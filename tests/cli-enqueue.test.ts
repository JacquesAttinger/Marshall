// Last edited: 2026-10-18 15:20 PDT
// `marshall enqueue`: the plan check, the Linear call, and the dry run.

import { describe, expect, test } from "bun:test";
import { EnqueueError, enqueuePlan, formatEnqueue, planTitle } from "../src/cli/enqueue.ts";
import { dispatch, parseArgs } from "../src/cli/index.ts";
import type { CreatedPlanIssue } from "../src/linear/index.ts";

const PLAN = `# Plan: Add a late charge

## TLDR

Add it.

## Repos touched

- DB-Migrations: sibling
- Command: primary

## Plan

1. Do it.

## Verification

1. Check it.
`;

function fakeLinear() {
  const calls: { title: string; description: string }[] = [];
  const issue: CreatedPlanIssue = {
    id: "i1",
    identifier: "AND-1",
    url: "https://linear.app/x/issue/AND-1",
    branchName: "me/and-1-add-a-late-charge",
  };
  return {
    calls,
    linear: {
      async createQueuedPlan(input: { title: string; description: string }) {
        calls.push(input);
        return issue;
      },
    },
  };
}

describe("planTitle", () => {
  test("drops a leading Plan: and returns null with no H1", () => {
    expect(planTitle(PLAN)).toBe("Add a late charge");
    expect(planTitle("# Just a title\n")).toBe("Just a title");
    expect(planTitle("no heading")).toBeNull();
  });
});

describe("enqueuePlan", () => {
  test("files the issue with the title and the trimmed plan text", async () => {
    const { calls, linear } = fakeLinear();
    const report = await enqueuePlan({ text: `${PLAN}\n\n`, linear });
    expect(calls).toEqual([{ title: "Add a late charge", description: PLAN.trim() }]);
    expect(report.issue?.identifier).toBe("AND-1");
    expect(report.repos.map((r) => r.slug)).toEqual(["DB-Migrations", "Command"]);
    expect(formatEnqueue(report)).toContain("Branch: me/and-1-add-a-late-charge");
  });

  test("a dry run checks the plan and never calls Linear", async () => {
    const { calls, linear } = fakeLinear();
    const report = await enqueuePlan({ text: PLAN, linear, dryRun: true });
    expect(calls).toEqual([]);
    expect(report.issue).toBeUndefined();
    expect(formatEnqueue(report)).toContain("dry run");
  });

  test("refuses a plan that fails the check, naming every problem, and files nothing", async () => {
    const { calls, linear } = fakeLinear();
    const bad = "# Plan: x\n\n## TLDR\n\nx\n";
    const attempt = enqueuePlan({ text: bad, linear });
    await expect(attempt).rejects.toBeInstanceOf(EnqueueError);
    await expect(attempt).rejects.toThrow(/Plan, Verification/);
    expect(calls).toEqual([]);
  });

  test("refuses a repo the config does not list", async () => {
    const { linear } = fakeLinear();
    const attempt = enqueuePlan({ text: PLAN, linear, knownRepos: ["Command"] });
    await expect(attempt).rejects.toThrow(/"DB-Migrations" is not in the config's repos list/);
  });
});

describe("cli wiring", () => {
  test("parseArgs reads --dry-run", () => {
    expect(parseArgs(["enqueue", "p.md", "--dry-run"])).toMatchObject({
      positional: ["enqueue", "p.md"],
      dryRun: true,
    });
  });

  test("dispatch routes `enqueue` and needs one file", async () => {
    const errors: string[] = [];
    const original = console.error;
    console.error = (...a: unknown[]) => void errors.push(a.join(" "));
    try {
      expect(await dispatch(["enqueue"])).toBe(2);
    } finally {
      console.error = original;
    }
    expect(errors[0]).toContain("Unknown command: enqueue");
  });
});
