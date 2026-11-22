import type { Socket } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { LocalEmbeddings, models } from "./embeddings.ts";
import { createWorkerServer, openWorkerEndpoint } from "./embedding-endpoint.ts";
import { parseRequest, type Reply } from "./embedding-protocol.ts";
import { withFileLock } from "./file-lock.ts";

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const send = (socket: Socket, reply: Reply) => { if (!socket.destroyed) socket.write(JSON.stringify(reply) + "\n"); };

async function serve(profile: string, directory: string) {
  const local = new LocalEmbeddings(profile);
  const endpoint = await openWorkerEndpoint(directory);
  try { await listen(local, endpoint); }
  finally { await endpoint.close?.(); }
}

async function listen(local: LocalEmbeddings, endpoint: Awaited<ReturnType<typeof openWorkerEndpoint>>) {
  let work = Promise.resolve();
  let clients = 0;
  const server = await createWorkerServer(endpoint, (socket) => {
    clients++;
    const disconnect = new AbortController();
    socket.on("error", () => socket.destroy());
    socket.once("close", () => {
      disconnect.abort();
      clients--;
      stopWhenUnused();
    });
    send(socket, { kind: "ready" });
    const lines = createInterface({ input: socket, crlfDelay: Infinity });
    lines.on("error", () => socket.destroy());
    lines.on("line", (line) => {
      work = work.then(async () => {
        if (disconnect.signal.aborted) return;
        const request = parseRequest(line);
        if (request.kind === "probe") {
          send(socket, { kind: "probe", unavailable: await local.cudaUnavailable() });
          return;
        }
        const model = models.find((model) => model.model === request.model);
        if (!model) throw new Error(`Unsupported Smart Mem embedding model: ${request.model}`);
        const embedding = await local.embed(model, request.device, request.text, {
          query: request.query, signal: disconnect.signal,
          download: request.download ? (message) => send(socket, { kind: "progress", message }) : undefined,
        });
        send(socket, { kind: "embedding", embedding });
      }).catch((error: unknown) => send(socket, { kind: "error", message: errorMessage(error) }));
    });
  });
  function stopWhenUnused() {
    if (!clients && !process.connected && server.listening) server.close();
  }
  process.once("disconnect", stopWhenUnused);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.once("close", resolve);
    server.listen(endpoint.path, () => {
      if (process.connected) process.send?.({ ready: true }, (error) => { if (error) stopWhenUnused(); });
      else stopWhenUnused();
    });
  });
  await work;
  await local.close();
}

const profile = process.argv[2];
const directory = join(profile, "embedding-worker");
await withFileLock(join(directory, "owner.lock"), async () => {
  try { await serve(profile, directory); }
  catch (error) {
    // If teardown failed, exit while still holding the lock so the OS destroys
    // this process's runtime before another worker can take ownership.
    if (process.connected) {
      await new Promise<void>((resolve) => process.send?.({ error: errorMessage(error) }, () => resolve()));
    } else console.error(`Smart Mem embedding worker: ${errorMessage(error)}`);
    process.exit(1);
  }
});
