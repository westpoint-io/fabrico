//! Certification: the ONE tie-break comparator is a STRICT TOTAL ORDER (WIRE-02) —
//! the milestone's deepest verification.
//!
//! Belt delivery AND wire delivery route through ONE queue ordered by ONE canonical
//! comparator. Its DOCUMENTED semantic form is the lexicographic tuple
//! `(tick, source node-id, source port, sequence)`; its RUNTIME encoding is
//! `(tick, route_seq)`, where `route_seq` is a per-tick `u64` reset to 0 each tick and
//! incremented after EVERY delivery push, in the deterministic fold order
//! (`drain_active_sorted` ascending [`NodeId`], then ascending output port, then FIFO —
//! `src/tick.rs`). Because `route_seq` is strictly incremented per push, no two DISTINCT
//! items delivered in one tick ever share it: `(tick, route_seq)` is a strict total
//! order with NO ties.
//!
//! This file proves, at `PROPTEST_CASES` (CI raises to 1024), against a REAL `tick()`
//! fold (NOT std's tuple `Ord` — an earlier Property 1 asserted total-order laws on a
//! plain `(u64,u64,u16,u64)` tuple `a.cmp(b)`, a stdlib tautology that could never fail
//! and gave false assurance; WR-02 replaced it with the fold-driven proof below):
//! 1. **Strict-total-order of the REAL delivery key:** the sequence of `(tick,
//!    route_seq)` keys the sim ACTUALLY stamps onto same-tick deliveries — projected out
//!    of a driven mixed belt+wire fold — is STRICTLY ASCENDING in delivery (FIFO) order,
//!    hence pairwise DISTINCT (irreflexive/antisymmetric/total) and consistently ordered
//!    (transitive) on the production comparator key. A regression that reused a
//!    `route_seq` or sorted `in_flight` (corrupting FIFO) breaks this; the old tuple
//!    tautology was insensitive to the sim.
//! 2. **Runtime no-ties:** against a REAL `tick()` fold, the multiset of `route_seq`
//!    values delivered in a SINGLE tick has NO duplicate — even when belt items and
//!    wire messages converge on ONE machine the SAME tick (they share the one counter).
//! 3. **Encoding fidelity:** in a two-source-into-one-machine grid the destination
//!    inbox FIFO order equals ascending `route_seq` equals ascending source [`NodeId`].
//!
//! # Load-bearing subtlety (Pitfall 3 — do NOT "simplify" the comparator)
//! The TRUE runtime order is `(tick, fixpoint_iteration, source_node, source_port,
//! drain)` — the exact order `route_seq` is assigned. A lower-`NodeId` node stepped in
//! fixpoint iteration 2 earns a HIGHER `route_seq` than a higher-`NodeId` node stepped
//! in iteration 1. So `route_seq` order does NOT in general equal `(node, port)` order.
//! The comparator's authority is therefore `route_seq` (the `(tick, sequence)`
//! projection), NOT a re-sort by `(source_node, port)`. The encoding-fidelity check
//! (property 3) is deliberately confined to a SINGLE-fixpoint-iteration grid (two
//! sources delivering instantly to one collector), the only regime where `node` order
//! and `route_seq` order coincide. This file never sorts by `(node, port)` across
//! iterations.

mod common;

use common::{belt_wire_merge_collector, fire, header, wire_fire};
use fabrico_core::core::Core;
use fabrico_core::ids::{Item, NodeId};
use fabrico_core::wire::{WireEnvelope, DEFAULT_WIRE_BUDGET};
use proptest::prelude::*;

/// Fixed genesis seed for the runtime grids.
const SEED: u64 = 0x0000_C0DE_0037_0005;

