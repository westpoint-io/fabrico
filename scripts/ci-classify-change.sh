#!/usr/bin/env bash
#
# ci-classify-change.sh - decide whether a CI run's change is DOCS-ONLY, so the heavy
# jobs in .github/workflows/ci.yml (determinism, golden-corpus, e2e, e2e-live, unit,
# headless-build, wasm-player) can be skipped (2026-09-30), and whether it needs the
# docs site's suite (the `docs` job).
#
# WHY. The heavy jobs cost thousands of Linux-equivalent CI minutes a day, and many
# pushes change only markdown notes or the docs site, which no heavy job reads.
#
# WHAT DOCS-ONLY MEANS. The changed-path list is NON-EMPTY and every path is either at the
# repository root (no `/` in it) and ends in `.md` (README.md, STATUS.md), or starts with
# `site/` (the docs site). Case-sensitive: `.MD` is not docs, and neither is `Site/`.
# NOT docs: anything under `docs/`, a root file or folder whose name only starts with
# `site` (`site.txt`, `sites/`), any markdown under `crates/` or `frontend/`, any
# non-markdown file at the root (PNG, SVG, JSON evidence), and every other path.
#
# THE TWO OUTPUTS.
#   docs_only   true when every changed path is docs as above. The heavy jobs skip only on
#               the exact string `true`.
#   docs_suite  false only when every changed path is root markdown, which the docs site
#               doesn't read. The docs job skips only on the exact string `false`.
# So the three outcomes are: root markdown only gives true/false (everything skips but the
# always-on jobs); any change made of root markdown and `site/` paths with at least one
# `site/` path gives true/true (the heavy jobs skip, the docs suite runs); anything else,
# every fail-safe path included, gives false/true (everything runs, docs suite too).
#
# THE MEASURED INVARIANT THIS RESTS ON (2026-09-30). No heavy job reads a markdown file
# at the repository root; every hit of a search for such reads was a display string or a
# test title. The one gate that DID read a markdown note (`check-neutrality.sh`) was moved
# out of `unit` into its own always-on `neutrality` job in the same change. The same holds
# for `site/` (2026-11-10): outside the docs suite, its build scripts and the always-on
# residue gate, nothing under crates/, frontend/ or scripts/ reads a file there.
#
# THE RESIDUAL, stated plainly. If a heavy job ever starts reading such a file, or a file
# under `site/`, a docs-only push that edits it skips that job. The next code push re-runs every heavy job
# over the whole tree and surfaces the red then, one push late.
#
# FAIL-SAFE DIRECTION. Every path through this script that is not a positive, complete
# proof of docs-only decides `docs_only=false` and `docs_suite=true`, which runs everything:
# workflow_dispatch and every event other than push and pull_request, an empty,
# malformed, all-zero or missing SHA, a push whose base is not an ancestor of its head
# (force push), a failed merge-base, a shallow checkout, a git error, and an empty diff.
# Renames are listed as a delete plus an add (`--no-renames`), so moving a file OUT of a
# code path to a root markdown file or into `site/` still lists the code path.
#
# CONTRACT.
#   inputs  env CLASSIFY_EVENT, CLASSIFY_PR_BASE, CLASSIFY_PR_HEAD, CLASSIFY_PUSH_BEFORE,
#           CLASSIFY_PUSH_AFTER (any may be empty). git runs in the CURRENT working
#           directory, which in CI is the checkout root; the prover relies on this to run
#           it inside a throwaway repository.
#   output  exactly two lines, `docs_only=<true|false>` then `docs_suite=<true|false>`,
#           appended to the file named by GITHUB_OUTPUT in one write, plus a human-readable
#           reason on stdout. The pair is one of true/false, true/true or false/true.
#   exit    0 when a decision was written; 2 when GITHUB_OUTPUT is unset or not writable.
#           On exit 2 the job goes red and both outputs stay empty. The heavy gate reads
#           empty as "not docs-only" and the docs gate reads empty as "needs the suite",
#           so everything runs.
#
# Event values arrive through env only; the workflow never interpolates them into a
# command line. Each SHA must match ^[0-9a-f]{40}$ before it reaches any git call.
#
# Proved by scripts/prove-ci-classify-change.sh, which CI runs immediately before this.

set -u

if [ -z "${GITHUB_OUTPUT:-}" ]; then
    echo "ci-classify-change: GITHUB_OUTPUT is not set; no decision can be recorded" >&2
    exit 2
fi
if ! { : >>"$GITHUB_OUTPUT"; } 2>/dev/null; then
    echo "ci-classify-change: GITHUB_OUTPUT ($GITHUB_OUTPUT) is not writable" >&2
    exit 2
fi

PATHS_FILE=""
cleanup() {
    if [ -n "$PATHS_FILE" ]; then
        rm -f -- "$PATHS_FILE"
    fi
}
trap cleanup EXIT

