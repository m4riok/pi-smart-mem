import assert from "node:assert/strict";
import { test } from "node:test";
import { planLinkBatches } from "../src/linking.ts";

const pair = (a, b) => [a.id, b.id].sort().join(":");
const notes = Array.from({ length: 100 }, (_, i) => ({
  id: `n${i}`, text: "x".repeat(1 + (i * 97) % 300), scope: i < 71 ? "project" : "global",
}));

function assertCoverage(notes, sources, fit) {
  const pending = new Set(sources.map(({ id }) => id));
  const batches = planLinkBatches(notes, pending, fit);
  const expected = notes.flatMap((a, i) => notes.slice(i + 1)
    .filter((b) => pending.has(a.id) || pending.has(b.id)).map((b) => pair(a, b)));
  const covered = [];
  for (const { left, right, sourceIds, oversized } of batches) {
    assert.equal(oversized, undefined);
    const eligible = new Set(sourceIds);
    assert.deepEqual(eligible, new Set([...left, ...(right ?? [])].filter((n) => pending.has(n.id)).map(({ id }) => id)));
    for (const [i, a] of left.entries()) {
      for (const b of right ?? left.slice(i + 1)) {
        if (eligible.has(a.id) || eligible.has(b.id)) covered.push(pair(a, b));
      }
    }
  }
  assert.deepEqual(covered.sort(), expected.sort());
  return batches;
}

test("first pass shows all unordered pairs once, even when split into overlapping blocks", () => {
  const global = notes.map((note) => ({ ...note, scope: "global" }));
  assert.equal(assertCoverage(global, global, () => true).length, 1);
  const capped = ({ notes, otherNotes = [] }) => notes.length + otherNotes.length <= 50;
  assert.ok(assertCoverage(global, global, capped).length > 1);
});

test("uneven blocks cover pending project sources against checked and global targets", () => {
  const pending = [notes[1], notes[33], notes[62]];
  const fit = (payload) => JSON.stringify(payload).length <= 1500;
  const batches = assertCoverage(notes, pending, fit);
  assert.ok(batches.length > 1);
  assert.ok(batches.some(({ left, right = [] }) => [...left, ...right].some(({ scope }) => scope === "global")));
  assert.deepEqual(planLinkBatches(notes, new Set(), fit), []);
  assert.deepEqual(planLinkBatches([notes[0]], new Set([notes[0].id]), fit), []);
});

test("an oversized pair is identified rather than dropped or split into unjudgeable notes", () => {
  const pending = new Set([notes[0].id]);
  const batches = planLinkBatches(notes.slice(0, 3), pending, ({ notes, otherNotes = [] }) =>
    [...notes, ...otherNotes].every(({ id }) => id !== "n1"));
  assert.equal(batches.length, 2);
  assert.equal(batches[0].oversized, true);
  assert.equal(batches[1].oversized, undefined);
});
