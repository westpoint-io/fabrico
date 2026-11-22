#!/usr/bin/env bash
#
# Golden-corpus AUTHORING-DRIFT measurement (SCHEMA-02, milestone v8.0 Phase 63).
#
# ---------------------------------------------------------------------------------
# WHY THIS EXISTS. It is not a second opinion on an existing gate; it is the first
# observation of the corpus that has ever been taken.
#
# `crates/fabrico-scenario` HAS an authoring-drift guard: `committed_fixtures_match_authoring`
# (crates/fabrico-scenario/tests/bless_fixtures.rs) asserts the committed `.postcard`
# bytes equal FRESHLY-AUTHORED bytes, so an authoring-code or schema change that was
# not re-blessed reddens a normal `cargo test` run.
#
# `crates/fabrico-core/tests/golden/` has NO equivalent, and the things that look like
# one are each asserting something else:
#   - `tests/cert_cross_platform.rs` pulls each fixture in with `include_bytes!` and
#     REPLAYS it. It never re-authors, and it never reads `EditRecord.schema_version`.
#   - `Core::run_log_two_logs` does not read the edit schema version either.
#
# Name the difference plainly, because the whole premise of Phase 63 rests on it:
#
#   REPLAY-EQUALITY   (what is asserted today) the committed bytes still fold to the
#                     committed per-tick hashes.
#   AUTHORING-EQUALITY (what NOTHING asserts today, and what this script measures)
#                     the committed bytes still equal what today's generators produce.
#
# "Appending enum variants 3 and 4 cannot move existing bytes" is an AUTHORING-equality
# claim. A green `cert_cross_platform` run says nothing about it: the corpus would keep
# replaying green at a stale schema version forever, and nothing in the repository would
# ever have told you a byte moved. So this script is the only instrument there is.
# ---------------------------------------------------------------------------------
#
# WHAT IT DOES, in the checkout it is run from (see below):
#   1. refuses to run over an already-dirty corpus tree;
#   2. copies the committed corpus into a `mktemp -d` scratch;
#   3. digests every fixture file of that copy (sha256, LC_ALL=C order);
#   4. regenerates ALL fixtures by running the `#[ignore]`d generators in
#      `crates/fabrico-core/tests/regen.rs` -- the same generators
#      `scripts/regen-golden.sh` drives one at a time, so the two can never disagree
#      about what "authoring" means;
#   5. digests again;
#   6. emits a per-fixture, per-file digest table with a roll-up and the invoking sha;
#   7. measures the board hash manifest the same way, as a second section: it copies
#      examples/boards/hashes.manifest aside, runs its `#[ignore]`d generator
#      (`regenerate_board_manifest` in crates/fabrico-engine/tests/board_manifest.rs), and
#      compares the two files byte for byte, printing `board manifest: IDENTICAL` or
#      `board manifest: MOVED` with a diff.
#
# IT RUNS IN PLACE. Step 4 rewrites every file of the tracked corpus where it stands; the
# generators write to a fixed path, and no override exists (see WHAT WAS DELIBERATELY NOT
# DONE below). In CI the checkout is thrown away after the job. Locally, a fixture that moved
# is left changed in your working tree, so `git diff` shows it, the same as after
# `scripts/regen-golden.sh`. Revert it with `git checkout -- crates/fabrico-core/tests/golden
# examples/boards/hashes.manifest` if you didn't mean to re-bless. Don't run this while another
# process is editing the corpus in the same checkout.
#
# EXIT CODES, inherited in shape from the earlier core-freeze gate:
#   0  every digested file is byte-identical and the board manifest is too: both still
#      reproduce from their own generators.
#   1  at least one corpus file MOVED, or the board manifest did. Every moved fixture and
#      file is named in the table, and a RESULT line names each section that moved.
#   2  the measurement COULD NOT BE MADE. This is a FAILURE, not a pass. An assertion
#      that measures nothing must never present as green -- that is the failure mode
#      this whole family of scripts exists to refuse.
#
# ANTI-VACUOUS GUARDS, each a named, numbered guard with its own exit, never an `||`
# chain. This script exits 2 rather than passing if:
#   - GUARD 1: the corpus tree or the board manifest is already dirty. A measurement taken
#     over an edited file compares the generators against a human's uncommitted edit and
#     reports on neither.
#   - GUARD 2: no fixture folder was found under the corpus directory. The count of
#     folders found (each holding a meta.toml) is the number of generators GUARD 4
#     requires to run, so a corpus that grows needs no edit here.
#   - GUARD 3: `cargo` is absent, or the regeneration run failed to COMPILE. A build
#     that did not run measured nothing, so that is exit 2 and not exit 1.
#   - GUARD 4: the regeneration ran the wrong number of generators. See below.
#   - The board manifest section has the same three refusals of its own: the manifest is
#     missing, its generator failed to compile, or the count of generators that passed
#     differs from EXPECTED_BOARD_GENERATORS. A comparison of the two files that can't be
#     made is exit 2 as well.
#   (GUARD 5, "the restore did not restore", was retired by phase 84 plan 06.)
#
# GUARD 4 IS THE ONE THIS INSTRUMENT WOULD BE WORTHLESS WITHOUT.
# `cargo test ... -- --ignored` EXITS 0 WHEN ZERO TESTS RAN. A renamed generator, a
# typo in the filter, or an `#[ignore]` attribute removed so the generator now runs in
# the normal sweep instead, all produce a green regeneration run in which NOTHING was
# written. Every digest then compares equal and this script reports
# "27 IDENTICAL / 0 MOVED of 27" -- the instrument reading zero for everything, which
# is the exact failure it exists to exclude, produced by the script itself.
#
# So the harness summary line (`test result: ok. N passed; ...`) is PARSED and N is
# required to equal the number of fixture folders found. A mismatch is exit 2 naming both numbers,
# and an unrecognised summary is also exit 2, because a parse that found nothing has
# measured nothing.
#
# WHY THE PASS COUNT AND NOT A FILE-TIMESTAMP CHECK. Asserting that every fixture
# file's mtime advanced is the obvious alternative and it is weaker in the way that
# matters: a generator that runs and writes the SAME bytes still touches the file, so
# mtime cannot distinguish "27 generators ran" from "1 generator ran and 26 files were
# touched by something else". It is also sensitive to filesystem timestamp granularity
# and to a copy resetting the timestamps this script itself would then read.
# The pass count answers the question directly. A later reader will reach for mtime;
# this paragraph is here so they do not.
#
# WHY NOTHING IS RESTORED. A regenerated file that equals the committed one leaves git
# clean, and one that differs is the finding, so it stays in the working tree to be read.
#
# WHY THIS IS A SCRIPT AND NOT A RUST TEST. The generators use `std::fs` under a
# file-scoped clippy escape hatch and are `#[ignore]`d BY DESIGN -- "the corpus is NEVER
# auto-regenerated on a test failure" (regen.rs:16-20, threat T-3-BLESS). Making them
# run in the normal sweep would reverse the decision that rule exists to protect.
#
# WHAT WAS DELIBERATELY NOT DONE: no `GOLDEN_OUT_DIR` environment override was added to
# `regen.rs::golden_dir`. That would be a permanent new capability inside a frozen crate,
# `std::env::var` is on the workspace `disallowed-methods` list in `clippy.toml`, and it
# would only compile by riding the file-scoped `#![allow(clippy::disallowed_methods)]`
# that `regen.rs` was granted for `std::fs`.
#
# Usage:
#   bash scripts/measure-golden-corpus.sh [--label <text> | <text>]
#   CORPUS_LABEL=<text> bash scripts/measure-golden-corpus.sh
#
# Phase 63 recorded one section per quarantine point in a single measurement document
# (internal design notes).

