#!/usr/bin/env bash
#
# check-board-structure.sh - the art board's STRUCTURAL gate (BOARD-01, plan 57-01).
#
# The board's neutrality is checked in two halves. Its rendered PROSE is checked by
# the Playwright spec (a token scan over innerText); everything below is the other
# half: the structural properties that no amount of careful wording can hold, and
# that a future change would otherwise be free to violate because nothing objected.
#
#   1. bundle exclusion  - the dev page is structurally absent from dist (D-05, Part G)
#   2. zero controls     - no interactive control and no persistence (N3, N4)
#   3. no selection      - no identifier carrying a "which one is chosen" state (N3)
#   4. nothing hidden    - no collapse, no details, no display:none but the readout (N10)
#   5. no reachability   - the board is not wired into the app, and no direction seam
#                          exists under src/render/ (Part G, Pitfall 7)
#
# HOUSE STYLE, and the two non-tradeable guards (Phase 56's recorded lesson). A bare
# `grep ... | wc -l` prints a number and ALWAYS EXITS 0: it is a decorative gate. So
# every check here ASSIGNS a count, ECHOES it, and ASSERTS `test "$HITS" = "0"`. And
# every check first LISTS its search corpus, because the assertion without the listing
# passes vacuously over a renamed or empty path, while the listing without the
# assertion never fails. Neither guard is optional and neither substitutes for the
# other.
#
# COMMENTS ARE STRIPPED BEFORE COUNTING. This file's own subject matter is a list of
# forbidden constructs, and so are the board module's header docblocks - a check that
# counted prose would be permanently red and would get "fixed" by weakening it into
# uselessness. Line/block comments (`//`, `/*`, ` *`) are filtered out of every count
# below, with LINE NUMBERS PRESERVED so a real hit is still a locator.
#
# NO PATH INPUT, EVER. The corpus is resolved from this script's own location, never
# from argv and never from cwd - the same rule scripts/lint-svg.ts follows, and for
# the same two reasons: a path-traversal surface, and a false-green source.
#
# MUTATION-PROVEN. Every check below was verified to redden on a deliberate violation
# before this file was committed; the five-row table is in 57-01-SUMMARY.md. A gate
# that passed on its first run has proven nothing. One row since added:
#
#   check 1, html files in dist/ (exactly index.html) - plan 91-03 (CHROME-06, D-05):
#     reddened with vite.config.ts's dev-fixture guard removed and a second html rollup
#     input added (the mutation is recorded as `MUT check-board-html` in that phase's
#     evidence). With the guard in place the same input fails the build by name first.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

FAILED=0

# The board's own source corpus, for checks 2, 3 and 4.
# artBoardLanes.ts joined the corpus in plan 57-08. A board module outside this list is
# a module the zero-controls, no-selection and nothing-hidden checks pass OVER rather
# than over nothing - the corpus is the gate, and a new section that is not in it is
# ungated no matter how carefully it was written.
#
# artBoardGeometry.ts and artBoardChannels.ts joined in the phase 57 review fix (WR-05).
# They were the two of the six board modules this list omitted, which meant the comment
# directly above described exactly the state the list was in. Checks 3 and 4 are not
# DOM-specific and apply to them in full: artBoardGeometry.ts is precisely where a
# `chosen` / `pinned` lane-width variable would appear if anyone added one, and it is
# the module the whole lane strip now draws through.
#
# artBoardChannels.ts LEFT the board's source corpus on 2026-08-16, and this is the
# deliberate paired edit the paragraph below demands: the module and the number were
# changed together, in one commit, for one stated reason. Its colour-vision transforms
# were never board-only. `render/assets/colourVision.test.ts` is the ART-03 gate over
# the SHIPPED palette and it imports `transformRgba` rather than re-authoring the
# Machado matrices, so a shipped gate rested on a module inside the tree's dev-tooling
# directory - which is also the one real violation check 5 was reporting. The module
# moved to `src/render/colourChannels.ts`, on the shipped side, and the board's panel
# now imports it from there like any other consumer. Nothing was exempted and nothing
# was removed from a scan to make a check pass: the file this list dropped is no longer
# a board module and no longer lives under src/spike/, so leaving it here would make
# the `corpus` existence guard fail on a path that cannot exist.
#
# ALL FIVE MODULES ARE LISTED, and the count is asserted below rather than left to a
# reader to check by eye - a corpus that silently loses an entry is the failure this
# whole file is written against.
BOARD_TS=(
  src/spike/artBoard.ts
  src/spike/artBoardSlate.ts
  src/spike/artBoardPanel.ts
  src/spike/artBoardLanes.ts
  src/spike/artBoardGeometry.ts
)

