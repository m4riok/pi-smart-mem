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

async function fixture(t, { child = false, setup = false } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "smart-mem-pi-"));
  const agentDir = join(cwd, "agent");
  const directory = join(agentDir, "pi-smart-mem");
  const alerts = [];
  const errors = [];
  t.after(() => rm(cwd, { recursive: true, force: true }));
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
    note = await store.add({ scope: "global", category: "user_preference", text: "Use exit status to verify tests ran" }, { model, values: Array.from({ length: dimensions }, (_, i) => i === 0 ? 1 : 0) });
    await archive.pin("global", "Standing pin fixture");
  }
  await new SettingsFile(directory).update({ initialMessages: 6, periodicTurns: 3, prompts: { recall: "Recall prompt fixture", correction: "Correction task fixture", explicit: "Explicit task fixture", periodic: "Periodic task fixture", injection: "Injection task fixture" } });
  const faux = fauxProvider({ provider: "smart-mem-fixture", tokensPerSecond: 100000 });
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, modelsStorePath: join(agentDir, "models-cache.json"), refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 16 } });
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, additionalExtensionPaths: [new URL("../index.ts", import.meta.url).pathname], noContextFiles: true });
  await resourceLoader.reload();
  const sessionManager = SessionManager.create(cwd, join(agentDir, "sessions", "fixture"));
  const { session } = await createAgentSession({ cwd, agentDir, settingsManager, resourceLoader, modelRuntime, model: faux.getModel(), sessionManager,
    tools: child ? ["memory_read", "skill_save"] : undefined, noTools: child ? undefined : "builtin" });
  t.after(() => session.dispose());
  const dialogs = [];
  const ui = { notify: (...args) => alerts.push(args), setWidget: () => {},
    select: async (title, options) => {
      if (!setup) throw new Error("Unexpected setup dialog");
      dialogs.push(title);
      return options[0];
    },
    confirm: async (title) => { dialogs.push(title); return false; },
  };
  await session.bindExtensions({ mode: "rpc", uiContext: ui, onError: (error) => errors.push(error) });
  return { session, note, archive, faux, alerts, errors, sessionManager, store, directory, dialogs, cwd };
}

const text = (messages) => messages.filter((m) => m.role === "user").map((m) => contentText(m.content)).join("\n");
const rows = (sessionManager) => sessionManager.getEntries().filter((e) => e.type === "custom" && e.customType === "smart-mem-review").map((e) => e.data);
const injections = (sessionManager) => sessionManager.getEntries().filter((e) => e.type === "custom_message" && e.customType === "smart-mem-injection");

test("setup asks before creating database or downloading model", async (t) => {
  const { dialogs, directory, errors } = await fixture(t, { setup: true });
  assert.deepEqual(dialogs, ["Set up Smart Mem: select an embedding model", "Initialize Smart Mem?"]);
  await assert.rejects(stat(join(directory, "db")), { code: "ENOENT" });
  await assert.rejects(stat(join(directory, "models")), { code: "ENOENT" });
  assert.deepEqual(errors, []);
});

