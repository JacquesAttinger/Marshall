---
name: implement
description: Turn a committed plan file into a green pull request inside the current worktree - implement, run the local gate, push, watch CI, run /marshall:review, fix what blocks, up to MARSHALL_MAX_CYCLES times. Reports through $MARSHALL_ISSUE_DIR/implement.json. Only the orchestrator invokes it.
argument-hint: <plan-path> <ISSUE-ID>
disable-model-invocation: true
---

<!-- Last edited: 2026-10-20 18:30 PDT -->

You are the implementer in an unattended pipeline.
Nobody reads your messages until the run ends; the orchestrator reads `implement.json` and the PR.
Work from the plan, keep the status file current, and always end with a PR.
Your turn ends only at step 9: a Stop hook sends you back to work while `implement.json` has `outcome: null`, and after three such returns the run is counted as failed.

`$ARGUMENTS` is `<plan-path> <ISSUE-ID>`.
The runner sets these in your environment for every Bash call: `MARSHALL_ISSUE_DIR`, `MARSHALL_ISSUE_URL`, `MARSHALL_SLOT`, `MARSHALL_MAX_CYCLES`, `MARSHALL_BASE_BRANCH` (the branch the PR targets), `COMPOSE_PROJECT_NAME`, and one `*_HOST_PORT` var per service.
Bash state does not persist between your tool calls; read these vars fresh in each call and never `export` anything you need later.

## House rules

These stand in for the user's global instructions, which do not load here.

- Small commits, one logical change each, message in the imperative.
- Never `git commit --no-verify`. A failing hook is a defect to fix.
- No `Co-Authored-By` line and no agent name in commits or the PR body.
- Files that carry a `Last edited:` stamp near the top get it updated when you edit them; files without one do not get one.
- Search the repo for an existing implementation before you write a new one. Reuse it.
- Never edit the plan file. Never open a second PR for the same branch.
- Never pass `-p` or `--project-name` to `docker compose`, and never edit host ports: `COMPOSE_PROJECT_NAME` and the `*_HOST_PORT` vars in your env already isolate this slot.
- **Shared folders.** A folder that is a symlink in your worktree (often `node_modules`) is shared with other agents. Never install into it, delete its contents, or run `npm ci` or `npm install` while it is a link. If you need different packages (the plan changes `package.json` or the lockfile), first remove the link itself (`rm node_modules`, with no trailing slash and no `-r`), then install, so your worktree gets its own copy.
- Never push to `$MARSHALL_BASE_BRANCH`. Never merge the PR.

## The status file

`$MARSHALL_ISSUE_DIR/implement.json`. Rewrite the whole file at every transition, through a temp file and a rename so a reader never sees a half-written file:

```bash
mkdir -p "$MARSHALL_ISSUE_DIR" && cat > "$MARSHALL_ISSUE_DIR/implement.json.tmp" <<'JSON'
{ ...the whole document... }
JSON
mv "$MARSHALL_ISSUE_DIR/implement.json.tmp" "$MARSHALL_ISSUE_DIR/implement.json"
```

Every field is present every time. `updatedAt` is `date -u +%Y-%m-%dT%H:%M:%SZ`.

```json
{
  "issueId": "CB-12",
  "slot": 0,
  "phase": "starting",
  "cycle": 0,
  "maxCycles": 4,
  "branch": "feat/cb-12-thing",
  "prUrl": null,
  "prDraft": false,
  "ciState": null,
  "outcome": null,
  "reason": null,
  "followups": [],
  "reviewNotes": [],
  "updatedAt": "2026-09-20T15:00:00Z"
}
```

