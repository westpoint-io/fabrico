#!/usr/bin/env bash
#
# Opens the offline examples file, frontend/dist-examples/fabrico-examples.html, from disk in three
# browsers and checks every board in it. Build the file first with scripts/build-embed.sh.
#
#   1. Playwright (frontend/playwright.offline.config.ts): Chromium, and Firefox with its stock
#      file:// policy. The Firefox offline tests depend on a canary that must see a sibling module
#      script and a sibling fetch both refused, so they can't pass under Playwright's relaxed
#      profile. Playwright's exit code alone can't tell a skipped or focused test from a passing
#      one, so this script also lists the tests, reads the run's JSON stats, and fails unless every
#      listed test ran and passed.
#   2. WebKitGTK (scripts/wasm/webkit-offline.py) under xvfb-run, on the system Python, which has
#      the GObject bindings.
#
# Both legs run even when the first fails, so one run reports both.
#
# OUTPUT, on stdout after each tool's own output:
#   OFFLINE_TESTS listed=<n> passed=<n>
#   WEBKIT_OFFLINE boards=<n> drawn=<n> matched=<n>     (printed by the WebKitGTK harness)
#   OFFLINE playwright=<ok|fail> webkitgtk=<ok|fail>
#
# NEEDS: Playwright's Chromium and Firefox (`npx playwright install chromium firefox`), xvfb-run,
# /usr/bin/python3 with gi, cairo and WebKit2 4.1.
#
# EXIT CODES
#   0  every listed Playwright test passed and the WebKitGTK harness passed.
#   1  either leg failed.
#   2  no check: the offline file is missing.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
FILE="$ROOT/frontend/dist-examples/fabrico-examples.html"

if [ ! -s "$FILE" ]; then
  echo "check-offline-browsers: $FILE is missing. Run scripts/build-embed.sh first." >&2
  exit 2
fi

LIST_OUT="$(mktemp)"
JSON_OUT="$(mktemp)"
cleanup() { rm -f "$LIST_OUT" "$JSON_OUT"; }
trap cleanup EXIT

# --- Leg 1: Playwright, Chromium and strict Firefox ---

PLAYWRIGHT=fail
cd "$ROOT/frontend"
LISTED=""
if npx playwright test --config=playwright.offline.config.ts --list >"$LIST_OUT"; then
  # The list reporter ends with "Total: <n> tests in <m> files".
  LISTED="$(sed -n 's/^Total: \([0-9][0-9]*\) tests\{0,1\} in .*/\1/p' "$LIST_OUT")"
fi
if [ -z "$LISTED" ]; then
  echo "check-offline-browsers: couldn't read the listed test count. The list output:" >&2
  cat "$LIST_OUT" >&2
  LISTED=0
fi

STATUS=0
PLAYWRIGHT_JSON_OUTPUT_FILE="$JSON_OUT" npx playwright test --config=playwright.offline.config.ts \
  --reporter=list,json || STATUS=$?

EXPECTED=0
if read -r EXPECTED UNEXPECTED FLAKY SKIPPED < <(node -e '
  const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).stats;
  console.log(s.expected, s.unexpected, s.flaky, s.skipped);
' "$JSON_OUT"); then
  echo "OFFLINE_TESTS listed=$LISTED passed=$EXPECTED"
  if [ "$STATUS" -eq 0 ] && [ "$LISTED" -gt 0 ] && [ "$EXPECTED" -eq "$LISTED" ] && [ "$UNEXPECTED" -eq 0 ] &&
    [ "$FLAKY" -eq 0 ] && [ "$SKIPPED" -eq 0 ]; then
    PLAYWRIGHT=ok
  else
    echo "check-offline-browsers: Playwright exited $STATUS; $LISTED tests listed, $EXPECTED passed," \
      "$UNEXPECTED failed, $FLAKY flaky, $SKIPPED skipped" >&2
  fi
else
  echo "OFFLINE_TESTS listed=$LISTED passed=0"
  echo "check-offline-browsers: the Playwright run wrote no readable JSON report (exit $STATUS)" >&2
fi

# --- Leg 2: WebKitGTK through python gi under Xvfb ---

WEBKITGTK=fail
cd "$ROOT"
WK_STATUS=0
xvfb-run -a -s "-screen 0 1280x1024x24" /usr/bin/python3 -I scripts/wasm/webkit-offline.py "$FILE" || WK_STATUS=$?
if [ "$WK_STATUS" -eq 0 ]; then
  WEBKITGTK=ok
else
  echo "check-offline-browsers: the WebKitGTK harness exited $WK_STATUS" >&2
fi

echo "OFFLINE playwright=$PLAYWRIGHT webkitgtk=$WEBKITGTK"
if [ "$PLAYWRIGHT" != ok ] || [ "$WEBKITGTK" != ok ]; then
  exit 1
fi
