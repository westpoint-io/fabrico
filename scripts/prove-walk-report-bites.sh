#!/usr/bin/env bash
#
# prove-walk-report-bites.sh - the bite proof for scripts/check-walk-report.sh, which decides whether
# the lesson walk really ran.
#
# WHY IT RUNS IN CI, BEFORE THE MERGE. A checker that has drifted towards "OK" would let a skipped or
# missing walk test through. The walk runs as shards, and the `e2e-walk-verdict` job merges their blob
# reports into one JSON report for the checker. That job runs this first, so if the checker no longer
# bites the job fails before the merged report is read.
#
# Every report is hand-made under `mktemp -d`, in the shape of a real Playwright 1.61 report: a file
# suite with top-level specs, and a nested describe with more. So the checker has to walk the same
# nesting a real report has.
#
#   K1  FLOOR tests, all passed                         -> exit 0, verdict=OK
#   K2  FLOOR + 1 tests, all passed                     -> exit 0, verdict=OK
#   R1  a test skipped itself                           -> exit 1, the test named
#   R2  a test didn't run, with a skipped result        -> exit 1, the test named
#   R3  a test didn't run, with an empty result list    -> exit 1, the test named
#   R4  a test failed                                   -> exit 1, the test named
#   R5  a test timed out                                -> exit 1, the test named
#   R6  a test was flaky                                -> exit 1, the test named
#   R7  a test marked test.fail() failed                -> exit 1, the test named
#   R8  a test titled like a live suite CUT failed      -> exit 1, the test named
#   U1  FLOOR - 1 tests, all passed                     -> exit 2, the floor named
#   U2  a top-level error                               -> exit 2
#   U3  the report is missing                           -> exit 2
#   U4  the report is empty                             -> exit 2
#   U5  the report isn't JSON                           -> exit 2
#   U6  the report has no `suites`                      -> exit 2
#   U7  the report holds zero tests                     -> exit 2
#   U8  a status the checker doesn't know               -> exit 2
#   U9  no argument                                     -> exit 2
#   U10 two reports                                     -> exit 2
#   U11 an attempt to lower the floor with --min-tests  -> exit 2
#   WM1 a merged report with one shard's files missing  -> exit 2, the floor named
#   WM2 a merged report carrying a shard's timeout      -> exit 2, the error named
#
# THE CHECKER UNDER TEST is `WALK_REPORT_CHECKER`, default the tracked scripts/check-walk-report.sh.
# The override exists so a deliberately broken copy can be run through this proof and seen to turn it
# red.
#
# THE FLOOR is the one literal below. Every count that follows the walk's floor is derived from it, so
# raising the floor is two one-line edits: MIN_TESTS in the checker and FLOOR here. This proof keeps
# its own literal and doesn't read the checker's, so a checker whose floor was lowered fails U1.
#
# EXIT CODES (the repository's prover convention):
#   0  every case as expected
#   1  one or more cases wrong, each named in one run
#   2  the proof could not be made: no jq, no checker, or a temp-dir failure

set -euo pipefail

FLOOR=25

# Sourced first: the helper records where this script lives. Its Shape A with no probes: every report
# is written under `mktemp -d`, and the helper compares this checkout's tracked tree before and after.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source-path=SCRIPTDIR source=lib/prover-isolation.sh
. "${SCRIPT_DIR}/lib/prover-isolation.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel 2>/dev/null)" || {
    echo "prove-walk-report-bites: not inside the repository; COULD NOT PROVE" >&2
    exit 2
}
CHECKER="${WALK_REPORT_CHECKER:-$ROOT/scripts/check-walk-report.sh}"

if ! command -v jq >/dev/null 2>&1; then
    echo "prove-walk-report-bites: jq not found; COULD NOT PROVE" >&2
    exit 2
fi
if [ ! -f "$CHECKER" ]; then
    echo "prove-walk-report-bites: checker $CHECKER missing; COULD NOT PROVE" >&2
    exit 2
fi

TMP="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/prove-walk-report.XXXXXX")" || {
    echo "prove-walk-report-bites: mktemp failed; COULD NOT PROVE" >&2
    exit 2
}
# shellcheck disable=SC2329  # invoked by the helper's EXIT trap
remove_tmp() {
    rm -rf -- "$TMP"
}
prover_on_exit remove_tmp
# shellcheck disable=SC2119  # no probes: this run writes only under mktemp -d
prover_isolate_untracked

SPEC=lessons.walk.ts
TOP='a top-level test'
NESTED='a test inside a describe'
CUT='CUT - leg 1 of the walk'

