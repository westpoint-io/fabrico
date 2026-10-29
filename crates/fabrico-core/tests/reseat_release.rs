//! CORNER-06 / WR-01 (phase 74.1, plans 74.1-12 and 74.1-16): which belt docks a port edit
//! keeps and which it releases, pinned as GEOMETRY.
//!
//! # What this file pins
//! Since plan 74.1-12 `fold_remove_port` and `fold_add_port` ask IDENTITY, THEN FACING: a
//! belt dock that survives the identity re-key (the link follows its port through the
//! list edit) is kept only while its port still faces the belt end, at the machine's
//! anchor, footprint and rotation after the edit; otherwise it is released with one
//! `UnlinkedDock` carrying its PRE-edit link key. Wire endpoints keep the identity verdict.
//!
//! Since plan 74.1-16 (the 2026-10-04 design ruling that existing ports are not
//! auto-arranged, and review WR-01) NO PORT EDIT MOVES AN EXISTING PORT OFF ITS SLOT. A removal
//! keeps the box, the anchor and every survivor's slot; an add seats the new port on the
//! first free slot of its role in the centre-out `role_slot` order from the catalog box,
//! and when the box must grow it grows on its rot-0 east or south edge, wherever the turn
//! put that edge, by shifting the anchor: rot 0 `(0, 0)`, rot 1 `(-dh, 0)`, rot 2
//! `(-dw, -dh)`, rot 3 `(0, -dw)`. So the facing verdict releases a survivor only where an
//! add moves a port: an Out on a widening, a Fault on a growth taller. From 74.1-12 to
//! 74.1-16 every edit re-seated the whole list and grew the box with its anchor fixed, so
//! these pins asserted many more releases; each re-authored pin names what changed.
//!
//!   1. `removing_out_0_of_a_2x4_router_releases_only_its_own_belt`: no survivor moves, the
//!      box does not shrink, the three other Outs are re-keyed and kept.
//!   2. `removing_the_last_out_releases_only_its_belt`: and the box still does not shrink.
//!   3. `a_widening_add_keeps_the_fault_nub_and_moves_the_out_column_onto_its_belt`: a
//!      Fault added to a half-turned Router widens the box on its far edge, so the Fault
//!      nubs stay and the Out column moves one cell onto its belt's end tile, which is why
//!      the command layer refuses that add; on a forged fold the Out's belt is released.
//!   4. `an_add_port_that_moves_nothing_releases_nothing`.
//!   5. `every_kept_belt_link_faces_its_port_after_any_single_port_edit`: the sweep.
//!
//! # Why the boundary is asserted as geometry
//! A pin that restates the predicate (`kept == dock_still_reaches(..)`) passes for
//! whatever predicate the fold carries; `dock_facing_rotate.rs` records how that once
//! certified the wrong boundary. Every expectation here is derived from where a port's
//! FACING CELL lands, through this file's own statement of the 74.1-16 geometry
//! ([`expected_after`], written from the rule's sentence, never from the fold's code) and
//! `port_world` alone. A legal dock faces before the edit, and a port keeps its role and
//! therefore its side, so it still faces afterwards exactly when its facing cell did not
//! move.
//!
//! # The boards are reachable ones
//! Every board places its machine on the layout a command gives it, docks belts on real
//! doorsteps, and the sweep skips any add whose grown box (at its shifted anchor) would
//! cover a belt tile, because the command layer refuses that `AddPort`.
//!
//! Run target: `cargo test -p fabrico-core --test reseat_release`.
//! `BTreeSet`/`Vec` only, no `HashSet` or `HashMap` iteration.

use std::collections::BTreeSet;

use fabrico_core::core::Core;
use fabrico_core::edit::{BeltEnd, EDIT_SCHEMA_VERSION, EditOp, EditRecord, PortSeat};
use fabrico_core::event::{LogHeader, SCHEMA_VERSION};
use fabrico_core::fault::FAULT_PORT;
use fabrico_core::ids::{NodeId, PortId};
use fabrico_core::state::{
    cells_of_footprint, grow_to_fit, port_world, reseat_ports, role_slot, unit_delta, Axis,
    BeltTile, Footprint, Medium, Node, Port, Role, Side, TileKind,
};

/// The machine kind byte `fold_place` mints a `Node::Router` from, restated as
/// `remove_port_repoint.rs` does (`machine_kind` is crate-private).
const KIND_ROUTER: u8 = 5;

/// The Router's per-kind floor, `base_footprint(Node::Router)`. Restated here so every
/// expected box is computed without reading the fold's own output.
const ROUTER_BASE: Footprint = Footprint { w: 2, h: 3, rot: 0 };

/// Every board's machine anchor.
const ANCHOR: (i32, i32) = (10, 10);

/// A forged-board edit record: stamped with the current schema, action 0.
fn rec(sequence: u64, tick: u64, op: EditOp) -> EditRecord {
    EditRecord {
        schema_version: EDIT_SCHEMA_VERSION,
        partition: 0,
        sequence,
        tick,
        action: 0,
        op,
    }
}

/// A core folded straight from edit records through `Core::advance_edits`, the entry the
/// host's edit drain uses. Nothing here hand-writes a link or a port list.
#[derive(Clone)]
struct Forge {
    core: Core,
    seq: u64,
}

impl Forge {
    fn new(seed: u64) -> Self {
        Self {
            core: Core::genesis(LogHeader {
                schema_version: SCHEMA_VERSION,
                seed,
            }),
            seq: 0,
        }
    }

