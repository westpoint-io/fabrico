#!/usr/bin/env bash
#
# Proof that the WebAssembly player's size gate can fail.
#
# WHY THIS SCRIPT EXISTS. scripts/check-player-size.sh is green at each commit where the player
# fits its budget, and a gate nobody has seen go red looks the same as one that can't. This script
# edits the budget in a private worktree, runs the gate, and requires the exit code each case
# calls for.
#
# THE PROPERTIES, in order:
#   1. BASELINE GREEN. With nothing changed the gate exits 0, prints one PLAYER_SIZE line, and its
#      gzip number equals one this script measures itself. A red baseline makes the rest
#      meaningless, so it's exit 2.
#   2. ONE BYTE UNDER. With the budget at the measured size minus 1, the gate exits 1 and names both
#      numbers.
#   3. EXACTLY AT. With the budget at the measured size, the gate exits 0.
#   4. NO MODULE. With FABRICO_WASM_OUT pointed at an empty directory, the gate exits 2.
#   5. EMPTY OR WRONG MODULE. A zero-byte file and a file with no WebAssembly magic number each
#      exit 2, so a measurement of nothing can't pass.
#   6. UNREADABLE BUDGET. A missing file, a word, a zero, a negative number, two numbers and a file
#      of comments alone each exit 2.
#   7. REVERT CLEAN. With the budget's bytes put back, the gate exits 0 again.
#
# This prover uses prebuilt artifacts and runs no cargo command, so a CI run doesn't compile the
# workspace once per prover. Build first with scripts/build-wasm.sh.
#
# ENVIRONMENT
#   FABRICO_WASM_OUT  where the module is. It has to be an absolute path, because the gate runs
#                     from a private worktree.
#
# EXIT CODES
#   0  every property held. The final line begins `PROVEN:`.
#   1  at least one property did not hold, and the failing one is named.
#   2  the proof could not be made: an argument was passed, FABRICO_WASM_OUT isn't absolute, the
#      module is missing or empty, the gate or the budget file is missing, or the baseline is red.
#
# Usage:  FABRICO_WASM_OUT=<absolute dir> bash scripts/prove-player-size-bites.sh

set -euo pipefail

# Sourced before any change of directory: the helper records where this script lives.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source-path=SCRIPTDIR source=lib/prover-isolation.sh
. "${SCRIPT_DIR}/lib/prover-isolation.sh"

cd "$(git rev-parse --show-toplevel)"

GATE="scripts/check-player-size.sh"
BUDGET="crates/fabrico-player/size-budget.txt"

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
MODULE="${FABRICO_WASM_OUT}/fabrico_player.wasm"
if [ ! -s "$MODULE" ]; then
    echo "FAIL: ${MODULE} is missing or empty. Run scripts/build-wasm.sh first." >&2
    exit 2
fi

# --- Into the private worktree -------------------------------------------------------
prover_run_in_worktree "$@"

if [ ! -f "$GATE" ] || [ ! -f "$BUDGET" ]; then
    echo "FAIL: ${GATE} or ${BUDGET} isn't present, so there is nothing to prove." >&2
    exit 2
fi

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/fabrico-player-size.XXXXXX")"
cleanup() {
    rm -rf "$SCRATCH"
}
prover_on_exit cleanup
prover_keep_bytes "$BUDGET"

# Runs the gate with the given module directory, keeping stdout and stderr apart and the exit code
# clear of `set -e`, since a red run is the point of most calls.
GATE_RC=0
GATE_STDOUT=""
GATE_STDERR=""
run_gate() {
    GATE_RC=0
    FABRICO_WASM_OUT="$1" bash "$GATE" >"${SCRATCH}/stdout" 2>"${SCRATCH}/stderr" || GATE_RC=$?
    GATE_STDOUT="$(cat "${SCRATCH}/stdout")"
    GATE_STDERR="$(cat "${SCRATCH}/stderr")"
}

# Replaces the budget file's one number line. The file keeps its comments, so only the number moves.
set_budget() {
    prover_put_back "$BUDGET"
    sed -i -E "s/^[0-9]+\$/$1/" "$BUDGET"
    if ! grep -q -x -e "$1" "$BUDGET"; then
        echo "FAIL: the edit to ${BUDGET} didn't take, so the proof could not be made." >&2
        exit 2
    fi
}

failed=0
fail_property() {
    echo "      FAIL: $1" >&2
    if [ -n "$GATE_STDOUT" ]; then printf '        stdout: %s\n' "$GATE_STDOUT" >&2; fi
    if [ -n "$GATE_STDERR" ]; then printf '        stderr: %s\n' "$GATE_STDERR" >&2; fi
    failed=1
}

# Requires exit 2 and no size printed, for the cases where nothing could be measured.
expect_refused() {
    local what="$1"
    if [ "$GATE_RC" -ne 2 ]; then
        fail_property "${what}: the gate exited ${GATE_RC}, expected 2."
    elif [ -n "$GATE_STDOUT" ]; then
        fail_property "${what}: the gate exited 2 but printed a size."
    else
        echo "      ${what}: exit 2, ${GATE_STDERR}"
    fi
}

echo "Proving ${GATE} bites, on ${MODULE}."

