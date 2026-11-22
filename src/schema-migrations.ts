import { NotFoundError, type Surreal } from "surrealdb";
import { databaseAccessSchema } from "./database-access.ts";

// Version zero is the initialized schema before version tracking was added.
const migrations = [
  "DEFINE FIELD IF NOT EXISTS consolidated ON memory TYPE option<bool>;",
  "DEFINE FIELD IF NOT EXISTS linkChecked ON memory TYPE option<bool>;",
  "DEFINE FIELD IF NOT EXISTS conflictChecked ON memory TYPE option<bool>;",
  databaseAccessSchema,
] as const;

const schemaTable = "smart_schema";
const schemaRecord = `${schemaTable}:current`;
const setVersion = (version: number) => `
  DEFINE TABLE IF NOT EXISTS ${schemaTable} SCHEMAFULL;
  DEFINE FIELD IF NOT EXISTS version ON ${schemaTable} TYPE int;
  UPSERT ${schemaRecord} SET version = ${version};`;

// New databases have no existing rows to migrate. Apply the schema additions
// and stamp the latest version in the same transaction as initialization.
export const freshSchema = `${migrations.join("\n")}\n${setVersion(migrations.length)}`;

export type SchemaMigrationObserver = (stage: "start" | "applied", from: number, to: number) => void;

// The caller must hold the database lock across this read and all writes.
export async function migrateSchema(db: Surreal, observe?: SchemaMigrationObserver, signal?: AbortSignal): Promise<void> {
  let stored: { version: number } | undefined;
  try { [stored] = await db.query<[typeof stored]>(`SELECT version FROM ONLY ${schemaRecord}`); }
  catch (error) {
    if (!(error instanceof NotFoundError) || error.tableName !== schemaTable) throw error;
  }
  const version = stored === undefined ? 0 : stored.version;
  if (!Number.isSafeInteger(version) || version < 0) throw new Error("Invalid Smart Mem database schema version");
  if (version > migrations.length) {
    throw new Error(`Smart Mem database schema ${version} is newer than supported schema ${migrations.length}. Update Smart Mem.`);
  }
  for (let from = version; from < migrations.length; from++) {
    signal?.throwIfAborted();
    const to = from + 1;
    observe?.("start", from, to);
    try {
      await db.query(`BEGIN TRANSACTION;\n${migrations[from]}\n${setVersion(to)}\nCOMMIT TRANSACTION;`);
    } catch (error) {
      throw new Error(`Smart Mem database migration ${from} → ${to} failed: ${String(error)}`, { cause: error });
    }
    observe?.("applied", from, to);
  }
}
