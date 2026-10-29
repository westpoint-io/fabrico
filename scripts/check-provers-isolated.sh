#!/usr/bin/env bash
#
# THE PROVER-ISOLATION LINT (phase 84, plan 84-07, GATE-03, decision D-08).
#
# ---------------------------------------------------------------------------------
# WHAT IT ASSERTS. That every prover in scripts/ is kept off the shared working tree by
# scripts/lib/prover-isolation.sh, and does nothing that would take it back off.
#
# WHY. Concurrent processes may share this working tree, its index and its target/. Until
# phase 84 several provers edited a tracked file, ran a gate and put the file back with a
# git restore verb. Any edit another process saved to that file while the prover ran
# was silently discarded, and a staged deletion was left in the shared index for the
# other process's next commit to carry. Plans 84-04 and 84-06 moved every prover onto
# one of the helper's two shapes. Nothing stopped the next prover from bringing the old
# shape back, so this lint runs on every push.
#
# THE FIVE RULES, each read on non-comment lines only (a line whose first non-blank
# character is `#`; a trailing comment on a code line counts as code):
#   R1  no git verb that writes the work tree, the index or the stash list from git's
#       copy, with or without options between `git` and the verb. In every shape:
#       `checkout`, `checkout-index`, `restore`, `stash`, `clean`, `switch`, `read-tree`,
#       `update-index` and `apply`. Outside Shape B: `reset`, `rm`, `mv`, `add` and
#       `commit` too (the declared-moves prover legitimately runs `git rm` and
#       `git reset -q --` inside its private worktree). Each of these, run on the shared
#       tree, discards or stages another process's work; `git reset --hard`, `git rm`
#       and `git clean -fdx` passed this lint until review 84 CR-02. Even in Shape B they
#       are allowed only BELOW the first `prover_run_in_worktree` line: the outer run
#       executes every line above it in the shared checkout, before the helper takes its
#       snapshot, so neither half of GATE-03 would see the damage (review 84 iteration 2
#       WR-01). A heredoc's text is read as code too, so a usage text above the shape
#       names the verb as `git-rm`, the way its manual page does.
#   R2  the file sources lib/prover-isolation.sh, and enters exactly one shape: one line
#       that starts AT COLUMN 0 with `prover_isolate_untracked` (Shape A) or
#       `prover_run_in_worktree` (Shape B), and no indented line calls either. No shape
#       means no comparison and no cleanup; two means a prover whose isolation depends on
#       which branch ran. An indented shape line sits in a function, an `if` or a loop, so
#       the outer run can execute lines below it, or never enter it, while the "above the
#       shape line" rules of R1 and R4 read only line order (review 84 iteration 3 WR-02).
#       A shape line at column 0 that is still inside an unindented function or `if` is
#       beyond a line scan; the helper's runtime checks close it (see below).
#   R3  no `trap ... EXIT` of its own. The helper owns the only EXIT trap; a second one
#       replaces it and silently switches off the probe removal, the worktree removal and
#       the before-and-after comparison. Cleanups go through `prover_on_exit`.
#   R4  an in-place sed (`sed -i`, `sed --in-place`, combined flags such as `-Ei`),
#       `prover_keep_bytes` or `prover_put_back` only in a Shape B prover, and only below
#       its first `prover_run_in_worktree` line. In Shape A, or above that line, those
#       edits land on the shared tree; below it in Shape B they land in a private worktree.
#   R5  no `ln` of a whole directory named `node_modules` (review 92 WR-A-05). Vite keeps
#       its dependency cache inside `node_modules/.vite`; through a link to the caller's
#       whole directory, a Vite started in a private worktree deleted and rewrote the shared
#       cache, an ignored path the helper's tracked comparison cannot see. A prover that
#       needs the packages calls `prover_link_node_modules`, which links entry by entry and
#       leaves the caches private.
#
# THIS IS THE STATIC HALF. The helper's runtime checks are the other half: its comparison
# catches a write to a tracked file by any route this lint cannot read (a variable holding
# the verb, a write through cp or a redirect); it refuses a shape entered from a function
# or a subshell, or after HEAD, the tracked tree or the index moved since it was sourced;
# and it turns an exit 0 that never entered a shape into 2. Each of those is exit 2 after
# the fact: a write above the shape has already landed on the shared tree, which is why
# this lint refuses what it can read before anything runs. Neither replaces the other.
#
# THE FILE SET is every `prove-*.sh` in the provers directory plus
# `measure-golden-corpus.sh` and `determinism-gate-negative-test.sh`, the two provers whose
# names predate the `prove-` prefix. The directory is scripts/ unless PROVERS_DIR names
# another; the override exists only so scripts/prove-provers-isolated-bites.sh can point
# this lint at an empty or thin directory and see it refuse.
#
# ANTI-VACUOUS GUARDS. A lint that reads nothing reports green.
#   - fewer than MIN_PROVERS files found is exit 2 (13 at plan 84-07);
#   - the helper missing from <dir>/lib/ is exit 2: every prover sources it from there;
#   - either of the two named provers missing, or any file unreadable, is exit 2.
#
# NO EXEMPTION BY NAME. A prover that cannot meet a rule is rewritten, not listed here.
#
# PORTABILITY. POSIX awk and ERE only (no `\b`, no gawk functions, no `grep -P`), so it
# runs the same with BSD tools on macOS, Git Bash on Windows and GNU tools on Linux.
#
# OUTPUT. One line per offence, `<file>: R<n> <what>`, then `OK: <n> provers, each
# isolated` or a FAIL summary.
#
# EXIT CODES:
#   0  every prover read is isolated
#   1  at least one is not; every offending file is named with every rule it breaks
#   2  the assertion could not be made (see the guards). This is a FAILURE, not a pass.