set -euo pipefail

# Resolve repo root so the script works from any cwd.
cd "$(git rev-parse --show-toplevel)"

GOLDEN_DIR="crates/fabrico-core/tests/golden"

# The second measured section. The manifest holds one line per board file, and it comes from
# one generator, so this count is about the generator and not about the number of boards.
BOARD_MANIFEST="examples/boards/hashes.manifest"
EXPECTED_BOARD_GENERATORS=1

# The five files every generator writes (regen.rs `freeze()`).
GOLDEN_FILES=(genesis.snapshot log.postcard edit-log.postcard hashes.txt meta.toml)

# The generator filter. EMPTY means "every #[ignore]d generator in the regen target",
# which is the whole-corpus form of the command scripts/regen-golden.sh runs one
# fixture at a time. Setting this to a name no generator has is how GUARD 4 is proved
# to bite; it is not a supported mode and there is deliberately no flag for it.
REGEN_FILTER=""

usage() {
    cat >&2 <<'USAGE'
usage: scripts/measure-golden-corpus.sh [--label <text> | <text>]

Measures two things against the committed bytes. It regenerates the whole golden corpus
and reports, per fixture and per file, whether the committed bytes still equal what the
generators produce now. Then it regenerates the board hash manifest
(examples/boards/hashes.manifest) and reports whether that file is byte-identical. It runs
in place: a file that moved is left changed in your working tree, so `git diff` shows it.

  --label <text>  a label for the emitted table (also accepts --label=<text>)
  <text>          the same thing, positionally
  --help, -h      this message

  CORPUS_LABEL    env var; used when no label is given on the command line

Precedence: command-line label > $CORPUS_LABEL > "(unlabelled)".

Exit codes:
  0  every digested file is byte-identical, and so is the board manifest
  1  at least one corpus file MOVED, or the board manifest did; the table names every
     moved fixture, and a RESULT line names each section that moved
  2  the measurement could not be made (a dirty corpus tree or board manifest, no
     fixture folder found, no cargo on the PATH, a
     regeneration that failed to compile, a regeneration that ran the wrong number of
     generators, a missing board manifest, a board manifest generator that failed to
     compile or whose passed count differs from EXPECTED_BOARD_GENERATORS, a comparison
     of the two manifests that could not be made). This is a FAILURE, not a pass: an assertion that measures
     nothing must never be green.
USAGE
}

