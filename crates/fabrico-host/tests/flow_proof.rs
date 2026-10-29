//! THE FLOW PROOF (Phase 20, LIVE-02/LIVE-05 — RESEARCH Finding 1): the first test
//! anywhere that flows an item through a COMMAND-DOCKED multi-port Out.
//!
//! Before this test, a green `Dock` proved only TOPOLOGY (the link exists) — never
//! that items FLOW across it. That gap hid the Out-dock link keyspace mismatch: a
//! command dock froze the catalog ARRAY index (FACTORY Out = 1, TEE Outs = 1/2) while
//! machines emit on ROUTING port ids (FACTORY emits on 0, TEE on 0/1), so every item
//! a command-docked factory emitted silently vanished at the missing link
//! ("Why nothing caught this": `01-exit-gate` deliberately leaves its Out belt
//! dangling; `02`/`03` dock only port-0 SOURCE/SINK ports, aligned by luck; the
//! legacy direct-seeded showcase (deleted in Phase 20) used raw assembly `link()` keys).
//!
//! This test builds a real chain ENTIRELY from `GridCommand`s over a real `Host`
//! (tempfile redb), one command per tick through `apply_gesture` + `tick_once` —
//! never the test-only direct-core backdoor — then injects real `ManualInject`
//! items over the ingress
//! channel and counts the Commands the SINKS dispatch on a LIVE `cmd_rx`. The chain
//! covers BOTH mismatch cases in one scene:
//!
//! - FACTORY: catalog Out index 1 -> emit port 0 (the 1:1 passthrough),
//! - TEE: catalog Out indices 1/2 -> emit ports 0/1 (the fan-out, incl. the
//!   off-by-one second branch that previously delivered NOTHING).
//!
//! K items in => 2*K sink Commands out (the TEE broadcasts each item to BOTH
//! branches). A behavior assertion, not a count-of-links assertion.

use fabrico_core::belt_slots::DEFAULT_TICKS_PER_SLOT;
use fabrico_core::command::{Command, ResultEvent};
use fabrico_core::core::Core;
use fabrico_core::event::{EventPayload, LogHeader, SCHEMA_VERSION};
use fabrico_core::ids::{Item, NodeId};
use fabrico_core::persist::RedbStore;
use fabrico_host::driver::Host;
use fabrico_host::input_apply::apply_gesture;
use fabrico_host::ledger::DispatchLedger;
use fabrico_protocol::{BeltEnd, GridCommand, machine_kind};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};

/// The genesis seed (value free — determinism only requires it be pinned).
const SEED: u64 = 7;
/// Items injected into the source; the TEE fans each out to BOTH sinks => 2*K
/// dispatched sink Commands.
const K: usize = 3;
/// Generous settle headroom: a belt advances one slot every `ticks_per_slot` ticks
/// and a tile is `SLOTS_PER_TILE = 4` slots (Phase 60 / SLOT-01 moved it from 3), so
/// a tile costs `4 * ticks_per_slot` ticks. The whole chain is ~12 belt tiles, so
/// ~48 belt ticks at an interval of one, plus factory/tee processing.
///
/// # A BUDGET, therefore DERIVED (SLOT-03, plan 62-03)
/// The belt leg scales one-for-one with the advance interval, so this stretches with
/// it instead of being a literal somebody has to remember to move.
///
/// # REASONED, NOT MEASURED, and said so on purpose
/// Unlike the `fabrico-core` and `fabrico-scenario` budgets this plan raised, no
/// probe was run against this one under a longer interval. The raise is an argument
/// from the chain's tile count, not an observation, and the honest reading is that
/// it is generous rather than that it is proven. The one interaction that would make
/// it fail differently rather than merely late: the debug sink synthesizes a Timeout
/// at 600 ticks, which changes WHAT this test observes rather than how long it waits.
/// The chain would have to actually take that long, needing an interval around 12,
/// far outside anything this phase runs.
const RUN_TICKS: usize = 300 * DEFAULT_TICKS_PER_SLOT.get() as usize;

/// A real `Host` over tempfile redb stores (mirrors `live_undo.rs::build_host` /
/// `input_apply.rs::test_host`), on an EMPTY genesis grid: the ENTIRE topology below
/// enters through the edit-log (commands), never a direct core write.
fn test_host() -> (tempfile::TempDir, Host) {
    let dir = tempfile::tempdir().expect("tempdir");
    let core = Core::genesis(LogHeader {
        schema_version: SCHEMA_VERSION,
        seed: SEED,
    });
    let store = RedbStore::open(dir.path().join("log.redb")).expect("open log");
    let ledger = DispatchLedger::open(dir.path().join("ledger.redb")).expect("open ledger");
    let host = Host::new(core, store, ledger, None).expect("open host");
    (dir, host)
}

