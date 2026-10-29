#!/usr/bin/env bash
#
# NON-VACUITY PROOF for the declared-moves gate, scripts/check-core-declared.sh.
#
# ---------------------------------------------------------------------------------
# WHY THIS EXISTS. The gate has ONE blind spot and it is structural: IT CANNOT SEE EDITS TO
# ITSELF, OR TO ITS OWN `COVERED_CRATES` LIST. `scripts/` is not a covered path, there is
# no self-hash, and nothing else asserts that list still names three crates. A change that
# deleted "crates/fabrico-protocol" from it would go GREEN and nothing else in this
# repository would fire, because a comparison taken against a narrowed path set is
# vacuously empty by construction.
#
# So the proof is a COMMITTED SCRIPT THAT RUNS IN CI, not one manual probe recorded in
# prose. ACCEPTANCE IS THIS SCRIPT'S EXIT CODE, NEVER A SOURCE GREP.
#
# WHAT IS ASSERTED - nine properties. Numbers 1 to 8 are listed in run order; number 9
# RUNS second-to-last, so that number 8 stays this script's exit condition:
#
#   1. BASELINE GREEN. With no probe applied, the gate exits 0 over the COMMITTED
#      declaration. Without this every red below proves nothing: a tree already dirty
#      against the base makes the gate exit non-zero whether a probe is applied or not.
#   2. THE [source] ARM BITES. A throwaway edit to a covered source file that the
#      declaration does not list makes the gate exit exactly 1 and NAME that path.
#   3. THE DIGEST ARM BITES. A declared path whose recomputed digest differs from the
#      declared one exits 1, naming the path and BOTH digests; restoring the content
#      returns exit 0.
#   4. A DECLARED-BUT-UNMOVED ENTRY BITES. A declaration line naming a path that did NOT
#      move exits 1 naming that path, and does so through the unmoved arm rather than the
#      digest arm.
#   5. THE UNTRACKED WALK BITES. A brand-new untracked file under a covered path exits 1
#      naming it. This is the hole no diff against a commit can see.
#   6. THE LOCKFILE CHECK BITES. A one-byte Cargo.lock edit exits 1.
#   7. THE GATE'S OWN COVERED-PATH LIST STILL HOLDS ALL FOUR ROOTS. The three crate roots
#      are read from `COVERED_CRATES` BY BLOCK with comment lines filtered out, so the
#      gate's header prose - which names all three crates in English - cannot satisfy the
#      check on its own. The fourth root is the lockfile.
#   8. CLEAN REVERT. This run left the working tree exactly as it found it.
#   9. THE DELETION ARM BITES. `git rm` of an undeclared covered path that EXISTS AT THE
#      BASE exits 1 NAMING it; an unstage and the path's kept bytes restore it
#      byte-identically. Every property above perturbs a path by CHANGING it, and a
#      changed path is present on both sides by construction - so not one of them could
#      see a covered set discovered from the working tree alone, in which `git rm` of a
#      golden fixture directory, of a scenario fixture, or of crates/fabrico-core/src/lib.rs
#      would each leave the gate printing its full green line. It RUNS second-to-last,
#      after the carve-out and before property 8, because property 8 is this script's exit
#      condition; the number is the property's identity, not its position.
#
# ---------------------------------------------------------------------------------
# EVERY PROBE PATH IS SELECTED AT RUN TIME. NO COVERED PATH IS WRITTEN INTO THIS SCRIPT.
#
# The reason is the declaration file itself. docs/DECLARED-MOVES.txt is CUMULATIVE since
# the base tag: every change that moves a covered path appends to it. So a path written
# into this script today is a DECLARED path tomorrow. The `[source]` arm ignores the
# CONTENT of a declared file by design, the gate therefore exits 0 on an edit to it, and
# property 2 would read that 0 as "the arm is not enforced" and redden a gate that is
# working perfectly. Nor may the probes be three files chosen because nobody will ever
# declare them: that is the narrowing move in different clothing, and narrowing is the
# exact thing this script exists to refuse.
#
# Selection runs in the SETUP phase, BEFORE property 1. That ordering is load-bearing:
# if selection ran at the property that uses it, a tree whose candidate set is exhausted
# AND whose baseline is red would report property 1's exit 1 and never reach the point
# where it would have discovered it has no probe left. A proof that cannot tell "I
# checked and it failed" from "I had nothing to check with" is the vacuous green in its
# most dangerous form.
#
# AN EXHAUSTED CANDIDATE SET IS EXIT 2, NEVER EXIT 0 AND NEVER EXIT 1. It is named as
# "the assertion could not be made", and the message says WHICH property lost its probe.
# A proof that has run out of things to perturb measured nothing.
# ---------------------------------------------------------------------------------
#
# ---------------------------------------------------------------------------------
# THE ENTRY GUARD, AND ITS ONE CARVE-OUT.
#
# The entry guard refuses to run over a dirty tree: any tracked file modified, staged or
# deleted ANYWHERE, or any untracked file under `crates`, `frontend`, `scripts` or `docs`.
# That is exit 2, not exit 1: a dirty tree makes property 1 fail for a reason that has
# nothing to do with the gate, and reporting that as "the gate is vacuous" sends the
# reader hunting the wrong bug.
#
# EXACTLY ONE PATH IS EXEMPT FROM THE TRACKED-DIRT HALF: `$GATE_DIRT_EXEMPT`, which is
# `scripts/check-core-declared.sh`. The reason is a reviewer's check of this proof, in
# which the reader EDITS the gate live - deleting a root from its covered-path list - and
# then runs this proof expecting to SEE the exit 1 that says the covered set no longer
# holds all three corpora. Without the carve-out that check could not be made: the guard
# would refuse with exit 2, and showing a refusal where a bite was promised is precisely
# the confusion this proof exists to remove.
#
# THREE LIMITS KEEP THE CARVE-OUT FROM BECOMING A HOLE:
#   1. It applies ONLY to the entry guard, NEVER to the closing residue assertion. A run
#      that leaves the gate dirty at exit still fails, and the residue message names it.
#      For the same reason this script never reverts a gate edit it did not make: a live
#      edit by the reader is the reader's work, not this script's residue.
#   2. It is one exact path. Never a directory, never a glob.
#   3. This proof asserts the carve-out itself: one of its own cases dirties the gate,
#      confirms the run proceeds past the entry guard, and confirms that the covered-list
#      assertion is the thing that reddens.
# ---------------------------------------------------------------------------------
#
# THIS IS A MERGE-GATE TOOL, NOT A DEVELOPMENT-LOOP TOOL. It cannot run over a tree with
# uncommitted work in it, even work far from the covered crates. That price is stated
# rather than left to be discovered: the proof is meaningful ONLY at a base the working
# tree is genuinely clean against.
#
# ---------------------------------------------------------------------------------
# IT RUNS IN A PRIVATE WORKTREE.
#
# Every property above has to MODIFY, STAGE or DELETE a tracked path: a covered source
# file, a fixture, the declaration, Cargo.lock, the gate itself, and property 9 stages a
# deletion with `git rm`. Other processes may share this checkout and its index, so doing
# that here would discard an edit saved mid-run and leave a staged deletion where the next
# commit made in this tree would carry it. No untracked file can stand in for those paths,
# so this is Shape B of scripts/lib/prover-isolation.sh: once the base ref is resolved,
# `prover_run_in_worktree` checks HEAD out into a detached worktree outside this checkout,
# applies the caller's uncommitted tracked diff over it, and re-runs this script there.
# Everything below happens in that worktree and its own index; the base tag resolves there
# because a worktree shares its repository's refs. Each probed path's bytes are kept at
# entry and every restore puts those bytes back; property 9 unstages inside the worktree
# before it does. The worktree is removed at exit whatever the outcome.
#
# The entry guard and the carve-out still hold, and now apply to the worktree, which
# mirrors the caller's tracked diff: an uncommitted tracked edit in the caller's tree is
# still exit 2, as before.
# ---------------------------------------------------------------------------------
#
# THE BASE REF IS AN ARGUMENT AND THERE IS NO DEFAULT, deliberately. A proof run against a
# guessed base proves something about a base nobody declared. The ref is taken the three
# ways the gate takes it - positionally, via `--base`, and via `DECLARED_MOVES_BASE` -
# with the SAME leading-dash refusal on every route.
#
# EXIT CODES:
#   0  PROVEN. All nine properties held and the carve-out behaved as specified.
#   1  A property did NOT hold. The gate is vacuous, or weaker than claimed. Every
#      failing property is named.
#   2  The proof COULD NOT BE MADE. This is a FAILURE, not a pass - an assertion that
#      measures nothing must never present as green. The classes, each implemented below:
#        - no base ref given (argument and environment variable both absent)
#        - a base ref starting with '-' on either route
#        - more than one base ref given
#        - the base ref does not resolve to a commit (a shallow or tag-less checkout)
#        - the gate script or the declaration file is absent
#        - the working tree was dirty at entry (anything other than the exempt gate path)
#        - a probe candidate set was EXHAUSTED, so a property lost its probe
#        - the gate's COVERED_CRATES array could not be located at all