# --- Argument parsing, with the SAME leading-dash guard on BOTH input routes -------
# Taken from the earlier core-freeze gate, for this reason: without it the two
# entry points enforce different rules, so `--label -oops` is rejected with a named
# error while CORPUS_LABEL=-oops sails through. A gate whose two doors have different
# locks is one refactor away from that mattering.
# A function, so the parse's `shift` does not consume the script's own arguments.
LABEL=""
parse_args() {
    while [ $# -gt 0 ]; do
        case "$1" in
            --help | -h)
                usage
                exit 0
                ;;
            --label)
                if [ $# -lt 2 ]; then
                    echo "FAIL: --label requires a text argument, and none followed it." >&2
                    usage
                    exit 2
                fi
                LABEL="$2"
                shift 2
                ;;
            --label=*)
                LABEL="${1#--label=}"
                shift
                ;;
            -*)
                echo "FAIL: unknown option '$1'." >&2
                usage
                exit 2
                ;;
            *)
                if [ -n "$LABEL" ]; then
                    echo "FAIL: more than one label given ('$LABEL' and '$1')." >&2
                    exit 2
                fi
                LABEL="$1"
                shift
                ;;
        esac
    done
}
parse_args "$@"

if [ -z "$LABEL" ]; then
    LABEL="${CORPUS_LABEL:-}"
fi

case "$LABEL" in
    -*)
        echo "FAIL: label '${LABEL}' starts with '-', which reads as an option rather than a label." >&2
        echo "      Pass real text via the positional argument, --label, or CORPUS_LABEL." >&2
        exit 2
        ;;
esac

if [ -z "$LABEL" ]; then
    LABEL="(unlabelled)"
