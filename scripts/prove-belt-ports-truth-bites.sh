#!/usr/bin/env bash
#
# NON-VACUITY PROOF for the belt-ports truth gate (LINK-12, milestone v9.0 Phase 74).
#
# ---------------------------------------------------------------------------------
# WHY THIS EXISTS, AND WHY IT ASSERTS MORE THAN THE PLAN ASKED FOR.
#
# `scripts/check-belt-ports-truth.sh` asserts an ABSENCE - that no artefact still claims a
# belt carries no ports or that two belt runs cannot dock - and an absence claim is worth
# exactly the proof that it can still fail. That much is the standard obligation every
# gate in this milestone carries, and one probe would discharge it.
#
# THIS GATE NEEDS MORE THAN ONE PROBE, because it is not a blunt proximity grep. Its
# matcher has three TUNED parts - present tense only, the object must be the ports
# themselves, and a sentence-scoped qualifier exemption - and each of those is a place a
# gate can be made to stop biting without anyone noticing. In particular THE QUALIFIER
# EXEMPTION IS THE DANGEROUS ONE: it is the gate's own escape hatch, and a later phase
# that hit a finding could make it disappear by adding one word to the qualifier list
# rather than by correcting the claim. Every check in the gate would still pass.
#
# So four probes and two structural assertions, not one probe:
#
#   0. BASELINE GREEN. Re-asserted after every put-back, which catches a FAILED ONE in
#      the previous probe instead of carrying it into the next probe's result.
#
#   1. PROBE A - THE PORTLESS CLAIM, PRESENT TENSE, ON ONE LINE. The plain shape.
#
#   2. PROBE B - THE SAME CLAIM SPLIT ACROSS TWO COMMENT LINES. This is the shape the
#      precedent gate's ORIGINAL single-line version could not see, which was found by
#      reading rather than by the gate. A successor that could not see it either would be
#      ceremony. `.` does not match a newline, so only the strip-and-join normalization
#      makes this catchable, and this probe is what proves that normalization is live.
#
#   3. PROBE C - THE CANNOT-DOCK CLAIM. The gate's second pattern, which probes A and B
#      leave entirely untested. Without this, the dock half could be dead and the proof
#      would still report PROVEN off the ports half.
#
#   4. PROBE D - THE CLAIM INSIDE THE README. The corpus includes the root README.md
#      (ruling R-05), and a corpus entry nothing ever probes is a corpus entry that can be
#      silently dropped. This probe is what makes the README's membership real rather
#      than declared.
#
#   5. ASSERTION 5 - THE QUALIFIER EXEMPTION IS STILL NARROW. The gate's list of temporal
#      qualifiers is extracted from its source, with comment lines filtered out so the
#      gate's own header prose - which discusses the exemption at length - cannot satisfy
#      the check. The list must not have grown past a stated ceiling, and it must not
#      contain any of a set of words that would turn it into a blanket.
#
#   6. ASSERTION 6 - THE CORPUS AND ITS FLOOR ARE INTACT. `MIN_FILES`, the two `ROOTS`,
#      and the README's presence in `EXTRA_FILES`. Same blind spot as every other gate in
#      this repository: A GATE CANNOT SEE EDITS TO ITSELF.
#
# ACCEPTANCE IS THIS SCRIPT'S EXIT CODE, NEVER A SOURCE GREP - the same contract
# `scripts/prove-freeze-non-vacuous.sh` opens with, and what stops the probe text below
# from becoming a self-invalidating grep gate.
#
# THE BASE REF IS AN ARGUMENT WITH NO DEFAULT, AND IT IS OPTIONAL. Same reasoning as
# `scripts/prove-belt-end-resolver-bites.sh`: the gate proved here is not diff-based, so
# there is no base to guess and none is invented. A ref that IS given is subjected to the
# same three refusals - a leading dash on either route, more than one, one that does not
# resolve - because a proof whose two entry points enforce different rules is one refactor
# away from a real inconsistency.
#
# THE PROOF RUNS IN A PRIVATE WORKTREE (phase 84, plan 84-04, GATE-03). Other processes may
# share this working tree. The earlier version appended its probes to the two tracked files below
# and restored them from git after each probe, which would silently discard an edit
# another process saved to either file mid-run. Now `prover_run_in_worktree` (from
# scripts/lib/prover-isolation.sh, "Shape B") checks HEAD out into a detached worktree
# outside this checkout, applies the caller's uncommitted tracked diff over it, and runs
# this same script there; every probe is written into the worktree's copies, and every
# restore puts back the bytes kept at entry. The shared tree, its index and any edit in it
# are never written, and the helper compares them before and after to prove it.
#
# WHY NOT UNTRACKED PROBE FILES ("Shape A"). The Rust probes could live in a new untracked
# .rs file, because the gate walks every file under `crates`. Probe D cannot: the gate
# reads the README only as a FIXED PATH in its EXTRA_FILES, so no new file can stand in
# for it, and the claim has to be written into that tracked file itself.
#
# EXIT CODES:
#   0  PROVEN.
#   1  A property did NOT hold. The gate is vacuous, or weaker than claimed. Every failing
#      property is named.
#   2  The proof COULD NOT BE MADE. This is a FAILURE, not a pass: a bad base ref, a
#      missing gate or probe file, a worktree that could not be made, a failed put-back,
#      or residue left behind.

