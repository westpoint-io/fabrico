#!/usr/bin/env bash
#
# The LIVE RED-SET gate: the live e2e suite's verdict is its failed set, read from
# Playwright's JSON report, and it passes only when that set is exactly the declared CUTs.
#
# ---------------------------------------------------------------------------------
# WHY THIS EXISTS. Do not delete it as ceremony.
#
# The live suite deliberately carries a CUT: a test titled `CUT - leg <n> ...` whose body
# throws its reason (77 D-15, D-20; the vitest audit in
# frontend/src/gates/oneBoardAllFive.source.test.ts holds that exact form with
# `CUT_TITLE = /^CUT - leg \d/`). A cut fails loudly by the maintainers' ruling, so it is never a
# `test.fail()`, never skipped and never deleted. That means `npm run e2e:live` exits 1
# FOREVER, and a gate that reads its exit code is either always red or switched off. Both
# hide every real regression. This script replaces the exit code with a named set.
#
# THE TWO STANDING RULES:
#
#   AN UNEXPECTED RED IS A REGRESSION. Any test that is not a CUT and did not pass
#   (failed, timed out, interrupted, flaky, skipped, did not run, or marked
#   `test.fail()`) makes this exit 1, named. The response is to fix it, never to retitle
#   it as a CUT.
#
#   A CUT THAT DID NOT FAIL IS NOT GOOD NEWS. A CUT that passed, or was turned into
#   `test.fail()`, means the cut was silenced or the clause came back without the
#   ruling being revisited. It is exit 1, named.
#
# A SERIAL FOLLOWER THAT DID NOT RUN IS RED. 77-one-board-all-five.live.spec.ts runs in
# serial mode, so one failed leg turns every later test into "did not run", the CUT
# included (it is declared last). A checker that only asked "did the CUT pass?" would
# read a CUT that never ran as green while a walking leg was broken (84-RESEARCH Pitfall
# 8). So anything that did not run, CUT or not, is exit 1.
#
# WHAT THIS DOES NOT CHECK. That the CUT exists at all is the vitest audit's job; with no
# CUT in the report, the rules above reduce to "every test passed".
#
# HOW A TEST IS CLASSIFIED (field names read from a real Playwright 1.61 report,
# 2026-10-12). Each spec's `tests[]` entry has a `status` and an `expectedStatus`:
#   expected   + expectedStatus passed  -> passed
#   expected   + expectedStatus failed  -> marked test.fail()
#   unexpected                          -> failed (its last result says failed, timedOut
#                                          or interrupted)
#   flaky                               -> flaky
#   skipped    + expectedStatus skipped -> skipped (the test asked to be skipped)
#   skipped    + anything else, or no result at all -> did not run
# Anything else is a report this script does not understand, and that is exit 2.
#
# EXIT CODES:
#   0  the failed set is exactly the CUTs, every CUT ran and failed, nothing else is red
#   1  it is not; every offender is printed as `<file>:<line> > <describes> > <title>`
#      with its status
#   2  the verdict COULD NOT BE MADE. This is a FAILURE, never a pass. The classes:
#        - no report path, more than one, or an unknown option
#        - the report is missing, empty or not JSON, or `jq` is not on the PATH
#        - the report has no `suites` array
#        - the report has a non-empty top-level `errors` (a webServer that never came
#          up, a config error, a worker crash outside any test)
#        - zero tests, or fewer than the floor (MIN_TESTS, or --min-tests)
#        - a full run (no --min-tests) with no test from a TERMINAL_FILES spec, or one that
#          started such a spec before another test ended
#        - a test status this script does not recognise
#
# A STALE REPORT. This script cannot tell a report from this run from one an earlier run
# left behind. `npm run e2e:live` therefore deletes test-results/live-report.json before it
# builds (review 84 WR-12): if the build fails, Playwright never starts, and grading the
# leftover would certify a run that never happened. A run started any other way (the
# webServer-less reuse config) must delete the report first too.
#
# The last stdout line is always:
#   LIVE RED SET total=<n> passed=<n> failed=<n> skipped=<n> did_not_run=<n> flaky=<n> cut_failed=<n> verdict=<OK|RED|UNMEASURED>
#
# USAGE: check-live-red-set.sh [--min-tests <n>] <report.json>

set -u

