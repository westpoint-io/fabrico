#!/usr/bin/env bash
#
# Runs the read-only board's Playwright specs (frontend/e2e-embed/) over the built pages in
# frontend/dist-embed/pages/, opened by file:// URL, so no server is involved. Build the pages first
# with scripts/build-embed.sh.
#
# Playwright's exit code alone can't tell a skipped or focused test from a passing one, so this
# script also lists the tests, reads the run's JSON stats, and fails unless every listed test ran
# and passed.
#
# OUTPUT, one line on stdout after Playwright's own output:
#   EMBED_TESTS listed=<n> passed=<n>
#
# EXIT CODES
#   0  every listed test passed.
#   1  Playwright passed but fewer tests passed than it listed (one was skipped, focused out, or
#      flaky), or the listed count was 0.
#   2  no check: frontend/dist-embed/pages/ holds no page.
#   Any other non-zero code is Playwright's own.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
PAGES="$ROOT/frontend/dist-embed/pages"

if [ -z "$(find "$PAGES" -maxdepth 1 -name '*.html' -type f 2>/dev/null)" ]; then
  echo "check-embed: $PAGES holds no page. Run scripts/build-embed.sh first." >&2
  exit 2
fi

cd "$ROOT/frontend"

LIST_OUT="$(mktemp)"
JSON_OUT="$(mktemp)"
cleanup() { rm -f "$LIST_OUT" "$JSON_OUT"; }
trap cleanup EXIT

npx playwright test --config=playwright.embed.config.ts --list >"$LIST_OUT"
# The list reporter ends with "Total: <n> tests in <m> files".
LISTED="$(sed -n 's/^Total: \([0-9][0-9]*\) tests\{0,1\} in .*/\1/p' "$LIST_OUT")"
if [ -z "$LISTED" ]; then
  echo "check-embed: couldn't read the listed test count. The list output:" >&2
  cat "$LIST_OUT" >&2
  exit 1
fi

STATUS=0
PLAYWRIGHT_JSON_OUTPUT_FILE="$JSON_OUT" npx playwright test --config=playwright.embed.config.ts \
  --reporter=list,json || STATUS=$?

read -r EXPECTED UNEXPECTED FLAKY SKIPPED < <(node -e '
  const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).stats;
  console.log(s.expected, s.unexpected, s.flaky, s.skipped);
' "$JSON_OUT") || {
  echo "check-embed: the run wrote no readable JSON report" >&2
  if [ "$STATUS" -ne 0 ]; then exit "$STATUS"; fi
  exit 1
}

echo "EMBED_TESTS listed=$LISTED passed=$EXPECTED"

if [ "$STATUS" -ne 0 ]; then
  exit "$STATUS"
fi
if [ "$LISTED" -eq 0 ] || [ "$EXPECTED" -ne "$LISTED" ] || [ "$UNEXPECTED" -ne 0 ] || [ "$FLAKY" -ne 0 ] ||
  [ "$SKIPPED" -ne 0 ]; then
  echo "check-embed: $LISTED tests listed, $EXPECTED passed, $UNEXPECTED failed, $FLAKY flaky, $SKIPPED skipped" >&2
  exit 1
fi
