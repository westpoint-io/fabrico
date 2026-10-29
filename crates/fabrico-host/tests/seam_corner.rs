//! CORNER-01 / CORNER-06 (phase 74.1 gap closure, plan 74.1-07): the SHIPPED tile kind at a
//! docked seam.
//!
//! # What this file pins, and what it refuses to read
//!
//! Manual testing rejected S1, S2 and S4 on the real binary because a belt that turns at a dock drew
//! as a T: the Dock link landed, but the seam tile stayed the Straight that `route()` typed
//! from the new belt's own cells. Every check before this file graded the LINK (a dock op
//! recorded, `link_target` set, a dock read 1/1 from both sides) and every one of them
//! passed while the screen showed a T-shaped seam. So every pin here reads
//! the RENDER PACKET, the bytes the renderer draws from, and asserts the exact
//! `TileKindView` it ships. None reads `belt.docks`, `link_target` or a dock count as proof
//! of a join.
//!
//! The rule under test (74.1-SEAM-DESIGN.md section 2): a belt's STORED geometry is the
//! authored shape `route()` typed at DrawBelt and never changes for a dock; what is DRAWN at
//! a docked end is derived on every read by `GridState::effective_belt_tiles`, and
//! `render_packet.rs` `current_views` ships that.
//!
//! # The byte encodings the expected values are written in
//!
//! `TileKindView` carries the core enums as numeric `u8`s: `Axis` X=0, Y=1; `Dir` N=0,
//! E=1, S=2, W=3 (y-down, so N is `(0,-1)`). `Corner { from, to }` is the flow entering
//! facing `from` and leaving facing `to`.
//!
//! Run target: `cargo test -p fabrico-host --test seam_corner`.

use fabrico_command::{GridLookup, GridSession};
use fabrico_core::core::Core;
use fabrico_core::edit::{EDIT_SCHEMA_VERSION, EditOp, EditRecord};
use fabrico_core::event::{LogHeader, SCHEMA_VERSION};
use fabrico_core::ids::NodeId;
use fabrico_core::persist::RedbStore;
use fabrico_core::state::{
    Axis, BeltTile, Medium, Node, Port, Role, Side, TileKind, port_world, reseat_ports, unit_delta,
};
use fabrico_host::driver::Host;
use fabrico_host::ledger::DispatchLedger;
use fabrico_host::render_packet::RenderPacketBuilder;
use fabrico_protocol::{BeltEnd, BeltView, GridCommand, RenderPacket, TileKindView, machine_kind};

/// The genesis seed for every session here. Pinned so a rerun folds the identical board.
const SEED: u64 = 7;

/// `Straight { axis }` on the wire.
fn straight(axis: u8) -> TileKindView {
    TileKindView::Straight { axis }
}

/// `Corner { from, to }` on the wire.
fn corner(from: u8, to: u8) -> TileKindView {
    TileKindView::Corner { from, to }
}

/// A real `Host` over a CLONE of `core` with temporary redb stores. The `TempDir` is
/// returned so it outlives the stores.
fn host_over(core: &Core) -> (tempfile::TempDir, Host) {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = RedbStore::open(dir.path().join("log.redb")).expect("open log");
    let ledger = DispatchLedger::open(dir.path().join("ledger.redb")).expect("open ledger");
    let host = Host::new(core.clone(), store, ledger, None).expect("open host");
    (dir, host)
}

/// The tile kinds the render packet SHIPS for `belt`, read off a fresh keyframe built over
/// a clone of `core`. This is the only reader the pins use.
fn shipped(core: &Core, belt: NodeId) -> Vec<TileKindView> {
    let (_dir, host) = host_over(core);
    let mut builder = RenderPacketBuilder::new();
    let pkt = builder.build_keyframe(&host);
    let h = builder
        .handle_for_node(belt)
        .unwrap_or_else(|| panic!("belt {belt:?} has a render handle"));
    pkt.belts
        .iter()
        .find(|b| b.id == h)
        .unwrap_or_else(|| panic!("belt handle {h} in the keyframe"))
        .tiles
        .iter()
        .map(|t| t.kind.clone())
        .collect()
}

/// The STORED geometry kinds of `belt`, read off the core. Used only to show the derived
/// kind is not written back, never as a join claim.
fn stored(core: &Core, belt: NodeId) -> Vec<TileKind> {
    match core.state.node(belt) {
        Some(Node::Belt(b)) => b.geometry.iter().map(|t| t.tile_kind()).collect(),
        other => panic!("{belt:?} is a belt, got {:?}", other.map(|_| "non-belt")),
    }
}

/// Draw a belt through `cells` and return its session handle.
fn draw_belt(session: &mut GridSession, cells: Vec<(i32, i32)>) -> u64 {
    session
        .apply(GridCommand::DrawBelt { cells })
        .expect("a clear drawn path is accepted");
    let id = *session.core().last_tick.placed.last().expect("belt minted");
    session.view().handle_of(id).expect("belt got a handle")
}

/// The core id behind a session handle.
fn id_of(session: &GridSession, handle: u64) -> NodeId {
    session
        .view()
        .lookup(session.core())
        .resolve(handle)
        .unwrap_or_else(|| panic!("handle {handle} resolves"))
}

