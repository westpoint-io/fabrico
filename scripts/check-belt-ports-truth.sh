#!/usr/bin/env bash
#
# THE BELT-PORTS TRUTH GATE (milestone v9.0 Phase 74, LINK-12).
#
# ---------------------------------------------------------------------------------
# WHAT IT ASSERTS. That no artefact in this repository still claims, of the product as it
# stands, that a belt carries no ports or that two belt runs cannot dock to each other.
#
# BOTH WERE TRUE UNTIL PHASE 74 AND BOTH BECAME FALSE IN ONE COMMIT. Plan 74-02 made a
# belt a ported node and opened the belt-to-belt `Dock` on the certified command path.
# From that commit a junction NODE stopped being the only way two runs could meet.
#
# WHY THAT NEEDS A GATE AND NOT JUST A CLEANUP. This project has been bitten repeatedly by
# a surviving artefact letting a superseded decision be re-derived: a comment saying a belt
# has no ports is a sentence a later engineer reasons FROM, and WINDOWS row 107 is the
# same class. The one-time correction fixes the sites that exist; nothing stops the next
# one. `scripts/check-drawwire-truth.sh` exists for exactly this reason and this gate is
# its twin.
# ---------------------------------------------------------------------------------
#
# =================================================================================
# THE HARD PART, AND WHY THIS GATE IS NOT A BARE PROXIMITY GREP
# =================================================================================
#
# The precedent gate hunts two words that sit near each other and is deliberately blunt:
# in that corpus, the op name near the dead-word is always the dead claim. THAT DOES NOT TRANSFER
# HERE, and it was measured rather than assumed. A first draft of this gate used the
# precedent's shape - `belt` within 120 characters of `no ports`, plus a negated `dock` -
# and it named TWENTY-EIGHT sites across nineteen files. Three were the dead claim. The
# other twenty-five were correct prose, most of it written BY this phase, recording in the
# past tense what used to be true. A gate that cries wolf twenty-five times is one a
# runner learns to ignore, which is the failure `prove-freeze-non-vacuous.sh` records
# about its own guard F in the same words.
#
# So the matcher asks for the claim as an ASSERTION ABOUT THE PRESENT PRODUCT, in three
# parts, each of which was tuned against the measured corpus and is self-tested below:
#
#   1. PRESENT-TENSE VERBS ONLY. "a belt CARRIES no ports" is a claim; "a belt DECLARED no
#      ports" is a record of what it did. Every legitimate site in this corpus is in the
#      past tense, and every dead claim is in the present. This one distinction removes
#      most of the noise on its own.
#
#   2. THE OBJECT MUST BE THE PORTS THEMSELVES, not another noun that starts with them.
#      "a belt has no port EDITS to make" is TRUE and stays true - a belt has ports and no
#      port editing - and a matcher that read it as "a belt has no ports" would be simply
#      wrong. So `no ports` must be followed by punctuation, by end of text, or by a
#      clause connective; a following noun ends the match. `records` is in the connective
#      list on purpose: "no Port records" IS the claim, said another way.
#
#   3. A QUALIFIER EXEMPTION, SENTENCE-SCOPED. A claim scoped to the pre-thaw past is a
#      RECORD, and records are exactly what this gate must leave alone. "A PRE-THAW BOARD'S belts carry no ports and are therefore un-linkable"
#      is true, load-bearing, and lives in the core's own schema docblock explaining why
#      the version bump is a break. So a match whose SAME SENTENCE carries a temporal
#      qualifier is exempt.
#
#      THE EXEMPTION IS SENTENCE-SCOPED FOR A REASON THAT WAS MEASURED, NOT GUESSED. With
#      a plain character lead instead of a sentence-bounded one, this phase's roadmap
#      criterion 5 - which really does carry a stale present-tense claim - was EXEMPTED by
#      the words "pre-thaw blob" sitting in the PREVIOUS sentence, about a different
#      subject. The lead is `[^.]{0,40}`, so it cannot reach back across a full stop.
#
# WHAT THIS COSTS, STATED RATHER THAN LEFT TO BE DISCOVERED. A claim written in the
# present tense with a temporal qualifier in the same sentence is exempt, and a claim
# phrased in a way none of the three parts recognises is missed. That is the price of a
# gate whose findings are all real; the alternative was measured and it was twenty-five
# false ones. THE ANSWER TO A MISS IS TO WIDEN THE MATCHER AND SAY SO, never to widen the
# exemption or narrow the corpus.
#
# =================================================================================
# THE FIVE PROPERTIES COPIED FROM `scripts/check-drawwire-truth.sh`
# =================================================================================
#
#   1. SEARCH WORDS ASSEMBLED FROM PIECES, so the gate cannot match its own source and
#      needs no self-exclusion. A self-exclusion is a hole: a falsehood written into the
#      gate's own comments would be the one place nothing looks.
#   2. A PROXIMITY WINDOW ON THE JOINED TEXT rather than a line grep, so a claim split
#      across two comment lines is caught. That is not hypothetical: the precedent's own
#      first version was a line grep and missed exactly that shape. The windows here are
#      `[^.]`-bounded, which is a proximity window that also cannot cross a sentence.
#   3. A `MIN_FILES` ANTI-VACUITY FLOOR over an explicit `ROOTS` corpus, exiting 2. A gate
#      that found nothing and a gate that found nothing wrong must not share an exit code.
#   4. A `normalize()` that strips comment leaders before joining. ITS LEADER SET COVERS
#      `//!`, `///`, `//`, `#` AND `*`, because the measured sites span Rust doc comments,
#      Rust line comments, a TSX comment block and Markdown - a regex handling only `//`
#      would miss three of the eight.
#   5. TWO IN-GATE SELF-TESTS, both exiting 2, both run BEFORE the corpus scan.
#      There are SIX here rather than two, because this matcher has three tuned parts and
#      an untested part is a part that can quietly stop working:
#        (a) POSITIVE, on the SPLIT-ACROSS-LINES shape specifically;
#        (b) NEGATIVE, on the past tense - a record must not fire;
#        (c) NEGATIVE, on the other-noun shape - "no port edits" must not fire;
#        (d) POSITIVE, on the qualifier exemption's own boundary - the SAME sentence with
#            the qualifier REMOVED must fire, so the exemption cannot silently swallow
#            everything;
#        (e) NEGATIVE, on the exemption itself - the qualified sentence must be exempt;
#        (f) POSITIVE, on the CANNOT-DOCK pattern ALONE. Self-test (a) carries both
#            claims in one sentence, so it fires on the ports pattern and would pass with
#            the dock pattern completely dead. That is not hypothetical - it happened, and
#            the note at self-test (f) records how.
#
# THE CORPUS INCLUDES THE PROSE A READER QUOTES BACK (ruling R-05). When this gate was
# written the extra file was the roadmap that authorised the phase, whose own success
# criteria carried the live claim. That roadmap was an internal design note; the
# repository's equivalent is its root README.md, the one document most likely to be
# quoted back. Scoping this gate to `crates/` and `frontend/` only would be a silent
# exclusion of it, and a silent exclusion is a hole.
#
# EXIT CODES:
#   0  no artefact claims a belt carries no ports or that two runs cannot dock
#   1  at least one does; every file is named with the matched window
#   2  the assertion could not be made (corpus below the floor, or a self-test failed).
#      This is a FAILURE, not a pass.

