//! D-60-3 / `WINDOWS.md` id 43: the golden corpus README's schema block must name the
//! CURRENT values of the constants it transcribes, so the next bump cannot silently rot it
//! again.
//!
//! # Why this test is the OPPOSITE of `endpoint.rs::core_version_consts_are_frozen`
//!
//! The sibling tripwire in `endpoint.rs:617` states its rule in capitals: "These are
//! HAND-WRITTEN literals and must stay literals. Deriving any of them from the constant it
//! checks would make this tripwire agree with any value." That rule is right FOR THAT TEST,
//! whose job is to PIN a value - a derived assertion cannot fail, so it would certify
//! nothing.
//!
//! This test is the deliberate inverse, and the divergence is by design rather than by
//! oversight. Its job is not to pin a value; it is to REDDEN ON A BUMP. It formats the LIVE
//! constants and asks whether the README still names them. Hand-writing the numbers here
//! would produce a second transcription that goes stale in exactly the way the first one
//! did - which is the defect being closed, reintroduced one file over. So the two tests
//! want opposite things from the same constants, and between them the pair is complete:
//! one refuses a bump that was not reviewed, the other refuses a bump whose documentation
//! was not updated.
//!
//! # Why this file lives in `fabrico-host` rather than beside the corpus it guards
//!
//! `crates/fabrico-core` is FROZEN for milestone v7.0 (the single exception was Phase 60),
//! and the freeze was machine-enforced by the core-freeze gate. That gate closed
//! both doors a new file could use:
//!
//! - **Check 2** diffed the whole frozen path set against the
//!   base ref, so a COMMITTED new file under `crates/fabrico-core` broke the freeze.
//! - **Check 3** walked `git ls-files --others`, so an
//!   UNCOMMITTED one broke it too. That check exists precisely because "a diff against a
//!   commit cannot see a file git has never been told about".
//!
//! So NO phase under the freeze can put a new file in `fabrico-core` - not just this one.
//! The ROADMAP's Phase 61 note originally implied otherwise (it said the test lands in
//! Phase 61 "because a new test is a new behavioural path inside a frozen crate and was
//! outside Phase 60's declared radius", which reads as though Phase 61 could place it
//! there); that premise is corrected in the ROADMAP in the same commit as this file.
//!
//! `fabrico-host` is the right home on its merits and not merely by elimination: it is
//! unfrozen, it already depends on `fabrico-core`, and `endpoint.rs` already reads
//! `SNAPSHOT_SCHEMA_VERSION` from it.
//!
//! # Why a compile-time embed and never a runtime read
//!
//! The README is pulled in at COMPILE TIME. Nothing here touches the filesystem at runtime,
//! which is the same discipline the corpus runner itself follows ("it never touches the
//! filesystem (so it stays inside the determinism clippy gate and is robust to cwd/OS)").
//! It also keeps this test a pure READ of the frozen tree: the golden-corpus byte-identity
//! check (check 1 of the core-freeze gate) is untouched, because reading a file is not
//! writing one.

/// The corpus README, embedded at compile time. The path is relative to THIS source file:
/// `crates/fabrico-host/tests/` -> `crates/fabrico-core/tests/golden/README.md`.
const GOLDEN_README: &str = include_str!("../../fabrico-core/tests/golden/README.md");

/// The shape the README prints a constant in, reproduced exactly once.
///
/// The README writes each as `` `NAME = value` `` inside a markdown code span (lines 35 and
/// 46 at the time of writing). Only the `NAME = value` core is matched: the surrounding
/// backticks and bold markers are formatting the author may reflow, and a gate that broke on
/// a cosmetic edit would be retired by the first person it inconvenienced.
fn named(name: &str, value: impl std::fmt::Display) -> String {
    format!("{name} = {value}")
}

/// One assertion, with a message that names the missing string AND what to do about it.
fn assert_readme_names(name: &str, value: impl std::fmt::Display) {
    let expected = named(name, value);
    assert!(
        GOLDEN_README.contains(&expected),
        "crates/fabrico-core/tests/golden/README.md no longer names `{expected}`.\n\
         \n\
         That block is headed \"keep this current on every clean-break bump\", and it has \
         gone stale under that instruction before (it read `6` and `3` \"as of Phase 11\" \
         long after a later bump moved them). Update the README's schema block to the current \
         value - do NOT edit this test to match the README, which would restore exactly the \
         silent rot D-60-3 was filed to close."
    );
}

/// The corpus README names the CURRENT value of every constant it transcribes.
///
/// One assertion per constant, each with its own message, so a run names the offender rather
/// than reporting that "something" drifted. All three are checked in one test because they
/// are one obligation and one place to fix.
#[test]
fn golden_readme_states_the_current_schema_constants() {
    assert_readme_names(
        "SNAPSHOT_SCHEMA_VERSION",
        fabrico_core::snapshot::SNAPSHOT_SCHEMA_VERSION,
    );
    assert_readme_names("EDIT_SCHEMA_VERSION", fabrico_core::edit::EDIT_SCHEMA_VERSION);
    assert_readme_names("SLOTS_PER_TILE", fabrico_core::belt_slots::SLOTS_PER_TILE);
}

/// NON-VACUITY: the README must be a real, non-empty embed.
///
/// Without this, a README that had been emptied, moved or replaced by a stub would make
/// every `contains` above fail loudly - fine - but a `contains` over a string that merely
/// HAPPENED to hold the three fragments in a comment or a changelog would pass while
/// covering nothing. Pinning the heading the block lives under is what ties the assertions
/// above to the block D-60-3 is actually about.
#[test]
fn the_embedded_readme_is_the_corpus_schema_block_and_not_an_empty_or_unrelated_file() {
    assert!(
        !GOLDEN_README.is_empty(),
        "the embedded golden README is empty - the assertions above would be testing nothing"
    );
    assert!(
        GOLDEN_README.contains("keep this current on every clean-break bump"),
        "the golden README no longer carries the \"keep this current on every clean-break \
         bump\" heading. That heading is what makes the block below it an obligation rather \
         than prose, and it is the block this test guards. If the heading was deliberately \
         reworded, re-point this assertion in the SAME commit - never delete it."
    );
}