fi

# --- GUARD 1: the corpus tree and the manifest must be clean before they are measured
# A measurement taken over an already-edited file compares the generators against a
# human's uncommitted edit and reports on neither of them.
dirty="$(git status --porcelain -- "$GOLDEN_DIR" "$BOARD_MANIFEST")"
if [ -n "$dirty" ]; then
    echo "FAIL: ${GOLDEN_DIR} or ${BOARD_MANIFEST} is already dirty, so no measurement was made:" >&2
    printf '%s\n' "$dirty" | sed 's/^/  /' >&2
    echo >&2
    echo "This script compares the COMMITTED bytes against freshly-authored ones. Over a" >&2
    echo "dirty tree it would compare the generators against an uncommitted edit and" >&2
    echo "report on neither. Commit or revert the edit, then re-run." >&2
    exit 2
fi

# --- GUARD 2: the walk must find at least one fixture ----------------------------
# Fixtures are discovered by their meta.toml provenance file, so a stray non-fixture
# directory cannot inflate the count. LC_ALL=C keeps the walk order stable across
# locales.
if ! fixture_metas="$(LC_ALL=C find "$GOLDEN_DIR" -mindepth 2 -maxdepth 2 -name 'meta.toml' -print | LC_ALL=C sort)"; then
    echo "FAIL: could not walk ${GOLDEN_DIR} for fixtures, so no measurement was made." >&2
    echo "      This is NOT a report that the corpus moved." >&2
    exit 2
fi

FIXTURES=()
while IFS= read -r meta_path; do
    [ -n "$meta_path" ] || continue
    fixture_dir="${meta_path%/meta.toml}"
    FIXTURES+=("${fixture_dir##*/}")
done <<< "$fixture_metas"

fixture_count="${#FIXTURES[@]}"
if [ "$fixture_count" -eq 0 ]; then
    echo "FAIL: found no fixture folder (one holding a meta.toml) under ${GOLDEN_DIR}, so no" >&2
    echo "      measurement was made. This is NOT a report that the corpus is clean." >&2
    exit 2
fi

# --- GUARD 3a: cargo must be on the PATH -------------------------------------------
if ! command -v cargo >/dev/null 2>&1; then
    echo "FAIL: cargo is not on the PATH, so the corpus could not be regenerated and" >&2
    echo "      nothing was measured." >&2
    exit 2
fi

# The digest tool, in its portable form. CI's Windows leg runs .sh through Git Bash
# (ci.yml defaults.run.shell: bash), so no GNU-only flag is used here.
if command -v sha256sum >/dev/null 2>&1; then
    SHA_CMD=(sha256sum)
elif command -v shasum >/dev/null 2>&1; then
    SHA_CMD=(shasum -a 256)
else
    echo "FAIL: neither sha256sum nor shasum is on the PATH, so nothing could be digested." >&2
    exit 2
fi

# --- Scratch -----------------------------------------------------------------------
# Removed at exit.
SCRATCH=""
# shellcheck disable=SC2329 # run by the EXIT trap below
remove_scratch() {
    if [ -n "$SCRATCH" ]; then
        rm -rf "$SCRATCH"
    fi
    return 0
}
trap remove_scratch EXIT

SCRATCH="$(mktemp -d)"

HEAD_SHA="$(git rev-parse HEAD)"

echo "[measure-golden-corpus] label   : ${LABEL}"
echo "[measure-golden-corpus] head    : ${HEAD_SHA}"
echo "[measure-golden-corpus] corpus  : ${GOLDEN_DIR} (${fixture_count} fixtures x ${#GOLDEN_FILES[@]} files)"
echo "[measure-golden-corpus] scratch : ${SCRATCH}"
echo

echo "[measure-golden-corpus] copying the committed corpus aside ..."
cp -a "$GOLDEN_DIR" "${SCRATCH}/golden.before"

