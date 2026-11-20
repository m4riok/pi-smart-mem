import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseSessionEntries, SessionManager } from "@earendil-works/pi-coding-agent";
import { Archive } from "../src/archive.ts";
import { MemoryStore } from "../src/memory-store.ts";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "smart-mem-archive-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "db");
  await new MemoryStore("/project/a", path).initialize({ model: "fixture", dimensions: 2 });
  return { root, a: new Archive(path, "/project/a"), b: new Archive(path, "/project/b"), global: new Archive(path) };
}

test("pins and reusable skills respect repo and global scopes across connections", async (t) => {
  const { a, b, global } = await fixture(t);
  await a.pin("project", "Project instructions");
  await global.pin("global", "Global instructions");
  assert.deepEqual(await a.pins(), ["Project instructions", "Global instructions"]);
  assert.deepEqual(await b.pins(), ["Global instructions"]);
  const data = { name: "QA", description: "Verify checks", text: "Run the verification fixture" };
  const local = await a.saveSkill({ ...data, scope: "project" });
  const shared = await global.saveSkill({ ...data, scope: "global" });
  assert.equal(await b.readSkill(local.id), undefined);
  assert.deepEqual(await b.readSkill(shared.id), shared);
  assert.deepEqual((await a.searchSkills("verify", "project")).map(({ id }) => id), [local.id]);
  assert.equal(await b.saveSkill({ ...data, scope: "project" }, local.id), undefined);
  assert.equal(await a.saveSkill({ ...data, scope: "global" }, local.id), undefined);
  assert.equal((await a.saveSkill({ ...data, scope: "project", text: "Run the extended verification fixture" }, local.id)).text, "Run the extended verification fixture");
});

test("backfill is idempotent and prune never writes original Pi transcripts", async (t) => {
  const { root, a } = await fixture(t);
  const directory = join(root, "sessions");
  const session = SessionManager.create(root, directory);
  session.appendMessage({ role: "user", content: "Historical unicorn detail", timestamp: Date.now() });
  session.appendMessage({ role: "assistant", content: [{ type: "text", text: "Acknowledged" }], api: "fixture", provider: "fixture", model: "fixture", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() });
  const path = session.getSessionFile();
  const original = await readFile(path);
  assert.equal(await a.backfill(directory, () => {}), 1);
  assert.equal(await a.backfill(directory, () => {}), 1);
  const matches = await a.searchTranscripts("unicorn");
  assert.equal(matches.length, 1);
  assert.equal(matches[0].path, path);
  assert.match(matches[0].text, /Historical unicorn detail/);
  assert.deepEqual(await a.searchTranscripts("unicorn", path), []);
  await a.prune();
  assert.deepEqual(await a.searchTranscripts("unicorn"), []);
  assert.deepEqual(await readFile(path), original);
});

test("stale backfill snapshot does not delete a later indexed message", async (t) => {
  const { root, a } = await fixture(t);
  const path = join(root, "session.jsonl");
  const header = { type: "session", id: "fixture", version: 3, cwd: root };
  const entry = (id, content) => ({ type: "message", id, timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content } });
  const stale = [header, entry("1", "Older orchard")];
  await a.index(path, [...stale, entry("2", "Newer strawberry")]);
  await a.index(path, stale);
  assert.equal((await a.searchTranscripts("strawberry")).length, 1);
  assert.equal((await a.searchTranscripts("orchard")).length, 1);
});

test("legacy transcripts preserve each message across repeated backfills", async (t) => {
  const { root, a } = await fixture(t);
  const directory = join(root, "sessions");
  const path = join(directory, "legacy.jsonl");
  const timestamp = "2026-01-01T00:00:00Z";
  const original = [
    { type: "session", id: "legacy-fixture", version: 1, cwd: root, timestamp },
    ...["Quince detail", "Lemon detail"].map((content) => ({ type: "message", timestamp, message: { role: "user", content } })),
  ].map((entry) => JSON.stringify(entry)).join("\n");
  assert.equal(parseSessionEntries(original)[1].id, undefined);
  await mkdir(directory);
  await writeFile(path, original);
  await a.backfill(directory, () => {});
  await a.backfill(directory, () => {});
  const quince = await a.searchTranscripts("quince");
  const lemon = await a.searchTranscripts("lemon");
  assert.equal(quince.length, 1);
  assert.equal(lemon.length, 1);
  assert.notEqual(quince[0].entry, lemon[0].entry);
  assert.equal(await readFile(path, "utf8"), original);
});
