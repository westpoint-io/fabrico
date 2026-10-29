//! Factory-node integration proofs (FACT-01..04) — the sandbox driven as a real
//! `Node::Factory` through the **production fold**, not in isolation.
//!
//! Plan 04-02 proved `FactoryRuntime` in isolation (build/run + the determinism
//! boundary). This suite proves the 04-03 wiring: a factory placed on the grid
//! transforms-and-emits through the real `tick` fold (FACT-01), routes typed faults
//! on the reserved `FAULT_PORT` for a withheld global (FACT-02/04) and a fuse trip
//! (FACT-03/04) without crashing or hanging the sim, and persists `ctx.state` across
//! ticks (criterion-5 groundwork).
//!
//! Assertions are by **decoded `Fault`** and by **item bytes** — never by reading an
//! `f64` into Rust (the determinism clippy gate forbids floats in this crate, and the
//! whole point is that no float crosses the boundary).

mod common;

use common::{COUNTER_FACTORY_JS, collector_items, fire, run_factory_to, source_factory_collector};
use fabrico_core::fault::{FAULT_PORT, Fault, FaultReason};
use fabrico_core::ids::Item;

const SEED: u64 = 0x00FA_C704;

#[test]
fn factory_topology_end_to_end() {
    // FACT-01: a source -> factory -> collector topology delivers a TRANSFORMED
    // item end-to-end through the real fold. The factory parses a number from its
    // input and emits a derived value; the collector receives exactly that item.
    let (mut core, s, _f, c) = source_factory_collector(
        SEED,
        "export default function (input, ctx) { ctx.emit(0, input * 2); }",
    );

    // Fire `21` into the source at tick 0. The instant links carry it
    // source -> factory -> collector within tick 0 via the fixpoint.
    core.advance(&[fire(s, 1, 0, Item(b"21".to_vec()))]);

    // The collector received exactly the transformed item (21 * 2 == 42), as the
    // canonical JSON bytes — asserted by bytes, never by reading a float.
    assert_eq!(
        collector_items(&core, c),
        vec![Item(b"42".to_vec())],
        "factory transformed 21 -> 42 and the collector received it through the fold"
    );
}

#[test]
fn denied_global_faults() {
    // FACT-02/04: a factory referencing a WITHHELD global (Math.sin) faults rather
    // than leaking nondeterminism or crashing the sim. Its FAULT_PORT is wired to a
    // dead-letter collector; the injected item produces a decodable FactoryError
    // Fault on that sink, and nothing reaches the normal output collector.
    let (mut core, s, f, c) = source_factory_collector(
        SEED,
        "export default function (input, ctx) { ctx.emit(0, Math.sin(input)); }",
    );
    // Wire the reserved fault port to its own dead-letter sink (a Source that
    // ignores its input, so the faulted item rests in its inbox for inspection).
    let sink = core.state.add_source();
    core.state.link((f, FAULT_PORT), (sink, 0));

    core.advance(&[fire(s, 1, 0, Item(b"1".to_vec()))]);

    // No normal output was produced (the partial emit is discarded on fault).
    assert!(
        collector_items(&core, c).is_empty(),
        "a faulted factory emits nothing on its normal output port"
    );

    // The dead-letter sink holds exactly one decodable Fault with reason
    // FactoryError, sourced at the factory — a routed event, not a sim crash.
    let faults = collector_items(&core, sink);
    assert_eq!(faults.len(), 1, "exactly one fault routed to the dead-letter sink");
    let fault = Fault::decode(&faults[0]).expect("the routed item decodes to a Fault");
    assert_eq!(fault.reason, FaultReason::FactoryError, "withheld global => FactoryError");
    assert_eq!(fault.source, f, "the fault is sourced at the factory node");
    assert!(
        !fault.payload.is_empty(),
        "the JS error message rides the fault payload for dead-letter inspection"
    );
}