set -euo pipefail

# Sourced before any change of directory: the helper records where this script lives.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source-path=SCRIPTDIR source=lib/prover-isolation.sh
. "${SCRIPT_DIR}/lib/prover-isolation.sh"

cd "$(git rev-parse --show-toplevel)"

GATE="scripts/check-belt-ports-truth.sh"

# The probe files, one per corpus ROOT plus the EXTRA_FILES entry. Chosen so that between
# them every part of the corpus declaration is exercised: a Rust source root, and the
# root README ruling R-05 pulls in.
PROBE_RS="crates/fabrico-core/src/state.rs"
PROBE_MD="README.md"

PROBE_MARK="THROWAWAY probe written by scripts/prove-belt-ports-truth-bites.sh. If you are seeing this committed, the proof aborted without reverting - delete this line."

usage() {
    cat >&2 <<'USAGE'
usage: scripts/prove-belt-ports-truth-bites.sh [--base <ref> | <ref>]

Proves that scripts/check-belt-ports-truth.sh actually BITES, on four different claim
shapes rather than one, and that its qualifier exemption and its corpus are still what
they say they are.

In a fixed order:
  0. baseline green    - the gate exits 0 with no probe applied
  A. portless claim    - one line, present tense       -> exit 1, file named
  B. the same, SPLIT   - across two comment lines      -> exit 1, file named
  C. cannot-dock claim - the gate's second pattern     -> exit 1, file named
  D. claim in the README - the R-05 corpus entry       -> exit 1, file named
  5. exemption narrow  - the qualifier list has not become a blanket
  6. corpus intact     - MIN_FILES, both ROOTS, and the README in EXTRA_FILES
  7. no residue        - both probe files back to their kept bytes, no marker

  --base <ref>   record which commit the proof was taken at (also --base=<ref>)
  <ref>          the same thing, positionally
  --help, -h     this message

  BELT_PORTS_PROOF_BASE   env var; used when no ref is given on the command line

THERE IS NO DEFAULT BASE, and the ref is OPTIONAL: this gate is not diff-based, so there
is no base to guess. A ref that IS given is refused if it starts with '-', if a second one
is given, or if it does not resolve to a commit.

THE PROOF RUNS IN A PRIVATE WORKTREE (scripts/lib/prover-isolation.sh, Shape B): HEAD
plus this tree's uncommitted tracked edits, outside this checkout. This tree, its index
and any uncommitted edit in it are never written.

Exit codes:
  0  proven
  1  a property did not hold; every failure is named
  2  the proof could not be made. This is a FAILURE, not a pass.
USAGE
}

