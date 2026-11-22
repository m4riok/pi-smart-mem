import type { Uuid } from "surrealdb";
import { databaseName, databaseNamespace, withDatabase } from "./database.ts";

export const databaseAccessModes = ["Disabled", "Read-only", "Read-write"] as const;
export type DatabaseAccessMode = (typeof databaseAccessModes)[number];
type EnabledMode = Exclude<DatabaseAccessMode, "Disabled">;

const access = "smart_mem_maintenance";
const identity = "smart_db_access";
const identities = { "Read-only": `${identity}:reader`, "Read-write": `${identity}:writer` } as const;
const dataTables = ["memory", "memory_link", "smart_pin", "smart_skill", "smart_transcript"];
const readOnlyTables = ["smart_project", "smart_project_remote", "mem_config", "memory_incident"];
const readPermission = `FOR SELECT WHERE $access = '${access}'`;
const writePermission = (writable: boolean) => writable
  ? `IF $auth = ${identities["Read-write"]} { true } ELSE { THROW 'Smart Mem database access is read-only'; }`
  : "{ THROW 'Smart Mem metadata is read-only'; }";

// In non-strict mode even a denied CREATE on a missing table can leave the
// table defined. Both modes therefore require strict table creation.
export const databaseAccessSchema = `
  DEFINE DATABASE OVERWRITE ${databaseName} STRICT;
  DEFINE TABLE IF NOT EXISTS smart_project SCHEMALESS;
  DEFINE TABLE IF NOT EXISTS smart_project_remote SCHEMALESS;
  DEFINE TABLE IF NOT EXISTS ${identity} SCHEMAFULL PERMISSIONS NONE;
  DEFINE FIELD IF NOT EXISTS credential ON ${identity} TYPE uuid;
  UPSERT ${identities["Read-only"]} SET credential = rand::uuid();
  UPSERT ${identities["Read-write"]} SET credential = rand::uuid();
  DEFINE ACCESS IF NOT EXISTS ${access} ON DATABASE TYPE RECORD
    SIGNIN (SELECT id FROM ${identity} WHERE credential = $credential LIMIT 1);
  ${[...dataTables, ...readOnlyTables].map((table) => `ALTER TABLE ${table} PERMISSIONS ${readPermission}
    FOR CREATE, UPDATE, DELETE WHERE ${writePermission(dataTables.includes(table))};`).join("\n")}
`;

export const databaseQueryDescription = `Run raw SurrealQL against Smart Mem across projects and global scope. Existing data tables: ${dataTables.join(", ")}; read-only lookup tables: ${readOnlyTables.join(", ")}. The memory.project field is a project ID or NONE for global. No schema changes. In Read-write mode, mutations run directly and do not invoke Smart Mem's embedding, memory metadata, or link maintenance. Prefer dedicated memory tools when they can do the job. Use an explicit transaction for related writes.`;

export async function queryDatabase(path: string, mode: EnabledMode, query: string, signal?: AbortSignal) {
  return withDatabase(path, false, async (db) => {
    const [credential] = await db.query<[Uuid | undefined]>(`SELECT VALUE credential FROM ONLY ${identities[mode]}`);
    if (!credential) throw new Error("Smart Mem database access is not initialized");
    signal?.throwIfAborted();
    const restricted = await db.newSession();
    await restricted.signin({ namespace: databaseNamespace, database: databaseName, access, variables: { credential } });
    return restricted.query(query).json().signal(signal).collect();
  }, signal, { capabilities: { guest_access: false, scripting: false, network_targets: false, live_query_notifications: false, experimental: false } });
}
