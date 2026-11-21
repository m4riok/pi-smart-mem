import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import { RecordId } from "surrealdb";
import { cleanupConflicts, cleanupMode, conflictGuidance } from "../src/conflict-cleanup.ts";
import { withDatabase } from "../src/database.ts";
import { MemoryStore } from "../src/memory-store.ts";
import { defaults } from "../src/settings.ts";

const embedding = { model: "conflict-fixture", values: [1, 0] };

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "psm-conflicts-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "db");
  const store = new MemoryStore("current", path);
  await store.initialize({ model: embedding.model, dimensions: 2 });
  const add = async (scope, kind, text, revisedAt) => {
    const note = await store.add({ scope, kind, text }, embedding);
    await withDatabase(path, false, (db) => db.query("UPDATE $id SET revisedAt = $revisedAt", { id: new RecordId("memory", note.id), revisedAt }));
    return { ...note, revisedAt };
  };
  const failures = [];
  const run = (mode, choose, guidance) => cleanupConflicts({
    scopes: ["project", "global"], store, settings: defaults, progress: () => {}, onFailure: (...failure) => failures.push(failure),
    ctx: { model: { id: "fixture", reasoning: false }, getSystemPrompt: () => assert.fail("Ambient prompt leaked"), modelRegistry: {
      streamSimple(_model, { messages }) {
        assert.deepEqual(messages.map(({ role }) => role), ["system", "user"]);
        const [tool] = getCurrentTools(messages);
        const decision = choose(tool.name, JSON.parse(messages[1].content));
        return { result: async () => fauxAssistantMessage(fauxToolCall(tool.name, decision)) };
      },
    } },
  }, mode, async () => embedding, guidance);
  return { root, path, store, add, run, failures };
}

test("cleanup runs scoped guidance before conflicts, strips only proposed text and preserves newer record metadata and links", async (t) => {
  const { root, path, store, add, run, failures } = await fixture(t);
  const agentDir = join(root, "agent");
  await mkdir(agentDir);
  await writeFile(join(agentDir, "SYSTEM.md"), "Global system directive");
  const guidance = await conflictGuidance({ customPrompt: "Local system directive", contextFiles: [
    { path: join(agentDir, "AGENTS.md"), content: "Global agents directive" },
    { path: join(root, "repo", "AGENTS.md"), content: "Local agents directive" },
  ] }, agentDir);
  const older = await add("project", "guideline", "Use npm. Tests run in fixtures.", 1000);
  const newer = await add("project", "preference", "Use pnpm instead of npm.", 2000);
  const partial = await add("project", "preference", "Deploy on Friday. Stage has its own DB.", 3000);
  const obsolete = await add("global", "guideline", "Disable tests everywhere.", 4000);
  const globalKeep = await add("global", "note", "Friday is safe elsewhere.", 5000);
  const unrelated = new MemoryStore("unrelated", path);
  const outside = await unrelated.add({ scope: "project", kind: "note", text: "Unrelated repository" }, embedding);
  await store.saveLinks([older, globalKeep], [{ from: older.id, to: globalKeep.id }], []);
  await store.reinforce(older.id, "first");
  await store.reinforce(older.id, "second");
  await store.reinforce(newer.id, "third");
  const calls = [];
  const result = await run(cleanupMode(""), (tool, input) => {
    calls.push(tool);
    if (tool === "psm_cleanup_guidance_batch") {
      if (input.notes[0].scope === "project") {
        assert.match(JSON.stringify(input.guidance), /Local system directive/);
        assert.match(JSON.stringify(input.guidance), /Local agents directive/);
        assert.ok(input.notes.every(({ project }) => project === "current"));
        return { updates: [{ id: partial.id, text: "Stage has its own DB." }] };
      }
      assert.doesNotMatch(JSON.stringify(input.guidance), /Local .* directive/);
      assert.match(JSON.stringify(input.guidance), /Global system directive/);
      assert.match(JSON.stringify(input.guidance), /Global agents directive/);
      return { updates: [{ id: obsolete.id, text: null }] };
    }
    if (input.source.id === partial.id) {
      assert.equal(input.source.text, "Stage has its own DB.");
      return { ids: [] };
    }
    const other = input.source.id === older.id ? newer : older;
    if (!input.candidates.some(({ id }) => id === other.id)) return { ids: [] };
    return { ids: [other.id], text: "Use pnpm instead of npm. Tests run in fixtures." };
  }, async () => guidance);
  assert.deepEqual(result, { changes: 3, skipped: 0 });
  assert.deepEqual(calls.slice(0, 2), ["psm_cleanup_guidance_batch", "psm_cleanup_guidance_batch"]);
  assert.ok(calls.slice(2).every((name) => name === "psm_cleanup_memory_conflict"));
  assert.deepEqual(await store.read(partial.id), { ...partial, text: "Stage has its own DB." });
  assert.deepEqual(await store.read(newer.id), { ...newer, weight: 2, text: "Use pnpm instead of npm. Tests run in fixtures." });
  assert.deepEqual(await store.related(newer.id), [globalKeep]);
  assert.equal(await store.read(older.id), undefined);
  assert.equal(await store.read(obsolete.id), undefined);
  assert.deepEqual(await unrelated.read(outside.id), outside);
  assert.deepEqual(failures, []);
});

test("memory-only cleanup does not read guidance or choose between tied revisions", async (t) => {
  const { store, add, run } = await fixture(t);
  const first = await add("global", "note", "Product flag is enabled.", 1000);
  const second = await add("global", "note", "Product flag is disabled.", 1000);
  const result = await run(cleanupMode("memory-only"), () => assert.fail("No uniquely newer candidate"),
    () => assert.fail("Memory-only must not read guidance"));
  assert.deepEqual(result, { changes: 0, skipped: 0 });
  assert.deepEqual(await store.read(first.id), first);
  assert.deepEqual(await store.read(second.id), second);
  assert.throws(() => cleanupMode("--memory-only"), /guidance-only, or memory-only/);
});
