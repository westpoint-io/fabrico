#!/usr/bin/env bash
#
# prove-ci-classify-change.sh - the both-ways proof for scripts/ci-classify-change.sh, the
# script that lets a docs-only change skip the heavy CI jobs (2026-09-30), and decides
# whether the docs site's suite runs.
#
# WHY IT RUNS IN CI, BEFORE THE CLASSIFIER. The classifier is the one script in this
# repository whose verdict can switch other gates OFF. A classifier that has drifted
# towards "true" skips real verification silently. So the `changes` job in
# .github/workflows/ci.yml runs this prover first, in the same job; if it fails, the job
# fails, the classifier never runs, the job's output stays empty, and every heavy job
# runs (the heavy gate skips only on the exact string `true`, the docs gate only on the
# exact string `false`).
#
# EACH CASE EXPECTS A PAIR, docs_only/docs_suite: true/false (root markdown only),
# true/true (root markdown and site/ paths, at least one under site/), or false/true
# (anything else, and every fail-safe path).
#
# WHAT EACH CASE GROUP PROVES.
#   R1-R9  HISTORY SHAPES built in a throwaway repository (a master line with a merged
#          feature branch), so the proof needs no particular history in this checkout.
#          R1/R7 (a commit that changed only root markdown, as a push and as a
#          pull_request) must be true/false; code, non-markdown evidence beside a root
#          markdown file (R3), a PR merge commit, a multi-commit push and a code PR must be
#          false/true; a push whose base is not an ancestor of its head (R8, force push)
#          and an empty range (R9) must be false/true.
#   F1-F9  FAIL-SAFE paths. Each holds R1's docs-only SHAs in every variable it does not
#          vary, so its expected false/true can only come from the one field under test:
#          workflow_dispatch, schedule, an empty event, an empty / all-zero / missing /
#          revision-expression push base, an empty pull_request base. F9 unsets
#          GITHUB_OUTPUT and requires a non-zero exit and an output file with no line.
#   F10    GITHUB_OUTPUT names a directory, which can't be appended to: a non-zero exit,
#          and the directory stays empty, so neither output line exists anywhere.
#   S1-S5  SHAPES built in a second throwaway repository: a rename out of code into a
#          root markdown file (false/true, only visible with --no-renames), a root README
#          change (true/false), a docs/ markdown change (false/true), a markdown change
#          under crates/ (false/true), and a depth-2 shallow clone over a root-README-only
#          range (false/true, the shallow rule alone decides it).
#   S6-S13 THE DOCS SITE, both directions: a change only under site/ (true/true), site/
#          plus root markdown (true/true); site/ plus frontend/src (false/true), site/ plus
#          crates/ (false/true), a rename from frontend/src into site/ (false/true, only
#          visible with --no-renames), docs/site/x.md (false/true), a root file named
#          site.txt (false/true) and a sites/ folder (false/true).
#   I1     IDEMPOTENCY: S6's push classified twice into two fresh output files gives two
#          byte-identical files.
#
# Every case except F9 must exit 0 and leave EXACTLY TWO lines in its own fresh
# GITHUB_OUTPUT file, one `docs_only=` and one `docs_suite=`. All five CLASSIFY_*
# variables are unset before each case and only the ones that case names are set, so
# nothing leaks from the previous case.
#
# NON-VACUITY. The number of executed cases must equal the declared total, at least one
# true and one false docs_only outcome must have been observed, and each of the three
# pairs true/false, true/true and false/true must have come out of a case that expected
# it, or this exits 1.
#
# EXIT CODES (the repository's prover convention):
#   0  every case as expected.
#   1  one or more cases wrong; every wrong case is named in one run.
#   2  the proof could not be made: no git, a throwaway-repository git failure, or a
#      temp-dir failure.

set -u

# Sourced before any change of directory: the helper records where this script lives. Its
# Shape A with no probes (plan 84-04, GATE-03): every write here is under `mktemp -d`, and
# the helper compares this checkout's tracked tree before and after to prove it.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source-path=SCRIPTDIR source=lib/prover-isolation.sh
. "${SCRIPT_DIR}/lib/prover-isolation.sh"

cd "$(dirname "${BASH_SOURCE[0]}")/.." || { echo "prove-ci-classify-change: cannot cd to repo root" >&2; exit 2; }
ROOT="$(pwd)"
CLASSIFIER="$ROOT/scripts/ci-classify-change.sh"

