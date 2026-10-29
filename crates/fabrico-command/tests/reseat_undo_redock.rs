//! CORNER-06 (phase 74.1, plans 74.1-12 and 74.1-16), the command half of a port edit's
//! release: ONE Ctrl+Z puts back EVERY belt a port edit released, live and after a save
//! and a load.
//!
//! From 74.1-12 to 74.1-16 `fold_remove_port` and `fold_add_port` re-seated every port and
//! released each belt whose port moved, so a removal released several belts and a growing
//! add on a half-turned Router released four. By design now (74.1-16, 2026-10-04, and
//! review WR-01) no port edit moves an existing port: a removal releases
//! exactly the removed port's own belt, and a growing add releases nothing, because the
//! only ports it moves (an Out on a widening, a Fault on a growth taller) move onto the
//! cell a docked belt's end tile holds, and the command layer refuses that add as a
//! collision. Both are still recorded on `core.last_tick.unlinked` when they happen, so
//! the command layer still owes compensating `Dock`s on undo:
//!
//! - `RemovePort`'s inverse re-docks everything its capture severed (73-06).
//! - `AddPort` is in `attribute_severances`' severing-op set, and its inverse (a
//!   `RemovePort` of the slot the record names, carrying the box it grew from) is followed
//!   by compensating `Dock`s from its own capture under the `RemovePort` arm's refusal
//!   policy. No command-built board reaches that release any more, so its rows here run on
//!   a FORGED log loaded through `GridSession::replay`, the path a hand-edited file takes.
//!
//! # Every row drives the PUBLIC `GridSession::apply` seam
//! `Place`, `Rotate`, `AddPort`, `RemovePort`, `DrawBelt`, `Dock`, `Undo`: the producer
//! the UI is. The save and load leg encodes `session.edit_log()` with postcard (the
//! on-disk representation) and re-folds it through `GridSession::replay`, which rebuilds
//! the severed set only through `reconstruct_projection`'s throwaway re-fold.
//!
//! # The oracle is the serialized `links` map, never a count
//! As `rotate_undo_redock.rs` and `remove_port_redock.rs` assert: a link COUNT is
//! satisfied by a build that re-docked the wrong belt to the wrong port. The severed set is
//! READ off `last_tick.unlinked`, asserted to be the measured size first, and the restored
//! map is compared byte for byte against one captured in the same run. Every row also
//! checks that each restored link's port faces its belt end, so "byte-equal" cannot hide a
//! board drawn onto nothing.
//!
//! # The boards are CATALOG Routers (since 74.1-14)
//! Until plan 74.1-14 a Router placed from the catalog seated its Outs at local rows
//! 2, 0, 1 and the fold re-seated by index, so these boards made the machine's first
//! port edit before any belt was drawn. Under the rule of 2026-10-04 ("Edits keep
//! middle layout") the catalog seats the In on row 1 and the Outs on rows 1, 2, 0, which
//! is exactly where every port edit and every undo re-seats them, so the warm-up edit is
//! gone and `catalog_router` asserts the fixed point instead. The rows each test docks on
//! are measured and asserted before use.
//!
//! Run target: `cargo test -p fabrico-command --test reseat_undo_redock`.

use fabrico_command::GridSession;
use fabrico_core::edit::EditRecord;
use fabrico_core::fault::FAULT_PORT;
use fabrico_core::ids::{NodeId, PortId};
use fabrico_core::state::{Footprint, Node, Port, Role, port_world, reseat_ports, unit_delta};
use fabrico_protocol::{GridCommand, machine_kind};

const SEED: u64 = 0xFAB_C0DE;

/// Every machine here is anchored at (10,10).
const ANCHOR: (i32, i32) = (10, 10);

/// The serialized `links` map, the oracle every row asserts on.
fn link_bytes(session: &GridSession) -> Vec<u8> {
    let links: Vec<((NodeId, PortId), (NodeId, PortId))> =
        session.core().state.links_iter().collect();
    postcard::to_allocvec(&links).expect("serialize the links map")
}

/// The most recently minted node and its dense render handle.
fn last_minted(session: &GridSession) -> (NodeId, u64) {
    let id = *session.core().last_tick.placed.last().expect("a node was minted");
    (id, session.view().handle_of(id).expect("the node got a handle"))
}

