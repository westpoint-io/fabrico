//! CORNER-06 (phase 74.1, D-02): the facing clause of `GridState::dock_still_reaches`,
//! pinned as GEOMETRY.
//!
//! `rotate_footprint` re-judges every belt dock of a rotated machine through
//! `dock_still_reaches`, and nothing in the edit log carries the verdict
//! (`EditOp::Rotate`'s byte shape never changed). Phase 74.1 narrowed that predicate's
//! facing clause to the one the command layer's `Dock` arm uses: a multi-tile belt is
//! refused on facing ONLY when its outward side EQUALS the port's side, which is the one
//! geometry where the belt's inner tile sits on the port's own cell. Because the verdict
//! is derived on every replay, the narrowing changes what a replay of an existing log
//! produces, and this file pins exactly where:
//!
//!   1. **A legal dock survives a quarter turn exactly when the port's facing cell is
//!      unchanged.** Every footprint, every perimeter port as Out and as In, every
//!      starting rotation, one quarter turn either way, every belt the command layer
//!      would have accepted at the starting rotation (single-tile, and multi-tile with
//!      any outward side but the port's own), skipping belts the new footprint would
//!      cover (the command layer refuses that Rotate). The assertion is
//!      `kept == (facing cell after == facing cell before)`. The densely folded range
//!      is 1x1 to 7x7; the full range up to `MAX_FOOTPRINT_DIM` is enumerated by
//!      geometry and every case whose facing cell survives is folded too.
//!   2. **A carrier turning back into its port is released** (D-13). A forged belt whose
//!      inner tile sits on the machine's own cell is the one shape the narrowed clause
//!      still refuses; a same-rotation re-judge releases it.
//!   3. **A 2x5 Router's middle-Out dock survives one quarter turn** (`Out_1` since the
//!      74.1-14 centre-out reseat, `Out_2` before it), the readable instance
//!      of claim 1 on a shape the game ships.
//!
//! # The divergence, in closed form
//! A quarter turn about the fixed anchor keeps a port's facing cell only when the
//! footprint is `w x h` with `h = 2w + 1` and the port sits at local row `w` on the E or
//! W column, or `w = 2h + 1` and the port sits at local column `h` on the N or S row,
//! each in one turn direction from two of the four starting rotations. For such a dock
//! made legal under the OLD clause (belt outward OPPOSITE the port side), the port's side
//! turns a quarter and the belt's outward becomes PERPENDICULAR to it: the old clause
//! released it, the narrowed clause keeps it. Up to 7x7 that is 1x3, 2x5, 3x7 and their
//! transposes, four cases each, Out and In: 48. `MAX_FOOTPRINT_DIM` is 64, so the full
//! set a replayed log can hold is the 31 shapes `w x (2w + 1)` for `w` in 1..=31 and
//! their transposes: 62 shapes, four cases each, Out and In: 496. Zero on half turns.
//!
//! # Why the boundary is asserted as geometry
//! A pin that restates the predicate (`kept == (outward != port side)`) passes for
//! whatever predicate the fold carries, which is how round 4 of the corner design
//! declared the wrong boundary with a test that passed either way. Claim 1 instead
//! derives the expected verdict from where the port's facing cell lands, through
//! `port_world` alone, and claim 2 pins the one refusal geometry cannot predict. Each
//! wrong boundary reddens at least one of the three tests: the old clause reddens 1 and
//! 3, no facing clause reddens 2, a perpendicular-only clause reddens all three. The
//! table and the golden-move declaration were recorded with plan 74.1-03.
//!
//! Run target: `cargo test -p fabrico-core --test dock_facing_rotate`.
//! `BTreeSet`/`Vec` only, no `HashSet` or `HashMap` iteration.

use fabrico_core::core::Core;
use fabrico_core::edit::{BeltEnd, EDIT_SCHEMA_VERSION, EditOp, EditRecord};
use fabrico_core::event::{LogHeader, SCHEMA_VERSION};
use fabrico_core::ids::NodeId;
use fabrico_core::state::{
    cells_of_footprint, opposite, port_world, reseat_ports, unit_delta, Axis, BeltTile, Footprint,
    Medium, Node, Port, Role, Side, TileKind, MAX_FOOTPRINT_DIM,
};
use std::collections::BTreeSet;

