// Last edited: 2026-10-18 13:40 PDT
// Regression tests for the review findings on multi-repo claims: a sibling repo with no PR is not
// merged, rebases stay inside one repo and skip a merged primary, a fresh restart keeps the sibling
// PRs, the done sweep needs every repo merged, and a plan must list repos in a multi-repo project.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { enqueuePlan } from "../../src/cli/enqueue.ts";
import { parseConfig } from "../../src/config.ts";
import { repoOfPr, sweepMergedPr, verdictOf } from "../../src/phases/multi.ts";
import { resolveRepos } from "../../src/repos.ts";
import { claimRepos, setClaimRepos, setRepoPr } from "../../src/scheduler/repos.ts";
import { getClaim } from "../../src/scheduler/store.ts";
import { type TempHome, useTempHome } from "../helpers.ts";
import {
  claimFor,
  type MasterHarness,
  makeMasterHarness,
  masterEvents,
  PLAN,
  registerIssue,
  until,
  writeStatus,
} from "../master/helpers.ts";
import { seedClaim } from "../scheduler/helpers.ts";

let h: MasterHarness;
let home: TempHome;

beforeEach(() => {
  home = useTempHome();
});

afterEach(() => {
  h?.close();
  home.restore();
});

const view = (state: string, mergedAt: string | null = null) => ({
  mergedAt,
  state,
  ci: "green" as const,
  mergeable: "mergeable" as const,
});
const MERGED = view("MERGED", "2026-10-18T00:00:00Z");

const PR_CMD = "https://github.com/hemut/Command/pull/1";
const PR_DB = "https://github.com/hemut/DB-Migrations/pull/2";
const PR_OTHER_CMD = "https://github.com/hemut/Command/pull/3";
const PR_ZONES = "https://github.com/hemut/zones/pull/4";

function parked(n: number, prUrl: string, extra: Record<string, unknown> = {}) {
  const harness = h;
  seedClaim(harness.db, {
    issueId: `issue-${n}`,
    identifier: `CB-${n}`,
    slot: 0,
    state: "awaiting_human",
    branch: `cb-${n}-issue`,
    worktreePath: `${harness.home.dir}/wt-CB-${n}`,
    planPath: PLAN,
    prUrl,
    claimedAt: new Date(harness.clock.now.getTime() - n * 60_000).toISOString(),
    updatedAt: harness.clock.now.toISOString(),
    ...extra,
  });
  harness.linear.issues.set(`issue-${n}`, {
    issue: {
      id: `issue-${n}`,
      identifier: `CB-${n}`,
      title: `Issue ${n}`,
      description: null,
      priority: 3,
      url: `https://linear.app/x/issue/CB-${n}`,
      branchName: `cb-${n}-issue`,
      createdAt: "2026-09-10T00:00:00.000Z",
      labels: [],
      comments: [],
    },
    state: { name: "Needs Verification", type: "started" },
    labels: [],
  });
}

const rowFor = (slug: string, role: "primary" | "sibling", order: number, dir: string) => ({
  slug,
  role,
  order,
  repoPath: `/r/${slug}`,
  baseBranch: "staging",
  worktreePath: dir,
});

describe("a sibling repo with no PR is not merged", () => {
  test("verdictOf waits while a sibling repo has no PR recorded", () => {
    expect(verdictOf(MERGED, [], 1)).toBe("waiting");
    expect(verdictOf(MERGED, [MERGED], 0)).toBe("merged");
  });

  test("the poll keeps the claim parked when the primary merged but the sibling never opened a PR", async () => {
    h = makeMasterHarness();
    parked(1, PR_CMD);
    setClaimRepos(h.db, "issue-1", [
      rowFor("Command", "primary", 2, `${h.home.dir}/wt-CB-1`),
      rowFor("DB-Migrations", "sibling", 1, `${h.home.dir}/wt-d`),
    ]);
    setRepoPr(h.db, "issue-1", "Command", PR_CMD);
    h.gh.views.set(PR_CMD, { mergedAt: "2026-10-18T00:00:00Z", state: "MERGED" });
    await h.hooks.pulse();
    expect(getClaim(h.db, "issue-1")?.state).toBe("awaiting_human");
    expect(masterEvents(h.db, "issue-1")).not.toContain("done");
  });
});

