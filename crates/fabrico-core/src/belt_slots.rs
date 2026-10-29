//! `belt_slots` — the per-tile slot-array transport PRIMITIVE (BELT-05/BELT-07).
//!
//! This is the certification-critical spike of Phase 11: the single genuinely-new
//! algorithm with no in-repo analog. It is prototyped here as a pure, standalone,
//! proptest-certified module BEFORE any `Belt`-struct swap, fold wiring, schema
//! bump, or golden-corpus re-bless (those land in 11-02+). Adding this module is
//! zero serialized-byte impact: `lib.rs` gains one `pub mod` line, nothing else.
//!
//! # The data structure
//! A belt is modelled as a line of per-tile item slots — a flat `[Option<Item>]`.
//! A length-`N` belt has `SLOTS_PER_TILE * N` slots (capacity AND traverse-time
//! both scale with `N`). Since Phase 62 traverse-time ALSO scales with the belt's
//! own advance interval, so this is TWO knobs, not one: the BELT-05 one-knob
//! doctrine that stood here is superseded by name in the `SLOTS_PER_TILE` docblock
//! below (SLOT-03, `62-CONTEXT.md` D-02). Items hold true per-slot positions
//! and visibly bunch slot-by-slot under backpressure (BELT-07).
//!
//! # Slot-index convention (load-bearing for golden hashes — document it)
//! - **slot 0 = HEAD** — the deliver / output end. The fold (11-02/11-04) takes
//!   the head for conditional downstream delivery; [`advance_slots`] NEVER
//!   auto-empties slot 0, so a blocked head bunches by leaving slot 0 occupied.
//! - **slot M-1 = TAIL** — the admit / input end. [`admit_tail`] places an
//!   arriving item here.
//! - Items advance from HIGH index toward LOW index (tail → head).
//!
//! # The advance algorithm (deliver-then-admit, at slot granularity)
//! This generalises the certified deliver-then-admit PRINCIPLE from
//! [`crate::belt`] (`belt.rs:36-79`, the continuous-feed-loses-nothing doctrine)
//! to every slot boundary. [`advance_slots`] iterates `i` ASCENDING (`1..M`) and
//! moves an occupied slot `i` into a free slot `i-1`. Because `i-1` was already
//! processed earlier in the same pass, a packed run shifts forward by EXACTLY one
//! slot per call — no shear, no skip. Processing head-toward-tail means a slot
//! freed by this pass is immediately visible to its upstream neighbour in the
//! same tick (the deliver-then-admit invariant).
//!
//! # Traverse-time contract (BELT-05/SLOT-03 — the -1 boundary AND the interval)
//! An item admitted into tail slot `M-1` advances one slot per [`advance_slots`]
//! call and reaches head slot `0` after exactly `M-1` advance calls. Advances are
//! NOT ticks (SLOT-03): a belt advances once every `ticks_per_slot` ticks, so
//!
//! **traverse-time = `(SLOTS_PER_TILE * N - 1) * ticks_per_slot` advance ticks,
//! plus an admission-alignment offset of at most `ticks_per_slot - 1` ticks.**
//!
//! The `-1` is the boundary: the item occupies the tail at the admit tick itself,
//! then needs `M-1` shifts to reach the head. The alignment offset is the wait for
//! the first due tick AFTER the admit; `advance_slots` runs BEFORE the admit inside
//! `Belt::step`, so the admit tick never advances the item it just admitted. There
//! is NO further whole interval on top: head delivery is UNGATED (it is the fold's
//! job, not the belt's), so an item that reaches slot 0 on a due tick is delivered
//! on that same tick.
//!
//! At the slot count locked by `60-CONTEXT.md` (2026-08-09) the advance count is
//! `4N - 1`: a 1-tile belt traverses in 3 advances, a 2-tile belt in 7, a 3-tile
//! belt in 11 — each multiplied by that belt's own `ticks_per_slot` to get ticks.
//! This contract is stated in exactly three places and all three must agree: here,
//! [`crate::belt`]'s module docblock, and `tests/golden/README.md`.
//!
//! # Retain, never drop (the one behaviour change vs v1.0)
//! v1.0's `belt.rs:64-70` DROPS a push beyond the depth bound. The per-tile model
//! RETAINS instead: [`admit_tail`] returns the item back (`Some`) when the tail is
//! full, so the caller leaves it upstream as backpressure. The ONLY sanctioned
//! item loss in the whole system is the explicit delete-drop (BELT-08, later
//! plans). This retain-not-drop rule is what makes the conservation invariant
//! (`delivered + resident == admitted`) the new certification anchor that
//! replaces the retired "length-1 == v1.0 depth-1 byte-identical" anchor.

// This module is the certified-in-isolation transport primitive: every public
// symbol here is consumed by `Belt::step` and the `step_node` head-delivery
// branch in 11-02/11-04, but has no non-test caller in THIS plan (which adds the
// module + a `mod` line only). Allow dead_code so the determinism clippy gate
// (`--all-targets -- -D warnings`) stays green until the 11-02 cutover wires it.
#![allow(dead_code)]

