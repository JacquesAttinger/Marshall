// Last edited: 2026-10-18 13:17 PDT
// Which repos an issue touches. A plan's `## Repos touched` section names them; an issue with no
// plan, or a plan with no such section, uses the default repo (the first in the config). Pure: it
// reads the config and the issue text, and never touches disk or Linear.

import type { Config, RepoConfig } from "./config.ts";
import { isHasPlan, type PickableIssue } from "./linear/index.ts";
import { parseReposTouched, type RepoRole } from "./plan/intake.ts";

export interface ClaimRepoSpec {
  repo: RepoConfig;
  role: RepoRole;
  /** 1-based; the merge order the hand-off prints. */
  order: number;
}

export type RepoResolution =
  | { ok: true; repos: ClaimRepoSpec[]; explicit: boolean }
  | { ok: false; error: string };

export function repoBySlug(config: Config, slug: string): RepoConfig | undefined {
  return config.repos.find((r) => r.slug.toLowerCase() === slug.toLowerCase());
}

/** The default repo: the first entry, which is what `config.repoPath` names. */
export function defaultRepo(config: Config): RepoConfig {
  return config.repos[0] as RepoConfig;
}

/**
 * The repos for an issue, primary first. An issue that carries its plan in its body and lists
 * repos gets exactly those (unknown slug: an error naming the known ones). A plan in a project
 * with several repos must list them. Anything else gets the default repo alone, which is the
 * single-repo behavior every existing project has.
 */
export function resolveRepos(
  config: Config,
  issue: Pick<PickableIssue, "labels" | "description">,
): RepoResolution {
  const listed = isHasPlan(issue.labels) ? parseReposTouched(issue.description ?? "") : [];
  if (listed.length === 0 && isHasPlan(issue.labels) && config.repos.length > 1) {
    // A misspelled heading would otherwise drop every sibling repo without a word.
    return {
      ok: false,
      error: `the plan has no "Repos touched" section, and this project has ${config.repos.length} repos`,
    };
  }
  if (listed.length === 0) {
    const repos = [{ repo: defaultRepo(config), role: "primary" as const, order: 1 }];
    return { ok: true, explicit: false, repos };
  }
  const specs: ClaimRepoSpec[] = [];
  for (const ref of listed) {
    const repo = repoBySlug(config, ref.slug);
    if (!repo) {
      const known = config.repos.map((r) => r.slug).join(", ");
      return { ok: false, error: `repo "${ref.slug}" is not in the config (known: ${known})` };
    }
    specs.push({ repo, role: ref.role, order: ref.order });
  }
  const primary = specs.findIndex((s) => s.role === "primary");
  if (primary < 0) return { ok: false, error: `"Repos touched" names no primary repo` };
  const [first] = specs.splice(primary, 1);
  return { ok: true, explicit: true, repos: [first as ClaimRepoSpec, ...specs] };
}
