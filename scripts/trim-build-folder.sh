#!/usr/bin/env bash
#
# Build-folder trim by age (GATE-02, milestone v11.0 phase 84, plans 84-03 and 84-14).
#
# ---------------------------------------------------------------------------------
# WHY THIS EXISTS. cargo never deletes an old build output. Every new fingerprint
# generation (a compiler update, a Cargo.lock change, a profile change, a different
# package or feature selection) adds a full set of outputs beside the old ones, so
# `target/` only ever grows. The two profile lines in the root Cargo.toml make each
# generation smaller; this script removes the generations nobody has used for a while.
# It is the first step of every full gate run (84-GATES.md, "How a full gate run is
# taken").
#
# WHAT IT REMOVES, PART 1: THE AGE SWEEP. It runs cargo-sweep 0.8.0's age sweep
# (`cargo sweep --time <days>`) on this repository's `target/`. cargo-sweep finds every
# `.fingerprint` folder under `target/` (debug, release and the private targets under
# `target/isolated/`), and for each build unit reads the most recent ACCESS TIME among
# the files in its fingerprint folder. A unit whose fingerprint nobody has read for
# <days> days loses its outputs in `deps/` and `build/`, its uplifted copy, and its
# fingerprint, together, so cargo never sees a fingerprint pointing at a deleted file (a
# hand-rolled `find -delete` would leave exactly that). cargo reads a unit's fingerprint
# on every build that includes the unit, so "not read for 14 days" means "no build of
# any kind used it for 14 days". Read from cargo-sweep 0.8.0's source
# (src/fingerprint.rs, `last_used_time` uses `metadata().accessed()`), not assumed.
#
# WHAT IT REMOVES, PART 2: THE AGE TRIM (plan 84-14). cargo-sweep 0.8.0 skips the
# incremental caches and the example binaries (its source: "incremental is not tracked
# by fingerprint", "examples is just final artifacts not tracked by fingerprint"), so
# after the sweep this script trims four folders itself, by age only:
# `debug/incremental`, `debug/examples`, `release/incremental`, `release/examples`.
#   - Its units are each folder's direct entries (one crate's incremental folder, one
#     example file), dot-names included. A symlink, or an entry that is neither a
#     folder nor a regular file, is kept and never followed.
#   - A unit is IN USE when a regular file in it (or the unit itself, if it is a file)
#     was read or written less than <days> days ago, or a folder in it (itself
#     included) was written less than <days> days ago, by `find`'s day arithmetic
#     (`-atime -<days>`, `-mtime -<days>`). Every other unit is removed whole.
#   - A FOLDER'S READ TIME IS NEVER A SIGN OF USE. Listing a folder refreshes its read
#     time, and the before-measurement below runs `du` over all of `target/` before
#     anything is removed, so every folder looks read today (measured at plan 84-14 on
#     btrfs and tmpfs: one `du -s` over a 30-day-old tree made every folder's read time
#     now and left every file's alone). File read times and folder write times are not
#     touched by a walk.
#   - Why it is safe: both kinds of output lie outside cargo's fingerprints, so removing
#     one cannot leave a fingerprint pointing at a deleted file. rustc reads a crate's
#     incremental folder on every compile of that crate, and an example is read when it
#     runs and written when it links. The worst case is one slower compile of a crate
#     whose incremental folder went, or one relink of an example whose binary went,
#     which cargo performs on its own when an output it expects is missing.
#   - What stays untrimmed: `target/doc`, `target/tmp` and `target/isolated` outside its
#     fingerprinted outputs; 84-EVIDENCE.md `## GATE-02 build folder` sizes them.
#
# THE RULES, and why each one:
#   - Age only, default 14 days. Never `cargo sweep --maxsize` or any size bound: a size
#     bound deletes the OLDEST outputs until the folder fits, and in a folder another
#     build writes into, the oldest outputs can be the ones that build is
#     about to link. Never `cargo clean` or a whole-folder removal: it deletes any other
#     build in progress as well (D-07). Never a `find target -delete` over
#     fingerprinted outputs (see above).
#   - Refused while any `cargo`, `rustc`, `clippy-driver` or `cargo-clippy` process runs:
#     other builds may share the same folder, and a build in flight may be
#     about to read an output this script would remove.
#   - `target/debug/.cargo-lock` and, when `target/release` exists,
#     `target/release/.cargo-lock`, the locks cargo takes for a build in each profile
#     folder, are held for the whole run, so a build that starts mid-trim waits for it
#     instead of racing it. Both the sweep and the age trim reach `release/`. A lock
#     already held is a refusal.
#   - Refused when the age signal cannot be trusted: a `noatime` mount never updates
#     access times, so every unit would look unused and the trim would delete live
#     outputs. `relatime` (this machine) updates an access time at least once a day,
#     which is ample for a 14-day window.
#   - Refused when one of the four age-trim folders is a symlink or resolves outside
#     `target/`, so the trim never leaves the folder it was asked to trim.
#   - Refused when cargo-sweep is absent or is not 0.8.0 (the signal above was read
#     from 0.8.0's source), and when cargo would place this repository's target folder
#     anywhere but `target/` (a `CARGO_TARGET_DIR` in the environment is ignored).
#
# USAGE
#   trim-build-folder.sh [--dry-run] [--days <n>]
#
#   --dry-run   list what would go (cargo-sweep `-v` and the age trim print
#               `Would remove: <path>` per entry) and delete nothing.
#   --days <n>  the age cutoff in whole days, at least 1; default 14.
#
# OUTPUT: a `measure-build-folder.sh --label trim-before` line, cargo-sweep's own output
# (`[INFO] Cleaned <size> from "<target>"` or `Would clean: ...`), the age trim's
# `Removed: <path>` or `Would remove: <path>` lines and one line per folder,
#   AGE_TRIM dir=<folder> units=<n> unused=<n> removed=<n> failed=<n>
# (`AGE_TRIM dir=<folder> absent` for a folder that does not exist; `removed=0` in a dry
# run), and a `--label trim-after` line.
#
# EXIT CODES
#   0  the sweep and the age trim (or their dry runs) ran and reported no error.
#   1  the sweep or the age trim ran but failed or logged an error (cargo-sweep logs a
#      failed removal and still exits 0, so its output is read for `[ERROR]` and `[WARN]`
#      lines; an age-trim unit whose walk or removal errored is counted `failed`), or
#      the after-measurement failed.
#   2  refused, nothing deleted: an unknown option, a build running, a build lock held,
#      cargo-sweep absent or the wrong version, an untrustworthy age signal, an age-trim
#      folder that is a symlink or outside `target/`, a target folder elsewhere, or a
#      before-measurement that failed.
# ---------------------------------------------------------------------------------

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="$ROOT/target"
MEASURE="$ROOT/scripts/measure-build-folder.sh"
INSTALL_LINE="cargo install cargo-sweep --locked --version 0.8.0"
SWEEP_VERSION="0.8.0"
AGE_DIRS=(debug/incremental debug/examples release/incremental release/examples)

