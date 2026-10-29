//! Live Undo/Redo host integration + the two REQUIRED determinism proofs
//! (Phase 19, the heart of the Nyquist gate — 19-VALIDATION.md).
//!
//! This is the LIVE analog of Phase 12's headless `undo_survives_save_load`: it
//! drives a real `Host` + `RenderProducer` + `SimLoop` through ordinary ticks and
//! proves live Undo/Redo folds correctly, broadcasts a full keyframe + reroutes,
//! survives a redb save/load round-trip, and — the correctness bar the whole phase
//! exists to satisfy — that the PERSISTED live undo/redo edit+event log replays from
//! genesis to a byte-identical frozen state (Proof 1).
//!
//! - `live_undo_redo_folds` (UNDO-04): a live Playing loop places a machine, folds an
//!   Undo (the node disappears) then a Redo (it reappears); the folded batch carries
//!   `EditOp::Undo`/`Redo` lineage markers — proving the gesture was ROUTED and
//!   ACCEPTED, never rejected as `CommandError::Malformed`.
//! - `undo_emits_keyframe_and_reroutes` (UNDO-06): undoing a placed Source broadcasts a
//!   `full:true` keyframe over the diff channel and the LIVE webhook route table drops
//!   the removed Source (no dangling handle).
//! - `undo_survives_save_load_live` (UNDO-05): place → Undo → `save_project` → reopen via
//!   `load_project` into a FRESH Host; the reloaded `can_undo`/`can_redo` + core snapshot
//!   match the live session (redb round-trip).
//! - `live_undo_replays_byte_identical` (UNDO-05, Proof 1): drive Place A / Place B /
//!   DrawBelt / Undo / Redo live, read the PERSISTED redb logs, replay from genesis via
//!   `GridSession::replay_two_logs`, assert byte-identical `snapshot(core)`.
//!
//! All traffic (where a socket is used) stays on `127.0.0.1`.

use std::time::Duration;

use fabrico_command::GridSession;
use fabrico_core::core::Core;
use fabrico_core::edit::EditOp;
use fabrico_core::event::{LogHeader, SCHEMA_VERSION};
use fabrico_core::persist::RedbStore;
use fabrico_core::snapshot::snapshot;
use fabrico_host::config::HostConfig;
use fabrico_host::driver::Host;
use fabrico_host::ledger::DispatchLedger;
use fabrico_host::project::{load_project, save_project};
use fabrico_host::render_packet::RenderProducer;
use fabrico_host::sim_loop::{GestureSink, SimLoop, gesture_channel};
use fabrico_protocol::{machine_kind, BeltEnd, GridCommand, RenderPacket};

/// The genesis seed shared by every live host in this file — the SAME seed
/// `replay_two_logs` re-genesis's from in Proof 1 (a mismatch would diverge the
/// snapshot). `Core::genesis` expands this one-way, so it must be pinned here.
const SEED: u64 = 1;

fn header() -> LogHeader {
    LogHeader {
        schema_version: SCHEMA_VERSION,
        seed: SEED,
    }
}

fn test_rt() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("build executor runtime")
}

fn test_cfg() -> HostConfig {
    HostConfig {
        webhook_addr: "127.0.0.1:0".parse().expect("loopback addr"),
    }
}

/// Build an offline-safe host on temp redb, running `build` against its [`Core`]
/// first (topology construction), mirroring `sim_loop.rs`'s `build_host` /
/// `tests/ingress.rs`.
fn build_host(dir: &std::path::Path, build: impl FnOnce(&mut Core)) -> Host {
    let mut core = Core::genesis(header());
    build(&mut core);
    let store = RedbStore::open(dir.join("log.redb")).expect("open log");
    let ledger = DispatchLedger::open(dir.join("ledger.redb")).expect("open ledger");
    Host::new(core, store, ledger, None).expect("open host")
}

