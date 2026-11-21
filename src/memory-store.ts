import { randomUUID } from "node:crypto";
import { RecordId, type Surreal } from "surrealdb";
import { DEFAULT_DATABASE_PATH, withDatabase } from "./database.ts";
import { commands } from "./commands.ts";
import { freshSchema, migrateSchema, type SchemaMigrationObserver } from "./schema-migrations.ts";

export const memoryKinds = ["guideline", "preference", "note"] as const;
export type Scope = "project" | "global";
export type Inventory = { memories: number; skills: number; pins: number };
export type ScopedInventory = { project?: Inventory; global: Inventory };
export type MemoryKind = (typeof memoryKinds)[number];
export type EmbeddingSpace = { model: string; dimensions: number };
export type Embedding = { model: string; values: readonly number[] };
export type Memory = { id: string; text: string; kind: MemoryKind; project?: string; scope: Scope; weight: number; revisedAt: number };
export type Draft = { scope: Scope; kind: MemoryKind; text: string };
export type LinkPair = { from: string; to: string };
type StoredMemory = Omit<Memory, "id" | "scope"> & { id: RecordId<"memory", string> };
type Search = { text: string; embedding: Embedding; limit: number; scope?: Scope; kind?: MemoryKind };
type Bindings = Record<string, unknown>;
export type ImportData = {
  memories: { text: string; kind: MemoryKind; project?: string; revisedAt?: number; embedding: Embedding }[];
  skills: { name: string; description: string; text: string; project?: string }[];
  pins: { text: string; project?: string }[];
  unmatchedProjects: { name: string; id: string }[];
};

const projection = "id, text, kind, project, weight, revisedAt";
const maxIndexSize = 0xffff_ffff;
const currentProject = "($project != NONE AND project = $project)";
const globalScope = "project = NONE";
const visible = `(${currentProject} OR ${globalScope})`;
const selectSpace = "SELECT model, dimensions FROM ONLY mem_config:embedding";
const fields = ["embedding", "embedding_alt"] as const;
async function activeField(db: Surreal) {
  const [slot] = await db.query<[0 | 1]>("SELECT VALUE slot FROM ONLY mem_config:embedding");
  return fields[slot];
}
const record = (id: string) => new RecordId("memory", id);
const linkKey = (from: string, to: string) => JSON.stringify([from, to]);

function memory({ id, text, kind, project, weight, revisedAt }: StoredMemory): Memory {
  return { id: id.id, text, kind, project, weight, revisedAt, scope: project === undefined ? "global" : "project" };
}

function positiveInt(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maxIndexSize) {
    throw new Error(`${name} must be a positive 32-bit unsigned integer`);
  }
}

async function assertEmbedding(db: Surreal, embedding: Embedding): Promise<void> {
  const [space] = await db.query<[EmbeddingSpace | undefined]>(selectSpace);
  if (!space) throw new Error("Smart Mem database is not initialized");
  validateEmbedding(space, embedding);
}

function validateEmbedding(space: EmbeddingSpace, embedding: Embedding): void {
  if (space.model !== embedding.model || space.dimensions !== embedding.values.length) {
    throw new Error("Embedding does not match the active Smart Mem model and dimensions");
  }
  if (embedding.values.some((value) => !Number.isFinite(value)) || !embedding.values.some((value) => value !== 0)) {
    throw new Error("Cosine search requires a finite, nonzero embedding");
  }
}

const inventoryTables = ["memory", "smart_skill", "smart_pin"];
const dataTables = ["memory_link", "memory_incident", ...inventoryTables, "smart_transcript"];

async function hasStoredData(db: Surreal): Promise<boolean> {
  const [found] = await db.query<[boolean]>(`RETURN ${dataTables.map((table) => `(SELECT VALUE id FROM ${table} LIMIT 1) != []`).join(" OR ")}`);
  return found;
}

export class MemoryStore {
  readonly #project?: string;
  readonly #path: string;