    /// Fold one op and return the id it minted, if any.
    fn fold(&mut self, op: EditOp) -> Option<NodeId> {
        self.seq += 1;
        let r = rec(self.seq, self.core.tick, op);
        self.core.advance_edits(&[r], &[]);
        self.core.last_tick.placed.last().copied()
    }
}

/// A Mechanical port of `role`; its offset and side are overwritten by `reseat_ports`.
fn mech(role: Role) -> Port {
    Port {
        local_offset: (0, 0),
        side: Side::E,
        role,
        medium: Medium::Mechanical,
    }
}

/// The box and the re-seated ports a Router carrying `roles` (in list order) sits in, as
/// a pure function of the list: `grow_to_fit` over the Router floor, then `reseat_ports`.
fn seated(roles: &[Role]) -> (Footprint, Vec<Port>) {
    let seed: Vec<Port> = roles.iter().map(|r| mech(*r)).collect();
    let fp = grow_to_fit(ROUTER_BASE, &seed);
    let ports = reseat_ports(ROUTER_BASE, fp.w, fp.h, &seed);
    (fp, ports)
}

/// Place a Router carrying `roles` at [`ANCHOR`], already re-seated, then turn it `rot`
/// quarter turns (nothing is docked yet, so the turns release nothing).
fn router(forge: &mut Forge, roles: &[Role], rot: u8) -> NodeId {
    let (fp, ports) = seated(roles);
    let m = forge
        .fold(EditOp::Place {
            kind: KIND_ROUTER,
            cell_x: ANCHOR.0,
            cell_y: ANCHOR.1,
            w: fp.w,
            h: fp.h,
            ports,
            rot: 0,
        })
        .expect("the router was minted");
    for r in 0..rot {
        forge.fold(EditOp::Rotate {
            node: m,
            new_rot: r + 1,
            old_rot: r,
        });
    }
    m
}

/// One step from `cell` across edge `side`.
fn step(cell: (i32, i32), side: Side) -> (i32, i32) {
    let (dx, dy) = unit_delta(side);
    (cell.0 + dx, cell.1 + dy)
}

/// A straight tile on `cell` running along the axis of a step across `side`.
fn tile(cell: (i32, i32), side: Side) -> BeltTile {
    let axis = match side {
        Side::E | Side::W => Axis::X,
        Side::N | Side::S => Axis::Y,
    };
    BeltTile::new(cell, TileKind::Straight { axis })
}

/// A two-tile belt LEAVING `door`: its Tail on `door`, its second tile one step `toward`.
fn belt_leaving(forge: &mut Forge, door: (i32, i32), toward: Side) -> NodeId {
    forge
        .fold(EditOp::DrawBelt {
            tiles: vec![tile(door, toward), tile(step(door, toward), toward)],
        })
        .expect("the belt was minted")
}

/// A two-tile belt ARRIVING at `door`: its Head on `door`, its first tile one step `from`.
fn belt_arriving(forge: &mut Forge, door: (i32, i32), from: Side) -> NodeId {
    forge
        .fold(EditOp::DrawBelt {
            tiles: vec![tile(step(door, from), from), tile(door, from)],
        })
        .expect("the belt was minted")
}

/// The port a dock link key names on `ports`, by the keyspace table in `state.rs`
/// (`resolve_link_port`'s docblock): `FAULT_PORT` is the first Fault, a Tail key is the
/// n-th Out, a Head key is the catalog index.
fn port_index_for_key(ports: &[Port], key: PortId, end: BeltEnd) -> Option<usize> {
    if key == FAULT_PORT {
        return ports.iter().position(|p| p.role == Role::Fault);
    }
    match end {
        BeltEnd::Tail => ports
            .iter()
            .enumerate()
            .filter(|(_, p)| p.role == Role::Out)
            .nth(key as usize)
            .map(|(i, _)| i),
        BeltEnd::Head => ((key as usize) < ports.len()).then_some(key as usize),
    }
}

/// The FACING CELL of port `p` on a box `fp` at `anchor`: the cell a docked belt end must
/// sit on for the port to touch it.
fn facing_cell(anchor: (i32, i32), fp: Footprint, p: &Port) -> (i32, i32) {
    let (pcell, side) = port_world(anchor, fp.w, fp.h, fp.rot, p);
    step(pcell, side)
}

/// The facing cell of the port `key` names on machine `m`, read off the live core.
fn live_doorstep(core: &Core, m: NodeId, key: PortId, end: BeltEnd) -> (i32, i32) {
    let ports = core.state.ports_of(m).expect("the machine declares ports");
    let fp = core.state.footprint_of(m).expect("the machine has a footprint");
    let anchor = core.state.cell_of(m).expect("the machine has a cell");
    let i = port_index_for_key(ports, key, end)
        .unwrap_or_else(|| panic!("link key {key} at {end:?} names a port"));
    facing_cell(anchor, fp, &ports[i])
}

/// The cell a belt's `end` tile sits on.
fn belt_end_cell(core: &Core, belt: NodeId, end: BeltEnd) -> (i32, i32) {
    match core.state.node(belt) {
        Some(Node::Belt(b)) => match end {
            BeltEnd::Tail => b.geometry.first().expect("a drawn belt").cell,
            BeltEnd::Head => b.geometry.last().expect("a drawn belt").cell,
        },
        _ => panic!("{belt:?} is a belt"),
    }
}

/// `BeltEnd` as a sortable byte (it derives no `Ord`).
fn end_byte(end: BeltEnd) -> u8 {
    match end {
        BeltEnd::Tail => 0,
        BeltEnd::Head => 1,
    }
}

fn end_of(byte: u8) -> BeltEnd {
    if byte == 0 { BeltEnd::Tail } else { BeltEnd::Head }
}

