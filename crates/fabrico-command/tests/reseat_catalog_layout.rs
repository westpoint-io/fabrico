//! CORNER-06 (phase 74.1, plan 74.1-14): a port edit lays ports out the way the catalog
//! does, so a machine's first port edit moves nothing.
//!
//! # The ruling these pins hold
//! The chosen option (2026-10-04) among those plan 74.1-12 left open, verbatim:
//! "Edits keep middle layout". Until this plan `reseat_ports` seated the k-th port of a
//! role at row k, while the catalog seats the Factory's In and Out on its middle row and
//! the Router's Outs at rows 2, 0, 1. So the first port edit on any catalog-placed
//! machine moved every nub, and since 74.1-12 that released every belt on it. The fix is
//! a centre-out fill anchored on the CATALOG box: on a side of length B, with
//! `c = (B - 1) / 2`, the k-th port of a role takes `c` for k = 0, then alternates below
//! and above the centre (`c + 1`, `c - 1`, ...) until the side is used, then takes `k`.
//!
//! # Why every pin compares the hand-written catalog to the fold
//! `port_catalog` is written out by hand, arm by arm. The fold's output is what a user's
//! edit produces. A pin that compared the fold to a catalog DERIVED from the same rule
//! would compare the rule to itself and pass whatever the rule did. So every pin here
//! drives the public `GridSession::apply` seam (the producer the UI is) and reads the
//! folded `ports_of`, `footprint_of` and `last_tick.unlinked`, against the literal arms.
//!
//! # Which kinds are swept
//! Every byte for which `kind_has_catalog_arm` is true, walked over the whole `u8` range,
//! minus BELT (its `Place` is refused by design) and LABEL (a port-less note, phase 76). The
//! count is asserted to be nine, so a new arm is swept the day it lands and an empty sweep
//! cannot pass.
//!
//! # The one named exception, and the change 74.1-16 made to it
//! ENDPOINT's catalog box is 1x1 with its In and Out on the one cell. An In-plus-Out list
//! needs a column each, so the first port edit grows it to a 2-wide box and moves its Out
//! one cell east (the jump `port_catalog`'s ENDPOINT arm documents). Until 74.1-16 no
//! undo could shrink it back, so an AddPort-then-Undo left a 2x1 box. Since 74.1-16 the
//! inverse of an `AddPort` carries the box it grew from (`RemovePort.restore`), so the
//! undo returns ENDPOINT to its 1x1 catalog box with both ports back on (0,0), like every
//! other catalog arm. Its ports are electrical: a wire keeps the identity verdict and has
//! no doorstep, so the jump releases nothing. It is still asserted as itself.
//!
//! # Since 74.1-16 port edits seat by first free slot
//! A port edit no longer re-seats the list through `reseat_ports`: a new port takes the
//! first free slot of its role and no existing port moves. On a hole-free list the two
//! rules agree, which `seating_each_catalog_arm_port_by_port_reproduces_the_arm` pins.
//!
//! Run target: `cargo test -p fabrico-command --test reseat_catalog_layout`.

use fabrico_command::{GridSession, kind_has_catalog_arm, port_catalog};
use fabrico_core::ids::NodeId;
use fabrico_core::state::{Footprint, Medium, Port, Role, Side};
use fabrico_protocol::{GridCommand, machine_kind, port_medium, port_role};

const SEED: u64 = 0xFAB_1414;

/// Every machine here is anchored at (10,10) on its own fresh session, so a grown box
/// can never collide with another machine.
const ANCHOR: (i32, i32) = (10, 10);

