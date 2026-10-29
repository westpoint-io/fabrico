//! UNDO-04 / UNDO-05, the core half: removing an output re-points everything that was
//! keyed to it, and releases the belt that was on it.
//!
//! Since 74.1-12 the removal judges each surviving belt by identity, then facing;
//! `reseat_release.rs` pins that boundary as geometry. Every dock row here sits its belts
//! on their ports' real doorsteps, so what it judges is the re-key. Since 74.1-16 (the
//! design ruling of 2026-10-04) a removal moves no other port, so on the catalog layout a command
//! builds every surviving dock is re-keyed and kept; `catalog_layout_router` says why the
//! same-role rows are back on that board.
//!
//! Before plan 73-06 `fold_remove_port` was nine statements and not one of them mentioned
//! `routes`, `default` or `links`. So a routing rule aimed at the third output silently
//! started feeding the second, with no error and no refusal, and a belt docked to the
//! removed output kept a link naming a key that no longer existed while a belt on a
//! SURVIVING output started draining a different one.
//!
//! # Every row here drives the FOLD, and the fold is what the shipped app runs
//! The board is built out of `EditOp` records handed to `Core::advance_edits`, which is
//! the same entry the host's edit drain uses. Nothing here reaches into `GridState` to
//! hand-write a link or a port list, so there is no test-only seam holding a row up.
//!
//! # Why no assertion here compares `Port` structs
//! Until 74.1-16 every port edit re-seated each port as a pure function of its index
//! AMONG ITS ROLE, so two same-medium `Role::Out` ports could swap cells and still read as
//! byte-identical lists: a struct comparison passed on exactly the defect this file exists
//! to catch. Ports keep their slots since 74.1-16, but the rows keep their stronger oracle. Every row therefore asserts a RESOLVED DESTINATION - which node
//! `link_target` hands back, or which belt an item physically lands on.
//!
//! Run target: `cargo test -p fabrico-core --test remove_port_repoint`.

mod common;

use common::header;
use fabrico_core::core::Core;
use fabrico_core::edit::{BeltEnd, EDIT_SCHEMA_VERSION, EditOp, EditRecord, MachineConfig, PortSeat};
use fabrico_core::event::{Event, EventPayload, SCHEMA_VERSION};
use fabrico_core::ids::{Item, NodeId, PortId};
use fabrico_core::state::{
    Axis, BeltTile, Medium, Node, Port, Role, RouteKey, Side, TileKind,
};

/// The machine kind byte `fold_place` mints a `Node::Router` from. Restated locally, the
/// way `footprint_rotation.rs` does: `machine_kind` is a crate-private module and an
/// integration test names the byte at the line rather than widening the crate surface.
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

/// One `Role::Out` port on the east column at row `row`.
fn out_port(row: i32) -> Port {
    Port {
        local_offset: (1, row),
        side: Side::E,
        role: Role::Out,
        medium: Medium::Mechanical,
    }
}

/// The single `Role::In` port on the west column.
fn in_port(row: i32) -> Port {
    Port {
        local_offset: (0, row),
        side: Side::W,
        role: Role::In,
        medium: Medium::Mechanical,
    }
}

/// Place a 2x3 Router at `(0,0)` carrying `ports` VERBATIM, and return its id.
fn place_router(core: &mut Core, ports: Vec<Port>) -> NodeId {
    core.advance_edits(
        &[rec(
            1,
            0,
            EditOp::Place {
                kind: KIND_ROUTER,
                cell_x: 0,
                cell_y: 0,
                w: 2,
                h: 3,
                ports,
                rot: 0,
            },
        )],
        &[],
    );
    *core.last_tick.placed.last().expect("the router was minted")
}

/// Draw a two-tile straight belt starting at `(x, y)` running east, and return its id.
fn draw_belt(core: &mut Core, seq: u64, x: i32, y: i32) -> NodeId {
    let tick = core.tick;
    core.advance_edits(
        &[rec(
            seq,
            tick,
            EditOp::DrawBelt {
                tiles: vec![
                    BeltTile::new((x, y), TileKind::Straight { axis: Axis::X }),
                    BeltTile::new((x + 1, y), TileKind::Straight { axis: Axis::X }),
                ],
            },
        )],
        &[],
    );
    *core.last_tick.placed.last().expect("the belt was minted")
}

