#!/usr/bin/env bash
#
# THE BELT-END RESOLVER GATE (milestone v9.0 Phase 74, LINK-11, plans 74-02 and 74-10).
#
# ---------------------------------------------------------------------------------
# WHAT IT ASSERTS. That replaying any command which resolves a belt end's world cell
# reaches ONE definition of that resolver, that the readers who need the answer ask it
# by name, and that nothing anywhere derives the same answer for itself.
#
# THIS RETIRES A DRIFT THAT WAS LIVE, NOT ONE THAT MIGHT HAPPEN. At the phase-74 base
# commit the derivation was written out TWICE, byte for byte: once in
# `GridState::dock_still_reaches` in `fabrico-core`, and once in the `GridCommand::Dock`
# validate arm in `fabrico-command`. One of the two even commented itself as a mirror of
# the other while citing a line number that had since rotted. Plan 74-02 collapsed both
# into `fabrico_core::state::belt_end_world`. This gate is what keeps them collapsed.
#
# WHY THAT PARTICULAR DUPLICATION WAS DANGEROUS. Two copies of the rule that decides
# whether a dock REACHES agree on the first abutting belt pair anybody tests and drift
# later, on a shape nobody thought to write a case for. The first pass's proposed
# defence - "assert the two agree on one belt pair" - cannot detect that: two duplicated
# resolvers pass such a clause exactly as one shared resolver does. T-63-14 is the same
# class, cited in `crates/fabrico-command/src/command.rs`.
# ---------------------------------------------------------------------------------
#
# =================================================================================
# THE CALL-SITE FLOOR IS **TWO**, AND THAT IS A MEASUREMENT, NOT A RELAXATION.
# =================================================================================
#
# `REQUIREMENTS.md` LINK-11 asks for "at least three named call sites across the Dock
# arm, the Unlink arm, `dock_still_reaches` and the render packet", and plan 74-10
# repeats it, naming the Dock arm, `dock_still_reaches` and `belt_docks`. THAT NUMBER IS
# NOT REACHABLE WITHOUT MANUFACTURING A DEAD CALL, and it was measured three times
# independently before this floor was written: by plan 74-02 (handover 1), again by plan
# 74-06 after its own work (handover 4), and again here.
#
# TWO of the four named readers ask the resolver, and the other two are RIGHT not to:
#
#   1. `GridState::dock_still_reaches`, in `crates/fabrico-core/src/state.rs`. ASKS.
#   2. The `GridCommand::Dock` validate arm, in `crates/fabrico-command/src/command.rs`.
#      ASKS, TWICE - once for the carrier belt's own end, once for a belt TARGET's end.
#      The wire-carrier branch in the same arm deliberately does NOT ask: the resolver
#      answers `None` for a `Wire`-minted belt's empty geometry, so asking there would
#      refuse the very case the branch exists to admit.
#   3. The `GridCommand::Unlink` arm. DOES NOT ASK, ON PURPOSE. Its own comment states
#      the contract: "NO geometry is re-checked: a rotate or a footprint change may well
#      have moved the machine since the dock, and a disconnect must stay reachable for
#      exactly the links that are hardest to reason about." A resolver call there would
#      be either a dead call or a refusal envelope the disconnect verb deliberately
#      lacks - which would make a link created legally impossible to remove.
#   4. `belt_docks` in `crates/fabrico-host/src/render_packet.rs`. DOES NOT ASK, AND
#      DOES NOT NEED TO. It reads the LINK GRAPH (`link_target` and a `links_iter` walk),
#      never geometry, and it already projects a belt-to-belt dock from both sides with
#      no node-kind filter. It needed no change at all when belts became ported.
#
# SO THE FLOOR IS TWO NAMED READERS AND THREE CALL EXPRESSIONS, and both numbers are
# asserted below. DO NOT "FIX" THIS BACK TO THREE READERS by adding a call to
# `belt_docks` or to the `Unlink` arm. A resolver call inside a function that reads the
# link graph is a dead call, and a change made to satisfy a plan sentence rather than to
# make something true is the exact move plan 74-03 was offered with `identify_belt` and
# refused. If a third reader ever appears for a real reason, raise the floor then.
#
# THIS GATE'S OWN STATED PRINCIPLE APPLIES TO ITSELF: a gate that passes when its subject
# does not exist is a gate that cannot fail. That is why CHECK A treats ZERO definitions
# as a FAILURE and not as "no duplication found", and why the reader floor is asserted at
# the measured number rather than at an aspirational one that would have to be satisfied
# with a call nobody reads.
#
# =================================================================================
# THE FIVE PROPERTIES COPIED FROM `scripts/check-drawwire-truth.sh`
# =================================================================================
#
#   1. SEARCH WORDS ASSEMBLED FROM PIECES, so this script cannot match its own source
#      and needs no self-exclusion. `scripts/` is not in this gate's corpus today, but a
#      self-exclusion is a hole and the assembly costs nothing.
#   2. A PROXIMITY BOUND ON THE JOINED TEXT, not a line grep - see `normalize()` and
#      CHECK C, where a call split over four lines by `rustfmt` must still read as a call.
#   3. A `MIN_FILES` ANTI-VACUITY FLOOR over an explicit `ROOTS` corpus, exiting 2. A gate
#      that found nothing and a gate that found nothing wrong must not share an exit code.
#   4. A `normalize()` that strips comment leaders before joining.
#   5. TWO IN-GATE SELF-TESTS, both exiting 2, both run BEFORE the corpus scan, so a
#      broken matcher is reported as a gate defect rather than as a clean corpus.
#
# TWO NORMALIZERS, DELIBERATELY, AND THE REASON IS NOT SYMMETRY. `normalize()` turns
# comments INTO matchable text, which is exactly right for a prose gate and exactly wrong
# here: this gate asserts things about CODE, and the resolver's own docblock necessarily
# describes the derivation it owns. Reading that docblock as code would report the one
# correct definition as a duplicate of itself. So the shape scan runs over `code_only()`,
# which deletes comments rather than unwrapping them, and `normalize()` is used where a
# joined read is what is wanted. Both are exercised by the self-tests.
#
# WHAT THIS GATE DOES NOT COVER, STATED SO IT IS NOT ASSUMED:
#   - The corpus is `crates/**/*.rs`. The TypeScript side is deliberately out: it never
#     derives a belt end, it receives resolved cells over the wire in the render packet.
#   - CHECK A's shape detector is anchored on a geometry-named receiver (`geom` /
#     `geometry`). A duplicate written with entirely different local identifiers would
#     escape it. That is why CHECK B exists: it is name-independent and matches on the
#     RETURN SHAPE instead, so the two checks fail on disjoint disguises.
#   - CHECK C's production/test split stops counting a file at its first top-level
#     `#[cfg(test)]`. A call from a test module is deliberately not a "reader".
#
# EXIT CODES:
#   0  one definition, both named readers ask it, nothing re-derives it
#   1  at least one of those is false; every offending site is named
#   2  the assertion could not be made (corpus below the floor, or a self-test failed).
#      This is a FAILURE, not a pass.

