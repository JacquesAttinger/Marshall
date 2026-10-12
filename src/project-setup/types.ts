// Last edited: 2026-10-11 21:00 PDT
// Types shared by the "add a project" pipeline: what the form sends, what each step reports, and
// the injectable dependencies (so the whole pipeline runs in tests with no network and no `gh`).

import type { Gql } from "../linear/gql.ts";
import type { Logger } from "../log.ts";
import type { TrustResult } from "../trust.ts";

export interface RepoChoice {
  mode: "new" | "existing";
  /** New repo name. For an existing repo, `owner/name` is also accepted here. */
  name?: string;
  /** Existing repo: `owner/name` or an `https://github.com/owner/name` URL. */
  url?: string;
}

export interface CreateProjectInput {
  name: string;
  linearApiKey: string;
  repo: RepoChoice;
  teamId?: string;
}

export interface TeamInfo {
  id: string;
  key: string;
  name: string;
}

export interface StepResult {
  step: string;
  ok: boolean;
  detail: string;
}

export interface CreateProjectResult {
  ok: boolean;
  steps: StepResult[];
  /** The Linear workspace the key belongs to, once the key check passed. */
  workspace?: string;
  /** Set with `needsTeam` when the workspace has several teams and none was chosen. */
  teams?: TeamInfo[];
  needsTeam?: boolean;
  slug?: string;
  /** True when the new project is the active one (it was the first). */
  active?: boolean;
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs one program with an argv array. Never a shell string. */
export type CommandRunner = (argv: string[], opts?: { cwd?: string }) => Promise<CommandResult>;

/** The slice of `node:fs` the pipeline itself uses (the registry keeps its own file access). */
export interface SetupFs {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: "utf8"): string;
  writeFileSync(path: string, data: string): void;
  mkdirSync(path: string, opts: { recursive: true }): void;
}

export interface SetupDeps {
  /** A Linear client bound to one API key. */
  gql(apiKey: string): Gql;
  run: CommandRunner;
  fs: SetupFs;
  now(): Date;
  /** Where repos live: `~/code`. A repo path is always `<codeDir>/<name>`. */
  codeDir: string;
  /** Config to start from when no project is active. */
  fallbackConfigPath: string;
  trust(repoPath: string): TrustResult;
  log: Logger;
}
