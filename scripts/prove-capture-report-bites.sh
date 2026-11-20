#!/usr/bin/env bash
#
# prove-capture-report-bites.sh - the bite proof for scripts/check-capture-report.sh, which decides
# whether the board capture set really ran and whether its expected failures are declared.
#
# WHY IT RUNS IN CI, BEFORE THE CHECKER. A checker that has drifted towards "OK" would let a skipped,
# lost or unexplained capture test through. The `e2e-capture` job runs this proof first, so if the
# checker no longer bites the job fails before the real report is read.
#
# Every report is hand-made under `mktemp -d`, in the shape of a real Playwright 1.61 report of the
# capture set: a `board.capture.ts` file suite with one capture spec, and a `board-grade.capture.ts`
# file suite with the grading specs. Tags sit on the spec without their leading `@`, the way the JSON
# reporter writes them, and a declared test carries a `fixed-by` annotation, the way the grading file
# declares one.
#
#   C1  the report is missing                                        -> exit 2
#   C2  the report is empty                                          -> exit 2
#   C3  the report isn't JSON                                        -> exit 2
#   C4  the report has no `suites`                                   -> exit 2
#   C5  a top-level error                                            -> exit 2
#   C6  the report holds zero tests                                  -> exit 2
#   C7  one test fewer than the floor, all passed                    -> exit 2, the floor named
#   C8  the floor's count of tests, all passed                       -> exit 0, verdict=OK
#   C9  a test skipped itself                                        -> exit 1
#   C10 a test with no result                                        -> exit 1
#   C11 a flaky test                                                 -> exit 1
#   C12 a failed test                                                -> exit 1
#   C13 an expected failure with no tag                              -> exit 1
#   C14 an expected failure tagged STRK-01 and STRK-02               -> exit 1
#   C15 an expected failure tagged STRK-02 in board.capture.ts       -> exit 1
#   C16 an expected failure tagged STRK-02 in board-grade.capture.ts -> exit 0, DECLARED [@STRK-02]
#   C17 a test marked test.fail() that passed                        -> exit 1
#
# THE CHECKER UNDER TEST is `CAPTURE_REPORT_CHECKER`, default the tracked
# scripts/check-capture-report.sh. The override exists so a deliberately broken copy can be run
# through this proof and seen to turn it red.
#
# THE FLOOR is read from the checker's `MIN_TESTS=` line, so raising it is one edit. A checker with
# no such line, or a floor below 2 (one capture test and one grading test), is exit 2.
#
# EXIT CODES (the repository's prover convention):
#   0  every case as expected
#   1  one or more cases wrong, each named in one run
#   2  the proof could not be made: no jq, no checker, no floor, or a temp-dir failure

set -euo pipefail

# Sourced first: the helper records where this script lives. Its Shape A with no probes: every report
# is written under `mktemp -d`, and the helper compares this checkout's tracked tree before and after.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source-path=SCRIPTDIR source=lib/prover-isolation.sh
. "${SCRIPT_DIR}/lib/prover-isolation.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel 2>/dev/null)" || {
    echo "prove-capture-report-bites: not inside the repository; COULD NOT PROVE" >&2
    exit 2
}
CHECKER="${CAPTURE_REPORT_CHECKER:-$ROOT/scripts/check-capture-report.sh}"

if ! command -v jq >/dev/null 2>&1; then
    echo "prove-capture-report-bites: jq not found; COULD NOT PROVE" >&2
    exit 2
fi
if [ ! -f "$CHECKER" ]; then
    echo "prove-capture-report-bites: checker $CHECKER missing; COULD NOT PROVE" >&2
    exit 2
fi
MIN_TESTS="$(sed -n 's/^MIN_TESTS=\([0-9][0-9]*\)$/\1/p' "$CHECKER")"
case "$MIN_TESTS" in
    '' | *[!0-9]* | 0 | 1)
        echo "prove-capture-report-bites: no MIN_TESTS= line of 2 or more in $CHECKER (read '$MIN_TESTS'); COULD NOT PROVE" >&2
        exit 2
        ;;
esac

TMP="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/prove-capture-report.XXXXXX")" || {
    echo "prove-capture-report-bites: mktemp failed; COULD NOT PROVE" >&2
    exit 2
}
# shellcheck disable=SC2329  # invoked by the helper's EXIT trap
remove_tmp() {
    rm -rf -- "$TMP"
}
prover_on_exit remove_tmp
# shellcheck disable=SC2119  # no probes: this run writes only under mktemp -d
prover_isolate_untracked

