//! The ONE inbox admission path: a three-way classifier plus the mechanical bound.
//!
//! Every inbox push in the deterministic core routes through [`try_admit`] here. That
//! is a rule with a reason (71-CONTEXT D-03): a cap written at one push site and not at
//! another is the shape this project has repeatedly found to go vacuous, because the
//! site nobody remembered stays uncapped while every test stays green. There are EIGHT
//! non-test push sites in the core (the generic outbox drain, the `OutputRefused` dead
//! letter minted at that same drain, the belt-head delivery and the reply-wire overflow
//! fault in `route_replies` - all four in [`crate::tick`] - and four sites in
//! [`crate::manual_inject`]), and all eight call [`try_admit`]. The count and the
//! parenthesis are checked against
//! `grep -n 'try_admit(' src/tick.rs src/manual_inject.rs`; the dead-letter site is the
//! one plan 71-04 added and the enumeration missed (71-review IN-01).
//!
//! # The three classes
//!
//! * `Fault` - the delivery is addressed to the reserved [`FAULT_PORT`]. Bounded by
//!   [`FAULT_QUEUE_CAP`]. Past the bound the fault is DROPPED (PILE-09 as rewritten by
//!   the 2026-09-01 SCOPE CHANGE, ruling R-16). Ruling R-16 removed every dropped-fault
//!   counter and that still stands for DIAGNOSTIC faults - with ONE exception, at the
//!   generic outbox drain, where the discarded value's payload is the user's own
//!   conveyable rather than a diagnostic. That one drop calls
//!   `GridState::count_dropped_fault` so an item cannot be destroyed with no record
//!   (71-review CR-01).
//! * `Electrical` - a request/response WIRE delivery (Phase 37). EXEMPT from the
//!   mechanical bound entirely: no cap, no backpressure, no refusal path. A wire is not
//!   a queue-based transport; it creates as many messages as a tick needs and answers
//!   all of them, and its own SPACE bound is [`crate::wire::WIRE_INFLIGHT_CAP`] on the
//!   wire's in-flight FIFO, not on the destination inbox (71-CONTEXT D-02).
//! * `Mechanical` - a belt/item delivery. Bounded by [`MECHANICAL_INBOX_CAP`].
//!
//! # What is deliberately NOT here
//!
//! Waking the destination. The belt-head site and the generic outbox drain wake through
//! different guards (one of them must stay at `now + 1`, and its docblock in
//! [`crate::tick`] says why at length), so the wake stays the caller's decision and
//! [`try_admit`] never touches the scheduler.

use crate::fault::FAULT_PORT;
use crate::ids::{Item, NodeId, PortId};
use crate::state::{GridState, ManualInject, Medium, Node};

/// The MECHANICAL inbox cap - the bound on a single input port's queue on any
/// belt/item (non-wire) delivery.
///
/// **What refusal means mechanically.** A mechanical inbox at this many items refuses
/// admission. The refusal is never a silent drop: the belt-head delivery site RETAINS
/// the item in slot 0 so the belt bunches backwards from the head (PILE-01, the exact
/// analog of [`crate::belt_slots`]'s `admit_tail` refuse-on-full), and the generic
/// outbox drain - where `PortOutbox::drain_sorted` has already taken the item out and
/// there is nowhere to put it back - emits a [`crate::fault::FaultReason::OutputRefused`]
/// fault on the EMITTING node's [`FAULT_PORT`] instead. The one exception is documented
/// where it lives, in [`crate::manual_inject`]'s `Input` arm.
///
/// **Why SIXTEEN and not another number.** Small enough that a real board jams VISIBLY -
/// the point of the phase is that a user can point at the machine that is refusing, the
/// way a Factorio player points at a jammed inserter - and large enough that a brief
/// slowdown is absorbed rather than instantly propagated across the whole board. It is
/// deliberately NOT [`crate::wire::WIRE_INFLIGHT_CAP`]'s 256, which bounds a logical
/// (non-spatial) wire and is sized for fan-in, not for legibility.
///
/// **Which decision locked it.** The maintainer's call, taken over a tight
/// 1-2 and over reusing the wire cap's 256.
///
/// **Which fixture bakes it in.** `0030-inbox-saturation-replay`, which plan 71-07
/// adds and blesses. Until that bless lands the golden corpus replays to hashes
/// recorded before this cap existed, and `cert_cross_platform` is red BY DESIGN.
///
/// **ONE constant governs TWO queues** (ruling R-1): a machine inbox and a belt's own
/// staging inbox. They are literally the same [`crate::state::PortInbox`] type stored in
/// the same `GridState.inboxes` map and admitted by this same helper, so two names for
/// one bound would be a mirrored constant - a later edit could move one and not the
/// other while every test stayed green.
pub const MECHANICAL_INBOX_CAP: usize = 16;

