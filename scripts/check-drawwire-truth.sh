#!/usr/bin/env bash
#
# THE WIRE-OP TRUTH GATE (milestone v8.0 Phase 63, plans 63-02, 63-03 and 63-13).
#
# ---------------------------------------------------------------------------------
# WHAT IT ASSERTS. That no artifact in this repository still claims the wire-drawing
# edit op has no behaviour.
#
# It HAD no behaviour, from Phase 35 until Phase 63. Then plan 63-02 gave it a real
# fold: it mints a `Node::Wire` and records the same directed link the genesis seam
# records. Plan 63-03 corrected fifteen surviving claims to the contrary across five
# files, plus four the inventory did not have.
#
# WHY THAT NEEDS A GATE AND NOT JUST A CLEANUP. This project has been bitten
# repeatedly by a surviving artifact letting a superseded decision be re-derived: a
# comment saying an op does nothing is a sentence a later engineer reasons FROM. A
# one-time correction fixes the fifteen that existed; nothing stops the sixteenth. So
# the correction runs on every commit.
# ---------------------------------------------------------------------------------
#
# THE BLIND SPOT THIS VERSION CLOSES, recorded by plan 63-03 in deferred-items.md.
# The original gate was a single `grep -rniE` with a proximity pattern. `.` does not
# match a newline, so a claim SPLIT ACROSS TWO COMMENT LINES was invisible to it.
# That was not hypothetical: site 1 of the 63-03 inventory (tick.rs:246-250) was
# exactly that shape, the gate never saw it, and it was found by reading instead.
# Wiring a gate into CI that cannot see the shape it already missed once would be
# ceremony.
#
# So this version STRIPS COMMENT LEADERS AND JOINS EVERY LINE before matching, which
# makes a two-line claim indistinguishable from a one-line one.
#
# HOW IT AVOIDS BEING SELF-INVALIDATING. `scripts/` is inside the scanned corpus, and
# this file necessarily talks about the thing it searches for. Both search words are
# therefore BUILT FROM PIECES below, so neither appears as a contiguous string
# anywhere in this file. That is what lets this script scan ITSELF rather than
# carrying a self-exclusion, and a self-exclusion is a hole: a falsehood written into
# the gate's own comments would be the one place nothing looks.
#
# THE SAME RULE BINDS EVERY OTHER FILE THAT DESCRIBES THIS GATE. The matcher is a
# deliberately blunt two-way proximity match (the op name within WINDOW characters of
# the dead-word, in either order), because a real claim takes many shapes: a doc
# comment ABOVE the item puts the dead-word first, a full stop and no verb between
# them. The price is that prose ABOUT this gate which writes the two words
# contiguously reads as a claim. That happened once (forensic sweep 2026-09-17,
# finding A: the header of scripts/check-belt-ports-truth.sh). It was fixed AT THE
# LINE, by rewording that comment, and not by narrowing this matcher: a narrower
# matcher tried in review missed the historical claim in edit.rs this gate was built
# to refuse.
#
# ANTI-VACUOUS GUARDS. A truth gate that scans nothing reports green.
#   - GUARD 0: every root must exist as a directory. `find` runs inside a process
#     substitution, whose exit status `set -e` and `pipefail` never see, so a missing
#     root would otherwise print one stderr line and be silently dropped from the scan.
#   - GUARD 1: the discovered file set must be at least MIN_FILES. A wrong cwd, a
#     moved directory or a broken `find` would otherwise pass trivially.
#   - GUARD 2: THE MATCHER IS SELF-TESTED, and it is tested on the SPLIT-ACROSS-LINES
#     shape specifically. A synthetic two-line comment block carrying the exact claim
#     this gate exists to refuse is built at run time, normalized through the same
#     pipeline, and REQUIRED to match. If it does not, the pattern or the
#     normalization has broken and this script exits 2 rather than reporting a green
#     that measures nothing. This is the in-process form of the negative test
#     scripts/determinism-gate-negative-test.sh performs with a real probe.
#
# ---------------------------------------------------------------------------------
# ARM 2, THE WIRE ROUTER'S LOCATION (milestone v9.0 phase 75, plan 75-04; REQUIREMENTS
# CABLE-10). A second, separate assertion riding this gate rather than a new script,
# as CABLE-10 asks.
#
# WHAT IT ASSERTS. That no artifact still says the wire router lives in the frozen
# core crate, or that the side-blind cable fix sits inside the byte-freeze. Both were
# false: the router is crates/fabrico-command/src/wire_route.rs, and fabrico-command
# was never in the frozen set (fabrico-core, fabrico-protocol, fabrico-scenario). The
# false location let a known defect stay accepted for eight milestones as one nobody
# was allowed to fix, and the same sentence was copied into a code comment where the
# next reader would have reasoned from it again.
#
# THE TWO NEEDLES, named here only by description and assembled from pieces below so
# neither script matches itself: needle A is the router's file path placed under the
# core crate; needle B is the phrase placing the fix inside the core's freeze. Both are
# scanned for in every .rs, .ts and .tsx file under crates and frontend/src (wider than
# the one comment the claim was found in, so moving that comment into another module
# cannot hide a surviving copy). Both are fixed-string, line-based matches, the two
# greps CABLE-10 states. (CABLE-10 also scanned the project's internal defect ledger for
# needle A; that ledger is not part of this repository.)
#
# THE FLOW. Arm 1 no longer exits on its own finding: it sets a flag, arm 2 runs, both
# reports print, and the script exits 1 if either found anything. Arm 1's green line
# still starts with `OK:`; arm 2's starts with `ROUTER-OK:`, so the prover's read of
# the arm-1 file count is unchanged. Arm 2 is proved by
# scripts/prove-drawwire-truth-bites.sh (a source probe and configuration pins).
# ---------------------------------------------------------------------------------
#
# EXIT CODES:
#   0  no artifact claims the wire-drawing op is behaviourally dead, and none places
#      the wire router in the frozen core
#   1  at least one does; every file is named with the matched window (arm 1) or as
#      file:line (arm 2)
#   2  the assertion could not be made (a root missing, a corpus below
#      its floor, or the matcher failed its own self-test). This is a FAILURE, not a
#      pass.