CAPTURE_FILE=board.capture.ts
GRADE_FILE=board-grade.capture.ts
CAPTURE='capture dpr=1 aa=shipped'
GRADE='outline-sides dpr=1 aa=shipped zoom=boot'

# report OUT GRADE_COUNT: one passing capture test and GRADE_COUNT passing grading tests. The first
# grading test is titled GRADE, the rest are fillers at other zooms.
report() {
    jq -n --arg cf "$CAPTURE_FILE" --arg gf "$GRADE_FILE" --arg capture "$CAPTURE" --arg grade "$GRADE" \
        --argjson n "$2" '
      def t(file; title; line; project):
        { title: title, ok: true, tags: [], id: ("id-" + file + "-" + (line|tostring)), file: file, line: line, column: 3,
          tests: [ { timeout: 90000, annotations: [], expectedStatus: "passed", projectId: project, projectName: project,
                     results: [ { workerIndex: 0, parallelIndex: 0, status: "passed", duration: 900, errors: [],
                                  stdout: [], stderr: [], retry: 0, startTime: "2026-11-20T09:00:00.000Z",
                                  annotations: [], attachments: [] } ],
                     status: "expected" } ] };
      { config: { version: "1.61.1", workers: 1, projects: [ { name: "capture", retries: 0 }, { name: "grade", retries: 0 } ] },
        suites: [ { title: $cf, file: $cf, line: 0, column: 0, specs: [ t($cf; $capture; 49; "capture") ] },
                  { title: $gf, file: $gf, line: 0, column: 0,
                    specs: ( [ t($gf; $grade; 22; "grade") ]
                             + [ range($n - 1) as $i | t($gf; "outline-sides dpr=1 aa=shipped zoom=\($i + 2)"; 22; "grade") ] ) } ],
        errors: [],
        stats: { startTime: "2026-11-20T09:00:00.000Z", duration: 11000, expected: ($n + 1), skipped: 0, unexpected: 0, flaky: 0 } }' \
        > "$1"
}

BASE="$TMP/base.json"
BELOW_FLOOR="$TMP/below-floor.json"
if ! report "$BASE" "$((MIN_TESTS - 1))" || ! report "$BELOW_FLOOR" "$((MIN_TESTS - 2))"; then
    echo "prove-capture-report-bites: could not build the base reports; COULD NOT PROVE" >&2
    exit 2
fi

# one_test OUT FILE TITLE STATUS EXPECTED_STATUS TAGS_JSON RESULT... : copy the base with the test
# titled TITLE in FILE changed: its status, its expected status, its spec's tags and its results.
one_test() {
    local out="$1" file="$2" title="$3" status="$4" expected="$5" tags="$6"
    shift 6
    local rs
    rs="$(printf '%s\n' "$@" | jq -R . | jq -s 'map(select(. != ""))')"
    jq --arg file "$file" --arg title "$title" --arg st "$status" --arg ex "$expected" \
        --argjson tags "$tags" --argjson rs "$rs" '
      (.suites[] | select(.file == $file) | .specs[] | select(.title == $title)) |=
        (.tags = $tags
         | .tests[0] |= (.status = $st | .expectedStatus = $ex
             | .annotations = (if $ex == "failed" then [ { type: "fixed-by", description: "core 4, 3, 4, 4 on machine 3" } ] else [] end)
             | .results = [ $rs[] | { workerIndex: 0, parallelIndex: 0, status: ., duration: 900, errors: [],
                                      stdout: [], stderr: [], retry: 0, startTime: "2026-11-20T09:00:00.000Z",
                                      annotations: [], attachments: [] } ]))' \
        "$BASE" > "$out"
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
        echo "  $id: WRONG, expected exit $want, got $rc"
        printf '%s\n' "$out" | sed 's/^/      /'
        failures+=("$id: expected exit $want, got $rc")
        return
    fi
    if [ -n "$must" ] && ! grep -qF -- "$must" <<< "$out"; then
        echo "  $id: WRONG, expected exit $want, got $rc, but the output does not contain: $must"
        printf '%s\n' "$out" | sed 's/^/      /'
        failures+=("$id: output does not name: $must")
        return
    fi
    echo "  $id: expected exit $want, got $rc"
}

echo "prove-capture-report-bites: checker under test: $CHECKER (floor $MIN_TESTS)"

run_case "C1 a missing report" 2 "verdict=UNMEASURED" "$TMP/does-not-exist.json"