# --- Argument parsing ---------------------------------------------------------------
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
    BASE="${BELT_PORTS_PROOF_BASE:-}"
fi

# --- Guard A: the SAME leading-dash refusal on BOTH routes ---------------------------
if [ -n "$BASE" ]; then
    case "$BASE" in
        -*)
            echo "FAIL: base ref '${BASE}' starts with '-', which git would read as an option." >&2
            echo "      Pass a real ref via the positional argument, --base, or" >&2
            echo "      BELT_PORTS_PROOF_BASE." >&2
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

# --- Guard C: every probe file must exist, and its bytes are kept ---------------------
# The kept bytes are what every restore below puts back: the worktree's copy as it was at
# entry, which is HEAD plus the caller's uncommitted edit, if any. So an uncommitted edit
# in a probe file no longer stops the proof; it is carried through it.
PROBE_FILES=("$PROBE_RS" "$PROBE_MD")

for probe in "${PROBE_FILES[@]}"; do
    if [ ! -f "$probe" ]; then
        echo "FAIL: probe file '${probe}' does not exist." >&2
        echo "      Point this script at another tracked file in the same corpus root; do" >&2
        echo "      NOT drop a probe, which is how a four-shape proof becomes a three-" >&2
        echo "      shape one with the same PROVEN line at the end." >&2
        exit 2
    fi
done

prover_keep_bytes "${PROBE_FILES[@]}"

restore_probes() {
    prover_put_back "${PROBE_FILES[@]}"
}

failures=()

GATE_OUT=""
GATE_RC=0
run_gate() {
    set +e
    GATE_OUT="$(bash "$GATE" 2>&1)"
    GATE_RC=$?
    set -e
}

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
    restore_probes
    local p
    for p in "${PROBE_FILES[@]}"; do
        if ! prover_same_as_kept "$p"; then
            echo "FAIL: '${p}' was not restored after a probe." >&2
            echo "      The proof cannot continue: every later assertion would be taken on" >&2
            echo "      a tree carrying the previous probe." >&2
            exit 2
        fi
    done
}

# One probe: assert the gate exits EXACTLY 1 and NAMES the file the probe went into.
#
# NAMING MATTERS AS MUCH AS THE EXIT CODE. This gate scans five hundred files; an exit of
# 1 could come from any of them, so a probe verified by exit code alone could be satisfied
# by a finding somewhere else entirely and the shape under test would stay unproved.
run_probe() {
    local name="$1" file="$2"

    run_gate

    if [ "$GATE_RC" -eq 0 ]; then
        failures+=(
"PROBE ${name}: the gate exited 0 WITH THE CLAIM PRESENT in ${file}. It is vacuous for
    this shape: the exact sentence it exists to forbid is in the corpus and it reported
    green."
        )
        return
    fi
    if [ "$GATE_RC" -ne 1 ]; then
        failures+=(
"PROBE ${name}: the gate exited ${GATE_RC}, expected exactly 1. Exit 2 means the gate could
    not make its assertion at all (a self-test or the corpus floor), which is a different
    failure from the finding this probe is meant to produce."
        )
        return
    fi
    if ! printf '%s' "$GATE_OUT" | grep -F -- "$file" >/dev/null; then
        failures+=(
"PROBE ${name}: the gate exited 1 but did NOT name '${file}'. This gate scans hundreds of
    files, so an exit code with no path cannot distinguish this probe firing from an
    unrelated finding elsewhere in the corpus."
        )
    fi
}

assert_baseline_green "before any probe was applied"

# =================================================================================
# PROBE A - the portless claim, present tense, on one line.
#
# Assembled from pieces, exactly as the gate's own patterns are, so this script's SOURCE
# does not carry the claim as a contiguous string. If `scripts/` is ever added to the
# gate's corpus, this prover does not become a finding.
# =================================================================================
printf '// %s A b%s carries no p%s.\n' "$PROBE_MARK" 'elt' 'orts' >>"$PROBE_RS"
run_probe "A (portless claim, one line)" "$PROBE_RS"
assert_reverted
assert_baseline_green "after probe A was reverted"

