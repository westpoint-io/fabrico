#!/usr/bin/env bash
#
# Non-vacuity proof for the pointer-width serialized-field guard
# (scripts/check-no-usize-state.sh, DI-1, GATE-04).
#
# Asserts BOTH directions, one NAMED CASE per shape, on the exact shapes the guard
# has got wrong before. A false NEGATIVE on a determinism gate is worse than a false
# positive, so most of the cases below are must-bite cases.
#
# Every case prints one verdict line and the run carries on, so a single run names
# every miss:
#   PROVEN <id>: <what>
#   NOT PROVEN <id>: <reason>
# Exit 0 when every case is proven, 1 when any is not, 2 when the proof could not be
# made at all (a red baseline, a missing gate, a probe path already present).
#
# THE GATE UNDER TEST is `scripts/check-no-usize-state.sh` unless
# USIZE_GATE_UNDER_TEST names another file. That override is how a new case is SEEN
# RED before it is trusted: run this prover against a copy of the gate as it stood
# before the fix, and every new case must come back NOT PROVEN (plan 84-05 keeps that
# output in its evidence).
#
# What each group proves (and only that):
#   - `fnparam` and `field` carry a BYTE-IDENTICAL offending line, exactly
#     `    n: usize,` (four leading spaces). `fnparam` wraps it in a rustfmt-split
#     `fn (...)` signature (must pass, exit 0); `field` wraps it in a `struct { ... }`
#     (must bite, exit 1). A repair keyed on the line's characters (for example
#     "exclude any line ending in a comma") treats them identically and fails here. Do
#     NOT "simplify" the two probe lines apart: their sameness is the point.
#   - `tuple`: an isize tuple-struct field bites.
#   - Comments: `cmtfield`, a real field whose TRAILING comment carries an excluded
#     token (`fn `), still bites (DI-3). `docline` and `inlinecmt`, a whole-line doc
#     comment and a whole-line body comment that mention usize inside parens, never
#     trip (review 260929-p7p WR-01).
#   - Stray parens: `cmtparen`, `docparen`, `charparen`, `strparen`, `mlstr`. A `(` in
#     a comment, doc comment, char literal, string literal or multi-line string on a
#     line that also carries `fn` must NOT hide a real field further down the file
#     (review 260929-p7p CR-01). The guard's fn-parameter exclusion counts parens on
#     code only; these cases go red if it ever counts them on the raw line again.
#   - Field shapes (todo 2026-09-29-usize-gate-uncovered-field-shapes, closed by plan
#     84-05), each a must-bite: `vec`, `option`, `array`, `map_key`, `map_value`,
#     `enum_struct_variant` (a one-line struct variant), `raw_ident` (`r#type`),
#     `block_before` and `block_after` (a block comment on the field's line, the
#     second carrying `fn `), `one_line_struct`.
#   - `string_literal`, a must-pass: `"(u32, usize)"` in a string on a plain statement
#     line inside a fn body. The guard once matched the raw line, so this failed the
#     build. A `let` line would not show it (the `let` exclusion hides it), which is
#     why the probe line is a `println!`.
#   - Wrapped fields, each a must-bite: `wrapped_type` (`pub v:` with `usize,` on the
#     next line) and `wrapped_generic` (`pub v: BTreeMap<` then one type per line).
#   - Where the rule stops, each a must-pass: `path_expr` (`n: usize::MAX,` in a
#     struct literal), `cast` (`n: a as usize,`), `closure` (`.map(|i: usize| ...)`).
#   - Positional fields beyond a bare `usize`, each a must-bite: `tuple_generic`
#     (`pub struct W(Vec<usize>);`), `enum_tuple_generic` (an `A(Vec<usize>),` variant)
#     and `wrapped_tuple` (a tuple struct with one field per line). `wrapped_call`, a
#     must-pass, pins where that stops: a call wrapped one argument per line, one of
#     them `usize::MAX`.
#   - One-line declarations (review 84 WR-01), each a must-bite unless named:
#     `one_line_static_lifetime` (a `&'static str` field beside a `usize` one),
#     `one_line_fn_ptr` (a `fn(u8) -> u8` field beside an `Option<usize>` one),
#     `const_generic_struct` and `const_generic_tuple` (a `<const N: usize>` generic list
#     on a struct with a real pointer-width field). `const_generic_only`, a must-pass,
#     pins that the generic list alone is not a field.
#   - Two items on one line (review 84 iteration 2 WR-02): `two_decls_one_line` (a
#     struct body, then a second struct with the `usize` field) and
#     `tuple_then_decl_one_line` (a tuple struct, then the same), each a must-bite.
#     `decl_then_impl_one_line`, a must-pass, pins that the text after a body is still
#     excluded as a plain line (an `impl` with a `fn ... -> usize` method).
#   - A body closed on the line a new item opens (review 84 iteration 3 WR-01), each a
#     must-bite: `field_then_decl_one_line` (`    pub a: usize, } pub struct B { .. }`),
#     `variant_then_decl_one_line` (`    V(usize), } pub struct C;`),
#     `field_then_impl_one_line` (the field, then `} impl A { fn .. }`, which makes the
#     whole line excluded) and `variant_body_then_variant` (`a: u8 }, W { b: usize } }
#     impl E {`, a variant between two closing braces) and `close_then_variant`
#     (`f: fn(u8) -> u8 }, W(usize),`, a variant after the last close on a line the
#     `fn` excludes). `let_then_close`, a must-pass, pins that the text cut before a `}`
#     is still excluded (`let n: usize = 3; .. }`).
#   - Not measured, each must exit 2 and say NOT MEASURED (review 84 CR-01):
#     `missing_dir`, `empty_dir` and `below_floor` run a copy of the gate whose SRC_DIR
#     line is repointed at a missing, an empty and a one-file directory under a private
#     mktemp scratch. The gate once printed OK with exit 0 over a missing directory.
#   - Where clauses: `where_bound`, a must-pass, is a bound `T: Into<usize>,` on its
#     own line under a `where` that rustfmt put on its own line (a bound, not a
#     field). `where_then_field`, a must-bite, is a struct whose where clause is
#     followed by a real `pub n: usize,` field: the skipped clause ends at its `{`.
# These cases do not prove the guard catches every field shape Rust allows; they pin
# every shape it has been seen to get wrong. The guard scans only
# crates/fabrico-core/src (todo 2026-10-12-usize-gate-stops-at-fabrico-core).
#
# Every must-bite case asserts exit 1 AND that the output names the probe file, so a
# red caused by something else in the tree cannot pass for a bite; after the probe is
# removed the gate must be back at exit 0.
#
# Acceptance is THIS SCRIPT'S EXIT CODE, never a source grep. The guard scans ONLY
# crates/fabrico-core/src, so this script's own body under scripts/ - including the
# usize/isize tokens in the probe heredocs below - is invisible to the guard and
# cannot self-invalidate it (same property the sibling
# scripts/determinism-gate-negative-test.sh relies on).
#
# Probes are throwaway, untracked .rs files written under crates/fabrico-core/src
# with a run-time nonce name (PID + timestamp) so they cannot collide and cargo
# ignores them (orphan modules, never reached by a `mod`). No tracked file is ever
# written. Isolation is scripts/lib/prover-isolation.sh's Shape A
# (`prover_isolate_untracked`): it refuses a probe path that exists or is tracked,
# removes every probe at exit (its EXIT trap is the only one this script has), and
# compares the tracked tree before and after.

