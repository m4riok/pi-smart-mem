import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RecordId } from "surrealdb";
import { promisify } from "node:util";
import { Archive } from "../src/archive.ts";
import { withDatabase } from "../src/database.ts";
import { MemoryStore } from "../src/memory-store.ts";

const exec = promisify(execFile);
const space = { model: "fixture", dimensions: 3 };
const vector = (...values) => ({ model: space.model, values });
const query = vector(1, 0, 0);
const projectNote = (text) => ({ scope: "project", kind: "note", text });
const preference = (text) => ({ scope: "global", kind: "preference", text });

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "smart-mem-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "profile #α", "db");
  const store = new MemoryStore("/repo/a", path);
  await store.initialize(space);
  return { path, store, other: new MemoryStore("/repo/b", path), global: new MemoryStore(undefined, path) };
}

test("explicit initialization and durable scoped CRUD", async (t) => {
  const { path, store, other, global } = await fixture(t);
  assert.ok((await stat(path)).isDirectory());
  assert.deepEqual(await global.embeddingSpace(), space);
  await store.initialize(space);
  await assert.rejects(store.initialize({ ...space, model: "incompatible" }), /already initialized/);
  await assert.rejects(store.add(projectNote("Bad vector"), vector(1, 0)), /does not match/);
  await assert.rejects(store.add(projectNote("Stale vector"), { ...query, model: "stale" }), /does not match/);
  await assert.rejects(global.add(projectNote("No repo"), query), /No current project/);

  const local = await store.add(projectNote("Use pnpm in this repo"), query);
  const shared = await store.add(preference("Run relevant tests"), query);
  assert.deepEqual(await global.read(shared.id), shared);
  assert.equal(await global.read(local.id), undefined);
  assert.equal(await other.read(local.id), undefined);
  assert.equal(await other.replace(local.id, "Not allowed", query), undefined);
  assert.equal(await other.remove(local.id), false);
  assert.deepEqual(await store.read(local.id), local);
  assert.equal(local.weight, 0);
  assert.ok(local.revisedAt > 0);
  assert.deepEqual(await store.replace(local.id, local.text, query), local);
  const { revisedAt, ...edited } = await store.replace(local.id, "Use pnpm and run check", query);
  assert.ok(revisedAt > local.revisedAt);
  const { revisedAt: originalRevision, ...original } = local;
  assert.deepEqual(edited, { ...original, text: "Use pnpm and run check" });
  assert.equal(await store.remove(local.id), true);
  assert.equal(await store.read(local.id), undefined);
});

test("inventory counts memories, skills and pins without counting unrelated projects", async (t) => {
  const { path, store, other, global } = await fixture(t);
  const archive = new Archive(path, store.project);
  const otherArchive = new Archive(path, other.project);
  const skill = { name: "Fixture", description: "Test", text: "Run tests" };
  await store.add(projectNote("Current project"), query);
  await other.add(projectNote("Unrelated project"), query);
  await global.add(preference("Global preference"), query);
  await global.add({ scope: "global", kind: "note", text: "Global failure" }, query);
  await archive.saveSkill({ ...skill, scope: "project" });
  await archive.saveSkill({ ...skill, scope: "global" });
  await otherArchive.saveSkill({ ...skill, scope: "project" });
  await archive.pin("global", "Global pin");
  await otherArchive.pin("project", "Unrelated pin");
  const shared = { memories: 2, skills: 1, pins: 1 };
  assert.deepEqual(await store.inventory(), { project: { memories: 1, skills: 1, pins: 0 }, global: shared });
  assert.deepEqual(await global.inventory(), { project: undefined, global: shared });
});

test("search filters before ranking and returns project and global labels", async (t) => {
  const { store, other, global } = await fixture(t);
  const excluded = await other.add(projectNote("PHPMD PHPMD"), query);
  const both = await store.add(projectNote("Run PHPMD on changes"), vector(0.94, 0.34, 0));
  const semantic = await store.add(projectNote("Check code for maintainability"), vector(0.99, 0.14, 0));
  const lexical = await store.add(projectNote("PHPMD is unrelated to CSS"), vector(0, 1, 0));
  const shared = await global.add(preference("Run relevant quality checks"), vector(0.91, 0.41, 0));
  const search = { text: "PHPMD", embedding: query, limit: 2 };
  const scoped = await store.search({ ...search, scope: "project" });
  assert.deepEqual(scoped, [both, semantic]);
  assert.ok((await store.search({ ...search, scope: "project", limit: 3 })).some(({ id }) => id === lexical.id));
  const mixed = await store.search({ ...search, limit: 5 });
  assert.deepEqual(new Set(mixed), new Set([both, semantic, lexical, shared]));
  assert.ok(mixed.every(({ id }) => id !== excluded.id));
  assert.deepEqual(await store.search({ ...search, kind: "preference" }), [shared]);
  assert.deepEqual(await global.search(search), [shared]);
});

