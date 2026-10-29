//! The per-tick render-packet builder + the single [`RenderProducer`] that owns
//! the explicit `layout.update → build → encode → broadcast.send` pipeline (W2).
//!
//! # The one producer of the bytes both transports send
//! The deterministic core models machine *state* (idle/working/faulted) as a
//! presentation concern derived host-side, but on-screen *position* (cells) now lives
//! in core [`GridState`](fabrico_core::state::GridState) (folded from the edit-log,
//! captured in the snapshot — SPAT-01). This module joins the Core read-state
//! (`node_ids`/`node`/`links_iter`/`cell_of`, belt `in_flight`) with the per-tick
//! [`TickObservation`] (state derivation), then serializes the
//! **integer-only** [`RenderPacket`] with `postcard`. Those bytes are what BOTH the
//! dev WebSocket (07-06) and the Tauri `Channel` (07-08) send — identical regardless
//! of which transport carries them (the locked "one builder, identical bytes").
//!
//! # Active-set diff (idle ticks nearly free)
//! [`RenderPacketBuilder::build`] keeps the previously-emitted `(NodeView, BeltView)`
//! snapshot keyed by a dense host-assigned `u64` handle and emits ONLY the
//! nodes/belts that changed this tick (plus removed handles), with `full:false`.
//! A steady grid emits an empty diff — mirroring the engine's active-set scheduler.
//! [`RenderPacketBuilder::build_keyframe`] emits everything (`full:true`) for a
//! freshly-subscribed transport.
//!
//! # Integer-only wire (Pitfall 4, T-07-WIRE-FLOAT)
//! No `f32`/`f64`/`fixed` ever crosses the wire: item motion ships
//! `arrival_tick:u64` + `latency:u32`, `fill` is a `u16`, cells are `i32`. The
//! renderer derives float positions canvas-side.
//!
//! # Dense handle, not `as_ffi` (Assumption A3)
//! Handles are host-assigned monotonically from `0`, NOT `NodeId::data().as_ffi()`
//! (which packs a generation counter in the high bits, can exceed `2^53`, and would
//! force `BigInt` in TS). The builder owns the dense `NodeId → u64` table.

use std::collections::{BTreeMap, VecDeque};

use fabrico_command::command::{GRID_MAX, GRID_MIN};
use fabrico_command::route::route;
use fabrico_command::wire_route::normal;
use fabrico_command::{
    WireBody, WireDock, WireGeometry, WireRouteError, is_wire_obstacle, wire_route_avoiding,
};
use fabrico_core::admit::{self, AdmitClass};
use fabrico_core::core::{Core, TickObservation};
use fabrico_core::ids::{NodeId, PortId};
use fabrico_core::state::{
    Axis, BeltTile, Dir, Footprint, GridState, Medium, Node, Port, Role, Side, TileKind,
    WireLink, effective_box, port_world,
};
use fabrico_core::wire::{WIRE_HOP_TICKS, WireInFlight};
use fabrico_protocol::{
    BeltDockView, BeltEnd, BeltView, ItemView, LabelView, NodeView, PortView, RenderPacket,
    TileKindView, TileView, WireDockView, WirePulseView, WireView, machine_kind, port_medium,
    port_role, state_tag,
};
use tokio::sync::{broadcast, watch};

use crate::driver::Host;

/// The diff broadcast channel depth. Bounded (a slow subscriber lags rather than
/// growing memory unboundedly); the watch-held keyframe lets a lagged subscriber
/// resync from the latest full frame.
const DIFF_CHANNEL_CAPACITY: usize = 256;

/// Map a live [`Node`] variant plus its declared `ports` to its `machine_kind` u8 (the
/// shared convention from `fabrico-protocol`, the single source of truth).
///
/// # The FACTORY/HANDLER arm calls the SHARED predicate (72-06, D-26)
/// A Handler is a [`Node::Factory`] (D-11 adds no `Node` variant), so this function
/// cannot emit `HANDLER` without reading `GridState.ports`, hence the second argument.
/// The rule is NOT restated here. It is
/// [`fabrico_command::is_handler_shape`](fabrico_command::is_handler_shape), which
/// `fabrico_command::grid_view::kind_byte` (the Delete-time kind CAPTURE, compared by
/// the inverse target-identity guard) and `input_apply::kind_byte` also call. If these
/// three mappings could disagree an undo would delete the wrong node, which is why they
/// changed signature in ONE commit.
///
/// # It is stricter than the servicing predicate, deliberately
/// [`admit::inbox_class`] answers "is this delivery a wire request" from port 0's medium
/// ALONE (D-16, and see `mechanical_ports_of` below, which asks it rather than testing a
/// medium itself). This answers "what is this machine called" and ALSO demands an
/// electrical Out. THE NAMING RULE IS THE STRICTER OF THE TWO: a machine named Handler
/// with no way to send an answer back is the overstating-label defect SERVE-03 exists to
/// close. The two must never be merged (R-6).
fn machine_kind_of(node: &Node, ports: Option<&[Port]>) -> u8 {
    match node {
        Node::Source(_) => machine_kind::SOURCE,
        Node::Belt(_) => machine_kind::BELT,
        Node::Tee(_) => machine_kind::TEE,
        Node::Balancer(_) => machine_kind::BALANCER,
        Node::Merge(_) => machine_kind::MERGE,
        Node::Router(_) => machine_kind::ROUTER,
        // FACTORY or HANDLER, decided by the SHARED predicate and by nothing local.
        Node::Factory(_) => {
            if fabrico_command::is_handler_shape(node, ports) {
                machine_kind::HANDLER
            } else {
                machine_kind::FACTORY
            }
        }
        Node::Sink(_) => machine_kind::SINK,
        // Explicit map (never `as u8`): the machine_kind byte order is distinct from
        // the Node discriminant order, so this Node::X => machine_kind::Y arm is the
        // only bridge. WIRE is a LIVE byte since 63-03 — the DrawWire undo inverse
        // emits `Delete { kind: machine_kind::WIRE }` and the target-identity guard
        // compares against it — so a wrong arm here is now a wrong deletion, not a
        // dormant mapping. ENDPOINT is not yet produced by any command.
        Node::Wire(_) => machine_kind::WIRE,
        Node::Endpoint(_) => machine_kind::ENDPOINT,
        // Phase 76 (SHAPE-10): a Label is Node discriminant 10 and kind byte 11.
        Node::Label(_) => machine_kind::LABEL,
    }
}

/// Derive a node's visual [`state_tag`]: `faulted` (2) wins over `working` (1)
/// wins over `idle` (0). A node that emitted on the reserved fault port this
/// tick — or that is still HOLDING an undrained fault — is faulted; else one
/// that stepped is working; else idle (VIS-03).
///
/// # Why this reads the inbox and not just the observation
///
/// **A FAILED OUTBOUND CALL USED TO RENDER AS `WORKING`, THEN GO IDLE FOREVER.**
/// The failure is not lost: `manual_inject` pushes a `CommandFailure` /
/// `CommandTimeout` / `WireOverflow` fault into the node's inbox on
/// [`FAULT_PORT`] and wakes it. But a Sink drains only `take_input(0)` — a
/// hard-coded literal, not "the first non-empty port" — so it never reads that
/// fault, and `tick`'s `produced_fault` flag is set by scanning the OUTBOX
/// only. The node was therefore woken (so it landed in `stepped`, painting
/// green) while carrying an unread failure, and nothing ever re-woke it. Every
/// kind of failed outbound action was invisible, not just the unreachable email
/// one it was filed under.
///
/// Widening the derivation here rather than changing how Sinks drain keeps the
/// fix host-side: this reads the frozen core through its existing public
/// read-only API ([`GridState::inbox_of`] + [`PortInbox::has_on`]) and writes
/// nothing, so `fabrico-core`, `fabrico-protocol`, `fabrico-scenario` and the
/// 27 golden fixtures are untouched and the core-freeze gate stays green.
///
/// # The fault now has an EXIT, and the save file now has a CEILING (PILE-09, PILE-10)
///
/// This paragraph recorded a known defect through v8.0: the undrained fault was
/// never cleared, so each failure appended one `Fault` to a snapshotted inbox
/// forever and a long-running board pointed at a dead endpoint grew its save
/// file without bound. Deterministic, so no gate reddened on it. Phase 71 closes
/// both halves, and they had to land together: bounding the queue on its own
/// would have converted silent unbounded growth into silent loss.
///
/// * **PILE-10, the exit.** A Sink and a Router now carry a real spatial
///   `Role::Fault` nub a user can drag a belt onto. When that fault port is
///   LINKED, the fold moves one resting inbox fault to the outbox per pass and
///   the generic drain routes it onto the belt, so the failures leave. The Sink
///   stops reading FAULTED here once the last one has gone.
/// * **PILE-09, the ceiling.** `admit::FAULT_QUEUE_CAP` bounds the queue. Past
///   the bound a fault is DROPPED and nothing counts it (a deliberate 2026-09-01 scope
///   decision: the two `faults` counters that exist are read by tests only and this
///   function already marks a machine FAULTED on a single unread fault, so the
///   number bought nothing a user could see).
///
/// **AN UNDOCKED FAULT PORT IS UNCHANGED, and that is the point of gating the
/// drain on the link.** With no belt drawn, the fault stays in the inbox, the
/// `holds_unread_fault` clause below keeps painting the machine FAULTED, and it
/// stays red until the board is rebuilt. That resting fault is the ONE signal a
/// user has today, and a drain that ran regardless of docking would have deleted
/// it while looking like an improvement.
///
/// # The ONE exception, which rule won, and what STAYS OPEN (72-07, D-25, R-49)
///
/// EXACTLY ONE fault reason at exactly one node clears itself, and a reader looking at
/// a red machine must not have to infer which rule applies to it. The rule is:
///
/// * [`FaultReason::NoEntryWire`](fabrico_core::fault::FaultReason::NoEntryWire),
///   resting on the node a [`EditOp::DrawWire`](fabrico_core::edit::EditOp) leaves,
///   is DRAINED BY THAT FOLD (`tick::drain_no_entry_wire_faults`). A user who posts to
///   a Route with no cable sees it go red, draws the cable, and watches it go back to
///   normal WITH NO SECOND POST.
/// * EVERY OTHER FAULT, and `NoEntryWire` at any other node, follows the paragraph
///   above unchanged: it stays red until the board is rebuilt, or until its
///   `Role::Fault` nub is docked and the PILE-10 drain routes it onto a belt.
///
/// **THE GENERAL FAULT-CLEAR LIFECYCLE STAYS OPEN.** Phase 72 does not close it and
/// does not claim to. What it settles is one node's one reason, chosen because
/// `NoEntryWire` carries an EMPTY payload and therefore has no dead letter to destroy;
/// the general problem is still that a fault with a real payload has no exit except a
/// docked nub or a rebuild. This is stated rather than ticked because the alternative is
/// a reader inferring, from one machine that clears itself, that all of them do.
///
/// The clear lives in the FOLD and not here, which is what keeps this function a PURE
/// PRESENTATION read: it borrows the core, writes nothing, and a replay of the same log
/// reproduces the same clear at the same tick.
///
/// # The fourth arm, and why its POSITION is the whole point (PILE-08, D-05)
///
/// A machine whose mechanical inbox sits AT the admission cap is refusing further
/// belt deliveries, and it reads [`state_tag::BACKED_UP`] rather than WORKING.
/// The arm is checked BEFORE the `obs.stepped` arm and that ordering is
/// load-bearing, not stylistic: `TickObservation::stepped` is extended from the
/// ACTIVE SET before the nodes are stepped, so a full machine that is woken on a tick
/// (by a delivery, say) and then held back by the output gate is in `stepped` on that
/// tick. With the arms the other way round that jammed machine would paint green, which
/// is the exact reading PILE-08 exists to replace. Do not "simplify" the order.
///
/// # The waiting arm, and why it sits AFTER `stepped` (phase 87, JAM-04, D-06, D-12)
///
/// Since phase 87 a blocked machine SLEEPS: the gate puts it in the scheduler's sleep set
/// and it leaves the active set, so on the ticks it waits it is not in `stepped` at all.
/// Read only through `stepped`, a Tee holding eight items behind two full branches would
/// paint IDLE and the jammed board would look empty. So a machine that did not step this
/// tick and waits behind its blocked output holding work
/// ([`fabrico_core::tick::waits_behind_blocked_output`], the gate's own predicate, ruling
/// R-3) reads BACKED_UP too: the jam mark the board already draws (the dimmed outline, the
/// gauge at its inbox's own level, which [`derive_load`] carries separately).
///
/// It sits AFTER the `stepped` arm, so a tick on which the machine steps reads exactly what
/// it read before phase 87. That keeps the drip a steady jam shows: the Tee emits, holds 15
/// of 16 and reads WORKING for one tick, which `77-one-board-all-five` leg 3's merged-bar
/// grader (`mergedBarAgainstDrips`, phase 84's ruling "Check against drips") counts. An arm
/// before `stepped` would turn every drip BACKED_UP and leave that grader nothing to grade.
/// A sleeper whose block has just lifted reads IDLE for the one tick before it steps (the
/// consumer wake schedules it at `now + 1`). The arm reads no scheduler state, so a board
/// restored from a save reads the same.
///
/// BACKED_UP is a pure read of inbox occupancy against the cap ([`derive_load`]
/// at its top level), and for a Source of its backlog against
/// [`admit::SOURCE_PENDING_CAP`] (plan 87-01, JAM-06), NOT "was gated off this tick". The occupancy reading is
/// stable across a tick in which the machine happened not to be woken; a
/// gated-this-tick reading would flicker with the scheduler.
///
/// A machine that is both faulted and full reports FAULTED here and STILL carries
/// `load == 4` on the wire, because [`NodeView::load`] is a separate channel. That
/// partial case is the one the UI contract calls its most load-bearing behaviour.
#[must_use]
pub fn derive_state(id: NodeId, obs: &TickObservation, state: &GridState) -> u8 {
    let holds_unread_fault = state
        .inbox_of(id)
        .is_some_and(|inbox| inbox.has_on(fabrico_core::fault::FAULT_PORT));

    if obs.faulted.contains(&id) || holds_unread_fault {
        state_tag::FAULTED
    } else if is_refusing(id, state) {
        // BEFORE the `stepped` arm on purpose - see the docblock. A full node woken and
        // gated on this tick is in the active set, so a `stepped` check first would call it
        // WORKING.
        state_tag::BACKED_UP
    } else if obs.stepped.contains(&id) {
        state_tag::WORKING
    } else if fabrico_core::tick::waits_behind_blocked_output(state, id) {
        // AFTER the `stepped` arm on purpose (phase 87, JAM-04, D-06): a machine asleep
        // behind its blocked output, holding work, wears the jam mark rather than IDLE, and a
        // tick on which it steps reads what it read before. See the docblock.
        state_tag::BACKED_UP
    } else {
        state_tag::IDLE
    }
}

/// The top gauge level: the machine's fullest mechanical inbox port is AT the
/// admission cap and is refusing. [`derive_state`] raises [`state_tag::BACKED_UP`] on
/// exactly the same condition - but it reads it through [`is_refusing`], which asks
/// the ADMISSION PATH, not through this value. See [`is_refusing`] for why that
/// indirection is the point rather than an extra hop.
pub const LOAD_FULL: u8 = 4;

/// Is this machine actually REFUSING a mechanical delivery right now?
///
/// **This is the cure for a circular cover (WR-01).** [`derive_state`]'s BACKED_UP arm
/// used to be spelled `derive_load(id, state) == LOAD_FULL`, which made the two
/// channels agree BY CONSTRUCTION: no test could ever observe the gauge disagreeing
/// with the cap, because the tag WAS the gauge. That circularity hid a real defect -
/// [`derive_load`] summed every mechanical port against a cap that is enforced PER
/// PORT, so a Merge or a Balancer (two In ports each, `port_catalog`) holding 8 and 8
/// painted BACKED_UP with eight free slots on each port and both draining. The mark
/// pointed the user at a machine that was not refusing, which is the exact inversion
/// PILE-08 and PILE-11 judgment C exist to prevent.
///
/// So the tag now asks the question the CAP answers, through the same
/// [`admit::accepts_one`] predicate the push sites themselves call, and the gauge
/// answers it from occupancy. They are two independent readings of one fact, and
/// `derive_load_bands_and_the_cross_invariant` asserts they agree - an assertion that
/// can now FAIL, which is what makes it a cover.
///
/// Only `Mechanical` ports count. `Fault` is bounded by its own cap and reported by
/// the FAULTED tag; `Electrical` is exempt entirely. [`PortInbox::ports_sorted`] yields
/// only the buckets currently holding something, which is exactly the set that can be
/// at a cap.
///
/// # The fourth state's other queue: a Source's backlog (plan 87-01, JAM-06, WINDOWS 173)
///
/// A Source has no mechanical inbox to fill. Its queue is its own backlog, the
/// `ManualInject.pending` deque the event stream pushes into, and past
/// [`admit::SOURCE_PENDING_CAP`] the admit arm drops every event it is sent (ruling R-15).
/// That Source is refusing exactly as a full machine is, so it reads BACKED_UP. The
/// question is asked through [`admit::source_accepts_one`], the function the admit arm
/// itself calls, never through a second comparison against the constant here (ruling
/// R-3). It is asked BEFORE the no-inbox early return below: a Source with no inbox entry
/// and a full backlog is still refusing. Before plan 87-01 this function read only the
/// inbox, so a Source refusing every event painted WORKING.
///
/// [`PortInbox::ports_sorted`]: fabrico_core::state::PortInbox::ports_sorted
#[must_use]
pub fn is_refusing(id: NodeId, state: &GridState) -> bool {
    if let Some(Node::Source(source)) = state.node(id)
        && !admit::source_accepts_one(source)
    {
        return true;
    }
    let Some(inbox) = state.inbox_of(id) else {
        return false;
    };
    inbox.ports_sorted().any(|port| {
        let class = admit::inbox_class(state, id, port);
        matches!(class, AdmitClass::Mechanical) && !admit::accepts_one(state, class, id, port)
    })
}

/// Derive a node's inbox fill as a LEVEL of 0 through 4 for [`NodeView::load`]
/// (PILE-08, D-04). Like [`derive_state`] this reads the frozen core through its
/// existing public read-only API ([`GridState::inbox_of`] + [`PortInbox::len_on`] +
/// [`admit::inbox_class`]) and writes nothing: no core, protocol-snapshot or
/// fixture byte moves for the gauge to exist.
///
/// # The bands
///
/// ```text
/// n == 0            -> 0
/// n >= CAP          -> 4
/// otherwise         -> 1 + (n * 3 / CAP)
/// ```
///
/// At `CAP = 16` that is `1..=5 -> 1`, `6..=10 -> 2`, `11..=15 -> 3`, `16.. -> 4`.
/// Any single resting item shows a tick; only a genuinely full inbox shows the
/// solid bar.
///
/// # A Source's backlog is the fourth state's other queue (plan 87-01, JAM-06)
///
/// A Source's queue is its `ManualInject.pending` backlog, not an inbox. It is banded the
/// same way against [`admit::SOURCE_PENDING_CAP`], and the gauge is the higher of the two
/// levels, so a Source whose backlog is full carries the merged full bar exactly when
/// [`is_refusing`] says it refuses (WINDOWS 173: before plan 87-01 it carried no gauge and
/// painted WORKING while every event it was sent was dropped).
///
/// # Why the HOST quantises and not the renderer
///
/// A raw count on the wire would force the frontend to hold a TypeScript mirror of
/// [`admit::MECHANICAL_INBOX_CAP`] in order to draw anything, and a mirrored
/// constant is the exact drift trap `frontend/src/protocol/kinds.ts`'s own header
/// warns about. The frontend receives a LEVEL, never a count and a divisor.
///
/// # Why it asks [`admit::inbox_class`] rather than testing a medium here
///
/// The cap lives in `fabrico-core` and this gauge lives in `fabrico-host`, so two
/// readings of the word "mechanical" would drift with nothing to notice: the gauge
/// would light on a wire fan-in, or stay dark on a genuinely capped port, and no
/// gate spans both crates to see it. `inbox_class` is the ONE predicate the
/// admission path itself calls (core ruling R-3).
///
/// Two consequences of that predicate worth carrying rather than discovering:
///
/// * An UNDECLARED port reads Mechanical, so a PORT-LESS collector (anything built
///   by `add_source`, which is most of the golden corpus) holding items on port 0
///   is gauged. Without that reading the bar would be dead for every core-built
///   node on the board.
/// * The reserved [`FAULT_PORT`](fabrico_core::fault::FAULT_PORT) classifies as
///   `Fault`, not Mechanical, so a queue of undrained faults never lights the
///   mechanical gauge. It is bounded by its own cap and reported by the FAULTED
///   tag instead.
///
/// The ports walked are the ones currently HOLDING items. A [`PortInbox`] is by
/// construction the INPUT side of a node, so "In ports only" is carried by reading
/// the inbox at all rather than by a second role test here - and a second predicate
/// beside `inbox_class` is the drift this function exists to avoid.
///
/// [`PortInbox`]: fabrico_core::state::PortInbox
/// [`PortInbox::len_on`]: fabrico_core::state::PortInbox::len_on
#[must_use]
pub fn derive_load(id: NodeId, state: &GridState) -> u8 {
    // A SOURCE'S BACKLOG IS GAUGED TOO (plan 87-01, JAM-06, WINDOWS 173). The backlog is
    // the fourth state's other queue (see `is_refusing`): a Source whose `pending` is at
    // `SOURCE_PENDING_CAP` refuses every event, and the merged full bar is the mark the
    // user sees, so a tag of BACKED_UP with a dark gauge would paint nothing (87-RESEARCH
    // Pitfall 5). It is read on the SAME bands as a mechanical port, `SOURCE_PENDING_CAP`
    // in place of `MECHANICAL_INBOX_CAP` (both 16), so a filling backlog shows ticks before
    // the full bar. A Source with no inbox entry is still gauged: this reading comes
    // before the inbox is looked up, and the higher of the two levels is the gauge.
    let backlog = match state.node(id) {
        Some(Node::Source(source)) => band(source.pending.len(), admit::SOURCE_PENDING_CAP),
        _ => 0,
    };
    let Some(inbox) = state.inbox_of(id) else {
        return backlog;
    };
    // THE FULLEST PORT, NOT THE TOTAL (WR-01). `admit::accepts_n` tests
    // `inbox.len_on(dest_port) + n <= MECHANICAL_INBOX_CAP` - the cap is enforced PER
    // PORT, so a node with two In ports legitimately holds 32 items before it refuses
    // anything. Summing read that node as FULL at 16 while it had eight free slots on
    // each port and was actively draining, which is a machine LYING about being
    // jammed. `port_catalog` gives BALANCER two In ports and MERGE two, so this was
    // every multi-input machine on every board, throughout PILE-11 judgment D's
    // release wave. The gauge must be read the same way the cap is enforced.
    let n: usize = inbox
        .ports_sorted()
        .filter(|&port| matches!(admit::inbox_class(state, id, port), AdmitClass::Mechanical))
        .map(|port| inbox.len_on(port))
        .max()
        .unwrap_or(0);

    band(n, admit::MECHANICAL_INBOX_CAP).max(backlog)
}

