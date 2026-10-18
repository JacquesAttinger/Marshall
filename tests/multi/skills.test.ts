// Last edited: 2026-10-18 19:50 PDT
// The Hemut implement skill and the multi-repo wording in the shared skills. An agent that never
// reads a rule cannot follow it, so each rule that matters is pinned here as text.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseConfig } from "../../src/config.ts";
import { checkHandoffText } from "../../src/handoff/validate.ts";
import { ImplementStatusSchema } from "../../src/implement/status.ts";
import { implementPrompt, implementResumePrompt } from "../../src/phases/names.ts";

const SKILLS = resolve(import.meta.dir, "..", "..", "plugin", "skills");
const read = (name: string) => readFileSync(join(SKILLS, name, "SKILL.md"), "utf8");

describe("implement-hemut", () => {
  const text = read("implement-hemut");

  test("has the same shape as implement: hidden from the model, plan path and issue id", () => {
    expect(text).toContain("name: implement-hemut");
    expect(text).toContain("disable-model-invocation: true");
    expect(text).toContain("argument-hint: <plan-path> <ISSUE-ID>");
  });

  test("quotes every implement.json field, including the optional prs list", () => {
    for (const key of Object.keys(ImplementStatusSchema.shape)) {
      expect(text).toContain(`"${key}"`);
    }
  });

  test.each([
    ["never merges, even with auto-merge", "Never merge."],
    ["names the forbidden merge commands", "gh pr merge"],
    ["forbids auto-merge", "--auto"],
    ["never commits to staging or main", "Never push to `staging` or `main`"],
    ["keeps the Linear branch name", "gitBranchName"],
    ["puts the issue URL in the body", "Closes <MARSHALL_ISSUE_URL>"],
    ["never skips hooks", "Never `git commit --no-verify`"],
    ["file size limit", "No file over 500 lines"],
    ["function size limit", "No function over 75 lines"],
    ["migrations live in DB-Migrations", "`DB-Migrations` repo"],
    ["checks the architecture atlas", "Architecture Atlas"],
    ["plain-language errors", "plain language"],
    ["organizations, not tenants", 'Use "organizations", never "tenants".'],
    ["runs the review pass before done", "mandatory pre-PR review"],
    ["knows the repos list", "MARSHALL_REPOS_JSON"],
    ["cross-links the PRs", "## Related PRs"],
    ["never uses real credentials", "Never use real third-party or cloud credentials"],
  ])("states the rule: %s", (_why, needle) => {
    expect(text).toContain(needle);
  });
});

describe("shared skills know about several repos", () => {
  test("review reviews every repo in MARSHALL_REPOS_JSON", () => {
    expect(read("review")).toContain("MARSHALL_REPOS_JSON");
  });

  test("handoff reads MARSHALL_REPOS_JSON and prints the merge order", () => {
    const text = read("handoff");
    expect(text).toContain("MARSHALL_REPOS_JSON");
    expect(text).toContain("- Merge order:");
  });
});

describe("implementSkill config", () => {
  const base = { workspace: "w", teamId: "t", repoPath: SKILLS };

  test("defaults to implement and accepts implement-hemut only", () => {
    expect(parseConfig(base).implementSkill).toBe("implement");
    expect(parseConfig({ ...base, implementSkill: "implement-hemut" }).implementSkill).toBe(
      "implement-hemut",
    );
    expect(() => parseConfig({ ...base, implementSkill: "other" })).toThrow();
  });

  test("the prompt and the resume nudge name the chosen skill", () => {
    expect(implementPrompt("docs/x_plan.md", "AND-1")).toBe(
      "/marshall:implement docs/x_plan.md AND-1",
    );
    expect(implementPrompt("docs/x_plan.md", "AND-1", "implement-hemut")).toBe(
      "/marshall:implement-hemut docs/x_plan.md AND-1",
    );
    expect(implementResumePrompt("implement-hemut")).toContain("/marshall:implement-hemut");
  });
});

describe("hand-off validation with several PRs", () => {
  const primary = "https://github.com/hemut/Command/pull/12";
  const other = "https://github.com/hemut/DB-Migrations/pull/7";
  const doc = (recipe: string) =>
    `# AND-1 — t\n\n**TLDR:** x\n\n## Where to find it\n\nx\n\n## Orientation\n\nx\n\n## What was wrong and why\n\nx\n\n## What the agent did\n\nx\n\n**Files that matter**\n\n- a\n\n**Decisions made alone**\n\n- b\n\n**Review notes (not fixed)**\n\n- (none)\n\n**Follow-ups proposed**\n\n- (none)\n\n## Verification recipe\n\n${recipe}\n`;

  test("accepts the primary PR even when another PR is listed first", () => {
    const text = doc(
      `- Branch: \`me/and-1-x\`\n- Other PRs: DB-Migrations: ${other}\n- PR: ${primary}\n- Merge order: DB-Migrations first.`,
    );
    const check = checkHandoffText(text, { prUrl: primary, branch: "me/and-1-x" });
    expect(check.problems).toEqual([]);
  });

  test("still rejects a hand-off that never names the primary PR", () => {
    const text = doc(`- Branch: \`me/and-1-x\`\n- PR: ${other}`);
    const check = checkHandoffText(text, { prUrl: primary, branch: "me/and-1-x" });
    expect(check.problems.join(" ")).toContain("expected");
  });
});