digest_tree() {
    local root="$1"
    local out="$2"
    local fx f d
    : > "$out"
    for fx in "${FIXTURES[@]}"; do
        for f in "${GOLDEN_FILES[@]}"; do
            if [ -f "${root}/${fx}/${f}" ]; then
                d="$("${SHA_CMD[@]}" "${root}/${fx}/${f}" | awk '{print $1}')"
            else
                d="ABSENT"
            fi
            printf '%s %s %s\n' "$fx" "$f" "$d" >> "$out"
        done
    done
}

lookup() {
    awk -v fx="$1" -v fl="$2" '$1 == fx && $2 == fl { print $3 }' "$3"
}

# The "before" digests are taken from the copy aside, which the regeneration cannot reach.
echo "[measure-golden-corpus] digesting the committed bytes ..."
digest_tree "${SCRATCH}/golden.before" "${SCRATCH}/before.txt"

# --- Regenerate ---------------------------------------------------------------------
# --locked for the same reason every other cargo invocation in this phase uses it: an
# accidental dependency bump must not be able to move a reading.
REGEN_CMD=(cargo test -p fabrico-core --locked --test regen -- --ignored)
if [ -n "$REGEN_FILTER" ]; then
    REGEN_CMD+=(--exact "$REGEN_FILTER")
fi

RUN_LOG="${SCRATCH}/regen.log"

echo
echo "[measure-golden-corpus] regenerating the whole corpus with:"
echo "    ${REGEN_CMD[*]}"
echo

regen_rc=0
CARGO_TERM_COLOR=never "${REGEN_CMD[@]}" 2>&1 | tee "$RUN_LOG" || regen_rc="${PIPESTATUS[0]}"

# --- GUARD 3b: a compile failure measured nothing -----------------------------------
# The pattern is narrow on purpose: cargo prints a column-0 `error: test failed, ...`
# line for an ORDINARY test failure, so a bare `^error: ` test would exit 2 on runs
# that compiled and ran perfectly. Only the two unambiguous compile signals match.
COMPILE_FAILURE_RE='^error\[E[0-9]{4}\]:|^error: could not compile'
if grep -qE "$COMPILE_FAILURE_RE" "$RUN_LOG"; then
    echo >&2
    echo "FAIL: the regeneration run did not COMPILE, so no corpus was authored and" >&2
    echo "      nothing was measured." >&2
    echo >&2
    grep -E "$COMPILE_FAILURE_RE" "$RUN_LOG" | head -20 | sed 's/^/    /' >&2
    echo >&2
    echo "A build error is not a clean corpus. cargo exited ${regen_rc}." >&2
    exit 2
fi

# --- GUARD 4: the regeneration must have RUN the generators -------------------------
# See the header. `-- --ignored` exits 0 when zero tests matched, after which every
# digest below compares equal and this script would report a spotless corpus while
# having authored nothing at all.
summary_lines="$(grep -cE '^test result: ' "$RUN_LOG" || true)"
generators_passed="$(
    awk '/^test result: / { for (i = 1; i <= NF; i++) if ($i == "passed;") s += $(i - 1) } END { print s + 0 }' "$RUN_LOG"
)"

if [ "$summary_lines" -eq 0 ]; then
    echo >&2
    echo "FAIL: no harness summary line was recognised in the regeneration output, so the" >&2
    echo "      number of generators that ran is unknown and NOTHING was measured." >&2
    echo >&2
    echo "A parse that found nothing has measured nothing. cargo exited ${regen_rc}." >&2
    echo >&2
    echo "Last 20 lines of the run:" >&2
    tail -20 "$RUN_LOG" | sed 's/^/    /' >&2
    exit 2
fi