#[test]
fn s1_tail_turning_north_off_a_belt_head_ships_a_corner() {
    // S1 (seq 42/43 of the failing walk). Belt A runs EAST (5,6)..(7,6), so
    // its Head is (7,6) and its doorstep (8,6). Belt B starts ON that doorstep and turns
    // NORTH at once: (8,6) -> (8,5) -> (8,4). route() types every tile of B from B's own
    // cells, so B's stored tile 0 is Straight{Y}. Docked, the flow enters (8,6) travelling
    // E (out of A) and leaves N: the tile the user must SEE is Corner{from:E, to:N}.
    let mut session = GridSession::new(SEED);
    let a = draw_belt(&mut session, vec![(5, 6), (6, 6), (7, 6)]);
    let b = draw_belt(&mut session, vec![(8, 6), (8, 5), (8, 4)]);
    let (a_id, b_id) = (id_of(&session, a), id_of(&session, b));

    // Undocked, B ships exactly what route() stored: three north-south straights.
    assert_eq!(
        shipped(session.core(), b_id),
        vec![straight(1), straight(1), straight(1)],
        "an UNDOCKED B ships its stored Straight{{Y}} run: no seam, nothing to derive"
    );

    session
        .apply(GridCommand::Dock {
            belt: b,
            endpoint: BeltEnd::Tail,
            node: a,
            port: 1, // a belt's catalog is [Tail (In) = 0, Head (Out) = 1]
        })
        .expect("a Tail that turns at a belt Head's doorstep is accepted");

    assert_eq!(
        shipped(session.core(), b_id),
        vec![corner(1, 0), straight(1), straight(1)],
        "docked, B's seam tile ships Corner{{from:E, to:N}}: the join the user sees"
    );
    assert_eq!(
        shipped(session.core(), a_id),
        vec![straight(0), straight(0), straight(0)],
        "A's flow continues straight into the seam: only the carrier bends"
    );
    assert_eq!(
        stored(session.core(), b_id)[0],
        TileKind::Straight { axis: Axis::Y },
        "the derivation is READ-ONLY: B's stored tile 0 is still the Straight{{Y}} route() typed"
    );
}

// ---------------------------------------------------------------------------
// The rig for every pin below.
// ---------------------------------------------------------------------------

/// The `Dir` byte a cell edge `side` travels on the wire (`N=0, E=1, S=2, W=3`), written
/// out so no pin trusts a cast.
fn dir_byte(side: Side) -> u8 {
    match side {
        Side::N => 0,
        Side::E => 1,
        Side::S => 2,
        Side::W => 3,
    }
}

/// The side directly against `side`.
fn against(side: Side) -> Side {
    match side {
        Side::N => Side::S,
        Side::E => Side::W,
        Side::S => Side::N,
        Side::W => Side::E,
    }
}

/// The belt whose tile occupies `cell`, by the core's occupancy index. Pins address belts
/// by CELL so an Undo that re-mints an id cannot point a pin at the wrong belt.
fn belt_at(core: &Core, cell: (i32, i32)) -> NodeId {
    let id = core
        .state
        .occupied(cell)
        .unwrap_or_else(|| panic!("a node occupies {cell:?}"));
    assert!(
        matches!(core.state.node(id), Some(Node::Belt(_))),
        "the node at {cell:?} is a belt"
    );
    id
}

/// The tile kinds SHIPPED for the belt occupying `cell`.
fn shipped_at(core: &Core, cell: (i32, i32)) -> Vec<TileKindView> {
    shipped(core, belt_at(core, cell))
}

/// Place a machine of `kind` at `(cell_x, cell_y)` through the command layer and return its
/// session handle.
fn place(session: &mut GridSession, kind: u8, cell_x: i32, cell_y: i32) -> u64 {
    session
        .apply(GridCommand::Place { kind, cell_x, cell_y })
        .expect("the machine is placed");
    let id = *session.core().last_tick.placed.last().expect("machine minted");
    session.view().handle_of(id).expect("machine got a handle")
}

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

/// A Mechanical port declaration for a forged board (reseated before use).
fn mech(role: Role) -> Port {
    Port {
        local_offset: (0, 0),
        side: Side::E,
        role,
        medium: Medium::Mechanical,
    }
}

/// A straight tile on `cell` running along `axis`.
fn straight_tile(cell: (i32, i32), axis: Axis) -> BeltTile {
    BeltTile::new(cell, TileKind::Straight { axis })
}

/// A core folded straight from forged records (the `dock_facing_rotate.rs` method): the
/// only way to build a 2xN Router with N > 3 Outs and to Dock without the command layer.
struct Forge {
    core: Core,
    seq: u64,
}

impl Forge {
    fn new() -> Self {
        Self {
            core: Core::genesis(LogHeader {
                schema_version: SCHEMA_VERSION,
                seed: SEED,
            }),
            seq: 0,
        }
    }

    /// Fold one forged op and return the id it minted, if any.
    fn fold(&mut self, op: EditOp) -> Option<NodeId> {
        self.seq += 1;
        let r = rec(self.seq, self.core.tick, op);
        self.core.advance_edits(&[r], &[]);
        self.core.last_tick.placed.last().copied()
    }

    /// A Router of `w x h` anchored at `anchor` carrying `ports` (already reseated).
    fn router(&mut self, anchor: (i32, i32), w: u16, h: u16, ports: Vec<Port>) -> NodeId {
        self.fold(EditOp::Place {
            kind: machine_kind::ROUTER,
            cell_x: anchor.0,
            cell_y: anchor.1,
            w,
            h,
            ports,
            rot: 0,
        })
        .expect("the router was minted")
    }

    /// A belt over `tiles` (folded verbatim, no route()).
    fn belt(&mut self, tiles: Vec<BeltTile>) -> NodeId {
        self.fold(EditOp::DrawBelt { tiles }).expect("the belt was minted")
    }

