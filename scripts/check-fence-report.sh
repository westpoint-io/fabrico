#!/usr/bin/env bash
#
# The fence report gate. It measures where a Factory first runs out of gas, memory or stack on the
# desktop build and in the wasm build, writes the report to $FABRICO_WASM_OUT/fence-report.txt, and
# checks it: the gas count has to be equal on both targets, each memory count has to equal its line
# in crates/fabrico-player/fence-pins.txt, the memory and gas limits have to be equal, a runaway
# recursion in wasm has to fault without trapping on both recursion shapes, and the allocator
# self-check in wasm has to pass. scripts/wasm/fence-report.mjs has the report format and the rules.
# Build the modules first with scripts/build-wasm.sh.
#
#   bash scripts/check-fence-report.sh                    measure, then check
#   bash scripts/check-fence-report.sh --report <file>    check that report only
#
# ENVIRONMENT
#   FABRICO_WASM_OUT  where the harness and corpus_native are. Defaults to target/wasm-out under the
#                     repo root.
#
# EXIT CODES
#   0  every rule held.
#   1  a rule failed, each failure named on stderr.
#   2  no check: the harness or corpus_native is missing, a file is missing or empty, or the report
#      lacks a line the rules need.
#   Any other non-zero code is corpus_native's own.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
OUT="${FABRICO_WASM_OUT:-$ROOT/target/wasm-out}"
PINS="$ROOT/crates/fabrico-player/fence-pins.txt"

REPORT=""
case "$#" in
  0) ;;
  2)
    if [ "$1" != "--report" ]; then
      echo "check-fence-report: unknown argument $1" >&2
      exit 2
    fi
    if [ ! -f "$2" ]; then
      echo "check-fence-report: the report $2 is missing. No check was made." >&2
      exit 2
    fi
    REPORT="$(cd "$(dirname "$2")" && pwd -P)/$(basename "$2")"
    ;;
  *)
    echo "check-fence-report: usage: check-fence-report.sh [--report <existing file>]" >&2
    exit 2
    ;;
esac

cd "$ROOT"

if [ -n "$REPORT" ]; then
  exec node scripts/wasm/fence-report.mjs check --report "$REPORT" --pins "$PINS"
fi

if [ ! -d "$OUT" ]; then
  echo "check-fence-report: $OUT is missing. Run scripts/build-wasm.sh first." >&2
  exit 2
fi
OUT="$(cd "$OUT" && pwd -P)"
WASM="$OUT/fabrico_wasm_corpus.wasm"
NATIVE_TOOL="$OUT/corpus_native"
if [ ! -s "$WASM" ]; then
  echo "check-fence-report: $WASM is missing or empty. Run scripts/build-wasm.sh first." >&2
  exit 2
fi
if [ ! -x "$NATIVE_TOOL" ]; then
  echo "check-fence-report: $NATIVE_TOOL is missing. Run scripts/build-wasm.sh first." >&2
  exit 2
fi

NATIVE="$OUT/fence-native.txt"
REPORT="$OUT/fence-report.txt"
rm -f "$NATIVE" "$REPORT"
NATIVE_RC=0
"$NATIVE_TOOL" --fence --pins "$PINS" >"$NATIVE" || NATIVE_RC=$?
if [ "$NATIVE_RC" -ne 0 ]; then
  rm -f "$NATIVE"
  exit "$NATIVE_RC"
fi

node scripts/wasm/fence-report.mjs measure --wasm "$WASM" --native "$NATIVE" --pins "$PINS" --out "$REPORT"
exec node scripts/wasm/fence-report.mjs check --report "$REPORT" --pins "$PINS"
