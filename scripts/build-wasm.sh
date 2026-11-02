#!/usr/bin/env bash
#
# The one command that builds the WebAssembly player, for CI and for local runs.
#
# The module it writes is the wasm-opt -Oz output, because that's what ships. Limit numbers for
# wasm belong to this exact build, so don't measure them on anything else.
#
# It also builds the native dump_packets tool with the same compiler and copies it beside the
# module, because scripts/check-wasm-player.sh compares the two builds byte for byte.
#
# The corpus harness is built and optimised the same way, so the corpus runs on what wasm-opt emits,
# as the player does, and its native report tool is copied beside it for
# scripts/check-wasm-corpus.sh. The harness doesn't ship, and the player's dependency check refuses
# it by name.
#
# OUTPUT, exactly one line on stdout after cargo's own output:
#   WASM_BUILD player_raw=<bytes> player_opt=<bytes> corpus_opt=<bytes>
#
# ENVIRONMENT
#   WASM_OPT          the wasm-opt binary, from scripts/install-wasm-opt.sh. Required.
#   FABRICO_WASM_OUT  where the modules and the tools go. Defaults to target/wasm-out under the repo root.
#   CARGO_TARGET_DIR  cargo's build folder. Defaults to target under the repo root.
#
# EXIT CODES
#   0  the module was built and the line was printed.
#   2  no build: clang has no wasm32 backend, llvm-ar isn't on PATH, the compiler has no wasm
#      standard library, or WASM_OPT isn't executable.
#   Any other non-zero code is cargo's or wasm-opt's own. Either way the old module and the old
#   tool are gone, so a later check can't read a stale one.

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
if [ ! -x "${WASM_OPT:-}" ]; then
  echo "build-wasm: WASM_OPT is '${WASM_OPT:-}', which isn't an executable." >&2
  echo "build-wasm: run: export WASM_OPT=\"\$(bash scripts/install-wasm-opt.sh <dir>)\"" >&2
  exit 2
fi

export CC_wasm32_unknown_unknown=clang
export AR_wasm32_unknown_unknown=llvm-ar

TARGET_DIR="${CARGO_TARGET_DIR:-target}"
OUT="${FABRICO_WASM_OUT:-$ROOT/target/wasm-out}"
MODULE="$OUT/fabrico_player.wasm"
DUMP_TOOL="$OUT/dump_packets"
CORPUS_MODULE="$OUT/fabrico_wasm_corpus.wasm"
CORPUS_TOOL="$OUT/corpus_native"
mkdir -p "$OUT"
rm -f "$MODULE" "$DUMP_TOOL" "$CORPUS_MODULE" "$CORPUS_TOOL"

cargo build --locked -p fabrico-player -p fabrico-wasm-corpus --lib --target wasm32-unknown-unknown --profile wasm-player

optimise() {
  "$WASM_OPT" -Oz --enable-bulk-memory --enable-nontrapping-float-to-int --enable-sign-ext \
    --enable-mutable-globals "$1" -o "$2"
}

RAW="$TARGET_DIR/wasm32-unknown-unknown/wasm-player/fabrico_player.wasm"
optimise "$RAW" "$MODULE"
optimise "$TARGET_DIR/wasm32-unknown-unknown/wasm-player/fabrico_wasm_corpus.wasm" "$CORPUS_MODULE"

cargo build --locked -p fabrico-player --example dump_packets
cp "$TARGET_DIR/debug/examples/dump_packets" "$DUMP_TOOL"

cargo build --locked -p fabrico-wasm-corpus --bin corpus_native
cp "$TARGET_DIR/debug/corpus_native" "$CORPUS_TOOL"

echo "WASM_BUILD player_raw=$(wc -c <"$RAW") player_opt=$(wc -c <"$MODULE") corpus_opt=$(wc -c <"$CORPUS_MODULE")"
