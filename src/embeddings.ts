import { createRequire } from "node:module";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Tokenizer } from "@huggingface/tokenizers";
import type * as Ort from "onnxruntime-web";
import type { Embedding } from "./memory-store.ts";
import { directMLRuntime, hasDirectMLRuntime, installDirectMLRuntime } from "./directml-runtime.ts";

// Keep the existing settings and worker wire value for the GPU device.
export type Device = "cpu" | "cuda";
export type GpuAvailability = { unavailable?: string; needsRuntime?: true };
export type ModelPreset = {
  model: string; dimensions: number; size: string; revision: string; tokens: number;
  tier: Device; pooling: "mean" | "cls" | "last"; queryPrefix?: string; passagePrefix?: string; output?: string;
  // The Qwen export is a decoder graph with empty KV-cache inputs for embedding.
  decoder?: { heads: number; headSize: number; weights: string };
};
const retrieval = "Represent this sentence for searching relevant passages: ";
export const models: readonly ModelPreset[] = [
  { model: "Xenova/all-MiniLM-L6-v2", dimensions: 384, size: "23 MB", revision: "751bff37182d3f1213fa05d7196b954e230abad9", tokens: 256, tier: "cpu", pooling: "mean" },
  { model: "Xenova/paraphrase-MiniLM-L3-v2", dimensions: 384, size: "17 MB", revision: "4b544e74dfc3256b2b56849ea5d7064fee1ac846", tokens: 128, tier: "cpu", pooling: "mean" },
  { model: "TaylorAI/bge-micro-v2", dimensions: 384, size: "17 MB", revision: "3edf6d7de0faa426b09780416fe61009f26ae589", tokens: 512, tier: "cpu", pooling: "mean" },
  { model: "Snowflake/snowflake-arctic-embed-xs", dimensions: 384, size: "23 MB", revision: "d8c86521100d3556476a063fc2342036d45c106f", tokens: 512, tier: "cpu", pooling: "cls", queryPrefix: retrieval },
  { model: "Xenova/bge-small-en-v1.5", dimensions: 384, size: "34 MB", revision: "ea104dacec62c0de699686887e3f920caeb4f3e3", tokens: 512, tier: "cpu", pooling: "cls", queryPrefix: retrieval },
  { model: "Xenova/bge-base-en-v1.5", dimensions: 768, size: "110 MB", revision: "4d6cd88e18e51a5e020c2c305726d76ada9c03cf", tokens: 512, tier: "cpu", pooling: "cls", queryPrefix: retrieval },
  { model: "Xenova/multilingual-e5-small", dimensions: 384, size: "118 MB", revision: "761b726dd34fb83930e26aab4e9ac3899aa1fa78", tokens: 512, tier: "cpu", pooling: "mean", queryPrefix: "query: ", passagePrefix: "passage: " },
  { model: "jinaai/jina-embeddings-v2-base-code", dimensions: 768, size: "321 MB", revision: "516f4baf13dec4ddddda8631e019b5737c8bc250", tokens: 8192, tier: "cuda", pooling: "mean" },
  { model: "Xenova/multilingual-e5-base", dimensions: 768, size: "555 MB", revision: "1ec9243030a27d1a115d5c340572074c125b58b2", tokens: 512, tier: "cuda", pooling: "mean", queryPrefix: "query: ", passagePrefix: "passage: " },
  { model: "Snowflake/snowflake-arctic-embed-m-v2.0", dimensions: 768, size: "613 MB", revision: "95c2741480856aa9666782eb4afe11959938017f", tokens: 8192, tier: "cuda", pooling: "cls", queryPrefix: "query: ", output: "token_embeddings" },
  { model: "Xenova/bge-large-en-v1.5", dimensions: 1024, size: "669 MB", revision: "dfeef6070b90658e1b391a6940efdb0925c1de6f", tokens: 512, tier: "cuda", pooling: "cls", queryPrefix: retrieval },
  { model: "Xenova/bge-m3", dimensions: 1024, size: "1.13 GB", revision: "4de13258303883538bd53b696b452bf8099f0858", tokens: 8192, tier: "cuda", pooling: "cls" },
  { model: "onnx-community/Qwen3-Embedding-0.6B-ONNX", dimensions: 1024, size: "1.20 GB", revision: "c25a394dd583836952667c12f008335071b3f43d", tokens: 32768, tier: "cuda", pooling: "last", queryPrefix: "Instruct: Given a search query, retrieve relevant saved notes that answer the query.\nQuery:", decoder: { heads: 8, headSize: 128, weights: "onnx/model_fp16.onnx_data" } },
];
export const embeddingDevice = (preset: ModelPreset | undefined, configured: Device): Device => preset?.tier === "cuda" ? "cuda" : configured;
const useDirectML = process.platform === "win32";
export const embeddingDeviceLabel = (device: Device) => device === "cpu" ? "CPU" : useDirectML ? "DirectML" : "CUDA";
export const gpuRequirements = useDirectML
  ? "Windows GPU embeddings use DirectML and require a DirectX 12-capable GPU with a working driver and the Visual C++ runtime."
  : "To enable GPU embeddings, use a compatible NVIDIA GPU and install CUDA 12 + cuDNN 9 and ONNX Runtime Node with the CUDA provider.";
