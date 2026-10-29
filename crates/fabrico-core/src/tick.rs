//! The fixed-tick fold: the deterministic projection function that turns a
//! logged event stream into grid state, one integer tick at a time
//! (CORE-01/CORE-02, RESEARCH Pattern 1).
//!
//! One [`tick`] does five things, in this fixed order:
//! 0. **EDITS-FIRST (build, then run)** — apply every topology [`EditRecord`] for
//!    this tick (mint/link/remove via [`apply_edit`]) BEFORE admitting any runtime
//!    event (decision Q1 / FORK 3). An edit at tick T is therefore visible to the
//!    items flowing at T. This is the canonical merge order of the two ordered logs
//!    (the edit-log + the runtime event-log) and sits NEXT TO the deliver-then-admit
//!    (T-1-BUF) rule below. It is **behavior-preserving** vs the v1.0 inline gesture
//!    fold (which already ran gestures in the admit stage, ahead of the fixpoint) and
//!    **RNG-stream-preserving** (the only admit-stage RNG draw is
//!    `fold_place(FACTORY)`; grouping every edit ahead of zero-draw event admits
//!    changes no factory sub-seed draw order — Assumption A2). Replay applies the
//!    frozen RESOLVED records with NO re-validation / NO re-normalization (Q2/SC#3).
//! 1. **Admit** every inbound event at this tick boundary (via the source's
//!    [`crate::manual_inject::admit`] helper), routing each to its target and
//!    waking it. After the Phase-8 clean break (decision Q4) the event log carries
//!    ONLY the four non-gesture payloads; topology edits (place/wire/delete) flow
//!    through the EDIT log and `apply_edit` (step 0), never this admit stage.
//! 2. **Promote** scheduled wakes due this tick into the active set
//!    ([`Scheduler::take_due`]).
//! 3. **Fold** the active set in **stable ascending [`NodeId`] order** — a
//!    bounded fixpoint so that 0-latency (instant-wire) chains propagate within
//!    the same tick. Each stepped node's outputs are routed onto belts/links and
//!    the downstream targets are woken.
//! 4. **Advance** logical time (`tick += 1`).
//!
//! # No full-grid scan (CORE-07)
//! The fold iterates only [`Scheduler::drain_active_sorted`] — the woken set. It
//! **never** iterates `state.nodes` to decide who steps; an idle tick (no events,
//! empty wheel) drains an empty active set and steps zero machines.
//!
//! # Determinism (threat T-1-DET)
//! Step order is `drain_active_sorted()` (ascending id); output routing drains
//! the outbox in ascending `(port, link-key)` order; arrival math is integer
//! tick arithmetic. The only authority a machine touches is its `StepCtx`. The
//! same-tick fixpoint is capped at `node_count + 1` iterations so a 0-latency
//! cycle surfaces as a bounded stop rather than a hang (a Phase-2 topology
//! concern; T-1-FUSE accepted for Phase 1).

use crate::command::{Command, Effect};
use crate::core::Core;
use crate::edit::{EditOp, EditRecord, MachineConfig};
use crate::event::Event;
use crate::fault::{Fault, FaultReason, FAULT_PORT};
use crate::ids::{Item, NodeId, PortId};
use crate::scheduler::Scheduler;
use crate::state::{
    BeltTile, GridState, Node, Port, PortInbox, PortOutbox, SinkTemplate, WireLink,
};
use std::collections::{BTreeMap, BTreeSet};

// DELETED IN PHASE 72 PLAN 04: the per-tick reply-binding type alias that stood here,
// `BTreeMap<u64, ((NodeId, PortId), u64)>`. The name is deliberately not repeated anywhere
// under `crates/`, so that a grep for it returns nothing rather than a dangling reference to
// a mechanism that no longer exists; it is recorded by name in the project history for
// phase 72 plan 04, which is where a reader chasing the old name will land.
//
// WHAT IT WAS. A per-tick, fold-local map `correlation -> (return_addr, remaining_budget)`,
// written by `step_wire` the tick a request was FORWARDED and read by `route_replies` when
// the handler emitted an `Effect::Reply`. It existed to carry the caller's reply address
// without adding a serialized field, because a serialized field would have byte-shifted the
// whole golden corpus.
//
// WHY IT IS GONE, AND WHAT A READER LOOKING FOR IT SHOULD KNOW. It was rebuilt EMPTY every
// tick, and a Factory drains only `FACTORY_ITEMS_PER_TICK` items per tick and re-wakes at
// now+1. So a reply emitted on any tick LATER than the tick its request hopped found no
// binding and was silently DROPPED. Two POSTs arriving on one tick at one handler therefore
// produced exactly ONE in-sim reply. That loss was invisible to every HTTP-level assertion
// in this repository, because the host resolves the parked socket by correlation off the
// command stream and reads nothing from the grid: the answer went out and nothing travelled
// home. Its last-writer-wins `insert` rule had a second cost, WINDOWS 124: nothing in the map
// said WHICH cable a reply should take, so `route_replies` picked the lowest ascending
// `NodeId` out of the handler and a second caller's reply rode the first caller's cable.
//
// WHAT REPLACED IT. The two values now ride on the reply itself, as
// `Effect::Reply { return_addr, budget }` (`command.rs`), sourced from the `WireEnvelope` the
// handler was servicing. No scratch state, no per-tick lifetime, and the address is available
// on the tick the reply is emitted no matter how many ticks after the hop that is. There is
// still ZERO persistent per-request router state (WIRE-01) and still no new snapshot field:
// `Effect` is a command-stream type the corpus carries no instances of.

/// Advance `core` by exactly one tick, applying `edits` (the topology edit-records
/// logged at the current tick) EDITS-FIRST, then folding `events` (the runtime
/// events logged at the current tick) into grid state. Returns the command intent
/// emitted this tick (never dispatched in Phase 1).
///
/// The canonical per-tick phase order is documented in the module doc-comment:
/// EDITS-FIRST (build, then run) → admit events → take_due → bounded fixpoint →
/// `tick += 1` (decision Q1 / FORK 3).
pub fn tick(core: &mut Core, edits: &[EditRecord], events: &[Event]) -> Vec<Command> {
    let mut commands = Vec::new();

    // Clear the per-tick observation surface (presentation-only, #[serde(skip)] —
    // zero snapshot-byte impact). The fold repopulates it below: `placed`/`removed`
    // during the edits-first apply + the retained gesture folds, `stepped`/`faulted`
    // during the fixpoint.
    core.last_tick = crate::core::TickObservation::default();

    // (0) EDITS-FIRST (build, then run): apply the RESOLVED edit-records in edit-log
    //     order, mutating topology BEFORE any runtime event is admitted (decision Q1).
    //     NO re-validation / NO re-normalization — the records are applied verbatim
    //     (Q2/SC#3). This is behavior-preserving + RNG-stream-preserving (A2): see the
    //     module doc-comment.
    for er in edits {
        apply_edit(core, er);
    }
    // A tick that carries edits wakes every machine asleep behind a blocked output (phase
    // 87, JAM-04, D-06): a Disconnect, the delete of a destination, a port edit or a
    // rotate can lift a block without any consumer stepping. Each sleeper steps once this
    // tick; one still gated goes straight back to sleep. See the gate in `step_node`.
    if !edits.is_empty() {
        core.sched.wake_all_blocked_now();
    }

    // (1) Admit logged events: route each to its target and wake it. After the
    //     Phase-8 clean break (decision Q4) the runtime event log carries ONLY the
    //     four non-gesture payloads (ManualInject/Input/CommandResult/Timeout) — all
    //     admitted through `admit`. Topology edits (place/wire/delete) no longer ride
    //     the event log; they fold EDITS-FIRST above via `apply_edit` (the edit-log
    //     path), the ONLY mutator of topology.
    for ev in events {
        crate::manual_inject::admit(&mut core.state, &mut core.sched, ev, core.tick);
    }

    // (2) Promote scheduled wakes due this tick into the active set. On an idle
    //     tick this is a single O(log n) miss that activates nothing (CORE-07).
    core.sched.take_due(core.tick);

    // (3) Bounded fixpoint over the active set so instant-wire (0-latency)
    //     chains propagate within this tick. The cap bounds 0-latency cycles.
    let cap = core.state.node_count() + 1;
    let mut iterations = 0usize;
    // Per-tick monotonic counter stamped onto each routed item as its `event_seq`
    // (ROUTE-06). Items routed in the same tick — including across the fixpoint
    // iterations and to different input ports of one node — get strictly
    // increasing seqs, giving cross-port resolution a total order instead of the
    // old "every item stamped with `now`" tie. It is reset every tick and is a
    // pure function of this tick's deterministic routing order, so it adds no
    // Core-level state and is snapshot/replay safe.
    let mut route_seq = 0u64;
    loop {
        let active: Vec<NodeId> = core.sched.drain_active_sorted();
        if active.is_empty() {
            break;
        }
        // Record every node stepped this fixpoint iteration into the observation
        // (the host derives `working` from membership). Accumulated across
        // iterations so an instant-wire chain reports every node it stepped.
        core.last_tick.stepped.extend(active.iter().copied());
        for id in active {
            step_node(core, id, &mut commands, &mut route_seq);
        }
        iterations += 1;
        if iterations > cap {
            break;
        }
    }

    // (4) Advance logical time.
    core.tick += 1;
    commands
}

// --- Phase-7 gesture folds (Place/Wire/Delete) ---
//
// `kind:u8` follows the shared `machine_kind` convention — the single source of
// truth is `fabrico-protocol::machine_kind`. fabrico-core is the headless crate
// and does NOT depend on the (ts-rs-bearing) protocol crate, so the mapping is
// re-declared here; it MUST stay in lockstep with `fabrico-protocol::machine_kind`.
mod machine_kind {
    pub const SOURCE: u8 = 0;
    /// Byte 1 stays RESERVED for BELT in lockstep with `fabrico-protocol::machine_kind`
    /// even though `fold_place` no longer mints a belt (17-02 removed the Place{BELT}
    /// arm — belts come only from `DrawBelt`). Kept so the byte mapping never drifts.
    #[allow(dead_code)]
    pub const BELT: u8 = 1;
    pub const FACTORY: u8 = 2;
    pub const TEE: u8 = 3;
    pub const BALANCER: u8 = 4;
    pub const ROUTER: u8 = 5;
    pub const MERGE: u8 = 6;
    pub const SINK: u8 = 7;
    /// Byte 8 — WIRE (Phase-37 transport). Mirrors `fabrico-protocol::machine_kind::WIRE`.
    /// The machine_kind u8 order is DELIBERATELY distinct from the `Node` discriminant
    /// order; append at the next free byte, never align the two orderings. `fold_place`
    /// mints no wire (a `Place{WIRE}` is a typed reject at validate time, Phase 36), so
    /// this const is unused here today — kept in lockstep so the byte mapping never drifts.
    #[allow(dead_code)]
    pub const WIRE: u8 = 8;
    /// Byte 9 — ENDPOINT (Phase-38 host bridge). Mirrors `fabrico-protocol::machine_kind::ENDPOINT`.
    /// Same distinct-ordering discipline as WIRE. `fold_place` DOES mint an endpoint
    /// from this byte (63-04, WIRE-03) — the `#[allow(dead_code)]` the const used to
    /// carry is gone because the arm is real.
    pub const ENDPOINT: u8 = 9;
    /// Byte 10 - HANDLER (72-05, SERVE-03). Mirrors `fabrico-protocol::machine_kind::HANDLER`.
    /// Same append-at-the-next-free-byte, distinct-ordering discipline as WIRE and
    /// ENDPOINT. `fold_place` DOES mint from this byte (72-06): it folds to a
    /// `Node::Factory` seeded with `DEFAULT_HANDLER_SOURCE`, so it carries no
    /// `#[allow(dead_code)]` and adds no `Node` variant (D-11).
    pub const HANDLER: u8 = 10;
    /// Byte 11 - LABEL (phase 76, SHAPE-10). Mirrors `fabrico-protocol::machine_kind::LABEL`,
    /// in lockstep, at the next free byte. `fold_place` mints a `Node::Label` from it
    /// through `GridState::add_label`, drawing no random number (D-03).
    pub const LABEL: u8 = 11;
}

/// Apply one RESOLVED [`EditRecord`] EDITS-FIRST (decision Q1): match its
/// [`EditOp`] and drive the `fold_place`/`fold_delete` bodies. After
/// the Phase-8 clean break (decision Q4) this is the SOLE topology-fold path — the
/// legacy inline event-log gesture fold is gone. `fold_place(FACTORY)` is the only
/// admit-stage RNG draw, so applying every edit ahead of zero-draw event admits is
/// RNG-stream-preserving (Assumption A2).
///
/// The records are applied VERBATIM — NO re-validation, NO re-normalization
/// (Q2/SC#3): `apply_edit` is a dumb applier, not a validator. As of Phase 9
/// (SPAT-01) the `cell_x`/`cell_y` carried by [`EditOp::Place`] are FOLDED into
/// `GridState.cells` (via `fold_place`), reversing the v1.0 "cells never in core"
/// decision; the `cell_x`/`cell_y` + `kind` captured on a `Delete` are for Phase-12
/// inverse-append, not consumed here (`fold_delete` clears the cell through
/// `remove_node`).
fn apply_edit(core: &mut Core, er: &EditRecord) {
    match &er.op {
        // 10-03: the frozen `w`/`h`/`ports` are applied VERBATIM via
        // `claim_footprint` (no catalog lookup — replay is catalog-independent,
        // decision Q2). A 1×1 with no ports stays byte-identical to v4 (claims its
        // single cell, writes NO footprints/ports entry, absent ⇒ 1×1 rot0); a
        // multi-cell record claims its whole body + writes the footprints/ports map.
        EditOp::Place {
            kind,
            cell_x,
            cell_y,
            w,
            h,
            ports,
            rot,
        } => fold_place(core, *kind, *cell_x, *cell_y, *w, *h, ports, *rot),
        EditOp::Delete { node, .. } => fold_delete(core, *node),
        // 10-06: apply the resolved ABSOLUTE `new_rot` VERBATIM (no catalog lookup,
        // no fold-time collision re-check — legality was decided at validate time,
        // Q2). `old_rot` rides for Phase-12 inverse-append and is NOT consumed here.
        EditOp::Rotate { node, new_rot, .. } => fold_rotate(core, *node, *new_rot),
        // 11-02: apply the RESOLVED normalized tiles VERBATIM (BELT-04 — replay never
        // re-routes, never calls `route()`); the decode guard already bounded the
        // tile count + cell extents at `edit::upcast`.
        EditOp::DrawBelt { tiles } => fold_draw_belt(core, tiles),
        // 11-06: link the belt endpoint to the machine port VERBATIM per the dock
        // direction (no re-validation — legality decided at validate time, Q2).
        EditOp::Dock {
            belt,
            endpoint,
            node,
            port,
        } => fold_dock(core, *belt, *endpoint, *node, *port),
        // 12-01: Unlink is the directional INVERSE of Dock — `fold_unlink` removes
        // exactly the one directed link the matching dock created (VERBATIM, no
        // re-validation; a frozen inverse record).
        EditOp::Unlink {
            belt,
            endpoint,
            node,
            port,
        } => fold_unlink(core, *belt, *endpoint, *node, *port),
        // 36-01: AddPort/RemovePort now BEHAVE (PORT-07) — they fold into the stored
        // ports+footprints maps VERBATIM (no re-validation; legality is decided at
        // command validate time in plan 02), mirroring the Place/Rotate/Dock arms.
        EditOp::AddPort { node, port, index, seat } => fold_add_port(core, *node, port, *index, *seat),
        EditOp::RemovePort { node, index, restore } => fold_remove_port(core, *node, *index, *restore),
        // 39-01: `Configure` now BEHAVES (CFG-02) — it folds the two EXISTING
        // serialized fields (`Factory.source` / `Sink.template`) VERBATIM and, for a
        // Factory, evicts the NodeId-keyed runtime cache so the NEW source runs. A
        // Source config is a CORE no-op (its trigger is host-side, Phase-39 hard
        // constraint). `code_hash` is opaque here — stored/round-tripped by the record,
        // NEVER read by the fold. Mirrors the AddPort/Dock destructuring arms.
        EditOp::Configure { node, config, .. } => fold_configure(core, *node, config),
        // 63-02: `DrawWire` BEHAVES (WIRE-01) — it mints a `Node::Wire` through the
        // SAME `GridState::add_wire` seam the genesis demo wire uses and records the one
        // forward link, VERBATIM (no re-validation; legality is decided at command
        // validate time, Q2). It folded to nothing from Phase 35 to Phase 62; plan 63-03
        // corrected the fifteen sites across five crates and the frontend that said so.
        EditOp::DrawWire {
            from_node,
            from_port,
            to_node,
            to_port,
        } => fold_draw_wire(core, *from_node, *from_port, *to_node, *to_port),
        // 12-01: Undo/Redo remain fold-NOOP lineage markers, and they are the ONLY
        // remaining fold-NOOP arms (12-RESEARCH Pattern 1). They carry no topology, so
        // folding one changes ZERO GridState bytes (NEVER mints, mutates or routes;
        // NEVER `unreachable!`/panics on a forged log record, SCHEMA-03). That is the
        // shape, not a stage: the inverse group a marker names is built ONE LAYER UP,
        // by `fabrico_command::GridSession::compute_inverse`, which reads the marker's
        // `target_action` off the log. Nothing about them is owed to a later phase.
        //
        // 85-05 (D-10): the history seal joins them. It carries no topology either and
        // folds to nothing; the command layer reads it as the undo floor.
        EditOp::Undo { .. } | EditOp::Redo { .. } | EditOp::SealHistory => {}
    }
}

/// Default fan-out/fan-in arity for a `Place`d tee/balancer/merge (sane non-zero).
///
/// **Load-bearing for the port catalog (17-01 key-link):** the number of routing
/// ports on the fan side of a BALANCER/TEE/MERGE entry in
/// [`fabrico_command::command::port_catalog`] MUST equal this value, or a dock would
/// reference a port the minted node never emits on (17-RESEARCH A5). `pub` so the
/// command-layer catalog test can assert that equality.
pub const DEFAULT_ARITY: u16 = 2;
/// Default per-command deadline (ticks) for a `Place`d sink.
const DEFAULT_SINK_DEADLINE: u64 = 600;
/// Minimal passthrough JS for a `Place`d factory: emit the input unchanged on port 0.
const DEFAULT_FACTORY_SOURCE: &str = "export default function (input, ctx) { ctx.emit(0, input); }";

/// Reply-shaped JS for a `Place`d HANDLER (`machine_kind::HANDLER`, 72-06/SERVE-03) -
/// the source [`fold_place`] seeds into the `Node::Factory` a `Place{HANDLER}` mints.
///
/// # Why this is NOT [`DEFAULT_FACTORY_SOURCE`], which is the whole point of the arm
/// `DEFAULT_FACTORY_SOURCE` calls `ctx.emit` and NEVER `ctx.command`. A machine seeded
/// with it answers a webhook with NOTHING: the parked socket resolves only as a 504 on
/// the deadline sweep. Correct electrical ports plus that source is a machine that is
/// CALLED a Handler and cannot reply, which is the overstating-label defect SERVE-03
/// exists to close. The seed is what makes the ports mean something.
///
/// # Why it is MULTI-LINE, which is a walk requirement rather than taste
/// `72-UI-SPEC.md` section 4.1 fixes this exact text and the reason: the walk step that
/// judges this phase is "change the returned body", and the `body:` line has to be
/// findable in under a second in the config card's editor. A one-line handler source
/// fails that walk, so no one-liner is reused here.
///
/// # The JS contract, quoted so no later plan re-invents it
/// `input` is `{method, path, query, headers, body}` as JSON, and
/// `ctx.command({status, headers, body}, deadline)` is the reply. The 37-03 reply seam
/// maps that call to an [`Effect::Reply`](crate::command::Effect::Reply) which
/// [`route_replies`] reverse-transports to the caller on the return cable.
///
/// `pub` so the config panel, the live specs and the tests read ONE string rather than
/// three copies that can drift.
pub const DEFAULT_HANDLER_SOURCE: &str = r#"export default function (input, ctx) {
  ctx.command({
    status: 200,
    headers: { "content-type": "text/plain" },
    body: "hello from fabrico",
  }, 0);
}"#;

/// Fold a `Place{kind,cell_x,cell_y,w,h,ports}` gesture: mint exactly one node of
/// `kind`, then CLAIM its multi-cell footprint into `GridState` (FOOT-01 — the cell
/// and footprint now live in the deterministic core, not the host layout) by applying
/// the FROZEN `w,h,ports` VERBATIM via [`claim_footprint`](crate::state::GridState::claim_footprint)
/// (no catalog lookup — replay is catalog-independent, decision Q2), and record its
/// minted [`NodeId`] into `last_tick.placed`. A 1×1 with no ports claims exactly its
/// single cell and writes NO footprints/ports entry (absent ⇒ 1×1 rot0), byte-faithful
/// to the pre-10-03 `set_cell` path. The record carries no rotation, so rot is always
/// zero here (rotation is 10-06). An unknown `kind` is a panic-free no-op (mints
/// nothing, claims nothing).
///
/// # Which `machine_kind` bytes mint, and which deliberately do not (63-04, 72-06)
/// Every byte from `SOURCE` (0) through `HANDLER` (10) has an arm EXCEPT `BELT` (1) and
/// `WIRE` (8), and those two are exclusions by decision rather than gaps: a belt is
/// minted only by `DrawBelt` (a `Place{BELT}` is a typed reject at validate time,
/// 17-02/CAT-04) and a wire only by `DrawWire`. `ENDPOINT` gained its arm in 63-04 for
/// WIRE-03.
///
/// **Byte 10 is `HANDLER` and it MINTS (72-06, SERVE-03).** This docblock said "bytes
/// above 9 name no machine" until this commit, and that sentence is exactly the shape a
/// later engineer reasons from, so it is corrected rather than left standing. `HANDLER`
/// folds to a [`Node::Factory`](crate::state::Node::Factory), adding NO `Node` variant,
/// seeded with [`DEFAULT_HANDLER_SOURCE`] instead of [`DEFAULT_FACTORY_SOURCE`]. What
/// makes it a Handler rather than a Factory is the PORT LIST the record carries (an
/// electrical In at index 0, read by `admit::inbox_class`, D-16) plus that reply-shaped
/// seed. Bytes ABOVE `HANDLER` name no machine and fall through with the unknown kinds.
///
/// (The wrapped hyphen that used to open the second line of this paragraph read to
/// clippy's `doc_lazy_continuation` lint as a markdown list item and made
/// `cargo clippy --all-targets -- -D warnings` fail. It was a stand-in for an em dash,
/// which this project forbids; the sentence is recast instead. 72-07.)
///
/// `rot` (EDIT 13, plan 86-02) is the rotation the rot-0 box is claimed at. Every forward
/// placement carries 0; the inverse of a `Delete` carries the rotation its capture
/// recorded, so a turned machine comes back turned in this one claim. A `rot` above 3
/// names no orientation: the fold mints NOTHING for it, before any id or random draw is
/// taken, the same no-op shape as an unknown kind. The decode boundaries refuse such a
/// record first; this is the second line for one that reaches the fold anyway.
#[allow(clippy::too_many_arguments)]
fn fold_place(
    core: &mut Core,
    kind: u8,
    cell_x: i32,
    cell_y: i32,
    w: u16,
    h: u16,
    ports: &[Port],
    rot: u8,
) {
    if rot > 3 {
        return;
    }
    let id = match kind {
        machine_kind::SOURCE => core.state.add_source(),
        machine_kind::FACTORY => {
            // The factory sub-seed is drawn from the global sim RNG — deterministic
            // and replayable (the same log reproduces the same draw order). No
            // genesis-seed field exists on Core; the advanced RNG is the sanctioned
            // nondeterminism source the fold may consume.
            let seed = core.rng.next_u64();
            core.state.add_factory(
                DEFAULT_FACTORY_SOURCE.to_owned(),
                crate::factory::DEFAULT_GAS_BUDGET,
                seed,
            )
        }
        machine_kind::TEE => core.state.add_tee(DEFAULT_ARITY),
        machine_kind::BALANCER => core.state.add_balancer(DEFAULT_ARITY),
        machine_kind::ROUTER => core.state.add_router(Vec::new(), Some(0)),
        machine_kind::MERGE => core.state.add_merge(DEFAULT_ARITY),
        machine_kind::SINK => core.state.add_sink(SinkTemplate::Debug, DEFAULT_SINK_DEADLINE),
        // 63-04 (WIRE-03): an ENDPOINT is mintable BY THE FOLD. Until Phase 63 kind 9
        // fell through to the `_ => return` below and minted nothing, so the only way
        // to get one was a direct Rust `add_endpoint` call. Phase 66 places an HTTP
        // Endpoint from the palette and requires byte-identical save/load/replay, which
        // needs the fold to mint it — and `fabrico-core` closes at the end of Phase 63,
        // so the arm is this-phase-or-never.
        //
        // 63-CONTEXT's deferred list said `Node::Endpoint` and `add_endpoint` already
        // existed and needed no serialized change. That was TRUE about the SHAPE and
        // FALSE about the FOLD ARM: the arm itself had to be written, and the sentence
        // read like it did not.
        //
        // 72-07 (SERVE-08) MAKES THE OTHER HALF FALSE TOO, and it is corrected here
        // rather than left as prose a later engineer reasons from. The endpoint payload
        // is no longer field-less: it carries a `path`, so this arm DOES move stored
        // bytes for every board holding a Route. The path is minted inside
        // `add_endpoint` (R-44; `/route-N` since phase 91, D-13), NOT here, and that
        // placement is load-bearing twice over: no caller anywhere can mint a pathless
        // Route, and a fold-minted endpoint stays byte-identical to a seeded one, which
        // is the 63-04 property `a_fold_minted_endpoint_is_identical_to_an_add_endpoint_one`
        // pins. Seeding it in this arm would break that identity silently.
        machine_kind::ENDPOINT => core.state.add_endpoint(),
        // 72-06 (SERVE-03): a HANDLER is user code a webhook reaches over a wire. It
        // mints through the SAME `add_factory` seam the FACTORY arm above uses, from
        // ONE record and ONE action id: no `AddPort`, no `RemovePort`, no strip-and-
        // reseed, and no new `Node` variant (D-11). The port-removal path phase 73 owns
        // is never touched by placing one.
        //
        // TWO THINGS, AND ONLY TWO, SEPARATE THIS FROM THE FACTORY ARM.
        //  1. The SEED is `DEFAULT_HANDLER_SOURCE`, which calls `ctx.command`.
        //     `DEFAULT_FACTORY_SOURCE` calls only `ctx.emit`, so a Handler seeded with
        //     it would answer a webhook with nothing at all and the caller's socket
        //     would resolve as a 504 on the deadline sweep. Correct ports alone do not
        //     make a machine that replies.
        //  2. The PORT LIST arrives on the record (electrical In at index 0), and it is
        //     applied verbatim below like every other kind's. `admit::inbox_class` reads
        //     that declared medium and it is the entire discriminator between a
        //     mechanical Factory and an electrical Handler (D-16, plan 72-03).
        //
        // The RNG draw mirrors the FACTORY arm exactly and for the same reason: the
        // factory sub-seed comes from the global sim RNG, so it is deterministic and
        // replayable. Drawing it here keeps a Handler's draw in the same fold order a
        // Factory's would have taken, so the two are interchangeable at replay.
        machine_kind::HANDLER => {
            let seed = core.rng.next_u64();
            core.state.add_factory(
                DEFAULT_HANDLER_SOURCE.to_owned(),
                crate::factory::DEFAULT_GAS_BUDGET,
                seed,
            )
        }
        // Phase 76 (SHAPE-10): a LABEL is a note on the board. It mints through the ONE
        // seam `add_label` (empty text, Sand, an inbox) and it DRAWS NO RANDOM NUMBER.
        // That is the whole of D-03 at this line, and it is why this arm must never copy
        // the FACTORY and HANDLER arms above: a `core.rng.next_u64()` here would advance
        // the global sim RNG for every label placed, which shifts the sub-seed of every
        // Factory placed after it. `label_inert.rs` and `label.rs` both compare the RNG
        // before and after a label Place to keep it that way.
        machine_kind::LABEL => core.state.add_label(),
        // Unknown kind: no-op, panic-free (host-validated upstream; this is the
        // second line of defense, threat T-07-FOLD-PANIC).
        //
        // Exactly three `machine_kind` bytes reach this arm, all deliberately: BELT (1)
        // and WIRE (8), which are unfoldable via Place by decision (belts come only from
        // `DrawBelt`, 17-02/CAT-04; wires only from `DrawWire`), and every byte above
        // LABEL (11), which names no machine at all. That last clause read "above
        // ENDPOINT (9)" until 72-06 gave byte 10 the arm above, and "above HANDLER (10)"
        // until phase 76 gave byte 11 the LABEL arm.
        _ => return,
    };
    // FOOT-01: claim the Place's full footprint into the core (10-03). The frozen
    // w,h,ports are applied verbatim (no catalog), at the record's rot (EDIT 13, plan
    // 86-02): 0 for every forward placement, the captured turn for a Delete undo. A
    // 1×1/port-less rot-0 Place stays byte-faithful (no footprints/ports entry). Belts
    // are never minted here: a Place of `kind == BELT` is a typed reject at validate
    // time (17-02, CAT-04); belts come only from `DrawBelt`.
    core.state.claim_footprint(id, (cell_x, cell_y), w, h, rot);
    // Write ports ONLY when non-empty (an empty list ⇒ no `ports` map entry, keeping
    // the port-less corpus byte-faithful).
    if !ports.is_empty() {
        core.state.set_ports(id, ports.to_vec());
    }
    core.last_tick.placed.push(id);
}

/// Fold a `Configure{node, config, code_hash}` edit (CFG-02, Phase 39): apply the
/// authored machine configuration to the node's EXISTING serialized fields VERBATIM.
/// The `code_hash` is NOT read here — it is an opaque, host-computed blake3 the record
/// stores/round-trips only (never interpreted by the core). This fold mutates NO new
/// serialized shape (no version bump): it writes only [`Factory.source`](crate::state::Factory)
/// / [`Sink.template`](crate::state::Sink) / [`Belt.ticks_per_slot`](crate::state::Belt)
/// / [`Router.routes`](crate::state::Router) + `Router.default`
/// / [`Endpoint.path`](crate::state::Endpoint) / a label's text, colour and `footprints`
/// entry, all already in the snapshot.
///
/// Per config variant:
/// - [`MachineConfig::Factory`]: set the node's `Factory.source` to the NEW bytes
///   (EXACT — no reformat) AND [`evict`](crate::factory::FactoryRuntimeCache::evict)
///   its `NodeId`-keyed compiled engine, so the NEXT factory step rebuilds from the
///   new source. WITHOUT the eviction the cache (keyed only on `NodeId`) would keep
///   running the STALE engine — the critical CFG-02 behavior/determinism landmine
///   (threat T-39-STALE-JS). Golden 0027 proves the new handler ran after the swap.
/// - [`MachineConfig::Sink`]: set the node's `Sink.template` to the new target.
/// - [`MachineConfig::Source`]: a CORE no-op — the trigger is host-side (Phase-39
///   hard constraint), so a Source config changes ZERO GridState bytes.
/// - [`MachineConfig::Belt`] (63-04, BELT-02): set the node's
///   [`Belt::ticks_per_slot`](crate::state::Belt::ticks_per_slot) — one field, nothing
///   else about the belt moves.
/// - [`MachineConfig::Endpoint`] (72-07, SERVE-08): set the node's
///   [`Endpoint::path`](crate::state::Endpoint::path) - one field, nothing else about
///   the Route moves. It does NOT republish the host route table, because the core has
///   no route table; the host hooks its own republish off this fold (R-45), and without
///   that hook a user types a path, presses Apply, and gets a 404 until they place
///   something.
/// - [`MachineConfig::Label`] (76-02, SHAPE-10, D-04): set the label's
///   [`text`](crate::state::Label::text) and [`colour`](crate::state::Label::colour), then
///   re-box it to `w` by `h` at its unchanged anchor, rot 0, no ports, with both clamped
///   to `1..=MAX_FOOTPRINT_DIM` (the size lands in the existing `footprints` map, never in
///   a new field). One record carries all three, so one Apply is one undo step.
/// - [`MachineConfig::Router`] (63-04, ROUTE-03): set the node's `routes` and `default`
///   FIELD BY FIELD, never through a fresh `Router`. The third field, `faults`, is a
///   snapshot-captured debug counter and a struct-literal overwrite would zero it —
///   changing an existing board's bytes on every reconfiguration for a reason nobody
///   chose (threat T-63-23). Reconfiguring a router preserves its exact fault count.
///
/// # Panic-free on a forged/wrong-kind record (threat T-39-FOLD-PANIC)
/// A `node` that is absent, or whose live kind does not match the config variant, is a
/// silent no-op (early return) that mutates nothing — mirroring [`fold_place`]'s
/// unknown-kind `_ => return` discipline. Applied VERBATIM: legality is decided at
/// command validate time (plan 39-02); this fold never re-validates. Free of float,
/// `std::HashMap` iteration, and RNG (determinism).
fn fold_configure(core: &mut Core, node: NodeId, config: &MachineConfig) {
    match config {
        // Factory JS swap: write the exact bytes, then evict the stale compiled engine.
        MachineConfig::Factory { source } => {
            match core.state.node_mut(node) {
                Some(Node::Factory(factory)) => factory.source.clone_from(source),
                // Absent / wrong-kind node: panic-free no-op (do NOT evict a non-factory).
                _ => return,
            }
            core.factory_runtimes.evict(node);
        }
        // Sink target swap: write the new effect template verbatim.
        MachineConfig::Sink { target } => {
            if let Some(Node::Sink(sink)) = core.state.node_mut(node) {
                sink.template = target.clone();
            }
        }
        // Source trigger is host-side (Phase-39): a core no-op, ZERO GridState bytes.
        MachineConfig::Source { .. } => {}
        // Belt interval swap (BELT-02, 63-04): one field, the `Sink` arm's exact shape.
        // An absent or wrong-kind node falls through and writes nothing.
        MachineConfig::Belt { ticks_per_slot } => {
            if let Some(Node::Belt(belt)) = core.state.node_mut(node) {
                belt.ticks_per_slot = *ticks_per_slot;
            }
        }
        // Router table swap (ROUTE-03, 63-04). The two fields are written INDIVIDUALLY
        // and a fresh `Router` is deliberately NOT constructed here (threat T-63-23).
        // `Router` has THREE fields — `routes`, `default` and `faults` — and this config
        // variant carries two, so a `*router = Router::new(..)` or a struct-literal
        // overwrite would zero `faults`. That counter is SNAPSHOT-CAPTURED, so zeroing it
        // would change an existing board's serialized bytes on every routing
        // reconfiguration, for a reason nobody chose, and would surface as a
        // determinism-hash difference in a save-and-reload comparison far from its cause.
        // The inverse of a Configure restores configuration, not a debug counter, so the
        // capture in `fabrico-command` deliberately omits `faults` too — both directions
        // leave it alone.
        MachineConfig::Router { routes, default } => {
            if let Some(Node::Router(router)) = core.state.node_mut(node) {
                router.routes.clone_from(routes);
                router.default = *default;
            }
        }
        // Route address swap (SERVE-08, 72-07): one field, the `Sink` arm's exact shape.
        // An absent or wrong-kind node falls through and writes nothing, which is the
        // T-39-FOLD-PANIC discipline every arm here keeps.
        //
        // APPLIED VERBATIM. All four of R-47's rules - the leading slash, the length
        // bound, the unreserved-byte alphabet and the board-wide uniqueness - are
        // decided at COMMAND VALIDATE TIME and none of them is re-asked here. That is
        // decision Q2 and it is why replay is validation-independent: a record that was
        // legal when it was written stays foldable forever, even if a later phase
        // narrows what a user may type.
        MachineConfig::Endpoint { path } => {
            if let Some(Node::Endpoint(endpoint)) = core.state.node_mut(node) {
                endpoint.path.clone_from(path);
            }
        }
        // Label words, colour and box (phase 76, plan 76-02, D-04): ONE record, three
        // writes. Only on a live `Node::Label`; an absent or wrong-kind node falls through
        // and writes nothing (T-39-FOLD-PANIC). The words and the colour are plain-data
        // writes onto the node's existing fields; the box goes through
        // `resize_label_box`, which re-boxes the label through the shipped port-geometry
        // writer with the anchor unchanged, rot 0 and no ports, and CLAMPS width and depth
        // to `1..=MAX_FOOTPRINT_DIM` (threat T-76-05): a forged record is never an
        // occupancy bomb. APPLIED VERBATIM otherwise: the text bound, the 16 by 8 caps and
        // the collision walk are decided at command validate time (decision Q2).
        MachineConfig::Label { text, colour, w, h } => {
            let Some(Node::Label(label)) = core.state.node_mut(node) else {
                return;
            };
            label.text.clone_from(text);
            label.colour = *colour;
            core.state.resize_label_box(node, *w, *h);
        }
    }
}

/// Fold an `AddPort{node, port, index, seat}` edit (PORT-07, Phase 36): insert `port`
/// into the machine's rot-0 port list at `index` and write the geometry
/// [`add_port_geometry`](crate::state::add_port_geometry) computes, the SAME function the
/// command layer's `AddPort` validate arm collision-checks. Applied VERBATIM, the atomic
/// bounds and collision refusal lives at command validate time; this fold is INFALLIBLE
/// (mirrors [`fold_place`]'s no-`Err` discipline).
///
/// # Panic-free / design-time only (threats T-36-01/04)
/// Only a PLACED machine (one with a cell) is port-editable: an absent node, or a
/// cell-less `Wire`-minted belt, is a panic-free no-op that writes NO map entry (mirror
/// [`fold_place`]'s unknown-kind no-op). This fold runs ONLY on edit-log application —
/// NO tick/runtime path calls it, upholding the "never grows a port mid-run" invariant.
///
/// # The rule: no existing port moves (plan 74.1-16, CORNER-06)
/// It was ruled on 2026-10-04 that existing ports are not auto-arranged and new ports are
/// placed automatically. So the new port takes the FIRST FREE slot of its role in the centre-out `role_slot` order
/// from the catalog box ([`PortSeat::Auto`](crate::edit::PortSeat::Auto), every forward
/// gesture), or its OWN captured slot ([`PortSeat::Captured`](crate::edit::PortSeat::Captured),
/// the inverse of a removal), and no other port leaves its slot. On an unedited catalog
/// machine the first free slot is where plan 74.1-14 put the next port; after a removal it
/// is the freed slot.
///
/// # A turned machine grows on its far edges (review WR-01)
/// When no free slot lies inside the box, the box grows on its rot-0 east edge (width)
/// or south edge (height), wherever the turn has put that edge in world space, by
/// shifting the anchor by the growth `(dw, dh)`: rot 0 `(0, 0)`, rot 1 `(-dh, 0)`, rot 2
/// `(-dw, -dh)`, rot 3 `(0, -dw)`. Until 74.1-16 the box grew with its anchor fixed, and
/// because `port_world` maps local `y` to world `x` as `h - 1 - y` at rot 1 (and to world
/// `y` the same way at rot 2), a fourth output on a Factory turned 90 or 180 degrees
/// moved its input and every output one cell and released their belts. Now no In ever
/// moves, an Out moves only when the box widens, and a Fault only when it grows taller.
///
/// # Identity, then facing, and why the facing verdict now releases nothing
/// The insert re-keys every dock by identity, then keeps a BELT dock only while its port
/// still faces the belt end (74.1-12, unchanged here). On a command-built board that
/// verdict now never releases anything: the only ports an add moves are an Out on a
/// widening and a Fault on a growth taller, and a docked belt's end tile sits on exactly
/// the cell such a move would claim, so the validate arm refuses that add as a collision
/// before any record exists (`reseat_release.rs`' sweep proves an accepted add releases
/// nothing). The verdict stays as the defence against a forged or hand-edited log.
///
/// # Why the records carry a seat and a restore
/// A removal no longer re-seats, so a slot is no longer a function of list position: the
/// inverse of a removal must NAME the slot it puts the port back on (`seat: Captured`
/// with the captured port), and the inverse of a growing add must NAME the box and anchor
/// it shrinks back to (`RemovePort.restore`). Both are fields on live variants, which
/// together with the fold change is why `EDIT_SCHEMA_VERSION` is 11.
fn fold_add_port(
    core: &mut Core,
    node: NodeId,
    port: &Port,
    index: crate::ids::PortId,
    seat: crate::edit::PortSeat,
) {
    // Plan 86-07 (D-08, WORK-09): a label never takes a port. Validation refuses the
    // gesture (`LabelDoesNotConnect`), so only a forged or hand-edited log reaches here;
    // the fold changes nothing and records the label, and the load path refuses the file.
    // Before this a forged record gave the label the port and grew its box with no
    // collision check.
    if refuse_label_connect(core, node) {
        return;
    }
    // Recover the per-kind catalog box from the live node (absent node ⇒ no-op). It
    // decides the centre-out slot order only; the box itself never goes below the
    // machine's CURRENT box.
    let Some(base) = core.state.node(node).map(crate::state::base_footprint) else {
        return;
    };
    // Only a placed machine (with a cell) is port-editable — no map entry for a
    // cell-less node (a Wire-minted belt or a dangling id), threat T-36-04.
    let Some(anchor_before) = core.state.cell_of(node) else {
        return;
    };
    // The LIVE footprint, rotation included (an absent entry is 1x1 rot 0).
    let fp_before = core
        .state
        .footprint_of(node)
        .unwrap_or(crate::state::Footprint { w: 1, h: 1, rot: 0 });
    // Insert at the RECORD'S index (absent ⇒ a fresh single-port list).
    let ports = core.state.ports_of(node).map(<[Port]>::to_vec).unwrap_or_default();
    // 73-03: INSERT AT `index`, NOT `push`. A forward `AddPort` resolves
    // `index = ports.len()` at validate time, so this is byte-identical to the push it
    // replaces for every forward gesture and for every record in the frozen corpus; what
    // it newly makes expressible is the inverse of a `RemovePort`, which now names the
    // slot the port came out of instead of re-appending it last.
    //
    // AN INDEX PAST THE END IS CLAMPED TO THE APPEND POSITION, NOT DROPPED, and that is a
    // MEASURED decision rather than a defensive reflex. It was first written as a no-op,
    // mirroring `fold_remove_port`'s `idx >= ports.len()` guard below, and the live suite
    // caught what that costs within one run: three specs went red on the Router preset,
    // which is the most ordinary gesture in the app.
    //
    // THE MECHANISM, because it is not obvious and the next reader will hit it too. The
    // HOST batches a whole gesture burst into ONE tick and folds them EDITS-FIRST, AFTER
    // the drain loop. Placing a Router preset emits five `RemovePort`s and then five
    // `AddPort`s in that one burst (`frontend/src/input/gestures.ts`, `seedRouterPreset`),
    // and `validate_normalize` resolves each `index` against `core.state`, which has NONE
    // of the burst folded yet. So all five `AddPort`s carry the SAME stale append
    // position, computed against a port list the `RemovePort`s are about to empty. Every
    // one of them is then past the end at fold time. Dropping them left the machine with
    // no ports at all.
    //
    // The honest reading of a forward record's `index` is therefore "AT OR AFTER the end",
    // which is what "append" means, and clamping is what says so. This is exactly the
    // pre-73-03 behaviour for every out-of-range value - the fold used to `push`
    // unconditionally - so it cannot regress anything, and it keeps the fold a pure
    // function of the record plus the state at fold time, which is all replay needs.
    // The headless `GridSession` re-projects after every apply, so ITS forward indices are
    // exact and land on the `==` case; no frozen fixture takes this branch.
    //
    // T-73-03-01 IS STILL CLOSED, and it is worth being precise about what that threat is:
    // a forged `index` reaching `Vec::insert` is a PANIC, and the clamp removes the panic
    // just as completely as a no-op did. A forged huge index now appends, which is bounded,
    // allocation-free beyond the one port, and precisely what every build before this plan
    // did with every index it was given.
    let idx = (index as usize).min(ports.len());
    // 73-06: THE MIRROR OF `fold_remove_port`'S RE-POINT, and it is what makes a port
    // add/remove EXACTLY reversible rather than merely reversible in the port list.
    //
    // Without it, one Ctrl+Z after a `RemovePort` puts the port back and leaves the
    // routing table and every surviving dock still carrying the DECREMENTED keys the
    // removal gave them - so a rule and a belt that were aimed at the third output come
    // back aimed at the second. That is the identical defect `fold_remove_port` closes,
    // reintroduced on the undo path, and it is not fixable in the command layer without
    // inventing a second logged record: the shift is a DERIVED consequence of the port
    // list moving, so the fold that moves the list is the one that owes it.
    //
    // The rule is the removal's, inverted: inserting an Out at routing key `k` pushes
    // every key at or above `k` UP by one. Derived from the PRE-insert list, since
    // `ports[..idx]` is the same slice before and after the insert.
    let inserted_out_key: Option<crate::ids::PortId> =
        (port.role == crate::state::Role::Out).then(|| {
            ports[..idx]
                .iter()
                .filter(|p| p.role == crate::state::Role::Out)
                .count()
                .try_into()
                .unwrap_or(crate::ids::PortId::MAX)
        });
    // 74.1-16: the port at its seat, inserted at `idx`, every other port on its own slot,
    // the box grown on its far edges with the anchor shifted by the turn's table. ONE
    // function computes it here and in the command layer's validate arm.
    let geometry = crate::state::add_port_geometry(
        base,
        anchor_before,
        fp_before,
        &ports,
        crate::ids::PortId::try_from(idx).unwrap_or(crate::ids::PortId::MAX),
        *port,
        seat,
    );
    core.state.write_port_geometry(node, &geometry);

    // The table. Saturating: a key already at PortId::MAX stays there rather than
    // wrapping onto key 0, which would silently re-aim a rule at the FIRST output.
    if let Some(k) = inserted_out_key
        && let Some(crate::state::Node::Router(r)) = core.state.node_mut(node)
    {
        for (_, target) in &mut r.routes {
            if *target >= k {
                *target = target.saturating_add(1);
            }
        }
        if let Some(p) = r.default
            && p >= k
        {
            r.default = Some(p.saturating_add(1));
        }
    }

    // The docks, through the SAME shared machinery: IDENTITY, THEN FACING (74.1-12).
    //
    // Identity first: every key at or above the inserted slot shifts up by one, in its
    // own keyspace, so a dock keeps naming the port it named. An insert removes no port,
    // so identity alone releases nothing.
    //
    // Then facing, for a BELT dock only: a dock is kept while its port still faces the
    // belt's end tile and RELEASED otherwise, with its PRE-edit key, exactly as
    // `fold_remove_port` releases one: a kept link must touch its port, or the user sees
    // a belt drawn onto nothing. Since 74.1-16 an add moves only an Out on a widening and
    // a Fault on a growth taller, onto the cell a docked belt's end tile would hold, which
    // the validate arm refuses as a collision; so on a command-built board this verdict
    // releases nothing, and it stays as the forged-log defence. It is still a writer of
    // `last_tick.unlinked` (beside `fold_rotate` and `fold_remove_port`), and the command
    // layer's `AddPort` inverse still re-docks whatever it records. A wire endpoint keeps
    // the identity verdict: a wire routes, it has no doorstep to leave.
    let idx_key = u16::try_from(idx).unwrap_or(u16::MAX);
    let anchor = core.state.cell_of(node).unwrap_or_default();
    let fp = core
        .state
        .footprint_of(node)
        .unwrap_or(crate::state::Footprint { w: 1, h: 1, rot: 0 });
    let judged = core.state.judge_docks(node, |state, port, other, end| {
        let rekeyed = if port == crate::fault::FAULT_PORT {
            Some(port)
        } else {
            // The RAW CATALOG rule, shared by a Head dock and BOTH wire endpoints because
            // all three key on the catalog index and shift for EVERY insert whatever the
            // inserted port's role. Written once and named, so the next endpoint kind
            // joins the right group by declaration rather than by a reader noticing.
            let catalog_shift = if port >= idx_key {
                Some(port.saturating_add(1))
            } else {
                Some(port)
            };
            match end {
                // A Tail (offload) key is an OUT ROUTING key, a different keyspace.
                crate::state::DockEnd::Belt(crate::edit::BeltEnd::Tail) => match inserted_out_key {
                    Some(k) if port >= k => Some(port.saturating_add(1)),
                    _ => Some(port),
                },
                crate::state::DockEnd::Belt(crate::edit::BeltEnd::Head)
                | crate::state::DockEnd::WireFrom
                | crate::state::DockEnd::WireTo => catalog_shift,
            }
        };
        match end {
            crate::state::DockEnd::Belt(endpoint) => rekeyed.filter(|&k| {
                state.dock_still_reaches(node, anchor, fp.w, fp.h, fp.rot, k, other, endpoint)
            }),
            crate::state::DockEnd::WireFrom | crate::state::DockEnd::WireTo => rekeyed,
        }
    });
    core.last_tick.unlinked.extend_from_slice(&judged.unlinked);
    debug_assert!(
        judged.released_wires.is_empty(),
        "an AddPort strands no wire: an insert removes no port and a wire keeps the \
         identity verdict, so no wire candidate is ever answered None"
    );
}

/// Fold a `RemovePort{node, index, restore}` edit (PORT-07, Phase 36): remove the port
/// at `index` from the machine's rot-0 port list and write the geometry
/// [`remove_port_geometry`](crate::state::remove_port_geometry) computes. Applied
/// VERBATIM (no re-validation), INFALLIBLE like [`fold_add_port`].
///
/// # Nothing else moves (design ruling of 2026-10-04)
/// Removing an output shifts no other output, existing ports are not auto-arranged, and
/// deleting an output does not shuffle positions. With `restore: None`, which every
/// forward removal carries, every surviving port keeps its slot and the footprint and
/// the anchor stay exactly as they were: a removal NEVER shrinks the machine (a
/// stated design assumption), so it never moves
/// the Fault row or the Out column either. Only the removed port's own docks are
/// released. On the walk board (a Factory with two outputs and a belt on each, the first
/// output removed) exactly ONE belt lets go, which is UNDO-06's original "exactly one
/// strand, not two", restored. `restore: Some` is written only by the inverse of an
/// `AddPort` that grew the box, and puts back the pre-add box and anchor.
///
/// # Panic-free forged-index guard (threats T-36-01/02/04)
/// An absent/cell-less node, a port-less node, OR an out-of-range `index` is a panic-
/// free no-op — the bounds check REPLACES a `Vec` index panic (the forged-index DoS
/// guard). Design-time only: no tick/runtime path calls this.
///
/// # It RE-POINTS the routing table and RE-KEYS the docks (73-06, UNDO-04 / UNDO-05)
/// Until phase 73 this fold was nine statements and none of them mentioned `routes`,
/// `default` or `links`. So a routing rule aimed at the third output silently started
/// feeding the second, a belt docked to the removed output kept a link naming a key that
/// no longer existed, and a belt on a SURVIVING output started draining a different one.
/// Three consequences now follow the removal, all derived from the PRE-removal port list
/// because after `ports.remove(idx)` the information needed to derive them is gone:
///
/// 1. **The table.** Removing the Out whose routing key is `k` DROPS every rule naming
///    `k` and decrements every rule above it. `default == Some(k)` becomes `None`, which
///    is the EXISTING no-match semantics rather than an invented one: a default pointing
///    at an output that no longer exists honestly means there is no default, and clamping
///    onto a surviving key would silently start feeding an output the user never chose,
///    which is the very defect this fold now closes, one level up (73-06 ruling R-25).
/// 2. **The Out-side (Tail) docks.** The dock ON `k` is released; every dock above `k`
///    decrements, so it keeps naming the port it named (IDENTITY).
/// 3. **The In-side (Head) docks.** A Head link key is the RAW CATALOG INDEX, and
///    `ports.remove(idx)` shifts every catalog index above `idx` down one, so a belt
///    docked to a LATER In is re-keyed. No requirement names this half; it is reachable
///    today on any machine with two Ins.
///
/// # Identity, THEN facing (74.1-12, CORNER-06), and the 74.1-12 release reversed
/// A belt dock that survives the identity re-key is then judged by the facing rule a
/// `Rotate` asks ([`dock_still_reaches`](crate::state::GridState), at the machine's
/// anchor, footprint and rotation after the edit): kept while the re-keyed port's facing
/// cell is the belt's end tile and the carrier does not run back into the port, RELEASED
/// otherwise, with one `UnlinkedDock` carrying its PRE-edit key (the keyspace the inverse
/// `AddPort` restores). Wire endpoints keep the identity verdict: a wire routes, it has
/// no doorstep.
///
/// THIS REVERSES PLAN 74.1-12'S RE-SEAT RELEASE, BY DESIGN RULING. From 74.1-12 to
/// 74.1-16 this fold re-seated every survivor by list position (centre-out from the
/// catalog box since 74.1-14), so removing `Out_0` moved every later Out into the
/// previous slot and the facing verdict released each of their belts: removing the first
/// of two outputs let go of both. That was caught in manual testing and ruled out. Since
/// no survivor moves now, the facing verdict keeps every re-keyed survivor on a
/// command-built board; it stays as the forged-log defence (a forged `restore` box can
/// still move one). `REQUIREMENTS.md` UNDO-05 and UNDO-06 take the matching text in plan
/// 74.1-17.
///
/// # The belt NODE survives, and this needs no new logged op
/// Exactly as [`fold_rotate`]'s de-dock does: only the LINK is dropped, never the belt
/// (A* is a locked anti-feature). The release and the re-point are deterministic DERIVED
/// consequences of the `RemovePort` record - recomputable from the frozen port list on
/// every replay - so they add no logged op (A3). The record itself gained one field in
/// 74.1-16, `restore`, which only an `AddPort` inverse fills.
/// The released docks are surfaced on `last_tick.unlinked`, which is ephemeral telemetry
/// and never snapshotted, so this write moves no fixture's per-tick state hash.
fn fold_remove_port(
    core: &mut Core,
    node: NodeId,
    index: crate::ids::PortId,
    restore: Option<crate::edit::BoxRestore>,
) {
    if core.state.node(node).is_none() {
        return;
    }
    let Some(anchor_before) = core.state.cell_of(node) else {
        return;
    };
    // Port-less node ⇒ nothing to remove (no-op).
    let Some(ports) = core.state.ports_of(node).map(<[Port]>::to_vec) else {
        return;
    };
    // Forged / out-of-range index ⇒ panic-free no-op (NO Vec OOB panic). EVERY line
    // below this guard is new work as of 73-06, so a forged index still reaches none of
    // it (threat T-73-06-01).
    let idx = index as usize;
    if idx >= ports.len() {
        return;
    }
    // Derived from the PRE-removal list, because `ports.remove(idx)` destroys the
    // information both of them need.
    //
    // `removed_out_key` is the removed port's OUT ROUTING KEY: its 0-based position among
    // the node's `Role::Out` ports, which is the keyspace `Router.routes`, `Router.default`
    // and every Tail dock link all share (`command.rs`'s `dock_link_key` is the forward
    // translator and `dock_still_reaches` carries the mirror reverse map). `None` when the
    // removed port is not an Out, in which case no routing key moves at all.
    let removed_role = ports[idx].role;
    let removed_out_key: Option<crate::ids::PortId> = (removed_role == crate::state::Role::Out).then(|| {
        ports[..idx]
            .iter()
            .filter(|p| p.role == crate::state::Role::Out)
            .count()
            .try_into()
            .unwrap_or(crate::ids::PortId::MAX)
    });
    // The routed `FAULT_PORT` sentinel names the node's FIRST Fault (`resolve_link_port`),
    // so a dock on it is the removed port's own dock only when the removed port IS that
    // first Fault. Until 74.1-16 this read "the removed port is any Fault", which on a
    // machine with two Faults released the first Fault's belt when the SECOND was removed:
    // a dock on a port that did not move and was not removed. Since 74.1-16 a removal
    // releases exactly the removed port's own docks, and this is that rule for the
    // sentinel keyspace.
    let removed_is_fault = removed_role == crate::state::Role::Fault
        && ports.iter().position(|p| p.role == crate::state::Role::Fault) == Some(idx);

    // 74.1-16: the list without the port, every survivor on its own slot, the box and
    // anchor unchanged, or (an `AddPort` inverse only) the captured pre-add box and anchor.
    let fp_before = core
        .state
        .footprint_of(node)
        .unwrap_or(crate::state::Footprint { w: 1, h: 1, rot: 0 });
    let geometry =
        crate::state::remove_port_geometry(anchor_before, fp_before, &ports, index, restore);
    core.state.write_port_geometry(node, &geometry);

    // 1. UNDO-04: re-point the routing table (R-25). Saturating arithmetic over the
    //    EXISTING Vec - drop, decrement, or leave - and never an index INTO `ports` by a
    //    rule's target, which is what `validate_normalize`'s docblock warns about in
    //    capitals (threat T-73-06-02).
    if let Some(k) = removed_out_key
        && let Some(crate::state::Node::Router(r)) = core.state.node_mut(node)
    {
        r.routes.retain(|(_, port)| *port != k);
        for (_, port) in &mut r.routes {
            if *port > k {
                *port -= 1;
            }
        }
        r.default = match r.default {
            Some(p) if p == k => None,
            Some(p) if p > k => Some(p - 1),
            other => other,
        };
    }

    // 2/3. UNDO-05: IDENTITY, THEN FACING, through the one shared machinery (R-26/R-27).
    //      `judge_docks` owns the candidate collect, the unlink and the record; what this
    //      fold supplies is the keep-or-re-key-or-release rule. The identity re-key is
    //      unchanged since 73-06; since 74.1-12 a belt dock it keeps is then asked
    //      `dock_still_reaches` at the geometry written above (this fn's docblock says
    //      why it releases no survivor on a command-built board since 74.1-16).
    let anchor = core.state.cell_of(node).unwrap_or_default();
    let fp = core
        .state
        .footprint_of(node)
        .unwrap_or(crate::state::Footprint { w: 1, h: 1, rot: 0 });
    let judged = core.state.judge_docks(node, |state, port, other, end| {
        let rekeyed = if port == crate::fault::FAULT_PORT {
            // The routed fault sentinel is its own keyspace and shifts with nothing: it
            // is released iff the removed port WAS the node's first Fault, the one it names.
            (!removed_is_fault).then_some(port)
        } else {
            // The RAW CATALOG rule, shared by a Head dock and BOTH wire endpoints: every
            // catalog index above the removed one shifts down, and the one ON it is
            // released. 73-12 gave the two wire arms this rule rather than a second one,
            // which is what 73-REVIEW CR-02's preferred fix asks for and what keeps the
            // seam single.
            let catalog_shift = match port.cmp(&index) {
                std::cmp::Ordering::Equal => None,
                std::cmp::Ordering::Greater => Some(port - 1),
                std::cmp::Ordering::Less => Some(port),
            };
            match end {
                // A Tail (offload) key is an OUT ROUTING key, a different keyspace.
                crate::state::DockEnd::Belt(crate::edit::BeltEnd::Tail) => match removed_out_key {
                    None => Some(port),
                    Some(k) if port == k => None,
                    Some(k) if port > k => Some(port - 1),
                    Some(_) => Some(port),
                },
                crate::state::DockEnd::Belt(crate::edit::BeltEnd::Head)
                | crate::state::DockEnd::WireFrom
                | crate::state::DockEnd::WireTo => catalog_shift,
            }
        };
        match end {
            // A belt survivor must still TOUCH its re-keyed port, or it is released with
            // its pre-edit key (which `judge_docks` records for a `None` verdict).
            crate::state::DockEnd::Belt(endpoint) => rekeyed.filter(|&k| {
                state.dock_still_reaches(node, anchor, fp.w, fp.h, fp.rot, k, other, endpoint)
            }),
            // A wire keeps the identity verdict: it routes, it has no doorstep.
            crate::state::DockEnd::WireFrom | crate::state::DockEnd::WireTo => rekeyed,
        }
    });
    core.last_tick.unlinked.extend_from_slice(&judged.unlinked);
    // 73-12: THE RELEASED CABLES. A wire has no representable disconnected state, so a
    // wire endpoint that named the removed port takes the wire with it - the same thing a
    // Delete of the machine already does (`remove_node`'s wire cascade). `remove_node`
    // returns the FULL removed set (the wire, plus anything its own cascade tears down)
    // and every id is PAIRED with `sched.remove` (the AR-3 pairing, Pitfall 4) and pushed
    // onto `last_tick.removed`, exactly as `fold_delete` does.
    //
    // NO VALIDATED LOG REACHES THIS BRANCH, AND THAT IS DECLARED RATHER THAN LEFT TO BE
    // DISCOVERED. `validate_normalize`'s `RemovePort` arm refuses the command with
    // `CommandError::PortOccupied` when a cable names the port, so a `GridSession` never
    // produces such a record. `Core::advance_edits` and `GridSession::replay` are both
    // `pub` and a forged or hand-edited log reaches them, which is what this branch is
    // for: without it the fold leaves a `Node::Wire` naming a port that no longer exists,
    // and `resolve_wire_dock` degrades to the node origin (WINDOWS 116). It is red-able,
    // and `remove_port_repoint.rs`'s
    // `a_forged_removal_of_the_very_port_a_wire_leaves_from_takes_the_wire_with_it`
    // is the row that reddens it.
    for wire in judged.released_wires {
        for removed in core.state.remove_node(wire) {
            core.sched.remove(removed);
            core.last_tick.removed.push(removed);
        }
    }
}

/// Fold a `Delete{node}` gesture: remove the node + its WHOLE footprint and every
/// link referencing it, AND cascade-detach every Wire-minted belt docked to one of
/// its ports (FOOT-04), in deterministic `(NodeId, PortId)` order. For the primary
/// node AND every cascade-detached belt, `sched.remove` is PAIRED with the
/// `GridState` removal (the AR-3 pairing, Pitfall 4) so neither a stray `in_flight`
/// item nor a dangling `wake_wheel` entry survives — `remove_node` returns the full
/// removed set in order so the pairing covers every id. An in-flight item on a
/// detached belt DROPs via the missing-link no-op (Q3, NOT a fault). Records every
/// removed id into `last_tick.removed` (primary first, then the detached belts). A
/// delete of an absent node is a panic-free no-op (records nothing).
///
/// # The Route-and-Handler PAIRED delete is NOT here, and PHASE 73 OWNS ITS UNDO (72-08)
/// Since 72-08 a `Delete` of either leg of a Route-and-Handler cable removes BOTH legs.
/// That cascade is at the COMMAND layer, in `fabrico_command`'s `validate_normalize`
/// Delete arm, which freezes TWO `EditOp::Delete` records under ONE action id; this fold
/// then applies them exactly as it applies any two deletes, re-checking neither (Q2).
///
/// It is not in this function ON PURPOSE, and the reason is worth having at the site
/// rather than in a plan file. Deciding that two wires are ONE cable requires the R-37
/// naming predicate (`fabrico_command::is_handler_shape`), which plan 72-06 deliberately
/// kept OUT of the deterministic core because it answers a host-side NAMING question that
/// decides nothing here. The core could instead ask the cheaper structural question - "two
/// wires between the same two nodes, running opposite ways" - and that rule is WRONG in a
/// silent way: a user can hand-draw a Route-to-Router wire and a Router-to-Route wire,
/// which is two SINGLE cables, and the cheap rule would cascade one delete into two.
///
/// **PHASE 73 OWNS RESTORING THE PAIR AS ONE UNDO STEP.** D-04's reversibility is recorded
/// as COSTLY for exactly this reason: the two legs are minted and torn down as one action,
/// so an undo that restores only one of them restores the forward-only board D-06 rules
/// unreachable. A phase 73 planner meeting the wire and belt undo defects (UNDO-01 to
/// UNDO-03) inherits this constraint, and splitting the pairing later means re-opening the
/// command-layer cascade it depends on.
fn fold_delete(core: &mut Core, node: NodeId) {
    let removed = core.state.remove_node(node);
    if removed.is_empty() {
        return;
    }
    for &id in &removed {
        core.sched.remove(id);
    }
    core.last_tick.removed.extend_from_slice(&removed);
}

/// Fold a `Rotate{node, new_rot}` edit (FOOT-02, CAT-06 — the SPIKE): apply the
/// resolved record VERBATIM — anchor-preserving pivot, NO collision re-check at fold
/// time (legality was decided by `validate_normalize`, decision Q2). Delegates the
/// GridState-side re-expand + SELECTIVE de-dock to
/// [`GridState::rotate_footprint`](crate::state::GridState) and extends
/// `last_tick.unlinked` with the [`UnlinkedDock`](crate::state::UnlinkedDock)s it
/// returns — the docks whose port no longer FACES its belt end-tile under the new rot.
///
/// # NO `sched.remove`, NO node removal (Pitfall 4 — DIVERGES from `fold_delete`)
/// Unlike the old cascade-destroy (which `remove_node`d every docked belt and paired
/// `sched.remove` with each), a rotate now drops ONLY the stranded LINK — the belt
/// NODE SURVIVES with its AR-3 wake intact, so a de-docked belt keeps advancing its
/// items rather than freezing (T-17-ROT-WAKE). The belt is never re-drawn (A* is a
/// locked anti-feature). A node with no footprint/cell (absent / a `Wire`-minted
/// belt) is a panic-free no-op; a 1×1 rotate is an occupancy no-op but still re-judges
/// its docked belts (a port-bearing 1×1's world-side spins). The de-dock is a
/// deterministic DERIVED consequence of `Rotate` — replay reproduces it byte-for-byte
/// with no extra logged op.
fn fold_rotate(core: &mut Core, node: NodeId, new_rot: u8) {
    let unlinked = core.state.rotate_footprint(node, new_rot);
    core.last_tick.unlinked.extend_from_slice(&unlinked);
}

/// Fold a `DrawBelt{tiles}` edit (BELT-01..06): mint ONE belt of `tiles.len()`
/// tiles (`SLOTS_PER_TILE * tiles.len()` empty slots), set its drawn `geometry` to
/// the RESOLVED tiles, and CLAIM every tile cell into the unified occupancy index
/// ([`claim_belt_tiles`](crate::state::GridState::claim_belt_tiles)). Applied
/// VERBATIM — NO re-routing, NO catalog lookup, NO collision re-check (legality was
/// decided by `validate_normalize`, Q2; mirrors `fold_place`'s claim shape).
/// Records the minted [`NodeId`] into `last_tick.placed`.
fn fold_draw_belt(core: &mut Core, tiles: &[BeltTile]) {
    // The tile count is bounded by the `edit::upcast` decode guard (MAX_BELT_TILES),
    // so the cast is overflow-safe on the replay path; an in-process caller stays
    // far below u32::MAX in practice.
    let belt = core.state.add_belt(tiles.len() as u32);
    if let Some(Node::Belt(b)) = core.state.node_mut(belt) {
        b.geometry = tiles.to_vec();
    }
    core.state.claim_belt_tiles(belt, tiles);
    core.last_tick.placed.push(belt);
}

/// Whether `node` is a live [`Node::Label`](crate::state::Node::Label), recording it in
/// `last_tick.refused_label_connects` when it is (plan 86-07, D-08, WORK-09).
///
/// The one rule the three connect folds (`fold_add_port`, `fold_dock`, `fold_draw_wire`)
/// share: a label is a note and never connects, so a record joining one to anything changes
/// nothing. No record a build writes names a label here (`validate_normalize` refuses the
/// gesture as `LabelDoesNotConnect`), so the no-op moves no golden; it is reached only by a
/// forged log, which `fabrico_command`'s re-fold reads off the observation and the load path
/// refuses in words.
fn refuse_label_connect(core: &mut Core, node: NodeId) -> bool {
    if matches!(core.state.node(node), Some(crate::state::Node::Label(_))) {
        core.last_tick.refused_label_connects.push(node);
        true
    } else {
        false
    }
}

/// Fold a `Dock{belt, endpoint, node, port}` edit (11-06, BELT-05/06): link the
/// belt ENDPOINT (its single port 0 — the belt's head output AND tail input share
/// port 0, exactly as [`fold_wire`] wires it) to the machine `port` in the DIRECTION
/// the `endpoint` implies, applied VERBATIM (NO re-validation — legality was decided
/// by `validate_normalize`, Q2):
/// - [`BeltEnd::Head`](crate::edit::BeltEnd::Head) (LOAD): the belt delivers into the
///   machine — `link((belt, 0) -> (node, port))`.
/// - [`BeltEnd::Tail`](crate::edit::BeltEnd::Tail) (OFFLOAD): the machine feeds the
///   belt — `link((node, port) -> (belt, 0))`.
///
/// If EITHER the belt or the machine node is not live this is a panic-free no-op
/// (mirror [`fold_wire`]'s missing-endpoint guard) — no dangling link survives. A
/// dock adds a LINK, not a node, so nothing is pushed to `last_tick.placed`, and the
/// belt's AR-3 wake (driven by its slot occupancy) is untouched.
fn fold_dock(
    core: &mut Core,
    belt: NodeId,
    endpoint: crate::edit::BeltEnd,
    node: NodeId,
    port: crate::ids::PortId,
) {
    if core.state.node(belt).is_none() || core.state.node(node).is_none() {
        return;
    }
    // Plan 86-07 (D-08, WORK-09): a belt never docks to a label, on any port (its
    // `FAULT_PORT` included). Only a forged log names one here (validation refuses the
    // gesture as `LabelDoesNotConnect`); the fold changes nothing and records the label, and
    // the load path refuses the file. Before this a forged Dock jammed the belt on a link no
    // user could see or remove.
    //
    // BOTH operands (phase 86 review, WR-03): a forged Dock that names the label as its
    // BELT linked the label into the machine, and a later forged Delete of either one
    // removed the link before the snapshot gate could see it, so the file opened. A
    // bitwise `|`, not `||`, so a record naming a label on both sides records both.
    if refuse_label_connect(core, belt) | refuse_label_connect(core, node) {
        return;
    }
    match endpoint {
        crate::edit::BeltEnd::Head => core.state.link((belt, 0), (node, port)),
        crate::edit::BeltEnd::Tail => core.state.link((node, port), (belt, 0)),
    }
}

/// Fold a `DrawWire{from_node, from_port, to_node, to_port}` edit (63-02, WIRE-01):
/// MINT one `Node::Wire` carrying the two logical endpoints, record the ONE forward
/// link out of the wire's own output port, and record the minted id. The union of
/// [`fold_dock`]'s guard and [`fold_draw_belt`]'s mint, and nothing more.
///
/// # The FORWARD shape, not the return shape
/// A forward wire and a bare return wire are NOT symmetric: a FORWARD wire is
/// `add_wire` PLUS `link`, a bare RETURN wire minted with no link is `add_wire` alone.
/// This fold reproduces the FORWARD shape, because a drawn wire is a delivering wire:
/// routing out of a wire's own output port goes through `links[(wire, 0)]` in
/// [`step_node`], so without the `link` the wire would ingest a request and never
/// deliver it. The wire's INPUT
/// side needs no `links` entry — the entry wire is found by a scan
/// ([`GridState::wire_from_node`](crate::state::GridState::wire_from_node)), not by a
/// link key.
///
/// # It MINTS, so it records into `last_tick.placed`
/// Mirrors [`fold_draw_belt`]: the minted [`NodeId`] is pushed into
/// `last_tick.placed`, which is the seam the host harvests a fresh id from and the
/// seam the undo inverse (`EditOp::Delete { node: wire, .. }`) is built on. Unlike
/// `fold_dock`, this fold adds a node, not only a link.
///
/// # A forged record
/// A record naming a node that is not live returns BEFORE anything is written
/// (mirroring [`fold_dock`]'s missing-endpoint guard, threat T-63-02), so no dangling
/// wire survives and zero `GridState` bytes change. There is no partial-mint state:
/// the guard returns before all three writes, or all three run.
///
/// # It never re-validates (decision Q2)
/// Endpoint legality — role, medium, occupancy, self-loop — was decided ONCE at
/// command-validate time by `fabrico_command::validate_normalize`. This fold applies
/// the frozen record VERBATIM. Two behaviours it therefore deliberately does NOT
/// prevent, recorded so a later reader does not read them as oversights:
/// - a SELF-LOOP (`from_node == to_node`) mints. The reject lives at validate time.
/// - a port index naming no declared port mints a wire whose logical port nothing
///   reads. That is panic-free by construction: `links` is a `BTreeMap` and nothing
///   here indexes a slice.
///
/// Float-free, RNG-free, and it iterates no `std::HashMap` — the determinism
/// discipline every fold in this module holds.
///
/// # It also CLEARS the no-cable mark on the node the wire leaves (72-07, SERVE-08)
/// See [`drain_no_entry_wire_faults`] below. This is the ONLY fault clear any fold
/// performs, it is scoped to ONE reason at ONE node, and it is here rather than in the
/// render layer so that a replay reproduces it and `derive_state` stays a pure
/// presentation function.
fn fold_draw_wire(
    core: &mut Core,
    from_node: NodeId,
    from_port: PortId,
    to_node: NodeId,
    to_port: PortId,
) {
    if core.state.node(from_node).is_none() || core.state.node(to_node).is_none() {
        return;
    }
    // Plan 86-07 (D-08, WORK-09): a cable never starts or ends at a label. Both ends are
    // judged (and both recorded when both are labels) BEFORE the mint, so a refused record
    // mints nothing and pushes nothing to `last_tick.placed`.
    let from_label = refuse_label_connect(core, from_node);
    let to_label = refuse_label_connect(core, to_node);
    if from_label || to_label {
        return;
    }
    // Call the minter, never hand-roll the insert: `add_wire` also provisions the
    // `inboxes` entry, and a mint that forgets the inbox produces a wire that drops on
    // ingest and is NOT byte-identical to the genesis one (T-63-16).
    let wire = core.state.add_wire((from_node, from_port), (to_node, to_port));
    core.state.link((wire, 0), (to_node, to_port));
    core.last_tick.placed.push(wire);
    drain_no_entry_wire_faults(core, from_node);
}

/// Drain every resting [`FaultReason::NoEntryWire`](crate::fault::FaultReason) fault
/// from `node`'s reserved [`FAULT_PORT`](crate::fault::FAULT_PORT) inbox bucket
/// (Phase 72, SERVE-08, D-25). ONE reason, at ONE node, and nothing else.
///
/// # Why the clear lives in the FOLD and not in the render layer
/// D-25 gives this one mark a self-clear "once a cable is drawn".
/// `72-CLEAN-DESIGN`'s mechanism cleared it on the next successful ADMIT, which is one
/// POST later; ruling R-14 overrides that, because a user who fixes the board and
/// watches it stay red has been told their fix did not work. Putting the clear here
/// keeps `fabrico_host::render_packet::derive_state` a PURE PRESENTATION FUNCTION that
/// mutates nothing, and it puts the clear where a REPLAY REPRODUCES IT: the same log
/// folded twice clears the same fault at the same tick.
///
/// # Why it is scoped to one reason, and what that costs to get wrong
/// A blanket drain would eat a [`FaultReason::CommandFailure`] or
/// [`FaultReason::CommandTimeout`], and those carry the original faulted bytes as their
/// [`Fault::payload`](crate::fault::Fault) for dead-letter inspection
/// (`fault.rs:129-131`). Draining them would destroy evidence every time somebody drew
/// a cable, while looking like an improvement. `NoEntryWire` carries an EMPTY payload
/// precisely so that clearing it is free of that cost.
///
/// # The GENERAL fault-clear lifecycle STAYS OPEN
/// `render_packet.rs` records that an undrained fault mark "stays red until the board is
/// rebuilt", BY DESIGN, for every fault. That ruling is UNCHANGED by this function for
/// every reason except `NoEntryWire` at the node the wire leaves. Phase 72 does not
/// close the general lifecycle and does not claim to.
///
/// # It never panics on a forged record
/// A node with no inbox, no fault bucket, or bytes that are not a `Fault` at all is a
/// no-op: undecodable bytes are KEPT (`Fault::decode` returns `Err`, the predicate keeps
/// them), because this function's job is to remove one known reason, never to tidy a
/// bucket it cannot read.
fn drain_no_entry_wire_faults(core: &mut Core, node: NodeId) {
    if core.state.node(node).is_none() {
        return;
    }
    core.state.inbox_mut(node).retain_on(FAULT_PORT, |item| {
        // KEEP unless it decodes to exactly this reason. Undecodable bytes are kept: a
        // drain that deleted what it could not read would be a tidier, not a fix.
        !matches!(Fault::decode(item), Ok(f) if f.reason == FaultReason::NoEntryWire)
    });
}

/// Fold an `Unlink{belt, endpoint, node, port}` edit (12-01) — the exact directional
/// INVERSE of [`fold_dock`]: remove the single directed link the matching dock
/// created, recomputing the SAME key from the SAME `endpoint` (applied VERBATIM, NO
/// re-validation — it is a frozen inverse record):
/// - [`BeltEnd::Head`](crate::edit::BeltEnd::Head): `fold_dock` linked
///   `(belt, 0) -> (node, port)`, so unlink removes the key `(belt, 0)`.
/// - [`BeltEnd::Tail`](crate::edit::BeltEnd::Tail): `fold_dock` linked
///   `(node, port) -> (belt, 0)`, so unlink removes the key `(node, port)`.
///
/// Needs NO missing-node guard — [`GridState::unlink`](crate::state::GridState) of
/// an absent key is already a panic-free no-op (strictly safer than `fold_dock`'s
/// guard), so a forged `Unlink` with junk ids never panics and leaves no dangling
/// state. Removes a LINK, not a node, so nothing is pushed to `last_tick`.
fn fold_unlink(
    core: &mut Core,
    belt: NodeId,
    endpoint: crate::edit::BeltEnd,
    node: NodeId,
    port: crate::ids::PortId,
) {
    match endpoint {
        crate::edit::BeltEnd::Head => core.state.unlink((belt, 0)),
        crate::edit::BeltEnd::Tail => core.state.unlink((node, port)),
    }
}

/// THE PILE-02 GATE: can EVERY linked output of `id` accept what one step of `id`
/// could put on it?
///
/// Returns true when at least ONE destination cannot, in which case
/// [`step_node`] does not step the node at all: it does not take the node's inbox, so
/// the node stops consuming and the backlog forms on the belt in front of it instead
/// of disappearing into a queue the user cannot see (PILE-02).
///
/// # ANY blocked, not ALL, and the demo board FORCED that (ruling R-10)
///
/// A Tee has two output ports. Under an ALL-blocked predicate the shipped demo board
/// would never jam at all: `scenes/demo_scene.ron` wires the Tee's short branch out to
/// belt 11 (which runs on to the Router, Balancer, Merge and terminal Sink) and its long
/// branch out to belt 12, and the acceptance walk slows belt 12 ONLY. The short branch
/// keeps draining, so an ALL-blocked Tee never stops, belt 10's head is taken every
/// tick, and there is nothing for a user to see. ANY-blocked is forced by that
/// acceptance topology; it is not a preference.
///
/// **Since phase 87 (JAM-02, D-03, D-04) the Tee is not gated by this function.** One slow
/// branch stopping every other branch was measured as the defect (WINDOWS 174), so
/// [`node_gated`] reads a Tee per branch and holds it back only when every docked branch is
/// busy; the backpressure walk slows both branches to keep grading the stall. Every other
/// kind keeps the reading below.
///
/// Two consequences, written here rather than left for a reader to discover:
///
/// * **A Router with three Outs stops entirely when ONE branch jams**, even for items
///   that would have gone down a free branch. That is the honest read of a filter
///   splitter with a full output, and it is what makes the cascade legible: the machine
///   that is refusing is the one holding the line.
/// * **A node whose output port has no `link_target` is never blocked by it.** An
///   undocked Out is not a full Out; it contributes no link, so it contributes no
///   demand.
///
/// # A Sink with no fault belt is never blocked, so a jam STOPS at a terminal (R-13)
///
/// 71-CONTEXT D-08 asks whether a jam propagates through a Sink. **It does not, unless
/// the user has drawn a fault belt** - and that reading needs no Sink-specific code and
/// gets none. This function walks `links_from(sink)`; a Sink with nothing docked on its
/// fault port has no outgoing links, so the demand map is empty, so it is never blocked
/// and keeps consuming. Dock a belt onto its fault port and that belt becomes an output
/// like any other, and a full one blocks the Sink like any other. The rule is one rule.
/// The consequence a user needs to know: **backpressure at a terminal requires drawing a
/// fault belt.**
///
/// # The demand model holds the fold's own fault drain (WINDOWS 176 half 1, D-05)
///
/// The step is not the only producer onto a node's outputs. The fault drain arm in
/// [`step_node`] moves ONE resting fault from the inbox's `FAULT_PORT` bucket onto the
/// linked fault port after the step, so a node holding a resting fault and docked on its
/// fault port demands one more item there than its links alone say. This function adds
/// that one under the drain arm's own condition (`link_target((id, FAULT_PORT))` is
/// `Some` and the inbox `has_on(FAULT_PORT)`), and adds nothing on an undocked fault
/// port, where the arm does not fire. Phase 87 measured what leaving it out cost: a
/// Router faulting every item onto a fault belt with one free slot pushed two items, the
/// second was refused, and the refusals nested `OutputRefused` 131 deep in 4000 ticks.
///
/// # Deliberately KIND-BLIND
///
/// There is no machine-kind match anywhere in this body, and there must not be one. The
/// kind exclusions (`Node::Belt`, ruling R-10a, and since phase 87 `Node::Tee`, JAM-02) live
/// in [`node_gated`], the one gate predicate the CALL SITE in [`step_node`] calls, with
/// their measured reasons written there. Putting a kind test in here is the first place the
/// rule would drift: the Sink reading above would stop being a consequence of walking
/// links and start being a match arm somebody could edit without noticing what it cost.
///
/// # Determinism
///
/// `links_from` is a `BTreeMap` range read in ascending `(NodeId, PortId)` order and the
/// demand accumulator is a `BTreeMap` too, so both the walk order and the grouping are
/// fixed by key order - never an arrival order, never a `HashMap` scan. The answer is a
/// pure function of `state`.
fn outputs_blocked(state: &GridState, id: NodeId) -> bool {
    // Group this node's outgoing links BY DESTINATION `(node, port)` and count how many
    // of its output ports map to each. Two ports docked to one destination demand TWO
    // (ruling R-11); without the grouping that board drops an item at the drain.
    let mut demand: BTreeMap<(NodeId, PortId), usize> = BTreeMap::new();
    for (_from, to) in state.links_from(id) {
        *demand.entry(to).or_insert(0) += 1;
    }
    // THE FOLD'S SECOND PRODUCER (WINDOWS 176 half 1, 87-CONTEXT D-05). The fault drain
    // arm in `step_node` pushes ONE resting fault onto the linked fault port AFTER the
    // step, on top of whatever the step itself emits there. Its demand is counted here
    // under the arm's own condition, read through the same two state calls: the fault
    // port is linked and the inbox holds a fault on it. Without this a node that also
    // emits on its fault port in its own step (a Router faulting every item) pushes two
    // items onto a destination the gate cleared for one, and the refused second becomes
    // a dead letter that the next refusal wraps again.
    //
    // IT OVER-RESERVES, KNOWINGLY (87-REVIEW IN-01). The link demand above counts the fault
    // link whether or not this step will emit a fault, so a node holding a resting fault
    // needs TWO free slots at its fault destination even when its step emits none there (a
    // Sink's fault belt now rests at `MECHANICAL_INBOX_CAP - 1`; the pin was moved for it).
    // The cost: such a node can be starved by a competing one-slot feeder into the SAME
    // destination port, which always finds the one slot it needs first. No catalog gesture
    // builds a shared fault destination today; a topology that does must be judged against
    // this reading.
    if let Some(fault_dest) = state.link_target((id, FAULT_PORT))
        && state.inbox_of(id).is_some_and(|i| i.has_on(FAULT_PORT))
    {
        *demand.entry(fault_dest).or_insert(0) += 1;
    }
    demand.into_iter().any(|((dest, dest_port), n)| {
        // THE SAME predicate the push sites call, reached through the SAME classifier.
        // The gate and the cap cannot drift into two readings of "can this destination
        // accept" (threat T-71-03-05): `accepts_one` is literally `accepts_n(.., 1)`.
        let class =
            crate::admit::admit_class(state, crate::admit::Emitter::Node(id), dest, dest_port);
        !crate::admit::accepts_n(state, class, dest, dest_port, n)
    })
}

/// Is `id` a machine stuck behind its own output: gated, and holding work it would do if it
/// could move? (Phase 87, JAM-04, D-06, D-12.)
///
/// True exactly when [`node_gated`] holds, the gate's own predicate and never a second
/// reading of "is this machine held back" (ruling R-3: one reading across crates), and the
/// node holds work: an item in its inbox on any port but [`FAULT_PORT`], a `Node::Source`
/// whose `pending` backlog is not empty, or a `Node::Factory` whose `pending_emits` is not
/// empty. A belt is never gated, so it never reads true.
///
/// Since phase 87 a blocked machine SLEEPS out of the active set, so it is no longer in
/// `last_tick.stepped`, and a presentation that read only `stepped` would paint a Tee holding
/// eight items behind two full branches IDLE: the jammed board would look empty. This is the
/// reading `derive_state` in `fabrico-host` takes AFTER its `stepped` arm to paint such a
/// machine BACKED_UP, the jam mark the board already draws. A gated machine holding nothing
/// (a Source with an empty backlog behind a full belt) has no work waiting and reads false.
///
/// A PURE READ of `state`: it writes nothing and reads no scheduler state, so the reading is
/// the same on a live board and on one restored from a save.
#[must_use]
pub fn waits_behind_blocked_output(state: &GridState, id: NodeId) -> bool {
    if !node_gated(state, id) {
        return false;
    }
    let inbox_work = state.inbox_of(id).is_some_and(|inbox| {
        inbox
            .ports_sorted()
            .any(|port| port != FAULT_PORT && inbox.len_on(port) > 0)
    });
    let own_queue = match state.node(id) {
        Some(Node::Source(source)) => !source.pending.is_empty(),
        Some(Node::Factory(factory)) => !factory.pending_emits.is_empty(),
        _ => false,
    };
    inbox_work || own_queue
}

/// Does the MACHINE `id` hold work its own step takes, so that it must step again with no
/// outside event? (Phase 87 security audit, threat T-87-28.)
///
/// True exactly when the machine's step would take something, read the way each step reads
/// its own work, and so exactly when that step re-wakes itself at `now + 1`:
///
///   - a `Node::Source` whose `pending` backlog is not empty (a Source ignores its inbox);
///   - a `Node::Sink`, `Node::Router` or `Node::Tee` with an item on In 0;
///   - a `Node::Balancer` with an item on either catalog In (`0..DEFAULT_ARITY`);
///   - a `Node::Merge` with an item on an In `0..inputs`;
///   - a `Node::Factory` with an item on In 0 or a waiting emit (`pending_emits`).
///
/// False for every other node: a belt and a wire have their own arms in the trust gate
/// (`BeltWakeMissing`, `WireWakeMissing`), and an Endpoint and a Label have no core step.
///
/// Two things are left out ON PURPOSE. A fault resting on [`FAULT_PORT`] is not work: the
/// fault drain arm in [`step_node`] moves it only once the fault port is docked, and a dock
/// wakes nothing ([`fold_dock`]), so a live board holds a resting fault with no wake at a
/// boundary. And an item on an In the step never reads (a Balancer's In 2, a Sink's In 1)
/// is not work either: a wake would not move it (threat T-87-29's shape, not this one's).
///
/// The snapshot trust gate reads it to refuse a machine holding work that is neither
/// scheduled at `core.tick` nor asleep (`StateInvariant::MachineWakeMissing`): such a
/// machine would never step again. A PURE READ of one node's own state and inbox.
#[must_use]
pub(crate) fn holds_work_its_step_takes(state: &GridState, id: NodeId) -> bool {
    let on = |port: PortId| state.inbox_of(id).is_some_and(|inbox| inbox.has_on(port));
    match state.node(id) {
        Some(Node::Source(source)) => !source.pending.is_empty(),
        Some(Node::Sink(_) | Node::Router(_) | Node::Tee(_)) => on(0),
        Some(Node::Balancer(_)) => (0..DEFAULT_ARITY).any(on),
        Some(Node::Merge(merge)) => (0..merge.inputs).any(on),
        Some(Node::Factory(factory)) => !factory.pending_emits.is_empty() || on(0),
        Some(Node::Belt(_) | Node::Wire(_) | Node::Endpoint(_) | Node::Label(_)) | None => false,
    }
}

/// Every item resting in `id`'s inbox, on every port (0 for a node with no inbox). The
/// consumer wake in [`step_node`] compares it before and after the step (phase 87,
/// JAM-04). A walk of one node's own buckets, never of the grid.
fn inbox_total(state: &GridState, id: NodeId) -> usize {
    state
        .inbox_of(id)
        .map_or(0, |inbox| inbox.ports_sorted().map(|port| inbox.len_on(port)).sum())
}

/// Is `id` a belt whose tail slot is occupied? False for any other node and for a belt
/// with no slots. The consumer wake in [`step_node`] compares it before and after a belt's
/// step (phase 87, JAM-04, plan 87-07).
fn belt_tail_occupied(state: &GridState, id: NodeId) -> bool {
    matches!(state.node(id), Some(Node::Belt(b)) if b.slots.last().is_some_and(Option::is_some))
}

/// Is the belt `id` SETTLED: unable to do anything until something outside it changes?
/// (Phase 87, JAM-04, D-06, success criterion 3.)
///
/// True exactly when all three hold:
///
///   1. ITS HEAD IS HELD. Slot 0 is occupied and the head-delivery block in [`step_node`]
///      would retain it now: the belt's Out has no link, or its destination is a belt
///      whose tail slot is occupied (the belt-to-belt arm's `tail_free` read), or its
///      destination is a machine that the SAME `admit_class` and `accepts_one` calls the
///      belt-to-machine arm makes would refuse.
///   2. ITS ITEMS ARE PACKED FROM THE HEAD. The occupied slots are `0..k` with no gap, so
///      an advance moves nothing (`belt_slots::advance_slots` only moves a run into a free
///      slot ahead of it). A belt with a gap is still closing forward and is never settled:
///      it must keep stepping until it has closed its last gap (PILE-07).
///   3. ITS TAIL CAN ADMIT NOTHING. Its staging inbox holds nothing on port 0 (the port
///      `Belt::step` takes from), or its tail slot is occupied.
///
/// A settled belt's step changes nothing, on any tick, due or not: the advance has nowhere
/// to move a run, the admit has nothing to take or nowhere to put it, and the head stays.
/// So [`step_node`] withdraws the next-tick wake `Belt::step` just set and puts the belt in
/// the sleep set, and the four things that can change one of the three clauses wake it:
/// a delivery into it (the generic drain and the belt-to-belt arm take it out of the set
/// and schedule it), the consumer that frees its head's machine destination and the
/// downstream belt whose tail slot comes free (both through the reverse link index), and
/// an edit tick. The snapshot trust gate reads this predicate to refuse a sleeping belt
/// that is not settled (`StateInvariant::BlockedBeltNotSettled`).
///
/// A PURE READ of `state`: false for any node that is not a belt and for a belt with no
/// slots. One belt's slots and its one destination, never a walk of the grid.
#[must_use]
pub(crate) fn belt_settled(state: &GridState, id: NodeId) -> bool {
    let Some(Node::Belt(belt)) = state.node(id) else {
        return false;
    };
    let slots = &belt.slots;
    let (Some(head), Some(tail)) = (slots.first(), slots.last()) else {
        return false;
    };
    if head.is_none() {
        return false;
    }
    // (2) packed from the head: once a free slot is seen, no occupied slot may follow.
    let occupied = slots.iter().take_while(|slot| slot.is_some()).count();
    if slots[occupied..].iter().any(Option::is_some) {
        return false;
    }
    // (3) nothing admissible at the tail.
    if tail.is_none() && state.inbox_of(id).is_some_and(|inbox| inbox.has_on(0)) {
        return false;
    }
    // (1) the head is held, read exactly as the head-delivery block reads it.
    match state.link_target((id, 0)) {
        None => true,
        Some((dest, dest_port)) => match state.node(dest) {
            Some(Node::Belt(downstream)) => downstream.slots.last().is_none_or(Option::is_some),
            _ => {
                let class = crate::admit::admit_class(state, crate::admit::Emitter::Node(id), dest, dest_port);
                !crate::admit::accepts_one(state, class, dest, dest_port)
            }
        },
    }
}

/// THE ONE GATE PREDICATE: is `id` held back this pass, not stepped? [`step_node`] calls
/// it before it takes the node's inbox, so a gated node stops consuming and the belt in
/// front of it packs backwards (PILE-02).
///
/// A Belt is never gated. A Tee is gated only when it has at least one docked Out branch
/// and EVERY docked one is busy (phase 87, JAM-02, D-04), or when its fault port is docked
/// and cannot take the busy copies the step would send there. Every other node is gated
/// exactly when [`outputs_blocked`] says so.
///
/// # The kind exclusions, and why each one is measured
///
/// THE FIRST EXCLUSION IS `Node::Belt` (ruling R-10a). Three reasons, every one of them
/// measured against this file rather than reasoned from the outside:
///
///   1. The belt head-delivery block lives INSIDE [`step_node`], hundreds of lines BELOW
///      the gate, after the machine step and after the generic outbox drain. An early
///      return there would make plan 71-01's retain-the-head-in-slot-0 path UNREACHABLE,
///      and `tick_belt_to_machine_bunches_at_the_cap` would then pass on this gate rather
///      than on the mechanism it is named after.
///   2. A gated belt's own `Machine::step` never runs, so it never advances its slots. A
///      12-tile belt behind a full machine would FREEZE wherever it stood, interior gaps
///      and all, instead of closing forward tile by tile. "The belt closes its last gap
///      and holds it" is the read PILE-07 asserts and PILE-11 asks a human to judge, so a
///      frozen belt fails the requirement while the gate looks correct. Since plan 87-07 a
///      belt DOES sleep, but never here and never with a gap: [`step_node`] puts a belt to
///      sleep after its own step and its head-delivery block, and only once
///      [`belt_settled`] holds (head held, items packed from the head, nothing admissible at
///      the tail). A belt still closing a gap is not settled, so it keeps stepping until the
///      gap is gone, which is exactly the "closes its last gap and holds it" read. This gate
///      would stop it while gaps stood; the settled test cannot.
///   3. `links_from(belt)` for a belt-to-belt link resolves to the DOWNSTREAM BELT'S
///      STAGING INBOX, but the belt-to-belt arm in [`step_node`] gates on `tail_free`, not
///      on inbox occupancy. `accepts_n` would answer a question nobody asked and stall a
///      belt whose downstream tail is free while its staging inbox happened to sit at the
///      cap.
///
/// A belt does not NEED this gate because it already has two of its own: `Belt::step`
/// admits from its staging inbox only when its tail slot is free, and the fold's
/// belt-to-belt arm retains the head on a full downstream tail. A third, coarser gate above
/// both would pre-empt them rather than reinforce them.
///
/// AND AN EXCLUDED BELT CAN NEVER REACH THE FAULTING DRAIN, which phase 71's
/// zero-`OutputRefused` assertion rests on: a belt's outbox is ALWAYS EMPTY, because the
/// FOLD delivers a belt's head and `Belt::step` deliberately does not (the head-delivery
/// block says so in its own words). So the drain loop body never runs for a belt and the
/// `OutputRefused` path is unreachable from one. If a future phase ever gives `Belt::step`
/// an outbox write, THIS EXCLUSION MUST BE RE-TAKEN.
///
/// THE SECOND EXCLUSION IS `Node::Tee` (phase 87, JAM-02, WINDOWS 174, 87-CONTEXT D-03 and
/// D-04), and this is the measured reason the paragraph below asks for. Under the
/// ANY-blocked gate one slow branch stopped the Tee entirely: on P174 (a Tee whose Out 1
/// belt docks nowhere and whose Out 0 feeds a Sink, fed every 2 ticks) the healthy branch
/// received 20, then 0, 0, 0 items per 200 ticks, because once the slow branch filled every
/// item the healthy branch could have taken waited behind it. The Tee is now gated per
/// branch: the fold reads each Out branch's state ([`tee_branch_states`]) from the same
/// `admit_class` and `accepts_n` calls [`outputs_blocked`] makes, demand counted per
/// destination the same way, and the Tee is held back only when every DOCKED branch is
/// busy (D-04, the case the ANY-blocked gate already covered). An undocked branch counts as
/// neither free nor busy (87-RESEARCH Pitfall 4): counted free, a Tee with one docked
/// jammed branch and one undocked branch would never stall, would shed every copy and would
/// stop packing upstream, which `77-one-board-all-five` leg 3 grades. A busy branch's copy
/// is counted on `Tee.faults` and leaves on `FAULT_PORT` as a `BranchBusy` fault (`tee.rs`),
/// so nothing a busy branch misses is lost without a trace. A Tee with no docked branch is
/// never gated, as before. Since the ANY-blocked reading was forced by the demo board's
/// acceptance walk slowing ONE Tee branch (ruling R-10, in [`outputs_blocked`]), the
/// backpressure walk now slows both (`25-backpressure-cascade.spec.ts`, phase 87).
///
/// The Router does not get this for free and keeps the ANY-blocked gate: it sends each item
/// down exactly one route, so a per-branch gate would turn a blocked route into a dead
/// letter rather than a wait (87-RESEARCH Finding 2; out of scope).
///
/// A THIRD KIND EXCLUSION NEEDS A MEASURED REASON AND A PLAN AMENDMENT. In particular the
/// Sink ruling (R-13) stays a CONSEQUENCE of walking `links_from` inside
/// [`outputs_blocked`] and never a match arm here.
///
/// What happens to a gated node is the caller's: since phase 87 (JAM-04, D-06) [`step_node`]
/// puts it to sleep in the scheduler's sleep set, and the consumer that frees its slot, a
/// delivery or an edit wakes it. The snapshot trust gate reads this predicate too, to refuse
/// a sleeper that is not gated (`StateInvariant::BlockedNotGated`).
pub(crate) fn node_gated(state: &GridState, id: NodeId) -> bool {
    match state.node(id) {
        Some(Node::Belt(_)) => false,
        Some(Node::Tee(tee)) => tee_gated(state, id, &tee_branch_states(state, id, tee.outputs)),
        _ => outputs_blocked(state, id),
    }
}

/// What each of a Tee's Out branches `0..outputs` can take this pass (phase 87, JAM-02,
/// D-03): undocked (no link), free (its destination accepts one more item) or busy.
///
/// The SAME reading [`outputs_blocked`] makes, so the two cannot drift (threat T-71-03-05):
/// the class from `admit_class` with the Tee as the emitter, the answer from `accepts_n`,
/// and the demand counted per destination, so two branches docked to one destination ask
/// it for two (ruling R-11). The fold reads it before the Tee's node borrow and hands it to
/// `Tee::step_branches`: only the fold may read another node's capacity (CORE-03). A pure
/// function of `state`; the walk is in port order and the demand is a `BTreeMap`.
fn tee_branch_states(state: &GridState, id: NodeId, outputs: u16) -> Vec<crate::tee::TeeBranch> {
    use crate::tee::TeeBranch;
    let mut demand: BTreeMap<(NodeId, PortId), usize> = BTreeMap::new();
    for port in 0..outputs {
        if let Some(to) = state.link_target((id, port)) {
            *demand.entry(to).or_insert(0) += 1;
        }
    }
    (0..outputs)
        .map(|port| match state.link_target((id, port)) {
            None => TeeBranch::Undocked,
            Some((dest, dest_port)) => {
                let n = demand.get(&(dest, dest_port)).copied().unwrap_or(1);
                let class = crate::admit::admit_class(
                    state,
                    crate::admit::Emitter::Node(id),
                    dest,
                    dest_port,
                );
                if crate::admit::accepts_n(state, class, dest, dest_port, n) {
                    TeeBranch::Free
                } else {
                    TeeBranch::Busy
                }
            }
        })
        .collect()
}

/// The Tee's gate over its branch states (phase 87, JAM-02, D-04): held back only when it
/// has a docked branch and every docked branch is busy.
///
/// One more case holds it back, for a Tee whose fault port is docked (the catalog Tee has
/// no fault nub, so only a built state can dock one): the busy copies leave on that port,
/// one per busy branch, plus one resting fault if the drain arm in [`step_node`] fires, and
/// a destination that cannot take them all would refuse a copy at the drain, where a Tee
/// has no counter to catch it. So that destination is asked for all of them, by the same
/// `accepts_n`, and a refusal gates the Tee as a full branch would.
fn tee_gated(state: &GridState, id: NodeId, branches: &[crate::tee::TeeBranch]) -> bool {
    use crate::tee::TeeBranch;
    let docked = branches.iter().filter(|b| **b != TeeBranch::Undocked).count();
    let busy = branches.iter().filter(|b| **b == TeeBranch::Busy).count();
    if docked > 0 && busy == docked {
        return true;
    }
    if let Some((dest, dest_port)) = state.link_target((id, FAULT_PORT)) {
        let drained = usize::from(state.inbox_of(id).is_some_and(|i| i.has_on(FAULT_PORT)));
        let need = busy + drained;
        if need > 0 {
            let class =
                crate::admit::admit_class(state, crate::admit::Emitter::Node(id), dest, dest_port);
            return !crate::admit::accepts_n(state, class, dest, dest_port, need);
        }
    }
    false
}

/// The dead letter the generic outbox drain re-admits onto the emitter's `FAULT_PORT`
/// when a destination refuses an item that left on `port` (WINDOWS 176 half 2, 87-CONTEXT
/// D-05).
///
/// An item that left on [`FAULT_PORT`] is ALREADY the fault its emitter meant (a Router's
/// no-match, a Factory's fault, a resting fault the drain arm carried out), so it comes
/// back UNCHANGED: wrapping it again would add a header around the whole previous fault on
/// every refusal, which is the growth phase 87 measured (`OutputRefused` nested 131 deep
/// and a save growing from 3379 to 12380 bytes in 3000 ticks). Any other item is wrapped
/// ONCE as an `OutputRefused` fault naming the emitter, as before.
///
/// # The PORT decides, never the bytes
///
/// The rule reads the port the item left on and nothing else. It never asks whether the
/// item's bytes happen to parse as a `Fault`: a user item can be any bytes, including a
/// valid fault encoding, and phase 72 deleted exactly that byte sniff from the factory
/// (`factory.rs`, "two discriminators that can disagree are worse than either alone").
/// The port is the one discriminator the fold already owns.
///
/// # No wire change, so no schema bump
///
/// The `Fault` struct and every `FaultReason` discriminant are unchanged; a fault on the
/// wire reads exactly as it did. D-05's "if this changes the Fault wire shape it takes the
/// schema bump" therefore does not arise.
///
/// # Reachability
///
/// Half 1 (the gate counts the drain arm, [`outputs_blocked`]) keeps a ROUTER'S single
/// no-match fault and the drain arm's carry from being refused. It does not cover a
/// Factory since plan 87-04: a run with emits past `FACTORY_EMITS_PER_PORT` pushes one
/// `FactoryError` per surplus emit onto `FAULT_PORT` in one step, while the gate cleared
/// the fault link's demand and the drain arm's, so on a docked fault belt with little room
/// the rest are refused and come through this arm (87-REVIEW WR-03). The board test
/// `no_permanent_jams.rs` `a_factorys_refused_surplus_faults_rest_unwrapped` drives that
/// path end to end and reads red when this arm wraps; the unit test
/// `tick_a_refused_fault_is_readmitted_unchanged` pins both arms on their own.
fn refused_dead_letter(id: NodeId, port: PortId, refused: Item) -> Item {
    if port == FAULT_PORT {
        refused
    } else {
        Fault::command(id, FaultReason::OutputRefused, refused.0).encode()
    }
}

/// Re-admit an item a destination refused at the generic outbox drain onto its emitter's
/// own `FAULT_PORT`, as the dead letter [`refused_dead_letter`] builds, and COUNT it on the
/// emitter when even that is refused past `FAULT_QUEUE_CAP` (CR-01). The whole refusal arm
/// of [`step_node`]'s drain, named so it can be driven on its own.
///
/// # Why it is named (phase 87, plan 87-04)
/// Until plan 87-04 a user item reached this arm on a live board by one path: a Factory
/// whose run emitted twice on one port pushed two items past a gate that cleared one
/// (WINDOWS 165). Plan 87-04 queues a run's later emits on the Factory, so no machine's
/// step pushes more user items onto a port than the gate cleared, and this arm is defence
/// in depth for user items, as `refused_dead_letter`'s fault arm has been since plan 87-02.
/// Items leaving on `FAULT_PORT` can still reach it (a Factory run whose surplus emits each
/// fault pushes one fault per surplus emit). The CR-01 count is pinned by driving this
/// function (`tick_over_cap_output_refused_is_counted_and_conserved`).
fn readmit_refused(core: &mut Core, id: NodeId, port: PortId, refused: Item, route_seq: u64) {
    let dead_letter = refused_dead_letter(id, port, refused);
    if crate::admit::try_admit(
        &mut core.state,
        crate::admit::Emitter::Node(id),
        id,
        FAULT_PORT,
        route_seq,
        dead_letter,
    )
    .is_err()
    {
        core.state.count_dropped_fault(id);
    }
}

/// Step a single active node, then route its outputs onto belts/links.
///
/// Uses the split-borrow pattern (RESEARCH Pattern 1): the node's inbox is taken
/// out (owned) so the node itself can be borrowed mutably from `core.state` while
/// `StepCtx` simultaneously borrows the sibling `sched`/`rng` fields. After the
/// step, the inbox is restored and each produced `(port, item)` is routed through
/// `links[(id, port)]` into the destination's inbox, waking it.
fn step_node(
    core: &mut Core,
    id: NodeId,
    commands: &mut Vec<Command>,
    route_seq: &mut u64,
) {
    let now = core.tick;

    // THE PILE-02 GATE, and since phase 87 THE SLEEP (JAM-04, D-06, WINDOWS 177).
    //
    // Placed HERE, before the `std::mem::take` of the inbox below, because this is the
    // one position where `core.state` can be read immutably with no borrow conflict -
    // and because a gate that ran after the inbox had been taken would have already let
    // the machine stop being the thing holding the line.
    //
    // A node that steps leaves the sleep set first (`unblock`) and re-enters it only if
    // it is still gated, so the set holds exactly the nodes the gate last held back.
    //
    // A gated node is NOT stepped: its inbox is not taken, so it stops consuming and the
    // belt in front of it packs backwards. It then SLEEPS: `mark_blocked` puts it in the
    // scheduler's sleep set and nothing re-schedules it. Until phase 87 it re-scheduled
    // itself at `now + 1` here, unconditionally, which was the ONLY thing that woke a
    // blocked node, so a board jammed solid stepped every machine on every tick forever
    // (P177B: 2.00 machine steps per tick, against the project's performance rule, "idle ticks
    // must be nearly free"). Three things wake a sleeper now, and between them they cover every way a
    // block can lift:
    //
    //   1. THE CONSUMER WAKE, below the fault drain arm: a node whose inbox shrank on its
    //      step finds its feeders through the state's derived reverse link index and
    //      schedules each one that is asleep at `now + 1`. A gated node's outputs are
    //      blocked only by a destination's inbox at its cap, and that inbox shrinks only
    //      on the destination's own step, so the consumer wake reaches every blocked
    //      feeder the tick after its slot frees. That matches the old self re-wake only
    //      when the feeder's NodeId is BELOW its consumer's. When the feeder's NodeId is
    //      above (the consumer was placed first), the old spinning feeder stepped after
    //      the consumer in the same tick and refilled the slot that tick; the sleeping one
    //      refills it a tick later, so a jam in such a chain clears one hop per tick.
    //      Deliveries are unchanged; item positions at tick boundaries are not (87-REVIEW
    //      WR-01, kept by ruling). `no_permanent_jams.rs`
    //      `a_blocked_feeder_resumes_one_tick_after_its_slot_frees_in_either_order` pins
    //      this latency in both orders. `now + 1` AND NEVER `wake_now`: the two `THIS GUARD STAYS
    //      AT now + 1` blocks below explain the failure mode in the file's own words, and
    //      this is the third case they cover - a `wake_now` re-enters the CURRENT tick's
    //      fixpoint, and a node whose output is still blocked would spin until the
    //      `node_count + 1` iteration cap cut it off.
    //   2. A DELIVERY into its own inbox (`wake_now` at the generic drain and at the belt
    //      head delivery). A sleeper woken that way steps once, is still gated and goes
    //      back to sleep: one step per delivery, never one per tick.
    //   3. AN EDIT: a tick that carries edits wakes every sleeper before the fixpoint
    //      (`Scheduler::wake_all_blocked_now` in `tick()`), so a Disconnect, the delete of
    //      the destination, a port edit or a rotate resumes it without any consumer
    //      stepping.
    //
    // 87-RESEARCH measured why the WINDOWS row's own fix shape (keep a node awake only
    // while its inbox holds work) was not taken: a blocked Source holds its work in
    // `pending`, not in its inbox, so it would sleep forever, and every machine with a
    // full inbox on a jammed board would still spin.
    //
    // `core.last_tick.stepped` is deliberately LEFT ALONE. It is extended from the active
    // set before any node is stepped, so a node the fold considers and gates on this tick
    // (one woken by a delivery while still blocked) is still in it, and that is correct:
    // the fold DID consider it. A SLEEPER is not in the active set and so is not in it,
    // which is why `derive_state` in `fabrico-host` reads a machine waiting behind its
    // output from `waits_behind_blocked_output` rather than from `stepped`.
    //
    // THE KIND EXCLUSIONS (the Belt, ruling R-10a, and since phase 87 the Tee, JAM-02)
    // live in [`node_gated`], the ONE gate predicate, with their measured reasons written
    // there. `outputs_blocked` stays kind-blind. The sleep goes through `node_gated` too,
    // so a Tee with one free branch is never put to sleep.
    core.sched.unblock(id);
    if node_gated(&core.state, id) {
        core.sched.mark_blocked(id);
        return;
    }
    // The inbox total BEFORE the step, read for the consumer wake below the drain arm.
    let inbox_before = inbox_total(&core.state, id);
    // For a belt, whether its TAIL SLOT is occupied before the step, read for the same wake
    // (phase 87, JAM-04, plan 87-07): a belt fed by another belt receives into its tail slot
    // directly, never through its staging inbox, so its inbox never shrinks for that feeder.
    let tail_before = belt_tail_occupied(&core.state, id);

    // Record the command tail BEFORE this node steps, so the reply reverse-transport
    // below inspects ONLY the commands THIS node emitted this step (37-03).
    let cmd_start = commands.len();
    // The delivering port's DECLARED medium, read ONCE from the snapshot and hoisted
    // ABOVE the `node_mut` borrow below, which holds `&mut core.state` across the whole
    // match block (ruling R-22). That is why this seam is a `Copy` scalar passed by
    // value and not a `&GridState` or a `&[Port]`: no borrow of state can cross it.
    //
    // This is WHAT MAKES A DELIVERY A WIRE REQUEST (D-16), and `factory::step_factory`
    // reads nothing else to decide. `crate::admit::inbox_class` is the ONE predicate the
    // mechanical inbox cap and the load gauge already share, so the fold does not mint a
    // second reading of "is this port electrical" (ruling R-3). It is deliberately NOT
    // `admit_class`: that one layers an EMITTER clause on top (any delivery from a
    // `Node::Wire` reads Electrical), which answers the admission-capacity question and
    // would make a port-less Factory serviceable whenever its feeder happens to be a
    // wire. Port 0 is the subject because the factory sandbox drains inbox port 0 only.
    let port_zero_is_electrical = matches!(
        crate::admit::inbox_class(&core.state, id, 0),
        crate::admit::AdmitClass::Electrical
    );
    // THE FACTORY'S LINKED OUTPUT PORTS (phase 87, JAM-05, D-07), read here for the same
    // reason as the scalar above: the `node_mut` borrow below holds `&mut core.state`, so
    // this is an OWNED set read before it, never a borrow that crosses into the step. Only
    // these ports may queue a run's later emits, so a queue never names a port the trust
    // gate would refuse (`StateInvariant::FactoryPendingEmits`). Empty, and never
    // allocated, for every other kind.
    let factory_out_ports: BTreeSet<crate::ids::PortId> =
        if matches!(core.state.node(id), Some(Node::Factory(_))) {
            core.state
                .links_from(id)
                .map(|((_, port), _)| port)
                .filter(|&port| port != FAULT_PORT)
                .collect()
        } else {
            BTreeSet::new()
        };
    // THE TEE'S BRANCH STATES (phase 87, JAM-02, D-03), read here for the same reason: an
    // OWNED answer from the same reading `node_gated` just made of the same state, handed
    // to the Tee's step so it never reads another node's capacity itself (CORE-03). Empty,
    // and never allocated, for every other kind.
    let tee_branches: Vec<crate::tee::TeeBranch> = match core.state.node(id) {
        Some(Node::Tee(tee)) => tee_branch_states(&core.state, id, tee.outputs),
        _ => Vec::new(),
    };
    // Take the inbox out so it does not alias the node borrow below.
    let mut inbox = std::mem::take(core.state.inbox_mut(id));
    let mut outbox = PortOutbox::new();

    {
        // The active set only holds live, woken nodes; a missing node is a bug.
        let node = core
            .state
            .node_mut(id)
            .expect("step_node: active id has no node");
        match node {
            // The factory is special-cased rather than driven through the `Machine`
            // trait: it needs the Core-level `factory_runtimes` cache, which `StepCtx`
            // deliberately does not expose. `core.factory_runtimes` and `core.sched`
            // are sibling Core fields (disjoint from `core.state`), so they borrow
            // alongside the node the same way `sched`/`rng` do for the other arms.
            // `core.sched` lets the factory re-wake itself at tick+1 while its inbox
            // has a backlog (bounded per-tick work, WR-03). The golden-rule capability
            // model is still honored — user JS reaches the world ONLY through the
            // injected `ctx`, never sim internals (see `factory::step_factory`).
            Node::Factory(factory) => crate::factory::step_factory(
                now,
                id,
                factory,
                &mut core.factory_runtimes,
                &mut inbox,
                port_zero_is_electrical,
                &factory_out_ports,
                &mut outbox,
                commands,
                &mut core.sched,
            ),
            // The wire is special-cased like the factory (NOT driven through
            // `StepCtx`): `step_wire` iterates the taken-out `inbox` directly to
            // INGEST wire-to-wire deliveries in ascending-port `route_seq` FIFO order,
            // and borrows `core.sched` (a sibling Core field, disjoint from
            // `core.state`) to self-rewake while messages remain in flight — a set
            // `StepCtx` deliberately does not bundle for direct inbox iteration
            // (RESEARCH §1). Its re-forwarded outputs are routed by the SAME generic
            // outbox drain below, so wire and belt delivery share ONE route_seq queue.
            Node::Wire(link) => {
                step_wire(now, id, link, &mut inbox, &mut outbox, &mut core.sched)
            }
            // Every other node reaches the world through the single `StepCtx`
            // capability object.
            other => {
                let mut ctx = crate::machine::StepCtx::new(
                    now,
                    id,
                    &mut inbox,
                    &mut outbox,
                    commands,
                    &mut core.sched,
                    &mut core.rng,
                );
                match other {
                    Node::Source(source) => crate::machine::Machine::step(source, &mut ctx),
                    Node::Belt(belt) => crate::machine::Machine::step(belt, &mut ctx),
                    // Per branch (JAM-02, D-03): the states the fold read above.
                    Node::Tee(tee) => tee.step_branches(&mut ctx, &tee_branches),
                    Node::Balancer(balancer) => crate::machine::Machine::step(balancer, &mut ctx),
                    Node::Merge(merge) => crate::machine::Machine::step(merge, &mut ctx),
                    Node::Router(router) => crate::machine::Machine::step(router, &mut ctx),
                    Node::Sink(sink) => crate::machine::Machine::step(sink, &mut ctx),
                    Node::Factory(_) => unreachable!("Factory handled above"),
                    Node::Wire(_) => unreachable!("Wire handled above"),
                    // An Endpoint has no CORE step — no wake, no route, no alloc — and
                    // that is permanent, not pending: Phase 38 put its behaviour
                    // host-side, where `SimLoop` publishes the route its path keys and the
                    // executor resolves replies. A typed no-op (NEVER
                    // unreachable!/panic!/todo!) so a forged snapshot carrying an endpoint
                    // discriminant steps to nothing and can never panic on the
                    // untrusted-load path (SCHEMA-03, threat T-35-01-INERT).
                    Node::Endpoint(_) => {}
                    // A Label has no step at all, and that is permanent: it is a note, it
                    // takes no items, routes nothing and draws no random number (D-03,
                    // SHAPE-11). A typed no-op (NEVER unreachable!/panic!/todo!), exactly
                    // as for the Endpoint above, so a forged snapshot carrying a label
                    // discriminant steps to nothing on the untrusted-load path.
                    Node::Label(_) => {}
                }
            }
        }
    }

    // Restore the (possibly-drained) inbox.
    *core.state.inbox_mut(id) = inbox;

    // THE FAULT DRAIN (PILE-10, ruling R-18). A fault RESTING in this node's inbox on
    // the reserved FAULT_PORT moves to its outbox - and therefore, through the generic
    // drain below, onto a belt - WHEN AND ONLY WHEN that fault port is LINKED.
    //
    // Nothing in this repository moved a fault from an inbox to an outbox before this
    // arm. A Router PRODUCES its no-match fault straight into its OUTBOX (`router.rs`),
    // so a docked belt already carried it away; a Sink RECEIVES a CommandFailure /
    // CommandTimeout into its INBOX (`manual_inject.rs`) and drains only `take_input(0)`,
    // a hard-coded literal, so nothing ever read it. This is the drain that was missing.
    //
    // THREE REASONS IT IS A FOLD ARM AND NOT A `Machine::step` ARM, all of them the
    // reason and not a preference:
    //
    //   1. It needs `link_target`, a CROSS-NODE read. The fold's own doctrine, written
    //      out at the belt head-delivery block below, is that a cross-node "can the
    //      downstream accept / is there a downstream" question lives HERE in the fold,
    //      which legitimately sees the whole grid, and NEVER inside a `Machine::step` or
    //      a `StepCtx` (share-nothing, CORE-03).
    //   2. IT MUST NOT FIRE ON AN UNDOCKED FAULT PORT. Today an undrained inbox fault is
    //      the ONE signal a user has that a board is pointed at a dead endpoint:
    //      `derive_state` in `fabrico-host` paints a machine FAULTED while its inbox
    //      holds one. A Sink-side drain that ran regardless of docking would push the
    //      fault to the outbox, the undocked-fault arm below would drop it, and the
    //      machine would go quietly green. That is a silent loss of the signal, which is
    //      exactly the trade PILE-09's bound would otherwise have made.
    //   3. ONE ARM COVERS EVERY KIND. A Sink-side arm covers a Sink. A Factory and an
    //      Endpoint receive inbox faults too.
    //
    // ONE ITEM PER PASS, re-waking at `now + 1` while more remain (plan 71-03's ruling
    // R-12, the same reasoning every machine's step now follows): the PILE-02 gate above
    // proved ONE item admissible per linked output, so moving a whole bucket in one pass
    // could overflow a destination the gate had just cleared. `now + 1` and never
    // `wake_now`, for the reason the two `THIS GUARD STAYS AT now + 1` blocks below give
    // at length.
    //
    // The gate above covers this link AND this arm's push. `outputs_blocked` walks EVERY
    // entry in `links_from(id)`, and a docked fault port is an entry like any other; since
    // phase 87 (WINDOWS 176 half 1, D-05) it also adds one demand on that link whenever
    // this arm's own condition holds (the fault port linked, a fault resting on it), so
    // the step's own fault emission plus this arm's one item are both counted against the
    // destination before the node is stepped. So a Sink whose fault belt's staging inbox
    // is full is not stepped at all, and this arm is not reached - 71-CONTEXT D-08
    // arriving as a consequence of one rule rather than as a special case - and a node
    // whose fault belt has room for one item but would receive two is gated too.
    if core.state.link_target((id, FAULT_PORT)).is_some()
        && let Some((_seq, item)) = core.state.inbox_mut(id).take(FAULT_PORT)
    {
        outbox.push(FAULT_PORT, item);
        // Re-wake only while the bucket still holds work, so a drained-empty node does
        // not schedule itself forever (the merge re-wake gate's rule, WR-01).
        if core
            .state
            .inbox_of(id)
            .is_some_and(|i| i.has_on(FAULT_PORT))
        {
            core.sched.schedule_wake(id, now + 1);
        }
    }

    // THE CONSUMER WAKE (phase 87, JAM-04, D-06). This node's step and the drain arm
    // above are the only places its inbox shrinks, so if it holds fewer items now than
    // before the step, a slot one of its feeders may be blocked on has freed. Each feeder
    // comes from the derived reverse link index (`GridState::feeders_of`), never from a
    // walk of every link (the project's performance rule: no full-grid scans), and ONLY a feeder the sleep set
    // reports asleep is woken: the research prototype that woke every feeder added wheel
    // entries on boards with no jam at all and moved golden 0001. `now + 1`, never
    // `wake_now`, for the reason the gate's comment above gives. A feeder woken this way
    // whose slot was taken again before it steps is still gated and goes back to sleep.
    //
    // A BELT WHOSE TAIL SLOT CAME FREE counts as having freed room too (plan 87-07). An
    // upstream belt delivers into this belt's tail slot directly (the belt-to-belt arm
    // below), so when it is SETTLED against an occupied tail the only event that can lift
    // its block is this belt's advance emptying that slot. Without this clause such a
    // feeder would sleep forever (`a_settled_belt_wakes_when_its_downstream_belt_frees`).
    let tail_freed = tail_before && !belt_tail_occupied(&core.state, id);
    if inbox_total(&core.state, id) < inbox_before || tail_freed {
        let feeders: Vec<NodeId> = core.state.feeders_of(id).collect();
        for feeder in feeders {
            if core.sched.unblock(feeder) {
                core.sched.schedule_wake(feeder, now + 1);
            }
        }
    }

    // Route outputs deterministically: outbox drains in ascending (port, FIFO)
    // order; each item follows its link into the destination's inbox carrying a
    // strictly-increasing per-tick `event_seq` (ROUTE-06 cross-port tie-break),
    // and wakes the destination. A missing link for an output port is a no-op (a
    // sink with no downstream) and consumes no sequence.
    // Detect fault production for the observation (VIS-03): a node emitting on the
    // reserved FAULT_PORT this step is `faulted`. This unified per-step signal
    // catches BOTH the router (no-match-without-default) and the factory
    // (FAULT_PORT emission), and it counts PRODUCTION regardless of whether the
    // fault port is wired (an unwired fault is still a fault) — mirroring the
    // producer-side `Router.faults` debug counter. Recorded once per step even if
    // several items fault, since the host only checks membership.
    //
    // SINCE PILE-10 THE DRAIN ARM ABOVE ALSO REACHES THIS FLAG, and that is correct
    // rather than incidental: a fault leaving on a docked belt is emitted through this
    // node's outbox on this tick, so the node IS faulted on the tick it hands the fault
    // over. What changes is the DURATION, not the reading. Before the drain a faulted
    // machine stayed FAULTED forever because the inbox never emptied; with a docked
    // fault belt it reports FAULTED on the ticks it is actually shedding faults and
    // goes quiet when the last one has left. With NO fault belt nothing changes at all:
    // the fault rests in the inbox and `derive_state`'s `holds_unread_fault` clause
    // keeps painting it red.
    let mut produced_fault = false;
    for (port, item) in outbox.drain_sorted() {
        if port == FAULT_PORT {
            produced_fault = true;
        }
        if let Some((dest, dest_port)) = core.state.link_target((id, port)) {
            // THE ONE ADMISSION PATH (71-CONTEXT D-03). `try_admit` classifies the
            // delivery from the EMITTING side and either places the item or hands it
            // back: an electrical delivery and a FAULT_PORT delivery are never refused,
            // a mechanical one is refused once the destination port holds
            // `MECHANICAL_INBOX_CAP` items.
            match crate::admit::try_admit(
                &mut core.state,
                crate::admit::Emitter::Node(id),
                dest,
                dest_port,
                *route_seq,
                item,
            ) {
                Ok(()) => {
                    *route_seq += 1;
                    // A belt is transport WITH LATENCY, NOT a 0-latency instant-wire: it
                    // must step AT MOST ONCE PER TICK, and therefore advance at most one
                    // slot per tick and at most one per `ticks_per_slot` ticks (SLOT-03).
                    // Waking it NOW would re-enter the current fixpoint and double-step
                    // it whenever it was already in the initial active set (AR-3
                    // occupied-slot re-wake), giving ~2x transport rate (CR-01). Schedule
                    // belts for the NEXT tick so a fed belt advances once; keep
                    // `wake_now` (0-latency instant-wire) for machine targets, which
                    // carry no per-tick transport.
                    //
                    // **THIS GUARD STAYS AT `now + 1` AND MUST NOT BE "OPTIMISED" TO THE
                    // NEXT DUE TICK.** It defends against RE-ENTRY WITHIN ONE TICK'S
                    // FIXPOINT, not against the advance interval; those are different
                    // failure modes and this one is unchanged by SLOT-03. The interval is
                    // enforced by the absolute-tick gate inside `Belt::step`, which is
                    // required regardless of where this line schedules, so moving the
                    // wake to the next due tick would buy nothing and would reintroduce
                    // the double step on every non-due wake.
                    //
                    // A BELT ASLEEP (settled, plan 87-07) LEAVES THE SLEEP SET HERE: an item
                    // in its staging inbox may be admissible on its next step, so it is no
                    // longer settled and must not sit in the set across the tick boundary
                    // (`StateInvariant::BlockedBeltNotSettled`). It steps at `now + 1` and
                    // goes back to sleep if it is still settled.
                    if matches!(core.state.node(dest), Some(Node::Belt(_))) {
                        core.sched.unblock(dest);
                        core.sched.schedule_wake(dest, now + 1);
                    } else {
                        core.sched.wake_now(dest);
                    }
                }
                Err(refused) => {
                    // THE REFUSAL SHAPE AT THIS SITE IS A FAULT, NOT A RETAIN (71-01
                    // ruling R-4). `PortOutbox::drain_sorted` is a `std::mem::take`, so
                    // by the time this loop body runs the item is already out of the
                    // outbox and there is NOWHERE to put a refused one back; the outbox
                    // is fold-local and never crosses a tick boundary, and serializing
                    // it would be a `GridState` shape change D-09 forbids. So the item
                    // does not travel: it rides as the payload of a
                    // `FaultReason::OutputRefused` fault on the EMITTING node's
                    // FAULT_PORT, and the emitter is woken. The shape is the
                    // `WireRequest` overflow arm's (`manual_inject.rs`): a refused
                    // admission mints a fault to the emitting node rather than growing
                    // anything past its cap.
                    //
                    // The fault push goes through `try_admit` too - FAULT_PORT classifies
                    // as `AdmitClass::Fault`, bounded by `FAULT_QUEUE_CAP`; past that bound
                    // the dead letter cannot be placed either. It does NOT set
                    // `produced_fault`: that observation counts fault EMISSION through a
                    // node's outbox, and a fold-minted fault is not an emission (the
                    // `route_replies` overflow fault does not set it either).
                    //
                    // **THE OVER-CAP DROP IS COUNTED (CR-01).** This is the ONE drop in
                    // the fold that destroys a CONVEYABLE rather than a diagnostic: the
                    // discarded value is a `Fault` whose payload IS the user's item
                    // (`refused.0`), so an uncounted `let _ =` here would annihilate an
                    // item with no trace in state, in the observation or in any counter -
                    // and every conservation sum in the phase counts items RESTING on
                    // FAULT_PORT, which is exactly the set this path is not in. It is
                    // counted through the SAME `count_dropped_fault` the NO-LINK drop
                    // twelve lines below uses, for the same reason and at the same cost:
                    // a snapshot-captured per-node integer, no schema change, no
                    // `GridState` shape change (the item itself cannot be retained - the
                    // outbox is a fold-local `std::mem::take`, which D-09 forbids
                    // serializing). The defect this closes is the SILENCE, not the drop.
                    //
                    // **A REFUSED FAULT IS NEVER WRAPPED AGAIN (WINDOWS 176, D-05).** The
                    // row had two halves and both are closed. Half 1 lives in the gate:
                    // `outputs_blocked` counts the fault drain arm's push, so the fold's own
                    // drain can no longer overfill a fault port the gate just cleared, and
                    // a refusal of an item leaving on `FAULT_PORT` does not arise on a
                    // gated board. Half 2 is here: the dead letter is built by
                    // `refused_dead_letter`, keyed on the port the item LEFT on, so an item
                    // that left on `FAULT_PORT` is re-admitted unchanged and any other item
                    // is wrapped once. Before both, each refusal wrapped the previous fault
                    // whole, and a jammed board's save grew without any edit or event.
                    readmit_refused(core, id, port, refused, *route_seq);
                    *route_seq += 1;
                    core.sched.wake_now(id);
                }
            }
        } else if port == FAULT_PORT {
            // Undocked fault DROP point (CAT-02 / CONTEXT Area 2): a fault emitted on
            // the reserved FAULT_PORT with NO belt docked there is NOT silently
            // dropped — it increments the emitting machine's snapshot-captured
            // per-machine fault counter so error counts stay inspectable without
            // wiring anything. A no-op for a non-Factory emitter (the router keeps its
            // own production-side counter). This is the ONLY behavior change to the
            // fold's existing missing-link no-op, and it is deterministic (a pure
            // per-node integer increment at a fixed fold point).
            //
            // A Tee's busy copy (phase 87, JAM-02, a `BranchBusy` fault) reaching here is
            // ALREADY COUNTED on `Tee.faults` by the Tee's own step, and its emission has
            // marked the Tee FAULTED this tick (`produced_fault` above), so dropping it here
            // loses nothing uncounted; `count_dropped_fault` is a no-op for a Tee.
            core.state.count_dropped_fault(id);
        }
    }
    if produced_fault {
        core.last_tick.faulted.push(id);
    }

    // Belt head-delivery (BELT-04/07, RESEARCH Pattern 3 + Pitfall 1 — the
    // backpressure trap): the FOLD — which legitimately sees the whole grid —
    // delivers a belt's head (slot 0). `Belt::step` deliberately does NOT, so an
    // undeliverable head RETAINS in slot 0 (bunching). The cross-node "can the
    // downstream accept?" decision lives HERE in the fold (which sees BOTH belts),
    // NEVER inside `Belt::step` / `StepCtx` (share-nothing, CORE-03).
    //
    // Three downstream cases, decided once slot 0 is occupied and
    // `link_target((belt, 0))` resolves:
    //   * downstream is a BELT    -> deliver into ITS tail slot via `admit_tail` IFF
    //     the tail is free; on a FULL tail RETAIN the head in slot 0 (bunch) and
    //     consume NO `route_seq` (a direct slot write carries no inbox seq). This is
    //     the BELT-07 belt->belt backpressure (11-04): a blocked/full tail belt makes
    //     its upstream bunch tile-by-tile from the head end (never drops, BELT-08).
    //   * downstream is a MACHINE -> deliver into its BOUNDED inbox stamping the SAME
    //     monotonic `route_seq` + waking it (11-02 parity) IFF that inbox can accept
    //     one more item; on a FULL inbox RETAIN the head in slot 0 (bunch) exactly as
    //     the belt->belt arm does on a full tail. A mechanical inbox is bounded by
    //     `admit::MECHANICAL_INBOX_CAP` (16, 71-CONTEXT D-01), so a belt feeding a
    //     machine that cannot accept PACKS BACKWARDS from the head instead of draining
    //     into an invisible queue (PILE-01). This reverses the v1.0 doctrine that stood
    //     here, which declared the machine inbox unbounded and machine-side
    //     backpressure out of scope; the fold doctrine BELOW - that the cross-node
    //     capacity read lives HERE and never inside `Belt::step` - is unchanged and is
    //     now more load-bearing, not less, because a third arm rests on it.
    //   * NO downstream link      -> RETAIN the head in slot 0 (the dangling-head
    //     bunch, the one behaviour change from v1.0's missing-link DROP, Pitfall 1).
    //
    // Belts are processed in the existing ascending-`NodeId` fold order (NOT
    // re-ordered). A freed downstream tail is visible to its upstream WITHIN one belt
    // the same tick (the deliver-then-admit slot invariant), but ACROSS a belt->belt
    // boundary a 1-tick junction stutter is possible — it is DETERMINISTIC and
    // conservation-safe, accepted for the MVP (RESEARCH Open Q1 / A3; the phased
    // advance-all/deliver-all/admit-all fold is deferred unless a fixture reveals an
    // unacceptable stutter).
    if matches!(core.state.node(id), Some(Node::Belt(_)))
        && let Some((dest, dest_port)) = core.state.link_target((id, 0))
    {
        // Peek (do NOT yet take) this belt's head — it must be retained if the
        // downstream cannot accept it (bunching).
        let head_occupied = matches!(
            core.state.node(id),
            Some(Node::Belt(b)) if crate::belt_slots::head(&b.slots).is_some()
        );
        if head_occupied {
            if matches!(core.state.node(dest), Some(Node::Belt(_))) {
                // belt -> belt: capacity-gated delivery into the downstream tail. The
                // tail-free read happens HERE in the fold (it sees both belts), never
                // in `StepCtx`. A full tail leaves the head in slot 0 (RETAIN = bunch)
                // and consumes no `route_seq`.
                let tail_free = matches!(
                    core.state.node(dest),
                    Some(Node::Belt(b)) if b.slots.last().is_some_and(Option::is_none)
                );
                if tail_free {
                    let item = match core.state.node_mut(id) {
                        Some(Node::Belt(b)) => crate::belt_slots::take_head(&mut b.slots),
                        _ => None,
                    };
                    if let Some(item) = item {
                        // The tail was confirmed free, so `admit_tail` always accepts
                        // (returns `None`); it is the certified primitive encoding the
                        // retain-never-drop rule.
                        if let Some(Node::Belt(db)) = core.state.node_mut(dest) {
                            let _ = crate::belt_slots::admit_tail(&mut db.slots, item);
                        }
                        // Schedule the downstream belt for the NEXT tick so it advances
                        // the just-admitted tail item AT MOST once (CR-01). Waking it
                        // NOW would re-enter the current fixpoint and double-step it
                        // (the dest belt re-wakes itself via AR-3 once it holds a slot,
                        // so it is already in the initial active set the next tick) —
                        // a belt is transport WITH LATENCY, never a 0-latency wire: at
                        // most one slot advance per tick, and at most one per
                        // `ticks_per_slot` ticks (SLOT-03). The upstream belt's own AR-3
                        // re-wake keeps IT scheduled while it still holds a retained
                        // head.
                        //
                        // LIKE ITS SIBLING GUARD ABOVE, THIS STAYS AT `now + 1`. It
                        // defends against re-entry within one tick's fixpoint, not
                        // against the advance interval; the absolute-tick gate inside
                        // `Belt::step` is what enforces the interval and is required
                        // wherever this line schedules.
                        //
                        // A downstream belt asleep (settled, plan 87-07) leaves the sleep set
                        // here, as at the generic drain: an item in its tail slot can open a
                        // gap behind its head, so it is no longer settled.
                        core.sched.unblock(dest);
                        core.sched.schedule_wake(dest, now + 1);
                    }
                }
                // else: downstream tail full -> RETAIN head in slot 0 (bunch).
            } else {
                // belt -> machine: CAPACITY-GATED delivery into the destination's
                // bounded inbox (PILE-01), stamping the SAME monotonic `route_seq` +
                // waking the dest (determinism parity with the generic routing path
                // above). The capacity read happens HERE in the fold, BEFORE the
                // `take_head`, in the same position `tail_free` sits in the sibling
                // belt->belt arm above - that arm is the proof that a plain
                // read-capacity-first is sufficient at this site and that no
                // peek/commit split of `take_head` is needed.
                let class =
                    crate::admit::admit_class(&core.state, crate::admit::Emitter::Node(id), dest, dest_port);
                if crate::admit::accepts_one(&core.state, class, dest, dest_port) {
                    let item = match core.state.node_mut(id) {
                        Some(Node::Belt(b)) => crate::belt_slots::take_head(&mut b.slots),
                        _ => None,
                    };
                    if let Some(item) = item {
                        // Capacity was confirmed one statement ago and nothing has
                        // mutated the destination inbox since, so `try_admit` always
                        // accepts here - the same reasoning (and the same `let _ =`)
                        // as the sibling arm's `admit_tail` on a confirmed-free tail.
                        let _ = crate::admit::try_admit(
                            &mut core.state,
                            crate::admit::Emitter::Node(id),
                            dest,
                            dest_port,
                            *route_seq,
                            item,
                        );
                        *route_seq += 1;
                        core.sched.wake_now(dest);
                    }
                }
                // else: destination inbox at MECHANICAL_INBOX_CAP -> RETAIN the head in
                // slot 0 (bunch), consuming NO `route_seq`. Nothing is taken and nothing
                // is lost; the belt packs backwards tile-by-tile from the head end and
                // its own AR-3 occupied-slot re-wake keeps it scheduled, exactly as the
                // sibling belt->belt arm's full-tail RETAIN does.
                //
                // THIS ARM IS A REAL MECHANISM AND MUST STAY ONE. Plan 71-03 adds a
                // gate near the TOP of `step_node` that can early-return a node whose
                // linked output cannot accept, and its ruling R-10a EXCLUDES
                // `Node::Belt` from that gate precisely so this block stays reachable.
                // Do not weaken this read on the assumption that the gate covers it.
            }
        }
    }

    // THE SETTLED BELT SLEEPS (phase 87, JAM-04, D-06, success criterion 3, plan 87-07).
    // `Belt::step` re-woke this belt at `now + 1` because it holds items (AR-3). If it is
    // SETTLED now, after its own step and after the head-delivery block above has had its
    // chance to move the head ([`belt_settled`]: head held, items packed from the head,
    // nothing admissible at the tail), that wake would only step it to no effect, on every
    // tick, forever: on a board jammed solid every belt holding items did exactly that
    // (P177B: 3.00 belt steps per tick, and a wake-wheel key that moved with the tick, so
    // two saves far apart differed in more than the tick counter). So the fold withdraws
    // the wake and puts the belt in the sleep set. What wakes it is what can change it: a
    // delivery into it (both delivery sites take it out of the set and schedule it), the
    // machine that frees its head's destination and the downstream belt whose tail slot
    // comes free (the consumer wake above, through the reverse link index), and an edit
    // tick (`Scheduler::wake_all_blocked_now`).
    //
    // A belt sleeps only once it is PACKED, so it still closes its last gap and holds it
    // (PILE-07): a belt with a gap behind its head is not settled and keeps stepping until
    // the gap is gone. The sleep is decided here, after the head-delivery block, and never
    // at the gate above, which a belt never meets ([`node_gated`], reason 2).
    if belt_settled(&core.state, id) {
        core.sched.cancel_wake(id, now + 1);
        core.sched.mark_blocked(id);
    }

    // 37-03: reverse-transport any `Effect::Reply` this node emitted THIS step back to
    // its caller, IN-SIM through the return wire + the ONE `route_seq` queue (WIRE-01).
    // The cable is chosen by the address the reply CARRIES. A no-op for the overwhelming
    // majority of nodes/steps (no reply emitted), so the idle hot path is untouched.
    route_replies(core, id, now, &commands[cmd_start..], route_seq);
}

/// The wire's single logical forward output port. A matured in-flight message is
/// pushed here; the EXISTING generic outbox drain in [`step_node`] then routes it
/// via `link_target((wire, WIRE_FORWARD_PORT))` — which the topology wires to
/// [`WireLink::to`] - stamping `route_seq` on the SAME `admit::try_admit` call
/// (`tick.rs` generic drain) belt delivery uses. ONE queue, ONE comparator: there
/// is deliberately NO wire-specific routing.
const WIRE_FORWARD_PORT: PortId = 0;

/// Step a [`Node::Wire`]: INGEST its inbox (multi-hop wire-to-wire deliveries),
/// ADVANCE + DELIVER matured in-flight messages via the ONE `route_seq` queue, and
/// SELF-REWAKE while messages remain in flight. Special-cased like the factory
/// (rather than driven through [`StepCtx`](crate::machine::StepCtx)) because it
/// iterates the taken-out `inbox` directly and borrows `sched` for the backlog
/// self-rewake (RESEARCH §1).
///
/// # The ONE comparator (WIRE-02) — do NOT invent a second ordering path
/// The semantic same-tick tie-break is `(tick, source node-id, source port,
/// sequence)`. Its RUNTIME encoding is `(tick, route_seq)`, where `route_seq`
/// (`tick.rs:95-102`) is a per-tick counter assigned STRICTLY in canonical fold
/// order: `(tick, fixpoint_iteration, ascending source NodeId, ascending source
/// port, FIFO drain)`. Because `route_seq` is incremented after EVERY push, no two
/// distinct items delivered in one tick share it — a STRICT TOTAL ORDER with no
/// ties. Wire delivery earns its `route_seq` at the SAME
/// `admit::try_admit(.., dest, dest_port, *route_seq, item)` call belt delivery uses,
/// so belt and wire items are indistinguishable to the comparator: literally ONE
/// queue. (Their admission CLASS differs - a wire emitter is exempt from the
/// mechanical bound, a belt emitter is not - but the seq they earn and the order they
/// earn it in do not.)
///
/// LOAD-BEARING fixpoint nuance (RESEARCH §1): the true runtime order is
/// `(tick, fixpoint_iteration, source NodeId, source port, drain_seq)`, NOT
/// `(tick, source NodeId, port, sequence)` when a fixpoint runs >1 iteration — a
/// lower-`NodeId` node stepped in iteration 2 gets a HIGHER `route_seq` than a
/// higher-`NodeId` node stepped in iteration 1. This weakens neither totality nor
/// determinism (the iteration structure is a deterministic function of topology,
/// independent of arrival order). Do NOT "simplify" the comparator into a
/// source-keyed sort that silently reorders across fixpoint iterations.
fn step_wire(
    now: u64,
    id: NodeId,
    link: &mut WireLink,
    inbox: &mut PortInbox,
    outbox: &mut PortOutbox,
    sched: &mut Scheduler,
) {
    // (1) INGEST — the multi-hop fix (a wire must transport messages DELIVERED to it,
    //     not only directly-admitted ones). Drain the wire's OWN inbox in
    //     ascending-port FIFO order — this IS `route_seq` order, the deterministic,
    //     arrival-order-independent fold order. Reading/draining the inbox does NOT
    //     change its serialized shape (no landmine). Each drained item is an opaque
    //     WireEnvelope forwarded from an upstream caller/wire.
    let ports: Vec<PortId> = inbox.ports_sorted().collect();
    for port in ports {
        while let Some((_seq, item)) = inbox.take(port) {
            // A malformed envelope (untrusted Item bytes, threat T-37-05b-ENVELOPE)
            // is DROPPED, never a panic.
            let Ok(env) = crate::wire::WireEnvelope::decode(&item) else {
                continue;
            };
            // Spend one hop of DEPTH budget on delivery INTO this wire.
            match crate::wire::step_budget(env.budget) {
                // DEPTH bound (TIME): budget exhausted -> a WireOverflow fault out the
                //     wire's FAULT_PORT (routed by the generic drain), never re-admitted.
                //     A deep chain / routing cycle trips here at a deterministic tick.
                None => {
                    let fault = Fault::command(id, FaultReason::WireOverflow, Vec::new());
                    outbox.push(FAULT_PORT, fault.encode());
                }
                Some(child_budget) => {
                    let stepped = crate::wire::WireEnvelope {
                        budget: child_budget,
                        ..env
                    };
                    // `entry_tick == now`: the just-ingested message does NOT mature
                    // this tick (>= 1 tick/hop), so it can never forward the SAME tick.
                    let msg = crate::wire::WireInFlight::from_envelope(stepped, now);
                    if crate::wire::admit(&mut link.in_flight, msg).is_some() {
                        // SPACE bound: at WIRE_INFLIGHT_CAP -> refuse and fault (never
                        //     grows past the cap).
                        let fault = Fault::command(id, FaultReason::WireOverflow, Vec::new());
                        outbox.push(FAULT_PORT, fault.encode());
                    }
                }
            }
        }
    }

    // (2) ADVANCE + DELIVER — pop EVERY matured message (`entry_tick + WIRE_HOP_TICKS
    //     <= now`) in FIFO order and re-forward it via the ONE `route_seq` queue;
    //     retain the rest in FIFO order. Messages ingested THIS tick (entry_tick ==
    //     now) are NOT matured (>= 1 tick/hop), so a message ingested at `now` can
    //     never mature+forward the SAME tick — and a second same-tick step finds an
    //     empty inbox and nothing matured (idempotent).
    let mut retained: std::collections::VecDeque<crate::wire::WireInFlight> =
        std::collections::VecDeque::new();
    while let Some(msg) = link.in_flight.pop_front() {
        if crate::wire::is_matured(&msg, now) {
            // NOTHING IS RECORDED HERE ANY MORE (Phase 72 plan 04). This is where the
            // deleted per-tick reply-binding map was written, with a last-writer-wins `insert`
            // that a long comment defended as deterministic. It WAS deterministic and it
            // was still wrong: the map was rebuilt empty every tick, so a reply emitted a
            // tick later than its request's hop found nothing and was dropped, and nothing
            // in the map said which cable a reply should take.
            //
            // `msg.to_envelope()` below already carries `correlation`, `return_addr` and
            // `budget` unchanged (`wire.rs`), so the forwarded bytes ARE the record of who
            // asked and what they had left. The handler reads them off the envelope it is
            // servicing and stamps them onto its `Effect::Reply`; `route_replies` reads
            // them off the reply. One source of truth, travelling with the message.
            outbox.push(WIRE_FORWARD_PORT, msg.to_envelope().encode());
        } else {
            retained.push_back(msg);
        }
    }
    link.in_flight = retained;

    // (3) SELF-REWAKE — while messages remain in flight, re-step next tick so they
    //     mature (mirrors the factory backlog rewake `tick.rs:511-523` and belt
    //     `tick.rs:588`). Omitting this strands in-flight messages (Pitfall 4).
    if !link.in_flight.is_empty() {
        sched.schedule_wake(id, now + 1);
    }
}

/// Reverse-transport every [`Effect::Reply`] a just-stepped `handler` emitted THIS step
/// back to its caller: the in-sim reply half of WIRE-01/WIRE-04 (37-03). Each reply
/// CARRIES the caller's `return_addr` and the request's remaining `budget` on itself
/// (`command.rs`, Phase 72 plan 04); this function builds a reply
/// [`WireInFlight`](crate::wire::WireInFlight) INHERITING that budget (never a fresh
/// one, so the whole forward+return round-trip is bounded by ONE budget, "deadline
/// bounds time") and admits it into the handler's RETURN WIRE. That wire then transports
/// the reply toward `return_addr` through the SAME `route_seq` queue belt items and
/// forward wire messages use: a first-class ordered delivery folded through the ONE
/// comparator, NOT a separately-logged row.
///
/// # Return-wire selection is ADDRESS-EXACT, and deliberately UNLIKE the entry side
/// The return wire is the live `Node::Wire` out of `handler` whose `to.node` equals the
/// reply's own `return_addr.0`
/// ([`GridState::return_wire_from`](crate::state::GridState::return_wire_from)). It asks
/// "which cable out of this node points at the caller I owe", which the old code could
/// not even ask: it called
/// [`wire_from_node`](crate::state::GridState::wire_from_node) and took the FIRST
/// ascending `NodeId` with no reference to who was owed the answer, so on a board where
/// two callers share one handler the second caller's reply rode the first caller's cable
/// (WINDOWS 124).
///
/// The ENTRY lookup (`manual_inject.rs`) stays node-only on purpose. See D-19 and the
/// comment at that site: the asymmetry is on the DESTINATION half, not the source half.
///
/// # Stateless forward path (WIRE-01) + spoof-safe (threat T-37-07-CORRELATION)
/// The forward routers still hold ZERO per-request state, and there is no scratch map
/// left to hold any: the address and budget travel on the message and then on the reply.
/// A reply naming a `return_addr` no cable out of this handler points at is DROPPED:
/// never panics, never routes to an arbitrary node, idempotent under replay.
fn route_replies(
    core: &mut Core,
    handler: NodeId,
    now: u64,
    new_commands: &[Command],
    route_seq: &mut u64,
) {
    for cmd in new_commands {
        let Effect::Reply { correlation, payload, return_addr, budget } = &cmd.effect else {
            continue;
        };
        let (return_addr, remaining_budget) = (*return_addr, *budget);
        // The RETURN WIRE: out of this handler AND pointing at the caller this reply is
        // owed to. No such cable -> the reply is dropped (never wakes a nonexistent node,
        // and never rides a cable pointing at somebody else).
        let Some(return_wire) = core.state.return_wire_from(handler, return_addr.0) else {
            continue;
        };
        let env = crate::wire::WireEnvelope {
            correlation: *correlation,
            return_addr,
            budget: remaining_budget,
            payload: payload.clone(),
        };
        // `entry_tick == now`: the reply matures one tick later, so a return wire can
        // never forward it the SAME tick it was admitted (>= 1 tick/hop) — the
        // load-bearing determinism gate the reply transport rests on.
        let msg = crate::wire::WireInFlight::from_envelope(env, now);
        let mut overflowed = false;
        if let Some(Node::Wire(link)) = core.state.node_mut(return_wire) {
            overflowed = crate::wire::admit(&mut link.in_flight, msg).is_some();
        }
        if overflowed {
            // SPACE bound (the in-flight cap): the return wire is at WIRE_INFLIGHT_CAP ->
            // a WireOverflow fault to the RETURN-ADDRESS node's FAULT_PORT + wake it (the
            // manual-inject admit-overflow precedent, `manual_inject.rs:186-201`) — never
            // grows past the cap. Guarded so a dangling return_addr node is never woken.
            let entry_node = return_addr.0;
            if core.state.node(entry_node).is_some() {
                let fault = Fault::command(entry_node, FaultReason::WireOverflow, Vec::new());
                // Through the ONE admission path (D-03) like every other core push.
                // FAULT_PORT classifies as `AdmitClass::Fault`, which clause 1 decides
                // BEFORE the emitter clause could look at `handler`; the bound that then
                // applies is `FAULT_QUEUE_CAP`, and past it the fault is DROPPED. Passing
                // the stepping node as the emitter is the honest value here: it is the
                // node whose reply produced the overflow.
                let _ = crate::admit::try_admit(
                    &mut core.state,
                    crate::admit::Emitter::Node(handler),
                    entry_node,
                    FAULT_PORT,
                    *route_seq,
                    fault.encode(),
                );
                *route_seq += 1;
                core.sched.wake_now(entry_node);
            }
        } else {
            // Admitted: wake the return wire so the fold transports the reply back.
            core.sched.wake_now(return_wire);
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::core::Core;
    use crate::event::{Event, EventPayload, LogHeader, SCHEMA_VERSION};
    use crate::ids::{Item, NodeId};

    fn core_with_seed(seed: u64) -> Core {
        Core::genesis(LogHeader {
            schema_version: SCHEMA_VERSION,
            seed,
        })
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

    /// The in-crate traverse assertion.
    ///
    /// **IT IS SELF-AGREEING AND IS NOT THE PHASE'S VALUE GATE (SLOT-03/SLOT-04).**
    /// The tick counts below are DERIVED from `DEFAULT_TICKS_PER_SLOT`, so they agree
    /// with it at every value and this case can never tell a reader that the shipped
    /// interval is right. It is the same treatment plan 62-03 gave `tests/belt.rs` and
    /// `tests/fault.rs`, and the same reason Phase 60 refused to cite its
    /// `SLOTS_PER_TILE`-derived predecessor as a gate. The admissible hand-pins are
    /// `belt_slots.rs`'s `default_ticks_per_slot_pin` (filled by plan 62-09) and the
    /// hand-pinned window rates in `tests/belt_per_tile.rs`. Do not cite a green run
    /// of this case as evidence about the interval.
    ///
    /// What it DOES gate: the shape of the fold's transport path end to end (feed is
    /// not instant, the item is absent for the whole traverse, it is delivered exactly
    /// once, and the belt drains behind it).
    #[test]
    fn tick_inject_travels_slot_belt_and_arrives_at_traverse_time() {
        // source -> belt(2 tiles) -> collector(source: ignores its inbox so the item
        // rests there). A 2-tile belt has SLOTS_PER_TILE*2 slots.
        //
        // Feeding a belt is transport WITH LATENCY, NOT a 0-latency instant-wire
        // (CR-01): at the FIRE tick the source routes the item into the belt's INBOX
        // and `schedule_wake`s the belt for the NEXT tick, so the belt admits the item
        // to its tail at tick 1 (not tick 0). From that admit the item needs exactly
        // `SLOTS_PER_TILE*2 - 1` ADVANCES to reach the head, where the fold delivers
        // it. Advances are not ticks (SLOT-03): the belt advances once every
        // `ticks_per_slot` ticks, so the wait in TICKS is that advance count times the
        // interval, plus the alignment wait for the first due tick after the admit.
        // Head delivery is ungated, so there is no further whole interval on top. It is
        // delivered EXACTLY ONCE (conservation).
        use crate::belt_slots::{DEFAULT_TICKS_PER_SLOT, SLOTS_PER_TILE, slot_count};
        let mut core = core_with_seed(1);
        let s = core.state.add_source();
        let b = core.state.add_belt(2);
        let c = core.state.add_source();
        core.state.link((s, 0), (b, 0));
        core.state.link((b, 0), (c, 0));

        let m = slot_count(2);
        // Tick 0: fire one item — routed into the belt's inbox (NOT yet admitted).
        core.advance(&[fire(s, 1, 0, Item(vec![0x99]))]);
        assert!(
            matches!(core.state.node(b), Some(Node::Belt(belt)) if belt.slots.iter().all(Option::is_none)),
            "belt not yet admitted at the fire tick (feed is not instant)"
        );
        // Tick 1: the belt's scheduled wake fires; it admits the item to its tail.
        core.advance(&[]);
        assert!(
            matches!(core.state.node(b), Some(Node::Belt(belt)) if belt.slots[m - 1] == Some(Item(vec![0x99]))),
            "item admitted to the belt tail at tick 1"
        );

        // ADVANCES and INTERVAL are written as separate names, because they are
        // different units and the pre-SLOT-03 form (a single `traverse` that was both)
        // could not keep them apart.
        let advances = u64::from(SLOTS_PER_TILE * 2 - 1);
        let interval = u64::from(DEFAULT_TICKS_PER_SLOT.get());
        // The item is absent for the first `(advances - 1) * interval` ticks after the
        // admit: it cannot possibly have made its last advance yet. At an interval of
        // one this collapses to `advances`, the exact tick the pre-SLOT-03 assertion
        // pinned, so this is that statement widened by the alignment and by nothing
        // else. It is NOT widened by a further whole interval, which would be true and
        // would hide a real regression (plan 62-03 measured the tighter bound).
        for _ in 1..((advances - 1) * interval + 1) {
            assert!(
                core.state.inbox_of(c).is_some_and(|i| i.is_empty()),
                "absent before the traverse-time (at tick {})",
                core.tick
            );
            core.advance(&[]);
        }
        // The delivering advance lands it in the collector exactly once, within the
        // alignment allowance of `interval` ticks.
        let mut arrived = false;
        for _ in 0..interval {
            core.advance(&[]);
            if core.state.inbox_of(c).is_some_and(|i| !i.is_empty()) {
                arrived = true;
                break;
            }
        }
        assert!(arrived, "arrived within the alignment allowance of the traverse-time");
        let mut c_inbox = core.state.inbox_of(c).cloned().expect("collector inbox");
        let (_seq, item) = c_inbox.take(0).expect("collector has the item");
        assert_eq!(item, Item(vec![0x99]), "arrives at exactly the traverse-time");
        assert_eq!(c_inbox.take(0), None, "delivered exactly once (conservation)");
        // The belt is now empty (the item left its slots).
        match core.state.node(b) {
            Some(Node::Belt(belt)) => {
                assert_eq!(belt.slots.len(), m);
                assert!(belt.slots.iter().all(Option::is_none), "belt drained after delivery");
            }
            other => panic!("expected a Belt, got {other:?}"),
        }
    }

    #[test]
    fn tick_belt_with_no_downstream_retains_its_head_bunching() {
        // BELT-07 dangling-head bunch (RESEARCH Pitfall 1): a belt whose head has NO
        // downstream link RETAINS its head item across ticks — it does NOT drop (the
        // one behaviour change from v1.0's missing-link DROP). Conservation holds: the
        // item rides the belt forever rather than vanishing.
        let mut core = core_with_seed(1);
        let s = core.state.add_source();
        let b = core.state.add_belt(1);
        core.state.link((s, 0), (b, 0));
        // NB: no link from (b, 0) — the belt head is dangling.

        core.advance(&[fire(s, 1, 0, Item(vec![0x77]))]);
        // Advance well past the traverse-time; the head must remain occupied. This is a
        // BUDGET, so it is DERIVED from the interval and stretches with it (SLOT-04,
        // plan 62-03's rule: budgets are derived because headroom is exactly what a
        // number that re-derives at every value is for; assertions are hand-pinned
        // because a number that re-derives is a tautology). It read a flat `10` and
        // under-ran from an interval of 3 upward, failing as a WRONG-LOOKING BUNCH
        // rather than as a budget, which is the silent failure mode this rule exists
        // to kill.
        for _ in 0..(10 * u64::from(crate::belt_slots::DEFAULT_TICKS_PER_SLOT.get())) {
            core.advance(&[]);
        }
        match core.state.node(b) {
            Some(Node::Belt(belt)) => {
                assert_eq!(belt.slots[0], Some(Item(vec![0x77])), "dangling head retained (bunched)");
                let resident = belt.slots.iter().filter(|s| s.is_some()).count();
                assert_eq!(resident, 1, "exactly one item conserved on the belt, none dropped");
            }
            other => panic!("expected a Belt, got {other:?}"),
        }
    }

    #[test]
    fn tick_idle_tick_steps_zero_machines() {
        // A grid with nodes but nothing woken steps zero machines on an idle
        // tick — the active-set guarantee (CORE-07). We assert the would-step
        // oracle reads zero, then that the tick still advances cleanly.
        let mut core = core_with_seed(1);
        let _s = core.state.add_source();
        let _b = core.state.add_belt(5);

        let t = core.tick;
        assert_eq!(
            core.sched.active_count_at(t),
            0,
            "nothing woken => zero would-step on an idle tick"
        );
        let cmds = core.advance(&[]);
        assert!(cmds.is_empty(), "idle tick emits no commands");
        assert_eq!(core.tick, t + 1, "idle tick still advances time");
    }

    #[test]
    fn tick_belt_chain_transports_across_a_belt_to_belt_boundary() {
        // source -> belt(1) -> belt(1) -> collector. A single fire at tick 0 rides the
        // first slot belt, crosses the belt->belt boundary (the head of belt 1 is
        // delivered into belt 2's inbox, admitted to belt 2's tail), then rides belt 2
        // to the collector. It arrives exactly once (conservation) after enough ticks.
        let mut core = core_with_seed(1);
        let s = core.state.add_source();
        let b1 = core.state.add_belt(1);
        let b2 = core.state.add_belt(1);
        let c = core.state.add_source();
        core.state.link((s, 0), (b1, 0));
        core.state.link((b1, 0), (b2, 0));
        core.state.link((b2, 0), (c, 0));

        core.advance(&[fire(s, 1, 0, Item(vec![0x77]))]);
        // Drive enough ticks for the two-belt traverse (plus the boundary stutter). A
        // DERIVED BUDGET (SLOT-04): the flat `20` under-ran from an interval of 5
        // upward and the test then failed on `delivered`, saying nothing about the
        // boundary it exists to prove.
        let mut delivered: Option<Item> = None;
        for _ in 0..(20 * u64::from(crate::belt_slots::DEFAULT_TICKS_PER_SLOT.get())) {
            core.advance(&[]);
            if let Some(inbox) = core.state.inbox_of(c) {
                let mut clone = inbox.clone();
                if let Some((_seq, item)) = clone.take(0) {
                    delivered = Some(item);
                    break;
                }
            }
        }
        assert_eq!(delivered, Some(Item(vec![0x77])), "item crossed both belts to the collector");
    }

    /// Drain a node's inbox on port 0 (cloned, non-destructive to the live core) and
    /// return the item count — a test-only conservation counter.
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

    /// Count the items a node is holding as `OutputRefused` fault payloads on its
    /// [`FAULT_PORT`] - the third place an item can rest since Phase 71 bounded the
    /// mechanical inbox.
    ///
    /// The fold's generic outbox drain has nowhere to RETAIN a refused item (its outbox
    /// is a `std::mem::take`), so it mints a `FaultReason::OutputRefused` carrying the
    /// item's bytes as the payload (ruling R-4). A conservation count that looks only at
    /// belt slots and port-0 inboxes therefore under-counts by exactly the number of
    /// refusals, and would read a correct refusal as a LOSS. Reads through
    /// `PortInbox::items_on`, which is non-destructive.
    fn refused_on_fault_port(core: &Core, id: NodeId) -> u64 {
        match core.state.inbox_of(id) {
            Some(inbox) => inbox
                .items_on(crate::fault::FAULT_PORT)
                .filter(|item| {
                    matches!(
                        crate::fault::Fault::decode(item),
                        Ok(f) if f.reason == crate::fault::FaultReason::OutputRefused
                    )
                })
                .count() as u64,
            None => 0,
        }
    }

    /// How many items are resting in a Source's `pending` deque - the FOURTH resting
    /// place, and the one plan 71-03 created.
    ///
    /// Before the PILE-02 gate a source drained its whole `pending` every step, so a
    /// conservation sum could ignore it. Under the gate a source whose output belt is
    /// full is not stepped at all and `pending` holds. `SOURCE_PENDING_CAP` is what
    /// stops it holding without limit (PILE-04); this is what stops a test reading a
    /// held item as a lost one. Zero for any node that is not a Source.
    fn source_pending(core: &Core, id: NodeId) -> u64 {
        match core.state.node(id) {
            Some(Node::Source(src)) => src.pending.len() as u64,
            _ => 0,
        }
    }

    /// Count occupied slots on a Belt node.
    fn slot_resident(core: &Core, id: NodeId) -> u64 {
        match core.state.node(id) {
            Some(Node::Belt(b)) => b.slots.iter().filter(|s| s.is_some()).count() as u64,
            other => panic!("expected a Belt, got {other:?}"),
        }
    }

    #[test]
    fn tick_belt_to_belt_bunches_on_full_downstream_tail() {
        // BELT-07 belt->belt backpressure (RESEARCH Pitfall 1 / Pattern 3): beltA feeds
        // beltB whose head is DANGLING (a permanently-stalled tail). Once beltB
        // saturates, beltA can no longer deliver its head into beltB's FULL tail, so
        // beltA RETAINS its head (slot 0 stays occupied) and bunches tile-by-tile from
        // the head end. Nothing is dropped (conservation). This is the one true
        // backpressure path — the capacity decision lives in the FOLD (step_node), not
        // in the share-nothing StepCtx.
        use crate::belt_slots::slot_count;
        let mut core = core_with_seed(1);
        let s = core.state.add_source();
        let a = core.state.add_belt(2);
        let b = core.state.add_belt(2);
        core.state.link((s, 0), (a, 0));
        core.state.link((a, 0), (b, 0));
        // NB: no link from (b, 0) — beltB's head is dangling (the stalled tail).

        // Fire enough items to overflow BOTH belts (each holds slot_count(2)=6 slots).
        let n = slot_count(2) as u64 * 2 + 4;
        let fires: Vec<Event> = (0..n)
            .map(|i| fire(s, i + 1, 0, Item(vec![(i & 0xFF) as u8])))
            .collect();
        // THE SOURCE NOW REFUSES PAST `SOURCE_PENDING_CAP` (plan 71-03, PILE-04), so
        // "fired" and "admitted" are no longer the same number and conservation is over
        // what the board ACCEPTED. `admitted` is MEASURED from `pending` growing, not
        // derived from the constant: a test that recomputed the bound's own predicate
        // would agree with a broken bound as readily as with a correct one.
        //
        // Admitting by hand and then folding an EMPTY tick is exactly what
        // `core.advance(&fires)` does - `tick` admits every event in the batch before
        // the fixpoint runs (phase order: edits, admit, take_due, fixpoint) - split only
        // so the acceptance is observable between the two halves.
        let mut admitted = 0u64;
        for ev in &fires {
            let before = source_pending(&core, s);
            crate::manual_inject::admit(&mut core.state, &mut core.sched, ev, core.tick);
            admitted += source_pending(&core, s) - before;
        }
        assert!(
            admitted < n,
            "non-vacuity: this burst is wider than SOURCE_PENDING_CAP, so the source \
             must have refused some of it ({admitted} admitted of {n} fired)"
        );
        core.advance(&[]);
        // Drive to steady state (both belts saturated, backpressure stable). A DERIVED
        // BUDGET (SLOT-04): saturating two belts takes proportionally longer at a
        // longer interval, and an under-run leaves beltB unsaturated, which reads as
        // "backpressure did not happen" rather than as "the test did not wait".
        let interval = u64::from(crate::belt_slots::DEFAULT_TICKS_PER_SLOT.get());
        for _ in 0..((slot_count(2) as u64 * 4 + 20) * interval) {
            core.advance(&[]);
        }

        let a_slots = match core.state.node(a) {
            Some(Node::Belt(belt)) => belt.slots.clone(),
            o => panic!("expected beltA, got {o:?}"),
        };
        let b_slots = match core.state.node(b) {
            Some(Node::Belt(belt)) => belt.slots.clone(),
            o => panic!("expected beltB, got {o:?}"),
        };
        // beltB saturated (its dangling head can never deliver).
        assert!(
            b_slots.iter().all(Option::is_some),
            "beltB saturates against its dangling head"
        );
        // beltA RETAINS its head — the belt->belt backpressure bunch.
        assert!(
            a_slots[0].is_some(),
            "beltA head retained (belt->belt backpressure: downstream tail full)"
        );
        // beltA's occupied portion is a head-anchored, gap-free prefix (it bunched
        // tile-by-tile from the blocked head end).
        let occ = a_slots.iter().filter(|x| x.is_some()).count();
        assert!(occ > 0, "beltA holds retained items");
        for (i, slot) in a_slots.iter().enumerate() {
            if i < occ {
                assert!(slot.is_some(), "beltA prefix [0..{occ}) is gap-free (head-anchored bunch)");
            } else {
                assert!(slot.is_none(), "beltA has no items past the bunched prefix");
            }
        }
        // Conservation: nothing reached a downstream (delivered == 0), so every fired
        // item is still accounted for. None created, none lost.
        //
        // THE THIRD RESTING PLACE (Phase 71). Before the mechanical inbox was bounded,
        // "resident" meant belt slots plus belt inboxes and that was the whole grid.
        // Now beltA's own staging inbox is bounded at `MECHANICAL_INBOX_CAP` (PILE-03),
        // so the source's outbox drain cannot place every fired item: the surplus is
        // refused and rides as `FaultReason::OutputRefused` fault payloads on the
        // SOURCE's FAULT_PORT (ruling R-4, the generic-drain refusal shape). Counting
        // only the first two places would read a correct refusal as a LOSS. Plan 71-03's
        // gate stops the source from draining into a full inbox at all, at which point
        // this term goes to zero on this board; the term stays here because the sum has
        // to be over every place an item can be, not over the places it used to be.
        //
        // AND THE FOURTH RESTING PLACE (plan 71-03). The source is now gated by
        // `outputs_blocked` and takes ONE item per pass, so items can still be sitting
        // in its `pending` deque at quiescence. The sum is over every place an item can
        // be, not over the places it used to be.
        let refused = refused_on_fault_port(&core, s);
        let resident = source_pending(&core, s)
            + slot_resident(&core, a)
            + slot_resident(&core, b)
            + inbox_count(&core, a)
            + inbox_count(&core, b);
        assert_eq!(
            resident + refused,
            admitted,
            "delivered(0) + resident({resident}) + refused({refused}) == admitted \
             ({admitted}) (no loss, no creation)"
        );
    }

    #[test]
    fn tick_belt_to_machine_bunches_at_the_cap() {
        // PILE-01. A belt whose head faces a machine that cannot accept RETAINS its
        // head in slot 0 and packs backwards, so a finite burst leaves the belt FULL
        // with nothing lost.
        //
        // THE BASELINE THIS INVERTS, measured rather than asserted. This test replaces
        // the belt-to-machine control that stood here green on exactly this topology -
        // a source, a two-tile belt and a port-less `add_source()` collector that never
        // drains - and asserted `slot_resident(belt) == 0` with the message
        // "belt->machine drains, never bunches (unbounded inbox always accepts)". On
        // this topology a finite burst left the belt at 0 of 8 slots, pattern all-empty.
        // That is the measured baseline, re-measured against an unbounded build while
        // writing this case; every clause below is its inverse.
        //
        // THE OLD CASE WAS DELETED RATHER THAN EDITED, and the reason belongs here
        // rather than in a commit message: its NAME asserted the claim ("never
        // bunches"), so an edited body under that name would leave a test whose name
        // and body disagree, and the name is what a later reader greps for.
        use crate::admit::MECHANICAL_INBOX_CAP;
        use crate::belt_slots::slot_count;

        /// The collector's inbox depth on port 0. Read through `PortInbox::len_on`,
        /// non-destructively, so it can be sampled every tick.
        fn depth_on_0(core: &Core, id: NodeId) -> usize {
            core.state.inbox_of(id).map_or(0, |i| i.len_on(0))
        }

        let mut core = core_with_seed(1);
        let s = core.state.add_source();
        let a = core.state.add_belt(2);
        // The collector is a port-less `add_source()`: it ignores its inbox entirely,
        // so it is a machine that never drains. Port-less means `inbox_class` reads its
        // port 0 as Mechanical (clause 4), which is the reading PILE-01 depends on for
        // every core-built collector in the corpus.
        let c = core.state.add_source();
        core.state.link((s, 0), (a, 0));
        core.state.link((a, 0), (c, 0));

        let interval = u64::from(crate::belt_slots::DEFAULT_TICKS_PER_SLOT.get());
        // A FINITE burst, so quiescence is reachable and this test cannot hang. Sized
        // to exactly fill both resting places downstream of the source: the collector's
        // bounded inbox (MECHANICAL_INBOX_CAP) plus the belt's own slots.
        let n = slot_count(2) as u64 + MECHANICAL_INBOX_CAP as u64;

        // PACED INJECTION, one item every `interval` ticks - the belt's own admit rate.
        // Not a single-tick burst: `ManualInject::step` drains its whole `pending` in
        // ONE step, so a single-tick burst of n would meet the belt's OWN staging inbox
        // bound (PILE-03) at the source's outbox drain and fault the surplus away before
        // it ever reached the belt. That is correct behaviour, and it is plan 71-03's
        // subject; it is not what PILE-01 is about, and letting it happen here would
        // measure the wrong refusal.
        let mut peak = 0usize;
        for i in 0..n {
            let ev = fire(s, i + 1, core.tick, Item(vec![(i & 0xFF) as u8]));
            core.advance(&[ev]);
            peak = peak.max(depth_on_0(&core, c));
            for _ in 1..interval {
                core.advance(&[]);
                peak = peak.max(depth_on_0(&core, c));
            }
        }
        // Run to quiescence. A DERIVED BUDGET (SLOT-04): draining a belt at one slot
        // every `ticks_per_slot` ticks takes proportionally longer, so the budget scales
        // with the interval. Every tick is sampled, which is what clause (c) needs.
        for _ in 0..((n + slot_count(2) as u64 * 4 + 40) * interval) {
            core.advance(&[]);
            peak = peak.max(depth_on_0(&core, c));
        }

        let a_slots = match core.state.node(a) {
            Some(Node::Belt(belt)) => belt.slots.clone(),
            o => panic!("expected a Belt, got {o:?}"),
        };

        // (a) The belt is FULL: slot_count(2) of slot_count(2), where the deleted test
        //     measured 0 of slot_count(2).
        assert_eq!(
            slot_resident(&core, a),
            slot_count(2) as u64,
            "the belt packs full against a machine that cannot accept ({} of {})",
            slot_resident(&core, a),
            slot_count(2)
        );
        // (b) The tile touching the machine is specifically the occupied one: the head
        //     was RETAINED in slot 0, not merely "some items are somewhere".
        assert!(
            a_slots[0].is_some(),
            "the head is retained in slot 0 (the tile touching the machine)"
        );
        // (c) The machine's inbox sits at the cap EXACTLY, and a per-tick sample across
        //     the whole run shows it never exceeded the cap at ANY tick. An end-state
        //     read alone cannot tell "capped at 16" from "overshot to 24 and drained
        //     back to 16", and the overshoot is exactly what a capacity read placed
        //     AFTER the take would produce.
        assert_eq!(
            depth_on_0(&core, c),
            MECHANICAL_INBOX_CAP,
            "the machine inbox rests at MECHANICAL_INBOX_CAP"
        );
        assert_eq!(
            peak, MECHANICAL_INBOX_CAP,
            "the machine inbox never exceeded MECHANICAL_INBOX_CAP at any tick (peak {peak})"
        );
        // (d) Conservation. `delivered` is the collector's inbox length: the collector
        //     never drains, so nothing it received has gone anywhere else, and the term
        //     is not dead. `refused` must be ZERO here - the paced injection means the
        //     source never met the belt's staging bound, so no item was turned into an
        //     OutputRefused fault payload, and the only refusal in this test is the
        //     belt-head RETAIN, which loses nothing by construction.
        let delivered = depth_on_0(&core, c) as u64;
        let resident = slot_resident(&core, a);
        let staged = inbox_count(&core, a);
        assert_eq!(
            refused_on_fault_port(&core, s),
            0,
            "no item was refused at the source's outbox drain (paced injection)"
        );
        assert_eq!(
            delivered + resident + staged,
            n,
            "delivered({delivered}) + resident({resident}) + inbox({staged}) == admitted({n}): nothing lost, nothing created"
        );
    }

    #[test]
    fn tick_belt_staging_inbox_is_bounded_and_refuses_its_feeder() {
        // PILE-03. A belt's OWN staging inbox is bounded by the SAME constant and the
        // SAME helper as a machine inbox, because they are literally the same
        // `PortInbox` in the same `GridState.inboxes` map (ruling R-1). One constant for
        // both is the point: two names would be a mirrored constant a later edit could
        // move on one side only, with every test staying green.
        //
        // Since phase 87 (JAM-04, D-06) the feeder this bound refuses SLEEPS: the gated
        // Tee and Source leave the active set, and the slow belt wakes them through the
        // consumer wake each time it takes an item off its staging inbox. With that wake
        // removed the board never restarts and this test goes red (87-EVIDENCE `## Plan
        // 87-06`, `mut-consumer.out`).
        //
        // Board: a source injecting every tick, a two-tile belt at the default pace, a
        // Tee, and a four-tile belt at the SLOWEST pace the command layer will write
        // (20, the top of its inclusive 2..=20 range). The slow belt's head is dangling,
        // so it saturates and its staging inbox is where the backlog actually lands -
        // `Belt::step` gates only `advance_slots` on the interval, and admits at most one
        // inbox item per tick when the tail is free, so a slow belt reads its inbox far
        // more slowly than a fast feeder fills it.
        //
        // WHAT THIS TEST DELIBERATELY DOES NOT ASSERT: that the Tee stops consuming its
        // own inbox once its output is blocked. That is PILE-02 and plan 71-03 owns it.
        // Until then the Tee keeps draining and its refused outputs become
        // `OutputRefused` faults, which is why the conservation sum below counts them.
        // The absence is a boundary, not an oversight.
        use crate::admit::MECHANICAL_INBOX_CAP;
        use crate::belt_slots::slot_count;
        use std::num::NonZeroU32;

        fn depth_on_0(core: &Core, id: NodeId) -> usize {
            core.state.inbox_of(id).map_or(0, |i| i.len_on(0))
        }

        let mut core = core_with_seed(1);
        let s = core.state.add_source();
        let fast = core.state.add_belt(2);
        let t = core.state.add_tee(1);
        let slow = core.state.add_belt(4);
        core.state.link((s, 0), (fast, 0));
        core.state.link((fast, 0), (t, 0));
        core.state.link((t, 0), (slow, 0));
        // NB: no link from (slow, 0) - the slow belt's head is dangling, so it saturates
        // and can never hand anything on.
        const SLOWEST: u32 = 20;
        match core.state.node_mut(slow) {
            Some(Node::Belt(b)) => {
                b.ticks_per_slot = NonZeroU32::new(SLOWEST).expect("20 is non-zero")
            }
            o => panic!("expected a Belt, got {o:?}"),
        }

        // Inject one item per tick for long enough to fill every resting place on the
        // board with room to spare, then stop. FINITE, so quiescence is reachable.
        //
        // The size is DERIVED, not guessed: the slow belt admits at most one inbox item
        // per due tick, so it needs `slot_count(4) * SLOWEST` ticks just to pack its own
        // slots, and only AFTER that does its staging inbox stop draining and start
        // resting at the bound. An injection window shorter than that empties upstream
        // first and leaves the inbox mid-drain, which reads as "the bound is 9" - a
        // measurement of the window, not of the bound.
        //
        // `admitted` is MEASURED rather than assumed equal to `n`: since plan 71-03 the
        // source refuses past `SOURCE_PENDING_CAP` (PILE-04), and under the PILE-02 gate
        // a source whose belt is full is not stepped, so on this board most of the
        // window is refused at the top of the chain. The admission is read off `pending`
        // GROWING, never recomputed from the bound's own predicate. Admitting by hand and
        // then folding an empty tick is what `core.advance(&[ev])` does internally; the
        // split just makes the acceptance observable.
        let n: u64 = slot_count(4) as u64 * u64::from(SLOWEST) * 2 + 200;
        let mut admitted = 0u64;
        for i in 0..n {
            let ev = fire(s, i + 1, core.tick, Item(vec![(i & 0xFF) as u8]));
            let before = source_pending(&core, s);
            crate::manual_inject::admit(&mut core.state, &mut core.sched, &ev, core.tick);
            admitted += source_pending(&core, s) - before;
            core.advance(&[]);
        }
        assert!(
            admitted < n,
            "non-vacuity: a jammed board must refuse some of a {n}-item window at the \
             source bound ({admitted} admitted)"
        );
        // Advance to quiescence. The slow belt needs `slot_count(4) * SLOWEST` ticks
        // just to fill its slots, so the budget is derived from the belt's own pace
        // rather than guessed.
        for _ in 0..(slot_count(4) as u64 * u64::from(SLOWEST) * 3 + 500) {
            core.advance(&[]);
        }

        // THE BOUND. The slow belt's own staging inbox rests at exactly the same
        // constant a machine inbox rests at.
        let staged = depth_on_0(&core, slow);
        assert_eq!(
            staged, MECHANICAL_INBOX_CAP,
            "the belt's own staging inbox is bounded at MECHANICAL_INBOX_CAP (got {staged})"
        );
        assert_eq!(
            slot_resident(&core, slow),
            slot_count(4) as u64,
            "the slow belt itself saturated against its dangling head"
        );

        // Conservation at the first reading. Every item is in one of six places: the
        // source's pending queue, either belt's slots, either belt's staging inbox, the
        // Tee's inbox, or an `OutputRefused` fault payload on whichever node's push the
        // cap refused.
        let total = |core: &Core| -> u64 {
            source_pending(core, s)
                + slot_resident(core, fast)
                + slot_resident(core, slow)
                + inbox_count(core, fast)
                + inbox_count(core, slow)
                + inbox_count(core, t)
                + refused_on_fault_port(core, s)
                + refused_on_fault_port(core, t)
        };
        assert_eq!(
            total(&core),
            admitted,
            "nothing lost, nothing created at quiescence"
        );

        // A BOUND, NOT A COINCIDENCE. 2000 further ticks with no new injection: the
        // staging inbox does not grow by one item, and nothing is lost while it holds.
        for _ in 0..2000u64 {
            core.advance(&[]);
        }
        assert_eq!(
            depth_on_0(&core, slow),
            staged,
            "the staging inbox does not grow across a further 2000 ticks"
        );
        assert_eq!(
            total(&core),
            admitted,
            "nothing lost, nothing created across the further 2000 ticks"
        );
    }
    // =========================================================================
    // PLAN 71-03: the PILE-02 gate, the jam it forms, the clear, and the bound.
    //
    // Every board below runs to a STATED TICK COUNT rather than to an unbounded
    // quiescence loop. That is not a style choice: under ruling R-12 a gated node
    // re-wakes at `now + 1` for as long as its output is blocked, and a belt re-wakes
    // itself while any slot is occupied, so A PERMANENTLY PACKED BOARD NEVER IDLES and
    // a quiescence loop would hang. That cost is ruling R-14's subject and it was
    // accepted when the requirement was written: producing packed boards is the whole
    // point of the phase.
    // =========================================================================

    /// The slowest `ticks_per_slot` the command layer will write (the top of its
    /// inclusive 2..=20 range). The jammed arm's belt B runs at this; the control arm's
    /// runs at `DEFAULT_TICKS_PER_SLOT`.
    const PILE02_SLOWEST: u32 = 20;

    /// One injection offered every this many ticks. DERIVED from the belt, not picked:
    /// a belt admits at most one inbox item per tick and only when its tail is free,
    /// and its tail frees once per `ticks_per_slot` ticks, so a default-pace belt
    /// carries one item per 2 ticks. Offering one every 4 runs the chain at HALF its
    /// carrying rate, which is what lets the CONTROL arm keep up and makes the jammed
    /// arm's backlog attributable to belt B's pace rather than to the feed rate.
    const PILE02_INJECT_EVERY: u64 = 4;

    /// The PILE-02 board: source -> beltA(`a_tiles`, default pace) -> Tee ->
    /// beltB(`b_tiles` at `b_pace`) -> Sink.
    ///
    /// The jammed arm and the negative control differ in EXACTLY ONE argument,
    /// `b_pace`. Two separately-authored boards could differ in something nobody
    /// noticed; one builder with one parameter cannot.
    ///
    /// The terminal is a real Sink and that is load-bearing for ruling R-13: a Sink
    /// with no fault belt has NO outgoing links, so `outputs_blocked` finds nothing to
    /// block on and it keeps consuming. The jam therefore forms at the TEE, which is
    /// the machine a user would point at, rather than at the terminal. That is the
    /// Sink ruling demonstrated on a board rather than asserted in a comment.
    fn pile02_board(
        seed: u64,
        a_tiles: u32,
        b_tiles: u32,
        b_pace: u32,
    ) -> (Core, PileBoard) {
        use std::num::NonZeroU32;
        let mut core = core_with_seed(seed);
        let s = core.state.add_source();
        let a = core.state.add_belt(a_tiles);
        let t = core.state.add_tee(1);
        let b = core.state.add_belt(b_tiles);
        let sink = core.state.add_sink(crate::state::SinkTemplate::Debug, 100);
        core.state.link((s, 0), (a, 0));
        core.state.link((a, 0), (t, 0));
        core.state.link((t, 0), (b, 0));
        core.state.link((b, 0), (sink, 0));
        set_pace(&mut core, b, b_pace);
        let _ = NonZeroU32::new(1);
        (core, PileBoard { s, a, t, b, sink })
    }

    /// The five node ids of a [`pile02_board`], named rather than positional.
    struct PileBoard {
        s: NodeId,
        a: NodeId,
        t: NodeId,
        b: NodeId,
        #[allow(dead_code)]
        sink: NodeId,
    }

    fn set_pace(core: &mut Core, belt: NodeId, pace: u32) {
        use std::num::NonZeroU32;
        match core.state.node_mut(belt) {
            Some(Node::Belt(b)) => {
                b.ticks_per_slot = NonZeroU32::new(pace).expect("pace is non-zero")
            }
            o => panic!("expected a Belt, got {o:?}"),
        }
    }

    /// Fold ONE tick, offering an injection when `offer` is true.
    ///
    /// Returns whether the source ACCEPTED the offer, MEASURED from `pending` growing
    /// rather than recomputed from `SOURCE_PENDING_CAP`'s own predicate. Admitting by
    /// hand and then folding an empty tick is exactly what `core.advance(&[ev])` does
    /// internally (phase order: edits, admit, take_due, fixpoint); the split only makes
    /// the acceptance observable between the two halves.
    fn pile02_tick(core: &mut Core, s: NodeId, seq: &mut u64, offer: bool) -> bool {
        let mut accepted = false;
        if offer {
            let ev = fire(s, *seq, core.tick, Item(vec![(*seq & 0xFF) as u8]));
            *seq += 1;
            let before = source_pending(core, s);
            crate::manual_inject::admit(&mut core.state, &mut core.sched, &ev, core.tick);
            accepted = source_pending(core, s) > before;
        }
        core.advance(&[]);
        accepted
    }

    /// The occupied-slot pattern of a belt, slot 0 (the deliver end) first.
    fn slot_pattern(core: &Core, id: NodeId) -> Vec<bool> {
        match core.state.node(id) {
            Some(Node::Belt(b)) => b.slots.iter().map(Option::is_some).collect(),
            o => panic!("expected a Belt, got {o:?}"),
        }
    }

    /// The length of the gap-free occupied run anchored at slot 0.
    ///
    /// This is the measure the packing claim is actually about, and a bare COUNT is
    /// not: a frozen belt holding the same number of items scattered behind an interior
    /// gap has the same count and a shorter run.
    fn head_run(pattern: &[bool]) -> usize {
        pattern.iter().take_while(|o| **o).count()
    }

    /// Every `FaultReason::OutputRefused` fault resting anywhere on the board.
    ///
    /// THE READ SITE IS NAMED, not left open: every node id from `node_ids`, that
    /// node's `inbox_of`, its `FAULT_PORT` bucket via `PortInbox::items_on`, each item
    /// decoded with `Fault::decode`, counting only `OutputRefused`.
    ///
    /// It deliberately does NOT read `core.last_tick.faulted`. That is a membership
    /// list of node ids carrying no reason on it, so it cannot tell an `OutputRefused`
    /// from a Router no-match, and an assertion built on it would be measuring
    /// something else while looking correct.
    ///
    /// SINCE PILE-09/PILE-10 THIS IS A SNAPSHOT OF WHAT IS CURRENTLY RESTING, not a
    /// whole-run count. Two things now remove or refuse a fault: the drain arm moves one
    /// onto a DOCKED fault belt, and `FAULT_QUEUE_CAP` drops any past the bound. Every
    /// caller below therefore samples it on EVERY tick and keeps a running max rather
    /// than reading it once at the end - which they already did, deliberately, in
    /// anticipation of exactly this.
    fn output_refused_on_board(core: &Core) -> usize {
        use crate::fault::{Fault, FAULT_PORT, FaultReason};
        core.state
            .node_ids()
            .map(|id| {
                core.state.inbox_of(id).map_or(0, |inbox| {
                    inbox
                        .items_on(FAULT_PORT)
                        .filter(|item| {
                            Fault::decode(item)
                                .is_ok_and(|f| f.reason == FaultReason::OutputRefused)
                        })
                        .count()
                })
            })
            .sum()
    }

    /// Every item resting anywhere on a [`pile02_board`].
    fn pile02_resident(core: &Core, bd: &PileBoard) -> u64 {
        source_pending(core, bd.s)
            + slot_resident(core, bd.a)
            + slot_resident(core, bd.b)
            + inbox_count(core, bd.a)
            + inbox_count(core, bd.b)
            + inbox_count(core, bd.t)
    }

    #[test]
    fn tick_gated_machine_packs_the_belt_in_front_of_it() {
        // PILE-02. A machine whose output cannot be placed stops taking items off the
        // belt feeding it, so the backlog forms ON THE BELT where a user can see it
        // rather than inside an inbox nothing draws.
        //
        // Belt B carries one item per 20 ticks and the source offers one every 4, so
        // belt B's staging inbox reaches MECHANICAL_INBOX_CAP, the Tee is gated, and
        // the refusal walks back up the chain to belt A and then to the source.
        use crate::admit::{MECHANICAL_INBOX_CAP, SOURCE_PENDING_CAP};
        use crate::belt_slots::{DEFAULT_TICKS_PER_SLOT, slot_count};

        let (mut core, bd) = pile02_board(11, 2, 4, PILE02_SLOWEST);

        // The window is DERIVED from belt B's own pace: it needs
        // `slot_count(4) * SLOWEST` ticks just to pack its own slots, and only after
        // that does its staging inbox stop draining and start resting at the bound. A
        // shorter window measures the window rather than the bound.
        let window = slot_count(4) as u64 * u64::from(PILE02_SLOWEST) * 3 + 400;
        // THE STEADY STATE IS A CYCLE, NOT A FREEZE, and the assertions below say so
        // rather than reading one lucky tick. Belt B hands ONE item to the Sink every
        // `SLOWEST` ticks, which frees one slot of its staging inbox, which un-gates the
        // Tee for exactly one pass. So belt A's head IS taken - once per 20 ticks - and
        // is refilled on belt A's next advance two ticks later. That is the honest
        // picture of a jam with a slow drain and it is what a user sees: the head tile
        // holds instead of blinking empty every tick.
        //
        // The tolerances are DERIVED from those two paces, never fitted to the observed
        // numbers: at most one departure per `SLOWEST` ticks, and at most
        // `DEFAULT_TICKS_PER_SLOT` ticks empty per departure.
        const TAIL: u64 = 200;
        let mut seq = 1u64;
        let mut admitted = 0u64;
        let mut max_tee_inbox = 0u64;
        let mut full_ticks = 0u64;
        let mut head_empty_ticks = 0u64;
        let mut empty_streak = 0u64;
        let mut worst_empty_streak = 0u64;
        for i in 0..window {
            if pile02_tick(&mut core, bd.s, &mut seq, i % PILE02_INJECT_EVERY == 0) {
                admitted += 1;
            }
            max_tee_inbox = max_tee_inbox.max(inbox_count(&core, bd.t));
            if i + TAIL >= window {
                let pattern = slot_pattern(&core, bd.a);
                if pattern.iter().all(|o| *o) {
                    full_ticks += 1;
                }
                if pattern[0] {
                    empty_streak = 0;
                } else {
                    head_empty_ticks += 1;
                    empty_streak += 1;
                    worst_empty_streak = worst_empty_streak.max(empty_streak);
                }
            }
        }

        // The two derived tolerances.
        let departures = TAIL / u64::from(PILE02_SLOWEST) + 1;
        let max_empty = departures * u64::from(DEFAULT_TICKS_PER_SLOT.get());

        // (a) belt A holds a FULL slot line across the tail window, minus only the ticks
        // the slow drain accounts for.
        assert!(
            full_ticks >= TAIL - max_empty,
            "belt A holds a full slot line against the gated Tee: full on {full_ticks} \
             of the last {TAIL} ticks, floor {} (pattern {:?})",
            TAIL - max_empty,
            slot_pattern(&core, bd.a)
        );
        // (b) and specifically its slot 0 - the tile touching the machine - STAYS
        // occupied. This is the ONE bit that separates a packed belt from a belt whose
        // head is taken every tick, and it is the bit PILE-07 asks a human to see. At
        // HEAD this slot is empty on 300 of 300 consecutive ticks on the shipped board;
        // here it is empty only while a departing item is replaced.
        assert!(
            head_empty_ticks <= max_empty,
            "belt A's head tile stays occupied: empty on {head_empty_ticks} of the last \
             {TAIL} ticks, ceiling {max_empty}"
        );
        assert!(
            worst_empty_streak <= u64::from(DEFAULT_TICKS_PER_SLOT.get()),
            "and it is never empty for longer than one belt advance ({worst_empty_streak} \
             consecutive ticks): a head that blinks empty and STAYS empty is a draining \
             belt, not a packed one"
        );
        // (c) the Tee's inbox reached the cap and never exceeded it at any tick.
        assert_eq!(
            max_tee_inbox, MECHANICAL_INBOX_CAP as u64,
            "the gated Tee's inbox rests at MECHANICAL_INBOX_CAP and never exceeded it \
             at any tick of the run"
        );
        // (d) conservation. Everything the source accepted is either resting on the
        // board or was consumed by the terminal Sink; nothing was created. The clause
        // under it, not this one, is what makes the sum bite.
        let resident = pile02_resident(&core, &bd);
        assert!(
            resident <= admitted,
            "no item was created: {resident} resting against {admitted} admitted"
        );
        assert_eq!(
            output_refused_on_board(&core),
            0,
            "and nothing was refused at an outbox drain: the gate stopped the machines \
             BEFORE they emitted, which is the whole difference between a bound that \
             faults and a machine that waits"
        );
        // Non-vacuity: the source itself is holding at its own bound, so the WHOLE
        // chain is bounded rather than the middle of it.
        assert_eq!(
            source_pending(&core, bd.s),
            SOURCE_PENDING_CAP as u64,
            "and the SOURCE is holding at its own bound (PILE-04)"
        );
    }

    #[test]
    fn tick_equal_pace_control_never_sustains_a_full_belt() {
        // THE NEGATIVE CONTROL for the test above, and the arms differ in EXACTLY ONE
        // argument: belt B's `ticks_per_slot`. At the same pace as belt A the chain
        // keeps up with the feed, so belt A never sustains a full slot line and the Tee
        // is never gated.
        //
        // At HEAD this arm is INDISTINGUISHABLE from the positive arm - neither belt
        // packs, because the Tee drained its whole inbox every tick whatever its output
        // was doing. That is what makes the pair non-vacuous: the positive arm's result
        // is caused by belt B's pace, not by the existence of a gate.
        use crate::belt_slots::{DEFAULT_TICKS_PER_SLOT, slot_count};

        let (mut core, bd) = pile02_board(11, 2, 4, DEFAULT_TICKS_PER_SLOT.get());

        let window = slot_count(4) as u64 * u64::from(PILE02_SLOWEST) * 3 + 400;
        let mut seq = 1u64;
        let mut full_ticks = 0u64;
        let mut max_tee_inbox = 0u64;
        for i in 0..window {
            pile02_tick(&mut core, bd.s, &mut seq, i % PILE02_INJECT_EVERY == 0);
            if slot_resident(&core, bd.a) == slot_count(2) as u64 {
                full_ticks += 1;
            }
            max_tee_inbox = max_tee_inbox.max(inbox_count(&core, bd.t));
        }
        assert_eq!(
            full_ticks, 0,
            "at equal pace belt A never sustains a full slot line (it was full on \
             {full_ticks} of {window} ticks)"
        );
        assert!(
            max_tee_inbox < crate::admit::MECHANICAL_INBOX_CAP as u64,
            "and the Tee's inbox never reached the cap, so it was never gated \
             (peak {max_tee_inbox})"
        );
    }

    #[test]
    fn tick_belt_behind_a_gated_machine_packs_forward() {
        // R-10a, PILE-07 and PILE-11 judgment A. The belt behind a gated machine PACKS
        // FORWARD: it keeps stepping, keeps advancing its slots, and CLOSES ITS GAPS
        // from the head end. It does not freeze where it stood.
        //
        // THIS IS THE TEST THAT WOULD CATCH AN UNSCOPED GATE, and only its last clause
        // would. A gate that early-returned a `Node::Belt` leaves belt A frozen with its
        // interior gaps intact, and "contiguous", "full" and "non-decreasing" are ALL
        // satisfied by a belt that entered the jam already full and then stopped. Only
        // a STRICT INCREASE in the head-anchored run proves a gap closed WHILE the
        // machine in front was refusing - which is why this board is built to ENTER the
        // jam with a gap rather than inheriting one by luck.
        use crate::admit::MECHANICAL_INBOX_CAP;
        use crate::belt_slots::slot_count;

        // THREE tiles on belt A, so an interior gap is representable at all (12 slots).
        // Belt B is ONE tile, and its head is UNDOCKED: a permanently blocked output is
        // the cleanest gate there is, so once belt B and its staging inbox saturate the
        // Tee is gated on EVERY subsequent tick and never un-gated. That matters here
        // and nowhere else: with a draining terminal the Tee is briefly un-gated once
        // per drain, belt A's head is taken, and the head-anchored run drops to zero -
        // which is correct behaviour but makes "non-decreasing" the wrong shape to
        // assert. A permanent gate is what makes the packing MONOTONE and therefore
        // what makes the strict increase below mean what it says.
        let (mut core, bd) = pile02_board(23, 3, 1, PILE02_SLOWEST);
        core.state.unlink((bd.b, 0));
        let full = slot_count(3);

        let window = 1400u64;
        let mut seq = 1u64;
        let mut jam_onset: Option<(u64, Vec<bool>)> = None;
        let mut runs_after_jam: Vec<usize> = Vec::new();
        for i in 0..window {
            pile02_tick(&mut core, bd.s, &mut seq, i % PILE02_INJECT_EVERY == 0);
            let pattern = slot_pattern(&core, bd.a);
            if jam_onset.is_none() && inbox_count(&core, bd.t) == MECHANICAL_INBOX_CAP as u64
            {
                // JAM ONSET: the tick the Tee's inbox first reaches the cap. From here
                // the Tee is gated on every tick, so belt A can no longer hand its head
                // over and everything after this sample is the belt packing on its own.
                jam_onset = Some((core.tick, pattern.clone()));
            }
            if jam_onset.is_some() {
                runs_after_jam.push(head_run(&pattern));
            }
        }

        let (onset_tick, onset_pattern) =
            jam_onset.expect("the Tee must reach its cap inside the window");
        let onset_run = head_run(&onset_pattern);
        let final_pattern = slot_pattern(&core, bd.a);

        // THE ENTRY GAP IS ASSERTED, NOT ASSUMED. If belt A were already contiguous and
        // full at onset, every clause below would pass on a frozen belt.
        assert!(
            onset_run < full,
            "the board must ENTER the jam with belt A not yet packed, or the strict \
             increase below proves nothing. Onset tick {onset_tick}, pattern \
             {onset_pattern:?}"
        );

        // (1) NON-DECREASING: the head-anchored run never shrinks after the jam begins.
        for w in runs_after_jam.windows(2) {
            assert!(
                w[1] >= w[0],
                "the head-anchored run never shrinks once the machine is refusing \
                 ({} then {})",
                w[0],
                w[1]
            );
        }
        // (2) THE STRICT INCREASE. A belt that entered the jam already full and then
        // FROZE satisfies contiguity, fullness and non-decreasing all three. Only this
        // clause separates a packing belt from a frozen one.
        assert!(
            runs_after_jam.windows(2).any(|w| w[1] > w[0]),
            "belt A closed no gap while the Tee refused: the run never strictly \
             increased, which is exactly what a belt excluded from stepping would look \
             like. Runs after jam: {runs_after_jam:?}"
        );
        // (3) CONTIGUOUS FROM SLOT 0 WITH NO INTERIOR GAP, and (4) FULL.
        assert_eq!(
            head_run(&final_pattern),
            full,
            "at steady state belt A is contiguous from slot 0 with no interior gap \
             (pattern {final_pattern:?})"
        );
        assert_eq!(
            slot_resident(&core, bd.a),
            full as u64,
            "and the occupied count equals the belt's full slot count"
        );
        eprintln!(
            "PACKS-FORWARD onset tick {onset_tick} pattern {onset_pattern:?} run \
             {onset_run}; steady pattern {final_pattern:?} run {}",
            head_run(&final_pattern)
        );
    }

    #[test]
    fn tick_jam_clears_when_the_block_lifts() {
        // RESEARCH Pitfall 5. A jam-only test cannot tell a correct gate from one that
        // permanently STRANDS the machine, and stranding would look exactly like the
        // fix working in every jam assertion. So this drives the jam, lifts the block,
        // and asserts the board resumes.
        //
        // The mechanism under test is THE CONSUMER WAKE in `step_node` (phase 87, JAM-04,
        // D-06): a gated node now sleeps out of the active set, and the node whose inbox
        // shrinks (here the slow belt taking an item off its staging inbox) schedules each
        // feeder asleep behind it at `now + 1`, found through the reverse link index.
        // Until phase 87 the mechanism was the gate's unconditional `schedule_wake(id,
        // now + 1)`, which spun every blocked machine every tick. Either way, a gated node
        // that was never re-woken would sit out of the active set forever and the board
        // would never restart, however free its output became; with the consumer wake
        // removed this test goes red (87-EVIDENCE `## Plan 87-06`, `mut-consumer.out`).
        use crate::admit::MECHANICAL_INBOX_CAP;
        use crate::belt_slots::{DEFAULT_TICKS_PER_SLOT, slot_count};

        let (mut core, bd) = pile02_board(37, 2, 4, PILE02_SLOWEST);
        let window = slot_count(4) as u64 * u64::from(PILE02_SLOWEST) * 3 + 400;
        let mut seq = 1u64;
        let mut max_belt_a = 0u64;
        let mut max_tee_inbox = 0u64;
        for i in 0..window {
            pile02_tick(&mut core, bd.s, &mut seq, i % PILE02_INJECT_EVERY == 0);
            max_belt_a = max_belt_a.max(slot_resident(&core, bd.a));
            max_tee_inbox = max_tee_inbox.max(inbox_count(&core, bd.t));
        }
        // THE JAM IS REAL BEFORE WE LIFT ANYTHING. Read as maxima over the run rather
        // than as one tick's values: with a slow but non-zero drain the steady state is
        // a cycle, and a precondition pinned to a single tick's phase would redden for a
        // reason that has nothing to do with the clear.
        assert_eq!(
            max_belt_a,
            slot_count(2) as u64,
            "precondition: belt A packed full at some point in the run"
        );
        assert_eq!(
            max_tee_inbox, MECHANICAL_INBOX_CAP as u64,
            "precondition: the Tee reached its cap and was gated"
        );

        // LIFT THE BLOCK - AND KEEP INJECTING (CR-02).
        //
        // The original shape did TWO things in one step: it restored the pace AND it
        // stopped offering items. The board then emptied, and both causes explain that
        // equally. Measured: with the pace restore DELETED the board still drained to
        // zero well inside the budget, because belt B at 20 ticks/slot still moves an
        // item every 20 ticks and at most ~72 items are resident. So the line that is
        // supposed to be the cause was INERT and the sole registered cover for "the jam
        // CLEARS when the block lifts" separated nothing.
        //
        // The confound is removed by keeping the ONE variable that was not under test
        // constant: injection continues at the SAME `PILE02_INJECT_EVERY` cadence it
        // ran at during the jam, right across the restore. That is legitimate on this
        // board rather than a hope - `PILE02_INJECT_EVERY` is 4 against a default-pace
        // belt carrying one item per 2 ticks, i.e. HALF the chain's carrying rate, so
        // once belt B is back at that pace there IS real surplus capacity and the
        // backlog genuinely has to clear while the feed keeps running.
        //
        // The claim therefore moves from "the board is empty" (which a stopped feed
        // buys) to "the board is no longer JAMMED while still loaded", which only the
        // pace restore can buy. It is read over the TAIL of the window, after a settle
        // prefix long enough for the accumulated backlog to travel out, so it is a
        // statement about the new steady state and not about the transient.
        set_pace(&mut core, bd.b, DEFAULT_TICKS_PER_SLOT.get());

        const CLEAR_WINDOW: u64 = 4000;
        const SETTLE: u64 = 2000;
        let full_a = slot_count(2) as u64;
        let mut tail_full_ticks = 0u64;
        let mut tail_max_tee = 0u64;
        let mut tail_max_pending = 0u64;
        let mut tail_ticks = 0u64;
        let mut max_refused = 0usize;
        let mut offered_after_lift = 0u64;
        for i in 0..CLEAR_WINDOW {
            let offer = i % PILE02_INJECT_EVERY == 0;
            if offer {
                offered_after_lift += 1;
            }
            pile02_tick(&mut core, bd.s, &mut seq, offer);
            max_refused = max_refused.max(output_refused_on_board(&core));
            if i >= SETTLE {
                tail_ticks += 1;
                if slot_resident(&core, bd.a) == full_a {
                    tail_full_ticks += 1;
                }
                tail_max_tee = tail_max_tee.max(inbox_count(&core, bd.t));
                tail_max_pending = tail_max_pending.max(source_pending(&core, bd.s));
            }
        }

        // NON-VACUITY: the feed really did keep running across the restore. Without
        // this the arm could silently degrade back into the stopped-injection version
        // it was written to replace.
        assert_eq!(
            offered_after_lift,
            CLEAR_WINDOW / PILE02_INJECT_EVERY,
            "injection ran across the whole post-lift window at the SAME cadence it \
             ran at during the jam - that constancy is what makes the clear \
             attributable to the pace restore"
        );

        // THE CLAIM. Belt A never sustains a full slot line again, which is the same
        // measure `tick_equal_pace_control_never_sustains_a_full_belt` uses for "not
        // jammed". With the pace restore removed belt A stays packed on every one of
        // these ticks and this is the assertion that fires.
        assert_eq!(
            tail_full_ticks, 0,
            "after the block lifted belt A never sustains a full slot line again, on \
             {tail_ticks} tail ticks with the feed still running (pattern {:?})",
            slot_pattern(&core, bd.a)
        );
        // And the Tee is no longer gated: its inbox stays strictly under the cap.
        assert!(
            tail_max_tee < MECHANICAL_INBOX_CAP as u64,
            "the Tee stepped again and its inbox stayed under the cap (peak \
             {tail_max_tee} of {MECHANICAL_INBOX_CAP}): the gate re-woke it and the \
             backlog cleared"
        );
        // And the source is no longer holding a backlog of its own.
        assert_eq!(
            tail_max_pending, 0,
            "and the source, gated at its own bound a moment ago, fires every offer \
             the tick it arrives"
        );
        assert_eq!(
            max_refused, 0,
            "and nothing was refused at any point on the way out"
        );
    }

    #[test]
    fn tick_gated_board_produces_no_output_refused_fault() {
        // THE GATE'S OWN NON-VACUITY INSTRUMENT. A non-zero count here means a machine
        // emitted MORE than the gate cleared: the gate proves one item per output port
        // is admissible, ruling R-12 holds every machine to exactly that, and the
        // generic outbox drain faults anything past it. Zero is therefore the claim
        // that the gate and the bounded passes agree.
        //
        // THIS ASSERTION IS PROVED ABLE TO FIRE. A zero-count assertion whose subject
        // has never been observed passes identically on a correct gate, on a miswired
        // fault reason, on a test reading the wrong site, and on a build where
        // `OutputRefused` is never pushed at all. The plan 71-03 SUMMARY carries a
        // fire-and-restore transcript: with the gate's early return commented out the
        // same board and the same read site produce a NON-ZERO count, and it returns to
        // zero when the gate is restored.
        use crate::belt_slots::slot_count;

        let (mut core, bd) = pile02_board(41, 2, 4, PILE02_SLOWEST);
        let window = slot_count(4) as u64 * u64::from(PILE02_SLOWEST) * 3 + 400;
        let mut seq = 1u64;
        let mut worst = 0usize;
        let mut max_tee_inbox = 0u64;
        for i in 0..window {
            pile02_tick(&mut core, bd.s, &mut seq, i % PILE02_INJECT_EVERY == 0);
            // Sampled EVERY tick, not only at the end. The PILE-10 drain and the
            // PILE-09 bound both now remove or refuse faults, so an end-of-run read
            // would NOT be sufficient. The per-tick max is what keeps this honest, and
            // it was written this way before either landed for exactly that reason.
            worst = worst.max(output_refused_on_board(&core));
            max_tee_inbox = max_tee_inbox.max(inbox_count(&core, bd.t));
        }
        assert_eq!(
            worst, 0,
            "no machine on a fully jammed board ever emitted more than the gate had \
             cleared"
        );
        // Non-vacuity of the BOARD, separately from the instrument: a run that never
        // jammed would produce zero refusals for an uninteresting reason.
        assert_eq!(
            max_tee_inbox,
            crate::admit::MECHANICAL_INBOX_CAP as u64,
            "and the board really did jam, so the zero above is not a zero from an \
             empty run"
        );
    }

    #[test]
    fn tick_jammed_board_snapshot_length_is_stable() {
        // PILE-04. A board that has jammed solid stops growing on disk.
        //
        // The equality is the requirement; the four clauses under it are what stop it
        // being bought by a board that simply STOPPED. An equal length behind an
        // unbounded queue is the failure this test exists to catch, so every queue is
        // read against its own governing constant at BOTH points and at least one must
        // be AT it.
        use crate::admit::{MECHANICAL_INBOX_CAP, SOURCE_PENDING_CAP};

        let (mut core, bd) = pile02_board(53, 2, 4, PILE02_SLOWEST);
        let mut seq = 1u64;
        // A timer offering an injection EVERY tick, so the board is under continuous
        // load rather than fed a finite burst that ran out.
        let mut offered_first = 0u64;
        for _ in 0..2000u64 {
            pile02_tick(&mut core, bd.s, &mut seq, true);
            offered_first += 1;
        }
        let len_at_2000 = crate::snapshot::snapshot(&core).len();
        let resident_at_2000 = pile02_resident(&core, &bd);

        let mut offered_second = 0u64;
        let mut at_bound_ticks = 0u64;
        for _ in 0..2000u64 {
            pile02_tick(&mut core, bd.s, &mut seq, true);
            offered_second += 1;
            if inbox_count(&core, bd.t) == MECHANICAL_INBOX_CAP as u64
                || inbox_count(&core, bd.a) == MECHANICAL_INBOX_CAP as u64
                || inbox_count(&core, bd.b) == MECHANICAL_INBOX_CAP as u64
                || source_pending(&core, bd.s) == SOURCE_PENDING_CAP as u64
            {
                at_bound_ticks += 1;
            }
        }
        let len_at_4000 = crate::snapshot::snapshot(&core).len();
        let resident_at_4000 = pile02_resident(&core, &bd);

        // THE REQUIREMENT.
        assert_eq!(
            len_at_2000, len_at_4000,
            "a jammed board's serialized size is identical at tick 2000 and tick 4000 \
             ({len_at_2000} then {len_at_4000} bytes)"
        );

        // CLAUSE 1: still under load. The event stream offered an injection on every
        // one of the second 2000 ticks. Almost all of them were REFUSED, and that is
        // the bound working rather than the board idling: `SOURCE_PENDING_CAP` is what
        // turns "keeps arriving" into "stops growing".
        assert_eq!(offered_first, 2000, "offered every tick in the first window");
        assert_eq!(offered_second, 2000, "and every tick in the second");

        // CLAUSE 2: conservation. Nothing was created or lost between the points.
        assert_eq!(
            resident_at_2000, resident_at_4000,
            "the resident population is identical at both points ({resident_at_2000} \
             then {resident_at_4000})"
        );

        // CLAUSE 3: every queue at or under its governing constant, at both points.
        for (label, len, cap) in [
            ("the Tee's machine inbox", inbox_count(&core, bd.t), MECHANICAL_INBOX_CAP),
            ("belt A's staging inbox", inbox_count(&core, bd.a), MECHANICAL_INBOX_CAP),
            ("belt B's staging inbox", inbox_count(&core, bd.b), MECHANICAL_INBOX_CAP),
            ("the source's pending", source_pending(&core, bd.s), SOURCE_PENDING_CAP),
        ] {
            assert!(
                len <= cap as u64,
                "{label} is at or under its governing constant ({len} of {cap})"
            );
        }
        // The FOURTH queue is the fault port, bounded by `FAULT_QUEUE_CAP` (PILE-09).
        // On THIS board it holds NOTHING at all, which is a stronger statement than any
        // bound: the machines stop before they emit, so no refusal is ever minted and
        // the cap is never consulted.
        let faults: usize = core
            .state
            .node_ids()
            .map(|id| {
                core.state
                    .inbox_of(id)
                    .map_or(0, |i| i.len_on(crate::fault::FAULT_PORT))
            })
            .sum();
        assert_eq!(faults, 0, "the fault queue holds nothing on a gated board");

        // CLAUSE 4: at least ONE queue is AT its constant on EVERY tick of the second
        // window, so the equality is not bought by a board that never filled anything.
        // Read over the window rather than at the last tick: the steady state is a
        // cycle, and a single tick's phase is not the claim.
        assert_eq!(
            at_bound_ticks, offered_second,
            "some queue was AT its bound on every tick of the second window ({} of {}): \
             Tee {}, beltA {}, beltB {}, pending {}",
            at_bound_ticks,
            offered_second,
            inbox_count(&core, bd.t),
            inbox_count(&core, bd.a),
            inbox_count(&core, bd.b),
            source_pending(&core, bd.s)
        );

        // A NOTE THE NEXT READER NEEDS. `snapshot` covers the WHOLE core including
        // `core.tick`, and postcard writes that as a varint: 2000 and 4000 both encode
        // in two bytes, so the tick field contributes equally at the two points. Move
        // either sample past 16383 and the varint widens by a byte, and this equality
        // would redden for a reason that has nothing to do with a queue.
        eprintln!("PILE-04 snapshot len {len_at_2000} at 2000, {len_at_4000} at 4000");
    }

    // =========================================================================
    // PLAN 71-04: PILE-10's fault drain, and the undocked control that stops it
    // deleting the one signal a user has today.
    // =========================================================================

    /// A Sink, optionally with a belt docked onto its reserved FAULT_PORT.
    ///
    /// Built through `state.link((sink, FAULT_PORT), (belt, 0))` rather than through the
    /// command layer, because this file tests the FOLD. `fault_reconciliation.rs` is
    /// where the command layer's Option-A reconciliation (a spatial `Role::Fault` dock
    /// resolving to this same key) is pinned, and plan 71-04 task 3 widens it to the
    /// Sink. The two meet at exactly this key, which is the whole point of that
    /// reconciliation: dock key == emit key.
    fn fault_drain_board(seed: u64, docked: bool) -> (Core, NodeId, Option<NodeId>) {
        use crate::fault::FAULT_PORT;
        let mut core = core_with_seed(seed);
        let sink = core.state.add_sink(crate::state::SinkTemplate::Debug, 100);
        let belt = if docked {
            let b = core.state.add_belt(4);
            core.state.link((sink, FAULT_PORT), (b, 0));
            Some(b)
        } else {
            None
        };
        (core, sink, belt)
    }

    /// One logged `CommandResult` FAILURE re-entry addressed at `node` - the real
    /// "the outside world could not be reached" path. `manual_inject::admit` turns it
    /// into a `FaultReason::CommandFailure` on `node`'s FAULT_PORT and wakes the node.
    ///
    /// Driven as a logged event rather than pushed by hand, deliberately: a hand-pushed
    /// fault bypasses `admit::try_admit`, which is where `FAULT_QUEUE_CAP` lives, so a
    /// hand-pushed test would assert the drain against a queue the bound never saw.
    fn failing_dispatch(node: NodeId, seq: u64, at_tick: u64) -> crate::event::Event {
        crate::event::Event {
            schema_version: crate::event::SCHEMA_VERSION,
            partition: 0,
            sequence: seq,
            tick: at_tick,
            payload: crate::event::EventPayload::CommandResult(crate::command::ResultEvent {
                command_id: (at_tick, node, seq as u32),
                tick: at_tick,
                outcome: crate::command::Outcome::Failure,
            }),
        }
    }

    /// How many faults are RESTING on a node's FAULT_PORT, read non-destructively.
    fn faults_resting(core: &Core, id: NodeId) -> usize {
        core.state
            .inbox_of(id)
            .map_or(0, |i| i.len_on(crate::fault::FAULT_PORT))
    }

    #[test]
    fn tick_docked_fault_belt_carries_a_sink_failure_away() {
        // PILE-10. A Sink whose FAULT_PORT is LINKED: a failing dispatch puts a fault in
        // its inbox, the fold moves it to the outbox, the generic drain routes it onto
        // the belt, and the belt carries it. The Sink stops holding a fault once the
        // last one has left.
        let (mut core, sink, belt) = fault_drain_board(0x7104_2001, true);
        let belt = belt.expect("this arm is docked");

        core.advance(&[failing_dispatch(sink, 1, 0)]);

        // The fault did not stay in the inbox: the drain arm ran in the SAME tick the
        // fault arrived, because `manual_inject` woke the sink and the fold stepped it.
        assert_eq!(
            faults_resting(&core, sink),
            0,
            "the docked fault left the Sink's inbox"
        );

        // And it is on the belt rather than nowhere. Read across both of the belt's
        // resting places - its staging inbox and its slots - so the assertion does not
        // depend on which tick of the belt's own pace this happens to be.
        let on_belt = |core: &Core| inbox_count(core, belt) + slot_resident(core, belt);
        assert_eq!(on_belt(&core), 1, "the fault is resting on the fault belt");

        // It TRAVELS. Drive the belt long enough to move an item its whole length and
        // assert the item is still accounted for at the far end, where its head dangles
        // (nothing is docked past this belt, so the head RETAINS - the dangling-head
        // bunch, not a loss).
        for _ in 0..(crate::belt_slots::slot_count(4) as u64
            * u64::from(crate::belt_slots::DEFAULT_TICKS_PER_SLOT.get())
            + 8)
        {
            core.advance(&[]);
        }
        assert_eq!(on_belt(&core), 1, "nothing was lost carrying it");
        assert_eq!(
            slot_resident(&core, belt),
            1,
            "and it made it out of the staging inbox onto the belt itself"
        );
        assert_eq!(
            faults_resting(&core, sink),
            0,
            "the Sink is still not holding one"
        );
    }

    #[test]
    fn tick_undocked_fault_port_still_holds_the_fault_indefinitely() {
        use crate::fault::FAULT_PORT;
        // THE CONTROL, and the reason the drain is a fold arm gated on the link rather
        // than a Sink step arm (ruling R-18). With NOTHING docked on the fault port the
        // fault must STAY in the inbox, because that resting fault is the ONE signal a
        // user has that the board is pointed at a dead endpoint: `derive_state` paints
        // a machine FAULTED while `has_on(FAULT_PORT)` is true.
        //
        // A Sink-side drain would have moved this fault to the outbox, the fold's
        // undocked-fault arm would have dropped it, and the machine would have gone
        // quietly green. This test is what makes that failure mode impossible to ship.
        let (mut core, sink, belt) = fault_drain_board(0x7104_2002, false);
        assert!(belt.is_none(), "this arm is UNDOCKED");
        assert!(
            core.state.link_target((sink, FAULT_PORT)).is_none(),
            "non-vacuity: the fault port must really be unlinked"
        );

        core.advance(&[failing_dispatch(sink, 1, 0)]);
        assert_eq!(faults_resting(&core, sink), 1, "the fault landed");

        for _ in 0..2000u64 {
            core.advance(&[]);
        }
        assert_eq!(
            faults_resting(&core, sink),
            1,
            "and it is STILL there 2000 ticks later, so the machine still paints FAULTED"
        );
    }

    #[test]
    fn tick_fault_drain_moves_one_per_pass_and_re_wakes_itself() {
        // ONE item per pass (ruling R-12's reasoning, copied): the PILE-02 gate proved
        // ONE item admissible per linked output, so a whole-bucket move could overflow a
        // destination the gate had just cleared. The re-wake at `now + 1` is what makes
        // one-per-pass drain the whole bucket without any further event.
        let (mut core, sink, belt) = fault_drain_board(0x7104_2003, true);
        let belt = belt.expect("this arm is docked");

        let burst = 4usize;
        let evs: Vec<crate::event::Event> = (0..burst)
            .map(|i| failing_dispatch(sink, i as u64 + 1, 0))
            .collect();
        core.advance(&evs);

        // EXACTLY ONE left on the tick they all arrived, so this is one-per-pass and not
        // a whole-bucket move that happened to look right.
        assert_eq!(
            faults_resting(&core, sink),
            burst - 1,
            "exactly one fault left on the arrival tick"
        );

        // NO further events. The bucket empties purely on the arm's own re-wake, one per
        // tick, which is the property the assertion below is really about.
        let mut observed = vec![faults_resting(&core, sink)];
        for _ in 0..(burst - 1) {
            core.advance(&[]);
            observed.push(faults_resting(&core, sink));
        }
        assert_eq!(
            observed,
            vec![3, 2, 1, 0],
            "one fault per tick, driven by the arm's own re-wake and nothing else"
        );

        // Conservation: all four are on the belt, none dropped.
        assert_eq!(
            inbox_count(&core, belt) + slot_resident(&core, belt),
            burst as u64,
            "every fault reached the belt"
        );
    }

    #[test]
    fn tick_sink_with_a_full_fault_belt_is_blocked_and_stops_draining() {
        // 71-CONTEXT D-08 arriving as a CONSEQUENCE of one rule rather than as a special
        // case. `outputs_blocked` walks every entry in `links_from(sink)`, and a docked
        // fault port is an entry like any other, so a Sink whose fault belt's staging
        // inbox is full is not stepped at all. The backpressure at a terminal that
        // ruling R-13 said "requires drawing a fault belt" is exactly this.
        //
        // The belt is ONE tile at the slowest pace the command layer will write, so its
        // staging inbox fills long before its slots can carry the backlog away.
        use crate::admit::{FAULT_QUEUE_CAP, MECHANICAL_INBOX_CAP};
        let (mut core, sink, belt) = fault_drain_board(0x7104_2004, true);
        let belt = belt.expect("this arm is docked");
        set_pace(&mut core, belt, PILE02_SLOWEST);

        // Offer a failing dispatch EVERY tick, far past both bounds, so the board is
        // under continuous load rather than fed a burst that ran out.
        let mut seq = 1u64;
        for _ in 0..400u64 {
            let ev = failing_dispatch(sink, seq, core.tick);
            seq += 1;
            core.advance(&[ev]);
        }

        // ONE SLOT SHORT OF THE BOUND, AND THAT IS THE GATE'S OWN ARITHMETIC (phase 87,
        // WINDOWS 176 half 1, D-05). The kind-blind gate counts the fault link once (the
        // step MAY emit a fault there, as a Router faulting every item does) and the drain
        // arm's push once more while a fault rests, so a Sink holding a resting fault
        // needs room for two. A Sink's step never emits on its fault port, so on this
        // board one of the two slots is reserved and never used, and the staging inbox
        // rests at `MECHANICAL_INBOX_CAP - 1`. Counting exactly would need a kind match in
        // the gate or a second capacity check in the drain arm; both are refused.
        let resting_at = MECHANICAL_INBOX_CAP as u64 - 1;
        assert_eq!(
            inbox_count(&core, belt),
            resting_at,
            "the fault belt's staging inbox rests one under the mechanical bound"
        );
        assert_eq!(
            faults_resting(&core, sink),
            FAULT_QUEUE_CAP,
            "and the Sink is holding at its OWN bound, because the gate stopped stepping \
             it and the drain arm is therefore never reached"
        );

        // A BOUND, NOT A PAUSE: 2000 further ticks under the same continuous load move
        // neither queue by one item.
        for _ in 0..2000u64 {
            let ev = failing_dispatch(sink, seq, core.tick);
            seq += 1;
            core.advance(&[ev]);
        }
        assert_eq!(
            inbox_count(&core, belt),
            resting_at,
            "the staging inbox does not grow across a further 2000 ticks"
        );
        assert_eq!(
            faults_resting(&core, sink),
            FAULT_QUEUE_CAP,
            "and neither does the fault queue"
        );
    }

    // =========================================================================
    // PLAN 87-02: JAM-03, WINDOWS 176. The output gate counts the fold's own fault
    // drain (D-05 half 1), and a refused fault is re-admitted unchanged (D-05 half 2).
    // =========================================================================

    /// A Router with no routes and no default (every item it takes faults on its
    /// `FAULT_PORT`), holding one item on In 0 and one resting `CommandTimeout` fault on
    /// its `FAULT_PORT`, woken for the next tick. When `room` is `Some(r)` its fault
    /// port docks a 1-tile belt whose staging inbox already holds
    /// `MECHANICAL_INBOX_CAP - r` items, so the belt has room for exactly `r` more; when
    /// it is `None` the fault port is undocked. Built by hand, the way
    /// `tick_belt_staging_inbox_is_bounded_and_refuses_its_feeder` builds its board,
    /// because the case under test is one gate decision on one tick.
    fn drain_gate_board(seed: u64, room: Option<usize>) -> (Core, NodeId, Option<NodeId>) {
        use crate::admit::MECHANICAL_INBOX_CAP;
        use crate::fault::{Fault, FaultReason, FAULT_PORT};
        let mut core = core_with_seed(seed);
        let router = core.state.add_router(Vec::new(), None);
        let belt = room.map(|r| {
            let b = core.state.add_belt(1);
            core.state.link((router, FAULT_PORT), (b, 0));
            for k in 0..(MECHANICAL_INBOX_CAP - r) {
                core.state.inbox_mut(b).push(0, k as u64, Item(vec![0xB0]));
            }
            b
        });
        core.state.inbox_mut(router).push(0, 100, Item(vec![7]));
        let resting = Fault::command(router, FaultReason::CommandTimeout, Vec::new());
        core.state
            .inbox_mut(router)
            .push(FAULT_PORT, 101, resting.encode());
        core.sched.wake_now(router);
        (core, router, belt)
    }

    #[test]
    fn tick_the_fault_drain_counts_in_the_gate() {
        use crate::fault::FAULT_PORT;
        // ROW 1, THE CASE WINDOWS 176 MEASURED. The Router's fault belt has room for
        // exactly ONE item, and stepping the Router would push TWO onto it: the no-match
        // fault its own step emits on `FAULT_PORT`, and the resting fault the drain arm
        // moves out after the step. Counting only the link, the gate read one demand
        // against one free slot and let the Router step, the second push was refused, and
        // the refusal minted an `OutputRefused` dead letter. Counting the drain arm too,
        // the Router is gated: not stepped, nothing refused, its item still waiting.
        let (mut core, router, belt) = drain_gate_board(0x8702_0001, Some(1));
        let belt = belt.expect("this row is docked");
        assert!(
            super::outputs_blocked(&core.state, router),
            "a resting fault on a docked fault port adds the drain arm's push to the \
             gate's demand: two items against room for one is blocked"
        );
        core.advance(&[]);
        assert_eq!(
            output_refused_on_board(&core),
            0,
            "nothing is refused, so no dead letter is minted"
        );
        assert_eq!(
            core.state.inbox_of(router).map_or(0, |i| i.len_on(0)),
            1,
            "the gated Router was not stepped: its item is still on In 0"
        );
        assert_eq!(
            faults_resting(&core, router),
            1,
            "and the resting fault is still resting, unrefused"
        );
        assert!(
            core.state.inbox_of(belt).map_or(0, |i| i.len_on(0))
                <= crate::admit::MECHANICAL_INBOX_CAP,
            "the fault belt's staging inbox never passed its bound"
        );

        // CONTROL: room for TWO. The same step is admissible, so the gate must not
        // over-block: the Router steps, both pushes land, nothing is refused.
        let (mut core, router, _belt) = drain_gate_board(0x8702_0002, Some(2));
        assert!(
            !super::outputs_blocked(&core.state, router),
            "two items against room for two is not blocked"
        );
        core.advance(&[]);
        assert_eq!(output_refused_on_board(&core), 0, "nothing refused with room for two");
        assert_eq!(
            core.state.inbox_of(router).map_or(0, |i| i.len_on(0)),
            0,
            "the Router stepped and took its item"
        );
        assert_eq!(faults_resting(&core, router), 0, "and the drain arm carried the fault out");

        // ROW 2: the fault port is UNDOCKED. The drain arm does not fire on an undocked
        // fault port (ruling R-18), so the resting fault adds no demand: a Router with no
        // links at all is never blocked, it steps, and the resting fault stays resting
        // as the signal `derive_state` paints red.
        let (mut core, router, belt) = drain_gate_board(0x8702_0003, None);
        assert!(belt.is_none(), "this row is undocked");
        assert!(
            core.state.link_target((router, FAULT_PORT)).is_none(),
            "non-vacuity: the fault port is really unlinked"
        );
        assert!(
            !super::outputs_blocked(&core.state, router),
            "an undocked fault port adds no demand, resting fault or not"
        );
        core.advance(&[]);
        assert_eq!(
            core.state.inbox_of(router).map_or(0, |i| i.len_on(0)),
            0,
            "the ungated Router stepped and took its item"
        );
        assert_eq!(faults_resting(&core, router), 1, "the undocked fault still rests");
        assert_eq!(output_refused_on_board(&core), 0, "nothing refused");
    }

    #[test]
    fn tick_a_refused_fault_is_readmitted_unchanged() {
        use crate::fault::{Fault, FaultReason, FAULT_PORT};
        let mut core = core_with_seed(0x8702_0004);
        let id = core.state.add_router(Vec::new(), None);
        let other = core.state.add_sink(crate::state::SinkTemplate::Debug, 0);

        // ROW 1: an item that left on `FAULT_PORT` comes back byte for byte. It is
        // already the fault its emitter meant; wrapping it again is the growth WINDOWS
        // 176 measured (131 deep in 4000 ticks).
        let fault = Fault::command(other, FaultReason::NoMatch, vec![1, 2, 3]).encode();
        assert_eq!(
            super::refused_dead_letter(id, FAULT_PORT, fault.clone()),
            fault,
            "an item refused on FAULT_PORT is re-admitted unchanged"
        );
        // Even bytes that are not a fault at all: the rule reads the port, never the bytes.
        let plain = Item(vec![0xFF, 0x00, 0x7F]);
        assert_eq!(
            super::refused_dead_letter(id, FAULT_PORT, plain.clone()),
            plain,
            "the FAULT_PORT arm never inspects the bytes"
        );

        // ROW 2: an item that left on any other port is wrapped ONCE, naming the emitter.
        let item = Item(vec![7, 8, 9]);
        let wrapped = super::refused_dead_letter(id, 0, item.clone());
        assert_eq!(
            Fault::decode(&wrapped),
            Ok(Fault {
                reason: FaultReason::OutputRefused,
                source: id,
                attempt: 1,
                payload: item.0.clone(),
            }),
            "an item refused on port 0 becomes one OutputRefused fault carrying it"
        );

        // ROW 3: a USER item on port 0 whose bytes happen to decode as a `Fault` is still
        // wrapped once. Deciding by decoding is the byte sniff phase 72 deleted from the
        // factory ("two discriminators that can disagree are worse than either alone").
        let lookalike = Fault::command(other, FaultReason::OutputRefused, vec![4, 5]).encode();
        assert!(Fault::decode(&lookalike).is_ok(), "non-vacuity: the bytes decode as a Fault");
        let wrapped = super::refused_dead_letter(id, 0, lookalike.clone());
        let outer = Fault::decode(&wrapped).expect("the dead letter is a Fault");
        assert_eq!(outer.reason, FaultReason::OutputRefused, "wrapped as OutputRefused");
        assert_eq!(outer.source, id, "naming the emitter, not the look-alike's source");
        assert_eq!(outer.payload, lookalike.0, "carrying the look-alike's bytes whole");
    }

    #[test]
    fn tick_two_sources_both_fire_in_one_tick() {
        // Two independent sources fired in the same tick both deliver — the fold
        // steps every woken node in the active set (ascending id order).
        let mut core = core_with_seed(1);
        let s1 = core.state.add_source();
        let s2 = core.state.add_source();
        let c1 = core.state.add_source();
        let c2 = core.state.add_source();
        core.state.link((s1, 0), (c1, 0));
        core.state.link((s2, 0), (c2, 0));

        core.advance(&[
            fire(s1, 1, 0, Item(vec![0xA])),
            fire(s2, 2, 0, Item(vec![0xB])),
        ]);
        let mut i1 = core.state.inbox_of(c1).cloned().expect("c1 inbox");
        let mut i2 = core.state.inbox_of(c2).cloned().expect("c2 inbox");
        assert_eq!(i1.take(0).map(|(_seq, it)| it), Some(Item(vec![0xA])));
        assert_eq!(i2.take(0).map(|(_seq, it)| it), Some(Item(vec![0xB])));
    }

    #[test]
    fn tick_cross_port_items_get_distinct_route_seqs_in_one_tick() {
        // ROUTE-06 (WR-03): two items routed in the SAME tick to two different
        // input ports of one node must carry distinct, ordered `event_seq`s so a
        // future merge/router has a total cross-port tie-break — not the old
        // "everyone stamped with `now`" tie that left ordering undefined.
        let mut core = core_with_seed(1);
        let s1 = core.state.add_source();
        let s2 = core.state.add_source();
        let sink = core.state.add_source(); // collector: ignores its inbox
        // s1 -> sink port 0 ; s2 -> sink port 1 (distinct input ports).
        core.state.link((s1, 0), (sink, 0));
        core.state.link((s2, 0), (sink, 1));

        core.advance(&[
            fire(s1, 1, 0, Item(vec![0xA])),
            fire(s2, 2, 0, Item(vec![0xB])),
        ]);

        let mut inbox = core.state.inbox_of(sink).cloned().expect("sink inbox");
        let (seq0, _) = inbox.take(0).expect("port 0 item");
        let (seq1, _) = inbox.take(1).expect("port 1 item");
        assert_ne!(seq0, seq1, "cross-port items carry distinct event_seqs");
        assert!(
            seq0 < seq1,
            "route order is a monotonic total order (s1 routed before s2)"
        );
    }

    #[test]
    fn derive_observation_stepped_lists_nodes_that_stepped() {
        // `last_tick.stepped` lists every node the fold stepped this tick. With the
        // slot belt the chain is NOT instant, and feeding a belt is NOT a 0-latency
        // wire (CR-01): at the fire tick ONLY the source steps — it routes the item
        // into the belt's inbox and `schedule_wake`s the belt for the NEXT tick, so the
        // belt steps (and admits to its tail) one tick later. The collector is woken +
        // steps only once the belt delivers its head (after the traverse). An idle tick
        // leaves the observation empty (VIS-03).
        use crate::belt_slots::slot_count;
        let mut core = core_with_seed(1);
        let s = core.state.add_source();
        let b = core.state.add_belt(1);
        let c = core.state.add_source(); // collector
        core.state.link((s, 0), (b, 0));
        core.state.link((b, 0), (c, 0));

        core.advance(&[fire(s, 1, 0, Item(vec![0x11]))]);
        // At the fire tick: ONLY the source stepped; the belt is scheduled for the
        // next tick (feed is not instant), and the collector is untouched.
        assert!(core.last_tick.stepped.contains(&s), "the fired source stepped");
        assert!(!core.last_tick.stepped.contains(&b), "belt not stepped at the fire tick (scheduled next tick)");
        assert!(!core.last_tick.stepped.contains(&c), "collector not yet woken (mid-transport)");
        assert!(core.last_tick.faulted.is_empty(), "no faults on a clean chain");

        // Next tick: the belt's scheduled wake fires and it steps (admitting to tail).
        core.advance(&[]);
        assert!(core.last_tick.stepped.contains(&b), "the admitting belt steps the next tick");

        // Drive the traverse; on the delivering tick the collector is woken + steps.
        // A DERIVED BUDGET (SLOT-04): `slot_count(1) + 1` is the traverse in ADVANCES
        // plus one, and advances are not ticks, so it is multiplied by the interval.
        // It under-ran from an interval of 3 upward and failed at `collector_stepped`,
        // which reads as "the fold never woke the collector".
        let interval = u64::from(crate::belt_slots::DEFAULT_TICKS_PER_SLOT.get()) as usize;
        let mut collector_stepped = false;
        for _ in 0..((slot_count(1) + 1) * interval) {
            core.advance(&[]);
            if core.last_tick.stepped.contains(&c) {
                collector_stepped = true;
                break;
            }
        }
        assert!(collector_stepped, "the collector steps once the belt delivers its head");

        // Once the grid quiesces, an idle tick steps nothing and clears the
        // observation. (A belt that delivers its head still carries a trailing
        // tick+1 wake from its in-step occupancy check — a deterministic, benign
        // no-op step the share-nothing split implies — so drain to quiescence first.)
        // Also a DERIVED BUDGET: the trailing wake chain is per-tick, but a belt still
        // holding an item quiesces only after its remaining advances, each `interval`
        // ticks apart.
        let mut idled = false;
        for _ in 0..(4 * interval) {
            core.advance(&[]);
            if core.last_tick.stepped.is_empty() {
                idled = true;
                break;
            }
        }
        assert!(idled, "the grid quiesces to an idle tick that steps zero nodes");
    }

    #[test]
    fn derive_observation_faulted_lists_fault_producers() {
        // A router with no routes and no default faults every item on FAULT_PORT;
        // the producing router id appears in `last_tick.faulted` (VIS-03 faulted
        // signal). The fault port is left UNWIRED to prove production — not delivery
        // — is what the observation records.
        let mut core = core_with_seed(1);
        let s = core.state.add_source();
        let r = core.state.add_router(Vec::new(), None); // no route, no default
        core.state.link((s, 0), (r, 0));

        core.advance(&[fire(s, 1, 0, Item(vec![0x99]))]);
        assert!(core.last_tick.stepped.contains(&r), "the router stepped");
        assert!(
            core.last_tick.faulted.contains(&r),
            "the router emitted on FAULT_PORT, so it is faulted"
        );
        // The source did NOT fault.
        assert!(!core.last_tick.faulted.contains(&s), "the source did not fault");

        // Next idle tick clears the faulted set.
        core.advance(&[]);
        assert!(core.last_tick.faulted.is_empty(), "faulted clears each tick");
    }

    #[test]
    fn fault_counter_increments_on_undocked_factory_fault_and_survives_restore() {
        // CAT-02 / CONTEXT Area 2: a factory that emits a fault on the reserved
        // FAULT_PORT with NO belt docked there is NOT silently dropped — the fold's
        // drop point increments a deterministic, snapshot-captured per-machine fault
        // counter. Here the fault port is left UNDOCKED to prove the DROP path counts.
        use crate::snapshot::{restore, snapshot};
        use crate::state::Node;

        let mut core = core_with_seed(42);
        // A factory whose JS always throws => every processed input faults with a
        // FactoryError on FAULT_PORT.
        let f = core.state.add_factory(
            "export default function (input, ctx) { throw new Error('boom'); }".to_owned(),
            crate::factory::DEFAULT_GAS_BUDGET,
            7,
        );
        // Deliver one item straight into the factory's input port 0 (an `Input` event
        // admits to any existing node's inbox + wakes it), so it steps + faults THIS
        // tick with its fault port unwired.
        let ev = Event {
            schema_version: SCHEMA_VERSION,
            partition: 0,
            sequence: 1,
            tick: 0,
            payload: EventPayload::Input {
                target: f,
                port: 0,
                item: Item(b"1".to_vec()),
            },
        };
        core.advance(&[ev]);

        // The undocked fault incremented the factory's per-machine counter to 1.
        let faults = match core.state.node(f) {
            Some(Node::Factory(fac)) => fac.faults,
            _ => panic!("the factory node exists"),
        };
        assert_eq!(
            faults, 1,
            "an undocked factory fault increments the snapshot-captured per-machine counter"
        );
        assert!(
            core.last_tick.faulted.contains(&f),
            "the factory emitted on FAULT_PORT, so it is faulted this tick"
        );

        // Determinism: replaying the identical event onto an identical fresh Core
        // yields the identical count (a pure per-node integer increment at a fixed
        // fold point — no non-deterministic path).
        let mut core2 = core_with_seed(42);
        let f2 = core2.state.add_factory(
            "export default function (input, ctx) { throw new Error('boom'); }".to_owned(),
            crate::factory::DEFAULT_GAS_BUDGET,
            7,
        );
        let ev2 = Event {
            schema_version: SCHEMA_VERSION,
            partition: 0,
            sequence: 1,
            tick: 0,
            payload: EventPayload::Input {
                target: f2,
                port: 0,
                item: Item(b"1".to_vec()),
            },
        };
        core2.advance(&[ev2]);
        let faults2 = match core2.state.node(f2) {
            Some(Node::Factory(fac)) => fac.faults,
            _ => panic!("the factory node exists"),
        };
        assert_eq!(faults2, faults, "the fault count is deterministic on replay");

        // The counter is snapshot-captured (appended LAST on `Factory`): it survives a
        // snapshot/restore round-trip at the current schema version.
        let bytes = snapshot(&core);
        let restored = restore(&bytes).expect("a valid Core round-trips through restore");
        let restored_faults = match restored.state.node(f) {
            Some(Node::Factory(fac)) => fac.faults,
            _ => panic!("the factory node survives restore"),
        };
        assert_eq!(
            restored_faults, 1,
            "the per-machine fault counter survives snapshot/restore"
        );
    }

    #[test]
    fn tick_over_cap_output_refused_is_counted_and_conserved() {
        // CR-01. The generic outbox drain mints a `FaultReason::OutputRefused` carrying
        // the refused ITEM's bytes, and that fault is itself bounded by
        // `FAULT_QUEUE_CAP`. Past the bound the dead letter cannot be placed, and the
        // discarded value is the USER'S CONVEYABLE. That drop is now COUNTED through
        // the same `count_dropped_fault` the undocked-fault drop uses, so the loss is
        // inspectable in state and a conservation sum can close.
        //
        // RE-DRIVEN BY PLAN 87-04 (a pinned move, `87-EVIDENCE.md` `## Pinned moves`).
        // Until then this test reached the refusal on a live board: a Factory whose JS
        // emits TWICE on port 0 (the WINDOWS-165 shape) feeding a port-less collector
        // held at `cap - 1`, so the gate cleared one item and the step pushed two. Plan
        // 87-04 closes exactly that hole: the second emit waits in the Factory's queue and
        // leaves on a later step, so that board now delivers both and refuses nothing (leg
        // 2 below reads it), and no machine's step pushes more user items onto a port than
        // the gate cleared. The arm is therefore driven directly, through
        // `readmit_refused`, the drain's refusal arm named for it (leg 1): every call is
        // the arm the drain runs on a refusal, with a user item that left on port 0.
        use crate::admit::{FAULT_QUEUE_CAP, MECHANICAL_INBOX_CAP};
        use crate::fault::{Fault, FAULT_PORT, FaultReason};
        use crate::state::Node;

        const EMITS_TWICE: &str =
            "export default function (input, ctx) { ctx.emit(0, 1); ctx.emit(0, 2); }";
        // THREE refusals past the bound rather than one, so the count below cannot be an
        // off-by-one that happens to land on the right number.
        const OVER: u64 = 3;

        let factory_faults = |core: &Core, f: NodeId| -> u64 {
            match core.state.node(f) {
                Some(Node::Factory(fac)) => fac.faults,
                other => panic!("expected a Factory, got {other:?}"),
            }
        };

        // LEG 1: the refusal arm, `FAULT_QUEUE_CAP + OVER` refused user items.
        let mut core = core_with_seed(0x7101_C201);
        let f = core.state.add_factory(
            EMITS_TWICE.to_owned(),
            crate::factory::DEFAULT_GAS_BUDGET,
            7,
        );
        let refused_total = FAULT_QUEUE_CAP as u64 + OVER;
        let mut fault_len_max = 0usize;
        for k in 0..refused_total {
            super::readmit_refused(&mut core, f, 0, Item(format!("{k}").into_bytes()), k);
            fault_len_max = fault_len_max.max(
                core.state
                    .inbox_of(f)
                    .map_or(0, |i| i.len_on(FAULT_PORT)),
            );
        }

        // NON-VACUITY 1: the fault queue actually REACHED its bound before any drop.
        assert_eq!(
            fault_len_max, FAULT_QUEUE_CAP,
            "the Factory's FAULT_PORT filled to FAULT_QUEUE_CAP by refusal alone \
             before any drop was possible"
        );
        let resting = core.state.inbox_of(f).map_or(0, |i| i.len_on(FAULT_PORT)) as u64;
        assert_eq!(
            resting, FAULT_QUEUE_CAP as u64,
            "and it never grew past the bound"
        );
        let refused_items: Vec<Vec<u8>> = core
            .state
            .inbox_of(f)
            .map_or(Vec::new(), |i| {
                i.items_on(FAULT_PORT)
                    .filter_map(|item| match Fault::decode(item) {
                        Ok(fa) if fa.reason == FaultReason::OutputRefused => Some(fa.payload),
                        _ => None,
                    })
                    .collect()
            });
        assert_eq!(
            refused_items.len(),
            FAULT_QUEUE_CAP,
            "every resting fault is an OutputRefused, so the queue was filled by the \
             path under test and not by some other fault"
        );
        assert_eq!(
            refused_items.first().map(Vec::as_slice),
            Some(&b"0"[..]),
            "a refused user item is wrapped ONCE, its own bytes the payload"
        );

        // THE CLAIM. The over-cap drops are COUNTED, one per refusal past the bound.
        let dropped = factory_faults(&core, f);
        assert_eq!(
            dropped, OVER,
            "each refusal past FAULT_QUEUE_CAP increments the snapshot-captured \
             per-machine counter (a bare `let _ =` here reads 0 and destroys {OVER} \
             conveyables with no record)"
        );
        // CONSERVATION closes only with the new term: every refused item is resting on
        // FAULT_PORT or counted as dropped. Drop either term and the sum is short.
        assert_eq!(
            resting + dropped,
            refused_total,
            "resting {resting} + dropped {dropped} == refused {refused_total}"
        );

        // The new term is snapshot-captured, like the undocked-fault term beside it.
        let bytes = crate::snapshot::snapshot(&core);
        let restored = crate::snapshot::restore(&bytes).expect("the jammed board restores");
        assert_eq!(
            factory_faults(&restored, f),
            dropped,
            "the over-cap drop count survives snapshot/restore"
        );

        // LEG 2: the board this test used to drive, which plan 87-04 closed. The Factory
        // emits twice on port 0 into a port-less collector held at `cap - 1` every round;
        // now the second emit waits in the queue, both arrive, and nothing is refused.
        let mut core = core_with_seed(0x7101_C202);
        let f = core.state.add_factory(
            EMITS_TWICE.to_owned(),
            crate::factory::DEFAULT_GAS_BUDGET,
            7,
        );
        let c = core.state.add_source();
        core.state.link((f, 0), (c, 0));
        /// Hold the collector at most `n` items on port 0, returning how many were taken.
        fn hold_at(core: &mut Core, id: NodeId, n: usize) -> u64 {
            let mut taken = 0u64;
            let inbox = core.state.inbox_mut(id);
            while inbox.len_on(0) > n {
                inbox.take(0).expect("len_on said there was one");
                taken += 1;
            }
            taken
        }
        const ROUNDS: u64 = 40;
        let mut delivered = 0u64;
        for round in 0..ROUNDS {
            delivered += hold_at(&mut core, c, MECHANICAL_INBOX_CAP - 1);
            let ev = Event {
                schema_version: SCHEMA_VERSION,
                partition: 0,
                sequence: round + 1,
                tick: core.tick,
                payload: EventPayload::Input {
                    target: f,
                    port: 0,
                    item: Item(format!("{round}").into_bytes()),
                },
            };
            core.advance(&[ev]);
            // A second tick a round: one input makes two items, which leave one a step,
            // so the Factory's own inbox never reaches its cap and no input is turned
            // away at admission (that would be a refusal of the logged event, not of an
            // emit).
            delivered += hold_at(&mut core, c, MECHANICAL_INBOX_CAP - 1);
            core.advance(&[]);
        }
        let mut idle = 0u64;
        while idle < 400 {
            delivered += hold_at(&mut core, c, 0);
            core.advance(&[]);
            idle += 1;
        }
        delivered += hold_at(&mut core, c, 0);
        let refused_resting = core.state.inbox_of(f).map_or(0, |i| i.len_on(FAULT_PORT));
        assert_eq!(refused_resting, 0, "the two-emit board refuses nothing since plan 87-04");
        assert_eq!(factory_faults(&core, f), 0, "and drops nothing");
        assert_eq!(delivered, 2 * ROUNDS, "both emits of every round arrive");
    }

    #[test]
    fn tick_observation_is_not_snapshotted() {
        // `last_tick` is #[serde(skip)]: forcibly populating it must NOT change the
        // snapshot bytes (zero snapshot-byte impact — the determinism oracle and the
        // frozen corpus never see it).
        let mut core = core_with_seed(7);
        let s = core.state.add_source();
        let b = core.state.add_belt(3);
        let baseline = crate::snapshot::snapshot(&core);

        // Forge a fully-populated observation.
        core.last_tick.stepped.push(s);
        core.last_tick.faulted.push(b);
        core.last_tick.placed.push(s);
        core.last_tick.removed.push(b);

        let after = crate::snapshot::snapshot(&core);
        assert_eq!(
            baseline, after,
            "TickObservation is #[serde(skip)] — populating it changes no snapshot byte"
        );
    }

    // --- Phase-8 two-log EDITS-FIRST merge (08-03 Task 1) ---
    //
    // The legacy inline `EventPayload::Place/Wire/Delete` fold tests were removed in
    // the Phase-8 clean break (decision Q4): topology now folds ONLY through the
    // edit-log (`apply_edit`), so the equivalent coverage lives in the
    // `apply_edit_*` tests below + the corpus 0007/0008 fixtures.

    use crate::ids::PortId;
    use crate::state::{Node, Port};

    use crate::edit::{EDIT_SCHEMA_VERSION, EditOp, EditRecord};

    fn edit_place(kind: u8, seq: u64, tick: u64) -> EditRecord {
        EditRecord {
            schema_version: EDIT_SCHEMA_VERSION,
            partition: 0,
            sequence: seq,
            tick,
            action: 0,
            op: EditOp::Place {
                kind,
                cell_x: 0,
                cell_y: 0,
                w: 1,
                h: 1,
                ports: vec![],
                rot: 0,
            },
        }
    }

    fn edit_delete(node: NodeId, seq: u64, tick: u64) -> EditRecord {
        EditRecord {
            schema_version: EDIT_SCHEMA_VERSION,
            partition: 0,
            sequence: seq,
            tick,
            action: 0,
            op: EditOp::Delete {
                node,
                kind: 0,
                cell_x: 0,
                cell_y: 0,
                captured: Default::default(),
            },
        }
    }

    fn edit_rotate(node: NodeId, new_rot: u8, old_rot: u8, seq: u64, tick: u64) -> EditRecord {
        EditRecord {
            schema_version: EDIT_SCHEMA_VERSION,
            partition: 0,
            sequence: seq,
            tick,
            action: 0,
            op: EditOp::Rotate {
                node,
                new_rot,
                old_rot,
            },
        }
    }

    #[test]
    fn apply_edit_place_mints_node() {
        // An EditOp::Place folded via the edit-log mints exactly one node of the kind
        // and records the minted id in last_tick.placed (apply_edit drives fold_place,
        // the sole topology-fold path after the clean break).
        let mut core = core_with_seed(1);
        core.advance_edits(&[edit_place(super::machine_kind::SOURCE, 1, 0)], &[]);
        assert_eq!(core.state.node_count(), 1, "exactly one node minted");
        assert_eq!(core.last_tick.placed.len(), 1, "the minted id is recorded");
        let id = core.last_tick.placed[0];
        assert!(matches!(core.state.node(id), Some(Node::Source(_))));
    }

    fn edit_place_at(kind: u8, seq: u64, tick: u64, cell_x: i32, cell_y: i32) -> EditRecord {
        EditRecord {
            schema_version: EDIT_SCHEMA_VERSION,
            partition: 0,
            sequence: seq,
            tick,
            action: 0,
            op: EditOp::Place { kind, cell_x, cell_y, w: 1, h: 1, ports: vec![], rot: 0 },
        }
    }

    #[test]
    fn apply_edit_place_writes_cell_into_core() {
        // SPAT-01: a Place folded via the edit-log writes its (cell_x, cell_y) into
        // GridState.cells (the cell now lives in the deterministic core), and the
        // derived occupancy index resolves the reverse lookup.
        let mut core = core_with_seed(1);
        core.advance_edits(&[edit_place_at(super::machine_kind::SOURCE, 1, 0, 4, -7)], &[]);
        let id = core.last_tick.placed[0];
        assert_eq!(core.state.cell_of(id), Some((4, -7)), "Place folds the cell into core");
        assert_eq!(core.state.occupied((4, -7)), Some(id), "occupancy resolves the cell");
    }

    #[test]
    fn fold_delete_clears_cell() {
        // SPAT-01: deleting a placed node clears its cell + occupancy via remove_node.
        let mut core = core_with_seed(1);
        core.advance_edits(&[edit_place_at(super::machine_kind::SOURCE, 1, 0, 2, 2)], &[]);
        let id = core.last_tick.placed[0];
        assert_eq!(core.state.cell_of(id), Some((2, 2)));
        core.advance_edits(&[edit_delete(id, 2, 1)], &[]);
        assert_eq!(core.state.cell_of(id), None, "delete clears the cell");
        assert_eq!(core.state.occupied((2, 2)), None, "delete clears occupancy");
    }

    #[test]
    fn apply_edit_delete_removes_node_and_links() {
        // An EditOp::Delete folded via the edit-log removes the node, its inbox, and
        // every link referencing it, recording the id in last_tick.removed.
        let mut core = core_with_seed(1);
        let s = core.state.add_source();
        let b = core.state.add_belt(0);
        let c = core.state.add_source();
        core.state.link((s, 0), (b, 0));
        core.state.link((b, 0), (c, 0));

        core.advance_edits(&[edit_delete(b, 1, 0)], &[]);
        assert!(core.state.node(b).is_none(), "the node is gone");
        assert!(core.state.inbox_of(b).is_none(), "its inbox is gone");
        assert_eq!(core.last_tick.removed, vec![b], "the removed id is recorded");
        assert_eq!(core.state.link_target((s, 0)), None, "incoming link dropped");
        assert_eq!(core.state.link_target((b, 0)), None, "outgoing link dropped");
        assert_eq!(core.state.node_count(), 2, "s and c remain");
    }

    #[test]
    fn apply_edit_mid_flow_delete_drops_in_flight_item() {
        // Q3: deleting a belt carrying an in-flight item drops the item via the
        // existing missing-link no-op — no panic on later ticks, no resurrection.
        let mut core = core_with_seed(1);
        let s = core.state.add_source();
        let b = core.state.add_belt(3); // latency 3 => the item is mid-flight a while
        let c = core.state.add_source();
        core.state.link((s, 0), (b, 0));
        core.state.link((b, 0), (c, 0));

        // Fire an item; it begins travelling the belt (a future scheduled wake).
        core.advance(&[fire(s, 1, 0, Item(vec![0xAB]))]);
        assert!(core.sched.pending_wakes() > 0, "the belt scheduled a future wake");

        // Mid-flight: delete the belt via the edit-log (EDITS-FIRST).
        core.advance_edits(&[edit_delete(b, 2, 1)], &[]);
        assert!(core.state.node(b).is_none(), "the belt is gone mid-flow");

        // Advance well past the original arrival: no panic on a dead scheduled id,
        // and the item never resurfaces at the collector.
        for _ in 0..5 {
            core.advance(&[]);
        }
        assert!(core.state.node(b).is_none(), "belt stays deleted");
        assert!(
            core.state.inbox_of(c).is_some_and(|i| i.is_empty()),
            "the in-flight item dropped with the belt (never arrived)"
        );
    }

    #[test]
    fn rng_stream_deterministic_factory_place_via_edit_log() {
        // Assumption A2 (re-proven on the two-log model after the clean break):
        // placing a FACTORY via the edit-log draws its sub-seed from the sim RNG
        // deterministically, so the SAME edit-log from the SAME genesis seed yields a
        // byte-identical Core on every replay. `fold_place(FACTORY)` is the ONLY
        // admit-stage RNG consumer — grouping it EDITS-FIRST changes no draw order.
        let build = || {
            let mut core = core_with_seed(0xF00D);
            core.advance_edits(&[edit_place(super::machine_kind::FACTORY, 1, 0)], &[]);
            core
        };
        assert_eq!(
            crate::snapshot::snapshot(&build()),
            crate::snapshot::snapshot(&build()),
            "a factory placed via the edit-log replays byte-identical (deterministic sub-seed draw)"
        );
    }

    #[test]
    fn edit_log_replays_byte_identical() {
        // ELOG-02: replaying the same edit-log from genesis twice (via
        // run_log_two_logs) yields byte-identical GridState — topology is a pure
        // projection of the logged edits (the edit-log analog of
        // gesture_log_replays_byte_identical).
        let build = || {
            let mut core = Core::genesis(LogHeader {
                schema_version: SCHEMA_VERSION,
                seed: 7,
            });
            let s = core.state.add_source();
            let _c = core.state.add_source();
            // 17-02: the node→node Wire edit and Place{BELT} are removed; belts come
            // only from DrawBelt now. The replay-determinism contract holds over the
            // remaining ops (Place + Delete).
            let edits = vec![
                edit_place(super::machine_kind::SOURCE, 1, 0),
                edit_delete(s, 4, 3),
            ];
            core.run_log_two_logs(&edits, &[]).expect("replay within MAX_REPLAY_SPAN");
            core
        };
        let a = build();
        let b = build();
        let ba = postcard::to_allocvec(&a.state).expect("serialize a.state");
        let bb = postcard::to_allocvec(&b.state).expect("serialize b.state");
        assert_eq!(
            ba, bb,
            "same edit-log from genesis => byte-identical projected topology"
        );
    }

    #[test]
    fn advance_equals_advance_edits_with_empty_edit_log() {
        // The back-compat contract documented on `advance`: advancing one tick with
        // event-only `advance` is byte-identical to `advance_edits(&[], events)`.
        let mut a = core_with_seed(3);
        let sa = a.state.add_source();
        let ca = a.state.add_source();
        a.state.link((sa, 0), (ca, 0));

        let mut b = core_with_seed(3);
        let sb = b.state.add_source();
        let cb = b.state.add_source();
        b.state.link((sb, 0), (cb, 0));
        debug_assert_eq!(sa, sb);
        debug_assert_eq!(ca, cb);

        a.advance(&[fire(sa, 1, 0, Item(vec![0x55]))]);
        b.advance_edits(&[], &[fire(sb, 1, 0, Item(vec![0x55]))]);

        assert_eq!(
            crate::snapshot::snapshot(&a),
            crate::snapshot::snapshot(&b),
            "advance(events) == advance_edits(&[], events)"
        );
    }

    // --- Phase-10 fold_rotate (10-06 / FOOT-02) ---

    use crate::state::Footprint;

    #[test]
    fn apply_edit_rotate_reexpands_occupancy_anchor_fixed() {
        // fold_rotate keeps the anchor FIXED, frees the old footprint cells, sets
        // rot=new_rot, and re-expands the new rectangle into occupancy (verbatim, no
        // collision re-check). A 2×3 at (5,5) [x{5,6} y{5,6,7}] rotated +1 becomes a
        // 3×2 [x{5,6,7} y{5,6}].
        let mut core = core_with_seed(1);
        let m = core.state.add_router(vec![], Some(0));
        core.state.claim_footprint(m, (5, 5), 2, 3, 0);
        // Before: (6,7) is a body cell; (7,5) is free.
        assert_eq!(core.state.occupied((6, 7)), Some(m), "rot0 body cell occupied");
        assert_eq!(core.state.occupied((7, 5)), None, "rot0 leaves (7,5) free");

        core.advance_edits(&[edit_rotate(m, 1, 0, 1, 0)], &[]);

        assert_eq!(core.state.cell_of(m), Some((5, 5)), "anchor is FIXED on rotate");
        assert_eq!(core.state.occupied((7, 5)), Some(m), "new rot1 body cell claimed");
        assert_eq!(core.state.occupied((6, 7)), None, "old rot0 body cell freed");
        assert_eq!(
            core.state.footprint_of(m),
            Some(Footprint { w: 2, h: 3, rot: 1 }),
            "rot re-stamped to 1 (dims unchanged, anchor-frame w/h)"
        );
    }

    #[test]
    fn apply_edit_rotate_selective_de_dock_belt_survives_unlinked() {
        // CAT-06 (the SPIKE) — REWRITTEN from the old cascade-DESTROY semantics.
        // Rotating a machine spins its port world-side; a dock the rotated port no
        // longer FACES is deterministically UNLINKED — but the belt NODE SURVIVES
        // disconnected (never removed, never re-drawn). Only the ONE link drops; it is
        // recorded into last_tick.unlinked (NOT last_tick.removed), no sched.remove,
        // and the post-rotate state still validates on restore.
        use crate::state::{Axis, Medium, Port, Role, Side, TileKind};
        let mut core = core_with_seed(1);
        // A 1×1 machine at (5,5) with a single Out port facing E (world facing cell
        // (6,5) at rot0). A 1×1 keeps its anchor cell under rotation but SPINS the
        // port side (rot1: E→S, facing (5,6)) — the clean de-dock witness.
        let m = core.state.add_router(vec![], Some(0));
        core.state.claim_footprint(m, (5, 5), 1, 1, 0);
        core.state.set_ports(
            m,
            vec![Port { local_offset: (0, 0), side: Side::E, role: Role::Out, medium: Medium::Mechanical }],
        );
        // A 2-tile drawn belt whose TAIL (first tile) sits on the port's rot0 facing
        // cell (6,5); flow runs east so its outward side is W == opposite(E) → the
        // dock is legal at rot0.
        let geom = vec![
            BeltTile::new((6, 5), TileKind::Straight { axis: Axis::X }),
            BeltTile::new((7, 5), TileKind::Straight { axis: Axis::X }),
        ];
        let belt = core.state.add_belt(2);
        if let Some(Node::Belt(b)) = core.state.node_mut(belt) {
            b.geometry = geom.clone();
        }
        core.state.claim_belt_tiles(belt, &geom);
        // Tail dock (machine Out offloads onto the belt): link((m,0) -> (belt,0)).
        core.state.link((m, 0), (belt, 0));
        assert_eq!(
            core.state.link_target((m, 0)),
            Some((belt, 0)),
            "the fault-free Tail dock link exists pre-rotate"
        );

        core.advance_edits(&[edit_rotate(m, 1, 0, 1, 0)], &[]);

        // The belt NODE survives (opposite of the old cascade-destroy).
        assert!(core.state.node(belt).is_some(), "the de-docked belt SURVIVES");
        assert!(core.state.node(m).is_some(), "the rotated machine remains");
        // Its ONE dock link is gone (the port now faces (5,6), not the belt (6,5)).
        assert_eq!(
            core.state.link_target((m, 0)),
            None,
            "the stranded dock link is unlinked"
        );
        // Recorded in last_tick.unlinked (NOT removed — the belt was not destroyed).
        assert!(core.last_tick.removed.is_empty(), "nothing was removed");
        assert_eq!(core.last_tick.unlinked.len(), 1, "exactly one de-dock recorded");
        let ud = core.last_tick.unlinked[0];
        assert_eq!(ud.belt, belt, "the surviving belt id");
        assert_eq!(ud.node, m, "the rotated machine id");
        assert_eq!(ud.port, 0, "the machine port that stranded");
        assert_eq!(ud.endpoint, crate::edit::BeltEnd::Tail, "the Tail dock end");
        // Both a kept and a dropped dock must leave a snapshot the invariant gate
        // accepts (T-17-ROT-ILLEGAL) — here the dropped dock leaves a legal grid.
        assert!(
            crate::snapshot::restore(&crate::snapshot::snapshot(&core)).is_ok(),
            "post-rotate state is structurally valid (no stranded wake, no illegal dock)"
        );
    }

    #[test]
    fn fold_rotate_four_quarter_turns_is_identity() {
        // rotate90⁴ == identity THROUGH THE FOLD: four +1 rotations return the
        // GridState to byte-identical (occupancy is #[serde(skip)] and re-expands the
        // same; footprints[m].rot cycles 0→1→2→3→0; the anchor never moves).
        let mut core = core_with_seed(1);
        let m = core.state.add_router(vec![], Some(0));
        core.state.claim_footprint(m, (5, 5), 2, 3, 0);
        let before = postcard::to_allocvec(&core.state).expect("serialize GridState");
        for (seq, (new_rot, old_rot)) in [(1u8, 0u8), (2, 1), (3, 2), (0, 3)].into_iter().enumerate() {
            core.advance_edits(&[edit_rotate(m, new_rot, old_rot, seq as u64, seq as u64)], &[]);
        }
        let after = postcard::to_allocvec(&core.state).expect("serialize GridState");
        assert_eq!(
            before, after,
            "rotate90⁴ == identity through the fold (GridState byte-identical)"
        );
    }

    // --- CAT-06 selective rotate de-dock landmines (the SPIKE) ---

    /// Build a fresh core with a 1×1 machine at (5,5) carrying `ports` and a drawn
    /// belt of `geom` (occupancy claimed). Caller wires the dock links. Returns
    /// (core, machine_id, belt_id).
    fn dedock_fixture(
        ports: Vec<crate::state::Port>,
        geom: Vec<crate::state::BeltTile>,
    ) -> (Core, NodeId, NodeId) {
        let mut core = core_with_seed(1);
        let m = core.state.add_router(vec![], Some(0));
        core.state.claim_footprint(m, (5, 5), 1, 1, 0);
        core.state.set_ports(m, ports);
        let belt = core.state.add_belt(geom.len() as u32);
        if let Some(Node::Belt(b)) = core.state.node_mut(belt) {
            b.geometry = geom.clone();
        }
        core.state.claim_belt_tiles(belt, &geom);
        (core, m, belt)
    }

    #[test]
    fn rotate_dedock_both_ends() {
        // Landmine 1: ONE belt docked BOTH ends to the SAME rotating machine gets TWO
        // INDEPENDENT verdicts (raw-links walk, NOT deduped belt ids). Under rot1 the
        // In@W port keeps its Head dock (faces (5,4)) while the Out@S port loses its
        // Tail dock (now faces (4,5), not the belt tail (5,6)).
        use crate::state::{Axis, Medium, Port, Role, Side, TileKind};
        // A U-belt around the machine: TAIL (first) (5,6) south, HEAD (last) (5,4)
        // north, with the pre-head tile (5,3) so the Head outward side is S.
        let geom = vec![
            BeltTile::new((5, 6), TileKind::Straight { axis: Axis::Y }),
            BeltTile::new((6, 6), TileKind::Straight { axis: Axis::X }),
            BeltTile::new((6, 5), TileKind::Straight { axis: Axis::Y }),
            BeltTile::new((6, 4), TileKind::Straight { axis: Axis::Y }),
            BeltTile::new((6, 3), TileKind::Straight { axis: Axis::X }),
            BeltTile::new((5, 3), TileKind::Straight { axis: Axis::Y }),
            BeltTile::new((5, 4), TileKind::Straight { axis: Axis::Y }),
        ];
        let ports = vec![
            Port { local_offset: (0, 0), side: Side::W, role: Role::In, medium: Medium::Mechanical }, // catalog 0 (Head)
            Port { local_offset: (0, 0), side: Side::S, role: Role::Out, medium: Medium::Mechanical }, // catalog 1 (Tail)
        ];
        let (mut core, m, belt) = dedock_fixture(ports, geom);
        // Head dock: belt delivers into In (catalog idx 0, the raw inbox key)
        // => link((belt,0) -> (m,0)).
        core.state.link((belt, 0), (m, 0));
        // Tail dock: the Out (catalog idx 1) offloads onto the belt. Its link key is
        // the Out ROUTING key — the 0-based index among Role::Out ports (Finding 1):
        // the single Out routes as 0 => link((m,0) -> (belt,0)).
        core.state.link((m, 0), (belt, 0));

        core.advance_edits(&[edit_rotate(m, 1, 0, 1, 0)], &[]);

        assert!(core.state.node(belt).is_some(), "the belt survives (never destroyed)");
        // Head dock KEPT: In@W spun to N faces (5,4) == belt HEAD tile.
        assert_eq!(
            core.state.link_target((belt, 0)),
            Some((m, 0)),
            "the still-facing Head dock is KEPT"
        );
        // Tail dock DROPPED: Out@S spun to W faces (4,5) != belt TAIL tile (5,6).
        assert_eq!(core.state.link_target((m, 0)), None, "the stranded Tail dock is unlinked");
        assert_eq!(core.last_tick.unlinked.len(), 1, "exactly ONE end de-docked (independent)");
        let ud = core.last_tick.unlinked[0];
        assert_eq!(ud.endpoint, crate::edit::BeltEnd::Tail, "the Tail end de-docked");
        assert_eq!(ud.port, 0, "the Out ROUTING key (0 = the machine's 0th Out) stranded");
        assert!(core.last_tick.removed.is_empty(), "nothing removed");
    }

    #[test]
    fn rotate_dedock_tail_key_resolves_nth_out_not_catalog_index() {
        // Finding 1's REVERSE map (the CAT-06 keep-or-unlink mirror): a Tail-dock link
        // key lives in the Out ROUTING keyspace, so `dock_still_reaches` must resolve
        // it as the n-th Role::Out port — NOT as a raw catalog index. Here the machine
        // is [In@W (catalog 0), Out@E (catalog 1)] and the Tail dock is keyed on
        // routing 0 (the 0th Out). A rot0->rot0 re-judge must resolve key 0 to the
        // Out@E nub (which faces the belt tail at (6,5)) and KEEP the dock. A raw
        // catalog read of index 0 would judge the In@W nub (faces (4,5)) and wrongly
        // de-dock a perfectly-docked belt.
        use crate::state::{Axis, Medium, Port, Role, Side, TileKind};
        let geom = vec![
            BeltTile::new((6, 5), TileKind::Straight { axis: Axis::X }),
            BeltTile::new((7, 5), TileKind::Straight { axis: Axis::X }),
        ];
        let ports = vec![
            Port { local_offset: (0, 0), side: Side::W, role: Role::In, medium: Medium::Mechanical }, // catalog 0
            Port { local_offset: (0, 0), side: Side::E, role: Role::Out, medium: Medium::Mechanical }, // catalog 1, routing 0
        ];
        let (mut core, m, belt) = dedock_fixture(ports, geom);
        // Tail dock in the ROUTING keyspace: the 0th Out => link((m,0) -> (belt,0)).
        core.state.link((m, 0), (belt, 0));

        core.advance_edits(&[edit_rotate(m, 0, 0, 1, 0)], &[]);

        assert_eq!(
            core.state.link_target((m, 0)),
            Some((belt, 0)),
            "the Tail link key resolves to the 0th Role::Out (E, still facing) — KEPT"
        );
        assert!(
            core.last_tick.unlinked.is_empty(),
            "no de-dock: routing key 0 is the Out@E nub, not the In@W catalog slot"
        );
    }

    #[test]
    fn rotate_dedock_single_tile() {
        // Landmine 3: a SINGLE-tile belt (Head == Tail == same cell, no inner
        // neighbour) must NOT panic on geom[len-2] and gets a correct verdict.
        use crate::state::{Axis, Medium, Port, Role, Side, TileKind};
        let geom = vec![BeltTile::new((6, 5), TileKind::Straight { axis: Axis::X })];
        let ports = vec![Port { local_offset: (0, 0), side: Side::E, role: Role::Out, medium: Medium::Mechanical }];
        // KEEP branch: rot0->rot0 re-judge — Out@E still faces (6,5), outward==None so
        // adjacency+facing alone decides — no spurious drop, no panic.
        let (mut keep, mk, _kb) = dedock_fixture(ports.clone(), geom.clone());
        keep.state.link((mk, 0), (_kb, 0)); // Tail dock
        keep.advance_edits(&[edit_rotate(mk, 0, 0, 1, 0)], &[]);
        assert_eq!(keep.state.link_target((mk, 0)), Some((_kb, 0)), "single-tile dock KEPT when still facing");
        assert!(keep.last_tick.unlinked.is_empty(), "no de-dock, no panic (single tile)");
        // DROP branch: rot0->rot1 — Out@E spins to S facing (5,6) != (6,5).
        let (mut drop, md, db) = dedock_fixture(ports, geom);
        drop.state.link((md, 0), (db, 0)); // Tail dock
        drop.advance_edits(&[edit_rotate(md, 1, 0, 1, 0)], &[]);
        assert!(drop.state.node(db).is_some(), "single-tile belt survives");
        assert_eq!(drop.state.link_target((md, 0)), None, "single-tile dock unlinked when no longer facing");
        assert_eq!(drop.last_tick.unlinked.len(), 1, "single-tile de-dock recorded (no panic)");
    }

    #[test]
    fn rotate_dedock_keeps_when_still_facing() {
        // A genuine rotation that KEEPS the dock: Out@E on a 1×1 spins to S under rot1
        // and faces (5,6); the belt TAIL sits at (5,6) with outward N == opposite(S),
        // so the facing-side predicate keeps it. No link is rewritten to keep it.
        use crate::state::{Axis, Medium, Port, Role, Side, TileKind};
        let geom = vec![
            BeltTile::new((5, 6), TileKind::Straight { axis: Axis::Y }),
            BeltTile::new((5, 7), TileKind::Straight { axis: Axis::Y }),
        ];
        let ports = vec![Port { local_offset: (0, 0), side: Side::E, role: Role::Out, medium: Medium::Mechanical }];
        let (mut core, m, belt) = dedock_fixture(ports, geom);
        core.state.link((m, 0), (belt, 0)); // Tail dock

        core.advance_edits(&[edit_rotate(m, 1, 0, 1, 0)], &[]);

        assert_eq!(
            core.state.link_target((m, 0)),
            Some((belt, 0)),
            "the dock is KEPT (port still faces the belt end after rotate)"
        );
        assert!(core.last_tick.unlinked.is_empty(), "no de-dock when still facing");
    }

    #[test]
    fn rotate_dedock_drops_when_no_longer_facing() {
        // The DROP mirror: Out@E on a 1×1 spins to S under rot1 facing (5,6); the belt
        // TAIL sits at (6,5) (east) so the port no longer faces it -> deterministic unlink.
        use crate::state::{Axis, Medium, Port, Role, Side, TileKind};
        let geom = vec![
            BeltTile::new((6, 5), TileKind::Straight { axis: Axis::X }),
            BeltTile::new((7, 5), TileKind::Straight { axis: Axis::X }),
        ];
        let ports = vec![Port { local_offset: (0, 0), side: Side::E, role: Role::Out, medium: Medium::Mechanical }];
        let (mut core, m, belt) = dedock_fixture(ports, geom);
        core.state.link((m, 0), (belt, 0)); // Tail dock

        core.advance_edits(&[edit_rotate(m, 1, 0, 1, 0)], &[]);

        assert!(core.state.node(belt).is_some(), "belt survives disconnected");
        assert_eq!(core.state.link_target((m, 0)), None, "the dock is unlinked (no longer facing)");
        assert_eq!(core.last_tick.unlinked.len(), 1, "the de-dock is recorded");
    }

    #[test]
    fn rotate_dedock_1x1_port_spin() {
        // Landmine 7: a 1×1 keeps its anchor cell but the port SIDE spins; the SAME
        // fixed belt is kept or dropped purely by the port's new facing side. Belt TAIL
        // at (5,6): rot1 (Out@E->S) faces (5,6) => KEEP; rot2 (Out@E->W) faces (4,5) => DROP.
        use crate::state::{Axis, Medium, Port, Role, Side, TileKind};
        let geom = vec![
            BeltTile::new((5, 6), TileKind::Straight { axis: Axis::Y }),
            BeltTile::new((5, 7), TileKind::Straight { axis: Axis::Y }),
        ];
        let ports = vec![Port { local_offset: (0, 0), side: Side::E, role: Role::Out, medium: Medium::Mechanical }];

        let (mut keep, mk, kb) = dedock_fixture(ports.clone(), geom.clone());
        keep.state.link((mk, 0), (kb, 0));
        keep.advance_edits(&[edit_rotate(mk, 1, 0, 1, 0)], &[]);
        assert_eq!(keep.state.link_target((mk, 0)), Some((kb, 0)), "rot1 spins Out to S -> faces belt -> KEEP");
        assert!(keep.last_tick.unlinked.is_empty(), "no de-dock at rot1");

        let (mut drop, md, db) = dedock_fixture(ports, geom);
        drop.state.link((md, 0), (db, 0));
        drop.advance_edits(&[edit_rotate(md, 2, 0, 1, 0)], &[]);
        assert_eq!(drop.state.link_target((md, 0)), None, "rot2 spins Out to W -> faces away -> DROP");
        assert_eq!(drop.last_tick.unlinked.len(), 1, "de-dock at rot2");
    }

    use proptest::prelude::*;

    proptest! {
        /// Determinism (DET / T-17-ROT-DETERM): the de-dock is a deterministic DERIVED
        /// consequence of Rotate, so replaying the SAME rotate edit-log on two fresh
        /// cores yields BYTE-IDENTICAL snapshots (no logged unlink op; pure-i32 verdict).
        #[test]
        fn rotate_replay_is_byte_identical(
            rots in proptest::collection::vec(0u8..4, 1..6),
            port_side in 0u8..4,
        ) {
            use crate::state::{Axis, Medium, Port, Role, Side, TileKind};
            let build = |rots: &[u8], port_side: u8| -> Vec<u8> {
                let mut core = core_with_seed(7);
                let m = core.state.add_router(vec![], Some(0));
                core.state.claim_footprint(m, (5, 5), 1, 1, 0);
                core.state.set_ports(
                    m,
                    vec![Port { local_offset: (0, 0), side: Side::from(port_side), role: Role::Out, medium: Medium::Mechanical }],
                );
                let geom = vec![
                    BeltTile::new((6, 5), TileKind::Straight { axis: Axis::X }),
                    BeltTile::new((7, 5), TileKind::Straight { axis: Axis::X }),
                ];
                let belt = core.state.add_belt(2);
                if let Some(Node::Belt(b)) = core.state.node_mut(belt) {
                    b.geometry = geom.clone();
                }
                core.state.claim_belt_tiles(belt, &geom);
                core.state.link((m, 0), (belt, 0)); // Tail dock
                let mut prev = 0u8;
                for (seq, &r) in rots.iter().enumerate() {
                    core.advance_edits(&[edit_rotate(m, r, prev, seq as u64, seq as u64)], &[]);
                    prev = r;
                }
                crate::snapshot::snapshot(&core)
            };
            let a = build(&rots, port_side);
            let b = build(&rots, port_side);
            prop_assert_eq!(a, b, "the same rotate edit-log replays byte-identically");
        }
    }

    // --- Phase-11 fold_draw_belt (11-02 / BELT-01..06) ---

    use crate::state::{Axis, BeltTile, TileKind};

    fn edit_draw_belt(tiles: Vec<BeltTile>, seq: u64, tick: u64) -> EditRecord {
        EditRecord {
            schema_version: EDIT_SCHEMA_VERSION,
            partition: 0,
            sequence: seq,
            tick,
            action: 0,
            op: EditOp::DrawBelt { tiles },
        }
    }

    #[test]
    fn apply_edit_draw_belt_mints_slot_belt_and_claims_tiles() {
        use crate::belt_slots::slot_count;
        // A resolved DrawBelt of 3 straight tiles mints ONE belt with
        // SLOTS_PER_TILE*3 empty slots, stores the geometry VERBATIM, and CLAIMS each
        // tile cell into the unified occupancy index (BELT-04/06).
        let mut core = core_with_seed(1);
        let tiles = vec![
            BeltTile::new((2, 2), TileKind::Straight { axis: Axis::X }),
            BeltTile::new((3, 2), TileKind::Straight { axis: Axis::X }),
            BeltTile::new((4, 2), TileKind::Straight { axis: Axis::X }),
        ];
        core.advance_edits(&[edit_draw_belt(tiles.clone(), 1, 0)], &[]);

        assert_eq!(core.last_tick.placed.len(), 1, "exactly one belt minted");
        let belt = core.last_tick.placed[0];
        match core.state.node(belt) {
            Some(Node::Belt(b)) => {
                assert_eq!(b.tiles, 3, "tile count == drawn tiles");
                assert_eq!(b.slots.len(), slot_count(3), "SLOTS_PER_TILE*3 slots");
                assert!(b.slots.iter().all(Option::is_none), "fresh belt is empty");
                assert_eq!(b.geometry, tiles, "geometry applied verbatim");
            }
            other => panic!("expected a Belt, got {other:?}"),
        }
        // Every tile cell is claimed into the unified occupancy index.
        for t in &tiles {
            assert_eq!(core.state.occupied(t.cell), Some(belt), "tile cell {:?} claimed", t.cell);
        }
        assert_eq!(core.state.occupied((5, 2)), None, "a cell off the belt is free");
    }

    /// LINK-08 clause (ii) / D-04, on a DRAWN belt folded through the certified path.
    ///
    /// The sibling case in `state.rs` proves the same shape on a `Wire`-minted
    /// (geometry-empty) belt. Both are needed and neither substitutes for the other:
    /// D-06's whole content is that the answer does NOT depend on which of the two a belt
    /// is, so a case covering only one of them would leave the other undefined.
    ///
    /// It also asserts that the ports SURVIVE A SNAPSHOT ROUND-TRIP, because stored is
    /// the whole point (D-04): a derived-on-read implementation would pass every
    /// assertion above the round-trip and fail the ones below it.
    #[test]
    fn apply_edit_draw_belt_declares_both_belt_ports_in_first() {
        use crate::state::{Medium, Role};
        let mut core = core_with_seed(1);
        let tiles = vec![
            BeltTile::new((2, 2), TileKind::Straight { axis: Axis::X }),
            BeltTile::new((3, 2), TileKind::Straight { axis: Axis::X }),
        ];
        core.advance_edits(&[edit_draw_belt(tiles, 1, 0)], &[]);
        let belt = core.last_tick.placed[0];

        let check = |ports: &[crate::state::Port], where_: &str| {
            assert_eq!(ports.len(), 2, "a drawn belt declares exactly two ports ({where_})");
            assert_eq!(ports[0].role, Role::In, "index 0 is the TAIL, Role::In ({where_})");
            assert_eq!(ports[1].role, Role::Out, "index 1 is the HEAD, Role::Out ({where_})");
            assert_eq!(ports[0].local_offset, (0, 0), "belt ports sit at (0,0) ({where_})");
            assert_eq!(ports[1].local_offset, (0, 0), "belt ports sit at (0,0) ({where_})");
            assert_eq!(ports[0].medium, Medium::Mechanical, "Mechanical carrier ({where_})");
            assert_eq!(ports[1].medium, Medium::Mechanical, "Mechanical carrier ({where_})");
        };
        check(
            core.state.ports_of(belt).expect("a drawn belt is a ported node"),
            "live",
        );

        // STORED, not derived: the two records come back out of the serialized bytes.
        let bytes = crate::snapshot::snapshot(&core);
        let restored = crate::snapshot::restore(&bytes).expect("the belt-ported snapshot restores");
        check(
            restored
                .state
                .ports_of(belt)
                .expect("the belt is still a ported node after a snapshot round-trip"),
            "restored",
        );
    }

    #[test]
    fn draw_belt_geometry_survives_snapshot_and_rebuilds_occupancy() {
        // BELT-06 / RESEARCH Pitfall 5: a drawn belt's geometry is the single
        // serialized truth; a snapshot round-trip re-claims its tile cells into
        // occupancy via rebuild_occupancy (the trust gate accepts it).
        let mut core = core_with_seed(1);
        let tiles = vec![
            BeltTile::new((0, 0), TileKind::Straight { axis: Axis::Y }),
            BeltTile::new((0, 1), TileKind::Corner { from: crate::state::Dir::S, to: crate::state::Dir::E }),
        ];
        core.advance_edits(&[edit_draw_belt(tiles.clone(), 1, 0)], &[]);
        let belt = core.last_tick.placed[0];

        let bytes = crate::snapshot::snapshot(&core);
        let restored = crate::snapshot::restore(&bytes).expect("drawn belt restores through the gate");
        // The restored twin re-claims the belt tile cells into occupancy.
        for t in &tiles {
            assert_eq!(restored.state.occupied(t.cell), Some(belt), "tile {:?} re-claimed on restore", t.cell);
        }
        assert_eq!(bytes, crate::snapshot::snapshot(&restored), "drawn belt round-trips byte-identically");
    }

    // --- Phase-11 fold_dock (11-06 / BELT-05/06) ---

    use crate::edit::BeltEnd;

    fn edit_dock(belt: NodeId, endpoint: BeltEnd, node: NodeId, port: PortId, seq: u64, tick: u64) -> EditRecord {
        EditRecord {
            schema_version: EDIT_SCHEMA_VERSION,
            partition: 0,
            sequence: seq,
            tick,
            action: 0,
            op: EditOp::Dock { belt, endpoint, node, port },
        }
    }

    #[test]
    fn apply_edit_dock_tail_links_machine_out_into_belt_tail() {
        // OFFLOAD: docking the belt TAIL to a machine port links (node, port) -> (belt, 0)
        // — the machine feeds items onto the belt's admit end. Applied VERBATIM.
        let mut core = core_with_seed(1);
        let belt = core.state.add_belt(3);
        let machine = core.state.add_source();
        core.advance_edits(&[edit_dock(belt, BeltEnd::Tail, machine, 0, 1, 0)], &[]);

        assert_eq!(
            core.state.link_target((machine, 0)),
            Some((belt, 0)),
            "an offload (Tail) dock links machine.Out -> belt.tail (port 0)"
        );
        assert!(core.last_tick.placed.is_empty(), "a dock mints no node");
    }

    #[test]
    fn apply_edit_dock_head_links_belt_head_into_machine_in() {
        // LOAD: docking the belt HEAD to a machine port links (belt, 0) -> (node, port)
        // — the belt delivers items into the machine's input.
        let mut core = core_with_seed(1);
        let belt = core.state.add_belt(3);
        let machine = core.state.add_source();
        core.advance_edits(&[edit_dock(belt, BeltEnd::Head, machine, 2, 1, 0)], &[]);

        assert_eq!(
            core.state.link_target((belt, 0)),
            Some((machine, 2)),
            "a load (Head) dock links belt.head (port 0) -> machine.In"
        );
        assert!(core.last_tick.placed.is_empty(), "a dock mints no node");
    }

    #[test]
    fn apply_edit_dock_absent_endpoint_is_panic_free_no_op() {
        // T-11-DOCK-FOLD: a dock referencing an absent belt OR machine node is a
        // panic-free no-op (mirror fold_wire's missing-endpoint guard) — no dangling
        // link survives.
        let mut core = core_with_seed(1);
        let belt = core.state.add_belt(3);
        let machine = core.state.add_source();
        let live = core.state.add_source();
        // Remove the machine, then fold a dock referencing it: no panic, no link.
        core.advance_edits(&[edit_delete(machine, 0, core.tick)], &[]);
        core.advance_edits(&[edit_dock(belt, BeltEnd::Tail, machine, 0, 1, core.tick)], &[]);
        assert_eq!(core.state.link_target((machine, 0)), None, "no link to the dead machine");
        assert_eq!(core.state.link_target((belt, 0)), None, "no dangling belt link");

        // A dock of an absent belt is equally a no-op.
        core.advance_edits(&[edit_delete(belt, 2, core.tick)], &[]);
        core.advance_edits(&[edit_dock(belt, BeltEnd::Head, live, 0, 3, core.tick)], &[]);
        assert_eq!(core.state.link_target((belt, 0)), None, "no link from the dead belt");
    }

    // --- Phase-12 fold_unlink + fold-NOOP markers (12-01 / UNDO-01) ---

    fn edit_unlink(belt: NodeId, endpoint: BeltEnd, node: NodeId, port: PortId, seq: u64, tick: u64) -> EditRecord {
        EditRecord {
            schema_version: EDIT_SCHEMA_VERSION,
            partition: 0,
            sequence: seq,
            tick,
            action: 0,
            op: EditOp::Unlink { belt, endpoint, node, port },
        }
    }

    #[test]
    fn fold_unlink_is_the_exact_inverse_of_fold_dock() {
        // Dock a belt HEAD into a machine, assert the link exists, then fold the
        // inverse Unlink and assert the link is gone and the rest of the topology is
        // unchanged (the machine + belt nodes survive).
        let mut core = core_with_seed(1);
        let belt = core.state.add_belt(3);
        let machine = core.state.add_source();
        core.advance_edits(&[edit_dock(belt, BeltEnd::Head, machine, 2, 1, 0)], &[]);
        assert_eq!(
            core.state.link_target((belt, 0)),
            Some((machine, 2)),
            "the Head dock linked belt.head -> machine.In"
        );

        core.advance_edits(&[edit_unlink(belt, BeltEnd::Head, machine, 2, 2, 1)], &[]);
        assert_eq!(
            core.state.link_target((belt, 0)),
            None,
            "fold_unlink removed exactly the docked link (inverse of fold_dock)"
        );
        assert!(core.state.node(belt).is_some(), "the belt node survives the unlink");
        assert!(core.state.node(machine).is_some(), "the machine node survives the unlink");

        // The Tail direction removes the (node, port) key (the mirror of the Tail dock).
        core.advance_edits(&[edit_dock(belt, BeltEnd::Tail, machine, 0, 3, 2)], &[]);
        assert_eq!(core.state.link_target((machine, 0)), Some((belt, 0)), "Tail dock linked machine.Out -> belt");
        core.advance_edits(&[edit_unlink(belt, BeltEnd::Tail, machine, 0, 4, 3)], &[]);
        assert_eq!(core.state.link_target((machine, 0)), None, "fold_unlink(Tail) removed the (node, port) key");
    }

    #[test]
    fn fold_unlink_of_an_absent_link_is_a_panic_free_no_op() {
        // A forged Unlink whose key was never linked is a panic-free no-op (unlink of
        // an absent key just returns), leaving GridState byte-identical.
        let mut core = core_with_seed(1);
        let belt = core.state.add_belt(3);
        let machine = core.state.add_source();
        let before = postcard::to_allocvec(&core.state).expect("serialize GridState");
        core.advance_edits(&[edit_unlink(belt, BeltEnd::Head, machine, 7, 1, 0)], &[]);
        let after = postcard::to_allocvec(&core.state).expect("serialize GridState");
        assert_eq!(before, after, "unlink of a never-linked key changes zero GridState bytes");
    }

    #[test]
    fn fold_undo_redo_markers_change_zero_gridstate_bytes() {
        // Undo/Redo are fold-NOOP lineage markers — folding one leaves GridState
        // byte-identical (snapshot before == after).
        let mut core = core_with_seed(1);
        let belt = core.state.add_belt(3);
        let machine = core.state.add_source();
        core.advance_edits(&[edit_dock(belt, BeltEnd::Head, machine, 2, 1, 0)], &[]);
        let before = postcard::to_allocvec(&core.state).expect("serialize GridState");

        let undo = EditRecord {
            schema_version: EDIT_SCHEMA_VERSION,
            partition: 0,
            sequence: 2,
            tick: 1,
            action: 0,
            op: EditOp::Undo { target_action: 99 },
        };
        let redo = EditRecord {
            schema_version: EDIT_SCHEMA_VERSION,
            partition: 0,
            sequence: 3,
            tick: 2,
            action: 0,
            op: EditOp::Redo { target_action: 99 },
        };
        core.advance_edits(&[undo, redo], &[]);
        let after = postcard::to_allocvec(&core.state).expect("serialize GridState");
        assert_eq!(before, after, "folding Undo/Redo markers changes zero GridState bytes");
    }

    // ───────────────── PORT-07: fold_add_port / fold_remove_port (36-01) ─────────────────

    /// An `AddPort` record naming an explicit slot (73-03).
    fn edit_add_port_at(
        node: NodeId,
        port: Port,
        index: PortId,
        seq: u64,
        tick: u64,
    ) -> EditRecord {
        EditRecord {
            schema_version: EDIT_SCHEMA_VERSION,
            partition: 0,
            sequence: seq,
            tick,
            action: 0,
            op: EditOp::AddPort { node, port, index, seat: crate::edit::PortSeat::Auto },
        }
    }

    /// An APPENDING `AddPort`, which is what every forward gesture produces: the record's
    /// `index` is resolved to the CURRENT port-list length at validate time, so the fold's
    /// indexed insert lands exactly where its pre-73-03 `push` did. Reading the length off
    /// the live core here rather than hard-coding it is what keeps these tests a statement
    /// about APPENDING rather than about a particular board.
    fn edit_add_port(core: &Core, node: NodeId, port: Port, seq: u64, tick: u64) -> EditRecord {
        let at = core.state.ports_of(node).map_or(0, <[Port]>::len);
        edit_add_port_at(
            node,
            port,
            PortId::try_from(at).unwrap_or(PortId::MAX),
            seq,
            tick,
        )
    }

    fn edit_remove_port(node: NodeId, index: PortId, seq: u64, tick: u64) -> EditRecord {
        EditRecord {
            schema_version: EDIT_SCHEMA_VERSION,
            partition: 0,
            sequence: seq,
            tick,
            action: 0,
            op: EditOp::RemovePort { node, index, restore: None },
        }
    }

    /// A mechanical port of `role` (offset/side are re-seated by the fold).
    fn mech_port(role: crate::state::Role) -> Port {
        use crate::state::{Medium, Side};
        Port { local_offset: (0, 0), side: Side::N, role, medium: Medium::Mechanical }
    }

    /// A placed Router (2×3 at (5,5)) seeded 1-in / 2-out with CANONICALLY-SEATED
    /// ports - the faithful preset-born shape (In_0→(0,1)W, Out_0→(1,1)E, Out_1→(1,2)E)
    /// for which `footprint == grow_to_fit(base, ports)` and the ports are already at
    /// their re-seated slots (so a subsequent resize is a fixed point).
    fn placed_router_seed() -> (Core, NodeId) {
        use crate::state::{Medium, Role, Side};
        let mut core = core_with_seed(1);
        let m = core.state.add_router(vec![], Some(0));
        core.state.claim_footprint(m, (5, 5), 2, 3, 0);
        // Seated as every port edit seats a 1-in/2-out list on the 2x3 Router base since
        // 74.1-14 (centre-out from the catalog box): In on the middle row, the Outs on
        // rows 1 then 2. Until 74.1-14 this seed read the index rows (0,0), (1,0), (1,1).
        core.state.set_ports(m, vec![
            Port { local_offset: (0, 1), side: Side::W, role: Role::In, medium: Medium::Mechanical },
            Port { local_offset: (1, 1), side: Side::E, role: Role::Out, medium: Medium::Mechanical },
            Port { local_offset: (1, 2), side: Side::E, role: Role::Out, medium: Medium::Mechanical },
        ]);
        (core, m)
    }

    #[test]
    fn fold_add_port_floors_at_base_then_grows_above_it() {
        use crate::state::Role;
        let (mut core, m) = placed_router_seed();
        // Add a 3rd output → still floored at the 2×3 base (3 outs ≤ base.h).
        core.advance_edits(&[edit_add_port(&core, m, mech_port(Role::Out), 1, 0)], &[]);
        assert_eq!(core.state.ports_of(m).unwrap().len(), 4, "the port was appended");
        assert_eq!(
            core.state.footprint_of(m),
            Some(Footprint { w: 2, h: 3, rot: 0 }),
            "3 outputs stay floored at the frozen 2×3 base"
        );
        // Add a 4th output → grows to 2×4 (min_h = 4 > base.h = 3).
        core.advance_edits(&[edit_add_port(&core, m, mech_port(Role::Out), 2, 1)], &[]);
        assert_eq!(
            core.state.footprint_of(m),
            Some(Footprint { w: 2, h: 4, rot: 0 }),
            "the 4th output grows the footprint to 2×4"
        );
        // The new 4th-row cells are claimed to this node.
        assert_eq!(core.state.occupied((5, 8)), Some(m));
        assert_eq!(core.state.occupied((6, 8)), Some(m));
    }

    #[test]
    fn fold_remove_port_never_shrinks_below_base() {
        use crate::state::Role;
        let (mut core, m) = placed_router_seed(); // 1 in / 2 out, 2×3
        // Remove index 2 (the 2nd Out) → 1 in / 1 out; min-rect wants 2×1 but the
        // 2×3 FLOOR holds.
        core.advance_edits(&[edit_remove_port(m, 2, 1, 0)], &[]);
        assert_eq!(core.state.ports_of(m).unwrap().len(), 2, "exactly one port removed");
        assert_eq!(
            core.state.footprint_of(m),
            Some(Footprint { w: 2, h: 3, rot: 0 }),
            "removal never shrinks the Router below its 2×3 base"
        );
        // The removed port is the one at index 2 (an Out); one In + one Out remain.
        let roles: Vec<Role> = core.state.ports_of(m).unwrap().iter().map(|p| p.role).collect();
        assert_eq!(roles, vec![Role::In, Role::Out]);
    }

    #[test]
    fn fold_add_port_on_absent_node_is_byte_identical_noop() {
        use crate::state::Role;
        let (mut core, _m) = placed_router_seed();
        // Mint + remove a ghost FIRST so the allocator churn is already reflected; the
        // `before` snapshot then isolates the forged fold's effect (a no-op).
        let ghost = core.state.add_router(vec![], Some(0));
        core.state.remove_node(ghost); // now a dangling id (no node, no cell)
        let before = postcard::to_allocvec(&core.state).expect("serialize GridState");
        core.advance_edits(&[edit_add_port(&core, ghost, mech_port(Role::Out), 1, 0)], &[]);
        let after = postcard::to_allocvec(&core.state).expect("serialize GridState");
        assert_eq!(before, after, "AddPort on an absent node writes NO map entry");
    }

    #[test]
    fn fold_add_port_past_the_end_is_a_panic_free_append_and_never_an_insert_panic() {
        // T-73-03-01. `EditOp::AddPort.index` is an attacker-influenceable integer used to
        // POSITION a `Vec::insert`, and `Vec::insert` PANICS past `len()`. That panic is
        // the threat, and this row is what holds it closed.
        //
        // The answer is a CLAMP TO APPEND rather than a no-op, and the fold's own comment
        // records why: the host batches a gesture burst into one tick and resolves every
        // index against a pre-fold port list, so an ordinary Router preset placement
        // legitimately produces five indices past the end. A no-op dropped all five and
        // left the machine port-less; the live suite caught it. Appending is also exactly
        // what every build before this plan did with every index, so it regresses nothing.
        use crate::state::Role;
        let (mut core, m) = placed_router_seed(); // 1 in / 2 out
        let len_before = core.state.ports_of(m).expect("the router has ports").len();
        // 99 is far past the 3-port list.
        core.advance_edits(
            &[edit_add_port_at(m, mech_port(Role::Out), 99, 1, 0)],
            &[],
        );
        let ports = core.state.ports_of(m).expect("the router still has ports");
        assert_eq!(
            ports.len(),
            len_before + 1,
            "a forged out-of-range index APPENDS rather than panicking or vanishing"
        );
        assert_eq!(
            ports[len_before].role,
            Role::Out,
            "and it lands at the END, which is what an index past the end means"
        );
    }

    #[test]
    fn a_strip_and_reseed_burst_resolved_against_one_stale_list_still_seeds_in_order() {
        // THE REGRESSION THIS FILE EXISTS TO PIN, in the core, in the shape the HOST
        // actually produces it. Placing a Router preset emits N `RemovePort`s and then N
        // `AddPort`s in ONE tick, and the host resolves every one of those indices against
        // the pre-fold port list - so every `AddPort` carries the SAME stale append
        // position while the `RemovePort`s empty the list underneath them.
        //
        // The ORDER of the seeded profile is the whole assertion. Roles are asserted by
        // POSITION, never by count: a count of 3 is satisfied by a reversed list, which is
        // exactly what a naive insert-at-stale-index produces, and a reversed port array
        // silently re-keys every belt dock on the machine.
        use crate::state::Role;
        let (mut core, m) = placed_router_seed(); // 1 in / 2 out = 3 ports
        let stale = core.state.ports_of(m).expect("the router has ports").len();
        let stale_idx = PortId::try_from(stale).expect("3 fits a PortId");

        // Strip highest-index-first, exactly as the frontend does.
        let mut batch: Vec<EditRecord> = (0..stale)
            .rev()
            .enumerate()
            .map(|(n, i)| {
                edit_remove_port(
                    m,
                    PortId::try_from(i).expect("in range"),
                    n as u64 + 1,
                    0,
                )
            })
            .collect();
        // Then seed In, Out, Fault - every one carrying the SAME stale index.
        for (n, role) in [Role::In, Role::Out, Role::Fault].into_iter().enumerate() {
            batch.push(edit_add_port_at(
                m,
                mech_port(role),
                stale_idx,
                (stale + n) as u64 + 1,
                0,
            ));
        }
        core.advance_edits(&batch, &[]);

        let roles: Vec<Role> = core
            .state
            .ports_of(m)
            .expect("the reseeded router has ports")
            .iter()
            .map(|p| p.role)
            .collect();
        assert_eq!(
            roles,
            vec![Role::In, Role::Out, Role::Fault],
            "the preset seeds IN ORDER despite every AddPort naming the same stale slot"
        );
    }

    #[test]
    fn fold_add_port_at_the_append_position_is_still_legal_and_still_appends() {
        // The BOUNDARY of the guard above, and it is the case that matters most: every
        // FORWARD add resolves `index = ports.len()`, which is one PAST the last valid
        // subscript. A `>=` bound - the obvious mirror of `fold_remove_port`'s - would
        // reject every ordinary "add an output" gesture in the app while every negative
        // test above stayed green. So the bound is `>`, and this row is why.
        use crate::state::Role;
        let (mut core, m) = placed_router_seed();
        let at = core.state.ports_of(m).expect("the router has ports").len();
        core.advance_edits(
            &[edit_add_port_at(
                m,
                mech_port(Role::Out),
                PortId::try_from(at).expect("a 3-port list fits a PortId"),
                1,
                0,
            )],
            &[],
        );
        let ports = core.state.ports_of(m).expect("the router still has ports");
        assert_eq!(ports.len(), at + 1, "the append position is a legal insert");
        assert_eq!(
            ports[at].role,
            Role::Out,
            "and the port landed in the slot the record named, which is LAST"
        );
    }

    #[test]
    fn fold_add_port_at_a_middle_index_inserts_there_rather_than_appending() {
        // 73-03, and this is the whole reason the field exists. Before it, this fold
        // could only push, so the inverse of a `RemovePort` put a removed middle output
        // back LAST and silently renumbered every port after it. The list LENGTH came
        // back correct either way, which is exactly why nothing caught it: only the ORDER
        // was wrong, and order is what every belt dock key is.
        use crate::state::Role;
        let (mut core, m) = placed_router_seed(); // In at 0, Out at 1, Out at 2
        let roles_before: Vec<Role> = core
            .state
            .ports_of(m)
            .expect("the router has ports")
            .iter()
            .map(|p| p.role)
            .collect();
        core.advance_edits(
            &[edit_add_port_at(m, mech_port(Role::Out), 1, 1, 0)],
            &[],
        );
        let ports = core.state.ports_of(m).expect("the router still has ports");
        assert_eq!(ports.len(), roles_before.len() + 1, "exactly one port arrived");
        // Asserted by POSITION, never by count: a count is satisfied by an append.
        assert_eq!(
            ports[1].role,
            Role::Out,
            "the new port is at the slot the record named"
        );
        let tail: Vec<Role> = ports[2..].iter().map(|p| p.role).collect();
        assert_eq!(
            tail,
            roles_before[1..].to_vec(),
            "and every port that was at or after that slot shifted up by exactly one"
        );
    }

    #[test]
    fn fold_remove_port_out_of_range_index_is_byte_identical_noop() {
        let (mut core, m) = placed_router_seed();
        let before = postcard::to_allocvec(&core.state).expect("serialize GridState");
        // index 99 is far past the 3-port list → panic-free byte-identical no-op
        // (the forged-index DoS guard; NO Vec OOB panic).
        core.advance_edits(&[edit_remove_port(m, 99, 1, 0)], &[]);
        let after = postcard::to_allocvec(&core.state).expect("serialize GridState");
        assert_eq!(before, after, "an out-of-range RemovePort index is a no-op");
    }

    #[test]
    fn fold_add_port_on_cell_less_belt_is_a_byte_identical_noop() {
        use crate::state::{belt_ports, Role};
        // A Wire-minted belt has no cell → it is NOT port-editable (threat T-36-04).
        //
        // RENAMED AND ITS SECOND ASSERTION CORRECTED AT PHASE 74, because the old name and
        // the old assertion described the MECHANISM rather than the guarantee. They read
        // "writes no entry" / `ports_of(belt).is_none()`, which was true only because a
        // belt declared no ports at all; a belt is a ported node now (LINK-08, D-06) and
        // is ALWAYS present in `ports`. The guarantee itself is untouched and is what the
        // first assertion has always carried: a port edit aimed at a belt moves NO byte.
        // The second assertion now says that in terms of the belt's own two records, which
        // is a strictly stronger claim than absence was - it catches an AddPort that
        // appended a third record just as much as one that minted a first.
        let mut core = core_with_seed(1);
        let belt = core.state.add_belt(1); // no geometry, no cell
        let before = postcard::to_allocvec(&core.state).expect("serialize GridState");
        core.advance_edits(&[edit_add_port(&core, belt, mech_port(Role::Out), 1, 0)], &[]);
        let after = postcard::to_allocvec(&core.state).expect("serialize GridState");
        assert_eq!(before, after, "a cell-less belt gets no ports/footprint edit");
        assert_eq!(
            core.state.ports_of(belt),
            Some(belt_ports().as_slice()),
            "the belt still carries exactly its own two records, neither added to nor replaced",
        );
    }

    #[test]
    fn add_then_remove_port_round_trips_byte_identical_on_a_preset() {
        use crate::state::Role;
        // The undo-exactness witness (key-link for plan 02): footprint+ports are a PURE
        // function of (base, port multiset), so add-then-remove-last returns byte-identical.
        let (mut core, m) = placed_router_seed();
        let before = postcard::to_allocvec(&core.state).expect("serialize GridState");
        core.advance_edits(&[edit_add_port(&core, m, mech_port(Role::Out), 1, 0)], &[]);
        // Remove the just-appended port (it is the LAST in the list, index 3).
        let last = (core.state.ports_of(m).unwrap().len() - 1) as PortId;
        core.advance_edits(&[edit_remove_port(m, last, 2, 1)], &[]);
        let after = postcard::to_allocvec(&core.state).expect("serialize GridState");
        assert_eq!(before, after, "add-then-remove-last is byte-identical (exact undo)");
    }

    #[test]
    fn port_edits_are_design_time_only_no_runtime_mutation() {
        // Structural guard: a plain `tick` (runtime fold, no edit records) NEVER mutates
        // the ports/footprints maps — the "never grows a port mid-run" invariant. Seed a
        // Router, then tick several times with NO edits and assert its ports+footprint
        // stay byte-identical (only the AddPort/RemovePort edit arms move them).
        let (mut core, m) = placed_router_seed();
        let ports_before = core.state.ports_of(m).map(<[Port]>::to_vec);
        let fp_before = core.state.footprint_of(m);
        for _ in 0..5 {
            core.advance_edits(&[], &[]); // pure runtime ticks, no edits
        }
        assert_eq!(core.state.ports_of(m).map(<[Port]>::to_vec), ports_before, "runtime never mutates ports");
        assert_eq!(core.state.footprint_of(m), fp_before, "runtime never resizes a footprint");
    }

    // ── fold_configure (CFG-02, Phase 39) ──────────────────────────────────────

    /// Build one `Configure{node, config, code_hash:[0;32]}` edit record. The
    /// `code_hash` is opaque to the fold (host-stamped in production), so a zero hash
    /// is faithful for the fold-behavior proofs here.
    fn edit_configure(
        node: NodeId,
        config: crate::edit::MachineConfig,
        seq: u64,
        tick: u64,
    ) -> EditRecord {
        EditRecord {
            schema_version: EDIT_SCHEMA_VERSION,
            partition: 0,
            sequence: seq,
            tick,
            action: 0,
            op: EditOp::Configure { node, config, code_hash: [0u8; 32] },
        }
    }

    /// DRAIN (mutating) the items resting on port 0 of a collector `Source`'s inbox,
    /// so a later read isolates only the items delivered since this call.
    fn drain_collector(core: &mut Core, id: NodeId) -> Vec<Item> {
        let inbox = core.state.inbox_mut(id);
        let mut out = Vec::new();
        while let Some((_seq, item)) = inbox.take(0) {
            out.push(item);
        }
        out
    }

    #[test]
    fn fold_configure_factory() {
        use crate::edit::MachineConfig;
        // A Configure{Factory{source: NEW}} sets the node's Factory.source to the EXACT
        // new bytes (no reformat) — the CFG-02 core write on an existing serialized field.
        let mut core = core_with_seed(1);
        let f = core.state.add_factory(
            super::DEFAULT_FACTORY_SOURCE.to_owned(),
            crate::factory::DEFAULT_GAS_BUDGET,
            7,
        );
        const NEW_JS: &str = "export default function (input, ctx) { ctx.emit(0, 42); }";
        core.advance_edits(
            &[edit_configure(f, MachineConfig::Factory { source: NEW_JS.to_owned() }, 1, 0)],
            &[],
        );
        match core.state.node(f) {
            Some(Node::Factory(fac)) => {
                assert_eq!(fac.source, NEW_JS, "Factory.source is the exact new bytes");
            }
            _ => panic!("the factory node exists"),
        }
    }

    #[test]
    fn fold_configure_evicts_cache() {
        use crate::edit::MachineConfig;
        // BEHAVIORAL eviction proof (threat T-39-STALE-JS): after the runtime is built
        // once from source A, a Configure{Factory{source: B}} must evict the NodeId-keyed
        // cache so the NEXT item through the factory runs B (not the stale A engine).
        // Topology: source -> factory -> collector (instant links; delivered within tick).
        const SRC_A: &str = "export default function (input, ctx) { ctx.emit(0, \"A\"); }";
        const SRC_B: &str = "export default function (input, ctx) { ctx.emit(0, \"B\"); }";
        let mut core = core_with_seed(1);
        let s = core.state.add_source();
        let f = core.state.add_factory(SRC_A.to_owned(), crate::factory::DEFAULT_GAS_BUDGET, 7);
        let c = core.state.add_source();
        core.state.link((s, 0), (f, 0));
        core.state.link((f, 0), (c, 0));

        // Fire through the factory under source A: builds + caches the A engine, emits "A".
        core.advance(&[fire(s, 1, core.tick, Item(b"1".to_vec()))]);
        assert_eq!(
            drain_collector(&mut core, c),
            vec![Item(b"\"A\"".to_vec())],
            "the original source A ran and emitted \"A\""
        );
        assert!(!core.factory_runtimes.is_empty(), "the A engine is cached after the first run");

        // Swap the source to B via a Configure edit — MUST evict the cached A engine.
        core.advance_edits(
            &[edit_configure(f, MachineConfig::Factory { source: SRC_B.to_owned() }, 2, core.tick)],
            &[],
        );

        // Fire again: the factory rebuilds from the NEW source B and emits "B". A stale
        // (un-evicted) A engine would emit "A" here — the divergence this proves closed.
        core.advance(&[fire(s, 3, core.tick, Item(b"1".to_vec()))]);
        assert_eq!(
            drain_collector(&mut core, c),
            vec![Item(b"\"B\"".to_vec())],
            "the swapped source B ran (cache evicted + rebuilt) — the NEW handler emitted \"B\""
        );
    }

    #[test]
    fn fold_configure_sink() {
        use crate::edit::MachineConfig;
        use crate::state::SinkTemplate;
        // A Configure{Sink{target}} sets the node's Sink.template to the new effect target.
        let mut core = core_with_seed(1);
        let k = core.state.add_sink(SinkTemplate::Debug, 600);
        let target = SinkTemplate::Http {
            url: "https://example.com/hook".to_owned(),
            method: crate::state::HttpMethod::Put,
        };
        core.advance_edits(
            &[edit_configure(k, MachineConfig::Sink { target: target.clone() }, 1, 0)],
            &[],
        );
        match core.state.node(k) {
            Some(Node::Sink(sink)) => assert_eq!(sink.template, target, "Sink.template swapped"),
            _ => panic!("the sink node exists"),
        }
    }

    #[test]
    fn fold_configure_source_noop() {
        use crate::edit::{MachineConfig, SourceTrigger};
        // A Configure{Source{..}} is a CORE no-op (the trigger is host-side): it changes
        // ZERO GridState bytes (snapshot before == after).
        let mut core = core_with_seed(1);
        let s = core.state.add_source();
        let before = postcard::to_allocvec(&core.state).expect("serialize GridState");
        core.advance_edits(
            &[edit_configure(
                s,
                MachineConfig::Source { trigger: SourceTrigger::Timer { interval_ticks: 5 } },
                1,
                0,
            )],
            &[],
        );
        let after = postcard::to_allocvec(&core.state).expect("serialize GridState");
        assert_eq!(before, after, "a Source config folds to ZERO GridState-byte change");
    }

    #[test]
    fn folding_a_seal_history_record_changes_no_state() {
        // 85-05 (D-10): the history seal folds to NOTHING. Two cores built the same way
        // advance one tick each, one folding a SealHistory record and one folding no
        // edit at all; their whole snapshots are byte-identical. (Comparing against the
        // pre-tick bytes would conflate the seal with the tick counter itself moving.)
        let build = || {
            let mut core = core_with_seed(7);
            let s = core.state.add_source();
            let k = core.state.add_sink(crate::state::SinkTemplate::Debug, 600);
            let _ = (s, k);
            core
        };
        let mut sealed = build();
        let mut plain = build();
        let grid_before = postcard::to_allocvec(&sealed.state).expect("serialize GridState");
        let seal = EditRecord {
            schema_version: EDIT_SCHEMA_VERSION,
            partition: 0,
            sequence: 1,
            tick: 0,
            action: 1,
            op: EditOp::SealHistory,
        };
        sealed.advance_edits(&[seal], &[]);
        plain.advance_edits(&[], &[]);
        assert_eq!(
            crate::snapshot::snapshot(&sealed),
            crate::snapshot::snapshot(&plain),
            "folding a SealHistory record leaves the snapshot byte-identical to folding nothing"
        );
        assert_eq!(
            postcard::to_allocvec(&sealed.state).expect("serialize GridState"),
            grid_before,
            "and the grid itself is unchanged"
        );
    }

    #[test]
    fn fold_configure_forged_is_panic_free() {
        use crate::edit::MachineConfig;
        use crate::state::SinkTemplate;
        // A forged Configure — an ABSENT node, or a node whose live kind does NOT match
        // the config variant — folds panic-free with NO state corruption (mirrors
        // fold_place's `_ => return` guard, threat T-39-FOLD-PANIC).
        let mut core = core_with_seed(1);
        // A live Source (wrong kind for a Factory config) + a real factory to isolate the
        // forged effect against.
        let s = core.state.add_source();
        let f = core.state.add_factory(
            super::DEFAULT_FACTORY_SOURCE.to_owned(),
            crate::factory::DEFAULT_GAS_BUDGET,
            7,
        );
        // A ghost id: minted then removed → a dangling handle referring to no node.
        let ghost = core.state.add_sink(SinkTemplate::Debug, 600);
        core.state.remove_node(ghost);
        let before = postcard::to_allocvec(&core.state).expect("serialize GridState");
        core.advance_edits(
            &[
                // Factory config aimed at a SOURCE node (kind mismatch) → no-op.
                edit_configure(s, MachineConfig::Factory { source: "X".to_owned() }, 1, 0),
                // Sink config aimed at a FACTORY node (kind mismatch) → no-op.
                edit_configure(
                    f,
                    MachineConfig::Sink { target: SinkTemplate::Debug },
                    2,
                    0,
                ),
                // Any config aimed at an ABSENT node → no-op.
                edit_configure(ghost, MachineConfig::Factory { source: "Y".to_owned() }, 3, 0),
            ],
            &[],
        );
        let after = postcard::to_allocvec(&core.state).expect("serialize GridState");
        assert_eq!(before, after, "a forged/wrong-kind Configure corrupts NO state (panic-free no-op)");
    }

    // ── fold_place: the ENDPOINT gap (WIRE-03, Phase 63) ──────────────────────

    #[test]
    fn fold_place_endpoint_mints_an_endpoint_with_its_inbox() {
        // Before this arm existed, `machine_kind::ENDPOINT` (9) fell through to
        // `fold_place`'s panic-free `_ => return` and minted NOTHING, so an endpoint
        // could only be created by a Rust caller. WIRE-03 needs one minted BY THE FOLD.
        let mut core = core_with_seed(1);
        core.advance_edits(&[edit_place(super::machine_kind::ENDPOINT, 1, 0)], &[]);
        let minted = *core
            .last_tick
            .placed
            .last()
            .expect("Place{ENDPOINT} minted a node id");
        assert!(
            matches!(core.state.node(minted), Some(Node::Endpoint(_))),
            "the fold minted a Node::Endpoint, got {:?}",
            core.state.node(minted)
        );
        assert!(
            core.state.inbox_of(minted).is_some(),
            "the minted endpoint carries its inbox (the `add_endpoint` seam, not a bare node)"
        );
    }

    #[test]
    fn a_fold_minted_endpoint_is_identical_to_an_add_endpoint_one() {
        // The corrected `add_endpoint` doc claims the two minters produce identical
        // nodes. This is what makes that claim TRUE rather than merely reworded: build
        // one core each way and compare the serialized GridState byte for byte.
        //
        // The REFERENCE has to be allocator-faithful, and that is a fact about
        // `fold_place` rather than about endpoints: minting and CLAIMING are two steps.
        // `fold_place` mints through `add_endpoint` and then claims the record's 1x1
        // footprint, while `add_endpoint` alone claims no cell — so a bare
        // `add_endpoint()` core differs by the occupancy entry and nothing else. Compare
        // against a twin that reached the same place the other way (mint, then claim the
        // same cell), which is a STRONGER statement than trimming the assertion down to
        // the node: it says the fold does exactly the mint plus exactly the claim, and
        // nothing further.
        let mut folded = core_with_seed(1);
        folded.advance_edits(&[edit_place(super::machine_kind::ENDPOINT, 1, 0)], &[]);

        let mut direct = core_with_seed(1);
        let id = direct.state.add_endpoint();
        direct.state.claim_footprint(id, (0, 0), 1, 1, 0);

        assert_eq!(
            postcard::to_allocvec(&folded.state).expect("serialize the folded GridState"),
            postcard::to_allocvec(&direct.state).expect("serialize the direct GridState"),
            "a fold-minted endpoint and an add_endpoint-minted one are byte-identical"
        );
    }

    #[test]
    fn fold_place_belt_and_wire_still_mint_nothing() {
        // BELT (1) and WIRE (8) are DELIBERATELY unfoldable via Place and stay that way:
        // belts come only from `DrawBelt` (17-02 / CAT-04) and wires only from
        // `DrawWire`. Pinned as zero state-byte change so the two exclusions read as
        // decisions rather than as the same oversight ENDPOINT was.
        for kind in [super::machine_kind::BELT, super::machine_kind::WIRE] {
            let mut core = core_with_seed(1);
            let before = postcard::to_allocvec(&core.state).expect("serialize GridState");
            core.advance_edits(&[edit_place(kind, 1, 0)], &[]);
            let after = postcard::to_allocvec(&core.state).expect("serialize GridState");
            assert_eq!(before, after, "Place{{kind {kind}}} writes ZERO GridState bytes");
            assert!(
                core.last_tick.placed.is_empty(),
                "Place{{kind {kind}}} mints no id"
            );
        }
    }

    #[test]
    fn fold_place_above_handler_is_still_a_panic_free_no_op() {
        // LABEL (11) is the LAST machine_kind byte. Every kind above it is unknown and
        // still folds to nothing, panic-free (threat T-07-FOLD-PANIC).
        //
        // THIS TEST READ `10` AS AN UNKNOWN BYTE UNTIL PLAN 72-06, and it reddened on the
        // commit that gave byte 10 the HANDLER arm. It is re-pointed rather than deleted:
        // the ceiling probe is spelled `HANDLER + 1` so it keeps meaning "one past the
        // top" instead of quietly asserting `no-op` about a real placeable kind the day
        // another byte is appended. Byte 10 minting is covered by
        // `crates/fabrico-core/tests/handler_place.rs`. Phase 76 appended LABEL at byte
        // 11, which is exactly the day that sentence anticipated: the probe is re-pointed
        // to `LABEL + 1` (the name keeps its history), and byte 11 minting is covered by
        // `crates/fabrico-command/tests/label.rs`.
        let mut core = core_with_seed(1);
        let before = postcard::to_allocvec(&core.state).expect("serialize GridState");
        core.advance_edits(
            &[
                edit_place(super::machine_kind::LABEL + 1, 1, 0),
                edit_place(u8::MAX, 2, 0),
            ],
            &[],
        );
        let after = postcard::to_allocvec(&core.state).expect("serialize GridState");
        assert_eq!(before, after, "an unknown kind byte writes ZERO GridState bytes");
        assert!(core.last_tick.placed.is_empty(), "an unknown kind mints no id");
    }

    // ── fold_configure: the Belt and Router arms (63-04, BELT-02 / ROUTE-03) ───

    #[test]
    fn fold_configure_belt_writes_only_the_interval() {
        use crate::edit::MachineConfig;
        use std::num::NonZeroU32;
        // A Configure{Belt{ticks_per_slot}} writes that ONE field and changes nothing
        // else about the belt: its slots, geometry and tile count are untouched.
        let mut core = core_with_seed(1);
        let b = core.state.add_belt(3);
        let (tiles_before, slots_before, geometry_before) = match core.state.node(b) {
            Some(Node::Belt(belt)) => (belt.tiles, belt.slots.clone(), belt.geometry.clone()),
            other => panic!("expected a Belt node, got {other:?}"),
        };
        let new = NonZeroU32::new(17).expect("17 is non-zero");
        core.advance_edits(
            &[edit_configure(b, MachineConfig::Belt { ticks_per_slot: new }, 1, 0)],
            &[],
        );
        match core.state.node(b) {
            Some(Node::Belt(belt)) => {
                assert_eq!(belt.ticks_per_slot, new, "the interval is the new value");
                assert_eq!(belt.tiles, tiles_before, "tile count untouched");
                assert_eq!(belt.slots, slots_before, "slots untouched");
                assert_eq!(belt.geometry, geometry_before, "geometry untouched");
            }
            other => panic!("expected a Belt node, got {other:?}"),
        }
    }

    #[test]
    fn fold_configure_router_writes_routes_and_default() {
        use crate::edit::MachineConfig;
        use crate::state::RouteKey;
        // A Configure{Router{routes, default}} writes the table VERBATIM — same order,
        // no sort, no dedup — and the default port beside it.
        let mut core = core_with_seed(1);
        let r = core.state.add_router(vec![(RouteKey::new(0, b"old".to_vec()), 1)], Some(9));
        let routes = vec![
            (RouteKey::new(0, b"alpha".to_vec()), 1),
            (RouteKey::new(2, b"beta".to_vec()), 2),
        ];
        core.advance_edits(
            &[edit_configure(
                r,
                MachineConfig::Router { routes: routes.clone(), default: Some(4) },
                1,
                0,
            )],
            &[],
        );
        match core.state.node(r) {
            Some(Node::Router(router)) => {
                assert_eq!(router.routes, routes, "the table is written VERBATIM, in order");
                assert_eq!(router.default, Some(4), "the default port is written");
            }
            other => panic!("expected a Router node, got {other:?}"),
        }
    }

    #[test]
    fn fold_configure_router_preserves_the_fault_counter() {
        use crate::edit::MachineConfig;
        use crate::state::RouteKey;
        // T-63-23, and its OWN test rather than a clause inside another one. `Router` has
        // THREE fields and `MachineConfig::Router` carries two, so a `*router = Router {
        // .. }` struct-literal overwrite would zero `faults` — a snapshot-captured
        // counter — moving an existing board's bytes on every reconfiguration for a
        // reason nobody chose. The counter is SEEDED non-zero first: a test that only
        // checked it was still 0 would pass against the bug.
        let mut core = core_with_seed(1);
        let r = core.state.add_router(vec![], None);
        match core.state.node_mut(r) {
            Some(Node::Router(router)) => router.faults = 42,
            other => panic!("expected a Router node, got {other:?}"),
        }
        core.advance_edits(
            &[edit_configure(
                r,
                MachineConfig::Router {
                    routes: vec![(RouteKey::new(0, b"x".to_vec()), 1)],
                    default: Some(2),
                },
                1,
                0,
            )],
            &[],
        );
        match core.state.node(r) {
            Some(Node::Router(router)) => assert_eq!(
                router.faults, 42,
                "reconfiguring a router preserves its EXACT fault counter"
            ),
            other => panic!("expected a Router node, got {other:?}"),
        }
    }

    #[test]
    fn fold_configure_belt_and_router_on_an_absent_node_write_zero_bytes() {
        use crate::edit::MachineConfig;
        use std::num::NonZeroU32;
        // An absent node is a panic-free no-op for the two new variants exactly as for
        // the other three (T-39-FOLD-PANIC).
        let mut core = core_with_seed(1);
        let ghost = core.state.add_source();
        core.state.remove_node(ghost);
        let before = postcard::to_allocvec(&core.state).expect("serialize GridState");
        core.advance_edits(
            &[
                edit_configure(
                    ghost,
                    MachineConfig::Belt {
                        ticks_per_slot: NonZeroU32::new(5).expect("5 is non-zero"),
                    },
                    1,
                    0,
                ),
                edit_configure(
                    ghost,
                    MachineConfig::Router { routes: vec![], default: None },
                    2,
                    0,
                ),
            ],
            &[],
        );
        let after = postcard::to_allocvec(&core.state).expect("serialize GridState");
        assert_eq!(before, after, "a Configure naming an absent node writes ZERO GridState bytes");
    }

    /// Phase 76 (plan 76-02, threat T-76-05): a forged `Configure{Label}` carrying a
    /// `65535 x 65535` box folds to a box CLAMPED to `MAX_FOOTPRINT_DIM` on each side,
    /// never to an occupancy bomb. The fold applies records verbatim on every replay,
    /// including ones no command gate validated, so the clamp has to live in the fold.
    ///
    /// The assertion is on the EXACT clamped box and its corner cells, not on "no larger
    /// than": a fold that wrote nothing at all would satisfy an upper bound and prove
    /// nothing. The words and the colour are asserted too, so the arm is shown to write
    /// all three.
    ///
    /// RED BEFORE THE ARM (recorded in 76-02-SUMMARY.md): with the `Label` arm a no-op,
    /// the footprint stays the placed 4x1 and the box assertion fails.
    #[test]
    fn fold_configure_label_clamps_a_forged_size() {
        use crate::edit::MachineConfig;
        use crate::state::{Footprint, LabelColour, MAX_FOOTPRINT_DIM};
        let mut core = core_with_seed(1);
        let label = core.state.add_label();
        core.state.claim_footprint(label, (3, 4), 4, 1, 0);
        core.advance_edits(
            &[edit_configure(
                label,
                MachineConfig::Label {
                    text: "forged".to_owned(),
                    colour: LabelColour::Rose,
                    w: u16::MAX,
                    h: u16::MAX,
                },
                1,
                0,
            )],
            &[],
        );
        let cap = MAX_FOOTPRINT_DIM;
        assert_eq!(
            core.state.footprint_of(label),
            Some(Footprint { w: cap, h: cap, rot: 0 }),
            "a 65535 by 65535 record folds to the MAX_FOOTPRINT_DIM box, rot 0"
        );
        assert_eq!(core.state.cell_of(label), Some((3, 4)), "the anchor never moves");
        let last = i32::from(cap) - 1;
        assert_eq!(core.state.occupied((3 + last, 4 + last)), Some(label), "the far corner is held");
        assert_eq!(core.state.occupied((3 + last + 1, 4)), None, "nothing past the clamped width");
        assert_eq!(core.state.occupied((3, 4 + last + 1)), None, "nothing past the clamped depth");
        match core.state.node(label) {
            Some(Node::Label(l)) => {
                assert_eq!(l.text, "forged", "the fold wrote the words");
                assert_eq!(l.colour, LabelColour::Rose, "the fold wrote the colour");
            }
            other => panic!("expected a Node::Label, got {other:?}"),
        }
        assert!(core.state.ports_of(label).is_none(), "a re-boxed label has no ports");
    }

    /// Phase 76 (plan 76-02): a `Configure{Label}` aimed at a NON-label folds to a no-op
    /// that writes ZERO GridState bytes, the T-39-FOLD-PANIC discipline every arm keeps.
    #[test]
    fn fold_configure_label_on_a_non_label_writes_zero_bytes() {
        use crate::edit::MachineConfig;
        use crate::state::LabelColour;
        let mut core = core_with_seed(1);
        let router = core.state.add_router(vec![], Some(1));
        let before = postcard::to_allocvec(&core.state).expect("serialize GridState");
        core.advance_edits(
            &[edit_configure(
                router,
                MachineConfig::Label {
                    text: "x".to_owned(),
                    colour: LabelColour::Moss,
                    w: 6,
                    h: 2,
                },
                1,
                0,
            )],
            &[],
        );
        let after = postcard::to_allocvec(&core.state).expect("serialize GridState");
        assert_eq!(before, after, "a wrong-kind Label Configure writes ZERO GridState bytes");
    }

    #[test]
    fn fold_configure_belt_and_router_wrong_kind_write_zero_bytes() {
        use crate::edit::MachineConfig;
        use crate::state::RouteKey;
        use std::num::NonZeroU32;
        // Both directions of the mismatch: a Belt config aimed at a Router, and a Router
        // config aimed at a Belt. Each is a fold no-op that corrupts nothing.
        let mut core = core_with_seed(1);
        let belt = core.state.add_belt(2);
        let router = core.state.add_router(vec![], Some(1));
        let before = postcard::to_allocvec(&core.state).expect("serialize GridState");
        core.advance_edits(
            &[
                edit_configure(
                    router,
                    MachineConfig::Belt {
                        ticks_per_slot: NonZeroU32::new(5).expect("5 is non-zero"),
                    },
                    1,
                    0,
                ),
                edit_configure(
                    belt,
                    MachineConfig::Router {
                        routes: vec![(RouteKey::new(0, b"z".to_vec()), 3)],
                        default: Some(4),
                    },
                    2,
                    0,
                ),
            ],
            &[],
        );
        let after = postcard::to_allocvec(&core.state).expect("serialize GridState");
        assert_eq!(
            before, after,
            "a wrong-kind Belt/Router Configure writes ZERO GridState bytes"
        );
    }

    #[test]
    fn fold_configure_router_applies_an_empty_table_and_faults_every_item() {
        use crate::edit::MachineConfig;
        use crate::fault::FAULT_PORT;
        use crate::state::RouteKey;
        // An empty `routes` with `default: None` is applied VERBATIM, and the router then
        // sends every item to the reserved fault port. That is the existing no-match
        // behaviour, reached through a folded config rather than through construction.
        let mut core = core_with_seed(1);
        let s = core.state.add_source();
        let r = core.state.add_router(vec![(RouteKey::new(0, b"a".to_vec()), 0)], Some(0));
        let collector = core.state.add_source();
        core.state.link((s, 0), (r, 0));
        core.state.link((r, FAULT_PORT), (collector, 0));
        core.advance_edits(
            &[edit_configure(
                r,
                MachineConfig::Router { routes: vec![], default: None },
                1,
                0,
            )],
            &[],
        );
        match core.state.node(r) {
            Some(Node::Router(router)) => {
                assert!(router.routes.is_empty(), "the empty table is applied verbatim");
                assert_eq!(router.default, None, "the absent default is applied verbatim");
            }
            other => panic!("expected a Router node, got {other:?}"),
        }
        core.advance(&[fire(s, 1, core.tick, Item(b"a".to_vec()))]);
        assert_eq!(
            drain_collector(&mut core, collector).len(),
            1,
            "with no routes and no default the item leaves on the FAULT port"
        );
    }

    #[test]
    fn fold_configure_router_preserves_route_order_and_the_first_match_wins() {
        use crate::edit::MachineConfig;
        use crate::state::RouteKey;
        // The ordering guarantee as an EXECUTABLE claim rather than a comment: two routes
        // that both match the same item resolve to the EARLIER one. Proved by routing a
        // real item and reading the port it left on, not by inspecting the Vec.
        let mut core = core_with_seed(1);
        let s = core.state.add_source();
        let r = core.state.add_router(vec![], Some(9));
        let first = core.state.add_source();
        let second = core.state.add_source();
        core.state.link((s, 0), (r, 0));
        core.state.link((r, 0), (first, 0));
        core.state.link((r, 1), (second, 0));

        // Both keys match the item b"ab": an empty-offset prefix and the same prefix
        // again. Port 0 is declared FIRST.
        core.advance_edits(
            &[edit_configure(
                r,
                MachineConfig::Router {
                    routes: vec![
                        (RouteKey::new(0, b"a".to_vec()), 0),
                        (RouteKey::new(0, b"a".to_vec()), 1),
                    ],
                    default: None,
                },
                1,
                0,
            )],
            &[],
        );
        core.advance(&[fire(s, 1, core.tick, Item(b"ab".to_vec()))]);
        assert_eq!(
            drain_collector(&mut core, first).len(),
            1,
            "the item left on the FIRST matching route's port"
        );
        assert_eq!(
            drain_collector(&mut core, second).len(),
            0,
            "the second matching route did not fire"
        );
    }

    // --- Phase 86 (plan 86-02, D-03): a Place carries its turn, a Delete capture names it ---

    #[allow(clippy::too_many_arguments)]
    fn edit_place_turned(
        kind: u8,
        seq: u64,
        tick: u64,
        cell: (i32, i32),
        w: u16,
        h: u16,
        ports: Vec<Port>,
        rot: u8,
    ) -> EditRecord {
        EditRecord {
            schema_version: EDIT_SCHEMA_VERSION,
            partition: 0,
            sequence: seq,
            tick,
            action: 0,
            op: EditOp::Place { kind, cell_x: cell.0, cell_y: cell.1, w, h, ports, rot },
        }
    }

    /// A `Place` at rot 2 claims its 2 by 3 box turned twice, at its anchor, and stores the
    /// footprint with that rotation; the state passes the snapshot trust gate.
    #[test]
    fn a_place_at_rot_2_folds_to_a_footprint_at_rot_2() {
        use crate::state::{Footprint, cells_of_footprint};
        let mut core = core_with_seed(1);
        core.advance_edits(
            &[edit_place_turned(super::machine_kind::ROUTER, 1, 0, (20, 28), 2, 3, vec![], 2)],
            &[],
        );
        assert_eq!(core.last_tick.placed.len(), 1, "the turned Place mints one node");
        let id = core.last_tick.placed[0];
        assert_eq!(core.state.footprint_of(id), Some(Footprint { w: 2, h: 3, rot: 2 }));
        assert_eq!(core.state.cell_of(id), Some((20, 28)), "the anchor is the record's cell");
        let cells: Vec<_> = cells_of_footprint((20, 28), 2, 3, 2).collect();
        assert_eq!(cells.len(), 6);
        for c in cells {
            assert_eq!(core.state.occupied(c), Some(id), "the rot-2 body claims {c:?}");
        }
        let bytes = crate::snapshot::snapshot(&core);
        assert!(crate::snapshot::restore(&bytes).is_ok(), "a turned placement is a valid state");
    }

    /// A `Place` naming a rotation above 3 mints NOTHING: no node, no cell, no random draw
    /// (the unknown-kind no-op shape), so a forged turn that reaches the fold is inert.
    #[test]
    fn a_place_turned_past_3_mints_nothing() {
        for rot in [4u8, 7, u8::MAX] {
            let mut core = core_with_seed(1);
            let rng_before = core.rng.clone();
            core.advance_edits(
                &[edit_place_turned(super::machine_kind::FACTORY, 1, 0, (0, 0), 3, 3, vec![], rot)],
                &[],
            );
            assert_eq!(core.state.node_count(), 0, "rot {rot}: no node is minted");
            assert!(core.last_tick.placed.is_empty(), "rot {rot}: nothing is recorded as placed");
            assert_eq!(core.state.occupied((0, 0)), None, "rot {rot}: no cell is claimed");
            assert_eq!(core.rng, rng_before, "rot {rot}: the Factory seed draw is not taken");
        }
    }

    /// The Delete capture names the turn the machine holds and, for every cascade belt and
    /// for a bare belt's own record, the pace it runs at (EDIT 13).
    #[test]
    fn the_delete_capture_records_the_turn_and_each_belts_pace() {
        use crate::edit::{BeltEnd, DeletedSelf, MachineConfig};
        use crate::state::{Medium, Role, Side};
        use std::num::NonZeroU32;
        let five = NonZeroU32::new(5).expect("5 is non-zero");
        let out = Port { local_offset: (1, 1), side: Side::E, role: Role::Out, medium: Medium::Mechanical };
        let mut core = core_with_seed(1);
        core.advance_edits(
            &[edit_place_turned(super::machine_kind::ROUTER, 1, 0, (20, 28), 2, 3, vec![out], 0)],
            &[],
        );
        let router = core.last_tick.placed[0];
        core.advance_edits(&[edit_rotate(router, 1, 0, 2, 1)], &[]);
        let belt = core.state.add_belt(2);
        core.advance_edits(
            &[
                edit_configure(belt, MachineConfig::Belt { ticks_per_slot: five }, 3, 2),
                edit_dock(belt, BeltEnd::Tail, router, 0, 4, 2),
            ],
            &[],
        );
        let captured = core.state.capture_deleted_subgraph(router);
        assert_eq!((captured.w, captured.h, captured.rot), (2, 3, 1), "the turned Router's box and turn");
        assert_eq!(captured.belts.len(), 1, "the docked belt is in the cascade");
        assert_eq!(captured.belts[0].ticks_per_slot, five, "the cascade belt's pace is recorded");

        let own = core.state.capture_deleted_subgraph(belt);
        match own.self_record {
            Some(DeletedSelf::Belt(b)) => assert_eq!(b.ticks_per_slot, five, "a bare belt records its own pace"),
            other => panic!("a belt delete captures its own record, got {other:?}"),
        }
        assert_eq!(own.rot, 0, "a belt holds no footprint turn");
    }
}

/// Phase-37 wire transport fold behavior (Task 2): multi-hop ingest + matured
/// delivery through the ONE `route_seq` queue + budget/cap overflow + self-rewake.
#[cfg(test)]
mod wire_transport_tests {
    use super::Node;
    use crate::core::Core;
    use crate::event::{Event, EventPayload, LogHeader, SCHEMA_VERSION};
    use crate::ids::{Item, NodeId, PortId};
    use crate::wire::{WireEnvelope, WireInFlight, WIRE_INFLIGHT_CAP};

    fn core_with_seed(seed: u64) -> Core {
        Core::genesis(LogHeader {
            schema_version: SCHEMA_VERSION,
            seed,
        })
    }

    /// A logged WireRequest for `return_addr`, carrying `budget`/`payload`.
    fn wire_req(
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
                correlation: 0x1234,
                deadline_tick: tick + 100,
                budget,
                return_addr,
                payload,
            },
        }
    }

    /// The in-flight message count on a `Node::Wire`.
    fn in_flight_len(core: &Core, id: NodeId) -> usize {
        match core.state.node(id) {
            Some(Node::Wire(l)) => l.in_flight.len(),
            other => panic!("expected a Wire, got {other:?}"),
        }
    }

    #[test]
    fn tick_wire_transports_request_one_hop_after_one_tick() {
        // caller -> wire -> handler. A WireRequest admitted at tick 0 is HELD by the
        // wire for >= 1 tick (the maturity gate), then forwarded as an opaque
        // WireEnvelope into the handler's inbox via the ONE route_seq queue.
        let mut core = core_with_seed(1);
        let caller = core.state.add_source();
        let handler = core.state.add_source();
        let wire = core.state.add_wire((caller, 0), (handler, 0));
        core.state.link((wire, 0), (handler, 0)); // wire forwards on port 0 -> handler

        // Tick 0: admit; the request enters the wire's in-flight (entry_tick 0) and is
        // NOT delivered the same tick (>= 1 tick/hop).
        core.advance(&[wire_req((caller, 0), 8, 1, 0, Item(vec![0xDE]))]);
        assert_eq!(in_flight_len(&core, wire), 1, "held in-flight at the admit tick");
        assert!(
            core.state.inbox_of(handler).is_some_and(|i| i.is_empty()),
            "no same-tick delivery (maturity gate)"
        );

        // Tick 1: the wire matures the message and forwards it to the handler's inbox.
        core.advance(&[]);
        assert_eq!(in_flight_len(&core, wire), 0, "forwarded, in-flight drained");
        let mut hinbox = core.state.inbox_of(handler).cloned().expect("handler inbox");
        let (_seq, item) = hinbox.take(0).expect("handler received the forwarded envelope");
        let env = WireEnvelope::decode(&item).expect("a well-formed envelope was delivered");
        assert_eq!(env.correlation, 0x1234);
        assert_eq!(env.return_addr, (caller, 0));
        assert_eq!(env.budget, 8, "the entry-wire hop does not decrement budget");
        assert_eq!(env.payload, Item(vec![0xDE]));
    }

    #[test]
    fn tick_wire_multi_hop_decrements_budget_once_per_delivered_wire() {
        // caller -> wire1 -> wire2 -> handler. The entry wire (wire1) forwards without
        // a decrement; wire2 DECREMENTS on ingest. The handler therefore sees budget-1,
        // proving the DEPTH budget is spent once per wire a message is DELIVERED into.
        let mut core = core_with_seed(1);
        let caller = core.state.add_source();
        let handler = core.state.add_source();
        let wire1 = core.state.add_wire((caller, 0), (handler, 0)); // entry (from.node == caller)
        let wire2 = core.state.add_wire((wire1, 0), (handler, 0));
        core.state.link((wire1, 0), (wire2, 0)); // wire1 -> wire2 inbox
        core.state.link((wire2, 0), (handler, 0)); // wire2 -> handler inbox

        core.advance(&[wire_req((caller, 0), 8, 1, 0, Item(vec![0x11]))]);
        // Drive ticks until the handler receives the twice-hopped envelope.
        let mut delivered: Option<WireEnvelope> = None;
        for _ in 0..10 {
            core.advance(&[]);
            if let Some(inbox) = core.state.inbox_of(handler) {
                let mut clone = inbox.clone();
                if let Some((_seq, item)) = clone.take(0) {
                    delivered = Some(WireEnvelope::decode(&item).expect("well-formed envelope"));
                    break;
                }
            }
        }
        let env = delivered.expect("handler received the multi-hop envelope");
        assert_eq!(env.budget, 7, "one decrement across two wires (entry free, wire2 spends 1)");
        assert_eq!(env.payload, Item(vec![0x11]), "payload transported intact");
        assert_eq!(in_flight_len(&core, wire1), 0, "wire1 drained");
        assert_eq!(in_flight_len(&core, wire2), 0, "wire2 drained");
    }

    #[test]
    fn tick_wire_routing_cycle_faults_on_budget_and_terminates() {
        // WIRE-03 DEPTH bound, integration-reachable: caller -> wire_a <-> wire_b is a
        // routing CYCLE. A request bounces a<->b, spending one budget unit each wire it
        // is delivered into, until the budget is exhausted -> WireOverflow fault at a
        // DETERMINISTIC tick. The cycle TERMINATES (both wires drain) — never OOMs/hangs.
        let mut core = core_with_seed(1);
        let caller = core.state.add_source();
        let wire_a = core.state.add_wire((caller, 0), (caller, 0)); // entry
        let wire_b = core.state.add_wire((wire_a, 0), (caller, 0));
        core.state.link((wire_a, 0), (wire_b, 0));
        core.state.link((wire_b, 0), (wire_a, 0)); // b forwards back to a — the cycle

        core.advance(&[wire_req((caller, 0), 3, 1, 0, Item(vec![0x55]))]);
        let mut faulted_at: Option<u64> = None;
        for _ in 0..40 {
            core.advance(&[]);
            if !core.last_tick.faulted.is_empty() {
                faulted_at = Some(core.tick);
                break;
            }
        }
        assert!(faulted_at.is_some(), "the routing cycle faults (WireOverflow) at a bounded tick");
        // Run a few more ticks; the cycle must fully drain (bounded SPACE, no growth).
        for _ in 0..10 {
            core.advance(&[]);
        }
        assert_eq!(in_flight_len(&core, wire_a), 0, "wire_a drained — the cycle terminated");
        assert_eq!(in_flight_len(&core, wire_b), 0, "wire_b drained — the cycle terminated");
    }

    #[test]
    fn tick_wire_ingest_at_cap_faults_deterministically_and_never_grows() {
        // WIRE-03 SPACE bound on the INGEST path: a wire already at WIRE_INFLIGHT_CAP
        // that receives one more envelope refuses it and FAULTS (WireOverflow) — the
        // in-flight FIFO never grows past the cap.
        let mut core = core_with_seed(1);
        let caller = core.state.add_source();
        let wire = core.state.add_wire((caller, 0), (caller, 0));
        // Pre-fill to the cap with un-matured messages (entry_tick == the tick we run,
        // so the advance below does not drain them).
        if let Some(Node::Wire(l)) = core.state.node_mut(wire) {
            for _ in 0..WIRE_INFLIGHT_CAP {
                l.in_flight.push_back(WireInFlight {
                    entry_tick: 0,
                    correlation: 0,
                    return_addr: (caller, 0),
                    budget: 1,
                    payload: Item(vec![]),
                });
            }
        }
        // Deliver one more envelope into the wire's inbox and wake it.
        let env = WireEnvelope {
            correlation: 9,
            return_addr: (caller, 0),
            budget: 5,
            payload: Item(vec![0xEE]),
        };
        core.state.inbox_mut(wire).push(0, 42, env.encode());
        core.sched.wake_now(wire);

        core.advance(&[]);
        assert_eq!(
            in_flight_len(&core, wire),
            WIRE_INFLIGHT_CAP,
            "over-cap ingest refuses: never grows past the cap"
        );
        assert!(
            core.last_tick.faulted.contains(&wire),
            "an at-cap ingest faults WireOverflow deterministically"
        );
    }

    #[test]
    fn tick_wire_ingest_malformed_envelope_is_dropped_without_panic() {
        // A malformed envelope (untrusted Item bytes) delivered to a wire's inbox is
        // DROPPED on ingest — no panic, nothing admitted, no fault (threat T-37-05b).
        let mut core = core_with_seed(1);
        let caller = core.state.add_source();
        let wire = core.state.add_wire((caller, 0), (caller, 0));
        core.state.inbox_mut(wire).push(0, 1, Item(vec![0xFF, 0xFF, 0xFF]));
        core.sched.wake_now(wire);

        core.advance(&[]);
        assert_eq!(in_flight_len(&core, wire), 0, "garbage dropped, nothing admitted");
        assert!(
            !core.last_tick.faulted.contains(&wire),
            "a malformed envelope is dropped, not a fault"
        );
    }

    /// Build the round-trip topology `caller -> forward_wire -> factory-handler ->
    /// return_wire -> caller`: a factory whose JS emits one `ctx.command` (mapped to
    /// `Effect::Reply` while servicing a wire request, 37-03), an inbound forward wire,
    /// and an outbound return wire. Returns `(core, caller, correlation)`.
    fn reply_round_trip_core() -> (Core, NodeId, u64) {
        // The handler emits one command per serviced request -> the fold turns it into
        // an Effect::Reply routed back by correlation (a non-wire input would stay Noop).
        const HANDLER: &str = "export default function (input, ctx) { ctx.command({ok:1}, 0); }";
        let mut core = core_with_seed(7);
        let caller = core.state.add_source();
        let factory = core.state.add_factory(HANDLER.to_owned(), 256, 7);
        // THE HANDLER DECLARES AN ELECTRICAL In AT PORT 0, and after phase 72 that
        // declaration is what makes it a handler at all (D-16). `add_factory` inserts an
        // inbox and NO ports, and a port-less node reads MECHANICAL
        // (`admit::inbox_class` clause 3), so without this line the request arrives, is
        // never unwrapped, and no reply is ever produced: this whole round trip goes
        // dark rather than red in any way that names its cause. Deleting it does not
        // simplify the fixture, it silences it.
        core.state.set_ports(
            factory,
            vec![crate::state::Port {
                local_offset: (0, 1),
                side: crate::state::Side::W,
                role: crate::state::Role::In,
                medium: crate::state::Medium::Electrical,
            }],
        );
        // Forward wire: caller -> factory (entry wire is `from.node == caller`).
        let forward_wire = core.state.add_wire((caller, 0), (factory, 0));
        core.state.link((forward_wire, 0), (factory, 0));
        // Return wire: factory -> caller (return wire is `from.node == factory`).
        let return_wire = core.state.add_wire((factory, 0), (caller, 0));
        core.state.link((return_wire, 0), (caller, 0));

        let correlation = 0xABCD_1234u64;
        // Admit one request at tick 0 (return_addr == caller). budget 8; the round-trip
        // (forward + return) is bounded by that ONE inherited budget.
        core.advance(&[Event {
            schema_version: SCHEMA_VERSION,
            partition: 0,
            sequence: 1,
            tick: 0,
            payload: EventPayload::WireRequest {
                correlation,
                deadline_tick: 500,
                budget: 8,
                return_addr: (caller, 0),
                // The inner request body the handler's JS parses (valid JSON — the wire
                // envelope wrapping it is stripped by the factory reply seam, 37-03).
                payload: Item(b"{\"n\":1}".to_vec()),
            },
        }]);
        (core, caller, correlation)
    }

    #[test]
    fn reply_round_trip_delivers_reply_to_return_addr() {
        // WIRE-01/WIRE-04 functional half: request -> handler -> reply reverse-transports
        // IN-SIM back to the caller (return_addr) by correlation, via the return wire and
        // the ONE route_seq queue. The caller receives a well-formed reply WireEnvelope.
        let (mut core, caller, correlation) = reply_round_trip_core();

        let mut reply: Option<WireEnvelope> = None;
        for _ in 0..8 {
            core.advance(&[]);
            if let Some(inbox) = core.state.inbox_of(caller) {
                let mut clone = inbox.clone();
                if let Some((_seq, item)) = clone.take(0) {
                    reply = Some(WireEnvelope::decode(&item).expect("a well-formed reply envelope"));
                    break;
                }
            }
        }
        let env = reply.expect("the reply reverse-transported to the caller");
        assert_eq!(env.correlation, correlation, "reply carries the request's correlation");
        assert_eq!(env.return_addr, (caller, 0), "reply routed to return_addr");
        assert_eq!(
            env.budget, 8,
            "reply INHERITS the request's remaining budget (entry + return hops both free here)"
        );
    }

    #[test]
    fn reply_round_trip_replays_byte_identical() {
        // WIRE-04 determinism: two fresh cores built from the SAME imperative topology +
        // the SAME logged WireRequest, folded the SAME number of ticks, reach a
        // byte-identical snapshot — the request->handler->reply round-trip is a pure fold
        // consequence of logged inputs (the reply is never separately logged).
        let (mut a, _caller_a, _corr_a) = reply_round_trip_core();
        let (mut b, _caller_b, _corr_b) = reply_round_trip_core();
        for _ in 0..8 {
            a.advance(&[]);
            b.advance(&[]);
            assert_eq!(
                crate::snapshot::snapshot(&a),
                crate::snapshot::snapshot(&b),
                "per-tick snapshot byte-identical across two genesis folds (replay determinism)"
            );
        }
    }
}
