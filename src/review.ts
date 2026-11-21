import { clampThinkingLevel, validateToolCall, type AssistantMessage, type Message, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { contentText } from "./archive.ts";
import { resultText, toolNames, type Operation } from "./memory-tools.ts";
import { prompt, type Settings } from "./settings.ts";

const strong = ["don't do that", "not like that", "i said", "i told you", "we already discussed", "please don't", "that's not what i", "i never said", "i didn't ask for", "you misunderstood"];
const weak = ["no", "wrong", "actually", "stop"];
const explicit = ["remember this", "remember that", "save this as a memory", "save this to memory"];
const negative = ["no worries", "no problem", "no thanks", "no need", "actually looks good", "actually looks great", "actually that's perfect", "actually that's correct", "actually that's right", "stop there", "stop here", "stop for now"];
const normalize = (text: string) => text.toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim();
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const includes = (text: string, phrase: string) => new RegExp(`(?:^|\\W)${escape(phrase)}(?:$|\\W)`).test(text);

export type Trigger = "correction" | "explicit" | "periodic" | "flush";
export type UserTrigger = { kind: "correction" | "explicit"; text: string };

export function detectTrigger(text: string, settings: Pick<Settings, "include" | "exclude">): UserTrigger["kind"] | undefined {
  const clean = normalize(text.replace(/```[\s\S]*?```|`[^`]*`|["“][^"”]*["”]|(?<!\w)['‘][^'’\n]*['’](?!\w)|^\s*>[^\n]*/gm, " "));
  const excluded = new Set(settings.exclude.map(normalize));
  const active = (phrase: string) => !excluded.has(phrase);
  // Allow a direct instruction after a scope preamble without treating every
  // mention of the phrase as a command (e.g. "If I say remember this...").
  const start = /^(?:(?:for|in|on) [^,]{1,120},\s*)?(?:(?:please[,:]?|(?:can|could|would) you)\s+)*/;
  const reminder = /^(?:(?:you|we) (?:need|have|still have) to|(?:i|we|you) (?:have|has|had) (?:an? |our |the )?(?:meeting|appointment|deadline|call|flight|interview)\b|(?:the|our|your|my) (?:meeting|appointment|deadline|call|flight|interview) (?:is|starts)\b)/;
  for (const sentence of clean.split(/(?<=[.!?;])\s+/)) {
    const clause = sentence.replace(start, "");
    for (const phrase of explicit.filter(active)) {
      const match = clause.match(new RegExp(`^${escape(phrase)}\\b`));
      if (!match) continue;
      const tail = clause.slice(phrase.length).trim();
      if (!phrase.startsWith("remember") || !reminder.test(tail)) return "explicit";
    }
  }
  const effective = negative.filter(active).reduce((s, phrase) => s.replace(new RegExp(`\\b${escape(phrase)}\\b`, "g"), " "), clean).trim();
  if ([...strong, ...settings.include.map(normalize)].some((phrase) => phrase && active(phrase) && includes(effective, phrase))) return "correction";
  const directive = /^(?:(?:please|instead)\s+)*(?:don't|do not|never|always|use|run|keep|change|replace|remove|add|make|fix|update|put|leave|set|switch|follow|check|write|read|prefer|avoid|only|stop|start|revert|undo|work|open|close|move|don't|you (?:must|should|need to|have to)|i (?:want|need) you to)\b/;
  for (const phrase of weak.filter(active)) {
    const tail = effective.match(new RegExp(`^${phrase}\\b[\\s,:;.!–—-]*([\\s\\S]+)$`))?.[1];
    if (tail && directive.test(tail)) return "correction";
  }
  return undefined;
}

export type ToolLog = { name: string; arguments: unknown; result: unknown; isError: boolean };
export type RunReport = { rationale?: string; error?: string; saved: number; calls: ToolLog[] };
export const newReport = (): RunReport => ({ saved: 0, calls: [] });
export const reviewTitle = "smart-mem-review";

export function runnerContext(messages: Message[], systemPrompt: string): Message[] {
  // Preserve the foreground transcript and prompt sections; do not carry over its tools.
  if (!messages.some(({ role }) => role === "system")) return [{ role: "system", content: systemPrompt, timestamp: 0 }, ...messages];
  return messages.map((msg) => {
    if (msg.role !== "system") return msg;
    const { toolsAdded: _added, toolsRemoved: _removed, ...rest } = msg;
    return rest;
  });
}

export type ModelContext = Pick<ExtensionContext, "model" | "modelRegistry" | "thinkingLevel" | "getSystemPrompt">;

export async function runModel(ctx: ModelContext, messages: Message[], task: string, tools: Operation[], options: {
  settings: Settings; reviewer?: boolean; reasoning?: ModelThinkingLevel; signal?: AbortSignal; report?: RunReport;
  done?: (call: ToolLog) => boolean; onResponse?: (response: AssistantMessage) => void;
}): Promise<RunReport> {
  const { settings, signal, report = newReport() } = options;
  const override = options.reviewer ? settings.reviewModel : undefined;
  const model = override ? ctx.modelRegistry.find(override.provider, override.id) : ctx.model;
  if (!model) throw new Error(override ? `Review model unavailable: ${override.provider}/${override.id}` : "No active Pi model");
  const effort = (options.reviewer ? settings.reviewReasoning : undefined) ?? options.reasoning ?? ctx.thinkingLevel ?? "off";
  const reasoning = clampThinkingLevel(model, effort);
  const definitions = tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
  const source = runnerContext(messages, ctx.getSystemPrompt());
  const leading = source[0];
  if (leading.role !== "system") throw new Error("Pi context has no leading system prompt");
  const context: Message[] = [{ ...leading, sections: { ...leading.sections, "smart-mem-task": `\n\n${task}` }, toolsAdded: definitions }, ...source.slice(1)];
  for (let iteration = 0; iteration < 16; iteration++) {
    signal?.throwIfAborted();
    const response = await ctx.modelRegistry.streamSimple(model, { messages: context }, { signal, reasoning: reasoning === "off" ? undefined : reasoning }).result();
    options.onResponse?.(response);
    signal?.throwIfAborted();
    if (response.stopReason === "error" || response.stopReason === "aborted" || response.stopReason === "length") throw new Error(response.errorMessage ?? `Model stopped: ${response.stopReason}`);
    if (contentText(response.content)) report.rationale = contentText(response.content);
    context.push(response);
    const calls = response.content.filter((part) => part.type === "toolCall");
    if (!calls.length) return report;
    for (const call of calls) {
      signal?.throwIfAborted();
      let result: unknown;
      let saved: boolean | undefined;
      let isError = false;
      try {
        const args = validateToolCall(definitions, call);
        const tool = tools.find(({ name }) => name === call.name);
        if (!tool) throw new Error(`Tool is not exposed: ${call.name}`);
        ({ value: result, saved } = await tool.call(args, signal));
        if (saved) report.saved++;
      } catch (error) { result = String(error); isError = true; }
      const entry = { name: call.name, arguments: call.arguments, result: saved === undefined ? result : { saved, result }, isError };
      report.calls.push(entry);
      context.push({ role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: resultText(result, saved) }], isError, timestamp: Date.now() });
      if (options.done?.(entry)) return report;
    }
  }
  throw new Error("Model tool loop did not finish after 16 calls to the provider");
}

export function reviewTask(settings: Settings, trigger: Trigger, request?: string) {
  const search = settings.reviewTools.includes(toolNames.sessionSearch) && prompt(settings, "sessionSearch");
  return [prompt(settings, "precedence"), prompt(settings, "write"), prompt(settings, "classification"), search, prompt(settings, "review"), prompt(settings, trigger), request && JSON.stringify(request)].filter(Boolean).join("\n\n");
}

export function injectionText(entries: readonly string[], cap = 32 * 1024) {
  const kept: string[] = [];
  let bytes = 0;
  for (const text of entries) {
    bytes += Buffer.byteLength(text, "utf8") + (kept.length ? 2 : 0);
    if (bytes > cap) return { kept, overflow: true };
    kept.push(text);
  }
  return { kept, overflow: false };
}
