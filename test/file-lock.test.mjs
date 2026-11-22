import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { withFileLock } from "../src/file-lock.ts";

const moduleUrl = new URL("../src/file-lock.ts", import.meta.url).href;

test("file lock excludes independent processes, cancels waiting, and releases on process death", { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "psm-lock-"));
  const path = join(root, "settings.lock");
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { withFileLock } from ${JSON.stringify(moduleUrl)};
    await withFileLock(process.argv[1], async () => {
      process.stdout.write("ready");
      process.stdin.resume();
      await new Promise(() => {});
    });
  `, path], { stdio: ["pipe", "pipe", "inherit"] });
  const exit = once(child, "close");
  try {
    const [ready] = await Promise.race([once(child.stdout, "data"), exit.then(() => assert.fail("Lock owner exited before acquisition"))]);
    assert.equal(ready.toString(), "ready");
    await assert.rejects(withFileLock(path, async () => assert.fail("Contended lock admitted a waiter"), AbortSignal.timeout(100)), { name: "TimeoutError" });
    child.kill("SIGKILL");
    await exit;
    assert.equal(await withFileLock(path, async () => "reacquired", AbortSignal.timeout(5000)), "reacquired");
  } finally {
    child.kill("SIGKILL");
    try { await exit; }
    finally { await rm(root, { recursive: true, force: true }); }
  }
});
