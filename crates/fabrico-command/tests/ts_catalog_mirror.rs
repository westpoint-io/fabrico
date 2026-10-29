//! Phase 65-05 (ROUTE-02) - the CROSS-LANGUAGE catalog mirror lock.
//!
//! # What this file is for
//! `frontend/src/protocol/decode.ts` holds `MACHINE_CATALOG`, a HAND-MAINTAINED mirror
//! of `fabrico_command::port_catalog`. Its own docblock records what that cost, in this
//! repository, in words worth repeating: when 63-07 widened the Router's `Role::Out`
//! arity, EVERY Rust test stayed green while that table went on telling the placement
//! ghost a Router has one output. It was corrected by hand, after the fact, by a human
//! who happened to look. Nothing in the workspace could see the two languages disagree,
//! because every check lived on one side of the boundary and sampled its own side.
//!
//! This is that check. It embeds the frontend module at COMPILE time and asserts the
//! Router entry's declared profile EQUALS the Rust catalog's, value by value. It would
//! have caught 63-07's drift on the commit that introduced it.
//!
//! # Why it panics instead of skipping
//! Every extraction step here panics with a message naming the anchor it could not
//! find. An extractor that returned an empty set and let the assertions pass over it
//! would be a green that measured nothing, which is the exact failure shape this
//! project has now hit repeatedly. The `include_str!` + named-anchor + panic-on-miss
//! discipline is lifted verbatim from `fabrico-host/tests/refusal_copy_truth.rs`.
//!
//! # The half-blindness this file shipped with, and what closed it (65 review, CR)
//! The rule above was stated from the first commit and the extractor still broke it, in
//! the one place nobody looked: a `cp(..)` ROW it could not read was not a panic and was
//! not an empty set. It was a `continue`. The row left the comparison set and the four
//! equalities below went on comparing the rows that happened to parse.
//!
//! That was PROVED, not argued: appending `cp(4, 1, 3, CAT_E, CAT_OUT), // widened` to
//! the shipped Router entry - a fourth Out against a `ROUTER_OUT_ARITY` of 3, the exact
//! 63-07 drift this file exists to catch - left all 8 tests GREEN, because the trailing
//! comment defeated the `strip_suffix("),")` the row walk demanded. UNDER-declaration
//! bit; OVER-declaration did not, and 65's own mutation proof only ever deleted a row.
//!
//! Three things changed. `entry_body` is bounded by BRACKET DEPTH rather than by the
//! literal line `"\n  },"` (that bound was simply wrong for the five entries written on
//! one line, and ran `SOURCE` straight into `FACTORY`). The port array is split into its
//! ELEMENTS, a measure that does not depend on recognising `cp(` at all, and EVERY
//! element must parse or the extractor panics naming it. And the rows found inside
//! `ports: [ ... ]` are counted against the `cp(` rows in the whole entry body, so a row
//! that escapes the array cannot go unseen either. A row can now leave the comparison
//! set by exactly one route: being deleted from `decode.ts`.
//!
//! # Every catalog kind is mirrored (plan 85-02, D-21, GATE-06)
//! Until plan 85-02 four entries had their own comparisons here: ROUTER (65-05,
//! ROUTE-02), ENDPOINT (66-03, WIRE-03), SINK (71-review IN-02 - PILE-10 gave it a
//! `Role::Fault` nub whose SIDE decides where a user can dock a fault belt, and only a
//! count was watching that row) and HANDLER (72-05, SERVE-03), with LABEL's portless row
//! added in phase 76; SOURCE, FACTORY, TEE, BALANCER and MERGE were hand-kept with nothing
//! comparing them (WINDOWS row 63). Those per-kind tests stay. Beside them, two tests now
//! cover the whole table, and their subject list is not written in this file: it is every
//! byte 0 to 255 for which `fabrico_command::kind_has_catalog_arm` answers true, minus
//! BELT (not placeable, no frontend row by design).
//!
//! - `every_catalog_kind_has_a_frontend_row_and_no_other_kind_does`: the keys of the
//!   frontend `MACHINE_CATALOG` equal that Rust set in both directions, every byte
//!   classified, a missing row and a row for an unknown kind each named, and an empty
//!   table a failure rather than a pass.
//! - `every_frontend_catalog_row_mirrors_rust_port_for_port`: for every kind in that set
//!   but LABEL (whose empty port array keeps its own test, because `entry_ports` panics on
//!   an empty array by design), the `kind:` field, the box and every port compared with
//!   `catalog_entry(kind)` port for port in index order, medium included, as exact
//!   integers, counting the kinds it checked (9) so it cannot pass over fewer.
//!
//! Four mutation legs hold that each check bites, naming the kind: a table missing
//! FACTORY's row, one with an extra `[200]` row, TEE with two ports swapped, BALANCER
//! with one medium flipped; a fifth holds that an empty table fails.
//!
//! What it still does NOT hold: the palette Router's preset port count (that leg lands
//! with the Router fault port in plan 85-05, D-22), and anything the frontend computes
//! from these rows after reading them.
//!
//! # THE MEDIUM IS MIRRORED, ON ALL FOUR ENTRIES (72-05). WHAT THIS SECTION USED TO SAY.
//! Until plan 72-05 this section was headed with the opposite claim, that the medium was
//! not mirrored and that this mattered most for ENDPOINT, and it said, in terms: `decode.ts`'s `cp()` helper takes
//! `(index, local_x, local_y, side, role)` and carries NO medium at all, the TS
//! `CatalogPortView` has no such field, every equality below therefore compares box plus
//! index/local_x/local_y/side/role, and NOTHING here can see a `Medium` drift. It ended
//! by forbidding anyone to cite the green below as proof that the two languages agree
//! about medium.
//!
//! THAT SENTENCE IS REMOVED BECAUSE IT STOPPED BEING TRUE, NOT BECAUSE IT WAS
//! INCONVENIENT. `cp()` now takes a sixth argument, the TS `CatalogPortView` carries a
//! `medium` field, `parse_port` resolves it through `ts_const` like the side and role
//! bytes, and all four port-for-port equalities compare it. A green below IS now a
//! statement that the two languages agree about medium on the four mirrored entries.
//!
//! # The file's own criterion was met, and recording that is the point
//! The old section did not merely note the gap; it stated exactly when the gap would
//! become a defect: "the moment anything in the frontend branches on medium, this gap is
//! real and needs a different check". `72-UI-SPEC` 1.2 gives an electrical port a SQUARE
//! nub, so `drawRoleNub` and `PortIndicator` branch on medium in plan 72-09. The rule the
//! file wrote for itself fired, on schedule, and was acted on. A later reader inheriting
//! a similar gap elsewhere should note that this is what a dated, falsifiable
//! self-criterion buys over a TODO.
//!
//! # Why HANDLER is the entry that made it unavoidable
//! Both ENDPOINT ports are `Medium::Electrical` in Rust, and the old section named
//! ENDPOINT as the entry the gap mattered most for. HANDLER is worse. A Handler stands on
//! the FACTORY's chassis - same 3x3 box, same three `local_offset` values, same sides,
//! same roles, copied verbatim (`71-UI-SPEC` R-21) - so with the medium out of the
//! comparison a HANDLER row and a FACTORY row are INDISTINGUISHABLE. The mirror would
//! have reported a green over a frontend Handler that declared a mechanical In at index
//! 0, which is the port `step_factory` drains and whose declared medium is the entire
//! D-16 discriminator; every request would have been stranded on a board that looked
//! correct in both languages.
//!
//! # THE MEDIUM PROOFS, RE-RUN AT 72-05 AND NOT INHERITED
//! Adding an argument to `cp()` changes what the element parser must ACCEPT, and this
//! file's recorded near-miss is precisely a parser that silently `continue`d past a row
//! it could not read. So the proof was RE-RUN against the shipped `decode.ts` after the
//! widening, three mutations, each reverted and `git diff --quiet` verified. OBSERVED,
//! verbatim:
//!
//!   MUTATION (a) UNDER-declaration. Delete `cp(1, 2, 1, CAT_E, CAT_OUT, CAT_ELEC),` from
//!   the HANDLER entry. TWO tests reddened, 23 passed / 2 failed:
//!     `the frontend Handler declares 0 Out(s) and the Rust catalog 1; both must be
//!      exactly ONE (D-02). [..]  left: (0, 1)  right: (1, 1)`
//!     `the frontend Handler entry and the Rust catalog disagree port for port,
//!      INCLUDING the medium byte [..]
//!       left: [TsPort { index: 0, .. }, TsPort { index: 2, .. }]
//!      right: [TsPort { index: 0, .. }, TsPort { index: 1, local_x: 2, local_y: 1,
//!              side: 1, role: 1, medium: 1 }, TsPort { index: 2, .. }]`
//!
//!   MUTATION (b) OVER-declaration, the class that was GREEN before the 65-review
//!   rewrite. Append `cp(3, 2, 0, CAT_E, CAT_OUT, CAT_ELEC),` to the HANDLER entry. The
//!   same two tests reddened, 23 passed / 2 failed:
//!     `the frontend Handler declares 2 Out(s) and the Rust catalog 1 [..]
//!       left: (2, 1)  right: (1, 1)`
//!     `[..] left: [.., TsPort { index: 3, local_x: 2, local_y: 0, side: 1, role: 1,
//!              medium: 1 }]  right: [.. three rows ..]`
//!
//!   MUTATION (c) THE MEDIUM ITSELF, and the proof this task exists for. Flip HANDLER's
//!   port 0 from `CAT_ELEC` to `CAT_MECH` - a change NO count, side, role, offset or box
//!   assertion in this file can see. 23 passed / 2 failed:
//!     `the frontend Handler's port 0 must be ELECTRICAL. It is the port `step_factory`
//!      drains, and since plan 72-03 its declared medium is the ENTIRE discriminator
//!      between a mechanical Factory and an electrical Handler [..]
//!       left: Some(0)  right: Some(1)`
//!     `the frontend Handler entry and the Rust catalog disagree port for port,
//!      INCLUDING the medium byte [..]
//!       left: [TsPort { index: 0, .., medium: 0 }, ..]
//!      right: [TsPort { index: 0, .., medium: 1 }, ..]`
//!
//!   And the same field flipped on the ENDPOINT entry, the row the OLD section named by
//!   name as the one it could not watch. `CAT_ELEC` -> `CAT_MECH` on ENDPOINT's port 0,
//!   24 passed / 1 failed:
//!     `the frontend Endpoint entry and the Rust catalog disagree port for port,
//!      INCLUDING the medium byte
//!       left: [TsPort { index: 0, .., medium: 0 }, TsPort { index: 1, .., medium: 1 }]
//!      right: [TsPort { index: 0, .., medium: 1 }, TsPort { index: 1, .., medium: 1 }]`
//!
//! The extractor's own arity check moved from 5 to `PORT_CALL_ARGS`, and the eight
//! synthetic silent-skip fixtures below were widened with it. That was not cosmetic
//! either: before they were widened they FAILED, loudly, naming the row and its argument
//! count - which is the panic-on-miss discipline holding through the very change most
//! likely to break it.
//!
//! Run target: `cargo test -p fabrico-command --test ts_catalog_mirror`