# The base report: FLOOR - 1 passing tests, one below the walk's floor. One is at the top of the file
# suite and the rest are in a describe under it: one named test and FLOOR - 3 fillers.
BELOW_FLOOR="$TMP/below-floor.json"
jq -n --arg spec "$SPEC" --arg top "$TOP" --arg nested "$NESTED" --argjson fillers "$((FLOOR - 3))" --argjson below "$((FLOOR - 1))" '
  def t(title; line):
    { title: title, ok: true, tags: [], id: ("id-" + (line|tostring)), file: $spec, line: line, column: 1,
      tests: [ { timeout: 90000, annotations: [], expectedStatus: "passed", projectId: "walk", projectName: "walk",
                 results: [ { workerIndex: 0, parallelIndex: 0, status: "passed", duration: 1200, errors: [],
                              stdout: [], stderr: [], retry: 0, startTime: "2026-10-31T07:00:00.000Z",
                              annotations: [], attachments: [] } ],
                 status: "expected" } ] };
  { config: { version: "1.61.1", workers: 1, projects: [ { name: "walk", retries: 0 } ] },
    suites: [ { title: $spec, file: $spec, line: 0, column: 0,
                specs: [ t($top; 5) ],
                suites: [ { title: "a describe", file: $spec, line: 10, column: 1,
                            specs: ( [ t($nested; 20) ] + [ range($fillers) as $i | t("filler \($i)"; 30 + $i) ] ) } ] } ],
    errors: [],
    stats: { startTime: "2026-10-31T07:00:00.000Z", duration: 4800, expected: $below, skipped: 0, unexpected: 0, flaky: 0 } }' \
    > "$BELOW_FLOOR" || {
    echo "prove-walk-report-bites: could not build the base report; COULD NOT PROVE" >&2
    exit 2
}

# with_more IN OUT COUNT: copy IN with COUNT more passing tests, copied from the top-level one.
with_more() {
    jq --argjson n "$3" '
      .suites[0].specs += [ range($n) as $i | .suites[0].specs[0] | .title = "extra \($i)" | .line = (100 + $i) ]' \
        "$1" > "$2"
}
BASE="$TMP/base.json"
with_more "$BELOW_FLOOR" "$BASE" 1

# one_test OUT TITLE STATUS EXPECTED_STATUS RESULT... : copy the base with one test changed.
one_test() {
    local out="$1" title="$2" status="$3" expected="$4"
    shift 4
    local rs
    rs="$(printf '%s\n' "$@" | jq -R . | jq -s 'map(select(. != ""))')"
    jq --arg title "$title" --arg st "$status" --arg ex "$expected" --argjson rs "$rs" '
      (.. | objects | select(has("specs")) | .specs[] | select(.title == $title) | .tests[0]) |=
        (.status = $st | .expectedStatus = $ex
         | .results = [ $rs[] | { workerIndex: 0, parallelIndex: 0, status: ., duration: 900, errors: [],
                                  stdout: [], stderr: [], retry: 0, startTime: "2026-10-31T07:00:00.000Z",
                                  annotations: [], attachments: [] } ])' \
        "${BASE_FOR_ONE:-$BASE}" > "$out"
}

failures=()
executed=0

# run_case ID WANT_RC MUST_CONTAIN CHECKER_ARGS...
run_case() {
    local id="$1" want="$2" must="$3"
    shift 3
    local out rc
    executed=$((executed + 1))
    set +e
    out="$(bash "$CHECKER" "$@" 2>&1)"
    rc=$?
    set -e
    if [ "$rc" -ne "$want" ]; then
        echo "  $id: WRONG, exit $rc, expected $want"
        printf '%s\n' "$out" | sed 's/^/      /'
        failures+=("$id: exit $rc, expected $want")
        return
    fi
    if [ -n "$must" ] && ! grep -qF -- "$must" <<< "$out"; then
        echo "  $id: WRONG, exit $rc as expected but the output does not contain: $must"
        printf '%s\n' "$out" | sed 's/^/      /'
        failures+=("$id: output does not name: $must")
        return
    fi
    echo "  $id: exit $rc as required"
}

echo "prove-walk-report-bites: checker under test: $CHECKER"

run_case "K1 $FLOOR tests, all passed" 0 "total=$FLOOR passed=$FLOOR failed=0" "$BASE"
with_more "$BASE" "$TMP/k2.json" 1
run_case "K2 $((FLOOR + 1)) tests, all passed" 0 "total=$((FLOOR + 1))" "$TMP/k2.json"

one_test "$TMP/r1.json" "$TOP" skipped skipped skipped
run_case "R1 a test skipped itself" 1 "RED [skipped] $SPEC:5 > $TOP" "$TMP/r1.json"

one_test "$TMP/r2.json" "$NESTED" skipped passed skipped
run_case "R2 a test did not run, with a skipped result" 1 "RED [did not run] $SPEC:20 > a describe > $NESTED" "$TMP/r2.json"

one_test "$TMP/r3.json" "$NESTED" skipped passed
run_case "R3 a test did not run, with no result" 1 "RED [did not run] $SPEC:20" "$TMP/r3.json"

one_test "$TMP/r4.json" "$NESTED" unexpected passed failed
run_case "R4 a test failed" 1 "RED [failed: failed] $SPEC:20" "$TMP/r4.json"

one_test "$TMP/r5.json" "$NESTED" unexpected passed timedOut
run_case "R5 a test timed out" 1 "RED [failed: timedOut] $SPEC:20" "$TMP/r5.json"

