#!/usr/bin/env bash
#
# `scripts/check-dev-pace-switch-absent.sh` ACTUALLY BITES - proved per token, not once
# (Phase 68 plan 68-07, `68-CONTEXT.md` D-68-13's non-vacuity requirement as AMENDED by
# D-68-18, BELT-05).
#
# ---------------------------------------------------------------------------------
# IT RUNS IN A PRIVATE WORKTREE (phase 84 plan 06, GATE-03, decision D-08).
#
# Every probe below appends a line to one of five EXISTING TRACKED files, and that cannot
# be changed: the gate builds its scan set from `git ls-files`, so an untracked probe file
# is never searched and would prove nothing. Shape A of scripts/lib/prover-isolation.sh
# (untracked probes) therefore cannot serve. Other processes may share this checkout, and
# appending to `frontend/src/chrome/App.tsx` there and restoring it afterwards would
# discard any edit saved to it mid-run; it would also push each probe
# through any running Vite dev server as a hot reload.
#
# So this is Shape B: after argument parsing, `prover_run_in_worktree` checks HEAD out
# into a detached worktree outside this checkout, applies the caller's uncommitted
# tracked diff over it, and re-runs this script there. Every probe and restore happens in
# that worktree; each probe file's bytes are kept at entry and put back from those bytes,
# never from git. The worktree is removed at exit whatever the outcome.
#
# THE TREE NO LONGER HAS TO BE CLEAN. The old whole-tree guard (and its advice to commit
# unrelated churn first) existed because the probes were restored with a
# checkout in the shared tree. In a private worktree an uncommitted edit is simply part
# of the tree under proof. If such an edit carries one of the tokens, property 1 (baseline
# green, re-asserted before every probe) is what reddens, which is the gate's real verdict
# on the tree as it stands.
# ---------------------------------------------------------------------------------
#
# WHY THIS EXISTS AT ALL. The gate it proves is a grep for an ABSENCE, and an absence
# gate is the single easiest thing in this repository to make vacuous: a grep that
# matches nothing because the pattern is wrong is INDISTINGUISHABLE from a grep that
# matches nothing because the code is gone. This project's signature defect class is
# checks that cannot fail - six found historically and eight more in phase 67 alone - and
# a five-token absence assertion is exactly that shape. Acceptance is therefore this
# script's EXIT CODE, never a source grep, which is the same contract
# `scripts/determinism-gate-negative-test.sh` opens with (and the freeze prover did, until
# phase 84 plan 06 deleted it with its retired gate).
#
# FIVE PROBES, ONE PER TOKEN, AND THAT IS D-68-18's EXPLICIT REQUIREMENT. A prover that
# probes one token proves nothing about the other four, so the widening from three tokens
# to five would itself be unproven. Each token gets its own probe, in its own file.
#
# THE PROVER CONTAINS NO TOKEN LITERALLY, DELIBERATELY. It reads the live list from
# `check-dev-pace-switch-absent.sh --print-tokens`. Two reasons, both load-bearing:
#
#   - If this script spelled the five tokens out, the gate would find them here and the
#     only fix would be to EXCLUDE this script - a SECOND exclusion, on a gate whose whole
#     design is that its exclusion list is exactly one principled entry. Reading the
#     list is what keeps that promise.
#   - A transcribed list can drift from the gate's real one. A prover asserting a
#     five-token gate reddens while silently probing a four-token copy of the list is the
#     same defect it exists to catch, pointed at itself.
#
# WHAT IS ASSERTED, per token, in a FIXED order:
#
#   1. BASELINE GREEN. With no probe applied, the gate exits 0. This is re-asserted
#      before EVERY probe rather than once at the start, and the freeze prover's reason
#      applies here identically: it is what catches a FAILED REVERT from the previous
#      probe, which would otherwise present as a probe that reddened for the wrong token.
#
#   2. PROBE RED, AND NAMED - TWO SEPARATE ASSERTIONS, BOTH REQUIRED. A throwaway edit
#      to an EXISTING TRACKED FILE that the gate scans, then:
#        a. the gate exits EXACTLY 1. Not "non-zero". Exit 1 means a token was FOUND;
#           exit 2 means the gate could not assert. A non-zero exit alone cannot
#           distinguish the token check firing on the probe from the floor or the
#           positive control firing on something unrelated, and a prover that accepted
#           "non-zero" would pass against a gate that had stopped working entirely.
#        b. its combined stdout+stderr NAMES that exact path. D-68-13 requires the gate
#           to name the offending path, and an exit code cannot carry that.
#
#   3. REVERT CLEAN. The file is restored, `git diff` on it is empty, and the gate is
#      green again - so the proof leaves no residue and a failed revert is caught here
#      rather than carried into the next token's probe.
#
# THEN TWO PROBES THE FREEZE PROVER HAS NO EQUIVALENT FOR, because this gate has two
# failure modes the freeze gate does not, and both are COULD-NOT-ASSERT rather than
# FOUND:
#
#   6. THE FLOOR. The scan set is driven below its floor and the gate must exit 2, not 0.
#      A scan of zero files greps clean, and the floor is the only thing standing between
#      that and a confident green over nothing.
#   7. THE POSITIVE CONTROL. The control token is made unfindable and the gate must exit
#      2. A control that is not found means the search is not measuring, and a zero
#      result for the five tokens would be meaningless.
#
# Both are driven through the gate's own `--min-scan-files` / `--positive-control`
# overrides rather than by mutating the tree, so neither probe can leave residue. The
# distinction between exit 1 and exit 2 is the entire point of the gate's contract, so a
# prover that only ever observed exit 1 would not have tested it.
#
# FINALLY, AN EIGHTEENTH ASSERTION that closes the same blind spot the freeze prover's
# fourth one does: the gate's live token list must still hold exactly five entries, and
# every one of them must have been probed above. A prover that silently probed three of
# five would report PROVEN while the widening stayed unproven.
#
# EVERY PROBE IS A SINGLE APPENDED COMMENT LINE, in a file whose comment syntax makes
# that harmless. The freeze prover's reason is worth repeating in substance: even an
# abort between the write and the restore must leave a syntactically valid file rather
# than a broken build (here, in the private worktree that is about to be removed).
#
# EXIT CODES:
#   0  PROVEN. Three properties held for each of the five tokens, both could-not-assert
#      paths exit 2, and the gate's token list still holds all five.
#   1  A property did NOT hold. The gate is vacuous, or weaker than claimed, on at least
#      one token. Every failing property is named.
#   2  The proof COULD NOT BE MADE. A FAILURE, not a pass. The classes:
#        - the gate script is absent, or `--print-tokens` did not emit five tokens
#        - a probe file does not exist, or is not tracked
#        - a revert did not restore a file
#        - this run left the worktree different from its entry state (the closing
#          residue assertion)
#        - the private worktree could not be made or removed (the helper)