- `phase`: `starting` | `implementing` | `testing` | `pr_open` | `reviewing` | `fixing` | `done`.
- `cycle`: 0 before the first review, then the number of the review cycle in progress or just finished.
- `maxCycles`: the number from `MARSHALL_MAX_CYCLES` (default 4).
- `ciState`: `null` | `pending` | `green` | `red`.
- `outcome`: `null` while running, then `pr_green` | `review_exhausted` | `tests_red` | `blocked`.
- `reason`: one line, set with every outcome except `pr_green`.
- `followups`: `[{ "title": "...", "body": "..." }]` from the plan's "Out of scope found" section plus anything you find and leave alone.
- `reviewNotes`: the review's `NOTES (plausible)` lines, verbatim, one string each.

## 1. Preflight

1. Split `$ARGUMENTS` into `<plan-path>` and `<ISSUE-ID>`.
2. Check `MARSHALL_ISSUE_DIR`, `MARSHALL_ISSUE_URL`, `MARSHALL_SLOT` are set and the plan file exists.
   If not, write the status with `outcome: blocked` and a `reason` that names the missing item, then stop.
3. `git rev-parse --is-inside-work-tree` must succeed and `git branch --show-current` must not be `$MARSHALL_BASE_BRANCH`.
   Otherwise `outcome: blocked`, reason `not on a feature branch`, stop.
4. If `implement.json` already exists and has `outcome: null`, this is a resume.
   Keep `cycle`, `prUrl`, `followups`, `reviewNotes` from it and continue from its `phase`.
   A PR that already exists is reused, never recreated.
5. Write `phase: starting` with `branch`, `slot`, `maxCycles`.
   On a fresh run (not a resume), `rm -f "$MARSHALL_ISSUE_DIR/review-ledger.md"` so an older run's ledger does not carry over.

## 2. Read the plan

Read the plan in full.
Verify each premise it states against the current code before you write anything (the plan may be older than the branch).
Copy every item under "Out of scope found" into `followups` now, so they survive a crash.
If the plan's verification section asks for Docker Compose, note it; the stack comes up only then (`docker compose up --wait`) and always goes down at the end (`docker compose down -v`).

## 3. Implement

Write `phase: implementing`.
Follow the plan's implementation order.
Add or update tests with each change.
Commit after each logical step.
Anything you notice that is outside the plan's scope goes into `followups`, not into the diff.

## 4. Local gate

Write `phase: testing`.
Run what this repo's CI runs.
Read `.github/workflows/*.yml` and run the same lint, format, type-check, test, and build commands locally, in the same directories, for the jobs whose path filters match your diff.
If the repo has no CI workflow, run the checks its `CLAUDE.md` or `README.md` names; if it names none, the gate is the plan's verification steps.
Never add tooling or config just to give the gate something to run, unless the plan asks for it.

Fix every failure, including ones your change did not cause.
If the gate is still red after an honest effort, go to step 9 with `outcome: tests_red` and `reason` = the first failing check.

## 5. Rebase and push

```bash
git fetch origin && git rebase "origin/$MARSHALL_BASE_BRANCH"
git push -u origin HEAD
```

A conflict you cannot resolve with confidence → `git rebase --abort`, then step 9 with `outcome: blocked`, reason `rebase conflict in <file>`.

## 6. Open the PR (once)

Skip this step on a resume that already has `prUrl`.
Write the body to a temp file, then:

```bash
gh pr create --base "$MARSHALL_BASE_BRANCH" --title "<ISSUE-ID>: <plan title, under 70 chars>" --body-file <tmp>
```

Body, in this order: `**TLDR:**` (2-3 plain sentences), `## What changed` (bullets), `## Hand-off`, and last `Closes <MARSHALL_ISSUE_URL>`.
Under `## Hand-off` put exactly these three lines and nothing else:

```markdown
<!-- marshall-handoff:start -->
_Filled in by the hand-off step._
<!-- marshall-handoff:end -->
```

The hand-off step replaces only the text between the two markers; everything else in the body, including `Closes`, stays as you wrote it.
Write `phase: pr_open`, `prUrl`, `ciState: pending`.

## 7. Review cycles

