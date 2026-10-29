#!/usr/bin/env bash
#
# `scripts/check-toolchain-pin.sh` ACTUALLY BITES - proved on the mismatch route THAW-10
# names, on the pin file itself, and on both of its could-not-assert paths (Phase 70 plan
# 70-02, `70-CONTEXT.md` D-08, ruling R-8).
#
# ---------------------------------------------------------------------------------
# IT RUNS IN A PRIVATE WORKTREE (phase 84 plan 06, GATE-03, decision D-08).
#
# Every probe below edits, empties or moves away `rust-toolchain.toml`, a tracked file the
# gate reads by its fixed name, so no untracked file can stand in for it. Concurrent
# processes may share this checkout; editing the pin there and restoring it afterwards would
# discard an edit saved to it mid-run, and for the length of the run every cargo command
# another process started would see a wrong or missing pin.
#
# So this is Shape B of scripts/lib/prover-isolation.sh: after argument parsing,
# `prover_run_in_worktree` checks HEAD out into a detached worktree, applies the caller's
# uncommitted tracked diff over it, and re-runs this script there. Every edit, the move
# away and the move back happen in that worktree; the pin file's bytes are kept at entry
# and every restore puts those bytes back, never git's copy. The worktree is removed at
# exit whatever the outcome.
#
# THE WORKTREE SITS OUTSIDE THIS CHECKOUT (under ${TMPDIR:-/tmp}), and that matters here
# in particular: rustup looks for a `rust-toolchain.toml` in the current directory and
# then in each parent. A worktree nested inside the checkout would find the OUTER pin
# file the moment step 8 moved its own away, and the pin-absent probe would measure the
# wrong file. From outside, the upward search never reaches the outer checkout's pin.
#
# THE TREE NO LONGER HAS TO BE CLEAN. The old whole-tree guard (and its advice to commit
# unrelated churn first) existed because the pin file was restored with
# a checkout in the shared tree. In a private worktree an uncommitted edit is part of the
# tree under proof; the match case (step 1) is what reddens if it moves the pin.
# ---------------------------------------------------------------------------------
#
# WHY THIS EXISTS AT ALL. The gate it proves is a version COMPARISON, and a comparison
# gate is easy to make vacuous in a way nobody notices: two strings that are never
# actually read compare equal to each other forever, and a green run looks identical
# whether the pin matched or the read returned two empty strings. This project's
# signature defect class is checks that cannot fail - fourteen found historically, eight
# in a single phase - and "compare a parsed value against a parsed value" is exactly that
# shape. Acceptance is therefore this script's EXIT CODE, never a source grep, which is
# the contract `scripts/prove-dev-pace-switch-absent-non-vacuous.sh` opens with (and the
# freeze prover did, until phase 84 plan 06 deleted it with its retired gate).
#
# THE PROVER CONTAINS NO VERSION LITERAL, DELIBERATELY. It reads the live pin from
# `check-toolchain-pin.sh --print-pin` and MINTS its mismatch value from that pin at run
# time (one minor below it). Two reasons, both load-bearing:
#
#   - A transcribed version goes stale the first time the pin moves, and a prover
#     asserting a 1.98 gate while probing with a 1.96 literal is the same defect it
#     exists to catch, pointed at itself.
#   - A minted mismatch cannot accidentally BE the pin. A hardcoded probe value that
#     happened to equal the pin would make property 2 assert exit 1 against a matching
#     pair, and the prover would report NOT PROVEN for a gate that is working - or, if
#     the sign were the other way round, PROVEN for one that is not.
#
# WHAT IS ASSERTED, in a fixed order:
#
#   1. MATCH CASE GREEN. With nothing perturbed the gate exits 0. Every red below is
#      measured against this, and it is re-asserted before the first tree mutation
#      (step 3) so a red at step 4 cannot be residue from step 2.
#
#   2. THE `RUSTUP_TOOLCHAIN` OVERRIDE - THAW-10's named mismatch route, and the one
#      that works on a machine with no rustup at all. Two separate assertions, both
#      required: the gate exits EXACTLY 1 (not "non-zero" - exit 2 is could-not-assert
#      and a prover that accepted non-zero would pass against a gate that had stopped
#      parsing anything), and its combined output NAMES BOTH versions. Naming one leaves
#      the reader unable to tell which end moved, which is the whole point of the gate.
#
#   3/4/5. THE PIN FILE ITSELF. A throwaway edit moves `rust-toolchain.toml`'s channel
#      off the active toolchain; the gate must exit EXACTLY 1 naming both versions; the
#      edit is reverted and the gate is green again. This is the T-70-13 probe: it is the
#      edit someone would make to force a mismatch through, and it must not pass.
#
#      HOW STEP 4 HOLDS THE ACTIVE TOOLCHAIN, per machine (fixed 2026-09-30, quick
#      260930-ace, todo 2026-09-29-ubuntu-toolchain-pin-prover-red). Two routes:
#        - NO RUSTUP (the pin file is inert): the gate reads `cargo --version` from PATH,
#          which the edit cannot move, so the edit alone is a real file-versus-compiler
#          mismatch. Unchanged from the original step.
#        - RUSTUP PRESENT: `cargo` is a rustup proxy that selects, and with rustup's
#          default auto-install DOWNLOADS, whatever channel the edited file names. So the
#          edit moved the compiler too, `cargo --version` reported the minted channel,
#          the gate correctly saw a MATCHED pair and exited 0, and this step reported
#          NOT PROVEN on every rustup runner. That was the ubuntu CI red. Reproduced
#          locally with rustup 1.29.1 in a scratch RUSTUP_HOME: the gate exits 0 on the
#          edited pin with NO earlier step having installed the minted channel, so the
#          install was not step 2's doing. With RUSTUP_AUTO_INSTALL=0 it exits 2 (no
#          compiler for the edited pin), which is not a mismatch either. The step now
#          holds the running toolchain at the REAL pin with RUSTUP_TOOLCHAIN for this one
#          gate run, so the file says one channel and the compiler is another, which is
#          the mismatch the step exists to show. The gate must still exit EXACTLY 1 and
#          name both, and a gate that stopped reading the pin file, or compared the
#          active toolchain against itself, still exits 0 here and reddens this step.
#          Nothing is downloaded by this step on that route.
#
#   6/7. THE CHANNEL LINE UNREADABLE. The `channel` line is removed from the pin file and
#      the gate must exit EXACTLY 2, not 0. A pin that reads as the empty string compares
#      unequal to everything and would exit 1, or - worse, if the comparison were written
#      the other way - equal to another empty read and exit 0. Exit 2 is the only honest
#      answer and this is the probe that proves the gate gives it.
#
#   8/9. THE PIN FILE ABSENT. Same contract, different cause: the file is moved away and
#      the gate must exit EXACTLY 2 with "the assertion could not be made".
#
#   10. THE GATE'S OWN NAMED READ. `PINNED_CHANNEL_BLOCK` must still resolve to a
#      non-empty channel and still declare its expected number of entries. This closes
#      the same blind spot the freeze prover's fourth assertion does: the gate cannot see
#      an edit to its own read, so a block narrowed to nothing would go green while
#      measuring nothing, and only something OUTSIDE the gate can say so.
#
#   11. RESIDUE. The run left the worktree exactly as it found it.
#
# EVERY MUTATION IS TO ONE TRACKED FILE, `rust-toolchain.toml`, in the private worktree,
# restored from its kept bytes. The file is two lines of TOML and every throwaway state
# written here is still valid TOML, so even an abort between the write and the restore
# leaves a parseable file rather than a broken build.
#
# EXIT CODES:
#   0  PROVEN. All the properties above held.
#   1  A property did NOT hold. The gate is vacuous, or weaker than claimed. Every
#      failing property is named.
#   2  The proof COULD NOT BE MADE. A FAILURE, not a pass. The classes:
#        - the gate script is absent (this is what a run before the gate exists reports)
#        - `--print-pin` emitted nothing, or a channel whose minor cannot be parsed
#        - `RUSTUP_TOOLCHAIN` was already set in the caller's environment, so there is no
#          unperturbed baseline to measure against
#        - the gate's baseline output carried no readable `active toolchain: <version>`,
#          so step 4's naming assertion would have had to assume one
#        - `rust-toolchain.toml` is missing or untracked
#        - a revert did not restore the file
#        - this run left the worktree different from its entry state (the closing
#          assertion)
#        - the private worktree could not be made or removed (the helper)