    fn dock(&mut self, belt: NodeId, endpoint: fabrico_core::edit::BeltEnd, node: NodeId, port: u16) {
        self.fold(EditOp::Dock {
            belt,
            endpoint,
            node,
            port,
        });
    }

    fn rotate(&mut self, node: NodeId, new_rot: u8, old_rot: u8) {
        self.fold(EditOp::Rotate {
            node,
            new_rot,
            old_rot,
        });
    }
}

/// The belt `id`'s view in a DIFF packet, if the diff carries it.
fn belt_in_diff<'a>(
    builder: &RenderPacketBuilder,
    pkt: &'a RenderPacket,
    id: NodeId,
) -> Option<&'a BeltView> {
    let h = builder.handle_for_node(id)?;
    pkt.belts.iter().find(|b| b.id == h)
}

/// The S1 board: belt A east (5,6)..(7,6), belt B north at once (8,6)..(8,4), undocked.
/// Returns the session and both handles.
fn s1_board() -> (GridSession, u64, u64) {
    let mut session = GridSession::new(SEED);
    let a = draw_belt(&mut session, vec![(5, 6), (6, 6), (7, 6)]);
    let b = draw_belt(&mut session, vec![(8, 6), (8, 5), (8, 4)]);
    (session, a, b)
}

/// Dock B's Tail onto A's Head on the S1 board.
fn s1_dock(session: &mut GridSession, a: u64, b: u64) {
    session
        .apply(GridCommand::Dock {
            belt: b,
            endpoint: BeltEnd::Tail,
            node: a,
            port: 1,
        })
        .expect("the S1 seam dock is accepted");
}

/// B's kinds as S1 docked must ship them.
fn s1_docked() -> Vec<TileKindView> {
    vec![corner(1, 0), straight(1), straight(1)]
}

/// B's kinds undocked: the stored route() run.
fn s1_undocked() -> Vec<TileKindView> {
    vec![straight(1), straight(1), straight(1)]
}

/// The S1 seam cell (B's Tail tile).
const S1_SEAM: (i32, i32) = (8, 6);

// ---------------------------------------------------------------------------
// The pins.
// ---------------------------------------------------------------------------

#[test]
fn a_dock_after_the_draw_reemits_the_belt_with_its_corner_on_the_diff_path() {
    // The REAL echo order: the DrawBelt lands in one packet and the Dock one packet later.
    // A keyframe-only pin cannot see whether the per-tick DIFF re-emits B when only a link
    // changed, so this builds a baseline diff after the two draws and asserts the NEXT diff
    // carries B with its seam corner. (The S1 pin above already covers the separate-Dock
    // frame a handle drag emits, CR-01 entry 1.)
    let (mut session, a, b) = s1_board();
    let b_id = id_of(&session, b);
    let mut builder = RenderPacketBuilder::new();
    let (_d0, before) = host_over(session.core());
    let _baseline = builder.build(&before);

    s1_dock(&mut session, a, b);
    let (_d1, after) = host_over(session.core());
    let diff = builder.build(&after);
    assert!(!diff.full, "a per-tick diff, not a keyframe");
    let bv = belt_in_diff(&builder, &diff, b_id).expect("the diff after the Dock re-emits B");
    let kinds: Vec<TileKindView> = bv.tiles.iter().map(|t| t.kind.clone()).collect();
    assert_eq!(
        kinds,
        s1_docked(),
        "the diff that carries the Dock carries B's seam tile as Corner{{from:E, to:N}}"
    );
}

#[test]
fn s2_machine_out_turning_at_once_ships_a_corner() {
    // S2 on a plain Out, the n-th Out key. A FACTORY at (0,0) has its Out (catalog 1, Out
    // routing key 0) at (2,1) facing E, doorstep (3,1). The belt starts ON the doorstep and
    // turns SOUTH at once: (3,1) -> (3,2) -> (3,3). The expected corner is computed from
    // port_world, not trusted from this comment: items leave the port travelling along its
    // side and the belt carries them on south.
    let mut session = GridSession::new(SEED);
    let f = place(&mut session, machine_kind::FACTORY, 0, 0);
    let belt = draw_belt(&mut session, vec![(3, 1), (3, 2), (3, 3)]);
    let f_id = id_of(&session, f);
    let port = session.core().state.ports_of(f_id).expect("factory ports")[1];
    assert_eq!(port.role, Role::Out, "catalog 1 is the factory's Out");
    let (pcell, pside) = port_world((0, 0), 3, 3, 0, &port);
    let (dx, dy) = unit_delta(pside);
    assert_eq!((pcell.0 + dx, pcell.1 + dy), (3, 1), "the Out faces the belt's Tail tile");
    assert_eq!(shipped_at(session.core(), (3, 1)), vec![straight(1); 3], "undocked: stored");

    session
        .apply(GridCommand::Dock {
            belt,
            endpoint: BeltEnd::Tail,
            node: f,
            port: 1,
        })
        .expect("a Tail turning at the Out's doorstep is accepted");
    assert_eq!(
        shipped_at(session.core(), (3, 1)),
        vec![corner(dir_byte(pside), 2), straight(1), straight(1)],
        "docked to the Out, the doorstep tile ships Corner{{from: port side, to: S}}"
    );
}

