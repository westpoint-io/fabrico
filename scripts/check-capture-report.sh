#!/usr/bin/env bash
#
# The BOARD CAPTURE SET's verdict on its own report: every test ran, each one passed or is a declared
# expected failure, and at least MIN_TESTS of them exist.
#
# WHY THE EXIT CODE ISN'T ENOUGH. `npm run e2e:capture` exits 0 on a skipped test, on a test marked
# `test.fail()` that failed, and on a run with a whole file left out. The capture job would stay green
# with a grading test skipped, or with a grading test that calls `test.fail()` for a reason nobody
# wrote down. This script reads what ran.
#
# DECLARED EXPECTED FAILURES. The capture set grades the board as it is drawn today, and some of what
# it measures is a known defect that a later change is meant to fix. Such a grading test calls
# `test.fail()`, so Playwright reports it as expected to fail, and it carries the tag of the
# requirement whose fix will make it pass. This script accepts one only when both hold:
#   - its spec file is `board-grade.capture.ts`, the file that grades measurements;
#   - its tags hold exactly one of @STRK-01, @STRK-02 and @STRK-03, and no other @STRK- tag.
# It prints such a test as `DECLARED [<tag>] <name>`. An expected failure in any other file, with no
# STRK tag or with two, is RED. A test marked `test.fail()` that passed is reported by Playwright as
# unexpected, so it is RED as a failure: the defect it declared is gone and the declaration has to go
# with it. The JSON reporter writes tags without their leading `@` on the spec; this script reads them
# from the test and the spec and compares them with the `@` put back.
#
# WHY NOT check-walk-report.sh. That one counts every `test.fail()` as RED, because the lesson walk
# declares none. Like it, this script refuses every option, so nothing on the CI line can lower the
# floor or loosen the rule.
#
# HOW A TEST IS CLASSIFIED, the same as check-walk-report.sh. Each spec's `tests[]` entry has a
# `status` and an `expectedStatus`:
#   expected   + expectedStatus passed  -> passed
#   expected   + expectedStatus failed  -> marked test.fail(): declared, or RED by the rule above
#   unexpected                          -> failed (its last result says failed, timedOut or interrupted)
#   flaky                               -> flaky
#   skipped    + expectedStatus skipped -> skipped (test.skip or test.fixme)
#   skipped    + anything else, or no result at all -> did not run
# Anything else is a report this script doesn't understand, and that is exit 2.
#
# A STALE REPORT. This script can't tell this run's report from an earlier one. `npm run e2e:capture`
# deletes test-results/capture-report.json before it builds, so a failed build leaves no report to
# read. A run started any other way has to delete it first too. In CI the capture job starts from a
# fresh checkout, so the only report there is the one its own run writes.
#
# EXIT CODES:
#   0  at least MIN_TESTS tests, and each one passed or is a declared expected failure
#   1  at least one didn't; each is printed as `<file>:<line> > <describes> > <title>` with its status
#   2  no verdict could be made, which is a failure and never a pass: a missing path, more than one
#      path or any option; a report that is missing, empty or not JSON; no `jq`; no `suites` array; a
#      non-empty top-level `errors`; zero tests; fewer than MIN_TESTS tests; a status this script
#      doesn't know
#
# The last stdout line is always:
#   CAPTURE REPORT total=<n> passed=<n> declared=<n> failed=<n> skipped=<n> did_not_run=<n> flaky=<n> verdict=<OK|RED|UNMEASURED>
#
# USAGE: check-capture-report.sh <report.json>
#
# scripts/prove-capture-report-bites.sh runs this over hand-made reports in the capture job, before
# this script reads the real one.

set -u

# The capture set held 222 tests when this floor was set: one capture test per boot (six boots: pixel
# ratios 1, 1.181793212890625 and 2, each with antialiasing as shipped and on) and one grading test
# per (property, graded cell). Per boot that is outline-sides and glyph-strokes at boot zoom, zoom 1
# and the full-screen boot zoom (3 + 3), fault-ring and rail-vs-outline at the seven zooms where
# machines draw as vectors (7 + 7), and belt-dash and cap-in-cell at all eight zooms (8 + 8): 36 per
# boot, 216 in all, plus the 6 capture tests. It equals the count
# `npx playwright test --config=playwright.capture.config.ts --list` prints. A report below it is a
# partial run or a capture file that went missing. Raise it when tests are added;
# scripts/prove-capture-report-bites.sh reads it from here. Lowering it is a decision to stop
# capturing or grading something.
MIN_TESTS=222

