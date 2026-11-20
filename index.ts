import { stat } from "node:fs/promises";
import { join } from "node:path";
import { convertToLlm, getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { Archive, contentText } from "./src/archive.ts";
import { LocalEmbeddings, models, type Device, type ModelPreset, type Progress } from "./src/embeddings.ts";
import { migrateHermes } from "./src/hermes-migration.ts";
import { readHermesSource } from "./src/hermes-source.ts";
import { maintain } from "./src/maintenance.ts";
import { MemoryStore, type Scope } from "./src/memory-store.ts";
import { lookupNames, memoryTools, operation, registerTools } from "./src/memory-tools.ts";
import { resolveProject } from "./src/project.ts";
import { detectTrigger, injectionText, newReport, reviewTask, reviewTitle, runModel, type RunReport, type Trigger, type UserTrigger } from "./src/review.ts";
import { openSettings, prompt, SettingsFile, type Settings } from "./src/settings.ts";

const injectedType = "smart-mem-injection";
const initialType = "smart-mem-initial";
const statusKey = "smart-mem";
const isConversation = ({ role }: { role: string }) => role === "user" || role === "assistant";
const isMissing = (error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return false; };
const reportError = (ctx: ExtensionContext, error: unknown) => ctx.ui.notify(`Smart Mem: ${String(error)}`, "error");

function scopedMaintenance(project: string | undefined, args: string): Scope[] {
  const value = args.trim();
  if (value === "global") return project ? ["project", "global"] : ["global"];
  if (value) throw new Error("Use the command without arguments for this project, or append global to include global memories");
  if (!project) throw new Error("No active project scope. Resolve project identity or append global");
  return ["project"];
}

async function progress<T>(ctx: ExtensionContext, title: string, action: (report: Progress) => Promise<T>): Promise<T> {
  ctx.ui.setWidget(statusKey, [title]);
  try { return await action((message) => ctx.ui.setWidget(statusKey, [title, message])); }
  finally { ctx.ui.setWidget(statusKey, undefined); }
}

type ReviewRow = RunReport & { trigger: Trigger; status: string };

export default function smartMemory(pi: ExtensionAPI): void {
  const directory = join(getAgentDir(), "pi-smart-mem");
  const dbPath = join(directory, "db");
  const file = new SettingsFile(directory);
  const local = new LocalEmbeddings(directory);
  const main = process.env.PI_SUBAGENT_CHILD !== "1";
  let activePreset: ModelPreset | undefined;
  let project: string | undefined;
  let store = new MemoryStore(project, dbPath);
  let archive = new Archive(dbPath, project);
  let activeContext: ExtensionContext | undefined;
  let pending: (UserTrigger & { timestamp: number })[] = [];
  let turns = 0;
  let calls = 0;
  let initial = false;
  let indexed = 0;
  let reviewQueue = Promise.resolve();
  let lastContext: { projected: Message[]; actual: Message[] } | undefined;

  function getStore() {
    if (!activePreset) throw new Error("Smart Mem is not set up. Open /smart-mem-settings in a main session");
    return store;
  }
  function getArchive() { getStore(); return archive; }
  function preset(model: string): ModelPreset {
    const match = models.find((item) => item.model === model);
    if (!match) throw new Error(`Unsupported Smart Mem embedding model: ${model}`);
    return match;
  }
  async function embed(text: string, query = false, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const model = activePreset;
    if (!model) throw new Error("Smart Mem is not set up");
    const settings = await file.read();
    return local.embed(model, settings.device, text, { query, signal });
  }
  const tools = memoryTools(getStore, getArchive, embed, () => activeContext?.sessionManager.getSessionFile());
  const reviewTools = tools.filter(({ name }) => name !== "skill_save");
  registerTools(pi, main ? tools : reviewTools);

  async function bindProject(ctx: ExtensionContext) {
    try { project = await resolveProject(ctx.cwd, dbPath); }
    catch (error) {
      project = undefined;
      reportError(ctx, error);
    }
    store = new MemoryStore(project, dbPath);
    archive = new Archive(dbPath, project);
  }

  async function setup(ctx: ExtensionContext) {
    const current = activePreset;
    const options = models.map((m) => `${m.model} · ${m.size} · ${m.dimensions} dimensions${m.model === current?.model ? " (active)" : ""}`);
    const selected = await ctx.ui.select(current ? "Smart Mem embedding model" : "Set up Smart Mem: select an embedding model", options);
    if (!selected) return;
    const next = models[options.indexOf(selected)];
    const rebuild = !!current && current.model !== next.model;
    const confirm = rebuild
      ? "Existing embeddings will be regenerated. Coordinate other Pi sessions before continuing. The old model stays active if the rebuild fails."
      : `Download ${next.model} (${next.size}) if needed and initialize local storage?`;
    if (!await ctx.ui.confirm(rebuild ? "Rebuild the memory index?" : current ? "Verify Smart Mem model?" : "Initialize Smart Mem?", confirm)) return;
    const { device } = await file.read();
    const space = { model: next.model, dimensions: next.dimensions };
    await progress(ctx, rebuild ? "Rebuilding Smart Mem index" : "Setting up Smart Mem", async (report) => {
      report("Loading embedding model");
      await local.embed(next, device, next.model, { download: report });
      if (rebuild) {
        let embedded = 0;
        await store.rebuild(space, async (text) => {
          const embedding = await local.embed(next, device, text);
          report(`Regenerated ${++embedded} embeddings`);
          return embedding;
        });
      } else if (!current) {
        await store.initialize(space);
        await bindProject(ctx);
      }
      activePreset = next;
    });
    ctx.ui.notify(`Smart Mem ready: ${next.model} on ${device.toUpperCase()}`, "info");
  }

  async function setDevice(ctx: ExtensionContext, device: Device) {
    if ((await file.read()).device === device) return;
    const space = await getStore().embeddingSpace();
    if (!space) throw new Error("Set up Smart Mem before changing device");
    await progress(ctx, `Testing ${device.toUpperCase()}`, async () => {
      await local.embed(preset(space.model), device, "Test embedding device");
      await file.update({ device });
    });
  }

  function projected(ctx: ExtensionContext): Message[] {
    return convertToLlm(ctx.sessionManager.buildSessionProjection().messages);
  }

  function withActiveContext(messages: Message[]): Message[] {
    if (!lastContext) return messages;
    const before = lastContext.projected;
    // Reuse provider-visible transforms only when the current branch extends
    // the exact projection from that request. Otherwise use current Pi state.
    if (!before.length || before.length > messages.length || !before.every((msg, i) => JSON.stringify(msg) === JSON.stringify(messages[i]))) return messages;
    return [...lastContext.actual, ...messages.slice(before.length)];
  }

  async function inject(ctx: ExtensionContext, settings: Settings, messages: Message[]) {
    const ids: string[] = [];
    let submitted = false;
    const available = tools.filter(({ name }) => lookupNames.includes(name));
    const selection = operation("select_memories", "Submit existing memory IDs in selection order; an empty list is valid.", Type.Object({ ids: Type.Array(Type.String()) }), ({ ids: chosen }) => {
      ids.push(...new Set(chosen)); submitted = true;
      return { value: { selected: ids.length } };
    });
    const task = [prompt(settings, "precedence"), prompt(settings, "injection")].join("\n\n");
    await runModel(ctx, messages, task, [...available, selection], { settings, signal: ctx.signal, done: () => submitted });
    if (!submitted) throw new Error("Model did not submit a memory selection");
    const notes = await getStore().readMany(ids);
    const { kept, overflow } = injectionText(notes.map(({ text }) => text));
    if (overflow) ctx.ui.notify("Memory injection exceeded 32 KiB. Remaining notes were not injected.", "warning");
    if (!kept.length) return undefined;
    return { customType: injectedType, content: `${prompt(settings, "injected")}\n\n${kept.join("\n\n")}`, display: false };
  }

  async function review(ctx: ExtensionContext, settings: Settings, trigger: Trigger, messages: Message[], request?: string, signal?: AbortSignal): Promise<ReviewRow> {
    const report = newReport();
    const previous = reviewQueue;
    const loop = previous.then(async () => {
      signal?.throwIfAborted();
      await runModel(ctx, messages, reviewTask(settings, trigger, request), reviewTools.filter(({ name }) => settings.reviewTools.includes(name)), {
        settings, reviewer: true, signal, report, reasoning: pi.getThinkingLevel(),
      });
    });
    let unregister: (() => void) | undefined;
    const abort = signal && new Promise<never>((_, reject) => {
      const handler = () => reject(signal.reason);
      signal.addEventListener("abort", handler, { once: true });
      unregister = () => signal.removeEventListener("abort", handler);
      if (signal.aborted) handler();
    });
    const settled = abort ? Promise.race([loop, abort]) : loop;
    // Cancellation retires this review even if the provider does not settle.
    // Keep prior reviews ordered; the expired loop checks its signal before tools and writes.
    reviewQueue = previous.then(() => settled).catch(() => undefined);
    try { await settled; }
    catch (error) { report.error = String(error); }
    finally { unregister?.(); }
    const failed = report.error || report.calls.some(({ isError }) => isError);
    const status = report.saved ? `Saved · ${report.saved}${failed ? " (with errors)" : ""}` : failed ? "Failed" : "Skipped";
    return { ...report, calls: [...report.calls], trigger, status };
  }

  async function flush(ctx: ExtensionContext, preCompact?: AbortSignal) {
    const branch = ctx.sessionManager.getBranch();
    if (branch.filter((entry) => entry.type === "message" && entry.message.role === "user").length < 6) return;
    const settings = await file.read();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException("Memory review timed out", "TimeoutError")), Math.min(settings.flushSeconds * 1000, 2_147_483_647));
    const signal = preCompact ? AbortSignal.any([preCompact, controller.signal]) : controller.signal;
    try {
      pi.appendEntry(reviewTitle, await review(ctx, settings, "flush", withActiveContext(projected(ctx)), undefined, signal));
    } finally { clearTimeout(timer); }
  }

  async function indexCurrent(ctx: ExtensionContext) {
    const path = ctx.sessionManager.getSessionFile();
    if (!path) return;
    const entries = ctx.sessionManager.getEntries();
    const header = ctx.sessionManager.getHeader();
    if (!header || entries.length <= indexed || !await stat(path).then(() => true, isMissing)) return;
    const end = entries.length;
    await archive.index(path, [header, ...entries.slice(indexed, end)]);
    indexed = end;
  }

  pi.on("session_start", async (_event, ctx) => {
    activeContext = ctx;
    const space = await stat(dbPath).then((info) => info.isDirectory(), isMissing) ? await store.embeddingSpace() : undefined;
    activePreset = space ? preset(space.model) : undefined;
    if (activePreset) await bindProject(ctx);
    initial = ctx.sessionManager.getEntries().some((entry) => entry.type === "custom" && entry.customType === initialType);
    if (!activePreset && main && ctx.hasUI) {
      try { await setup(ctx); } catch (error) { reportError(ctx, error); }
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    activeContext = ctx;
    const settings = await file.read();
    if (!activePreset) return;
    const pins = await archive.pins();
    const active = new Set(pi.getActiveTools());
    const memoryExposed = tools.some(({ name }) => active.has(name));
    const guidance = memoryExposed ? [prompt(settings, "precedence"), prompt(settings, "recall"), prompt(settings, "write")] : [];
    if (main && active.has("skill_save")) guidance.push(prompt(settings, "skillWrite"));
    if (pins.length) guidance.push(...pins);
    if (guidance.length) return { systemPrompt: [event.systemPrompt, ...guidance].join("\n\n") };
  });

  pi.on("context_with_system", (event, ctx) => {
    if (main && activePreset) lastContext = { projected: projected(ctx), actual: convertToLlm(event.messages) };
  });
  pi.on("session_tree", () => { lastContext = undefined; pending = []; });

  pi.registerEntryRenderer<ReviewRow>(reviewTitle, (entry, { expanded }, theme) => {
    const box = new Box(1, 0);
    const data = entry.data;
    if (!data) return box;
    box.addChild(new Text(theme.fg("accent", `Memory review · ${data.status}`), 0, 0));
    if (expanded) {
      const details = [
        `Trigger: ${data.trigger}`,
        ...data.calls.map((call) => `${call.name} ${JSON.stringify(call.arguments)} → ${call.isError ? "Error: " : ""}${JSON.stringify(call.result) ?? "No result"}`),
        data.rationale && `Reason: ${data.rationale}`, data.error && `Error: ${data.error}`,
      ].filter(Boolean).join("\n");
      // Do not interpret model-provided terminal escapes in the custom renderer.
      box.addChild(new Text(details.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ""), 0, 0));
    }
    return box;
  });

  if (!main) return;

  pi.on("message_end", async ({ message }, ctx) => {
    if (!activePreset || message.role !== "user") return;
    const text = contentText(message.content);
    try {
      const kind = detectTrigger(text, await file.read());
      if (kind) pending.push({ kind, text, timestamp: message.timestamp });
    } catch (error) { reportError(ctx, error); }
  });

  pi.on("turn_end", async (event, ctx) => {
    if (!activePreset) return;
    const entries = [];
    try {
      const settings = await file.read();
      const active = event.context.contextMessages;
      const branch = ctx.sessionManager.getBranch();
      const chat = branch.flatMap((entry) => entry.type === "message" && isConversation(entry.message) ? [entry.message] : []);
      const messages = withActiveContext(event.context.llmMessages);
      turns++;
      if (event.message.role === "assistant") calls += event.message.content.filter((part) => part.type === "toolCall").length;
      for (const request of pending.splice(0)) {
        if (!chat.some((m) => m.role === "user" && m.timestamp === request.timestamp)) continue;
        entries.push({ type: "custom" as const, customType: reviewTitle, data: await review(ctx, settings, request.kind, messages, request.text, ctx.signal) });
      }
      const due = turns >= settings.periodicTurns || calls >= settings.periodicCalls;
      const enough = chat.filter(({ role }) => role === "user").length >= 3 && active.filter((m) => "content" in m && (contentText(m.content).trim() || (Array.isArray(m.content) && m.content.some(({ type }) => type === "image" || type === "toolCall")))).length >= 4;
      if (due && enough && !ctx.signal?.aborted) {
        entries.push({ type: "custom" as const, customType: reviewTitle, data: await review(ctx, settings, "periodic", messages, undefined, ctx.signal) });
        turns = 0;
        calls = 0;
      }
      if (!initial && chat.length >= settings.initialMessages && !ctx.signal?.aborted) {
        const addition = await inject(ctx, settings, messages);
        ctx.signal?.throwIfAborted();
        initial = true;
        entries.push({ type: "custom" as const, customType: initialType });
        if (addition) entries.push({ type: "custom_message" as const, ...addition });
      }
    } catch (error) { reportError(ctx, error); }
    return { entries };
  });

  pi.on("session_before_compact", async (event, ctx) => {
    if (activePreset) try { await flush(ctx, event.signal); } catch (error) { reportError(ctx, error); }
  });
  pi.on("session_compact", async (_event, ctx) => {
    lastContext = undefined;
    if (!activePreset || !ctx.sessionManager.getEntries().some((e) => e.type === "custom_message" && e.customType === injectedType)) return;
    try {
      const addition = await inject(ctx, await file.read(), projected(ctx));
      if (addition) pi.sendMessage(addition, { triggerTurn: false });
    } catch (error) { reportError(ctx, error); }
  });
  pi.on("agent_settled", async (_event, ctx) => {
    if (!activePreset) return;
    try {
      await indexCurrent(ctx);
      const settings = await file.read();
      if (settings.autoLink) await maintain({ kind: "link", scopes: project ? ["project", "global"] : ["global"], automatic: true, ctx, store, settings,
        messages: withActiveContext(projected(ctx)), embed: (text, signal) => embed(text, false, signal), progress: () => {} });
    } catch (error) { reportError(ctx, error); }
  });
  pi.on("session_shutdown", async (event, ctx) => {
    if (!activePreset || event.reason === "reload") return;
    try { await flush(ctx); await indexCurrent(ctx); } catch (error) { reportError(ctx, error); }
  });

  pi.registerCommand("smart-mem-settings", {
    description: "Configure Smart Mem",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      try {
        await openSettings(ctx, file, reviewTools.map(({ name }) => name), {
          modelName: () => activePreset?.model ?? "Not set up",
          setup: () => setup(ctx), device: (device) => setDevice(ctx, device),
          backfill: async () => {
            const a = getArchive();
            const count = await progress(ctx, "Backfilling past Pi conversations", (log) => a.backfill(join(getAgentDir(), "sessions"), log));
            ctx.ui.notify(`Indexed ${count} Pi sessions`, "info");
          },
          prune: async () => {
            if (!await ctx.ui.confirm("Clear transcript index?", "Original Pi transcripts will not be changed.")) return;
            await getArchive().prune();
            ctx.ui.notify("Transcript index cleared", "info");
          },
        });
      } catch (error) { reportError(ctx, error); }
    },
  });
  pi.registerCommand("migrate-hermes", {
    description: "Import all pi-hermes-memory data (use --force to replace existing Smart Mem data)",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      try {
        const flag = args.trim();
        if (flag && flag !== "--force") throw new Error("Use /migrate-hermes [--force]");
        const force = flag === "--force";
        const source = await readHermesSource(getAgentDir(), ctx.cwd);
        if (!activePreset && ctx.hasUI) await setup(ctx);
        getStore();
        if (force) ctx.ui.notify("Replacing Smart Mem database contents: existing memories, links, skills, pins, and transcript search index will be removed. Hermes files will not change.", "warning");
        const result = await progress(ctx, "Migrating Hermes", (log) => migrateHermes({
          source, dbPath, force, embed: (text) => embed(text, false, ctx.signal), progress: log,
        }));
        await bindProject(ctx);
        ctx.ui.notify(`Imported ${source.memories.length} memories, ${source.skills.length} skills, and ${source.pins.length} pins across global scope and ${result.projects} projects`, "info");
        if (result.unmatchedProjects.length) {
          ctx.ui.notify(`Imported projects without a matching folder:\n${result.unmatchedProjects.map(({ name, id }) => `${name}: ${id}`).join("\n")}`, "warning");
        }
      } catch (error) { reportError(ctx, error); }
    },
  });
  pi.registerCommand("inject-mem", {
    description: "Select and inject relevant saved memories",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      try {
        getStore();
        const settings = await file.read();
        const addition = await progress(ctx, "Selecting relevant memories", () => inject(ctx, settings, withActiveContext(projected(ctx))));
        if (addition) pi.sendMessage(addition, { triggerTurn: false });
        ctx.ui.notify(addition ? "Injected relevant memories" : "No relevant memories selected", "info");
      } catch (error) { reportError(ctx, error); }
    },
  });
  for (const [kind, command] of [["link", "link-mem"], ["consolidate", "consolidate-mem"]] as const) pi.registerCommand(command, {
    description: kind === "link" ? "Build related-memory links" : "Merge overlapping saved memories and shorten notes",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      try {
        const settings = await file.read();
        const scopes = scopedMaintenance(project, args);
        const changes = await progress(ctx, kind === "link" ? "Building memory links" : "Consolidating memories", (log) => maintain({
          kind, scopes, ctx, store: getStore(), settings, messages: withActiveContext(projected(ctx)),
          embed: (text, signal) => embed(text, false, signal), progress: log, signal: ctx.signal,
        }));
        ctx.ui.notify(kind === "link" ? `Created ${changes} memory links` : `Updated ${changes} saved memories`, "info");
      } catch (error) { reportError(ctx, error); }
    },
  });
  pi.registerCommand("memory-pin", {
    description: "Save standing instructions for this project or globally",
    handler: async (args, ctx) => {
      try {
        const value = args.trim();
        const scope = /^global(?:\s|$)/.test(value) ? "global" : "project";
        const text = scope === "global" ? value.slice(6).trim() : value;
        if (!text) throw new Error("Use /memory-pin <text> or /memory-pin global <text>");
        await getArchive().pin(scope, text);
        ctx.ui.notify(`Saved ${scope} pin`, "info");
      } catch (error) { reportError(ctx, error); }
    },
  });
}
