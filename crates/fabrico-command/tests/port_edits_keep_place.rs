//! CORNER-06, UNDO-05, UNDO-06 (phase 74.1, plan 74.1-16): no port edit moves an existing
//! port, and one Ctrl+Z puts either edit back exactly.
//!
//! # The ruling these pins hold
//! In manual testing, removing the first of two outputs on a fresh Factory let BOTH belts
//! go, because plan 74.1-12 re-seated the surviving output into the freed row and released
//! its belt. The rule was reversed on 2026-10-04: deleting an output does not shuffle the
//! positions of the others, and automatic arrangement of inputs and outputs is left for
//! later work. Adding may still place the new port automatically. The stated assumption
//! that goes with it: a removal never shrinks the machine.
//!
//! # The turned-machine defect pinned beside it (74.1-REVIEW WR-01)
//! A port add grew the box with its anchor fixed, and `port_world` maps local y to world x
//! as `h - 1 - y` at rot 1 and to world y the same way at rot 2. So on a Factory turned 90
//! or 180 degrees, a fourth output moved the input and every output one cell and released
//! their belts (links 5 to 1 in the review's reproduction). The rule these pins hold: a
//! box grows only on its rot-0 east or south edge, wherever the turn has put that edge, so
//! the anchor shifts by the growth and no In ever moves, an Out moves only when the box
//! widens, and a Fault only when it grows taller.
//!
//! # How the pins read the board
//! Every pin drives `GridSession::apply`, the path a user's edit takes, and reads
//! `ports_of`, `footprint_of`, `cell_of`, the link set and `core().last_tick.unlinked`.
//! Every touch is read through ONE helper, [`touches`], which places each docked port with
//! `port_world` and `unit_delta` and each belt end with `belt_end_world`. Each rotation
//! loop first asserts the board's measured cells against the literal table
//! [`MEASURED`], so a pin cannot pass on a board that is not the one it describes, and
//! every for-all over a dock set first asserts the set is the measured size.
//!
//! Run target: `cargo test -p fabrico-command --test port_edits_keep_place`.

use fabrico_command::{CommandError, GridSession};
use fabrico_core::edit::BeltEnd as CoreEnd;
use fabrico_core::event::{Event, EventPayload, SCHEMA_VERSION};
use fabrico_core::fault::FAULT_PORT;
use fabrico_core::ids::{Item, NodeId, PortId};
use fabrico_core::state::{
    Footprint, Node, Port, Role, Side, belt_end_world, port_world, unit_delta,
};
use fabrico_protocol::{BeltEnd, GridCommand, MachineConfig, machine_kind, port_medium, port_role};

const SEED: u64 = 0xFAB_7416;

/// Every Factory here is placed with its anchor at (20,20) on its own fresh session.
const ANCHOR: (i32, i32) = (20, 20);

/// A world cell.
type Cell = (i32, i32);

/// One rotation's measured cells: `(In, [Outs], Fault)`.
type Measured = (Cell, [Cell; 3], Cell);

/// The world cells of a 3x3 Factory at [`ANCHOR`] turned `rot` clockwise quarter turns,
/// MEASURED through `port_world` and written out by hand: `(In, [Out on row 1, Out on
/// row 2, Out on row 0], Fault)`. The Outs are listed in the order `+ Add output` fills
/// them (the catalog's middle row, then below, then above).
const MEASURED: [Measured; 4] = [
    // rot 0: In faces W, Outs face E, Fault faces S.
    ((20, 21), [(22, 21), (22, 22), (22, 20)], (21, 22)),
    // rot 1: In faces N, Outs face S, Fault faces W.
    ((21, 20), [(21, 22), (20, 22), (22, 22)], (20, 21)),
    // rot 2: In faces E, Outs face W, Fault faces N.
    ((22, 21), [(20, 21), (20, 20), (20, 22)], (21, 20)),
    // rot 3: In faces S, Outs face N, Fault faces E.
    ((21, 22), [(21, 20), (22, 20), (20, 20)], (22, 21)),
];

