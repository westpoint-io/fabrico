#!/usr/bin/env bash
#
# `scripts/check-test-aa-switch-absent.sh` CAN STILL FAIL.
#
# The absence check greps built bundles for the test antialiasing flag's name and passes on
# zero hits. Zero hits also come from a search that looked at the wrong files, so this
# prover shows the check fails when it should, in four cases:
#
#   1. PLANTED LEAK. It removes the `import.meta.env.DEV` early return from
#      `frontend/src/render/testAntialias.ts`, so the flag's name is live code, runs
#      `vite build` into a private directory, and requires the check to exit EXACTLY 1 with a
#      `FOUND` line naming a file inside that directory. Then it puts the file back from the
#      bytes it kept.
#   2. An EMPTY directory must exit 2.
#   3. A directory holding one .js file without the positive control must exit 2.
#   4. A path that doesn't exist must exit 2.
#
# IT RUNS IN A PRIVATE WORKTREE (Shape B of scripts/lib/prover-isolation.sh). Case 1 edits a
# tracked source file, and the Vite dev server and other processes may be reading this
# checkout; editing it here would push the unguarded switch through a hot reload. So the
# outer run checks HEAD plus your uncommitted tracked edits and untracked files out into a
# detached worktree, and every edit, build and restore happens there. The worktree borrows
# the caller's frontend/node_modules entry by entry (`prover_link_node_modules`), so Vite's
# own caches stay private.
#
# Exit codes:
#   0  proven: all four cases behaved
#   1  a case did not behave; each failure is named
#   2  the proof could not be made (missing tool, file or node_modules, a failed build, a
#      guard line that wasn't found). This is a FAILURE, not a pass.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
. "${SCRIPT_DIR}/lib/prover-isolation.sh"

cd "$(git rev-parse --show-toplevel)"

GATE="scripts/check-test-aa-switch-absent.sh"
SWITCH="frontend/src/render/testAntialias.ts"
# The guard line removed in case 1. Matched as a whole line so a rewrite of the switch that
# drops or renames it makes this prover exit 2 instead of planting nothing.
GUARD_LINE='  if (!import.meta.env.DEV) return false;'

usage() {
    cat >&2 <<'USAGE'
usage: bash scripts/prove-test-aa-switch-absent-non-vacuous.sh

Proves scripts/check-test-aa-switch-absent.sh can fail: a build with the DEV guard removed
must exit 1 and name the bundle file, and an empty directory, a directory with no positive
control and a missing path must each exit 2.

It runs in a private worktree and never writes a file in your checkout. Set TMPDIR to a
directory on disk if /tmp is small; the private build goes there.

  --help, -h   this message

Exit codes:
  0  proven
  1  a case did not behave; every failure is named
  2  the proof could not be made. This is a FAILURE, not a pass.
USAGE
}

ORIG_ARGS=("$@")
for arg in "$@"; do
    case "$arg" in
        -h | --help)
            usage
            exit 0
            ;;
        *)
            echo "FAIL: unknown argument '${arg}' (this prover takes none)." >&2
            usage
            exit 2
            ;;
    esac
done

if ! command -v node >/dev/null 2>&1; then
    echo "FAIL: 'node' is not available, so the bundle can't be built." >&2
    exit 2
fi

# --- Into the private worktree (Shape B) ---------------------------------------------
prover_run_in_worktree ${ORIG_ARGS[@]+"${ORIG_ARGS[@]}"}

echo "testing rev=$(git rev-parse HEAD) overlay=$(prover_overlay_stamp)"

for f in "$GATE" "$SWITCH"; do
    if [ ! -f "$f" ]; then
        echo "FAIL: ${f} is missing, so there is nothing to prove." >&2
        exit 2
    fi
done

CALLER="$(prover_caller_root)"
if [ ! -f "${CALLER}/frontend/node_modules/vite/bin/vite.js" ]; then
    echo "FAIL: ${CALLER}/frontend/node_modules has no Vite (run npm ci in frontend/)." >&2
    exit 2
fi
prover_link_node_modules "${CALLER}/frontend/node_modules" frontend/node_modules

WORK="$(mktemp -d "${TMPDIR:-/tmp}/fabrico-aa-switch.XXXXXX")"
cleanup() {
    # A real directory of links plus Vite's private caches: removing it removes the links,
    # never what they point at.
    if [ -d frontend/node_modules ] && [ ! -L frontend/node_modules ]; then
        rm -rf -- frontend/node_modules
    fi
    rm -rf -- "$WORK"
}
prover_on_exit cleanup

failed=0
fail() {
    echo "  FAIL: $1" >&2
    failed=1
}

