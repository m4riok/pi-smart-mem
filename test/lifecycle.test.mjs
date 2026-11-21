import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:net";
import { createInterface } from "node:readline";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import { getCurrentSystemPrompt, getCurrentTools, fauxProvider, fauxAssistantMessage, fauxToolCall, contentText } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, initTheme, ModelRuntime, SessionManager, SettingsManager, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { getKeybindings, KeybindingsManager, setKeybindings } from "@earendil-works/pi-tui";
import { Archive } from "../src/archive.ts";
import { withDatabase } from "../src/database.ts";
import { models } from "../src/embeddings.ts";
import { openSocketDirectory } from "../src/embedding-protocol.ts";
import { MemoryStore } from "../src/memory-store.ts";
import { resolveProject } from "../src/project.ts";
import { prompts, SettingsFile } from "../src/settings.ts";

const hermesNames = ["memory_add", "memory_replace", "memory_remove", "session_search", "memory_search"];

async function fixture(t, { child = false, setup = false, empty = false, hermes = false, mode = "rpc", setWidget = () => {}, select, custom, confirm = false } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "smart-mem-pi-"));
  const agentDir = join(cwd, "agent");
  const directory = join(agentDir, "pi-smart-mem");
  const alerts = [];
  const errors = [];
  let boundSession;
  t.after(async () => {
    if (boundSession) {
      await boundSession.extensionRunner.emit({ type: "session_shutdown", reason: "reload" });
      boundSession.dispose();
    }
    await rm(cwd, { recursive: true, force: true });
  });
  const previousAgent = process.env.PI_CODING_AGENT_DIR;
  const previousChild = process.env.PI_SUBAGENT_CHILD;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  if (child) process.env.PI_SUBAGENT_CHILD = "1";
  else delete process.env.PI_SUBAGENT_CHILD;
  t.after(() => {
    if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgent;
    if (previousChild === undefined) delete process.env.PI_SUBAGENT_CHILD;
    else process.env.PI_SUBAGENT_CHILD = previousChild;
  });
  const store = new MemoryStore(undefined, join(directory, "db"));
  const archive = new Archive(join(directory, "db"));
  const { model, dimensions } = models[0];
  let note;
  if (!setup) {
    await store.initialize({ model, dimensions });
    if (!empty) {
      note = await store.add({ scope: "global", kind: "preference", text: "Use exit status to verify tests ran" }, { model, values: Array.from({ length: dimensions }, (_, i) => i === 0 ? 1 : 0) });
      await archive.pin("global", "Standing pin fixture");
    }
  }
  await new SettingsFile(directory).update({ initialMessages: 6, periodicTurns: 3, prompts: { recall: "Recall prompt fixture", correction: "Correction task fixture", explicit: "Explicit task fixture", periodic: "Periodic task fixture", injection: "Injection task fixture" } });
  const faux = fauxProvider({ provider: "smart-mem-fixture", tokensPerSecond: 100000 });
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, modelsStorePath: join(agentDir, "models-cache.json"), refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 16 } });
  const additionalExtensionPaths = [new URL("../index.ts", import.meta.url).pathname];
  if (hermes) {
    const path = join(cwd, "hermes-fixture.mjs");
    await writeFile(path, `export default function (pi) {
      for (const name of ${JSON.stringify(hermesNames)}) pi.registerTool({
        name, label: name, description: "Hermes fixture tool", parameters: { type: "object", properties: {} },
        execute: async () => ({ content: [{ type: "text", text: "Hermes fixture" }] }),
      });
    }`);
    additionalExtensionPaths.push(path);
  }
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, additionalExtensionPaths, noContextFiles: true });
  await resourceLoader.reload();
  const sessionManager = SessionManager.create(cwd, join(agentDir, "sessions", "fixture"));
  const { session } = await createAgentSession({ cwd, agentDir, settingsManager, resourceLoader, modelRuntime, model: faux.getModel(), sessionManager,
    tools: child ? ["psm_memory_read", "psm_skill_save"] : undefined, noTools: child ? undefined : "builtin" });
  boundSession = session;
  const dialogs = [];
  const ui = { notify: (...args) => alerts.push(args), setWidget,
    select: select ?? (async (title, options) => {
      if (!setup) throw new Error("Unexpected setup dialog");
      dialogs.push(title);
      return options[0];
    }),
    custom,
    confirm: async (title) => { dialogs.push(title); return confirm; },
  };
  await session.bindExtensions({ mode, uiContext: ui, onError: (error) => errors.push(error) });
  return { session, note, archive, faux, alerts, errors, sessionManager, store, directory, dialogs, cwd };
}

async function pausedEmbeddingWorker(directory) {
  const workerDirectory = join(directory, "embedding-worker");
  await mkdir(workerDirectory, { recursive: true });
  const endpoint = await openSocketDirectory(workerDirectory);
  const started = Promise.withResolvers();
  const resumed = Promise.withResolvers();
  let client;
  const server = createServer((socket) => {
    client = socket;
    const reply = (data) => { if (!socket.destroyed) socket.write(JSON.stringify(data) + "\n"); };
    reply({ kind: "ready" });
    createInterface({ input: socket }).on("line", async (line) => {
      const request = JSON.parse(line);
      if (request.kind === "probe") { reply({ kind: "probe" }); return; }
      started.resolve({ request, closed: once(socket, "close") });
      if (request.download) reply({ kind: "progress", message: "Downloading fixture model" });
      await resumed.promise;
      const { model, dimensions } = models[0];
      reply({ kind: "embedding", embedding: { model, values: Array.from({ length: dimensions }, (_, i) => Number(i === 0)) } });
    });
  });
  await once(server.listen(endpoint.path), "listening");
  return { started: started.promise, resume: resumed.resolve, close: async () => {
    resumed.resolve();
    client?.destroy();
    await new Promise((resolve) => server.close(resolve));
    await endpoint.close();
  } };
}

const text = (messages) => messages.filter((m) => m.role === "user").map((m) => contentText(m.content)).join("\n");
const rows = (sessionManager) => sessionManager.getEntries().filter((e) => e.type === "custom" && e.customType === "smart-mem-review").map((e) => e.data);
const injections = (sessionManager) => sessionManager.getEntries().filter((e) => e.type === "custom_message" && e.customType === "smart-mem-injection");

async function waitFor(check, description) {
  const deadline = Date.now() + 4000;
  while (!await check()) {
    assert.ok(Date.now() < deadline, `Timed out waiting for ${description}`);
    await delay(10);
  }
}
const waitForReviews = (manager, count) => waitFor(() => rows(manager).length >= count, `${count} review rows`);

test("unconfigured startup warns without opening the picker; setup command asks before creating storage", async (t) => {
  const { session, dialogs, directory, alerts, errors, faux } = await fixture(t, { setup: true });
  assert.deepEqual(session.extensionRunner.getRegisteredCommands().map(({ name }) => name).sort(), [
    "psm-cleanup-conflicts", "psm-consolidate", "psm-inject", "psm-link", "psm-migrate-hermes", "psm-pin", "psm-reclassify", "psm-settings", "psm-setup",
  ]);
  assert.deepEqual(dialogs, []);
  assert.ok(alerts.some(([message, level]) => level === "warning" && message.includes("/psm-setup")));
  assert.equal(faux.state.callCount, 0);
  await assert.rejects(stat(join(directory, "db")), { code: "ENOENT" });
  await assert.rejects(stat(join(directory, "models")), { code: "ENOENT" });

  await session.prompt("/psm-setup");
  assert.deepEqual(dialogs, ["Set up Smart Mem: select an embedding model", "Initialize Smart Mem?"]);
  assert.equal(faux.state.callCount, 0);
  await assert.rejects(stat(join(directory, "db")), { code: "ENOENT" });
  await assert.rejects(stat(join(directory, "models")), { code: "ENOENT" });
  assert.deepEqual(errors, []);
});

