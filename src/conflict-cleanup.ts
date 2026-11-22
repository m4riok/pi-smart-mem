import { readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { requestDecision, resolveBatch, retryDecision, runBatches, type BatchOptions } from "./maintenance-batch.ts";
import { maintenanceShortlistSize, type MaintenanceResult } from "./maintenance.ts";
import type { Embedding, Scope } from "./memory-store.ts";
import { operation, toolNames } from "./memory-tools.ts";
import { prompt } from "./settings.ts";

const id = Type.String({ minLength: 1 });
const replacementText = Type.String({ minLength: 1 });
type Guidance = Record<Scope, { source: string; text: string }[]>;
type CleanupMode = "both" | "guidance-only" | "memory-only";
type Embed = (text: string, signal?: AbortSignal) => Promise<Embedding>;

export function cleanupMode(args: string): CleanupMode {
  const mode = args.trim();
  if (!mode) return "both";
  if (mode === "guidance-only" || mode === "memory-only") return mode;
  throw new Error("Use no argument, guidance-only, or memory-only");
}

async function readPrompt(path: string) {
  try { return (await readFile(path, "utf8")).replace(/^\uFEFF/, ""); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

export async function conflictGuidance(options: ReturnType<ExtensionCommandContext["getSystemPromptOptions"]>, agentDir: string): Promise<Guidance> {
  const global: Guidance[Scope] = [];
  const local: Guidance[Scope] = [];
  for (const { path, content } of options.contextFiles ?? []) {
    if (!/^AGENTS(?:\.override)?\.md$/i.test(basename(path))) continue;
    (resolve(dirname(path)) === resolve(agentDir) ? global : local).push({ source: path, text: content });
  }
  const systemFiles = [["SYSTEM.md", options.customPrompt], ["APPEND_SYSTEM.md", options.appendSystemPrompt]] as const;
  for (const [name, active] of systemFiles) {
    const path = join(agentDir, name);
    const globalText = await readPrompt(path);
    if (globalText?.trim()) global.push({ source: path, text: globalText });
    if (active?.trim() && active !== globalText) {
      // Pi exposes active prompt text, not its provenance. Only known global
      // files may invalidate global memories; session overrides stay local.
      local.push({ source: `Active session ${name}`, text: active });
    }
  }
  return { project: [...global, ...local], global };
}

async function cleanAgainstGuidance(options: BatchOptions, guidance: Guidance, embed: Embed): Promise<MaintenanceResult> {
  const { store, settings } = options;
  const scopes = options.scopes.filter((scope) => guidance[scope].length > 0);
  return runBatches({ ...options, scopes }, "Checking guidance for", async (fields, notes) => {
    let changes = 0;
    const tool = operation(toolNames.cleanupGuidance, "Submit only directly conflicting notes from this batch. Supply replacement text, or null if no durable content remains.",
      Type.Object({ updates: Type.Array(Type.Object({ id, text: Type.Union([replacementText, Type.Null()]) })) }), async ({ updates }, signal) => {
        const replacements = [];
        for (const { note, update } of resolveBatch(notes, updates)) {
          const text = update.text?.trim();
          if (update.text !== null && !text) throw new Error("Use null for deletion, not blank replacement text");
          if (text === note.text) continue;
          replacements.push({ note, replacement: text ? { text, embedding: await embed(text, signal) } : null });
        }
        changes = await store.cleanGuidance(replacements, signal);
        return { value: { changes } };
      });
    await requestDecision(options, fields, prompt(settings, "cleanupGuidance"), { guidance: guidance[fields.scope], notes }, tool);
    return changes;
  });
}

async function cleanAgainstMemories(options: BatchOptions, embed: Embed): Promise<MaintenanceResult> {
  const { store, settings, scopes, signal } = options;
  const total = { changes: 0, skipped: 0 };
  for (const scope of scopes) {
    signal?.throwIfAborted();
    const notes = await store.list(scope, "unchecked-conflicts");
    for (const [i, { id: sourceId }] of notes.entries()) {
      const outcome = await retryDecision(options, scope, [sourceId], `Checking ${scope} memory conflicts: ${i + 1}/${notes.length}`, async (fields) => {
        const source = await store.read(sourceId);
        if (!source) return 0;
        const candidates = await store.candidates(source, maintenanceShortlistSize, true);
        if (!candidates.some(({ revisedAt }) => revisedAt !== source.revisedAt)) {
          await store.markConflictChecked(source, signal);
          return 0;
        }
        let changes = 0;
        const tool = operation(toolNames.cleanupMemory, "Submit genuinely conflicting candidate IDs and complete text of the newest position. Omit text and pass an empty list if none.",
          Type.Object({ ids: Type.Array(id), text: Type.Optional(replacementText) }), async ({ ids, text }, signal) => {
            if (!ids.length) {
              await store.markConflictChecked(source, signal);
              return { value: { changes } };
            }
            const conflicts = resolveBatch(candidates, ids.map((id) => ({ id }))).map(({ note }) => note);
            const [keep, ...remove] = [source, ...conflicts].sort((a, b) => b.revisedAt - a.revisedAt);
            if (keep.revisedAt === remove[0].revisedAt) throw new Error("Conflicting memories tie for latest substantive revision");
            const replacement = text?.trim();
            if (!replacement) throw new Error("A conflict merge requires complete replacement text");
            const embedding = await embed(replacement, signal);
            if (await store.merge(keep, remove, replacement, embedding, signal, keep.id === source.id ? "conflict" : undefined)) changes = remove.length;
            return { value: { changes } };
          });
        await requestDecision(options, fields, prompt(settings, "cleanupMemory"), { source, candidates }, tool);
        return changes;
      });
      total.changes += outcome.changes;
      total.skipped += outcome.skipped;
    }
  }
  return total;
}

export async function cleanupConflicts(options: BatchOptions, mode: CleanupMode, embed: Embed, guidance: () => Promise<Guidance>): Promise<MaintenanceResult> {
  const first = mode === "memory-only" ? { changes: 0, skipped: 0 } : await cleanAgainstGuidance(options, await guidance(), embed);
  if (mode === "guidance-only") return first;
  const second = await cleanAgainstMemories(options, embed);
  return { changes: first.changes + second.changes, skipped: first.skipped + second.skipped };
}