set -euo pipefail

# The isolation helper is sourced before any change of directory, so it can locate this
# script as it was invoked. It owns the only EXIT trap this script has.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source-path=SCRIPTDIR source=lib/prover-isolation.sh
. "${SCRIPT_DIR}/lib/prover-isolation.sh"

# Resolve repo root so the script works from any cwd, exactly as the gate does.
cd "$(git rev-parse --show-toplevel)"

GATE="scripts/check-core-declared.sh"
DECLARATION="docs/DECLARED-MOVES.txt"
LOCKFILE="Cargo.lock"

# The three covered crate roots, written out HERE rather than read from the gate. If the
# two ever disagree, property 7 below is what says so, and a proof that sourced its
# subject's own list could not.
EXPECTED_CRATES=(
    "crates/fabrico-core"
    "crates/fabrico-protocol"
    "crates/fabrico-scenario"
)

# The fixture path prefixes, written out here for the same reason EXPECTED_CRATES is: if
# this proof's idea of what counts as a covered SOURCE file and the gate's ever disagree,
# that disagreement IS a narrowing and must surface as a red rather than be hidden by
# sourcing the subject.
FIXTURE_PREFIXES=(
    "crates/fabrico-core/tests/golden/"
    "crates/fabrico-scenario/fixtures/"
    "crates/fabrico-scenario/snapshots/"
    "crates/fabrico-protocol/tests/fixtures/"
)

GOLDEN_ROOT="crates/fabrico-core/tests/golden"

# The carve-out: EXACTLY ONE path, exempt from the entry guard's tracked-dirt half and
# from nothing else. No glob character, no directory.
GATE_DIRT_EXEMPT="scripts/check-core-declared.sh"

SOURCE_TREES=(
    "crates"
    "frontend"
    "scripts"
    "docs"
)

PROBE_TEXT="THROWAWAY probe line written by scripts/prove-declared-gate-non-vacuous.sh. If you are seeing this committed, the proof aborted without reverting - delete this line."

usage() {
    cat >&2 <<'USAGE'
usage: scripts/prove-declared-gate-non-vacuous.sh [--base <ref> | <ref>]

Proves that scripts/check-core-declared.sh actually BITES, in all nine ways listed
below, and that the gate's own covered-path list still names all four covered roots.

The nine properties, in run order:
  1. baseline green            - the gate exits 0 with no probe applied
  2. the [source] arm bites    - an undeclared source edit exits 1 NAMING the path
  3. the digest arm bites      - a declared path whose digest differs exits 1 printing
                                 BOTH digests; restoring the content returns exit 0
  4. declared-but-unmoved      - a line naming a path that did not move exits 1 NAMING it
  5. the untracked walk bites  - a new untracked file under a covered path exits 1
  6. the lockfile check bites  - a one-byte Cargo.lock edit exits 1
  7. the covered list holds    - COVERED_CRATES still names all three crates, read BY
                                 BLOCK with comments filtered, plus the lockfile
  9. the deletion arm bites    - `git-rm` of an undeclared covered path that exists at the
                                 base exits 1 NAMING it, and the path is restored
                                 byte-identically. Runs here, second-to-last, so that
                                 property 8 stays this script's exit condition
  8. clean revert              - this run left the tree exactly as it found it

Every probe path is SELECTED AT RUN TIME from the current declaration. No covered path is
written into this script: the declaration grows with every covered move, and a
hard-coded probe becomes a declared path the moment its move lands. An exhausted
candidate set is
exit 2 and never exit 0.

  --base <ref>   base ref to prove at (also accepts --base=<ref>)
  <ref>          the same thing, positionally
  --help, -h     this message

  DECLARED_MOVES_BASE   env var; used when no ref is given on the command line

THERE IS NO DEFAULT BASE, deliberately. A proof run against a guessed base proves
something about a base nobody declared.

Exit codes:
  0  proven
  1  a property did not hold; every failure is named
  2  the proof could not be made (no base ref, an unresolvable one, a missing gate or
     declaration, a dirty tree at entry, an exhausted probe candidate set, or a
     covered-path list that could not be located). This is a FAILURE, not a pass.

THE WHOLE WORKING TREE MUST BE CLEAN, not merely the probe paths. Any tracked file
modified anywhere, or any untracked file under crates/, frontend/, scripts/ or docs/, is
exit 2 - with EXACTLY ONE exemption, scripts/check-core-declared.sh itself, so that a
reader can edit the gate live and watch this proof redden. That exemption applies to the
entry guard only: a run that leaves the gate dirty at exit still fails and names it, and
this script never reverts a gate edit it did not make.

  DECLARED_MOVES_BASE=public-base bash scripts/prove-declared-gate-non-vacuous.sh
USAGE
}