test("startup displays and logs database upgrades, and blocks unsupported schemas", async (t) => {
  let render;
  const frames = [];
  const { session, note, store, directory, faux, errors } = await fixture(t, { mode: "tui", setWidget: (_key, build) => {
    render = undefined;
    const widget = build?.({ requestRender: () => { if (render) frames.push(render()); } }, { fg: (_color, text) => text });
    if (widget) render = () => widget.render(180).join("\n");
  } });
  const path = join(directory, "db");
  const query = (sql) => withDatabase(path, false, (db) => db.query(sql).collect());
  await query("REMOVE TABLE smart_schema; REMOVE FIELD consolidated ON memory;");
  await session.reload();
  assert.ok(frames.some((frame) => frame.includes("Schema 0 → 1")), JSON.stringify(frames));
  assert.match(render(), /Smart Mem database upgraded to schema 1/);
  assert.deepEqual(await store.read(note.id), note);
  await session.reload();
  assert.doesNotMatch(render(), /database upgraded/);
  const log = async () => (await readFile(join(directory, "smart-mem.log"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual((await log()).filter(({ event }) => event.startsWith("schema.migration.")).map(({ event, from, to }) => ({ event, from, to })), [
    { event: "schema.migration.start", from: 0, to: 1 },
    { event: "schema.migration.applied", from: 0, to: 1 },
  ]);
  await query("UPDATE smart_schema:current SET version = 2;");
  await session.reload();
  assert.match(render(), /^🧠 ····  Not set up/);
  assert.match(render(), /schema 2 is newer than supported schema 1/);
  assert.ok((await log()).some(({ event, error }) => event === "schema.open_failed" && error.includes("schema 2")));
  await session.prompt("/psm-consolidate global");
  assert.equal(faux.state.callCount, 0);
  assert.deepEqual(await store.read(note.id), note);
  assert.deepEqual(errors, []);
});

test("Smart Mem and Hermes tool names coexist in one Pi session", async (t) => {
  const { session, alerts, errors } = await fixture(t, { hermes: true });
  assert.ok(!alerts.some(([message]) => message.includes("/psm-setup")));
  const names = session.getAllTools().map(({ name }) => name);
  for (const name of hermesNames) {
    assert.ok(names.includes(name), `Missing Hermes tool ${name}`);
    assert.ok(names.includes(`psm_${name}`), `Missing Smart Mem tool psm_${name}`);
  }
  assert.deepEqual(errors, []);
});

test("Hermes migration command refuses existing data unless forced and warns before replacing it", async (t) => {
  const { session, note, archive, alerts, errors, store, cwd, faux } = await fixture(t);
  const source = join(cwd, "agent", "pi-hermes-memory");
  await mkdir(source);
  await writeFile(join(source, "STANDING.md"), "- Imported standing instruction\n");
  await session.prompt("/psm-migrate-hermes");
  assert.ok(alerts.some(([message, level]) => level === "error" && message.includes("/psm-migrate-hermes force")));
  await session.prompt("/psm-migrate-hermes --force");
  assert.ok(alerts.some(([message, level]) => level === "error" && message.includes("Use /psm-migrate-hermes [force]")));
  assert.deepEqual(await store.read(note.id), note);
  await session.prompt("/psm-migrate-hermes force");
  const warning = alerts.findIndex(([message, level]) => level === "warning" && /Replacing Smart Mem database contents/.test(message));
  const success = alerts.findIndex(([message, level]) => level === "info" && /Imported 0 memories, 0 skills, and 1 pins/.test(message));
  assert.ok(warning >= 0 && success > warning);
  assert.equal(await store.read(note.id), undefined);
  assert.deepEqual(await archive.pins(), ["Imported standing instruction"]);
  assert.equal(await readFile(join(source, "STANDING.md"), "utf8"), "- Imported standing instruction\n");
  assert.equal(faux.state.callCount, 0);
  assert.deepEqual(errors, []);
});

for (const reload of [false, true]) {
  test(`interactive Hermes import ${reload ? "cancels on reload" : "allows chat and shows a 60-second unmatched notice"}`, { timeout: 10_000 }, async (t) => {
    let panel;
    const { session, faux, store, archive, directory, errors, alerts } = await fixture(t, { mode: "tui", empty: true, setWidget: (_key, build) => {
      panel = build?.({ requestRender() {} }, { fg: (_color, text) => text });
    } });
    const source = join(directory, "..", "pi-hermes-memory");
    const missing = join(directory, "..", "projects-memory", "missing-project");
    await mkdir(source);
    await mkdir(missing, { recursive: true });
    await writeFile(join(source, "MEMORY.md"), "A Hermes fixture note");
    await writeFile(join(missing, "MEMORY.md"), "A note from an unmatched project");
    const noticeTimer = Promise.withResolvers();
    const set = globalThis.setTimeout;
    t.mock.method(globalThis, "setTimeout", (callback, ms, ...args) => {
      if (ms === 60_000) noticeTimer.resolve(() => callback(...args));
      return set(callback, ms, ...args);
    });
    const worker = await pausedEmbeddingWorker(directory);
    try {
      await session.prompt("/psm-migrate-hermes");
      const { closed } = await worker.started;
      if (reload) {
        await session.reload();
        await closed;
        assert.deepEqual(await store.list("global"), []);
      } else {
        faux.setResponses([fauxAssistantMessage("Chat worked during migration")]);
        await session.prompt("migrationchatfixture");
        assert.equal(faux.state.callCount, 1);
        assert.equal(await store.hasStoredData(), false);
        worker.resume();
        const expireNotice = await noticeTimer.promise;
        assert.match(panel.render(180).join("\n"), /Imported 2 memories.*1 unmatched/);
        assert.ok(!alerts.some(([message]) => message.includes("missing-project:")));
        const log = await readFile(join(directory, "smart-mem.log"), "utf8");
        const unmatched = log.trim().split("\n").map(JSON.parse).find(({ event }) => event === "migration.unmatched_project");
        assert.equal(unmatched.name, "missing-project");
        assert.match(unmatched.id, /^[\da-f-]{36}$/);
        expireNotice();
        assert.doesNotMatch(panel.render(180).join("\n"), /Imported 2 memories/);
        assert.deepEqual((await store.list("global")).map(({ text }) => text), ["A Hermes fixture note"]);
        assert.ok((await archive.searchTranscripts("migrationchatfixture")).some(({ text }) => text === "migrationchatfixture"));
      }
      assert.deepEqual(errors, []);
    } finally { await worker.close(); }
  });
}

for (const command of ["psm-setup", "psm-settings", "psm-migrate-hermes"]) {
  test(`first-time setup from /${command} lets Pi chat during the model download`, { timeout: 10_000 }, async (t) => {
    const importing = command === "psm-migrate-hermes";
    const fromSettings = command === "psm-settings";
    const menuChoices = fromSettings ? [0, models[0]] : [models[0]];
    const completed = Promise.withResolvers();
    const downloading = Promise.withResolvers();
    let customCalls = 0;
    const { session, directory, dialogs, faux, store, errors } = await fixture(t, { setup: true, mode: "tui", confirm: true,
      custom: async () => menuChoices[customCalls++],
      setWidget: (_key, build) => {
        if (!build) return;
        const panel = build({ requestRender() {
          const visible = panel.render(180).join("\n");
          if (visible.includes("Downloading fixture model")) downloading.resolve();
          if (visible.includes(importing ? "Imported 1 memories" : "Smart Mem ready:")) completed.resolve();
        } }, { fg: (_color, text) => text });
      },
    });
    if (importing) {
      const source = join(directory, "..", "pi-hermes-memory");
      await mkdir(source);
      await writeFile(join(source, "MEMORY.md"), "First-time import fixture");
    }
    const worker = await pausedEmbeddingWorker(directory);
    try {
      await session.prompt(`/${command}`);
      assert.equal(customCalls, menuChoices.length);
      assert.deepEqual(dialogs, ["Initialize Smart Mem?"]);
      const { request } = await worker.started;
      assert.equal(request.download, true);
      await downloading.promise;
      await assert.rejects(stat(join(directory, "db")), { code: "ENOENT" });
      faux.setResponses([fauxAssistantMessage("Chat worked while the model downloaded")]);
      await session.prompt("Can you respond during setup?");
      assert.equal(faux.state.callCount, 1);
      worker.resume();
      await completed.promise;
      assert.equal((await store.embeddingSpace()).model, models[0].model);
      assert.deepEqual((await store.list("global")).map(({ text }) => text), importing ? ["First-time import fixture"] : []);
      assert.deepEqual(errors, []);
    } finally { await worker.close(); }
  });
}

test("Pi runs user-triggered and periodic reviews and adds independent, repeatable injections", async (t) => {
  const { session, note, faux, alerts, errors, sessionManager, archive, store, directory } = await fixture(t);
  const removable = await store.add({ scope: "global", kind: "preference", text: "Obsolete fixture" }, { model: models[0].model, values: Array.from({ length: models[0].dimensions }, (_, i) => Number(i === 0)) });
  const seen = [];
  faux.setResponses([
    (ctx) => {
      assert.match(getCurrentSystemPrompt(ctx.messages), /Standing pin fixture/);
      assert.match(getCurrentSystemPrompt(ctx.messages), /Recall prompt fixture/);
      assert.ok(getCurrentTools(ctx.messages).some((tool) => tool.name === "psm_memory_related"));
      return fauxAssistantMessage("First answer");
    },
    fauxAssistantMessage("Second answer"),
    (ctx) => {
      seen.push("correction");
      const system = getCurrentSystemPrompt(ctx.messages);
      assert.match(system, /Correction task fixture/);
      assert.match(system, /compare the detail against the saved note itself/);
      assert.match(system, /lacks a durable qualification, condition, or outcome, use psm_memory_replace/);
      assert.match(system, /Use psm_reinforce_memory only when the existing same-scope note already fully covers the durable information/);
      assert.match(text(ctx.messages), /First historical detail/);
      assert.match(text(ctx.messages), /No, use pnpm/);
      assert.doesNotMatch(getCurrentTools(ctx.messages).map((tool) => tool.name).join(" "), /psm_memory_remove|bash/);
      return fauxAssistantMessage("No durable correction yet");
    },
    fauxAssistantMessage("Third answer"),
    (ctx) => {
      seen.push("initial");
      assert.match(getCurrentSystemPrompt(ctx.messages), /Injection task fixture/);
      return fauxAssistantMessage(fauxToolCall("psm_select_memories", { ids: [note.id] }));
    },
    (ctx) => {
      seen.push("explicit");
      assert.match(getCurrentSystemPrompt(ctx.messages), /Explicit task fixture/);
      assert.match(text(ctx.messages), /Remember this: use fixtures/);
      const names = getCurrentTools(ctx.messages).map((tool) => tool.name);
      assert.ok(names.includes("psm_memory_remove"));
      assert.ok(!names.includes("psm_skill_save"));
      return fauxAssistantMessage(fauxToolCall("psm_memory_remove", { id: removable.id }));
    },
    fauxAssistantMessage("Removed obsolete fixture memory"),
    (ctx) => {
      seen.push("periodic");
      assert.match(getCurrentSystemPrompt(ctx.messages), /Periodic task fixture/);
      return fauxAssistantMessage("Nothing else to save");
    },
  ]);
  await session.prompt("First historical detail");
  await session.prompt("No, use pnpm for this task.");
  await waitForReviews(sessionManager, 1);
  const file = new SettingsFile(directory);
  // A pre-prefix review allowlist still permits removal, but never skill saves.
  await file.update({ reviewTools: [...(await file.read()).reviewTools, "skill_save", "memory_remove"] });
  await session.prompt("Remember this: use fixtures for regression checks.");
  await waitForReviews(sessionManager, 3);
  assert.deepEqual(seen, ["correction", "initial", "explicit", "periodic"]);
  assert.deepEqual(rows(sessionManager).map(({ trigger, status }) => [trigger, status]), [["correction", "Skipped"], ["explicit", "Saved · 1"], ["periodic", "Skipped"]]);
  assert.equal(await store.read(removable.id), undefined);
  assert.equal(injections(sessionManager).length, 1);
  faux.appendResponses(Array.from({ length: 2 }, () => fauxAssistantMessage(fauxToolCall("psm_select_memories", { ids: [note.id] }))));
  await session.prompt("/psm-inject");
  await session.prompt("/psm-inject");
  assert.deepEqual(errors, []);
  assert.deepEqual(alerts.filter(([, level]) => level === "error"), []);
  assert.equal(injections(sessionManager).length, 3);
  assert.ok(injections(sessionManager).every(({ content }) => content.includes(note.text)));
  assert.equal((await archive.searchTranscripts("historical")).length, 1);
  assert.deepEqual(errors, []);
  assert.deepEqual(alerts.filter(([, level]) => level === "error"), []);
});

test("interactive manual injection shares the review queue without blocking chat", { timeout: 10000 }, async (t) => {
  let panel;
  const { session, note, faux, directory, sessionManager, errors } = await fixture(t, { mode: "tui", setWidget: (key, build) => {
    if (key === "smart-mem") panel = build?.({ requestRender() {} }, { fg: (_color, text) => text });
  } });
  await new SettingsFile(directory).update({ initialMessages: 100, periodicTurns: 100 });
  const review = Promise.withResolvers();
  const selection = Promise.withResolvers();
  const reviewDone = fauxAssistantMessage("Nothing to save");
  const selected = fauxAssistantMessage(fauxToolCall("psm_select_memories", { ids: [note.id] }));
  let selectorInput;
  let nextPromptHadInjection;
  try {
    faux.setResponses([
      fauxAssistantMessage("Correction acknowledged"),
      () => review.promise,
      fauxAssistantMessage("Replied before selection started"),
      ({ messages }) => { selectorInput = text(messages); return selection.promise; },
      ({ messages }) => {
        nextPromptHadInjection = messages.some((message) => "content" in message && contentText(message.content).includes(note.text));
        return fauxAssistantMessage("Replied while selection was running");
      },
    ]);
    await session.prompt("No, use the actual exit status.");
    await session.prompt("/psm-inject");
    assert.match(panel.render(120).join("\n"), /Queued: Selecting relevant memories/);
    await session.prompt("Chat before selection starts");
    assert.equal(selectorInput, undefined);
    review.resolve(reviewDone);
    await waitFor(() => selectorInput !== undefined, "queued injection to start");
    assert.match(selectorInput, /No, use the actual exit status/);
    assert.doesNotMatch(selectorInput, /Chat before selection starts/);
    await session.prompt("Chat while selection is running");
    assert.equal(nextPromptHadInjection, false);
    assert.deepEqual(injections(sessionManager), []);
    selection.resolve(selected);
    await waitFor(() => injections(sessionManager).length === 1, "selected memory to be injected");
    assert.ok(injections(sessionManager)[0].content.includes(note.text));
    assert.deepEqual(errors, []);
  } finally {
    review.resolve(reviewDone);
    selection.resolve(selected);
  }
});

test("manual injection treats clean empty and omitted selections alike but reports failures", async (t) => {
  const { session, faux, alerts, sessionManager, directory, errors } = await fixture(t);
  const logPath = join(directory, "smart-mem.log");
  faux.setResponses([
    fauxAssistantMessage("No applicable memories"),
    fauxAssistantMessage(fauxToolCall("psm_select_memories", { ids: [] })),
    fauxAssistantMessage(fauxToolCall("psm_memory_search", { limit: "fixture-private-argument" })),
    fauxAssistantMessage("Could not search"),
    fauxAssistantMessage("", { stopReason: "error", errorMessage: "Selector service unavailable" }),
  ]);
  await session.prompt("/psm-inject");
  await session.prompt("/psm-inject");
  assert.equal(faux.state.callCount, 2);
  assert.equal(alerts.filter(([message, level]) => level === "info" && message === "No relevant memories selected").length, 2);
  assert.deepEqual(alerts.filter(([, level]) => level === "error"), []);
  await session.prompt("/psm-inject");
  await session.prompt("/psm-inject");
  const failures = alerts.filter(([, level]) => level === "error").map(([message]) => message);
  assert.equal(failures.length, 2);
  assert.match(failures[0], /psm_memory_search.*query/s);
  assert.match(failures[1], /Selector service unavailable/);
  const outcomes = async () => (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line)).filter(({ event }) => event === "injection.finish");
  await waitFor(async () => (await outcomes()).length === 2, "both empty injection outcomes in diagnostics");
  assert.deepEqual((await outcomes()).map(({ manual, selected }) => [manual, selected]), [[true, 0], [true, 0]]);
  assert.doesNotMatch(failures[0], /Received arguments|fixture-private-argument/);
  assert.doesNotMatch(await readFile(logPath, "utf8"), /Received arguments|fixture-private-argument/);
  assert.deepEqual(injections(sessionManager), []);
  assert.deepEqual(errors, []);
});

test("explicit review waits for a foreground save and sees its confirmed result", { timeout: 10000 }, async (t) => {
  const { session, faux, directory, sessionManager, store } = await fixture(t);
  const settings = new SettingsFile(directory);
  await settings.update({ initialMessages: 100, periodicTurns: 100 });
  const worker = await pausedEmbeddingWorker(directory);
  try {
    const draft = { scope: "global", kind: "note", text: "Fixture polling stops after the fifth consecutive connection error." };
    let saved;
    let reviewContext;
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("psm_memory_search", { query: "polling connection errors" })),
      fauxAssistantMessage(fauxToolCall("psm_memory_add", draft)),
      ({ messages }) => {
        saved = JSON.parse(contentText(messages.find((message) => message.role === "toolResult" && message.toolName === "psm_memory_add").content));
        return fauxAssistantMessage("Saved in the foreground.");
      },
      ({ messages }) => {
        reviewContext = messages;
        return fauxAssistantMessage("Already saved by the foreground agent.");
      },
    ]);
    const turn = session.prompt(`Remember this: ${draft.text}`);
    await worker.started;
    worker.resume();
    await turn;
    await waitForReviews(sessionManager, 1);
    const reviewResults = reviewContext.filter((message) => message.role === "toolResult" && message.toolName === "psm_memory_add");
    assert.equal(reviewResults.length, 1);
    assert.ok(contentText(reviewResults[0].content).includes(saved.result.id));
    assert.ok(reviewContext.some((message) => message.role === "assistant" && contentText(message.content).includes("Saved in the foreground.")));
    assert.equal(saved.saved, true);
    assert.equal((await store.list("global")).filter(({ text }) => text === draft.text).length, 1);
    assert.deepEqual(rows(sessionManager).map(({ trigger, status }) => [trigger, status]), [["explicit", "Skipped"]]);
  } finally { await worker.close(); }
});

