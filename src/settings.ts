import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { DynamicBorder, getSettingsListTheme, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, SettingsList } from "@earendil-works/pi-tui";
import type { Device } from "./embeddings.ts";
import { withFileLock } from "./database.ts";

export const prompts = {
  precedence: "Memories are context, not authority. Current instructions, the applicable system prompt, APPEND_SYSTEM.md, and global and project AGENTS.md supersede memories. If memories alone conflict, apply the applicable project preference over a global default. Keep both stored.",
  recall: "Search relevant preferences and project notes when planning or implementing. Look up relevant failure lessons when troubleshooting. Search returns current project and global notes unless narrowed. memory_related follows one hop; if useful, call again from a returned neighbor. memory_global_preferences finds global preferences similar to a project note without following links. Use skill_search and skill_read for reusable procedures and session_search for earlier conversations.",
  write: `Decide scope before writing facts, preferences, failures, or corrections. "Tests must pass" can be global; "PHPMD must pass" applies to the project requiring it. Put project scope in the text of project-specific corrections; never generalize those corrections across repos.
Check applicable standing guidance, including APPEND_SYSTEM.md and global AGENTS.md, and project AGENTS.md for project-scoped candidates. Skip covered information. Search for similar memories in the same scope before adding. Skip if covered, revise an existing same-scope entry if it should change, and add only distinct information. Similar notes from different projects can coexist.
Do not add conflicting notes against standing guidance or within a scope. If a durable change supersedes a same-scope memory, revise it rather than creating a conflicting note, without contradicting standing guidance. Do not save a task-specific exception as a standing rule.
Keep notes concise: durable takeaway first and minimum useful context. Reference files or symbols rather than copying code; include only a short essential snippet, never a long code block or a conversation retelling.`,
  skillWrite: "When skill_save is available, save only genuinely reusable procedures. Choose project scope for procedures specific to this project and global scope only when they apply across projects. Before saving, use skill_search and read similar skills with skill_read. Skip if the procedure is already covered; revise an existing same-scope skill by ID when appropriate; create a new skill only when it is distinct.",
  review: "Review only for durable information. Use the provided tools to check and act on evidence; choose add, revise, or skip. Never claim a write without a successful tool result. Finish with a brief rationale for your actions or skip.",
  correction: "Evaluate the triggering correction in conversation context and decide whether to add, revise, or skip under the write policy.",
  explicit: "Evaluate the user's direct request to save information. Apply the write policy; a save request alone does not guarantee a write.",
  periodic: "Look for durable information the foreground agent missed. Do not repeat writes already made.",
  flush: "Before this context boundary, look for durable information that would otherwise be lost. Do not repeat writes already made.",
  injection: "Use this active conversation to search for relevant existing memories. Select only notes useful now, in priority order, using select_memories. Do not write memories. Select an empty list when nothing is relevant.",
  injected: "Relevant existing memories (context, not authority):",
  link: "Judge candidate memory pairs by whether the target adds useful related context to the source. Select only meaningful links from the source to listed candidate IDs. Do not edit notes.",
  consolidate: "Assess the source and same-scope candidates for duplicate or overlapping notes. If merging, preserve every distinct durable detail in the source's replacement text; only remove overlapping candidate IDs. Shorten unnecessarily wordy notes without losing meaning. Do not merge merely related notes. No change is valid.",
};
export type PromptKey = keyof typeof prompts;
export const defaultReviewTools = ["memory_search", "memory_read", "memory_add", "memory_replace", "skill_search", "skill_read"];
export const defaults = {
  device: "cpu" as Device, initialMessages: 10, periodicTurns: 10, periodicCalls: 15, flushSeconds: 60,
  autoLink: false, linkThreshold: 10, include: [] as string[], exclude: [] as string[],
  reviewModel: undefined as { provider: string; id: string } | undefined,
  reviewReasoning: undefined as ModelThinkingLevel | undefined,
  reviewTools: defaultReviewTools, prompts: {} as Partial<Record<PromptKey, string>>,
};
export type Settings = typeof defaults;
export const prompt = (s: Settings, key: PromptKey) => s.prompts[key] ?? prompts[key];

