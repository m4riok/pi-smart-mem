import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { getCurrentSystemPrompt, getCurrentTools, fauxProvider, fauxAssistantMessage, fauxToolCall, contentText } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Archive } from "../src/archive.ts";
import { models } from "../src/embeddings.ts";
import { MemoryStore } from "../src/memory-store.ts";
import { SettingsFile } from "../src/settings.ts";

const hermesNames = ["memory_add", "memory_replace", "memory_remove", "session_search", "memory_search"];

async function fixture(t, { child = false, setup = false, hermes = false, mode = "rpc", setWidget = () => {}, select } = {}) {
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
    note = await store.add({ scope: "global", kind: "preference", text: "Use exit status to verify tests ran" }, { model, values: Array.from({ length: dimensions }, (_, i) => i === 0 ? 1 : 0) });
    await archive.pin("global", "Standing pin fixture");
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
    confirm: async (title) => { dialogs.push(title); return false; },
  };
  await session.bindExtensions({ mode, uiContext: ui, onError: (error) => errors.push(error) });
  return { session, note, archive, faux, alerts, errors, sessionManager, store, directory, dialogs, cwd };
}

const text = (messages) => messages.filter((m) => m.role === "user").map((m) => contentText(m.content)).join("\n");
const rows = (sessionManager) => sessionManager.getEntries().filter((e) => e.type === "custom" && e.customType === "smart-mem-review").map((e) => e.data);
const injections = (sessionManager) => sessionManager.getEntries().filter((e) => e.type === "custom_message" && e.customType === "smart-mem-injection");

test("unconfigured startup warns without opening the picker; setup command asks before creating storage", async (t) => {
  const { session, dialogs, directory, alerts, errors, faux } = await fixture(t, { setup: true });
  assert.deepEqual(session.extensionRunner.getRegisteredCommands().map(({ name }) => name).sort(), [
    "psm-consolidate", "psm-inject", "psm-link", "psm-migrate-hermes", "psm-pin", "psm-settings", "psm-setup",
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
  assert.ok(alerts.some(([message, level]) => level === "error" && /--force/.test(message)));
  assert.deepEqual(await store.read(note.id), note);
  await session.prompt("/psm-migrate-hermes --force");
  const warning = alerts.findIndex(([message, level]) => level === "warning" && /Replacing Smart Mem database contents/.test(message));
  const success = alerts.findIndex(([message, level]) => level === "info" && /Imported 0 memories, 0 skills, and 1 pins/.test(message));
  assert.ok(warning >= 0 && success > warning);
  assert.equal(await store.read(note.id), undefined);
  assert.deepEqual(await archive.pins(), ["Imported standing instruction"]);
  assert.equal(await readFile(join(source, "STANDING.md"), "utf8"), "- Imported standing instruction\n");
  assert.equal(faux.state.callCount, 0);
  assert.deepEqual(errors, []);
});

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
      assert.match(getCurrentSystemPrompt(ctx.messages), /Correction task fixture/);
      assert.match(text(ctx.messages), /First historical detail/);
      assert.match(text(ctx.messages), /No, use pnpm/);
      assert.doesNotMatch(getCurrentTools(ctx.messages).map((tool) => tool.name).join(" "), /psm_memory_remove|bash/);
      return fauxAssistantMessage("No durable correction yet");
    },
    fauxAssistantMessage("Third answer"),
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
    (ctx) => {
      seen.push("initial");
      assert.match(getCurrentSystemPrompt(ctx.messages), /Injection task fixture/);
      return fauxAssistantMessage(fauxToolCall("psm_select_memories", { ids: [note.id] }));
    },
  ]);
  await session.prompt("First historical detail");
  await session.prompt("No, use pnpm for this task.");
  const file = new SettingsFile(directory);
  // A pre-prefix review allowlist still permits removal, but never skill saves.
  await file.update({ reviewTools: [...(await file.read()).reviewTools, "skill_save", "memory_remove"] });
  await session.prompt("Remember this: use fixtures for regression checks.");
  assert.deepEqual(seen, ["correction", "explicit", "periodic", "initial"]);
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
  assert.equal(frames.at(-1)[0], "🧠 Memory · Active");
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
      assert.doesNotMatch(getCurrentSystemPrompt(ctx.messages), /Shorten the source note or merge/);
      return fauxAssistantMessage("Normal response while maintenance is running");
    },
  ]);
  await session.prompt("/psm-consolidate global");
  assert.match(await judging.promise, /Shorten the source note or merge/);
  assert.ok(frames.at(-1).some((line) => line.includes("Consolidating global memories: 1/1")));
  await session.prompt("/psm-link global");
  assert.ok(frames.at(-1).some((line) => line.includes("maintenance is already running")));
  await session.prompt("Background work should not block this prompt");
  assert.equal(faux.state.callCount, 2);
  decision.resolve(fauxAssistantMessage(fauxToolCall("psm_consolidate_note", { ids: [] })));
  await finished.promise;
  assert.equal(registrations, 1);
  assert.ok(frames.at(-1)[0].startsWith("🧠 Memory · Active"));
  assert.deepEqual(errors, []);
});