/// UNDO-04: a live Playing loop folds Undo/Redo — a placed machine DISAPPEARS on
/// Undo and REAPPEARS on Redo, and the folded batch carries `EditOp::Undo`/`Redo`
/// lineage markers (the routed-and-accepted proof; a `Malformed` reject would enqueue
/// NOTHING, so the markers' presence certifies the gesture was NOT rejected).
#[test]
fn live_undo_redo_folds() {
    let rt = test_rt();
    let dir = tempfile::tempdir().expect("tempdir");
    // Empty genesis grid: the Place below is the only live topology.
    let host = build_host(dir.path(), |_c| {});
    let (gtx, grx) = gesture_channel();
    let mut sim = SimLoop::new(host, RenderProducer::new(), rt.handle(), test_cfg(), grx);

    // Place a machine, fold it EDITS-FIRST in one live tick.
    gtx.send_gesture(GridCommand::Place {
        kind: machine_kind::SOURCE,
        cell_x: 0,
        cell_y: 0,
    })
    .expect("send place gesture");
    sim.run(Some(1), Duration::ZERO).expect("fold the place");
    assert_eq!(
        sim.host().core().state.node_count(),
        1,
        "the placed machine is live before the undo"
    );
    assert!(sim.host().can_undo(), "the placement is undoable");
    assert!(!sim.host().can_redo(), "nothing to redo yet");

    // Undo — the node disappears; the folded batch carries an EditOp::Undo marker
    // (routed to resolve_undo BEFORE validate_normalize, so NOT Malformed — UNDO-04).
    gtx.send_gesture(GridCommand::Undo).expect("send undo gesture");
    sim.run(Some(1), Duration::ZERO).expect("fold the undo");
    assert_eq!(
        sim.host().core().state.node_count(),
        0,
        "the machine disappeared on Undo"
    );
    assert!(
        sim.host()
            .logged_edits()
            .expect("read edit log")
            .iter()
            .any(|r| matches!(r.op, EditOp::Undo { .. })),
        "the Undo was routed + accepted (an EditOp::Undo marker folded) — NOT Malformed"
    );
    assert!(!sim.host().can_undo(), "nothing left to undo after the undo");
    assert!(sim.host().can_redo(), "the undone placement is redoable");

    // Redo — the node reappears; the folded batch carries an EditOp::Redo marker.
    gtx.send_gesture(GridCommand::Redo).expect("send redo gesture");
    sim.run(Some(1), Duration::ZERO).expect("fold the redo");
    assert_eq!(
        sim.host().core().state.node_count(),
        1,
        "the machine reappeared on Redo"
    );
    assert!(
        sim.host()
            .logged_edits()
            .expect("read edit log")
            .iter()
            .any(|r| matches!(r.op, EditOp::Redo { .. })),
        "the Redo was routed + accepted (an EditOp::Redo marker folded) — NOT Malformed"
    );
    assert!(sim.host().can_undo(), "the redone placement is undoable again");
}