/// The SOURCE PENDING cap - the bound on a `ManualInject` source's serialized
/// `pending` deque, the one queue at the TOP of the chain.
///
/// **What refusal means here.** An admission past this bound is REFUSED: the item is
/// not enqueued and the source is NOT woken. It takes the same shape as the `Input`
/// arm's over-cap refusal in [`crate::manual_inject`] and for the same class of reason
/// (ruling R-5): the emitter is the LOGGED EVENT STREAM, not a node, so there is no
/// node whose [`FAULT_PORT`] would be the honest home for the refusal, and the log
/// itself is already the audit trail. `VecDeque` already has `len()`, so nothing is
/// added to a serialized type and 71-CONTEXT D-09 holds.
///
/// **Why this bound has to exist AT ALL, and why plan 71-03 created the need for it.**
/// Before the PILE-02 gate, a Source drained its whole `pending` into its outbox every
/// step and the surplus piled up downstream. Under the gate a Source whose output belt's
/// staging inbox is at [`MECHANICAL_INBOX_CAP`] is not stepped, so `pending` is not
/// drained and GROWS - a serialized, unbounded `VecDeque` inside `Node::Source`. That is
/// the leak PILE-04 exists to close, and without a bound here the phase would merely
/// have RELOCATED the invisible queue one node upstream rather than closed it. The
/// Source is the top of the chain: a bound anywhere else has somewhere further to run.
///
/// **Why the same SIXTEEN.** It governs the same kind of thing for the same reason as
/// [`MECHANICAL_INBOX_CAP`] - small enough that a jammed board stops accepting VISIBLY,
/// large enough that a brief slowdown is absorbed - and a second, different number would
/// have to be justified by a difference nobody has measured. It is a SEPARATE constant
/// rather than a reuse because the two bound different types on different sides of the
/// admission boundary: one is a `PortInbox` port bucket the fold pushes into, the other
/// is a `VecDeque` the event stream pushes into. Ruling R-1's mirrored-constant hazard
/// does not apply, because no edit can move one of these and mean the other.
pub const SOURCE_PENDING_CAP: usize = 16;

/// Would this Source accept ONE more event onto its backlog? True while its `pending`
/// holds fewer than [`SOURCE_PENDING_CAP`] items.
///
/// **The one reading of "this Source refuses" (ruling R-3, plan 87-01, JAM-06).** The
/// refusal itself is ruling R-15's (71-03, PILE-04): the `ManualInject` admit arm in
/// [`crate::manual_inject`] enqueues and wakes only while this holds, and past it the event
/// is dropped silently. `fabrico-host`'s render packet asks the SAME question to paint the
/// Source BACKED_UP and fill its gauge (`render_packet::is_refusing` and `derive_load`,
/// WINDOWS 173): before plan 87-01 the host read only a machine's mechanical inbox, so a
/// Source refusing every event painted WORKING. Two spellings of this comparison, one at
/// the cap site and one in the host, could drift with nothing spanning both crates to
/// notice, which is why both call this function and neither compares against the
/// constant itself.
#[must_use]
pub fn source_accepts_one(source: &ManualInject) -> bool {
    source.pending.len() < SOURCE_PENDING_CAP
}

