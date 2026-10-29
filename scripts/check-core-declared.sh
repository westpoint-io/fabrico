#!/usr/bin/env bash
#
# Declared-moves assertion for the deterministic core, its protocol and its scenario
# corpus.
#
# WHY IT EXISTS. An assertion that a covered byte never moves is the wrong shape for a
# project that moves fixtures deliberately: under it every real change is a red, and a
# regime in which every change is a red is a regime a contributor learns to route around.
# This gate asserts something stronger: a covered byte MAY move, and the move must be
# DECLARED first, in docs/DECLARED-MOVES.txt, with the digest the path is expected to
# carry afterwards. Acceptance is THIS SCRIPT'S EXIT CODE, never a human reading a diff.
#
# WHAT IT ASSERTS, against a named base ref (by default the annotated tag `public-base`,
# cut at the first commit of this repository):
#
#   1. [fixtures], in BOTH directions, over four corpora: the golden fixture directories
#      under crates/fabrico-core/tests/golden, the scenario fixtures and snapshots, and
#      the protocol fixtures.
#        - a covered path that DIFFERS from the base and is not declared is named;
#        - a declared path that did NOT differ is named (a stale entry must never become
#          a blanket permission, and the declaration is cumulative since the base);
#        - a declared path whose recomputed digest is not the declared one is named, with
#          BOTH digests printed so correcting the entry is copy-paste, not re-derivation.
#
#   2. [source], in BOTH directions, over the tracked non-fixture files under the three
#      covered crate roots. A path list with NO digests: a changed source file that is not
#      listed is named, and a listed source file that did not change is named too.
#
#   DELETION IS A MOVE. Both covered sets are built from the UNION of the working tree and
#   the base ref, classified by the same fixture/source boundary and de-duplicated. Without
#   that union every covered path set would be discovered from the working tree or the
#   index alone, and a path that existed at the base and is GONE today would be a member of
#   nothing this gate compares: `git rm crates/fabrico-core/src/lib.rs` would report OK
#   with every discovery count unchanged. A deleted path is walked like any other, differs
#   from the base like any other, and reddens by name unless it is declared. A DELETED
#   fixture path is declared with the literal digest field `DELETED` rather than a hex
#   digest, because an absent path has no bytes to digest; a DELETED source path is
#   declared the way every source path is, as a bare path under [source].
#
#   3. No UNTRACKED file under the three covered crate roots. A diff against a commit
#      cannot see a file git has never been told about, so a brand-new module would ride
#      in green without this walk.
#
#   4. Cargo.lock byte-identity against the same base. A dependency bump changes generated
#      code, and therefore potentially serialized bytes, without touching one line under
#      crates/. The lockfile is deliberately NOT declarable: a dependency change is a
#      reviewed move of the base tag (see BASE MOVES below), not a line somebody appends
#      to a data file.
#
# BASE MOVES. The base tag moves only as a reviewed change of its own: the tag is cut at
# the new commit and pushed first, and the commit that relies on it resets both sections
# of docs/DECLARED-MOVES.txt to NONE, because every move declared against the old base is
# part of the new one. Moving the tag to make a red pass is the gate-weakening move named
# at the bottom of this header.
#
# WHAT IT DOES NOT ASSERT, stated plainly so no downstream artifact overstates its
# coverage: it does not build, test, or replay anything. It is a pure git-level and
# digest-level assertion. `cargo test --workspace` in the CI determinism job is what
# proves a corpus still REPLAYS; this script only proves what moved and whether the move
# was declared.
#
# What the [source] arm does NOT catch is written out in full in the declaration file's
# own header, and is repeated here because it is a stated limit rather than an oversight:
# it does not catch a wrong edit to a file that WAS declared, when that edit moves no
# fixture. The named backstop is the corpus itself plus
# crates/fabrico-core/tests/cert_cross_platform.rs. A fold change that no board in either
# corpus exercises is out of this gate's reach.
#
# The diff is taken against the WORKING TREE, not HEAD, so uncommitted edits are caught
# too: a change must be clean on disk, not merely clean in history.
#
# ANTI-VACUOUS GUARDS. An assertion that measures nothing is worse than no assertion,
# because it reports green. This script exits 2 rather than passing if:
#   - the base ref does not resolve to a commit (a shallow or tag-less checkout);
#   - docs/DECLARED-MOVES.txt is absent, empty, or missing a section;
#   - a section holds neither the literal line NONE nor at least one entry;
#   - a declaration line cannot be parsed (it is REFUSED, never skipped);
#   - a declared path escapes the repo root or contains "..";
#   - a covered path or corpus directory is absent on disk or at the base ref;
#   - the golden discovery walk fails, or discovers fewer than MIN_GOLDEN_FIXTURES;
#   - any of the four discovery counts comes back zero.
#
# THE DIGEST RECIPE, so a declaration line is reproducible by hand:
#
#   A GOLDEN FIXTURE DIRECTORY IS ONE COVERED PATH, not five. Its digest is
#       (cd <dir> && LC_ALL=C find . -type f -print0 | LC_ALL=C sort -z \
#          | xargs -0 sha256sum | sha256sum)
#   that is, the sha256 of the `sha256sum` output lines over EVERY FILE the directory holds
#   at ANY depth, dot-files included, sorted BYTE-WISE by `./`-prefixed path. LC_ALL=C is
#   MANDATORY: locale collation orders those names differently on a different runner and
#   would produce a different digest for identical bytes.
#
#   WHY `find`, NOT `ls`. `ls` omits dot-files and does not recurse, so a tracked
#   `.smuggled` file or a nested subdirectory added inside a DECLARED fixture directory
#   would leave its digest unmoved and ride in green. `find . -type f` sees both. The `./`
#   prefix `find` emits is part of the digested text.
#
#   EVERY OTHER COVERED PATH IS A SINGLE FILE and its digest is a plain `sha256sum` of its
#   raw bytes.
#
#   A DELETED COVERED PATH HAS NO DIGEST. Its [fixtures] line carries the literal field
#   `DELETED` in place of the hex, and this gate refuses that line if the path is still
#   present - a declaration that says "gone" while the bytes are on disk is the stale
#   entry the both-directions rule exists to catch.
#
#   EQUALITY IS OVER RAW BYTES. No text mode, no line-ending translation, no Unicode
#   normalization. A CRLF a text-mode comparison would forgive changes the recorded bytes,
#   and the recorded bytes are the thing the corpora assert.
#
#   macOS note: `sha256sum` is GNU coreutils. This script SELECTS the tool once at the top -
#   `sha256sum` if present, otherwise `shasum -a 256`, otherwise exit 2 saying so - and uses
#   the selection everywhere. The digest is identical either way because both emit
#   "<hex>  <name>" in the same format. An ABSENT sha256 tool is exit 2 ("the assertion
#   could not be made"), never the silent exit 1 an unguarded pipeline would produce.
#
# THE RESPONSE TO A RED RESULT IS TO DECLARE THE MOVE OR TO REVERT IT. Never widen the
# base ref and never narrow the covered path set to make this script pass - doing either
# converts the gate back into prose, and neither is visible to any other check in this
# repository except scripts/prove-declared-gate-non-vacuous.sh, which reads the covered
# path set from outside.