/// The kinds the catalog places: every `kind_has_catalog_arm` byte except BELT and LABEL.
///
/// LABEL (phase 76) is the second named exclusion, and for the same kind of reason BELT is:
/// it is placeable but it is not a MACHINE WITH PORTS. A label's catalog arm is a 4 by 1 box
/// with an EMPTY port list (it is a note, D-07), so every sweep below - re-seating a port
/// list, appending a port, editing and undoing one - has nothing to measure on it, and port
/// edits on a label are refused outright by plan 76-04. Its box is covered where it can
/// fail: the W1 base-parity loop and `label.rs`.
fn catalog_kinds() -> Vec<u8> {
    assert!(
        kind_has_catalog_arm(machine_kind::LABEL) && port_catalog(machine_kind::LABEL).1.is_empty(),
        "the LABEL exclusion below is only honest while a label has a catalog arm and no ports"
    );
    let kinds: Vec<u8> = (0..=u8::MAX)
        .filter(|k| {
            kind_has_catalog_arm(*k) && *k != machine_kind::BELT && *k != machine_kind::LABEL
        })
        .collect();
    assert_eq!(
        kinds.len(),
        9,
        "nine placeable catalog kinds (SOURCE, FACTORY, TEE, BALANCER, ROUTER, MERGE, SINK, \
         ENDPOINT, HANDLER); a new arm must be swept here, and an empty sweep cannot pass"
    );
    kinds
}

/// A fresh session holding one `kind` placed at [`ANCHOR`]: `(session, id, handle)`.
fn placed(kind: u8) -> (GridSession, NodeId, u64) {
    let mut session = GridSession::new(SEED);
    session
        .apply(GridCommand::Place {
            kind,
            cell_x: ANCHOR.0,
            cell_y: ANCHOR.1,
        })
        .unwrap_or_else(|e| panic!("kind {kind}: a Place on a clear patch is accepted: {e:?}"));
    let id = *session.core().last_tick.placed.last().expect("the Place minted a node");
    let handle = session.view().handle_of(id).expect("the node got a handle");
    (session, id, handle)
}

/// The folded footprint (an absent entry is the `1x1 rot0` convention).
fn footprint(session: &GridSession, id: NodeId) -> Footprint {
    session
        .core()
        .state
        .footprint_of(id)
        .unwrap_or(Footprint { w: 1, h: 1, rot: 0 })
}

/// The folded port list.
fn ports(session: &GridSession, id: NodeId) -> Vec<Port> {
    session
        .core()
        .state
        .ports_of(id)
        .map(<[Port]>::to_vec)
        .unwrap_or_default()
}

/// The medium a new port of `role` takes on `kind`: the medium of the kind's own first
/// port of that role, or Mechanical where it has none.
fn medium_for(kind: u8, role: Role) -> Medium {
    port_catalog(kind)
        .1
        .iter()
        .find(|p| p.role == role)
        .map_or(Medium::Mechanical, |p| p.medium)
}

/// The wire bytes for an `AddPort` of `role` at `medium`.
fn add_port(session: &mut GridSession, handle: u64, role: Role, medium: Medium) {
    let (role_b, side_b) = match role {
        Role::In => (port_role::IN, Side::W as u8),
        Role::Out => (port_role::OUT, Side::E as u8),
        Role::Fault => (port_role::FAULT, Side::S as u8),
    };
    let medium_b = match medium {
        Medium::Mechanical => port_medium::MECHANICAL,
        Medium::Electrical => port_medium::ELECTRICAL,
    };
    session
        .apply(GridCommand::AddPort {
            node: handle,
            role: role_b,
            side: side_b,
            medium: medium_b,
        })
        .unwrap_or_else(|e| panic!("an AddPort of {role:?} on a clear patch is accepted: {e:?}"));
}

