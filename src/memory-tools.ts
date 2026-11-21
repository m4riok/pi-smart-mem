import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { JsonObject, Tool } from "@earendil-works/pi-ai";
import { Container, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type, type Static, type TSchema } from "typebox";
import { contentText, transcriptRoles, type Archive } from "./archive.ts";
import { memoryKinds, type Embedding, type MemoryStore } from "./memory-store.ts";

const text = Type.String({ minLength: 1 });
const id = Type.String({ minLength: 1 });
const scope = Type.Union([Type.Literal("project"), Type.Literal("global")]);
const limit = Type.Optional(Type.Integer({ minimum: 1, maximum: 50 }));
export const memoryKind = Type.Union(memoryKinds.map((value) => Type.Literal(value)));
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
  reinforceMemory: `${prefix}reinforce_memory`,
  memoryRelated: `${prefix}memory_related`,
  memoryGlobalPreferences: `${prefix}memory_global_preferences`,
  skillSearch: `${prefix}skill_search`,
  skillRead: `${prefix}skill_read`,
  skillSave: `${prefix}skill_save`,
  sessionSearch: `${prefix}session_search`,
  selectMemories: `${prefix}select_memories`,
  selectLinks: `${prefix}select_links`,
  consolidateNote: `${prefix}consolidate_note`,
  reclassify: `${prefix}reclassify_batch`,
  cleanupGuidance: `${prefix}cleanup_guidance_batch`,
  cleanupMemory: `${prefix}cleanup_memory_conflict`,
};

const oldToolNames = new Map(Object.values(toolNames).map((name) => [name.slice(prefix.length), name]));
export const currentToolName = (name: string) => oldToolNames.get(name) ?? name;
export const lookupNames = [toolNames.memorySearch, toolNames.memoryRead, toolNames.memoryRelated, toolNames.memoryGlobalPreferences];

export function sessionSearchTool(getArchive: () => Archive, sessionFile: () => string | undefined): Operation {
  return operation(toolNames.sessionSearch, "Search text in indexed past Pi conversations.", Type.Object({
    query: text,
    project: Type.Optional(Type.String({ minLength: 1, description: "Exact full working directory (cwd) recorded by Pi. Omit to search all indexed projects." })),
    role: Type.Optional(Type.Union(transcriptRoles.map((value) => Type.Literal(value)), { description: "Filter by message author role." })),
  }), async ({ query, project, role }) => ({ value: await getArchive().searchTranscripts(query, { exclude: sessionFile(), project, role }) }));
}

export function memoryTools(getStore: () => MemoryStore, getArchive: () => Archive, embed: (text: string, query: boolean, signal?: AbortSignal) => Promise<Embedding>): Operation[] {
  const output = async <T>(task: Promise<T>): Promise<Outcome> => ({ value: await task });
  return [
    operation(toolNames.memorySearch, "Find saved memories by keyword and meaning.", Type.Object({ query: text, limit, scope: Type.Optional(scope), kind: Type.Optional(memoryKind) }), async (args, signal) => {
      const embedding = await embed(args.query, true, signal);
      const notes = await getStore().search({ ...args, text: args.query, embedding, limit: args.limit ?? 10 });
      return { value: notes.map(({ project: _, ...note }) => ({ ...note, scope: note.scope === "project" ? "Project" : "Global" })) };
    }),
    operation(toolNames.memoryRead, "Read one saved memory by ID.", Type.Object({ id }), ({ id }) => output(getStore().read(id))),
    operation(toolNames.memoryAdd, "Save a durable memory. Choose its kind using the memory classification guidance.", Type.Object({ scope, kind: memoryKind, text }), async (args, signal) => {
      const value = await getStore().add(args, await embed(args.text, false, signal), signal);
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
  ];
}

function toolPreview(...lines: string[]) {
  return { render: (width: number) => lines.map((line) => truncateToWidth(line, width)), invalidate() {} };
}

function terminalText(text: string) {
  return text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

export function registerTools(pi: ExtensionAPI, tools: Operation[]) {
  for (const tool of tools) pi.registerTool<TSchema, { saved?: boolean }>({
    name: tool.name, label: tool.name, description: tool.description, parameters: tool.parameters as TSchema,
    renderCall(args, theme, { expanded, isPartial, executionStarted }) {
      const title = theme.fg("toolTitle", theme.bold(tool.name));
      const pending = isPartial ? theme.fg("toolOutput", executionStarted ? "Running" : "Pending") : undefined;
      if (expanded) {
        const argumentsText = theme.fg("toolOutput", `Arguments: ${terminalText(JSON.stringify(args))}`);
        return new Text([title, argumentsText, pending].filter(Boolean).join("\n"), 0, 0);
      }
      const preview = Object.entries(args as JsonObject).map(([key, value]) => `${JSON.stringify(key).slice(1, -1)}=${JSON.stringify(value)}`).join(" ");
      const call = preview ? `${title} ${theme.fg("muted", terminalText(preview))}` : title;
      return pending ? toolPreview(call, pending) : toolPreview(call);
    },
    renderResult(result, { expanded, isPartial }, theme, { isError, keyHint }) {
      if (isPartial) return new Container();
      const status = isError ? "Failed" : result.details?.saved === true ? "Saved" : result.details?.saved === false ? "Not saved" : "Finished";
      const summary = theme.fg(isError ? "error" : "toolOutput", status);
      if (!expanded) return toolPreview(`${summary} ${keyHint("app.tools.expand", "to expand")}`);
      const output = theme.fg("toolOutput", `Result: ${terminalText(contentText(result.content))}`);
      return new Text(`${summary}\n${output}`, 0, 0);
    },
    async execute(_id, args, signal) {
      const { value, saved } = await tool.call(args, signal);
      return { content: [{ type: "text", text: resultText(value, saved) }], details: { saved } };
    },
  });
}

export function resultText(value: unknown, saved?: boolean) {
  return JSON.stringify({ ...(saved !== undefined ? { saved } : {}), result: value ?? null });
}
