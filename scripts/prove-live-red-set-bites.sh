#!/usr/bin/env bash
#
# prove-live-red-set-bites.sh - the bite proof for scripts/check-live-red-set.sh, the
# checker that decides the live e2e suite's verdict from its Playwright JSON report
# (phase 84, plan 84-02, GATE-07 and GATE-01's live job).
#
# WHY IT RUNS IN CI, BEFORE THE SUITE. The live job swallows `npm run e2e:live`'s exit
# code, because the suite carries a CUT that throws forever, and hands the verdict to the
# checker. A checker that has drifted towards "OK" would then switch the whole live gate
# off without anyone seeing it. So the `e2e-live` job runs this proof first; if the
# checker no longer bites, the job fails before the suite starts.
#
# WHAT EACH CASE PROVES, and only that. Every report is hand-made under `mktemp -d`
# (never in the tree) in the real Playwright 1.61 JSON shape, read from a real report on
# 2026-10-12: one file suite whose `specs` hold the top-level CUT and whose nested
# `suites` hold a describe of three ordinary legs, so the checker must walk the same
# nesting the real report has. A test that did not run behind a failed serial leg has
# `status: "skipped"`, `expectedStatus: "passed"` and one `skipped` result; a skip the
# test asked for has `expectedStatus: "skipped"`.
#
#   K1  only the CUT failed                            -> exit 0, verdict=OK cut_failed=1
#   K2  the CUT and leg 2 failed                       -> exit 1, leg 2 named
#   K3  the CUT failed and leg 2 timed out             -> exit 1, leg 2 named
#   K4  the CUT passed                                 -> exit 1, the CUT named
#   K5  leg 3 failed, so the CUT did not run           -> exit 1, the CUT named
#   K6  the CUT did not run, with an empty result list -> exit 1, the CUT named
#   K7  leg 1 skipped itself                           -> exit 1, leg 1 named
#   K8  leg 2 was flaky (failed, then passed)          -> exit 1, leg 2 named
#   K9  the CUT turned into test.fail()                -> exit 1, the CUT named
#   K10 leg 2 turned into test.fail()                  -> exit 1, leg 2 named
#   U1  a top-level error in the report                -> exit 2, verdict=UNMEASURED
#   U2  the report file is missing                     -> exit 2
#   U3  the report file is empty                       -> exit 2
#   U4  the report is not JSON                         -> exit 2
#   U5  the report has no `suites`                     -> exit 2
#   U6  the report holds zero tests                    -> exit 2
#   U7  four tests and no --min-tests (floor 290)      -> exit 2
#   U8  no argument at all                             -> exit 2
#   U9  an unknown option                              -> exit 2
#   F1  a full-size run, the fatal spec last           -> exit 0, verdict=OK (phase 90 review WR-C-01)
#   U10 the same run without the fatal spec            -> exit 2, the file named (a `--project live` run)
#   U11 the fatal spec started before another test ended -> exit 2
#   S1  one shard (--shard 2/4), the fatal spec last    -> exit 0, verdict=OK
#   S2  that shard with the fatal spec started early    -> exit 2
#   S3  a shard 3/4 report read with --shard 2/4        -> exit 2, both named
#   S4  --shard together with --min-tests               -> exit 2
#   S5  a shard without the fatal spec                  -> exit 2, the file named
#   S6  a shard below its floor of 290 / (2 * 4) = 36   -> exit 2
#   M1  four valid shards (--merge 4), CUT in shard 3   -> exit 0, cut_failed=1 verdict=OK
#   M2  shard 3's report missing                        -> exit 2, the path named
#   M3  shard 2's report again at position 3            -> exit 2
#   M4  four shards summing to 244                      -> exit 2, below the floor of 290
#   M5  shard 4 without the fatal spec                  -> exit 2
#   M6  a non-CUT test failed in shard 2                -> exit 1, the test named
#   M7  shard 4 stopped by the global timeout           -> exit 2
#   M8  one test id in shards 1 and 2                   -> exit 2
#   M9  shard 2 with 3 of the fatal spec's 4 tests      -> exit 2
#   M10 --merge 4 with three paths                      -> exit 2
#   M11 four valid shards and no CUT                    -> exit 0, cut_failed=0 verdict=OK
#
# Every K case except K1 runs with `--min-tests 1`, so the floor cannot be what turns it
# red; K1 also passes `--min-tests 4`, the fixture's exact count. Every exit-1 case must
# name its offender's title, and every exit-2 case must print `verdict=UNMEASURED`.
#
# THE CHECKER UNDER TEST is `LIVE_RED_SET_CHECKER`, default the tracked
# scripts/check-live-red-set.sh. The override exists so a deliberately broken copy can be
# run through this proof and seen to turn it red.
#
# EXIT CODES (the repository's prover convention):
#   0  every case as expected
#   1  one or more cases wrong; every wrong case is named in one run
#   2  the proof could not be made: no jq, no checker, or a temp-dir failure

