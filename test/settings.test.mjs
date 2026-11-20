import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SettingsFile } from "../src/settings.ts";

test("concurrent settings writers preserve sibling settings and prompt edits", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "smart-mem-settings-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const first = new SettingsFile(dir);
  const second = new SettingsFile(dir);
  await first.update({ prompts: { recall: "old recall", write: "old write" } });
  await Promise.all([
    first.update({ initialMessages: 12, prompts: { recall: "new recall" } }),
    second.update({ autoLink: true, prompts: { write: undefined, injection: "new injection" } }),
  ]);
  const result = await second.read();
  assert.equal(result.initialMessages, 12);
  assert.equal(result.autoLink, true);
  assert.deepEqual(result.prompts, { recall: "new recall", injection: "new injection" });
});
