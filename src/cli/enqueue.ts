// Last edited: 2026-10-18 15:10 PDT
// `marshall enqueue <plan-file> [--dry-run] [--json]` queues a finished plan for the next night run:
// it checks the plan, then files a Todo issue assigned to you with the plan as the body and the
// `marshall:queued` and `marshall:has-plan` labels. The scheduler picks the issue up, skips the
// planner, and implements the plan. `--dry-run` checks only and writes nothing to Linear.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig, loadEnv, pickupOptions, requireLinearApiKey } from "../config.ts";
import { type CreatedPlanIssue, connectLinear, type LinearClient } from "../linear/index.ts";
import { createLogger } from "../log.ts";
import { expandTilde } from "../paths.ts";
import { checkIntakePlan, type RepoRef } from "../plan/index.ts";

export interface EnqueueOptions {
  file: string;
  dryRun: boolean;
  json: boolean;
  configPath?: string;
}

export interface EnqueueReport {
  title: string;
  repos: RepoRef[];
  /** Absent on a dry run. */
  issue?: CreatedPlanIssue;
}

/** The plan's H1 without a leading `Plan:`, which is how plan files in this repo title themselves. */
export function planTitle(text: string): string | null {
  const m = /^#\s+(?:plan:\s*)?(.+?)\s*$/im.exec(text);
  return m?.[1] ?? null;
}

export class EnqueueError extends Error {
  override name = "EnqueueError";
}

/**
 * Check the plan and, unless `dryRun`, file the issue. `knownRepos` (the registry's slugs) rejects
 * a plan that lists a repo Marshall does not know; omit it to skip that check.
 */
export async function enqueuePlan(input: {
  text: string;
  linear: Pick<LinearClient, "createQueuedPlan">;
  dryRun?: boolean;
  knownRepos?: string[];
}): Promise<EnqueueReport> {
  const text = input.text.trim();
  const check = checkIntakePlan(text);
  const problems = [...check.problems];
  const title = planTitle(text);
  if (!title) problems.push("the plan has no `# Title` line");
  const known = input.knownRepos?.map((s) => s.toLowerCase());
  for (const repo of check.repos) {
    if (known && !known.includes(repo.slug.toLowerCase())) {
      problems.push(`repo "${repo.slug}" is not in the config's repos list`);
    }
  }
  if (problems.length > 0 || !title) {
    throw new EnqueueError(`The plan cannot be queued: ${problems.join("; ")}.`);
  }
  if (input.dryRun) return { title, repos: check.repos };
  const issue = await input.linear.createQueuedPlan({ title, description: text });
  return { title, repos: check.repos, issue };
}

export function formatEnqueue(report: EnqueueReport): string {
  const repos =
    report.repos.length > 0
      ? report.repos.map((r) => `${r.order}. ${r.slug} (${r.role})`).join(", ")
      : "the project's one repo";
  if (!report.issue) return `Plan OK (dry run): "${report.title}". Repos: ${repos}.`;
  return [
    `Queued ${report.issue.identifier}: "${report.title}"`,
    `Repos: ${repos}`,
    `Issue: ${report.issue.url}`,
    `Branch: ${report.issue.branchName}`,
    "Marshall picks it up on its next tick and skips planning.",
  ].join("\n");
}

/** Exit code 0 when queued (or the dry run passed), 1 when the plan is refused. */
export async function runEnqueue(opts: EnqueueOptions): Promise<number> {
  const file = resolve(expandTilde(opts.file));
  if (!existsSync(file)) throw new Error(`plan file not found: ${file}`);
  const text = readFileSync(file, "utf8");
  const config = loadConfig(opts.configPath);
  const linear = opts.dryRun
    ? { createQueuedPlan: () => Promise.reject(new Error("dry run")) }
    : await connectLinear({
        apiKey: requireLinearApiKey(loadEnv()),
        teamId: config.teamId,
        workspace: config.workspace,
        log: createLogger({ command: "enqueue" }),
        pickup: pickupOptions(config),
      });
  try {
    const report = await enqueuePlan({ text, linear, dryRun: opts.dryRun });
    console.log(opts.json ? JSON.stringify(report, null, 2) : formatEnqueue(report));
    return 0;
  } catch (err) {
    if (!(err instanceof EnqueueError)) throw err;
    console.error(err.message);
    return 1;
  }
}
