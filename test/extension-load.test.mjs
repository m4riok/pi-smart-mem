import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));

test("Pi discovers and loads the package extension", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-smart-mem-test-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));

  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: join(cwd, "agent"),
    settingsManager: SettingsManager.inMemory(),
    additionalExtensionPaths: [packageRoot],
    noContextFiles: true,
  });
  await loader.reload();

  const { extensions, errors } = loader.getExtensions();
  assert.deepEqual(errors, []);
  assert.deepEqual(extensions.map((extension) => extension.path), [join(packageRoot, "index.ts")]);
});