/// Draw a belt through `cells` and return `(id, handle)`.
fn draw(session: &mut GridSession, cells: Vec<(i32, i32)>) -> (NodeId, u64) {
    session
        .apply(GridCommand::DrawBelt { cells })
        .expect("a clear drawn path is accepted");
    last_minted(session)
}

/// Dock `belt`'s `end` to the machine's SPATIAL catalog index `port` (the command's own
/// keyspace; `dock_link_key` translates it).
fn dock(session: &mut GridSession, belt: u64, end: fabrico_protocol::BeltEnd, node: u64, port: u16) {
    session
        .apply(GridCommand::Dock {
            belt,
            endpoint: end,
            node,
            port,
        })
        .expect("a dock on a real doorstep is accepted");
}

/// A Router placed from the catalog at [`ANCHOR`] and turned `quarter_turns`, its list
/// `[In, Out, Out, Out, Fault]` already on the cells every later port edit re-seats it to
/// (asserted, not assumed: the catalog layout is a fixed point of `reseat_ports` since
/// 74.1-14).
fn catalog_router(session: &mut GridSession, quarter_turns: u8) -> (NodeId, u64) {
    session
        .apply(GridCommand::Place {
            kind: machine_kind::ROUTER,
            cell_x: ANCHOR.0,
            cell_y: ANCHOR.1,
        })
        .expect("place the router");
    let (m, h) = last_minted(session);
    for _ in 0..quarter_turns {
        session
            .apply(GridCommand::Rotate { node: h, ccw: false })
            .expect("turn the undocked router");
    }
    let ports = session.core().state.ports_of(m).expect("router ports").to_vec();
    assert_eq!(
        ports.iter().map(|p| p.role).collect::<Vec<_>>(),
        vec![Role::In, Role::Out, Role::Out, Role::Out, Role::Fault],
        "the catalog's list, in order"
    );
    assert_eq!(
        ports,
        reseat_ports(Footprint { w: 2, h: 3, rot: 0 }, 2, 3, &ports),
        "and every port is already on its re-seated cell"
    );
    (m, h)
}

/// The facing cell of the port a LINK key names on `m` (the keyspace table in
/// `state.rs`: `FAULT_PORT` is the first Fault, a Tail key the n-th Out, a Head key the
/// catalog index), read off the live core.
fn doorstep_of_key(session: &GridSession, m: NodeId, key: PortId, head: bool) -> (i32, i32) {
    let state = &session.core().state;
    let ports: &[Port] = state.ports_of(m).expect("ports");
    let port = if key == FAULT_PORT {
        ports.iter().find(|p| p.role == Role::Fault)
    } else if head {
        ports.get(key as usize)
    } else {
        ports.iter().filter(|p| p.role == Role::Out).nth(key as usize)
    }
    .expect("the key names a port");
    let fp = state.footprint_of(m).expect("footprint");
    let anchor = state.cell_of(m).expect("the machine has a cell");
    let (pcell, side) = port_world(anchor, fp.w, fp.h, fp.rot, port);
    let (dx, dy) = unit_delta(side);
    (pcell.0 + dx, pcell.1 + dy)
}

/// The facing cell of catalog port `idx` on `m`.
fn doorstep_of_catalog(session: &GridSession, m: NodeId, idx: usize) -> (i32, i32) {
    let state = &session.core().state;
    let port = state.ports_of(m).expect("ports")[idx];
    let fp = state.footprint_of(m).expect("footprint");
    let anchor = state.cell_of(m).expect("the machine has a cell");
    let (pcell, side) = port_world(anchor, fp.w, fp.h, fp.rot, &port);
    let (dx, dy) = unit_delta(side);
    (pcell.0 + dx, pcell.1 + dy)
}

/// Every belt link naming `m` touches its port: the port's facing cell is the belt's end
/// tile. Returns how many links were checked.
fn assert_every_link_faces(session: &GridSession, m: NodeId, ctx: &str) -> usize {
    let state = &session.core().state;
    let mut n = 0;
    for ((f, fp), (t, tp)) in state.links_iter() {
        let (belt, key, head) = if f == m {
            (t, fp, false)
        } else if t == m {
            (f, tp, true)
        } else {
            continue;
        };
        let Some(Node::Belt(b)) = state.node(belt) else { continue };
        let end = if head { b.geometry.last() } else { b.geometry.first() }
            .expect("a drawn belt")
            .cell;
        assert_eq!(
            doorstep_of_key(session, m, key, head),
            end,
            "{ctx}: the link on key {key} ({}) touches its belt",
            if head { "Head" } else { "Tail" }
        );
        n += 1;
    }
    n
}

