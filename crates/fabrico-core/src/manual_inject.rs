//! `impl Machine for ManualInject` — the manual-inject source (SRC-02) — plus
//! the event-admission helper that routes a logged event to its target.
//!
//! The source's plain data (`ManualInject { pending }`) lives in
//! [`crate::state`]; here it gains behavior through the public [`Machine`] trait
//! (API-02). The "drop one item on the belt" affordance is two halves:
//!
//! 1. **Admission** ([`admit`]): a logged [`Event`] is interpreted at a tick
//!    boundary. A [`EventPayload::ManualInject`] enqueues the item into the
//!    target source's `pending` and wakes it; an [`EventPayload::Input`] (a belt
//!    delivery re-entering as a log event) pushes straight into the target's
//!    inbox carrying the event's `sequence` (the ROUTE-06 tie-break key) and
//!    wakes it. Phase-5 payloads (`CommandResult`, `Timeout`) are matched and
//!    no-oped.
//! 2. **Firing** ([`ManualInject::step`]): when the woken source steps, it drains
//!    its `pending` onto output port 0 — one queued item == one item downstream.
//!
//! Keeping admission here (next to the source) means the source's "firing" logic
//! lives with the source; the fold (`tick.rs`) calls [`admit`] for every inbound
//! event before stepping the active set.

use crate::command::Outcome;
use crate::event::{Event, EventPayload};
use crate::fault::{Fault, FaultReason, FAULT_PORT};
use crate::machine::{Machine, StepCtx};
use crate::scheduler::Scheduler;
use crate::state::{GridState, Node};
use crate::wire;

impl Machine for crate::state::ManualInject {
    fn step(&mut self, ctx: &mut StepCtx<'_>) {
        // Fire: ONE queued item per pass to output port 0 (71-03 ruling R-12). One
        // queued item == one item dropped downstream (SRC-02). A source ignores its
        // input port, so its serviceable queue is `pending`, not the inbox.
        //
        // The fold's PILE-02 gate proves that ONE item is admissible on the belt this
        // source is docked to; a pass that drained the whole deque would push far more
        // than that against a gate which cleared one, and everything past the belt's
        // own staging bound would be refused at the generic outbox drain as an
        // `OutputRefused` fault rather than travelling.
        if let Some(item) = self.pending.pop_front() {
            ctx.push_output(0, item);
        }
        // Re-wake next tick while `pending` still holds a backlog - strictly future,
        // never `schedule_wake(now)`. `pending` IS the serviceable queue here, so this
        // is the exact analogue of the other machines' serviceable-port gate and it
        // carries no livelock risk: a drained source sleeps (CORE-07).
        if !self.pending.is_empty() {
            ctx.schedule_wake(ctx.tick() + 1);
        }
    }
}