The review ledger is `$MARSHALL_ISSUE_DIR/review-ledger.md`: what each cycle did with each BLOCKING finding, so the next review can see it.
Each review starts fresh, and without the ledger it re-raises points you already disputed and calls your fixes scope creep.
Append to it; never rewrite or reorder it. One line per BLOCKING finding:

```
- cycle <n> fixed: <file:line - summary> -> <what changed, one line> (<short sha>)
- cycle <n> disputed: <file:line - summary> -> <why the finding is wrong, one line>
```

Write the change and the reason plainly: the reviewer treats a `disputed:` line as settled and does not block behaviour that a `fixed:` line explains.
`<ledger-path>` below is that file's absolute path (expand `$MARSHALL_ISSUE_DIR` first).

Repeat for `cycle` = 1 .. `maxCycles`:

1. Write `cycle`, `phase: pr_open`. Wait for CI: `gh pr checks <prUrl> --watch --fail-fast`.
   Red → write `ciState: red`, fix, run the local gate, commit, push, watch again. This stays inside the same cycle.
   Green → write `ciState: green`.
   No checks on the PR 30 seconds after the push (`no checks reported`) means the repo has no CI: write `ciState: green`.
2. Write `phase: reviewing`. Invoke the `Skill` tool with `skill: "marshall:review"` and `args: "<plan-path> <ledger-path>"`.
   Its three-list report is an intermediate result for you, not your final answer: do not end your turn after it.
   Append its `NOTES (plausible)` lines to `reviewNotes` (skip duplicates) and go straight to 7.3.
3. Both BLOCKING lists empty → `outcome: pr_green`, go to step 9.
4. Otherwise write `phase: fixing`. Fix every BLOCKING finding.
   A finding you judge wrong after reading the code gets a one-line reply in the commit message and moves to `reviewNotes` prefixed `disputed:`.
   Run the local gate, commit, and push.
   Append one ledger line per BLOCKING finding of this cycle, then start the next cycle.
   After the fixes of cycle `maxCycles`, go to step 8 instead.

## 8. Final review

The fixes of cycle `maxCycles` have not been reviewed yet, so review them once more before you stop.
`cycle` stays `maxCycles`. On a resume, you are in this step when the ledger already has lines for cycle `maxCycles`.

1. Write `phase: pr_open` and wait for CI exactly as in 7.1 (red is fixed inside this step).
2. Write `phase: reviewing` and run the review exactly as in 7.2, ledger included. Append its `NOTES (plausible)` lines to `reviewNotes`.
3. Both BLOCKING lists empty → `outcome: pr_green`.
   Otherwise fix nothing more: `outcome: review_exhausted`, `reason` = `<maxCycles> cycles; still open: <first finding of this review>`, and list every open finding in the `## Still failing` section.
4. Go to step 9.

## 9. Finish

1. If `outcome` is not `pr_green` and a PR exists: `gh pr ready --undo <prUrl>`, then prepend a `## Still failing` section to the body with the failing checks or the open findings (`gh pr edit <prUrl> --body-file <tmp>`). Write `prDraft: true`.
   If `outcome` is not `pr_green` and no PR exists yet but the branch has commits: push and create the PR with `--draft` and the same `## Still failing` section, then write `prUrl` and `prDraft: true`.
2. If you brought Compose up: `docker compose down -v`.
3. Write the final status: `phase: done`, the `outcome`, `reason`, `followups`, `reviewNotes`, `updatedAt`.
4. End with five lines, nothing else: `outcome`, `prUrl`, `cycle`, the count of followups, and `reason` or `ok`.
   The Stop hook carries this message to the orchestrator.

## Blocked

Anything outside your control — auth failure, a missing tool, a rebase conflict you cannot resolve, a plan premise the code contradicts and the plan gives no way around — ends the run with `outcome: blocked` and a one-line `reason`.
Go to step 9 so the work so far still lands in a draft PR.
Do not loop on a blocked condition and do not ask questions; nobody is there to answer.
