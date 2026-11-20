import { randomUUID } from "node:crypto";
import type { Progress } from "./embeddings.ts";
import type { HermesSource } from "./hermes-source.ts";
import { MemoryStore, type Embedding, type ImportData } from "./memory-store.ts";
import { resolveProject } from "./project.ts";

export async function migrateHermes(options: {
  source: HermesSource;
  dbPath: string;
  force: boolean;
  embed: (text: string) => Promise<Embedding>;
  progress: Progress;
}) {
  const { source, dbPath, force, embed, progress } = options;
  const store = new MemoryStore(undefined, dbPath);
  if (!force && await store.hasStoredData()) {
    throw new Error("Smart Mem already contains data. Run /migrate-hermes --force to replace it.");
  }

  const embedded = [];
  for (const [i, note] of source.memories.entries()) {
    progress(`Embedding Hermes memory ${i + 1}/${source.memories.length}`);
    embedded.push({ ...note, embedding: await embed(note.text) });
  }

  const pairs = new Map<string, string>();
  const unmatchedProjects: ImportData["unmatchedProjects"] = [];
  for (const [name, folder] of source.folders) {
    const id = folder ? await resolveProject(folder, dbPath) : randomUUID();
    pairs.set(name, id);
    if (!folder) unmatchedProjects.push({ name, id });
  }
  const mapScope = <T extends { project?: string }>(entry: T): T => {
    if (entry.project === undefined) return entry;
    const project = pairs.get(entry.project);
    if (!project) throw new Error(`Missing project ID for Hermes project ${entry.project}`);
    return { ...entry, project };
  };
  progress("Writing imported Hermes data");
  await store.replaceImportedData({
    memories: embedded.map(mapScope), skills: source.skills.map(mapScope), pins: source.pins.map(mapScope), unmatchedProjects,
  }, force);
  return { projects: pairs.size, unmatchedProjects };
}