if ! command -v git >/dev/null 2>&1; then
    echo "prove-ci-classify-change: git not found; COULD NOT PROVE" >&2
    exit 2
fi
if [ ! -f "$CLASSIFIER" ]; then
    echo "prove-ci-classify-change: $CLASSIFIER missing; COULD NOT PROVE" >&2
    exit 2
fi

MISSING_SHA=0123456789abcdef0123456789abcdef01234567
ZERO_SHA=0000000000000000000000000000000000000000

TMPROOT="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/prove-ci-classify.XXXXXX")" || {
    echo "prove-ci-classify-change: mktemp failed; COULD NOT PROVE" >&2
    exit 2
}
# shellcheck disable=SC2329  # invoked by the helper's EXIT trap
remove_tmproot() {
    rm -rf -- "$TMPROOT"
}
prover_on_exit remove_tmproot
# shellcheck disable=SC2119  # no probes: this run writes only under mktemp -d
prover_isolate_untracked

DECLARED_TOTAL=33
executed=0
saw_true=0
saw_false=0
failures=()

# record_pair PAIR - remembers each outcome pair a case produced as expected.
seen_pairs=" "
record_pair() {
    case "$seen_pairs" in
        *" $1 "*) ;;
        *) seen_pairs="${seen_pairs}$1 " ;;
    esac
}

# run_case ID EXPECTED DIR [NAME=VALUE ...]
#   EXPECTED is a docs_only/docs_suite pair (true/false, true/true or false/true), or
#   nonzero (the classifier must exit non-zero and write no line, F9).
#   DIR is the working directory the classifier runs in.
run_case() {
    local id="$1" expected="$2" dir="$3"
    shift 3
    local out rc total only_lines suite_lines only suite got
    executed=$((executed + 1))

    local -a envargs=(-u CLASSIFY_EVENT -u CLASSIFY_PR_BASE -u CLASSIFY_PR_HEAD
        -u CLASSIFY_PUSH_BEFORE -u CLASSIFY_PUSH_AFTER -u GITHUB_OUTPUT)
    if [ "$expected" = "nonzero" ]; then
        # GITHUB_OUTPUT stays unset for the classifier; the file next to it shows nothing was
        # written anywhere a later read could pick up.
        out="$(mktemp "$TMPROOT/out.XXXXXX")" || {
            echo "prove-ci-classify-change: mktemp failed; COULD NOT PROVE" >&2
            exit 2
        }
        (cd "$dir" && env "${envargs[@]}" "$@" bash "$CLASSIFIER") >"$out.log" 2>&1
        rc=$?
        if [ "$rc" -eq 0 ]; then
            echo "  $id: WRONG, exit 0 with GITHUB_OUTPUT unset"
            failures+=("$id: exit 0 with GITHUB_OUTPUT unset, expected non-zero")
        elif [ -s "$out" ]; then
            echo "  $id: WRONG, exit $rc but an output line was written"
            failures+=("$id: exit $rc, but the output file holds a line")
        else
            # A case may name GITHUB_OUTPUT itself (F10, a directory). Whatever it names must
            # still hold nothing afterwards.
            local arg target=""
            for arg in "$@"; do
                case "$arg" in GITHUB_OUTPUT=*) target="${arg#GITHUB_OUTPUT=}" ;; esac
            done
            if [ -n "$target" ] && [ -d "$target" ] && [ -n "$(ls -A "$target")" ]; then
                echo "  $id: WRONG, exit $rc but something was written under $target"
                failures+=("$id: exit $rc, but $target is no longer empty")
            elif [ -n "$target" ] && [ -f "$target" ] && [ -s "$target" ]; then
                echo "  $id: WRONG, exit $rc but $target holds a line"
                failures+=("$id: exit $rc, but $target holds a line")
            else
                echo "  $id: exit $rc as required, no line written"
            fi
        fi
        return
    fi

    out="$(mktemp "$TMPROOT/out.XXXXXX")" || {
        echo "prove-ci-classify-change: mktemp failed; COULD NOT PROVE" >&2
        exit 2
    }
    (cd "$dir" && env "${envargs[@]}" GITHUB_OUTPUT="$out" "$@" bash "$CLASSIFIER") >"$out.log" 2>&1
    rc=$?
    total="$(wc -l <"$out" | tr -d ' ')"
    only_lines="$(grep -c '^docs_only=' "$out")"
    suite_lines="$(grep -c '^docs_suite=' "$out")"
    only="$(sed -n 's/^docs_only=//p' "$out")"
    suite="$(sed -n 's/^docs_suite=//p' "$out")"
    got="$only/$suite"

    if [ "$only" = "true" ]; then saw_true=1; fi
    if [ "$only" = "false" ]; then saw_false=1; fi

    if [ "$rc" -ne 0 ]; then
        echo "  $id: WRONG, classifier exit $rc"
        failures+=("$id: classifier exited $rc, expected 0 ($(head -n 1 "$out.log"))")
    elif [ "$total" != "2" ] || [ "$only_lines" != "1" ] || [ "$suite_lines" != "1" ]; then
        echo "  $id: WRONG, GITHUB_OUTPUT holds $total line(s): $only_lines docs_only= and $suite_lines docs_suite="
        failures+=("$id: GITHUB_OUTPUT must hold exactly two lines, one docs_only= and one docs_suite=")
    elif [ "$got" != "$expected" ]; then
        echo "  $id: WRONG, docs_only/docs_suite=$got, expected $expected ($(head -n 1 "$out.log"))"
        failures+=("$id: docs_only/docs_suite=$got, expected $expected")
    else
        record_pair "$got"
        echo "  $id: docs_only/docs_suite=$got as expected"
    fi
}

