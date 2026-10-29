//! The timer source: a tick-interval injector that emits one logged event into
//! a configured source node every N ticks (SRC-03).
//!
//! # Pure function of the tick — no wall clock
//!
//! The whole point of a deterministic core is that the same starting state plus
//! the same ordered events always replays identically. A timer that read the
//! host's wall clock would inject events at non-reproducible ticks and break
//! replay. So this timer reads NO clock: its schedule is `tick % interval == 0`,
//! a pure function of the sim tick. Two independent runs with the same interval
//! inject on the identical set of ticks, and replaying the produced log
//! reproduces the same injections without the timer running at all (the
//! injections are already in the log as ordinary `ManualInject` events).
//!
//! Each due timer produces exactly ONE logged [`EventPayload::ManualInject`]
//! event targeting its configured source node, carrying its CONFIGURED payload
//! (`TimerConfig::item`) as the item — plain constant bytes per timer (no clock,
//! no counter), byte-stable across runs and replays, caller-chosen so a
//! JSON-parsing factory receives valid input (e.g. canonical `b"{}"`). The
//! driver stamps these into the log (monotonic `(partition, sequence)` + the
//! current tick) and folds them like any other inbound event, so a timer fire
//! is a normal item drop on the grid.

use std::collections::BTreeMap;

use fabrico_core::edit::{EditOp, EditRecord, MachineConfig, SourceTrigger};
use fabrico_core::event::{Event, EventPayload, SCHEMA_VERSION};
use fabrico_core::ids::{Item, NodeId};

use crate::config::TimerConfig;

/// The fixed item payload every PROJECTED timer injection carries (CFG-01): a
/// canonical, byte-stable `b"{}"` (valid JSON so a JSON-parsing Factory receives
/// well-formed input). A user-settable per-source payload is a deferred enhancement
/// that needs NO serialized change — the interval alone lives in the edit-log.
const PROJECTED_TIMER_PAYLOAD: &[u8] = b"{}";

/// Project a [`TimerSet`] from the certified edit-log (CFG-01, host-side Timer
/// trigger).
///
/// # Why the edit-log, not `core.state`
/// The Source trigger is deliberately NOT a snapshot field (adding a `trigger` to
/// `Node::Source` would be a FORBIDDEN second serialized re-bless — RESEARCH §Q3 /
/// Pitfall 5). So the trigger cannot be read from folded state the way
/// `project_routes` reads it. Instead this scans the LATEST live
/// `Configure{Source, trigger}` per node straight from the certified edit-log and
/// builds the tick-driven [`TimerSet`]. The produced injections are LOGGED
/// `ManualInject` events (via [`TimerSet::due_events`], reading no clock), so replay
/// reproduces them identically by construction.
///
/// # Latest-wins, deterministic
/// Walks `edits` in fold order maintaining an ordered `BTreeMap<NodeId, interval>`:
/// a `Timer { interval_ticks }` with `interval_ticks > 0` sets the node's interval
/// (a later config for the same node overwrites an earlier one — latest wins); a
/// `Webhook` (or an `interval_ticks == 0`) removes the node from the map; a later
/// `Delete { node }` ALSO removes it (a deleted node has no live timer — F1). The
/// resulting `TimerSet` is built from the map's ordered entries, so its timer order
/// is deterministic (a `BTreeMap`, never a `HashMap` iteration). Non-`Source`
/// configs (Factory/Sink) are ignored.
#[must_use]
pub fn project_timers(edits: &[EditRecord]) -> TimerSet {
    let mut intervals: BTreeMap<NodeId, u64> = BTreeMap::new();
    for record in edits {
        match &record.op {
            EditOp::Configure {
                node,
                config: MachineConfig::Source { trigger },
                ..
            } => match trigger {
                // A positive-interval Timer installs/overwrites this node's interval.
                SourceTrigger::Timer { interval_ticks } if *interval_ticks > 0 => {
                    intervals.insert(*node, *interval_ticks);
                }
                // Webhook, or a degenerate interval 0 — the node has no live timer.
                SourceTrigger::Timer { .. } | SourceTrigger::Webhook => {
                    intervals.remove(node);
                }
            },
            // A later Delete of the node drops its timer (F1 — TIMER-DELETE-LEAK): the
            // edit-log is append-only, so a `Configure{Source, Timer}` record survives
            // forever, but the node is GONE once its Delete folds. Without this arm the
            // projection would keep re-deriving the dead node's interval and
            // `due_events` would inject a `ManualInject` into it every interval tick
            // FOREVER — the fold drops each dangling-target inject (determinism holds),
            // but the durable event log grows unbounded on wasted work. Respecting log
            // order, a Delete after the Configure removes the entry; NodeIds are
            // generational (never reused), so a deleted node can never be re-configured
            // to re-add it. Mirrors `project_routes`, which self-heals by reading folded
            // state.
            EditOp::Delete { node, .. } => {
                intervals.remove(node);
            }
            _ => {}
        }
    }
    let timers = intervals
        .into_iter()
        .map(|(target, interval)| TimerConfig {
            target,
            interval,
            item: PROJECTED_TIMER_PAYLOAD.to_vec(),
        })
        .collect();
    TimerSet::new(timers)
}

