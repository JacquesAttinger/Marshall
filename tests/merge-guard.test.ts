// Last edited: 2026-10-18 13:17 PDT
// The merge guard: what it denies, what it must leave alone, and the hook wiring around it.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  denyDecision,
  forbiddenReason,
  judge,
  protectedBranches,
  refspecTarget,
} from "../scripts/merge-guard.ts";
import { buildAgentSettings, loadBaseSettings, MERGE_GUARD_PATH } from "../src/runner/settings.ts";
import { type TempHome, useTempHome } from "./helpers.ts";

const denied = (command: string, env: Record<string, string> = {}) =>
  forbiddenReason(command, env) !== null;

let home: TempHome;

beforeEach(() => {
  home = useTempHome();
});

afterEach(() => {
  home.restore();
});

describe("forbiddenReason: merges and approvals", () => {
  test.each([
    "gh pr merge 12",
    "gh pr merge --auto --squash 12",
    "gh -R hemut/Command pr merge 12",
    "cd x && gh pr merge 12",
    "echo done; gh pr merge 12",
    "true || gh pr merge 12",
    "gh pr view 12 | tee x\ngh pr merge 12",
    "gh pr review 12 --approve",
    "gh pr review --approve 12",
    "gh api repos/hemut/Command/pulls/12/merge -X PUT",
    "gh api -X PUT repos/o/r/pulls/12/merge -f merge_method=squash",
    "gh api graphql -f query='mutation { mergePullRequest(input: {}) { clientMutationId } }'",
    "gh api graphql -f query='mutation { enablePullRequestAutoMerge(input: {}) { clientMutationId } }'",
    // Ways round a plain-text match.
    "gh pr 'merge' 5",
    'gh "pr" merge 5',
    "gh pr mer\\ge 5",
    "G=gh; $G pr merge 5",
    "env GH_TOKEN=x gh pr merge 5",
    "sudo -n gh pr merge 5",
    'bash -c "gh pr merge 5"',
    "sh -c 'cd x && gh pr merge 5'",
    "eval gh pr merge 5",
    "gh api repos/o/r/pulls/5/reviews -f event=APPROVE",
    "gh api repos/o/r/pulls/5/merge -X PUT",
  ])("denies %p", (command) => {
    expect(denied(command)).toBe(true);
  });

  test.each([
    "gh pr create --base staging --title 'AND-1: x' --body-file b.md",
    "gh pr view 12 --json state,mergedAt,mergeable",
    "gh pr checks 12 --watch --fail-fast",
    "gh pr edit 12 --body-file b.md",
    "gh pr ready --undo 12",
    "gh pr review 12 --comment --body hi",
    "gh api repos/o/r/pulls/12/comments",
    "gh api repos/o/r --jq .default_branch",
    "git merge-base origin/staging HEAD",
    "git merge origin/staging",
    // Prose that mentions a forbidden command is text, not a command.
    "echo gh pr merge is forbidden",
    'gh pr create --title "AND-1: x" --body "never run gh pr merge or git push origin main"',
    'git commit -m "never git push origin main"',
    "gh api repos/o/r/issues/5/comments -f body='please merge this'",
    "gh pr view 12 --repo hemut/Command --json state",
  ])("allows %p", (command) => {
    expect(denied(command)).toBe(false);
  });

  test("a request body in a file is read, so a merge cannot hide in --input", () => {
    const file = join(home.dir, "body.json");
    writeFileSync(file, '{"merge_method":"squash"}');
    expect(denied(`gh api repos/o/r/pulls/5/merge --input ${file}`)).toBe(true);
    expect(denied(`gh api repos/o/r/issues --input ${file}`)).toBe(true);
    writeFileSync(file, '{"body":"hello"}');
    expect(denied(`gh api repos/o/r/issues/5/comments --input ${file}`)).toBe(false);
  });
});

describe("forbiddenReason: pushes", () => {
  test.each([
    "git push origin staging",
    "git push origin main",
    "git push origin master",
    "git push -u origin HEAD:staging",
    "git push origin HEAD:refs/heads/main",
    "git push --force origin +HEAD:staging",
    "git push origin feat/x:staging",
    "git push --mirror origin",
    "git push --all origin",
    "git -C /wt push origin staging",
    "git add . && git commit -m x && git push origin main",
  ])("denies %p", (command) => {
    expect(denied(command)).toBe(true);
  });

  test.each([
    "git push -u origin HEAD",
    "git push origin me/and-1-fix-staging-thing",
    "git push --force-with-lease origin HEAD",
    "git push origin HEAD:me/and-1-x",
    "git push",
    "git pull --ff-only origin staging",
    "git fetch origin staging",
    "git rebase origin/staging",
    "git log origin/main..HEAD",
  ])("allows %p", (command) => {
    expect(denied(command)).toBe(false);
  });

  test("a base branch named by the run's env is protected too", () => {
    expect(denied("git push origin release-2", {})).toBe(false);
    expect(denied("git push origin release-2", { MARSHALL_BASE_BRANCH: "release-2" })).toBe(true);
    const repos = JSON.stringify([{ slug: "a", base: "trunk" }]);
    expect(denied("git push origin trunk", { MARSHALL_REPOS_JSON: repos })).toBe(true);
    expect(protectedBranches({ MARSHALL_REPOS_JSON: "not json" }).has("staging")).toBe(true);
  });

  test("refspecTarget reads the destination", () => {
    expect(refspecTarget("HEAD:refs/heads/main")).toBe("main");
    expect(refspecTarget("+a:staging")).toBe("staging");
    expect(refspecTarget("feature")).toBe("feature");
  });
});

