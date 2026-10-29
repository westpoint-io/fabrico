#!/usr/bin/env bash
#
# Non-vacuity proof for the golden-corpus REGISTRATION guard (THAW-06).
#
# WHY THIS SCRIPT EXISTS AT ALL.
# `crates/fabrico-core/tests/corpus_registration.rs` asserts that the set of golden
# fixture DIRECTORIES on disk equals the set of registered CORPUS names. At every commit
# where the corpus is correct those two sets ARE equal, so the test is GREEN ON ARRIVAL
# and, on its own, proves nothing: a guard nobody has ever seen go red is
# indistinguishable from a guard that cannot go red. That is this repository's signature
# defect class, and THAW-06 says so in as many words.
#
# So the proof is here, not there. This script PLANTS an unregistered fixture directory
# under crates/fabrico-core/tests/golden/, requires the guard to go RED and to NAME the
# planted directory, and then reverts. Acceptance is THIS SCRIPT'S EXIT CODE, never a
# human reading a test file.
#
# THE THREE PROPERTIES, in order:
#   1. BASELINE GREEN.  With nothing planted, `cargo test -p fabrico-core --test
#      corpus_registration` exits 0. Asserted FIRST, because a red baseline makes property
#      2 meaningless: the guard would be red whether the directory were planted or not.
#   2. RED AND NAMED.   With the directory planted, the same command exits non-zero, its
#      output contains a `test result: FAILED` summary (so the redness came from the
#      assertion and not from a build that never ran the test), and it NAMES the planted
#      directory. An exit code alone cannot tell the unregistered-directory finding apart
#      from the registered-record-with-no-directory finding or from a registry-drift
#      finding, all three of which live in the same assertion.
#   3. REVERT CLEAN.    The planted directory is removed and the tree is left exactly as
#      it was found.
#
# EXIT CODES
#   0  every property held. The final line begins `PROVEN:`.
#   1  at least one property did not hold; the failing one is named. The most important
#      case is property 2 exiting 0, which means a planted unregistered directory left the
#      suite GREEN - the exact hole THAW-06 exists to close.
#   2  the proof could not be MADE (an edited corpus, guard or runner at entry, a red
#      baseline, a missing guard file, an empty donor set, a planted path that already
#      exists, no cargo). This is a different condition from "the guard is vacuous" and
#      reporting it as one would send a runner hunting the wrong bug.
#
# WHERE IT RUNS (review 84 WR-11). In a private worktree: scripts/lib/prover-isolation.sh's
# Shape B runs this script again in a detached worktree of HEAD plus the caller's
# uncommitted and untracked files, with its own CARGO_TARGET_DIR. Planted in the shared
# checkout (Shape A, plan 84-04), the unregistered directory turned any other
# `corpus_registration` run red for the length of the run, and the whole-tree-clean guard that
# Shape A needed refused almost every local run in a tree other processes edit.
#
# ON THE DONOR AND THE PROBE, BOTH SELECTED AT RUN TIME
# The donor fixture whose five files are copied, is chosen from the fixtures discovered on
# disk rather than named here. A prover holding a literal covered path goes stale the
# moment that path is renamed, and a stale prover that skips its probe reports a green it
# did not earn.
#
# Usage:  bash scripts/prove-corpus-registration-bites.sh

set -euo pipefail

# Sourced before any change of directory: the helper records where this script lives.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source-path=SCRIPTDIR source=lib/prover-isolation.sh
. "${SCRIPT_DIR}/lib/prover-isolation.sh"

# Resolve repo root so the script works from any cwd.
cd "$(git rev-parse --show-toplevel)"

GUARD="crates/fabrico-core/tests/corpus_registration.rs"
RUNNER="crates/fabrico-core/tests/cert_cross_platform.rs"
GOLDEN_DIR="crates/fabrico-core/tests/golden"

# The planted directory. Deliberately outside every reserved fixture id (the reservation
# table above `const CORPUS` runs to 0036) and deliberately self-describing, so a leftover
# one found by a later runner explains itself.
PLANTED_DIR="${GOLDEN_DIR}/9999-prover-planted-unregistered"

# The five files a golden fixture directory holds (regen.rs `freeze()`), copied verbatim
# from the donor. The guard's predicate is `meta.toml` presence alone, but planting a
# COMPLETE fixture shape is what makes this probe the realistic case: a half-written
# directory would also be caught by scripts/measure-golden-corpus.sh, and then a green
# here would not be attributable to this guard.
GOLDEN_FILES=(genesis.snapshot log.postcard edit-log.postcard hashes.txt meta.toml)

