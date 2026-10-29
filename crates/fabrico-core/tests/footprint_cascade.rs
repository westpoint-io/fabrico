//! FOOT-04 cascade-detach behaviour spec — the AR-3 landmine plan (10-05).
//!
//! Deleting (or moving) a multi-cell machine must:
//!   1. free its WHOLE footprint (every occupancy cell, not just the anchor) and
//!      its `footprints`/`ports` entries, atomically;
//!   2. cascade-detach every docked Wire-minted belt in `(NodeId, PortId)`
//!      ascending order (the `links` `BTreeMap` key order) — each detached belt is
//!      removed from `GridState` AND its scheduler wake cleared (the AR-3 pairing
//!      `fold_delete` already uses for the primary node, Pitfall 4), so neither a
//!      stray `in_flight` item nor a dangling `wake_wheel` entry survives;
//!   3. DROP any in-flight item on a detached belt via the certified missing-link
//!      no-op (Q3 — NOT a fault): the item is conserved (dropped, never
//!      resurrected downstream), and the post-cascade snapshot still passes the
//!      trust gate (no `BeltWakeMissing` / `DanglingSchedule`);
//!   4. replay deterministically (building+deleting the same topology twice yields
//!      byte-identical snapshots).
//!
//! These tests drive the PUBLIC fold path (`advance_edits` with an
//! `EditOp::Delete` record) + the snapshot/restore trust-gate oracle, so they are
//! stable across the Task-2 `remove_node` signature change. `restore(&snapshot)`
//! runs `validate_invariants`, so `is_ok()` IS the AR-3 no-trip proof.
//!
//! Run target: `cargo test -p fabrico-core --test footprint_cascade`.

use fabrico_core::core::Core;
use fabrico_core::edit::{EDIT_SCHEMA_VERSION, EditOp, EditRecord};
use fabrico_core::event::{DecodeError, Event, EventPayload, LogHeader, SCHEMA_VERSION, StateInvariant};
use fabrico_core::ids::{Item, NodeId};
use fabrico_core::snapshot::{restore, snapshot};
use fabrico_core::state::{Node, cells_of_footprint};

/// A genesis header carrying `seed`.
fn header(seed: u64) -> LogHeader {
    LogHeader {
        schema_version: SCHEMA_VERSION,
        seed,
    }
}

/// An `EditOp::Delete` record for `node`, stamped at `tick`. `kind`/cell are
/// head/append-aware provenance the fold ignores (it removes by id), so a
/// placeholder is faithful.
fn edit_delete(node: NodeId, seq: u64, tick: u64) -> EditRecord {
    EditRecord {
        schema_version: EDIT_SCHEMA_VERSION,
        partition: 0,
        sequence: seq,
        tick,
        action: 0,
        op: EditOp::Delete {
            node,
            kind: 0,
            cell_x: 0,
            cell_y: 0,
            // 12-02: the Delete-capture field exists but stays default-empty (the
            // fold ignores it; behavior is byte-identical).
            captured: Default::default(),
        },
    }
}

/// One `ManualInject` event stamped at `tick`.
fn inject(target: NodeId, seq: u64, tick: u64, item: Item) -> Event {
    Event {
        schema_version: SCHEMA_VERSION,
        partition: 0,
        sequence: seq,
        tick,
        payload: EventPayload::ManualInject {
            target,
            port: 0,
            item,
        },
    }
}

/// The deterministic cascade-detach order: every docked Wire-minted belt of `node`
/// in `links` `BTreeMap` key order — the SAME order `remove_node` must use. Used to
/// assert the recorded removal order without hard-coding NodeId values.
fn expected_cascade_order(core: &Core, node: NodeId) -> Vec<NodeId> {
    let mut belts = Vec::new();
    for (from, to) in core.state.links_iter() {
        let other = if from.0 == node {
            Some(to.0)
        } else if to.0 == node {
            Some(from.0)
        } else {
            None
        };
        if let Some(o) = other
            && matches!(core.state.node(o), Some(Node::Belt(_)))
            && !belts.contains(&o)
        {
            belts.push(o);
        }
    }
    belts
}

