#!/bin/bash
# Install Tailscale on Ubuntu from Tailscale's official apt repository (pkgs.tailscale.com), so the
# dashboard can be reached from a phone over a private tailnet. Linux/Ubuntu only. Safe to rerun:
# a step that is already done is skipped. It does NOT log in: that step is interactive (see the
# notes it prints at the end).
#
# Usage: scripts/install-tailscale.sh [--dry-run]
#        --dry-run prints what it would do and changes nothing.
# Last edited: 2026-10-11 19:10 PDT
set -euo pipefail

DRY_RUN=0
case "${1:-}" in
  "") ;;
  --dry-run) DRY_RUN=1 ;;
  *)
    echo "usage: install-tailscale.sh [--dry-run]" >&2
    exit 2
    ;;
esac

if [ "$(uname -s)" != "Linux" ] || [ ! -r /etc/os-release ]; then
  echo "install-tailscale.sh: Linux (Ubuntu) only. On macOS, install the Tailscale app." >&2
  exit 1
fi
# shellcheck disable=SC1091
. /etc/os-release
if [ "${ID:-}" != "ubuntu" ] || [ -z "${VERSION_CODENAME:-}" ]; then
  echo "install-tailscale.sh: Ubuntu only (found ID=${ID:-unknown})." >&2
  exit 1
fi

BASE="https://pkgs.tailscale.com/stable/ubuntu/$VERSION_CODENAME"
KEYRING="/usr/share/keyrings/tailscale-archive-keyring.gpg"
LIST="/etc/apt/sources.list.d/tailscale.list"

# Print the step; run it unless this is a dry run.
step() {
  echo "+ $*"
  if [ "$DRY_RUN" -eq 0 ]; then bash -c "$*"; fi
}

if [ "$DRY_RUN" -eq 1 ]; then echo "(dry run: nothing is changed)"; fi

if [ -s "$KEYRING" ]; then
  echo "skip: $KEYRING exists"
else
  step "sudo mkdir -p --mode=0755 /usr/share/keyrings"
  step "curl -fsSL '$BASE.noarmor.gpg' | sudo tee '$KEYRING' >/dev/null"
fi

if [ -s "$LIST" ]; then
  echo "skip: $LIST exists"
else
  step "curl -fsSL '$BASE.tailscale-keyring.list' | sudo tee '$LIST' >/dev/null"
fi

if command -v tailscale >/dev/null 2>&1; then
  echo "skip: tailscale is installed ($(tailscale version 2>/dev/null | head -1))"
else
  step "sudo apt-get update && sudo apt-get install -y tailscale"
fi

cat <<'NOTES'

Next, by hand (these steps are interactive; this script cannot do them):
  1. On this machine: sudo tailscale up
     It prints a login URL. Open it in a browser and approve this machine.
  2. In the Tailscale admin console (https://login.tailscale.com/admin/dns):
     turn on MagicDNS, then turn on HTTPS Certificates.
  3. Install the Tailscale app on the phone and log in to the same account.
  4. On this machine: scripts/tailscale-serve.sh
     It prints the https URL to open on the phone.
  See docs/dashboard.md.
NOTES