/// The gauge band of a queue holding `n` items against `cap`: `0` empty, [`LOAD_FULL`] at
/// or past the cap, otherwise `1 + (n * 3 / cap)`. One function for the inbox and the
/// Source backlog, so the two queues cannot be banded two ways.
fn band(n: usize, cap: usize) -> u8 {
    if n == 0 {
        0
    } else if n >= cap {
        LOAD_FULL
    } else {
        // Integer bands, cap-relative: 1 + (n * 3 / CAP). `n < cap` here, so the
        // result is at most 3 and the `u8` cast cannot truncate.
        u8::try_from(1 + (n * 3 / cap)).unwrap_or(LOAD_FULL)
    }
}

/// A wire pulse travelling AWAY from its origin toward a handler (the request half of
/// the request/response round-trip). The default when a message is not arriving home.
pub const WIRE_FORWARD: u8 = 0;

/// A wire pulse travelling HOME to its return address — the reply half, the "reply
/// travelling home" distinct read (WUI-01). Warmer tint + trailing glow, render-side.
pub const WIRE_REPLY: u8 = 1;

/// Derive a wire pulse's forward/reply DIRECTION host-side from observable topology
/// alone — the [`derive_state`] precedent (a presentation byte derived at packet-build
/// time from observable state, NEVER a stored/snapshotted sim field).
///
/// # Why this is derivable with ZERO new serialized field (the frozen-schema HARD STOP)
/// A [`WireLink`] is directional (`from -> to`) and every in-flight message already
/// carries the caller's logical `return_addr` ([`WireInFlight::return_addr`] — an
/// EXISTING snapshotted field this reads, never writes). The caller is BOTH a request's
/// origin and its reply target (`manual_inject.rs:149`: the entry wire is
/// `wire_from_node(return_addr.0)`), and a reply reverse-transports on the RETURN wire
/// `wire_from_node(handler)` whose `to` endpoint is that same caller (37-03). So:
/// - a message whose `return_addr` node IS this wire's delivery (`to`) endpoint is
///   ARRIVING HOME — the wire runs handler->caller, the pulse is a **REPLY**;
/// - otherwise the message is leaving its origin (`return_addr == from`) or in forward
///   transit, so the pulse is **FORWARD**.
///
/// Adding an `is_reply` bit to `WireLink.in_flight` / `WireInFlight` would be a
/// snapshotted-field change (a re-bless, closed since Phase 35) — this derivation
/// avoids it entirely by classifying the WIRE from observable endpoints + the existing
/// `return_addr`, exactly as `derive_state` classifies a node from the tick observation.
///
/// # Totality / unambiguity
/// On the two request/response topologies that ship this milestone — the single-hop
/// headline (caller<->handler) and a one-level fan-out (one handler <-> N downstream
/// handlers) — every in-flight message's `return_addr` is EXACTLY one of the wire's two
/// endpoints (`from` for a forward pulse, `to` for a reply pulse), so a wire is never
/// classified as both. (A deep pure-forwarding chain, where `return_addr` is not
/// rewritten at intermediate hops, is out of scope this milestone; such an intermediate
/// return wire would default to FORWARD — documented, not silently wrong.)
#[must_use]
pub fn derive_wire_direction(link: &WireLink, msg: &WireInFlight) -> u8 {
    if msg.return_addr.0 == link.to.0 {
        WIRE_REPLY
    } else {
        WIRE_FORWARD
    }
}

/// The wire `u8` a core [`Role`] rides as (`In=0, Out=1, Fault=2`). An explicit
/// match (not an `as u8` cast) decouples the wire value from the enum's in-memory
/// layout — exactly the `dir_u8`/`axis_u8` pattern (PORT-02). `Role::Fault`
/// (17-01) rides as [`port_role::FAULT`], the byte the render-packet golden already
/// reserves so the renderer styles a fault nub distinctly.
fn role_u8(role: Role) -> u8 {
    match role {
        Role::In => port_role::IN,
        Role::Out => port_role::OUT,
        Role::Fault => port_role::FAULT,
    }
}

/// The wire `u8` a core [`Medium`] rides as (`Mechanical=0, Electrical=1`). An
/// explicit match (not an `as u8` cast) decouples the wire value from the enum's
/// in-memory layout — the same `role_u8`/`side_u8` pattern (PORT-02, 35-03).
fn medium_u8(medium: Medium) -> u8 {
    match medium {
        Medium::Mechanical => port_medium::MECHANICAL,
        Medium::Electrical => port_medium::ELECTRICAL,
    }
}

/// The wire `u8` a core [`Side`] rides as (`N=0, E=1, S=2, W=3`) — the numeric order
/// core already pins, matched explicitly. `port_world` returns the ALREADY
/// rot-applied world side, so this receives the resolved side (zero TS rotation
/// math, PORT-01).
fn side_u8(side: Side) -> u8 {
    match side {
        Side::N => 0,
        Side::E => 1,
        Side::S => 2,
        Side::W => 3,
    }
}

/// The numeric `u8` a core [`Axis`] rides as on the integer wire (`X=0, Y=1`) — the
/// protocol-local [`TileKindView`] convention. An explicit match (not an `as u8`
/// cast) keeps the wire value decoupled from the core enum's in-memory layout.
fn axis_u8(axis: Axis) -> u8 {
    match axis {
        Axis::X => 0,
        Axis::Y => 1,
    }
}

/// The numeric `u8` a core [`Dir`] rides as on the integer wire
/// (`N=0, E=1, S=2, W=3`) — the protocol-local [`TileKindView`] convention.
fn dir_u8(dir: Dir) -> u8 {
    match dir {
        Dir::N => 0,
        Dir::E => 1,
        Dir::S => 2,
        Dir::W => 3,
    }
}

/// Map a core [`BeltTile`] into the protocol-local wire [`TileView`] — integer-only
/// (cell coords + numeric Axis/Dir bytes), no float crosses the wire (T-14-FLOAT-LEAK).
fn tile_view_of(tile: &BeltTile) -> TileView {
    let kind = match tile.tile_kind() {
        TileKind::Straight { axis } => TileKindView::Straight {
            axis: axis_u8(axis),
        },
        TileKind::Corner { from, to } => TileKindView::Corner {
            from: dir_u8(from),
            to: dir_u8(to),
        },
    };
    TileView {
        cell_x: tile.cell.0,
        cell_y: tile.cell.1,
        kind,
    }
}

/// Resolve a wire endpoint `(node, port)` to its world electrical terminal
/// ([`WireDock`] `{ cell, side, body }`) via core [`port_world`] — the integer input
/// [`wire_route_avoiding`] auto-routes the cable cell-path from. Degrades to the node's cell
/// facing `N` when the port index is missing (a forged/inert wire never panics —
/// SCHEMA-03). Read-only: reads `cell_of`/`footprint_of`/`ports_of`, mutates nothing.
///
/// THE `rot` DECODE IS ONE EXPRESSION IN THIS LANGUAGE AND IT IS NOT WRITTEN HERE.
/// CORRECTED 2026-09-04 (phase 72 review WR-01). This docblock used to claim the decode
/// "lives here", and described the expression below it as "copied verbatim from core
/// `cells_of_footprint`" - which is an accurate description of a DUPLICATION, not of a
/// shared source. There were three copies of the `(rot & 1)` swap: core `state.rs`, this
/// function, and `frontend/src/protocol/footprint.ts`, and only the TypeScript one had an
/// owner. Core `state::effective_box` is now the owner for Rust, called by
/// `cells_of_footprint` and by this function, and its docblock carries why a second copy
/// at a call site is the one drift surface the wire parity corpus structurally cannot see.
/// The DEGRADED branch below sets `body` too - that branch is missing the PORT, not the
/// footprint, so its rectangle is just as real. `max = anchor + dim - 1` stays here: it is
/// this function's rectangle convention, not part of the swap.
fn resolve_wire_dock(core: &Core, endpoint: (NodeId, PortId)) -> WireDock {
    let (node, port_id) = endpoint;
    let cell = core.state.cell_of(node).unwrap_or((0, 0));
    let fp = core
        .state
        .footprint_of(node)
        .unwrap_or(Footprint { w: 1, h: 1, rot: 0 });
    let body = wire_body_of(core, node);
    if let Some(port) = core
        .state
        .ports_of(node)
        .and_then(|ps| ps.get(port_id as usize))
    {
        let (world_cell, world_side) = port_world(cell, fp.w, fp.h, fp.rot, port);
        WireDock {
            cell: world_cell,
            side: side_u8(world_side),
            body,
        }
    } else {
        WireDock {
            cell,
            side: 0,
            body,
        }
    }
}

/// The inclusive world cell box of `node`, rotation applied: the rectangle a wire dock on
/// `node` carries ([`resolve_wire_dock`]) and the rectangle `node` blocks in every other
/// cable's way ([`wire_obstacles`]). ONE expression for both, so the endpoint filter inside
/// [`wire_route_avoiding`] (which drops every machine rectangle holding a dock cell) sees the
/// very rectangle the dock was resolved against.
///
/// The cell and footprint defaults are the ones the `NodeView` this node ships as uses (cell
/// `(0, 0)`, a 1x1 rot-0 footprint), so the drag preview, which builds its machine list from
/// the packet's `NodeView`s through `bodyOfNode`, reads the same box.
fn wire_body_of(core: &Core, node: NodeId) -> WireBody {
    let cell = core.state.cell_of(node).unwrap_or((0, 0));
    let fp = core
        .state
        .footprint_of(node)
        .unwrap_or(Footprint { w: 1, h: 1, rot: 0 });
    let (bw, bh) = effective_box(fp.w, fp.h, fp.rot);
    WireBody {
        min_x: cell.0,
        min_y: cell.1,
        max_x: cell.0 + bw - 1,
        max_y: cell.1 + bh - 1,
    }
}

/// THE MACHINE LIST every cable of one packet is routed around (phase 92, D-09, CHROME-19):
/// the box of every live node whose kind byte `is_wire_obstacle` accepts (every kind but a
/// belt, a wire and a label), through [`wire_body_of`], sorted by `(min_x, min_y, max_x,
/// max_y)`. Built ONCE per [`current_views`](RenderPacketBuilder::current_views) call, before
/// its node loop, and handed to every wire, so no cable of a packet can see a different
/// board from another.
///
/// The drag preview builds the same list from the packet's own nodes (`ghostLeg` in
/// `frontend/src/input/gestures.ts`: `getScene().nodes` through `bodyOfNode`, filtered by
/// `isWireObstacle`), and `fabrico-command/tests/ts_wire_obstacle_mirror.rs` locks the two
/// predicates together over every kind byte, so the preview shows the path the cable lands
/// on. A `Vec`, sorted, never a hash map: the packet inherits the sim's iteration discipline,
/// though the router's answer does not depend on the order it is handed.
///
/// RENDER-ONLY. The list and every path routed from it are computed per packet and never
/// saved: no core state, snapshot, log record or golden reads them.
fn wire_obstacles(core: &Core) -> Vec<WireBody> {
    let mut machines: Vec<WireBody> = core
        .state
        .node_ids()
        .filter(|&id| {
            core.state
                .node(id)
                .is_some_and(|node| is_wire_obstacle(machine_kind_of(node, core.state.ports_of(id))))
        })
        .map(|id| wire_body_of(core, id))
        .collect();
    machines.sort_by_key(|b| (b.min_x, b.min_y, b.max_x, b.max_y));
    machines
}

/// THE NAMED FALLBACK for a wire the router refuses (75-03, D-05, CABLE-09 part 2;
/// `75-UI-SPEC.md` section 2.2): two cells, the source port's cell and then the cell its
/// outward normal faces.
///
/// # Why it exists
/// Until 75-03 the Node::Wire arm below did `wire_route(..).unwrap_or_default()`, so a
/// refused pair shipped an EMPTY path: no surface draws an empty path, and nothing logged
/// it. A wire that exists in the model and is drawn as nothing is a silent wrong picture.
/// The router now refuses two docks on one cell with a typed error (only a forged packet
/// or a damaged port reference reaches that: no gesture can), and this function is what
/// the host draws instead, so the result is NEVER FEWER THAN TWO CELLS.
///
/// # The second cell
/// The cell `from`'s normal faces, when that cell is on the grid (`GRID_MIN..=GRID_MAX`
/// on both axes). If it is off the grid, or the side byte is forged so the normal is
/// `(0, 0)`, the first orthogonal neighbour ON the grid, scanning N, E, S, W. If the source
/// cell is itself so far off the grid that no neighbour is on it (a forged cell), the scan's
/// first neighbour, N, is used anyway: two cells beat none.
///
/// The two cells are normalised through `route()`, the same normaliser every cable goes
/// through, so the stub is an ordinary straight cable of two tiles. How its two ends are
/// DRAWN (the source nub and the nub elbow on the far end) is the wire layer's job (plan
/// 75-05), not this function's. No colour or field marks it as a fallback: that would be a
/// new field on `WireView`, a protocol schema change this phase rules out.
#[must_use]
pub fn fallback_stub(from: WireDock) -> Vec<TileView> {
    let a = from.cell;
    let on_grid = |c: (i32, i32)| {
        (GRID_MIN..=GRID_MAX).contains(&c.0) && (GRID_MIN..=GRID_MAX).contains(&c.1)
    };
    let step = |d: (i32, i32)| (a.0 + d.0, a.1 + d.1);
    let n = normal(from.side);
    let faced = step(n);
    let second = if n != (0, 0) && on_grid(faced) {
        faced
    } else {
        // N, E, S, W: the side numbering, read through `normal` (no local table).
        (0u8..4)
            .map(|s| step(normal(s)))
            .find(|&c| on_grid(c))
            .unwrap_or_else(|| step(normal(0)))
    };
    match route(&[a, second]) {
        Ok(tiles) => tiles.iter().map(tile_view_of).collect(),
        // Unreachable: two distinct, orthogonally adjacent cells are exactly what `route()`
        // accepts. Kept total rather than panicking inside a render packet; the straight
        // pair below is what `route()` itself emits for such a list.
        Err(_) => {
            let axis = if second.0 != a.0 { 0 } else { 1 };
            [a, second]
                .iter()
                .map(|&(x, y)| TileView {
                    cell_x: x,
                    cell_y: y,
                    kind: TileKindView::Straight { axis },
                })
                .collect()
        }
    }
}

/// Builds the per-tick [`RenderPacket`]: owns the dense `NodeId → u64` handle table
/// and the previously-emitted snapshot for the active-set diff.
#[derive(Debug, Default)]
pub struct RenderPacketBuilder {
    /// Dense, host-assigned handles (monotonic from 0 — NOT `as_ffi`, A3).
    handles: BTreeMap<NodeId, u64>,
    /// The same table read the other way, `handle -> NodeId`, written beside `handles` in
    /// [`handle_for`](Self::handle_for) (phase 88, D-02). It is what a gesture's handle is
    /// resolved through, and what [`RenderProducer`] keeps of an outgoing table at a reset.
    /// Like `handles` it is never pruned: a deleted node's handle keeps naming its dead id,
    /// which `validate_normalize` refuses as `UnknownNode`.
    nodes_by_handle: BTreeMap<u64, NodeId>,
    /// Next free dense handle.
    next_handle: u64,
    /// The last emitted NodeView per handle (the diff baseline).
    prev_nodes: BTreeMap<u64, NodeView>,
    /// The last emitted BeltView per handle (the diff baseline).
    prev_belts: BTreeMap<u64, BeltView>,
    /// The last emitted WireView per handle (the diff baseline). A wire with active
    /// pulses changes each tick (so it re-emits); an idle wire is byte-stable, so it
    /// drops out of the diff — the active-set discipline (WUI-01).
    prev_wires: BTreeMap<u64, WireView>,
    /// How many wire projections this builder has drawn with [`fallback_stub`] because
    /// the router refused the pair (75-03, CABLE-09). Counted PER BUILDER CALL: both
    /// [`build`](Self::build) and [`build_keyframe`](Self::build_keyframe) project every
    /// wire, so one refused wire adds one per call, not one per tick. Read through
    /// [`wire_route_failures`](Self::wire_route_failures) by tests and logs; never shown
    /// to the user.
    wire_route_failures: u64,
    /// THE ROUTE MEMO (review fix pass 1, WR-A-03, threats T-92-06 and T-92-10): the machine
    /// list the memo's routes were computed around, and one router answer per cable, keyed
    /// by its two docks ([`wire_memo_key`]). `wire_route_avoiding` is a pure function of
    /// those inputs, so a hit answers exactly what a fresh call would; any change to the
    /// list drops every entry, and each [`current_views`](Self::current_views) call keeps
    /// only the cables it drew. So a quiet tick routes no cable, and its second build (the
    /// keyframe) reuses the first's answers: the audit measured 12 ms per tick at 2,025
    /// machines and 1,000 cables, and 819 ms on a forged 6,400-machine board, every tick, on
    /// the sim thread. RENDER-ONLY and never saved, like the routes themselves; a `BTreeMap`,
    /// never a hash map.
    wire_memo_board: Vec<WireBody>,
    wire_memo: BTreeMap<[i32; 14], Result<WireGeometry, WireRouteError>>,
    /// How many times this builder has called the router (review fix pass 1), read through
    /// [`wire_routes_computed`](Self::wire_routes_computed) by the memo's tests.
    wire_routes_computed: u64,
}

/// The memo key of a cable: both docks' cells, sides and bodies, every input
/// `wire_route_avoiding` reads besides the machine list.
fn wire_memo_key(from: WireDock, to: WireDock) -> [i32; 14] {
    let d = |w: WireDock| {
        [w.cell.0, w.cell.1, i32::from(w.side), w.body.min_x, w.body.min_y, w.body.max_x, w.body.max_y]
    };
    let (a, b) = (d(from), d(to));
    [a[0], a[1], a[2], a[3], a[4], a[5], a[6], b[0], b[1], b[2], b[3], b[4], b[5], b[6]]
}

impl RenderPacketBuilder {
    /// A fresh builder (empty handle table, empty diff baseline).
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// The live [`NodeId`] a dense render handle currently maps to, if any — the
    /// INVERSE of the handle table the frontend sees in [`NodeView`](fabrico_protocol::NodeView)`.id`.
    /// `input_apply` (07-06) builds its gesture handle→`NodeId` resolver from this so a
    /// `Wire`/`Delete` carrying a dense handle resolves back to the core's id (an
    /// unmapped handle is `None` → `CommandError::UnknownNode`). Read-only; never mints.
    pub fn node_for_handle(&self, handle: u64) -> Option<NodeId> {
        self.nodes_by_handle.get(&handle).copied()
    }

    /// The whole `handle -> NodeId` table, read-only (phase 88, D-02).
    fn handle_table(&self) -> &BTreeMap<u64, NodeId> {
        &self.nodes_by_handle
    }

    /// Give up the `handle -> NodeId` table, for [`RenderProducer::reset`] to keep.
    fn into_handle_table(self) -> BTreeMap<u64, NodeId> {
        self.nodes_by_handle
    }

    /// The dense render handle currently assigned to `id`, if any — the FORWARD
    /// direction of [`node_for_handle`](Self::node_for_handle). Read-only (never
    /// mints): a node the builder has not yet emitted is `None`. The frontend already
    /// sees this handle on every [`NodeView`](fabrico_protocol::NodeView)`.id`; this
    /// accessor lets a test / caller reverse a known [`NodeId`] back to the handle the
    /// config-query commands (`QueryConfig`/`QueryWebhookUrl`) take.
    #[must_use]
    pub fn handle_for_node(&self, id: NodeId) -> Option<u64> {
        self.handles.get(&id).copied()
    }

    /// How many wire projections this builder has drawn with [`fallback_stub`] because the
    /// router refused the pair (75-03, CABLE-09): one per refused wire per
    /// [`build`](Self::build) or [`build_keyframe`](Self::build_keyframe) call. Zero on
    /// every board a gesture can build.
    #[must_use]
    pub fn wire_route_failures(&self) -> u64 {
        self.wire_route_failures
    }

    /// How many times this builder has called the router since it was made (review fix pass
    /// 1): one per cable whose docks or board changed since the last
    /// [`current_views`](Self::current_views) call, none for a cable the route memo answers.
    #[must_use]
    pub fn wire_routes_computed(&self) -> u64 {
        self.wire_routes_computed
    }

    /// The dense handle for `id`, assigning a new monotonic one on first sight.
    fn handle_for(&mut self, id: NodeId) -> u64 {
        if let Some(&h) = self.handles.get(&id) {
            return h;
        }
        let h = self.next_handle;
        self.next_handle += 1;
        self.handles.insert(id, h);
        self.nodes_by_handle.insert(h, id);
        h
    }