/// One AddPort of an Out, then one Undo: every catalog machine is back on its catalog
/// cells and its catalog box. ENDPOINT included since 74.1-16 (a named change: its
/// AddPort-then-Undo used to keep the 2x1 jump; the inverse now restores the box).
///
/// RED AT THE START REVISION: the Factory, Handler and Router come back on
/// the index rows (`In` at (0,0), the Factory's `Out` at (2,0), its `Fault` at (0,2)),
/// because the undo's own re-seat is by index and the catalog is not.
#[test]
fn a_port_edit_and_its_undo_leave_every_catalog_machine_on_its_catalog_cells() {
    let mut wrong = Vec::new();
    for kind in catalog_kinds() {
        let (mut session, id, handle) = placed(kind);
        let (cat_fp, cat_ports) = port_catalog(kind);
        // Measured before the edit: the Place froze the catalog verbatim.
        assert_eq!(ports(&session, id), cat_ports, "kind {kind}: the Place seats the catalog");
        assert_eq!(footprint(&session, id), cat_fp, "kind {kind}: the Place takes the catalog box");

        add_port(&mut session, handle, Role::Out, medium_for(kind, Role::Out));
        if kind == machine_kind::ENDPOINT {
            assert_eq!(
                footprint(&session, id).w,
                2,
                "ENDPOINT: the add makes the documented jump to a 2-wide box"
            );
        }
        session.apply(GridCommand::Undo).expect("ONE Undo of the AddPort");

        let got_ports = ports(&session, id);
        let got_fp = footprint(&session, id);
        if kind == machine_kind::ENDPOINT {
            // The named exception, changed in 74.1-16: the add still makes the 2-wide jump
            // (asserted on the way), and the undo now takes it back to the 1x1 catalog box.
            assert!(
                session.core().last_tick.unlinked.is_empty(),
                "ENDPOINT: the undo releases nothing (its ports are electrical)"
            );
            assert_eq!(got_fp, cat_fp, "ENDPOINT: the undo restores the 1x1 catalog box (74.1-16)");
            assert_eq!(got_ports, cat_ports, "ENDPOINT: both ports back on (0,0)");
            continue;
        }
        if got_ports != cat_ports || got_fp != cat_fp {
            wrong.push(format!(
                "kind {kind}: after AddPort + Undo got box {got_fp:?} ports {:?}, want box {cat_fp:?} ports {:?}",
                got_ports.iter().map(|p| (p.role, p.local_offset)).collect::<Vec<_>>(),
                cat_ports.iter().map(|p| (p.role, p.local_offset)).collect::<Vec<_>>(),
            ));
        }
    }
    assert!(wrong.is_empty(), "catalog machines not restored by one undo:\n{}", wrong.join("\n"));
}

/// One appended port of ANY role moves no existing port, except where the box grows: a
/// taller box moves the Fault row to the new bottom row, a wider box moves the Out column
/// to the new east column. Both exceptions are read from the MEASURED folded box.
///
/// RED AT THE START REVISION: on the Factory and Handler every append re-seats the In
/// from (0,1) to (0,0); on the Router the first Out moves from row 2 to row 0.
#[test]
fn an_append_moves_no_existing_port_except_where_the_box_grows() {
    let mut wrong = Vec::new();
    let mut cases = 0;
    for kind in catalog_kinds() {
        for role in [Role::In, Role::Out, Role::Fault] {
            let (mut session, id, handle) = placed(kind);
            let (cat_fp, cat_ports) = port_catalog(kind);
            add_port(&mut session, handle, role, medium_for(kind, role));
            cases += 1;
            let got = ports(&session, id);
            let fp = footprint(&session, id);
            assert_eq!(got.len(), cat_ports.len() + 1, "kind {kind} + {role:?}: one port appended");
            assert_eq!(got.last().map(|p| p.role), Some(role), "kind {kind}: the append is last");
            let taller = fp.h > cat_fp.h;
            let wider = fp.w > cat_fp.w;
            for (i, (g, c)) in got.iter().zip(cat_ports.iter()).enumerate() {
                let want_x = if c.role == Role::Out && wider { i32::from(fp.w) - 1 } else { c.local_offset.0 };
                let want_y = if c.role == Role::Fault && taller { i32::from(fp.h) - 1 } else { c.local_offset.1 };
                let want = Port { local_offset: (want_x, want_y), ..*c };
                if *g != want {
                    wrong.push(format!(
                        "kind {kind} + {role:?} (box {}x{} from {}x{}): port {i} {:?} at {:?}, want {:?}",
                        fp.w, fp.h, cat_fp.w, cat_fp.h, c.role, g.local_offset, want.local_offset
                    ));
                }
            }
        }
    }
    assert_eq!(cases, 27, "nine kinds times three roles");
    assert!(wrong.is_empty(), "an append moved an existing port:\n{}", wrong.join("\n"));
}