#[test]
fn factory_fuse_trip_routes_timeout() {
    // FACT-03/04: an input that triggers the unbounded-loop branch trips the
    // deterministic gas fuse to FactoryTimeout (routed on FAULT_PORT) while the sim
    // KEEPS ADVANCING — no hang, no crash. Uses the shared COUNTER_FACTORY_JS whose
    // sentinel `"loop"` input runs `while (true) {}`.
    let (mut core, s, f, c) = source_factory_collector(SEED, COUNTER_FACTORY_JS);
    let sink = core.state.add_source();
    core.state.link((f, FAULT_PORT), (sink, 0));

    let tick_before = core.tick;
    // Fire the sentinel: the factory loops, the fuse trips, run() returns.
    core.advance(&[fire(s, 1, tick_before, Item(b"\"loop\"".to_vec()))]);

    // The sim advanced exactly one tick (the fuse bounded the runaway — no hang).
    assert_eq!(core.tick, tick_before + 1, "the sim kept ticking past the fuse trip");
    // No normal output (the tripped call discards partial effects).
    assert!(
        collector_items(&core, c).is_empty(),
        "a fuse-tripped factory emits nothing on its normal output"
    );

    // The dead-letter sink holds a decodable FactoryTimeout fault — distinct from a
    // thrown FactoryError.
    let faults = collector_items(&core, sink);
    assert_eq!(faults.len(), 1, "exactly one timeout fault routed to the sink");
    let fault = Fault::decode(&faults[0]).expect("the routed item decodes to a Fault");
    assert_eq!(
        fault.reason,
        FaultReason::FactoryTimeout,
        "a runaway loop trips the fuse to FactoryTimeout (distinct from FactoryError)"
    );
    assert_eq!(fault.source, f, "the fault is sourced at the factory node");

    // And the factory is still usable afterward: a normal input now increments and
    // emits (the engine survived the abort).
    core.advance(&[fire(s, 2, core.tick, Item(b"1".to_vec()))]);
    assert_eq!(
        collector_items(&core, c),
        vec![Item(b"1".to_vec())],
        "the factory is reusable after a fuse trip (ctx.state still at its prior value)"
    );
}

#[test]
fn factory_processes_one_item_per_tick_and_rewakes() {
    // WR-03 / CORE-07: a factory flooded with N items on input port 0 in a SINGLE
    // tick must NOT drain them all in one tick (unbounded per-tick CPU). It processes
    // a fixed-bounded number per tick (one, mirroring merge), re-waking itself at
    // tick+1 while a backlog remains, so N items take N ticks and per-tick work stays
    // bounded regardless of inbox depth. A fully drained factory then sleeps.
    let (mut core, _s, f, c) = source_factory_collector(
        SEED,
        "export default function (input, ctx) { ctx.emit(0, input); }",
    );

    // Flood the factory's input port 0 with N items within one tick, and wake it.
    const N: u64 = 5;
    for k in 0..N {
        core.state
            .inbox_mut(f)
            .push(0, k, Item(format!("{k}").into_bytes()));
    }
    core.sched.wake_now(f);

    // Each tick delivers EXACTLY ONE more item to the collector (bounded per-tick
    // work), in FIFO order, until all N are drained over N ticks.
    for done in 1..=N {
        core.advance(&[]);
        let got = collector_items(&core, c);
        assert_eq!(
            got.len() as u64,
            done,
            "exactly one item processed per tick (bounded work) — {done} after {done} tick(s)"
        );
        let expected: Vec<Item> = (0..done).map(|k| Item(format!("{k}").into_bytes())).collect();
        assert_eq!(got, expected, "items processed FIFO, one per tick");
    }

    // The backlog is drained; the factory re-wakes no further and sleeps (CORE-07):
    // an extra idle tick delivers nothing new.
    core.advance(&[]);
    assert_eq!(
        collector_items(&core, c).len() as u64,
        N,
        "a drained factory schedules no further wake — no extra items after the backlog clears"
    );
}

#[test]
fn factory_state_persists_across_ticks() {
    // criterion-5 groundwork: the counter factory's emitted value INCREMENTS across
    // successive ticks, proving ctx.state (the SOLE cross-tick state) crosses the
    // tick boundary through the real fold. Five ticks => emitted 1,2,3,4,5.
    let (core, _s, _f, c) = run_factory_to(SEED, COUNTER_FACTORY_JS, 5);

    assert_eq!(
        collector_items(&core, c),
        vec![
            Item(b"1".to_vec()),
            Item(b"2".to_vec()),
            Item(b"3".to_vec()),
            Item(b"4".to_vec()),
            Item(b"5".to_vec()),
        ],
        "ctx.state.count persists and increments across ticks (1..=5)"
    );
}
