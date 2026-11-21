import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { Diagnostics } from "../src/diagnostics.ts";

const size = 5 * 1024 * 1024;
const run = promisify(execFile);

test("independent diagnostic writers share rotation without losing records; retain three archives", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "smart-mem-log-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "smart-mem.log");
  await writeFile(path, "old file\n", { mode: 0o600 });
  await truncate(path, size);
  const code = `
    import { Diagnostics } from ${JSON.stringify(new URL("../src/diagnostics.ts", import.meta.url).href)};
    const log = new Diagnostics(process.argv[1], process.argv[2], (error) => { throw error; });
    await Promise.all([log.write("start"), log.write("finish")]);
  `;
  await Promise.all(["first", "second", "third"].map((source) => run(process.execPath, ["--input-type=module", "--eval", code, directory, source])));
  const rows = (await readFile(path, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(rows.length, 6);
  assert.equal(new Set(rows.map(({ pid }) => pid)).size, 3);
  for (const source of ["first", "second", "third"]) assert.deepEqual(rows.filter((row) => row.source === source).map(({ event }) => event), ["start", "finish"]);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await stat(`${path}.1`)).size, size);

  const errors = [];
  const log = new Diagnostics(directory, "test", (error) => errors.push(error));
  for (let round = 1; round <= 3; round++) {
    await truncate(path, size);
    await log.write("rotation", { round });
  }
  const names = (await readdir(directory)).filter((name) => /^smart-mem\.log\.\d+$/.test(name)).sort();
  assert.deepEqual(names, ["smart-mem.log.1", "smart-mem.log.2", "smart-mem.log.3"]);
  assert.deepEqual(names.map(() => size), await Promise.all(names.map(async (name) => (await stat(join(directory, name))).size)));
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")).round, 3);
  assert.deepEqual(errors, []);
});