  get project(): string | undefined { return this.#project; }

  constructor(project?: string, path = DEFAULT_DATABASE_PATH) {
    this.#project = project;
    this.#path = path;
  }

  async initialize(space: EmbeddingSpace, signal?: AbortSignal): Promise<void> {
    positiveInt(space.dimensions, "Embedding dimensions");
    await withDatabase(this.#path, true, async (db) => {
      await db.query("DEFINE TABLE IF NOT EXISTS mem_config SCHEMAFULL");
      const [existing] = await db.query<[EmbeddingSpace | undefined]>(selectSpace);
      if (existing) {
        if (existing.model !== space.model || existing.dimensions !== space.dimensions) {
          throw new Error("Smart Mem is already initialized with a different embedding model or dimension");
        }
        await migrateSchema(db, undefined, signal);
        return;
      }
      signal?.throwIfAborted();
      await db.query(`
        BEGIN TRANSACTION;
        DEFINE FIELD model ON mem_config TYPE string;
        DEFINE FIELD dimensions ON mem_config TYPE int;
        DEFINE FIELD slot ON mem_config TYPE int DEFAULT 0;
        DEFINE TABLE memory SCHEMAFULL;
        DEFINE FIELD text ON memory TYPE string;
        DEFINE FIELD kind ON memory TYPE ${memoryKinds.map((kind) => `'${kind}'`).join(" | ")};
        DEFINE FIELD weight ON memory TYPE int DEFAULT 0 ASSERT $value >= 0;
        DEFINE FIELD revisedAt ON memory TYPE int DEFAULT time::millis();
        DEFINE FIELD project ON memory TYPE option<string>;
        DEFINE FIELD embedding ON memory TYPE option<array<float>>;
        DEFINE FIELD embedding_alt ON memory TYPE option<array<float>>;
        DEFINE TABLE memory_incident SCHEMALESS;
        DEFINE TABLE smart_pin SCHEMALESS;
        DEFINE TABLE smart_skill SCHEMALESS;
        DEFINE TABLE smart_transcript SCHEMALESS;
        DEFINE INDEX memory_scope ON memory FIELDS project, kind;
        DEFINE ANALYZER memory_terms TOKENIZERS blank,class,camel,punct FILTERS lowercase;
        DEFINE INDEX transcript_text ON smart_transcript FIELDS text FULLTEXT ANALYZER memory_terms BM25;
        DEFINE INDEX memory_text ON memory FIELDS text FULLTEXT ANALYZER memory_terms BM25;
        DEFINE INDEX memory_vector ON memory FIELDS embedding HNSW DIMENSION ${space.dimensions} DIST COSINE;
        DEFINE TABLE memory_link SCHEMAFULL TYPE RELATION IN memory OUT memory ENFORCED;
        DEFINE INDEX memory_link_pair ON memory_link FIELDS in, out UNIQUE;
        CREATE ONLY mem_config:embedding CONTENT $space;
        ${freshSchema}
        COMMIT TRANSACTION;
      `, { space });
    }, signal);
  }

