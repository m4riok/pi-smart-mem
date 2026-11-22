import { execFile } from "node:child_process";
import { mkdtemp, rename, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { Progress, Runtime } from "./embeddings.ts";

const version = "1.31.1";
const runtimeDirectory = (profile: string) => join(profile, `directml-${version}`);
const exec = promisify(execFile);

export async function hasDirectMLRuntime(profile: string): Promise<boolean> {
  return stat(runtimeDirectory(profile)).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
}

export function directMLRuntime(profile: string): Runtime {
  return createRequire(import.meta.url)(join(runtimeDirectory(profile), "node_modules", "onnxruntime-node"));
}

// The shared worker serializes requests, including runtime installation.
export async function installDirectMLRuntime(profile: string, progress: Progress, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const staging = await mkdtemp(join(profile, ".directml-"));
  try {
    progress("Downloading ONNX Runtime Node for DirectML");
    // Use npm shipped with Node on Windows. Run its JavaScript entry point so
    // cancellation reaches npm directly and no console window is created.
    const npm = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
    await exec(process.execPath, [npm, "install", "--prefix", ".", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock", `onnxruntime-node@${version}`], {
      cwd: staging, signal, windowsHide: true,
    });
    signal?.throwIfAborted();
    await rename(staging, runtimeDirectory(profile));
  } finally { await rm(staging, { recursive: true, force: true }); }
}
