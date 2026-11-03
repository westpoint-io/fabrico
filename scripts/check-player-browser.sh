#!/usr/bin/env bash
#
# Runs the built WebAssembly player in headless Chromium: the demo board from its data file, through
# the same loader Node uses, to the end hash in examples/boards/hashes.manifest. It also runs the
# stack fence spec on the corpus harness, which checks that a runaway recursion faults cleanly in
# Node, on Chromium's main thread and in a Chromium Worker. Build both modules first with
# scripts/build-wasm.sh.
#
# This script starts and stops Vite itself, as a child it kills by PID, because Playwright's own
# server management dies at signal 16 in some restricted shells. CI runs the same script.
#
# Playwright's exit code alone can't tell a skipped or focused test from a passing one, so this
# script also lists the tests, reads the run's JSON stats, and fails unless every listed test ran
# and passed. Under CI the config also refuses a committed test.only outright.
#
# OUTPUT, one line on stdout after Playwright's own output:
#   PLAYER_TESTS listed=<n> passed=<n>
#
# ENVIRONMENT
#   FABRICO_WASM_OUT  where the module is. Defaults to target/wasm-out under the repo root.
#
# EXIT CODES
#   0  every listed test passed.
#   1  Playwright passed but fewer tests passed than it listed (one was skipped, focused out, or
#      flaky), the listed count was 0, or the list or the JSON report couldn't be read.
#   2  no check: either module is missing or empty, port 5181 is already answering, or Vite didn't
#      come up within 60 seconds.
#   Any other non-zero code is Playwright's own.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
OUT="${FABRICO_WASM_OUT:-$ROOT/target/wasm-out}"
WASM="$(cd "$OUT" 2>/dev/null && pwd -P)/fabrico_player.wasm" || WASM="$OUT/fabrico_player.wasm"
CORPUS_WASM="$(dirname "$WASM")/fabrico_wasm_corpus.wasm"
PORT=5181
URL="http://127.0.0.1:$PORT/"

if [ ! -s "$WASM" ]; then
  echo "check-player-browser: $WASM is missing or empty. Run scripts/build-wasm.sh first." >&2
  exit 2
fi
if [ ! -s "$CORPUS_WASM" ]; then
  echo "check-player-browser: $CORPUS_WASM is missing or empty. Run scripts/build-wasm.sh first." >&2
  exit 2
fi

# Another server on this port would answer the poll below and get tested in place of this tree.
if curl -s -o /dev/null --max-time 2 "$URL"; then
  echo "check-player-browser: something is already answering on $URL" >&2
  exit 2
fi

VITE_LOG="$(mktemp)"
LIST_OUT="$(mktemp)"
JSON_OUT="$(mktemp)"
VITE_PID=""
stop_vite() {
  if [ -n "$VITE_PID" ]; then
    kill "$VITE_PID" 2>/dev/null || true
    wait "$VITE_PID" 2>/dev/null || true
    VITE_PID=""
  fi
  rm -f "$VITE_LOG" "$LIST_OUT" "$JSON_OUT"
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

export FABRICO_PLAYER_WASM="$WASM" FABRICO_CORPUS_WASM="$CORPUS_WASM"

LIST_STATUS=0
npx playwright test --config=playwright.player.config.ts --list >"$LIST_OUT" 2>&1 || LIST_STATUS=$?
# The list reporter ends with "Total: <n> tests in <m> files".
LISTED="$(sed -n 's/^Total: \([0-9][0-9]*\) tests\{0,1\} in .*/\1/p' "$LIST_OUT")"
if [ "$LIST_STATUS" -ne 0 ] || [ -z "$LISTED" ]; then
  echo "check-player-browser: couldn't list the tests (exit $LIST_STATUS). The list output:" >&2
  cat "$LIST_OUT" >&2
  if [ "$LIST_STATUS" -ne 0 ]; then exit "$LIST_STATUS"; fi
  exit 1
fi

STATUS=0
PLAYWRIGHT_JSON_OUTPUT_FILE="$JSON_OUT" npx playwright test --config=playwright.player.config.ts \
  --reporter=list,json || STATUS=$?

if ! STATS="$(node -e '
  const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).stats;
  console.log(s.expected, s.unexpected, s.flaky, s.skipped);
' "$JSON_OUT")"; then
  echo "check-player-browser: the run wrote no readable JSON report" >&2
  if [ "$STATUS" -ne 0 ]; then exit "$STATUS"; fi
  exit 1
fi
read -r EXPECTED UNEXPECTED FLAKY SKIPPED <<<"$STATS"

echo "PLAYER_TESTS listed=$LISTED passed=$EXPECTED"

if [ "$STATUS" -ne 0 ]; then
  exit "$STATUS"
fi
if [ "$LISTED" -eq 0 ] || [ "$EXPECTED" -ne "$LISTED" ] || [ "$UNEXPECTED" -ne 0 ] || [ "$FLAKY" -ne 0 ] ||
  [ "$SKIPPED" -ne 0 ]; then
  echo "check-player-browser: $LISTED tests listed, $EXPECTED passed, $UNEXPECTED failed, $FLAKY flaky, $SKIPPED skipped" >&2
  exit 1
fi
