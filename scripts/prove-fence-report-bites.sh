#!/usr/bin/env bash
#
# Proof that the fence report gate can fail.
#
# WHY THIS SCRIPT EXISTS. scripts/check-fence-report.sh is green at each commit where the wasm build
# runs out of gas, memory and stack the way the rules allow, and a gate nobody has seen go red looks
# the same as one that can't. This script measures once, keeps the real report, and runs the gate's
# `--report` mode on tampered copies of it, and on the real report with the pins file edited in a
# private worktree. Each red has to exit with the code the case calls for and name what it found,
# so a crash or a missing file can't pass as a failed rule.
#
# It reads every number it tampers with from the report it measured, so a moved pin or a new
# compiler can't leave it probing a value the report no longer holds.
#
# THE PROPERTIES, in order:
#   1. BASELINE GREEN. With nothing changed the gate measures and exits 0. A red baseline makes the
#      rest meaningless, so it's exit 2.
#   2. GAS. For each target, its gas count raised by 1 exits 1 and names both counts, and lowered by
#      1 does the same. Running it per target and in both directions means a one-sided compare
#      can't pass.
#   3. MEMORY. One wasm32 pin in the pins file raised by 1 exits 1 and names the shape, and lowered
#      by 1 does the same. Then the same with one native pin.
#   4. STACK KIND. Each of kind, runaway, map_kind and map_runaway set to trap on the wasm32 stack
#      line exits 1 and names its field.
#   5. STACK SIZE. shadow_stack set equal to limit exits 1.
#   6. NO DEPTH PIN. first_fault and map_first_fault moved by 100 on both targets, up and then down,
#      exit 0. The depths change with the compiler and the profile, so the rules print them and
#      don't pin them, and this property shows that's what the gate does.
#   7. A MISSING LINE. Each line of the report deleted in turn exits 2 and names the line, the
#      `FENCE alloc wasm32 ok` line among them.
#   8. A TRAP IN THE MEMORY SEARCH. A `FENCE trap memory wasm32 <shape> <size>` line added to the
#      report, the line the measurement writes when a memory probe traps the instance, exits 1 and
#      names the shape and the size.
#   9. MISSING ARTIFACTS. The gate exits 2 with no artifact folder, with no harness module, with no
#      native tool and with a named report that doesn't exist. This script also exits 2 at its start
#      when FABRICO_WASM_OUT lacks either artifact.
#
# After the last property it puts the pins file back and requires a fresh measurement to exit 0.
#
# This prover uses prebuilt artifacts and runs no cargo command, so a CI run doesn't compile the
# workspace once per prover. Build first with scripts/build-wasm.sh. The gate writes its report to a
# private copy of the artifacts, so the caller's stay as they were.
#
# ENVIRONMENT
#   FABRICO_WASM_OUT  where the harness module and the native tool are. It has to be an absolute
#                     path, because the gate runs from a private worktree.
#
# EXIT CODES
#   0  every property held. The final line begins `PROVEN:`.
#   1  at least one property did not hold, and the failing one is named.
#   2  the proof could not be made: an argument was passed, FABRICO_WASM_OUT isn't absolute, an
#      artifact is missing, a tamper didn't take, or the baseline is red.
#
# Usage:  FABRICO_WASM_OUT=<absolute dir> bash scripts/prove-fence-report-bites.sh

set -euo pipefail

# Sourced before any change of directory: the helper records where this script lives.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source-path=SCRIPTDIR source=lib/prover-isolation.sh
. "${SCRIPT_DIR}/lib/prover-isolation.sh"

cd "$(git rev-parse --show-toplevel)"

GATE="scripts/check-fence-report.sh"
PINS="crates/fabrico-player/fence-pins.txt"

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

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/fabrico-fence-report.XXXXXX")"
cleanup() {
    rm -rf "$SCRATCH"
}
prover_on_exit cleanup

# The gate writes its report beside the module, so it gets a private copy of both.
OUT="${SCRATCH}/out"
mkdir "$OUT" "${SCRATCH}/empty-dir" "${SCRATCH}/no-tool" "${SCRATCH}/no-module"
cp "$MODULE" "$NATIVE_TOOL" "$OUT/"
cp "$MODULE" "${SCRATCH}/no-tool/"
cp "$NATIVE_TOOL" "${SCRATCH}/no-module/"

