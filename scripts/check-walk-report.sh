#!/usr/bin/env bash
#
# The LESSON WALK's verdict on its own report: every test ran and passed, and at least MIN_TESTS of
# them exist.
#
# WHY THE EXIT CODE ISN'T ENOUGH. `npm run e2e:walk` exits 0 on a skipped test, on a test marked
# `test.fail()` that failed, and on a suite with a whole file deleted. The walk's job would stay green
# with the parity test skipped or gone. This script reads what ran.
#
# WHICH REPORT. CI runs the walk as shards, one leg each, and each leg uploads a blob report. The
# `e2e-walk-verdict` job merges the blobs with `playwright merge-reports` into one JSON report and runs
# this script on it, so it grades the whole walk and never one shard. A shard that was lost, because
# its leg crashed or its blob never reached the merge, leaves its tests out of the merged report. The
# total then falls under MIN_TESTS while MIN_TESTS equals the walk's test count, and that is exit 2.
#
# THE BLOB COUNT. That floor catches a lost shard only while someone keeps MIN_TESTS level with the
# walk. Once the walk outgrows it, a merge that lost its smallest shard can still clear it. So before
# the merge the verdict job runs this script in blobs mode, `--blobs <n> <dir>`: the folder must hold
# exactly report-1.zip to report-<n>.zip, the names Playwright's blob reporter gives shard i of n
# (padded to the digits of n), and nothing else. A missing, extra or misnamed blob is exit 2. This
# check doesn't read MIN_TESTS, so it holds however large the walk grows.
#
# WHY NOT check-live-red-set.sh. That one lets tests titled `CUT - leg <n>` fail, because the live
# suite declares them. The walk declares none, so a walk test with that title failing is a failure
# here. It also takes --min-tests, which this script refuses, so nothing on the CI line can lower the
# floor.
#
# HOW A TEST IS CLASSIFIED, the same as check-live-red-set.sh. Each spec's `tests[]` entry has a
# `status` and an `expectedStatus`:
#   expected   + expectedStatus passed  -> passed
#   expected   + expectedStatus failed  -> marked test.fail()
#   unexpected                          -> failed (its last result says failed, timedOut or interrupted)
#   flaky                               -> flaky
#   skipped    + expectedStatus skipped -> skipped (test.skip or test.fixme)
#   skipped    + anything else, or no result at all -> did not run
# Anything else is a report this script doesn't understand, and that is exit 2.
#
# A STALE REPORT. This script can't tell this run's report from an earlier one. `npm run e2e:walk`
# deletes test-results/walk-report.json before it builds, so a failed build leaves no report to read.
# A run started any other way has to delete it first too. In CI the verdict job starts from a fresh
# checkout, so the only report there is the one its merge step writes.
#
# EXIT CODES:
#   0  at least MIN_TESTS tests, and all of them ran and passed
#   1  at least one didn't; each is printed as `<file>:<line> > <describes> > <title>` with its status
#   2  no verdict could be made, which is a failure and never a pass: a missing path, more than one
#      path or any option; a report that is missing, empty or not JSON; no `jq`; no `suites` array; a
#      non-empty top-level `errors`; fewer than MIN_TESTS tests; a status this script doesn't know
# In blobs mode, 0 when the folder holds exactly the n blobs, and 2 otherwise: a count that isn't a
# whole number above 0, a missing folder, a missing blob, or any other entry in the folder.
#
# The last stdout line is always:
#   WALK REPORT total=<n> passed=<n> failed=<n> skipped=<n> did_not_run=<n> flaky=<n> verdict=<OK|RED|UNMEASURED>
# or, in blobs mode:
#   WALK BLOBS want=<n> found=<n> verdict=<OK|UNMEASURED>
#
# USAGE: check-walk-report.sh <report.json>
#        check-walk-report.sh --blobs <shards> <blob-folder>
#
# scripts/prove-walk-report-bites.sh runs this over hand-made reports in the walk verdict job, before
# the merge.

set -u

