// Last edited: 2026-10-18 15:59 PDT
// A project that names its own statuses: the hand-off lands in the configured "needs verification"
// status and a stuck issue is parked in the configured "blocked" one.

import { afterEach, describe, expect, test } from "bun:test";
import {
  claimFor,
  type MasterHarness,
  makeMasterHarness,
  registerIssue,
  until,
  writeStatus,
} from "./helpers.ts";

let h: MasterHarness;

afterEach(() => {
  h?.close();
});

const HEMUT = { states: { needsVerification: "In Review", blocked: "Backlog" } };

describe("custom status names", () => {
  test("the hand-off moves the issue to the configured needs-verification status", async () => {
    h = makeMasterHarness({ config: HEMUT });
    const issue = registerIssue(h, "CB-1");
    await h.hooks.start(claimFor(h, issue), issue);
    await until(() => h.runner.launches.length >= 1, 2000, "implement launch");
    writeStatus("CB-1");
    h.waiter.finish(h.runner.launches[0]?.runId as string, { kind: "finished" });
    await h.hooks.settled();
    expect(h.linear.stateOf(issue.id)).toBe("In Review");
  });

  test("a blocked issue is parked in the configured blocked status", async () => {
    h = makeMasterHarness({ config: HEMUT });
    const issue = registerIssue(h, "CB-1");
    h.linear.issues.get(issue.id)?.labels.push("marshall:has-plan");
    h.phases.intakeResults.push({ ok: false, reason: "invalid_plan", detail: "missing sections" });
    await h.hooks.start(claimFor(h, issue), issue);
    await until(() => h.linear.stateOf(issue.id) === "Backlog", 2000, "blocked");
    expect(h.runner.launches).toHaveLength(0);
  });

  test("with no states key the defaults are used", async () => {
    h = makeMasterHarness();
    const issue = registerIssue(h, "CB-1");
    await h.hooks.start(claimFor(h, issue), issue);
    await until(() => h.runner.launches.length >= 1, 2000, "implement launch");
    writeStatus("CB-1");
    h.waiter.finish(h.runner.launches[0]?.runId as string, { kind: "finished" });
    await h.hooks.settled();
    expect(h.linear.stateOf(issue.id)).toBe("Needs Verification");
  });
});