if [ ! -s "$PINS" ]; then
    echo "FAIL: ${PINS} isn't there to probe." >&2
    exit 2
fi
prover_keep_bytes "$PINS"

# --- Helpers --------------------------------------------------------------------------
GATE_RC=0
GATE_OUTPUT=""
run_gate() {
    local out_dir="$1"
    shift
    GATE_RC=0
    FABRICO_WASM_OUT="$out_dir" bash "$GATE" "$@" </dev/null >"${SCRATCH}/output" 2>&1 || GATE_RC=$?
    GATE_OUTPUT="$(cat "${SCRATCH}/output")"
}
run_report() {
    run_gate "$OUT" --report "$1"
}

failed=0
fail_property() {
    echo "      FAIL: $1" >&2
    printf '%s\n' "$GATE_OUTPUT" | sed 's/^/        /' >&2
    failed=1
}

# The exit code has to be the one named, and each named text has to appear in the output. On
# success it prints the lines that hold each text, which are the evidence the gate went red for the
# right reason.
expect_exit() {
    local want="$1" what="$2" text
    shift 2
    if [ "$GATE_RC" -ne "$want" ]; then
        fail_property "${what}: the gate exited ${GATE_RC}, expected ${want}."
        return
    fi
    for text in "$@"; do
        if ! grep -q -F -e "$text" <<<"$GATE_OUTPUT"; then
            fail_property "${what}: the gate exited ${want} and its output doesn't hold '${text}'."
            return
        fi
    done
    echo "      ${what}: exit ${want}"
    for text in "$@"; do
        grep -F -e "$text" <<<"$GATE_OUTPUT" | sed 's/^/        /'
    done
}

cannot_prove() {
    echo "      FAIL: $1, so the proof could not be made (exit 2)." >&2
    exit 2
}

# A copy of the good report with one literal text replaced on the one line that starts with the
# given prefix. It has to replace exactly once, or the tamper didn't take.
TAMPERED="${SCRATCH}/tampered.txt"
tamper() {
    local prefix="$1" old="$2" new="$3" source="${4:-$GOOD_REPORT}"
    local rc=0
    awk -v p="$prefix " -v o="$old" -v n="$new" '
        index($0, p) == 1 && (i = index($0, o)) > 0 {
            $0 = substr($0, 1, i - 1) n substr($0, i + length(o)); c++
        }
        { print }
        END { if (c != 1) exit 3 }
    ' "$source" >"${TAMPERED}.next" || rc=$?
    if [ "$rc" -ne 0 ]; then
        cannot_prove "replacing '${old}' on the '${prefix}' line didn't change exactly one line"
    fi
    mv "${TAMPERED}.next" "$TAMPERED"
}

# The value of one `key=value` field on the line that starts with the given prefix.
field_of() {
    awk -v p="$1 " -v k="$2" '
        index($0, p) == 1 {
            for (f = 1; f <= NF; f++) if (index($f, k "=") == 1) { print substr($f, length(k) + 2); exit }
        }
    ' "$GOOD_REPORT"
}

echo "Proving ${GATE} bites, on ${MODULE}."

# --- Property 1: baseline green -------------------------------------------------------
echo "[1/9] baseline green"
run_gate "$OUT"
if [ "$GATE_RC" -ne 0 ]; then
    echo "      FAIL: the gate exited ${GATE_RC} with nothing changed:" >&2
    printf '%s\n' "$GATE_OUTPUT" >&2
    echo "      The proof could not be made (exit 2)." >&2
    exit 2
fi
printf '%s\n' "$GATE_OUTPUT" | sed 's/^/      /'
GOOD_REPORT="${SCRATCH}/report-good.txt"
cp "${OUT}/fence-report.txt" "$GOOD_REPORT"
run_report "$GOOD_REPORT"
if [ "$GATE_RC" -ne 0 ]; then
    cannot_prove "the gate exited ${GATE_RC} on the report it had just passed"
fi

