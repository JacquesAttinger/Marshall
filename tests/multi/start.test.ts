// Last edited: 2026-10-18 18:00 PDT
// A multi-repo plan through the scheduler: one worktree per repo on one branch, the primary's path on
// the claim, the sibling rows, and a plan that names an unknown repo blocking cleanly.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { claimRepos } from "../../src/scheduler/repos.ts";
import { getClaim } from "../../src/scheduler/store.ts";
import { tick } from "../../src/scheduler/tick.ts";
import { type TempHome, useTempHome } from "../helpers.ts";
import { pickable } from "../scheduler/fake-client.ts";
import { type Harness, makeHarness } from "../scheduler/helpers.ts";

let home: TempHome;
let h: Harness;

beforeEach(() => {
  home = useTempHome();
  for (const name of ["Command", "DB-Migrations"]) mkdirSync(join(home.dir, name));
});

afterEach(() => {
  h?.close();
  home.restore();
});

const config = () => ({
  repoPath: undefined,
  pickup: "labeled",
  repos: [
    { slug: "Command", repoPath: join(home.dir, "Command"), baseBranch: "staging" },
    { slug: "DB-Migrations", repoPath: join(home.dir, "DB-Migrations"), baseBranch: "main" },
  ],
});

const plan = (lines: string[]) =>
  `# P\n\n## TLDR\n\nx\n\n## Repos touched\n\n${lines.join("\n")}\n\n## Plan\n\ny\n\n## Verification\n\nz\n`;

function planIssue(lines: string[]) {
  return pickable({
    identifier: "AND-1",
    branchName: "me/and-1-add-a-column",
    labels: ["marshall:queued", "marshall:has-plan"],
    description: plan(lines),
  });
}

describe("tick with a multi-repo plan", () => {
  test("opens a worktree in each repo on one branch and records the siblings", async () => {
    h = makeHarness({
      config: config(),
      issues: [planIssue(["- DB-Migrations: sibling", "- Command: primary"])],
    });
    const result = await tick(h.deps);
    expect(result.decisions[0]).toMatchObject({ identifier: "AND-1", action: "started" });
    expect(
      h.worktreeCalls.map((c) => [c.op, c.spec.repoPath, c.spec.baseBranch, c.spec.branch]),
    ).toEqual([
      ["create", join(home.dir, "Command"), "staging", "me/and-1-add-a-column"],
      ["create", join(home.dir, "DB-Migrations"), "main", "me/and-1-add-a-column"],
    ]);
    const claim = getClaim(h.db, "issue-1");
    expect(claim?.worktreePath).toBe(`${join(home.dir, "Command")}-me/and-1-add-a-column`);
    expect(claimRepos(h.db, "issue-1").map((r) => [r.slug, r.role, r.order])).toEqual([
      ["DB-Migrations", "sibling", 1],
      ["Command", "primary", 2],
    ]);
  });

  test("a plan that names only a non-default repo still records it, so its base branch is used", async () => {
    h = makeHarness({ config: config(), issues: [planIssue(["- DB-Migrations: primary"])] });
    await tick(h.deps);
    expect(h.worktreeCalls).toHaveLength(1);
    expect(h.worktreeCalls[0]?.spec.baseBranch).toBe("main");
    expect(claimRepos(h.db, "issue-1").map((r) => r.slug)).toEqual(["DB-Migrations"]);
  });

  test("an unknown repo blocks the issue before any worktree exists", async () => {
    h = makeHarness({ config: config(), issues: [planIssue(["- Nope: primary"])] });
    const result = await tick(h.deps);
    expect(result.decisions[0]).toMatchObject({ action: "skipped", reason: "start_failed" });
    expect(h.worktreeCalls).toEqual([]);
    expect(h.linear.comments.at(-1)?.body).toContain('repo "Nope" is not in the config');
    expect(getClaim(h.db, "issue-1")?.state).toBe("blocked");
  });

  test("an issue with no repos section gets the default repo and no sibling rows", async () => {
    h = makeHarness({
      config: config(),
      issues: [
        pickable({ identifier: "AND-2", labels: ["marshall:queued"], description: "do it" }),
      ],
    });
    await tick(h.deps);
    expect(h.worktreeCalls.map((c) => c.spec.repoPath)).toEqual([join(home.dir, "Command")]);
    expect(claimRepos(h.db, "issue-2")).toEqual([]);
  });
});
