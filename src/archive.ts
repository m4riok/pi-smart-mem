import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { type FileEntry, parseSessionEntries } from "@earendil-works/pi-coding-agent";
import { RecordId } from "surrealdb";
import { withDatabase } from "./database.ts";
import type { Scope } from "./memory-store.ts";

export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n");
}

export type Pin = { id: RecordId<"smart_pin">; scope: Scope; text: string };
type PinRow = Pick<Pin, "id" | "text"> & { project?: string };
type SkillDraft = { name: string; description: string; text: string; scope: Scope };
type SkillSummaryRow = Pick<SkillDraft, "name" | "description"> & { id: RecordId<"smart_skill", string>; project?: string };
type SkillRow = SkillSummaryRow & Pick<SkillDraft, "text">;
export const transcriptRoles = ["user", "assistant"] as const;
type TranscriptPart = { entry: string; role: typeof transcriptRoles[number]; text: string; timestamp: string };
type TranscriptSearch = { exclude?: string; project?: string; role?: TranscriptPart["role"] };
const inScope = "(project = NONE OR ($project != NONE AND project = $project))";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const skill = <T extends SkillSummaryRow>({ id, project, ...row }: T) => ({ ...row, id: id.id, scope: project === undefined ? "Global" : "Project" });
const skillWords = (value: string) => value.match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];

export function transcriptParts(entries: FileEntry[]): TranscriptPart[] {
  const parts: TranscriptPart[] = [];
  for (const [position, record] of entries.entries()) {
    if (record.type !== "message") continue;
    const { role } = record.message;
    if (role !== "user" && role !== "assistant") continue;
    const text = contentText(record.message.content).trim();
    // V1 JSONL has no entry IDs. Its line order is stable across backfills.
    if (text) parts.push({ entry: record.id ?? `legacy:${position}`, role, text, timestamp: record.timestamp });
  }
  return parts;
}

export class Archive {
  readonly #path: string;
  readonly #project?: string;
  constructor(path: string, project?: string) { this.#path = path; this.#project = project; }

  async pin(scope: Scope, text: string) {
    const project = this.#scope(scope);
    await withDatabase(this.#path, false, async (db) => {
      await db.query("CREATE smart_pin SET text = $text, project = $project, created = time::now()", { project, text });
    });
  }

  async pins() {
    return (await this.listPins()).map(({ text }) => text);
  }

  async listPins(): Promise<Pin[]> {
    return withDatabase(this.#path, false, async (db) => {
      const [rows] = await db.query<[PinRow[]]>(`SELECT id, text, project, created FROM smart_pin WHERE ${inScope} ORDER BY created`, { project: this.#project });
      return rows.map(({ id, text, project }) => ({ id, text, scope: project === undefined ? "global" : "project" }));
    });
  }

  async removePin({ id, scope }: Pin): Promise<boolean> {
    const project = this.#scope(scope);
    return withDatabase(this.#path, false, async (db) => {
      const [rows] = await db.query<[PinRow[]]>("DELETE $id WHERE project = $project RETURN BEFORE", { id, project });
      return rows.length > 0;
    });
  }

