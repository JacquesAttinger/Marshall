// Last edited: 2026-10-18 13:17 PDT
// Names the phases and the plugin skills agree on: run names (`<ID> <phase>`, what the master
// agent looks up after a restart), the prompts, and the planner's revision commit subject.

import type { Config } from "../config.ts";

export type PhaseRunKind = "plan" | "implement" | "handoff" | "resolve";

export function runName(identifier: string, kind: PhaseRunKind): string {
  return `${identifier} ${kind}`;
}

/** `plugin/skills/plan/SKILL.md` commits a revision as `Plan: revision N`. */
export function PLAN_REVISION_SUBJECT(revision: number): string {
  return `Plan: revision ${revision}`;
}

/** The plugin skill that implements a plan: `implement`, or `implement-hemut` (config.implementSkill). */
export type ImplementSkill = Config["implementSkill"];

export function implementPrompt(
  planPath: string,
  identifier: string,
  skill: ImplementSkill = "implement",
): string {
  return `/marshall:${skill} ${planPath} ${identifier}`;
}

export const RESOLVE_STATUS_FILE = "resolve.json";

export function resolvePrompt(
  planPath: string,
  identifier: string,
  mode: "conflict" | "ci",
): string {
  return `/marshall:resolve-conflicts ${planPath} ${identifier} ${mode}`;
}

/** The nudge a resumed implement session gets; the skill's preflight reads implement.json. */
export function implementResumePrompt(skill: ImplementSkill = "implement"): string {
  return (
    "Your session was interrupted. Read $MARSHALL_ISSUE_DIR/implement.json and continue " +
    `/marshall:${skill} from the phase it records. The PR, if any, is reused, never recreated.`
  );
}
