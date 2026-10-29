#!/usr/bin/env bash
#
# NON-VACUITY PROOF for the wire-op truth gate (forensic finding A, 2026-09-17;
# hardened by quick 260929-p7p after review of PR #5).
#
# ---------------------------------------------------------------------------------
# WHAT THIS PROVES.
#
# `scripts/check-drawwire-truth.sh` asserts an ABSENCE: that no artifact still claims the
# wire-drawing op is behaviourally dead. An absence claim is worth exactly the proof that
# it can still fail, and a gate can be narrowed in more ways than "it stops recording
# findings". Review of PR #5 found an earlier version of this prover staying PROVEN while
# the window was cut to 13 characters, while five of six crates were dropped from the
# roots, and while a root was silently missing. So this prover checks two things:
#
#   BEHAVIOUR. Real claim shapes are written into UNTRACKED probe files, the gate runs
#   once with all of them present, and it must exit exactly 1 AND name every probe file:
#     A    one line, "the op is dead"
#     B    the same claim split across two comment lines (only the strip-and-join
#          normalization can see it)
#     P20  the doc-comment-above-the-item shape: the dead-word first, then a full stop,
#          then the op name on the next line with no verb between them. This is the
#          historical claim in edit.rs that plan 63-03 corrected, and the shape a
#          narrower, verb-requiring matcher tried in review could not see
#     P35  a hash comment leader in a shell file, with a hyphen and no verb
#     GAP110  the two words about 110 characters apart
#     GAP120  the two words exactly 120 characters apart, the edge of the window
#     EXT  one plain claim per scanned root and extension (.rs under crates, .ts and .tsx
#          under frontend/src, .sh under scripts, .yml under .github), so dropping a root
#          or an extension from the walk leaves a probe unnamed
#
#   CONFIGURATION, read from the gate's code lines (comment lines filtered out). A gate
#   cannot see edits to itself, so these pins are the cover for that blind spot:
#     WINDOW   must be exactly 120
#     ROOTS    must be exactly the four-root list
#     PATTERN  must be the two-way proximity form built from W_OP, W_DEAD and WINDOW
#     W_OP, W_DEAD  must assemble the two search words
#     MIN_FILES     must not fall below 150
#     PORTABLE      no bash-4+ list builtin on a code line (bash 3.2 on the macOS host)
#     COUNT    the gate's "OK: N files" must be at least the count an independent find
#              over the four roots and five extensions returns
#
#   ARM 2, THE WIRE ROUTER'S LOCATION (plan 75-04, CABLE-10). The gate's second arm
#   scans every .rs, .ts and .tsx under crates and frontend/src for needle A (the
#   router's path placed under the core crate) and needle B (the phrase placing the fix
#   inside the core's freeze). This prover covers it with:
#     ROUTER probe  an untracked, nonce-named .ts under frontend/src carrying needle B,
#                   which the single gate run must name as file:line
#     ROUTER-RAN    the green baseline must carry arm 2's `ROUTER-OK:` line, so an arm
#                   that silently stopped running cannot pass
#     ROUTER pins   ROUTER_NEEDLE_PATH and ROUTER_NEEDLE_FREEZE must assemble to the two
#                   needles, and ROUTER_ROOTS must be exactly crates and frontend/src
#
# IT NEVER TOUCHES THE SHARED TREE. An earlier version appended to a tracked source file
# and restored it with `git checkout --`, which would silently discard an uncommitted
# edit another process made to that file mid-run (review WR-04). Every probe here is a
# NEW, nonce-named, untracked file, and since review 84 WR-11 they are written in a
# private worktree: scripts/lib/prover-isolation.sh's Shape B (`prover_run_in_worktree`)
# runs this script again in a detached worktree of HEAD plus the caller's uncommitted
# and untracked files. Written in the shared checkout (Shape A, plan 84-04), the probes
# under crates/ and frontend/src/ were compiled by any other cargo and tsc run in the checkout for
# the length of the run, which turned their gates red for a reason that was not theirs.
# The helper still compares the shared tree before and after.
#
# ACCEPTANCE IS THIS SCRIPT'S EXIT CODE, NEVER A SOURCE GREP.
#
# TOKEN DISCIPLINE. This prover lives in `scripts/`, which the gate scans. Both search
# words are assembled from pieces in every probe string, so this file carries neither as
# a contiguous string and the gate does not flag it. In prose they are "the op" and "the
# dead-word".
#
# THE BASE REF IS AN OPTIONAL ARGUMENT WITH NO DEFAULT. This gate is not diff-based, so
# there is no base to guess and none is invented. A ref that IS given is refused if it
# starts with '-', if more than one is given, or if it does not resolve to a commit.
#
# EXIT CODES:
#   0  PROVEN.
#   1  A property did NOT hold. The gate is vacuous or narrower than pinned, or tracked
#      files changed during the run. Every failing property is named.
#   2  The proof COULD NOT BE MADE. This is a FAILURE, not a pass: a bad base ref, a
#      missing gate, a probe path that already exists, a baseline that is not green (a
#      missing root makes the gate exit 2, which lands here), or residue.

