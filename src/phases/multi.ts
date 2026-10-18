// Last edited: 2026-10-18 17:15 PDT
// The multi-repo side of merge detection. A claim that touches several repos has one PR per repo;
// it counts as merged only when all of them merged, and as closed when any was closed unmerged.
// A single-repo claim has no `claim_repos` rows, so every function here returns the neutral answer.

import type { MasterDeps } from "../master/types.ts";
import { type Claim, claimRepos } from "../scheduler/index.ts";
import { type PrView, viewPr } from "./pr.ts";

export function isMerged(view: Pick<PrView, "mergedAt" | "state">): boolean {
  return Boolean(view.mergedAt) || view.state === "MERGED";
}

/** `gh pr view` for every sibling repo's PR that exists. [] for a single-repo claim. */
export async function viewSiblingPrs(deps: MasterDeps, claim: Claim): Promise<PrView[]> {
  const siblings = claimRepos(deps.db, claim.issueId).filter(
    (r) => r.role === "sibling" && r.prUrl,
  );
  const views: PrView[] = [];
  for (const repo of siblings) {
    views.push(
      await viewPr(deps.gh, repo.prUrl as string, repo.worktreePath, claim.updatedAt, deps.now()),
    );
  }
  return views;
}

export type PrVerdict = "merged" | "closed" | "waiting" | "open";

/**
 * What the claim's PRs say together. `waiting`: the primary merged but a sibling PR is still open,
 * so the claim stays parked. `open`: the primary is open (the rebase logic may act on it).
 */
export function verdictOf(primary: PrView, siblings: PrView[]): PrVerdict {
  const all = [primary, ...siblings];
  if (all.every(isMerged)) return "merged";
  if (all.some((v) => v.state === "CLOSED" && !isMerged(v))) return "closed";
  return isMerged(primary) ? "waiting" : "open";
}