set -euo pipefail

# Sourced first: the helper records where this script lives. Its Shape A with no probes
# (plan 84-04, GATE-03): every report is written under `mktemp -d`, and the helper compares
# this checkout's tracked tree before and after to prove it.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source-path=SCRIPTDIR source=lib/prover-isolation.sh
. "${SCRIPT_DIR}/lib/prover-isolation.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel 2>/dev/null)" || {
    echo "prove-live-red-set-bites: not inside the repository; COULD NOT PROVE" >&2
    exit 2
}
CHECKER="${LIVE_RED_SET_CHECKER:-$ROOT/scripts/check-live-red-set.sh}"

if ! command -v jq >/dev/null 2>&1; then
    echo "prove-live-red-set-bites: jq not found; COULD NOT PROVE" >&2
    exit 2
fi
if [ ! -f "$CHECKER" ]; then
    echo "prove-live-red-set-bites: checker $CHECKER missing; COULD NOT PROVE" >&2
    exit 2
fi

TMP="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/prove-live-red-set.XXXXXX")" || {
    echo "prove-live-red-set-bites: mktemp failed; COULD NOT PROVE" >&2
    exit 2
}
# shellcheck disable=SC2329  # invoked by the helper's EXIT trap
remove_tmp() {
    rm -rf -- "$TMP"
}
prover_on_exit remove_tmp
# shellcheck disable=SC2119  # no probes: this run writes only under mktemp -d
prover_isolate_untracked

SPEC=77-one-board-all-five.live.spec.ts
LEG1='leg 1 - a Route and an HTTP Handler answer a POST'
LEG2='leg 2 - a belt from a Source packs solid back through the join'
LEG3='leg 3 - that run jams behind a Tee and clears when released'
CUT='CUT - leg 3 clause "clears from the front": overturned on 2026-10-08'

# The base report: three legs passed in a describe, the top-level CUT failed.
BASE="$TMP/base.json"
jq -n --arg spec "$SPEC" --arg l1 "$LEG1" --arg l2 "$LEG2" --arg l3 "$LEG3" --arg cut "$CUT" '
  def t(title; line; status; rs):
    { title: title, ok: (status != "unexpected"), tags: [], id: ("id-" + (line|tostring)),
      file: $spec, line: line, column: 1,
      tests: [ { timeout: 90000, annotations: [], expectedStatus: "passed",
                 projectId: "live", projectName: "live",
                 results: [ rs[] | { workerIndex: 0, parallelIndex: 0, status: ., duration: 1200,
                                     errors: [], stdout: [], stderr: [], retry: 0,
                                     startTime: "2026-10-12T07:00:00.000Z", annotations: [],
                                     attachments: [] } ],
                 status: status } ] };
  { config: { version: "1.61.1", workers: 1, projects: [ { name: "live", retries: 0 } ] },
    suites: [ { title: $spec, file: $spec, line: 0, column: 0,
                specs: [ t($cut; 300; "unexpected"; ["failed"]) ],
                suites: [ { title: "one board, all five", file: $spec, line: 10, column: 1,
                            specs: [ t($l1; 20; "expected"; ["passed"]),
                                     t($l2; 120; "expected"; ["passed"]),
                                     t($l3; 220; "expected"; ["passed"]) ] } ] } ],
    errors: [],
    stats: { startTime: "2026-10-12T07:00:00.000Z", duration: 4800, expected: 3, skipped: 0,
             unexpected: 1, flaky: 0 } }' > "$BASE" || {
    echo "prove-live-red-set-bites: could not build the base report; COULD NOT PROVE" >&2
    exit 2
}