describe("judge", () => {
  const payload = (command: unknown, tool = "Bash") =>
    JSON.stringify({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: { command } });

  test("only Bash commands are judged, and bad input is allowed", () => {
    expect(judge(payload("gh pr merge 1"), {})).not.toBeNull();
    expect(judge(payload("gh pr merge 1", "Read"), {})).toBeNull();
    expect(judge(payload(42), {})).toBeNull();
    expect(judge("not json", {})).toBeNull();
  });

  test("the deny decision is what Claude Code reads", () => {
    const decision = JSON.parse(denyDecision("gh pr merge")) as {
      hookSpecificOutput: Record<string, string>;
    };
    expect(decision.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(decision.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(decision.hookSpecificOutput.permissionDecisionReason).toContain("Leave it for a human");
  });
});

describe("the script as a hook", () => {
  async function run(command: string, eventsFile: string) {
    const proc = Bun.spawn(["bun", MERGE_GUARD_PATH, eventsFile], {
      stdin: new Blob([
        JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command },
        }),
      ]),
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return { out, code: proc.exitCode };
  }

  test("a merge prints a deny decision and logs an event; an ordinary command prints nothing", async () => {
    const events = join(home.dir, "events", "run-1.jsonl");
    const bad = await run("gh pr merge 12 --auto", events);
    expect(bad.code).toBe(0);
    expect(JSON.parse(bad.out).hookSpecificOutput.permissionDecision).toBe("deny");
    const line = JSON.parse(readFileSync(events, "utf8").trim()) as {
      event: Record<string, unknown>;
    };
    expect(line.event).toMatchObject({ hook_event_name: "PreToolUse", blocked: true });
    expect(String(line.event.command)).toContain("gh pr merge 12");

    const ok = await run("git status", events);
    expect(ok.out).toBe("");
    expect(readFileSync(events, "utf8").trim().split("\n")).toHaveLength(1);
  });

  test("with no events file it still denies", async () => {
    const proc = Bun.spawn(["bun", MERGE_GUARD_PATH], {
      stdin: new Blob([
        JSON.stringify({ tool_name: "Bash", tool_input: { command: "gh pr merge 1" } }),
      ]),
      stdout: "pipe",
    });
    expect(JSON.parse(await new Response(proc.stdout).text()).hookSpecificOutput).toBeDefined();
    expect(existsSync(join(home.dir, "events"))).toBe(false);
  });
});

describe("failing closed", () => {
  test("the hook command blocks (exit 2) when the guard cannot run at all", () => {
    const settings = JSON.parse(buildAgentSettings("run-9")) as {
      hooks: { PreToolUse: { hooks: { command: string }[] }[] };
    };
    const command = settings.hooks.PreToolUse[0]?.hooks[0]?.command as string;
    expect(command).toEndWith("|| exit 2");
    // No `bun` on PATH: the shell fails to start it, and the `|| exit 2` turns that into a block.
    const run = Bun.spawnSync(["/bin/sh", "-c", command], {
      env: { PATH: "/nonexistent" },
      stdin: new Blob(["{}"]),
    });
    expect(run.exitCode).toBe(2);
  });

  test("a command the guard cannot judge is denied, not allowed", async () => {
    const proc = Bun.spawn(["bun", MERGE_GUARD_PATH, "/proc/nonexistent/events.jsonl"], {
      stdin: new Blob([
        JSON.stringify({ tool_name: "Bash", tool_input: { command: "gh pr merge 1" } }),
      ]),
      stdout: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    expect(JSON.parse(out).hookSpecificOutput.permissionDecision).toBe("deny");
  });
});

describe("wiring in the agent settings", () => {
  test("every run gets the PreToolUse Bash hook that points at the guard and its events file", () => {
    const settings = JSON.parse(buildAgentSettings("run-9")) as {
      hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]>;
    };
    const group = settings.hooks.PreToolUse?.[0];
    expect(group?.matcher).toBe("Bash");
    expect(group?.hooks[0]?.command).toContain(MERGE_GUARD_PATH);
    expect(group?.hooks[0]?.command).toContain("run-9.jsonl");
  });

  test("the committed settings deny gh pr merge as a second lock", () => {
    const base = loadBaseSettings() as { permissions?: { deny?: string[] } };
    expect(base.permissions?.deny).toContain("Bash(gh pr merge:*)");
    expect(base.permissions?.deny).toContain("Bash(git push origin staging:*)");
    expect(base.permissions?.deny).toContain("Bash(gh pr review --approve:*)");
    expect(resolve(MERGE_GUARD_PATH)).toBe(MERGE_GUARD_PATH);
  });
});
