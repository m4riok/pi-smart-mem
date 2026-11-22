import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { models } from "../src/embeddings.ts";
import { createWorkerServer, openWorkerEndpoint } from "../src/embedding-endpoint.ts";
import { SharedEmbeddings } from "../src/shared-embeddings.ts";

const mini = models[0];
const bge = models.find(({ model }) => model === "Xenova/bge-base-en-v1.5");
// ONNX opset 11: cast [1, tokens] IDs to float, unsqueeze and tile to [1, tokens, dimensions].
const graph = {
  384: "CAc69AEKIgoJaW5wdXRfaWRzEgRjYXN0IgRDYXN0KgkKAnRvGAGgAQIKJgoEY2FzdBIGY29sdW1uIglVbnNxdWVlemUqCwoEYXhlc0ACoAEHCioKBmNvbHVtbgoHcmVwZWF0cxIRbGFzdF9oaWRkZW5fc3RhdGUiBFRpbGUSEWVtYmVkZGluZy1maXh0dXJlKhQIAxAHOAE4ATiAA0IHcmVwZWF0c1ohCglpbnB1dF9pZHMSFAoSCAcSDgoCCAEKCBIGbGVuZ3RoYi4KEWxhc3RfaGlkZGVuX3N0YXRlEhkKFwgBEhMKAggBCggSBmxlbmd0aAoDCIADQgIQCw==",
  768: "CAc69AEKIgoJaW5wdXRfaWRzEgRjYXN0IgRDYXN0KgkKAnRvGAGgAQIKJgoEY2FzdBIGY29sdW1uIglVbnNxdWVlemUqCwoEYXhlc0ACoAEHCioKBmNvbHVtbgoHcmVwZWF0cxIRbGFzdF9oaWRkZW5fc3RhdGUiBFRpbGUSEWVtYmVkZGluZy1maXh0dXJlKhQIAxAHOAE4ATiABkIHcmVwZWF0c1ohCglpbnB1dF9pZHMSFAoSCAcSDgoCCAEKCBIGbGVuZ3RoYi4KEWxhc3RfaGlkZGVuX3N0YXRlEhkKFwgBEhMKAggBCggSBmxlbmd0aAoDCIAGQgIQCw==",
};
const tokenizer = {
  model: { type: "WordPiece", unk_token: "[UNK]", vocab: { "[UNK]": 1, "[CLS]": 2, "[SEP]": 3, alpha: 4, beta: 5 }, continuing_subword_prefix: "##", max_input_chars_per_word: 100 },
  decoder: { type: "WordPiece", prefix: "##", cleanup: true }, pre_tokenizer: { type: "Whitespace" },
  post_processor: { type: "BertProcessing", sep: ["[SEP]", 3], cls: ["[CLS]", 2] }, normalizer: null, added_tokens: [],
};

async function cacheModel(profile, preset) {
  const path = join(profile, "models", preset.model, preset.revision);
  await mkdir(join(path, "onnx"), { recursive: true });
  await writeFile(join(path, "tokenizer.json"), JSON.stringify(tokenizer));
  await writeFile(join(path, "tokenizer_config.json"), JSON.stringify({ unk_token: "[UNK]" }));
  await writeFile(join(path, "onnx", "model_quantized.onnx"), Buffer.from(graph[preset.dimensions], "base64"));
}

function client(t, profile) {
  const code = `
    import {SharedEmbeddings} from ${JSON.stringify(new URL("../src/shared-embeddings.ts", import.meta.url).href)};
    import {models} from ${JSON.stringify(new URL("../src/embeddings.ts", import.meta.url).href)};
    const worker = new SharedEmbeddings(process.argv[1]);
    process.on("message", async ({ model, device }) => {
      try {
        const progress = [];
        const embedding = await worker.run((session) => session.embed(models.find((preset) => preset.model === model), device, "alpha beta", { download: (message) => progress.push(message) }));
        process.send({ embedding, progress });
      } catch (error) { process.send({ error: error.message }); }
    });`;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", code, profile], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
  const closed = once(child, "close");
  t.after(async () => { child.kill(); await closed; });
  return {
    embed: async (preset, device = "cpu") => {
      const timeout = new AbortController();
      const timer = setTimeout(10_000, undefined, { signal: timeout.signal });
      try {
        const message = once(child, "message", { signal: timeout.signal });
        child.send({ model: preset.model, device });
        const [answer] = await Promise.race([message, closed.then(([code, signal]) => assert.fail(`Client exited before reply: ${signal ?? code}`)), timer.then(() => assert.fail("Client did not reply"))]);
        assert.equal(answer.error, undefined);
        assert.equal(answer.embedding.model, preset.model);
        assert.equal(answer.embedding.values.length, preset.dimensions);
        assert.ok(Math.abs(Math.hypot(...answer.embedding.values) - 1) < 1e-5);
        return answer.progress.filter((message) => message.startsWith("Loading ")).length;
      } finally { timeout.abort(); }
    },
    exit: async () => { child.kill(); await closed; },
  };
}

async function waitForWorkerExit(profile, count) {
  const deadline = Date.now() + 5_000;
  let log;
  while (Date.now() < deadline) {
    log = await readFile(join(profile, "smart-mem.log"), "utf8");
    if (log.split('"event":"worker.exit"').length - 1 >= count) return log;
    await setTimeout(20);
  }
  assert.fail(`Embedding worker diagnostics did not record shutdown:\n${log}`);
}

