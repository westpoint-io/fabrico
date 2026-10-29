//! `impl Machine for Belt` — the belt as a **per-tile slot line** (BELT-05/07).
//!
//! The belt's plain data (`Belt { tiles, slots, geometry }`) lives in
//! [`crate::state`]; this module gives it behavior through the public
//! [`Machine`] trait. The v1.0 single-delay-line (`latency`/`in_flight`) is
//! RETIRED (the Phase-11 clean break): a belt is now a flat line of per-tile item
//! slots (`SLOTS_PER_TILE * tiles` of them) advanced by the certified
//! [`crate::belt_slots`] primitive.
//!
//! # The per-tick step (deliver-then-admit, at slot granularity)
//! Each tick `step` does exactly two things to its OWN `slots` (share-nothing —
//! it touches only `self.slots` + `ctx`):
//!
//! 1. **Advance**, ON A DUE TICK ONLY (SLOT-03: a tick `T` where
//!    `T % ticks_per_slot == 0`), every packed run forward by EXACTLY one slot via
//!    [`belt_slots::advance_slots`](crate::belt_slots::advance_slots). Slot 0 (the
//!    head) is NEVER auto-emptied here — head delivery is the FOLD's job
//!    ([`crate::tick`]), so an undeliverable head RETAINS in slot 0 and the belt
//!    bunches (BELT-07; the one behaviour change from v1.0's missing-link DROP).
//! 2. **Admit** at most ONE inbox item into the TAIL slot (single lane). The item
//!    is taken from the inbox ONLY when the tail is free, so a full tail leaves the
//!    item in the inbox as upstream backpressure — RETAIN, never drop (conservation
//!    is the new certification anchor; the ONLY sanctioned loss is the explicit
//!    delete-drop, BELT-08).
//!
//! Then it re-wakes itself at `tick+1` while ANY slot is occupied (AR-3: a belt
//! with an occupied slot MUST be scheduled, so it keeps advancing and a dangling
//! head stays scheduled until the fold can deliver it). Since phase 87 (JAM-04,
//! plan 87-07) the FOLD withdraws that wake when the belt is SETTLED (head held,
//! items packed from the head, nothing admissible at the tail; `tick::belt_settled`)
//! and puts the belt in the scheduler's sleep set until a delivery, the consumer that
//! frees its head's destination, a downstream tail coming free or an edit wakes it.
//! This step itself is unchanged: the share-nothing step cannot see its destination,
//! so the cross-node "can the head leave" half of the decision stays in the fold.
//!
//! # Traverse-time (BELT-05/SLOT-03 — the -1 boundary AND the interval)
//! An item admitted into the tail reaches the head after exactly `M-1` advances,
//! and advances are NOT ticks: the belt advances once every `ticks_per_slot` ticks.
//! So
//!
//! **traverse-time = `(SLOTS_PER_TILE * tiles - 1) * ticks_per_slot` advance ticks,
//! plus an admission-alignment offset of at most `ticks_per_slot - 1` ticks.**
//!
//! The `-1` is the boundary (the item occupies the tail at the admit tick, then
//! needs `M-1` shifts). The alignment offset is the wait for the first due tick
//! after the admit, and it is bounded because step (1) runs BEFORE step (2), so an
//! item never advances on the tick it was admitted. There is NO further whole
//! interval: head delivery is UNGATED (the fold's job), so an item reaching slot 0
//! on a due tick leaves on that tick.
//!
//! Capacity scales with `tiles` alone; latency scales with `tiles` AND with the
//! belt's own interval. The one-knob doctrine that said otherwise is SUPERSEDED,
//! by name, in [`crate::belt_slots`]'s `SLOTS_PER_TILE` docblock (`62-CONTEXT.md`
//! D-02). At the slot count locked by `60-CONTEXT.md` (2026-08-09) the advance
//! count is `4 * tiles - 1`: a 1-tile belt traverses in 3 advances, a 2-tile belt
//! in 7. The same contract is stated on [`crate::belt_slots`] and in
//! `tests/golden/README.md`; all three must agree.
//!
//! All belt state is plain serde data (`slots`/`geometry`, no floats, no hidden
//! fields), so a belt mid-transport is fully captured by a snapshot (CORE-09).

