#!/usr/bin/env bash
#
# Runs the built WebAssembly player in headless Chromium: the demo board from its data file, through
# the same loader Node uses, to the end hash in examples/boards/hashes.manifest. Build the module
# first with scripts/build-wasm.sh.
#
# This script starts and stops Vite itself, as a child it kills by PID, because Playwright's own
# server management dies at signal 16 in some restricted shells. CI runs the same script.
#
# ENVIRONMENT
#   FABRICO_WASM_OUT  where the module is. Defaults to target/wasm-out under the repo root.
#
# EXIT CODES
#   0  the spec passed.
#   2  no check: the module is missing or empty, port 5181 is already answering, or Vite didn't
#      come up within 60 seconds.
#   Any other non-zero code is Playwright's own.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
OUT="${FABRICO_WASM_OUT:-$ROOT/target/wasm-out}"
WASM="$(cd "$OUT" 2>/dev/null && pwd -P)/fabrico_player.wasm" || WASM="$OUT/fabrico_player.wasm"
PORT=5181
URL="http://127.0.0.1:$PORT/"

if [ ! -s "$WASM" ]; then
  echo "check-player-browser: $WASM is missing or empty. Run scripts/build-wasm.sh first." >&2
  exit 2
fi

# Another server on this port would answer the poll below and get tested in place of this tree.
if curl -s -o /dev/null --max-time 2 "$URL"; then
  echo "check-player-browser: something is already answering on $URL" >&2
  exit 2
fi

VITE_LOG="$(mktemp)"
VITE_PID=""
stop_vite() {
  if [ -n "$VITE_PID" ]; then
    kill "$VITE_PID" 2>/dev/null || true
    wait "$VITE_PID" 2>/dev/null || true
    VITE_PID=""
  fi
  rm -f "$VITE_LOG"
}
trap stop_vite EXIT

cd "$ROOT/frontend"
node node_modules/vite/bin/vite.js --port "$PORT" --strictPort --host 127.0.0.1 >"$VITE_LOG" 2>&1 &
VITE_PID=$!

for _ in $(seq 1 120); do
  if curl -s -o /dev/null --max-time 2 "$URL"; then
    break
  fi
  if ! kill -0 "$VITE_PID" 2>/dev/null; then
    echo "check-player-browser: Vite exited before it answered. Its output:" >&2
    cat "$VITE_LOG" >&2
    exit 2
  fi
  sleep 0.5
done
if ! curl -s -o /dev/null --max-time 2 "$URL"; then
  echo "check-player-browser: Vite didn't answer on $URL within 60 seconds. Its output:" >&2
  cat "$VITE_LOG" >&2
  exit 2
fi

STATUS=0
FABRICO_PLAYER_WASM="$WASM" npx playwright test --config=playwright.player.config.ts || STATUS=$?
stop_vite
trap - EXIT
exit "$STATUS"