test("foreground receives skill guidance and can choose project or global scope", async (t) => {
  const { session, archive, faux, errors, directory, cwd, sessionManager } = await fixture(t);
  const file = new SettingsFile(directory);
  const draft = (scope) => ({ scope, name: `${scope} fixture`, description: "Run regression fixtures", text: "Create isolated fixtures before testing." });
  faux.setResponses([
    (ctx) => {
      assert.match(getCurrentSystemPrompt(ctx.messages), /Before saving, use psm_skill_search/);
      const names = getCurrentTools(ctx.messages).map((tool) => tool.name);
      for (const name of ["psm_skill_search", "psm_skill_read", "psm_skill_save"]) assert.ok(names.includes(name));
      return fauxAssistantMessage(fauxToolCall("psm_skill_save", draft("project")));
    },
    fauxAssistantMessage("Saved project fixture skill"),
    (ctx) => {
      assert.match(getCurrentSystemPrompt(ctx.messages), /Skill guidance override fixture/);
      assert.doesNotMatch(getCurrentSystemPrompt(ctx.messages), /Before saving, use psm_skill_search/);
      return fauxAssistantMessage(fauxToolCall("psm_skill_save", draft("global")));
    },
    fauxAssistantMessage("Saved global fixture skill"),
  ]);
  await session.prompt("Save this project fixture procedure as a skill.");
  await file.update({ prompts: { skillWrite: "Skill guidance override fixture" } });
  await session.prompt("Save the portable fixture procedure as a skill.");
  const project = (await readFile(join(cwd, ".pi", "smart-mem-id"), "utf8")).trim();
  const localArchive = new Archive(join(directory, "db"), project);
  assert.deepEqual((await localArchive.searchSkills("fixture")).map(({ name, scope }) => [name, scope]), [["global fixture", "Global"], ["project fixture", "Project"]]);
  assert.deepEqual((await archive.searchSkills("fixture")).map(({ name }) => name), ["global fixture"]);
  assert.deepEqual(rows(sessionManager), []);
  assert.deepEqual(errors, []);
});

test("interactive maintenance reports progress and results while normal chat remains usable", { timeout: 10_000 }, async (t) => {
  const frames = [];
  const finished = Promise.withResolvers();
  let registrations = 0;
  const { session, faux, errors } = await fixture(t, { mode: "tui", setWidget: (key, build, options) => {
    if (!build) return;
    assert.equal(key, "smart-mem");
    assert.equal(options.placement, "aboveEditor");
    assert.equal(typeof build, "function");
    registrations++;
    const paint = () => {
      const lines = widget.render(100);
      frames.push(lines);
      if (lines.some((line) => line.trim() === "Updated 0 saved memories")) finished.resolve();
    };
    const widget = build({ requestRender: paint }, { fg: (_color, text) => text });
    paint();
  } });
  assert.equal(frames.at(-1)[0], "🧠 ━━━━  Active");
  const judging = Promise.withResolvers();
  const decision = Promise.withResolvers();
  t.after(() => decision.resolve(fauxAssistantMessage("No decision")));
  faux.setResponses([
    (ctx) => {
      judging.resolve(getCurrentSystemPrompt(ctx.messages));
      return decision.promise;
    },
    (ctx) => {
      assert.match(text(ctx.messages), /Background work should not block this prompt/);
      assert.doesNotMatch(getCurrentSystemPrompt(ctx.messages), /Leave the source unchanged by default/);
      return fauxAssistantMessage("Normal response while maintenance is running");
    },
  ]);
  await session.prompt("/psm-consolidate global");
  assert.match(await judging.promise, /Leave the source unchanged by default/);
  assert.ok(frames.at(-1).some((line) => line.includes("Consolidating global memories: 1/1")));
  await session.prompt("/psm-link global");
  assert.ok(frames.at(-1).some((line) => line.includes("Queued: Building memory links")));
  await session.prompt("Background work should not block this prompt");
  assert.equal(faux.state.callCount, 2);
  decision.resolve(fauxAssistantMessage(fauxToolCall("psm_consolidate_note", { ids: [] })));
  await finished.promise;
  await waitFor(() => frames.at(-1).some((line) => line.includes("Created 0 memory links")), "queued linking outcome");
  assert.equal(registrations, 1);
  assert.ok(frames.at(-1)[0].startsWith("🧠 ━━━━  Active"));
  assert.deepEqual(errors, []);
});

