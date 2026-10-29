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
//! 1. drain the ingress channel (`try_recv`) into this tick's inbound batch;
//! 2. drain the result channel (`try_recv`) — a result CLEARS its in-flight entry
//!    (drained BEFORE timeout synthesis, RESEARCH Pitfall 5, so an in-time result
//!    can never produce a spurious Timeout) and marks the ledger `Done`;
//! 3. synthesize a [`EventPayload::Timeout`] for every still-in-flight command
//!    whose `deadline <= tick`, iterating the in-flight `BTreeMap<CommandId>` in
//!    deterministic order;
//! 4. append EVERY inbound event (ingress + result + timeout) to the durable log,
//!    stamped with a monotonic `(partition, sequence)` and the current tick —
//!    NEVER a wall-clock value — BEFORE folding; then drain + stamp + append this
//!    tick's enqueued topology edits to the EDITS table (ELOG-01);
//! 5. fold one tick EDITS-FIRST:
//!    `core.advance_edits(&edits, &inbound) -> Vec<Command>` (the topology edits
//!    fold ahead of the events this tick);
//! 6. for each emitted command: write the durable `InFlight` ledger row (the
//!    write-ahead marker) THEN send it to the executor and track its deadline in
//!    the in-flight map;
//! 7. persist a snapshot if the cadence is due at the new tick boundary.
//!
//! # Single-writer invariant
//! The host loop is the ONE redb writer (the event log, the snapshots, and the
//! ledger). Concurrent executor tasks never touch redb — they only send
//! [`ResultEvent`]s back over a channel for the loop to drain, log, and mark
//! `Done`. This keeps the single-writer guarantee without a mutex.

use std::collections::{BTreeMap, BTreeSet};

use fabrico_command::GridSession;
use fabrico_core::command::{Command, ResultEvent};
use fabrico_core::core::Core;
use fabrico_core::edit::{EDIT_SCHEMA_VERSION, EditOp, EditRecord};
use fabrico_core::event::{DecodeError, Event, EventPayload, LogHeader, SCHEMA_VERSION};
use fabrico_core::ids::{CommandId, NodeId};
use fabrico_core::persist::{PersistenceStore, RedbStore, StoreError};
use fabrico_core::snapshot::{persist_snapshot, restore, snapshot, snapshot_due};
use fabrico_core::state::Node;
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender};

use crate::ingress::seen_set::SeenSet;
use crate::ingress::timer::TimerSet;
use crate::ledger::DispatchLedger;