/// One belt dock on a machine as `(machine-side key, end byte, belt)`.
type Dock = (PortId, u8, NodeId);

/// Every belt dock naming `m`, read off the links map, sorted.
fn machine_docks(core: &Core, m: NodeId) -> BTreeSet<Dock> {
    let is_belt = |id: NodeId| matches!(core.state.node(id), Some(Node::Belt(_)));
    core.state
        .links_iter()
        .filter_map(|((f, fp), (t, tp))| {
            if f == m && is_belt(t) {
                Some((fp, end_byte(BeltEnd::Tail), t))
            } else if t == m && is_belt(f) {
                Some((tp, end_byte(BeltEnd::Head), f))
            } else {
                None
            }
        })
        .collect()
}

/// The docks the last fold released, as `(pre-edit key, end byte, belt)`, each asserted
/// to name machine `m`.
fn released(core: &Core, m: NodeId) -> BTreeSet<Dock> {
    core.last_tick
        .unlinked
        .iter()
        .map(|u| {
            assert_eq!(u.node, m, "every release names the edited machine");
            (u.port, end_byte(u.endpoint), u.belt)
        })
        .collect()
}

/// Dock `belt`'s `end` to `m` at link key `key`, and assert the dock is legal geometry:
/// the port's facing cell is the belt's end tile.
fn dock(forge: &mut Forge, m: NodeId, key: PortId, belt: NodeId, end: BeltEnd) {
    assert_eq!(
        live_doorstep(&forge.core, m, key, end),
        belt_end_cell(&forge.core, belt, end),
        "the board is legal: key {key} at {end:?} faces its belt's end tile"
    );
    forge.fold(EditOp::Dock {
        belt,
        endpoint: end,
        node: m,
        port: key,
    });
}

/// Every belt dock still naming `m` touches its port: the port's facing cell is the end
/// tile. The plan's sweep claim, read off the live core after the edit.
fn assert_every_dock_faces(core: &Core, m: NodeId, ctx: &str) {
    for (key, end, belt) in machine_docks(core, m) {
        let end = end_of(end);
        assert_eq!(
            live_doorstep(core, m, key, end),
            belt_end_cell(core, belt, end),
            "{ctx}: the kept dock {key} at {end:?} faces its belt's end tile"
        );
    }
}

// ---------------------------------------------------------------------------
// The 2x4 Router board, pins 1 and 2.
// ---------------------------------------------------------------------------

/// The 2x4 board, MEASURED (each cell is asserted in the board builder):
///
/// A Router `[In, Out, Out, Out, Out]` at (10,10), rot 0. `grow_to_fit` gives 2x4 (four
/// Outs need four rows). Re-seated: `In_0` at local (0,1) facing W, so its facing cell is
/// world (9,11); `Out_k` at local (1, OUT_ROWS[k]) facing E, facing cell
/// (12, 10 + OUT_ROWS[k]), with `OUT_ROWS` = [1, 2, 0, 3].
///
/// Belts: a feeder ARRIVES at (9,11) from the west, (8,11) -> (9,11), Head on `In_0`
/// (catalog key 0). `Out_0`, `Out_1`, `Out_2` each LEAVE east from their facing cells.
/// `Out_3`'s belt TURNS at once, (12,13) -> (12,14), the shape the seam derivation draws as
/// a corner.
/// The local row of `Out_k` on the 2x4 board (centre-out from the 2x3 base, then grown).
const OUT_ROWS: [i32; 4] = [1, 2, 0, 3];

struct TwoByFour {
    forge: Forge,
    m: NodeId,
    feeder: NodeId,
    outs: [NodeId; 4],
}

fn two_by_four(seed: u64) -> TwoByFour {
    let mut forge = Forge::new(seed);
    let roles = [Role::In, Role::Out, Role::Out, Role::Out, Role::Out];
    let m = router(&mut forge, &roles, 0);
    assert_eq!(
        forge.core.state.footprint_of(m),
        Some(Footprint { w: 2, h: 4, rot: 0 }),
        "measured: four Outs grow the Router to 2x4"
    );
    assert_eq!(live_doorstep(&forge.core, m, 0, BeltEnd::Head), (9, 11), "measured: In_0 faces (9,11)");
    for k in 0..4u16 {
        let y = 10 + OUT_ROWS[usize::from(k)];
        assert_eq!(live_doorstep(&forge.core, m, k, BeltEnd::Tail), (12, y), "measured: Out_{k} faces (12, {y})");
    }
    let feeder = belt_arriving(&mut forge, (9, 11), Side::W);
    let o0 = belt_leaving(&mut forge, (12, 11), Side::E);
    let o1 = belt_leaving(&mut forge, (12, 12), Side::E);
    let o2 = belt_leaving(&mut forge, (12, 10), Side::E);
    let o3 = belt_leaving(&mut forge, (12, 13), Side::S);
    dock(&mut forge, m, 0, feeder, BeltEnd::Head);
    for (k, b) in [o0, o1, o2, o3].into_iter().enumerate() {
        dock(&mut forge, m, k as PortId, b, BeltEnd::Tail);
    }
    assert_eq!(machine_docks(&forge.core, m).len(), 5, "five docks before the edit");
    TwoByFour {
        forge,
        m,
        feeder,
        outs: [o0, o1, o2, o3],
    }
}