/// One Factory on its own session.
struct Board {
    s: GridSession,
    m: NodeId,
    h: u64,
    rot: u8,
}

/// A Factory placed at [`ANCHOR`], turned `rot` clockwise quarter turns while undocked,
/// with `outs` outputs in all (the catalog's one plus `outs - 1` `+ Add output`s).
fn factory(rot: u8, outs: usize) -> Board {
    let mut s = GridSession::new(SEED);
    s.apply(GridCommand::Place { kind: machine_kind::FACTORY, cell_x: ANCHOR.0, cell_y: ANCHOR.1 })
        .expect("place the factory on clear floor");
    let m = *s.core().last_tick.placed.last().expect("the factory was minted");
    let h = s.view().handle_of(m).expect("the factory got a handle");
    for _ in 0..rot {
        s.apply(GridCommand::Rotate { node: h, ccw: false }).expect("turn the undocked factory");
    }
    let mut b = Board { s, m, h, rot };
    for _ in 1..outs {
        add_out(&mut b).expect("an add on a clear patch is accepted");
    }
    b
}

/// One `+ Add output`, the panel's gesture.
fn add_out(b: &mut Board) -> Result<(), CommandError> {
    b.s.apply(GridCommand::AddPort {
        node: b.h,
        role: port_role::OUT,
        side: Side::E as u8,
        medium: port_medium::MECHANICAL,
    })
    .map(|_| ())
}

/// The live rot-0 port list.
fn ports(b: &Board) -> Vec<Port> {
    b.s.core().state.ports_of(b.m).expect("the factory declares ports").to_vec()
}

/// The live footprint (absent is the `1x1 rot0` convention).
fn footprint(b: &Board) -> Footprint {
    b.s.core().state.footprint_of(b.m).unwrap_or(Footprint { w: 1, h: 1, rot: 0 })
}

/// The live anchor.
fn anchor(b: &Board) -> (i32, i32) {
    b.s.core().state.cell_of(b.m).expect("the factory has a cell")
}

/// A port's world cell and world side on the live board.
fn world(b: &Board, p: &Port) -> ((i32, i32), Side) {
    let fp = footprint(b);
    port_world(anchor(b), fp.w, fp.h, fp.rot, p)
}

/// The cell a port faces on the live board.
fn facing(b: &Board, p: &Port) -> (i32, i32) {
    let (c, side) = world(b, p);
    let (dx, dy) = unit_delta(side);
    (c.0 + dx, c.1 + dy)
}

/// The catalog index of the `k`-th Out in list order.
fn out_index(b: &Board, k: usize) -> u16 {
    let ps = ports(b);
    let i = ps
        .iter()
        .enumerate()
        .filter(|(_, p)| p.role == Role::Out)
        .nth(k)
        .map(|(i, _)| i)
        .expect("the factory has that many outputs");
    u16::try_from(i).expect("a catalog index fits")
}

/// The catalog index of the first port of `role`.
fn first_index(b: &Board, role: Role) -> u16 {
    let i = ports(b).iter().position(|p| p.role == role).expect("the factory has that role");
    u16::try_from(i).expect("a catalog index fits")
}

/// The world cell of every port, in list order, by role.
fn world_cells(b: &Board) -> Vec<(Role, (i32, i32))> {
    ports(b).iter().map(|p| (p.role, world(b, p).0)).collect()
}

/// The world cells of every port of `role`, in list order.
fn role_cells(b: &Board, role: Role) -> Vec<(i32, i32)> {
    ports(b).iter().filter(|p| p.role == role).map(|p| world(b, p).0).collect()
}

/// The most recently minted node and its handle.
fn last_minted(b: &Board) -> (NodeId, u64) {
    let id = *b.s.core().last_tick.placed.last().expect("a node was minted");
    (id, b.s.view().handle_of(id).expect("the node got a handle"))
}

