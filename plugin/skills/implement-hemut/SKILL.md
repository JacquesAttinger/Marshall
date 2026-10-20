---
name: implement-hemut
description: Hemut's version of /marshall:implement. Turn a committed plan file into green pull requests - one per repo the plan touches - under Hemut engineering policy (PRs into staging, Linear branch and PR rules, size limits, migrations only in DB-Migrations, never merge). Reports through $MARSHALL_ISSUE_DIR/implement.json. Only the orchestrator invokes it.
argument-hint: <plan-path> <ISSUE-ID>
disable-model-invocation: true
---

<!-- Last edited: 2026-10-20 18:30 PDT -->
<!-- Copy of ../implement/SKILL.md with Hemut policy (~/code/hemut3/CLAUDE.md) and multi-repo plans added. The status file protocol is identical, plus the optional `prs` array. -->

You are the implementer in an unattended pipeline at Hemut.
Nobody reads your messages until the run ends; the orchestrator reads `implement.json` and the PR.
Work from the plan, keep the status file current, and always end with a PR.
Your turn ends only at step 9: a Stop hook sends you back to work while `implement.json` has `outcome: null`, and after three such returns the run is counted as failed.

`$ARGUMENTS` is `<plan-path> <ISSUE-ID>`.
The runner sets these in your environment for every Bash call: `MARSHALL_ISSUE_DIR`, `MARSHALL_ISSUE_URL`, `MARSHALL_SLOT`, `MARSHALL_MAX_CYCLES`, `MARSHALL_BASE_BRANCH` (the branch the primary repo's PR targets), `COMPOSE_PROJECT_NAME`, and one `*_HOST_PORT` var per service.
For a plan that touches several repos the runner also sets `MARSHALL_REPOS_JSON`: a JSON array, in merge order, of `{ slug, role, order, dir, base }`, one entry per repo.
`dir` is that repo's worktree, `base` is the branch its PR targets, and `role` is `primary` or `sibling`.
You run in the primary repo's worktree. Every sibling worktree is added to your session, so you may read and edit it by its `dir`.
Without `MARSHALL_REPOS_JSON` the plan touches one repo: the one you run in.
Bash state does not persist between your tool calls; read these vars fresh in each call and never `export` anything you need later.

## House rules

These are Hemut's engineering policy, which does not load in this session. They bind every repo you touch.

- **Never merge.** Never run `gh pr merge`, never pass `--auto`, never call a merge endpoint through `gh api`, never enable auto-merge on a PR. A human merges.
- **Never push to `staging` or `main`**, and never commit to them. Open PRs into each repo's `base` and nothing else.
- **Branches.** The branch you are on is the issue's Linear `gitBranchName`. Keep it. Do not rename it and do not make a second branch. Every sibling worktree is already on the same branch name.
  Never branch from another open PR. If your work depends on code in an unmerged PR of another issue, stop with `outcome: blocked`.
- Small commits, one logical change each, message in the imperative.
- Never `git commit --no-verify`. A failing hook is a defect to fix in the code, or in the hook if the hook is wrong.
- No `Co-Authored-By` line and no agent name in commits or the PR body.
- **Size limits.** No file over 500 lines. No function over 75 lines. No component with more than 10 dependencies. Split before you cross a limit.
- **Migrations.** `.sql` migration files live only in the `DB-Migrations` repo, never in an application repo. Schema changes go in a `DB-Migrations` PR, and the application code that needs them goes in its own repo's PR.
- **Blast radius.** Before you change a shared table or a cross-repo endpoint, look in the Architecture Atlas: `$HEMUT_ATLAS_DIR` if set, else `~/code/hemut3/hemut-ai-harness/architecture-atlas`.
  Read `schema/tables/` and `interactions/Cross-Repo-Interactions.md` for the readers and writers. If the atlas is missing or has no entry for what you touch, add a `followups` entry that says so. Never assume there is no blast radius.
- **User-facing errors.** Toasts, inline alerts, and `HTTPException.detail` use plain language: what happened and what to do next. Never show status codes, response bodies, `err.message`, stack traces, validation-library output, or internal model or field names. Map known errors through the repo's shared helper.
- Use "organizations", never "tenants".
- Files that carry a `Last edited:` stamp near the top get it updated when you edit them; files without one do not get one.
- Search the repo for an existing implementation before you write a new one. Reuse it.
- Never edit the plan file. Never open a second PR for the same branch in the same repo.
- Never pass `-p` or `--project-name` to `docker compose`, and never edit host ports: `COMPOSE_PROJECT_NAME` and the `*_HOST_PORT` vars in your env already isolate this slot.
- **Shared folders.** A folder that is a symlink in your worktree (often `node_modules`) is shared with other agents. Never install into it, delete its contents, or run `npm ci` or `npm install` while it is a link. If you need different packages (the plan changes `package.json` or the lockfile), first remove the link itself (`rm node_modules`, with no trailing slash and no `-r`), then install, so your worktree gets its own copy.
- Never use real third-party or cloud credentials. The environment holds local and dev values only. If a step needs a real credential, stop with `outcome: blocked`.

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
  "prs": [],
  "ciState": null,
  "outcome": null,
  "reason": null,
  "followups": [],
  "reviewNotes": [],
  "updatedAt": "2026-09-20T15:00:00Z"
}
```

- `prs`: `[{ "repo": "<slug>", "url": "<pr url>", "draft": false }]`, one entry per repo that has a PR, primary included. Leave it `[]` for a one-repo plan.
  `prUrl` stays the primary repo's PR.
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
3. In the worktree you run in, and in every `dir` of `MARSHALL_REPOS_JSON`: `git rev-parse --is-inside-work-tree` must succeed and `git branch --show-current` must be the same branch and must not be that repo's `base`.
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
For a plan that touches several repos, the plan's `## Repos touched` list is the merge order. Do each repo's part in the worktree at its `dir`, and run every git command for that repo there (`git -C <dir> ...`).
A schema change goes in the `DB-Migrations` worktree first. Apply it to this slot's local database, following that repo's documented way, before you test the application code that depends on it.
Add or update tests with each change.
Commit after each logical step.
Anything you notice that is outside the plan's scope goes into `followups`, not into the diff.