/// Pin 1. RemovePort `Out_0` (catalog 1). RE-AUTHORED IN 74.1-16 (was
/// `removing_out_0_of_a_2x4_router_releases_every_out_whose_port_moved`): until 74.1-16
/// the box floored to 2x3 and every later Out moved into the previous slot, so all four
/// Out belts were released. MEASURED now: the list becomes `[In, Out, Out, Out]`, the box
/// STAYS 2x4 and the survivors keep their slots, so their facing cells are still (12,12),
/// (12,10), (12,13), re-keyed by identity 1 -> 0, 2 -> 1, 3 -> 2. Only the removed port's
/// own belt is released, with its PRE-edit key 0. The In is kept.
///
/// RED at 74.1-16's start revision (four released).
#[test]
fn removing_out_0_of_a_2x4_router_releases_only_its_own_belt() {
    let TwoByFour { mut forge, m, feeder, outs } = two_by_four(0x7412_0001);
    forge.fold(EditOp::RemovePort { node: m, index: 1, restore: None });

    assert_eq!(
        forge.core.state.footprint_of(m),
        Some(Footprint { w: 2, h: 4, rot: 0 }),
        "measured: a removal never shrinks the box"
    );
    for k in 0..3u16 {
        let y = 10 + OUT_ROWS[usize::from(k) + 1];
        assert_eq!(
            live_doorstep(&forge.core, m, k, BeltEnd::Tail),
            (12, y),
            "measured: the surviving Out_{k} still faces (12, {y}), its old slot"
        );
    }
    let tail = end_byte(BeltEnd::Tail);
    assert_eq!(
        released(&forge.core, m),
        BTreeSet::from([(0, tail, outs[0])]),
        "only the removed port's own belt is released, with its PRE-edit key"
    );
    assert_eq!(
        machine_docks(&forge.core, m),
        BTreeSet::from([
            (0, end_byte(BeltEnd::Head), feeder),
            (0, tail, outs[1]),
            (1, tail, outs[2]),
            (2, tail, outs[3]),
        ]),
        "every survivor is re-keyed by identity and kept"
    );
    assert_every_dock_faces(&forge.core, m, "after RemovePort Out_0");
}

/// Pin 2. RemovePort `Out_3` (catalog 4), the LAST Out. MEASURED: the list becomes
/// `[In, Out, Out, Out]` and `Out_0..Out_2` keep their rows, so their facing cells are
/// still (12,11), (12,12), (12,10). Only the turning belt on the removed port is
/// released; every other key is unchanged. Since 74.1-16 the box also stays 2x4.
///
/// GREEN BEFORE 74.1-12 by design: it is the pin a release-every-survivor boundary
/// reddens, and identity-keep does not.
#[test]
fn removing_the_last_out_releases_only_its_belt() {
    let TwoByFour { mut forge, m, feeder, outs } = two_by_four(0x7412_0002);
    forge.fold(EditOp::RemovePort { node: m, index: 4, restore: None });

    let tail = end_byte(BeltEnd::Tail);
    assert_eq!(
        released(&forge.core, m),
        BTreeSet::from([(3, tail, outs[3])]),
        "exactly the belt on the removed last Out is released"
    );
    assert_eq!(
        machine_docks(&forge.core, m),
        BTreeSet::from([
            (0, end_byte(BeltEnd::Head), feeder),
            (0, tail, outs[0]),
            (1, tail, outs[1]),
            (2, tail, outs[2]),
        ]),
        "every belt whose port did not move keeps its dock and its key"
    );
    assert_eq!(
        forge.core.state.footprint_of(m),
        Some(Footprint { w: 2, h: 4, rot: 0 }),
        "and the box does not shrink (74.1-16)"
    );
    assert_every_dock_faces(&forge.core, m, "after RemovePort of the last Out");
}

