#!/usr/bin/env bash
#
# Runs the docs suite: the Playwright specs in frontend/e2e-docs/, in Chromium, over the built docs
# site in site/dist/. Build the site first with scripts/build-site.sh.
#
# The site is served by site/scripts/serve-dist.ts, which this script starts on 127.0.0.1, mounts
# at /fabrico/ the way GitHub Pages will, and stops by its process id when the run ends. Playwright's
# own webServer option isn't used.
#
# Playwright's exit code alone can't tell a skipped or focused test from a passing one, so this
# script also lists the tests, reads the run's JSON stats, and fails unless every listed test ran
# and passed.
#
# OUTPUT, one line on stdout after Playwright's own output:
#   DOCS_TESTS listed=<n> passed=<n>
#
# ENVIRONMENT
#   FABRICO_DOCS_PORT  the port the site is served on. Defaults to 4329.
#
# EXIT CODES
#   0  every listed test passed.
#   1  Playwright passed but fewer tests passed than it listed (one was skipped, focused out, or
#      flaky), or the listed count was 0, or the server never answered.
#   2  no check: site/dist/index.html is missing, or something already answers on the port.
#   Any other non-zero code is Playwright's own.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
DIST="$ROOT/site/dist"
PORT="${FABRICO_DOCS_PORT:-4329}"

if [ ! -f "$DIST/index.html" ]; then
  echo "check-docs: $DIST/index.html is missing. Run scripts/build-site.sh first." >&2
  exit 2
fi
if curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/"; then
  echo "check-docs: something already answers on http://127.0.0.1:$PORT/. Stop it or set FABRICO_DOCS_PORT." >&2
  exit 2
fi

LIST_OUT="$(mktemp)"
JSON_OUT="$(mktemp)"
SERVER_LOG="$(mktemp)"
SERVER_PID=""
cleanup() {
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -f "$LIST_OUT" "$JSON_OUT" "$SERVER_LOG"
}
trap cleanup EXIT

node "$ROOT/site/scripts/serve-dist.ts" --dist "$DIST" --port "$PORT" >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!

if ! curl --retry 60 --retry-connrefused --retry-delay 1 -fsS -o /dev/null "http://127.0.0.1:$PORT/fabrico/"; then
  echo "check-docs: the site server never answered on port $PORT. Its log:" >&2
  cat "$SERVER_LOG" >&2
  exit 1
fi

export FABRICO_DOCS_URL="http://127.0.0.1:$PORT/fabrico/"

cd "$ROOT/frontend"

npx playwright test --config=playwright.docs.config.ts --list >"$LIST_OUT"
# The list reporter ends with "Total: <n> tests in <m> files".
LISTED="$(sed -n 's/^Total: \([0-9][0-9]*\) tests\{0,1\} in .*/\1/p' "$LIST_OUT")"
if [ -z "$LISTED" ]; then
  echo "check-docs: couldn't read the listed test count. The list output:" >&2
  cat "$LIST_OUT" >&2
  exit 1
fi

STATUS=0
PLAYWRIGHT_JSON_OUTPUT_FILE="$JSON_OUT" npx playwright test --config=playwright.docs.config.ts \
  --reporter=list,json || STATUS=$?

read -r EXPECTED UNEXPECTED FLAKY SKIPPED < <(node -e '
  const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).stats;
  console.log(s.expected, s.unexpected, s.flaky, s.skipped);
' "$JSON_OUT") || {
  echo "check-docs: the run wrote no readable JSON report" >&2
  if [ "$STATUS" -ne 0 ]; then exit "$STATUS"; fi
  exit 1
}

echo "DOCS_TESTS listed=$LISTED passed=$EXPECTED"

if [ "$STATUS" -ne 0 ]; then
  exit "$STATUS"
fi
if [ "$LISTED" -eq 0 ] || [ "$EXPECTED" -ne "$LISTED" ] || [ "$UNEXPECTED" -ne 0 ] || [ "$FLAKY" -ne 0 ] ||
  [ "$SKIPPED" -ne 0 ]; then
  echo "check-docs: $LISTED tests listed, $EXPECTED passed, $UNEXPECTED failed, $FLAKY flaky, $SKIPPED skipped" >&2
  exit 1
fi
