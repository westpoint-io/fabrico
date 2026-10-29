//! Active-set scheduler with a tick-indexed wake wheel (CORE-07).
//!
//! The scheduler is the structural guarantee behind "idle ticks are near-free"
//! (SC#3): a machine is stepped only if it was woken *this* tick (it received
//! input or fired) or it has a scheduled wake landing on this tick (a belt
//! delivery, a future timer). The cost of a tick is `O(active + waking)` — it
//! never scales with the total number of machines on the grid, because the only
//! iteration surfaces are the active set and the single wheel bucket for `tick`.
//! **There is deliberately no path that scans all nodes** (RESEARCH Pattern 2).
//!
//! # Data structures (deterministic + serializable, CORE-06/09)
//! - `active_now: BTreeSet<NodeId>` — machines woken this tick. A `BTreeSet`
//!   yields its members in ascending [`NodeId`] order for free, so draining it
//!   is the stable id-order the fold needs; membership de-duplicates naturally
//!   (waking the same node twice in a tick steps it once).
//! - `wake_wheel: BTreeMap<u64, Vec<NodeId>>` — future scheduled wakes keyed by
//!   tick. Chosen over a binary heap precisely because a `BTreeMap` is trivially
//!   `serde`-serializable for snapshots and an idle-tick lookup
//!   (`wake_wheel.remove(&T)` returning `None`) costs O(log n) and steps nothing.
//!
//! # The one failure mode (RESEARCH Pattern 2 warning)
//! Every belt push / `schedule_wake` MUST enqueue the receiver, or a machine is
//! stranded ("stuck machine"). The belt/manual-inject wiring that always wakes
//! its target lands in plan 05; this module only provides the enqueue surface.

use crate::ids::NodeId;
use std::collections::{BTreeMap, BTreeSet};

/// The active-set scheduler + tick-indexed wake wheel (CORE-07).
///
/// `Default` is an empty scheduler (nothing active, no scheduled wakes). It
/// derives `serde` because it is part of the tick-boundary snapshot
/// (RESEARCH Pitfall 6 — the wake wheel and active set are state).
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Scheduler {
    /// Machines woken for the current tick. `BTreeSet` keeps them in ascending
    /// `NodeId` order (the stable fold order) and de-duplicates.
    active_now: BTreeSet<NodeId>,
    /// Future scheduled wakes, keyed by the tick they become due.
    wake_wheel: BTreeMap<u64, Vec<NodeId>>,
    /// Machines asleep behind a blocked output (phase 87, JAM-04, D-06, WINDOWS 177):
    /// a member is not re-scheduled every tick while its outputs are blocked, and the
    /// step that frees a slot it feeds wakes it. The gate in `tick.rs` `step_node` fills
    /// it ([`Self::mark_blocked`]); a consumer whose inbox shrank empties it of the
    /// feeders it found through the state's reverse link index ([`Self::unblock`]); a
    /// tick carrying edits empties it whole ([`Self::wake_all_blocked_now`]). Every member
    /// is a live node: [`Self::referenced_ids`] includes the set (so the trust gate
    /// refuses a dead one as `DanglingSchedule`) and [`Self::remove`] drops a deleted
    /// node from it. The trust gate also refuses a non-belt member that is not gated
    /// (`StateInvariant::BlockedNotGated`), so a forged file cannot strand a machine that
    /// could move.
    ///
    /// Since plan 87-07 a SETTLED belt sleeps here too (head held, items packed from the
    /// head, nothing admissible at the tail): the fold withdraws its own next-tick wake
    /// ([`Self::cancel_wake`]) and marks it. A delivery into it, the consumer that frees its
    /// head's destination, a downstream belt whose tail slot comes free, or an edit wakes
    /// it; the trust gate refuses a belt member that is not settled
    /// (`StateInvariant::BlockedBeltNotSettled`).
    ///
    /// # Appended LAST (SNAPSHOT 13 to 14)
    /// After `wake_wheel`, so both earlier fields keep their postcard positions.
    blocked: BTreeSet<NodeId>,
}

