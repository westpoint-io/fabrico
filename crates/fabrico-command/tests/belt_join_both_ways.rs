//! GAP N4 (plan 74.1-15): A BELT-TO-BELT JOIN CONNECTS WHICHEVER BELT IS DRAGGED.
//!
//! # What usability testing rejected
//! A belt run from an output to an input right next to it was reported as an error. On
//! the test board, dragging a side belt's last tile onto a main belt's
//! first tile was refused, while the same physical join made by dragging the main belt's
//! first tile onto the side belt's last tile was accepted. The host rule required the
//! TARGET belt's end to point straight at the dragged end
//! (`target cell + unit_delta(target side) == carrier end cell`), so only the dragged belt
//! was allowed to turn.
//!
//! # What this file pins
//! 1. `dragging_either_belt_makes_the_same_join`: on the dry-run board (main belt
//!    (4,6)->(7,6) east, side belt (4,3)->(4,5) south) both drag directions return `Ok`
//!    and leave identical link sets. RED BEFORE THE FIX: the side-belt direction was
//!    `Err(InvalidDock)`.
//! 2. `the_join_works_at_every_orientation`: the same board through all four quarter
//!    turns about (10,10). RED BEFORE THE FIX.
//! 3. The refusals the new rule KEEPS, each with the state bytes and the edit log length
//!    unchanged after: a carrier two cells away (and, since plan 74.1-24, a diagonal
//!    neighbour), a belt docking onto its own inner tile,
//!    a single-tile target, a Head onto a Head (role), and a U-turn pair in both
//!    directions (the D-02 facing term, kept uniform: a stated assumption that can be
//!    turned around after further usability testing).
//! 4. `a_machine_doorstep_still_needs_the_exact_cell`: a MACHINE target keeps the
//!    doorstep rule; a carrier end next to the port cell but off its doorstep is refused.
//!
//! # Named change (plan 74.1-18, gap N4c)
//! Every belt-target refusal in item 3 was `InvalidDock`, whose sentence ("A belt runs from
//! an output to an input, right next to it.") was judged an error that explains nothing.
//! They became `InvalidBeltJoin`, a belt sentence. The machine-doorstep pin in item 4 stays
//! `InvalidDock`. Which docks are accepted did not change.
//!
//! # Named change (plan 74.1-24, gap J11)
//! The walk failed the one belt sentence, so two causes carry their own tags: the U-turn
//! pair is `BeltJoinTurnsBack` ("A join cannot turn back the way it came.") and the carrier
//! two cells away, with the new diagonal case, `BeltEndsApart` ("These ends do not
//! touch."). The role, single-tile and inner-tile refusals stay `InvalidBeltJoin` ("A belt's
//! end joins only a belt starting right next to it, never turning back."). Only tags moved.
//!
//! Every board is built through `GridSession` commands only, and every cell an
//! assertion depends on is MEASURED from the folded state first (the measured value is
//! written beside the assertion).
//!
//! Run target: `cargo test -p fabrico-command --test belt_join_both_ways`.

use fabrico_command::{CommandError, GridSession};
use fabrico_core::edit::BeltEnd as CoreEnd;
use fabrico_core::ids::NodeId;
use fabrico_core::state::{Node, Role, Side, belt_end_world, port_world, unit_delta};
use fabrico_protocol::{BeltEnd, GridCommand, machine_kind};

const SEED: u64 = 0x0074_0115_B0B0_0000;

/// A belt's Tail port index (`Role::In`, declared first, 74-02).
const TAIL_PORT: u16 = 0;
/// A belt's Head port index (`Role::Out`, declared second, 74-02).
const HEAD_PORT: u16 = 1;

/// The serialized `GridState`, the refusal oracle (see `dock_occupancy.rs` for why it is
/// `GridState` and never the whole `Core`).
fn state_bytes(session: &GridSession) -> Vec<u8> {
    postcard::to_allocvec(&session.core().state).expect("GridState serializes")
}

/// Draw a belt along `cells` (cells[0] is the Tail) and return `(node id, handle)`.
fn draw(session: &mut GridSession, cells: Vec<(i32, i32)>) -> (NodeId, u64) {
    session
        .apply(GridCommand::DrawBelt { cells: cells.clone() })
        .unwrap_or_else(|e| panic!("a clear drawn path {cells:?} is accepted, got {e:?}"));
    let id = *session.core().last_tick.placed.last().expect("the belt was minted");
    let handle = session.view().handle_of(id).expect("the belt got a handle");
    (id, handle)
}