# set_test OUT TITLE STATUS EXPECTED_STATUS RESULT... : copy the base with one test changed.
set_test() {
    local out="$1" title="$2" status="$3" expected="$4"
    shift 4
    local rs
    rs="$(printf '%s\n' "$@" | jq -R . | jq -s 'map(select(. != ""))')"
    jq --arg title "$title" --arg st "$status" --arg ex "$expected" --argjson rs "$rs" '
      (.. | objects | select(has("specs")) | .specs[] | select(.title == $title) | .tests[0]) |=
        (.status = $st | .expectedStatus = $ex
         | .results = [ $rs[] | { workerIndex: 0, parallelIndex: 0, status: ., duration: 900,
                                  errors: [], stdout: [], stderr: [], retry: 0,
                                  startTime: "2026-10-12T07:00:00.000Z", annotations: [],
                                  attachments: [] } ])' \
        "${out}.in" > "$out"
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

# A fixture built from the base by one or more set_test calls.
fixture() {
    local name="$1"
    cp "$BASE" "$TMP/$name.json.in"
    echo "$TMP/$name.json"
}
apply() {
    local f="$1"
    shift
    set_test "$f" "$@"
    cp "$f" "${f}.in"
}

echo "prove-live-red-set-bites: checker under test: $CHECKER"

# K1 only the CUT failed.
f="$(fixture k1)"; cp "$BASE" "$f"
run_case "K1 only the CUT failed" 0 "verdict=OK" --min-tests 4 "$f"
run_case "K1 cut_failed=1 in the summary" 0 "cut_failed=1" --min-tests 1 "$f"

# K2 the CUT and leg 2 failed.
f="$(fixture k2)"; apply "$f" "$LEG2" unexpected passed failed
run_case "K2 the CUT plus leg 2 failed" 1 "$LEG2" --min-tests 1 "$f"

# K3 leg 2 timed out.
f="$(fixture k3)"; apply "$f" "$LEG2" unexpected passed timedOut
run_case "K3 the CUT plus leg 2 timed out" 1 "$LEG2" --min-tests 1 "$f"

# K4 the CUT passed.
f="$(fixture k4)"; apply "$f" "$CUT" expected passed passed
run_case "K4 the CUT passed" 1 "$CUT" --min-tests 1 "$f"

# K5 leg 3 failed, so the serial CUT did not run.
f="$(fixture k5)"; apply "$f" "$LEG3" unexpected passed failed
apply "$f" "$CUT" skipped passed skipped
run_case "K5 the CUT did not run behind a failed leg" 1 "$CUT" --min-tests 1 "$f"

# K6 the CUT did not run, with no result at all.
f="$(fixture k6)"; apply "$f" "$CUT" skipped passed
run_case "K6 the CUT did not run (no result)" 1 "$CUT" --min-tests 1 "$f"

# K7 leg 1 skipped itself.
f="$(fixture k7)"; apply "$f" "$LEG1" skipped skipped skipped
run_case "K7 a non-CUT test skipped" 1 "$LEG1" --min-tests 1 "$f"

# K8 leg 2 flaky.
f="$(fixture k8)"; apply "$f" "$LEG2" flaky passed failed passed
run_case "K8 a flaky test" 1 "$LEG2" --min-tests 1 "$f"

# K9 the CUT as test.fail(): Playwright calls that expected.
f="$(fixture k9)"; apply "$f" "$CUT" expected failed failed
run_case "K9 the CUT turned into test.fail()" 1 "$CUT" --min-tests 1 "$f"

# K10 leg 2 as test.fail().
f="$(fixture k10)"; apply "$f" "$LEG2" expected failed failed
run_case "K10 a non-CUT test turned into test.fail()" 1 "$LEG2" --min-tests 1 "$f"

# U1 a top-level error.
f="$TMP/u1.json"
jq '.errors = [ { message: "Error: Timed out waiting 60000ms from config.webServer." } ]' "$BASE" > "$f"
run_case "U1 a top-level error" 2 "verdict=UNMEASURED" --min-tests 1 "$f"

# U2 missing.
run_case "U2 a missing report" 2 "verdict=UNMEASURED" --min-tests 1 "$TMP/does-not-exist.json"

# U3 empty.
: > "$TMP/u3.json"
run_case "U3 an empty report" 2 "verdict=UNMEASURED" --min-tests 1 "$TMP/u3.json"

# U4 not JSON.
printf 'Running 180 tests using 1 worker\n{ "suites": [\n' > "$TMP/u4.json"
run_case "U4 an unparsable report" 2 "verdict=UNMEASURED" --min-tests 1 "$TMP/u4.json"

# U5 no suites.
jq 'del(.suites)' "$BASE" > "$TMP/u5.json"
run_case "U5 a report without suites" 2 "verdict=UNMEASURED" --min-tests 1 "$TMP/u5.json"

# U6 zero tests.
jq '.suites = []' "$BASE" > "$TMP/u6.json"
run_case "U6 zero tests" 2 "verdict=UNMEASURED" --min-tests 1 "$TMP/u6.json"

# U7 below the floor.
run_case "U7 below the 290-test floor" 2 "verdict=UNMEASURED" "$BASE"

# F1, U10, U11 (phase 90 review WR-C-01): a full-size run, no --min-tests. The base report plus
# 290 passing tests in another file, all ended by 07:00:02, plus the fatal spec's four tests,
# started at 07:10.
TERMINAL=90-sim-fatal.terminal.spec.ts
FULL="$TMP/f1.json"
jq --arg tf "$TERMINAL" '
  def r(start): [ { workerIndex: 0, parallelIndex: 0, status: "passed", duration: 1000, errors: [],
                    stdout: [], stderr: [], retry: 0, startTime: start, annotations: [], attachments: [] } ];
  def spec(file; i; start): { title: ("t" + (i|tostring)), ok: true, tags: [], id: (file + (i|tostring)),
    file: file, line: (i + 1), column: 1,
    tests: [ { timeout: 90000, annotations: [], expectedStatus: "passed", projectId: "p", projectName: "p",
               results: r(start), status: "expected" } ] };
  .suites += [ { title: "filler.spec.ts", file: "filler.spec.ts", line: 0, column: 0,
                 specs: [ range(290) as $i | spec("filler.spec.ts"; $i; "2026-10-12T07:00:00.500Z") ], suites: [] },
               { title: $tf, file: $tf, line: 0, column: 0,
                 specs: [ range(4) as $i | spec($tf; $i; "2026-10-12T07:10:00.000Z") ], suites: [] } ]' \
    "$BASE" > "$FULL" || {
    echo "prove-live-red-set-bites: could not build the full-size report; COULD NOT PROVE" >&2
    exit 2
}
run_case "F1 a full-size run with the fatal spec last" 0 "verdict=OK" "$FULL"
jq --arg tf "$TERMINAL" 'del(.suites[] | select(.file == $tf))' "$FULL" > "$TMP/u10.json"
run_case "U10 a full-size run without the fatal spec" 2 "$TERMINAL" "$TMP/u10.json"
jq --arg tf "$TERMINAL" '(.suites[] | select(.file == $tf) | .specs[0].tests[0].results[0].startTime) = "2026-10-12T07:00:01.000Z"' \
    "$FULL" > "$TMP/u11.json"
