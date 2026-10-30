//! The host driver — the sync, single-thread owner of [`Core`] + redb that
//! bridges the deterministic sim to the async tokio executor by channels.
//!
//! This is the integration hub where the phase's guarantees converge:
//! - **EXEC-01 (the grid never blocks):** the sim runs on its own thread, owns
//!   the [`Core`] and the single redb writer, and drains the result/ingress
//!   channels with `try_recv` — it NEVER `.await`s and never waits on the async
//!   executor mid-fold.
//! - **EXEC-02 (results fold back off-thread):** an emitted [`Command`] is sent
//!   to the executor over a channel; its `Outcome` returns as a [`ResultEvent`]
//!   the driver drains on a later tick and appends to the log as a
//!   [`EventPayload::CommandResult`].
//! - **EXEC-03 (deadline -> Timeout):** at the deadline tick of an unresolved
//!   command the driver synthesizes a deterministic [`EventPayload::Timeout`]
//!   (BTreeMap order — never a randomly-ordered hashed set).
//! - **EXEC-04 (crash recovery never double-sends):** [`Host::recover`] rebuilds
//!   [`Core`] from snapshot + log with the executor muted and reconciles the
//!   durable ledger, so an in-flight-without-result command is NEVER re-dispatched
//!   (it resolves as a Timeout at its deadline instead).
//! - **REPLAY-04 (executor muted on replay):** the determinism guarantee is
//!   "same log => same state". The driver's only job on the live path is to
//!   produce a LOG; replaying that log via [`Host::recover`] folds byte-identical
//!   state while dispatching ZERO real effects.
//!
//! # The fixed per-tick order ([`Host::tick_once`])
//! `tick_once` drains both channels with `try_recv` and calls [`Engine::step`], which does no
//! I/O. It then hands the [`StepOutput`] to `Host::finish_tick`, which performs the durable
//! writes and the sends.
//!
//! In the engine:
//! 1. timers, then the drained ingress, stamped into this tick's inbound batch;
//! 2. the drained results: a result CLEARS its in-flight entry (handled BEFORE timeout
//!    synthesis, RESEARCH Pitfall 5, so an in-time result can never produce a spurious
//!    Timeout);
//! 3. synthesize a [`EventPayload::Timeout`] for every still-in-flight command
//!    whose `deadline <= tick`, iterating the in-flight `BTreeMap<CommandId>` in
//!    deterministic order;
//! 4. stamp every inbound event with a monotonic `(partition, sequence)` and the current
//!    tick (NEVER a wall-clock value), and stamp this tick's enqueued topology edits;
//! 5. fold one tick EDITS-FIRST:
//!    `core.advance_edits(&edits, &inbound) -> Vec<Command>` (the topology edits
//!    fold ahead of the events this tick), and track each emitted command's deadline.
//!
//! Then in the host:
//! 6. mark each resolved command `Done` in the ledger, append every inbound event to the
//!    durable log, and append every stamped edit to the EDITS table (ELOG-01);
//! 7. for each emitted command: write the durable `InFlight` ledger row (the
//!    write-ahead marker) THEN send it to the executor;
//! 8. persist a snapshot if the cadence is due at the new tick boundary.
//!
//! The fold runs before the durable writes. A crash loses the in-memory fold either way, so
//! recovery behaves the same. If a write fails the core sits one tick ahead of the log, the
//! sim loop stops on that error, and nothing reads the core or saves after it.
//!
//! # Single-writer invariant
//! The host loop is the ONE redb writer (the event log, the snapshots, and the
//! ledger). Concurrent executor tasks never touch redb — they only send
//! [`ResultEvent`]s back over a channel for the loop to drain, log, and mark
//! `Done`. This keeps the single-writer guarantee without a mutex.

use std::collections::BTreeSet;

use fabrico_command::GridSession;
use fabrico_core::command::{Command, ResultEvent};
use fabrico_core::core::Core;
use fabrico_core::edit::{EDIT_SCHEMA_VERSION, EditRecord};
use fabrico_core::event::{DecodeError, Event, EventPayload, LogHeader, SCHEMA_VERSION};
use fabrico_core::ids::CommandId;
use fabrico_core::persist::{PersistenceStore, RedbStore, StoreError};
use fabrico_core::snapshot::{persist_snapshot, restore, snapshot, snapshot_due};
use fabrico_engine::engine::{Engine, StepOutput};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender};