# The history shapes, built in a throwaway repository: a base commit, a code commit (R2),
# an evidence commit (R3), a feature branch with a code change merged with --no-ff (R4, the
# branch tip is R6's code PR head), then a root-markdown-only commit (R1).
HIST="$TMPROOT/history"
h() {
    git -C "$HIST" -c user.name=prove -c user.email=prove@invalid -c commit.gpgsign=false \
        -c core.hooksPath=/dev/null -c init.defaultBranch=master "$@"
}
mkdir -p "$HIST/crates" "$HIST/frontend" "$HIST/docs" || exit 2
if ! h init -q; then
    echo "prove-ci-classify-change: git init failed; COULD NOT PROVE" >&2
    exit 2
fi
printf 'fn a() {}\n' >"$HIST/crates/a.rs"
printf 'export const g = 1;\n' >"$HIST/frontend/g.ts"
printf '# readme\n' >"$HIST/README.md"
printf '# status\n' >"$HIST/STATUS.md"
printf '# docs\n' >"$HIST/docs/x.md"
hist_commit() {
    h add -A >/dev/null && h commit -q -m "$1" >/dev/null && h rev-parse HEAD
}
if ! H0="$(hist_commit h0-base)"; then echo "prove-ci-classify-change: throwaway commit failed; COULD NOT PROVE" >&2; exit 2; fi
printf 'export const g = 2;\n' >"$HIST/frontend/g.ts"
if ! H1="$(hist_commit h1-code)"; then exit 2; fi
printf 'PNG' >"$HIST/evidence.png"
printf 'measured\n' >"$HIST/evidence.txt"
printf '# status\nmeasured\n' >"$HIST/STATUS.md"
if ! H2="$(hist_commit h2-evidence)"; then exit 2; fi
h checkout -q -b feature || exit 2
printf 'fn a() { let _ = 1; }\n' >"$HIST/crates/a.rs"
if ! FEATURE_HEAD="$(hist_commit h3-feature-code)"; then exit 2; fi
h checkout -q master || exit 2
h merge -q --no-ff -m h4-merge feature >/dev/null || exit 2
if ! H4="$(h rev-parse HEAD)"; then exit 2; fi
printf '# readme\nmore\n' >"$HIST/README.md"
printf '# status\nmeasured\nmore\n' >"$HIST/STATUS.md"
if ! H5="$(hist_commit h5-root-markdown)"; then exit 2; fi
if h cat-file -e "${MISSING_SHA}^{commit}" 2>/dev/null; then
    echo "prove-ci-classify-change: the missing-SHA probe $MISSING_SHA exists here; COULD NOT PROVE" >&2
    exit 2
fi

R1_BEFORE="$H4"          # parent of the root-markdown-only commit
R1_AFTER="$H5"           # README.md and STATUS.md only
R2_BEFORE="$H0"
R2_AFTER="$H1"           # frontend/g.ts
R3_BEFORE="$H1"
R3_AFTER="$H2"           # evidence: png, txt, one root md
R4_BEFORE="$H2"
R4_AFTER="$H4"           # a PR merge commit
R6_HEAD="$FEATURE_HEAD"  # a code PR head