# Guard F's scope, identical to the retired freeze prover's: untracked dirt is refused
# under a SOURCE tree only, so repository-root scratch files and notes do not make an
# exit-gate tool cry wolf.
SOURCE_TREES=(
    "crates"
    "frontend"
    "scripts"
    "docs"
)

if [ "$#" -ne 0 ]; then
    echo "FAIL: this proof takes no arguments (got: $*)." >&2
    echo "usage: bash scripts/prove-corpus-registration-bites.sh" >&2
    exit 2
fi

# --- Into the private worktree (Shape B, review 84 WR-11) ---------------------------
# In the caller this does not return: it runs this script again inside the worktree (with
# a private CARGO_TARGET_DIR) and exits with that run's code. Inside, it returns.
prover_run_in_worktree "$@"

# --- Guard A: the guard under test must be present ----------------------------------
if [ ! -f "$GUARD" ]; then
    echo "FAIL: ${GUARD} is not present, so there is no guard to prove." >&2
    exit 2
fi
if [ ! -f "$RUNNER" ]; then
    echo "FAIL: ${RUNNER} is not present; the guard reads it for its registry-drift" >&2
    echo "      clause, so the proof could not be made." >&2
    exit 2
fi
if [ ! -d "$GOLDEN_DIR" ]; then
    echo "FAIL: ${GOLDEN_DIR} is not present, so there is nothing to plant into." >&2
    exit 2
fi

# --- Guard B: cargo must be runnable -------------------------------------------------
if ! command -v cargo >/dev/null 2>&1; then
    echo "FAIL: cargo is not on PATH, so the guard cannot be run and nothing can be" >&2
    echo "      proved about it." >&2
    exit 2
fi

# --- Guard C: the planted path must not already exist --------------------------------
# If it does, it is residue from an aborted earlier run. Removing it here would delete
# evidence and could delete a real directory somebody created; refusing names it instead.
if [ -e "$PLANTED_DIR" ]; then
    echo "FAIL: ${PLANTED_DIR} already exists, so this run cannot plant it." >&2
    echo >&2
    echo "That is almost certainly RESIDUE from an aborted earlier run of this script." >&2
    echo "Remove it by hand and re-run. It is deliberately not removed automatically:" >&2
    echo "deleting a directory this run did not create would destroy evidence." >&2
    exit 2
fi

# --- Guard D: a donor fixture must exist, selected at RUN TIME ------------------------
# The whole five-file shape is required of the donor, so the planted directory is a
# realistic fixture rather than a lone meta.toml.
DONOR_FIXTURE=""
if ! donor_candidates="$(LC_ALL=C find "$GOLDEN_DIR" -mindepth 2 -maxdepth 2 -name 'meta.toml' -print | LC_ALL=C sort)"; then
    echo "FAIL: could not walk ${GOLDEN_DIR} for a donor fixture, so the proof could" >&2
    echo "      not be made." >&2
    exit 2
fi
while IFS= read -r meta_path; do
    [ -n "$meta_path" ] || continue
    candidate="${meta_path%/meta.toml}"
    complete=1
    for f in "${GOLDEN_FILES[@]}"; do
        if [ ! -f "${candidate}/${f}" ]; then
            complete=0
            break
        fi
    done
    if [ "$complete" -eq 1 ]; then
        DONOR_FIXTURE="$candidate"
        break
    fi
done <<<"$donor_candidates"

if [ -z "$DONOR_FIXTURE" ]; then
    echo "FAIL: no COMPLETE five-file fixture was found under ${GOLDEN_DIR}, so this" >&2
    echo "      script has nothing to copy and the proof could not be made." >&2
    echo "      Expected files in a fixture directory: ${GOLDEN_FILES[*]}" >&2
    exit 2
fi

# --- Guard E: the corpus, the guard and its runner must be as committed ---------------
# Inside the private worktree, which carries the caller's uncommitted and untracked files.
# An edit to the golden directory, to the guard or to the runner it reads would make
# property 1 or 2 below fail for a reason that has nothing to do with the registration
# guard, and reporting that as "the guard is vacuous" points at the wrong bug. Dirt
# anywhere else is the tree as it stands, which is what the proof is for (review 84
# WR-11); if it breaks the build, property 1 is red and the proof is exit 2.
dirt="$(git status --porcelain -- "$GOLDEN_DIR" "$GUARD" "$RUNNER")"
if [ -n "$dirt" ]; then
    echo "FAIL: the corpus, the guard or its runner is not as committed, so this proof" >&2
    echo "      cannot be made:" >&2
    printf '%s\n' "$dirt" | sed 's/^/    /' >&2
    echo >&2
    echo "If one of the paths above is an UNREVERTED PROBE from an earlier interrupted" >&2
    echo "script run, that is exactly what this guard exists to catch: remove it." >&2
    exit 2