test("reviews and consolidation share a FIFO queue without blocking chat or direct memory reads", { timeout: 10000 }, async (t) => {
  let widget;
  const { session, note, faux, directory, sessionManager, errors } = await fixture(t, {
    mode: "tui",
    setWidget: (_key, build) => { widget = build?.({ requestRender() {} }, { fg: (_color, text) => text }); },
  });
  await new SettingsFile(directory).update({ initialMessages: 100, periodicTurns: 100 });
  const first = Promise.withResolvers();
  const consolidation = Promise.withResolvers();
  const started = [];
  t.after(() => { first.resolve(fauxAssistantMessage("First review done")); consolidation.resolve(fauxAssistantMessage(fauxToolCall("psm_consolidate_note", { ids: [] }))); });
  faux.setResponses([
    fauxAssistantMessage("Correction acknowledged"),
    ({ messages }) => { started.push(["correction", text(messages)]); return first.promise; },
    fauxAssistantMessage(fauxToolCall("psm_memory_read", { id: note.id })),
    ({ messages }) => {
      assert.match(contentText(messages.find(({ role }) => role === "toolResult").content), /Use exit status/);
      return fauxAssistantMessage("Answer despite running review");
    },
    ({ messages }) => { started.push(["consolidation", text(messages)]); return consolidation.promise; },
    ({ messages }) => { started.push(["explicit", text(messages)]); return fauxAssistantMessage("Second review done"); },
  ]);
  const render = () => widget.render(140).join("\n");
  await session.prompt("No, use the actual exit status.");
  assert.match(render(), /Memory review · correction/);
  await session.prompt("/psm-consolidate global");
  await session.prompt("Remember this: read the exit status from the wrapper.");
  assert.deepEqual(started.map(([kind]) => kind), ["correction"]);
  assert.match(render(), /Queued: Consolidating memories\n  Queued: Memory review · explicit/);
  assert.deepEqual(rows(sessionManager), []);
  first.resolve(fauxAssistantMessage("First review done"));
  await waitFor(() => started.length >= 2, "consolidation after review");
  assert.deepEqual(started.map(([kind]) => kind), ["correction", "consolidation"]);
  assert.match(render(), /Consolidating global memories: 1\/1/);
  assert.match(render(), /Queued: Memory review · explicit/);
  consolidation.resolve(fauxAssistantMessage(fauxToolCall("psm_consolidate_note", { ids: [] })));
  await waitForReviews(sessionManager, 2);
  assert.deepEqual(started.map(([kind]) => kind), ["correction", "consolidation", "explicit"]);
  assert.doesNotMatch(started[0][1], /read the exit status from the wrapper/);
  assert.match(started[2][1], /read the exit status from the wrapper/);
  assert.deepEqual(rows(sessionManager).map(({ trigger, rationale }) => [trigger, rationale]), [["correction", "First review done"], ["explicit", "Second review done"]]);
  assert.doesNotMatch(render(), /Queued:/);
  assert.deepEqual(errors, []);
});

test("RPC maintenance waits in the same queue and still reports its outcome", { timeout: 10000 }, async (t) => {
  const { session, faux, directory, alerts, sessionManager } = await fixture(t);
  await new SettingsFile(directory).update({ initialMessages: 100, periodicTurns: 100 });
  const review = Promise.withResolvers();
  t.after(() => review.resolve(fauxAssistantMessage("Review done")));
  faux.setResponses([
    fauxAssistantMessage("Acknowledged"),
    () => review.promise,
    fauxAssistantMessage(fauxToolCall("psm_consolidate_note", { ids: [] })),
  ]);
  await session.prompt("No, use the actual exit status.");
  let completed = false;
  const command = session.prompt("/psm-consolidate global").then(() => { completed = true; });
  const logPath = join(directory, "smart-mem.log");
  await waitFor(async () => (await readFile(logPath, "utf8")).includes('"name":"psm-consolidate"'), "RPC command start");
  assert.equal(completed, false);
  assert.equal(faux.state.callCount, 2);
  review.resolve(fauxAssistantMessage("Review done"));
  await command;
  assert.equal(rows(sessionManager).length, 1);
  assert.deepEqual(alerts.at(-1), ["Updated 0 saved memories", "info"]);
});

for (const reason of ["quit", "reload"]) test(`${reason} cancels review and discards pending jobs without a final review`, { timeout: 10000 }, async (t) => {
  const { session, note, store, faux, directory, sessionManager, errors } = await fixture(t, { mode: "tui" });
  const settings = new SettingsFile(directory);
  await settings.update({ initialMessages: 100, periodicTurns: 100, reviewTools: [...(await settings.read()).reviewTools, "psm_memory_remove"] });
  faux.setResponses(Array.from({ length: 5 }, () => fauxAssistantMessage("Ordinary answer")));
  for (let i = 0; i < 5; i++) await session.prompt(`Conversation message ${i}`);
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  const returned = Promise.withResolvers();
  t.after(() => release.resolve());
  faux.appendResponses([
    fauxAssistantMessage("Correction acknowledged"),
    async (_ctx, options) => {
      started.resolve(options.signal);
      await release.promise;
      returned.resolve();
      return fauxAssistantMessage(fauxToolCall("psm_memory_remove", { id: note.id }));
    },
  ]);
  await session.prompt("No, use the fixture instead.");
  const signal = await started.promise;
  await session.prompt("/psm-consolidate global");
  await session.prompt("/psm-inject");
  if (reason === "reload") await session.reload();
  else await session.extensionRunner.emit({ type: "session_shutdown", reason });
  assert.equal(signal.aborted, true);
  release.resolve();
  await returned.promise;
  assert.deepEqual(await store.read(note.id), note);
  assert.deepEqual(rows(sessionManager), []);
  assert.deepEqual(injections(sessionManager), []);
  assert.equal(faux.state.callCount, 7);
  assert.deepEqual(errors, []);
});

test("interactive Memory panel separates scoped counts and refreshes after writes", async (t) => {
  let panel;
  const { session, note, faux, errors } = await fixture(t, { mode: "tui", setWidget: (key, build) => {
    if (key === "smart-mem") panel = build?.({ requestRender() {} }, { fg: (_color, text) => text });
  } });
  const counts = (width = 100) => panel.render(width).slice(1).join("\n");
  assert.equal(panel.render(100)[0], "🧠 ━━━━  Active");
  assert.match(counts(), /Project: 0 mem · 0 skills · 0 pins  │  Global: 1 mem · 0 skills · 1 pins/);
  await session.prompt("/psm-pin Preserve the fixture");
  assert.match(counts(45), /Project: 0 mem · 0 skills · 1 pins\n  Global: 1 mem · 0 skills · 1 pins/);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("psm_skill_save", { name: "Verify fixtures", description: "Fixture workflow", text: "Run tests", scope: "project" })),
    fauxAssistantMessage(fauxToolCall("psm_memory_remove", { id: note.id })),
    fauxAssistantMessage("Updated stored fixtures"),
  ]);
  await session.prompt("Update the stored fixtures");
  assert.match(counts(), /Project: 0 mem · 1 skills · 1 pins  │  Global: 0 mem · 0 skills · 1 pins/);
  assert.deepEqual(errors, []);
});

test("interactive Memory panel reports foreground tools and reviews without replacing their results", async (t) => {
  let panel;
  const { session, note, faux, sessionManager, errors } = await fixture(t, { mode: "tui", setWidget: (key, build) => {
    if (key === "smart-mem") panel = build?.({ requestRender() {} }, { fg: (_color, text) => text });
  } });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("psm_memory_read", { id: note.id })),
    (ctx) => {
      const result = ctx.messages.find(({ role }) => role === "toolResult");
      assert.match(contentText(result.content), /Use exit status/);
      assert.ok(panel.render(100).some((line) => line.includes("psm_memory_read · Finished")));
      assert.ok(!panel.render(100).join("\n").includes("Use exit status"));
      return fauxAssistantMessage("Read fixture note");
    },
    fauxAssistantMessage("Correction acknowledged"),
    fauxAssistantMessage("Not a durable change"),
  ]);
  await session.prompt("Look up the test note");
  await session.prompt("No, use pnpm for this task.");
  await waitForReviews(sessionManager, 1);
  assert.ok(panel.render(100).some((line) => line.includes("Memory review · Skipped")));
  assert.equal(rows(sessionManager).at(-1).rationale, "Not a durable change");
  const review = sessionManager.getEntries().find((entry) => entry.customType === "smart-mem-review");
  assert.equal(session.extensionRunner.getEntryRenderer(review.customType)(review, { expanded: false }), undefined);

  initTheme("dark", false);
  const previousBindings = getKeybindings();
  t.after(() => setKeybindings(previousBindings));
  setKeybindings(new KeybindingsManager({ "app.tools.expand": { defaultKeys: "ctrl+o", description: "Toggle tool output" } }));
  const entries = sessionManager.getEntries();
  const result = entries.find(({ message }) => message?.role === "toolResult" && message.toolName === "psm_memory_read").message;
  const name = result.toolName;
  const row = new ToolExecutionComponent(name, result.toolCallId, { id: note.id }, {}, session.extensionRunner.getToolDefinition(name), { requestRender() {} });
  row.updateResult(result);
  const render = (width) => row.render(width).map(stripVTControlCharacters).map((line) => line.trim()).filter(Boolean);
  const collapsed = render(100);
  assert.equal(collapsed.length, 2);
  assert.equal(collapsed[0], `psm_memory_read id=${JSON.stringify(note.id)}`);
  assert.match(collapsed[1], /^Finished.*ctrl\+o to expand/i);
  assert.doesNotMatch(collapsed.join("\n"), /Use exit status/);
  const narrow = render(36);
  assert.equal(narrow.length, 2);
  assert.match(narrow[0], /^psm_memory_read id=.*(?:\.\.\.|…)$/u);
  assert.ok(!narrow[0].includes(note.id));
  row.setExpanded(true);
  const expanded = render(100).join("\n");
  assert.ok(expanded.includes(`Arguments: ${JSON.stringify({ id: note.id })}`));
  assert.match(expanded, /Result: .*Use exit status/);
  assert.doesNotMatch(expanded, /to expand/i);
  row.setExpanded(false);
  assert.deepEqual(render(100), collapsed);
  assert.deepEqual(errors, []);
});