/// Fold one record against `core` at the current tick.
fn fold(core: &mut Core, seq: u64, op: EditOp) {
    let tick = core.tick;
    core.advance_edits(&[rec(seq, tick, op)], &[]);
}

/// Install `routes` + `default` on `router` through `fold_configure`.
fn configure(core: &mut Core, seq: u64, router: NodeId, routes: Vec<(RouteKey, PortId)>, default: Option<PortId>) {
    fold(
        core,
        seq,
        EditOp::Configure {
            node: router,
            config: MachineConfig::Router { routes, default },
            code_hash: [0u8; 32],
        },
    );
}

/// The router's live `(routes, default)`.
fn table(core: &Core, router: NodeId) -> (Vec<(RouteKey, PortId)>, Option<PortId>) {
    match core.state.node(router) {
        Some(Node::Router(r)) => (r.routes.clone(), r.default),
        other => panic!("expected a Router, got {other:?}"),
    }
}

/// A one-byte match key at offset 0.
fn key(b: u8) -> RouteKey {
    RouteKey::new(0, vec![b])
}

/// Every `(from, to)` link the grid holds, in the map's own ascending key order.
fn links(core: &Core) -> Vec<((NodeId, PortId), (NodeId, PortId))> {
    core.state.links_iter().collect()
}

/// A logged `Input` event delivering `item` into `target`'s input `port` at `tick`.
///
/// `common::fire` is deliberately NOT reused: it emits a `ManualInject`, which `admit`
/// routes only into a `Node::ManualInject`'s `pending` queue, so a `ManualInject` aimed at
/// a Router is admitted nowhere and the row would assert nothing. An `Input` pushes
/// straight into the target's inbox, which is the shape a belt delivery re-entering the
/// fold carries.
fn input(target: NodeId, seq: u64, tick: u64, item: Item) -> Event {
    Event {
        schema_version: SCHEMA_VERSION,
        partition: 0,
        sequence: seq,
        tick,
        payload: EventPayload::Input { target, port: 0, item },
    }
}

/// The three-Out board every re-point row shares: a 2x3 Router at `(0,0)` declaring
/// `[In, Out, Out, Out]` (catalog 0..3, so the Outs carry ROUTING keys 0, 1 and 2).
fn three_out_router(core: &mut Core) -> NodeId {
    place_router(core, vec![in_port(0), out_port(0), out_port(1), out_port(2)])
}

// ---------------------------------------------------------------------------
// UNDO-04: the routing table
// ---------------------------------------------------------------------------

/// RED ON HEAD BECAUSE: `fold_remove_port` never mentions `routes`. Removing the output
/// a rule names leaves that rule in the table pointing at a key that now belongs to a
/// DIFFERENT output, so the rule silently starts feeding an output it does not name.
#[test]
fn removing_an_out_drops_the_rule_that_named_it_and_decrements_the_higher_ones() {
    let mut core = Core::genesis(header(0x0073_0601));
    let router = three_out_router(&mut core);
    configure(
        &mut core,
        2,
        router,
        vec![(key(0xA), 0), (key(0xB), 1), (key(0xC), 2)],
        Some(2),
    );

    // Remove the port at CATALOG index 1, which is the FIRST Out and therefore ROUTING
    // key 0. An earlier Out, which is the case no shipped fixture covered.
    fold(&mut core, 3, EditOp::RemovePort { node: router, index: 1, restore: None });

    let (routes, default) = table(&core, router);
    assert_eq!(
        routes,
        vec![(key(0xB), 0), (key(0xC), 1)],
        "the rule that NAMED the removed key is dropped and every higher rule decrements"
    );
    assert_eq!(default, Some(1), "a default above the removed key decrements with the rules");
}

/// RED ON HEAD BECAUSE: the fold touches `default` not at all, so it keeps pointing at a
/// key that no longer exists. R-25 rules the answer: `None`, the EXISTING no-match
/// semantics, rather than a clamp onto a surviving output the user never chose.
#[test]
fn a_default_pointing_at_the_removed_output_becomes_none() {
    let mut core = Core::genesis(header(0x0073_0602));
    let router = three_out_router(&mut core);
    configure(&mut core, 2, router, vec![(key(0xC), 2)], Some(0));

    fold(&mut core, 3, EditOp::RemovePort { node: router, index: 1, restore: None });

    let (routes, default) = table(&core, router);
    assert_eq!(
        default, None,
        "a default naming the REMOVED output honestly means there is no default (R-25)"
    );
    assert_eq!(
        routes,
        vec![(key(0xC), 1)],
        "the surviving rule still decrements; only the default arm differs"
    );
}

