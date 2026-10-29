#!/usr/bin/env bash
#
# NON-VACUITY PROOF for the belt-end resolver gate (LINK-11, milestone v9.0 Phase 74).
#
# ---------------------------------------------------------------------------------
# WHY THIS EXISTS. `scripts/check-belt-end-resolver.sh` asserts an ABSENCE - that no
# second definition of a belt end's world cell exists anywhere - and an absence claim is
# worth exactly the proof that it can still fail. This repository's signature defect is a
# check that cannot go red: every plan in phase 74 found at least one, most of them in
# their own new work, and the freeze gate's own prover exists because the seventh such
# check was found in a gate nobody doubted.
#
# So the proof is a COMMITTED SCRIPT THAT RUNS IN CI, not one manual probe recorded in
# prose, and it drives THREE DIFFERENT CHECKS red rather than one. A single probe would
# prove the gate can exit 1; it would not prove that each of the gate's three assertions
# is individually load-bearing, and a gate with one live check and two dead ones reads as
# three times the coverage it has.
#
# ACCEPTANCE IS THIS SCRIPT'S EXIT CODE, NEVER A SOURCE GREP. Same contract
# `scripts/prove-freeze-non-vacuous.sh` and `scripts/determinism-gate-negative-test.sh`
# open with, and it is what stops the probe text below from becoming a self-invalidating
# grep gate.
# ---------------------------------------------------------------------------------
#
# WHAT IS ASSERTED, IN THIS FIXED ORDER:
#
#   0. BASELINE GREEN. With no probe applied the gate exits 0. Re-asserted after EVERY
#      put-back, which is what catches a FAILED ONE in the previous probe instead of
#      carrying it forward into the next probe's result.
#
#   1. PROBE A - A SECOND DEFINITION. A throwaway resolver-shaped function is appended to
#      the core's own source. The gate must exit EXACTLY 1, must name the probe file, and
#      must report BOTH `CHECK A` (the shape scan) and `CHECK B` (the return-shape scan).
#      Both, because they exist to fail on DISJOINT disguises and a probe that only fired
#      one of them would leave the other unproved.
#
#   2. PROBE B - A READER STOPS ASKING. The call inside `dock_still_reaches` is renamed
#      to something the gate does not recognise. The gate must exit 1 and report
#      `CHECK C`. This is the half that catches a future refactor quietly re-deriving the
#      answer at a call site instead of asking for it.
#
#   3. PROBE C - THE SUBJECT DISAPPEARS. The one definition's inner-neighbour derivation
#      is altered so the gate can no longer see any resolver at all. The gate must exit 1
#      and its output must say NO definition was found. THIS IS THE MOST IMPORTANT PROBE
#      IN THE FILE: it is the difference between "no duplication found" and "nothing to
#      look at", and a gate that returned 0 here would be green on a build where the
#      feature had been deleted.
#
#   4. THE FLOORS ARE STILL THE MEASURED ONES. The gate's `MIN_READERS`, `MIN_CALLS` and
#      `MIN_FILES` are extracted from its source, with comment lines filtered out so the
#      gate's own header prose - which discusses those numbers in English - cannot
#      satisfy the check. This closes the gate's structural blind spot, which is the same
#      one `prove-freeze-non-vacuous.sh` records: A GATE CANNOT SEE EDITS TO ITSELF. A
#      later phase that hit CHECK C and "fixed" it by lowering MIN_READERS to 1 would
#      leave every check in the gate passing and nothing in this repository would fire.
#
#   5. NO RESIDUE. The probe file is put back to the bytes kept at entry and asserted
#      byte-identical to them on the way out, and carries no probe marker.
#
# THE BASE REF IS AN ARGUMENT AND THERE IS NO DEFAULT - BUT IT IS ALSO OPTIONAL, AND THE
# DIFFERENCE FROM `prove-freeze-non-vacuous.sh` IS DELIBERATE. That prover's gate is
# DIFF-BASED: it compares the tree against a base, so a proof run without one would be
# proving something about a base nobody declared, and it refuses to start. The gate proved
# here is not diff-based - it reads the tree as it stands - so there is no base to guess
# and none is invented. The argument is accepted so a CI run can RECORD which commit the
# proof was taken at, and it is subjected to the same three refusals (a leading dash on
# either route, more than one ref, a ref that does not resolve) because a proof whose two
# entry points enforce different rules is one refactor away from a real inconsistency.
#
# THE PROOF RUNS IN A PRIVATE WORKTREE (phase 84, plan 84-04, GATE-03), because its probes
# must mutate the ONE definition file by name: the gate reads `state.rs` as its DEF_FILE,
# so no untracked file can stand in for it. Other processes may share this working tree, and the
# earlier version edited `state.rs` in place and restored it from git between probes,
# which would silently discard an edit another process saved to it mid-run. Now
# `prover_run_in_worktree` (scripts/lib/prover-isolation.sh, "Shape B") checks HEAD out
# into a detached worktree outside this checkout, applies the caller's uncommitted tracked
# diff over it, and runs this same script there. Every `sed -i` below edits the
# worktree's copy; every restore puts back the bytes kept at entry. The shared tree, its
# index and any edit in it are never written, and the helper compares them before and
# after to prove it.
#
# NO TREE NEEDS TO BE CLEAN. The kept bytes are HEAD plus the caller's uncommitted edit,
# so an edit in `state.rs` is carried through the proof rather than refused. If the
# baseline is not green for a reason outside the probe, that is reported as exit 2 with
# the gate's own output, not as "the gate is vacuous".
#
# EXIT CODES:
#   0  PROVEN. Three probes drove three different checks red, each was reverted clean, and
#      the gate's floors are still the measured numbers.
#   1  A property did NOT hold. The gate is vacuous, or weaker than claimed. Every failing
#      property is named.
#   2  The proof COULD NOT BE MADE. This is a FAILURE, not a pass:
#        - a base ref starting with '-' on either route, or more than one, or one that
#          does not resolve
#        - the gate script or the probe file is absent
#        - the private worktree could not be made
#        - a put-back did not restore the file
#        - this run left residue behind

