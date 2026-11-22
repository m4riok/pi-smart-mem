import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, realpath } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { Device, GpuAvailability, ModelPreset, Progress } from "./embeddings.ts";
import type { Embedding } from "./memory-store.ts";
import { openWorkerEndpoint } from "./embedding-endpoint.ts";
import type { Reply, Request } from "./embedding-protocol.ts";
import { withFileLock } from "./file-lock.ts";
import type { Diagnostics } from "./diagnostics.ts";

type EmbeddingSession = {
  gpuAvailability(download?: Progress): Promise<GpuAvailability>;
  embed(preset: ModelPreset, device: Device, text: string, options?: { query?: boolean; download?: Progress }): Promise<Embedding>;
};

type Answer = Exclude<Reply, { kind: "progress" | "error" }>;
class Connection {
  #error?: Error;
  readonly #lines;
  readonly socket: Socket;
  constructor(socket: Socket) {
    this.socket = socket;
    this.#lines = createInterface({ input: socket, crlfDelay: Infinity });
    const failed = (error: Error) => { this.#error = error; socket.destroy(); };
    socket.on("error", failed);
    this.#lines.on("error", failed);
  }

  receive(signal?: AbortSignal, progress?: Progress): Promise<Answer> {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const socket = this.socket;
      const cleanup = () => {
        socket.off("close", closed);
        this.#lines.off("line", line);
        signal?.removeEventListener("abort", canceled);
      };
      const closed = () => {
        cleanup();
        reject(this.#error ?? Object.assign(new Error("Smart Mem embedding worker disconnected"), { code: "ECONNRESET" }));
      };
      const canceled = () => {
        cleanup();
        socket.destroy();
        reject(signal?.reason);
      };
      const line = (text: string) => {
        try {
          const reply = JSON.parse(text) as Reply;
          if (reply.kind === "progress") { progress?.(reply.message); return; }
          cleanup();
          if (reply.kind === "error") reject(new Error(reply.message));
          else resolve(reply);
        } catch (error) {
          cleanup();
          socket.destroy();
          reject(error);
        }
      };
      if (socket.destroyed) { closed(); return; }
      socket.once("close", closed);
      this.#lines.on("line", line);
      signal?.addEventListener("abort", canceled, { once: true });
    });
  }
}

async function connect(directory: string, signal?: AbortSignal): Promise<Connection> {
  const endpoint = await openWorkerEndpoint(directory);
  const connection = new Connection(createConnection(endpoint.path));
  try {
    if ((await connection.receive(signal)).kind !== "ready") throw new Error("Unexpected embedding worker greeting");
    connection.socket.unref();
    return connection;
  } catch (error) {
    connection.socket.destroy();
    throw error;
  } finally { await endpoint.close?.(); }
}

function workerReady(child: ChildProcess, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      child.off("exit", exited);
      child.off("disconnect", disconnected);
      signal?.removeEventListener("abort", canceled);
    };
    const failed = (error: unknown) => { cleanup(); reject(error); };
    const exited = (code: number | null, killed: string | null) => failed(new Error(`Smart Mem embedding worker failed to start (${killed ?? code})`));
    const disconnected = () => failed(new Error("Smart Mem embedding worker disconnected during startup"));
    const canceled = () => failed(signal?.reason);
    child.once("error", failed);
    child.once("exit", exited);
    child.once("disconnect", disconnected);
    child.once("message", (message: { ready?: true; error?: string }) => {
      cleanup();
      if (message.ready) resolve();
      else reject(new Error(`Smart Mem embedding worker failed to start: ${message.error}`));
    });
    signal?.addEventListener("abort", canceled, { once: true });
  });
}

export class SharedEmbeddings {
  #connection?: Connection;
  readonly #profile: string;
  readonly #log?: Diagnostics;
  constructor(profile: string, log?: Diagnostics) { this.#profile = profile; this.#log = log; }

  close() { this.#connection?.socket.destroy(); }

  // The profile-wide lock orders configuration changes and inference. It is
  // separate from the database lock, which is never held during inference.
  async run<T>(action: (session: EmbeddingSession) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const directory = join(this.#profile, "embedding-worker");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return withFileLock(join(directory, "requests.lock"), () => action({
      gpuAvailability: async (download) => {
        const answer = await this.#call(directory, { kind: "probe", download: download ? true : undefined }, signal, download);
        if (answer.kind !== "probe") throw new Error("Unexpected embedding worker probe reply");
        return { unavailable: answer.unavailable, needsRuntime: answer.needsRuntime };
      },
      embed: async (preset, device, text, options = {}) => {
        const answer = await this.#call(directory, { kind: "embed", model: preset.model, device, text,
          query: options.query ?? false, download: options.download !== undefined }, signal, options.download);
        if (answer.kind !== "embedding") throw new Error("Unexpected embedding worker inference reply");
        return answer.embedding;
      },
    }), signal);
  }

  async #call(directory: string, request: Request, signal?: AbortSignal, progress?: Progress): Promise<Answer> {
    signal?.throwIfAborted();
    const started = performance.now();
    const fields = request.kind === "embed" ? { model: request.model, device: request.device, query: request.query } : {};
    try {
      const current = this.#connection;
      const coldConnection = !current || current.socket.destroyed;
      const connection = coldConnection ? await this.#startOrConnect(directory, signal) : current;
      this.#connection = connection;
      const { socket } = connection;
      socket.ref();
      try {
        const reply = connection.receive(signal, progress);
        if (!socket.destroyed) socket.write(JSON.stringify(request) + "\n");
        const answer = await reply;
        void this.#log?.write(`embedding.${request.kind}`, { ...fields, coldConnection, ms: Math.round(performance.now() - started),
          unavailable: answer.kind === "probe" ? answer.unavailable : undefined });
        return answer;
      } finally { socket.unref(); }
    } catch (error) {
      void this.#log?.write(`embedding.${request.kind}`, { ...fields, ms: Math.round(performance.now() - started), error: String(error) }, signal?.aborted ? "info" : "error");
      throw error;
    }
  }

  async #startOrConnect(directory: string, signal?: AbortSignal): Promise<Connection> {
    // Windows and macOS name endpoints by canonical profile; Linux connects by descriptor.
    const canonical = process.platform === "linux" ? undefined : await realpath(this.#profile);
    const endpointDirectory = canonical === undefined ? directory : join(canonical, "embedding-worker");
    try { return await connect(endpointDirectory, signal); }
    catch (error) {
      if (!["ENOENT", "ECONNREFUSED", "ECONNRESET"].includes((error as NodeJS.ErrnoException)?.code ?? "")) throw error;
    }
    const profile = canonical ?? await realpath(this.#profile);
    signal?.throwIfAborted();
    const entry = fileURLToPath(new URL("./embedding-worker-entry.mjs", import.meta.url));
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", entry, profile], {
      detached: true, windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    try {
      await workerReady(child, signal);
      return await connect(endpointDirectory, signal);
    } finally {
      if (child.connected) child.disconnect();
      child.unref();
    }
  }
}
