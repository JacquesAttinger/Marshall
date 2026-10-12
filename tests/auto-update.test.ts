// Last edited: 2026-10-12 16:55 PDT
// scripts/auto-update.sh against throwaway git repos: a bare "origin", a "seed" clone that pushes
// commits, and a "deployed" clone the script updates. `systemctl` and `bun` are stubs that log their
// arguments, so nothing real restarts. The gate is a stub command too.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "scripts", "auto-update.sh");

let root: string;
let origin: string;
let seed: string;
let deployed: string;
let calls: string;

/** The environment without `GIT_DIR` and friends, which a git hook exports and would redirect the throwaway repos. */
function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith("GIT_")) env[k] = v;
  }
  return env;
}

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    env: cleanEnv(),
  });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

/** Commit files in the seed clone and push them to origin. */
function push(files: Record<string, string>): string {
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(seed, path, ".."), { recursive: true });
    writeFileSync(join(seed, path), body);
  }
  git(seed, "add", "-A");
  git(seed, "commit", "-qm", "change");
  git(seed, "push", "-q", "origin", "main");
  return git(seed, "rev-parse", "HEAD");
}

function stub(dir: string, name: string): void {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\necho "${name} $*" >> "${calls}"\n`);
  chmodSync(path, 0o755);
}

function run(gate = "true"): { code: number; out: string } {
  const r = Bun.spawnSync(["bash", join(deployed, "scripts", "auto-update.sh")], {
    cwd: deployed,
    env: {
      ...cleanEnv(),
      PATH: `${join(root, "bin")}:${process.env.PATH}`,
      HOME: root,
      MARSHALL_UPDATE_GATE: gate,
    },
  });
  return { code: r.exitCode ?? -1, out: r.stdout.toString() + r.stderr.toString() };
}

const calledWith = (needle: string): boolean => readFileSync(calls, "utf8").includes(needle);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "marshall-update-"));
  origin = join(root, "origin.git");
  seed = join(root, "seed");
  deployed = join(root, "deployed");
  calls = join(root, "calls.log");
  writeFileSync(calls, "");
  mkdirSync(join(root, "bin"));
  stub(join(root, "bin"), "systemctl");
  stub(join(root, "bin"), "bun");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(root, "clone", "-q", origin, seed);
  git(seed, "checkout", "-q", "-b", "main");
  mkdirSync(join(seed, "scripts"));
  cpSync(SCRIPT, join(seed, "scripts", "auto-update.sh"));
  push({ "src/a.ts": "1", "README.md": "1", "bun.lock": "1" });
  git(root, "clone", "-q", origin, deployed);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("auto-update.sh", () => {
  test("does nothing when origin has no new commit", () => {
    const r = run();
    expect(r.code).toBe(0);
    expect(r.out).toBe("");
    expect(readFileSync(calls, "utf8")).toBe("");
  });

  test("pulls a source change and restarts both services", () => {
    const sha = push({ "src/a.ts": "2" });
    const r = run();
    expect(r.code).toBe(0);
    expect(git(deployed, "rev-parse", "HEAD")).toBe(sha);
    expect(calledWith("systemctl --user restart marshall\n")).toBe(true);
    expect(calledWith("systemctl --user restart marshall-dashboard\n")).toBe(true);
    expect(calledWith("bun install")).toBe(false);
  });

  test("pulls a docs-only change without a restart", () => {
    const sha = push({ "README.md": "2" });
    const r = run();
    expect(r.code).toBe(0);
    expect(git(deployed, "rev-parse", "HEAD")).toBe(sha);
    expect(calledWith("restart")).toBe(false);
    expect(r.out).toContain("no restart");
  });

  test("installs dependencies when the lockfile changes", () => {
    push({ "bun.lock": "2" });
    expect(run().code).toBe(0);
    expect(calledWith("bun install --frozen-lockfile")).toBe(true);
    expect(calledWith("restart marshall\n")).toBe(true);
  });

  test("rolls back a change that fails the gate and does not retry it", () => {
    const before = git(deployed, "rev-parse", "HEAD");
    const bad = push({ "src/a.ts": "broken" });
    const first = run("false");
    expect(first.code).toBe(1);
    expect(git(deployed, "rev-parse", "HEAD")).toBe(before);
    expect(readFileSync(join(root, ".marshall-update-failed"), "utf8").trim()).toBe(bad);
    expect(calledWith("restart")).toBe(false);

    // Same bad commit, even with a passing gate: skipped. A newer commit is tried again.
    expect(run("true").out).toBe("");
    expect(git(deployed, "rev-parse", "HEAD")).toBe(before);
    const fixed = push({ "src/a.ts": "fixed" });
    expect(run("true").code).toBe(0);
    expect(git(deployed, "rev-parse", "HEAD")).toBe(fixed);
  });
});

describe("auto-update.sh safety checks", () => {
  test("leaves a checkout with local edits alone", () => {
    const before = git(deployed, "rev-parse", "HEAD");
    push({ "src/a.ts": "2" });
    writeFileSync(join(deployed, "src", "a.ts"), "hand edit");
    const r = run();
    expect(r.code).toBe(1);
    expect(r.out).toContain("local edits");
    expect(git(deployed, "rev-parse", "HEAD")).toBe(before);
  });

  test("leaves a checkout that is not on main alone", () => {
    git(deployed, "checkout", "-q", "-b", "other");
    push({ "src/a.ts": "2" });
    const r = run();
    expect(r.code).toBe(1);
    expect(r.out).toContain("not on main");
  });

  test("refuses a diverged main", () => {
    writeFileSync(join(deployed, "local.txt"), "x");
    git(deployed, "add", "-A");
    git(deployed, "commit", "-qm", "local");
    push({ "src/a.ts": "2" });
    const r = run();
    expect(r.code).toBe(1);
    expect(r.out).toContain("diverged");
  });
});