one_test "$TMP/r6.json" "$NESTED" flaky passed failed passed
run_case "R6 a flaky test" 1 "RED [flaky, failed then passed] $SPEC:20" "$TMP/r6.json"

one_test "$TMP/r7.json" "$NESTED" expected failed failed
run_case "R7 a test marked test.fail()" 1 "RED [marked test.fail()" "$TMP/r7.json"

jq --arg top "$TOP" --arg cut "$CUT" '(.suites[0].specs[] | select(.title == $top) | .title) = $cut' "$BASE" > "$TMP/r8.in.json"
BASE_FOR_ONE="$TMP/r8.in.json" one_test "$TMP/r8.json" "$CUT" unexpected passed failed
run_case "R8 a test titled like a CUT failed" 1 "RED [failed: failed] $SPEC:5 > $CUT" "$TMP/r8.json"

run_case "U1 $((FLOOR - 1)) tests, all passed" 2 "below the floor of $FLOOR" "$BELOW_FLOOR"

jq '.errors = [ { message: "Error: Timed out waiting 60000ms from config.webServer." } ]' "$BASE" > "$TMP/u2.json"
run_case "U2 a top-level error" 2 "verdict=UNMEASURED" "$TMP/u2.json"

run_case "U3 a missing report" 2 "verdict=UNMEASURED" "$TMP/does-not-exist.json"

: > "$TMP/u4.json"
run_case "U4 an empty report" 2 "verdict=UNMEASURED" "$TMP/u4.json"

printf 'Running 13 tests using 1 worker\n{ "suites": [\n' > "$TMP/u5.json"
run_case "U5 an unparsable report" 2 "verdict=UNMEASURED" "$TMP/u5.json"

jq 'del(.suites)' "$BASE" > "$TMP/u6.json"
run_case "U6 a report without suites" 2 "verdict=UNMEASURED" "$TMP/u6.json"

jq '.suites = []' "$BASE" > "$TMP/u7.json"
run_case "U7 zero tests" 2 "verdict=UNMEASURED" "$TMP/u7.json"

one_test "$TMP/u8.json" "$NESTED" weird passed passed
run_case "U8 a status the checker does not know" 2 "unrecognised test status" "$TMP/u8.json"

run_case "U9 no argument" 2 "verdict=UNMEASURED"

run_case "U10 two reports" 2 "more than one report" "$BASE" "$BASE"

run_case "U11 an attempt to lower the floor" 2 "unknown option" --min-tests 1 "$BELOW_FLOOR"

# A MERGED REPORT, as the walk verdict job reads it: one file suite per walk file, from three shards.
# The FLOOR tests are spread over three files, one file per shard, so each case below loses or breaks
# one shard's part of the walk.
SHARD_ONE=$((FLOOR / 3))
SHARD_TWO=$((FLOOR / 3))
SHARD_THREE=$((FLOOR - SHARD_ONE - SHARD_TWO))
MERGED="$TMP/merged.json"
jq --argjson a "$SHARD_ONE" --argjson b "$SHARD_TWO" --argjson c "$SHARD_THREE" '
  .suites[0].specs[0] as $t
  | def file(name; n): { title: name, file: name, line: 0, column: 0,
                         specs: [ range(n) as $i | $t | .file = name | .title = "test \($i)" | .line = (10 + $i) ] };
  .suites = [ file("shard-one.walk.ts"; $a), file("shard-two.walk.ts"; $b), file("shard-three.walk.ts"; $c) ]' \
    "$BASE" > "$MERGED"

# WM1: a shard's blob never reached the merge (its leg crashed before writing it, or the download
# missed it), so the merged report holds the other two shards' files only.
jq '.suites |= map(select(.file != "shard-two.walk.ts"))' "$MERGED" > "$TMP/wm1.json"
run_case "WM1 a merged report with one shard's files missing" 2 \
    "the report holds $((FLOOR - SHARD_TWO)) tests, below the floor of $FLOOR" "$TMP/wm1.json"

# WM2: a shard hit the walk config's globalTimeout. Its blob carries the run's top-level error, and
# the merge copies it into the merged report.
jq '.errors = [ { message: "Timed out waiting 3300s for the test suite to run" } ]' "$MERGED" > "$TMP/wm2.json"
run_case "WM2 a merged report carrying a shard's timeout" 2 \
    "top-level error: Timed out waiting 3300s for the test suite to run" "$TMP/wm2.json"

# The number of cases above, K1 to WM2. It counts cases, not tests, so it doesn't follow the floor.
DECLARED_TOTAL=23
if [ "$executed" -ne "$DECLARED_TOTAL" ]; then
    failures+=("ran $executed cases, declared $DECLARED_TOTAL")
fi

if [ "${#failures[@]}" -ne 0 ]; then
    echo "prove-walk-report-bites: FAILED, the checker does not bite on ${#failures[@]} case(s):"
    for x in "${failures[@]}"; do
        echo "  - $x"
    done
    exit 1
fi
echo "prove-walk-report-bites: PROVEN, $executed of $DECLARED_TOTAL cases as required"
exit 0
