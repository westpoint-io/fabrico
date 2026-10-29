//! The headless `Core` driver: grid state + scheduler + seeded RNG advanced in
//! fixed integer ticks by folding an ordered event log (CORE-01/CORE-02).
//!
//! `Core` ties together the pieces the earlier plans built — [`GridState`]
//! (the projection), [`Scheduler`] (the active set), and [`SimRng`] (the only
//! sanctioned nondeterminism) — and drives them with [`crate::tick::tick`]. The
//! fundamental invariant: **grid state is a pure projection of the event log.**
//! Starting from [`genesis`](Core::genesis) and folding the same ordered events
//! always reconstructs the identical state (the determinism guarantee SC#1 proves
//! in plan 06).
//!
//! Ticks are plain `u64` integers — logical time, never wall-clock, never
//! fixed-point. `cursor` records how far into a log [`run_log`](Core::run_log)
//! has consumed, so the whole `Core` snapshots and restores at a tick boundary
//! (CORE-09): every field is `Clone` + serde-plain.

use crate::command::Command;
use crate::edit::EditRecord;
use crate::event::{Event, LogHeader};
use crate::factory::FactoryRuntimeCache;
use crate::ids::NodeId;
use crate::rng::SimRng;
use crate::scheduler::Scheduler;
use crate::state::GridState;

/// The maximum number of ticks a single replay ([`Core::run_log`] /
/// [`Core::run_log_two_logs`]) will fold forward before bailing with a typed
/// [`ReplayError`] rather than hanging or overflowing (WR-02).
///
/// The replay loops `while self.tick <= max_tick { … self.tick += 1 }`, stepping
/// ONE (possibly idle) tick per iteration. Both `self.tick` (a restored snapshot's
/// tick) and every log `tick` can be attacker-influenced on a tampered on-disk log,
/// so without a ceiling a hostile log with a gigantic max tick drives that loop a
/// trillion times (a non-terminating DoS) and overflows the final `self.tick += 1`
/// at `u64::MAX`.
///
/// This MIRRORS `fabrico_host::project::MAX_REPLAY_SPAN` (the pre-flight guard
/// `load_project` applies BEFORE `recover()`), pushed down into the replay engine so
/// the bound holds for ANY caller that reaches the loop directly — e.g.
/// `Host::recover` over a tampered `log.redb` opened via `Host::new` that did NOT
/// pass through `load_project` (the defense-in-depth gap WR-02 flags). The ceiling
/// (10M ticks ≈ 46h of simulated time at 60 ticks/s) is far beyond any sane snapshot
/// cadence yet finite, so a legitimately-saved project always replays.
pub const MAX_REPLAY_SPAN: u64 = 10_000_000;

/// A typed, non-panicking replay-bounding failure returned by [`Core::run_log`] /
/// [`Core::run_log_two_logs`] when an attacker-influenced log would drive the fold
/// loop past a safe bound (WR-02). NEVER a panic or an unbounded hang.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReplayError {
    /// The highest log tick is `u64::MAX`, so the loop's final `self.tick += 1`
    /// would overflow (panic under overflow-checks / silently wrap in release).
    /// Refused before the loop runs (Mode A of the load-time DoS).
    TickOverflow { max_tick: u64 },
    /// The forward replay span (`max_tick - self.tick`) exceeds [`MAX_REPLAY_SPAN`]
    /// — an effectively non-terminating idle-tick loop (Mode B of the load-time DoS,
    /// which bites even in release where the overflow does not). Bounded with
    /// saturating arithmetic and refused in O(1) before the loop runs.
    ReplaySpanTooLong { span: u64, limit: u64 },
}

impl std::fmt::Display for ReplayError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ReplayError::TickOverflow { max_tick } => write!(
                f,
                "replay max tick {max_tick} + 1 overflows u64 (hostile/tampered tick field)"
            ),
            ReplayError::ReplaySpanTooLong { span, limit } => write!(
                f,
                "replay would fold {span} ticks forward (exceeds the {limit}-tick ceiling) \
                 — refusing a replay DoS"
            ),
        }
    }
}

impl std::error::Error for ReplayError {}

