import { execFile, spawn } from "node:child_process";
import { open } from "node:fs/promises";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);
const requireNative = createRequire(import.meta.url);
type NativeLocks = { tryLock(fd: number): boolean };
let native: NativeLocks | undefined;

function nativeLocks(): NativeLocks {
  if (process.platform !== "win32" && process.platform !== "darwin") {
    throw new Error(`Smart Mem file locking is unsupported on ${process.platform}`);
  }
  try { return native ??= requireNative("fs-native-extensions"); }
  catch (cause) {
    throw new Error(`Smart Mem could not load its file-lock backend for ${process.platform}/${process.arch}. Reinstall Smart Mem.`, { cause });
  }
}

const flockUnavailable = (cause: unknown) => new Error("Smart Mem requires flock from util-linux. Install it or add it to PATH.", { cause });

export async function checkFileLockBackend(): Promise<void> {
  if (process.platform === "linux") {
    try { await exec("flock", ["--version"]); }
    catch (cause) { throw flockUnavailable(cause); }
  } else nativeLocks();
}

function acquireFlock(fd: number, path: string, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    // flock locks the open file description shared with the parent. The lock
    // survives helper exit and releases when the parent closes its descriptor.
    const child = spawn("flock", ["--exclusive", "3"], { stdio: ["ignore", "ignore", "pipe", fd], signal });
    let stderr = "";
    child.stderr!.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    let error: NodeJS.ErrnoException | undefined;
    child.once("error", (cause) => { error = cause; });
    child.once("close", (code, killed) => {
      if (signal?.aborted) reject(signal.reason);
      else if (error?.code === "ENOENT") reject(flockUnavailable(error));
      else if (error) reject(new Error(`Could not start flock for ${path}`, { cause: error }));
      else if (code === 0) resolve();
      else reject(new Error(`Could not acquire Smart Mem lock ${path} (flock: ${killed ?? code})${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
    });
  });
}

export async function withFileLock<T>(path: string, action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  // Linux must keep using flock: the native addon's OFD locks do not contend with it.
  const locks = process.platform === "linux" ? undefined : nativeLocks();
  // Never unlink the lock file: existing waiters would still use its old inode.
  // Windows LockFileEx needs more than the append-only access granted by "a".
  const handle = await open(path, locks ? "a+" : "a", 0o600);
  try {
    if (!locks) await acquireFlock(handle.fd, path, signal);
    else while (!locks.tryLock(handle.fd)) {
      await delay(25);
      signal?.throwIfAborted();
    }
    signal?.throwIfAborted();
    return await action();
  } finally {
    await handle.close();
  }
}