# The one file whose expected failures may be declared, and the tags that may declare one.
GRADE_FILE="board-grade.capture.ts"
DECLARABLE_TAGS=" @STRK-01 @STRK-02 @STRK-03 "

total=0
passed=0
declared=0
failed=0
skipped=0
did_not_run=0
flaky=0
offenders=0

summary() {
    echo "CAPTURE REPORT total=$total passed=$passed declared=$declared failed=$failed skipped=$skipped did_not_run=$did_not_run flaky=$flaky verdict=$1"
}

unmeasured() {
    echo "check-capture-report: $1; NO VERDICT (exit 2 is a failure, not a pass)" >&2
    summary UNMEASURED
    exit 2
}

report=""
while [ $# -gt 0 ]; do
    case "$1" in
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

[ -n "$report" ] || unmeasured "no report path given (usage: check-capture-report.sh <report.json>)"
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

# One row per test, fields split by the ASCII unit separator (0x1f) so an empty tag list stays a
# field: category, name, last result status, spec file, tags (each with its `@`, comma-joined).
US=$'\x1f'
rows="$(jq -r '
  def clean: tostring | gsub("[\t\r\n\u001f]"; " ");
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
          ( ($s.file | clean) + ":" + ($s.line | clean) + " > "
            + ((chain + [$s.title]) | map(clean) | join(" > ")) ),
          ( ($rs | last | .status) // "none" | clean ),
          ( ($s.file // "") | clean ),
          ( ((($t.tags // []) + ($s.tags // []))
             | map(clean | ltrimstr("@") | "@" + .) | unique | join(",")) ) ]
      | join("\u001f") ),
    ( (.suites // [])[] as $su | $su | walk_tests(chain + [$su.title]) );
  .suites[] | walk_tests([])
' "$report" 2>/dev/null)" || unmeasured "jq could not walk the report's suites"

# Classify one expected failure. Sets `declared_tag` when it is declared, and `undeclared` to the
# reason when it is not.
declared_tag=""
undeclared=""
classify_expected_failure() {
    local file="$1" tags="$2" tag strk=()
    declared_tag=""
    undeclared=""
    if [ "${file##*/}" != "$GRADE_FILE" ]; then
        undeclared="an expected failure outside $GRADE_FILE"
        return
    fi
    local IFS=','
    for tag in $tags; do
        case "$tag" in
            @STRK-*) strk+=("$tag") ;;
        esac
    done
    if [ "${#strk[@]}" -eq 0 ]; then
        undeclared="an expected failure with no STRK requirement tag"
    elif [ "${#strk[@]}" -gt 1 ]; then
        undeclared="an expected failure with ${#strk[@]} STRK tags ($(IFS=" "; echo "${strk[*]}")), not exactly one"
    else
        case "$DECLARABLE_TAGS" in
            *" ${strk[0]} "*) declared_tag="${strk[0]}" ;;
            *) undeclared="an expected failure tagged ${strk[0]}, which is not one of${DECLARABLE_TAGS% }" ;;
        esac
    fi
}

while IFS="$US" read -r cat name last file tags; do
    [ -n "$cat" ] || continue
    total=$((total + 1))
    case "$cat" in
        passed)
            passed=$((passed + 1))
            ;;
        failed)
            failed=$((failed + 1))
            echo "RED [failed: $last] $name"
            offenders=$((offenders + 1))
            ;;
        expected_fail)
            classify_expected_failure "$file" "$tags"
            if [ -n "$declared_tag" ]; then
                declared=$((declared + 1))
                echo "DECLARED [$declared_tag] $name"
            else
                failed=$((failed + 1))
                echo "RED [marked test.fail(), last result $last: $undeclared] $name"
                offenders=$((offenders + 1))
            fi
            ;;
        skipped)
            skipped=$((skipped + 1))
            echo "RED [skipped] $name"
            offenders=$((offenders + 1))
            ;;
        did_not_run)
            did_not_run=$((did_not_run + 1))
            echo "RED [did not run] $name"
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
[ "$total" -ge "$MIN_TESTS" ] || unmeasured "the report holds $total tests, below the floor of $MIN_TESTS (a partial run or a missing capture file is not the gate)"

if [ "$offenders" -gt 0 ]; then
    echo "check-capture-report: RED, $offenders of $total tests neither passed nor are declared"
    summary RED
    exit 1
fi
echo "check-capture-report: OK, $total tests: $passed passed, $declared declared expected failure(s)"
summary OK
exit 0
