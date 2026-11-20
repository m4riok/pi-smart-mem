import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { RecordId } from "surrealdb";
import { withDatabase } from "./database.ts";

const exec = promisify(execFile);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function git(cwd: string, ...args: string[]) {
  return exec("git", args, { cwd, env: { ...process.env, LC_ALL: "C" } });
}

async function locate(cwd: string): Promise<{ root: string; origin?: string }> {
  const folder = await realpath(cwd);
  let stdout: string;
  try {
    ({ stdout } = await git(folder, "worktree", "list", "--porcelain", "-z"));
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stderr?: string };
    if (failure.code === "ENOENT" || failure.stderr?.startsWith("fatal: not a git repository")) return { root: folder };
    throw error;
  }
  // Git lists the main checkout first, including from a linked worktree.
  const first = stdout.split("\0", 1)[0];
  if (!first.startsWith("worktree ")) throw new Error(`Git did not report a main worktree for ${folder}`);
  const root = await realpath(first.slice("worktree ".length));
  try {
    const { stdout } = await git(root, "config", "--get", "remote.origin.url");
    return { root, origin: stdout.trim() || undefined };
  } catch (error) {
    const failure = error as { code?: number; stderr?: string };
    if (failure.code === 1 && !failure.stderr) return { root };
    throw error;
  }
}

function originKey(origin: string, root: string): string {
  // Network forms share host/path across SSH and HTTPS. Never persist their credentials.
  const repoPath = (path: string) => path.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
  let normalized: string;
  if (origin.includes("://")) {
    const url = new URL(origin);
    if (url.protocol === "file:") {
      normalized = `file:${resolve(fileURLToPath(url))}`;
    } else {
      const port = url.protocol === "ssh:" && url.port === "22" ? "" : url.port;
      normalized = `remote:${url.hostname.toLowerCase()}${port ? `:${port}` : ""}/${repoPath(url.pathname)}`;
    }
  } else {
    const ssh = origin.match(/^(?:[^@/:]+@)?(\[[^\]]+\]|[^/:]+):(.+)$/);
    normalized = ssh ? `remote:${ssh[1].toLowerCase()}/${repoPath(ssh[2])}` : `file:${resolve(root, origin)}`;
  }
  return createHash("sha256").update(normalized).digest("hex");
}

async function readMarker(path: string): Promise<string | undefined> {
  try {
    const value = (await readFile(path, "utf8")).trim();
    if (!uuid.test(value)) throw new Error(`Invalid Smart Mem project ID in ${path}`);
    return value.toLowerCase();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return undefined;
  }
}

async function createMarker(path: string, id: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${id}\n`, { flag: "wx", mode: 0o600 });
    // Publish a complete marker, without replacing one another profile may have created.
    await link(temp, path);
  } finally { await rm(temp, { force: true }); }
}

export async function resolveProject(cwd: string, dbPath: string): Promise<string> {
  const { root, origin } = await locate(cwd);
  const markerPath = join(root, ".pi", "smart-mem-id");
  const remote = origin ? new RecordId("smart_project_remote", originKey(origin, root)) : undefined;
  return withDatabase(dbPath, false, async (db) => {
    await db.query(`DEFINE TABLE IF NOT EXISTS smart_project SCHEMALESS;
      DEFINE TABLE IF NOT EXISTS smart_project_remote SCHEMALESS;`);
    const [remoteProject] = remote
      ? await db.query<[string | undefined]>("SELECT VALUE project FROM ONLY $remote", { remote })
      : [undefined];
    const marker = await readMarker(markerPath);
    const [markerProject] = marker
      ? await db.query<[string | undefined]>("SELECT VALUE project FROM ONLY $marker", { marker: new RecordId("smart_project", marker) })
      : [undefined];
    if (remoteProject && markerProject && remoteProject !== markerProject) {
      throw new Error(`Project identity conflict in ${root}: Git origin and ${markerPath} identify different Smart Mem projects. Neither was changed.`);
    }
    const project = remoteProject ?? markerProject ?? marker ?? randomUUID();
    if (!marker) await createMarker(markerPath, project);
    // An unregistered marker follows a matched origin without rewriting the file.
    const registerMarker = marker ? !markerProject : !remoteProject;
    const registerRemote = remote && !remoteProject;
    if (registerMarker || registerRemote) {
      await db.query(`BEGIN TRANSACTION;
        ${registerMarker ? "CREATE $id SET project = $project;" : ""}
        ${registerRemote ? "CREATE $remote SET project = $project;" : ""}
        COMMIT TRANSACTION;`, { id: new RecordId("smart_project", marker ?? project), remote, project });
    }
    return project;
  });
}