/// A per-tick **presentation-only** observation of what the fold did, populated
/// fresh every [`tick`](crate::tick::tick) and consumed host-side (07-04) to
/// derive machine state (VIS-03) and the minted-id→cell association (SC5) WITHOUT
/// adding any presentation state to the snapshot.
///
/// It mirrors the [`FactoryRuntimeCache`] discipline: it lives on [`Core`] behind
/// `#[serde(skip)]`, so it has **zero snapshot-byte impact** (the frozen corpus and
/// the determinism oracle never see it), it is defaulted (empty) on deserialize,
/// and its [`Clone`] returns empty so a cloned `Core` never carries a stale
/// observation. Holding it is NOT state the sim reads — the fold writes it, the
/// host reads it, and the next tick clears it.
///
/// # The W1 disambiguation contract (carried by `placed`)
/// `placed` holds the ids of THREE minting folds in one fold-ordered list:
/// `Place`-minted node ids, `DrawBelt`-minted BELT ids and (63-02)
/// `DrawWire`-minted WIRE ids, 1:1 with the tick's enqueued Place+DrawBelt+DrawWire
/// events in order (Place → a non-Belt/non-Wire node id, DrawBelt → a Belt id,
/// DrawWire → a Wire id). Neither a `DrawBelt`-minted belt nor a `DrawWire`-minted
/// wire carries a machine cell, so the host (07-04) MUST filter those ids out (by
/// node kind) before pairing the survivors with Place cells — naive fold-order
/// zipping that pairs every placed id to a Place cell is wrong on a mixed tick.
/// (17-02 removed the node→node `Wire` op; belts are minted only by `DrawBelt` and
/// wires only by `DrawWire`, but the mixed-list kind-filtering contract is
/// unchanged.)
///
/// The list of minting folds is HAND-MAINTAINED in every consumer — most sharply in
/// `fabrico_command`, where `compute_inverse`'s parity filter and
/// `capture_after_fold`'s positional harvest each carry their own copy of it. A
/// fourth minting fold added here without updating both of those silently
/// mis-attributes a minted id to the wrong action.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct TickObservation {
    /// Every node id stepped this tick (across all fixpoint iterations), in fold
    /// order. The host derives `working` (state byte 1) from membership.
    pub stepped: Vec<NodeId>,
    /// Every node id that emitted on the reserved fault port this tick (router
    /// no-match-without-default + factory FAULT_PORT emissions). The host derives
    /// `faulted` (state byte 2) from membership.
    pub faulted: Vec<NodeId>,
    /// Node ids minted this tick — `Place`-minted nodes, `DrawBelt`-minted belts
    /// AND `DrawWire`-minted wires, in fold order (the W1 disambiguation contract
    /// above).
    pub placed: Vec<NodeId>,
    /// Node ids removed this tick by a `Delete` fold.
    pub removed: Vec<NodeId>,
    /// Docks deterministically UNLINKED this tick by a `Rotate` OR a `RemovePort` fold,
    /// in `links` key order. The belt node SURVIVES disconnected in both cases; only the
    /// ONE directed link is dropped.
    ///
    /// - `Rotate` (CAT-06, the SPIKE): a rotated port that no longer FACES its docked
    ///   belt end-tile.
    /// - `RemovePort` (73-06, UNDO-05): the dock that was ON the removed port. The docks
    ///   on the ports that SURVIVE are re-keyed rather than released, so they do not
    ///   appear here - that difference is the whole of R-26 and it is why the two folds
    ///   pass different verdicts into the shared `GridState::judge_docks`.
    ///
    /// Ephemeral telemetry (a sibling to `removed`): the host/render layer surfaces
    /// the de-dock (Phase-21 visual disconnect indicator); it is never snapshotted. That
    /// last clause is load-bearing for the second writer as much as the first: because
    /// this field never reaches a snapshot, a fold that starts writing it moves no
    /// fixture's per-tick state hash by doing so.
    pub unlinked: Vec<crate::state::UnlinkedDock>,
    /// Labels a connect fold REFUSED this tick (plan 86-07, D-08, WORK-09), in fold order:
    /// a `Node::Label` named by an `AddPort`, by a `Dock` (on any port, `FAULT_PORT`
    /// included) or by either end of a `DrawWire`. A label is a note and never connects,
    /// so those folds change nothing when they meet one and push the label's id here.
    ///
    /// No record a build writes reaches this: `validate_normalize` refuses every such
    /// gesture first (`LabelDoesNotConnect`), so only a forged or hand-edited log does.
    /// `fabrico_command`'s re-fold from genesis reads it after each slice and the load path
    /// refuses the file in words rather than dropping the record and opening it.
    ///
    /// Ephemeral telemetry like its siblings: never snapshotted, so writing it moves no
    /// fixture's per-tick state hash.
    pub refused_label_connects: Vec<NodeId>,
}

