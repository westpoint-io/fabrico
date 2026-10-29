//! FOOT-02 golden gate — the rotation closed-form proven in isolation.
//!
//! These tests pin the ONE shared spatial primitive every later Phase-10 plan
//! (validate, fold, rebuild, trust gate, dock) reuses, so validate and fold can
//! never diverge on rotation. The pure `i32` helpers in `state.rs` are provable
//! without any `GridState`, fold, or wire-format involvement:
//!
//!   1. **`rotate90⁴ == identity`** (proptest): composing the single CW
//!      quarter-turn four times returns the ORIGINAL port local offset, world
//!      side, AND effective box; the building block agrees cell-for-cell with
//!      `port_world`'s closed-form table; and `cells_of_footprint` is
//!      rotation-periodic (occupancy `BTreeSet` over `rot` == over `rot+4`).
//!   2. **1×1 rotation is a no-op** (focused): a unit footprint occupies only its
//!      anchor and its port stays on the anchor cell for every `rot`.
//!   3. **Extreme-corner safety** (focused, WR-09-03 class): a wide footprint
//!      anchored near `GRID_MAX` rotates off-grid; every cell enumerates without
//!      panic/overflow and at least one exceeds 512, so a caller's per-cell
//!      bounds check WILL reject it (Pitfall 5 detectable, never silently
//!      accepted).
//!   4. **Undoing a severing rotate needs no new edit-log op** (plan 63-10):
//!      `state.rs`'s Landmine 4 records that a DOCKED machine's four-turn is NOT
//!      identity, because turn 1 may de-dock and turn 4 does not restore the link.
//!      `63-CONTEXT.md` claims CONNECT-03's inverse is nonetheless expressible with
//!      the ops that already exist, since the de-dock is a derived consequence
//!      recorded in `last_tick.unlinked`. The last test in this file MEASURES that:
//!      it reads the severed set off `last_tick.unlinked`, folds one `EditOp::Dock`
//!      per record, and asserts the whole `GridState` returns byte-identical.
//!
//! Run target: `cargo test -p fabrico-core --test footprint_rotation`
//! (`PROPTEST_CASES=1024` in CI). `BTreeSet`/`Vec` only — no `HashSet`.

use fabrico_core::core::Core;
use fabrico_core::edit::{BeltEnd, EDIT_SCHEMA_VERSION, EditOp, EditRecord};
use fabrico_core::event::{LogHeader, SCHEMA_VERSION};
use fabrico_core::ids::{NodeId, PortId};
use fabrico_core::state::{
    cells_of_footprint, port_world, Axis, BeltTile, Footprint, Medium, Port, Role, Side, TileKind,
    MAX_FOOTPRINT_DIM,
};
use proptest::prelude::*;
use std::collections::BTreeSet;

/// Reusable proptest strategies for footprint/rotation inputs. Later Phase-10
/// plans (validate, fold, dock) pull their random spatial inputs from the same
/// bounds: dims ≤ `MAX_FOOTPRINT_DIM`, anchors in the verified grid range
/// `[-512, 512]`, ports in-range for their box.
mod gens {
    use super::*;

    /// A footprint dim pair `(w, h)`, each axis `1..=MAX_FOOTPRINT_DIM`.
    pub fn footprint() -> impl Strategy<Value = (u16, u16)> {
        (1..=MAX_FOOTPRINT_DIM, 1..=MAX_FOOTPRINT_DIM)
    }

    /// A rotation `0..4` (CW quarter-turn count).
    pub fn rot() -> impl Strategy<Value = u8> {
        0u8..4
    }

    /// An anchor (min-corner) within the verified grid range `[-512, 512]`.
    pub fn anchor() -> impl Strategy<Value = (i32, i32)> {
        (-512i32..=512, -512i32..=512)
    }

    /// An arbitrary side.
    pub fn side() -> impl Strategy<Value = Side> {
        prop_oneof![Just(Side::N), Just(Side::E), Just(Side::S), Just(Side::W)]
    }

    /// An arbitrary role.
    pub fn role() -> impl Strategy<Value = Role> {
        prop_oneof![Just(Role::In), Just(Role::Out)]
    }

    /// A port whose `local_offset` is in-range for the rot-0 box `[0,w)×[0,h)`.
    pub fn port_in(w: u16, h: u16) -> impl Strategy<Value = Port> {
        (0i32..i32::from(w), 0i32..i32::from(h), side(), role())
            .prop_map(|(x, y, side, role)| Port {
                local_offset: (x, y),
                side,
                role,
                medium: Medium::Mechanical,
            })
    }
}

