import { Type } from "typebox";
import type { Memory, MemoryStore, Scope } from "./memory-store.ts";
import { memoryKind, operation, toolNames, type Operation } from "./memory-tools.ts";
import type { MaintenanceResult } from "./maintenance.ts";
import { traceDecision, type MaintenanceDiagnostics } from "./maintenance-trace.ts";
import { runModel, type ModelContext } from "./review.ts";
import { prompt, type Settings } from "./settings.ts";

const batchSize = 20;
const id = Type.String({ minLength: 1 });
export type BatchOptions = {
  scopes: Scope[]; ctx: ModelContext; store: MemoryStore; settings: Settings;
  progress: (message: string) => void; signal?: AbortSignal;
  onFailure: (scope: Scope, noteIds: string[], attempt: 1 | 2, reason: string) => void;
  diagnostics?: MaintenanceDiagnostics;
};

type DecisionContext = Pick<BatchOptions, "ctx" | "settings" | "signal" | "diagnostics">;
type Attempt = { scope: Scope; noteIds: string[]; attempt: 1 | 2 };
export async function requestDecision({ ctx, settings, signal, diagnostics }: DecisionContext, fields: Attempt, task: string, input: unknown, decision: Operation, lookup?: Operation) {
  const model = { ...ctx, getSystemPrompt: () => "" };
  const trace = traceDecision(settings.debugLogging ? diagnostics : undefined, "maintenance.decision", { ...fields, tool: decision.name }, input);
  const report = await runModel(model, [{ role: "user", content: JSON.stringify(input), timestamp: 0 }], task, lookup ? [decision, lookup] : [decision], {
    settings, signal, done: ({ name, isError }) => name === decision.name || isError, onResponse: trace?.onResponse,
  });
  const call = report.calls.at(-1);
  if (call?.isError) throw new Error(String(call.result).split("\n\nReceived arguments:\n", 1)[0]);
  if (call?.name !== decision.name) throw new Error(`Model did not call ${decision.name}`);
  trace?.result(call.result);
}

export function resolveBatch<T extends { id: string }>(notes: readonly Memory[], updates: readonly T[]): { note: Memory; update: T }[] {
  const allowed = new Map(notes.map((note) => [note.id, note]));
  return updates.map((update) => {
    const note = allowed.get(update.id);
    if (!note) throw new Error("Decision contains an unknown or repeated ID for this batch");
    allowed.delete(update.id);
    return { note, update };
  });
}

export async function retryDecision(options: BatchOptions, scope: Scope, ids: string[], status: string, decide: (fields: Attempt) => Promise<number>): Promise<MaintenanceResult> {
  const { progress, signal, onFailure } = options;
  for (const attempt of [1, 2] as const) {
    signal?.throwIfAborted();
    progress(attempt === 1 ? status : `${status} · retrying`);
    try { return { changes: await decide({ scope, noteIds: ids, attempt }), skipped: 0 }; }
    catch (error) {
      signal?.throwIfAborted();
      onFailure(scope, ids, attempt, String(error));
    }
  }
  return { changes: 0, skipped: ids.length };
}

export async function runBatches(options: BatchOptions, title: string, decide: (fields: Attempt, notes: Memory[]) => Promise<number>): Promise<MaintenanceResult> {
  const { scopes, store, signal } = options;
  const result = { changes: 0, skipped: 0 };
  for (const scope of scopes) {
    signal?.throwIfAborted();
    const notes = await store.list(scope);
    for (let i = 0; i < notes.length; i += batchSize) {
      const batch = notes.slice(i, i + batchSize);
      const status = `${title} ${scope} memories: ${i + 1}–${i + batch.length}/${notes.length}`;
      const outcome = await retryDecision(options, scope, batch.map(({ id }) => id), status, (fields) => decide(fields, batch));
      result.changes += outcome.changes;
      result.skipped += outcome.skipped;
    }
  }
  return result;
}

export async function reclassifyMemories(options: BatchOptions, sessionSearch: Operation): Promise<MaintenanceResult> {
  const { store, settings } = options;
  const task = [prompt(settings, "classification"), prompt(settings, "reclassify")].join("\n\n");
  return runBatches(options, "Reclassifying", async (fields, notes) => {
    let changes = 0;
    const tool = operation(toolNames.reclassify, "After any needed session searches, submit changed kinds using IDs from this batch. Submit an empty updates list if none.",
      Type.Object({ updates: Type.Array(Type.Object({ id, kind: memoryKind })) }), async ({ updates }, signal) => {
        const classified = resolveBatch(notes, updates).map(({ note, update }) => ({ note, kind: update.kind }));
        changes = await store.reclassify(classified, signal);
        return { value: { changes } };
      });
    await requestDecision(options, fields, task, { notes }, tool, sessionSearch);
    return changes;
  });
}
