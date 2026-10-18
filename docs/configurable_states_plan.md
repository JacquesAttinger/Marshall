<!-- Last edited: 2026-10-18 16:01 PDT -->

# Plan: Configurable status names

## TLDR

Marshall needs two Linear statuses, "Needs Verification" and "Blocked", and it creates them itself.
In the Hemut workspace only an admin can create statuses, and no admin is available.
This plan lets a project name the statuses Marshall uses, so Hemut can point Marshall at statuses that already exist ("In Review" and "Backlog").
Nothing changes for projects that do not set the new option.

## Context

The two names are constants in `src/linear/map.ts` (`NEEDS_VERIFICATION_STATE`, `BLOCKED_STATE`).
They are used in six places:

- `src/linear/setup.ts` creates the two statuses when they are missing (`ensureWorkspaceSetup`).
- `src/linear/client.ts` refuses to start unless both exist (`requireSetup`), and lists issues that wait for a merge (`listAwaitingMerge`).
- `src/linear/queries.ts` has the `ReviewableIssues` query that filters on the two names.
- `src/phases/handoff.ts` moves a finished issue to "Needs Verification".
- `src/scheduler/tick.ts` (`blockIssue`) moves a stuck issue to "Blocked".
- `src/cli/linear.ts` and `src/project-setup/pipeline.ts` call setup.

`ensureState` already reuses a status that exists with the right name, so setup can run against existing statuses without creating anything.

Team Andrew1 has these statuses: Triage, Backlog, Todo, In Progress, In Review, Done, Canceled, Duplicate.
Checked on 2026-10-18 with the Linear API.
Jacques is not a workspace admin, and `marshall linear setup` failed with `Cannot create workflow state`.

## Decisions

1. **New config key `states`** with two optional names: `needsVerification` (default `Needs Verification`) and `blocked` (default `Blocked`).
   A project that sets nothing behaves exactly as before.
2. **Hemut maps `needsVerification` to `In Review` and `blocked` to `Backlog`.**
   "In Review" is where a finished PR waits for a human, and Hemut's GitHub link already uses it.
   "Backlog" is not picked up (the scheduler only takes Todo issues), so a stuck issue waits there until a human moves it back to Todo.
   Jacques can change either name later in the config.
3. **The merge sweep stays narrow.**
   `ReviewableIssues` lists issues in the two statuses.
   With "In Review" and "Backlog" that would include every issue Jacques has in those statuses.
   In `labeled` pick-up mode the query therefore also requires the opt-in label.
   Marshall only handles labeled issues in that mode, so nothing it handled is missed.
4. **Setup keeps its job.**
   `marshall linear setup` ensures the configured statuses exist, creating a missing one (which needs an admin).
   With statuses that already exist it creates only labels.

## Plan

1. `src/config.ts`: add `StatesSchema` and the `states` key. Export a `StateNames` type and a `stateNames(config)` helper.
2. `src/linear/queries.ts`: replace the `ReviewableIssues` constant with `reviewableIssuesOp(states, pickup)`.
   It filters on the two names, and on the label when `pickup.mode` is `labeled`.
3. `src/linear/client.ts`: add `states` to `ConnectOptions` and `Ctx`. `requireSetup` checks the configured names. `listAwaitingMerge` uses them.
4. `src/linear/setup.ts`: `ensureWorkspaceSetup` takes the names (default: the constants).
5. Callers pass the names: `src/cli/linear.ts`, `src/cli/run.ts`, `src/cli/queue.ts`, `src/cli/status.ts`, `src/cli/enqueue.ts`, `src/dashboard/context.ts`, `src/phases/handoff.ts`, `src/scheduler/tick.ts`.
   Use one helper so the call sites stay short.
6. `marshall.hemut.config.json`: set `states`. Update `docs/hemut_runbook.md`, `docs/runbook.md`, and the README.
7. Tests: config defaults and overrides, the query text for each mode, `requireSetup` with custom names, setup reusing an existing status and creating none, the hand-off and block paths using the configured names, and the Hemut config test.

## Likely touched files

- `src/config.ts`, `src/linear/{queries,client,setup,index}.ts`
- `src/phases/handoff.ts`, `src/scheduler/tick.ts`
- `src/cli/{linear,run,queue,status,enqueue}.ts`, `src/dashboard/context.ts`
- `marshall.hemut.config.json`, `docs/hemut_runbook.md`, `docs/runbook.md`, `README.md`
- tests under `tests/linear/`, `tests/scheduler/`, `tests/master/`, and `tests/hemut-config.test.ts`

## Decisions made alone

- Backlog as the "Blocked" name for Hemut. It is one config line, so changing it costs nothing.
- The label filter on the merge sweep applies only in `labeled` mode, so existing projects keep their sweep.

## Added during review

- The config refuses a status name that is `Todo`, `In Progress`, or `Done`, and refuses two equal names.
  Marshall already uses those three for other purposes, and equal names would make the two states mean one thing.
- `StatesSchema` is strict: an unknown key under `states` fails the load, like every other settings block.
- `LinearClient` has a public `states` field, so the hand-off and the block path read the names from the client they already hold.
- `src/cli/kill.ts` and `src/cli/plan.ts` pass the settings too, because both connect to Linear.
- In the default `assigned` mode, custom names such as `In Review` make the merge sweep list every issue the user has in those statuses.
  The sweep only marks an issue Done when a merged PR title carries the issue ID, so the risk is low.
  Use `pickup: "labeled"` with busy status names.

## Out of scope found

- The dashboard "Add project" flow (`src/project-setup/pipeline.ts`) writes a config with no `states` key and calls setup with the default names.
  A project made there on a team without admin rights fails at setup, and can be fixed by adding `states` to its config.
  Making that flow ask for the names is a separate change.
- The dashboard and `marshall status` still print "Needs Verification" and "Blocked" as display words.
  They describe Marshall's two claim states, not Linear names, so they stay.

## Verification

1. `bun run typecheck`, `bun run lint`, `bun run check:size`, and `bun test` pass.
2. With no `states` key, the Linear queries and `requireSetup` are the same as before (existing tests pass unchanged).
3. With `states` set to existing names, `marshall linear setup` against a fake team that has them creates no status.
4. On the VM, after the change is merged: `marshall linear setup` for the `hemut` project creates only labels, and no `Cannot create workflow state` error appears.