/// Place a machine and return `(node id, handle)`.
fn place(session: &mut GridSession, kind: u8, cell_x: i32, cell_y: i32) -> (NodeId, u64) {
    session
        .apply(GridCommand::Place { kind, cell_x, cell_y })
        .expect("place at a free cell");
    let id = *session.core().last_tick.placed.last().expect("the node was minted");
    let handle = session.view().handle_of(id).expect("the node got a handle");
    (id, handle)
}

/// MEASURE a belt end from the folded state: its cell and its outward side.
fn end_of(session: &GridSession, belt: NodeId, end: CoreEnd) -> ((i32, i32), Option<Side>) {
    let Some(Node::Belt(b)) = session.core().state.node(belt) else {
        panic!("{belt:?} is a belt");
    };
    belt_end_world(&b.geometry, end).expect("a drawn belt has a spatial end")
}

/// The link set, in `BTreeMap` order.
type Links = Vec<((NodeId, u16), (NodeId, u16))>;
fn links(session: &GridSession) -> Links {
    session.core().state.links_iter().collect()
}

/// Assert a Dock is refused with `want` and that it touched nothing: state bytes and the
/// edit log length are identical after.
fn assert_refused(session: &mut GridSession, cmd: GridCommand, want: CommandError, why: &str) {
    let before = state_bytes(session);
    let log_len = session.edit_log().len();
    assert_eq!(session.apply(cmd).err(), Some(want), "{why}");
    assert_eq!(session.edit_log().len(), log_len, "{why}: no record produced");
    assert_eq!(state_bytes(session), before, "{why}: state byte-identical");
}

/// [`assert_refused`] with the refusal compared BY NAME (`format!("{err:?}")`), so a pin
/// naming a tag the build does not have yet still compiles and its red names the tag the
/// build returned (plan 74.1-24's red-first runs, the 74.1-18 discipline).
fn assert_refused_named(session: &mut GridSession, cmd: GridCommand, want: &str, why: &str) {
    let before = state_bytes(session);
    let log_len = session.edit_log().len();
    let got = session.apply(cmd).err().map(|e| format!("{e:?}"));
    assert_eq!(got.as_deref(), Some(want), "{why}");
    assert_eq!(session.edit_log().len(), log_len, "{why}: no record produced");
    assert_eq!(state_bytes(session), before, "{why}: state byte-identical");
}

/// A quarter turn about (10,10), y-down: (x, y) -> (20 - y, x). `k` turns.
fn turn(k: u8, c: (i32, i32)) -> (i32, i32) {
    let mut p = c;
    for _ in 0..k {
        p = (20 - p.1, p.0);
    }
    p
}

/// Turn a side by `k` quarter turns clockwise (the same rotation as [`turn`]).
fn turn_side(k: u8, s: Side) -> Side {
    let mut s = s;
    for _ in 0..k {
        s = match s {
            Side::N => Side::E,
            Side::E => Side::S,
            Side::S => Side::W,
            Side::W => Side::N,
        };
    }
    s
}

/// The dry-run board, turned `k` quarter turns: main belt (4,6)->(7,6) east, side belt
/// (4,3)->(4,5) south. Returns `(session, main id, main handle, side id, side handle)`.
fn n4_board(k: u8) -> (GridSession, NodeId, u64, NodeId, u64) {
    let mut s = GridSession::new(SEED);
    let main = (4..=7).map(|x| turn(k, (x, 6))).collect();
    let side = (3..=5).map(|y| turn(k, (4, y))).collect();
    let (m_id, m_h) = draw(&mut s, main);
    let (s_id, s_h) = draw(&mut s, side);
    (s, m_id, m_h, s_id, s_h)
}

/// Direction 1: the main belt's Tail dragged onto the side belt's Head (accepted at HEAD).
fn main_tail_onto_side_head(m_h: u64, s_h: u64) -> GridCommand {
    GridCommand::Dock { belt: m_h, endpoint: BeltEnd::Tail, node: s_h, port: HEAD_PORT }
}

/// Direction 2: the side belt's Head dragged onto the main belt's Tail (refused at HEAD).
fn side_head_onto_main_tail(s_h: u64, m_h: u64) -> GridCommand {
    GridCommand::Dock { belt: s_h, endpoint: BeltEnd::Head, node: m_h, port: TAIL_PORT }
}

