//! THE ADVANCED-SCENE REGENERABILITY PROOF (quick 260916-adv, added by quick
//! 260929-p7p for review WR-02): the third shipped scene is REGENERABLE from its
//! command list, one list, two independent appliers, one hash. It is a clone of
//! `order_regenerability.rs` (the LIVE-04 discipline the demo earned in
//! `demo_regenerability.rs`): nothing outside the command list on either applier and NO
//! timer install, because the timer is projected after the seed.
//!
//! Applier A is the REAL live path: a `Host` over tempfile redb, genesis at
//! [`ADVANCED_GENESIS_SEED`], seeded by [`seed_scene`] through the certified
//! `apply_gesture` -> `enqueue_edit` -> `tick_once` path, one command per tick.
//! Applier B is the headless `GridSession`, folding the SAME
//! `SceneId::Advanced.commands()` list one `apply` at a time from the same seed.
//!
//! Equality is judged by ONE digest: `fabrico_scenario::tick_hash` =
//! blake3(snapshot(Core)), the single sanctioned state-equality path (threat
//! T-13-HASH). The snapshot covers the whole core including `tick` and the RNG
//! state, so equality certifies both appliers consumed identical ticks and RNG
//! draws.
//!
//! This scene covers shapes the demo and order pins do not: a Rotated Sink, an
//! AddPort'd Factory whose Fault port feeds a belt, and a Balancer/Merge chain.

use fabrico_command::GridSession;
use fabrico_core::core::Core;
use fabrico_core::event::{LogHeader, SCHEMA_VERSION};
use fabrico_core::persist::RedbStore;
use fabrico_host::demo_scene::{ADVANCED_GENESIS_SEED, SceneId, seed_scene};
use fabrico_host::driver::Host;
use fabrico_host::ledger::DispatchLedger;
use fabrico_scenario::tick_hash;

/// The advanced scene's absolute state digest at the seed boundary.
///
/// Pinned by quick 260929-p7p AFTER the review fixes to `scenes/advanced.ron`
/// (CR-01 validate JS, WR-04 dropped priority flag, CR-02 Sources moved to column
/// 0). The review measured `74943db3...` on the unfixed scene; that value is gone.
/// Any transcription drift in `scenes/advanced.ron` (a moved cell, an edited
/// Factory source) reddens this test.
///
/// **It moves TOGETHER with `GOLDEN_TICK_HASH` in `demo_regenerability.rs` and
/// `ORDER_GOLDEN_TICK_HASH` in `order_regenerability.rs`** on a snapshot-schema bump
/// (the version tag is inside the hashed bytes, and all three scenes place belts
/// and Sinks), so a bump that moved one of the three and not the others is a
/// defect, never a re-pin.
///
/// **74.1-14 (CORNER-06, the "Edits keep middle layout" rule)**, a
/// LAYOUT EDIT, named. The validate Factory's AddPort now keeps every catalog port (In
/// (0,1), Out_0 (2,1), Fault (1,2)) and seats the new Out at (2,2): belts 14, 15, 16 and 17
/// were redrawn onto In (8,7), Fault (9,8), Out_0 (10,7) and Out_1 (10,8), and the
/// dead-letter sink takes a second clockwise turn (In faces E) so the fault belt drops
/// straight down instead of running west (floor 4). Every machine keeps its place; every
/// Dock port index and Configure stays. THE TWO-APPLIER EQUALITY STILL HOLDS.
///   OLD `4e109c6447e0015b82f2427167d2541039e87ed11037e25625eaa22d23daad49`
///   NEW `cb68914dc1d67ebd81493e5df7deaf48e5a4a96f0753b5c3fe64af94f9cdee1f`
///
/// **85-05 (CHROME-04, D-08), the SNAPSHOT 12 -> 13 bump**, plan 85-05 re-pins it.
/// This plan does not touch the scene: `SNAPSHOT_SCHEMA_VERSION` 12 -> 13 (the Email sink
/// target's deletion, CHROME-04 / D-08) moves the version tag inside the hashed bytes,
/// which moves every state digest. The demo, order and advanced pins move together for
/// that one shared cause. THE TWO-APPLIER EQUALITY STILL HOLDS.
///   OLD `cb68914dc1d67ebd81493e5df7deaf48e5a4a96f0753b5c3fe64af94f9cdee1f`
///   NEW `863c22cdbde837a685463fc5295a123b10c45e3149f315608adb81fc25fa23bc`
///
/// **85-06 (DEMO-05, D-10), the history seal**, plan 85-06 re-pins it.
/// This plan does not touch the scene's commands: `seed_scene` now ends with one
/// `EditOp::SealHistory` record (the undo floor) folded in ONE more tick, so the seeded
/// core is one tick further on and `tick_hash` covers `core.tick`. The record changes no
/// grid state (the core's NOOP arm); the tick alone moves the digest. Applier B seals at
/// the same point (`GridSession::seal_history`), so THE TWO-APPLIER EQUALITY STILL HOLDS.
///   OLD `863c22cdbde837a685463fc5295a123b10c45e3149f315608adb81fc25fa23bc`
///   NEW `fdc117b9ea7e2ed03cab6ba4648794ddf89f5c127d6ed0229e682fd5446c61f5`
///
/// **85-10 (DEMO-09, D-25), the Advanced re-layout**, plan 85-10 re-pins it. A LAYOUT EDIT,
/// named: the Balancer, both workers, the fan-in Merge and the HTTP Sink move two columns
/// east; belt 16 grows two cells; belts 18 to 22 move with their machines; belt 17 runs
/// straight down column 12 into the invoice Factory's doorstep and belt 21 climbs column 24
/// into the fan-in Merge's In1 doorstep, neither doubling back (floor 6). Every Dock port
/// index and every Configure stays; the command count is unchanged. THE TWO-APPLIER EQUALITY
/// STILL HOLDS (seen holding while the absolute anchor below was red).
///   OLD `fdc117b9ea7e2ed03cab6ba4648794ddf89f5c127d6ed0229e682fd5446c61f5`
///   NEW `e8941f38d18a7051a3d0d57fe1ba4b731c673ca5d02fafe170d9ee8b5cdeaf2b`
///
/// **87-03 (JAM-01, D-02 to D-07), the SNAPSHOT 13 -> 14 bump**, plan 87-03 re-pins it.
/// This plan does not touch the scene: `SNAPSHOT_SCHEMA_VERSION` 13 -> 14 (phase 87's four
/// appended fields, `Balancer::next_in`, `Tee::faults`, `Factory::pending_emits` and
/// `Scheduler::blocked`) moves the version tag inside the hashed bytes and adds the new
/// fields' bytes (the Balancer's `next_in`, every Tee's and Factory's new field, and the
/// scheduler's empty `blocked` set), which moves every state digest. The demo, order and
/// advanced pins move together for that one shared cause. THE TWO-APPLIER EQUALITY STILL
/// HOLDS.
///   OLD `e8941f38d18a7051a3d0d57fe1ba4b731c673ca5d02fafe170d9ee8b5cdeaf2b`
///   NEW `e06e7f0a30b04aaafe3235388979043a205cea2ad9b3d53a07ec8c0443501309`
const ADVANCED_GOLDEN_TICK_HASH: &str =
    "e06e7f0a30b04aaafe3235388979043a205cea2ad9b3d53a07ec8c0443501309";

