<!-- Last edited: 2026-10-18 12:44 PDT -->

# Plan: Overnight plan queue for the Hemut repos

## TLDR

You write plans during the day.
At night, you queue them with one command.
A Marshall copy on your always-on VM then builds each plan and opens pull requests (PRs).
It can work in several Hemut repos at the same time, and one plan can change more than one repo.
Marshall never merges.
GitHub already needs one human approval on `staging`, and we add a second lock in the agent settings.
Marshall only picks issues that you label `marshall:queued`, so it never touches your other Linear work.

## Context

Marshall is a Bun and TypeScript daemon.
Today it polls one Linear team for Todo issues assigned to the key's user, plans each issue, implements the plan, and hands off a PR (`README.md`, `docs/state_machine.md`).
Three facts block the Hemut use case:

- **One repo per project.**
  The config has one `repoPath` and one `baseBranch` (`marshall.vm.config.json`).
  The project registry has one active project, and a switch is refused while an agent works (`src/projects.ts`, `docs/runbook.md`).
  Hemut has about 10 repos under `~/code/hemut3/`, and its PRs target `staging`.
- **Every Todo issue is picked.**
  `PickableIssues` in `src/linear/queries.ts:116` takes every unstarted issue assigned to the user.
  Its only exclusion is the `human-only` label.
  In the Hemut workspace this includes real work such as AND-2259 and AND-1777.
- **The planner always runs.**
  A claimed issue goes to `runPlanPhase` first (`src/master/agent.ts:52`).
  A plan you already wrote would be thrown away and redone.

Facts that help:

- Agents run with `--permission-mode bypassPermissions` and no tool limits, so sub-agents already work (`src/runner/launch.ts:44`).
  The runner already hooks `SubagentStop`, and `/marshall:review` spawns a sub-agent (`plugin/skills/review/SKILL.md:35`).
- `/marshall:implement <plan-path> <ISSUE-ID>` already does the job of your `ship-plan` skill: commits, local gate, PR, CI, review, fix cycles.
  Agents cannot load `~/.claude/skills/` (`--setting-sources project,local`), so `ship-plan` itself cannot run here.
- GitHub already protects `staging` in `Hemut2025/Command`.
  The ruleset needs 1 approving review, resolved review threads, and passing status checks.
  Jacques has push access only, not admin, so a self-merge is blocked (checked 2026-10-18 with `gh api repos/Hemut2025/Command/rules/branches/staging`).
  Repeat this check for every repo that joins the registry.

## Hemut policy this plan must follow

Source: `~/code/hemut3/CLAUDE.md`.
The Hemut implement skill (Phase 4) carries these rules, because `~/.claude/CLAUDE.md` and the Hemut file do not load inside a Marshall agent.

- Never commit to `staging` or `main`.
  Open the PR into `staging`.
- Branch name is the Linear `gitBranchName` of the issue, exactly.
  Start from `git checkout <default> && git pull --ff-only`.
  Never branch from another open PR.
- PR title contains the Linear issue ID.
  PR body has `Closes <LINEAR-URL>` and a summary of what and why.
- Run the `/code-review` pass before the PR, and fix everything it finds.
- Never use `git commit --no-verify`.
- No file over 500 lines, no function over 75 lines, no component with more than 10 dependencies.
- `.sql` migrations live only in `DB-Migrations`.
  Check the Architecture Atlas before you change a shared table or a cross-repo endpoint.
  If the atlas has no entry, the agent says so in the hand-off.
- User-facing errors and toasts use plain language.
  No status codes, raw payloads or library output.
- Use "organizations", never "tenants".
- Every review comment gets a reply and a resolved thread.
  This matters when a human bounces the issue back.
- No co-author line and no agent name in commits or the PR body.

## Decisions (made with Jacques on 2026-10-18)

1. **One daemon, many repos.**
   A repo registry maps each repo to its path, base branch, and local gate.
   One dashboard and one set of caps cover all of them.
2. **Cross-repo plans.**
   A plan lists the repos it touches.
   One agent gets one worktree per repo.
   Marshall opens one PR per repo, links them to each other, and writes one hand-off with the merge order.
3. **Sub-agents stay allowed.**
   The run shares one clock and one slot, so Hemut runs raise `issueTimeoutHours` and `stallMinutes`.
4. **Opt-in pick-up.**
   A per-project `pickup` setting.
   `"assigned"` is today's behavior and stays the default.
   Hemut uses `"labeled"` with the label `marshall:queued`.
   An optional `linearProjectId` filter narrows a project further.
5. **Staging-safe secrets.**
   The VM gets one `.env` per repo with local or dev values only.
   It holds no AWS credentials and no prod keys.
6. **The plan lives in Linear.**
   `marshall enqueue` creates the issue with the plan as its body, or as an attached Linear document when the plan is long.
   Marshall writes it to `docs/<topic>_plan.md` in each worktree and commits it first.

Defaults taken without a question (change them if you disagree):