/// The tick at which each wire request is admitted in the runtime no-ties scenario.
/// A `wire_fire` admitted at tick `WIRE_ADMIT_TICK` is forwarded into the collector at
/// `now = WIRE_ADMIT_TICK + 1` (`>= 1` tick/hop); belt fires at tick 0 land at the
/// collector at `now = 6` (belt(1): admit-to-tail at `now=1`, then three advances on the
/// DUE ticks 2, 4 and 6). So `WIRE_ADMIT_TICK = 5` makes belt and wire deliveries
/// CONVERGE at `now = 6`, sharing ONE per-tick `route_seq` counter, the crux of the
/// ONE-comparator claim.
///
/// This value was 2, converging at `now = 3` on a traverse of 2, until Phase 60 moved
/// the belt slot count from three to four (`60-CONTEXT.md`, 2026-08-09). A 1-tile
/// belt's traverse is `slots - 1`, so it grew from 2 to 3 and both the delivery tick
/// and this admit tick shifted by exactly one, to 3.
///
/// **It moved again, 3 to 5, at plan 62-09 on 2026-08-14**, when the shipped advance
/// interval went from the pre-change identity of 1 to **2** (chosen at the 2026-08-14
/// pace test, the only admissible source). The belt lane's delivery moved from `now = 4` to
/// `now = 6` and this admit tick follows it.
///
/// It is a HAND-WRITTEN LITERAL and it must stay one. Do NOT derive it from
/// `SLOTS_PER_TILE`, and do NOT add a `use` of `fabrico_core::belt_slots` to this
/// file. This is the only assertion in `fabrico-core` outside the golden corpus that
/// can tell the right slot count from a wrong one: measured, mutating the constant to
/// 5 against a corpus blessed at 4 reddens exactly two targets, the frozen corpus and
/// this one. Every other belt test in the crate derives its expectation from the
/// constant under test and passes at any value. Deriving this literal would make the
/// whole crate self-agreeing. Its derivation lives in the prose above instead, so a
/// human must update it having understood why it moved.
///
/// # IT MOVED AT PLAN 62-09, BY HAND, HAVING READ THIS PARAGRAPH (SLOT-03)
/// Phase 62 gives every belt its own advance interval (`Belt.ticks_per_slot`,
/// `62-CONTEXT.md` D-01), so a 1-tile belt's three advances take `3 * ticks_per_slot`
/// ticks and the convergence tick moves with the interval.
///
/// Plan 62-03's mutation drill measured this target RED at intervals 2, 3 and 5
/// (`62-CORPUS-REVIEW.md` FINDING 3-C), which is exactly what it is for and was NOT a
/// defect to fix there. **Plan 62-04 deliberately left it alone**: the correct new value
/// is `3 * <the shipped interval>` and the shipped interval was a maintainer decision (D-19),
/// so writing it then would either have derived the literal (destroying the one property
/// this constant has) or manufactured the number the decision reserved.
///
/// # THE RULE THIS DOCBLOCK USED TO STATE WAS WRONG, AND IT WAS CAUGHT BY MEASURING
/// **The retired sentence said the correct new value is `3 * <the shipped interval>`.**
/// That is 6 at an interval of 2, and **6 does not converge**. The measured value is
/// **5**. This is recorded rather than quietly corrected, because a rule that reads as
/// arithmetic and is wrong is more dangerous than no rule: the next reader would have
/// applied it, seen a red proptest, and looked for the defect in the sim.
///
/// **Why the rule was wrong.** It assumed the three advances begin the tick after the
/// admit, which is only true at an interval of 1. The advance gate is on the ABSOLUTE
/// tick (`tick % ticks_per_slot == 0`, `src/belt.rs`), so after an admit-to-tail at
/// `now = 1` the advances land on the DUE ticks 2, 4 and 6 - five ticks after the admit,
/// not six. The rule was only ever exercised at the identity, where `3 * 1 = 3` happens
/// to be right, so it survived two phases untested.
///
/// **The correct general form**, stated so the next mover has something true to apply:
/// with an admit-to-tail at tick `a`, the first advance is the smallest multiple of the
/// interval STRICTLY GREATER than `a`, and the remaining `slots - 2` follow one interval
/// apart. At `a = 1` and interval 2 that is 2, 4, 6, so the delivery tick is 6 and this
/// constant is 5. **Apply it by hand and then MEASURE, exactly as this plan did.**
///
/// **How 5 was obtained: watched failing, then swept.** The old 3 was watched failing on
/// the tree that had already landed the interval. The hand-derived 6 was then written,
/// watched FAILING too, and the neighbourhood swept: 4 fails, 5 PASSES, 6 fails, 7 fails.
/// The convergence value is unique and 5 is a reading, not a derivation.
///
/// **The two 8-tick drive loops below were CHECKED and did not need to move.** The
/// retired paragraph predicted they would "move with it". At 5 the convergence lands on
/// `now = 6`, and a `for t in 0..8u64` loop drives ticks 0 through 7, so it contains the
/// convergence with two ticks to spare. That is a measured no-change and not an
/// oversight; a larger interval WILL push convergence past 8 and the loops must then
/// grow, so the relationship is recorded here rather than left to be rediscovered.
const WIRE_ADMIT_TICK: u64 = 5;

/// Drain (a clone of) `collector`'s port-0 inbox in FIFO order, returning every
/// `(route_seq, item)` it has accumulated. The collector is a `Source` that never
/// consumes its inbox, so entries only APPEND — a stable cursor into per-tick
/// deliveries. Reading a clone never mutates the serialized state.
fn collector_entries(core: &Core, collector: NodeId) -> Vec<(u64, Item)> {
    let mut inbox = core
        .state
        .inbox_of(collector)
        .cloned()
        .expect("collector inbox");
    let mut out = Vec::new();
    while let Some(entry) = inbox.take(0) {
        out.push(entry);
    }
    out
}