impl Scheduler {
    /// A fresh, empty scheduler.
    pub fn new() -> Self {
        Self::default()
    }

    /// Wake `id` for the current tick (input arrived / instant-wire delivery).
    /// Idempotent: waking the same node twice in a tick still steps it once.
    pub fn wake_now(&mut self, id: NodeId) {
        self.active_now.insert(id);
    }

    /// Schedule `id` to wake at tick `at` (a belt delivery, a future timer).
    /// Multiple nodes can be scheduled for the same tick; insertion order
    /// within a bucket is preserved but the drain re-sorts by `NodeId`, so the
    /// observable step order is deterministic regardless of enqueue order.
    pub fn schedule_wake(&mut self, id: NodeId, at: u64) {
        self.wake_wheel.entry(at).or_default().push(id);
    }

    /// Promote every wake scheduled for `tick` into the active set.
    ///
    /// On an **idle tick** (no bucket for `tick`) this is a single O(log n)
    /// `BTreeMap` lookup that misses and does nothing — the active-set guarantee
    /// behind SC#3. Returns the number of ids promoted (0 on an idle tick).
    pub fn take_due(&mut self, tick: u64) -> usize {
        match self.wake_wheel.remove(&tick) {
            Some(ids) => {
                let n = ids.len();
                for id in ids {
                    self.active_now.insert(id);
                }
                n
            }
            None => 0,
        }
    }

    /// Withdraw `id`'s wake at tick `at` (phase 87, JAM-04, D-06): remove every entry for
    /// `id` from that one bucket and drop the bucket if it empties, the bucket discipline of
    /// [`Self::remove`]. Idempotent: a no-op when `id` is not scheduled at `at`.
    ///
    /// The fold calls it for a SETTLED belt after its head-delivery block (`tick.rs`
    /// `belt_settled`): `Belt::step` has just re-woken the belt at `now + 1` because it holds
    /// items, but a belt whose head cannot leave, whose items are packed from the head and
    /// whose tail can admit nothing would only step to no effect, so the fold takes that
    /// wake back and puts the belt in the sleep set ([`Self::mark_blocked`]). Withdrawing
    /// every entry at `at` is safe there: whatever scheduled the belt for `now + 1` earlier
    /// in the tick (a delivery into its staging inbox, before its own step) has already been
    /// seen by that step, and anything that changes the belt AFTER it wakes it again.
    pub fn cancel_wake(&mut self, id: NodeId, at: u64) {
        if let Some(bucket) = self.wake_wheel.get_mut(&at) {
            bucket.retain(|&scheduled| scheduled != id);
            if bucket.is_empty() {
                self.wake_wheel.remove(&at);
            }
        }
    }

    /// Put `id` to sleep behind its blocked output (phase 87, JAM-04, D-06). The gate in
    /// `tick.rs` `step_node` calls it INSTEAD of re-scheduling the node at `now + 1`, so a
    /// machine that cannot move costs nothing per tick until something wakes it: the
    /// consumer that frees a slot it feeds ([`Self::unblock`] then a `schedule_wake` at
    /// `now + 1`), a delivery into its own inbox ([`Self::wake_now`]), or a tick that
    /// carries edits ([`Self::wake_all_blocked_now`]). Idempotent.
    pub fn mark_blocked(&mut self, id: NodeId) {
        self.blocked.insert(id);
    }

    /// Take `id` out of the sleep set, returning whether it was asleep (phase 87, JAM-04).
    ///
    /// `step_node` calls it first for every node it steps, so a node that steps leaves the
    /// set and re-enters only if it is still gated. The consumer wake calls it for each
    /// feeder of a node whose inbox shrank and schedules ONLY the feeders it reports
    /// asleep: a research prototype that woke every feeder added wheel entries on boards
    /// with no jam at all and moved golden 0001 for nothing. It does not schedule anything
    /// itself; the caller decides the tick.
    pub fn unblock(&mut self, id: NodeId) -> bool {
        self.blocked.remove(&id)
    }