usage() {
  echo "usage: trim-build-folder.sh [--dry-run] [--days <n>]" >&2
}

refuse() {
  echo "trim-build-folder: REFUSED: $*" >&2
  exit 2
}

DRY_RUN=0
DAYS=14
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --days) [ $# -ge 2 ] || { usage; refuse "--days needs a value"; }; DAYS="$2"; shift 2 ;;
    *) usage; refuse "unknown option: $1" ;;
  esac
done
case "$DAYS" in ''|*[!0-9]*) refuse "--days must be a whole number of days: '$DAYS'" ;; esac
[ "$DAYS" -ge 1 ] || refuse "--days must be at least 1"

# Guard: no build may be running.
running=""
for name in cargo rustc clippy-driver cargo-clippy; do
  procs=$(pgrep -a -x "$name" 2>/dev/null)
  if [ -n "$procs" ]; then
    running="$running$procs"$'\n'
  fi
done
if [ -n "$running" ]; then
  printf '%s' "$running" >&2
  refuse "a build is running (process names above: cargo, rustc, clippy-driver or cargo-clippy); trim when it ends"
fi

# Guard: cargo-sweep present, and the version whose age signal was read.
if ! command -v cargo-sweep >/dev/null 2>&1; then
  refuse "cargo-sweep is not installed; install it with: $INSTALL_LINE"
