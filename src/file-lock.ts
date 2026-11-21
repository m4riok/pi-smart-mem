import { spawn } from "node:child_process";
import { open } from "node:fs/promises";

function acquireLock(fd: number, path: string, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    // flock locks the open file description shared with the parent. The lock
    // survives helper exit and releases when the parent closes its descriptor.
    const child = spawn("flock", ["--exclusive", "3"], { stdio: ["ignore", "ignore", "pipe", fd], signal });
    let stderr = "";
    child.stderr!.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    let error: Error | undefined;
    child.once("error", (cause) => { error = cause; });
    child.once("close", (code, killed) => {
      if (signal?.aborted) reject(signal.reason);
      else if (error) reject(new Error(`Could not start flock for ${path}`, { cause: error }));
      else if (code === 0) resolve();
      else reject(new Error(`Could not acquire Smart Mem lock ${path} (flock: ${killed ?? code})${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
    });
  });
}

export async function withFileLock<T>(path: string, action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  // Never unlink the lock file: existing waiters would still use its old inode.
  const handle = await open(path, "a", 0o600);
  try {
    await acquireLock(handle.fd, path, signal);
    signal?.throwIfAborted();
    return await action();
  } finally {
    await handle.close();
  }
}
