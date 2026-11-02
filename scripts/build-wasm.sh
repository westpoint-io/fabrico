#!/usr/bin/env bash
#
# The one command that builds the WebAssembly player, for CI and for local runs.
#
# OUTPUT, exactly one line on stdout after cargo's own output:
#   WASM_BUILD player_raw=<bytes>
#
# ENVIRONMENT
#   FABRICO_WASM_OUT  where the module goes. Defaults to target/wasm-out under the repo root.
#   CARGO_TARGET_DIR  cargo's build folder. Defaults to target under the repo root.
#
# EXIT CODES
#   0  the module was built and the line was printed.
#   2  no build: clang has no wasm32 backend, llvm-ar isn't on PATH, or the compiler has no wasm
#      standard library.
#   Any other non-zero code is cargo's own.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$ROOT"

if ! command -v clang >/dev/null 2>&1; then
  echo "build-wasm: clang isn't on PATH, and QuickJS's C code needs it for wasm32" >&2
  exit 2
fi
# Captured first: a grep that stops reading early can kill clang with SIGPIPE, which pipefail
# would then report as a missing backend.
CLANG_TARGETS="$(clang --print-targets)"
if ! grep -q wasm32 <<<"$CLANG_TARGETS"; then
  echo "build-wasm: this clang lists no wasm32 target" >&2
  exit 2
fi
if ! command -v llvm-ar >/dev/null 2>&1; then
  echo "build-wasm: llvm-ar isn't on PATH" >&2
  exit 2
fi
WASM_STD="$(rustc --print sysroot)/lib/rustlib/wasm32-unknown-unknown/lib"
if [ ! -d "$WASM_STD" ]; then
  echo "build-wasm: this compiler has no wasm standard library at $WASM_STD." >&2
  echo "build-wasm: run: rustup target add wasm32-unknown-unknown" >&2
  exit 2
fi

export CC_wasm32_unknown_unknown=clang
export AR_wasm32_unknown_unknown=llvm-ar

TARGET_DIR="${CARGO_TARGET_DIR:-target}"
OUT="${FABRICO_WASM_OUT:-$ROOT/target/wasm-out}"

cargo build --locked -p fabrico-player --lib --target wasm32-unknown-unknown --profile wasm-player

RAW="$TARGET_DIR/wasm32-unknown-unknown/wasm-player/fabrico_player.wasm"
mkdir -p "$OUT"
cp "$RAW" "$OUT/fabrico_player.wasm"

echo "WASM_BUILD player_raw=$(wc -c <"$RAW")"