#[test]
fn delete_cascade_detaches_docked_belts_and_frees_whole_footprint() {
    // A multi-cell machine M (2×3 ROUTER footprint) with an input-docked and an
    // output-docked Wire-minted belt. Deleting M must free all 6 footprint cells
    // and detach BOTH belts (nodes + links), in deterministic link-key order.
    let mut core = Core::genesis(header(1));
    let m = core.state.add_router(Vec::new(), Some(0));
    core.state.claim_footprint(m, (10, 10), 2, 3, 0);
    let s = core.state.add_source();
    let c = core.state.add_source(); // collector (ignores input)
    let belt_in = core.state.add_belt(0); // s -> belt_in -> m  (docked to m input)
    let belt_out = core.state.add_belt(0); // m -> belt_out -> c (docked to m output)
    core.state.link((s, 0), (belt_in, 0));
    core.state.link((belt_in, 0), (m, 0));
    core.state.link((m, 1), (belt_out, 0));
    core.state.link((belt_out, 0), (c, 0));

    // Sanity: the whole 2×3 footprint is occupied by M before the delete.
    for cell in cells_of_footprint((10, 10), 2, 3, 0) {
        assert_eq!(core.state.occupied(cell), Some(m), "M claims its whole footprint");
    }

    // The deterministic detach order, computed BEFORE the delete (links vanish after).
    let expected = expected_cascade_order(&core, m);
    assert_eq!(expected.len(), 2, "both docked belts are in the cascade set");

    core.advance_edits(&[edit_delete(m, 1, 0)], &[]);

    // (1) M gone + WHOLE footprint freed (not just the anchor).
    assert!(core.state.node(m).is_none(), "M is removed");
    assert!(core.state.footprint_of(m).is_none(), "M's footprint entry is freed");
    for cell in cells_of_footprint((10, 10), 2, 3, 0) {
        assert_eq!(core.state.occupied(cell), None, "every footprint cell is freed");
    }
    // (2) BOTH docked belts cascade-detached (nodes gone).
    assert!(core.state.node(belt_in).is_none(), "input-docked belt detached");
    assert!(core.state.node(belt_out).is_none(), "output-docked belt detached");
    // No surviving link references M or a detached belt.
    for (from, to) in core.state.links_iter() {
        assert!(![m, belt_in, belt_out].contains(&from.0), "no dangling link source");
        assert!(![m, belt_in, belt_out].contains(&to.0), "no dangling link target");
    }
    // Cascade order: primary first, then the docked belts in link-key order.
    assert_eq!(core.last_tick.removed.first().copied(), Some(m), "M removed first");
    assert_eq!(
        core.last_tick.removed[1..].to_vec(),
        expected,
        "docked belts detach in (NodeId,PortId) ascending order"
    );
    // AR-3 no-trip: the post-cascade snapshot passes the trust gate.
    assert!(restore(&snapshot(&core)).is_ok(), "no BeltWakeMissing / DanglingSchedule");
}

#[test]
fn delete_drops_in_flight_items_on_detached_belts_with_no_resurrection() {
    // Q3 item conservation: an item in-flight on a cascade-detached belt DROPS
    // (count conserved, nothing resurfaces downstream), and AR-3 holds after.
    // Topology: S -> beltA(5) -> M -> beltC(5) -> C. Fire one item; it rides beltA
    // in-flight; delete M mid-flight (detaching BOTH beltA and beltC); the item is
    // gone and C never receives anything.
    let mut core = Core::genesis(header(7));
    let s = core.state.add_source();
    let m = core.state.add_source(); // a plain machine with an in + out dock
    let c = core.state.add_source(); // downstream collector
    let belt_a = core.state.add_belt(5);
    let belt_c = core.state.add_belt(5);
    core.state.link((s, 0), (belt_a, 0));
    core.state.link((belt_a, 0), (m, 0));
    core.state.link((m, 0), (belt_c, 0));
    core.state.link((belt_c, 0), (c, 0));

    // Fire one item; S emits it onto beltA (a future arrival wake is scheduled).
    core.advance(&[inject(s, 1, 0, Item(vec![0xAB]))]);
    assert!(core.sched.pending_wakes() > 0, "beltA scheduled an in-flight arrival");

    // Mid-flight: delete M. beltA (carrying the item) + beltC cascade-detach.
    core.advance_edits(&[edit_delete(m, 2, 1)], &[]);
    assert!(core.state.node(m).is_none(), "M gone mid-flow");
    assert!(core.state.node(belt_a).is_none(), "in-flight-carrying belt detached");
    assert!(core.state.node(belt_c).is_none(), "output-docked belt detached");

    // Advance well past the original arrival: no panic on a dead scheduled id; the
    // item never resurfaces at the (now-detached) collector.
    for _ in 0..8 {
        core.advance(&[]);
    }
    assert!(core.state.node(c).is_some(), "the untouched collector survives");
    assert!(
        core.state.inbox_of(c).is_some_and(|i| i.is_empty()),
        "the in-flight item DROPPED (conserved, never resurrected downstream)"
    );
    // AR-3 no-trip after the in-flight cascade.
    assert!(restore(&snapshot(&core)).is_ok(), "no BeltWakeMissing / DanglingSchedule");
}