if [ "$generators_passed" -ne "$fixture_count" ]; then
    echo >&2
    echo "FAIL: the regeneration run reported ${generators_passed} generator(s) passed, but" >&2
    echo "      ${fixture_count} generators, one per fixture folder, must run for this" >&2
    echo "      measurement to mean anything." >&2
    echo >&2
    echo "A run that authored fewer fixtures than the corpus holds leaves the unwritten" >&2
    echo "ones comparing equal to themselves, which this script would otherwise report as" >&2
    echo "a clean corpus. A renamed generator, a filter that matched nothing, or an" >&2
    echo "#[ignore] attribute removed from a generator all produce exactly that. cargo" >&2
    echo "exited ${regen_rc}." >&2
    exit 2
fi

if [ "$regen_rc" -ne 0 ]; then
    echo >&2
    echo "FAIL: the regeneration run exited ${regen_rc}, so the authored corpus is not" >&2
    echo "      trustworthy and nothing was measured." >&2
    exit 2
fi

echo
echo "[measure-golden-corpus] ${generators_passed} generator(s) ran and passed."
echo "[measure-golden-corpus] human-readable view of the regenerated tree:"
git diff --stat -- "$GOLDEN_DIR" | sed 's/^/    /'
echo

echo "[measure-golden-corpus] digesting the freshly-authored bytes ..."
digest_tree "$GOLDEN_DIR" "${SCRATCH}/after.txt"

# --- Nothing to restore ------------------------------------------------------------
# A fixture that moved stays changed in the working tree, so `git diff` shows it.
echo "[measure-golden-corpus] the regenerated corpus is written in place; a moved file shows in git diff."
echo

# --- The table ----------------------------------------------------------------------
identical=0
moved=0

echo "### Corpus measurement: ${LABEL}"
echo
echo "Taken at \`${HEAD_SHA}\` with \`${REGEN_CMD[*]}\`."
echo
printf '| Fixture | %s | %s | %s | %s | %s | Verdict |\n' "${GOLDEN_FILES[@]}"
echo "|---------|------------------|--------------|-------------------|------------|-----------|---------|"

for fx in "${FIXTURES[@]}"; do
    row="| ${fx} "
    moved_files=""
    for f in "${GOLDEN_FILES[@]}"; do
        b="$(lookup "$fx" "$f" "${SCRATCH}/before.txt")"
        a="$(lookup "$fx" "$f" "${SCRATCH}/after.txt")"
        if [ "$b" = "$a" ]; then
            row="${row}| ${b:0:12} = "
        else
            row="${row}| **${b:0:12} -> ${a:0:12}** "
            if [ -z "$moved_files" ]; then
                moved_files="$f"
            else
                moved_files="${moved_files}, ${f}"
            fi
        fi
    done
    if [ -z "$moved_files" ]; then
        row="${row}| IDENTICAL |"
        identical=$((identical + 1))
    else
        row="${row}| MOVED (${moved_files}) |"
        moved=$((moved + 1))
    fi
    echo "$row"
done

echo
echo "${identical} IDENTICAL / ${moved} MOVED of ${fixture_count}"
echo "label: ${LABEL}"
echo "commit: ${HEAD_SHA}"
echo

# --- The second section: the board manifest ------------------------------------------
# The same question for one more file: do the committed bytes equal what the generator
# writes now? It runs even when the corpus moved, so one run reports both sections. The
# generator writes the manifest in place.
if [ ! -f "$BOARD_MANIFEST" ]; then
    echo "FAIL: ${BOARD_MANIFEST} does not exist, so the board manifest was not measured." >&2
    exit 2
fi

cp "$BOARD_MANIFEST" "${SCRATCH}/hashes.manifest.before"

BOARD_CMD=(cargo test -p fabrico-engine --locked --test board_manifest -- --ignored regenerate_board_manifest)
BOARD_LOG="${SCRATCH}/board-manifest.log"

echo "[measure-golden-corpus] regenerating the board manifest with:"
echo "    ${BOARD_CMD[*]}"
echo

board_rc=0
CARGO_TERM_COLOR=never "${BOARD_CMD[@]}" 2>&1 | tee "$BOARD_LOG" || board_rc="${PIPESTATUS[0]}"

