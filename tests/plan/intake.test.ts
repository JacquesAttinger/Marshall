// Last edited: 2026-10-18 14:50 PDT
// Plan intake: the pure checks, the `Repos touched` parser, and the one git commit it makes.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  checkIntakePlan,
  intakeCommitSubject,
  intakePlanPath,
  parseReposTouched,
  planSourceOf,
  runPlanIntake,
} from "../../src/plan/intake.ts";
import { isPlanPath } from "../../src/plan/template.ts";
import { git, makeRepo, sampleIssue, type TempRepo } from "./helpers.ts";

const PLAN = `# Plan: add a thing

## TLDR

Add a thing.

## Repos touched

- DB-Migrations: sibling
- Command: primary

## Plan

1. Do it.

## Verification

1. Check it.
`;

let repo: TempRepo;

beforeEach(() => {
  repo = makeRepo();
});

afterEach(() => {
  repo.remove();
});

describe("planSourceOf", () => {
  test("returns the body only for an issue with the has-plan label", () => {
    expect(planSourceOf(sampleIssue({ labels: ["marshall:has-plan"], description: PLAN }))).toBe(
      PLAN.trim(),
    );
    expect(planSourceOf(sampleIssue({ labels: ["bug"], description: PLAN }))).toBeNull();
    expect(
      planSourceOf(sampleIssue({ labels: ["marshall:has-plan"], description: "  " })),
    ).toBeNull();
  });
});

describe("parseReposTouched", () => {
  test("reads one bullet per repo, in order, with the role", () => {
    expect(parseReposTouched(PLAN)).toEqual([
      { slug: "DB-Migrations", role: "sibling", order: 1 },
      { slug: "Command", role: "primary", order: 2 },
    ]);
  });

  test("accepts backticks and a dash or em dash, and ignores other lines", () => {
    const text = "## Repos touched\n\nSome intro.\n- `EDI-Hub` — primary\n- zones - sibling\n";
    expect(parseReposTouched(text).map((r) => [r.slug, r.role])).toEqual([
      ["EDI-Hub", "primary"],
      ["zones", "sibling"],
    ]);
  });

  test("an absent section means no repos listed", () => {
    expect(parseReposTouched("## Plan\n\nx")).toEqual([]);
  });
});

describe("checkIntakePlan", () => {
  test("accepts a plan with TLDR, Plan, and Verification", () => {
    expect(checkIntakePlan(PLAN)).toMatchObject({ ok: true, problems: [] });
  });

  test("names a missing section", () => {
    const check = checkIntakePlan("# t\n\n## TLDR\n\nx\n\n## Plan\n\ny\n");
    expect(check.ok).toBe(false);
    expect(check.problems.join(" ")).toContain("Verification");
  });

  test("needs exactly one primary repo when repos are listed", () => {
    const two = PLAN.replace("sibling", "primary");
    expect(checkIntakePlan(two).problems.join(" ")).toContain("exactly one primary");
    const none = PLAN.replace("primary", "sibling");
    expect(checkIntakePlan(none).problems.join(" ")).toContain("exactly one primary");
  });

  test("refuses a repo listed twice and a plan over the size limit", () => {
    const dup = PLAN.replace("DB-Migrations: sibling", "Command: sibling");
    expect(checkIntakePlan(dup).problems.join(" ")).toContain("twice");
    expect(checkIntakePlan(`${PLAN}${"x".repeat(60_000)}`).problems.join(" ")).toContain(
      "characters",
    );
  });
});

describe("intakePlanPath", () => {
  test("is a kebab path that the plan-path pattern accepts", () => {
    const path = intakePlanPath({ identifier: "AND-7", title: "Add a Late Charge (v2)!" });
    expect(path).toBe("docs/add-a-late-charge-v2_plan.md");
    expect(isPlanPath(path)).toBe(true);
  });

  test("falls back to the identifier when the title has no usable characters", () => {
    expect(intakePlanPath({ identifier: "AND-7", title: "!!!" })).toBe("docs/and-7_plan.md");
  });
});

describe("runPlanIntake", () => {
  test("writes the plan, commits it once, and leaves the worktree clean", async () => {
    const issue = sampleIssue({ labels: ["marshall:has-plan"], description: PLAN });
    const result = await runPlanIntake({ issue, cwd: repo.dir });
    expect(result).toMatchObject({ ok: true, planPath: "docs/fix-castling-through-check_plan.md" });
    const path = join(repo.dir, "docs/fix-castling-through-check_plan.md");
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(`${PLAN.trim()}\n`);
    expect(git(["status", "--porcelain"], repo.dir)).toBe("");
    expect(git(["rev-list", "--count", `${repo.base}..HEAD`], repo.dir)).toBe("1");
    expect(git(["log", "-1", "--format=%s"], repo.dir)).toBe(intakeCommitSubject("CB-12"));
    expect(git(["diff", "--name-only", `${repo.base}..HEAD`], repo.dir)).toBe(
      "docs/fix-castling-through-check_plan.md",
    );
  });

  test("returns invalid_plan without touching git when the plan fails the check", async () => {
    const issue = sampleIssue({ labels: ["marshall:has-plan"], description: "# no sections" });
    const result = await runPlanIntake({ issue, cwd: repo.dir });
    expect(result).toMatchObject({ ok: false, reason: "invalid_plan" });
    expect(git(["rev-list", "--count", `${repo.base}..HEAD`], repo.dir)).toBe("0");
  });

  test("returns no_plan when the label is there but the body is empty", async () => {
    const issue = sampleIssue({ labels: ["marshall:has-plan"], description: null });
    expect(await runPlanIntake({ issue, cwd: repo.dir })).toMatchObject({
      ok: false,
      reason: "no_plan",
    });
  });
});
