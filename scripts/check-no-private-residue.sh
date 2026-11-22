#!/usr/bin/env bash
#
# No tracked file carries private residue: the maintainer's personal details, paths from the
# maintainer's own machine, or pointers into the private planning checkout that sits beside this
# repository and is ignored by it. The repository was published from a private one, and such a
# reference is either a broken pointer or personal data.
#
# PATTERNS apply to every tracked file except this one. SITE_PATTERNS apply only to tracked files
# under site/ and the root README.md, where a phase, requirement, plan or decision id from the
# private notes is a dead reference; a token in SITE_ALLOWED_TOKENS (a real name of the same shape)
# is excused when every match on its line is an allowed token. The names are stored rot13-encoded
# so this file doesn't spell them out. The first-name pattern is case-sensitive and treats a hyphen
# or digit as part of the word, so the brand mark, LogoMark and MARK-nn ids still pass. The three
# private paths may appear in .gitignore as whole lines and nowhere else. frontend/e2e-docs reads
# REQ_PREFIX, SITE_ALLOWED_TOKENS and SITE_PATTERNS from this file, so keep their layout.
#
# EXIT CODES: 0 clean; 1 residue found, each file:line named; 2 git grep itself failed.

export LC_ALL=C
rot13() { printf '%s' "$1" | tr 'A-Za-z' 'N-ZA-Mn-za-m'; }
P_FIRST="$(rot13 'Znex')"
P_LEGAL="$(rot13 'zruqv')"
P_MIDDLE="$(rot13 'funuv')"
P_FAMILY="$(rot13 'niqv')"
P_HANDLE="$(rot13 'zniqv')"
WB='(^|[^A-Za-z0-9_-])'
NB='([^A-Za-z0-9_-]|$)'

# Each entry is `label<TAB>flags<TAB>ERE`; flag `i` is case-insensitive, `-` case-sensitive.
PATTERNS=(
    "legal first name	i	${P_LEGAL}"
    "legal middle name	i	${P_MIDDLE}"
    "family name	i	${P_FAMILY}"
    "handle	i	${P_HANDLE}"
    "gmail address	i	@gmail[.]"
    "home directory path	-	/home/[^/[:space:]\"'\`]+/"
    "private planning path	i	[.]planning/"
    "assistant memory file	i	claude[.]md"
    "assistant name	i	claude"
    "assistant vendor	i	anthropic"
    "planning tool	i	(^|[^A-Za-z0-9])gsd([^A-Za-z0-9]|$)"
    "desktop environment	i	omarchy"
    "window manager	i	hyprland"
    "first name, as a word	-	${WB}${P_FIRST}${NB}"
)
# The labels keep "under site/" for README.md hits too: frontend/e2e-docs/leaks.spec.ts compares them.
REQ_PREFIX='[A-Z]{2,8}'
SITE_PATTERNS=(
    "phase id under site/	-	[Pp][Hh][Aa][Ss][Ee][ -]?[0-9]"
    "requirement id under site/	-	(^|[^A-Za-z0-9])${REQ_PREFIX}-[0-9]{2}([^A-Za-z0-9]|$)"
    "plan id under site/	-	[Pp]lan[ -]?[0-9]{2,3}([.][0-9]+)?-[0-9]{2}"
    "decision id under site/	-	(^|[^A-Za-z0-9])D-[0-9]{2}([^A-Za-z0-9]|$)"
)
SITE_ALLOWED_TOKENS='UTF-16'
ALLOWED_LINES=(".planning/" "CLAUDE.md" ".claude/")
SELF="scripts/check-no-private-residue.sh"

cd "$(git rev-parse --show-toplevel)" || exit 2
status=0
# tokens_allowed TEXT ERE [-i]: true when every letter/digit/hyphen run that matches is allowed.
tokens_allowed() {
    local text="$1" regex="$2" run matched=0
    shift 2
    while IFS= read -r run; do
        printf '%s\n' "$run" | grep -q -E "$@" -e "$regex" || continue
        matched=1
        case " ${SITE_ALLOWED_TOKENS} " in *" ${run} "*) ;; *) return 1 ;; esac
    done < <(printf '%s\n' "$text" | grep -o -E '[A-Za-z0-9-]+')
    [ "$matched" -eq 1 ]
}

# search ENTRY SITE PATHSPEC...: names every offending line; SITE=1 applies the token allowance.
search() {
    local label flags regex site="$2" hits rc hit file rest line text found=0 case_flag=()
    IFS='	' read -r label flags regex <<<"$1"
    shift 2
    [ "$flags" = "i" ] && case_flag=(-i)
    hits="$(git grep -nI -E ${case_flag[@]+"${case_flag[@]}"} -e "$regex" -- "$@")"
    rc=$?
    if [ "$rc" -gt 1 ]; then echo "FAIL: git grep exited ${rc} on the ${label} pattern." >&2; exit 2; fi
    while IFS= read -r hit; do
        [ -z "$hit" ] && continue
        file="${hit%%:*}"; rest="${hit#*:}"; line="${rest%%:*}"; text="${rest#*:}"; text="${text%$'\r'}"
        if [ "$file" = ".gitignore" ] && printf '%s\n' "${ALLOWED_LINES[@]}" | grep -qxF -- "$text"; then continue; fi
        if [ "$site" = 1 ] && tokens_allowed "$text" "$regex" ${case_flag[@]+"${case_flag[@]}"}; then continue; fi
        found=$((found + 1))
        printf 'FAIL: %s: %s:%s: %s\n' "$label" "$file" "$line" "$(printf '%s' "$text" | cut -c1-160)" >&2
    done <<<"$hits"
    echo "  ${label}: ${found}"
    [ "$found" -eq 0 ] || status=1
}

for entry in "${PATTERNS[@]}"; do search "$entry" 0 . ":!${SELF}"; done
for entry in "${SITE_PATTERNS[@]}"; do search "$entry" 1 site README.md; done

if [ "$status" -ne 0 ]; then
    echo "Remove the reference or reword it to describe the code, not the person or the private notes." >&2
    exit 1
fi
echo "OK: no private residue in tracked files."