impl Clone for TickObservation {
    /// Returns an EMPTY observation (mirrors [`FactoryRuntimeCache`]): the
    /// per-tick signal is never carried across a `Core` clone, so a cloned `Core`
    /// starts with a clean observation that the next tick populates.
    fn clone(&self) -> Self {
        Self::default()
    }
}

/// The deterministic sim driver. A snapshot of `Core` at a tick boundary fully
/// captures the running simulation (CORE-09).
#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct Core {
    /// Current logical tick (integer time — the only "now").
    pub tick: u64,
    /// The grid: the projection of the folded log.
    pub state: GridState,
    /// The active-set scheduler (who steps this tick).
    pub sched: Scheduler,
    /// The single seeded nondeterminism source (genesis seed from the header).
    pub rng: SimRng,
    /// Cumulative count of events [`run_log`](Core::run_log) has consumed across
    /// the sim's life (diagnostics / snapshot continuity) — not an index into any
    /// single call's slice.
    pub cursor: u64,
    /// The live, **non-serialized** factory engine cache (Phase 4): one compiled
    /// `rquickjs` runtime per `Node::Factory`, rebuilt lazily from the node's plain
    /// data on a cold cache / after restore.
    ///
    /// `#[serde(skip)]` (and defaulted on deserialize) so ONLY plain data crosses the
    /// snapshot boundary — the live engine handles are never serialized, and a
    /// restored `Core` starts with a cold cache (threat T-04-SNAP). Its `Clone` also
    /// returns empty, so a `Core` clone never shares a mutable engine. Excluded from
    /// the snapshot bytes, so it does not perturb the state-equality oracle or the
    /// frozen golden corpus.
    #[serde(skip)]
    pub factory_runtimes: FactoryRuntimeCache,
    /// The **non-serialized** per-tick observation surface (Phase 7): which nodes
    /// stepped/faulted/were-minted/were-removed this tick, for the host's VIS-03
    /// machine-state and SC5 layout-association derivations.
    ///
    /// `#[serde(skip)]` (and defaulted on deserialize) so ONLY plain data crosses
    /// the snapshot boundary — exactly the [`factory_runtimes`](Self::factory_runtimes)
    /// rationale: zero snapshot-byte impact (the determinism oracle and the frozen
    /// golden corpus never see it), defaulted (empty) on restore, empty on clone
    /// (see [`TickObservation::clone`]). It is a presentation-only signal the fold
    /// writes and the host reads; the sim never reads it back.
    #[serde(skip)]
    pub last_tick: TickObservation,
}

impl Core {
    /// Start a fresh sim from the log's genesis header: tick 0, empty grid, an
    /// RNG seeded from `header.seed` (CORE-05), nothing scheduled.
    pub fn genesis(header: LogHeader) -> Self {
        Self {
            tick: 0,
            state: GridState::new(),
            sched: Scheduler::new(),
            rng: SimRng::from_seed_u64(header.seed),
            cursor: 0,
            factory_runtimes: FactoryRuntimeCache::default(),
            last_tick: TickObservation::default(),
        }
    }

    /// Advance the sim by exactly one tick, admitting `inbound` (the events
    /// logged at the current tick) and folding the active set. Returns the
    /// command intent emitted this tick (the executor is muted in Phase 1, so
    /// commands are never dispatched here).
    pub fn advance(&mut self, inbound: &[Event]) -> Vec<Command> {
        crate::tick::tick(self, &[], inbound)
    }

    /// Advance the sim by exactly one tick on the TWO-LOG model: apply `edits`
    /// (the topology edit-records logged at the current tick) EDITS-FIRST, then
    /// admit `events` (the runtime events logged at the current tick), then fold
    /// the active set (decision Q1 / FORK 3). Returns the command intent emitted
    /// this tick.
    ///
    /// The single-log [`advance`](Self::advance) is exactly
    /// `advance_edits(&[], inbound)` — an event-only tick with an empty edit-log —
    /// which is why the entire event-only property suite keeps proving unchanged on
    /// the two-log model.
    pub fn advance_edits(&mut self, edits: &[EditRecord], events: &[Event]) -> Vec<Command> {
        crate::tick::tick(self, edits, events)
    }