const enableDirectMLHint = "Select Enable Windows GPU models in the embedding model picker first.";
export type Progress = (message: string) => void;
export type Runtime = Pick<typeof Ort, "Tensor" | "InferenceSession">;
type Encoder = { runtime: Runtime; tokenizer: Tokenizer; session: Ort.InferenceSession };
// ONNX opset 13: one float32 MatMul, two [1, 1] inputs a/b, one [1, 1] output c.
const gpuProbe = Buffer.from("CAc6XgoRCgFhCgFiEgFjIgZNYXRNdWwSCmN1ZGEtcHJvYmVaEwoBYRIOCgwIARIICgIIAQoCCAFaEwoBYhIOCgwIARIICgIIAQoCCAFiEwoBYxIOCgwIARIICgIIAQoCCAFCAhAN", "base64");

function gpuSessionOptions(probe = false): Ort.InferenceSession.SessionOptions {
  return useDirectML
    ? { executionProviders: ["dml"], enableMemPattern: false, executionMode: "sequential",
        ...(probe ? { extra: { session: { disable_cpu_ep_fallback: "1" } } } : {}) }
    : { executionProviders: ["cuda"] };
}

function encodeInputs({ runtime, tokenizer, session }: Encoder, preset: ModelPreset, text: string, query: boolean | undefined) {
  const prefix = (query ? preset.queryPrefix : preset.passagePrefix) ?? "";
  const input = tokenizer.encode(prefix + text, { add_special_tokens: true, return_token_type_ids: true });
  const length = Math.min(input.ids.length, preset.tokens);
  const ids: number[] = input.ids.slice(0, length);
  if (length < input.ids.length) ids[length - 1] = input.ids.at(-1)!; // Preserve the terminal special token.
  const features: Record<string, number[]> = {
    input_ids: ids, attention_mask: input.attention_mask.slice(0, length), token_type_ids: input.token_type_ids!.slice(0, length),
  };
  const decoder = preset.decoder;
  if (decoder) features.position_ids = ids.map((_, index) => index);
  const cache = decoder && new runtime.Tensor("float16", new Uint16Array(0), [1, decoder.heads, 0, decoder.headSize]);
  const tensors = Object.fromEntries(session.inputNames.map((name) => {
    if (cache && name.startsWith("past_key_values.")) return [name, cache];
    return [name, new runtime.Tensor("int64", BigInt64Array.from(features[name], BigInt), [1, length])];
  }));
  return { tensors, length };
}