describe("rebases stay inside one repo", () => {
  test("repoOfPr reads owner/repo from a PR URL", () => {
    expect(repoOfPr(PR_CMD)).toBe("https://github.com/hemut/Command");
    expect(repoOfPr("not a url")).toBeNull();
  });

  test("a merged PR queues only the waiting PRs of its own repo", async () => {
    h = makeMasterHarness();
    parked(1, PR_CMD);
    parked(2, PR_OTHER_CMD);
    parked(3, PR_ZONES);
    h.gh.views.set(PR_CMD, { mergedAt: "2026-10-18T00:00:00Z", state: "MERGED" });
    await h.hooks.pulse();
    expect(getClaim(h.db, "issue-2")?.rebaseAfter).toBe(PR_CMD);
    expect(getClaim(h.db, "issue-3")?.rebaseAfter).toBeNull();
  });

  test("a merged multi-repo claim queues the waiting PRs of every repo it merged into", async () => {
    h = makeMasterHarness();
    parked(1, PR_CMD);
    setClaimRepos(h.db, "issue-1", [
      rowFor("Command", "primary", 2, `${h.home.dir}/wt-CB-1`),
      rowFor("zones", "sibling", 1, `${h.home.dir}/wt-z`),
    ]);
    setRepoPr(h.db, "issue-1", "Command", PR_CMD);
    setRepoPr(h.db, "issue-1", "zones", "https://github.com/hemut/zones/pull/9");
    parked(2, PR_OTHER_CMD);
    parked(3, PR_ZONES);
    parked(4, PR_DB);
    h.gh.views.set(PR_CMD, { mergedAt: "2026-10-18T00:00:00Z", state: "MERGED" });
    h.gh.views.set("https://github.com/hemut/zones/pull/9", {
      mergedAt: "2026-10-18T00:00:00Z",
      state: "MERGED",
    });
    await h.hooks.pulse();
    expect(getClaim(h.db, "issue-1")?.state).toBe("released");
    expect(getClaim(h.db, "issue-2")?.rebaseAfter).toBe(PR_CMD);
    expect(getClaim(h.db, "issue-3")?.rebaseAfter).toBe("https://github.com/hemut/zones/pull/9");
    expect(getClaim(h.db, "issue-4")?.rebaseAfter).toBeNull();
  });

  test("a parked multi-repo claim whose primary already merged is never rebased", async () => {
    h = makeMasterHarness();
    parked(1, PR_CMD, { rebaseAfter: PR_OTHER_CMD });
    setClaimRepos(h.db, "issue-1", [
      rowFor("Command", "primary", 2, `${h.home.dir}/wt-CB-1`),
      rowFor("DB-Migrations", "sibling", 1, `${h.home.dir}/wt-d`),
    ]);
    setRepoPr(h.db, "issue-1", "Command", PR_CMD);
    setRepoPr(h.db, "issue-1", "DB-Migrations", PR_DB);
    h.gh.views.set(PR_CMD, { mergedAt: "2026-10-18T00:00:00Z", state: "MERGED" });
    h.gh.views.set(PR_DB, { state: "OPEN" });
    await h.hooks.pulse();
    await h.hooks.pulse();
    expect(h.git.calls.filter((c) => c.op === "rebase" || c.op === "forcePush")).toEqual([]);
    expect(getClaim(h.db, "issue-1")).toMatchObject({ state: "awaiting_human", rebaseAfter: null });
  });
});