set -euo pipefail

# Sourced before any change of directory: the helper records where this script lives.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source-path=SCRIPTDIR source=lib/prover-isolation.sh
. "${SCRIPT_DIR}/lib/prover-isolation.sh"

cd "$(git rev-parse --show-toplevel)"

GATE="scripts/check-belt-end-resolver.sh"

# The probe file. Chosen deliberately: it is the crate and the module the ONE definition
# lives in, so every probe below is the real shape of the regression it stands for - a
# second copy written back into core, a reader that stopped asking, a definition that
# quietly stopped being one. A probe in some other crate would test the gate's file walk
# rather than its assertions.
PROBE_FILE="crates/fabrico-core/src/state.rs"

# The self-identifying throwaway marker. Every probe carries it.
PROBE_MARK="THROWAWAY probe written by scripts/prove-belt-end-resolver-bites.sh. If you are seeing this committed, the proof aborted without reverting - delete it."

usage() {
    cat >&2 <<'USAGE'
usage: scripts/prove-belt-end-resolver-bites.sh [--base <ref> | <ref>]

Proves that scripts/check-belt-end-resolver.sh actually BITES, on three DIFFERENT
assertions rather than one, and that its floors are still the measured numbers.

In a fixed order:
  0. baseline green      - the gate exits 0 with no probe applied
  A. second definition   - the gate exits exactly 1, names the file, reports CHECK A AND B
  B. reader stops asking - the gate exits exactly 1 and reports CHECK C
  C. subject disappears  - the gate exits exactly 1 and says NO definition was found
  4. floors intact       - MIN_READERS, MIN_CALLS and MIN_FILES read out of the gate's
                           source with comments filtered out, so its own prose cannot
                           satisfy the check
  5. no residue          - the probe file is back to its kept bytes, with no marker

  --base <ref>   record which commit the proof was taken at (also --base=<ref>)
  <ref>          the same thing, positionally
  --help, -h     this message

  BELT_RESOLVER_PROOF_BASE   env var; used when no ref is given on the command line

THERE IS NO DEFAULT BASE, and unlike prove-freeze-non-vacuous.sh the ref is OPTIONAL: the
gate proved here is not diff-based, so there is no base to guess and none is invented. A
ref that IS given is refused if it starts with '-', if a second one is given, or if it
does not resolve to a commit.

THE PROOF RUNS IN A PRIVATE WORKTREE (scripts/lib/prover-isolation.sh, Shape B): HEAD
plus this tree's uncommitted tracked edits, outside this checkout. This tree, its index
and any uncommitted edit in it are never written.

Exit codes:
  0  proven
  1  a property did not hold; every failure is named
  2  the proof could not be made (a bad base ref, a missing gate or probe file, a
     worktree that could not be made, a failed put-back, or residue left behind). This
     is a FAILURE, not a pass.
USAGE
}