    /// Two-cursor batch driver: fold an ordered edit-log AND an ordered event-log
    /// tick-by-tick from the current tick up to the highest `tick` in EITHER log,
    /// applying each tick's edits EDITS-FIRST before its events.
    ///
    /// Mirrors [`run_log`](Self::run_log) but advances a SECOND cursor over `edits`:
    /// at each tick it takes the contiguous `edits[..].tick == self.tick` slice AND
    /// the `events[..].tick == self.tick` slice and calls
    /// [`advance_edits`](Self::advance_edits). The leading past-tick skip (WR-A) is
    /// preserved for BOTH cursors. `cursor` accumulates the count of EVENTS consumed
    /// this call (mirroring `run_log`'s diagnostics discipline; the edit-log carries
    /// its own `(partition, sequence)` provenance).
    ///
    /// Both logs MUST be ordered so same-tick records are contiguous and ticks are
    /// non-decreasing (the same contract as [`run_log`](Self::run_log)).
    pub fn run_log_two_logs(
        &mut self,
        edits: &[EditRecord],
        events: &[Event],
    ) -> Result<Vec<Command>, ReplayError> {
        let mut commands = Vec::new();
        let max_event = events.iter().map(|e| e.tick).max();
        let max_edit = edits.iter().map(|e| e.tick).max();
        let max_tick = match (max_event, max_edit) {
            (Some(a), Some(b)) => a.max(b),
            (Some(a), None) | (None, Some(a)) => a,
            (None, None) => return Ok(commands), // both batches empty: nothing to fold
        };
        // Bound the forward replay BEFORE the loop (WR-02): a hostile max tick would
        // otherwise hang the idle-tick loop and overflow the final `self.tick += 1`.
        self.guard_replay_span(max_tick)?;
        let mut eidx = 0usize;
        let mut didx = 0usize;
        // Skip leading already-consumed (past-tick) records in BOTH logs so a stale
        // front record cannot stall a cursor and silently drop the rest (WR-A).
        while eidx < events.len() && events[eidx].tick < self.tick {
            eidx += 1;
        }
        while didx < edits.len() && edits[didx].tick < self.tick {
            didx += 1;
        }
        let first_event = eidx;
        while self.tick <= max_tick {
            // EDITS-FIRST: gather this tick's contiguous edit slice, then its event
            // slice; `advance_edits` applies the edits ahead of the events.
            let dstart = didx;
            while didx < edits.len() && edits[didx].tick == self.tick {
                didx += 1;
            }
            let estart = eidx;
            while eidx < events.len() && events[eidx].tick == self.tick {
                eidx += 1;
            }
            let mut c = self.advance_edits(&edits[dstart..didx], &events[estart..eidx]);
            commands.append(&mut c);
        }
        self.cursor += (eidx - first_event) as u64;
        Ok(commands)
    }

    /// Bound a forward replay from `self.tick` up to `max_tick` (WR-02), mirroring
    /// `fabrico_host::project::load_project`'s pre-flight `MAX_REPLAY_SPAN` /
    /// tick-overflow guards but pushed down into the engine so it holds for ANY
    /// caller of [`run_log`](Self::run_log) / [`run_log_two_logs`](Self::run_log_two_logs).
    ///
    /// Returns `Ok(())` when there is nothing to fold forward (`self.tick > max_tick`,
    /// e.g. an empty-future / leading-past batch — the loop would not execute). Else:
    /// - **Mode A:** `max_tick == u64::MAX` ⇒ the loop's final `self.tick += 1` would
    ///   overflow ⇒ [`ReplayError::TickOverflow`] (checked arithmetic);
    /// - **Mode B:** `max_tick - self.tick > MAX_REPLAY_SPAN` ⇒ an effectively
    ///   non-terminating idle-tick loop ⇒ [`ReplayError::ReplaySpanTooLong`]
    ///   (saturating arithmetic keeps the bound itself panic-free).
    fn guard_replay_span(&self, max_tick: u64) -> Result<(), ReplayError> {
        if self.tick > max_tick {
            return Ok(());
        }
        // Mode A: the final `self.tick += 1` at `max_tick` must not overflow.
        max_tick
            .checked_add(1)
            .ok_or(ReplayError::TickOverflow { max_tick })?;
        // Mode B: the idle-tick loop span must be finite and bounded.
        let span = max_tick.saturating_sub(self.tick);
        if span > MAX_REPLAY_SPAN {
            return Err(ReplayError::ReplaySpanTooLong {
                span,
                limit: MAX_REPLAY_SPAN,
            });
        }
        Ok(())
    }

