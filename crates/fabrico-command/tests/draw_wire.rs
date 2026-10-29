//! Phase 63-02 (WIRE-01) - the command-layer behaviours of `GridCommand::DrawWire`,
//! the tracer that carries one wire from a gesture-shaped command all the way to a
//! live `Node::Wire`.
//!
//! Everything drives through the public `GridSession::apply(GridCommand::...)` seam,
//! the `configure.rs` idiom, so these are behaviours of the shipped command layer and
//! not of a test-only helper.
//!
//! # Why two electrical Routers and not an Endpoint
//! `place_router_preset(Medium::Electrical, ..)` is the ONLY path the command layer
//! has today to a `Medium::Electrical` port: every port in every `port_catalog` arm is
//! `Medium::Mechanical`, and the preset produces its port profile by stripping
//! the bare catalog ports and re-seeding them at a chosen medium through `AddPort`.
//! `Place{ENDPOINT}` is refused by the kind bound, so an Endpoint-to-Endpoint wire is
//! not buildable from a command until a later phase adds the catalog entry.
//!
//! An electrical preset router therefore carries one `In`/W at index 0 followed by
//! `fabrico_command::ROUTER_OUT_ARITY` `Out`/E ports at indices 1.., all `Electrical`.
//! The constants below name the first three of those indices; they are unchanged by
//! plan 65-05's widening, because the widening APPENDS.
//!
//! Run target: `cargo test -p fabrico-command --test draw_wire`

use fabrico_command::{CommandError, GridLookup, GridSession};
use fabrico_core::edit::EditOp;
use fabrico_core::ids::NodeId;
use fabrico_core::snapshot::snapshot;
use fabrico_core::state::{Medium, Node};
use fabrico_protocol::{GridCommand, machine_kind};

const SEED: u64 = 0x0063_0002_C0FF_EE00;

/// The port indices an electrical `place_router_preset` seeds (see the module doc).
const IN_PORT: u16 = 0;
const OUT_PORT: u16 = 1;
const SECOND_OUT_PORT: u16 = 2;

/// Place an electrical preset Router at `(x, y)` and return its minted `NodeId`.
fn router(session: &mut GridSession, x: i32, y: i32) -> NodeId {
    session
        .place_router_preset(Medium::Electrical, x, y)
        .expect("an electrical router preset places on a free cell");
    router_id_at(session, x, y)
}

/// The `NodeId` of the router anchored at `(x, y)`.
fn router_id_at(session: &GridSession, x: i32, y: i32) -> NodeId {
    session
        .core()
        .state
        .occupied((x, y))
        .expect("the preset router occupies its anchor cell")
}

/// The dense render handle for a `NodeId` (what a `GridCommand` targets).
fn handle(session: &GridSession, id: NodeId) -> u64 {
    session.view().handle_of(id).expect("live node has a handle")
}

/// A session holding two electrical preset routers, plus their ids.
fn two_routers() -> (GridSession, NodeId, NodeId) {
    let mut session = GridSession::new(SEED);
    let a = router(&mut session, 0, 0);
    let b = router(&mut session, 10, 10);
    (session, a, b)
}

/// The `DrawWire` command wiring `(from, from_port) -> (to, to_port)` by handle.
fn draw(
    session: &GridSession,
    from: NodeId,
    from_port: u16,
    to: NodeId,
    to_port: u16,
) -> GridCommand {
    GridCommand::DrawWire {
        from_node: handle(session, from),
        from_port,
        to_node: handle(session, to),
        to_port,
    }
}

/// One live wire, flattened for assertion: its id, its two logical endpoints, and how
/// many messages sit in its FIFO.
type WireShape = (NodeId, (NodeId, u16), (NodeId, u16), usize);

/// Every live `Node::Wire` in the session, as [`WireShape`].
fn wires(session: &GridSession) -> Vec<WireShape> {
    session
        .core()
        .state
        .node_ids()
        .filter_map(|id| match session.core().state.node(id) {
            Some(Node::Wire(w)) => Some((id, w.from, w.to, w.in_flight.len())),
            _ => None,
        })
        .collect()
}

/// The number of live nodes.
fn node_count(session: &GridSession) -> usize {
    session.core().state.node_count()
}

/// Every directed link as `(from, to)`, in the deterministic `links` key order.
fn links(session: &GridSession) -> Vec<((NodeId, u16), (NodeId, u16))> {
    session.core().state.links_iter().collect()
}

