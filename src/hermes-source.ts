import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Category } from "./memory-store.ts";

export type HermesMemory = { text: string; category: Category; project?: string };
export type HermesSkill = { name: string; description: string; text: string; project?: string };
export type HermesPin = { text: string; project?: string };
export type HermesSource = { memories: HermesMemory[]; skills: HermesSkill[]; pins: HermesPin[]; folders: Map<string, string | undefined> };

function missing(error: NodeJS.ErrnoException): undefined {
  if (error.code !== "ENOENT") throw error;
  return undefined;
}
const readOptional = (path: string) => readFile(path, "utf8").catch(missing);
const list = async (path: string) => (await readdir(path, { withFileTypes: true }).catch(missing) ?? [])
  .sort((a, b) => a.name.localeCompare(b.name));
const isDirectory = async (path: string) => (await stat(path).catch(missing))?.isDirectory() ?? false;

async function memoryFile(path: string, category: Category, project?: string): Promise<HermesMemory[]> {
  return (await readOptional(path) ?? "").split(/\r?\n§\r?\n/).map((entry) => entry
    .replace(/\s*<!--\s*created=[^,]+,\s*last=[^,>]+(?:,\s*project64=[A-Za-z0-9_-]+)?\s*-->\s*$/, "").trim())
    .filter(Boolean).map((text) => ({ text, category, project }));
}

async function pinFile(path: string, project?: string): Promise<HermesPin[]> {
  const seen = new Set<string>();
  return (await readOptional(path) ?? "").split("\n").flatMap((line) => {
    const text = line.replace(/^\s*[-*]\s+/, "").replace(/\s+/g, " ").trim();
    const key = text.toLowerCase();
    if (!text || text.startsWith("#") || seen.has(key)) return [];
    seen.add(key);
    return [{ text, project }];
  });
}

function parseSkill(raw: string, fallback: string, project?: string): HermesSkill | undefined {
  const match = raw.replaceAll("\r\n", "\n").match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  const meta = new Map<string, string>();
  for (const line of match?.[1].split("\n") ?? []) {
    const field = line.match(/^([\w_]+):\s*(.*)$/);
    if (!field) continue;
    const value = field[2].trim();
    meta.set(field[1], /^"(?:[^"\\]|\\.)*"$/.test(value) ? JSON.parse(value) : value);
  }
  const name = meta.get("display_name") || meta.get("name") || fallback;
  const text = (match ? match[2] : raw).trim();
  return text ? { name, description: meta.get("description") || name, text, project } : undefined;
}

async function skillsFolder(path: string, project?: string): Promise<HermesSkill[]> {
  const skills: HermesSkill[] = [];
  for (const item of await list(path)) {
    if (!item.isDirectory() && !(item.isFile() && item.name.endsWith(".md"))) continue;
    const raw = await readOptional(item.isDirectory() ? join(path, item.name, "SKILL.md") : join(path, item.name));
    const skill = raw && parseSkill(raw, basename(item.name, ".md"), project);
    if (skill) skills.push(skill);
  }
  return skills;
}

async function inferFolders(dbPath: string, projects: Iterable<string>, cwd: string) {
  const folders = new Map([...projects].map((name) => [name, basename(cwd) === name ? cwd : undefined] as const));
  if (!folders.size || !await stat(dbPath).catch(missing)) return folders;
  const { DatabaseSync } = await import("node:sqlite");
  // Hermes should be idle during import. Immutable access creates no SQLite sidecars.
  const url = pathToFileURL(dbPath);
  url.searchParams.set("immutable", "1");
  const db = new DatabaseSync(url, { readOnly: true });
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'sessions'").get()) return folders;
    const paths = db.prepare("SELECT cwd FROM sessions WHERE project = ? GROUP BY cwd ORDER BY max(started_at) DESC, cwd");
    for (const name of folders.keys()) {
      for (const { cwd: candidate } of paths.iterate(name)) {
        if (typeof candidate !== "string" || !isAbsolute(candidate) || !await isDirectory(candidate)) continue;
        folders.set(name, candidate);
        break;
      }
    }
    return folders;
  } finally { db.close(); }
}

export async function readHermesSource(agentDir: string, cwd: string): Promise<HermesSource> {
  const raw = await readOptional(join(agentDir, "hermes-memory-config.json"));
  const config: { memoryDir?: unknown; projectsMemoryDir?: unknown } = raw ? JSON.parse(raw) : {};
  const configuredPath = (value: unknown, fallback: string) => {
    const path = typeof value === "string" ? value.trim() : "";
    return path ? resolve(agentDir, path.replace(/^~(?=\/|$)/, homedir())) : join(agentDir, fallback);
  };
  const configured = configuredPath(config.memoryDir, "pi-hermes-memory");
  const legacy = join(agentDir, "memory");
  const globalDir = configured === legacy && await isDirectory(join(agentDir, "pi-hermes-memory"))
    ? join(agentDir, "pi-hermes-memory") : configured;
  const projectRoot = configuredPath(config.projectsMemoryDir, "projects-memory");
  const memories = [
    ...await memoryFile(join(globalDir, "MEMORY.md"), "user_preference"),
    ...await memoryFile(join(globalDir, "USER.md"), "user_preference"),
    ...await memoryFile(join(globalDir, "failures.md"), "global_workflow_failure"),
  ];
  const skills = await skillsFolder(join(globalDir, "skills"));
  const pins = await pinFile(join(globalDir, "STANDING.md"));
  const projects: string[] = [];
  for (const item of await list(projectRoot)) {
    if (!item.isDirectory()) continue;
    const path = join(projectRoot, item.name);
    const notes = await memoryFile(join(path, "MEMORY.md"), "repository_information", item.name);
    const procedures = await skillsFolder(join(path, "skills"), item.name);
    if (!notes.length && !procedures.length) continue;
    projects.push(item.name);
    memories.push(...notes);
    skills.push(...procedures);
  }
  if (!memories.length && !skills.length && !pins.length) throw new Error("No Hermes memories, skills, or pins found");
  return { memories, skills, pins, folders: await inferFolders(join(globalDir, "sessions.db"), projects, cwd) };
}
