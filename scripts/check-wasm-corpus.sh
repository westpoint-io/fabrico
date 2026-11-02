#!/usr/bin/env bash
#
# The wasm corpus gate. It replays the repo's fixtures in the wasm build under Node and compares
# each tick with a native report from this same revision. Build first with scripts/build-wasm.sh.
#
# It regenerates the native report on each run, so a stale report can't agree with a stale module.
# Pass --native-report to compare against a report you name instead. That flag exists so
# scripts/prove-wasm-corpus-bites.sh can compare against a tampered one.
#
# Usage: bash scripts/check-wasm-corpus.sh [--native-report <existing file>]
#
# ENVIRONMENT
#   FABRICO_WASM_OUT  where the module and the native tool are. Defaults to target/wasm-out under the repo root.
#
# EXIT CODES
#   0  every fixture matched, and the counts agree.
#   1  a difference, or a fixture the native tool couldn't decode. Stderr names each one.
#   2  no comparison: a bad argument, the module, the native tool or a named report is missing, or a
#      walk found nothing.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
OUT="${FABRICO_WASM_OUT:-$ROOT/target/wasm-out}"

NATIVE_REPORT=""
case "$#" in
  0) ;;
  2)
    if [ "$1" != "--native-report" ]; then
      echo "check-wasm-corpus: unknown argument $1" >&2
      exit 2
    fi
    if [ ! -f "$2" ]; then
      echo "check-wasm-corpus: the native report $2 is missing. No comparison was made." >&2
      exit 2
    fi
    NATIVE_REPORT="$(cd "$(dirname "$2")" && pwd -P)/$(basename "$2")"
    ;;
  *)
    echo "check-wasm-corpus: usage: check-wasm-corpus.sh [--native-report <existing file>]" >&2
    exit 2
    ;;
esac

if [ ! -d "$OUT" ]; then
  echo "check-wasm-corpus: $OUT is missing. Run scripts/build-wasm.sh first." >&2
  exit 2
fi
OUT="$(cd "$OUT" && pwd -P)"
WASM="$OUT/fabrico_wasm_corpus.wasm"
NATIVE_TOOL="$OUT/corpus_native"

if [ ! -s "$WASM" ]; then
  echo "check-wasm-corpus: $WASM is missing or empty. Run scripts/build-wasm.sh first." >&2
  exit 2
fi
if [ ! -x "$NATIVE_TOOL" ]; then
  echo "check-wasm-corpus: $NATIVE_TOOL is missing. Run scripts/build-wasm.sh first." >&2
  exit 2
fi

cd "$ROOT"

if [ -z "$NATIVE_REPORT" ]; then
  NATIVE_REPORT="$OUT/corpus-native.txt"
  rm -f "$NATIVE_REPORT"
  NATIVE_RC=0
  "$NATIVE_TOOL" >"$NATIVE_REPORT" || NATIVE_RC=$?
  if [ "$NATIVE_RC" -ne 0 ]; then
    rm -f "$NATIVE_REPORT"
    exit "$NATIVE_RC"
  fi
fi

exec node scripts/wasm/run-corpus.mjs --wasm "$WASM" --native-report "$NATIVE_REPORT"