/// The released belts, read off the live core, sorted.
fn released_belts(session: &GridSession) -> Vec<NodeId> {
    let mut v: Vec<NodeId> = session.core().last_tick.unlinked.iter().map(|u| u.belt).collect();
    v.sort();
    v
}

/// The local E-column row of routing key `k` on a 2x3 catalog Router (74.1-14: the
/// centre-out fill, middle, below, above).
const OUT_ROWS: [i32; 3] = [1, 2, 0];

/// THE REMOVEPORT BOARD, MEASURED. A catalog Router at (10,10), rot 0: `In` at local
/// (0,1) facing W, so its facing cell is (9,11); `Out_k` at (1, OUT_ROWS[k]) facing E,
/// facing (12, 10 + OUT_ROWS[k]); `Fault` at (0,2) facing S, facing (10,13). A feeder
/// arrives at (9,11) from the west, one belt leaves east from each Out's facing cell, and
/// one leaves south from the Fault's. Returns `(machine id, handle, the three Out belts in
/// routing-key order)`.
fn remove_port_board(session: &mut GridSession) -> (NodeId, u64, Vec<NodeId>) {
    let (m, h) = catalog_router(session, 0);
    assert_eq!(doorstep_of_catalog(session, m, 0), (9, 11), "measured: the In faces (9,11)");
    for (k, row) in OUT_ROWS.iter().enumerate() {
        assert_eq!(doorstep_of_catalog(session, m, 1 + k), (12, 10 + row), "measured: Out_{k}");
    }
    assert_eq!(doorstep_of_catalog(session, m, 4), (10, 13), "measured: the Fault faces (10,13)");
    let (_, feeder) = draw(session, vec![(7, 11), (8, 11), (9, 11)]);
    dock(session, feeder, fabrico_protocol::BeltEnd::Head, h, 0);
    let mut outs = Vec::new();
    for (k, row) in OUT_ROWS.iter().enumerate() {
        let y = 10 + row;
        let (id, b) = draw(session, vec![(12, y), (13, y)]);
        dock(session, b, fabrico_protocol::BeltEnd::Tail, h, 1 + k as u16);
        outs.push(id);
    }
    let (_, fault) = draw(session, vec![(10, 13), (10, 14)]);
    dock(session, fault, fabrico_protocol::BeltEnd::Tail, h, 4);
    assert_eq!(assert_every_link_faces(session, m, "the built board"), 5, "five docks");
    (m, h, outs)
}

/// RemovePort, live. RE-AUTHORED IN 74.1-16 (same title): removing `Out_0` used to re-seat
/// `Out_1` and `Out_2` into the previous slots and release all three Out belts. Under the middle-layout
/// rule no survivor moves, so the fold releases exactly the removed port's own belt,
/// keeps and re-keys the other two, and keeps the In and the Fault. One Ctrl+Z restores
/// the links byte for byte, which is this row's subject and is unchanged.
///
/// RED BEFORE 74.1-12 at its first assertion (it then pinned three releases); RED at
/// 74.1-16's start revision for the same reason in reverse.
#[test]
fn one_undo_re_docks_every_belt_a_remove_port_released() {
    let mut session = GridSession::new(SEED);
    let (m, h, outs) = remove_port_board(&mut session);
    let before = link_bytes(&session);

    session
        .apply(GridCommand::RemovePort { node: h, index: 1 })
        .expect("removing a docked Out is accepted");
    assert_eq!(
        released_belts(&session),
        vec![outs[0]],
        "the fold released exactly the removed port's own belt"
    );
    assert_ne!(link_bytes(&session), before, "the links map really moved");
    assert_eq!(
        assert_every_link_faces(&session, m, "after the removal"),
        4,
        "the In, the Fault and the two other Outs are kept, each touching"
    );

    session.apply(GridCommand::Undo).expect("ONE Undo");
    assert_eq!(link_bytes(&session), before, "one Ctrl+Z restores the links map byte for byte");
    assert_eq!(assert_every_link_faces(&session, m, "after the undo"), 5, "and every link touches");
}

