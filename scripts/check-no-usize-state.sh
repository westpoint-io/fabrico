#!/usr/bin/env bash
#
# Pointer-width serialized-field forward guard (Phase 3, plan 03-04; field rules
# rebuilt on code by phase 84 plan 84-05, GATE-04).
#
# The cross-platform replay trap: a serialized struct field typed as a
# POINTER-WIDTH integer (`usize` / `isize`) encodes to a different byte width on
# 32-bit vs 64-bit targets, so the same logical state would produce DIFFERENT
# postcard bytes (and different corpus/blake3 hashes) across architectures -
# silently breaking determinism (RESEARCH Pitfall 2). The fix is always to use a
# fixed-width integer type (u32/u64/i32/i64) for any field that crosses the
# serialization boundary.
#
# This guard scans fabrico-core's source for STRUCT FIELD declarations whose type
# holds a pointer-width integer anywhere (bare, or inside `Vec<..>`, `Option<..>`,
# `[..; N]`, a map key or value, a tuple) and FAILS the build if any appear. The scan
# covers crates/fabrico-core/src only (todo 2026-10-12-usize-gate-stops-at-fabrico-core).
#
# WHAT IS MATCHED, AND ON WHAT TEXT. One awk pass per file reduces every line to its
# CODE (`code_of` below: comments of every kind removed, string and char literals
# emptied, block-comment and raw-string state carried across lines) and applies two
# rules to that code, never to the raw line:
#   FIELD RULE: an identifier, optionally `r#`-prefixed, then a single `:` (not part of
#     `::`), then type text holding `usize` or `isize` as a whole word. The type text
#     is the rest of the code line, so a one-line struct, a one-line struct variant
#     and a block comment before or after the field all count. An occurrence followed
#     directly by `::` (a path such as `usize::MAX`) does not count.
#   TUPLE RULE: a `(` or `,`, optional visibility (`pub`, `pub(crate)`, ...), then
#     `usize` / `isize` closed by `,` or `)`: a tuple-struct positional field such as
#     `pub struct W(pub usize);`. Also any whole-word `usize` / `isize` (not followed
#     by `::`) after the line's first `(`, so `W(Vec<usize>)` and an enum variant
#     `A(Vec<usize>),` count.
#   WRAPPED FIELDS: a field head whose type text is empty (`pub v:`) or leaves a `<`,
#     `(` or `[` open (`pub v: BTreeMap<`), and any other line that leaves a `(` or `[`
#     open (a tuple struct wrapped one field per line), is joined with the following
#     code lines, at most 20, until its brackets balance. Both rules are applied to
#     the joined text and a hit is reported at the head's line.
# A code line is EXCLUDED from both rules when it holds one of the words `fn`, `let`,
# `const`, `static`, `type`, `impl` or `where` followed by whitespace (a signature, a
# local, an item, an alias, a bound; Rust forbids fields with those names, `r#type`
# is not the word `type`, and `'static` is a lifetime, not the word `static`), a `->`
# (a return type), `as usize` / `as isize` (a cast in a struct literal), a `|` (closure
# parameters) or `::<` (a turbofish). A line that DECLARES a struct, enum or union is
# never excluded whole: its generic list is dropped and each field or variant of a
# one-line body is excluded and ruled on by itself, so `pub struct A<const N: usize>
# { pub a: usize }` or a `fn(u8) -> u8` field beside a real one still bites (review 84
# WR-01). Text after the body's closing brace or paren is ruled on as well, so a second
# declaration on the same line is read (review 84 iteration 2 WR-02). Any line is also
# cut at each `}` that closes a body opened on an earlier line, each part ruled on by
# itself, so the last field of a multi-line body (`    pub a: usize, } pub struct B;`
# or `    V(usize), } impl E {`) is read whatever follows it (review 84 iteration 3
# WR-01). Because the rules
# read code, a string such as `"(u32, usize)"` or a comment such as `// see fn advance`
# can neither trip the gate nor excuse a field.
#
# A `where` that ends its code line (rustfmt's multi-line where clause) opens a clause
# whose bound lines, such as `T: Into<usize>,`, are bounds and not fields. They are
# skipped up to and including the line holding the `{`, `}` or `;` that closes the
# clause, so a mistaken entry can hide at most the lines up to the next brace or
# semicolon.
#
# The lexical `fn ` exclusion only ever catches a SINGLE-LINE signature. A
# rustfmt-wrapped signature puts each parameter on its own line, so a bare
# `    n: usize,` parameter line (admit.rs:346, DI-1) carries no `fn ` token of its
# own. The fix is STRUCTURAL: the same awk pass tracks unclosed fn-signature parens
# and marks every line that sits between `fn NAME(` and its matching `)` as a
# signature-interior line, to which neither rule applies.
#
# This pass CAN hide a real field if it mistakes something else for an open
# signature, because every line it marks is skipped. An earlier version counted
# parens on the raw line, so a `(` inside a comment, doc comment, string or char
# literal on a line that also said `fn` hid every later line of the file (review
# 260929-p7p CR-01). Two things now keep that risk small:
#   1. Parens are counted on CODE only. Each line is scanned left to right with
#      comments (line, doc and nested block), string literals (plain, byte and raw,
#      including ones that span lines) and char literals removed first. Signature
#      state is entered only when that code has a real `fn NAME(` (optional
#      generics) with more `(` than `)`.
#   2. Signature state also ends on any code line holding `{`, `}` or a `;` outside
#      square brackets. Parameter lines never carry these (an array type such as
#      `[u8; 4]` is why the `;` test skips brackets), so if something the scanner
#      does not model (a macro, say) still opens signature state, at most the lines
#      up to the next brace or semicolon are skipped, never the rest of the file.
# scripts/prove-no-usize-state-bites.sh pins every shape above with a named case,
# each seen red against the gate before the fix that closed it.
#
# Acceptance is THIS SCRIPT'S EXIT CODE, never an external source grep - so the
# banned type names written into the patterns below can never become a
# self-invalidating gate. No Rust build runs here, so it completes in well under a
# second on every OS runner under `shell: bash`. Only POSIX awk and ERE are used (no
# `\b`, no gawk functions, no `grep -P`), because the macOS (BSD awk) and Windows
# (Git Bash) runners run this too.