/// RED ON HEAD BECAUSE: with the table un-re-pointed, the rule that matched `0xC` still
/// names routing key 2 while the machine now has only two Outs, so the item routes to a
/// key that is no longer an output at all and is DROPPED instead of arriving on the belt
/// the rule was drawn to.
///
/// # The belts are docked AFTER the removal, and that is what makes this row able to fail
/// This is not board-shaping to force a red; it is the ordinary gesture order. A user
/// removes an output and then draws a belt to one of the outputs that remain, and the
/// command layer computes that belt's link key from the port list AS IT IS THEN
/// (`dock_link_key`), so the belt lands on routing key 1, the key the third Out now
/// carries.
///
/// The row is written this way because a board docked BEFORE the removal cannot fail on
/// HEAD, and that is worth stating rather than discovering later: on HEAD neither the
/// rules NOR the links move, so a stale rule naming key 2 resolves through an equally
/// stale link at key 2 and the item still arrives. The two wrongs cancel and the row
/// certifies nothing. The defect only becomes observable at the first boundary where
/// something reads the LIVE port list, and a dock drawn after the removal is the earliest
/// and most ordinary such boundary.
///
/// This row asserts the RESOLVED DESTINATION - which belt physically holds the item -
/// and never a `Port` struct, for the reason stated in this file's docblock.
#[test]
fn the_item_still_leaves_on_the_output_its_rule_was_drawn_to() {
    let mut core = Core::genesis(header(0x0073_0603));
    let router = three_out_router(&mut core);
    // `0xC` is drawn to the THIRD Out, which is routing key 2 while all three exist.
    configure(&mut core, 2, router, vec![(key(0xB), 1), (key(0xC), 2)], None);

    // Remove the FIRST Out. The second and third Outs are now routing keys 0 and 1.
    fold(&mut core, 3, EditOp::RemovePort { node: router, index: 1, restore: None });

    // Two belts drawn far apart so the two destinations are never confusable, docked to
    // the keys the SURVIVING outputs carry now.
    let belt_b = draw_belt(&mut core, 4, 4, 10);
    let belt_c = draw_belt(&mut core, 5, 4, 20);
    fold(&mut core, 6, EditOp::Dock { belt: belt_b, endpoint: BeltEnd::Tail, node: router, port: 0 });
    fold(&mut core, 7, EditOp::Dock { belt: belt_c, endpoint: BeltEnd::Tail, node: router, port: 1 });

    // Fire an item matching `0xC` and let it settle onto a belt.
    core.advance(&[input(router, 1, core.tick, Item(vec![0xC, 0x01]))]);
    for _ in 0..4 {
        core.advance(&[]);
    }

    let holds = |id: NodeId| match core.state.node(id) {
        Some(Node::Belt(b)) => b.slots.iter().flatten().count(),
        other => panic!("expected a Belt, got {other:?}"),
    };
    assert_eq!(holds(belt_c), 1, "the item arrives on the belt the `0xC` rule was drawn to");
    assert_eq!(holds(belt_b), 0, "and NOT on the belt the `0xB` rule was drawn to");

    // The structural half of the same claim: no rule and no default may name an output
    // that does not exist. On HEAD `0xC` still names key 2 against two live Outs.
    let live_outs: PortId = core
        .state
        .ports_of(router)
        .expect("the router still declares ports")
        .iter()
        .filter(|p| p.role == Role::Out)
        .count()
        .try_into()
        .expect("a port count fits a PortId");
    let (routes, default) = table(&core, router);
    for (_, target) in &routes {
        assert!(*target < live_outs, "rule target {target} names one of the {live_outs} live outputs");
    }
    if let Some(d) = default {
        assert!(d < live_outs, "the default names one of the {live_outs} live outputs");
    }
}

// ---------------------------------------------------------------------------
// UNDO-05: the docks
// ---------------------------------------------------------------------------