# --- Argument parsing: the same three routes, with the same leading-dash rule ---------
# In a function, so its shifts leave the script's own arguments intact for the worktree.
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

# Everything below runs inside the private worktree; this call does not return outside it.
prover_run_in_worktree "$@"

if [ -z "$BASE" ]; then
    BASE="${BELT_RESOLVER_PROOF_BASE:-}"
fi

# --- Guard A: the SAME leading-dash refusal on BOTH routes ---------------------------
# Applied even though the ref is optional. An empty ref is "none given"; a ref that starts
# with a dash is a mistake, and a proof that quietly ignored it would report PROVEN about
# a commit nobody named.
if [ -n "$BASE" ]; then
    case "$BASE" in
        -*)
            echo "FAIL: base ref '${BASE}' starts with '-', which git would read as an option." >&2
            echo "      Pass a real ref via the positional argument, --base, or" >&2
            echo "      BELT_RESOLVER_PROOF_BASE." >&2
            exit 2
            ;;
    esac
    if ! BASE_SHA="$(git rev-parse --verify --quiet "${BASE}^{commit}")"; then
        echo "FAIL: base ref '${BASE}' does not resolve to a commit." >&2
        echo "      A proof that recorded a ref which does not exist would be recording" >&2
        echo "      nothing and could not tell you so. Pass a real ref or none at all." >&2
        exit 2
    fi
    echo "Proof taken at ${BASE} (${BASE_SHA})."
else
    echo "Proof taken at the working tree; no base ref recorded (none is required - this"
    echo "gate is not diff-based, so there is no base to guess)."
fi

# --- Guard B: the gate must exist ----------------------------------------------------
if [ ! -f "$GATE" ]; then
    echo "FAIL: ${GATE} is not present, so there is no gate to prove." >&2
    exit 2
fi

# --- Guard C: the probe file must exist, and its bytes are kept ------------------------
if [ ! -f "$PROBE_FILE" ]; then
    echo "FAIL: probe file '${PROBE_FILE}' does not exist." >&2
    echo "      Point this script at another tracked source file in the same crate; do" >&2
    echo "      NOT drop a probe from the proof to make it run." >&2
    exit 2
fi

prover_keep_bytes "$PROBE_FILE"

restore_probe() {
    prover_put_back "$PROBE_FILE"
}

failures=()

# Runs the gate, capturing stdout+stderr and the exit code, without letting a non-zero
# exit kill this script under `set -e`.
GATE_OUT=""
GATE_RC=0
run_gate() {
    set +e
    GATE_OUT="$(bash "$GATE" 2>&1)"
    GATE_RC=$?
    set -e
}

# Asserts baseline green, and says WHY a non-green baseline is exit 2 rather than a
# finding: a probe's redness proves nothing if the tree was already red.
assert_baseline_green() {
    local when="$1"
    run_gate
    if [ "$GATE_RC" -ne 0 ]; then
        echo "FAIL: the gate is not green ${when} (exit ${GATE_RC})." >&2
        echo >&2
        printf '%s\n' "$GATE_OUT" >&2
        echo >&2
        echo "This is exit 2, not exit 1. A probe's redness measures nothing against a" >&2
        echo "baseline that was already red, and reporting it as 'the gate is vacuous'" >&2
        echo "would send the reader hunting the wrong bug." >&2
        exit 2
    fi
}

assert_reverted() {
    restore_probe
    if ! prover_same_as_kept "$PROBE_FILE"; then
        echo "FAIL: '${PROBE_FILE}' was not restored after a probe." >&2
        echo "      The proof cannot continue: every later assertion would be taken on a" >&2
        echo "      tree carrying the previous probe." >&2
        exit 2
    fi
}

