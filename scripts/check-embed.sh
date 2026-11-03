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
# THE PER-TICK ORACLE. Before Playwright runs, this script runs the native dump_packets tool that
# scripts/build-wasm.sh copies beside the player module, from the repo root, into
# $FABRICO_WASM_OUT/native-packets. Each board gets a `<path with / turned into _>.hashes` file with
# one `<tick> <hash>` line per tick, and the specs compare every tick the page ran with it. The
# folder reaches Playwright as FABRICO_PLAYER_NATIVE_DUMP. An artifact download drops file modes, so
# the script sets the tool's executable bit itself.
#
# OUTPUT, one line on stdout after Playwright's own output:
#   EMBED_TESTS listed=<n> passed=<n>
#
# ENVIRONMENT
#   FABRICO_WASM_OUT  where the player module and dump_packets are. Defaults to target/wasm-out
#                     under the repo root.
#
# EXIT CODES
#   0  every listed test passed.
#   1  Playwright passed but fewer tests passed than it listed (one was skipped, focused out, or
#      flaky), or the listed count was 0.
#   2  no check: frontend/dist-embed/pages/ holds no page, or the dump_packets tool is missing.
#   Any other non-zero code is Playwright's own.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
PAGES="$ROOT/frontend/dist-embed/pages"

if [ -z "$(find "$PAGES" -maxdepth 1 -name '*.html' -type f 2>/dev/null)" ]; then
  echo "check-embed: $PAGES holds no page. Run scripts/build-embed.sh first." >&2
  exit 2
fi

OUT="${FABRICO_WASM_OUT:-$ROOT/target/wasm-out}"
DUMP_TOOL="$OUT/dump_packets"
if [ ! -s "$DUMP_TOOL" ]; then
  echo "check-embed: $DUMP_TOOL is missing. Run scripts/build-wasm.sh first." >&2
  exit 2
fi
[ -x "$DUMP_TOOL" ] || chmod +x "$DUMP_TOOL"
NATIVE_DUMP="$(cd "$OUT" && pwd -P)/native-packets"
rm -rf "$NATIVE_DUMP"
cd "$ROOT"
"$DUMP_TOOL" "$NATIVE_DUMP"
export FABRICO_PLAYER_NATIVE_DUMP="$NATIVE_DUMP"

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
