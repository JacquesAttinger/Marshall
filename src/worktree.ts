// Last edited: 2026-10-19 22:50 PDT
// Worktrees for agent branches, mirroring ship-plan step 2: `<repo>/../<repo>-<branch>` off
// `origin/<base>`, with the main checkout's ignored `.env` files copied in and its `linkPaths`
// (installed dependencies such as `node_modules`) linked in. The scheduler owns this (step 07
// decision 1); step 08 never runs `git worktree`.

import {
  appendFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { GitError, gitLines, runGit } from "./git.ts";
import type { WorktreeOps, WorktreeSpec } from "./scheduler/types.ts";

function realOrResolved(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/**
 * `<parent of repo>/<repo dir name>-<branch>`, the same shape ship-plan uses. Symlinks are
 * resolved (macOS `/var` is `/private/var`) so the path compares equal to what git prints.
 */
export function worktreePathFor(repoPath: string, branch: string): string {
  const repo = realOrResolved(repoPath);
  return join(dirname(repo), `${basename(repo)}-${branch}`);
}

/** Ignored files named `.env*` anywhere in the checkout, as repo-relative paths. */
export async function listEnvFiles(repoPath: string): Promise<string[]> {
  const lines = await gitLines(
    ["ls-files", "--others", "--ignored", "--exclude-standard"],
    repoPath,
  );
  return lines.filter((f) => /(^|\/)\.env/.test(f));
}

/** Copy every `.env*` the main checkout ignores into the worktree. Returns what was copied. */
export async function copyEnvFiles(repoPath: string, worktreePath: string): Promise<string[]> {
  const copied: string[] = [];
  for (const rel of await listEnvFiles(repoPath)) {
    const target = join(worktreePath, rel);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(repoPath, rel), target);
    copied.push(rel);
  }
  return copied;
}

function existsNoFollow(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Make git ignore `rel` in every worktree of the repo when the repo's own rules do not. A
 * `.gitignore` line like `node_modules/` matches only a directory, never a symlink, so without
 * this an agent's `git add -A` could commit the link.
 */
async function ensureIgnored(worktreePath: string, rel: string): Promise<void> {
  try {
    await runGit(["check-ignore", "-q", "--no-index", rel], worktreePath);
    return;
  } catch (err) {
    if (!(err instanceof GitError)) throw err;
  }
  const commonDir = await runGit(["rev-parse", "--git-common-dir"], worktreePath);
  const exclude = join(resolve(worktreePath, commonDir), "info", "exclude");
  const line = `/${rel}`;
  const current = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
  if (current.split("\n").includes(line)) return;
  mkdirSync(dirname(exclude), { recursive: true });
  const sep = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
  appendFileSync(exclude, `${sep}${line}\n`);
}

/**
 * Symlink each repo-relative path in `paths` from the main checkout into the worktree, so an agent
 * can run checks without a fresh install (Command's `node_modules` is 1.4 GB). An entry the main
 * checkout lacks, or the worktree already has, is skipped. Returns what was linked.
 */
export async function linkSharedPaths(
  repoPath: string,
  worktreePath: string,
  paths: readonly string[],
): Promise<string[]> {
  const linked: string[] = [];
  for (const rel of paths) {
    if (isAbsolute(rel) || rel.split("/").includes("..")) {
      throw new Error(`linkPaths entry "${rel}" must be a path inside the repo`);
    }
    const source = join(repoPath, rel);
    const target = join(worktreePath, rel);
    if (!existsSync(source) || existsNoFollow(target)) continue;
    mkdirSync(dirname(target), { recursive: true });
    symlinkSync(realOrResolved(source), target);
    await ensureIgnored(worktreePath, rel);
    linked.push(rel);
  }
  return linked;
}

/** What a new worktree takes from the main checkout: `.env` copies and `linkPaths` links. */
async function prepareWorktree(spec: WorktreeSpec, path: string): Promise<void> {
  await copyEnvFiles(spec.repoPath, path);
  await linkSharedPaths(spec.repoPath, path, spec.linkPaths ?? []);
}

/** Paths git currently lists as worktrees of `repoPath`, as git prints them (real paths). */
export async function listWorktrees(repoPath: string): Promise<string[]> {
  const lines = await gitLines(["worktree", "list", "--porcelain"], repoPath);
  return lines.filter((l) => l.startsWith("worktree ")).map((l) => l.slice("worktree ".length));
}

/** Fresh branch off the latest `origin/<base>`, in a new worktree. Throws if the branch exists. */
export async function createWorktree(spec: WorktreeSpec): Promise<string> {
  const path = worktreePathFor(spec.repoPath, spec.branch);
  await runGit(["fetch", "origin", "--prune"], spec.repoPath);
  await runGit(["worktree", "prune"], spec.repoPath);
  await runGit(
    ["worktree", "add", path, "-b", spec.branch, `origin/${spec.baseBranch}`],
    spec.repoPath,
  );
  await prepareWorktree(spec, path);
  return path;
}

/**
 * The worktree for a bounce: the existing directory when git still knows it; else a worktree on
 * the existing branch (local, or a remote-tracking one git adopts by name); else a fresh one.
 */
export async function reuseWorktree(spec: WorktreeSpec): Promise<string> {
  const path = worktreePathFor(spec.repoPath, spec.branch);
  await runGit(["worktree", "prune"], spec.repoPath);
  if (existsSync(path) && (await listWorktrees(spec.repoPath)).includes(path)) return path;
  await runGit(["fetch", "origin", "--prune"], spec.repoPath);
  try {
    await runGit(["worktree", "add", path, spec.branch], spec.repoPath);
  } catch (err) {
    if (
      !(err instanceof GitError) ||
      !/invalid reference|not a valid|not found/i.test(err.message)
    ) {
      throw err;
    }
    return createWorktree(spec);
  }
  await prepareWorktree(spec, path);
  return path;
}

/** Drop the worktree directory. The branch stays, so a later bounce can still reuse it. */
export async function removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
  await runGit(["worktree", "remove", "--force", worktreePath], repoPath);
  await runGit(["worktree", "prune"], repoPath);
}

export const gitWorktrees: WorktreeOps = { create: createWorktree, reuse: reuseWorktree };