: > "$TMP/c2.json"
run_case "C2 an empty report" 2 "verdict=UNMEASURED" "$TMP/c2.json"

printf 'Running 3 tests using 1 worker\n{ "suites": [\n' > "$TMP/c3.json"
run_case "C3 a report that isn't JSON" 2 "verdict=UNMEASURED" "$TMP/c3.json"

jq 'del(.suites)' "$BASE" > "$TMP/c4.json"
run_case "C4 a report without suites" 2 "verdict=UNMEASURED" "$TMP/c4.json"

jq '.errors = [ { message: "Error: Timed out waiting 60000ms from config.webServer." } ]' "$BASE" > "$TMP/c5.json"
run_case "C5 a top-level error" 2 "top-level error: Error: Timed out waiting 60000ms" "$TMP/c5.json"

jq '.suites = []' "$BASE" > "$TMP/c6.json"
run_case "C6 zero tests" 2 "the report holds zero tests" "$TMP/c6.json"

run_case "C7 $((MIN_TESTS - 1)) tests, one below the floor" 2 "below the floor of $MIN_TESTS" "$BELOW_FLOOR"

run_case "C8 $MIN_TESTS tests, all passed" 0 \
    "total=$MIN_TESTS passed=$MIN_TESTS declared=0 failed=0 skipped=0 did_not_run=0 flaky=0 verdict=OK" "$BASE"

one_test "$TMP/c9.json" "$GRADE_FILE" "$GRADE" skipped skipped '[]' skipped
run_case "C9 a test skipped itself" 1 "RED [skipped] $GRADE_FILE:22 > $GRADE" "$TMP/c9.json"

one_test "$TMP/c10.json" "$CAPTURE_FILE" "$CAPTURE" skipped passed '[]'
run_case "C10 a test with no result" 1 "RED [did not run] $CAPTURE_FILE:49 > $CAPTURE" "$TMP/c10.json"

one_test "$TMP/c11.json" "$GRADE_FILE" "$GRADE" flaky passed '[]' failed passed
run_case "C11 a flaky test" 1 "RED [flaky, failed then passed] $GRADE_FILE:22 > $GRADE" "$TMP/c11.json"

one_test "$TMP/c12.json" "$GRADE_FILE" "$GRADE" unexpected passed '[]' failed
run_case "C12 a failed test" 1 "RED [failed: failed] $GRADE_FILE:22 > $GRADE" "$TMP/c12.json"

one_test "$TMP/c13.json" "$GRADE_FILE" "$GRADE" expected failed '[]' failed
run_case "C13 an expected failure with no tag" 1 "no STRK requirement tag" "$TMP/c13.json"

one_test "$TMP/c14.json" "$GRADE_FILE" "$GRADE" expected failed '["STRK-01","STRK-02"]' failed
run_case "C14 an expected failure tagged STRK-01 and STRK-02" 1 "2 STRK tags (@STRK-01 @STRK-02)" "$TMP/c14.json"

one_test "$TMP/c15.json" "$CAPTURE_FILE" "$CAPTURE" expected failed '["STRK-02"]' failed
run_case "C15 an expected failure tagged STRK-02 in $CAPTURE_FILE" 1 "outside $GRADE_FILE" "$TMP/c15.json"

one_test "$TMP/c16.json" "$GRADE_FILE" "$GRADE" expected failed '["STRK-02"]' failed
run_case "C16 an expected failure tagged STRK-02 in $GRADE_FILE" 0 \
    "DECLARED [@STRK-02] $GRADE_FILE:22 > $GRADE" "$TMP/c16.json"

one_test "$TMP/c17.json" "$GRADE_FILE" "$GRADE" unexpected failed '["STRK-02"]' passed
run_case "C17 a test marked test.fail() that passed" 1 "RED [failed: passed] $GRADE_FILE:22 > $GRADE" "$TMP/c17.json"

# The number of cases above, C1 to C17. It counts cases, not tests, so it doesn't follow the floor.
DECLARED_TOTAL=17
if [ "$executed" -ne "$DECLARED_TOTAL" ]; then
    failures+=("ran $executed cases, declared $DECLARED_TOTAL")
fi

if [ "${#failures[@]}" -ne 0 ]; then
    echo "prove-capture-report-bites: FAILED, the checker does not bite on ${#failures[@]} case(s):"
    for x in "${failures[@]}"; do
        echo "  - $x"
    done
    exit 1
fi
echo "prove-capture-report-bites: PROVEN, $executed of $DECLARED_TOTAL cases as required"
exit 0