/// The machine kind byte `fold_place` mints a `Node::Router` from. Restated locally, as
/// `footprint_rotation.rs` does: `machine_kind` is crate-private.
const KIND_ROUTER: u8 = 5;

/// Every machine in the sweep is anchored here; the anchor is fixed across rotation.
const ANCHOR: (i32, i32) = (0, 0);

/// The genesis seed for every core in this file.
const SEED: u64 = 0x0074_1003_D0CC;

/// The densely folded range of claim 1: every footprint `1..=DENSE_DIM` on both axes.
const DENSE_DIM: u16 = 7;

/// THE DECLARED DIVERGENCE COUNT inside the dense range: multi-tile docks whose outward
/// was OPPOSITE the port side at the starting rotation (the docks the pre-74.1 clause
/// itself validated) that one quarter turn KEEPS. Phase 74.1's research measured 48 up to
/// 7x7; declared as a golden move in plan 74.1-03.
const KEEPS_UP_TO_7X7: usize = 48;

/// THE DECLARED DIVERGENCE COUNT over every footprint a replayed log can hold
/// (`1..=MAX_FOOTPRINT_DIM` on both axes): the same closed form, 62 shapes, four cases
/// each, Out and In. Declared as a golden move in plan 74.1-03.
const DECLARED_DIVERGENCE_KEEPS: usize = 496;

const SIDES: [Side; 4] = [Side::N, Side::E, Side::S, Side::W];

/// Wrap `op` in the edit record shape a decoded log hands the fold.
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

fn genesis() -> Core {
    Core::genesis(LogHeader { schema_version: SCHEMA_VERSION, seed: SEED })
}

fn step(cell: (i32, i32), side: Side) -> (i32, i32) {
    let (dx, dy) = unit_delta(side);
    (cell.0 + dx, cell.1 + dy)
}

fn back(cell: (i32, i32), side: Side) -> (i32, i32) {
    let (dx, dy) = unit_delta(side);
    (cell.0 - dx, cell.1 - dy)
}

/// The cell a port FACES after `rot` quarter turns: its world cell stepped once toward
/// its world side. Derived through `port_world` only, never through the dock predicate.
fn facing_cell(w: u16, h: u16, rot: u8, port: &Port) -> ((i32, i32), Side) {
    let (cell, side) = port_world(ANCHOR, w, h, rot, port);
    (step(cell, side), side)
}

/// Every perimeter port of a `w x h` box in its rot-0 frame: each edge cell once per
/// edge it lies on, facing out of that edge.
fn perimeter_ports(w: u16, h: u16) -> Vec<((i32, i32), Side)> {
    let (wi, hi) = (i32::from(w), i32::from(h));
    let mut out = Vec::new();
    for x in 0..wi {
        out.push(((x, 0), Side::N));
        out.push(((x, hi - 1), Side::S));
    }
    for y in 0..hi {
        out.push(((0, y), Side::W));
        out.push(((wi - 1, y), Side::E));
    }
    out
}

fn port(local_offset: (i32, i32), side: Side, role: Role) -> Port {
    Port { local_offset, side, role, medium: Medium::Mechanical }
}

/// A belt's two-tile geometry. The kind does not decide a dock (only cells do); it is
/// the straight run along the step so the board is one the router could have drawn.
fn tile(cell: (i32, i32), along: Side) -> BeltTile {
    let axis = if matches!(along, Side::E | Side::W) { Axis::X } else { Axis::Y };
    BeltTile::new(cell, TileKind::Straight { axis })
}

/// The dock endpoint a port role takes: an Out offloads onto a belt's TAIL, an In loads
/// from a belt's HEAD.
fn endpoint_for(role: Role) -> BeltEnd {
    if role == Role::Out { BeltEnd::Tail } else { BeltEnd::Head }
}