/// Pin 3. RE-AUTHORED IN 74.1-16 (was `an_add_port_that_moves_the_fault_nub_releases_the_fault_dock`).
/// MEASURED board: a Router `[In, Out, Fault, Fault]` at (10,10): 2x3, `In` (0,1) W,
/// `Out` (1,1) E, `Fault_0` (0,2) S, `Fault_1` (1,2) S. Turned half way (rot 2, local
/// (x,y) -> (w-1-x, h-1-y), side + 2): the Out sits at world (10,11) facing W, facing cell
/// (9,11); `Fault_0` at (11,10) facing N, facing cell (11,9). A belt leaves (9,11) west on
/// the Out (key 0), another leaves (11,9) north on the first Fault (`FAULT_PORT`).
///
/// AddPort a third Fault, appended. It takes the first free Fault slot, 2, which widens
/// the box to 3x3. Until 74.1-16 the box grew with its anchor fixed, so at rot 2 every nub
/// with a local x moved one cell east and the FAULT belt was released while the Out was
/// kept. Since 74.1-16 the box grows on its rot-0 east edge, which the half turn puts at
/// world WEST, so the anchor moves to (9,10): the Faults keep their world cells and the
/// fault belt is kept, and the Out column (local x = w - 1, world column 0 of the box)
/// moves one cell west, onto (9,11), the cell its belt's Tail holds. So the grown box
/// covers a belt tile, which is why the command layer refuses this add. What this file
/// asserts below is that GEOMETRY (the grown box covers (9,11)), not the refusal: this is
/// a core test and folds the record verbatim, as a forged log would, which releases the
/// Out's belt under its pre-edit key. The refusal itself is pinned in the command layer by
/// `crates/fabrico-command/tests/fault_add_covers_belt.rs`, on this exact board built through
/// `GridSession::apply`: the Fault add is `Err(GrowCoversBelt)` with nothing logged.
/// CORRECTED IN PLACE by plan 74.1-32 (review round 4 IN-03): from plan 74.1-23 this cited
/// `add_output_golden.rs` and `reseat_undo_redock.rs`, which send only "+ Add output", an Out
/// add growing the box taller, and both stayed green with the command arm's collision walk
/// narrowed to Out adds (measured in a throwaway worktree), while the new test went red.
#[test]
fn a_widening_add_keeps_the_fault_nub_and_moves_the_out_column_onto_its_belt() {
    let mut forge = Forge::new(0x7412_0003);
    let m = router(&mut forge, &[Role::In, Role::Out, Role::Fault, Role::Fault], 2);
    assert_eq!(
        forge.core.state.footprint_of(m),
        Some(Footprint { w: 2, h: 3, rot: 2 }),
        "measured: a half-turned 2x3"
    );
    assert_eq!(live_doorstep(&forge.core, m, 0, BeltEnd::Tail), (9, 11), "measured: the Out faces (9,11)");
    assert_eq!(
        live_doorstep(&forge.core, m, FAULT_PORT, BeltEnd::Tail),
        (11, 9),
        "measured: the first Fault faces (11,9)"
    );
    let out_belt = belt_leaving(&mut forge, (9, 11), Side::W);
    let fault_belt = belt_leaving(&mut forge, (11, 9), Side::N);
    dock(&mut forge, m, 0, out_belt, BeltEnd::Tail);
    dock(&mut forge, m, FAULT_PORT, fault_belt, BeltEnd::Tail);

    forge.fold(EditOp::AddPort {
        node: m,
        port: mech(Role::Fault),
        index: 4,
        seat: PortSeat::Auto,
    });

    assert_eq!(
        forge.core.state.footprint_of(m),
        Some(Footprint { w: 3, h: 3, rot: 2 }),
        "measured: a third Fault widens the box to 3x3"
    );
    assert_eq!(forge.core.state.cell_of(m), Some((9, 10)), "measured: the anchor moves one cell west");
    assert_eq!(
        live_doorstep(&forge.core, m, FAULT_PORT, BeltEnd::Tail),
        (11, 9),
        "measured: the first Fault did not move"
    );
    assert!(
        cells_of_footprint((9, 10), 3, 3, 2).any(|c| c == (9, 11)),
        "the grown box covers the Out belt's Tail at (9,11), the geometry the command layer's refusal rests on"
    );
    let tail = end_byte(BeltEnd::Tail);
    assert_eq!(
        released(&forge.core, m),
        BTreeSet::from([(0, tail, out_belt)]),
        "folded verbatim, the Out dock whose nub moved is released, under its pre-edit key"
    );
    assert_eq!(
        machine_docks(&forge.core, m),
        BTreeSet::from([(FAULT_PORT, tail, fault_belt)]),
        "the Fault, which did not move, keeps its dock"
    );
    assert_every_dock_faces(&forge.core, m, "after the widening AddPort");
}

/// Pin 4. MEASURED board: a Router `[In, Out, Out, Fault]` at (10,10), rot 0, 2x3.
/// Re-seated: `In_0` (0,1) W facing (9,11); `Out_0` (1,1) E facing (12,11); `Out_1` (1,2)
/// E facing (12,12); `Fault_0` (0,2) S facing (10,13). A belt on each.
///
/// AddPort an Out, appended at catalog 4. Its first free slot is row 0 (rows 1 and 2 are
/// taken), so the box stays 2x3 and the new `Out_2` takes local (1,0); no existing nub
/// moves, and the new Out's routing key 2 is above every docked key, so no key moves
/// either. Nothing is released and the links map is byte-identical.
///
/// GREEN BEFORE 74.1-12 by design: the release-every-survivor boundary reddens it.
#[test]
fn an_add_port_that_moves_nothing_releases_nothing() {
    let mut forge = Forge::new(0x7412_0004);
    let m = router(&mut forge, &[Role::In, Role::Out, Role::Out, Role::Fault], 0);
    assert_eq!(live_doorstep(&forge.core, m, 0, BeltEnd::Head), (9, 11), "measured");
    assert_eq!(live_doorstep(&forge.core, m, 0, BeltEnd::Tail), (12, 11), "measured");
    assert_eq!(live_doorstep(&forge.core, m, 1, BeltEnd::Tail), (12, 12), "measured");
    assert_eq!(live_doorstep(&forge.core, m, FAULT_PORT, BeltEnd::Tail), (10, 13), "measured");
    let feeder = belt_arriving(&mut forge, (9, 11), Side::W);
    let o0 = belt_leaving(&mut forge, (12, 11), Side::E);
    let o1 = belt_leaving(&mut forge, (12, 12), Side::E);
    let fault = belt_leaving(&mut forge, (10, 13), Side::S);
    dock(&mut forge, m, 0, feeder, BeltEnd::Head);
    dock(&mut forge, m, 0, o0, BeltEnd::Tail);
    dock(&mut forge, m, 1, o1, BeltEnd::Tail);
    dock(&mut forge, m, FAULT_PORT, fault, BeltEnd::Tail);
    let before = machine_docks(&forge.core, m);
    let links_before: Vec<_> = forge.core.state.links_iter().collect();

    forge.fold(EditOp::AddPort {
        node: m,
        port: mech(Role::Out),
        index: 4,
        seat: PortSeat::Auto,
    });

    assert_eq!(
        forge.core.state.footprint_of(m),
        Some(Footprint { w: 2, h: 3, rot: 0 }),
        "measured: the box does not grow"
    );
    assert!(released(&forge.core, m).is_empty(), "an AddPort that moves no nub releases nothing");
    assert_eq!(machine_docks(&forge.core, m), before, "every dock is kept under its own key");
    assert_eq!(
        forge.core.state.links_iter().collect::<Vec<_>>(),
        links_before,
        "and the links map is identical"
    );
    assert_every_dock_faces(&forge.core, m, "after the AddPort that moves nothing");
}