use fabrico_command::{ROUTER_OUT_ARITY, catalog_entry, kind_has_catalog_arm};
use fabrico_protocol::{machine_kind, port_medium, port_role};

/// `decode.ts` embedded at COMPILE time - a moved or renamed file is a compile error in
/// this crate, never a test that quietly stops finding anything to check.
const DECODE_TS: &str = include_str!("../../../frontend/src/protocol/decode.ts");

/// The TypeScript declaration this file parses, named so a failure can quote the exact
/// anchor that went missing.
const ROUTER_ANCHOR: &str = "[machine_kind.ROUTER]: {";

/// The second mirrored declaration (66-03, WIRE-03). Written here as the exact string so
/// a later reader can find the cross-language coupling by grepping either file for it.
///
/// UNLIKE `ROUTER_ANCHOR` this one introduces a SINGLE-LINE entry, which is the input
/// class `entry_body` used to get wrong (see its docblock): the old line-bounded version
/// ran a one-line entry straight into the next one, and nothing noticed because only the
/// multi-line ROUTER entry was ever extracted. The brace-depth bound is what makes this
/// anchor safe, and `the_frontend_endpoint_entry_declares_exactly_two_port_rows` exists
/// to prove the bound actually held on this row rather than assuming it.
const ENDPOINT_ANCHOR: &str = "[machine_kind.ENDPOINT]: {";

/// The SINK entry's anchor. Also a SINGLE-LINE entry, and unlike `ENDPOINT_ANCHOR` it
/// has a neighbour after it, which is what makes it the subject
/// `a_single_line_entry_is_bounded_at_its_own_brace_and_not_the_next_ones` already
/// fails on. Named here (71-review IN-02) so the port-for-port comparator can be
/// pointed at it too: a COUNT equality passes a SINK row whose fault nub sits on the
/// wrong side or carries the wrong role.
const SINK_ANCHOR: &str = "[machine_kind.SINK]: {";

/// The declaration that opens an entry's port list.
const PORTS_ANCHOR: &str = "ports: [";

/// The port-constructor call every catalog row is written as.
const PORT_CALL: &str = "cp(";

/// How many arguments `cp()` takes in the shipped `decode.ts`. It was 5 until 72-05
/// appended the medium. Spelled once, so the arity check below and the argument indices
/// in `parse_port` cannot drift apart.
const PORT_CALL_ARGS: usize = 6;

/// The HANDLER entry's anchor (72-05, SERVE-03). The FOURTH mirrored entry, and the one
/// this file's medium widening exists for: a Handler is a Factory chassis whose port 0
/// carries `Medium::Electrical`, so the medium is the ONLY field that distinguishes the
/// two catalog rows from one another. A mirror blind to it would have compared a Handler
/// against a Factory and reported them equal.
const HANDLER_ANCHOR: &str = "[machine_kind.HANDLER]: {";

/// One port row parsed out of a `MACHINE_CATALOG` entry: the `cp(...)` argument tuple,
/// with the `side`/`role` NAMES already resolved to their declared numeric values.
#[derive(Debug, PartialEq, Eq)]
struct TsPort {
    index: u16,
    local_x: i32,
    local_y: i32,
    side: u8,
    role: u8,
    /// The transport medium byte (`Mechanical=0, Electrical=1`), added in 72-05. See
    /// the module header's medium section: this is the field the file shipped unable
    /// to see, and it is the one field that separates a Factory from a Handler.
    medium: u8,
}

/// The `n` in a `const {name} = n;` declaration in `source`.
///
/// PANICS when the constant is absent. The role and side bytes are read from the
/// frontend's own declarations rather than written down here, so a renumbering of
/// `CAT_OUT` is visible to this file instead of being silently absorbed by a Rust-side
/// copy of the same number.
fn ts_const(source: &str, name: &str) -> i64 {
    let needle = format!("const {name} = ");
    let start = source.find(&needle).unwrap_or_else(|| {
        panic!(
            "frontend/src/protocol/decode.ts no longer declares `const {name} = ...` - the \
             cross-language catalog lock cannot resolve the byte and must not pass silently"
        )
    });
    let rest = &source[start + needle.len()..];
    let end = rest
        .find(';')
        .unwrap_or_else(|| panic!("the `const {name}` declaration in decode.ts is not terminated by `;`"));
    rest[..end].trim().parse::<i64>().unwrap_or_else(|_| {
        panic!("the `const {name}` declaration in decode.ts is not a plain integer literal")
    })
}

/// The body of the `MACHINE_CATALOG` entry introduced by `anchor`, bounded by the brace
/// that closes it.
///
/// # Why depth and not a closing LINE
/// This used to search for the literal line `"\n  },"`. That bound is wrong for a
/// SINGLE-LINE entry, and five of the seven entries in the shipped table are written on
/// one line: for `SOURCE` it ran past the entry entirely and returned `SOURCE` plus all
/// of `FACTORY`. Nothing noticed, because only the multi-line `ROUTER` entry was ever
/// extracted. Counting brackets bounds every entry correctly whatever the formatting,
/// which is what lets the row counts below be trusted at all.
///
/// PANICS on a missing anchor or an entry whose brace never closes, naming the anchor in
/// both cases.
fn entry_body<'a>(source: &'a str, anchor: &str) -> &'a str {
    let start = source.find(anchor).unwrap_or_else(|| {
        panic!(
            "frontend/src/protocol/decode.ts no longer declares {anchor:?} - the cross-language \
             catalog lock cannot see the entry and must not pass silently"
        )
    });
    // `anchor` ends WITH the entry's opening brace, so the body starts just past it and
    // the counter starts already inside one level.
    let body = &source[start + anchor.len()..];
    let mut depth: i32 = 1;
    for (i, c) in body.char_indices() {
        match c {
            '{' | '[' | '(' => depth += 1,
            '}' | ']' | ')' => {
                depth -= 1;
                if depth == 0 {
                    assert_eq!(
                        c, '}',
                        "the {anchor:?} entry in decode.ts closes on {c:?} rather than a brace - \
                         the source is bracket-unbalanced and the extractor must not guess"
                    );
                    return &body[..i];
                }
            }
            _ => {}
        }
    }
    panic!(
        "the {anchor:?} entry in decode.ts is never closed by a matching brace - the extractor \
         cannot bound the entry and must not pass silently"
    )
}

/// The `w`/`h`/`rot` numbers declared on the entry introduced by `anchor`.
///
/// # Why this reads top-level FIELDS and not LINES (66-03)
/// This used to walk `body.lines()` and do `line.trim().strip_prefix("w: ")`, which
/// requires the field to OPEN its own line. That is the same line-shaped assumption
/// `entry_body` was rewritten to drop, left behind in a second function, and it is wrong
/// for exactly the same input class: on a SINGLE-LINE entry every field shares one line
/// with the anchor, so no trimmed line begins with `w: ` and the panic fired on an entry
/// that plainly declares one. It was never noticed because `entry_box` had only ever
/// been pointed at the multi-line ROUTER entry - and it was found by pointing it at the
/// single-line ENDPOINT row, which reddened with `declares no \`w:\` field`.
///
/// The body is now split into its top-level comma-separated fields by BRACKET DEPTH,
/// which is the same measure the port-row walk uses and is independent of formatting.
///
/// PANICS when any of the three fields is absent.
fn entry_box(source: &str, anchor: &str) -> (u16, u16, u8) {
    let body = strip_line_comments(entry_body(source, anchor));
    let fields = top_level_elements(&body, anchor);
    let field = |name: &str| -> i64 {
        let needle = format!("{name}:");
        for element in &fields {
            let element = element.trim();
            if let Some(rest) = element.strip_prefix(&needle)
                && let Ok(n) = rest.trim().parse::<i64>()
            {
                return n;
            }
        }
        panic!(
            "the {anchor:?} entry in decode.ts declares no `{name}:` field - the box-equality \
             assertion cannot be made and must not pass silently"
        )
    };
    (
        u16::try_from(field("w")).expect("a catalog width fits a u16"),
        u16::try_from(field("h")).expect("a catalog height fits a u16"),
        u8::try_from(field("rot")).expect("a catalog rot fits a u8"),
    )
}

/// `text` with every `//`-to-end-of-line comment removed.
///
/// Comments are STRIPPED rather than skipped-over, because the difference between the
/// two is the whole defect this extractor was rewritten to close (see `entry_ports`).
/// Safe on this input by inspection: a `MACHINE_CATALOG` port array contains only
/// integers, identifiers, commas and brackets - never a string literal, so there is no
/// `//` that is not a comment.
fn strip_line_comments(text: &str) -> String {
    text.lines()
        .map(|line| match line.find("//") {
            Some(at) => &line[..at],
            None => line,
        })
        .collect::<Vec<&str>>()
        .join("\n")
}

/// The text INSIDE the `ports: [ ... ]` array of the entry introduced by `anchor`,
/// comment-stripped, found by BRACKET DEPTH rather than by line.
///
/// PANICS when the entry declares no `ports: [` array at all, and when that array is
/// never closed. Either would otherwise leave the extractor with nothing to read while
/// the entry plainly declares ports.
fn ports_array(source: &str, anchor: &str) -> String {
    let body = entry_body(source, anchor);
    let open = body.find(PORTS_ANCHOR).unwrap_or_else(|| {
        panic!(
            "the {anchor:?} entry in decode.ts declares no {PORTS_ANCHOR:?} array - the extractor \
             has nothing to read and must not report a green over an entry it could not find the \
             ports of"
        )
    });
    let after = &body[open + PORTS_ANCHOR.len()..];
    let mut depth: i32 = 0;
    for (i, c) in after.char_indices() {
        match c {
            '(' | '[' | '{' => depth += 1,
            ')' | '}' => depth -= 1,
            ']' if depth == 0 => return strip_line_comments(&after[..i]),
            ']' => depth -= 1,
            _ => {}
        }
        assert!(
            depth >= 0,
            "the {anchor:?} entry's ports array in decode.ts closes a bracket it never opened - \
             the extractor cannot bound the array and must not pass silently"
        );
    }
    panic!(
        "the {anchor:?} entry's ports array in decode.ts is never closed by `]` - the extractor \
         cannot bound the array and must not pass silently"
    )
}