set -euo pipefail

# Resolve repo root so the script works from any cwd.
REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

SRC_DIR="crates/fabrico-core/src"

# NOT MEASURED is exit 2, never OK. A scan that reads no file proves nothing, so a
# missing source directory, a `find` that fails, or a file count below MIN_FILES (26
# `.rs` files at phase 84; the floor leaves room to merge a few, not to lose the tree)
# stops here. The listing is taken in a command substitution whose exit status is
# checked, because a `done < <(find ...)` process substitution hides a failing `find`
# from `set -e` and the loop then reads zero files and prints OK (review 84 CR-01).
MIN_FILES=20
if [ ! -d "$SRC_DIR" ]; then
    echo "FAIL: ${SRC_DIR} does not exist; NOT MEASURED." >&2
    exit 2
fi
if ! FILE_LIST="$(find "$SRC_DIR" -type f -name '*.rs' | LC_ALL=C sort)"; then
    echo "FAIL: could not list the .rs files under ${SRC_DIR}; NOT MEASURED." >&2
    exit 2
fi
FILE_COUNT=0
if [ -n "$FILE_LIST" ]; then
    FILE_COUNT="$(printf '%s\n' "$FILE_LIST" | wc -l | tr -d '[:space:]')"
fi
if [ "$FILE_COUNT" -lt "$MIN_FILES" ]; then
    echo "FAIL: scanned ${FILE_COUNT} .rs files under ${SRC_DIR}, below the floor of ${MIN_FILES}; NOT MEASURED." >&2
    exit 2
fi

