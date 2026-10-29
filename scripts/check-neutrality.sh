#!/usr/bin/env bash
#
# check-neutrality.sh - the MARKDOWN half of the art board's neutrality gate
# (BOARD-02, 57-CONTEXT.md D-14 as widened by D-17, plan 57-09).
#
# The instrument this phase builds must advocate nothing, and "advocates nothing" is
# only a promise until a machine can fail on it. There are two halves. The board's
# RENDERED prose is scanned by the Playwright spec (frontend/e2e/art-board.spec.ts,
# the `neutrality-tokens` test, over #art-board-root's innerText). This script is the
# other half: the markdown artifact a reader reaches for when the board sends them
# somewhere.
#
# THE TARGET: docs/style-bible.md, the rules the board's lock form becomes. The lock
# form itself was an internal design note and is not part of this repository.
#
# It is NOT scoped to a directory. This phase's RESEARCH, its UI-SPEC and
# every one of its plan files has to NAME the banned words in order to ban them, so a
# directory-wide scan is permanently red and gets "fixed" by weakening it into
# uselessness.
#
# It does NOT scan source, for the same reason measured on the real tree: `default`
# appears legitimately in `export default`, in a `switch` `default:` arm, in
# `defaultValue`, in Pixi's own `defaultAnchor` and in
# `ExtractSystem.defaultImageOptions`; `prefer`, `pick`, `should`, `strongest` and
# `the right` all appear in the board modules' own docblocks, where they are prose
# ABOUT the rule rather than a violation of it. A source-scoped grep over this repo
# returns 21 hits on a clean tree and every one is legitimate.
#
# THE THIRTEEN TOKENS. D-14 locked five - recommend, we suggest, best option, prefer,
# default. D-17 widened it by eight near-synonyms research measured as evading them -
# winner, strongest, should, obviously, pick, clearly, the right, the obvious - on the
# stated ground that a neutrality gate that can be walked around with a synonym is not
# a gate. Case-insensitive and by substring, so `preferred` and `defaulted` are caught.
#
# WHEN THIS GATE GOES RED, REWORD THE COPY. Never narrow the list. The first red is
# EXPECTED and its cause is documented in advance: 53-BELT-LOCK.md's own neutrality
# preamble carries `preferred` and `defaulted` in one sentence at :7 and `preference`
# at :27, so the document this phase mirrors fails this gate verbatim. That is a
# rewording job, and the instinct to shorten the token list instead is the one thing
# that would quietly turn this file back into a decoration.
#
# THE TWO NON-TRADEABLE HALVES (Phase 56's recorded `grep ... | wc -l` lesson).
# First, `ls -1` over the target list, so the corpus is PROVEN to exist: an assertion
# without an existence check passes vacuously over a renamed or deleted path. A
# missing target is ALWAYS a failure and there is no skip branch - the target exists
# by the time this gate runs, so an absent one means a rename or a deletion, and a
# scan that steps over what it cannot find is exactly the vacuous pass this pairing
# exists to prevent. Second, the count is ASSIGNED, ECHOED and then ASSERTED: a bare
# `grep ... | wc -l` prints a number and always exits 0. Neither half substitutes for
# the other, and each counting step carries its own assertion.
#
# NO PATH INPUT, EVER. The corpus is resolved from this script's own location, never
# from argv and never from cwd - the same rule frontend/scripts/lint-svg.ts
# follows, and for the same two reasons: a path-traversal
# surface, and a false-green source.
#
# MUTATION-PROVEN. Every half below was verified to redden on a deliberate violation
# before this file was committed, including the negative case proving the scan has NOT
# leaked into source.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# The whole corpus. Listed literally - never globbed, never derived from a
# directory walk, so a target that disappears is a failure rather than a smaller set.
TARGETS=(
  "docs/style-bible.md"
)

# D-14's five, widened by D-17's eight. Alternation, case-insensitive, substring.
BANNED='recommend|we suggest|best option|prefer|default|winner|strongest|should|obviously|pick|clearly|the right|the obvious'

# --- half 1: the corpus exists ---------------------------------------------
# No skip branch. A target that is not there does not get scanned over; the run ends.

echo "check-neutrality: the markdown corpus"
MISSING=0
for f in "${TARGETS[@]}"; do
  if [ -e "$f" ]; then
    ls -1 "$f" | sed 's/^/  /'
  else
    echo "  MISSING: $f"
    MISSING=1
  fi
done

if [ "$MISSING" != "0" ]; then
  echo
  echo "FAIL: the scan corpus is incomplete."
  echo "      A target named above does not exist, so this run would have reported"
  echo "      zero hits over a smaller set than the gate is defined on. Restore the"
  echo "      file, or change TARGETS deliberately - never both silently."
  exit 1
fi

# --- half 2: zero banned tokens across that corpus -------------------------
# ASSIGN, ECHO, ASSERT. One assertion per counting step, one for one.

HITS=$(grep -ioE "$BANNED" "${TARGETS[@]}" | grep -c . || true)
echo "  HITS=$HITS  (advocacy tokens over ${#TARGETS[@]} markdown targets)"

if [ "$HITS" != "0" ]; then
  echo
  echo "  every occurrence, with its file, line number and line:"
  grep -niE "$BANNED" "${TARGETS[@]}" | sed 's/^/    /'
fi

if ! test "$HITS" = "0"; then
  echo
  echo "FAIL: the instrument advocates."
  echo "      THE FIX IS TO REWORD THE COPY. Do not narrow the token list to make"
  echo "      this pass - the list is D-14 as widened by D-17, and shortening it is"
  echo "      the documented failure mode this gate was written to survive."
  exit 1
fi

echo
echo "check-neutrality: PASS (2 halves, ${#TARGETS[@]} targets, 13 tokens)"
exit 0