proptest! {
    // Honor PROPTEST_CASES (CI sets 1024); `ProptestConfig::default()` reads the env
    // and defaults to 256 locally (the WR-01 fix — never hardcode `cases`).
    #![proptest_config(ProptestConfig::default())]

    /// Property 1 — the REAL delivery key `(tick, route_seq)` the SIM stamps is a
    /// STRICT TOTAL ORDER, proven against a DRIVEN `tick()` fold (not std's tuple
    /// `Ord`). Drive a mixed belt+wire grid, collect every delivered key in delivery
    /// (FIFO) order across the whole run, and assert the key sequence is STRICTLY
    /// ASCENDING lexicographically: `tick` is non-decreasing across ticks and within a
    /// tick `route_seq` strictly increases in FIFO order. Strict ascent gives, on the
    /// PRODUCTION comparator key over the ACTUAL delivery stream:
    ///   - irreflexive/antisymmetric/total: every pair of distinct deliveries has a
    ///     definite, distinct key (no two deliveries ever share `(tick, route_seq)`);
    ///   - transitive: the keys are consistently ordered along the whole stream.
    /// A regression that reused a `route_seq` value (a tie) or sorted `in_flight`
    /// (corrupting FIFO delivery order) would break the strict-ascent assertion — unlike
    /// the retired std-tuple tautology, this is coupled to the sim's ordering authority.
    #[test]
    fn delivered_route_seq_key_is_strict_total_order(
        belt_inputs in 1u16..=4,
        wire_inputs in 1u16..=4,
        seed in any::<u64>(),
    ) {
        let (mut core, topo) = belt_wire_merge_collector(seed, belt_inputs, wire_inputs);

        let belt_batch: Vec<_> = topo
            .belt_sources
            .iter()
            .enumerate()
            .map(|(i, &s)| fire(s, (i + 1) as u64, 0, Item(vec![0xB0, i as u8])))
            .collect();
        let wire_batch: Vec<_> = topo
            .wire_entries
            .iter()
            .enumerate()
            .map(|(i, &e)| {
                wire_fire(
                    (e, 0),
                    (100 + i) as u64,
                    WIRE_ADMIT_TICK,
                    (i as u64) + 1,
                    DEFAULT_WIRE_BUDGET,
                    Item(vec![0x11, i as u8]),
                )
            })
            .collect();

        // Collect the REAL `(delivery_tick, route_seq)` key of every delivery, in
        // delivery order. `route_seq` resets each tick, so tagging each with the core
        // tick it was delivered at reconstructs the sim's canonical global order.
        let mut keys: Vec<(u64, u64)> = Vec::new();
        let mut prev_len = 0usize;
        for t in 0..8u64 {
            let inbound = if t == 0 {
                belt_batch.clone()
            } else if t == WIRE_ADMIT_TICK {
                wire_batch.clone()
            } else {
                Vec::new()
            };
            let delivery_tick = core.tick; // the tick this advance folds (pre-increment)
            core.advance(&inbound);

            let entries = collector_entries(&core, topo.collector);
            for (seq, _item) in &entries[prev_len..] {
                keys.push((delivery_tick, *seq));
            }
            prev_len = entries.len();
        }

        // The production key over the ACTUAL delivery stream is a strict total order:
        // strictly ascending in delivery order (hence pairwise distinct — no ties).
        for pair in keys.windows(2) {
            prop_assert!(
                pair[0] < pair[1],
                "delivered (tick, route_seq) keys strictly ascend in delivery order: \
                 {:?} !< {:?}",
                pair[0],
                pair[1]
            );
        }
    }

    /// Property 2 — RUNTIME no-ties against a REAL `tick()` fold. For a mixed grid of
    /// `belt_inputs` belt lanes and `wire_inputs` wire lanes converging on ONE
    /// collector: (a) the `route_seq` values delivered in ANY single tick are all
    /// DISTINCT (no ties — the one counter is strictly incremented per push), and
    /// (b) belt items and wire messages DO co-deliver in one tick, proving they share
    /// the ONE `route_seq` queue (not two colliding counters).
    #[test]
    fn runtime_route_seq_has_no_ties_per_tick(
        belt_inputs in 1u16..=4,
        wire_inputs in 1u16..=4,
        seed in any::<u64>(),
    ) {
        let (mut core, topo) = belt_wire_merge_collector(seed, belt_inputs, wire_inputs);

        // Belt lanes: one `fire()` per DISTINCT belt source at tick 0 (distinct-source
        // discipline — one same-tick arrival per lane). Belt marker bytes never decode
        // as a WireEnvelope, so they classify as belt deliveries below.
        let belt_batch: Vec<_> = topo
            .belt_sources
            .iter()
            .enumerate()
            .map(|(i, &s)| fire(s, (i + 1) as u64, 0, Item(vec![0xB0, i as u8])))
            .collect();

        // Wire lanes: one `wire_fire()` per DISTINCT entry node at WIRE_ADMIT_TICK.
        let wire_batch: Vec<_> = topo
            .wire_entries
            .iter()
            .enumerate()
            .map(|(i, &e)| {
                wire_fire(
                    (e, 0),
                    (100 + i) as u64,
                    WIRE_ADMIT_TICK,
                    (i as u64) + 1,
                    DEFAULT_WIRE_BUDGET,
                    Item(vec![0x11, i as u8]),
                )
            })
            .collect();

        // Drive the fold; at EVERY tick assert the newly-delivered route_seqs are
        // distinct, and detect the tick where belt + wire co-deliver.
        let mut prev_len = 0usize;
        let mut saw_mixed_multi = false;
        for t in 0..8u64 {
            let inbound = if t == 0 {
                belt_batch.clone()
            } else if t == WIRE_ADMIT_TICK {
                wire_batch.clone()
            } else {
                Vec::new()
            };
            core.advance(&inbound);

            let entries = collector_entries(&core, topo.collector);
            let added = &entries[prev_len..];

            // (a) NO TIES: every route_seq delivered THIS tick is distinct.
            let mut seqs: Vec<u64> = added.iter().map(|(seq, _)| *seq).collect();
            let delivered = seqs.len();
            seqs.sort_unstable();
            seqs.dedup();
            prop_assert_eq!(
                seqs.len(),
                delivered,
                "route_seq is unique within a single tick (no ties across distinct sources)"
            );

            // Classify: a wire message is the encoded WireEnvelope (decodes); a belt
            // item is a raw marker (does not). Co-delivery of BOTH in one tick proves
            // belt and wire delivery share ONE route_seq counter.
            let wire_n = added
                .iter()
                .filter(|(_, item)| WireEnvelope::decode(item).is_ok())
                .count();
            let belt_n = delivered - wire_n;
            if wire_n >= 1 && belt_n >= 1 {
                saw_mixed_multi = true;
            }
            prev_len = entries.len();
        }

        prop_assert!(
            saw_mixed_multi,
            "belt items and wire messages converge in ONE tick, sharing the ONE route_seq queue"
        );
    }
}