#[test]
fn advanced_scene_regenerates_to_an_identical_hash_from_two_appliers() {
    let cmds = SceneId::Advanced
        .commands()
        .expect("the embedded advanced RON parses");

    // ── Applier A: the REAL live Host, seeded through the certified path ─────
    let dir = tempfile::tempdir().expect("tempdir");
    let core = Core::genesis(LogHeader {
        schema_version: SCHEMA_VERSION,
        seed: ADVANCED_GENESIS_SEED,
    });
    let store = RedbStore::open(dir.path().join("log.redb")).expect("open log");
    let ledger = DispatchLedger::open(dir.path().join("ledger.redb")).expect("open ledger");
    let mut host = Host::new(core, store, ledger, None).expect("open host");
    let minted = seed_scene(&mut host, &cmds).expect("seed_scene folds every advanced command");
    assert_eq!(
        minted.len(),
        24,
        "12 machines + 12 belts mint in ledger order"
    );
    let live_hash = tick_hash(host.core());

    // ── Applier B: the headless GridSession, folding the SAME list ───────────
    let mut session = GridSession::new(ADVANCED_GENESIS_SEED);
    for cmd in cmds {
        session
            .apply(cmd)
            .expect("the session accepts every advanced-scene command");
    }
    // Plan 85-06 (D-10): `seed_scene` ends with the history seal folded in one more tick,
    // so the headless applier seals at the same point and advances the same ticks.
    session.seal_history().expect("sealing the history is always accepted");
    let session_hash = tick_hash(session.core());

    // ── THE PROOF: one list, two appliers, ONE hash ──────────────────────────
    assert_eq!(
        live_hash, session_hash,
        "the shipped advanced scene must be regenerable from its command list - the \
         live Host (certified gesture path, one command per tick) and an independent \
         GridSession folding the same list from the same seed must produce an \
         IDENTICAL blake3 tick_hash"
    );

    // ── The ABSOLUTE anchor: the pinned golden digest ────────────────────────
    assert_eq!(
        live_hash, ADVANCED_GOLDEN_TICK_HASH,
        "the RON-sourced advanced scene must reproduce the pinned state tick_hash (a \
         one-cell typo in scenes/advanced.ron moves this hash and fails here)"
    );
}