test("Hermes migration command refuses existing data unless forced and warns before replacing it", async (t) => {
  const { session, note, archive, alerts, errors, store, cwd, faux } = await fixture(t);
  const source = join(cwd, "agent", "pi-hermes-memory");
  await mkdir(source);
  await writeFile(join(source, "STANDING.md"), "- Imported standing instruction\n");
  await session.prompt("/migrate-hermes");
  assert.ok(alerts.some(([message, level]) => level === "error" && /--force/.test(message)));
  assert.deepEqual(await store.read(note.id), note);
  await session.prompt("/migrate-hermes --force");
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
  const removable = await store.add({ scope: "global", category: "user_preference", text: "Obsolete fixture" }, { model: models[0].model, values: Array.from({ length: models[0].dimensions }, (_, i) => Number(i === 0)) });
  const seen = [];
  faux.setResponses([
    (ctx) => {
      assert.match(getCurrentSystemPrompt(ctx.messages), /Standing pin fixture/);
      assert.match(getCurrentSystemPrompt(ctx.messages), /Recall prompt fixture/);
      assert.ok(getCurrentTools(ctx.messages).some((tool) => tool.name === "memory_related"));
      return fauxAssistantMessage("First answer");
    },
    fauxAssistantMessage("Second answer"),
    (ctx) => {
      seen.push("correction");
      assert.match(getCurrentSystemPrompt(ctx.messages), /Correction task fixture/);
      assert.match(text(ctx.messages), /First historical detail/);
      assert.match(text(ctx.messages), /No, use pnpm/);
      assert.doesNotMatch(getCurrentTools(ctx.messages).map((tool) => tool.name).join(" "), /memory_remove|bash/);
      return fauxAssistantMessage("No durable correction yet");
    },
    fauxAssistantMessage("Third answer"),
    (ctx) => {
      seen.push("explicit");
      assert.match(getCurrentSystemPrompt(ctx.messages), /Explicit task fixture/);
      assert.match(text(ctx.messages), /Remember this: use fixtures/);
      const names = getCurrentTools(ctx.messages).map((tool) => tool.name);
      assert.ok(names.includes("memory_remove"));
      assert.ok(!names.includes("skill_save"));
      return fauxAssistantMessage(fauxToolCall("memory_remove", { id: removable.id }));
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
      return fauxAssistantMessage(fauxToolCall("select_memories", { ids: [note.id] }));
    },
  ]);
  await session.prompt("First historical detail");
  await session.prompt("No, use pnpm for this task.");
  const file = new SettingsFile(directory);
  await file.update({ reviewTools: [...(await file.read()).reviewTools, "skill_save", "memory_remove"] });
  await session.prompt("Remember this: use fixtures for regression checks.");
  assert.deepEqual(seen, ["correction", "explicit", "periodic", "initial"]);
  assert.deepEqual(rows(sessionManager).map(({ trigger, status }) => [trigger, status]), [["correction", "Skipped"], ["explicit", "Saved · 1"], ["periodic", "Skipped"]]);
  assert.equal(await store.read(removable.id), undefined);
  assert.equal(injections(sessionManager).length, 1);
  faux.appendResponses(Array.from({ length: 2 }, () => fauxAssistantMessage(fauxToolCall("select_memories", { ids: [note.id] }))));
  await session.prompt("/inject-mem");
  await session.prompt("/inject-mem");
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
      assert.match(getCurrentSystemPrompt(ctx.messages), /Before saving, use skill_search/);
      const names = getCurrentTools(ctx.messages).map((tool) => tool.name);
      for (const name of ["skill_search", "skill_read", "skill_save"]) assert.ok(names.includes(name));
      return fauxAssistantMessage(fauxToolCall("skill_save", draft("project")));
    },
    fauxAssistantMessage("Saved project fixture skill"),
    (ctx) => {
      assert.match(getCurrentSystemPrompt(ctx.messages), /Skill guidance override fixture/);
      assert.doesNotMatch(getCurrentSystemPrompt(ctx.messages), /Before saving, use skill_search/);
      return fauxAssistantMessage(fauxToolCall("skill_save", draft("global")));
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

test("link command and opt-in batches judge stored embeddings with active model", async (t) => {
  const { session, note, faux, directory, store, errors, alerts } = await fixture(t);
  const { model, dimensions } = models[0];
  const embedding = { model, values: Array.from({ length: dimensions }, (_, i) => i === 0 ? 1 : 0) };
  const second = await store.add({ scope: "global", category: "global_workflow_failure", text: "Verify npm exit status when checks fail" }, embedding);
  await new SettingsFile(directory).update({ initialMessages: 100, periodicTurns: 100 });
  const judged = [];
  const judge = (ctx) => {
    const prompt = getCurrentSystemPrompt(ctx.messages);
    assert.match(prompt, /Judge candidate memory pairs/);
    const { source, candidates } = JSON.parse(prompt.trim().split("\n").at(-1));
    judged.push(source.id);
    return fauxAssistantMessage(fauxToolCall("select_links", { ids: source.id === note.id ? [candidates[0].id] : [] }));
  };
  faux.setResponses([judge, judge]);
  await session.prompt("/link-mem global");
  assert.deepEqual(new Set(judged), new Set([note.id, second.id]));
  assert.deepEqual(await store.related(note.id), [second]);
  assert.deepEqual(await store.related(second.id), []);
  assert.deepEqual(await store.list("global", true), []);
  await new SettingsFile(directory).update({ autoLink: true, linkThreshold: 1 });
  const third = await store.add({ scope: "global", category: "user_preference", text: "Run checks after editing" }, embedding);
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
  faux.appendResponses([fauxAssistantMessage(fauxToolCall("select_memories", { ids: [note.id] }))]);
  await session.prompt("/inject-mem");
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
      return fauxAssistantMessage(fauxToolCall("select_memories", { ids: [note.id] }));
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
    fauxAssistantMessage(fauxToolCall("select_memories", { ids: [] })),
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
  await file.update({ initialMessages: 100, periodicTurns: 100, flushSeconds: 1, reviewTools: [...(await file.read()).reviewTools, "memory_remove"] });
  faux.setResponses(Array.from({ length: 6 }, () => fauxAssistantMessage("Turn complete")));
  for (let i = 0; i < 6; i++) await session.prompt(`Conversation part ${i}`);
  let releaseLate;
  let lateReturned;
  const late = new Promise((resolve) => { lateReturned = resolve; });
  faux.appendResponses([
    async (ctx, options) => {
      assert.ok(getCurrentTools(ctx.messages).some(({ name }) => name === "memory_remove"));
      const pending = new Promise((resolve) => { releaseLate = resolve; });
      await pending;
      assert.equal(options.signal.aborted, true);
      lateReturned();
      return fauxAssistantMessage(fauxToolCall("memory_remove", { id: note.id }));
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

test("unconfigured subagent never opens setup dialog", async (t) => {
  const { dialogs, directory, errors } = await fixture(t, { setup: true, child: true });
  assert.deepEqual(dialogs, []);
  await assert.rejects(stat(join(directory, "db")), { code: "ENOENT" });
  assert.deepEqual(errors, []);
});

test("subagent uses exposed memory tool without automatic review or injection", async (t) => {
  const { session, note, faux, sessionManager, errors } = await fixture(t, { child: true });
  faux.setResponses([
    (ctx) => {
      assert.deepEqual(getCurrentTools(ctx.messages).map((t) => t.name), ["memory_read"]);
      return fauxAssistantMessage(fauxToolCall("memory_read", { id: note.id }));
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
