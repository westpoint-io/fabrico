//! Phase 72-10 (SERVE-05, R-68) - the CROSS-LANGUAGE BOUND mirror lock.
//!
//! # What this file is for
//! `frontend/src/chrome/RouteConfigBody.tsx` declares `MAX_ENDPOINT_PATH_BYTES`, a
//! HAND-MAINTAINED mirror of [`fabrico_core::edit::MAX_ENDPOINT_PATH_BYTES`]. It is read
//! TWICE on that side - once as the Path field's `maxLength`, once by the over-length
//! rule that computes the OVERAGE the user reads - so a drift does not merely mis-size a
//! field. It changes a sentence that tells the user how many characters to delete.
//!
//! # WHY IT EXISTS AT ALL, WHICH IS THE SHIPPED GAP IT REFUSES TO REPEAT
//! `RouterConfigBody.tsx` mirrors `MAX_ROUTE_EXPECT_BYTES` by hand with NOTHING in the
//! workspace checking the two agree. That is the shipped precedent for this exact
//! pattern and it is also a shipped hole: every check lives on one side of the language
//! boundary and samples its own side, which is precisely the condition under which
//! 63-07's Router-arity drift sat green for a phase (see `ts_catalog_mirror.rs`, whose
//! module header tells that story and whose idiom this file is lifted from).
//!
//! Widening the lock to `MAX_ROUTE_EXPECT_BYTES` as well is deliberately NOT done here:
//! that constant is another plan's subject and pulling it in would make this file's red
//! ambiguous about which mirror moved. This file locks ONE bound and says which.
//!
//! # Why it panics instead of skipping
//! Every extraction step panics with a message naming the anchor it could not find. An
//! extractor that returned `None` and let the caller skip would be a green that measured
//! nothing, which is the exact failure shape this project has hit repeatedly. That is
//! the load-bearing half of the idiom, not a nicety: the assertion below can only fail
//! if the numbers DIFFER, so an extractor that silently found no number would turn the
//! whole file into a test that cannot fail.
//!
//! Proved able to fail, 2026-09-03: changing the TypeScript literal to `1023` reddens
//! `the_typescript_bound_equals_the_rust_bound` with
//! `frontend/src/chrome/RouteConfigBody.tsx mirrors MAX_ENDPOINT_PATH_BYTES as 1023, but
//! fabrico_core::edit::MAX_ENDPOINT_PATH_BYTES is 1024`. Reverted.
//!
//! Run target: `cargo test -p fabrico-command --test ts_bound_mirror`

use fabrico_core::edit::MAX_ENDPOINT_PATH_BYTES;

/// The frontend module embedded at COMPILE time - a moved or renamed file is a compile
/// error in this crate, never a test that quietly stops finding anything to check. The
/// same `include_str!` discipline `ts_catalog_mirror.rs` uses for `decode.ts`.
const ROUTE_CONFIG_BODY_TSX: &str =
    include_str!("../../../frontend/src/chrome/RouteConfigBody.tsx");

/// The panel that reads the bound's two consumers, embedded for the same reason. It is a
/// SEPARATE file from the declaration on purpose (see
/// `the_bound_is_declared_in_exactly_one_place`).
const CONFIG_PANEL_TSX: &str = include_str!("../../../frontend/src/chrome/ConfigPanel.tsx");

/// The TypeScript declaration this file parses, named so a failure can quote the exact
/// anchor that went missing.
const BOUND_ANCHOR: &str = "export const MAX_ENDPOINT_PATH_BYTES = ";

/// The value the TypeScript side declares for `MAX_ENDPOINT_PATH_BYTES`.
///
/// PANICS on a missing anchor, an unterminated declaration, or a value that is not a
/// plain integer literal. A lookup that returned `None` and let the caller skip would
/// make the equality below pass vacuously, which is the failure mode this whole file
/// exists to refuse.
fn ts_bound() -> usize {
    let start = ROUTE_CONFIG_BODY_TSX.find(BOUND_ANCHOR).unwrap_or_else(|| {
        panic!(
            "frontend/src/chrome/RouteConfigBody.tsx no longer declares {BOUND_ANCHOR:?} - the \
             cross-language bound lock cannot see the mirror and must not pass silently"
        )
    });
    let rest = &ROUTE_CONFIG_BODY_TSX[start + BOUND_ANCHOR.len()..];
    let end = rest.find(';').unwrap_or_else(|| {
        panic!("the MAX_ENDPOINT_PATH_BYTES declaration in RouteConfigBody.tsx is not terminated by `;`")
    });
    rest[..end].trim().parse::<usize>().unwrap_or_else(|_| {
        panic!(
            "the MAX_ENDPOINT_PATH_BYTES declaration in RouteConfigBody.tsx is not a plain \
             integer literal (found {:?}) - a computed mirror cannot be compared to a constant",
            rest[..end].trim()
        )
    })
}