# One probe: apply, assert the gate exits EXACTLY 1, assert the output names every string
# in `must_report`, then revert and re-assert green.
#
# EXIT CODE ALONE IS NOT ENOUGH, which is why `must_report` exists. The gate has three
# checks and any of them exiting 1 would satisfy a bare code comparison - so a probe meant
# to prove CHECK C could be satisfied by CHECK A firing for an unrelated reason, and the
# proof would report a check as live while it was dead.
run_probe() {
    local name="$1"
    shift
    local -a must_report=("$@")

    run_gate

    if [ "$GATE_RC" -eq 0 ]; then
        failures+=(
"PROBE ${name}: the gate exited 0 WITH THE PROBE APPLIED. It is vacuous for this
    property: the thing it claims to forbid is present in the tree and it reported green."
        )
        return
    fi
    if [ "$GATE_RC" -ne 1 ]; then
        failures+=(
"PROBE ${name}: the gate exited ${GATE_RC}, expected exactly 1. Exit 2 means the gate
    could not make its assertion at all (a self-test or the corpus floor), which is a
    different failure from the finding this probe is meant to produce."
        )
        return
    fi
    if ! printf '%s' "$GATE_OUT" | grep -F -- "$PROBE_FILE" >/dev/null; then
        failures+=(
"PROBE ${name}: the gate exited 1 but did NOT name '${PROBE_FILE}'. An exit code with no
    path sends the reader looking for a finding they cannot locate, and cannot distinguish
    this probe firing from some unrelated file firing."
        )
    fi
    local needle
    for needle in "${must_report[@]}"; do
        if ! printf '%s' "$GATE_OUT" | grep -F -- "$needle" >/dev/null; then
            failures+=(
"PROBE ${name}: the gate exited 1 but its output does not report '${needle}'.
    The probe was built to drive that specific assertion red. Some OTHER check fired
    instead, so the one under test is still unproved and may be dead."
            )
        fi
    done
}

assert_baseline_green "before any probe was applied"

# =================================================================================
# PROBE A - A SECOND DEFINITION.
#
# A complete, compilable free function at module scope, not a bare comment: CHECK A and
# CHECK B assert things about CODE and a comment cannot drive either red. `BeltTile`,
# `Side` and `crate::edit::BeltEnd` are all in scope in this module, so the probed copy
# still compiles.
# =================================================================================
{
    printf '\n'
    printf '// %s\n' "$PROBE_MARK"
    printf 'pub fn prove_belt_end_resolver_bites_throwaway_probe(\n'
    printf '    geometry: &[BeltTile],\n'
    printf '    end: crate::edit::BeltEnd,\n'
    printf ') -> Option<((i32, i32), Option<Side>)> {\n'
    printf '    let _ = end;\n'
    printf '    let last = geometry.last()?.cell;\n'
    printf '    let inner = geometry.len().checked_sub(2).map(|i| geometry[i].cell);\n'
    printf '    let _ = inner;\n'
    printf '    Some((last, None))\n'
    printf '}\n'
} >>"$PROBE_FILE"

run_probe "A (a second definition)" "CHECK A" "CHECK B"
assert_reverted
assert_baseline_green "after probe A was reverted"

# =================================================================================
# PROBE B - A READER STOPS ASKING.
#
# The call inside `dock_still_reaches` is renamed to a token the gate does not recognise,
# which is the exact shape of the regression CHECK C exists for: a refactor that leaves
# the reader in place but stops it asking the one definition for the answer.
# =================================================================================
CALL_LINE="$(
    awk '
        /fn dock_still_reaches/ { inblock = 1 }
        inblock && /belt_end_world[[:space:]]*\(/ { print FNR; exit }
    ' "$PROBE_FILE"
)"

if [ -z "$CALL_LINE" ]; then
    echo "FAIL: no call to the resolver was found inside dock_still_reaches in ${PROBE_FILE}." >&2
    echo "      Probe B cannot be applied. That is exit 2, not a pass: the baseline was" >&2
    echo "      green, so the gate is claiming a reader that this script cannot locate." >&2
    exit 2
fi

sed -i "${CALL_LINE}s/belt_end_world/belt_end_world_renamed_by_the_probe/" "$PROBE_FILE"
sed -i "${CALL_LINE}i\\        // ${PROBE_MARK}" "$PROBE_FILE"

run_probe "B (a reader stops asking)" "CHECK C"
assert_reverted
assert_baseline_green "after probe B was reverted"

# =================================================================================
# PROBE C - THE SUBJECT DISAPPEARS. The most important probe in this file.
#
# The one definition's single-tile guard pair is altered so the gate's shape scan can no
# longer recognise any resolver at all. The gate must report that NO definition was found
# and exit 1. A gate that exited 0 here would be green on a build where the feature had
# been deleted, which is this repository's named signature defect.
# =================================================================================
sed -i "s/checked_sub(2)/checked_sub(2 + 0)/; s/geometry\\.get(1)/geometry\\.iter()\\.nth(1)/" "$PROBE_FILE"
printf '// %s\n' "$PROBE_MARK" >>"$PROBE_FILE"

run_probe "C (the subject disappears)" "CHECK A" "NO definition"
assert_reverted
assert_baseline_green "after probe C was reverted"