/// **THE HEADLINE.** Both drag directions of the N4 join are accepted and leave the same
/// link: the side belt's Head output feeding the main belt's Tail input.
///
/// RED BEFORE THE FIX: direction 2 returned `Err(InvalidDock)`, because the main belt's Tail
/// outward side is W, so its old "doorstep" was (3,6), not the side belt's Head at (4,5).
#[test]
fn dragging_either_belt_makes_the_same_join() {
    // Direction 1, on its own fresh session.
    let (mut a, am_id, am_h, as_id, as_h) = n4_board(0);
    // Measured: main Tail (4,6) outward W; side Head (4,5) outward S.
    assert_eq!(end_of(&a, am_id, CoreEnd::Tail), ((4, 6), Some(Side::W)));
    assert_eq!(end_of(&a, as_id, CoreEnd::Head), ((4, 5), Some(Side::S)));
    a.apply(main_tail_onto_side_head(am_h, as_h))
        .expect("dragging the main belt's Tail onto the side belt's Head joins");

    // Direction 2, on a second fresh session built by the same commands.
    let (mut b, bm_id, bm_h, bs_id, bs_h) = n4_board(0);
    assert_eq!((bm_id, bs_id), (am_id, as_id), "the same commands mint the same ids");
    assert_eq!(
        b.apply(side_head_onto_main_tail(bs_h, bm_h)).err(),
        None,
        "dragging the side belt's Head onto the main belt's Tail joins too (N4)",
    );

    // The same join: one link, side Head output (side,0) -> main Tail input (main,0).
    assert_eq!(links(&a), vec![((as_id, 0), (am_id, 0))], "direction 1 link");
    assert_eq!(links(&b), links(&a), "both directions leave the identical link set");
}

/// The N4 join at all four orientations: each direction accepted, links identical.
/// RED BEFORE THE FIX (direction 2 refused at every orientation).
#[test]
fn the_join_works_at_every_orientation() {
    for k in 0..4u8 {
        let (mut a, am_id, am_h, as_id, as_h) = n4_board(k);
        // Measured per orientation: the two ends are one step apart and the main Tail's
        // outward side is W turned k times, the side Head's outward is S turned k times.
        let (mt, mt_side) = end_of(&a, am_id, CoreEnd::Tail);
        let (sh, sh_side) = end_of(&a, as_id, CoreEnd::Head);
        assert_eq!(mt, turn(k, (4, 6)), "turn {k}: main Tail cell");
        assert_eq!(sh, turn(k, (4, 5)), "turn {k}: side Head cell");
        assert_eq!(mt_side, Some(turn_side(k, Side::W)), "turn {k}: main Tail outward");
        assert_eq!(sh_side, Some(turn_side(k, Side::S)), "turn {k}: side Head outward");
        a.apply(main_tail_onto_side_head(am_h, as_h))
            .unwrap_or_else(|e| panic!("turn {k}: direction 1 joins, got {e:?}"));

        let (mut b, bm_id, bm_h, _bs_id, bs_h) = n4_board(k);
        assert_eq!(
            b.apply(side_head_onto_main_tail(bs_h, bm_h)).err(),
            None,
            "turn {k}: direction 2 joins",
        );
        assert_eq!(links(&a), vec![((as_id, 0), (am_id, 0))], "turn {k}: one link");
        assert_eq!(links(&b), links(&a), "turn {k}: identical link sets");
        let _ = bm_id;
    }
}

/// The side belt one cell further up: its Head (4,4) is two cells from the main belt's
/// Tail (4,6). Refused in both directions; the one-orthogonal-step term decides.
#[test]
fn a_carrier_two_cells_away_is_refused() {
    let mut s = GridSession::new(SEED);
    let (m_id, m_h) = draw(&mut s, (4..=7).map(|x| (x, 6)).collect());
    let (s_id, s_h) = draw(&mut s, (2..=4).map(|y| (4, y)).collect());
    // Measured: main Tail (4,6), side Head (4,4): manhattan distance 2.
    assert_eq!(end_of(&s, m_id, CoreEnd::Tail).0, (4, 6));
    assert_eq!(end_of(&s, s_id, CoreEnd::Head).0, (4, 4));
    // NAMED CHANGE (plan 74.1-24, gap J11): `InvalidBeltJoin` until this plan; ends that
    // do not touch now carry their own cause, `BeltEndsApart`.
    assert_refused_named(
        &mut s,
        side_head_onto_main_tail(s_h, m_h),
        "BeltEndsApart",
        "a Head two cells from the target Tail",
    );
    assert_refused_named(
        &mut s,
        main_tail_onto_side_head(m_h, s_h),
        "BeltEndsApart",
        "a Tail two cells from the target Head",
    );
}