/// The sync, single-thread driver: owns [`Core`], the redb event-log/snapshot
/// store (the single writer), the durable dispatch [`DispatchLedger`], and the
/// host-side in-flight set.
///
/// Per-command in-flight tracking is a [`BTreeMap<CommandId, u64>`] (command ->
/// deadline tick), NEVER a randomly-ordered hashed set, so that same-tick
/// host-synthesized timeouts are emitted in a deterministic order (EXEC-03).
pub struct Host {
    /// The single topology authority: the `fabrico-command` [`GridSession`] whose
    /// embedded [`Core`] is the deterministic sim (Phase 19 decision (c) Option B —
    /// no second core, no shadow). Owned by — and never moved off — the driver
    /// thread (the Core caches `!Send` rquickjs runtimes, so it is built on and
    /// stays on its owning thread). Reads delegate through [`Host::core`]
    /// (`session.core()`) so every existing reader (render_packet, sim_loop,
    /// demo_scene, project, tests) is unaffected; the tick-boundary EDITS-FIRST fold
    /// runs through [`GridSession::fold_live`] (certified `advance_edits` verbatim);
    /// live Undo/Redo route through [`GridSession::resolve_undo`]/`resolve_redo`.
    session: GridSession,
    /// The single redb writer for the append-only event log + periodic snapshots.
    store: RedbStore,
    /// The durable write-ahead dispatch ledger (the exactly-once backbone).
    ledger: DispatchLedger,
    /// Commands dispatched but not yet resolved, mapped to their deadline tick.
    /// A `BTreeMap` (not a hashed set) so the timeout-synthesis order is
    /// deterministic (EXEC-03 / threat T-05-06-DET-LOG).
    in_flight: BTreeMap<CommandId, u64>,
    /// Monotonic log sequence counter — the `(partition, sequence)` key the store
    /// orders by. Stamped onto every logged event; never derived from a clock.
    next_seq: u64,
    /// Monotonic EDIT-log sequence counter — the `(partition, sequence)` key the
    /// EDITS table orders by (ELOG-01). The host is the edit-sequence authority:
    /// every enqueued [`EditRecord`] is stamped with the next value here. Derived
    /// from the persisted edit-log high-water mark in [`Host::new`] (mirror
    /// `next_seq`), so resuming over a populated edit-log never overwrites it.
    next_edit_seq: u64,
    /// Monotonic EDIT-log ACTION (coalescing group) counter — the id
    /// `reconstruct_projection` groups an undo step by (command.rs). The host is the
    /// action authority on the LIVE path (GridSession's own `action` counter is only
    /// consumed inside its `apply`/`move`/`append_inverse_group`, none of which run
    /// live). One id per NORMAL gesture (via [`Host::enqueue_edit_with_new_action`]),
    /// ONE shared id across an undo/redo inverse group (via
    /// [`Host::enqueue_action_group`]). Derived from the persisted edit-log's action
    /// high-water mark in [`Host::new`] / [`Host::recover`], so a resume over a
    /// populated log never reuses an action id. WITHOUT this every record carries
    /// `action = 0` and `reconstruct_projection` groups the WHOLE log as one action —
    /// a single Ctrl+Z would clear the entire grid (RESEARCH Pitfall 1).
    next_action: u64,
    /// Periodic snapshot cadence (ticks). `None` => on-demand only.
    snapshot_every: Option<u64>,
    /// Tick-interval timer sources injected at the head of every tick. Empty by
    /// default; a pure function of the tick (no clock — SRC-03).
    timers: TimerSet,
    /// Whether timer ingress is currently HELD (no `timers` events appended by
    /// [`Host::tick_once`]). Defaults `false` (timers fire) so every direct
    /// `tick_once` caller is unaffected; flipped per tick by the sim loop via
    /// [`Host::set_timers_gated`] — Draining only (Finding 3).
    timers_gated: bool,
    /// The persisted webhook delivery-id dedup store (INGRESS-02). `None` => no
    /// webhook ingress on this host (the seed/timer paths are already trusted).
    /// When present, the host loop records a delivery id BEFORE logging its
    /// event — and the record is durable across a restart.
    seen: Option<SeenSet>,
    /// This tick's enqueued topology edits, in enqueue order — the edit-log batch
    /// the gesture producer fills (ELOG-01). The gesture PRODUCER (08-06) calls
    /// [`Host::enqueue_edit`]; [`Host::tick_once`] drains, stamps, persists, and
    /// folds them EDITS-FIRST before the event fold each tick.
    pending_edits: Vec<EditRecord>,
    /// Whether THIS tick's folded edit batch contained an `EditOp::Undo`/`EditOp::Redo`
    /// lineage marker — the keyframe-reset trigger (Plan 03, Open Q2: scan-the-batch,
    /// not a `fold_live` return flag). Reset at the top of every [`Host::tick_once`],
    /// set true when the stamped batch carries an undo/redo marker, and read via
    /// [`Host::took_undo_redo_this_tick`]. An undo/redo re-mints ids + cascade-restores
    /// belts, which a render DIFF cannot express — Plan 03 emits a full keyframe when
    /// this is true (RESEARCH Pitfall 3).
    undo_redo_this_tick: bool,
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
        // Wrap the pre-wired core in a GridSession (the single topology authority —
        // no second core, no shadow). GridSession::new(seed) builds its own genesis
        // core; we immediately swap in the caller's already-wired core via core_mut.
        // The session's internal `seed` is irrelevant on the live host path: its only
        // reader is `reconstruct_projection`, whose slotmap id harvest is documented
        // deterministic AND seed-independent (command.rs). recover()/load rebuild the
        // session from the persisted logs, installing the fast-path core as authority.
        let mut session = GridSession::new(0);
        *session.core_mut() = core;
        Ok(Self {
            session,
            store,
            ledger,
            in_flight: BTreeMap::new(),
            next_seq,
            next_edit_seq,
            next_action,
            snapshot_every,
            timers: TimerSet::default(),
            timers_gated: false,
            seen: None,
            pending_edits: Vec::new(),
            undo_redo_this_tick: false,
        })
    }

    /// Install the tick-interval timer sources (in practice always
    /// `demo_scene::timers_from_log`, the edit-log projection - timers are
    /// per-host, installed strictly AFTER any scene seeding, never startup
    /// config; 20-review WR-04). A builder so [`Host::new`]'s signature — and the
    /// existing driver tests — stay unchanged for hosts with no timers.
    #[must_use]
    pub fn with_timers(mut self, timers: TimerSet) -> Self {
        self.timers = timers;
        self
    }

    /// Swap the live tick-interval timer set (the mutable sibling of the build-once
    /// [`Host::with_timers`] builder). Phase 39's certified-config path re-projects
    /// the [`TimerSet`] from the edit-log on every `Configure` fold and on a
    /// host-swap (Load/LoadDemo) — mirroring the `project_routes` re-publish — and
    /// installs it here. The next [`Host::tick_once`] uses the new intervals; the
    /// schedule stays a pure function of the tick (no clock), so replay is identical.
    pub fn set_timers(&mut self, timers: TimerSet) {
        self.timers = timers;
    }

    /// The live tick-interval timer set (read side of [`Host::set_timers`]). The sim
    /// loop's route table reads it beside the core (DEMO-08): a Source with an entry
    /// here is on Timer and has no webhook door, and the panel's URL query answers
    /// `None` for it, so the door and the URL read ONE projection of the trigger.
    #[must_use]
    pub fn timers(&self) -> &TimerSet {
        &self.timers
    }

    /// Hold (`true`) or release (`false`) timer ingress for subsequent
    /// [`Host::tick_once`] calls (Finding 3). While gated, `tick_once` appends NO
    /// timer events — so a drain-to-quiescence Pause on a timer-driven scene can
    /// actually reach quiescence instead of burning the full max-settle budget
    /// (and a latched Save then hitting the NotQuiescent refusal).
    ///
    /// Gating changes ONLY which events get LOGGED: replay reads the log and
    /// never re-fires timers, so determinism and `step×N == live×N` (HOST-03) are
    /// decided by WHERE the loop flips this — that is [`SimLoop`]'s job
    /// (`tick_body` sets it from `run_state == Draining` ONLY; Playing and Step
    /// both run ungated).
    ///
    /// [`SimLoop`]: crate::sim_loop::SimLoop
    pub fn set_timers_gated(&mut self, gated: bool) {
        self.timers_gated = gated;
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
        let tick = self.session.core().tick;
        match &mut self.seen {
            Some(seen) => seen.record(delivery_id, tick),
            None => Ok(true),
        }
    }

    /// Borrow the underlying [`Core`] (state inspection / topology assertions).
    /// Delegates to the single [`GridSession`] authority so every existing reader
    /// (render_packet, sim_loop, demo_scene, project, tests) is unchanged.
    #[must_use]
    pub fn core(&self) -> &Core {
        self.session.core()
    }

    /// Mutably borrow the underlying [`Core`] (topology construction in tests /
    /// the shell before the loop starts). A demo/test backdoor that BYPASSES the
    /// edit-log / undo projection (demo_scene.rs, transport_ws.rs, render_packet.rs
    /// tests); production topology writes go through [`Host::tick_once`]'s
    /// [`GridSession::fold_live`]. Delegates to [`GridSession::core_mut`].
    pub fn core_mut(&mut self) -> &mut Core {
        self.session.core_mut()
    }

    /// Borrow the single [`GridSession`] topology authority — the read surface the
    /// gesture adapter uses to route live Undo/Redo through
    /// [`GridSession::resolve_undo`]/`resolve_redo` and the availability passthroughs
    /// [`Host::can_undo`]/[`Host::can_redo`] read.
    #[must_use]
    pub fn session(&self) -> &GridSession {
        &self.session
    }

    /// Whether a live Undo is currently available (passthrough to
    /// [`GridSession::can_undo`] — the availability signal Plan 03 ships on every
    /// render packet).
    #[must_use]
    pub fn can_undo(&self) -> bool {
        self.session.can_undo()
    }

    /// Whether a live Redo is currently available (passthrough to
    /// [`GridSession::can_redo`]).
    #[must_use]
    pub fn can_redo(&self) -> bool {
        self.session.can_redo()
    }

    /// Whether THIS tick's folded edit batch contained an `EditOp::Undo`/`EditOp::Redo`
    /// lineage marker — the keyframe-reset trigger (Plan 03). Valid AFTER
    /// [`Host::tick_once`] returns for the tick just folded; reset to `false` at the
    /// top of the next tick. Plan 03 reads this to emit a full render keyframe
    /// (re-minted ids + cascade-restored belts cannot be expressed as a diff —
    /// RESEARCH Pitfall 3).
    #[must_use]
    pub fn took_undo_redo_this_tick(&self) -> bool {
        self.undo_redo_this_tick
    }

    /// Borrow the durable dispatch ledger (recovery / inspection).
    #[must_use]
    pub fn ledger(&self) -> &DispatchLedger {
        &self.ledger
    }

    /// Buffer a topology [`EditRecord`] for this tick, in enqueue order (ELOG-01).
    /// The gesture producer (08-06) calls this; [`Host::tick_once`] drains, stamps
    /// (partition + tick + monotonic edit-sequence), persists, and folds the buffer
    /// EDITS-FIRST. The record's `op`/`action` ride from the producer; the host
    /// overwrites the `partition`/`sequence`/`tick` provenance on stamp.
    pub fn enqueue_edit(&mut self, record: EditRecord) {
        self.pending_edits.push(record);
    }

    /// Buffer ONE normal-gesture [`EditRecord`], stamping it with a FRESH action id
    /// (its own undo step). The action is stamped at ENQUEUE time (Pattern 3) —
    /// `stamp_edit` at fold time preserves `op`/`action` and only overwrites
    /// `partition`/`sequence`/`tick`. Every live normal gesture (Place/Delete/
    /// Rotate/DrawBelt/Dock) rides this instead of the bare [`Host::enqueue_edit`],
    /// so `reconstruct_projection` sees one action per gesture (RESEARCH Pitfall 1).
    pub fn enqueue_edit_with_new_action(&mut self, mut record: EditRecord) {
        record.action = self.next_action;
        self.next_action += 1;
        self.enqueue_edit(record);
    }

    /// Buffer the HISTORY SEAL (plan 85-06, D-10, DEMO-05): one
    /// [`EditOp::SealHistory`] record under a fresh action id, folded on the next
    /// [`Host::tick_once`]. Once folded, everything logged before it sits below the undo
    /// floor (`GridSession::undo_floor`), so [`Host::can_undo`] is false and an Undo
    /// resolves to `NothingToUndo` until the user makes an edit of their own.
    ///
    /// `demo_scene::seed_scene` is the ONE caller outside tests: it seals after a scene's
    /// last command, so the demo at boot, every example on `LoadScene` and the dev server
    /// all get their floor from the same place. Nothing else seals on its own; a user's
    /// board and a reopened `.fab` carry exactly the seals their log already holds.
    pub fn seal_history(&mut self) {
        self.enqueue_edit_with_new_action(EditRecord {
            schema_version: EDIT_SCHEMA_VERSION,
            partition: 0,
            sequence: 0,
            tick: 0,
            action: 0,
            op: EditOp::SealHistory,
        });
    }

    /// Buffer an undo/redo inverse group under ONE SHARED action id, in order — so the
    /// whole compensating group (the `EditOp::Undo`/`Redo` lineage marker + its
    /// retargeted inverse Place/Delete records) is a SINGLE undo step, exactly as the
    /// headless `GridSession::append_inverse_group` coalesces it. The records arrive
    /// UNSTAMPED from [`GridSession::resolve_undo`]/`resolve_redo`; this stamps only
    /// `action` (the host stamps `partition`/`sequence`/`tick` at fold via
    /// `stamp_edit`). An empty group leaves `next_action` untouched (no wasted id).
    pub fn enqueue_action_group(&mut self, group: Vec<EditRecord>) {
        if group.is_empty() {
            return;
        }
        let action = self.next_action;
        self.next_action += 1;
        for mut record in group {
            record.action = action;
            self.enqueue_edit(record);
        }
    }

    /// This tick's enqueued-but-not-yet-folded topology edits, in enqueue order
    /// (WR-01). The host gesture adapter (`input_apply`) consults the `EditOp::Place`
    /// cells here so a second same-tick same-cell `Place` sees the first's cell
    /// BEFORE the core folds it (the core occupancy index only reflects PRIOR ticks
    /// until `tick_once` folds this tick's edits EDITS-FIRST). Sourcing the same-tick
    /// occupancy from this single buffer — instead of a parallel per-cell sidecar —
    /// keeps `core.state` plus this buffer the only occupancy authorities,
    /// collapsing the WR-01 TOCTOU structurally (SPAT-01).
    #[must_use]
    pub fn pending_edits(&self) -> &[EditRecord] {
        &self.pending_edits
    }

    /// The number of commands currently tracked as in-flight (dispatched, not yet
    /// resolved by a result or a synthesized timeout).
    #[must_use]
    pub fn in_flight_len(&self) -> usize {
        self.in_flight.len()
    }

    /// The total number of items currently resting in belt slots across the
    /// whole grid — the belt half of "quiescence" (the executor half is
    /// [`in_flight_len`](Self::in_flight_len)). A pure passthrough to
    /// [`GridState::belt_items_in_flight`](fabrico_core::state::GridState::belt_items_in_flight),
    /// mirroring `in_flight_len`. The sim has drained its belts when this
    /// reaches `0`; the drain-to-quiescence Pause freezes only when BOTH this
    /// and `in_flight_len()` are `0` (or the bounded settle budget is spent).
    #[must_use]
    pub fn belt_items_in_flight(&self) -> usize {
        self.session.core().state.belt_items_in_flight()
    }

    /// TEST-ONLY: seed a synthetic in-flight command so a test can drive the
    /// drain-to-quiescence Pause into its non-quiescent / stalled branches
    /// WITHOUT standing up a full Sink topology. A `deadline` of `u64::MAX`
    /// never times out (the tick-3 timeout synthesis needs `deadline <= tick`)
    /// and no result ever resolves it, so `in_flight_len()` stays non-zero —
    /// exactly the stalled drain the max-settle budget must backstop.
    #[cfg(test)]
    pub(crate) fn test_insert_in_flight(&mut self, id: CommandId, deadline: u64) {
        self.in_flight.insert(id, deadline);
    }

    /// The whole-[`Core`] snapshot bytes — the state-equality oracle used to prove
    /// replay/recovery reproduces the live trajectory byte-for-byte.
    #[must_use]
    pub fn snapshot_bytes(&self) -> Vec<u8> {
        snapshot(self.session.core())
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

    /// Stamp an enqueued [`EditRecord`] with the current tick and the next monotonic
    /// edit-sequence (mirror [`Host::stamp`]). The host owns the edit-log
    /// `(partition, sequence, tick)` provenance — integer logged data, NEVER a
    /// wall-clock read; the producer's `op`/`action`/`schema_version` are preserved.
    fn stamp_edit(&mut self, tick: u64, mut record: EditRecord) -> EditRecord {
        let sequence = self.next_edit_seq;
        self.next_edit_seq += 1;
        record.schema_version = EDIT_SCHEMA_VERSION;
        record.partition = 0;
        record.sequence = sequence;
        record.tick = tick;
        record
    }

    /// Stamp a payload into a logged [`Event`] at the current tick with the next
    /// monotonic sequence. The sequence + tick are integer, logged data — NEVER a
    /// wall-clock read (threat T-05-06-DET-LOG).
    fn stamp(&mut self, tick: u64, payload: EventPayload) -> Event {
        let sequence = self.next_seq;
        self.next_seq += 1;
        Event {
            schema_version: SCHEMA_VERSION,
            partition: 0,
            sequence,
            tick,
            payload,
        }
    }

    /// Run exactly one deterministic tick in the fixed 7-step order (see the
    /// module docs). Drains both channels with `try_recv` — it never `.await`s and
    /// never waits on the executor, so the sim advances using only the items
    /// already ready (EXEC-01: the grid never blocks).
    pub fn tick_once(
        &mut self,
        ingress_rx: &mut UnboundedReceiver<EventPayload>,
        results_rx: &mut UnboundedReceiver<ResultEvent>,
        cmd_tx: &UnboundedSender<Command>,
    ) -> Result<(), StoreError> {
        let tick = self.session.core().tick;
        let mut inbound: Vec<Event> = Vec::new();
        // Reset the per-tick undo/redo keyframe signal; set true below if this tick's
        // folded edit batch carries an Undo/Redo lineage marker (Plan 03 trigger).
        self.undo_redo_this_tick = false;

        // (1a) Tick-interval timer sources (SRC-03): a pure function of the tick,
        //      no clock. Each due timer contributes one logged ManualInject event
        //      at the head of this tick's inbound batch, stamped with the next
        //      monotonic sequence (disjoint field borrows: &self.timers + &mut
        //      self.next_seq), then appended + folded like any other inbound event.
        //      HELD while gated (Finding 3): the sim loop gates timer ingress
        //      during the Draining drain-to-quiescence ONLY, so a Pause on a
        //      timer-driven scene can settle instead of being re-fed every tick.
        //
        //      A FIRE ITS SOURCE WOULD REFUSE IS NOT LOGGED (phase 87, JAM-04, plan
        //      87-07). The predicate is the core's own refusal, `source_accepts_one`,
        //      read on the core's state at the head of this tick, before anything is
        //      folded: the fold's `ManualInject` admit arm refuses that event silently
        //      (no item, no fault, no wake), so leaving it out of the log changes
        //      nothing the board does; only `Core::cursor`, the count of events
        //      folded, counts one fewer, and replay reads the log alone, so the live
        //      host and any replay of its log still agree byte for byte. Without it a
        //      Timer Source behind a jam logged one refused event per interval forever
        //      and the save of a board jammed solid grew without bound. A target that
        //      is not a Source is accepted exactly as before (the fold drops it on its
        //      own terms). Only the host's own timer is skipped: webhook ingress in
        //      (1b) below is the user's input and is always logged.
        if !self.timers_gated {
            let core = self.session.core();
            let accepts = |target: NodeId| match core.state.node(target) {
                Some(Node::Source(source)) => fabrico_core::admit::source_accepts_one(source),
                _ => true,
            };
            inbound.extend(self.timers.due_events(tick, &mut self.next_seq, accepts));
        }

        // (1b) Drain ingress — non-blocking; only the items already queued.
        while let Ok(payload) = ingress_rx.try_recv() {
            inbound.push(self.stamp(tick, payload));
        }

        // (2) Drain results — non-blocking. A result CLEARS its in-flight entry
        //     (drained BEFORE timeout synthesis, Pitfall 5) and marks the ledger
        //     Done, then re-enters the fold as a logged CommandResult.
        while let Ok(mut re) = results_rx.try_recv() {
            // At-most-once resolution (CR-01): only a command STILL in-flight may be
            // resolved. A result arriving on a LATER tick than its deadline — the
            // command already timed out (step 3 removed it from `in_flight` and
            // logged a Timeout) — is dropped here. Without this gate the log would
            // carry BOTH a Timeout AND a CommandResult for one CommandId, folding two
            // resolutions (a double dead-letter/retry that can fire the same
            // real-world action twice). The invariant is one Timeout XOR one
            // CommandResult per command, never both.
            if self.in_flight.remove(&re.command_id).is_none() {
                continue;
            }
            re.tick = tick; // stamp the admit tick (host owns it; the executor sends 0)
            self.ledger.mark_done(&re.command_id, &re.outcome)?;
            inbound.push(self.stamp(tick, EventPayload::CommandResult(re)));
        }

        // (3) Synthesize timeouts for still-in-flight commands past their deadline,
        //     iterating the in-flight BTreeMap in deterministic CommandId order so
        //     same-tick host-synthesized timeouts have a stable total order.
        let mut timed_out: Vec<CommandId> = Vec::new();
        for (id, &deadline) in &self.in_flight {
            if deadline <= tick {
                timed_out.push(*id);
            }
        }
        for command_id in timed_out {
            self.in_flight.remove(&command_id);
            inbound.push(self.stamp(tick, EventPayload::Timeout { command_id }));
        }

        // (4) Append EVERY inbound event to the durable log BEFORE folding.
        for ev in &inbound {
            let bytes = postcard::to_allocvec(ev)
                .map_err(|e| StoreError::Backend(format!("event encode: {e}")))?;
            self.store.append_event(ev.partition, ev.sequence, &bytes)?;
        }

        // (4b) Drain this tick's enqueued topology edits, stamp each (partition 0,
        //      the current tick, the next monotonic edit-sequence — the host is the
        //      edit-sequence authority), and append each to the EDITS table BEFORE
        //      folding (ELOG-01). The buffer is the edit-log mirror of the inbound
        //      event batch; the gesture producer (08-06) fills it via enqueue_edit.
        let pending = std::mem::take(&mut self.pending_edits);
        let mut stamped_edits: Vec<EditRecord> = Vec::with_capacity(pending.len());
        for record in pending {
            let er = self.stamp_edit(tick, record);
            let bytes = postcard::to_allocvec(&er)
                .map_err(|e| StoreError::Backend(format!("edit encode: {e}")))?;
            self.store.append_edit(er.partition, er.sequence, &bytes)?;
            stamped_edits.push(er);
        }
        // Surface the undo/redo keyframe signal (Plan 03): true iff this tick's folded
        // batch carries an `EditOp::Undo`/`EditOp::Redo` lineage marker (the markers
        // are fold no-ops; the compensating Place/Delete records do the real work).
        self.undo_redo_this_tick = stamped_edits
            .iter()
            .any(|er| matches!(er.op, EditOp::Undo { .. } | EditOp::Redo { .. }));

        // (5) Fold one tick -> the command intent emitted this tick. EDITS-FIRST:
        //     this tick's stamped topology edits fold ahead of its events, so a
        //     placed/wired/deleted node takes effect before the events admit. The
        //     fold runs through GridSession::fold_live, which calls the CERTIFIED
        //     Core::advance_edits VERBATIM (EDITS-FIRST), advances the event cursor
        //     (`cursor += events.len()`, mirroring the old in-line accounting so a
        //     snapshot of the live trajectory stays byte-identical to its replay),
        //     appends the host-stamped records to the session edit-log as-is (no
        //     re-stamp — the host is the partition/sequence/tick/action authority),
        //     and rebuilds the view + undo/redo projection. HOST-03 and the
        //     persisted-log invariants are preserved (advance_edits is untouched).
        let cmds = self.session.fold_live(&stamped_edits, &inbound);

        // (6) Write-ahead each emitted command (durable InFlight) THEN dispatch it
        //     off-thread and track its deadline. The InFlight marker is on disk
        //     before the effect can run (the exactly-once write-ahead protocol).
        for cmd in &cmds {
            self.ledger.before_dispatch(cmd)?;
            // Unbounded send is sync-callable from the sim thread (no await).
            let _ = cmd_tx.send(cmd.clone());
            self.in_flight.insert(cmd.id, cmd.deadline);
        }

        // (7) Periodic snapshot at the new tick boundary if the cadence is due.
        if snapshot_due(self.snapshot_every, self.session.core().tick) {
            persist_snapshot(self.session.core(), &mut self.store)?;
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
                self.session.core_mut(),
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
        self.session = GridSession::replay_two_logs(0, &edits, &events);
        *self.session.core_mut() = core;
        // Keep the host sequences monotonic for any new (timeout) events / edits
        // appended after recovery resumes live ticking. CHECKED high-water + 1 (WR-03):
        // a hostile `.fab` carrying a record with `sequence == u64::MAX` passes every
        // `load_project` monotonic/version check yet would panic here on `+ 1` (debug)
        // or silently wrap to 0 (release) — and a wrap-to-0 re-hands `0,1,2,…` to live
        // appends, colliding keys that overwrite the source-of-truth log. Treat an
        // out-of-range high-water as a typed reject instead, consistent with the
        // reject-only untrusted-load contract.
        self.next_seq = next_high_water(events.iter().map(|e| e.sequence), "event")?;
        self.next_edit_seq = next_high_water(edits.iter().map(|e| e.sequence), "edit")?;
        // The action high-water (mirror the sequence marks): the next id the resumed
        // live path stamps, so a resume over a populated edit-log never reuses an
        // action id (RESEARCH Pitfall 1). CHECKED high-water (WR-03) — a tampered log
        // carrying `action == u64::MAX` is a typed reject, never a panic/wrap.
        self.next_action = next_high_water(edits.iter().map(|e| e.action), "action")?;

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
        self.in_flight.clear();
        for (id, cmd) in &recovery.do_not_resend {
            self.in_flight.insert(*id, cmd.deadline);
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
            self.in_flight.insert(cmd.id, cmd.deadline);
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