/// The CATALOG layout a command builds: a 2x3 Router at `(0,0)` declaring
/// `[In, Out, Out, Out]` with its In on the middle row and its Outs on rows 1, 2, 0
/// (routing key k on row `[1, 2, 0][k]`, doorstep world `(2, [1, 2, 0][k])`).
///
/// MOVED BACK ONTO A COMMAND-BUILT BOARD IN 74.1-16. In 74.1-14 these rows moved to the
/// pre-74.1-14 INDEX layout (Outs on rows 0, 1, 2), because on a catalog board removing an
/// earlier Out re-seated every later one, so a same-role re-key-and-keep could not occur on
/// any board a command builds. Since the design ruling of 2026-10-04 a removal moves no other
/// port, so the case is reachable again on the catalog layout: removing routing key 0 (row
/// 1) leaves key 1 on row 2 and key 2 on row 0, re-keyed to 0 and 1, on their own rows.
fn catalog_layout_router(core: &mut Core) -> NodeId {
    place_router(core, vec![in_port(1), out_port(1), out_port(2), out_port(0)])
}

/// RED ON HEAD BECAUSE: the fold leaves every dock link key untouched, so the belt that
/// was on routing key 2 keeps naming key 2 while the surviving Outs are now keys 0 and 1.
/// Its link is dangling and the belt on key 1 has silently changed which physical output
/// feeds it.
///
/// RE-AUTHORED IN 74.1-12 (was `the_surviving_out_dock_is_re_keyed_and_the_removed_one_is_released`).
/// The belts used to sit at (4,10) and (4,20), touching no port at all. Since 74.1-12 a port
/// edit keeps a surviving belt dock only while its port still faces the belt's end, so on
/// that non-spatial board both survivors were released and the row judged an accident of
/// the board instead of the re-key. The belts now sit on their ports' real doorsteps. Since
/// 74.1-16 the board is the catalog layout a command builds (see `catalog_layout_router`),
/// where no survivor moves, so the row pins exactly what it was written for: the keys
/// follow their ports.
#[test]
fn a_surviving_out_dock_whose_port_did_not_move_is_re_keyed_and_kept() {
    let mut core = Core::genesis(header(0x0073_0604));
    let router = catalog_layout_router(&mut core);
    // Routing key 1 sits at row 2, key 2 at row 0: doorsteps (2,2) and (2,0).
    let belt_1 = draw_belt(&mut core, 2, 2, 2);
    let belt_2 = draw_belt(&mut core, 3, 2, 0);
    fold(&mut core, 4, EditOp::Dock { belt: belt_1, endpoint: BeltEnd::Tail, node: router, port: 1 });
    fold(&mut core, 5, EditOp::Dock { belt: belt_2, endpoint: BeltEnd::Tail, node: router, port: 2 });

    fold(&mut core, 6, EditOp::RemovePort { node: router, index: 1, restore: None });

    assert_eq!(
        core.state.link_target((router, 0)),
        Some((belt_1, 0)),
        "the belt that was on routing key 1 is now reached through key 0 - the SAME belt"
    );
    assert_eq!(
        core.state.link_target((router, 1)),
        Some((belt_2, 0)),
        "and the belt that was on key 2 is now reached through key 1"
    );
    assert_eq!(
        core.state.link_target((router, 2)),
        None,
        "nothing is still reachable through the vacated top key"
    );
    assert!(
        core.last_tick.unlinked.is_empty(),
        "neither belt was ON the removed output and neither port moved, so NOTHING is released"
    );
}

