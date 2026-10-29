//! WR-03 (74.1-REVIEW, round 2): A ROUTER WITH A BELT ON ITS FIRST OUTPUT REFUSES TO TURN,
//! AND SAYS WHY.
//!
//! # The design decision, verbatim
//! On review WR-03, 2026-10-04, offered "refuse" or "let the turn release the belt and
//! re-dock it on undo", the chosen behavior is "Refuse, say why". So a Rotate whose
//! turned box would cover a belt stays REFUSED, nothing is deleted and nothing moves, and the refusal names
//! the belt: `CommandError::RotateCoversBelt`, read as `Turning would cover a belt. Move
//! that belt first.`. A turned box whose first occupied cell is a MACHINE is
//! `RotateBlocked` (`FootprintCollision` until plan 88-02).
//!
//! # Why catalog port 1 is the case
//! Plan 74.1-14 moved the Router's first Out to the middle row of its 2x3 box ("Edits keep
//! middle layout"). A Rotate keeps the anchor, so the turned 3x2 box covers that Out's
//! doorstep, the cell where any belt docked to it starts. Before this plan the refusal was
//! the generic `FootprintCollision`, and `rotate_undo_redock.rs` moved its boards to catalog
//! port 2 so its severing Rotates would still turn; no test pinned the port-1 case either
//! way. This file pins it, in both directions, with a port-2 control that still turns.
//!
//! # The board (74.1-REVIEW WR-03's failure scenario)
//! A Router at (10,10); a feeder belt whose Head docks the In (catalog 0, (10,11) facing W,
//! doorstep (9,11)); a belt (12,11)->(13,11) whose Tail docks catalog port 1 ((11,11)
//! facing E, doorstep (12,11)). Turned either way the box is x 10..12, y 10..11, walked
//! row-major by `cells_of_footprint`: (10,10) (11,10) (12,10) (10,11) (11,11) (12,11). The
//! first cell owned by another node is (12,11), the belt's first tile.
//!
//! # Why the tag is compared by name
//! The pins compare `format!("{err:?}")` with the variant's name, the spelling
//! `belt_join_golden.rs` records verdicts in. That lets the file compile at the start
//! revision, so its red there is an assertion naming `FootprintCollision`, not a missing
//! variant.
//!
//! Run target: `cargo test -p fabrico-command --test router_rotate_refusal`.

use fabrico_command::{CommandError, GridSession};
use fabrico_core::ids::{NodeId, PortId};
use fabrico_protocol::{BeltEnd, GridCommand, machine_kind};

const SEED: u64 = 0x0074_0118_7074_0000;

/// The Router's anchor on every board here.
const ROUTER_AT: (i32, i32) = (10, 10);

/// Catalog port 0, the Router's In: (10,11) facing W.
const IN_PORT: u16 = 0;
/// Catalog port 1, the Router's FIRST Out, on the middle row: (11,11) facing E.
const FIRST_OUT: u16 = 1;
/// Catalog port 2, the Router's second Out, on the bottom row: (11,12) facing E.
const SECOND_OUT: u16 = 2;

/// One Router board: the session, the Router's id and handle, and the Out belt's id.
struct Board {
    s: GridSession,
    router: NodeId,
    handle: u64,
    out_belt: NodeId,
}

/// The id and handle of the node the last apply minted.
fn minted(s: &GridSession) -> (NodeId, u64) {
    let id = *s.core().last_tick.placed.last().expect("the apply minted a node");
    (id, s.view().handle_of(id).expect("the minted node has a handle"))
}

/// The WR-03 board, with the Out belt docked on catalog port `out_port` (1 or 2).
fn board(out_port: u16) -> Board {
    let mut s = GridSession::new(SEED);
    s.apply(GridCommand::Place { kind: machine_kind::ROUTER, cell_x: ROUTER_AT.0, cell_y: ROUTER_AT.1 })
        .expect("a Router places on a free 2x3");
    let (router, handle) = minted(&s);
    // The feeder: its Head on the In's doorstep (9,11).
    s.apply(GridCommand::DrawBelt { cells: vec![(7, 11), (8, 11), (9, 11)] }).expect("the feeder draws");
    let (_, feeder) = minted(&s);
    s.apply(GridCommand::Dock { belt: feeder, endpoint: BeltEnd::Head, node: handle, port: IN_PORT })
        .expect("the feeder's Head docks the In");
    // The Out belt: its Tail on the named Out's doorstep, row 11 for port 1, row 12 for 2.
    let row = if out_port == FIRST_OUT { 11 } else { 12 };
    s.apply(GridCommand::DrawBelt { cells: vec![(12, row), (13, row)] }).expect("the Out belt draws");
    let (out_belt, out_h) = minted(&s);
    s.apply(GridCommand::Dock { belt: out_h, endpoint: BeltEnd::Tail, node: handle, port: out_port })
        .expect("the Out belt's Tail docks the Out");
    let b = Board { s, router, handle, out_belt };
    assert_eq!(links(&b.s).len(), 2, "MEASURED: the board carries its two docks");
    b
}

