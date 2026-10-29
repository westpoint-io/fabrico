//! Phase 11 plan 04 — the INTEGRATED (Core + snapshot) certification of the
//! per-tile slot belt through the FOLD.
//!
//! 11-01's `belt_slots` proptests certify the per-slot advance PRIMITIVE in pure
//! isolation (conservation + determinism of the bare algorithm). This suite is the
//! complementary fold-level proof: it drives a REAL `Core` (genesis → `advance` →
//! `snapshot`) and proves that, THROUGH the share-nothing fold + fold-mediated
//! boundary delivery,
//!
//!   1. **Conservation** — `delivered + resident == admitted` under random feed
//!      schedules and random belt lengths (no item created, none lost; the only
//!      sanctioned loss is the explicit delete-drop, which this suite never issues).
//!   2. **Determinism** — the per-tick `blake3(snapshot)` sequence is byte-identical
//!      across two identical replays (the PRIMARY assertion — the snapshot hash, not
//!      item counts, is the determinism oracle).
//!   3. **Snapshot-equivalence** — a mid-flow snapshot/restore continues to the SAME
//!      remaining per-tick hash sequence (no in-flight slot item stranded, none
//!      resurrected) — REPLAY-01.
//!
//! Backpressure is driven belt->belt into a STALLED TAIL (a downstream belt whose
//! head is dangling = a permanently full tail), NEVER a stalled machine — machine
//! inboxes are unbounded, so a belt->machine never bunches (RESEARCH Pitfall 1 / A4;
//! inserter-side backpressure is deferred). All math is integer; no float, no
//! `HashMap` (the crate clippy gate denies both); the only collections are `Vec` /
//! the belt's `slots`.
//!
//! # BUDGETS ARE DERIVED, ASSERTIONS ARE HAND-PINNED (SLOT-03, plan 62-03)
//!
//! **A tick BUDGET is derived from the belt's advance interval.** A budget is
//! headroom, not an expectation, so every one in this file is multiplied by
//! [`advance_interval`] and re-derives for free at whatever interval ships: a
//! number that stretches with the interval at every value is exactly what a budget
//! is for. An unraised budget does not fail loudly at a longer interval; it stops
//! reaching the moment it is measuring and goes quietly vacuous.
//!
//! **A rate or timing ASSERTION is hand-pinned to a measured number.** A value
//! derived from the constant under test agrees with that constant at every value,
//! so a derived expectation passes vacuously and proves nothing: Phase 60 measured
//! 308 of 309 `fabrico-core` library tests GREEN at a WRONG constant. Applying the
//! derive rule to the wrong side of that line is the failure this discipline exists
//! to prevent, so each side says which it is at its own site.

mod common;

use common::{header, tick_hash};
use fabrico_core::belt_slots::{DEFAULT_TICKS_PER_SLOT, SLOTS_PER_TILE};
use fabrico_core::core::Core;
use fabrico_core::event::{Event, EventPayload, SCHEMA_VERSION};
use fabrico_core::fault::{Fault, FaultReason, FAULT_PORT};
use fabrico_core::ids::{Item, NodeId};
use fabrico_core::snapshot;
use fabrico_core::state::Node;
use proptest::prelude::*;

/// Slots backing a `tiles`-tile belt: `SLOTS_PER_TILE * tiles` (the crate's
/// `belt_slots::slot_count` is `pub(crate)`, so this mirror is computed from the
/// public `SLOTS_PER_TILE` constant — the single belt model knob).
fn slot_count(tiles: u32) -> usize {
    (SLOTS_PER_TILE * tiles) as usize
}

/// Ticks between one slot advance on every belt this suite builds, in ticks per
/// slot. `Belt::new` seeds each belt from `DEFAULT_TICKS_PER_SLOT` (SLOT-03) and no
/// test here overrides it, so this IS the interval the belts under test run at.
///
/// **This is the BUDGET multiplier and nothing else.** It is read only by tick
/// budgets, never by an expectation: see the module docblock for why the two sides
/// are kept apart.
fn advance_interval() -> u64 {
    u64::from(DEFAULT_TICKS_PER_SLOT.get())
}

/// Build a `ManualInject` event firing one item into source `target` on port 0.
fn fire(target: NodeId, seq: u64, tick: u64, item: Item) -> Event {
    Event {
        schema_version: SCHEMA_VERSION,
        partition: 0,
        sequence: seq,
        tick,
        payload: EventPayload::ManualInject {
            target,
            port: 0,
            item,
        },
    }
}

/// Count items currently queued on port 0 of `id`'s inbox (cloned — never mutates
/// the live core). All belt / collector deliveries in these topologies land on
/// port 0, so a port-0 count is the full inbox count here.
fn inbox_count(core: &Core, id: NodeId) -> u64 {
    match core.state.inbox_of(id) {
        Some(inbox) => {
            let mut clone = inbox.clone();
            let mut n = 0u64;
            while clone.take(0).is_some() {
                n += 1;
            }
            n
        }
        None => 0,
    }
}

