import { spawn } from "node:child_process";
import { mkdir, open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { NodeEngine } from "@surrealdb/node";
import { Surreal, type ConnectionState } from "surrealdb";

export const DEFAULT_DATABASE_PATH = join(homedir(), ".pi", "agent", "pi-smart-mem", "db");

function acquireLock(fd: number): Promise<void> {
  return new Promise((resolve, reject) => {
    // flock locks the open file description shared with the parent. The lock
    // survives helper exit and releases when the parent closes its descriptor.
    const child = spawn("flock", ["--exclusive", "3"], { stdio: ["ignore", "ignore", "inherit", fd] });
    child.once("error", (cause) => reject(new Error("Could not start flock for Smart Mem", { cause })));
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Could not acquire Smart Mem database lock (flock: ${signal ?? code})`));
    });
  });
}

function embeddedClient(directory: string): Surreal {
  // The embedded native binding takes a literal path after surrealkv://. The
  // SDK's URL serialization otherwise opens a percent-encoded directory.
  const endpoint = new URL("surrealkv:///db");
  endpoint.toString = () => `surrealkv://${directory}`;
  return new Surreal({ engines: {
    surrealkv: (context) => new class extends NodeEngine {
      override open(state: ConnectionState): void { super.open({ ...state, url: endpoint }); }
    }(context),
  } });
}

export async function withFileLock<T>(path: string, action: () => Promise<T>): Promise<T> {
  // Never unlink the lock file: existing waiters would still use its old inode.
  const handle = await open(path, "a", 0o600);
  try {
    await acquireLock(handle.fd);
    return await action();
  } finally {
    await handle.close();
  }
}

export async function withDatabase<T>(
  path: string,
  initialize: boolean,
  action: (db: Surreal) => Promise<T>,
): Promise<T> {
  const directory = resolve(path);
  if (initialize) await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
  return withFileLock(`${directory}.lock`, async () => {
    if (!initialize && !(await stat(directory)).isDirectory()) {
      throw new Error(`Smart Mem database path is not a directory: ${directory}`);
    }
    if (initialize) await mkdir(directory, { mode: 0o700, recursive: true });
    const db = embeddedClient(directory);
    try {
      await db.connect("surrealkv:///db");
      await db.use({ namespace: "smart_mem", database: "memory" });
      return await action(db);
    } finally {
      await db.close();
    }
  });
}
