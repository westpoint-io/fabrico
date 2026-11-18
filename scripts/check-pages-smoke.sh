#!/usr/bin/env bash
#
# Runs the Pages smoke: the Playwright spec in frontend/e2e-smoke/, in Chromium, over a deployed
# docs site. In CI that is the live address after the pages job deploys; locally it is a copy of
# site/dist served with site/scripts/serve-dist.ts. The smoke first waits until the site's
# build.json names FABRICO_SMOKE_SHA, then checks one page per section (running its boards to their
# manifest hashes), the sitemaps, the hero and its sidecar, and every absolute link in README.md.
#
# It serves nothing: start the server yourself for a local run, for example
#   node site/scripts/serve-dist.ts --dist site/dist --port 4331 &
#   FABRICO_DOCS_URL=http://127.0.0.1:4331/fabrico/ FABRICO_SMOKE_SHA=$(git rev-parse HEAD) \
#     bash scripts/check-pages-smoke.sh
#
# Playwright's exit code alone can't tell a skipped or focused test from a passing one, so this
# script also lists the tests, reads the run's JSON stats, and fails unless every listed test ran
# and passed. The spec is serial, so a failed test leaves the ones after it skipped, and the count
# says so.
#
# OUTPUT, one line on stdout after Playwright's own output:
#   PAGES_SMOKE listed=<n> passed=<n>
#
# ENVIRONMENT
#   FABRICO_DOCS_URL              the site root to check, ending in /fabrico/. Required.
#   FABRICO_SMOKE_SHA             the commit the site must be built from (40 hex characters). Required.
#   FABRICO_SMOKE_POLL_CEILING_S  how long to wait for build.json to name that commit, in seconds.
#                                 Defaults to 900 (Pages serves the previous deployment for up to
#                                 600 s after a deploy).
#
# EXIT CODES
#   0  every listed test passed.
#   1  a test failed, or fewer tests passed than were listed (one was skipped, focused out, or
#      flaky), or the listed count was 0.
#   2  no check: FABRICO_DOCS_URL or FABRICO_SMOKE_SHA is unset or malformed.
#   Any other non-zero code is Playwright's own.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"

if [ -z "${FABRICO_DOCS_URL:-}" ]; then
  echo "check-pages-smoke: FABRICO_DOCS_URL is unset. Set it to the site root, ending in /fabrico/." >&2
  exit 2
fi
if [ -z "${FABRICO_SMOKE_SHA:-}" ]; then
  echo "check-pages-smoke: FABRICO_SMOKE_SHA is unset. Set it to the commit the site must come from." >&2
  exit 2
fi
if ! [[ "$FABRICO_SMOKE_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "check-pages-smoke: FABRICO_SMOKE_SHA is \"$FABRICO_SMOKE_SHA\", not 40 lowercase hex characters." >&2
  exit 2
fi
export FABRICO_DOCS_URL FABRICO_SMOKE_SHA

LIST_OUT="$(mktemp)"
JSON_OUT="$(mktemp)"
cleanup() {
  rm -f "$LIST_OUT" "$JSON_OUT"
}
trap cleanup EXIT

cd "$ROOT/frontend"

npx playwright test --config=playwright.smoke.config.ts --list >"$LIST_OUT"
# The list reporter ends with "Total: <n> tests in <m> files".
LISTED="$(sed -n 's/^Total: \([0-9][0-9]*\) tests\{0,1\} in .*/\1/p' "$LIST_OUT")"
if [ -z "$LISTED" ]; then
  echo "check-pages-smoke: couldn't read the listed test count. The list output:" >&2
  cat "$LIST_OUT" >&2
  exit 1
fi

STATUS=0
PLAYWRIGHT_JSON_OUTPUT_FILE="$JSON_OUT" npx playwright test --config=playwright.smoke.config.ts \
  --reporter=list,json || STATUS=$?

read -r EXPECTED UNEXPECTED FLAKY SKIPPED < <(node -e '
  const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).stats;
  console.log(s.expected, s.unexpected, s.flaky, s.skipped);
' "$JSON_OUT") || {
  echo "check-pages-smoke: the run wrote no readable JSON report" >&2
  if [ "$STATUS" -ne 0 ]; then exit "$STATUS"; fi
  exit 1
}

echo "PAGES_SMOKE listed=$LISTED passed=$EXPECTED"

if [ "$STATUS" -ne 0 ]; then
  exit "$STATUS"
fi
if [ "$LISTED" -eq 0 ] || [ "$EXPECTED" -ne "$LISTED" ] || [ "$UNEXPECTED" -ne 0 ] || [ "$FLAKY" -ne 0 ] ||
  [ "$SKIPPED" -ne 0 ]; then
  echo "check-pages-smoke: $LISTED tests listed, $EXPECTED passed, $UNEXPECTED failed, $FLAKY flaky, $SKIPPED skipped" >&2
  exit 1
fi