fi
v=$(cargo-sweep sweep --version 2>&1); rc=$?
if [ "$rc" -ne 0 ] || ! printf '%s\n' "$v" | grep -E " ${SWEEP_VERSION//./\\.}\$" >/dev/null; then
  refuse "cargo-sweep is '$v', not $SWEEP_VERSION; install the pinned one with: $INSTALL_LINE"
fi

# Guard: the age signal (file access time) must be maintained on this mount.
[ -d "$TARGET" ] || refuse "no target/ folder at $TARGET, nothing to trim"
opts=$(findmnt -no OPTIONS -T "$TARGET" 2>&1); rc=$?
[ "$rc" -eq 0 ] && [ -n "$opts" ] || refuse "could not read the mount options for $TARGET: $opts"
case ",$opts," in
  *,noatime,*) refuse "the mount holding $TARGET is noatime ($opts): access times never change, so the age signal would call every build output unused" ;;
esac

# Guard: hold the build locks for target/debug and target/release so no build starts
# mid-trim.
if [ -d "$TARGET/debug" ]; then
  exec 9>>"$TARGET/debug/.cargo-lock" || refuse "could not open $TARGET/debug/.cargo-lock"
  flock -n 9 || refuse "a build holds $TARGET/debug/.cargo-lock"
fi
if [ -d "$TARGET/release" ]; then
  exec 8>>"$TARGET/release/.cargo-lock" || refuse "could not open $TARGET/release/.cargo-lock"
  flock -n 8 || refuse "a build holds $TARGET/release/.cargo-lock"
fi

# Guard: cargo must resolve this repository's target folder to $TARGET.
unset CARGO_TARGET_DIR CARGO_BUILD_TARGET_DIR
meta=$(cargo metadata --no-deps --format-version 1 --manifest-path "$ROOT/Cargo.toml" 2>/dev/null); rc=$?
[ "$rc" -eq 0 ] || refuse "cargo metadata failed (exit $rc)"
resolved=$(printf '%s' "$meta" | grep -o '"target_directory":"[^"]*"' | head -n 1 | sed 's/^"target_directory":"//; s/"$//')
[ "$resolved" = "$TARGET" ] || refuse "cargo resolves the target folder to '$resolved', not $TARGET"