/// RemovePort, after a save and a load. The live severed-dock map is empty on a replayed
/// session by construction, so the compensation can only come from
/// `reconstruct_projection`'s re-fold.
#[test]
fn a_remove_port_release_is_undone_after_a_save_and_a_load() {
    let mut session = GridSession::new(SEED);
    let (m, h, outs) = remove_port_board(&mut session);
    let before = link_bytes(&session);

    session
        .apply(GridCommand::RemovePort { node: h, index: 1 })
        .expect("removing a docked Out is accepted");
    assert_eq!(released_belts(&session), vec![outs[0]], "one belt released live (74.1-16)");
    let severed = link_bytes(&session);

    let bytes = postcard::to_allocvec(&session.edit_log().to_vec()).expect("encode the edit log");
    let records: Vec<EditRecord> = postcard::from_bytes(&bytes).expect("decode the edit log");
    let mut loaded = GridSession::replay(SEED, &records);
    assert_eq!(link_bytes(&loaded), severed, "the load reproduces the released board");

    loaded.apply(GridCommand::Undo).expect("ONE Undo on the loaded session");
    assert_eq!(link_bytes(&loaded), before, "the compensation survives a save and a load");
    assert_eq!(assert_every_link_faces(&loaded, m, "after the loaded undo"), 5, "every link touches");
}

/// THE ADDPORT BOARD, MEASURED. A catalog Router at (10,10) turned half way (rot 2:
/// local (x,y) -> (w-1-x, h-1-y), side + 2). At 2x3: `Out_k` local (1, OUT_ROWS[k]) sits
/// at world (10, 12 - OUT_ROWS[k]) facing W, facing cells (9,11), (9,10), (9,12); the
/// `In` (0,1) sits at (11,11) facing E, facing (12,11); the `Fault` (0,2) sits at (11,10)
/// facing N, facing (11,9). A belt leaves west from each Out's facing cell, a feeder
/// arrives at (12,11) from the east, and, when `fault_belt`, a belt leaves north from the
/// Fault's. Returns `(machine id, handle)`.
fn add_port_board(session: &mut GridSession, fault_belt: bool) -> (NodeId, u64) {
    let (m, h) = catalog_router(session, 2);
    for (k, row) in OUT_ROWS.iter().enumerate() {
        assert_eq!(doorstep_of_catalog(session, m, 1 + k), (9, 12 - row), "measured: Out_{k}");
    }
    assert_eq!(doorstep_of_catalog(session, m, 0), (12, 11), "measured: the In faces (12,11)");
    assert_eq!(doorstep_of_catalog(session, m, 4), (11, 9), "measured: the Fault faces (11,9)");
    for (k, row) in OUT_ROWS.iter().enumerate() {
        let y = 12 - row;
        let (_, b) = draw(session, vec![(9, y), (8, y)]);
        dock(session, b, fabrico_protocol::BeltEnd::Tail, h, 1 + k as u16);
    }
    let (_, feeder) = draw(session, vec![(14, 11), (13, 11), (12, 11)]);
    dock(session, feeder, fabrico_protocol::BeltEnd::Head, h, 0);
    let mut n = 4;
    if fault_belt {
        let (_, fault) = draw(session, vec![(11, 9), (11, 8)]);
        dock(session, fault, fabrico_protocol::BeltEnd::Tail, h, 4);
        n = 5;
    }
    assert_eq!(assert_every_link_faces(session, m, "the built board"), n, "every dock touches");
    (m, h)
}

/// The forward AddPort of a fourth Out.
fn add_an_out(session: &mut GridSession, h: u64) -> Result<(), fabrico_command::CommandError> {
    session
        .apply(GridCommand::AddPort {
            node: h,
            role: 1,
            side: 1,
            medium: 0,
        })
        .map(|_| ())
}

