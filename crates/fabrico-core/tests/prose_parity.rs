//! THAW-07 / `WINDOWS.md` row 107: the frozen golden-corpus runner's own comments must
//! state the SHIPPED Router arity and the SHIPPED grown footprints, not the ones that were
//! true when the 0019/0020 fixtures were first registered in Phase 36.
//!
//! # What went stale, and why nobody could fix it
//!
//! `cert_cross_platform.rs`'s per-fixture comment blocks for `0019-add-remove-port-router-preset`
//! and `0020-footprint-resize-replay` describe an Item Router preset with two `Out` ports and
//! the footprints that follow from two. Plan 65-05 widened the preset to `ROUTER_OUT_ARITY`
//! outputs, which moved the preset arity and BOTH grown footprints. The generator
//! (`tests/regen.rs`) was updated with the widening because it is executable; the runner's
//! prose was not, because it is not.
//!
//! It stayed wrong for four milestones because `crates/fabrico-core` was byte-frozen, and
//! the core-freeze gate diffed the working tree: a COMMENT-ONLY edit under the
//! frozen root reddened check 2 exactly as a code edit did. The correction was correct to
//! make and forbidden to make. Milestone v9.0's declared-moves gate
//! replaces the byte-freeze with a declaration, and this
//! file is written in the first phase that can therefore make it.
//!
//! # Why the pin lives in a SEPARATE test target from the file it reads
//!
//! This target reads `cert_cross_platform.rs`'s source TEXT. If the assertions below lived
//! inside `cert_cross_platform.rs` itself, its own needle literals would appear in the text
//! being searched and would satisfy every one of them: `1-in/3-out` would be "found" because
//! this test names it, not because the runner states it. A check that its own source
//! satisfies is the defect class this repository has caught fourteen times. So the pin is a
//! separate integration-test target in the same crate, embedding the runner from outside it,
//! and it MUST stay that way. Do not merge these tests into the runner.
//!
//! This follows two shipped precedents: `crates/fabrico-host/tests/golden_readme_currency.rs`
//! (a compile-time embed of a file that could not host its own gate, plus a non-vacuity
//! anchor) and `crates/fabrico-command/tests/rotate_undo_redock.rs` (a prose-parity gate
//! whose failure message says CORRECT THE PROSE, never re-point the test).
//!
//! # Why a compile-time embed and never a runtime read
//!
//! The embed below resolves at COMPILE time. Nothing here touches the filesystem while the
//! test runs, so the runner's own discipline ("it never touches the filesystem, so it stays
//! inside the determinism clippy gate and is robust to cwd/OS") is preserved and the
//! workspace `disallowed_methods` deny needs no exemption in this file.
//!
//! # Why every failure is REPORTED TOGETHER rather than asserted one at a time
//!
//! Six sequential `assert!` calls would panic on the FIRST mismatch, so a run could only ever
//! name one token however many had drifted, and "each of the six is pinned" would be a claim
//! no run could measure. Phase 70 plan 70-02 hit exactly that shape and fixed it the same
//! way. Every token below is therefore CHECKED, its verdict collected, and the whole list
//! reported in one assertion at the end.

/// The golden-corpus runner, embedded at COMPILE time. The path is relative to THIS source
/// file: both live in `crates/fabrico-core/tests/`. Nothing below touches the filesystem at
/// run time.
const CERT_RUNNER: &str = include_str!("cert_cross_platform.rs");

/// The arity and footprint tokens that were true BEFORE plan 65-05 widened the Router
/// preset, and are false now. Each must occur ZERO times in the runner.
///
/// Written with explicit Rust unicode escapes so this source is unambiguous about which code
/// points it means: `\u{d7}` is U+00D7 MULTIPLICATION SIGN, the character the runner and the
/// generator both use for a footprint, and NOT the ASCII letter `x`.
const RETIRED_ARITY_TOKENS: [&str; 3] = ["1-in/2-out", "2\u{d7}4", "2\u{d7}6"];

/// The arity and footprint tokens the code actually ships, read from
/// `crates/fabrico-core/tests/regen.rs` (the 0019 generator at its `place_router_preset`
/// assertions, and the 0020 generator at its grow/floor assertions) rather than derived.
/// Each must occur AT LEAST ONCE in the runner.
const SHIPPED_ARITY_TOKENS: [&str; 3] = ["1-in/3-out", "2\u{d7}5", "2\u{d7}7"];