    /// The per-end docks of a belt as wire [`BeltDockView`]s (PORT-03), read from the
    /// core link graph exactly where `fold_dock` writes them — but keeping the
    /// `(node, port)` handle instead of resolving to a cell (FORK B), so the `docks`
    /// LIST is invariant under a docked node's move: its handles do not change. The
    /// belt's `tiles` are NOT: since plan 74.1-07 they are derived through
    /// `effective_belt_tiles` from the docked partner's CURRENT port geometry, so a
    /// partner move or Rotate that changes a seam kind changes the `BeltView` and the
    /// diff re-emits the belt, which `tests/seam_corner.rs`
    /// `partner_rotate_reemits_the_belt_on_the_diff_path` pins (review IN-01).
    /// Replaces the removed cell-resolving belt-endpoints derivation. Deterministic
    /// order: Head (if any) before Tail (if any).
    ///
    /// `upstreams` is this belt's entry in the packet's ONE reverse link index (target to
    /// sources, built once per packet in [`current_views`](Self::current_views)): every
    /// `(node, port)` linked onto `(belt, 0)`, in ascending `links_iter` key order.
    fn belt_docks(
        &mut self,
        core: &Core,
        belt: NodeId,
        upstreams: &[(NodeId, PortId)],
    ) -> Vec<BeltDockView> {
        let mut docks = Vec::new();
        // Head dock (LOAD, belt->machine): link((belt,0) -> (node,port)).
        if let Some((node, port)) = core.state.link_target((belt, 0)) {
            docks.push(BeltDockView {
                end: BeltEnd::Head,
                node: self.handle_for(node),
                port,
            });
        }
        // Tail docks (OFFLOAD, upstream->belt): EVERY link whose TARGET is (belt,0),
        // not the first one a lookup reaches (LINK-13, WINDOWS 139).
        //
        // THE ASYMMETRY WITH THE HEAD BRANCH IS REAL, NOT AN OVERSIGHT. A
        // `(node, port)` has at most one OUTGOING link, because `links` is keyed by
        // the FROM pair, so the Head branch above is a map lookup and is exact by
        // construction. Any number of links may TARGET `(belt, 0)`, so the Tail side
        // needs a walk. Since plan 74.1-07 that walk happens ONCE PER PACKET, in
        // `current_views`, which builds the reverse link index both this list and the
        // seam derivation read; `upstreams` is this belt's slice of it, already in
        // `links_iter` order. Until phase 74 it was a find-first bind, which reported one
        // upstream and silently dropped the rest; 74-02 made a belt-to-belt dock
        // user-constructible, at which point that dropped upstream stopped being a
        // characterisation and became the belt panel's run count changing depending
        // on which tile the user pressed.
        //
        // ORDER IS `links_iter`'s ASCENDING BTreeMap KEY ORDER and nothing else. It is
        // deterministic by construction, so the docks vector is byte-stable
        // tick-over-tick and a fan-in adds no churn to the active-set diff. The
        // results are NOT re-sorted and NOT collected through a `std::HashMap`:
        // `fabrico-core` forbids `HashMap` iteration in the sim for exactly this
        // reason, and the render packet inherits the discipline.
        //
        for &(node, port) in upstreams {
            docks.push(BeltDockView {
                end: BeltEnd::Tail,
                node: self.handle_for(node),
                port,
            });
        }
        docks
    }

    /// Build the current `(NodeView, BeltView)` view of every live node, keyed by
    /// dense handle. Non-belt nodes become [`NodeView`]s (cell from core `GridState`,
    /// state from the observation); belts become [`BeltView`]s (endpoints from the
    /// linked nodes' cells, items + fill from `in_flight`).
    fn current_views(
        &mut self,
        host: &Host,
    ) -> (
        BTreeMap<u64, NodeView>,
        BTreeMap<u64, BeltView>,
        BTreeMap<u64, WireView>,
    ) {
        let core = host.core();
        let obs = &core.last_tick;
        let mut nodes = BTreeMap::new();
        let mut belts = BTreeMap::new();
        let mut wires = BTreeMap::new();
        // THE ONE REVERSE LINK INDEX PER PACKET (plan 74.1-07): link target -> every
        // source linked onto it. `links_iter` walks the link BTreeMap in ascending key
        // order and each push appends, so every source list is in that order, the order
        // both readers below require. Built once here and read by `belt_docks` (the Tail
        // dock list) and by `effective_belt_tiles` (the Tail seam feeds), so docks and
        // seams together cost O(links) per packet rather than O(belts x links). A
        // BTreeMap, never a HashMap: the packet inherits the sim's iteration discipline.
        let mut sources_of: BTreeMap<(NodeId, PortId), Vec<(NodeId, PortId)>> = BTreeMap::new();
        for (from, to) in core.state.links_iter() {
            sources_of.entry(to).or_default().push(from);
        }
        // THE ONE MACHINE LIST PER PACKET (phase 92, D-09): every cable below is routed around
        // the same boxes, read once here from `core.state`. See `wire_obstacles`.
        let machines = wire_obstacles(core);
        // THE ROUTE MEMO: the entries routed around this very list survive; the drawn cables
        // are carried into `memo_next`, so a cable that left the board leaves the memo.
        let mut memo = std::mem::take(&mut self.wire_memo);
        if machines != self.wire_memo_board {
            memo.clear();
            self.wire_memo_board.clone_from(&machines);
        }
        let mut memo_next: BTreeMap<[i32; 14], Result<WireGeometry, WireRouteError>> = BTreeMap::new();
        for id in core.state.node_ids() {
            let node = core
                .state
                .node(id)
                .expect("node_ids yields only live node ids");
            let handle = self.handle_for(id);
            match node {
                Node::Belt(belt) => {
                    // Phase-11 slot model: items + fill come from the occupied slots.
                    // NB: the real per-tile BeltView{+tiles} render contract (true
                    // per-slot positions) is Phase 14 / REND-01 — OUT OF SCOPE here;
                    // this minimal mapping keeps the host compiling + behaviourally
                    // sane (the slot INDEX stands in for `arrival_tick`, `latency` is
                    // derived from the slot length).
                    let items: Vec<ItemView> = belt
                        .slots
                        .iter()
                        .enumerate()
                        .filter_map(|(i, slot)| {
                            slot.as_ref().map(|item| ItemView {
                                arrival_tick: i as u64,
                                // The visual class is the item's leading byte (a colour
                                // bucket), not the payload — 0 for an empty item.
                                tag: item.0.first().copied().unwrap_or(0),
                            })
                        })
                        .collect();
                    // fill = occupied-slot count, saturating into u16 (never floats).
                    let fill = belt
                        .slots
                        .iter()
                        .filter(|s| s.is_some())
                        .count()
                        .min(u16::MAX as usize) as u16;
                    // latency derived from the slot length (a sane non-zero proxy for
                    // the renderer's elapsed-tick divisor until Phase 14's per-tile view).
                    let latency = belt.slots.len().min(u32::MAX as usize).max(1) as u32;
                    // SLOT-03 (D-08): the belt's OWN advance interval, projected from
                    // core state on every packet. `NonZeroU32 -> u32` via `.get()`
                    // because the wire grammar carries plain integers only; the
                    // non-zero invariant stays in the core, where the type enforces
                    // it. The renderer derives the tread's px-per-tick from this, so
                    // it never re-types a core constant render-side.
                    let ticks_per_slot = belt.ticks_per_slot.get();
                    // REND-01: ship the belt's resolved per-tile geometry from core
                    // `Belt.geometry`. EMPTY for a Wire-minted logical belt (the
                    // renderer falls back to the straight from/to line); length ==
                    // tiles for a DrawBelt-drawn belt. (The per-slot item->tile
                    // position fidelity stays the stand-in above — RESEARCH Open Q6 /
                    // paired with the 14-05 TS interp + manual visual check.)
                    //
                    // THE SEAM RULE (phase 74.1 gap closure, 74.1-SEAM-DESIGN.md section
                    // 2): the tiles ship AS DRAWN. `effective_belt_tiles` re-kinds each
                    // DOCKED end from what its seam says now (a perpendicular dock draws a
                    // 90 degree corner), and writes nothing back, so the stored geometry
                    // stays route()'s authored shape. THIS IS THE ONLY RUST PLACE A BELT'S
                    // TILES BECOME WHAT IS DRAWN. The stored geometry is the fallback only
                    // if the derivation answers `None`, which a live belt id never does.
                    let upstreams: &[(NodeId, PortId)] =
                        sources_of.get(&(id, 0)).map_or(&[], Vec::as_slice);
                    let drawn = core.state.effective_belt_tiles(id, Some(upstreams));
                    let tiles: Vec<TileView> = match drawn {
                        Some(drawn) => drawn.iter().map(tile_view_of).collect(),
                        None => belt.geometry.iter().map(tile_view_of).collect(),
                    };
                    // PORT-03: per-end docks from the (belt,0) link graph (Head/Tail),
                    // keeping (node, port) handles rather than resolved cells.
                    let docks = self.belt_docks(core, id, upstreams);
                    belts.insert(
                        handle,
                        BeltView {
                            id: handle,
                            latency,
                            fill,
                            items,
                            tiles,
                            docks,
                            ticks_per_slot,
                        },
                    );
                }
                Node::Wire(link) => {
                    // WUI-01: a Node::Wire projects to a real WireView instead of a
                    // degenerate NodeView(0,0). Resolve both electrical terminals,
                    // auto-route the cable through wire_route_avoiding around the packet's
                    // one machine list (phase 92, D-09: today's path whenever it enters no
                    // machine, else the shortest way round; corners inherit belt parity),
                    // and project each in-flight message into a pulse whose
                    // direction is HOST-DERIVED from observable topology (never a
                    // snapshotted field — the derive_state precedent).
                    let from_dock = resolve_wire_dock(core, link.from);
                    let to_dock = resolve_wire_dock(core, link.to);
                    // NEVER AN EMPTY PATH (75-03, D-05, CABLE-09). A refused pair is drawn
                    // as the named two-cell `fallback_stub` and counted; it used to be
                    // `unwrap_or_default`, an empty path no surface draws and nothing logged.
                    let key = wire_memo_key(from_dock, to_dock);
                    let routed = match memo_next.get(&key).cloned().or_else(|| memo.remove(&key)) {
                        Some(r) => r,
                        None => {
                            self.wire_routes_computed += 1;
                            wire_route_avoiding(from_dock, to_dock, &machines)
                        }
                    };
                    let path: Vec<TileView> = match &routed {
                        Ok(g) => g.tiles.iter().map(tile_view_of).collect(),
                        Err(e) => {
                            // ONE standard-error line per builder, the first time the count
                            // leaves zero, never one per tick: `current_views` runs in both
                            // `build` and `build_keyframe` on every tick.
                            if self.wire_route_failures == 0 {
                                eprintln!(
                                    "fabrico-host: wire {handle} could not be routed ({e:?}); \
                                     drawing a two-cell stub from its source port"
                                );
                            }
                            self.wire_route_failures += 1;
                            fallback_stub(from_dock)
                        }
                    };
                    memo_next.insert(key, routed);
                    // In-flight request/reply pulses — EMPTY for an idle wire (the
                    // active-set discipline: nothing in flight => nothing to animate).
                    let pulses: Vec<WirePulseView> = link
                        .in_flight
                        .iter()
                        .map(|msg| WirePulseView {
                            entry_tick: msg.entry_tick,
                            hop_ticks: WIRE_HOP_TICKS.min(u64::from(u32::MAX)) as u32,
                            direction: derive_wire_direction(link, msg),
                        })
                        .collect();
                    let from = WireDockView {
                        node: self.handle_for(link.from.0),
                        port: link.from.1,
                    };
                    let to = WireDockView {
                        node: self.handle_for(link.to.0),
                        port: link.to.1,
                    };
                    wires.insert(
                        handle,
                        WireView {
                            id: handle,
                            from,
                            to,
                            path,
                            pulses,
                        },
                    );
                }
                other => {
                    let cell = core.state.cell_of(id).unwrap_or((0, 0));
                    // REND-01: footprint dims/rotation from core (the authoritative
                    // source). ABSENT footprint => the faithful 1x1 rot0 default (the
                    // append-only convention). The renderer drives orientation from
                    // `rot` (the cosmetic `orient` was removed in Phase 16, CLEAN-02).
                    let fp = core
                        .state
                        .footprint_of(id)
                        .unwrap_or(Footprint { w: 1, h: 1, rot: 0 });
                    // PORT-01: host-resolve each rot-0 port to its WORLD cell + side via
                    // core `port_world` (rot applied in-core → zero TS math). Port-index
                    // order is preserved (deterministic — PORT-04); a port-less node
                    // (ports_of == None) yields an empty vec.
                    let ports: Vec<PortView> = core
                        .state
                        .ports_of(id)
                        .unwrap_or(&[])
                        .iter()
                        .enumerate()
                        .map(|(i, port)| {
                            let (world_cell, world_side) =
                                port_world(cell, fp.w, fp.h, fp.rot, port);
                            PortView {
                                index: i as u16,
                                cell_x: world_cell.0,
                                cell_y: world_cell.1,
                                side: side_u8(world_side),
                                role: role_u8(port.role),
                                medium: medium_u8(port.medium),
                            }
                        })
                        .collect();
                    nodes.insert(
                        handle,
                        NodeView {
                            id: handle,
                            // `other` is the node at `id` and the ports are read for
                            // that SAME id (the `ports` vec above comes from
                            // `ports_of(id)`), so the two halves cannot come from
                            // different nodes.
                            kind: machine_kind_of(other, core.state.ports_of(id)),
                            cell_x: cell.0,
                            cell_y: cell.1,
                            state: derive_state(id, obs, &core.state),
                            w: fp.w,
                            h: fp.h,
                            rot: fp.rot,
                            ports,
                            load: derive_load(id, &core.state),
                            // Phase 76 (plan 76-02, D-02): a label's committed words and
                            // colour, `None` for every other kind. No extra diff code: the
                            // packet diff below compares whole `NodeView`s, so a changed
                            // text, colour or size re-emits the node on its own.
                            label: match other {
                                Node::Label(l) => Some(LabelView {
                                    text: l.text.clone(),
                                    colour: l.colour.to_byte(),
                                }),
                                _ => None,
                            },
                        },
                    );
                }
            }
        }
        self.wire_memo = memo_next;
        (nodes, belts, wires)
    }

    /// Build the per-tick active-set DIFF packet (`full:false`): only nodes/belts
    /// that changed since the last `build`, plus the handles removed this tick.
    /// Updates the diff baseline. An unchanged grid yields an empty diff.
    pub fn build(&mut self, host: &Host) -> RenderPacket {
        let tick = host.core().tick;
        let (cur_nodes, cur_belts, cur_wires) = self.current_views(host);

        // Changed/new nodes (ascending handle order — BTreeMap iteration).
        let placed: Vec<NodeView> = cur_nodes
            .iter()
            .filter(|(h, nv)| self.prev_nodes.get(*h) != Some(*nv))
            .map(|(_, nv)| nv.clone())
            .collect();
        // Changed/new belts.
        let belts: Vec<BeltView> = cur_belts
            .iter()
            .filter(|(h, bv)| self.prev_belts.get(*h) != Some(*bv))
            .map(|(_, bv)| bv.clone())
            .collect();
        // Changed/new wires (WUI-01) — an idle wire is byte-stable and drops out.
        let wires: Vec<WireView> = cur_wires
            .iter()
            .filter(|(h, wv)| self.prev_wires.get(*h) != Some(*wv))
            .map(|(_, wv)| wv.clone())
            .collect();
        // Removed = handles in the baseline (node OR belt OR wire) no longer live.
        let mut removed: Vec<u64> = self
            .prev_nodes
            .keys()
            .filter(|h| !cur_nodes.contains_key(*h))
            .chain(
                self.prev_belts
                    .keys()
                    .filter(|h| !cur_belts.contains_key(*h)),
            )
            .chain(
                self.prev_wires
                    .keys()
                    .filter(|h| !cur_wires.contains_key(*h)),
            )
            .copied()
            .collect();
        removed.sort_unstable();

        self.prev_nodes = cur_nodes;
        self.prev_belts = cur_belts;
        self.prev_wires = cur_wires;

        RenderPacket {
            tick,
            full: false,
            placed,
            removed,
            belts,
            // UNDO-06: availability MUST ride the DIFF path, not only keyframes —
            // can_undo flips true on the first normal placement (a diff), so a
            // keyframe-only read would leave the buttons disabled until the next
            // reset (Pitfall 5). Render-only, not hashed.
            can_undo: host.can_undo(),
            can_redo: host.can_redo(),
            wires,
            // 73-12 (WR-01): never set by the producer. A diff is not a keyframe at
            // all, so the flag is meaningless here and false is the honest value. Only
            // a transport's lag-resync arm sets it.
            resync: false,
            // Phase 88 (D-02): the builder does not know which generation it belongs to.
            // `RenderProducer` stamps its own counter on every packet before encoding it
            // (`stamp`); a builder used without a producer (tests) leaves it at 0.
            generation: 0,
            // Phase 88 security (T-88-11): stamped by `RenderProducer` with the generation.
            swap_floor: 0,
        }
    }

    /// Build a full KEYFRAME packet (`full:true`): every live node + belt, no
    /// removals — for a freshly-subscribed transport. Does NOT touch the diff
    /// baseline (the diff stream continues uninterrupted for existing subscribers).
    pub fn build_keyframe(&mut self, host: &Host) -> RenderPacket {
        let tick = host.core().tick;
        let (cur_nodes, cur_belts, cur_wires) = self.current_views(host);
        RenderPacket {
            tick,
            full: true,
            placed: cur_nodes.into_values().collect(),
            removed: Vec::new(),
            belts: cur_belts.into_values().collect(),
            // UNDO-06: keyframe carries live availability too, so a freshly-
            // subscribed transport greys the toolbar correctly on first paint.
            can_undo: host.can_undo(),
            can_redo: host.can_redo(),
            // WUI-01: every live wire ships on the keyframe (append-LAST).
            wires: cur_wires.into_values().collect(),
            // 73-12 (WR-01): FALSE here, and that is the whole point of the field.
            // Every keyframe this producer builds is either a fresh subscription or a
            // genuine RESTRUCTURE (undo, redo, load, New, scene swap), and a client
            // holding an unacknowledged port edit is right to release its latch on one.
            // A LAG RESYNC re-sends this same keyframe to a connection that fell behind,
            // where the timeline did NOT move and releasing is the releases-too-early
            // direction. The transports flip the bit on that path, through
            // `RenderRelay::lagged`, and only when no reset fell in the lag; nothing here
            // does.
            resync: false,
            // Phase 88 (D-02): stamped by `RenderProducer` before encoding, as on `build`.
            generation: 0,
            // Phase 88 security (T-88-11): stamped with the generation, as on `build`.
            swap_floor: 0,
        }
    }
}

/// Re-tag encoded keyframe bytes as a LAG RESYNC (73-12, 73-REVIEW WR-01), returning the
/// re-encoded frame.
///
/// # Private, and reached only through [`RenderRelay::lagged`]
/// Until the 76-19 refuter round both transports called this directly on every lag, and
/// that was wrong whenever the dropped frames held a [`RenderProducer::reset`]: the resent
/// keyframe is then a restructure the client never saw, not "the same timeline, frames
/// missed". Whether to tag is decided in [`RenderRelay::lagged`], the one place both
/// transports go through, so a transport cannot tag a frame without that decision.
///
/// # It decodes and re-encodes, on the arm where that is free
/// The watch holds ENCODED bytes so the common path costs one clone and no work at all.
/// This runs ONLY when a connection has already fallen past the bounded diff broadcast
/// (`DIFF_CHANNEL_CAPACITY`, 256 frames), which is rare by construction and already the slow
/// path. Patching the trailing byte in place was
/// rejected: postcard is positional and not self-describing, so a "the flag is the last
/// byte" assumption is exactly the kind that survives a later append and then silently
/// corrupts a `wires` length prefix.
///
/// # A frame it cannot decode is passed through UNCHANGED, never dropped
/// The alternative to a resync frame is no frame, and a client that lagged and then got
/// nothing holds a stale scene forever. An undecodable keyframe is a host bug that this
/// function must not turn into a blank canvas, so the original bytes go out and the client
/// reads them exactly as it did before this field existed.
#[must_use]
fn tag_keyframe_as_resync(bytes: Vec<u8>) -> Vec<u8> {
    let Ok(mut pkt) = postcard::from_bytes::<RenderPacket>(&bytes) else {
        return bytes;
    };
    pkt.resync = true;
    postcard::to_allocvec(&pkt).unwrap_or(bytes)
}

/// One frame on a [`RenderProducer`] channel: the encoded [`RenderPacket`] and the
/// handle-table GENERATION that numbered it (plan 76-19 refuter round).
///
/// # Why the generation rides beside the bytes
/// Every [`RenderProducer::reset`] (an undo, a redo, a Load, a New, a scene swap)
/// installs a fresh builder, so every render handle is minted again from 0. A client
/// that lags past the bounded diff broadcast is resent the latest keyframe, and whether
/// that keyframe is "the same timeline, you missed frames" (`resync: true`) or "the
/// timeline was restructured" (`resync: false`) depends on ONE fact: did a reset happen
/// among the frames it missed. The generation says so. Since phase 88 (D-02) it ALSO
/// crosses the wire, as [`RenderPacket::generation`], stamped by the producer before the
/// bytes are encoded, so the two are always equal; the relay keeps reading it here because
/// a lag decision should not have to decode the frame it is deciding about.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RenderFrame {
    /// How many [`RenderProducer::reset`] calls preceded the build of this frame.
    pub generation: u64,
    /// The packet's own [`RenderPacket::tick`], so a relay can order frames without decoding
    /// them (phase 90, D-09). Host-only, like the struct: never serialized, the wire bytes
    /// are `bytes` alone.
    pub tick: u64,
    /// The postcard-encoded [`RenderPacket`], the bytes a transport sends.
    pub bytes: Vec<u8>,
}

/// One connection's relay of the render stream, shared by BOTH transports
/// (`fabrico_host::transport_ws` and `fabrico_app`) so the lag decision cannot drift.
/// It remembers the generation of the last frame the client was sent.
///
/// # The lag decision (plan 76-19 refuter round)
/// [`lagged`](Self::lagged) tags the resent keyframe `resync: true` ONLY when the client
/// is still on the keyframe's generation. When a reset fell among the dropped frames the
/// keyframe goes out untagged, as the restructure it is for this client, exactly as the
/// reset's own keyframe would have arrived had the client kept up. Before this, every lag
/// was tagged, and the frontend held a pending port-edit latch across a resync that
/// spanned an undo of that very edit, or that handed its handle to another machine with
/// the same origin cell and kind: the panel disabled Add output and Remove for an edit
/// that would never fold.
///
/// # The lag floor (phase 90, FAIL-05, D-09)
/// After a lag the broadcast resumes this receiver at the oldest frame it still buffers,
/// and every one of those frames is at or below the keyframe [`lagged`](Self::lagged) just
/// sent: forwarding them walked the client's tick back by up to 256 frames, and after an
/// Undo in the gap laid the old handle table's diffs over the new board. So `lagged`
/// records the keyframe's `(generation, tick)` as a floor and [`forward`](Self::forward)
/// returns `None` for any frame at or below it, generation compared first and then tick
/// (a reset re-seeds the tick inside a higher generation). The filter is race-safe against
/// the producer's order: [`RenderProducer::on_tick`] sends a diff BEFORE it updates the
/// keyframe watch, so the one diff a lag read can land between is newer than the keyframe
/// read and is forwarded, never lost (a resubscribe there would lose it). The floor stays
/// until the next lag: once a newer frame is forwarded, every later one is newer still.
#[derive(Debug)]
pub struct RenderRelay {
    /// The generation of the last frame this connection was sent.
    generation: u64,
    /// The `(generation, tick)` of the last keyframe this connection was sent, the opening one
    /// or the one the last lag resent; `None` when that keyframe was empty.
    floor: Option<(u64, u64)>,
}

