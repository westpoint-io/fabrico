//! Routing-operator integration proofs (ROUTE-02 / ROUTE-03).
//!
//! - `balancer_distinct_from_tee`: the same input through a tee lands a copy on
//!   EVERY collector, through a balancer lands exactly ONE item on each — the
//!   observable "balancer is visibly distinct from broadcast" guarantee
//!   (ROUTE-03 SC#2).
//! - `balancer_snapshot_restore_equiv`: firing one item per tick so the
//!   round-robin pointer is mid-cycle at the snapshot boundary, a restore-then-
//!   continue run is byte-identical to an uninterrupted run — proving the
//!   rotation pointer is captured by the whole-node snapshot (RESEARCH Pitfall 1,
//!   threat T-2-ROT). This is the load-bearing Phase-2 determinism proof for
//!   selection state; it MUST fail if `next` is ever moved outside the node.

mod common;

use common::{
    advance_drawing_rng, collector_count, fire, header, run_balancer_to,
    source_balancer_collectors, source_tee_collectors, state_bytes, step_balancer_scenario,
};
use fabrico_core::core::Core;
use fabrico_core::fault::FAULT_PORT;
use fabrico_core::ids::{Item, NodeId};
use fabrico_core::snapshot::{restore, snapshot};
use fabrico_core::state::RouteKey;
use proptest::prelude::*;

/// Phase 87 (JAM-01, D-02): two Sources docked on the Balancer's In 0 and In 1 and
/// `outputs` collectors. Defined here rather than in `common` so the shared single-input
/// scenario the replay certs use stays exactly as it was.
fn two_input_balancer(seed: u64, outputs: u16) -> (Core, [NodeId; 2]) {
    let mut core = Core::genesis(header(seed));
    let s0 = core.state.add_source();
    let s1 = core.state.add_source();
    let bal = core.state.add_balancer(outputs);
    core.state.link((s0, 0), (bal, 0));
    core.state.link((s1, 0), (bal, 1));
    for port in 0..outputs {
        let c = core.state.add_source();
        core.state.link((bal, port), (c, 0));
    }
    (core, [s0, s1])
}

/// One step of the two-input scenario: one item into In 0 every tick and one into In 1
/// on even ticks, so both Ins hold a backlog (a pass takes ONE item) and the input
/// pointer `next_in` decides which In the next pass serves. The schedule depends only on
/// `core.tick`, so an uninterrupted run and a restored one see the same events.
fn step_two_input_balancer(core: &mut Core, sources: [NodeId; 2]) {
    let t = core.tick;
    let mut inbound = vec![fire(sources[0], 2 * t, t, Item(vec![(t % 127) as u8]))];
    if t.is_multiple_of(2) {
        inbound.push(fire(sources[1], 2 * t + 1, t, Item(vec![0x80 | (t % 127) as u8])));
    }
    advance_drawing_rng(core, &inbound);
}

/// Run the two-input scenario from genesis up to (not including) `target`.
fn run_two_input_balancer_to(seed: u64, outputs: u16, target: u64) -> (Core, [NodeId; 2]) {
    let (mut core, sources) = two_input_balancer(seed, outputs);
    while core.tick < target {
        step_two_input_balancer(&mut core, sources);
    }
    (core, sources)
}

#[test]
fn balancer_distinct_from_tee() {
    const SEED: u64 = 7;
    const ARITY: u16 = 3;

    // Three items fired into each source at tick 0 (distinct sequences).
    let items = [Item(vec![0xA]), Item(vec![0xB]), Item(vec![0xC])];
    let fires = |s: NodeId| {
        vec![
            fire(s, 1, 0, items[0].clone()),
            fire(s, 2, 0, items[1].clone()),
            fire(s, 3, 0, items[2].clone()),
        ]
    };

    // Tee: each of the 3 items is broadcast to all 3 collectors.
    //
    // Since 71-03 (ruling R-12) a source fires ONE item per pass and a tee consumes
    // ONE item per pass, so three items take several ticks to travel rather than one.
    // The observable guarantee this test exists for - broadcast lands a copy on EVERY
    // collector while the balancer lands exactly one on each - is unchanged; only the
    // number of ticks it takes moved, so both arms drive to quiescence.
    const SETTLE: usize = 12;
    let (mut tc, ts, tcols) = source_tee_collectors(SEED, ARITY);
    tc.advance(&fires(ts));
    for _ in 0..SETTLE {
        tc.advance(&[]);
    }
    for c in &tcols {
        assert_eq!(
            collector_count(&tc, *c),
            3,
            "tee copies every input to every collector (3 items x 3 = 3 per collector)"
        );
    }

    // Balancer: each of the 3 items goes to exactly one collector, round-robin.
    let (mut bc, bs, bcols) = source_balancer_collectors(SEED, ARITY);
    bc.advance(&fires(bs));
    for _ in 0..SETTLE {
        bc.advance(&[]);
    }
    let counts: Vec<usize> = bcols.iter().map(|c| collector_count(&bc, *c)).collect();
    assert_eq!(
        counts,
        vec![1, 1, 1],
        "balancer sends exactly one item to each output (round-robin), distinct from tee"
    );
    let total: usize = counts.iter().sum();
    assert_eq!(total, 3, "balancer neither duplicates nor drops (one in, one out)");
}

