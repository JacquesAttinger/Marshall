#!/bin/bash
# Keep a deployed checkout on the latest `main`: fetch, fast-forward, check the new code, restart
# the services. The Oracle VM runs this from a systemd timer (scripts/install-auto-update.sh).
# Last edited: 2026-10-12 16:50 PDT
#
# Order: fetch -> (nothing new? stop) -> fast-forward -> `bun install` if the lockfile changed ->
# gate (typecheck + tests) -> restart `marshall` and `marshall-dashboard`. A change that touches
# only docs or tests is pulled but restarts nothing. Live agents survive a restart (KillMode=process).
#
# Safe by default: it never touches a checkout that is off `main`, has edits to tracked files, or
# has diverged from origin. When the gate fails it resets to the commit it started from, remembers
# the bad commit (so the next tick does not retry it), and leaves the running services alone.
# A newer commit on `main` is tried again.
#
# Env: MARSHALL_UPDATE_GATE   command that must pass before a restart (default: typecheck + tests)
#      MARSHALL_UPDATE_STATE  file that remembers the last bad commit (default: ~/.marshall-update-failed)
# systemd never runs two copies of the oneshot service at once, so there is no lock here.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
GATE="${MARSHALL_UPDATE_GATE:-bun run typecheck && bun test}"
FAILED_FILE="${MARSHALL_UPDATE_STATE:-$HOME/.marshall-update-failed}"
# Paths whose change means the running code changed.
RESTART_PATHS='^(src/|bin/|package\.json$|bun\.lock$)'
DEPS_PATHS='^(package\.json$|bun\.lock$)'

log() { echo "auto-update: $*"; }

install_deps() { bun install --frozen-lockfile; }

# Undo a fast-forward that failed the gate and remember the commit so we do not retry it.
roll_back() {
  local old="$1" new="$2" changed="$3"
  git reset --hard --quiet "$old"
  echo "$new" > "$FAILED_FILE"
  if echo "$changed" | grep -Eq "$DEPS_PATHS"; then install_deps || log "could not restore dependencies"; fi
  log "rolled back to ${old:0:7}; ${new:0:7} will not be retried"
}

# Install dependencies when the lockfile changed, then run the gate.
check_new_code() {
  if echo "$1" | grep -Eq "$DEPS_PATHS"; then install_deps || return 1; fi
  bash -c "$GATE"
}

restart_services() {
  local unit
  for unit in marshall marshall-dashboard; do
    if systemctl --user cat "$unit" > /dev/null 2>&1; then
      systemctl --user restart "$unit" || { log "restart of $unit failed"; return 1; }
      log "restarted $unit"
    fi
  done
}

main() {
  cd "$REPO"
  [ "$(git rev-parse --abbrev-ref HEAD)" = "main" ] || { log "not on main; leaving it alone"; return 1; }
  [ -z "$(git status --porcelain --untracked-files=no)" ] || { log "tracked files have local edits; leaving it alone"; return 1; }

  git fetch --quiet origin main
  local old new
  old="$(git rev-parse HEAD)"
  new="$(git rev-parse origin/main)"
  [ "$old" != "$new" ] || return 0
  if [ -f "$FAILED_FILE" ] && [ "$(cat "$FAILED_FILE")" = "$new" ]; then return 0; fi
  git merge-base --is-ancestor "$old" "$new" || { log "local main has diverged from origin; leaving it alone"; return 1; }

  git merge --ff-only --quiet origin/main
  local changed
  changed="$(git diff --name-only "$old" "$new")"
  log "updated ${old:0:7} -> ${new:0:7}"

  if ! check_new_code "$changed"; then
    roll_back "$old" "$new" "$changed"
    return 1
  fi
  rm -f "$FAILED_FILE"

  if echo "$changed" | grep -Eq "$RESTART_PATHS"; then
    restart_services
  else
    log "only docs, tests, or scripts changed; no restart"
  fi
}

# `main` runs to the end before bash reads on: the fast-forward may rewrite this very file.
main "$@"
exit $?
