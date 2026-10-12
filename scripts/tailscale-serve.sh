#!/bin/bash
# Publish the dashboard to your tailnet over HTTPS: `tailscale serve --bg <port>`, then print the
# URL. Only devices logged in to your Tailscale account can open it. `--bg` keeps it after a
# reboot. Needs Tailscale installed and logged in (`sudo tailscale up`), with MagicDNS and HTTPS
# certificates on in the admin console. Never uses `tailscale funnel` (that is public internet).
#
# Usage: [PORT=7474] scripts/tailscale-serve.sh [--reset]
#        --reset runs `tailscale serve reset`: it stops sharing and removes EVERY serve setting
#        on this machine.
# Last edited: 2026-10-11 19:10 PDT
set -euo pipefail

PORT="${PORT:-7474}"
case "${1:-}" in
  "" | --reset) ;;
  *)
    echo "usage: tailscale-serve.sh [--reset]" >&2
    exit 2
    ;;
esac

if ! command -v tailscale >/dev/null 2>&1; then
  echo "tailscale-serve.sh: tailscale is not installed (run scripts/install-tailscale.sh)" >&2
  exit 1
fi

# `serve` changes the node's config, so it needs root unless `sudo tailscale set --operator=$USER`
# was run once. sudo works in both cases.
ts() {
  if [ "$(id -u)" -eq 0 ]; then tailscale "$@"; else sudo tailscale "$@"; fi
}

if [ "${1:-}" = "--reset" ]; then
  ts serve reset
  echo "Stopped sharing."
  exit 0
fi

ts serve --bg "$PORT"
echo
tailscale serve status
echo
echo "Open the https:// address above on the phone (the dashboard listens on 127.0.0.1:$PORT)."
