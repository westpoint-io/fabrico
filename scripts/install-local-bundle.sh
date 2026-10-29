#!/usr/bin/env bash
#
# Unpack the built Debian payload into a USER prefix, and take it back out again.
# Phase 81, decision D-09. ICON-02's approval walk depends on this script and on nothing else.
#
# WHY THIS EXISTS. On a Linux desktop without `dpkg-deb`, `rpmbuild` or `appimagetool`,
# none of Tauri's three Linux bundle targets installs natively. What actually
# puts an icon in a panel on such a desktop is a `.desktop` entry in the user applications
# directory plus PNGs under the user hicolor tree - and those are exactly the `.deb`
# payload. Copying them to a user prefix is therefore not a workaround; it is the package
# doing its job at a different prefix.
#
# THE TWO RULES THIS SCRIPT IS BUILT AROUND.
#
#   1. ONE DECLARED LIST. Install and uninstall both read PAYLOAD_MAP below and neither may
#      name a destination that is not in it. The two directions cannot drift because there is
#      one list rather than two that have to agree.
#
#   2. THE UNINSTALL REMOVES ONLY WHAT THE INSTALL RECORDED CREATING. The install writes a
#      MANIFEST - every file it copied, every directory it had to make, and anything the
#      desktop's own index refresh created inside a directory it made - and the uninstall
#      reads that manifest back. Rule 1 alone was not enough and the gap was measured: the
#      install refuses to overwrite an existing destination precisely because "already there"
#      means "not created by this run", and the uninstall used to make the exact opposite
#      assumption and recursively remove whatever stood at a declared destination. An
#      existing ~/.local/bin/fabrico-app and a populated ~/.local/lib/Fabrico were
#      destroyed that way in review (phase 81 review, CR-02). The uninstall now REFUSES a path it
#      cannot show it created: it reports it and leaves it.
#
# IDEMPOTENCE. `uninstall` with no manifest and nothing present is a clean no-op that exits 0.
# `uninstall` with a manifest whose paths are already gone counts them as already-absent and
# exits 0. `uninstall` with no manifest and a declared destination PRESENT refuses, names the
# path, leaves it in place and exits 1.
#
# frontend/src/render/assets/installScript.test.ts is the gate on this file. It walks the text
# for the structural properties AND it EXECUTES this script against a mkdtemp HOME, because a
# grep over a function body is not a behavioural claim. It reads PAYLOAD_MAP as a block, so
# keep the array a top-level literal opened by a line that is exactly `PAYLOAD_MAP=(` and
# closed by a line that is exactly `)`. It also asserts that no $HOME-rooted path appears
# anywhere in this file outside that array and MANIFEST_PATH, which is why every parent
# directory below is derived with `dirname` and never written out, and that the home directory
# is spelled exactly one way - no `${HOME}` and no `~/` in code - because the path predicates
# match one spelling and a second spelling is a hole rather than a style.
#
# THE MOST DAMAGING MISTAKE AVAILABLE HERE, named so it is never made: recursively deleting the
# shared icon tree. That tree holds other applications' icons. There is exactly ONE recursive removal in this file, inside
# `remove_path`, its operand is a variable, and `remove_path` refuses any operand that is not
# strictly under the user prefix. The pruning walk uses `rmdir`, which refuses a non-empty
# directory, and only ever names a directory the manifest records this install as creating.
#
# THIS SCRIPT NEVER USES sudo AND NEVER WRITES OUTSIDE THE USER PREFIX. Every destination is a
# path under the invoking user's home directory.
#
# Usage: scripts/install-local-bundle.sh { install | uninstall | verify } [--force] [--payload DIR]

set -euo pipefail
shopt -s nullglob

if [ -z "${HOME:-}" ]; then
    echo "FAIL: HOME is empty, so no user prefix can be resolved and nothing may be written." >&2
    exit 2
fi

# Captured BEFORE the `cd` below, so a relative --payload resolves against the directory the
# operator actually typed it in rather than against the repository root.
INVOCATION_DIR="$PWD"

if ! REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"; then
    echo "FAIL: not inside a git repository, so the built payload cannot be located." >&2
    exit 2
fi
cd "$REPO_ROOT"

# The one prefix every write and every removal must be strictly under. Held as its own
# constant so the guard below carries no $HOME-rooted path of its own.
USER_PREFIX="$HOME"