/// A footprint paired with a port that is in-range for it.
fn footprint_and_port() -> impl Strategy<Value = (u16, u16, Port)> {
    gens::footprint().prop_flat_map(|(w, h)| (Just(w), Just(h), gens::port_in(w, h)))
}

/// One 90° CW quarter-turn of a local offset inside box `(w,h)` into box `(h,w)`:
/// `(x,y) ↦ (h-1-y, x)`, side `↦ (side+1)&3`, box `↦ (h,w)`. This is the single
/// building block; composing it four times must be the identity (the proof in
/// 10-RESEARCH §The Rotation Spike), and composing it `k` times must agree with
/// `port_world`'s closed-form table.
fn quarter_turn(
    off: (i32, i32),
    side: Side,
    (w, h): (u16, u16),
) -> ((i32, i32), Side, (u16, u16)) {
    let (x, y) = off;
    let hh = i32::from(h);
    ((hh - 1 - y, x), Side::from(side as u8 + 1), (h, w))
}

proptest! {
    // CI overrides via PROPTEST_CASES=1024; the in-source default keeps local
    // runs fast while still broadly sampling the rotation space.
    #![proptest_config(ProptestConfig::with_cases(256))]

    /// `rotate90⁴ == identity` over dims, port local-offset, port side, AND
    /// occupancy set — the FOOT-02 golden property. Also binds the single
    /// quarter-turn building block to `port_world`'s closed form.
    #[test]
    fn rotate90_pow4_is_identity(
        (w, h, p) in footprint_and_port(),
        anchor in gens::anchor(),
    ) {
        // Walk rot 0,1,2,3: at each step the composed quarter-turn building block
        // must match port_world's table (local offset = world cell − anchor, and
        // world side), and one more turn advances the state.
        let mut off = p.local_offset;
        let mut side = p.side;
        let mut bx = (w, h);
        for rot in 0u8..4 {
            let (cell, wside) = port_world(anchor, w, h, rot, &p);
            let local = (cell.0 - anchor.0, cell.1 - anchor.1);
            prop_assert_eq!(local, off, "port_world local offset matches composed quarter-turns");
            prop_assert_eq!(wside, side, "port_world side matches composed quarter-turns");
            let (next_off, next_side, next_bx) = quarter_turn(off, side, bx);
            off = next_off;
            side = next_side;
            bx = next_bx;
        }
        // Four quarter-turns return offset, side AND box to the original.
        prop_assert_eq!(off, p.local_offset, "local offset returns after 4 quarter-turns");
        prop_assert_eq!(side, p.side, "side returns after 4 quarter-turns");
        prop_assert_eq!(bx, (w, h), "effective box returns after 4 quarter-turns");

        // The footprint occupancy set is 4-periodic: rot and rot+4 (same parity)
        // expand to the identical set of world cells.
        for rot in 0u8..4 {
            let here: BTreeSet<(i32, i32)> = cells_of_footprint(anchor, w, h, rot).collect();
            let after: BTreeSet<(i32, i32)> =
                cells_of_footprint(anchor, w, h, rot.wrapping_add(4)).collect();
            prop_assert_eq!(&here, &after, "occupancy set is rotation-periodic");
            // The set has exactly W*H distinct cells (dim swap on odd rot).
            let (we, he) = if rot & 1 == 0 { (w, h) } else { (h, w) };
            prop_assert_eq!(here.len(), usize::from(we) * usize::from(he), "exactly W*H cells");
        }
    }

    /// `port_world`'s world side is `(side + rot) & 3`, independent of dims/anchor.
    #[test]
    fn port_world_side_is_side_plus_rot(side in gens::side(), rot in gens::rot()) {
        let p = Port { local_offset: (0, 0), side, role: Role::In, medium: Medium::Mechanical };
        let (_cell, wside) = port_world((0, 0), 1, 1, rot, &p);
        prop_assert_eq!(wside, Side::from(side as u8 + rot));
    }
}

/// Rotating a 1×1 footprint is observably a no-op: it occupies only its anchor
/// cell and its port stays on that anchor cell for every `rot` (only the world
/// side spins).
#[test]
fn one_by_one_rotation_is_a_noop() {
    let anchor = (3, 4);
    let p = Port { local_offset: (0, 0), side: Side::N, role: Role::Out, medium: Medium::Mechanical };
    for rot in 0u8..4 {
        let cells: Vec<(i32, i32)> = cells_of_footprint(anchor, 1, 1, rot).collect();
        assert_eq!(cells, vec![anchor], "1×1 occupies only its anchor at rot {rot}");
        let (cell, side) = port_world(anchor, 1, 1, rot, &p);
        assert_eq!(cell, anchor, "1×1 port stays on the anchor cell at rot {rot}");
        assert_eq!(
            side,
            Side::from(p.side as u8 + rot),
            "only the world side spins for a 1×1 at rot {rot}"
        );
    }
}