/// `text` split on the commas at bracket depth 0 - the ELEMENTS of an array literal (or,
/// since 66-03, the top-level FIELDS of an entry body), whatever each one is written as.
///
/// This measure is deliberately INDEPENDENT of `cp(`: it counts what the array declares,
/// not what the extractor happens to recognise. A row written as anything other than a
/// `cp(..)` call still arrives here as an element, and `parse_port` then fails on it
/// LOUDLY instead of it vanishing.
///
/// The single trailing element after a trailing comma is blank and is dropped. A blank
/// element ANYWHERE else PANICS: it means the split disagrees with the source and the
/// row count can no longer be trusted.
fn top_level_elements(text: &str, anchor: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut depth: i32 = 0;
    let mut start = 0usize;
    for (i, c) in text.char_indices() {
        match c {
            '(' | '[' | '{' => depth += 1,
            ')' | ']' | '}' => depth -= 1,
            ',' if depth == 0 => {
                out.push(text[start..i].to_string());
                start = i + c.len_utf8();
            }
            _ => {}
        }
        assert!(
            depth >= 0,
            "a comma-separated list in the {anchor:?} entry of decode.ts is bracket-unbalanced \
             - the element split cannot be trusted and must not pass silently"
        );
    }
    out.push(text[start..].to_string());
    let last = out.len() - 1;
    for (i, element) in out.iter().enumerate() {
        assert!(
            !element.trim().is_empty() || i == last,
            "a comma-separated list in the {anchor:?} entry of decode.ts has an EMPTY element at \
             position {i} of {last} - only the text after a trailing comma may be blank, so the \
             element split disagrees with the source and the count cannot be trusted"
        );
    }
    out.retain(|element| !element.trim().is_empty());
    out
}

/// One `cp(index, local_x, local_y, SIDE, ROLE)` element, parsed.
///
/// PANICS on ANY element it cannot read, naming the element. That panic is the entire
/// point of this function: see `entry_ports`.
fn parse_port(element: &str, source: &str, anchor: &str) -> TsPort {
    let trimmed = element.trim();
    let args = trimmed
        .strip_prefix(PORT_CALL)
        .and_then(|rest| rest.strip_suffix(')'))
        .unwrap_or_else(|| {
            panic!(
                "a port row in the {anchor:?} entry of decode.ts is not a {PORT_CALL:?} call this \
                 extractor can read: {trimmed:?}. A row it cannot read must be a LOUD failure and \
                 never a silent skip - a skipped row vanishes from the comparison set entirely, so \
                 the mirror would report a green over only the rows it happened to understand"
            )
        });
    let args: Vec<&str> = args.split(',').map(str::trim).collect();
    assert_eq!(
        args.len(),
        PORT_CALL_ARGS,
        "a cp(..) row in the {anchor:?} entry has {} arguments, not the {PORT_CALL_ARGS} the \
         helper takes: {trimmed:?}",
        args.len(),
    );
    let num = |a: &str| -> i64 {
        a.parse::<i64>()
            .unwrap_or_else(|_| panic!("a cp(..) coordinate argument is not an integer: {a:?}"))
    };
    TsPort {
        index: u16::try_from(num(args[0])).expect("a port index fits a u16"),
        local_x: i32::try_from(num(args[1])).expect("a local x fits an i32"),
        local_y: i32::try_from(num(args[2])).expect("a local y fits an i32"),
        side: u8::try_from(ts_const(source, args[3])).expect("a side byte fits a u8"),
        role: u8::try_from(ts_const(source, args[4])).expect("a role byte fits a u8"),
        // Resolved through `ts_const` like the side and role bytes, NOT written as a
        // number here: a renumbering of `CAT_ELEC` in the frontend is then visible to
        // this file instead of being absorbed by a Rust-side copy of the same value.
        medium: u8::try_from(ts_const(source, args[5])).expect("a medium byte fits a u8"),
    }
}

/// Every `cp(index, local_x, local_y, SIDE, ROLE)` row in the entry introduced by
/// `anchor`, in declaration order.
///
/// # Why this reads ELEMENTS and not LINES (the 65-review CR fix)
/// The first version of this function walked `body.lines()` and did
/// `line.strip_prefix("cp(")` then `rest.strip_suffix("),")`, CONTINUING past any line
/// that failed either. Both `continue`s were silent, so a row the extractor could not
/// read did not fail - it VANISHED from the comparison set, and every assertion below
/// then compared the rows it happened to understand and reported a green.
///
/// That made this file the eighth check in this repository structurally unable to see
/// what it guards, and it was PROVED so rather than argued: appending
/// `cp(4, 1, 3, CAT_E, CAT_OUT), // widened` to the shipped Router entry - a fourth Out
/// against a `ROUTER_OUT_ARITY` of 3, the exact 63-07 drift this file exists to catch -
/// left all 8 tests green, because the trailing comment defeated `strip_suffix("),")`.
/// The row was dropped and the arity assertion counted 3 of 4. Phase 65's own mutation
/// proof deleted a row instead, which reddens, and so the half-blindness survived:
/// UNDER-declaration bit, OVER-declaration did not.
///
/// The rule this function now keeps: A ROW THE EXTRACTOR CANNOT READ IS A FAILURE,
/// NEVER A SKIP. The array is split into its elements by bracket depth (a measure
/// independent of `cp(` entirely), every element must parse, and the parsed count is
/// cross-checked against a raw count of `cp(` occurrences taken a third way. A row can
/// no longer leave the set by any route except being deleted from the source.
///
/// PANICS when the entry declares ZERO port rows. An extractor that returned an empty
/// vector here would make every count assertion below pass over nothing, which is the
/// same vacuous-green shape by a different door.
fn entry_ports(source: &str, anchor: &str) -> Vec<TsPort> {
    let array = ports_array(source, anchor);
    let elements = top_level_elements(&array, anchor);
    let declared = elements.len();
    let ports: Vec<TsPort> = elements
        .iter()
        .map(|element| parse_port(element, source, anchor))
        .collect();
    // Holds BY CONSTRUCTION today, because `parse_port` panics rather than returning an
    // Option and the map is 1:1. It is asserted anyway as the tripwire for the specific
    // regression this rewrite undoes: the moment anyone reintroduces a `filter_map` /
    // `flat_map` / `else { continue }` here, the counts part and this reddens rather
    // than the file going quietly half-blind again.
    assert_eq!(
        ports.len(),
        declared,
        "the {anchor:?} entry declares {declared} port element(s) and the extractor produced \
         {} - a declared row was DROPPED, which is the vacuous-green shape this file exists to end",
        ports.len(),
    );
    // The REACHABLE cross-check, and the last silent-drop route left open. Everything
    // above is bounded by `ports: [ ... ]`, so a `cp(..)` row that ends up OUTSIDE that
    // array - most plausibly because the array closed early on a stray `]`, or because a
    // reformat moved a row past it - is invisible to the element walk and would drop out
    // of the comparison set exactly as the old line walk let rows drop. Counting the
    // `cp(` occurrences across the WHOLE comment-stripped entry body is a measure that
    // does not depend on the array bounds at all, so the two part when a row escapes.
    let raw_calls = strip_line_comments(entry_body(source, anchor))
        .matches(PORT_CALL)
        .count();
    assert_eq!(
        ports.len(),
        raw_calls,
        "the {anchor:?} entry declares {raw_calls} {PORT_CALL:?} row(s) but only {} of them are \
         inside its {PORTS_ANCHOR:?} array - a row outside the array is invisible to the mirror \
         and must not be dropped silently",
        ports.len(),
    );
    assert!(
        !ports.is_empty(),
        "the {anchor:?} entry in decode.ts declares ZERO cp(..) port rows - the extractor found \
         nothing to compare and must not report a green over an empty set"
    );
    ports
}

/// The Router entry's port rows, from the shipped frontend source.
fn router_ports() -> Vec<TsPort> {
    entry_ports(DECODE_TS, ROUTER_ANCHOR)
}

/// The Endpoint entry's port rows, from the shipped frontend source.
fn endpoint_ports() -> Vec<TsPort> {
    entry_ports(DECODE_TS, ENDPOINT_ANCHOR)
}

/// The Sink entry's port rows, from the shipped frontend source.
fn sink_ports() -> Vec<TsPort> {
    entry_ports(DECODE_TS, SINK_ANCHOR)
}

/// The catalog's rows for `kind`, in the shape the frontend expresses. Since 72-05 that
/// includes the MEDIUM: `cp()` takes it and `CatalogPortView` carries it in both
/// languages, so this projection is now total over the Rust `CatalogPortView` rather than
/// a lossy subset of it.
fn expected_ts_ports(kind: u8) -> Vec<TsPort> {
    catalog_entry(kind)
        .ports
        .iter()
        .map(|p| TsPort {
            index: p.index,
            local_x: p.local_x,
            local_y: p.local_y,
            side: p.side,
            role: p.role,
            medium: p.medium,
        })
        .collect()
}

/// The Handler entry's port rows, from the shipped frontend source.
fn handler_ports() -> Vec<TsPort> {
    entry_ports(DECODE_TS, HANDLER_ANCHOR)
}