set -euo pipefail

# Sourced before any change of directory: the helper records where this script lives.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source-path=SCRIPTDIR source=lib/prover-isolation.sh
. "${SCRIPT_DIR}/lib/prover-isolation.sh"

cd "$(git rev-parse --show-toplevel)"

GATE="scripts/check-drawwire-truth.sh"

usage() {
    cat >&2 <<'USAGE'
usage: scripts/prove-drawwire-truth-bites.sh [--base <ref> | <ref>]

Proves that scripts/check-drawwire-truth.sh bites on every claim shape and every scanned
root and extension, and that its window, roots, matcher and floor are exactly what they
are pinned to. Writes only untracked, nonce-named probe files, in a private worktree.

  --base <ref>   record which commit the proof was taken at (also --base=<ref>)
  <ref>          the same thing, positionally
  --help, -h     this message

  DRAWWIRE_PROOF_BASE   env var; used when no ref is given on the command line

Exit codes:
  0  proven
  1  a property did not hold; every failure is named
  2  the proof could not be made. This is a FAILURE, not a pass.
USAGE
}

# --- Argument parsing ---------------------------------------------------------------
# Kept whole, for the inner run in the private worktree (the loop below shifts them away).
ORIG_ARGS=("$@")
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
    BASE="${DRAWWIRE_PROOF_BASE:-}"
fi

if [ -n "$BASE" ]; then
    case "$BASE" in
        -*)
            echo "FAIL: base ref '${BASE}' starts with '-', which git would read as an option." >&2
            exit 2
            ;;
    esac
    if ! BASE_SHA="$(git rev-parse --verify --quiet "${BASE}^{commit}")"; then
        echo "FAIL: base ref '${BASE}' does not resolve to a commit." >&2
        exit 2
    fi
    echo "Proof taken at ${BASE} (${BASE_SHA})."
else
    echo "Proof taken at the working tree; no base ref recorded (this gate is not"
    echo "diff-based, so there is no base to guess)."
fi

if [ ! -f "$GATE" ]; then
    echo "FAIL: ${GATE} is not present, so there is no gate to prove." >&2
    exit 2
fi

# --- Into the private worktree (Shape B, review 84 WR-11) ---------------------------
# After the arguments are validated, so a bad ref is still exit 2 before any worktree
# exists. In the caller this does not return; inside the worktree it returns and the
# proof goes on there.
prover_run_in_worktree ${ORIG_ARGS[@]+"${ORIG_ARGS[@]}"}

# --- The two search words and the four roots, assembled from pieces ------------------
OP='draw''wire'
DEAD='in''ert'
R_CRATES='cra''tes'
R_FRONT='front''end/src'
R_SCRIPTS='scr''ipts'
R_GITHUB='.git''hub'

# Arm 2's two needles, assembled from pieces like the words above.
NEEDLE_PATH='crates/fabrico-''core/src/wire_''route.rs'
NEEDLE_FREEZE='inside the core ''freeze'

# --- Probe files: untracked, nonce-named, refused if already present ----------------
NONCE="$$_$(date +%s)_${RANDOM}"
P_A="${R_CRATES}/fabrico-core/src/zz_drawwire_probe_${NONCE}_a.rs"
P_B="${R_CRATES}/fabrico-core/src/zz_drawwire_probe_${NONCE}_b.rs"
P_P20="${R_CRATES}/fabrico-core/src/zz_drawwire_probe_${NONCE}_p20.rs"
P_GAP110="${R_CRATES}/fabrico-core/src/zz_drawwire_probe_${NONCE}_gap110.rs"
P_GAP120="${R_CRATES}/fabrico-core/src/zz_drawwire_probe_${NONCE}_gap120.rs"
P_P35="${R_SCRIPTS}/zz_drawwire_probe_${NONCE}_p35.sh"
P_TS="${R_FRONT}/zz_drawwire_probe_${NONCE}.ts"
P_TSX="${R_FRONT}/zz_drawwire_probe_${NONCE}.tsx"
P_SH="${R_SCRIPTS}/zz_drawwire_probe_${NONCE}.sh"
P_YML="${R_GITHUB}/zz_drawwire_probe_${NONCE}.yml"