// ---------------------------------------------------------------------------
// Pin 5: the sweep.
// ---------------------------------------------------------------------------

/// One port edit the sweep folds.
#[derive(Clone, Copy, Debug)]
enum Edit {
    Remove(usize),
    Add(usize, Role),
}

impl Edit {
    /// The port list the edit should produce.
    fn apply(self, roles: &[Role]) -> Vec<Role> {
        let mut out = roles.to_vec();
        match self {
            Edit::Remove(i) => {
                out.remove(i);
            }
            Edit::Add(i, role) => out.insert(i, role),
        }
        out
    }

    /// Where catalog index `old` lands after the edit, or `None` for the removed port.
    fn new_index(self, old: usize) -> Option<usize> {
        match self {
            Edit::Remove(i) if old == i => None,
            Edit::Remove(i) if old > i => Some(old - 1),
            Edit::Remove(_) => Some(old),
            Edit::Add(i, _) if old >= i => Some(old + 1),
            Edit::Add(..) => Some(old),
        }
    }

    fn op(self, node: NodeId) -> EditOp {
        match self {
            Edit::Remove(i) => EditOp::RemovePort {
                node,
                index: i as PortId,
                restore: None,
            },
            Edit::Add(i, role) => EditOp::AddPort {
                node,
                port: mech(role),
                index: i as PortId,
                seat: PortSeat::Auto,
            },
        }
    }
}

/// The link key a dock on catalog index `idx` of `roles` carries at `end`, the forward
/// translation `command.rs`'s `dock_link_key` performs.
fn key_for_index(roles: &[Role], idx: usize, end: BeltEnd) -> PortId {
    match (end, roles[idx]) {
        (BeltEnd::Tail, Role::Fault) => FAULT_PORT,
        (BeltEnd::Tail, _) => roles[..idx].iter().filter(|r| **r == Role::Out).count() as PortId,
        (BeltEnd::Head, _) => idx as PortId,
    }
}

/// What the edit should do to the dock `(key, end)`: `Some(new key)` when the dock
/// survives the IDENTITY re-key, `None` when identity releases it. This is the
/// pre-74.1-12 rule; it is written out so the facing half can be layered on.
///
/// `FAULT_PORT` names the FIRST Fault, so it is released iff the removed port WAS that
/// first Fault (74.1-16; until then any removed Fault released it, which released the
/// first Fault's belt when the second one was removed), and otherwise keeps its key.
fn identity_key(roles: &[Role], edit: Edit, key: PortId, end: BeltEnd) -> Option<(PortId, usize)> {
    let after = edit.apply(roles);
    if key == FAULT_PORT {
        if let Edit::Remove(i) = edit
            && roles.iter().position(|r| *r == Role::Fault) == Some(i)
        {
            return None;
        }
        let idx = after.iter().position(|r| *r == Role::Fault)?;
        return Some((FAULT_PORT, idx));
    }
    let ports: Vec<Port> = roles.iter().map(|r| mech(*r)).collect();
    let old = port_index_for_key(&ports, key, end)?;
    let new = edit.new_index(old)?;
    Some((key_for_index(&after, new, end), new))
}

/// The slot a port holds along its edge: its row for an In or an Out, its column for a
/// Fault.
fn slot(p: &Port) -> i32 {
    match p.role {
        Role::In | Role::Out => p.local_offset.1,
        Role::Fault => p.local_offset.0,
    }
}

/// THIS FILE'S OWN STATEMENT OF THE 74.1-16 GEOMETRY, written from the rule's sentence and
/// not from the fold: where the machine's anchor, box and ports are after `edit`, from
/// `(anchor, fp, ports)` before it.
///
/// - A removal drops the port and moves NOTHING: same anchor, same box, same slots.
/// - An add seats the new port on the first free slot of its role, walking `role_slot(k,
///   B)` for k = 0, 1, ... with B the catalog side (`ROUTER_BASE.h` for In/Out,
///   `ROUTER_BASE.w` for Fault); keeps every other slot; grows the box only as far as the
///   slots need (height to the highest In/Out slot + 1, width to one column per In/Out
///   role present and the highest Fault slot + 1, never below the current box); puts every
///   port on its role's edge (In column 0 facing W, Out column w-1 facing E, Fault row h-1
///   facing S); and shifts the anchor by the growth per the turn: rot 0 (0,0), rot 1
///   (-dh,0), rot 2 (-dw,-dh), rot 3 (0,-dw).
fn expected_after(
    anchor: (i32, i32),
    fp: Footprint,
    ports: &[Port],
    edit: Edit,
) -> ((i32, i32), Footprint, Vec<Port>) {
    match edit {
        Edit::Remove(i) => {
            let mut out = ports.to_vec();
            out.remove(i);
            (anchor, fp, out)
        }
        Edit::Add(i, role) => {
            let side_len = if role == Role::Fault { ROUTER_BASE.w } else { ROUTER_BASE.h };
            let taken: BTreeSet<i32> = ports.iter().filter(|p| p.role == role).map(slot).collect();
            let mut k = 0;
            while taken.contains(&role_slot(k, side_len)) {
                k += 1;
            }
            let new_slot = role_slot(k, side_len);
            let mut list = ports.to_vec();
            let fresh = match role {
                Role::Fault => Port { local_offset: (new_slot, 0), ..mech(role) },
                _ => Port { local_offset: (0, new_slot), ..mech(role) },
            };
            list.insert(i, fresh);
            let mut need_h = 1;
            let mut need_fault_w = 1;
            let has_in = list.iter().any(|p| p.role == Role::In);
            let has_out = list.iter().any(|p| p.role == Role::Out);
            for p in &list {
                if p.role == Role::Fault {
                    need_fault_w = need_fault_w.max(slot(p) + 1);
                } else {
                    need_h = need_h.max(slot(p) + 1);
                }
            }
            let need_w = (i32::from(has_in) + i32::from(has_out)).max(need_fault_w);
            let w = i32::from(fp.w).max(need_w);
            let h = i32::from(fp.h).max(need_h);
            let (dw, dh) = (w - i32::from(fp.w), h - i32::from(fp.h));
            let shift = match fp.rot & 3 {
                0 => (0, 0),
                1 => (-dh, 0),
                2 => (-dw, -dh),
                _ => (0, -dw),
            };
            let edged: Vec<Port> = list
                .into_iter()
                .map(|p| {
                    let s = slot(&p);
                    let (local_offset, side) = match p.role {
                        Role::In => ((0, s), Side::W),
                        Role::Out => ((w - 1, s), Side::E),
                        Role::Fault => ((s, h - 1), Side::S),
                    };
                    Port { local_offset, side, ..p }
                })
                .collect();
            let fp1 = Footprint { w: w as u16, h: h as u16, rot: fp.rot };
            ((anchor.0 + shift.0, anchor.1 + shift.1), fp1, edged)
        }
    }
}