#[test]
fn delete_with_cascade_is_byte_deterministic() {
    // Building + deleting the same multi-cell-with-docked-belts topology (with an
    // in-flight item) twice yields byte-identical snapshots — the cascade order and
    // the in-flight DROP are deterministic across replays.
    let build = || {
        let mut core = Core::genesis(header(0xC0FFEE));
        let s = core.state.add_source();
        let m = core.state.add_router(Vec::new(), Some(0));
        core.state.claim_footprint(m, (4, 4), 2, 3, 0);
        let c = core.state.add_source();
        let belt_in = core.state.add_belt(5);
        let belt_out = core.state.add_belt(5);
        core.state.link((s, 0), (belt_in, 0));
        core.state.link((belt_in, 0), (m, 0));
        core.state.link((m, 1), (belt_out, 0));
        core.state.link((belt_out, 0), (c, 0));
        core.advance(&[inject(s, 1, 0, Item(vec![0x5A]))]);
        core.advance_edits(&[edit_delete(m, 2, 1)], &[]);
        for _ in 0..6 {
            core.advance(&[]);
        }
        core
    };
    assert_eq!(
        snapshot(&build()),
        snapshot(&build()),
        "delete-with-cascade replays byte-identically"
    );
}

// ============================================================================
// 63-06: the WIRE half of the cascade.
//
// `docked_wire_belts` matches `Node::Belt` only, so a `Node::Wire` attached to a
// deleted machine was neither cascaded nor captured. That is not untidy, it is a
// save-then-refuse-to-load defect: `snapshot.rs` invariant 8 rejects a grid holding a
// `Node::Wire` whose `from` or `to` names a node that is not live, as
// `StateInvariant::DanglingWireEndpoint`.
//
// The SOURCE-side case has its own test because it is the case a `links`-only walk
// structurally cannot see: `fold_draw_wire` writes only the `(wire, 0) -> to` entry, so
// a wire whose SOURCE is the deleted node appears in `links` nowhere. That is the
// demo scene's endpoint, and it is why the wire cascade walks `nodes`.
// ============================================================================

/// A `NodeId` that names no node in ANY grid - a slot freed and re-issued in a
/// FOREIGN slotmap, so its version can never collide with a live id here. Used to
/// forge the pre-fix state directly (the negative control).
fn ghost_id() -> NodeId {
    let mut foreign: slotmap::SlotMap<NodeId, ()> = slotmap::SlotMap::with_key();
    let k = foreign.insert(());
    foreign.remove(k);
    foreign.insert(())
}

/// An `EditOp::Rotate` record for `node`, stamped at `tick`.
fn edit_rotate(node: NodeId, new_rot: u8, seq: u64, tick: u64) -> EditRecord {
    EditRecord {
        schema_version: EDIT_SCHEMA_VERSION,
        partition: 0,
        sequence: seq,
        tick,
        action: 0,
        op: EditOp::Rotate { node, old_rot: 0, new_rot },
    }
}

/// Every live `Node::Wire` id, in ascending order.
fn wire_ids(core: &Core) -> Vec<NodeId> {
    core.state
        .node_ids()
        .filter(|id| matches!(core.state.node(*id), Some(Node::Wire(_))))
        .collect()
}

#[test]
fn delete_of_a_wire_target_machine_cascades_the_wire() {
    // The wire delivers INTO `b`. Deleting `b` must remove the wire too - otherwise a
    // `Node::Wire` survives naming a dead `to`.
    let mut core = Core::genesis(header(63_061));
    let a = core.state.add_source();
    let b = core.state.add_source();
    let wire = core.state.add_wire((a, 0), (b, 0));
    core.state.link((wire, 0), (b, 0));

    core.advance_edits(&[edit_delete(b, 1, 0)], &[]);

    assert!(core.state.node(b).is_none(), "the target machine is removed");
    assert!(core.state.node(wire).is_none(), "its wire cascades with it");
    assert!(wire_ids(&core).is_empty(), "no Node::Wire survives");
    assert!(
        core.last_tick.removed.contains(&wire),
        "the cascaded wire id is reported to the caller, so `sched.remove` is paired with it"
    );
}