/// Every belt the command layer accepts docked at a port whose facing cell is `facing`
/// and whose side is `pside`: a single tile on the facing cell, and a two-tile belt whose
/// end is the facing cell and whose outward is any side but `pside`. Returned with the
/// outward side (`None` for the single tile). The END is the belt's FIRST tile for a
/// Tail dock and its LAST tile for a Head dock, so outward is `end - inner` either way.
fn legal_belts(
    facing: (i32, i32),
    pside: Side,
    endpoint: BeltEnd,
) -> Vec<(Vec<BeltTile>, Option<Side>)> {
    let mut out = vec![(vec![tile(facing, pside)], None)];
    for o in SIDES {
        if o == pside {
            continue; // the carrier's inner tile would be the port's own cell
        }
        let inner = back(facing, o);
        let tiles = match endpoint {
            BeltEnd::Tail => vec![tile(facing, o), tile(inner, o)],
            BeltEnd::Head => vec![tile(inner, o), tile(facing, o)],
        };
        out.push((tiles, Some(o)));
    }
    out
}

/// A fresh core holding ONE `w x h` router with the single port `p`, turned to `r0`
/// through the fold. Returns the core and the machine id.
fn placed(w: u16, h: u16, p: Port, r0: u8) -> (Core, NodeId) {
    let mut core = genesis();
    core.advance_edits(
        &[rec(
            1,
            core.tick,
            EditOp::Place { kind: KIND_ROUTER, cell_x: ANCHOR.0, cell_y: ANCHOR.1, w, h, ports: vec![p], rot: 0 },
        )],
        &[],
    );
    let m = *core.last_tick.placed.last().expect("the machine was minted");
    if r0 != 0 {
        core.advance_edits(&[rec(2, core.tick, EditOp::Rotate { node: m, new_rot: r0, old_rot: 0 })], &[]);
    }
    (core, m)
}

/// Is the dock between machine `m` (its port 0) and `belt` present, in the direction
/// `endpoint` writes it?
fn docked(core: &Core, m: NodeId, belt: NodeId, endpoint: BeltEnd) -> bool {
    match endpoint {
        BeltEnd::Tail => core.state.link_target((m, 0)) == Some((belt, 0)),
        BeltEnd::Head => core.state.link_target((belt, 0)) == Some((m, 0)),
    }
}

/// Draw `tiles`, dock them to port 0 of `m`, turn `m` from `r0` to `r1`, all through the
/// fold. Returns whether the dock survived and how many `UnlinkedDock`s the turn wrote.
fn dock_then_turn(
    base: &Core,
    m: NodeId,
    tiles: &[BeltTile],
    endpoint: BeltEnd,
    r0: u8,
    r1: u8,
) -> (bool, usize) {
    let mut core = base.clone();
    core.advance_edits(&[rec(3, core.tick, EditOp::DrawBelt { tiles: tiles.to_vec() })], &[]);
    let belt = *core.last_tick.placed.last().expect("the belt was minted");
    core.advance_edits(&[rec(4, core.tick, EditOp::Dock { belt, endpoint, node: m, port: 0 })], &[]);
    assert!(docked(&core, m, belt, endpoint), "the dock is in place before the turn");
    core.advance_edits(&[rec(5, core.tick, EditOp::Rotate { node: m, new_rot: r1, old_rot: r0 })], &[]);
    (docked(&core, m, belt, endpoint), core.last_tick.unlinked.len())
}

/// The closed form the module docblock states, in the rot-0 frame.
fn in_closed_form(w: u16, h: u16, local: (i32, i32), side: Side) -> bool {
    let (wi, hi) = (i32::from(w), i32::from(h));
    (hi == 2 * wi + 1 && local.1 == wi && matches!(side, Side::E | Side::W))
        || (wi == 2 * hi + 1 && local.0 == hi && matches!(side, Side::N | Side::S))
}