/// Assert that applying `cmd` is refused with EXACTLY `expected`, appends nothing to
/// the edit log, and leaves the serialized state byte-identical.
///
/// The three assertions travel together deliberately: a typed error that still
/// appended a record, or that mutated state on the way out, would satisfy any one of
/// them alone. `state_bytes` here is the same whole-`Core` snapshot oracle the core
/// crate's suites use.
fn assert_refused(session: &mut GridSession, cmd: GridCommand, expected: CommandError) {
    let before_len = session.edit_log().len();
    let before_bytes = snapshot(session.core());
    let err = session.apply(cmd).expect_err("the command must be refused");
    assert_eq!(err, expected, "the refusal must carry the exact typed variant");
    assert_eq!(
        session.edit_log().len(),
        before_len,
        "a refused command appends NOTHING to the edit log"
    );
    assert_eq!(
        snapshot(session.core()),
        before_bytes,
        "a refused command leaves the serialized state byte-identical (SC#2)"
    );
}

/// The accept case, asserting all four positive properties in ONE test: the node
/// count grew by exactly one, the new node is a `Node::Wire` carrying the expected
/// endpoints and an EMPTY `in_flight`, `links` grew by exactly one entry keyed
/// `(wire, 0)` and targeting `(to_node, to_port)`, and the minted id was recorded in
/// `last_tick.placed`.
#[test]
fn draw_wire_mints_a_linked_wire_and_appends_one_record() {
    let (mut session, a, b) = two_routers();
    let nodes_before = node_count(&session);
    let links_before = links(&session).len();
    let log_before = session.edit_log().len();

    session
        .apply(draw(&session, a, OUT_PORT, b, IN_PORT))
        .expect("an electrical Out -> electrical In wire is legal");

    // Exactly one record, carrying the two RESOLVED (NodeId, PortId) pairs.
    assert_eq!(
        session.edit_log().len(),
        log_before + 1,
        "one DrawWire command appends exactly one record"
    );
    match &session.edit_log()[log_before].op {
        EditOp::DrawWire {
            from_node,
            from_port,
            to_node,
            to_port,
        } => {
            assert_eq!(*from_node, a);
            assert_eq!(*from_port, OUT_PORT);
            assert_eq!(*to_node, b);
            assert_eq!(*to_port, IN_PORT);
        }
        other => panic!("expected an EditOp::DrawWire, got {other:?}"),
    }

    // Exactly one more node, and it is the wire.
    assert_eq!(
        node_count(&session),
        nodes_before + 1,
        "the fold minted exactly one node"
    );
    let live = wires(&session);
    assert_eq!(live.len(), 1, "exactly one Node::Wire exists");
    let (wire, from, to, in_flight) = live[0];
    assert_eq!(from, (a, OUT_PORT), "WireLink.from is the resolved source");
    assert_eq!(to, (b, IN_PORT), "WireLink.to is the resolved target");
    assert_eq!(in_flight, 0, "a freshly minted wire's in_flight FIFO is empty");

    // Exactly one more link, keyed on the wire's OWN output port, and nothing keyed
    // on its input side (the forward direction is found by `wire_from_node`, a scan).
    let after = links(&session);
    assert_eq!(
        after.len(),
        links_before + 1,
        "the fold added exactly one links entry"
    );
    assert_eq!(
        session.core().state.link_target((wire, 0)),
        Some((b, IN_PORT)),
        "links[(wire, 0)] targets the wire's declared input endpoint"
    );
    assert!(
        !after.iter().any(|(k, _)| k.0 == a && k.1 == OUT_PORT),
        "no links entry is keyed on the wire's INPUT side"
    );

    // The minted id is harvestable, which is what makes the undo inverse buildable.
    assert!(
        session.core().last_tick.placed.contains(&wire),
        "the minted wire id lands in last_tick.placed"
    );

    // The wire is inbox-provisioned: `add_wire` did the mint, not a hand-rolled insert.
    assert!(
        session.core().state.inbox_of(wire).is_some(),
        "the minted wire carries an inbox (GridState::add_wire provisioned it)"
    );
}

/// A mechanical source port is refused by the SHARED `mediums_compatible` predicate.
/// The Mechanical router preset is the buildable mechanical-port machine.
#[test]
fn mechanical_from_port_is_refused_with_medium_mismatch() {
    let mut session = GridSession::new(SEED);
    session
        .place_router_preset(Medium::Mechanical, 0, 0)
        .expect("a mechanical router preset places on a free cell");
    let mech = router_id_at(&session, 0, 0);
    let elec = router(&mut session, 10, 10);

    let cmd = draw(&session, mech, OUT_PORT, elec, IN_PORT);
    assert_refused(&mut session, cmd, CommandError::MediumMismatch);
}

/// A mechanical TARGET port is refused by the same predicate, in the other direction.
#[test]
fn mechanical_to_port_is_refused_with_medium_mismatch() {
    let mut session = GridSession::new(SEED);
    let elec = router(&mut session, 0, 0);
    session
        .place_router_preset(Medium::Mechanical, 10, 10)
        .expect("a mechanical router preset places on a free cell");
    let mech = router_id_at(&session, 10, 10);

    let cmd = draw(&session, elec, OUT_PORT, mech, IN_PORT);
    assert_refused(&mut session, cmd, CommandError::MediumMismatch);
}