set -euo pipefail

case "${1:-}" in
    '') ;;
    -h | --help)
        sed -n '2,/^set -euo pipefail$/p' "$0" | sed -e '$d' -e 's/^# \{0,1\}//'
        exit 0
        ;;
    *)
        echo "check-provers-isolated: unknown argument '$1' (it takes none); NOT MEASURED" >&2
        exit 2
        ;;
esac

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
    echo "check-provers-isolated: not inside a git checkout; NOT MEASURED" >&2
    exit 2
}
cd "$ROOT"

MIN_PROVERS=12
DIR="${PROVERS_DIR:-scripts}"
DIR="${DIR%/}"
HELPER="${DIR}/lib/prover-isolation.sh"
NAMED=(measure-golden-corpus.sh determinism-gate-negative-test.sh)

unmeasured=()
if [ ! -d "$DIR" ]; then
    unmeasured+=("the provers directory '${DIR}' does not exist")
fi
if [ ! -f "$HELPER" ]; then
    unmeasured+=("the helper ${HELPER} is missing")
fi

FILES=()
for f in "$DIR"/prove-*.sh; do
    [ -e "$f" ] || continue
    FILES+=("$f")
done
for n in "${NAMED[@]}"; do
    if [ -e "${DIR}/${n}" ]; then
        FILES+=("${DIR}/${n}")
    else
        unmeasured+=("${DIR}/${n} is missing (a prover this lint is required to read)")
    fi
done
for f in ${FILES[@]+"${FILES[@]}"}; do
    if [ ! -f "$f" ] || [ ! -r "$f" ]; then
        unmeasured+=("${f} cannot be read")
    fi
done
if [ "${#FILES[@]}" -lt "$MIN_PROVERS" ]; then
    unmeasured+=("found ${#FILES[@]} provers in ${DIR}, below the floor of ${MIN_PROVERS}")
fi
if [ "${#unmeasured[@]}" -gt 0 ]; then
    for u in "${unmeasured[@]}"; do
        echo "check-provers-isolated: ${u}" >&2
    done
    echo "check-provers-isolated: NOT MEASURED (exit 2), so no prover was certified isolated." >&2
    exit 2
fi