# --- Property 2: gas ------------------------------------------------------------------
echo "[2/9] a gas count moved by 1, on each target, in both directions"
NATIVE_GAS="$(awk '$1 == "FENCE" && $2 == "gas" && $3 == "native" { print $4 }' "$GOOD_REPORT")"
WASM_GAS="$(awk '$1 == "FENCE" && $2 == "gas" && $3 == "wasm32" { print $4 }' "$GOOD_REPORT")"
case "${NATIVE_GAS}:${WASM_GAS}" in
    *[!0-9:]* | :* | *:) cannot_prove "the report's gas counts aren't two numbers ('${NATIVE_GAS}', '${WASM_GAS}')" ;;
esac
for target in native wasm32; do
    if [ "$target" = native ]; then gas="$NATIVE_GAS"; else gas="$WASM_GAS"; fi
    for delta in 1 -1; do
        moved=$((gas + delta))
        tamper "FENCE gas ${target}" " ${gas}" " ${moved}"
        run_report "$TAMPERED"
        if [ "$target" = native ]; then
            want="native trips the fuse at ${moved} and wasm32 at ${WASM_GAS}"
        else
            want="native trips the fuse at ${NATIVE_GAS} and wasm32 at ${moved}"
        fi
        expect_exit 1 "${target} gas ${gas} -> ${moved}" "$want"
    done
done

# --- Property 3: memory pins ----------------------------------------------------------
echo "[3/9] a memory pin moved by 1, on each target, in both directions"
for target in wasm32 native; do
    PIN_LINE="$(awk -v t="$target" '$1 == t && NF == 3 { print; exit }' "$PINS")"
    read -r _ shape pin <<<"$PIN_LINE"
    case "${shape:-}:${pin:-}" in
        :* | *: | *:*[!0-9]*) cannot_prove "${PINS} has no '${target} <shape> <count>' line to move" ;;
    esac
    for delta in 1 -1; do
        moved=$((pin + delta))
        awk -v old="$PIN_LINE" -v new="${target} ${shape} ${moved}" '
            $0 == old { $0 = new; c++ } { print } END { if (c != 1) exit 3 }
        ' "$PINS" >"${SCRATCH}/pins.next" || cannot_prove "the pin line '${PIN_LINE}' isn't in ${PINS} once"
        cp "${SCRATCH}/pins.next" "$PINS"
        if prover_same_as_kept "$PINS"; then
            cannot_prove "the edit to ${PINS} didn't take"
        fi
        run_report "$GOOD_REPORT"
        expect_exit 1 "${target} ${shape} pin ${pin} -> ${moved}" \
            "memory ${target} ${shape}: the pin is ${moved} and this build measured ${pin}"
        prover_put_back "$PINS"
    done
done

# --- Property 4: stack kind -----------------------------------------------------------
echo "[4/9] each stack kind field set to trap"
for key in kind runaway map_kind map_runaway; do
    tamper "FENCE stack wasm32" " ${key}=fault" " ${key}=trap"
    run_report "$TAMPERED"
    expect_exit 1 "${key}=trap" "stack wasm32 ${key}=trap, and it has to be fault"
done

# --- Property 5: stack size -----------------------------------------------------------
echo "[5/9] shadow_stack equal to limit"
LIMIT="$(field_of "FENCE stack wasm32" limit)"
SHADOW="$(field_of "FENCE stack wasm32" shadow_stack)"
if [ -z "$LIMIT" ] || [ -z "$SHADOW" ]; then
    cannot_prove "the wasm32 stack line has no limit or shadow_stack field"
fi
tamper "FENCE stack wasm32" " shadow_stack=${SHADOW}" " shadow_stack=${LIMIT}"
run_report "$TAMPERED"
expect_exit 1 "shadow_stack=${LIMIT}" "stack wasm32 shadow_stack=${LIMIT} isn't larger than limit=${LIMIT}"

# --- Property 6: no depth pin ---------------------------------------------------------
echo "[6/9] first_fault and map_first_fault moved by 100 on both targets"
for delta in 100 -100; do
    cp "$GOOD_REPORT" "${SCRATCH}/depths.txt"
    for target in native wasm32; do
        for key in first_fault map_first_fault; do
            depth="$(field_of "FENCE stack ${target}" "$key")"
            case "${depth:-x}" in
                *[!0-9]*) cannot_prove "the ${target} stack line has no ${key} number" ;;
            esac
            tamper "FENCE stack ${target}" " ${key}=${depth}" " ${key}=$((depth + delta))" "${SCRATCH}/depths.txt"
            cp "$TAMPERED" "${SCRATCH}/depths.txt"
        done
    done
    run_report "${SCRATCH}/depths.txt"
    expect_exit 0 "depths moved by ${delta}" "first_fault=" "gas equal, memory at its pins"