#[test]
fn s2_factory_fault_nub_turning_at_once_ships_a_corner() {
    // S2 on the Fault nub, the FAULT_PORT sentinel key. A FACTORY at (0,0) has its Fault
    // port (catalog 2) at (1,2) facing S, doorstep (1,3). The belt starts there and turns
    // EAST at once: (1,3) -> (2,3) -> (3,3). Faults leave the nub travelling S and the belt
    // carries them east: Corner{S, E}.
    let mut session = GridSession::new(SEED);
    let f = place(&mut session, machine_kind::FACTORY, 0, 0);
    let belt = draw_belt(&mut session, vec![(1, 3), (2, 3), (3, 3)]);
    assert_eq!(shipped_at(session.core(), (1, 3)), vec![straight(0); 3], "undocked: stored");
    session
        .apply(GridCommand::Dock {
            belt,
            endpoint: BeltEnd::Tail,
            node: f,
            port: 2,
        })
        .expect("a Tail turning at the Fault nub's doorstep is accepted");
    assert_eq!(
        shipped_at(session.core(), (1, 3)),
        vec![corner(2, 1), straight(0), straight(0)],
        "docked to the Fault nub, the doorstep tile ships Corner{{from:S, to:E}}"
    );
}

#[test]
fn head_arriving_sideways_at_a_belt_tail_ships_a_corner() {
    // IN-04's Head half. Belt A runs NORTH (8,8) -> (8,7) -> (8,6), Head (8,6). Belt B runs
    // EAST from (9,6): its Tail's outward is W, so it faces (8,6), A's Head tile. A's Head
    // docks onto B's Tail. A is the carrier: its Head tile takes the flow N in and E out,
    // Corner{N, E}. B's Tail is entered from the west and keeps flowing east: it STAYS
    // Straight{X}. Only the carrier bends, and the cell step is what says which one.
    let mut session = GridSession::new(SEED);
    let a = draw_belt(&mut session, vec![(8, 8), (8, 7), (8, 6)]);
    let b = draw_belt(&mut session, vec![(9, 6), (10, 6), (11, 6)]);
    session
        .apply(GridCommand::Dock {
            belt: a,
            endpoint: BeltEnd::Head,
            node: b,
            port: 0, // a belt's catalog is [Tail (In) = 0, Head (Out) = 1]
        })
        .expect("a Head arriving sideways at a belt Tail is accepted");
    assert_eq!(
        shipped_at(session.core(), (8, 6)),
        vec![straight(1), straight(1), corner(0, 1)],
        "A's Head tile ships Corner{{from:N, to:E}}"
    );
    assert_eq!(
        shipped_at(session.core(), (9, 6)),
        vec![straight(0), straight(0), straight(0)],
        "B's Tail, entered straight from the west, stays Straight{{X}}"
    );
}

#[test]
fn head_arriving_sideways_at_an_in_ships_a_corner() {
    // D-14. A FACTORY at (10,10) has its In (catalog 0) at (10,11) facing W, so it takes
    // from (9,11). A belt runs SOUTH (9,9) -> (9,10) -> (9,11) and ends sideways in front
    // of it. Its Head docks to the In: items arrive travelling S and turn into the port,
    // against the port's side. The exact corner comes from the port facts.
    let mut session = GridSession::new(SEED);
    let f = place(&mut session, machine_kind::FACTORY, 10, 10);
    let belt = draw_belt(&mut session, vec![(9, 9), (9, 10), (9, 11)]);
    let f_id = id_of(&session, f);
    let port = session.core().state.ports_of(f_id).expect("factory ports")[0];
    assert_eq!(port.role, Role::In, "catalog 0 is the factory's In");
    let (pcell, pside) = port_world((10, 10), 3, 3, 0, &port);
    let (dx, dy) = unit_delta(pside);
    assert_eq!((pcell.0 + dx, pcell.1 + dy), (9, 11), "the In faces the belt's Head tile");
    session
        .apply(GridCommand::Dock {
            belt,
            endpoint: BeltEnd::Head,
            node: f,
            port: 0,
        })
        .expect("a Head arriving sideways at an In is accepted (D-14)");
    assert_eq!(
        shipped_at(session.core(), (9, 11)),
        vec![straight(1), straight(1), corner(2, dir_byte(against(pside)))],
        "the Head tile ships Corner{{from:S, to: into the port}}"
    );
}

/// The 2x5 Router of `dock_facing_rotate.rs` claim 3: one In and five Outs reseated into a
/// 2x5 box over the 2x3 Router catalog box, so (since 74.1-14, the centre-out fill) the
/// Outs sit on rows 1, 2, 0, 3, 4 and `Out_1` is the one at local (1,2), the middle of the
/// E column. Anchored at (10,10), the belt `[(12,12), (13,12)]` (east) is Tail-docked to
/// `Out_1` (routing key 1). Until 74.1-14 the index rule put `Out_2` there and the board
/// docked key 2; the geometry is the same. Returns the forge, the router and the belt.
fn router_2x5_board() -> (Forge, NodeId, NodeId) {
    let mut seed_ports = vec![mech(Role::In)];
    seed_ports.extend((0..5).map(|_| mech(Role::Out)));
    let ports = reseat_ports(fabrico_core::state::Footprint { w: 2, h: 3, rot: 0 }, 2, 5, &seed_ports);
    assert_eq!((ports[2].local_offset, ports[2].side), ((1, 2), Side::E));
    let mut forge = Forge::new();
    let m = forge.router((10, 10), 2, 5, ports);
    let belt = forge.belt(vec![
        straight_tile((12, 12), Axis::X),
        straight_tile((13, 12), Axis::X),
    ]);
    forge.dock(belt, fabrico_core::edit::BeltEnd::Tail, m, 1);
    assert_eq!(forge.core.state.link_target((m, 1)), Some((belt, 0)), "Out_1 docked");
    (forge, m, belt)
}

