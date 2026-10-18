// Last edited: 2026-10-18 20:20 PDT
// PreToolUse guard for Bash calls. Marshall never merges, approves, or pushes to a protected branch:
// a human does. The agents run with bypassPermissions, so this hook (and the deny rules in
// agent-settings.json) are what keep a bad instruction in an issue, a PR comment, or a plan from
// turning into a merge. Usage: bun scripts/merge-guard.ts <events-file>   (stdin: the hook payload)
//
// Prints a PreToolUse deny decision and appends one line to the run's events file when the command
// is forbidden. Prints nothing (allow) otherwise. Exit code is always 0: a broken guard must not
// stop every agent, and the GitHub ruleset on the base branch is the lock behind this one.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** Branches nobody but a human pushes to, besides the base branches the run's env names. */
export const ALWAYS_PROTECTED = ["staging", "main", "master"];

export interface Verdict {
  reason: string;
}

/** Base branches named by the run's env: `MARSHALL_BASE_BRANCH` and each `base` in the repos JSON. */
export function protectedBranches(env: Record<string, string | undefined>): Set<string> {
  const names = new Set(ALWAYS_PROTECTED);
  if (env.MARSHALL_BASE_BRANCH) names.add(env.MARSHALL_BASE_BRANCH);
  try {
    const repos = JSON.parse(env.MARSHALL_REPOS_JSON ?? "[]") as { base?: unknown }[];
    for (const repo of repos) if (typeof repo.base === "string") names.add(repo.base);
  } catch {
    // A malformed value only means fewer extra names; the always-protected ones still apply.
  }
  return names;
}

// `gh` global flags, with or without a value: `gh -R owner/repo pr merge`.
const GH = String.raw`\bgh\s+(?:-\S+\s+(?:[^\s-]\S*\s+)?)*`;
const MERGE_WORDS = String.raw`(?:\/merge\b|merge_method|auto_merge|mergePullRequest|enablePullRequestAutoMerge|enable_auto_merge)`;

/** A refspec's destination branch: `HEAD:refs/heads/main` -> `main`, `+x:staging` -> `staging`. */
export function refspecTarget(spec: string): string {
  const afterColon = spec.includes(":") ? spec.slice(spec.lastIndexOf(":") + 1) : spec;
  return afterColon.replace(/^\+/, "").replace(/^refs\/heads\//, "");
}

function pushVerdict(segment: string, protectedNames: Set<string>): Verdict | null {
  const m = /\bgit\s+(?:-\S+\s+(?:\S+\s+)?)*push\b(.*)$/s.exec(segment);
  if (!m) return null;
  const args = (m[1] ?? "").trim().split(/\s+/).filter(Boolean);
  if (args.some((a) => a === "--mirror" || a === "--all")) {
    return { reason: "git push --mirror and --all rewrite every branch" };
  }
  const positional = args.filter((a) => !a.startsWith("-"));
  for (const spec of positional.slice(1)) {
    const target = refspecTarget(spec);
    if (protectedNames.has(target)) {
      return { reason: `git push to the protected branch "${target}"` };
    }
  }
  return null;
}

/** Why a Bash command is forbidden, or null. Pure: the tests call it with strings. */
export function forbiddenReason(
  command: string,
  env: Record<string, string | undefined> = {},
): Verdict | null {
  const protectedNames = protectedBranches(env);
  for (const segment of command.split(/&&|\|\||;|\||\n|\$\(|`/)) {
    if (new RegExp(`${GH}pr\\s+merge\\b`).test(segment)) {
      return { reason: "gh pr merge: a human merges Marshall's PRs" };
    }
    if (new RegExp(`${GH}pr\\s+review\\b[^\\n]*(?:--approve|\\s-a\\b)`).test(segment)) {
      return { reason: "gh pr review --approve: a human approves Marshall's PRs" };
    }
    if (new RegExp(`${GH}api\\b[^\\n]*${MERGE_WORDS}`, "i").test(segment)) {
      return { reason: "gh api call that merges or enables auto-merge" };
    }
    const push = pushVerdict(segment, protectedNames);
    if (push) return push;
  }
  return null;
}

interface HookPayload {
  hook_event_name?: unknown;
  tool_name?: unknown;
  tool_input?: { command?: unknown };
}

/** The deny decision Claude Code reads from stdout. */
export function denyDecision(reason: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `Marshall never does this: ${reason}. Leave it for a human.`,
    },
  });
}

/** Judge one hook payload (JSON text). Null means allow. */
export function judge(stdin: string, env: Record<string, string | undefined>): Verdict | null {
  let payload: HookPayload;
  try {
    payload = JSON.parse(stdin) as HookPayload;
  } catch {
    return null;
  }
  const command = payload.tool_input?.command;
  if (payload.tool_name !== "Bash" || typeof command !== "string") return null;
  return forbiddenReason(command, env);
}

function recordBlock(eventsFile: string, stdin: string, verdict: Verdict): void {
  let command = "";
  try {
    command = String((JSON.parse(stdin) as HookPayload).tool_input?.command ?? "").slice(0, 300);
  } catch {
    // The payload parsed once already; a failure here only loses the command text.
  }
  const event = {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    blocked: true,
    reason: verdict.reason,
    command,
  };
  mkdirSync(dirname(eventsFile), { recursive: true });
  const line = { received_at: new Date().toISOString(), event };
  appendFileSync(eventsFile, `${JSON.stringify(line)}\n`);
}

if (import.meta.main) {
  try {
    const stdin = await Bun.stdin.text();
    const verdict = judge(stdin, process.env);
    if (verdict) {
      const eventsFile = process.argv[2];
      if (eventsFile) recordBlock(eventsFile, stdin, verdict);
      console.log(denyDecision(verdict.reason));
    }
  } catch {
    // Allow on any failure of the guard itself.
  }
}