GATE_OUT=""
GATE_RC=0
run_gate() {
    GATE_OUT=""
    GATE_RC=0
    GATE_OUT="$(bash "$GATE" "$@" 2>&1)" || GATE_RC=$?
}

# --- Case 1: the planted leak ----------------------------------------------------------
echo "[1/4] the DEV guard removed: the check must exit EXACTLY 1 and name a bundle file"
prover_keep_bytes "$SWITCH"
guards="$(grep -c -x -F -- "$GUARD_LINE" "$SWITCH" || true)"
if [ "$guards" -ne 1 ]; then
    echo "FAIL: ${SWITCH} holds ${guards} copies of the guard line, expected 1:" >&2
    echo "  ${GUARD_LINE}" >&2
    echo "If the switch was rewritten, update GUARD_LINE here so the planted leak still removes" >&2
    echo "the guard. The proof could not be made." >&2
    exit 2
fi
grep -v -x -F -- "$GUARD_LINE" "$SWITCH" > "${WORK}/switch.ts"
cp "${WORK}/switch.ts" "$SWITCH"
if prover_same_as_kept "$SWITCH"; then
    echo "FAIL: removing the guard left ${SWITCH} unchanged. The proof could not be made." >&2
    exit 2
fi

OUT="${WORK}/dist-leak"
build_start="$(date +%s)"
if ! (cd frontend && node node_modules/vite/bin/vite.js build --outDir "$OUT" --emptyOutDir) > "${WORK}/build.log" 2>&1; then
    echo "FAIL: vite build failed with the guard removed, so the proof could not be made:" >&2
    sed 's/^/  /' "${WORK}/build.log" >&2
    exit 2
fi
echo "       built ${OUT} in $(( $(date +%s) - build_start )) s"
prover_put_back "$SWITCH"

run_gate "$OUT"
if [ "$GATE_RC" -ne 1 ]; then
    fail "the check exited ${GATE_RC} on a build with the guard removed, expected EXACTLY 1."
    printf '%s\n' "$GATE_OUT" | sed 's/^/    /' >&2
else
    echo "       exit 1 (correct)"
fi
named="$(printf '%s\n' "$GATE_OUT" | grep -E "^FOUND ${OUT}/[^ ]+ [0-9]+$" || true)"
if [ -z "$named" ]; then
    fail "the check printed no 'FOUND <file> <count>' line for a file inside ${OUT}."
    printf '%s\n' "$GATE_OUT" | sed 's/^/    /' >&2
else
    printf '%s\n' "$named" | sed 's/^/       /'
fi
if ! prover_same_as_kept "$SWITCH"; then
    fail "${SWITCH} differs from its kept bytes after the put-back."
fi

# --- Cases 2-4: could not assert -------------------------------------------------------
echo "[2/4] an empty directory: the check must exit 2"
mkdir "${WORK}/empty"
run_gate "${WORK}/empty"
if [ "$GATE_RC" -ne 2 ]; then
    fail "the check exited ${GATE_RC} on an empty directory, expected EXACTLY 2."
    printf '%s\n' "$GATE_OUT" | sed 's/^/    /' >&2
else
    echo "       exit 2 (correct): $(printf '%s\n' "$GATE_OUT" | grep '^CANNOT ASSERT' | head -1)"
fi

echo "[3/4] one .js file without the positive control: the check must exit 2"
mkdir "${WORK}/no-control"
printf 'console.log("no renderer here");\n' > "${WORK}/no-control/index.js"
run_gate "${WORK}/no-control"
if [ "$GATE_RC" -ne 2 ]; then
    fail "the check exited ${GATE_RC} on a directory without the positive control, expected EXACTLY 2."
    printf '%s\n' "$GATE_OUT" | sed 's/^/    /' >&2
else
    echo "       exit 2 (correct): $(printf '%s\n' "$GATE_OUT" | grep '^CANNOT ASSERT' | head -1)"
fi

echo "[4/4] a path that doesn't exist: the check must exit 2"
run_gate "${WORK}/no-such-dir"
if [ "$GATE_RC" -ne 2 ]; then
    fail "the check exited ${GATE_RC} on a missing path, expected EXACTLY 2."
    printf '%s\n' "$GATE_OUT" | sed 's/^/    /' >&2
else
    echo "       exit 2 (correct): $(printf '%s\n' "$GATE_OUT" | grep '^CANNOT ASSERT' | head -1)"
fi

echo
if [ "$failed" -ne 0 ]; then
    echo "NOT PROVEN: at least one case did not behave (named above)." >&2
    exit 1
fi
echo "PROVEN: ${GATE} exits 1 and names the file on a build with the guard removed, and"
echo "exits 2 on an empty directory, a directory without the positive control and a missing path."
exit 0