- **Never merge, two locks.**
  The GitHub ruleset is lock one.
  Lock two is deny rules for `gh pr merge`, `gh pr merge --auto`, and `gh api` calls to a `merge` endpoint, in `agent-settings.json`.
- **Merge order.**
  A migration PR and an app PR cannot stack, because Hemut forbids branching from an open PR.
  The agent tests the app against the migration in the sibling worktree.
  The hand-off says "merge `DB-Migrations` first."
- **Rollout.**
  Start with one repo and one tiny plan.
  Add repos one at a time.
  Keep `dailyStartCap` low in week one.
- **Notifications.**
  Keep the existing ntfy.sh push for Needs Verification and Blocked.

## Plan

Each phase is a separate PR in this repo.
Keep each file under 500 lines and each function under 75 lines (`bun run check:size`).

### Phase 1 — Opt-in pick-up (smallest, safest, ship first)

1. Add `pickup: "assigned" | "labeled"`, `pickupLabel` (default `marshall:queued`), and optional `linearProjectId` to the config schema in `src/config.ts`.
   Default `pickup` to `"assigned"`.
2. Make `PickableIssues` in `src/linear/queries.ts` take the label and project filters as variables.
   Today it hard-codes the `human-only` exclusion.
   In `"labeled"` mode, require the label and keep the `human-only` exclusion too.
3. Create the `marshall:queued` label in `src/linear/setup.ts` (`marshall linear setup` already creates labels).
4. Mirror the label check in `src/scheduler/tick.ts:164`, the place that already re-checks `human-only`.
   A label removed after claim must stop a start that has not begun.
5. Show the pick-up mode in `marshall queue` and on the dashboard.
6. Tests: the queue test under `tests/scheduler/` and `tests/linear/` covers `"assigned"` unchanged, and `"labeled"` skips unlabeled issues.

### Phase 2 — Plan intake (skip the planner)

1. Define the plan header that `marshall plan check` already half-enforces.
   Add a required `## Repos touched` section that lists `repo`, `role` (primary or sibling) and `order` for each repo.
   Update `src/plan/` and `docs/planning.md`.
2. In `src/master/agent.ts`, when the issue has a plan source (label `marshall:has-plan`, or a plan block in the body), skip `PLANNING`.
   Write the plan to each worktree, commit it, run `checkPlanFile`, and go straight to implement.
   A bad plan moves the issue to Blocked with the reason.
3. Add `marshall enqueue <plan-file> [--repo <slug>...]`.
   It validates the plan, creates the Linear issue in Team Andrew1 (body or attached document), adds `marshall:queued` and `marshall:has-plan`, and prints the issue URL and the `gitBranchName`.
4. Tests: a plan-intake master-agent test with the fake `claude` shim, and an `enqueue` CLI test.

### Phase 3 — Multi-repo registry and worktrees

1. Extend the config with a `repos` list: slug, `repoPath`, `baseBranch`, local gate command, `services` and `portOffsetPerSlot` where the repo needs them.
   Keep a single `repoPath` working as a one-repo list, so existing configs do not break.
2. Change `src/worktree.ts` so one claim creates one worktree per repo in the plan's `Repos touched`, all on the same `gitBranchName`, with each repo's `.env*` copied in.
3. Extend `src/isolation.ts` so one slot gets one Compose project and one port set for the whole claim.
   Do not collide with the other slots.
4. Run the agent from a parent folder for the claim.
   Give it every worktree path through env vars and `--add-dir`.
5. Teach the claim row (`src/scheduler/store.ts`) to hold a list of worktrees and PRs, not one.
6. Update `reconcile` and the rebase flow to loop over the repos.
   A merged sibling PR in one repo rebases only that repo's waiting PR.
7. Keep the shared caps (`maxAgents`, `dailyStartCap`, `windowStartCap`) per claim, not per repo.
8. Tests: worktree and isolation tests with two fixture repos, and a reconcile test with one claim and two PRs.

### Phase 4 — Hemut implement skill

1. Add `plugin/skills/implement-hemut/` as a copy of `/marshall:implement` with the Hemut policy list from this plan as its house rules.
   Keep the status-file protocol (`implement.json`) identical, so the orchestrator needs no new reader.
2. Make it multi-repo aware.
   It reads the worktree list, opens one PR per repo (`gh pr create --base <staging>` from each worktree), and cross-links the PRs in each body.
3. Make `/marshall:review` accept a repo list, so one review pass covers every diff and the plan.
4. Add a config key, for example `skills.implement`, so the Hemut project picks `implement-hemut` and other projects keep `implement`.
5. Add a plugin test that checks every skill file for the required house-rule headings.

### Phase 5 — Never merge, hand-off, safety

1. Add deny rules to `agent-settings.json` for `gh pr merge` (any flags), `gh api` against `/merge`, and `git push` to `staging` or `main`.
   Add a hook, in case a deny rule is bypassed, that blocks the same commands and writes an event.
2. Extend `/marshall:handoff` for several PRs.
   It lists each PR, the merge order, and which Atlas entries were checked.
