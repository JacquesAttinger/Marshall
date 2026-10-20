// Last edited: 2026-10-19 22:55 PDT

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { GitError } from "../src/git.ts";
import {
  copyEnvFiles,
  createWorktree,
  linkSharedPaths,
  listWorktrees,
  removeWorktree,
  reuseWorktree,
  worktreePathFor,
} from "../src/worktree.ts";
import { git, makeRepo, type TempRepo } from "./plan/helpers.ts";

let repo: TempRepo;

beforeEach(() => {
  repo = makeRepo();
  git(["checkout", "-q", "main"], repo.dir);
  writeFileSync(join(repo.dir, ".gitignore"), ".env\n.env.*\n");
  git(["add", ".gitignore"], repo.dir);
  git(["commit", "-q", "-m", "ignore env"], repo.dir);
  git(["push", "-q", "origin", "main"], repo.dir);
  writeFileSync(join(repo.dir, ".env"), "KEY=1\n");
  mkdirSync(join(repo.dir, "apps", "api"), { recursive: true });
  writeFileSync(join(repo.dir, "apps", "api", ".env.local"), "PORT=2\n");
});

afterEach(() => {
  repo.remove();
});

const spec = () => ({ repoPath: repo.dir, branch: "cb-7-fix", baseBranch: "main" });

describe("worktreePathFor", () => {
  test("is a sibling named <repo>-<branch>", () => {
    expect(worktreePathFor("/tmp/x/ChessBuddy", "cb-7-fix")).toBe("/tmp/x/ChessBuddy-cb-7-fix");
  });
});

describe("createWorktree", () => {
  test("branches off origin/main into a sibling dir and copies every ignored .env", async () => {
    const path = await createWorktree(spec());
    expect(path).toBe(worktreePathFor(repo.dir, "cb-7-fix"));
    expect(git(["rev-parse", "--abbrev-ref", "HEAD"], path)).toBe("cb-7-fix");
    expect(git(["rev-parse", "HEAD"], path)).toBe(git(["rev-parse", "origin/main"], repo.dir));
    expect(readFileSync(join(path, ".env"), "utf8")).toBe("KEY=1\n");
    expect(readFileSync(join(path, "apps", "api", ".env.local"), "utf8")).toBe("PORT=2\n");
    expect(git(["status", "--porcelain"], path)).toBe("");
  });

  test("uses the latest origin/main, not the local main", async () => {
    // Advance origin from a second clone; the local main stays behind.
    const other = join(repo.dir, "..", "other");
    git(["clone", "-q", join(repo.dir, "..", "origin.git"), other], repo.dir);
    git(["config", "user.email", "t@example.com"], other);
    git(["config", "user.name", "T"], other);
    writeFileSync(join(other, "new.txt"), "x\n");
    git(["add", "new.txt"], other);
    git(["commit", "-q", "-m", "ahead"], other);
    git(["push", "-q", "origin", "main"], other);
    const path = await createWorktree(spec());
    expect(existsSync(join(path, "new.txt"))).toBe(true);
  });

  test("refuses when the branch already exists", async () => {
    await createWorktree(spec());
    await removeWorktree(repo.dir, worktreePathFor(repo.dir, "cb-7-fix"));
    await expect(createWorktree(spec())).rejects.toBeInstanceOf(GitError);
  });
});

describe("reuseWorktree", () => {
  test("returns the existing worktree untouched", async () => {
    const path = await createWorktree(spec());
    writeFileSync(join(path, "wip.txt"), "keep me\n");
    expect(await reuseWorktree(spec())).toBe(path);
    expect(readFileSync(join(path, "wip.txt"), "utf8")).toBe("keep me\n");
  });

  test("re-adds a worktree for a branch whose directory is gone, with .env", async () => {
    const path = await createWorktree(spec());
    git(["commit", "-q", "--allow-empty", "-m", "agent work"], path);
    const head = git(["rev-parse", "HEAD"], path);
    rmSync(path, { recursive: true, force: true });
    expect(await reuseWorktree(spec())).toBe(path);
    expect(git(["rev-parse", "HEAD"], path)).toBe(head);
    expect(readFileSync(join(path, ".env"), "utf8")).toBe("KEY=1\n");
  });

  test("adopts a branch that only exists on origin", async () => {
    const path = await createWorktree(spec());
    git(["commit", "-q", "--allow-empty", "-m", "agent work"], path);
    git(["push", "-q", "-u", "origin", "cb-7-fix"], path);
    const head = git(["rev-parse", "HEAD"], path);
    await removeWorktree(repo.dir, path);
    git(["branch", "-D", "cb-7-fix"], repo.dir);
    expect(await reuseWorktree(spec())).toBe(path);
    expect(git(["rev-parse", "HEAD"], path)).toBe(head);
  });

  test("falls back to a fresh worktree when the branch exists nowhere", async () => {
    const path = await reuseWorktree(spec());
    expect(git(["rev-parse", "--abbrev-ref", "HEAD"], path)).toBe("cb-7-fix");
    expect(git(["rev-parse", "HEAD"], path)).toBe(git(["rev-parse", "origin/main"], repo.dir));
  });
});

