// Last edited: 2026-10-18 16:25 PDT
// Open one worktree per repo of a claim, all on the same branch name, so one agent can work in
// every repo a plan touches. The primary repo's worktree comes first and is the claim's cwd.

import type { ClaimRepoSpec } from "../repos.ts";
import type { ClaimRepo } from "./repos.ts";
import type { WorktreeOps } from "./types.ts";

export interface OpenedWorktrees {
  /** The primary repo's worktree: `claims.worktree_path`. */
  primaryPath: string;
  /**
   * Every repo of the claim, in merge order, for `claim_repos`. Empty when the plan named no
   * repos: the claim then lives in the default repo, as every single-repo project does.
   */
  rows: Omit<ClaimRepo, "issueId" | "prUrl">[];
}

/**
 * Create (or, on a bounce, reuse) a worktree in each repo. Throws on the first failure; the
 * worktrees already made stay on disk, as they do for a single-repo failure today.
 */
export async function openClaimWorktrees(
  worktrees: WorktreeOps,
  specs: ClaimRepoSpec[],
  branch: string,
  bounce: boolean,
  explicit: boolean,
): Promise<OpenedWorktrees> {
  const rows: OpenedWorktrees["rows"] = [];
  for (const { repo, role, order } of specs) {
    const spec = { repoPath: repo.repoPath, branch, baseBranch: repo.baseBranch };
    const worktreePath = bounce ? await worktrees.reuse(spec) : await worktrees.create(spec);
    rows.push({
      slug: repo.slug,
      role,
      order,
      repoPath: repo.repoPath,
      baseBranch: repo.baseBranch,
      worktreePath,
    });
  }
  const primary =
    rows.find((r) => r.role === "primary") ?? (rows[0] as OpenedWorktrees["rows"][number]);
  return { primaryPath: primary.worktreePath, rows: explicit ? rows : [] };
}