/// AddPort, live. RE-AUTHORED IN 74.1-16 (was `one_undo_re_docks_every_belt_an_add_port_released`).
/// On this half-turned board a fourth Out used to grow the box with the anchor fixed, move
/// every Out and the In one row and release those four belts (review WR-01). Since 74.1-16
/// the box grows on its rot-0 south edge, which the half turn puts at world NORTH, so the
/// anchor moves from (10,10) to (10,9), no In or Out moves, and the add releases nothing.
/// One Ctrl+Z (a `RemovePort` carrying the pre-add box) restores the box, the anchor and the
/// links byte for byte, and emits no compensating `Dock` because nothing was severed.
///
/// With a belt on the Fault the same add is REFUSED: the north growth lands on the fault
/// belt's end tile at (11,9). That is the second half of WR-01's fix. Since plan 74.1-18
/// the refusal is `GrowCoversBelt` (it was `FootprintCollision`): the tile met is a belt's.
#[test]
fn a_growing_add_on_the_half_turned_router_releases_nothing_and_one_undo_restores_it() {
    let mut session = GridSession::new(SEED);
    let (m, h) = add_port_board(&mut session, false);
    let before = link_bytes(&session);
    let fp_before = session.core().state.footprint_of(m);

    add_an_out(&mut session, h).expect("the growing add is accepted: no belt on the Fault");
    assert!(released_belts(&session).is_empty(), "the add released nothing");
    assert_eq!(session.core().state.cell_of(m), Some((10, 9)), "measured: the anchor moved north by the growth");
    assert_eq!(assert_every_link_faces(&session, m, "after the add"), 4, "every belt still touches");
    assert_eq!(link_bytes(&session), before, "and the links map did not move");

    let log_len = session.edit_log().len();
    session.apply(GridCommand::Undo).expect("ONE Undo");
    assert_eq!(link_bytes(&session), before, "one Ctrl+Z leaves the links map byte for byte");
    assert_eq!(session.core().state.cell_of(m), Some(ANCHOR), "the anchor is back");
    assert_eq!(session.core().state.footprint_of(m), fp_before, "the box is back");
    assert_eq!(assert_every_link_faces(&session, m, "after the undo"), 4, "and every link touches");
    let inverse: Vec<&fabrico_core::edit::EditOp> =
        session.edit_log()[log_len..].iter().map(|r| &r.op).collect();
    assert!(
        inverse.iter().any(|op| matches!(
            op,
            fabrico_core::edit::EditOp::RemovePort { restore: Some(r), .. }
                if (r.anchor_x, r.anchor_y, r.w, r.h) == (ANCHOR.0, ANCHOR.1, 2, 3)
        )),
        "the inverse RemovePort carries the pre-add 2x3 box at the pre-add anchor"
    );
    assert!(
        !inverse.iter().any(|op| matches!(op, fabrico_core::edit::EditOp::Dock { .. })),
        "and no compensating Dock, because nothing was severed"
    );

    let mut refused = GridSession::new(SEED);
    let (_m, h) = add_port_board(&mut refused, true);
    let log_len = refused.edit_log().len();
    assert_eq!(
        add_an_out(&mut refused, h),
        Err(fabrico_command::CommandError::GrowCoversBelt),
        "with a belt on the Fault the north growth would cover its end tile, so it is refused \
         in belt words (named change, plan 74.1-18: was FootprintCollision)"
    );
    assert_eq!(refused.edit_log().len(), log_len, "and nothing is logged");
}

/// A FORGED port-edit log, loaded the way a hand-edited file is: a catalog Router at
/// (10,10), rot 0, with a feeder on the In, a belt leaving east from each Out's facing
/// cell (12, 11), (12, 12), (12, 10) and one leaving south from the Fault's (10,13), all
/// built through `apply`; then ONE forged `AddPort` record no command writes, a Fault
/// seated `Captured` on slot 3, which widens the box to 4 and moves the Out column from
/// local x 1 to 3. The facing verdict releases the three Out belts (their ports moved);
/// the In and the Fault are kept. Returns the loaded session, the machine and the links
/// map from before the forged record.
fn forged_widening_load() -> (GridSession, NodeId, Vec<u8>) {
    let mut session = GridSession::new(SEED);
    let (m, _h, _outs) = remove_port_board(&mut session);
    let before = link_bytes(&session);
    let mut records: Vec<EditRecord> = session.edit_log().to_vec();
    let last = records.last().expect("a built board has records").clone();
    records.push(EditRecord {
        sequence: last.sequence + 1,
        tick: last.tick + 1,
        action: last.action + 1,
        op: fabrico_core::edit::EditOp::AddPort {
            node: m,
            port: Port {
                local_offset: (3, 2),
                side: fabrico_core::state::Side::S,
                role: Role::Fault,
                medium: fabrico_core::state::Medium::Mechanical,
            },
            index: 5,
            seat: fabrico_core::edit::PortSeat::Captured,
        },
        ..last
    });
    let bytes = postcard::to_allocvec(&records).expect("encode the edit log");
    let records: Vec<EditRecord> = postcard::from_bytes(&bytes).expect("decode the edit log");
    let loaded = GridSession::replay(SEED, &records);
    (loaded, m, before)
}