describe("removeWorktree and helpers", () => {
  test("removes the directory and the registration, keeps the branch", async () => {
    const path = await createWorktree(spec());
    await removeWorktree(repo.dir, path);
    expect(existsSync(path)).toBe(false);
    expect(await listWorktrees(repo.dir)).toEqual([realpathSync(repo.dir)]);
    expect(git(["rev-parse", "--verify", "cb-7-fix"], repo.dir)).toHaveLength(40);
  });

  test("copyEnvFiles reports what it copied", async () => {
    const target = join(repo.dir, "..", "target");
    mkdirSync(target);
    expect((await copyEnvFiles(repo.dir, target)).sort()).toEqual([".env", "apps/api/.env.local"]);
  });
});

describe("linkPaths", () => {
  const linked = () => ({ ...spec(), linkPaths: ["node_modules", "web/node_modules"] });

  beforeEach(() => {
    mkdirSync(join(repo.dir, "node_modules", "left-pad"), { recursive: true });
    writeFileSync(join(repo.dir, "node_modules", "left-pad", "index.js"), "x\n");
  });

  test("links each path the main checkout has, skips the rest, and keeps git status clean", async () => {
    // The fixture ignores only `.env`, so git sees the link unless Marshall excludes it.
    const path = await createWorktree(linked());
    const link = join(path, "node_modules");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(realpathSync(join(repo.dir, "node_modules")));
    expect(readFileSync(join(link, "left-pad", "index.js"), "utf8")).toBe("x\n");
    expect(existsSync(join(path, "web"))).toBe(false);
    expect(git(["status", "--porcelain"], path)).toBe("");
    const exclude = readFileSync(join(repo.dir, ".git", "info", "exclude"), "utf8");
    expect(exclude.split("\n")).toContain("/node_modules");
  });

  test("relinks on a bounce, and removing the worktree leaves the shared folder alone", async () => {
    const path = await createWorktree(linked());
    rmSync(path, { recursive: true, force: true });
    expect(lstatSync(join(await reuseWorktree(linked()), "node_modules")).isSymbolicLink()).toBe(
      true,
    );
    await removeWorktree(repo.dir, path);
    expect(existsSync(join(repo.dir, "node_modules", "left-pad", "index.js"))).toBe(true);
  });

  test("never replaces what the worktree already has, and adds an exclude line once", async () => {
    const path = await createWorktree(spec());
    mkdirSync(join(path, "node_modules"));
    expect(await linkSharedPaths(repo.dir, path, ["node_modules"])).toEqual([]);
    rmSync(join(path, "node_modules"), { recursive: true });
    expect(await linkSharedPaths(repo.dir, path, ["node_modules"])).toEqual(["node_modules"]);
    rmSync(join(path, "node_modules"));
    await linkSharedPaths(repo.dir, path, ["node_modules"]);
    const exclude = readFileSync(join(repo.dir, ".git", "info", "exclude"), "utf8");
    expect(exclude.split("\n").filter((l) => l === "/node_modules")).toHaveLength(1);
  });

  test("adds no exclude line when the repo already ignores the link", async () => {
    git(["checkout", "-q", "main"], repo.dir);
    writeFileSync(join(repo.dir, ".gitignore"), ".env\n.env.*\nnode_modules\n");
    git(["commit", "-q", "-am", "ignore node_modules"], repo.dir);
    git(["push", "-q", "origin", "main"], repo.dir);
    await createWorktree(linked());
    const exclude = join(repo.dir, ".git", "info", "exclude");
    const text = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
    expect(text).not.toContain("/node_modules");
  });

  test("refuses a path outside the repo", async () => {
    const path = await createWorktree(spec());
    await expect(linkSharedPaths(repo.dir, path, ["../escape"])).rejects.toThrow(/inside the repo/);
  });
});
