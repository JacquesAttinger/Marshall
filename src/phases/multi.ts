// Last edited: 2026-10-18 13:17 PDT
// The multi-repo side of merge detection. A claim that touches several repos has one PR per repo;
// it counts as merged only when all of them merged, and as closed when any was closed unmerged.
// A single-repo claim has no `claim_repos` rows, so every function here returns the neutral answer.

import type { MasterDeps } from "../master/types.ts";
import { type Claim, claimRepos, patchClaim } from "../scheduler/index.ts";
import { type FoundPr, type PrView, viewPr } from "./pr.ts";

export function isMerged(view: Pick<PrView, "mergedAt" | "state">): boolean {
  return Boolean(view.mergedAt) || view.state === "MERGED";
}

export interface SiblingPrs {
  /** `gh pr view` for every sibling repo's PR that exists. */
  views: PrView[];
  /** Sibling repos with no PR recorded: the claim cannot count as merged while one is missing. */
  missing: number;
}

/** The sibling repos' PR states. `{ views: [], missing: 0 }` for a single-repo claim. */
export async function viewSiblingPrs(deps: MasterDeps, claim: Claim): Promise<SiblingPrs> {
  const siblings = claimRepos(deps.db, claim.issueId).filter((r) => r.role === "sibling");
  const views: PrView[] = [];
  for (const repo of siblings.filter((r) => r.prUrl)) {
    views.push(
      await viewPr(deps.gh, repo.prUrl as string, repo.worktreePath, claim.updatedAt, deps.now()),
    );
  }
  return { views, missing: siblings.filter((r) => !r.prUrl).length };
}

/** `https://github.com/o/r/pull/12` -> `https://github.com/o/r`; null when it is not a PR URL. */
export function repoOfPr(url: string): string | null {
  return /^(https?:\/\/[^/]+\/[^/]+\/[^/]+)\/pull\/\d+/.exec(url)?.[1] ?? null;
}

/** Every PR URL of the claim, primary first: the ones whose merge moves a base branch. */
export function prUrlsOf(deps: Pick<MasterDeps, "db">, claim: Claim): string[] {
  const siblings = claimRepos(deps.db, claim.issueId).filter(
    (r) => r.role === "sibling" && r.prUrl,
  );
  return [claim.prUrl, ...siblings.map((r) => r.prUrl)].filter((u): u is string => Boolean(u));
}

/**
 * A parked multi-repo claim whose primary PR already merged must not be rebased: the branch is
 * gone from the queue's point of view. Clears the queued rebase and returns true in that case.
 */
export async function dropRebaseIfMerged(
  deps: MasterDeps,
  claim: Claim,
  cwd: string,
): Promise<boolean> {
  if (claimRepos(deps.db, claim.issueId).length === 0 || !claim.prUrl) return false;
  const view = await viewPr(deps.gh, claim.prUrl, cwd, claim.updatedAt, deps.now());
  if (!isMerged(view)) return false;
  patchClaim(deps.db, claim.issueId, { rebaseAfter: null }, deps.now().toISOString());
  return true;
}

/**
 * The PR a done sweep credits. None while any PR is open. A multi-repo issue (`expectedRepoPaths`
 * from the claim's repo rows) needs a merged PR in every one of its repos; a single-repo issue
 * needs just one merged PR.
 */
export function sweepMergedPr(
  byRepo: Map<string, FoundPr[]>,
  expectedRepoPaths: string[],
): FoundPr | null {
  const all = [...byRepo.values()].flat();
  if (all.some((pr) => pr.state === "OPEN")) return null;
  const isDone = (pr: FoundPr) => Boolean(pr.mergedAt) || pr.state === "MERGED";
  for (const path of expectedRepoPaths) {
    if (!(byRepo.get(path) ?? []).some(isDone)) return null;
  }
  const first = expectedRepoPaths[0];
  const pool = first ? (byRepo.get(first) ?? []) : all;
  return pool.find(isDone) ?? null;
}

export type PrVerdict = "merged" | "closed" | "waiting" | "open";

/**
 * What the claim's PRs say together. `waiting`: the primary merged but a sibling PR is still open,
 * so the claim stays parked; so does a sibling repo with no PR recorded (`missing`). `open`: the
 * primary is open (the rebase logic may act on it).
 */
export function verdictOf(primary: PrView, siblings: PrView[], missing = 0): PrVerdict {
  const all = [primary, ...siblings];
  if (all.every(isMerged)) return missing > 0 ? "waiting" : "merged";
  if (all.some((v) => v.state === "CLOSED" && !isMerged(v))) return "closed";
  return isMerged(primary) ? "waiting" : "open";
}
