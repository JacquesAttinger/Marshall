// Last edited: 2026-10-18 18:10 PDT
// The implement phase on a multi-repo claim: sibling worktrees reach the agent, and the PR it opened
// in each repo is read back from implement.json onto the claim's repo rows.

import { afterEach, describe, expect, test } from "bun:test";
import { claimRepos, setClaimRepos } from "../../src/scheduler/repos.ts";
import {
  claimFor,
  type MasterHarness,
  makeMasterHarness,
  registerIssue,
  until,
  writeStatus,
} from "../master/helpers.ts";

let h: MasterHarness;

afterEach(() => {
  h?.close();
});

const PR_PRIMARY = "https://github.com/hemut/Command/pull/12";
const PR_SIBLING = "https://github.com/hemut/DB-Migrations/pull/7";

describe("implement phase, multi-repo", () => {
  test("launches with --add-dir per sibling and the repos JSON, then stores each repo's PR", async () => {
    h = makeMasterHarness();
    const issue = registerIssue(h, "CB-1");
    const claim = claimFor(h, issue);
    setClaimRepos(h.db, issue.id, [
      {
        slug: "Command",
        role: "primary",
        order: 2,
        repoPath: "/r/c",
        baseBranch: "staging",
        worktreePath: claim.worktreePath as string,
      },
      {
        slug: "DB-Migrations",
        role: "sibling",
        order: 1,
        repoPath: "/r/d",
        baseBranch: "main",
        worktreePath: "/wt/d",
      },
    ]);
    await h.hooks.start(claim, issue);
    await until(() => h.runner.launches.length >= 1, 2000, "implement launch");

    const launch = h.runner.launches[0]?.opts;
    expect(launch?.extraArgs?.slice(-2)).toEqual(["--add-dir", "/wt/d"]);
    expect(launch?.env?.MARSHALL_BASE_BRANCH).toBe("staging");
    expect(JSON.parse(launch?.env?.MARSHALL_REPOS_JSON as string)).toHaveLength(2);

    writeStatus("CB-1", {
      prUrl: PR_PRIMARY,
      prs: [
        { repo: "Command", url: PR_PRIMARY, draft: false },
        { repo: "DB-Migrations", url: PR_SIBLING, draft: false },
      ],
    });
    h.waiter.finish(h.runner.launches[0]?.runId as string, { kind: "finished" });
    await h.hooks.settled();

    expect(claimRepos(h.db, issue.id).map((r) => [r.slug, r.prUrl])).toEqual([
      ["DB-Migrations", PR_SIBLING],
      ["Command", PR_PRIMARY],
    ]);
  });

  test("implementSkill implement-hemut launches the Hemut skill", async () => {
    h = makeMasterHarness({ config: { implementSkill: "implement-hemut" } });
    const issue = registerIssue(h, "CB-1");
    await h.hooks.start(claimFor(h, issue), issue);
    await until(() => h.runner.launches.length >= 1, 2000, "implement launch");
    expect(h.runner.launches[0]?.opts.prompt).toBe(
      "/marshall:implement-hemut docs/fix-castling_plan.md CB-1",
    );
  });
});