# =================================================================================
# PROBE B - the SAME claim split across two comment lines.
#
# The shape the precedent gate's original version could not see. `.` does not match a
# newline, so this is invisible to any line-oriented matcher and only the strip-and-join
# normalization catches it.
# =================================================================================
{
    printf '// %s\n' "$PROBE_MARK"
    printf '// A b%s carries\n' 'elt'
    printf '// no p%s.\n' 'orts'
} >>"$PROBE_RS"
run_probe "B (portless claim, split across two lines)" "$PROBE_RS"
assert_reverted
assert_baseline_green "after probe B was reverted"

# =================================================================================
# PROBE C - the cannot-dock claim. The gate's SECOND pattern, which A and B leave
# entirely untested: without this probe the dock half could be dead and this script would
# still print PROVEN off the ports half.
# =================================================================================
printf '// %s Two b%s runs cannot d%s to each other.\n' "$PROBE_MARK" 'elt' 'ock' >>"$PROBE_RS"
run_probe "C (cannot-dock claim)" "$PROBE_RS"
assert_reverted
assert_baseline_green "after probe C was reverted"

# =================================================================================
# PROBE D - the claim inside the root README.
#
# Ruling R-05 put the README in the corpus. A corpus entry that nothing ever probes is
# one that can be quietly dropped from EXTRA_FILES with every check still passing, and the
# README is the single document most likely to be quoted back.
# =================================================================================
printf -- '- %s A b%s carries no p%s.\n' "$PROBE_MARK" 'elt' 'orts' >>"$PROBE_MD"
run_probe "D (the claim in the README, ruling R-05)" "$PROBE_MD"
assert_reverted
assert_baseline_green "after probe D was reverted"

# =================================================================================
# ASSERTION 5 - THE QUALIFIER EXEMPTION IS STILL NARROW.
#
# The gate's escape hatch, and therefore the easiest place to make it stop biting without
# touching a single check. A phase that hit a finding could add one broad word here and
# every assertion in the gate would still pass.
#
# Comment lines are filtered out of this read so the gate's own header - which discusses
# the exemption at length and quotes example qualifiers in English - cannot satisfy it.
# =================================================================================
gate_assignment() {
    grep -vE '^[[:space:]]*#' "$GATE" | grep -E "^${1}=" | head -1 | cut -d= -f2- | tr -d '"'
}

QUALIFIER_LIST="$(gate_assignment W_QUALIFIER)"

if [ -z "$QUALIFIER_LIST" ]; then
    failures+=(
"ASSERTION 5: the gate's W_QUALIFIER could not be read from its source."
    )
else
    # Written with the same piece-assembly the gate uses, so this list is not itself a
    # contiguous copy of the thing it is checking for.
    QUALIFIER_COUNT="$(printf '%s' "$QUALIFIER_LIST" | tr '|' '\n' | grep -c . || true)"
    QUALIFIER_CEILING=24
    if [ "$QUALIFIER_COUNT" -gt "$QUALIFIER_CEILING" ]; then
        failures+=(
"ASSERTION 5: the gate's qualifier exemption now lists ${QUALIFIER_COUNT} phrases, above the
    ceiling of ${QUALIFIER_CEILING}. The exemption exists so a RECORD of what used to be true can be
    written in the present tense when it is scoped to the past in the same sentence. Every
    phrase added to it is a sentence the gate stops reading. If a real record needs a new
    qualifier, add it AND raise this ceiling here, in the same commit, with the sentence
    that needed it."
        )
    fi

    # Words that would turn the exemption into a blanket: they appear in ordinary prose
    # about belts and ports constantly, so any one of them would exempt most of the corpus.
    for banned in 'b''elt' 'p''ort' 'd''ock' 'the' 'a' 'is' 'not'; do
        if printf '%s' "$QUALIFIER_LIST" | tr '|' '\n' | grep -ixF -- "$banned" >/dev/null; then
            failures+=(
"ASSERTION 5: the gate's qualifier exemption contains '${banned}', which is not a temporal
    qualifier and appears in ordinary prose throughout this corpus. One entry like that
    exempts most of the corpus and the gate goes green on everything while every one of
    its self-tests still passes."
            )
        fi
    done
