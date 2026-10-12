#!/bin/bash
# Install (or refresh) the auto-update timer on Linux: render the service template with this
# machine's repo and bun paths, write the service and timer to ~/.config/systemd/user, and start
# the timer. Safe to rerun. Run it from the main checkout, like install-systemd.sh.
#
# Usage: scripts/install-auto-update.sh [--dry-run]
#        --dry-run prints the rendered service and changes nothing.
# Turn it off: systemctl --user disable --now marshall-update.timer
# Last edited: 2026-10-12 16:50 PDT
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
DRY_RUN=0
case "${1:-}" in
  "") ;;
  --dry-run) DRY_RUN=1 ;;
  *)
    echo "usage: install-auto-update.sh [--dry-run]" >&2
    exit 2
    ;;
esac

case "$REPO" in
  */.worktrees/*)
    echo "install-auto-update.sh: $REPO is a worktree; run this from the main checkout" >&2
    exit 1
    ;;
esac

if [ "$(uname -s)" != "Linux" ]; then
  echo "install-auto-update.sh: systemd is Linux-only" >&2
  exit 1
fi

BUN="$(command -v bun || true)"
if [ -z "$BUN" ]; then
  echo "install-auto-update.sh: bun not found on PATH" >&2
  exit 1
fi
UPDATE_PATH="$(dirname "$BUN"):/usr/local/bin:/usr/bin:/bin"

render() {
  sed -e "s|{{REPO}}|$REPO|g" -e "s|{{PATH}}|$UPDATE_PATH|g" \
    "$REPO/scripts/systemd/marshall-update.service.template"
}

if [ "$DRY_RUN" = 1 ]; then
  render
  exit 0
fi

UNIT_DIR="$HOME/.config/systemd/user"
mkdir -p "$UNIT_DIR"
render > "$UNIT_DIR/marshall-update.service"
cp "$REPO/scripts/systemd/marshall-update.timer" "$UNIT_DIR/marshall-update.timer"
systemctl --user daemon-reload
systemctl --user enable --now marshall-update.timer
echo "installed $UNIT_DIR/marshall-update.{service,timer}"
echo "logs: journalctl --user -u marshall-update    next run: systemctl --user list-timers marshall-update"