# The fewest tests a full live run may hold. Measured 301 at phase 90 review pass 2 (297 in
# `live`, 4 in `live-terminal`); a report below 290 is a filtered or partial run (one spec, a
# --grep, a crashed worker, `--project live` alone) being used as the gate, which measures some
# other suite. A deliberate partial run, such as the tracer over one spec, lowers it with
# --min-tests. Until review pass 2 the floor was 170 against a 297-test suite, so a run that
# dropped the whole terminal project still read OK (90-REVIEW.md WR-C-01).
MIN_TESTS=290

# THE TERMINAL SPECS A FULL PASS MUST HOLD, AND RUN LAST (phase 90 review WR-C-01). The fatal sim
# error spec ends the one shared dev host, so it runs in its own `live-terminal` project after every
# other test. A full run (no --min-tests) whose report holds no test from one of these files did not
# grade FAIL-01 at all, and one that started any of them before another test ended stopped the host
# under the rest of the suite: both are exit 2. A partial run (--min-tests) skips this check.
TERMINAL_FILES=('90-sim-fatal.terminal.spec.ts')

# The CUT title form, the same as the vitest audit's CUT_TITLE (/^CUT - leg \d/).
CUT_PATTERN='^CUT - leg [0-9]'

total=0
passed=0
failed=0
skipped=0
did_not_run=0
flaky=0
cut_failed=0
offenders=0

summary() {
    echo "LIVE RED SET total=$total passed=$passed failed=$failed skipped=$skipped did_not_run=$did_not_run flaky=$flaky cut_failed=$cut_failed verdict=$1"
}

unmeasured() {
    echo "check-live-red-set: $1; NO VERDICT (exit 2 is a failure, not a pass)" >&2
    summary UNMEASURED
    exit 2
}

min="$MIN_TESTS"
full=1
report=""
while [ $# -gt 0 ]; do
    case "$1" in
        --min-tests)
            [ $# -ge 2 ] || unmeasured "--min-tests needs a number"
            case "$2" in
                '' | *[!0-9]*) unmeasured "--min-tests needs a whole number, got '$2'" ;;
            esac
            min=$((10#$2))
            [ "$min" -ge 1 ] || unmeasured "--min-tests must be at least 1"
            full=0
            shift 2
            ;;
        -*)
            unmeasured "unknown option '$1'"
            ;;
        *)
            [ -z "$report" ] || unmeasured "more than one report given ('$report', '$1')"
            report="$1"
            shift
            ;;
    esac
done

[ -n "$report" ] || unmeasured "no report path given (usage: check-live-red-set.sh [--min-tests <n>] <report.json>)"
command -v jq >/dev/null 2>&1 || unmeasured "jq not found on the PATH"
[ -e "$report" ] || unmeasured "report '$report' does not exist"
[ -s "$report" ] || unmeasured "report '$report' is empty"
jq -e 'type == "object"' "$report" >/dev/null 2>&1 || unmeasured "report '$report' is not a JSON object"
jq -e '(.suites | type) == "array"' "$report" >/dev/null 2>&1 \
    || unmeasured "report '$report' has no suites array"

errs="$(jq -r '(.errors // []) | length' "$report" 2>/dev/null)" || unmeasured "cannot read the report's errors"
if [ "$errs" != "0" ]; then
    jq -r '.errors[] | "  top-level error: " + ((.message // tostring) | split("\n")[0])' "$report" >&2
    unmeasured "the report carries $errs top-level error(s)"
fi

