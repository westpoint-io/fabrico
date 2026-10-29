# shellcheck shell=bash
#
# prover-isolation.sh - the one way a prover in scripts/ is kept off the shared working
# tree (phase 84, plan 84-04, GATE-03, decision D-08). Sourced, never executed.
#
# ---------------------------------------------------------------------------------
# WHY THIS EXISTS.
#
# Concurrent processes may share this working tree, its index and its target/. A prover that
# edits a tracked file and restores it afterwards (the old shape: append a probe, then
# `git checkout --` the file) silently discards any edit another process saved to that
# file while the prover ran, and a prover that stages a deletion leaves it in the shared
# index, where the next commit made in that tree carries it. The "file must be clean at
# entry" guards those provers had cannot see an edit made a second after they ran.
#
# So every prover takes one of two shapes from this file, and nothing else.
#
#   SHAPE A, untracked probes: `prover_isolate_untracked [<probe>...]`.
#     Right when the gate under proof walks a directory, so a NEW untracked file placed in
#     it is seen without touching any tracked file. Refuses (exit 2) when a probe path
#     already exists or is tracked, removes every probe at exit, and compares the tracked
#     tree before and after. Called with no probes it only arms the comparison, for a
#     prover whose whole work happens under `mktemp -d`.
#
#   SHAPE B, a private worktree: `prover_run_in_worktree "$@"`.
#     Right when the probe must change, stage or delete a TRACKED path, or the gate reads
#     a fixed tracked path by name, so no untracked file can stand in for it. The caller's
#     HEAD is checked out into a detached worktree OUTSIDE this checkout (outside, so
#     rust-toolchain.toml and any other parent-directory lookup never find the outer one),
#     the caller's uncommitted tracked diff is applied over it, every untracked file git
#     does not ignore is copied in (review 84 WR-08: without them a new fixture, generator
#     or test module in the caller's checkout was silently absent, and a guard that refuses
#     an untracked fixture never saw it), and the same script is run again there with
#     FABRICO_PROVER_INNER=1 and a private CARGO_TARGET_DIR. So the proof covers the tree as
#     it stands: HEAD, the tracked diff and the untracked files. An untracked nested
#     repository cannot be carried and is exit 2. The worktree
#     has its own index and its own files: nothing the inner run does can reach the shared
#     ones. Inside it, `prover_keep_bytes` and `prover_put_back` restore a probed file from
#     its own saved bytes, never from git.
#
# THIS FILE OWNS THE ONLY EXIT TRAP A PROVER HAS. It is installed when the file is sourced.
# A prover registers its own cleanups with `prover_on_exit <function>` and must not call
# `trap ... EXIT` itself, which would replace this one and silently switch off the probe
# removal, the worktree removal and the comparison below.
#
# THE COMPARISON, taken when a shape is entered and again at exit, covers three things:
# `git status --porcelain --untracked-files=no`, the index (`git diff --cached
# --name-status`), and the sha256 of every tracked file that was already dirty at entry.
# Porcelain alone shows ` M` both before and after for a file somebody had already edited,
# so the hash is what proves an uncommitted edit survived byte for byte. Any difference
# names the differing lines and fails the run. Which failure it is (review 84 WR-10): a
# difference that names one of a Shape A prover's own probe paths is the prover's doing,
# exit 1. Any other difference is another writer's (other processes share this tree):
# in Shape B outer the prover wrote nothing here at all, and in Shape A it writes only its
# probes. That is exit 2, the proof could not be made on a tree that moved, never 1, which
# would send a reader hunting a vacuous gate that is not vacuous.
#
# EXIT CONTRACT ENFORCED HERE (the repository's prover convention):
#   0  the prover's own 0, with the tracked tree, the index and every dirty file unchanged
#   1  the prover's own 1, or its 0 turned into 1 by a tracked change to one of its probes
#   2  the proof could not be made: a probe path that exists or is tracked, a failed
#      `git worktree add` or `git apply`, a worktree or probe left behind, no sha256 tool,
#      or a tracked tree that another writer moved while the prover ran (this outranks the
#      prover's own 1, which was measured on that moving tree). An inner exit of 2 stays 2.
#      Also 2 (review 84 iteration 3 WR-02): a shape called from a function or a subshell;
#      HEAD, the tracked tree or the index moved between sourcing this file and entering
#      the shape; and an exit 0 that never entered a shape, unless `-h` or `--help` was
#      among the prover's arguments (a usage print). A write above the shape line has
#      already landed on the shared tree by then: these make sure such a run is never a
#      pass, and scripts/check-provers-isolated.sh refuses the text before it runs.
#
# PORTABILITY. CI runs provers on Linux, macOS (bash 3.2, BSD tools) and Windows (Git
# Bash). So: indexed arrays only, every possibly-empty array expanded through the
# `${a[@]+"${a[@]}"}` form (bash 3.2 calls an empty array unbound under `set -u`), no
# bash-4 associative arrays or list builtins, `date +%s` rather than EPOCHSECONDS, and the
# sha256 tool selected once below.
#
# USAGE, at the top of a prover and before it changes directory:
#
#   SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
#   . "${SCRIPT_DIR}/lib/prover-isolation.sh"
#   ... argument parsing (so --help needs no worktree) ...
#   prover_run_in_worktree "$@"          # Shape B
#   prover_isolate_untracked "$P1" "$P2" # or Shape A
#
# The shape line is a top-level statement at column 0, never inside a function, an `if`
# or a subshell, and nothing above it writes to the tracked tree.