# --- Argument parsing: the gate's three routes, with the gate's leading-dash rule ----
# A function, so the parse's `shift` does not consume the script's own arguments: the
# private worktree run below is handed them unchanged.
BASE=""
parse_args() {
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
}
parse_args "$@"

if [ -z "$BASE" ]; then
    BASE="${DECLARED_MOVES_BASE:-}"
fi

# --- Guard A: a base ref is REQUIRED --------------------------------------------------
if [ -z "$BASE" ]; then
    echo "FAIL: no base ref given." >&2
    echo >&2
    echo "This proof has NO default base, deliberately. Proving the gate bites against a" >&2
    echo "base nobody declared proves something about that other base, not about the base" >&2
    echo "every declared move is resolved against. Pass a ref positionally," >&2
    echo "via --base, or via DECLARED_MOVES_BASE." >&2
    exit 2
fi

# --- Guard B: the same leading-dash refusal on BOTH routes ----------------------------
case "$BASE" in
    -*)
        echo "FAIL: base ref '${BASE}' starts with '-', which git would read as an option." >&2
        echo "      Pass a real ref via the positional argument, --base, or DECLARED_MOVES_BASE." >&2
        exit 2
        ;;
esac

# --- Guard C: the base ref must resolve -----------------------------------------------
if ! BASE_SHA="$(git rev-parse --verify --quiet "${BASE}^{commit}")"; then
    echo "FAIL: base ref '${BASE}' does not resolve to a commit." >&2
    echo >&2
    echo "A non-vacuity proof against a ref that does not exist would assert nothing and" >&2
    echo "could not tell you so, which is the exact failure mode this script exists to" >&2
    echo "refuse. Pass a real ref." >&2
    exit 2
fi

# --- Into the private worktree --------------------------------------------------------
# After the base is resolved, so a missing or unresolvable base is still exit 2 before any
# worktree exists. In the caller this does not return: it runs this script again inside
# the worktree and exits with that run's code. Inside, it returns and the proof goes on.
prover_run_in_worktree "$@"

# --- Guard D: the gate and its declaration must both be present -----------------------
if [ ! -f "$GATE" ]; then
    echo "FAIL: ${GATE} is not present, so there is no gate to prove." >&2
    exit 2
fi
if [ ! -f "$DECLARATION" ]; then
    echo "FAIL: ${DECLARATION} is not present, so every property below would redden for a" >&2
    echo "      reason that has nothing to do with whether the gate bites." >&2
    exit 2
fi

# --- Guard E: the WHOLE TREE must be clean, with the one carve-out --------------------
# Reported TOGETHER in one message rather than short-circuiting on the first, so a runner
# fixes everything in one pass instead of re-running per file.
#
# The tracked half drops `??` lines, which the untracked half handles with a narrower
# scope; without that filter this would fire on files that live untracked in this repo by
# design, and a guard that cries wolf is one a runner learns to ignore. The path is
# compared EXACTLY against the exempt path rather than by suffix match, so a rename entry
# cannot smuggle a second path through the carve-out.
entry_tracked_dirt() {
    local line path out=""
    while IFS= read -r line; do
        [ -z "$line" ] && continue
        case "$line" in
            '??'*) continue ;;
        esac
        path="${line:3}"
        if [ "$path" = "$GATE_DIRT_EXEMPT" ]; then
            continue
        fi
        out="${out}${line}"$'\n'
    done < <(git status --porcelain)
    printf '%s' "$out"
}

untracked_under_source_trees() {
    git ls-files --others --exclude-standard -- "${SOURCE_TREES[@]}"
}

tracked_dirt="$(entry_tracked_dirt)"
untracked_src="$(untracked_under_source_trees)"

if [ -n "$tracked_dirt" ] || [ -n "$untracked_src" ]; then
    echo "FAIL: the working tree is not clean, so this proof cannot be made." >&2
    echo >&2
    if [ -n "$tracked_dirt" ]; then
        echo "  TRACKED files modified/staged/deleted (anywhere in the tree):" >&2
        printf '%s' "$tracked_dirt" | sed 's/^/    /' >&2
        echo >&2
    fi
    if [ -n "$untracked_src" ]; then
        echo "  UNTRACKED files under a source tree (${SOURCE_TREES[*]}):" >&2
        printf '%s\n' "$untracked_src" | sed 's/^/    /' >&2
        echo >&2
    fi
    echo "Property 1 below (baseline green) would fail for a reason that has NOTHING to" >&2
    echo "do with the gate, and reporting that as 'the gate is vacuous' would send you" >&2
    echo "hunting the wrong bug. So this is exit 2." >&2
    echo >&2
    echo "The ONE exemption is ${GATE_DIRT_EXEMPT} itself, so the gate can be edited live" >&2
    echo "and this proof watched to redden. Everything else must be committed or reverted." >&2
    echo "If one of the paths above is an UNREVERTED PROBE from an earlier run, that is" >&2
    echo "exactly what this guard exists to catch: revert it." >&2
    exit 2
fi

# Whether the gate was ALREADY dirty when this run started. If it was, that edit belongs
# to the caller and this script must neither revert it nor overwrite it: limit 1 of the
# carve-out. It is captured here, before anything is written.
GATE_DIRTY_AT_ENTRY=0
if [ -n "$(git status --porcelain -- "$GATE")" ]; then
    GATE_DIRTY_AT_ENTRY=1
fi

# --- Declaration reading --------------------------------------------------------------
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

# True when `needle` appears as the PATH FIELD of an entry in the named section. Comment
# lines, blank lines and the literal NONE are not entries.
declared_in_section() {
    local section="$1"
    local needle="$2"
    local line first rest
    while IFS= read -r line; do
        [ -z "$line" ] && continue
        case "$line" in
            '#'*) continue ;;
        esac
        [ "$line" = "NONE" ] && continue
        first=""
        rest=""
        read -r first rest <<<"$line"
        if [ "$first" = "$needle" ]; then
            return 0
        fi
    done < <(declaration_section "$section")
    return 1
}

# The golden fixture DIRECTORIES, discovered by their hashes.txt manifest exactly as the
# gate discovers them. This is what makes the classification below MIRROR the gate rather
# than merely resemble it - see path_has_fixture_prefix.
GOLDEN_FIXTURE_DIRS=()
while IFS= read -r golden_dir_line; do
    [ -z "$golden_dir_line" ] && continue
    GOLDEN_FIXTURE_DIRS+=("$golden_dir_line")
