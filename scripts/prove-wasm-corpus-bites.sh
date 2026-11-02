#!/usr/bin/env bash
#
# Proof that the wasm corpus gate can fail.
#
# WHY THIS SCRIPT EXISTS. scripts/check-wasm-corpus.sh is green at each commit where the wasm build
# matches native, and a gate nobody has seen go red looks the same as one that can't. This script
# edits the fixtures in a private worktree, runs the gate, and requires the exit code and the named
# fixture each case calls for. A red has to name its fixture, so a build failure can't pass as one.
#
# It picks its probes from what's on disk at run time, so a renamed fixture can't make it skip one.
#
# THE PROPERTIES, in order:
#   1. BASELINE GREEN. With nothing changed the gate exits 0, and its counts equal ones this script
#      takes itself. A red baseline makes the rest meaningless, so it's exit 2.
#   2. A CORRUPTED HASH. The last character of the last line of a fixture's hashes.txt changes. The
#      gate exits 1 and names the fixture and its last tick.
#   3. A DROPPED GOLDEN FIXTURE. The gate exits 1, its count reads one short, and it names the
#      fixture.
#   4. A DROPPED SCENARIO FIXTURE. The same, for one .postcard file.
#   5. AN EXTRA GOLDEN FIXTURE. A fixture copied to a new name. The gate exits 1, its count reads one
#      over, and it names the copy, so the count fails in both directions.
#   6. A NATIVE DISAGREEMENT ON A SCENARIO TICK. A copy of the native report with the last character
#      of one scenario line changed. The gate exits 1 and names the fixture and tick. A scenario
#      stores one hash, so this is the scenario half's per-tick proof. A second copy with one
#      fixture's fault count raised by 1 has to exit 1 and name that fixture's two counts, so a
#      fixture faulting on one target alone can't pass.
#   7. A SHORT HASHES FILE. A fixture's last hash line is deleted. The gate exits 1 and names the
#      fixture, because its meta.toml still says the fixture has that tick.
#   8. NOTHING TO COMPARE. The gate exits 2 with no module, with no native tool, with a named report
#      that doesn't exist, with an empty walk of either family and with a native count of zero.
#
# After the last property it puts every file back and requires the gate to exit 0 again.
#
# The clock comparison isn't here. Watching it fail needs a harness that reads the clock, and that's
# a second wasm build on each run.
#
# This prover uses prebuilt artifacts and runs no cargo command, so a CI run doesn't compile the
# workspace once per prover. Build first with scripts/build-wasm.sh. The gate writes its reports to
# a private copy of the artifacts, so the caller's stay as they were.
#
# ENVIRONMENT
#   FABRICO_WASM_OUT  where the harness module and the native tool are. It has to be an absolute
#                     path, because the gate runs from a private worktree.
#
# EXIT CODES
#   0  every property held. The final line begins `PROVEN:`.
#   1  at least one property did not hold, and the failing one is named.
#   2  the proof could not be made: an argument was passed, FABRICO_WASM_OUT isn't absolute, an
#      artifact is missing, the fixtures aren't there to probe, or the baseline is red.
#
# Usage:  FABRICO_WASM_OUT=<absolute dir> bash scripts/prove-wasm-corpus-bites.sh

set -euo pipefail

# Sourced before any change of directory: the helper records where this script lives.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source-path=SCRIPTDIR source=lib/prover-isolation.sh
. "${SCRIPT_DIR}/lib/prover-isolation.sh"

cd "$(git rev-parse --show-toplevel)"

GATE="scripts/check-wasm-corpus.sh"
GOLDEN_ROOT="crates/fabrico-core/tests/golden"
RECORD_FILE="crates/fabrico-core/tests/cert_cross_platform.rs"
SCENARIO_ROOT="crates/fabrico-scenario/fixtures"
SNAPSHOT_ROOT="crates/fabrico-scenario/snapshots"
EXTRA_SUFFIX="-extra-probe"

if [ "$#" -ne 0 ]; then
    echo "FAIL: this proof takes no arguments (got: $*)." >&2
    exit 2