/// Phase 19 CONTRACT (regression): REPEATED undo/redo cycles stay correct on a
/// COMMAND-BUILT scene — one whose topology entered through the edit-log (the Phase 19
/// single-`GridSession`-authority model). The engine derives all node identity from the
/// edit-log (`reconstruct_projection` re-folds the log on a fresh genesis core to build
/// the `xlate`), so it is correct ONLY when the core matches the log.
///
/// NOTE (cross-phase, closed in Phase 20): the legacy direct-seeded showcase
/// (which bypassed the edit-log via `core.state.add_*` and made
/// repeated undo/redo diverge) is GONE - both entrypoints now boot the command-built
/// `demo_scene::boot_scene` scene, applied through the certified gesture path one
/// command per tick, so this test's double-cycle contract covers the SHIPPED default
/// by construction. It pins that undo/redo ITSELF is correct on a log-consistent
/// scene: a second undo/redo cycle used to leak a node when driven over a
/// direct-seeded scene; here it must not.
#[test]
fn live_undo_redo_double_cycle_on_command_built_scene() {
    let rt = test_rt();
    let dir = tempfile::tempdir().expect("tempdir");
    // Empty genesis — the ENTIRE baseline below is built through the edit-log (commands).
    let host = build_host(dir.path(), |_c| {});
    let (gtx, grx) = gesture_channel();
    let mut sim = SimLoop::new(host, RenderProducer::new(), rt.handle(), test_cfg(), grx);

    // Command-built baseline: two Sources entered THROUGH the edit-log, each folded.
    gtx.send_gesture(GridCommand::Place { kind: machine_kind::SOURCE, cell_x: 0, cell_y: 0 })
        .expect("send baseline place 1");
    sim.run(Some(1), Duration::ZERO).expect("fold baseline place 1");
    gtx.send_gesture(GridCommand::Place { kind: machine_kind::SOURCE, cell_x: 5, cell_y: 0 })
        .expect("send baseline place 2");
    sim.run(Some(1), Duration::ZERO).expect("fold baseline place 2");
    let baseline = sim.host().core().state.node_count();
    assert_eq!(baseline, 2, "two command-built baseline sources");

    // The node we undo/redo repeatedly.
    gtx.send_gesture(GridCommand::Place { kind: machine_kind::SOURCE, cell_x: 10, cell_y: 0 })
        .expect("send place");
    sim.run(Some(1), Duration::ZERO).expect("fold place");
    assert_eq!(sim.host().core().state.node_count(), baseline + 1, "after place");

    // TWO full undo/redo cycles — the count must return EXACTLY each time (no leak,
    // no over-delete). The second cycle is the regression that a direct-seeded scene
    // breaks.
    for cycle in 0..2 {
        gtx.send_gesture(GridCommand::Undo).expect("send undo");
        sim.run(Some(1), Duration::ZERO).expect("fold undo");
        assert_eq!(
            sim.host().core().state.node_count(),
            baseline,
            "node removed cleanly on undo (cycle {cycle})"
        );
        gtx.send_gesture(GridCommand::Redo).expect("send redo");
        sim.run(Some(1), Duration::ZERO).expect("fold redo");
        assert_eq!(
            sim.host().core().state.node_count(),
            baseline + 1,
            "node restored cleanly on redo, no duplicate leaked (cycle {cycle})"
        );
    }
}

