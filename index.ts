import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { convertToLlm, getAgentDir, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { Archive, contentText } from "./src/archive.ts";
import { embeddingDevice, models, type Device, type ModelPreset, type Progress } from "./src/embeddings.ts";
import { migrateHermes } from "./src/hermes-migration.ts";
import { readHermesSource } from "./src/hermes-source.ts";
import { maintain, type MaintenanceResult } from "./src/maintenance.ts";
import { reclassifyMemories, type BatchOptions } from "./src/maintenance-batch.ts";
import { cleanupConflicts, cleanupMode, conflictGuidance } from "./src/conflict-cleanup.ts";
import { Diagnostics } from "./src/diagnostics.ts";
import { commands } from "./src/commands.ts";
import { MemoryPanel, memoryPanelShortcut, type Activity, type Level } from "./src/memory-panel.ts";
import { MemoryStore, type Scope } from "./src/memory-store.ts";
import { lookupNames, memoryTools, operation, registerTools, toolNames } from "./src/memory-tools.ts";
import { resolveProject } from "./src/project.ts";
import { detectTrigger, injectionText, newReport, reviewTask, reviewTitle, runModel, type RunReport, type Trigger, type UserTrigger } from "./src/review.ts";
import { chooseEmbeddingModel, openSettings, prompt, SettingsFile, type Settings } from "./src/settings.ts";
import { SharedEmbeddings } from "./src/shared-embeddings.ts";

const injectedType = "smart-mem-injection";
const initialType = "smart-mem-initial";
const statusKey = "smart-mem";

const isConversation = ({ role }: { role: string }) => role === "user" || role === "assistant";
const isMissing = (error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return false; };

function scopedMaintenance(project: string | undefined, args: string): Scope[] {
  const value = args.trim();
  if (value === "global") return project ? ["project", "global"] : ["global"];
  if (value) throw new Error("Use the command without arguments for this project, or append global to include global memories");
  if (!project) throw new Error("No active project scope. Resolve project identity or append global");
  return ["project"];
}

function consolidationOptions(project: string | undefined, args: string): { scopes: Scope[]; full: boolean } {
  switch (args.trim().replace(/\s+/g, " ")) {
    case "": return { scopes: scopedMaintenance(project, ""), full: false };
    case "global": return { scopes: scopedMaintenance(project, "global"), full: false };
    case "full": return { scopes: scopedMaintenance(project, ""), full: true };
    case "global full": return { scopes: scopedMaintenance(project, "global"), full: true };
    default: throw new Error(`Use /${commands.consolidate} [global] [full]`);
  }
}

async function fallbackProgress<T>(ctx: ExtensionContext, title: string, action: (report: Progress) => Promise<T>): Promise<T> {
  ctx.ui.setWidget(statusKey, [title]);
  try { return await action((message) => ctx.ui.setWidget(statusKey, [title, message])); }
  finally { ctx.ui.setWidget(statusKey, undefined); }
}

type ReviewRow = RunReport & { trigger: Trigger; status: string };
const skipSummary = (count: number) => count ? ` · Skipped ${count} ${count === 1 ? "note" : "notes"}` : "";

export default function smartMemory(pi: ExtensionAPI): void {
  const directory = join(getAgentDir(), "pi-smart-mem");
  const dbPath = join(directory, "db");
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
  const panel = new MemoryPanel();
  const toolActivity = new Map<string, Activity>();
  let manualMaintenance: AbortController | undefined;
  let deferredImportIndex: { pending: boolean } | undefined;
  const hasPanel = (ctx: ExtensionContext) => main && ctx.mode === "tui";
  const present = (ctx: ExtensionContext, message: string, level: Level, detail?: string, timeoutMs?: number) => {
    if (hasPanel(ctx)) panel.notice(message.split("\n", 1)[0], level, detail ?? (message.includes("\n") ? message : undefined), timeoutMs);
    else ctx.ui.notify(message, level);
  };
  const log = new Diagnostics(directory, main ? "pi" : "subagent", (error) => {
    if (activeContext) present(activeContext, `Cannot write Smart Mem diagnostics: ${String(error)}`, "warning");
  });
  const file = new SettingsFile(directory, log);
  const embeddings = new SharedEmbeddings(directory, log);
  const registerCommand: ExtensionAPI["registerCommand"] = (name, options) => pi.registerCommand(name, {
    ...options, handler: async (args, ctx) => {
      void log.write("command.start", { name });
      await options.handler(args, ctx);
    },
  });
  const begin = (ctx: ExtensionContext, title: string) => hasPanel(ctx) ? panel.begin(title) : undefined;
  function notify(ctx: ExtensionContext, message: string, level: Level = "info", detail?: string, timeoutMs?: number) {
    void log.write("notice", { message }, level);
    present(ctx, message, level, detail, timeoutMs);
  }
  const reportError = (ctx: ExtensionContext, error: unknown, timeoutMs?: number) => notify(ctx, `Smart Mem: ${String(error)}`, "error", String(error), timeoutMs);
  async function refreshCounts(ctx: ExtensionContext) {
    if (!panel.mounted || !activePreset) return;
    try { panel.setCounts(await store.inventory()); }
    catch (error) { reportError(ctx, error); }
  }
  async function progress<T>(ctx: ExtensionContext, title: string, action: (report: Progress) => Promise<T>): Promise<T> {
    void log.write("operation.start", { title });
    const track = (report: Progress) => action((message) => {
      void log.write("operation.progress", { title, message });
      report(message);
    });
    const activity = begin(ctx, title);
    if (!activity) return fallbackProgress(ctx, title, track);
    try { return await track(activity.update); }
    finally { activity.clear(); }
  }
  async function runMaintenance(options: Omit<Parameters<typeof maintain>[0], "onFailure" | "diagnostics">) {
    const batch = { kind: options.kind, scopes: options.scopes.join(","), model: options.ctx.model?.id, automatic: !!options.automatic,
      mode: options.kind === "consolidate" ? (options.full ? "full" : "incremental") : undefined };
    let started = false;
    const start = () => { if (!started) { started = true; void log.write("maintenance.start", batch); } };
    if (!options.automatic) start();
    try {
      const outcome = await maintain({ ...options, diagnostics: log, progress: (message) => {
        start();
        void log.write("maintenance.progress", { ...batch, message });
        options.progress(message);
      }, onFailure: (failure) => { void log.write("maintenance.note_failed", { ...batch, ...failure }, "warning"); } });
      if (started) void log.write("maintenance.finish", { ...batch, ...outcome }, outcome.skipped ? "warning" : "info");
      return outcome;
    } catch (error) {
      if (options.signal?.aborted) void log.write("maintenance.canceled", batch);
      else void log.write("maintenance.failed", { ...batch, error: String(error) }, "error");
      throw error;
    }
  }
  let lastContext: { projected: Message[]; actual: Message[] } | undefined;

  function getStore() {
    if (!activePreset) throw new Error(`Smart Mem is not set up. Run /${commands.setup} in a main session`);
    return store;
  }
  function getArchive() { getStore(); return archive; }
  function preset(model: string): ModelPreset {
    const match = models.find((item) => item.model === model);
    if (!match) throw new Error(`Unsupported Smart Mem embedding model: ${model}`);
    return match;
  }
  async function readActivePreset() {
    const space = await stat(dbPath).then((info) => info.isDirectory(), isMissing) ? await store.embeddingSpace() : undefined;
    return space && preset(space.model);
  }

  async function embed(text: string, query = false, signal?: AbortSignal) {
    if (!activePreset) throw new Error("Smart Mem is not set up");
    return embeddings.run(async (worker) => {
      const model = await readActivePreset();
      if (!model) throw new Error("Smart Mem is not set up");
      const settings = await file.read();
      activePreset = model;
      return worker.embed(model, embeddingDevice(model, settings.device), text, { query });
    }, signal);
  }
  const tools = memoryTools(getStore, getArchive, embed, () => activeContext?.sessionManager.getSessionFile());
  const reviewTools = tools.filter(({ name }) => name !== toolNames.skillSave);
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

  async function prepareSetup(ctx: ExtensionContext, current: ModelPreset | undefined, signal: AbortSignal) {
    const next = await chooseEmbeddingModel(ctx, current, await embeddings.run((worker) => worker.cudaUnavailable(), signal));
    if (!next) return;
    const rebuild = !!current && current.model !== next.model;
    const confirm = rebuild
      ? "Existing embeddings will be regenerated. Coordinate other Pi sessions before continuing. The old model stays active if the rebuild fails."
      : `Download ${next.model} (${next.size}) if needed and initialize local storage?`;
    if (!await ctx.ui.confirm(rebuild ? "Rebuild the memory index?" : current ? "Verify Smart Mem model?" : "Initialize Smart Mem?", confirm)) return;
    const title = rebuild ? "Rebuilding Smart Mem index" : "Setting up Smart Mem";
    const run = (report: Progress, signal: AbortSignal) => embeddings.run(async (worker) => {
      void log.write("setup.start", { model: next.model, rebuild });
      if ((await readActivePreset())?.model !== current?.model) throw new Error("Smart Mem model changed in another session. Reopen setup and retry.");
      const device = embeddingDevice(next, (await file.read()).device);
      const space = { model: next.model, dimensions: next.dimensions };
      report("Loading embedding model");
      await worker.embed(next, device, next.model, { download: report });
      if (rebuild) {
        let embedded = 0;
        await store.rebuild(space, async (text) => {
          const embedding = await worker.embed(next, device, text);
          report(`Regenerated ${++embedded} embeddings`);
          return embedding;
        });
      } else if (!current) await store.initialize(space, signal);
      signal.throwIfAborted();
      if (!activePreset) await bindProject(ctx);
      signal.throwIfAborted();
      activePreset = next;
      panel.setActive(true);
      await refreshCounts(ctx);
      if (!signal.aborted) notify(ctx, `Smart Mem ready: ${next.model} on ${device.toUpperCase()}`);
    }, signal);
    return { title, run };
  }

  async function setup(ctx: ExtensionCommandContext) {
    const current = await readActivePreset();
    return runManualJob(ctx, ctx.mode === "tui" && !current, async (signal) => {
      const setup = await prepareSetup(ctx, current, signal);
      return setup && { kind: "setup", ...setup };
    });
  }

  async function setDevice(ctx: ExtensionContext, device: Device) {
    await embeddings.run(async (worker) => {
      if ((await file.read()).device === device) return;
      const model = await readActivePreset();
      if (!model) throw new Error("Set up Smart Mem before changing device");
      await progress(ctx, `Testing ${device.toUpperCase()}`, async () => {
        await worker.embed(model, device, "Test embedding device");
        await file.update({ device });
        if (hasPanel(ctx)) panel.notice(`Embedding device set to ${device.toUpperCase()}`);
      });
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

  async function inject(ctx: ExtensionContext, settings: Settings, messages: Message[], manual = false) {
    const action = () => selectInjection(ctx, settings, messages);
    if (!manual && !hasPanel(ctx)) return action();
    return progress(ctx, "Selecting relevant memories", action);
  }

  async function selectInjection(ctx: ExtensionContext, settings: Settings, messages: Message[]) {
    const ids: string[] = [];
    let submitted = false;
    const available = tools.filter(({ name }) => lookupNames.includes(name));
    const selection = operation(toolNames.selectMemories, "Submit existing memory IDs in selection order; an empty list is valid.", Type.Object({ ids: Type.Array(Type.String()) }), ({ ids: chosen }) => {
      ids.push(...new Set(chosen)); submitted = true;
      return { value: { selected: ids.length } };
    });
    const task = [prompt(settings, "precedence"), prompt(settings, "injection")].join("\n\n");
    await runModel(ctx, messages, task, [...available, selection], { settings, signal: ctx.signal, done: () => submitted });
    if (!submitted) throw new Error("Model did not submit a memory selection");
    const notes = await getStore().readMany(ids);
    const { kept, overflow } = injectionText(notes.map(({ text }) => text));
    if (overflow) notify(ctx, "Memory injection exceeded 32 KiB. Remaining notes were not injected.", "warning");
    else if (hasPanel(ctx)) panel.notice(kept.length ? `Injected ${kept.length} saved ${kept.length === 1 ? "memory" : "memories"}` : "No relevant memories selected");
    void log.write("injection.finish", { selected: kept.length, overflow });
    if (!kept.length) return undefined;
    return { customType: injectedType, content: `${prompt(settings, "injected")}\n\n${kept.join("\n\n")}`, display: false };
  }

  async function review(ctx: ExtensionContext, settings: Settings, trigger: Trigger, messages: Message[], request?: string, signal?: AbortSignal): Promise<ReviewRow> {
    const report = newReport();
    const activity = begin(ctx, `Memory review · ${trigger}`);
    void log.write("review.start", { trigger, model: settings.reviewModel?.id ?? ctx.model?.id });
    const previous = reviewQueue;
    const loop = previous.then(async () => {
      signal?.throwIfAborted();
      const available = reviewTools.filter(({ name }) => settings.reviewTools.includes(name));
      const reinforce = settings.reviewTools.includes(toolNames.reinforceMemory);
      if (reinforce) {
        const target = getStore();
        const original = ctx.sessionManager.getBranch().flatMap((entry) => {
          if (entry.type !== "message") return [];
          const message = entry.message;
          if (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult") return [];
          return messages.some(({ role, timestamp }) => role === message.role && timestamp === message.timestamp) ? [entry] : [];
        });
        available.push(operation(toolNames.reinforceMemory,
          "Boost an existing same-scope memory for a new incident. Supply a unique verbatim excerpt of the original evidence from this session.",
          Type.Object({ id: Type.String({ minLength: 1 }), evidence: Type.String({ minLength: 1 }) }), async ({ id, evidence }, signal) => {
            const quote = evidence.trim();
            const matches = quote ? original.filter(({ message }) => "content" in message && contentText(message.content).includes(quote)) : [];
            if (matches.length !== 1) throw new Error("Quote unique original evidence from an active session message");
            const entry = matches[0];
            const incident = createHash("sha256").update(JSON.stringify([entry.id, entry.message.timestamp])).digest("hex");
            const saved = await target.reinforce(id, incident, signal);
            return { value: { reinforced: saved }, saved };
          }));
      }
      const task = reviewTask(settings, trigger, request);
      await runModel(ctx, messages, reinforce ? `${task}\n\n${prompt(settings, "reinforce")}` : task, available, {
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
    const row = { ...report, calls: [...report.calls], trigger, status };
    void log.write("review.finish", { trigger, status, saved: report.saved, calls: report.calls.length, error: report.error }, failed ? "error" : "info");
    for (const call of report.calls) void log.write("review.tool", { trigger, name: call.name, error: call.isError ? String(call.result) : undefined }, call.isError ? "error" : "info");
    if (report.saved) await refreshCounts(ctx);
    if (activity) activity.finish(`Memory review · ${status}`, failed ? "error" : "info", reviewDetails(row));
    return row;
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
    void log.write("transcript.index", { entries: end - indexed });
    indexed = end;
  }

  pi.on("session_start", async (_event, ctx) => {
    activeContext = ctx;
    try { activePreset = await readActivePreset(); }
    catch (error) { await log.write("session.start_failed", { error: String(error) }, "error"); throw error; }
    if (hasPanel(ctx)) panel.mount(ctx.ui, !!activePreset);
    if (activePreset) {
      await bindProject(ctx);
      await refreshCounts(ctx);
    }
    void log.write("session.start", { mode: ctx.mode, configured: !!activePreset, model: activePreset?.model, project });
    initial = ctx.sessionManager.getEntries().some((entry) => entry.type === "custom" && entry.customType === initialType);
    if (!activePreset && main && ctx.hasUI) notify(ctx, `Smart Mem is not set up. Run /${commands.setup} to set it up.`, "warning");
  });

  pi.on("before_agent_start", async (event, ctx) => {
    activeContext = ctx;
    const settings = await file.read();
    if (!activePreset) return;
    const pins = await archive.pins();
    const active = new Set(pi.getActiveTools());
    const memoryExposed = tools.some(({ name }) => active.has(name));
    const guidance = memoryExposed ? [prompt(settings, "precedence"), prompt(settings, "recall"), prompt(settings, "write")] : [];
    if (main && active.has(toolNames.skillSave)) guidance.push(prompt(settings, "skillWrite"));
    if (pins.length) guidance.push(...pins);
    if (guidance.length) return { systemPrompt: [event.systemPrompt, ...guidance].join("\n\n") };
  });

  pi.on("context_with_system", (event, ctx) => {
    if (main && activePreset) lastContext = { projected: projected(ctx), actual: convertToLlm(event.messages) };
  });
  pi.on("session_tree", () => { lastContext = undefined; pending = []; });

  const reviewDetails = (data: ReviewRow) => [
    `Trigger: ${data.trigger}`,
    ...data.calls.map((call) => `${call.name} ${JSON.stringify(call.arguments)} → ${call.isError ? "Error: " : ""}${JSON.stringify(call.result) ?? "No result"}`),
    data.rationale && `Reason: ${data.rationale}`, data.error && `Error: ${data.error}`,
  ].filter(Boolean).join("\n");

  pi.registerEntryRenderer<ReviewRow>(reviewTitle, (entry, { expanded }, theme) => {
    const box = new Box(1, 0);
    const data = entry.data;
    if (!data) return box;
    box.addChild(new Text(theme.fg("accent", `Memory review · ${data.status}`), 0, 0));
    if (expanded) {
      // Do not interpret model-provided terminal escapes in the custom renderer.
      box.addChild(new Text(reviewDetails(data).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ""), 0, 0));
    }
    return box;
  });

  pi.on("session_shutdown", async (event, ctx) => {
    manualMaintenance?.abort();
    manualMaintenance = undefined;
    panel.dispose();
    toolActivity.clear();
    try {
      if (main && activePreset && event.reason !== "reload") {
        await flush(ctx);
        await indexCurrent(ctx);
      }
    } catch (error) { reportError(ctx, error); }
    finally {
      embeddings.close();
      await log.write("session.shutdown", { reason: event.reason });
    }
  });

  const exposedNames = new Set(tools.map(({ name }) => name));
  pi.on("tool_execution_start", (event, ctx) => {
    if (!exposedNames.has(event.toolName)) return;
    void log.write("tool.start", { name: event.toolName, id: event.toolCallId });
    if (hasPanel(ctx)) toolActivity.set(event.toolCallId, panel.begin(event.toolName));
  });
  const inventoryTools = new Set([toolNames.memoryAdd, toolNames.memoryRemove, toolNames.skillSave]);
  pi.on("tool_execution_end", async (event, ctx) => {
    if (!exposedNames.has(event.toolName)) return;
    const saved = event.result?.details?.saved === true;
    const status = event.isError ? "Failed" : saved ? "Saved" : "Finished";
    const detail = contentText(event.result?.content) || undefined;
    void log.write("tool.finish", { name: event.toolName, id: event.toolCallId, status, ms: event.durationMs,
      error: event.isError ? detail : undefined }, event.isError ? "error" : "info");
    toolActivity.get(event.toolCallId)?.finish(`${event.toolName} · ${status}`, event.isError ? "error" : "info", detail);
    toolActivity.delete(event.toolCallId);
    if (saved && inventoryTools.has(event.toolName)) await refreshCounts(ctx);
  });

  if (!main) return;

  pi.registerShortcut(memoryPanelShortcut, { description: "Toggle Memory panel details", handler: (ctx) => { if (hasPanel(ctx)) panel.toggle(); } });

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
      if (deferredImportIndex) deferredImportIndex.pending = true;
      else await indexCurrent(ctx);
      const settings = await file.read();
      if (settings.autoLink) {
        let activity: Activity | undefined;
        try {
          const result = await runMaintenance({ kind: "link", scopes: project ? ["project", "global"] : ["global"], automatic: true, ctx, store, settings,
            messages: withActiveContext(projected(ctx)), embed: (text, signal) => embed(text, false, signal), progress: (line) => {
              activity ??= begin(ctx, "Automatic linking");
              activity?.update(line);
            } });
          activity?.finish(`Automatic linking · Created ${result.changes} memory links${skipSummary(result.skipped)}`);
        } finally { activity?.clear(); }
      }
    } catch (error) { reportError(ctx, error); }
  });
  registerCommand(commands.setup, {
    description: "Set up Smart Mem embeddings and storage",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      try {
        if (!ctx.hasUI) throw new Error("Smart Mem setup requires interactive Pi");
        await setup(ctx);
      } catch (error) { reportError(ctx, error); }
    },
  });
  registerCommand(commands.settings, {
    description: "Configure Smart Mem",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      try {
        await openSettings(ctx, file, [...reviewTools.map(({ name }) => name), toolNames.reinforceMemory], {
          model: () => activePreset,
          setup: () => setup(ctx), device: (device) => setDevice(ctx, device),
          backfill: async () => {
            const a = getArchive();
            const count = await progress(ctx, "Backfilling past Pi conversations", (log) => a.backfill(join(getAgentDir(), "sessions"), log));
            notify(ctx, `Indexed ${count} Pi sessions`);
          },
          prune: async () => {
            if (!await ctx.ui.confirm("Clear transcript index?", "Original Pi transcripts will not be changed.")) return;
            await getArchive().prune();
            notify(ctx, "Transcript index cleared");
          },
        });
      } catch (error) { reportError(ctx, error); }
    },
  });
  registerCommand(commands.migrateHermes, {
    description: "Import all pi-hermes-memory data (use force to replace existing Smart Mem data)",
    handler: async (args, ctx) => {
      const argument = args.trim();
      const noticeMs = 60_000;
      if (argument && argument !== "force") { reportError(ctx, new Error(`Use /${commands.migrateHermes} [force]`), noticeMs); return; }
      const force = argument === "force";
      const background = ctx.mode === "tui" && !force;
      await runManualJob(ctx, background, async (signal) => {
        const readSource = () => readHermesSource(getAgentDir(), ctx.cwd);
        // Verify that there is something to import before asking to set up.
        const sourceForSetup = !activePreset ? await readSource() : undefined;
        const needsSetup = !activePreset && ctx.hasUI;
        if (needsSetup && background) await ctx.waitForIdle();
        const firstSetup = needsSetup ? await prepareSetup(ctx, await readActivePreset(), signal) : undefined;
        if (!firstSetup) getStore();
        const title = "Migrating Hermes";
        return {
          kind: "migrate-hermes", title,
          run: async (report, signal) => {
            const deferred = background ? { pending: false } : undefined;
            if (deferred) {
              deferredImportIndex = deferred;
              void log.write("operation.start", { title });
            }
            try {
              if (firstSetup) {
                await firstSetup.run((message) => report(`Setting up · ${message}`), signal);
                signal.throwIfAborted();
              }
              if (force) {
                const warning = "Replacing Smart Mem database contents: existing memories, links, skills, pins, and transcript search index will be removed. Hermes files will not change.";
                notify(ctx, warning, "warning", warning, noticeMs);
              }
              const source = sourceForSetup ?? await readSource();
              const result = await migrateHermes({ source, dbPath, force, signal, embed: (text) => embed(text, false, signal), progress: (message) => {
                if (background) void log.write("operation.progress", { title, message });
                report(message);
              } });
              return { source, result };
            } finally {
              if (deferred) {
                try {
                  while (deferred.pending && !signal.aborted) {
                    deferred.pending = false;
                    await indexCurrent(ctx);
                  }
                } catch (error) { reportError(ctx, error, noticeMs); }
                finally { deferredImportIndex = undefined; }
              }
            }
          },
          complete: async ({ source, result }, signal) => {
            await bindProject(ctx);
            if (signal.aborted) return;
            await refreshCounts(ctx);
            if (signal.aborted) return;
            const summary = `Imported ${source.memories.length} memories, ${source.skills.length} skills, and ${source.pins.length} pins across global scope and ${result.projects} projects`;
            const unmatched = result.unmatchedProjects.length
              ? `Imported projects without a matching folder:\n${result.unmatchedProjects.map(({ name, id }) => `${name}: ${id}`).join("\n")}` : undefined;
            if (hasPanel(ctx) && unmatched) {
              // The timed panel can truncate large lists. Preserve every ID in the log.
              await Promise.all(result.unmatchedProjects.map((pair) => log.write("migration.unmatched_project", pair, "warning")));
              if (!signal.aborted) notify(ctx, `${summary} · ${result.unmatchedProjects.length} unmatched (see smart-mem.log)`, "warning", unmatched, noticeMs);
            } else {
              notify(ctx, summary, "info", undefined, noticeMs);
              if (unmatched) ctx.ui.notify(unmatched, "warning");
            }
          },
        };
      }, noticeMs);
    },
  });
  registerCommand(commands.inject, {
    description: "Select and inject relevant saved memories",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      try {
        getStore();
        const settings = await file.read();
        const addition = await inject(ctx, settings, withActiveContext(projected(ctx)), true);
        if (addition) pi.sendMessage(addition, { triggerTurn: false });
        if (!hasPanel(ctx)) notify(ctx, addition ? "Injected relevant memories" : "No relevant memories selected");
      } catch (error) { reportError(ctx, error); }
    },
  });
  type Job = {
    kind: string; title: string; scopes: Scope[]; summary: (changes: number) => string; refresh?: boolean;
    run: (report: Progress, signal: AbortSignal) => Promise<MaintenanceResult>;
  };
  type ManualWork<T> = {
    kind: string; title: string;
    run: (report: Progress, signal: AbortSignal) => Promise<T>;
    complete?: (outcome: T, signal: AbortSignal, activity?: Activity) => void | Promise<void>;
  };
  async function runManualJob<T>(ctx: ExtensionCommandContext, background: boolean, prepare: (signal: AbortSignal) => ManualWork<T> | undefined | Promise<ManualWork<T> | undefined>, noticeMs?: number): Promise<boolean> {
    if (!background) await ctx.waitForIdle();
    if (manualMaintenance) {
      notify(ctx, "Smart Mem maintenance is already running in this session", "warning");
      return false;
    }
    const controller = new AbortController();
    const foregroundSignal = background ? undefined : ctx.signal;
    const signal = foregroundSignal ? AbortSignal.any([controller.signal, foregroundSignal]) : controller.signal;
    manualMaintenance = controller;
    const finish = () => { if (manualMaintenance === controller) manualMaintenance = undefined; };
    try {
      const work = await prepare(signal);
      if (!work) { finish(); return false; }
      const { kind, title, run, complete } = work;
      signal.throwIfAborted();
      const activity = background ? begin(ctx, title) : undefined;
      if (!activity) {
        try {
          const outcome = await progress(ctx, title, (report) => run(report, signal));
          if (!signal.aborted) await complete?.(outcome, signal);
        } finally { finish(); }
        return false;
      }
      // Keep the command handler out of Pi's input loop once work starts.
      void (async () => {
        try {
          const outcome = await run(activity.update, signal);
          if (!signal.aborted) await complete?.(outcome, signal, activity);
        } catch (error) {
          if (!signal.aborted) {
            void log.write("maintenance.command_error", { kind, error: String(error) }, "error");
            activity.finish(`${title} · Failed`, "error", String(error), noticeMs);
          }
        } finally { activity.clear(); finish(); }
      })().catch((error) => { if (!signal.aborted) reportError(ctx, error, noticeMs); });
      return true;
    } catch (error) {
      finish();
      if (!signal.aborted) reportError(ctx, error, noticeMs);
      return false;
    }
  }

  function registerMaintenanceCommand(command: string, description: string, prepare: (args: string, ctx: ExtensionCommandContext) => Job) {
    registerCommand(command, { description, handler: async (args, ctx) => {
      await runManualJob(ctx, ctx.mode === "tui", () => {
        const { kind, title, scopes, summary, run, refresh } = prepare(args, ctx);
        return { kind, title, run, complete: async (outcome, signal, activity) => {
          const result = summary(outcome.changes) + skipSummary(outcome.skipped);
          if (activity) {
            if (refresh && outcome.changes) await refreshCounts(ctx);
            if (!signal.aborted) activity.finish(result, "info", `Scope: ${scopes.join(" and ")}${outcome.skipped ? "\nSee smart-mem.log for skipped notes." : ""}`);
          } else notify(ctx, result);
        } };
      });
    } });
  }

  for (const [kind, command] of [["link", commands.link], ["consolidate", commands.consolidate]] as const) {
    const link = kind === "link";
    registerMaintenanceCommand(command, link ? "Build related-memory links" :
      "Consolidate unchecked project memories. Options: global (unchecked in both scopes), full (all project), global full (all in both scopes)", (args, ctx) => {
      const { scopes, full } = link ? { scopes: scopedMaintenance(project, args), full: false } : consolidationOptions(project, args);
      const target = getStore();
      const messages = link ? withActiveContext(projected(ctx)) : [];
      const systemPrompt = link ? ctx.getSystemPrompt() : "";
      const modelContext = { model: ctx.model, modelRegistry: ctx.modelRegistry, thinkingLevel: ctx.thinkingLevel, getSystemPrompt: () => systemPrompt };
      return { kind, scopes, title: link ? "Building memory links" : "Consolidating memories", refresh: !link,
        summary: (changes) => link ? `Created ${changes} memory links` : `Updated ${changes} saved memories`,
        run: async (report, signal) => runMaintenance({
          kind, scopes, full, ctx: modelContext, store: target, settings: await file.read(), messages,
          embed: (text, signal) => embed(text, false, signal), progress: report, signal,
        }),
      };
    });
  }

  function batchJob(ctx: ExtensionCommandContext, kind: string, title: string, scopes: Scope[], summary: Job["summary"],
    action: (options: BatchOptions) => Promise<MaintenanceResult>, refresh = false): Job {
    const target = getStore();
    const model = { model: ctx.model, modelRegistry: ctx.modelRegistry, thinkingLevel: ctx.thinkingLevel, getSystemPrompt: () => "" };
    const batch = { kind, scopes: scopes.join(","), model: model.model?.id };
    return { kind, title, scopes, summary, refresh, run: async (report, signal) => {
      void log.write("maintenance.start", batch);
      const result = await action({ ctx: model, store: target, scopes, signal, settings: await file.read(), diagnostics: log, progress: (message) => {
        void log.write("maintenance.progress", { ...batch, message });
        report(message);
      }, onFailure: (scope, ids, attempt, reason) => {
        void log.write("maintenance.batch_failed", { ...batch, scope, ids: ids.join(","), attempt, reason }, "warning");
      } });
      void log.write("maintenance.finish", { ...batch, ...result }, result.skipped ? "warning" : "info");
      return result;
    } };
  }

  registerMaintenanceCommand(commands.reclassify, "Review and update stored memory kinds", (args, ctx) =>
    batchJob(ctx, "reclassify", "Reclassifying memories", scopedMaintenance(project, args),
      (changes) => `Reclassified ${changes} saved memories`, reclassifyMemories));

  registerMaintenanceCommand(commands.cleanupConflicts, "Clean up stored memory conflicts with guidance or other memories", (args, ctx) => {
    const mode = cleanupMode(args);
    const scopes: Scope[] = project ? ["project", "global"] : ["global"];
    const promptOptions = ctx.getSystemPromptOptions();
    return batchJob(ctx, "cleanup-conflicts", "Cleaning up memory conflicts", scopes,
      (changes) => `Cleaned up ${changes} conflicting memories`,
      (options) => cleanupConflicts(options, mode, (text, signal) => embed(text, false, signal),
        () => conflictGuidance(promptOptions, getAgentDir())), true);
  });

  registerCommand(commands.pin, {
    description: "Save standing instructions for this project or globally",
    handler: async (args, ctx) => {
      try {
        const value = args.trim();
        const scope = /^global(?:\s|$)/.test(value) ? "global" : "project";
        const text = scope === "global" ? value.slice(6).trim() : value;
        if (!text) throw new Error(`Use /${commands.pin} <text> or /${commands.pin} global <text>`);
        await getArchive().pin(scope, text);
        await refreshCounts(ctx);
        notify(ctx, `Saved ${scope} pin`, "info", text);
      } catch (error) { reportError(ctx, error); }
    },
  });
}
