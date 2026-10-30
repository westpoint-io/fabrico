//! The one per-tick loop body, with no I/O.
//!
//! [`Engine::step`] takes a tick's inputs as plain data, folds them on the deterministic core
//! and returns what must be written and dispatched as a [`StepOutput`]. It touches no store, no
//! ledger and no channel, so it runs anywhere the core runs. The desktop host drains its
//! channels, calls `step`, then performs the writes and sends. Anything else that runs a board
//! calls the same function, so there is only one tick loop.
//!
//! # The order inside [`Engine::step`]
//! 1. reset the undo/redo signal and read the tick from the core;
//! 2. timers, unless gated, with the accept check read on the core before anything folds;
//! 3. stamp ingress, in the order given;
//! 4. results, in the order given: a result whose command is no longer in flight is dropped;
//! 5. timeouts for commands whose deadline has passed, in [`CommandId`] order;
//! 6. stamp this tick's enqueued edits and set the undo/redo signal from them;
//! 7. fold, edits first;
//! 8. record each emitted command as in flight.
//!
//! A tick hash depends on this order, and `crates/fabrico-host/tests/host_parity.rs` compares
//! the hashes against a recording made before this code moved here.

use std::collections::BTreeMap;

use fabrico_command::GridSession;
use fabrico_core::command::{Command, Outcome, ResultEvent};
use fabrico_core::core::Core;
use fabrico_core::edit::{EDIT_SCHEMA_VERSION, EditOp, EditRecord};
use fabrico_core::event::{Event, EventPayload, SCHEMA_VERSION};
use fabrico_core::ids::{CommandId, NodeId};
use fabrico_core::state::Node;

use crate::timer::TimerSet;

/// What one [`Engine::step`] needs the caller to do. The fields are in the order a durable
/// host acts on them: mark `resolved` done, append `inbound`, append `stamped_edits`, then
/// write ahead and dispatch each of `commands`.
#[derive(Debug)]
pub struct StepOutput {
    /// Every event folded this tick, stamped, in fold order.
    pub inbound: Vec<Event>,
    /// Every edit folded this tick, stamped, in fold order.
    pub stamped_edits: Vec<EditRecord>,
    /// The commands a result resolved this tick, with their outcomes.
    pub resolved: Vec<(CommandId, Outcome)>,
    /// The commands this tick's fold emitted. They are already recorded as in flight.
    pub commands: Vec<Command>,
    /// Whether any edit folded this tick. A caller that keeps timers projected from the edit
    /// log re-projects when this is true.
    pub edits_folded: bool,
}

/// The deterministic session plus everything a tick needs that is not durable: the in-flight
/// set, the log counters, the timers and this tick's enqueued edits.
pub struct Engine {
    /// The single topology authority: the `fabrico-command` [`GridSession`] whose
    /// embedded [`Core`] is the deterministic sim (Phase 19 decision (c) Option B —
    /// no second core, no shadow). Owned by — and never moved off — the driver
    /// thread (the Core caches `!Send` rquickjs runtimes, so it is built on and
    /// stays on its owning thread). Reads delegate through [`Engine::core`]
    /// (`session.core()`) so every existing reader (render_packet, sim_loop,
    /// demo_scene, project, tests) is unaffected; the tick-boundary EDITS-FIRST fold
    /// runs through [`GridSession::fold_live`] (certified `advance_edits` verbatim);
    /// live Undo/Redo route through [`GridSession::resolve_undo`]/`resolve_redo`.
    session: GridSession,
    /// Commands dispatched but not yet resolved, mapped to their deadline tick.
    /// A `BTreeMap` (not a hashed set) so the timeout-synthesis order is
    /// deterministic (EXEC-03 / threat T-05-06-DET-LOG).
    in_flight: BTreeMap<CommandId, u64>,
    /// Monotonic log sequence counter — the `(partition, sequence)` key the store
    /// orders by. Stamped onto every logged event; never derived from a clock.
    next_seq: u64,
    /// Monotonic EDIT-log sequence counter — the `(partition, sequence)` key the
    /// EDITS table orders by (ELOG-01). The host is the edit-sequence authority:
    /// every enqueued [`EditRecord`] is stamped with the next value here. The host
    /// derives it from the persisted edit-log high-water mark and passes it to
    /// [`Engine::from_parts`] (mirror `next_seq`), so resuming over a populated
    /// edit-log never overwrites it.
    next_edit_seq: u64,
    /// Monotonic EDIT-log ACTION (coalescing group) counter — the id
    /// `reconstruct_projection` groups an undo step by (command.rs). The host is the
    /// action authority on the LIVE path (GridSession's own `action` counter is only
    /// consumed inside its `apply`/`move`/`append_inverse_group`, none of which run
    /// live). One id per NORMAL gesture (via [`Engine::enqueue_edit_with_new_action`]),
    /// ONE shared id across an undo/redo inverse group (via
    /// [`Engine::enqueue_action_group`]). The host derives it from the persisted edit-log's
    /// action high-water mark when it builds or recovers the engine, so a resume over a
    /// populated log never reuses an action id. WITHOUT this every record carries
    /// `action = 0` and `reconstruct_projection` groups the WHOLE log as one action —
    /// a single Ctrl+Z would clear the entire grid (RESEARCH Pitfall 1).
    next_action: u64,
    /// Tick-interval timer sources injected at the head of every tick. Empty by
    /// default; a pure function of the tick (no clock — SRC-03).
    timers: TimerSet,
    /// Whether timer ingress is currently HELD (no `timers` events appended by
    /// [`Engine::step`]). Defaults `false` (timers fire) so every direct
    /// `step` caller is unaffected; flipped per tick by the sim loop via
    /// [`Engine::set_timers_gated`] — Draining only (Finding 3).
    timers_gated: bool,
    /// This tick's enqueued topology edits, in enqueue order — the edit-log batch
    /// the gesture producer fills (ELOG-01). The gesture PRODUCER (08-06) calls
    /// [`Engine::enqueue_edit`]; [`Engine::step`] drains, stamps, persists, and
    /// folds them EDITS-FIRST before the event fold each tick.
    pending_edits: Vec<EditRecord>,
    /// Whether THIS tick's folded edit batch contained an `EditOp::Undo`/`EditOp::Redo`
    /// lineage marker — the keyframe-reset trigger (Plan 03, Open Q2: scan-the-batch,
    /// not a `fold_live` return flag). Reset at the top of every [`Engine::step`],
    /// set true when the stamped batch carries an undo/redo marker, and read via
    /// [`Engine::took_undo_redo_this_tick`]. An undo/redo re-mints ids + cascade-restores
    /// belts, which a render DIFF cannot express — Plan 03 emits a full keyframe when
    /// this is true (RESEARCH Pitfall 3).
    undo_redo_this_tick: bool,
}

