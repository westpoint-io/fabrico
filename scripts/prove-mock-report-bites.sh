#!/usr/bin/env bash
#
# prove-mock-report-bites.sh - the bite proof for scripts/check-mock-report.sh, the checker that
# decides the mock e2e suite's verdict by comparing its Playwright JSON report with the suite's exact
# `--list` (phase 111, plan 111-07, VERD-01, decisions D-03 and D-04).
#
# WHY IT EXISTS. The mock verdict replaces the exit code of `CI=1 npm run test:e2e`, which passes a
# skipped test and a deleted spec file. A checker that drifted towards "OK" would switch the mock gate
# off without anyone seeing it, so this proof shows each of its rules red on hand-made input.
#
# THE FIXTURES. Every list and report is hand-made under `mktemp -d` (never in the tree) in the shape
# of a real Playwright 1.61 report and `--list --reporter=json` output, read on 2026-11-21: one file
# suite per spec file, each holding two describes ("describe A" and "describe B") of PER specs in
# project `chromium`. A list is the same JSON with empty `results` and status `skipped`. The suite is
# four files f1 to f4 of 180 tests each, 720 in all, so it clears the floor of 700 without any option
# (the checker refuses --min-tests). Shard k of 4 holds file fk, 180 tests, over the shard floor of
# 700 / (2 * 4) = 87. Single-shard cases use shard 2/4.
#
#   M1  shard 2/4 matching its list                     -> exit 0, verdict=OK
#   M2  four shards (--merge 4) matching the whole list -> exit 0, tests=720
#   M3  a whole run matching the whole list             -> exit 0, verdict=OK
#   M4  one test dropped from the shard report          -> exit 1, named `not in the report`
#   M5  a test skipped itself                           -> exit 1, named `skipped`
#   M6  a test did not run                              -> exit 1, named `did not run`
#   M7  a flaky test (failed, then passed)              -> exit 1, named `flaky`
#   M8  a test turned into test.fail()                  -> exit 1, named `marked test.fail()`
#   M9  a test interrupted                              -> exit 1, named `failed: interrupted`
#   M10 a test failed                                   -> exit 1, named `failed: failed`
#   M11 no --list                                       -> exit 2
#   M12 the list of shard 3/4 read with --shard 2/4     -> exit 2, 3/4 named
#   M13 a shard list given to --merge                   -> exit 2
#   M14 a report key that isn't on the list             -> exit 2, `not on the list`
#   M15 a list with zero tests                          -> exit 2
#   M16 a whole list and run of 540 tests               -> exit 2, below the floor of 700
#   M17 --min-tests given                               -> exit 2, refused
#   M18 merge paths for shards 2 and 3 swapped          -> exit 2
#   M19 --merge 4 with three paths                      -> exit 2
#   M20 the report is not JSON                          -> exit 2
#   M21 the report carries a top-level error            -> exit 2
#   M22 shard 2/4 list and report of 80 tests           -> exit 2, below the shard floor of 87
#   M23 one test in shards 2 and 3 of a merge           -> exit 2, `appear twice`
#   M24 a shard report read in single mode              -> exit 2
#   M25 the list carries a top-level error              -> exit 2
#   M26 shard 3's report path missing from a merge      -> exit 2, the path named
#
# Every case checks its exit code, then its verdict word (exit 0 prints verdict=OK, exit 1
# verdict=RED, exit 2 verdict=UNMEASURED), then the text named in the table, which for every exit-1
# case includes the offender's file, line and titles.
#
# THE CHECKER UNDER TEST is `MOCK_REPORT_CHECKER`, default the tracked scripts/check-mock-report.sh.
# The override exists so a deliberately broken copy can be run through this proof and seen to turn it
# red.
#
# EXIT CODES (the repository's prover convention):
#   0  every case as expected
#   1  one or more cases wrong; every wrong case is named in one run
#   2  the proof could not be made: no jq, no checker, a fixture that could not be built, or a
#      temp-dir failure

set -euo pipefail

# Sourced first: the helper records where this script lives. Shape A with no probes: every list and
# report is written under `mktemp -d`, and the helper compares this checkout's tracked tree before
# and after to prove it.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source-path=SCRIPTDIR source=lib/prover-isolation.sh
. "${SCRIPT_DIR}/lib/prover-isolation.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel 2>/dev/null)" || {
    echo "prove-mock-report-bites: not inside the repository; COULD NOT PROVE" >&2
    exit 2
}
CHECKER="${MOCK_REPORT_CHECKER:-$ROOT/scripts/check-mock-report.sh}"

