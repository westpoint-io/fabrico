#!/usr/bin/env bash
#
# The WebAssembly player's size gate. It compares the gzipped size of the built module with the
# budget in crates/fabrico-player/size-budget.txt. Build first with scripts/build-wasm.sh.
#
# The size is `gzip -9 -n`, because -n leaves the file name and timestamp out, so the same module
# measures the same on every run. A size exactly at the budget passes, and one byte over fails.
#
# scripts/prove-player-size-bites.sh watches this gate fail on each CI run.
#
# OUTPUT, exactly one line on stdout, when a size was measured:
#   PLAYER_SIZE raw=<bytes> gzip=<bytes> budget=<bytes>
#
# ENVIRONMENT
#   FABRICO_WASM_OUT  where the module is. Defaults to target/wasm-out under the repo root.
#
# EXIT CODES
#   0  the gzipped size is at or under the budget.
#   1  the gzipped size is over the budget. Stderr names both numbers.
#   2  no measurement: the module is missing, empty or not a WebAssembly file, gzip failed, or the
#      budget file is missing or doesn't hold exactly one positive integer. A size of zero never
#      passes.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
OUT="${FABRICO_WASM_OUT:-$ROOT/target/wasm-out}"
WASM="$OUT/fabrico_player.wasm"
BUDGET_FILE="$ROOT/crates/fabrico-player/size-budget.txt"

refuse() {
  echo "check-player-size: $1. No size was measured." >&2
  exit 2
}

if [ ! -f "$WASM" ] || [ ! -r "$WASM" ]; then
  refuse "$WASM is missing or can't be read. Run scripts/build-wasm.sh first"
fi

# Arithmetic strips the padding some wc builds print.
RAW_BYTES=$(($(wc -c <"$WASM")))
if [ "$RAW_BYTES" -le 0 ]; then
  refuse "$WASM is empty"
fi

# A truncated or wrong file would measure small and pass, so the module has to start with the
# WebAssembly magic number.
MAGIC="$(head -c 4 "$WASM" | od -An -tx1 | tr -d ' \n')"
if [ "$MAGIC" != "0061736d" ]; then
  refuse "$WASM doesn't start with the WebAssembly magic number"
fi

# pipefail makes a gzip failure fail this assignment, rather than count an empty stream.
if ! GZIP_OUTPUT="$(gzip -9 -n -c "$WASM" | wc -c)"; then
  refuse "gzip failed on $WASM"
fi
GZIP_BYTES=$((GZIP_OUTPUT))
if [ "$GZIP_BYTES" -le 0 ]; then
  refuse "gzip measured $WASM at zero bytes"
fi

if [ ! -f "$BUDGET_FILE" ] || [ ! -r "$BUDGET_FILE" ]; then
  refuse "$BUDGET_FILE is missing or can't be read"
fi
# grep exits 1 when every line is a comment, and the pattern check below refuses that empty result.
BUDGET_LINES="$(grep -v -E '^[[:space:]]*(#|$)' "$BUDGET_FILE" || true)"
# The cap on digits keeps the number inside bash's 64-bit arithmetic. A second number line, or a
# carriage return, fails the match because the whole text has to be one integer.
if ! [[ "$BUDGET_LINES" =~ ^[1-9][0-9]{0,17}$ ]]; then
  refuse "$BUDGET_FILE has to hold exactly one positive integer outside its comments"
fi
BUDGET_BYTES="$BUDGET_LINES"

echo "PLAYER_SIZE raw=$RAW_BYTES gzip=$GZIP_BYTES budget=$BUDGET_BYTES"

if [ "$GZIP_BYTES" -gt "$BUDGET_BYTES" ]; then
  echo "check-player-size: the player is $GZIP_BYTES bytes gzipped, over its budget of $BUDGET_BYTES bytes by $((GZIP_BYTES - BUDGET_BYTES))." >&2
  exit 1
fi
exit 0
