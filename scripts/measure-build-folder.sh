#!/usr/bin/env bash
#
# Build-folder measurement (GATE-02, milestone v11.0 phase 84, plan 84-03).
#
# ---------------------------------------------------------------------------------
# WHY THIS EXISTS. `target/` only ever grew: cargo never deletes an old artifact, so
# every new fingerprint generation (a compiler update, a Cargo.lock change, a profile
# change, a different package or feature selection) adds a full copy beside the old
# one. GATE-02 asks that growth be BOUNDED, and a bound is only shown by numbers taken
# the same way every time. This script is that one way.
#
# WHAT EACH NUMBER IS, AND IS NOT. This disk is btrfs with `compress=zstd:3`, so the
# usual "how big is it" answers disagree, and each one below answers a different
# question:
#
#   apparent_mib   `du -s --apparent-size`: the sum of file lengths. What cargo wrote,
#                  uncompressed. Over-reports the disk cost by about 2.5x here.
#   allocated_mib  `du -s` (blocks): on btrfs this is STILL the uncompressed extent
#                  size, not what zstd left on disk. It differs from apparent mostly
#                  by sparse files and block rounding. It is NOT the real disk cost.
#   df_used_mib    `df --output=used` on the filesystem holding `target/`: the real
#                  disk in use, after compression. The only number in which a deletion
#                  shows its true reclaim (as a delta between two lines). It includes
#                  every other writer on the same filesystem, including another
#                  checkout's builds, so a delta is only clean when nothing else was writing.
#   written_since_mib  the summed lengths of files under `target/` modified after the
#                  `--since` stamp, or `-` when no stamp is given. The only number another
#                  writer cannot inflate unless it built in the same window, and
#                  the one that says what a run itself wrote.
#   deps_mib, incremental_mib, examples_mib, release_mib  apparent size of
#                  `target/debug/deps`, `target/debug/incremental`,
#                  `target/debug/examples` and `target/release`; 0 when absent.
#
# All sizes are MiB (1,048,576 bytes), rounded up as `du --block-size=1M` rounds.
#
# USAGE
#   measure-build-folder.sh [--label <l>] [--since <stamp>]
#   measure-build-folder.sh --stamp <file>
#
#   --stamp <file>   touch <file> (the reference for a later `--since`) and exit 0.
#
# OUTPUT, exactly one line on stdout:
#   BUILD_FOLDER label=<l> apparent_mib=<n> allocated_mib=<n> df_used_mib=<n>
#     written_since_mib=<n|-> deps_mib=<n> incremental_mib=<n> examples_mib=<n> release_mib=<n>
#   (one line; wrapped here for reading)
#
# EXIT CODES
#   0  the line was printed.
#   2  no measurement: an unknown option, a missing `--since` stamp, `target/` absent,
#      or a `du`, `df` or `find` that failed (for example a file deleted under the walk
#      by a running build). A size that could not be taken is never printed as a size.
# ---------------------------------------------------------------------------------

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="$ROOT/target"

usage() {
  echo "usage: measure-build-folder.sh [--label <l>] [--since <stamp>] | --stamp <file>" >&2
}

fail() {
  echo "measure-build-folder: $*" >&2
  exit 2
}

LABEL="unlabeled"
SINCE=""
STAMP=""
while [ $# -gt 0 ]; do
  case "$1" in
    --label) [ $# -ge 2 ] || { usage; fail "--label needs a value"; }; LABEL="$2"; shift 2 ;;
    --since) [ $# -ge 2 ] || { usage; fail "--since needs a stamp file"; }; SINCE="$2"; shift 2 ;;
    --stamp) [ $# -ge 2 ] || { usage; fail "--stamp needs a file"; }; STAMP="$2"; shift 2 ;;
    *) usage; fail "unknown option: $1" ;;
  esac
done

case "$LABEL" in
  *[[:space:]]*|'') fail "a label must be one word: '$LABEL'" ;;
esac

if [ -n "$STAMP" ]; then
  [ -z "$SINCE" ] || fail "--stamp and --since do not go together"
  touch "$STAMP" || fail "could not touch the stamp $STAMP"
  exit 0
fi

[ -d "$TARGET" ] || fail "no target/ folder at $TARGET, nothing to measure"
if [ -n "$SINCE" ] && [ ! -f "$SINCE" ]; then
  fail "the --since stamp does not exist: $SINCE"
fi

# One size in MiB from du, or exit 2. Takes extra du flags first, then the path.
du_mib() {
  local out rc
  out=$(du -s --block-size=1M "$@" 2>&1); rc=$?
  [ "$rc" -eq 0 ] || fail "du $* failed (exit $rc): $out"
  out=${out%%[[:space:]]*}
  case "$out" in ''|*[!0-9]*) fail "du $* printed no size" ;; esac
  printf '%s' "$out"
}

sub_mib() {
  if [ -d "$TARGET/$1" ]; then du_mib --apparent-size "$TARGET/$1"; else printf '0'; fi
}

apparent=$(du_mib --apparent-size "$TARGET") || exit 2
allocated=$(du_mib "$TARGET") || exit 2

df_out=$(df -B1M --output=used "$TARGET" 2>&1); rc=$?
[ "$rc" -eq 0 ] || fail "df on $TARGET failed (exit $rc): $df_out"
df_used=$(printf '%s\n' "$df_out" | sed -n '2p' | tr -d '[:space:]')
case "$df_used" in ''|*[!0-9]*) fail "df printed no used figure: $df_out" ;; esac

written="-"
if [ -n "$SINCE" ]; then
  sizes=$(find "$TARGET" -newer "$SINCE" -type f -printf '%s\n' 2>&1); rc=$?
  [ "$rc" -eq 0 ] || fail "find -newer $SINCE failed (exit $rc)"
  written=$(printf '%s\n' "$sizes" | awk '{ s += $1 } END { printf "%d", int((s + 1048575) / 1048576) }')
fi

deps=$(sub_mib debug/deps) || exit 2
incremental=$(sub_mib debug/incremental) || exit 2
examples=$(sub_mib debug/examples) || exit 2
release=$(sub_mib release) || exit 2

printf 'BUILD_FOLDER label=%s apparent_mib=%s allocated_mib=%s df_used_mib=%s written_since_mib=%s deps_mib=%s incremental_mib=%s examples_mib=%s release_mib=%s\n' \
  "$LABEL" "$apparent" "$allocated" "$df_used" "$written" "$deps" "$incremental" "$examples" "$release"