/// A source port that is not `Role::Out` is refused. Port 0 of the preset is `In`.
#[test]
fn non_out_from_port_is_refused_with_incompatible_ports() {
    let (mut session, a, b) = two_routers();
    let cmd = draw(&session, a, IN_PORT, b, IN_PORT);
    assert_refused(&mut session, cmd, CommandError::IncompatiblePorts);
}

/// A target port that is not `Role::In` is refused. Port 1 of the preset is `Out`.
#[test]
fn non_in_to_port_is_refused_with_incompatible_ports() {
    let (mut session, a, b) = two_routers();
    let cmd = draw(&session, a, OUT_PORT, b, SECOND_OUT_PORT);
    assert_refused(&mut session, cmd, CommandError::IncompatiblePorts);
}

/// A self-loop is refused HERE, at validate time. The fold deliberately does not
/// re-validate (decision Q2), so this is the only site that can stop one.
#[test]
fn self_loop_is_refused_with_incompatible_ports() {
    let (mut session, a, _b) = two_routers();
    let cmd = draw(&session, a, OUT_PORT, a, IN_PORT);
    assert_refused(&mut session, cmd, CommandError::IncompatiblePorts);
}

/// A port index that names no declared port is refused before anything is frozen.
#[test]
fn out_of_range_port_index_is_refused_with_incompatible_ports() {
    let (mut session, a, b) = two_routers();
    let cmd = draw(&session, a, 99, b, IN_PORT);
    assert_refused(&mut session, cmd, CommandError::IncompatiblePorts);
}

/// An output port that already feeds a link is refused. `links` is a `BTreeMap` keyed
/// by `from`, so a second wire out of one output port would silently REPLACE the first
/// entry and strand the first wire with no record of it.
#[test]
fn already_linked_out_port_is_refused_with_port_occupied() {
    let (mut session, a, b) = two_routers();
    let c = router(&mut session, 20, 20);
    session
        .apply(draw(&session, a, OUT_PORT, b, IN_PORT))
        .expect("the first wire out of port 1 is legal");

    // A SECOND wire out of the same output port, to a different node.
    let cmd = draw(&session, a, OUT_PORT, c, IN_PORT);
    assert_refused(&mut session, cmd, CommandError::PortOccupied);
}

/// The occupancy guard is PER PORT, not per node: a second wire out of the router's
/// OTHER output port is accepted.
///
/// This pins a decision rather than reporting a discovery. `GridState::wire_from_node`
/// takes the FIRST wire out of a node in ascending `NodeId` order and its docblock
/// records the single-wire-per-endpoint topology the request transport assumes, so a
/// node with two outgoing wires resolves to the lower-id one. That is deterministic,
/// so it is not a replay defect, but it does mean the second wire carries no request.
/// Phase 63 does not refuse it: the command layer's job here is to stop a SILENT
/// overwrite of one port, and the UI that makes a two-wire node drawable, along with
/// whatever it should say about it, is a later phase's.
#[test]
fn a_second_wire_out_of_a_different_out_port_is_accepted() {
    let (mut session, a, b) = two_routers();
    let c = router(&mut session, 20, 20);

    session
        .apply(draw(&session, a, OUT_PORT, b, IN_PORT))
        .expect("the first wire, out of port 1");
    session
        .apply(draw(&session, a, SECOND_OUT_PORT, c, IN_PORT))
        .expect("a second wire out of port 2 is a different port, so it is accepted");

    let live = wires(&session);
    assert_eq!(live.len(), 2, "both wires were minted");
    let lowest = live.iter().map(|w| w.0).min().expect("two wires exist");
    assert_eq!(
        session.core().state.wire_from_node(a),
        Some(lowest),
        "wire_from_node resolves the lower-id wire; the second carries no request"
    );
}

/// A handle that resolves to no live node is refused, on either side.
#[test]
fn unresolvable_handle_is_refused_with_unknown_node() {
    let (mut session, a, b) = two_routers();
    let stale = u64::MAX;

    let cmd = GridCommand::DrawWire {
        from_node: stale,
        from_port: OUT_PORT,
        to_node: handle(&session, b),
        to_port: IN_PORT,
    };
    assert_refused(&mut session, cmd, CommandError::UnknownNode);

    let cmd = GridCommand::DrawWire {
        from_node: handle(&session, a),
        from_port: OUT_PORT,
        to_node: stale,
        to_port: IN_PORT,
    };
    assert_refused(&mut session, cmd, CommandError::UnknownNode);
}