# =================================================================================
# ASSERTION 4 - THE FLOORS ARE STILL THE MEASURED ONES.
#
# The gate's structural blind spot is that it cannot see edits to ITSELF. A later phase
# that hit CHECK C and "fixed" it by dropping MIN_READERS to 1, or that hit the corpus
# floor and dropped MIN_FILES to 0, would leave every check in the gate passing and
# nothing in this repository would fire.
#
# Comment lines are filtered out of this read, so the gate's own header - which discusses
# all three numbers in English, at length - cannot satisfy the check on its own.
# =================================================================================
gate_assignment() {
    grep -vE '^[[:space:]]*#' "$GATE" | grep -E "^${1}=" | head -1 | cut -d= -f2 | tr -d '"'
}

EXPECTED_MIN_READERS=2
EXPECTED_MIN_CALLS=3
MIN_FILES_LOWER_BOUND=100

actual_readers="$(gate_assignment MIN_READERS)"
actual_calls="$(gate_assignment MIN_CALLS)"
actual_files="$(gate_assignment MIN_FILES)"

if [ "$actual_readers" != "$EXPECTED_MIN_READERS" ]; then
    failures+=(
"ASSERTION 4: the gate's MIN_READERS is '${actual_readers}', expected ${EXPECTED_MIN_READERS}.
    TWO is the MEASURED number of named readers that ask the resolver, established three
    times independently (plans 74-02, 74-06 and 74-10). Lowering it would let a reader
    stop asking with nothing firing. RAISING it to 3 is the other error and is the one the
    plan text invites: the remaining two candidate readers - the Unlink arm and belt_docks
    - deliberately do not ask, so a third could only be satisfied by a dead call. If the
    number really changed, change it HERE too, in the same commit, with the measurement."
    )
fi

if [ "$actual_calls" != "$EXPECTED_MIN_CALLS" ]; then
    failures+=(
"ASSERTION 4: the gate's MIN_CALLS is '${actual_calls}', expected ${EXPECTED_MIN_CALLS}.
    Two readers make three call expressions: dock_still_reaches asks once, the Dock
    validate arm asks twice (the carrier's own end, and a belt TARGET's end)."
    )
fi

case "$actual_files" in
    ''|*[!0-9]*)
        failures+=(
"ASSERTION 4: the gate's MIN_FILES could not be read as a number (got '${actual_files}')."
        )
        ;;
    *)
        if [ "$actual_files" -lt "$MIN_FILES_LOWER_BOUND" ]; then
            failures+=(
"ASSERTION 4: the gate's MIN_FILES is ${actual_files}, below ${MIN_FILES_LOWER_BOUND}.
    That floor is the gate's only defence against a truncated discovery walk. Dropped low
    enough, a gate that scanned two files would report 'exactly one definition, no
    re-implementations' and mean nothing by it."
            )
        fi
        ;;
esac

# =================================================================================
# ASSERTION 5 - NO RESIDUE.
# =================================================================================
if ! prover_same_as_kept "$PROBE_FILE"; then
    echo "FAIL: '${PROBE_FILE}' differs from its kept bytes after the last put-back." >&2
    exit 2
fi

if grep -qF -- "$PROBE_MARK" "$PROBE_FILE"; then
    echo "FAIL: a probe marker is still present in '${PROBE_FILE}'." >&2
    echo "      The file equals the bytes kept at entry, so the marker was already in the" >&2
    echo "      tree this proof started from: a probe was COMMITTED, or left in the tree." >&2
    exit 2
fi

# =================================================================================
# The verdict.
# =================================================================================
if [ "${#failures[@]}" -ne 0 ]; then
    echo "FAIL: ${GATE} does not bite as claimed:" >&2
    echo >&2
    for msg in "${failures[@]}"; do
        printf '  - %s\n\n' "$msg" >&2
    done
    exit 1
fi

echo "PROVEN: ${GATE} bites."
echo "  A. a second definition        -> exit 1, CHECK A and CHECK B, file named"
echo "  B. a reader stops asking      -> exit 1, CHECK C, file named"
echo "  C. the subject disappears     -> exit 1, NO definition found, file named"
echo "  4. floors intact              -> MIN_READERS=${actual_readers}, MIN_CALLS=${actual_calls}, MIN_FILES=${actual_files}"
echo "  5. no residue                 -> ${PROBE_FILE} is back to its kept bytes, no probe marker"
exit 0
