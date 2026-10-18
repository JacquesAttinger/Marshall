<!-- Last edited: 2026-10-18 21:10 PDT -->

# Hemut overnight queue — runbook

**TLDR:** You write plans during the day and queue them with `marshall enqueue`.
At night, Marshall on the VM builds each plan and opens pull requests (PRs) into `staging`.
It can work in several Hemut repos at once, and one plan can change more than one repo.
Marshall never merges.
In the morning you read the dashboard, review the PRs, and merge them yourself.

Plan of record: [`hemut_overnight_queue_plan.md`](hemut_overnight_queue_plan.md).
Config: [`marshall.hemut.config.json`](../marshall.hemut.config.json).
Policy the agents follow: `~/code/hemut3/CLAUDE.md`, copied into `plugin/skills/implement-hemut/SKILL.md`.

## The daily loop

1. **Write a plan.**
   Use any plan file that has three H2 sections in this order: `TLDR`, `Plan`, `Verification`.
   If the plan touches more than one repo, add a `## Repos touched` section.
   Each repo is one bullet, in merge order, with its role:

   ```markdown
   ## Repos touched

   - DB-Migrations: sibling
   - Command: primary
   ```

   Exactly one repo is `primary`.
   The primary repo is where the agent starts, where the plan file is committed, and where `MARSHALL_BASE_BRANCH` points.
   The repo slugs must match the `repos` list in `marshall.hemut.config.json`.
   A plan with no `## Repos touched` section works in the first repo of that list (`Command`).
2. **Check it.**
   `marshall enqueue docs/my_plan.md --dry-run` checks the plan and writes nothing.
3. **Queue it.**
   `marshall enqueue docs/my_plan.md` files one Linear issue in Team Andrew1.
   The issue is in Todo, assigned to you, with the plan as its body.
   It carries the labels `marshall:queued` and `marshall:has-plan`.
   The command prints the issue URL and the branch name (Linear's `gitBranchName`).
4. **Go to sleep.**
   Marshall picks up queued issues, oldest and highest priority first, up to the caps in the config.
5. **Read the dashboard in the morning.**
   "Needs you" lists one card per issue.
   A multi-repo card shows one link per PR, primary first.
   Each card has a hand-off: what changed, how to test it, and the order to merge in.
6. **Review and merge by hand.**
   Merge in the order the hand-off gives (usually `DB-Migrations` first).
   When every PR of an issue has merged, Marshall moves the issue to Done.
   If you close a PR without merging, Marshall releases the issue and does not mark it Done.

## What Marshall does with one queued plan

1. The scheduler sees `marshall:queued`, claims the issue, and opens one worktree per repo on the issue's branch.
2. Because the issue has `marshall:has-plan`, it skips the planner.
   It checks the plan, writes `docs/<title>_plan.md` in the primary worktree, and commits it as the first commit.
   A plan that fails the check blocks the issue with the reason in a Linear comment.
3. It runs `/marshall:implement-hemut`: code, the local gate in every repo, push, one PR per repo, CI, then the review pass, then fixes.
   The agent may start sub-agents, as in any Claude Code session.
4. It writes the hand-off and moves the issue to Needs Verification.

## Never merge: the three locks

1. **GitHub.**
   The `staging` ruleset in each listed repo needs one approving review and passing checks.
   Your GitHub permission is push only, so you cannot bypass it.
   Check this before you add a repo to the config:
   `gh api repos/Hemut2025/<repo>/rules/branches/staging`.
   Do not add a repo where that call shows no `pull_request` rule.
2. **Deny rules.**
   `agent-settings.json` denies `gh pr merge` for every agent.
3. **Guard hook.**
   `scripts/merge-guard.ts` runs before every Bash call an agent makes.
   It denies `gh pr merge`, `gh pr review --approve`, `gh api` calls that merge or enable auto-merge, and `git push` to `staging`, `main`, `master`, or any base branch of the run.
   Each denial is written to the run's events file.
   A live agent run was blocked by this hook on 2026-10-18.

## Opt-in pick-up

`pickup: "labeled"` means Marshall only starts an issue that carries `marshall:queued`.
Your other Todo issues in the Hemut workspace are never touched.
Other projects keep `pickup: "assigned"`, the default, and still take every Todo issue assigned to you.
To stop one issue, remove the label.
Marshall re-checks the label right before a start, so a removal wins even if the list was read a moment earlier.
To stop everything, run `marshall pause`.
Agents that already run keep running; `marshall kill <ID>` stops one.

## One-time VM setup

1. Install the toolchain and Docker, and clone every repo in the config under `~/code/hemut3/`.
2. Write one `.env` per repo with local and dev values only.
   No AWS credentials, no production keys, no real third-party keys.
   The agents read these files, and they read text that other people write (issues and PR comments).
3. Put the Hemut Linear API key in the project's secrets, not in the repo.
   `marshall linear setup` refuses a key from another workspace.
4. Fill in `teamId` in `marshall.hemut.config.json` (Team Andrew1).
5. `marshall project import --name hemut marshall.hemut.config.json`, then `marshall linear setup`.
   Setup creates the states and the labels `marshall:queued` and `marshall:has-plan`.
6. Fill in each repo's Compose host ports in `services`, then restart the services.
7. Clone `hemut-ai-harness` next to the repos, or set `HEMUT_ATLAS_DIR`, so agents can read the Architecture Atlas.
   If the atlas is missing, the agent says so in the follow-ups.

## Rollout

1. Start with one repo and one tiny plan, with `dailyStartCap` at 1.
   Read the PR, the hand-off, and the Linear comment line by line against the policy list.
2. Add repos one at a time.
3. Run one cross-repo plan (a `DB-Migrations` change plus an app change) after the single-repo run is clean.
4. Raise the caps only after a week of clean nights.

## Things to know

- **Sibling PRs are not auto-rebased.**
  Marshall rebases the primary repo's PR when another Marshall PR merges.
  It does not rebase the sibling repos' PRs.
  If `staging` moves and GitHub asks for an update, press "Update branch" on the sibling PR.
- **A sibling PR can show red CI** until the migration it needs has merged.
  The agent notes this in the review notes.
- **The plan is committed only in the primary repo's PR.**
  The sibling PRs do not carry the plan file.
- **Plans must fit in a Linear issue body.**
  `marshall enqueue` refuses a plan over 60,000 characters.
- **Hemut policy for people still applies to you.**
  Resolve every review comment with a reply (`Fixed`, `Deliberately not changed`, or `Stale`) before you merge.
  The agents do this only when you bounce an issue back.
- **Bounce an issue** the usual way: comment, then move it back to Todo.
  A bounce on an issue with a plan skips no step: the planner revises the plan, then the agent implements again.

## Recovery

| Problem | Do this |
|---|---|
| An issue is Blocked | Read the Linear comment. Fix the cause (a plan section, a repo slug, a red gate). Move it back to Todo. |
| "repo X is not in the config" | The plan names a repo the config lacks. Fix the plan's slug or add the repo (after the ruleset check). |
| Marshall picked up nothing | `marshall queue` shows why each issue waits. Check the label, the assignee, and the caps. |
| An agent tried to merge | Look for a `PreToolUse` line with `"blocked": true` in `~/.marshall/events/<runId>.jsonl`. Find the instruction that asked for it. |
| Stop everything now | `marshall pause`, then `marshall kill <ID>` for each live agent. |