use crate::ingress::seen_set::SeenSet;
use crate::ingress::timer::TimerSet;
use crate::ledger::DispatchLedger;

/// The sync, single-thread driver: owns the [`Engine`], which holds [`Core`], plus the redb
/// event-log/snapshot store (the single writer) and the durable dispatch
/// [`DispatchLedger`].
///
/// The engine holds everything a tick needs that is not durable, including the in-flight set.
/// The host holds everything that touches the disk, and it performs what each
/// [`Engine::step`] returns.
pub struct Host {
    /// The tick loop body and its non-durable state. Owned by, and never moved off, the
    /// driver thread (the Core caches `!Send` rquickjs runtimes, so it is built on and
    /// stays on its owning thread).
    engine: Engine,
    /// The single redb writer for the append-only event log + periodic snapshots.
    store: RedbStore,
    /// The durable write-ahead dispatch ledger (the exactly-once backbone).
    ledger: DispatchLedger,
    /// Periodic snapshot cadence (ticks). `None` => on-demand only.
    snapshot_every: Option<u64>,
    /// The persisted webhook delivery-id dedup store (INGRESS-02). `None` => no
    /// webhook ingress on this host (the seed/timer paths are already trusted).
    /// When present, the host loop records a delivery id BEFORE logging its
    /// event — and the record is durable across a restart.
    seen: Option<SeenSet>,
}

impl Host {
    /// Build a driver around a pre-constructed [`Core`] (its topology already
    /// wired), the redb event-log store, and the dispatch ledger.
    ///
    /// `next_seq` is derived from the persisted log's high-water mark, NOT reset to
    /// 0 (WR-04): the host always appends at the next free `(partition, sequence)`
    /// key. This makes resumption safe BY DEFAULT — constructing a `Host` over an
    /// already-populated store and ticking WITHOUT first calling [`Host::recover`]
    /// can no longer hand out sequences `0,1,2,…` and silently overwrite the
    /// source-of-truth log. (Sequences are contiguous from 0 in partition 0 — every
    /// stamped event is appended once — so the count IS the next free sequence;
    /// [`Host::recover`] later sets the identical value from the replayed log.)
    ///
    /// # Errors
    /// Returns the underlying [`StoreError`] if the persisted log cannot be read to
    /// compute the high-water mark.
    pub fn new(
        core: Core,
        store: RedbStore,
        ledger: DispatchLedger,
        snapshot_every: Option<u64>,
    ) -> Result<Self, StoreError> {
        // The next free sequence = the number of already-persisted partition-0
        // events (sequences are contiguous from 0). An empty/never-written log
        // reads back as 0 — identical to the previous hard-coded reset, but correct
        // for a populated store.
        let next_seq = store.read_events(0, 0)?.len() as u64;
        // The next free EDIT sequence = the number of already-persisted partition-0
        // edits (contiguous from 0, exactly like `next_seq`). An empty/never-written
        // edit-log reads back as 0; recover() later sets the identical value from the
        // replayed edit-log.
        let raw_edits = store.read_edits(0, 0)?;
        let next_edit_seq = raw_edits.len() as u64;
        // The next free ACTION id = the persisted edit-log's action high-water + 1
        // (0 for an empty log), mirroring `next_seq`/`next_edit_seq` so a resume over
        // a populated edit-log never reuses an action id (RESEARCH Pitfall 1). Decode
        // each record to read its `action` (the len shortcut only works for the
        // contiguous sequence keys); a wrong-versioned or garbage record is a typed
        // StoreError, mirroring `logged_edits`.
        //
        // THIS IS THE FOURTH EDIT-LOG DECODE BOUNDARY, and it is production-reachable
        // by every `Host::new` call. Phase 63's RESEARCH FINDING 3 named three
        // (`edit::upcast`, `Host::logged_edits`, `project::load_project`) and missed
        // this one. Until plan 63-11 the comment above claimed a version refusal that
        // the loop below did not perform: only `postcard` failure was caught, so a
        // stale-version record seeded the action high-water for a store the rest of
        // the system refuses to read. Found because the clean break made that stale
        // sentence checkable. The check is now here and the sentence is true.
        let mut edit_actions: Vec<u64> = Vec::with_capacity(raw_edits.len());
        for bytes in &raw_edits {
            let er: EditRecord = postcard::from_bytes(bytes)
                .map_err(|e| StoreError::Backend(format!("edit decode: {e}")))?;
            if fabrico_core::edit::check_version(er.schema_version).is_err() {
                return Err(StoreError::Backend(format!(
                    "edit schema_version {} is not the version this build reads \
                     ({EDIT_SCHEMA_VERSION})",
                    er.schema_version
                )));
            }
            edit_actions.push(er.action);
        }
        let next_action = next_high_water(edit_actions.into_iter(), "action")?;
        Ok(Self {
            engine: Engine::from_parts(core, next_seq, next_edit_seq, next_action),
            store,
            ledger,
            snapshot_every,
            seen: None,
        })
    }