fi

case "${FABRICO_WASM_OUT:-}" in
    /*) ;;
    *)
        echo "FAIL: FABRICO_WASM_OUT is '${FABRICO_WASM_OUT:-}', and it has to be an absolute path." >&2
        exit 2
        ;;
esac
MODULE="${FABRICO_WASM_OUT}/fabrico_wasm_corpus.wasm"
NATIVE_TOOL="${FABRICO_WASM_OUT}/corpus_native"
if [ ! -s "$MODULE" ] || [ ! -x "$NATIVE_TOOL" ]; then
    echo "FAIL: ${MODULE} or ${NATIVE_TOOL} is missing. Run scripts/build-wasm.sh first." >&2
    exit 2
fi

# --- Into the private worktree -------------------------------------------------------
prover_run_in_worktree "$@"

export LC_ALL=C

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/fabrico-wasm-corpus.XXXXXX")"
cleanup() {
    rm -rf "$SCRATCH"
}
prover_on_exit cleanup

# The gate writes its reports beside the module, so it gets a private copy of both.
OUT="${SCRATCH}/out"
mkdir "$OUT" "${SCRATCH}/empty-dir" "${SCRATCH}/no-tool"
cp "$MODULE" "$NATIVE_TOOL" "$OUT/"
cp "$MODULE" "${SCRATCH}/no-tool/"

# --- The probes, chosen from what's on disk -------------------------------------------
GOLDEN_NAMES=()
for dir in "$GOLDEN_ROOT"/*/; do
    if [ -f "${dir}meta.toml" ]; then
        GOLDEN_NAMES+=("$(basename "$dir")")
    fi
done
if [ "${#GOLDEN_NAMES[@]}" -lt 2 ]; then
    echo "FAIL: ${GOLDEN_ROOT} holds ${#GOLDEN_NAMES[@]} fixture(s), and this needs at least 2." >&2
    exit 2
fi
EDITED_GOLDEN="${GOLDEN_NAMES[0]}"
DROPPED_GOLDEN="${GOLDEN_NAMES[$((${#GOLDEN_NAMES[@]} - 1))]}"
EDITED_HASHES="${GOLDEN_ROOT}/${EDITED_GOLDEN}/hashes.txt"
DROPPED_DIR="${GOLDEN_ROOT}/${DROPPED_GOLDEN}"