// ---------------------------------------------------------------------------
// The equalities. Every one compares a value PARSED from the frontend against a value
// READ from this crate; none compares against a number written here.
//
// MUTATION-PROVED on 2026-08-22 by RUNNING five mutations against the SHIPPED
// `decode.ts` and restoring it byte-identically after each (`git diff --quiet`), not by
// describing them. Phase 65's original proof ran only M2, which is why the file shipped
// half-blind: a DELETED row reddens under both the old extractor and the new one, so it
// could never have exposed the silent skip.
//
//   M1 OVER-declaration. Append `cp(4, 1, 3, CAT_E, CAT_OUT), // widened` - a fourth Out
//      against a `ROUTER_OUT_ARITY` of 3. BEFORE the extractor rewrite this left ALL 8
//      tests GREEN. It now reddens two of them; both messages are below.
//   M2 UNDER-declaration. Delete `cp(3, 1, 1, CAT_E, CAT_OUT),`. Reddens the same two.
//   M3 FIELD mutation. Port 2's side byte `CAT_E` -> `CAT_S`. Reddens the port-for-port
//      test ONLY, which is correct and is the reason that test exists: the Out COUNT is
//      unchanged, so no count assertion can see it.
//   M4 REFORMAT, no semantic change. Collapse the Router ports array onto one line, the
//      shape prettier produces and the shape five of the seven shipped entries already
//      use. Must stay GREEN: 16 passed / 0 failed. The old line-based extractor read
//      ZERO rows from it.
//   M5 REFORMAT + field. The same one-line collapse with port 3's `local_y` 1 -> 9.
//      Reddens the port-for-port test, proving M4's green was the parser READING the
//      rows and not the parser losing them.
// ---------------------------------------------------------------------------

#[test]
fn the_frontend_router_entry_declares_the_shared_out_arity() {
    let outs = router_ports().iter().filter(|p| p.role == port_role::OUT).count();
    // OBSERVED, verbatim:
    //   M1 (a fourth Out appended with a trailing comment):
    //     `frontend/src/protocol/decode.ts declares 4 Router outputs while
    //      fabrico_command::ROUTER_OUT_ARITY is 3. [...]  left: 4  right: 3`
    //     -- the drift the whole file exists to catch, and the exact case that was
    //     GREEN before the extractor rewrite.
    //   M2 (a row deleted):
    //     `frontend/src/protocol/decode.ts declares 2 Router outputs while
    //      fabrico_command::ROUTER_OUT_ARITY is 3. [...]  left: 2  right: 3`
    assert_eq!(
        u16::try_from(outs).expect("the frontend Out count fits a u16"),
        ROUTER_OUT_ARITY,
        "frontend/src/protocol/decode.ts declares {outs} Router outputs while \
         fabrico_command::ROUTER_OUT_ARITY is {ROUTER_OUT_ARITY}. The placement ghost, the \
         gesture seeding legs and the config panel all read that table, so a Router placed in \
         the browser would differ from one placed through the command layer.",
    );
}

#[test]
fn the_frontend_router_entry_declares_the_catalog_input_count() {
    let rust = catalog_entry(machine_kind::ROUTER);
    let ts_ins = router_ports().iter().filter(|p| p.role == port_role::IN).count();
    let rust_ins = rust.ports.iter().filter(|p| p.role == port_role::IN).count();
    assert_eq!(
        ts_ins, rust_ins,
        "the frontend Router entry declares {ts_ins} input port(s) and the Rust catalog declares \
         {rust_ins}",
    );
}

#[test]
fn the_frontend_router_entry_declares_the_catalog_box() {
    let rust = catalog_entry(machine_kind::ROUTER);
    let (w, h, rot) = entry_box(DECODE_TS, ROUTER_ANCHOR);
    assert_eq!(
        (w, h, rot),
        (rust.w, rust.h, rust.rot),
        "the frontend Router entry's box is {w}x{h} rot {rot} and the Rust catalog's is {}x{} \
         rot {}. The ghost is sized from the frontend value, so it would promise a footprint the \
         host does not claim.",
        rust.w,
        rust.h,
        rust.rot,
    );
}

#[test]
fn the_frontend_router_entry_mirrors_the_catalog_port_for_port() {
    // The superset of the three equalities above: index, offset, side and role, row by
    // row. A PortId is an INDEX into this list, so a reordered row re-points every
    // spatial dock that already reaches a port by number, which no count assertion can
    // see.
    let expected: Vec<TsPort> = expected_ts_ports(machine_kind::ROUTER);
    // OBSERVED, verbatim (all four mutations that touch a row redden HERE, and M3/M5
    // redden ONLY here - a field change moves no count, so this is the only assertion
    // in the file that can see one):
    //   M1 (a fourth Out appended with a trailing comment):
    //     `the frontend Router entry and the Rust catalog disagree port for port
    //       left: [.., TsPort { index: 3, local_x: 1, local_y: 1, side: 1, role: 1 },
    //              TsPort { index: 4, local_x: 1, local_y: 3, side: 1, role: 1 }]
    //      right: [.., TsPort { index: 3, local_x: 1, local_y: 1, side: 1, role: 1 }]`
    //   M2 (a row deleted):
    //     `[..]  left: [.., TsPort { index: 2, .. }]
    //      right: [.., TsPort { index: 2, .. }, TsPort { index: 3, local_x: 1,
    //              local_y: 1, side: 1, role: 1 }]`
    //   M3 (port 2's side CAT_E -> CAT_S):
    //     `[..]  left: [.., TsPort { index: 2, local_x: 1, local_y: 0, side: 2, role: 1 }, ..]
    //      right: [.., TsPort { index: 2, local_x: 1, local_y: 0, side: 1, role: 1 }, ..]`
    //   M5 (one-line reformat + port 3's local_y 1 -> 9):
    //     `[..]  left: [.., TsPort { index: 3, local_x: 1, local_y: 9, side: 1, role: 1 }]
    //      right: [.., TsPort { index: 3, local_x: 1, local_y: 1, side: 1, role: 1 }]`
    assert_eq!(
        router_ports(),
        expected,
        "the frontend Router entry and the Rust catalog disagree port for port, \
         INCLUDING the medium byte",
    );
}

#[test]
fn every_router_preset_seeds_the_ts_router_rows_port_count_with_a_mechanical_fault() {
    // GATE-06's palette-Router leg (plan 85-05, D-22). The browser seeds a palette Router
    // from the WHOLE TS ROUTER row (`gestures.ts` `routerPresetSeedCommands`), Fault
    // included; the Rust preset producer `router_preset_ports`, which `router_presets()`
    // and `place_router_preset` both read, used to seed one In and the Outs and NO Fault,
    // so the two sides minted Routers of different shapes (WINDOWS 170). Both sides now
    // seed five, and the Fault is Mechanical for BOTH presets (the Handler precedent: a
    // fault drains on a belt, so an Electrical fault nub is one nothing can dock).
    let ts_row = router_ports();
    let ts_faults: Vec<&TsPort> = ts_row.iter().filter(|p| p.role == port_role::FAULT).collect();
    assert_eq!(ts_faults.len(), 1, "non-vacuity: the TS ROUTER row declares exactly one Fault");
    assert_eq!(
        ts_faults[0].medium,
        port_medium::MECHANICAL,
        "the TS ROUTER row's Fault is Mechanical"
    );
    let presets = fabrico_command::command::router_presets();
    assert_eq!(presets.len(), 2, "non-vacuity: two presets, HTTP and Item");
    for preset in &presets {
        let in_medium = preset.ports.first().map(|p| p.medium);
        assert_eq!(
            preset.ports.len(),
            ts_row.len(),
            "the preset at in-medium {in_medium:?} seeds as many ports as the TS ROUTER row \
             the browser seeds from"
        );
        let faults: Vec<_> = preset.ports.iter().filter(|p| p.role == port_role::FAULT).collect();
        assert_eq!(faults.len(), 1, "the preset at in-medium {in_medium:?} carries one Fault");
        assert_eq!(
            faults[0].medium,
            port_medium::MECHANICAL,
            "the preset at in-medium {in_medium:?} seeds its Fault Mechanical"
        );
    }
}

// ---------------------------------------------------------------------------
// The ENDPOINT equalities (66-03, WIRE-03). Same discipline as the Router block above:
// every value is PARSED from the frontend and compared against a value READ from this
// crate. Nothing here is a number written in this file.
//
// WHY THIS ROW IS MIRRORED AT ALL. `MACHINE_CATALOG` had no kind-9 key, so
// `catalogEntry(9)` fell through to the `ports: []` fallback and the placement ghost
// previewed no nubs for the one machine whose entire point is the wire terminal on it.
// Adding the row by hand is a SECOND hand-maintained mirror unless something watches it,
// and a plausible-looking hand-maintained mirror is what Phase 65 lost a phase to
// (`ROUTER_PRESET_PORT_LEGS`, a two-Out mirror of a three-Out catalog). So the row and
// the guard land together.
//
// THE MEDIUM IS OUT OF SCOPE HERE BY CONSTRUCTION - see the module header. Both ports are
// `Medium::Electrical` in Rust and `cp()` cannot express it.
// ---------------------------------------------------------------------------

#[test]
fn the_frontend_endpoint_entry_declares_exactly_two_port_rows() {
    // THE SINGLE-LINE EXTRACTOR TRAP, HELD AS AN ASSERTION RATHER THAN ASSUMED.
    // `entry_body` records a real past bug: bounded by a closing LINE it mis-read a
    // one-line entry and returned that entry plus all of the next one, and nothing
    // noticed because only the multi-line ROUTER entry was ever extracted. The ENDPOINT
    // row is written in the one-line SINK shape - exactly that input class. If the
    // brace-depth bound ever regresses, this entry's body would swallow whatever follows
    // it in the table and the count would exceed 2.
    //
    // Deliberately a STATED literal 2 and not `catalog_entry(ENDPOINT).ports.len()`: the
    // port-for-port test below already compares against Rust, and a count that read its
    // expectation from the same place it reads its subject could not see the extractor
    // over-reading into a neighbouring entry.
    let ports = endpoint_ports();
    assert_eq!(
        ports.len(),
        2,
        "the frontend Endpoint entry parsed to {} port row(s), not the 2 it declares - if this \
         is more than 2 the extractor has over-read past the single-line entry into whatever \
         follows it in MACHINE_CATALOG, which is the bug `entry_body` was rewritten to fix",
        ports.len(),
    );
}