    /// Borrow the [`Engine`] this host runs on.
    #[must_use]
    pub fn engine(&self) -> &Engine {
        &self.engine
    }

    /// Mutably borrow the [`Engine`] this host runs on.
    pub fn engine_mut(&mut self) -> &mut Engine {
        &mut self.engine
    }

    /// Install the tick-interval timer sources (in practice always
    /// `demo_scene::timers_from_log`, the edit-log projection - timers are
    /// per-host, installed strictly AFTER any scene seeding, never startup
    /// config; 20-review WR-04). A builder so [`Host::new`]'s signature — and the
    /// existing driver tests — stay unchanged for hosts with no timers.
    #[must_use]
    pub fn with_timers(mut self, timers: TimerSet) -> Self {
        self.engine.set_timers(timers);
        self
    }

    /// See [`Engine::set_timers`].
    pub fn set_timers(&mut self, timers: TimerSet) {
        self.engine.set_timers(timers);
    }

    /// See [`Engine::timers`].
    #[must_use]
    pub fn timers(&self) -> &TimerSet {
        self.engine.timers()
    }

    /// See [`Engine::set_timers_gated`].
    pub fn set_timers_gated(&mut self, gated: bool) {
        self.engine.set_timers_gated(gated);
    }

    /// Install the persisted webhook delivery-id dedup store (INGRESS-02). A
    /// builder so hosts without webhook ingress keep the unchanged constructor.
    #[must_use]
    pub fn with_seen_set(mut self, seen: SeenSet) -> Self {
        self.seen = Some(seen);
        self
    }

    /// Record a webhook delivery id in the persisted seen-set at the current
    /// tick, returning `true` if it is NEW (the caller should log its event) or
    /// `false` if it was already seen (a duplicate — drop it). This is the
    /// dedup-BEFORE-log decision (INGRESS-02): the record is committed durably
    /// before the event is appended, so a duplicate — even across a restart —
    /// yields exactly one logged event.
    ///
    /// With no seen-set configured every id is treated as new (no dedup).
    pub fn record_delivery(&mut self, delivery_id: &[u8]) -> Result<bool, StoreError> {
        let tick = self.engine.core().tick;
        match &mut self.seen {
            Some(seen) => seen.record(delivery_id, tick),
            None => Ok(true),
        }
    }

    /// See [`Engine::core`].
    #[must_use]
    pub fn core(&self) -> &Core {
        self.engine.core()
    }

    /// See [`Engine::core_mut`].
    pub fn core_mut(&mut self) -> &mut Core {
        self.engine.core_mut()
    }

    /// See [`Engine::session`].
    #[must_use]
    pub fn session(&self) -> &GridSession {
        self.engine.session()
    }

    /// See [`Engine::can_undo`].
    #[must_use]
    pub fn can_undo(&self) -> bool {
        self.engine.can_undo()
    }

    /// See [`Engine::can_redo`].
    #[must_use]
    pub fn can_redo(&self) -> bool {
        self.engine.can_redo()
    }

    /// See [`Engine::took_undo_redo_this_tick`].
    #[must_use]
    pub fn took_undo_redo_this_tick(&self) -> bool {
        self.engine.took_undo_redo_this_tick()
    }

    /// Borrow the durable dispatch ledger (recovery / inspection).
    #[must_use]
    pub fn ledger(&self) -> &DispatchLedger {
        &self.ledger
    }

