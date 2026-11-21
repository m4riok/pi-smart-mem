import type { Message } from "@earendil-works/pi-ai";
import type { Diagnostics } from "./diagnostics.ts";
import { Type } from "typebox";
import type { Embedding, Memory, MemoryStore, Scope } from "./memory-store.ts";
import { operation, toolNames } from "./memory-tools.ts";
import { runModel, type ModelContext } from "./review.ts";
import { prompt, type Settings } from "./settings.ts";

type MaintenanceFailure = { scope: Scope; noteId: string; attempt: 1 | 2; reason: string };
export const maintenanceShortlistSize = 8;
export type MaintenanceResult = { changes: number; skipped: number };
type Options = {
  kind: "link" | "consolidate"; scopes: Scope[]; automatic?: boolean; store: MemoryStore; ctx: ModelContext;
  messages: Message[]; settings: Settings; embed: (text: string, signal?: AbortSignal) => Promise<Embedding>;
  progress: (text: string) => void; signal?: AbortSignal; onFailure?: (failure: MaintenanceFailure) => void;
  diagnostics?: Pick<Diagnostics, "debug">;
};

class MissingDecision extends Error {}

async function judgeNote(options: Options, id: string, attempt: 1 | 2, retryDecision: boolean, result: MaintenanceResult) {
  const { store, kind, settings, ctx, messages, embed, signal } = options;
  const source = await store.read(id);
  if (!source) return;
  const candidates = await store.candidates(source, maintenanceShortlistSize, kind === "consolidate");
  if (kind === "link" && candidates.length === 0) { await store.markReviewed(source, signal); return; }
  const allowed = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const payload = { source, candidates };
  const input = JSON.stringify(payload);
  const consolidate = kind === "consolidate";
  const task = consolidate
    ? [prompt(settings, "consolidate"), retryDecision && prompt(settings, "consolidateRetry")].filter(Boolean).join("\n\n")
    : [prompt(settings, "precedence"), prompt(settings, "link"), input,
      retryDecision && `Call ${toolNames.selectLinks} with selected IDs, or {"ids":[]} if none.`].filter(Boolean).join("\n\n");
  const modelContext = consolidate ? { ...ctx, getSystemPrompt: () => "" } : ctx;
  const exchange: Message[] = consolidate ? [{ role: "user", content: input, timestamp: 0 }] : messages;
  let judged = false;
  const tool = kind === "link"
    ? operation(toolNames.selectLinks, "Submit selected target IDs, or an empty list.", Type.Object({ ids: Type.Array(Type.String()) }), async ({ ids }) => {
      if (ids.some((id) => !allowed.has(id))) throw new Error("Target not shortlisted");
      for (const id of new Set(ids)) {
        signal?.throwIfAborted();
        if (await store.link(source.id, id, signal)) result.changes++;
      }
      judged = true;
      return { value: { changes: result.changes } };
    })
    : operation(toolNames.consolidateNote, "Submit one decision for the current source. ids contains only IDs from the current candidates array, never the source ID. Use ids: [] without text for no change. Supply complete replacement text for shortening or merging.", Type.Object({ text: Type.Optional(Type.String({ minLength: 1 })), ids: Type.Array(Type.String()) }), async ({ text, ids }) => {
      const removed: Memory[] = [...new Set(ids)].map((id) => {
        const candidate = allowed.get(id);
        if (!candidate) throw new Error("Memory not shortlisted");
        return candidate;
      });
      if (removed.length && !text) throw new Error("A merge needs replacement text");
      if (text && (text !== source.text || removed.length) && await store.merge(source, removed, text, await embed(text, signal), signal)) result.changes++;
      judged = true;
      return { value: { changes: result.changes } };
    });
  const debug = consolidate && settings.debugLogging ? options.diagnostics : undefined;
  const trace = { noteId: source.id, scope: source.scope, attempt };
  void debug?.debug("consolidation.request", { ...trace, input: payload });
  const report = await runModel(modelContext, exchange, task, [tool], {
    settings, signal, done: (call) => judged || call.isError,
    onResponse: debug && (({ content, stopReason, errorMessage }) => {
      void debug.debug("consolidation.response", { ...trace, content, stopReason, errorMessage });
    }),
  });
  signal?.throwIfAborted();
  const failure = report.calls.find(({ isError }) => isError);
  if (failure) {
    // Pi's validation error appends the full tool arguments. For consolidation,
    // keep those in the opt-in reply trace, not in the ordinary failure log.
    const error = String(failure.result);
    const reason = consolidate ? error.split("\n\nReceived arguments:\n", 1)[0] : error;
    throw new Error(`${failure.name}: ${reason}`);
  }
  if (!judged) throw new MissingDecision(`No ${kind} decision`);
  if (kind === "link") await store.markReviewed(source, signal);
}

export async function maintain(options: Options): Promise<MaintenanceResult> {
  const { kind, scopes, automatic, store, settings, progress, signal, onFailure } = options;
  const result = { changes: 0, skipped: 0 };
  for (const scope of scopes) {
    signal?.throwIfAborted();
    const notes = await store.list(scope, automatic);
    if (automatic && notes.length < settings.linkThreshold) continue;
    for (const [i, note] of notes.entries()) {
      signal?.throwIfAborted();
      const status = `${kind === "link" ? "Linking" : "Consolidating"} ${scope} memories: ${i + 1}/${notes.length}`;
      progress(status);
      let retryDecision = false;
      for (const attempt of [1, 2] as const) {
        try {
          await judgeNote(options, note.id, attempt, retryDecision, result);
          break;
        } catch (error) {
          signal?.throwIfAborted();
          onFailure?.({ scope, noteId: note.id, attempt, reason: String(error) });
          if (attempt === 1) {
            retryDecision = error instanceof MissingDecision;
            progress(`${status} · retrying`);
          } else result.skipped++;
        }
      }
    }
  }
  return result;
}
