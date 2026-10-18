// Last edited: 2026-10-18 14:10 PDT
// Plan intake: an issue that carries a finished plan (label `marshall:has-plan`, plan text in the
// issue body) skips the planner. This module checks the text, writes it to `docs/<topic>_plan.md`
// in the worktree, and commits it as the branch's first commit, so the plan lands in the PR the
// same way a planner's plan does. Pure checks first, then the one function that touches git.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runGit } from "../git.ts";
import { type IssueDetail, isHasPlan } from "../linear/index.ts";
import { checkRequiredSections, sectionBody } from "../markdown.ts";
import { PLAN_PATH_PATTERN } from "./template.ts";

/**
 * H2 sections an intake plan needs, in this order. Looser than the planner's template: a plan a
 * person wrote has its own Context and Decisions sections, but it must say what to do and how to
 * check it.
 */
export const INTAKE_SECTIONS = ["TLDR", "Plan", "Verification"] as const;

/** The heading that lists the repos a plan touches (see `parseReposTouched`). */
export const REPOS_TOUCHED_HEADING = "Repos touched";

/** Linear stores a description up to a size limit; stay well under it. */
export const MAX_PLAN_CHARS = 60_000;

export type RepoRole = "primary" | "sibling";

export interface RepoRef {
  slug: string;
  role: RepoRole;
  /** 1-based position in the list. Merge order in the hand-off follows it. */
  order: number;
}

export interface IntakeCheck {
  ok: boolean;
  problems: string[];
  repos: RepoRef[];
}

/** The plan text: the issue body when the issue carries the has-plan label, else null. */
export function planSourceOf(issue: Pick<IssueDetail, "labels" | "description">): string | null {
  if (!isHasPlan(issue.labels)) return null;
  const text = issue.description?.trim();
  return text && text.length > 0 ? text : null;
}

/**
 * Repos from the `## Repos touched` bullets. One bullet per repo: `- <slug>: primary|sibling`
 * (a dash or an em dash works in place of the colon). Bullet order is the merge order. An empty
 * list means the plan touches only the repo the worktree is in.
 */
export function parseReposTouched(text: string): RepoRef[] {
  const body = sectionBody(text, REPOS_TOUCHED_HEADING);
  if (!body) return [];
  const repos: RepoRef[] = [];
  for (const line of body.split("\n")) {
    const m = /^[-*]\s+`?([A-Za-z0-9][A-Za-z0-9._-]*)`?\s*[:—-]\s*(primary|sibling)\b/i.exec(
      line.trim(),
    );
    if (!m?.[1] || !m[2]) continue;
    repos.push({ slug: m[1], role: m[2].toLowerCase() as RepoRole, order: repos.length + 1 });
  }
  return repos;
}

/** Everything wrong with an intake plan, as readable problems. Pure: no file or git access. */
export function checkIntakePlan(text: string): IntakeCheck {
  const problems: string[] = [];
  if (text.length > MAX_PLAN_CHARS) {
    problems.push(`the plan is ${text.length} characters; Linear takes at most ${MAX_PLAN_CHARS}`);
  }
  const { missing, misordered } = checkRequiredSections(text, INTAKE_SECTIONS);
  if (missing.length > 0) problems.push(`missing sections: ${missing.join(", ")}`);
  if (misordered.length > 0) problems.push(`sections out of order: ${misordered.join(", ")}`);
  const repos = parseReposTouched(text);
  const primaries = repos.filter((r) => r.role === "primary").length;
  if (repos.length > 0 && primaries !== 1) {
    problems.push(`"${REPOS_TOUCHED_HEADING}" needs exactly one primary repo, found ${primaries}`);
  }
  const slugs = repos.map((r) => r.slug.toLowerCase());
  if (new Set(slugs).size !== slugs.length) {
    problems.push(`"${REPOS_TOUCHED_HEADING}" lists a repo twice`);
  }
  return { ok: problems.length === 0, problems, repos };
}

/** `docs/<kebab-title>_plan.md`, a name `PLAN_PATH_PATTERN` accepts. */
export function intakePlanPath(issue: Pick<IssueDetail, "identifier" | "title">): string {
  const words = issue.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
  const topic = words.length > 0 ? words : issue.identifier.toLowerCase();
  const path = `docs/${topic}_plan.md`;
  return PLAN_PATH_PATTERN.test(path) ? path : `docs/${issue.identifier.toLowerCase()}_plan.md`;
}

export interface IntakeInput {
  issue: IssueDetail;
  /** The worktree to write the plan into, already on the issue branch. */
  cwd: string;
}

export type IntakeResult =
  | { ok: true; planPath: string; repos: RepoRef[] }
  | { ok: false; reason: "no_plan" | "invalid_plan"; detail: string };

/** Commit subject of the plan's first commit. */
export function intakeCommitSubject(identifier: string): string {
  return `Add the plan for ${identifier}`;
}

/**
 * Check the issue's plan, write it into the worktree, and commit it. Throws on a git failure (the
 * master agent turns a throw into Blocked); a bad plan returns `ok: false` instead.
 */
export async function runPlanIntake(input: IntakeInput): Promise<IntakeResult> {
  const text = planSourceOf(input.issue);
  if (!text) {
    return {
      ok: false,
      reason: "no_plan",
      detail: "the issue has the has-plan label but an empty body",
    };
  }
  const check = checkIntakePlan(text);
  if (!check.ok) return { ok: false, reason: "invalid_plan", detail: check.problems.join("; ") };
  const planPath = intakePlanPath(input.issue);
  const full = join(input.cwd, planPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, `${text}\n`);
  await runGit(["add", planPath], input.cwd);
  await runGit(["commit", "-m", intakeCommitSubject(input.issue.identifier)], input.cwd);
  return { ok: true, planPath, repos: check.repos };
}