/// CR-01 REGRESSION: MULTIPLE Undo/Redo gestures batched into a SINGLE drain must
/// step the undo cursor discretely (one action per undo), never desync it.
///
/// The gesture channel is drained in one `while try_recv()` loop per tick
/// (`acquire_input`), but `resolve_undo`/`resolve_redo` read the session projection
/// (cursor) which only refreshes in `fold_live` — once per tick. Before the CR-01 fix,
/// two undos in one drain both resolved against the same pre-fold cursor, targeted the
/// SAME action, enqueued duplicate inverse groups, and decremented the cursor twice
/// while the core reversed the action only once — leaving a node behind (and a later
/// redo re-minting a live node → leak). The fix forces a tick boundary after each
/// undo/redo drained so its `fold_live`→`reconstruct_projection` runs before the next
/// resolves; remaining gestures stay queued for the following tick.
///
/// Reproduction: two Sources A/B built through the edit-log, then TWO Undo gestures
/// enqueued BEFORE running the sim (so both sit in the channel for one drain). Running
/// the loop must undo BOTH discretely (node_count → 0), then two Redo gestures must
/// restore BOTH discretely (node_count → 2, no duplicate/leak). Pre-fix this FAILS
/// (the batched drain undoes only B, leaving A → node_count 1 ≠ 0).
#[test]
fn batched_same_tick_undo_redo_steps_discretely() {
    let rt = test_rt();
    let dir = tempfile::tempdir().expect("tempdir");
    // Empty genesis — both baseline sources enter THROUGH the edit-log (commands), so
    // the core matches the log and reconstruct_projection mints consistent ids.
    let host = build_host(dir.path(), |_c| {});
    let (gtx, grx) = gesture_channel();
    let mut sim = SimLoop::new(host, RenderProducer::new(), rt.handle(), test_cfg(), grx);

    // Two distinct undoable placements (action0 = A, action1 = B), each folded.
    gtx.send_gesture(GridCommand::Place { kind: machine_kind::SOURCE, cell_x: 0, cell_y: 0 })
        .expect("send place A");
    sim.run(Some(1), Duration::ZERO).expect("fold place A");
    gtx.send_gesture(GridCommand::Place { kind: machine_kind::SOURCE, cell_x: 5, cell_y: 0 })
        .expect("send place B");
    sim.run(Some(1), Duration::ZERO).expect("fold place B");
    assert_eq!(sim.host().core().state.node_count(), 2, "two placed sources");
    assert!(sim.host().can_undo(), "both placements undoable");

    // Enqueue TWO Undo gestures BEFORE running — both sit in the channel for one drain
    // (the batched-flush case: e.g. pause → Ctrl+Z×2 → resume). Run enough ticks for
    // the fix to drain them one-per-tick; pre-fix a single tick drains both (the bug).
    gtx.send_gesture(GridCommand::Undo).expect("send undo 1");
    gtx.send_gesture(GridCommand::Undo).expect("send undo 2");
    sim.run(Some(2), Duration::ZERO).expect("fold the batched undos");

    assert_eq!(
        sim.host().core().state.node_count(),
        0,
        "BOTH placements undone discretely (pre-fix leaves A behind → count 1)"
    );
    assert!(!sim.host().can_undo(), "undo stack exhausted after two discrete undos");
    assert!(sim.host().can_redo(), "both undone placements are redoable");

    // Symmetric redo: TWO Redo gestures batched into the channel must restore BOTH
    // discretely — never re-mint a still-live node (the CR-01 leak signature).
    gtx.send_gesture(GridCommand::Redo).expect("send redo 1");
    gtx.send_gesture(GridCommand::Redo).expect("send redo 2");
    sim.run(Some(2), Duration::ZERO).expect("fold the batched redos");

    assert_eq!(
        sim.host().core().state.node_count(),
        2,
        "BOTH placements restored discretely — no duplicate/leaked node (CR-01)"
    );
    assert!(sim.host().can_undo(), "restored placements undoable again");
    assert!(!sim.host().can_redo(), "redo stack exhausted after two discrete redos");
}

