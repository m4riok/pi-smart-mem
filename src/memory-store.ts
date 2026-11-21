import { randomUUID } from "node:crypto";
import { RecordId, type Surreal } from "surrealdb";
import { DEFAULT_DATABASE_PATH, withDatabase } from "./database.ts";
import { commands } from "./commands.ts";

const categories = {
  project: ["repository_information", "workflow_decision", "local_failure"],
  global: ["user_preference", "global_workflow_failure"],
} as const;

export type Scope = keyof typeof categories;
export type Inventory = { memories: number; skills: number; pins: number };
export type ScopedInventory = { project?: Inventory; global: Inventory };
export type Category = (typeof categories)[Scope][number];
export type EmbeddingSpace = { model: string; dimensions: number };
export type Embedding = { model: string; values: readonly number[] };
export type Memory = { id: string; text: string; category: Category; project?: string; scope: Scope };
export type Draft = {
  [S in Scope]: { scope: S; category: (typeof categories)[S][number]; text: string };
}[Scope];
type StoredMemory = Omit<Memory, "id" | "scope"> & { id: RecordId<"memory", string> };
type Search = { text: string; embedding: Embedding; limit: number; scope?: Scope; category?: Category };
type Bindings = Record<string, unknown>;
export type ImportData = {
  memories: { text: string; category: Category; project?: string; embedding: Embedding }[];
  skills: { name: string; description: string; text: string; project?: string }[];
  pins: { text: string; project?: string }[];
  unmatchedProjects: { name: string; id: string }[];
};

const projection = "id, text, category, project";
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