#[test]
fn a_single_line_entry_is_bounded_at_its_own_brace_and_not_the_next_ones() {
    // THE RECORDED BUG, HELD AGAINST THE SHIPPED FILE RATHER THAN A FIXTURE.
    // `entry_body`'s docblock records that its line-bounded first version ran a
    // single-line entry straight into the next one - "for `SOURCE` it ran past the entry
    // entirely and returned `SOURCE` plus all of `FACTORY`" - and that nothing noticed,
    // because only the multi-line ROUTER entry was ever extracted.
    //
    // The ENDPOINT row this file now mirrors is written in that same single-line shape, so
    // the trap is live again. It cannot be proved ON the ENDPOINT row: ENDPOINT is the
    // LAST entry in `MACHINE_CATALOG`, so an unbounded read there runs into `};` and finds
    // no further `cp(` rows - a broken bound would look identical to a working one. The
    // subjects that CAN fail are the single-line entries that have a neighbour.
    //
    // MUTATION-PROVED (66-03) by restoring the pre-brace-count bound in `entry_body`
    // (`body.find("\n  },")`) and running this test. Both readings, verbatim:
    //
    //   SOURCE - the silent-bleed case the docblock names. The line sentinel matched
    //   FACTORY's closing line, so SOURCE's body swallowed all of FACTORY:
    //     `the "[machine_kind.SOURCE]: {" entry declares 4 "cp(" row(s) but only 1 of them
    //      are inside its "ports: [" array [..]  left: 1  right: 4`
    //
    //   SINK - the loud case. With ENDPOINT appended, every entry after ROUTER is written
    //   on one line, so the sentinel never occurs after SINK at all:
    //     `the "[machine_kind.SINK]: {" entry in decode.ts is never closed by a matching
    //      brace - the extractor cannot bound the entry and must not pass silently`
    //
    // The bound was restored and all tests returned to green.
    let source = entry_ports(DECODE_TS, "[machine_kind.SOURCE]: {");
    assert_eq!(
        source.len(),
        1,
        "the single-line SOURCE entry parsed to {} port row(s), not the 1 it declares - it has \
         run past its own closing brace into FACTORY, which is verbatim the bug `entry_body` \
         was rewritten to fix",
        source.len(),
    );
    // The expected count moved 1 -> 2 in phase 71: PILE-10 gives the SINK a second
    // catalog port (the `Role::Fault` nub on the same 1x1 cell), and the row is
    // deliberately kept on ONE LINE so it stays a subject this test can fail on. The
    // number is READ from the Rust catalog rather than written here, so the next arm
    // widening moves it automatically instead of turning this into a stale literal.
    let expected_sink_rows = catalog_entry(machine_kind::SINK).ports.len();
    assert_eq!(
        expected_sink_rows, 2,
        "SINK must still declare MORE THAN ONE port row for this subject to be able to \
         fail at all: a one-row entry bleeding into its neighbour and a one-row entry \
         read correctly are the same length"
    );
    let sink = entry_ports(DECODE_TS, "[machine_kind.SINK]: {");
    assert_eq!(
        sink.len(),
        expected_sink_rows,
        "the single-line SINK entry parsed to {} port row(s), not the {} it declares. Any \
         extra rows belong to the ENDPOINT entry that follows it, so `entry_body` is no \
         longer bounding a single-line entry at its own brace - and the single-line \
         ENDPOINT row below could not be trusted either",
        sink.len(),
        expected_sink_rows,
    );
}

#[test]
fn the_frontend_endpoint_entry_declares_one_in_and_one_out() {
    let rust = catalog_entry(machine_kind::ENDPOINT);
    let ts = endpoint_ports();
    let ts_ins = ts.iter().filter(|p| p.role == port_role::IN).count();
    let ts_outs = ts.iter().filter(|p| p.role == port_role::OUT).count();
    let rust_ins = rust.ports.iter().filter(|p| p.role == port_role::IN).count();
    let rust_outs = rust.ports.iter().filter(|p| p.role == port_role::OUT).count();
    assert_eq!(
        (ts_ins, ts_outs),
        (rust_ins, rust_outs),
        "the frontend Endpoint entry declares {ts_ins} input(s)/{ts_outs} output(s) and the Rust \
         catalog declares {rust_ins}/{rust_outs}. The placement ghost previews a nub per port, so \
         a hand-placed endpoint would show a terminal the host does not have (or hide one it does)",
    );
    assert_eq!(
        ts.first().map(|p| p.role),
        Some(port_role::IN),
        "the frontend Endpoint entry must list its In FIRST, per the Rust invariant \
         `port_catalog_every_kind_lists_in_ports_first`: a PortId is a raw index into this list, \
         so an Out declared before an In mis-keys every dock that reaches a port by number",
    );
}

#[test]
fn the_frontend_endpoint_entry_declares_the_catalog_box() {
    let rust = catalog_entry(machine_kind::ENDPOINT);
    let (w, h, rot) = entry_box(DECODE_TS, ENDPOINT_ANCHOR);
    assert_eq!(
        (w, h, rot),
        (rust.w, rust.h, rust.rot),
        "the frontend Endpoint entry's box is {w}x{h} rot {rot} and the Rust catalog's is {}x{} \
         rot {}. The ghost is sized from the frontend value, so it would promise a footprint the \
         host does not claim.",
        rust.w,
        rust.h,
        rust.rot,
    );
}

#[test]
fn the_frontend_endpoint_entry_mirrors_the_catalog_port_for_port() {
    // Index, offset, side and role, row by row - the only assertion in this block that
    // can see a FIELD move, because a field change moves no count.
    // Projected through `expected_ts_ports`, the ONE projection, so the medium 72-05
    // added cannot be carried by some mirrored entries and quietly dropped by others.
    let expected: Vec<TsPort> = expected_ts_ports(machine_kind::ENDPOINT);
    // NON-VACUITY, and it is this entry specifically. Both ENDPOINT ports are
    // `Medium::Electrical` and every port in every other mirrored entry except the
    // Handler's two is `Mechanical`, so if the medium were ever dropped back out of the
    // comparison this is the row where the loss is largest. Asserted rather than
    // assumed: a mirror that compared two all-zero medium columns would be a green over
    // a field nobody set.
    assert!(
        expected.iter().all(|p| p.medium == port_medium::ELECTRICAL),
        "both Endpoint ports must be ELECTRICAL for the medium comparison below to be \
         worth making on this entry (they are {:?})",
        expected.iter().map(|p| p.medium).collect::<Vec<u8>>(),
    );
    assert_eq!(
        endpoint_ports(),
        expected,
        "the frontend Endpoint entry and the Rust catalog disagree port for port, \
         INCLUDING the medium byte",
    );
}

// ---------------------------------------------------------------------------
// The extractor's own failure modes, exercised rather than described. Each of these
// would otherwise be a silent green.
// ---------------------------------------------------------------------------

#[test]
#[should_panic(expected = "no longer declares")]
fn a_missing_anchor_panics_naming_the_anchor() {
    // The anchor is the one thing that goes missing when the table is refactored or the
    // entry renamed. Returning an empty set here would let every assertion above pass
    // over nothing.
    let _ = entry_ports(DECODE_TS, "[machine_kind.NOT_A_REAL_KIND]: {");
}

#[test]
#[should_panic(expected = "declares ZERO cp(..) port rows")]
fn an_entry_with_no_port_rows_panics_rather_than_reporting_an_empty_set() {
    const PORTLESS: &str = "const MACHINE_CATALOG = {\n  [machine_kind.ROUTER]: {\n    kind: 5,\n    w: 2,\n    h: 3,\n    rot: 0,\n    ports: [],\n  },\n};\n";
    let _ = entry_ports(PORTLESS, ROUTER_ANCHOR);
}

#[test]
#[should_panic(expected = "is never closed by a matching brace")]
fn an_unterminated_entry_panics_rather_than_running_off_the_end() {
    const UNTERMINATED: &str = "const MACHINE_CATALOG = {\n  [machine_kind.ROUTER]: {\n    kind: 5,\n";
    let _ = entry_ports(UNTERMINATED, ROUTER_ANCHOR);
}

#[test]
#[should_panic(expected = "no longer declares `const CAT_NOT_A_ROLE = ...`")]
fn a_missing_role_constant_panics_rather_than_defaulting_to_zero() {
    // A role byte resolved to a default would map every unknown role onto `IN` (0) and
    // silently drop the Out count to zero, which reads as drift rather than as a broken
    // parser.
    let _ = ts_const(DECODE_TS, "CAT_NOT_A_ROLE");
}

// ---------------------------------------------------------------------------
// The SILENT-SKIP tests (65-review CR fix). Every one of these is a formatting the
// extractor's first, line-based version DROPPED without a word. A dropped row does not
// redden anything - it leaves the comparison set, and the four equalities above then
// compare the rows that survived and report a green. That is how a fourth Router Out
// sat in the shipped frontend against a `ROUTER_OUT_ARITY` of 3 with all 8 tests
// passing. Each test below is that formatting, held.
//
// The fixtures are synthetic on purpose: they exercise the EXTRACTOR without editing
// `decode.ts`, which stays the single hand-maintained mirror and is never touched to
// make a test pass.
// ---------------------------------------------------------------------------

/// A minimal `MACHINE_CATALOG` source carrying the side/role constants `parse_port`
/// resolves against, with `rows` dropped verbatim inside the Router entry's port array.
fn fixture(rows: &str) -> String {
    format!(
        "const CAT_IN = 0;\n\
         const CAT_OUT = 1;\n\
         const CAT_N = 0;\n\
         const CAT_E = 1;\n\
         const CAT_S = 2;\n\
         const CAT_W = 3;\n\
         const CAT_MECH = 0;\n\
         const CAT_ELEC = 1;\n\
         const MACHINE_CATALOG = {{\n  \
           [machine_kind.ROUTER]: {{\n    \
             kind: 5,\n    \
             w: 2,\n    \
             h: 3,\n    \
             rot: 0,\n    \
             ports: [{rows}],\n  \
           }},\n\
         }};\n"
    )
}

#[test]
fn a_trailing_comment_on_a_port_row_does_not_hide_the_row() {
    // THE REPRODUCTION, held as a test. Appending
    //   `cp(4, 1, 3, CAT_E, CAT_OUT), // widened`
    // to the shipped Router entry left all 8 tests GREEN before this fix, because
    // `strip_suffix("),")` failed on the trailing comment and the old line walk
    // `continue`d past it. The row was not compared and was not reported: it was gone.
    let src = fixture(
        "\n      cp(0, 0, 0, CAT_W, CAT_IN, CAT_MECH),\n      cp(1, 1, 2, CAT_E, CAT_OUT, CAT_MECH), // widened\n    ",
    );
    let ports = entry_ports(&src, ROUTER_ANCHOR);
    assert_eq!(ports.len(), 2, "a commented row is READ, never skipped");
    assert_eq!(ports[1].role, 1, "and it is read WHOLE, comment and all");
}

