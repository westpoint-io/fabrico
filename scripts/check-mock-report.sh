#!/usr/bin/env bash
#
# The MOCK suite's verdict: every test the suite lists ran and passed, read from Playwright's JSON
# report and compared test by test with the suite's exact `--list` (phase 111, plan 111-07, VERD-01,
# decisions D-03 and D-04).
#
# ---------------------------------------------------------------------------------
# WHY THIS EXISTS. Do not delete it as ceremony.
#
# Until phase 111 the mock job's verdict was the exit code of `CI=1 npm run test:e2e`. Playwright
# exits 0 on a skipped test, on a test marked `test.fail()` that failed, and on a suite with a whole
# spec file deleted, so the mock gate stayed green with any of its tests gone. A floor on the count
# alone doesn't fix that: dropping one spec of 714 tests still clears a floor of 700. So this script
# reads what ran and compares it with what the suite lists, by Playwright test id and project. A
# listed test with no result is red and named.
#
# WHY A SIBLING OF check-live-red-set.sh AND NOT A MODE OF IT. The live checker lets tests titled
# `CUT - leg <n>` fail, because the live suite declares them, and it requires the fatal sim spec to
# run last. The mock suite has neither, so a mock test with a CUT title failing is a failure here,
# and there is no terminal spec. The repo keeps one checker per suite (check-walk-report.sh is the
# walk's). It also refuses --min-tests, so no CI line can lower the floor.
#
# HOW A TEST IS CLASSIFIED, the same as check-live-red-set.sh (field names from a real Playwright 1.61
# report). Each spec's `tests[]` entry has a `status` and an `expectedStatus`:
#   no result at all                    -> did not run
#   any result `interrupted`            -> failed, last result interrupted (Playwright files an
#                                          interrupted test as `skipped`, which would hide it)
#   expected   + expectedStatus passed  -> passed
#   expected   + expectedStatus failed  -> marked test.fail()
#   unexpected                          -> failed (its last result says failed or timedOut)
#   flaky                               -> flaky
#   skipped    + expectedStatus skipped -> skipped (test.skip or test.fixme)
#   skipped    + anything else          -> did not run
# Anything but passed is red. Anything else is a report this script doesn't understand: exit 2.
#
# THE LIST. `npx playwright test --list --reporter=json` from frontend/, with the same config and the
# same --shard as the run, prints every test the run would hold, with the same spec ids and project
# names, and no results. A test's key, in the list and the report alike, is
# `<spec.id> @ <projectName>`. Then:
#   - a listed key with no result in the report is exit 1, printed as
#     `RED [not in the report] <file>:<line> > <describes> > <title>` (a deleted spec, a crashed
#     worker, a lost shard);
#   - a report key that isn't on the list is exit 2: the report and the list came from different
#     trees or different commands, and no verdict can be read from the pair;
#   - the list must be the right kind: in shard mode its `config.shard` must equal i/n, and in merge
#     and single modes it must be null (an unsharded list). A list from another shard is exit 2.
#
# THE FLOOR, a second guard behind the exact list: the list must hold at least MIN_TESTS tests (a
# whole list) or MIN_TESTS / (2 * n), rounded down (a shard list). A list made with --grep, one spec
# or a different config would match its own report exactly, so the floor is what refuses it.
# Playwright cuts shards at file boundaries, so a shard can sit well under an even share; half of one
# still catches a shard list that holds one spec.
#
# EXIT CODES:
#   0  every listed test ran and passed, and the report holds nothing else
#   1  at least one didn't; each is printed as `RED [<why>] <file>:<line> > <describes> > <title>`
#      (in a merge, behind the `shard i:` prefix of its report)
#   2  the verdict COULD NOT BE MADE. This is a FAILURE, never a pass. The classes:
#        - no --list, no report path, the wrong number of report paths, or an unknown option
#        - --min-tests in any form (the floor changes only in this script, with its prover)
#        - --shard <i>/<n> that is not two whole numbers with n at least 2 and i from 1 to n, or
#          given twice; --merge <n> with n under 2, given twice, with --shard, or with a path count
#          other than n
#        - `jq` not on the PATH
#        - the list or a report is missing, empty or not JSON, has no `suites` array, or carries a
#          non-empty top-level `errors` (a spec that didn't load, a webServer that never came up)
#        - the list holds zero tests, fewer than the floor, or one key twice
#        - the list's `config.shard` is not i/n in shard mode, or not null in merge or single mode
#        - a report's `config.shard` is not i/n in shard mode, not k/n for the report at position k
#          in merge mode (swapped paths, a missing leg, one leg given twice), or not null in single mode
#        - a report holds zero tests
#        - a report key that isn't on the list, or a key in two reports (or twice in one)
#        - a test status this script doesn't recognise
#
# A STALE REPORT. This script can't tell this run's report from an earlier one. `npm run test:e2e`
# deletes test-results/mock-report.json before Playwright starts, so a run that never starts leaves
# no report. A run started any other way must delete it first too.
#
# OUTPUT. One RED line per offender, then:
#   MOCK LIST ids=<listed tests> reported=<listed tests with a result> missing=<listed tests without>
#   MOCK SHARDS n=<n> tests=<tests summed over the reports>        (merge mode only)
# and as the last stdout line:
#   MOCK REPORT total=<n> passed=<n> failed=<n> skipped=<n> did_not_run=<n> flaky=<n> expected_fail=<n> verdict=<OK|RED|UNMEASURED>
# where total counts the report's tests and did_not_run includes the listed tests missing from it.
#
# USAGE:
#   check-mock-report.sh --shard <i>/<n> --list <shard-list.json> <report.json>
#   check-mock-report.sh --merge <n> --list <whole-list.json> <report-1.json> ... <report-n.json>
#   check-mock-report.sh --list <whole-list.json> <report.json>
#
# scripts/prove-mock-report-bites.sh runs this over hand-made reports and lists and shows each rule
# red.

