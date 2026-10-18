// Last edited: 2026-10-18 13:17 PDT
// Per-slot isolation for agents that share one laptop: each slot gets its own Compose project
// name and its own host ports, handed to the agent through the settings `env` key (see
// docs/isolation.md). Nothing here runs Docker; the skill does, with these vars in its env.

import type { Config } from "./config.ts";
import { issueDir } from "./paths.ts";
import type { ClaimRepo } from "./scheduler/repos.ts";

export class IsolationError extends Error {
  override name = "IsolationError";
}

/** `marshall-<slot>`: the Compose project name, which also prefixes volumes and images. */
export function composeProjectName(slot: number): string {
  return `marshall-${slot}`;
}

function assertSlot(slot: number, config: Config): void {
  if (!Number.isInteger(slot) || slot < 0 || slot >= config.maxAgents) {
    throw new IsolationError(`slot must be an integer in [0, ${config.maxAgents}); got ${slot}`);
  }
}

/**
 * The env every Bash call in slot `slot` runs with: the slot number, the Compose project name,
 * and one host-port var per configured service (`base + slot * portOffsetPerSlot`).
 * Values are strings because they land in a settings JSON `env` block.
 */
export function slotEnv(
  slot: number,
  config: Config,
  repos: readonly ClaimRepo[] = [],
): Record<string, string> {
  assertSlot(slot, config);
  const env: Record<string, string> = {
    MARSHALL_SLOT: String(slot),
    COMPOSE_PROJECT_NAME: composeProjectName(slot),
  };
  // A multi-repo claim runs every repo's Compose stack in one slot: merge each repo's own ports.
  const services = { ...config.services };
  for (const claimRepo of repos) {
    const repo = config.repos.find((r) => r.slug === claimRepo.slug);
    Object.assign(services, repo?.services);
  }
  for (const [name, base] of Object.entries(services)) {
    const portNumber = base + slot * config.portOffsetPerSlot;
    if (portNumber > 65535) {
      throw new IsolationError(`${name} for slot ${slot} would be ${portNumber}, above 65535`);
    }
    env[name] = String(portNumber);
  }
  return env;
}

/**
 * `slotEnv` plus what `/marshall:implement` needs: where its status file goes, the issue URL for
 * the PR body, the review-cycle cap (`config.maxFixCycles`), and the branch PRs target.
 */
export function implementEnv(
  issueId: string,
  issueUrl: string,
  slot: number,
  config: Config,
  repos: readonly ClaimRepo[] = [],
): Record<string, string> {
  return {
    ...slotEnv(slot, config, repos),
    MARSHALL_ISSUE_DIR: issueDir(issueId),
    MARSHALL_ISSUE_URL: issueUrl,
    MARSHALL_MAX_CYCLES: String(config.maxFixCycles),
    ...reposEnv(config, repos),
  };
}

/**
 * The base branch of the primary repo, and for a multi-repo claim `MARSHALL_REPOS_JSON`: one entry
 * per repo in merge order, with the worktree directory and the branch its PR targets.
 */
export function reposEnv(config: Config, repos: readonly ClaimRepo[]): Record<string, string> {
  const primary = repos.find((r) => r.role === "primary");
  const env: Record<string, string> = {
    MARSHALL_BASE_BRANCH: primary?.baseBranch ?? config.baseBranch,
  };
  if (repos.length > 0) {
    env.MARSHALL_REPOS_JSON = JSON.stringify(
      repos.map((r) => ({
        slug: r.slug,
        role: r.role,
        order: r.order,
        dir: r.worktreePath,
        base: r.baseBranch,
      })),
    );
  }
  return env;
}