set -euo pipefail

# The isolation helper is sourced before any change of directory, so it can locate this
# script as it was invoked. It owns the only EXIT trap this script has.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source-path=SCRIPTDIR source=lib/prover-isolation.sh
. "${SCRIPT_DIR}/lib/prover-isolation.sh"

# Resolve repo root so this works from any cwd, exactly as the gate does.
cd "$(git rev-parse --show-toplevel)"

GATE="scripts/check-toolchain-pin.sh"
PIN_FILE="rust-toolchain.toml"

# The number of entries `--print-block` must emit. Stated here and in the gate, and
# asserted at step 10: a gate that quietly dropped an entry from its own read would
# otherwise keep reporting green over a narrower read than the one documented.
EXPECTED_BLOCK_ENTRIES=3

usage() {
    cat >&2 <<'USAGE'
usage: bash scripts/prove-toolchain-pin-bites.sh

Proves that scripts/check-toolchain-pin.sh actually BITES: that it refuses a toolchain
which is not the pinned one, on the two routes a mismatch can arrive by, and that it
exits 2 rather than 0 when it cannot read the pin at all.

  1.     match case green (re-asserted before the first tree mutation)
  2.     RUSTUP_TOOLCHAIN override -> exit EXACTLY 1, BOTH versions named
  3-5.   a throwaway rust-toolchain.toml edit -> exit EXACTLY 1, both named, then revert
  6-7.   the channel line removed -> exit EXACTLY 2, then revert
  8-9.   the pin file absent -> exit EXACTLY 2, then restore
  10.    the gate's own PINNED_CHANNEL_BLOCK still resolves to a non-empty channel
  11.    residue: the run left the worktree exactly as it found it

  --help, -h   this message

It runs in a private worktree outside this checkout (HEAD plus your uncommitted tracked
edits), so it never writes your rust-toolchain.toml and the tree does not have to be
clean. RUSTUP_TOOLCHAIN must NOT be set in the calling environment: with an override
already in force there is no unperturbed baseline for step 1 to measure.

Exit codes:
  0  proven
  1  a property did not hold; every failure is named
  2  the proof could not be made. This is a FAILURE, not a pass.
USAGE
}

