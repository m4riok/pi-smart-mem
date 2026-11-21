import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Tool } from "@earendil-works/pi-ai";
import { Type, type Static, type TSchema } from "typebox";
import type { Archive } from "./archive.ts";
import type { Draft, Embedding, MemoryStore } from "./memory-store.ts";

const text = Type.String({ minLength: 1 });
const id = Type.String({ minLength: 1 });
const scope = Type.Union([Type.Literal("project"), Type.Literal("global")]);
const limit = Type.Optional(Type.Integer({ minimum: 1, maximum: 50 }));
const projectCategories = Type.Union([Type.Literal("repository_information"), Type.Literal("workflow_decision"), Type.Literal("local_failure")]);
const globalCategories = Type.Union([Type.Literal("user_preference"), Type.Literal("global_workflow_failure")]);
export type Outcome = { value: unknown; saved?: boolean };
export type Operation = Tool & { call: (args: unknown, signal: AbortSignal | undefined) => Promise<Outcome> };
export function operation<T extends TSchema>(name: string, description: string, parameters: T, call: (args: Static<T>, signal?: AbortSignal) => Promise<Outcome> | Outcome): Operation {
  return { name, description, parameters, call: async (args, signal) => { signal?.throwIfAborted(); return call(args as Static<T>, signal); } };
}

const prefix = "psm_";
export const toolNames = {
  memorySearch: `${prefix}memory_search`,
  memoryRead: `${prefix}memory_read`,
  memoryAdd: `${prefix}memory_add`,
  memoryReplace: `${prefix}memory_replace`,
  memoryRemove: `${prefix}memory_remove`,
  memoryRelated: `${prefix}memory_related`,
  memoryGlobalPreferences: `${prefix}memory_global_preferences`,
  skillSearch: `${prefix}skill_search`,
  skillRead: `${prefix}skill_read`,
  skillSave: `${prefix}skill_save`,
  sessionSearch: `${prefix}session_search`,
  selectMemories: `${prefix}select_memories`,
  selectLinks: `${prefix}select_links`,
  consolidateNote: `${prefix}consolidate_note`,
};

const oldToolNames = new Map(Object.values(toolNames).map((name) => [name.slice(prefix.length), name]));
export const currentToolName = (name: string) => oldToolNames.get(name) ?? name;
export const lookupNames = [toolNames.memorySearch, toolNames.memoryRead, toolNames.memoryRelated, toolNames.memoryGlobalPreferences];

export function memoryTools(getStore: () => MemoryStore, getArchive: () => Archive, embed: (text: string, query: boolean, signal?: AbortSignal) => Promise<Embedding>, sessionFile: () => string | undefined): Operation[] {
  const output = async <T>(task: Promise<T>): Promise<Outcome> => ({ value: await task });
  return [
    operation(toolNames.memorySearch, "Find saved memories by keyword and meaning.", Type.Object({ query: text, limit, scope: Type.Optional(scope), category: Type.Optional(Type.Union([projectCategories, globalCategories])) }), async (args, signal) => {
      const embedding = await embed(args.query, true, signal);
      const notes = await getStore().search({ ...args, text: args.query, embedding, limit: args.limit ?? 10 });
      return { value: notes.map(({ project: _, ...note }) => ({ ...note, scope: note.scope === "project" ? "Project" : "Global" })) };
    }),
    operation(toolNames.memoryRead, "Read one saved memory by ID.", Type.Object({ id }), ({ id }) => output(getStore().read(id))),
    operation(toolNames.memoryAdd, "Save a new durable memory to the selected scope and category.", Type.Object({ scope, category: Type.Union([projectCategories, globalCategories]), text }), async (args, signal) => {
      // MemoryStore validates that the selected category belongs to the requested scope.
      const value = await getStore().add(args as Draft, await embed(args.text, false, signal), signal);
      return { value, saved: true };
    }),
    operation(toolNames.memoryReplace, "Replace the text of a saved memory without changing its scope or links.", Type.Object({ id, text }), async (args, signal) => {
      const value = await getStore().replace(args.id, args.text, await embed(args.text, false, signal), signal);
      return { value, saved: !!value };
    }),
    operation(toolNames.memoryRemove, "Remove one saved memory by ID.", Type.Object({ id }), async ({ id }, signal) => {
      const removed = await getStore().remove(id, signal);
      return { value: { removed }, saved: removed };
    }),
    operation(toolNames.memoryRelated, "Find one hop of stored graph neighbors from a saved memory.", Type.Object({ id }), ({ id }) => output(getStore().related(id))),
    operation(toolNames.memoryGlobalPreferences, "Find global user preferences semantically related to a project memory.", Type.Object({ id, limit }), ({ id, limit }) => output(getStore().relatedGlobalPreferences(id, limit ?? 5))),
    operation(toolNames.skillSearch, "Find stored reusable procedures by name or description.", Type.Object({ query: Type.String(), scope: Type.Optional(scope) }), ({ query, scope }) => output(getArchive().searchSkills(query, scope))),
    operation(toolNames.skillRead, "Read a stored reusable procedure by ID.", Type.Object({ id }), ({ id }) => output(getArchive().readSkill(id))),
    operation(toolNames.skillSave, "Save a reusable procedure or revise a procedure in the same scope using its ID.", Type.Object({ id: Type.Optional(id), name: text, description: text, text, scope }), async ({ id, ...draft }, signal) => {
      const value = await getArchive().saveSkill(draft, id, signal);
      return { value, saved: !!value };
    }),
    operation(toolNames.sessionSearch, "Search text in indexed past Pi conversations.", Type.Object({ query: text }), ({ query }) => output(getArchive().searchTranscripts(query, sessionFile()))),
  ];
}

export function registerTools(pi: ExtensionAPI, tools: Operation[]) {
  for (const tool of tools) pi.registerTool({
    name: tool.name, label: tool.name, description: tool.description, parameters: tool.parameters as TSchema,
    async execute(_id, args, signal) {
      const { value, saved } = await tool.call(args, signal);
      return { content: [{ type: "text", text: resultText(value, saved) }], details: { saved } };
    },
  });
}

export function resultText(value: unknown, saved?: boolean) {
  return JSON.stringify({ ...(saved !== undefined ? { saved } : {}), result: value ?? null });
}
