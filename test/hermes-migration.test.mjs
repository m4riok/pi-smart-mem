import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Archive } from "../src/archive.ts";
import { migrateHermes } from "../src/hermes-migration.ts";
import { readHermesSource } from "../src/hermes-source.ts";
import { MemoryStore } from "../src/memory-store.ts";
import { resolveProject } from "../src/project.ts";

const embedding = { model: "fixture", values: [1, 0] };
const embed = async () => embedding;

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "smart-mem-import-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  const hermes = join(agentDir, "pi-hermes-memory");
  const projectRoot = join(agentDir, "projects-memory");
  const folder = join(root, "renamed-project");
  const dbPath = join(agentDir, "pi-smart-mem", "db");
  const store = new MemoryStore(undefined, dbPath);
  await mkdir(folder);
  const skill = (name) => `---\nname: "${name}"\ndescription: "Run fixtures"\n---\n## Procedure\nRun tests.`;
  const files = new Map([
    [join(hermes, "MEMORY.md"), "Keep notes concise <!-- created=2026-01-01, last=2026-01-02 -->\n§\nSummarize changes"],
    [join(hermes, "USER.md"), "Prefer short feedback"],
    [join(hermes, "failures.md"), [
      "PROJECT-shop: Check exit status <!-- created=2026-01-01, last=2026-01-02, project64=c2hvcA -->",
      "Verify the result of a global operation",
      `PROJECT-failure-only: Recheck the query <!-- created=2026-01-01, last=2026-01-02, project64=${Buffer.from("failure-only").toString("base64url")} -->`,
    ].join("\n§\n")],
    [join(hermes, "STANDING.md"), "# Pins\n- Preserve fixtures"],
    [join(hermes, "skills", "verify", "SKILL.md"), skill("Global verification")],
    [join(projectRoot, "shop", "MEMORY.md"), "Use pnpm"],
    [join(projectRoot, "shop", "skills", "verify", "SKILL.md"), skill("Local verification")],
    [join(projectRoot, "retired", "MEMORY.md"), "Archived design choice"],
  ]);
  for (const [path, content] of files) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
  const sqlitePath = join(hermes, "sessions.db");
  const sqlite = new DatabaseSync(sqlitePath);
  sqlite.exec("PRAGMA journal_mode = WAL; CREATE TABLE sessions (project TEXT, cwd TEXT, started_at TEXT)");
  sqlite.prepare("INSERT INTO sessions VALUES (?, ?, ?)").run("shop", folder, "2026-01-01");
  sqlite.close();
  files.set(sqlitePath, await readFile(sqlitePath));
  await store.initialize({ model: embedding.model, dimensions: 2 });
  const source = await readHermesSource(agentDir, root);
  return { root, hermes, folder, dbPath, store, source, files,
    migrate: (force, encoder = embed) => migrateHermes({ source, dbPath, force, embed: encoder, progress: () => {} }) };
}

test("bulk import preserves Hermes project and global failure attribution, skills and pins", async (t) => {
  const { hermes, folder, store, source, dbPath, files, migrate, root } = await fixture(t);
  assert.equal(source.folders.get("shop"), folder);
  assert.equal(await store.hasStoredData(), false);
  const result = await migrate(false);
  assert.equal(result.projects, 3);
  const unmatched = new Map(result.unmatchedProjects.map(({ name, id }) => [name, id]));
  assert.deepEqual([...unmatched.keys()].sort(), ["failure-only", "retired"]);
  const localId = await resolveProject(folder, dbPath);
  const local = new MemoryStore(localId, dbPath);
  const archive = new Archive(dbPath, localId);
  const global = await store.list("global");
  assert.deepEqual(global.map(({ text }) => text).sort(), ["Keep notes concise", "Prefer short feedback", "Summarize changes", "Verify the result of a global operation"]);
  assert.deepEqual(Object.fromEntries(global.map(({ text, kind }) => [text, kind])), {
    "Keep notes concise": "note", "Prefer short feedback": "preference", "Summarize changes": "note", "Verify the result of a global operation": "note",
  });
  assert.equal(global.find(({ text }) => text === "Keep notes concise").revisedAt, Date.parse("2026-01-01"));
  assert.ok(global.find(({ text }) => text === "Summarize changes").revisedAt > Date.parse("2026-01-02"));
  assert.ok(global.every(({ weight }) => weight === 0));
  const projectNotes = await local.list("project");
  assert.deepEqual(projectNotes.map(({ text }) => text).sort(), ["PROJECT-shop: Check exit status", "Use pnpm"]);
  assert.ok(projectNotes.every(({ kind }) => kind === "note"));
  assert.equal(projectNotes.find(({ text }) => text.includes("exit status")).revisedAt, Date.parse("2026-01-01"));
  const [top] = await local.search({ text: "pnpm", embedding, limit: 8, scope: "project" });
  assert.equal(top.text, "Use pnpm");
  const failureOnly = new MemoryStore(unmatched.get("failure-only"), dbPath);
  assert.deepEqual((await failureOnly.list("project")).map(({ text }) => text), ["PROJECT-failure-only: Recheck the query"]);
  const retired = new MemoryStore(unmatched.get("retired"), dbPath);
  assert.deepEqual((await retired.list("project")).map(({ text }) => text), ["Archived design choice"]);
  assert.deepEqual((await archive.searchSkills("verification")).map(({ name, scope }) => [name, scope]), [["Global verification", "Global"], ["Local verification", "Project"]]);
  assert.deepEqual(await archive.pins(), ["Preserve fixtures"]);
  assert.deepEqual(await archive.searchTranscripts("shop"), []);
  for (const [path, content] of files) assert.deepEqual(await readFile(path, typeof content === "string" ? "utf8" : undefined), content);
  assert.ok(!(await readdir(hermes)).some((name) => /sessions\.db-(wal|shm)$/.test(name)));
  assert.deepEqual(await readHermesSource(join(root, "agent"), root), source);
});

test("populated store requires force; failed embedding leaves existing data intact", async (t) => {
  const { store, dbPath, migrate, root } = await fixture(t);
  const old = await store.add({ scope: "global", kind: "preference", text: "Old saved note" }, embedding);
  const other = await store.add({ scope: "global", kind: "preference", text: "Other old note" }, embedding);
  await store.link(old.id, other.id);
  const archive = new Archive(dbPath);
  const skill = await archive.saveSkill({ scope: "global", name: "Old skill", description: "Old", text: "Old instructions" });
  await archive.pin("global", "Old pin");
  await archive.index(join(root, "old.jsonl"), [
    { type: "session", version: 3, id: "old-session", cwd: root },
    { type: "message", id: "old-message", timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "Old transcript" } },
  ]);
  await assert.rejects(migrate(false, () => assert.fail("Must reject before embedding")), /--force/);
  await assert.rejects(migrate(true, async () => { throw new Error("Embedding failure"); }), /Embedding failure/);
  assert.equal((await store.read(old.id)).text, "Old saved note");
  assert.equal((await store.related(old.id))[0].id, other.id);
  assert.equal((await archive.searchTranscripts("Old transcript")).length, 1);
  await migrate(true);
  assert.equal(await store.read(old.id), undefined);
  assert.deepEqual(await store.related(old.id), []);
  assert.equal(await archive.readSkill(skill.id), undefined);
  assert.deepEqual(await archive.searchTranscripts("Old transcript"), []);
  assert.deepEqual(await archive.pins(), ["Preserve fixtures"]);
  assert.deepEqual(await store.embeddingSpace(), { model: "fixture", dimensions: 2 });
});
