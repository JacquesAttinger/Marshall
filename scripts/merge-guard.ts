// Last edited: 2026-10-18 13:17 PDT
// PreToolUse guard for Bash calls. Marshall never merges, approves, or pushes to a protected branch:
// a human does. The agents run with bypassPermissions, so this hook (and the deny rules in
// agent-settings.json) are what keep a bad instruction in an issue, a PR comment, or a plan from
// turning into a merge. Usage: bun scripts/merge-guard.ts <events-file>   (stdin: the hook payload)
//
// Prints a PreToolUse deny decision and appends one line to the run's events file when the command
// is forbidden. Prints nothing (allow) otherwise. The guard fails closed: if it cannot judge a
// command it denies it, and the hook command in settings exits 2 when this script cannot run at
// all (no `bun`, a crash), which Claude Code reads as a block. A broken guard stops the agent
// loudly instead of letting a merge through. The GitHub ruleset on the base branch is the lock
// behind this one.

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
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
/** A refspec's destination branch: `HEAD:refs/heads/main` -> `main`, `+x:staging` -> `staging`. */
export function refspecTarget(spec: string): string {
  const afterColon = spec.includes(":") ? spec.slice(spec.lastIndexOf(":") + 1) : spec;
  return afterColon.replace(/^\+/, "").replace(/^refs\/heads\//, "");
}

/**
 * Split one shell segment into words the way a shell would: quotes group and are dropped, a
 * backslash escapes. A quoted body text ("do not run gh pr merge") stays one word, so it can never
 * look like a subcommand, and a quoted subcommand (`gh pr 'merge'`) is still read as `merge`.
 */
export function shellWords(segment: string): string[] {
  const words: string[] = [];
  let current = "";
  let started = false;
  let quote: string | null = null;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i] as string;
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < segment.length) current += segment[++i];
      else current += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
    } else if (ch === "\\" && i + 1 < segment.length) {
      current += segment[++i];
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) words.push(current);
      current = "";
      started = false;
    } else {
      current += ch;
      started = true;
    }
  }
  if (started) words.push(current);
  return words;
}

const WRAPPERS = new Set(["env", "command", "sudo", "time", "nohup", "exec", "builtin", "nice"]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash"]);
const API_MERGE_WORDS =
  /merge_method|auto_merge|mergePullRequest|enablePullRequestAutoMerge|enable_auto_merge|pulls\/\d+\/merge\b/i;
const API_APPROVE =
  /pulls\/\d+\/reviews\b[\s\S]*\bAPPROVE\b|\bAPPROVE\b[\s\S]*pulls\/\d+\/reviews\b/i;
/** `gh` flags that take a value, which must not be read as a subcommand. */
const GH_VALUE_FLAGS = new Set(["-R", "--repo", "--hostname"]);

function ghVerdict(args: string[]): Verdict | null {
  const subcommands: string[] = [];
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const word = args[i] as string;
    if (subcommands.length < 2 && word.startsWith("-")) {
      if (GH_VALUE_FLAGS.has(word)) i++;
    } else if (subcommands.length < 2) subcommands.push(word);
    else rest.push(word);
  }
  const [group, action] = subcommands;
  if (group === "pr" && action === "merge") {
    return { reason: "gh pr merge: a human merges Marshall's PRs" };
  }
  if (
    group === "pr" &&
    action === "review" &&
    rest.some((w) => /^(--approve|-[a-zA-Z]*a[a-zA-Z]*)$/.test(w))
  ) {
    return { reason: "gh pr review --approve: a human approves Marshall's PRs" };
  }
  if (group === "api") {
    // `--input <file>` carries the request body; read it so a merge body cannot hide there.
    const inputAt = rest.indexOf("--input");
    let text = [action, ...rest].join(" ");
    const file = inputAt >= 0 ? rest[inputAt + 1] : undefined;
    if (file && file !== "-") {
      try {
        text += ` ${readFileSync(file, "utf8")}`;
      } catch {
        // An unreadable file cannot be judged; the endpoint text above still is.
      }
    }
    if (API_MERGE_WORDS.test(text))
      return { reason: "gh api call that merges or enables auto-merge" };
    if (API_APPROVE.test(text)) return { reason: "gh api call that approves a pull request" };
  }
  return null;
}

function gitPushVerdict(args: string[], protectedNames: Set<string>): Verdict | null {
  // Skip git's own options (`-C <dir>`, `-c k=v`) to find the subcommand.
  let i = 0;
  while (i < args.length && (args[i] as string).startsWith("-")) {
    i += args[i] === "-C" || args[i] === "-c" ? 2 : 1;
  }
  if (args[i] !== "push") return null;
  const pushArgs = args.slice(i + 1);
  if (pushArgs.some((a) => a === "--mirror" || a === "--all")) {
    return { reason: "git push --mirror and --all rewrite every branch" };
  }
  const positional = pushArgs.filter((a) => !a.startsWith("-"));
  for (const spec of positional.slice(1)) {
    const target = refspecTarget(spec);
    if (protectedNames.has(target)) {
      return { reason: `git push to the protected branch "${target}"` };
    }
  }
  return null;
}

function wordsVerdict(words: string[], protectedNames: Set<string>, depth: number): Verdict | null {
  let i = 0;
  while (i < words.length) {
    const word = words[i] as string;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || WRAPPERS.has(word)) i++;
    else if (word.startsWith("-") && i > 0 && WRAPPERS.has(words[i - 1] as string)) i++;
    else break;
  }
  const command = words[i];
  if (!command) return null;
  const args = words.slice(i + 1);
  const name = command.split("/").at(-1) as string;
  if (name === "gh") return ghVerdict(args);
  if (name === "git") return gitPushVerdict(args, protectedNames);
  if (depth < 3 && SHELLS.has(name)) {
    const at = args.indexOf("-c");
    const inner = at >= 0 ? args[at + 1] : undefined;
    return inner ? commandVerdict(inner, protectedNames, depth + 1) : null;
  }
  if (depth < 3 && name === "eval")
    return commandVerdict(args.join(" "), protectedNames, depth + 1);
  // A command named by a variable (`$G pr merge`) cannot be read, so a `merge` word is enough.
  if (command.startsWith("$") && args.includes("merge")) {
    return { reason: "a merge through a shell variable" };
  }
  return null;
}

function commandVerdict(
  command: string,
  protectedNames: Set<string>,
  depth: number,
): Verdict | null {
  for (const segment of command.split(/&&|\|\||;|\||\n|\$\(|`/)) {
    const verdict = wordsVerdict(shellWords(segment), protectedNames, depth);
    if (verdict) return verdict;
  }
  return null;
}

/** Why a Bash command is forbidden, or null. Pure: the tests call it with strings. */
export function forbiddenReason(
  command: string,
  env: Record<string, string | undefined> = {},
): Verdict | null {
  return commandVerdict(command, protectedBranches(env), 0);
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
  } catch (err) {
    console.log(denyDecision(`the guard could not judge this command (${(err as Error).message})`));
  }
}