impl RenderRelay {
    /// Open a connection on the latest keyframe. Returns the relay and the bytes to send
    /// first (empty before the first tick: the caller skips an empty frame).
    ///
    /// The opening keyframe is a floor, as a lag keyframe is (phase 90 review IN-A-01): both
    /// transports resubscribe to the diff broadcast BEFORE they read the keyframe watch, and
    /// the producer sends a tick's diff before it updates the watch, so a connection opened
    /// between the two holds the keyframe for tick T and then reads the diff for tick T, which
    /// that keyframe already contains. An empty keyframe (before the first tick) sets no floor.
    #[must_use]
    pub fn open(keyframe: &RenderFrame) -> (Self, Vec<u8>) {
        (
            Self {
                generation: keyframe.generation,
                floor: (!keyframe.bytes.is_empty()).then_some((keyframe.generation, keyframe.tick)),
            },
            keyframe.bytes.clone(),
        )
    }

    /// Forward one diff-broadcast frame unchanged, remembering its generation (a reset's
    /// own keyframe rides the broadcast too, so this is how the client moves to the next
    /// generation when it keeps up). `None` for a frame at or below the lag floor, which the
    /// client must not be sent (see the type's doc); a transport skips it.
    #[must_use]
    pub fn forward(&mut self, frame: RenderFrame) -> Option<Vec<u8>> {
        if self.floor.is_some_and(|floor| (frame.generation, frame.tick) <= floor) {
            return None;
        }
        self.generation = frame.generation;
        Some(frame.bytes)
    }

    /// The connection lagged past the bounded diff broadcast: the bytes to send are the
    /// latest keyframe, tagged as a lag resync only when no reset happened since the last
    /// frame the client was sent, and that keyframe becomes the floor below which
    /// [`forward`](Self::forward) sends nothing. An empty keyframe (before the first tick) is
    /// never sent, so it sets no floor. See the type's doc.
    #[must_use]
    pub fn lagged(&mut self, keyframe: &RenderFrame) -> Vec<u8> {
        let same_timeline = keyframe.generation == self.generation;
        self.generation = keyframe.generation;
        if !keyframe.bytes.is_empty() {
            self.floor = Some((keyframe.generation, keyframe.tick));
        }
        if same_timeline {
            tag_keyframe_as_resync(keyframe.bytes.clone())
        } else {
            keyframe.bytes.clone()
        }
    }
}

/// How many handle tables before the current one a [`RenderProducer`] keeps (phase 88,
/// D-02). A chosen default (D-02 left the size to the plan): a paused board holds every
/// Undo or Redo after the first (App's `undoHeld`), a playing board falls at most two or
/// three resets behind in one round trip, and a connection that fell further behind than
/// this is better refused with a sentence than resolved from a deeper history. Each kept
/// table is a `handle -> NodeId` map only.
pub const KEPT_GENERATIONS: usize = 8;

/// What a gesture's `(generation, handle)` names, read by [`RenderProducer::resolve_at`]
/// (phase 88, D-02, D-03, D-05). The pair is compared, never the handle alone: handle 3 of
/// one table and handle 3 of the next are different names.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Resolved {
    /// The node the named table gave this handle. It may since have been removed (an Undo
    /// can take it back); a dead id then fails `validate_normalize` as `UnknownNode`, so an
    /// old handle reaches only nodes the board still has.
    Node(NodeId),
    /// The named table never minted this handle.
    Gone,
    /// The generation is on this board but older than the [`KEPT_GENERATIONS`] tables kept:
    /// the host cannot say which node the user picked, so the edit is refused
    /// `BoardChanged` (D-03).
    TooOld,
    /// The generation is from before a board swap (Load, LoadDemo, LoadScene, New): the edit
    /// was made on a board that no longer exists and is answered discarded (D-05).
    Discard,
    /// The generation is above the board's current one, which no client was ever sent: a
    /// forged header, refused as the cannot-read tag `Malformed`.
    Ahead,
}

/// The single per-tick render producer (W2): it OWNS the explicit
/// `build → encode → broadcast.send` pipeline and the fan-out channels both
/// transports subscribe to. Cells are sourced from core `GridState` (SPAT-01), so
/// the producer no longer maintains a host-side layout projection.
///
/// The per-tick OWNER that drives [`on_tick`](Self::on_tick) is the 07-08 sim loop;
/// 07-06's `transport_ws` and 07-08's `subscribe_render` are pure SUBSCRIBERS that
/// call [`subscribe`](Self::subscribe) and forward the identical postcard bytes.
pub struct RenderProducer {
    /// The packet builder (handle table + diff baseline).
    builder: RenderPacketBuilder,
    /// Per-tick diff bytes — the live broadcast every subscriber reads.
    diff_tx: broadcast::Sender<RenderFrame>,
    /// The latest full keyframe bytes — a new subscriber's resync point.
    keyframe_tx: watch::Sender<RenderFrame>,
    /// How many [`reset`](Self::reset) calls this producer has run: the generation every
    /// frame it sends carries ([`RenderFrame`], plan 76-19 refuter round).
    generation: u64,
    /// The `handle -> NodeId` tables of the last [`KEPT_GENERATIONS`] generations before the
    /// current one, oldest first, each under the generation it was current at (phase 88,
    /// D-02). Same-board only: a swap clears it ([`reset_for_swap`](Self::reset_for_swap)).
    kept: VecDeque<(u64, BTreeMap<u64, NodeId>)>,
    /// The generation the last board swap installed (phase 88, D-05). A gesture stamped
    /// below it was made on a board that no longer exists. NodeIds are per board, so a
    /// pre-swap id can equal a live id of the new board; nothing below the floor is ever
    /// resolved.
    swap_floor: u64,
}

impl RenderProducer {
    /// A fresh producer with both fan-out channels (an empty initial keyframe).
    #[must_use]
    pub fn new() -> Self {
        let (diff_tx, _diff_rx) = broadcast::channel(DIFF_CHANNEL_CAPACITY);
        let (keyframe_tx, _keyframe_rx) = watch::channel(RenderFrame::default());
        Self {
            builder: RenderPacketBuilder::new(),
            diff_tx,
            keyframe_tx,
            generation: 0,
            kept: VecDeque::new(),
            swap_floor: 0,
        }
    }

    /// The EXPLICIT per-tick call site (W2): build the diff packet, encode it,
    /// broadcast it, then refresh the latest-keyframe watch. Called once per tick by
    /// the sim-loop owner. Cells ride in core `GridState` (the 09-02 fold writes each
    /// `Place`'s cell), so the producer no longer drains a pending-cell buffer or
    /// updates a host-side layout — it just reads `core.state.cell_of` (SPAT-01).
    ///
    /// # Errors
    /// Returns the `postcard` encode error if either the diff or keyframe packet
    /// fails to serialize (never expected for the integer-only DTOs).
    pub fn on_tick(&mut self, host: &Host) -> Result<(), postcard::Error> {
        // 1. Build + encode + broadcast the active-set diff.
        let built = self.builder.build(host);
        let pkt = self.stamp(built);
        let bytes = postcard::to_allocvec(&pkt)?;
        // A send error only means "no subscribers yet" — not fatal; the keyframe
        // watch still holds the latest full frame for a future subscriber.
        let _ = self.diff_tx.send(RenderFrame {
            generation: self.generation,
            tick: pkt.tick,
            bytes,
        });

        // 2. Refresh the latest-keyframe watch (a new subscriber resyncs from this).
        let built = self.builder.build_keyframe(host);
        let keyframe = self.stamp(built);
        let keyframe_bytes = postcard::to_allocvec(&keyframe)?;
        let _ = self.keyframe_tx.send(RenderFrame {
            generation: self.generation,
            tick: keyframe.tick,
            bytes: keyframe_bytes,
        });

        Ok(())
    }

    /// RESET the producer for a host SWAP (Load, HOST-05) — the never-dark
    /// re-sync. Replaces the builder ONLY (dropping the stale `NodeId->u64`
    /// handle table + diff baseline) and KEEPS both fan-out channels, then pushes
    /// a `full:true` keyframe of the NEW scene over BOTH the diff broadcast AND
    /// the keyframe watch.
    ///
    /// The `diff_tx.send` is the LOAD-BEARING line: an already-connected
    /// subscriber sits in `diff_rx.recv()` and only re-reads the keyframe watch on
    /// connect / `Lagged`, so a watch-only reset would leave live webviews
    /// rendering the OLD scene. Riding the diff broadcast makes the frontend
    /// decoder clear its buffer on `full:true` (`sceneState.ts`) and repopulate
    /// inline — the subscriber keeps its channel (never a `Closed` stream, which
    /// a rebuild would cause). Handle reuse from 0 is safe because the `full:true`
    /// packet clears the decoder buffer entirely before repopulating (Pitfall 3).
    ///
    /// A send error means "no subscribers yet" and is non-fatal (`let _ =`),
    /// matching [`on_tick`](Self::on_tick)'s convention.
    ///
    /// # Errors
    /// Returns the `postcard` encode error if the keyframe fails to serialize
    /// (never expected for the integer-only DTOs).
    pub fn reset(&mut self, host: &Host) -> Result<(), postcard::Error> {
        self.reset_as(host, false)
    }

    /// [`reset`](Self::reset), and for a board swap also the swap's own bookkeeping, done
    /// BEFORE the keyframe is stamped so that keyframe already names the new floor
    /// (phase 88 security, T-88-11).
    fn reset_as(&mut self, host: &Host, swap: bool) -> Result<(), postcard::Error> {
        // Drop the stale handle table + diff baseline. A new handle table is a new
        // generation: a connection that lags across this reset is resent the keyframe as
        // a restructure, never as a resync (`RenderRelay::lagged`, plan 76-19 refuter).
        //
        // Phase 88 (D-02): the outgoing table is KEPT under the outgoing generation, so a
        // gesture made from it (an edit queued behind an Undo) resolves to the node the user
        // picked. The oldest past `KEPT_GENERATIONS` is dropped.
        let outgoing = std::mem::take(&mut self.builder);
        self.kept.push_back((self.generation, outgoing.into_handle_table()));
        while self.kept.len() > KEPT_GENERATIONS {
            self.kept.pop_front();
        }
        self.generation += 1;
        if swap {
            // A swap's history is cleared and its floor set here, before anything can fail,
            // so no pre-swap table survives an encode error; and before the keyframe below is
            // stamped, so the swap's own keyframe tells every client the board was replaced.
            self.kept.clear();
            self.swap_floor = self.generation;
        }
        // PRIME prev_nodes/prev_belts to the NEW scene (the `build` side effect)
        // so the NEXT on_tick diff is empty — no spurious re-emit of the scene we
        // are about to keyframe.
        let _prime = self.builder.build(host);
        // The full keyframe of the new scene. `build_keyframe` does not touch the
        // diff baseline, so the prime above must run first. Stamped AFTER the increment
        // above, so it names the NEW table's generation (phase 88, D-02).
        let built = self.builder.build_keyframe(host);
        let keyframe = self.stamp(built);
        let frame = RenderFrame {
            generation: self.generation,
            tick: keyframe.tick,
            bytes: postcard::to_allocvec(&keyframe)?,
        };
        // LIVE subscribers: clear + repopulate inline (the load-bearing send).
        let _ = self.diff_tx.send(frame.clone());
        // FUTURE subscribers: the new resync baseline.
        let _ = self.keyframe_tx.send(frame);
        Ok(())
    }

    /// RESET the producer for a BOARD SWAP (Load, LoadDemo, LoadScene, New; phase 88, D-05):
    /// what [`reset`](Self::reset) does, then the kept tables are cleared and the swap floor
    /// set to the new generation. A swap starts a new NodeId allocator, so a table of the
    /// replaced board could name a live node of the new one (Pitfall 1); after this, every
    /// gesture stamped before the swap reads [`Resolved::Discard`].
    ///
    /// The history is cleared and the floor set even when the keyframe fails to encode, so
    /// no pre-swap table survives an error. Both happen before the swap's keyframe is
    /// stamped, so that keyframe carries the new floor in [`RenderPacket::swap_floor`]
    /// (phase 88 security, T-88-11): a client learns of the swap from the packet, whichever
    /// page asked for it.
    ///
    /// # Errors
    /// The `postcard` encode error [`reset`](Self::reset) returns.
    pub fn reset_for_swap(&mut self, host: &Host) -> Result<(), postcard::Error> {
        self.reset_as(host, true)
    }

    /// What generation `generation` lets a gesture read (phase 88, D-02, D-03, D-05), before
    /// any handle is looked at: `Ok` when its table is the current one or a kept one, else
    /// the one answer that applies, which is only ever [`Resolved::Discard`] (below the
    /// swap floor), [`Resolved::Ahead`] (above the current generation) or
    /// [`Resolved::TooOld`] (on this board but past the kept history).
    ///
    /// # Errors
    /// The [`Resolved`] answer for a generation whose table the producer does not hold.
    pub fn check_generation(&self, generation: u64) -> Result<(), Resolved> {
        self.table_at(generation).map(|_| ())
    }

    /// The node handle `handle` named in the table of generation `generation`: the table
    /// the client read the handle from (phase 88, D-02). The current generation reads the
    /// live builder, a kept generation its kept table; see [`Resolved`] for the rest.
    #[must_use]
    pub fn resolve_at(&self, generation: u64, handle: u64) -> Resolved {
        match self.table_at(generation) {
            Ok(table) => table.get(&handle).map_or(Resolved::Gone, |&id| Resolved::Node(id)),
            Err(answer) => answer,
        }
    }

    /// The `handle -> NodeId` table of `generation`, or why there is none.
    fn table_at(&self, generation: u64) -> Result<&BTreeMap<u64, NodeId>, Resolved> {
        if generation < self.swap_floor {
            return Err(Resolved::Discard);
        }
        if generation > self.generation {
            return Err(Resolved::Ahead);
        }
        if generation == self.generation {
            return Ok(self.builder.handle_table());
        }
        self.kept
            .iter()
            .find(|(g, _)| *g == generation)
            .map(|(_, table)| table)
            .ok_or(Resolved::TooOld)
    }

    /// Subscribe a transport: returns `(latest-keyframe watch receiver, live-diff
    /// broadcast receiver)`. The transport sends the watched keyframe first, then
    /// forwards each diff frame. Both carry the IDENTICAL postcard bytes the other
    /// transport sends.
    #[must_use]
    pub fn subscribe(&self) -> (watch::Receiver<RenderFrame>, broadcast::Receiver<RenderFrame>) {
        (self.keyframe_tx.subscribe(), self.diff_tx.subscribe())
    }

    /// The live [`NodeId`] a dense render handle maps to (the gesture-resolver source
    /// `input_apply` uses, 07-06). Delegates to the builder's inverse handle table;
    /// the per-tick owner (07-08) builds `|h| producer.node_for_handle(h)` and hands
    /// it to `apply_gesture`.
    pub fn node_for_handle(&self, handle: u64) -> Option<NodeId> {
        self.builder.node_for_handle(handle)
    }

    /// The dense render handle currently assigned to `id` (the inverse of
    /// [`node_for_handle`](Self::node_for_handle)). Delegates to the builder's handle
    /// table; `None` for a node not yet emitted. Read-only, never mints.
    #[must_use]
    pub fn handle_for_node(&self, id: NodeId) -> Option<u64> {
        self.builder.handle_for_node(id)
    }

    /// The board generation of the CURRENT handle table: how many [`reset`](Self::reset)
    /// calls this producer has run (phase 88, D-02). Every packet it encodes carries this
    /// number in [`RenderPacket::generation`], and every frame carries it beside the bytes
    /// in [`RenderFrame::generation`].
    #[must_use]
    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// Put this producer's generation and swap floor on a packet the builder built (phase
    /// 88, D-02, D-05; the floor since the security audit, T-88-11). The builder owns the
    /// handle table but not the count of tables; the producer owns the count, so it stamps
    /// every packet in ONE place before it encodes it, and the wire field and the
    /// `RenderFrame` beside it cannot disagree.
    fn stamp(&self, mut pkt: RenderPacket) -> RenderPacket {
        pkt.generation = self.generation;
        pkt.swap_floor = self.swap_floor;
        pkt
    }
}

impl Default for RenderProducer {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use fabrico_core::core::Core;
    use fabrico_core::event::{LogHeader, SCHEMA_VERSION};
    use fabrico_core::ids::Item;
    use fabrico_core::persist::RedbStore;
    use fabrico_core::state::{Node, Port};

    use crate::ledger::DispatchLedger;

    fn test_host() -> (tempfile::TempDir, Host) {
        let dir = tempfile::tempdir().expect("tempdir");
        let core = Core::genesis(LogHeader {
            schema_version: SCHEMA_VERSION,
            seed: 7,
        });
        let store = RedbStore::open(dir.path().join("log.redb")).expect("open log");
        let ledger = DispatchLedger::open(dir.path().join("ledger.redb")).expect("open ledger");
        let host = Host::new(core, store, ledger, None).expect("open host");
        (dir, host)
    }

    #[test]
    fn derive_state_from_observation() {
        // faulted (2) wins over working (1) wins over idle (0).
        let mut core = Core::genesis(LogHeader {
            schema_version: SCHEMA_VERSION,
            seed: 1,
        });
        let working = core.state.add_source();
        let faulted = core.state.add_source();
        let idle = core.state.add_source();
        let obs = TickObservation {
            stepped: vec![working, faulted],
            faulted: vec![faulted],
            ..Default::default()
        };
        assert_eq!(
            derive_state(faulted, &obs, &core.state),
            state_tag::FAULTED,
            "fault wins"
        );
        assert_eq!(
            derive_state(working, &obs, &core.state),
            state_tag::WORKING,
            "stepped"
        );
        assert_eq!(
            derive_state(idle, &obs, &core.state),
            state_tag::IDLE,
            "neither => idle"
        );
    }

    /// An UNDRAINED fault in the inbox paints FAULTED even on a tick the node
    /// neither faulted nor stepped — the arm that makes a failed outbound call
    /// visible.
    ///
    /// Watched RED first: with `derive_state` reading only the observation, the
    /// third assertion below returns `IDLE` and the first returns `WORKING`,
    /// which is exactly the shipped defect (a failed outbound sink painted green
    /// for one tick, then grey forever, while holding the unread failure).
    #[test]
    fn derive_state_sees_an_undrained_fault() {
        use fabrico_core::fault::{FAULT_PORT, Fault, FaultReason};

        let mut core = Core::genesis(LogHeader {
            schema_version: SCHEMA_VERSION,
            seed: 1,
        });
        let failed = core.state.add_source();
        let clean = core.state.add_source();

        // Exactly what `manual_inject` does when a dispatch folds to Failure:
        // push a CommandFailure onto the reserved fault port and wake the node.
        let fault = Fault::command(failed, FaultReason::CommandFailure, Vec::new());
        core.state
            .inbox_mut(failed)
            .push(FAULT_PORT, 0, fault.encode());

        // The node was woken, so it is in `stepped` — this is the tick that used
        // to paint it green.
        let stepped_obs = TickObservation {
            stepped: vec![failed, clean],
            ..Default::default()
        };
        assert_eq!(
            derive_state(failed, &stepped_obs, &core.state),
            state_tag::FAULTED,
            "an unread fault outranks having stepped"
        );
        assert_eq!(
            derive_state(clean, &stepped_obs, &core.state),
            state_tag::WORKING,
            "a node with no fault still reads WORKING"
        );

        // Every later tick: nothing re-wakes it, and the fault is never drained.
        let quiet_obs = TickObservation::default();
        assert_eq!(
            derive_state(failed, &quiet_obs, &core.state),
            state_tag::FAULTED,
            "the failure stays visible instead of decaying to IDLE"
        );
        assert_eq!(
            derive_state(clean, &quiet_obs, &core.state),
            state_tag::IDLE,
            "an idle node is still IDLE"
        );
    }

    /// Fill `id`'s inbox on `port` with `n` plain items, exactly as a belt delivery
    /// would rest them there.
    fn fill(core: &mut Core, id: NodeId, port: PortId, n: usize) {
        for k in 0..n {
            core.state.inbox_mut(id).push(port, k as u64, Item(Vec::new()));
        }
    }

    /// Declare ONE In port on `id` at the given medium, so `admit::inbox_class`
    /// classifies port 0 by a DECLARED medium rather than by the port-less default.
    fn declare_in_port(core: &mut Core, id: NodeId, medium: Medium) {
        core.state.set_ports(
            id,
            vec![Port {
                local_offset: (0, 0),
                side: Side::W,
                role: Role::In,
                medium,
            }],
        );
    }

    /// Declare `mediums.len()` In ports on `id`, one per entry. The multi-In-port
    /// shape the catalog actually ships: `port_catalog` gives BALANCER two In ports
    /// and MERGE two.
    fn declare_in_ports(core: &mut Core, id: NodeId, mediums: &[Medium]) {
        core.state.set_ports(
            id,
            mediums
                .iter()
                .enumerate()
                .map(|(i, medium)| Port {
                    local_offset: (0, i as i32),
                    side: Side::W,
                    role: Role::In,
                    medium: *medium,
                })
                .collect(),
        );
    }