# --- Where we are, recorded at source time --------------------------------------------
# BASH_SOURCE[1] is the script that sourced this file, as it was invoked. It is resolved
# NOW, before the caller changes directory, which is why the source line must come first.
_PI_CALLER_GIVEN="${BASH_SOURCE[1]:-}"
if [ -z "$_PI_CALLER_GIVEN" ] || [ ! -f "$_PI_CALLER_GIVEN" ]; then
    echo "FAIL: prover-isolation.sh must be sourced by a prover script, before that script" >&2
    echo "      changes directory (could not locate the caller '${_PI_CALLER_GIVEN}')." >&2
    exit 2
fi
_PI_CALLER="$(cd "$(dirname "$_PI_CALLER_GIVEN")" && pwd -P)/$(basename "$_PI_CALLER_GIVEN")"
_PI_SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/$(basename "${BASH_SOURCE[0]}")"
_PI_NAME="$(basename "$_PI_CALLER" .sh)"
if ! _PI_ROOT="$(cd "$(dirname "$_PI_CALLER")" && git rev-parse --show-toplevel 2>/dev/null)"; then
    echo "FAIL: ${_PI_CALLER} is not inside a git checkout, so it cannot be isolated." >&2
    exit 2
fi
_PI_ROOT="$(cd "$_PI_ROOT" && pwd -P)"
case "$_PI_CALLER" in
    "$_PI_ROOT"/*) _PI_REL="${_PI_CALLER#"$_PI_ROOT"/}" ;;
    *)
        echo "FAIL: ${_PI_CALLER} is not under its checkout root ${_PI_ROOT}." >&2
        exit 2
        ;;
esac

# --- The sha256 tool, selected ONCE ---------------------------------------------------
if command -v sha256sum >/dev/null 2>&1; then
    _PI_SHA256=(sha256sum)
elif command -v shasum >/dev/null 2>&1; then
    _PI_SHA256=(shasum -a 256)
else
    echo "FAIL: no sha256 tool found (need 'sha256sum' or 'shasum -a 256'), so the" >&2
    echo "      tracked-tree comparison could not be made." >&2
    exit 2
fi

_PI_TMPBASE="${TMPDIR:-/tmp}"
_PI_TMPBASE="${_PI_TMPBASE%/}"

# --- State --------------------------------------------------------------------------
_PI_EXIT_FNS=()     # registered cleanups, run last-registered first
_PI_PROBES=()       # Shape A probe paths, relative to the root
_PI_DIRTY=()        # tracked paths dirty at entry, hashed before and after
_PI_KEEP_PATHS=()   # Shape B inner: paths whose bytes were kept
_PI_SCRATCH=""      # private mktemp directory for snapshots and kept bytes
_PI_COMPARE=0       # 1 once a shape has taken the "before" snapshot
_PI_SHAPE=""        # A, B-outer or B-inner
_PI_WT=""           # Shape B outer: the worktree path
_PI_TARGET=""       # Shape B outer: the private cargo target directory

# --no-optional-locks: reading the status must not take the shared index lock or rewrite
# the index's stat data while another process works. core.quotePath=false: a path with
# non-ASCII bytes is listed as itself, so it can be hashed.
_pi_git() {
    git --no-optional-locks -C "$_PI_ROOT" -c core.quotePath=false "$@"
}

_pi_sha_of() {
    "${_PI_SHA256[@]}" <"$1" | awk '{print $1}'
}

_pi_scratch() {
    if [ -z "$_PI_SCRATCH" ]; then
        if ! _PI_SCRATCH="$(mktemp -d "${_PI_TMPBASE}/fabrico-pi-scratch.XXXXXX")"; then
            echo "FAIL: mktemp failed, so the prover could not be isolated." >&2
            exit 2
        fi
    fi
}

# Writes the three-part snapshot to $1. Returns non-zero if git could not be read.
_pi_snapshot() {
    local out="$1" status index i f h
    status="$(_pi_git status --porcelain --untracked-files=no)" || return 1
    index="$(_pi_git diff --cached --name-status --no-renames --no-ext-diff)" || return 1
    {
        echo "== tracked status"
        [ -n "$status" ] && printf '%s\n' "$status"
        echo "== index"
        [ -n "$index" ] && printf '%s\n' "$index"
        echo "== sha256 of tracked files dirty at entry"
        i=0
        while [ "$i" -lt "${#_PI_DIRTY[@]}" ]; do
            f="${_PI_DIRTY[$i]}"
            if [ -f "${_PI_ROOT}/${f}" ]; then
                h="$(_pi_sha_of "${_PI_ROOT}/${f}")"
            else
                h="absent"
            fi
            printf '%s  %s\n' "$h" "$f"
            i=$((i + 1))
        done
    } >"$out"
}

# Takes the "before" snapshot and arms the comparison at exit.
_pi_arm_compare() {
    local f list
    _pi_scratch
    if ! list="$(_pi_git diff HEAD --name-only --no-renames --no-ext-diff)"; then
        echo "FAIL: could not list the tracked files already dirty in ${_PI_ROOT}." >&2
        exit 2
    fi
    _PI_DIRTY=()
    if [ -n "$list" ]; then
        while IFS= read -r f; do
            [ -n "$f" ] && _PI_DIRTY+=("$f")
        done <<<"$list"
    fi
    if ! _pi_snapshot "${_PI_SCRATCH}/before"; then
        echo "FAIL: could not read the tracked status of ${_PI_ROOT}." >&2
        exit 2
    fi
    _PI_COMPARE=1
}

# --- The state at source time (review 84 iteration 3 WR-02) ---------------------------
# Everything a prover runs between sourcing this file and entering its shape runs in the
# shared checkout, before the "before" snapshot. A shape line hidden in a function or an
# `if` made those lines look like "below the shape" to the lint. So HEAD, the tracked
# status, the index and the hash of every tracked file dirty at source time are recorded
# here, and a shape refuses to start (exit 2) if any of them moved before it was entered.
# _PI_HELP_ASKED: `-h` or `--help` is among the prover's arguments (a sourced file sees
# its caller's), so an exit 0 that never entered a shape is a usage print, not a proof.
_PI_SRC_DIRTY=()
_PI_SRC_STATE=""
_PI_HELP_ASKED=0
for _pi_a in "$@"; do
    case "$_pi_a" in
        -h | --help) _PI_HELP_ASKED=1 ;;
    esac
done
unset _pi_a

# Prints HEAD, the tracked status, the index and the hashes of _PI_SRC_DIRTY. Returns
# non-zero if git could not be read.
_pi_source_state() {
    local head status index f h
    head="$(_pi_git rev-parse -q --verify HEAD)" || head="none"
    status="$(_pi_git status --porcelain --untracked-files=no)" || return 1
    index="$(_pi_git diff --cached --name-status --no-renames --no-ext-diff)" || return 1
    printf 'HEAD %s\n== tracked status\n%s\n== index\n%s\n== sha256 of tracked files dirty at source time\n' \
        "$head" "$status" "$index"
    for f in ${_PI_SRC_DIRTY[@]+"${_PI_SRC_DIRTY[@]}"}; do
        if [ -f "${_PI_ROOT}/${f}" ]; then
            h="$(_pi_sha_of "${_PI_ROOT}/${f}")"
        else
            h="absent"
        fi
        printf '%s  %s\n' "$h" "$f"
    done
}

# Refuses (exit 2) a shape entered from a function or a subshell, or after the state
# recorded at source time moved. $1 is the shape's public name.
_pi_require_clean_entry() {
    local now
    # FUNCNAME[2] is the shape's caller: "main" (or unset) at the prover's top level.
    if [ "${FUNCNAME[2]:-main}" != "main" ] || [ "${BASH_SUBSHELL:-0}" -ne 0 ]; then
        echo "FAIL: ${_PI_NAME} called $1 from inside a function or a subshell (caller" >&2
        echo "      '${FUNCNAME[2]:-main}', subshell level ${BASH_SUBSHELL:-0}). Every line the outer" >&2
        echo "      run reaches first runs in the shared checkout, so the shape line must be a" >&2
        echo "      top-level statement of the prover." >&2
        exit 2
    fi
    if ! now="$(_pi_source_state)"; then
        echo "FAIL: could not read the tracked status of ${_PI_ROOT} on entering $1." >&2
        exit 2
    fi
    if [ "$now" != "$_PI_SRC_STATE" ]; then
        _pi_scratch
        printf '%s\n' "$_PI_SRC_STATE" >"${_PI_SCRATCH}/at-source"
        printf '%s\n' "$now" >"${_PI_SCRATCH}/at-entry"
        echo "FAIL: HEAD, the tracked tree or the index changed between sourcing" >&2
        echo "      prover-isolation.sh and ${_PI_NAME}'s $1 line:" >&2
        # diff exits 1 on a difference; `|| true` keeps `set -e` from ending the run as 1.
        diff "${_PI_SCRATCH}/at-source" "${_PI_SCRATCH}/at-entry" |
            sed -n -e 's/^< /  at source: /p' -e 's/^> /  at entry:  /p' >&2 || true
        echo "      Either the prover ran a write above its shape line, or another writer (the" >&2
        echo "      tree is shared with other processes) moved it. Exit 2: the proof was not made." >&2
        exit 2
    fi
}

if ! _pi_list="$(_pi_git diff HEAD --name-only --no-renames --no-ext-diff 2>/dev/null)"; then
    _pi_list=""
fi
if [ -n "$_pi_list" ]; then
    while IFS= read -r _pi_f; do
        [ -n "$_pi_f" ] && _PI_SRC_DIRTY+=("$_pi_f")
    done <<<"$_pi_list"
fi
unset _pi_list _pi_f
if ! _PI_SRC_STATE="$(_pi_source_state)"; then
    echo "FAIL: could not read the tracked status of ${_PI_ROOT} when the prover started." >&2
    exit 2
fi

# Compares the "after" snapshot with "before". Returns 0 when they match. On a difference it
# prints the lines and returns 1 when a line names one of this prover's own Shape A probes,
# else 2 (another writer moved the tree; review 84 WR-10).
_pi_compare() {
    local d p own=0
    if ! _pi_snapshot "${_PI_SCRATCH}/after"; then
        echo "FAIL: could not read the tracked status of ${_PI_ROOT} at exit." >&2
        return 2
    fi
    if d="$(diff "${_PI_SCRATCH}/before" "${_PI_SCRATCH}/after")"; then
        return 0
    fi
    echo "TRACKED TREE CHANGED during ${_PI_NAME}:" >&2
    printf '%s\n' "$d" | sed -n -e 's/^< /  before: /p' -e 's/^> /  after:  /p' >&2
    if [ "$_PI_SHAPE" = "A" ]; then
        for p in ${_PI_PROBES[@]+"${_PI_PROBES[@]}"}; do
            if printf '%s\n' "$d" | grep -F -- "$p" >/dev/null; then
                own=1
            fi
        done
    fi
    if [ "$own" -eq 1 ]; then
        echo "  A line above names a probe of this prover, which must stay untracked: the prover" >&2
        echo "  itself staged or committed it. Exit 1." >&2
        return 1
    fi
    if [ "$_PI_SHAPE" = "B-outer" ]; then
        echo "  This prover wrote only in its private worktree, so every line above is a change" >&2
        echo "  by another writer (the tree is shared with other processes) while it ran. Nothing" >&2
        echo "  was discarded; the proof is not certified for a tree that moved under it." >&2
    else
        echo "  No line above names a probe of this prover, and a Shape A prover writes only its" >&2
        echo "  probes, so another writer (the tree is shared with other processes) changed it while" >&2
        echo "  the prover ran." >&2
    fi
    echo "  Exit 2: the proof could not be made on a tree that moved. Repeat the run." >&2
    return 2
}

# Removes the Shape B worktree, its registration and its private cargo target.
# Returns 2 if anything is left behind.
_pi_remove_worktree() {
    local left=0
    if [ -n "$_PI_WT" ]; then
        git -C "$_PI_ROOT" worktree remove --force "$_PI_WT" >/dev/null 2>&1
        case "$_PI_WT" in
            "${_PI_TMPBASE}"/fabrico-prover-*)
                if [ -e "$_PI_WT" ]; then rm -rf -- "$_PI_WT"; fi
                ;;
        esac
        git -C "$_PI_ROOT" worktree prune >/dev/null 2>&1
        if [ -e "$_PI_WT" ]; then
            echo "FAIL: the prover worktree ${_PI_WT} is still on disk." >&2
            left=1
        fi
        if git -C "$_PI_ROOT" worktree list --porcelain | grep -xF "worktree ${_PI_WT}" >/dev/null; then
            echo "FAIL: the prover worktree ${_PI_WT} is still registered." >&2
            left=1
        fi
    fi
    if [ -n "$_PI_TARGET" ]; then
        case "$_PI_TARGET" in
            "${_PI_ROOT}"/target/isolated/cargo-*)
                rm -rf -- "$_PI_TARGET"
                ;;
        esac
    fi
    [ "$left" -eq 0 ] || return 2
    return 0
}

# THE EXIT TRAP. Cleanups, then probes, then the worktree, then the comparison.
_pi_on_exit_trap() {
    local rc=$? i p crc
    trap - EXIT
    set +e

    i=$((${#_PI_EXIT_FNS[@]} - 1))
    while [ "$i" -ge 0 ]; do
        "${_PI_EXIT_FNS[$i]}"
        i=$((i - 1))
    done

    for p in ${_PI_PROBES[@]+"${_PI_PROBES[@]}"}; do
        rm -rf -- "${_PI_ROOT:?}/${p}"
    done
    for p in ${_PI_PROBES[@]+"${_PI_PROBES[@]}"}; do
        if [ -e "${_PI_ROOT}/${p}" ] || [ -L "${_PI_ROOT}/${p}" ]; then
            echo "FAIL: probe '${p}' is still present after the prover exited." >&2
            [ "$rc" -eq 2 ] || rc=2
        fi
    done

    if [ "$_PI_SHAPE" = "B-outer" ]; then
        if ! _pi_remove_worktree; then
            [ "$rc" -eq 2 ] || rc=2
        fi
    fi

    # A run that never entered a shape had no comparison and no cleanup, and any write it
    # made landed on the shared tree: its 0 is not a proof, so it becomes 2. The one 0 kept
    # is a usage print, asked for with -h or --help (review 84 iteration 3 WR-02).
    if [ -z "$_PI_SHAPE" ] && [ "$rc" -eq 0 ] && [ "$_PI_HELP_ASKED" -ne 1 ]; then
        echo "FAIL: ${_PI_NAME} exited 0 without entering an isolation shape" >&2
        echo "      (prover_isolate_untracked or prover_run_in_worktree), so nothing was compared" >&2
        echo "      and nothing it wrote was kept off the shared tree. Exit 2: the proof was not made." >&2
        rc=2
    fi

    if [ "$_PI_COMPARE" -eq 1 ]; then
        _pi_compare
        crc=$?
        # A 1 (the prover's own probe) turns only a 0 into 1; a 2 (the tree moved under the
        # prover) outranks its 0 and its 1 alike, since both were measured on that tree. A
        # signal's code (130, 143, 129) is left as it is.
        if [ "$crc" -eq 2 ] && { [ "$rc" -eq 0 ] || [ "$rc" -eq 1 ]; }; then
            rc=2
        elif [ "$crc" -ne 0 ] && [ "$rc" -eq 0 ]; then
            rc="$crc"
        fi
    fi

    if [ -n "$_PI_SCRATCH" ]; then
        rm -rf -- "$_PI_SCRATCH"
    fi
    exit "$rc"
}
trap _pi_on_exit_trap EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

# --- Public: register a cleanup -----------------------------------------------------
prover_on_exit() {
    if [ $# -ne 1 ] || ! command -v "$1" >/dev/null 2>&1; then
        echo "FAIL: prover_on_exit needs the name of one defined function (got '$*')." >&2
        exit 2
    fi
    _PI_EXIT_FNS+=("$1")
}

# --- Public: SHAPE A ----------------------------------------------------------------
prover_isolate_untracked() {
    local p
    if [ -n "$_PI_SHAPE" ]; then
        echo "FAIL: ${_PI_NAME} entered an isolation shape twice (${_PI_SHAPE}, then A)." >&2
        exit 2
    fi
    _pi_require_clean_entry prover_isolate_untracked
    for p in "$@"; do
        case "$p" in
            '' | /* | *..*)
                echo "FAIL: probe path '${p}' must be a non-empty path relative to ${_PI_ROOT}." >&2
                exit 2
                ;;
        esac
        if [ -e "${_PI_ROOT}/${p}" ] || [ -L "${_PI_ROOT}/${p}" ]; then
            echo "FAIL: probe path '${p}' already exists; refusing to overwrite or remove it." >&2
            exit 2
        fi
        if _pi_git ls-files --error-unmatch -- "$p" >/dev/null 2>&1; then
            echo "FAIL: probe path '${p}' is tracked by git; a probe must be a new file." >&2
            exit 2
        fi
    done
    _PI_SHAPE="A"
    # Registered before anything is written, so an abort from here on removes them.
    for p in "$@"; do
        _PI_PROBES+=("$p")
    done
    _pi_arm_compare
}

# --- Public: SHAPE B ----------------------------------------------------------------
# In the outer case this never returns: it runs the inner script and exits with its code.
# In the inner case it validates where it is and returns.
prover_run_in_worktree() {
    local top common gitdir wt patch rc out f _pi_copied _PI_OVERLAY
    if [ "${FABRICO_PROVER_INNER:-}" = "1" ]; then
        # The inner run's lines above the shape ran in the private worktree, so only the
        # call site is checked here; the outer run already checked the state.
        if [ "${FUNCNAME[1]:-main}" != "main" ] || [ "${BASH_SUBSHELL:-0}" -ne 0 ]; then
            echo "FAIL: ${_PI_NAME} called prover_run_in_worktree from inside a function or a subshell." >&2
            exit 2
        fi
        top="$(git rev-parse --show-toplevel 2>/dev/null)"
        gitdir="$(cd "$top" 2>/dev/null && git rev-parse --absolute-git-dir 2>/dev/null)"
        common="$(cd "$top" 2>/dev/null && cd "$(git rev-parse --git-common-dir)" 2>/dev/null && pwd -P)"
        case "$(basename "$top")" in
            fabrico-prover-*) ;;
            *) top="" ;;
        esac
        if [ -z "$top" ] || [ -z "$gitdir" ] || [ "$(cd "$gitdir" && pwd -P)" = "$common" ]; then
            echo "FAIL: FABRICO_PROVER_INNER=1 is set, but this is not a prover worktree." >&2
            echo "      Refusing: the variable must never be used to run a Shape B prover in" >&2
            echo "      a shared checkout." >&2
            exit 2
        fi
        _PI_SHAPE="B-inner"
        return 0
    fi

    if [ -n "$_PI_SHAPE" ]; then
        echo "FAIL: ${_PI_NAME} entered an isolation shape twice (${_PI_SHAPE}, then B)." >&2
        exit 2
    fi
    _pi_require_clean_entry prover_run_in_worktree
    _PI_SHAPE="B-outer"
    _pi_arm_compare

    wt="${_PI_TMPBASE}/fabrico-prover-${_PI_NAME}-$$-$(date +%s)"
    if [ -e "$wt" ]; then
        echo "FAIL: worktree path ${wt} already exists." >&2
        exit 2
    fi
    if ! out="$(git -C "$_PI_ROOT" -c core.hooksPath=/dev/null worktree add --detach "$wt" HEAD 2>&1)"; then
        echo "FAIL: git worktree add failed, so the proof could not be made:" >&2
        printf '%s\n' "$out" | sed 's/^/  /' >&2
        exit 2
    fi
    _PI_WT="$wt"
    # One target per RUN, not per prover name (review 84 WR-09): two concurrent runs of the
    # same prover (two checkout users, or a rerun while one is in flight) shared one directory,
    # and the first to exit removed it under the other's build. Every run removes its own at
    # exit, so nothing was reused across runs anyway.
    _PI_TARGET="${_PI_ROOT}/target/isolated/cargo-${_PI_NAME}-$$-$(date +%s)"

    # Overlay the caller's uncommitted TRACKED edits, so the proof covers the tree as it
    # stands, not only as committed.
    patch="${_PI_SCRATCH}/overlay.patch"
    if ! git -C "$_PI_ROOT" -c color.ui=never -c diff.noprefix=false -c diff.mnemonicPrefix=false \
        -c diff.relative=false diff HEAD --binary --no-ext-diff --no-color >"$patch"; then
        echo "FAIL: could not take the caller's uncommitted diff, so the proof could not be made." >&2
        exit 2
    fi
    if [ -s "$patch" ]; then
        if ! out="$(git -C "$wt" apply --binary "$patch" 2>&1)"; then
            echo "FAIL: git apply of the caller's uncommitted diff failed in ${wt}:" >&2
            printf '%s\n' "$out" | sed 's/^/  /' >&2
            exit 2
        fi
    fi
    # Copy every untracked file git does not ignore (review 84 WR-08). The list is taken
    # into a file first, so a failing `git ls-files` is seen rather than read as no files.
    if ! git -C "$_PI_ROOT" -c core.quotePath=false ls-files -z --others --exclude-standard \
        >"${_PI_SCRATCH}/untracked"; then
        echo "FAIL: could not list the caller's untracked files, so the proof could not be made." >&2
        exit 2
    fi
    _pi_copied=0
    while IFS= read -r -d '' f; do
        case "$f" in
            */)
                echo "FAIL: untracked nested repository '${f}' cannot be carried into the private" >&2
                echo "      worktree, so the proof would not cover the tree as it stands." >&2
                exit 2
                ;;
        esac
        mkdir -p "$(dirname "${wt}/${f}")"
        if ! cp -P "${_PI_ROOT}/${f}" "${wt}/${f}"; then
            echo "FAIL: could not copy the untracked file '${f}' into ${wt}." >&2
            exit 2
        fi
        _pi_copied=$((_pi_copied + 1))
    done <"${_PI_SCRATCH}/untracked"
    # The inner run must be the code that was invoked, even if the prover or this helper is
    # new and not yet tracked: copy both over their worktree paths.
    mkdir -p "$(dirname "${wt}/${_PI_REL}")" "$(dirname "${wt}/${_PI_SELF#"$_PI_ROOT"/}")"
    cp "$_PI_CALLER" "${wt}/${_PI_REL}"
    cp "$_PI_SELF" "${wt}/${_PI_SELF#"$_PI_ROOT"/}"

    # THE OVERLAY'S NAME (review 92 WR-A-06): the run tests HEAD plus the tracked diff and the
    # untracked files above, so an evidence line that names only HEAD claims less was tested
    # than was. The inner run reads `prover_overlay_stamp`: `none` when the overlay is empty,
    # else the first 16 hex of the sha256 over the patch and every carried file's path and
    # sha256, in the order carried.
    if [ -s "$patch" ] || [ "$_pi_copied" -gt 0 ]; then
        {
            "${_PI_SHA256[@]}" <"$patch" | cut -d' ' -f1
            while IFS= read -r -d '' f; do
                printf '%s %s\n' "$f" "$(_pi_sha_of "${_PI_ROOT}/${f}")"
            done <"${_PI_SCRATCH}/untracked"
        } >"${_PI_SCRATCH}/overlay.id"
        _PI_OVERLAY="$("${_PI_SHA256[@]}" <"${_PI_SCRATCH}/overlay.id" | cut -c1-16)"
    else
        _PI_OVERLAY="none"
    fi

    echo "${_PI_NAME}: running in a private worktree, ${wt} (${_pi_copied} untracked file(s) carried, overlay ${_PI_OVERLAY})"
    (
        unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX GIT_COMMON_DIR
        cd "$wt" || exit 2
        FABRICO_PROVER_INNER=1 FABRICO_PROVER_OVERLAY="$_PI_OVERLAY" FABRICO_PROVER_CALLER_ROOT="$_PI_ROOT" \
            CARGO_TARGET_DIR="$_PI_TARGET" bash "${wt}/${_PI_REL}" "$@"
    )
    rc=$?
    exit "$rc"
}