#[test]
fn a_port_row_without_a_trailing_comma_is_still_read() {
    // The last row of an array need not carry a trailing comma, and prettier removes
    // one in some configurations. The old `strip_suffix("),")` dropped exactly that row
    // - the LAST one, which for a Router is an Out.
    let src =
        fixture("\n      cp(0, 0, 0, CAT_W, CAT_IN, CAT_MECH),\n      cp(1, 1, 2, CAT_E, CAT_OUT, CAT_MECH)\n    ");
    assert_eq!(
        entry_ports(&src, ROUTER_ANCHOR).len(),
        2,
        "the comma-less final row is READ, never skipped"
    );
}

#[test]
fn port_rows_written_on_one_line_are_all_read() {
    // Not hypothetical: SOURCE, FACTORY, TEE, MERGE and SINK are ALL written this way in
    // the shipped `decode.ts` today, and prettier collapses the Router entry into this
    // shape the moment it fits the print width. The old line walk read ZERO rows from it
    // (no line begins with `cp(`), which the empty-set panic would at least have caught
    // - but a PARTIAL collapse, with `ports: [cp(0, ..),` on the opening line and the
    // rest below, dropped just the first row and passed.
    let src = fixture("cp(0, 0, 0, CAT_W, CAT_IN, CAT_MECH), cp(1, 1, 0, CAT_E, CAT_OUT, CAT_MECH), cp(2, 1, 1, CAT_E, CAT_OUT, CAT_MECH)");
    assert_eq!(
        entry_ports(&src, ROUTER_ANCHOR).len(),
        3,
        "every row on a shared line is READ"
    );
}

#[test]
#[should_panic(expected = "is not a \"cp(\" call this extractor can read")]
fn a_port_row_the_extractor_cannot_read_panics_rather_than_vanishing() {
    // The general case behind all three above: any element that is not a `cp(..)` call.
    // A future helper, a spread of a shared array, a hand-written object literal - the
    // extractor must say it cannot read it, because the alternative is comparing a
    // silently shortened list against the Rust catalog and calling the difference drift.
    let src = fixture(
        "\n      cp(0, 0, 0, CAT_W, CAT_IN, CAT_MECH),\n      makePort(1, 1, 2, CAT_E, CAT_OUT, CAT_MECH),\n    ",
    );
    let _ = entry_ports(&src, ROUTER_ANCHOR);
}

#[test]
#[should_panic(expected = "of them are inside its \"ports: [\" array")]
fn a_port_row_outside_the_ports_array_panics_rather_than_being_invisible() {
    // The last silent-drop route: the element walk is bounded by `ports: [ ... ]`, so a
    // row that ends up outside those brackets is not skipped - it is never seen at all.
    // The whole-body `cp(` count is the measure that does not share those bounds.
    const STRAY: &str =
        "const CAT_IN = 0;\nconst CAT_OUT = 1;\nconst CAT_E = 1;\nconst CAT_W = 3;\n\
         const CAT_MECH = 0;\n\
         const MACHINE_CATALOG = {\n  [machine_kind.ROUTER]: {\n    kind: 5,\n    \
         ports: [cp(0, 0, 0, CAT_W, CAT_IN, CAT_MECH)],\n    stray: cp(1, 1, 2, CAT_E, CAT_OUT, CAT_MECH),\n  },\n};\n";
    let _ = entry_ports(STRAY, ROUTER_ANCHOR);
}

#[test]
#[should_panic(expected = "declares no \"ports: [\" array")]
fn an_entry_without_a_ports_array_panics_rather_than_reading_nothing() {
    const NO_ARRAY: &str =
        "const MACHINE_CATALOG = {\n  [machine_kind.ROUTER]: {\n    kind: 5,\n    w: 2,\n  },\n};\n";
    let _ = entry_ports(NO_ARRAY, ROUTER_ANCHOR);
}

#[test]
#[should_panic(expected = "closes a bracket it never opened")]
fn an_unbalanced_ports_array_panics_rather_than_reading_a_prefix() {
    // A `ports: [` with no `]` swallows the entry's own closing brace, so the array walk
    // meets a `}` at depth zero. It says so rather than returning the prefix it managed
    // to read, which would be a short list compared against the full Rust catalog and
    // reported as drift.
    const UNBALANCED: &str = "const MACHINE_CATALOG = {\n  [machine_kind.ROUTER]: {\n    kind: 5,\n    ports: [\n      cp(0, 0, 0, CAT_W, CAT_IN, CAT_MECH),\n  },\n};\n";
    let _ = entry_ports(UNBALANCED, ROUTER_ANCHOR);
}

#[test]
fn the_extractor_reads_every_entry_the_shipped_catalog_declares() {
    // REACHABILITY, not a second mirror. The four equalities above only ever run the
    // extractor over ROUTER, so a formatting the extractor cannot handle could sit in
    // `decode.ts` unnoticed until the day the Router entry is reformatted into it. Every
    // other entry uses the ONE-LINE style that the old extractor read as zero rows, so
    // running the parser over the whole shipped table is the cheapest proof that both
    // shapes in the file are readable. It asserts only that each entry yields a
    // non-empty, parseable set. The Rust-to-TS comparison over every kind is
    // `every_frontend_catalog_row_mirrors_rust_port_for_port` (plan 85-02); this test
    // stays as the extractor's own reachability check.
    for kind in [
        "SOURCE", "FACTORY", "TEE", "BALANCER", "ROUTER", "MERGE", "SINK", "ENDPOINT",
        // 72-05: HANDLER, the fourth mirrored entry and the second multi-line one.
        "HANDLER",
    ] {
        let anchor = format!("[machine_kind.{kind}]: {{");
        let ports = entry_ports(DECODE_TS, &anchor);
        assert!(
            !ports.is_empty(),
            "the {anchor:?} entry parsed to zero ports - the extractor cannot read this entry's \
             formatting, so a mirror over it would be vacuous"
        );
        // THE BOX READER IS WALKED HERE TOO, AND IT WAS ADDED BECAUSE IT WAS BROKEN (66-03).
        // `entry_box` kept the LINE-shaped assumption that `entry_body` was rewritten to drop:
        // it required `w:` to open its own line, so it could not read ANY of the six
        // single-line entries in the shipped table. Nothing caught that for a whole phase,
        // because the only caller pointed it at the multi-line ROUTER entry. It surfaced the
        // moment the single-line ENDPOINT row was mirrored. The port walk above cannot see
        // this class of bug at all - the two readers share no code path - so the box is read
        // over every entry as well, which is what keeps the fix from silently regressing.
        let (w, h, _rot) = entry_box(DECODE_TS, &anchor);
        assert!(
            w > 0 && h > 0,
            "the {anchor:?} entry's box read as {w}x{h} - a zero dimension means the field \
             reader is matching something other than the declared box"
        );
    }
}

// ---------------------------------------------------------------------------
// The SINK equality (71-review IN-02). Plan 71-04's PILE-10 appended a `Role::Fault`
// nub to `port_catalog(SINK)` and the frontend row grew with it, but the only guard on
// that row was a COUNT
// (`a_single_line_entry_is_bounded_at_its_own_brace_and_not_the_next_ones`). A count
// passes a row whose fault nub sits on the wrong SIDE (`CAT_E` instead of `CAT_S`) or
// carries the wrong ROLE, and the nub's side is exactly what decides where a user can
// dock a fault belt. The comparator that can see it already existed and is
// anchor-parameterised; this points it at SINK.
// ---------------------------------------------------------------------------

#[test]
fn the_frontend_sink_entry_mirrors_the_catalog_port_for_port() {
    let expected = expected_ts_ports(machine_kind::SINK);
    // NON-VACUITY: the comparison must span MORE THAN ONE row, or a side/role mutation
    // on the fault nub has nowhere to hide but also nothing to be compared against. The
    // number is READ from the catalog, so a later widening moves it rather than turning
    // this into a stale literal.
    assert!(
        expected.len() >= 2,
        "SINK must declare its In port AND its Fault nub for this mirror to be worth \
         having (it declares {})",
        expected.len(),
    );
    assert!(
        expected.iter().any(|p| p.role == port_role::FAULT),
        "and one of them must be the Fault nub, which is the row a COUNT equality \
         cannot check the side or the role of",
    );
    assert_eq!(
        sink_ports(),
        expected,
        "the frontend Sink entry and the Rust catalog disagree port for port, INCLUDING \
         the medium byte. A PortId is an INDEX into this list, and the Fault nub's SIDE \
         is what decides where a user can dock a fault belt - neither is visible to a count",
    );
}

// ---------------------------------------------------------------------------
// The HANDLER equalities (72-05, SERVE-03). The FOURTH mirrored entry, and the entry
// that made the medium widening above unavoidable rather than merely nice.
//
// WHY THIS ROW IS THE ONE THAT FORCED THE MEDIUM. A Handler stands on the FACTORY's
// chassis: same 3x3 box, same three `local_offset` values, same sides, same roles,
// copied verbatim from the FACTORY arm because a Handler folds to a `Node::Factory`
// (72-CONTEXT D-11). Strip the medium out of the comparison and the Handler row and the
// Factory row become INDISTINGUISHABLE. The pre-72-05 mirror would have compared a
// frontend Handler entry against `port_catalog(HANDLER)` and reported a green over a
// row that had silently declared a mechanical In - the port `step_factory` drains, whose
// declared medium is the whole D-16 discriminator - and every request would have been
// stranded on a board that looked correct in both languages.
// ---------------------------------------------------------------------------

#[test]
fn the_frontend_handler_entry_declares_the_catalog_box() {
    let rust = catalog_entry(machine_kind::HANDLER);
    let (w, h, rot) = entry_box(DECODE_TS, HANDLER_ANCHOR);
    assert_eq!(
        (w, h, rot),
        (rust.w, rust.h, rust.rot),
        "the frontend Handler entry's box is {w}x{h} rot {rot} and the Rust catalog's is {}x{} \
         rot {}. The ghost is sized from the frontend value, so it would promise a footprint the \
         host does not claim.",
        rust.w,
        rust.h,
        rust.rot,
    );
}