    /// The PILE-08 precedence table, asserted arm by arm:
    /// `FAULTED > BACKED_UP > WORKING > IDLE`.
    ///
    /// The second case is the one the ORDER buys. `TickObservation::stepped` is
    /// extended from the active set before the nodes are stepped, so a full machine woken
    /// on a tick and held back by the output gate is in `stepped`. `full_and_stepped` below
    /// is in `stepped` and reads BACKED_UP only because the arm is checked first;
    /// swap the two arms and it reads WORKING, which is the reading PILE-08 replaces.
    #[test]
    fn derive_state_precedence_backed_up_outranks_stepped() {
        use fabrico_core::fault::{FAULT_PORT, Fault, FaultReason};

        let mut core = Core::genesis(LogHeader {
            schema_version: SCHEMA_VERSION,
            seed: 1,
        });
        let faulted_and_full = core.state.add_source();
        let full_and_stepped = core.state.add_source();
        let working = core.state.add_source();
        let idle = core.state.add_source();

        let cap = fabrico_core::admit::MECHANICAL_INBOX_CAP;
        fill(&mut core, faulted_and_full, 0, cap);
        fill(&mut core, full_and_stepped, 0, cap);
        fill(&mut core, working, 0, 1);

        let fault = Fault::command(faulted_and_full, FaultReason::CommandFailure, Vec::new());
        core.state
            .inbox_mut(faulted_and_full)
            .push(FAULT_PORT, 0, fault.encode());

        // EVERY one of the three busy nodes is in the active set, including the two
        // the gate would have skipped. That is the shape the ordering has to survive.
        let obs = TickObservation {
            stepped: vec![faulted_and_full, full_and_stepped, working],
            ..Default::default()
        };

        assert_eq!(
            derive_state(faulted_and_full, &obs, &core.state),
            state_tag::FAULTED,
            "a fault outranks a full inbox",
        );
        assert_eq!(
            derive_load(faulted_and_full, &core.state),
            LOAD_FULL,
            "and the faulted machine STILL carries its gauge: two separate channels",
        );
        assert_eq!(
            derive_state(full_and_stepped, &obs, &core.state),
            state_tag::BACKED_UP,
            "a full inbox outranks having been left in the active set by a skipped step",
        );
        assert_eq!(
            derive_state(working, &obs, &core.state),
            state_tag::WORKING,
            "a stepped node under the cap is still WORKING",
        );
        assert_eq!(
            derive_state(idle, &obs, &core.state),
            state_tag::IDLE,
            "neither faulted, nor full, nor stepped",
        );
    }

    /// JAM-06, WINDOWS 173, D-09 (plan 87-01): a Source whose backlog is full is refusing
    /// every event it is sent, so it reads BACKED_UP with the full gauge, not WORKING.
    ///
    /// The board is the research's P173 shape: a Source linked to a 1-tile belt whose head
    /// is linked to nothing, fed one logged `ManualInject` a tick until its `pending` holds
    /// `SOURCE_PENDING_CAP` items (the belt's slots and staging inbox fill first). Then for
    /// 200 more fed ticks both the real observation the fold wrote (`core.last_tick`) and a
    /// hand-built one with the Source in `stepped` (the shape the gate's spin produces, and
    /// the one `derive_state_precedence_backed_up_outranks_stepped` builds) must read
    /// BACKED_UP, and the gauge must read `LOAD_FULL` on every one of those ticks.
    ///
    /// Watched RED first at `PHASE87_START`: the Source read WORKING with its backlog full,
    /// because `is_refusing` returned early on a Source's empty inbox and `derive_load` read
    /// only the inbox. The rows after it pin the bands and the no-inbox case.
    #[test]
    fn a_source_with_a_full_backlog_reads_backed_up() {
        use fabrico_core::admit::SOURCE_PENDING_CAP;
        use fabrico_core::event::{Event, EventPayload};

        let cap = SOURCE_PENDING_CAP;
        assert_eq!(cap, 16, "the bands below are written for a backlog cap of 16");
        let mut core = Core::genesis(LogHeader {
            schema_version: SCHEMA_VERSION,
            seed: 173,
        });
        let source = core.state.add_source();
        let belt = core.state.add_belt(1);
        core.state.link((source, 0), (belt, 0));
        let pending = |core: &Core| match core.state.node(source) {
            Some(Node::Source(s)) => s.pending.len(),
            other => panic!("expected the Source, got {other:?}"),
        };
        let mut seq = 0u64;
        let mut feed = |core: &mut Core| {
            seq += 1;
            let ev = Event {
                schema_version: SCHEMA_VERSION,
                partition: 0,
                sequence: seq,
                tick: core.tick,
                payload: EventPayload::ManualInject {
                    target: source,
                    port: 0,
                    item: Item(vec![1]),
                },
            };
            core.advance(&[ev]);
        };
        let mut filled_at = None;
        for _ in 0..1000 {
            feed(&mut core);
            if pending(&core) == cap {
                filled_at = Some(core.tick);
                break;
            }
        }
        let filled_at = filled_at.expect("the Source's backlog reaches its cap on a belt that docks nowhere");
        let mut wrong: Vec<(u64, u8, u8, u8)> = Vec::new();
        for _ in 0..200 {
            feed(&mut core);
            assert_eq!(pending(&core), cap, "the backlog stays at its cap while every event is refused");
            let hand = TickObservation {
                stepped: vec![source],
                ..Default::default()
            };
            let real_tag = derive_state(source, &core.last_tick, &core.state);
            let hand_tag = derive_state(source, &hand, &core.state);
            let load = derive_load(source, &core.state);
            if real_tag != state_tag::BACKED_UP || hand_tag != state_tag::BACKED_UP || load != LOAD_FULL {
                wrong.push((core.tick, real_tag, hand_tag, load));
            }
        }
        assert!(
            wrong.is_empty(),
            "a Source with {cap} pending (filled at tick {filled_at}) reads BACKED_UP ({}) with the full \
             gauge ({LOAD_FULL}) on all 200 ticks; {} ticks read otherwise, first (tick, real tag, \
             hand-built tag, load) = {:?}",
            state_tag::BACKED_UP,
            wrong.len(),
            wrong.first(),
        );

        // The bands: a Source's backlog reads on the inbox's bands, and only a FULL backlog
        // refuses. A fresh Source per row, its `pending` set directly.
        let set_pending = |core: &mut Core, id: NodeId, n: usize| match core.state.node_mut(id) {
            Some(Node::Source(s)) => {
                s.pending = (0..n).map(|k| Item(vec![k as u8])).collect();
            }
            other => panic!("expected a Source, got {other:?}"),
        };
        let obs = |id: NodeId| TickObservation {
            stepped: vec![id],
            ..Default::default()
        };
        for (n, level, refusing) in [(0usize, 0u8, false), (1, 1, false), (15, 3, false), (16, LOAD_FULL, true)] {
            let id = core.state.add_source();
            set_pending(&mut core, id, n);
            assert_eq!(derive_load(id, &core.state), level, "a Source holding {n} pending reads level {level}");
            assert_eq!(is_refusing(id, &core.state), refusing, "a Source holding {n} pending refusing={refusing}");
            let want = if refusing { state_tag::BACKED_UP } else { state_tag::WORKING };
            assert_eq!(derive_state(id, &obs(id), &core.state), want, "a stepped Source holding {n} pending");
        }

        // A Source with NO inbox entry at all and a full backlog is still refusing: the
        // backlog clause is read before the no-inbox early return, not after it.
        let bare = core.state.add_source();
        set_pending(&mut core, bare, cap);
        core.state.test_remove_inbox(bare);
        assert!(core.state.inbox_of(bare).is_none(), "this Source must genuinely have no inbox");
        assert!(is_refusing(bare, &core.state), "a Source with no inbox and a full backlog is refusing");
        assert_eq!(derive_load(bare, &core.state), LOAD_FULL, "and its gauge reads full");
    }

    /// Plan 87-06, JAM-04, D-06, D-12: a machine asleep behind its blocked output that holds
    /// work reads BACKED_UP, the jam mark, not IDLE.
    ///
    /// Real folded boards on `Core::genesis`, read with `core.last_tick` on a tick that
    /// carries no event and no delivery, so the sleeper is not in `stepped`:
    ///
    /// * the P177B Tee (a 1-tile inlet, two 1-tile branch belts whose heads dock nowhere),
    ///   fed exactly enough to fill both branches and leave 8 items in its inbox: BACKED_UP,
    ///   `derive_load` 2, `is_refusing` false (8 of 16 is not a full inbox);
    /// * a Source holding 15 in `pending` behind a full 1-tile belt whose head docks
    ///   nowhere: BACKED_UP, `derive_load` 3, `is_refusing` false (15 of 16);
    /// * the same Source shape with an empty `pending`: IDLE (gated, but no work waits);
    /// * the Tee again with a hand-built observation that has it in `stepped` (the drip tick
    ///   of a steady jam): WORKING, as before plan 87-06.
    ///
    /// Watched RED first with the waiting arm absent: the sleeping Tee read IDLE.
    #[test]
    fn a_machine_waiting_behind_a_blocked_output_reads_backed_up() {
        use fabrico_core::event::{Event, EventPayload};

        let cap = fabrico_core::admit::MECHANICAL_INBOX_CAP;
        // What one 1-tile belt whose head docks nowhere holds: its slots (read off a probe
        // belt, never a second copy of the core's slot count) and its staging inbox at the cap.
        let one_belt = {
            let mut probe = Core::genesis(LogHeader { schema_version: SCHEMA_VERSION, seed: 0 });
            let b = probe.state.add_belt(1);
            match probe.state.node(b) {
                Some(Node::Belt(belt)) => belt.slots.len(),
                other => panic!("expected a belt, got {other:?}"),
            }
        } + cap;
        let fire = |target: NodeId, seq: u64, tick: u64| Event {
            schema_version: SCHEMA_VERSION,
            partition: 0,
            sequence: seq,
            tick,
            payload: EventPayload::ManualInject {
                target,
                port: 0,
                item: Item(vec![1]),
            },
        };
        // Feed `source` one event every 8 ticks until `n` are fired, then run 2000 quiet
        // ticks so everything that can move has moved, then one more quiet tick to read.
        let feed = |core: &mut Core, source: NodeId, n: usize| {
            let mut fired = 0usize;
            while fired < n {
                let t = core.tick;
                if t.is_multiple_of(8) {
                    fired += 1;
                    core.advance(&[fire(source, fired as u64, t)]);
                } else {
                    core.advance(&[]);
                }
            }
            for _ in 0..2000 {
                core.advance(&[]);
            }
            core.advance(&[]);
        };
        let pending = |core: &Core, id: NodeId| match core.state.node(id) {
            Some(Node::Source(s)) => s.pending.len(),
            _ => 0,
        };

        // THE TEE. Each item the Tee takes is copied to both branches, so it takes exactly
        // `one_belt` items before both branches are full, then 8 more rest in its inbox.
        let mut core = Core::genesis(LogHeader { schema_version: SCHEMA_VERSION, seed: 0x87_0177 });
        let s = core.state.add_source();
        let inlet = core.state.add_belt(1);
        let tee = core.state.add_tee(2);
        let left = core.state.add_belt(1);
        let right = core.state.add_belt(1);
        core.state.link((s, 0), (inlet, 0));
        core.state.link((inlet, 0), (tee, 0));
        core.state.link((tee, 0), (left, 0));
        core.state.link((tee, 1), (right, 0));
        feed(&mut core, s, one_belt + 8);
        let tee_in = core.state.inbox_of(tee).map_or(0, |i| i.len_on(0));
        assert_eq!(tee_in, 8, "the Tee holds 8 behind two full branches");
        assert!(!core.last_tick.stepped.contains(&tee), "the Tee sleeps: it is not in stepped");
        assert!(!is_refusing(tee, &core.state), "8 of 16 is not a full inbox");
        assert_eq!(derive_load(tee, &core.state), 2, "the gauge reads its own level, 8 of 16");
        assert_eq!(
            derive_state(tee, &core.last_tick, &core.state),
            state_tag::BACKED_UP,
            "a Tee asleep holding work behind two full branches wears the jam mark, not IDLE",
        );
        let drip = TickObservation { stepped: vec![tee], ..Default::default() };
        assert_eq!(
            derive_state(tee, &drip, &core.state),
            state_tag::WORKING,
            "on a tick the Tee steps it reads what it read before plan 87-06 (the drip)",
        );

        // THE SOURCE WITH A PART-FULL BACKLOG. The belt takes `one_belt` items, then the
        // Source holds the rest in `pending`.
        let mut core = Core::genesis(LogHeader { schema_version: SCHEMA_VERSION, seed: 0x87_0173 });
        let src = core.state.add_source();
        let belt = core.state.add_belt(1);
        core.state.link((src, 0), (belt, 0));
        feed(&mut core, src, one_belt + 15);
        assert_eq!(pending(&core, src), 15, "the Source holds 15 behind its full belt");
        assert!(!core.last_tick.stepped.contains(&src), "the Source sleeps");
        assert!(!is_refusing(src, &core.state), "15 of 16 is not a full backlog");
        assert_eq!(derive_load(src, &core.state), 3, "the gauge reads 15 of 16");
        assert_eq!(
            derive_state(src, &core.last_tick, &core.state),
            state_tag::BACKED_UP,
            "a Source asleep holding a backlog behind its full belt wears the jam mark",
        );

        // THE SAME SOURCE SHAPE WITH NOTHING WAITING.
        let mut core = Core::genesis(LogHeader { schema_version: SCHEMA_VERSION, seed: 0x87_0174 });
        let empty = core.state.add_source();
        let belt = core.state.add_belt(1);
        core.state.link((empty, 0), (belt, 0));
        feed(&mut core, empty, one_belt);
        assert_eq!(pending(&core, empty), 0, "every item went onto the belt");
        assert_eq!(
            derive_state(empty, &core.last_tick, &core.state),
            state_tag::IDLE,
            "a Source behind a full belt with nothing waiting is IDLE",
        );
    }

    /// The gauge bands, the two exemptions, and the cross-invariant in BOTH
    /// directions.
    ///
    /// THE BOARD INCLUDES A PORT-LESS NODE ON PURPOSE. `admit::inbox_class` reads an
    /// UNDECLARED port as Mechanical, so a port-less collector is gauged; a board of
    /// only declared-port nodes would pass while the bar was silently dead for every
    /// node `add_source` builds, which is most of the golden corpus.
    #[test]
    fn derive_load_bands_and_the_cross_invariant() {
        use fabrico_core::fault::{FAULT_PORT, Fault, FaultReason};

        let cap = fabrico_core::admit::MECHANICAL_INBOX_CAP;
        assert_eq!(cap, 16, "the bands below are written for a cap of 16");

        let mut core = Core::genesis(LogHeader {
            schema_version: SCHEMA_VERSION,
            seed: 3,
        });

        // The bands, one node per boundary value.
        for (n, expected) in [
            (0usize, 0u8),
            (1, 1),
            (5, 1),
            (6, 2),
            (10, 2),
            (11, 3),
            (15, 3),
            (16, 4),
            (17, 4),
        ] {
            let id = core.state.add_source();
            fill(&mut core, id, 0, n);
            assert_eq!(
                derive_load(id, &core.state),
                expected,
                "an inbox holding {n} items reads level {expected}",
            );
        }

        // A PORT-LESS node at the cap reads FULL. The case that actually occurs.
        let portless_full = core.state.add_source();
        fill(&mut core, portless_full, 0, cap);
        assert!(
            core.state.ports_of(portless_full).is_none(),
            "this node must genuinely be port-less or it is not the case under test",
        );
        assert_eq!(
            derive_load(portless_full, &core.state),
            LOAD_FULL,
            "an undeclared port reads Mechanical, so a port-less collector is gauged",
        );

        // A declared ELECTRICAL In port contributes NOTHING, however deep (D-02).
        let wired = core.state.add_source();
        declare_in_port(&mut core, wired, Medium::Electrical);
        fill(&mut core, wired, 0, cap * 4);
        assert_eq!(
            derive_load(wired, &core.state),
            0,
            "a wire fan-in must never light the mechanical gauge",
        );

        // A declared MECHANICAL In port is gauged exactly like the port-less one.
        let belted = core.state.add_source();
        declare_in_port(&mut core, belted, Medium::Mechanical);
        fill(&mut core, belted, 0, cap);
        assert_eq!(
            derive_load(belted, &core.state),
            LOAD_FULL,
            "a declared mechanical port is gauged",
        );

        // ===================================================================
        // WR-01: THE MULTI-In-PORT CASE, WHICH IS THE CASE THAT SHIPPED WRONG.
        //
        // The cap is enforced PER PORT (`admit::accepts_n` tests
        // `len_on(dest_port) + n <= MECHANICAL_INBOX_CAP`), so a node with two In
        // ports legitimately holds 32 items before it refuses anything. Summing them
        // read `cap/2 + cap/2` as FULL and painted BACKED_UP on a machine with eight
        // free slots on each port that was actively draining - which is a machine
        // LYING about being jammed, the inversion PILE-08 and PILE-11 judgment C
        // exist to prevent. `port_catalog` gives BALANCER two In ports and MERGE two,
        // so this is not a synthetic shape.
        //
        // Both directions are on the board, because "take the max" and "take the sum"
        // agree whenever only ONE port is occupied and only the pair separates them.
        // ===================================================================
        let two_in_half = core.state.add_source();
        declare_in_ports(
            &mut core,
            two_in_half,
            &[Medium::Mechanical, Medium::Mechanical],
        );
        fill(&mut core, two_in_half, 0, cap / 2);
        fill(&mut core, two_in_half, 1, cap / 2);
        assert_ne!(
            derive_load(two_in_half, &core.state),
            LOAD_FULL,
            "a two-In-port node holding cap/2 on EACH port is NOT full: it has \
             {} free slots on each of its two ports",
            cap - cap / 2,
        );
        assert_eq!(
            derive_load(two_in_half, &core.state),
            derive_load(
                {
                    let solo = core.state.add_source();
                    declare_in_port(&mut core, solo, Medium::Mechanical);
                    fill(&mut core, solo, 0, cap / 2);
                    solo
                },
                &core.state
            ),
            "and it gauges exactly like a single port holding the same cap/2, because \
             the gauge reads the fullest PORT",
        );
        assert!(
            !is_refusing(two_in_half, &core.state),
            "non-vacuity for the cross-invariant below: the admission path agrees it \
             is accepting, so a summing gauge would DISAGREE with the cap here",
        );

        // The other direction: ONE of two In ports AT the cap. That machine IS
        // refusing (on that port), and the max reading must still say so.
        let two_in_one_full = core.state.add_source();
        declare_in_ports(
            &mut core,
            two_in_one_full,
            &[Medium::Mechanical, Medium::Mechanical],
        );
        fill(&mut core, two_in_one_full, 0, cap);
        fill(&mut core, two_in_one_full, 1, 1);
        assert_eq!(
            derive_load(two_in_one_full, &core.state),
            LOAD_FULL,
            "one port AT the cap is a refusal, whatever the other port holds",
        );
        assert!(
            is_refusing(two_in_one_full, &core.state),
            "and the admission path agrees",
        );

        // A queue of undrained FAULTS is not mechanical fill: FAULT_PORT classifies
        // Fault, has its own cap, and is reported by the FAULTED tag instead.
        let faulty = core.state.add_source();
        for k in 0..cap {
            let fault = Fault::command(faulty, FaultReason::CommandFailure, Vec::new());
            core.state
                .inbox_mut(faulty)
                .push(FAULT_PORT, k as u64, fault.encode());
        }
        assert_eq!(
            derive_load(faulty, &core.state),
            0,
            "the reserved fault port is not mechanical fill",
        );

        // A faulted AND full node, so the invariant's `state != FAULTED` guard is
        // exercised by a node that actually trips it rather than by no node at all.
        let faulted_and_full = core.state.add_source();
        fill(&mut core, faulted_and_full, 0, cap);
        let fault = Fault::command(faulted_and_full, FaultReason::CommandFailure, Vec::new());
        core.state
            .inbox_mut(faulted_and_full)
            .push(FAULT_PORT, 0, fault.encode());

        // SOURCE ROWS (plan 87-01, JAM-06): a Source's backlog is gauged on the same bands
        // and refuses at its own cap. Empty, partial, one under the cap, at the cap, and at
        // the cap with no inbox entry at all, so the loop below checks the tag against the
        // gauge on a queue that is not an inbox. `is_refusing` asks
        // `admit::source_accepts_one` and the gauge reads `pending.len()`: still two
        // independent readings of one fact.
        let source_cap = fabrico_core::admit::SOURCE_PENDING_CAP;
        let mut source_full = Vec::new();
        for (n, expected) in [(0usize, 0u8), (5, 1), (15, 3), (source_cap, LOAD_FULL)] {
            let id = core.state.add_source();
            if let Some(Node::Source(s)) = core.state.node_mut(id) {
                s.pending = (0..n).map(|_| Item(Vec::new())).collect();
            }
            assert_eq!(
                derive_load(id, &core.state),
                expected,
                "a Source with {n} pending reads level {expected}",
            );
            if expected == LOAD_FULL {
                source_full.push(id);
            }
        }
        let source_full_no_inbox = core.state.add_source();
        if let Some(Node::Source(s)) = core.state.node_mut(source_full_no_inbox) {
            s.pending = (0..source_cap).map(|_| Item(Vec::new())).collect();
        }
        core.state.test_remove_inbox(source_full_no_inbox);
        source_full.push(source_full_no_inbox);

        // THE CROSS-INVARIANT, both directions, over every node on the board.
        //
        // THIS LOOP CAN NOW FAIL (WR-01). It used to be circular: `derive_state`'s
        // BACKED_UP arm was spelled `derive_load(..) == LOAD_FULL`, so "the tag agrees
        // with the gauge" was true by construction and no board could ever separate
        // them. The tag now reads `is_refusing`, which asks `admit::accepts_one` - the
        // same predicate the push sites call - so the two sides are independent
        // readings of one fact. MEASURED: restoring the summing gauge reddens this loop
        // at "a full gauge on a machine that is not faulted implies BACKED_UP" (left 1,
        // right 3) even with the direct multi-port assertions above deleted.
        // A TEE WAITING BEHIND TWO FULL COLLECTORS (plan 87-06, JAM-04, D-06): holding 8,
        // gated (both branches refuse), so with nothing stepped it reads BACKED_UP through
        // the waiting arm with a part-full gauge, and stepped it reads WORKING. The unstepped
        // pass below must see it.
        let waiting_tee = core.state.add_tee(2);
        for port in 0..2 {
            let collector = core.state.add_source();
            fill(&mut core, collector, 0, cap);
            core.state.link((waiting_tee, port), (collector, 0));
        }
        fill(&mut core, waiting_tee, 0, cap / 2);
        assert!(
            fabrico_core::tick::waits_behind_blocked_output(&core.state, waiting_tee),
            "non-vacuity: the Tee is gated and holds work",
        );

        // THE CROSS-INVARIANT, over every node on the board, under two observations: every
        // node stepped (the shape plans 71-05 to 87-05 graded) and nothing stepped (the
        // shape a sleeping board has since plan 87-06).
        //
        // THIS LOOP CAN FAIL (WR-01). It used to be circular: `derive_state`'s BACKED_UP arm
        // was spelled `derive_load(..) == LOAD_FULL`, so "the tag agrees with the gauge" was
        // true by construction and no board could ever separate them. The tag reads
        // `is_refusing`, which asks `admit::accepts_one` - the same predicate the push
        // sites call - so the two sides are independent readings of one fact. MEASURED:
        // restoring the summing gauge reddens this loop at "a full gauge on a machine that
        // is not faulted implies BACKED_UP" (left 1, right 3) even with the direct
        // multi-port assertions above deleted.
        //
        // THE TWO-WAY RULE (plan 87-06): BACKED_UP holds EXACTLY when the node is not
        // faulted and either refuses, or did not step and waits behind its blocked output.
        // It replaced "BACKED_UP implies a full gauge", which the waiting arm makes false on
        // purpose (the Tee above wears the mark at 8 of 16).
        let all_stepped = TickObservation {
            stepped: core.state.node_ids().collect(),
            ..Default::default()
        };
        let none_stepped = TickObservation::default();
        let mut saw_backed_up = 0usize;
        let mut saw_full_and_faulted = 0usize;
        let mut saw_partial = 0usize;
        let mut saw_waiting_part_full = 0usize;
        for (pass, obs) in [("all stepped", &all_stepped), ("none stepped", &none_stepped)] {
            for id in core.state.node_ids().collect::<Vec<_>>() {
                let tag = derive_state(id, obs, &core.state);
                let load = derive_load(id, &core.state);
                let faulted = obs.faulted.contains(&id)
                    || core.state.inbox_of(id).is_some_and(|i| i.has_on(FAULT_PORT));
                let stepped = obs.stepped.contains(&id);
                let expect_backed_up = !faulted
                    && (is_refusing(id, &core.state)
                        || (!stepped && fabrico_core::tick::waits_behind_blocked_output(&core.state, id)));
                assert_eq!(
                    tag == state_tag::BACKED_UP,
                    expect_backed_up,
                    "{pass}: BACKED_UP exactly when not faulted and refusing, or not stepped and waiting",
                );
                if load == LOAD_FULL && tag != state_tag::FAULTED {
                    assert_eq!(
                        tag,
                        state_tag::BACKED_UP,
                        "{pass}: a full gauge on a machine that is not faulted implies BACKED_UP",
                    );
                }
                if pass == "all stepped" {
                    if tag == state_tag::BACKED_UP {
                        saw_backed_up += 1;
                    }
                    if load == LOAD_FULL && tag == state_tag::FAULTED {
                        saw_full_and_faulted += 1;
                    }
                    if load != 0 && load != LOAD_FULL {
                        saw_partial += 1;
                    }
                } else if tag == state_tag::BACKED_UP && load < LOAD_FULL {
                    saw_waiting_part_full += 1;
                }
            }
        }
        let obs = &all_stepped;
        assert!(
            saw_waiting_part_full >= 1,
            "the unstepped pass must see a BACKED_UP node whose gauge is below full (saw {saw_waiting_part_full})",
        );
        assert_eq!(derive_state(waiting_tee, obs, &core.state), state_tag::WORKING, "stepped, the Tee is WORKING");

        // NON-VACUITY. Both directions above are satisfied by a board on which no
        // node is ever full, which is the shape that makes an invariant test green
        // while proving nothing.
        assert!(
            saw_backed_up >= 3,
            "the board must actually produce BACKED_UP nodes (saw {saw_backed_up})",
        );
        assert_eq!(
            saw_full_and_faulted, 1,
            "the faulted-AND-full partial case must be on the board exactly once",
        );
        assert!(
            saw_partial >= 4,
            "the board must carry mid-band gauges too (saw {saw_partial})",
        );
        // NON-VACUITY for the Source rows: both full Sources were on the board and read
        // BACKED_UP through the loop above, so the loop checked a backlog, not only inboxes.
        for id in source_full {
            assert_eq!(
                derive_state(id, obs, &core.state),
                state_tag::BACKED_UP,
                "a Source with a full backlog is one of the BACKED_UP nodes the loop counted",
            );
        }
    }

