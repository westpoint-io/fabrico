//! Certification criterion 3 — arrival-order independence, REPLAY-03.
//!
//! Proves that permuting the wall-clock ARRIVAL order of a batch of same-tick
//! events yields an identical final state hash. Determinism does not rest on the
//! order the inbound slice happens to be handed to the fold; it rests on (a) the
//! active set stepping woken nodes in ascending [`NodeId`] order
//! (`drain_active_sorted`) and (b) the per-tick `route_seq` stamped in that
//! deterministic fold order (ROUTE-06, see `src/tick.rs`). This is the T-3-ARR
//! mitigation: arrival order is untrusted input the fold must ignore.
//!
//! # DESIGN CONSTRAINT (load-bearing — do not "strengthen" into the same-source case)
//! The permuted events MUST each target a DISTINCT source (exactly one item per
//! source), NOT multiple items into one source. Reason (from `src/tick.rs` +
//! `src/manual_inject.rs`): admission folds the inbound slice IN ORDER and
//! `ManualInject::admit` enqueues the item into the target source's `pending`
//! FIFO. So two items into the SAME source are arrival-order-sensitive *by
//! design* — and that order is the log's canonical `sequence` order, not
//! wall-clock. Across DISTINCT sources each source receives exactly one item, the
//! fold steps the woken sources in ascending NodeId order regardless of admission
//! order, and `route_seq` is assigned in that deterministic fold order — so the
//! result is genuinely arrival-order-independent. That is precisely the ROUTE-06
//! property this criterion certifies. A future contributor who rewrites this to
//! push several items into one source will (correctly) see it become
//! order-sensitive and must NOT "fix" it by sorting — that would make the test
//! vacuous.

mod common;

use common::{
    belt_wire_merge_collector, fire, fold_log_collecting_hashes, multi_source_merge_collector,
    wire_fire, BeltWireTopology,
};
use fabrico_core::event::Event;
use fabrico_core::ids::{Item, NodeId};
use fabrico_core::wire::DEFAULT_WIRE_BUDGET;
use proptest::prelude::*;

/// Fixed genesis seed for the certified topology.
const SEED: u64 = 0x000A_C0DE;
/// Distinct sources merged (one same-tick item each).
const INPUTS: u16 = 4;
/// Tick budget: enough to admit + drain the merge backlog and settle the
/// collector (INPUTS woken sources + the merge pass + a few idle settle ticks).
const TICKS: u64 = 12;

/// The canonical same-tick batch: one item per DISTINCT source, all stamped at
/// `tick = 0`, with strictly ascending `sequence` values (the log's canonical
/// by-sequence order). Each item's payload encodes its source index so a wrong
/// merge would change the final hash.
fn base_events(sources: &[NodeId]) -> Vec<Event> {
    sources
        .iter()
        .enumerate()
        .map(|(k, &s)| fire(s, (k + 1) as u64, 0, Item(vec![k as u8])))
        .collect()
}

/// Fold a same-tick `batch` into a FRESH core built from the same genesis seed and
/// return the FINAL `tick_hash` after `TICKS` ticks. Because the topology is built
/// deterministically from genesis, the `NodeId`s the `batch` targets are identical
/// across every fresh core, so two batches differing only in arrival order are a
/// like-for-like comparison.
fn final_hash_for(batch: &[Event]) -> String {
    let (mut core, _sources, _collector) = multi_source_merge_collector(SEED, INPUTS);
    let hashes = fold_log_collecting_hashes(&mut core, batch, TICKS);
    hashes
        .last()
        .expect("TICKS >= 1 so at least one tick hash is captured")
        .clone()
}

proptest! {
    // Honor PROPTEST_CASES (CI sets 1024); `ProptestConfig::default()` reads the env
    // and defaults to 256 cases locally. `with_cases(256)` hardcoded `cases`, which
    // overwrote the env-derived value, so the env var was dead (WR-01).
    #![proptest_config(ProptestConfig::default())]

    /// Permuting the arrival order of the same-tick batch across DISTINCT sources
    /// leaves the final state hash unchanged (criterion 3 / REPLAY-03 / T-3-ARR).
    #[test]
    fn arrival_order_independent_final_hash(
        perm in {
            // Build the canonical batch once, then let proptest shuffle it (with
            // free shrinking to a minimal failing permutation) per case.
            let (_core, sources, _c) = multi_source_merge_collector(SEED, INPUTS);
            Just(base_events(&sources)).prop_shuffle()
        }
    ) {
        let (_core, sources, _c) = multi_source_merge_collector(SEED, INPUTS);
        let canonical = base_events(&sources);

        // (1) Arrival-order invariance: the canonical by-sequence fold and the
        //     permuted fold reach the same final hash.
        let canonical_final = final_hash_for(&canonical);
        let permuted_final = final_hash_for(&perm);
        prop_assert_eq!(
            &canonical_final,
            &permuted_final,
            "criterion 3 / REPLAY-03: arrival order is irrelevant"
        );

        // (2) Identical-log half: sorting the permuted batch by `event.sequence`
        //     reproduces the canonical batch byte-for-byte — the canonical log is
        //     permutation-invariant, so wall-clock arrival order carries no
        //     information the fold could (or does) depend on.
        let mut sorted = perm.clone();
        sorted.sort_by_key(|e| e.sequence);
        prop_assert_eq!(
            sorted,
            canonical,
            "sorting the permuted batch by sequence reproduces the canonical log"
        );
    }
}

