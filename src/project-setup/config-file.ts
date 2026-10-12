// Last edited: 2026-10-11 21:00 PDT
// Step 7: write the new project's config.json. It starts from the active project's config (or the
// repo's marshall.config.json when none is active) so tuned limits, sshCommand and dashboardPort
// carry over; only workspace, teamId, repoPath and baseBranch change. The result is checked with
// the same schema the daemon uses. The API key never goes in here: it lives in secrets.env.

import { join } from "node:path";
import { parseConfig } from "../config.ts";
import { getActive, type ProjectRecord, projectDir } from "../projects.ts";
import type { SetupDeps } from "./types.ts";

export interface ProjectFacts {
  workspace: string;
  teamId: string;
  repoPath: string;
  baseBranch: string;
}

type ConfigObject = Record<string, unknown>;

function readConfig(deps: SetupDeps, path: string): ConfigObject {
  const parsed: unknown = Bun.JSONC.parse(deps.fs.readFileSync(path, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path} is not a config object`);
  }
  return parsed as ConfigObject;
}

export function configPathFor(slug: string): string {
  return join(projectDir(slug), "config.json");
}

/** The config to copy settings from: this project's own file, else the active one, else the default. */
function baseConfigPath(deps: SetupDeps, own: string, active: ProjectRecord | null): string {
  if (deps.fs.existsSync(own)) return own;
  return active && deps.fs.existsSync(active.configPath)
    ? active.configPath
    : deps.fallbackConfigPath;
}

/**
 * Write `<slug>/config.json` unless it already says the same. Returns "written" or "unchanged".
 * `repoPath` must exist (the schema checks) and `home/` is created for the project's database.
 */
export function writeProjectConfig(
  deps: SetupDeps,
  slug: string,
  facts: ProjectFacts,
): "written" | "unchanged" {
  const own = configPathFor(slug);
  let base: ConfigObject;
  try {
    base = readConfig(deps, baseConfigPath(deps, own, getActive()));
  } catch {
    throw new Error("Could not read a config to start from. Check marshall.config.json.");
  }
  const next: ConfigObject = { ...base, ...facts };
  parseConfig(next, own);
  if (deps.fs.existsSync(own)) {
    const current = readConfig(deps, own);
    if (Object.entries(facts).every(([k, v]) => current[k] === v)) return "unchanged";
  }
  deps.fs.mkdirSync(join(projectDir(slug), "home"), { recursive: true });
  deps.fs.writeFileSync(own, `${JSON.stringify(next, null, 2)}\n`);
  return "written";
}