# The single place a decision is written. Every call is followed by `exit 0`. Both lines go
# out in one printf, so the output file can't hold one without the other.
decide() {
    local docs_only="$1" docs_suite="$2" reason="$3"
    if ! printf 'docs_only=%s\ndocs_suite=%s\n' "$docs_only" "$docs_suite" >>"$GITHUB_OUTPUT"; then
        echo "ci-classify-change: could not append to GITHUB_OUTPUT" >&2
        exit 2
    fi
    echo "docs_only=${docs_only} docs_suite=${docs_suite}: ${reason}"
}

is_sha() {
    [[ "$1" =~ ^[0-9a-f]{40}$ ]]
}

is_commit() {
    git cat-file -e "$1^{commit}" 2>/dev/null
}

# A markdown file at the repository root.
is_root_md() {
    local path="$1"
    if [[ "$path" != */* && "$path" == *.md ]]; then
        return 0
    fi
    return 1
}

# Root markdown, or anything under the docs site's folder.
is_docs_path() {
    local path="$1"
    if is_root_md "$path" || [[ "$path" == site/* ]]; then
        return 0
    fi
    return 1
}

EVENT="${CLASSIFY_EVENT:-}"

# (1) A shallow checkout cannot be trusted to hold both ends of the diff.
shallow="$(git rev-parse --is-shallow-repository 2>/dev/null)"
if [ "$shallow" != "false" ]; then
    decide false true "shallow checkout or git error (is-shallow-repository printed '${shallow}')"
    exit 0
fi

# (2) Pick the two ends from the event. Anything else runs everything.
case "$EVENT" in
    pull_request)
        FROM="${CLASSIFY_PR_BASE:-}"
        TO="${CLASSIFY_PR_HEAD:-}"
        ;;
    push)
        FROM="${CLASSIFY_PUSH_BEFORE:-}"
        TO="${CLASSIFY_PUSH_AFTER:-}"
        ;;
    *)
        decide false true "event '${EVENT}' always runs every job"
        exit 0
        ;;
esac

# (3) Shape, then existence.
if ! is_sha "$FROM" || ! is_sha "$TO"; then
    decide false true "a SHA is empty or not 40 lowercase hex characters (from='${FROM}' to='${TO}')"
    exit 0
fi
if [ "$FROM" = "0000000000000000000000000000000000000000" ]; then
    decide false true "no previous commit (base is all zeros)"
    exit 0
fi
if ! is_commit "$FROM" || ! is_commit "$TO"; then
    decide false true "a SHA is not a commit in this checkout (from=${FROM} to=${TO})"
    exit 0
fi

# (4) The diff base.
if [ "$EVENT" = "push" ]; then
    if ! git merge-base --is-ancestor "$FROM" "$TO" 2>/dev/null; then
        decide false true "force push or rewritten history (${FROM} is not an ancestor of ${TO})"
        exit 0
    fi
    DIFF_FROM="$FROM"
else
    if ! DIFF_FROM="$(git merge-base "$FROM" "$TO" 2>/dev/null)" || ! is_sha "$DIFF_FROM"; then
        decide false true "no merge base between ${FROM} and ${TO}"
        exit 0
    fi
fi

# (5) The changed paths, renames split into delete plus add.
if ! PATHS_FILE="$(mktemp "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/ci-classify.XXXXXX")"; then
    PATHS_FILE=""
    decide false true "could not create a temp file"
    exit 0
fi
if ! git diff --no-renames --name-only -z "$DIFF_FROM" "$TO" >"$PATHS_FILE" 2>/dev/null; then
    decide false true "git diff failed for ${DIFF_FROM}..${TO}"
    exit 0
fi

# (6) and (7) Classify every path; the first non-docs path decides false/true, and the
# first path that isn't root markdown means the docs suite has to run.
count=0
first_non_docs=""
first_non_root_md=""
listed=()
while IFS= read -r -d '' path; do
    count=$((count + 1))
    if [ "${#listed[@]}" -lt 20 ]; then
        listed+=("$path")
    fi
    if [ -z "$first_non_docs" ] && ! is_docs_path "$path"; then
        first_non_docs="$path"
    fi
    if [ -z "$first_non_root_md" ] && ! is_root_md "$path"; then
        first_non_root_md="$path"
    fi
done <"$PATHS_FILE"

print_paths() {
    echo "changed paths: ${count}"
    local p
    for p in "${listed[@]+"${listed[@]}"}"; do
        echo "  ${p}"
    done
    if [ "$count" -gt 20 ]; then
        echo "  ... and $((count - 20)) more"
    fi
}

if [ "$count" -eq 0 ]; then
    decide false true "nothing to classify (empty diff ${DIFF_FROM}..${TO})"
    print_paths
    exit 0
fi
if [ -n "$first_non_docs" ]; then
    decide false true "'${first_non_docs}' is neither a markdown file at the repository root nor under site/"
    print_paths
    exit 0
fi
if [ -z "$first_non_root_md" ]; then
    decide true false "every changed path is markdown at the repository root"
    print_paths
    exit 0
fi

decide true true "every changed path is root markdown or under site/ ('${first_non_root_md}' is under site/)"
print_paths
exit 0