    /// See [`Engine::enqueue_edit`].
    pub fn enqueue_edit(&mut self, record: EditRecord) {
        self.engine.enqueue_edit(record);
    }

    /// See [`Engine::enqueue_edit_with_new_action`].
    pub fn enqueue_edit_with_new_action(&mut self, record: EditRecord) {
        self.engine.enqueue_edit_with_new_action(record);
    }

    /// See [`Engine::seal_history`].
    pub fn seal_history(&mut self) {
        self.engine.seal_history();
    }

    /// See [`Engine::enqueue_action_group`].
    pub fn enqueue_action_group(&mut self, group: Vec<EditRecord>) {
        self.engine.enqueue_action_group(group);
    }

    /// See [`Engine::pending_edits`].
    #[must_use]
    pub fn pending_edits(&self) -> &[EditRecord] {
        self.engine.pending_edits()
    }

    /// See [`Engine::in_flight_len`].
    #[must_use]
    pub fn in_flight_len(&self) -> usize {
        self.engine.in_flight_len()
    }

    /// See [`Engine::belt_items_in_flight`].
    #[must_use]
    pub fn belt_items_in_flight(&self) -> usize {
        self.engine.belt_items_in_flight()
    }

    /// TEST-ONLY: seed a synthetic in-flight command so a test can drive the
    /// drain-to-quiescence Pause into its non-quiescent / stalled branches
    /// WITHOUT standing up a full Sink topology. A `deadline` of `u64::MAX`
    /// never times out (the tick-3 timeout synthesis needs `deadline <= tick`)
    /// and no result ever resolves it, so `in_flight_len()` stays non-zero —
    /// exactly the stalled drain the max-settle budget must backstop.
    #[cfg(test)]
    pub(crate) fn test_insert_in_flight(&mut self, id: CommandId, deadline: u64) {
        self.engine.insert_in_flight(id, deadline);
    }

    /// The whole-[`Core`] snapshot bytes — the state-equality oracle used to prove
    /// replay/recovery reproduces the live trajectory byte-for-byte.
    #[must_use]
    pub fn snapshot_bytes(&self) -> Vec<u8> {
        snapshot(self.engine.core())
    }

    /// The latest PERSISTED snapshot `(base_tick, bytes)` from the store, or
    /// `None` if no cadence/on-demand snapshot has been written yet. Additive,
    /// non-behavioral read surface — used by `save_project` to choose a replay
    /// base at `base_tick <= head_tick` (SAVE-01).
    pub fn latest_persisted_snapshot(&self) -> Result<Option<(u64, Vec<u8>)>, StoreError> {
        self.store.latest_snapshot()
    }

    /// Decode and return every event persisted in the log (partition 0), in fold
    /// order. The durable log is the source of truth; this is the read side used
    /// by recovery and by assertions over what was logged.
    pub fn logged_events(&self) -> Result<Vec<Event>, StoreError> {
        let raw = self.store.read_events(0, 0)?;
        let mut events = Vec::with_capacity(raw.len());
        for bytes in &raw {
            // The log is our own durable single-writer output; decode behind a
            // Result (never panic) and refuse a forward-versioned record, mirroring
            // the event-log trust-boundary discipline.
            let ev: Event = postcard::from_bytes(bytes)
                .map_err(|e| StoreError::Backend(format!("event decode: {e}")))?;
            if ev.schema_version > SCHEMA_VERSION {
                return Err(StoreError::Backend(format!(
                    "event schema_version {} exceeds readable {SCHEMA_VERSION}",
                    ev.schema_version
                )));
            }
            events.push(ev);
        }
        Ok(events)
    }