if ! command -v jq >/dev/null 2>&1; then
    echo "prove-mock-report-bites: jq not found; COULD NOT PROVE" >&2
    exit 2
fi
if [ ! -f "$CHECKER" ]; then
    echo "prove-mock-report-bites: checker $CHECKER missing; COULD NOT PROVE" >&2
    exit 2
fi

TMP="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/prove-mock-report.XXXXXX")" || {
    echo "prove-mock-report-bites: mktemp failed; COULD NOT PROVE" >&2
    exit 2
}
# shellcheck disable=SC2329  # invoked by the helper's EXIT trap
remove_tmp() {
    rm -rf -- "$TMP"
}
prover_on_exit remove_tmp
# shellcheck disable=SC2119  # no probes: this run writes only under mktemp -d
prover_isolate_untracked

# gen OUT FILES SHARD RESULTS PER: a list (RESULTS false) or a report (RESULTS true) holding the spec
# files named by FILES (a JSON array of numbers), each with PER specs in each of its two describes.
# SHARD is `null` or {"current":i,"total":n}, written as config.shard the way Playwright does.
gen() {
    jq -n --argjson files "$2" --argjson shard "$3" --argjson res "$4" --argjson per "$5" '
      def test:
        { timeout: 30000, annotations: [], expectedStatus: "passed",
          projectId: "chromium", projectName: "chromium",
          results: (if $res then [ { workerIndex: 0, parallelIndex: 0, status: "passed", duration: 900,
                                     errors: [], stdout: [], stderr: [], retry: 0,
                                     startTime: "2026-11-21T07:00:00.000Z", annotations: [],
                                     attachments: [] } ] else [] end),
          status: (if $res then "expected" else "skipped" end) };
      def spec(f; d; i; line):
        { title: "f\(f) \(d) t\(i)", ok: true, tags: [], tests: [ test ],
          id: "f\(f)-\(d)-\(i)", file: "f\(f).spec.ts", line: line, column: 3 };
      def describe(f; d; base):
        { title: "describe \(d)", file: "f\(f).spec.ts", line: base, column: 1,
          specs: [ range($per) as $i | spec(f; d; $i; base + 1 + $i) ] };
      { config: { version: "1.61.1", workers: 1, shard: $shard, projects: [ { name: "chromium" } ] },
        suites: [ $files[] as $f
                  | { title: "f\($f).spec.ts", file: "f\($f).spec.ts", line: 0, column: 0, specs: [],
                      suites: [ describe($f; "A"; 10), describe($f; "B"; 500) ] } ],
        errors: [],
        stats: { startTime: "2026-11-21T07:00:00.000Z", duration: 1000 } }' > "$1" || {
        echo "prove-mock-report-bites: could not build $1; COULD NOT PROVE" >&2
        exit 2
    }
}

# set_test IN OUT ID STATUS EXPECTED_STATUS RESULT... : copy IN with the test of spec ID changed.
set_test() {
    local in="$1" out="$2" id="$3" status="$4" expected="$5"
    shift 5
    local rs
    rs="$(printf '%s\n' "$@" | jq -R . | jq -s 'map(select(. != ""))')"
    jq --arg id "$id" --arg st "$status" --arg ex "$expected" --argjson rs "$rs" '
      (.. | objects | select(has("specs")) | .specs[] | select(.id == $id) | .tests[0]) |=
        (.status = $st | .expectedStatus = $ex
         | .results = [ $rs[] | { workerIndex: 0, parallelIndex: 0, status: ., duration: 900,
                                  errors: [], stdout: [], stderr: [], retry: 0,
                                  startTime: "2026-11-21T07:00:00.000Z", annotations: [],
                                  attachments: [] } ])' "$in" > "$out" || {
        echo "prove-mock-report-bites: could not build $out; COULD NOT PROVE" >&2
        exit 2
    }
}

failures=()
executed=0