/// GAP N3-RACE (plan 74.1-23): A CTRL+Z ON THE SAME TICK AS A JOIN UNDOES THE JOIN.
///
/// The walk (74.1-REWALK-2, N3) logged `seq 73 Dock, 74 Undo{target 53}, 75 Delete` on one
/// tick: the Dock and the Undo were drained in ONE pass, the Undo resolved against a
/// projection that did not yet hold the Dock, targeted the second belt's `DrawBelt` and
/// deleted that belt, and every later Ctrl+Z was refused `Malformed`.
///
/// The board is the walk's N3 board: belt A drawn four cells north, (5,9) to (5,6), so its
/// Head is the top tile; belt B starting on the tile right of A's top tile, (6,6) to (8,6).
/// The Dock (A's Head onto B's Tail) and the Undo are queued with NO `run` between them, so
/// both sit in the channel for one drain pass. After the loop runs: both belts stand, they
/// are not joined, the Undo marker names the Dock's action, and a further Undo removes B.
#[test]
fn a_same_tick_undo_after_a_join_undoes_the_join_and_keeps_both_belts() {
    let rt = test_rt();
    let dir = tempfile::tempdir().expect("tempdir");
    let host = build_host(dir.path(), |_c| {});
    let (gtx, grx) = gesture_channel();
    let mut sim = SimLoop::new(host, RenderProducer::new(), rt.handle(), test_cfg(), grx);

    gtx.send_gesture(GridCommand::DrawBelt {
        cells: vec![(5, 9), (5, 8), (5, 7), (5, 6)],
    })
    .expect("send belt A");
    sim.run(Some(1), Duration::ZERO).expect("fold belt A");
    let a = *sim.host().core().last_tick.placed.last().expect("belt A minted");
    gtx.send_gesture(GridCommand::DrawBelt {
        cells: vec![(6, 6), (7, 6), (8, 6)],
    })
    .expect("send belt B");
    sim.run(Some(1), Duration::ZERO).expect("fold belt B");
    let b = *sim.host().core().last_tick.placed.last().expect("belt B minted");
    assert_ne!(a, b, "two belts");
    let a_h = sim.handle_for_node(a).expect("belt A has a render handle");
    let b_h = sim.handle_for_node(b).expect("belt B has a render handle");
    let b_draw_action = sim
        .host()
        .logged_edits()
        .expect("read edit log")
        .iter()
        .rev()
        .find(|r| matches!(r.op, EditOp::DrawBelt { .. }))
        .expect("B's DrawBelt is logged")
        .action;

    // The join and the Ctrl+Z, queued together: one drain pass meets both.
    gtx.send_gesture(GridCommand::Dock {
        belt: a_h,
        endpoint: BeltEnd::Head,
        node: b_h,
        port: 0,
    })
    .expect("send the join");
    gtx.send_gesture(GridCommand::Undo).expect("send the undo");
    sim.run(Some(2), Duration::ZERO).expect("fold the join and the undo");

    let edits = sim.host().logged_edits().expect("read edit log");
    let dock_action = edits
        .iter()
        .find(|r| matches!(r.op, EditOp::Dock { .. }))
        .expect("the join folded")
        .action;
    let undo_targets: Vec<u64> = edits
        .iter()
        .filter_map(|r| match r.op {
            EditOp::Undo { target_action } => Some(target_action),
            _ => None,
        })
        .collect();
    let core = sim.host().core();
    assert!(core.state.node(b).is_some(), "belt B survives the same-tick undo (N3-RACE)");
    assert!(core.state.node(a).is_some(), "belt A survives the same-tick undo");
    assert_eq!(core.state.node_count(), 2, "both belts stand");
    assert_eq!(core.state.links_iter().count(), 0, "the belts are no longer joined");
    assert_eq!(undo_targets, vec![dock_action], "the one Undo marker names the join");

    // Undo is not dead: the next Ctrl+Z is accepted and takes belt B's draw back.
    gtx.send_gesture(GridCommand::Undo).expect("send the next undo");
    sim.run(Some(1), Duration::ZERO).expect("fold the next undo");
    let edits = sim.host().logged_edits().expect("read edit log");
    let last_target = edits.iter().rev().find_map(|r| match r.op {
        EditOp::Undo { target_action } => Some(target_action),
        _ => None,
    });
    assert_eq!(last_target, Some(b_draw_action), "the next undo names B's draw");
    let core = sim.host().core();
    assert!(core.state.node(b).is_none(), "the next undo removes belt B");
    assert!(core.state.node(a).is_some(), "and leaves belt A");
    assert!(sim.host().can_undo(), "belt A's draw is still undoable");
}

