import assert from "node:assert/strict";
import { test } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { detectTrigger, injectionText, runModel } from "../src/review.ts";

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

test("model runs end with a user turn when the transcript ends with an assistant reply", async () => {
  const sent = [];
  const ctx = { model: { id: "fixture", reasoning: false }, thinkingLevel: "off", getSystemPrompt: () => "Base prompt", modelRegistry: {
    streamSimple(_model, { messages }) {
      sent.push([...messages]);
      return { result: async () => fauxAssistantMessage("Done") };
    },
  } };
  const user = { role: "user", content: "Question", timestamp: 1 };
  const reply = fauxAssistantMessage("Answer");
  const leading = { role: "system", content: "Base prompt", timestamp: 0 };
  const update = { role: "system", content: "Later instruction", timestamp: 3 };
  const run = (messages) => runModel(ctx, messages, "Task", [], { settings: defaults });
  const roles = () => sent.at(-1).map(({ role }) => role);

  await run([user, reply]);
  assert.deepEqual(roles(), ["system", "user", "assistant", "user"]);
  assert.match(sent.at(-1).at(-1).content, /task/i);
  await run([leading, user, reply, update]);
  assert.deepEqual(roles(), ["system", "user", "assistant", "system", "user"]);
  const toolResult = { role: "toolResult", toolCallId: "call", toolName: "lookup", content: [{ type: "text", text: "{}" }], isError: false, timestamp: 4 };
  const call = fauxAssistantMessage(fauxToolCall("lookup", {}, { id: "call" }), { stopReason: "toolUse" });
  await run([user, call, toolResult]);
  assert.deepEqual(roles(), ["system", "user", "assistant", "toolResult"]);
  await run([user]);
  assert.deepEqual(roles(), ["system", "user"]);
  assert.deepEqual(sent.at(-1)[1], user);
});
