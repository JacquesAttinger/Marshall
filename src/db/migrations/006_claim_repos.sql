-- Last edited: 2026-10-18 13:17 PDT
-- Multi-repo claims: one row per repo a claim touches, only for claims that touch more than one.
-- A claim with no rows here is a single-repo claim, exactly as before. The primary repo's worktree
-- is also `claims.worktree_path`; this table adds the siblings and each repo's own PR.

CREATE TABLE claim_repos (
  issue_id      TEXT    NOT NULL REFERENCES claims (issue_id) ON DELETE CASCADE,
  slug          TEXT    NOT NULL,
  role          TEXT    NOT NULL CHECK (role IN ('primary', 'sibling')),
  ord           INTEGER NOT NULL,
  repo_path     TEXT    NOT NULL,
  base_branch   TEXT    NOT NULL,
  worktree_path TEXT    NOT NULL,
  pr_url        TEXT,
  PRIMARY KEY (issue_id, slug)
);