# A function, so the parse does not consume the script's own arguments: the private
# worktree run below is handed them unchanged.
parse_args() {
    while [ $# -gt 0 ]; do
        case "$1" in
            -h | --help)
                usage
                exit 0
                ;;
            *)
                echo "FAIL: unknown argument '$1'." >&2
                usage
                exit 2
                ;;
        esac
    done
}
parse_args "$@"

# --- Into the private worktree ----------------------------------------------------------
# In the caller this does not return: it runs this script again inside the worktree and
# exits with that run's code. Inside, it returns and the proof goes on.
prover_run_in_worktree "$@"

# --- Guard A: the gate exists -------------------------------------------------------
if [ ! -f "$GATE" ]; then
    echo "FAIL: the gate '${GATE}' does not exist, so there is nothing to prove." >&2
    echo "This proof cannot be made." >&2
    exit 2
fi

# --- Guard B: no override may already be in force ------------------------------------
# Step 1 measures the gate with nothing perturbed. If the caller's environment already
# carries RUSTUP_TOOLCHAIN, "nothing perturbed" is not a state this run can reach, and a
# baseline taken under someone else's override is a baseline of the wrong thing.
if [ -n "${RUSTUP_TOOLCHAIN:-}" ]; then
    echo "FAIL: RUSTUP_TOOLCHAIN is already set to '${RUSTUP_TOOLCHAIN}' in this" >&2
    echo "environment, so there is no unperturbed baseline for step 1 to measure and" >&2
    echo "step 2's override would not be an override of anything. Unset it and re-run." >&2
    echo "This proof cannot be made." >&2
    exit 2