    /// Fold an ordered batch of events from the current tick up to the highest
    /// `event.tick` in `events`. At each tick the slice of events stamped for
    /// that tick is admitted; ticks with no events are still advanced (idle
    /// ticks, near-free).
    ///
    /// `events` is the batch of (new) events to fold **from the current tick
    /// onward** — it is consumed relative to its own start, not via a persistent
    /// absolute index. This makes incremental/event-sourced usage correct: a
    /// later call passing only the *new* events resumes from `self.tick` and
    /// admits them. (The previous implementation indexed `events` by an absolute
    /// `cursor`, so a second call passing only new events indexed past the slice
    /// and silently dropped every one — the WR-01 footgun.)
    ///
    /// `events` must be ordered so same-tick events are contiguous and ticks are
    /// non-decreasing. Events stamped in the **past** (`tick < self.tick`) are
    /// already-consumed and are skipped before folding, so a stale leading event
    /// can never stall the cursor. This keeps both usages correct: the
    /// incremental usage (pass only the new events) AND the
    /// always-pass-the-full-cumulative-log usage (the already-folded prefix is
    /// skipped and the remaining future events still admit). Without this skip a
    /// leading past event would never match a folded tick, freeze `idx` at 0, and
    /// silently drop the entire batch — the WR-A regression the WR-01 fix
    /// introduced. `cursor` records the cumulative number of events consumed
    /// across the sim's life (diagnostics / snapshot continuity), not an index
    /// into any single call's slice.
    pub fn run_log(&mut self, events: &[Event]) -> Result<Vec<Command>, ReplayError> {
        let mut commands = Vec::new();
        let Some(max_tick) = events.iter().map(|e| e.tick).max() else {
            return Ok(commands); // empty batch: nothing to fold
        };
        // Bound the forward replay BEFORE the loop (WR-02) — see `guard_replay_span`.
        self.guard_replay_span(max_tick)?;
        let mut idx = 0usize;
        // Skip leading already-consumed (past-tick) events so a stale front event
        // cannot stall `idx` and silently drop the rest of the batch (WR-A).
        while idx < events.len() && events[idx].tick < self.tick {
            idx += 1;
        }
        // Events before this index were already folded in a prior call — they
        // must NOT be counted into `cursor` again (WR-02). Counting from here
        // makes the cumulative count agree between the incremental driver and the
        // "always re-pass the full cumulative log" driver the docs call
        // equivalent, so the whole-`Core` snapshot stays a faithful equality
        // oracle.
        let first_admitted = idx;
        while self.tick <= max_tick {
            let start = idx;
            while idx < events.len() && events[idx].tick == self.tick {
                idx += 1;
            }
            let mut c = self.advance(&events[start..idx]);
            commands.append(&mut c);
        }
        self.cursor += (idx - first_admitted) as u64;
        Ok(commands)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::{EventPayload, SCHEMA_VERSION};
    use crate::ids::{Item, NodeId};
    use crate::state::Node;

    fn header(seed: u64) -> LogHeader {
        LogHeader {
            schema_version: SCHEMA_VERSION,
            seed,
        }
    }

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

    #[test]
    fn core_genesis_seeds_rng_from_header() {
        let mut core = Core::genesis(header(0xABCD));
        assert_eq!(core.tick, 0);
        assert_eq!(core.state.node_count(), 0);
        // The RNG stream matches a reference seeded the same way (CORE-05).
        let mut reference = SimRng::from_seed_u64(0xABCD);
        assert_eq!(core.rng.next_u64(), reference.next_u64());
    }

    #[test]
    fn core_run_log_folds_topology_and_transports_over_the_slot_belt() {
        // source -> belt(1 tile) -> collector(source, ignores its inbox). A single
        // Fire at tick 0 admits the item to the belt tail; run_log stops at the max
        // event tick (0), so it has NOT yet traversed. Advancing the slot-belt's
        // traverse ticks lands it in the collector (the fold delivers the head once
        // it reaches slot 0). A Source ignores its input port, so it is not consumed.
        use crate::belt_slots::slot_count;
        let mut core = Core::genesis(header(1));
        let s = core.state.add_source();
        let b = core.state.add_belt(1);
        let c = core.state.add_source();
        core.state.link((s, 0), (b, 0));
        core.state.link((b, 0), (c, 0));

        let log = [fire(s, 1, 0, Item(vec![0xEE]))];
        core.run_log(&log).expect("replay within MAX_REPLAY_SPAN");
        assert_eq!(core.tick, 1, "run_log advanced past the single event tick");
        assert!(
            core.state.inbox_of(c).is_some_and(|i| i.is_empty()),
            "absent before the slot belt has been traversed"
        );

        // Advance the remaining traverse ticks; the item then rests in C's inbox. A
        // DERIVED BUDGET (SLOT-04, `62-CONTEXT.md` D-01): `slot_count(1)` counts
        // ADVANCES, and advances are not ticks - a belt advances one slot every
        // `ticks_per_slot` ticks - so the tick budget is that count times the interval.
        // Flat, it under-ran at every interval above 1 and the test failed at
        // `collector has the item after traverse`, which reads as a lost item rather
        // than as an impatient loop. Found by plan 62-03's mutation drill (FINDING 3-C),
        // not by the grep that found the prose.
        for _ in 0..(slot_count(1) as u64 * u64::from(crate::belt_slots::DEFAULT_TICKS_PER_SLOT.get())) {
            core.advance(&[]);
        }
        let mut c_inbox = core.state.inbox_of(c).cloned().expect("collector inbox");
        let (_seq, item) = c_inbox.take(0).expect("collector has the item after traverse");
        assert_eq!(item, Item(vec![0xEE]));
    }

    #[test]
    fn core_genesis_then_fold_is_deterministic_replay() {
        // Folding the same log from genesis twice reconstructs identical state
        // (the projection guarantee CORE-02; SC#1 proven fully in plan 06).
        let build = || {
            let mut core = Core::genesis(header(7));
            let s = core.state.add_source();
            let b = core.state.add_belt(0);
            let c = core.state.add_source();
            core.state.link((s, 0), (b, 0));
            core.state.link((b, 0), (c, 0));
            core.run_log(&[fire(s, 1, 0, Item(vec![1, 2, 3]))]).expect("replay within MAX_REPLAY_SPAN");
            core
        };
        let a = build();
        let b = build();
        // Byte-identical snapshots of the two independent runs.
        let ba = postcard::to_allocvec(&a.state).expect("serialize a");
        let bb = postcard::to_allocvec(&b.state).expect("serialize b");
        assert_eq!(ba, bb, "same log from genesis => identical projected state");
    }

    #[test]
    fn core_run_log_resumes_across_incremental_calls() {
        // Regression for WR-01: a second run_log call passing only the NEW events
        // (the natural event-sourced / webhook usage) must admit them — not
        // silently drop them because a stale absolute cursor indexed past the new
        // slice.
        let mut core = Core::genesis(header(1));
        let s = core.state.add_source();
        let c = core.state.add_source();
        core.state.link((s, 0), (c, 0)); // instant link: same-tick delivery into c

        // Call 1: events stamped at ticks 0 and 1.
        core.run_log(&[
            fire(s, 1, 0, Item(vec![0xA])),
            fire(s, 2, 1, Item(vec![0xB])),
        ]).expect("replay within MAX_REPLAY_SPAN");
        assert_eq!(core.tick, 2, "advanced through tick 1");

        // Call 2: ONLY the new events, stamped at ticks 2 and 3 (incremental).
        core.run_log(&[
            fire(s, 3, 2, Item(vec![0xC])),
            fire(s, 4, 3, Item(vec![0xD])),
        ]).expect("replay within MAX_REPLAY_SPAN");
        assert_eq!(core.tick, 4, "advanced through tick 3 on the incremental call");

        // All four items were admitted, fired, and delivered to the collector
        // (a Source that ignores its input, so they rest there FIFO).
        let mut inbox = core.state.inbox_of(c).cloned().expect("collector inbox");
        let mut got = Vec::new();
        while let Some((_seq, item)) = inbox.take(0) {
            got.push(item);
        }
        assert_eq!(
            got,
            vec![
                Item(vec![0xA]),
                Item(vec![0xB]),
                Item(vec![0xC]),
                Item(vec![0xD]),
            ],
            "incremental run_log admitted every event (none dropped)"
        );
    }

    #[test]
    fn core_run_log_full_cumulative_log_drops_no_future_event() {
        // Regression for WR-A: a batch whose LEADING event predates self.tick
        // (the "always re-pass the full cumulative log" usage) must skip the
        // already-consumed prefix and still admit every future event — not stall
        // idx at 0 and silently drop the whole batch. Also assert the resulting
        // state equals a single full fold from genesis.
        let topo = |core: &mut Core| {
            let s = core.state.add_source();
            let c = core.state.add_source();
            core.state.link((s, 0), (c, 0)); // instant link: same-tick delivery
            (s, c)
        };

        // Driver A: incremental + full-cumulative-log re-pass.
        let mut a = Core::genesis(header(1));
        let (sa, ca) = topo(&mut a);
        let full_log = [
            fire(sa, 1, 0, Item(vec![0xA])),
            fire(sa, 2, 1, Item(vec![0xB])),
            fire(sa, 3, 2, Item(vec![0xC])),
            fire(sa, 4, 3, Item(vec![0xD])),
        ];
        // Call 1 consumes ticks 0..1, leaving self.tick == 2.
        a.run_log(&full_log[0..2]).expect("replay within MAX_REPLAY_SPAN");
        assert_eq!(a.tick, 2);
        // Call 2 re-passes the ENTIRE cumulative log. The leading e@0/e@1 are in
        // the past and must be skipped; e@2/e@3 must still admit.
        a.run_log(&full_log).expect("replay within MAX_REPLAY_SPAN");
        assert_eq!(a.tick, 4, "full-cumulative re-pass advanced through tick 3");

        // Driver B: a single full fold of the whole log from genesis.
        let mut b = Core::genesis(header(1));
        let (sb, cb) = topo(&mut b);
        b.run_log(&[
            fire(sb, 1, 0, Item(vec![0xA])),
            fire(sb, 2, 1, Item(vec![0xB])),
            fire(sb, 3, 2, Item(vec![0xC])),
            fire(sb, 4, 3, Item(vec![0xD])),
        ]).expect("replay within MAX_REPLAY_SPAN");

        // No future event was dropped: all four items rest FIFO in the collector.
        let collect = |core: &Core, id: NodeId| {
            let mut inbox = core.state.inbox_of(id).cloned().expect("collector inbox");
            let mut got = Vec::new();
            while let Some((_seq, item)) = inbox.take(0) {
                got.push(item);
            }
            got
        };
        let want = vec![
            Item(vec![0xA]),
            Item(vec![0xB]),
            Item(vec![0xC]),
            Item(vec![0xD]),
        ];
        assert_eq!(
            collect(&a, ca),
            want,
            "full-cumulative re-pass dropped no future event (WR-A)"
        );
        // And the cumulative-log driver's grid state matches a single full fold.
        assert_eq!(
            collect(&b, cb),
            want,
            "single full fold delivers all four items"
        );
        assert_eq!(
            postcard::to_allocvec(&a.state).expect("serialize a"),
            postcard::to_allocvec(&b.state).expect("serialize b"),
            "cumulative re-pass state == single full fold state"
        );
    }

    #[test]
    fn core_run_log_skips_leading_past_event_in_one_batch() {
        // A single batch with a mis-stamped/duplicate leading PAST event must not
        // poison the otherwise-valid future events behind it.
        let mut core = Core::genesis(header(1));
        let s = core.state.add_source();
        let c = core.state.add_source();
        core.state.link((s, 0), (c, 0));

        // Advance to tick 2 first.
        core.run_log(&[
            fire(s, 1, 0, Item(vec![0xA])),
            fire(s, 2, 1, Item(vec![0xB])),
        ]).expect("replay within MAX_REPLAY_SPAN");
        assert_eq!(core.tick, 2);

        // One leading past event (tick 1, already consumed) followed by valid
        // future events. The past one is skipped; the future ones still admit.
        core.run_log(&[
            fire(s, 9, 1, Item(vec![0xBA])), // stale leading past event
            fire(s, 3, 2, Item(vec![0xC])),
            fire(s, 4, 3, Item(vec![0xD])),
        ]).expect("replay within MAX_REPLAY_SPAN");
        assert_eq!(core.tick, 4, "future events behind the stale one still folded");

        let mut inbox = core.state.inbox_of(c).cloned().expect("collector inbox");
        let mut got = Vec::new();
        while let Some((_seq, item)) = inbox.take(0) {
            got.push(item);
        }
        assert_eq!(
            got,
            vec![
                Item(vec![0xA]),
                Item(vec![0xB]),
                Item(vec![0xC]),
                Item(vec![0xD]),
            ],
            "stale leading past event did not drop the valid future events (WR-A)"
        );
    }

    #[test]
    fn core_node_variants_include_phase2_operators() {
        // Phase 2 extends the Node enum with routing operators: the grid now
        // constructs Tee/Balancer in addition to the Phase-1 Source/Belt kinds.
        let mut core = Core::genesis(header(0));
        let s = core.state.add_source();
        let b = core.state.add_belt(1);
        let t = core.state.add_tee(2);
        let bal = core.state.add_balancer(2);
        assert!(matches!(core.state.node(s), Some(Node::Source(_))));
        assert!(matches!(core.state.node(b), Some(Node::Belt(_))));
        assert!(matches!(core.state.node(t), Some(Node::Tee(_))));
        assert!(matches!(core.state.node(bal), Some(Node::Balancer(_))));
    }

    #[test]
    fn run_log_rejects_replay_span_too_long() {
        // WR-02 (Mode B): a single event stamped far beyond MAX_REPLAY_SPAN must be
        // refused with a typed ReplaySpanTooLong BEFORE the idle-tick loop runs — never
        // a multi-trillion-iteration hang. The bound holds in the engine regardless of
        // caller (the defense-in-depth that protects recover() over a tampered log).
        let mut core = Core::genesis(header(1));
        let s = core.state.add_source();
        let huge_tick = MAX_REPLAY_SPAN + 5;
        let result = core.run_log(&[fire(s, 1, huge_tick, Item(vec![0x1]))]);
        assert!(
            matches!(result, Err(ReplayError::ReplaySpanTooLong { span, limit })
                if span == huge_tick && limit == MAX_REPLAY_SPAN),
            "an over-span replay is refused as ReplaySpanTooLong"
        );
        assert_eq!(core.tick, 0, "rejected before folding any tick (no partial advance)");
    }

    #[test]
    fn run_log_rejects_tick_overflow_at_u64_max() {
        // WR-02 (Mode A): an event stamped at u64::MAX must be refused with TickOverflow
        // rather than panicking on the loop's final `self.tick += 1` (debug) or silently
        // wrapping (release). Checked arithmetic before the loop catches it.
        let mut core = Core::genesis(header(1));
        let s = core.state.add_source();
        let result = core.run_log(&[fire(s, 1, u64::MAX, Item(vec![0x1]))]);
        assert!(
            matches!(result, Err(ReplayError::TickOverflow { max_tick }) if max_tick == u64::MAX),
            "a u64::MAX tick is refused as TickOverflow (no overflow panic / wrap)"
        );
    }

    #[test]
    fn run_log_two_logs_rejects_unbounded_span() {
        // WR-02: the two-log replay engine carries the SAME bound (recover()'s path).
        // An edit stamped far beyond MAX_REPLAY_SPAN is refused, never hung.
        use crate::edit::{EDIT_SCHEMA_VERSION, EditOp, EditRecord};
        let mut core = Core::genesis(header(1));
        let huge_tick = MAX_REPLAY_SPAN + 5;
        let edit = EditRecord {
            schema_version: EDIT_SCHEMA_VERSION,
            partition: 0,
            sequence: 0,
            tick: huge_tick,
            action: 0,
            op: EditOp::Place {
                kind: 0,
                cell_x: 0,
                cell_y: 0,
                w: 1,
                h: 1,
                ports: vec![],
                rot: 0,
            },
        };
        let result = core.run_log_two_logs(&[edit], &[]);
        assert!(
            matches!(result, Err(ReplayError::ReplaySpanTooLong { .. })),
            "an over-span edit-log replay is refused (two-log engine bounded too)"
        );
        assert_eq!(core.tick, 0, "rejected before folding any tick");
    }
}