/// The cells of the ports of `role`, in role order, as `(x, y)`.
fn role_cells(session: &GridSession, id: NodeId, role: Role) -> Vec<(i32, i32)> {
    ports(session, id).iter().filter(|p| p.role == role).map(|p| p.local_offset).collect()
}

/// The Factory's three-long sides fill middle, then below, then above, then grow.
///
/// Outs read port by port, by role index, after each `+ Add output`: rows [1,2], then
/// [1,2,0], then [1,2,0,3] in a 3x4 box, then [1,2,0,3,4] in a 3x5 box. The fifth Out is
/// there for one wrong rule: a centre taken from the CURRENT box instead of the catalog
/// box agrees with this rule up to a 4-tall box (`(4 - 1) / 2 == 1`) and parts from it at
/// 5 tall (`(5 - 1) / 2 == 2`). Ins fill the W column the same way; Faults fill the S
/// row's columns [1,2], [1,2,0], [1,2,0,3] in a 4-wide box.
///
/// RED AT THE START REVISION: the index rule gives rows [0,1], [0,1,2], ...
#[test]
fn the_slots_on_each_side_fill_middle_then_below_then_above() {
    // Outs.
    let (mut s, id, h) = placed(machine_kind::FACTORY);
    let mut seen = Vec::new();
    for _ in 0..4 {
        add_port(&mut s, h, Role::Out, Medium::Mechanical);
        let cells = role_cells(&s, id, Role::Out);
        assert!(cells.iter().all(|c| c.0 == i32::from(footprint(&s, id).w) - 1), "Outs on the E column");
        seen.push((cells.iter().map(|c| c.1).collect::<Vec<_>>(), footprint(&s, id)));
    }
    assert_eq!(
        seen,
        vec![
            (vec![1, 2], Footprint { w: 3, h: 3, rot: 0 }),
            (vec![1, 2, 0], Footprint { w: 3, h: 3, rot: 0 }),
            (vec![1, 2, 0, 3], Footprint { w: 3, h: 4, rot: 0 }),
            (vec![1, 2, 0, 3, 4], Footprint { w: 3, h: 5, rot: 0 }),
        ],
        "Factory Out rows by role index: middle, below, above, then grown rows"
    );

    // Ins.
    let (mut s, id, h) = placed(machine_kind::FACTORY);
    let mut seen = Vec::new();
    for _ in 0..3 {
        add_port(&mut s, h, Role::In, Medium::Mechanical);
        let cells = role_cells(&s, id, Role::In);
        assert!(cells.iter().all(|c| c.0 == 0), "Ins on the W column");
        seen.push((cells.iter().map(|c| c.1).collect::<Vec<_>>(), footprint(&s, id)));
    }
    assert_eq!(
        seen,
        vec![
            (vec![1, 2], Footprint { w: 3, h: 3, rot: 0 }),
            (vec![1, 2, 0], Footprint { w: 3, h: 3, rot: 0 }),
            (vec![1, 2, 0, 3], Footprint { w: 3, h: 4, rot: 0 }),
        ],
        "Factory In rows by role index"
    );

    // Faults.
    let (mut s, id, h) = placed(machine_kind::FACTORY);
    let mut seen = Vec::new();
    for _ in 0..3 {
        add_port(&mut s, h, Role::Fault, Medium::Mechanical);
        let cells = role_cells(&s, id, Role::Fault);
        assert!(cells.iter().all(|c| c.1 == i32::from(footprint(&s, id).h) - 1), "Faults on the S row");
        seen.push((cells.iter().map(|c| c.0).collect::<Vec<_>>(), footprint(&s, id)));
    }
    assert_eq!(
        seen,
        vec![
            (vec![1, 2], Footprint { w: 3, h: 3, rot: 0 }),
            (vec![1, 2, 0], Footprint { w: 3, h: 3, rot: 0 }),
            (vec![1, 2, 0, 3], Footprint { w: 4, h: 3, rot: 0 }),
        ],
        "Factory Fault columns by role index"
    );
}