# --- Public, Shape B inner only: keep a file's bytes, and put them back ---------------
_pi_require_inner() {
    if [ "$_PI_SHAPE" != "B-inner" ]; then
        echo "FAIL: $1 is for the inside of a prover worktree only (shape is '${_PI_SHAPE}')." >&2
        exit 2
    fi
}

_pi_keep_index() {
    local i=0
    while [ "$i" -lt "${#_PI_KEEP_PATHS[@]}" ]; do
        if [ "${_PI_KEEP_PATHS[$i]}" = "$1" ]; then
            echo "$i"
            return 0
        fi
        i=$((i + 1))
    done
    return 1
}

prover_keep_bytes() {
    local p idx
    _pi_require_inner prover_keep_bytes
    _pi_scratch
    for p in "$@"; do
        if [ ! -f "$p" ]; then
            echo "FAIL: cannot keep the bytes of '${p}': it is not a file." >&2
            exit 2
        fi
        if idx="$(_pi_keep_index "$p")"; then
            echo "FAIL: the bytes of '${p}' were already kept." >&2
            exit 2
        fi
        idx="${#_PI_KEEP_PATHS[@]}"
        if ! cp -p "$p" "${_PI_SCRATCH}/keep.${idx}"; then
            echo "FAIL: could not keep the bytes of '${p}'." >&2
            exit 2
        fi
        _PI_KEEP_PATHS+=("$p")
    done
}

