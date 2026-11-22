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
#      with its status (in a merge, behind the `shard i:` prefix of its shard)
#   2  the verdict COULD NOT BE MADE. This is a FAILURE, never a pass. The classes:
#        - no report path, more than one, or an unknown option
#        - the report is missing, empty or not JSON, or `jq` is not on the PATH
#        - the report has no `suites` array
#        - the report has a non-empty top-level `errors` (a webServer that never came
#          up, a config error, a worker crash outside any test)
#        - zero tests, or fewer than the floor (MIN_TESTS, or --min-tests, or the shard floor)
#        - a full run or a shard (no --min-tests) with no test from a TERMINAL_FILES spec, or
#          one that started such a spec before another test ended
#        - a test status this script does not recognise
#        - --shard <i>/<n> that is not two whole numbers with n at least 2 and i from 1 to n,
#          --shard given twice, or --shard together with --min-tests
#        - a --shard report whose `config.shard` is missing or is not i/n
#        - --merge <n> with n under 2, with a path count other than n, given twice, or
#          together with --shard or --min-tests; and every merge rule below
#        - --shard or --merge without --list, or --list given twice or with an empty path
#        - the list is missing, empty or not JSON, has no `suites` array, carries top-level
#          `errors`, holds zero tests, or holds one key twice
#        - the list's `config.shard` is not i/n with --shard, or not null with --merge or in
#          single-report mode; in single-report mode with a list, a report whose
#          `config.shard` is not null
#        - a report test that is not on the list (the report and the list come from
#          different trees or commands)
#
# THE EXACT LIST (`--list <list.json>`, phase 111, D-03, VERD-01). The floor alone lets tests
# vanish: 341 tests were listed at 3e64668 against MIN_TESTS=290, so about 50 could go missing
# with the verdict still OK. So the report is also compared, test by test, with the suite's own
# `npx playwright test --config=playwright.live.config.ts --list --reporter=json`, made with the
# same --shard as the run (or without one for --merge and a whole run). A test's key on both
# sides is `<spec.id> @ <projectName>`. Then:
#   - a listed test with no row in the report (or in any report of a merge) is exit 1, printed
#     as `RED [not in the report] <file>:<line> > <describes> > <title>`, named from the list,
#     and counted into did_not_run (total counts the report's tests only);
#   - a report test that isn't on the list is exit 2;
#   - the list must be the right kind: `config.shard` i/n with --shard, null with --merge and in
#     single-report mode, where the report must be unsharded too.
# --list is REQUIRED with --shard and --merge, the two modes CI runs. It is optional in
# single-report mode, so a local full pass (the visuals session's closing line) and a partial
# run with --min-tests keep working without one, and compared whenever it is given. MIN_TESTS,
# the shard floor, the CUT rule, the terminal rules and every status rule stay as the second
# guard behind the list: a list made with --grep or one spec matches its own report exactly.
# When a list is given, the line before the summary reads:
#   LIVE LIST ids=<listed tests> reported=<listed tests with a row> missing=<listed tests without>
#
# THE STEP A FAILED TEST DIED IN (VERD-02). Every `RED [failed: ...]` line ends with
# `  step: <chain>`: the innermost failed `test.step` of the last result, followed from the top
# through the one child that carries an error, titles joined with ` > ` (tabs and newlines as
# spaces, every other character kept). Playwright keeps no step that ran inside a hook, so a
# boot that failed in a `beforeEach` leaves none; waitForAppReady (e2e-live/support/oracle.ts)
# then pushes a `fabrico-failed-step` annotation reading `boot <scope>`, printed as
# `step: boot <scope> (in a hook)` (`(from the boot annotation)` when the scope is body). With
# neither, the line reads `no test.step (error at <file>:<line>)` from the last result's error
# location, or `no test.step`.
#
# A STALE REPORT. This script cannot tell a report from this run from one an earlier run
# left behind. `npm run e2e:live` therefore deletes test-results/live-report.json before it
# builds (review 84 WR-12): if the build fails, Playwright never starts, and grading the
# leftover would certify a run that never happened. A run started any other way (the
# webServer-less reuse config) must delete the report first too.
#
# ONE SHARD OF A SPLIT RUN (`--shard <i>/<n>`). CI splits the live suite with Playwright's
# `--shard`, one runner per shard, each with its own dev host. One shard holds a slice of the
# suite, so the full floor of 290 can't apply to it, and `--min-tests` is the wrong tool:
# it lowers the floor AND switches off the terminal checks, which would let a shard run the
# fatal spec first, or not at all, without a word. So the shard mode has its own floor and
# keeps the terminal checks:
#   - the report must carry `config.shard` equal to i/n, so a report from another shard (or
#     an unsharded run) can't stand in for this one;
#   - the floor is MIN_TESTS / (2 * n), rounded down, counted over the tests outside
#     TERMINAL_FILES. Playwright cuts shards at file boundaries, so a shard can sit well
#     under an even share; half of one still catches a shard that ran one spec or crashed
#     early;
#   - the terminal spec must be present and must run last inside the shard. Playwright adds
#     the terminal project back to every shard as the teardown of `live`, so every shard
#     runs it on its own host.
# Start times are only ever compared inside one report: two reports come from two machines
# whose clocks are not one clock.
#
# The last stdout line is always:
#   LIVE RED SET total=<n> passed=<n> failed=<n> skipped=<n> did_not_run=<n> flaky=<n> cut_failed=<n> verdict=<OK|RED|UNMEASURED>
# In shard mode the line before the verdict lines includes:
#   SHARD <i>/<n> live=<tests outside TERMINAL_FILES> terminal=<tests in TERMINAL_FILES>
# and the merge (`--merge`, described where it runs below) prints:
#   LIVE SHARDS n=<n> live=<sum> terminal=<count per shard>
#
# USAGE:
#   check-live-red-set.sh [--min-tests <n>] [--list <whole-list.json>] <report.json>
#   check-live-red-set.sh --shard <i>/<n> --list <shard-list.json> <report.json>
#   check-live-red-set.sh --merge <n> --list <whole-list.json> <report-1.json> ... <report-n.json>
#
# scripts/prove-live-red-set-bites.sh runs this over hand-made reports and lists and shows each
# rule red.

