#!/usr/bin/env bash
#
# Runs the docs suite: the Playwright specs in frontend/e2e-docs/, in Chromium, over the built docs
# site in site/dist/ and its fixture build in site/dist-fixtures/ (the same site plus the test pages
# whose file name starts with _). Build both first with scripts/build-site.sh.
#
# Each folder is served by its own site/scripts/serve-dist.ts, which this script starts on
# 127.0.0.1, mounts at /fabrico/ the way GitHub Pages will, and stops by its process id when the run
# ends. Playwright's own webServer option isn't used.
#
# Playwright's exit code alone can't tell a skipped or focused test from a passing one, so this
# script also lists the tests, reads the run's JSON stats, and fails unless every listed test ran
# and passed.
#
# OUTPUT, one line on stdout after Playwright's own output:
#   DOCS_TESTS listed=<n> passed=<n>
#
# ENVIRONMENT
#   FABRICO_DOCS_PORT           the port site/dist/ is served on. Defaults to 4329.
#   FABRICO_DOCS_FIXTURES_PORT  the port site/dist-fixtures/ is served on. Defaults to 4330.
# It exports FABRICO_DOCS_URL and FABRICO_DOCS_FIXTURES_URL to the suite.
#
# EXIT CODES
#   0  every listed test passed.
#   1  Playwright passed but fewer tests passed than it listed (one was skipped, focused out, or
#      flaky), or the listed count was 0, or the server never answered.
#   2  no check: site/dist/index.html or site/dist-fixtures/index.html is missing, or something
#      already answers on either port.
#   Any other non-zero code is Playwright's own.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
DIST="$ROOT/site/dist"
FIXTURE_DIST="$ROOT/site/dist-fixtures"
PORT="${FABRICO_DOCS_PORT:-4329}"
FIXTURE_PORT="${FABRICO_DOCS_FIXTURES_PORT:-4330}"

for folder in "$DIST" "$FIXTURE_DIST"; do
  if [ ! -f "$folder/index.html" ]; then
    echo "check-docs: $folder/index.html is missing. Run scripts/build-site.sh first." >&2
    exit 2
  fi
done
if [ "$PORT" = "$FIXTURE_PORT" ]; then
  echo "check-docs: FABRICO_DOCS_PORT and FABRICO_DOCS_FIXTURES_PORT are both $PORT. Give them different ports." >&2
  exit 2
fi
if curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/"; then
  echo "check-docs: something already answers on http://127.0.0.1:$PORT/. Stop it or set FABRICO_DOCS_PORT." >&2
  exit 2
fi
if curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$FIXTURE_PORT/"; then
  echo "check-docs: something already answers on http://127.0.0.1:$FIXTURE_PORT/. Stop it or set FABRICO_DOCS_FIXTURES_PORT." >&2
  exit 2
fi

LIST_OUT="$(mktemp)"
JSON_OUT="$(mktemp)"
SERVER_LOG="$(mktemp)"
FIXTURE_LOG="$(mktemp)"
SERVER_PID=""
FIXTURE_PID=""
cleanup() {
  for pid in "$SERVER_PID" "$FIXTURE_PID"; do
    if [ -n "$pid" ]; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  done
  rm -f "$LIST_OUT" "$JSON_OUT" "$SERVER_LOG" "$FIXTURE_LOG"
}
trap cleanup EXIT

node "$ROOT/site/scripts/serve-dist.ts" --dist "$DIST" --port "$PORT" >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!
node "$ROOT/site/scripts/serve-dist.ts" --dist "$FIXTURE_DIST" --port "$FIXTURE_PORT" >"$FIXTURE_LOG" 2>&1 &
FIXTURE_PID=$!

if ! curl --retry 60 --retry-connrefused --retry-delay 1 -fsS -o /dev/null "http://127.0.0.1:$PORT/fabrico/"; then
  echo "check-docs: the site server never answered on port $PORT. Its log:" >&2
  cat "$SERVER_LOG" >&2
  exit 1
fi
if ! curl --retry 60 --retry-connrefused --retry-delay 1 -fsS -o /dev/null "http://127.0.0.1:$FIXTURE_PORT/fabrico/"; then
  echo "check-docs: the fixture site server never answered on port $FIXTURE_PORT. Its log:" >&2
  cat "$FIXTURE_LOG" >&2
  exit 1
fi

export FABRICO_DOCS_URL="http://127.0.0.1:$PORT/fabrico/"
export FABRICO_DOCS_FIXTURES_URL="http://127.0.0.1:$FIXTURE_PORT/fabrico/"

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