function memory({ id, text, category, project }: StoredMemory): Memory {
  return { id: id.id, text, category, project, scope: project === undefined ? "global" : "project" };
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
const dataTables = ["memory_link", ...inventoryTables, "smart_transcript"];

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

  async initialize(space: EmbeddingSpace): Promise<void> {
    positiveInt(space.dimensions, "Embedding dimensions");
    await withDatabase(this.#path, true, async (db) => {
      await db.query("DEFINE TABLE IF NOT EXISTS mem_config SCHEMAFULL");
      const [existing] = await db.query<[EmbeddingSpace | undefined]>(selectSpace);
      if (existing) {
        if (existing.model !== space.model || existing.dimensions !== space.dimensions) {
          throw new Error("Smart Mem is already initialized with a different embedding model or dimension");
        }
        return;
      }
      await db.query(`
        BEGIN TRANSACTION;
        DEFINE FIELD model ON mem_config TYPE string;
        DEFINE FIELD dimensions ON mem_config TYPE int;
        DEFINE FIELD slot ON mem_config TYPE int DEFAULT 0;
        DEFINE TABLE memory SCHEMAFULL;
        DEFINE FIELD text ON memory TYPE string;
        DEFINE FIELD category ON memory TYPE string;
        DEFINE FIELD project ON memory TYPE option<string>;
        DEFINE FIELD embedding ON memory TYPE option<array<float>>;
        DEFINE FIELD embedding_alt ON memory TYPE option<array<float>>;
        DEFINE FIELD reviewed ON memory TYPE bool DEFAULT false;
        DEFINE TABLE smart_pin SCHEMALESS;
        DEFINE TABLE smart_skill SCHEMALESS;
        DEFINE TABLE smart_transcript SCHEMALESS;
        DEFINE INDEX memory_scope ON memory FIELDS project, category;
        DEFINE ANALYZER memory_terms TOKENIZERS blank,class,camel,punct FILTERS lowercase;
        DEFINE INDEX transcript_text ON smart_transcript FIELDS text FULLTEXT ANALYZER memory_terms BM25;
        DEFINE INDEX memory_text ON memory FIELDS text FULLTEXT ANALYZER memory_terms BM25;
        DEFINE INDEX memory_vector ON memory FIELDS embedding HNSW DIMENSION ${space.dimensions} DIST COSINE;
        DEFINE TABLE memory_link SCHEMAFULL TYPE RELATION IN memory OUT memory ENFORCED;
        DEFINE INDEX memory_link_pair ON memory_link FIELDS in, out UNIQUE;
        CREATE ONLY mem_config:embedding CONTENT $space;
        COMMIT TRANSACTION;
      `, { space });
    });
  }

  async embeddingSpace(): Promise<EmbeddingSpace | undefined> {
    return this.#use(async (db) => (await db.query<[EmbeddingSpace | undefined]>(selectSpace))[0]);
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

  async hasStoredData(): Promise<boolean> {
    return this.#use(hasStoredData);
  }

  async replaceImportedData(data: ImportData, force: boolean): Promise<void> {
    await this.#use(async (db) => {
      if (!force && await hasStoredData(db)) throw new Error(`Smart Mem already contains data. Run /${commands.migrateHermes} --force to replace it.`);
      const [space] = await db.query<[EmbeddingSpace | undefined]>(selectSpace);
      if (!space) throw new Error("Smart Mem database is not initialized");
      const field = await activeField(db);
      const memories = data.memories.map(({ embedding, ...note }) => {
        validateEmbedding(space, embedding);
        return { ...note, [field]: embedding.values };
      });
      await db.query("DEFINE TABLE IF NOT EXISTS smart_project SCHEMALESS");
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
    });
  }

  async add(draft: Draft, embedding: Embedding, signal?: AbortSignal): Promise<Memory> {
    const project = draft.scope === "project" ? this.#project : undefined;
    if (draft.scope === "project" && project === undefined) throw new Error("No current project for this memory");
    if (!(categories[draft.scope] as readonly Category[]).includes(draft.category)) {
      throw new Error(`Invalid category for ${draft.scope} memory: ${draft.category}`);
    }
    return this.#use(async (db) => {
      await assertEmbedding(db, embedding);
      const field = await activeField(db);
      signal?.throwIfAborted();
      const [row] = await db.query<[StoredMemory]>(`CREATE ONLY $id SET
        text = $text, category = $category, project = $project, ${field} = $embedding
        RETURN ${projection}`, {
        id: record(randomUUID()), text: draft.text, category: draft.category, project, embedding: embedding.values,
      });
      return memory(row);
    });
  }

  async read(id: string): Promise<Memory | undefined> {
    return this.#use((db) => this.#read(db, id));
  }

  async readMany(ids: string[]): Promise<Memory[]> {
    if (!ids.length) return [];
    return this.#use(async (db) => {
      const [rows] = await db.query<[StoredMemory[]]>(`SELECT ${projection} FROM $ids WHERE ${visible}`, this.#bind({ ids: ids.map(record) }));
      const found = new Map(rows.map((row) => [row.id.id, memory(row)]));
      return ids.flatMap((id) => found.get(id) ?? []);
    });
  }

  async replace(id: string, text: string, embedding: Embedding, signal?: AbortSignal): Promise<Memory | undefined> {
    return this.#use(async (db) => {
      await assertEmbedding(db, embedding);
      const field = await activeField(db);
      signal?.throwIfAborted();
      const [rows] = await db.query<[StoredMemory[]]>(`UPDATE $id SET text = $text, ${field} = $embedding
        WHERE ${visible} RETURN ${projection}`, this.#bind({ id: record(id), text, embedding: embedding.values }));
      return rows[0] && memory(rows[0]);
    });
  }

  async remove(id: string, signal?: AbortSignal): Promise<boolean> {
    return this.#use(async (db) => {
      signal?.throwIfAborted();
      const [rows] = await db.query<[StoredMemory[]]>(`DELETE $id WHERE ${visible} RETURN BEFORE`, this.#bind({ id: record(id) }));
      return rows.length > 0;
    });
  }

  async search({ text, embedding, limit, scope, category }: Search): Promise<Memory[]> {
    positiveInt(limit, "Search limit");
    const filter = scope === "project" ? currentProject : scope === "global" ? globalScope : visible;
    const predicate = `${filter}${category === undefined ? "" : " AND category = $category"}`;
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
      `, this.#bind({ text, category, limit, embedding: embedding.values }));
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
            WHERE ${globalScope} AND category = 'user_preference'
              AND ${field} <|${limit},${Math.max(limit, 100)}|> $anchor ORDER BY distance ASC;
        };
      `, this.#bind({ id: record(id) }));
      return rows.map(memory);
    });
  }

  // Only link-building callers use this method; recall and CRUD never create edges.
  async link(from: string, to: string, signal?: AbortSignal): Promise<boolean> {
    if (from === to) return false;
    return this.#use(async (db) => {
      const source = await this.#read(db, from);
      const target = await this.#read(db, to);
      if (!source || !target || (source.scope === "global" && target.scope === "project")) return false;
      const bindings = { from: record(from), to: record(to) };
      const [existing] = await db.query<[RecordId[]]>("SELECT VALUE id FROM memory_link WHERE in = $from AND out = $to LIMIT 1", bindings);
      if (existing.length > 0) return false;
      signal?.throwIfAborted();
      await db.query("RELATE $from->memory_link->$to", bindings);
      return true;
    });
  }

  async related(id: string): Promise<Memory[]> {
    return this.#use(async (db) => {
      const source = await this.#read(db, id);
      if (!source) return [];
      const condition = source.scope === "global" ? "out.project = NONE" : "(out.project = NONE OR out.project = $project)";
      const [, rows] = await db.query<[undefined, StoredMemory[]]>(`
        LET $targets = (SELECT VALUE out FROM memory_link WHERE in = $id AND ${condition});
        SELECT ${projection} FROM $targets;
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

  async list(scope: Scope, unreviewed = false): Promise<Memory[]> {
    const filter = scope === "project" ? currentProject : globalScope;
    const [rows] = await this.#use((db) => db.query<[StoredMemory[]]>(`SELECT ${projection} FROM memory WHERE ${filter}${unreviewed ? " AND reviewed = false" : ""} ORDER BY id`, this.#bind({})).collect());
    return rows.map(memory);
  }

  async markReviewed(note: Memory, signal?: AbortSignal): Promise<void> {
    await this.#use(async (db) => {
      signal?.throwIfAborted();
      await db.query(`UPDATE $id SET reviewed = true WHERE ${visible}`, this.#bind({ id: record(note.id) }));
    });
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

  async merge(survivor: Memory, removed: Memory[], text: string, embedding: Embedding, signal?: AbortSignal): Promise<boolean> {
    const expected = [survivor, ...removed];
    if (new Set(expected.map(({ id }) => id)).size !== expected.length || removed.some(({ project }) => project !== survivor.project)) {
      throw new Error("Consolidation requires distinct memories in the same scope");
    }
    return this.#use(async (db) => {
      await assertEmbedding(db, embedding);
      for (const note of expected) {
        const current = await this.#read(db, note.id);
        if (!current || current.text !== note.text || current.project !== note.project) return false;
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
        UPDATE $keep SET text = $text, ${field} = $embedding;
        DELETE $discard;
        FOR $edge IN $edges {
          LET $from = $edge.from;
          LET $to = $edge.to;
          IF (SELECT VALUE id FROM memory_link WHERE in = $from AND out = $to LIMIT 1) = [] {
            RELATE $from->memory_link->$to;
          };
        };
        COMMIT TRANSACTION;`, { keep, discard, text, embedding: embedding.values, edges: [...redirected.values()] });
      return true;
    });
  }

  #bind(bindings: Bindings): Bindings {
    return { ...bindings, project: this.#project };
  }

  #use<T>(action: (db: Surreal) => Promise<T>): Promise<T> {
    return withDatabase(this.#path, false, action);
  }

  async #read(db: Surreal, id: string): Promise<Memory | undefined> {
    const [rows] = await db.query<[StoredMemory[]]>(`SELECT ${projection} FROM $id WHERE ${visible}`, this.#bind({ id: record(id) }));
    return rows[0] && memory(rows[0]);
  }
}