# The walk held 27 tests when this floor was set: lesson-entry 6, lesson-hints 4, lesson-variants 11,
# lessons 3 (one per lesson in LESSON_WALKS) and parity 3. A report below it is a partial run or a walk
# file that went missing. Raise it when tests are added, with FLOOR in scripts/prove-walk-report-bites.sh.
# Lowering it is a decision to stop walking something.
MIN_TESTS=27

total=0
passed=0
failed=0
skipped=0
did_not_run=0
flaky=0
offenders=0

summary() {
    echo "WALK REPORT total=$total passed=$passed failed=$failed skipped=$skipped did_not_run=$did_not_run flaky=$flaky verdict=$1"
}

unmeasured() {
    echo "check-walk-report: $1; NO VERDICT (exit 2 is a failure, not a pass)" >&2
    summary UNMEASURED
    exit 2
}

# Blobs mode: count the shard blobs before the merge. Only as the first argument, with exactly a count
# and a folder after it; anywhere else `--blobs` is an unknown option.
if [ "${1:-}" = "--blobs" ]; then
    want="${2:-}"
    found=0
    blobs_unmeasured() {
        echo "check-walk-report: $1; NO VERDICT (exit 2 is a failure, not a pass)" >&2
        echo "WALK BLOBS want=$want found=$found verdict=UNMEASURED"
        exit 2
    }
    [ $# -eq 3 ] || blobs_unmeasured "--blobs takes a shard count and a folder, got $(($# - 1)) argument(s)"
    case "$want" in
        '' | *[!0-9]* | 0*) blobs_unmeasured "the shard count '$want' is not a whole number above 0" ;;
    esac
    dir="$3"
    [ -d "$dir" ] || blobs_unmeasured "the blob folder '$dir' does not exist"
    wanted=()
    for ((i = 1; i <= want; i++)); do
        wanted+=("report-$(printf "%0${#want}d" "$i").zip")
    done
    problems=0
    for name in "${wanted[@]}"; do
        if [ -f "$dir/$name" ]; then
            found=$((found + 1))
        else
            echo "MISSING $name: a shard's blob never reached the merge"
            problems=$((problems + 1))
        fi
    done
    while IFS= read -r entry; do
        [ -n "$entry" ] || continue
        name="${entry##*/}"
        case " ${wanted[*]} " in
            *" $name "*) ;;
            *)
                echo "UNEXPECTED $name: not one of the $want shard blobs"
                problems=$((problems + 1))
                ;;
        esac
    done < <(find "$dir" -mindepth 1 -maxdepth 1)
    [ "$problems" -eq 0 ] || blobs_unmeasured "the blob folder '$dir' does not hold exactly the $want shard blobs"
    echo "check-walk-report: OK, all $want shard blobs are in '$dir'"
    echo "WALK BLOBS want=$want found=$found verdict=OK"
    exit 0
fi

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

[ -n "$report" ] || unmeasured "no report path given (usage: check-walk-report.sh <report.json>)"
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

# One tab-separated row per test: category, name, last result status.
rows="$(jq -r '
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
          ( ($s.file | clean) + ":" + ($s.line | clean) + " > "
            + ((chain + [$s.title]) | map(clean) | join(" > ")) ),
          ( ($rs | last | .status) // "none" | clean ) ]
      | join("\t") ),
    ( (.suites // [])[] as $su | $su | walk_tests(chain + [$su.title]) );
  .suites[] | walk_tests([])
' "$report" 2>/dev/null)" || unmeasured "jq could not walk the report's suites"

while IFS=$'\t' read -r cat name last; do
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
            failed=$((failed + 1))
            echo "RED [marked test.fail(), last result $last] $name"
            offenders=$((offenders + 1))
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
[ "$total" -ge "$MIN_TESTS" ] || unmeasured "the report holds $total tests, below the floor of $MIN_TESTS (a partial run or a missing walk file is not the gate)"

if [ "$offenders" -gt 0 ]; then
    echo "check-walk-report: RED, $offenders of $total tests did not pass"
    summary RED
    exit 1
fi
echo "check-walk-report: OK, all $total tests passed"
summary OK
exit 0