fi

# =================================================================================
# ASSERTION 6 - THE CORPUS AND ITS FLOOR ARE INTACT.
# =================================================================================
MIN_FILES_LOWER_BOUND=300
actual_min_files="$(gate_assignment MIN_FILES)"

case "$actual_min_files" in
    ''|*[!0-9]*)
        failures+=(
"ASSERTION 6: the gate's MIN_FILES could not be read as a number (got '${actual_min_files}')."
        )
        ;;
    *)
        if [ "$actual_min_files" -lt "$MIN_FILES_LOWER_BOUND" ]; then
            failures+=(
"ASSERTION 6: the gate's MIN_FILES is ${actual_min_files}, below ${MIN_FILES_LOWER_BOUND}.
    That floor is the gate's only defence against a truncated discovery walk. Dropped low
    enough, a gate that scanned two files would report 'no surviving claim' and mean
    nothing by it."
            )
        fi
        ;;
esac

ROOTS_LINE="$(gate_assignment ROOTS)"
for root in 'cra''tes' 'front''end'; do
    if ! printf '%s' "$ROOTS_LINE" | grep -F -- "$root" >/dev/null; then
        failures+=(
"ASSERTION 6: the gate's ROOTS no longer names '${root}' (reads: ${ROOTS_LINE}).
    LINK-12 covers both source trees. Dropping one is a silent exclusion, and a silent
    exclusion is a hole - the gate would report a clean corpus about half of one."
        )
    fi
done

EXTRA_LINE="$(gate_assignment EXTRA_FILES)"
if ! printf '%s' "$EXTRA_LINE" | grep -F -- "$PROBE_MD" >/dev/null; then
    failures+=(
"ASSERTION 6: the gate's EXTRA_FILES no longer names '${PROBE_MD}' (reads: ${EXTRA_LINE}).
    Ruling R-05 put the root README INSIDE the corpus, on the reasoning that scoping the
    gate to code only would silently exclude the one artefact most likely to be quoted
    back. Probe D above is the running half of that ruling; this
    is the structural half."
    )
fi

# =================================================================================
# ASSERTION 7 - NO RESIDUE.
# =================================================================================
for probe in "${PROBE_FILES[@]}"; do
    if ! prover_same_as_kept "$probe"; then
        echo "FAIL: '${probe}' differs from its kept bytes after the last put-back." >&2
        exit 2
    fi
    if grep -qF -- "$PROBE_MARK" "$probe"; then
        echo "FAIL: a probe marker is still present in '${probe}'." >&2
        echo "      The file equals the bytes kept at entry, so the marker was already in the" >&2
        echo "      tree this proof started from: a probe was COMMITTED, or left in the tree." >&2
        exit 2
    fi
done

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
echo "  A. portless claim, one line          -> exit 1, ${PROBE_RS} named"
echo "  B. portless claim, split over lines  -> exit 1, ${PROBE_RS} named"
echo "  C. cannot-dock claim                 -> exit 1, ${PROBE_RS} named"
echo "  D. claim in the README (R-05)        -> exit 1, ${PROBE_MD} named"
echo "  5. exemption narrow                  -> ${QUALIFIER_COUNT} qualifiers, none of them a blanket"
echo "  6. corpus intact                     -> MIN_FILES=${actual_min_files}, ROOTS and EXTRA_FILES unchanged"
echo "  7. no residue                        -> both probe files back to their kept bytes, no marker"
exit 0