use crate::machine::{Machine, StepCtx};
use crate::state::Belt;

impl Machine for Belt {
    fn step(&mut self, ctx: &mut StepCtx<'_>) {
        let m = self.slots.len();
        if m == 0 {
            // A zero-tile (degenerate) belt transports nothing; it never admits and
            // never schedules — a panic-free no-op.
            return;
        }

        // (1) Advance one slot tail -> head, but ONLY on a DUE tick (SLOT-03).
        //     The head (slot 0) is NOT delivered here (the fold does that, so a
        //     blocked head bunches by staying occupied).
        //
        //     THE PREDICATE IS ON THE ABSOLUTE TICK, NEVER ON "WAS I WOKEN", and that
        //     is load-bearing in three ways:
        //       - it is a pure function of (tick, ticks_per_slot), so it carries NO
        //         phase counter, no hidden state outside the snapshot, and a belt
        //         restored mid-transport resumes on exactly the ticks it would have;
        //       - it makes the AR-3 re-wake below and the two CR-01 anti-double-step
        //         guards in `tick.rs` (`now + 1`) correct UNCHANGED: an extra wake on
        //         a non-due tick is a no-op advance rather than a double step, and a
        //         missed wake cannot shift the phase, because there is no phase to
        //         shift;
        //       - the interval is read off `self`, never off the crate's construction
        //         default in `belt_slots`. That default is consumed by `Belt::new` and
        //         by nothing in the executable path, so a per-belt override needs no
        //         change on this line.
        //
        //     NO FAST PATH FOR interval 1. A `if n == 1 { advance } else { modulo }`
        //     branch would be the retired global "one slot per tick" assumption
        //     surviving as an optimisation, and it is exactly what the deferred
        //     belt-tier phase would then have to find and delete (`62-CONTEXT.md`
        //     D-01/D-02: the old assumption is DEMOTED to the case n == 1, never
        //     retained alongside).
        //     Written as `is_multiple_of` rather than `tick % n == 0`: the two are the
        //     same predicate, and clippy's `manual_is_multiple_of` makes the modulo
        //     form a warning, which `-D warnings` turns into a third red clippy site
        //     beside D-23's two pre-existing ones. It is also the safer of the two by
        //     construction - `is_multiple_of(0)` is defined and returns a bool, where
        //     `% 0` panics - so the guarantee no longer rests on `NonZeroU32` alone.
        if ctx.tick().is_multiple_of(u64::from(self.ticks_per_slot.get())) {
            crate::belt_slots::advance_slots(&mut self.slots);
        }

        // (2) Admit at most one inbox item into the tail (single lane). Take from
        //     the inbox ONLY when the tail is free, so a full tail leaves the item
        //     in the inbox as upstream backpressure (retain, never drop). Because
        //     the tail is verified free first, `admit_tail` always accepts (returns
        //     `None`); it is the certified primitive that encodes the retain rule.
        if self.slots[m - 1].is_none()
            && let Some((_seq, item)) = ctx.take_input(0)
        {
            let _ = crate::belt_slots::admit_tail(&mut self.slots, item);
        }

        // (3) Re-wake next tick while ANY slot is occupied (AR-3): the belt must keep
        //     advancing, and an undeliverable head must stay scheduled. The FOLD takes
        //     this wake back for a settled belt (phase 87, JAM-04, plan 87-07): after the
        //     head-delivery block, a belt whose head is held, whose items are packed from
        //     the head and whose tail can admit nothing sleeps instead (`tick.rs`,
        //     `belt_settled`). That decision needs the destination, which this step must
        //     not read (CORE-03), so it is not made here.
        if self.slots.iter().any(Option::is_some) {
            ctx.schedule_wake(ctx.tick() + 1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::belt_slots::{SLOTS_PER_TILE, slot_count};
    use crate::command::Command;
    use crate::ids::{Item, NodeId, PortId};
    use crate::rng::SimRng;
    use crate::scheduler::Scheduler;
    use crate::state::{PortInbox, PortOutbox};
    use slotmap::SlotMap;
    use std::num::NonZeroU32;

    /// Mint one real generational `NodeId`.
    fn one_id() -> NodeId {
        let mut alloc: SlotMap<NodeId, ()> = SlotMap::with_key();
        alloc.insert(())
    }

    /// Drive `belt` for a single tick with the given `inputs` on port 0, draining
    /// the outbox (always empty in the slot model — the fold delivers the head).
    /// Returns the scheduler so callers can assert the AR-3 re-wake.
    fn step_belt(
        belt: &mut Belt,
        id: NodeId,
        tick: u64,
        inputs: &[Item],
        sched: &mut Scheduler,
        rng: &mut SimRng,
    ) -> Vec<(PortId, Item)> {
        let mut inbox = PortInbox::new();
        for (i, item) in inputs.iter().enumerate() {
            inbox.push(0, i as u64, item.clone());
        }
        let mut outbox = PortOutbox::new();
        let mut commands: Vec<Command> = Vec::new();
        {
            let mut ctx =
                StepCtx::new(tick, id, &mut inbox, &mut outbox, &mut commands, sched, rng);
            belt.step(&mut ctx);
        }
        // The belt never pushes to its outbox (head delivery is the fold's job).
        outbox.drain_sorted()
    }

    #[test]
    fn belt_admits_one_item_into_the_tail_then_advances() {
        let id = one_id();
        let mut sched = Scheduler::new();
        let mut rng = SimRng::from_seed_u64(1);
        let mut belt = Belt::new(1); // 1 tile => SLOTS_PER_TILE slots
        let m = slot_count(1);

        // Tick 0: admit one item — it lands at the TAIL (slot m-1), nothing exits.
        let out = step_belt(&mut belt, id, 0, &[Item(vec![0x42])], &mut sched, &mut rng);
        assert!(out.is_empty(), "belt produces no outbox output (fold delivers head)");
        assert_eq!(belt.slots[m - 1], Some(Item(vec![0x42])), "admitted at the tail");
        assert!(belt.slots[..m - 1].iter().all(Option::is_none), "only the tail is set");
        // AR-3: an occupied belt re-woke itself for the next tick.
        assert_eq!(sched.active_count_at(1), 1, "re-waked at tick+1 while occupied");
    }

    /// One slot per DUE tick, tail to head, and the `-1` traverse boundary.
    ///
    /// **This test was named `belt_step_advances_one_slot_per_tick_toward_the_head`
    /// and stepped the belt on consecutive ticks 1, 2, 3.** That is the retired model
    /// (SLOT-03, `62-CONTEXT.md` D-02): a belt advances one slot every
    /// `ticks_per_slot` ticks, so the consecutive-tick form reddens the moment the
    /// interval moves off the identity. Renamed and re-driven on DUE ticks rather
    /// than rewritten around a longer budget, because the claim it makes is about the
    /// per-advance step size and not about how often an advance happens.
    ///
    /// **IT IS SELF-AGREEING AND IS NOT THE PHASE'S VALUE GATE.** The due ticks below
    /// are computed FROM `belt.ticks_per_slot`, so this passes at every interval and
    /// can never tell you the shipped one is right. The admissible hand-pin lives in
    /// `belt_slots.rs` (`default_ticks_per_slot_pin`, filled by plan 62-09) and the
    /// hand-pinned window rates live in `tests/belt_per_tile.rs`. A later reader must
    /// not cite a green run of this case as evidence about the interval.
    ///
    /// What it DOES gate, and what nothing else in this file does: that a due-tick
    /// advance moves a run by exactly ONE slot (never two, never a full collapse) and
    /// that the head is reached after exactly `m - 1` of them. The complementary
    /// direction (that a NON-due tick does not advance) is
    /// [`belt_advances_only_on_a_due_tick`], at a hand-typed interval of 3.
    #[test]
    fn belt_step_advances_one_slot_per_due_tick_toward_the_head() {
        let id = one_id();
        let mut sched = Scheduler::new();
        let mut rng = SimRng::from_seed_u64(1);
        let mut belt = Belt::new(1);
        let m = slot_count(1);
        let interval = u64::from(belt.ticks_per_slot.get());

        // Admit at tick 0 (tail = slot m-1). Tick 0 is due at every interval, and the
        // advance runs BEFORE the admit, so the item does not move on its admit tick.
        step_belt(&mut belt, id, 0, &[Item(vec![0xAA])], &mut sched, &mut rng);
        assert_eq!(belt.slots[m - 1], Some(Item(vec![0xAA])));
        // Each subsequent DUE tick advances it ONE slot toward the head (no admit).
        for k in 1..m {
            let t = k as u64 * interval;
            step_belt(&mut belt, id, t, &[], &mut sched, &mut rng);
            assert_eq!(
                belt.slots[m - 1 - k],
                Some(Item(vec![0xAA])),
                "due tick {t} advanced it to slot {} (advance {k} of {})",
                m - 1 - k,
                m - 1
            );
        }
        // After m-1 advances it sits at the HEAD (slot 0) — the traverse-time -1
        // boundary. The head is NOT auto-emptied by step (the fold delivers it).
        assert_eq!(belt.slots[0], Some(Item(vec![0xAA])), "reached the head, retained by step");
    }

    #[test]
    fn belt_retains_on_full_tail_leaving_the_item_in_the_inbox() {
        // Backpressure (the v1.0 behaviour change): when the tail stays occupied even
        // AFTER the advance (the belt is fully packed, so nothing can move), the belt
        // does NOT take from the inbox — the item stays upstream, never dropped.
        let id = one_id();
        let mut sched = Scheduler::new();
        let mut rng = SimRng::from_seed_u64(1);
        let mut belt = Belt::new(1);
        // Fully pack the belt so the advance frees nothing and the tail stays full.
        for s in belt.slots.iter_mut() {
            *s = Some(Item(vec![0x01]));
        }

        let mut inbox = PortInbox::new();
        inbox.push(0, 7, Item(vec![0x99]));
        let mut outbox = PortOutbox::new();
        let mut commands: Vec<Command> = Vec::new();
        {
            let mut ctx =
                StepCtx::new(0, id, &mut inbox, &mut outbox, &mut commands, &mut sched, &mut rng);
            belt.step(&mut ctx);
        }
        // The item is RETAINED in the inbox (backpressure), not dropped or admitted.
        assert_eq!(inbox.take(0), Some((7, Item(vec![0x99]))), "item retained upstream");
        let _ = slot_count(1); // keep the import exercised across the suite
    }

    #[test]
    fn belt_full_belt_loses_nothing_and_keeps_scheduling() {
        // A fully packed belt: advance moves nothing (every slot-ahead is full),
        // admit is blocked (tail full), and it keeps re-waking (AR-3) — conservation.
        let id = one_id();
        let mut sched = Scheduler::new();
        let mut rng = SimRng::from_seed_u64(1);
        let mut belt = Belt::new(2);
        let m = slot_count(2);
        for s in belt.slots.iter_mut() {
            *s = Some(Item(vec![0x55]));
        }
        let before = belt.slots.clone();
        step_belt(&mut belt, id, 5, &[Item(vec![0x66])], &mut sched, &mut rng);
        assert_eq!(belt.slots, before, "fully packed belt: nothing moves, nothing lost");
        assert_eq!(sched.active_count_at(6), 1, "still scheduled while occupied (AR-3)");
        assert_eq!(SLOTS_PER_TILE * 2, m as u32, "2 tiles => 2*SLOTS_PER_TILE slots");
    }

    /// SLOT-03: the advance is GATED on the absolute tick, and the gate is proved in
    /// BOTH directions on ONE belt.
    ///
    /// The interval is set to a non-identity value IN THE TEST BODY, never taken from
    /// the crate's construction default: that default is 1 today (the identity), at
    /// which `T % n == 0` on every tick and this assertion would be VACUOUS in the
    /// "does not advance" direction. Reading the constant here would also make the
    /// test agree with it at every value, which is the exact failure mode
    /// `slots_per_tile_divides_the_render_tile` was written against (D-22).
    ///
    /// 3 is a TEST literal chosen so due and non-due ticks are both cheap to name. It
    /// is NOT a proposed belt speed: the shipped interval is a maintainer decision.
    #[test]
    fn belt_advances_only_on_a_due_tick() {
        let id = one_id();
        let mut sched = Scheduler::new();
        let mut rng = SimRng::from_seed_u64(1);
        let mut belt = Belt::new(1);
        let m = slot_count(1);
        belt.ticks_per_slot = NonZeroU32::new(3).expect("3 is non-zero");

        // Seat one item at the tail by hand, so the admit path plays no part in what
        // this test observes.
        belt.slots[m - 1] = Some(Item(vec![0xAA]));

        // Ticks 4 and 5 are NOT due (4 % 3 == 1, 5 % 3 == 2): the item does not move.
        for t in [4u64, 5] {
            step_belt(&mut belt, id, t, &[], &mut sched, &mut rng);
            assert_eq!(
                belt.slots[m - 1],
                Some(Item(vec![0xAA])),
                "tick {t} is not due (t % 3 != 0): the belt must NOT advance"
            );
            // AR-3 still fires on a NON-due tick — an occupied belt stays scheduled
            // regardless of whether this tick advanced it.
            assert_eq!(sched.active_count_at(t + 1), 1, "re-waked at tick+1 on a non-due tick");
        }

        // Tick 6 IS due (6 % 3 == 0): the item advances exactly one slot.
        step_belt(&mut belt, id, 6, &[], &mut sched, &mut rng);
        assert_eq!(belt.slots[m - 1], None, "the tail emptied on the due tick");
        assert_eq!(
            belt.slots[m - 2],
            Some(Item(vec![0xAA])),
            "tick 6 is due (6 % 3 == 0): advanced exactly one slot toward the head"
        );
        assert_eq!(sched.active_count_at(7), 1, "re-waked at tick+1 on a due tick too");
    }

    /// SLOT-03: the ADMIT path is NOT gated. A belt on a non-due tick with a free tail
    /// still takes an inbox item.
    ///
    /// Gating the admit as well would change BACKPRESSURE semantics, not just pace: an
    /// upstream machine would see a full-looking belt for `n - 1` ticks out of every
    /// `n` and retain items it could have handed over. The gate sits on the advance
    /// alone (`62-CONTEXT.md`: "any speed gate must sit on the advance, not on
    /// delivery").
    #[test]
    fn belt_admits_on_a_non_due_tick() {
        let id = one_id();
        let mut sched = Scheduler::new();
        let mut rng = SimRng::from_seed_u64(1);
        let mut belt = Belt::new(1);
        let m = slot_count(1);
        belt.ticks_per_slot = NonZeroU32::new(3).expect("3 is non-zero");

        // Tick 5 is NOT due (5 % 3 == 2) and the tail is free.
        step_belt(&mut belt, id, 5, &[Item(vec![0x42])], &mut sched, &mut rng);
        assert_eq!(
            belt.slots[m - 1],
            Some(Item(vec![0x42])),
            "the admit is ungated: a free tail takes an inbox item on a non-due tick"
        );
        assert!(belt.slots[..m - 1].iter().all(Option::is_none), "and it did not also advance");
    }

    #[test]
    fn belt_empty_belt_is_a_noop_and_does_not_schedule() {
        let id = one_id();
        let mut sched = Scheduler::new();
        let mut rng = SimRng::from_seed_u64(1);
        let mut belt = Belt::new(1);
        // No input, no occupied slot => nothing to do, and no re-wake (idle).
        let out = step_belt(&mut belt, id, 3, &[], &mut sched, &mut rng);
        assert!(out.is_empty());
        assert_eq!(sched.pending_wakes(), 0, "an empty belt schedules no wake");
    }
}
