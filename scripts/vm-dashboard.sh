#!/bin/bash
# Open the VM's dashboard on this Mac: forward local port 7474 to the VM's dashboard, until Ctrl-C.
# Then open http://127.0.0.1:7474. Override VM_HOST, VM_KEY, or PORT in the environment if needed.
# Last edited: 2026-10-11 17:40 PDT
set -euo pipefail
VM_HOST="${VM_HOST:-ubuntu@152.70.16.155}"
VM_KEY="${VM_KEY:-$HOME/.ssh/marshall_oracle}"
PORT="${PORT:-7474}"
echo "Dashboard on http://127.0.0.1:$PORT (Ctrl-C to close)"
exec ssh -i "$VM_KEY" -N -L "$PORT:127.0.0.1:7474" -o ExitOnForwardFailure=yes "$VM_HOST"
