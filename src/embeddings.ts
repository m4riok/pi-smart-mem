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

export const models = [
  { model: "Xenova/all-MiniLM-L6-v2", dimensions: 384, size: "23 MB", revision: "751bff37182d3f1213fa05d7196b954e230abad9", queryPrefix: "", tokens: 256 },
  { model: "Xenova/bge-base-en-v1.5", dimensions: 768, size: "110 MB", revision: "4d6cd88e18e51a5e020c2c305726d76ada9c03cf", queryPrefix: "Represent this sentence for searching relevant passages: ", tokens: 512 },
] as const;
export type Device = "cpu" | "cuda";
export type ModelPreset = typeof models[number];
export type Progress = (message: string) => void;
type Runtime = Pick<typeof Ort, "Tensor" | "InferenceSession">;
type Encoder = { runtime: Runtime; tokenizer: Tokenizer; session: Ort.InferenceSession };

export class LocalEmbeddings {
  readonly #encoders = new Map<string, Promise<Encoder>>();
  readonly #directory: string;
  constructor(directory: string) { this.#directory = directory; }

  async embed(preset: ModelPreset, device: Device, text: string, options: {
    query?: boolean; download?: Progress; signal?: AbortSignal;
  } = {}): Promise<Embedding> {
    options.signal?.throwIfAborted();
    const key = `${preset.model}:${device}`;
    let pending = this.#encoders.get(key);
    if (!pending) {
      pending = this.#load(preset, device, options.download);
      this.#encoders.set(key, pending);
      pending.catch(() => { if (this.#encoders.get(key) === pending) this.#encoders.delete(key); });
    }
    const { runtime, tokenizer, session } = await pending;
    options.signal?.throwIfAborted();
    const input = tokenizer.encode((options.query ? preset.queryPrefix : "") + text, { add_special_tokens: true, return_token_type_ids: true });
    const length = Math.min(input.ids.length, preset.tokens);
    const ids = input.ids.slice(0, length);
    if (length < input.ids.length) ids[length - 1] = input.ids.at(-1)!; // Preserve BERT's terminal [SEP].
    const features: Record<string, number[]> = { input_ids: ids, attention_mask: input.attention_mask.slice(0, length), token_type_ids: input.token_type_ids!.slice(0, length) };
    const tensors = Object.fromEntries(session.inputNames.map((name) => [name, new runtime.Tensor("int64", BigInt64Array.from(features[name], BigInt), [1, length])]));
    const { last_hidden_state: hidden } = await session.run(tensors);
    options.signal?.throwIfAborted();
    const { dimensions } = preset;
    if (hidden.dims[2] !== dimensions || hidden.dims[1] !== length) throw new Error(`Unexpected ${preset.model} embedding shape`);
    const values = new Array<number>(dimensions).fill(0);
    const data = hidden.data as Float32Array;
    const rows = preset.queryPrefix ? 1 : length; // BGE CLS vs. MiniLM mean pooling.
    for (let i = 0; i < rows; i++) for (let j = 0; j < dimensions; j++) values[j] += data[i * dimensions + j] / rows;
    const norm = Math.hypot(...values);
    if (!Number.isFinite(norm) || norm === 0) throw new Error(`Invalid ${preset.model} embedding`);
    return { model: preset.model, values: values.map((value) => value / norm) };
  }

  async #load(preset: ModelPreset, device: Device, progress?: Progress): Promise<Encoder> {
    try {
      let runtime: Runtime;
      if (device === "cpu") {
        const ort = await import("onnxruntime-web");
        ort.env.wasm.numThreads = 1;
        runtime = ort;
      } else {
        // Package is installed by the user in Smart Mem's profile, never by Smart Mem.
        runtime = createRequire(join(this.#directory, "package.json"))("onnxruntime-node");
      }
      const { Tokenizer } = await import("@huggingface/tokenizers");
      const load = (name: string) => this.#artifact(preset, name, progress);
      const tokenizer = new Tokenizer(JSON.parse(await readFile(await load("tokenizer.json"), "utf8")), JSON.parse(await readFile(await load("tokenizer_config.json"), "utf8")));
      const path = await load("onnx/model_quantized.onnx");
      progress?.(`Loading ${preset.model} on ${device.toUpperCase()}`);
      const session = await runtime.InferenceSession.create(await readFile(path), {
        executionProviders: [device === "cpu" ? "wasm" : "cuda"],
      });
      return { runtime, tokenizer, session };
    } catch (cause) {
      throw new Error(device === "cuda"
        ? `CUDA initialization failed for ${preset.model}. Install ONNX Runtime Node with the CUDA provider in ${this.#directory}. CPU was not selected automatically. ${String(cause)}`
        : `Could not load ${preset.model} on CPU: ${String(cause)}`, { cause });
    }
  }

  async #artifact(preset: ModelPreset, name: string, progress?: Progress): Promise<string> {
    const path = join(this.#directory, "models", preset.model, preset.revision, name);
    try { await stat(path); return path; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (!progress) throw new Error(`Model file ${name} is missing; reselect the model in Smart Mem settings`);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temp = `${path}.${randomUUID()}.part`;
    const response = await fetch(`https://huggingface.co/${preset.model}/resolve/${preset.revision}/${name}`, { signal: AbortSignal.timeout(10 * 60_000) });
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