test("reloading Pi cancels background linking and replaces its old panel",  { timeout: 10_000 }, async (t) => {
  let rendered;
  const { session, note, faux, store, errors } = await fixture(t, { mode: "tui", setWidget: (key, build) => {
    if (key !== "smart-mem") return;
    rendered = build?.({ requestRender() {} }, { fg: (_color, text) => text });
  } });
  const { model, dimensions } = models[0];
  const embedding = { model, values: Array.from({ length: dimensions }, (_, i) => i === 0 ? 1 : 0) };
  await store.add({ scope: "global", kind: "preference", text: "Check return codes" }, embedding);
  const judging = Promise.withResolvers();
  const decision = Promise.withResolvers();
  t.after(() => decision.resolve());
  faux.setResponses([async (ctx, options) => {
    const { candidates } = JSON.parse(getCurrentSystemPrompt(ctx.messages).match(/^\{"source":.+$/m)[0]);
    judging.resolve(options.signal);
    await decision.promise;
    return fauxAssistantMessage(fauxToolCall("psm_select_links", { ids: [candidates[0].id] }));
  }]);
  await session.prompt("/psm-link global");
  const signal = await judging.promise;
  assert.ok(rendered.render(100).some((line) => line.includes("Linking global memories")));
  const previous = rendered;
  await session.reload();
  assert.equal(signal.aborted, true);
  assert.notEqual(rendered, previous);
  assert.equal(rendered.render(100)[0], "🧠 ━━━━  Active");
  assert.ok(!rendered.render(100).some((line) => line.includes("Linking global memories")));
  decision.resolve();
  assert.deepEqual(await store.related(note.id), []);
  assert.deepEqual(errors, []);
});

for (const kind of ["link", "consolidate"]) test(`${kind} retries an overloaded provider and skips a note after two tool failures`, async (t) => {
  const { session, faux, store, alerts, errors, directory } = await fixture(t);
  const { model, dimensions } = models[0];
  const vector = { model, values: [1, ...Array(dimensions - 1).fill(0)] };
  for (const label of ["A", "B"]) await store.add({ scope: "global", kind: "preference", text: `Private fixture body ${label}` }, vector);
  const before = await store.list("global");
  const name = kind === "link" ? "psm_select_links" : "psm_consolidate_note";
  const calls = [];
  const response = (step, reply) => (ctx) => {
    const system = getCurrentSystemPrompt(ctx.messages);
    const note = before[step];
    const input = kind === "link" ? system : text(ctx.messages);
    assert.ok(input.includes(`"source":{"id":"${note.id}"`), input);
    calls.push(note.id);
    return reply;
  };
  const overload = "Codex error: Our servers are currently overloaded. Please try again later.";
  const failedTool = fauxAssistantMessage(fauxToolCall(name, { ids: ["invalid-target"] }));
  const noChange = fauxAssistantMessage(fauxToolCall(name, { ids: [] }));
  faux.setResponses([
    response(0, fauxAssistantMessage("", { stopReason: "error", errorMessage: overload })), response(0, noChange),
    response(1, failedTool), response(1, failedTool), response(2, noChange),
  ]);
  await session.prompt(`/psm-${kind} global`);
  assert.deepEqual(calls, [before[0].id, before[0].id, before[1].id, before[1].id, before[2].id]);
  assert.ok(alerts.some(([message, level]) => level === "info" && message.includes("Skipped 1 note")));
  assert.ok(!alerts.some(([, level]) => level === "error"));
  if (kind === "link") assert.deepEqual((await store.list("global", true)).map(({ id }) => id), [before[1].id]);
  await session.reload();
  const raw = await readFile(join(directory, "smart-mem.log"), "utf8");
  const events = raw.trim().split("\n").map(JSON.parse);
  const failures = events.filter(({ event }) => event === "maintenance.note_failed");
  assert.deepEqual(failures.map(({ noteId, attempt }) => [noteId, attempt]), [[before[0].id, 1], [before[1].id, 1], [before[1].id, 2]]);
  assert.equal(failures[0].reason, `Error: ${overload}`);
  assert.ok(events.some(({ event, skipped }) => event === "maintenance.finish" && skipped === 1));
  assert.ok(!raw.includes("Private fixture body"));
  assert.deepEqual(errors, []);
});

test("incremental consolidation tracks checked text, retains older candidates, and supports both full modes", { timeout: 20_000 }, async (t) => {
  const { session, faux, store, directory, cwd, errors } = await fixture(t, { empty: true });
  const path = join(directory, "db");
  const project = new MemoryStore(await resolveProject(cwd, path), path);
  const { model, dimensions } = models[0];
  const vector = { model, values: [1, ...Array(dimensions - 1).fill(0)] };
  const old = await project.add({ scope: "project", kind: "note", text: "Older project note" }, vector);
  const global = await store.add({ scope: "global", kind: "note", text: "Global note" }, vector);
  const command = session.extensionRunner.getRegisteredCommands().find(({ name }) => name === "psm-consolidate");
  assert.match(command.description, /global.*full.*global full/);
  const unchanged = { ids: [] };
  const run = async (args, ids, decide = () => unchanged) => {
    const inputs = [];
    const start = faux.state.callCount;
    faux.setResponses(ids.map(() => ({ messages }) => {
      const input = JSON.parse(text(messages));
      inputs.push(input);
      const decision = decide(input);
      return decision ? fauxAssistantMessage(fauxToolCall("psm_consolidate_note", decision)) : fauxAssistantMessage("No tool decision");
    }));
    await session.prompt(`/psm-consolidate${args ? ` ${args}` : ""}`);
    assert.deepEqual(inputs.map(({ source }) => source.id), ids);
    assert.equal(faux.state.callCount - start, ids.length);
    return inputs;
  };
  await run("", [old.id]);
  await session.reload();
  await run("", []);
  await run("global", [global.id]);
  const fresh = await project.add({ scope: "project", kind: "note", text: "New related project note" }, vector);
  const combined = "New and older project notes combined";
  const worker = await pausedEmbeddingWorker(directory);
  try {
    worker.resume();
    const [input] = await run("", [fresh.id], () => ({ ids: [old.id], text: combined }));
    assert.deepEqual(input.candidates.map(({ id }) => id), [old.id]);
    assert.equal(await project.read(old.id), undefined);
    assert.equal((await project.read(fresh.id)).text, combined);
    await run("global", []);
    await run("full", [fresh.id, fresh.id], () => undefined);
    await run("", [fresh.id]);
    await project.replace(fresh.id, "Edited project note", vector);
    await run("", [fresh.id]);
    await run("global full", [fresh.id, global.id]);
    await run("global", []);
    assert.deepEqual(errors, []);
  } finally { await worker.close(); }
});

test("consolidation skips standalone rewrites below either savings threshold without retrying", async (t) => {
  const { session, faux, store, alerts, errors, directory } = await fixture(t, { empty: true });
  const { model, dimensions } = models[0];
  const vector = { model, values: [1, ...Array(dimensions - 1).fill(0)] };
  const cases = [
    { body: "A".repeat(200), saved: 29, accepted: false },
    { body: "B".repeat(601), saved: 30, accepted: false },
    { body: "C".repeat(600), saved: 30, accepted: true },
    { body: "D".repeat(100), saved: -5, accepted: false },
  ];
  const notes = new Map();
  for (const example of cases) {
    const note = await store.add({ scope: "global", kind: "note", text: example.body }, vector);
    notes.set(note.id, { ...example, note });
  }
  const ordered = await store.list("global");
  faux.setResponses(ordered.map(({ id }) => {
    const { body, saved } = notes.get(id);
    const replacement = saved > 0 ? body.slice(0, -saved) : body + ".".repeat(-saved);
    return fauxAssistantMessage(fauxToolCall("psm_consolidate_note", { ids: [], text: replacement }));
  }));
  const worker = await pausedEmbeddingWorker(directory);
  try {
    worker.resume();
    await session.prompt("/psm-consolidate global");
    assert.equal(faux.state.callCount, cases.length);
    assert.ok(alerts.some(([message, level]) => level === "info" && message === "Updated 1 saved memories"));
    for (const { note, body, saved, accepted } of notes.values()) {
      const current = await store.read(note.id);
      if (accepted) assert.equal(current.text, body.slice(0, -saved));
      else assert.deepEqual(current, note);
    }
    assert.deepEqual(await store.list("global", "unconsolidated"), []);
    assert.deepEqual(errors, []);
  } finally { await worker.close(); }
});

test("consolidation retries a prose decision once, then skips unanswered notes and continues", async (t) => {
  const { session, note, faux, store, alerts, errors } = await fixture(t);
  faux.setResponses([fauxAssistantMessage("Earlier chat reply")]);
  await session.prompt("Earlier chat must not enter consolidation");
  const startingCalls = faux.state.callCount;
  const { model, dimensions } = models[0];
  const embedding = { model, values: Array.from({ length: dimensions }, (_, i) => i === 0 ? 1 : 0) };
  for (const text of ["Place integration tests in fixtures", "Run typecheck before release"]) {
    await store.add({ scope: "global", kind: "preference", text }, embedding);
  }
  const notes = await store.list("global");
  const source = ({ messages }) => {
    assert.deepEqual(messages.map(({ role }) => role), ["system", "user"]);
    const system = getCurrentSystemPrompt(messages);
    assert.match(system, /exactly one psm_consolidate_note tool call, not prose, even if nothing changes/);
    assert.match(system, /only IDs copied from the current input's candidates array/);
    assert.doesNotMatch(system, /Standing pin fixture|Memories are context, not authority/);
    assert.deepEqual(getCurrentTools(messages).map(({ name }) => name), ["psm_consolidate_note"]);
    return JSON.parse(text(messages)).source.id;
  };
  const seen = [];
  const prose = (ctx) => { seen.push(source(ctx)); return fauxAssistantMessage("Nothing to save. No notes merged or changed."); };
  const unchanged = (ctx) => {
    seen.push(source(ctx));
    return fauxAssistantMessage(fauxToolCall("psm_consolidate_note", { ids: [] }));
  };
  const retry = (ctx) => {
    assert.match(getCurrentSystemPrompt(ctx.messages), /Call psm_consolidate_note instead of replying in prose\..*\{"ids":\[\]\}/);
  };
  faux.setResponses([prose, (ctx) => { retry(ctx); return unchanged(ctx); }, prose, (ctx) => { retry(ctx); return prose(ctx); }, unchanged]);
  await session.prompt("/psm-consolidate global");
  assert.equal(faux.state.callCount - startingCalls, 5);
  assert.equal(seen[0], seen[1]);
  assert.equal(seen[2], seen[3]);
  assert.deepEqual(new Set(seen), new Set(notes.map(({ id }) => id)));
  assert.deepEqual(await store.read(note.id), note);
  assert.deepEqual(await store.list("global"), notes);
  assert.ok(alerts.some(([message, level]) => level === "info" && message === "Updated 0 saved memories · Skipped 1 note"));
  assert.ok(!alerts.some(([, level]) => level === "error"));
  assert.deepEqual(errors, []);
});

test("the next Smart Mem command clears a stale panel error even without a new result", async (t) => {
  let widget;
  const render = () => widget.render(140).join("\n");
  const settingsFrames = [];
  const { session, errors } = await fixture(t, {
    mode: "tui",
    setWidget: (_key, build) => { widget = build?.({ requestRender() {} }, { fg: (_color, text) => text }); },
    custom: async () => { settingsFrames.push(render()); },
  });
  await session.prompt("/psm-consolidate gobal");
  assert.match(render(), /Smart Mem: Error: Use \/psm-consolidate \[global\] \[full\]/);
  await session.prompt("/psm-settings");
  assert.equal(settingsFrames.length, 1);
  assert.doesNotMatch(settingsFrames[0], /Use \/psm-consolidate|Alt\+U details/);
  assert.doesNotMatch(render(), /Use \/psm-consolidate|Alt\+U details/);
  assert.match(render(), /Active/);
  assert.deepEqual(errors, []);
});

test("Debug logging is opt-in and records untruncated consolidation input, replies and tool calls", async (t) => {
  let toggle;
  const { session, store, directory, faux, errors } = await fixture(t, { select: async (title, options) => {
    if (title === "Smart Mem settings" && toggle) {
      const menuItem = options.find((option) => option.startsWith("Debug logging: "));
      assert.equal(menuItem, `Debug logging: ${toggle === "ON" ? "OFF" : "ON"}`);
      return menuItem;
    }
    if (title.startsWith("Debug logging")) {
      assert.deepEqual(options, ["OFF", "ON"]);
      const selected = toggle;
      toggle = undefined;
      return selected;
    }
  } });
  const settings = new SettingsFile(directory);
  assert.equal((await settings.read()).debugLogging, false);
  const { model, dimensions } = models[0];
  const body = "Private consolidation note " + "x".repeat(9000) + " end of note";
  await store.add({ scope: "global", kind: "preference", text: body }, { model, values: [1, ...Array(dimensions - 1).fill(0)] });
  const readLog = async () => {
    await session.reload();
    return (await readFile(join(directory, "smart-mem.log"), "utf8")).trim().split("\n").map(JSON.parse);
  };
  const unchanged = fauxAssistantMessage(fauxToolCall("psm_consolidate_note", { ids: [] }));
  const malformed = fauxAssistantMessage(fauxToolCall("psm_consolidate_note", { text: "Private malformed tool payload" }));
  faux.setResponses([malformed, unchanged, unchanged]);
  await session.prompt("/psm-consolidate global");
  const off = await readLog();
  assert.ok(off.some(({ event }) => event === "maintenance.finish"));
  assert.ok(!off.some(({ level }) => level === "debug"));
  assert.match(off.find(({ event }) => event === "maintenance.note_failed").reason, /Validation failed/);
  assert.doesNotMatch(JSON.stringify(off), /Private consolidation note|Private malformed tool payload/);

  toggle = "ON";
  await session.prompt("/psm-settings");
  assert.equal((await settings.read()).debugLogging, true);
  const inputs = [];
  const capture = (reply) => (ctx) => { inputs.push(JSON.parse(text(ctx.messages))); return reply; };
  const prose = "No changes needed on the first attempt.";
  const invalid = { ids: ["outside-current-shortlist"], text: "model's proposed replacement" };
  faux.setResponses([
    capture(fauxAssistantMessage(prose)), capture(unchanged),
    capture(fauxAssistantMessage(fauxToolCall("psm_consolidate_note", invalid))), capture(unchanged),
  ]);
  await session.prompt("/psm-consolidate global full");
  const debug = (await readLog()).filter(({ level }) => level === "debug");
  assert.deepEqual(debug.filter(({ event }) => event === "consolidation.request").map(({ input }) => input), inputs);
  assert.ok(inputs.some(({ source, candidates }) => [source, ...candidates].some(({ text }) => text === body)));
  const replies = debug.filter(({ event }) => event === "consolidation.response");
  assert.deepEqual(replies.map(({ attempt }) => attempt), [1, 2, 1, 2]);
  assert.equal(contentText(replies[0].content), prose);
  assert.deepEqual(replies[2].content.find(({ type }) => type === "toolCall").arguments, invalid);

  toggle = "OFF";
  await session.prompt("/psm-settings");
  assert.equal((await settings.read()).debugLogging, false);
  faux.setResponses([unchanged, unchanged]);
  await session.prompt("/psm-consolidate global full");
  assert.equal((await readLog()).filter(({ level }) => level === "debug").length, debug.length);
  assert.deepEqual(errors, []);
});

test("manual linking, reclassification, and both cleanup passes trace decisions only in debug mode", async (t) => {
  const { session, store, note, directory, faux, errors } = await fixture(t);
  const { model, dimensions } = models[0];
  const body = "Private maintenance note " + "x".repeat(9000);
  const guidance = "Private maintenance guidance";
  await store.add({ scope: "global", kind: "note", text: body }, { model, values: [1, ...Array(dimensions - 1).fill(0)] });
  await writeFile(join(directory, "..", "SYSTEM.md"), guidance);
  faux.setResponses([fauxAssistantMessage("Ordinary chat response")]);
  await session.prompt("Private linking conversation");
  const unchanged = (name) => fauxAssistantMessage(fauxToolCall(name, name.endsWith("_batch") ? { updates: [] } : { ids: [] }));
  const run = async (debugLogging) => {
    await new SettingsFile(directory).update({ debugLogging });
    const malformed = fauxAssistantMessage(fauxToolCall("psm_select_links", { text: "Private invalid decision" }));
    faux.setResponses([malformed, unchanged("psm_select_links"), unchanged("psm_select_links")]);
    await session.prompt("/psm-link global");
    faux.setResponses([fauxAssistantMessage(fauxToolCall("psm_reclassify_batch", { updates: [{ id: note.id, kind: debugLogging ? "guideline" : note.kind }] }))]);
    await session.prompt("/psm-reclassify global");
    faux.setResponses([unchanged("psm_cleanup_guidance_batch"), unchanged("psm_cleanup_memory_conflict"), unchanged("psm_cleanup_memory_conflict")]);
    await session.prompt("/psm-cleanup-conflicts");
    await session.reload();
    return (await readFile(join(directory, "smart-mem.log"), "utf8")).trim().split("\n").map(JSON.parse);
  };
  const off = await run(false);
  assert.ok(off.some(({ event }) => event === "maintenance.note_failed"));
  assert.ok(!off.some(({ level }) => level === "debug"));
  assert.doesNotMatch(JSON.stringify(off), /Private maintenance note|Private maintenance guidance|Private invalid decision/);
  const debug = (await run(true)).filter(({ level }) => level === "debug");
  const link = debug.filter(({ event }) => event.startsWith("linking."));
  assert.deepEqual(link.filter(({ event }) => event === "linking.request").map(({ attempt }) => attempt), [1, 2, 1]);
  assert.deepEqual(link.filter(({ event }) => event === "linking.result").map(({ result }) => result), [{ linked: [] }, { linked: [] }]);
  assert.ok(link.some(({ input }) => input && [input.source, ...input.candidates].some(({ text }) => text === body)));
  assert.match(JSON.stringify(link), /Private invalid decision/);
  assert.doesNotMatch(JSON.stringify(link.filter(({ event }) => event === "linking.request")), /Private linking conversation/);
  const decisions = debug.filter(({ event }) => event.startsWith("maintenance.decision."));
  const requests = decisions.filter(({ event }) => event.endsWith(".request"));
  const responses = decisions.filter(({ event }) => event.endsWith(".response"));
  const results = decisions.filter(({ event }) => event.endsWith(".result"));
  assert.deepEqual(requests.map(({ tool }) => tool), ["psm_reclassify_batch", "psm_cleanup_guidance_batch", "psm_cleanup_memory_conflict", "psm_cleanup_memory_conflict"]);
  assert.ok(requests[0].input.notes.some(({ text }) => text === body));
  assert.ok(requests[1].input.guidance.some(({ text }) => text === guidance));
  assert.deepEqual(responses.map(({ content }) => content.find(({ type }) => type === "toolCall").name), requests.map(({ tool }) => tool));
  const key = ({ tool, scope, noteIds, attempt }) => ({ tool, scope, noteIds, attempt });
  assert.deepEqual(responses.map(key), requests.map(key));
  assert.deepEqual(results.map(key), requests.map(key));
  assert.deepEqual(results.map(({ result }) => result.changes), [1, 0, 0, 0]);
  assert.deepEqual(errors, []);
});

const evidenceIds = (messages, role, quote) => messages.filter((message) => message.role === role && contentText(message.content).includes(quote))
  .map((message) => contentText(message.content).match(/\[Smart Mem evidence messageId: ([^\]]+)\]/)?.[1]);

test("review deduplicates cited evidence but accepts identical corrections for separate mistakes", async (t) => {
  const { session, faux, note, store, errors, directory, sessionManager } = await fixture(t);
  await new SettingsFile(directory).update({ initialMessages: 100, periodicTurns: 100 });
  const correction = "No, use the exit status for this failed setup check.";
  const evidence = "I reproduced a second bug: the suite failed with exit status 2 but its wrapper reported success.";
  const { model, dimensions } = models[0];
  const echo = await store.add({ scope: "global", kind: "note", text: correction }, { model, values: Array.from({ length: dimensions }, (_, i) => Number(i === 0)) });
  const boost = (messageId, evidence) => fauxToolCall("psm_reinforce_memory", { id: note.id, messageId, evidence });
  let originalId, echoId, secondCorrectionId, distinctId;
  faux.setResponses([
    ({ messages }) => {
      assert.ok(!getCurrentTools(messages).some(({ name }) => name === "psm_reinforce_memory"));
      assert.deepEqual(evidenceIds(messages, "user", correction), [undefined]);
      return fauxAssistantMessage(fauxToolCall("psm_memory_read", { id: echo.id }));
    },
    fauxAssistantMessage("I found the earlier setup check."),
    ({ messages }) => {
      [originalId] = evidenceIds(messages, "user", correction);
      [echoId] = evidenceIds(messages, "toolResult", correction);
      return fauxAssistantMessage(boost(originalId, correction));
    },
    fauxAssistantMessage("Reinforced after a fresh correction."),
    fauxAssistantMessage("I checked the exit status for the same setup check."),
    ({ messages }) => {
      assert.match(getCurrentSystemPrompt(messages), /A correction trigger alone does not establish a new incident/);
      return fauxAssistantMessage(boost(originalId, correction));
    },
    fauxAssistantMessage("This report already counted."),
    fauxAssistantMessage("The next setup check passed because it printed a success banner."),
    fauxAssistantMessage("I'll check the new run's exit status instead."),
    ({ messages }) => {
      assert.match(getCurrentSystemPrompt(messages), /The same wording can count again if it corrects a separate mistake/);
      secondCorrectionId = evidenceIds(messages, "user", correction).at(-1);
      return fauxAssistantMessage(boost(secondCorrectionId, correction));
    },
    fauxAssistantMessage("Reinforced for a separate mistake."),
    fauxAssistantMessage(evidence),
    ({ messages }) => {
      [distinctId] = evidenceIds(messages, "assistant", evidence);
      return fauxAssistantMessage([boost(originalId, correction), boost(distinctId, evidence)]);
    },
    fauxAssistantMessage("Only the newly verified incident counted."),
  ]);
  await session.prompt(correction);
  await waitForReviews(sessionManager, 1);
  assert.ok(originalId && echoId && originalId !== echoId);
  assert.deepEqual(await store.read(note.id), { ...note, weight: 1 });
  await session.prompt(correction);
  await waitForReviews(sessionManager, 2);
  assert.deepEqual(await store.read(note.id), { ...note, weight: 1 });
  assert.equal(rows(sessionManager)[1].calls[0].arguments.messageId, originalId);
  await session.prompt("Did the next setup check pass?");
  await session.prompt(correction);
  await waitForReviews(sessionManager, 3);
  assert.ok(secondCorrectionId && secondCorrectionId !== originalId);
  assert.deepEqual(await store.read(note.id), { ...note, weight: 2 });
  await session.prompt("No, check the other test wrapper too.");
  await waitForReviews(sessionManager, 4);
  assert.ok(distinctId && distinctId !== originalId);
  assert.deepEqual(await store.read(note.id), { ...note, weight: 3 });
  assert.deepEqual(rows(sessionManager).map(({ status }) => status), ["Saved · 1", "Skipped", "Saved · 1", "Saved · 1"]);
  assert.deepEqual(errors, []);
});

test("a rejected reinforcement citation skips review without marking a tool failure", async (t) => {
  const { session, faux, note, store, sessionManager, errors } = await fixture(t);
  const correction = "No, check the actual exit status.";
  faux.setResponses([
    fauxAssistantMessage("Checking."),
    ({ messages }) => {
      const [messageId] = evidenceIds(messages, "user", correction);
      return fauxAssistantMessage([
        fauxToolCall("psm_reinforce_memory", { id: note.id, messageId, evidence: "This quote isn't in the cited message." }),
        fauxToolCall("psm_reinforce_memory", { id: note.id, messageId: "not-active", evidence: correction }),
      ]);
    },
    fauxAssistantMessage("No valid evidence citation."),
  ]);
  await session.prompt(correction);
  await waitForReviews(sessionManager, 1);
  assert.deepEqual(await store.read(note.id), note);
  const [review] = rows(sessionManager);
  assert.equal(review.status, "Skipped");
  assert.equal(review.saved, 0);
  assert.equal(review.calls.length, 2);
  for (const call of review.calls) {
    assert.equal(call.isError, false);
    assert.deepEqual(call.result, { saved: false, result: { reinforced: false, reason: "Evidence must quote the cited active session message verbatim" } });
  }
  assert.deepEqual(errors, []);
});

test("cleanup guidance-only dispatches a scoped decision without running memory cleanup", async (t) => {
  const { session, faux, store, note, directory, errors, alerts } = await fixture(t);
  await writeFile(join(directory, "..", "SYSTEM.md"), "Current global directive: remove this conflicting fixture.");
  faux.setResponses([({ messages }) => {
    const { guidance, notes } = JSON.parse(text(messages));
    assert.match(JSON.stringify(guidance), /Current global directive/);
    assert.deepEqual(notes.map(({ id }) => id), [note.id]);
    assert.deepEqual(getCurrentTools(messages).map(({ name }) => name), ["psm_cleanup_guidance_batch"]);
    return fauxAssistantMessage(fauxToolCall("psm_cleanup_guidance_batch", { updates: [{ id: note.id, text: null }] }));
  }]);
  await session.prompt("/psm-cleanup-conflicts guidance-only");
  assert.equal(faux.state.callCount, 1);
  assert.equal(await store.read(note.id), undefined);
  assert.ok(alerts.some(([message]) => message === "Cleaned up 1 conflicting memories"));
  assert.deepEqual(errors, []);
});

test("foreground, automatic review, and reclassify share classification and session-search guidance", async (t) => {
  const { session, sessionManager, faux, directory, errors } = await fixture(t);
  const settings = new SettingsFile(directory);
  const { reviewTools } = await settings.read();
  await settings.update({ initialMessages: 100, periodicTurns: 100, reviewTools: [...reviewTools, "psm_session_search"] });
  const override = { classification: "Use the owner-edited classification rubric.", sessionSearch: "Use the owner-edited session search guidance." };
  const seen = [];
  for (const [index, rules] of [prompts, override].entries()) {
    if (index) await settings.update({ prompts: override });
    faux.setResponses([
      ({ messages }) => {
        seen.push({ prompt: getCurrentSystemPrompt(messages), tools: getCurrentTools(messages) });
        return fauxAssistantMessage("Foreground response");
      },
      ({ messages }) => {
        seen.push({ prompt: messages[0].sections?.["smart-mem-task"], tools: getCurrentTools(messages) });
        return fauxAssistantMessage("No new durable information");
      },
      ({ messages }) => {
        seen.push({ prompt: getCurrentSystemPrompt(messages), tools: getCurrentTools(messages) });
        return fauxAssistantMessage(fauxToolCall("psm_reclassify_batch", { updates: [] }));
      },
    ]);
    await session.prompt(`Remember this: use fixture ${index} for regression checks.`);
    await waitForReviews(sessionManager, index + 1);
    await session.prompt("/psm-reclassify global");
    const [foreground, review, reclassify] = seen.slice(index * 3);
    for (const observation of [foreground, review, reclassify]) {
      for (const key of ["classification", "sessionSearch"]) {
        assert.ok(observation.prompt.includes(rules[key]));
        if (index) assert.ok(!observation.prompt.includes(prompts[key]));
      }
      assert.ok(observation.tools.some(({ name }) => name === "psm_session_search"));
    }
    assert.ok(foreground.tools.some(({ name }) => name === "psm_memory_add"));
    assert.match(review.prompt, /Explicit task fixture/);
    assert.match(reclassify.prompt, /If the available evidence does not clearly support a different kind, keep the current kind/);
  }
  assert.deepEqual(errors, []);
});

test("reclassify can find past owner intent before submitting kind-only updates", async (t) => {
  const { session, faux, store, note, archive, cwd, errors, alerts } = await fixture(t);
  const vector = { model: models[0].model, values: [1, ...Array(models[0].dimensions - 1).fill(0)] };
  const other = await store.add({ scope: "global", kind: "preference", text: "Use the kiwi fixture" }, vector);
  await store.link(note.id, other.id);
  await store.reinforce(note.id, "fixture-incident");
  const before = await store.read(note.id);
  const standing = "From now on, always verify release checks using the exit status.";
  const historical = SessionManager.create(cwd, join(cwd, "previous"));
  historical.appendMessage({ role: "user", content: standing, timestamp: Date.now() });
  historical.appendMessage(fauxAssistantMessage("I’ll check the exit status."));
  await archive.index(historical.getSessionFile(), [historical.getHeader(), ...historical.getEntries()]);
  const searchResults = (messages) => messages.filter(({ role, toolName }) => role === "toolResult" && toolName === "psm_session_search")
    .map(({ content }) => JSON.parse(contentText(content)).result.map(({ role, text }) => ({ role, text })));
  const seen = [];
  faux.setResponses([
    ({ messages }) => {
      const input = JSON.parse(text(messages));
      seen.push({ ...input, tools: getCurrentTools(messages), prompt: getCurrentSystemPrompt(messages) });
      return fauxAssistantMessage(fauxToolCall("psm_session_search", { query: "exit status", project: input.cwd, role: "user" }));
    },
    ({ messages }) => {
      seen.push(searchResults(messages));
      return fauxAssistantMessage(fauxToolCall("psm_session_search", { query: "kiwi" }));
    },
    ({ messages }) => {
      seen.push(searchResults(messages));
      return fauxAssistantMessage(fauxToolCall("psm_reclassify_batch", { updates: [{ id: note.id, kind: "guideline" }] }));
    },
  ]);
  await session.prompt("/psm-reclassify global");
  const [request, hit, allSearches] = seen;
  assert.equal(request.cwd, cwd);
  assert.deepEqual(new Set(request.notes.map(({ id }) => id)), new Set([note.id, other.id]));
  assert.deepEqual(request.tools.map(({ name }) => name), ["psm_reclassify_batch", "psm_session_search"]);
  assert.match(request.prompt, /use psm_session_search with a focused query to look for the owner's original direction/);
  assert.deepEqual(hit, [[{ role: "user", text: standing }]]);
  assert.deepEqual(allSearches, [...hit, []]);
  assert.deepEqual(await store.read(note.id), { ...before, kind: "guideline" });
  assert.deepEqual(await store.related(note.id), [other]);
  assert.ok(alerts.some(([message]) => message === "Reclassified 1 saved memories"));
  assert.deepEqual(errors, []);
});

test("link command and opt-in batches judge stored embeddings with active model", async (t) => {
  const { session, note, faux, directory, store, errors, alerts } = await fixture(t);
  const { model, dimensions } = models[0];
  const embedding = { model, values: Array.from({ length: dimensions }, (_, i) => i === 0 ? 1 : 0) };
  const second = await store.add({ scope: "global", kind: "note", text: "Verify npm exit status when checks fail" }, embedding);
  await new SettingsFile(directory).update({ initialMessages: 100, periodicTurns: 100 });
  const judged = [];
  const judge = (ctx) => {
    const prompt = getCurrentSystemPrompt(ctx.messages);
    assert.match(prompt, /Judge candidate memory pairs/);
    const { source, candidates } = JSON.parse(prompt.trim().split("\n").at(-1));
    judged.push(source.id);
    return fauxAssistantMessage(fauxToolCall("psm_select_links", { ids: source.id === note.id ? [candidates[0].id] : [] }));
  };
  faux.setResponses([judge, judge]);
  await session.prompt("/psm-link global");
  assert.deepEqual(new Set(judged), new Set([note.id, second.id]));
  assert.deepEqual(await store.related(note.id), [second]);
  assert.deepEqual(await store.related(second.id), []);
  assert.deepEqual(await store.list("global", true), []);
  await new SettingsFile(directory).update({ autoLink: true, linkThreshold: 1 });
  const third = await store.add({ scope: "global", kind: "preference", text: "Run checks after editing" }, embedding);
  faux.setResponses([fauxAssistantMessage("Ordinary answer"), judge]);
  await session.prompt("Turn to trigger background linking");
  await waitFor(async () => (await store.list("global", true)).length === 0, "automatic linking");
  assert.deepEqual(judged.slice(2), [third.id]);
  assert.deepEqual(errors, []);
  assert.deepEqual(alerts.filter(([, level]) => level === "error"), []);
});

test("compaction and injection refresh finish while a pre-compaction review is still running", { timeout: 10000 }, async (t) => {
  const { session, note, faux, directory, errors, alerts, sessionManager } = await fixture(t);
  await new SettingsFile(directory).update({ initialMessages: 100, periodicTurns: 100 });
  faux.setResponses(Array.from({ length: 6 }, (_, i) => fauxAssistantMessage(`Assistant text ${i}`)));
  for (let i = 0; i < 6; i++) await session.prompt(`User text ${i}`);
  faux.appendResponses([fauxAssistantMessage(fauxToolCall("psm_select_memories", { ids: [note.id] }))]);
  await session.prompt("/psm-inject");
  assert.equal(injections(sessionManager).length, 1);
  const stages = [];
  const held = Promise.withResolvers();
  t.after(() => held.resolve(fauxAssistantMessage("Nothing durable for memory")));
  faux.appendResponses([
    (ctx) => {
      stages.push("flush");
      assert.match(getCurrentSystemPrompt(ctx.messages), /Before this context boundary/);
      assert.match(text(ctx.messages), /User text 0/);
      assert.match(text(ctx.messages), /User text 5/);
      return held.promise;
    },
    () => { stages.push("summary"); return fauxAssistantMessage("Fixture summary of earlier conversation"); },
    (ctx) => {
      stages.push("refresh");
      assert.match(getCurrentSystemPrompt(ctx.messages), /Injection task fixture/);
      assert.match(text(ctx.messages), /Fixture summary of earlier conversation/);
      return fauxAssistantMessage(fauxToolCall("psm_select_memories", { ids: [note.id] }));
    },
  ]);
  await session.compact();
  assert.deepEqual(stages, ["flush", "summary", "refresh"]);
  assert.equal(injections(sessionManager).length, 2);
  assert.deepEqual(rows(sessionManager), []);
  held.resolve(fauxAssistantMessage("Nothing durable for memory"));
  await waitForReviews(sessionManager, 1);
  assert.deepEqual(rows(sessionManager).map(({ trigger, status }) => [trigger, status]), [["flush", "Skipped"]]);
  assert.deepEqual(errors, []);
  assert.deepEqual(alerts.filter(([, level]) => level === "error"), []);
});

test("failed initial selection retries; a valid empty selection consumes the trigger", async (t) => {
  const { session, faux, directory, sessionManager } = await fixture(t);
  await new SettingsFile(directory).update({ initialMessages: 2, periodicTurns: 100 });
  const marker = () => sessionManager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "smart-mem-initial");
  faux.setResponses([
    fauxAssistantMessage("First answer"),
    fauxAssistantMessage("Did not select"),
    fauxAssistantMessage("Second answer"),
    fauxAssistantMessage(fauxToolCall("psm_select_memories", { ids: [] })),
    fauxAssistantMessage("Third answer"),
  ]);
  await session.prompt("First turn");
  assert.equal(marker().length, 0);
  await session.prompt("Second turn");
  assert.equal(marker().length, 1);
  await session.prompt("Third turn");
  assert.equal(marker().length, 1);
  assert.equal(injections(sessionManager).length, 0);
  assert.equal(faux.state.callCount, 5);
});

test("timed-out pre-compaction review cannot block a later review or start a write", async (t) => {
  const { session, faux, directory, sessionManager, store, note } = await fixture(t);
  const file = new SettingsFile(directory);
  await file.update({ initialMessages: 100, periodicTurns: 100, flushSeconds: 1, reviewTools: [...(await file.read()).reviewTools, "psm_memory_remove"] });
  faux.setResponses(Array.from({ length: 6 }, () => fauxAssistantMessage("Turn complete")));
  for (let i = 0; i < 6; i++) await session.prompt(`Conversation part ${i}`);
  let releaseLate;
  let lateReturned;
  const late = new Promise((resolve) => { lateReturned = resolve; });
  faux.appendResponses([
    async (ctx, options) => {
      assert.ok(getCurrentTools(ctx.messages).some(({ name }) => name === "psm_memory_remove"));
      const pending = new Promise((resolve) => { releaseLate = resolve; });
      await pending;
      assert.equal(options.signal.aborted, true);
      lateReturned();
      return fauxAssistantMessage(fauxToolCall("psm_memory_remove", { id: note.id }));
    },
    () => fauxAssistantMessage("Compaction continued"),
    () => fauxAssistantMessage("Correction acknowledged"),
    () => fauxAssistantMessage("Correction reviewed while old provider was pending"),
  ]);
  try {
    await session.compact();
    assert.deepEqual(rows(sessionManager), []);
    assert.equal(injections(sessionManager).length, 0);
    assert.ok(sessionManager.getEntries().some((entry) => entry.type === "compaction"));
    await session.prompt("No, use the updated fixture.");
    await waitForReviews(sessionManager, 2);
    const [flush, correction] = rows(sessionManager);
    assert.equal(flush.status, "Failed");
    assert.match(flush.error, /TimeoutError/);
    assert.equal(correction.rationale, "Correction reviewed while old provider was pending");
  } finally { releaseLate?.(); }
  await late;
  assert.deepEqual(await store.read(note.id), note);
});

test("unconfigured subagent skips setup warning and dialog", async (t) => {
  const { dialogs, directory, alerts, errors } = await fixture(t, { setup: true, child: true });
  assert.deepEqual(dialogs, []);
  assert.ok(!alerts.some(([message]) => message.includes("/psm-setup")));
  await assert.rejects(stat(join(directory, "db")), { code: "ENOENT" });
  assert.deepEqual(errors, []);
});

test("subagent uses exposed memory tool without automatic review or injection", async (t) => {
  const { session, note, faux, sessionManager, errors } = await fixture(t, { child: true });
  faux.setResponses([
    (ctx) => {
      assert.deepEqual(getCurrentTools(ctx.messages).map((t) => t.name), ["psm_memory_read"]);
      return fauxAssistantMessage(fauxToolCall("psm_memory_read", { id: note.id }));
    },
    (ctx) => {
      const result = ctx.messages.find(({ role }) => role === "toolResult");
      assert.equal(result.isError, false);
      assert.match(contentText(result.content), /verify tests ran/);
      return fauxAssistantMessage("Read verified");
    },
  ]);
  await session.prompt("Remember this: do not launch a review here.");
  assert.equal(faux.state.callCount, 2);
  assert.deepEqual(rows(sessionManager), []);
  assert.deepEqual(injections(sessionManager), []);
  assert.deepEqual(errors, []);
});
