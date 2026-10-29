//! The DATA-DRIVEN golden corpus test (TEST-02) — one `rstest` case per committed
//! `fixtures/*.postcard`, each freezing the scenario's blake3 `tick_hash` as the
//! PRIMARY `insta` snapshot line, with the id-free [`StateSummary`] as a secondary
//! readability line. This realizes the phase convention: "a test is a serialized
//! command-log fixture + a blake3 state-hash as the primary assertion, via insta +
//! rstest."
//!
//! # rstest `#[files]` = ONE case per fixture (1:1)
//! `#[files("fixtures/*.postcard")]` globs the committed corpus at compile time and
//! generates a distinct test case per match (the glob is relative to
//! `CARGO_MANIFEST_DIR`). Each case decodes the `Scenario`, REPLAYS it from genesis via
//! `GridSession::replay_two_logs`, and snapshots the result. Adding a fixture to the
//! corpus automatically adds a golden case here — no per-fixture boilerplate.
//!
//! # Hash is PRIMARY (T-13-HASH); the summary is a secondary aid (Pitfall 3)
//! Snapshot line 1 is the one digest path — `oracle::tick_hash` = `blake3(snapshot(core))`.
//! Line 2 is the id-free [`StateSummary`] (counts + SORTED faulted cells, never raw
//! `NodeId`s / `HashSet` order), so the snapshot is run-stable across undo/redo id
//! re-mints. The counts are NEVER the primary equality check — the hash leads.
//!
//! # File snapshots under `snapshots/`, blessed + committed, CI-enforced
//! Each case writes an insta FILE snapshot to `crates/fabrico-scenario/snapshots/`
//! (`snapshot_path => "../snapshots"`, module prefix suppressed) named after the fixture
//! stem, so the `.snap` files pair 1:1 with the fixtures. They are blessed once
//! (`INSTA_UPDATE=always` / `cargo insta accept`) and committed; CI runs `INSTA_UPDATE=no`
//! so any unblessed drift FAILS the build (T-13-HASH: counts/summary are non-authoritative;
//! the committed hash is the frozen golden value).
//!
//! # Reject-only fixture IO
//! `Scenario::from_bytes` decodes reject-only (typed `Result`), but a COMMITTED fixture is
//! trusted, so a decode failure here is a HARD test failure (a corrupt committed fixture is
//! a bug, never a silent skip and never a panic-from-decode). Reading the corpus from disk
//! is the sanctioned harness IO (like `bless_fixtures.rs` / `deps_headless.rs`), so the
//! workspace `disallowed_methods` lint (`std::fs::read`) is allowed for this test file only.
#![allow(clippy::disallowed_methods)]

use std::fs;
use std::path::PathBuf;

use fabrico_command::GridSession;
use fabrico_scenario::{Scenario, StateSummary, tick_hash};
use rstest::rstest;

/// ONE golden case per `fixtures/*.postcard`: decode the committed scenario, replay it
/// from genesis, and freeze `tick_hash` (PRIMARY) + the id-free `StateSummary` (secondary)
/// as a per-fixture FILE snapshot under `snapshots/`.
#[rstest]
fn golden_hash(#[files("fixtures/*.postcard")] path: PathBuf) {
    // Read the committed fixture bytes (trusted corpus IO — sanctioned, see module doc).
    let bytes = fs::read(&path)
        .unwrap_or_else(|e| panic!("read committed fixture {}: {e}", path.display()));

    // Decode reject-only; a COMMITTED fixture MUST decode (a hard failure, never a panic
    // from inside the decoder — the typed Err is surfaced as the test failure).
    let scenario = Scenario::from_bytes(&bytes).unwrap_or_else(|e| {
        panic!(
            "committed fixture {} must decode (trusted, but decoded reject-only): {e}",
            path.display()
        )
    });

    // REPLAY the full two-log command sequence from genesis — the deterministic re-fold.
    let session =
        GridSession::replay_two_logs(scenario.seed, &scenario.edit_log, &scenario.event_log);

    // PRIMARY: the one digest path (blake3 of the snapshot bytes).
    let hash = tick_hash(session.core());
    // SECONDARY readability aid: id-free counts + SORTED faulted cells (never raw ids).
    let summary = StateSummary::of(session.core());

    // Per-fixture snapshot name = the fixture file stem (e.g. "01-exit-gate"), so the
    // `.snap` files pair 1:1 with the fixtures.
    let name = path
        .file_stem()
        .and_then(|s| s.to_str())
        .expect("fixture file stem is valid UTF-8");

    // Store FILE snapshots at the crate-root `snapshots/` dir (not `tests/snapshots/`),
    // with the module prefix suppressed so the file is exactly `<stem>.snap`.
    let mut settings = insta::Settings::clone_current();
    settings.set_snapshot_path("../snapshots");
    settings.set_prepend_module_to_snapshot(false);
    settings.bind(|| {
        // Line 1 = hash (PRIMARY); line 2 = id-free summary (secondary aid).
        insta::assert_snapshot!(name, format!("{hash}\n{summary}"));
    });
}
