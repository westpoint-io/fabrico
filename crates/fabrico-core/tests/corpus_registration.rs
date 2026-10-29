//! THAW-06 — the golden corpus's REGISTRATION guard: a fixture directory the runner
//! never replays cannot exist.
//!
//! # The hole this closes
//! `tests/cert_cross_platform.rs` embeds every fixture at COMPILE time via
//! `include_bytes!`/`include_str!` and touches no filesystem, so it is structurally
//! blind to a directory on disk that no `CORPUS` record names. Its only registration
//! assertion was `!CORPUS.is_empty()`, which a planted directory sails past: the suite
//! stays green while the corpus certifies nothing about those bytes. A guard that sees
//! the directory has to read the disk at RUN time, which is why this lives in its own
//! integration-test target rather than inside the runner.
//!
//! # No clippy escape hatch is needed for the walk
//! `clippy.toml`'s `disallowed-methods` bans `std::fs::read`, `write`, `read_to_string`,
//! `File::open`, `OpenOptions::new`, `create_dir` and `create_dir_all`. It does NOT ban
//! `std::fs::read_dir`, and `Path::exists` is not an `fs` method call at all, so the
//! directory walk below carries no `#![allow]`. Presence of `meta.toml` is deliberately
//! the whole predicate: reading its CONTENT would need the file-scoped
//! `#![allow(clippy::disallowed_methods)]` that `regen.rs` and `bless_fixtures.rs` carry,
//! and would buy nothing this guard asserts.
//!
//! # THE STATED LIMIT OF THAT PREDICATE
//! A directory holding a `meta.toml` and none of the other four files IS caught here as
//! unregistered. A directory holding the other four files and NO `meta.toml` is INVISIBLE
//! to this guard. That gap is named rather than papered over; the nearest thing that would
//! see it is `scripts/measure-golden-corpus.sh`, whose `GOLDEN_FILES` walk requires all
//! five files to be present.
//!
//! # This test is NOT the proof
//! At every commit where the corpus is correct, the disk set and the registry set are
//! equal and this file is green on arrival. A guard that has never been observed red
//! proves nothing. `scripts/prove-corpus-registration-bites.sh` is the proof: it PLANTS an
//! unregistered fixture directory, requires this target to go red NAMING it, and reverts.

use std::path::{Path, PathBuf};

/// The registered fixture names, in `CORPUS` array order.
///
/// # This is a SECOND COPY and the consequence is stated, not hidden
/// `CORPUS` is a private `const` inside the `cert_cross_platform` integration-test crate.
/// Integration tests are separate crates and cannot import each other's private items, so
/// there is no way to read the real registry from here. The equality this file asserts is
/// therefore between the DISK and THIS LIST, not between the disk and `CORPUS` itself, and
/// two lists that can drift apart would let this guard confidently check the wrong
/// registry.
///
/// `every_golden_directory_is_registered_in_the_corpus_table` below closes that gap by
/// counting the registry's own records in its source text (see `corpus_record_count`) and
/// requiring the two counts to agree. Adding a fixture therefore reddens here until this
/// list is updated too, which is the intended cost of the duplication.
///
/// That clause is folded into the directory-set test rather than living in a test of its
/// own, so there is no separate function to grep for. An earlier draft of this docblock
/// named `the_local_name_list_matches_the_corpus_registry_length`, which never existed;
/// a reader grepping for it concluded the gap was unclosed (70-REVIEW WR-06).
const REGISTERED: &[&str] = &[
    "0001-source-belt-collector",
    "0002-merge-backlog",
    "0003-balancer-rotation",
    "0004-router-fault-mix",
    "0005-factory-stateful",
    "0006-executor-loop",
    "0007-edit-add-during-flow",
    "0008-edit-delete-during-flow",
    "0009-multi-cell-footprint",
    "0010-delete-cascade-detach",
    "0011-rotate-in-place",
    "0012-draw-belt-flow",
    "0013-delete-belt-with-items",
    "0014-undo-delete-with-docked-belt",
    "0015-undo-redo-each-op",
    "0016-factory-3x3-fault-dock",
    "0017-rotate-re-route-dedock",
    "0018-wire-removed-drawbelt-dock",
    "0019-add-remove-port-router-preset",
    "0020-footprint-resize-replay",
    "0021-undo-port-edit-survives-save-load",
    "0022-wire-transport-basic",
    "0023-wire-reply-round-trip",
    "0024-same-tick-belt-wire-tiebreak",
    "0025-wire-budget-overflow-cycle",
    "0026-wire-cap-overflow-fanin",
    "0027-configure-factory-source-swap",
    "0028-router-config-replay",
    "0029-belt-pace-replay",
    "0030-inbox-saturation-replay",
    "0031-undo-delete-of-a-wire",
    "0032-undo-delete-of-a-bare-belt",
    "0033-remove-out-port-repoints",
    "0034-belt-to-belt-junction-replay",
    "0035-label-inert-replay",
    // v11.0 phase 87, plan 87-08: one golden per core jam (JAM-01 to JAM-05, D-10).
    "0036-balancer-both-inputs",
    "0037-tee-slow-branch",
    "0038-refused-fault-bounded",
    "0039-jammed-solid-goes-idle",
    "0040-factory-two-emits",
];