/// WR-09-03-class extreme corner: a wide footprint anchored near `GRID_MAX`
/// rotates so its now-`h×w` extent grows off-grid. Every cell must enumerate
/// without panic/overflow, and at least one must exceed 512 so a caller's
/// per-cell bounds check WILL reject it (Pitfall 5 — detectable, not silently
/// accepted). The anchor itself stays in range.
#[test]
fn extreme_corner_rotation_is_enumerable_and_off_grid_detectable() {
    let anchor = (510, 510); // in-range min-corner, near +bound
    let (w, h) = (60u16, 2u16); // ≤ MAX_FOOTPRINT_DIM; rot 1 swaps to 2×60
    assert!(w <= MAX_FOOTPRINT_DIM && h <= MAX_FOOTPRINT_DIM);

    // Enumerate every rotated cell without panic — the rotation is overflow-safe.
    let cells: Vec<(i32, i32)> = cells_of_footprint(anchor, w, h, 1).collect();
    assert_eq!(
        cells.len(),
        usize::from(w) * usize::from(h),
        "all W*H cells enumerate without panic"
    );

    // At least one rotated body cell is off-grid (y-extent grows to 510+59=569).
    let off_grid = cells.iter().filter(|(x, y)| *x > 512 || *y > 512).count();
    assert!(
        off_grid > 0,
        "rotated extent extends past GRID_MAX=512 → per-cell bounds check rejects it"
    );

    // The far-corner port also computes off-grid without overflow/panic.
    let corner = Port {
        local_offset: (i32::from(w) - 1, i32::from(h) - 1),
        side: Side::S,
        role: Role::In, medium: Medium::Mechanical,
    };
    let (cell, _side) = port_world(anchor, w, h, 1, &corner);
    assert!(
        cell.0 > 512 || cell.1 > 512,
        "extreme port world-cell is detectably off-grid (computed without panic)"
    );
}

/// FOLD-level `rotate90⁴ == identity` (10-06): unlike the pure-helper proptest
/// above, this drives the ACTUAL fold — placing a 2×3 multi-cell machine through
/// the edit-log, applying four `+1` `Rotate` edits, and asserting the resulting
/// `GridState` is byte-identical to the pre-rotation snapshot. The anchor never
/// moves, the occupancy re-expands the identical set, `footprints[m].rot` cycles
/// `0→1→2→3→0`, and the identity-stable rot-0 ports are untouched. No docked belt
/// is wired, so this is a PURE rotation (no cascade-detach to perturb the state) —
/// the corpus fixture `0011` covers cascade-on-rotate separately.
#[test]
fn fold_rotate90_pow4_is_identity_through_the_fold() {
    const KIND_ROUTER: u8 = 5;
    let exemplar_ports = vec![
        Port { local_offset: (0, 0), side: Side::W, role: Role::In, medium: Medium::Mechanical },
        Port { local_offset: (1, 2), side: Side::E, role: Role::Out, medium: Medium::Mechanical },
    ];
    let mut core = Core::genesis(LogHeader {
        schema_version: SCHEMA_VERSION,
        seed: 0x0011_1DEA,
    });
    // Place a 2×3 multi-cell machine (no docked belt) via the edit-log fold.
    core.advance_edits(
        &[EditRecord {
            schema_version: EDIT_SCHEMA_VERSION,
            partition: 0,
            sequence: 0,
            tick: 0,
            action: 0,
            op: EditOp::Place {
                kind: KIND_ROUTER,
                cell_x: 5,
                cell_y: 5,
                w: 2,
                h: 3,
                ports: exemplar_ports.clone(),
                rot: 0,
            },
        }],
        &[],
    );
    let m = *core
        .last_tick
        .placed
        .last()
        .expect("the multi-cell machine was minted");
    // Sanity: it claimed a non-trivial footprint + its rot-0 ports.
    assert_eq!(core.state.footprint_of(m), Some(Footprint { w: 2, h: 3, rot: 0 }));
    assert_eq!(core.state.ports_of(m), Some(exemplar_ports.as_slice()));

    // GridState BEFORE any rotation (occupancy is #[serde(skip)]; this captures
    // nodes/cells/footprints/ports/links/inboxes).
    let before = postcard::to_allocvec(&core.state).expect("serialize GridState");

    // Apply four +1 quarter-turns THROUGH THE FOLD (one edit per tick).
    for (seq, (new_rot, old_rot)) in [(1u8, 0u8), (2, 1), (3, 2), (0, 3)].into_iter().enumerate() {
        core.advance_edits(
            &[EditRecord {
                schema_version: EDIT_SCHEMA_VERSION,
                partition: 0,
                sequence: 1 + seq as u64,
                tick: core.tick,
                action: 0,
                op: EditOp::Rotate {
                    node: m,
                    new_rot,
                    old_rot,
                },
            }],
            &[],
        );
    }

    let after = postcard::to_allocvec(&core.state).expect("serialize GridState");
    assert_eq!(
        before, after,
        "rotate90⁴ == identity through the fold: GridState returns byte-identical"
    );
    // The orientation explicitly cycled back to rot 0.
    assert_eq!(core.state.footprint_of(m), Some(Footprint { w: 2, h: 3, rot: 0 }));
}