PROBE_FILES=("$P_A" "$P_B" "$P_P20" "$P_GAP110" "$P_GAP120" "$P_P35" "$P_TS" "$P_TSX" "$P_SH" "$P_YML")
PROBE_NAMES=("A one line" "B split over two lines" "P20 doc above the item" \
    "GAP110 words 110 apart" "GAP120 words 120 apart" "P35 hash leader" \
    "EXT .ts under frontend/src" "EXT .tsx under frontend/src" \
    "EXT .sh under scripts" "EXT .yml under .github")
P_ROUTER="${R_FRONT}/zz_router_probe_${NONCE}.ts"

for probe in "${PROBE_FILES[@]}" "$P_ROUTER"; do
    if [ ! -d "$(dirname "$probe")" ]; then
        echo "FAIL: probe directory '$(dirname "$probe")' does not exist." >&2
        exit 2
    fi
done

# Inside the private worktree. A probe path that already exists (it could only have been
# carried in as an untracked file) is refused rather than overwritten.
for probe in "${PROBE_FILES[@]}" "$P_ROUTER"; do
    if [ -e "$probe" ] || [ -L "$probe" ]; then
        echo "FAIL: probe path '${probe}' already exists; refusing to overwrite it." >&2
        exit 2
    fi
done

cleanup() {
    local p
    for p in "${PROBE_FILES[@]}" "$P_ROUTER"; do
        rm -f -- "$p"
    done
}
prover_on_exit cleanup

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
        echo "This is exit 2, not exit 1: a probe's redness measures nothing against a" >&2
        echo "baseline that was already red or could not make its assertion." >&2
        exit 2
    fi
}

# --- Baseline, and the independent file count -------------------------------------
assert_baseline_green "before any probe was written"
BASELINE_OUT="$GATE_OUT"

EXPECTED_FILES="$(LC_ALL=C find "$R_CRATES" "$R_FRONT" "$R_SCRIPTS" "$R_GITHUB" -type f \
    \( -name '*.rs' -o -name '*.ts' -o -name '*.tsx' -o -name '*.sh' -o -name '*.yml' \) \
    -print | wc -l | tr -d ' ')"
GATE_FILES="$(printf '%s\n' "$BASELINE_OUT" | sed -n 's/^OK: \([0-9][0-9]*\) files.*/\1/p' | head -1)"
case "$GATE_FILES" in
    ''|*[!0-9]*)
        failures+=(
"COUNT: could not read 'OK: N files' from the gate's green output. A gate that no longer
    reports how much it scanned cannot be checked against the corpus."
        )
        ;;
    *)
        if [ "$GATE_FILES" -lt "$EXPECTED_FILES" ]; then
            failures+=(
"COUNT: the gate scanned ${GATE_FILES} files, but an independent find over the four roots
    and the five extensions returns ${EXPECTED_FILES}. The walk has been narrowed (a root or
    an extension dropped)."
            )
        fi
        ;;
esac

if ! printf '%s\n' "$BASELINE_OUT" | grep '^ROUTER-OK: ' >/dev/null; then
    failures+=(
"ROUTER-RAN: the gate's green output carries no 'ROUTER-OK:' line, so arm 2 (the wire
    router's location) did not run or no longer reports. An arm that stopped running
    reports green for everything it was meant to refuse."
    )
fi

# --- Write every probe --------------------------------------------------------------
MARK="THROWAWAY probe written by the wire-op truth prover; deleted on exit."
FILL110="$(printf '%110s' '' | tr ' ' '-')"
FILL120="$(printf '%120s' '' | tr ' ' '-')"

printf '// %s\n// the %s op is %s this milestone.\n' "$MARK" "$OP" "$DEAD" >"$P_A"

{
    printf '// %s\n' "$MARK"
    printf '// the %s op is\n' "$OP"
    printf '// behaviorally %s this milestone.\n' "$DEAD"
} >"$P_B"