fi

# --- Guard C: the pin file exists and is TRACKED ---------------------------------------
if [ ! -f "$PIN_FILE" ]; then
    echo "FAIL: '${PIN_FILE}' does not exist. It is the file every probe below mutates." >&2
    echo "This proof cannot be made." >&2
    exit 2
fi
if ! git ls-files --error-unmatch "$PIN_FILE" >/dev/null 2>&1; then
    echo "FAIL: '${PIN_FILE}' is not TRACKED, so it is not the pin this repository ships" >&2
    echo "and proving the gate against it would prove nothing about that pin." >&2
    echo "This proof cannot be made." >&2
    exit 2
fi

# --- The entry state, the kept bytes, and the scratch directory ------------------------
# The worktree may carry the caller's uncommitted tracked edits (that is the tree under
# proof), so "clean" is not the reference: the state at entry is. Its tracked status and
# its untracked files under a source tree are recorded here and the pin file's bytes are
# kept; every revert puts those bytes back and the closing residue assertion compares
# against all three. Untracked dirt is read under the source trees only, honouring
# .gitignore. The scratch directory sits outside the worktree and is removed through the
# helper at exit.
SOURCE_TREES=(
    "crates"
    "frontend"
    "scripts"
    "docs"
)
entry_tracked="$(git status --porcelain | grep -v '^??' || true)"
entry_untracked_src="$(git ls-files --others --exclude-standard -- "${SOURCE_TREES[@]}")"
prover_keep_bytes "$PIN_FILE"

SCRATCH="$(mktemp -d)" || {
    echo "FAIL: could not create a temporary directory. This proof cannot be made." >&2
    exit 2
}
# shellcheck disable=SC2329 # run by the helper's exit trap, through prover_on_exit
remove_scratch() {
    rm -rf "$SCRATCH" 2>/dev/null || true
}
prover_on_exit remove_scratch

# --- Guard E: read the LIVE pin from the gate, and MINT the mismatch from it ----------
# Never a transcription. See the header for both reasons.
PINNED_CHANNEL="$(bash "$GATE" --print-pin 2>/dev/null || true)"
PINNED_CHANNEL="$(printf '%s' "$PINNED_CHANNEL" | head -1 | tr -d '[:space:]')"
if [ -z "$PINNED_CHANNEL" ]; then
    echo "FAIL: '${GATE} --print-pin' emitted nothing, so this run has no pin to mint a" >&2
    echo "mismatch from and no value to assert the gate names. This proof cannot be made." >&2
    exit 2
fi

PINNED_MINOR="$(printf '%s' "$PINNED_CHANNEL" | sed -E -n 's/^1\.([0-9]+)(\..*)?$/\1/p')"
if [ -z "$PINNED_MINOR" ] || [ "$PINNED_MINOR" -lt 2 ] 2>/dev/null; then
    echo "FAIL: the pin '${PINNED_CHANNEL}' does not parse as 1.<minor>[.<patch>] with a" >&2
    echo "minor above 1, so this run cannot mint a DIFFERENT channel to probe with." >&2
    echo "A probe value that might equal the pin proves nothing either way." >&2
    echo "This proof cannot be made." >&2
    exit 2
fi
MISMATCH_CHANNEL="1.$((PINNED_MINOR - 1)).0"

echo "pin under proof: ${PINNED_CHANNEL}   minted mismatch: ${MISMATCH_CHANNEL}"