# --- Property 1: baseline green -------------------------------------------------------
echo "[1/7] baseline green"
OWN_GZIP=$(($(gzip -9 -n -c "$MODULE" | wc -c)))
run_gate "$FABRICO_WASM_OUT"
if [ "$GATE_RC" -ne 0 ]; then
    echo "      FAIL: the gate exited ${GATE_RC} with nothing changed: ${GATE_STDOUT} ${GATE_STDERR}" >&2
    echo "      The proof could not be made (exit 2)." >&2
    exit 2
fi
if ! [[ "$GATE_STDOUT" =~ ^PLAYER_SIZE\ raw=[1-9][0-9]*\ gzip=([1-9][0-9]*)\ budget=([1-9][0-9]*)$ ]]; then
    echo "      FAIL: the gate's stdout isn't one PLAYER_SIZE line: ${GATE_STDOUT}" >&2
    echo "      The proof could not be made (exit 2)." >&2
    exit 2
fi
GZIP_BYTES="${BASH_REMATCH[1]}"
if [ "$GZIP_BYTES" -ne "$OWN_GZIP" ]; then
    fail_property "the gate says gzip=${GZIP_BYTES}, and this script measured ${OWN_GZIP}."
fi
echo "      baseline: exit 0, ${GATE_STDOUT}"

# --- Property 2: one byte under -------------------------------------------------------
echo "[2/7] the budget one byte below the measured size"
UNDER=$((GZIP_BYTES - 1))
set_budget "$UNDER"
run_gate "$FABRICO_WASM_OUT"
if [ "$GATE_RC" -ne 1 ]; then
    fail_property "with the budget at ${UNDER}, the gate exited ${GATE_RC}, expected 1."
elif [[ "$GATE_STDOUT" != *"gzip=${GZIP_BYTES} budget=${UNDER}" ]]; then
    fail_property "the gate exited 1 but its PLAYER_SIZE line doesn't name gzip=${GZIP_BYTES} budget=${UNDER}."
elif [[ "$GATE_STDERR" != *"${GZIP_BYTES}"*"${UNDER}"* ]]; then
    fail_property "the gate exited 1 but its message doesn't name ${GZIP_BYTES} and ${UNDER}."
else
    echo "      exit 1"
    echo "      stdout: ${GATE_STDOUT}"
    echo "      stderr: ${GATE_STDERR}"
fi

# --- Property 3: exactly at -----------------------------------------------------------
echo "[3/7] the budget exactly at the measured size"
set_budget "$GZIP_BYTES"
run_gate "$FABRICO_WASM_OUT"
if [ "$GATE_RC" -ne 0 ]; then
    fail_property "with the budget at ${GZIP_BYTES}, the gate exited ${GATE_RC}, expected 0."
else
    echo "      exit 0, ${GATE_STDOUT}"
fi
prover_put_back "$BUDGET"

# --- Property 4: no module ------------------------------------------------------------
echo "[4/7] FABRICO_WASM_OUT at an empty directory"
mkdir "${SCRATCH}/empty-dir"
run_gate "${SCRATCH}/empty-dir"
expect_refused "no module"

# --- Property 5: empty or wrong module ------------------------------------------------
echo "[5/7] a zero-byte module and a module with no magic number"
mkdir "${SCRATCH}/zero-bytes" "${SCRATCH}/wrong-bytes"
: >"${SCRATCH}/zero-bytes/fabrico_player.wasm"
run_gate "${SCRATCH}/zero-bytes"
expect_refused "zero-byte module"
printf 'not a module' >"${SCRATCH}/wrong-bytes/fabrico_player.wasm"
run_gate "${SCRATCH}/wrong-bytes"
expect_refused "wrong module"

# --- Property 6: unreadable budget ----------------------------------------------------
echo "[6/7] budget files with no usable number"
check_bad_budget() {
    local what="$1" text="$2"
    printf '%b' "$text" >"$BUDGET"
    run_gate "$FABRICO_WASM_OUT"
    expect_refused "$what"
    prover_put_back "$BUDGET"
}
check_bad_budget "budget is a word" 'many\n'
check_bad_budget "budget is zero" '0\n'
check_bad_budget "budget is negative" '-1\n'
check_bad_budget "budget has two numbers" '578000\n578000\n'
check_bad_budget "budget has comments alone" '# nothing here\n'
rm -f "$BUDGET"
run_gate "$FABRICO_WASM_OUT"
expect_refused "budget file missing"
prover_put_back "$BUDGET"

# --- Property 7: revert clean ---------------------------------------------------------
echo "[7/7] the budget's bytes put back"
if ! prover_same_as_kept "$BUDGET"; then
    fail_property "${BUDGET} differs from its kept bytes."
fi
run_gate "$FABRICO_WASM_OUT"
if [ "$GATE_RC" -ne 0 ]; then
    fail_property "the gate exited ${GATE_RC} after the budget was put back."
else
    echo "      exit 0, ${GATE_STDOUT}"
fi

echo
if [ "$failed" -ne 0 ]; then
    echo "NOT PROVEN: at least one property above did not hold." >&2
    exit 1
fi

echo "PROVEN: ${GATE} bites. With the budget at ${UNDER}, one byte below the player's ${GZIP_BYTES}"
echo "        gzipped bytes, it exits 1 and names both numbers. At ${GZIP_BYTES} it exits 0. A missing,"
echo "        empty or wrong module and an unreadable budget each exit 2."
exit 0
