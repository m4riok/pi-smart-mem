import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { withFileLock } from "./file-lock.ts";

const maxBytes = 5 * 1024 * 1024;
const archives = 3;
type Level = "info" | "warning" | "error";
type Fields = Record<string, string | number | boolean | undefined>;
const ignoreMissing = (error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; };

export class Diagnostics {
  readonly #directory: string;
  readonly #path: string;
  readonly #source: string;
  readonly #onError: (error: unknown) => void;
  #pending = Promise.resolve();
  #created = false;
  #warned = false;

  constructor(directory: string, source: string, onError: (error: unknown) => void) {
    this.#directory = directory;
    this.#path = join(directory, "smart-mem.log");
    this.#source = source;
    this.#onError = onError;
  }

  write(event: string, fields: Fields = {}, level: Level = "info"): Promise<void> {
    return this.#write(event, fields, level, (_key, value) => typeof value === "string" ? value.slice(0, 8192) : value);
  }

  debug(event: string, fields: Record<string, unknown>): Promise<void> {
    return this.#write(event, fields, "debug");
  }

  #write(event: string, fields: Record<string, unknown>, level: Level | "debug", replacer?: (key: string, value: unknown) => unknown) {
    const entry = JSON.stringify({ time: new Date().toISOString(), pid: process.pid, source: this.#source, level, event, ...fields }, replacer) + "\n";
    this.#pending = this.#pending.then(async () => {
      if (!this.#created) {
        await mkdir(this.#directory, { recursive: true, mode: 0o700 });
        this.#created = true;
      }
      await withFileLock(`${this.#path}.lock`, async () => {
        const size = await stat(this.#path).then(({ size }) => size, ignoreMissing);
        if (size && size + Buffer.byteLength(entry) > maxBytes) {
          for (let i = archives - 1; i > 0; i--) {
            await rename(`${this.#path}.${i}`, `${this.#path}.${i + 1}`).catch(ignoreMissing);
          }
          await rename(this.#path, `${this.#path}.1`);
        }
        await appendFile(this.#path, entry, { mode: 0o600 });
      });
    }).catch((error) => {
      if (this.#warned) return;
      this.#warned = true;
      this.#onError(error);
    });
    return this.#pending;
  }
}