set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

# ---------------------------------------------------------------------------------
# The search words, assembled from pieces. None exists as a contiguous string in this
# file, so this script does not match itself even though `scripts/` could be added to the
# corpus tomorrow, and it carries no self-exclusion.
# ---------------------------------------------------------------------------------

# Present-tense possession verbs. A record uses the past tense and is not a claim.
W_VERB="(carr""ies|carr""y|h""as|ha""ve|expos""es|expo""se|declar""es|declar""e|hold""s|ho""ld|offer""s|off""er)"

# The object: the ports themselves. `no p` + `ort` never appears contiguously here.
W_NOPORT="no[[:space:]]+p""orts?"

# What may follow the object. Punctuation or a clause connective means the sentence was
# about the ports; anything else is a different noun and ends the match. `records` is
# included deliberately - "no Port records" is the same claim.
W_TAIL="([[:space:]]*[.,;:)]|[[:space:]]+(and|so|but|or|because|since|therefore|which|at all|whatever|recor""ds?|of any kind)([^[:alpha:]]|\$)|[[:space:]]*\$)"

# The negated-dock half.
W_NEG="(can""not|can not|can never|could never|do not|does not|never|will not)"
W_DOCK="do""ck(ed)?"

# The dock TARGET must be another belt. This is what keeps the gate off the TRUE and
# unrelated statement that a Mechanical belt cannot dock an ELECTRICAL nub, which this
# corpus makes in four places and which has nothing to do with LINK-12.
W_TARGET="(bel""ts?|each other|one another)"

