import { traceDecision, type MaintenanceDiagnostics } from "./maintenance-trace.ts";
import { Type } from "typebox";
import type { Embedding, Memory, MemoryStore, Scope } from "./memory-store.ts";
import { operation, toolNames } from "./memory-tools.ts";
import { runModel, type ModelContext } from "./review.ts";
import { minConsolidationSavings, prompt, type Settings } from "./settings.ts";

type MaintenanceFailure = { scope: Scope; noteId: string; attempt: 1 | 2; reason: string };
export const maintenanceShortlistSize = 8;
export type MaintenanceResult = { changes: number; skipped: number };
type Options = {
  scopes: Scope[]; full: boolean; store: MemoryStore; ctx: ModelContext;
  settings: Settings; embed: (text: string, signal?: AbortSignal) => Promise<Embedding>;
  progress: (text: string) => void; signal?: AbortSignal; onFailure?: (failure: MaintenanceFailure) => void;
  diagnostics?: MaintenanceDiagnostics;
};

class MissingDecision extends Error {}

function savesEnough(source: string, replacement: string): boolean {
  const original = Array.from(source).length;
  const saved = original - Array.from(replacement).length;
  return saved >= minConsolidationSavings.characters && saved * 100 >= original * minConsolidationSavings.percent;
}

async function judgeNote(options: Options, id: string, attempt: 1 | 2, retryDecision: boolean, result: MaintenanceResult) {
  const { store, settings, ctx, embed, signal } = options;
  const source = await store.read(id);
  if (!source) return;
  if (options.full && attempt === 1) await store.markConsolidated(source, false, signal);
  const candidates = await store.candidates(source, maintenanceShortlistSize, true);
  const allowed = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const payload = { source, candidates };
  const input = JSON.stringify(payload);
  const task = [prompt(settings, "consolidate"), retryDecision && prompt(settings, "consolidateRetry")].filter(Boolean).join("\n\n");
  const modelContext = { ...ctx, getSystemPrompt: () => "" };
  let judged = false;
  const tool = operation(toolNames.consolidateNote, "Submit one decision for the current source. ids contains only IDs from the current candidates array, never the source ID. Use ids: [] without text for no change. Supply complete replacement text for shortening or merging.", Type.Object({ text: Type.Optional(Type.String({ minLength: 1 })), ids: Type.Array(Type.String()) }), async ({ text, ids }) => {
    const removed: Memory[] = [...new Set(ids)].map((id) => {
      const candidate = allowed.get(id);
      if (!candidate) throw new Error("Memory not shortlisted");
      return candidate;
    });
    if (removed.length && !text) throw new Error("A merge needs replacement text");
    if (text && (removed.length || savesEnough(source.text, text))) {
      if (await store.merge(source, removed, text, await embed(text, signal), signal, true)) result.changes++;
    } else await store.markConsolidated(source, true, signal);
    judged = true;
    return { value: { changes: result.changes } };
  });
  const debug = settings.debugLogging ? options.diagnostics : undefined;
  const trace = traceDecision(debug, "consolidation", { noteId: source.id, scope: source.scope, attempt }, payload);
  const report = await runModel(modelContext, [{ role: "user", content: input, timestamp: 0 }], task, [tool], {
    settings, signal, done: (call) => judged || call.isError, onResponse: trace?.onResponse,
  });
  signal?.throwIfAborted();
  const failure = report.calls.find(({ isError }) => isError);
  if (failure) {
    // Pi's validation error appends the full tool arguments. For consolidation,
    // keep those in the opt-in reply trace, not in the ordinary failure log.
    throw new Error(`${failure.name}: ${String(failure.result).split("\n\nReceived arguments:\n", 1)[0]}`);
  }
  if (!judged) throw new MissingDecision("No consolidate decision");
}

export async function consolidateMemories(options: Options): Promise<MaintenanceResult> {
  const { scopes, full, store, progress, signal, onFailure } = options;
  const result = { changes: 0, skipped: 0 };
  for (const scope of scopes) {
    signal?.throwIfAborted();
    const notes = await store.list(scope, full ? undefined : "unconsolidated");
    for (const [i, note] of notes.entries()) {
      signal?.throwIfAborted();
      const status = `Consolidating ${scope} memories: ${i + 1}/${notes.length}`;
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
