//! THE REGRESSION PIN for `demo-timer-wiped-on-first-edit`: the shipped demo
//! scene must KEEP INJECTING after the user's first edit, whatever that edit is.
//!
//! # The defect this file exists to keep dead
//! `SimLoop::tick_body` re-derives the host `TimerSet` from the certified edit-log
//! on every gesture tick and installs it with `Host::set_timers`, which REPLACES
//! rather than merges. When the demo timer was installed imperatively
//! (`with_timers(demo_timers(&scene))`) and never entered the edit-log,
//! `project_timers` returned an EMPTY set and the first edit of any kind silently
//! and permanently stopped the shipped board. Measured before the fix: 75 logged
//! injections in the 600 ticks before an Apply, ZERO in the 600 after. This was hit
//! twice in one session without being recognised as a defect.
//!
//! # Why the assertion is "injections into the SOURCE", not "items on a belt"
//! A logged `ManualInject` is produced by `TimerSet::due_events` and appended by
//! `tick_once` regardless of what the grid downstream does. It is therefore a
//! DIRECT read of the live timer set and is immune to belt backpressure, factory
//! faults, and sink drain rate - all of which change when you edit the board. An
//! item-count assertion would be confounded by exactly the thing under test.
//!
//! # The three gestures
//! `folded_edits` - the guard on the wiping re-derive - is true for EVERY
//! edit-bearing gesture, which is why the defect did not care what the user did.
//! So all three families are pinned separately, each on its OWN freshly-booted
//! demo board: `Configure` (the original report), `Place` (belts drawn earlier
//! the same day, from the other end of the same defect) and `Undo`.
//!
//! # Each arm proves the gesture actually FOLDED
//! A gesture that is rejected at validate time enqueues nothing, leaves
//! `folded_edits` false, and would therefore sail past a naive injection count on
//! the BROKEN tree - a check structurally incapable of failing. Every arm below
//! asserts a visible consequence of its own gesture (the factory's JS bytes
//! changed / the node count grew / an `EditOp::Undo` marker landed in the log)
//! BEFORE it asserts anything about timers.

use std::time::Duration;

use fabrico_core::core::Core;
use fabrico_core::edit::EditOp;
use fabrico_core::event::{Event, EventPayload, LogHeader, SCHEMA_VERSION};
use fabrico_core::ids::NodeId;
use fabrico_core::persist::RedbStore;
use fabrico_core::state::Node;
use fabrico_host::config::HostConfig;
use fabrico_host::demo_scene::{DEMO_GENESIS_SEED, SceneId, boot_scene};
use fabrico_host::driver::Host;
use fabrico_host::ledger::DispatchLedger;
use fabrico_host::render_packet::RenderProducer;
use fabrico_host::sim_loop::{GestureSink, GestureTx, SimLoop, gesture_channel};
use fabrico_protocol::{GridCommand, MachineConfig, machine_kind};

/// Ticks run BEFORE the gesture, to establish the board is alive at all. At the
/// demo's interval of 8 this is ~25 injections - a baseline no boundary effect
/// can fake.
const PRIME_TICKS: u64 = 200;

/// Ticks run AFTER the gesture. The bug report's own bar: "still injects for at
/// least 400 ticks after each of Configure, Place and Undo".
const WATCH_TICKS: u64 = 400;

/// The floor the post-gesture window must clear. The demo injects every 8 ticks,
/// so 400 ticks is ~50 injections; 40 leaves generous room for tick-boundary
/// alignment while staying orders of magnitude above the ZERO the defect produced.
const MIN_INJECTS_AFTER: usize = 40;

/// The dense render handle of the demo scene's FACTORY. Handles mint monotonic
/// from 0 in mint order and the FACTORY is the second `Place` in
/// `examples/boards/demo_scene.board.ron`; the `configure` arm asserts the JS actually changed,
/// so a drift in this convention fails loudly rather than passing vacuously.
const FACTORY_HANDLE: u64 = 1;

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