/// Count the items a node holds as `OutputRefused` fault payloads on its `FAULT_PORT`:
/// the THIRD place an item can rest since Phase 71 bounded the mechanical inbox
/// (`admit::MECHANICAL_INBOX_CAP`, PILE-01/PILE-03).
///
/// The source drains its whole `pending` in ONE step, so a burst wider than
/// `MECHANICAL_INBOX_CAP` cannot all be placed into the first belt's staging inbox. The
/// fold's generic outbox drain has nowhere to RETAIN a refused item (its outbox is a
/// `std::mem::take`), so it mints a `FaultReason::OutputRefused` carrying the item's
/// bytes as the payload (71-01 ruling R-4). A conservation sum over belt slots and
/// port-0 inboxes alone therefore under-counts by exactly the number of refusals and
/// reads a correct refusal as a LOSS. Plan 71-03's gate stops the source from draining
/// into a full inbox at all, at which point this term goes to zero on these boards; the
/// term stays because the sum has to be over every place an item can be.
fn refused_on_fault_port(core: &Core, id: NodeId) -> u64 {
    match core.state.inbox_of(id) {
        Some(inbox) => inbox
            .items_on(FAULT_PORT)
            .filter(|item| {
                matches!(Fault::decode(item), Ok(f) if f.reason == FaultReason::OutputRefused)
            })
            .count() as u64,
        None => 0,
    }
}

/// Count occupied slots on a Belt node (its resident items).
/// How many items rest in a Source's `pending` deque - the FOURTH resting place, and
/// the one plan 71-03's PILE-02 gate created.
///
/// Before the gate a source drained its whole `pending` every step, so a conservation
/// sum could ignore it. Under the gate a source whose output belt is full is not
/// stepped and `pending` holds. `admit::SOURCE_PENDING_CAP` is what stops it holding
/// without limit (PILE-04); this is what stops a test reading a held item as a lost one.
fn source_pending(core: &Core, id: NodeId) -> u64 {
    match core.state.node(id) {
        Some(Node::Source(src)) => src.pending.len() as u64,
        _ => 0,
    }
}

fn slot_resident(core: &Core, id: NodeId) -> u64 {
    match core.state.node(id) {
        Some(Node::Belt(b)) => b.slots.iter().filter(|s| s.is_some()).count() as u64,
        other => panic!("expected a Belt, got {other:?}"),
    }
}

/// The deterministic feed rule: fire ONE item into the source at tick `t` iff we
/// are still inside the feed window AND the (cycled) schedule bit is set. Keyed
/// PURELY on the absolute tick `t`, so the same rule replays identically whether a
/// run is continuous or resumed from a mid-flow snapshot.
fn should_fire(t: u64, schedule: &[bool], feed_window: u64) -> bool {
    t < feed_window && schedule[(t as usize) % schedule.len()]
}

/// Drive `core` from its current tick up to `to_tick` (exclusive), firing into
/// source `s` per [`should_fire`], and return the per-tick `blake3(snapshot)`
/// sequence (one hash per advanced tick). Returns `(hashes, fired)` where `fired`
/// counts the items injected during THIS call.
fn drive(
    core: &mut Core,
    s: NodeId,
    to_tick: u64,
    schedule: &[bool],
    feed_window: u64,
) -> (Vec<String>, u64) {
    let mut hashes = Vec::new();
    let mut fired = 0u64;
    while core.tick < to_tick {
        let t = core.tick;
        if should_fire(t, schedule, feed_window) {
            core.advance(&[fire(s, t, t, Item(vec![(t & 0xFF) as u8]))]);
            fired += 1;
        } else {
            core.advance(&[]);
        }
        hashes.push(tick_hash(core));
    }
    (hashes, fired)
}

/// Build `source -> beltA(tiles_a) -> beltB(tiles_b)` with beltB's head DANGLING
/// (the stalled-tail belt->belt backpressure topology). Returns `(core, s, a, b)`.
fn build_backpressure(seed: u64, tiles_a: u32, tiles_b: u32) -> (Core, NodeId, NodeId, NodeId) {
    let mut core = Core::genesis(header(seed));
    let s = core.state.add_source();
    let a = core.state.add_belt(tiles_a);
    let b = core.state.add_belt(tiles_b);
    core.state.link((s, 0), (a, 0));
    core.state.link((a, 0), (b, 0));
    // NB: NO link from (b, 0) — beltB's head is dangling (the permanently full tail
    // that beltA backpressures against). NOT a stalled machine (Pitfall 1 / A4).
    (core, s, a, b)
}