/// The runner's 0019 and 0020 comment blocks state the shipped Router arity and the shipped
/// grown footprints.
///
/// Six checks, all six run, all failures reported together. Each verdict names the token, the
/// count found, and what to do about it.
#[test]
fn the_runner_states_the_shipped_router_arity() {
    let mut failures: Vec<String> = Vec::new();

    for token in RETIRED_ARITY_TOKENS {
        let hits = CERT_RUNNER.matches(token).count();
        if hits != 0 {
            failures.push(format!(
                "RETIRED token {token:?} occurs {hits} time(s) in \
                 crates/fabrico-core/tests/cert_cross_platform.rs and must occur 0. It \
                 describes the pre-65-05 Router preset. CORRECT THE RUNNER'S PROSE to the \
                 shipped value, reading the truth from crates/fabrico-core/tests/regen.rs; \
                 do NOT re-point this test at whatever the runner currently says, which \
                 would restore exactly the silent rot WINDOWS row 107 was filed to close."
            ));
        }
    }

    for token in SHIPPED_ARITY_TOKENS {
        let hits = CERT_RUNNER.matches(token).count();
        if hits == 0 {
            failures.push(format!(
                "SHIPPED token {token:?} occurs 0 times in \
                 crates/fabrico-core/tests/cert_cross_platform.rs and must occur at least \
                 once. The runner has to STATE the arity the code ships, not merely avoid \
                 stating the one it retired. CORRECT THE RUNNER'S PROSE, reading the truth \
                 from crates/fabrico-core/tests/regen.rs; do NOT delete this token from \
                 this list."
            ));
        }
    }

    assert!(
        failures.is_empty(),
        "the corpus runner's arity prose has drifted from the shipped Router preset \
         ({} of 6 tokens wrong):\n\n{}",
        failures.len(),
        failures.join("\n\n")
    );
}

/// BELT AND BRACES: the runner carries no ASCII `2x<digit>` footprint form.
///
/// GREEN at HEAD by construction; it is not one of the six recorded reds. Its job is to stop
/// a future fixer half-migrating the notation. If someone wrote the corrected footprints as
/// `2x5` and `2x7` in ASCII while leaving the U+00D7 originals in place, the retired-token
/// checks and the shipped-token checks above could be satisfied SIMULTANEOUSLY by two
/// different spellings of the same fact, and the pin would certify nothing.
///
/// The digits 3 through 9 are the ones that appear in a Router footprint (`2x3` base through
/// `2x7` grown); `2x0`, `2x1` and `2x2` are excluded because they are not footprint forms and
/// could collide with unrelated prose.
#[test]
fn the_runner_carries_no_half_migrated_ascii_footprint_form() {
    let mut offenders: Vec<&str> = Vec::new();
    for (i, _) in CERT_RUNNER.match_indices("2x") {
        let rest = &CERT_RUNNER[i + 2..];
        if let Some(digit) = rest.chars().next()
            && matches!(digit, '3'..='9')
        {
            offenders.push(&CERT_RUNNER[i..i + 3]);
        }
    }

    assert!(
        offenders.is_empty(),
        "crates/fabrico-core/tests/cert_cross_platform.rs carries {} ASCII footprint \
         form(s) {offenders:?}. The runner's notation is U+00D7 MULTIPLICATION SIGN \
         throughout. A half-migrated file lets the retired-token and shipped-token checks \
         in this file both pass while the prose says two contradictory things. Write the \
         footprint with U+00D7, matching the rest of the file.",
        offenders.len()
    );
}

/// NON-VACUITY: the embed is the real corpus runner.
///
/// Without this, a runner that had been emptied, renamed or moved would make every
/// `matches(...).count()` above return 0 - which SATISFIES all three retired-token checks -
/// and the shipped-token checks would fail for a reason that has nothing to do with arity.
/// Pinning `const CORPUS`, the fixture table the whole runner exists to walk, is what ties
/// the assertions above to the file THAW-07 is actually about.
#[test]
fn the_embedded_runner_is_the_real_corpus_runner_and_not_an_empty_or_moved_file() {
    assert!(
        !CERT_RUNNER.is_empty(),
        "the embedded corpus runner is empty - the arity assertions above would be \
         testing nothing"
    );
    assert!(
        CERT_RUNNER.contains("const CORPUS"),
        "crates/fabrico-core/tests/cert_cross_platform.rs no longer declares `const CORPUS`. \
         That table is the fixture registry the runner walks and the thing the arity \
         comments annotate; without it this file is embedding something else. If the runner \
         was deliberately restructured, re-point this anchor in the SAME commit - never \
         delete it."
    );
}
