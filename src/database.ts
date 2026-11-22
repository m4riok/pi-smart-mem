import { mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { NodeEngine } from "@surrealdb/node";
import { Surreal, type ConnectionState } from "surrealdb";
import { withFileLock } from "./file-lock.ts";

export const DEFAULT_DATABASE_PATH = join(homedir(), ".pi", "agent", "pi-smart-mem", "db");
export const databaseNamespace = "smart_mem";
export const databaseName = "memory";

type EngineOptions = ConstructorParameters<typeof NodeEngine>[1];

function embeddedClient(directory: string, options?: EngineOptions): Surreal {
  // The embedded native binding takes a literal path after surrealkv://. The
  // SDK's URL serialization otherwise opens a percent-encoded directory.
  const endpoint = new URL("surrealkv:///db");
  endpoint.toString = () => `surrealkv://${directory}`;
  return new Surreal({ engines: {
    surrealkv: (context) => new class extends NodeEngine {
      override open(state: ConnectionState): void { super.open({ ...state, url: endpoint }); }
    }(context, options),
  } });
}

export async function withDatabase<T>(
  path: string,
  initialize: boolean,
  action: (db: Surreal) => Promise<T>,
  signal?: AbortSignal,
  options?: EngineOptions,
): Promise<T> {
  const directory = resolve(path);
  if (initialize) await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
  return withFileLock(`${directory}.lock`, async () => {
    if (!initialize && !(await stat(directory)).isDirectory()) {
      throw new Error(`Smart Mem database path is not a directory: ${directory}`);
    }
    if (initialize) await mkdir(directory, { mode: 0o700, recursive: true });
    const db = embeddedClient(directory, options);
    try {
      await db.connect("surrealkv:///db");
      await db.use({ namespace: databaseNamespace, database: databaseName });
      return await action(db);
    } finally {
      await db.close();
    }
  }, signal);
}