done

# --- Property 7: a missing line -------------------------------------------------------
echo "[7/9] each report line deleted in turn"
LINE_COUNT="$(grep -c '^FENCE ' "$GOOD_REPORT")"
if [ "$LINE_COUNT" -lt 2 ] || ! grep -q -x -F 'FENCE alloc wasm32 ok' "$GOOD_REPORT"; then
    cannot_prove "the report has ${LINE_COUNT} FENCE line(s), or no 'FENCE alloc wasm32 ok' line"
fi
number=0
while IFS= read -r line; do
    number=$((number + 1))
    case "$line" in
        "FENCE memory "*) prefix="$(echo "$line" | awk '{ print $1, $2, $3, $4 }')" ;;
        FENCE\ *) prefix="$(echo "$line" | awk '{ print $1, $2, $3 }')" ;;
        *) continue ;;
    esac
    awk -v n="$number" 'NR != n' "$GOOD_REPORT" >"$TAMPERED"
    run_report "$TAMPERED"
    expect_exit 2 "'${prefix}' deleted" "has no line for: ${prefix}"
done <"$GOOD_REPORT"

# --- Property 8: a trap in the memory search ------------------------------------------
echo "[8/9] a memory probe that trapped the instance"
TRAP_SHAPE="$(awk '$1 == "FENCE" && $2 == "memory" && $3 == "wasm32" { print $4; exit }' "$GOOD_REPORT")"
TRAP_SIZE="$(awk '$1 == "FENCE" && $2 == "memory" && $3 == "wasm32" { print $5; exit }' "$GOOD_REPORT")"
case "${TRAP_SHAPE:-}:${TRAP_SIZE:-x}" in
    :* | *:*[!0-9]*) cannot_prove "the report has no 'FENCE memory wasm32 <shape> <count>' line" ;;
esac
cp "$GOOD_REPORT" "$TAMPERED"
echo "FENCE trap memory wasm32 ${TRAP_SHAPE} ${TRAP_SIZE}" >>"$TAMPERED"
run_report "$TAMPERED"
expect_exit 1 "${TRAP_SHAPE} trapped at ${TRAP_SIZE}" "FAIL memory wasm32 ${TRAP_SHAPE} trapped at ${TRAP_SIZE}"

# --- Property 9: missing artifacts ----------------------------------------------------
echo "[9/9] missing artifacts"
run_gate "${SCRATCH}/no-such-dir"
expect_exit 2 "no artifact folder" "is missing"
run_gate "${SCRATCH}/empty-dir"
expect_exit 2 "an empty artifact folder" "fabrico_wasm_corpus.wasm is missing"
run_gate "${SCRATCH}/no-module"
expect_exit 2 "no harness module" "fabrico_wasm_corpus.wasm is missing"
run_gate "${SCRATCH}/no-tool"
expect_exit 2 "no native tool" "corpus_native is missing"
run_report "${SCRATCH}/no-such-report.txt"
expect_exit 2 "a named report that doesn't exist" "is missing. No check was made."

# --- Everything put back --------------------------------------------------------------
echo "      the pins file put back"
if ! prover_same_as_kept "$PINS"; then
    fail_property "${PINS} differs from its kept bytes."
fi
run_gate "$OUT"
if [ "$GATE_RC" -ne 0 ]; then
    fail_property "the gate exited ${GATE_RC} after the pins file was put back."
else
    echo "      exit 0"
fi

echo
if [ "$failed" -ne 0 ]; then
    echo "NOT PROVEN: at least one property above did not hold." >&2
    exit 1
fi

echo "PROVEN: ${GATE} bites. It exits 1 on a gas count moved by 1 either way"
echo "        on either target, on a memory pin moved by 1 either way on either target, on each"
echo "        stack kind field set to trap, on a memory probe that trapped, and on a shadow stack no"
echo "        larger than the limit. It stays at 0 when the recursion depths move, and it exits 2 on"
echo "        each missing report line and each missing artifact."
exit 0