/// UNDO-06: undoing a placed Source broadcasts a `full:true` keyframe over the diff
/// channel (a diff cannot express re-minted ids + cascade restores) AND the LIVE
/// webhook route table recomputes — the removed Source drops out (no dangling handle).
#[test]
fn undo_emits_keyframe_and_reroutes() {
    let rt = test_rt();
    let dir = tempfile::tempdir().expect("tempdir");
    // Empty genesis grid so the placed Source is the ONLY route-table entry.
    let host = build_host(dir.path(), |_c| {});
    let (gtx, grx) = gesture_channel();
    let mut sim = SimLoop::new(host, RenderProducer::new(), rt.handle(), test_cfg(), grx);

    // A live subscriber (a webview) on the diff broadcast + the live route table.
    let (_kf_rx, mut diff_rx) = sim.subscribe();
    let mut routes_rx = sim.routes_receiver();

    // Place a Source, fold it — the route projection publishes its id-derived label.
    gtx.send_gesture(GridCommand::Place {
        kind: machine_kind::SOURCE,
        cell_x: 0,
        cell_y: 0,
    })
    .expect("send place-source gesture");
    sim.run(Some(1), Duration::ZERO).expect("fold the place");

    let routes_after_place = routes_rx.borrow_and_update().clone();
    assert_eq!(
        routes_after_place.len(),
        1,
        "the placed Source is projected into the route table"
    );
    let placed_source = *routes_after_place
        .values()
        .next()
        .expect("the projected Source NodeId");

    // Drain queued packets so the next try_recv sees only the undo tick's broadcast.
    while diff_rx.try_recv().is_ok() {}

    // Undo the Source — the undo-folding tick emits a full:true keyframe.
    gtx.send_gesture(GridCommand::Undo).expect("send undo gesture");
    sim.run(Some(1), Duration::ZERO).expect("fold the undo");

    let bytes = diff_rx
        .try_recv()
        .expect("the undo reset rides the diff broadcast (subscriber not Closed)");
    let pkt: RenderPacket = postcard::from_bytes(&bytes.bytes).expect("decode undo packet");
    assert!(
        pkt.full,
        "the undo-folding tick broadcasts a full:true keyframe (UNDO-06)"
    );
    assert!(
        pkt.placed.is_empty(),
        "undo removed the only Source -> the keyframe scene is empty"
    );

    // The route table recomputed: the removed Source is gone (no dangling handle).
    let routes_after_undo = routes_rx.borrow_and_update().clone();
    assert!(
        !routes_after_undo.values().any(|&id| id == placed_source),
        "the removed Source dropped out of the recomputed route table"
    );
    assert!(
        routes_after_undo.is_empty(),
        "no Sources remain after undoing the only placement"
    );
}

/// UNDO-05: undo history survives a redb save→load round-trip. Place → Undo →
/// `save_project` to a `.fab` → reopen via `load_project` into a FRESH Host; the
/// reloaded `can_undo`/`can_redo` and the core snapshot equal the live session (the
/// LIVE analog of the headless `undo_save_load` round-trip).
#[test]
fn undo_survives_save_load_live() {
    let rt = test_rt();
    let src_dir = tempfile::tempdir().expect("source tempdir");
    // Empty genesis grid; place then undo so the persisted log carries the full arc.
    let host = build_host(src_dir.path(), |_c| {});
    let (gtx, grx) = gesture_channel();
    let mut sim = SimLoop::new(host, RenderProducer::new(), rt.handle(), test_cfg(), grx);

    gtx.send_gesture(GridCommand::Place {
        kind: machine_kind::SOURCE,
        cell_x: 0,
        cell_y: 0,
    })
    .expect("send place gesture");
    sim.run(Some(1), Duration::ZERO).expect("fold the place");
    gtx.send_gesture(GridCommand::Undo).expect("send undo gesture");
    sim.run(Some(1), Duration::ZERO).expect("fold the undo");

    // The LIVE post-undo state: node gone, redo available, undo exhausted.
    assert_eq!(sim.host().core().state.node_count(), 0, "node gone post-undo");
    assert!(!sim.host().can_undo(), "undo exhausted live");
    assert!(sim.host().can_redo(), "redo available live");
    let live_snapshot = snapshot(sim.host().core());
    let live_can_undo = sim.host().can_undo();
    let live_can_redo = sim.host().can_redo();

    // SAVE: the host is quiescent (source-only, nothing in flight), so save_project
    // accepts it.
    assert_eq!(
        sim.host().in_flight_len(),
        0,
        "the live scene is quiescent (save precondition)"
    );
    let fab = src_dir.path().join("scene.fab");
    save_project(sim.host(), &fab).expect("save the live undo scene");

    // LOAD into a FRESH Host over a fresh work_dir (redb round-trip via recover()).
    let load_dir = tempfile::tempdir().expect("load work_dir");
    let reloaded = load_project(&fab, load_dir.path(), None).expect("reopen the saved scene");

    assert_eq!(
        reloaded.can_undo(),
        live_can_undo,
        "can_undo survives the save/load round-trip"
    );
    assert_eq!(
        reloaded.can_redo(),
        live_can_redo,
        "can_redo (the surviving redo lineage) survives the save/load round-trip"
    );
    assert_eq!(
        snapshot(reloaded.core()),
        live_snapshot,
        "the reloaded core snapshot is byte-identical to the live one (UNDO-05 save/load)"
    );
}