/// `crates/fabrico-core/tests/golden`, resolved from the crate manifest dir so the guard
/// does not depend on the working directory the runner was launched from (the same
/// convention `regen.rs`'s `golden_dir` and `rotate_undo_redock.rs`'s grep-parity gate
/// use).
fn golden_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("golden")
}

/// Every entry under `golden_root()` that is a DIRECTORY holding a `meta.toml`, sorted.
///
/// `README.md` is a file in that directory and holds no `meta.toml`, so the predicate
/// excludes it without needing a name-based exception. Sorted because `read_dir` yields
/// entries in an unspecified, filesystem-dependent order and a failure message that
/// reorders itself between runs is harder to act on.
fn directories_holding_a_meta_toml(root: &Path) -> Vec<String> {
    let entries = std::fs::read_dir(root).unwrap_or_else(|e| {
        panic!(
            "the registration guard must be able to walk {}: {e}",
            root.display()
        )
    });

    let mut found = Vec::new();
    for entry in entries {
        let entry = entry.unwrap_or_else(|e| {
            panic!(
                "the registration guard must be able to read every entry under {}: {e}",
                root.display()
            )
        });
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        if !path.join("meta.toml").exists() {
            continue;
        }
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_else(|| {
                panic!(
                    "a fixture directory name under {} is not valid UTF-8",
                    root.display()
                )
            })
            .to_owned();
        found.push(name);
    }
    found.sort();
    found
}

/// The number of `Fixture` records in the real registry, counted in the runner's own
/// source text.
///
/// # Why a source-text read, and why a COUNT
/// `CORPUS` is a private `const` in the `cert_cross_platform` integration-test crate.
/// Integration tests are separate crates and cannot import each other's private items, so
/// the registry cannot be read as data from here. A count is the strongest claim a
/// source-text read can make honestly: parsing Rust for the string literals would be a
/// second, weaker registry that could itself drift, while a count catches every add and
/// every delete of a record.
///
/// # Why the record opener and not the `name:` field
/// This counted `name: "` anywhere in the file until 70-REVIEW WR-06. That is a bare
/// substring over the whole text, comments included, so a comment carrying `name: "`
/// inflated the count, and - the case that actually matters - a comment added in the SAME
/// commit that deleted a record kept the count equal and hid the drift. Counting lines
/// that trim to exactly `Fixture {` cannot be moved by any comment: `// Fixture {` trims
/// to `// Fixture {`, not to `Fixture {`. The `struct Fixture {` declaration is excluded
/// for the same reason, its line trims to `struct Fixture {`.
///
/// # Non-vacuity
/// A parse that matches nothing would return 0 and make this clause assert two zeros
/// against each other. The floor below refuses that: if the opener ever stops matching,
/// this panics naming the file rather than passing.
fn corpus_record_count() -> usize {
    let runner = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("cert_cross_platform.rs");

    // A source-text parity read of one tracked file under CARGO_MANIFEST_DIR, not sim-core
    // I/O: refusing the read would delete the gate. Same narrowly-scoped exemption, and the
    // same reason, as the grep-parity gate in
    // crates/fabrico-command/tests/rotate_undo_redock.rs. The ban stays deny-level where it
    // means something (crates/fabrico-core/src/lib.rs); allowing it HERE does not weaken it
    // there.
    #[allow(clippy::disallowed_methods)]
    let text = std::fs::read_to_string(&runner).unwrap_or_else(|e| {
        panic!(
            "the registry-parity clause must be able to READ {}: {e}",
            runner.display()
        )
    });

    let count = text
        .lines()
        .filter(|line| line.trim() == "Fixture {")
        .count();

    assert!(
        count > 0,
        "the registry-parity clause counted ZERO `Fixture {{` record openers in {}. \
         Either the file no longer holds `const CORPUS`, or the record literal was \
         reformatted so the opener is no longer a line of its own. Counting zero would \
         make this clause compare two zeros and pass while checking nothing, so it \
         panics instead. Fix the count, never the assertion.",
        runner.display()
    );

    count
}