test("links are one-hop, scoped and retained on edit; related preferences do not add edges", async (t) => {
  const { store, other, global } = await fixture(t);
  const first = await store.add(projectNote("Authentication paths"), query);
  const neighbor = await store.add(projectNote("JWT generation"), query);
  const wrongRepo = await other.add(projectNote("Another repo's auth"), query);
  const shared = await global.add(preference("Use explicit expiry values"), vector(0.98, 0.2, 0));
  await global.add({ scope: "global", kind: "note", text: "A test did not run" }, query);
  assert.deepEqual(await store.relatedGlobalPreferences(first.id, 3), [shared]);
  assert.deepEqual(await other.relatedGlobalPreferences(first.id, 3), []);
  assert.deepEqual(await store.related(first.id), []);
  assert.equal(await store.link(first.id, neighbor.id), true);
  assert.equal(await store.link(first.id, neighbor.id), false);
  assert.equal(await store.link(neighbor.id, shared.id), true);
  assert.equal(await store.link(neighbor.id, wrongRepo.id), false);
  assert.equal(await store.link(shared.id, neighbor.id), false);
  assert.deepEqual(await store.related(first.id), [neighbor]);
  assert.deepEqual(await store.related(neighbor.id), [shared]);
  assert.deepEqual(await other.related(neighbor.id), []);
  const edited = await store.replace(neighbor.id, "JWT generation and TTL", vector(0.8, 0.6, 0));
  assert.deepEqual(await store.related(first.id), [edited]);
  assert.deepEqual(await store.related(neighbor.id), [shared]);
  assert.equal(await store.remove(neighbor.id), true);
  assert.deepEqual(await store.related(first.id), []);
});

test("merge redirects incoming and outgoing links and keeps scope and kind", async (t) => {
  const { path, store, global } = await fixture(t);
  const from = await store.add(projectNote("Refer to test procedure"), query);
  const keep = await store.add({ scope: "project", kind: "guideline", text: "Run check" }, query);
  const drop = await store.add({ scope: "project", kind: "note", text: "Test command needs database fixture" }, query);
  const target = await global.add(preference("Use isolated fixtures"), query);
  await withDatabase(path, false, (db) => db.query("UPDATE $keep SET weight = 2; UPDATE $drop SET weight = 5;", {
    keep: new RecordId("memory", keep.id), drop: new RecordId("memory", drop.id),
  }));
  await store.link(from.id, drop.id);
  await store.link(keep.id, drop.id);
  await store.link(drop.id, target.id);
  await store.link(keep.id, target.id);
  const text = "Run check against an isolated database fixture";
  assert.equal(await store.merge(keep, [drop], text, query), true);
  assert.equal(await store.read(drop.id), undefined);
  assert.deepEqual(await store.related(from.id), [{ ...keep, text, weight: 5 }]);
  assert.deepEqual(await store.related(keep.id), [target]);
  await assert.rejects(store.merge(keep, [target], text, query), /same scope/);
});

test("model swap leaves old index usable on failure and embeds outside lock", async (t) => {
  const { store } = await fixture(t);
  const note = await store.add(projectNote("Record context for tokens"), query);
  const next = { model: "next", dimensions: 2 };
  const newEmbedding = { model: next.model, values: [1, 0] };
  await assert.rejects(store.rebuild(next, async () => { throw new Error("Inference failed"); }), /Inference failed/);
  assert.deepEqual(await store.embeddingSpace(), space);
  assert.deepEqual(await store.search({ text: "unrelated", embedding: query, limit: 2 }), [note]);
  await store.rebuild(next, async (text) => {
    assert.equal(text, note.text);
    assert.deepEqual(await store.read(note.id), note);
    return newEmbedding;
  });
  assert.deepEqual(await store.embeddingSpace(), next);
  assert.deepEqual(await store.search({ text: "unrelated", embedding: newEmbedding, limit: 2 }), [note]);
  await assert.rejects(store.replace(note.id, "Stale worker", query), /active Smart Mem model/);
  await store.rebuild(space, async () => query);
  assert.deepEqual(await store.search({ text: "unrelated", embedding: query, limit: 2 }), [note]);
});

test("independent processes share the same store under the held lock", async (t) => {
  const { path, global } = await fixture(t);
  await withDatabase(path, false, async () => {
    // This child has an independent descriptor, unlike the lock acquisition helper.
    await assert.rejects(exec("flock", ["--nonblock", `${path}.lock`, "true"]), { code: 1 });
  });
  const source = new URL("../src/memory-store.ts", import.meta.url).href;
  const children = Array.from({ length: 4 }, (_, i) => exec(process.execPath, ["--input-type=module", "-e", `
    import { MemoryStore } from ${JSON.stringify(source)};
    const store = new MemoryStore(undefined, process.argv[1]);
    const saved = await store.add({ scope: "global", kind: "preference", text: process.argv[2] }, ${JSON.stringify(query)});
    console.log(saved.id);
  `, path, `Child ${i}`], { timeout: 15_000 }));
  const results = await Promise.allSettled(children);
  for (const result of results) assert.equal(result.status, "fulfilled", result.reason?.stack);
  const rows = await Promise.all(results.map(({ value }) => global.read(value.stdout.trim())));
  assert.deepEqual(rows.map(({ text }) => text), ["Child 0", "Child 1", "Child 2", "Child 3"]);
});