/// Property 3 — ENCODING FIDELITY (a deterministic single-fixpoint-iteration grid).
///
/// Two sources deliver INSTANTLY (one fixpoint iteration, no belts) to one collector
/// the same tick. The destination inbox FIFO order equals ascending `route_seq` equals
/// ascending source [`NodeId`]: the lower-`NodeId` source is stepped first
/// (`drain_active_sorted`), earns the lower `route_seq`, and lands first in FIFO. This
/// is the ONLY regime where `node` order and `route_seq` order coincide (Pitfall 3), so
/// the fidelity claim is confined to it.
#[test]
fn encoding_fidelity_fifo_is_ascending_route_seq_is_ascending_nodeid() {
    let mut core = Core::genesis(header(SEED));
    let s_lo = core.state.add_source(); // allocated first -> lower NodeId
    let s_hi = core.state.add_source();
    let collector = core.state.add_source();
    core.state.link((s_lo, 0), (collector, 0));
    core.state.link((s_hi, 0), (collector, 0));
    assert!(s_lo < s_hi, "add order yields ascending NodeId (no removals)");

    // Fire both DISTINCT sources the same tick; each source emits its injected item on
    // the same tick (instant links), converging on the collector's port 0.
    core.advance(&[
        fire(s_lo, 1, 0, Item(vec![0xAA])),
        fire(s_hi, 2, 0, Item(vec![0xBB])),
    ]);

    let entries = collector_entries(&core, collector);
    assert_eq!(entries.len(), 2, "both items delivered the same tick");
    let (seq0, item0) = &entries[0];
    let (seq1, item1) = &entries[1];
    assert!(seq0 < seq1, "FIFO order is ascending route_seq");
    assert_eq!(
        item0,
        &Item(vec![0xAA]),
        "lower-NodeId source delivered first: FIFO == ascending route_seq == ascending NodeId"
    );
    assert_eq!(item1, &Item(vec![0xBB]), "higher-NodeId source delivered second");
}