    /// Decode and return every edit persisted in the EDIT log (partition 0), in
    /// fold order (ELOG-01). Mirrors [`Host::logged_events`]: decodes behind a
    /// `Result` (never panics) and refuses a record whose `schema_version` is not
    /// EXACTLY the running [`EDIT_SCHEMA_VERSION`], newer or older. Used by recovery
    /// and edit-log assertions.
    ///
    /// This is ONE of the two edit-log decode boundaries a real caller reaches (the
    /// other is `crate::project::load_project`). `fabrico_core::edit::upcast` reads
    /// like the boundary and is not one: it has no production callers. All three sites
    /// share the single predicate [`fabrico_core::edit::check_version`] since Phase 63,
    /// and this one maps its answer into [`StoreError::Backend`].
    ///
    /// The refusal was forward-only through v6.0. Since the v8.0 clean break it is
    /// exact-match in both directions, so a store written by an earlier milestone is
    /// refused here rather than replayed against a layout it was not written for.
    ///
    /// Since plan 74.1-23 it also refuses a record whose port edit lies outside the
    /// envelope [`fabrico_core::edit::port_edit_in_envelope`] states (a captured seat's
    /// slot outside `[0, MAX_FOOTPRINT_DIM)`, a restore box out of range), naming the
    /// record's sequence: the same predicate `upcast` and `load_project` call.
    pub fn logged_edits(&self) -> Result<Vec<EditRecord>, StoreError> {
        let raw = self.store.read_edits(0, 0)?;
        let mut edits = Vec::with_capacity(raw.len());
        for bytes in &raw {
            let er: EditRecord = postcard::from_bytes(bytes)
                .map_err(|e| StoreError::Backend(format!("edit decode: {e}")))?;
            if fabrico_core::edit::check_version(er.schema_version).is_err() {
                return Err(StoreError::Backend(format!(
                    "edit schema_version {} is not the version this build reads \
                     ({EDIT_SCHEMA_VERSION})",
                    er.schema_version
                )));
            }
            // Plan 74.1-23 (review WR-02): the shared port-edit envelope, the one
            // `upcast` and `load_project` apply. A forged captured seat or restore box
            // would otherwise be folded VERBATIM by recover (Q2).
            if !fabrico_core::edit::port_edit_in_envelope(&er.op) {
                return Err(StoreError::Backend(format!(
                    "edit record at sequence {} carries a port edit outside the envelope \
                     this build accepts (a forged port slot or restore box)",
                    er.sequence
                )));
            }
            edits.push(er);
        }
        Ok(edits)
    }

    /// Run exactly one deterministic tick (see the module docs). Drains both channels with
    /// `try_recv`: it never `.await`s and never waits on the executor, so the sim advances
    /// using only the items already ready (EXEC-01: the grid never blocks).
    pub fn tick_once(
        &mut self,
        ingress_rx: &mut UnboundedReceiver<EventPayload>,
        results_rx: &mut UnboundedReceiver<ResultEvent>,
        cmd_tx: &UnboundedSender<Command>,
    ) -> Result<(), StoreError> {
        self.tick_with_dispatch(ingress_rx, results_rx, |cmd, _ledger| {
            // Unbounded send is sync-callable from the sim thread (no await).
            let _ = cmd_tx.send(cmd.clone());
        })
    }

    /// The body of [`Host::tick_once`], with the send handed in as `dispatch`. `tick_once` adds
    /// nothing to it but that send, and `tests/write_ahead_order.rs` holds it to that, so a test
    /// driving this function runs the path production runs and can look at the ledger from inside
    /// the dispatch closure.
    #[doc(hidden)]
    pub fn tick_with_dispatch(
        &mut self,
        ingress_rx: &mut UnboundedReceiver<EventPayload>,
        results_rx: &mut UnboundedReceiver<ResultEvent>,
        dispatch: impl FnMut(&Command, &DispatchLedger),
    ) -> Result<(), StoreError> {
        let mut ingress: Vec<EventPayload> = Vec::new();
        while let Ok(payload) = ingress_rx.try_recv() {
            ingress.push(payload);
        }
        let mut results: Vec<ResultEvent> = Vec::new();
        while let Ok(re) = results_rx.try_recv() {
            results.push(re);
        }
        let out = self.engine.step(ingress, results);
        self.finish_tick(out, dispatch)
    }