set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

# The two search words, assembled from pieces. Neither exists as a contiguous string
# in this file, so this script does not match itself even though it scans itself.
W_OP="draw""wire"
W_DEAD="in""ert"

# Proximity window, in characters, on the joined text. 120 is what plan 63-03's
# original gate used and it is kept so the two are comparable.
WINDOW=120
PATTERN="${W_OP}.{0,${WINDOW}}${W_DEAD}|${W_DEAD}.{0,${WINDOW}}${W_OP}"

# The corpus. Same four roots plan 63-03's gate used.
ROOTS=(crates frontend/src scripts .github)
MIN_FILES=200

# Strip comment leaders, then join every line into one stream. `sed` handles the four
# leader shapes this repo uses (`//!`, `///`, `//`, `#`, and a continuation `*`);
# `tr` is what makes a two-line claim readable.
normalize() {
    sed -E 's@^[[:space:]]*(//[!/]?|#+|\*)[[:space:]]?@@' "$1" | tr '\n' ' '
}

# --- GUARD 2: the matcher must catch the split-across-lines shape ------------------
# Built with the same assembled words, so this synthetic block is also invisible to a
# scan of this file's raw source, and only becomes a match after normalization - which
# is precisely the property under test.
SELF_TEST_FILE="$(mktemp)"
trap 'rm -f "$SELF_TEST_FILE"' EXIT
{
    printf '/// A claim split across two lines: the %s op is\n' "$W_OP"
    printf '/// behaviorally %s this milestone and gains a fold later.\n' "$W_DEAD"
} >"$SELF_TEST_FILE"

if ! normalize "$SELF_TEST_FILE" | grep -iE "$PATTERN" >/dev/null; then
    echo "FAIL: the matcher did not catch its own two-line self-test." >&2
    echo >&2
    echo "Either the proximity pattern or the comment-leader normalization has" >&2
    echo "broken. A gate whose matcher cannot match must never report green, so" >&2
    echo "this is exit 2 and not exit 0. This self-test exists because the ORIGINAL" >&2
    echo "single-line gate silently failed on exactly this shape." >&2
    exit 2
fi

# A negative control alongside the positive one: normalization must not manufacture a
# match out of text that contains only one of the two words.
{
    printf '/// A line naming only the %s op and nothing about its behaviour.\n' "$W_OP"
} >"$SELF_TEST_FILE"
if normalize "$SELF_TEST_FILE" | grep -iE "$PATTERN" >/dev/null; then
    echo "FAIL: the matcher fired on text carrying only one of the two words." >&2
    echo "      A pattern that matches everything names nothing useful." >&2
    exit 2
fi

# --- GUARD 0: every root must exist ------------------------------------------------
for r in "${ROOTS[@]}"; do
    if [ ! -d "$r" ]; then
        echo "FAIL: root $r missing" >&2
        echo >&2
        echo "A root that does not exist would be dropped from the walk without an error," >&2
        echo "and the gate would report a clean corpus about part of one." >&2
        exit 2
    fi
done

# --- GUARD 1: the corpus must not be empty or truncated ----------------------------
# The file list is gathered with a portable while-read loop rather than the bash-4+
# array builtin, so this gate runs on bash 3.2 (the macOS dev host, where it exited
# 127 before this change). Same find flags, same extension list, same LC_ALL=C sort.
# No source path in this repo contains a newline, so a line is one file.
FILES=()
while IFS= read -r file; do
    FILES+=("$file")