/// Draw a two-tile belt leaving catalog port `idx` outward from its facing cell and dock
/// its Tail there (an Out or a Fault offloads onto it). Returns the belt id.
fn offload(b: &mut Board, idx: u16) -> NodeId {
    let p = ports(b)[usize::from(idx)];
    let f = facing(b, &p);
    let (dx, dy) = unit_delta(world(b, &p).1);
    b.s.apply(GridCommand::DrawBelt { cells: vec![f, (f.0 + dx, f.1 + dy)] })
        .expect("the offload path is clear");
    let (belt, bh) = last_minted(b);
    b.s.apply(GridCommand::Dock { belt: bh, endpoint: BeltEnd::Tail, node: b.h, port: idx })
        .expect("a Tail on the port's facing cell docks");
    belt
}

/// Draw a two-tile belt arriving at catalog port `idx`'s facing cell from outside and dock
/// its Head there (the In loads from it). Returns the belt id.
fn feed(b: &mut Board, idx: u16) -> NodeId {
    let p = ports(b)[usize::from(idx)];
    let f = facing(b, &p);
    let (dx, dy) = unit_delta(world(b, &p).1);
    b.s.apply(GridCommand::DrawBelt { cells: vec![(f.0 + dx, f.1 + dy), f] })
        .expect("the feed path is clear");
    let (belt, bh) = last_minted(b);
    b.s.apply(GridCommand::Dock { belt: bh, endpoint: BeltEnd::Head, node: b.h, port: idx })
        .expect("a Head on the port's facing cell docks");
    belt
}

/// One belt dock naming the factory, as a hand sees it.
#[derive(Debug)]
struct Touch {
    belt: NodeId,
    key: PortId,
    facing: (i32, i32),
    end: (i32, i32),
}

/// THE ONE TOUCH READER: every belt dock naming the factory, its link key resolved in its
/// own keyspace (`FAULT_PORT` the first Fault, a Tail key the n-th Out, a Head key the
/// catalog index), the port's facing cell from `port_world` and `unit_delta`, the belt's
/// end tile from `belt_end_world`.
fn touches(b: &Board) -> Vec<Touch> {
    let state = &b.s.core().state;
    let ps = ports(b);
    let mut out = Vec::new();
    for (from, to) in state.links_iter() {
        let (belt, key, end) = if to.0 == b.m && matches!(state.node(from.0), Some(Node::Belt(_))) {
            (from.0, to.1, CoreEnd::Head)
        } else if from.0 == b.m && matches!(state.node(to.0), Some(Node::Belt(_))) {
            (to.0, from.1, CoreEnd::Tail)
        } else {
            continue;
        };
        let port = if key == FAULT_PORT {
            ps.iter().find(|p| p.role == Role::Fault)
        } else if end == CoreEnd::Head {
            ps.get(usize::from(key))
        } else {
            ps.iter().filter(|p| p.role == Role::Out).nth(usize::from(key))
        }
        .unwrap_or_else(|| panic!("the {end:?} key {key} names a port on the factory"));
        let Some(Node::Belt(belt_node)) = state.node(belt) else { unreachable!() };
        let (end_cell, _) = belt_end_world(&belt_node.geometry, end).expect("a drawn belt has ends");
        out.push(Touch { belt, key, facing: facing(b, port), end: end_cell });
    }
    out
}

/// Every dock touches its port, and there are exactly `n` of them (asserted first, so an
/// emptied set cannot pass the for-all).
fn assert_every_dock_touches(b: &Board, n: usize, ctx: &str) {
    let t = touches(b);
    assert_eq!(t.len(), n, "{ctx}: {n} docks name the factory");
    for x in &t {
        assert_eq!(x.facing, x.end, "{ctx}: the dock on key {} (belt {:?}) touches its port", x.key, x.belt);
    }
}

/// The serialized links map.
fn link_bytes(b: &Board) -> Vec<u8> {
    let links: Vec<((NodeId, PortId), (NodeId, PortId))> = b.s.core().state.links_iter().collect();
    postcard::to_allocvec(&links).expect("serialize the links map")
}

/// The serialized grid state.
fn state_bytes(b: &Board) -> Vec<u8> {
    postcard::to_allocvec(&b.s.core().state).expect("GridState serializes")
}

/// The belts the last fold released.
fn released(b: &Board) -> Vec<NodeId> {
    b.s.core().last_tick.unlinked.iter().map(|u| u.belt).collect()
}

