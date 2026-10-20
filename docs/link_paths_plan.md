<!-- Last edited: 2026-10-19 23:05 PDT -->

# Plan: Link installed packages into agent worktrees

## TLDR

Each Marshall agent works in a fresh copy of the repo, called a worktree.
A fresh worktree has no installed packages (`node_modules`), so the agent cannot run the frontend checks.
This change lets a repo list folders to link from the main checkout into each new worktree.
For Hemut, `Command` links `node_modules`, so agents can run Jest, ESLint and the type check without a 1.4 GB install.

## Context

`src/worktree.ts` copies only the ignored `.env*` files into a new worktree (`copyEnvFiles`).
On the VM, `npm ci` in `Command` takes about 43 s and fills 1.4 GB.
Three agents at once would need three copies.

## Plan

1. `src/config.ts`: add `linkPaths` (optional list of repo-relative paths) to `RepoSchema`. Refuse absolute paths and `..`.
2. `src/scheduler/types.ts` and `src/scheduler/worktrees.ts`: carry `linkPaths` in `WorktreeSpec`.
3. `src/worktree.ts`: `linkSharedPaths` symlinks each path that the main checkout has and the worktree lacks. `createWorktree` and `reuseWorktree` call it after `copyEnvFiles`.
4. If git would not ignore the link (a `.gitignore` line `node_modules/` matches only a directory), add `/<path>` to the repo's shared `info/exclude`, so `git add -A` cannot commit the link.
5. `marshall.hemut.config.json`: `Command` sets `linkPaths: ["node_modules"]`.
6. Docs: README and `docs/hemut_runbook.md`.

## Verification

1. `bun test`, `bun run typecheck`, `bun run lint`, `bun run check:size` pass.
2. On the VM, a `Command` worktree made by this code has `node_modules` as a symlink and a clean `git status`.
3. In that worktree, Jest, ESLint and the type check run.

## Caveats

- The linked folder is as new as the main checkout's last `npm ci`. Marshall does not refresh it.
- All worktrees share the folder. An agent that runs `npm install` changes it for all of them.
- `git worktree remove --force` deletes the link, not the folder it points to (tested).