/// The FAULT QUEUE cap - the bound on a node's reserved [`FAULT_PORT`] bucket, the
/// queue a machine fills when it cannot reach the outside world.
///
/// **What refusal means here: the fault is DROPPED.** Past this bound [`try_admit`]
/// returns the fault to its caller and every caller discards it. Nothing is counted:
/// no field is added to any kind, `SNAPSHOT_SCHEMA_VERSION` does not move, and the two
/// pre-existing `faults` counters ([`crate::state::Router`] and
/// [`crate::state::Factory`]) keep incrementing exactly as they did, because they
/// already exist and cost nothing. That is a change of direction from 71-CONTEXT D-06,
/// which read "counted, not dropped": the maintainer REMOVED the per-machine
/// dropped-fault counter from PILE-09 on 2026-09-01 (a dated scope change, ruling R-16), and REMOVED is not DEFERRED - there is no follow-up work here.
///
/// **What the removal BOUGHT, which is why it is recorded at the constant rather than
/// only in a plan.** A counter is a postcard varint, and a varint crossing 128 widens
/// by a byte. With no counter, PILE-09's acceptance can assert the STRONGER thing:
/// `snapshot::snapshot(&core).len()` is BYTE-EQUAL between the 3x-cap and the 10x-cap
/// points of a Sink under continuous failure. That equality was unassertable while a
/// counter was still in the design.
///
/// **Why SIXTEEN, and the honest statement of what this number does NOT decide.**
/// [`crate::fault::FAULT_PORT`] has no visual magnitude at all: `derive_state` in
/// `fabrico-host` paints a machine FAULTED on a SINGLE unread fault, so one fault and
/// sixteen faults render identically. The number therefore decides exactly one thing -
/// WHERE THE SAVE FILE STOPS GROWING - and nothing a user looks at. Sixteen matches
/// [`MECHANICAL_INBOX_CAP`] because it bounds the same kind of thing (a `PortInbox`
/// port bucket) and a second, different number would have to be justified by a
/// difference nobody has measured.
///
/// **Which decision locked it.** PILE-09 plus ruling R-17 in `71-04-PLAN.md`. R-17 also
/// carries the correction a later reader needs: `REQUIREMENTS.md` groups goldens 0004,
/// 0005 and 0006 under "FAULT CAP", but `gen_0004` links the router's fault to port 0
/// of a collector rather than to [`FAULT_PORT`], so the MECHANICAL cap governs that one
/// and this constant does not. The declared-moves gate checks digests, never reasons,
/// so a wrong reason is invisible to every check in the repository.
///
/// **Why the bound alone would have been dishonest.** Bounding a queue with no exit
/// converts silent unbounded growth into silent loss. PILE-10 lands in the same phase:
/// a node's [`FAULT_PORT`] gains a real spatial nub a user can drag a belt onto, and
/// the fold moves a resting inbox fault to the outbox WHEN AND ONLY WHEN that port is
/// linked. An UNDOCKED fault port still holds its fault and still paints the machine
/// FAULTED, which is the one signal a user has today.
pub const FAULT_QUEUE_CAP: usize = 16;

/// How a single inbox admission is governed. A fold-local classification: it is never
/// serialized, never snapshotted, and deliberately derives NO serde.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AdmitClass {
    /// Addressed to the reserved [`FAULT_PORT`]. Bounded by [`FAULT_QUEUE_CAP`]; past
    /// the bound the fault is DROPPED and nothing counts it (ruling R-16).
    Fault,
    /// A request/response WIRE delivery. EXEMPT from the mechanical bound (D-02).
    Electrical,
    /// A belt/item delivery. Bounded by [`MECHANICAL_INBOX_CAP`].
    Mechanical,
}