/// A DIAGONAL neighbour (plan 74.1-24): the side belt's Head (5,5) touches the main belt's
/// Tail (4,6) only at a corner, so the ends are not one orthogonal step apart. Refused in
/// both directions as `BeltEndsApart`, the same clause as two cells away.
#[test]
fn a_diagonal_neighbour_is_refused_as_ends_apart() {
    let mut s = GridSession::new(SEED);
    let (m_id, m_h) = draw(&mut s, (4..=7).map(|x| (x, 6)).collect());
    let (s_id, s_h) = draw(&mut s, (3..=5).map(|y| (5, y)).collect());
    // Measured: main Tail (4,6), side Head (5,5): one cell across and one down.
    assert_eq!(end_of(&s, m_id, CoreEnd::Tail).0, (4, 6));
    assert_eq!(end_of(&s, s_id, CoreEnd::Head).0, (5, 5));
    assert_refused_named(
        &mut s,
        side_head_onto_main_tail(s_h, m_h),
        "BeltEndsApart",
        "a Head diagonal to the target Tail",
    );
    assert_refused_named(
        &mut s,
        main_tail_onto_side_head(m_h, s_h),
        "BeltEndsApart",
        "a Tail diagonal to the target Head",
    );
}

/// A two-tile belt (20,5)->(21,5) docking an end onto its OWN other end: the carrier end
/// sits on the target end's inner tile. Refused both ways by the not-the-inner-tile term,
/// which is the only term that refuses it (the cells are one step apart and the outward
/// sides are W and E, not equal).
#[test]
fn a_belt_cannot_join_its_own_inner_tile() {
    let mut s = GridSession::new(SEED);
    let (id, h) = draw(&mut s, vec![(20, 5), (21, 5)]);
    // Measured: Tail (20,5) outward W, Head (21,5) outward E.
    assert_eq!(end_of(&s, id, CoreEnd::Tail), ((20, 5), Some(Side::W)));
    assert_eq!(end_of(&s, id, CoreEnd::Head), ((21, 5), Some(Side::E)));
    assert_refused(
        &mut s,
        GridCommand::Dock { belt: h, endpoint: BeltEnd::Tail, node: h, port: HEAD_PORT },
        CommandError::InvalidBeltJoin,
        "a belt's Tail onto its own Head (the Tail is the Head's inner tile)",
    );
    assert_refused(
        &mut s,
        GridCommand::Dock { belt: h, endpoint: BeltEnd::Head, node: h, port: TAIL_PORT },
        CommandError::InvalidBeltJoin,
        "a belt's Head onto its own Tail (the Head is the Tail's inner tile)",
    );
}

/// A one-tile target has an end cell and no direction: refused, as before.
#[test]
fn a_single_tile_target_is_refused() {
    let mut s = GridSession::new(SEED);
    let (m_id, m_h) = draw(&mut s, (4..=7).map(|x| (x, 6)).collect());
    let (t_id, t_h) = draw(&mut s, vec![(4, 5)]);
    // Measured: main Tail (4,6) outward W; the one-tile target (4,5) has no outward side.
    assert_eq!(end_of(&s, m_id, CoreEnd::Tail), ((4, 6), Some(Side::W)));
    assert_eq!(end_of(&s, t_id, CoreEnd::Head), ((4, 5), None));
    assert_refused(
        &mut s,
        main_tail_onto_side_head(m_h, t_h),
        CommandError::InvalidBeltJoin,
        "a Tail onto a one-tile target",
    );
}

/// Two belts meeting Head to Head: A east (10,30)->(12,30), B west (14,30)->(13,30). The
/// cells are one step apart, neither is the other's inner tile and the outward sides (E
/// and W) differ, so ONLY the role rule refuses: a Head (load) dock needs an In.
#[test]
fn a_head_onto_a_head_is_refused() {
    let mut s = GridSession::new(SEED);
    let (a_id, a_h) = draw(&mut s, vec![(10, 30), (11, 30), (12, 30)]);
    let (b_id, b_h) = draw(&mut s, vec![(14, 30), (13, 30)]);
    // Measured: A Head (12,30) outward E; B Head (13,30) outward W.
    assert_eq!(end_of(&s, a_id, CoreEnd::Head), ((12, 30), Some(Side::E)));
    assert_eq!(end_of(&s, b_id, CoreEnd::Head), ((13, 30), Some(Side::W)));
    assert_refused(
        &mut s,
        GridCommand::Dock { belt: a_h, endpoint: BeltEnd::Head, node: b_h, port: HEAD_PORT },
        CommandError::InvalidBeltJoin,
        "a Head onto another belt's Head (Out)",
    );
}