# A compile failure measured nothing, as in GUARD 3b.
if grep -qE "$COMPILE_FAILURE_RE" "$BOARD_LOG"; then
    echo >&2
    echo "FAIL: the board manifest generator did not COMPILE, so the manifest was not" >&2
    echo "      regenerated and nothing was measured." >&2
    echo >&2
    grep -E "$COMPILE_FAILURE_RE" "$BOARD_LOG" | head -20 | sed 's/^/    /' >&2
    echo >&2
    echo "A build error is not a clean manifest. cargo exited ${board_rc}." >&2
    exit 2
fi

# `-- --ignored` exits 0 when nothing ran, as in GUARD 4. The two files would then compare
# equal, and this section would report a clean manifest with nothing written.
board_summary_lines="$(grep -cE '^test result: ' "$BOARD_LOG" || true)"
board_generators_passed="$(
    awk '/^test result: / { for (i = 1; i <= NF; i++) if ($i == "passed;") s += $(i - 1) } END { print s + 0 }' "$BOARD_LOG"
)"

if [ "$board_summary_lines" -eq 0 ]; then
    echo >&2
    echo "FAIL: no harness summary line was recognised in the board manifest run, so the" >&2
    echo "      number of generators that ran is unknown and the manifest was not measured." >&2
    echo "      cargo exited ${board_rc}." >&2
    echo >&2
    echo "Last 20 lines of the run:" >&2
    tail -20 "$BOARD_LOG" | sed 's/^/    /' >&2
    exit 2
fi

if [ "$board_generators_passed" -ne "$EXPECTED_BOARD_GENERATORS" ]; then
    echo >&2
    echo "FAIL: the board manifest run reported ${board_generators_passed} generator(s) passed, but" >&2
    echo "      EXPECTED_BOARD_GENERATORS=${EXPECTED_BOARD_GENERATORS} must run for this comparison to" >&2
    echo "      mean anything. A renamed generator, or an #[ignore] attribute removed from it," >&2
    echo "      leaves the manifest comparing equal to itself. cargo exited ${board_rc}." >&2
    exit 2
fi

if [ "$board_rc" -ne 0 ]; then
    echo >&2
    echo "FAIL: the board manifest run exited ${board_rc}, so the regenerated manifest is not" >&2
    echo "      trustworthy and nothing was measured." >&2
    exit 2
fi

echo
echo "### Board manifest measurement: ${LABEL}"
echo
echo "Taken at \`${HEAD_SHA}\` with \`${BOARD_CMD[*]}\`."
echo

board_cmp_rc=0
cmp -s "${SCRATCH}/hashes.manifest.before" "$BOARD_MANIFEST" || board_cmp_rc=$?

board_moved=0
case "$board_cmp_rc" in
    0)
        echo "board manifest: IDENTICAL"
        ;;
    1)
        board_moved=1
        echo "board manifest: MOVED"
        diff -u "${SCRATCH}/hashes.manifest.before" "$BOARD_MANIFEST" || true
        ;;
    *)
        echo "FAIL: cmp exited ${board_cmp_rc} comparing the two copies of ${BOARD_MANIFEST}, so the" >&2
        echo "      board manifest was not measured." >&2
        exit 2
        ;;
esac
echo

if [ "$moved" -ne 0 ]; then
    echo "RESULT: the corpus has MOVED. ${moved} fixture(s) no longer reproduce from their own generators." >&2
else
    echo "RESULT: the corpus is IDENTICAL. All ${fixture_count} fixtures still reproduce byte-for-byte from their own generators."
fi

if [ "$board_moved" -ne 0 ]; then
    echo "RESULT: the board manifest has MOVED. ${BOARD_MANIFEST} no longer reproduces from its generator." >&2
else
    echo "RESULT: the board manifest is IDENTICAL. ${BOARD_MANIFEST} still reproduces byte-for-byte from its generator."
fi

if [ "$moved" -ne 0 ] || [ "$board_moved" -ne 0 ]; then
    exit 1
fi
exit 0