#[test]
fn rotate_keep_retypes_the_seam_by_derivation() {
    // CR-01 entry 2. At rot 0 Out_1 (the middle E port since 74.1-14) faces (12,12)
    // travelling E into an eastbound belt: Straight{X}. One CW quarter turn keeps the facing cell (dock_still_reaches keeps the
    // link) but the port now pushes S into it: Corner{S, E}. Turning back restores E:
    // Straight{X}. Nothing is written to the belt at any step; the kind is derived.
    let (mut forge, m, belt) = router_2x5_board();
    assert_eq!(shipped(&forge.core, belt), vec![straight(0), straight(0)], "rot 0");

    forge.rotate(m, 1, 0);
    assert_eq!(forge.core.state.link_target((m, 1)), Some((belt, 0)), "rot 1 keeps the dock");
    assert_eq!(
        shipped(&forge.core, belt),
        vec![corner(2, 1), straight(0)],
        "rot 1: the kept dock now pushes S into an eastbound belt, Corner{{from:S, to:E}}"
    );
    assert_eq!(
        stored(&forge.core, belt)[0],
        TileKind::Straight { axis: Axis::X },
        "and the stored tile was never rewritten"
    );

    forge.rotate(m, 0, 1);
    assert_eq!(
        shipped(&forge.core, belt),
        vec![straight(0), straight(0)],
        "rot back to 0: Straight{{X}} again"
    );

    // The releasing turn: rot 3 moves the facing cell, the link is released, and the
    // stored Straight shows.
    let (mut forge3, m3, belt3) = router_2x5_board();
    forge3.rotate(m3, 3, 0);
    assert_eq!(forge3.core.state.link_target((m3, 1)), None, "rot 3 releases the dock");
    assert_eq!(
        shipped(&forge3.core, belt3),
        vec![straight(0), straight(0)],
        "released: the stored Straight{{X}}"
    );
}

#[test]
fn unlink_undo_redo_follow_the_link() {
    // Every step asserts the EXACT kind (never "not Straight"): Dock draws the corner, Undo
    // takes it away, Redo brings it back, Unlink takes it away, Undo of the Unlink brings it
    // back. Belts are addressed by cell, so a re-folded id cannot mislead the pin.
    let (mut session, a, b) = s1_board();
    s1_dock(&mut session, a, b);
    assert_eq!(shipped_at(session.core(), S1_SEAM), s1_docked(), "after Dock");

    session.apply(GridCommand::Undo).expect("undo the Dock");
    assert_eq!(shipped_at(session.core(), S1_SEAM), s1_undocked(), "after Undo of the Dock");

    session.apply(GridCommand::Redo).expect("redo the Dock");
    assert_eq!(shipped_at(session.core(), S1_SEAM), s1_docked(), "after Redo of the Dock");

    session
        .apply(GridCommand::Unlink {
            belt: b,
            endpoint: BeltEnd::Tail,
            node: a,
            port: 1,
        })
        .expect("unlink the seam");
    assert_eq!(shipped_at(session.core(), S1_SEAM), s1_undocked(), "after Unlink");

    session.apply(GridCommand::Undo).expect("undo the Unlink");
    assert_eq!(shipped_at(session.core(), S1_SEAM), s1_docked(), "after Undo of the Unlink");
}

#[test]
fn fan_in_side_load_stays_straight_until_the_straight_feed_goes() {
    // Belt C runs EAST (10,10) -> (12,10). A SIDE feed S runs NORTH (10,13) -> (10,11) into
    // C's Tail; a STRAIGHT feed F runs EAST (7,10) -> (9,10) into it. S is drawn FIRST, so
    // its link key (S,0) sorts BEFORE (F,0): a "take the first feed" rule would draw a
    // corner here, and the fan-in rule must not. With both docked C's Tail is a side-load
    // and keeps its stored Straight{X}; once F is unlinked, S is the lone feed and the
    // Tail turns: Corner{N, E}.
    let mut session = GridSession::new(SEED);
    let s = draw_belt(&mut session, vec![(10, 13), (10, 12), (10, 11)]);
    let f = draw_belt(&mut session, vec![(7, 10), (8, 10), (9, 10)]);
    let c = draw_belt(&mut session, vec![(10, 10), (11, 10), (12, 10)]);
    assert!(
        id_of(&session, s) < id_of(&session, f),
        "the side feed's link key sorts first"
    );
    for upstream in [s, f] {
        session
            .apply(GridCommand::Dock {
                belt: c,
                endpoint: BeltEnd::Tail,
                node: upstream,
                port: 1,
            })
            .expect("a second inbound Tail link is accepted (fan-in)");
    }
    assert_eq!(
        shipped_at(session.core(), (10, 10)),
        vec![straight(0), straight(0), straight(0)],
        "two feeds: a side-load keeps the stored Straight{{X}}, whatever the key order"
    );

    session
        .apply(GridCommand::Unlink {
            belt: c,
            endpoint: BeltEnd::Tail,
            node: f,
            port: 1,
        })
        .expect("unlink the straight feed");
    assert_eq!(
        shipped_at(session.core(), (10, 10)),
        vec![corner(0, 1), straight(0), straight(0)],
        "the side feed alone: C's Tail ships Corner{{from:N, to:E}}"
    );
}

