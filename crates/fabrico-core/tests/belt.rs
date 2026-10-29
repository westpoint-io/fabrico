//! SC#4: per-tile slot-belt travel through the full fold (BELT-05, SRC-02, SLOT-03).
//!
//! An item injected at tick `t0` travels `source -> belt(tiles) -> collector`.
//! Feeding a belt is transport WITH LATENCY, NOT a 0-latency instant-wire (CR-01):
//! at the fire tick the source routes the item into the belt's INBOX and schedules
//! the belt to wake the NEXT tick, so the belt admits the item to its tail one tick
//! after the fire. From that admit it needs `SLOTS_PER_TILE * tiles - 1` slot
//! advances to reach head slot 0, where the fold delivers it, and it is absent at
//! every earlier tick. This is the full-fold proof complementing the belt unit tests + the
//! `belt_slots` conservation/determinism proptests.
//!
//! # Advances are not ticks (SLOT-03)
//! A belt advances only on its own due ticks, one slot every `ticks_per_slot` of
//! them, so traverse-time in TICKS is the advance count multiplied by the belt's
//! interval, plus the alignment wait for the first due tick after the admit. The
//! `advance_slots` call runs BEFORE the admit inside `Belt::step`, so the admit tick
//! itself never advances the item it just admitted, and that alignment wait is
//! therefore between 1 and `ticks_per_slot` ticks. Head delivery is UNGATED (it is
//! the fold's job, not the belt's), so an item reaching slot 0 on a due tick leaves
//! on that same tick rather than waiting a further whole interval.
//!
//! # The traverse assertion below is SELF-AGREEING and is NOT the phase's value gate
//! It is DERIVED FROM THE INTERVAL, so it holds at every value of
//! `DEFAULT_TICKS_PER_SLOT` and can never tell you the shipped value is right. Phase
//! 60 recorded exactly this of its `SLOTS_PER_TILE`-derived predecessor and refused
//! to cite it as a gate; adding the interval to the same derivation keeps it
//! self-agreeing. The hand-pinned pin that IS admissible lives in `belt_slots.rs`
//! and is filled by plan 62-09. A later reader must not cite a green run of this
//! file as proof that the interval is right.

mod common;

use common::{fire, source_belt_collector};
use fabrico_core::belt_slots::{DEFAULT_TICKS_PER_SLOT, SLOTS_PER_TILE};
use fabrico_core::ids::Item;

#[test]
fn belt_slot_traverse_time() {
    for tiles in [1u32, 2, 5] {
        let (mut core, s, c) = source_belt_collector(7, tiles);

        // Fire one item at tick 0 — routed into the belt's inbox (feed is NOT
        // instant, CR-01), then admitted to the belt tail on the NEXT tick when the
        // belt's scheduled wake fires.
        core.advance(&[fire(s, 1, 0, Item(vec![0x42]))]);
        core.advance(&[]);

        // Traverse: SLOTS_PER_TILE*tiles - 1 slot ADVANCES tail -> head, and advances
        // happen once every `interval` ticks. Writing `advances` and `interval` as
        // separate names keeps the two units apart, which is what the pre-SLOT-03
        // form (a single `traverse` that was both) could not do.
        //
        // The bound, derived above in the module docblock: the item is absent for the
        // first `(advances - 1) * interval` ticks after the admit (it cannot possibly
        // have made its last advance yet), and is present by `advances * interval`
        // (by then every alignment offset in 1..=interval has been paid). At an
        // interval of one both ends collapse to `advances`, which is the exact tick
        // the pre-SLOT-03 assertion pinned, so this is the same statement widened by
        // exactly the alignment and by nothing else.
        //
        // NOT widened by a whole extra interval: head delivery is ungated, so an item
        // reaching slot 0 on a due tick leaves on that tick. An `advances * interval
        // + interval` upper bound would be true and would hide a real regression.
        let interval = u64::from(DEFAULT_TICKS_PER_SLOT.get());
        let advances = u64::from(SLOTS_PER_TILE * tiles - 1);
        for _ in 1..((advances - 1) * interval + 1) {
            assert!(
                core.state.inbox_of(c).is_some_and(|i| i.is_empty()),
                "absent before the traverse-time (at tick {})",
                core.tick
            );
            core.advance(&[]);
        }

        // The delivering advance lands the item in the collector exactly once, within
        // the alignment allowance.
        let mut arrived = false;
        for _ in 0..interval {
            core.advance(&[]);
            if core.state.inbox_of(c).is_some_and(|i| !i.is_empty()) {
                arrived = true;
                break;
            }
        }
        assert!(
            arrived,
            "tiles {tiles} delivered within the alignment allowance of the traverse-time"
        );
        let mut inbox = core.state.inbox_of(c).cloned().expect("collector inbox");
        let (_seq, item) = inbox.take(0).expect("collector has the item");
        assert_eq!(
            item,
            Item(vec![0x42]),
            "tiles {tiles} arrives at exactly the slot traverse-time through the full fold"
        );
        assert_eq!(inbox.take(0), None, "delivered exactly once (conservation)");
    }
}
