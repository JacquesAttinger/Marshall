---
name: review
description: Review the current branch's diff against the base branch ($MARSHALL_BASE_BRANCH, default main) on two axes - the built-in /code-review bug hunt (CONFIRMED / PLAUSIBLE) and a Spec pass against the plan file. Reports BLOCKING (confirmed), BLOCKING (spec), and NOTES (plausible). Takes an optional review ledger so a later cycle does not re-raise settled points. Use from /marshall:implement after each push, or by hand on a finished branch.
argument-hint: <plan-path> [<ledger-path>]
---

<!-- Last edited: 2026-10-20 18:30 PDT -->

Review the diff between the base branch and `HEAD` on two axes and report three lists.
The base branch is `origin/$MARSHALL_BASE_BRANCH`, or `origin/main` when that var is unset (a run by hand); `<base-ref>` below means that ref.
`/marshall:implement` fixes the two BLOCKING lists and carries NOTES into the hand-off.
`$ARGUMENTS` is the plan file path, relative to the repo root, then an optional review ledger path.
When `MARSHALL_REPOS_JSON` is set (a plan that touches several repos), review every repo in it: sections 1 to 3 run once per entry, with `git -C <dir>` and that entry's `base` in place of `$MARSHALL_BASE_BRANCH`, and the report lists each finding with its repo slug.
The plan file is in the worktree you run in (the primary repo); the Spec pass in every repo checks against it.

## 1. Pin the diff

```bash
git fetch origin --quiet
base=$(git merge-base "origin/${MARSHALL_BASE_BRANCH:-main}" HEAD)
git log --oneline "$base"..HEAD
git diff --stat "$base"...HEAD
```

Stop with `REVIEW SKIPPED: empty diff` if the diff is empty.
Stop with `REVIEW SKIPPED: plan file missing <path>` if the plan path does not name a readable file.
Both cases are the caller's problem, not a finding.

If a ledger path was given and the file exists, read it in full.
It is written by `/marshall:implement` and lists, per earlier cycle, each finding it `fixed:` (with the change and commit) and each finding it `disputed:` (with the reason).
No ledger, or an empty one, means this is the first review: skip every ledger rule below.

**Settled points.** A `disputed:` entry is settled.
Drop a new finding that repeats it, unless the finding names something the dispute did not answer: code changed after the dispute's cycle, or a fact the reason gets wrong.
A dropped finding goes to NOTES as `re-raised, settled in cycle <n>: <summary>`, so the hand-off still shows it.

## 2. Bug hunt (built-in `/code-review`)

Invoke the `Skill` tool with `skill: "code-review"` and `args: "high <base-ref>...HEAD"`.
For each sibling repo in `MARSHALL_REPOS_JSON`, spawn one `general-purpose` sub-agent instead, with this brief: `cd <dir>`, then invoke the `Skill` tool with `skill: "code-review"` and `args: "high origin/<base>...HEAD"`, then report every finding as `<slug>:file:line - summary (verdict)`. It must not edit any file.
It reads every hunk, verifies each candidate, and reports findings with a verdict of `CONFIRMED` or `PLAUSIBLE`.
Do not pass `--fix`; the caller decides what to fix.
Collect every finding as `file:line - summary (verdict)`, then apply the settled-points rule from step 1.
Uncommitted changes are in scope too; the caller commits before it calls this skill, so a working-tree finding means a forgotten commit.

## 3. Spec pass (one sub-agent)

Spawn one `general-purpose` agent with this brief, filled in.
The sub-agent cannot see this file or the caller's context, so the brief carries everything.

> You are reviewing a branch against the plan that asked for it.
> Run `git diff <base>...HEAD` and `git log --oneline <base>..HEAD` in `<cwd>` (base = `<merge-base sha>`).
> The spec is the file `<plan-path>`. Read it in full. Its "Out of scope" and "Out of scope found" sections list work the branch must not do.
>
> Report, quoting the plan line for each finding:
> (a) requirements the plan asked for that are missing or partial;
> (b) behaviour in the diff that the plan did not ask for (scope creep), except tests, comments, and the `Last edited` stamps;
> (c) requirements that look implemented but where the implementation looks wrong, with the file and line.
>
> Tag each (b) finding with one of:
> `fix-driven` when a `fixed:` line in the ledger below explains it (the behaviour is how an earlier review finding was fixed; name the line);
> `rule-driven` when a rule of the repo requires it (a lint gate, a test under `tests/lint/`, `CLAUDE.md`, `AGENTS.md`; name the rule and its file);
> `unasked` otherwise.
> Do not report a finding that repeats a `disputed:` line in the ledger, unless the code it points at changed after that line's cycle or the dispute's reason is wrong; say which.
>
> Ledger (earlier cycles' fixes and disputes; `NONE` on the first review):
> <the ledger text, verbatim, or NONE>
>
> Number each finding. State `NONE` under a heading that has no findings. Under 400 words. Do not edit any file.

## 4. Report

Print exactly these three headings, each followed by a numbered list or `NONE`:

```
## BLOCKING (confirmed)
<CONFIRMED findings from step 2, file:line - summary>

## BLOCKING (spec)
<findings (a) and (c) from step 3, plus (b) findings tagged `unasked` that change runtime code>

## NOTES (plausible)
<PLAUSIBLE findings from step 2, one line each; (b) findings that are docs or tests only, or tagged `fix-driven` or `rule-driven`, with the tag; re-raised settled points>
```

End the report with one line: `REVIEW: <n> confirmed, <n> spec, <n> notes`.
Do not rerank across lists and do not fix anything.
A `fix-driven` finding is a note, not a block, because the fix is what an earlier cycle asked for; blocking it makes two reviews undo each other and spends a cycle on nothing.
When `/marshall:implement` called you, the report is its input for the next step, not the end of the run: hand it over and continue that skill.