    /// Perform what one [`Engine::step`] returned, in the durable order: mark resolved
    /// commands done, append the events, append the edits, write each command ahead and
    /// dispatch it, then snapshot if due. `dispatch` runs once per command, after that
    /// command's `InFlight` row is durable, and gets the ledger so a test can check that.
    fn finish_tick(
        &mut self,
        out: StepOutput,
        mut dispatch: impl FnMut(&Command, &DispatchLedger),
    ) -> Result<(), StoreError> {
        for (command_id, outcome) in &out.resolved {
            self.ledger.mark_done(command_id, outcome)?;
        }

        for ev in &out.inbound {
            let bytes = postcard::to_allocvec(ev)
                .map_err(|e| StoreError::Backend(format!("event encode: {e}")))?;
            self.store.append_event(ev.partition, ev.sequence, &bytes)?;
        }

        for er in &out.stamped_edits {
            let bytes = postcard::to_allocvec(er)
                .map_err(|e| StoreError::Backend(format!("edit encode: {e}")))?;
            self.store.append_edit(er.partition, er.sequence, &bytes)?;
        }

        // Write-ahead each emitted command (durable InFlight) THEN dispatch it off-thread.
        // The InFlight marker is on disk before the effect can run (the exactly-once
        // write-ahead protocol).
        for cmd in &out.commands {
            self.ledger.before_dispatch(cmd)?;
            dispatch(cmd, &self.ledger);
        }

        // Periodic snapshot at the new tick boundary if the cadence is due.
        if snapshot_due(self.snapshot_every, self.engine.core().tick) {
            persist_snapshot(self.engine.core(), &mut self.store)?;
        }

        Ok(())
    }

    /// Crash recovery: rebuild [`Core`] from the latest snapshot + the persisted
    /// log with the executor MUTED, then reconcile the durable ledger so that no
    /// in-flight-without-result command is ever re-dispatched (EXEC-04).
    ///
    /// Returns the commands the muted replay re-emitted — the driver dispatches
    /// NONE of them (REPLAY-04). They are the same commands a live run produced;
    /// returning (rather than dispatching) them is the muting proof.
    ///
    /// Steps:
    /// 1. restore the latest snapshot (topology + tick + rng + cursor), or keep
    ///    the caller-rebuilt genesis topology if no snapshot exists yet;
    /// 2. `run_log` the persisted events to rebuild [`Core`] — dispatching nothing;
    /// 3. rebuild the in-flight set authoritatively from the durable ledger: every
    ///    `InFlight`-without-a-logged-result is reinstated with its deadline so it
    ///    resolves as a Timeout at its deadline tick — NEVER a re-send.
    ///
    /// # The replayed core passes the snapshot trust gate (plan 74.1-23)
    /// The body is [`recover_gated`](Self::recover_gated): the core the logs replay to
    /// must pass `fabrico_core::snapshot::restore`, the gate the next load applies,
    /// before any session is installed. A refusal comes back as a
    /// [`StoreError::Backend`] naming a replayed edit log refused by the snapshot gate,
    /// so a forged store whose records each pass decode (a restore box too small for
    /// the ports that survive) never becomes a running session the next load refuses.
    pub fn recover(&mut self) -> Result<Vec<Command>, StoreError> {
        self.recover_gated().map_err(|e| match e {
            RecoverError::Store(e) => e,
            RecoverError::ReplayStateInvalid(d) => StoreError::Backend(format!(
                "replayed edit log refused by the snapshot gate: the board it folds to \
                 breaks a grid rule ({d:?})"
            )),
        })
    }

