//! Review round 4 IN-03 (plan 74.1-32): a FAULT add whose grown box would cover a belt is
//! refused at the command layer, with nothing logged.
//!
//! # Why this file exists
//! `crates/fabrico-core/tests/reseat_release.rs` (`a_widening_add_keeps_the_fault_nub_and_
//! moves_the_out_column_onto_its_belt`) folds this exact add verbatim, as a forged log
//! would, and asserts the geometry the refusal rests on: a third Fault on a half-turned
//! Router `[In, Out, Fault, Fault]` widens the box, and the Out column moves one cell west
//! onto the cell its belt's Tail holds. Its comment cited `add_output_golden.rs` and
//! `reseat_undo_redock.rs` as the command-layer pins of the refusal, but both send only
//! "+ Add output", an OUT add that grows the box TALLER. No test sent a Fault add that
//! WIDENS the box onto a belt, so narrowing the `AddPort` arm's collision walk to Out adds
//! would have stayed green everywhere. This is that test.
//!
//! # The board, built through `GridSession::apply` only
//! A catalog Router at (10,10) is `[In, Out, Out, Out, Fault]` (2x3). Its second and third
//! Outs are removed (a removal never shrinks the box or moves a survivor, plan 74.1-16) and
//! a Fault added, which takes Fault slot 1 at local (1,2) without growing: `[In, Out, Fault,
//! Fault]`, the core test's board. Turned half way (rot 2), the Out sits at world (10,11)
//! facing W, so a belt leaves (9,11) west on it, docked by its first tile.
//!
//! Run target: `cargo test -p fabrico-command --test fault_add_covers_belt`.

use fabrico_command::{CommandError, GridSession};
use fabrico_core::ids::NodeId;
use fabrico_core::state::{Footprint, Role, Side, port_world, unit_delta};
use fabrico_protocol::{BeltEnd, GridCommand, machine_kind, port_medium, port_role};

const SEED: u64 = 0x0074_0132_FA17_0000;

/// The most recently minted node and its dense render handle.
fn last_minted(session: &GridSession) -> (NodeId, u64) {
    let id = *session.core().last_tick.placed.last().expect("a node was minted");
    (id, session.view().handle_of(id).expect("the node got a handle"))
}

/// The world cell catalog port `idx` of `m` faces, read off the live core.
fn doorstep(session: &GridSession, m: NodeId, idx: usize) -> (i32, i32) {
    let state = &session.core().state;
    let port = state.ports_of(m).expect("ports")[idx];
    let fp = state.footprint_of(m).expect("footprint");
    let anchor = state.cell_of(m).expect("the machine has a cell");
    let (pcell, side) = port_world(anchor, fp.w, fp.h, fp.rot, &port);
    let (dx, dy) = unit_delta(side);
    (pcell.0 + dx, pcell.1 + dy)
}

/// The panel-shaped AddPort of a Fault on handle `h`.
fn add_fault(h: u64) -> GridCommand {
    GridCommand::AddPort { node: h, role: port_role::FAULT, side: Side::S as u8, medium: port_medium::MECHANICAL }
}

#[test]
fn a_fault_add_that_widens_a_half_turned_router_over_its_out_belt_is_refused() {
    let mut session = GridSession::new(SEED);
    session
        .apply(GridCommand::Place { kind: machine_kind::ROUTER, cell_x: 10, cell_y: 10 })
        .expect("place the router");
    let (m, h) = last_minted(&session);
    // [In, Out, Out, Out, Fault] -> [In, Out, Fault] -> [In, Out, Fault, Fault].
    for index in [3, 2] {
        session.apply(GridCommand::RemovePort { node: h, index }).expect("remove an undocked Out");
    }
    session.apply(add_fault(h)).expect("a second Fault fits the 2x3 box");
    for _ in 0..2 {
        session.apply(GridCommand::Rotate { node: h, ccw: false }).expect("turn the undocked router");
    }
    let state = &session.core().state;
    assert_eq!(
        state.ports_of(m).expect("ports").iter().map(|p| p.role).collect::<Vec<_>>(),
        vec![Role::In, Role::Out, Role::Fault, Role::Fault],
        "MEASURED: the core test's port list"
    );
    assert_eq!(state.footprint_of(m), Some(Footprint { w: 2, h: 3, rot: 2 }), "MEASURED: a half-turned 2x3");
    assert_eq!(doorstep(&session, m, 1), (9, 11), "MEASURED: the Out faces (9,11)");

    session.apply(GridCommand::DrawBelt { cells: vec![(9, 11), (8, 11)] }).expect("a belt west off the Out");
    let (belt, belt_h) = last_minted(&session);
    session
        .apply(GridCommand::Dock { belt: belt_h, endpoint: BeltEnd::Tail, node: h, port: 1 })
        .expect("the belt's first tile docks on the Out");

    let before = postcard::to_allocvec(&session.core().state).expect("state serializes");
    let log_len = session.edit_log().len();
    assert_eq!(
        session.apply(add_fault(h)).err(),
        Some(CommandError::GrowCoversBelt),
        "a third Fault widens the box west onto (9,11), the Out belt's first tile: refused"
    );
    assert_eq!(session.edit_log().len(), log_len, "nothing logged");
    assert_eq!(
        postcard::to_allocvec(&session.core().state).expect("state serializes"),
        before,
        "the refusal changes no byte of GridState"
    );
    assert_eq!(session.core().state.link_target((m, 0)), Some((belt, 0)), "the Out still feeds its belt");
}