# run_case ID WANT_RC MUST_CONTAIN CHECKER_ARGS...
run_case() {
    local id="$1" want="$2" must="$3"
    shift 3
    local out rc verdict
    executed=$((executed + 1))
    case "$want" in
        0) verdict="verdict=OK" ;;
        1) verdict="verdict=RED" ;;
        *) verdict="verdict=UNMEASURED" ;;
    esac
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
    if ! grep -qF -- "$verdict" <<< "$out"; then
        echo "  $id: WRONG, exit $rc as expected but the output does not say $verdict"
        printf '%s\n' "$out" | sed 's/^/      /'
        failures+=("$id: output does not say $verdict")
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

echo "prove-mock-report-bites: checker under test: $CHECKER"

PER=90
SHARD2='{"current":2,"total":4}'
W="$TMP/whole-list.json"
RW="$TMP/whole-report.json"
gen "$W" '[1,2,3,4]' null false "$PER"
gen "$RW" '[1,2,3,4]' null true "$PER"
for k in 1 2 3 4; do
    gen "$TMP/list-$k.json" "[$k]" "{\"current\":$k,\"total\":4}" false "$PER"
    gen "$TMP/report-$k.json" "[$k]" "{\"current\":$k,\"total\":4}" true "$PER"
done
L2="$TMP/list-2.json"
R2="$TMP/report-2.json"
R1="$TMP/report-1.json"; R3="$TMP/report-3.json"; R4="$TMP/report-4.json"

# The three modes, each matching its list.
run_case "M1 shard 2/4 matching its list" 0 \
    "MOCK REPORT total=180 passed=180 failed=0 skipped=0 did_not_run=0 flaky=0 expected_fail=0 verdict=OK" \
    --shard 2/4 --list "$L2" "$R2"
run_case "M2 four shards matching the whole list" 0 "MOCK SHARDS n=4 tests=720" \
    --merge 4 --list "$W" "$R1" "$R2" "$R3" "$R4"
run_case "M3 a whole run matching the whole list" 0 "MOCK LIST ids=720 reported=720 missing=0" \
    --list "$W" "$RW"

# M4 one test dropped from the shard report: named from the list.
jq 'del(.suites[0].suites[0].specs[5])' "$R2" > "$TMP/m4.json"
run_case "M4 one test dropped from the report" 1 \
    "RED [not in the report] f2.spec.ts:16 > describe A > f2 A t5" \
    --shard 2/4 --list "$L2" "$TMP/m4.json"

# M5 to M10: one test's outcome changed in the shard report.
set_test "$R2" "$TMP/m5.json" f2-A-7 skipped skipped skipped
run_case "M5 a test skipped itself" 1 "RED [skipped] f2.spec.ts:18 > describe A > f2 A t7" \
    --shard 2/4 --list "$L2" "$TMP/m5.json"
set_test "$R2" "$TMP/m6.json" f2-A-8 skipped passed skipped
run_case "M6 a test did not run" 1 "RED [did not run] f2.spec.ts:19 > describe A > f2 A t8" \
    --shard 2/4 --list "$L2" "$TMP/m6.json"
set_test "$R2" "$TMP/m7.json" f2-B-3 flaky passed failed passed
run_case "M7 a flaky test" 1 "RED [flaky] f2.spec.ts:504 > describe B > f2 B t3" \
    --shard 2/4 --list "$L2" "$TMP/m7.json"
set_test "$R2" "$TMP/m8.json" f2-B-4 expected failed failed
run_case "M8 a test turned into test.fail()" 1 \
    "RED [marked test.fail(), last result failed] f2.spec.ts:505 > describe B > f2 B t4" \
    --shard 2/4 --list "$L2" "$TMP/m8.json"
# Playwright files an interrupted test as status skipped, with one interrupted result.
set_test "$R2" "$TMP/m9.json" f2-B-5 skipped passed interrupted
run_case "M9 a test interrupted" 1 "RED [failed: interrupted] f2.spec.ts:506 > describe B > f2 B t5" \
    --shard 2/4 --list "$L2" "$TMP/m9.json"
set_test "$R2" "$TMP/m10.json" f2-B-6 unexpected passed failed
run_case "M10 a test failed" 1 "RED [failed: failed] f2.spec.ts:507 > describe B > f2 B t6" \
    --shard 2/4 --list "$L2" "$TMP/m10.json"

# M11 to M26: no verdict can be made.
run_case "M11 no --list" 2 "no --list given" --shard 2/4 "$R2"
run_case "M12 the list of shard 3/4 read as 2/4" 2 "carries config.shard 3/4, but --shard asked for 2/4" \
    --shard 2/4 --list "$TMP/list-3.json" "$R2"