impl Engine {
    /// Build an engine around a pre-wired [`Core`], with zero counters and no timers.
    #[must_use]
    pub fn from_core(core: Core) -> Self {
        Self::from_parts(core, 0, 0, 0)
    }

    /// Build an engine around a pre-wired [`Core`], resuming the three log counters. A host
    /// over a populated store passes the high-water marks it read from that store.
    #[must_use]
    pub fn from_parts(core: Core, next_seq: u64, next_edit_seq: u64, next_action: u64) -> Self {
        // Wrap the pre-wired core in a GridSession (the single topology authority —
        // no second core, no shadow). GridSession::new(seed) builds its own genesis
        // core; we immediately swap in the caller's already-wired core via core_mut.
        // The session's internal `seed` is irrelevant on the live host path: its only
        // reader is `reconstruct_projection`, whose slotmap id harvest is documented
        // deterministic AND seed-independent (command.rs). recover()/load rebuild the
        // session from the persisted logs, installing the fast-path core as authority.
        let mut session = GridSession::new(0);
        *session.core_mut() = core;
        Self {
            session,
            in_flight: BTreeMap::new(),
            next_seq,
            next_edit_seq,
            next_action,
            timers: TimerSet::default(),
            timers_gated: false,
            pending_edits: Vec::new(),
            undo_redo_this_tick: false,
        }
    }

    /// Swap the live tick-interval timer set (the mutable sibling of the host's build-once
    /// `with_timers` builder). Phase 39's certified-config path re-projects
    /// the [`TimerSet`] from the edit-log on every `Configure` fold and on a
    /// host-swap (Load/LoadDemo) — mirroring the `project_routes` re-publish — and
    /// installs it here. The next [`Engine::step`] uses the new intervals; the
    /// schedule stays a pure function of the tick (no clock), so replay is identical.
    pub fn set_timers(&mut self, timers: TimerSet) {
        self.timers = timers;
    }

    /// The live tick-interval timer set (read side of [`Engine::set_timers`]). The sim
    /// loop's route table reads it beside the core (DEMO-08): a Source with an entry
    /// here is on Timer and has no webhook door, and the panel's URL query answers
    /// `None` for it, so the door and the URL read ONE projection of the trigger.
    #[must_use]
    pub fn timers(&self) -> &TimerSet {
        &self.timers
    }