/// AddPort, after a load. RE-AUTHORED IN 74.1-16 (was `an_add_port_release_is_undone_after_a_save_and_a_load`).
/// No command-built board reaches an `AddPort` release any more, so the release comes
/// from a forged record (see [`forged_widening_load`]), and what this row pins is the
/// machinery that is left for it: one Ctrl+Z on the loaded session emits the `RemovePort`
/// carrying the pre-add box plus one compensating `Dock` per released belt, all rebuilt by
/// `reconstruct_projection` alone, and the links map comes back byte for byte.
#[test]
fn a_forged_add_port_release_is_undone_after_a_load() {
    let (mut loaded, m, before) = forged_widening_load();
    assert_eq!(
        session_footprint(&loaded, m),
        Footprint { w: 4, h: 3, rot: 0 },
        "measured: the forged Fault on slot 3 widened the box to 4"
    );
    assert_eq!(loaded.core().last_tick.unlinked.len(), 3, "the three Out belts were released");

    loaded.apply(GridCommand::Undo).expect("ONE Undo on the loaded session");
    assert_eq!(link_bytes(&loaded), before, "the compensation survives the load");
    assert_eq!(session_footprint(&loaded, m), Footprint { w: 2, h: 3, rot: 0 }, "the box is back");
    assert_eq!(assert_every_link_faces(&loaded, m, "after the loaded undo"), 5, "every link touches");
}

/// The live footprint.
fn session_footprint(session: &GridSession, m: NodeId) -> Footprint {
    session.core().state.footprint_of(m).expect("footprint")
}

/// The keyspace pin for the AddPort arm, the twin of `remove_port_redock.rs`'s
/// `the_compensating_dock_port_is_passed_through_untranslated`: each compensating `Dock`
/// carries `UnlinkedDock.port`, the PRE-edit LINK key, with no `dock_link_key`
/// translation. On this board the Outs' link keys are routing keys 0..2 while their catalog
/// indices are 1..3, so a translation cannot hide. Run on the forged load since 74.1-16
/// (see [`forged_widening_load`] for why).
#[test]
fn the_add_port_compensating_docks_carry_the_pre_edit_link_keys() {
    let (mut loaded, _m, _before) = forged_widening_load();
    let mut recorded: Vec<(NodeId, PortId)> =
        loaded.core().last_tick.unlinked.iter().map(|u| (u.belt, u.port)).collect();
    recorded.sort();

    let log_len = loaded.edit_log().len();
    loaded.apply(GridCommand::Undo).expect("ONE Undo");
    let mut emitted: Vec<(NodeId, PortId)> = loaded.edit_log()[log_len..]
        .iter()
        .filter_map(|r| match r.op {
            fabrico_core::edit::EditOp::Dock { belt, port, .. } => Some((belt, port)),
            _ => None,
        })
        .collect();
    emitted.sort();
    assert_eq!(emitted, recorded, "each Dock carries the released link key, untranslated");
    let keys: Vec<PortId> = recorded.iter().map(|(_, p)| *p).collect();
    assert!(keys.contains(&2), "routing key 2 (catalog 3) is among them, so translation would show");
    let first_dock = loaded.edit_log()[log_len..]
        .iter()
        .position(|r| matches!(r.op, fabrico_core::edit::EditOp::Dock { .. }))
        .expect("a Dock");
    let remove = loaded.edit_log()[log_len..]
        .iter()
        .position(|r| matches!(r.op, fabrico_core::edit::EditOp::RemovePort { .. }))
        .expect("the inverse RemovePort");
    assert!(remove < first_dock, "the RemovePort folds first, so each Dock lands in the restored keyspace");
}
