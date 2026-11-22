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

test("skill search ranks keyword matches across name and description within scope", async (t) => {
  const { a, b, global } = await fixture(t);
  const text = "Run the release deploy procedure";
  const phrase = await a.saveSkill({ name: "Z Release deploy guide", description: "Production checklist", text, scope: "project" });
  const reordered = await global.saveSkill({ name: "Deploy and release procedure", description: "Production checklist", text, scope: "global" });
  const sharedFields = await a.saveSkill({ name: "A Release checklist", description: "How to deploy safely", text, scope: "project" });
  await a.saveSkill({ name: "Deployment", description: "Release planning only", text, scope: "project" });
  await b.saveSkill({ name: "Release deploy", description: "Other project", text, scope: "project" });

  assert.deepEqual(await a.searchSkills("RELEASE deploy"), [phrase, reordered, sharedFields].map(({ id, name, description, scope }) => ({ id, name, description, scope })));
  assert.deepEqual((await a.searchSkills("release deploy", "project")).map(({ id }) => id), [phrase.id, sharedFields.id]);
  assert.deepEqual((await a.searchSkills("deploy and rel")).map(({ id }) => id), [reordered.id]);
});

test("pin removal targets one record and respects current project and global scope", async (t) => {
  const { a, b, global } = await fixture(t);
  const text = "Shared pin wording";
  await a.pin("project", text);
  await a.pin("project", text);
  await b.pin("project", "Another project's pin");
  await global.pin("global", text);
  const visible = await a.listPins();
  const [first, second] = visible.filter(({ scope }) => scope === "project");
  const [shared] = visible.filter(({ scope }) => scope === "global");
  assert.equal(visible.length, 3);
  assert.notEqual(first.id.id, second.id.id);
  assert.equal(await b.removePin(first), false);
  assert.equal(await a.removePin({ ...first, scope: "global" }), false);
  assert.equal(await a.removePin(first), true);
  assert.equal(await a.removePin(first), false);
  assert.deepEqual(new Set((await a.listPins()).map(({ id }) => id.id)), new Set([second.id.id, shared.id.id]));
  assert.equal(await a.removePin(shared), true);
  assert.deepEqual(await a.pins(), [text]);
  assert.deepEqual(await b.pins(), ["Another project's pin"]);
  assert.deepEqual(await global.pins(), []);
});

test("backfill skips subagent artifacts, is idempotent, and leaves originals untouched", async (t) => {
  const { root, a } = await fixture(t);
  const directory = join(root, "sessions");
  const projectSessions = join(directory, "--fixture--");
  const session = SessionManager.create(root, projectSessions);
  session.appendMessage({ role: "user", content: "Historical unicorn detail", timestamp: Date.now() });
  session.appendMessage({ role: "assistant", content: [{ type: "text", text: "Acknowledged" }], api: "fixture", provider: "fixture", model: "fixture", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() });
  const path = session.getSessionFile();
  const original = await readFile(path);
  const artifacts = join(projectSessions, "subagent-artifacts");
  const artifactPath = join(artifacts, "fixture_general_transcript.jsonl");
  const artifact = JSON.stringify({ version: 1, recordType: "message", role: "assistant", text: "Internal artifact" });
  await mkdir(artifacts);
  await writeFile(artifactPath, artifact);
  assert.equal(await a.backfill(directory, () => {}), 1);
  assert.equal(await a.backfill(directory, () => {}), 1);
  const matches = await a.searchTranscripts("unicorn");
  assert.equal(matches.length, 1);
  assert.equal(matches[0].path, path);
  assert.match(matches[0].text, /Historical unicorn detail/);
  assert.deepEqual(await a.searchTranscripts("unicorn", { exclude: path }), []);
  await a.prune();
  assert.deepEqual(await a.searchTranscripts("unicorn"), []);
  assert.deepEqual(await readFile(path), original);
  assert.equal(await readFile(artifactPath, "utf8"), artifact);
});

test("backfill reports a session file missing its Pi header", async (t) => {
  const { root, a } = await fixture(t);
  const directory = join(root, "sessions");
  const path = join(directory, "broken.jsonl");
  await mkdir(directory);
  await writeFile(path, JSON.stringify({ type: "message", id: "fixture", message: { role: "user", content: "Missing header" } }));
  await assert.rejects(a.backfill(directory, () => {}), { message: `Not a Pi transcript: ${path}` });
});

test("transcript search filters by exact working directory and author independently or together", async (t) => {
  const { root, a } = await fixture(t);
  const exact = join(root, "first", "addon");
  const sameName = join(root, "second", "addon");
  const nested = join(exact, "src");
  const current = join(root, "current.jsonl");
  const timestamp = "2026-01-01T00:00:00Z";
  const index = (path, cwd, roles) => a.index(path, [
    { type: "session", id: path, version: 3, cwd },
    ...roles.map((role) => ({ type: "message", id: role, timestamp, message: { role, content: "Pineapple detail" } })),
  ]);
  await index(join(root, "first.jsonl"), exact, ["user", "assistant"]);
  await index(join(root, "second.jsonl"), sameName, ["user"]);
  await index(join(root, "nested.jsonl"), nested, ["user"]);
  await index(current, exact, ["user"]);
  const search = (filters) => a.searchTranscripts("pineapple", { exclude: current, ...filters });
  assert.equal((await search()).length, 4);
  assert.deepEqual((await search({ project: exact })).map(({ cwd, role }) => [cwd, role]).sort(), [[exact, "assistant"], [exact, "user"]]);
  assert.deepEqual((await search({ role: "user" })).map(({ cwd }) => cwd).sort(), [exact, sameName, nested].sort());
  assert.deepEqual((await search({ project: exact, role: "user" })).map(({ cwd, role }) => [cwd, role]), [[exact, "user"]]);
  assert.deepEqual(await search({ project: "addon" }), []);
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