#[derive(Default)]
struct Tally {
    cases: usize,
    kept: usize,
    released: usize,
    /// Keeps among multi-tile docks whose outward was OPPOSITE the port side at `r0`.
    opposite_keeps: usize,
}

/// Fold every legal belt at `(w, h, local, side, role, r0 -> r1)` and assert the
/// geometric verdict for each, tallying into `t`.
fn sweep_case(
    t: &mut Tally,
    w: u16,
    h: u16,
    (local, side): ((i32, i32), Side),
    role: Role,
    r0: u8,
    r1: u8,
) {
    let p = port(local, side, role);
    let (f0, s0) = facing_cell(w, h, r0, &p);
    let (f1, _) = facing_cell(w, h, r1, &p);
    let expect_kept = f1 == f0;
    let body_before: BTreeSet<(i32, i32)> = cells_of_footprint(ANCHOR, w, h, r0).collect();
    let body_after: BTreeSet<(i32, i32)> = cells_of_footprint(ANCHOR, w, h, r1).collect();
    let endpoint = endpoint_for(role);
    let (base, m) = placed(w, h, p, r0);
    for (tiles, outward) in legal_belts(f0, s0, endpoint) {
        assert!(
            tiles.iter().all(|t| !body_before.contains(&t.cell)),
            "a belt legal at r0 lies off the body at r0 ({w}x{h} {local:?} {side:?} r{r0})"
        );
        if tiles.iter().any(|t| body_after.contains(&t.cell)) {
            continue; // the command layer refuses a Rotate onto a belt tile
        }
        let (kept, unlinked) = dock_then_turn(&base, m, &tiles, endpoint, r0, r1);
        assert_eq!(
            kept, expect_kept,
            "{w}x{h} port {local:?} {side:?} {role:?} r{r0}->r{r1} outward {outward:?}: the \
             dock must survive exactly when the facing cell is unchanged ({f0:?} -> {f1:?})"
        );
        assert_eq!(unlinked, usize::from(!kept), "one UnlinkedDock per release, none per keep");
        t.cases += 1;
        if kept {
            t.kept += 1;
            if outward == Some(opposite(s0)) {
                t.opposite_keeps += 1;
            }
        } else {
            t.released += 1;
        }
    }
}

/// Claim 1. See the module docblock.
#[test]
fn a_legal_dock_survives_a_quarter_turn_exactly_when_the_ports_facing_cell_is_unchanged() {
    // --- The dense fold: every case in 1x1..=7x7 is folded. ---
    let mut dense = Tally::default();
    for w in 1..=DENSE_DIM {
        for h in 1..=DENSE_DIM {
            for (local, side) in perimeter_ports(w, h) {
                for role in [Role::Out, Role::In] {
                    for r0 in 0u8..4 {
                        for r1 in [(r0 + 1) & 3, (r0 + 3) & 3] {
                            sweep_case(&mut dense, w, h, (local, side), role, r0, r1);
                        }
                    }
                }
            }
        }
    }
    assert!(dense.cases > 10_000, "the dense sweep checked {} cases", dense.cases);
    assert!(dense.kept > 0 && dense.released > 0, "both verdicts occur in the dense sweep");
    assert_eq!(
        dense.opposite_keeps, KEEPS_UP_TO_7X7,
        "the declared divergence up to 7x7: multi-tile docks the old clause validated that \
         one quarter turn keeps"
    );

    // --- The full range: enumerate every footprint a replayed log can hold by geometry,
    // and fold every case whose facing cell survives a turn in either direction (both
    // directions are folded, so the released side of each such port is folded too). ---
    let mut full = Tally::default();
    let mut shapes: BTreeSet<(u16, u16)> = BTreeSet::new();
    for w in 1..=MAX_FOOTPRINT_DIM {
        for h in 1..=MAX_FOOTPRINT_DIM {
            for (local, side) in perimeter_ports(w, h) {
                let probe = port(local, side, Role::Out);
                for r0 in 0u8..4 {
                    let turns = [(r0 + 1) & 3, (r0 + 3) & 3];
                    let f0 = facing_cell(w, h, r0, &probe).0;
                    let survives: Vec<bool> =
                        turns.iter().map(|&r1| facing_cell(w, h, r1, &probe).0 == f0).collect();
                    if !survives.contains(&true) {
                        continue;
                    }
                    assert!(
                        in_closed_form(w, h, local, side),
                        "{w}x{h} port {local:?} {side:?} r{r0}: a facing cell survives a quarter \
                         turn outside the declared closed form"
                    );
                    assert_eq!(
                        survives.iter().filter(|&&s| s).count(),
                        1,
                        "the facing cell survives in ONE turn direction only"
                    );
                    shapes.insert((w, h));
                    for role in [Role::Out, Role::In] {
                        for r1 in turns {
                            sweep_case(&mut full, w, h, (local, side), role, r0, r1);
                        }
                    }
                }
            }
        }
    }
    assert_eq!(shapes.len(), 62, "31 shapes w x (2w+1) up to MAX_FOOTPRINT_DIM, and their transposes");
    assert!(full.kept > 0 && full.released > 0, "both verdicts occur in the full-range folds");
    assert_eq!(
        full.opposite_keeps, DECLARED_DIVERGENCE_KEEPS,
        "the declared divergence over every footprint a replayed log can hold"
    );
}

