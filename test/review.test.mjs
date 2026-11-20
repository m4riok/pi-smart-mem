import assert from "node:assert/strict";
import { test } from "node:test";
import { detectTrigger, injectionText } from "../src/review.ts";

const defaults = { include: [], exclude: [] };

test("correction and explicit save triggers are separate and overridable", () => {
  const cases = [
    ["We already discussed this.", "correction"],
    ["No, use pnpm here.", "correction"],
    ["Wrong. Run the local checks.", "correction"],
    ["Actually, keep this under src.", "correction"],
    ["We use no additional packages.", undefined],
    ["Actually looks great!", undefined],
    ["No worries", undefined],
    ["Stop here for now", undefined],
    ["The words 'no' and 'stop' are weak triggers.", undefined],
    ["Remember this: keep fixtures small. I told you before.", "explicit"],
    ["Please save this as a memory: always rerun tests.", "explicit"],
    ["Could you remember that I prefer terse reports?", "explicit"],
    ["For this repo, remember this: use pnpm.", "explicit"],
    ["Remember that I have an appointment next week.", undefined],
    ["Remember that I have an appointment next week. Save this to memory: use fixtures.", "explicit"],
    ["'Remember this' is an example.", undefined],
    ["Remember that you need to run the build next.", undefined],
    ["Remember to call me tomorrow.", undefined],
    ["The phrase \"remember this\" is an example.", undefined],
    ["`remember this`", undefined],
    ["> Save this as a memory: fixture text\nDo not use this example.", undefined],
  ];
  for (const [text, expected] of cases) assert.equal(detectTrigger(text, defaults), expected, text);
  assert.equal(detectTrigger("Change of rule: use the fixture", { ...defaults, include: ["change of rule"] }), "correction");
  assert.equal(detectTrigger("I told you to do that.", { ...defaults, exclude: ["I told you"] }), undefined);
});

test("injection takes longest whole-note prefix measured in UTF-8 bytes", () => {
  const limit = 32 * 1024;
  const full = "é".repeat(limit / 2);
  assert.deepEqual(injectionText([full]), { kept: [full], overflow: false });
  assert.deepEqual(injectionText([full, "a"]), { kept: [full], overflow: true });
  assert.deepEqual(injectionText([full + "!", "fits"]), { kept: [], overflow: true });
  assert.deepEqual(injectionText(["abc", "é", "x"], 7), { kept: ["abc", "é"], overflow: true });
});
