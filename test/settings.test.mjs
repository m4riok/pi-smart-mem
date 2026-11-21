import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { embeddingDevice, models } from "../src/embeddings.ts";
import { chooseEmbeddingModel, SettingsFile } from "../src/settings.ts";

function picker(unavailable) {
  let panel;
  let closed = false;
  const result = chooseEmbeddingModel({ mode: "tui", ui: {
    custom: (build) => new Promise((resolve) => {
      panel = build({ requestRender() {} }, {
        fg: (color, text) => color === "muted" ? `\x1b[90m${text}\x1b[39m` : text,
      }, undefined, (selection) => { closed = true; resolve(selection); });
    }),
  } }, undefined, unavailable);
  return { result, panel, get closed() { return closed; } };
}

const down = "\x1b[B";
const confirm = "\r";

test("setup picker shows but disables every GPU model without CUDA, with setup guidance below Exit", async () => {
  const ui = picker("Unable to load CUDA provider");
  assert.match(stripTerminalSequences(ui.panel.render(110).join("\n")), /all-MiniLM-L6-v2.*CPU/);
  for (const model of models) {
    const rendered = ui.panel.render(110).join("\n");
    assert.ok(stripTerminalSequences(rendered).includes(model.model), `Missing model row: ${model.model}`);
    if (model.tier === "cuda") {
      assert.ok(rendered.includes(`\x1b[90m${model.model}\x1b[39m`));
      ui.panel.handleInput(confirm);
      assert.equal(ui.closed, false);
    }
    ui.panel.handleInput(down);
  }
  assert.match(stripTerminalSequences(ui.panel.render(110).join("\n")), /Exit[\s\S]*install CUDA 12 \+ cuDNN 9 and ONNX Runtime Node/);
  ui.panel.handleInput(confirm);
  assert.equal(await ui.result, undefined);
});

test("setup picker permits explicit GPU selection when CUDA is ready and keeps CPU as the default", async () => {
  const cpu = picker(undefined);
  cpu.panel.handleInput(confirm);
  assert.equal(await cpu.result, models[0]);
  assert.equal(embeddingDevice(await cpu.result, "cpu"), "cpu");

  const gpu = picker(undefined);
  const firstGpu = models.findIndex(({ tier }) => tier === "cuda");
  for (let i = 0; i < firstGpu; i++) gpu.panel.handleInput(down);
  assert.doesNotMatch(stripTerminalSequences(gpu.panel.render(110).join("\n")), /To enable GPU embeddings/);
  gpu.panel.handleInput(confirm);
  assert.equal(await gpu.result, models[firstGpu]);
  assert.equal(embeddingDevice(await gpu.result, "cpu"), "cuda");
});

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