/// THE HEADLINE. The two languages carry the same number.
///
/// MUTATION: change the TypeScript literal and this reddens, quoting both values.
#[test]
fn the_typescript_bound_equals_the_rust_bound() {
    assert_eq!(
        ts_bound(),
        MAX_ENDPOINT_PATH_BYTES,
        "frontend/src/chrome/RouteConfigBody.tsx mirrors MAX_ENDPOINT_PATH_BYTES as {}, but \
         fabrico_core::edit::MAX_ENDPOINT_PATH_BYTES is {}. The Path field's `maxLength` and \
         the over-length sentence's OVERAGE are both computed from the TS value, so a drift \
         tells the user to delete the wrong number of characters",
        ts_bound(),
        MAX_ENDPOINT_PATH_BYTES,
    );
}

/// The extractor RESOLVED something, and it resolved something plausible.
///
/// Not a restatement of the test above. That one compares two numbers; this one asserts
/// the number came from a real declaration rather than from a default a broken parse
/// might have produced. `ts_bound()` panics rather than defaulting, so this is belt on
/// braces - and it is the belt the sibling file's own recorded near miss argues for.
#[test]
fn the_extractor_resolves_a_real_declaration() {
    let n = ts_bound();
    assert!(
        n > 0,
        "the TypeScript bound parsed as {n}, which is not a length any path can be under"
    );
    assert!(
        ROUTE_CONFIG_BODY_TSX.contains(&format!("{BOUND_ANCHOR}{n};")),
        "the parsed value {n} does not round-trip against the source text the anchor \
         introduces - the extractor read something other than the declaration"
    );
}

/// THE BOUND IS MIRRORED ONCE, AND ONCE IS THE WHOLE POINT.
///
/// A second TypeScript declaration would be a second source of truth that this file's
/// single anchor is structurally blind to: `find` returns the FIRST match, so a
/// divergent second copy could sit in the tree with every assertion above green.
/// `68-UI-SPEC` FINDING 1 is the worked example of what that costs.
#[test]
fn the_bound_is_declared_in_exactly_one_place() {
    assert_eq!(
        ROUTE_CONFIG_BODY_TSX.matches(BOUND_ANCHOR).count(),
        1,
        "RouteConfigBody.tsx declares MAX_ENDPOINT_PATH_BYTES more than once - the mirror lock \
         compares only the FIRST, so a second declaration is an unchecked second truth"
    );
    assert!(
        !CONFIG_PANEL_TSX.contains(BOUND_ANCHOR),
        "ConfigPanel.tsx has grown its own MAX_ENDPOINT_PATH_BYTES declaration. It must READ \
         the one in RouteConfigBody.tsx, never restate it"
    );
}

/// THE BOUND'S NUMERAL IS NEVER RESTATED IN PROSE, on either consumer.
///
/// The over-length sentence states the OVERAGE and derives it. A restated figure in a
/// string is a second source of truth that no mirror lock can see, because it is not a
/// declaration at all.
#[test]
fn no_user_facing_string_restates_the_bound() {
    let numeral = MAX_ENDPOINT_PATH_BYTES.to_string();
    for (name, source) in [
        ("RouteConfigBody.tsx", ROUTE_CONFIG_BODY_TSX),
        ("ConfigPanel.tsx", CONFIG_PANEL_TSX),
    ] {
        for line in source.lines() {
            let trimmed = line.trim_start();
            // Comments and the declaration itself are where the number legitimately
            // appears. Everything else is code or copy.
            if trimmed.starts_with("//")
                || trimmed.starts_with('*')
                || trimmed.starts_with("/*")
                || trimmed.contains(BOUND_ANCHOR)
            {
                continue;
            }
            assert!(
                !line.contains(&numeral),
                "{name} restates the bound's numeral ({numeral}) outside its one declaration:\n  \
                 {line}\nThe bound is READ from the constant; the over-length sentence states \
                 the OVERAGE"
            );
        }
    }
}