W_BELT="bel""ts?"

# Proximity windows, in characters, on the JOINED text. Both are `[^.]`-bounded, so a
# window is also a sentence: a claim split across two comment lines is joined and caught,
# while two unrelated sentences that happen to sit near each other are not.
#
# WINDOW_DOCK is 24 because the measured claims are tight ("belt runs cannot dock to each
# other" is 18 characters from subject to verb). It was 60 in a first draft, at which
# width it matched an unrelated true sentence in `grid_view.rs` about a geometry-empty
# belt. WINDOW_LEAD is 40 and is the sentence-bounded lead the qualifier exemption reads.
WINDOW_DOCK=24
WINDOW_LEAD=40

# The temporal qualifiers that mark a sentence as a RECORD rather than a claim.
W_QUALIFIER="pre-t""haw|pre t""haw|until this phase|until phase|used to|before this milestone|before phase|at HEAD|historically|no longer|superseded|was true|were saved|old board|prior to|stopped being"

PATTERN_PORTS="${W_BELT}[[:space:]]+${W_VERB}[[:space:]]+${W_NOPORT}${W_TAIL}"
PATTERN_DOCK="${W_BELT}[^.]{0,${WINDOW_DOCK}}${W_NEG}[[:space:]]+(be[[:space:]]+)?${W_DOCK}[[:space:]]+(to[[:space:]]+)?(a[[:space:]]+|another[[:space:]]+)?${W_TARGET}"
PATTERN="${PATTERN_PORTS}|${PATTERN_DOCK}"

# The corpus. `crates/` and `frontend/` by requirement, plus the root README, by ruling
# R-05.
ROOTS=(crates frontend)
EXTRA_FILES=("README.md")
MIN_FILES=400

# Strip comment leaders, then join every line into one stream. The leader set covers the
# five shapes this repo uses; `tr` is what makes a two-line claim readable.
normalize() {
    sed -E 's@^[[:space:]]*(//[!/]?|#+|\*)[[:space:]]?@@' "$1" | tr '\n' ' '
}

SELF_TEST_FILE="$(mktemp)"
trap 'rm -f "$SELF_TEST_FILE"' EXIT

fires() {
    normalize "$SELF_TEST_FILE" | grep -iE "$PATTERN" >/dev/null
}

exempt() {
    normalize "$SELF_TEST_FILE" \
        | grep -oiE "[^.]{0,${WINDOW_LEAD}}(${PATTERN})" \
        | grep -iE "$W_QUALIFIER" >/dev/null
}

# --- SELF-TEST (a): POSITIVE, on the SPLIT-ACROSS-LINES shape ----------------------
# Built from the same assembled pieces, so this synthetic block is invisible to a raw scan
# of this file's source and only becomes a match after normalization - which is precisely
# the property under test. The precedent's original single-line gate silently failed on
# exactly this shape and it was found by reading instead.
{
    printf '/// A claim split across two lines: a b%s carries\n' 'elt'
    printf '/// no p%s, so two b%s runs cannot d%s to each other.\n' 'orts' 'elt' 'ock'
} >"$SELF_TEST_FILE"

if ! fires; then
    echo "FAIL: the matcher did not catch its own two-line self-test." >&2
    echo >&2
    echo "Either the pattern or the comment-leader normalization has broken. A gate whose" >&2
    echo "matcher cannot match must never report green, so this is exit 2 and not exit 0." >&2
    exit 2
fi