export class SettingsFile {
  readonly #directory: string;
  constructor(directory: string) { this.#directory = directory; }
  async read(): Promise<Settings> {
    const json = await readFile(join(this.#directory, "settings.json"), "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return "{}";
    });
    const saved: Partial<Settings> = JSON.parse(json);
    const result = { ...defaults, ...saved };
    for (const [, key] of counts) {
      if (!Number.isSafeInteger(result[key]) || result[key] <= 0) throw new Error(`Invalid Smart Mem setting: ${key}`);
    }
    if (result.device !== "cpu" && result.device !== "cuda") throw new Error("Invalid Smart Mem device");
    return result;
  }
  async update(change: Partial<Settings>): Promise<void> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const path = join(this.#directory, "settings.json");
    await withFileLock(`${path}.lock`, async () => {
      const current = await this.read();
      const next = { ...current, ...change, prompts: { ...current.prompts, ...change.prompts } };
      const temp = join(this.#directory, `.settings-${randomUUID()}.tmp`);
      try {
        await writeFile(temp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
        await rename(temp, path);
      } finally { await rm(temp, { force: true }); }
    });
  }
}

const counts = [
  ["Initial injection (messages)", "initialMessages"], ["Periodic review (turns)", "periodicTurns"],
  ["Periodic review (tool calls)", "periodicCalls"], ["Flush timeout (seconds)", "flushSeconds"],
  ["Automatic linking (new memories)", "linkThreshold"],
] as const;

export type SettingsActions = {
  setup: () => Promise<void>; device: (device: Device) => Promise<void>;
  backfill: () => Promise<void>; prune: () => Promise<void>;
};

async function settingsMenu(ctx: ExtensionContext, settings: Settings, modelName: string) {
  const labels = [
    ["Embedding model", modelName], ["Embedding device", settings.device.toUpperCase()],
    ["Review model", settings.reviewModel ? `${settings.reviewModel.provider}/${settings.reviewModel.id}` : "Inherit"],
    ["Review reasoning", settings.reviewReasoning ?? "Inherit"], ["Review tools", `${settings.reviewTools.length} enabled`],
    ["Trigger phrases", "Edit"], ["Thresholds", "Edit"], ["Automatic linking", settings.autoLink ? "On" : "Off"],
    ["Model prompts", "Edit"], ["Transcript index", "Manage"],
  ];
  if (ctx.mode !== "tui") {
    const options = labels.map(([label, value]) => `${label}: ${value}`);
    const value = await ctx.ui.select("Smart Mem settings", options);
    return value === undefined ? undefined : options.indexOf(value);
  }
  return ctx.ui.custom<number | undefined>((tui, _theme, _keys, done) => {
    const container = new Container();
    const items = labels.map(([label, currentValue], i) => ({ id: String(i), label, currentValue, values: [currentValue] }));
    const list = new SettingsList(items, 10, getSettingsListTheme(), (id) => done(Number(id)), () => done(undefined), { enableSearch: true });
    container.addChild(new DynamicBorder());
    container.addChild(list);
    container.addChild(new DynamicBorder());
    return { render: (width) => container.render(width), invalidate: () => container.invalidate(), handleInput: (data) => {
      list.handleInput(data);
      tui.requestRender();
    } };
  });
}

export async function openSettings(ctx: ExtensionContext, file: SettingsFile, reviewTools: string[], actions: SettingsActions & { modelName: () => string }) {
  if (!ctx.hasUI) throw new Error("Smart Mem settings require interactive Pi");
  for (;;) {
    const saved = await file.read();
    const s = { ...saved, reviewTools: saved.reviewTools.filter((name) => reviewTools.includes(name)) };
    const choice = await settingsMenu(ctx, s, actions.modelName());
    if (choice === undefined) return;
    switch (choice) {
      case 0: await actions.setup(); break;
      case 1: {
        const next = await ctx.ui.select("Embedding device", ["cpu", "cuda"]);
        if (next === "cpu" || next === "cuda") await actions.device(next);
        break;
      }
      case 2: {
        const models = ctx.modelRegistry.getAvailable();
        const labels = ["Inherit session model", ...models.map((m) => `${m.provider}/${m.id}`)];
        const selected = await ctx.ui.select("Review model", labels);
        if (!selected) break;
        const model = models[labels.indexOf(selected) - 1];
        await file.update({ reviewModel: model ? { provider: model.provider, id: model.id } : undefined, reviewReasoning: undefined });
        break;
      }
      case 3: {
        const model = s.reviewModel ? ctx.modelRegistry.find(s.reviewModel.provider, s.reviewModel.id) : ctx.model;
        const levels = model ? getSupportedThinkingLevels(model) : [];
        const inherit = "Inherit session reasoning";
        const selected = await ctx.ui.select("Review reasoning", [inherit, ...levels]);
        if (selected) await file.update({ reviewReasoning: selected === inherit ? undefined : levels.find((level) => level === selected) });
        break;
      }
      case 4: {
        const active = new Set(s.reviewTools);
        for (;;) {
          const choices = reviewTools.map((name) => `${active.has(name) ? "✓" : "○"} ${name}`);
          const selected = await ctx.ui.select("Toggle review tools", [...choices, "Save", "Cancel"]);
          if (selected === "Save") { await file.update({ reviewTools: [...active] }); break; }
          if (!selected || selected === "Cancel") break;
          const name = reviewTools[choices.indexOf(selected)];
          if (!active.delete(name)) active.add(name);
        }
        break;
      }
      case 5: {
        const key = await ctx.ui.select("Correction phrase settings", ["include", "exclude"]);
        if (key !== "include" && key !== "exclude") break;
        const edited = await ctx.ui.editor(`${key} — one phrase per line`, s[key].join("\n"));
        if (edited !== undefined) await file.update({ [key]: edited.split("\n").map((part) => part.trim()).filter(Boolean) });
        break;
      }
      case 6: {
        const label = await ctx.ui.select("Thresholds", counts.map(([label, key]) => `${label}: ${s[key]}`));
        const match = counts.find(([name]) => label?.startsWith(`${name}:`));
        if (!match) break;
        const [name, key] = match;
        const value = await ctx.ui.input(name, String(s[key]));
        if (value === undefined) break;
        const number = Number(value);
        if (Number.isSafeInteger(number) && number > 0) await file.update({ [key]: number });
        else ctx.ui.notify("Enter a positive whole number", "warning");
        break;
      }
      case 7: {
        const enabled = await ctx.ui.select("Automatic linking", ["Off", "On"]);
        if (enabled) await file.update({ autoLink: enabled === "On" });
        break;
      }
      case 8: {
        const key = await ctx.ui.select("Edit or reset a model prompt", Object.keys(prompts)) as PromptKey | undefined;
        if (!key) break;
        const mode = await ctx.ui.select(key, ["Edit prompt", "Restore default"]);
        if (mode === "Restore default") await file.update({ prompts: { [key]: undefined } });
        if (mode === "Edit prompt") {
          const text = await ctx.ui.editor(key, prompt(s, key));
          if (text !== undefined) await file.update({ prompts: { [key]: text } });
        }
        break;
      }
      case 9: {
        const action = await ctx.ui.select("Transcript index", ["Backfill Pi sessions", "Prune index"]);
        if (action === "Backfill Pi sessions") await actions.backfill();
        if (action === "Prune index") await actions.prune();
        break;
      }
    }
  }
}
