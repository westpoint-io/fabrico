//! LINK-05 (74-06): CONNECT AND DISCONNECT ARE THE SAME VERB PAIR ON A WIRE AS ON A BELT.
//!
//! # What was measured on HEAD before this file existed
//! `Unlink { belt: <a wire>, .. }` returned `Ok` and removed the wire's delivery link.
//! The `Dock` naming the IDENTICAL four fields returned `Err(InvalidDock)`. So a
//! hand-drawn wire could be disconnected through the command layer and never reconnected
//! through it: the user's cable was gone and the verb that would put it back refused.
//! WINDOWS row 65.
//!
//! The whole asymmetry lived in ONE line. `GridLookup::belt_geometry` matched only
//! `Node::Belt(b) if !b.geometry.is_empty()`, so a `Node::Wire` carrier resolved to
//! `None` and the Dock arm refused it before any rule ran. The `Unlink` arm re-checks NO
//! geometry at all, deliberately and for a stated reason, so it never met that line.
//!
//! # The oracle is the SERIALIZED `GridState`, and only that
//! The round-trip row compares `postcard::to_allocvec(&core.state)` taken BEFORE the
//! `Unlink` against the same bytes taken AFTER the `Dock`.
//!
//! **Never the whole `Core` and never a `snapshot` blob.** `Core::tick` is a serialized
//! field (`core.rs`) and `GridSession::apply` advances it on every accepted record, so a
//! `Core`-level byte comparison taken ACROSS TWO APPLIES is unsatisfiable BY
//! CONSTRUCTION: it could only ever be red, and whoever hit it next would rewrite it
//! unsupervised rather than read this paragraph. `GridState` is the thing the pair is
//! claiming to have restored, so `GridState` is what is compared.
//!
//! # The concurrency edge, stated because LINK-05 names one
//! An `Unlink` and its `Dock` are TWO separate certified records applied in order. The
//! sim is single-threaded, so there is no interleaving to reason about, and the byte
//! equality is taken ACROSS THE PAIR rather than inside either half. A partially applied
//! pair is therefore not representable here rather than merely unlikely.
//!
//! # Both negatives are mandatory
//! A reconnect that widened the accept envelope with nothing watching would be worse than
//! the gap it closed. The reconnect must refuse what the original `DrawWire` refuses, so
//! the `MediumMismatch` row reaches the SAME `mediums_compatible` predicate `DrawWire`
//! calls, and the `PortOccupied` row reaches the guard `dock_occupancy.rs` pins. The
//! third row watches this plan's own deliberate NARROWING: the wire carrier is admitted
//! in the Head direction only.
//!
//! Run target: `cargo test -p fabrico-command --test wire_unlink_redock`.

use fabrico_command::{CommandError, GridSession};
use fabrico_core::ids::{NodeId, PortId};
use fabrico_core::state::{Medium, Node};
use fabrico_protocol::{BeltEnd, GridCommand, machine_kind};

const SEED: u64 = 0x0074_0006_C0DE_0005;

/// The electrical Router preset's port indices, lifted from
/// `crates/fabrico-command/tests/undo_restores_a_wire.rs`, which builds the same board.
const WIRE_IN_PORT: PortId = 0;
const WIRE_OUT_PORT: PortId = 1;

/// The serialized `GridState` - the oracle the round-trip row asserts on. See the module
/// header for why this is `GridState` and never `Core` or `snapshot`.
fn state_bytes(session: &GridSession) -> Vec<u8> {
    postcard::to_allocvec(&session.core().state).expect("GridState serializes")
}

/// The single live `Node::Wire` on a board built to hold exactly one.
fn only_wire(session: &GridSession) -> NodeId {
    let state = &session.core().state;
    let found: Vec<NodeId> = state
        .node_ids()
        .filter(|id| matches!(state.node(*id), Some(Node::Wire(_))))
        .collect();
    assert_eq!(found.len(), 1, "this board is built to hold exactly one wire");
    found[0]
}

/// Two electrical Router presets with ONE wire drawn from the first's `Out` to the
/// second's `In` - `gen_0031-undo-delete-of-a-wire`'s board, built the same way and for
/// the same reason: the fixture and this file are two views of one claim.
///
/// Returns `(session, wire id, wire handle, target id, target handle)`.
fn drawn_wire() -> (GridSession, NodeId, u64, NodeId, u64) {
    let mut session = GridSession::new(SEED);
    session
        .place_router_preset(Medium::Electrical, 0, 0)
        .expect("place the source-side electrical Router preset");
    let a = session.core().state.occupied((0, 0)).expect("router at (0,0)");
    session
        .place_router_preset(Medium::Electrical, 10, 10)
        .expect("place the target-side electrical Router preset");
    let b = session.core().state.occupied((10, 10)).expect("router at (10,10)");

    let a_h = session.view().handle_of(a).expect("source router got a handle");
    let b_h = session.view().handle_of(b).expect("target router got a handle");
    session
        .apply(GridCommand::DrawWire {
            from_node: a_h,
            from_port: WIRE_OUT_PORT,
            to_node: b_h,
            to_port: WIRE_IN_PORT,
        })
        .expect("draw the wire between the two electrical Out/In ports");

    let wire = only_wire(&session);
    let wire_h = session.view().handle_of(wire).expect("the wire got a handle");
    (session, wire, wire_h, b, b_h)
}

