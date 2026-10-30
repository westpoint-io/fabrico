//! CORNER-06 (phase 74.1, plan 74.1-14): on the SHIPPED demo board, the first port edit
//! on the Factory or the Router releases nothing, and one undo puts every nub back.
//!
//! # The rule these pins hold
//! The rule, verbatim: "Edits keep middle layout". The demo Factory and Router
//! are placed from the catalog. Until this plan the first `+ Add output` on the demo
//! Factory re-seated its ports by index, moved every nub and (since 74.1-12) released
//! every belt on it, and Ctrl+Z re-docked the links while the nubs stayed moved
//! (`deferred-items.md`, "From plan 74.1-12"). These pins grade what the user looks at
//! on that board: which belts stay docked, and whether each docked belt still touches
//! its nub.
//!
//! # How the board is built
//! As applier B in `demo_regenerability.rs`: a `GridSession` from `DEMO_GENESIS_SEED`
//! folding `demo_commands()` one `apply` at a time. Since plan 85-08 that list is the
//! whole board (the Route and HTTP Handler are logged commands too), and neither of them
//! touches the Factory or the Router.
//!
//! # The touch is read through the shared definitions
//! For every belt link naming the machine, the port's facing cell (`port_world`, then
//! `unit_delta`) must equal the belt's end tile (`belt_end_world`). The link-key to port
//! lookup (Head key = catalog index, Tail key = n-th Out, `FAULT_PORT` = first Fault) is
//! the keyspace table in `state.rs`. Every for-all runs over a link set measured
//! non-empty first, so a board that released everything cannot pass.
//!
//! # Why the catalog is the oracle
//! After the undo the port list is compared to the hand-written `port_catalog` arm, never
//! to a copy derived from the reseat rule (which would compare the rule to itself).
//!
//! Run target: `cargo test -p fabrico-host --test demo_first_port_edit`.

use fabrico_command::{GridLookup, GridSession, port_catalog};
use fabrico_core::edit::BeltEnd;
use fabrico_core::fault::FAULT_PORT;
use fabrico_core::ids::{NodeId, PortId};
use fabrico_core::state::{Footprint, Node, Port, Role, belt_end_world, port_world, unit_delta};
use fabrico_host::demo_scene::{DEMO_GENESIS_SEED, demo_commands};
use fabrico_protocol::{GridCommand, machine_kind};

/// The demo Factory's dense handle (`demo_scene.board.ron`: machines 0..=10 in Place order).
const FACTORY: u64 = 1;
/// The demo Router's dense handle.
const ROUTER: u64 = 7;
/// The belt from the Factory's Out to the Tee (`demo_scene.board.ron`: belts 18..=28).
const FACTORY_OUT_BELT: u64 = 19;

/// The demo board, folded headlessly.
fn demo() -> GridSession {
    let mut session = GridSession::new(DEMO_GENESIS_SEED);
    for cmd in demo_commands() {
        session.apply(cmd).expect("the session accepts every demo command");
    }
    session
}

/// The live node a dense handle names.
fn node(session: &GridSession, handle: u64) -> NodeId {
    session
        .view()
        .lookup(session.core())
        .resolve(handle)
        .expect("the handle names a live node")
}

/// The folded footprint (an absent entry is the `1x1 rot0` convention).
fn footprint(session: &GridSession, m: NodeId) -> Footprint {
    session.core().state.footprint_of(m).unwrap_or(Footprint { w: 1, h: 1, rot: 0 })
}

/// The folded port list.
fn ports(session: &GridSession, m: NodeId) -> Vec<Port> {
    session.core().state.ports_of(m).map(<[Port]>::to_vec).unwrap_or_default()
}

/// Every link naming `m`, as `(belt, end, key)`, sorted. Machine to belt is a Tail dock
/// keyed in the machine's routing keyspace; belt to machine is a Head dock keyed by the
/// machine's catalog index.
fn links_naming(session: &GridSession, m: NodeId) -> Vec<(NodeId, bool, PortId)> {
    let mut v: Vec<(NodeId, bool, PortId)> = session
        .core()
        .state
        .links_iter()
        .filter_map(|((f, fp), (t, tp))| {
            if f == m {
                Some((t, false, fp))
            } else if t == m {
                Some((f, true, tp))
            } else {
                None
            }
        })
        .collect();
    v.sort();
    v
}