set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

# ---------------------------------------------------------------------------------
# The search words, assembled from pieces. None exists as a contiguous string in this
# file, so this script does not match itself even if the corpus ever grows to include it.
# ---------------------------------------------------------------------------------

# The resolver's name, as a call or a definition.
W_FN="belt_end""_world"

# The END-CELL accessor, anchored on a geometry-named receiver.
W_END="(geom|geo""metry)[A-Za-z0-9_]*[.](fi""rst|la""st)[(][)]"

# The INNER-NEIGHBOUR derivation: the single-tile guard pair both collapsed duplicates
# used. `checked_sub(2)` is what makes a one-tile belt answer "no inner neighbour"
# instead of wrapping; `get(1)` is the tail-side mirror of it.
W_INNER="(geom|geo""metry)[A-Za-z0-9_]*[.](le""n[(][)][.]checked_""sub[(]2[)]|ge""t[(]1[)]|le""n[(][)][[:space:]]*-[[:space:]]*2)"

# The resolver's RETURN SHAPE: a world cell plus an OPTIONAL outward side. The optional
# side is the load-bearing half - it is what a single-tile belt (no inherent direction)
# answers - so this shape is specific to this resolver and not to geometry code at large.
W_SIG="Opt""ion<[(][(]i32, i32[)], Opt""ion<Side>[)]>"