/// Build `source -> beltA(tiles_a) -> beltB(tiles_b) -> collector` where the
/// collector is an unbounded-inbox source (the delivery path). Returns
/// `(core, s, a, b, collector)`.
fn build_chain(
    seed: u64,
    tiles_a: u32,
    tiles_b: u32,
) -> (Core, NodeId, NodeId, NodeId, NodeId) {
    let mut core = Core::genesis(header(seed));
    let s = core.state.add_source();
    let a = core.state.add_belt(tiles_a);
    let b = core.state.add_belt(tiles_b);
    let c = core.state.add_source(); // collector: unbounded inbox, never refuses
    core.state.link((s, 0), (a, 0));
    core.state.link((a, 0), (b, 0));
    core.state.link((b, 0), (c, 0));
    (core, s, a, b, c)
}

proptest! {
    // Honors PROPTEST_CASES (CI sets 1024); `ProptestConfig::default()` reads the env.
    #![proptest_config(ProptestConfig::default())]

    /// CONSERVATION (belt->belt blocked tail): drive `source -> beltA -> beltB`
    /// (beltB dangling = stalled tail) under a random feed schedule and random belt
    /// lengths. Nothing reaches a downstream (delivered == 0), so EVERY admitted item
    /// must remain resident in a belt's slots or inbox — `delivered + resident ==
    /// admitted` (no loss, no creation). When the feed exceeds total belt capacity,
    /// beltA MUST bunch (its head is retained) — the belt->belt backpressure proof.
    #[test]
    fn belt_conserves_through_fold(
        seed in any::<u64>(),
        tiles_a in 1u32..=4,
        tiles_b in 1u32..=4,
        extra in 1u64..=12,
        schedule in proptest::collection::vec(any::<bool>(), 1..16),
    ) {
        let capacity = (slot_count(tiles_a) + slot_count(tiles_b)) as u64;
        // Feed strictly MORE than both belts can hold, so saturation + backpressure
        // are guaranteed once the belts fill.
        let feed_window = capacity + extra;
        let (mut core, s, a, b) = build_backpressure(seed, tiles_a, tiles_b);

        // BUDGET (derived): drive long enough to fire the whole window AND drain to
        // steady state. The drain leg is slot transport, so it stretches with the
        // advance interval; the feed window is a count of injections and does not.
        let total = feed_window + (capacity * 2 + 64) * advance_interval();
        let (_hashes, fired) = drive(&mut core, s, total, &schedule, feed_window);

        // delivered == 0 (dangling beltB head); every fired item is still resident.
        let delivered = 0u64; // nothing leaves a dangling-head belt chain
        let resident = slot_resident(&core, a)
            + slot_resident(&core, b)
            + inbox_count(&core, a)
            + inbox_count(&core, b);
        // The third resting place (Phase 71): whatever the bounded staging inbox refused
        // at the source's outbox drain rides as an `OutputRefused` fault payload. Counting
        // only slots and port-0 inboxes would read a correct refusal as a loss.
        let refused = refused_on_fault_port(&core, s);
        prop_assert_eq!(
            delivered + resident + refused,
            fired,
            "conservation: delivered + resident + refused == admitted"
        );
        // Backpressure engaged: when MORE items were actually fired than both belts
        // can hold, beltB saturated and beltA MUST have RETAINED its head (the
        // belt->belt bunch). The schedule may fire fewer than `feed_window` items (it
        // can be all-false), so this is gated on the REAL fired count, not the window.
        if fired > capacity {
            let a_head_occupied = matches!(
                core.state.node(a),
                Some(Node::Belt(belt)) if belt.slots.first().is_some_and(Option::is_some)
            );
            prop_assert!(
                a_head_occupied,
                "fired > capacity => beltA bunches (belt->belt backpressure: downstream tail full)"
            );
        }
    }

    /// CONSERVATION WITH DELIVERY: drive the full chain `source -> beltA -> beltB ->
    /// collector`. The collector's unbounded inbox always accepts, so items DO get
    /// delivered (delivered > 0 in general). `delivered + resident == admitted` still
    /// holds exactly — the belt->belt junction (beltA -> beltB tail) and the
    /// belt->machine delivery (beltB -> collector) together conserve every item.
    #[test]
    fn belt_chain_conserves_with_delivery(
        seed in any::<u64>(),
        tiles_a in 1u32..=4,
        tiles_b in 1u32..=4,
        feed_window in 1u64..=24,
        schedule in proptest::collection::vec(any::<bool>(), 1..16),
    ) {
        let capacity = (slot_count(tiles_a) + slot_count(tiles_b)) as u64;
        let (mut core, s, a, b, c) = build_chain(seed, tiles_a, tiles_b);

        // BUDGET (derived): the drain leg stretches with the advance interval.
        let total = feed_window + (capacity * 2 + 64) * advance_interval();
        let (_hashes, fired) = drive(&mut core, s, total, &schedule, feed_window);

        let delivered = inbox_count(&core, c);
        let resident = slot_resident(&core, a)
            + slot_resident(&core, b)
            + inbox_count(&core, a)
            + inbox_count(&core, b);
        prop_assert_eq!(
            delivered + resident,
            fired,
            "conservation: delivered + resident == admitted (with downstream delivery)"
        );
    }

    /// DETERMINISM (the PRIMARY assertion): two identical runs of the same topology +
    /// feed produce the byte-identical per-tick `blake3(snapshot)` sequence. The
    /// snapshot hash — not the item ledger — is the determinism oracle.
    #[test]
    fn belt_replay_blake3_is_deterministic(
        seed in any::<u64>(),
        tiles_a in 1u32..=4,
        tiles_b in 1u32..=4,
        feed_window in 1u64..=24,
        schedule in proptest::collection::vec(any::<bool>(), 1..16),
    ) {
        let capacity = (slot_count(tiles_a) + slot_count(tiles_b)) as u64;
        // BUDGET (derived): the drain leg stretches with the advance interval.
        let total = feed_window + (capacity * 2 + 48) * advance_interval();

        let (mut a1, s1, ..) = build_chain(seed, tiles_a, tiles_b);
        let (hashes1, _) = drive(&mut a1, s1, total, &schedule, feed_window);

        let (mut a2, s2, ..) = build_chain(seed, tiles_a, tiles_b);
        let (hashes2, _) = drive(&mut a2, s2, total, &schedule, feed_window);

        prop_assert_eq!(
            hashes1,
            hashes2,
            "identical runs => byte-identical per-tick blake3(snapshot) sequence"
        );
    }

    /// SNAPSHOT-EQUIVALENCE (REPLAY-01): snapshot the chain at a MID-FLOW tick,
    /// restore it, and continue. The restored run's remaining per-tick `blake3`
    /// hashes are byte-identical to the uninterrupted run's tail — no slot item is
    /// stranded or resurrected across the snapshot boundary. The snapshot hash is the
    /// primary assertion.
    #[test]
    fn belt_snapshot_restore_midflow_byte_identical(
        seed in any::<u64>(),
        tiles_a in 1u32..=4,
        tiles_b in 1u32..=4,
        feed_window in 4u64..=24,
        schedule in proptest::collection::vec(any::<bool>(), 1..16),
    ) {
        let capacity = (slot_count(tiles_a) + slot_count(tiles_b)) as u64;
        // BUDGET (derived): the drain leg stretches with the advance interval.
        let total = feed_window + (capacity * 2 + 48) * advance_interval();
        // A mid-flow cut point: partway through the feed window so items are genuinely
        // in transit across the belt->belt junction at the snapshot boundary.
        let cut = (feed_window / 2).max(1).min(total - 1);

        // Uninterrupted reference run: full per-tick hash sequence.
        let (mut reference, s_ref, ..) = build_chain(seed, tiles_a, tiles_b);
        let (hashes_full, _) = drive(&mut reference, s_ref, total, &schedule, feed_window);

        // Interrupted run: drive to `cut`, snapshot, restore, continue to `total`.
        let (mut interrupted, s_int, ..) = build_chain(seed, tiles_a, tiles_b);
        let _ = drive(&mut interrupted, s_int, cut, &schedule, feed_window);
        let blob = snapshot::snapshot(&interrupted);
        let mut restored = snapshot::restore(&blob)
            .expect("mid-flow belt snapshot restores through the hardened trust gate");
        prop_assert_eq!(restored.tick, cut, "restore lands at the snapshot tick");
        // The SAME source NodeId survives the snapshot (slotmap keys are serialized),
        // so the resumed run fires into the same source with the same per-tick rule.
        let (hashes_tail, _) = drive(&mut restored, s_int, total, &schedule, feed_window);

        let expected_tail = &hashes_full[cut as usize..];
        prop_assert_eq!(
            hashes_tail.as_slice(),
            expected_tail,
            "restored run's remaining per-tick blake3 hashes match the uninterrupted run \
             (no slot item stranded or resurrected)"
        );
    }
}