/// THE STATED ASSUMPTION. Two side-by-side belts running opposite ways, A east
/// (10,20)->(12,20) and B west (12,21)->(10,21): A's Head (12,20) sits right above B's
/// Tail (12,21). The cells are one step apart and neither is the other's inner tile, so
/// the D-02 facing term alone refuses it, in BOTH drag directions: the carrier's outward
/// side equals the target end's side (both E).
#[test]
fn a_u_turn_join_is_refused_both_ways() {
    let mut s = GridSession::new(SEED);
    let (a_id, a_h) = draw(&mut s, vec![(10, 20), (11, 20), (12, 20)]);
    let (b_id, b_h) = draw(&mut s, vec![(12, 21), (11, 21), (10, 21)]);
    // Measured: A Head (12,20) outward E; B Tail (12,21) outward E.
    assert_eq!(end_of(&s, a_id, CoreEnd::Head), ((12, 20), Some(Side::E)));
    assert_eq!(end_of(&s, b_id, CoreEnd::Tail), ((12, 21), Some(Side::E)));
    // NAMED CHANGE (plan 74.1-24, gap J11): `InvalidBeltJoin` until this plan; the
    // U-turn now carries its own cause, `BeltJoinTurnsBack`. Still refused both ways.
    assert_refused_named(
        &mut s,
        GridCommand::Dock { belt: a_h, endpoint: BeltEnd::Head, node: b_h, port: TAIL_PORT },
        "BeltJoinTurnsBack",
        "U-turn: A's Head dragged onto B's Tail",
    );
    assert_refused_named(
        &mut s,
        GridCommand::Dock { belt: b_h, endpoint: BeltEnd::Tail, node: a_h, port: HEAD_PORT },
        "BeltJoinTurnsBack",
        "U-turn: B's Tail dragged onto A's Head",
    );
}

/// A MACHINE target keeps the doorstep rule exactly. A Source's Out port: a carrier Tail
/// on the cell beside the machine (one orthogonal step from the PORT cell, which the
/// belt rule would accept) and a carrier Tail one step to the side of the doorstep are
/// both refused; the carrier Tail on the doorstep itself is accepted.
#[test]
fn a_machine_doorstep_still_needs_the_exact_cell() {
    let mut s = GridSession::new(SEED);
    let (src_id, src_h) = place(&mut s, machine_kind::SOURCE, 10, 10);
    let ports = s.core().state.ports_of(src_id).expect("a Source has ports").to_vec();
    let out_idx = ports.iter().position(|p| p.role == Role::Out).expect("a Source has an Out");
    let anchor = s.core().state.cell_of(src_id).expect("placed");
    let fp = s.core().state.footprint_of(src_id).unwrap_or(fabrico_core::state::Footprint {
        w: 1,
        h: 1,
        rot: 0,
    });
    let (pcell, pside) = port_world(anchor, fp.w, fp.h, fp.rot, &ports[out_idx]);
    let (dx, dy) = unit_delta(pside);
    let door = (pcell.0 + dx, pcell.1 + dy);
    // Perpendicular unit step to the port side.
    let (px, py) = (-dy, dx);
    // Measured: Source at (10,10), Out port cell (10,10) facing E, doorstep (11,10).
    assert_eq!((pcell, pside, door), ((10, 10), Side::E, (11, 10)));
    let port = u16::try_from(out_idx).expect("small index");

    // 1. Beside the machine: one orthogonal step from the PORT cell, off the doorstep.
    //    A carrier running away from the machine (Tail outward points back at it).
    let beside = (pcell.0 + px, pcell.1 + py);
    let (_c1, c1_h) = draw(&mut s, vec![beside, (beside.0 + px, beside.1 + py)]);
    assert_refused(
        &mut s,
        GridCommand::Dock { belt: c1_h, endpoint: BeltEnd::Tail, node: src_h, port },
        CommandError::InvalidDock,
        "a carrier Tail beside the machine, next to its port cell but off the doorstep",
    );
    // 2. One step to the side of the doorstep (diagonal to the port cell).
    let (sx, sy) = (door.0 - px, door.1 - py);
    let (_c2, c2_h) = draw(&mut s, vec![(sx, sy), (sx - px, sy - py)]);
    assert_refused(
        &mut s,
        GridCommand::Dock { belt: c2_h, endpoint: BeltEnd::Tail, node: src_h, port },
        CommandError::InvalidDock,
        "a carrier Tail one step to the side of the doorstep",
    );
    // Control: on the doorstep itself, running straight away, it docks.
    let (_c3, c3_h) = draw(&mut s, vec![door, (door.0 + dx, door.1 + dy)]);
    s.apply(GridCommand::Dock { belt: c3_h, endpoint: BeltEnd::Tail, node: src_h, port })
        .expect("a carrier Tail on the doorstep docks (control)");
}
