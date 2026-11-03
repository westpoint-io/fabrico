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
# BUILD PATHS. The module must not carry the paths of the machine that built it: they leak the
# builder's user name, and they make the bytes depend on where the repo and the cargo folders sit.
# rustc and clang both write source paths into panic messages, assertion text and debug sections,
# so the script maps three folders to fixed names before the build: the cargo registry sources to
# /cargo-registry, the repo root to /fabrico and the cargo target folder to /target. rustc gets
# --remap-path-prefix through CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS, and the C compiler for
# QuickJS gets -ffile-prefix-map through CFLAGS_wasm32_unknown_unknown. Both variables apply to the
# wasm32 target only, so the native dump_packets and corpus_native builds keep their flags and don't
# rebuild. After wasm-opt, the script searches the player module's bytes for the home folder, the
# cargo home, the repo root, the target folder and /tmp/, and fails when any of them is there.
#
# OUTPUT, exactly one line on stdout after cargo's own output:
#   WASM_BUILD player_raw=<bytes> player_opt=<bytes> corpus_opt=<bytes>
#
# ENVIRONMENT
#   WASM_OPT          the wasm-opt binary, from scripts/install-wasm-opt.sh. Required.
#   FABRICO_WASM_OUT  where the modules and the tools go. Defaults to target/wasm-out under the repo root.
#   CARGO_TARGET_DIR  cargo's build folder. Defaults to target under the repo root.
#   CARGO_HOME        cargo's home, whose registry/src is mapped. Defaults to ~/.cargo.
#
# EXIT CODES
#   0  the module was built and the line was printed.
#   1  the player module holds a build path. Stderr names each one, and the module is deleted.
#   2  no build: clang has no wasm32 backend, llvm-ar isn't on PATH, the compiler has no wasm
#      standard library, WASM_OPT isn't executable, RUSTFLAGS or CARGO_ENCODED_RUSTFLAGS is set
#      (cargo would then drop the target's flags and with them the path mapping), or a folder to
#      map has a space in its path.
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

# The folders to map, as absolute paths spelled the way cargo hands them to the compilers. Cargo
# reads a relative CARGO_TARGET_DIR from its working folder, which is the repo root here.
case "$TARGET_DIR" in
  /*) TARGET_ABS="$TARGET_DIR" ;;
  *) TARGET_ABS="$ROOT/$TARGET_DIR" ;;
esac
CARGO_HOME_DIR="${CARGO_HOME:-$HOME/.cargo}"
if [ -n "${RUSTFLAGS:-}" ] || [ -n "${CARGO_ENCODED_RUSTFLAGS:-}" ]; then
  echo "build-wasm: RUSTFLAGS or CARGO_ENCODED_RUSTFLAGS is set, and cargo would use it in place of" >&2
  echo "build-wasm: the wasm32 flags that keep build paths out of the module. Unset it and run again." >&2
  exit 2
fi
for dir in "$CARGO_HOME_DIR" "$ROOT" "$TARGET_ABS"; do
  if [[ "$dir" =~ [[:space:]] ]]; then
    echo "build-wasm: '$dir' has a space in it, and the compiler flag variables split on spaces" >&2
    exit 2
  fi
done
# rustc applies the last mapping that matches, so the target folder, which can sit inside the repo,
# comes after the repo root. clang does the same with its prefix maps.
export CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS="${CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS:+$CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS }\
--remap-path-prefix=$CARGO_HOME_DIR/registry/src=/cargo-registry \
--remap-path-prefix=$ROOT=/fabrico \
--remap-path-prefix=$TARGET_ABS=/target"
export CFLAGS_wasm32_unknown_unknown="${CFLAGS_wasm32_unknown_unknown:+$CFLAGS_wasm32_unknown_unknown }\
-ffile-prefix-map=$CARGO_HOME_DIR/registry/src=/cargo-registry \
-ffile-prefix-map=$ROOT=/fabrico \
-ffile-prefix-map=$TARGET_ABS=/target"

cargo build --locked -p fabrico-player -p fabrico-wasm-corpus --lib --target wasm32-unknown-unknown --profile wasm-player

optimise() {
  "$WASM_OPT" -Oz --enable-bulk-memory --enable-nontrapping-float-to-int --enable-sign-ext \
    --enable-mutable-globals "$1" -o "$2"
}

RAW="$TARGET_DIR/wasm32-unknown-unknown/wasm-player/fabrico_player.wasm"
optimise "$RAW" "$MODULE"

# The module ships, so it is searched as bytes. A path the mapping missed fails the build here,
# and the module goes first so no later check reads it.
LEAKS=()
for needle in "$HOME" "$CARGO_HOME_DIR" "$ROOT" "$TARGET_ABS" "/tmp/"; do
  if [ -n "$needle" ] && [ "$needle" != "/" ] && grep -a -q -F -- "$needle" "$MODULE"; then
    LEAKS+=("$needle")
  fi
done
if [ "${#LEAKS[@]}" -gt 0 ]; then
  rm -f "$MODULE"
  for leak in "${LEAKS[@]}"; do
    echo "build-wasm: the module holds a build path: $leak" >&2
  done
  exit 1
fi

optimise "$TARGET_DIR/wasm32-unknown-unknown/wasm-player/fabrico_wasm_corpus.wasm" "$CORPUS_MODULE"

cargo build --locked -p fabrico-player --example dump_packets
cp "$TARGET_DIR/debug/examples/dump_packets" "$DUMP_TOOL"

cargo build --locked -p fabrico-wasm-corpus --bin corpus_native
cp "$TARGET_DIR/debug/corpus_native" "$CORPUS_TOOL"

echo "WASM_BUILD player_raw=$(wc -c <"$RAW") player_opt=$(wc -c <"$MODULE") corpus_opt=$(wc -c <"$CORPUS_MODULE")"