/// Readable anchor (non-proptest): a 2-tile beltA feeding a dangling 1-tile beltB
/// bunches against the full tail and conserves every item, demonstrating belt->belt
/// backpressure through the real Core with an explicit, reviewable scenario.
#[test]
fn belt_to_belt_backpressure_anchor() {
    let (mut core, s, a, b) = build_backpressure(1, 2, 1);
    // 8 + 4 = 12. The comment read `6 + 3 = 9` from the Phase 11 cutover until plan
    // 62-03: it was arithmetic against the RETIRED `SLOTS_PER_TILE = 3` and has been
    // wrong since Phase 60 moved the pitch to 4. Corrected in place rather than
    // deleted, so the supersession stays visible.
    let capacity = (slot_count(2) + slot_count(1)) as u64; // 8 + 4 = 12
    let n = capacity + 5;
    // Fire all items at tick 0 (they queue in beltA's inbox, fed one/tick).
    let fires: Vec<Event> = (0..n)
        .map(|i| fire(s, i + 1, 0, Item(vec![(i & 0xFF) as u8])))
        .collect();
    // THE SOURCE NOW REFUSES PAST `SOURCE_PENDING_CAP` (plan 71-03, PILE-04), so
    // "fired" and "admitted" have parted company and conservation is over what the
    // board ACCEPTED. `admitted` is MEASURED from `pending` growing rather than
    // recomputed from the bound's own predicate - a test that recomputed the predicate
    // would agree with a broken bound as readily as with a correct one. Admitting by
    // hand and then folding an empty tick is precisely what `core.advance(&fires)` does
    // internally (phase order: edits, admit, take_due, fixpoint); the split only makes
    // the acceptance observable between the two halves.
    let mut admitted = 0u64;
    for ev in &fires {
        let before = source_pending(&core, s);
        fabrico_core::manual_inject::admit(&mut core.state, &mut core.sched, ev, core.tick);
        admitted += source_pending(&core, s) - before;
    }
    assert!(
        admitted < n,
        "non-vacuity: this burst is wider than SOURCE_PENDING_CAP, so the source must \
         have refused some of it ({admitted} admitted of {n} fired)"
    );
    core.advance(&[]);
    // BUDGET (derived): saturating 12 slots against a dangling head is pure slot
    // transport, so the tick cost scales one-for-one with the advance interval.
    // Research assumption A4 reasoned this budget fails LOUDLY rather than silently
    // under slowdown but never ran it under one, so that reasoning is treated as
    // UNVERIFIED and the budget is raised anyway: a raise costs nothing at the
    // shipped interval and an unverified loud-failure argument is not evidence.
    for _ in 0..((capacity * 3 + 32) * advance_interval()) {
        core.advance(&[]);
    }

    // beltB saturated (dangling head) and beltA's head retained (bunched).
    assert_eq!(slot_resident(&core, b), slot_count(1) as u64, "beltB saturated");
    let a_head = matches!(
        core.state.node(a),
        Some(Node::Belt(belt)) if belt.slots.first().is_some_and(Option::is_some)
    );
    assert!(a_head, "beltA head retained — belt->belt backpressure bunch");
    // Conservation: delivered(0) + resident + refused == admitted. The `refused` term
    // is the third resting place Phase 71 introduced (see `refused_on_fault_port`) and
    // the source's `pending` is the FOURTH, which plan 71-03 created: under the PILE-02
    // gate a source whose belt is full is not stepped at all, so items rest in the
    // deque instead of being drained into an invisible queue downstream. The sum has to
    // be over every place an item can be, not over the places it used to be.
    let resident = source_pending(&core, s)
        + slot_resident(&core, a)
        + slot_resident(&core, b)
        + inbox_count(&core, a)
        + inbox_count(&core, b);
    let refused = refused_on_fault_port(&core, s);
    assert_eq!(
        resident + refused,
        admitted,
        "delivered(0) + resident + refused == admitted ({admitted}) (no loss)"
    );
}