# The five board modules, stated as a literal. An assertion computed from the same array
# it is checking cannot fail, so this is the number a HUMAN wrote down: a module dropped
# from the list above reddens here instead of quietly shrinking every check below it.
BOARD_TS_EXPECTED=5
if [ "${#BOARD_TS[@]}" -ne "$BOARD_TS_EXPECTED" ]; then
  echo "FAIL: the board corpus holds ${#BOARD_TS[@]} modules, not $BOARD_TS_EXPECTED"
  echo "      Adding or removing a board section is a deliberate edit to BOARD_TS and to"
  echo "      BOARD_TS_EXPECTED together - never to one of them alone."
  FAILED=1
fi
BOARD_HTML=art-board.html
BOARD_SRC=("${BOARD_TS[@]}" "$BOARD_HTML")

# --- helpers ---------------------------------------------------------------

# Print a check's search corpus. A check whose corpus is empty or renamed must fail
# loudly rather than report zero hits over nothing.
corpus() {
  echo "  corpus:"
  local missing=0
  local f
  for f in "$@"; do
    if [ -e "$f" ]; then
      ls -1d "$f" | sed 's/^/    /'
    else
      echo "    MISSING: $f"
      missing=1
    fi
  done
  if [ "$missing" != "0" ]; then
    echo "  FAIL: search corpus is incomplete - this check would have passed over nothing"
    FAILED=1
  fi
}

# scan <extended-regex> <file...>  ->  `file:line:text` hits, comment lines removed.
scan() {
  local pat="$1"
  shift
  grep -nE "$pat" "$@" 2>/dev/null | grep -vE '^[^:]+:[0-9]+:[[:space:]]*(//|/\*|\*)' || true
}

# --- the allowlist helpers (review WR-06) ----------------------------------
#
# THE CARVE-OUTS ARE RESOLVED TO A LOCATION, NEVER APPLIED AS A CONTENT FILTER.
#
# Both allowlists used to be `grep -vF "$SENTENCE"`, which drops any line CONTAINING
# the allowlisted text as a substring - anywhere, in any file, however much else is on
# that line. A line such as
#
#   const x = '... TODAY is a pinned reference, not a candidate.' + selectedDirection;
#
# carries a real `selected` hit and was filtered out in its entirety. The comment above
# check 3 claimed the opposite ("It is matched EXACTLY"), so the gate was weaker than
# its own documentation. Resolving the allowlist to ONE `file:line` and excluding that
# location - then re-scanning that line with the allowlisted text REMOVED - closes it:
# an adjacent line reddens, another file reddens, and a violation appended to the
# allowlisted line itself reddens too.

# allow_count <sentence> <file...> -> the number of OCCURRENCES, across all files.
#
# `grep -hoF | wc -l`, never `grep -cF | grep -v ':0$' | wc -l`. The old form counted
# FILES, so two copies of the sentence in one file still reported 1 - and with a
# SINGLE-file corpus `grep -c` omits the `file:` prefix entirely, so `grep -v ':0$'`
# could not filter a zero and the count read 1 even when the sentence was absent, which
# inverted the staleness check. `tr -d` because BSD/macOS `wc` pads with leading spaces
# (IN-08).
allow_count() {
  local sentence="$1"
  shift
  grep -hoF "$sentence" "$@" 2>/dev/null | wc -l | tr -d '[:space:]'
}

# allow_loc <sentence> <file...> -> `file:line` of the first occurrence, or empty.
allow_loc() {
  local sentence="$1"
  shift
  grep -nF "$sentence" "$@" 2>/dev/null | head -1 | cut -d: -f1,2
}

# drop_loc <file:line>  - filter reading `file:line:text` scan hits on stdin.
# Exact field comparison, not a substring match: the paths in this corpus carry no
# colons, so `$1:$2` is the location and nothing else can collide with it.
drop_loc() {
  awk -v loc="$1" -F: '($1 ":" $2) != loc'
}