/// A two-long side keeps the index slots the rule before this plan gave: the Tee's Outs
/// are rows [0,1] as placed, then [0,1,2] in a 2x3 box.
///
/// GREEN AT THE START REVISION BY DESIGN: on a 1- or 2-long side the centre-out fill and
/// the index rule agree, which is why the Tee, Balancer, Merge, Source, Sink and Endpoint
/// boards never moved. This pin holds that agreement.
#[test]
fn a_two_long_side_keeps_the_index_slots() {
    let (mut s, id, h) = placed(machine_kind::TEE);
    let rows = |s: &GridSession| role_cells(s, id, Role::Out).iter().map(|c| c.1).collect::<Vec<_>>();
    assert_eq!(rows(&s), vec![0, 1], "the Tee as placed");
    add_port(&mut s, h, Role::Out, Medium::Mechanical);
    assert_eq!(rows(&s), vec![0, 1, 2], "a third Out takes row 2");
    assert_eq!(footprint(&s, id), Footprint { w: 2, h: 3, rot: 0 }, "in a 2x3 box");
}

/// The rule itself: `reseat_ports(base, catalog box, catalog ports) == catalog ports` for
/// every catalog arm, ENDPOINT included (its catalog box is 1x1, so seated in its own box
/// its Out stays on (0,0)). The catalog is the hand-written literal arm; the rule is the
/// pure function every port-edit fold calls. Added in task 2, once the signature exists.
#[test]
fn reseat_ports_reproduces_every_catalog_arm_exactly() {
    for kind in catalog_kinds() {
        let (box_, cat_ports) = port_catalog(kind);
        assert_eq!(
            fabrico_core::state::reseat_ports(box_, box_.w, box_.h, &cat_ports),
            cat_ports,
            "kind {kind}: the catalog arm is a fixed point of the reseat rule"
        );
    }
}

/// The Auto-seat property (74.1-16): seating a catalog arm's ports ONE AT A TIME from an
/// empty list, each at the append position with `PortSeat::Auto`, starting from the
/// catalog box, reproduces the arm exactly. This is where the first-free-slot rule and the
/// fresh-layout rule (`reseat_ports`) are held to agree on a hole-free fill.
///
/// ENDPOINT is the named exception and is asserted as itself: its catalog puts the In and
/// the Out on the one cell of a 1x1 box, which no seat rule produces (an In and an Out
/// need a column each, so the Out lands one column east in a 2x1 box).
#[test]
fn seating_each_catalog_arm_port_by_port_reproduces_the_arm() {
    use fabrico_core::edit::PortSeat;
    use fabrico_core::state::add_port_geometry;
    for kind in catalog_kinds() {
        let (box_, cat_ports) = port_catalog(kind);
        let mut fp = box_;
        let mut ports: Vec<Port> = Vec::new();
        let mut anchor = ANCHOR;
        for p in &cat_ports {
            let index = u16::try_from(ports.len()).expect("fits");
            let blank = Port { local_offset: (0, 0), side: Side::N, ..*p };
            let g = add_port_geometry(box_, anchor, fp, &ports, index, blank, PortSeat::Auto);
            anchor = g.anchor;
            fp = g.footprint;
            ports = g.ports;
        }
        assert_eq!(anchor, ANCHOR, "kind {kind}: a rot-0 fill never moves the anchor");
        if kind == machine_kind::ENDPOINT {
            assert_eq!(fp, Footprint { w: 2, h: 1, rot: 0 }, "ENDPOINT: In and Out take a column each");
            assert_eq!(ports[0], cat_ports[0], "ENDPOINT: the In on its catalog cell");
            assert_eq!(ports[1], Port { local_offset: (1, 0), ..cat_ports[1] }, "ENDPOINT: the Out one column east");
            continue;
        }
        assert_eq!(fp, box_, "kind {kind}: the fill stays in the catalog box");
        assert_eq!(ports, cat_ports, "kind {kind}: the Auto fill reproduces the catalog arm");
    }
}