/// WHO is delivering, as a type rather than as a `NodeId` with a dishonest value.
///
/// Four of the seven core push sites live in [`crate::manual_inject::admit`], where
/// there IS NO emitting node: the emitter is the logged event stream itself. A bare
/// `from: NodeId` parameter has no honest value at those sites, and both of the
/// dishonest ones are silently wrong. Passing the DESTINATION would make
/// [`admit_class`]'s wire clause ask whether the destination is a wire, exempting a
/// wire-shaped destination from a mechanical delivery. Passing a sentinel that happens
/// to resolve to a live wire would exempt the whole arm.
///
/// [`EventPayload::Input`](crate::event::EventPayload::Input) is exactly how the
/// mechanical arm of this module's own three-arm test is fed. If that arm were silently
/// exempted it would go red, which is the good case; the bad case is a reader taking
/// the red as "the arm is fed through the wrong path" and re-feeding it through a wire,
/// which destroys the proof while turning the suite green. So the wrong spelling is
/// UNREPRESENTABLE here rather than merely discouraged (ruling R-3b).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Emitter {
    /// A live grid node is delivering. Its kind is read structurally from
    /// `GridState.nodes`; there is no in-band signal an ITEM can carry to buy itself
    /// an exemption.
    Node(NodeId),
    /// The logged event stream is delivering. Carried by all four
    /// [`crate::manual_inject::admit`] push sites, and it can never match the wire
    /// clause.
    EventStream,
}

/// The DESTINATION-SIDE half of the classifier: clauses 1, 3 and 4 of ruling R-2, with
/// the emitter clause removed.
///
/// **Clause 1 runs FIRST for a reason that is not stylistic.** [`FAULT_PORT`] is
/// `u16::MAX`. Classifying it before anything else means the reserved port never
/// reaches an index into a node's ports `Vec` (clause 3 also uses `get`, which is
/// bounds-safe by construction, so the two guards are belt and braces - a panic in the
/// deterministic core is a denial of service of the whole sim, threat T-71-01-02).
///
/// **An UNDECLARED port reads Mechanical.** A port-less node (anything built by
/// `add_source`, which is most of the golden corpus) has no `ports` entry, so its port
/// 0 classifies Mechanical and is bounded. The consequence to carry rather than
/// discover: under this reading a port-less collector holding 16 items reads a FULL
/// load, which is the reading that keeps plan 71-05's `derive_load` gauge honest for
/// every core-built collector in the corpus. That plan's cross-invariant test must
/// include a port-less node or it cannot fail on the case that actually occurs.
///
/// This is `pub` because it is the ONE predicate three crates share: plan 71-05's
/// `derive_load` calls it and plan 71-04's restore check derives from it. If the cap
/// site and the gauge used two different readings of "is this port mechanical", the
/// gauge would light on a wire fan-in or stay dark on a genuinely capped port, and the
/// two live in different crates so nothing would notice (ruling R-3).
///
/// **The fourth consumer, added in phase 72 (D-16, ruling R-23).** `tick::step_node`
/// reads this for port 0 and hands the answer to [`crate::factory::step_factory`], where
/// it decides whether a delivery is a WIRE REQUEST (unwrap the `WireEnvelope`, run user
/// JS on its payload, reply on the correlation) or an ORDINARY BELT ITEM (hand the whole
/// bytes to user JS, muted `Effect::Noop`). That site reads THIS function and NOT
/// [`admit_class`], and the difference is not stylistic: see the note on the emitter
/// clause there. The "an UNDECLARED port reads Mechanical" clause above is what keeps a
/// port-less Factory unserviced, which is what holds goldens 0005 and 0027 still.
pub fn inbox_class(state: &GridState, dest: NodeId, dest_port: PortId) -> AdmitClass {
    // Clause 1. FIRST, so u16::MAX never indexes a ports Vec.
    if dest_port == FAULT_PORT {
        return AdmitClass::Fault;
    }
    // Clause 3. The destination port's DECLARED medium. `get` is bounds-safe, and an
    // absent ports entry (a port-less node) yields None.
    let declared_electrical = state
        .ports_of(dest)
        .and_then(|ports| ports.get(dest_port as usize))
        .is_some_and(|p| matches!(p.medium, Medium::Electrical));
    if declared_electrical {
        return AdmitClass::Electrical;
    }
    // Clause 4. Everything else is mechanical and bounded.
    AdmitClass::Mechanical
}