    /// Hold (`true`) or release (`false`) timer ingress for subsequent
    /// [`Engine::step`] calls (Finding 3). While gated, `step` appends NO
    /// timer events — so a drain-to-quiescence Pause on a timer-driven scene can
    /// actually reach quiescence instead of burning the full max-settle budget
    /// (and a latched Save then hitting the NotQuiescent refusal).
    ///
    /// Gating changes ONLY which events get LOGGED: replay reads the log and
    /// never re-fires timers, so determinism and `step×N == live×N` (HOST-03) are
    /// decided by WHERE the loop flips this — that is the host sim loop's job
    /// (`tick_body` sets it from `run_state == Draining` ONLY; Playing and Step
    /// both run ungated).
    pub fn set_timers_gated(&mut self, gated: bool) {
        self.timers_gated = gated;
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
    /// tests); production topology writes go through [`Engine::step`]'s
    /// [`GridSession::fold_live`]. Delegates to [`GridSession::core_mut`].
    pub fn core_mut(&mut self) -> &mut Core {
        self.session.core_mut()
    }

    /// Borrow the single [`GridSession`] topology authority — the read surface the
    /// gesture adapter uses to route live Undo/Redo through
    /// [`GridSession::resolve_undo`]/`resolve_redo` and the availability passthroughs
    /// [`Engine::can_undo`]/[`Engine::can_redo`] read.
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
    /// [`Engine::step`] returns for the tick just folded; reset to `false` at the
    /// top of the next tick. Plan 03 reads this to emit a full render keyframe
    /// (re-minted ids + cascade-restored belts cannot be expressed as a diff —
    /// RESEARCH Pitfall 3).
    #[must_use]
    pub fn took_undo_redo_this_tick(&self) -> bool {
        self.undo_redo_this_tick
    }

    /// Buffer a topology [`EditRecord`] for this tick, in enqueue order (ELOG-01).
    /// The gesture producer (08-06) calls this; [`Engine::step`] drains, stamps
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
    /// Rotate/DrawBelt/Dock) rides this instead of the bare [`Engine::enqueue_edit`],
    /// so `reconstruct_projection` sees one action per gesture (RESEARCH Pitfall 1).
    pub fn enqueue_edit_with_new_action(&mut self, mut record: EditRecord) {
        record.action = self.next_action;
        self.next_action += 1;
        self.enqueue_edit(record);
    }

    /// Buffer the HISTORY SEAL (plan 85-06, D-10, DEMO-05): one
    /// [`EditOp::SealHistory`] record under a fresh action id, folded on the next
    /// [`Engine::step`]. Once folded, everything logged before it sits below the undo
    /// floor (`GridSession::undo_floor`), so [`Engine::can_undo`] is false and an Undo
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
    /// until `step` folds this tick's edits EDITS-FIRST). Sourcing the same-tick
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

    /// Replace the whole session. Crash recovery rebuilds it from the persisted logs.
    pub fn replace_session(&mut self, session: GridSession) {
        self.session = session;
    }

    /// Set the three log counters. Crash recovery sets them from the replayed logs.
    pub fn set_counters(&mut self, next_seq: u64, next_edit_seq: u64, next_action: u64) {
        self.next_seq = next_seq;
        self.next_edit_seq = next_edit_seq;
        self.next_action = next_action;
    }

    /// Forget every in-flight command. Crash recovery clears the set before rebuilding it from
    /// the durable ledger.
    pub fn clear_in_flight(&mut self) {
        self.in_flight.clear();
    }

    /// Record a command as in flight without it having been emitted. Crash recovery reinstates
    /// commands through this, so they time out at their deadline and never re-send. Tests use it
    /// to hold a drain open: a `deadline` of `u64::MAX` never times out.
    #[doc(hidden)]
    pub fn insert_in_flight(&mut self, id: CommandId, deadline: u64) {
        self.in_flight.insert(id, deadline);
    }

    /// Stamp an enqueued [`EditRecord`] with the current tick and the next monotonic
    /// edit-sequence (mirror [`Engine::stamp`]). The host owns the edit-log
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

    /// Run exactly one deterministic tick in the fixed order (see the module docs) and return
    /// what the caller must write and dispatch. Advances the core by one tick even with no
    /// inputs. It does no I/O and cannot fail.
    pub fn step(&mut self, ingress: Vec<EventPayload>, results: Vec<ResultEvent>) -> StepOutput {
        let tick = self.session.core().tick;
        let mut inbound: Vec<Event> = Vec::new();
        let mut resolved: Vec<(CommandId, Outcome)> = Vec::new();
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

        // (1b) Stamp ingress, in the order the caller drained it.
        for payload in ingress {
            inbound.push(self.stamp(tick, payload));
        }

        // (2) Results. A result CLEARS its in-flight entry (handled BEFORE timeout
        //     synthesis, Pitfall 5), is reported in `resolved` so the host marks the
        //     ledger Done, then re-enters the fold as a logged CommandResult.
        for mut re in results {
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
            resolved.push((re.command_id, re.outcome.clone()));
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

        // (4) Take this tick's enqueued topology edits and stamp each (partition 0, the
        //     current tick, the next monotonic edit-sequence: the host is the
        //     edit-sequence authority). The buffer is the edit-log mirror of the inbound
        //     event batch; the gesture producer (08-06) fills it via enqueue_edit.
        let pending = std::mem::take(&mut self.pending_edits);
        let mut stamped_edits: Vec<EditRecord> = Vec::with_capacity(pending.len());
        for record in pending {
            let er = self.stamp_edit(tick, record);
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
        let commands = self.session.fold_live(&stamped_edits, &inbound);

        // (6) Track each emitted command's deadline. The caller writes each one ahead to
        //     its durable ledger and dispatches it; nothing here sends anything.
        for cmd in &commands {
            self.in_flight.insert(cmd.id, cmd.deadline);
        }

        let edits_folded = !stamped_edits.is_empty();
        StepOutput {
            inbound,
            stamped_edits,
            resolved,
            commands,
            edits_folded,
        }
    }
}