/// RED ON HEAD BECAUSE: nothing is released and nothing is recorded, so the belt keeps a
/// link naming an output that no longer exists.
///
/// RE-AUTHORED IN 74.1-12 (was `removing_the_docked_out_releases_exactly_one_dock`). This row
/// used to argue that the EXACTLY-ONE clause catches a geometric verdict: "reusing
/// `dock_still_reaches` here gives TWO", because the re-seat moved the surviving belt's
/// nub too. From 74.1-12 to 74.1-16 that was the intended outcome. Since 74.1-16 no survivor
/// moves on any board a command builds (per the 2026-10-04 design ruling), so this is UNDO-06's original
/// "exactly one" again, on the catalog layout (see `catalog_layout_router`): the removed
/// key 0 at row 1 and the survivor's key 2 at row 0, where it stays as key 1.
#[test]
fn removing_the_docked_out_releases_exactly_one_dock_when_no_survivor_moves() {
    let mut core = Core::genesis(header(0x0073_0605));
    let router = catalog_layout_router(&mut core);
    // Routing key 0 sits at row 1, key 2 at row 0: doorsteps (2,1) and (2,0).
    let on_removed = draw_belt(&mut core, 2, 2, 1);
    let survivor = draw_belt(&mut core, 3, 2, 0);
    fold(&mut core, 4, EditOp::Dock { belt: on_removed, endpoint: BeltEnd::Tail, node: router, port: 0 });
    fold(&mut core, 5, EditOp::Dock { belt: survivor, endpoint: BeltEnd::Tail, node: router, port: 2 });

    fold(&mut core, 6, EditOp::RemovePort { node: router, index: 1, restore: None });

    assert_eq!(core.last_tick.unlinked.len(), 1, "EXACTLY ONE dock is released: no survivor's port moves");
    let released = core.last_tick.unlinked[0];
    assert_eq!(released.belt, on_removed, "the released dock is the one that was ON the removed output");
    assert_eq!(released.node, router);
    assert_eq!(released.port, 0, "recorded in the LINK keyspace, which is what the undo re-docks with");
    assert_eq!(released.endpoint, BeltEnd::Tail);

    assert!(
        !links(&core).iter().any(|((n, p), _)| *n == router && *p == 0 && core.state.link_target((*n, *p)) == Some((on_removed, 0))),
        "NO links entry still routes the removed key to the released belt"
    );
    assert_eq!(
        core.state.link_target((router, 1)),
        Some((survivor, 0)),
        "the survivor keeps its own output, re-keyed from 2 down to 1"
    );
    assert_eq!(
        links(&core).iter().filter(|((n, _), _)| *n == router).count(),
        1,
        "one belt released and one kept leaves exactly one machine-side link"
    );
}

/// RED ON HEAD BECAUSE: nothing re-keys a Head dock either, and this is R-26's quieter
/// half that NO requirement names. A Head link key is the RAW CATALOG INDEX
/// (`state.rs`'s two-keyspaces note), and `ports.remove(idx)` shifts every catalog index
/// above `idx` down one.
///
/// RE-AUTHORED IN 74.1-12 (was `removing_an_in_re_keys_a_docked_belt_on_a_later_in`). The
/// old board removed the FIRST In of `[In, In, Out]` and fed a belt at (4,10), touching no
/// port. On real doorsteps that edit moves the later In into the earlier one's slot, so
/// since 74.1-12 its belt is released, which `reseat_release.rs` pins. This board keeps the
/// row's subject, a Head key shifting with the list while its port stays put: `[In, Out,
/// In]`, the list `+ Add input` leaves on a one-In machine. Removing the Out (catalog 1)
/// shifts the second In's catalog key 2 -> 1, and that In is still `In_1`, so its belt
/// still touches it.
///
/// THIS IS WHERE RE-KEY-AND-KEEP IS PINNED ON A BOARD A COMMAND BUILDS (74.1-14). The
/// cells are the centre-out rule's on the 2x3 Router base (layout ruling 2026-10-04): In_0
/// on row 1, the Out on row 1, In_1 on row 2 (until 74.1-14 they were the index rows 0, 0
/// and 1). Removing a port of ANOTHER role moves no In, which is why this cross-role
/// re-key keeps its belt where a same-role one cannot.
#[test]
fn removing_an_earlier_port_re_keys_a_docked_belt_on_a_later_in() {
    let mut core = Core::genesis(header(0x0073_0606));
    // In (catalog 0, row 1), Out (catalog 1, row 1), In (catalog 2, row 2).
    let router = place_router(&mut core, vec![in_port(1), out_port(1), in_port(2)]);
    // The second In faces W from (0,2), so a feeder arrives at (-1,2): tiles (-2,2), (-1,2).
    let feeder = draw_belt(&mut core, 2, -2, 2);
    fold(&mut core, 3, EditOp::Dock { belt: feeder, endpoint: BeltEnd::Head, node: router, port: 2 });

    // Remove the Out. Every catalog index above it shifts down one.
    fold(&mut core, 4, EditOp::RemovePort { node: router, index: 1, restore: None });

    assert_eq!(
        core.state.link_target((feeder, 0)),
        Some((router, 1)),
        "the surviving Head dock is decremented to the catalog index its port now occupies"
    );
    assert!(
        core.last_tick.unlinked.is_empty(),
        "the belt's own In survived and did not move, so nothing is released"
    );
    // And it still names an In: the port list is now [In, In], so catalog 1 is the In.
    match core.state.ports_of(router) {
        Some(ps) => assert_eq!(ps[1].role, Role::In, "catalog 1 is the surviving second In"),
        None => panic!("the router still declares ports"),
    }
}