/// The FULL classifier: [`inbox_class`] with the emitter clause layered on it, in the
/// clause order of ruling R-2.
///
/// **The exemption reads the DELIVERING side, and that is a proof rather than a
/// preference.** Two fixtures in the golden corpus are IDENTICAL on the destination
/// side and require opposite outcomes:
///
/// * `0026-wire-cap-overflow-fanin` delivers 256 same-tick wire messages into a
///   port-less `add_source()` node. Every message must arrive; the only thing that
///   refuses anything there is [`crate::wire::WIRE_INFLIGHT_CAP`].
/// * `0001-source-belt-collector` delivers belt items into a port-less `add_source()`
///   node. That one must bunch at the cap (PILE-01).
///
/// Both destinations are port-less, so no default for an undeclared port can separate
/// them: defaulting to Mechanical caps 0026 and moves it, and defaulting to exempt makes
/// PILE-01 vacuous for every port-less collector in the corpus, which is most of it.
/// Reading the EMITTER separates them exactly, and it costs one `BTreeMap` lookup on
/// `nodes`, which is already a `BTreeMap` and therefore carries no iteration-order
/// hazard.
///
/// Clause 3 (the destination port's declared medium) is still needed on top: it covers
/// the demo board's genesis-seeded electrical In handler, whose feeder is not itself a
/// wire node.
///
/// **WHICH QUESTION THIS ONE ANSWERS, stated because two classifiers now exist and a
/// later reader must find an account rather than a contradiction (rulings R-6, R-23).**
/// This function answers "MAY THIS DELIVERY EXCEED THE MECHANICAL INBOX CAP", which is a
/// question about admission capacity, and clause 2 above is why it is the right answer to
/// that one. It is NOT the classifier for "IS THIS MACHINE A HANDLER": that question is
/// answered at [`crate::factory::step_factory`] from [`inbox_class`] alone, because
/// clause 2 would make an undeclared-port Factory serviceable whenever its feeder happens
/// to be a wire, reopening two frozen goldens for a reason nothing declared. If the two
/// classifiers are ever measured DISAGREEING in a real defect rather than in principle,
/// the recorded fix is to stamp the arrival class on the delivery itself, once, at the
/// admit site (`72-CONTEXT.md`'s deferred note).
pub fn admit_class(
    state: &GridState,
    from: Emitter,
    dest: NodeId,
    dest_port: PortId,
) -> AdmitClass {
    // Clause 1. FIRST, for the same reason it is first in `inbox_class`.
    if dest_port == FAULT_PORT {
        return AdmitClass::Fault;
    }
    // Clause 2. The EMITTER is a wire -> electrical, exempt (D-02). `Emitter::EventStream`
    // can never match here, which is the whole point of the type.
    if let Emitter::Node(n) = from
        && matches!(state.node(n), Some(Node::Wire(_)))
    {
        return AdmitClass::Electrical;
    }
    // Clauses 3 and 4.
    inbox_class(state, dest, dest_port)
}

/// Would ONE more item be accepted onto `(dest, dest_port)` under `class`?
///
/// * `Electrical` - always. The exemption is total (D-02).
/// * `Fault` - iff the reserved [`FAULT_PORT`] bucket holds fewer than
///   [`FAULT_QUEUE_CAP`] (PILE-09). It stays its OWN match arm rather than folding into
///   the mechanical one, because the two bounds are separate decisions on separate
///   queues: a later phase moving one must not silently move the other.
/// * `Mechanical` - iff the port's queue holds fewer than [`MECHANICAL_INBOX_CAP`].
///
/// A destination with no inbox at all reads as accepting, which preserves the existing
/// behaviour exactly: `GridState::inbox_mut` panics on an unknown node, and every caller
/// already guards node existence (or relies on the snapshot trust gate's no-dangling-link
/// invariant). This function does not invent a new refusal for that case.
pub fn accepts_one(
    state: &GridState,
    class: AdmitClass,
    dest: NodeId,
    dest_port: PortId,
) -> bool {
    accepts_n(state, class, dest, dest_port, 1)
}