fi
# What was already untracked under a source tree at entry (carried from the caller), so
# the closing residue check names only what this run left.
untracked_at_entry="$(git ls-files --others --exclude-standard -- "${SOURCE_TREES[@]}")"

# The two short names, derived ONCE at top level rather than inside the property-2 block.
# Assigned there, they would be unset under `set -u` on any path that skips property 2 (a
# red baseline), and the closing PROVEN line reads one of them.
planted_id="${PLANTED_DIR##*/}"
donor_id="${DONOR_FIXTURE##*/}"

# --- Cleanup, in the private worktree ------------------------------------------------
# The planted directory is removed on every path (a failed assertion, a Ctrl-C, a `set -e`
# trip) through the helper's EXIT trap, then the worktree itself is removed. `rm -rf`
# rather than a git restore, because the probe is an UNTRACKED directory this script
# created; guard C above already refuses one that exists.
cleanup() {
    rm -rf "$PLANTED_DIR"
}
prover_on_exit cleanup

# --- Helpers -------------------------------------------------------------------------
# Runs the guard, capturing combined stdout+stderr and the exit code WITHOUT tripping
# `set -e`. `set -e` would abort on the deliberate red run, which is the run this whole
# script exists to observe.
GUARD_OUT=""
GUARD_RC=0
run_guard() {
    GUARD_OUT=""
    GUARD_RC=0
    set +e
    GUARD_OUT="$(cargo test -p fabrico-core --test corpus_registration 2>&1)"
    GUARD_RC=$?
    set -e
}

STEP=0
TOTAL=3
step() {
    STEP=$((STEP + 1))
    printf '[%d/%d] %s\n' "$STEP" "$TOTAL" "$1"
}

failed=0
# Whether property 2 actually planted the directory. Property 3 reads it so a run that
# never got that far reports "nothing was planted" rather than asserting a revert of
# something that was never there.
PLANTED=0

echo "Proving ${GUARD} bites."
echo "  donor fixture:    ${DONOR_FIXTURE}"
echo "  planted directory: ${PLANTED_DIR}"
echo

# --- Property 1: baseline green -------------------------------------------------------
step "baseline green (the guard exits 0 with nothing planted)"
run_guard
if [ "$GUARD_RC" -ne 0 ]; then
    echo "      FAIL: the guard exited ${GUARD_RC} with NOTHING planted." >&2
    echo >&2
    printf '%s\n' "$GUARD_OUT" | sed 's/^/        /' >&2
    echo >&2
    echo "      A red baseline makes property 2 below meaningless: the guard would be" >&2
    echo "      red whether the directory were planted or not. Either the corpus and the" >&2
    echo "      registry genuinely disagree at this commit, or the guard does not build." >&2
    echo "      The proof could not be made (exit 2)." >&2
    exit 2
else
    echo "      baseline: GREEN"
fi

# --- Property 2: red, and NAMED -------------------------------------------------------
if [ "$failed" -eq 0 ]; then
    step "planted directory makes the guard exit non-zero, NAMING ${PLANTED_DIR##*/}"

    mkdir -p "$PLANTED_DIR"
    PLANTED=1
    for f in "${GOLDEN_FILES[@]}"; do
        cp "${DONOR_FIXTURE}/${f}" "${PLANTED_DIR}/${f}"
    done
    # Rewrite the copy's scenario_id so the planted fixture claims its OWN identity rather
    # than the donor's. A copy still claiming the donor's id would be a duplicate-identity
    # probe, which is a different (and unguarded) condition.
    printf '%s\n' "scenario_id = \"${planted_id}\"" >"${PLANTED_DIR}/meta.toml.new"
    grep -v '^scenario_id = ' "${PLANTED_DIR}/meta.toml" >>"${PLANTED_DIR}/meta.toml.new"
    mv "${PLANTED_DIR}/meta.toml.new" "${PLANTED_DIR}/meta.toml"

    run_guard

    if [ "$GUARD_RC" -eq 0 ]; then
        echo "      FAIL: the guard exited 0 with an UNREGISTERED fixture directory" >&2
        echo "            planted at ${PLANTED_DIR}." >&2
        echo "            THE REGISTRATION HOLE IS OPEN: a directory the corpus runner" >&2
        echo "            never replays rides in green, certified by nothing. This is the" >&2
        echo "            exact condition THAW-06 exists to close." >&2
        failed=1
    elif ! printf '%s\n' "$GUARD_OUT" | grep -F 'test result: FAILED' >/dev/null; then
        echo "      FAIL: the guard exited ${GUARD_RC} but its output carries no" >&2
        echo "            'test result: FAILED' summary, so the test never RAN." >&2
        echo "            A build failure, a harness error or a missing target is a" >&2
        echo "            different condition from 'the guard bit', and it does not" >&2
        echo "            prove anything about the assertion." >&2
        printf '%s\n' "$GUARD_OUT" | sed 's/^/        /' >&2
        failed=1
    elif ! printf '%s\n' "$GUARD_OUT" | grep -F "$planted_id" >/dev/null; then
        echo "      FAIL: the guard reddened but did NOT name '${planted_id}'." >&2
        echo >&2
        printf '%s\n' "$GUARD_OUT" | sed 's/^/        /' >&2
        echo >&2
        echo "      The assertion carries three findings - an unregistered directory, a" >&2
        echo "      registered record with no directory, and registry drift - and an exit" >&2
        echo "      code alone cannot tell them apart. A red that does not name the" >&2
        echo "      planted path is a red attributed to the wrong cause." >&2
        failed=1
    else
        echo "      planted: guard correctly reddened (rc=${GUARD_RC}), naming ${planted_id}"
    fi