/// The per-tick channels `tick_once` drains — UNLIKE `input_apply.rs::channels()`,
/// the `cmd` RECEIVER half is returned ALIVE so the test can count the sink Commands
/// step (6) of the tick dispatches (the whole point of the flow proof).
#[allow(clippy::type_complexity)]
fn channels() -> (
    UnboundedSender<EventPayload>,
    UnboundedReceiver<EventPayload>,
    UnboundedSender<Command>,
    UnboundedReceiver<Command>,
    UnboundedReceiver<ResultEvent>,
) {
    let (ingress_tx, ingress_rx) = unbounded_channel::<EventPayload>();
    let (cmd_tx, cmd_rx) = unbounded_channel::<Command>();
    let (_res_tx, results_rx) = unbounded_channel::<ResultEvent>();
    (ingress_tx, ingress_rx, cmd_tx, cmd_rx, results_rx)
}

/// One `ManualInject` of `item` into `target` on port 0 (the ingress payload shape
/// the webhook/timer sources produce; the host stamps tick/sequence).
fn inject(target: NodeId, item: &[u8]) -> EventPayload {
    EventPayload::ManualInject {
        target,
        port: 0,
        item: Item(item.to_vec()),
    }
}

/// THE FLOW PROOF: a SOURCE -> belt -> FACTORY -> belt -> TEE -> 2 belts -> 2 SINKs
/// chain built entirely from GridCommands (5 Place + 4 DrawBelt + 8 Dock, one command
/// per tick), then K pumped items, then exactly 2*K sink Commands on the live cmd_rx
/// with zero faults on every observed tick.
#[test]
fn command_docked_factory_and_tee_outs_deliver_to_both_sinks() {
    let (_dir, mut host) = test_host();
    let (ingress_tx, mut ingress_rx, cmd_tx, mut cmd_rx, mut results_rx) = channels();

    // Mint-order handle ledger: dense handle h resolves to minted[h] — the same
    // mint-order == handle-order convention the render producer / Scene use. Extended
    // from `last_tick.placed` after every tick (the per-tick observation is the only
    // reliable mint-order source).
    let mut minted: Vec<NodeId> = Vec::new();

    // Apply ONE command and fold it in ONE tick (RESEARCH Regenerability Constraint:
    // a Dock resolves its target via the live core, so each dependency must be FOLDED
    // a tick before its dependent — one command per tick makes that structural).
    let mut apply_one = |host: &mut Host, minted: &mut Vec<NodeId>, cmd: GridCommand, what: &str| {
        apply_gesture(host, cmd, |h| minted.get(h as usize).copied())
            .unwrap_or_else(|e| panic!("{what}: rejected with {e:?}"));
        host.tick_once(&mut ingress_rx, &mut results_rx, &cmd_tx)
            .unwrap_or_else(|e| panic!("{what}: tick failed with {e:?}"));
        minted.extend(host.core().last_tick.placed.iter().copied());
        assert!(
            host.core().last_tick.faulted.is_empty(),
            "{what}: no machine faults during the build"
        );
    };

    // ── BUILD: the geometry (all at rot 0, RESEARCH world-cell tables) ─────────────
    // SOURCE @ (0,3): Out = own cell, faces E (belt tail one step E at (1,3)).
    // FACTORY @ (3,2) 3×3: In (3,3) W (head at (2,3)); Out (5,3) E (tail at (6,3)).
    // TEE @ (8,3) 2×2: In (8,3) W (head at (7,3)); Outs (9,3)/(9,4) E (tails at
    // (10,3)/(10,4)).
    // SINK1 @ (12,3), SINK2 @ (12,4): In = own cell, faces W (heads at (11,3)/(11,4)).
    let place = |kind: u8, x: i32, y: i32| GridCommand::Place { kind, cell_x: x, cell_y: y };
    apply_one(&mut host, &mut minted, place(machine_kind::SOURCE, 0, 3), "place SOURCE");
    apply_one(&mut host, &mut minted, place(machine_kind::FACTORY, 3, 2), "place FACTORY");
    apply_one(&mut host, &mut minted, place(machine_kind::TEE, 8, 3), "place TEE");
    apply_one(&mut host, &mut minted, place(machine_kind::SINK, 12, 3), "place SINK1");
    apply_one(&mut host, &mut minted, place(machine_kind::SINK, 12, 4), "place SINK2");
    let (source_h, factory_h, tee_h, sink1_h, sink2_h) = (0u64, 1u64, 2u64, 3u64, 4u64);

    // Belts (drawn TAIL-first; each end docked explicitly below).
    let draw = |cells: &[(i32, i32)]| GridCommand::DrawBelt { cells: cells.to_vec() };
    apply_one(&mut host, &mut minted, draw(&[(1, 3), (2, 3)]), "draw belt A (source->factory)");
    apply_one(&mut host, &mut minted, draw(&[(6, 3), (7, 3)]), "draw belt B (factory->tee)");
    apply_one(&mut host, &mut minted, draw(&[(10, 3), (11, 3)]), "draw belt C (tee->sink1)");
    apply_one(&mut host, &mut minted, draw(&[(10, 4), (11, 4)]), "draw belt D (tee->sink2)");
    let (belt_a, belt_b, belt_c, belt_d) = (5u64, 6u64, 7u64, 8u64);

    // Docks — ports addressed by CATALOG index on the wire (SOURCE Out = 0,
    // FACTORY In/Out = 0/1, TEE In/Out/Out = 0/1/2, SINK In = 0); validate_normalize
    // freezes Tail/Out links in the ROUTING keyspace (Finding 1: catalog 1 -> emit 0,
    // catalog 1/2 -> emit 0/1) — exactly what this test proves items across.
    let dock = |belt: u64, endpoint: BeltEnd, node: u64, port: u16| GridCommand::Dock {
        belt,
        endpoint,
        node,
        port,
    };
    apply_one(&mut host, &mut minted, dock(belt_a, BeltEnd::Tail, source_h, 0), "dock A tail -> SOURCE Out");
    apply_one(&mut host, &mut minted, dock(belt_a, BeltEnd::Head, factory_h, 0), "dock A head -> FACTORY In");
    apply_one(&mut host, &mut minted, dock(belt_b, BeltEnd::Tail, factory_h, 1), "dock B tail -> FACTORY Out (catalog 1 -> emit 0)");
    apply_one(&mut host, &mut minted, dock(belt_b, BeltEnd::Head, tee_h, 0), "dock B head -> TEE In");
    apply_one(&mut host, &mut minted, dock(belt_c, BeltEnd::Tail, tee_h, 1), "dock C tail -> TEE Out (catalog 1 -> emit 0)");
    apply_one(&mut host, &mut minted, dock(belt_c, BeltEnd::Head, sink1_h, 0), "dock C head -> SINK1 In");
    apply_one(&mut host, &mut minted, dock(belt_d, BeltEnd::Tail, tee_h, 2), "dock D tail -> TEE Out (catalog 2 -> emit 1)");
    apply_one(&mut host, &mut minted, dock(belt_d, BeltEnd::Head, sink2_h, 0), "dock D head -> SINK2 In");

    // The build dispatched nothing: no item has flowed yet.
    assert!(
        cmd_rx.try_recv().is_err(),
        "no Command dispatched during the pure-topology build"
    );

    // ── RUN: inject K items, then settle ───────────────────────────────────────────
    // The item payload is canonical JSON (`{}`) — the default passthrough factory
    // JSON-parses its input, so it processes (never faults) and re-emits on port 0.
    let source_id = minted[source_h as usize];
    for i in 0..K {
        ingress_tx
            .send(inject(source_id, b"{}"))
            .unwrap_or_else(|e| panic!("send inject {i}: {e}"));
        host.tick_once(&mut ingress_rx, &mut results_rx, &cmd_tx)
            .expect("tick folds the injected item");
        assert!(
            host.core().last_tick.faulted.is_empty(),
            "no machine faults on inject tick {i}"
        );
    }
    for t in 0..RUN_TICKS {
        host.tick_once(&mut ingress_rx, &mut results_rx, &cmd_tx)
            .expect("settle tick");
        assert!(
            host.core().last_tick.faulted.is_empty(),
            "no machine faults on settle tick {t} (the default passthrough factory \
             never faults on canonical JSON)"
        );
    }

    // ── THE PROOF: every injected item DELIVERED through both command-docked Outs ──
    // Each of the K items rides: SOURCE -> A -> FACTORY (1:1 passthrough, emits on
    // routing port 0 across the catalog-1 dock) -> B -> TEE (broadcasts on routing
    // ports 0 AND 1 across the catalog-1/2 docks) -> C/D -> SINK1/SINK2. Each sink
    // consumption dispatches exactly one Command on the live cmd_rx.
    let mut delivered = 0usize;
    while cmd_rx.try_recv().is_ok() {
        delivered += 1;
    }
    assert_eq!(
        delivered,
        2 * K,
        "every item a command-docked FACTORY/TEE Out emitted must reach a sink: \
         K={K} items in => 2*K sink Commands out (TEE fans out to BOTH branches; \
         a shortfall means items vanished at a missing link — Finding 1)"
    );
}