/// A set of tick-interval timer sources. Each timer fires on `tick % interval ==
/// 0`, injecting one logged event into its target source node.
///
/// Holds plain [`TimerConfig`] data (target + interval + item payload); it
/// reads no clock and owns no mutable schedule state — the schedule is
/// recomputed from the tick on every call, so it is a pure function of the
/// tick.
#[derive(Clone, Debug, Default)]
pub struct TimerSet {
    timers: Vec<TimerConfig>,
}

impl TimerSet {
    /// Build a timer set from the configured timers. Shipped scenes reach this
    /// through [`project_timers`] (via `demo_scene::timers_from_log`), never by
    /// hand-building a set outside the edit-log.
    #[must_use]
    pub fn new(timers: Vec<TimerConfig>) -> Self {
        Self { timers }
    }

    /// Whether this set has no timers (so the driver can skip it cheaply).
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.timers.is_empty()
    }

    /// The configured fire interval for `node` in this projected set, if it has a
    /// LIVE timer entry (CFG-01) — the read side `SimLoop::machine_config` merges
    /// into a Source's [`SourceTrigger`](fabrico_core::edit::SourceTrigger). A Source
    /// with no timer (Webhook, or interval-0 / never configured) has NO entry here, so
    /// this returns `None` and the caller reports `SourceTrigger::Webhook`. Reuses the
    /// same projected set `project_timers` builds, so the config read and the live
    /// firing schedule can never disagree.
    #[must_use]
    pub fn interval_for(&self, node: NodeId) -> Option<u64> {
        self.timers
            .iter()
            .find_map(|t| (t.target == node).then_some(t.interval))
    }

    /// The logged events due at `tick`: one [`EventPayload::ManualInject`] per
    /// timer whose `tick % interval == 0` AND whose target `accepts` says would take
    /// it, each stamped with the next monotonic `sequence` from `next_seq` (advanced
    /// in place so the driver's own stamping stays monotonic after these).
    ///
    /// Reads NO clock — the schedule is purely `tick.is_multiple_of(interval)`.
    /// A timer with `interval == 0` never fires (guards a divide-by-zero / a
    /// degenerate every-tick storm).
    ///
    /// # A fire its Source would refuse is not logged (phase 87, JAM-04, plan 87-07)
    ///
    /// A due timer whose target `accepts` refuses is SKIPPED before it is stamped, so
    /// it consumes no sequence number and the next fire's sequence is the one this
    /// would have taken. The driver passes the core's own refusal predicate
    /// (`fabrico_core::admit::source_accepts_one` on the target Source, read at the
    /// head of the tick): the fold's `ManualInject` admit arm refuses exactly that
    /// event, silently, with no item, no fault and no wake, so the board does exactly
    /// the same thing whether it was logged or not. The one serialized trace a logged
    /// refusal left is the fold's running event count (`Core::cursor`), which counts
    /// what is logged; replay reads only the log, so a replay reaches the live state
    /// exactly, that count included. What logging it DID change is the save: a Timer
    /// Source behind a jam logged one refused event per interval, forever, and a board
    /// jammed solid grew its save without bound.
    ///
    /// Only the host's own timer is skipped. A webhook POST a user sends to a jammed
    /// Source is their input and is still logged, refused or not.
    pub fn due_events(&self, tick: u64, next_seq: &mut u64, accepts: impl Fn(NodeId) -> bool) -> Vec<Event> {
        let mut events = Vec::new();
        for timer in &self.timers {
            // interval 0 is degenerate: never schedule (and never divide by zero).
            if timer.interval == 0 {
                continue;
            }
            if tick.is_multiple_of(timer.interval) && accepts(timer.target) {
                let sequence = *next_seq;
                *next_seq += 1;
                events.push(Event {
                    schema_version: SCHEMA_VERSION,
                    partition: 0,
                    sequence,
                    tick,
                    payload: EventPayload::ManualInject {
                        target: timer.target,
                        port: 0,
                        item: Item(timer.item.clone()),
                    },
                });
            }
        }
        events
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use fabrico_core::ids::NodeId;
    use proptest::prelude::*;
    use slotmap::SlotMap;

    /// Mint a single real generational [`NodeId`] (key-minting only — no grid).
    fn a_node() -> NodeId {
        let mut alloc: SlotMap<NodeId, ()> = SlotMap::with_key();
        alloc.insert(())
    }

    /// The set of ticks in `0..range` at which `timers` injects (and how many
    /// events per due tick), using a fresh sequence counter.
    fn injected_ticks(timers: &TimerSet, range: u64) -> Vec<u64> {
        let mut seq = 0u64;
        let mut ticks = Vec::new();
        for tick in 0..range {
            let due = timers.due_events(tick, &mut seq, |_| true);
            if !due.is_empty() {
                ticks.push(tick);
            }
        }
        ticks
    }

    #[test]
    fn timer_interval() {
        // A timer {interval=3, item=b"{}"} injects on exactly 0,3,6,9 across ticks
        // 0..10, carrying ITS configured payload (Finding 2: a JSON-parsing demo
        // factory must receive valid input, not a fixed marker byte).
        let target = a_node();
        let payload = b"{}".to_vec();
        let timers = TimerSet::new(vec![TimerConfig {
            target,
            interval: 3,
            item: payload.clone(),
        }]);

        let mut seq = 0u64;
        for tick in 0..10u64 {
            let due = timers.due_events(tick, &mut seq, |_| true);
            if tick.is_multiple_of(3) {
                assert_eq!(due.len(), 1, "tick {tick} is a multiple of 3 -> one event");
                match &due[0].payload {
                    EventPayload::ManualInject { target: t, port, item } => {
                        assert_eq!(*t, target, "injects into the configured target");
                        assert_eq!(*port, 0, "source injection is on port 0");
                        assert_eq!(
                            item,
                            &Item(payload.clone()),
                            "the CONFIGURED payload rides the injection, no clock"
                        );
                    }
                    other => panic!("expected ManualInject, got {other:?}"),
                }
                assert_eq!(due[0].tick, tick, "the event is stamped at the firing tick");
            } else {
                assert!(due.is_empty(), "tick {tick} is not a multiple of 3 -> no event");
            }
        }
        // Sequence advanced once per injected tick (0,3,6,9 -> 4 events).
        assert_eq!(seq, 4, "next_seq advanced exactly once per injection");
    }

    #[test]
    fn timer_payload_rides_per_timer_config() {
        // Two timers with DIFFERENT payloads each emit their OWN payload — the
        // payload is per-timer config, not a shared constant.
        let target_a = a_node();
        let target_b = a_node();
        let timers = TimerSet::new(vec![
            TimerConfig { target: target_a, interval: 1, item: b"{}".to_vec() },
            TimerConfig { target: target_b, interval: 1, item: vec![0xAA, 0xBB] },
        ]);

        let mut seq = 0u64;
        let due = timers.due_events(0, &mut seq, |_| true);
        assert_eq!(due.len(), 2, "both timers fire at tick 0");
        match (&due[0].payload, &due[1].payload) {
            (
                EventPayload::ManualInject { item: item_a, .. },
                EventPayload::ManualInject { item: item_b, .. },
            ) => {
                assert_eq!(item_a, &Item(b"{}".to_vec()), "timer A emits ITS payload");
                assert_eq!(item_b, &Item(vec![0xAA, 0xBB]), "timer B emits ITS payload");
            }
            other => panic!("expected two ManualInjects, got {other:?}"),
        }
    }

    /// Plan 87-07 (JAM-04): a due timer whose target the predicate refuses yields no
    /// event and consumes no sequence number; another target's timer, due the same tick,
    /// still fires and takes the sequence the refused one would have had.
    #[test]
    fn timer_refused_target_is_skipped_without_a_sequence() {
        let mut alloc: SlotMap<NodeId, ()> = SlotMap::with_key();
        let refused = alloc.insert(());
        let open = alloc.insert(());
        let timers = TimerSet::new(vec![
            TimerConfig { target: refused, interval: 2, item: b"{}".to_vec() },
            TimerConfig { target: open, interval: 2, item: b"{}".to_vec() },
        ]);

        let mut seq = 40u64;
        let due = timers.due_events(4, &mut seq, |t| t != refused);
        assert_eq!(due.len(), 1, "only the accepting target's timer fires");
        match &due[0].payload {
            EventPayload::ManualInject { target, .. } => assert_eq!(*target, open, "the open target fired"),
            other => panic!("expected ManualInject, got {other:?}"),
        }
        assert_eq!(due[0].sequence, 40, "the fire that ran took the next sequence, not one after a skipped fire");
        assert_eq!(seq, 41, "next_seq advanced once: the skipped fire consumed no sequence");

        let mut seq = 7u64;
        assert!(timers.due_events(4, &mut seq, |_| false).is_empty(), "every target refusing yields nothing");
        assert_eq!(seq, 7, "and consumes nothing");
        assert!(timers.due_events(3, &mut seq, |_| true).is_empty(), "a tick that is not due yields nothing either");
    }

    #[test]
    fn timer_interval_zero_never_fires() {
        // A degenerate interval of 0 must never fire (no divide-by-zero, no storm).
        let timers = TimerSet::new(vec![TimerConfig {
            target: a_node(),
            interval: 0,
            item: b"{}".to_vec(),
        }]);
        assert!(injected_ticks(&timers, 50).is_empty(), "interval 0 never injects");
    }

    proptest! {
        /// The injected-tick set is a pure function of the interval: two
        /// independent runs with the same interval inject on the IDENTICAL set of
        /// ticks, and that set is exactly the multiples of the interval in range
        /// (no clock can perturb it).
        #[test]
        fn timer_same_interval_same_injected_ticks(
            interval in 1u64..=20,
            range in 1u64..=200,
        ) {
            let target = a_node();
            let a = TimerSet::new(vec![TimerConfig { target, interval, item: b"{}".to_vec() }]);
            let b = TimerSet::new(vec![TimerConfig { target, interval, item: b"{}".to_vec() }]);

            let ticks_a = injected_ticks(&a, range);
            let ticks_b = injected_ticks(&b, range);
            prop_assert_eq!(&ticks_a, &ticks_b, "same interval => identical injected ticks");

            let expected: Vec<u64> = (0..range).filter(|t| t.is_multiple_of(interval)).collect();
            prop_assert_eq!(&ticks_a, &expected, "injects on exactly the multiples of the interval");
        }
    }
}