run_case "U11 the fatal spec started before another test ended" 2 "must run last" "$TMP/u11.json"

# U8 no argument.
run_case "U8 no argument" 2 "verdict=UNMEASURED"

# U9 an unknown option.
run_case "U9 an unknown option" 2 "verdict=UNMEASURED" --everything-is-fine "$BASE"

# make_shard OUT CURRENT TOTAL FILLER TERMINALS WITH_BASE PREFIX: one shard's report, the way
# Playwright writes it under --shard. `config.shard` is CURRENT/TOTAL; FILLER passing tests in
# the shard's own file (ids start with PREFIX, so no two shards share one), all ended by
# 07:00:02; then TERMINALS tests of the fatal spec, started at 07:10, with the same ids in every
# shard, because every shard runs its own copy as the teardown of `live`. WITH_BASE 1 keeps the
# base report's four tests (the three legs and the failed CUT), 0 drops them.
make_shard() {
    jq --arg tf "$TERMINAL" --argjson cur "$2" --argjson tot "$3" --argjson nf "$4" \
        --argjson nt "$5" --argjson base "$6" --arg pre "$7" '
      def r(start): [ { workerIndex: 0, parallelIndex: 0, status: "passed", duration: 1000, errors: [],
                        stdout: [], stderr: [], retry: 0, startTime: start, annotations: [], attachments: [] } ];
      def spec(file; id; i; project; start): { title: ("t" + (i|tostring)), ok: true, tags: [],
        id: (id + (i|tostring)), file: file, line: (i + 1), column: 1,
        tests: [ { timeout: 90000, annotations: [], expectedStatus: "passed", projectId: project,
                   projectName: project, results: r(start), status: "expected" } ] };
      ($pre + "filler.spec.ts") as $ff
      | .config.shard = { current: $cur, total: $tot }
      | .suites = (if $base == 1 then .suites else [] end)
          + [ { title: $ff, file: $ff, line: 0, column: 0,
                specs: [ range($nf) as $i | spec($ff; $pre; $i; "live"; "2026-10-12T07:00:00.500Z") ],
                suites: [] } ]
          + (if $nt == 0 then [] else
              [ { title: $tf, file: $tf, line: 0, column: 0,
                  specs: [ range($nt) as $i | spec($tf; "fatal-"; $i; "live-terminal"; "2026-10-12T07:10:00.000Z") ],
                  suites: [] } ] end)' \
        "$BASE" > "$1" || {
        echo "prove-live-red-set-bites: could not build shard report $1; COULD NOT PROVE" >&2
        exit 2
    }
}