# --- THE ONE LIST ---------------------------------------------------------------------
#
# Each record is  <payload-relative source>|<destination>.  A `*` in a record is a glob and
# appears in BOTH halves at the same position: the icon layers are one record, not seven, so
# adding a size bucket to the bundle needs no edit here.
#
# Removing a record from this list is the gate-weakening move: it would orphan whatever that
# record installs, because the uninstall reads the same list.
PAYLOAD_MAP=(
    "usr/bin/fabrico-app|$HOME/.local/bin/fabrico-app"
    "usr/share/applications/Fabrico.desktop|$HOME/.local/share/applications/Fabrico.desktop"
    "usr/share/icons/hicolor/*/apps/fabrico-app.png|$HOME/.local/share/icons/hicolor/*/apps/fabrico-app.png"
    "usr/lib/Fabrico|$HOME/.local/lib/Fabrico"
)

# --- THE OWNERSHIP RECORD -------------------------------------------------------------
#
# The install writes one tab-separated record per path it creates:
#
#   file<TAB>path   a regular file this install copied
#   tree<TAB>path   a directory this install copied whole, removable recursively
#   dir<TAB>path    a directory this install had to make, removable only with rmdir
#   index<TAB>path  a desktop index cache this install's refresh brought into existence. Its
#                   own kind because the uninstall has to remove it TWICE: once with everything
#                   else, and again after its own refresh writes it back
#
# The uninstall removes exactly these, then removes this file, then rmdirs the `dir` records
# deepest first. It is the answer to the question the install already asks and the uninstall
# used not to: did this script create the thing it is about to delete.
MANIFEST_PATH="$HOME/.local/share/fabrico/install-manifest"

# Where `tauri build --bundles deb` leaves the unpacked payload. A glob over the version
# directory, so a version bump needs no edit.
PAYLOAD_GLOB="target/release/bundle/deb/*/data"

usage() {
    cat >&2 <<'USAGE'
usage: scripts/install-local-bundle.sh { install | uninstall | verify } [--force] [--payload DIR]

Unpacks the built Debian payload into ~/.local, and takes it back out again.

  install     copy every declared source into its declared destination, recording every path
              created in ~/.local/share/fabrico/install-manifest. Refuses to overwrite an
              existing destination and names the path that stopped it, unless --force. Fails
              naming the record if any declared source matches nothing in the payload.
  uninstall   remove exactly the paths the manifest records this script creating. A path the
              manifest does not account for is REPORTED AND LEFT, never removed. With no
              manifest and nothing present it is a clean no-op.
  verify      print every declared destination with its existence state. Exits non-zero if
              any declared destination is absent.

  --force         overwrite existing destinations during install, and rewrite the manifest
  --payload DIR   use DIR as the unpacked payload root instead of discovering it under
                  target/release/bundle/deb/. A relative DIR resolves against the directory
                  you ran this from, not against the repository root.
  --help, -h      this message

Exit codes:
  0  the subcommand did what it says
  1  install refused to overwrite, verify found a missing destination, or uninstall refused a
     path it could not show it created
  2  the assertion could not be made (no repository, no payload, incomplete payload, bad
     arguments)
USAGE
}

# The destination half of a record.
destination_of() {
    printf '%s' "${1#*|}"
}

# The payload-relative source half of a record.
source_of() {
    printf '%s' "${1%%|*}"
}

# Given a record and ONE concrete payload-relative source path that its source glob matched,
# return the concrete destination. The glob segment is lifted out of the concrete source and
# substituted into the destination pattern at the same position, so the two halves stay bound
# to each other rather than being resolved independently.
concrete_destination() {
    local record="$1" concrete_source="$2"
    local pattern destination prefix suffix middle
    pattern="$(source_of "$record")"
    destination="$(destination_of "$record")"

    if [ "$pattern" = "${pattern%%\**}" ]; then
        printf '%s' "$destination"
        return 0
    fi

    prefix="${pattern%%\**}"
    suffix="${pattern#*\*}"
    middle="${concrete_source#"$prefix"}"
    middle="${middle%"$suffix"}"
    printf '%s' "${destination%%\**}${middle}${destination#*\*}"
}