set -euo pipefail

# Resolve repo root so the script works from any cwd. Every path printed below is
# repo-relative by construction (git and the fixture walk both emit relative paths).
cd "$(git rev-parse --show-toplevel)"

# The covered crate roots. Adding to this list is fine; REMOVING from it is the
# gate-weakening move the header forbids, and this gate cannot see an edit to itself.
# scripts/prove-declared-gate-non-vacuous.sh reads THIS ARRAY BY BLOCK, with comment lines
# filtered out, which is the only thing in this repository that can see the list narrowed.
# Keep it a top-level array literal opened by `COVERED_CRATES=(` and closed by a line that
# is exactly `)`. Do not inline it into a loop and do not build it from a function.
COVERED_CRATES=(
    "crates/fabrico-core"
    "crates/fabrico-protocol"
    "crates/fabrico-scenario"
)

GOLDEN_DIR="crates/fabrico-core/tests/golden"
SCENARIO_FIXTURE_DIR="crates/fabrico-scenario/fixtures"
SCENARIO_SNAPSHOT_DIR="crates/fabrico-scenario/snapshots"
PROTOCOL_FIXTURE_DIR="crates/fabrico-protocol/tests/fixtures"

# The workspace lockfile. Not a crate path, so it gets its own named check, diffed
# against the same base as everything else.
LOCKFILE="Cargo.lock"

# The golden corpus has well over 20 fixture directories at the base. The floor is
# deliberately well below that: it exists to catch a walk that discovers NOTHING (wrong
# cwd, moved directory, broken find), not to pin the exact corpus size - which
# scripts/measure-golden-corpus.sh pins as an equality and this gate pins by digest.
MIN_GOLDEN_FIXTURES=5

DEFAULT_BASE="public-base"

# The literal a [fixtures] line carries in place of a hex digest when the covered path is
# DELETED. An absent path has no bytes, so it has no digest; without an explicit token a
# deletion could only be declared by inventing one.
DELETED_SENTINEL="DELETED"

# What `digest_of_path` returns for a path that is not on disk. Deliberately NOT hex, so it
# can never accidentally equal a declared digest and can never be pasted into the
# declaration as one.
ABSENT_DIGEST="(absent from the working tree - this path is DELETED)"

# --- The sha256 tool, selected ONCE ---------------------------------------------------
# `sha256sum` is GNU coreutils; a macOS runner ships only `shasum -a 256`. Selecting here
# rather than hard-coding is what keeps a missing tool an EXIT 2 ("the assertion could not
# be made") instead of the silent exit 1 an unguarded `$(...)` pipeline produces under
# `set -euo pipefail` - and exit 1 is documented below as "every offending path is named",
# which would send the reader hunting a move that does not exist.
if command -v sha256sum >/dev/null 2>&1; then
    SHA256_CMD=(sha256sum)
elif command -v shasum >/dev/null 2>&1; then
    SHA256_CMD=(shasum -a 256)
else
    echo "FAIL: no sha256 tool found, so the assertion could not be made." >&2
    echo >&2
    echo "This gate needs either 'sha256sum' (GNU coreutils) or 'shasum -a 256' on PATH." >&2
    echo "Every declared fixture line is a digest, and a gate that cannot compute one" >&2
    echo "cannot reconcile anything. Install coreutils, or run on a host that has it." >&2
    exit 2
fi

# The digest of an EMPTY stream, under whichever tool was selected. It is what the
# directory recipe yields for a directory holding no files at all, and computing it here
# keeps that case from hanging `xargs` on an empty input list.
EMPTY_STREAM_DIGEST="$(printf '' | "${SHA256_CMD[@]}" | LC_ALL=C awk '{print $1}')"

# The declaration is resolved by FIXED PATH and is not configurable: a gate that could be
# pointed at a different declaration could be pointed at an empty one. It sits outside the
# three covered crate roots on purpose, so declaring a move does not itself become an
# undeclared change to a covered source file.
DECLARATION="docs/DECLARED-MOVES.txt"