# THE PROXIMITY BOUND HERE IS THE FUNCTION BLOCK, NOT A CHARACTER COUNT, AND THAT IS A
# DEPARTURE FROM THE PRECEDENT MADE ON PURPOSE.
#
# `check-drawwire-truth.sh` carries `WINDOW=120` because it hunts two words that happen to
# sit near each other in prose, and 120 characters is a defensible guess at "near". This
# gate hunts a call inside a NAMED READER, and the semantically correct window for that is
# the reader's own body: `dock_still_reaches` runs to about fifty lines and the Dock
# validate arm to about three hundred, so any character count large enough to cover the
# arm would also reach well past `dock_still_reaches` into its neighbours, and any count
# small enough to be tight on one would be wrong for the other.
#
# So CHECK C joins the reader's block through `normalize()` - which is the property that
# matters, a joined read rather than a line grep, so a call `rustfmt` wrapped over four
# lines still reads as a call - and bounds the search at the block, which `block_range()`
# computes. A `WINDOW=120` constant was written here first and then removed rather than
# left unused: a declared bound that nothing reads is its own small check that cannot
# fail, and the next reader would take it for a live constraint.

# The corpus.
ROOTS=(crates)
MIN_FILES=120

# The MEASURED floors. See the block at the top of this file before changing either.
MIN_READERS=2
MIN_CALLS=3

# Where the one definition must live.
DEF_FILE="crates/fabrico-core/src/state.rs"

# ---------------------------------------------------------------------------------
# `normalize()` - the precedent's, verbatim in behaviour: strip the five comment leader
# shapes this repo uses (`//!`, `///`, `//`, `#`, and a continuation `*`), then join every
# line into one stream so a construct split across lines reads as one.
# ---------------------------------------------------------------------------------
normalize() {
    sed -E 's@^[[:space:]]*(//[!/]?|#+|\*)[[:space:]]?@@' "$1" | tr '\n' ' '
}

# `code_only()` - DELETES comments rather than unwrapping them, and keeps the line
# structure that the function-block walk below needs. Full-line and trailing `//`
# comments both go.
code_only() {
    sed -E -e 's@[[:space:]]*//.*$@@' "$1"
}

# ---------------------------------------------------------------------------------
# The shape detector. Walks a Rust file's CODE, tracks which function each line belongs
# to, and reports every function whose body contains BOTH an end-cell accessor and an
# inner-neighbour derivation - which together are the resolver's derivation and not a
# shape ordinary geometry code has.
# ---------------------------------------------------------------------------------
resolver_shaped_blocks() {
    local f="$1" tmp ends inners
    tmp="$(mktemp)"
    # `code_only` substitutes in place and never deletes a line, so line numbers in
    # `$tmp` are the file's own line numbers and a report can be opened at them.
    code_only "$f" >"$tmp"
    # The two markers are located with `grep -E` rather than inside awk: awk applies its
    # own STRING-escape pass to a regex handed in through `-v`, which silently turns an
    # escaped paren into a capture group. Line-number sets cross that boundary intact.
    ends="$(grep -nE "$W_END" "$tmp" | cut -d: -f1 | tr '\n' ',' || true)"
    inners="$(grep -nE "$W_INNER" "$tmp" | cut -d: -f1 | tr '\n' ',' || true)"
    awk -v file="$f" -v ends="$ends" -v inners="$inners" '
        BEGIN {
            n = split(ends, e, ",");   for (i = 1; i <= n; i++) if (e[i] != "") isend[e[i] + 0] = 1
            n = split(inners, s, ","); for (i = 1; i <= n; i++) if (s[i] != "") isinner[s[i] + 0] = 1
        }
        function flush() {
            if (fname != "" && seen_end && seen_inner) {
                print file ":" fstart ":" fname
            }
        }
        {
            if (match($0, /(^|[^A-Za-z0-9_])fn[[:space:]]+[A-Za-z0-9_]+/)) {
                m = substr($0, RSTART, RLENGTH)
                sub(/^.*fn[[:space:]]+/, "", m)
                flush()
                fname = m; fstart = FNR; seen_end = 0; seen_inner = 0
            }
            if (isend[FNR])   { seen_end = 1 }
            if (isinner[FNR]) { seen_inner = 1 }
        }
        END { flush() }
    ' "$tmp"
    rm -f "$tmp"
}

# Production (non-test) call expressions of the resolver in one file. Counting stops at
# the file's first top-level `#[cfg(test)]`: a call from a test module witnesses the
# resolver, but it is not a READER of it in the sense LINK-11 means.
production_calls() {
    # NOT `awk ... { exit }`: awk exiting mid-stream closes the pipe under `code_only`,
    # which takes SIGPIPE, and `set -o pipefail` then reports the whole gate as having
    # died 141. The test module is skipped with a FLAG so the stream is always drained.
    code_only "$1" | awk -v needle="$W_FN" '
        /^#\[cfg\(test\)\]/ { in_tests = 1 }
        in_tests { next }
        {
            line = $0
            # A definition is not a call.
            if (line ~ /(^|[^A-Za-z0-9_])fn[[:space:]]+/ && line ~ needle) next
            n = gsub(needle "[(]", "")
            total += n
        }
        END { print total + 0 }
    '
}

