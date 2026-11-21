import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryPanel } from "../src/memory-panel.ts";

function fixture(t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const panel = new MemoryPanel();
  let widget;
  let renders = 0;
  panel.mount({ setWidget(_key, build) {
    widget = build?.({ requestRender: () => { renders++; } }, { fg: (_color, value) => value });
  } }, true);
  t.after(() => panel.dispose());
  return { panel, render: () => widget.render(100).join("\n"), renders: () => renders };
}

test("informational result expires without clearing the Memory header or running work", (t) => {
  const { panel, render, renders } = fixture(t);
  panel.begin("Consolidating memories");
  panel.notice("Injected 1 saved memory");
  t.mock.timers.tick(4999);
  assert.match(render(), /Injected 1 saved memory/);
  const before = renders();
  t.mock.timers.tick(1);
  assert.doesNotMatch(render(), /Injected 1 saved memory/);
  assert.match(render(), /🧠 Memory · Active.*\n.*Consolidating memories/);
  assert.equal(renders(), before + 1);
});

test("activities can override expiry and older timers cannot clear a newer warning", (t) => {
  const { panel, render } = fixture(t);
  panel.begin("Linking").finish("Created 1 memory link", "info", "Scope: global", 2000);
  t.mock.timers.tick(1999);
  assert.match(render(), /Created 1 memory link/);
  t.mock.timers.tick(1);
  assert.doesNotMatch(render(), /Created 1 memory link/);
  panel.notice("Injected 1 saved memory");
  panel.notice("Memory injection exceeded 32 KiB", "warning");
  t.mock.timers.tick(60_000);
  assert.match(render(), /Memory injection exceeded 32 KiB/);
});