use crate::ids::Item;
use core::num::NonZeroU32;

/// Item slots per belt tile (single-lane Factorio-style packing density).
///
/// The single tunable of the belt model: a length-`N` belt has
/// `SLOTS_PER_TILE * N` slots. LOCKED at 4 by `60-CONTEXT.md` (2026-08-09).
///
/// # Version history (in words, on purpose)
/// The value was **three** from the Phase 11 cutover until Phase 60. That earlier
/// value was described here as locked by the Phase 11 CONTEXT; that parenthetical
/// is SUPERSEDED by the Phase 60 belt slot spacing decision, dated
/// 2026-08-09, and is corrected in place rather than deleted so the supersession
/// is visible. The reason for the move: the render tile is 32 px, and a
/// three-slot pitch is 32/3 = 10.667 px, which device-pixel snapping turns into a
/// repeating 11/10/11 gap alternation on a bunched belt (SEED-011). Four slots
/// divide the tile exactly, at a uniform 8 px pitch. Factorio 0.17 moved item
/// spacing for the same reason (FFF-276), which was the maintainer's stated tiebreaker.
///
/// # The consequence, accepted in advance as a bug fix and NOT rebalanced (SLOT-02)
/// Capacity and traverse-time both rise by a third; visible item speed drops 25%
/// (10.667 px/tick to 8 px/tick).
///
/// # Version history of the two sentences that stood here (in words, on purpose)
/// This paragraph used to close with a throughput claim and a refusal, and Phase 62
/// retires BOTH. They are corrected in place rather than deleted, so the supersession
/// reads as a diff (the same shape the slot-count history above uses).
///
/// **The retired throughput sentence** read: *"steady-state throughput is UNCHANGED
/// at one item per tick, because throughput is gated by the advance rate, not by slot
/// count."* Its second clause is still true and its first is now FALSE. Phase 62 moves
/// the advance rate, so throughput moves with it: a belt at one slot per `n` ticks
/// delivers one item per `n` ticks. **That division is ACCEPTED, not compensated**
/// (`62-CONTEXT.md` D-04, SLOT-04). Slowing the belt is the point of the change; a
/// compensating multiplier would give back exactly what was bought.
///
/// **The retired refusal** read: *"The advance rate is deliberately NOT touched:
/// compensating would require a belt-local rate multiplier, i.e. a SECOND knob, and
/// the model's contract above is that capacity and traverse-time scale together off
/// ONE knob (BELT-05)."* Phase 62 TAKES that second knob, deliberately and on the
/// record (`62-CONTEXT.md` D-01/D-02, SLOT-03): it is
/// [`Belt.ticks_per_slot`](crate::state::Belt::ticks_per_slot), per-belt serialized
/// state, defaulted from [`DEFAULT_TICKS_PER_SLOT`] below.
///
/// **What still holds, unchanged.** Capacity is still `SLOTS_PER_TILE * N` off the
/// LENGTH knob alone, and traverse-time still scales linearly with length. What
/// changed is that traverse-time now ALSO scales with the belt's own interval, which
/// is why the contract at the top of this module states both factors. The one-knob
/// doctrine is superseded as a MODEL claim; the length knob it described is intact.
///
/// # Changing this value is a phase, not an edit
/// The pitch is pinned by `tests::slots_per_tile_divides_the_render_tile` below,
/// which no golden-corpus re-bless can satisfy. See that test for why.
pub const SLOTS_PER_TILE: u32 = 4;