/// The rot-0 port a link key names on `m` (the keyspace table in `state.rs`).
fn port_of_key(session: &GridSession, m: NodeId, key: PortId, head: bool) -> Port {
    let ps = ports(session, m);
    let p = if key == FAULT_PORT {
        ps.iter().find(|p| p.role == Role::Fault).copied()
    } else if head {
        ps.get(usize::from(key)).copied()
    } else {
        ps.iter().filter(|p| p.role == Role::Out).nth(usize::from(key)).copied()
    };
    p.unwrap_or_else(|| panic!("link key {key} (head {head}) names a port on the machine"))
}

/// Every belt link naming `m` touches its port: the port's facing cell is the belt's end
/// tile. Returns how many links were checked, so a caller can refuse an empty for-all.
fn assert_every_link_touches(session: &GridSession, m: NodeId, ctx: &str) -> usize {
    let state = &session.core().state;
    let anchor = state.cell_of(m).expect("the machine has a cell");
    let fp = footprint(session, m);
    let mut n = 0;
    for (belt, head, key) in links_naming(session, m) {
        let Some(Node::Belt(b)) = state.node(belt) else { continue };
        let end = if head { BeltEnd::Head } else { BeltEnd::Tail };
        let (end_cell, _) = belt_end_world(&b.geometry, end).expect("a drawn belt has an end");
        let port = port_of_key(session, m, key, head);
        let (pcell, side) = port_world(anchor, fp.w, fp.h, fp.rot, &port);
        let (dx, dy) = unit_delta(side);
        assert_eq!(
            (pcell.0 + dx, pcell.1 + dy),
            end_cell,
            "{ctx}: the {} link on key {key} faces its belt's end tile",
            if head { "Head" } else { "Tail" }
        );
        n += 1;
    }
    n
}

/// The released belts of the last apply, sorted.
fn released(session: &GridSession) -> Vec<NodeId> {
    let mut v: Vec<NodeId> = session.core().last_tick.unlinked.iter().map(|u| u.belt).collect();
    v.sort();
    v
}

/// `+ Add output` on the demo Factory releases nothing, keeps every link touching and
/// moves no nub; one Undo leaves every port on its catalog cell, every belt docked.
///
/// MEASURED on the demo board: the Factory at (4,2), 3x3, carries belt 18 on its In (Head,
/// key 0), belt 19 on its Out (Tail, key 0) and belt 22 on its Fault (Tail, FAULT_PORT).
///
/// RED AT THE START REVISION: the index re-seat moved all three nubs and
/// released all three belts.
#[test]
fn adding_an_output_to_the_demo_factory_releases_nothing_and_undo_restores_every_cell() {
    let mut s = demo();
    let m = node(&s, FACTORY);
    let (cat_fp, cat_ports) = port_catalog(machine_kind::FACTORY);
    assert_eq!(ports(&s, m), cat_ports, "measured: the demo Factory sits in its catalog layout");
    let before = links_naming(&s, m);
    assert_eq!(before.len(), 3, "measured: the demo Factory carries three belts (In, Out, Fault)");
    assert_eq!(assert_every_link_touches(&s, m, "the shipped board"), 3);

    s.apply(GridCommand::AddPort { node: FACTORY, role: 1, side: 1, medium: 0 })
        .expect("+ Add output on the demo Factory is accepted");
    assert_eq!(released(&s), Vec::<NodeId>::new(), "the add releases no belt");
    assert_eq!(links_naming(&s, m), before, "every link naming the Factory is kept");
    assert_eq!(assert_every_link_touches(&s, m, "after the add"), 3, "and each one touches its nub");
    let after = ports(&s, m);
    assert_eq!(&after[..cat_ports.len()], &cat_ports[..], "no existing nub moved");
    assert_eq!(footprint(&s, m), cat_fp, "a second Out fits the 3x3 box");

    s.apply(GridCommand::Undo).expect("ONE Undo");
    assert_eq!(ports(&s, m), cat_ports, "after one Ctrl+Z every port is on its catalog cell");
    assert_eq!(footprint(&s, m), cat_fp, "and the box is the catalog box");
    assert_eq!(links_naming(&s, m), before, "every belt is still docked");
    assert_eq!(assert_every_link_touches(&s, m, "after the undo"), 3, "and touching");
}