# --- SELF-TEST (f): POSITIVE, on the CANNOT-DOCK PATTERN ALONE --------------------
# SELF-TEST (a) above carries BOTH claims in one sentence, so it fires on the ports
# pattern and would keep firing with the dock pattern completely dead. That is not a
# hypothetical: the first version of `W_DOCK` read `docked?`, which in ERE requires the
# literal "docke", so it could not match the word "dock" at all. Every self-test passed,
# the gate ran green on the corpus, and the dock half was dead. It was found by
# `scripts/prove-belt-ports-truth-bites.sh` probe C, which is why that prover probes each
# pattern SEPARATELY, and this self-test is the in-gate half of the same lesson.
{
    printf '/// Two b%s runs cannot d%s to each other.\n' 'elt' 'ock'
} >"$SELF_TEST_FILE"

if ! fires; then
    echo "FAIL: the matcher did not catch the cannot-dock claim on its own." >&2
    echo >&2
    echo "The ports half of this gate can carry a corpus scan green while this half is" >&2
    echo "entirely dead - that has already happened once. A gate with one live pattern and" >&2
    echo "one dead one reads as twice the coverage it has, so this is exit 2." >&2
    exit 2
fi

# --- SELF-TEST (b): NEGATIVE, on the PAST TENSE -----------------------------------
# The whole corpus records this history in the past tense, most of it written by this
# phase. If the tense distinction breaks, the gate reddens on two dozen correct sentences
# and the next runner learns to ignore it.
{
    printf '/// Until this phase a b%s declared no p%s, so two runs could not\n' 'elt' 'orts'
    printf '/// be joined at all. That is what 74-02 changed.\n'
} >"$SELF_TEST_FILE"

if fires; then
    echo "FAIL: the matcher fired on a PAST-TENSE record." >&2
    echo "      Recording what used to be true is the point of a correction. A gate that" >&2
    echo "      reddens on the record cannot be distinguished from one that reddens on" >&2
    echo "      the claim, and a runner will silence both." >&2
    exit 2
fi

# --- SELF-TEST (c): NEGATIVE, on the OTHER-NOUN shape -----------------------------
# `sendPortEdit` in the frontend really does say this, it is TRUE, and it must stay
# sayable: a belt has ports and has no port EDITING.
{
    printf '// sendPortEdit refuses everything: a b%s has no p%s edits to make,\n' 'elt' 'ort'
    printf '// and the panel renders no Outputs group for it.\n'
} >"$SELF_TEST_FILE"

if fires; then
    echo "FAIL: the matcher read 'no port edits' as 'no ports'." >&2
    echo "      Those are different statements and only one of them is false. A gate that" >&2
    echo "      conflates them would demand a correction to a sentence that is correct." >&2
    exit 2
fi

# --- SELF-TEST (d): POSITIVE, on the EXEMPTION'S OWN BOUNDARY ---------------------
# The same sentence as (e) with the qualifier removed MUST fire. Without this, an
# exemption that had grown to swallow everything would look identical to a clean corpus.
{
    printf '/// A board'"'"'s b%ss carry no p%s and are therefore un-linkable.\n' 'elt' 'orts'
} >"$SELF_TEST_FILE"

if ! fires; then
    echo "FAIL: the matcher does not fire on an UNQUALIFIED present-tense claim." >&2
    echo "      Self-test (e) below asserts the qualified form is exempt; without this" >&2
    echo "      one, an exemption that had grown to cover every sentence would pass both." >&2
    exit 2
fi

if exempt; then
    echo "FAIL: an UNQUALIFIED claim was treated as exempt." >&2
    echo "      The qualifier list has grown to match something that is not a temporal" >&2
    echo "      qualifier, which turns the exemption into a blanket." >&2
    exit 2
fi

# --- SELF-TEST (e): NEGATIVE, on the EXEMPTION ------------------------------------
# The core's own schema docblock says this, and it is true and load-bearing: it is the
# reason the version bump is a BREAK rather than an append.
{
    printf '/// A pre-t%s board'"'"'s b%ss carry no p%s and are therefore un-linkable.\n' 'haw' 'elt' 'orts'
} >"$SELF_TEST_FILE"