echo "prove-ci-classify-change: history shapes"
run_case R1 true/false "$HIST" CLASSIFY_EVENT=push CLASSIFY_PUSH_BEFORE="$R1_BEFORE" CLASSIFY_PUSH_AFTER="$R1_AFTER"
run_case R2 false/true "$HIST" CLASSIFY_EVENT=push CLASSIFY_PUSH_BEFORE="$R2_BEFORE" CLASSIFY_PUSH_AFTER="$R2_AFTER"
run_case R3 false/true "$HIST" CLASSIFY_EVENT=push CLASSIFY_PUSH_BEFORE="$R3_BEFORE" CLASSIFY_PUSH_AFTER="$R3_AFTER"
run_case R4 false/true "$HIST" CLASSIFY_EVENT=push CLASSIFY_PUSH_BEFORE="$R4_BEFORE" CLASSIFY_PUSH_AFTER="$R4_AFTER"
run_case R5 false/true "$HIST" CLASSIFY_EVENT=push CLASSIFY_PUSH_BEFORE="$R4_BEFORE" CLASSIFY_PUSH_AFTER="$R1_AFTER"
run_case R6 false/true "$HIST" CLASSIFY_EVENT=pull_request CLASSIFY_PR_BASE="$R4_BEFORE" CLASSIFY_PR_HEAD="$R6_HEAD"
run_case R7 true/false "$HIST" CLASSIFY_EVENT=pull_request CLASSIFY_PR_BASE="$R1_BEFORE" CLASSIFY_PR_HEAD="$R1_AFTER"
run_case R8 false/true "$HIST" CLASSIFY_EVENT=push CLASSIFY_PUSH_BEFORE="$R1_AFTER" CLASSIFY_PUSH_AFTER="$R1_BEFORE"
run_case R9 false/true "$HIST" CLASSIFY_EVENT=push CLASSIFY_PUSH_BEFORE="$R1_AFTER" CLASSIFY_PUSH_AFTER="$R1_AFTER"

echo "prove-ci-classify-change: fail-safe paths (R1's docs-only SHAs held everywhere else)"
DOCS_ENV=(CLASSIFY_PR_BASE="$R1_BEFORE" CLASSIFY_PR_HEAD="$R1_AFTER"
    CLASSIFY_PUSH_BEFORE="$R1_BEFORE" CLASSIFY_PUSH_AFTER="$R1_AFTER")
run_case F1 false/true "$HIST" "${DOCS_ENV[@]}" CLASSIFY_EVENT=workflow_dispatch
run_case F2 false/true "$HIST" "${DOCS_ENV[@]}" CLASSIFY_EVENT=schedule
run_case F3 false/true "$HIST" "${DOCS_ENV[@]}" CLASSIFY_EVENT=
run_case F4 false/true "$HIST" CLASSIFY_EVENT=push CLASSIFY_PUSH_BEFORE= CLASSIFY_PUSH_AFTER="$R1_AFTER"
run_case F5 false/true "$HIST" CLASSIFY_EVENT=push CLASSIFY_PUSH_BEFORE="$ZERO_SHA" CLASSIFY_PUSH_AFTER="$R1_AFTER"
run_case F6 false/true "$HIST" CLASSIFY_EVENT=push CLASSIFY_PUSH_BEFORE="$MISSING_SHA" CLASSIFY_PUSH_AFTER="$R1_AFTER"
run_case F7 false/true "$HIST" CLASSIFY_EVENT=push CLASSIFY_PUSH_BEFORE="${R1_AFTER}^" CLASSIFY_PUSH_AFTER="$R1_AFTER"
run_case F8 false/true "$HIST" CLASSIFY_EVENT=pull_request CLASSIFY_PR_BASE= CLASSIFY_PR_HEAD="$R1_AFTER"
run_case F9 nonzero "$HIST" "${DOCS_ENV[@]}" CLASSIFY_EVENT=push
mkdir -p "$TMPROOT/output-is-a-directory" || exit 2
run_case F10 nonzero "$HIST" "${DOCS_ENV[@]}" CLASSIFY_EVENT=push \
    GITHUB_OUTPUT="$TMPROOT/output-is-a-directory"