/// Assert the board is the measured one: In, the first `outs` Outs and the Fault on the
/// cells [`MEASURED`] gives for this rotation, in a 3x3 box at [`ANCHOR`].
fn assert_measured(b: &Board, outs: usize) {
    let (in_cell, out_cells, fault_cell) = MEASURED[usize::from(b.rot)];
    assert_eq!(anchor(b), ANCHOR, "rot {}: the anchor is where it was placed", b.rot);
    assert_eq!(footprint(b), Footprint { w: 3, h: 3, rot: b.rot }, "rot {}: the catalog box", b.rot);
    assert_eq!(role_cells(b, Role::In), vec![in_cell], "rot {}: the In's measured cell", b.rot);
    assert_eq!(role_cells(b, Role::Out), out_cells[..outs].to_vec(), "rot {}: the Outs' measured cells", b.rot);
    assert_eq!(role_cells(b, Role::Fault), vec![fault_cell], "rot {}: the Fault's measured cell", b.rot);
}

/// **N5, the headline.** Remove the first of two outputs on a Factory with a belt on
/// each: exactly the removed output's belt lets go, the other output keeps its world cell
/// and its belt stays docked, re-keyed from 1 to 0, touching. Footprint and anchor do not
/// move. At every rotation.
///
/// RED AT THE START REVISION: 74.1-12's re-seat moves the second output into the first's
/// row (row 2 to row 1) and releases both belts.
#[test]
fn removing_the_first_of_two_outputs_moves_nothing_and_releases_only_its_belt() {
    for rot in 0..4u8 {
        let mut b = factory(rot, 2);
        assert_measured(&b, 2);
        let on_removed = { let i = out_index(&b, 0); offload(&mut b, i) };
        let survivor = { let i = out_index(&b, 1); offload(&mut b, i) };
        assert_eq!(b.s.core().state.link_target((b.m, 0)), Some((on_removed, 0)), "rot {rot}: key 0 is the first belt");
        assert_eq!(b.s.core().state.link_target((b.m, 1)), Some((survivor, 0)), "rot {rot}: key 1 is the second belt");
        assert_every_dock_touches(&b, 2, &format!("rot {rot} before"));
        let (fp, at) = (footprint(&b), anchor(&b));
        let (in_cell, out_cells, fault_cell) = MEASURED[usize::from(rot)];

        { let i = out_index(&b, 0); b.s.apply(GridCommand::RemovePort { node: b.h, index: i }) }
            .expect("removing the docked first output is accepted");

        assert_eq!(released(&b), vec![on_removed], "rot {rot}: exactly the removed output's belt lets go");
        assert_eq!(b.s.core().state.link_target((b.m, 0)), Some((survivor, 0)), "rot {rot}: the survivor is re-keyed 1 -> 0");
        assert_eq!(b.s.core().state.link_target((b.m, 1)), None, "rot {rot}: nothing is left on key 1");
        assert_eq!(footprint(&b), fp, "rot {rot}: the box does not move");
        assert_eq!(anchor(&b), at, "rot {rot}: the anchor does not move");
        assert_eq!(role_cells(&b, Role::Out), vec![out_cells[1]], "rot {rot}: the second output keeps its cell");
        assert_eq!(role_cells(&b, Role::In), vec![in_cell], "rot {rot}: the In keeps its cell");
        assert_eq!(role_cells(&b, Role::Fault), vec![fault_cell], "rot {rot}: the Fault keeps its cell");
        assert_every_dock_touches(&b, 1, &format!("rot {rot} after the removal"));
    }
}