# --- Helpers ---------------------------------------------------------------------------
# Runs the gate capturing combined stdout+stderr and the exit code WITHOUT tripping
# `set -e`. `set -e` would abort on the deliberate exit-1 and exit-2 runs, which are the
# runs this whole script exists to observe.
GATE_OUT=""
GATE_RC=0
run_gate() {
    GATE_OUT=""
    GATE_RC=0
    GATE_OUT="$(bash "$GATE" "$@" 2>&1)" || GATE_RC=$?
}
run_gate_under() {
    local toolchain="$1"
    shift
    GATE_OUT=""
    GATE_RC=0
    GATE_OUT="$(RUSTUP_TOOLCHAIN="$toolchain" bash "$GATE" "$@" 2>&1)" || GATE_RC=$?
}

failed=0
STEP=0
TOTAL=11 # 1 match case + 1 override probe + 1 re-asserted baseline + 2 pin-edit steps
         # + 2 channel-removed steps + 2 pin-absent steps + the named-read assertion
         # + the residue assertion. Counted rather than estimated: a step counter that
         # overruns its own total is a number that does not mean what it says, which is
         # the defect class this whole script exists to catch.

step() {
    STEP=$((STEP + 1))
    printf '[%2d/%d] %s\n' "$STEP" "$TOTAL" "$1"
}

fail() {
    echo "  FAIL: $1" >&2
    failed=1
}

# Asserts the gate's captured output names BOTH versions. Split out because it is the
# assertion THAW-10 cares about more than the exit code: an exit code cannot tell the
# reader which end moved.
assert_names_both() {
    local expected_other="$1"
    local what="$2"
    if ! printf '%s' "$GATE_OUT" | grep -F -- "$PINNED_CHANNEL" >/dev/null; then
        fail "${what}: the gate did not name the PINNED channel '${PINNED_CHANNEL}'. Without it the reader cannot tell whether the pin moved or the toolchain did."
        printf '%s\n' "$GATE_OUT" | sed 's/^/    /' >&2
    fi
    if ! printf '%s' "$GATE_OUT" | grep -F -- "$expected_other" >/dev/null; then
        fail "${what}: the gate did not name the ACTIVE version '${expected_other}'. Naming only the pin leaves the reader unable to tell which end moved."
        printf '%s\n' "$GATE_OUT" | sed 's/^/    /' >&2
    fi
}

# Writes the pin file with `channel` set to $1, preserving every other line. Written
# through a scratch file and `cat` rather than `sed -i` (whose -i suffix handling differs
# between GNU and BSD) and rather than `mv` (which would replace the inode and drop the
# file's mode).
write_channel() {
    local channel="$1"
    awk -v ch="$channel" '
        /^[[:space:]]*channel[[:space:]]*=/ { sub(/"[^"]*"/, "\"" ch "\"") }
        { print }
    ' "$PIN_FILE" > "${SCRATCH}/pin.toml"
    cat "${SCRATCH}/pin.toml" > "$PIN_FILE"
}

revert_pin() {
    prover_put_back "$PIN_FILE"
    if ! prover_same_as_kept "$PIN_FILE"; then
        fail "'${PIN_FILE}' differs from its kept bytes after the revert. Every later assertion in this run is now measuring residue."
    fi
}

# --- 1. The match case ------------------------------------------------------------------
step "match case: the gate exits 0 with nothing perturbed"
run_gate
if [ "$GATE_RC" -ne 0 ]; then
    fail "the gate exits ${GATE_RC} with NOTHING perturbed, so every red below would prove nothing. rc=2 means it could not parse the pin or the active version; rc=1 means the pin and this machine's toolchain genuinely disagree, which is a real finding and not a prover defect."
    printf '%s\n' "$GATE_OUT" | sed 's/^/    /' >&2
else
    echo "       exit 0 (correct): $(printf '%s' "$GATE_OUT" | grep -i '^OK' | head -1)"
fi