set -euo pipefail

# The isolation helper is sourced before any change of directory, so it can locate this
# script as it was invoked. It owns the only EXIT trap this script has.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source-path=SCRIPTDIR source=lib/prover-isolation.sh
. "${SCRIPT_DIR}/lib/prover-isolation.sh"

# Resolve repo root so this works from any cwd, exactly as the gate does.
cd "$(git rev-parse --show-toplevel)"

GATE="scripts/check-dev-pace-switch-absent.sh"

# ---------------------------------------------------------------------------------
# THE PROBE FILES, index-aligned with the gate's own token order.
# ---------------------------------------------------------------------------------
# Five DIFFERENT files on purpose: a single shared probe file could not tell a failed
# revert apart from a token that reddens for the wrong reason, and property 1's
# re-assertion before every probe is what makes the per-file separation pay off.
#
#   1 -> crates/fabrico-host/src/driver.rs
#        The live host seam. Rust `//`. Not a gate's scan corpus.
#   2 -> frontend/src/render/loop.ts
#        The renderer's loop. TypeScript `//`. Chosen to prove the FRONTEND half of the
#        tree is scanned, not only `crates/`.
#   3 -> scripts/check-neutrality.sh
#        A SIBLING GATE SCRIPT, and the most important probe in the list. It proves that
#        `scripts/` is inside the scan set - i.e. that the gate excludes ITSELF by exact
#        path and not its whole directory. If a future edit widened that exclusion to
#        `scripts/`, this probe is the one that would catch it. Shell `#`.
#   4 -> crates/fabrico-command/src/command.rs
#        The command layer. Rust `//`. A third crate, so the probe set is not confined to
#        one package.
#   5 -> frontend/src/chrome/App.tsx
#        The app shell. TSX `//`. The file the deleted panel used to be mounted from,
#        which makes it the natural place for a reintroduction to begin.
PROBE_FILES=(
    "crates/fabrico-host/src/driver.rs"
    "frontend/src/render/loop.ts"
    "scripts/check-neutrality.sh"
    "crates/fabrico-command/src/command.rs"
    "frontend/src/chrome/App.tsx"
)