/// Claim 2 (D-13). Forged through the public `GridState` API, because no command can
/// produce it: a 1x1 router at (5,5) with one Out facing E, and a belt `[(6,5), (5,5)]`
/// Tail-docked to it. The belt's end tile (6,5) is the port's facing cell, so adjacency
/// passes; its outward (end minus inner) is E, the port's own side, because its inner
/// tile is the machine's own cell. A same-rotation re-judge (rot 0 to rot 0) must
/// release it. The twin with the inner tile on the far side, `[(6,5), (7,5)]`, differs in
/// outward only and is kept, so the release is the facing clause's and nothing else's.
#[test]
fn a_carrier_turning_back_into_its_port_is_released() {
    let forge = |inner: (i32, i32)| {
        let mut core = genesis();
        let m = core.state.add_router(vec![], Some(0));
        core.state.claim_footprint(m, (5, 5), 1, 1, 0);
        core.state.set_ports(m, vec![port((0, 0), Side::E, Role::Out)]);
        let geom = vec![tile((6, 5), Side::E), tile(inner, Side::E)];
        let belt = core.state.add_belt(geom.len() as u32);
        if let Some(Node::Belt(b)) = core.state.node_mut(belt) {
            b.geometry = geom.clone();
        }
        core.state.claim_belt_tiles(belt, &geom);
        // Tail dock: the 0th Out offloads onto the belt => link((m,0) -> (belt,0)).
        core.state.link((m, 0), (belt, 0));
        core.advance_edits(&[rec(1, core.tick, EditOp::Rotate { node: m, new_rot: 0, old_rot: 0 })], &[]);
        (core, m, belt)
    };

    let (turned_back, m, belt) = forge((5, 5));
    assert_eq!(
        turned_back.state.link_target((m, 0)),
        None,
        "a carrier whose inner tile is the port's own cell is released"
    );
    assert_eq!(turned_back.last_tick.unlinked.len(), 1, "exactly one UnlinkedDock recorded");
    let ud = turned_back.last_tick.unlinked[0];
    assert_eq!((ud.belt, ud.endpoint, ud.node, ud.port), (belt, BeltEnd::Tail, m, 0));

    let (straight, m2, belt2) = forge((7, 5));
    assert_eq!(
        straight.state.link_target((m2, 0)),
        Some((belt2, 0)),
        "the same dock with the inner tile on the far side is kept"
    );
    assert!(straight.last_tick.unlinked.is_empty(), "and records nothing");
}