// --- CONNECT-03: undoing a severing rotate needs no new edit-log op (plan 63-10) ---

/// The machine kind byte `fold_place` mints a `Node::Router` from. Restated locally,
/// exactly as [`fold_rotate90_pow4_is_identity_through_the_fold`] does above:
/// `machine_kind` is a crate-private module, and the two integration tests that need a
/// kind byte name it at the line rather than widening the crate's surface for a test.
const KIND_ROUTER: u8 = 5;

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

/// Every directed link in the grid, serialized — the `links` map as bytes.
///
/// [`GridState::links_iter`](fabrico_core::state::GridState::links_iter) yields the
/// pairs in the map's own ascending key order, so this is a faithful byte image of the
/// map rather than a re-ordered copy of it: a link added back under a DIFFERENT key
/// moves these bytes.
fn link_bytes(core: &Core) -> Vec<u8> {
    let links: Vec<((NodeId, PortId), (NodeId, PortId))> = core.state.links_iter().collect();
    postcard::to_allocvec(&links).expect("serialize the links map")
}

/// The serialized `GridState` — nodes, inboxes, links, cells, footprints and ports.
///
/// Not the whole `Core`: its first serialized field is the monotonic tick and every
/// fold advances it, so a before/after equality over the whole `Core` is unattainable
/// for ANY op. Plans 63-03 and 63-05 both measured that wall.
fn grid_bytes(core: &Core) -> Vec<u8> {
    postcard::to_allocvec(&core.state).expect("serialize GridState")
}