# True only for a path STRICTLY under the user prefix. Every write and every removal in this
# file passes through this, so no operand can escape the home directory even if a record, a
# manifest line or a payload path were malformed.
under_user_prefix() {
    case "$1" in
        "$USER_PREFIX"/*) return 0 ;;
        *) return 1 ;;
    esac
}

# THE ONLY REMOVAL IN THIS FILE, and the only place `rm` appears at all.
#
# The operand is a variable, which is exactly the shape a text gate cannot bound - so it is
# bounded HERE instead, at runtime, by refusing anything that is not strictly under the user
# prefix. A directory is removed recursively only because every caller reaches this with a
# path the manifest records this install as having created.
remove_path() {
    local path="$1"
    if ! under_user_prefix "$path"; then
        echo "FAIL: refusing to remove $path, which is not under the user prefix." >&2
        exit 2
    fi
    if [ -d "$path" ] && [ ! -L "$path" ]; then
        rm -rf "$path"
    else
        rm -f "$path"
    fi
}

# Append one ownership record. Every path that reaches the manifest is prefix-checked, so a
# malformed record cannot teach the uninstall to delete outside the user prefix.
record_path() {
    local kind="$1" path="$2"
    if ! under_user_prefix "$path"; then
        echo "FAIL: refusing to record $path, which is not under the user prefix." >&2
        exit 2
    fi
    printf '%s\t%s\n' "$kind" "$path" >>"$MANIFEST_PATH"
}

# The directories that would have to be made for `$1` to exist, shallowest first. Empty when
# the directory already exists, which is the whole ownership question in one predicate.
missing_dirs() {
    local directory="$1" parent
    local -a stack=()
    while [ ! -d "$directory" ]; do
        stack=("$directory" ${stack[@]+"${stack[@]}"})
        parent="$(dirname "$directory")"
        if [ "$parent" = "$directory" ]; then
            break
        fi
        directory="$parent"
    done
    if [ "${#stack[@]}" -gt 0 ]; then
        printf '%s\n' "${stack[@]}"
    fi
}

# `mkdir -p` that records what it actually created, so the uninstall can prune those and only
# those. Deliberately NOT `mkdir -p`: that cannot tell a directory it made from one that was
# already there, which is the claim the pruning walk needs.
mkdir_owned() {
    local target="$1" directory
    while IFS= read -r directory; do
        if [ -n "$directory" ]; then
            mkdir "$directory"
            record_path dir "$directory"
        fi
    done < <(missing_dirs "$target")
}

# Open a fresh manifest, recording the directories the manifest itself needed.
#
# The two steps are ordered: make the directories, create the file, THEN write their records.
# A record cannot be appended to a file that does not exist yet.
start_manifest() {
    local directory
    local -a pending=()
    while IFS= read -r directory; do
        if [ -n "$directory" ]; then
            pending+=("$directory")
        fi
    done < <(missing_dirs "$(dirname "$MANIFEST_PATH")")

    for directory in ${pending[@]+"${pending[@]}"}; do
        mkdir "$directory"
    done
    : >"$MANIFEST_PATH"
    for directory in ${pending[@]+"${pending[@]}"}; do
        record_path dir "$directory"
    done
}

# The two directories the desktop's own index commands write into, derived from the declared
# list so that neither is named as a literal anywhere in this file.
index_directories() {
    local entry
    for entry in "${PAYLOAD_MAP[@]}"; do
        case "$(source_of "$entry")" in
            *icons*) printf '%s\n' "$(dirname "$(dirname "$(dirname "$(destination_of "$entry")")")")" ;;
            *applications*) printf '%s\n' "$(dirname "$(destination_of "$entry")")" ;;
        esac
    done
}

# The desktop's own indexes, refreshed best-effort the way desktop launcher installers and
# removers do it. NEITHER IS REQUIRED: often there is no icon-theme.cache anywhere under the
# user icon tree, and some desktop shells rebuild their own index with a raw `find` whenever
# the menu opens. Treating either as required would be wrong, which is why both swallow their output and their status.
refresh_desktop_indexes() {
    local entry icon_root='' desktop_dir=''
    for entry in "${PAYLOAD_MAP[@]}"; do
        case "$(source_of "$entry")" in
            *icons*) icon_root="$(dirname "$(dirname "$(dirname "$(destination_of "$entry")")")")" ;;
            *applications*) desktop_dir="$(dirname "$(destination_of "$entry")")" ;;
        esac
    done
    gtk-update-icon-cache "$icon_root" &>/dev/null || true
    update-desktop-database "$desktop_dir" &>/dev/null || true
}

# Every regular file directly inside the index directories, right now.
index_files() {
    local directory entry
    while IFS= read -r directory; do
        if [ -d "$directory" ]; then
            for entry in "$directory"/*; do
                if [ -f "$entry" ]; then
                    printf '%s\n' "$entry"
                fi
            done
        fi
    done < <(index_directories)
}

# Is `$1` one of the remaining arguments?
contains() {
    local needle="$1" item
    shift
    for item in "$@"; do
        if [ "$item" = "$needle" ]; then
            return 0
        fi
    done
    return 1
}

# Refresh the indexes and RECORD every file the refresh CREATED. Measured, and it is why this
# function exists rather than a bare refresh: `update-desktop-database` writes a mimeinfo.cache
# and `gtk-update-icon-cache` writes an icon-theme.cache, and on a machine where neither existed
# before, both are residue the uninstall would otherwise leave behind - which is exactly what
# D-09 forbids. The behavioural half of installScript.test.ts caught the icon-theme.cache case
# on the first run of this fix.
#
# THE OWNERSHIP QUESTION IS "DID IT EXIST BEFORE", NOT "IS THE DIRECTORY OURS". A cache that was
# already there is SHARED: the refresh rewrote a file somebody else owns, and rewriting is not
# creating, so it is deliberately not recorded and the uninstall leaves it alone.
refresh_and_record_indexes() {
    local entry
    local -a before=() after=()

    while IFS= read -r entry; do
        before+=("$entry")
    done < <(index_files)

    refresh_desktop_indexes

    while IFS= read -r entry; do
        after+=("$entry")
    done < <(index_files)

    for entry in ${after[@]+"${after[@]}"}; do
        if ! contains "$entry" ${before[@]+"${before[@]}"}; then
            record_path index "$entry"
            printf 'installed  %s\n' "$entry"
        fi
    done
}

discover_payload() {
    local IFS=''
    local candidates
    candidates=($PAYLOAD_GLOB)
    if [ "${#candidates[@]}" -eq 0 ]; then
        echo "FAIL: no unpacked payload found at $PAYLOAD_GLOB." >&2
        echo "Build one first: (cd crates/fabrico-app && ../../frontend/node_modules/.bin/tauri build --bundles deb)" >&2
        exit 2
    fi
    if [ "${#candidates[@]}" -gt 1 ]; then
        echo "FAIL: ${#candidates[@]} payload directories match $PAYLOAD_GLOB, so the right one is ambiguous." >&2
        echo "Pass one explicitly with --payload DIR." >&2
        exit 2
    fi
    printf '%s' "${candidates[0]}"
}

do_install() {
    # `IFS=''` suppresses word splitting while leaving pathname expansion alone, so the
    # unquoted glob expansions below still glob but a home directory containing a space no
    # longer splits a destination into two paths that exist nowhere - which silently disabled
    # the overwrite guard until it was measured (81-REVIEW.md WR-02).
    local IFS=''
    local payload="$1" force="$2"
    local entry destination existing concrete target matched copied=0

    if [ -e "$MANIFEST_PATH" ] && [ "$force" != "yes" ]; then
        echo "FAIL: $MANIFEST_PATH exists, so this payload is already installed." >&2
        echo "Run 'uninstall' first, or re-run 'install --force' to overwrite it." >&2
        exit 1
    fi

    for entry in "${PAYLOAD_MAP[@]}"; do
        destination="$(destination_of "$entry")"
        for existing in $destination; do
            if [ -e "$existing" ] && [ "$force" != "yes" ]; then
                echo "FAIL: $existing already exists and this run did not create it." >&2
                echo "Run 'uninstall' first, or re-run 'install --force' to overwrite it." >&2
                exit 1
            fi
        done
    done

    # PER RECORD, not over the whole payload. `nullglob` makes a source glob that matches
    # nothing contribute zero iterations in silence, so a payload built without bundle.icon
    # used to install the binary and the desktop entry and print a success line - the one
    # failure mode that would put a generic executable icon in front of an approval walk
    # while the transcript read "3 file(s) copied" (81-REVIEW.md WR-01).
    for entry in "${PAYLOAD_MAP[@]}"; do
        matched=0
        for concrete in $payload/$(source_of "$entry"); do
            matched=$((matched + 1))
        done
        if [ "$matched" -eq 0 ]; then
            echo "FAIL: no file in $payload matches the declared source $(source_of "$entry")." >&2
            echo "The payload is incomplete; rebuild with 'tauri build --bundles deb'." >&2
            exit 2
        fi
    done

    start_manifest

    for entry in "${PAYLOAD_MAP[@]}"; do
        for concrete in $payload/$(source_of "$entry"); do
            target="$(concrete_destination "$entry" "${concrete#"$payload/"}")"
            mkdir_owned "$(dirname "$target")"
            if [ -e "$target" ] || [ -L "$target" ]; then
                remove_path "$target"
            fi
            cp -a "$concrete" "$target"
            if [ -d "$target" ] && [ ! -L "$target" ]; then
                record_path tree "$target"
            else
                record_path file "$target"
            fi
            printf 'installed  %s\n' "$target"
            copied=$((copied + 1))
        done
    done

    if [ "$copied" -eq 0 ]; then
        echo "FAIL: the payload at $payload matched none of the declared sources." >&2
        exit 2
    fi

    refresh_and_record_indexes
    printf '%s file(s) or directories copied from %s\n' "$copied" "$payload"
    printf 'manifest   %s\n' "$MANIFEST_PATH"
}

# Remove the directories the manifest records this install as having MADE, and nothing else.
#
# The claim here used to be that everything below a glob record's fixed prefix "is structure
# the install created, so the uninstall owns it", which the code had no basis for: `mkdir -p`
# cannot tell a directory it made from one that was already there. The manifest gives that
# basis, so the comment is now a property rather than an assertion (81-REVIEW.md WR-08).
#
# Deepest first, because the manifest records a chain shallowest first. `rmdir` refuses a
# non-empty directory, so a bucket another application also uses survives on its own contents
# as well as on the ownership record.
prune_recorded_dirs() {
    local -a dirs=("$@")
    local directory index

    for ((index = ${#dirs[@]} - 1; index >= 0; index--)); do
        directory="${dirs[index]}"
        if ! under_user_prefix "$directory"; then
            continue
        fi
        if [ ! -d "$directory" ]; then
            continue
        fi
        if rmdir "$directory" 2>/dev/null; then
            printf 'pruned   %s\n' "$directory"
        fi
    done
}

# Every declared destination that exists right now, printed as LEFT and counted into
# UNACCOUNTED. Called when the manifest cannot account for a path: the answer is to report it
# and leave it, never to remove it and never to skip it silently.
#
# The count comes back in a global rather than on stdout, because the LEFT lines are also on
# stdout and a `$(...)` capture would swallow the report it exists to print.
UNACCOUNTED=0
report_unaccounted() {
    local IFS=''
    local entry destination present

    UNACCOUNTED=0
    for entry in "${PAYLOAD_MAP[@]}"; do
        destination="$(destination_of "$entry")"
        for present in $destination; do
            if [ -e "$present" ] || [ -L "$present" ]; then
                printf 'LEFT     %s\n' "$present"
                UNACCOUNTED=$((UNACCOUNTED + 1))
            fi
        done
    done
}

do_uninstall() {
    local IFS=''
    local kind path removed=0 absent=0
    local -a owned=() dirs=() caches=()

    if [ ! -f "$MANIFEST_PATH" ]; then
        report_unaccounted
        if [ "$UNACCOUNTED" -gt 0 ]; then
            echo "FAIL: there is no install manifest at $MANIFEST_PATH, so this script cannot show" >&2
            echo "it created the $UNACCOUNTED path(s) listed above. They have been LEFT IN PLACE." >&2
            echo "Remove them by hand if you are sure they are yours, or run 'install' first." >&2
            exit 1
        fi
        echo "OK: no install manifest and no declared destination present, so there is nothing to remove."
        return 0
    fi

    while IFS=$'\t' read -r kind path; do
        if [ -z "$kind" ]; then
            continue
        fi
        case "$kind" in
            file | tree) owned+=("$path") ;;
            index)
                owned+=("$path")
                caches+=("$path")
                ;;
            dir) dirs+=("$path") ;;
            *)
                echo "FAIL: unreadable manifest record kind '$kind' in $MANIFEST_PATH." >&2
                echo "Nothing has been removed." >&2
                exit 2
                ;;
        esac
    done <"$MANIFEST_PATH"

    for path in ${owned[@]+"${owned[@]}"}; do
        if [ ! -e "$path" ] && [ ! -L "$path" ]; then
            absent=$((absent + 1))
            continue
        fi
        remove_path "$path"
        printf 'removed  %s\n' "$path"
        removed=$((removed + 1))
    done

    remove_path "$MANIFEST_PATH"

    # THE ORDER OF THE NEXT THREE STEPS IS LOAD BEARING, and the behavioural half of
    # installScript.test.ts is what established it.
    #
    #   1. Refresh, so the desktop's own indexes are rebuilt WITHOUT our files. This has to
    #      happen while the directories still exist.
    #   2. Take back anything the refresh put back that this install had created. Removing a
    #      cache and then running the command that writes it is a loop that leaves residue:
    #      `gtk-update-icon-cache` recreated an icon-theme.cache that did not exist before the
    #      install, in the SHARED icon tree, and the uninstall left it there.
    #   3. Prune, last, because a directory cannot be rmdir-ed until the cache written into it
    #      in step 1 has been taken back in step 2.
    refresh_desktop_indexes

    for path in ${caches[@]+"${caches[@]}"}; do
        if [ -e "$path" ] || [ -L "$path" ]; then
            remove_path "$path"
            printf 'removed  %s (recreated by the index refresh)\n' "$path"
        fi
    done

    prune_recorded_dirs ${dirs[@]+"${dirs[@]}"}

    report_unaccounted
    printf '%s path(s) removed, %s already absent\n' "$removed" "$absent"
    if [ "$UNACCOUNTED" -gt 0 ]; then
        echo "FAIL: $UNACCOUNTED declared destination(s) above are not in the manifest, so this" >&2
        echo "script cannot show it created them. They have been LEFT IN PLACE." >&2
        exit 1
    fi
}

do_verify() {
    local IFS=''
    local entry destination present found missing=0

    for entry in "${PAYLOAD_MAP[@]}"; do
        destination="$(destination_of "$entry")"
        found=0
        for present in $destination; do
            if [ -e "$present" ]; then
                printf 'PRESENT  %s\n' "$present"
                found=1
            fi
        done
        if [ "$found" -eq 0 ]; then
            printf 'MISSING  %s\n' "$destination"
            missing=$((missing + 1))
        fi
    done

    if [ -f "$MANIFEST_PATH" ]; then
        printf 'PRESENT  %s\n' "$MANIFEST_PATH"
    else
        printf 'MISSING  %s\n' "$MANIFEST_PATH"
        missing=$((missing + 1))
    fi

    if [ "$missing" -gt 0 ]; then
        echo "FAIL: $missing declared destination(s) absent, so this is not installed." >&2
        return 1
    fi
    echo "OK: every declared destination is present."
}

SUBCOMMAND=""
FORCE="no"
PAYLOAD=""

while [ $# -gt 0 ]; do
    case "$1" in
        install | uninstall | verify)
            # A second subcommand used to win silently, so `verify uninstall` ran the
            # destructive one without saying so (81-REVIEW.md WR-10).
            if [ -n "$SUBCOMMAND" ]; then
                echo "FAIL: two subcommands given ($SUBCOMMAND and $1). Pick one." >&2
                exit 2
            fi
            SUBCOMMAND="$1"
            ;;
        --force)
            FORCE="yes"
            ;;
        --payload)
            # `--payload` as the final argument used to shift past the end and let `set -e`
            # kill the script with no output at all.
            if [ $# -lt 2 ]; then
                echo "FAIL: --payload needs a directory." >&2
                exit 2
            fi
            shift
            PAYLOAD="$1"
            ;;
        --help | -h)
            usage
            exit 0
            ;;
        *)
            echo "FAIL: unrecognised argument: $1" >&2
            usage
            exit 2
            ;;
    esac
    shift
done

case "$PAYLOAD" in
    '' | /*) ;;
    *) PAYLOAD="$INVOCATION_DIR/$PAYLOAD" ;;
esac

case "$SUBCOMMAND" in
    install)
        do_install "${PAYLOAD:-$(discover_payload)}" "$FORCE"
        ;;
    uninstall)
        do_uninstall
        ;;
    verify)
        do_verify
        ;;
    *)
        echo "FAIL: one of install, uninstall or verify is required." >&2
        usage
        exit 2
        ;;
esac