set -euo pipefail

# Sourced before any change of directory: the helper records where this script lives.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source-path=SCRIPTDIR source=lib/prover-isolation.sh
. "${SCRIPT_DIR}/lib/prover-isolation.sh"

# Resolve repo root so the script works from any cwd.
REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

GATE_PATH="${USIZE_GATE_UNDER_TEST:-scripts/check-no-usize-state.sh}"
if [ ! -f "$GATE_PATH" ]; then
    echo "FAIL: the gate under test '${GATE_PATH}' is not a file, so the proof could not be made." >&2
    exit 2
fi
GATE=(bash "$GATE_PATH")
SRC_DIR="crates/fabrico-core/src"
NONCE="$$_$(date +%s)"

if [ ! -d "$SRC_DIR" ]; then
    echo "FAIL: ${SRC_DIR} does not exist, so the proof could not be made." >&2
    exit 2
fi

# Every case id, in run order. Each id owns exactly one probe file.
CASE_IDS=(
    fnparam field tuple
    cmtfield docline inlinecmt
    cmtparen docparen charparen strparen mlstr
    vec option array map_key map_value enum_struct_variant raw_ident
    block_before block_after one_line_struct string_literal
    wrapped_type wrapped_generic path_expr cast closure
    tuple_generic enum_tuple_generic wrapped_tuple wrapped_call
    where_bound where_then_field
    one_line_static_lifetime one_line_fn_ptr const_generic_struct const_generic_tuple
    const_generic_only
    two_decls_one_line tuple_then_decl_one_line decl_then_impl_one_line
    field_then_decl_one_line variant_then_decl_one_line field_then_impl_one_line
    variant_body_then_variant close_then_variant let_then_close
)
# Cases that write no probe into the tree (they repoint a copy of the gate at a scratch
# directory instead); counted with CASE_IDS in the final verdict.
NM_CASE_IDS=(missing_dir empty_dir below_floor)

probe_of() {
    printf '%s' "${SRC_DIR}/_prove_usize_${NONCE}_$1.rs"
}

PROBES=()
for id in "${CASE_IDS[@]}"; do
    PROBES+=("$(probe_of "$id")")
done

# Shape A: refuses (exit 2) a probe path that exists or is tracked, removes every probe
# at exit, and compares the tracked tree before and after. Nothing below writes a probe
# until this has run.
prover_isolate_untracked "${PROBES[@]}"