#[test]
fn the_frontend_handler_entry_declares_one_electrical_in_first_and_exactly_one_out() {
    // D-02: ONE electrical Out, and the arity is LOAD-BEARING rather than sufficient.
    // With a single Out the command layer refuses a second Route's return cable as
    // `PortOccupied`, so this port list is what makes the one-request-one-reply shape
    // the only buildable board. A frontend row declaring more would preview nubs a user
    // could aim a second wire at and then be refused by the host.
    let rust = catalog_entry(machine_kind::HANDLER);
    let ts = handler_ports();
    let outs = ts.iter().filter(|p| p.role == port_role::OUT).count();
    let rust_outs = rust.ports.iter().filter(|p| p.role == port_role::OUT).count();
    assert_eq!(
        (outs, rust_outs),
        (1, 1),
        "the frontend Handler declares {outs} Out(s) and the Rust catalog {rust_outs}; both must \
         be exactly ONE (D-02). More than one lets a board D-01 rules out be previewed.",
    );
    assert_eq!(
        ts.first().map(|p| p.role),
        Some(port_role::IN),
        "the frontend Handler entry must list its In FIRST, per the Rust invariant \
         `port_catalog_every_kind_lists_in_ports_first`: a PortId is a raw index into this list, \
         and index 0 is the port `step_factory` drains",
    );
    assert_eq!(
        ts.first().map(|p| p.medium),
        Some(port_medium::ELECTRICAL),
        "the frontend Handler's port 0 must be ELECTRICAL. It is the port `step_factory` drains, \
         and since plan 72-03 its declared medium is the ENTIRE discriminator between a \
         mechanical Factory and an electrical Handler (D-16, read through `admit::inbox_class`). \
         A mechanical port 0 strands every request on a board that looks correct.",
    );
}

#[test]
fn the_frontend_handler_entry_mirrors_the_catalog_port_for_port() {
    let expected = expected_ts_ports(machine_kind::HANDLER);
    // NON-VACUITY, AND IT IS THE POINT OF THIS WHOLE TASK. The Handler's geometry is the
    // Factory's, copied verbatim, so the medium column is the ONLY thing in this
    // comparison that a Factory row would not also satisfy. Assert that the two rows
    // really are geometrically identical and really do differ only in medium, so that a
    // future reader cannot mistake this for a routine fourth mirror.
    let factory = expected_ts_ports(machine_kind::FACTORY);
    assert_eq!(
        expected
            .iter()
            .map(|p| (p.index, p.local_x, p.local_y, p.side, p.role))
            .collect::<Vec<(u16, i32, i32, u8, u8)>>(),
        factory
            .iter()
            .map(|p| (p.index, p.local_x, p.local_y, p.side, p.role))
            .collect::<Vec<(u16, i32, i32, u8, u8)>>(),
        "the Handler is supposed to be the Factory's chassis with different mediums \
         (71-UI-SPEC R-21, copied verbatim). If the geometry has diverged, either the \
         copy was edited or this test's premise is stale - resolve it rather than \
         relaxing the assertion",
    );
    assert_ne!(
        expected.iter().map(|p| p.medium).collect::<Vec<u8>>(),
        factory.iter().map(|p| p.medium).collect::<Vec<u8>>(),
        "the Handler and the Factory must DIFFER in their medium column, or the medium \
         is not distinguishing anything and this mirror is comparing a Factory against a \
         Factory",
    );
    assert_eq!(
        handler_ports(),
        expected,
        "the frontend Handler entry and the Rust catalog disagree port for port, INCLUDING \
         the medium byte - the one field that separates this machine from a Factory",
    );
}

/// The LABEL entry's anchor (phase 76, SHAPE-10). The FIFTH mirrored entry, and the first
/// whose port list is EMPTY by design: a label is a note and does not connect (D-07).
const LABEL_ANCHOR: &str = "[machine_kind.LABEL]: {";

/// Phase 76 (SHAPE-10, D-02): the frontend LABEL entry's box equals the Rust catalog's and
/// its port array is empty.
///
/// `entry_ports` is NOT used here, on purpose: it panics on an empty array (an empty set is
/// its vacuous-green shape), and an empty array is exactly what this row must declare. The
/// emptiness is read two independent ways instead, both through the panic-on-miss helpers:
/// the `ports: [ ... ]` array splits into ZERO elements, and the comment-stripped entry body
/// carries ZERO `cp(` calls, so a port row written inside or outside the array reddens it.
/// A missing `[machine_kind.LABEL]` anchor panics in `entry_body`, naming it.
#[test]
fn the_frontend_label_entry_declares_the_catalog_box_and_no_ports() {
    let rust = catalog_entry(machine_kind::LABEL);
    let (w, h, rot) = entry_box(DECODE_TS, LABEL_ANCHOR);
    assert_eq!(
        (w, h, rot),
        (rust.w, rust.h, rust.rot),
        "the frontend Label entry's box is {w}x{h} rot {rot} and the Rust catalog's is {}x{} \
         rot {}. The placement ghost is sized from the frontend value.",
        rust.w,
        rust.h,
        rust.rot,
    );
    assert!(rust.ports.is_empty(), "the Rust catalog gives a label no ports");
    let array = ports_array(DECODE_TS, LABEL_ANCHOR);
    let elements = top_level_elements(&array, LABEL_ANCHOR);
    assert!(
        elements.is_empty(),
        "the frontend Label entry declares {} port element(s); a label has none (D-07)",
        elements.len(),
    );
    let raw_calls = strip_line_comments(entry_body(DECODE_TS, LABEL_ANCHOR))
        .matches(PORT_CALL)
        .count();
    assert_eq!(raw_calls, 0, "the frontend Label entry carries a cp(..) row somewhere");
}

// ---------------------------------------------------------------------------
// EVERY CATALOG KIND, MIRRORED (plan 85-02, D-21, GATE-06). Until this plan five rows
// (SOURCE, FACTORY, TEE, BALANCER, MERGE) were hand-kept with nothing comparing them to
// Rust (WINDOWS row 63). The subject list is no longer written here: it is every byte
// for which `kind_has_catalog_arm` answers true, minus BELT (not placeable, no frontend
// row by design), so a kind the Rust catalog gains is a kind this file checks on the
// same commit, and a frontend row for a kind Rust does not have is a red.
//
// Two checks. The KEY SET: the bytes the frontend `MACHINE_CATALOG` declares rows for
// equal that Rust set, in both directions, classified for every byte 0 to 255. The
// ROWS: for every kind in the Rust set but LABEL (whose portless row keeps its own test
// above, because `entry_ports` panics on an empty array by design), the box and every
// port compare to `catalog_entry(kind)` port for port in index order, medium included,
// as exact integers. Both name the kind on every failure, and both count what they
// checked, so neither can pass over nothing.
// ---------------------------------------------------------------------------

/// Every `machine_kind` constant a `MACHINE_CATALOG` key may name, as (TS name, byte).
/// The ONE name table this file resolves anchors and keys through; it mirrors
/// `fabrico_protocol::machine_kind` and `frontend/src/protocol/kinds.ts`.
const KIND_NAMES: &[(&str, u8)] = &[
    ("SOURCE", machine_kind::SOURCE),
    ("BELT", machine_kind::BELT),
    ("FACTORY", machine_kind::FACTORY),
    ("TEE", machine_kind::TEE),
    ("BALANCER", machine_kind::BALANCER),
    ("ROUTER", machine_kind::ROUTER),
    ("MERGE", machine_kind::MERGE),
    ("SINK", machine_kind::SINK),
    ("WIRE", machine_kind::WIRE),
    ("ENDPOINT", machine_kind::ENDPOINT),
    ("HANDLER", machine_kind::HANDLER),
    ("LABEL", machine_kind::LABEL),
];

/// The kinds the Rust catalog declares and the frontend must mirror: every byte with a
/// catalog arm, minus BELT. Ascending.
fn rust_catalog_kinds() -> Vec<u8> {
    (0u8..=255)
        .filter(|k| kind_has_catalog_arm(*k) && *k != machine_kind::BELT)
        .collect()
}

/// A kind's name for a failure message: `FACTORY (2)`, or the bare byte for a kind with
/// no `machine_kind` name (`200`).
fn kind_label(kind: u8) -> String {
    KIND_NAMES
        .iter()
        .find(|(_, b)| *b == kind)
        .map_or_else(|| kind.to_string(), |(name, b)| format!("{name} ({b})"))
}

/// The `MACHINE_CATALOG` entry anchor for `kind`, `[machine_kind.<NAME>]: {`.
///
/// PANICS for a byte with no `machine_kind` name: the rows comparison only ever asks for
/// a kind the Rust catalog has, and every one of those is named.
fn anchor_of(kind: u8) -> String {
    let (name, _) = KIND_NAMES
        .iter()
        .find(|(_, b)| *b == kind)
        .unwrap_or_else(|| panic!("kind {kind} has a Rust catalog arm and no name in KIND_NAMES"));
    format!("[machine_kind.{name}]: {{")
}

/// The body of `const MACHINE_CATALOG ... = { ... }` in `source`, comment-stripped,
/// bounded by bracket depth.
///
/// PANICS when the declaration is missing or never closes.
fn catalog_body(source: &str) -> String {
    const DECL: &str = "const MACHINE_CATALOG";
    let start = source.find(DECL).unwrap_or_else(|| {
        panic!(
            "frontend/src/protocol/decode.ts no longer declares {DECL:?} - the key-set check \
             cannot see the table and must not pass silently"
        )
    });
    let after = &source[start..];
    let open = after
        .find("= {")
        .unwrap_or_else(|| panic!("the {DECL:?} declaration in decode.ts is not `= {{ ... }}`"));
    let body = &after[open + "= {".len()..];
    let mut depth: i32 = 1;
    for (i, c) in body.char_indices() {
        match c {
            '{' | '[' | '(' => depth += 1,
            '}' | ']' | ')' => {
                depth -= 1;
                if depth == 0 {
                    return strip_line_comments(&body[..i]);
                }
            }
            _ => {}
        }
    }
    panic!("the {DECL:?} body in decode.ts is never closed - the key-set check cannot bound it")
}