/// A NEGATIVE CONTROL, and it says so out loud. RED ON HEAD BECAUSE: it is NOT. The
/// `idx >= ports.len()` guard already existed and this row pins that the new re-point and
/// de-dock work sits BEHIND it (threat T-73-06-01), rather than pinning new behaviour.
#[test]
fn a_forged_out_of_range_remove_port_index_is_a_panic_free_no_op() {
    let mut core = Core::genesis(header(0x0073_0607));
    let router = three_out_router(&mut core);
    configure(&mut core, 2, router, vec![(key(0xA), 0), (key(0xC), 2)], Some(2));
    let belt = draw_belt(&mut core, 3, 4, 10);
    fold(&mut core, 4, EditOp::Dock { belt, endpoint: BeltEnd::Tail, node: router, port: 1 });

    let before = postcard::to_allocvec(&core.state).expect("serialize GridState");
    fold(&mut core, 5, EditOp::RemovePort { node: router, index: 9999, restore: None });
    let after = postcard::to_allocvec(&core.state).expect("serialize GridState");

    assert_eq!(before, after, "a forged out-of-range index leaves the grid BYTE-identical");
    assert!(core.last_tick.unlinked.is_empty(), "and releases nothing");
}


// ── 73-12 / CR-02: a WIRE endpoint is a raw catalog index and shifts with the list ─

/// One `Role::Out` ELECTRICAL port on the east column at `row` - the only role/medium
/// pair a `Node::Wire` may leave from (`resolve_wire_leg` steps 4 and 5).
fn electrical_out(row: i32) -> Port {
    Port {
        local_offset: (1, row),
        side: Side::E,
        role: Role::Out,
        medium: Medium::Electrical,
    }
}

/// One `Role::In` ELECTRICAL port on the west column at `row` - the only role/medium pair
/// a `Node::Wire` may terminate at.
fn electrical_in(row: i32) -> Port {
    Port {
        local_offset: (0, row),
        side: Side::W,
        role: Role::In,
        medium: Medium::Electrical,
    }
}

/// The live `(from, to)` endpoints of a wire, resolved off the node itself. A wire's
/// endpoints live INSIDE its `WireLink` and only its forward `(wire, 0) -> to` edge is in
/// `links`, so a `links` read answers half the question (`GridState::docked_wires`).
fn wire_ends(core: &Core, wire: NodeId) -> ((NodeId, PortId), (NodeId, PortId)) {
    match core.state.node(wire) {
        Some(Node::Wire(w)) => (w.from, w.to),
        other => panic!("expected a Wire, got {other:?}"),
    }
}

/// Place a second 2x3 Router at `(4, 0)` carrying `ports` VERBATIM, and return its id.
fn place_router_at(core: &mut Core, seq: u64, cell_x: i32, ports: Vec<Port>) -> NodeId {
    core.advance_edits(
        &[rec(
            seq,
            0,
            EditOp::Place {
                kind: KIND_ROUTER,
                cell_x,
                cell_y: 0,
                w: 2,
                h: 3,
                ports,
                rot: 0,
            },
        )],
        &[],
    );
    *core.last_tick.placed.last().expect("the router was minted")
}

/// **THE CR-02 HEADLINE, SOURCE SIDE.** A wire leaves a machine from a RAW CATALOG INDEX.
/// Removing an EARLIER port shifts every catalog index above it down by one, so the wire's
/// source endpoint has to travel with it exactly as a Head dock's link key does.
///
/// RED ON HEAD BECAUSE: `GridState::judge_docks` collects a candidate only where the far
/// end is a `Node::Belt` (both arms carry `matches!(.., Some(Node::Belt(_)))`), so
/// `fold_remove_port` never looks at a `Node::Wire` at all. The endpoint keeps the index it
/// had and now names a different port - or, when the removed port was the last one, no port
/// at all.
#[test]
fn a_wire_source_endpoint_above_the_removed_port_is_re_pointed() {
    let mut core = Core::genesis(header(0xC0DE_0001));
    // [In@0, Out@1, ELECTRICAL Out@2] - the wire leaves catalog index 2.
    let src = place_router(&mut core, vec![in_port(0), out_port(2), electrical_out(1)]);
    let dst = place_router_at(&mut core, 2, 4, vec![electrical_in(0), out_port(2)]);
    core.advance_edits(
        &[rec(
            3,
            1,
            EditOp::DrawWire {
                from_node: src,
                from_port: 2,
                to_node: dst,
                to_port: 0,
            },
        )],
        &[],
    );
    let wire = *core.last_tick.placed.last().expect("the wire was minted");
    assert_eq!(
        wire_ends(&core, wire).0,
        (src, 2),
        "the wire leaves catalog index 2, ABOVE the port about to be removed"
    );

    // Remove catalog index 1, which sits BELOW the wire's source port.
    core.advance_edits(&[rec(4, 2, EditOp::RemovePort { node: src, index: 1, restore: None })], &[]);

    assert_eq!(
        core.state.ports_of(src).map(<[Port]>::len),
        Some(2),
        "the machine really lost a port"
    );
    assert_eq!(
        wire_ends(&core, wire).0,
        (src, 1),
        "and the wire's source endpoint decremented with the list, exactly as a Head dock's \
         link key does - it names the SAME physical port it named before"
    );
}