PROVEN_IDS=()
FAILED_IDS=()

# Run the gate and capture its exit code WITHOUT tripping `set -e` (the deliberate
# exit-1 runs are exactly what this script exists to observe).
gate_rc() {
    local rc=0
    "${GATE[@]}" >/dev/null 2>&1 || rc=$?
    printf '%s' "$rc"
}

verdict() {
    local id="$1" reason="$2" what="$3"
    if [ -z "$reason" ]; then
        echo "PROVEN ${id}: ${what}"
        PROVEN_IDS+=("$id")
    else
        echo "NOT PROVEN ${id}: ${reason}"
        FAILED_IDS+=("$id")
    fi
}

# write_probe ID: the probe body comes from stdin.
write_probe() {
    cat >"$(probe_of "$1")"
}

# must_bite ID WHAT: the gate must exit exactly 1 and name the probe; then the probe is
# removed and the gate must be back at exit 0.
must_bite() {
    local id="$1" what="$2" probe rc=0 out reason=""
    probe="$(probe_of "$id")"
    out="$("${GATE[@]}" 2>&1)" || rc=$?
    if [ "$rc" -ne 1 ]; then
        reason="gate exit was ${rc} with the probe present, expected 1 (${what} missed)"
    elif ! printf '%s\n' "$out" | grep -F "$probe" >/dev/null; then
        reason="gate exited 1 but did not name the probe file ${probe} (${what})"
    fi
    rm -f -- "$probe"
    rc="$(gate_rc)"
    if [ -z "$reason" ] && [ "$rc" -ne 0 ]; then
        reason="gate exit was ${rc} after removing the probe, expected 0"
    fi
    verdict "$id" "$reason" "${what}: exit 1, names the probe"
}

# must_pass ID WHAT: the gate must exit 0 with the probe present; then it is removed.
must_pass() {
    local id="$1" what="$2" probe rc reason=""
    probe="$(probe_of "$id")"
    rc="$(gate_rc)"
    if [ "$rc" -ne 0 ]; then
        reason="gate exit was ${rc} with the probe present, expected 0 (false positive on ${what})"
    fi
    rm -f -- "$probe"
    verdict "$id" "$reason" "${what}: exit 0, no false positive"
}

echo "Gate under test: ${GATE_PATH}"
echo
echo "[1/10] BASELINE GREEN: no probe present, the gate must exit 0 ..."
rc="$(gate_rc)"
if [ "$rc" -ne 0 ]; then
    echo "FAIL: baseline gate exit was $rc, expected 0 (a red baseline makes every probe below meaningless)." >&2
    exit 2
fi
echo "      baseline: exit 0"

echo "[2/10] A WRAPPED FN PARAM against a BYTE-IDENTICAL struct field line ..."
write_probe fnparam <<'PROBE_EOF'
//! THROWAWAY probe for scripts/prove-no-usize-state-bites.sh (DI-1 false-positive
//! case). Created and removed by that script. If you see this committed, delete it.
//! A rustfmt-wrapped signature: the offending line below is BYTE-IDENTICAL to the
//! struct-field probe, but here it is a fn PARAMETER and must be excluded.
pub fn probe_accepts_n(
    a: u32,
    n: usize,
) -> bool {
    a as usize == n
}
PROBE_EOF
must_pass fnparam "a rustfmt-wrapped fn param (the DI-1 regression)"

write_probe field <<'PROBE_EOF'
//! THROWAWAY probe for scripts/prove-no-usize-state-bites.sh (band-aid guard).
//! Created and removed by that script. If you see this committed, delete it.
//! The field line below is BYTE-IDENTICAL to the fn-param probe's line, but here it
//! sits inside a struct, so it IS a serialized pointer-width field and must bite.
//! A "exclude any trailing comma" repair would wrongly let this through.
pub struct ProbeSerializedRecord {
    n: usize,
}
PROBE_EOF
must_bite field "a genuine 'n: usize,' struct field (a band-aid repair fails here)"

echo "[3/10] ISIZE TUPLE STRUCT ..."
write_probe tuple <<'PROBE_EOF'
//! THROWAWAY probe for scripts/prove-no-usize-state-bites.sh (isize tuple-struct).
//! Created and removed by that script. If you see this committed, delete it.
pub struct ProbeWrap(pub isize);
PROBE_EOF
must_bite tuple "a 'pub isize' tuple-struct field"