# One awk pass per file. It prints `path:lineno:<raw line>` for every offending line.
# `-v F="$f"` passes only the single-line path value.
offending=""
while IFS= read -r f; do
    hits="$(LC_ALL=C awk -v F="$f" '
        function isid(ch) { return ch ~ /^[A-Za-z0-9_]$/ }
        # Char k places before position i, or "" before the line start (BSD awk
        # returns the FIRST char for substr(s, 0, 1), gawk returns "").
        function before(s, i, k) { return (i - k >= 1) ? substr(s, i - k, 1) : "" }
        # Return the code part of line s: comments dropped, every string literal
        # replaced by "" and every char literal by '"''"'. bc (block-comment
        # nesting depth), ins (inside a string) and rawh (-1 for a plain string,
        # else the raw-string hash count) carry across lines.
        function code_of(s,    out, i, n, ch, nx, j, k, h, cl, rest) {
            out = ""; i = 1; n = length(s)
            while (i <= n) {
                if (bc > 0) {
                    rest = substr(s, i); j = index(rest, "*/"); k = index(rest, "/*")
                    if (k > 0 && (j == 0 || k < j)) { bc++; i += k + 1; continue }
                    if (j == 0) return out
                    bc--; i += j + 1; continue
                }
                if (ins) {
                    if (rawh >= 0) {
                        cl = "\""; for (h = 0; h < rawh; h++) cl = cl "#"
                        j = index(substr(s, i), cl)
                        if (j == 0) return out
                        ins = 0; i += j + length(cl) - 1; continue
                    }
                    ch = substr(s, i, 1)
                    if (ch == "\\") { i += 2; continue }
                    if (ch == "\"") ins = 0
                    i++; continue
                }
                ch = substr(s, i, 1); nx = substr(s, i + 1, 1)
                if (ch == "/" && nx == "/") return out
                if (ch == "/" && nx == "*") { bc = 1; i += 2; continue }
                if (ch == "\"") { ins = 1; rawh = -1; out = out "\"\""; i++; continue }
                if (ch == "r" && (nx == "\"" || nx == "#") && \
                    (!isid(before(s, i, 1)) || \
                     (before(s, i, 1) ~ /^[bc]$/ && !isid(before(s, i, 2))))) {
                    j = i + 1; h = 0
                    while (substr(s, j, 1) == "#") { h++; j++ }
                    if (substr(s, j, 1) == "\"") {
                        ins = 1; rawh = h; out = out "\"\""; i = j + 1; continue
                    }
                }
                if (ch == "'"'"'") {
                    if (nx == "\\") {
                        j = index(substr(s, i + 3), "'"'"'")
                        if (j > 0) { out = out "'"''"'"; i += j + 3; continue }
                    } else if (nx != "" && substr(s, i + 2, 1) == "'"'"'") {
                        out = out "'"''"'"; i += 3; continue
                    }
                }
                out = out ch; i++
            }
            return out
        }
        # 1 when code holds a brace, or a semicolon outside square brackets.
        function ends_sig(code,    i, n, ch, b) {
            if (index(code, "{") > 0 || index(code, "}") > 0) return 1
            if (index(code, ";") == 0) return 0
            n = length(code); b = 0
            for (i = 1; i <= n; i++) {
                ch = substr(code, i, 1)
                if (ch == "[") b++
                else if (ch == "]") { if (b > 0) b-- }
                else if (ch == ";" && b == 0) return 1
            }
            return 0
        }
        # 1 when code s is one of the excluded forms (see the header).
        function excluded(s) {
            if (s ~ /(^|[^A-Za-z0-9_#'"'"'])(fn|let|const|static|type|impl|where)[[:space:]]/) return 1
            if (index(s, "->") > 0 || index(s, "|") > 0 || index(s, "::<") > 0) return 1
            if (s ~ /(^|[^A-Za-z0-9_])as[[:space:]]+[iu]size([^A-Za-z0-9_]|$)/) return 1
            return 0
        }
        # 1 when t holds usize or isize as a whole word not followed by `::`.
        function ptr_word(t,    off, a) {
            off = 0
            while (match(substr(t, off + 1), /[iu]size/)) {
                a = off + RSTART
                if (!(a > 1 && isid(substr(t, a - 1, 1))) && !isid(substr(t, a + 5, 1)) && \
                    substr(t, a + 5, 2) != "::")
                    return 1
                off = a + 4
            }
            return 0
        }
        # 1 when s holds a field head: an identifier (optionally r#-prefixed) and a
        # single `:`. FT is set to the type text, the rest of s after that colon.
        function field_type(s,    i, n, j, k) {
            n = length(s)
            for (i = 1; i <= n; i++) {
                if (substr(s, i, 1) != ":") continue
                if (substr(s, i + 1, 1) == ":") { i++; continue }
                if (i > 1 && substr(s, i - 1, 1) == ":") continue
                j = i - 1
                while (j >= 1 && substr(s, j, 1) ~ /^[ \t]$/) j--
                k = j
                while (k >= 1 && isid(substr(s, k, 1))) k--
                if (k == j || substr(s, k + 1, 1) ~ /^[0-9]$/) continue
                if (k >= 2 && substr(s, k - 1, 2) == "r#") k -= 2
                if (k >= 1 && substr(s, k, 1) ~ /^[A-Za-z0-9_#'"'"']$/) continue
                FT = substr(s, i + 1)
                return 1
            }
            return 0
        }
        # A positional field: a bare `usize` after `(` or `,` (with optional visibility),
        # or a pointer-width word anywhere after the first `(` (`W(Vec<usize>)`).
        function tuple_hit(s,    p) {
            if (s ~ /[(,][[:space:]]*(pub(\([^)]*\))?[[:space:]]+)?(usize|isize)[[:space:]]*[,)]/) return 1
            p = index(s, "(")
            return p > 0 && ptr_word(substr(s, p + 1))
        }
        # 1 when code s, already known not excluded, breaks either rule.
        function rules_hit(s) {
            return (field_type(s) && ptr_word(FT)) || tuple_hit(s)
        }
        # ONE-LINE TYPE DECLARATIONS. A code line that declares a struct, enum or union
        # is never excluded as a whole: its own generic list (`<const N: usize>`) is
        # dropped, its body (after the first `{`, or a `(` straight after the generics)
        # is split at top-level commas, and each field or variant is excluded and ruled
        # on by itself. So `&'"'"'static str`, `fn(u8) -> u8` or a const generic beside a
        # real field excuses only itself (review 84 WR-01).
        function is_decl(s) { return s ~ /(^|[^A-Za-z0-9_])(struct|enum|union)[[:space:]]+[A-Za-z_]/ }
        # The text of declaration s after the type name and its generic list.
        function decl_rest(s,    i, n, ch, dd) {
            match(s, /(^|[^A-Za-z0-9_])(struct|enum|union)[[:space:]]+[A-Za-z_][A-Za-z0-9_]*/)
            i = RSTART + RLENGTH; n = length(s)
            while (i <= n && substr(s, i, 1) ~ /^[ \t]$/) i++
            if (substr(s, i, 1) == "<") {
                dd = 0
                for (; i <= n; i++) {
                    ch = substr(s, i, 1)
                    if (ch == "<") dd++
                    else if (ch == ">" && !(i > 1 && substr(s, i - 1, 1) == "-")) {
                        dd--
                        if (dd == 0) { i++; break }
                    }
                }
            }
            return substr(s, i)
        }
        # 1 when one field or variant t of a declaration body breaks either rule.
        function seg_hit(t) {
            return index(t, "size") > 0 && !excluded(t) && rules_hit("(" t ")")
        }
        # 1 when any field or variant of declaration s breaks either rule. When the body
        # closes before the line ends, the rest of the line is ruled on too: a second
        # declaration there (`pub struct A { a: u8 } pub struct B { b: usize }`) through
        # decl_hit, anything else as a plain code line (review 84 iteration 2 WR-02).
        function decl_hit(s,    r, p, body, i, n, ch, dd, seg, rest) {
            r = decl_rest(s)
            sub(/^[[:space:]]+/, "", r)
            if (substr(r, 1, 1) == "(") p = 1
            else p = index(r, "{")
            if (p == 0) return 0
            body = substr(r, p + 1); n = length(body); dd = 0; seg = ""
            for (i = 1; i <= n; i++) {
                ch = substr(body, i, 1)
                if (ch == "(" || ch == "[" || ch == "{" || ch == "<") dd++
                else if (ch == ")" || ch == "]" || ch == "}" || \
                         (ch == ">" && !(i > 1 && substr(body, i - 1, 1) == "-"))) {
                    dd--
                    if (dd < 0) {
                        if (seg_hit(seg)) return 1
                        rest = substr(body, i + 1)
                        if (is_decl(rest)) return decl_hit(rest)
                        return index(rest, "size") > 0 && !excluded(rest) && rules_hit(rest)
                    }
                }
                if (ch == "," && dd == 0) {
                    if (seg_hit(seg)) return 1
                    seg = ""; continue
                }
                seg = seg ch
            }
            return seg_hit(seg)
        }
        # The text the line-wide exclusion is tested on: a declaration only from its body.
        function excl_text(s) { return is_decl(s) ? decl_rest(s) : s }
        # 1 when one part t of a code line breaks either rule: a declaration through
        # decl_hit, anything else as a plain line (excluded, or ruled by the field and
        # tuple rules).
        function part_hit(t) {
            if (index(t, "size") == 0) return 0
            if (is_decl(t)) return decl_hit(t)
            return !excluded(t) && rules_hit(t)
        }
        # 1 when code s breaks either rule. A `}` that takes the line below every brace
        # depth it has reached closes a body opened on an earlier line, so the text up
        # to it is the end of that body (`    pub a: usize, } pub struct B { b: u8 }`,
        # `    V(usize), } impl E {`). The line is cut at each such brace and every part is
        # ruled on by itself, so neither the declaration that follows (decl_hit starts
        # reading at its keyword) nor an excluded word in another part can hide a field
        # (review 84 iteration 3 WR-01). The whole line is ruled on as well, as before.
        # Text before a declaration keyword with no such brace before it is not read on
        # its own: in Rust it can only be attributes, visibility or an item that opens a
        # body (`mod m {`, `fn f() {`), never a field.
        function line_hit(s,    i, n, ch, dd, lo, st) {
            n = length(s); dd = 0; lo = 0; st = 1
            for (i = 1; i <= n; i++) {
                ch = substr(s, i, 1)
                if (ch == "{") dd++
                else if (ch == "}") {
                    dd--
                    if (dd < lo) {
                        lo = dd
                        if (part_hit(substr(s, st, i - st))) return 1
                        st = i + 1
                    }
                }
            }
            if (st > 1 && part_hit(substr(s, st))) return 1
            return part_hit(s)
        }
        # Apply both rules to the code of the current line (never a signature interior).
        # Returns 1 when the line was reported.
        function check(s, si) {
            if (si || index(s, "size") == 0) return 0
            if (!line_hit(s)) return 0
            print F ":" FNR ":" $0
            return 1
        }
        # Open-bracket depth of s: `(` and `[` always, `<` and `>` too when angles is
        # set (a `>` straight after `-` is an arrow, not a closer).
        function bdepth(s, angles,    i, n, ch, dd) {
            dd = 0; n = length(s)
            for (i = 1; i <= n; i++) {
                ch = substr(s, i, 1)
                if (ch == "(" || ch == "[") dd++
                else if (ch == ")" || ch == "]") dd--
                else if (angles && ch == "<") dd++
                else if (angles && ch == ">" && !(i > 1 && substr(s, i - 1, 1) == "-")) dd--
            }
            return dd
        }
        # WRAPPED FIELDS. A head is a field whose type text is empty or leaves a `<`,
        # `(` or `[` open (kind f), or any other line that leaves a `(` or `[` open, as
        # a tuple struct wrapped one field per line does (kind t). Following code lines
        # (at most 20) are joined to it until the brackets balance; both rules are then
        # applied to the joined text, and a hit is reported at the head line.
        function start_head(s) {
            if (index(s, ":") > 0 && field_type(s) && \
                (FT ~ /^[[:space:]]*$/ || bdepth(FT, 1) > 0)) pk = "f"
            else if ((index(s, "(") > 0 || index(s, "[") > 0) && bdepth(s, 0) > 0) pk = "t"
            else return
            pend = 1; pl = FNR; praw = $0; ptxt = s; pn = 0
        }
        function join_line(s) {
            ptxt = ptxt " " s; pn++
            if (pn >= 20) { finish_head(); return }
            if (pk == "f") {
                if (field_type(ptxt) && FT !~ /^[[:space:]]*$/ && bdepth(FT, 1) <= 0) finish_head()
            } else if (bdepth(ptxt, 0) <= 0) finish_head()
        }
        function finish_head() {
            pend = 0
            if (index(ptxt, "size") == 0) return
            if (!line_hit(ptxt)) return
            print F ":" pl ":" praw
        }
        FNR==1 { depth = 0; bc = 0; ins = 0; rawh = -1; pend = 0; wh = 0 }
        {
            if (bc == 0 && !ins && index($0, "\"") == 0 && index($0, "'"'"'") == 0 && index($0, "/") == 0)
                code = $0
            else
                code = code_of($0)
            t = code; o = gsub(/\(/, "", t)
            u = code; c = gsub(/\)/, "", u)
            d = o - c
            si = 0
            # WHERE-CLAUSE INTERIOR. A `where` that ends its code line opens a clause
            # whose bound lines (`T: Into<usize>,`) are not fields; they are skipped up
            # to and including the line holding `{`, `}` or `;` that closes it.
            if (wh) {
                si = 1
                if (index(code, "{") > 0 || index(code, "}") > 0 || index(code, ";") > 0) wh = 0
            } else if (code ~ /(^|[^A-Za-z0-9_#])where[[:space:]]*$/) {
                wh = 1
            }
            if (depth > 0) {
                if (depth + d <= 0) { si = 1; depth = 0 }
                else if (ends_sig(code)) depth = 0
                else { si = 1; depth += d }
            } else if (code ~ /(^|[^A-Za-z0-9_])fn[[:space:]]+[A-Za-z_][A-Za-z0-9_]*[[:space:]]*(<.*>)?[[:space:]]*\(/ && d > 0) {
                depth = d
            }
            hit = check(code, si)
            if (pend) join_line(code)
            else if (!si && !hit && !excluded(excl_text(code))) start_head(code)
        }
        END { if (pend) finish_head() }
    ' "$f")"
    if [ -n "$hits" ]; then
        offending="${offending}${offending:+
}${hits}"
    fi
done <<<"$FILE_LIST"

if [ -n "$offending" ]; then
    echo "FAIL: serialized struct field(s) typed as a pointer-width integer (usize/isize):" >&2
    printf '%s\n' "$offending" >&2
    echo >&2
    echo "Pointer-width integers serialize to a DIFFERENT byte width on 32- vs 64-bit" >&2
    echo "targets (postcard width-trap, RESEARCH Pitfall 2), so the same state hashes" >&2
    echo "differently across architectures and breaks cross-platform replay." >&2
    echo "Use a fixed-width integer type (u32 / u64 / i32 / i64) for serialized fields." >&2
    exit 1
fi

echo "OK: ${FILE_COUNT} .rs files scanned, no serialized pointer-width (usize/isize) struct fields in $SRC_DIR."
exit 0