  async saveSkill(draft: SkillDraft, id?: string, signal?: AbortSignal) {
    const project = this.#scope(draft.scope);
    const data = { name: draft.name, description: draft.description, text: draft.text, project };
    return withDatabase(this.#path, false, async (db) => {
      signal?.throwIfAborted();
      const bindings = { id: new RecordId("smart_skill", id ?? randomUUID()), data, project };
      if (id) {
        const [rows] = await db.query<[SkillRow[]]>("UPDATE $id MERGE $data WHERE project = $project", bindings);
        return rows[0] && skill(rows[0]);
      }
      const [row] = await db.query<[SkillRow]>("CREATE ONLY $id CONTENT $data", bindings);
      return skill(row);
    });
  }

  async searchSkills(query: string, scope?: Scope) {
    const filter = scope === "project" ? "($project != NONE AND project = $project)" : scope === "global" ? "project = NONE" : inScope;
    const [rows] = await withDatabase(this.#path, false, (db) => db.query<[SkillSummaryRow[]]>(
      `SELECT id, name, description, project FROM smart_skill WHERE ${filter} ORDER BY name`, { project: this.#project }));
    const needle = query.toLowerCase();
    const terms = [...new Set(skillWords(needle))];
    return rows.flatMap((row) => {
      const name = row.name.toLowerCase();
      const description = row.description.toLowerCase();
      const literal = name.includes(needle) || description.includes(needle);
      const nameWords = new Set(skillWords(name));
      const missing = terms.filter((term) => !nameWords.has(term));
      if (!literal) {
        const descriptionWords = new Set(skillWords(description));
        if (!terms.length || missing.some((term) => !descriptionWords.has(term))) return [];
      }
      return [{ row, literal, nameHits: terms.length - missing.length }];
    }).sort((a, b) => Number(b.literal) - Number(a.literal) || b.nameHits - a.nameHits)
      .slice(0, 20).map(({ row }) => skill(row));
  }

  async readSkill(id: string) {
    return withDatabase(this.#path, false, async (db) => {
      const [rows] = await db.query<[SkillRow[]]>(`SELECT * FROM $id WHERE ${inScope}`, { project: this.#project, id: new RecordId("smart_skill", id) });
      return rows[0] && skill(rows[0]);
    });
  }

  async removeSkill(id: string, signal?: AbortSignal): Promise<boolean> {
    return withDatabase(this.#path, false, async (db) => {
      signal?.throwIfAborted();
      const [rows] = await db.query<[SkillRow[]]>(`DELETE $id WHERE ${inScope} RETURN BEFORE`, { project: this.#project, id: new RecordId("smart_skill", id) });
      return rows.length > 0;
    });
  }

  async index(path: string, entries: FileEntry[]) {
    const header = entries.find((entry) => entry.type === "session");
    if (!header) throw new Error(`Not a Pi transcript: ${path}`);
    const source = hash(path);
    const parts = transcriptParts(entries).map((row) => ({ ...row, key: new RecordId("smart_transcript", hash(`${source}:${row.entry}`)), source, path, session: header.id, cwd: header.cwd }));
    await withDatabase(this.#path, false, async (db) => {
      await db.query(`BEGIN TRANSACTION;
        FOR $row IN $parts { LET $id = $row.key; UPSERT $id CONTENT $row; };
        COMMIT TRANSACTION;`, { parts });
    });
    return parts.length;
  }

  async searchTranscripts(query: string, { exclude, project, role }: TranscriptSearch = {}) {
    return withDatabase(this.#path, false, async (db) => {
      const [rows] = await db.query<[(TranscriptPart & { session: string; cwd: string; path: string })[]]>(`
        SELECT id, text, session, cwd, entry, role, timestamp, path, search::score(1) AS score FROM smart_transcript
          WHERE ($exclude = NONE OR path != $exclude) AND ($project = NONE OR cwd = $project)
            AND ($role = NONE OR role = $role) AND text @1@ $query ORDER BY score DESC LIMIT 12`, { query, exclude, project, role });
      return rows.map(({ text, ...row }) => {
        const hit = text.toLowerCase().indexOf(query.toLowerCase());
        const start = Math.max(0, hit - 600);
        return { ...row, text: `${start ? "…" : ""}${text.slice(start, start + 1800)}${start + 1800 < text.length ? "…" : ""}` };
      });
    });
  }

  async prune() {
    await withDatabase(this.#path, false, async (db) => { await db.query("DELETE smart_transcript"); });
  }

  async backfill(root: string, progress: (message: string) => void) {
    const files = await readdir(root, { recursive: true, withFileTypes: true });
    // pi-subagents writes JSONL artifacts alongside native Pi sessions, but they have no session header.
    const paths = files.filter((file) => file.isFile() && file.name.endsWith(".jsonl")
      && !relative(root, file.parentPath).split(sep).includes("subagent-artifacts"))
      .map((file) => join(file.parentPath, file.name));
    for (const [i, path] of paths.entries()) {
      progress(`Indexing Pi session ${i + 1}/${paths.length}`);
      await this.index(path, parseSessionEntries(await readFile(path, "utf8")));
    }
    return paths.length;
  }

  #scope(scope: Scope) {
    if (scope === "global") return undefined;
    if (this.#project === undefined) throw new Error("No active project scope");
    return this.#project;
  }
}