/// PROOF 1 (UNDO-05 — the heart of the phase's Nyquist gate): the PERSISTED live
/// undo/redo edit+event log replays from genesis to a byte-identical frozen state.
///
/// Drive a live SimLoop (Playing) through Place A / Place B / DrawBelt / Undo / Redo
/// (ticking between each), read the PERSISTED redb logs (`host.logged_edits()` +
/// `host.logged_events()` — NOT the session's in-memory copy), replay from genesis via
/// `GridSession::replay_two_logs(SEED, &edits, &events)`, and assert byte-identical
/// `snapshot(core)`. This rides the proven ELOG-02 replay-equivalence contract: live
/// undo/redo records are ordinary `EditRecord`s, so replay reproduces them for free —
/// the LIVE analog of Phase 12's headless `undo_survives_save_load`.
#[test]
fn live_undo_replays_byte_identical() {
    let rt = test_rt();
    let dir = tempfile::tempdir().expect("tempdir");
    // Empty genesis grid — every node below is minted by a live gesture.
    let host = build_host(dir.path(), |_c| {});
    let (gtx, grx) = gesture_channel();
    let mut sim = SimLoop::new(host, RenderProducer::new(), rt.handle(), test_cfg(), grx);

    // Place A, tick.
    gtx.send_gesture(GridCommand::Place {
        kind: machine_kind::SOURCE,
        cell_x: 0,
        cell_y: 0,
    })
    .expect("send place A");
    sim.run(Some(1), Duration::ZERO).expect("fold place A");

    // Place B, tick.
    gtx.send_gesture(GridCommand::Place {
        kind: machine_kind::SOURCE,
        cell_x: 2,
        cell_y: 0,
    })
    .expect("send place B");
    sim.run(Some(1), Duration::ZERO).expect("fold place B");

    // DrawBelt on a clear path, tick.
    gtx.send_gesture(GridCommand::DrawBelt {
        cells: vec![(4, 0), (5, 0)],
    })
    .expect("send draw belt");
    sim.run(Some(1), Duration::ZERO).expect("fold draw belt");

    // Undo (undoes the belt), tick.
    gtx.send_gesture(GridCommand::Undo).expect("send undo");
    sim.run(Some(1), Duration::ZERO).expect("fold the undo");

    // Redo (re-draws the belt), tick.
    gtx.send_gesture(GridCommand::Redo).expect("send redo");
    sim.run(Some(1), Duration::ZERO).expect("fold the redo");

    // Read the PERSISTED redb logs — the durable source of truth (ELOG-02).
    let edits = sim.host().logged_edits().expect("read persisted edit log");
    let events = sim.host().logged_events().expect("read persisted event log");

    // Replay from genesis on a THROWAWAY session — the same seed the live host
    // genesis'd from, so the re-fold mints identical ids in fold order.
    let replayed = GridSession::replay_two_logs(SEED, &edits, &events);

    assert_eq!(
        snapshot(replayed.core()),
        snapshot(sim.host().core()),
        "the PERSISTED live undo/redo log replays from genesis to a byte-identical \
         frozen state (UNDO-05, Proof 1)"
    );
}