# One tab-separated row per test: category, is-CUT, name, last result status.
rows="$(jq -r --arg cut "$CUT_PATTERN" '
  def clean: tostring | gsub("[\t\r\n]"; " ");
  def walk_tests(chain):
    ( (.specs // [])[] as $s
      | ($s.tests // [])[] as $t
      | ($t.results // []) as $rs
      | ($t.expectedStatus // "passed") as $ex
      | [ ( if ($rs | length) == 0 then "did_not_run"
            elif $t.status == "skipped" then (if $ex == "skipped" then "skipped" else "did_not_run" end)
            elif $t.status == "flaky" then "flaky"
            elif $t.status == "expected" then (if $ex == "passed" then "passed" else "expected_fail" end)
            elif $t.status == "unexpected" then "failed"
            else "unknown:" + ($t.status | clean) end ),
          ( if ($s.title | clean | test($cut)) then "1" else "0" end ),
          ( ($s.file | clean) + ":" + ($s.line | clean) + " > "
            + ((chain + [$s.title]) | map(clean) | join(" > ")) ),
          ( ($rs | last | .status) // "none" | clean ) ]
      | join("\t") ),
    ( (.suites // [])[] as $su | $su | walk_tests(chain + [$su.title]) );
  .suites[] | walk_tests([])
' "$report" 2>/dev/null)" || unmeasured "jq could not walk the report's suites"

while IFS=$'\t' read -r cat is_cut name last; do
    [ -n "$cat" ] || continue
    total=$((total + 1))
    case "$cat" in
        passed)
            passed=$((passed + 1))
            if [ "$is_cut" = 1 ]; then
                echo "RED [CUT passed] $name"
                offenders=$((offenders + 1))
            fi
            ;;
        failed)
            failed=$((failed + 1))
            if [ "$is_cut" = 1 ]; then
                cut_failed=$((cut_failed + 1))
                echo "CUT failed as declared: $name"
            else
                echo "RED [failed: $last] $name"
                offenders=$((offenders + 1))
            fi
            ;;
        expected_fail)
            failed=$((failed + 1))
            echo "RED [marked test.fail(), last result $last] $name"
            offenders=$((offenders + 1))
            ;;
        # THE SKIPPED-OR-DID-NOT-RUN RULE. A test that never ran proves nothing, and a
        # CUT that never ran is a hidden red leg ahead of it, not a CUT gone green.
        skipped | did_not_run)
            if [ "$cat" = skipped ]; then
                skipped=$((skipped + 1))
                label="skipped"
            else
                did_not_run=$((did_not_run + 1))
                label="did not run"
            fi
            [ "$is_cut" = 1 ] && label="$label, CUT"
            echo "RED [$label] $name"
            offenders=$((offenders + 1))
            ;;
        flaky)
            flaky=$((flaky + 1))
            echo "RED [flaky, failed then passed] $name"
            offenders=$((offenders + 1))
            ;;
        *)
            unmeasured "unrecognised test status '$cat' for $name"
            ;;
    esac
done <<< "$rows"

[ "$total" -gt 0 ] || unmeasured "the report holds zero tests"
[ "$total" -ge "$min" ] || unmeasured "the report holds $total tests, below the floor of $min (a partial run is not the gate)"

if [ "$full" = 1 ]; then
    for tf in "${TERMINAL_FILES[@]}"; do
        # Every result of a test from the terminal file, and of every other test, as millisecond
        # start and end times; the terminal file's first start must not come before the others'
        # last end.
        verdict="$(jq -r --arg f "$tf" '
          def ms: (.startTime | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601) * 1000
                  + (try (.startTime | capture("\\.(?<f>[0-9]+)Z$").f | tonumber) catch 0);
          [ .. | objects | select(has("specs")) | .specs[] | . as $s | (.tests // [])[]
            | (.results // [])[] | select(has("startTime"))
            | { file: $s.file, start: ms, end: (ms + (.duration // 0)) } ] as $r
          | ([ .. | objects | select(has("specs")) | .specs[] | select(.file == $f) | (.tests // [])[] ] | length) as $n
          | ($r | map(select(.file == $f)) | map(.start) | min) as $fs
          | ($r | map(select(.file != $f)) | map(.end) | max) as $oe
          | if $n == 0 then "absent"
            elif $fs == null then "unrun"
            elif $oe != null and $fs < $oe then "early \($oe - $fs)"
            else "last \($n)" end
        ' "$report" 2>/dev/null)" || unmeasured "jq could not read when $tf ran"
        case "$verdict" in
            last\ *) echo "TERMINAL $tf ran last (${verdict#last } tests)" ;;
            absent) unmeasured "the report holds no test from $tf: the live-terminal project did not run, so a full pass never graded it (a --project live or --no-deps run is not the full gate)" ;;
            unrun) unmeasured "no test from $tf has a result with a start time" ;;
            early\ *) unmeasured "$tf started ${verdict#early } ms before another test ended: it must run last, after every other live test" ;;
            *) unmeasured "could not tell when $tf ran ($verdict)" ;;
        esac
    done
fi

if [ "$offenders" -gt 0 ]; then
    echo "check-live-red-set: RED, $offenders offender(s) beyond the declared CUTs"
    summary RED
    exit 1
fi
echo "check-live-red-set: OK, the only failures are the $cut_failed declared CUT(s)"
summary OK
exit 0