echo "prove-ci-classify-change: shapes in a second throwaway repository"
REPO="$TMPROOT/repo"
g() {
    git -C "$REPO" -c user.name=prove -c user.email=prove@invalid -c commit.gpgsign=false \
        -c core.hooksPath=/dev/null -c init.defaultBranch=master "$@"
}
mkdir -p "$REPO" || exit 2
if ! g init -q; then
    echo "prove-ci-classify-change: git init failed; COULD NOT PROVE" >&2
    exit 2
fi
mkdir -p "$REPO/crates/x" "$REPO/docs"
printf 'fn a() {}\n' >"$REPO/crates/a.rs"
printf '# readme\n' >"$REPO/README.md"
printf '# docs\n' >"$REPO/docs/x.md"
printf '# crate readme\n' >"$REPO/crates/x/README.md"
commit_all() {
    g add -A >/dev/null && g commit -q -m "$1" >/dev/null && g rev-parse HEAD
}
if ! C0="$(commit_all c0)"; then echo "prove-ci-classify-change: throwaway commit failed; COULD NOT PROVE" >&2; exit 2; fi
g mv crates/a.rs a.md || exit 2
if ! C1="$(commit_all c1-rename-code-into-root-markdown)"; then exit 2; fi
printf '# readme\nmore\n' >"$REPO/README.md"
if ! C2="$(commit_all c2-root-readme)"; then exit 2; fi
printf '# docs\nmore\n' >"$REPO/docs/x.md"
if ! C3="$(commit_all c3-docs-dir)"; then exit 2; fi
printf '# crate readme\nmore\n' >"$REPO/crates/x/README.md"
if ! C4="$(commit_all c4-crate-readme)"; then exit 2; fi
printf '# readme\nmore\nagain\n' >"$REPO/README.md"
if ! C5="$(commit_all c5-root-readme-again)"; then exit 2; fi
mkdir -p "$REPO/site/src/content/docs"
printf -- '---\ntitle: x\n---\n' >"$REPO/site/src/content/docs/x.md"
printf '{ "name": "site" }\n' >"$REPO/site/package.json"
if ! C6="$(commit_all c6-site-only)"; then exit 2; fi
printf -- '---\ntitle: y\n---\n' >"$REPO/site/src/content/docs/y.md"
printf '# readme\nmore\nagain\nsite\n' >"$REPO/README.md"
if ! C7="$(commit_all c7-site-and-root-markdown)"; then exit 2; fi
mkdir -p "$REPO/frontend/src"
printf 'export const g = 1;\n' >"$REPO/frontend/src/g.ts"
printf -- '---\ntitle: y2\n---\n' >"$REPO/site/src/content/docs/y.md"
if ! C8="$(commit_all c8-site-and-frontend)"; then exit 2; fi
printf 'fn b() {}\n' >"$REPO/crates/x/lib.rs"
printf -- '---\ntitle: y3\n---\n' >"$REPO/site/src/content/docs/y.md"
if ! C9="$(commit_all c9-site-and-crates)"; then exit 2; fi
g mv frontend/src/g.ts site/g.ts || exit 2
if ! C10="$(commit_all c10-rename-frontend-into-site)"; then exit 2; fi
mkdir -p "$REPO/docs/site"
printf '# not the site\n' >"$REPO/docs/site/x.md"
if ! C11="$(commit_all c11-docs-site-folder)"; then exit 2; fi
printf 'not the site\n' >"$REPO/site.txt"
if ! C12="$(commit_all c12-root-site-txt)"; then exit 2; fi
mkdir -p "$REPO/sites"
printf '# not the site\n' >"$REPO/sites/x.md"
if ! C13="$(commit_all c13-sites-folder)"; then exit 2; fi