set -u

# The fewest tests the whole mock list may hold. The unsharded list held 714 tests at 661f411 and
# 718 at 5718862. The
# exact list compare is the real guard; this floor refuses a list made from a partial command. When
# phase 115 deletes mock specs, lower it here together with scripts/prove-mock-report-bites.sh.
MIN_TESTS=700

total=0
passed=0
failed=0
skipped=0
did_not_run=0
flaky=0
expected_fail=0
offenders=0

summary() {
    echo "MOCK REPORT total=$total passed=$passed failed=$failed skipped=$skipped did_not_run=$did_not_run flaky=$flaky expected_fail=$expected_fail verdict=$1"
}

unmeasured() {
    echo "check-mock-report: $1; NO VERDICT (exit 2 is a failure, not a pass)" >&2
    summary UNMEASURED
    exit 2
}

shard=""
shard_i=0
shard_n=0
merge_n=""
list=""
list_given=0
paths=()
while [ $# -gt 0 ]; do
    case "$1" in
        --min-tests | --min-tests=*)
            unmeasured "--min-tests is refused: the floor is MIN_TESTS in this script and changes only with its prover"
            ;;
        --list)
            [ $# -ge 2 ] || unmeasured "--list needs a path"
            [ "$list_given" = 0 ] || unmeasured "--list given twice ('$list', '$2')"
            list="$2"
            list_given=1
            shift 2
            ;;
        --shard)
            [ $# -ge 2 ] || unmeasured "--shard needs <i>/<n>"
            [ -z "$shard" ] || unmeasured "--shard given twice ('$shard', '$2')"
            # Exactly one slash with a whole number on each side: 2/4, never 2, 2/, /4 or 2/4/1.
            case "$2" in
                */*) ;;
                *) unmeasured "--shard needs <i>/<n> as two whole numbers, got '$2'" ;;
            esac
            case "${2%%/*}" in
                '' | *[!0-9]*) unmeasured "--shard needs <i>/<n> as two whole numbers, got '$2'" ;;
            esac
            case "${2#*/}" in
                '' | *[!0-9]*) unmeasured "--shard needs <i>/<n> as two whole numbers, got '$2'" ;;
            esac
            shard_i=$((10#${2%%/*}))
            shard_n=$((10#${2#*/}))
            [ "$shard_n" -ge 2 ] || unmeasured "--shard $2: n must be at least 2"
            [ "$shard_i" -ge 1 ] && [ "$shard_i" -le "$shard_n" ] \
                || unmeasured "--shard $2: i must be from 1 to $shard_n"
            shard="$shard_i/$shard_n"
            shift 2
            ;;
        --merge)
            [ $# -ge 2 ] || unmeasured "--merge needs the number of shards"
            [ -z "$merge_n" ] || unmeasured "--merge given twice ('$merge_n', '$2')"
            case "$2" in
                '' | *[!0-9]*) unmeasured "--merge needs a whole number of shards, got '$2'" ;;
            esac
            merge_n=$((10#$2))
            [ "$merge_n" -ge 2 ] || unmeasured "--merge $2: a split run has at least 2 shards"
            shift 2
            ;;
        -*)
            unmeasured "unknown option '$1'"
            ;;
        *)
            paths+=("$1")
            shift
            ;;
    esac
done

USAGE="usage: check-mock-report.sh --shard <i>/<n> --list <list.json> <report.json>, --merge <n> --list <list.json> <report-1.json> ... <report-n.json>, or --list <list.json> <report.json>"
[ "$list_given" = 1 ] || unmeasured "no --list given: the verdict compares the report with the suite's exact list ($USAGE)"
[ -n "$list" ] || unmeasured "--list names an empty path"
if [ -n "$merge_n" ]; then
    [ -z "$shard" ] || unmeasured "--merge and --shard cannot be combined: the merge reads report k as shard k/n itself"
    [ "${#paths[@]}" -eq "$merge_n" ] \
        || unmeasured "--merge $merge_n needs $merge_n report paths, one per shard in shard order, got ${#paths[@]}"
else
    [ "${#paths[@]}" -gt 0 ] || unmeasured "no report path given ($USAGE)"
    [ "${#paths[@]}" -eq 1 ] || unmeasured "more than one report given ('${paths[0]}', '${paths[1]}'); a split run is read with --merge"
fi
command -v jq >/dev/null 2>&1 || unmeasured "jq not found on the PATH"

# The config.shard each input must carry: "i/n" or "none" (an unsharded run or list).
if [ -n "$shard" ]; then
    want_list_shard="$shard"
else
    want_list_shard="none"
fi

# check_json WHAT PATH: refuse a file that is missing, empty, not a JSON object, without `suites`, or
# with top-level errors.
check_json() {
    local what="$1" f="$2" errs
    [ -e "$f" ] || unmeasured "$what '$f' does not exist"
    [ -s "$f" ] || unmeasured "$what '$f' is empty"
    jq -e 'type == "object"' "$f" >/dev/null 2>&1 || unmeasured "$what '$f' is not a JSON object"
    jq -e '(.suites | type) == "array"' "$f" >/dev/null 2>&1 || unmeasured "$what '$f' has no suites array"
    errs="$(jq -r '(.errors // []) | length' "$f" 2>/dev/null)" || unmeasured "cannot read the errors of $what '$f'"
    if [ "$errs" != "0" ]; then
        jq -r '.errors[] | "  top-level error: " + ((.message // tostring) | split("\n")[0])' "$f" >&2
        unmeasured "$what '$f' carries $errs top-level error(s)"
    fi
}

# shard_of PATH: the file's config.shard as "i/n", or "none".
shard_of() {
    jq -r 'if (.config.shard | type) == "object"
           then "\(.config.shard.current)/\(.config.shard.total)" else "none" end' "$1" 2>/dev/null
}

# rows FILE: one tab-separated row per test: category, key (spec id and project name), name, last
# result status. The list and every report go through this one function, so a key means the same
# on both sides. For the list the category and status are unused (it has no results).
rows() {
    jq -r '
      def clean: tostring | gsub("[\t\r\n]"; " ");
      def walk_tests(chain):
        ( (.specs // [])[] as $s
          | ($s.tests // [])[] as $t
          | ($t.results // []) as $rs
          | ($t.expectedStatus // "passed") as $ex
          | ([ $rs[] | select(.status == "interrupted") ] | length > 0) as $int
          | [ ( if ($rs | length) == 0 then "did_not_run"
                elif $int then "failed"
                elif $t.status == "skipped" then (if $ex == "skipped" then "skipped" else "did_not_run" end)
                elif $t.status == "flaky" then "flaky"
                elif $t.status == "expected" then (if $ex == "passed" then "passed" else "expected_fail" end)
                elif $t.status == "unexpected" then "failed"
                else "unknown:" + ($t.status | clean) end ),
              ( (($s.id // (($s.file | clean) + ":" + ($s.line | clean) + ":" + ($s.title | clean))) | clean)
                + " @ " + (($t.projectName // "") | clean) ),
              ( ($s.file | clean) + ":" + ($s.line | clean) + " > "
                + ((chain + [$s.title]) | map(clean) | join(" > ")) ),
              ( if $int then "interrupted" else (($rs | last | .status) // "none" | clean) end ) ]
          | join("\t") ),
        ( (.suites // [])[] as $su | $su | walk_tests(chain + [$su.title]) );
      .suites[] | walk_tests([])
    ' "$1" 2>/dev/null
}

# tally ROWS PREFIX: count every report row and print each offender behind PREFIX.
tally() {
    local cat name last
    while IFS=$'\t' read -r cat _ name last; do
        [ -n "$cat" ] || continue
        total=$((total + 1))
        case "$cat" in
            passed)
                passed=$((passed + 1))
                ;;
            failed)
                failed=$((failed + 1))
                echo "$2RED [failed: $last] $name"
                offenders=$((offenders + 1))
                ;;
            expected_fail)
                expected_fail=$((expected_fail + 1))
                echo "$2RED [marked test.fail(), last result $last] $name"
                offenders=$((offenders + 1))
                ;;
            # A test that never ran proves nothing, whether it asked to be skipped or not.
            skipped)
                skipped=$((skipped + 1))
                echo "$2RED [skipped] $name"
                offenders=$((offenders + 1))
                ;;
            did_not_run)
                did_not_run=$((did_not_run + 1))
                echo "$2RED [did not run] $name"
                offenders=$((offenders + 1))
                ;;
            flaky)
                flaky=$((flaky + 1))
                echo "$2RED [flaky] $name"
                offenders=$((offenders + 1))
                ;;
            *)
                unmeasured "unrecognised test status '$cat' for $name"
                ;;
        esac
    done <<< "$1"
}

# THE LIST: the right kind, at least the floor, each key once.
check_json "list" "$list"
got="$(shard_of "$list")" || unmeasured "cannot read the list's config.shard"
if [ "$got" != "$want_list_shard" ]; then
    if [ -n "$shard" ]; then
        unmeasured "list '$list' carries config.shard $got, but --shard asked for $shard: make the list with the same --shard as the run"
    else
        unmeasured "list '$list' carries config.shard $got, but this mode needs the whole list (made without --shard)"
    fi
fi
list_rows="$(rows "$list")" || unmeasured "jq could not walk the list's suites"
list_keys="$(awk -F'\t' 'NF { print $2 "\t" $3 }' <<< "$list_rows")"
list_count="$(grep -c . <<< "$list_keys")"
[ "$list_count" -gt 0 ] || unmeasured "list '$list' holds zero tests"
if [ -n "$shard" ]; then
    floor=$((MIN_TESTS / (2 * shard_n)))
    floor_why="the shard floor of $floor (MIN_TESTS / (2 * $shard_n))"
else
    floor="$MIN_TESTS"
    floor_why="the floor of $MIN_TESTS"
fi
[ "$list_count" -ge "$floor" ] \
    || unmeasured "list '$list' holds $list_count tests, below $floor_why; a list made from one spec, a --grep or another config is not the suite"
dup_list="$(awk -F'\t' '{ if (seen[$1]++ == 1) print $2 }' <<< "$list_keys")"
if [ -n "$dup_list" ]; then
    while IFS= read -r d; do echo "check-mock-report: listed twice: $d" >&2; done <<< "$dup_list"
    unmeasured "list '$list' holds a key twice"
fi

# THE REPORTS: each the shard it claims to be, read in shard order.
if [ -n "$merge_n" ]; then
    n_reports="$merge_n"
else
    n_reports=1
fi
all_rows=""
shard_tests=""
k=0
for p in "${paths[@]}"; do
    k=$((k + 1))
    if [ -n "$merge_n" ]; then
        what="report $k of $merge_n"
        want="$k/$merge_n"
        prefix="shard $k: "
    else
        what="report"
        want="$want_list_shard"
        prefix=""
    fi
    check_json "$what" "$p"
    got="$(shard_of "$p")" || unmeasured "cannot read the config.shard of $what '$p'"
    if [ "$got" != "$want" ]; then
        if [ "$want" = none ]; then
            unmeasured "$what '$p' carries config.shard $got, but this mode reads a whole run (made without --shard)"
        else
            unmeasured "$what '$p' carries config.shard $got, but it must be shard $want (reports are read in shard order, one per shard)"
        fi
    fi
    r="$(rows "$p")" || unmeasured "jq could not walk the suites of $what '$p'"
    r="$(awk -F'\t' 'NF' <<< "$r")"
    [ -n "$r" ] || unmeasured "$what '$p' holds zero tests"
    shard_tests="$shard_tests${shard_tests:+ }$(grep -c . <<< "$r")"
    all_rows="$all_rows$(awk -F'\t' -v p="$prefix" '{ print $0 "\t" p }' <<< "$r")"$'\n'
done

# A key twice across the reports (or twice in one): a repeated leg would pad the count.
dups="$(awk -F'\t' 'NF {
    w = ($5 == "" ? "the report" : substr($5, 1, length($5) - 2))
    if (!($2 in first)) first[$2] = w
    else if (!($2 in told)) { told[$2] = 1; print $3 " (" first[$2] " and " w ")" }
}' <<< "$all_rows")"
if [ -n "$dups" ]; then
    while IFS= read -r d; do echo "DUPLICATE $d"; done <<< "$dups"
    unmeasured "$(grep -c . <<< "$dups") test(s) appear twice in the report(s)"
fi

# A report key that isn't on the list: the pair doesn't describe one suite.
extra="$(awk -F'\t' 'NR == FNR { if (NF) listed[$1] = 1; next } NF && !($2 in listed) { print $5 $3 }' \
    <(printf '%s\n' "$list_keys") <(printf '%s' "$all_rows"))"
if [ -n "$extra" ]; then
    while IFS= read -r e; do echo "NOT ON THE LIST $e"; done <<< "$extra"
    unmeasured "$(grep -c . <<< "$extra") reported test(s) are not on the list: the report and the list came from different trees or commands"
fi

# Every report row, behind its shard prefix.
for k in $(seq 1 "$n_reports"); do
    if [ -n "$merge_n" ]; then
        prefix="shard $k: "
    else
        prefix=""
    fi
    tally "$(awk -F'\t' -v p="$prefix" 'NF && $5 == p { print $1 "\t" $2 "\t" $3 "\t" $4 }' <<< "$all_rows")" "$prefix"
done

# THE LIST COMPARE: a listed test with no result is red, named from the list.
missing_names="$(awk -F'\t' 'NR == FNR { if (NF) seen[$2] = 1; next } NF && !($1 in seen) { print $2 }' \
    <(printf '%s' "$all_rows") <(printf '%s\n' "$list_keys"))"
missing=0
if [ -n "$missing_names" ]; then
    while IFS= read -r m; do
        echo "RED [not in the report] $m"
        missing=$((missing + 1))
    done <<< "$missing_names"
fi
did_not_run=$((did_not_run + missing))
offenders=$((offenders + missing))

echo "MOCK LIST ids=$list_count reported=$((list_count - missing)) missing=$missing"
if [ -n "$merge_n" ]; then
    echo "MOCK SHARDS n=$merge_n tests=$total (per shard: $shard_tests)"
fi

if [ "$offenders" -gt 0 ]; then
    echo "check-mock-report: RED, $offenders offender(s)"
    summary RED
    exit 1
fi
echo "check-mock-report: OK, all $list_count listed tests ran and passed"
summary OK
exit 0