/// Boot the SHIPPED demo board through the call the Tauri shell makes
/// (`fabrico-app/src/lib.rs`: genesis -> `boot_scene` -> `SimLoop::new`; `boot_scene`
/// seeds, seals and projects the timers). Booting it any other way would test a board
/// no user ever sees.
fn boot_demo(dir: &std::path::Path) -> (Host, NodeId) {
    let core = Core::genesis(LogHeader {
        schema_version: SCHEMA_VERSION,
        seed: DEMO_GENESIS_SEED,
    });
    let store = RedbStore::open(dir.join("log.redb")).expect("open log");
    let ledger = DispatchLedger::open(dir.join("ledger.redb")).expect("open ledger");
    let host = Host::new(core, store, ledger, None).expect("open host");
    let host = boot_scene(host, SceneId::Demo).unwrap_or_else(|e| panic!("{e}"));
    // The demo's one SOURCE is the timer's target.
    let state = &host.core().state;
    let source = state
        .node_ids()
        .find(|&id| matches!(state.node(id), Some(Node::Source(_))))
        .expect("the demo carries its item SOURCE");
    (host, source)
}

/// Count the logged timer injections that targeted `source` - a direct read of
/// the live `TimerSet`, unconfounded by anything downstream on the grid.
fn injects_into(events: &[Event], source: NodeId) -> usize {
    events
        .iter()
        .filter(|e| matches!(e.payload, EventPayload::ManualInject { target, .. } if target == source))
        .count()
}

/// The shared body: boot the demo, prove it is injecting, apply ONE gesture via
/// `apply`, prove the gesture folded, then prove the board is STILL injecting
/// across the next [`WATCH_TICKS`].
///
/// `apply` receives the live sim so it can send its gesture and assert its own
/// folded-ness; it returns a label used in the failure messages.
fn assert_demo_keeps_injecting_after(
    label: &str,
    apply: impl FnOnce(&mut SimLoop, &GestureTx),
) {
    let rt = test_rt();
    let dir = tempfile::tempdir().expect("tempdir");
    let (host, source) = boot_demo(dir.path());
    let (gtx, grx) = gesture_channel();
    let mut sim = SimLoop::new(host, RenderProducer::new(), rt.handle(), test_cfg(), grx);

    // ── Baseline: the shipped board injects on its own ───────────────────────
    sim.run(Some(PRIME_TICKS), Duration::ZERO)
        .expect("prime run");
    let before = injects_into(&sim.host().logged_events().expect("read log"), source);
    assert!(
        before > 0,
        "[{label}] PRECONDITION: the shipped demo board must be injecting BEFORE \
         the gesture (got {before} injections in {PRIME_TICKS} ticks) - without \
         this the post-gesture assertion proves nothing"
    );

    // ── The user's first edit ────────────────────────────────────────────────
    apply(&mut sim, &gtx);

    // ── The pin: the board is STILL alive 400 ticks later ────────────────────
    let at_gesture = injects_into(&sim.host().logged_events().expect("read log"), source);
    sim.run(Some(WATCH_TICKS), Duration::ZERO)
        .expect("post-gesture run");
    let after = injects_into(&sim.host().logged_events().expect("read log"), source);
    let produced = after - at_gesture;

    assert!(
        produced >= MIN_INJECTS_AFTER,
        "[{label}] THE DEMO BOARD DIED ON THE FIRST EDIT. Only {produced} timer \
         injections into the SOURCE in the {WATCH_TICKS} ticks after the gesture \
         (expected >= {MIN_INJECTS_AFTER}; {before} had already fired before it). \
         The shipped demo timer must survive every edit-bearing gesture - the \
         edit-log projection in SimLoop::tick_body REPLACES the live TimerSet, so \
         the demo timer has to BE in the edit-log."
    );
}