/// CR-01 REGRESSION (the BELT-05 traverse-time defect): a belt fed EVERY tick must
/// advance AT MOST one slot on any tick: it must NOT double-step. Before the fix an
/// occupied belt (re-woken at `tick+1` via AR-3, so already in the initial active
/// set) that an upstream ALSO routed into the SAME tick re-entered the bounded
/// fixpoint via `wake_now`, calling `advance_slots` a SECOND time → ~2x transport
/// rate. The fix routes into a belt via `schedule_wake(dest, now+1)` (a belt is
/// transport with latency, NOT a 0-latency instant-wire), so it steps at most once
/// per tick, and since SLOT-03 it advances only on its own due ticks.
///
/// # Four readings, and only ONE of them is a value gate
/// - **(A) No acceleration.** Under continuous feed the FIRST item arrives at the
///   same tick a single lone item would. Both legs slow together with the interval,
///   so this is SELF-AGREEING: it holds at every value and gates acceleration only.
/// - **(B) At most one delivery per tick.** The single-lane boundary property. It
///   is still real and still worth asserting, but it is NOT the rate: a SLOWER belt
///   satisfies `<= 1` trivially, which is exactly why the old `== 1` form survived
///   this whole phase vacuously (Pitfall 2) and had to be rewritten (D-04).
/// - **(C) The window rate, HAND-PINNED.** The count of deliveries in a fixed
///   window of continuous feed. This is the reading that discriminates, and it is
///   the only one here whose number was typed rather than computed.
/// - **(D) The rate SHAPE, derived.** Deliveries across the steady-state leg equal
///   the leg divided by the interval. It proves the pacing relationship holds at
///   any interval, and being derived from the interval it is SELF-AGREEING and NOT
///   admissible as this phase's value gate.
#[test]
fn belt_continuously_fed_advances_exactly_one_slot_per_tick() {
    const SEED: u64 = 0xFEED_0001;
    const TILES: u32 = 3;
    /// The HAND-PINNED window for reading (C), in ticks. Deliberately NOT scaled by
    /// the advance interval: a window that stretched with the interval would count
    /// the same number of deliveries at every interval, which is the tautology this
    /// rewrite exists to remove.
    const RATE_WINDOW_TICKS: u64 = 32;
    /// Deliveries reading (C) expects inside `RATE_WINDOW_TICKS` ticks of continuous
    /// feed, at the interval shipped TODAY. HAND-TYPED from a measured run, never
    /// computed from `DEFAULT_TICKS_PER_SLOT`: a value derived from the constant
    /// under test agrees with that constant at every value (D-22).
    ///
    /// # RE-PINNED BY PLAN 62-09 ON 2026-08-14: 20 becomes 5
    /// The shipped interval moved from the pre-change identity of 1 to **2**, chosen
    /// by hand at the 2026-08-14 pace test (the only admissible source). This number moves with it, exactly as the paragraph below always said
    /// it would.
    ///
    /// **5 is a READING, not arithmetic.** The old assertion was watched FAILING at
    /// the new interval before this literal was touched, and it reported
    /// `left: 5  right: 20` at `belt_per_tile.rs:518`. That 5 was then typed here.
    /// Two independent measurements agree with it: plan 62-03's mutation drill
    /// (`62-CORPUS-REVIEW.md`, "The rewrite reddens on the HAND-PINNED reading")
    /// measured the same 5 at interval 2 on a different tree, and its sibling's 16
    /// reproduces `62-RESEARCH.md` section 5's independently modelled steady-state
    /// table.
    ///
    /// Why 5 and not 16: the window opens with a ramp leg that delivers nothing,
    /// because the first item cannot arrive before it has traversed the belt, and at
    /// interval 2 that ramp is twice as long. After the first arrival a belt at 2
    /// delivers every SECOND tick rather than every tick, so the window's remaining
    /// span yields half as many again. The ramp is why an approximately
    /// `window / interval` expectation needs a tolerance and this exact one does not.
    ///
    /// **The WINDOW deliberately stayed at 32 ticks.** `62-CORPUS-REVIEW.md`
    /// FINDING 3-B warned that a long enough interval pushes the first arrival past
    /// the window and fires the underflow guard below, and that this plan would then
    /// have to re-pin the window alongside the count. **At 2 the guard did not fire**
    /// (both failures were at the count assertions, neither at
    /// `arrival <= RATE_WINDOW_TICKS`), so the window still contains its first
    /// arrival and stretching it would have been an unforced weakening.
    ///
    /// **This number MOVES when the shipped interval moves, and that is the point.**
    /// It is red at every other interval, so it is the assertion the mutation drill
    /// uses and it is one of the only three literals in `fabrico-core` outside the
    /// golden corpus that can tell the shipped interval from a wrong one. Do NOT
    /// compute it from `DEFAULT_TICKS_PER_SLOT`: a value derived from the constant
    /// under test agrees with that constant at every value (D-22).
    const RATE_WINDOW_DELIVERIES: u64 = 5;
    let m = slot_count(TILES) as u64;

    // Baseline: a SINGLE lone item through `source -> belt -> collector`. Record the
    // tick it arrives at the collector.
    let single_arrival = {
        let mut core = Core::genesis(header(SEED));
        let s = core.state.add_source();
        let b = core.state.add_belt(TILES);
        let c = core.state.add_source();
        core.state.link((s, 0), (b, 0));
        core.state.link((b, 0), (c, 0));
        core.advance(&[fire(s, 0, 0, Item(vec![0]))]); // fire one item at tick 0
        let mut arrival = None;
        // BUDGET (derived), and the TIGHTEST one in the tree before plan 62-03: at
        // the shipped interval the item arrives on tick 13 of a 20-tick window, but
        // the arrival tick is ~`(m - 1) * interval`, so the unraised 20 is already
        // short at an interval of 2. Its failure is not a quiet one either: the
        // result feeds the `.expect` below, so an under-run is a HARD PANIC and the
        // whole test dies before any assertion is reached.
        for _ in 0..((m + 8) * advance_interval()) {
            if inbox_count(&core, c) > 0 {
                arrival = Some(core.tick);
                break;
            }
            core.advance(&[]);
        }
        arrival.expect("the lone item arrives at the collector")
    };

    // Continuous feed: fire ONE item into the source EVERY tick.
    let mut core = Core::genesis(header(SEED));
    let s = core.state.add_source();
    let b = core.state.add_belt(TILES);
    let c = core.state.add_source();
    core.state.link((s, 0), (b, 0));
    core.state.link((b, 0), (c, 0));

    let mut first_arrival: Option<u64> = None;
    let mut prev_delivered = 0u64;
    let mut max_per_tick = 0u64;
    let mut delivered_in_window = 0u64;
    // BUDGET (derived): the continuous-feed run must outlast the first arrival, and
    // that arrival is ~`(m - 1) * interval` ticks in. Research section 5 enumerated
    // seven budgets and missed this one; unraised it survives an interval of 2 and
    // then leaves `first_arrival` at `None` from 3 onward, which fails the
    // no-acceleration assertion for a reason that has nothing to do with
    // acceleration. Raised in the same commit as its sibling above.
    for t in 0..((m + 20) * advance_interval()) {
        core.advance(&[fire(s, t, t, Item(vec![(t & 0xFF) as u8]))]);
        let delivered = inbox_count(&core, c);
        max_per_tick = max_per_tick.max(delivered - prev_delivered);
        if first_arrival.is_none() && delivered > 0 {
            first_arrival = Some(core.tick);
        }
        if core.tick == RATE_WINDOW_TICKS {
            delivered_in_window = delivered;
        }
        prev_delivered = delivered;
    }

    // (A) No acceleration: continuous feed delivers the first item at the SAME tick a
    // lone item would. A double-stepping belt would deliver it roughly twice as fast.
    // SELF-AGREEING: both legs are the same belt at the same interval, so this holds
    // at every value of DEFAULT_TICKS_PER_SLOT and is NOT admissible as this phase's
    // value gate. It gates acceleration, which is what it was written for.
    assert_eq!(
        first_arrival,
        Some(single_arrival),
        "continuous feed must not accelerate the belt: traverse-time is invariant \
         under the feed schedule (BELT-05)"
    );
    // (B) Single-lane, single-advance: AT MOST one item is delivered per tick. A belt
    // that double-stepped could advance + deliver two in one tick. Kept as its own
    // assertion because that boundary property is still real, and demoted from `==`
    // to `<=` because it is no longer the rate: a belt at any interval satisfies an
    // upper bound of one trivially, so `== 1` would survive every slowdown as a
    // tautology (Pitfall 2).
    assert!(
        max_per_tick <= 1,
        "a continuously-fed belt delivers at most one item per tick (no double-step), \
         saw {max_per_tick}"
    );
    // (C) THE RATE, hand-pinned. Deliveries counted over a fixed window of continuous
    // feed. This is the discriminating reading and the only assertion in this test
    // that reddens when the shipped interval moves.
    assert_eq!(
        delivered_in_window, RATE_WINDOW_DELIVERIES,
        "steady-state throughput: {RATE_WINDOW_DELIVERIES} deliveries in the first \
         {RATE_WINDOW_TICKS} ticks of continuous feed at the shipped advance interval"
    );
    // (D) The rate SHAPE, derived. Across the steady-state leg (first arrival to the
    // close of the window) a belt at `interval` ticks per slot delivers exactly once
    // per interval, so the count is the leg divided by the interval, plus the arrival
    // that opened it. SELF-AGREEING by construction: it holds at every interval, so
    // it proves the pacing RELATIONSHIP and is NOT admissible as the value gate.
    // (C) is what pins the value; this is what pins the shape.
    let arrival = first_arrival.expect("continuous feed delivers within the budget");
    // Guard the subtraction below. A window shorter than the ramp leg measures nothing,
    // and without this the underflow panics as an arithmetic overflow rather than
    // saying what went wrong. The window is hand-pinned and does NOT stretch with the
    // interval, so a long enough interval WILL push the first arrival past it; plan
    // 62-09 re-pins the window alongside the count when it ships the value.
    assert!(
        arrival <= RATE_WINDOW_TICKS,
        "the rate window ({RATE_WINDOW_TICKS} ticks) must contain the first arrival \
         (tick {arrival}); re-pin the window with the value"
    );
    let steady_leg = RATE_WINDOW_TICKS - arrival;
    assert_eq!(
        delivered_in_window,
        steady_leg / advance_interval() + 1,
        "one delivery per advance interval across the steady-state leg"
    );
}