/// The catalog fact the whole file rests on, asserted rather than assumed: an
/// electrical preset router really does carry In/Out/Out at `Medium::Electrical`, and
/// a `Place{ROUTER}` alone really does carry mechanical ports. If a later catalog edit
/// falsifies this, every case above would silently start testing something else.
#[test]
fn electrical_preset_ports_are_the_only_electrical_ports_reachable() {
    let mut session = GridSession::new(SEED);
    session
        .apply(GridCommand::Place {
            kind: machine_kind::ROUTER,
            cell_x: 0,
            cell_y: 0,
        })
        .expect("a bare router places");
    let bare = router_id_at(&session, 0, 0);
    let bare_ports = session
        .core()
        .state
        .ports_of(bare)
        .expect("the bare catalog router declares ports")
        .to_vec();
    assert!(
        bare_ports.iter().all(|p| p.medium == Medium::Mechanical),
        "every bare catalog port is Mechanical: {bare_ports:?}"
    );

    let elec = router(&mut session, 10, 10);
    let ports = session
        .core()
        .state
        .ports_of(elec)
        .expect("the preset router declares ports")
        .to_vec();
    // Derived, never restated: the preset seeds one In plus the shared Out arity, and
    // the count is read out of `fabrico_command` rather than written down here. A
    // literal here passes under a wrong shared constant, which is the exact drift
    // ROUTE-02 closes. Since 85-05 (D-22) it also seeds one Fault, LAST, at Mechanical:
    // a Router's fault drains on a belt, so it is the one port of an HTTP Router that
    // is NOT electrical, and no wire case in this file can reach it.
    assert_eq!(
        ports.len(),
        2 + fabrico_command::ROUTER_OUT_ARITY as usize,
        "the preset seeds one In, the shared Out arity and one Fault",
    );
    assert!(
        ports
            .iter()
            .filter(|p| p.role != fabrico_core::state::Role::Fault)
            .all(|p| p.medium == Medium::Electrical),
        "every preset In and Out is Electrical: {ports:?}"
    );
    let last = ports.last().expect("the preset has ports");
    assert_eq!(
        (last.role, last.medium),
        (fabrico_core::state::Role::Fault, Medium::Mechanical),
        "the preset's last port is its Mechanical Fault: {ports:?}"
    );
    assert_eq!(ports[IN_PORT as usize].role, fabrico_core::state::Role::In);
    assert_eq!(ports[OUT_PORT as usize].role, fabrico_core::state::Role::Out);
    assert_eq!(
        ports[SECOND_OUT_PORT as usize].role,
        fabrico_core::state::Role::Out
    );
}

// ===========================================================================
// Phase 63-05 (CONNECT-01) - `GridCommand::Unlink`, the explicit disconnect verb
//
// `EditOp::Unlink` and `fold_unlink` have existed since Phase 12, but nothing on
// the command wire mapped to them: the op was produced only internally, by the
// undo driver, as a `Dock`'s inverse. These cases pin the shape of the command
// that now reaches it, and they live beside the `DrawWire` cases because connect
// and disconnect are two halves of one verb.
//
// # The port keyspace, and why it is the whole risk here
// A `GridCommand` addresses a machine port by its CATALOG INDEX. A `links` entry
// is keyed in the ROUTING keyspace: `fold_dock`'s Tail arm links `(node, port)`
// where `port` is the 0-based position among the node's `Role::Out` ports (or
// `FAULT_PORT`), because that is the keyspace machines EMIT on. The `Dock` arm
// performs that translation before freezing. An `Unlink` that carried the catalog
// index through verbatim would compute a DIFFERENT key and remove nothing, while
// reporting success - so these tests assert the FROZEN port, not only the outcome.
//
// A ROUTER's catalog is [In (index 0), Out (index 1)]; its Out's routing key is 0.
// Those two numbers collide in the `(node, port)` keyspace, which is why the arm
// refuses a Tail unlink naming an In port rather than translating it.
// ===========================================================================

use fabrico_core::edit::BeltEnd;

/// Place `kind` at `(x, y)` and return the minted node's dense render handle.
fn place(session: &mut GridSession, kind: u8, cell_x: i32, cell_y: i32) -> u64 {
    session
        .apply(GridCommand::Place { kind, cell_x, cell_y })
        .expect("place at a free cell");
    let id = *session
        .core()
        .last_tick
        .placed
        .last()
        .expect("the place minted a node");
    session.view().handle_of(id).expect("the node got a handle")
}

/// Draw a belt along `cells` and return the minted belt's dense render handle.
fn draw_belt(session: &mut GridSession, cells: Vec<(i32, i32)>) -> u64 {
    session
        .apply(GridCommand::DrawBelt { cells })
        .expect("a clear drawn path is accepted");
    let id = *session
        .core()
        .last_tick
        .placed
        .last()
        .expect("the draw minted a belt");
    session.view().handle_of(id).expect("the belt got a handle")
}