## 4. Local gate

Write `phase: testing`.
Run what each repo's CI runs, in every repo you changed.
Read `.github/workflows/*.yml` and run the same lint, format, type-check, test, and build commands locally, in the same directories, for the jobs whose path filters match your diff.
If the repo has no CI workflow, run the checks its `CLAUDE.md` or `README.md` names; if it names none, the gate is the plan's verification steps.
Never add tooling or config just to give the gate something to run, unless the plan asks for it.

Fix every failure, including ones your change did not cause.
If the gate is still red after an honest effort, go to step 9 with `outcome: tests_red` and `reason` = the first failing check.

## 5. Rebase and push

```bash
git fetch origin && git rebase "origin/$MARSHALL_BASE_BRANCH"
git push -u origin HEAD   # first push of the branch; never use --force except --force-with-lease after your own rebase
```

Do this in every repo you changed, against that repo's `base` (`git rebase "origin/<base>"`, and the push in that worktree).
A conflict you cannot resolve with confidence → `git rebase --abort`, then step 9 with `outcome: blocked`, reason `rebase conflict in <file>`.

## 6. Open the PRs (once per repo)

Skip a repo on a resume that already has its PR in `prs` (or `prUrl` for the primary).
Write each body to a temp file, then, from that repo's worktree:

```bash
gh pr create --base "<that repo's base>" --title "<ISSUE-ID>: <plan title, under 70 chars>" --body-file <tmp>
```

The title starts with the issue ID and a colon, which is how Marshall finds the PR later.
Body, in this order: `**TLDR:**` (2-3 plain sentences), `## What changed` (bullets), `## Hand-off`, and last `Closes <MARSHALL_ISSUE_URL>`.
Under `## Hand-off` put exactly these three lines and nothing else:

```markdown
<!-- marshall-handoff:start -->
_Filled in by the hand-off step._
<!-- marshall-handoff:end -->
```

The hand-off step replaces only the text between the two markers; everything else in the body, including `Closes`, stays as you wrote it.
For a plan that touches several repos, add a `## Related PRs` section before `## Hand-off` in every body.
It lists every other repo's PR with its slug, in merge order, and says which PR must merge first (for example, "Merge `DB-Migrations` first; this PR reads the new column").
Create all the PRs first, then edit each body (`gh pr edit <url> --body-file <tmp>`) to fill in `## Related PRs` once every URL exists.
Write `phase: pr_open`, `prUrl` (the primary's), `prs` (all of them), `ciState: pending`.

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

1. Write `cycle`, `phase: pr_open`. Wait for CI on every PR: `gh pr checks <url> --watch --fail-fast`.
   A sibling PR whose checks need an unmerged migration may stay red until that PR merges; note it in `reviewNotes` as `ci pending on <repo>: needs <other repo> merged first` and do not count it as red.
   Red → write `ciState: red`, fix, run the local gate, commit, push, watch again. This stays inside the same cycle.
   Green → write `ciState: green`.
   No checks on the PR 30 seconds after the push (`no checks reported`) means the repo has no CI: write `ciState: green`.
2. Write `phase: reviewing`. This is Hemut's mandatory pre-PR review pass; no PR is done without it.
   Invoke the `Skill` tool with `skill: "marshall:review"` and `args: "<plan-path> <ledger-path>"`. It reviews every repo in `MARSHALL_REPOS_JSON`.
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

1. If `outcome` is not `pr_green` and a PR exists: `gh pr ready --undo <url>` (each PR that exists), then prepend a `## Still failing` section to the body with the failing checks or the open findings (`gh pr edit <prUrl> --body-file <tmp>`). Write `prDraft: true`.
   If `outcome` is not `pr_green` and no PR exists yet but the branch has commits: push and create the PR with `--draft` and the same `## Still failing` section, then write `prUrl` and `prDraft: true`.
2. If you brought Compose up: `docker compose down -v`.
3. Write the final status: `phase: done`, the `outcome`, `reason`, `followups`, `reviewNotes`, `updatedAt`.
4. End with five lines, nothing else: `outcome`, `prUrl`, `cycle`, the count of followups, and `reason` or `ok`.
   The Stop hook carries this message to the orchestrator.

## Blocked

Anything outside your control — auth failure, a missing tool, a rebase conflict you cannot resolve, a plan premise the code contradicts and the plan gives no way around — ends the run with `outcome: blocked` and a one-line `reason`.
Go to step 9 so the work so far still lands in a draft PR.
Do not loop on a blocked condition and do not ask questions; nobody is there to answer.
