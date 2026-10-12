// Last edited: 2026-10-11 21:00 PDT
// Step 4: get the repo under ~/code. "new" creates a private GitHub repo and clones it; "existing"
// clones one. Both finish with the repo's default branch, which becomes the PR base. Every command
// is an argv array run without a shell; names were validated before they reach this file.

import { join } from "node:path";
import type { SetupDeps } from "./types.ts";
import { checkRepoName, OWNER, type RepoRef } from "./validate.ts";

export class RepoError extends Error {
  override name = "RepoError";
}

const BRANCH = /^[A-Za-z0-9._/-]{1,100}$/;

export interface RepoOutcome {
  /** `owner/name` on GitHub. */
  fullName: string;
  repoPath: string;
  baseBranch: string;
  detail: string;
}

async function ghOwner(deps: SetupDeps): Promise<string> {
  const res = await deps.run(["gh", "api", "user", "-q", ".login"]);
  const login = res.stdout.trim();
  if (res.code !== 0 || !OWNER.test(login)) {
    throw new RepoError(
      `Could not read the GitHub login (${firstLine(res.stderr) || "is gh logged in?"}).`,
    );
  }
  return login;
}

function firstLine(text: string): string {
  return (text.trim().split("\n")[0] ?? "").slice(0, 200);
}

/** `https://github.com/o/n.git` and `git@github.com:o/n.git` both name `o/n`. */
function remoteNames(url: string, fullName: string): boolean {
  const norm = url
    .trim()
    .toLowerCase()
    .replace(/\.git$/, "");
  return norm.endsWith(`/${fullName.toLowerCase()}`) || norm.endsWith(`:${fullName.toLowerCase()}`);
}

async function defaultBranch(deps: SetupDeps, repoPath: string): Promise<string> {
  const head = await deps.run([
    "git",
    "-C",
    repoPath,
    "symbolic-ref",
    "--short",
    "refs/remotes/origin/HEAD",
  ]);
  let branch = head.code === 0 ? head.stdout.trim().replace(/^origin\//, "") : "";
  if (!branch) {
    const cur = await deps.run(["git", "-C", repoPath, "rev-parse", "--abbrev-ref", "HEAD"]);
    branch = cur.code === 0 ? cur.stdout.trim() : "";
  }
  if (!BRANCH.test(branch) || branch === "HEAD") {
    throw new RepoError("Could not tell which branch is the default. Check the clone.");
  }
  return branch;
}

/** The folder exists: it must be a git clone of this very repo, else stop. */
async function checkExisting(deps: SetupDeps, repoPath: string, fullName: string): Promise<void> {
  if (!deps.fs.existsSync(join(repoPath, ".git"))) {
    throw new RepoError(
      `${repoPath} already exists and is not a git repo. Move it or pick another name.`,
    );
  }
  const remote = await deps.run(["git", "-C", repoPath, "remote", "get-url", "origin"]);
  if (remote.code !== 0 || !remoteNames(remote.stdout, fullName)) {
    throw new RepoError(`${repoPath} already exists but is not a clone of ${fullName}.`);
  }
}

async function createIfMissing(deps: SetupDeps, fullName: string): Promise<boolean> {
  const view = await deps.run(["gh", "repo", "view", fullName, "--json", "name"]);
  if (view.code === 0) return false;
  const made = await deps.run(["gh", "repo", "create", fullName, "--private", "--add-readme"]);
  if (made.code !== 0) {
    throw new RepoError(`Could not create ${fullName} (${firstLine(made.stderr)}).`);
  }
  return true;
}

export async function getRepo(
  deps: SetupDeps,
  ref: RepoRef,
  repoPath: string,
): Promise<RepoOutcome> {
  const name = checkRepoName(ref.name);
  const owner = ref.owner ?? (await ghOwner(deps));
  const fullName = `${owner}/${name}`;
  if (deps.fs.existsSync(repoPath)) {
    await checkExisting(deps, repoPath, fullName);
    const baseBranch = await defaultBranch(deps, repoPath);
    return {
      fullName,
      repoPath,
      baseBranch,
      detail: `Already done: ${repoPath} is a clone of ${fullName}.`,
    };
  }
  const created = ref.mode === "new" && (await createIfMissing(deps, fullName));
  deps.fs.mkdirSync(deps.codeDir, { recursive: true });
  const clone = await deps.run(["gh", "repo", "clone", fullName, repoPath]);
  if (clone.code !== 0) {
    throw new RepoError(`Could not clone ${fullName} (${firstLine(clone.stderr)}).`);
  }
  const baseBranch = await defaultBranch(deps, repoPath);
  const verb = created ? "Created private repo and cloned" : "Cloned";
  return { fullName, repoPath, baseBranch, detail: `${verb} ${fullName} to ${repoPath}.` };
}
