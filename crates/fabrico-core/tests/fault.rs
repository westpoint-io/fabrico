//! Fault-port wireability integration proofs (API-05).
//!
//! "Faults are routed events, not a subsystem": the router's reserved
//! [`FAULT_PORT`](fabrico_core::fault::FAULT_PORT) is routed by the existing fold
//! exactly like any other output port. These tests prove the three wiring
//! outcomes CONTEXT calls for:
//! - `fault_dead_letter`: `FAULT_PORT` -> a sink collects the faulted item,
//!   decodable, carrying reason + source + attempt (dead-letter queue).
//! - `fault_retry_loop`: `FAULT_PORT` -> a delay belt -> the fault re-arrives
//!   downstream after exactly the belt latency (retry loop; the attempt field
//!   rides the item).
//! - `fault_unwired_drops_no_panic`: an UNWIRED `FAULT_PORT` drops the fault via
//!   the fold's existing missing-link no-op — no panic, no special-casing — while
//!   the producer-side `faults` counter still reflects the produced fault.

mod common;

use common::{fire, header, router_dead_letter, router_retry_loop};
use fabrico_core::core::Core;
use fabrico_core::fault::{Fault, FaultReason};
use fabrico_core::ids::{Item, NodeId};
use fabrico_core::state::Node;

/// Drain and return the items resting on port 0 of `id`'s collector inbox.
fn collector_items(core: &Core, id: NodeId) -> Vec<Item> {
    let mut inbox = core.state.inbox_of(id).cloned().expect("collector inbox");
    let mut out = Vec::new();
    while let Some((_seq, item)) = inbox.take(0) {
        out.push(item);
    }
    out
}

#[test]
fn fault_dead_letter() {
    const SEED: u64 = 0xDEAD_1E77;
    // Empty routes + no default => the fired item no-matches and faults; the
    // FAULT_PORT is wired to a sink (dead-letter queue).
    let (mut core, s, router, sink) = router_dead_letter(SEED, Vec::new(), None);

    // Fire one (necessarily non-matching) item. Instant links carry it
    // source -> router -> FAULT_PORT -> sink within the same tick's fixpoint.
    core.advance(&[fire(s, 1, 0, Item(vec![0x99, 0xEE]))]);

    let items = collector_items(&core, sink);
    assert_eq!(items.len(), 1, "the sink received exactly the one faulted item");
    let fault = Fault::decode(&items[0]).expect("the dead-lettered item decodes to a Fault");
    assert_eq!(fault.reason, FaultReason::NoMatch, "no-match fault reason");
    assert_eq!(fault.source, router, "fault carries the producing router's id");
    assert_eq!(fault.attempt, 1, "attempt rides the item (set to 1 on production)");
    assert_eq!(fault.payload, vec![0x99, 0xEE], "original item bytes preserved for inspection");
}

#[test]
fn fault_retry_loop() {
    use fabrico_core::belt_slots::{DEFAULT_TICKS_PER_SLOT, SLOTS_PER_TILE};
    const SEED: u64 = 0x0BAD_4E77;
    const TILES: u32 = 3;
    // source -> router -> FAULT_PORT -> belt(TILES) -> collector. Every item
    // faults (empty routes), then the fault traverses the slot belt and re-arrives
    // at the collector after exactly the traverse-time — proving retry-loop
    // wireability over the per-tile slot belt (BELT-05).
    let (mut core, s, router, c) = router_retry_loop(SEED, TILES);

    // Fold-tick 0: fire. Router faults same-tick and routes the fault into the
    // belt's INBOX, scheduling the belt to wake the NEXT tick (feeding a belt is NOT
    // a 0-latency wire, CR-01). Tick 1: the belt's scheduled wake fires and admits
    // the fault onto its tail. Not yet at the collector.
    core.advance(&[fire(s, 1, 0, Item(vec![0x99]))]);
    core.advance(&[]);

    // Travelling the belt: absent at the collector until the traverse completes.
    // SLOTS_PER_TILE*TILES - 1 slot ADVANCES tail -> head, and since SLOT-03 a belt
    // advances only on its own due ticks, one slot every `interval` of them. The
    // advance runs BEFORE the admit inside `Belt::step`, so the admit tick never
    // advances the item it just admitted and the wait for the first due tick is
    // between 1 and `interval` ticks. The fault is therefore absent for the first
    // `(advances - 1) * interval` ticks and present by `advances * interval`. NOT a
    // whole extra interval later: head delivery is ungated, so a head reaching slot 0
    // on a due tick leaves on that same tick, and a more generous upper bound would
    // hide a real regression.
    //
    // DERIVED FROM THE INTERVAL and therefore SELF-AGREEING: this holds at every
    // value of `DEFAULT_TICKS_PER_SLOT` and is NOT admissible as this phase's value
    // gate. Phase 60 recorded the same of this assertion's `SLOTS_PER_TILE`-derived
    // predecessor. The hand-pinned pin that IS admissible lives in `belt_slots.rs`
    // (plan 62-09); a green run here proves retry-loop WIREABILITY over the belt, not
    // that the interval is right.
    let interval = u64::from(DEFAULT_TICKS_PER_SLOT.get());
    let advances = u64::from(SLOTS_PER_TILE * TILES - 1);
    for _ in 1..((advances - 1) * interval + 1) {
        assert!(
            collector_items(&core, c).is_empty(),
            "fault still travelling the belt, absent at the collector"
        );
        core.advance(&[]);
    }
    let mut arrived = false;
    for _ in 0..interval {
        core.advance(&[]);
        if !collector_items(&core, c).is_empty() {
            arrived = true;
            break;
        }
    }
    assert!(
        arrived,
        "the fault arrives within the alignment allowance of the traverse-time"
    );

    // Delivered now (the head reached slot 0): the fault item re-arrived downstream.
    let items = collector_items(&core, c);
    assert_eq!(items.len(), 1, "the fault re-arrived at the collector after the slot traverse");
    let fault = Fault::decode(&items[0]).expect("the re-arrived item decodes to a Fault");
    assert_eq!(fault.reason, FaultReason::NoMatch);
    assert_eq!(fault.source, router, "the attempt/source metadata rode the item through the belt");
    assert_eq!(fault.attempt, 1, "attempt rides the item across the retry belt");
}

#[test]
fn fault_unwired_drops_no_panic() {
    const SEED: u64 = 0xF00D_D40F;
    // A router with no default and an UNWIRED FAULT_PORT: no `link((router,
    // FAULT_PORT), ..)` exists. The fault must be dropped by the fold's existing
    // missing-link no-op — no panic, no null-sink, no special-case.
    let mut core = Core::genesis(header(SEED));
    let s = core.state.add_source();
    let router = core.state.add_router(Vec::new(), None); // every item faults
    core.state.link((s, 0), (router, 0));
    // Wire a sink to a NORMAL output port (port 0) the router never uses, to prove
    // nothing is delivered downstream when the fault drops.
    let sink = core.state.add_source();
    core.state.link((router, 0), (sink, 0));

    // Advance the fold over a faulting item — must complete without panicking.
    core.advance(&[fire(s, 1, 0, Item(vec![0x99]))]);

    // Nothing delivered downstream (the fault dropped at the unwired FAULT_PORT,
    // and the router never emits on the normal port).
    assert!(
        collector_items(&core, sink).is_empty(),
        "unwired fault drops; nothing delivered downstream"
    );

    // The producer-side faults counter still reflects the produced fault.
    match core.state.node(router) {
        Some(Node::Router(r)) => assert_eq!(r.faults, 1, "the produced fault was counted"),
        other => panic!("expected a Router node, got {other:?}"),
    }
}