    /// Build a `WireInFlight` carrying `return_addr` — the only field the direction
    /// derivation reads (plus a fixed correlation/budget/empty payload for the rest).
    fn inflight(return_addr: (NodeId, u16)) -> WireInFlight {
        WireInFlight {
            entry_tick: 0,
            correlation: 0x1234,
            return_addr,
            budget: 8,
            payload: Item(Vec::new()),
        }
    }

    #[test]
    fn direction_headline_forward_and_reply() {
        // Headline single-hop topology: caller <-> handler. The caller is BOTH the
        // request's origin and its reply target (manual_inject.rs:149).
        let mut core = Core::genesis(LogHeader {
            schema_version: SCHEMA_VERSION,
            seed: 1,
        });
        let caller = core.state.add_source();
        let handler = core.state.add_source();

        // Forward (entry) wire runs caller -> handler; the request's return_addr is the
        // caller == the wire's `from`. It is NOT arriving home => FORWARD.
        let forward = WireLink {
            from: (caller, 0),
            to: (handler, 0),
            in_flight: std::collections::VecDeque::new(),
        };
        assert_eq!(
            derive_wire_direction(&forward, &inflight((caller, 0))),
            WIRE_FORWARD,
            "a request leaving the caller toward the handler is FORWARD",
        );

        // Return wire runs handler -> caller; the reply's return_addr is the caller ==
        // the wire's `to`. It IS arriving home => REPLY.
        let reply = WireLink {
            from: (handler, 0),
            to: (caller, 0),
            in_flight: std::collections::VecDeque::new(),
        };
        assert_eq!(
            derive_wire_direction(&reply, &inflight((caller, 0))),
            WIRE_REPLY,
            "a reply arriving home at the caller is REPLY",
        );
    }

    #[test]
    fn direction_fanout_is_total_and_unambiguous() {
        // Fan-out topology: one handler H <-> N downstream handlers. Each downstream
        // request's return_addr is its immediate reply target — the fan-out handler H.
        let mut core = Core::genesis(LogHeader {
            schema_version: SCHEMA_VERSION,
            seed: 2,
        });
        let hub = core.state.add_source(); // the fan-out handler H
        let leaves: Vec<NodeId> = (0..3).map(|_| core.state.add_source()).collect();

        for &leaf in &leaves {
            // Forward leg H -> leaf: the child request's return_addr is H (== `from`),
            // never the leaf (`to`) => FORWARD on every leg.
            let fwd = WireLink {
                from: (hub, 0),
                to: (leaf, 0),
                in_flight: std::collections::VecDeque::new(),
            };
            let fwd_dir = derive_wire_direction(&fwd, &inflight((hub, 0)));

            // Reply leg leaf -> H: the reply's return_addr is H (== `to`) => REPLY.
            let rev = WireLink {
                from: (leaf, 0),
                to: (hub, 0),
                in_flight: std::collections::VecDeque::new(),
            };
            let rev_dir = derive_wire_direction(&rev, &inflight((hub, 0)));

            assert_eq!(fwd_dir, WIRE_FORWARD, "each fan-out forward leg is FORWARD");
            assert_eq!(rev_dir, WIRE_REPLY, "each fan-out reply leg is REPLY");
            // Totality: a wire is never BOTH — the two legs classify oppositely.
            assert_ne!(
                fwd_dir, rev_dir,
                "forward and reply legs of a fan-out are unambiguously distinct",
            );
        }
    }

    #[test]
    fn direction_reads_only_observable_topology() {
        // Frozen-schema guard: the derivation compiles and runs against ONLY the
        // existing observable fields (WireLink.from/to + WireInFlight.return_addr).
        // ZERO new serialized field was added to state.rs / wire.rs (asserted at the
        // repo level by `git diff --quiet` in the plan's acceptance gate). Here we
        // simply prove a bare WireLink + WireInFlight classify without any host-side
        // extra state, mirroring how derive_state needs only the TickObservation.
        let mut core = Core::genesis(LogHeader {
            schema_version: SCHEMA_VERSION,
            seed: 3,
        });
        let caller = core.state.add_source();
        let handler = core.state.add_source();
        let ret = WireLink {
            from: (handler, 0),
            to: (caller, 0),
            in_flight: std::collections::VecDeque::new(),
        };
        assert_eq!(derive_wire_direction(&ret, &inflight((caller, 0))), WIRE_REPLY);
    }

    #[test]
    fn wire_projects_endpoints_path_and_directed_pulse() {
        // WUI-01: a Node::Wire carrying an in-flight message projects a real
        // WireView — two resolved dock endpoints, a non-empty route()-normalized
        // path, and one pulse stamped with the host-derived direction byte.
        use fabrico_core::state::{Port, Role, Side};
        let (_dir, mut host) = test_host();
        // The handler (wire origin) with an electrical Out nub, at (0,0).
        let handler = host.core_mut().state.add_source();
        host.core_mut().state.set_cell(handler, (0, 0));
        host.core_mut().state.set_ports(
            handler,
            vec![Port {
                local_offset: (0, 0),
                side: Side::E,
                role: Role::Out,
                medium: Medium::Electrical,
            }],
        );
        // The caller (reply target) with an electrical In nub, at a DISTINCT cell so
        // the cable auto-routes a non-degenerate L path.
        let caller = host.core_mut().state.add_source();
        host.core_mut().state.set_cell(caller, (3, 2));
        host.core_mut().state.set_ports(
            caller,
            vec![Port {
                local_offset: (0, 0),
                side: Side::W,
                role: Role::In,
                medium: Medium::Electrical,
            }],
        );
        // The RETURN wire runs handler -> caller (from=handler, to=caller). A reply
        // whose return_addr is the caller (== the wire's `to`) is arriving home.
        let wire = host.core_mut().state.add_wire((handler, 0), (caller, 0));
        if let Some(Node::Wire(link)) = host.core_mut().state.node_mut(wire) {
            link.in_flight.push_back(inflight((caller, 0)));
        } else {
            panic!("expected a Wire node");
        }

        let mut builder = RenderPacketBuilder::new();
        let pkt = builder.build_keyframe(&host);

        assert_eq!(pkt.wires.len(), 1, "one WireView on the packet");
        let wv = &pkt.wires[0];
        // Endpoints resolve to the (node, port) dock handles (FORK B — the frontend
        // resolves the nub anchor from the docked node's ports).
        assert_eq!(wv.from.node, builder.handle_for(handler), "from == handler handle");
        assert_eq!(wv.from.port, 0);
        assert_eq!(wv.to.node, builder.handle_for(caller), "to == caller handle");
        assert_eq!(wv.to.port, 0);
        // The cable auto-routes a non-empty route()-normalized path.
        assert!(!wv.path.is_empty(), "a wire between distinct cells has a path");
        // One in-flight pulse, host-derived as a REPLY (return_addr == wire.to).
        assert_eq!(wv.pulses.len(), 1, "one in-flight pulse");
        assert_eq!(
            wv.pulses[0].direction, WIRE_REPLY,
            "return_addr == wire.to (caller) => REPLY (the reply-home read)"
        );
        assert_eq!(
            u64::from(wv.pulses[0].hop_ticks),
            WIRE_HOP_TICKS,
            "the pulse ships the WIRE_HOP_TICKS hop duration"
        );
        // The wire is NOT ALSO emitted as a degenerate NodeView(0,0).
        assert!(
            pkt.placed.iter().all(|n| n.id != wv.id),
            "a Node::Wire projects a WireView, not a NodeView"
        );
    }

    /// The cells of a projected wire path, in order.
    fn path_cells(path: &[TileView]) -> Vec<(i32, i32)> {
        path.iter().map(|t| (t.cell_x, t.cell_y)).collect()
    }

    /// One electrical port on a 1x1 node's own cell.
    fn electrical(side: fabrico_core::state::Side, role: fabrico_core::state::Role) -> Port {
        Port {
            local_offset: (0, 0),
            side,
            role,
            medium: Medium::Electrical,
        }
    }

    /// CABLE-09 part 2 ON A REAL BUILDER (75-03, D-05). A forged self-wire on ONE 1x1
    /// node whose electrical In (W) and Out (E) share its cell: both docks resolve to
    /// `(4,4)`, the router refuses the pair as `Coincident`, and the packet must carry the
    /// named two-cell stub, the node's cell then the cell its Out faces, instead of the
    /// empty path `unwrap_or_default` shipped before. The count is read after EACH builder
    /// call, because `current_views` runs in both `build_keyframe` and `build` every tick
    /// (75-RESEARCH Pitfall 9): one refused wire adds one per call.
    #[test]
    fn a_coincident_wire_renders_a_two_cell_stub_and_counts_one_failure_per_build() {
        use fabrico_core::state::{Role, Side};
        let (_dir, mut host) = test_host();
        let node = host.core_mut().state.add_source();
        host.core_mut().state.set_cell(node, (4, 4));
        host.core_mut().state.set_ports(
            node,
            vec![electrical(Side::E, Role::Out), electrical(Side::W, Role::In)],
        );
        let _wire = host.core_mut().state.add_wire((node, 0), (node, 1));

        let mut builder = RenderPacketBuilder::new();
        assert_eq!(builder.wire_route_failures(), 0, "a fresh builder has counted nothing");
        let key = builder.build_keyframe(&host);
        assert_eq!(key.wires.len(), 1, "the forged wire still ships a WireView");
        assert_eq!(
            path_cells(&key.wires[0].path),
            vec![(4, 4), (5, 4)],
            "the source port's cell, then the cell its east-facing normal faces"
        );
        assert_eq!(
            builder.wire_route_failures(),
            1,
            "one refused wire, one keyframe call"
        );
        let diff = builder.build(&host);
        assert_eq!(
            path_cells(&diff.wires[0].path),
            vec![(4, 4), (5, 4)],
            "the diff path carries the same stub"
        );
        assert_eq!(
            builder.wire_route_failures(),
            2,
            "counted per builder call: the keyframe and the diff each projected the wire"
        );
    }

    /// A wire whose endpoints name port indices its node DOES NOT HAVE degrades through
    /// `resolve_wire_dock` to the node's cell facing N at both ends, which is a coincident
    /// pair. It must still draw two cells: the node's cell and the one north of it.
    #[test]
    fn a_wire_naming_a_missing_port_on_its_own_node_still_draws_two_cells() {
        let (_dir, mut host) = test_host();
        let node = host.core_mut().state.add_source();
        host.core_mut().state.set_cell(node, (2, 3));
        let _wire = host.core_mut().state.add_wire((node, 5), (node, 6));

        let mut builder = RenderPacketBuilder::new();
        let pkt = builder.build_keyframe(&host);
        assert_eq!(pkt.wires.len(), 1);
        let cells = path_cells(&pkt.wires[0].path);
        assert!(
            cells.len() >= 2,
            "a wire is never drawn as fewer than two cells; got {cells:?}"
        );
        assert_eq!(cells, vec![(2, 3), (2, 2)], "the degraded dock faces N");
        assert_eq!(builder.wire_route_failures(), 1);
    }

    fn wire_dock(cell: (i32, i32), side: u8) -> WireDock {
        WireDock {
            cell,
            side,
            body: WireBody {
                min_x: cell.0,
                min_y: cell.1,
                max_x: cell.0,
                max_y: cell.1,
            },
        }
    }

    /// `fallback_stub` called directly: the second cell is the one the port's normal
    /// faces, and the pair is an ordinary straight two-tile cable on that axis.
    #[test]
    fn fallback_stub_faces_the_port_normal() {
        let s = fallback_stub(wire_dock((0, 0), 2));
        assert_eq!(path_cells(&s), vec![(0, 0), (0, 1)], "S faces (0, 1)");
        assert!(
            s.iter()
                .all(|t| t.kind == TileKindView::Straight { axis: 1 }),
            "a vertical stub is two straight Y tiles: {s:?}"
        );
        assert_eq!(
            path_cells(&fallback_stub(wire_dock((7, -3), 3))),
            vec![(7, -3), (6, -3)],
            "W faces one cell west"
        );
    }

    /// The faced cell is OFF THE GRID: the first in-grid orthogonal neighbour, scanned N,
    /// E, S, W. At the grid's north-east corner facing E, the faced cell, N and E are all
    /// off the grid, so the scan has to reach S.
    #[test]
    fn fallback_stub_scans_n_e_s_w_off_the_grid() {
        use fabrico_command::command::{GRID_MAX, GRID_MIN};
        assert_eq!(
            path_cells(&fallback_stub(wire_dock((GRID_MAX, GRID_MIN), 1))),
            vec![(GRID_MAX, GRID_MIN), (GRID_MAX, GRID_MIN + 1)],
            "east and north are off the grid, so south"
        );
        assert_eq!(
            path_cells(&fallback_stub(wire_dock((GRID_MAX, 0), 1))),
            vec![(GRID_MAX, 0), (GRID_MAX, -1)],
            "east is off the grid and north is on it"
        );
        assert_eq!(
            path_cells(&fallback_stub(wire_dock((GRID_MIN, GRID_MAX), 3))),
            vec![(GRID_MIN, GRID_MAX), (GRID_MIN, GRID_MAX - 1)],
            "west is off the grid, north is on it"
        );
    }

    /// A FORGED side byte has normal `(0, 0)`, which faces no cell: the same N, E, S, W
    /// scan. On the grid's top row N is off the grid, so E.
    #[test]
    fn fallback_stub_scans_n_e_s_w_on_a_forged_side() {
        use fabrico_command::command::GRID_MIN;
        assert_eq!(
            path_cells(&fallback_stub(wire_dock((0, 0), 9))),
            vec![(0, 0), (0, -1)],
            "a forged side scans N first"
        );
        assert_eq!(
            path_cells(&fallback_stub(wire_dock((5, GRID_MIN), 200))),
            vec![(5, GRID_MIN), (6, GRID_MIN)],
            "north is off the grid, so east"
        );
    }

    #[test]
    fn idle_wire_projects_empty_pulses() {
        // Active-set discipline: an idle wire (no in-flight) still projects a
        // WireView (endpoints + path) but with EMPTY pulses — nothing to animate.
        let (_dir, mut host) = test_host();
        let a = host.core_mut().state.add_source();
        host.core_mut().state.set_cell(a, (0, 0));
        let b = host.core_mut().state.add_source();
        host.core_mut().state.set_cell(b, (2, 0));
        let _wire = host.core_mut().state.add_wire((a, 0), (b, 0));

        let mut builder = RenderPacketBuilder::new();
        let pkt = builder.build_keyframe(&host);
        assert_eq!(pkt.wires.len(), 1, "the idle wire still projects a WireView");
        assert!(
            pkt.wires[0].pulses.is_empty(),
            "an idle wire has no in-flight pulses to animate"
        );
    }

    #[test]
    fn render_diff_idle_is_empty() {
        // An unchanged grid (steady state) emits an empty active-set diff (full:false).
        let (_dir, mut host) = test_host();
        host.core_mut().state.add_source();
        let mut builder = RenderPacketBuilder::new();
        let _baseline = builder.build(&host); // first build emits the node
        let pkt = builder.build(&host); // nothing changed
        assert!(!pkt.full, "a diff is never a keyframe");
        assert!(
            pkt.placed.is_empty() && pkt.belts.is_empty() && pkt.removed.is_empty(),
            "an idle grid emits an empty diff"
        );
    }

    #[test]
    fn render_diff_one_change_is_one_node() {
        // Adding one node produces a one-node diff (only the changed node).
        let (_dir, mut host) = test_host();
        host.core_mut().state.add_source(); // node A (baseline)
        let mut builder = RenderPacketBuilder::new();
        let _baseline = builder.build(&host);

        host.core_mut().state.add_source(); // node B — the single change
        let pkt = builder.build(&host);
        assert!(!pkt.full);
        assert_eq!(pkt.placed.len(), 1, "exactly one changed node in the diff");
        assert!(pkt.removed.is_empty(), "nothing removed");
        assert!(pkt.belts.is_empty(), "no belts changed");
    }

    #[test]
    fn backpressure_fill_reports_occupied_slot_count() {
        // A fully-packed slot belt reports fill == the occupied-slot count (the
        // bunching signal), and ships each item as integers only (slot index + tag).
        let (_dir, mut host) = test_host();
        let tiles: u32 = 2;
        let belt = host.core_mut().state.add_belt(tiles);
        let slots = if let Some(Node::Belt(b)) = host.core_mut().state.node_mut(belt) {
            for s in b.slots.iter_mut() {
                *s = Some(Item(vec![0xAA]));
            }
            b.slots.len()
        } else {
            panic!("expected a Belt");
        };
        let mut builder = RenderPacketBuilder::new();
        let pkt = builder.build_keyframe(&host);
        assert_eq!(pkt.belts.len(), 1, "one belt in the keyframe");
        let bv = &pkt.belts[0];
        assert_eq!(bv.fill as usize, slots, "fill == occupied-slot count");
        assert_eq!(bv.latency as usize, slots, "latency is derived from the slot length");
        assert_eq!(bv.items.len(), slots, "every occupied slot shipped");
        assert_eq!(bv.items[0].tag, 0xAA, "tag is the item's leading byte");
    }