run_case "M13 a shard list given to --merge" 2 "needs the whole list" \
    --merge 4 --list "$TMP/list-1.json" "$R1" "$R2" "$R3" "$R4"
jq '(.suites[0].suites[1].specs[2].id) = "from-another-tree"' "$R2" > "$TMP/m14.json"
run_case "M14 a report key that isn't on the list" 2 \
    "NOT ON THE LIST f2.spec.ts:503 > describe B > f2 B t2" \
    --shard 2/4 --list "$L2" "$TMP/m14.json"
jq '.suites = []' "$L2" > "$TMP/m15.json"
run_case "M15 a list with zero tests" 2 "holds zero tests" --shard 2/4 --list "$TMP/m15.json" "$R2"
gen "$TMP/m16-list.json" '[1,2,3]' null false "$PER"
gen "$TMP/m16-report.json" '[1,2,3]' null true "$PER"
run_case "M16 a whole list and run of 540 tests" 2 "holds 540 tests, below the floor of 700" \
    --list "$TMP/m16-list.json" "$TMP/m16-report.json"
run_case "M17 --min-tests given" 2 "--min-tests is refused" --min-tests 1 --list "$W" "$RW"
run_case "M18 merge paths for shards 2 and 3 swapped" 2 "carries config.shard 3/4, but it must be shard 2/4" \
    --merge 4 --list "$W" "$R1" "$R3" "$R2" "$R4"
run_case "M19 --merge 4 with three paths" 2 "needs 4 report paths" \
    --merge 4 --list "$W" "$R1" "$R2" "$R3"
printf 'Running 180 tests using 1 worker\n{ "suites": [\n' > "$TMP/m20.json"
run_case "M20 the report is not JSON" 2 "is not a JSON object" --shard 2/4 --list "$L2" "$TMP/m20.json"
jq '.errors = [ { message: "Error: Timed out waiting 60000ms from config.webServer." } ]' "$R2" > "$TMP/m21.json"
run_case "M21 the report carries a top-level error" 2 "top-level error: Error: Timed out waiting 60000ms" \
    --shard 2/4 --list "$L2" "$TMP/m21.json"
gen "$TMP/m22-list.json" '[2]' "$SHARD2" false 40
gen "$TMP/m22-report.json" '[2]' "$SHARD2" true 40
run_case "M22 a shard of 80 tests" 2 "holds 80 tests, below the shard floor of 87" \
    --shard 2/4 --list "$TMP/m22-list.json" "$TMP/m22-report.json"
jq --slurpfile two "$R2" '.suites[0].suites[0].specs += [ $two[0].suites[0].suites[0].specs[0] ]' \
    "$R3" > "$TMP/m23-3.json"
run_case "M23 one test in shards 2 and 3" 2 "DUPLICATE f2.spec.ts:11 > describe A > f2 A t0 (shard 2 and shard 3)" \
    --merge 4 --list "$W" "$R1" "$R2" "$TMP/m23-3.json" "$R4"
run_case "M24 a shard report read in single mode" 2 "this mode reads a whole run" --list "$W" "$R2"
jq '.errors = [ { message: "Error: f9.spec.ts: SyntaxError: Unexpected token" } ]' "$W" > "$TMP/m25.json"
run_case "M25 the list carries a top-level error" 2 "top-level error: Error: f9.spec.ts: SyntaxError" \
    --list "$TMP/m25.json" "$RW"
run_case "M26 shard 3's report path missing" 2 "m26-shard-3-never-uploaded.json' does not exist" \
    --merge 4 --list "$W" "$R1" "$R2" "$TMP/m26-shard-3-never-uploaded.json" "$R4"

DECLARED_TOTAL=26
if [ "$executed" -ne "$DECLARED_TOTAL" ]; then
    failures+=("ran $executed cases, declared $DECLARED_TOTAL")
fi

if [ "${#failures[@]}" -ne 0 ]; then
    echo "prove-mock-report-bites: FAILED, the checker does not bite on ${#failures[@]} case(s):"
    for x in "${failures[@]}"; do
        echo "  - $x"
    done
    exit 1
fi
echo "prove-mock-report-bites: PROVEN, $executed of $DECLARED_TOTAL cases as required"
exit 0