/// Would `n` more items be accepted onto `(dest, dest_port)` under `class`?
///
/// The generalisation of [`accepts_one`], and [`accepts_one`] is now literally
/// `accepts_n(.., 1)` rather than a second reading of the same question. That
/// delegation is the mitigation for threat T-71-03-05: the PILE-02 gate in
/// [`crate::tick`] asks the capacity question about a WHOLE STEP while the push sites
/// ask it about ONE item, and if those were two independent predicates an edit to
/// either would make the gate vacuous silently, in a way no test on either side would
/// notice.
///
/// **Why a COUNT and not a repeated one-item question** (ruling R-11). A node's output
/// ports are wired independently, and NOTHING stops two of them being docked to the
/// same destination port: a Tee with both outputs on one belt is a board a user can
/// draw. The gate therefore groups this node's links BY destination and asks each
/// destination whether it can take as many items as the number of output ports mapping
/// to it. Asking "can it take one" per port would clear a destination with exactly one
/// free slot for TWO items, and the second would be refused at the drain and turn into
/// an `OutputRefused` fault - an item the user drew a belt for that never travels, on a
/// board no test builds unless it is built on purpose.
///
/// `saturating_add` rather than `+`: `n` is a link count and cannot realistically
/// approach `usize::MAX`, but a panic in the deterministic core is a denial of service
/// of the whole sim, so the arithmetic is total by construction rather than by argument.
pub fn accepts_n(
    state: &GridState,
    class: AdmitClass,
    dest: NodeId,
    dest_port: PortId,
    n: usize,
) -> bool {
    // The two bounded arms share one shape and differ ONLY in the constant. They are
    // written out separately rather than through a `cap` local because a reader must be
    // able to see WHICH constant governs WHICH class at the point of refusal: folding
    // them would put the answer one indirection away from the line that refuses.
    match class {
        AdmitClass::Electrical => true,
        AdmitClass::Fault => state.inbox_of(dest).is_none_or(|inbox| {
            inbox.len_on(dest_port).saturating_add(n) <= FAULT_QUEUE_CAP
        }),
        AdmitClass::Mechanical => state.inbox_of(dest).is_none_or(|inbox| {
            inbox.len_on(dest_port).saturating_add(n) <= MECHANICAL_INBOX_CAP
        }),
    }
}