/// The serialized `GridState` bytes - the topology oracle these cases compare on.
///
/// NOT `snapshot(core)`: that serializes the whole `Core`, whose FIRST field is the
/// monotonic tick, and every accepted command advances it. Plan 63-03 measured that
/// and replaced the same unattainable whole-`Core` criterion for the same reason. A
/// `GridState` comparison is the strongest oracle that is actually a function of the
/// topology: it covers nodes, inboxes, links, cells, footprints and ports.
fn grid_state_bytes(session: &GridSession) -> Vec<u8> {
    postcard::to_allocvec(&session.core().state).expect("GridState is plain serde data")
}

/// Resolve a dense render handle back to its `NodeId`.
fn id_of(session: &GridSession, handle: u64) -> NodeId {
    session
        .view()
        .lookup(session.core())
        .resolve(handle)
        .expect("the handle resolves to a live node")
}

/// A ROUTER at `(0, 0)` with a belt docked TAIL-first to its Out port.
///
/// The geometry is the proven-valid offload from `undo_inverse_dock`: the router's
/// Out port (catalog index 1) sits at world `(1, 1)` facing E (the middle row since
/// plan 74.1-14; it was `(1, 2)`), and a belt drawn `(2,1) -> (3,1)` presents its tail
/// one step E of that port, facing W.
/// Returns the session, the router handle and the belt handle.
fn docked_offload() -> (GridSession, u64, u64) {
    let mut session = GridSession::new(SEED);
    let router = place(&mut session, machine_kind::ROUTER, 0, 0);
    let belt = draw_belt(&mut session, vec![(2, 1), (3, 1)]);
    session
        .apply(GridCommand::Dock {
            belt,
            endpoint: fabrico_protocol::BeltEnd::Tail,
            node: router,
            port: ROUTER_OUT_CATALOG,
        })
        .expect("a valid offload dock is accepted");
    (session, router, belt)
}

/// The ROUTER catalog's In port index (`port_catalog`: In at 0, Out at 1).
const ROUTER_IN_CATALOG: u16 = 0;
/// The ROUTER catalog's Out port index. Its ROUTING key is 0 - the collision above.
const ROUTER_OUT_CATALOG: u16 = 1;

/// The `Unlink` command naming a machine port by CATALOG index.
fn unlink(belt: u64, endpoint: fabrico_protocol::BeltEnd, node: u64, port: u16) -> GridCommand {
    GridCommand::Unlink { belt, endpoint, node, port }
}

/// Behaviour 1: the command validates to `EditOp::Unlink` with BOTH handles resolved
/// and the port translated into the link keyspace `fold_dock` wrote.
#[test]
fn unlink_validates_to_a_resolved_editop_unlink() {
    let (mut session, router, belt) = docked_offload();
    let router_id = id_of(&session, router);
    let belt_id = id_of(&session, belt);

    let rec = session
        .apply(unlink(belt, fabrico_protocol::BeltEnd::Tail, router, ROUTER_OUT_CATALOG))
        .expect("an unlink of a live dock is accepted");

    assert_eq!(
        rec.op,
        EditOp::Unlink {
            belt: belt_id,
            endpoint: BeltEnd::Tail,
            node: router_id,
            port: 0,
        },
        "the frozen Unlink carries resolved NodeIds AND the Out ROUTING key (catalog 1 -> emit 0), \
         which is the key fold_dock wrote and the only key fold_unlink can remove"
    );
}

/// Behaviour 2: applying it removes EXACTLY the directed link the matching `Dock`
/// created, and nothing else.
#[test]
fn unlink_removes_exactly_the_docked_link() {
    let (mut session, router, belt) = docked_offload();
    let router_id = id_of(&session, router);
    let belt_id = id_of(&session, belt);
    let before = links(&session);
    assert!(
        before.contains(&((router_id, 0), (belt_id, 0))),
        "the dock linked (router, emit 0) -> (belt, 0): {before:?}"
    );

    session
        .apply(unlink(belt, fabrico_protocol::BeltEnd::Tail, router, ROUTER_OUT_CATALOG))
        .expect("an unlink of a live dock is accepted");

    let after = links(&session);
    let expected: Vec<_> = before
        .iter()
        .copied()
        .filter(|entry| *entry != ((router_id, 0), (belt_id, 0)))
        .collect();
    assert_eq!(
        after, expected,
        "exactly the one docked entry is gone and every other link is untouched"
    );
}