/// **THE CR-02 HEADLINE, TARGET SIDE**, and it is the half that mis-DELIVERS rather than
/// merely mis-draws. A wire's target endpoint is recorded twice: on the `WireLink.to`
/// field AND as the value of the `(wire, 0) -> (machine, port)` link `fold_draw_wire`
/// writes. Both are raw catalog indices and BOTH have to shift.
///
/// RED ON HEAD BECAUSE: neither moves. Items admitted to the wire are delivered into the
/// inbox bucket of whatever port now sits at the old index.
#[test]
fn a_wire_target_endpoint_above_the_removed_port_is_re_pointed_on_the_node_and_the_link() {
    let mut core = Core::genesis(header(0xC0DE_0002));
    let src = place_router(&mut core, vec![in_port(0), electrical_out(1)]);
    // [In@0, ELECTRICAL In@1, Out@2] - the wire arrives at catalog index 1.
    let dst = place_router_at(
        &mut core,
        2,
        4,
        vec![in_port(0), electrical_in(1), out_port(2)],
    );
    core.advance_edits(
        &[rec(
            3,
            1,
            EditOp::DrawWire {
                from_node: src,
                from_port: 1,
                to_node: dst,
                to_port: 1,
            },
        )],
        &[],
    );
    let wire = *core.last_tick.placed.last().expect("the wire was minted");
    assert_eq!(wire_ends(&core, wire).1, (dst, 1));
    assert_eq!(core.state.link_target((wire, 0)), Some((dst, 1)));

    // Remove catalog index 0 on the TARGET, below the wire's target port.
    core.advance_edits(&[rec(4, 2, EditOp::RemovePort { node: dst, index: 0, restore: None })], &[]);

    assert_eq!(
        wire_ends(&core, wire).1,
        (dst, 0),
        "the WireLink.to field decrements with the list"
    );
    assert_eq!(
        core.state.link_target((wire, 0)),
        Some((dst, 0)),
        "and so does the link VALUE the fold wrote beside it - the two are one endpoint \
         recorded twice and a fix that moves only one of them mis-delivers"
    );
}

/// The MIRROR: `fold_add_port` owes the same shift back, or one Ctrl+Z restores the port
/// and leaves every wire endpoint on the decremented index the removal gave it. That is
/// the identical defect on the undo path, and it is the deviation 73-06 recorded for the
/// routing table and the belt docks.
///
/// RED ON HEAD BECAUSE: neither fold touches a wire, so nothing shifts in either
/// direction. It becomes able to fail the moment the removal shifts and the insert does
/// not.
#[test]
fn re_adding_the_port_puts_every_wire_endpoint_back_where_it_was() {
    let mut core = Core::genesis(header(0xC0DE_0003));
    let src = place_router(&mut core, vec![in_port(0), out_port(2), electrical_out(1)]);
    let dst = place_router_at(&mut core, 2, 4, vec![electrical_in(0), out_port(2)]);
    core.advance_edits(
        &[rec(
            3,
            1,
            EditOp::DrawWire {
                from_node: src,
                from_port: 2,
                to_node: dst,
                to_port: 0,
            },
        )],
        &[],
    );
    let wire = *core.last_tick.placed.last().expect("the wire was minted");
    let before = wire_ends(&core, wire);

    core.advance_edits(&[rec(4, 2, EditOp::RemovePort { node: src, index: 1, restore: None })], &[]);
    // ASSERTED IN THE MIDDLE, or this row cannot fail: on a build where NEITHER fold
    // touches a wire the endpoint never moves, so the before/after comparison below
    // passes for the reason this file exists to catch. The two wrongs cancel.
    assert_eq!(
        wire_ends(&core, wire).0,
        (src, 1),
        "the removal really moved the endpoint, so the restoration below has work to do"
    );

    core.advance_edits(
        &[rec(
            5,
            3,
            // The inverse's shape: the removed port back at its index, on its own slot.
            EditOp::AddPort {
                node: src,
                port: out_port(2),
                index: 1,
                seat: PortSeat::Captured,
            },
        )],
        &[],
    );

    assert_eq!(
        wire_ends(&core, wire),
        before,
        "the insert's mirror puts the wire endpoint back on the index it named before"
    );
}