# S1 to S6: one shard read with --shard. The shard floor at n=4 is 290 / 8 = 36 tests outside
# the fatal spec.
#   S1 a valid shard: the base's 4 tests, 40 filler, the fatal spec last -> exit 0
#   S2 the fatal spec started before a filler test ended                  -> exit 2, must run last
#   S3 a report carrying shard 3/4, read as --shard 2/4                    -> exit 2, 3/4 named
#   S4 --shard together with --min-tests                                   -> exit 2
#   S5 a shard with no test from the fatal spec                            -> exit 2, the file named
#   S6 the base's 4 tests and 30 filler, 34 in all                         -> exit 2, under 36
S1="$TMP/s1.json"
make_shard "$S1" 2 4 40 4 1 "s2-"
run_case "S1 a valid shard with the fatal spec last" 0 "verdict=OK" --shard 2/4 "$S1"
jq --arg tf "$TERMINAL" '(.suites[] | select(.file == $tf) | .specs[0].tests[0].results[0].startTime) = "2026-10-12T07:00:01.000Z"' \
    "$S1" > "$TMP/s2.json"
run_case "S2 a shard whose fatal spec started early" 2 "must run last" --shard 2/4 "$TMP/s2.json"
make_shard "$TMP/s3.json" 3 4 40 4 1 "s3-"
run_case "S3 a shard 3/4 report read as 2/4" 2 "config.shard 3/4, but --shard asked for 2/4" --shard 2/4 "$TMP/s3.json"
run_case "S4 --shard with --min-tests" 2 "cannot be combined" --shard 2/4 --min-tests 1 "$S1"
make_shard "$TMP/s5.json" 2 4 40 0 1 "s2-"
run_case "S5 a shard without the fatal spec" 2 "$TERMINAL" --shard 2/4 "$TMP/s5.json"
make_shard "$TMP/s6.json" 2 4 30 4 1 "s2-"
run_case "S6 a shard below its floor" 2 "below the shard floor of 36" --shard 2/4 "$TMP/s6.json"

# M1 to M11: four shards read with --merge 4. The valid set V1 to V4: 73 tests outside the fatal
# spec in each shard (shard 3 holds the base's 4 tests, the failed CUT among them, and 69
# filler), 292 in all, plus the fatal spec's 4 tests last in every shard, counted once: 296.
#   M1  the valid set                                      -> exit 0, cut_failed=1 verdict=OK
#   M2  shard 3's report path does not exist                -> exit 2, the path named
#   M3  shard 2's report given again at position 3          -> exit 2
#   M4  60 per shard, 244 in all                            -> exit 2, below the floor of 290
#   M5  shard 4 without the fatal spec                      -> exit 2
#   M6  a filler test failed in shard 2                     -> exit 1, the test named
#   M7  shard 4 stopped by the suite's global timeout       -> exit 2
#   M8  one test id in shards 1 and 2                       -> exit 2, both shards named
#   M9  shard 2 with 3 tests of the fatal spec, not 4       -> exit 2
#   M10 --merge 4 with three paths                          -> exit 2
#   M11 the valid set without the CUT                       -> exit 0, cut_failed=0 verdict=OK
V1="$TMP/v1.json"; V2="$TMP/v2.json"; V3="$TMP/v3.json"; V4="$TMP/v4.json"
make_shard "$V1" 1 4 73 4 0 "v1-"
make_shard "$V2" 2 4 73 4 0 "v2-"
make_shard "$V3" 3 4 69 4 1 "v3-"
make_shard "$V4" 4 4 73 4 0 "v4-"
run_case "M1 four valid shards, the CUT failed in shard 3" 0 \
    "LIVE RED SET total=296 passed=295 failed=1 skipped=0 did_not_run=0 flaky=0 cut_failed=1 verdict=OK" \
    --merge 4 "$V1" "$V2" "$V3" "$V4"