#[test]
fn router_replay_byte_identical() {
    // ROUTE-04 + ROUTE-06: building and driving the same router topology from
    // genesis twice with a scripted mix of matching + non-matching items yields
    // byte-identical state — the routing decision (first-match -> default -> fault)
    // reproduces exactly on replay. `state_bytes` (the whole-Core snapshot) is the
    // equality oracle, so this also pins that the router's `faults` counter and
    // the produced fault bytes are part of the deterministic state.
    const SEED: u64 = 0x0072_07E5;

    let build = || {
        let mut core = Core::genesis(header(SEED));
        let s = core.state.add_source();
        // routes: 0x01.. -> port 0 ; 0x02.. -> port 1 ; no default => fault.
        let router = core.state.add_router(
            vec![
                (RouteKey::new(0, vec![0x01]), 0),
                (RouteKey::new(0, vec![0x02]), 1),
            ],
            None,
        );
        core.state.link((s, 0), (router, 0));
        // Wire every observable output port + the fault port to its own collector.
        let c0 = core.state.add_source();
        let c1 = core.state.add_source();
        let cf = core.state.add_source();
        core.state.link((router, 0), (c0, 0));
        core.state.link((router, 1), (c1, 0));
        core.state.link((router, FAULT_PORT), (cf, 0));

        // A scripted mix: match port 0, match port 1, no-match (fault), match
        // port 0 again, no-match (fault) — one fire per tick.
        let script = [
            vec![0x01, 0x0A], // -> port 0
            vec![0x02, 0x0B], // -> port 1
            vec![0x99, 0x0C], // -> fault (no match)
            vec![0x01, 0x0D], // -> port 0
            vec![0x03, 0x0E], // -> fault (no match)
        ];
        for (i, bytes) in script.iter().enumerate() {
            core.advance(&[fire(s, (i + 1) as u64, i as u64, Item(bytes.clone()))]);
        }
        core
    };

    let a = build();
    let b = build();
    assert_eq!(
        state_bytes(&a),
        state_bytes(&b),
        "same router topology + same scripted items => byte-identical state (ROUTE-04 replay)"
    );
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]

    #[test]
    fn balancer_snapshot_restore_equiv(t in 1u64..20, n in 1u64..20) {
        const SEED: u64 = 0x00B4_1A0C;
        const OUTPUTS: u16 = 3; // 1 item/tick => pointer mid-cycle unless t % 3 == 0
        let total = t + n;

        // (1) Uninterrupted reference run to T+N.
        let (uninterrupted, _s) = run_balancer_to(SEED, OUTPUTS, total);

        // (2) Run to T, snapshot at that clean tick boundary, restore, continue
        //     to T+N with the SAME per-tick logic.
        let (at_t, source) = run_balancer_to(SEED, OUTPUTS, t);
        let snap = snapshot(&at_t);
        let mut restored = restore(&snap).expect("restore valid snapshot");
        prop_assert_eq!(restored.tick, t, "restored resumes at the snapshot tick");

        while restored.tick < total {
            step_balancer_scenario(&mut restored, source);
        }

        // (3) Byte-identical — only true if the round-robin `next` pointer
        //     survived the snapshot (T-2-ROT).
        prop_assert_eq!(
            state_bytes(&uninterrupted),
            state_bytes(&restored),
            "snapshot+restore+continue == uninterrupted run; rotation pointer survived"
        );

        // (4) Phase 87 (JAM-01, D-02): BOTH Ins fed, so the input pointer `next_in` is
        //     mid-rotation at the restore tick. Byte-identical only if it survived too.
        let (uninterrupted, _s) = run_two_input_balancer_to(SEED, OUTPUTS, total);
        let (at_t, sources) = run_two_input_balancer_to(SEED, OUTPUTS, t);
        let mut restored = restore(&snapshot(&at_t)).expect("restore valid snapshot");
        prop_assert_eq!(restored.tick, t, "restored resumes at the snapshot tick");
        while restored.tick < total {
            step_two_input_balancer(&mut restored, sources);
        }
        prop_assert_eq!(
            state_bytes(&uninterrupted),
            state_bytes(&restored),
            "two-input snapshot+restore+continue == uninterrupted run; next_in survived"
        );
    }
}
