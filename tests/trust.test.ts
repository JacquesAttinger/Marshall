// Last edited: 2026-10-11 19:10 PDT

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeConfigPath, ensureRepoTrusted } from "../src/trust.ts";

let dir: string;
let config: string;
let repo: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "marshall-trust-"));
  config = join(dir, ".claude.json");
  repo = join(dir, "repo");
  mkdirSync(repo);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const read = () => JSON.parse(readFileSync(config, "utf8"));

describe("ensureRepoTrusted", () => {
  test("adds the flag for a repo Claude Code has not seen, keeping everything else", () => {
    writeFileSync(config, JSON.stringify({ numStartups: 7, projects: { "/other": { x: 1 } } }));
    expect(ensureRepoTrusted(repo, config)).toBe("trusted");
    const after = read();
    expect(after.numStartups).toBe(7);
    expect(after.projects["/other"]).toEqual({ x: 1 });
    expect(
      Object.values(after.projects).some(
        (p) => (p as Record<string, unknown>).hasTrustDialogAccepted === true,
      ),
    ).toBe(true);
  });

  test("flips a repo that was explicitly declined and keeps its other settings", () => {
    const key = realpathSync(repo);
    writeFileSync(
      config,
      JSON.stringify({
        projects: { [key]: { hasTrustDialogAccepted: false, allowedTools: ["a"] } },
      }),
    );
    expect(ensureRepoTrusted(repo, config)).toBe("trusted");
    expect(read().projects[key]).toEqual({ hasTrustDialogAccepted: true, allowedTools: ["a"] });
  });

  test("an already trusted repo is not rewritten", () => {
    const key = realpathSync(repo);
    const text = JSON.stringify({ projects: { [key]: { hasTrustDialogAccepted: true } } });
    writeFileSync(config, text);
    const before = statSync(config).mtimeMs;
    expect(ensureRepoTrusted(repo, config)).toBe("already_trusted");
    expect(readFileSync(config, "utf8")).toBe(text);
    expect(statSync(config).mtimeMs).toBe(before);
  });

  test("a config with no projects key gets one", () => {
    writeFileSync(config, "{}");
    expect(ensureRepoTrusted(repo, config)).toBe("trusted");
    expect(Object.keys(read().projects)).toHaveLength(1);
  });

  test("no config file: nothing is created", () => {
    expect(ensureRepoTrusted(repo, config)).toBe("no_config");
    expect(readdirSync(dir)).toEqual(["repo"]);
  });

  test("a damaged or non-object config is left byte for byte alone", () => {
    for (const text of ["{not json", "[]", "null", '"x"']) {
      writeFileSync(config, text);
      expect(ensureRepoTrusted(repo, config)).toBe("unreadable");
      expect(readFileSync(config, "utf8")).toBe(text);
    }
  });

  test("the file stays private and no temp file is left behind", () => {
    writeFileSync(config, "{}", { mode: 0o644 });
    ensureRepoTrusted(repo, config);
    expect(statSync(config).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir).sort()).toEqual([".claude.json", "repo"]);
  });

  test("a symlinked repoPath is keyed by its real path, as Claude Code does", () => {
    const link = join(dir, "link");
    symlinkSync(repo, link);
    writeFileSync(config, "{}");
    ensureRepoTrusted(link, config);
    expect(Object.keys(read().projects)).toEqual([realpathSync(repo)]);
  });
});

describe("claudeConfigPath", () => {
  test("follows CLAUDE_CONFIG_DIR, else the home directory", () => {
    const prev = process.env.CLAUDE_CONFIG_DIR;
    try {
      process.env.CLAUDE_CONFIG_DIR = "/x/y";
      expect(claudeConfigPath()).toBe("/x/y/.claude.json");
      delete process.env.CLAUDE_CONFIG_DIR;
      expect(claudeConfigPath().endsWith("/.claude.json")).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prev;
    }
  });
});
