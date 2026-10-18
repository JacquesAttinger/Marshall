// Last edited: 2026-10-18 13:17 PDT
// The planning phase as the master agent runs it: one `runPlanPhase` call (step 04), fresh on a
// first start and in revise mode on a bounce. A failure gets one fresh retry after the branch is
// put back where the phase found it; a rate limit pauses and retries uncounted.

import { isHasPlan } from "../linear/index.ts";
import { tldrOf } from "../markdown.ts";
import type { MasterAgent } from "../master/agent.ts";
import { PLANNING } from "../master/types.ts";
import type { PlanPhaseInput, PlanPhaseResult } from "../plan/index.ts";
import { terminalOf } from "../plan/wait.ts";
import { claimBase } from "../scheduler/index.ts";
import { PLAN_REVISION_SUBJECT } from "./names.ts";

/**
 * Where the branch goes back to before a retry. Fresh: the base branch tip. Revise: the tip,
 * unless the newest commit is the planner's own revision commit, which is dropped.
 */
export async function planningBase(agent: MasterAgent, mode: "fresh" | "revise"): Promise<string> {
  const { git, config, db } = agent.deps;
  if (mode === "fresh") return `origin/${claimBase(db, config, agent.claim.issueId)}`;
  const head = await git.head(agent.cwd);
  const subject = await git.subject(agent.cwd, head);
  return subject === PLAN_REVISION_SUBJECT(agent.claim.bounces) ? `${head}~1` : head;
}

function planInput(agent: MasterAgent, mode: "fresh" | "revise", attachRunId?: string) {
  const { deps, claim, issue } = agent;
  const input: PlanPhaseInput = {
    db: deps.db,
    linear: deps.linear,
    config: deps.config,
    issue,
    cwd: agent.cwd,
    mode,
    base: `origin/${claimBase(deps.db, deps.config, claim.issueId)}`,
    waiter: deps.waiter,
    onLaunched: (run) => agent.watch(run.runId),
  };
  if (claim.model) input.model = claim.model;
  if (mode === "revise") {
    input.revision = claim.bounces;
    if (claim.planPath) input.planPath = claim.planPath;
  }
  if (attachRunId) input.attachRunId = attachRunId;
  return input;
}

/** A failure's StopFailure details (the rate limit's reset time), read from the run row. */
function detailsOf(agent: MasterAgent, result: PlanPhaseResult): string | undefined {
  if (result.ok || !result.runId) return undefined;
  const terminal = terminalOf(agent.deps.db, result.runId);
  return terminal?.kind === "failed" ? terminal.details : undefined;
}

/**
 * A fresh issue that carries its own plan: put the branch back at the base, write and commit the
 * plan, post the TLDR. Skips the classifier and the planner. A bad plan is Blocked, not retried:
 * a second try would read the same text.
 */
async function runIntake(agent: MasterAgent, base: string): Promise<boolean> {
  const { deps, issue } = agent;
  await deps.git.resetHard(agent.cwd, base);
  const result = await deps.phases.intake({ issue, cwd: agent.cwd });
  if (!result.ok) {
    await agent.block(
      "plan_invalid",
      `The plan in this issue cannot be used (${result.reason}): ${result.detail}.`,
    );
    return false;
  }
  agent.patch({ planPath: result.planPath });
  agent.emit("plan_intake", { planPath: result.planPath, repos: result.repos.length });
  const tldr = tldrOf(issue.description ?? "");
  await deps.linear.comment(
    issue.id,
    [
      "Marshall found a finished plan in this issue and skipped planning.",
      tldr ? `\n${tldr}` : "",
      `\nPlan: \`${result.planPath}\` on branch \`${agent.claim.branch ?? issue.branchName}\`.`,
    ].join("\n"),
  );
  return true;
}

/** True when the plan is on the branch and stored on the claim; false when the issue is blocked. */
export async function runPlanningPhase(
  agent: MasterAgent,
  entry: { kind: "start" | "resume" | "attach" },
): Promise<boolean> {
  const mode = agent.claim.bounces > 0 ? "revise" : "fresh";
  if (agent.claim.state !== PLANNING) agent.transition(PLANNING, { mode });
  const base = await planningBase(agent, mode);
  if (mode === "fresh" && isHasPlan(agent.issue.labels) && !agent.claim.planPath) {
    return runIntake(agent, base);
  }
  const live = entry.kind === "attach" ? agent.runFor("plan") : null;
  const ended = live ? terminalOf(agent.deps.db, live.runId) : null;
  let attachRunId = live && !ended ? live.runId : undefined;
  if (ended?.kind === "failed" && ended.error === "rate_limit") {
    // Parked in rate_limited when the orchestrator went down: pause again before relaunching.
    await agent.pauseForRateLimit(ended.details);
  }
  for (;;) {
    if (agent.overBudget()) {
      await agent.blockOverBudget();
      return false;
    }
    if (!attachRunId) await agent.deps.git.resetHard(agent.cwd, base);
    const result = await agent.deps.phases.plan(planInput(agent, mode, attachRunId));
    agent.runId = null;
    if (result.ok) {
      agent.patch({ planPath: result.planPath, model: result.model });
      return true;
    }
    const verdict = await agent.decideRetry(result.reason, result.detail, detailsOf(agent, result));
    if (verdict === "blocked") return false;
    attachRunId = undefined;
  }
}