/// Sim TICKS between one slot advance — the belt model's SECOND knob (SLOT-03).
///
/// A belt advances its packed runs by one slot on every tick `T` where
/// `T % ticks_per_slot == 0`. **Units: ticks per slot. LARGER MEANS SLOWER.** At
/// `n` the belt moves one slot every `n` ticks, so its steady-state throughput is
/// one item per `n` ticks and its traverse time is
/// `(SLOTS_PER_TILE * N - 1) * n` ticks for a length-`N` belt, plus an
/// admission-alignment offset of at most `n - 1` ticks (the module docblock above
/// derives both terms, and is the first of the three places that must agree).
///
/// # This is a CONSTRUCTION default and nothing else
/// The interval is per-belt SERIALIZED STATE on
/// [`Belt.ticks_per_slot`](crate::state::Belt::ticks_per_slot). This constant is
/// consumed by [`Belt::new`](crate::state::Belt::new) and by NOTHING in the
/// executable path: [`crate::belt`]'s `step` reads `self.ticks_per_slot`, never
/// this constant. That separation is what makes a later per-belt override (the
/// deferred belt-tier phase) a balance-and-UI job rather than a core change.
///
/// # It supersedes the BELT-05 one-knob refusal above, on the record
/// The `SLOTS_PER_TILE` docblock declined a belt-local rate multiplier as "a SECOND
/// knob". Phase 62 takes that knob deliberately (`62-CONTEXT.md` D-01/D-02,
/// SLOT-03). **That refusal has now been rewritten in place, by plan 62-04**, under
/// the heading "Version history of the two sentences that stood here": it quotes the
/// retired refusal verbatim, names what took it, and records what still holds
/// (capacity off the LENGTH knob; traverse-time still linear in length; traverse-time
/// now ALSO scaling with the belt's own interval). This constant is where the knob
/// lives; that docblock is where its supersession is recorded. Neither states it
/// alone.
///
/// # Version history (in words, on purpose)
/// The same shape `SLOTS_PER_TILE` uses above, and for the same reason: a constant
/// that carries only its current value tells the next reader nothing about what it
/// cost to get there.
///
/// **1, from plan 62-01 to plan 62-09 (2026-08-13 to 2026-08-14). The pre-change
/// IDENTITY, never a candidate.** `T % 1 == 0` on every tick, so a belt at 1
/// advanced exactly as every belt did before Phase 62: the same model, the same
/// arrival ticks, the same golden hashes from the timing side. It shipped for four
/// waves so the SHAPE change (`Belt.ticks_per_slot` as serialized state) could be
/// landed and reviewed WITHOUT a behaviour change riding inside it, which is the
/// only way either one is separately readable.
///
/// **2, from 2026-08-14. CHOSEN BY HAND ON THE REAL BINARY.**
///
/// | | |
/// |---|---|
/// | Value | **2 ticks per slot** |
/// | Chosen by | the maintainer, after a hands-on pace test |
/// | When | 2026-08-14, at the hands-on pace test reserved by decision D-19 |
/// | On what build | the real self-contained WebKitGTK `fabrico-app`, built with `--features tauri/custom-protocol` so the frontend is embedded and no dev server is in the loop |
/// | Landed by | plan 62-09, in the ONE quarantined reviewed corpus re-bless (D-21) |
///
/// **It was chosen knowing the cost, which is why the choice is a judgement and not a
/// first impression.** The trade-off considered: 2 is exactly HALF today's pace, it
/// is the FASTEST value decision D-06's Nyquist floor permits, and it therefore sits
/// at the TOP edge of the comfortable band Phase 61 measured (roughly 120 to 240
/// px/sec); at the shipped 8 px slot pitch it yields 240 px/sec. The value was
/// confirmed with that trade-off in view. **2 is the least slowing that clears the
/// direction-ambiguity wall**, and it is the option with the least margin against it.
/// A dash pattern cannot convey motion faster than half its period per drawn frame,
/// today's item speed sits ON that wall, and this is the answer to it.
///
/// **Changing it again is a PHASE, not an edit.** It re-blesses all 27 golden
/// fixtures, moves three hand-pinned tick hashes and three insta snapshots, and
/// spends a reviewed re-bless that `62-CONTEXT.md` D-21 permits once.
///
/// # The pin, and why it asserts TWO things
/// [`tests::default_ticks_per_slot_pin`] is the only gate in this crate a golden
/// re-bless cannot satisfy. It asserts the value AND a hand-typed measured arrival
/// tick, because Phase 60 measured 308 of 309 `fabrico-core` library tests green at
/// a WRONG constant: every one of them derived its expectation from the constant
/// under test and therefore agreed with it at every value (D-22).
pub const DEFAULT_TICKS_PER_SLOT: NonZeroU32 = match NonZeroU32::new(2) {
    Some(n) => n,
    // Unreachable: the literal above is a non-zero constant. Written as a `match`
    // rather than `.unwrap()` so the literal stays visible at the declaration
    // (a `NonZeroU32::MIN` would hide which number ships) in a const context.
    None => panic!("DEFAULT_TICKS_PER_SLOT must be non-zero"),
};

/// The number of slots backing a length-`tiles` belt: `SLOTS_PER_TILE * tiles`.
///
/// Overflow-safe: uses `saturating_mul` so even an absurd `tiles` argument can
/// never wrap. (The real bound is `MAX_BELT_TILES`, enforced at the decode
/// boundary in 11-02; this fn must be total regardless.)
pub(crate) fn slot_count(tiles: u32) -> usize {
    SLOTS_PER_TILE.saturating_mul(tiles) as usize
}

/// Advance every packed run of items forward by EXACTLY one slot (tail → head).
///
/// For each `i` in `1..len`, if slot `i` is occupied and slot `i-1` is free, the
/// item moves `i -> i-1`. Ascending iteration guarantees one-slot-per-call (a
/// freed slot is visible to its upstream neighbour in the same pass). Slot 0 (the
/// head) is NEVER auto-emptied here — head delivery is the fold's job (11-02/04),
/// so a blocked head bunches by remaining occupied.
pub(crate) fn advance_slots(slots: &mut [Option<Item>]) {
    for i in 1..slots.len() {
        if slots[i].is_some() && slots[i - 1].is_none() {
            slots[i - 1] = slots[i].take();
        }
    }
}