#[test]
fn a_forged_non_facing_machine_link_keeps_the_stored_kind() {
    // IN-02 class defence. A FACTORY at (0,0) and a belt running SOUTH (5,5) -> (5,6) far
    // from it. A Dock no command would accept (the Out does not face the belt) is folded
    // straight through Core::advance_edits. The link exists, but the Out's facing cell is
    // not the belt's Tail tile, so nothing is derived: the stored Straight{Y} ships. The
    // belt runs PERPENDICULAR to the Out's side on purpose, so dropping the facing check
    // would draw Corner{E, S} here and this pin would see it.
    let mut session = GridSession::new(SEED);
    let f = place(&mut session, machine_kind::FACTORY, 0, 0);
    let belt = draw_belt(&mut session, vec![(5, 5), (5, 6)]);
    let (f_id, belt_id) = (id_of(&session, f), id_of(&session, belt));
    let core = session.core_mut();
    let r = rec(1_000, core.tick, EditOp::Dock {
        belt: belt_id,
        endpoint: fabrico_core::edit::BeltEnd::Tail,
        node: f_id,
        port: 0, // the factory's Out routing key
    });
    core.advance_edits(&[r], &[]);
    assert_eq!(core.state.link_target((f_id, 0)), Some((belt_id, 0)), "the forged link folded");
    assert_eq!(
        shipped(core, belt_id),
        vec![straight(1), straight(1)],
        "a link whose port does not face the end tile keeps the stored kind"
    );
}

#[test]
fn a_forged_non_adjacent_belt_link_keeps_the_stored_kind() {
    // The belt-partner half of the IN-02 defence, added because mutation M1b (the belt
    // adjacency check dropped) reddened nothing else. Belt A runs EAST (5,6)..(7,6); belt
    // B runs NORTH (9,6)..(9,4), so B's Tail is TWO cells east of A's Head, collinear with
    // it. A Dock no command would accept links them, folded straight through
    // Core::advance_edits. A cell step of two is not a seam: both belts ship their stored
    // runs. Without the exactly-one-step check, B's Tail would read a feed travelling E
    // and draw Corner{E, N}.
    let mut session = GridSession::new(SEED);
    let a = draw_belt(&mut session, vec![(5, 6), (6, 6), (7, 6)]);
    let b = draw_belt(&mut session, vec![(9, 6), (9, 5), (9, 4)]);
    let (a_id, b_id) = (id_of(&session, a), id_of(&session, b));
    let core = session.core_mut();
    let r = rec(1_000, core.tick, EditOp::Dock {
        belt: b_id,
        endpoint: fabrico_core::edit::BeltEnd::Tail,
        node: a_id,
        port: 0, // a belt Head's link key
    });
    core.advance_edits(&[r], &[]);
    assert_eq!(core.state.link_target((a_id, 0)), Some((b_id, 0)), "the forged link folded");
    assert_eq!(
        shipped(core, b_id),
        vec![straight(1), straight(1), straight(1)],
        "a belt partner two cells away is no seam: B keeps its stored Straight{{Y}} run"
    );
    assert_eq!(
        shipped(core, a_id),
        vec![straight(0), straight(0), straight(0)],
        "and A keeps its stored Straight{{X}} run"
    );
}

#[test]
fn delete_partner_and_undo_restore_the_corner() {
    // Delete removes A and its links: B's seam has nothing to turn from and ships its
    // stored run. Undo re-draws A from the captured AUTHORED geometry and re-docks: the
    // corner is derived again.
    let (mut session, a, b) = s1_board();
    s1_dock(&mut session, a, b);
    assert_eq!(shipped_at(session.core(), S1_SEAM), s1_docked(), "docked");
    session.apply(GridCommand::Delete { node: a }).expect("delete A");
    assert_eq!(session.core().state.occupied((7, 6)), None, "A is gone");
    assert_eq!(shipped_at(session.core(), S1_SEAM), s1_undocked(), "A deleted: stored run");
    session.apply(GridCommand::Undo).expect("undo the Delete");
    assert_eq!(shipped_at(session.core(), S1_SEAM), s1_docked(), "A restored: the corner is back");
    assert_eq!(
        shipped_at(session.core(), (7, 6)),
        vec![straight(0), straight(0), straight(0)],
        "and A is restored with its authored straight run"
    );
}

#[test]
fn snapshot_restore_and_replay_ship_the_same_corner() {
    // Every input to the derivation is replayed, snapshotted state, so a restored core and a
    // core rebuilt from the edit log ship BYTE-IDENTICAL packets, corner included.
    let (mut session, a, b) = s1_board();
    s1_dock(&mut session, a, b);
    let live = session.core().clone();
    assert_eq!(shipped_at(&live, S1_SEAM), s1_docked(), "the live core ships the corner");
    let keyframe_bytes = |core: &Core| {
        let (_d, host) = host_over(core);
        let mut builder = RenderPacketBuilder::new();
        postcard::to_allocvec(&builder.build_keyframe(&host)).expect("encode packet")
    };
    let live_bytes = keyframe_bytes(&live);

    let restored = fabrico_core::snapshot::restore(&fabrico_core::snapshot::snapshot(&live))
        .expect("the snapshot restores");
    assert_eq!(shipped_at(&restored, S1_SEAM), s1_docked(), "the restored core ships the corner");
    assert_eq!(keyframe_bytes(&restored), live_bytes, "restore(snapshot) ships the same bytes");

    let replayed = GridSession::replay(SEED, session.edit_log());
    assert_eq!(
        shipped_at(replayed.core(), S1_SEAM),
        s1_docked(),
        "the replayed core ships the corner"
    );
    assert_eq!(
        keyframe_bytes(replayed.core()),
        live_bytes,
        "a session rebuilt from the edit log ships the same bytes"
    );
}