    /// The body of [`recover`](Self::recover), with the post-replay trust gate's refusal
    /// as its own arm so `load_project` can map it to its own typed variant
    /// (`ProjectError::EditReplayStateInvalid`) rather than a `Store` string.
    ///
    /// # Why the gate runs here, on the replayed core
    /// The decode boundaries (`logged_edits`, `load_project`'s per-record loop, `upcast`)
    /// judge one record at a time and cannot see state: a `RemovePort{restore: Some}`
    /// whose box is inside the envelope yet too small for the ports that survive passes
    /// all of them. The replay is the one place the state exists. So immediately after
    /// `run_log_two_logs`, and before the session is rebuilt or anything is installed,
    /// the replayed core is put through `restore(&snapshot(&core))`: the gate's OWN
    /// rules, never a second copy, and a refusal is returned, never clamped, skipped or
    /// repaired. This is the replay-time twin of `load_project`'s
    /// `EditPortOutOfFootprint` refusal, which closed the same replay-versus-gate
    /// asymmetry for a `Place` (review WR-02).
    pub(crate) fn recover_gated(&mut self) -> Result<Vec<Command>, RecoverError> {
        let edits = self.logged_edits()?;
        let events = self.logged_events()?;

        // (1) Rebuild the CORE via the proven snapshot fast-path + two-log replay —
        //     byte-identical to the pre-session recover. Restore the latest snapshot
        //     (topology + advanced rng state) if one exists; else fold forward from
        //     the caller-rebuilt genesis topology already held in the session (the
        //     SC#2 path builds topology directly on the core, NOT via the edit-log,
        //     so it MUST be preserved — a bare from-genesis replay would lose it).
        let mut core = if let Some((_tick, bytes)) = self.store.latest_snapshot()? {
            restore(&bytes)
                .map_err(|_| StoreError::Backend("snapshot restore failed".to_owned()))?
        } else {
            // Take the caller-rebuilt core out of the session (a throwaway genesis
            // replaces it; the whole session is rebuilt in step 2 below).
            std::mem::replace(
                self.engine.core_mut(),
                Core::genesis(LogHeader {
                    schema_version: SCHEMA_VERSION,
                    seed: 0,
                }),
            )
        };

        // (2) Replay BOTH persisted logs MUTED into the fast-path core — rebuild it
        //     via the two-log driver (edits-first per tick), collect the emitted
        //     commands, dispatch NONE (REPLAY-04). The edit-log is folded ahead of
        //     the event-log at each tick exactly as the live `tick_once` does
        //     (ELOG-01).
        // Bounded replay (WR-02): a tampered on-disk log reaching recover() directly
        // (NOT via load_project's pre-flight guards) is refused as a typed StoreError
        // rather than hanging the idle-tick loop or overflowing the tick advance. The
        // engine-level MAX_REPLAY_SPAN / tick-overflow bound holds for this caller too.
        let emitted = core
            .run_log_two_logs(&edits, &events)
            .map_err(|e| StoreError::Backend(format!("replay rejected: {e}")))?;

        // (2a) Plan 74.1-23: the replayed core must pass the snapshot trust gate the
        //      next load applies, BEFORE the session is rebuilt or anything installed.
        //      See `recover_gated`'s docblock. The restored copy is discarded: only the
        //      verdict is wanted, and the replayed `core` stays the single authority.
        restore(&snapshot(&core)).map_err(RecoverError::ReplayStateInvalid)?;

        // (2b) Rebuild the SESSION (edit-log + undo/redo projection) from the
        //     persisted logs so undo history survives recover()/Load "for free" (the
        //     log IS the history). `GridSession::replay_two_logs`' projection is a
        //     pure, seed-independent fold of the edit-log; its own from-genesis core
        //     is discarded — we install the fast-path `core` above as the single
        //     authority, keeping determinism byte-identical while gaining the rebuilt
        //     undo stack. (The seed arg is immaterial: the projection is
        //     seed-independent and the core is overwritten. The session `view` is
        //     re-projected on the next `fold_live`; no host path reads it before then.)
        // Every node on a board this build writes or reads was minted by an edit-log
        // record, so the projection rebuild re-folds the edit log alone and its
        // throwaway core mints exactly the ids the real one did.
        self.engine.replace_session(GridSession::replay_two_logs(0, &edits, &events));
        *self.engine.core_mut() = core;
        // Keep the host sequences monotonic for any new (timeout) events / edits
        // appended after recovery resumes live ticking. CHECKED high-water + 1 (WR-03):
        // a hostile `.fab` carrying a record with `sequence == u64::MAX` passes every
        // `load_project` monotonic/version check yet would panic here on `+ 1` (debug)
        // or silently wrap to 0 (release) — and a wrap-to-0 re-hands `0,1,2,…` to live
        // appends, colliding keys that overwrite the source-of-truth log. Treat an
        // out-of-range high-water as a typed reject instead, consistent with the
        // reject-only untrusted-load contract.
        let next_seq = next_high_water(events.iter().map(|e| e.sequence), "event")?;
        let next_edit_seq = next_high_water(edits.iter().map(|e| e.sequence), "edit")?;
        // The action high-water (mirror the sequence marks): the next id the resumed
        // live path stamps, so a resume over a populated edit-log never reuses an
        // action id (RESEARCH Pitfall 1). CHECKED high-water (WR-03) — a tampered log
        // carrying `action == u64::MAX` is a typed reject, never a panic/wrap.
        let next_action = next_high_water(edits.iter().map(|e| e.action), "action")?;
        self.engine.set_counters(next_seq, next_edit_seq, next_action);

        // (3) Compute the resolved (logged result / timeout) command ids.
        let mut resolved: BTreeSet<CommandId> = BTreeSet::new();
        for ev in &events {
            match &ev.payload {
                EventPayload::CommandResult(re) => {
                    resolved.insert(re.command_id);
                }
                EventPayload::Timeout { command_id } => {
                    resolved.insert(*command_id);
                }
                _ => {}
            }
        }

        // (4) Rebuild in-flight authoritatively from the durable ledger. Every
        //     InFlight-without-result is at-most-once: reinstated with its deadline
        //     so it times out (never re-sends). The ledger is the durable source of
        //     "what is in flight" — snapshot-independent and exact.
        let recovery = self.ledger.recover(&resolved)?;
        self.engine.clear_in_flight();
        for (id, cmd) in &recovery.do_not_resend {
            self.engine.insert_in_flight(*id, cmd.deadline);
        }

        // (5) Reconcile the muted replay's emitted set against the ledger (WR-05).
        //     A command the replay re-emits that is NEITHER resolved in the log NOR
        //     present in the ledger (no InFlight/Done row) crashed in the single step
        //     between `core.advance` emitting it and `before_dispatch` committing its
        //     write-ahead marker. Its consumed item is folded into the recovered
        //     state, but with no ledger row it would be silently dropped — neither
        //     dispatched nor ever timed out (a lost action with no audit/fault).
        //     Re-write-ahead it and reinstate it into `in_flight` so it resolves as a
        //     deterministic Timeout (routing a fault) at its deadline tick. It is
        //     NEVER re-dispatched (at-most-once): reinstatement only schedules the
        //     timeout, it does not send the command to the executor.
        for cmd in &emitted {
            if resolved.contains(&cmd.id) || recovery.known.contains(&cmd.id) {
                continue;
            }
            self.ledger.before_dispatch(cmd)?;
            self.engine.insert_in_flight(cmd.id, cmd.deadline);
        }

        Ok(emitted)
    }
}