/// One Ctrl+Z after that removal: the output is back at its index ON ITS OWN CELL, its
/// belt is docked and touching, and the other belt never changed. The port list, the box,
/// the anchor and the links map are byte for byte what they were.
#[test]
fn one_undo_puts_the_removed_output_back_on_its_own_cell_with_its_belt() {
    for rot in 0..4u8 {
        let mut b = factory(rot, 2);
        assert_measured(&b, 2);
        let _ = { let i = out_index(&b, 0); offload(&mut b, i) };
        let _ = { let i = out_index(&b, 1); offload(&mut b, i) };
        let (ps, fp, at, links) = (ports(&b), footprint(&b), anchor(&b), link_bytes(&b));
        let cells = world_cells(&b);

        { let i = out_index(&b, 0); b.s.apply(GridCommand::RemovePort { node: b.h, index: i }) }
            .expect("remove the first output");
        b.s.apply(GridCommand::Undo).expect("ONE Undo");

        assert_eq!(ports(&b), ps, "rot {rot}: every port back at its index and slot");
        assert_eq!(world_cells(&b), cells, "rot {rot}: every port back on its own world cell");
        assert_eq!(footprint(&b), fp, "rot {rot}: the box");
        assert_eq!(anchor(&b), at, "rot {rot}: the anchor");
        assert_eq!(link_bytes(&b), links, "rot {rot}: the links map, byte for byte");
        assert_every_dock_touches(&b, 2, &format!("rot {rot} after the undo"));
    }
}

/// Two removals then two undos: both outputs come back on their OWN cells. The guard
/// against an undo that re-seats by first free slot: after both removals the free rows
/// are 1 and 2, and the first undo must put its output back on row 2, its own, where the
/// first free slot is row 1.
///
/// RED AT THE START REVISION, MEASURED, AT THE MIDDLE STEP ONLY: after both removals the
/// old re-seat has moved the row-0 output into row 1. Its FINAL assertions are green there
/// by design, because the old re-seat restores the catalog rows from list order, a fixed
/// point of the catalog; this pin is kept for the wrong rule it alone can tell apart, an
/// undo that seats by first free slot.
#[test]
fn two_removals_undone_put_both_outputs_back_on_their_own_cells() {
    for rot in 0..4u8 {
        let mut b = factory(rot, 3);
        assert_measured(&b, 3);
        for k in 0..3 {
            let _ = { let i = out_index(&b, k); offload(&mut b, i) };
        }
        assert_every_dock_touches(&b, 3, &format!("rot {rot} before"));
        let (ps, fp, at, links) = (ports(&b), footprint(&b), anchor(&b), link_bytes(&b));
        let cells = world_cells(&b);
        let (_, out_cells, _) = MEASURED[usize::from(rot)];

        // Remove the Out on row 1, then the one on row 2 (now the first in list order).
        { let i = out_index(&b, 0); b.s.apply(GridCommand::RemovePort { node: b.h, index: i }) }.expect("first removal");
        { let i = out_index(&b, 0); b.s.apply(GridCommand::RemovePort { node: b.h, index: i }) }.expect("second removal");
        assert_eq!(role_cells(&b, Role::Out), vec![out_cells[2]], "rot {rot}: only the row-0 output is left, on its cell");

        b.s.apply(GridCommand::Undo).expect("first Undo");
        assert_eq!(
            role_cells(&b, Role::Out),
            vec![out_cells[1], out_cells[2]],
            "rot {rot}: the first undo puts the row-2 output back on row 2, its own, not the free row 1"
        );
        b.s.apply(GridCommand::Undo).expect("second Undo");

        assert_eq!(ports(&b), ps, "rot {rot}: both outputs back at their index and slot");
        assert_eq!(world_cells(&b), cells, "rot {rot}: every port on its own world cell");
        assert_eq!(footprint(&b), fp, "rot {rot}: the box");
        assert_eq!(anchor(&b), at, "rot {rot}: the anchor");
        assert_eq!(link_bytes(&b), links, "rot {rot}: the links map, byte for byte");
        assert_every_dock_touches(&b, 3, &format!("rot {rot} after both undos"));
    }
}

/// The turned board of the growing-add pins: three outputs (a full 3x3 column), a belt
/// feeding the In and a belt leaving each Out. Returns the board with 4 docks.
fn grown_board(rot: u8) -> Board {
    let mut b = factory(rot, 3);
    assert_measured(&b, 3);
    let _ = { let i = first_index(&b, Role::In); feed(&mut b, i) };
    for k in 0..3 {
        let _ = { let i = out_index(&b, k); offload(&mut b, i) };
    }
    assert_every_dock_touches(&b, 4, &format!("rot {rot} before the growing add"));
    b
}