/// Admit a logged [`Event`] into the grid at a tick boundary: route its payload
/// to the target node and wake the target so the fold will step it.
///
/// - [`EventPayload::ManualInject`]: enqueue the item into the target source's
///   `pending` (the source fires it on its next step) and `wake_now` the source.
/// - [`EventPayload::Input`]: push the item directly into the target's inbox on
///   `port`, carrying `ev.sequence` as the cross-port tie-break key (ROUTE-06),
///   and `wake_now` the target.
/// - [`EventPayload::CommandResult`]: a dispatched command's logged outcome
///   re-entering the fold (EXEC-02). Routed PURELY off `CommandId.NodeId` (the
///   emitting node), holding ZERO per-command state in the core: `Failure` pushes
///   a [`FaultReason::CommandFailure`] fault onto the node's [`FAULT_PORT`] and
///   wakes it; `Success` is validated-then-fire-and-forget (no state mutation, no
///   wake — the result stays a logged audit event); `Pending` is ignored (never a
///   final logged result).
/// - [`EventPayload::Timeout`]: a host-synthesized command timeout (EXEC-03).
///   Routed off `CommandId.NodeId`: pushes a [`FaultReason::CommandTimeout`] fault
///   onto the node's [`FAULT_PORT`] and wakes it.
///
/// # Trust boundary (threat T-1-DES): total over malformed targets
/// A [`NodeId`](crate::ids::NodeId) is a generational slotmap key that
/// deserializes from arbitrary bytes; a corrupt-but-schema-valid log record
/// passes [`crate::event::upcast`] (which checks only `schema_version`, not
/// referential integrity). `admit` therefore **never panics on a dangling or
/// wrong-kind target**: it validates the target exists (and, for `ManualInject`,
/// is actually a `Source`) before mutating state or waking it. An event whose
/// target does not exist is silently dropped, and a non-existent node is **never**
/// woken (which would otherwise enter the active set and panic in `step_node`).
/// `now` is the CURRENT core tick (`core.tick`) the fold is admitting into — the
/// authoritative hop-maturation clock for the `WireRequest` arm. A message's
/// `entry_tick` is clamped to `now`, NOT taken from the untrusted `ev.tick`, so the
/// `>= 1`-tick/hop maturity gate holds unconditionally even for a forged/stale-tick
/// event or a non-canonical `advance()` caller (on the canonical replay path
/// `ev.tick == now`, so this clamp is a no-op there — no fixture changes). Every other
/// arm keys off `ev.sequence` (the tie-break key), never `ev.tick`.
pub fn admit(state: &mut GridState, sched: &mut Scheduler, ev: &Event, now: u64) {
    match &ev.payload {
        EventPayload::ManualInject {
            target,
            port: _,
            item,
        } => {
            // Enqueue+wake ONLY when the target is a real Source. A dangling or
            // wrong-kind target is dropped - never wake a node that does not
            // exist (it would panic in the fold).
            //
            // AND ONLY WHILE `pending` IS UNDER `SOURCE_PENDING_CAP` (71-03 ruling
            // R-15, PILE-04). Past the bound the item is NOT enqueued and the source
            // is NOT woken. This is the one honest refusal at the TOP of the chain,
            // and it exists because plan 71-03's own gate created the need for it: a
            // Source whose output belt is full is no longer stepped, so `pending` is
            // no longer drained, and an unbounded serialized `VecDeque` inside
            // `Node::Source` would grow forever on a jammed board - the leak merely
            // relocated one node upstream instead of closed (threat T-71-03-01).
            //
            // The refusal is SILENT and mints no fault, taking exactly the shape of the
            // `Input` arm's over-cap refusal below and of the dangling-target drop
            // above, for the same class of reason (ruling R-5): the emitter is the
            // LOGGED EVENT STREAM and not a node, so no node's FAULT_PORT is an honest
            // home for it, and the log is already the audit trail.
            //
            // The cap comparison is `admit::source_accepts_one` (plan 87-01, JAM-06): the
            // render packet asks the same function whether this Source is refusing, so the
            // BACKED_UP mark and this refusal are one reading (ruling R-3).
            if let Some(Node::Source(source)) = state.node_mut(*target)
                && crate::admit::source_accepts_one(source)
            {
                source.pending.push_back(item.clone());
                sched.wake_now(*target);
            }
        }
        EventPayload::Input { target, port, item } => {
            // Push into the inbox ONLY when the target node exists, so a dangling
            // target is dropped rather than panicking in `inbox_mut`.
            //
            // LOAD-BEARING (shared seq slot): this stamps `ev.sequence` into the SAME
            // `(u64, Item)` inbox slot the FOLD fills with `route_seq` (belt/wire
            // deliveries, `tick.rs`). The two u64 sources are only interchangeable
            // because EVERY inbox consumer treats the queue as PURE FIFO (insertion
            // order == delivery order) and never SORTS or dedups by that u64 — the ONE
            // exception is the `Input`->sink idempotency key `(tick, self_id, event_seq)`
            // (`sink.rs:27`), which is production-unreachable (v1 sinks are
            // validated-then-fire-and-forget; no live grid loops an `Input` into a sink).
            // Do NOT introduce a seq-ordered inbox read: it would make the shared slot's
            // meaning depend on which producer filled it and break the ONE `route_seq`
            // FIFO the comparator rests on.
            //
            // OVER-CAP HERE IS REFUSED SILENTLY, AND THE TARGET IS NOT WOKEN (71-01
            // ruling R-5). This is the ONE mechanical refusal in Phase 71 that is
            // neither RETAINED (as the belt head is) nor FAULTED (as the fold's generic
            // outbox drain is), and the reason is that the emitter is the LOGGED EVENT
            // STREAM, not a node: there is no node whose FAULT_PORT would be the honest
            // home for the refusal, and the log itself is already the audit trail. It
            // takes exactly the shape the dangling-target drop above takes, and for the
            // same class of reason.
            if state.node(*target).is_some()
                && crate::admit::try_admit(
                    state,
                    crate::admit::Emitter::EventStream,
                    *target,
                    *port,
                    ev.sequence,
                    item.clone(),
                )
                .is_ok()
            {
                sched.wake_now(*target);
            }
        }
        // Phase-5 dispatch RESULT re-entry (EXEC-02). Route PURELY off the emitting
        // NodeId carried in the CommandId — the core holds ZERO per-command state.
        EventPayload::CommandResult(re) => {
            let (_tick, node, _seq) = re.command_id;
            // Existence guard (mirrors the ManualInject/Input arms, threat
            // T-05-01-DES): a dangling CommandId.NodeId is dropped — never panic,
            // never wake a node that does not exist (it would panic in the fold).
            if state.node(node).is_some() {
                match re.outcome {
                    // A failed dispatch routes a CommandFailure fault onto the
                    // emitting node's reserved FAULT_PORT (wired to a dead-letter /
                    // retry belt like any other fault) and wakes the node.
                    Outcome::Failure => {
                        let fault = Fault::command(node, FaultReason::CommandFailure, Vec::new());
                        // Through the ONE admission path (D-03). The emitter is the
                        // logged event stream, so `Emitter::EventStream` is the only
                        // honest spelling; FAULT_PORT classifies as `AdmitClass::Fault`
                        // (clause 1), which is bounded by `FAULT_QUEUE_CAP`. Past that
                        // bound the fault is DROPPED and nothing counts it (PILE-09,
                        // ruling R-16) - the `let _ =` discards the returned item, which
                        // IS the drop. A board pointed at a dead endpoint therefore stops
                        // growing its save file; PILE-10's drain is what keeps that
                        // honest, by giving the queue an exit a user can draw.
                        let _ = crate::admit::try_admit(
                            state,
                            crate::admit::Emitter::EventStream,
                            node,
                            FAULT_PORT,
                            ev.sequence,
                            fault.encode(),
                        );
                        sched.wake_now(node);
                    }
                    // Validated-then-fire-and-forget for v1 sinks: a successful
                    // dispatch mutates NO grid state and does NOT wake the node. The
                    // CommandResult remains a logged audit event. This deliberately
                    // avoids re-stepping the sink on success — re-waking it would let
                    // a sink that re-emits on step re-trigger its own dispatch in a
                    // livelock (Open Question 2 / Pitfall 5). A future result-port
                    // delivery is a v2 concern.
                    Outcome::Success => {}
                    // Pending is never a FINAL logged result (the host only logs a
                    // resolved outcome); ignore it defensively.
                    Outcome::Pending => {}
                }
            }
        }
        // Phase-5 command TIMEOUT re-entry (EXEC-03): the host synthesized this when
        // a command's logged deadline passed with no resolution. Route off the
        // emitting NodeId to a CommandTimeout fault on FAULT_PORT, then wake.
        EventPayload::Timeout { command_id } => {
            let (_tick, node, _seq) = command_id;
            // Same dangling-target guard (T-05-01-DES).
            if state.node(*node).is_some() {
                let fault = Fault::command(*node, FaultReason::CommandTimeout, Vec::new());
                // Through the ONE admission path (D-03), `Emitter::EventStream` for the
                // same reason as the `CommandResult::Failure` arm above.
                let _ = crate::admit::try_admit(
                    state,
                    crate::admit::Emitter::EventStream,
                    *node,
                    FAULT_PORT,
                    ev.sequence,
                    fault.encode(),
                );
                sched.wake_now(*node);
            }
        }
        // 37-02: a logged WireRequest is ADMITTED into its entry wire's in-flight FIFO
        // and the wire is woken so the fold transports it (>= 1 tick/hop). The request
        // body (correlation/return_addr/budget/payload — the Plan-01 grow) rides ON the
        // in-flight message; `deadline_tick` is the Phase-38 reply deadline, unused here.
        EventPayload::WireRequest {
            correlation,
            deadline_tick: _,
            budget,
            return_addr,
            payload,
        } => {
            // The ENTRY NODE is the `return_addr` node (the caller is both the
            // request's origin and its reply target — the Phase-38 Endpoint is that
            // caller). The ENTRY WIRE is the live `Node::Wire` whose
            // `from.node == return_addr.node` (ascending-`NodeId` FIRST on the
            // single-wire-per-endpoint topology, via `wire_from_node`). If no such
            // live wire exists the request is DROPPED — NEVER wake a nonexistent node
            // (it would panic in the fold, mirroring the `Input` existence guard above;
            // threat T-37-04-FORGE, total over a dangling/wrong-kind target).
            //
            // LOAD-BEARING (arrival-order independence — do NOT "fix" by sorting):
            // admitting DIRECTLY into the entry wire's `in_flight` (bypassing any
            // per-source pending buffer) is arrival-order-independent ONLY because the
            // arrival-order certification (`cert_arrival_order.rs:11-25`) feeds at most
            // ONE request per DISTINCT wire-entry node. A future test that admits
            // MULTIPLE requests into ONE entry wire in a tick would make their relative
            // `in_flight` order depend on admit (arrival) order — and that must NOT be
            // repaired by sorting `in_flight` (which would corrupt the FIFO the ONE
            // route_seq comparator relies on); the fix belongs at the SOURCE (distinct
            // entry nodes), exactly as the criterion guarantees.
            let entry_node = return_addr.0;
            // THIS LOOKUP IS DELIBERATELY LESS PRECISE THAN ITS SIBLING, AND THAT IS D-19.
            //
            // `tick::route_replies` picks the RETURN cable with
            // `GridState::return_wire_from`, which is exact on the destination node. This
            // ENTRY lookup stays NODE-ONLY: it asks only "which cable leaves the caller",
            // and it does NOT match on the source PORT either.
            //
            // MEASURED reason, not a preference. The shipped scenario-07 board draws its
            // forward wire from the endpoint's port 1 (`bless_fixtures.rs`, "FORWARD:
            // endpoint Out (catalog 1) -> factory In (catalog 0)") while the host stamps
            // `return_addr = (endpoint, 0)` on the request. A port-exact entry match would
            // find NO wire out of `(endpoint, 0)`, drop the request, and move a frozen
            // golden fixture for a reason nobody asked for.
            //
            // So: if you arrive here reading the two precision rules as an oversight, they
            // are not. The asymmetry is on the DESTINATION half of the return lookup only.
            if let Some(entry_wire) = state.wire_from_node(entry_node) {
                let env = wire::WireEnvelope {
                    correlation: *correlation,
                    return_addr: *return_addr,
                    budget: *budget,
                    payload: payload.clone(),
                };
                // `entry_tick == now` (the current core tick, CLAMPED — not `ev.tick`):
                // the message matures one tick later, so the entry wire can never forward
                // it the SAME tick it was admitted. Clamping to `now` (rather than trusting
                // the event's own `ev.tick`) keeps the `>= 1`-tick/hop maturity gate airtight
                // even for a forged/stale-tick event or a non-canonical `advance()` caller
                // — `Core::advance` does NOT verify `ev.tick == core.tick`. On the canonical
                // replay path `ev.tick == now` already, so no fixture's hop timing changes.
                let msg = wire::WireInFlight::from_envelope(env, now);
                // Admission only ENQUEUES to the wire's in-flight buffer; actual
                // delivery / onward-hop acquires `route_seq` in the fold (Pitfall 2) —
                // never a direct inbox push with `ev.sequence` here.
                let mut overflowed = false;
                if let Some(Node::Wire(link)) = state.node_mut(entry_wire) {
                    overflowed = wire::admit(&mut link.in_flight, msg).is_some();
                }
                if overflowed {
                    // SPACE bound (the in-flight cap): the entry wire is at
                    // WIRE_INFLIGHT_CAP -> a WireOverflow fault to the ENTRY NODE's
                    // FAULT_PORT + wake it (the CommandFailure fault-emit precedent,
                    // manual_inject.rs:103-106) — deterministic, never grows past the
                    // cap. Guarded so a dangling `return_addr` node is dropped (never
                    // woken); the wire's `from.node` referencing a node does not prove
                    // that node is live.
                    if state.node(entry_node).is_some() {
                        let fault =
                            Fault::command(entry_node, FaultReason::WireOverflow, Vec::new());
                        // Through the ONE admission path (D-03), `Emitter::EventStream`
                        // for the same reason as the two fault arms above.
                        let _ = crate::admit::try_admit(
                            state,
                            crate::admit::Emitter::EventStream,
                            entry_node,
                            FAULT_PORT,
                            ev.sequence,
                            fault.encode(),
                        );
                        sched.wake_now(entry_node);
                    }
                } else {
                    // Admitted: wake the entry wire so the fold transports it.
                    sched.wake_now(entry_wire);
                }
            } else {
                // NO ENTRY WIRE (Phase 72, SERVE-08). THIS BRANCH DID NOT EXIST until
                // 72-07, and its absence was the worst defect shape in this codebase.
                //
                // WHAT HAPPENED BEFORE. The `if let Some(entry_wire)` above simply fell
                // through. The request was DISCARDED INSIDE THE FOLD: nothing pushed,
                // nothing woken, and because an Endpoint never steps on its own its
                // state byte stayed IDLE forever. The caller's only signal was a
                // host-side 504 on the deadline sweep, three hundred ticks later, naming
                // nothing on the board. A request that looks accepted and never happens.
                //
                // THE SHAPE IS THE WIRE_INFLIGHT_CAP BRANCH ABOVE, MIRRORED. That branch
                // is the precedent and the only other refusal on this arm: push a Fault
                // to the ENTRY NODE's FAULT_PORT through the ONE admission path (D-03,
                // `Emitter::EventStream`), then wake the node. Same liveness guard too:
                // a dangling `return_addr` node is DROPPED and never woken, because
                // waking a nonexistent node panics in the fold (T-37-04-FORGE).
                //
                // THE PAYLOAD IS EMPTY, and that is a decision rather than laziness.
                // `Fault::payload` carries the original faulted bytes for dead-letter
                // inspection (`fault.rs:129-131`), and the request's own payload is
                // right here in `payload` and could have ridden along. It deliberately
                // does not: D-25 grants this ONE fault a self-clear when the user draws
                // the missing cable, and a self-clearing fault that carried a dead letter
                // would destroy evidence every time somebody fixed their board. An empty
                // payload is what makes the clear safe.
                //
                // NO `Role::Fault` NUB IS NEEDED ON THE ROUTE and none is added: an
                // unwired fault is still a fault (`tick.rs`, the fault-port routing
                // note), `derive_state` reads the RESTING inbox entry, and what a
                // missing nub costs is only a dead-letter belt this node never had.
                if state.node(entry_node).is_some() {
                    let fault = Fault::command(entry_node, FaultReason::NoEntryWire, Vec::new());
                    let _ = crate::admit::try_admit(
                        state,
                        crate::admit::Emitter::EventStream,
                        entry_node,
                        FAULT_PORT,
                        ev.sequence,
                        fault.encode(),
                    );
                    sched.wake_now(entry_node);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::command::Command;
    use crate::event::{Event, EventPayload, SCHEMA_VERSION};
    use crate::ids::{Item, NodeId, PortId};
    use crate::machine::StepCtx;
    use crate::rng::SimRng;
    use crate::scheduler::Scheduler;
    use crate::state::{Node, PortOutbox};
    use slotmap::SlotMap;

    fn inject_event(target: NodeId, seq: u64, item: Item) -> Event {
        Event {
            schema_version: SCHEMA_VERSION,
            partition: 0,
            sequence: seq,
            tick: 0,
            payload: EventPayload::ManualInject {
                target,
                port: 0,
                item,
            },
        }
    }

    /// Step the source at `id` in `state` for one tick, returning port outputs.
    fn step_source(state: &mut GridState, id: NodeId) -> Vec<(PortId, Item)> {
        let mut inbox = std::mem::take(state.inbox_mut(id));
        let mut outbox = PortOutbox::new();
        let mut commands: Vec<Command> = Vec::new();
        let mut sched = Scheduler::new();
        let mut rng = SimRng::from_seed_u64(0);
        {
            let mut ctx =
                StepCtx::new(0, id, &mut inbox, &mut outbox, &mut commands, &mut sched, &mut rng);
            match state.node_mut(id).expect("node exists") {
                Node::Source(s) => s.step(&mut ctx),
                Node::Belt(b) => b.step(&mut ctx),
                Node::Tee(t) => t.step(&mut ctx),
                Node::Balancer(b) => b.step(&mut ctx),
                Node::Merge(m) => m.step(&mut ctx),
                Node::Router(r) => r.step(&mut ctx),
                Node::Sink(s) => s.step(&mut ctx),
                // A factory is NOT driven through the Machine trait — it needs the
                // Core-level FactoryRuntime cache that this simple-machine test
                // helper does not provide. The fold drives it via the dedicated
                // tick Node::Factory arm; this helper must never be called on one.
                Node::Factory(_) => {
                    panic!("step_source: Factory nodes are driven by the tick Node::Factory arm")
                }
                // Neither has a `Machine::step`, and that is permanent rather than
                // pending: a wire is driven by the tick's own transport pass and an
                // endpoint's behaviour is host-side. A typed no-op, NOT the panic! used
                // for Factory (that panic guards an internal invariant; wire/endpoint
                // must stay panic-free so a forged node never crashes on step —
                // SCHEMA-03, threat T-35-01-INERT).
                // A Label (phase 76) steps to nothing for the same reason: it is a note.
                Node::Wire(_) | Node::Endpoint(_) | Node::Label(_) => {}
            }
        }
        *state.inbox_mut(id) = inbox;
        outbox.drain_sorted()
    }

    #[test]
    fn manual_inject_one_fire_drops_exactly_one_item() {
        let mut g = GridState::new();
        let s = g.add_source();
        let mut sched = Scheduler::new();

        admit(&mut g, &mut sched, &inject_event(s, 1, Item(vec![0xAA])), 0);
        // Admission woke the target so the fold will step it.
        assert_eq!(sched.drain_active_sorted(), vec![s], "admission wakes the source");

        let out = step_source(&mut g, s);
        assert_eq!(out, vec![(0u16, Item(vec![0xAA]))], "one fire == one item");

        // Firing again with nothing queued yields nothing.
        let out = step_source(&mut g, s);
        assert!(out.is_empty(), "no pending => no output");
    }

    #[test]
    fn manual_inject_firing_twice_yields_two() {
        let mut g = GridState::new();
        let s = g.add_source();
        let mut sched = Scheduler::new();

        admit(&mut g, &mut sched, &inject_event(s, 1, Item(vec![1])), 0);
        admit(&mut g, &mut sched, &inject_event(s, 2, Item(vec![2])), 0);
        // Two queued items fire FIFO over TWO passes. Since 71-03 (ruling R-12) a
        // source pushes ONE item per pass and re-wakes while `pending` is non-empty,
        // for the same reason every other machine does: the fold's PILE-02 gate proves
        // exactly one item is admissible on the belt this source is docked to, and a
        // pass that drained the whole deque would emit more than the gate cleared.
        let out = step_source(&mut g, s);
        assert_eq!(out, vec![(0u16, Item(vec![1]))], "ONE item per pass");
        let out = step_source(&mut g, s);
        assert_eq!(out, vec![(0u16, Item(vec![2]))], "FIFO: the second on pass two");
        let out = step_source(&mut g, s);
        assert!(out.is_empty(), "a drained source emits nothing and sleeps");
    }

    #[test]
    fn manual_inject_refuses_past_source_pending_cap_and_does_not_wake() {
        // PILE-04 / ruling R-15: the one honest refusal at the TOP of the chain.
        //
        // Under the PILE-02 gate a Source whose output belt is full is not stepped, so
        // `pending` is not drained. Without this bound it would grow forever inside a
        // SERIALIZED `Node::Source`, and the phase would have relocated the invisible
        // queue one node upstream rather than closed it (threat T-71-03-01).
        //
        // The refusal is SILENT: nothing enqueued, and - the half that is easy to get
        // wrong - the source is NOT woken, because waking a node for an item it never
        // received would put it in the active set to do nothing every tick.
        let mut g = GridState::new();
        let s = g.add_source();
        let mut sched = Scheduler::new();

        let over = crate::admit::SOURCE_PENDING_CAP + 8;
        for i in 0..over {
            admit(
                &mut g,
                &mut sched,
                &inject_event(s, i as u64 + 1, Item(vec![(i & 0xFF) as u8])),
                0,
            );
        }
        let pending = match g.node(s) {
            Some(Node::Source(src)) => src.pending.len(),
            o => panic!("expected a Source, got {o:?}"),
        };
        assert_eq!(
            pending,
            crate::admit::SOURCE_PENDING_CAP,
            "pending stops at SOURCE_PENDING_CAP however many events arrive"
        );
        // Non-vacuity: the burst is strictly wider than the bound, so a build with no
        // bound at all would read `over` here rather than the cap.
        assert!(over > crate::admit::SOURCE_PENDING_CAP);

        // AND THE SOURCE IS NOT WOKEN by a refused admission. Clear the active set the
        // accepted ones filled, then offer one more and assert nothing entered it: a
        // refusal that still woke its target would put the node in the active set every
        // tick to do nothing, and on a jammed board that is every tick forever.
        let _ = sched.drain_active_sorted();
        admit(&mut g, &mut sched, &inject_event(s, 9_999, Item(vec![0xFF])), 0);
        assert!(
            sched.drain_active_sorted().is_empty(),
            "a refused admission wakes nobody"
        );

        // And the FIFO prefix survived: the bound refuses the NEW arrivals, it never
        // evicts the queued ones. An eviction policy would silently reorder a logged
        // event stream.
        match g.node(s) {
            Some(Node::Source(src)) => {
                assert_eq!(src.pending.front(), Some(&Item(vec![0])), "oldest kept");
                assert_eq!(
                    src.pending.back(),
                    Some(&Item(vec![(crate::admit::SOURCE_PENDING_CAP - 1) as u8])),
                    "and the tail is the LAST accepted, not the last offered"
                );
            }
            o => panic!("expected a Source, got {o:?}"),
        }
    }

    #[test]
    fn manual_inject_admit_input_pushes_to_inbox_and_wakes() {
        // An Input payload (a belt delivery re-entering as a log event) lands in
        // the target's inbox carrying the event sequence, and wakes the target.
        let mut g = GridState::new();
        let b = g.add_belt(0);
        let mut sched = Scheduler::new();
        let ev = Event {
            schema_version: SCHEMA_VERSION,
            partition: 0,
            sequence: 99,
            tick: 0,
            payload: EventPayload::Input {
                target: b,
                port: 0,
                item: Item(vec![7]),
            },
        };
        admit(&mut g, &mut sched, &ev, 0);
        assert_eq!(sched.drain_active_sorted(), vec![b], "input wakes the target");
        // The item is in the inbox carrying its event sequence (ROUTE-06 key).
        let mut inbox = g.inbox_of(b).cloned().expect("inbox exists");
        assert_eq!(inbox.take(0), Some((99, Item(vec![7]))));
    }

    #[test]
    fn manual_inject_admit_dangling_target_does_not_panic_or_wake() {
        // Regression for CR-02: a decoded event whose target NodeId does not
        // exist in the grid must be dropped — never panic (threat T-1-DES) and
        // never wake a non-existent node (which would later panic in the fold).
        let mut g = GridState::new();
        let real = g.add_source(); // a real node (first slot) so the grid is non-empty
        // Mint a NodeId from a SEPARATE allocator, advancing past the first slot
        // so it cannot alias `g`'s only node: it is well-formed but dangling
        // (never inserted into `g`) — exactly like a corrupt-but-schema-valid log
        // record's target that passed `upcast`.
        let bogus: NodeId = {
            let mut alloc: SlotMap<NodeId, ()> = SlotMap::with_key();
            let _first = alloc.insert(()); // would alias g's first slot
            alloc.insert(()) // second slot — guaranteed absent from g
        };
        assert_ne!(bogus, real, "test setup: bogus id must not alias the real node");
        let mut sched = Scheduler::new();

        // ManualInject to a dangling target: dropped, no wake, no panic.
        admit(&mut g, &mut sched, &inject_event(bogus, 1, Item(vec![0xDE])), 0);
        assert!(
            sched.drain_active_sorted().is_empty(),
            "dangling ManualInject target is dropped, not woken"
        );

        // Input to a dangling target: dropped, no wake, no panic.
        let input_ev = Event {
            schema_version: SCHEMA_VERSION,
            partition: 0,
            sequence: 7,
            tick: 0,
            payload: EventPayload::Input {
                target: bogus,
                port: 0,
                item: Item(vec![0xAD]),
            },
        };
        admit(&mut g, &mut sched, &input_ev, 0);
        assert!(
            sched.drain_active_sorted().is_empty(),
            "dangling Input target is dropped, not woken"
        );
    }

    // --- Phase-5 admit() result/timeout re-entry (Task 3) ---

    use crate::command::{Outcome, ResultEvent};
    use crate::fault::{Fault, FaultReason, FAULT_PORT};
    use crate::ids::CommandId;

    /// A logged CommandResult event for `command_id` with `outcome`.
    fn result_event(command_id: CommandId, outcome: Outcome, seq: u64) -> Event {
        Event {
            schema_version: SCHEMA_VERSION,
            partition: 0,
            sequence: seq,
            tick: 0,
            payload: EventPayload::CommandResult(ResultEvent {
                command_id,
                tick: 0,
                outcome,
            }),
        }
    }

    /// A logged Timeout event for `command_id`.
    fn timeout_event(command_id: CommandId, seq: u64) -> Event {
        Event {
            schema_version: SCHEMA_VERSION,
            partition: 0,
            sequence: seq,
            tick: 0,
            payload: EventPayload::Timeout { command_id },
        }
    }

    /// Decode the single fault item resting on `node`'s FAULT_PORT, if any.
    fn fault_on_port(g: &GridState, node: NodeId) -> Option<Fault> {
        let mut inbox = g.inbox_of(node).cloned()?;
        let (_seq, item) = inbox.take(FAULT_PORT)?;
        Fault::decode(&item).ok()
    }

    #[test]
    fn manual_inject_admit_command_failure_routes_fault_and_wakes() {
        // EXEC-02: a logged CommandResult{Failure} for an existing node pushes a
        // CommandFailure fault onto that node's FAULT_PORT and wakes it.
        let mut g = GridState::new();
        let node = g.add_source(); // any real node works (routing is off the id)
        let mut sched = Scheduler::new();

        admit(
            &mut g,
            &mut sched,
            &result_event((3, node, 0), Outcome::Failure, 5),
            0,
        );
        assert_eq!(
            sched.drain_active_sorted(),
            vec![node],
            "a failure result wakes the emitting node"
        );
        let fault = fault_on_port(&g, node).expect("a fault rests on FAULT_PORT");
        assert_eq!(fault.reason, FaultReason::CommandFailure);
        assert_eq!(fault.source, node);
        assert_eq!(fault.attempt, 1);
    }

    #[test]
    fn manual_inject_admit_timeout_routes_fault_and_wakes() {
        // EXEC-03: a logged Timeout for an existing node pushes a CommandTimeout
        // fault onto its FAULT_PORT and wakes it.
        let mut g = GridState::new();
        let node = g.add_source();
        let mut sched = Scheduler::new();

        admit(&mut g, &mut sched, &timeout_event((9, node, 1), 7), 0);
        assert_eq!(
            sched.drain_active_sorted(),
            vec![node],
            "a timeout wakes the emitting node"
        );
        let fault = fault_on_port(&g, node).expect("a fault rests on FAULT_PORT");
        assert_eq!(fault.reason, FaultReason::CommandTimeout);
        assert_eq!(fault.source, node);
    }

    #[test]
    fn manual_inject_admit_command_success_is_a_validated_no_op() {
        // A logged CommandResult{Success} mutates NO grid state and does NOT wake:
        // validated-then-fire-and-forget for v1 sinks (avoids sink re-trigger
        // livelock). The result remains a logged audit event.
        let mut g = GridState::new();
        let node = g.add_source();
        let mut sched = Scheduler::new();

        admit(
            &mut g,
            &mut sched,
            &result_event((3, node, 0), Outcome::Success, 5),
            0,
        );
        assert!(
            sched.drain_active_sorted().is_empty(),
            "success does not wake the node"
        );
        assert!(
            g.inbox_of(node).is_some_and(|i| i.is_empty()),
            "success pushes nothing onto the inbox"
        );
        assert!(
            fault_on_port(&g, node).is_none(),
            "success produces no fault"
        );
    }

    #[test]
    fn manual_inject_admit_result_and_timeout_dangling_target_drop_without_panic_or_wake() {
        // Mirror manual_inject_admit_dangling_target_does_not_panic_or_wake for the
        // two Phase-5 payloads: a CommandId.NodeId absent from the grid is dropped —
        // never panics (T-05-01-DES), never wakes a non-existent node.
        let mut g = GridState::new();
        let _real = g.add_source(); // non-empty grid
        let bogus: NodeId = {
            let mut alloc: SlotMap<NodeId, ()> = SlotMap::with_key();
            let _first = alloc.insert(());
            alloc.insert(()) // guaranteed absent from g
        };
        let mut sched = Scheduler::new();

        // Failure result to a dangling node: dropped, no wake, no panic.
        admit(
            &mut g,
            &mut sched,
            &result_event((1, bogus, 0), Outcome::Failure, 1),
            0,
        );
        assert!(
            sched.drain_active_sorted().is_empty(),
            "dangling CommandResult target is dropped, not woken"
        );

        // Timeout to a dangling node: dropped, no wake, no panic.
        admit(&mut g, &mut sched, &timeout_event((1, bogus, 0), 2), 0);
        assert!(
            sched.drain_active_sorted().is_empty(),
            "dangling Timeout target is dropped, not woken"
        );
    }

    // --- Phase-37 admit() WireRequest entry-wire admission (Task 1) ---

    use crate::wire::{WireInFlight, WIRE_INFLIGHT_CAP};

    /// A logged WireRequest for `return_addr`, carrying `budget`/`payload`.
    fn wire_request_event(
        return_addr: (NodeId, PortId),
        budget: u64,
        seq: u64,
        tick: u64,
        payload: Item,
    ) -> Event {
        Event {
            schema_version: SCHEMA_VERSION,
            partition: 0,
            sequence: seq,
            tick,
            payload: EventPayload::WireRequest {
                correlation: 0xABCD,
                deadline_tick: tick + 100,
                budget,
                return_addr,
                payload,
            },
        }
    }

    /// The in-flight message count on a `Node::Wire`, or `None` if `id` is not a wire.
    fn in_flight_len(g: &GridState, id: NodeId) -> Option<usize> {
        match g.node(id) {
            Some(Node::Wire(link)) => Some(link.in_flight.len()),
            _ => None,
        }
    }

    #[test]
    fn wire_request_admits_into_entry_wire_and_wakes() {
        // WIRE-02/04: a logged WireRequest is enqueued into the entry wire (the wire
        // whose from.node == return_addr.node) and the wire is woken to transport it.
        let mut g = GridState::new();
        let caller = g.add_source();
        let handler = g.add_source();
        let wire = g.add_wire((caller, 0), (handler, 0)); // from.node == caller
        let mut sched = Scheduler::new();

        admit(
            &mut g,
            &mut sched,
            &wire_request_event((caller, 0), 8, 5, 3, Item(vec![0xDE])),
            3, // now == ev.tick on the canonical path
        );

        // The ENTRY WIRE is woken (not the caller/handler) so the fold transports it.
        assert_eq!(sched.drain_active_sorted(), vec![wire], "the entry wire is woken");

        // The request rides ON the in-flight message; entry_tick == now (so it
        // matures >= 1 tick later); admit does NOT decrement budget.
        match g.node(wire) {
            Some(Node::Wire(link)) => {
                assert_eq!(link.in_flight.len(), 1, "one message admitted");
                let msg = &link.in_flight[0];
                assert_eq!(msg.entry_tick, 3, "entry_tick == now (== ev.tick canonically)");
                assert_eq!(msg.correlation, 0xABCD);
                assert_eq!(msg.return_addr, (caller, 0));
                assert_eq!(msg.budget, 8, "admit does not decrement budget (per-ingest-hop only)");
                assert_eq!(msg.payload, Item(vec![0xDE]));
            }
            other => panic!("expected a Wire, got {other:?}"),
        }
    }

    #[test]
    fn wire_request_entry_tick_is_clamped_to_now_not_ev_tick() {
        // Adversarial hardening: `admit` stamps `entry_tick = now` (the core tick),
        // NOT the untrusted `ev.tick`. A forged event carrying a STALE `ev.tick` far in
        // the past would, if trusted, make the message ALREADY matured on admit and
        // forward the SAME tick — breaking the >= 1-tick/hop determinism gate. Clamping
        // to `now` forecloses that regardless of the caller's `ev.tick`.
        let mut g = GridState::new();
        let caller = g.add_source();
        let handler = g.add_source();
        let wire = g.add_wire((caller, 0), (handler, 0));
        let mut sched = Scheduler::new();

        // ev.tick = 0 (stale), but the fold is admitting at now = 42.
        admit(
            &mut g,
            &mut sched,
            &wire_request_event((caller, 0), 8, 5, 0, Item(vec![0xDE])),
            42,
        );
        match g.node(wire) {
            Some(Node::Wire(link)) => {
                let msg = &link.in_flight[0];
                assert_eq!(
                    msg.entry_tick, 42,
                    "entry_tick clamped to now (42), NOT the stale ev.tick (0)"
                );
            }
            other => panic!("expected a Wire, got {other:?}"),
        }
    }

    #[test]
    fn wire_request_no_entry_wire_faults_the_entry_node_and_wakes_it() {
        // A live caller with NO outgoing wire: the request FAULTS to that caller's
        // FAULT_PORT with `NoEntryWire` and wakes it (SERVE-08, 72-07).
        //
        // THIS TEST WAS INVERTED IN 72-07 AND ITS OLD ASSERTION IS RECORDED HERE,
        // because a reader comparing it to the phase's diff is entitled to see that the
        // change was chosen rather than eroded. It was named
        // `wire_request_no_entry_wire_is_dropped_without_panic_or_wake` and asserted
        // `sched.drain_active_sorted().is_empty()` with the reason "no entry wire =>
        // dropped, nothing woken". That WAS the shipped behaviour and it was the worst
        // defect shape in this codebase: the request was discarded inside the fold, the
        // node's state byte stayed IDLE forever, and the caller's only signal was a
        // host-side 504 three hundred ticks later naming nothing on the board.
        //
        // The half of the old test that was RIGHT is kept and is now its own sibling
        // clause: nothing is woken that does not exist. That case lives in
        // `wire_request_dangling_return_addr_is_dropped_without_panic` below, which is
        // UNCHANGED and still passes - a `return_addr` naming no live node is still
        // dropped in silence, because waking a nonexistent node panics in the fold
        // (threat T-37-04-FORGE). The distinction this pair now draws is exactly the
        // right one: a REAL node with no cable gets told; a node that is not there
        // cannot be.
        let mut g = GridState::new();
        let caller = g.add_source();
        let mut sched = Scheduler::new();
        admit(
            &mut g,
            &mut sched,
            &wire_request_event((caller, 0), 8, 1, 0, Item(vec![1])),
            0,
        );
        assert_eq!(
            sched.drain_active_sorted(),
            vec![caller],
            "the entry node is WOKEN: a fault written with no wake is a fault nothing \
             will ever look at again, because an Endpoint never steps on its own"
        );
        let resting: Vec<Fault> = g
            .inbox_of(caller)
            .expect("a live node has an inbox")
            .items_on(FAULT_PORT)
            .map(|item| Fault::decode(item).expect("the fault this fold pushed decodes"))
            .collect();
        assert_eq!(resting.len(), 1, "exactly one fault, not a storm");
        assert_eq!(resting[0].reason, FaultReason::NoEntryWire);
        assert_eq!(resting[0].source, caller);
        assert!(
            resting[0].payload.is_empty(),
            "EMPTY payload: no dead letter, so the D-25 self-clear destroys no evidence"
        );
    }

    #[test]
    fn wire_request_dangling_return_addr_is_dropped_without_panic() {
        // A return_addr node absent from the grid matches no wire's from.node, so the
        // request is dropped — never panics, never wakes a nonexistent node.
        let mut g = GridState::new();
        let _caller = g.add_source();
        let bogus: NodeId = {
            let mut alloc: SlotMap<NodeId, ()> = SlotMap::with_key();
            let _first = alloc.insert(());
            alloc.insert(())
        };
        let mut sched = Scheduler::new();
        admit(
            &mut g,
            &mut sched,
            &wire_request_event((bogus, 0), 8, 1, 0, Item(vec![1])),
            0,
        );
        assert!(
            sched.drain_active_sorted().is_empty(),
            "dangling return_addr => dropped, nothing woken"
        );
    }

    #[test]
    fn wire_request_at_cap_faults_to_entry_node_deterministically() {
        // WIRE-03 SPACE bound: an entry wire already at WIRE_INFLIGHT_CAP refuses the
        // request and faults WireOverflow to the ENTRY NODE's FAULT_PORT; the wire
        // never grows past the cap.
        let mut g = GridState::new();
        let caller = g.add_source();
        let handler = g.add_source();
        let wire = g.add_wire((caller, 0), (handler, 0));
        if let Some(Node::Wire(link)) = g.node_mut(wire) {
            for _ in 0..WIRE_INFLIGHT_CAP {
                link.in_flight.push_back(WireInFlight {
                    entry_tick: 0,
                    correlation: 0,
                    return_addr: (caller, 0),
                    budget: 1,
                    payload: Item(vec![]),
                });
            }
        }
        let mut sched = Scheduler::new();
        admit(
            &mut g,
            &mut sched,
            &wire_request_event((caller, 0), 8, 7, 2, Item(vec![0xAA])),
            2, // now == ev.tick on the canonical path
        );

        assert_eq!(
            in_flight_len(&g, wire),
            Some(WIRE_INFLIGHT_CAP),
            "over-cap refuses: the wire never grows past the cap"
        );
        assert_eq!(
            sched.drain_active_sorted(),
            vec![caller],
            "the entry node is woken on overflow"
        );
        let fault = fault_on_port(&g, caller).expect("a WireOverflow fault rests on the entry node");
        assert_eq!(fault.reason, FaultReason::WireOverflow);
        assert_eq!(fault.source, caller);
    }

    #[test]
    fn wire_request_picks_ascending_nodeid_first_on_multi_wire_endpoint() {
        // SINGLE-WIRE-PER-ENDPOINT is assumed; a node with >1 outgoing wire resolves
        // to the FIRST in ascending NodeId order (the `nodes` BTreeMap tie-break).
        let mut g = GridState::new();
        let caller = g.add_source();
        let h1 = g.add_source();
        let h2 = g.add_source();
        let wire_a = g.add_wire((caller, 0), (h1, 0));
        let wire_b = g.add_wire((caller, 1), (h2, 0));
        assert!(wire_a < wire_b, "test setup: wire_a is the ascending-first wire");
        let mut sched = Scheduler::new();
        admit(
            &mut g,
            &mut sched,
            &wire_request_event((caller, 0), 8, 1, 0, Item(vec![9])),
            0,
        );
        assert_eq!(in_flight_len(&g, wire_a), Some(1), "ascending-first wire admits the request");
        assert_eq!(in_flight_len(&g, wire_b), Some(0), "the later wire is untouched");
        assert_eq!(sched.drain_active_sorted(), vec![wire_a], "only the chosen wire is woken");
    }
}