SCENARIO_NAMES=()
for file in "$SCENARIO_ROOT"/*.postcard; do
    if [ -f "$file" ]; then
        SCENARIO_NAMES+=("$(basename "$file" .postcard)")
    fi
done
if [ "${#SCENARIO_NAMES[@]}" -lt 1 ]; then
    echo "FAIL: ${SCENARIO_ROOT} holds no .postcard file." >&2
    exit 2
fi
DROPPED_SCENARIO="${SCENARIO_NAMES[0]}"
DROPPED_POSTCARD="${SCENARIO_ROOT}/${DROPPED_SCENARIO}.postcard"

if [ ! -s "$EDITED_HASHES" ] || [ ! -f "$RECORD_FILE" ]; then
    echo "FAIL: ${EDITED_HASHES} or ${RECORD_FILE} isn't there to probe." >&2
    exit 2
fi

DROPPED_FILES=("$DROPPED_DIR"/*)
prover_keep_bytes "$EDITED_HASHES" "$DROPPED_POSTCARD" "$RECORD_FILE" "${DROPPED_FILES[@]}"

# The counts this script expects, taken without the gate's help.
GOLDEN_RECORDS="$(grep -c '^ *Fixture {$' "$RECORD_FILE")"
SNAP_FILES=("$SNAPSHOT_ROOT"/*.snap)
SCENARIO_RECORDS="${#SNAP_FILES[@]}"
HASH_LINES="$(wc -l <"$EDITED_HASHES")"
HASH_LINES=$((HASH_LINES))
LAST_HASH_TICK=$((HASH_LINES - 1))

# --- Helpers --------------------------------------------------------------------------
GATE_RC=0
GATE_OUTPUT=""
run_gate() {
    local out_dir="$1"
    shift
    GATE_RC=0
    FABRICO_WASM_OUT="$out_dir" bash "$GATE" "$@" >"${SCRATCH}/output" 2>&1 || GATE_RC=$?
    GATE_OUTPUT="$(cat "${SCRATCH}/output")"
}

failed=0
fail_property() {
    echo "      FAIL: $1" >&2
    printf '%s\n' "$GATE_OUTPUT" | sed 's/^/        /' >&2
    failed=1
}

# The exit code has to be 1, and each named text has to appear in the output. On success it prints
# the lines that hold each text, which are the evidence the property went red for the right reason.
expect_red() {
    local what="$1" text
    shift
    if [ "$GATE_RC" -ne 1 ]; then
        fail_property "${what}: the gate exited ${GATE_RC}, expected 1."
        return
    fi
    for text in "$@"; do
        if ! grep -q -F -e "$text" <<<"$GATE_OUTPUT"; then
            fail_property "${what}: the gate exited 1 and its output doesn't hold '${text}'."
            return
        fi
    done
    echo "      exit 1"
    for text in "$@"; do
        grep -F -e "$text" <<<"$GATE_OUTPUT" | sed 's/^/      /'
    done
}

expect_refused() {
    local what="$1"
    if [ "$GATE_RC" -ne 2 ]; then
        fail_property "${what}: the gate exited ${GATE_RC}, expected 2."
    else
        echo "      ${what}: exit 2, ${GATE_OUTPUT}"
    fi
}

# The last character of a hash, swapped for a different one.
other_character() {
    if [ "$1" = "0" ]; then echo 1; else echo 0; fi
}

put_back_dropped_dir() {
    mkdir -p "$DROPPED_DIR"
    prover_put_back "${DROPPED_FILES[@]}"
}

echo "Proving ${GATE} bites, on ${MODULE}."

# --- Property 1: baseline green -------------------------------------------------------
echo "[1/8] baseline green"
run_gate "$OUT"
if [ "$GATE_RC" -ne 0 ]; then
    echo "      FAIL: the gate exited ${GATE_RC} with nothing changed:" >&2
    printf '%s\n' "$GATE_OUTPUT" >&2
    echo "      The proof could not be made (exit 2)." >&2
    exit 2
fi
for line in \
    "FIXTURES golden native=${GOLDEN_RECORDS} wasm=${GOLDEN_RECORDS}" \
    "FIXTURES scenario native=${SCENARIO_RECORDS} wasm=${SCENARIO_RECORDS}"; do
    if ! grep -q -x -F -e "$line" <<<"$GATE_OUTPUT"; then
        echo "      FAIL: the gate's output has no line '${line}':" >&2
        printf '%s\n' "$GATE_OUTPUT" >&2
        echo "      The proof could not be made (exit 2)." >&2
        exit 2
    fi
done
if ! [[ "$GATE_OUTPUT" =~ CLOCK\ constant_calls=[1-9][0-9]*\ random_calls=[1-9][0-9]* ]]; then
    echo "      FAIL: the gate's output has no CLOCK line with both counts above 0:" >&2
    printf '%s\n' "$GATE_OUTPUT" >&2
    echo "      The proof could not be made (exit 2)." >&2
    exit 2
fi
printf '%s\n' "$GATE_OUTPUT" | sed 's/^/      /'
GOOD_REPORT="${SCRATCH}/native-good.txt"
cp "${OUT}/corpus-native.txt" "$GOOD_REPORT"

# --- Property 2: a corrupted hash -----------------------------------------------------
echo "[2/8] the last character of ${EDITED_GOLDEN}'s last hash changed"
LAST_LINE="$(sed -n '$p' "$EDITED_HASHES")"
NEW_CHARACTER="$(other_character "${LAST_LINE: -1}")"
sed -i "\$ s/.\$/${NEW_CHARACTER}/" "$EDITED_HASHES"
if prover_same_as_kept "$EDITED_HASHES"; then
    echo "      FAIL: the edit to ${EDITED_HASHES} didn't take, so the proof could not be made." >&2
    exit 2
fi
run_gate "$OUT"
expect_red "a corrupted hash" "golden ${EDITED_GOLDEN} tick ${LAST_HASH_TICK} wasm="
prover_put_back "$EDITED_HASHES"

# --- Property 3: a dropped golden fixture ---------------------------------------------
echo "[3/8] ${DROPPED_GOLDEN} dropped"
rm -rf "$DROPPED_DIR"
run_gate "$OUT"
expect_red "a dropped golden fixture" \
    "FIXTURES golden native=${GOLDEN_RECORDS} wasm=$((GOLDEN_RECORDS - 1))" \
    "golden ${DROPPED_GOLDEN} is missing"
put_back_dropped_dir

# --- Property 4: a dropped scenario fixture -------------------------------------------
echo "[4/8] ${DROPPED_SCENARIO} dropped"
rm -f "$DROPPED_POSTCARD"
run_gate "$OUT"
expect_red "a dropped scenario fixture" \
    "FIXTURES scenario native=${SCENARIO_RECORDS} wasm=$((SCENARIO_RECORDS - 1))" \
    "scenario ${DROPPED_SCENARIO} is missing"
prover_put_back "$DROPPED_POSTCARD"

# --- Property 5: an extra golden fixture ----------------------------------------------
EXTRA_NAME="${EDITED_GOLDEN}${EXTRA_SUFFIX}"
echo "[5/8] ${EDITED_GOLDEN} copied to ${EXTRA_NAME}"
cp -R "${GOLDEN_ROOT}/${EDITED_GOLDEN}" "${GOLDEN_ROOT}/${EXTRA_NAME}"
run_gate "$OUT"
expect_red "an extra golden fixture" \
    "FIXTURES golden native=${GOLDEN_RECORDS} wasm=$((GOLDEN_RECORDS + 1))" \
    "golden ${EXTRA_NAME} is extra"
rm -rf "${GOLDEN_ROOT:?}/${EXTRA_NAME}"

# --- Property 6: a native disagreement on a scenario tick ------------------------------
TAMPERED_LINE="$(grep -n '^T scenario ' "$GOOD_REPORT" | tail -n 1)"
if [ -z "$TAMPERED_LINE" ]; then
    echo "      FAIL: the native report has no scenario tick line, so the proof could not be made." >&2
    exit 2
fi
TAMPERED_NUMBER="${TAMPERED_LINE%%:*}"
read -r _ _ TAMPERED_FIXTURE TAMPERED_TICK TAMPERED_HASH <<<"${TAMPERED_LINE#*:}"
echo "[6/8] the native report's ${TAMPERED_FIXTURE} tick ${TAMPERED_TICK} changed"
TAMPERED_REPORT="${SCRATCH}/native-tampered.txt"
cp "$GOOD_REPORT" "$TAMPERED_REPORT"
NEW_CHARACTER="$(other_character "${TAMPERED_HASH: -1}")"
sed -i "${TAMPERED_NUMBER}s/.\$/${NEW_CHARACTER}/" "$TAMPERED_REPORT"
if cmp -s "$GOOD_REPORT" "$TAMPERED_REPORT"; then
    echo "      FAIL: the edit to the native report didn't take, so the proof could not be made." >&2
    exit 2
fi
run_gate "$OUT" --native-report "$TAMPERED_REPORT"
expect_red "a native disagreement" "scenario ${TAMPERED_FIXTURE} tick ${TAMPERED_TICK} wasm=${TAMPERED_HASH} expected="

FAULT_LINE="$(grep -n '^F ' "$GOOD_REPORT" | tail -n 1)"
if [ -z "$FAULT_LINE" ]; then
    echo "      FAIL: the native report has no fault count line, so the proof could not be made." >&2
    exit 2
fi
FAULT_NUMBER="${FAULT_LINE%%:*}"
read -r _ FAULT_FAMILY FAULT_FIXTURE FAULT_COUNT <<<"${FAULT_LINE#*:}"
echo "      the native report's ${FAULT_FIXTURE} fault count raised by 1"
cp "$GOOD_REPORT" "$TAMPERED_REPORT"
sed -i "${FAULT_NUMBER}s/ ${FAULT_COUNT}\$/ $((FAULT_COUNT + 1))/" "$TAMPERED_REPORT"
if cmp -s "$GOOD_REPORT" "$TAMPERED_REPORT"; then
    echo "      FAIL: the edit to the native report didn't take, so the proof could not be made." >&2
    exit 2
fi
run_gate "$OUT" --native-report "$TAMPERED_REPORT"
expect_red "a native fault count disagreement" \
    "${FAULT_FAMILY} ${FAULT_FIXTURE} faults wasm=${FAULT_COUNT} native=$((FAULT_COUNT + 1))"

# --- Property 7: a short hashes file --------------------------------------------------
echo "[7/8] ${EDITED_GOLDEN}'s last hash line deleted"
sed -i '$ d' "$EDITED_HASHES"
run_gate "$OUT"
expect_red "a short hashes file" "golden ${EDITED_GOLDEN} tick ${LAST_HASH_TICK} wasm="
prover_put_back "$EDITED_HASHES"

# --- Property 8: nothing to compare ---------------------------------------------------
echo "[8/8] nothing to compare"
run_gate "${SCRATCH}/empty-dir"
expect_refused "no module"
run_gate "${SCRATCH}/no-tool"
expect_refused "no native tool"
run_gate "$OUT" --native-report "${SCRATCH}/no-such-report.txt"
expect_refused "a named report that doesn't exist"

mv "$GOLDEN_ROOT" "${SCRATCH}/golden-away"
mkdir "$GOLDEN_ROOT"
run_gate "$OUT"
expect_refused "an empty golden walk, read by the native tool"
run_gate "$OUT" --native-report "$GOOD_REPORT"
expect_refused "an empty golden walk, read by the runner"
rmdir "$GOLDEN_ROOT"
mv "${SCRATCH}/golden-away" "$GOLDEN_ROOT"

mv "$SCENARIO_ROOT" "${SCRATCH}/scenario-away"
mkdir "$SCENARIO_ROOT"
run_gate "$OUT"
expect_refused "an empty scenario walk, read by the native tool"
run_gate "$OUT" --native-report "$GOOD_REPORT"
expect_refused "an empty scenario walk, read by the runner"
rmdir "$SCENARIO_ROOT"
mv "${SCRATCH}/scenario-away" "$SCENARIO_ROOT"

sed -i 's/^\( *\)Fixture {$/\1Fixture{/' "$RECORD_FILE"
run_gate "$OUT"
expect_refused "a golden native count of zero"
prover_put_back "$RECORD_FILE"

mv "$SNAPSHOT_ROOT" "${SCRATCH}/snapshot-away"
mkdir "$SNAPSHOT_ROOT"
run_gate "$OUT"
expect_refused "a scenario native count of zero"
rmdir "$SNAPSHOT_ROOT"
mv "${SCRATCH}/snapshot-away" "$SNAPSHOT_ROOT"

# --- Everything put back --------------------------------------------------------------
echo "      every file put back"
if ! prover_same_as_kept "$EDITED_HASHES" "$DROPPED_POSTCARD" "$RECORD_FILE" "${DROPPED_FILES[@]}"; then
    fail_property "a probed file differs from its kept bytes."
fi
run_gate "$OUT"
if [ "$GATE_RC" -ne 0 ]; then
    fail_property "the gate exited ${GATE_RC} after every file was put back."
else
    echo "      exit 0"
fi

echo
if [ "$failed" -ne 0 ]; then
    echo "NOT PROVEN: at least one property above did not hold." >&2
    exit 1
fi

echo "PROVEN: ${GATE} bites. It exits 1 and names the fixture for a corrupted hash, a dropped golden"
echo "        fixture, a dropped scenario fixture, an extra golden fixture, a native disagreement on a"
echo "        scenario tick or a fault count and a short hashes file. It exits 2 when there's nothing"
echo "        to compare."
exit 0