# The patterns. Bracket expressions rather than backslash escapes, because awk -v
# processes backslashes in the value.
#   R1: `git`, any options (each with an optional non-option argument), then the verb.
#   RE_R1 offends in every shape; RE_R1B offends only when the file is not Shape B (the
#   same test as R4). A `.` after the verb ends the match, so a config key passed with
#   `-c` (`-c commit.gpgsign=false`) is not read as the verb.
RE_R1='(^|[^[:alnum:]_./-])git([[:space:]]+-[^[:space:]]+([[:space:]]+[^-[:space:]][^[:space:]]*)?)*[[:space:]]+(checkout|checkout-index|restore|stash|clean|switch|read-tree|update-index|apply)([^[:alnum:]_.-]|$)'
RE_R1B='(^|[^[:alnum:]_./-])git([[:space:]]+-[^[:space:]]+([[:space:]]+[^-[:space:]][^[:space:]]*)?)*[[:space:]]+(reset|rm|mv|add|commit)([^[:alnum:]_.-]|$)'
RE_SOURCE='^[[:space:]]*([.]|source)[[:space:]]+.*lib/prover-isolation[.]sh'
#   R2: a shape line starts at column 0, so it is a top-level statement in any indented
#   prover. An indented one (inside a function, an `if` or a loop) counts in RE_SHAPE_IN,
#   never as the shape (review 84 iteration 3 WR-02).
RE_SHAPE_A='^prover_isolate_untracked([[:space:];]|$)'
RE_SHAPE_B='^prover_run_in_worktree([[:space:];]|$)'
RE_SHAPE_IN='^[[:space:]]+(prover_isolate_untracked|prover_run_in_worktree)([[:space:];]|$)'
#   R3: the trap builtin with EXIT (or its number, 0) among its arguments.
RE_TRAP='(^|[^[:alnum:]_-])trap[[:space:]](.*[^[:alnum:]_])?(EXIT|SIGEXIT|0)([^[:alnum:]_]|$)'
#   R4: sed, then option tokens up to a pipe or separator, one of which is in-place.
RE_SED_I='(^|[^[:alnum:]_./-])sed([[:space:]]+[^|;&[:space:]]+)*[[:space:]]+(-[A-Za-z]*i[^[:space:]]*|--in-place[^[:space:]]*)'
RE_KEEP='(^|[^[:alnum:]_])(prover_keep_bytes|prover_put_back)([^[:alnum:]_]|$)'
#   R5: ln, any options, then a first operand whose last path part is node_modules.
RE_LN_NM='(^|[^[:alnum:]_./-])ln([[:space:]]+-[^[:space:]]+)*[[:space:]]+[^[:space:]]*node_modules["]?([[:space:]]|$)'