/// The anchor a 3x3 Factory at [`ANCHOR`] takes when one more output grows it to 3x4,
/// by rotation: the box grows on its rot-0 south edge, which a turn puts at world S, W, N
/// and E in turn, so the anchor shifts by `(0, 0)`, `(-1, 0)`, `(0, -1)`, `(0, 0)`.
const GROWN_ANCHOR: [(i32, i32); 4] = [(20, 20), (19, 20), (20, 19), (20, 20)];

/// **WR-01.** A fourth output on a turned Factory with its In and Outs docked and no fault
/// belt: accepted, releases nothing, every In and Out world cell unchanged, and the Fault
/// nub one cell further from the machine. At every rotation.
///
/// RED AT THE START REVISION at rot 1 and rot 2: the box grows with its anchor fixed, so
/// the In and every Out shift one cell and their four belts are released.
#[test]
fn adding_an_output_moves_no_input_or_output_at_any_rotation() {
    for rot in 0..4u8 {
        let mut b = grown_board(rot);
        let (in_cell, out_cells, fault_cell) = MEASURED[usize::from(rot)];
        let links = link_bytes(&b);
        let fault_side = world(&b, &ports(&b)[usize::from(first_index(&b, Role::Fault))]).1;

        add_out(&mut b).expect("the growing add is accepted: no belt sits where the box grows");

        assert!(released(&b).is_empty(), "rot {rot}: the add releases nothing, got {:?}", released(&b));
        assert_eq!(footprint(&b), Footprint { w: 3, h: 4, rot }, "rot {rot}: the box grew one row");
        assert_eq!(anchor(&b), GROWN_ANCHOR[usize::from(rot)], "rot {rot}: the anchor shifts by the growth");
        assert_eq!(role_cells(&b, Role::In), vec![in_cell], "rot {rot}: the In did not move");
        assert_eq!(&role_cells(&b, Role::Out)[..3], &out_cells[..], "rot {rot}: no existing Out moved");
        let (dx, dy) = unit_delta(fault_side);
        assert_eq!(
            role_cells(&b, Role::Fault),
            vec![(fault_cell.0 + dx, fault_cell.1 + dy)],
            "rot {rot}: the Fault moved one cell away from the machine, and only it"
        );
        assert_eq!(link_bytes(&b), links, "rot {rot}: every link kept, byte for byte");
        assert_every_dock_touches(&b, 4, &format!("rot {rot} after the growing add"));
    }
}

/// The same growing add with a FAULT belt docked: the grown box would cover the Fault's
/// facing cell, which the fault belt's end tile occupies, so the add is refused at every
/// rotation and nothing moves: state and edit log byte-identical.
///
/// RED AT THE START REVISION at rot 1 and rot 2: the box grows away from the fault belt
/// there, so the add is accepted and releases the In and Out belts.
///
/// NAMED CHANGE (plan 74.1-18): the refusal was `FootprintCollision` ("That space is
/// taken."); it is now `GrowCoversBelt` ("Growing would cover a belt. Move that belt
/// first."), because the first cell the grown box meets is the fault belt's tile. Which
/// adds are refused did not change.
#[test]
fn a_growing_add_over_a_fault_belt_is_refused_at_every_rotation() {
    for rot in 0..4u8 {
        let mut b = grown_board(rot);
        let _ = { let i = first_index(&b, Role::Fault); offload(&mut b, i) };
        assert_every_dock_touches(&b, 5, &format!("rot {rot} with the fault belt"));
        let state = state_bytes(&b);
        let log = postcard::to_allocvec(b.s.edit_log()).expect("serialize the edit log");

        assert_eq!(
            add_out(&mut b),
            Err(CommandError::GrowCoversBelt),
            "rot {rot}: a box that would grow over the fault belt is refused, in belt words"
        );
        assert_eq!(state_bytes(&b), state, "rot {rot}: state byte-identical");
        assert_eq!(
            postcard::to_allocvec(b.s.edit_log()).expect("serialize the edit log"),
            log,
            "rot {rot}: nothing appended to the edit log"
        );
    }
}

