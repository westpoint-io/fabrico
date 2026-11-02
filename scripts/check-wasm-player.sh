#!/usr/bin/env bash
#
# Runs the built WebAssembly player under Node: each board from its data file, through the app's
# own packet decoder, to the end hash in examples/boards/hashes.manifest. It also compares the
# packets, effects and hash at each tick with a native run at this same revision. Build first with
# scripts/build-wasm.sh.
#
# This regenerates the native dump on each run, so a byte changed in a dump can't reach the spec
# through this script. To watch the comparison fail, run vitest directly on a tampered copy, with
# FABRICO_PLAYER_WASM and FABRICO_PLAYER_NATIVE_DUMP set.
#
# ENVIRONMENT
#   FABRICO_WASM_OUT  where the module and the dump tool are. Defaults to target/wasm-out under the repo root.
#
# EXIT CODES
#   0  every spec passed.
#   2  no check: the module is missing or empty, the dump tool is missing, or it couldn't write.
#   1  a board wouldn't run natively, or a spec failed.
#   Any other non-zero code is vitest's own.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
OUT="${FABRICO_WASM_OUT:-$ROOT/target/wasm-out}"
WASM="$(cd "$OUT" 2>/dev/null && pwd -P)/fabrico_player.wasm" || WASM="$OUT/fabrico_player.wasm"

if [ ! -s "$WASM" ]; then
  echo "check-wasm-player: $WASM is missing or empty. Run scripts/build-wasm.sh first." >&2
  exit 2
fi

DUMP_TOOL="$(dirname "$WASM")/dump_packets"
if [ ! -x "$DUMP_TOOL" ]; then
  echo "check-wasm-player: $DUMP_TOOL is missing. Run scripts/build-wasm.sh first." >&2
  exit 2
fi

NATIVE_DUMP="$(dirname "$WASM")/native-packets"
rm -rf "$NATIVE_DUMP"
cd "$ROOT"
"$DUMP_TOOL" "$NATIVE_DUMP"

cd "$ROOT/frontend"
FABRICO_PLAYER_WASM="$WASM" FABRICO_PLAYER_NATIVE_DUMP="$NATIVE_DUMP" \
  exec npx vitest run --config vitest.player.config.ts