/// CR-01 REGRESSION across a belt->belt boundary: a steadily-fed two-belt chain must
/// not double-step at the junction. The boundary delivery schedules the downstream
/// belt for the NEXT tick (`schedule_wake(dest, now+1)`) rather than `wake_now`, so
/// it never re-enters the current fixpoint. Steady-state throughput at the far
/// collector is one delivery per advance interval.
///
/// Readings, on the same split as its sibling above: `max_per_tick <= 1` is the
/// boundary property and NOT the rate; the hand-pinned window count is the rate and
/// is the only assertion here that reddens when the shipped interval moves; the
/// quotient form pins the SHAPE and, being derived from the interval, is
/// self-agreeing and inadmissible as the value gate.
#[test]
fn belt_chain_steady_flow_advances_one_slot_per_tick() {
    const SEED: u64 = 0xFEED_0002;
    /// The HAND-PINNED window for the rate reading, in ticks. Deliberately NOT
    /// scaled by the advance interval, for the reason its sibling states.
    const RATE_WINDOW_TICKS: u64 = 60;
    /// Deliveries expected inside `RATE_WINDOW_TICKS` ticks of continuous feed
    /// across the 2+2 junction, at the interval shipped TODAY. HAND-TYPED from a
    /// measured run, never computed from `DEFAULT_TICKS_PER_SLOT` (D-22).
    ///
    /// # RE-PINNED BY PLAN 62-09 ON 2026-08-14: 45 becomes 16
    /// The shipped interval moved from the pre-change identity of 1 to **2**
    /// (chosen at the 2026-08-14 pace test). This number moves with it, exactly as the paragraph
    /// below always said it would, and it is the strongest of the three non-hash
    /// literals this plan re-pinned.
    ///
    /// **16 is a READING, corroborated twice over.** The old assertion was watched
    /// FAILING at the new interval before this literal was touched, reporting
    /// `left: 16  right: 45` at `belt_per_tile.rs:617`. Plan 62-03's mutation drill
    /// measured 16 at interval 2 on a different tree, AND `62-RESEARCH.md` section 5
    /// modelled the same steady-state table from first principles and independently
    /// produced 45 at 1 and 16 at 2. **Three methods, one number**, which is why the
    /// paragraph below can state the whole curve rather than the one shipped point.
    ///
    /// Why 16 and not 30: the first item crosses BOTH belts before anything is
    /// delivered, and at interval 2 that ramp is twice as long; after it, deliveries
    /// come one per interval rather than one per tick.
    ///
    /// **The WINDOW deliberately stayed at 60 ticks**, for the reason its sibling
    /// states: the FINDING 3-B underflow guard did not fire at 2, so the window still
    /// contains its first arrival and stretching it would have been an unforced
    /// weakening.
    ///
    /// **This number MOVES when the shipped interval moves, and that is the point.**
    /// The measured counts over this same window are 45 at an interval of 1, 16 at 2,
    /// 6 at 3, 1 at 4 and ZERO at 5, so the assertion is red by a wide margin at every
    /// mutation rather than by one item. Do NOT compute it from
    /// `DEFAULT_TICKS_PER_SLOT` (D-22).
    const RATE_WINDOW_DELIVERIES: u64 = 16;
    let (mut core, s, _a, _b, c) = build_chain(SEED, 2, 2);
    let mut prev = 0u64;
    let mut max_per_tick = 0u64;
    let mut first_arrival: Option<u64> = None;
    let mut delivered_in_window = 0u64;
    // BUDGET (derived): the run must be long enough for the chain to deliver at all,
    // and the first arrival across the 2+2 junction is ~`14 * interval` ticks in.
    // Unraised, 60 ticks yields ONE delivery at an interval of 4 and ZERO at 5, so
    // `assert!(prev > 0)` below stops being a statement about the chain and becomes
    // a statement about the window.
    for t in 0..(RATE_WINDOW_TICKS * advance_interval()) {
        core.advance(&[fire(s, t, t, Item(vec![(t & 0xFF) as u8]))]);
        let delivered = inbox_count(&core, c);
        max_per_tick = max_per_tick.max(delivered - prev);
        if first_arrival.is_none() && delivered > 0 {
            first_arrival = Some(core.tick);
        }
        if core.tick == RATE_WINDOW_TICKS {
            delivered_in_window = delivered;
        }
        prev = delivered;
    }
    // THE BUDGET GUARD, read FIRST. Whether the run was long enough for the chain to
    // deliver at all is a question about the WINDOW, and it has to be answered before
    // any reading taken through that window means anything. Asserted here rather than
    // at the end of the test so the mutation drill exercises it at every interval:
    // trailing it behind the rate assertions would leave it unreached, and therefore
    // unproved, on exactly the runs the drill exists to take.
    assert!(prev > 0, "the chain actually delivered items downstream");
    // The boundary property, NOT the rate. Demoted from `==` to `<=` for the reason
    // its sibling states: an upper bound of one is satisfied trivially by a belt at
    // any interval, so `== 1` survives every slowdown vacuously (Pitfall 2).
    assert!(
        max_per_tick <= 1,
        "belt->belt chain delivers at most one item per tick (no double-step across \
         the boundary), saw {max_per_tick}"
    );
    // THE RATE, hand-pinned. The discriminating reading, and the only assertion here
    // that reddens when the shipped interval moves.
    assert_eq!(
        delivered_in_window, RATE_WINDOW_DELIVERIES,
        "steady-state throughput across the belt->belt junction: \
         {RATE_WINDOW_DELIVERIES} deliveries in the first {RATE_WINDOW_TICKS} ticks \
         of continuous feed at the shipped advance interval"
    );
    // The rate SHAPE, derived from the interval and therefore SELF-AGREEING: it holds
    // at every value and is NOT admissible as this phase's value gate. It proves the
    // pacing relationship survives the junction, which the hand-pin alone does not.
    let arrival = first_arrival.expect("the chain actually delivered items downstream");
    // Guard the subtraction, for the reason its sibling states: a window shorter than
    // the ramp leg measures nothing, and an unguarded underflow panics as an
    // arithmetic overflow instead of saying so.
    assert!(
        arrival <= RATE_WINDOW_TICKS,
        "the rate window ({RATE_WINDOW_TICKS} ticks) must contain the first arrival \
         (tick {arrival}); re-pin the window with the value"
    );
    let steady_leg = RATE_WINDOW_TICKS - arrival;
    assert_eq!(
        delivered_in_window,
        steady_leg / advance_interval() + 1,
        "one delivery per advance interval across the steady-state leg"
    );
}