# P20: the historical edit.rs shape. Upper and mixed case on purpose (the gate is -i).
{
    printf '// %s\n' "$MARK"
    printf 'pub enum EditOpProbe {\n'
    printf '    /// existing version-refusal arm only. Behaviorally %s this phase (a fold NOOP);\n' 'IN''ERT'
    printf '    /// transport behavior ships in Phase 37, wiring/routing in Phase 37+.\n'
    printf '    %s {\n' 'Draw''Wire'
    printf '    },\n'
    printf '}\n'
} >"$P_P20"

# The gap probes carry no leader on the claim line: the filler sits directly between the
# two words, so the measured gap is exactly the filler length.
printf '// %s\n%s%s%s\n' "$MARK" "$OP" "$FILL110" "$DEAD" >"$P_GAP110"
printf '// %s\n%s%s%s\n' "$MARK" "$OP" "$FILL120" "$DEAD" >"$P_GAP120"

printf '# %s\n# %s - %s until 63.\n' "$MARK" "$OP" "$DEAD" >"$P_P35"

printf '// %s\n// the %s op is %s this milestone.\n' "$MARK" "$OP" "$DEAD" >"$P_TS"
printf '// %s\n// the %s op is %s this milestone.\n' "$MARK" "$OP" "$DEAD" >"$P_TSX"
printf '# %s\n# the %s op is %s this milestone.\n' "$MARK" "$OP" "$DEAD" >"$P_SH"
printf '# %s\n# the %s op is %s this milestone.\n' "$MARK" "$OP" "$DEAD" >"$P_YML"

# Arm 2's source probe: the false deferral sentence, needle B, on line 2.
printf '// %s\n// the fix is in wire_route.rs, %s.\n' "$MARK" "$NEEDLE_FREEZE" >"$P_ROUTER"

# --- One gate run with every probe present ------------------------------------------
# Each probe is its own file and the gate normalizes and matches each file on its own,
# so one run is equivalent to one run per probe, and names every file that fired.
run_gate

if [ "$GATE_RC" -ne 1 ]; then
    failures+=(
"PROBES: the gate exited ${GATE_RC} with ${#PROBE_FILES[@]} real claims in the corpus, expected
    exactly 1. Exit 0 means it is vacuous for every shape below; exit 2 means it could not
    make its assertion at all."
    )
fi

i=0
while [ "$i" -lt "${#PROBE_FILES[@]}" ]; do
    f="${PROBE_FILES[$i]}"
    # The gate lists each firing file on its own line, indented by two spaces.
    if ! printf '%s\n' "$GATE_OUT" | grep -xF -- "  ${f}" >/dev/null; then
        failures+=(
"PROBE ${PROBE_NAMES[$i]}: the gate did NOT name ${f}. The claim is in the corpus and the
    gate did not see it: this shape, root or extension is no longer covered."
        )
    fi
    i=$((i + 1))
done

if ! printf '%s\n' "$GATE_OUT" | grep -xF -- "  ${P_ROUTER}:2" >/dev/null; then
    failures+=(
"PROBE ROUTER needle B in a .ts under frontend/src: the gate did NOT name ${P_ROUTER}:2.
    The false router-location sentence is in the corpus and arm 2 did not see it."
    )
fi

cleanup
for probe in "${PROBE_FILES[@]}" "$P_ROUTER"; do
    if [ -e "$probe" ]; then
        echo "FAIL: probe '${probe}' still exists after cleanup." >&2
        exit 2
    fi
done

assert_baseline_green "after every probe was removed"

# --- Configuration pins -------------------------------------------------------------
# Read from code lines only, so header prose cannot satisfy a pin.
gate_assignment() {
    grep -vE '^[[:space:]]*#' "$GATE" | grep -E "^${1}=" | head -1 | cut -d= -f2- | tr -d '"'
}

actual_window="$(gate_assignment WINDOW)"
if [ "$actual_window" != "120" ]; then
    failures+=(
"WINDOW: the gate's WINDOW is '${actual_window}', pinned to exactly 120. The gate's own failure
    text forbids narrowing the window to make a finding go away."
    )
fi

EXPECTED_ROOTS="(${R_CRATES} ${R_FRONT} ${R_SCRIPTS} ${R_GITHUB})"
actual_roots="$(gate_assignment ROOTS)"
if [ "$actual_roots" != "$EXPECTED_ROOTS" ]; then
    failures+=(
"ROOTS: the gate's ROOTS reads '${actual_roots}', pinned to exactly '${EXPECTED_ROOTS}'. A
    narrowed or renamed root is a silent exclusion."
    )
fi