/// Behaviour 3, and the decision this arm pins: unlinking a link that does NOT exist
/// is ACCEPTED at validate time and folds to a panic-free no-op.
///
/// The choice mirrors the `Configure` arm's resolve-only precedent - a wrong-kind
/// config folds to a no-op, so validity is a resolve-only gate there too - and rests
/// on `GridState::unlink`'s documented behaviour: removing an absent key is already
/// safe, strictly safer than `fold_dock`'s missing-node guard. The alternative
/// (refusing an absent link) would need validate to read the live `links` map, which
/// is a second accept-envelope for the same gesture. Pinned here so Phase 67 cannot
/// rediscover it as an open question with a UI already built on the other answer.
#[test]
fn unlink_of_an_absent_link_is_accepted_and_folds_to_a_noop() {
    let (mut session, router, belt) = docked_offload();
    session
        .apply(unlink(belt, fabrico_protocol::BeltEnd::Tail, router, ROUTER_OUT_CATALOG))
        .expect("the first unlink removes the link");
    let after_first = grid_state_bytes(&session);
    let log_len = session.edit_log().len();

    session
        .apply(unlink(belt, fabrico_protocol::BeltEnd::Tail, router, ROUTER_OUT_CATALOG))
        .expect("a second unlink of the SAME link is accepted, not refused");

    assert_eq!(
        grid_state_bytes(&session),
        after_first,
        "the second unlink folds to a no-op: the serialized GridState is byte-identical"
    );
    assert_eq!(
        session.edit_log().len(),
        log_len + 1,
        "the accepted no-op still appends its record (it is a normal accepted command)"
    );
}

/// Behaviour 4: an unresolvable BELT handle is refused with `UnknownNode` and appends
/// nothing.
#[test]
fn unlink_with_an_unresolvable_belt_handle_is_refused_with_unknown_node() {
    let (mut session, router, _belt) = docked_offload();
    assert_refused(
        &mut session,
        unlink(u64::MAX, fabrico_protocol::BeltEnd::Tail, router, ROUTER_OUT_CATALOG),
        CommandError::UnknownNode,
    );
}

/// Behaviour 4, the other handle: an unresolvable MACHINE handle is refused with
/// `UnknownNode` and appends nothing.
#[test]
fn unlink_with_an_unresolvable_machine_handle_is_refused_with_unknown_node() {
    let (mut session, _router, belt) = docked_offload();
    assert_refused(
        &mut session,
        unlink(belt, fabrico_protocol::BeltEnd::Tail, u64::MAX, ROUTER_OUT_CATALOG),
        CommandError::UnknownNode,
    );
}

/// Behaviour 5: `Unlink` then `Undo` restores the link, and the serialized topology
/// is BYTE-IDENTICAL to the pre-unlink state - not merely the same link count.
///
/// The inverse of an unlink is the `Dock` that created it, so this asserts the whole
/// round trip: same key, same value, same map ordering, same everything else.
#[test]
fn unlink_then_undo_restores_the_link_byte_identically() {
    let (mut session, router, belt) = docked_offload();
    let before = grid_state_bytes(&session);

    session
        .apply(unlink(belt, fabrico_protocol::BeltEnd::Tail, router, ROUTER_OUT_CATALOG))
        .expect("the unlink is accepted");
    assert_ne!(
        grid_state_bytes(&session),
        before,
        "the unlink actually moved the serialized topology (else the undo proves nothing)"
    );

    session.apply(GridCommand::Undo).expect("undo the unlink");
    assert_eq!(
        grid_state_bytes(&session),
        before,
        "undoing an unlink re-Docks exactly the link it removed: GridState is byte-identical"
    );
}

/// Behaviour 6: the redo direction re-applies the unlink, with both endpoints
/// retargeted through the id translation.
#[test]
fn undo_then_redo_re_applies_the_unlink() {
    let (mut session, router, belt) = docked_offload();
    let router_id = id_of(&session, router);
    let belt_id = id_of(&session, belt);

    session
        .apply(unlink(belt, fabrico_protocol::BeltEnd::Tail, router, ROUTER_OUT_CATALOG))
        .expect("the unlink is accepted");
    let unlinked = grid_state_bytes(&session);

    session.apply(GridCommand::Undo).expect("undo the unlink");
    assert!(
        links(&session).contains(&((router_id, 0), (belt_id, 0))),
        "the undo restored the link"
    );

    session.apply(GridCommand::Redo).expect("redo the unlink");
    assert!(
        !links(&session).contains(&((router_id, 0), (belt_id, 0))),
        "the redo removed it again"
    );
    assert_eq!(
        grid_state_bytes(&session),
        unlinked,
        "redo reproduces the post-unlink topology byte-for-byte"
    );
}