#[test]
fn partner_rotate_reemits_the_belt_on_the_diff_path() {
    // A Rotate of the docked machine changes no belt field and no link, only the port the
    // belt's seam reads. The per-tick DIFF must still re-emit the belt with its new kind,
    // or the renderer keeps the old seam until the next keyframe.
    let (mut forge, m, belt) = router_2x5_board();
    let mut builder = RenderPacketBuilder::new();
    let (_d0, before) = host_over(&forge.core);
    let _baseline = builder.build(&before);
    forge.rotate(m, 1, 0);
    let (_d1, after) = host_over(&forge.core);
    let diff = builder.build(&after);
    assert!(!diff.full, "a per-tick diff, not a keyframe");
    let bv = belt_in_diff(&builder, &diff, belt)
        .expect("the diff after the partner's Rotate re-emits the docked belt");
    let kinds: Vec<TileKindView> = bv.tiles.iter().map(|t| t.kind.clone()).collect();
    assert_eq!(kinds, vec![corner(2, 1), straight(0)], "with its new seam kind");
}

#[test]
fn remove_port_keeps_the_survivor_and_its_corner_and_undo_restores_its_key() {
    // THE RESEAT HOLE, history. Plan 74.1-07 pinned it at its old behaviour
    // (`remove_port_reseat_kept_dock_pins_todays_behaviour`: a re-seated survivor kept by
    // identity, a link drawn onto nothing). Plan 74.1-12 flipped it
    // (`remove_port_releases_the_moved_survivor_and_undo_restores_its_corner`: the moved
    // survivor released). RE-AUTHORED IN 74.1-16 under this title, because the survivor no
    // longer moves: the design rule is that removing an output moves no other port
    // (survivors are not auto-arranged). The subject is kept: a survivor whose belt
    // turns at its doorstep, and what its seam ships through the removal and the undo.
    //
    // MEASURED board, built through the command layer so the Undo is the real one: a
    // Router placed at (10,10), then `+ Add output` once, which grows it to 2x4:
    // `[In, Out, Out, Out, Fault, Out]`, `Out_k` (routing key k) at local (1, [1,2,0,3][k])
    // facing E, so the doorsteps are (12,11), (12,12), (12,10), (12,13). Belts: `Out_0`'s
    // runs east from (12,11); `Out_2`'s turns NORTH at once (12,10) -> (12,9); `Out_3`'s
    // runs east from (12,13). `Out_1`'s doorstep carries no belt. Before the removal
    // `Out_2`'s belt ships Corner{E, N}.
    //
    // RemovePort `Out_0` (catalog 1): the list becomes `[In, Out, Out, Fault, Out]`, the
    // box stays 2x4 and no survivor moves. The old `Out_2` is routing key 1 now, still on
    // local row 0 facing (12,10), so its belt is KEPT, re-keyed 2 -> 1, and keeps shipping
    // its corner; only `Out_0`'s own belt is released. One Undo re-adds the port on its
    // own row and the keys shift back, so the link is on key 2 again with the same corner.
    let mut session = GridSession::new(SEED);
    let m = place(&mut session, machine_kind::ROUTER, 10, 10);
    session
        .apply(GridCommand::AddPort { node: m, role: 1, side: 1, medium: 0 })
        .expect("+ Add output grows the router to four Outs");
    let m_id = id_of(&session, m);
    let ports = session.core().state.ports_of(m_id).expect("router ports").to_vec();
    let fp = session.core().state.footprint_of(m_id).expect("router footprint");
    assert_eq!((fp.w, fp.h), (2, 4), "measured: four Outs grow the router to 2x4");
    let doorstep = |p: &Port| {
        let (pcell, pside) = port_world((10, 10), fp.w, fp.h, fp.rot, p);
        let (dx, dy) = unit_delta(pside);
        (pcell.0 + dx, pcell.1 + dy)
    };
    let outs: Vec<(u16, (i32, i32))> = ports
        .iter()
        .enumerate()
        .filter(|(_, p)| p.role == Role::Out)
        .map(|(i, p)| (i as u16, doorstep(p)))
        .collect();
    assert_eq!(
        outs,
        vec![(1, (12, 11)), (2, (12, 12)), (3, (12, 10)), (5, (12, 13))],
        "measured: Out_k sits at catalog 1, 2, 3, 5 with its doorstep on rows 11, 12, 10, 13"
    );
    let b0 = draw_belt(&mut session, vec![(12, 11), (13, 11)]);
    let b2 = draw_belt(&mut session, vec![(12, 10), (12, 9)]);
    let b3 = draw_belt(&mut session, vec![(12, 13), (13, 13)]);
    for (belt, catalog) in [(b0, 1), (b2, 3), (b3, 5)] {
        session
            .apply(GridCommand::Dock { belt, endpoint: BeltEnd::Tail, node: m, port: catalog })
            .expect("a belt on a real doorstep docks");
    }
    let (b0_id, b2_id) = (id_of(&session, b0), id_of(&session, b2));
    assert_eq!(session.core().state.link_target((m_id, 2)), Some((b2_id, 0)), "Out_2 docked");
    assert_eq!(
        shipped(session.core(), b2_id),
        vec![corner(1, 0), straight(1)],
        "before the removal Out_2's belt turns at its doorstep: Corner{{from:E, to:N}}"
    );

    session
        .apply(GridCommand::RemovePort { node: m, index: 1 })
        .expect("removing Out_0 is accepted");
    let released: Vec<NodeId> = session.core().last_tick.unlinked.iter().map(|u| u.belt).collect();
    assert_eq!(released, vec![b0_id], "only the removed output's own belt is released");
    assert_eq!(
        session.core().state.link_target((m_id, 1)),
        Some((b2_id, 0)),
        "the survivor is kept, re-keyed 2 -> 1"
    );
    assert_eq!(
        session.core().state.footprint_of(m_id).map(|f| (f.w, f.h)),
        Some((2, 4)),
        "the box does not shrink"
    );
    assert_eq!(
        shipped(session.core(), b2_id),
        vec![corner(1, 0), straight(1)],
        "and the kept belt still turns at its unmoved doorstep: Corner{{from:E, to:N}}"
    );

    session.apply(GridCommand::Undo).expect("ONE Undo");
    assert_eq!(
        session.core().state.link_target((m_id, 2)),
        Some((b2_id, 0)),
        "one Undo puts the survivor back on its own key"
    );
    assert_eq!(
        shipped(session.core(), b2_id),
        vec![corner(1, 0), straight(1)],
        "with its corner unchanged"
    );
    assert_eq!(
        session.core().state.link_target((m_id, 0)),
        Some((b0_id, 0)),
        "and the released belt is re-docked on the restored output"
    );
}