/// The serialized `GridState` (see `dock_occupancy.rs` for why the state and not the core).
fn state_bytes(s: &GridSession) -> Vec<u8> {
    postcard::to_allocvec(&s.core().state).expect("GridState serializes")
}

/// The serialized edit log.
fn log_bytes(s: &GridSession) -> Vec<u8> {
    postcard::to_allocvec(s.edit_log()).expect("the edit log serializes")
}

/// The link set, in `BTreeMap` order.
fn links(s: &GridSession) -> Vec<((NodeId, PortId), (NodeId, PortId))> {
    s.core().state.links_iter().collect()
}

/// Every live node id, ascending.
fn nodes(s: &GridSession) -> Vec<NodeId> {
    s.core().state.node_ids().collect()
}

/// The node owning `cell`, or `None`.
fn owner(s: &GridSession, cell: (i32, i32)) -> Option<NodeId> {
    s.core().state.occupied(cell)
}

/// Apply a Rotate that must be refused, assert it touched nothing, and return the refusal's
/// variant name.
fn refused_rotate(b: &mut Board, ccw: bool) -> String {
    let (state, log, ns, ls) = (state_bytes(&b.s), log_bytes(&b.s), nodes(&b.s), links(&b.s));
    let dir = if ccw { "ccw" } else { "cw" };
    let err = b
        .s
        .apply(GridCommand::Rotate { node: b.handle, ccw })
        .err()
        .unwrap_or_else(|| panic!("{dir}: the Rotate was ACCEPTED; this pin needs a refusal"));
    assert_eq!(nodes(&b.s), ns, "{dir}: no node disappears");
    assert_eq!(links(&b.s), ls, "{dir}: no link disappears");
    assert_eq!(state_bytes(&b.s), state, "{dir}: state byte-identical");
    assert_eq!(log_bytes(&b.s), log, "{dir}: nothing appended to the edit log");
    format!("{err:?}")
}

/// **THE CHOSEN BEHAVIOR.** A Router with a belt on its first output (catalog port 1)
/// cannot turn either way, deletes nothing, and the refusal is `RotateCoversBelt`.
///
/// RED AT THE START REVISION on the tag: both directions refused as `FootprintCollision`.
#[test]
fn turning_a_router_onto_the_belt_on_its_first_output_is_refused_both_ways() {
    for ccw in [false, true] {
        let mut b = board(FIRST_OUT);
        // MEASURED: the turned box's first foreign cell is the Out belt's first tile, and
        // no cell of the walk before it is foreign.
        assert_eq!(owner(&b.s, (12, 11)), Some(b.out_belt), "the Out belt starts on (12,11)");
        for c in [(10, 10), (11, 10), (12, 10), (10, 11), (11, 11)] {
            assert!(
                owner(&b.s, c).is_none_or(|o| o == b.router),
                "{c:?} is the Router's own or free, so (12,11) is the first foreign cell"
            );
        }
        assert_eq!(
            refused_rotate(&mut b, ccw),
            "RotateCoversBelt",
            "ccw={ccw}: the turn would cover the belt on the first output, and says so"
        );
    }
}

/// THE CONTROL. The same Router with its belt on catalog port 2 (the bottom row, outside
/// the turned box) turns.
#[test]
fn a_router_whose_belt_is_on_port_two_still_turns() {
    let mut b = board(SECOND_OUT);
    assert_eq!(owner(&b.s, (12, 12)), Some(b.out_belt), "the Out belt starts on (12,12)");
    b.s.apply(GridCommand::Rotate { node: b.handle, ccw: false })
        .expect("a Router whose belt sits outside the turned box turns");
    assert_eq!(
        b.s.core().state.footprint_of(b.router).map(|f| f.rot),
        Some(1),
        "the Router turned once clockwise"
    );
}

/// A MACHINE first in the walk is `RotateBlocked` (`FootprintCollision` until plan 88-02): a
/// Source on (12,10), which the
/// walk meets before the belt on (12,11). Both are in the turned box, so this also pins
/// that the FIRST occupied cell decides the tag, in the host's walk order.
#[test]
fn a_machine_in_the_way_keeps_the_space_taken_refusal() {
    for ccw in [false, true] {
        let mut b = board(FIRST_OUT);
        b.s.apply(GridCommand::Place { kind: machine_kind::SOURCE, cell_x: 12, cell_y: 10 })
            .expect("a Source places on (12,10)");
        let (source, _) = minted(&b.s);
        assert_eq!(owner(&b.s, (12, 10)), Some(source), "MEASURED: the Source sits on (12,10)");
        assert_eq!(owner(&b.s, (12, 11)), Some(b.out_belt), "and the belt still starts on (12,11)");
        assert_eq!(
            refused_rotate(&mut b, ccw),
            format!("{:?}", CommandError::RotateBlocked),
            "ccw={ccw}: a machine met first in the walk is RotateBlocked (the space-taken refusal until plan 88-02)"
        );
    }
}