/// **CONNECT-03, measured.** A rotate that SEVERS a dock is undone by folding one
/// `EditOp::Dock` per record the rotate wrote into `last_tick.unlinked` — no new
/// serialized shape, no new op.
///
/// # Why this needed proving rather than arguing
/// [`GridState::rotate_footprint`](fabrico_core::state::GridState)'s own Landmine 4
/// records that a DOCKED machine's four-turn is NOT identity: turn 1 may de-dock and
/// turn 4 does not put the link back. `63-CONTEXT.md` nonetheless claims CONNECT-03's
/// inverse needs no new shape, on the ground that the de-dock is a DERIVED consequence
/// already recorded as `Vec<UnlinkedDock>`, so the inverse is N `EditOp::Dock` records
/// in the undo group. That claim decides whether the undo half of Phase 67's connect
/// verb is ordinary `fabrico-command` work or a missing keystone shape, and
/// `fabrico-core` closes at the end of this phase, so it is this-phase-or-never.
///
/// # The board, and why this rotation severs
/// A 1×1 router at `(5,5)` declaring a single `Out@E`, and a 2-tile belt at
/// `(6,5)-(7,5)` docked `Tail` (the machine offloads onto the belt). At rot 0 the Out
/// nub faces `(6,5)`, the belt's tail tile — the dock reaches. Under rot 1 the nub
/// spins to `S` and faces `(5,6)`, which is not the belt, so `dock_still_reaches`
/// returns false and the one directed link is dropped. This is
/// `tick.rs::rotate_dedock_drops_when_no_longer_facing`'s board, reached here through
/// the FOLD (Place, DrawBelt, Dock records) rather than through direct `GridState`
/// calls, so the whole path a real edit log takes is exercised.
///
/// # The severed set is READ, never hand-written
/// The restore loop iterates `core.last_tick.unlinked`. A test that hand-listed the
/// dock it expected to be severed would still pass if the rotate had recorded nothing
/// at all, which is precisely the failure that would make the inverse unbuildable. The
/// non-emptiness of that set is asserted first, for the same reason.
#[test]
fn rotate_severed_docks_are_restored_by_folding_their_recorded_dock_records() {
    let mut core = Core::genesis(LogHeader {
        schema_version: SCHEMA_VERSION,
        seed: 0x0063_0010_D0CC,
    });

    // 1. A 1×1 machine at (5,5) with one Out@E, placed through the fold.
    core.advance_edits(
        &[rec(
            1,
            0,
            EditOp::Place {
                kind: KIND_ROUTER,
                cell_x: 5,
                cell_y: 5,
                w: 1,
                h: 1,
                ports: vec![Port {
                    local_offset: (0, 0),
                    side: Side::E,
                    role: Role::Out,
                    medium: Medium::Mechanical,
                }],
                rot: 0,
            },
        )],
        &[],
    );
    let m = *core.last_tick.placed.last().expect("the machine was minted");

    // 2. A 2-tile drawn belt running east from the machine's Out nub.
    core.advance_edits(
        &[rec(
            2,
            core.tick,
            EditOp::DrawBelt {
                tiles: vec![
                    BeltTile::new((6, 5), TileKind::Straight { axis: Axis::X }),
                    BeltTile::new((7, 5), TileKind::Straight { axis: Axis::X }),
                ],
            },
        )],
        &[],
    );
    let belt = *core.last_tick.placed.last().expect("the belt was minted");

    // 3. Dock the belt's TAIL to the machine's 0th Role::Out (the routing keyspace).
    core.advance_edits(
        &[rec(
            3,
            core.tick,
            EditOp::Dock { belt, endpoint: BeltEnd::Tail, node: m, port: 0 },
        )],
        &[],
    );
    assert_eq!(
        core.state.link_target((m, 0)),
        Some((belt, 0)),
        "the board starts DOCKED — everything below is a claim about undoing a severance"
    );

    // The two oracles, captured on the docked, un-rotated board.
    let docked_links = link_bytes(&core);
    let docked_state = grid_bytes(&core);

    // 4. Rotate +1. The Out nub spins E -> S and no longer faces the belt's tail tile.
    core.advance_edits(
        &[rec(4, core.tick, EditOp::Rotate { node: m, new_rot: 1, old_rot: 0 })],
        &[],
    );
    let severed = core.last_tick.unlinked.clone();
    assert_eq!(
        severed.len(),
        1,
        "the rotate SEVERED exactly one dock and recorded it — without this the \
         restore below would be vacuous"
    );
    assert_eq!(
        core.state.link_target((m, 0)),
        None,
        "the dock link really is gone after the rotate"
    );
    assert_ne!(
        docked_links,
        link_bytes(&core),
        "the links map MOVED, so the byte equality below is not trivially satisfiable"
    );
    assert!(
        core.state.node(belt).is_some(),
        "the belt NODE survives the severance — only the link was dropped"
    );

    // 5. The inverse: one EditOp::Dock per recorded UnlinkedDock, in the order the
    //    rotate recorded them. Nothing here is invented; every field is read off the
    //    record the fold itself wrote.
    let redocks: Vec<EditRecord> = severed
        .iter()
        .enumerate()
        .map(|(i, u)| {
            rec(
                5 + i as u64,
                core.tick,
                EditOp::Dock {
                    belt: u.belt,
                    endpoint: u.endpoint,
                    node: u.node,
                    port: u.port,
                },
            )
        })
        .collect();
    core.advance_edits(&redocks, &[]);

    assert_eq!(
        docked_links,
        link_bytes(&core),
        "the links map is byte-identical to the pre-rotate one: CONNECT-03's inverse \
         is N EditOp::Dock records and needs no new serialized shape"
    );

    // 6. The whole-state claim. With the links restored, the ONLY difference left is
    //    the rotation itself, so turning the machine back to rot 0 must return the
    //    whole GridState byte-identical. That is the strongest form of "differs only in
    //    the rotation", and it is exactly what Landmine 4 says does NOT hold without
    //    the redock records above.
    core.advance_edits(
        &[rec(9, core.tick, EditOp::Rotate { node: m, new_rot: 0, old_rot: 1 })],
        &[],
    );
    assert_eq!(
        docked_state,
        grid_bytes(&core),
        "rotate + redock + rotate-back returns the whole GridState byte-identical, \
         which a docked machine's bare four-turn does NOT (state.rs Landmine 4)"
    );
    assert!(
        core.last_tick.unlinked.is_empty(),
        "turning back re-judged the restored dock and KEPT it — the port faces the \
         belt again at rot 0"
    );
}