/// The dry-run board of gap N4 (plan 74.1-15): main belt (4,6)->(7,6) east, side belt
/// (4,3)->(4,5) south, docked from EITHER belt. Returns the session.
fn n4_docked(drag_side: bool) -> GridSession {
    let mut session = GridSession::new(SEED);
    let main = draw_belt(&mut session, vec![(4, 6), (5, 6), (6, 6), (7, 6)]);
    let side = draw_belt(&mut session, vec![(4, 3), (4, 4), (4, 5)]);
    let cmd = if drag_side {
        // The side belt's Head dragged onto the main belt's Tail (In, port 0): refused
        // before plan 74.1-15.
        GridCommand::Dock { belt: side, endpoint: BeltEnd::Head, node: main, port: 0 }
    } else {
        // The main belt's Tail dragged onto the side belt's Head (Out, port 1).
        GridCommand::Dock { belt: main, endpoint: BeltEnd::Tail, node: side, port: 1 }
    };
    session
        .apply(cmd)
        .unwrap_or_else(|e| panic!("the N4 join is accepted (drag_side={drag_side}), got {e:?}"));
    session
}

#[test]
fn both_drag_directions_ship_the_same_corner() {
    // GAP N4 (plan 74.1-15). The same physical join made from either belt ships the same
    // tiles: the main belt's first tile (4,6) is entered travelling S and left travelling
    // E, Corner{S, E}; the side belt's last tile (4,5) is entered and left travelling S,
    // Straight{Y}. RED with plan 74.1-15's host change reverted: the side-belt direction
    // was refused, so `n4_docked(true)` panics.
    let by_main = n4_docked(false);
    let by_side = n4_docked(true);
    for (name, s) in [("main dragged", &by_main), ("side dragged", &by_side)] {
        assert_eq!(
            shipped_at(s.core(), (4, 6)),
            vec![corner(2, 1), straight(0), straight(0), straight(0)],
            "{name}: the main belt's first tile ships Corner{{from:S, to:E}}"
        );
        assert_eq!(
            shipped_at(s.core(), (4, 5)),
            vec![straight(1), straight(1), straight(1)],
            "{name}: the side belt's last tile stays Straight{{Y}}"
        );
    }
    for cell in [(4, 6), (4, 5)] {
        assert_eq!(
            shipped_at(by_main.core(), cell),
            shipped_at(by_side.core(), cell),
            "the belt at {cell:?} ships identical tiles whichever belt was dragged"
        );
    }
}

#[test]
fn a_join_where_both_ends_turn_ships_two_corners() {
    // The `seam_flow` docblock's "either belt may turn, and both may", pinned (plan
    // 74.1-15). Target belt T runs EAST (2,4) -> (4,4), Head (4,4). Carrier C runs EAST
    // (4,5) -> (6,5), Tail (4,5), directly below T's Head. The two ends are one step apart
    // and neither is the other's inner tile, so the join is accepted from either belt, and
    // items step SOUTH across the seam: T's Head is entered travelling E and left
    // travelling S, Corner{E, S}; C's Tail is entered travelling S and left travelling E,
    // Corner{S, E}. Both were refused before plan 74.1-15 (neither end pointed at the other).
    for drag_carrier in [true, false] {
        let mut session = GridSession::new(SEED);
        let t = draw_belt(&mut session, vec![(2, 4), (3, 4), (4, 4)]);
        let c = draw_belt(&mut session, vec![(4, 5), (5, 5), (6, 5)]);
        let cmd = if drag_carrier {
            GridCommand::Dock { belt: c, endpoint: BeltEnd::Tail, node: t, port: 1 }
        } else {
            GridCommand::Dock { belt: t, endpoint: BeltEnd::Head, node: c, port: 0 }
        };
        session
            .apply(cmd)
            .unwrap_or_else(|e| panic!("a jog join is accepted (drag_carrier={drag_carrier}), got {e:?}"));
        assert_eq!(
            shipped_at(session.core(), (4, 4)),
            vec![straight(0), straight(0), corner(1, 2)],
            "drag_carrier={drag_carrier}: T's Head ships Corner{{from:E, to:S}}"
        );
        assert_eq!(
            shipped_at(session.core(), (4, 5)),
            vec![corner(2, 1), straight(0), straight(0)],
            "drag_carrier={drag_carrier}: C's Tail ships Corner{{from:S, to:E}}"
        );
    }
}