prover_put_back() {
    local p idx
    _pi_require_inner prover_put_back
    for p in "$@"; do
        if ! idx="$(_pi_keep_index "$p")"; then
            echo "FAIL: cannot put back '${p}': its bytes were never kept." >&2
            exit 2
        fi
        if ! cp "${_PI_SCRATCH}/keep.${idx}" "$p" || ! cmp -s "${_PI_SCRATCH}/keep.${idx}" "$p"; then
            echo "FAIL: '${p}' could not be put back to its kept bytes." >&2
            exit 2
        fi
    done
}

# Returns 0 when every named file is byte-identical to its kept bytes, 1 otherwise.
prover_same_as_kept() {
    local p idx
    _pi_require_inner prover_same_as_kept
    for p in "$@"; do
        idx="$(_pi_keep_index "$p")" || return 1
        cmp -s "${_PI_SCRATCH}/keep.${idx}" "$p" || return 1
    done
    return 0
}

# --- Public, Shape B inner only: what was tested, and the caller's node_modules -------
# (review 92 WR-A-05 and WR-A-06)

# prover_overlay_stamp: `none`, or the 16-hex name of the caller's tracked diff and
# untracked files the run carried over HEAD. An evidence line writes it beside the HEAD it
# names (`rev=<HEAD> overlay=<stamp>`), so a run that tested more than HEAD says so.
prover_overlay_stamp() {
    _pi_require_inner prover_overlay_stamp
    case "${FABRICO_PROVER_OVERLAY:-}" in
        none | [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f])
            printf '%s\n' "$FABRICO_PROVER_OVERLAY"
            ;;
        *)
            echo "FAIL: the outer run passed no overlay stamp, so what was tested cannot be named." >&2
            exit 2
            ;;
    esac
}