# --- 2. THAW-10's named mismatch route ---------------------------------------------------
step "RUSTUP_TOOLCHAIN=${MISMATCH_CHANNEL}: the gate must exit EXACTLY 1 and NAME BOTH versions"
run_gate_under "$MISMATCH_CHANNEL"
if [ "$GATE_RC" -ne 1 ]; then
    fail "the gate exited ${GATE_RC} under an overriding toolchain, expected EXACTLY 1. Exit 0 means the override rode in green and the gate cannot refuse a verdict from the wrong compiler at all; exit 2 means it refused to assert instead of asserting a mismatch."
    printf '%s\n' "$GATE_OUT" | sed 's/^/    /' >&2
else
    echo "       exit 1 (correct)"
fi
assert_names_both "$MISMATCH_CHANNEL" "RUSTUP_TOOLCHAIN override"

# --- 3. Baseline re-asserted before the first tree mutation --------------------------------
# Steps 1 and 2 perturbed nothing on disk, but everything from here does. Re-asserting the
# baseline immediately before the first write is what lets a red at step 4 be attributed to
# step 4's edit rather than to something that arrived in between.
step "baseline re-asserted (not inherited) immediately before the first tree mutation"
run_gate
if [ "$GATE_RC" -ne 0 ]; then
    fail "the gate exits ${GATE_RC} before any file was touched. The probes below would be measured against a baseline that is not green."
    printf '%s\n' "$GATE_OUT" | sed 's/^/    /' >&2
fi

# THE ACTIVE VERSION IS READ OUT OF THE BASELINE ABOVE, NEVER ASSUMED TO EQUAL THE PIN.
# This line used to be `ACTIVE_BEFORE_EDIT="$PINNED_CHANNEL"`, which conflated the pinned
# STRING with the version the machine is actually running. The gate compares MINOR
# components only, on purpose (`check-toolchain-pin.sh`: the pin says 1.98.0, a runner may
# install 1.98.1, and refusing that would make the gate red for a reason nobody chose), so
# a runner in exactly that tolerated configuration prints `active toolchain: 1.98.1` while
# the old line grepped step 4's output for `1.98.0`, missed it, and declared a WORKING gate
# "vacuous, or weaker than it claims". A false NOT PROVEN on the configuration the gate was
# designed to accept. Read the value the gate itself reported instead.
ACTIVE_BEFORE_EDIT="$(printf '%s' "$GATE_OUT" |
    sed -n 's/.*active toolchain: \([0-9][0-9.]*\).*/\1/p' | head -1)"
if [ -z "$ACTIVE_BEFORE_EDIT" ]; then
    echo "FAIL: could not read an active toolchain version out of the gate's own baseline" >&2
    echo "output, so step 4 below has no ACTIVE value to assert the gate names alongside" >&2
    echo "the edited pin. Substituting the pin for it is the defect this read replaces, and" >&2
    echo "asserting nothing there would leave step 4 checking half of what it claims." >&2
    echo "The baseline output was:" >&2
    printf '%s\n' "$GATE_OUT" | sed 's/^/    /' >&2
    echo "This proof cannot be made." >&2
    exit 2
fi

# --- 4/5. The pin file edited (T-70-13) -----------------------------------------------------
# See the header, step 3/4/5, for why the two routes differ. The route is chosen with the
# same test the gate itself uses to decide whether the pin file steers the compiler
# (`command -v rustup`), so the prover and the gate cannot disagree about which machine
# they are on.
if command -v rustup >/dev/null 2>&1; then
    STEP4_ROUTE="rustup present: the running toolchain is held at the real pin ${PINNED_CHANNEL} with RUSTUP_TOOLCHAIN, because the rustup proxy would otherwise select the edited channel"
    STEP4_ACTIVE="$PINNED_CHANNEL"
else
    STEP4_ROUTE="no rustup: the pin file is inert and the gate reads cargo --version from PATH"
    STEP4_ACTIVE="$ACTIVE_BEFORE_EDIT"