# allow_remainder <file:line> <sentence> -> that line with the sentence excised.
#
# THIS IS WHAT MAKES THE CARVE-OUT A CARVE-OUT RATHER THAN A LINE-WIDE AMNESTY. The
# allowlist exists for one SENTENCE, so only that sentence is forgiven; whatever else
# shares its line is scanned normally.
allow_remainder() {
  local loc="$1"
  local sentence="$2"
  local file="${loc%%:*}"
  local line="${loc##*:}"
  awk -v n="$line" -v s="$sentence" '
    NR == n {
      i = index($0, s)
      if (i > 0) print substr($0, 1, i - 1) substr($0, i + length(s))
      else print $0
    }' "$file" 2>/dev/null
}

# assert_zero <label> <hits-text>
assert_zero() {
  local label="$1"
  local hits="$2"
  local n
  n=$(printf '%s' "$hits" | grep -c . || true)
  echo "  HITS=$n  ($label)"
  if [ "$n" != "0" ]; then
    printf '%s\n' "$hits" | sed 's/^/    /'
    echo "  FAIL: $label"
    FAILED=1
  fi
}

# --- check 1: bundle exclusion (D-05, 57-UI-SPEC Part G) -------------------
# vite.config.ts declares no build.rollupOptions.input, so index.html is the only
# rollup input and the board is absent from dist BY CONSTRUCTION. That is exactly why
# this gate exists: it is what keeps the property true after someone adds a rollup
# input for an unrelated reason, which is the only way it could ever break.

echo "check 1: the board is structurally absent from the production bundle"
echo "  building..."
if ! npm run build >/dev/null 2>&1; then
  echo "  FAIL: npm run build did not succeed - the bundle assertion has nothing to read"
  FAILED=1
fi
corpus dist
if [ -d dist ]; then
  echo "  dist contents:"
  ls -1 dist | sed 's/^/    /'
fi
assert_zero "board tokens in dist/" "$(grep -rlE 'art-board|artBoard' dist 2>/dev/null || true)"

# The shipped bundle holds exactly ONE page, and it is dist/index.html (plan 91-03,
# CHROME-06, D-05). The dev fixture pages (art-board, chrome-dpr-spike, pixel-guard and
# the static mark sheet) are served by the dev server only; a second html in dist/ is a
# second rollup input, which is how a fixture page would start to ship. Counted by file
# name, never by words in a page. This covers HTML PAGES ONLY (phase 91 review IN-A-04):
# a dev-only MODULE bundled into a script (src/spike/, render/assets/pilot.svg) is caught
# by vite.config.ts devFixtureGuardPlugin's buildEnd alone, since dist/ keeps no module
# paths to check by.
HTML_FILES="$(find dist -name '*.html' 2>/dev/null | LC_ALL=C sort)"
HTML_N=$(printf '%s' "$HTML_FILES" | grep -c . || true)
echo "  html files in dist/:"
printf '%s\n' "$HTML_FILES" | sed 's/^/    /'
echo "  HTML=$HTML_N  (html files in dist/ (exactly index.html))"
if [ "$HTML_N" != "1" ] || [ "$HTML_FILES" != "dist/index.html" ]; then
  echo "  FAIL: html files in dist/ (exactly index.html)"
  FAILED=1
fi

# --- check 2: zero interactive controls and zero persistence (N3, N4) ------
# The board has no state to record and nothing to record it with. A control is how an
# instrument acquires a preference; persistence is how it keeps one. The ONLY record
# of a choice is the art-direction lock, written by the maintainer.