export class LocalEmbeddings {
  #loaded?: { model: string; device: Device; encoder: Encoder };
  readonly #directory: string;
  constructor(directory: string) { this.#directory = directory; }

  #gpuRuntime(): Runtime {
    if (useDirectML) return directMLRuntime(this.#directory);
    // CUDA is installed by the user, not by Smart Mem.
    return createRequire(join(this.#directory, "package.json"))("onnxruntime-node");
  }

  async close(): Promise<void> {
    if (!this.#loaded) return;
    await this.#loaded.encoder.session.release();
    this.#loaded = undefined;
  }

  async gpuAvailability(download?: Progress, signal?: AbortSignal): Promise<GpuAvailability> {
    if (this.#loaded?.device === "cuda") return {};
    try {
      if (useDirectML && !await hasDirectMLRuntime(this.#directory)) {
        if (!download) return { needsRuntime: true, unavailable: enableDirectMLHint };
        await installDirectMLRuntime(this.#directory, download, signal);
      }
      const runtime = this.#gpuRuntime();
      await this.close();
      signal?.throwIfAborted();
      const session = await runtime.InferenceSession.create(gpuProbe, gpuSessionOptions(true));
      try {
        const a = new runtime.Tensor("float32", new Float32Array([2]), [1, 1]);
        if ((await session.run({ a, b: a })).c.data[0] !== 4) throw new Error(`${embeddingDeviceLabel("cuda")} probe returned an unexpected result`);
      } finally { await session.release(); }
      return {};
    } catch (error) {
      signal?.throwIfAborted();
      if (!useDirectML && (error as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND") return { unavailable: `Cannot load ONNX Runtime Node from ${this.#directory}.` };
      return { unavailable: error instanceof Error ? error.message : String(error) };
    }
  }

  async embed(preset: ModelPreset, device: Device, text: string, options: {
    query?: boolean; download?: Progress; signal?: AbortSignal;
  } = {}): Promise<Embedding> {
    options.signal?.throwIfAborted();
    if (preset.tier === "cuda" && device !== "cuda") throw new Error(`${preset.model} requires ${embeddingDeviceLabel("cuda")}`);
    if (this.#loaded?.model !== preset.model || this.#loaded.device !== device) {
      await this.close();
      const encoder = await this.#load(preset, device, options.download, options.signal);
      this.#loaded = { model: preset.model, device, encoder };
    }
    const { encoder } = this.#loaded;
    options.signal?.throwIfAborted();
    const { tensors, length } = encodeInputs(encoder, preset, text, options.query);
    const output = preset.output ?? "last_hidden_state";
    const hidden = (await encoder.session.run(tensors, [output]))[output];
    options.signal?.throwIfAborted();
    const { dimensions, pooling } = preset;
    if (hidden.type !== "float32" || hidden.dims[2] !== dimensions || hidden.dims[1] !== length) throw new Error(`Unexpected ${preset.model} embedding type or shape`);
    const values = new Array<number>(dimensions).fill(0);
    const data = hidden.data as Float32Array;
    const start = pooling === "last" ? length - 1 : 0;
    const rows = pooling === "mean" ? length : 1;
    for (let i = start; i < start + rows; i++) for (let j = 0; j < dimensions; j++) values[j] += data[i * dimensions + j] / rows;
    const norm = Math.hypot(...values);
    if (!Number.isFinite(norm) || norm === 0) throw new Error(`Invalid ${preset.model} embedding`);
    return { model: preset.model, values: values.map((value) => value / norm) };
  }

  async #load(preset: ModelPreset, device: Device, progress?: Progress, signal?: AbortSignal): Promise<Encoder> {
    try {
      let runtime: Runtime;
      if (device === "cpu") {
        const ort = await import("onnxruntime-web");
        ort.env.wasm.numThreads = 1;
        runtime = ort;
      } else {
        if (useDirectML && !await hasDirectMLRuntime(this.#directory)) throw new Error(enableDirectMLHint);
        runtime = this.#gpuRuntime();
      }
      const { Tokenizer } = await import("@huggingface/tokenizers");
      const load = (name: string) => this.#artifact(preset, name, progress, signal);
      const tokenizer = new Tokenizer(JSON.parse(await readFile(await load("tokenizer.json"), "utf8")), JSON.parse(await readFile(await load("tokenizer_config.json"), "utf8")));
      const path = await load(preset.tier === "cpu" ? "onnx/model_quantized.onnx" : "onnx/model_fp16.onnx");
      if (preset.decoder) await load(preset.decoder.weights);
      signal?.throwIfAborted();
      progress?.(`Loading ${preset.model} on ${embeddingDeviceLabel(device)}`);
      const session = device === "cpu"
        ? await runtime.InferenceSession.create(await readFile(path), { executionProviders: ["wasm"] })
        : await runtime.InferenceSession.create(path, gpuSessionOptions());
      return { runtime, tokenizer, session };
    } catch (cause) {
      throw new Error(device === "cuda"
        ? useDirectML
          ? `DirectML initialization failed for ${preset.model}. CPU was not selected automatically. ${String(cause)}`
          : `CUDA initialization failed for ${preset.model}. Install ONNX Runtime Node with the CUDA provider in ${this.#directory}. CPU was not selected automatically. ${String(cause)}`
        : `Could not load ${preset.model} on CPU: ${String(cause)}`, { cause });
    }
  }

  async #artifact(preset: ModelPreset, name: string, progress?: Progress, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    const path = join(this.#directory, "models", preset.model, preset.revision, name);
    try { await stat(path); return path; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (!progress) throw new Error(`Model file ${name} is missing; reselect the model in Smart Mem settings`);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temp = `${path}.${randomUUID()}.part`;
    const timeout = AbortSignal.timeout(10 * 60_000);
    const response = await fetch(`https://huggingface.co/${preset.model}/resolve/${preset.revision}/${name}`, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (!response.ok || !response.body) throw new Error(`Download of ${name} failed: HTTP ${response.status}`);
    const total = Number(response.headers.get("content-length"));
    let bytes = 0;
    let percent = -1;
    const meter = new Transform({ transform(chunk, _encoding, next) {
      bytes += chunk.length;
      const step = total ? Math.floor(bytes / total * 100) : Math.floor(bytes / 1_000_000);
      if (step !== percent) progress(total ? `Downloading ${name}: ${step}%` : `Downloading ${name}: ${step} MB`);
      percent = step;
      next(null, chunk);
    } });
    try {
      // Node fetch supplies a web stream; DOM and @types/node describe it differently.
      const body = response.body as unknown as import("node:stream/web").ReadableStream<Uint8Array>;
      await pipeline(Readable.fromWeb(body), meter, createWriteStream(temp, { mode: 0o600, flags: "wx" }));
      await rename(temp, path);
    } finally { await rm(temp, { force: true }); }
    return path;
  }
}