done < <(
    LC_ALL=C find "${ROOTS[@]}" \
        -type f \
        \( -name '*.rs' -o -name '*.ts' -o -name '*.tsx' -o -name '*.sh' -o -name '*.yml' \) \
        -print | LC_ALL=C sort
)

if [ "${#FILES[@]}" -lt "$MIN_FILES" ]; then
    echo "FAIL: discovered only ${#FILES[@]} file(s) under ${ROOTS[*]}, below the floor of ${MIN_FILES}." >&2
    echo >&2
    echo "A truncated or empty discovery walk would let this gate pass vacuously." >&2
    exit 2
fi

# --- The scan ----------------------------------------------------------------------
found=0
for f in "${FILES[@]}"; do
    hit="$(normalize "$f" | grep -oiE "$PATTERN" || true)"
    if [ -n "$hit" ]; then
        if [ "$found" -eq 0 ]; then
            echo "FAIL: an artifact still claims the wire-drawing op has no behaviour:" >&2
            echo >&2
        fi
        found=1
        echo "  ${f}" >&2
        printf '%s\n' "$hit" | sed 's/^/      /' >&2
    fi
done

arm1_failed=0
if [ "$found" -ne 0 ]; then
    echo >&2
    echo "That op gained a real fold in Phase 63 (plan 63-02): it mints a Node::Wire" >&2
    echo "and records the same directed link the genesis seam records. Correct the" >&2
    echo "claim AT THE LINE, to what is true and why it now matters. Do NOT narrow" >&2
    echo "this gate's corpus or its window to make the finding go away." >&2
    arm1_failed=1
else
    echo "OK: ${#FILES[@]} files scanned across ${ROOTS[*]}; no surviving claim that the"
    echo "    wire-drawing op is behaviourally dead. Comment leaders are stripped and"
    echo "    lines joined, so a claim split across two lines is caught too."
fi

# =================================================================================
# ARM 2: the wire router's location (plan 75-04, CABLE-10). See the header.
# =================================================================================
ROUTER_NEEDLE_PATH="crates/fabrico-""core/src/wire_""route.rs"
ROUTER_NEEDLE_FREEZE="inside the core ""freeze"
ROUTER_ROOTS=(crates frontend/src)
ROUTER_MIN_FILES=150

# --- ARM 2 GUARDS: both roots must exist, the walk must not be empty ---------------
for r in "${ROUTER_ROOTS[@]}"; do
    if [ ! -d "$r" ]; then
        echo "FAIL: arm 2 root $r missing" >&2
        exit 2
    fi
done

ROUTER_FILES=()
while IFS= read -r file; do
    ROUTER_FILES+=("$file")
done < <(
    LC_ALL=C find "${ROUTER_ROOTS[@]}" \
        -type f \
        \( -name '*.rs' -o -name '*.ts' -o -name '*.tsx' \) \
        -print | LC_ALL=C sort
)
if [ "${#ROUTER_FILES[@]}" -lt "$ROUTER_MIN_FILES" ]; then
    echo "FAIL: arm 2 discovered only ${#ROUTER_FILES[@]} source file(s) under ${ROUTER_ROOTS[*]}," >&2
    echo "      below the floor of ${ROUTER_MIN_FILES}; a truncated walk would pass vacuously." >&2
    exit 2
fi

# --- ARM 2 scan ---------------------------------------------------------------------
router_hits=()
for f in "${ROUTER_FILES[@]}"; do
    while IFS= read -r n; do
        [ -n "$n" ] && router_hits+=("${f}:${n}")
    done < <(grep -nF -e "$ROUTER_NEEDLE_PATH" -e "$ROUTER_NEEDLE_FREEZE" -- "$f" | cut -d: -f1 || true)
done

arm2_failed=0
if [ "${#router_hits[@]}" -ne 0 ]; then
    arm2_failed=1
    echo "FAIL: an artifact still places the wire router in the frozen core:" >&2
    echo >&2
    for h in "${router_hits[@]}"; do
        echo "  ${h}" >&2
    done
    echo >&2
    echo "The router is crates/fabrico-command/src/wire_route.rs, and fabrico-command was" >&2
    echo "never frozen (the frozen set was fabrico-core, fabrico-protocol, fabrico-scenario)." >&2
    echo "Reword the claim AT THE LINE to that statement." >&2
else
    echo "ROUTER-OK: ${#ROUTER_FILES[@]} source files across ${ROUTER_ROOTS[*]};"
    echo "    nothing places the wire router in the frozen core."
fi

if [ "$arm1_failed" -ne 0 ] || [ "$arm2_failed" -ne 0 ]; then
    exit 1
fi
exit 0