echo "[4/10] COMMENTS: a trailing comment never excuses a real field (DI-3), and a"
echo "      whole-line comment never trips the gate (WR-01) ..."
# A genuine serialized field with a trailing comment that contains excluded keyword
# prose ('fn '). The pre-DI-3 gate filtered the whole line INCLUDING the comment,
# silently dropping this real width-trap field.
write_probe cmtfield <<'PROBE_EOF'
//! THROWAWAY probe for scripts/prove-no-usize-state-bites.sh (DI-3 comment false
//! negative). Created and removed by that script. If you see this committed, delete it.
//! The field's TRAILING comment carries 'fn ' - pre-fix that prose was fed to the
//! benign-form filter and silently dropped the field. It must bite regardless.
pub struct ProbeCommentedField {
    pub cursor: usize, // index of the next item; see fn advance()
}
PROBE_EOF
must_bite cmtfield "a real field with a trailing 'fn ' comment (DI-3)"

# A whole-line doc comment that the tuple rule would match on the raw line
# (`(NodeId, usize)`). It has no code, so it must never be reported (review probe 21).
write_probe docline <<'PROBE_EOF'
//! THROWAWAY probe for scripts/prove-no-usize-state-bites.sh (WR-01 doc comment).
//! Created and removed by that script. If you see this committed, delete it.
/// Returns the pair (NodeId, usize).
pub fn probe_pair() -> (u32, u64) {
    (0, 0)
}
PROBE_EOF
must_pass docline "a '/// Returns the pair (NodeId, usize).' doc comment"

# A whole-line body comment inside a struct, same shape (review probe 22).
write_probe inlinecmt <<'PROBE_EOF'
//! THROWAWAY probe for scripts/prove-no-usize-state-bites.sh (WR-01 inline comment).
//! Created and removed by that script. If you see this committed, delete it.
pub struct ProbeInlineComment {
    // was (u32, usize) before the width fix
    pub pair: (u32, u64),
}
PROBE_EOF
must_pass inlinecmt "a '// was (u32, usize)' comment inside a struct"

echo "[5/10] STRAY PARENS: a '(' outside code on a line with 'fn' must not hide a real"
echo "      field further down the file (CR-01) ..."
# Review probe 24: a body comment with an unbalanced paren and the word fn.
write_probe cmtparen <<'PROBE_EOF'
//! THROWAWAY probe for scripts/prove-no-usize-state-bites.sh (CR-01 comment paren).
//! Created and removed by that script. If you see this committed, delete it.
pub fn probe_tick() -> u32 {
    // the fn below (see admit.rs
    0
}

pub struct ProbeAfterCommentParen {
    pub n: usize,
}
PROBE_EOF
must_bite cmtparen "a field after '// the fn below (see admit.rs'"

# Review probe 20: a doc comment directly above the field, unbalanced paren.
write_probe docparen <<'PROBE_EOF'
//! THROWAWAY probe for scripts/prove-no-usize-state-bites.sh (CR-01 doc paren).
//! Created and removed by that script. If you see this committed, delete it.
pub struct ProbeDocParen {
    /// advanced by fn step (see tick.rs; wraps at the end
    pub cursor: usize,
}
PROBE_EOF
must_bite docparen "a field under a doc comment with 'fn step (see'"

# Review probe 18: a char literal holding an open paren.
write_probe charparen <<'PROBE_EOF'
//! THROWAWAY probe for scripts/prove-no-usize-state-bites.sh (CR-01 char literal).
//! Created and removed by that script. If you see this committed, delete it.
pub fn is_open(c: char) -> bool { c == '(' }

#[derive(Serialize)]
pub struct ProbeAfterCharParen {
    cursor: usize,
}
PROBE_EOF
must_bite charparen "a field after 'fn is_open(c: char) -> bool { c == '(' }'"

# Review probe 19: a string literal holding an open paren.
write_probe strparen <<'PROBE_EOF'
//! THROWAWAY probe for scripts/prove-no-usize-state-bites.sh (CR-01 string literal).
//! Created and removed by that script. If you see this committed, delete it.
pub fn label() -> &'static str { "(none" }

pub struct ProbeAfterStrParen {
    pub n: usize,
}
PROBE_EOF
must_bite strparen "a field after 'fn label() -> &'static str { \"(none\" }'"