test("interactive Memory panel separates scoped counts and refreshes after writes", async (t) => {
  let panel;
  const { session, note, faux, errors } = await fixture(t, { mode: "tui", setWidget: (key, build) => {
    if (key === "smart-mem") panel = build?.({ requestRender() {} }, { fg: (_color, text) => text });
  } });
  const counts = (width = 100) => panel.render(width).slice(1).join("\n");
  assert.equal(panel.render(100)[0], "🧠 Memory · Active");
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
  assert.ok(panel.render(100).some((line) => line.includes("Memory review · Skipped")));
  assert.equal(rows(sessionManager).at(-1).rationale, "Not a durable change");
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
  assert.equal(rendered.render(100)[0], "🧠 Memory · Active");
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
  await session.prompt("/psm-consolidate global");
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
  await session.prompt("/psm-consolidate global");
  assert.equal((await readLog()).filter(({ level }) => level === "debug").length, debug.length);
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
  assert.deepEqual(judged.slice(2), [third.id]);
  assert.deepEqual(await store.list("global", true), []);
  assert.deepEqual(errors, []);
  assert.deepEqual(alerts.filter(([, level]) => level === "error"), []);
});

test("flush precedes summarization and compaction refresh follows prior injection", async (t) => {
  const { session, note, faux, directory, errors, alerts, sessionManager } = await fixture(t);
  await new SettingsFile(directory).update({ initialMessages: 100, periodicTurns: 100 });
  faux.setResponses(Array.from({ length: 6 }, (_, i) => fauxAssistantMessage(`Assistant text ${i}`)));
  for (let i = 0; i < 6; i++) await session.prompt(`User text ${i}`);
  faux.appendResponses([fauxAssistantMessage(fauxToolCall("psm_select_memories", { ids: [note.id] }))]);
  await session.prompt("/psm-inject");
  assert.equal(injections(sessionManager).length, 1);
  const stages = [];
  faux.appendResponses([
    (ctx) => {
      stages.push("flush");
      assert.match(getCurrentSystemPrompt(ctx.messages), /Before this context boundary/);
      assert.match(text(ctx.messages), /User text 0/);
      assert.match(text(ctx.messages), /User text 5/);
      return fauxAssistantMessage("Nothing durable for memory");
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
    assert.equal(rows(sessionManager).at(-1).status, "Failed");
    assert.match(rows(sessionManager).at(-1).error, /TimeoutError/);
    assert.equal(injections(sessionManager).length, 0);
    assert.ok(sessionManager.getEntries().some((entry) => entry.type === "compaction"));
    const next = session.prompt("No, use the updated fixture.");
    let deadline;
    try {
      await Promise.race([next, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error("Next turn blocked by expired review")), 3_000); })]);
      assert.equal(rows(sessionManager).at(-1).rationale, "Correction reviewed while old provider was pending");
    } finally { clearTimeout(deadline); }
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
