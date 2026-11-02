#!/usr/bin/env bash
#
# Runs the built WebAssembly player under Node: a board from its data file, through the app's own
# packet decoder, to the end hash in examples/boards/hashes.manifest. Build the module first with
# scripts/build-wasm.sh.
#
# ENVIRONMENT
#   FABRICO_WASM_OUT  where the module is. Defaults to target/wasm-out under the repo root.
#
# EXIT CODES
#   0  every spec passed.
#   2  no check: the module is missing or empty.
#   Any other non-zero code is vitest's own.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
OUT="${FABRICO_WASM_OUT:-$ROOT/target/wasm-out}"
WASM="$(cd "$OUT" 2>/dev/null && pwd -P)/fabrico_player.wasm" || WASM="$OUT/fabrico_player.wasm"

if [ ! -s "$WASM" ]; then
  echo "check-wasm-player: $WASM is missing or empty. Run scripts/build-wasm.sh first." >&2
  exit 2
fi

cd "$ROOT/frontend"
FABRICO_PLAYER_WASM="$WASM" exec npx vitest run --config vitest.player.config.ts