usage() {
    cat >&2 <<'USAGE'
usage: scripts/check-core-declared.sh [--base <ref> | <ref>]

Asserts every covered path against a base ref and the declaration file
docs/DECLARED-MOVES.txt: a covered path may MOVE, and the move must be DECLARED
with the digest the path is expected to carry afterwards.

Four checks:
  1. [fixtures], both directions, over the golden fixture directories, the scenario
     fixtures and snapshots, and the protocol fixtures. An undeclared move is named; a
     declared path that did not move is named; a digest that does not match the declared
     one is named with BOTH digests printed.
  2. [source], both directions, over the tracked non-fixture files under the three
     covered crate roots. A path list with no digests.
  3. No untracked new file under the covered crate roots.
  4. Cargo.lock byte-identity. The lockfile is deliberately NOT declarable.

Both covered sets are the UNION of the working tree and the base ref, so a DELETED path is
still walked and still reddens by name. A deleted fixture path is declared with the literal
digest field DELETED; a deleted source path is declared as a bare path under [source].

The diff is taken against the WORKING TREE, so uncommitted edits are caught too.
This is a git-level and digest-level assertion only: it does not build, test or replay.

  --base <ref>   base ref to compare against (also accepts --base=<ref>)
  <ref>          the same thing, positionally
  --help, -h     this message

  DECLARED_MOVES_BASE   env var; used when no ref is given on the command line

Precedence: command-line ref > $DECLARED_MOVES_BASE > the annotated tag `public-base`.

The base tag must be present locally. A shallow or tag-less clone cannot resolve it;
run `git fetch --tags --unshallow` (or check out with fetch-depth 0 in CI).

Exit codes:
  0  every covered path reconciles with the declaration
  1  it does not; every offending path is named on stderr
  2  the assertion could not be made (an unresolvable base ref, an absent, empty or
     unparseable declaration, a missing covered path, or a discovery walk smaller than
     the floor). This is a FAILURE, not a pass: an assertion that measures nothing must
     never be green.

That the covered path set is still all three crate roots plus the lockfile is checked by
something OTHER than this script, because this script cannot see its own COVERED_CRATES
array:
    bash scripts/prove-declared-gate-non-vacuous.sh --base public-base
USAGE
}

# --- Argument parsing: three routes, one leading-dash rule ---------------------------
BASE=""
while [ $# -gt 0 ]; do
    case "$1" in
        --help | -h)
            usage
            exit 0
            ;;
        --base)
            if [ $# -lt 2 ]; then
                echo "FAIL: --base requires a ref argument." >&2
                usage
                exit 2
            fi
            BASE="$2"
            shift 2
            ;;
        --base=*)
            BASE="${1#--base=}"
            shift
            ;;
        -*)
            echo "FAIL: unknown option '$1'." >&2
            usage
            exit 2
            ;;
        *)
            if [ -n "$BASE" ]; then
                echo "FAIL: more than one base ref given ('$BASE' and '$1')." >&2
                exit 2
            fi
            BASE="$1"
            shift
            ;;
    esac
done

if [ -z "$BASE" ]; then
    BASE="${DECLARED_MOVES_BASE:-$DEFAULT_BASE}"
fi

# The SAME leading-dash guard the CLI parser applies, on the environment route too.
# Without it the two input routes disagree: `--base --depth=1` is rejected with a named
# error while `DECLARED_MOVES_BASE=--depth=1` sails through and reaches
# `git rev-parse --verify --quiet -- '--depth=1^{commit}'` as an OPTION. That fails closed
# today and nothing here is interpolated into a shell, so this is not an injection - it is
# an inconsistency, and a gate whose two entry points enforce different rules is one
# refactor away from a real one.
case "$BASE" in
    -*)
        echo "FAIL: base ref '${BASE}' starts with '-', which git would read as an option." >&2
        echo "      Pass a real ref via the positional argument, --base, or DECLARED_MOVES_BASE." >&2
        exit 2
        ;;
esac

# --- Guard 0: the base ref must resolve ----------------------------------------------
if ! BASE_SHA="$(git rev-parse --verify --quiet "${BASE}^{commit}")"; then
    echo "FAIL: base ref '${BASE}' does not resolve to a commit, so the assertion could not be made." >&2
    echo >&2
    echo "A declared-moves assertion against a ref that does not exist would report a" >&2
    echo "green that measures nothing, so this is a hard failure." >&2
    if [ "$BASE" = "$DEFAULT_BASE" ]; then
        echo >&2
        echo "'${DEFAULT_BASE}' is the annotated tag on this repository's first commit. It is" >&2
        echo "missing from this clone, which usually means a shallow or tag-less checkout:" >&2
        echo "    git fetch --tags --unshallow    (or: git fetch --tags origin)" >&2
        echo "In CI, check out with 'fetch-depth: 0', which fetches every tag." >&2
    else
        echo "Pass a real ref, set DECLARED_MOVES_BASE, or drop the argument to use the" >&2
        echo "default tag '${DEFAULT_BASE}'." >&2
    fi
    exit 2
fi

# --- Guard 1: the declaration must exist and be non-empty ----------------------------
if [ ! -f "$DECLARATION" ]; then
    echo "FAIL: ${DECLARATION} does not exist, so the assertion could not be made." >&2
    echo >&2
    echo "Every covered path is reconciled against that file. Without" >&2
    echo "it there is nothing to reconcile against, and a run that reported green here" >&2
    echo "would be green because it measured nothing. Restore the file, or write it with" >&2
    echo "both sections carrying the literal line NONE if nothing has moved." >&2
    exit 2
fi

if [ ! -s "$DECLARATION" ]; then
    echo "FAIL: ${DECLARATION} is empty, so the assertion could not be made." >&2
    echo >&2
    echo "An empty declaration is indistinguishable from one somebody forgot to write." >&2
    echo "Zero moves is declared with the literal line NONE in each section; it is never" >&2
    echo "declared by leaving the file blank." >&2
    exit 2
fi