# The joined, comment-stripped text of an inclusive line range of a file.
block_text() {
    sed -n "${2},${3}p" "$1" | sed -E 's@^[[:space:]]*(//[!/]?|#+|\*)[[:space:]]?@@' | tr '\n' ' '
}

# The line range of the block a marker opens: from the marker's line to the line before
# the next line matching `terminator`, or to end of file.
block_range() {
    local file="$1" marker="$2" terminator="$3"
    awk -v marker="$marker" -v term="$terminator" '
        start == 0 && $0 ~ marker { start = FNR; next }
        start != 0 && $0 ~ term   { print start ":" (FNR - 1); found = 1; exit }
        END { if (start != 0 && found != 1) print start ":" FNR; if (start == 0) print "0:0" }
    ' "$file"
}

# =================================================================================
# SELF-TEST 1 (positive). The shape detector must catch a synthetic DUPLICATE.
#
# Built from the same assembled pieces, so this block is invisible to a raw scan of this
# file's source and only becomes a match after the detector runs - which is the property
# under test.
# =================================================================================
SELF_TEST_FILE="$(mktemp)"
trap 'rm -f "$SELF_TEST_FILE"' EXIT

{
    printf 'fn a_second_copy_of_the_resolver(geometry: &[BeltTile]) -> Option<(i32, i32)> {\n'
    printf '    let last = geometry.la%s()?.cell;\n' 'st'
    printf '    let inner = geometry.le%s().checked_%s(2).map(|i| geometry[i].cell);\n' 'n' 'sub'
    printf '    let _ = (last, inner);\n'
    printf '    None\n'
    printf '}\n'
} >"$SELF_TEST_FILE"

if [ -z "$(resolver_shaped_blocks "$SELF_TEST_FILE")" ]; then
    echo "FAIL: the shape detector did not catch its own synthetic duplicate." >&2
    echo >&2
    echo "Either the end-cell pattern, the inner-neighbour pattern or the function-block" >&2
    echo "walk has broken. A gate whose matcher cannot match must never report green, so" >&2
    echo "this is exit 2 and not exit 0 - the corpus scan below would otherwise report" >&2
    echo "'exactly one definition' about a detector that finds none of them." >&2
    exit 2
fi

# =================================================================================
# SELF-TEST 2 (negative, two halves). The detector must NOT fire on:
#   (a) a function that reads an end cell but derives no inner neighbour - the shape of
#       an ordinary test asserting a belt's endpoints, which is NOT a re-implementation;
#   (b) a DOC COMMENT describing the derivation in full. This is the half that proves
#       `code_only()` is really deleting comments rather than unwrapping them, and it is
#       not hypothetical: the one correct definition carries exactly such a docblock, so
#       a detector that read comments would report the resolver as its own duplicate.
# =================================================================================
{
    printf 'fn reads_only_the_end_cell(belt: &Belt) {\n'
    printf '    let head = belt.geometry.la%s().map(|t| t.cell);\n' 'st'
    printf '    let tail = belt.geometry.fi%s().map(|t| t.cell);\n' 'rst'
    printf '    let _ = (head, tail);\n'
    printf '}\n'
} >"$SELF_TEST_FILE"

if [ -n "$(resolver_shaped_blocks "$SELF_TEST_FILE")" ]; then
    echo "FAIL: the shape detector fired on a function that only reads an end cell." >&2
    echo "      A detector that matches every use of a geometry endpoint names nothing" >&2
    echo "      useful, and would report ordinary assertions as forbidden duplicates." >&2
    exit 2
fi

{
    printf '/// The derivation, described in prose: the head is geometry.la%s(), and\n' 'st'
    printf '/// the inner neighbour is geometry.le%s().checked_%s(2).\n' 'n' 'sub'
    printf 'fn documents_the_derivation_but_does_not_perform_it() {}\n'
} >"$SELF_TEST_FILE"

if [ -n "$(resolver_shaped_blocks "$SELF_TEST_FILE")" ]; then
    echo "FAIL: the shape detector read a DOC COMMENT as code." >&2
    echo >&2
    echo "code_only() has stopped deleting comments. The one correct definition carries a" >&2
    echo "docblock describing its own derivation, so this gate would report the resolver" >&2
    echo "as a duplicate of itself and CHECK A would exit 1 on a correct tree." >&2
    exit 2