async function assertSocketAbsent(profile) {
  if (process.platform === "win32") return; // Named pipes are not filesystem entries.
  const endpoint = await openWorkerEndpoint(await realpath(join(profile, "embedding-worker")));
  try { await assert.rejects(stat(endpoint.path), { code: "ENOENT" }); }
  finally { await endpoint.close?.(); }
}

test("independent clients share one loaded CPU model, including switches and worker restart", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "smart-mem-worker-"));
  const profile = join(root, "long profile ".repeat(10));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cacheModel(profile, mini);
  await cacheModel(profile, bge);
  await mkdir(join(profile, "embedding-worker"));
  const [first, second, third] = [client(t, profile), client(t, profile), client(t, profile)];
  await assertSocketAbsent(profile);
  const loads = await Promise.all([first.embed(mini), second.embed(mini), third.embed(mini)]);
  assert.equal(loads.reduce((sum, count) => sum + count, 0), 1);
  await first.exit();
  assert.equal(await third.embed(mini), 0);
  assert.equal(await second.embed(bge), 1);
  assert.equal(await third.embed(bge), 0);
  assert.equal(await third.embed(mini), 1, "Switching must evict the previous session");
  await second.exit();
  await third.exit();
  await waitForWorkerExit(profile, 1);
  await assertSocketAbsent(profile);

  const restarted = client(t, profile);
  assert.equal(await restarted.embed(mini), 1);
  const rows = (await readFile(join(profile, "smart-mem.log"), "utf8")).trim().split("\n").map(JSON.parse);
  process.kill(rows.findLast(({ event }) => event === "worker.start").workerPid, "SIGKILL");
  await waitForWorkerExit(profile, 2);
  assert.equal(await restarted.embed(mini), 1, "The same client must reconnect after the worker dies");
  await restarted.exit();
  await waitForWorkerExit(profile, 3);
  await assertSocketAbsent(profile);
});

test("clients share the CUDA runtime and release its model before loading another device", async (t) => {
  const profile = await mkdtemp(join(tmpdir(), "smart-mem-worker-cuda-"));
  t.after(() => rm(profile, { recursive: true, force: true }));
  await cacheModel(profile, mini);
  const runtime = join(profile, "node_modules", "onnxruntime-node");
  const log = join(profile, "cuda-events");
  await mkdir(runtime, { recursive: true });
  await writeFile(join(runtime, "index.js"), `
    const {appendFileSync} = require("node:fs");
    const event = (kind) => appendFileSync(${JSON.stringify(log)}, kind + " " + process.pid + "\\n");
    exports.Tensor = class { constructor(type, data, dims) { Object.assign(this, {type, data, dims}); } };
    exports.InferenceSession = {create: async (_path, options) => {
      if (options.executionProviders[0] !== "cuda") throw new Error("Wrong execution provider");
      event("load");
      console.error("Native CUDA diagnostic fixture");
      return {
        inputNames: ["input_ids"],
        run: async ({input_ids}) => {
          event("run");
          const n = input_ids.dims[1];
          return {last_hidden_state: new exports.Tensor("float32", new Float32Array(n * 384).fill(1), [1, n, 384])};
        },
        release: async () => {
          event("release");
          require("node:fs").writeSync(2, "Native CUDA release diagnostic fixture\\n");
        },
      };
    }};`);
  const [first, second] = [client(t, profile), client(t, profile)];
  assert.equal(await first.embed(mini, "cuda"), 1);
  assert.equal(await second.embed(mini, "cuda"), 0);
  await first.exit();
  assert.equal(await second.embed(mini), 1);
  const events = (await readFile(log, "utf8")).trim().split("\n").map((line) => line.split(" "));
  assert.deepEqual(events.map(([kind]) => kind), ["load", "run", "run", "release"]);
  assert.equal(new Set(events.map(([, pid]) => pid)).size, 1);
  await second.exit();
  const diagnostics = (await waitForWorkerExit(profile, 1)).trim().split("\n").map(JSON.parse);
  await assertSocketAbsent(profile);
  const stderr = diagnostics.filter((entry) => entry.event === "worker.output" && entry.stream === "stderr").map(({ message }) => message).join("");
  assert.match(stderr, /Native CUDA diagnostic fixture/);
  assert.match(stderr, /Native CUDA release diagnostic fixture/, "Native stderr still drains after the launching Pi exits");
});

test("Windows worker pipes are profile-specific and work without a key", { skip: process.platform !== "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "psm-pipes-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const endpoint = await openWorkerEndpoint(root);
  assert.notEqual(endpoint.path, (await openWorkerEndpoint(join(root, "other"))).path);
  const server = await createWorkerServer(endpoint, (socket) => socket.end("ready"));
  await once(server.listen(endpoint.path), "listening");
  try {
    const socket = createConnection(endpoint.path);
    const chunks = [];
    for await (const chunk of socket) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).toString(), "ready");
    await assert.rejects(stat(join(root, "pipe.key")), { code: "ENOENT" });
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test("canceling a wait for the shared embedding lock does not run the queued action", async (t) => {
  const profile = await mkdtemp(join(tmpdir(), "smart-mem-worker-lock-"));
  t.after(() => rm(profile, { recursive: true, force: true }));
  const first = new SharedEmbeddings(profile);
  const second = new SharedEmbeddings(profile);
  let unlock;
  let locked;
  const ready = new Promise((resolve) => { locked = resolve; });
  const held = first.run(() => new Promise((resolve) => { unlock = resolve; locked(); }));
  await ready;
  try {
    await assert.rejects(second.run(async () => assert.fail("Canceled callback ran"), AbortSignal.timeout(100)), { name: "TimeoutError" });
  } finally { unlock(); await held; }
});
