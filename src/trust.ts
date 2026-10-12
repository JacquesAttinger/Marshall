// Last edited: 2026-10-11 19:10 PDT
// Trust the configured repo in Claude Code's own config, so `claude --bg` can start there.
// Claude Code asks "do you trust this folder?" once per git repo and keeps the answer as
// `projects[<path>].hasTrustDialogAccepted` in `~/.claude.json`. On a headless VM nobody can answer
// the prompt, so every new repoPath failed with "Workspace not trusted". Marshall already runs
// unattended agents in repoPath, so it records the trust itself, once, before the first launch.
// A trusted parent folder does not cover a git repo inside it (docs/oracle_hosting_plan.md).

import {
  chmodSync,
  existsSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type TrustResult =
  /** The repo was already trusted; nothing was written. */
  | "already_trusted"
  /** The trust flag was written. */
  | "trusted"
  /** No Claude config file yet (Claude Code never ran here): nothing to edit, so nothing written. */
  | "no_config"
  /** The config is not a JSON object. Left alone, so a damaged file is never made worse. */
  | "unreadable";

/** `$CLAUDE_CONFIG_DIR/.claude.json` when that variable is set, else `~/.claude.json`. */
export function claudeConfigPath(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR;
  return dir && dir.length > 0 ? join(dir, ".claude.json") : join(homedir(), ".claude.json");
}

type ProjectEntry = Record<string, unknown>;
type ClaudeConfig = { projects?: Record<string, ProjectEntry> } & Record<string, unknown>;

function parse(text: string): ClaudeConfig | null {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as ClaudeConfig)
      : null;
  } catch {
    return null;
  }
}

/** The path Claude Code keys the repo by: its real path, as it resolves symlinks. */
function repoKey(repoPath: string): string {
  try {
    return realpathSync(repoPath);
  } catch {
    return repoPath;
  }
}

/**
 * Set `hasTrustDialogAccepted` for `repoPath` unless it is already set. Writes through a temp file
 * and a rename, so Claude Code never reads a half-written config, and keeps the file private.
 * The file is read again right before the write: Claude Code rewrites it often, and a
 * stale copy would undo its changes.
 */
export function ensureRepoTrusted(repoPath: string, configPath = claudeConfigPath()): TrustResult {
  if (!existsSync(configPath)) return "no_config";
  const key = repoKey(repoPath);
  const before = parse(readFileSync(configPath, "utf8"));
  if (!before) return "unreadable";
  if (before.projects?.[key]?.hasTrustDialogAccepted === true) return "already_trusted";

  const config = parse(readFileSync(configPath, "utf8"));
  if (!config) return "unreadable";
  const projects = config.projects ?? {};
  projects[key] = { ...projects[key], hasTrustDialogAccepted: true };
  config.projects = projects;

  const temp = `${configPath}.marshall-${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, configPath);
  return "trusted";
}
