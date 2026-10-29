//! Merge-operator integration proofs (ROUTE-05).
//!
//! - `merge_funnel_order_is_deterministic`: an end-to-end
//!   `[source_0, source_1] -> merge -> collector` run delivers the merged items in
//!   the documented round-robin(port)-then-FIFO(within-port) order with the start
//!   port rotating each pass.
//! - `merge_replay_byte_identical`: building and driving the same multi-source
//!   merge topology from genesis twice yields byte-identical state — the merged
//!   order reproduces on replay (SC#1 extended to the merge funnel).
//! - `merge_snapshot_restore_equiv`: firing into multiple merge inputs across
//!   ticks so the rotation pointer is mid-cycle (and a backlog + pending re-wake
//!   are live) at the snapshot boundary, a restore-then-continue run is byte-
//!   identical to an uninterrupted run — proving the merge `next` pointer (and the
//!   un-served inbox items + scheduler wheel) are captured by the whole-node
//!   snapshot (RESEARCH Pitfall 1, threat T-2-ROT-MERGE). It MUST fail if `next`
//!   is ever moved outside the node.

mod common;

use common::{
    collector_items, fire, multi_source_merge_collector, run_merge_to, state_bytes,
    step_merge_scenario,
};
use fabrico_core::ids::Item;
use fabrico_core::snapshot::{restore, snapshot};
use proptest::prelude::*;

#[test]
fn merge_funnel_order_is_deterministic() {
    const SEED: u64 = 0x0FED_5E25;
    // Two inputs; queue two items on each at tick 0:
    //   port0 (s0) = [a0, a1], port1 (s1) = [b0, b1]
    // The merge funnels ONE item per pass from the first non-empty serviceable port
    // starting at `next`, rotating `next` after every pass:
    //   pass 1 (start 0): a0     pass 2 (start 1): b0
    //   pass 3 (start 0): a1     pass 4 (start 1): b1
    //   merged at the collector: a0, b0, a1, b1
    //
    // THE ORDER MOVED IN 71-03 AND THE PROPERTY DID NOT. Before ruling R-12 the pass
    // took one item PER INPUT, which batched a0+b0 into one pass and then b1+a1 into
    // the next, giving a0, b0, b1, a1. One item per pass makes the same round-robin
    // rule read as a strict alternation instead. Round-robin across ports with FIFO
    // within a port and a rotating start is unchanged; only the number of items a
    // single pass carries moved, and it moved because the fold's PILE-02 gate proves
    // exactly ONE item admissible on the merge's single output.
    let (mut core, sources, c) = multi_source_merge_collector(SEED, 2);
    let (s0, s1) = (sources[0], sources[1]);
    let a0 = Item(vec![0xA0]);
    let a1 = Item(vec![0xA1]);
    let b0 = Item(vec![0xB0]);
    let b1 = Item(vec![0xB1]);

    // Tick 0: fire two items into each source (distinct sequences).
    core.advance(&[
        fire(s0, 1, 0, a0.clone()),
        fire(s0, 2, 0, a1.clone()),
        fire(s1, 3, 0, b0.clone()),
        fire(s1, 4, 0, b1.clone()),
    ]);
    // Drive to quiescence: since 71-03 (ruling R-12) BOTH the sources and the merge
    // move one item per pass, so four items take several ticks rather than two.
    for _ in 0..12 {
        core.advance(&[]);
    }

    let merged = collector_items(&core, c);
    assert_eq!(
        merged,
        vec![a0, b0, a1, b1],
        "merged order is round-robin(port)-then-FIFO with rotating start (ROUTE-05)"
    );
}

#[test]
fn merge_replay_byte_identical() {
    // The same multi-source merge topology built and driven from genesis twice
    // (rotating inputs + backlog + rng draws via the scenario) yields byte-
    // identical state — the merged order reproduces on replay (SC#1).
    const SEED: u64 = 0x00C0_FFEE;
    const INPUTS: u16 = 3;
    const TARGET: u64 = 17;

    let (a, _sa, _ca) = run_merge_to(SEED, INPUTS, TARGET);
    let (b, _sb, _cb) = run_merge_to(SEED, INPUTS, TARGET);
    assert_eq!(
        state_bytes(&a),
        state_bytes(&b),
        "same multi-source merge log from genesis => byte-identical state (SC#1)"
    );
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]

    #[test]
    fn merge_snapshot_restore_equiv(t in 1u64..20, n in 1u64..20) {
        const SEED: u64 = 0x4A1C_3E70;
        const INPUTS: u16 = 3; // rotating feed => pointer mid-cycle at most boundaries
        let total = t + n;

        // (1) Uninterrupted reference run to T+N.
        let (uninterrupted, _s, _c) = run_merge_to(SEED, INPUTS, total);

        // (2) Run to T, snapshot at that clean tick boundary, restore, continue to
        //     T+N with the SAME per-tick logic (same source ids — the topology is
        //     deterministic from genesis).
        let (at_t, sources, _c) = run_merge_to(SEED, INPUTS, t);
        let snap = snapshot(&at_t);
        let mut restored = restore(&snap).expect("restore valid snapshot");
        prop_assert_eq!(restored.tick, t, "restored resumes at the snapshot tick");

        while restored.tick < total {
            step_merge_scenario(&mut restored, &sources);
        }

        // (3) Byte-identical — only true if the round-robin `next` pointer (and the
        //     un-served merge inbox items + scheduler wheel) survived the snapshot
        //     (T-2-ROT-MERGE).
        prop_assert_eq!(
            state_bytes(&uninterrupted),
            state_bytes(&restored),
            "snapshot+restore+continue == uninterrupted run; merge rotation pointer survived"
        );
    }
}