/// The kind bytes the frontend `MACHINE_CATALOG` declares rows for, in declaration order.
/// A key is `[machine_kind.<NAME>]` (resolved through `KIND_NAMES`) or `[<integer>]`.
///
/// PANICS on a key it cannot read and on a kind declared twice, naming it: a key it
/// skipped would drop a row from the set this check exists to compare.
fn ts_catalog_kinds(source: &str) -> Vec<u8> {
    let body = catalog_body(source);
    let mut kinds: Vec<u8> = Vec::new();
    for element in top_level_elements(&body, "const MACHINE_CATALOG") {
        let element = element.trim();
        let key = element
            .strip_prefix('[')
            .and_then(|rest| rest.split_once("]:"))
            .map(|(key, _)| key.trim())
            .unwrap_or_else(|| {
                panic!(
                    "a MACHINE_CATALOG element in decode.ts is not a `[key]: {{ .. }}` row this \
                     check can read: {element:?}"
                )
            });
        let kind = if let Some(name) = key.strip_prefix("machine_kind.") {
            KIND_NAMES
                .iter()
                .find(|(n, _)| *n == name)
                .map(|(_, b)| *b)
                .unwrap_or_else(|| panic!("MACHINE_CATALOG names an unknown kind `machine_kind.{name}`"))
        } else {
            key.parse::<u8>().unwrap_or_else(|_| {
                panic!("MACHINE_CATALOG key {key:?} is neither `machine_kind.<NAME>` nor a byte")
            })
        };
        assert!(
            !kinds.contains(&kind),
            "MACHINE_CATALOG declares kind {} twice",
            kind_label(kind)
        );
        kinds.push(kind);
    }
    kinds
}

/// Every byte 0 to 255 classified against the two sides: a kind with a Rust catalog arm
/// (minus BELT) must have a frontend row, and a kind without one must not. Returns one
/// sentence per offending kind, and one for a frontend table that declares no kinds.
fn key_set_violations(source: &str) -> Vec<String> {
    let rust = rust_catalog_kinds();
    let ts = ts_catalog_kinds(source);
    let mut out = Vec::new();
    if ts.is_empty() {
        out.push(
            "the frontend MACHINE_CATALOG declares no kinds at all - a key-set check over an \
             empty table must not pass"
                .to_string(),
        );
    }
    for kind in 0u8..=255 {
        match (rust.contains(&kind), ts.contains(&kind)) {
            (true, false) => out.push(format!(
                "kind {} has a Rust catalog arm and no frontend MACHINE_CATALOG row",
                kind_label(kind)
            )),
            (false, true) => out.push(format!(
                "kind {} has a frontend MACHINE_CATALOG row and no Rust catalog arm",
                kind_label(kind)
            )),
            _ => {}
        }
    }
    out
}

/// Panics with every key-set violation, one per line, when there is any.
fn assert_key_sets_equal(source: &str) {
    let violations = key_set_violations(source);
    assert!(
        violations.is_empty(),
        "the frontend MACHINE_CATALOG keys and the Rust catalog kinds differ:\n{}",
        violations.join("\n")
    );
}

/// The `kind:` field declared inside the entry introduced by `anchor`, resolved like a key.
fn entry_kind_field(source: &str, anchor: &str) -> u8 {
    let body = strip_line_comments(entry_body(source, anchor));
    for element in top_level_elements(&body, anchor) {
        if let Some(rest) = element.trim().strip_prefix("kind:") {
            let value = rest.trim();
            if let Some(name) = value.strip_prefix("machine_kind.") {
                if let Some((_, b)) = KIND_NAMES.iter().find(|(n, _)| *n == name) {
                    return *b;
                }
            } else if let Ok(b) = value.parse::<u8>() {
                return b;
            }
            panic!("the {anchor:?} entry's `kind:` field {value:?} names no known kind");
        }
    }
    panic!("the {anchor:?} entry in decode.ts declares no `kind:` field")
}

/// For every kind in the Rust set but LABEL: the entry's `kind:` field, box and every port
/// compared with `catalog_entry(kind)`, port for port in index order, medium included, as
/// exact integers. Returns how many kinds were checked and one sentence per difference.
fn row_violations(source: &str) -> (usize, Vec<String>) {
    let mut checked = 0usize;
    let mut out = Vec::new();
    for kind in rust_catalog_kinds()
        .into_iter()
        .filter(|k| *k != machine_kind::LABEL)
    {
        let name = kind_label(kind);
        let anchor = anchor_of(kind);
        let rust = catalog_entry(kind);
        let declared = entry_kind_field(source, &anchor);
        if declared != kind {
            out.push(format!(
                "kind {name}: the frontend row's `kind:` field is {}",
                kind_label(declared)
            ));
        }
        let (w, h, rot) = entry_box(source, &anchor);
        if (w, h, rot) != (rust.w, rust.h, rust.rot) {
            out.push(format!(
                "kind {name}: the frontend box is {w}x{h} rot {rot} and the Rust catalog's is {}x{} rot {}",
                rust.w, rust.h, rust.rot
            ));
        }
        let ts = entry_ports(source, &anchor);
        let expected = expected_ts_ports(kind);
        if ts.len() != expected.len() {
            out.push(format!(
                "kind {name}: the frontend declares {} port(s) and the Rust catalog {}",
                ts.len(),
                expected.len()
            ));
        }
        for (i, (t, r)) in ts.iter().zip(expected.iter()).enumerate() {
            if t != r {
                out.push(format!(
                    "kind {name}: port {i} differs, frontend {t:?} against Rust {r:?} (index, \
                     offsets, side, role and medium are all compared)"
                ));
            }
        }
        checked += 1;
    }
    (checked, out)
}

/// Panics with every row violation when there is any, or when fewer kinds were checked
/// than the Rust catalog declares (minus BELT and LABEL).
fn assert_rows_mirror_rust(source: &str) {
    let (checked, violations) = row_violations(source);
    let want = rust_catalog_kinds().len() - 1;
    assert_eq!(
        checked, want,
        "NON-VACUITY: the row comparison checked {checked} kind(s) and the Rust catalog declares \
         {want} with ports"
    );
    assert!(
        violations.is_empty(),
        "the frontend MACHINE_CATALOG and the Rust catalog disagree:\n{}",
        violations.join("\n")
    );
}

#[test]
fn every_catalog_kind_has_a_frontend_row_and_no_other_kind_does() {
    // NON-VACUITY on the Rust side: the set is driven by `kind_has_catalog_arm`, and a
    // predicate that stopped answering true would make both sides empty and equal.
    assert_eq!(
        rust_catalog_kinds().len(),
        10,
        "the Rust catalog declares {} kinds minus BELT; this phase knows 10 (nine with ports \
         plus LABEL). A new kind moves this number on purpose.",
        rust_catalog_kinds().len()
    );
    assert_key_sets_equal(DECODE_TS);
}

#[test]
fn every_frontend_catalog_row_mirrors_rust_port_for_port() {
    let (checked, _) = row_violations(DECODE_TS);
    assert_eq!(checked, 9, "the row comparison must check 9 kinds, never fewer");
    assert_rows_mirror_rust(DECODE_TS);
}

// ---------------------------------------------------------------------------
// The mutation legs (plan 85-02). Each is the shipped `decode.ts` with ONE defect
// injected, and each must fail naming the kind. They edit a copy in memory; `decode.ts`
// is never touched to make a test pass.
// ---------------------------------------------------------------------------

/// `source` with the entry introduced by `anchor` (anchor and body, through its closing
/// brace) replaced by `f(entry)`.
fn with_entry(source: &str, anchor: &str, f: impl Fn(&str) -> String) -> String {
    let start = source
        .find(anchor)
        .unwrap_or_else(|| panic!("fixture: no {anchor:?} in decode.ts"));
    let body = entry_body(source, anchor);
    let end = start + anchor.len() + body.len() + 1;
    format!("{}{}{}", &source[..start], f(&source[start..end]), &source[end..])
}

#[test]
#[should_panic(expected = "kind FACTORY (2) has a Rust catalog arm and no frontend MACHINE_CATALOG row")]
fn a_catalog_missing_the_factory_row_fails_naming_factory() {
    let anchor = anchor_of(machine_kind::FACTORY);
    // The entry AND the comma after it, so the table stays well formed and the only
    // defect is the missing row.
    let start = DECODE_TS.find(&anchor).expect("fixture: the FACTORY row");
    let end = start + anchor.len() + entry_body(DECODE_TS, &anchor).len() + 1;
    assert_eq!(&DECODE_TS[end..=end], ",", "fixture: the FACTORY row is followed by a comma");
    let src = format!("{}{}", &DECODE_TS[..start], &DECODE_TS[end + 1..]);
    assert_key_sets_equal(&src);
}

#[test]
#[should_panic(expected = "kind 200 has a frontend MACHINE_CATALOG row and no Rust catalog arm")]
fn a_catalog_with_an_extra_kind_200_row_fails_naming_200() {
    let at = DECODE_TS.find("const MACHINE_CATALOG").expect("fixture: the table");
    let open = at + DECODE_TS[at..].find("= {").expect("fixture: the table opens") + "= {".len();
    let src = format!(
        "{}\n  [200]: {{ kind: 200, w: 1, h: 1, rot: 0, ports: [] }},{}",
        &DECODE_TS[..open],
        &DECODE_TS[open..]
    );
    assert_key_sets_equal(&src);
}

#[test]
#[should_panic(expected = "kind TEE (3): port 0 differs")]
fn a_tee_row_with_two_ports_swapped_fails_naming_tee() {
    let tee = anchor_of(machine_kind::TEE);
    let src = with_entry(DECODE_TS, &tee, |entry| {
        let first = "cp(0, 0, 0, CAT_W, CAT_IN, CAT_MECH)";
        let second = "cp(1, 1, 0, CAT_E, CAT_OUT, CAT_MECH)";
        assert!(entry.contains(first) && entry.contains(second), "fixture: TEE rows moved");
        entry
            .replacen(first, "@@FIRST@@", 1)
            .replacen(second, first, 1)
            .replacen("@@FIRST@@", second, 1)
    });
    assert_rows_mirror_rust(&src);
}

#[test]
#[should_panic(expected = "kind BALANCER (4): port 0 differs")]
fn a_balancer_row_with_one_medium_flipped_fails_naming_balancer() {
    let balancer = anchor_of(machine_kind::BALANCER);
    let src = with_entry(DECODE_TS, &balancer, |entry| {
        assert!(entry.contains("CAT_MECH"), "fixture: BALANCER carries no mechanical port");
        entry.replacen("CAT_MECH", "CAT_ELEC", 1)
    });
    assert_rows_mirror_rust(&src);
}

#[test]
#[should_panic(expected = "declares no kinds at all")]
fn an_empty_catalog_fails_the_key_set_check_rather_than_passing_on_zero_kinds() {
    let at = DECODE_TS.find("const MACHINE_CATALOG").expect("fixture: the table");
    let src = format!("{}const MACHINE_CATALOG: Record<number, MachineCatalogEntry> = {{}};\n", &DECODE_TS[..at]);
    assert_key_sets_equal(&src);
}