fi
step "throwaway pin edit to ${MISMATCH_CHANNEL}: the gate must exit EXACTLY 1 and NAME BOTH versions"
echo "       route: ${STEP4_ROUTE}"
write_channel "$MISMATCH_CHANNEL"
if command -v rustup >/dev/null 2>&1; then
    run_gate_under "$PINNED_CHANNEL"
else
    run_gate
fi
if [ "$GATE_RC" -ne 1 ]; then
    fail "the gate exited ${GATE_RC} with '${PIN_FILE}' pinning ${MISMATCH_CHANNEL} while the running toolchain is ${STEP4_ACTIVE}, expected EXACTLY 1. This is the edit someone would make to force a mismatch through; if it passes, the pin file is not a pin."
    printf '%s\n' "$GATE_OUT" | sed 's/^/    /' >&2
else
    echo "       exit 1 (correct)"
fi
if ! printf '%s' "$GATE_OUT" | grep -F -- "$MISMATCH_CHANNEL" >/dev/null; then
    fail "the gate did not name the edited pin '${MISMATCH_CHANNEL}' in its output."
    printf '%s\n' "$GATE_OUT" | sed 's/^/    /' >&2
fi
if ! printf '%s' "$GATE_OUT" | grep -F -- "$STEP4_ACTIVE" >/dev/null; then
    fail "the gate did not name the ACTIVE version '${STEP4_ACTIVE}' alongside the edited pin. Naming only one end leaves the reader unable to tell which moved."
    printf '%s\n' "$GATE_OUT" | sed 's/^/    /' >&2
fi

step "revert clean: the pin file is restored and the gate is green again"
revert_pin
run_gate
if [ "$GATE_RC" -ne 0 ]; then
    fail "the gate exits ${GATE_RC} after the revert; the pin edit left residue somewhere."
    printf '%s\n' "$GATE_OUT" | sed 's/^/    /' >&2
fi

# --- 6/7. The channel line unreadable --------------------------------------------------------
step "channel line removed: the gate must exit EXACTLY 2, NOT 0"
grep -v '^[[:space:]]*channel[[:space:]]*=' "$PIN_FILE" > "${SCRATCH}/nochannel.toml"
cat "${SCRATCH}/nochannel.toml" > "$PIN_FILE"
run_gate
if [ "$GATE_RC" -ne 2 ]; then
    fail "the gate exited ${GATE_RC} with no readable channel line, expected EXACTLY 2. A pin that reads as the empty string is not a pin that matched; an assertion that measures nothing must never report green, and exit 1 would be a mismatch finding the gate has no basis for either."
    printf '%s\n' "$GATE_OUT" | sed 's/^/    /' >&2
else
    echo "       exit 2 (correct): $(printf '%s' "$GATE_OUT" | grep -i 'could not be made' | head -1 | sed 's/^ *//')"
fi
if ! printf '%s' "$GATE_OUT" | grep -i 'could not be made' >/dev/null; then
    fail "the gate exited 2 without saying 'the assertion could not be made'. The phrase is what tells a reader this is a could-not-assert and not a finding."
fi

step "revert clean: the channel line is restored and the gate is green again"
revert_pin
run_gate
if [ "$GATE_RC" -ne 0 ]; then
    fail "the gate exits ${GATE_RC} after restoring the channel line."
    printf '%s\n' "$GATE_OUT" | sed 's/^/    /' >&2
fi

# --- 8/9. The pin file absent ------------------------------------------------------------------
step "pin file moved away: the gate must exit EXACTLY 2, NOT 0"
mv "$PIN_FILE" "${SCRATCH}/pin.away"
run_gate
if [ "$GATE_RC" -ne 2 ]; then
    fail "the gate exited ${GATE_RC} with '${PIN_FILE}' absent, expected EXACTLY 2. With no pin file there is no pin, and a gate that reports green over a missing pin is asserting nothing at all."
    printf '%s\n' "$GATE_OUT" | sed 's/^/    /' >&2
else
    echo "       exit 2 (correct): $(printf '%s' "$GATE_OUT" | grep -i 'could not be made' | head -1 | sed 's/^ *//')"