/// **THE HEADLINE.** Disconnect a hand-drawn wire and reconnect it with the SAME four
/// fields, and the board comes back byte for byte.
///
/// RED ON HEAD BECAUSE: the `Dock` returned `Err(InvalidDock)`. `belt_geometry` answered
/// `None` for the `Node::Wire` carrier and the arm refused before the role rule, the
/// medium gate or anything else ran. The `Unlink` above it returned `Ok` on the same
/// tree, which is exactly what made the gap a trap rather than a limitation.
#[test]
fn an_unlinked_wire_reconnects_through_dock_and_the_grid_state_bytes_return_exactly() {
    let (mut session, wire, wire_h, target, target_h) = drawn_wire();

    // The link `fold_draw_wire` wrote: keyed on the WIRE's own port 0.
    assert_eq!(
        session.core().state.link_target((wire, 0)),
        Some((target, WIRE_IN_PORT)),
        "the drawn wire delivers into the target's In port",
    );
    // THE BYTES BEFORE, taken on the connected board.
    let before = state_bytes(&session);

    // DISCONNECT. This half already worked, and is asserted anyway: a round-trip whose
    // first half quietly did nothing would pass the byte comparison for the wrong reason.
    session
        .apply(GridCommand::Unlink {
            belt: wire_h,
            endpoint: BeltEnd::Head,
            node: target_h,
            port: WIRE_IN_PORT,
        })
        .expect("unlinking a hand-drawn wire is accepted");
    assert_eq!(
        session.core().state.link_target((wire, 0)),
        None,
        "the disconnect actually removed the wire's delivery link",
    );
    assert_ne!(
        state_bytes(&session),
        before,
        "the disconnect moved bytes, so the round-trip below is a real round-trip",
    );

    // RECONNECT, with the IDENTICAL four fields. This is the verdict the whole file is
    // about.
    session
        .apply(GridCommand::Dock {
            belt: wire_h,
            endpoint: BeltEnd::Head,
            node: target_h,
            port: WIRE_IN_PORT,
        })
        .expect("a Dock naming the same wire, endpoint, node and port reconnects it");

    assert_eq!(
        session.core().state.link_target((wire, 0)),
        Some((target, WIRE_IN_PORT)),
        "the reconnect restored the wire's delivery link to the same endpoint",
    );
    // AND THE WHOLE BOARD IS BACK. Named links are not enough: this catches a reconnect
    // that also woke a node, touched an inbox or left a fault behind.
    assert_eq!(
        state_bytes(&session),
        before,
        "the GridState bytes after the Dock equal the bytes before the Unlink",
    );
}

/// NEGATIVE 1. The reconnect refuses what the original `DrawWire` refuses: a Mechanical
/// port earns `MediumMismatch`, from the same `mediums_compatible` predicate.
///
/// A wire is ALWAYS an Electrical carrier. Without the carrier-medium clause the wire
/// branch would have inherited the belt's `Medium::Mechanical` and this row would read
/// `Ok`, quietly linking an electrical cable into a mechanical port.
///
/// RED ON HEAD BECAUSE: the verdict was `InvalidDock`, from the geometry line, not
/// `MediumMismatch` from the medium gate - so on HEAD this asserts a refusal that the
/// arm could not yet produce for this reason.
#[test]
fn a_dock_naming_the_wire_onto_a_mechanical_port_is_refused_medium_mismatch() {
    let (mut session, wire, wire_h, _target, _target_h) = drawn_wire();
    // A FACTORY: catalog index 0 is its `Role::In`, and it is MECHANICAL. The role rule
    // therefore passes for a Head dock and the medium gate is the only thing left to
    // refuse it, which is what makes this row name the predicate it names.
    session
        .apply(GridCommand::Place { kind: machine_kind::FACTORY, cell_x: 30, cell_y: 30 })
        .expect("place a factory on free floor");
    let factory = *session.core().last_tick.placed.last().expect("the factory was minted");
    let factory_h = session.view().handle_of(factory).expect("the factory got a handle");
    assert_eq!(
        session
            .core()
            .state
            .ports_of(factory)
            .expect("a factory declares ports")[0]
            .medium,
        Medium::Mechanical,
        "the target port is Mechanical, which is the whole premise of this row",
    );

    let before = state_bytes(&session);
    let verdict = session.apply(GridCommand::Dock {
        belt: wire_h,
        endpoint: BeltEnd::Head,
        node: factory_h,
        port: 0,
    });
    assert_eq!(
        verdict.err(),
        Some(CommandError::MediumMismatch),
        "an electrical carrier onto a mechanical port is refused by the medium gate",
    );
    assert_eq!(
        session.core().state.link_target((wire, 0)),
        Some((_target, WIRE_IN_PORT)),
        "the refused dock left the wire's real link alone",
    );
    assert_eq!(state_bytes(&session), before, "the refusal moved zero bytes");
}

