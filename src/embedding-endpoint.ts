import { createHash } from "node:crypto";
import { mkdir, open, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";

type Endpoint = { path: string; close?: () => Promise<void> };

// directory is under the real (canonical) profile path on client and worker.
export async function openWorkerEndpoint(directory: string): Promise<Endpoint> {
  const profileId = () => createHash("sha256").update(directory).digest("hex");
  if (process.platform === "win32") {
    return { path: `\\\\.\\pipe\\psm-${profileId()}` };
  }
  if (process.platform === "darwin") {
    // macOS has a 103-byte pathname limit and no /proc/self/fd alias.
    const root = `/tmp/pi-smart-mem-${process.getuid!()}`;
    await mkdir(root, { recursive: true, mode: 0o700 });
    return { path: join(root, `${profileId()}.sock`) };
  }
  // Keep Linux's short alias to the existing private filesystem socket.
  const handle = await open(directory, "r");
  return { path: `/proc/self/fd/${handle.fd}/worker.sock`, close: () => handle.close() };
}

export async function createWorkerServer(endpoint: Endpoint, onClient: (socket: Socket) => void) {
  // Only the worker holding the lifetime lock may remove a stale Unix socket.
  // A Windows pipe disappears on exit.
  if (process.platform !== "win32") await rm(endpoint.path, { force: true });
  return createServer(onClient);
}
