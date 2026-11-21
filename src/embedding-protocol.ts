import { open } from "node:fs/promises";
import type { Device } from "./embeddings.ts";
import type { Embedding } from "./memory-store.ts";

export type Request = { kind: "probe" } | { kind: "embed"; model: string; device: Device; text: string; query: boolean; download: boolean };
export type Reply = { kind: "ready" } | { kind: "progress"; message: string } | { kind: "error"; message: string }
  | { kind: "probe"; unavailable?: string } | { kind: "embedding"; embedding: Embedding };

export async function openSocketDirectory(directory: string) {
  // Linux sockaddr_un has a short path limit. Pass a short alias to the same
  // private filesystem socket, even when the Pi profile path is long.
  const handle = await open(directory, "r");
  return { path: `/proc/self/fd/${handle.fd}/worker.sock`, close: () => handle.close() };
}

export function parseRequest(line: string): Request {
  const value = JSON.parse(line) as Partial<Request> | null;
  if (value?.kind === "probe") return { kind: "probe" };
  if (value?.kind === "embed" && typeof value.model === "string" && (value.device === "cpu" || value.device === "cuda") &&
      typeof value.text === "string" && typeof value.query === "boolean" && typeof value.download === "boolean") return value as Request;
  throw new Error("Invalid embedding worker request");
}