fi

# A last self-test on `normalize()`, which CHECK C depends on: a call broken over four
# lines by rustfmt must read as one call after the join.
{
    printf '        let answer = %s(\n' "$W_FN"
    printf '            geometry,\n'
    printf '            end,\n'
    printf '        );\n'
} >"$SELF_TEST_FILE"

if ! normalize "$SELF_TEST_FILE" | grep -E "${W_FN}[(]" >/dev/null; then
    echo "FAIL: normalize() did not join a call split across lines." >&2
    echo "      CHECK C reads reader blocks through it, so a formatter that wrapped a" >&2
    echo "      call would make a real reader look like a missing one." >&2
    exit 2
fi

# =================================================================================
# GUARD: the corpus must not be empty or truncated.
# =================================================================================
mapfile -t FILES < <(
    LC_ALL=C find "${ROOTS[@]}" -type f -name '*.rs' -print | LC_ALL=C sort
)

if [ "${#FILES[@]}" -lt "$MIN_FILES" ]; then
    echo "FAIL: discovered only ${#FILES[@]} file(s) under ${ROOTS[*]}, below the floor of ${MIN_FILES}." >&2
    echo >&2
    echo "A truncated or empty discovery walk would let this gate pass vacuously: with no" >&2
    echo "files, 'exactly one definition' is false and 'zero re-implementations' is true," >&2
    echo "and the two would be reported from the same scan. Exit 2, not 0 and not 1." >&2
    exit 2
fi

failures=()

# =================================================================================
# CHECK A: exactly ONE definition, in the right crate, and zero re-implementations.
# =================================================================================
mapfile -t SHAPED < <(
    for f in "${FILES[@]}"; do
        resolver_shaped_blocks "$f"
    done
)

# `mapfile` on empty input yields a one-element array holding "". Normalise that away.
if [ "${#SHAPED[@]}" -eq 1 ] && [ -z "${SHAPED[0]}" ]; then
    SHAPED=()
fi

if [ "${#SHAPED[@]}" -eq 0 ]; then
    failures+=(
"CHECK A: NO definition of a belt end's world cell was found anywhere under ${ROOTS[*]}.
    This is a FAILURE and not a pass. A gate that goes green when its subject does not
    exist is a gate that cannot fail: every other check in this file would report 'no
    duplication' about a resolver that had been deleted or renamed out from under it.
    Expected exactly one, in ${DEF_FILE}."
    )
elif [ "${#SHAPED[@]}" -gt 1 ]; then
    listed=""
    for s in "${SHAPED[@]}"; do
        listed="${listed}
      ${s}"
    done
    failures+=(
"CHECK A: ${#SHAPED[@]} functions derive a belt end's cell and its inner neighbour:${listed}
    Exactly one may. That derivation was written out twice before phase 74 - in
    dock_still_reaches and in the Dock validate arm - and the two agreed on every belt
    pair anyone had tested. Collapse the new one into the resolver in ${DEF_FILE} and
    call it by name. Do NOT narrow this gate's patterns to make the finding go away."
    )
else
    only="${SHAPED[0]}"
    case "$only" in
        "${DEF_FILE}":*) ;;
        *)
            failures+=(
"CHECK A: the one definition is at '${only}', not in ${DEF_FILE}.
    If the resolver genuinely moved, move this gate's DEF_FILE in the same commit and say
    why. If it did not move, something else now carries its shape."
            )
            ;;
    esac
    def_line="$(printf '%s' "$only" | cut -d: -f2)"
    if ! sed -n "${def_line}p" "$DEF_FILE" | grep 'pub fn' >/dev/null; then
        failures+=(
"CHECK A: the definition at ${only} is not a \`pub fn\`.
    A private resolver cannot be the ONE definition its readers in another crate call by
    name, which is the whole of LINK-11."
        )
    fi
fi

# =================================================================================
# CHECK B: the RETURN SHAPE is declared exactly once.
#
# Name-independent, so it fails on the disguise CHECK A cannot see: a duplicate written
# with entirely different local identifiers still has to return a cell plus an OPTIONAL
# outward side, because that optional is what a single-tile belt answers.
# =================================================================================
sig_hits=()
for f in "${FILES[@]}"; do
    while IFS= read -r hit; do
        [ -n "$hit" ] && sig_hits+=("${f}:${hit}")
    done < <(code_only "$f" | grep -nE "$W_SIG" | cut -d: -f1 || true)
