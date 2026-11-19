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
# A LATER DEPLOY (review 101 WR-01). Deploys queue in ci.yml's `pages` group, but the smoke runs
# after its own deploy and outside that group, so the next push's deploy can go live while this
# smoke polls or runs. A shared group wouldn't stop it: the next deploy is already waiting and starts
# the moment this push's deploy ends, before this smoke is queued. Then the site is a later commit's
# build, and this commit's poll or its commit-bound checks (the hero's demo board) fail against it.
# So when the smoke fails, the script reads build.json once more. If it names a different commit
# that has FABRICO_SMOKE_SHA as an ancestor, the script prints a PAGES_SMOKE superseded line and a
# GitHub notice and exits 0: the later commit's own smoke checks the site that is live. A served
# commit git can't find locally is fetched from origin first. Any other failure stays a failure.
#
# OUTPUT, one line on stdout after Playwright's own output:
#   PAGES_SMOKE listed=<n> passed=<n>
# and, when a later commit's build is live after a failure, one more line:
#   PAGES_SMOKE superseded sha=<FABRICO_SMOKE_SHA> by=<the served sha>
#
# ENVIRONMENT
#   FABRICO_DOCS_URL              the site root to check, ending in /fabrico/. Required.
#   FABRICO_SMOKE_SHA             the commit the site must be built from (40 hex characters). Required.
#   FABRICO_SMOKE_POLL_CEILING_S  how long to wait for build.json to name that commit, in seconds.
#                                 Defaults to 900 (Pages serves the previous deployment for up to
#                                 600 s after a deploy).
#
# EXIT CODES
#   0  every listed test passed, or the smoke failed while the site serves a later commit on the
#      same history (the superseded line above).
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

# Prints the commit the site serves and returns 0 when it is a later commit than FABRICO_SMOKE_SHA,
# one that has it as an ancestor. Returns 1 otherwise, including when build.json can't be read.
superseded_by() {
  local root="${FABRICO_DOCS_URL%/}/" served
  # shellcheck disable=SC2016 # the ${...} below is a JavaScript template literal
  served="$(node -e '
    fetch(`${process.argv[1]}build.json?superseded=${Date.now()}`, { headers: { "cache-control": "no-cache" } })
      .then((r) => (r.status === 200 ? r.json() : {}))
      .then((b) => console.log(typeof b.sha === "string" ? b.sha : ""))
      .catch(() => console.log(""));
  ' "$root")" || return 1
  [[ "$served" =~ ^[0-9a-f]{40}$ ]] || return 1
  [ "$served" != "$FABRICO_SMOKE_SHA" ] || return 1
  if ! git -C "$ROOT" cat-file -e "$served^{commit}" 2>/dev/null; then
    git -C "$ROOT" fetch --quiet --no-tags origin "$served" || return 1
  fi
  git -C "$ROOT" merge-base --is-ancestor "$FABRICO_SMOKE_SHA" "$served" || return 1
  printf '%s\n' "$served"
}

# Exits with $1, unless a later commit's build is live, which exits 0 with the superseded line.
fail_unless_superseded() {
  local by
  if by="$(superseded_by)"; then
    echo "PAGES_SMOKE superseded sha=$FABRICO_SMOKE_SHA by=$by"
    echo "::notice title=pages-smoke superseded::The site now serves $by, a later commit than $FABRICO_SMOKE_SHA. That commit's smoke checks it."
    exit 0
  fi
  exit "$1"
}

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
  if [ "$STATUS" -ne 0 ]; then fail_unless_superseded "$STATUS"; fi
  fail_unless_superseded 1
}

echo "PAGES_SMOKE listed=$LISTED passed=$EXPECTED"

if [ "$STATUS" -ne 0 ]; then
  fail_unless_superseded "$STATUS"
fi
if [ "$LISTED" -eq 0 ] || [ "$EXPECTED" -ne "$LISTED" ] || [ "$UNEXPECTED" -ne 0 ] || [ "$FLAKY" -ne 0 ] ||
  [ "$SKIPPED" -ne 0 ]; then
  echo "check-pages-smoke: $LISTED tests listed, $EXPECTED passed, $UNEXPECTED failed, $FLAKY flaky, $SKIPPED skipped" >&2
  fail_unless_superseded 1
fi