offences=()
offenders=0
for f in "${FILES[@]}"; do
    # One pass per file: counts and the first line number of each finding.
    if ! read -r r1 r1l r1b r1bl src a b r3 r3l r4 r4l bl r1bp r1bpl r4p r4pl ind indl r5 r5l < <(
        awk -v re1="$RE_R1" -v re1b="$RE_R1B" -v res="$RE_SOURCE" -v rea="$RE_SHAPE_A" \
            -v reb="$RE_SHAPE_B" -v ret="$RE_TRAP" -v rei="$RE_SED_I" -v rek="$RE_KEEP" \
            -v rein="$RE_SHAPE_IN" -v reln="$RE_LN_NM" '
            BEGIN {
                r1 = 0; r1l = 0; r1b = 0; r1bl = 0; src = 0; a = 0; b = 0; r3 = 0; r3l = 0; r4 = 0; r4l = 0
                bl = 0; r1bp = 0; r1bpl = 0; r4p = 0; r4pl = 0; ind = 0; indl = 0; r5 = 0; r5l = 0
            }
            /^[[:space:]]*#/ { next }
            {
                # bl: the first Shape B line. A hit on an earlier line counts in r1bp or r4p,
                # because the outer run executes it in the shared checkout.
                if ($0 ~ reb) { b++; if (!bl) bl = NR }
                if ($0 ~ re1) { r1++; if (!r1l) r1l = NR }
                if ($0 ~ re1b) { r1b++; if (!r1bl) r1bl = NR; if (!bl) { r1bp++; if (!r1bpl) r1bpl = NR } }
                if ($0 ~ res) src++
                if ($0 ~ rea) a++
                if ($0 ~ rein) { ind++; if (!indl) indl = NR }
                if ($0 ~ ret) { r3++; if (!r3l) r3l = NR }
                if ($0 ~ rei || $0 ~ rek) { r4++; if (!r4l) r4l = NR; if (!bl) { r4p++; if (!r4pl) r4pl = NR } }
                if ($0 ~ reln) { r5++; if (!r5l) r5l = NR }
            }
            END { print r1, r1l, r1b, r1bl, src, a, b, r3, r3l, r4, r4l, bl, r1bp, r1bpl, r4p, r4pl, ind, indl, r5, r5l }
        ' "$f"
    ); then
        echo "check-provers-isolated: ${f} could not be scanned; NOT MEASURED (exit 2)" >&2
        exit 2
    fi
    before="${#offences[@]}"
    if [ "$r1" -gt 0 ]; then
        offences+=("${f}: R1 uses a git verb that writes the work tree, index or stash ($r1 code line(s), first at line ${r1l}); probe a private worktree instead")
    fi
    shape_b=0
    if [ "$b" -eq 1 ] && [ "$a" -eq 0 ]; then
        shape_b=1
    fi
    if [ "$r1b" -gt 0 ] && [ "$shape_b" -eq 0 ]; then
        offences+=("${f}: R1 uses git reset, rm, mv, add or commit without being Shape B ($r1b code line(s), first at line ${r1bl}); that write would land on the shared tree or index")
    elif [ "$r1bp" -gt 0 ]; then
        offences+=("${f}: R1 uses git reset, rm, mv, add or commit above prover_run_in_worktree (line ${r1bpl}, the shape at line ${bl}); the outer run executes it in the shared checkout")
    fi
    if [ "$src" -eq 0 ]; then
        offences+=("${f}: R2 does not source lib/prover-isolation.sh")
    fi
    if [ $((a + b)) -ne 1 ]; then
        offences+=("${f}: R2 enters $((a + b)) isolation shape(s) at column 0 (Shape A: $a, Shape B: $b); exactly one is required")
    fi
    if [ "$ind" -gt 0 ]; then
        offences+=("${f}: R2 enters a shape from an indented line (${ind} line(s), first at line ${indl}); inside a function, an if or a loop the outer run can reach other lines first, so the shape line must start at column 0")
    fi
    if [ "$r3" -gt 0 ]; then
        offences+=("${f}: R3 installs its own EXIT trap (line ${r3l}), replacing the helper's; use prover_on_exit")
    fi
    if [ "$r4" -gt 0 ] && [ "$shape_b" -eq 0 ]; then
        offences+=("${f}: R4 edits files in place (line ${r4l}) without being Shape B; that edit would land on the shared tree")
    elif [ "$r4p" -gt 0 ]; then
        offences+=("${f}: R4 edits files in place above prover_run_in_worktree (line ${r4pl}, the shape at line ${bl}); the outer run executes it in the shared checkout")
    fi
    if [ "$r5" -gt 0 ]; then
        offences+=("${f}: R5 links a whole node_modules directory (line ${r5l}); a Vite run through it writes the shared .vite cache, so use prover_link_node_modules")
    fi
    if [ "${#offences[@]}" -gt "$before" ]; then
        offenders=$((offenders + 1))
    fi
done

if [ "${#offences[@]}" -gt 0 ]; then
    printf '%s\n' "${offences[@]}"
    echo "FAIL: ${offenders} of ${#FILES[@]} provers are not isolated (${#offences[@]} offence(s) above)."
    echo "      Rewrite the prover onto one shape of scripts/lib/prover-isolation.sh; never exempt it."
    exit 1
fi
echo "OK: ${#FILES[@]} provers, each isolated (R1 to R5 hold on every code line)"
exit 0