/// A HEAD (load) unlink removes the BELT-keyed entry, not the machine-keyed one.
///
/// `fold_dock`'s Head arm links `(belt, 0) -> (node, port)`, so the key lives on the
/// belt and the machine port rides only as the link's VALUE. The two directions are
/// asserted separately because a single arm that got the endpoint wrong would still
/// pass the Tail case.
#[test]
fn head_unlink_removes_the_belt_keyed_link() {
    // The proven-valid LOAD geometry: a ROUTER at (5,5) has its In port (catalog 0)
    // at world (5,6) facing W (the middle row since 74.1-14); a belt drawn
    // (3,6) -> (4,6) presents its HEAD one step W of that port, facing E.
    let mut session = GridSession::new(SEED);
    let router = place(&mut session, machine_kind::ROUTER, 5, 5);
    let belt = draw_belt(&mut session, vec![(3, 6), (4, 6)]);
    session
        .apply(GridCommand::Dock {
            belt,
            endpoint: fabrico_protocol::BeltEnd::Head,
            node: router,
            port: ROUTER_IN_CATALOG,
        })
        .expect("a valid load dock is accepted");
    let router_id = id_of(&session, router);
    let belt_id = id_of(&session, belt);
    assert!(
        links(&session).contains(&((belt_id, 0), (router_id, ROUTER_IN_CATALOG))),
        "the load dock keyed the link on the BELT"
    );

    let rec = session
        .apply(unlink(belt, fabrico_protocol::BeltEnd::Head, router, ROUTER_IN_CATALOG))
        .expect("the head unlink is accepted");
    assert_eq!(
        rec.op,
        EditOp::Unlink {
            belt: belt_id,
            endpoint: BeltEnd::Head,
            node: router_id,
            port: ROUTER_IN_CATALOG,
        },
        "an In port needs NO routing translation (In ports come first in every catalog)"
    );
    assert!(
        !links(&session).contains(&((belt_id, 0), (router_id, ROUTER_IN_CATALOG))),
        "the head unlink removed the belt-keyed entry"
    );
}

/// The port-keyspace collision, refused rather than translated.
///
/// A ROUTER's In port has catalog index 0, and its Out port's ROUTING key is also 0.
/// A Tail (offload) unlink naming catalog index 0 therefore names an In port whose
/// index, carried through, is exactly the live Out link's key. Refusing on the role,
/// which is the same direction rule `Dock` applies, is what keeps the two numbers
/// from aliasing and silently disconnecting a link the user did not name.
#[test]
fn tail_unlink_naming_an_in_port_is_refused_rather_than_removing_the_out_link() {
    let (mut session, router, belt) = docked_offload();
    let router_id = id_of(&session, router);
    let belt_id = id_of(&session, belt);

    assert_refused(
        &mut session,
        unlink(belt, fabrico_protocol::BeltEnd::Tail, router, ROUTER_IN_CATALOG),
        CommandError::InvalidDock,
    );
    assert!(
        links(&session).contains(&((router_id, 0), (belt_id, 0))),
        "the Out link the aliasing key would have hit is still there"
    );
}

/// A port index naming no declared port is refused, rather than freezing a key that
/// could only ever fold to a no-op.
#[test]
fn unlink_of_an_undeclared_port_index_is_refused() {
    let (mut session, router, belt) = docked_offload();
    assert_refused(
        &mut session,
        unlink(belt, fabrico_protocol::BeltEnd::Tail, router, 99),
        CommandError::InvalidDock,
    );
}

/// The multi-Out translation, the case a single-Out router cannot distinguish: a TEE
/// declares [In(0), Out(1), Out(2)], so catalog index 2 is the SECOND Out and its
/// routing key is 1. An arm that carried the catalog index through would freeze 2 and
/// remove nothing.
#[test]
fn unlink_translates_a_tee_second_out_catalog_index_to_its_routing_key() {
    // The TEE at (0,0) is 2x2 with its second Out at world (1,1) facing E; a belt
    // drawn (2,1) -> (3,1) presents its tail one step E of that port, facing W.
    let mut session = GridSession::new(SEED);
    let tee = place(&mut session, machine_kind::TEE, 0, 0);
    let belt = draw_belt(&mut session, vec![(2, 1), (3, 1)]);
    session
        .apply(GridCommand::Dock {
            belt,
            endpoint: fabrico_protocol::BeltEnd::Tail,
            node: tee,
            port: 2,
        })
        .expect("a valid offload dock to the tee's second Out is accepted");
    let tee_id = id_of(&session, tee);
    let belt_id = id_of(&session, belt);
    assert!(
        links(&session).contains(&((tee_id, 1), (belt_id, 0))),
        "the dock keyed the second Out on routing key 1"
    );

    let rec = session
        .apply(unlink(belt, fabrico_protocol::BeltEnd::Tail, tee, 2))
        .expect("the unlink of the tee's second Out is accepted");
    assert_eq!(
        rec.op,
        EditOp::Unlink {
            belt: belt_id,
            endpoint: BeltEnd::Tail,
            node: tee_id,
            port: 1,
        },
        "catalog index 2 -> the 1st (0-based) Role::Out -> routing key 1, the SAME \
         translation the Dock arm froze"
    );
    assert!(
        !links(&session).contains(&((tee_id, 1), (belt_id, 0))),
        "the unlink removed exactly that entry"
    );
}