/// A wire endpoint BELOW the removed port must not move, and a wire attached to a
/// DIFFERENT machine must not move either. Without this the shift could be written as an
/// unconditional decrement and every row above would still pass.
///
/// # THIS ROW IS A DECLARED NEGATIVE CONTROL
/// RED ON HEAD BECAUSE: it is NOT. On HEAD no fold touches a wire at all, so "nothing
/// moved" is true for the wrong reason. It earns its place beside the two rows above:
/// together they pin that the shift is CONDITIONAL on the index rather than blanket.
#[test]
fn a_wire_endpoint_below_the_removed_port_and_one_on_another_machine_both_stay_put() {
    let mut core = Core::genesis(header(0xC0DE_0004));
    // [ELECTRICAL Out@0, In@1, Out@2] - the wire leaves catalog index 0, BELOW the removal.
    let src = place_router(&mut core, vec![electrical_out(0), in_port(1), out_port(2)]);
    let dst = place_router_at(&mut core, 2, 4, vec![electrical_in(0), out_port(2)]);
    core.advance_edits(
        &[rec(
            3,
            1,
            EditOp::DrawWire {
                from_node: src,
                from_port: 0,
                to_node: dst,
                to_port: 0,
            },
        )],
        &[],
    );
    let wire = *core.last_tick.placed.last().expect("the wire was minted");
    let before = wire_ends(&core, wire);

    // Remove catalog index 2 on the SOURCE - above the wire's port - and index 1 on the
    // TARGET, which is above the wire's target port 0 as well.
    core.advance_edits(&[rec(4, 2, EditOp::RemovePort { node: src, index: 2, restore: None })], &[]);
    core.advance_edits(&[rec(5, 3, EditOp::RemovePort { node: dst, index: 1, restore: None })], &[]);

    assert_eq!(
        wire_ends(&core, wire),
        before,
        "an endpoint below the removed index is untouched on BOTH machines"
    );
}

/// THE RELEASE BRANCH, reached the only way a validated log can never reach it: by handing
/// the fold a bare `RemovePort` naming the very port a cable is attached to.
///
/// `validate_normalize` refuses that command (73-12), so no `GridSession` produces this
/// record - but `Core::advance_edits` and `GridSession::replay` are both `pub` and a
/// forged or hand-edited log reaches them. The fold must leave a structurally coherent
/// board rather than a wire naming a port that no longer exists.
///
/// RED ON HEAD BECAUSE: the wire survives with `from == (src, 1)` while `src` has one port.
#[test]
fn a_forged_removal_of_the_very_port_a_wire_leaves_from_takes_the_wire_with_it() {
    let mut core = Core::genesis(header(0xC0DE_0005));
    let src = place_router(&mut core, vec![in_port(0), electrical_out(1)]);
    let dst = place_router_at(&mut core, 2, 4, vec![electrical_in(0), out_port(2)]);
    core.advance_edits(
        &[rec(
            3,
            1,
            EditOp::DrawWire {
                from_node: src,
                from_port: 1,
                to_node: dst,
                to_port: 0,
            },
        )],
        &[],
    );
    let wire = *core.last_tick.placed.last().expect("the wire was minted");
    assert!(core.state.node(wire).is_some(), "the wire is live before the removal");

    core.advance_edits(&[rec(4, 2, EditOp::RemovePort { node: src, index: 1, restore: None })], &[]);

    assert!(
        core.state.node(wire).is_none(),
        "the cable on the removed output goes with it rather than surviving as a wire \
         naming a port that does not exist"
    );
    assert!(
        core.last_tick.removed.contains(&wire),
        "and the removal is REPORTED, so the render packet can retire the cable"
    );
}