EXPECTED_PATTERN='${W_OP}.{0,${WINDOW}}${W_DEAD}|${W_DEAD}.{0,${WINDOW}}${W_OP}'
actual_pattern="$(gate_assignment PATTERN)"
if [ "$actual_pattern" != "$EXPECTED_PATTERN" ]; then
    failures+=(
"PATTERN: the gate's PATTERN reads '${actual_pattern}', pinned to the two-way proximity form
    '${EXPECTED_PATTERN}'. Any extra requirement between the two words (a verb list, a
    sentence bound) loses the doc-above-the-item claim this gate exists to refuse."
    )
fi

if [ "$(gate_assignment W_OP)" != "$OP" ]; then
    failures+=("W_OP: the gate's op word no longer assembles to the op name.")
fi
if [ "$(gate_assignment W_DEAD)" != "$DEAD" ]; then
    failures+=("W_DEAD: the gate's dead-word no longer assembles to the dead-word.")
fi

MIN_FILES_LOWER_BOUND=150
actual_min_files="$(gate_assignment MIN_FILES)"
case "$actual_min_files" in
    ''|*[!0-9]*)
        failures+=("MIN_FILES: could not be read as a number (got '${actual_min_files}').")
        ;;
    *)
        if [ "$actual_min_files" -lt "$MIN_FILES_LOWER_BOUND" ]; then
            failures+=(
"MIN_FILES: the gate's floor is ${actual_min_files}, below ${MIN_FILES_LOWER_BOUND}. That floor is the gate's
    defence against a truncated discovery walk."
            )
        fi
        ;;
esac

BUILTIN_HITS="$(grep -vE '^[[:space:]]*#' "$GATE" | grep -c 'map''file' || true)"
if [ "$BUILTIN_HITS" -ne 0 ]; then
    failures+=(
"PORTABLE: the gate uses a bash-4+ list builtin on ${BUILTIN_HITS} code line(s). It does not exist on
    bash 3.2 (the macOS dev host), where the gate exited 127 before the while-read walk."
    )
fi

if [ "$(gate_assignment ROUTER_NEEDLE_PATH)" != "$NEEDLE_PATH" ]; then
    failures+=("ROUTER_NEEDLE_PATH: arm 2's path needle no longer assembles to needle A.")
fi
if [ "$(gate_assignment ROUTER_NEEDLE_FREEZE)" != "$NEEDLE_FREEZE" ]; then
    failures+=("ROUTER_NEEDLE_FREEZE: arm 2's source needle no longer assembles to needle B.")
fi
EXPECTED_ROUTER_ROOTS="(${R_CRATES} ${R_FRONT})"
actual_router_roots="$(gate_assignment ROUTER_ROOTS)"
if [ "$actual_router_roots" != "$EXPECTED_ROUTER_ROOTS" ]; then
    failures+=(
"ROUTER_ROOTS: arm 2's roots read '${actual_router_roots}', pinned to exactly
    '${EXPECTED_ROUTER_ROOTS}'. A narrowed root lets a moved copy of the claim survive."
    )
fi

# --- The shared tree untouched -------------------------------------------------------
# Checked by the isolation helper in the caller, after this run's verdict: a changed
# tracked status, index or already-dirty file there fails the run and names it.

# --- Verdict ------------------------------------------------------------------------
if [ "${#failures[@]}" -ne 0 ]; then
    echo "FAIL: ${GATE} does not bite as pinned:" >&2
    echo >&2
    for msg in "${failures[@]}"; do
        printf '  - %s\n\n' "$msg" >&2
    done
    exit 1
fi

echo "PROVEN: ${GATE} bites every probe shape and is pinned at full strength."
echo "  probes   -> exit 1, all ${#PROBE_FILES[@]} untracked probe files named:"
i=0
while [ "$i" -lt "${#PROBE_NAMES[@]}" ]; do
    echo "             ${PROBE_NAMES[$i]}"
    i=$((i + 1))
done
echo "  WINDOW=120, ROOTS exact, PATTERN two-way, MIN_FILES=${actual_min_files}, no bash-4 list builtin"
echo "  COUNT    -> gate scanned ${GATE_FILES} files, independent find counts ${EXPECTED_FILES}"
echo "  ROUTER   -> arm 2 ran green at baseline; its probe ${P_ROUTER}:2 named; needles"
echo "              and roots (${R_CRATES} ${R_FRONT}) pinned"
echo "  TRACKED  -> probes written only in the private worktree; the shared tree compared"
echo "              by scripts/lib/prover-isolation.sh at exit"
exit 0