# --- Declaration parsing --------------------------------------------------------------
# Returns the body lines of one section, header comment block excluded. Section headers
# are matched after trimming surrounding whitespace so an indented header is still a
# header rather than silently becoming a body line of the previous section.
declaration_section() {
    local want="$1"
    LC_ALL=C awk -v want="[${want}]" '
        {
            line = $0
            sub(/^[[:space:]]+/, "", line)
            sub(/[[:space:]]+$/, "", line)
        }
        line ~ /^\[/ { in_section = (line == want); next }
        in_section { print line }
    ' "$DECLARATION"
}

section_present() {
    local want="$1"
    LC_ALL=C grep -qE "^[[:space:]]*\[${want}\][[:space:]]*$" "$DECLARATION"
}

# A declared path must stay inside the repository. `..` is refused anywhere in the string
# rather than only as a leading component: a gate that resolved `a/../../etc/passwd` would
# be digesting something nobody declared.
declared_path_is_safe() {
    local p="$1"
    case "$p" in
        "" | -* | /*) return 1 ;;
        *..*) return 1 ;;
    esac
    return 0
}

refuse_line() {
    local section="$1"
    local line="$2"
    local why="$3"
    echo "FAIL: ${DECLARATION} [${section}] holds a line this gate cannot parse, so the" >&2
    echo "      assertion could not be made:" >&2
    echo "        ${line}" >&2
    echo "      ${why}" >&2
    echo >&2
    echo "The line is REFUSED, never skipped. A line silently skipped is the vacuous green" >&2
    echo "this gate exists to refuse: it would read as a path nobody declared and as a" >&2
    echo "move nobody made, at the same time." >&2
    exit 2
}

for section in fixtures source; do
    if ! section_present "$section"; then
        echo "FAIL: ${DECLARATION} has no [${section}] section, so the assertion could not be made." >&2
        echo >&2
        echo "Both [fixtures] and [source] must be present. A section that is absent is not" >&2
        echo "a section with zero entries: zero entries is the literal line NONE." >&2
        exit 2
    fi
done

DECLARED_FIX_PATHS=()
DECLARED_FIX_DIGESTS=()
fixtures_none=0
fixtures_entries=0

while IFS= read -r line; do
    [ -z "$line" ] && continue
    case "$line" in '#'*) continue ;; esac
    if [ "$line" = "NONE" ]; then
        fixtures_none=1
        continue
    fi
    f1=""
    f2=""
    f3=""
    read -r f1 f2 f3 <<<"$line"
    if [ -z "$f2" ]; then
        refuse_line fixtures "$line" "a [fixtures] entry is '<path> <sha256>'; this line has one field."
    fi
    if [ -n "$f3" ]; then
        refuse_line fixtures "$line" "a [fixtures] entry is exactly '<path> <sha256>'; put the reason on a '#' comment line above it."
    fi
    if [ "$f2" != "$DELETED_SENTINEL" ] &&
        ! printf '%s' "$f2" | LC_ALL=C grep -qE '^[0-9a-f]{64}$'; then
        refuse_line fixtures "$line" "the second field is neither a 64-character lowercase hex sha256 nor the literal ${DELETED_SENTINEL} (which declares that the path is gone)."
    fi
    if ! declared_path_is_safe "$f1"; then
        refuse_line fixtures "$line" "the path is empty, absolute, option-shaped, or contains '..', so it may escape the repo root."
    fi
    DECLARED_FIX_PATHS+=("$f1")
    DECLARED_FIX_DIGESTS+=("$f2")
    fixtures_entries=$((fixtures_entries + 1))
done < <(declaration_section fixtures)

DECLARED_SRC_PATHS=()
source_none=0
source_entries=0

while IFS= read -r line; do
    [ -z "$line" ] && continue
    case "$line" in '#'*) continue ;; esac
    if [ "$line" = "NONE" ]; then
        source_none=1
        continue
    fi
    f1=""
    f2=""
    read -r f1 f2 <<<"$line"
    if [ -n "$f2" ]; then
        refuse_line source "$line" "a [source] entry is a bare path with no digest; put the reason on a '#' comment line above it."
    fi
    if ! declared_path_is_safe "$f1"; then
        refuse_line source "$line" "the path is empty, absolute, option-shaped, or contains '..', so it may escape the repo root."
    fi
    DECLARED_SRC_PATHS+=("$f1")
    source_entries=$((source_entries + 1))
done < <(declaration_section source)

for section in fixtures source; do
    if [ "$section" = "fixtures" ]; then
        none_flag="$fixtures_none"
        entry_count="$fixtures_entries"
    else
        none_flag="$source_none"
        entry_count="$source_entries"
    fi
    if [ "$none_flag" -eq 1 ] && [ "$entry_count" -gt 0 ]; then
        echo "FAIL: ${DECLARATION} [${section}] holds NONE alongside ${entry_count} entr(y/ies)," >&2
        echo "      so the assertion could not be made." >&2
        echo >&2
        echo "NONE means 'this section has zero entries'. It cannot coexist with an entry:" >&2
        echo "one of the two is stale and this gate must not guess which." >&2
        exit 2
    fi
    if [ "$none_flag" -eq 0 ] && [ "$entry_count" -eq 0 ]; then
        echo "FAIL: ${DECLARATION} [${section}] holds neither NONE nor an entry, so the" >&2
        echo "      assertion could not be made." >&2
        echo >&2
        echo "A section that is present but says nothing is indistinguishable from one" >&2
        echo "somebody started and did not finish. Declare zero moves with the literal" >&2
        echo "line NONE." >&2
        exit 2
    fi
done

# --- Guard 2: every covered root must exist, on disk AND at the base ref --------------
# A rename or deletion empties the compared set, which `git diff --quiet` reports as
# clean. Existence on BOTH sides is what makes the covered path set load-bearing.
missing=""
for p in "${COVERED_CRATES[@]}" "$GOLDEN_DIR" "$SCENARIO_FIXTURE_DIR" "$SCENARIO_SNAPSHOT_DIR" "$PROTOCOL_FIXTURE_DIR" "$LOCKFILE"; do
    if [ ! -e "$p" ]; then
        missing="${missing}  working tree: ${p}"$'\n'
    fi
    if ! git cat-file -e "${BASE_SHA}:${p}" 2>/dev/null; then
        missing="${missing}  ${BASE}: ${p}"$'\n'
    fi
done

if [ -n "$missing" ]; then
    echo "FAIL: a covered path is missing, so the assertion could not be made:" >&2
    printf '%s' "$missing" >&2
    echo >&2
    echo "A missing or renamed covered path would make the comparison vacuously empty." >&2
    echo "Restore the path. If the move was deliberate, amend the covered path set in" >&2
    echo "this script as a reviewed change - never as a way to make a red run pass." >&2
    exit 2
fi

# --- Discovery, all four corpora, on BOTH sides ---------------------------------------
# Golden fixtures are discovered by their hashes.txt manifest (the file
# scripts/regen-golden.sh writes), so a stray non-fixture directory cannot inflate the
# count. LC_ALL=C sort keeps the walk order stable across locales.
#
# EVERY LISTING IS TAKEN TWICE: once from the working tree or the index, and once from the
# BASE REF. The covered set is the UNION. That union is what makes a DELETION visible: a
# path discovered only from the working tree is, by construction, a path that still exists,
# so a set built that way can never hold the thing that is gone. Without the union, a
# `git rm` of a whole golden fixture directory, of a scenario fixture, or of
# crates/fabrico-core/src/lib.rs would each report OK with every discovery count unchanged.
#
# The `if !` wrapper is NOT redundant with `set -euo pipefail` - it is what keeps the two
# failure classes apart. As a BARE assignment, a failing `find` or `sort` propagates
# through `pipefail` and `set -e` aborts with EXIT 1 and NO OUTPUT. Exit 1 is documented
# as "every offending path is named on stderr", so a silent 1 naming nothing would report
# a broken assertion when the truth is that the assertion could not be MADE.
if ! golden_manifests="$(LC_ALL=C find "$GOLDEN_DIR" -mindepth 2 -maxdepth 2 -name 'hashes.txt' -print | LC_ALL=C sort)"; then
    echo "FAIL: could not walk ${GOLDEN_DIR} for golden fixtures, so the assertion could not be made." >&2
    echo >&2
    echo "The corpus discovery pipeline itself failed. This is NOT a report that a" >&2
    echo "covered path moved." >&2
    exit 2
fi

# The base side of the same walk. `git ls-tree -r` yields every blob path at the base; a
# golden fixture directory at the base is exactly one whose `<dir>/hashes.txt` is present
# there, which is the same manifest rule the working-tree walk applies.
if ! base_golden_listing="$(LC_ALL=C git ls-tree -r --name-only "$BASE_SHA" -- "$GOLDEN_DIR")"; then
    echo "FAIL: could not list ${GOLDEN_DIR} at '${BASE}', so the assertion could not be made." >&2
    echo >&2
    echo "Without the base side of this walk the gate cannot see a golden fixture" >&2
    echo "directory that was DELETED, and a set that cannot hold the deleted path" >&2
    echo "compares clean. This is NOT a report that a covered path moved." >&2
    exit 2
fi

golden_dirs_both="$(
    {
        if [ -n "$golden_manifests" ]; then
            printf '%s\n' "$golden_manifests"
        fi
        if [ -n "$base_golden_listing" ]; then
            printf '%s\n' "$base_golden_listing"
        fi
    } | LC_ALL=C awk -v root="$GOLDEN_DIR" '
        {
            n = length(root) + 1
            if (substr($0, 1, n) != root "/") { next }
            rest = substr($0, n + 1)
            slash = index(rest, "/")
            if (slash == 0) { next }
            name = substr(rest, 1, slash - 1)
            if (substr(rest, slash + 1) != "hashes.txt") { next }
            print root "/" name
        }
    ' | LC_ALL=C sort -u
)"

GOLDEN_PATHS=()
if [ -n "$golden_dirs_both" ]; then
    while IFS= read -r d; do
        [ -z "$d" ] && continue
        GOLDEN_PATHS+=("$d")
    done <<<"$golden_dirs_both"
fi
golden_count="${#GOLDEN_PATHS[@]}"

if [ "$golden_count" -lt "$MIN_GOLDEN_FIXTURES" ]; then
    echo "FAIL: discovered only ${golden_count} golden fixture director(y/ies) under ${GOLDEN_DIR}," >&2
    echo "      below the floor of ${MIN_GOLDEN_FIXTURES}, so the assertion could not be made." >&2
    echo >&2
    echo "A truncated or empty discovery walk would let the corpus arm pass vacuously," >&2
    echo "so this is a hard failure rather than a green with a warning." >&2
    exit 2
fi

if ! scenario_listing="$(LC_ALL=C git ls-files -- "$SCENARIO_FIXTURE_DIR" "$SCENARIO_SNAPSHOT_DIR" | LC_ALL=C sort)"; then
    echo "FAIL: could not list the scenario corpora, so the assertion could not be made." >&2
    exit 2
fi
if ! base_scenario_listing="$(LC_ALL=C git ls-tree -r --name-only "$BASE_SHA" -- "$SCENARIO_FIXTURE_DIR" "$SCENARIO_SNAPSHOT_DIR")"; then
    echo "FAIL: could not list the scenario corpora at '${BASE}', so the assertion could not be made." >&2
    exit 2
fi
if ! protocol_listing="$(LC_ALL=C git ls-files -- "$PROTOCOL_FIXTURE_DIR" | LC_ALL=C sort)"; then
    echo "FAIL: could not list ${PROTOCOL_FIXTURE_DIR}, so the assertion could not be made." >&2
    exit 2
fi
if ! base_protocol_listing="$(LC_ALL=C git ls-tree -r --name-only "$BASE_SHA" -- "$PROTOCOL_FIXTURE_DIR")"; then
    echo "FAIL: could not list ${PROTOCOL_FIXTURE_DIR} at '${BASE}', so the assertion could not be made." >&2
    exit 2
fi

# Folds a working-tree listing and a base listing into ONE sorted, de-duplicated list. A
# path present on either side is a covered path: present-only-at-base is a DELETION and
# present-only-in-the-tree is an ADDITION, and both must be declared.
union_listing() {
    {
        if [ -n "${1:-}" ]; then printf '%s\n' "$1"; fi
        if [ -n "${2:-}" ]; then printf '%s\n' "$2"; fi
    } | LC_ALL=C sed '/^$/d' | LC_ALL=C sort -u
}

SCENARIO_FILES=()
scenario_both="$(union_listing "$scenario_listing" "$base_scenario_listing")"
if [ -n "$scenario_both" ]; then
    while IFS= read -r f; do
        [ -z "$f" ] && continue
        SCENARIO_FILES+=("$f")
    done <<<"$scenario_both"
fi
PROTOCOL_FILES=()
protocol_both="$(union_listing "$protocol_listing" "$base_protocol_listing")"
if [ -n "$protocol_both" ]; then
    while IFS= read -r f; do
        [ -z "$f" ] && continue
        PROTOCOL_FILES+=("$f")
    done <<<"$protocol_both"
fi

scenario_count="${#SCENARIO_FILES[@]}"
protocol_count="${#PROTOCOL_FILES[@]}"
lockfile_count=1

# A zero on ANY of the four discovery counts is a walk that found nothing, and a walk that
# found nothing compares clean. The OK line reports all four for exactly this reason: a
# reader who sees a zero there is looking at a green that measured nothing.
if [ "$scenario_count" -eq 0 ] || [ "$protocol_count" -eq 0 ]; then
    echo "FAIL: a corpus discovery walk came back EMPTY, so the assertion could not be made:" >&2
    echo "        scenario files: ${scenario_count}" >&2
    echo "        protocol files: ${protocol_count}" >&2
    echo >&2
    echo "An empty corpus compares clean against any base. This is a hard failure rather" >&2
    echo "than a green with a zero in it." >&2
    exit 2
fi

# --- The covered path sets ------------------------------------------------------------
# A golden fixture DIRECTORY is ONE covered path. Every other covered fixture path is a
# single file.
COVERED_FIXTURE_PATHS=()
COVERED_FIXTURE_PATHS+=("${GOLDEN_PATHS[@]}")
COVERED_FIXTURE_PATHS+=("${SCENARIO_FILES[@]}")
COVERED_FIXTURE_PATHS+=("${PROTOCOL_FILES[@]}")

list_contains() {
    local needle="$1"
    shift
    local item
    for item in "$@"; do
        if [ "$item" = "$needle" ]; then
            return 0
        fi
    done
    return 1
}

path_is_under_fixture() {
    local f="$1"
    local d
    case "$f" in
        "$GOLDEN_DIR"/*)
            for d in "${GOLDEN_PATHS[@]}"; do
                case "$f" in
                    "$d"/*) return 0 ;;
                esac
            done
            ;;
    esac
    if list_contains "$f" "${SCENARIO_FILES[@]}"; then
        return 0
    fi
    if list_contains "$f" "${PROTOCOL_FILES[@]}"; then
        return 0
    fi
    return 1
}

# The covered SOURCE set: every tracked file under the three crate roots that is not part
# of a covered fixture path. crates/fabrico-core/tests/golden/README.md sits under the
# golden directory but is not inside a fixture directory, so it is source, not a fixture -
# that boundary is deliberate and stated here because it is the one a reader gets wrong.
#
# THE UNION AGAIN, and this is the arm that hid the worst case: `git ls-files` lists the
# INDEX, so a `git rm crates/fabrico-core/src/lib.rs` removed the deterministic core's
# crate root from the covered source set and the gate printed its full green line with
# every discovery count unchanged. Folding in `git ls-tree` at the base keeps the deleted
# path a covered path, so it differs from the base and reddens unless [source] declares it.
if ! tracked_listing="$(LC_ALL=C git ls-files -- "${COVERED_CRATES[@]}" | LC_ALL=C sort)"; then
    echo "FAIL: could not list the covered crate roots, so the assertion could not be made." >&2
    exit 2
fi
if ! base_tracked_listing="$(LC_ALL=C git ls-tree -r --name-only "$BASE_SHA" -- "${COVERED_CRATES[@]}")"; then
    echo "FAIL: could not list the covered crate roots at '${BASE}', so the assertion could not be made." >&2
    echo >&2
    echo "Without the base side of this walk a DELETED source file is a member of nothing" >&2
    echo "this gate compares. This is NOT a report that a covered path moved." >&2
    exit 2
fi

COVERED_SOURCE_PATHS=()
while IFS= read -r f; do
    [ -z "$f" ] && continue
    if path_is_under_fixture "$f"; then
        continue
    fi
    COVERED_SOURCE_PATHS+=("$f")
done < <(union_listing "$tracked_listing" "$base_tracked_listing")

if [ "${#COVERED_SOURCE_PATHS[@]}" -eq 0 ]; then
    echo "FAIL: the covered SOURCE walk came back empty, so the assertion could not be made." >&2
    echo >&2
    echo "The three covered crate roots hold tracked non-fixture files. A walk that found" >&2
    echo "none of them compares clean and would report a green that measured nothing." >&2
    exit 2
fi

# --- What differs from the base, computed once ----------------------------------------
# One `git diff` over the whole covered surface, rather than one per path: the comparison
# below is a set membership test against this listing, which keeps a 250-path walk to a
# single git invocation.
if ! changed_listing="$(LC_ALL=C git diff --name-only "$BASE_SHA" -- "${COVERED_CRATES[@]}" "$LOCKFILE" | LC_ALL=C sort)"; then
    echo "FAIL: could not diff the covered paths against '${BASE}', so the assertion could not be made." >&2
    exit 2
fi
changed_nl=$'\n'"${changed_listing}"$'\n'

path_differs_from_base() {
    local p="$1"
    case "$changed_nl" in
        *$'\n'"$p"$'\n'*) return 0 ;;
    esac
    local c
    while IFS= read -r c; do
        [ -z "$c" ] && continue
        case "$c" in
            "$p"/*) return 0 ;;
        esac
    done <<<"$changed_listing"
    return 1
}

# The digest recipe, and the ONE place it is implemented. Three cases:
#
#   ABSENT   the path is not on disk, which after the union above is a normal and expected
#            state (a DELETED covered path). It has no bytes, so it gets the non-hex marker
#            $ABSENT_DIGEST, which can never equal a declared hex digest.
#   DIRECTORY  every file at ANY depth, dot-files included, digested and then digested
#            again. `find`, never `ls`: `ls` omits dot-files and does not recurse, so a
#            tracked `.smuggled` file or a nested subdirectory planted inside a DECLARED
#            fixture directory would leave the digest unmoved and ride in green. The `./`
#            prefix `find` emits is part of the digested text.
#   FILE     a plain sha256 of the raw bytes.
#
# An empty directory is handled before `xargs` sees an empty list, because `xargs` with no
# arguments runs the command with no operands and it would then read stdin and hang. The
# value it yields is the digest of an empty stream, which is what the pipeline would have
# produced had `xargs` been willing.
digest_of_path() {
    local p="$1"
    if [ ! -e "$p" ]; then
        printf '%s\n' "$ABSENT_DIGEST"
        return 0
    fi
    if [ -d "$p" ]; then
        if [ -z "$(LC_ALL=C find "$p" -type f)" ]; then
            printf '%s\n' "$EMPTY_STREAM_DIGEST"
            return 0
        fi
        (
            cd "$p" || exit 1
            LC_ALL=C find . -type f -print0 |
                LC_ALL=C sort -z |
                xargs -0 "${SHA256_CMD[@]}" |
                "${SHA256_CMD[@]}"
        ) | LC_ALL=C awk '{print $1}'
    else
        "${SHA256_CMD[@]}" "$p" | LC_ALL=C awk '{print $1}'
    fi
}

declared_move_footer() {
    echo >&2
    echo "HOW TO ANSWER THIS." >&2
    echo "  Either DECLARE the move or REVERT the edit. Nothing else answers it." >&2
    echo >&2
    echo "  To DECLARE a fixture move, append one line to ${DECLARATION} under" >&2
    echo "  [fixtures], with a one-line reason as a '#' comment above it:" >&2
    echo "      # <why this change moves it>" >&2
    echo "      <path> <post-move sha256>" >&2
    echo "  The digest of a golden fixture DIRECTORY is" >&2
    echo "      (cd <dir> && LC_ALL=C find . -type f -print0 | LC_ALL=C sort -z \\" >&2
    echo "         | xargs -0 sha256sum | sha256sum)" >&2
    echo "  that is, every file it holds at ANY depth, dot-files included, sorted BYTE-WISE" >&2
    echo "  by its './'-prefixed path. 'ls' is NOT the recipe: it omits dot-files and does" >&2
    echo "  not recurse, so a file smuggled into a declared directory left its digest" >&2
    echo "  unmoved. The digest of every other covered path is a plain 'sha256sum <path>'." >&2
    echo "  Where this run printed a recomputed digest above, that is the value to paste." >&2
    echo >&2
    echo "  To DECLARE a fixture DELETION, use the literal digest field ${DELETED_SENTINEL}:" >&2
    echo "      # <why this change deletes it>" >&2
    echo "      <path> ${DELETED_SENTINEL}" >&2
    echo "  An absent path has no bytes, so it has no digest. That line is refused while the" >&2
    echo "  path is still on disk, so it cannot outlive the deletion it describes." >&2
    echo >&2
    echo "  To DECLARE a source edit OR a source deletion, append the bare path under" >&2
    echo "  [source]. A deletion needs nothing extra there: that section already" >&2
    echo "  carries no digests, and it is checked in BOTH directions: a path listed there" >&2
    echo "  that did not actually change is a red too, because a stale entry silently" >&2
    echo "  un-guards that file for every later change against this base." >&2
    echo >&2
    echo "  To REVERT, restore the offending path and re-run." >&2
    echo >&2
    echo "WHAT DOES NOT ANSWER IT. Do NOT narrow the covered path set in this script, and" >&2
    echo "do NOT move the base ref '${DEFAULT_BASE}' forward. Both make the red go away by" >&2
    echo "deleting the measurement, and the whole point of this gate is that a move is" >&2
    echo "DECLARED rather than hidden." >&2
    echo >&2
}

# Every check below runs even after an earlier one fails, and the exit is deferred to the
# end: one run should name EVERY offending path, so the finding is actionable without
# re-running git by hand or fixing-and-rerunning one file at a time.
failed=0
declared_matched=0

# --- Check 1: the [fixtures] arm, both directions -------------------------------------
if [ "${#DECLARED_FIX_PATHS[@]}" -gt 0 ]; then
    for i in "${!DECLARED_FIX_PATHS[@]}"; do
        dp="${DECLARED_FIX_PATHS[$i]}"
        want="${DECLARED_FIX_DIGESTS[$i]}"

        if ! list_contains "$dp" "${COVERED_FIXTURE_PATHS[@]}"; then
            echo "FAIL: [fixtures] declares '${dp}', which is not a covered fixture path." >&2
            echo "      Covered fixture paths are the golden fixture DIRECTORIES under" >&2
            echo "      ${GOLDEN_DIR}, the files under ${SCENARIO_FIXTURE_DIR} and" >&2
            echo "      ${SCENARIO_SNAPSHOT_DIR}, and the files under ${PROTOCOL_FIXTURE_DIR}." >&2
            echo "      A source path belongs in [source], which carries no digest." >&2
            failed=1
            continue
        fi

        if ! path_differs_from_base "$dp"; then
            echo "FAIL: DECLARED but UNMOVED - [fixtures] declares '${dp}', which is" >&2
            echo "      byte-identical to '${BASE}'." >&2
            echo "      A declaration that outlives the move it described becomes a blanket" >&2
            echo "      permission for that path from then on. Remove the line, or make the" >&2
            echo "      move it declares." >&2
            failed=1
            continue
        fi

        # A declared DELETION: the path must actually be gone. A line that says "gone"
        # while the bytes are still on disk is the stale entry the both-directions rule
        # exists to catch, and accepting it would hand that path a blanket permission from
        # then on.
        if [ "$want" = "$DELETED_SENTINEL" ]; then
            if [ -e "$dp" ]; then
                echo "FAIL: DECLARED ${DELETED_SENTINEL} but PRESENT - [fixtures] declares '${dp}'" >&2
                echo "      as deleted, but it is on disk." >&2
                echo "      Either delete it, or replace ${DELETED_SENTINEL} with the digest it now" >&2
                echo "      carries. A declaration that outlives the deletion it described is a" >&2
                echo "      blanket permission for that path from then on." >&2
                failed=1
                continue
            fi
            declared_matched=$((declared_matched + 1))
            continue
        fi

        # `if !`, not a bare assignment: under `set -euo pipefail` a failing digest
        # pipeline aborts the script with exit 1 and NO OUTPUT, and exit 1 is documented
        # above as "every offending path is named on stderr". The reader would go hunting a
        # move that does not exist. A digest that cannot be computed is exit 2, "the
        # assertion could not be made", which is a different thing and says so.
        if ! got="$(digest_of_path "$dp")"; then
            echo "FAIL: could not digest '${dp}', so the assertion could not be made." >&2
            echo >&2
            echo "The digest pipeline itself failed. This is NOT a report that a covered" >&2
            echo "path moved: nothing was compared for this path at all." >&2
            exit 2
        fi
        if [ "$got" != "$want" ]; then
            echo "FAIL: DIGEST MISMATCH - '${dp}' moved, but not to the declared bytes:" >&2
            echo "        declared:   ${want}" >&2
            echo "        recomputed: ${got}" >&2
            echo "      Either the move landed differently from what was declared, or the" >&2
            echo "      declared digest was computed by a different recipe. Paste the" >&2
            echo "      recomputed value above if the current bytes are the intended ones." >&2
            failed=1
            continue
        fi

        declared_matched=$((declared_matched + 1))
    done
fi

for cp in "${COVERED_FIXTURE_PATHS[@]}"; do
    if [ "${#DECLARED_FIX_PATHS[@]}" -gt 0 ] && list_contains "$cp" "${DECLARED_FIX_PATHS[@]}"; then
        continue
    fi
    if path_differs_from_base "$cp"; then
        # Same `if !` reasoning as above: inside `echo`'s arguments a failure is swallowed
        # entirely and the reader gets "recomputed: " with an empty value beside a red they
        # then cannot act on.
        if ! recomputed="$(digest_of_path "$cp")"; then
            echo "FAIL: could not digest '${cp}', so the assertion could not be made." >&2
            echo >&2
            echo "The digest pipeline itself failed while reporting an undeclared move." >&2
            exit 2
        fi
        echo "FAIL: MOVED but NOT DECLARED - '${cp}' differs from '${BASE}' and no" >&2
        echo "      [fixtures] line declares it." >&2
        echo "        recomputed: ${recomputed}" >&2
        if [ ! -e "$cp" ]; then
            echo "      This path is GONE from the working tree. A DELETION is a move: declare" >&2
            echo "      it with the literal digest field ${DELETED_SENTINEL}, or restore the path." >&2
        fi
        failed=1
    fi
done

# --- Check 2: the [source] arm, both directions, membership only ----------------------
# Membership, never content: a change declares which source files it expects to touch and
# the gate ignores what it did to them. The limit that buys is stated in this file's
# header and in the declaration's own header, in full.
if [ "${#DECLARED_SRC_PATHS[@]}" -gt 0 ]; then
    for dp in "${DECLARED_SRC_PATHS[@]}"; do
        if ! list_contains "$dp" "${COVERED_SOURCE_PATHS[@]}"; then
            echo "FAIL: [source] declares '${dp}', which is not a covered source path." >&2
            echo "      Covered source paths are the tracked non-fixture files under" >&2
            echo "      ${COVERED_CRATES[*]}. A fixture path belongs in [fixtures], with a" >&2
            echo "      digest." >&2
            failed=1
            continue
        fi
        if ! path_differs_from_base "$dp"; then
            echo "FAIL: DECLARED but UNCHANGED - [source] lists '${dp}', which is" >&2
            echo "      byte-identical to '${BASE}'." >&2
            echo "      The declaration is cumulative since the base, so an entry that" >&2
            echo "      outlives its change silently un-guards that file for every change" >&2
            echo "      after it. Remove the line, or make the edit it declares." >&2
            failed=1
            continue
        fi
        declared_matched=$((declared_matched + 1))
    done
fi

for cp in "${COVERED_SOURCE_PATHS[@]}"; do
    if [ "${#DECLARED_SRC_PATHS[@]}" -gt 0 ] && list_contains "$cp" "${DECLARED_SRC_PATHS[@]}"; then
        continue
    fi
    if path_differs_from_base "$cp"; then
        echo "FAIL: CHANGED but NOT DECLARED - '${cp}' differs from '${BASE}' and no" >&2
        echo "      [source] line declares it." >&2
        if [ ! -e "$cp" ]; then
            echo "      This path is GONE from the working tree. A DELETION is a change:" >&2
            echo "      declare the bare path under [source], or restore it." >&2
        fi
        failed=1
    fi
done

# --- Check 3: no UNTRACKED file under the covered crate roots -------------------------
# `git diff <commit>` compares only files git already knows about, so a brand-new,
# never-added .rs file under crates/fabrico-core is INVISIBLE to checks 1 and 2 - it would
# pass green while a new module sat in the core. `--exclude-standard` honours .gitignore,
# so build output (target/) and other ignored artefacts do not trip the gate.
untracked="$(git ls-files --others --exclude-standard -- "${COVERED_CRATES[@]}")"
if [ -n "$untracked" ]; then
    echo "FAIL: untracked new file(s) under the covered crate paths:" >&2
    printf '%s\n' "$untracked" | sed 's/^/  /' >&2
    echo "      A path git has never been told about is invisible to every diff above," >&2
    echo "      so it cannot be declared and cannot be reconciled. Add it and declare it," >&2
    echo "      or remove it." >&2
    failed=1
fi

# --- Check 4: Cargo.lock byte-identity against the base -------------------------------
if ! git diff --quiet "$BASE_SHA" -- "$LOCKFILE"; then
    echo "FAIL: ${LOCKFILE} changed against '${BASE}' (${BASE_SHA:0:12})." >&2
    echo "      A dependency bump can change generated code and therefore serialized bytes" >&2
    echo "      without touching a line under crates/, so the lockfile is covered alongside" >&2
    echo "      the three crate roots. It is deliberately NOT declarable: a dependency" >&2
    echo "      change is a reviewed move of the base tag (see BASE MOVES in this script's" >&2
    echo "      header), not a line appended to a data file. Revert the lockfile change," >&2
    echo "      or move the base as that section describes." >&2
    failed=1
fi

if [ "$failed" -ne 0 ]; then
    declared_move_footer
    exit 1
fi

echo "OK: every covered path reconciles with ${DECLARATION} against ${BASE} (${BASE_SHA:0:12}) - discovered ${golden_count} golden fixture directories, ${scenario_count} scenario files, ${protocol_count} protocol files and ${lockfile_count} lockfile; ${declared_matched} declared move(s) matched."
exit 0
