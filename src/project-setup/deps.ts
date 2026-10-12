// Last edited: 2026-10-11 21:00 PDT
// The real dependencies: `fetch` to Linear, `Bun.spawn` with an argv array for `gh` and `git`,
// the real file system, and the real Claude Code config.

import * as nodeFs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG_PATH } from "../config.ts";
import { gitEnv } from "../git.ts";
import { createGql } from "../linear/gql.ts";
import type { Logger } from "../log.ts";
import { ensureRepoTrusted } from "../trust.ts";
import type { CommandRunner, SetupDeps } from "./types.ts";

const COMMAND_TIMEOUT_MS = 120_000;

/** `Bun.spawn` on an argv array: no shell, no stdin, a time limit. A missing program is code 127. */
export const spawnRunner: CommandRunner = async (argv, opts = {}) => {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(argv, {
      cwd: opts.cwd,
      env: gitEnv(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch {
    return { code: 127, stdout: "", stderr: `${argv[0]} is not installed` };
  }
  const timer = setTimeout(() => proc.kill(), COMMAND_TIMEOUT_MS);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout as ReadableStream).text(),
      new Response(proc.stderr as ReadableStream).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
};

export function defaultSetupDeps(log: Logger): SetupDeps {
  return {
    gql: (apiKey) => createGql({ apiKey, log }),
    run: spawnRunner,
    fs: nodeFs,
    now: () => new Date(),
    codeDir: join(homedir(), "code"),
    fallbackConfigPath: DEFAULT_CONFIG_PATH,
    trust: (repoPath) => ensureRepoTrusted(repoPath),
    log,
  };
}
