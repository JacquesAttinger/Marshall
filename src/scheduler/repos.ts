// Last edited: 2026-10-18 13:17 PDT
// Row helpers for `claim_repos`: the repos a multi-repo claim touches. A claim with no rows is a
// single-repo claim. The primary repo's worktree is also `claims.worktree_path`.

import type { Database } from "bun:sqlite";
import type { Config } from "../config.ts";

export type ClaimRepoRole = "primary" | "sibling";

export interface ClaimRepo {
  issueId: string;
  slug: string;
  role: ClaimRepoRole;
  /** Position in the plan's list; the merge order. */
  order: number;
  repoPath: string;
  baseBranch: string;
  worktreePath: string;
  prUrl: string | null;
}

interface Row {
  issue_id: string;
  slug: string;
  role: string;
  ord: number;
  repo_path: string;
  base_branch: string;
  worktree_path: string;
  pr_url: string | null;
}

function toRepo(r: Row): ClaimRepo {
  return {
    issueId: r.issue_id,
    slug: r.slug,
    role: r.role as ClaimRepoRole,
    order: r.ord,
    repoPath: r.repo_path,
    baseBranch: r.base_branch,
    worktreePath: r.worktree_path,
    prUrl: r.pr_url,
  };
}

/** Every repo of the claim in merge order, or [] for a single-repo claim. */
export function claimRepos(db: Database, issueId: string): ClaimRepo[] {
  const rows = db
    .query<Row, [string]>("SELECT * FROM claim_repos WHERE issue_id = ? ORDER BY ord")
    .all(issueId);
  return rows.map(toRepo);
}

/** The sibling repos only (what an agent gets as extra directories). */
export function siblingRepos(db: Database, issueId: string): ClaimRepo[] {
  return claimRepos(db, issueId).filter((r) => r.role === "sibling");
}

/**
 * Replace the claim's repo rows. A start or a bounce re-writes them, with no PR yet: like
 * `claims.pr_url`, the URLs are read back from implement.json once the implement phase runs.
 */
export function setClaimRepos(
  db: Database,
  issueId: string,
  repos: Omit<ClaimRepo, "issueId" | "prUrl">[],
): void {
  db.transaction(() => {
    db.run("DELETE FROM claim_repos WHERE issue_id = ?", [issueId]);
    for (const r of repos) {
      db.run(
        `INSERT INTO claim_repos
           (issue_id, slug, role, ord, repo_path, base_branch, worktree_path, pr_url)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [issueId, r.slug, r.role, r.order, r.repoPath, r.baseBranch, r.worktreePath, null],
      );
    }
  })();
}

/** Record the PR the implement phase opened in one repo. Unknown slug: nothing changes. */
export function setRepoPr(db: Database, issueId: string, slug: string, prUrl: string | null): void {
  db.run("UPDATE claim_repos SET pr_url = ? WHERE issue_id = ? AND slug = ?", [
    prUrl,
    issueId,
    slug,
  ]);
}

/** Forget the PR URLs, as a fresh restart or a bounce does for the claim's own `pr_url`. */
export function clearRepoPrs(db: Database, issueId: string): void {
  db.run("UPDATE claim_repos SET pr_url = NULL WHERE issue_id = ?", [issueId]);
}

/** The branch the claim's primary repo starts from and its PR targets. */
export function claimBase(db: Database, config: Config, issueId: string): string {
  const primary = claimRepos(db, issueId).find((r) => r.role === "primary");
  return primary?.baseBranch ?? config.baseBranch;
}

/** `--add-dir <worktree>` for every sibling repo, so the agent may read and edit all of them. */
export function siblingDirArgs(db: Database, issueId: string): string[] {
  return siblingRepos(db, issueId).flatMap((r) => ["--add-dir", r.worktreePath]);
}