run_case "M2 shard 3's report is missing" 2 "m2-shard-3-never-uploaded.json" \
    --merge 4 "$V1" "$V2" "$TMP/m2-shard-3-never-uploaded.json" "$V4"
run_case "M3 shard 2's report at position 3" 2 "shard 3: check-live-red-set: report '$V2' carries config.shard 2/4, but --shard asked for 3/4" \
    --merge 4 "$V1" "$V2" "$V2" "$V4"
for k in 1 2 4; do make_shard "$TMP/m4-$k.json" "$k" 4 60 4 0 "m4-$k-"; done
make_shard "$TMP/m4-3.json" 3 4 56 4 1 "m4-3-"
run_case "M4 four shards below the summed floor" 2 "244 in all, below the floor of 290" \
    --merge 4 "$TMP/m4-1.json" "$TMP/m4-2.json" "$TMP/m4-3.json" "$TMP/m4-4.json"
make_shard "$TMP/m5-4.json" 4 4 73 0 0 "v4-"
run_case "M5 shard 4 without the fatal spec" 2 "shard 4: check-live-red-set: the report holds no test from $TERMINAL" \
    --merge 4 "$V1" "$V2" "$V3" "$TMP/m5-4.json"
M6_TITLE='shard two filler that failed'
jq --arg t "$M6_TITLE" '(.suites[] | select(.file == "v2-filler.spec.ts") | .specs[5]) |=
    (.title = $t | .ok = false | .tests[0].status = "unexpected" | .tests[0].results[0].status = "failed")' \
    "$V2" > "$TMP/m6-2.json"
run_case "M6 a failed test in shard 2" 1 "$M6_TITLE" --merge 4 "$V1" "$TMP/m6-2.json" "$V3" "$V4"
jq '.errors = [ { message: "Timed out waiting 5400s for the test suite to run" } ]' "$V4" > "$TMP/m7-4.json"
run_case "M7 shard 4 hit the global timeout" 2 "shard 4:   top-level error: Timed out waiting 5400s for the test suite to run" \
    --merge 4 "$V1" "$V2" "$V3" "$TMP/m7-4.json"
jq '(.suites[] | select(.file == "v2-filler.spec.ts") | .specs[0].id) = "v1-0"' "$V2" > "$TMP/m8-2.json"
run_case "M8 one test id in two shards" 2 "(shards 1 and 2)" --merge 4 "$V1" "$TMP/m8-2.json" "$V3" "$V4"
make_shard "$TMP/m9-2.json" 2 4 73 3 0 "v2-"
run_case "M9 shard 2 ran 3 of the fatal spec's 4 tests" 2 "terminal=4,3,4,4" \
    --merge 4 "$V1" "$TMP/m9-2.json" "$V3" "$V4"
run_case "M10 --merge 4 with three paths" 2 "needs 4 report paths" --merge 4 "$V1" "$V2" "$V3"
make_shard "$TMP/m11-3.json" 3 4 73 4 0 "v3-"
run_case "M11 four valid shards and no CUT" 0 \
    "LIVE RED SET total=296 passed=296 failed=0 skipped=0 did_not_run=0 flaky=0 cut_failed=0 verdict=OK" \
    --merge 4 "$V1" "$V2" "$TMP/m11-3.json" "$V4"

DECLARED_TOTAL=40
if [ "$executed" -ne "$DECLARED_TOTAL" ]; then
    failures+=("ran $executed cases, declared $DECLARED_TOTAL")
fi

if [ "${#failures[@]}" -ne 0 ]; then
    echo "prove-live-red-set-bites: FAILED, the checker does not bite on ${#failures[@]} case(s):"
    for x in "${failures[@]}"; do
        echo "  - $x"
    done
    exit 1
fi
echo "prove-live-red-set-bites: PROVEN, $executed of $DECLARED_TOTAL cases as required"
exit 0