/// Undo of a growing add puts the box, the anchor and every port back exactly, with every
/// belt docked and touching, at every rotation.
#[test]
fn undoing_a_growing_add_restores_the_box_and_the_anchor() {
    for rot in 0..4u8 {
        let mut b = grown_board(rot);
        let (ps, fp, at, links) = (ports(&b), footprint(&b), anchor(&b), link_bytes(&b));
        let cells = world_cells(&b);

        add_out(&mut b).expect("the growing add");
        assert_eq!(footprint(&b).h, 4, "rot {rot}: the add grew the box");
        b.s.apply(GridCommand::Undo).expect("ONE Undo");

        assert_eq!(footprint(&b), fp, "rot {rot}: the box is back to 3x3");
        assert_eq!(anchor(&b), at, "rot {rot}: the anchor is back");
        assert_eq!(ports(&b), ps, "rot {rot}: every port back on its slot");
        assert_eq!(world_cells(&b), cells, "rot {rot}: every port back on its world cell");
        assert_eq!(link_bytes(&b), links, "rot {rot}: the links map, byte for byte");
        assert_every_dock_touches(&b, 4, &format!("rot {rot} after the undo"));
    }
}

/// A removal never shrinks the machine: a Factory grown to 3x4 by a fourth output, with a
/// fault belt docked AFTER the growth, has its fourth output removed and keeps 3x4 and its
/// fault belt, docked and touching.
///
/// RED AT THE START REVISION: the removal shrinks the box to 3x3, the Fault moves back a
/// row and its belt is released.
#[test]
fn a_removal_never_shrinks_the_machine() {
    for rot in 0..4u8 {
        let mut b = factory(rot, 4);
        assert_eq!(footprint(&b), Footprint { w: 3, h: 4, rot }, "rot {rot}: four outputs grew the box");
        let fault_belt = { let i = first_index(&b, Role::Fault); offload(&mut b, i) };
        assert_eq!(b.s.core().state.link_target((b.m, FAULT_PORT)), Some((fault_belt, 0)), "rot {rot}: the fault belt");
        let (fp, at, cells) = (footprint(&b), anchor(&b), world_cells(&b));

        { let i = out_index(&b, 3); b.s.apply(GridCommand::RemovePort { node: b.h, index: i }) }
            .expect("remove the fourth output");

        assert!(released(&b).is_empty(), "rot {rot}: nothing lets go, got {:?}", released(&b));
        assert_eq!(footprint(&b), fp, "rot {rot}: the machine keeps its 3x4 box");
        assert_eq!(anchor(&b), at, "rot {rot}: and its anchor");
        let mut kept = cells.clone();
        kept.remove(usize::from(list_position_of_out(&cells, 3)));
        assert_eq!(world_cells(&b), kept, "rot {rot}: every other port keeps its world cell");
        assert_eq!(b.s.core().state.link_target((b.m, FAULT_PORT)), Some((fault_belt, 0)), "rot {rot}: the fault belt stays docked");
        assert_every_dock_touches(&b, 1, &format!("rot {rot} after the removal"));
    }
}

/// The list position of the `k`-th Out in a `(role, cell)` list.
fn list_position_of_out(cells: &[(Role, (i32, i32))], k: usize) -> u16 {
    let i = cells
        .iter()
        .enumerate()
        .filter(|(_, (r, _))| *r == Role::Out)
        .nth(k)
        .map(|(i, _)| i)
        .expect("that many outputs");
    u16::try_from(i).expect("fits")
}