    #[test]
    fn render_packet_sources_node_cells_from_core() {
        // SPAT-01: the producer reads NodeView cells straight from core GridState
        // (set_cell, written by the 09-02 fold), NOT a host-side layout. A known
        // scene's encoded NodeView cell positions match the fixed expectation —
        // proving the cell SOURCE moved to core while the integer wire is unchanged.
        let (_dir, mut host) = test_host();
        let a = host.core_mut().state.add_source();
        host.core_mut().state.set_cell(a, (3, 5));
        let b = host.core_mut().state.add_source();
        host.core_mut().state.set_cell(b, (-2, 7));

        let mut builder = RenderPacketBuilder::new();
        let pkt = builder.build_keyframe(&host);
        assert!(pkt.full, "a keyframe");
        assert_eq!(pkt.placed.len(), 2, "two source NodeViews");

        // NodeView cells come from core.state.cell_of (the single SPAT-01 source).
        let mut cells: Vec<(i32, i32)> =
            pkt.placed.iter().map(|n| (n.cell_x, n.cell_y)).collect();
        cells.sort_unstable();
        assert_eq!(cells, vec![(-2, 7), (3, 5)], "cells sourced from core GridState");

        // The integer NodeView wire is unchanged: the packet encodes + decodes back
        // to the same cells (no wire-format change accompanies the cell-source move).
        let bytes = postcard::to_allocvec(&pkt).expect("encode");
        let decoded: RenderPacket = postcard::from_bytes(&bytes).expect("decode");
        let mut rt_cells: Vec<(i32, i32)> =
            decoded.placed.iter().map(|n| (n.cell_x, n.cell_y)).collect();
        rt_cells.sort_unstable();
        assert_eq!(rt_cells, cells, "NodeView cell bytes round-trip unchanged");
    }

    #[test]
    fn nodeview_reports_footprint_dims_and_rotation() {
        // REND-01: a node with a claimed multi-cell footprint ships w/h/rot from
        // core footprint_of; a node with NO footprint ships the 1x1 rot0 default.
        use fabrico_core::state::Footprint;
        let (_dir, mut host) = test_host();
        let big = host.core_mut().state.add_source();
        host.core_mut()
            .state
            .set_footprint(big, Footprint { w: 2, h: 3, rot: 1 });
        let plain = host.core_mut().state.add_source(); // no footprint => 1x1 rot0

        let mut builder = RenderPacketBuilder::new();
        let pkt = builder.build_keyframe(&host);
        let big_h = builder.handle_for(big);
        let plain_h = builder.handle_for(plain);

        let big_nv = pkt
            .placed
            .iter()
            .find(|n| n.id == big_h)
            .expect("multi-cell node in keyframe");
        assert_eq!(
            (big_nv.w, big_nv.h, big_nv.rot),
            (2, 3, 1),
            "NodeView carries the claimed 2x3 rot1 footprint"
        );

        let plain_nv = pkt
            .placed
            .iter()
            .find(|n| n.id == plain_h)
            .expect("footprint-less node in keyframe");
        assert_eq!(
            (plain_nv.w, plain_nv.h, plain_nv.rot),
            (1, 1, 0),
            "absent footprint => the faithful 1x1 rot0 default"
        );
    }

    #[test]
    fn beltview_reports_tile_geometry_from_core() {
        // REND-01: a belt with non-empty geometry ships matching `tiles` (cell +
        // typed kind with numeric Axis/Dir bytes); a geometry-less Wire belt ships
        // empty `tiles`.
        use fabrico_core::state::{Axis, BeltTile, Dir, TileKind};
        let (_dir, mut host) = test_host();
        // A drawn belt with a Straight (axis Y=1) then a Corner (from E=1, to S=2).
        let drawn = host.core_mut().state.add_belt(2);
        let geometry = vec![
            BeltTile::new((4, 1), TileKind::Straight { axis: Axis::Y }),
            BeltTile::new(
                (4, 2),
                TileKind::Corner {
                    from: Dir::E,
                    to: Dir::S,
                },
            ),
        ];
        if let Some(Node::Belt(b)) = host.core_mut().state.node_mut(drawn) {
            b.geometry = geometry.clone();
        } else {
            panic!("expected a Belt");
        }
        // A Wire-minted belt: geometry stays empty.
        let _wire = host.core_mut().state.add_belt(1);

        let mut builder = RenderPacketBuilder::new();
        let pkt = builder.build_keyframe(&host);
        let drawn_h = builder.handle_for(drawn);

        let drawn_bv = pkt
            .belts
            .iter()
            .find(|b| b.id == drawn_h)
            .expect("drawn belt in keyframe");
        assert_eq!(
            drawn_bv.tiles.len(),
            geometry.len(),
            "tiles.len() == geometry.len()"
        );
        assert_eq!(drawn_bv.tiles[0].cell_x, 4);
        assert_eq!(drawn_bv.tiles[0].cell_y, 1);
        assert_eq!(
            drawn_bv.tiles[0].kind,
            TileKindView::Straight { axis: 1 },
            "Straight tile ships axis Y as numeric 1"
        );
        assert_eq!(
            drawn_bv.tiles[1].kind,
            TileKindView::Corner { from: 1, to: 2 },
            "Corner tile ships from E=1, to S=2 as numeric bytes"
        );

        let empty_bv = pkt
            .belts
            .iter()
            .find(|b| b.tiles.is_empty())
            .expect("a Wire-minted belt ships empty tiles");
        assert!(empty_bv.tiles.is_empty(), "geometry-less belt => empty tiles");
    }

    #[test]
    fn beltview_carries_each_belts_own_advance_interval() {
        // SLOT-03 / D-08: the interval is projected PER BELT from core state, not
        // assumed. Two belts on one board carry DIFFERENT intervals and the packet
        // reports each one's own — the assertion a single-belt board could not make,
        // because one belt at the crate default agrees with a hard-coded projection.
        //
        // 5 and 9 are TEST literals, not proposed paces (`62-CONTEXT.md` D-19). They
        // are read back as the numbers typed here rather than derived from
        // `DEFAULT_TICKS_PER_SLOT`: a derived expectation agrees with the constant at
        // every value.
        let (_dir, mut host) = test_host();
        let slow = host.core_mut().state.add_belt(1);
        let slower = host.core_mut().state.add_belt(1);
        for (id, n) in [(slow, 5u32), (slower, 9)] {
            if let Some(Node::Belt(b)) = host.core_mut().state.node_mut(id) {
                b.ticks_per_slot = std::num::NonZeroU32::new(n).expect("non-zero test literal");
            } else {
                panic!("expected a Belt");
            }
        }

        let mut builder = RenderPacketBuilder::new();
        let pkt = builder.build_keyframe(&host);
        let find = |h: u64| {
            pkt.belts
                .iter()
                .find(|b| b.id == h)
                .expect("belt in keyframe")
                .ticks_per_slot
        };
        assert_eq!(find(builder.handle_for(slow)), 5, "the first belt's own interval");
        assert_eq!(find(builder.handle_for(slower)), 9, "the second belt's own interval");
    }

    #[test]
    fn nodeview_ports_are_world_resolved_from_port_world() {
        // PORT-01: each PortView's cell/side/role is the authoritative output of core
        // `port_world` (rot applied in-core) + role_u8 — zero renderer rotation math.
        use fabrico_core::state::{Footprint, Port, Role, Side};
        let (_dir, mut host) = test_host();
        let n = host.core_mut().state.add_source();
        host.core_mut().state.set_cell(n, (10, 4));
        let fp = Footprint { w: 2, h: 3, rot: 1 };
        host.core_mut().state.set_footprint(n, fp);
        let ports = vec![
            Port {
                local_offset: (0, 0),
                side: Side::N,
                role: Role::In, medium: Medium::Mechanical,
            },
            Port {
                local_offset: (1, 2),
                side: Side::E,
                role: Role::Out, medium: Medium::Mechanical,
            },
        ];
        host.core_mut().state.set_ports(n, ports.clone());

        let mut builder = RenderPacketBuilder::new();
        let pkt = builder.build_keyframe(&host);
        let handle = builder.handle_for(n);
        let nv = pkt
            .placed
            .iter()
            .find(|p| p.id == handle)
            .expect("ported node in keyframe");

        assert_eq!(nv.ports.len(), ports.len(), "one PortView per rot-0 port");
        for (i, port) in ports.iter().enumerate() {
            let (world_cell, world_side) = port_world((10, 4), fp.w, fp.h, fp.rot, port);
            let pv = &nv.ports[i];
            assert_eq!(pv.index, i as u16, "PortView index == port-list index");
            assert_eq!(
                (pv.cell_x, pv.cell_y),
                world_cell,
                "PortView cell == port_world world cell (rot applied in-core)"
            );
            assert_eq!(pv.side, side_u8(world_side), "PortView side == resolved side");
            assert_eq!(pv.role, role_u8(port.role), "PortView role == role_u8");
        }
        // Roles pinned: In=0, Out=1 (PORT-02).
        assert_eq!(nv.ports[0].role, port_role::IN);
        assert_eq!(nv.ports[1].role, port_role::OUT);
    }

    #[test]
    fn portless_node_emits_empty_ports() {
        // A node with no recorded ports (ports_of == None) ships an empty ports vec.
        let (_dir, mut host) = test_host();
        host.core_mut().state.add_source();
        let mut builder = RenderPacketBuilder::new();
        let pkt = builder.build_keyframe(&host);
        assert_eq!(pkt.placed.len(), 1, "one node");
        assert!(
            pkt.placed[0].ports.is_empty(),
            "a port-less node emits an empty ports vec"
        );
    }

    #[test]
    fn beltview_docks_from_link_graph_head_before_tail() {
        // PORT-03: docks are derived from the (belt,0) link graph, keeping (node,port)
        // handles, in deterministic Head-before-Tail order.
        let (_dir, mut host) = test_host();
        let belt = host.core_mut().state.add_belt(2);
        let src = host.core_mut().state.add_source();
        let dst = host.core_mut().state.add_source();
        // Tail (OFFLOAD, machine->belt): link((src,0) -> (belt,0)).
        host.core_mut().state.link((src, 0), (belt, 0));
        // Head (LOAD, belt->machine): link((belt,0) -> (dst,1)).
        host.core_mut().state.link((belt, 0), (dst, 1));

        let mut builder = RenderPacketBuilder::new();
        let pkt = builder.build_keyframe(&host);
        let belt_h = builder.handle_for(belt);
        let src_h = builder.handle_for(src);
        let dst_h = builder.handle_for(dst);

        let bv = pkt
            .belts
            .iter()
            .find(|b| b.id == belt_h)
            .expect("belt in keyframe");
        assert_eq!(bv.docks.len(), 2, "both a Head and a Tail dock");
        assert_eq!(
            bv.docks[0],
            BeltDockView {
                end: BeltEnd::Head,
                node: dst_h,
                port: 1,
            },
            "Head dock first: (belt,0)->(dst,1)"
        );
        assert_eq!(
            bv.docks[1],
            BeltDockView {
                end: BeltEnd::Tail,
                node: src_h,
                port: 0,
            },
            "Tail dock second: (src,0)->(belt,0)"
        );
    }

    /// The three arms of one board, kept in one helper so the fan-in, the
    /// single-upstream and the no-upstream cases below all read the SAME belt out of
    /// the SAME keyframe rather than each rebuilding a board of its own.
    fn docks_of(
        builder: &mut RenderPacketBuilder,
        pkt: &RenderPacket,
        belt: NodeId,
    ) -> Vec<BeltDockView> {
        let h = builder.handle_for(belt);
        pkt.belts
            .iter()
            .find(|b| b.id == h)
            .unwrap_or_else(|| panic!("belt handle {h} in keyframe"))
            .docks
            .clone()
    }

    #[test]
    fn belt_docks_reports_every_upstream_not_the_first_one_a_lookup_reaches() {
        // LINK-13 / WINDOWS 139. Belts `a` and `b` BOTH deliver into `c`'s tail. In the
        // core that is two link records, and until this phase the wire carried one:
        // `belt_docks` bound a single upstream with a `.find()` over `links_iter()`, so
        // `c` reported only whichever upstream ascending BTreeMap key order reached
        // first and `b`'s membership in the run was invisible from `c`.
        //
        // 74-02 made a belt-to-belt dock user-constructible, so this stopped being a
        // characterisation and became a shipped wrong answer: the belt panel's run count
        // depended on which tile the user pressed.
        //
        // THE ORDER IS ASSERTED, NOT MERELY THE SET. `links_iter()` is a BTreeMap walk in
        // ascending `(node, port)` key order and `a` is allocated before `b`, so `a`'s
        // Tail entry precedes `b`'s on every call. A set comparison here would stay green
        // on a projection that collected through a `std::HashMap`, which is the exact
        // non-determinism `fabrico-core` forbids in the sim and the render packet
        // inherits.
        let (_dir, mut host) = test_host();
        let a = host.core_mut().state.add_belt(2);
        let b = host.core_mut().state.add_belt(2);
        let c = host.core_mut().state.add_belt(2);
        host.core_mut().state.link((a, 0), (c, 0));
        host.core_mut().state.link((b, 0), (c, 0));

        let mut builder = RenderPacketBuilder::new();
        let pkt = builder.build_keyframe(&host);
        let a_h = builder.handle_for(a);
        let b_h = builder.handle_for(b);
        let c_h = builder.handle_for(c);

        assert_eq!(
            docks_of(&mut builder, &pkt, c),
            vec![
                BeltDockView {
                    end: BeltEnd::Tail,
                    node: a_h,
                    port: 0,
                },
                BeltDockView {
                    end: BeltEnd::Tail,
                    node: b_h,
                    port: 0,
                },
            ],
            "a fan-in reaches the wire WHOLE: one Tail entry per upstream, in links_iter \
             BTreeMap order, and no Head entry because c delivers nowhere"
        );

        // The two upstreams each keep exactly one Head entry and no Tail entry: the Head
        // branch is a `link_target((belt, 0))` map lookup and a `(node, port)` has at most
        // one OUTGOING link, so it was already exact and this change must not touch it.
        assert_eq!(
            docks_of(&mut builder, &pkt, a),
            vec![BeltDockView {
                end: BeltEnd::Head,
                node: c_h,
                port: 0,
            }],
            "the first upstream delivers into c and is fed by nothing"
        );
        assert_eq!(
            docks_of(&mut builder, &pkt, b),
            vec![BeltDockView {
                end: BeltEnd::Head,
                node: c_h,
                port: 0,
            }],
            "the second upstream delivers into c and is fed by nothing"
        );
    }

    #[test]
    fn belt_docks_with_exactly_one_upstream_is_what_it_always_was() {
        // The boundary one step BELOW the fan-in, and the case that makes the LINK-13
        // change provably NARROW rather than a rewrite nobody bounded. A `find()` and a
        // `filter()` agree here and disagree one step above, so a plan that asserted only
        // the fan-in would not know which of the two it had shipped.
        let (_dir, mut host) = test_host();
        let up = host.core_mut().state.add_belt(2);
        let down = host.core_mut().state.add_belt(2);
        let sink = host.core_mut().state.add_source();
        host.core_mut().state.link((up, 0), (down, 0));
        host.core_mut().state.link((down, 0), (sink, 3));

        let mut builder = RenderPacketBuilder::new();
        let pkt = builder.build_keyframe(&host);
        let up_h = builder.handle_for(up);
        let sink_h = builder.handle_for(sink);

        assert_eq!(
            docks_of(&mut builder, &pkt, down),
            vec![
                BeltDockView {
                    end: BeltEnd::Head,
                    node: sink_h,
                    port: 3,
                },
                BeltDockView {
                    end: BeltEnd::Tail,
                    node: up_h,
                    port: 0,
                },
            ],
            "one upstream still yields exactly one Tail entry, after the Head entry, \
             with the docked (node, port) unchanged"
        );
    }

    #[test]
    fn belt_docks_with_no_upstream_emits_no_tail_entry() {
        // The boundary one step BELOW that: zero upstreams is an ABSENT Tail entry, never
        // a placeholder one. `beltRun`'s walk terminates on the ABSENCE of a dock, so a
        // zero-valued Tail entry would read as a dock to render handle 0.
        let (_dir, mut host) = test_host();
        let lone = host.core_mut().state.add_belt(2);
        let sink = host.core_mut().state.add_source();
        host.core_mut().state.link((lone, 0), (sink, 0));

        let mut builder = RenderPacketBuilder::new();
        let pkt = builder.build_keyframe(&host);
        let sink_h = builder.handle_for(sink);

        assert_eq!(
            docks_of(&mut builder, &pkt, lone),
            vec![BeltDockView {
                end: BeltEnd::Head,
                node: sink_h,
                port: 0,
            }],
            "a belt nothing feeds carries a Head entry and NO Tail entry at all"
        );
    }

    #[test]
    fn render_diff_idle_with_ports_is_empty() {
        // PORT-04: a node carrying ports is byte-identical tick-over-tick, so a second
        // build with no state change yields an empty active-set diff (no extra churn).
        use fabrico_core::state::{Port, Role, Side};
        let (_dir, mut host) = test_host();
        let n = host.core_mut().state.add_source();
        host.core_mut().state.set_ports(
            n,
            vec![Port {
                local_offset: (0, 0),
                side: Side::E,
                role: Role::Out, medium: Medium::Mechanical,
            }],
        );
        let mut builder = RenderPacketBuilder::new();
        let _baseline = builder.build(&host); // first build emits the ported node
        let pkt = builder.build(&host); // nothing changed
        assert!(!pkt.full, "a diff is never a keyframe");
        assert!(
            pkt.placed.is_empty() && pkt.belts.is_empty() && pkt.removed.is_empty(),
            "an idle ported node adds no churn to the diff"
        );
    }

    #[test]
    fn schema_version_unchanged_no_snapshot_bump() {
        // PORT-05: render-packet changes are ephemeral wire fields and must NOT drive a
        // logged/snapshot schema bump. Pin SCHEMA_VERSION so an accidental snapshot
        // change fails here. The pinned value is 2 after the deliberate v6.0 re-bless
        // (35-03) bumped the event schema in lockstep with the Port.medium byte-forcer —
        // that bump was schema-driven, NOT render-driven, which is exactly the
        // distinction this guard protects.
        assert_eq!(
            SCHEMA_VERSION, 2,
            "ports/docks are ephemeral wire fields — the render packet drives no snapshot bump (PORT-05)"
        );
    }

    #[test]
    fn producer_emits_packet_per_tick() {
        // After one on_tick, a subscriber's broadcast receiver yields exactly one
        // diff frame and the keyframe watch holds a non-empty full frame.
        let (_dir, mut host) = test_host();
        host.core_mut().state.add_source(); // one node so the diff is non-empty
        let mut producer = RenderProducer::new();
        let (keyframe_rx, mut diff_rx) = producer.subscribe();

        producer.on_tick(&host).expect("on_tick encodes + sends");

        let frame = diff_rx.try_recv().expect("exactly one diff frame");
        assert!(!frame.bytes.is_empty(), "the diff frame carries bytes");
        assert!(
            diff_rx.try_recv().is_err(),
            "exactly one frame per on_tick (no second frame)"
        );
        assert!(
            !keyframe_rx.borrow().bytes.is_empty(),
            "the keyframe watch holds a non-empty full frame"
        );
    }

    #[test]
    fn reset_pushes_full_over_diff_broadcast_subscribers_stay_live() {
        // HOST-05: an already-connected diff subscriber receives a `full:true`
        // packet after reset (its stream is NOT Closed), so a live webview clears
        // + repopulates inline across a Load host-swap instead of going dark.
        let (_dir, mut host) = test_host();
        host.core_mut().state.add_source();
        let mut producer = RenderProducer::new();
        // Subscribe BEFORE the reset (an already-connected webview).
        let (_keyframe_rx, mut diff_rx) = producer.subscribe();

        producer.reset(&host).expect("reset encodes + sends");

        // The pre-existing subscriber receives the reset packet over the DIFF
        // broadcast (not a RecvError::Closed) and it is a full:true keyframe.
        let bytes = diff_rx
            .try_recv()
            .expect("the reset rides the diff broadcast (subscriber stays live)")
            .bytes;
        let pkt: RenderPacket = postcard::from_bytes(&bytes).expect("decode reset packet");
        assert!(pkt.full, "the reset packet is a full:true keyframe");
        assert_eq!(
            pkt.placed.len(),
            1,
            "the reset keyframe carries the new scene's node"
        );
    }

    #[test]
    fn on_tick_after_reset_emits_empty_diff_no_re_emit() {
        // After a reset primes the diff baseline to the new scene, the NEXT
        // on_tick produces an EMPTY diff (no spurious re-emit of the just-
        // keyframed scene) — proving `reset` primed prev_nodes/prev_belts.
        let (_dir, mut host) = test_host();
        host.core_mut().state.add_source();
        let mut producer = RenderProducer::new();
        let (_keyframe_rx, mut diff_rx) = producer.subscribe();

        producer.reset(&host).expect("reset");
        // Drain the reset's full packet.
        let _full = diff_rx.try_recv().expect("reset packet present");

        // A no-change tick after the reset emits an empty diff.
        producer.on_tick(&host).expect("on_tick after reset");
        let bytes = diff_rx.try_recv().expect("exactly one diff frame").bytes;
        let pkt: RenderPacket = postcard::from_bytes(&bytes).expect("decode diff");
        assert!(!pkt.full, "a diff, not a keyframe");
        assert!(
            pkt.placed.is_empty() && pkt.belts.is_empty() && pkt.removed.is_empty(),
            "the tick after a reset re-emits nothing (baseline was primed)"
        );
    }

    // ======================= WR-01 (phase 72 code review) =======================
    // THE TWO GATES RUST WAS MISSING OVER THE `rot` DIMENSION SWAP.
    //
    // The swap decides the `WireBody` rectangle `resolve_wire_dock` hands the wire
    // auto-router, and `wire_route.rs`'s own design note says this is the one decode the
    // cross-language parity corpus structurally CANNOT see: the corpus supplies resolved
    // rectangles as literal numbers, so a transposition at a call site passes all 3920 of
    // its rows. `wire_golden.rs` cannot see it either - that fixture is `rot: 0`, where
    // the swap is the identity. TypeScript was gated for exactly this (`gestures.test.ts`
    // counts the raw decode in the comment-stripped gesture layer and requires zero);
    // Rust had nothing, in either the structural or the behavioural direction, so both
    // are added rather than one.
    // ============================================================================

