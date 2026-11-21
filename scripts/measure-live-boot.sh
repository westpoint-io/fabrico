#!/usr/bin/env bash
#
# Live boot measurement: how much of the live suite's time is app startup, and how much is
# the tests' own work, read from Playwright JSON reports (TIME-01). A local measurement, not a
# CI gate.
#
# ---------------------------------------------------------------------------------
# WHY THIS EXISTS. Every live test boots the real app before it does anything, and a plan that
# speeds up that startup can only be judged against numbers taken the same way before and
# after. CI already keeps one JSON report per live shard, and `waitForAppReady` in
# frontend/e2e-live/support/oracle.ts pushes one `fabrico-boot` annotation per boot into it:
#
#   <workerIndex>:<seq> <bootMs> <navMs> <scope>
#
# with scope one of body, beforeEach, beforeAll, afterEach, afterAll. The boot is also wrapped
# in `test.step('boot')`, but the JSON reporter drops any step started inside a hook, so only
# the annotation reaches the report from every location. This script reads the annotations.
#
# WHERE A BOOT'S TIME SITS. A test's `duration` holds its beforeEach hooks, its body and its
# afterEach hooks, so a boot with scope body, beforeEach or afterEach is inside that test's
# duration and is subtracted from it. beforeAll and afterAll hooks run in their own time slots,
# inside no test's duration, so their boots are startup counted outside the tests and are
# subtracted from nothing. Playwright copies a beforeAll annotation onto every later test of
# its suite, so boots are deduplicated by key inside each report. Never across reports: worker
# indices restart at 0 on every CI runner, so 0:1 on shard 1 and 0:1 on shard 2 are two boots.
#
# WHAT EACH NUMBER IS, AND IS NOT. Every number is wall-clock time on the machine that ran
# the report, so a report from a loaded machine reads slow.
#
#   tests            test entries in the reports (every specs[].tests[] entry, run or not).
#   boots            unique fabrico-boot annotations (by key, per report).
#   body, beforeEach, beforeAll, afterEach, afterAll (REPORT line)
#                    unique boots in that report with that scope, a count.
#   startup_min      sum of bootMs + navMs over all unique boots, in minutes. bootMs is the
#                    wall time of `waitForAppReady` (chrome, first tick, the welcome-card reload
#                    when shown, camera settle). navMs is the page's own navigation-to-load
#                    time for the document the boot found, counted once per document; it
#                    stands in for the spec's `page.goto('/')`, which runs outside the helper.
#   in_tests_min     the part of startup_min from boots with scope body, beforeEach or
#                    afterEach, which sits inside test durations.
#   outside_tests_min  the part from beforeAll and afterAll boots, inside no test's duration.
#   body_min         sum of the last result's duration over tests that carry at least one
#                    fabrico-boot annotation, minus in_tests_min. The tests' own work. It is
#                    NOT a whole run's wall time: worker start, browser launch and the time
#                    between tests are in no number here.
#   no_boot_tests, no_boot_min  tests with no fabrico-boot annotation and the sum of their
#                    durations, in minutes. Kept apart from body_min, never inside it. Such a
#                    test either shares a page an earlier test booted (its startup is 0), or
#                    boots without `waitForAppReady` (for example 12-welcome-card.spec.ts,
#                    which uses `waitForChromeAndTick` to see the first-run card), whose
#                    startup this script cannot see. Tests that did not run are listed too,
#                    with duration 0.
#   startup_per_boot_s  startup_min over boots, in seconds.
#
# Minutes and seconds carry two decimals.
#
# USAGE
#   measure-live-boot.sh <report.json> [<report.json> ...]
#   (the four CI live reports together, or one local report). Needs jq.
#
# OUTPUT, in this order:
#   REPORT <path> tests=<n> boots=<n> body=<n> beforeEach=<n> beforeAll=<n> afterEach=<n> afterAll=<n>
#     (one per report)
#   NO BOOT <file>:<line> > <describe ...> > <title> duration_s=<x>
#     (one per test without a fabrico-boot annotation)
#   LIVE BOOT tests=<n> boots=<n> startup_min=<x> in_tests_min=<x> outside_tests_min=<x>
#     body_min=<x> no_boot_tests=<n> no_boot_min=<x> startup_per_boot_s=<x> verdict=MEASURED
#     (last, one line; wrapped here for reading)
#
# EXIT CODES
#   0  measured.
#   2  verdict=UNMEASURED, a failure and never a pass: no report given; a report missing,
#      empty, not JSON or with no `suites` array; no fabrico-boot annotation in any report
#      (a helper that lost its wrapping must not read as zero startup); a description that is
#      not `<n>:<n> <n> <n> <scope>` with a known scope; or one key with two descriptions.
#      The reason goes to stderr, and the last stdout line is `LIVE BOOT verdict=UNMEASURED`.
# ---------------------------------------------------------------------------------

set -u

