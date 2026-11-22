import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { queryDatabase } from "../src/database-access.ts";
import { withDatabase } from "../src/database.ts";
import { MemoryStore } from "../src/memory-store.ts";

const vector = { model: "db-access-fixture", values: [1, 0] };
const note = (scope, text) => ({ scope, text, kind: "note" });

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "psm-db-access-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "db");
  const store = new MemoryStore("project-a", path);
  await store.initialize({ model: vector.model, dimensions: 2 });
  return { store, path, admin: (sql) => withDatabase(path, false, (db) => db.query(sql).collect()) };
}

test("raw queries see cross-project data; engine rejects nested and direct mutations in read-only mode", async (t) => {
  const { store, path } = await fixture(t);
  const local = await store.add(note("project", "Project A"), vector);
  await new MemoryStore("project-b", path).add(note("project", "Project B"), vector);
  await store.add(note("global", "Global"), vector);
  const query = (sql) => queryDatabase(path, "Read-only", sql);
  assert.deepEqual(await query("SELECT VALUE text FROM memory ORDER BY text"), [["Global", "Project A", "Project B"]]);
  await assert.rejects(query("UPDATE memory SET text = 'not allowed'"), /read-only/);
  await assert.rejects(query("RETURN (DELETE memory RETURN BEFORE)"), /read-only/);
  await assert.rejects(query("SELECT * FROM memory; CREATE smart_pin SET text = 'not allowed'"), /read-only/);
  await assert.rejects(query("CREATE missing_table:row SET value = 1"), /table.*does not exist/i);
  assert.deepEqual(await store.read(local.id), local);
});

test("read-write permissions allow data changes but not schema, metadata, or other databases", async (t) => {
  const { store, path, admin } = await fixture(t);
  const local = await store.add(note("project", "Original"), vector);
  const query = (sql) => queryDatabase(path, "Read-write", sql);
  assert.deepEqual(await query("UPDATE memory SET project = 'project-b' WHERE text = 'Original' RETURN VALUE project"), [["project-b"]]);
  assert.equal(await store.read(local.id), undefined);
  assert.deepEqual(await new MemoryStore("project-b", path).read(local.id), { ...local, project: "project-b" });
  await assert.rejects(query("DEFINE TABLE disallowed SCHEMALESS"), /permissions/i);
  await assert.rejects(query("REMOVE INDEX memory_text ON memory"), /permissions/i);
  await assert.rejects(query("CREATE missing_table:row SET value = 1"), /table.*does not exist/i);
  await assert.rejects(query("UPDATE mem_config:embedding SET dimensions = 5"), /metadata is read-only/);
  await assert.rejects(query("USE NS elsewhere DB elsewhere;"), /permission/i);
  await assert.rejects(query("RETURN http::get('http://127.0.0.1:1/')"), /network target.*not allowed/i);
  assert.deepEqual(await query("SELECT * FROM smart_db_access"), [[]]);
  const [schema] = await admin("INFO FOR DB");
  assert.ok(!Object.hasOwn(schema.tables, "missing_table"));
  assert.ok(!Object.hasOwn(schema.tables, "disallowed"));
  assert.deepEqual(await store.embeddingSpace(), { model: vector.model, dimensions: 2 });
});

test("v3 upgrade installs restricted access and preserves preferences, links, and all check flags", async (t) => {
  const { store, path, admin } = await fixture(t);
  const saved = await store.add({ scope: "global", kind: "preference", text: "Original" }, vector);
  const linked = await store.add(note("global", "Related"), vector);
  await store.saveLinks([saved, linked], [{ from: saved.id, to: linked.id }], [saved.id]);
  await store.markConflictChecked(saved);
  await store.markConsolidated(saved, true);
  await admin(`DEFINE DATABASE OVERWRITE memory;
    REMOVE ACCESS smart_mem_maintenance ON DATABASE;
    REMOVE TABLE smart_db_access;
    ALTER TABLE memory PERMISSIONS NONE;
    UPDATE smart_schema:current SET version = 3;`);
  const observed = [];
  await store.embeddingSpace({ observe: (...event) => observed.push(event) });
  assert.deepEqual(observed, [["start", 3, 4], ["applied", 3, 4]]);
  assert.deepEqual(await store.read(saved.id), saved);
  assert.deepEqual(await store.related(saved.id), [linked]);
  assert.deepEqual(await store.list("global", "unconsolidated"), [linked]);
  assert.deepEqual(await store.list("global", "unchecked-conflicts"), [linked]);
  assert.deepEqual((await store.linkingSnapshot("global")).sources, [linked]);
  assert.deepEqual(await queryDatabase(path, "Read-only", "SELECT VALUE text FROM memory ORDER BY text"), [["Original", "Related"]]);
  await assert.rejects(queryDatabase(path, "Read-write", "CREATE missing_table:row"), /table.*does not exist/i);
});