3. Raise `issueTimeoutHours` and `stallMinutes` for Hemut in its project config.
   Document the reason: sub-agent runs are long and quiet.
4. Add `docs/hemut_runbook.md`: queue a plan, read the morning dashboard, bounce an issue, remove the label to stop one.

### Phase 6 — VM setup and rollout

1. On the VM, clone each Hemut repo, install its toolchain and Docker, and write the staging-safe `.env` files by hand.
   Do not copy any `.env` from the Mac.
2. Create a Hemut project in the registry with its own Linear key.
   Use `bin/marshall project import` and `bin/marshall linear setup`.
   The setup command refuses a key from a different workspace.
3. Check the GitHub ruleset on every repo before you add it (`gh api repos/<org>/<repo>/rules/branches/staging`).
   Do not add a repo where a self-merge is possible.
4. Dry run: one tiny plan in one repo, with `dailyStartCap` at 1.
   Read the PR, the hand-off, and the Linear comment.
5. Add repos one at a time.
   Run a cross-repo plan (a `DB-Migrations` change plus an app change) once the single-repo run is clean.
6. Raise the caps only after a week of clean nights.

## Likely touched files

- `src/config.ts`, `marshall.vm.config.json`, a new Hemut project config, `agent-settings.json`
- `src/linear/queries.ts`, `src/linear/setup.ts`, `src/linear/map.ts`
- `src/scheduler/tick.ts`, `src/scheduler/store.ts`, `src/scheduler/reconcile.ts`
- `src/master/agent.ts`, `src/master/types.ts`, `src/master-agent.ts`, `src/plan/*`
- `src/worktree.ts`, `src/isolation.ts`, `src/projects.ts`
- `src/cli/index.ts`, a new `src/cli/enqueue.ts`, `src/cli/queue.ts`, `src/cli/status.ts`
- `plugin/skills/implement-hemut/`, `plugin/skills/review/`, `plugin/skills/handoff/`
- `src/dashboard/*` (pick-up mode, one claim with several PRs)
- `docs/planning.md`, `docs/runbook.md`, `docs/state_machine.md`, a new `docs/hemut_runbook.md`, `README.md`
- `tests/` for each phase, as listed above

Check `src/master/agent.ts` (353 lines) first.
It is near the 500-line limit, so split it before you add the plan-intake branch.

## Risks

- **Wrong repo or wrong issue.**
  Mitigation: opt-in label, `human-only` still wins, and a low `dailyStartCap` at the start.
- **A key leaks from the VM.**
  Mitigation: staging-safe `.env` only, no AWS credentials, and no prod access from the VM.
  Marshall also reads Linear text that other people write, so treat it as untrusted input.
- **A merge happens.**
  Mitigation: the ruleset, the deny rules, and the hook.
  Drill it once: ask a test agent to run `gh pr merge` on a throwaway PR and confirm it is blocked.
- **Cross-repo PRs land out of order.**
  Mitigation: the merge order in the hand-off, plus a note at the top of each PR body.
  Hemut forbids stacked PRs, so the app PR's CI may stay red until the migration lands.
- **Long runs get killed.**
  Mitigation: the raised `issueTimeoutHours` and `stallMinutes`, and one `Stop` guard per claim.
- **The Max-plan budget runs out.**
  Mitigation: shared caps.
  Opus implementation plus a code review on a long list is expensive, so watch the first week.
- **The plan quality is bad.**
  Marshall now trusts your plan without the planner's checks.
  Mitigation: `plan check` on enqueue, and a plan that fails it never reaches the VM.

## Decisions made alone

- Gave Phase 1 first place because it is the only change that protects your real Linear work.
  It ships alone and is safe on its own.
- Chose a new `implement-hemut` skill over editing `/marshall:implement`, so the non-Hemut projects do not change.
- Kept `pickup: "assigned"` as the default, so no existing project changes behavior.

## Out of scope

- A Testing agent, voice intake, or goal splitting (README roadmap).
- Moving Marshall off the Oracle VM.
- Auto-merging, even for green PRs, even when a human approves.
- Dependency graphs between plans (plan B waits for plan A's merge).
  Order is only a note in the hand-off for now.
- A Linear webhook in place of polling.

## Verification

1. `bun run lint`, `bun run typecheck`, `bun run check:size`, and `bun test` pass after each phase.
2. Phase 1: with `pickup: "labeled"`, `marshall queue` lists only labeled issues, and an unlabeled Todo issue assigned to you does not start.
3. Phase 2: a queued plan makes no planner run (`runs` has no plan row) and the PR contains the plan file as its first commit.
4. Phase 3 and 4: a two-repo plan opens two PRs on the same `gitBranchName`, each into `staging`, each linked to the other.
5. Phase 5: a test agent that runs `gh pr merge` is blocked, and the event appears in the log.
6. Phase 6: the dry-run PR passes the Hemut policy list by hand, line by line, and has a green CI run.
7. After the first cross-repo night, check the morning dashboard from your phone, then read one hand-off in full.