unmeasured() {
    echo "measure-live-boot: $1" >&2
    echo "LIVE BOOT verdict=UNMEASURED"
    exit 2
}

[ "$#" -ge 1 ] || unmeasured "no report given (usage: measure-live-boot.sh <report.json> [...])"
command -v jq >/dev/null 2>&1 || unmeasured "jq not found on the PATH"

# report_rows REPORT: tab-separated rows for one report.
#   T <duration ms> <boot annotations on the test> <name>   one per test
#   B <key> <bootMs> <navMs> <scope>                        one per unique boot
#   M <description>                                         one per malformed description
# A key seen with two different descriptions is reported as M.
report_rows() {
    jq -r '
      def clean: tostring | gsub("[\t\r\n]"; " ");
      def walk_tests(chain):
        ( (.specs // [])[] as $s
          | ($s.tests // [])[] as $t
          | (($t.results // []) | last) as $r
          | ((($r // {}) | .annotations) // $t.annotations // [])
              | map(select(.type == "fabrico-boot") | (.description // "" | tostring)) as $boots
          | { dur: ((($r // {}) | .duration) // 0),
              boots: $boots,
              name: (($s.file | clean) + ":" + ($s.line | clean) + " > "
                     + ((chain + [$s.title]) | map(clean) | join(" > "))) } ),
        ( (.suites // [])[] as $su | $su | walk_tests(chain + [$su.title]) );
      [ .suites[] | walk_tests([]) ] as $tests
      | ( $tests[] | "T\t\(.dur)\t\(.boots | length)\t\(.name)" ),
        ( [ $tests[].boots[] ] | unique as $descs
          | ( $descs[] | select(test("^[0-9]+:[0-9]+ [0-9]+ [0-9]+ (body|beforeEach|beforeAll|afterEach|afterAll)$") | not)
              | "M\t\(clean)" ),
            ( [ $descs[] | select(test("^[0-9]+:[0-9]+ [0-9]+ [0-9]+ (body|beforeEach|beforeAll|afterEach|afterAll)$"))
                | split(" ") ]
              | group_by(.[0])[]
              | if length > 1 then "M\tkey \(.[0][0]) has \(length) different descriptions"
                else "B\t\(.[0] | join("\t"))" end ) )
    ' "$1"
}

out_lines=()
all_rows=""
for report in "$@"; do
    [ -f "$report" ] || unmeasured "report not found: $report"
    [ -s "$report" ] || unmeasured "report is empty: $report"
    jq -e 'type == "object" and (.suites | type) == "array"' "$report" >/dev/null 2>&1 \
        || unmeasured "report is not JSON or has no suites array: $report"
    rows="$(report_rows "$report")" || unmeasured "jq could not read the report: $report"
    malformed="$(printf '%s\n' "$rows" | awk -F'\t' '$1 == "M" { print $2 }')"
    [ -z "$malformed" ] || unmeasured "malformed fabrico-boot annotation in $report: $(printf '%s' "$malformed" | head -n 3 | tr '\n' ';')"
    line="$(printf '%s\n' "$rows" | awk -F'\t' -v path="$report" '
        $1 == "T" { tests++ }
        $1 == "B" { boots++; n[$5]++ }
        END { printf "REPORT %s tests=%d boots=%d body=%d beforeEach=%d beforeAll=%d afterEach=%d afterAll=%d\n",
                     path, tests, boots, n["body"], n["beforeEach"], n["beforeAll"], n["afterEach"], n["afterAll"] }')"
    out_lines+=("$line")
    while IFS= read -r nb; do
        [ -n "$nb" ] && out_lines+=("$nb")
    done < <(printf '%s\n' "$rows" | awk -F'\t' '$1 == "T" && $3 == 0 { printf "NO BOOT %s duration_s=%.2f\n", $4, $2 / 1000 }')
    all_rows+="$rows"$'\n'
done

summary="$(printf '%s' "$all_rows" | awk -F'\t' '
    $1 == "T" { tests++; if ($3 > 0) with_ms += $2; else { nb++; nb_ms += $2 } }
    $1 == "B" { boots++; ms = $3 + $4; startup += ms
                if ($5 == "beforeAll" || $5 == "afterAll") outside += ms; else inside += ms }
    END {
        if (boots == 0) { print "NONE"; exit }
        printf "LIVE BOOT tests=%d boots=%d startup_min=%.2f in_tests_min=%.2f outside_tests_min=%.2f body_min=%.2f no_boot_tests=%d no_boot_min=%.2f startup_per_boot_s=%.2f verdict=MEASURED\n",
            tests, boots, startup / 60000, inside / 60000, outside / 60000, (with_ms - inside) / 60000,
            nb, nb_ms / 60000, startup / boots / 1000
    }')"
[ "$summary" != NONE ] || unmeasured "no fabrico-boot annotation in any report; did waitForAppReady lose its boot step?"

printf '%s\n' "${out_lines[@]}"
echo "$summary"
exit 0
