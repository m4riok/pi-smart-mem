import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { Embedding, Memory, MemoryStore, Scope } from "./memory-store.ts";
import { operation } from "./memory-tools.ts";
import { runModel } from "./review.ts";
import { prompt, type Settings } from "./settings.ts";

export async function maintain(options: {
  kind: "link" | "consolidate"; scopes: Scope[]; automatic?: boolean; store: MemoryStore; ctx: ExtensionContext;
  messages: Message[]; settings: Settings; embed: (text: string, signal?: AbortSignal) => Promise<Embedding>;
  progress: (text: string) => void; signal?: AbortSignal;
}) {
  const { kind, scopes, automatic, store, ctx, settings, embed, progress, signal } = options;
  let changes = 0;
  for (const scope of scopes) {
    const notes = await store.list(scope, automatic);
    if (automatic && notes.length < settings.linkThreshold) continue;
    for (const [i, note] of notes.entries()) {
      signal?.throwIfAborted();
      const source = await store.read(note.id);
      if (!source) continue;
      progress(`${kind === "link" ? "Linking" : "Consolidating"} ${scope} memories: ${i + 1}/${notes.length}`);
      const candidates = await store.candidates(source, 8, kind === "consolidate");
      if (kind === "link" && candidates.length === 0) { await store.markReviewed(source); continue; }
      const allowed = new Map(candidates.map((candidate) => [candidate.id, candidate]));
      const task = [prompt(settings, "precedence"), prompt(settings, kind), JSON.stringify({ source, candidates })].join("\n\n");
      let judged = false;
      const tool = kind === "link"
        ? operation("select_links", "Submit selected target IDs, or an empty list.", Type.Object({ ids: Type.Array(Type.String()) }), async ({ ids }) => {
          if (ids.some((id) => !allowed.has(id))) throw new Error("Target not shortlisted");
          for (const id of new Set(ids)) {
            signal?.throwIfAborted();
            if (await store.link(source.id, id)) changes++;
          }
          judged = true;
          return { value: { changes } };
        })
        : operation("consolidate_note", "Submit replacement text and IDs to merge, or omit text to keep the note unchanged.", Type.Object({ text: Type.Optional(Type.String({ minLength: 1 })), ids: Type.Array(Type.String()) }), async ({ text, ids }) => {
          const removed: Memory[] = [...new Set(ids)].map((id) => {
            const candidate = allowed.get(id);
            if (!candidate) throw new Error("Memory not shortlisted");
            return candidate;
          });
          if (removed.length && !text) throw new Error("A merge needs replacement text");
          if (text && (text !== source.text || removed.length) && await store.merge(source, removed, text, await embed(text, signal), signal)) changes++;
          judged = true;
          return { value: { changes } };
        });
      const report = await runModel(ctx, options.messages, task, [tool], { settings, signal, done: () => judged });
      if (!judged) throw new Error(`No ${kind} decision for ${source.id}: ${report.rationale ?? "no response"}`);
      if (kind === "link") await store.markReviewed(source);
    }
  }
  return changes;
}
