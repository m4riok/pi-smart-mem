import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { embeddingDevice, models } from "../src/embeddings.ts";
import { detectTrigger } from "../src/review.ts";
import { chooseEmbeddingModel, enableWindowsGpu, openSettings, SettingsFile } from "../src/settings.ts";

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

test("setup picker shows but disables GPU models until the provider is available", async () => {
  const ui = picker({ unavailable: "Fixture GPU provider unavailable" });
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
  const guidance = stripTerminalSequences(ui.panel.render(110).join("\n"));
  assert.match(guidance, /Exit[\s\S]*Fixture GPU provider unavailable/);
  assert.match(guidance, process.platform === "win32" ? /DirectX 12/ : /install CUDA 12 \+ cuDNN 9 and ONNX Runtime Node/);
  ui.panel.handleInput(confirm);
  assert.equal(await ui.result, undefined);
});

test("missing DirectML runtime offers a separate download without changing the CPU default", async () => {
  const availability = { needsRuntime: true, unavailable: "DirectML not installed" };
  const cpu = picker(availability);
  cpu.panel.handleInput(confirm);
  assert.equal(await cpu.result, models[0]);

  const enable = picker(availability);
  for (const _model of models) enable.panel.handleInput(down);
  enable.panel.handleInput(confirm);
  assert.equal(await enable.result, enableWindowsGpu);
});

test("setup picker permits explicit GPU selection when ready and keeps CPU as the default", async () => {
  const cpu = picker({});
  cpu.panel.handleInput(confirm);
  assert.equal(await cpu.result, models[0]);
  assert.equal(embeddingDevice(await cpu.result, "cpu"), "cpu");

  const gpu = picker({});
  const firstGpu = models.findIndex(({ tier }) => tier === "cuda");
  for (let i = 0; i < firstGpu; i++) gpu.panel.handleInput(down);
  assert.doesNotMatch(stripTerminalSequences(gpu.panel.render(110).join("\n")), /To enable GPU embeddings/);
  gpu.panel.handleInput(confirm);
  assert.equal(await gpu.result, models[firstGpu]);
  assert.equal(embeddingDevice(await gpu.result, "cpu"), "cuda");
});

test("Exclude lists active and excluded phrases and applies only saved toggles", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "smart-mem-settings-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = new SettingsFile(dir);
  const initial = { include: ["My correction"], exclude: ["I   Told You", "old custom phrase"] };
  await file.update(initial);

  async function editExclusions(...picks) {
    const answers = ["Trigger phrases: Edit", "exclude", ...picks];
    await openSettings({ mode: "rpc", hasUI: true, ui: {
      select: async (title, options) => {
        if (title.startsWith("Toggle excluded phrases")) {
          assert.ok(options.includes("○ Trigger: remember this"));
          assert.ok(options.includes("○ Trigger: no"));
          assert.ok(options.includes("○ Suppressor: no thanks"));
        }
        const next = answers.shift();
        if (next !== undefined) assert.ok(options.includes(next), `${title}: missing ${next}`);
        return next;
      },
    } }, file, [], { model: () => undefined, databaseAccess: () => "Disabled" });
    assert.equal(answers.length, 0);
  }

  await editExclusions("✓ Trigger: i told you", "○ Trigger: My correction", "Cancel");
  assert.deepEqual((await file.read()).exclude, initial.exclude);
  await editExclusions("✓ Trigger: i told you", "○ Trigger: My correction", "Save");
  const saved = await file.read();
  assert.deepEqual(saved.exclude, ["old custom phrase", "my correction"]);
  assert.deepEqual(saved.include, initial.include);
  assert.equal(detectTrigger("I told you to use that.", saved), "correction");
  assert.equal(detectTrigger("My correction: use that.", saved), undefined);
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