run_case S1 false/true "$REPO" CLASSIFY_EVENT=push CLASSIFY_PUSH_BEFORE="$C0" CLASSIFY_PUSH_AFTER="$C1"
run_case S2 true/false "$REPO" CLASSIFY_EVENT=push CLASSIFY_PUSH_BEFORE="$C1" CLASSIFY_PUSH_AFTER="$C2"
run_case S3 false/true "$REPO" CLASSIFY_EVENT=push CLASSIFY_PUSH_BEFORE="$C2" CLASSIFY_PUSH_AFTER="$C3"
run_case S4 false/true "$REPO" CLASSIFY_EVENT=push CLASSIFY_PUSH_BEFORE="$C3" CLASSIFY_PUSH_AFTER="$C4"
run_case S6 true/true "$REPO" CLASSIFY_EVENT=push CLASSIFY_PUSH_BEFORE="$C5" CLASSIFY_PUSH_AFTER="$C6"
run_case S7 true/true "$REPO" CLASSIFY_EVENT=push CLASSIFY_PUSH_BEFORE="$C6" CLASSIFY_PUSH_AFTER="$C7"
run_case S8 false/true "$REPO" CLASSIFY_EVENT=push CLASSIFY_PUSH_BEFORE="$C7" CLASSIFY_PUSH_AFTER="$C8"
run_case S9 false/true "$REPO" CLASSIFY_EVENT=push CLASSIFY_PUSH_BEFORE="$C8" CLASSIFY_PUSH_AFTER="$C9"
run_case S10 false/true "$REPO" CLASSIFY_EVENT=push CLASSIFY_PUSH_BEFORE="$C9" CLASSIFY_PUSH_AFTER="$C10"
run_case S11 false/true "$REPO" CLASSIFY_EVENT=push CLASSIFY_PUSH_BEFORE="$C10" CLASSIFY_PUSH_AFTER="$C11"
run_case S12 false/true "$REPO" CLASSIFY_EVENT=push CLASSIFY_PUSH_BEFORE="$C11" CLASSIFY_PUSH_AFTER="$C12"
run_case S13 false/true "$REPO" CLASSIFY_EVENT=push CLASSIFY_PUSH_BEFORE="$C12" CLASSIFY_PUSH_AFTER="$C13"

echo "prove-ci-classify-change: the same push classified twice"
executed=$((executed + 1))
I1_A="$TMPROOT/idem-a"
I1_B="$TMPROOT/idem-b"
for f in "$I1_A" "$I1_B"; do
    (cd "$REPO" && env -u CLASSIFY_PR_BASE -u CLASSIFY_PR_HEAD GITHUB_OUTPUT="$f" \
        CLASSIFY_EVENT=push CLASSIFY_PUSH_BEFORE="$C5" CLASSIFY_PUSH_AFTER="$C6" \
        bash "$CLASSIFIER") >/dev/null 2>&1
done
if [ ! -s "$I1_A" ] || [ "$(wc -l <"$I1_A" | tr -d ' ')" != "2" ]; then
    echo "  I1: WRONG, the first run did not write two lines"
    failures+=("I1: the first run did not write exactly two lines")
elif ! cmp -s "$I1_A" "$I1_B"; then
    echo "  I1: WRONG, two runs over the same push wrote different files"
    failures+=("I1: two runs over the same push wrote different output files")
else
    echo "  I1: two runs over the same push wrote the same two lines"
fi

SHALLOW="$TMPROOT/shallow"
if ! git -c core.hooksPath=/dev/null clone -q --depth 2 "file://$REPO" "$SHALLOW" 2>/dev/null; then
    echo "prove-ci-classify-change: shallow clone failed; COULD NOT PROVE" >&2
    exit 2
fi
if [ "$(git -C "$SHALLOW" rev-parse --is-shallow-repository)" != "true" ]; then
    echo "prove-ci-classify-change: the depth-2 clone is not shallow; COULD NOT PROVE" >&2
    exit 2
fi
run_case S5 false/true "$SHALLOW" CLASSIFY_EVENT=push CLASSIFY_PUSH_BEFORE="$C4" CLASSIFY_PUSH_AFTER="$C5"

echo
if [ "$executed" -ne "$DECLARED_TOTAL" ]; then
    failures+=("executed $executed case(s), declared $DECLARED_TOTAL")
fi
if [ "$saw_true" -ne 1 ] || [ "$saw_false" -ne 1 ]; then
    failures+=("both outcomes must be observed (saw true: $saw_true, saw false: $saw_false)")
fi
for pair in true/false true/true false/true; do
    case "$seen_pairs" in
        *" $pair "*) ;;
        *) failures+=("outcome pair $pair was never observed as expected (seen:${seen_pairs% })") ;;
    esac
done

if [ "${#failures[@]}" -gt 0 ]; then
    echo "NOT PROVEN: ${#failures[@]} problem(s):"
    for f in "${failures[@]}"; do
        echo "  - $f"
    done
    exit 1
fi
echo "PROVEN: $executed of $DECLARED_TOTAL cases as expected; all three outcome pairs observed (true/false, true/true, false/true)."
exit 0