/// THE CLIENT SENTENCE IS LOCKED TO THE HOST VERDICT (plan 75-07, D-12, UI-SPEC 5.3).
///
/// The Wire tool refuses a press on a port that only takes belts at the press, in the
/// client's own words (`That port takes belts, not wires.`), and sends nothing. That is
/// only honest if the host would refuse a wire on that port anyway. The client fires on
/// exactly the ports where `mediumsCompatible(port.medium, MEDIUM_ELECTRICAL)` is false,
/// so this walks every `port_catalog` kind and every `Medium::Mechanical` port on it, on
/// a freshly placed machine, and asserts a `DrawWire` naming that port is refused both
/// as the SOURCE (to a fresh Route's electrical In) and as the TARGET (from a fresh
/// Route's electrical Out). Any refusal passes: an In or a Fault as a source is refused
/// on role at step (4) before the medium is read, and that is still a refusal. An `Ok`
/// fails, naming the kind and the port.
///
/// `mechanical_from_port_is_refused_with_medium_mismatch` and
/// `mechanical_to_port_is_refused_with_medium_mismatch` above pin the exact tag on the
/// mechanical Router preset; this covers the catalog the user can actually place.
///
/// Shown able to fail (75-07-SUMMARY.md): with the medium check removed from
/// `resolve_wire_leg`, this test reddens.
#[test]
fn every_belt_only_catalog_port_is_refused_as_a_wire_source_and_target() {
    const KIND_AT: (i32, i32) = (2, 2);
    const ROUTE_AT: (i32, i32) = (14, 14);
    /// The Route's catalog ports: In at 0, Out at 1, both electrical.
    const ROUTE_IN: u16 = 0;
    const ROUTE_OUT: u16 = 1;

    let place = |session: &mut GridSession, kind: u8, at: (i32, i32)| -> NodeId {
        session
            .apply(GridCommand::Place {
                kind,
                cell_x: at.0,
                cell_y: at.1,
            })
            .unwrap_or_else(|e| panic!("kind {kind} places at {at:?}: {e:?}"));
        session
            .core()
            .state
            .occupied(at)
            .expect("the placed machine occupies its anchor cell")
    };

    let mut walked_kinds: Vec<u8> = Vec::new();
    let mut refusals: Vec<(u8, usize, &'static str, CommandError)> = Vec::new();
    for kind in (0..=u8::MAX).filter(|k| fabrico_command::kind_has_catalog_arm(*k)) {
        let (_, catalog) = fabrico_command::port_catalog(kind);
        for (index, port) in catalog.iter().enumerate() {
            if port.medium != Medium::Mechanical {
                continue;
            }
            let port_index = u16::try_from(index).expect("a catalog index fits a u16");
            for as_source in [true, false] {
                let mut session = GridSession::new(SEED);
                let machine = place(&mut session, kind, KIND_AT);
                let route = place(&mut session, machine_kind::ENDPOINT, ROUTE_AT);
                // The index the command names is the catalog port this loop read: a fresh
                // machine's live ports are its catalog ports, in catalog order.
                let live = session
                    .core()
                    .state
                    .ports_of(machine)
                    .expect("a live machine has ports")
                    .to_vec();
                assert_eq!(
                    (live[index].role, live[index].medium),
                    (port.role, port.medium),
                    "kind {kind} port {index}: the live port is the catalog port"
                );
                let route_ports = session.core().state.ports_of(route).expect("Route ports").to_vec();
                assert_eq!(
                    (
                        route_ports[ROUTE_IN as usize].medium,
                        route_ports[ROUTE_OUT as usize].medium
                    ),
                    (Medium::Electrical, Medium::Electrical),
                    "the Route's In and Out are electrical"
                );
                let (cmd, end) = if as_source {
                    (draw(&session, machine, port_index, route, ROUTE_IN), "source")
                } else {
                    (draw(&session, route, ROUTE_OUT, machine, port_index), "target")
                };
                match session.apply(cmd) {
                    Ok(_) => panic!(
                        "kind {kind} port {index} ({:?}, Mechanical) was ACCEPTED as a wire {end}: \
                         the client would say `That port takes belts, not wires.` about a port \
                         the host wires",
                        port.role
                    ),
                    Err(e) => refusals.push((kind, index, end, e)),
                }
            }
            if walked_kinds.last() != Some(&kind) {
                walked_kinds.push(kind);
            }
        }
    }
    for (kind, index, end, err) in &refusals {
        println!("kind {kind} port {index} as {end}: refused {err:?}");
    }
    // Not vacuous: the kinds whose belt-only ports the user meets with the Wire tool are
    // in the walk (the Router's ports, the reported case, and a Handler's mechanical Fault drain).
    for must in [machine_kind::ROUTER, machine_kind::FACTORY, machine_kind::HANDLER] {
        assert!(
            walked_kinds.contains(&must),
            "kind {must} has a belt-only port and was walked"
        );
    }
    assert!(
        refusals
            .iter()
            .any(|(k, _, end, e)| *k == machine_kind::ROUTER
                && *end == "source"
                && *e == CommandError::MediumMismatch),
        "a Router's belt-only Out as a wire source is refused on the medium itself"
    );
}
