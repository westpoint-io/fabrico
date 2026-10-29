//! The DATA-DRIVEN determinism test (TEST-03) — one `rstest` case per committed
//! `fixtures/*.postcard`, each feeding the scenario through the three determinism
//! helpers from [`fabrico_scenario::determinism`]. This proves EVERY authored scenario
//! in the corpus is deterministic, not just the headline exit gate.
//!
//! # rstest `#[files]` = ONE case per fixture
//! `#[files("fixtures/*.postcard")]` globs the corpus at compile time (relative to
//! `CARGO_MANIFEST_DIR`) and generates a distinct case per fixture. Adding a fixture
//! automatically adds a determinism case — no per-fixture boilerplate.
//!
//! # Three byte-equality properties (NOT golden snapshots — no insta here)
//! For each fixture:
//! - [`assert_replays`] — replay-from-genesis is a byte-identical deterministic re-fold
//!   (two independent `replay_two_logs` reach byte-identical snapshots).
//! - [`assert_snapshot_restore`] — `snapshot -> restore -> snapshot` round-trips
//!   byte-identically (exercising the REJECT-ONLY restore trust gate).
//! - [`assert_arrival_order_independent`] — permuting a SAME-TICK distinct-source
//!   injection batch leaves the final `tick_hash` unchanged (REPLAY-03 / T-3-ARR). It is
//!   a DOCUMENTED NO-OP (returns `false`) for a fixture with no qualifying batch, so it
//!   is correct to run on every fixture and simply skip where inapplicable.
//!
//! These are equality assertions over the canonical core primitives + the one digest
//! path — no forked fold or digest, and deliberately no `insta` golden (a determinism
//! property is a byte-equality invariant, not a frozen value).
//!
//! # Reject-only fixture IO
//! `Scenario::from_bytes` decodes reject-only, but a COMMITTED fixture is trusted, so a
//! decode failure is a HARD test failure (never a silent skip, never a panic-from-decode).
//! Reading the corpus from disk is the sanctioned harness IO (like `golden_hashes.rs` /
//! `bless_fixtures.rs` / `deps_headless.rs`), so the workspace `disallowed_methods` lint
//! (`std::fs::read`) is allowed for this test file only.
#![allow(clippy::disallowed_methods)]

use std::fs;
use std::path::PathBuf;

use fabrico_scenario::{
    Scenario, assert_arrival_order_independent, assert_replays, assert_snapshot_restore,
};
use rstest::rstest;

/// ONE determinism case per `fixtures/*.postcard`: decode the committed scenario and run
/// all three byte-equality determinism properties against it.
#[rstest]
fn determinism(#[files("fixtures/*.postcard")] path: PathBuf) {
    // Read the committed fixture bytes (trusted corpus IO — sanctioned, see module doc).
    let bytes =
        fs::read(&path).unwrap_or_else(|e| panic!("read committed fixture {}: {e}", path.display()));

    // Decode reject-only; a COMMITTED fixture MUST decode (hard failure, never a panic).
    let scenario = Scenario::from_bytes(&bytes).unwrap_or_else(|e| {
        panic!(
            "committed fixture {} must decode (trusted, but decoded reject-only): {e}",
            path.display()
        )
    });

    // (a) replay-from-genesis byte-equality, (b) snapshot/restore round-trip.
    assert_replays(&scenario);
    assert_snapshot_restore(&scenario);
    // (c) arrival-order independence — runs where a distinct-source same-tick batch
    // exists, a documented no-op (returns false) otherwise. Consume the `#[must_use]`
    // result: a fixture may legitimately have no qualifying batch (e.g. belt-transport's
    // single injection), so we do NOT require it to have run.
    let _arrival_order_checked = assert_arrival_order_independent(&scenario);
}