// ── SC#3 extended to WIRE (WIRE-02): a MIXED same-tick belt+wire batch ───────────
//
// The criterion above certifies belt-only same-tick arrivals; this extends it IN PLACE
// to a MIXED batch of belt fires AND wire requests (RESEARCH §7 step 3-4). The wire
// admit path follows the SAME per-node-holding-then-fold-re-emit shape as `ManualInject`
// (a `WireRequest` is admitted into its ENTRY WIRE's in-flight FIFO, `manual_inject.rs`),
// so the identical invariance argument holds: across DISTINCT entry nodes each entry
// wire receives EXACTLY ONE same-tick request, the fold re-emits in ascending-`NodeId`
// order acquiring `route_seq` there, and arrival order affects only per-node holding
// buffers with nothing to reorder. The DISTINCT-source discipline (module header,
// lines 11-25) is KEPT: one arrival per DISTINCT belt source / wire-entry node, never
// two into one — a future rewrite pushing several into one entry wire would (correctly)
// become order-sensitive and must NOT be "fixed" by sorting.

/// Fixed genesis seed for the mixed belt+wire certified topology.
const MIXED_SEED: u64 = 0x0037_0005_AC0D_E000;
/// Distinct belt lanes (one same-tick `fire()` each).
const BELT_INPUTS: u16 = 3;
/// Distinct wire lanes (one same-tick `wire_fire()` each).
const WIRE_INPUTS: u16 = 3;
/// Tick budget: belt items land at the collector at `now = 3`, wire messages at
/// `now = 1`; a dozen ticks admits + settles both and idles the grid to a stable hash.
const MIXED_TICKS: u64 = 12;

/// The canonical MIXED same-tick batch over the `belt_wire_merge_collector` topology:
/// one `fire()` per DISTINCT belt source THEN one `wire_fire()` per DISTINCT wire-entry
/// node, ALL stamped at `tick = 0`, with strictly ascending `sequence` (the log's
/// canonical by-sequence order). Each item's payload encodes its lane so a wrong merge
/// would change the final hash.
fn mixed_base_events(topo: &BeltWireTopology) -> Vec<Event> {
    let mut events = Vec::new();
    let mut seq = 1u64;
    for (k, &s) in topo.belt_sources.iter().enumerate() {
        events.push(fire(s, seq, 0, Item(vec![0xB0, k as u8])));
        seq += 1;
    }
    for (k, &entry) in topo.wire_entries.iter().enumerate() {
        events.push(wire_fire(
            (entry, 0),
            seq,
            0,
            (k as u64) + 1,
            DEFAULT_WIRE_BUDGET,
            Item(vec![0x11, k as u8]),
        ));
        seq += 1;
    }
    events
}

/// Fold a MIXED same-tick `batch` into a FRESH core built from `MIXED_SEED` and return
/// the FINAL `tick_hash` after `MIXED_TICKS` ticks. The topology is deterministic from
/// genesis, so the `NodeId`s the `batch` targets are identical across every fresh core
/// — a like-for-like comparison of two batches differing only in arrival order.
fn mixed_final_hash(batch: &[Event]) -> String {
    let (mut core, _topo) = belt_wire_merge_collector(MIXED_SEED, BELT_INPUTS, WIRE_INPUTS);
    let hashes = fold_log_collecting_hashes(&mut core, batch, MIXED_TICKS);
    hashes
        .last()
        .expect("MIXED_TICKS >= 1 so at least one tick hash is captured")
        .clone()
}

proptest! {
    #![proptest_config(ProptestConfig::default())]

    /// Permuting the arrival order of a MIXED same-tick belt+wire batch across DISTINCT
    /// sources / wire-entry nodes leaves the final state hash unchanged AND the canonical
    /// log recoverable by sorting on `sequence` (criterion 3 / REPLAY-03 / T-3-ARR,
    /// extended to wire events — WIRE-02).
    #[test]
    fn arrival_order_independent_mixed_belt_wire(
        perm in {
            let (_core, topo) = belt_wire_merge_collector(MIXED_SEED, BELT_INPUTS, WIRE_INPUTS);
            Just(mixed_base_events(&topo)).prop_shuffle()
        }
    ) {
        let (_core, topo) = belt_wire_merge_collector(MIXED_SEED, BELT_INPUTS, WIRE_INPUTS);
        let canonical = mixed_base_events(&topo);

        // (1) Arrival-order invariance across belt + wire: the canonical by-sequence
        //     fold and the permuted fold reach the same final hash.
        let canonical_final = mixed_final_hash(&canonical);
        let permuted_final = mixed_final_hash(&perm);
        prop_assert_eq!(
            &canonical_final,
            &permuted_final,
            "SC#3 (wire): permuting same-tick belt+wire arrivals is byte-identical"
        );

        // (2) Identical-log half: sorting the permuted mixed batch by `sequence`
        //     reproduces the canonical batch byte-for-byte — wall-clock arrival order
        //     of belt fires AND wire requests carries no information the fold depends on.
        let mut sorted = perm.clone();
        sorted.sort_by_key(|e| e.sequence);
        prop_assert_eq!(
            sorted,
            canonical,
            "sorting the permuted mixed batch by sequence reproduces the canonical log"
        );
    }
}