    /// True when `id` is asleep behind a blocked output. Read-only, no authority.
    pub fn is_blocked(&self, id: NodeId) -> bool {
        self.blocked.contains(&id)
    }

    /// Every sleeper, in ascending [`NodeId`] order. Read-only, no authority: the trust gate
    /// walks it to refuse a sleeper that is not gated, and tests read it.
    pub fn blocked_ids(&self) -> impl Iterator<Item = NodeId> + '_ {
        self.blocked.iter().copied()
    }

    /// Wake every sleeper for the CURRENT tick and empty the set (phase 87, JAM-04, D-06).
    ///
    /// `tick.rs` `tick()` calls it after the edit loop on a tick that carries edits. A
    /// Disconnect, the delete of a destination, a port edit or a rotate can each lift a
    /// block without any consumer stepping, and tracking which link went away would be a
    /// second, edit-shaped wake path to keep right; waking the whole set is one rule and
    /// costs a step per sleeper on the rare tick a user edits. A woken node that is still
    /// gated goes straight back to sleep. `wake_now` is safe here, unlike in the consumer
    /// wake, because the fixpoint has not started: each sleeper steps once this tick.
    pub fn wake_all_blocked_now(&mut self) {
        let sleepers = std::mem::take(&mut self.blocked);
        self.active_now.extend(sleepers);
    }

    /// Drain the active set as an ascending, de-duplicated `Vec<NodeId>`,
    /// clearing it for the next tick. `BTreeSet` already iterates in ascending
    /// order, so this is the canonical stable fold order (CORE-06).
    pub fn drain_active_sorted(&mut self) -> Vec<NodeId> {
        std::mem::take(&mut self.active_now).into_iter().collect()
    }

    /// Forget every scheduled wake for `id`: remove it from the active set and from
    /// every `wake_wheel` bucket (dropping a bucket that becomes empty). Idempotent
    /// — a no-op for an id that was never scheduled.
    ///
    /// Used by the [`EditOp::Delete`](crate::edit::EditOp::Delete)
    /// fold: a deleted node MUST NOT remain referenced by the scheduler, or
    /// `take_due`/`drain_active_sorted` would surface a dead id and `step_node` would
    /// panic (`node_mut(id).expect(..)`). Keeping this here preserves the invariant
    /// "every active/scheduled id is a live node" the snapshot trust gate also checks
    /// (`referenced_ids`). **Additive + byte-stable**: a method only, no field
    /// change, so the snapshot shape is unaffected.
    pub fn remove(&mut self, id: NodeId) {
        self.active_now.remove(&id);
        self.blocked.remove(&id);
        self.wake_wheel.retain(|_tick, bucket| {
            bucket.retain(|&scheduled| scheduled != id);
            !bucket.is_empty()
        });
    }

    /// True when `tick` would step zero machines: nothing already active and no
    /// wheel bucket due at `tick`.
    pub fn is_idle(&self, tick: u64) -> bool {
        self.active_now.is_empty() && !self.wake_wheel.contains_key(&tick)
    }

    /// Number of distinct ticks that still have scheduled wakes (diagnostics).
    pub fn pending_wakes(&self) -> usize {
        self.wake_wheel.len()
    }

    /// Non-mutating SC#3 oracle (consumed by plan 06): how many machines *would*
    /// step at `tick` — the already-active set plus the wheel bucket due at
    /// `tick`. This is 0 on an idle tick and is independent of the total machine
    /// count, proving there is no full-grid scan in the hot path (CORE-07).
    pub fn active_count_at(&self, tick: u64) -> usize {
        self.active_now.len() + self.wake_wheel.get(&tick).map_or(0, Vec::len)
    }

    /// True iff `id` is scheduled to wake at exactly `at` — a single
    /// `wake_wheel` bucket lookup (mirrors [`active_count_at`]'s
    /// `wake_wheel.get(&at)` style).
    ///
    /// Additive, read-only, **no authority**: it does not expose the private
    /// fields and changes nothing. Consumed by the snapshot trust gate
    /// (`crate::snapshot::validate_invariants`) to enforce AR-3 — every belt
    /// `in_flight` arrival tick MUST have a matching wheel entry, or the belt's
    /// own re-delivery wake (`belt.rs::step` schedules `arrival = now + latency`)
    /// never fires and the item is silently stranded.
    pub fn is_scheduled_at(&self, id: NodeId, at: u64) -> bool {
        self.wake_wheel.get(&at).is_some_and(|b| b.contains(&id))
    }

    /// True iff `id` will step at tick `at` with no outside event: it sits in the wheel
    /// bucket for exactly `at` ([`Self::is_scheduled_at`]) or in the active set. Read-only,
    /// **no authority**.
    ///
    /// Consumed by the snapshot trust gate's `MachineWakeMissing` arm (phase 87 security
    /// audit, threat T-87-28), which asks it of every machine holding work. At a clean tick
    /// boundary the active set is empty, because the fixpoint drained it; it can hold a
    /// node only when the fixpoint's iteration cap cut a zero-latency cycle short, and such
    /// a node steps first on the next tick, so it counts as awake.
    pub fn is_awake_at(&self, id: NodeId, at: u64) -> bool {
        self.active_now.contains(&id) || self.is_scheduled_at(id, at)
    }

    /// Every `NodeId` the scheduler references — the union of `active_now` with
    /// every id across all `wake_wheel` buckets — as a deduplicated, ascending
    /// `BTreeSet`.
    ///
    /// Additive, read-only, **no authority** (mirrors `active_count_at`): it does
    /// not expose the private fields and changes nothing. Consumed by the snapshot
    /// trust gate (`crate::snapshot::validate_invariants`) to reject a
    /// scheduler-referenced id that is not a live node — the `step_node` panic
    /// surface (RESEARCH A1).
    ///
    /// Since SNAPSHOT 14 (phase 87) the union also takes every member of `blocked`, so
    /// a sleeper that names a dead node is refused at restore the same way.
    pub fn referenced_ids(&self) -> BTreeSet<NodeId> {
        let mut ids = self.active_now.clone();
        for bucket in self.wake_wheel.values() {
            ids.extend(bucket.iter().copied());
        }
        ids.extend(self.blocked.iter().copied());
        ids
    }

    /// **Test-support only — never compiled into a normal build.** Strip `id`
    /// from the `wake_wheel` bucket at `at` while leaving every other structure
    /// (including the belt's `in_flight` queue) untouched — forging the AR-3
    /// `BeltWakeMissing` invalid state (a belt arrival with no matching wheel
    /// entry). No public `schedule_wake`/`take_due`/`remove` path can produce
    /// this (a belt always schedules its own arrival wake), so this scaffolding
    /// is the only way a test can construct the corrupt-but-decodable Core the
    /// snapshot trust gate must reject. Idempotent (a no-op if absent); drops a
    /// bucket that becomes empty to mirror `remove`'s bucket discipline. Gated
    /// behind `cfg(test)` (in-crate unit tests) OR the `test-support` feature
    /// (cross-crate integration tests) — mirrors `GridState::test_remove_inbox`.
    #[cfg(any(test, feature = "test-support"))]
    pub fn test_remove_wake(&mut self, id: NodeId, at: u64) {
        if let Some(bucket) = self.wake_wheel.get_mut(&at) {
            bucket.retain(|&scheduled| scheduled != id);
            if bucket.is_empty() {
                self.wake_wheel.remove(&at);
            }
        }
    }

    /// **Test-support only, never compiled into a normal build.** Put `id` in the
    /// `blocked` set directly, so a test can forge a snapshot whose sleeper is not a
    /// live node (the `DanglingSchedule` arm through [`Self::referenced_ids`]) or is not
    /// gated (`BlockedNotGated`). The product path is [`Self::mark_blocked`], which only
    /// the gate calls. Gated like [`Self::test_remove_wake`].
    #[cfg(any(test, feature = "test-support"))]
    pub fn test_insert_blocked(&mut self, id: NodeId) {
        self.blocked.insert(id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use slotmap::SlotMap;

    /// Mint `n` real generational `NodeId`s via a slotmap allocator.
    fn mint(n: usize) -> Vec<NodeId> {
        let mut alloc: SlotMap<NodeId, ()> = SlotMap::with_key();
        (0..n).map(|_| alloc.insert(())).collect()
    }

    #[test]
    fn scheduler_idle_tick_yields_zero_active() {
        // A fresh scheduler at tick T with nothing scheduled steps nothing.
        let mut s = Scheduler::new();
        let tick = 0u64;
        assert!(s.is_idle(tick));
        assert_eq!(s.active_count_at(tick), 0, "idle oracle must read zero");
        assert_eq!(s.take_due(tick), 0, "idle wheel lookup activates nothing");
        assert!(
            s.drain_active_sorted().is_empty(),
            "idle tick drains an empty active set"
        );
    }

    #[test]
    fn scheduler_scheduled_wake_activates_at_its_tick() {
        let ids = mint(1);
        let n = ids[0];
        let mut s = Scheduler::new();
        s.schedule_wake(n, 5);

        // Before the wake tick: not due, oracle sees the future wake only at t=5.
        assert_eq!(s.take_due(0), 0);
        assert!(s.drain_active_sorted().is_empty());
        assert_eq!(s.active_count_at(5), 1, "oracle counts the future wake at t=5");

        // At the wake tick: the node becomes active.
        assert_eq!(s.take_due(5), 1);
        assert_eq!(s.drain_active_sorted(), vec![n]);
        // The bucket was consumed.
        assert_eq!(s.pending_wakes(), 0);
    }

    #[test]
    fn scheduler_drain_is_ascending_and_deduplicated() {
        // Mint three ids; wake them in mixed order, some twice.
        let ids = mint(3);
        let (a, b, c) = (ids[0], ids[1], ids[2]);
        let mut s = Scheduler::new();
        // Mixed enqueue order: c, a, b, and a again (duplicate).
        s.wake_now(c);
        s.wake_now(a);
        s.wake_now(b);
        s.wake_now(a);

        let drained = s.drain_active_sorted();
        // Expect ascending NodeId order with no duplicates.
        let mut expected = vec![a, b, c];
        expected.sort();
        assert_eq!(drained, expected, "active set drains ascending, de-duplicated");
        // Draining cleared the set.
        assert!(s.drain_active_sorted().is_empty());
    }

    #[test]
    fn scheduler_serde_round_trips() {
        let ids = mint(2);
        let mut s = Scheduler::new();
        s.wake_now(ids[0]);
        s.schedule_wake(ids[1], 9);

        let bytes = postcard::to_allocvec(&s).expect("serialize scheduler");
        let restored: Scheduler = postcard::from_bytes(&bytes).expect("deserialize scheduler");
        assert_eq!(s, restored, "scheduler round-trips for snapshots");

        // Re-encode is byte-identical (deterministic-container discipline).
        let bytes2 = postcard::to_allocvec(&restored).expect("re-serialize scheduler");
        assert_eq!(bytes, bytes2);
    }

    #[test]
    fn scheduler_active_count_is_independent_of_total_machines() {
        // SC#3 essence: schedule ONE wake at t=100 among a large minted id space;
        // the per-tick oracle at an idle tick reads zero regardless of how many
        // ids exist — no full-grid scan.
        let ids = mint(10_000);
        let mut s = Scheduler::new();
        s.schedule_wake(ids[4242], 100);

        // Idle tick 0: zero would-step, despite 10k minted ids.
        assert_eq!(s.active_count_at(0), 0);
        // Only the single scheduled node is due at t=100.
        assert_eq!(s.active_count_at(100), 1);
    }

    #[test]
    fn scheduler_referenced_ids_unions_active_and_wheel_deduped_ascending() {
        // referenced_ids() returns the deduped, ascending union of active_now and
        // every wake_wheel bucket — the id set the snapshot trust gate checks for
        // liveness. wake_now(a) + schedule_wake(a, 9) + schedule_wake(b, 4) => {a, b}.
        let ids = mint(2);
        let (a, b) = (ids[0], ids[1]);
        let mut s = Scheduler::new();
        s.wake_now(a);
        s.schedule_wake(a, 9); // a appears in BOTH active_now and a future bucket
        s.schedule_wake(b, 4);

        let referenced: Vec<NodeId> = s.referenced_ids().into_iter().collect();
        // Deduped (a once despite two references) and ascending (a < b).
        assert_eq!(referenced, vec![a, b]);

        // Read-only: the scheduler still steps a and b as before.
        assert_eq!(s.active_count_at(4), 2, "active a + bucket b due at t=4");
    }

    #[test]
    fn scheduler_is_scheduled_at_reports_exact_bucket_membership() {
        // is_scheduled_at(id, at) is a precise (id, tick) wheel lookup: true only
        // when id sits in the bucket for exactly `at` — the structural fact AR-3
        // enforces (a belt arrival must have its matching wake entry).
        let ids = mint(2);
        let (a, b) = (ids[0], ids[1]);
        let mut s = Scheduler::new();
        s.schedule_wake(a, 5);

        assert!(s.is_scheduled_at(a, 5), "a is scheduled at its exact tick");
        assert!(!s.is_scheduled_at(a, 4), "not scheduled a tick early");
        assert!(!s.is_scheduled_at(a, 6), "not scheduled a tick late");
        assert!(!s.is_scheduled_at(b, 5), "b shares the tick but is not in the bucket");
        // active_now membership is NOT a wheel entry — is_scheduled_at is wheel-only.
        s.wake_now(b);
        assert!(!s.is_scheduled_at(b, 0), "wake_now is the active set, not the wheel");
    }

    #[test]
    fn scheduler_sleep_set_marks_unblocks_and_wakes_all() {
        // Phase 87, JAM-04, D-06: a sleeper is in no wheel bucket and not active, so it
        // costs nothing; `unblock` reports whether it was asleep; `wake_all_blocked_now`
        // moves every sleeper into the current tick's active set and empties the set.
        let ids = mint(3);
        let (a, b, c) = (ids[0], ids[1], ids[2]);
        let mut s = Scheduler::new();
        s.mark_blocked(b);
        s.mark_blocked(a);
        s.mark_blocked(a);
        assert!(s.is_idle(0), "a sleeper is not stepped");
        assert!(s.is_blocked(a) && s.is_blocked(b) && !s.is_blocked(c));
        let mut both = vec![a, b];
        both.sort();
        assert_eq!(s.blocked_ids().collect::<Vec<_>>(), both, "ascending, de-duplicated");
        assert!(s.unblock(a), "a was asleep");
        assert!(!s.unblock(a), "and is not any more");
        assert!(!s.unblock(c), "c was never asleep");
        s.mark_blocked(c);
        s.wake_all_blocked_now();
        assert_eq!(s.blocked_ids().count(), 0, "the set is empty");
        let mut woke = vec![b, c];
        woke.sort();
        assert_eq!(s.drain_active_sorted(), woke, "every sleeper steps this tick");
    }

    #[test]
    fn scheduler_test_remove_wake_forges_missing_entry() {
        // The AR-3 forge: strip a single wheel entry while leaving the rest intact,
        // exactly the corrupt state (belt arrival with no wake) the trust gate rejects.
        let ids = mint(2);
        let (a, b) = (ids[0], ids[1]);
        let mut s = Scheduler::new();
        s.schedule_wake(a, 9);
        s.schedule_wake(b, 9); // same bucket as a

        s.test_remove_wake(a, 9);
        assert!(!s.is_scheduled_at(a, 9), "a's wheel entry was forged away");
        assert!(s.is_scheduled_at(b, 9), "b's entry in the same bucket survives");

        // Removing the last entry drops the bucket (mirrors `remove`'s discipline).
        s.test_remove_wake(b, 9);
        assert_eq!(s.pending_wakes(), 0, "emptied bucket is dropped");
        // Idempotent: removing an absent entry is a no-op.
        s.test_remove_wake(a, 9);
        assert_eq!(s.pending_wakes(), 0);
    }
}
