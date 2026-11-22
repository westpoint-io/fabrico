#!/usr/bin/env bash
#
# The test antialiasing switch is ABSENT FROM THE BUILT BUNDLES.
#
# WHAT THE SWITCH IS. `frontend/src/render/testAntialias.ts` reads one URL flag at boot and,
# in the Vite dev server only, creates the board's WebGL context with antialiasing on. The
# capture set uses it to photograph the board with antialiasing on as well as off. Shipped
# antialiasing is off, and a user must not be able to turn it on with a URL.
#
# WHY THE BUILT OUTPUT AND NOT THE TREE. The switch stays in source on purpose, so a grep of
# tracked files would always find it. What has to hold is that `vite build` drops it: the
# function returns early on `import.meta.env.DEV`, Vite replaces that with `false`, and the
# minifier removes the rest of the function together with the flag's name. If someone moves
# the name into an exported constant, reads it outside the guard, or a build config stops
# folding DEV, the name survives into the bundle and this check finds it.
#
# USAGE: bash scripts/check-test-aa-switch-absent.sh <dir>...
#   Each <dir> is a built output directory: frontend/dist (the app the desktop binary
#   embeds) or frontend/dist-embed (the docs embed). CI runs it on both.
#
# HOW A GREEN RUN IS MADE TO MEAN SOMETHING. A grep that finds nothing looks the same
# whether the name is absent or the search looked at nothing, so:
#   1. Every directory must exist. Its scan set (every *.js, *.mjs and *.html under it,
#      sorted) is printed with its size on every run. A directory with no such file, or
#      with no .js file, can't hold the renderer and is exit 2.
#   2. A positive control must be found in each directory's scan set: `devicePixelRatio`,
#      which `bootPixi` reads to size the canvas. A scan set that doesn't contain it can't
#      be the renderer's code, so a zero count there proves nothing; exit 2.
#   3. Exit 2 means "could not assert" and is never a pass.
#
# EXIT CODES
#   0  the flag's name occurs 0 times in every directory, and each directory could be checked
#   1  the name was FOUND; each file is printed as `FOUND <path> <count>`
#   2  the check could not be made (no directory given, a missing directory, an empty scan
#      set, no .js file, no positive control, a missing grep, find or sort)
#
# The last line is always
#   TEST AA SWITCH dirs=<n> files=<n> hits=<n> verdict=<ABSENT|PRESENT|UNMEASURED>

set -euo pipefail
export LC_ALL=C

# The flag's name. It appears here and in the switch's own source, test and spec; this
# script only ever searches built output, so naming it here is harmless.
FLAG="fab-test-antialias"
CONTROL="devicePixelRatio"

dirs_n=0
files_n=0
hits_n=0
unmeasured=0
found=0

finish() {
    local verdict
    if [ "$unmeasured" -ne 0 ]; then
        verdict="UNMEASURED"
    elif [ "$found" -ne 0 ]; then
        verdict="PRESENT"
    else
        verdict="ABSENT"
    fi
    echo "TEST AA SWITCH dirs=${dirs_n} files=${files_n} hits=${hits_n} verdict=${verdict}"
    case "$verdict" in
        UNMEASURED) exit 2 ;;
        PRESENT) exit 1 ;;
        *) exit 0 ;;
    esac
}

cannot() {
    echo "CANNOT ASSERT: $1" >&2
    unmeasured=1
}

for tool in grep find sort; do
    if ! command -v "$tool" >/dev/null 2>&1; then
        cannot "'${tool}' is not on PATH, so the bundles can't be searched."
    fi
done
if [ "$unmeasured" -ne 0 ]; then
    finish
fi

if [ $# -eq 0 ]; then
    cannot "no directory given. Usage: bash scripts/check-test-aa-switch-absent.sh <dir>..."
    finish
fi

for dir in "$@"; do
    dirs_n=$((dirs_n + 1))
    if [ ! -d "$dir" ]; then
        cannot "'${dir}' is not a directory (was the bundle built?)."
        continue
    fi

    list=()
    while IFS= read -r f; do
        [ -n "$f" ] && list+=("$f")
    done < <(find "$dir" -type f \( -name '*.js' -o -name '*.mjs' -o -name '*.html' \) | sort)

    echo "scan set for ${dir}: ${#list[@]} file(s)"
    js=0
    for f in ${list[@]+"${list[@]}"}; do
        echo "  ${f}"
        case "$f" in *.js) js=$((js + 1)) ;; esac
    done
    files_n=$((files_n + ${#list[@]}))

    if [ "${#list[@]}" -eq 0 ]; then
        cannot "'${dir}' holds no .js, .mjs or .html file, so there is nothing to search."
        continue
    fi
    if [ "$js" -eq 0 ]; then
        cannot "'${dir}' holds no .js file, so the renderer's code isn't in it."
        continue
    fi

    control=0
    for f in "${list[@]}"; do
        n="$(grep -o -F -- "$CONTROL" "$f" | grep -c . || true)"
        control=$((control + n))
    done
    echo "positive control '${CONTROL}' in ${dir}: ${control} occurrence(s)"
    if [ "$control" -lt 1 ]; then
        cannot "the positive control '${CONTROL}' isn't in '${dir}', so these files aren't the renderer and a zero count would prove nothing."
        continue
    fi

    for f in "${list[@]}"; do
        n="$(grep -o -F -- "$FLAG" "$f" | grep -c . || true)"
        if [ "$n" -gt 0 ]; then
            echo "FOUND ${f} ${n}"
            hits_n=$((hits_n + n))
            found=1
        fi
    done
done

if [ "$found" -ne 0 ]; then
    echo "The test antialiasing flag's name is in a built bundle, so a shipped build may let a" >&2
    echo "URL turn antialiasing on. Keep the name inline behind the import.meta.env.DEV early" >&2
    echo "return in frontend/src/render/testAntialias.ts, and don't export it or read it anywhere" >&2
    echo "else. Don't narrow this check's scan set to make it pass." >&2
fi
finish