  async embeddingSpace(upgrade?: { observe: SchemaMigrationObserver; signal?: AbortSignal }): Promise<EmbeddingSpace | undefined> {
    return this.#use(async (db) => {
      const [space] = await db.query<[EmbeddingSpace | undefined]>(selectSpace);
      if (space && upgrade) await migrateSchema(db, upgrade.observe, upgrade.signal);
      return space;
    }, upgrade?.signal);
  }

  async inventory(): Promise<ScopedInventory> {
    type Counts = { project?: string; total: number }[];
    return this.#use(async (db) => {
      const [memories, skills, pins] = await db.query<[Counts, Counts, Counts]>(
        inventoryTables.map((table) => `SELECT project, count() AS total FROM ${table} WHERE ${visible} GROUP BY project;`).join("\n"),
        { project: this.#project },
      );
      const forProject = (project?: string): Inventory => {
        const count = (rows: Counts) => rows.find((row) => row.project === project)?.total ?? 0;
        return { memories: count(memories), skills: count(skills), pins: count(pins) };
      };
      return { project: this.#project === undefined ? undefined : forProject(this.#project), global: forProject() };
    });
  }

  async hasStoredData(signal?: AbortSignal): Promise<boolean> {
    return this.#use(hasStoredData, signal);
  }

  async replaceImportedData(data: ImportData, force: boolean, signal?: AbortSignal): Promise<void> {
    await this.#use(async (db) => {
      if (!force && await hasStoredData(db)) throw new Error(`Smart Mem already contains data. Run /${commands.migrateHermes} force to replace it.`);
      const [space] = await db.query<[EmbeddingSpace | undefined]>(selectSpace);
      if (!space) throw new Error("Smart Mem database is not initialized");
      const field = await activeField(db);
      const memories = data.memories.map(({ embedding, ...note }) => {
        validateEmbedding(space, embedding);
        return { ...note, [field]: embedding.values };
      });
      signal?.throwIfAborted();
      await db.query("DEFINE TABLE IF NOT EXISTS smart_project SCHEMALESS");
      signal?.throwIfAborted();
      await db.query(`BEGIN TRANSACTION;
        ${dataTables.map((table) => `DELETE ${table};`).join("\n")}
        FOR $note IN $memories { CREATE memory CONTENT $note; };
        FOR $skill IN $skills { CREATE smart_skill CONTENT $skill; };
        FOR $pin IN $pins { CREATE smart_pin SET text = $pin.text, project = $pin.project, created = time::now(); };
        FOR $pair IN $unmatched {
          LET $id = $pair.id;
          CREATE $id SET project = $pair.project, hermesName = $pair.name;
        };
        COMMIT TRANSACTION;`, {
        memories, pins: data.pins, skills: data.skills,
        unmatched: data.unmatchedProjects.map(({ name, id }) => ({ id: new RecordId("smart_project", id), project: id, name })),
      });
    }, signal);
  }

  async add(draft: Draft, embedding: Embedding, signal?: AbortSignal): Promise<Memory> {
    const project = draft.scope === "project" ? this.#project : undefined;
    if (draft.scope === "project" && project === undefined) throw new Error("No current project for this memory");
    return this.#use(async (db) => {
      await assertEmbedding(db, embedding);
      const field = await activeField(db);
      signal?.throwIfAborted();
      const [row] = await db.query<[StoredMemory]>(`CREATE ONLY $id SET
        text = $text, kind = $kind, project = $project, ${field} = $embedding
        RETURN ${projection}`, {
        id: record(randomUUID()), text: draft.text, kind: draft.kind, project, embedding: embedding.values,
      });
      return memory(row);
    });
  }

  async read(id: string): Promise<Memory | undefined> {
    return this.#use((db) => this.#read(db, id));
  }

  async readMany(ids: string[], signal?: AbortSignal): Promise<Memory[]> {
    if (!ids.length) return [];
    return this.#use(async (db) => {
      const [rows] = await db.query<[StoredMemory[]]>(`SELECT ${projection} FROM $ids WHERE ${visible}`, this.#bind({ ids: ids.map(record) }));
      const found = new Map(rows.map((row) => [row.id.id, memory(row)]));
      return ids.flatMap((id) => found.get(id) ?? []);
    }, signal);
  }

  async replace(id: string, text: string, embedding: Embedding, signal?: AbortSignal): Promise<Memory | undefined> {
    return this.#use(async (db) => {
      await assertEmbedding(db, embedding);
      const field = await activeField(db);
      signal?.throwIfAborted();
      const [rows] = await db.query<[StoredMemory[]]>(`UPDATE $id SET consolidated = IF text != $text { NONE } ELSE { consolidated },
        linkChecked = IF text != $text { NONE } ELSE { linkChecked },
        revisedAt = IF text != $text { time::millis() } ELSE { revisedAt }, text = $text, ${field} = $embedding
        WHERE ${visible} RETURN ${projection}`, this.#bind({ id: record(id), text, embedding: embedding.values }));
      return rows[0] && memory(rows[0]);
    });
  }

  async reclassify(changes: readonly { note: Memory; kind: MemoryKind }[], signal?: AbortSignal): Promise<number> {
    if (!changes.length) return 0;
    return this.#use(async (db) => {
      const updates = [];
      for (const { note, kind } of changes) {
        const current = await this.#read(db, note.id);
        if (current && current.revisedAt === note.revisedAt && current.text === note.text && current.kind === note.kind && current.kind !== kind) {
          updates.push({ id: record(note.id), kind });
        }
      }
      if (!updates.length) return 0;
      signal?.throwIfAborted();
      await db.query("BEGIN TRANSACTION; FOR $change IN $updates { UPDATE $change.id SET kind = $change.kind; }; COMMIT TRANSACTION;", { updates });
      return updates.length;
    });
  }

  async cleanGuidance(changes: readonly { note: Memory; replacement: { text: string; embedding: Embedding } | null }[], signal?: AbortSignal): Promise<number> {
    if (!changes.length) return 0;
    return this.#use(async (db) => {
      const updates = [];
      const field = await activeField(db);
      for (const { note, replacement } of changes) {
        const current = await this.#read(db, note.id);
        if (!current || current.text !== note.text || current.revisedAt !== note.revisedAt || replacement?.text === current.text) continue;
        if (replacement) await assertEmbedding(db, replacement.embedding);
        updates.push({ id: record(note.id), text: replacement?.text, embedding: replacement?.embedding.values });
      }
      if (!updates.length) return 0;
      signal?.throwIfAborted();
      await db.query(`BEGIN TRANSACTION;
        FOR $change IN $updates {
          LET $id = $change.id;
          IF $change.text = NONE { DELETE $id; }
          ELSE { UPDATE $id SET text = $change.text, consolidated = NONE, linkChecked = NONE, ${field} = $change.embedding; };
        };
        COMMIT TRANSACTION;`, { updates });
      return updates.length;
    });
  }

  async reinforce(id: string, incident: string, signal?: AbortSignal): Promise<boolean> {
    return this.#use(async (db) => {
      if (!await this.#read(db, id)) return false;
      const marker = new RecordId("memory_incident", incident);
      const [existing] = await db.query<[RecordId | undefined]>("SELECT VALUE id FROM ONLY $marker", { marker });
      if (existing) return false;
      signal?.throwIfAborted();
      await db.query(`BEGIN TRANSACTION;
        CREATE $marker;
        UPDATE $id SET weight += 1;
        COMMIT TRANSACTION;`, { marker, id: record(id) });
      return true;
    });
  }

  async remove(id: string, signal?: AbortSignal): Promise<boolean> {
    return this.#use(async (db) => {
      signal?.throwIfAborted();
      const [rows] = await db.query<[StoredMemory[]]>(`DELETE $id WHERE ${visible} RETURN BEFORE`, this.#bind({ id: record(id) }));
      return rows.length > 0;
    });
  }

  async search({ text, embedding, limit, scope, kind }: Search): Promise<Memory[]> {
    positiveInt(limit, "Search limit");
    const filter = scope === "project" ? currentProject : scope === "global" ? globalScope : visible;
    const predicate = `${filter}${kind === undefined ? "" : " AND kind = $kind"}`;
    return this.#use(async (db) => {
      await assertEmbedding(db, embedding);
      const field = await activeField(db);
      const [, , , hits, rows] = await db.query<[undefined, undefined, undefined, { id: RecordId<"memory", string> }[], StoredMemory[]]>(`
        LET $vectors = (SELECT id, vector::distance::knn() AS distance FROM memory
          WHERE ${predicate} AND ${field} <|${limit},${Math.max(limit, 100)}|> $embedding ORDER BY distance ASC);
        LET $terms = (SELECT id, search::score(1) AS score FROM memory WHERE ${predicate} AND text @1@ $text
          ORDER BY score DESC LIMIT $limit);
        LET $hits = search::rrf([$vectors, $terms], $limit, 60);
        RETURN $hits;
        SELECT ${projection} FROM $hits.id;
      `, this.#bind({ text, kind, limit, embedding: embedding.values }));
      const byId = new Map(rows.map((row) => [row.id.id, row]));
      return hits.map(({ id }) => {
        const row = byId.get(id.id);
        if (!row) throw new Error(`Missing Smart Mem search result: ${id}`);
        return memory(row);
      });
    });
  }

  async relatedGlobalPreferences(id: string, limit: number): Promise<Memory[]> {
    positiveInt(limit, "Search limit");
    return this.#use(async (db) => {
      if (this.#project === undefined) return [];
      const field = await activeField(db);
      const [, rows] = await db.query<[undefined, StoredMemory[]]>(`
        LET $anchor = (SELECT VALUE ${field} FROM ONLY $id WHERE ${currentProject});
        IF $anchor = NONE { RETURN []; } ELSE {
          RETURN SELECT ${projection}, vector::distance::knn() AS distance FROM memory
            WHERE ${globalScope} AND kind = 'preference'
              AND ${field} <|${limit},${Math.max(limit, 100)}|> $anchor ORDER BY distance ASC;
        };
      `, this.#bind({ id: record(id) }));
      return rows.map(memory);
    });
  }

  async linkingSnapshot(scope: Scope, { full = false, signal }: { full?: boolean; signal?: AbortSignal } = {}): Promise<{ notes: Memory[]; sources: Memory[] }> {
    const [rows] = await this.#use((db) => db.query<[(StoredMemory & { linkChecked?: boolean })[]]>(
      `SELECT ${projection}, linkChecked FROM memory WHERE ${scope === "project" ? visible : globalScope} ORDER BY id`, this.#bind({}),
    ).collect(), signal);
    return {
      notes: rows.map(memory),
      sources: rows.filter((row) => (full || !row.linkChecked) && (row.project === undefined ? scope === "global" : scope === "project")).map(memory),
    };
  }

  // Commit edges and completed source checks together. Another Pi session can
  // edit or remove a note while the model is judging its snapshot.
  async saveLinks(notes: readonly Memory[], pairs: readonly LinkPair[], checked: readonly string[], signal?: AbortSignal): Promise<number> {
    return this.#use(async (db) => {
      const ids = notes.map(({ id }) => record(id));
      const [rows] = await db.query<[StoredMemory[]]>(`SELECT ${projection} FROM $ids WHERE ${visible}`, this.#bind({ ids }));
      const current = new Map(rows.map((row) => [row.id.id, row]));
      for (const note of notes) {
        const row = current.get(note.id);
        if (!row || row.text !== note.text || row.project !== note.project || row.revisedAt !== note.revisedAt) {
          throw new Error(`Memory ${note.id} changed during linking; rerun to check its current text`);
        }
      }
      if (checked.some((id) => !current.has(id))) throw new Error("Cannot mark a memory outside the link batch checked");
      const edges = [];
      if (pairs.length) {
        const [stored] = await db.query<[{ in: StoredMemory["id"]; out: StoredMemory["id"] }[]]>(
          "SELECT in, out FROM memory_link WHERE in INSIDE $ids AND out INSIDE $ids", { ids },
        );
        const seen = new Set(stored.map((edge) => linkKey(edge.in.id, edge.out.id)));
        for (const { from, to } of pairs) {
          const source = current.get(from);
          const target = current.get(to);
          if (!source || !target || from === to || (target.project !== undefined && target.project !== source.project)) {
            throw new Error("Ineligible link endpoints");
          }
          const key = linkKey(from, to);
          if (seen.has(key) || (source.project === target.project && seen.has(linkKey(to, from)))) continue;
          edges.push({ from: source.id, to: target.id });
          seen.add(key);
        }
      }
      if (!edges.length && !checked.length) return 0;
      signal?.throwIfAborted();
      await db.query(`BEGIN TRANSACTION;
        FOR $edge IN $edges { LET $from = $edge.from; LET $to = $edge.to; RELATE $from->memory_link->$to; };
        UPDATE $checked SET linkChecked = true;
        COMMIT TRANSACTION;`, { edges, checked: checked.map(record) });
      return edges.length;
    }, signal);
  }

  async related(id: string): Promise<Memory[]> {
    return this.#use(async (db) => {
      const source = await this.#read(db, id);
      if (!source) return [];
      const incoming = source.scope === "global" ? "in.project = NONE" : "in.project = $project";
      const outgoing = source.scope === "global" ? "out.project = NONE" : "(out.project = NONE OR out.project = $project)";
      const [, , rows] = await db.query<[undefined, undefined, StoredMemory[]]>(`
        LET $targets = (SELECT VALUE out FROM memory_link WHERE in = $id AND ${outgoing});
        LET $origins = (SELECT VALUE in FROM memory_link WHERE out = $id AND ${incoming});
        SELECT ${projection} FROM array::distinct(array::concat($targets, $origins));
      `, this.#bind({ id: record(id) }));
      return rows.map(memory);
    });
  }

  async rebuild(space: EmbeddingSpace, embed: (text: string) => Promise<Embedding>): Promise<void> {
    positiveInt(space.dimensions, "Embedding dimensions");
    const snapshot = () => this.#use((db) => db.query<[EmbeddingSpace, StoredMemory[]]>(`${selectSpace}; SELECT ${projection} FROM memory ORDER BY id;`).collect());
    const [active, rows] = await snapshot();
    const updates: { id: StoredMemory["id"]; embedding: readonly number[] }[] = [];
    for (const row of rows) {
      const { model, values } = await embed(row.text);
      if (model !== space.model || values.length !== space.dimensions || values.some((v) => !Number.isFinite(v)) || values.every((v) => v === 0)) throw new Error("Invalid replacement embedding");
      updates.push({ id: row.id, embedding: values });
    }
    await this.#use(async (db) => {
      const [current, recent] = await db.query<[EmbeddingSpace, StoredMemory[]]>(`${selectSpace}; SELECT ${projection} FROM memory ORDER BY id;`);
      if (JSON.stringify(active) !== JSON.stringify(current) || JSON.stringify(rows.map(memory)) !== JSON.stringify(recent.map(memory))) {
        throw new Error("Memories or active model changed during rebuild. Coordinate other Pi sessions and retry.");
      }
      const previous = await activeField(db);
      const slot = previous === fields[0] ? 1 : 0;
      const next = fields[slot];
      const oldIndex = previous === fields[0] ? "memory_vector" : "memory_vector_alt";
      const newIndex = slot === 0 ? "memory_vector" : "memory_vector_alt";
      // Index definition must commit before writes. This slot is inactive;
      // a failed rebuild can leave its empty index, which the next rebuild replaces.
      await db.query(`REMOVE INDEX IF EXISTS ${newIndex} ON memory;
        DEFINE INDEX ${newIndex} ON memory FIELDS ${next} HNSW DIMENSION ${space.dimensions} DIST COSINE;`);
      await db.query(`BEGIN TRANSACTION;
        REMOVE INDEX ${oldIndex} ON memory;
        FOR $row IN $updates { LET $id = $row.id; UPDATE $id SET ${next} = $row.embedding, ${previous} = NONE; };
        UPDATE mem_config:embedding MERGE $space;
        COMMIT TRANSACTION;`, { updates, space: { ...space, slot } });
    });
  }

  async list(scope: Scope, selection?: "unconsolidated"): Promise<Memory[]> {
    const filter = scope === "project" ? currentProject : globalScope;
    const pending = selection === "unconsolidated" ? " AND consolidated != true" : "";
    const [rows] = await this.#use((db) => db.query<[StoredMemory[]]>(`SELECT ${projection} FROM memory WHERE ${filter}${pending} ORDER BY id`, this.#bind({})).collect());
    return rows.map(memory);
  }

  async markConsolidated(note: Memory, checked: boolean, signal?: AbortSignal): Promise<void> {
    await this.#use(async (db) => {
      signal?.throwIfAborted();
      await db.query(`UPDATE $id SET consolidated = $checked WHERE ${visible} AND text = $text AND revisedAt = $revisedAt`,
        this.#bind({ id: record(note.id), text: note.text, revisedAt: note.revisedAt, checked }));
    }, signal);
  }

  async candidates(note: Memory, limit: number, sameScope: boolean): Promise<Memory[]> {
    positiveInt(limit, "Candidate limit");
    const filter = note.scope === "global" ? globalScope : sameScope ? currentProject : visible;
    return this.#use(async (db) => {
      if (!(await this.#read(db, note.id))) return [];
      const field = await activeField(db);
      const [, rows] = await db.query<[undefined, StoredMemory[]]>(`
        LET $anchor = (SELECT VALUE ${field} FROM ONLY $id);
        SELECT ${projection}, vector::distance::knn() AS distance FROM memory WHERE ${filter} AND id != $id
          AND ${field} <|${limit},${Math.max(limit, 100)}|> $anchor ORDER BY distance ASC;
      `, this.#bind({ id: record(note.id) }));
      return rows.map(memory);
    });
  }

  async merge(survivor: Memory, removed: Memory[], text: string, embedding: Embedding, signal?: AbortSignal, consolidated = false): Promise<boolean> {
    const expected = [survivor, ...removed];
    if (new Set(expected.map(({ id }) => id)).size !== expected.length || removed.some(({ project }) => project !== survivor.project)) {
      throw new Error("Consolidation requires distinct memories in the same scope");
    }
    return this.#use(async (db) => {
      await assertEmbedding(db, embedding);
      let weight = 0;
      for (const note of expected) {
        const current = await this.#read(db, note.id);
        if (!current || current.text !== note.text || current.project !== note.project || current.revisedAt !== note.revisedAt) return false;
        weight = Math.max(weight, current.weight);
      }
      const field = await activeField(db);
      const keep = record(survivor.id);
      const discard = removed.map(({ id }) => record(id));
      const [edges] = await db.query<[{ in: RecordId; out: RecordId }[]]>("SELECT in, out FROM memory_link WHERE in INSIDE $discard OR out INSIDE $discard", { discard });
      const discarded = new Set(discard.map(String));
      const redirected = new Map<string, { from: RecordId; to: RecordId }>();
      for (const edge of edges) {
        const from = discarded.has(String(edge.in)) ? keep : edge.in;
        const to = discarded.has(String(edge.out)) ? keep : edge.out;
        if (String(from) !== String(to)) redirected.set(JSON.stringify([String(from), String(to)]), { from, to });
      }
      signal?.throwIfAborted();
      await db.query(`BEGIN TRANSACTION;
        UPDATE $keep SET consolidated = IF $consolidated { true } ELSE IF text = $text { consolidated } ELSE { NONE },
          linkChecked = IF text = $text { linkChecked } ELSE { NONE }, text = $text, weight = $weight, ${field} = $embedding;
        DELETE $discard;
        FOR $edge IN $edges {
          LET $from = $edge.from;
          LET $to = $edge.to;
          IF (SELECT VALUE id FROM memory_link WHERE in = $from AND out = $to LIMIT 1) = [] {
            RELATE $from->memory_link->$to;
          };
        };
        COMMIT TRANSACTION;`, { keep, discard, text, weight, consolidated, embedding: embedding.values, edges: [...redirected.values()] });
      return true;
    });
  }

  #bind(bindings: Bindings): Bindings {
    return { ...bindings, project: this.#project };
  }

  #use<T>(action: (db: Surreal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    return withDatabase(this.#path, false, action, signal);
  }

  async #read(db: Surreal, id: string): Promise<Memory | undefined> {
    const [rows] = await db.query<[StoredMemory[]]>(`SELECT ${projection} FROM $id WHERE ${visible}`, this.#bind({ id: record(id) }));
    return rows[0] && memory(rows[0]);
  }
}