#[test]
fn delete_of_a_wire_source_machine_cascades_the_wire() {
    // The case a `links`-only walk MISSES, and the demo scene's endpoint. The wire's
    // SOURCE endpoint has no `links` entry at all: `fold_draw_wire` records only
    // `(wire, 0) -> to`. So deleting `a` leaves nothing in `links` naming `a`, and a
    // cascade that walks `links` finds nothing to remove.
    let mut core = Core::genesis(header(63_062));
    let a = core.state.add_source();
    let b = core.state.add_source();
    let wire = core.state.add_wire((a, 0), (b, 0));
    core.state.link((wire, 0), (b, 0));

    // Stated as an assertion rather than as prose: `a` really is absent from `links`.
    assert!(
        core.state.links_iter().all(|(from, to)| from.0 != a && to.0 != a),
        "the wire's SOURCE endpoint has no links entry - this is why the walk is over `nodes`"
    );

    core.advance_edits(&[edit_delete(a, 1, 0)], &[]);

    assert!(core.state.node(a).is_none(), "the source machine is removed");
    assert!(core.state.node(wire).is_none(), "its wire cascades with it");
    assert!(wire_ids(&core).is_empty(), "no Node::Wire survives");
    assert!(core.last_tick.removed.contains(&wire), "the cascaded wire id is reported");
}

#[test]
fn a_grid_whose_wired_machine_was_deleted_restores_cleanly() {
    // The test that matters most, in both directions, with its negative control.
    //
    // Before this plan BOTH deletes below leave a `Node::Wire` naming a dead id, and
    // `restore` refuses the resulting snapshot with `DanglingWireEndpoint` - the board
    // saves and then will not load.
    for delete_source_side in [false, true] {
        let mut core = Core::genesis(header(63_063));
        let a = core.state.add_source();
        let b = core.state.add_source();
        let wire = core.state.add_wire((a, 0), (b, 0));
        core.state.link((wire, 0), (b, 0));

        let victim = if delete_source_side { a } else { b };
        core.advance_edits(&[edit_delete(victim, 1, 0)], &[]);

        assert!(core.state.node(wire).is_none(), "the wire cascaded");
        assert!(
            restore(&snapshot(&core)).is_ok(),
            "the post-delete grid passes the snapshot trust gate (no DanglingWireEndpoint), \
             deleting the {} endpoint",
            if delete_source_side { "source" } else { "target" }
        );
    }

    // NEGATIVE CONTROL, in the same test: forge the pre-fix state directly and assert
    // `restore` still REFUSES it. Without this, a restore path that accepted everything
    // would make the assertions above pass while proving nothing.
    let mut forged = Core::genesis(header(63_063));
    let a = forged.state.add_source();
    let _orphan = forged.state.add_wire((a, 0), (ghost_id(), 0));
    assert!(
        matches!(
            restore(&snapshot(&forged)),
            Err(DecodeError::InvalidState(StateInvariant::DanglingWireEndpoint))
        ),
        "an orphan wire naming a dead id is still refused - the gate this fix satisfies is real"
    );
}

#[test]
fn a_wire_looping_a_machine_to_itself_is_cascaded_exactly_once() {
    // Both endpoints name the deleted machine. The walk must deduplicate, mirroring the
    // belt walk's `contains` check, or the recursion re-enters a node already removed.
    let mut core = Core::genesis(header(63_064));
    let m = core.state.add_source();
    let wire = core.state.add_wire((m, 0), (m, 1));
    core.state.link((wire, 0), (m, 1));

    core.advance_edits(&[edit_delete(m, 1, 0)], &[]);

    assert!(core.state.node(wire).is_none(), "the self-loop wire is removed");
    assert_eq!(
        core.last_tick.removed.iter().filter(|&&id| id == wire).count(),
        1,
        "the self-loop wire appears EXACTLY once in the cascade set"
    );
    assert!(restore(&snapshot(&core)).is_ok(), "the post-cascade grid restores");
}