echo "check 2: zero interactive controls and zero persistence"
corpus "${BOARD_SRC[@]}"
assert_zero "controls / persistence" \
  "$(scan "localStorage|sessionStorage|addEventListener\('click'|addEventListener\(\"click\"|<button|<input|<select|onclick" "${BOARD_SRC[@]}")"

# --- check 3: no selection state (N3) --------------------------------------
# Word boundaries so `data-direction`, `Direction`, `DIRECTIONS` and Pixi's own option
# names cannot false-positive.
#
# ONE ALLOWLISTED LOCATION, carved out deliberately rather than by a loose pattern: the
# board's standing header line says "TODAY is a pinned reference, not a candidate",
# verbatim from 57-UI-SPEC C.2, and that sentence is the whole reason the word appears
# on this page.
#
# IT IS MATCHED BY LOCATION AND BY SENTENCE, which is what the comment here used to
# claim and the implementation did not do (review WR-06). The carve-out forgives exactly
# one `file:line`, and on that line it forgives exactly the allowlisted sentence: a
# `pinned` identifier on an adjacent line reddens, one in another file reddens, and one
# appended to the allowlisted line itself reddens too.
#
# THE STEMS TAKE A SUFFIX (review WR-02). The pattern used to end every stem in `\b`,
# which cannot match a compound identifier: `\b` requires a NON-word character after
# `selected`, and the `D` of `selectedDirection` is a word character. So
# `selectedDirection` - the exact identifier the previous review used as its worked
# example of the violation this check exists to catch - walked straight through, as did
# `selectedLane`, `chosenWidth`, `pinnedLane` and `highlightedRow`. Two compounds were
# already spelled out literally (`activeDirection`, `currentDirection`), so the compound
# FORM was anticipated; the four generic stems just never got the same treatment.
#
# `[A-Za-z]*` after each stem, with the LEADING `\b` kept, is the whole fix. The leading
# boundary is what keeps `data-direction`, `Direction`, `DIRECTIONS` and Pixi's own
# option names clean - dropping it would match the `-pinned` inside a hyphenated
# attribute and the check would be relaxed within a phase. `active`/`current` keep their
# required `Direction` because those two words alone are far too common to ban.
#
# TIGHTER, NEVER LOOSER: this pattern is a strict superset of the one it replaces, and
# it was run over the committed tree BEFORE it was committed - the only hit is the
# allowlisted header sentence, so it reddens on nothing that is there today. All five
# compounds above were then planted in a board module one at a time and each one was
# observed to redden; the table is in 57-REVIEW-FIX.md.

SELECTION_PATTERN='\b(selected|chosen|pinned|highlight)[A-Za-z]*\b|\b(active|current)Direction[A-Za-z]*\b'

echo "check 3: no selection state"
corpus "${BOARD_SRC[@]}"
HEADER_ALLOW="Column order carries no meaning. TODAY is a pinned reference, not a candidate."
HEADER_HITS=$(allow_count "$HEADER_ALLOW" "${BOARD_TS[@]}")
HEADER_LOC=$(allow_loc "$HEADER_ALLOW" "${BOARD_TS[@]}")
echo "  allowlisted header sentence: $HEADER_HITS occurrence(s) at ${HEADER_LOC:-<not found>}"
if [ "$HEADER_HITS" != "1" ] || [ -z "$HEADER_LOC" ]; then
  echo "  FAIL: the allowlisted header sentence was not found exactly once - the carve-out is stale"
  FAILED=1
fi
assert_zero "selection-state identifiers" \
  "$(scan "$SELECTION_PATTERN" "${BOARD_SRC[@]}" | drop_loc "$HEADER_LOC" || true)"
# ...and the allowlisted line itself, with the forgiven sentence removed.
assert_zero "selection-state identifiers on the allowlisted line" \
  "$(allow_remainder "$HEADER_LOC" "$HEADER_ALLOW" | grep -nE "$SELECTION_PATTERN" || true)"

# --- check 4: nothing hidden (N10), source half ----------------------------
# Nothing on this board filters, collapses, toggles or hides a candidate, a channel, a
# zoom or a subject. D-07 forbids the CVD toggle by name; this generalises it.
#
# ONE carve-out, by EXACT LINE and BY ID: the readiness marker is an out-of-flow data
# marker that must not be rendered. The id assignment is asserted separately, so the
# exact-line allowlist cannot be reused to hide a different element.

echo "check 4: nothing on the board hides anything"
corpus "${BOARD_SRC[@]}"
READOUT_ALLOW="readout.style.display = 'none';"
READOUT_ID="readout.id = 'art-board-readout';"
READOUT_ID_HITS=$(allow_count "$READOUT_ID" "${BOARD_TS[@]}")
READOUT_LOC=$(allow_loc "$READOUT_ALLOW" "${BOARD_TS[@]}")
READOUT_HITS=$(allow_count "$READOUT_ALLOW" "${BOARD_TS[@]}")
echo "  readout id assignment: $READOUT_ID_HITS occurrence(s)"
echo "  allowlisted hide line: $READOUT_HITS occurrence(s) at ${READOUT_LOC:-<not found>}"
if [ "$READOUT_ID_HITS" != "1" ]; then
  echo "  FAIL: the allowlisted element is not the art-board readout - the carve-out is stale"
  FAILED=1
fi
if [ "$READOUT_HITS" != "1" ] || [ -z "$READOUT_LOC" ]; then
  echo "  FAIL: the allowlisted hide line was not found exactly once - the carve-out is stale"
  FAILED=1
fi
# The pattern names the HIDING forms only. An earlier draft matched every
# `.style.display =` assignment and reddened on `inline-block`, which is layout, not
# hiding - a check that fires on a legitimate construct gets relaxed rather than
# obeyed, and the relaxation is where the real hole enters.
HIDING_PATTERN="<details|display:[[:space:]]*none|\.style\.display[[:space:]]*=[[:space:]]*['\"]none['\"]|\.hidden[[:space:]]*=[[:space:]]*true|hidden="
# BY LOCATION, not by content - same correction as check 3 (review WR-06). The old
# `grep -vF "$READOUT_ALLOW"` dropped every line containing that assignment as a
# substring, wherever it appeared and whatever else was on it.
assert_zero "hiding constructs" \
  "$(scan "$HIDING_PATTERN" "${BOARD_SRC[@]}" | drop_loc "$READOUT_LOC" || true)"
assert_zero "hiding constructs on the allowlisted line" \
  "$(allow_remainder "$READOUT_LOC" "$READOUT_ALLOW" | grep -nE "$HIDING_PATTERN" || true)"

# --- check 5: reachability (Part G, Pitfall 7) -----------------------------
# The board is not wired into the app, and no direction seam exists under src/render/.
# A variant SYSTEM is the half-built skin picker SKIN-02 deleted one phase ago, and
# rebuilding the machinery a phase ago deleted is the single most likely regression in
# this milestone.
#
# art-board.html's own <script src> is NOT in this corpus and must not be: it is the
# board's one legitimate entry point. The corpus is src/, minus src/spike/.

echo "check 5: the board is unreachable from the app, and no direction seam exists"
corpus src src/render src/spike
assert_zero "imports of spike/artBoard from outside src/spike/" \
  "$(grep -rnE "spike/artBoard" src --include='*.ts' --include='*.tsx' 2>/dev/null \
     | grep -v '^src/spike/' || true)"
# WIDENED FROM THE BARE `setDirection` (review WR-12). The comment above claims this
# check proves "no direction seam exists under src/render/" and that "rebuilding the
# machinery a phase ago deleted is the single most likely regression in this milestone".
# A single exact identifier does not carry that claim: `applyDirection`, `useDirection`,
# `currentDirection`, `activeDirection`, `DIRECTION_REGISTRY`, `DirectionRegistry`,
# `setVariant` and `directionFor` all passed it, and every one of them is the seam.
#
# THE PATTERN NAMES SEAM SHAPES, not one name. It stays scoped to `src/render/` so
# board-local code under `src/spike/` - which legitimately carries a `Direction` type, a
# `DIRECTIONS` const and a `candidateDirections()` derivation - is unaffected. The word
# boundaries keep `Direction`, `DIRECTIONS` and `data-direction` from false-positiving.
#
# Verified clean over the committed tree at the time of widening: zero hits.
assert_zero "direction/variant seam under src/render/" \
  "$(grep -rnE '\b(set|use|apply|current|active)Direction\b|\bDIRECTION_REGISTRY\b|\bDirectionRegistry\b|\bsetVariant\b|\bdirectionFor\b' \
     src/render --include='*.ts' --include='*.tsx' 2>/dev/null || true)"

# --- verdict ---------------------------------------------------------------

echo
if [ "$FAILED" = "0" ]; then
  echo "check-board-structure: PASS (5 checks)"
  exit 0
fi
echo "check-board-structure: FAIL"
exit 1