    /// BEHAVIOURAL. The dock's body rectangle IS transposed under an odd `rot`, asserted
    /// against literal numbers rather than against `effective_box` - deriving the
    /// expectation from the function under test would agree with it by construction and
    /// go green on exactly the transposition this exists to catch.
    ///
    /// Both parities are asserted so a decode that swapped UNCONDITIONALLY is a red too.
    /// The footprint is NON-SQUARE for the reason the wire corpus carries a non-square
    /// shape pair: on a square footprint the swap is the identity and nothing can see it.
    #[test]
    fn the_wire_dock_body_is_the_rot_swapped_extent() {
        use fabrico_core::state::Footprint;
        let (_dir, mut host) = test_host();
        let n = host.core_mut().state.add_source();
        host.core_mut().state.set_cell(n, (10, 4));

        // rot 0: 3 wide, 1 tall, anchored at (10, 4).
        host.core_mut()
            .state
            .set_footprint(n, Footprint { w: 3, h: 1, rot: 0 });
        let even = resolve_wire_dock(host.core(), (n, 0));
        assert_eq!(
            (
                even.body.min_x,
                even.body.min_y,
                even.body.max_x,
                even.body.max_y
            ),
            (10, 4, 12, 4),
            "an even rot leaves the extent alone: 3 wide, 1 tall from the anchor",
        );

        // rot 1: the SAME footprint is 1 wide, 3 tall.
        host.core_mut()
            .state
            .set_footprint(n, Footprint { w: 3, h: 1, rot: 1 });
        let odd = resolve_wire_dock(host.core(), (n, 0));
        assert_eq!(
            (
                odd.body.min_x,
                odd.body.min_y,
                odd.body.max_x,
                odd.body.max_y
            ),
            (10, 4, 10, 6),
            "an odd rot TRANSPOSES the extent: 1 wide, 3 tall from the same anchor. A \
             transposition here would change every rotated multi-cell machine's cable \
             shape and pass the whole wire parity corpus",
        );
    }

    /// STRUCTURAL, the Rust twin of the TypeScript grep gate. The swap has ONE home in
    /// this language (`fabrico_core::state::effective_box`), so the honest count of raw
    /// decodes in the render-packet producer is ZERO.
    ///
    /// COMMENTS ARE STRIPPED BEFORE COUNTING, and for the same reason the TS gate strips
    /// them: this file explains itself in prose that names the decode, so a count over the
    /// raw text would redden on a comment edit and go on reddening until someone reworded
    /// a sentence. A guard that fires on prose teaches the next reader to stop believing
    /// it. The stripper is checked against the file it is stripping in the same test, so
    /// a stripper that ate the code it is meant to count cannot pass silently.
    #[test]
    fn the_rot_decode_has_one_home_and_it_is_not_this_file() {
        // THE NEEDLE IS ASSEMBLED, NEVER SPELLED. Written as one literal it would appear
        // in the very text it searches - inside this test's own code, which the stripper
        // does not and must not remove - and the gate would then be counting itself. The
        // same discipline `gestures.test.ts` records for the four-pixel lane gap.
        let needle: String = ["rot &", " 1"].concat();
        let src = include_str!("render_packet.rs");
        let code: String = src
            .lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        assert_eq!(
            code.matches(&needle).count(),
            0,
            "the rot decode lives in fabrico_core::state::effective_box, reached through \
             it and never re-written here",
        );
        // ...and the stripper is not eating the code it is meant to count: the call site
        // that replaced the hand-rolled swap is still in `code`.
        assert!(
            code.contains("effective_box(fp.w, fp.h, fp.rot)"),
            "the stripper left the call site it is counting around",
        );
        // ...and the prose the stripper removes really does carry the needle, so a
        // stripper that silently stopped stripping is caught by the count above rather
        // than by nothing.
        assert!(
            src.matches(&needle).count() > 0,
            "this file's own prose names the decode; if it stops doing so, the stripper \
             check above stops being a check",
        );
    }

    // ── 73-12 (73-REVIEW WR-01): the resync tag ──────────────────────────────────

    /// A minimal packet whose only interesting field is the one under test.
    fn bare_keyframe() -> RenderPacket {
        RenderPacket {
            tick: 7,
            full: true,
            placed: Vec::new(),
            removed: Vec::new(),
            belts: Vec::new(),
            can_undo: true,
            can_redo: false,
            wires: Vec::new(),
            resync: false,
            generation: 4,
            swap_floor: 2,
        }
    }

    /// THE WR-01 HEADLINE. A producer keyframe says "the timeline was restructured";
    /// the same bytes resent on a lag must say "you merely missed frames".
    #[test]
    fn the_resync_tag_flips_exactly_one_bit_and_nothing_else() {
        let pkt = bare_keyframe();
        assert!(!pkt.resync, "a producer keyframe is never a resync");
        let bytes = postcard::to_allocvec(&pkt).expect("encode");

        let tagged = tag_keyframe_as_resync(bytes.clone());
        assert_ne!(tagged, bytes, "the tag really changed the frame");

        let back: RenderPacket = postcard::from_bytes(&tagged).expect("decode the tagged frame");
        assert!(back.resync, "and the client can read it");
        // Every OTHER field is byte-identical, asserted by re-clearing the one bit and
        // comparing whole packets rather than field by field - a field-by-field check
        // is satisfied by a tagger that dropped a field this test forgot to name.
        let mut cleared = back;
        cleared.resync = false;
        assert_eq!(cleared, pkt, "the tag touched nothing but its own bit");
    }

    /// The tagger must never turn a frame it cannot read into NO frame: a client that
    /// lagged and then got nothing holds a stale scene forever.
    #[test]
    fn an_undecodable_frame_is_passed_through_unchanged_rather_than_dropped() {
        let junk = vec![0xFFu8; 12];
        assert_eq!(
            tag_keyframe_as_resync(junk.clone()),
            junk,
            "an undecodable keyframe goes out as-is; the client reads it exactly as it did \
             before this field existed"
        );
    }

    /// The NEGATIVE CONTROL, declared as one: the producer sets the bit on NEITHER of
    /// the two packets it builds. Without this row `tag_keyframe_as_resync` could be a
    /// no-op wrapper around a producer that already set the flag, and the row above
    /// would still pass.
    #[test]
    fn neither_producer_packet_is_ever_tagged_a_resync() {
        assert!(!bare_keyframe().resync);
    }

    // ── Phase 88 (D-02, D-05): the board generation crosses the wire ──────────────

    /// THE GENERATION RIDES EVERY PACKET. A diff and a keyframe from `on_tick`, and the
    /// keyframe from `reset`, each decode to a `generation` equal to the
    /// `RenderFrame.generation` the producer sent beside the bytes, and `reset` raises it
    /// by exactly one. The lag tagger decodes and re-encodes, so the field survives it.
    ///
    /// Two `on_tick` rounds are read, one before and one after the reset, so a producer
    /// that stamped a constant (0, or the value it had at construction) is caught on the
    /// second round rather than passing on a fresh producer where every value is 0.
    #[test]
    fn every_frame_carries_the_producer_generation() {
        let (_dir, mut host) = test_host();
        host.core_mut().state.add_source();
        let mut producer = RenderProducer::new();
        let (mut keyframe_rx, mut diff_rx) = producer.subscribe();
        let read = |frame: &RenderFrame| -> RenderPacket {
            postcard::from_bytes(&frame.bytes).expect("decode a producer frame")
        };

        producer.on_tick(&host).expect("on_tick");
        let diff = diff_rx.try_recv().expect("a diff frame");
        let kf = keyframe_rx.borrow_and_update().clone();
        assert_eq!(producer.generation(), 0, "PRECONDITION: a fresh producer is at 0");
        assert_eq!((read(&diff).generation, diff.generation), (0, 0), "diff before any reset");
        assert_eq!((read(&kf).generation, kf.generation), (0, 0), "keyframe before any reset");

        producer.reset(&host).expect("reset");
        assert_eq!(producer.generation(), 1, "a reset raises the generation by exactly one");
        let reset_frame = diff_rx.try_recv().expect("the reset keyframe rides the diff broadcast");
        let reset_pkt = read(&reset_frame);
        assert!(reset_pkt.full, "PRECONDITION: the reset frame is a keyframe");
        assert_eq!(
            (reset_pkt.generation, reset_frame.generation),
            (1, 1),
            "the reset keyframe names the NEW table's generation"
        );

        producer.on_tick(&host).expect("on_tick after the reset");
        let diff = diff_rx.try_recv().expect("a diff frame");
        let kf = keyframe_rx.borrow_and_update().clone();
        assert_eq!((read(&diff).generation, diff.generation), (1, 1), "diff after the reset");
        assert_eq!((read(&kf).generation, kf.generation), (1, 1), "keyframe after the reset");

        let tagged: RenderPacket =
            postcard::from_bytes(&tag_keyframe_as_resync(kf.bytes.clone())).expect("decode tagged");
        assert!(tagged.resync, "PRECONDITION: the tagger set the bit");
        assert_eq!(tagged.generation, 1, "the lag tagger keeps the generation");
    }

    // ── Phase 88 (D-02, D-03, D-05): a gesture resolves against the table it was read from ──

    /// THE TABLE THE CLIENT SAW. Two Sources are minted at generation 0 as `a = 0`, `b = 1`;
    /// `a` is removed and `c` added, minted at 0 as handle 2. A reset to generation 1
    /// re-mints in node order, which puts `c` (in the slot `a` left) first: the new table
    /// gives `c` handle 0, so handle 0 now names a different node. `resolve_at(0, h)` still names what
    /// the generation-0 table gave `h` (handle 0 is `a`, dead, which `validate_normalize`
    /// refuses), and `resolve_at(1, h)` what the new table gives it.
    #[test]
    fn resolve_at_reads_the_table_the_client_saw() {
        let (_dir, mut host) = test_host();
        let a = host.core_mut().state.add_source();
        let b = host.core_mut().state.add_source();
        let mut producer = RenderProducer::new();
        producer.on_tick(&host).expect("on_tick mints a and b");
        assert_eq!(
            (producer.handle_for_node(a), producer.handle_for_node(b)),
            (Some(0), Some(1)),
            "PRECONDITION: generation 0 mints a = 0, b = 1"
        );
        host.core_mut().state.remove_node(a);
        let c = host.core_mut().state.add_source();
        producer.on_tick(&host).expect("on_tick mints c");
        assert_eq!(producer.handle_for_node(c), Some(2), "PRECONDITION: c is minted 2 at generation 0");

        producer.reset(&host).expect("reset to generation 1");
        assert_eq!(producer.generation(), 1, "PRECONDITION: one reset");
        let new_c = producer.handle_for_node(c).expect("c is drawn at generation 1");
        let new_b = producer.handle_for_node(b).expect("b is drawn at generation 1");
        assert!(
            new_c != 2 && producer.node_for_handle(0).is_some_and(|id| id != a),
            "PRECONDITION: the reset reorders the handles (c leaves 2, handle 0 names a live node \
             other than a), or this proves nothing: b={new_b} c={new_c}"
        );

        assert_eq!(producer.resolve_at(0, 0), Resolved::Node(a), "generation 0, handle 0: a, as the client saw it");
        assert_eq!(producer.resolve_at(0, 1), Resolved::Node(b), "generation 0, handle 1: b");
        assert_eq!(producer.resolve_at(0, 2), Resolved::Node(c), "generation 0, handle 2: c");
        assert_eq!(producer.resolve_at(1, new_b), Resolved::Node(b), "generation 1 reads the new table for b");
        assert_eq!(producer.resolve_at(1, new_c), Resolved::Node(c), "generation 1 reads the new table for c");
        assert_eq!(producer.resolve_at(1, 2), Resolved::Gone, "the new table never minted handle 2");
        assert_eq!(producer.resolve_at(0, 3), Resolved::Gone, "the old table never minted handle 3");
        assert_eq!(producer.node_for_handle(new_c), Some(c), "node_for_handle reads the current table");
    }

    /// THE BOUND (T-88-12). After `KEPT_GENERATIONS + 1` resets the current generation is
    /// `g`; generation `g - KEPT_GENERATIONS` still reads its table and `g - KEPT_GENERATIONS - 1`
    /// is `TooOld`, for `resolve_at` and `check_generation` alike.
    #[test]
    fn resolve_at_keeps_eight_generations_and_no_more() {
        assert_eq!(KEPT_GENERATIONS, 8, "the kept history is eight tables");
        let (_dir, mut host) = test_host();
        let s = host.core_mut().state.add_source();
        let mut producer = RenderProducer::new();
        producer.on_tick(&host).expect("on_tick mints the Source");
        for _ in 0..=KEPT_GENERATIONS {
            producer.reset(&host).expect("reset");
        }
        let g = producer.generation();
        assert_eq!(g, KEPT_GENERATIONS as u64 + 1, "PRECONDITION: nine resets");
        let oldest = g - KEPT_GENERATIONS as u64;
        for kept in oldest..g {
            assert_eq!(producer.resolve_at(kept, 0), Resolved::Node(s), "generation {kept} is kept");
            assert_eq!(producer.check_generation(kept), Ok(()), "generation {kept} is readable");
        }
        assert_eq!(producer.resolve_at(g, 0), Resolved::Node(s), "the current generation reads the live table");
        assert_eq!(producer.resolve_at(oldest - 1, 0), Resolved::TooOld, "generation {} is past the kept history", oldest - 1);
        assert_eq!(producer.check_generation(oldest - 1), Err(Resolved::TooOld));
        assert_eq!(producer.resolve_at(0, 0), Resolved::TooOld, "generation 0 is long gone");
    }

    /// THE FLOOR AND THE CEILING (D-05, T-88-11, T-88-13). A swap clears the kept tables and
    /// sets the floor at its own generation: every generation under it reads `Discard`, even
    /// one that a plain reset would have kept. A generation above the current one reads
    /// `Ahead`. A plain reset after the swap keeps the swap's table as usual.
    #[test]
    fn resolve_at_refuses_below_the_swap_floor_and_ahead_of_the_board() {
        let (_dir, mut host) = test_host();
        let s = host.core_mut().state.add_source();
        let mut producer = RenderProducer::new();
        producer.on_tick(&host).expect("on_tick mints the Source");
        producer.reset(&host).expect("reset to 1");
        assert_eq!(producer.resolve_at(0, 0), Resolved::Node(s), "PRECONDITION: a plain reset keeps generation 0");

        producer.reset_for_swap(&host).expect("swap to 2");
        assert_eq!(producer.generation(), 2, "PRECONDITION: the swap is a reset");
        assert_eq!(producer.resolve_at(0, 0), Resolved::Discard, "generation 0 is from the replaced board");
        assert_eq!(producer.resolve_at(1, 0), Resolved::Discard, "generation 1 is from the replaced board");
        assert_eq!(producer.check_generation(1), Err(Resolved::Discard));
        assert_eq!(producer.resolve_at(2, 0), Resolved::Node(s), "the swap's own generation reads the new board");
        assert_eq!(producer.resolve_at(3, 0), Resolved::Ahead, "no client was sent generation 3");
        assert_eq!(producer.check_generation(3), Err(Resolved::Ahead));
        assert_eq!(producer.resolve_at(u64::MAX, 0), Resolved::Ahead, "nor any above it");

        producer.reset(&host).expect("reset to 3");
        assert_eq!(producer.resolve_at(2, 0), Resolved::Node(s), "a reset after the swap keeps the swap's table");
        assert_eq!(producer.resolve_at(1, 0), Resolved::Discard, "the floor stays where the swap set it");
        assert_eq!(producer.resolve_at(4, 0), Resolved::Ahead);
    }

    /// THE SWAP FLOOR RIDES EVERY PACKET (phase 88 security, T-88-11). An undo's keyframe and
    /// a swap's keyframe both raise the generation, so only the floor tells a client which one
    /// it holds. The swap's OWN keyframe already names the new floor (it is set before the
    /// keyframe is stamped), every diff and keyframe after it carries it, and a plain reset
    /// leaves it where the swap put it. Before the field a client learned of a swap only when
    /// it had asked for one itself, so a Load from another client let it name a pre-swap belt
    /// again on the loaded board.
    #[test]
    fn every_frame_carries_the_swap_floor_from_the_swap_keyframe_on() {
        let (_dir, mut host) = test_host();
        host.core_mut().state.add_source();
        let mut producer = RenderProducer::new();
        let (mut keyframe_rx, mut diff_rx) = producer.subscribe();
        let read = |frame: &RenderFrame| -> RenderPacket {
            postcard::from_bytes(&frame.bytes).expect("decode a producer frame")
        };
        let floors = |pkt: &RenderPacket| (pkt.generation, pkt.swap_floor);

        producer.on_tick(&host).expect("on_tick");
        assert_eq!(floors(&read(&diff_rx.try_recv().expect("a diff"))), (0, 0), "before any swap");

        producer.reset(&host).expect("an undo's reset");
        let undo = read(&diff_rx.try_recv().expect("the reset keyframe"));
        assert!(undo.full, "PRECONDITION: a keyframe");
        assert_eq!(floors(&undo), (1, 0), "an undo's keyframe raises the generation and not the floor");

        producer.reset_for_swap(&host).expect("a swap");
        let swap = read(&diff_rx.try_recv().expect("the swap keyframe"));
        assert!(swap.full, "PRECONDITION: a keyframe");
        assert_eq!(floors(&swap), (2, 2), "the swap's own keyframe names the new floor");

        producer.on_tick(&host).expect("on_tick after the swap");
        assert_eq!(floors(&read(&diff_rx.try_recv().expect("a diff"))), (2, 2), "a diff after the swap");
        assert_eq!(floors(&read(&keyframe_rx.borrow_and_update().clone())), (2, 2), "the resync keyframe too");

        producer.reset(&host).expect("an undo after the swap");
        let after = read(&diff_rx.try_recv().expect("the reset keyframe"));
        assert_eq!(floors(&after), (3, 2), "a plain reset keeps the floor where the swap set it");
        let tagged: RenderPacket =
            postcard::from_bytes(&tag_keyframe_as_resync(keyframe_rx.borrow_and_update().bytes.clone()))
                .expect("decode tagged");
        assert_eq!(floors(&tagged), (3, 2), "the lag tagger keeps the floor");
    }

    /// A frame as the producer would send it, with stand-in bytes that name it.
    fn relay_frame(generation: u64, tick: u64) -> RenderFrame {
        RenderFrame {
            generation,
            tick,
            bytes: [generation.to_le_bytes(), tick.to_le_bytes()].concat(),
        }
    }

    #[test]
    fn relay_forwards_every_frame_without_a_lag() {
        let (mut relay, first) = RenderRelay::open(&relay_frame(0, 1));
        assert_eq!(first, relay_frame(0, 1).bytes);
        // In order, an equal tick (a paused diff), a reset's lower tick in a higher
        // generation, and an older frame: with no lag the relay is a pass-through.
        for (g, t) in [(0, 2), (0, 3), (0, 3), (1, 1), (1, 2), (0, 9)] {
            let frame = relay_frame(g, t);
            let bytes = frame.bytes.clone();
            assert_eq!(relay.forward(frame), Some(bytes), "frame ({g}, {t}) forwarded");
        }
    }

    /// Phase 90 review IN-A-01: both transports resubscribe to the diff broadcast BEFORE they
    /// read the keyframe watch, and the producer sends a tick's diff before it updates the
    /// watch, so a connection opened between the two is sent keyframe T and then diff T, which
    /// the keyframe already holds. `open` floors at its own keyframe, the rule `lagged` applies.
    #[test]
    fn relay_open_drops_the_diff_its_keyframe_already_holds() {
        let (mut relay, first) = RenderRelay::open(&relay_frame(0, 5));
        assert_eq!(first, relay_frame(0, 5).bytes, "the opening keyframe is sent");
        assert_eq!(
            relay.forward(relay_frame(0, 5)),
            None,
            "the diff for the opening keyframe's own tick is not sent again"
        );
        let next = relay_frame(0, 6);
        let bytes = next.bytes.clone();
        assert_eq!(relay.forward(next), Some(bytes), "the next tick is sent");
    }

    #[test]
    fn relay_drops_frames_at_or_below_the_lag_floor() {
        let (mut relay, _) = RenderRelay::open(&relay_frame(1, 40));
        let kf = relay.lagged(&relay_frame(1, 301));
        assert!(!kf.is_empty(), "the lag keyframe is sent");
        for (g, t) in [(0, 400), (1, 46), (1, 300), (1, 301)] {
            assert_eq!(
                relay.forward(relay_frame(g, t)),
                None,
                "frame ({g}, {t}) is at or below the lag floor (1, 301) and is dropped"
            );
        }
        let newer = relay_frame(1, 302);
        let bytes = newer.bytes.clone();
        assert_eq!(relay.forward(newer), Some(bytes), "frame (1, 302) is newer than the floor");
    }

    #[test]
    fn relay_passes_a_newer_generation_with_a_lower_tick() {
        let (mut relay, _) = RenderRelay::open(&relay_frame(1, 40));
        let _ = relay.lagged(&relay_frame(1, 301));
        // A reset after the lag keyframe (a New restarts the tick near 0): the generation is
        // compared first, so its lower tick does not drop it.
        let reset = relay_frame(2, 3);
        let bytes = reset.bytes.clone();
        assert_eq!(relay.forward(reset), Some(bytes), "frame (2, 3) passes a floor of (1, 301)");
        assert!(relay.forward(relay_frame(2, 4)).is_some(), "the new generation runs on");
    }

    #[test]
    fn relay_moves_its_floor_on_each_lag() {
        let (mut relay, _) = RenderRelay::open(&relay_frame(0, 1));
        let _ = relay.lagged(&relay_frame(0, 301));
        assert_eq!(relay.forward(relay_frame(0, 301)), None, "at the first floor");
        assert!(relay.forward(relay_frame(0, 302)).is_some(), "past the first floor");
        let _ = relay.lagged(&relay_frame(0, 700));
        assert_eq!(
            relay.forward(relay_frame(0, 500)),
            None,
            "a frame past the first floor but at or below the second is dropped"
        );
        assert!(relay.forward(relay_frame(0, 701)).is_some(), "past the second floor");
    }

    #[test]
    fn relay_takes_no_floor_from_an_empty_keyframe() {
        // Before the first tick the keyframe watch holds an empty default frame. A transport
        // sends nothing for it, so it must not become a floor that drops the first real frame.
        let (mut relay, first) = RenderRelay::open(&RenderFrame::default());
        assert!(first.is_empty());
        assert!(relay.lagged(&RenderFrame::default()).is_empty());
        let frame = relay_frame(0, 0);
        let bytes = frame.bytes.clone();
        assert_eq!(relay.forward(frame), Some(bytes), "frame (0, 0) after an empty lag keyframe");
    }
}
