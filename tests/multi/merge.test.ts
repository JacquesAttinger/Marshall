// Last edited: 2026-10-18 13:17 PDT
// When a multi-repo claim counts as merged or closed, and what the done sweep searches.

import { afterEach, describe, expect, test } from "bun:test";
import { DONE_SWEEP_FLAG, sweepDone } from "../../src/phases/done.ts";
import { isMerged, verdictOf } from "../../src/phases/multi.ts";
import { setClaimRepos, setRepoPr } from "../../src/scheduler/repos.ts";
import { getClaim } from "../../src/scheduler/store.ts";
import { type MasterHarness, makeMasterHarness, masterEvents, PLAN } from "../master/helpers.ts";
import { seedClaim } from "../scheduler/helpers.ts";

let h: MasterHarness;

afterEach(() => {
  h?.close();
});

const view = (state: string, mergedAt: string | null = null) => ({
  mergedAt,
  state,
  ci: "green" as const,
  mergeable: "mergeable" as const,
});
const MERGED = view("MERGED", "2026-10-18T00:00:00Z");

describe("verdictOf", () => {
  test("merged only when every PR merged", () => {
    expect(verdictOf(MERGED, [MERGED])).toBe("merged");
    expect(verdictOf(MERGED, [])).toBe("merged");
  });

  test("waiting while the primary merged and a sibling PR is still open", () => {
    expect(verdictOf(MERGED, [view("OPEN")])).toBe("waiting");
  });

  test("closed when any PR was closed unmerged, even after the primary merged", () => {
    expect(verdictOf(MERGED, [view("CLOSED")])).toBe("closed");
    expect(verdictOf(view("CLOSED"), [MERGED])).toBe("closed");
  });

  test("open while the primary is open", () => {
    expect(verdictOf(view("OPEN"), [MERGED])).toBe("open");
    expect(isMerged(MERGED)).toBe(true);
  });
});

const PRIMARY = "https://github.com/hemut/Command/pull/1";
const SIBLING = "https://github.com/hemut/DB-Migrations/pull/2";

function parkedMultiRepo() {
  seedClaim(h.db, {
    issueId: "issue-1",
    identifier: "CB-1",
    slot: 0,
    state: "awaiting_human",
    branch: "cb-1-issue",
    worktreePath: `${h.home.dir}/wt-CB-1`,
    planPath: PLAN,
    prUrl: PRIMARY,
    claimedAt: h.clock.now.toISOString(),
    updatedAt: h.clock.now.toISOString(),
  });
  h.linear.issues.set("issue-1", {
    issue: {
      id: "issue-1",
      identifier: "CB-1",
      title: "t",
      description: null,
      priority: 3,
      url: "https://linear.app/x/issue/CB-1",
      branchName: "cb-1-issue",
      createdAt: "2026-09-10T00:00:00.000Z",
      labels: [],
      comments: [],
    },
    state: { name: "Needs Verification", type: "started" },
    labels: [],
  });
  setClaimRepos(h.db, "issue-1", [
    {
      slug: "Command",
      role: "primary",
      order: 2,
      repoPath: "/r/c",
      baseBranch: "staging",
      worktreePath: `${h.home.dir}/wt-CB-1`,
    },
    {
      slug: "DB-Migrations",
      role: "sibling",
      order: 1,
      repoPath: "/r/d",
      baseBranch: "main",
      worktreePath: `${h.home.dir}/wt-d`,
    },
  ]);
  setRepoPr(h.db, "issue-1", "Command", PRIMARY);
  setRepoPr(h.db, "issue-1", "DB-Migrations", SIBLING);
}

describe("the merge poll with a sibling PR", () => {
  test("stays parked while the sibling PR is open, then releases and marks Done when both merged", async () => {
    h = makeMasterHarness();
    parkedMultiRepo();
    h.gh.views.set(PRIMARY, { mergedAt: "2026-10-18T00:00:00Z", state: "MERGED" });
    h.gh.views.set(SIBLING, { state: "OPEN" });
    await h.hooks.pulse();
    expect(getClaim(h.db, "issue-1")?.state).toBe("awaiting_human");
    expect(h.linear.stateOf("issue-1")).toBe("Needs Verification");

    h.gh.views.set(SIBLING, { mergedAt: "2026-10-18T01:00:00Z", state: "MERGED" });
    await h.hooks.pulse();
    expect(getClaim(h.db, "issue-1")?.state).toBe("released");
    expect(masterEvents(h.db, "issue-1")).toContain("done");
  });

  test("a sibling PR closed unmerged releases the claim without marking Done", async () => {
    h = makeMasterHarness();
    parkedMultiRepo();
    h.gh.views.set(PRIMARY, { mergedAt: "2026-10-18T00:00:00Z", state: "MERGED" });
    h.gh.views.set(SIBLING, { state: "CLOSED" });
    await h.hooks.pulse();
    expect(getClaim(h.db, "issue-1")?.state).toBe("released");
    expect(masterEvents(h.db, "issue-1")).toContain("pr_closed");
    expect(masterEvents(h.db, "issue-1")).not.toContain("done");
  });
});

describe("the done sweep", () => {
  test("searches every configured repo for the issue's PRs", async () => {
    h = makeMasterHarness();
    const second = h.home.dir;
    h = makeMasterHarness({
      config: {
        repoPath: undefined,
        repos: [
          { slug: "a", repoPath: h.home.dir },
          { slug: "b", repoPath: second },
        ],
      },
    });
    h.linear.issues.set("issue-9", {
      issue: {
        id: "issue-9",
        identifier: "CB-9",
        title: "t",
        description: null,
        priority: 3,
        url: "u",
        branchName: "b",
        createdAt: "2026-09-10T00:00:00.000Z",
        labels: [],
        comments: [],
      },
      state: { name: "Needs Verification", type: "started" },
      labels: [],
    });
    h.db.run("DELETE FROM flags WHERE key = ?", [DONE_SWEEP_FLAG]);
    await sweepDone(h.deps);
    const searches = h.gh.calls.filter((c) => c[0] === "pr" && c[1] === "list");
    expect(searches).toHaveLength(2);
  });
});