# A multi-line string whose body looks like a wrapped signature opener.
write_probe mlstr <<'PROBE_EOF'
//! THROWAWAY probe for scripts/prove-no-usize-state-bites.sh (CR-01 multi-line string).
//! Created and removed by that script. If you see this committed, delete it.
pub const PROBE_HELP: &str = "usage:
    fn probe(
";

pub struct ProbeAfterMultiLineString {
    pub n: usize,
}
PROBE_EOF
must_bite mlstr "a field after a multi-line string holding 'fn probe('"

echo "[6/10] FIELD SHAPES: a pointer-width integer anywhere in a field's type, on any"
echo "      line a field can sit on (todo 2026-09-29, review probes 2 to 23) ..."
write_probe vec <<'PROBE_EOF'
//! THROWAWAY probe for scripts/prove-no-usize-state-bites.sh (Vec wrapper).
//! Created and removed by that script. If you see this committed, delete it.
pub struct ProbeVec {
    pub v: Vec<usize>,
}
PROBE_EOF
must_bite vec "a 'Vec<usize>' field"

write_probe option <<'PROBE_EOF'
//! THROWAWAY probe for scripts/prove-no-usize-state-bites.sh (Option wrapper).
//! Created and removed by that script. If you see this committed, delete it.
pub struct ProbeOption {
    pub v: Option<isize>,
}
PROBE_EOF
must_bite option "an 'Option<isize>' field"

write_probe array <<'PROBE_EOF'
//! THROWAWAY probe for scripts/prove-no-usize-state-bites.sh (array).
//! Created and removed by that script. If you see this committed, delete it.
pub struct ProbeArray {
    pub v: [usize; 4],
}
PROBE_EOF
must_bite array "a '[usize; 4]' field"

write_probe map_key <<'PROBE_EOF'
//! THROWAWAY probe for scripts/prove-no-usize-state-bites.sh (map key).
//! Created and removed by that script. If you see this committed, delete it.
pub struct ProbeMapKey {
    pub v: BTreeMap<usize, u32>,
}
PROBE_EOF
must_bite map_key "a 'BTreeMap<usize, u32>' field"

write_probe map_value <<'PROBE_EOF'
//! THROWAWAY probe for scripts/prove-no-usize-state-bites.sh (map value).
//! Created and removed by that script. If you see this committed, delete it.
pub struct ProbeMapValue {
    pub v: BTreeMap<u32, usize>,
}
PROBE_EOF
must_bite map_value "a 'BTreeMap<u32, usize>' field"

write_probe enum_struct_variant <<'PROBE_EOF'
//! THROWAWAY probe for scripts/prove-no-usize-state-bites.sh (one-line struct variant).
//! Created and removed by that script. If you see this committed, delete it.
pub enum ProbeEnum { V { n: usize }, }
PROBE_EOF
must_bite enum_struct_variant "a one-line 'enum E { V { n: usize }, }'"

write_probe raw_ident <<'PROBE_EOF'
//! THROWAWAY probe for scripts/prove-no-usize-state-bites.sh (raw identifier).
//! Created and removed by that script. If you see this committed, delete it.
pub struct ProbeRawIdent {
    pub r#type: usize,
}
PROBE_EOF
must_bite raw_ident "a 'pub r#type: usize,' field"

write_probe block_before <<'PROBE_EOF'
//! THROWAWAY probe for scripts/prove-no-usize-state-bites.sh (block comment before).
//! Created and removed by that script. If you see this committed, delete it.
pub struct ProbeBlockBefore {
    /* width */ pub n: usize,
}
PROBE_EOF
must_bite block_before "a '/* width */ pub n: usize,' field"

write_probe block_after <<'PROBE_EOF'
//! THROWAWAY probe for scripts/prove-no-usize-state-bites.sh (block comment after).
//! Created and removed by that script. If you see this committed, delete it.
pub struct ProbeBlockAfter {
    pub n: usize, /* see fn advance */
}
PROBE_EOF
must_bite block_after "a 'pub n: usize, /* see fn advance */' field"

write_probe one_line_struct <<'PROBE_EOF'
//! THROWAWAY probe for scripts/prove-no-usize-state-bites.sh (one-line struct).
//! Created and removed by that script. If you see this committed, delete it.
pub struct ProbeOneLine { pub n: usize }
PROBE_EOF
must_bite one_line_struct "a one-line 'pub struct P { pub n: usize }'"

echo "[7/10] STRING LITERAL: a tuple-shaped string on a plain statement line is not a"
echo "      field (review probe 17) ..."
write_probe string_literal <<'PROBE_EOF'
//! THROWAWAY probe for scripts/prove-no-usize-state-bites.sh (string literal).
//! Created and removed by that script. If you see this committed, delete it.
pub fn probe_print() {
    let a = 1;
    println!("(u32, usize)");
    let _ = a;
}
PROBE_EOF
must_pass string_literal "'println!(\"(u32, usize)\");' inside a fn body"

echo "[8/10] WRAPPED AND POSITIONAL FIELDS bite, and the rule stops at paths, casts,"
echo "      closures and calls ..."
write_probe wrapped_type <<'PROBE_EOF'
//! THROWAWAY probe for scripts/prove-no-usize-state-bites.sh (wrapped type).
//! Created and removed by that script. If you see this committed, delete it.
pub struct ProbeWrappedType {
    pub v:
        usize,
}
PROBE_EOF
must_bite wrapped_type "a field whose type sits on the next line ('pub v:' then 'usize,')"

write_probe wrapped_generic <<'PROBE_EOF'
//! THROWAWAY probe for scripts/prove-no-usize-state-bites.sh (wrapped generic).
//! Created and removed by that script. If you see this committed, delete it.
pub struct ProbeWrappedGeneric {
    pub v: BTreeMap<
        usize,
        u32,
    >,
}
PROBE_EOF
must_bite wrapped_generic "a 'BTreeMap<' field with one type per line"

write_probe path_expr <<'PROBE_EOF'
//! THROWAWAY probe for scripts/prove-no-usize-state-bites.sh (path in a struct literal).
//! Created and removed by that script. If you see this committed, delete it.
pub fn probe_limit() -> ProbeLimit {
    ProbeLimit {
        n: usize::MAX,
    }
}
PROBE_EOF
must_pass path_expr "'n: usize::MAX,' in a struct literal"

write_probe cast <<'PROBE_EOF'
//! THROWAWAY probe for scripts/prove-no-usize-state-bites.sh (cast in a struct literal).
//! Created and removed by that script. If you see this committed, delete it.
pub fn probe_cast(a: u32) -> ProbeCast {
    ProbeCast {
        n: a as usize,
    }
}
PROBE_EOF
must_pass cast "'n: a as usize,' in a struct literal"

write_probe closure <<'PROBE_EOF'
//! THROWAWAY probe for scripts/prove-no-usize-state-bites.sh (closure parameter).
//! Created and removed by that script. If you see this committed, delete it.
pub fn probe_count(xs: &[u32]) -> u32 {
    xs.iter()
        .map(|i: usize| i + 1)
        .count() as u32
}
PROBE_EOF
must_pass closure "'.map(|i: usize| i + 1)' on its own line"

write_probe tuple_generic <<'PROBE_EOF'
//! THROWAWAY probe for scripts/prove-no-usize-state-bites.sh (generic tuple field).
//! Created and removed by that script. If you see this committed, delete it.
pub struct ProbeTupleGeneric(Vec<usize>);
PROBE_EOF
must_bite tuple_generic "a 'pub struct W(Vec<usize>);' positional field"

write_probe enum_tuple_generic <<'PROBE_EOF'
//! THROWAWAY probe for scripts/prove-no-usize-state-bites.sh (generic tuple variant).
//! Created and removed by that script. If you see this committed, delete it.
pub enum ProbeEnumTuple {
    A(Vec<usize>),
    B(u32),
}
PROBE_EOF
must_bite enum_tuple_generic "an 'A(Vec<usize>),' enum variant"

write_probe wrapped_tuple <<'PROBE_EOF'
//! THROWAWAY probe for scripts/prove-no-usize-state-bites.sh (wrapped tuple struct).
//! Created and removed by that script. If you see this committed, delete it.
pub struct ProbeWrappedTuple(
    pub u32,
    pub usize,
);
PROBE_EOF
must_bite wrapped_tuple "a tuple struct with 'pub usize,' on its own line"

write_probe wrapped_call <<'PROBE_EOF'
//! THROWAWAY probe for scripts/prove-no-usize-state-bites.sh (wrapped call).
//! Created and removed by that script. If you see this committed, delete it.
pub fn probe_call(a: u32) -> u64 {
    combine(
        a,
        usize::MAX,
    )
}
PROBE_EOF
must_pass wrapped_call "a call wrapped one argument per line holding 'usize::MAX,'"

write_probe where_bound <<'PROBE_EOF'
//! THROWAWAY probe for scripts/prove-no-usize-state-bites.sh (where-clause bound).
//! Created and removed by that script. If you see this committed, delete it.
pub fn probe_widen<T>(x: T) -> u64
where
    T: Into<usize>,
{
    x.into() as u64
}
PROBE_EOF
must_pass where_bound "a 'T: Into<usize>,' bound under a 'where' line"

write_probe where_then_field <<'PROBE_EOF'
//! THROWAWAY probe for scripts/prove-no-usize-state-bites.sh (field after a where clause).
//! Created and removed by that script. If you see this committed, delete it.
pub struct ProbeWhereThenField<T>
where
    T: Clone,
{
    pub t: T,
    pub n: usize,
}
PROBE_EOF
must_bite where_then_field "a 'pub n: usize,' field after a struct's where clause"

# Review 84 WR-01: a line-wide exclusion token on one field of a one-line declaration
# must excuse only that field, never its neighbour.
write_probe one_line_static_lifetime <<'PROBE_EOF'
//! THROWAWAY probe for scripts/prove-no-usize-state-bites.sh (one-line, 'static field).
//! Created and removed by that script. If you see this committed, delete it.
pub struct ProbeStaticLifetime { pub b: &'static str, pub a: usize, }
PROBE_EOF
must_bite one_line_static_lifetime "a one-line struct whose other field is '&'static str'"

write_probe one_line_fn_ptr <<'PROBE_EOF'
//! THROWAWAY probe for scripts/prove-no-usize-state-bites.sh (one-line, fn-pointer field).
//! Created and removed by that script. If you see this committed, delete it.
pub struct ProbeFnPtr { pub a: Option<usize>, pub f: fn(u8) -> u8, }
PROBE_EOF
must_bite one_line_fn_ptr "a one-line struct whose other field is 'fn(u8) -> u8'"

write_probe const_generic_struct <<'PROBE_EOF'
//! THROWAWAY probe for scripts/prove-no-usize-state-bites.sh (const generic, braces).
//! Created and removed by that script. If you see this committed, delete it.
pub struct ProbeConstGeneric<const N: usize> { pub a: usize }
PROBE_EOF
must_bite const_generic_struct "a one-line 'struct A<const N: usize> { pub a: usize }'"

write_probe const_generic_tuple <<'PROBE_EOF'
//! THROWAWAY probe for scripts/prove-no-usize-state-bites.sh (const generic, tuple).
//! Created and removed by that script. If you see this committed, delete it.
pub struct ProbeConstGenericTuple<const N: usize>(pub usize);
PROBE_EOF
must_bite const_generic_tuple "a 'struct W<const N: usize>(pub usize);' tuple struct"

write_probe const_generic_only <<'PROBE_EOF'
//! THROWAWAY probe for scripts/prove-no-usize-state-bites.sh (const generic, no field).
//! Created and removed by that script. If you see this committed, delete it.
pub struct ProbeConstGenericOnly<const N: usize> { pub a: [u8; N] }
PROBE_EOF
must_pass const_generic_only "a const generic 'N: usize' with no pointer-width field"

# Review 84 iteration 2 WR-02: the gate stopped at the first declaration's closing brace
# and never read the rest of the line.
write_probe two_decls_one_line <<'PROBE_EOF'
//! THROWAWAY probe for scripts/prove-no-usize-state-bites.sh (two structs, one line).
//! Created and removed by that script. If you see this committed, delete it.
pub struct ProbeTwoA { pub a: u8 } pub struct ProbeTwoB { pub b: usize }
PROBE_EOF
must_bite two_decls_one_line "a second one-line struct after a first, its field 'pub b: usize'"

write_probe tuple_then_decl_one_line <<'PROBE_EOF'
//! THROWAWAY probe for scripts/prove-no-usize-state-bites.sh (tuple struct, then a struct).
//! Created and removed by that script. If you see this committed, delete it.
pub struct ProbeTupleA(pub u8); pub struct ProbeTupleB { pub b: usize }
PROBE_EOF
must_bite tuple_then_decl_one_line "a one-line struct after a tuple struct, its field 'pub b: usize'"

write_probe decl_then_impl_one_line <<'PROBE_EOF'
//! THROWAWAY probe for scripts/prove-no-usize-state-bites.sh (struct, then impl, one line).
//! Created and removed by that script. If you see this committed, delete it.
pub struct ProbeDeclImpl { pub a: u8 } impl ProbeDeclImpl { pub fn n(&self) -> usize { 0 } }
PROBE_EOF
must_pass decl_then_impl_one_line "an impl with a 'fn n(&self) -> usize' after a one-line struct"

# Review 84 iteration 3 WR-01: the last field of a multi-line body, closed on the same
# line as a new item opens. decl_hit starts reading at the keyword and an `impl` makes
# the whole line excluded, so the field before the `}` was never read.
write_probe field_then_decl_one_line <<'PROBE_EOF'
//! THROWAWAY probe for scripts/prove-no-usize-state-bites.sh (field, close, struct).
//! Created and removed by that script. If you see this committed, delete it.
pub struct ProbeFieldThenDeclA {
    pub a: usize, } pub struct ProbeFieldThenDeclB { pub b: u8 }
PROBE_EOF
must_bite field_then_decl_one_line "a last field 'pub a: usize,' then '} pub struct B { b: u8 }'"

write_probe variant_then_decl_one_line <<'PROBE_EOF'
//! THROWAWAY probe for scripts/prove-no-usize-state-bites.sh (variant, close, struct).
//! Created and removed by that script. If you see this committed, delete it.
pub enum ProbeVariantThenDecl {
    V(usize), } pub struct ProbeVariantThenDeclC;
PROBE_EOF
must_bite variant_then_decl_one_line "a last variant 'V(usize),' then '} pub struct C;'"

write_probe field_then_impl_one_line <<'PROBE_EOF'
//! THROWAWAY probe for scripts/prove-no-usize-state-bites.sh (field, close, impl).
//! Created and removed by that script. If you see this committed, delete it.
pub struct ProbeFieldThenImpl {
    pub a: usize, } impl ProbeFieldThenImpl { pub fn n(&self) -> u8 { 0 } }
PROBE_EOF
must_bite field_then_impl_one_line "a last field 'pub a: usize,' then '} impl A { fn ... }'"

write_probe variant_body_then_variant <<'PROBE_EOF'
//! THROWAWAY probe for scripts/prove-no-usize-state-bites.sh (two closes, one line).
//! Created and removed by that script. If you see this committed, delete it.
pub enum ProbeVariantBody {
    V {
        a: u8 }, W { b: usize } } impl ProbeVariantBody { pub fn f() {} }
PROBE_EOF
must_bite variant_body_then_variant "'a: u8 }, W { b: usize } } impl E {': a variant between two closing braces"

write_probe close_then_variant <<'PROBE_EOF'
//! THROWAWAY probe for scripts/prove-no-usize-state-bites.sh (a variant after a close).
//! Created and removed by that script. If you see this committed, delete it.
pub enum ProbeCloseThenVariant {
    V {
        f: fn(u8) -> u8 }, W(usize),
}
PROBE_EOF
must_bite close_then_variant "'f: fn(u8) -> u8 }, W(usize),': a variant after the close, on a line 'fn' excludes"

write_probe let_then_close <<'PROBE_EOF'
//! THROWAWAY probe for scripts/prove-no-usize-state-bites.sh (a let before a close).
//! Created and removed by that script. If you see this committed, delete it.
pub fn probe_let_then_close() -> u8 {
    let n: usize = 3; n as u8 }
PROBE_EOF
must_pass let_then_close "'let n: usize = 3; n as u8 }': the text cut before a '}' is still excluded"

echo "[9/10] NOT MEASURED: a source directory that is missing, empty or nearly empty is"
echo "      exit 2, never OK (review 84 CR-01) ..."
# A copy of the gate under test with only its SRC_DIR line repointed at a directory under
# a private mktemp scratch, outside the checkout, so nothing in the tree is written. If
# the copy cannot be repointed (the gate under test has no such line), every case below
# is NOT PROVEN rather than silently skipped.
NM_SCRATCH=""
nm_cleanup() {
    if [ -n "$NM_SCRATCH" ]; then rm -rf -- "$NM_SCRATCH"; fi
}
prover_on_exit nm_cleanup
if ! NM_SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/fabrico-usize-nm.XXXXXX")"; then
    echo "FAIL: mktemp failed, so the NOT MEASURED cases could not be made." >&2
    exit 2
fi
mkdir -p "${NM_SCRATCH}/empty" "${NM_SCRATCH}/few"
printf '%s\n' '//! one clean file, far below the floor' 'pub struct Few { pub n: u32 }' \
    >"${NM_SCRATCH}/few/lib.rs"

# not_measured ID DIR WHAT: the repointed gate must exit exactly 2 and say NOT MEASURED.
not_measured() {
    local id="$1" dir="$2" what="$3" copy rc=0 out reason=""
    copy="${NM_SCRATCH}/gate_${id}.sh"
    sed "s#^SRC_DIR=\"crates/fabrico-core/src\"\$#SRC_DIR=\"${dir}\"#" "$GATE_PATH" >"$copy"
    if ! grep -qxF "SRC_DIR=\"${dir}\"" "$copy"; then
        verdict "$id" "the gate under test has no 'SRC_DIR=\"crates/fabrico-core/src\"' line to repoint" "$what"
        return 0
    fi
    out="$(bash "$copy" 2>&1)" || rc=$?
    if [ "$rc" -ne 2 ]; then
        reason="gate exit was ${rc} over ${what}, expected 2 (output: $(printf '%s' "$out" | tr '\n' ' '))"
    elif ! printf '%s\n' "$out" | grep -F "NOT MEASURED" >/dev/null; then
        reason="gate exited 2 over ${what} but did not say NOT MEASURED"
    fi
    verdict "$id" "$reason" "${what}: exit 2, NOT MEASURED"
}
not_measured missing_dir "${NM_SCRATCH}/absent" "a source directory that does not exist"
not_measured empty_dir "${NM_SCRATCH}/empty" "an empty source directory"
not_measured below_floor "${NM_SCRATCH}/few" "a source directory holding one .rs file"

echo "[10/10] CLEAN REVERT: the working tree must carry no probe residue from this run ..."
residue="$(find "$SRC_DIR" -type f -name "_prove_usize_${NONCE}_*.rs" 2>/dev/null || true)"
residue_ok=1
if [ -n "$residue" ]; then
    echo "FAIL: probe residue left in the tree: $residue" >&2
    residue_ok=0
else
    echo "      no residue"
fi

# --- Tracked files untouched --------------------------------------------------------
# Checked by the isolation helper's EXIT trap, after this script's verdict: a changed
# tracked status, index or already-dirty file turns the exit 0 below into 1 and names it.

echo
if [ "${#FAILED_IDS[@]}" -ne 0 ] || [ "$residue_ok" -ne 1 ]; then
    echo "FAIL: ${#FAILED_IDS[@]} of $((${#CASE_IDS[@]} + ${#NM_CASE_IDS[@]})) cases not proven against ${GATE_PATH}:" \
        ${FAILED_IDS[@]+"${FAILED_IDS[@]}"} >&2
    exit 1
fi

echo "ALL ${#PROVEN_IDS[@]} CASES PROVEN against ${GATE_PATH}: every field shape listed bites"
echo "by name, every boundary case passes, and the tree carries no probe."
exit 0
