import type { Device, GpuAvailability } from "./embeddings.ts";
import type { Embedding } from "./memory-store.ts";

export type Request = { kind: "probe"; download?: true } | { kind: "embed"; model: string; device: Device; text: string; query: boolean; download: boolean };
export type Reply = { kind: "ready" } | { kind: "progress"; message: string } | { kind: "error"; message: string }
  | ({ kind: "probe" } & GpuAvailability) | { kind: "embedding"; embedding: Embedding };

export function parseRequest(line: string): Request {
  const value = JSON.parse(line) as Partial<Request> | null;
  if (value?.kind === "probe") return { kind: "probe", download: value.download === true ? true : undefined };
  if (value?.kind === "embed" && typeof value.model === "string" && (value.device === "cpu" || value.device === "cuda") &&
      typeof value.text === "string" && typeof value.query === "boolean" && typeof value.download === "boolean") return value as Request;
  throw new Error("Invalid embedding worker request");
}