#[test]
fn rotating_a_machine_with_a_wire_attached_does_not_detach_the_wire() {
    // Rotation must NOT cascade wires and must not start. A rotate severs a BELT dock
    // because the port moves in world space and the belt's end-tile no longer abuts it;
    // a wire has no spatial endpoint, so a rotation cannot sever one.
    //
    // This test is GREEN before the plan as well as after. That is the point: it pins
    // the behaviour the wire cascade must not disturb.
    let mut core = Core::genesis(header(63_065));
    let a = core.state.add_source();
    let m = core.state.add_source();
    core.state.claim_footprint(m, (3, 3), 2, 3, 0);
    let wire = core.state.add_wire((a, 0), (m, 0));
    core.state.link((wire, 0), (m, 0));

    core.advance_edits(&[edit_rotate(m, 1, 1, 0)], &[]);

    assert!(core.state.node(m).is_some(), "the rotated machine survives");
    assert!(core.state.node(wire).is_some(), "its wire is NOT detached by a rotate");
    assert_eq!(
        core.state.link_target((wire, 0)),
        Some((m, 0)),
        "the wire's forward link survives the rotate untouched"
    );
    assert!(
        core.last_tick.unlinked.is_empty(),
        "a wire is never reported as a de-docked dock"
    );
}

#[test]
fn the_capture_records_cascaded_wires_in_the_one_cascade_order() {
    // The capture and the removal must read the SAME set in the SAME order. Two orders
    // would let a captured wire be restored in an order the removal did not use, and the
    // ids would not line up. Both call `docked_wires`, and this test compares the
    // capture's order against the ORDER THE FOLD ACTUALLY REMOVED, read off
    // `last_tick.removed` - not against a second copy of the walk.
    let mut core = Core::genesis(header(63_066));
    let m = core.state.add_source();
    let x = core.state.add_source();
    let y = core.state.add_source();
    // Three wires: m as source, m as target, and one that does not touch m at all.
    let w_out = core.state.add_wire((m, 0), (x, 0));
    core.state.link((w_out, 0), (x, 0));
    let w_in = core.state.add_wire((y, 0), (m, 1));
    core.state.link((w_in, 0), (m, 1));
    let w_other = core.state.add_wire((x, 1), (y, 1));
    core.state.link((w_other, 0), (y, 1));

    let captured = core.state.capture_deleted_subgraph(m);
    assert_eq!(captured.wires.len(), 2, "both wires touching m are captured, the third is not");
    assert!(!captured.is_empty(), "a real capture is never the empty sentinel");
    assert_eq!(captured.wires[0].from, (m, 0), "the m-as-source wire's endpoints are captured");
    assert_eq!(captured.wires[0].to, (x, 0));
    assert_eq!(captured.wires[1].from, (y, 0), "the m-as-target wire's endpoints are captured");
    assert_eq!(captured.wires[1].to, (m, 1));
    assert!(captured.wires.iter().all(|w| w.kind == 8), "kind mirrors machine_kind::WIRE");
    assert_eq!(
        captured.wires[0].links,
        vec![(w_out, 0, x, 0)],
        "each captured wire carries the directed links it was incident to"
    );

    core.advance_edits(&[edit_delete(m, 1, 0)], &[]);

    // The order the capture recorded IS the order the fold removed them in.
    let removed_wires: Vec<NodeId> = core
        .last_tick
        .removed
        .iter()
        .copied()
        .filter(|id| [w_out, w_in].contains(id))
        .collect();
    assert_eq!(removed_wires, vec![w_out, w_in], "the removal order is ascending NodeId");
    assert!(core.state.node(w_other).is_some(), "an unrelated wire is untouched");
    assert!(restore(&snapshot(&core)).is_ok(), "the post-cascade grid restores");
}

#[test]
fn a_capture_with_wires_but_no_belts_is_not_the_empty_sentinel() {
    // `DeletedSubgraph::is_empty()` keys on `w == 0` and the 63-06 append must not
    // disturb it. A machine carrying only a wire still resolves a footprint, so the
    // sentinel still means "no capture" and nothing else.
    let mut core = Core::genesis(header(63_067));
    let m = core.state.add_source();
    let t = core.state.add_source();
    let wire = core.state.add_wire((m, 0), (t, 0));
    core.state.link((wire, 0), (t, 0));

    let captured = core.state.capture_deleted_subgraph(m);
    assert!(captured.belts.is_empty(), "no belts in this capture");
    assert_eq!(captured.wires.len(), 1, "one wire in this capture");
    assert!(!captured.is_empty(), "a wires-only capture is a REAL capture");
    assert!(
        fabrico_core::edit::DeletedSubgraph::default().is_empty(),
        "and the default is still the empty sentinel"
    );
}
