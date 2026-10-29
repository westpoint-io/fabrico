#!/usr/bin/env bash
# Fires webhooks at the running Fabrico app so the belts light up during a demo.
# usage: ./scripts/demo-fire-webhooks.sh [count] [delay-seconds]
#   ENDPOINT=<path> overrides the Route path (default `hello`, the demo Route's configured
#   path, so it no longer changes per launch).
set -euo pipefail

# `|| true` is load-bearing: under `pipefail` a grep that matches nothing makes the
# whole pipeline non-zero, `set -e` aborts on the assignment, and the friendly
# message below can never print. That was the defect (70-REVIEW WR-10).
port="$(ss -ltnpH 2>/dev/null | grep fabrico-app | grep -oP '127\.0\.0\.1:\K[0-9]+' | head -1 || true)"
[ -n "$port" ] || { echo "fabrico-app is not listening - is it running?" >&2; exit 1; }

endpoint="${ENDPOINT:-hello}"
count=${1:-20}
delay=${2:-0.4}
echo "firing $count events at 127.0.0.1:$port/endpoint/$endpoint"
for i in $(seq 1 "$count"); do
  curl -s -X POST "http://127.0.0.1:$port/endpoint/$endpoint" \
    -H 'content-type: application/json' \
    -d "{\"order\":$i,\"customer\":\"demo\"}" -o /dev/null -w "$i -> %{http_code}\n"
  sleep "$delay"
done