if ! exempt; then
    echo "FAIL: a claim scoped to the pre-thaw past was NOT exempt." >&2
    echo "      The qualifier is in the same sentence as the subject, so the sentence is a" >&2
    echo "      record. A gate that demanded its correction would be asking for a true" >&2
    echo "      sentence to be made vague." >&2
    exit 2
fi

# --- GUARD: the corpus must not be empty or truncated ------------------------------
mapfile -t FILES < <(
    LC_ALL=C find "${ROOTS[@]}" \
        \( -name node_modules -o -name dist -o -name target -o -name test-results -o -name playwright-report \) -prune \
        -o -type f \( -name '*.rs' -o -name '*.ts' -o -name '*.tsx' -o -name '*.md' \) -print \
        | LC_ALL=C sort
)

for extra in "${EXTRA_FILES[@]}"; do
    if [ ! -f "$extra" ]; then
        echo "FAIL: '${extra}' is not present, so a document ruling R-05 puts in the corpus is" >&2
        echo "      not being scanned. If it moved," >&2
        echo "      point EXTRA_FILES at where it went; do not drop it." >&2
        exit 2
    fi
    FILES+=("$extra")
done

if [ "${#FILES[@]}" -lt "$MIN_FILES" ]; then
    echo "FAIL: discovered only ${#FILES[@]} file(s) under ${ROOTS[*]}, below the floor of ${MIN_FILES}." >&2
    echo >&2
    echo "A truncated or empty discovery walk would let this gate pass vacuously: a gate" >&2
    echo "that found nothing and a gate that found nothing wrong report the same exit code" >&2
    echo "otherwise. Exit 2, not 0." >&2
    exit 2
fi

# --- The scan ----------------------------------------------------------------------
# LC_ALL=C on the walk above fixes the enumeration and therefore the order failures are
# reported in, so a verdict does not depend on the locale it ran under.
found=0
exempted=0
for f in "${FILES[@]}"; do
    # A cheap pre-filter. Any form of either claim contains one of these two words on some
    # line, so this cannot hide a finding; it keeps a whole-corpus run under five seconds.
    grep -qiE 'p''ort|d''ock' "$f" || continue

    text="$(normalize "$f")"
    printf '%s' "$text" | grep -iE "$PATTERN" >/dev/null || continue

    hits=()
    while IFS= read -r hit; do
        [ -z "$hit" ] && continue
        if printf '%s' "$hit" | grep -iE "$W_QUALIFIER" >/dev/null; then
            exempted=$((exempted + 1))
            continue
        fi
        hits+=("$hit")
    done < <(printf '%s' "$text" | grep -oiE "[^.]{0,${WINDOW_LEAD}}(${PATTERN})" || true)

    if [ "${#hits[@]}" -ne 0 ]; then
        if [ "$found" -eq 0 ]; then
            echo "FAIL: an artefact still claims a belt carries no ports, or that two belt" >&2
            echo "      runs cannot dock to each other:" >&2
            echo >&2
        fi
        found=1
        echo "  ${f}" >&2
        printf '      %s\n' "${hits[@]}" >&2
    fi
done

if [ "$found" -ne 0 ]; then
    echo >&2
    echo "Both claims became false in phase 74 (plan 74-02): a belt is a ported node, and a" >&2
    echo "belt-to-belt Dock is accepted by the certified command path under the same" >&2
    echo "adjacency, facing and role rule that judges a belt-to-machine dock. Correct the" >&2
    echo "claim AT THE LINE, to what is true and why it now matters." >&2
    echo >&2
    echo "If the sentence is a RECORD of what used to be true, put it in the past tense or" >&2
    echo "scope it in the same sentence ('a pre-thaw board's belts...'). Do NOT narrow this" >&2
    echo "gate's corpus, widen its qualifier list, or drop a file from EXTRA_FILES to make" >&2
    echo "the finding go away." >&2
    exit 1
fi

echo "OK: ${#FILES[@]} files scanned across ${ROOTS[*]} plus ${EXTRA_FILES[*]};"
echo "    no surviving claim that a belt carries no ports or that two belt runs cannot"
echo "    dock. Comment leaders are stripped and lines joined, so a claim split across"
echo "    two lines is caught too. ${exempted} past-scoped record(s) exempted."
exit 0