/// The original gesture: open the FACTORY's config panel and Apply new JS.
#[test]
fn demo_timer_survives_a_configure() {
    assert_demo_keeps_injecting_after("Configure", |sim, gtx| {
        let before_js = factory_source(sim);
        gtx.send_gesture(GridCommand::Configure {
            node: FACTORY_HANDLE,
            config: MachineConfig::Factory {
                source: "export default function (input, ctx) { ctx.emit(0, input); }\n// edited"
                    .to_owned(),
            },
        })
        .expect("send configure gesture");
        sim.run(Some(1), Duration::ZERO).expect("fold the configure");
        let after_js = factory_source(sim);
        assert_ne!(
            before_js, after_js,
            "the Configure must actually FOLD (the factory's JS bytes changed) - a \
             rejected gesture leaves folded_edits false and would make the timer \
             assertion below structurally incapable of failing"
        );
    });
}

/// The gesture made earlier the same day without recognising the defect: the user
/// drew belts on the demo board and the item dots vanished.
#[test]
fn demo_timer_survives_a_place() {
    assert_demo_keeps_injecting_after("Place", |sim, gtx| {
        let before = sim.host().core().state.node_count();
        // (0,12) is well clear of the demo's bounding box (rows 0..8).
        gtx.send_gesture(GridCommand::Place {
            kind: machine_kind::SINK,
            cell_x: 0,
            cell_y: 12,
        })
        .expect("send place gesture");
        sim.run(Some(1), Duration::ZERO).expect("fold the place");
        assert_eq!(
            sim.host().core().state.node_count(),
            before + 1,
            "the Place must actually FOLD (one new node on the grid) - a rejected \
             gesture would make the timer assertion below unable to fail"
        );
    });
}

/// Ctrl+Z on the demo board. Undoing must not take the item source down with it.
///
/// RE-POINTED by plan 85-06 (D-10, DEMO-05). This used to undo the demo's own last
/// authoring command on the freshly booted board. A seeded scene now ends with the history
/// seal, so nothing of the scene is undoable (the precondition below was false). The test
/// therefore undoes the user's OWN first edit (a Sink placed well clear of the scene), which
/// is the same Undo fold, the same timer re-projection and the same property: an Undo on
/// the demo board leaves the Source injecting.
#[test]
fn demo_timer_survives_an_undo() {
    assert_demo_keeps_injecting_after("Undo", |sim, gtx| {
        assert!(
            !sim.host().can_undo(),
            "the freshly seeded demo has nothing to undo (the history seal, plan 85-06)"
        );
        let before = sim.host().core().state.node_count();
        // (0,12) is well clear of the demo's bounding box (rows 0..8).
        gtx.send_gesture(GridCommand::Place {
            kind: machine_kind::SINK,
            cell_x: 0,
            cell_y: 12,
        })
        .expect("send the user's own place gesture");
        sim.run(Some(1), Duration::ZERO).expect("fold the place");
        assert_eq!(sim.host().core().state.node_count(), before + 1, "the user's own Place folded");
        assert!(
            sim.host().can_undo(),
            "PRECONDITION: the user's own edit on the demo board is undoable"
        );
        gtx.send_gesture(GridCommand::Undo).expect("send undo gesture");
        sim.run(Some(1), Duration::ZERO).expect("fold the undo");
        assert!(
            sim.host()
                .logged_edits()
                .expect("read edit log")
                .iter()
                .any(|r| matches!(r.op, EditOp::Undo { .. })),
            "the Undo must actually FOLD (an EditOp::Undo lineage marker landed in \
             the edit-log) - a Malformed reject would make the timer assertion \
             below unable to fail"
        );
        assert_eq!(sim.host().core().state.node_count(), before, "the Undo removed the user's own Sink");
    });
}

/// The FACTORY's live JS bytes, read straight off the folded core.
fn factory_source(sim: &SimLoop) -> String {
    let state = &sim.host().core().state;
    state
        .node_ids()
        .find_map(|id| match state.node(id) {
            // The demo's order-making FACTORY sits at (4,2); the HTTP Handler (which
            // folds to a Factory too) sits elsewhere.
            Some(Node::Factory(f)) if state.cell_of(id) == Some((4, 2)) => Some(f.source.clone()),
            _ => None,
        })
        .expect("the demo scene's FACTORY is at (4,2)")
}