/// Why [`Host::recover_gated`] refused (plan 74.1-23): a store/replay failure, or the
/// snapshot trust gate refusing the core the replay folded to. Crate-private:
/// [`Host::recover`] folds the gate arm into a [`StoreError::Backend`], and
/// `load_project` maps it to `ProjectError::EditReplayStateInvalid`.
#[derive(Debug)]
pub(crate) enum RecoverError {
    /// A store, decode or replay failure, exactly what `recover` returned before.
    Store(StoreError),
    /// The replayed core breaks a rule the snapshot trust gate enforces.
    ReplayStateInvalid(DecodeError),
}

impl From<StoreError> for RecoverError {
    fn from(e: StoreError) -> Self {
        RecoverError::Store(e)
    }
}

/// The next free monotonic sequence above a log's high-water mark = `max(seq) + 1`,
/// or `0` for an empty log — with CHECKED arithmetic (WR-03).
///
/// A hostile `.fab` can carry a record whose `sequence == u64::MAX`; `load_project`
/// validates strictly-increasing keys and forward versions but does NOT bound the
/// sequence MAGNITUDE, so such a record reaches [`Host::recover`]. The naive
/// `max(seq) + 1` then panics (debug/overflow-checks) or silently wraps to `0`
/// (release) — and a wrap-to-0 re-hands `0,1,2,…` to subsequent live appends,
/// colliding `(partition, sequence)` keys that overwrite the durable log. Reject it
/// as a typed [`StoreError`] instead, honoring the "a hostile two-log save file must
/// NEVER panic" contract.
fn next_high_water(
    sequences: impl Iterator<Item = u64>,
    kind: &str,
) -> Result<u64, StoreError> {
    match sequences.max() {
        Some(max) => max.checked_add(1).ok_or_else(|| {
            StoreError::Backend(format!(
                "{kind} sequence high-water {max} + 1 overflows u64 (hostile/tampered log)"
            ))
        }),
        None => Ok(0),
    }
}
