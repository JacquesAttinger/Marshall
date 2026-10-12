// Last edited: 2026-10-11 21:40 PDT
// Fake dependencies for the "add a project" pipeline: Linear is `fakeLinear` behind the real GraphQL
// transport, `gh`/`git` are a recording runner that fakes a clone by making the folder, and the
// file system is real but lives in a temp dir (the registry reads MARSHALL_PROJECTS_DIR).

import * as nodeFs from "node:fs";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGql } from "../../src/linear/gql.ts";
import type { CommandResult, CommandRunner, SetupDeps } from "../../src/project-setup/types.ts";
import type { TrustResult } from "../../src/trust.ts";
import { recordingLogger } from "../helpers.ts";
import { type FakeLinear, fakeLinear, type Handler } from "../linear/fake-linear.ts";

/** A key-shaped string with a marker, to prove it never leaves secrets.env and Linear's header. */
export const CANARY = "lin_api_CANARY0123456789abcdef";

export interface Rig {
  root: string;
  codeDir: string;
  deps: SetupDeps;
  linear: FakeLinear;
  commands: string[][];
  lines: ReturnType<typeof recordingLogger>["lines"];
  /** Replace the answer for commands whose joined argv starts with `prefix`; null restores the default. */
  answer(prefix: string, result: Partial<CommandResult> | null): void;
  /** Stop `gh repo create` until `release()` is called (for the concurrency test). */
  gate(): { release(): void };
  trusted: string[];
  cleanup(): void;
}

const OK: CommandResult = { code: 0, stdout: "", stderr: "" };

interface FakeRunner {
  run: CommandRunner;
  commands: string[][];
  answers: Map<string, Partial<CommandResult>>;
  gate(): { release(): void };
}

function makeRunner(): FakeRunner {
  const commands: string[][] = [];
  const answers = new Map<string, Partial<CommandResult>>();
  let gateWait: Promise<void> | null = null;
  const run: CommandRunner = async (argv) => {
    commands.push(argv);
    const line = argv.join(" ");
    for (const [prefix, result] of answers) {
      if (line.startsWith(prefix)) return { ...OK, ...result };
    }
    if (line.startsWith("gh api user")) return { ...OK, stdout: "jacques\n" };
    if (line.startsWith("gh repo view")) return { ...OK, code: 1, stderr: "not found" };
    if (line.startsWith("gh repo create")) {
      if (gateWait) await gateWait;
      return OK;
    }
    if (argv[1] === "repo" && argv[2] === "clone") {
      mkdirSync(join(argv[4] as string, ".git"), { recursive: true });
      return OK;
    }
    if (line.includes("symbolic-ref")) return { ...OK, stdout: "origin/main\n" };
    if (line.includes("remote get-url")) {
      return {
        ...OK,
        stdout: `https://github.com/jacques/${(argv[2] as string).split("/").pop()}.git\n`,
      };
    }
    return OK;
  };
  const gate = () => {
    let release = () => {};
    gateWait = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { release };
  };
  return { run, commands, answers, gate };
}

/** A tuned base config (JSONC, with a comment) for the new project to copy from. */
function writeBaseConfig(root: string): string {
  const base = join(root, "marshall.config.json");
  writeFileSync(
    base,
    `// tuned\n{"workspace":"old","teamId":"old-team","repoPath":${JSON.stringify(root)},"maxAgents":3,"dashboardPort":7777,"sshCommand":"ssh me@vm"}`,
  );
  return base;
}

export function makeRig(
  opts: {
    teams?: Array<{ id: string; key: string; name: string }>;
    linear?: Record<string, Handler>;
  } = {},
): Rig {
  const root = mkdtempSync(join(tmpdir(), "marshall-setup-"));
  const codeDir = join(root, "code");
  mkdirSync(codeDir);
  const previous = process.env.MARSHALL_PROJECTS_DIR;
  process.env.MARSHALL_PROJECTS_DIR = join(root, "projects");
  const teams = opts.teams ?? [{ id: "team-1", key: "TIC", name: "TicTacToe" }];
  const linear = fakeLinear({
    KeyCheck: () => ({
      viewer: { organization: { urlKey: "tictactoe1514" } },
      teams: { nodes: teams },
    }),
    ...opts.linear,
  });
  const runner = makeRunner();
  const trusted: string[] = [];
  const { log, lines } = recordingLogger();
  const deps: SetupDeps = {
    gql: (apiKey) => createGql({ apiKey, log, fetchImpl: linear.fetchImpl }),
    run: runner.run,
    fs: nodeFs,
    now: () => new Date("2026-10-11T12:00:00Z"),
    codeDir,
    fallbackConfigPath: writeBaseConfig(root),
    trust: (repoPath): TrustResult => {
      const again = trusted.includes(repoPath);
      trusted.push(repoPath);
      return again ? "already_trusted" : "trusted";
    },
    log,
  };
  return {
    root,
    codeDir,
    deps,
    linear,
    commands: runner.commands,
    lines,
    trusted,
    answer: (prefix, result) =>
      void (result ? runner.answers.set(prefix, result) : runner.answers.delete(prefix)),
    gate: runner.gate,
    cleanup() {
      if (previous === undefined) delete process.env.MARSHALL_PROJECTS_DIR;
      else process.env.MARSHALL_PROJECTS_DIR = previous;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export const newRepoInput = (over: Record<string, unknown> = {}) => ({
  name: "Tic Tac Toe",
  linearApiKey: CANARY,
  repo: { mode: "new", name: "tic-tac-toe" },
  ...over,
});