done < <(
    LC_ALL=C find "$GOLDEN_ROOT" -mindepth 2 -maxdepth 2 -name 'hashes.txt' -print |
        sed 's#/hashes\.txt$##' | LC_ALL=C sort
)
if [ "${#GOLDEN_FIXTURE_DIRS[@]}" -eq 0 ]; then
    echo "FAIL: no golden fixture directory was discovered under ${GOLDEN_ROOT}, so this" >&2
    echo "      proof cannot classify a covered path and could not be made." >&2
    exit 2
fi

# THE GATE'S BOUNDARY, MIRRORED. Under the golden prefix a path is a FIXTURE only when it
# is inside a directory holding hashes.txt; everything else under that prefix is SOURCE.
# crates/fabrico-core/tests/golden/README.md is the file that boundary is about, and the
# gate names it explicitly at its own covered-source walk.
#
# Treating the bare prefix as sufficient - which this function used to do - put this proof
# and its subject into silent disagreement: the gate called README.md source and covered it,
# this proof called it a fixture and refused to select it as a source probe. The consequence
# was benign only because that one file is never the first candidate; if the gate's boundary
# ever moved, the probe set would drift out of the covered set with no red anywhere. The
# header of this file says such a disagreement "IS a narrowing and must surface as a red",
# so the disagreement is removed rather than tolerated.
path_has_fixture_prefix() {
    local f="$1"
    local prefix d
    case "$f" in
        "$GOLDEN_ROOT"/*)
            for d in "${GOLDEN_FIXTURE_DIRS[@]}"; do
                case "$f" in
                    "$d"/*) return 0 ;;
                esac
            done
            return 1
            ;;
    esac
    for prefix in "${FIXTURE_PREFIXES[@]:1}"; do
        case "$f" in
            "$prefix"*) return 0 ;;
        esac
    done
    return 1
}

# --- Run-time probe selection ---------------------------------------------------------
# See the block in this file's header for why no covered path may be written down here.
select_undeclared_source_probe() {
    local listing f
    listing="$(LC_ALL=C git ls-files -- "${EXPECTED_CRATES[@]}" | LC_ALL=C sort)"
    while IFS= read -r f; do
        [ -z "$f" ] && continue
        if path_has_fixture_prefix "$f"; then
            continue
        fi
        if declared_in_section source "$f"; then
            continue
        fi
        printf '%s\n' "$f"
        return 0
    done <<<"$listing"
    return 1
}

# A golden fixture DIRECTORY is ONE covered path; every other covered fixture path is a
# single file. Directories are discovered by their hashes.txt manifest so a stray
# non-fixture directory cannot join the candidate set.
select_undeclared_fixture_probe() {
    local listing f
    listing="$( {
        LC_ALL=C find "$GOLDEN_ROOT" -mindepth 2 -maxdepth 2 -name 'hashes.txt' -print |
            sed 's#/hashes\.txt$##'
        LC_ALL=C git ls-files -- "${FIXTURE_PREFIXES[1]}" "${FIXTURE_PREFIXES[2]}" "${FIXTURE_PREFIXES[3]}"
    } | LC_ALL=C sort)"
    while IFS= read -r f; do
        [ -z "$f" ] && continue
        if declared_in_section fixtures "$f"; then
            continue
        fi
        printf '%s\n' "$f"
        return 0
    done <<<"$listing"
    return 1
}

# Property 9's probe carries ONE extra requirement the others do not: it must exist AT THE
# BASE. Deleting a path that the base never held moves it out of the working-tree set and
# out of the base set at the same time, so it is covered by neither and the gate is right
# to stay green. Selecting a base-present path is what makes the deletion probe measure the
# union rather than measure nothing.
select_undeclared_deletable_probe() {
    local listing f
    listing="$(LC_ALL=C git ls-files -- "${EXPECTED_CRATES[@]}" | LC_ALL=C sort)"
    while IFS= read -r f; do
        [ -z "$f" ] && continue
        if path_has_fixture_prefix "$f"; then
            continue
        fi
        if declared_in_section source "$f"; then
            continue
        fi
        if ! git cat-file -e "${BASE_SHA}:${f}" 2>/dev/null; then
            continue
        fi
        printf '%s\n' "$f"
        return 0
    done <<<"$listing"
    return 1
}

probe_exhausted() {
    local which="$1"
    local section="$2"
    echo "FAIL: ${which} lost its probe, so the assertion could not be made." >&2
    echo >&2
    echo "Every candidate path this proof could perturb is ALREADY listed in the" >&2
    echo "[${section}] section of ${DECLARATION}. The gate ignores a declared path by" >&2
    echo "design, so perturbing one would produce exit 0 and this proof would read that 0" >&2
    echo "as 'the arm is not enforced' - reddening a gate that is working." >&2
    echo >&2
    echo "This is exit 2 and NOT exit 0: a proof that has run out of things to perturb" >&2
    echo "measured nothing, and a green from it is the vacuous pass this family refuses." >&2
    echo "It is not exit 1 either: no property FAILED, the proof could not be MADE." >&2
    exit 2
}

SOURCE_PROBE=""
if ! SOURCE_PROBE="$(select_undeclared_source_probe)"; then
    probe_exhausted "property 2 (the [source] arm)" source
fi
FIXTURE_PROBE=""
if ! FIXTURE_PROBE="$(select_undeclared_fixture_probe)"; then
    probe_exhausted "properties 3 and 4 (the [fixtures] arm)" fixtures
fi
DELETION_PROBE=""
if ! DELETION_PROBE="$(select_undeclared_deletable_probe)"; then
    echo "FAIL: property 9 (the DELETION arm) lost its probe, so the assertion could not" >&2
    echo "      be made." >&2
    echo >&2
    echo "Every covered source path that exists at '${BASE}' is ALREADY listed in the" >&2
    echo "[source] section of ${DECLARATION}. Deleting a declared path is a declared" >&2
    echo "deletion and the gate is right to exit 0 on it, so this proof would read that 0" >&2
    echo "as 'the deletion arm is not enforced' - reddening a gate that is working." >&2
    echo >&2
    echo "This is exit 2 and NOT exit 0: a proof that has run out of things to delete" >&2
    echo "measured nothing." >&2
    exit 2
fi

# The byte to touch when the fixture probe must be made to DIFFER from the base. For a
# golden fixture DIRECTORY that is its hashes.txt, one of the five files the directory
# digest is taken over; for every other covered path it is the file itself.
if [ -d "$FIXTURE_PROBE" ]; then
    FIXTURE_EDIT_TARGET="${FIXTURE_PROBE}/hashes.txt"
else
    FIXTURE_EDIT_TARGET="$FIXTURE_PROBE"
fi

if [ ! -f "$FIXTURE_EDIT_TARGET" ]; then
    echo "FAIL: the selected fixture probe '${FIXTURE_PROBE}' has no file to perturb" >&2
    echo "      ('${FIXTURE_EDIT_TARGET}' does not exist), so the assertion could not be made." >&2
    exit 2
fi

# An untracked probe path that cannot collide with anything in the tree, built at run time
# so this script carries no literal a future edit might accidentally make real.
UNTRACKED_PROBE="${EXPECTED_CRATES[0]}/src/prover-nonce-$$-$(date +%s).rs"

# --- The kept bytes -------------------------------------------------------------------
# Every path a property below writes has its bytes kept HERE, at entry, after selection and
# before the first probe, and every restore puts those bytes back. Nothing is restored from
# git. An abort part-way needs no restore at all: this whole run is inside a private
# worktree that is removed at exit, so a half-applied probe dies with it. The only cleanup
# left is the two scratch files outside the worktree, registered with the helper rather
# than with a trap of this script's own.
#
# The source probe and the deletion probe are often the same file (both are the first
# undeclared covered source path in sort order), so a path is kept once.
KEPT_PATHS=()
keep_once() {
    local p k
    for p in "$@"; do
        for k in ${KEPT_PATHS[@]+"${KEPT_PATHS[@]}"}; do
            [ "$k" = "$p" ] && continue 2
        done
        prover_keep_bytes "$p"
        KEPT_PATHS+=("$p")
    done
}
keep_once "$DECLARATION" "$LOCKFILE" "$GATE" "$SOURCE_PROBE" "$FIXTURE_EDIT_TARGET" "$DELETION_PROBE"

DECL_TMP=""
GATE_TMP=""
# shellcheck disable=SC2329 # run by the helper's exit trap, through prover_on_exit
remove_scratch_files() {
    if [ -n "$DECL_TMP" ]; then rm -f "$DECL_TMP" 2>/dev/null || true; fi
    if [ -n "$GATE_TMP" ]; then rm -f "$GATE_TMP" 2>/dev/null || true; fi
}
prover_on_exit remove_scratch_files

# --- Helpers --------------------------------------------------------------------------
# Runs the gate at $BASE, capturing combined stdout+stderr and the exit code WITHOUT
# tripping `set -e`. `set -e` would abort on the deliberate exit-1 runs, which are the runs
# this whole script exists to observe.
GATE_OUT=""
GATE_RC=0
run_gate() {
    GATE_OUT=""
    GATE_RC=0
    GATE_OUT="$(bash "$GATE" --base "$BASE" 2>&1)" || GATE_RC=$?
}

# The digest recipe, written out here rather than sourced from the gate, for the same
# reason EXPECTED_CRATES is: this proof must be able to disagree with its subject. Property
# 3 is where a disagreement surfaces - it asserts the gate PRINTS the digest this function
# computed, so the two recipes drifting apart is a named red rather than a quiet pass.
#
# `find . -type f`, not `ls`: `ls` omits dot-files and does not recurse, so a file smuggled
# into a fixture directory left the digest unmoved. The `./` prefix find emits is part of
# the digested text.
prover_digest_of() {
    local p="$1"
    if [ -d "$p" ]; then
        (
            cd "$p" || exit 1
            LC_ALL=C find . -type f -print0 |
                LC_ALL=C sort -z |
                xargs -0 sha256sum |
                sha256sum
        ) | LC_ALL=C awk '{print $1}'
    else
        sha256sum "$p" | LC_ALL=C awk '{print $1}'
    fi
}

# Inserts one entry into the [fixtures] section and drops that section's NONE line, which
# cannot coexist with an entry. Removed again by `unmint`, which puts the declaration's
# kept bytes back; the closing residue assertion is what proves the removal took.
mint_fixture_line() {
    local entry="$1"
    DECL_TMP="$(mktemp)"
    LC_ALL=C awk -v entry="$entry" '
        {
            line = $0
            trimmed = $0
            sub(/^[[:space:]]+/, "", trimmed)
            sub(/[[:space:]]+$/, "", trimmed)
        }
        trimmed ~ /^\[/ {
            in_fixtures = (trimmed == "[fixtures]")
            print line
            if (in_fixtures) { print entry }
            next
        }
        in_fixtures && trimmed == "NONE" { next }
        { print line }
    ' "$DECLARATION" >"$DECL_TMP"
    cat "$DECL_TMP" >"$DECLARATION"
    rm -f "$DECL_TMP"
    DECL_TMP=""
}

unmint() {
    prover_put_back "$DECLARATION"
}

# A probe line that stays a COMMENT in the file it is appended to, so even an abort
# between write and restore leaves a syntactically valid file rather than a broken build.
# The selected source probe is whatever sorts first among the undeclared covered source
# paths, which is not always Rust.
probe_line_for() {
    local f="$1"
    case "$f" in
        *.rs) printf '// %s\n' "$PROBE_TEXT" ;;
        *) printf '# %s\n' "$PROBE_TEXT" ;;
    esac
}

fail_named() {
    printf '      FAIL: %s\n' "$1" >&2
    failed=1
}

# Reads the gate's OWN covered-path list and records every root it no longer names in the
# global MISSING_ROOTS. The array body is read BY BLOCK and comment lines are dropped, so
# the gate's header prose - which names all three crates in English - cannot satisfy this
# on its own. An array that cannot be located at all is exit 2, not a missing root: the
# assertion could not be MADE, and an assertion that silently found nothing to check is
# precisely the vacuous green this family refuses.
#
# The result travels in a GLOBAL rather than on stdout deliberately. A function whose only
# exit-2 path lives inside a `$( )` substitution can only kill the subshell, so the script
# would sail past its own could-not-assert case - which is the exact class of defect this
# file exists to catch, and it would be embarrassing to ship it here.
MISSING_ROOTS=""
compute_missing_roots() {
    local block crate
    MISSING_ROOTS=""
    block="$(sed -n '/^COVERED_CRATES=(/,/^)/p' "$GATE" | grep -v '^[[:space:]]*#' || true)"
    if [ -z "$block" ]; then
        echo "FAIL: could not locate the COVERED_CRATES array in ${GATE}, so the assertion" >&2
        echo "      could not be made." >&2
        echo >&2
        echo "The array was renamed, reformatted, or removed. This is exit 2 rather than" >&2
        echo "exit 1 because the assertion could not be MADE - and an assertion that" >&2
        echo "silently found nothing to check is precisely the vacuous green this whole" >&2
        echo "family of scripts refuses." >&2
        exit 2
    fi
    for crate in "${EXPECTED_CRATES[@]}"; do
        if ! printf '%s\n' "$block" | grep -F "\"${crate}\"" >/dev/null; then
            MISSING_ROOTS="${MISSING_ROOTS}${crate} "
        fi
    done
    if ! grep -qxF "LOCKFILE=\"${LOCKFILE}\"" "$GATE"; then
        MISSING_ROOTS="${MISSING_ROOTS}${LOCKFILE} "
    fi
}

failed=0
STEP=0
# The 9 properties, plus the carve-out case. The carve-out is a case, not a numbered
# property, which is why the step counter and the property numbers were never the same
# sequence. Property 9 (the deletion arm) runs second-to-last so property 8 (clean revert)
# can stay this script's exit condition.
TOTAL=10

step() {
    STEP=$((STEP + 1))
    printf '[%d/%d] %s\n' "$STEP" "$TOTAL" "$1"
}

echo "Proving ${GATE} bites, against '${BASE}' (${BASE_SHA:0:12})."
echo "property 2 probe: ${SOURCE_PROBE}"
echo "property 3/4 probe: ${FIXTURE_PROBE}"
echo "property 9 probe: ${DELETION_PROBE}"
echo

# --- Property 1: baseline green -------------------------------------------------------
step "property 1: BASELINE GREEN (the gate exits 0 over the committed declaration)"
run_gate
if [ "$GATE_RC" -ne 0 ]; then
    fail_named "the gate exited ${GATE_RC} with NO probe applied."
    printf '%s\n' "$GATE_OUT" | sed 's/^/        /' >&2
    echo >&2
    echo "      A red baseline makes every probe below meaningless: the gate would exit" >&2
    echo "      non-zero whether a probe were applied or not. Either the tree is genuinely" >&2
    echo "      dirty against '${BASE}', or the committed declaration does not reconcile." >&2
else
    echo "      baseline: GREEN"
fi

# --- Property 2: the [source] arm bites -----------------------------------------------
step "property 2: the [source] ARM BITES (an undeclared edit to ${SOURCE_PROBE} exits 1 naming it)"
probe_line_for "$SOURCE_PROBE" >>"$SOURCE_PROBE"
run_gate
if [ "$GATE_RC" -eq 0 ]; then
    fail_named "the gate exited 0 with an undeclared edit to a covered source file. THE [source] ARM IS NOT ENFORCED."
elif [ "$GATE_RC" -ne 1 ]; then
    fail_named "the gate exited ${GATE_RC}, not 1. Exit 2 means the assertion could not be MADE, which is a different condition from 'a covered path moved undeclared' and does not prove the gate bites."
    printf '%s\n' "$GATE_OUT" | sed 's/^/        /' >&2
elif ! printf '%s\n' "$GATE_OUT" | grep -F -- "$SOURCE_PROBE" >/dev/null; then
    fail_named "the gate exited 1 but did NOT name '${SOURCE_PROBE}'. An exit code alone cannot tell the source arm firing on this probe from the lockfile check firing on a stray edit."
    printf '%s\n' "$GATE_OUT" | sed 's/^/        /' >&2
else
    echo "      probe present: gate correctly EXITS 1, naming ${SOURCE_PROBE}"
fi
prover_put_back "$SOURCE_PROBE"
if [ -n "$(git status --porcelain -- "$SOURCE_PROBE")" ]; then
    fail_named "'${SOURCE_PROBE}' is still modified after its kept bytes were put back."
fi

# --- Property 3: the digest arm bites -------------------------------------------------
# This case needs a DECLARED entry to exist, and while nothing has moved since the base
# the section holds only NONE, so the proof MINTS one for the duration of the case: it makes
# the probe differ from the base, declares it with a DELIBERATELY WRONG digest, asserts
# the red names the path and BOTH digests, then removes the line and restores the path.
step "property 3: the DIGEST ARM BITES (a declared path whose digest differs exits 1 printing BOTH digests)"
WRONG_DIGEST="0000000000000000000000000000000000000000000000000000000000000000"
printf '\n' >>"$FIXTURE_EDIT_TARGET"
EXPECTED_DIGEST="$(prover_digest_of "$FIXTURE_PROBE")"
mint_fixture_line "${FIXTURE_PROBE} ${WRONG_DIGEST}"
run_gate
if [ "$GATE_RC" -eq 0 ]; then
    fail_named "the gate exited 0 with a declared digest that does not match the bytes on disk. THE DIGEST ARM IS NOT ENFORCED."
elif [ "$GATE_RC" -ne 1 ]; then
    fail_named "the gate exited ${GATE_RC}, not 1, on a digest mismatch."
    printf '%s\n' "$GATE_OUT" | sed 's/^/        /' >&2
elif ! printf '%s\n' "$GATE_OUT" | grep -F -- "$FIXTURE_PROBE" >/dev/null; then
    fail_named "the gate exited 1 but did NOT name '${FIXTURE_PROBE}'."
elif ! printf '%s\n' "$GATE_OUT" | grep -F -- "$WRONG_DIGEST" >/dev/null; then
    fail_named "the gate exited 1 naming the path but did not print the DECLARED digest, so a re-bless would be re-derivation rather than copy-paste."
elif ! printf '%s\n' "$GATE_OUT" | grep -F -- "$EXPECTED_DIGEST" >/dev/null; then
    fail_named "the gate exited 1 but did not print the RECOMPUTED digest ${EXPECTED_DIGEST}, so nothing tells the reader what value to paste - and nothing confirms the gate computes the same digest this proof does."
else
    echo "      digest mismatch: gate correctly EXITS 1, naming the path and both digests"
fi
unmint
prover_put_back "$FIXTURE_EDIT_TARGET"
run_gate
if [ "$GATE_RC" -ne 0 ]; then
    fail_named "the gate exited ${GATE_RC} after the declared content was restored; property 3 must return to green."
    printf '%s\n' "$GATE_OUT" | sed 's/^/        /' >&2
else
    echo "      content restored: GREEN restored"
fi

# --- Property 4: a declared-but-unmoved entry bites -----------------------------------
# The path is left BYTE-UNTOUCHED, because not having moved is the condition under test,
# and the minted line carries the path's ACTUAL CURRENT digest rather than an invented
# one. That correct digest is load-bearing: a wrong one would fire the digest-mismatch arm
# as well, and this red would be property 3's red wearing property 4's name, which is two
# properties proving one thing.
step "property 4: DECLARED BUT UNMOVED (a line naming a path that did not move exits 1 naming it)"
ACTUAL_DIGEST="$(prover_digest_of "$FIXTURE_PROBE")"
mint_fixture_line "${FIXTURE_PROBE} ${ACTUAL_DIGEST}"
run_gate
if [ "$GATE_RC" -eq 0 ]; then
    fail_named "the gate exited 0 with a declaration naming a path that did not move. A STALE ENTRY IS A BLANKET PERMISSION FOR THAT PATH FROM THEN ON."
elif [ "$GATE_RC" -ne 1 ]; then
    fail_named "the gate exited ${GATE_RC}, not 1, on a declared-but-unmoved entry."
    printf '%s\n' "$GATE_OUT" | sed 's/^/        /' >&2
elif ! printf '%s\n' "$GATE_OUT" | grep -F -- "$FIXTURE_PROBE" >/dev/null; then
    fail_named "the gate exited 1 but did NOT name '${FIXTURE_PROBE}'."
elif printf '%s\n' "$GATE_OUT" | grep -F 'DIGEST MISMATCH' >/dev/null; then
    fail_named "the gate reddened through the DIGEST arm, not the unmoved arm, even though the declared digest is the path's actual current digest. This red would be property 3's red wearing property 4's name."
    printf '%s\n' "$GATE_OUT" | sed 's/^/        /' >&2
elif ! printf '%s\n' "$GATE_OUT" | grep -F 'UNMOVED' >/dev/null; then
    fail_named "the gate exited 1 naming the path but did not report it as UNMOVED, so nothing distinguishes this finding from any other red."
    printf '%s\n' "$GATE_OUT" | sed 's/^/        /' >&2
else
    echo "      declared but unmoved: gate correctly EXITS 1, naming ${FIXTURE_PROBE}"
fi
unmint
if [ -n "$(git status --porcelain -- "$DECLARATION")" ]; then
    fail_named "'${DECLARATION}' is still modified after the mint was removed."
fi

# --- Property 5: the untracked walk bites ---------------------------------------------
step "property 5: the UNTRACKED WALK BITES (a new untracked file under a covered path exits 1 naming it)"
printf '// %s\n' "$PROBE_TEXT" >"$UNTRACKED_PROBE"
run_gate
if [ "$GATE_RC" -eq 0 ]; then
    fail_named "the gate exited 0 with an untracked new file under a covered path. A path git has never been told about is invisible to every diff, which is exactly the hole this check exists to close."
elif [ "$GATE_RC" -ne 1 ]; then
    fail_named "the gate exited ${GATE_RC}, not 1, on an untracked file under a covered path."
    printf '%s\n' "$GATE_OUT" | sed 's/^/        /' >&2
elif ! printf '%s\n' "$GATE_OUT" | grep -F -- "$UNTRACKED_PROBE" >/dev/null; then
    fail_named "the gate exited 1 but did NOT name '${UNTRACKED_PROBE}'."
else
    echo "      untracked probe: gate correctly EXITS 1, naming it"
fi
rm -f "$UNTRACKED_PROBE"

# --- Property 6: the lockfile check bites ---------------------------------------------
step "property 6: the LOCKFILE CHECK BITES (a one-byte ${LOCKFILE} edit exits 1)"
printf '\n' >>"$LOCKFILE"
run_gate
if [ "$GATE_RC" -eq 0 ]; then
    fail_named "the gate exited 0 with ${LOCKFILE} changed. A dependency bump changes generated code, and therefore potentially serialized bytes, without touching one line under crates/."
elif [ "$GATE_RC" -ne 1 ]; then
    fail_named "the gate exited ${GATE_RC}, not 1, on a ${LOCKFILE} edit."
    printf '%s\n' "$GATE_OUT" | sed 's/^/        /' >&2
elif ! printf '%s\n' "$GATE_OUT" | grep -F -- "$LOCKFILE" >/dev/null; then
    fail_named "the gate exited 1 but did NOT name '${LOCKFILE}'."
else
    echo "      lockfile probe: gate correctly EXITS 1, naming ${LOCKFILE}"
fi
prover_put_back "$LOCKFILE"

# --- Property 7: the gate's own covered-path list -------------------------------------
# THE BLIND SPOT THIS CLOSES. scripts/ is not a covered path, the gate has no self-hash,
# and nothing else in this repository can see an entry silently dropped from that array.
# The probes above cannot see it either: dropping a crate would simply make a probe under
# it stop reddening, which reads as "the gate is broken" rather than "the gate was
# NARROWED" - and a change that narrowed the list would have every reason to also move the
# probe.
step "property 7: the COVERED LIST HOLDS all four roots (read by block, comments filtered)"
compute_missing_roots
if [ -n "$MISSING_ROOTS" ]; then
    fail_named "${GATE}'s covered set no longer holds all three corpora and the lockfile. Missing: ${MISSING_ROOTS}"
    echo >&2
    echo "      REMOVING AN ENTRY FROM THAT LIST IS THE GATE-WEAKENING MOVE THE GATE'S OWN" >&2
    echo "      HEADER FORBIDS, and NOTHING ELSE IN THIS REPOSITORY CAN SEE IT. scripts/ is" >&2
    echo "      not itself covered, the gate has no self-hash, and a comparison against a" >&2
    echo "      narrowed path set is vacuously empty by construction. The response is to" >&2
    echo "      restore the entry, never to relax this assertion." >&2
else
    echo "      the covered set holds all three corpora and ${LOCKFILE}"
fi

# --- The carve-out case ---------------------------------------------------------------
step "the carve-out: a dirty gate passes the ENTRY GUARD, and property 7 is what reddens"
if [ "$GATE_DIRTY_AT_ENTRY" -eq 1 ]; then
    # The caller edited the gate before starting this run. That edit is theirs, so this
    # case observes it rather than overwriting it, and the closing residue assertion will
    # still name the gate as dirt on the way out.
    echo "      the gate was ALREADY dirty at entry and this run reached here, which is the"
    echo "      carve-out working: the entry guard did not refuse. Live edit left untouched."
    compute_missing_roots
    if [ -z "$MISSING_ROOTS" ]; then
        echo "      the live edit did not narrow the covered set; property 7 above stands."
    else
        echo "      the live edit narrowed the covered set and property 7 above reddened."
    fi
else
    # grep, not `sed -i`: the root being deleted is a PATH, and its slashes would have to
    # be escaped past sed's address delimiter for the pattern to mean what it reads as.
    GATE_TMP="$(mktemp)"
    grep -vF "\"${EXPECTED_CRATES[2]}\"" "$GATE" >"$GATE_TMP" || true
    cat "$GATE_TMP" >"$GATE"
    rm -f "$GATE_TMP"
    GATE_TMP=""
    compute_missing_roots
    if [ -z "$(git status --porcelain -- "$GATE")" ]; then
        fail_named "the carve-out case could not dirty ${GATE}, so it proved nothing."
    elif [ -n "$(entry_tracked_dirt)" ]; then
        fail_named "the entry guard reports tracked dirt with ONLY ${GATE_DIRT_EXEMPT} modified. The carve-out is missing or misapplied, so a live edit to the gate cannot be watched to redden."
    elif ! printf '%s\n' "$MISSING_ROOTS" | grep -F -- "${EXPECTED_CRATES[2]}" >/dev/null; then
        fail_named "with '${EXPECTED_CRATES[2]}' deleted from the gate's covered list, the covered-list assertion did not name it. The narrowing rode in unseen."
    else
        echo "      dirty gate: entry guard proceeds, and the covered-list assertion names ${EXPECTED_CRATES[2]}"
    fi
    prover_put_back "$GATE"
    if [ -n "$(git status --porcelain -- "$GATE")" ]; then
        fail_named "'${GATE}' is still modified after its kept bytes were put back."
    fi
fi

# --- Property 9: the deletion arm bites -----------------------------------------------
# THE BLIND SPOT THIS CLOSES, and it was a live one. Every covered path set the gate built
# was discovered from the WORKING TREE or the INDEX, so a path that existed at the base and
# was GONE today was a member of nothing the gate compared. `git rm` of a whole golden
# fixture directory, of a scenario fixture, or of crates/fabrico-core/src/lib.rs each left
# the gate printing its full green line with every discovery count unchanged. None of
# properties 1 to 8 could see it: every one of them perturbs a path by CHANGING it, and a
# changed path is present on both sides by construction.
#
# It runs here, after the carve-out and before property 8, because property 8 is this
# script's EXIT condition and must stay last. The number 9 is the property's identity, not
# its position.
#
# The probe is deleted with `git rm`, which stages the deletion. It is restored in two
# steps: `git reset -q --` unstages it, which touches only this private worktree's own
# index, and `prover_put_back` writes its kept bytes back to disk. The caller's index never
# sees the deletion. Byte-identity of the restored file is asserted here rather than left
# to property 8:
# property 8 reads `git status`, and a file restored with different bytes but the same
# staged state would read as clean.
step "property 9: THE DELETION ARM BITES (git rm of ${DELETION_PROBE} exits 1 naming it)"
DELETION_PROBE_DIGEST_BEFORE="$(prover_digest_of "$DELETION_PROBE")"
git rm -q "$DELETION_PROBE"
if [ -e "$DELETION_PROBE" ]; then
    fail_named "'${DELETION_PROBE}' is still on disk after 'git rm', so nothing was deleted and this property proved nothing."
else
    run_gate
    if [ "$GATE_RC" -eq 0 ]; then
        fail_named "the gate exited 0 with a covered path DELETED and undeclared. THE DELETION ARM IS NOT ENFORCED: every covered path set is being discovered from the working tree or the index alone, so a path that existed at '${BASE}' and is gone today is a member of nothing the gate compares."
    elif [ "$GATE_RC" -ne 1 ]; then
        fail_named "the gate exited ${GATE_RC}, not 1, on a deleted covered path. Exit 2 means the assertion could not be MADE, which does not prove the deletion arm bites."
        printf '%s\n' "$GATE_OUT" | sed 's/^/        /' >&2
    elif ! printf '%s\n' "$GATE_OUT" | grep -F -- "$DELETION_PROBE" >/dev/null; then
        fail_named "the gate exited 1 but did NOT name '${DELETION_PROBE}'. An exit code alone cannot tell the deletion being caught from some unrelated arm firing."
        printf '%s\n' "$GATE_OUT" | sed 's/^/        /' >&2
    else
        echo "      deleted probe: gate correctly EXITS 1, naming ${DELETION_PROBE}"
    fi
fi
git reset -q -- "$DELETION_PROBE"
prover_put_back "$DELETION_PROBE"
if [ -n "$(git status --porcelain -- "$DELETION_PROBE")" ]; then
    fail_named "'${DELETION_PROBE}' is still dirty after it was unstaged and its kept bytes put back."
elif [ ! -e "$DELETION_PROBE" ]; then
    fail_named "'${DELETION_PROBE}' was not restored to disk after it was unstaged and its kept bytes put back."
elif [ "$(prover_digest_of "$DELETION_PROBE")" != "$DELETION_PROBE_DIGEST_BEFORE" ]; then
    fail_named "'${DELETION_PROBE}' was restored with DIFFERENT bytes than it had before this property ran."
fi

# --- Property 8: clean revert ---------------------------------------------------------
# The entry guard re-run as an EXIT condition, with NO carve-out. Each case above proves
# its OWN probe was restored, but none of them would notice this run having dirtied
# anything else, and the whole reason the entry guard exists is that "I cleaned up" is a
# claim, not evidence.
#
# Inside the private worktree "the tree" is that worktree, back at its entry state: no
# tracked residue, no untracked file under a source tree, and every path whose bytes were
# kept is byte-identical to them.
step "property 8: CLEAN REVERT (this run left the tree exactly as it found it)"
residue_tracked="$(git status --porcelain | grep -v '^??' || true)"
residue_untracked="$(untracked_under_source_trees)"
residue_bytes=""
for kept_path in "${KEPT_PATHS[@]}"; do
    if ! prover_same_as_kept "$kept_path"; then
        residue_bytes="${residue_bytes}${kept_path}"$'\n'
    fi
done
if [ -n "$residue_bytes" ]; then
    fail_named "this run left a probed path with bytes different from those kept at entry."
    printf '%s' "$residue_bytes" | sed 's/^/        /' >&2
fi
if [ -n "$residue_tracked" ] || [ -n "$residue_untracked" ]; then
    fail_named "this run left RESIDUE in the working tree."
    echo >&2
    if [ -n "$residue_tracked" ]; then
        printf '%s\n' "$residue_tracked" | sed 's/^/        /' >&2
    fi
    if [ -n "$residue_untracked" ]; then
        printf '%s\n' "$residue_untracked" | sed 's/^/        /' >&2
    fi
    echo >&2
    echo "      There is NO carve-out here: ${GATE_DIRT_EXEMPT} counts as residue on the" >&2
    echo "      way out even though it is exempt on the way in. If it is named above, a" >&2
    echo "      live edit to the gate is still in the tree - which is expected while a" >&2
    echo "      reviewer watches the proof redden and is a defect anywhere else. Revert" >&2
    echo "      the paths above by hand before doing anything else." >&2
else
    echo "      no residue: the tree is as it was found"
fi

echo
if [ "$failed" -ne 0 ]; then
    echo "NOT PROVEN: at least one property above did not hold. See the named failures." >&2
    exit 1
fi

echo "What held: a green baseline; a NAMED red on an undeclared source edit; a NAMED red"
echo "with BOTH digests on a declared path whose bytes moved elsewhere; a NAMED red on a"
echo "declaration that outlived its move; a NAMED red on an untracked new file; a red on a"
echo "${LOCKFILE} edit; the carve-out; a NAMED red on a DELETED covered path, restored"
echo "byte-identically; and a clean tree on the way out. The covered set still holds, read"
echo "by block with comment lines filtered:"
printf '  %s\n' "${EXPECTED_CRATES[@]}" "$LOCKFILE"
echo
# The last line of a successful run begins with PROVEN:, so a caller can read the verdict
# off the tail without parsing the transcript above it.
echo "PROVEN: ${GATE} bites in all nine ways, against '${BASE}' (${BASE_SHA:0:12})."
exit 0