/// `+ Add output` on the demo Router grows it to 2x4 and moves only its Fault row, which
/// carries no belt on the demo board; it releases nothing and one Undo restores the
/// catalog cells.
///
/// MEASURED on the demo board: the Router at (14,0) carries belt 20 on its In (Head) and,
/// since plan 85-08 docks all three outputs (D-15), the medium, large and small lanes
/// (belts 24, 25 and 23) on its Outs (Tail, keys 0, 1 and 2); no belt names its Fault.
///
/// RED AT THE START REVISION: the index re-seat moved the first Out from row 2 to row 0
/// and released belt 14.
#[test]
fn adding_an_output_to_the_demo_router_releases_nothing_and_undo_restores_every_cell() {
    let mut s = demo();
    let m = node(&s, ROUTER);
    let (cat_fp, cat_ports) = port_catalog(machine_kind::ROUTER);
    assert_eq!(ports(&s, m), cat_ports, "measured: the demo Router sits in its catalog layout");
    let before = links_naming(&s, m);
    assert_eq!(before.len(), 4, "measured: the demo Router carries four belts (In and all three Outs)");
    assert!(
        before.iter().all(|(_, _, key)| *key != FAULT_PORT),
        "measured: no belt names the Router's Fault"
    );
    assert_eq!(assert_every_link_touches(&s, m, "the shipped board"), 4);

    s.apply(GridCommand::AddPort { node: ROUTER, role: 1, side: 1, medium: 0 })
        .expect("+ Add output on the demo Router is accepted");
    assert_eq!(released(&s), Vec::<NodeId>::new(), "the add releases no belt");
    assert_eq!(footprint(&s, m), Footprint { w: 2, h: 4, rot: 0 }, "a fourth Out grows the box to 2x4");
    let after = ports(&s, m);
    for (i, (g, c)) in after.iter().zip(cat_ports.iter()).enumerate() {
        let want_y = if c.role == Role::Fault { 3 } else { c.local_offset.1 };
        assert_eq!(
            *g,
            Port { local_offset: (c.local_offset.0, want_y), ..*c },
            "port {i}: only the Fault row moves, to the new bottom row"
        );
    }
    assert_eq!(links_naming(&s, m), before, "every link naming the Router is kept");
    assert_eq!(assert_every_link_touches(&s, m, "after the add"), 4, "and each one touches its nub");

    s.apply(GridCommand::Undo).expect("ONE Undo");
    assert_eq!(ports(&s, m), cat_ports, "after one Ctrl+Z every port is on its catalog cell");
    assert_eq!(footprint(&s, m), cat_fp, "and the box is the catalog box");
    assert_eq!(links_naming(&s, m), before, "every belt is still docked");
    assert_eq!(assert_every_link_touches(&s, m, "after the undo"), 4, "and touching");
}

/// Removing the demo Factory's only output releases the belt on it and nothing else: the
/// In and the Fault keep their cells and their belts.
///
/// RED AT THE START REVISION: the index re-seat of `[In, Fault]` moved the In to (0,0)
/// and the Fault to (0,2), releasing belts 9 and 13 as well.
#[test]
fn removing_the_demo_factorys_only_output_releases_its_belt_alone() {
    let mut s = demo();
    let m = node(&s, FACTORY);
    let out_belt = node(&s, FACTORY_OUT_BELT);
    let before = links_naming(&s, m);
    assert_eq!(before.len(), 3, "measured: three belts on the demo Factory");
    assert!(
        before.iter().any(|(b, head, key)| *b == out_belt && !*head && *key == 0),
        "measured: belt 19 is Tail-docked to the Factory's only Out"
    );

    s.apply(GridCommand::RemovePort { node: FACTORY, index: 1 })
        .expect("removing the Factory's Out is accepted");
    assert_eq!(released(&s), vec![out_belt], "only the removed output's belt is released");
    let kept: Vec<_> = before.iter().filter(|(b, _, _)| *b != out_belt).copied().collect();
    assert_eq!(links_naming(&s, m), kept, "the In and Fault belts stay docked");
    assert_eq!(assert_every_link_touches(&s, m, "after the removal"), 2, "and touch their nubs");
}