set -u

# The fewest tests a full live run may hold. Measured 301 at phase 90 review pass 2 (297 in
# `live`, 4 in `live-terminal`); a report below 290 is a filtered or partial run (one spec, a
# --grep, a crashed worker, `--project live` alone) being used as the gate, which measures some
# other suite. A deliberate partial run, such as the tracer over one spec, lowers it with
# --min-tests (which no CI line passes). A shard uses MIN_TESTS / (2 * n) instead, see above.
# Until review pass 2 the floor was 170 against a 297-test suite, so a run that
# dropped the whole terminal project still read OK (90-REVIEW.md WR-C-01).
MIN_TESTS=290

# THE TERMINAL SPECS A FULL PASS MUST HOLD, AND RUN LAST (phase 90 review WR-C-01). The fatal sim
# error spec ends the one shared dev host, so it runs in its own `live-terminal` project after every
# other test. A full run or a shard (no --min-tests) whose report holds no test from one of these
# files did not grade FAIL-01 at all, and one that started any of them before another test ended
# stopped the host under the rest of the suite: both are exit 2. A partial run (--min-tests) skips
# this check.
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
min_given=0
full=1
shard=""
shard_i=0
shard_n=0
merge_n=""
list=""
list_given=0
paths=()
while [ $# -gt 0 ]; do
    case "$1" in
        --list)
            [ $# -ge 2 ] || unmeasured "--list needs a path"
            [ "$list_given" = 0 ] || unmeasured "--list given twice ('$list', '$2')"
            list="$2"
            list_given=1
            [ -n "$list" ] || unmeasured "--list names an empty path"
            shift 2
            ;;
        --min-tests)
            [ $# -ge 2 ] || unmeasured "--min-tests needs a number"
            case "$2" in
                '' | *[!0-9]*) unmeasured "--min-tests needs a whole number, got '$2'" ;;
            esac
            min=$((10#$2))
            [ "$min" -ge 1 ] || unmeasured "--min-tests must be at least 1"
            min_given=1
            full=0
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

# THE FLOOR AND THE TERMINAL CHECKS DO NOT SHARE ONE SWITCH IN SHARD MODE. --min-tests drops the
# terminal checks, so a shard graded with it would run the fatal spec first and still read OK.
if [ -n "$shard" ] && [ "$min_given" = 1 ]; then
    unmeasured "--shard and --min-tests cannot be combined: a shard has its own floor and keeps the terminal checks"
fi

# THE LIST IS REQUIRED IN THE TWO MODES CI RUNS. Without it a shard or a merge could lose tests
# down to the floor and still read OK.
if [ -n "$shard" ] && [ "$list_given" = 0 ]; then
    unmeasured "--shard needs --list <shard-list.json>, the exact list made with the same --shard as the run"
fi
if [ -n "$merge_n" ] && [ "$list_given" = 0 ]; then
    unmeasured "--merge needs --list <whole-list.json>, the exact list made without --shard"
fi

if [ -n "$merge_n" ]; then
    [ -z "$shard" ] || unmeasured "--merge and --shard cannot be combined: the merge grades shard i/n itself"
    [ "$min_given" = 0 ] || unmeasured "--merge and --min-tests cannot be combined: the merge floor is MIN_TESTS"
    [ "${#paths[@]}" -eq "$merge_n" ] \
        || unmeasured "--merge $merge_n needs $merge_n report paths, one per shard in shard order, got ${#paths[@]}"
    report=""
else
    [ "${#paths[@]}" -gt 0 ] || unmeasured "no report path given (usage: check-live-red-set.sh [--min-tests <n>] [--list <list.json>] <report.json>, --shard <i>/<n> --list <list.json> <report.json>, or --merge <n> --list <list.json> <report-1.json> ... <report-n.json>)"
    [ "${#paths[@]}" -eq 1 ] || unmeasured "more than one report given ('${paths[0]}', '${paths[1]}')"
    report="${paths[0]}"
fi
command -v jq >/dev/null 2>&1 || unmeasured "jq not found on the PATH"

# The TERMINAL_FILES list as a JSON array, for jq.
terminal_json="$(printf '%s\n' "${TERMINAL_FILES[@]}" | jq -R . | jq -s -c .)" \
    || unmeasured "could not hand TERMINAL_FILES to jq"

# report_rows REPORT: one tab-separated row per test: category, is-CUT, is-terminal (its file is
# in TERMINAL_FILES), identity (spec id and project name), name, last result status, and the step
# text for a failed test (`-` for any other). Every mode classifies through this one function, and
# list_rows reads a list through it too, so a key means the same on both sides.
report_rows() {
    jq -r --arg cut "$CUT_PATTERN" --argjson tf "$terminal_json" '
      def clean: tostring | gsub("[\t\r\n]"; " ");
      # The innermost failed test.step: from the top, follow the one child that has an error.
      def fpath: (map(select(.error))) as $e
        | if ($e | length) == 1 then [$e[0].title] + (($e[0].steps // []) | fpath) else [] end;
      def shortfile: clean | if test("/e2e-live/") then sub("^.*/e2e-live/"; "") else (split("/") | last) end;
      def steptext($t; $r):
        ((($r.steps // []) | fpath) | map(clean)) as $p
        | if ($p | length) > 0 then "step: " + ($p | join(" > "))
          else
            ( [ (($r.annotations // []) + ($t.annotations // []))[]
                | select(.type == "fabrico-failed-step") | (.description // "" | clean) ] | first ) as $a
            | ( $r.errorLocation // $r.error.location // ((($r.errors // [])[0]) // {}).location ) as $loc
            | if $a != null and $a != "" then
                "step: " + $a + (if ($a | test(" body$")) then " (from the boot annotation)" else " (in a hook)" end)
              elif $loc != null and $loc.file != null then
                "no test.step (error at " + ($loc.file | shortfile) + ":" + ($loc.line | clean) + ")"
              else "no test.step" end
          end;
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
              ( if ([$s.file] | inside($tf)) then "1" else "0" end ),
              ( (($s.id // (($s.file | clean) + ":" + ($s.line | clean) + ":" + ($s.title | clean))) | clean)
                + " @ " + (($t.projectName // "") | clean) ),
              ( ($s.file | clean) + ":" + ($s.line | clean) + " > "
                + ((chain + [$s.title]) | map(clean) | join(" > ")) ),
              ( ($rs | last | .status) // "none" | clean ),
              ( if ($rs | length) > 0 and $t.status == "unexpected" then steptext($t; ($rs | last)) else "-" end ) ]
          | join("\t") ),
        ( (.suites // [])[] as $su | $su | walk_tests(chain + [$su.title]) );
      .suites[] | walk_tests([])
    ' "$1" 2>/dev/null
}

# list_rows LIST: one tab-separated row per listed test: key (spec id and project name) and name,
# read through report_rows so the key is built by the same code as a report's.
list_rows() {
    local r
    r="$(report_rows "$1")" || return 1
    awk -F'\t' 'NF { print $4 "\t" $5 }' <<< "$r"
}

# check_json WHAT PATH: refuse a file that is missing, empty, not a JSON object, without `suites`,
# or with top-level errors.
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

# load_list WANT: check the --list file, which must carry config.shard WANT ("i/n" or "none"),
# and set list_keys (key TAB name per listed test) and list_count.
list_keys=""
list_count=0
load_list() {
    local want="$1" got dup
    check_json "list" "$list"
    got="$(shard_of "$list")" || unmeasured "cannot read the list's config.shard"
    if [ "$got" != "$want" ]; then
        if [ "$want" = none ]; then
            unmeasured "list '$list' carries config.shard $got, but this mode needs the whole list (made without --shard)"
        else
            unmeasured "list '$list' carries config.shard $got, but --shard asked for $want: make the list with the same --shard as the run"
        fi
    fi
    list_keys="$(list_rows "$list")" || unmeasured "jq could not walk the list's suites"
    list_count="$(grep -c . <<< "$list_keys")"
    [ "$list_count" -gt 0 ] || unmeasured "list '$list' holds zero tests"
    dup="$(awk -F'\t' 'NF { if (seen[$1]++ == 1) print $2 }' <<< "$list_keys")"
    if [ -n "$dup" ]; then
        while IFS= read -r d; do echo "check-live-red-set: listed twice: $d" >&2; done <<< "$dup"
        unmeasured "list '$list' holds a key twice"
    fi
}

# list_compare KEYS: KEYS holds every reported key, one per line. A report key off the list is
# exit 2; each listed key not in KEYS prints `RED [not in the report] <name>` and counts as an
# offender and as did_not_run. Then the LIVE LIST line.
list_missing=0
list_compare() {
    local extra missing_names reported
    extra="$(awk -F'\t' 'NR == FNR { if (NF) listed[$1] = 1; next } NF && !($1 in listed) { print $1 }' \
        <(printf '%s\n' "$list_keys") <(printf '%s\n' "$1") | sort -u)"
    if [ -n "$extra" ]; then
        while IFS= read -r e; do echo "NOT ON THE LIST $e"; done <<< "$extra"
        unmeasured "$(grep -c . <<< "$extra") reported test(s) are not on the list: the report and the list come from different trees or commands"
    fi
    missing_names="$(awk -F'\t' 'NR == FNR { if (NF) seen[$1] = 1; next } NF && !($1 in seen) { print $2 }' \
        <(printf '%s\n' "$1") <(printf '%s\n' "$list_keys"))"
    if [ -n "$missing_names" ]; then
        while IFS= read -r m; do
            echo "RED [not in the report] $m"
            list_missing=$((list_missing + 1))
        done <<< "$missing_names"
    fi
    offenders=$((offenders + list_missing))
    did_not_run=$((did_not_run + list_missing))
    reported=$((list_count - list_missing))
    echo "LIVE LIST ids=$list_count reported=$reported missing=$list_missing"
}

live_count=0
terminal_count=0

# tally ROWS: count every row into the totals above and print each offender.
tally() {
    local cat is_cut is_term name last step label
    while IFS=$'\t' read -r cat is_cut is_term _ name last step; do
        [ -n "$cat" ] || continue
        total=$((total + 1))
        if [ "$is_term" = 1 ]; then
            terminal_count=$((terminal_count + 1))
        else
            live_count=$((live_count + 1))
        fi
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
                    echo "RED [failed: $last] $name  $step"
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
    done <<< "$1"
}


# ---------------------------------------------------------------------------------
# THE MERGE (`--merge <n> <report-1.json> ... <report-n.json>`): the verdict over a split run,
# read from the raw per-shard reports, never from a `playwright merge-reports` JSON. A merged
# report holds every shard's copy of the terminal spec (Playwright salts the repeated ids, so
# they do not collapse), which pads the total, and its start times come from different
# machines, so the terminal-last check over it would compare clocks that are not one clock.
#
# Each report is graded by this same script with `--shard i/n`, its lines prefixed `shard i:`,
# so the merge carries no second copy of the rules. On top of that, across the shards:
#   - the report at position i must be shard i/n (the --shard check), so a missing, repeated
#     or misplaced shard is refused; a path that does not exist is that shard's exit 2, which
#     is how a missing CI artifact shows up;
#   - every shard holds the same number of terminal tests (each runs the whole fatal spec);
#   - no test outside TERMINAL_FILES appears in two shards (its spec id with its project
#     name), so a repeated shard cannot pad the floor;
#   - the tests outside TERMINAL_FILES summed over the shards, plus one shard's terminal
#     tests, reach MIN_TESTS.
#   - with every shard graded, the union of the reports' keys is compared with the whole --list
#     (the terminal tests repeat in every shard report, which is expected): a listed test in no
#     report is exit 1, named, and a report test off the list is exit 2.
# The inner `--shard` call needs a list too, and the merge has only the whole one, so it hands
# each shard a list written from that shard's own report under `mktemp -d` (results stripped).
# That inner compare can't find anything missing by construction; the union compare above is the
# one that can, and its LIVE LIST line is the only one the merge prints.
# The cross-shard rules and the summed counts read the shards that could be graded (exit 0
# or 1); one that could not is already exit 2. Exit precedence: any shard exit 2 or any broken cross-shard rule is
# 2, otherwise any shard exit 1 is 1, otherwise 0. The CUT count is not fixed: a run with no
# CUT passes, as in the single-report mode.
#
# Before the LIVE RED SET line the merge prints:
#   LIVE SHARDS n=<n> live=<tests outside TERMINAL_FILES, summed> terminal=<count per shard>
# and the LIVE RED SET counts are summed over the shards with each terminal test counted once
# (its worst result across the shards).
if [ -n "$merge_n" ]; then
    self="${BASH_SOURCE[0]}"
    load_list none
    merge_tmp="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/check-live-red-set.XXXXXX")" \
        || unmeasured "mktemp failed for the merge's shard lists"
    trap 'rm -rf -- "$merge_tmp"' EXIT
    all_keys=""
    any_red=0
    any_unmeasured=0
    broken=()
    live_rows=""
    term_rows=""
    ids=""
    term_list=""
    first_term=""
    unequal=0
    i=0
    for p in "${paths[@]}"; do
        i=$((i + 1))
        # This shard's own list, from its own report; a report jq can't read leaves no file, and
        # the inner call then refuses the report before it reads the list.
        jq '.errors = [] | (.. | objects | select(has("tests") and (.tests | type) == "array") | .tests[]) |= (.results = [])' \
            "$p" > "$merge_tmp/list-$i.json" 2>/dev/null || rm -f -- "$merge_tmp/list-$i.json"
        out="$(bash "$self" --shard "$i/$merge_n" --list "$merge_tmp/list-$i.json" "$p" 2>&1)"
        rc=$?
        printf '%s\n' "$out" | grep -v '^LIVE LIST ' | sed "s/^/shard $i: /"
        case "$rc" in
            0) ;;
            1) any_red=1 ;;
            *) any_unmeasured=1
               term_list="$term_list${term_list:+,}-"
               continue ;;
        esac
        rows="$(report_rows "$p")" || {
            broken+=("shard $i graded, but its report could not be read again")
            continue
        }
        all_keys="$all_keys$(awk -F'\t' 'NF { print $4 }' <<< "$rows")"$'\n'
        shard_live="$(awk -F'\t' '$3 == 0' <<< "$rows")"
        shard_term="$(awk -F'\t' '$3 == 1' <<< "$rows")"
        n_term="$(awk -F'\t' '$3 == 1 { n++ } END { print n + 0 }' <<< "$rows")"
        term_list="$term_list${term_list:+,}$n_term"
        if [ -z "$first_term" ]; then
            first_term="$n_term"
        elif [ "$n_term" != "$first_term" ]; then
            unequal=1
        fi
        [ -z "$shard_live" ] || live_rows="$live_rows$shard_live"$'\n'
        [ -z "$shard_term" ] || term_rows="$term_rows$shard_term"$'\n'
        [ -z "$shard_live" ] || ids="$ids$(awk -F'\t' -v s="$i" '{ print s "\t" $4 "\t" $5 }' <<< "$shard_live")"$'\n'
    done

    if [ "$unequal" = 1 ]; then
        broken+=("the terminal spec holds a different number of tests in different shards (terminal=$term_list): every shard runs the whole spec")
    fi

    # A test outside TERMINAL_FILES in two shards: its name and the two shards.
    dups="$(awk -F'\t' '$2 != "" {
        if (!($2 in first)) { first[$2] = $1; name[$2] = $3 }
        else if (first[$2] != $1 && !($2 in told)) { told[$2] = 1; print name[$2] " (shards " first[$2] " and " $1 ")" }
    }' <<< "$ids")"
    if [ -n "$dups" ]; then
        while IFS= read -r d; do
            [ -n "$d" ] && echo "DUPLICATE $d"
        done <<< "$dups"
        broken+=("$(grep -c . <<< "$dups") test(s) outside the terminal spec appear in two shards")
    fi

    # Each terminal test once, with its worst result: the first row that did not pass, if any.
    term_once="$(awk -F'\t' '{
        k = $4
        if (!(k in row)) { row[k] = $0; c[k] = $1; order[++n] = k }
        else if (c[k] == "passed" && $1 != "passed") { row[k] = $0; c[k] = $1 }
    } END { for (j = 1; j <= n; j++) print row[order[j]] }' <<< "$term_rows")"
    tally "$live_rows$term_once" > /dev/null

    # THE UNION COMPARE, only when every shard was graded: with one shard exit 2 its tests would
    # all read as missing, and the verdict is already UNMEASURED.
    if [ "$any_unmeasured" = 0 ] && [ "${#broken[@]}" -eq 0 ]; then
        list_compare "$all_keys"
        [ "$list_missing" -eq 0 ] || any_red=1
    fi

    echo "LIVE SHARDS n=$merge_n live=$live_count terminal=$term_list"
    if [ "$any_unmeasured" = 0 ] && [ "${#broken[@]}" -eq 0 ]; then
        floor_count=$((live_count + ${first_term:-0}))
        [ "$floor_count" -ge "$MIN_TESTS" ] \
            || broken+=("the shards hold $live_count tests outside the terminal spec plus ${first_term:-0} terminal, $floor_count in all, below the floor of $MIN_TESTS (a partial run is not the gate)")
    fi

    if [ "$any_unmeasured" = 1 ] || [ "${#broken[@]}" -gt 0 ]; then
        for b in ${broken[@]+"${broken[@]}"}; do
            echo "check-live-red-set: $b" >&2
        done
        [ "$any_unmeasured" = 0 ] || echo "check-live-red-set: a shard could not be graded (its lines above)" >&2
        unmeasured "the merge over $merge_n shards could not be made"
    fi
    if [ "$any_red" = 1 ]; then
        echo "check-live-red-set: RED, a shard has offender(s) beyond the declared CUTs, or a listed test is in no report (the lines above)"
        summary RED
        exit 1
    fi
    echo "check-live-red-set: OK over $merge_n shards, the only failures are the $cut_failed declared CUT(s)"
    summary OK
    exit 0
fi

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

# A SHARD REPORT MUST BE THE SHARD IT CLAIMS TO BE. Playwright writes `config.shard`
# {current, total} into every JSON report (null when the run was not split), so a report left
# from another shard, or from an unsharded run, is refused here instead of graded as this one.
if [ -n "$shard" ]; then
    got="$(jq -r 'if (.config.shard | type) == "object"
                  then "\(.config.shard.current)/\(.config.shard.total)" else "none" end' \
        "$report" 2>/dev/null)" || unmeasured "cannot read the report's config.shard"
    if [ "$got" = none ]; then
        unmeasured "report '$report' carries no config.shard (an unsharded run), but --shard asked for $shard"
    fi
    [ "$got" = "$shard" ] \
        || unmeasured "report '$report' carries config.shard $got, but --shard asked for $shard"
fi

# THE LIST, when given (always with --shard): the right kind, and in single-report mode the
# report must be a whole run too.
if [ "$list_given" = 1 ]; then
    if [ -n "$shard" ]; then
        load_list "$shard"
    else
        got="$(shard_of "$report")" || unmeasured "cannot read the report's config.shard"
        [ "$got" = none ] \
            || unmeasured "report '$report' carries config.shard $got, but single-report mode with --list reads a whole run (grade a shard with --shard)"
        load_list none
    fi
fi

rows="$(report_rows "$report")" || unmeasured "jq could not walk the report's suites"
tally "$rows"

[ "$total" -gt 0 ] || unmeasured "the report holds zero tests"
if [ "$list_given" = 1 ]; then
    list_compare "$(awk -F'\t' 'NF { print $4 }' <<< "$rows")"
fi
if [ -n "$shard" ]; then
    # THE SHARD FLOOR: MIN_TESTS / (2 * n), over the tests outside TERMINAL_FILES, because every
    # shard carries its own copy of the terminal spec and those copies must not pad the count.
    shard_floor=$((MIN_TESTS / (2 * shard_n)))
    echo "SHARD $shard live=$live_count terminal=$terminal_count"
    [ "$live_count" -ge "$shard_floor" ] \
        || unmeasured "shard $shard holds $live_count tests outside the terminal spec, below the shard floor of $shard_floor (MIN_TESTS / (2 * $shard_n)); a shard that ran one spec or crashed early is not the gate"
else
    [ "$total" -ge "$min" ] || unmeasured "the report holds $total tests, below the floor of $min (a partial run is not the gate)"
fi

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