# prover_caller_root: the top level of the checkout the prover was invoked from (a linked
# worktree when it was run from one), not the parent of the shared git directory, which is
# always the main checkout.
prover_caller_root() {
    _pi_require_inner prover_caller_root
    if [ -z "${FABRICO_PROVER_CALLER_ROOT:-}" ] || [ ! -d "$FABRICO_PROVER_CALLER_ROOT" ]; then
        echo "FAIL: the outer run passed no caller root, so its node_modules cannot be found." >&2
        exit 2
    fi
    printf '%s\n' "$FABRICO_PROVER_CALLER_ROOT"
}

# prover_link_node_modules <from> <to>: make <to> a REAL directory whose entries are links
# to <from>'s entries, every entry but `.vite` and `.vite-temp`. Vite keeps its dependency
# cache in `<package>/node_modules/.vite` and its bundled configs in `.vite-temp`; through
# a link to the whole directory those were the CALLER's, and the private worktree's Vite
# (whose root path never matches the caller's) deleted and rewrote the shared cache on its
# first start, under any other Vite being served from it. With a real directory
# both land in the private worktree and go with it. <to> must not exist.
prover_link_node_modules() {
    local from="$1" to="$2" e n
    _pi_require_inner prover_link_node_modules
    if [ ! -d "$from" ]; then
        echo "FAIL: ${from} is not a directory, so there is no node_modules to link." >&2
        exit 2
    fi
    if [ -e "$to" ] || [ -L "$to" ]; then
        echo "FAIL: ${to} already exists in the private worktree." >&2
        exit 2
    fi
    mkdir "$to"
    for e in "$from"/* "$from"/.[!.]* "$from"/..?*; do
        [ -e "$e" ] || [ -L "$e" ] || continue
        n="$(basename "$e")"
        case "$n" in
            .vite | .vite-temp) continue ;;
        esac
        ln -s "$e" "${to}/${n}"
    done
}