/// The port lists the sweep places: every count of 1..=2 Ins, 1..=4 Outs and 0..=2
/// Faults, in two orders (Faults last, and Faults between the Ins and the Outs, the
/// shape an `AddPort` appended after a catalog Fault leaves).
fn swept_lists() -> Vec<Vec<Role>> {
    let mut lists = Vec::new();
    for n_in in 1..=2 {
        for n_out in 1..=4 {
            for n_fault in 0..=2 {
                let ins = vec![Role::In; n_in];
                let outs = vec![Role::Out; n_out];
                let faults = vec![Role::Fault; n_fault];
                lists.push([ins.clone(), outs.clone(), faults.clone()].concat());
                if n_fault > 0 {
                    lists.push([ins, faults, outs].concat());
                }
            }
        }
    }
    lists
}

/// Pin 5, THE SWEEP, RE-AUTHORED IN 74.1-16 on the no-move rule. For every swept list,
/// every rotation, a belt docked on every In and every Out and on the first Fault, each
/// leaving or arriving straight through its port's facing cell, then every single
/// `RemovePort` and every `AddPort` (seat `Auto`) of each role at each index, one at a time
/// on a fresh copy of the board:
///
/// - the fold writes exactly the anchor, box and ports [`expected_after`] states;
/// - the expected verdict is IDENTITY THEN GEOMETRY: a dock is kept iff it survives the
///   identity re-key AND its port's facing cell after the edit is the facing cell it had
///   before; the folded links naming the machine equal exactly the expected kept set under
///   the new keys, and `last_tick.unlinked` equals exactly the expected released set under
///   the PRE-edit keys;
/// - every remaining belt link's port faces its belt end, read off the live core;
/// - 74.1-16's two claims, asserted per edit: an accepted RemovePort releases exactly the
///   removed port's own docks (no release by facing) and moves no surviving port's world
///   cell; an accepted APPEND (the only add a command writes) releases nothing and moves
///   no In or Out world cell.
///
/// An add whose grown box, at its shifted anchor, would cover a belt tile is skipped,
/// because the command layer refuses that `AddPort`; the counts below are asserted so the
/// skip cannot swallow the sweep. An add at a middle index with seat `Auto` is a record
/// no command writes (the forward gesture appends, the inverse seats `Captured`); it is
/// swept for the facing claim only.
#[test]
fn every_kept_belt_link_faces_its_port_after_any_single_port_edit() {
    let mut cases = 0usize;
    let mut skipped = 0usize;
    let mut kept_total = 0usize;
    let mut released_by_facing = 0usize;
    let mut released_by_identity = 0usize;
    let mut appends = 0usize;
    let mut removals = 0usize;

    for roles in swept_lists() {
        for rot in 0..4u8 {
            // The board: the machine, then one belt per dockable port.
            let mut board = Forge::new(0x7412_0005);
            let m = router(&mut board, &roles, rot);
            let (fp0, ports0) = seated(&roles);
            let fp0 = Footprint { rot, ..fp0 };
            let mut docks: Vec<(PortId, BeltEnd, NodeId, (i32, i32))> = Vec::new();
            let mut belt_cells: Vec<(i32, i32)> = Vec::new();
            let first_fault = roles.iter().position(|r| *r == Role::Fault);
            for (idx, port) in ports0.iter().enumerate() {
                let (pcell, side) = port_world(ANCHOR, fp0.w, fp0.h, fp0.rot, port);
                let door = step(pcell, side);
                let (end, belt) = match port.role {
                    Role::In => (BeltEnd::Head, belt_arriving(&mut board, door, side)),
                    Role::Out => (BeltEnd::Tail, belt_leaving(&mut board, door, side)),
                    Role::Fault if Some(idx) == first_fault => {
                        (BeltEnd::Tail, belt_leaving(&mut board, door, side))
                    }
                    Role::Fault => continue,
                };
                let key = key_for_index(&roles, idx, end);
                dock(&mut board, m, key, belt, end);
                docks.push((key, end, belt, door));
                belt_cells.push(door);
                belt_cells.push(step(door, side));
            }
            assert_eq!(machine_docks(&board.core, m).len(), docks.len(), "every dock landed");

            let mut edits: Vec<Edit> = (0..roles.len()).map(Edit::Remove).collect();
            for i in 0..=roles.len() {
                for role in [Role::In, Role::Out, Role::Fault] {
                    edits.push(Edit::Add(i, role));
                }
            }

            for edit in edits {
                let (anchor1, fp1, ports1) = expected_after(ANCHOR, fp0, &ports0, edit);
                if matches!(edit, Edit::Add(..))
                    && cells_of_footprint(anchor1, fp1.w, fp1.h, rot).any(|c| belt_cells.contains(&c))
                {
                    skipped += 1;
                    continue;
                }
                cases += 1;

                let mut expected_kept: BTreeSet<Dock> = BTreeSet::new();
                let mut expected_released: BTreeSet<Dock> = BTreeSet::new();
                let mut facing_releases_here = 0usize;
                for &(key, end, belt, door) in &docks {
                    match identity_key(&roles, edit, key, end) {
                        Some((new_key, new_idx)) if facing_cell(anchor1, fp1, &ports1[new_idx]) == door => {
                            expected_kept.insert((new_key, end_byte(end), belt));
                        }
                        Some(_) => {
                            released_by_facing += 1;
                            facing_releases_here += 1;
                            expected_released.insert((key, end_byte(end), belt));
                        }
                        None => {
                            released_by_identity += 1;
                            expected_released.insert((key, end_byte(end), belt));
                        }
                    }
                }
                kept_total += expected_kept.len();

                let mut forge = board.clone();
                forge.fold(edit.op(m));
                let ctx = format!("{roles:?} rot {rot} {edit:?}");
                assert_eq!(
                    forge.core.state.ports_of(m).map(<[Port]>::to_vec),
                    Some(ports1.clone()),
                    "{ctx}: the fold writes the ports the rule states"
                );
                assert_eq!(forge.core.state.footprint_of(m), Some(fp1), "{ctx}: and the box");
                assert_eq!(forge.core.state.cell_of(m), Some(anchor1), "{ctx}: and the anchor");
                assert_eq!(machine_docks(&forge.core, m), expected_kept, "{ctx}: kept docks");
                assert_eq!(released(&forge.core, m), expected_released, "{ctx}: released docks");
                assert_every_dock_faces(&forge.core, m, &ctx);

                // 74.1-16's two claims, each on the edits a command can write.
                let world = |a: (i32, i32), f: Footprint, p: &Port| port_world(a, f.w, f.h, f.rot, p).0;
                match edit {
                    Edit::Remove(i) => {
                        removals += 1;
                        assert_eq!(facing_releases_here, 0, "{ctx}: a removal releases only by identity");
                        for (old, p) in ports0.iter().enumerate().filter(|(old, _)| *old != i) {
                            let new = if old > i { old - 1 } else { old };
                            assert_eq!(
                                world(anchor1, fp1, &ports1[new]),
                                world(ANCHOR, fp0, p),
                                "{ctx}: a removal moves no surviving port"
                            );
                        }
                    }
                    Edit::Add(i, _) if i == roles.len() => {
                        appends += 1;
                        assert!(expected_released.is_empty(), "{ctx}: an accepted append releases nothing");
                        for (old, p) in ports0.iter().enumerate().filter(|(_, p)| p.role != Role::Fault) {
                            assert_eq!(
                                world(anchor1, fp1, &ports1[old]),
                                world(ANCHOR, fp0, p),
                                "{ctx}: an append moves no In or Out"
                            );
                        }
                    }
                    Edit::Add(..) => {}
                }
            }
        }
    }

    // MEASURED and pinned, so a later skip or a shrunken list cannot quietly empty the
    // sweep. History: plan 74.1-12 measured 3,120 folded edits and 688 skips; 74.1-14
    // re-measured (3120, 688, 11952, 2816, 832) on the centre-out re-seat, through a
    // Python replica of the oracle that reproduced both its own tuple and 74.1-12's.
    //
    // RE-MEASURED IN 74.1-16 on the no-move rule (every per-edit assertion above green),
    // and REPRODUCED by an independent Python replica of this oracle that ALSO reproduces
    // 74.1-14's tuple under the old rule before its breakdown is trusted (74.1-16-SUMMARY.md
    // carries the breakdown). The tuple and the append and removal counts are below.
    assert_eq!(
        (cases, skipped, kept_total, released_by_facing, released_by_identity, appends, removals),
        MEASURED_SWEEP,
        "the sweep's measured size"
    );
}

/// The sweep's measured `(cases, skipped, kept, released by facing, released by identity,
/// appends folded, removals folded)`, 74.1-16.
///
/// The breakdown, from the replica: all 240 facing releases are middle-index `Auto` Fault
/// inserts BEFORE the first Fault (the `FAULT_PORT` sentinel then names the new Fault, on
/// another cell), a record no command writes; every one of the 768 identity releases is a
/// removal's own dock; the 928 skips are 128 APPENDS the command layer refuses (64 Out
/// appends that grow the box taller, moving the Fault onto its belt's end tile, and 64
/// Fault appends that widen it, moving the Out column onto its belts' end tiles) and 800
/// middle-index inserts. Under 74.1-14's rule the same replica gives
/// (3120, 688, 11952, 2816, 832), the tuple this pin carried before.
const MEASURED_SWEEP: (usize, usize, usize, usize, usize, usize, usize) =
    (2880, 928, 13136, 240, 768, 352, 832);