/// Admit `item` into the tail slot (`M-1`), or RETAIN it on backpressure.
///
/// Returns `None` when the item was placed (tail was free), or `Some(item)` when
/// the tail is full or the belt has zero slots — the caller keeps the item
/// upstream (backpressure). Never drops (conservation).
pub(crate) fn admit_tail(slots: &mut [Option<Item>], item: Item) -> Option<Item> {
    match slots.last_mut() {
        Some(tail @ None) => {
            *tail = Some(item);
            None
        }
        // Tail full, or zero-length belt: retain the item upstream.
        _ => Some(item),
    }
}

/// Peek the head slot (slot 0) without removing it.
///
/// Lets the fold (11-02/04) inspect the head for a conditional downstream
/// delivery decision without committing to take it (so it can be retained for
/// bunching when the downstream cannot accept).
pub(crate) fn head(slots: &[Option<Item>]) -> Option<&Item> {
    slots.first().and_then(Option::as_ref)
}

/// Take the head item (slot 0), leaving it empty.
///
/// The fold calls this only once it has confirmed the downstream can accept the
/// head item; otherwise it leaves the head in place (bunching).
pub(crate) fn take_head(slots: &mut [Option<Item>]) -> Option<Item> {
    slots.first_mut().and_then(Option::take)
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    /// Drive a bare slot array through the per-tick belt loop and report the
    /// conservation ledger. Each tick, in the CONTEXT-locked order:
    ///   1. `advance_slots` (items shift one slot tail->head),
    ///   2. if `block_schedule[t]` is true (downstream NOT blocked) deliver the
    ///      head (`take_head`) and count it; if false the head bunches (retained),
    ///   3. admit the next feed item to the tail — but only count it admitted when
    ///      `admit_tail` accepts it (`None`); on backpressure (`Some`) the item is
    ///      RETAINED upstream and retried next tick (never dropped).
    ///
    /// Runs well past the last feed so steady state + draining are exercised.
    ///
    /// Returns `(per_tick_delivered, final_slots, admitted, delivered)`. This is a
    /// PURE, deterministic function of its inputs (the determinism anchor).
    fn simulate(
        tiles: u32,
        feed: &[u8],
        block_schedule: &[bool],
    ) -> (Vec<u32>, Vec<Option<Item>>, u64, u64) {
        let mut slots: Vec<Option<Item>> = vec![None; slot_count(tiles)];
        let mut feed_idx = 0usize;
        let mut admitted = 0u64;
        let mut delivered = 0u64;
        // Generous horizon: enough ticks to attempt every feed item against
        // backpressure, then drain the full belt several times over.
        let total_ticks = feed.len() + slots.len() * 2 + 64;
        let mut per_tick_delivered = Vec::with_capacity(total_ticks);

        for t in 0..total_ticks {
            advance_slots(&mut slots);

            let mut this_tick = 0u32;
            // block_schedule is non-empty (1..); cycle it deterministically.
            let unblocked = block_schedule[t % block_schedule.len()];
            if unblocked && take_head(&mut slots).is_some() {
                delivered += 1;
                this_tick = 1;
            }

            if feed_idx < feed.len() {
                let item = Item(vec![feed[feed_idx]]);
                if admit_tail(&mut slots, item).is_none() {
                    admitted += 1;
                    feed_idx += 1;
                }
                // else: backpressure — retain, retry next tick (feed_idx unchanged).
            }
            per_tick_delivered.push(this_tick);
        }

        (per_tick_delivered, slots, admitted, delivered)
    }

    /// SLOT-01: the slot pitch must DIVIDE the render tile, and the divided pitch
    /// must be exactly 8 px. This is the one assertion in `fabrico-core` that a
    /// golden-corpus re-bless cannot satisfy: the corpus is regenerated FROM
    /// `SLOTS_PER_TILE`, so it agrees with the constant at every value, and so does
    /// every other belt test in the workspace. Mutating the constant to 5 against a
    /// corpus blessed at 4 leaves **321** tests GREEN across the five targets that
    /// were actually run: 308 of the 309 `fabrico-core` lib tests (the one failure IS
    /// this pin), plus `belt`, `belt_per_tile`, `fault` and `edit_merge` entire.
    /// MEASURED, not estimated: `60-CORPUS-REVIEW.md`, "The surviving set at 5".
    ///
    /// This line used to say "roughly 370", which is `60-RESEARCH.md`'s estimate of
    /// belt-exercising tests WORKSPACE-WIDE. That estimate was never measured and it
    /// is not what this docblock reports, so quoting it here read as a measurement
    /// that had not been taken - in the one phase whose whole argument is that a green
    /// suite is not evidence.
    ///
    /// `RENDER_TILE_PX` is declared HERE and imported from nowhere: not from the
    /// frontend, not from another Rust constant. An expectation derived from the
    /// thing it checks cannot fail, which is the doctrine Phase 57 recorded for the
    /// board-local elbow radius and Phase 60 mirrors on the TypeScript side.
    ///
    /// Both assertions are load-bearing and neither is redundant. Divisibility
    /// alone passes at 1, 2, 4, 8, 16 and 32, so it reddens at 5 but NOT at 8. The
    /// quotient assertion is what pins the LOCKED value: it is the only thing that
    /// reddens at 8. A non-dividing pitch is what produced the defect this phase
    /// fixes: 32/3 = 10.667 px, which device-pixel snapping renders as a repeating
    /// 11/10/11 gap alternation on a bunched belt (SEED-011).
    ///
    /// Changing the pinned value is a PHASE, not an edit. It moves the serialized
    /// belt shape, forces a snapshot-version bump, and re-blesses all 27 golden
    /// fixtures. See `60-CONTEXT.md` (2026-08-09).
    #[test]
    fn slots_per_tile_divides_the_render_tile() {
        // frontend/shared/geometry.ts: `export const CELL = 32;`
        const RENDER_TILE_PX: u32 = 32;
        assert_eq!(
            RENDER_TILE_PX % SLOTS_PER_TILE,
            0,
            "SLOTS_PER_TILE must divide the {RENDER_TILE_PX}px render tile (SLOT-01)"
        );
        assert_eq!(
            RENDER_TILE_PX / SLOTS_PER_TILE,
            8,
            "the locked slot pitch is 8px (SLOT-01, 60-CONTEXT.md); changing it is a phase, not an edit"
        );
    }

    /// SLOT-03: the pin on the SHIPPED advance interval, and its consequence.
    ///
    /// **FILLED BY PLAN 62-09 ON 2026-08-14, AND THE `#[ignore]` IS GONE.** It stood
    /// unimplemented and ignored from plan 62-01 to here because decision D-19
    /// reserved the value to a human decision on the real self-contained WebKitGTK
    /// binary, made BEFORE any golden fixture was re-blessed. No automated step could
    /// infer, default to or manufacture it, and a placeholder assertion
    /// would have manufactured exactly the number the decision reserved.
    ///
    /// **The value below comes from the recorded pace-test verdict and from nowhere
    /// else.** Not from a summary, not from a screenshot caption.
    ///
    /// # It asserts TWO things and NEITHER is redundant (D-22)
    /// This is the shape `slots_per_tile_divides_the_render_tile` two tests up
    /// established, and the reasoning is the same reasoning:
    ///
    /// **(A) THE VALUE.** A hand-typed integer against the shipped constant. On its
    /// own this catches a silent edit to the constant and nothing else.
    ///
    /// **(B) THE CONSEQUENCE, HAND-TYPED FROM A MEASUREMENT.** A lone item is admitted
    /// to a REAL 3-tile [`Belt`](crate::state::Belt) built through
    /// [`Belt::new`](crate::state::Belt::new) - which is the one call site that
    /// consumes `DEFAULT_TICKS_PER_SLOT` - and driven through the belt's own
    /// [`Machine::step`](crate::machine::Machine::step). The tick at which it first
    /// occupies the HEAD slot is compared against `HEAD_ARRIVAL_TICK`, an integer
    /// TYPED HERE that appears nowhere else and is not an expression over anything.
    ///
    /// **Why (B) is not merely (A) restated.** (A) is a value comparison; (B) is a
    /// behavioural one, and the two fail for different causes. (A) alone would stay
    /// green if the advance GATE in [`crate::belt`] were removed, because a belt with
    /// no gate runs at the identity pace while the constant still reads 2 - the exact
    /// complementary mutation plan 62-03 drilled on the `belt_per_tile` quotients.
    /// (B) alone would stay green under a compensating pair of edits. Together they
    /// pin the number and the behaviour it is supposed to produce.
    ///
    /// **Why the expected arrival is TYPED and never DERIVED.** A value derived from
    /// the constant under test agrees with that constant at EVERY value and can
    /// therefore never fail. This is not a theoretical hazard: Phase 60 measured
    /// **308 of 309 `fabrico-core` library tests GREEN at a WRONG constant**
    /// (`60-CORPUS-REVIEW.md`, "The surviving set at 5"), because every belt test in
    /// the crate derived its expectation from the thing it was supposed to be
    /// checking. `62-CONTEXT.md` D-22 is that measurement turned into a rule. Writing
    /// `(SLOTS_PER_TILE * TILES - 1) * DEFAULT_TICKS_PER_SLOT.get()` here would look
    /// more rigorous and would assert nothing at all.
    ///
    /// **This pin is the ONLY gate in this crate that a golden-corpus re-bless cannot
    /// satisfy.** The corpus is regenerated FROM the constant, so it agrees with
    /// whatever the constant says; `tests/belt.rs`, `tests/fault.rs` and every
    /// interval-aware case plans 62-03 and 62-04 wrote are SELF-AGREEING by
    /// construction and recorded as such in place. A later reader must not cite a
    /// green belt suite as evidence that the shipped interval is right.
    #[test]
    fn default_ticks_per_slot_pin() {
        use crate::ids::{Item, NodeId};
        use crate::machine::{Machine, StepCtx};
        use crate::rng::SimRng;
        use crate::scheduler::Scheduler;
        use crate::state::{Belt, PortInbox, PortOutbox};
        use slotmap::SlotMap;

        // (A) THE VALUE. Hand-typed from the 2026-08-14 pace-test verdict.
        const SHIPPED_INTERVAL: u32 = 2;
        assert_eq!(
            DEFAULT_TICKS_PER_SLOT.get(),
            SHIPPED_INTERVAL,
            "the shipped advance interval is {SHIPPED_INTERVAL} ticks per slot, chosen by hand at \
             the 2026-08-14 pace test; changing it re-blesses the whole golden corpus and is a \
             phase, not an edit"
        );

        // (B) THE CONSEQUENCE, hand-typed from a MEASUREMENT of the real belt.
        //
        // The belt below is 3 tiles, so it has SLOTS_PER_TILE * 3 = 12 slots and a
        // lone item admitted at the tail must cross 11 of them to reach the head.
        // TILES is stated here rather than swept because the number under it is a
        // MEASURED integer for THIS length: sweeping lengths would force the
        // expectation to become a formula, and a formula over the constant is
        // precisely what D-22 forbids.
        const TILES: u32 = 3;
        /// The tick on which the lone item first occupies the HEAD slot.
        ///
        /// **HAND-TYPED, MEASURED, AND DELIBERATELY NOT AN EXPRESSION.** Read off a
        /// real run of the loop below on 2026-08-14 after `cargo clean -p
        /// fabrico-core`, having first watched this assertion FAIL against a
        /// deliberately wrong value so the number is a reading rather than a guess.
        ///
        /// It is 22 because the belt advances only on ticks where
        /// `tick % ticks_per_slot == 0`, the advance runs BEFORE the admit (so the
        /// item does not move on the tick it is admitted), and 11 advances at every
        /// second tick land on ticks 2, 4, ... 22. At an interval of 1 it would be
        /// 11 and at 3 it would be 33, so this integer discriminates the shipped
        /// value in both directions.
        const HEAD_ARRIVAL_TICK: u64 = 22;

        let id: NodeId = {
            let mut alloc: SlotMap<NodeId, ()> = SlotMap::with_key();
            alloc.insert(())
        };
        let mut sched = Scheduler::new();
        let mut rng = SimRng::from_seed_u64(0x5107_0503);
        // Belt::new is the ONE call site that consumes DEFAULT_TICKS_PER_SLOT, so
        // driving a real belt is what makes this a behavioural reading rather than
        // arithmetic over the constant.
        let mut belt = Belt::new(TILES);
        let m = slot_count(TILES);
        assert_eq!(m, 12, "a 3-tile belt has 12 slots at the locked SLOTS_PER_TILE");

        // A generous drive bound: enough for any interval a sane pin could hold, and
        // an upper bound rather than an expectation, so it can never become the thing
        // being asserted.
        const MAX_DRIVE_TICKS: u64 = 512;
        let mut head_arrival: Option<u64> = None;
        for tick in 0..MAX_DRIVE_TICKS {
            // One item, offered ONCE at tick 0. Nothing is fed afterwards, so what is
            // measured is transport and never admission pressure.
            let inputs: &[Item] = if tick == 0 { &[Item(vec![0xA1])] } else { &[] };
            let mut inbox = PortInbox::new();
            for (i, item) in inputs.iter().enumerate() {
                inbox.push(0, i as u64, item.clone());
            }
            let mut outbox = PortOutbox::new();
            let mut commands = Vec::new();
            {
                let mut ctx =
                    StepCtx::new(tick, id, &mut inbox, &mut outbox, &mut commands, &mut sched, &mut rng);
                belt.step(&mut ctx);
            }
            if head_arrival.is_none() && belt.slots[0].is_some() {
                head_arrival = Some(tick);
                break;
            }
        }

        assert_eq!(
            head_arrival,
            Some(HEAD_ARRIVAL_TICK),
            "a lone item admitted at tick 0 to a real {TILES}-tile belt must first occupy the head \
             slot on tick {HEAD_ARRIVAL_TICK}. This integer is HAND-TYPED from a measurement and is \
             NOT derived from DEFAULT_TICKS_PER_SLOT (62-CONTEXT.md D-22): a value derived from the \
             constant under test agrees with it at every value, and Phase 60 measured 308 of 309 \
             fabrico-core library tests green at a WRONG constant for exactly that reason"
        );
    }

    /// A length-N belt has exactly `SLOTS_PER_TILE * N` slots.
    #[test]
    fn slot_count_couples_capacity_to_length() {
        assert_eq!(slot_count(0), 0);
        assert_eq!(slot_count(1), SLOTS_PER_TILE as usize);
        assert_eq!(slot_count(10), (SLOTS_PER_TILE * 10) as usize);
    }

    /// `slot_count` is total — a huge argument saturates rather than wrapping.
    #[test]
    fn slot_count_is_overflow_safe() {
        // SLOTS_PER_TILE * u32::MAX would wrap a naive `*`; saturating_mul caps it.
        let n = slot_count(u32::MAX);
        assert_eq!(n, u32::MAX as usize, "saturates at u32::MAX, no wrap/panic");
    }

    /// A packed run shifts forward by EXACTLY one slot per call (no shear, no skip).
    #[test]
    fn advance_shifts_packed_run_one_slot() {
        let mut slots = vec![None, Some(Item(vec![0xA])), Some(Item(vec![0xB]))];
        advance_slots(&mut slots);
        assert_eq!(
            slots,
            vec![Some(Item(vec![0xA])), Some(Item(vec![0xB])), None],
            "the whole packed run advanced one slot toward the head"
        );
    }

    /// A second call advances the run another single slot — head bunches at slot 0.
    #[test]
    fn advance_is_one_slot_per_call_not_a_full_collapse() {
        let mut slots = vec![None, None, Some(Item(vec![1]))];
        advance_slots(&mut slots);
        assert_eq!(slots, vec![None, Some(Item(vec![1])), None], "moved 2 -> 1");
        advance_slots(&mut slots);
        assert_eq!(slots, vec![Some(Item(vec![1])), None, None], "moved 1 -> 0");
        // Slot 0 is never auto-emptied: a third advance leaves the head in place.
        advance_slots(&mut slots);
        assert_eq!(slots, vec![Some(Item(vec![1])), None, None], "head retained");
    }

    /// An item blocked behind an occupied slot ahead does NOT advance (collision).
    #[test]
    fn advance_blocks_behind_occupied_slot() {
        let mut slots = vec![Some(Item(vec![1])), Some(Item(vec![2])), Some(Item(vec![3]))];
        advance_slots(&mut slots);
        assert_eq!(
            slots,
            vec![Some(Item(vec![1])), Some(Item(vec![2])), Some(Item(vec![3]))],
            "fully packed belt: nothing moves, nothing lost"
        );
    }

    /// admit_tail places into a free tail and returns None.
    #[test]
    fn admit_tail_fills_free_tail() {
        let mut slots = vec![None, None, None];
        let ret = admit_tail(&mut slots, Item(vec![0x42]));
        assert_eq!(ret, None, "admitted -> nothing returned");
        assert_eq!(slots, vec![None, None, Some(Item(vec![0x42]))], "placed at tail");
    }

    /// admit_tail RETAINS (returns Some) and leaves the array unchanged when the
    /// tail is full — backpressure, never drop (the v1.0 behaviour change).
    #[test]
    fn admit_tail_retains_on_full_tail() {
        let mut slots = vec![None, None, Some(Item(vec![0x01]))];
        let before = slots.clone();
        let ret = admit_tail(&mut slots, Item(vec![0x99]));
        assert_eq!(ret, Some(Item(vec![0x99])), "full tail -> item retained");
        assert_eq!(slots, before, "array unchanged on backpressure");
    }

    /// A zero-length belt admits nothing and retains the item.
    #[test]
    fn admit_tail_retains_on_zero_length() {
        let mut slots: Vec<Option<Item>> = vec![];
        let ret = admit_tail(&mut slots, Item(vec![0x07]));
        assert_eq!(ret, Some(Item(vec![0x07])), "no slots -> retain");
        assert!(slots.is_empty());
    }

    /// head peeks slot 0 without removing; take_head removes it.
    #[test]
    fn head_peeks_and_take_head_removes() {
        let mut slots = vec![Some(Item(vec![0xFE])), None, None];
        assert_eq!(head(&slots), Some(&Item(vec![0xFE])), "peek the head");
        assert!(slots[0].is_some(), "peek does not remove");
        let taken = take_head(&mut slots);
        assert_eq!(taken, Some(Item(vec![0xFE])), "take removes the head");
        assert_eq!(slots, vec![None, None, None], "head now empty");
        assert_eq!(take_head(&mut slots), None, "nothing left to take");
    }

    /// Traverse-time contract: an item admitted at the tail reaches the head after
    /// exactly M-1 advance calls (the documented -1 boundary).
    #[test]
    fn traverse_time_is_slot_count_minus_one() {
        let tiles = 2u32;
        // 8 slots: SLOTS_PER_TILE (4, since Phase 60) * 2 tiles. The trailing comment
        // here said six from the Phase 11 cutover until now, i.e. it was wrong from
        // the day Phase 60 moved the constant from three to four (SLOT-03,
        // `62-CONTEXT.md` "fix four stale literals in passing"). The assertions below
        // are written in `m`, so the stale comment misled a reader without ever
        // failing a test.
        let m = slot_count(tiles); // 8
        let mut slots: Vec<Option<Item>> = vec![None; m];
        assert_eq!(admit_tail(&mut slots, Item(vec![0xAA])), None);
        // After exactly m-1 advances the item is at the head, not before.
        for k in 0..m - 1 {
            assert!(head(&slots).is_none(), "head still empty after {k} advances");
            advance_slots(&mut slots);
        }
        assert_eq!(head(&slots), Some(&Item(vec![0xAA])), "at head after m-1 advances");
    }

    /// BELT-07 demonstrator: with the head PERMANENTLY blocked, items always form
    /// a CONTIGUOUS run (no interior gaps — they advance ONE SLOT PER ADVANCE CALL
    /// at the same rate they are fed), the run packs up against the blocked head end
    /// so the final saturated state is a head-anchored prefix `[0..M)`, and once full
    /// `admit_tail` returns `Some` (upstream backpressure) — proving no silent loss.
    ///
    /// This docblock said "one slot/tick", which is retired (SLOT-03, `62-CONTEXT.md`
    /// D-02): a belt advances one slot every `ticks_per_slot` ticks. The loop below
    /// drives `advance_slots` DIRECTLY, once per iteration, so it is a statement about
    /// the primitive and never about the tick rate — which is exactly why the retired
    /// wording was gratuitous here as well as false.
    #[test]
    fn bunching_packs_from_the_blocked_end() {
        // 8 slots: SLOTS_PER_TILE (4) * 2 tiles. The trailing comment here said six
        // and has been wrong since Phase 60 moved the constant, for the same reason
        // as the sibling literal above.
        let mut slots: Vec<Option<Item>> = vec![None; slot_count(2)]; // 8 slots
        let mut backpressure_seen = false;

        for t in 0..20u32 {
            advance_slots(&mut slots);
            // Head permanently blocked: never take_head -> the head bunches.
            let item = Item(vec![(t & 0xFF) as u8]);
            if admit_tail(&mut slots, item).is_some() {
                backpressure_seen = true; // tail full -> retained, never dropped
            }
            // The occupied slots are always a single CONTIGUOUS run (no interior
            // gaps): items enter at the tail and advance one slot per advance call
            // toward the head, so the run is gap-free whether it is still in transit
            // (anchored near the tail) or bunched against the blocked head. The rate
            // in TICKS is the belt's own `ticks_per_slot` (SLOT-03) and is not a term
            // in this loop, which calls the primitive directly.
            let first = slots.iter().position(Option::is_some);
            let last = slots.iter().rposition(Option::is_some);
            let total = slots.iter().filter(|s| s.is_some()).count();
            if let (Some(f), Some(l)) = (first, last) {
                assert_eq!(l - f + 1, total, "tick {t}: occupied slots are gap-free");
            }
        }

        // Once the head stays blocked the belt saturates: a head-anchored prefix
        // `[0..M)` filling the whole array (items piled up from slot 0 upward).
        assert!(
            slots.iter().all(Option::is_some),
            "belt saturates: contiguous prefix from slot 0 fills every slot"
        );
        assert!(
            backpressure_seen,
            "admit_tail returned Some once saturated — backpressure, no silent loss"
        );
    }

    proptest! {
        #![proptest_config(ProptestConfig::default())] // honors PROPTEST_CASES (CI=1024)

        /// THE certification anchor: across any random block schedule over 1..=10
        /// tiles, items conserve — `delivered + resident == admitted` (no creation,
        /// no silent loss; over-cap RETAINS, never drops).
        #[test]
        fn belt_conserves_items_under_random_backpressure(
            tiles in 1u32..=10,
            feed in proptest::collection::vec(0u8..=255, 0..40),
            block_schedule in proptest::collection::vec(any::<bool>(), 1..40),
        ) {
            let (_per_tick, final_slots, admitted, delivered) =
                simulate(tiles, &feed, &block_schedule);
            let resident = final_slots.iter().filter(|s| s.is_some()).count() as u64;
            prop_assert_eq!(
                delivered + resident,
                admitted,
                "conservation: delivered + resident == admitted"
            );
            // Admitted can never exceed what was fed (no creation).
            prop_assert!(admitted <= feed.len() as u64, "no item created from nothing");
        }

        /// Determinism anchor: the advance is a pure function of its inputs — a
        /// second identical run yields the identical per-tick delivered sequence
        /// AND the byte-identical final slot vector.
        #[test]
        fn belt_advance_is_deterministic(
            tiles in 1u32..=10,
            feed in proptest::collection::vec(0u8..=255, 0..40),
            block_schedule in proptest::collection::vec(any::<bool>(), 1..40),
        ) {
            let a = simulate(tiles, &feed, &block_schedule);
            let b = simulate(tiles, &feed, &block_schedule);
            prop_assert_eq!(&a.0, &b.0, "identical per-tick delivered sequence");
            prop_assert_eq!(&a.1, &b.1, "byte-identical final slot vector");
            prop_assert_eq!(a.2, b.2, "identical admitted count");
            prop_assert_eq!(a.3, b.3, "identical delivered count");
        }
    }
}