done

if [ "${#sig_hits[@]}" -eq 0 ]; then
    failures+=(
"CHECK B: no function anywhere under ${ROOTS[*]} declares the resolver's return shape
    (a world cell plus an OPTIONAL outward side). Same reasoning as CHECK A: an absent
    subject is a failure, not a clean bill of health."
    )
elif [ "${#sig_hits[@]}" -gt 1 ]; then
    listed=""
    for s in "${sig_hits[@]}"; do
        listed="${listed}
      ${s}"
    done
    failures+=(
"CHECK B: ${#sig_hits[@]} functions declare the resolver's return shape:${listed}
    Exactly one may. The optional side is the load-bearing half of that signature - it is
    what a single-tile belt answers - so a second function returning it is a second
    resolver whatever its locals are named."
    )
fi

# =================================================================================
# CHECK C: the NAMED READERS ask by name. The floor is TWO; see the top of this file.
# =================================================================================
READER_FILES=(
    "crates/fabrico-core/src/state.rs"
    "crates/fabrico-command/src/command.rs"
)
READER_MARKERS=(
    "fn dock_still_reaches"
    "GridCommand::Dock [{]"
)
READER_TERMINATORS=(
    "^    (pub )?(fn|pub[(]crate[)] fn) "
    "^        GridCommand::"
)
READER_NAMES=(
    "GridState::dock_still_reaches"
    "the GridCommand::Dock validate arm"
)

readers_found=0
for i in "${!READER_FILES[@]}"; do
    rf="${READER_FILES[$i]}"
    if [ ! -f "$rf" ]; then
        failures+=("CHECK C: reader file '${rf}' does not exist.")
        continue
    fi
    range="$(block_range "$rf" "${READER_MARKERS[$i]}" "${READER_TERMINATORS[$i]}")"
    rstart="${range%%:*}"
    rend="${range##*:}"
    if [ "$rstart" = "0" ]; then
        failures+=(
"CHECK C: '${READER_NAMES[$i]}' was not found in ${rf}.
    It was renamed, moved, or deleted. Point this gate at where it went, in the same
    commit - do NOT drop the reader from the list, which is how a floor of two silently
    becomes a floor of one."
        )
        continue
    fi
    if block_text "$rf" "$rstart" "$rend" | grep -E "${W_FN}[[:space:]]*[(]" >/dev/null; then
        readers_found=$((readers_found + 1))
    else
        failures+=(
"CHECK C: '${READER_NAMES[$i]}' (${rf}:${rstart}-${rend}) does not call the resolver.
    It needs the answer and must ask for it by name rather than deriving it. A reader
    that stops asking is how the second copy gets written."
        )
    fi
done

if [ "$readers_found" -lt "$MIN_READERS" ]; then
    failures+=(
"CHECK C: ${readers_found} named reader(s) call the resolver, below the MEASURED floor of
    ${MIN_READERS}. Read the block at the top of this file before changing that number:
    the Unlink arm and belt_docks are deliberately NOT readers, and adding a call to
    either to raise this count would be a dead call."
    )
fi

total_calls=0
for f in "${FILES[@]}"; do
    n="$(production_calls "$f")"
    total_calls=$((total_calls + n))
done

if [ "$total_calls" -lt "$MIN_CALLS" ]; then
    failures+=(
"CHECK C: ${total_calls} production call expression(s) of the resolver, below the MEASURED
    floor of ${MIN_CALLS}. Two readers make three calls: dock_still_reaches asks once, and
    the Dock validate arm asks twice - once for the carrier belt's own end and once for a
    belt TARGET's end. A count that has dropped means one of those three stopped asking."
    )
fi

# =================================================================================
# The verdict.
# =================================================================================
if [ "${#failures[@]}" -ne 0 ]; then
    echo "FAIL: the belt-end resolver is not the single definition LINK-11 requires:" >&2
    echo >&2
    for msg in "${failures[@]}"; do
        printf '  - %s\n\n' "$msg" >&2
    done
    exit 1
fi

echo "OK: ${#FILES[@]} Rust files scanned across ${ROOTS[*]}."
echo "    ONE definition of a belt end's world cell and outward side, in ${DEF_FILE};"
echo "    ${readers_found} named readers ask it by name, over ${total_calls} production call sites;"
echo "    no other function derives the same answer for itself."
exit 0
