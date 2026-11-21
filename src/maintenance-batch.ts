import { Type } from "typebox";
import type { Memory, MemoryStore, Scope } from "./memory-store.ts";
import { memoryKind, operation, toolNames, type Operation } from "./memory-tools.ts";
import type { MaintenanceResult } from "./maintenance.ts";
import { runModel, type ModelContext } from "./review.ts";
import { prompt, type Settings } from "./settings.ts";

const batchSize = 20;
const id = Type.String({ minLength: 1 });
export type BatchOptions = {
  scopes: Scope[]; ctx: ModelContext; store: MemoryStore; settings: Settings;
  progress: (message: string) => void; signal?: AbortSignal;
  onFailure: (scope: Scope, noteIds: string[], attempt: 1 | 2, reason: string) => void;
};

type DecisionContext = Pick<BatchOptions, "ctx" | "settings" | "signal">;
export async function requestDecision({ ctx, settings, signal }: DecisionContext, task: string, input: unknown, tool: Operation) {
  const model = { ...ctx, getSystemPrompt: () => "" };
  const report = await runModel(model, [{ role: "user", content: JSON.stringify(input), timestamp: 0 }], task, [tool], {
    settings, signal, done: () => true,
  });
  const call = report.calls[0];
  if (!call) throw new Error(`Model did not call ${tool.name}`);
  if (call.isError) throw new Error(String(call.result).split("\n\nReceived arguments:\n", 1)[0]);
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

export async function retryDecision(options: BatchOptions, scope: Scope, ids: string[], status: string, decide: () => Promise<number>): Promise<MaintenanceResult> {
  const { progress, signal, onFailure } = options;
  for (const attempt of [1, 2] as const) {
    signal?.throwIfAborted();
    progress(attempt === 1 ? status : `${status} · retrying`);
    try { return { changes: await decide(), skipped: 0 }; }
    catch (error) {
      signal?.throwIfAborted();
      onFailure(scope, ids, attempt, String(error));
    }
  }
  return { changes: 0, skipped: ids.length };
}

export async function runBatches(options: BatchOptions, title: string, decide: (scope: Scope, notes: Memory[]) => Promise<number>): Promise<MaintenanceResult> {
  const { scopes, store, signal } = options;
  const result = { changes: 0, skipped: 0 };
  for (const scope of scopes) {
    signal?.throwIfAborted();
    const notes = await store.list(scope);
    for (let i = 0; i < notes.length; i += batchSize) {
      const batch = notes.slice(i, i + batchSize);
      const status = `${title} ${scope} memories: ${i + 1}–${i + batch.length}/${notes.length}`;
      const outcome = await retryDecision(options, scope, batch.map(({ id }) => id), status, () => decide(scope, batch));
      result.changes += outcome.changes;
      result.skipped += outcome.skipped;
    }
  }
  return result;
}

export async function reclassifyMemories(options: BatchOptions): Promise<MaintenanceResult> {
  const { store, settings } = options;
  return runBatches(options, "Reclassifying", async (_scope, notes) => {
    let changes = 0;
    const tool = operation(toolNames.reclassify, "Submit changed kinds using IDs from this batch. Submit an empty updates list if none.",
      Type.Object({ updates: Type.Array(Type.Object({ id, kind: memoryKind })) }), async ({ updates }, signal) => {
        const classified = resolveBatch(notes, updates).map(({ note, update }) => ({ note, kind: update.kind }));
        changes = await store.reclassify(classified, signal);
        return { value: { changes } };
      });
    await requestDecision(options, prompt(settings, "reclassify"), { notes }, tool);
    return changes;
  });
}