/// After removing the middle-row output of three, the next `+ Add output` takes the
/// middle row (the first free slot in the centre-out order) and nothing else moves: box,
/// anchor, every other port and both belts.
///
/// RED AT THE START REVISION: the removal re-seats the other two outputs (row 2 to row 1,
/// row 0 to row 2) and releases both belts.
#[test]
fn after_a_removal_the_next_add_fills_the_free_row() {
    for rot in 0..4u8 {
        let mut b = factory(rot, 3);
        assert_measured(&b, 3);
        let (_, out_cells, _) = MEASURED[usize::from(rot)];
        // Belts on the row-2 and row-0 outputs; the middle-row output carries none.
        let _ = { let i = out_index(&b, 1); offload(&mut b, i) };
        let _ = { let i = out_index(&b, 2); offload(&mut b, i) };
        let (fp, at, links_before) = (footprint(&b), anchor(&b), touches(&b).len());
        assert_eq!(links_before, 2, "rot {rot}: two belts");

        { let i = out_index(&b, 0); b.s.apply(GridCommand::RemovePort { node: b.h, index: i }) }
            .expect("remove the middle-row output");
        assert!(released(&b).is_empty(), "rot {rot}: the removed output carried no belt, so nothing lets go");
        assert_eq!(role_cells(&b, Role::Out), vec![out_cells[1], out_cells[2]], "rot {rot}: the other two did not move");

        add_out(&mut b).expect("the next add");
        assert!(released(&b).is_empty(), "rot {rot}: the add releases nothing");
        assert_eq!(
            role_cells(&b, Role::Out),
            vec![out_cells[1], out_cells[2], out_cells[0]],
            "rot {rot}: the new output fills the freed middle row, listed last"
        );
        assert_eq!(footprint(&b), fp, "rot {rot}: the box did not move");
        assert_eq!(anchor(&b), at, "rot {rot}: the anchor did not move");
        assert_every_dock_touches(&b, 2, &format!("rot {rot} after the add"));
    }
}

/// UNDO-05 scenario 1 on a command-built Factory: three outputs, belts on routing keys 1
/// and 2, key 0 removed. The two belts are now keys 0 and 1, and an item the factory
/// emits on each key after the removal arrives on the belt that was on that output, read
/// off the belt slots after ticking.
///
/// RED AT THE START REVISION: the removal re-seats both surviving outputs, releases both
/// belts, and the emitted items reach no belt.
#[test]
fn a_surviving_belt_is_rekeyed_and_still_drains_its_own_output() {
    let mut b = factory(0, 3);
    assert_measured(&b, 3);
    let on_key_1 = { let i = out_index(&b, 1); offload(&mut b, i) };
    let on_key_2 = { let i = out_index(&b, 2); offload(&mut b, i) };
    b.s.apply(GridCommand::Configure {
        node: b.h,
        config: MachineConfig::Factory {
            source: "export default function (input, ctx) { ctx.emit(0, 10); ctx.emit(1, 20); }".to_string(),
        },
    })
    .expect("configure the factory");

    { let i = out_index(&b, 0); b.s.apply(GridCommand::RemovePort { node: b.h, index: i }) }
        .expect("remove routing key 0");
    assert!(released(&b).is_empty(), "the removed output carried no belt, so nothing lets go");
    assert_eq!(b.s.core().state.link_target((b.m, 0)), Some((on_key_1, 0)), "key 1's belt is now key 0");
    assert_eq!(b.s.core().state.link_target((b.m, 1)), Some((on_key_2, 0)), "key 2's belt is now key 1");
    assert_every_dock_touches(&b, 2, "after the removal");

    b.s.pump(&[Event {
        schema_version: SCHEMA_VERSION,
        partition: 0,
        sequence: 0,
        tick: 0,
        payload: EventPayload::Input { target: b.m, port: 0, item: Item(b"1".to_vec()) },
    }]);
    b.s.advance(40);

    let items = |id: NodeId| match b.s.core().state.node(id) {
        Some(Node::Belt(belt)) => belt.slots.iter().flatten().cloned().collect::<Vec<Item>>(),
        other => panic!("expected a Belt, got {other:?}"),
    };
    assert_eq!(items(on_key_1), vec![Item(b"10".to_vec())], "the item emitted on key 0 lands on the belt of the output that was key 1");
    assert_eq!(items(on_key_2), vec![Item(b"20".to_vec())], "the item emitted on key 1 lands on the belt of the output that was key 2");
}