/// THE inbox push. Classify, ask [`accepts_one`], and either place the item or hand it
/// back.
///
/// Returns `Ok(())` when the item was placed, or `Err(item)` - the refusal signal - when
/// the bound refused it, in which case the inbox is left UNCHANGED and never grows past
/// the cap. The exact shape of [`crate::wire::admit`] and [`crate::belt_slots`]'s
/// `admit_tail`: over-cap refuses, never silently drops and never grows.
///
/// It never wakes the destination. Waking is the CALLER's, because the belt-head site
/// and the generic outbox drain wake through different guards and one of them must stay
/// at `now + 1` (see the guard comments in [`crate::tick`], which say at length why).
pub(crate) fn try_admit(
    state: &mut GridState,
    from: Emitter,
    dest: NodeId,
    dest_port: PortId,
    seq: u64,
    item: Item,
) -> Result<(), Item> {
    let class = admit_class(state, from, dest, dest_port);
    if !accepts_one(state, class, dest, dest_port) {
        return Err(item);
    }
    state.inbox_mut(dest).push(dest_port, seq, item);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::Core;
    use crate::event::{Event, EventPayload, LogHeader, SCHEMA_VERSION};
    use crate::state::{Port, Role, Side};

    /// The over-cap fan-in size every arm uses. STRICTLY greater than
    /// [`MECHANICAL_INBOX_CAP`], which is what makes an "everything was delivered"
    /// assertion mean something: an exemption arm on a board that never reached the cap
    /// passes against a build with no cap at all.
    const FAN_IN: usize = MECHANICAL_INBOX_CAP + 8;

    fn core_with_seed(seed: u64) -> Core {
        Core::genesis(LogHeader {
            schema_version: SCHEMA_VERSION,
            seed,
        })
    }

    /// One `EventPayload::Input`: an item arriving at `target`'s port 0 FROM THE LOGGED
    /// EVENT STREAM. There is no emitting node, which is why `admit` carries
    /// [`Emitter::EventStream`] at this site and why the wire clause can never fire for
    /// it.
    fn input_event(target: NodeId, seq: u64, item: Item) -> Event {
        Event {
            schema_version: SCHEMA_VERSION,
            partition: 0,
            sequence: seq,
            tick: 0,
            payload: EventPayload::Input {
                target,
                port: 0,
                item,
            },
        }
    }

    /// One logged `WireRequest` into the entry wire out of `return_addr.0` - the
    /// golden-0026 shape, reproduced in miniature.
    fn wire_request_event(
        return_addr: (NodeId, PortId),
        correlation: u64,
        seq: u64,
        payload: Item,
    ) -> Event {
        Event {
            schema_version: SCHEMA_VERSION,
            partition: 0,
            sequence: seq,
            tick: 0,
            payload: EventPayload::WireRequest {
                correlation,
                deadline_tick: u64::MAX,
                budget: crate::wire::DEFAULT_WIRE_BUDGET,
                return_addr,
                payload,
            },
        }
    }

    /// A node's inbox depth on port 0, read non-destructively.
    fn depth_on_0(core: &Core, id: NodeId) -> usize {
        core.state.inbox_of(id).map_or(0, |i| i.len_on(0))
    }

    /// Declare ONE In port on `id` speaking `medium`. The ONE field arms A and B differ
    /// in.
    fn declare_one_in_port(core: &mut Core, id: NodeId, medium: Medium) {
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

    #[test]
    fn over_cap_fan_in_is_exempt_on_electrical_and_capped_on_mechanical() {
        // PILE-05 / D-02. THREE arms in ONE function so the boards sit side by side and
        // a reader can see which field moved. Two arms cannot do this job: the emitter
        // clause and the declared-medium clause are separate exemptions and the corpus
        // needs both pinned separately, because golden 0026 rides on the emitter clause
        // and the demo board's genesis-seeded electrical In rides on the declared one.
        //
        // Every arm drives `Core::advance`, never a direct `step_*` call. A direct call
        // bypasses the fold, and the fold is where the classification happens - a test
        // that stepped a machine by hand would prove nothing about admission.

        // ---- Arm A: DECLARED ELECTRICAL, fed by the event stream -------------------
        // The destination declares one In port speaking `Medium::Electrical`, and the
        // over-cap fan-in arrives as `EventPayload::Input` events. Exempt by CLAUSE 3
        // (the declared medium).
        //
        // DELIBERATELY NOT WIRE-DELIVERED, and this is the difference from arm C. A
        // wire-fed arm A would be exempted by clause 2 before clause 3 was ever
        // consulted, so it would stay green on a build with the declared-medium clause
        // DELETED - it would be a duplicate of arm C wearing a decorative port. Feeding
        // it from the event stream is what makes it a test of clause 3, and it is also
        // what makes arms A and B differ in EXACTLY ONE FIELD: the port's `medium`.
        let (delivered_a, class_a) = {
            let mut core = core_with_seed(0x0071_010A);
            let d = core.state.add_source();
            declare_one_in_port(&mut core, d, Medium::Electrical);
            let evs: Vec<Event> = (0..FAN_IN)
                .map(|i| input_event(d, i as u64 + 1, Item(vec![(i & 0xFF) as u8])))
                .collect();
            core.advance(&evs);
            (depth_on_0(&core, d), inbox_class(&core.state, d, 0))
        };

        // ---- Arm B: DECLARED MECHANICAL, fed by the event stream -------------------
        // The byte-identical board with that ONE port's medium flipped to
        // `Medium::Mechanical`, fed the SAME over-cap fan-in the SAME way. Delivery
        // stops at MECHANICAL_INBOX_CAP exactly.
        //
        // THIS ARM IS DELIBERATELY NOT WIRE-DELIVERED, and that is the whole reason it
        // can fail. `EventPayload::Input` enters through `manual_inject::admit`, which
        // carries `Emitter::EventStream`; clause 2 keys on the EMITTER being a
        // `Node::Wire` and can never match it. A version of this arm that fanned in
        // through a wire would be exempted by clause 2 and would pass against a build
        // with no mechanical cap at all - the exact vacuous shape this phase exists to
        // refuse. If this arm ever goes red, the answer is NOT to re-feed it through a
        // wire.
        let (delivered_b, class_b) = {
            let mut core = core_with_seed(0x0071_010B);
            let d = core.state.add_source();
            declare_one_in_port(&mut core, d, Medium::Mechanical);
            let evs: Vec<Event> = (0..FAN_IN)
                .map(|i| input_event(d, i as u64 + 1, Item(vec![(i & 0xFF) as u8])))
                .collect();
            core.advance(&evs);
            (depth_on_0(&core, d), inbox_class(&core.state, d, 0))
        };

        // ---- Arm C: PORT-LESS, delivered THROUGH A WIRE ----------------------------
        // The golden-0026 shape in miniature: a port-less `add_source()` destination fed
        // an over-cap same-tick fan-in through one entry wire. Exempt by CLAUSE 2 (the
        // EMITTER is a `Node::Wire`), even though the destination reads Mechanical on
        // its own. This is the pair golden 0026 and golden 0001 form: identical
        // destinations, opposite outcomes, separable only from the delivering side.
        let (delivered_c, class_c_by_emitter, class_c_by_destination) = {
            let mut core = core_with_seed(0x0071_010C);
            let caller = core.state.add_source();
            let handler = core.state.add_source();
            let wire = core.state.add_wire((caller, 0), (handler, 0));
            core.state.link((wire, 0), (handler, 0));
            let evs: Vec<Event> = (0..FAN_IN)
                .map(|i| {
                    wire_request_event(
                        (caller, 0),
                        0x0071_0000 + i as u64,
                        i as u64 + 1,
                        Item(vec![(i & 0xFF) as u8]),
                    )
                })
                .collect();
            // Tick 0 admits the whole fan-in into the entry wire's in-flight FIFO
            // (FAN_IN is far under WIRE_INFLIGHT_CAP, so the wire refuses nothing);
            // the messages mature one hop later and the fold delivers every matured
            // message in one pass, so they land in ONE destination inbox on ONE tick.
            core.advance(&evs);
            for _ in 0..4 {
                core.advance(&[]);
            }
            (
                depth_on_0(&core, handler),
                admit_class(&core.state, Emitter::Node(wire), handler, 0),
                inbox_class(&core.state, handler, 0),
            )
        };

        // The classifier's own reading, asserted directly, so a delivery-count surprise
        // can be told apart from a classification surprise.
        assert_eq!(class_a, AdmitClass::Electrical, "arm A: declared electrical");
        assert_eq!(class_b, AdmitClass::Mechanical, "arm B: declared mechanical");
        assert_eq!(
            class_c_by_emitter,
            AdmitClass::Electrical,
            "arm C: the WIRE emitter exempts it"
        );
        assert_eq!(
            class_c_by_destination,
            AdmitClass::Mechanical,
            "arm C: read from the DESTINATION alone it is mechanical - which is exactly \
             why the destination cannot be what decides"
        );

        // NON-VACUITY, structural rather than a probe: an exemption arm on a board that
        // never reached the cap passes against a build with no cap at all.
        assert!(
            delivered_a > MECHANICAL_INBOX_CAP,
            "arm A delivered {delivered_a}, which must exceed the cap {MECHANICAL_INBOX_CAP} \
             for the exemption to mean anything"
        );
        assert!(
            delivered_c > MECHANICAL_INBOX_CAP,
            "arm C delivered {delivered_c}, which must exceed the cap {MECHANICAL_INBOX_CAP} \
             for the exemption to mean anything"
        );

        assert_eq!(delivered_a, FAN_IN, "arm A: every message delivered (exempt)");
        assert_eq!(
            delivered_b, MECHANICAL_INBOX_CAP,
            "arm B: delivery stops at MECHANICAL_INBOX_CAP"
        );
        assert_eq!(delivered_c, FAN_IN, "arm C: every message delivered (exempt)");
    }
}