fi
if ! printf '%s' "$GATE_OUT" | grep -i 'could not be made' >/dev/null; then
    fail "the gate exited 2 without saying 'the assertion could not be made'."
fi

step "restore clean: the pin file is back and the gate is green again"
mv "${SCRATCH}/pin.away" "$PIN_FILE"
revert_pin
run_gate
if [ "$GATE_RC" -ne 0 ]; then
    fail "the gate exits ${GATE_RC} after the pin file was put back."
    printf '%s\n' "$GATE_OUT" | sed 's/^/    /' >&2
fi

# --- 10. The gate's own named read ---------------------------------------------------------------
# The gate cannot see an edit to its own PINNED_CHANNEL_BLOCK: the block IS the read, so a
# block narrowed to nothing makes the read return nothing and the comparison compare
# nothing. Only something outside the gate can say the read is still there. Re-read here
# rather than reusing the value captured at guard E, so a gate whose read changed mid-run is
# visible.
step "the gate's PINNED_CHANNEL_BLOCK still resolves, and still declares ${EXPECTED_BLOCK_ENTRIES} entries"
recheck_pin="$(bash "$GATE" --print-pin 2>/dev/null | head -1 | tr -d '[:space:]' || true)"
if [ -z "$recheck_pin" ]; then
    fail "'${GATE} --print-pin' now emits nothing. The gate's read of the pin has been broken or narrowed away, and every comparison it makes is now between two values it did not read."
else
    block_entries="$(bash "$GATE" --print-block 2>/dev/null | grep -c . || true)"
    if [ "$block_entries" -ne "$EXPECTED_BLOCK_ENTRIES" ]; then
        fail "'${GATE} --print-block' emits ${block_entries} entry/entries, expected ${EXPECTED_BLOCK_ENTRIES}. An entry dropped from the block is a read narrowed silently, which is the shape of a gate that reports green over less than it claims."
    else
        echo "       pin '${recheck_pin}' read through ${block_entries} declared block entries"
    fi
fi

# --- 11. Residue ------------------------------------------------------------------------------------
# The entry state again, on the way out. This script must not be able to leave residue AND
# report PROVEN; a probe that survived would mean every later verdict measured a wrong pin.
step "residue: this run left the worktree exactly as it found it"
tracked_out="$(git status --porcelain | grep -v '^??' || true)"
untracked_src_out="$(git ls-files --others --exclude-standard -- "${SOURCE_TREES[@]}")"
pin_moved=0
prover_same_as_kept "$PIN_FILE" || pin_moved=1
if [ "$tracked_out" != "$entry_tracked" ] || [ "$untracked_src_out" != "$entry_untracked_src" ] \
    || [ "$pin_moved" -eq 1 ]; then
    echo "FAIL: this run left RESIDUE in the worktree." >&2
    [ "$tracked_out" != "$entry_tracked" ] && printf '%s\n' "$tracked_out" | sed 's/^/    tracked now: /' >&2
    [ "$untracked_src_out" != "$entry_untracked_src" ] && printf '%s\n' "$untracked_src_out" | sed 's/^/    untracked now: /' >&2
    [ "$pin_moved" -eq 1 ] && echo "    not its kept bytes: ${PIN_FILE}" >&2
    echo "A prover that cannot clean up after itself cannot be trusted to have measured" >&2
    echo "what it says it measured. This is exit 2, not a pass." >&2
    exit 2
fi

echo
if [ "$failed" -ne 0 ]; then
    echo "NOT PROVEN: at least one property did not hold (named above)." >&2
    echo "The toolchain pin check is vacuous, or weaker than it claims." >&2
    exit 1
fi

echo "PROVEN: ${GATE} refuses a toolchain that is not the pinned one, on the"
echo "RUSTUP_TOOLCHAIN route and on the pin file itself, names BOTH versions when it"
echo "does, and exits 2 rather than 0 when it cannot read the pin at all."
exit 0