describe("a fresh restart keeps the sibling PRs", () => {
  test("only the primary is reset; the sibling's PR URL stays for the merge poll", async () => {
    h = makeMasterHarness({ config: { maxResumes: 1 } });
    const issue = registerIssue(h, "CB-1");
    const claim = claimFor(h, issue);
    setClaimRepos(h.db, issue.id, [
      rowFor("Command", "primary", 2, claim.worktreePath as string),
      rowFor("DB-Migrations", "sibling", 1, "/wt/d"),
    ]);
    setRepoPr(h.db, issue.id, "DB-Migrations", PR_DB);
    await h.hooks.start(claim, issue);
    await until(() => h.runner.launches.length >= 1, 2000, "implement launch");
    writeStatus("CB-1", { outcome: null, phase: "implementing", prUrl: null, ciState: null });

    // One resume is allowed; the second stall is a fresh restart.
    const first = h.runner.launches[0]?.runId as string;
    h.runner.stalled.add(first);
    await h.hooks.pulse();
    await until(() => h.runner.resumes.length === 1, 2000, "resume");
    h.runner.stalled.delete(first);
    h.runner.stalled.add(h.runner.resumes[0]?.runId as string);
    await h.hooks.pulse();
    await until(() => h.runner.launches.length === 2, 2000, "fresh launch");

    expect(getClaim(h.db, issue.id)?.freshRestarts).toBe(1);
    expect(claimRepos(h.db, issue.id).find((r) => r.slug === "DB-Migrations")?.prUrl).toBe(PR_DB);
  });
});

describe("the done sweep needs every repo merged", () => {
  const found = (state: string, mergedAt: string | null = null) => ({
    number: 1,
    url: "u",
    title: "CB-1: x",
    state,
    mergedAt,
  });

  test("a single-repo issue is credited with its merged PR", () => {
    const byRepo = new Map([["/r/Command", [found("MERGED", "t")]]]);
    expect(sweepMergedPr(byRepo, [])?.state).toBe("MERGED");
  });

  test("a two-repo issue with only one repo merged is not Done", () => {
    const byRepo = new Map([
      ["/r/DB-Migrations", [found("MERGED", "t")]],
      ["/r/Command", [found("OPEN")]],
    ]);
    expect(sweepMergedPr(byRepo, ["/r/Command", "/r/DB-Migrations"])).toBeNull();
  });

  test("a two-repo issue whose second repo has no PR at all is not Done", () => {
    const byRepo = new Map([["/r/DB-Migrations", [found("MERGED", "t")]]]);
    expect(sweepMergedPr(byRepo, ["/r/Command", "/r/DB-Migrations"])).toBeNull();
  });

  test("a two-repo issue with a merged PR in each repo is Done, crediting the primary's", () => {
    const primary = { ...found("MERGED", "t"), url: "primary-url" };
    const byRepo = new Map([
      ["/r/Command", [primary]],
      ["/r/DB-Migrations", [found("MERGED", "t")]],
    ]);
    expect(sweepMergedPr(byRepo, ["/r/Command", "/r/DB-Migrations"])?.url).toBe("primary-url");
  });
});

describe("a plan must list repos in a project with several repos", () => {
  const body = "# P\n\n## TLDR\n\nx\n\n## Plan\n\ny\n\n## Verification\n\nz\n";

  function config() {
    for (const name of ["Command", "DB-Migrations"]) mkdirSync(join(home.dir, name));
    return parseConfig({
      workspace: "w",
      teamId: "t",
      repos: [
        { slug: "Command", repoPath: join(home.dir, "Command") },
        { slug: "DB-Migrations", repoPath: join(home.dir, "DB-Migrations") },
      ],
    });
  }

  test("the scheduler refuses a has-plan issue with no Repos touched section", () => {
    const r = resolveRepos(config(), { labels: ["marshall:has-plan"], description: body });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain('no "Repos touched" section');
  });

  test("a project with one repo does not need the section", () => {
    mkdirSync(join(home.dir, "solo"));
    const solo = parseConfig({ workspace: "w", teamId: "t", repoPath: join(home.dir, "solo") });
    expect(resolveRepos(solo, { labels: ["marshall:has-plan"], description: body }).ok).toBe(true);
  });

  test("enqueue refuses the plan up front when the config has several repos", async () => {
    const linear = { createQueuedPlan: async () => Promise.reject(new Error("not reached")) };
    const attempt = enqueuePlan({ text: body, linear, knownRepos: ["Command", "DB-Migrations"] });
    await expect(attempt).rejects.toThrow(/Repos touched/);
    const single = enqueuePlan({ text: body, linear, knownRepos: ["Command"], dryRun: true });
    await expect(single).resolves.toMatchObject({ repos: [] });
  });
});