/// The set of golden fixture DIRECTORIES on disk equals the set of registered fixture
/// names, in BOTH directions, and the local name list has not drifted from the real
/// registry.
///
/// # Both directions, with different messages, each NAMING the offender
/// A directory with no record is "certified by nothing, the runner never replays it".
/// A record with no directory is "the record points at bytes that are not there". They are
/// different defects with different fixes, and a single symmetric message would report
/// neither usefully.
///
/// # Failures are DEFERRED into one assertion
/// Rust panics on the first `assert!`, so directional assertions in sequence would report
/// one side and hide every other. Every gate under `scripts/` defers its exit for exactly
/// this reason and this test does the same: every finding is collected and reported
/// together, numbered.
#[test]
fn every_golden_directory_is_registered_in_the_corpus_table() {
    let root = golden_root();
    let on_disk = directories_holding_a_meta_toml(&root);

    let mut registered: Vec<&str> = REGISTERED.to_vec();
    registered.sort_unstable();

    let mut unmet: Vec<String> = Vec::new();

    // A walk that found nothing compares clean against any registry, so the floor is a
    // clause of its own rather than a silent precondition.
    if on_disk.is_empty() {
        unmet.push(format!(
            "the walk of {} found ZERO directories holding a meta.toml. An empty disk set \
             compares equal to nothing and would report a green that measured nothing.",
            root.display()
        ));
    }

    for dir in &on_disk {
        if !registered.contains(&dir.as_str()) {
            unmet.push(format!(
                "UNREGISTERED FIXTURE DIRECTORY: '{dir}' exists under {} and no CORPUS \
                 record names it. The corpus runner never replays it, so those bytes are \
                 certified by nothing and the non-emptiness floor in \
                 crates/fabrico-core/tests/cert_cross_platform.rs cannot see it. Either \
                 register it (one Fixture record there, and one name in REGISTERED here) \
                 or remove the directory.",
                root.display()
            ));
        }
    }

    for name in &registered {
        if !on_disk.iter().any(|d| d == name) {
            unmet.push(format!(
                "REGISTERED FIXTURE WITH NO DIRECTORY: '{name}' is registered but no \
                 directory holding a meta.toml exists for it under {}. The record points \
                 at bytes that are not there.",
                root.display()
            ));
        }
    }

    // The drift clause. Without it the two directional checks above can be entirely
    // correct about a registry that is not the one the runner replays: a fixture added to
    // CORPUS and to disk but not to REGISTERED reads as an unregistered directory, and a
    // record deleted from CORPUS alone goes unnoticed here.
    let records = corpus_record_count();
    if records != REGISTERED.len() {
        unmet.push(format!(
            "REGISTRY DRIFT: crates/fabrico-core/tests/cert_cross_platform.rs holds \
             {records} CORPUS record(s) but REGISTERED in this file holds {}. The two \
             lists have drifted, so the equality above is being asserted against the wrong \
             registry. Add or remove the name here in the SAME commit that adds or removes \
             the record there.",
            REGISTERED.len()
        ));
    }

    assert!(
        unmet.is_empty(),
        "the golden fixture directories on disk and the registered corpus do not agree \
         ({} finding(s); {} director(y/ies) on disk, {} registered name(s), {records} \
         CORPUS record(s)):\n{}",
        unmet.len(),
        on_disk.len(),
        registered.len(),
        unmet
            .iter()
            .enumerate()
            .map(|(i, m)| format!("  {}. {m}", i + 1))
            .collect::<Vec<_>>()
            .join("\n")
    );
}