/// NEGATIVE 2. A `Dock` naming a `(wire,0)` key that is ALREADY linked is refused
/// `PortOccupied`, through this plan's own occupancy guard.
///
/// This is the case that reaches the guard's WIRE-relevant half through the CERTIFIED
/// path: no `Unlink` first, so the key `fold_draw_wire` wrote is still carrying the
/// user's cable. Without the guard the reconnect would have been a silent replace.
///
/// RED ON HEAD BECAUSE: on the pre-guard tree the arm refused this with `InvalidDock`
/// (the geometry line), and on a tree with the widening but WITHOUT the guard it returns
/// `Ok` and overwrites the link.
#[test]
fn a_dock_naming_an_already_linked_wire_key_is_refused_port_occupied() {
    let (mut session, wire, wire_h, target, target_h) = drawn_wire();
    let before = state_bytes(&session);

    let verdict = session.apply(GridCommand::Dock {
        belt: wire_h,
        endpoint: BeltEnd::Head,
        node: target_h,
        port: WIRE_IN_PORT,
    });
    assert_eq!(
        verdict.err(),
        Some(CommandError::PortOccupied),
        "re-docking a wire that is still connected is refused, not silently replaced",
    );
    assert_eq!(
        session.core().state.link_target((wire, 0)),
        Some((target, WIRE_IN_PORT)),
        "the cable the user drew is still the cable on the board",
    );
    assert_eq!(state_bytes(&session), before, "the refusal moved zero bytes");
}

/// NEGATIVE 3, watching this plan's own NARROWING rather than its widening.
///
/// A wire carrier is admitted in the HEAD direction ONLY. A Head dock writes
/// `link((wire,0) -> (node,port))`, byte for byte the link `fold_draw_wire` writes. A
/// Tail dock would write `link((node,port) -> (wire,0))`, a shape no wire in this model
/// has ever had - a wire's SOURCE endpoint lives on its own `WireLink` and never in
/// `links`. Admitting it would widen the certified accept envelope into a state nothing
/// reads and no gesture asks for, which is exactly the tampering T-74-28 names.
///
/// The refusal is `InvalidDock`, which is the tag the shipped copy already covers, and no
/// variant is minted for it.
///
/// # What this row is NOT a witness for, measured
/// It is deliberately not a witness for the WIDENING. With the `Node::Wire` clause
/// removed from `belt_geometry` this row stays GREEN, because the arm then refuses
/// `InvalidDock` at the geometry line for an entirely different reason - measured, 1
/// passed / 3 failed. The other three rows are the widening's witnesses. This row's own
/// mutation is the removal of the direction narrowing above, under which it is the ONLY
/// row that goes red - measured, 3 passed / 1 failed. Stated so nobody reads a green here
/// as evidence the reconnect works.
#[test]
fn a_tail_dock_naming_a_wire_is_refused_because_no_wire_has_that_link_shape() {
    let (mut session, wire, wire_h, target, target_h) = drawn_wire();
    // The target's OUT port, so the Tail direction's role rule (`Out` or `Fault`) passes
    // and the refusal below can only be coming from the direction narrowing itself.
    let out_role = session
        .core()
        .state
        .ports_of(target)
        .expect("the router declares ports")[WIRE_OUT_PORT as usize]
        .role;
    assert_eq!(
        out_role,
        fabrico_core::state::Role::Out,
        "index 1 is the Router's Out, so the Tail direction's role rule is satisfied",
    );

    let before = state_bytes(&session);
    let verdict = session.apply(GridCommand::Dock {
        belt: wire_h,
        endpoint: BeltEnd::Tail,
        node: target_h,
        port: WIRE_OUT_PORT,
    });
    assert_eq!(
        verdict.err(),
        Some(CommandError::InvalidDock),
        "a Tail dock naming a wire carrier is refused: no wire has that link shape",
    );
    assert_eq!(
        session.core().state.link_target((wire, 0)),
        Some((target, WIRE_IN_PORT)),
        "the wire's real link is untouched",
    );
    assert_eq!(state_bytes(&session), before, "the refusal moved zero bytes");
}
