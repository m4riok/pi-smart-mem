import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { Archive } from "../src/archive.ts";
import { MemoryStore } from "../src/memory-store.ts";
import { resolveProject } from "../src/project.ts";

const exec = promisify(execFile);
const marker = (root) => join(root, ".pi", "smart-mem-id");
const readId = async (root) => (await readFile(marker(root), "utf8")).trim();
const embedding = { model: "fixture", values: [1, 0] };

async function git(cwd, ...args) {
  await exec("git", args, { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" } });
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "smart-mem-project-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const db = join(root, "db");
  await new MemoryStore(undefined, db).initialize({ model: "fixture", dimensions: 2 });
  return { root, db };
}

async function createRepo(root, origin) {
  await mkdir(root, { recursive: true });
  await git(root, "init", "--quiet");
  if (origin) await git(root, "remote", "add", "origin", origin);
}

test("linked worktrees and same-origin clones share memories, pins and skills", async (t) => {
  const { root, db } = await fixture(t);
  const main = join(root, "one", "repo");
  const clone = join(root, "clone");
  const other = join(root, "two", "repo");
  const worktree = join(root, "checkout #α");
  await createRepo(main, "https://EXAMPLE.test/team/repo.git");
  await createRepo(clone, "git@example.test:team/repo");
  await createRepo(other, "https://example.test/other/repo.git");
  await git(main, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--quiet", "--allow-empty", "-m", "Fixture");
  await git(main, "worktree", "add", "--quiet", "--detach", worktree);
  const nested = join(worktree, "src");
  await mkdir(nested);
  const id = await resolveProject(nested, db);
  assert.equal(await readId(main), id);
  await assert.rejects(stat(marker(worktree)), { code: "ENOENT" });
  assert.equal(await resolveProject(main, db), id);
  assert.equal(await resolveProject(clone, db), id);
  assert.equal(await readId(clone), id);
  const otherId = await resolveProject(other, db);
  assert.notEqual(otherId, id);

  const note = await new MemoryStore(id, db).add({ scope: "project", kind: "note", text: "Run project fixtures" }, embedding);
  assert.deepEqual(await new MemoryStore(await resolveProject(clone, db), db).read(note.id), note);
  assert.equal(await new MemoryStore(otherId, db).read(note.id), undefined);
  const archive = new Archive(db, id);
  await archive.pin("project", "Project fixture pin");
  const skill = await archive.saveSkill({ name: "Fixture", description: "Run fixtures", text: "Run pnpm test", scope: "project" });
  const clonedArchive = new Archive(db, await resolveProject(clone, db));
  assert.deepEqual(await clonedArchive.pins(), ["Project fixture pin"]);
  assert.deepEqual(await clonedArchive.readSkill(skill.id), skill);
  assert.deepEqual(await new Archive(db, otherId).pins(), []);
  assert.equal(await new Archive(db, otherId).readSkill(skill.id), undefined);
});

test("non-Git marker survives moves and copies; adding or changing origin keeps scope", async (t) => {
  const { root, db } = await fixture(t);
  const folder = join(root, "folder");
  const moved = join(root, "moved");
  const copy = join(root, "copy");
  await mkdir(folder);
  const id = await resolveProject(folder, db);
  await rename(folder, moved);
  await cp(moved, copy, { recursive: true });
  assert.equal(await resolveProject(moved, db), id);
  assert.equal(await resolveProject(copy, db), id);
  await createRepo(moved, "https://example.test/team/old");
  assert.equal(await resolveProject(moved, db), id);
  await git(moved, "remote", "set-url", "origin", "https://example.test/team/new");
  assert.equal(await resolveProject(moved, db), id);
  const fresh = join(root, "fresh");
  await createRepo(fresh, "ssh://git@example.test:22/team/new.git");
  assert.equal(await resolveProject(fresh, db), id);
});

test("conflicting registered marker and origin are reported without changing either", async (t) => {
  const { root, db } = await fixture(t);
  const first = join(root, "first");
  const second = join(root, "second");
  const one = "https://example.test/team/one";
  const two = "https://example.test/team/two";
  await createRepo(first, one);
  await createRepo(second, two);
  const firstId = await resolveProject(first, db);
  const secondId = await resolveProject(second, db);
  assert.notEqual(firstId, secondId);
  await git(first, "remote", "set-url", "origin", two);
  await assert.rejects(resolveProject(first, db), /Project identity conflict/);
  assert.equal(await readId(first), firstId);
  assert.equal(await resolveProject(second, db), secondId);
  await git(first, "remote", "set-url", "origin", one);
  assert.equal(await resolveProject(first, db), firstId);
});