# Guard: every age-trim folder that exists is a real folder inside target/, reached
# without a symlink, so the trim cannot leave target/.
target_real=$(realpath -e -- "$TARGET" 2>&1); rc=$?
[ "$rc" -eq 0 ] || refuse "could not resolve $TARGET: $target_real"
for rel in "${AGE_DIRS[@]}"; do
  p="$TARGET/$rel"
  [ -L "$p" ] && refuse "$p is a symlink; the age trim never follows one"
  [ -L "$(dirname -- "$p")" ] && refuse "$(dirname -- "$p") is a symlink; the age trim never follows one"
  [ -e "$p" ] || continue
  [ -d "$p" ] || refuse "$p is not a folder"
  real=$(realpath -e -- "$p" 2>&1); rc=$?
  [ "$rc" -eq 0 ] || refuse "could not resolve $p: $real"
  case "$real" in
    "$target_real"/*) ;;
    *) refuse "$p resolves to $real, outside $target_real" ;;
  esac
done

before=$(bash "$MEASURE" --label trim-before 2>&1); rc=$?
[ "$rc" -eq 0 ] || refuse "the before-measurement failed: $before"
printf '%s\n' "$before"

args=(sweep --time "$DAYS" -v)
[ "$DRY_RUN" -eq 1 ] && args+=(--dry-run)
out=$(cd "$ROOT" && cargo "${args[@]}" "$ROOT" 2>&1); sweep_rc=$?
printf '%s\n' "$out"

problems=$(printf '%s\n' "$out" | grep -E '^\[(ERROR|WARN)\]')

# The age trim of one folder: prints its Removed / Would remove lines and its AGE_TRIM
# line, adds its failures to AGE_FAILED.
AGE_FAILED=0
LIST=$(mktemp) || { echo "trim-build-folder: could not create a temporary file" >&2; exit 1; }
trap 'rm -f -- "$LIST"' EXIT

age_trim() {
  local rel=$1 dir="$TARGET/$1" unit hit rc units=0 unused=0 removed=0 failed=0
  if [ ! -e "$dir" ]; then
    echo "AGE_TRIM dir=$rel absent"
    return 0
  fi
  find "$dir" -mindepth 1 -maxdepth 1 -print0 > "$LIST" 2>/dev/null; rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "trim-build-folder: could not list $dir (find exit $rc); nothing removed from it" >&2
    echo "AGE_TRIM dir=$rel units=0 unused=0 removed=0 failed=1"
    AGE_FAILED=$((AGE_FAILED + 1))
    return 0
  fi
  while IFS= read -r -d '' unit; do
    units=$((units + 1))
    # A symlink, or anything that is neither a folder nor a regular file: kept, never
    # followed.
    if [ -L "$unit" ]; then
      continue
    elif [ -f "$unit" ]; then
      hit=$(find "$unit" -maxdepth 0 \( -atime "-$DAYS" -o -mtime "-$DAYS" \) -print 2>&1); rc=$?
    elif [ -d "$unit" ]; then
      # Files: read or written. Folders: written only (see the header).
      hit=$(find "$unit" \( \( -type f \( -atime "-$DAYS" -o -mtime "-$DAYS" \) \) -o \( -type d -mtime "-$DAYS" \) \) -print -quit 2>&1); rc=$?
    else
      continue
    fi
    if [ "$rc" -ne 0 ]; then
      echo "trim-build-folder: kept $unit, its walk failed (find exit $rc): $hit" >&2
      failed=$((failed + 1))
      continue
    fi
    [ -n "$hit" ] && continue
    unused=$((unused + 1))
    if [ "$DRY_RUN" -eq 1 ]; then
      echo "Would remove: $unit"
      continue
    fi
    if rm -rf -- "$unit" 2>/dev/null && [ ! -e "$unit" ] && [ ! -L "$unit" ]; then
      removed=$((removed + 1))
      echo "Removed: $unit"
    else
      echo "trim-build-folder: failed to remove $unit" >&2
      failed=$((failed + 1))
    fi
  done < "$LIST"
  echo "AGE_TRIM dir=$rel units=$units unused=$unused removed=$removed failed=$failed"
  AGE_FAILED=$((AGE_FAILED + failed))
}

for rel in "${AGE_DIRS[@]}"; do
  age_trim "$rel"
done

after=$(bash "$MEASURE" --label trim-after 2>&1); after_rc=$?
printf '%s\n' "$after"

if [ "$sweep_rc" -ne 0 ]; then
  echo "trim-build-folder: cargo sweep exited $sweep_rc" >&2
  exit 1
fi
if [ -n "$problems" ]; then
  echo "trim-build-folder: cargo sweep logged errors or warnings:" >&2
  printf '%s\n' "$problems" >&2
  exit 1
fi
if [ "$AGE_FAILED" -ne 0 ]; then
  echo "trim-build-folder: the age trim failed on $AGE_FAILED unit(s), each kept and named above" >&2
  exit 1
fi
if [ "$after_rc" -ne 0 ]; then
  echo "trim-build-folder: the after-measurement failed" >&2
  exit 1
fi
exit 0