# The comment prefix for each probe file, index-aligned. Shell for the gate script, `//`
# for the Rust and TypeScript ones. A probe written with the wrong prefix would leave a
# file that does not parse if the run aborted between write and restore.
PROBE_PREFIX=(
    "//"
    "//"
    "#"
    "//"
    "//"
)

EXPECTED_TOKEN_COUNT=5

usage() {
    cat >&2 <<'USAGE'
usage: bash scripts/prove-dev-pace-switch-absent-non-vacuous.sh

Proves that scripts/check-dev-pace-switch-absent.sh actually BITES, independently for
EACH of its five tokens, and that both of its could-not-assert paths exit 2 rather than
reporting green.

Per token, in a fixed order, three properties:
  1. baseline green   - the gate exits 0 with no probe applied (re-asserted before
                        EVERY probe, which is what catches a failed revert)
  2. probe red, NAMED - a tracked-file edit makes the gate exit EXACTLY 1 and name the
                        offending path. Both halves are asserted separately.
  3. revert clean     - the file is restored and the gate is green again

Then two could-not-assert probes, both asserting exit 2 specifically:
  6. a scan set driven below the floor
  7. a positive control that cannot be found

Then: the gate's live token list still holds five entries, all of them probed.

  --help, -h   this message

It runs in a private worktree (HEAD plus your uncommitted tracked edits), so it never
writes a file in your checkout and the tree does not have to be clean. An uncommitted
edit that carries a token makes property 1 red, which is the gate's verdict on it.

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

# --- Guard A: the gate exists and is readable ---------------------------------------
if [ ! -f "$GATE" ]; then
    echo "FAIL: the gate '${GATE}' does not exist, so there is nothing to prove." >&2
    exit 2
fi

# --- Guard B: read the LIVE token list from the gate itself -------------------------
# Never a transcription. See the header for both reasons.
TOKENS=()
while IFS= read -r line; do
    [ -z "$line" ] && continue
    TOKENS+=("$line")
done < <(bash "$GATE" --print-tokens 2>/dev/null || true)

if [ "${#TOKENS[@]}" -ne "$EXPECTED_TOKEN_COUNT" ]; then
    echo "FAIL: '${GATE} --print-tokens' emitted ${#TOKENS[@]} token(s), expected ${EXPECTED_TOKEN_COUNT}." >&2
    echo "D-68-18 widened this gate from three tokens to five, and requires EACH to be" >&2
    echo "probed in turn or the widening is itself unproven. A prover that silently" >&2
    echo "probed a different number would report PROVEN over a gate nobody had tested." >&2
    echo "This proof cannot be made." >&2
    exit 2
fi

if [ "${#PROBE_FILES[@]}" -ne "${#TOKENS[@]}" ] || [ "${#PROBE_PREFIX[@]}" -ne "${#TOKENS[@]}" ]; then
    echo "FAIL: ${#TOKENS[@]} token(s) but ${#PROBE_FILES[@]} probe file(s) and" >&2
    echo "${#PROBE_PREFIX[@]} comment prefix(es). The three lists are index-aligned by" >&2
    echo "construction; if a token was added to the gate, add its probe here." >&2
    exit 2
fi

# --- Guard C: every probe file exists and is TRACKED ----------------------------------
for probe in "${PROBE_FILES[@]}"; do
    if [ ! -f "$probe" ]; then
        echo "FAIL: probe file '${probe}' does not exist. A probe that cannot be written" >&2
        echo "cannot make the gate red, and a proof over four of five tokens is not the" >&2
        echo "proof D-68-18 asks for." >&2
        exit 2
    fi
    if ! git ls-files --error-unmatch "$probe" >/dev/null 2>&1; then
        echo "FAIL: probe file '${probe}' is not TRACKED. The gate enumerates its scan" >&2
        echo "set from 'git ls-files', so an untracked probe is invisible to it and the" >&2
        echo "probe would silently prove nothing." >&2
        exit 2
    fi
done

# --- The entry state, and the kept bytes ---------------------------------------------
# The worktree may carry the caller's uncommitted tracked edits (that is the tree under
# proof), so "clean" is not the reference: the state at entry is. Its tracked status and
# its untracked files under a source tree are recorded here, and every probe file's bytes
# are kept; the closing residue assertion compares against all three. Untracked dirt is
# read under the source trees only, honouring .gitignore.
SOURCE_TREES=(
    "crates"
    "frontend"
    "scripts"
    "docs"
)
entry_tracked="$(git status --porcelain | grep -v '^??' || true)"
entry_untracked_src="$(git ls-files --others --exclude-standard -- "${SOURCE_TREES[@]}")"
prover_keep_bytes "${PROBE_FILES[@]}"

# --- Helpers -------------------------------------------------------------------------
# Runs the gate with any extra arguments, capturing combined stdout+stderr and the exit
# code WITHOUT tripping `set -e`. `set -e` would abort on the deliberate exit-1 and
# exit-2 runs, which are the runs this whole script exists to observe.
GATE_OUT=""
GATE_RC=0
run_gate() {
    GATE_OUT=""
    GATE_RC=0
    GATE_OUT="$(bash "$GATE" "$@" 2>&1)" || GATE_RC=$?
}

failed=0
STEP=0
TOTAL=19 # 5 tokens x 3 properties, 2 could-not-assert probes, the token-list assertion,
         # and the closing residue assertion. Counted rather than estimated: a step
         # counter that overruns its own total is a number that does not mean what it
         # says, which is the defect class this whole script exists to catch.

step() {
    STEP=$((STEP + 1))
    printf '[%2d/%d] %s\n' "$STEP" "$TOTAL" "$1"
}

fail() {
    echo "  FAIL: $1" >&2
    failed=1
}

# --- The five token probes ------------------------------------------------------------
i=0
while [ "$i" -lt "${#TOKENS[@]}" ]; do
    token="${TOKENS[$i]}"
    probe="${PROBE_FILES[$i]}"
    prefix="${PROBE_PREFIX[$i]}"
    n=$((i + 1))

    # Property 1: baseline green, RE-ASSERTED before every probe. This is what catches a
    # failed revert from probe n-1: without it, probe n's redness could be probe n-1's
    # residue and the report would name the wrong token.
    step "token ${n}/${#TOKENS[@]}: baseline green (re-asserted, not inherited)"
    run_gate
    if [ "$GATE_RC" -ne 0 ]; then
        fail "the gate exits ${GATE_RC} with NO probe applied, so a red below would prove nothing."
        echo "$GATE_OUT" | sed 's/^/    /' >&2
    fi

    # Property 2: probe red, and NAMED. A single appended comment line, so an abort
    # between the write and the restore leaves a file that still parses.
    step "token ${n}/${#TOKENS[@]}: probe '${probe}' -> the gate must exit EXACTLY 1 and NAME it"
    printf '%s THROWAWAY probe line written by scripts/prove-dev-pace-switch-absent-non-vacuous.sh. If you are seeing this committed, the proof aborted without reverting - delete this line. %s\n' \
        "$prefix" "$token" >> "$probe"
    run_gate
    if [ "$GATE_RC" -ne 1 ]; then
        fail "the gate exited ${GATE_RC}, expected EXACTLY 1. Exit 1 is 'a token was FOUND'; exit 2 is 'could not assert'; 0 is vacuous."
        echo "$GATE_OUT" | sed 's/^/    /' >&2
    else
        echo "       exit 1 (correct)"
    fi
    if ! printf '%s' "$GATE_OUT" | grep -F -- "$probe" >/dev/null; then
        fail "the gate did not NAME '${probe}' in its output. An exit code alone does not tell a reader which file to fix, and D-68-13 requires the path."
        echo "$GATE_OUT" | sed 's/^/    /' >&2
    else
        echo "       named: $(printf '%s' "$GATE_OUT" | grep -F -- "$probe" | head -1 | sed 's/^ *//')"
    fi

    # Property 3: revert clean - the file AND the gate. The file goes back to the bytes
    # kept at entry, never to git's copy.
    step "token ${n}/${#TOKENS[@]}: revert clean"
    prover_put_back "$probe"
    if ! prover_same_as_kept "$probe"; then
        fail "'${probe}' differs from its kept bytes after the revert. Every later assertion in this run is now measuring residue."
    fi
    run_gate
    if [ "$GATE_RC" -ne 0 ]; then
        fail "the gate exits ${GATE_RC} after the revert; the probe left residue somewhere."
        echo "$GATE_OUT" | sed 's/^/    /' >&2
    fi

    i=$((i + 1))
done

# --- Could-not-assert probe 1: the FLOOR ----------------------------------------------
# Driven through the gate's own override rather than by emptying the tree, so this probe
# cannot leave residue. The tree holds far fewer than this many tracked files, so the
# scan set is below the floor by construction.
step "could-not-assert: a scan set below the floor must exit 2, NOT 0"
run_gate --min-scan-files 999999999
if [ "$GATE_RC" -ne 2 ]; then
    fail "the gate exited ${GATE_RC} with its scan set below the floor, expected EXACTLY 2. A scan of nothing greps clean; if this is 0 the gate reports green over a walk that discovered nothing."
    echo "$GATE_OUT" | sed 's/^/    /' >&2
else
    echo "       exit 2 (correct): $(printf '%s' "$GATE_OUT" | grep -i 'below the floor' | head -1 | sed 's/^ *//')"
fi

# --- Could-not-assert probe 2: the POSITIVE CONTROL -----------------------------------
# A nonce built at runtime so it cannot collide with anything in the tree, and so this
# script does not carry a literal that a future edit might accidentally make findable.
ABSENT_CONTROL="fabrico-prover-nonce-$$-$(date +%s)-no-such-symbol"
step "could-not-assert: an unfindable positive control must exit 2, NOT 0"
run_gate --positive-control "$ABSENT_CONTROL"
if [ "$GATE_RC" -ne 2 ]; then
    fail "the gate exited ${GATE_RC} with a positive control that cannot be found, expected EXACTLY 2. Without a control hit, a zero result for the five tokens is meaningless - it looks identical whether they are absent or the search is broken."
    echo "$GATE_OUT" | sed 's/^/    /' >&2
else
    echo "       exit 2 (correct): $(printf '%s' "$GATE_OUT" | grep -i 'positive control' | tail -1 | sed 's/^ *//')"
fi

# --- The token-list assertion ----------------------------------------------------------
# The same blind spot the freeze prover's fourth assertion closes, pointed at this gate:
# every token the gate declares must have been probed above. Re-read here rather than
# reusing the array captured at the top, so a gate that changed its list mid-run - or a
# `--print-tokens` that is not stable - is visible.
step "the gate's live token list still holds ${EXPECTED_TOKEN_COUNT}, and every one was probed"
recheck=()
while IFS= read -r line; do
    [ -z "$line" ] && continue
    recheck+=("$line")
done < <(bash "$GATE" --print-tokens 2>/dev/null || true)

if [ "${#recheck[@]}" -ne "$EXPECTED_TOKEN_COUNT" ]; then
    fail "'${GATE} --print-tokens' now emits ${#recheck[@]} token(s), expected ${EXPECTED_TOKEN_COUNT}."
else
    for t in "${recheck[@]}"; do
        probed=0
        for p in "${TOKENS[@]}"; do
            if [ "$t" = "$p" ]; then
                probed=1
                break
            fi
        done
        if [ "$probed" -ne 1 ]; then
            fail "the gate declares a token that this run never probed. A prover that skips a token reports PROVEN over an untested widening."
        fi
    done
    echo "       ${#recheck[@]} token(s) declared, ${#TOKENS[@]} probed, all matched"
fi

# --- The closing residue assertion ------------------------------------------------------
# The entry state again, on the way out. This script must not be able to leave residue
# AND report PROVEN; a probe that survived would mean every later verdict in this run
# measured residue.
step "residue: this run left the worktree exactly as it found it"
tracked_out="$(git status --porcelain | grep -v '^??' || true)"
untracked_src_out="$(git ls-files --others --exclude-standard -- "${SOURCE_TREES[@]}")"
bytes_moved=""
for probe in "${PROBE_FILES[@]}"; do
    prover_same_as_kept "$probe" || bytes_moved="${bytes_moved}${probe}"$'\n'
done
if [ "$tracked_out" != "$entry_tracked" ] || [ "$untracked_src_out" != "$entry_untracked_src" ] \
    || [ -n "$bytes_moved" ]; then
    echo "FAIL: this run left RESIDUE in the worktree." >&2
    [ "$tracked_out" != "$entry_tracked" ] && printf '%s\n' "$tracked_out" | sed 's/^/    tracked now: /' >&2
    [ "$untracked_src_out" != "$entry_untracked_src" ] && printf '%s\n' "$untracked_src_out" | sed 's/^/    untracked now: /' >&2
    [ -n "$bytes_moved" ] && printf '%s' "$bytes_moved" | sed 's/^/    not its kept bytes: /' >&2
    echo "A prover that cannot clean up after itself cannot be trusted to have measured" >&2
    echo "what it says it measured. This is exit 2, not a pass." >&2
    exit 2
fi

echo
if [ "$failed" -ne 0 ]; then
    echo "NOT PROVEN: at least one property did not hold (named above)." >&2
    echo "The absence gate is vacuous, or weaker than it claims, on at least one token." >&2
    exit 1
fi

echo "PROVEN: ${GATE} bites on each of its ${#TOKENS[@]} tokens by name, and both of its"
echo "could-not-assert paths exit 2 rather than reporting green."
exit 0