/// Claim 3: the shipped-reachable instance. A Router with one input and five outputs is
/// grown to 2x5 by `grow_to_fit`; `reseat_ports` seats the ports centre-out from the 2x3
/// Router catalog box (74.1-14), so `In_0` is at (0,1) facing W and the Outs are on rows
/// 1, 2, 0, 3, 4 of the E column: `Out_1` sits at local (1,2), the middle of the E column
/// of a `w x (2w + 1)` box. (Until 74.1-14 the index rule put `Out_2` there; this pin
/// docked routing key 2 and was titled for `Out_2`. The geometry is unchanged.)
///
/// Anchored at (10,10): at rot 0 the middle Out is world (11,12) facing E, so it faces
/// (12,12). Rot 1 maps local (x, y) to (h - 1 - y, x) = (5 - 1 - 2, 1) = (2,1), world
/// (12,11), and turns the side E to S, so it faces (12,12): the SAME cell. Rot 3 maps
/// (x, y) to (y, w - 1 - x) = (2,0), world (12,10), side N, facing (12,9): a different
/// cell. Both are asserted through `port_world` below rather than trusted from this
/// comment.
///
/// The belt `[(12,12), (13,12)]` is Tail-docked to the middle Out (routing key 1) with
/// outward W, opposite E, the geometry the pre-74.1 clause demanded. After the rot 1 turn
/// the port faces S and the belt's outward W is perpendicular: the old clause released it,
/// the narrowed clause keeps it. The rot 3 turn releases it under either clause
/// (adjacency).
#[test]
fn a_2x5_routers_middle_out_dock_survives_one_quarter_turn() {
    const A: (i32, i32) = (10, 10);
    let mut seed_ports = vec![port((0, 0), Side::W, Role::In)];
    seed_ports.extend((0..5).map(|_| port((0, 0), Side::E, Role::Out)));
    let ports = reseat_ports(Footprint { w: 2, h: 3, rot: 0 }, 2, 5, &seed_ports);
    let out_2 = ports[2];
    assert_eq!((out_2.local_offset, out_2.side, out_2.role), ((1, 2), Side::E, Role::Out));

    let face = |rot: u8| {
        let (cell, side) = port_world(A, 2, 5, rot, &out_2);
        step(cell, side)
    };
    assert_eq!(face(0), (12, 12));
    assert_eq!(face(1), (12, 12), "one CW quarter turn keeps the middle Out's facing cell");
    assert_ne!(face(3), (12, 12), "the other quarter turn moves it");

    let belt_tiles = vec![tile((12, 12), Side::E), tile((13, 12), Side::E)];
    let turn = |new_rot: u8| {
        let mut core = genesis();
        core.advance_edits(
            &[rec(
                1,
                core.tick,
                EditOp::Place { kind: KIND_ROUTER, cell_x: A.0, cell_y: A.1, w: 2, h: 5, ports: ports.clone(), rot: 0 },
            )],
            &[],
        );
        let m = *core.last_tick.placed.last().expect("the router was minted");
        core.advance_edits(&[rec(2, core.tick, EditOp::DrawBelt { tiles: belt_tiles.clone() })], &[]);
        let belt = *core.last_tick.placed.last().expect("the belt was minted");
        core.advance_edits(
            &[rec(3, core.tick, EditOp::Dock { belt, endpoint: BeltEnd::Tail, node: m, port: 1 })],
            &[],
        );
        assert_eq!(core.state.link_target((m, 1)), Some((belt, 0)), "the middle Out is docked before the turn");
        let body: BTreeSet<(i32, i32)> = cells_of_footprint(A, 2, 5, new_rot).collect();
        assert!(
            belt_tiles.iter().all(|t| !body.contains(&t.cell)),
            "the turned body does not cover the belt, so the command layer allows this Rotate"
        );
        core.advance_edits(&[rec(4, core.tick, EditOp::Rotate { node: m, new_rot, old_rot: 0 })], &[]);
        (core.state.link_target((m, 1)) == Some((belt, 0)), core.last_tick.unlinked.len())
    };

    assert_eq!(turn(1), (true, 0), "the middle Out's dock survives the quarter turn that keeps its facing cell");
    assert_eq!(turn(3), (false, 1), "and is released by the quarter turn that moves it");
}