fi

# --- Property 3: revert clean ---------------------------------------------------------
# UNCONDITIONAL, unlike property 2. The removal has to happen on EVERY path, including the
# path where property 2 just found the hole open: gating it on `failed` would leave the
# planted directory on disk when the residue assertion below runs, and that assertion would
# then report "this script dirtied the tree and did not clean up" - two extra, FALSE
# failures stacked on top of the one real finding, pointing a reader at a cleanup bug that
# does not exist. The `trap cleanup EXIT` would have removed it a moment later, after the
# report was already wrong.
step "revert clean (the planted directory is gone and the guard is green again)"
rm -rf "$PLANTED_DIR"

if [ -e "$PLANTED_DIR" ]; then
    echo "      FAIL: '${PLANTED_DIR}' still exists after 'rm -rf'." >&2
    failed=1
elif [ "$PLANTED" -eq 0 ]; then
    echo "      nothing was planted (an earlier property did not hold), so the removal is"
    echo "      a no-op and the guard is not re-run here"
else
    run_guard
    if [ "$GUARD_RC" -ne 0 ]; then
        echo "      FAIL: the guard exited ${GUARD_RC} after the directory was removed." >&2
        echo >&2
        printf '%s\n' "$GUARD_OUT" | sed 's/^/        /' >&2
        echo >&2
        echo "      The proof must leave no residue. Something else in the tree moved" >&2
        echo "      during this run, or the removal did not take." >&2
        failed=1
    else
        echo "      reverted: GREEN restored"
    fi
fi

# --- The closing residue assertion ----------------------------------------------------
# The untracked files under a source tree, compared with the set at entry. Property 3
# already proves the planted directory is gone, but it only ever looks at that one path;
# nothing above would notice this run having left an untracked file elsewhere under a
# source tree, and "I cleaned up" is a claim, not evidence. The shared tree's TRACKED half
# (status, index, already-dirty file hashes, entry against exit) is the isolation helper's
# comparison in the caller, taken after this verdict.
residue_untracked="$(git ls-files --others --exclude-standard -- "${SOURCE_TREES[@]}")"
if [ "$residue_untracked" = "$untracked_at_entry" ]; then
    residue_untracked=""
fi

if [ -n "$residue_untracked" ]; then
    echo >&2
    echo "FAIL: this run left RESIDUE under a source tree." >&2
    echo >&2
    printf '%s\n' "$residue_untracked" | sed 's/^/    /' >&2
    echo >&2
    echo "The untracked set under the source trees differs from the one at entry, so this" >&2
    echo "script left something behind in its private worktree and did not clean up." >&2
    failed=1
fi

echo
if [ "$failed" -ne 0 ]; then
    echo "NOT PROVEN: at least one property above did not hold. See the named failures." >&2
    exit 1
fi

echo "PROVEN: ${GUARD} bites. An unregistered fixture directory planted under"
echo "        ${GOLDEN_DIR} (five files copied from ${donor_id}, its scenario_id"
echo "        rewritten) makes 'cargo test -p fabrico-core --test corpus_registration'"
echo "        redden NAMING that directory; the guard is green with nothing planted and"
echo "        green again after the revert, and this run left zero residue."
exit 0
