//! Phase 73-05 (UNDO-03) - THE UNDO HANDS BACK EVERY LINK THE DELETE TORE DOWN.
//!
//! `capture_deleted_subgraph` records EVERY directed link incident to each cascade-removed
//! wire into `DeletedWire.links`. The restore read NONE of them: the wire leg in
//! `compute_inverse` emitted one `EditOp::DrawWire` per captured wire and stopped, and
//! `fold_draw_wire` writes exactly ONE link, the canonical `(wire, 0) -> to`. Any other
//! link the delete tore down - a `Dock` aimed at the wire, whose Tail arm writes
//! `link((node, port), (belt, 0))`, a shape `fold_draw_wire` never writes - was simply
//! gone.
//!
//! This is the worst shape in the UNDO cluster and the reason it is worth its own file:
//! the undo returned `Ok`. Nothing told the user. The board they got back was not the
//! board the delete took away, and every count-based assertion in the suite agreed it was.
//!
//! # WHY THIS CANNOT BE A LIVE-PATH TEST, AND WHAT WOULD MAKE IT ONE (ruling R-22)
//! `GridCommand::Dock` naming a wire is REFUSED at validate time with
//! `CommandError::InvalidDock` - measured, and pinned by the last test in this file. So
//! the link WINDOWS row 62 describes cannot be built by ANY shipped gesture, and a
//! test that tried to build one through `GridSession::apply` would be testing nothing.
//!
//! The only route is a FORGED `EditOp::Dock { belt: <the wire>, endpoint: Tail, node: M,
//! port }` driven through the public `GridSession::replay` primitive, which folds to
//! `(M, port) -> (W, 0)`. That is the established idiom in this repository:
//! `crates/fabrico-host/tests/undo_on_demo_board.rs:802-847` uses it for the same reason,
//! with its `GridSession::replay` call at `:847`.
//!
//! MAKING THIS A LIVE-PATH TEST NEEDS PHASE 74's LINK-05, and doing it before then
//! inverts the 73-before-74 ordering the whole milestone sequence rests on. This is
//! recorded in `73-CONTEXT.md` as decision D-09 and it is repeated HERE because this file
//! is where the person about to "improve" it will be looking. Do not convert it.
//!
//! # The assertion discipline
//! The links comparison is a SET EQUALITY after substituting the re-minted ids, asserted
//! in both directions and separately by name, plus a named present-edge assertion so a
//! failure reads as a sentence rather than a diff of two maps. It is NEVER a length and
//! never a count: a size comparison passes on a build that restores one edge and drops
//! another, which is the precise defect this file exists to close.
//!
//! Every test carries a `// RED ON HEAD BECAUSE:` line stating what it measured on the
//! pre-fix tree.

use std::collections::BTreeSet;

use fabrico_command::{CommandError, GridSession};
use fabrico_core::edit::{BeltEnd as EditBeltEnd, EDIT_SCHEMA_VERSION, EditOp, EditRecord};
use fabrico_core::ids::{NodeId, PortId};
use fabrico_core::state::{Medium, Node};
use fabrico_protocol::{BeltEnd, GridCommand, machine_kind};

const SEED: u64 = 0x0073_0005_11A0;

/// One directed link, `(from_node, from_port) -> (to_node, to_port)`.
type Link = ((NodeId, PortId), (NodeId, PortId));

/// The grid's directed links as a SET - the oracle every leg here asserts on.
type LinkSet = BTreeSet<Link>;

/// The electrical Router preset's port indices, lifted from `undo_restores_a_wire.rs`:
/// index 0 is the `In`/W port and indices 1.. are the `Out`/E ports.
const WIRE_IN_PORT: PortId = 0;
const WIRE_OUT_PORT: PortId = 1;

/// Every directed link in the grid, as a SET.
fn link_set(session: &GridSession) -> LinkSet {
    session.core().state.links_iter().collect()
}

/// The single live `Node::Wire` on a board built to hold exactly one.
fn only_wire(session: &GridSession) -> NodeId {
    let state = &session.core().state;
    let mut found: Vec<NodeId> = state
        .node_ids()
        .filter(|id| matches!(state.node(*id), Some(Node::Wire(_))))
        .collect();
    assert_eq!(found.len(), 1, "this board is built to hold exactly one wire");
    found.pop().expect("the length was just asserted to be 1")
}

/// Substitute two old-to-new id pairs across a link set - the SAME remapping seam
/// `compute_inverse` performs through its `remap` map, applied on the test side so the
/// pre-delete map and the post-undo map become comparable. Both the machine and the wire
/// are re-minted by the restore, so both need substituting.
fn remap_links(links: &LinkSet, pairs: &[(NodeId, NodeId)]) -> LinkSet {
    let sub = |n: NodeId| {
        pairs
            .iter()
            .find_map(|&(old, new)| (old == n).then_some(new))
            .unwrap_or(n)
    };
    links
        .iter()
        .map(|&((f, fp), (t, tp))| ((sub(f), fp), (sub(t), tp)))
        .collect()
}

/// A stamped log record, the shape a persisted log carries.
fn rec(sequence: u64, tick: u64, action: u64, op: EditOp) -> EditRecord {
    EditRecord {
        schema_version: EDIT_SCHEMA_VERSION,
        partition: 0,
        sequence,
        tick,
        action,
        op,
    }
}

/// The board under test, and the whole forgery, in one place.
///
/// Two electrical Router presets at `(0,0)` and `(10,10)` with one wire drawn between
/// them, PLUS a forged `EditOp::Dock` aimed at that wire. The wire therefore carries TWO
/// incident links: the canonical `(W, 0) -> (B, in)` that `fold_draw_wire` wrote for
/// itself, and `(A, out) -> (W, 0)` that only a `Dock` can write.
///
/// Returns `(session, a, b, wire, links_before)` for a session in which machine `a` has
/// ALREADY been deleted through a log record carrying the real capture, so the only thing
/// left to drive is the `Undo`. `GridCommand::Undo` is fieldless and needs no render
/// handle, which is what makes the whole board reachable through `GridSession::replay`.
///
/// The capture is taken with `GridState::capture_deleted_subgraph`, the SAME function the
/// command layer's `enrich_delete_capture` calls on the live gesture path. It is not
/// hand-written: a hand-written capture would let this test pass against a build whose
/// capture had gone empty, which is exactly the defect plan 73-03 found.
fn deleted_machine_with_a_docked_wire() -> (GridSession, NodeId, NodeId, NodeId, LinkSet) {
    let mut probe = GridSession::new(SEED);
    probe
        .place_router_preset(Medium::Electrical, 0, 0)
        .expect("place the source-side electrical Router preset");
    let a = probe.core().state.occupied((0, 0)).expect("router at (0,0)");
    probe
        .place_router_preset(Medium::Electrical, 10, 10)
        .expect("place the target-side electrical Router preset");
    let b = probe
        .core()
        .state
        .occupied((10, 10))
        .expect("router at (10,10)");
    let a_h = probe.view().handle_of(a).expect("source router got a handle");
    let b_h = probe.view().handle_of(b).expect("target router got a handle");
    probe
        .apply(GridCommand::DrawWire {
            from_node: a_h,
            from_port: WIRE_OUT_PORT,
            to_node: b_h,
            to_port: WIRE_IN_PORT,
        })
        .expect("draw the wire between the two electrical Out/In ports");
    let wire = only_wire(&probe);

    let mut records: Vec<EditRecord> = probe.edit_log().to_vec();
    let next = |records: &[EditRecord]| {
        (
            records.iter().map(|r| r.sequence).max().map_or(0, |s| s + 1),
            records.iter().map(|r| r.tick).max().map_or(0, |t| t + 1),
            records.iter().map(|r| r.action).max().map_or(0, |a| a + 1),
        )
    };

    // THE FORGERY. `fold_dock`'s Tail arm writes `link((node, port), (belt, 0))`, which
    // for a wire is `(A, out) -> (W, 0)` - the source-side link a drawn wire never has,
    // and the exact shape `fold_draw_wire` never writes. See this file's docblock for why
    // no live gesture can produce it.
    let (s, t, ac) = next(&records);
    records.push(rec(
        s,
        t,
        ac,
        EditOp::Dock {
            belt: wire,
            endpoint: EditBeltEnd::Tail,
            node: a,
            port: WIRE_OUT_PORT,
        },
    ));

    let docked = GridSession::replay(SEED, &records);
    let links_before = link_set(&docked);
    assert_eq!(
        links_before.len(),
        2,
        "the forged board carries BOTH the canonical wire link and the docked one; \
         without both, the set equality below could not tell a complete restore from a \
         canonical-only one"
    );

    // The DELETE, carrying the capture the live enrichment path would have produced.
    let captured = docked.core().state.capture_deleted_subgraph(a);
    assert_eq!(
        captured.wires.len(),
        1,
        "the delete cascade takes the wire with the machine, and the capture records it"
    );
    let (s, t, ac) = next(&records);
    records.push(rec(
        s,
        t,
        ac,
        EditOp::Delete {
            node: a,
            kind: machine_kind::ROUTER,
            cell_x: 0,
            cell_y: 0,
            captured,
        },
    ));

    let session = GridSession::replay(SEED, &records);
    assert!(
        link_set(&session).is_empty(),
        "the delete tore BOTH links down, so the restore below is a real change"
    );
    assert!(
        session.can_undo(),
        "the delete is on the undo stack (fixture precondition)"
    );
    (session, a, b, wire, links_before)
}

/// The two ids the restore re-mints, harvested from the SAME seam `compute_inverse`'s
/// `remap` harvests from: `core.last_tick.placed`, in fold order. The undo group is
/// `Place` (the machine) then `DrawWire` (the wire), so the machine is first.
fn reminted_pair(session: &GridSession) -> (NodeId, NodeId) {
    let placed = &session.core().last_tick.placed;
    assert_eq!(
        placed.len(),
        2,
        "the undo group re-minted exactly the machine and the wire, in that order"
    );
    (placed[0], placed[1])
}

/// UNDO-03, the headline. A `Dock` aimed at a wire is a link like any other, and the undo
/// of the delete that tore it down puts it back.
///
/// RED ON HEAD BECAUSE: measured on the pre-fix tree by a throwaway probe. `apply(Undo)`
/// returns `Ok(())` and the post-undo link set is `{(W', 0) -> (B, 0)}` alone - the
/// canonical link and nothing else. The forged `(A, 1) -> (W, 0)` edge is DROPPED, and the
/// undo reports success while doing it. That is the whole defect: it is silent.
#[test]
fn a_delete_undo_restores_a_dock_aimed_at_a_wire() {
    let (mut session, a, _b, wire, links_before) = deleted_machine_with_a_docked_wire();

    session
        .apply(GridCommand::Undo)
        .expect("undoing the delete of a wired machine is buildable");

    let (a_new, wire_new) = reminted_pair(&session);
    let expected = remap_links(&links_before, &[(a, a_new), (wire, wire_new)]);
    let actual = link_set(&session);
    assert_eq!(actual, expected, "the links map is set-equal after remapping");

    // The same claim once more, named, so a failure reads as a sentence. This is the edge
    // only a `Dock` ever wrote, and the one the restore used to drop.
    let docked_edge: Link = ((a_new, WIRE_OUT_PORT), (wire_new, 0));
    assert!(
        actual.contains(&docked_edge),
        "the restore put back the edge a Dock wrote at the wire: {docked_edge:?}, actual \
         links {actual:?}"
    );
}

/// UNDO-03, the two directions of the set equality, asserted separately and by name.
///
/// Never a length and never a count: a size comparison is satisfied by a build that
/// restores one edge and drops another, which is the failure mode this whole file is
/// about.
///
/// RED ON HEAD BECAUSE: the DROPPED direction below is non-empty on the pre-fix tree - the
/// docked edge is missing - while the ADDED direction is empty, so a size-based assertion
/// would have been red for the right reason and a set-based one says WHICH edge went.
#[test]
fn no_edge_was_dropped_and_none_was_added() {
    let (mut session, a, _b, wire, links_before) = deleted_machine_with_a_docked_wire();

    session
        .apply(GridCommand::Undo)
        .expect("undoing the delete of a wired machine is buildable");

    let (a_new, wire_new) = reminted_pair(&session);
    let expected = remap_links(&links_before, &[(a, a_new), (wire, wire_new)]);
    let actual = link_set(&session);

    let dropped: Vec<_> = expected.difference(&actual).collect();
    assert!(
        dropped.is_empty(),
        "the undo DROPPED edges that existed before the delete: {dropped:?}"
    );
    let added: Vec<_> = actual.difference(&expected).collect();
    assert!(
        added.is_empty(),
        "the undo ADDED edges that did not exist before the delete: {added:?}"
    );
}

/// Ruling R-24. The restore emits a `Dock` ONLY for links that are not the canonical
/// `(wire, 0) -> to` one `fold_draw_wire` already wrote for itself.
///
/// Re-writing the canonical link would not be harmful today - `GridState::link` overwrites
/// the same key with the same value - but it would make the set equality above pass FOR
/// THE WRONG REASON: a leg that blindly replayed every captured link would look identical
/// on this board to one that understood which link the fold already owns. That is the
/// passes-for-the-wrong-reason class this phase exists to close, so it gets its own row.
///
/// The inverse group is read through the public `resolve_undo`, which computes it at issue
/// time and mutates nothing.
///
/// RED ON HEAD BECAUSE: the group carries ZERO `Dock` records on the pre-fix tree, so the
/// count below is 0 rather than 1. Measured on the throwaway probe: the inverse group was
/// exactly `[Undo, Place, DrawWire]`.
#[test]
fn the_canonical_link_is_not_written_twice() {
    let (session, _a, b, _wire, _links_before) = deleted_machine_with_a_docked_wire();

    let group = session
        .resolve_undo()
        .expect("the inverse of a wired-machine delete is buildable");

    let docks: Vec<&EditOp> = group
        .iter()
        .map(|r| &r.op)
        .filter(|op| matches!(op, EditOp::Dock { .. }))
        .collect();
    assert_eq!(
        docks.len(),
        1,
        "the capture holds two incident links and `fold_draw_wire` re-writes exactly one \
         of them, so the restore owes exactly ONE Dock; got {docks:?}"
    );

    // And it is not a re-write of the canonical edge. A `Dock { endpoint: Head, node: B,
    // port: in }` would fold to `(W', 0) -> (B, in)`, which is the edge the `DrawWire`
    // already wrote.
    for op in &docks {
        if let EditOp::Dock {
            endpoint,
            node,
            port,
            ..
        } = op
        {
            assert!(
                !(matches!(endpoint, EditBeltEnd::Head) && *node == b && *port == WIRE_IN_PORT),
                "this Dock re-writes the canonical link `fold_draw_wire` already wrote, \
                 which makes the set equality pass without the restore understanding \
                 which link the fold owns: {op:?}"
            );
        }
    }
}

/// Ruling R-22, pinned in code. `GridCommand::Dock` naming a WIRE is refused at validate
/// time, so the link this file is about cannot be reached by any shipped gesture.
///
/// This row is the reason the rest of the file forges a log record instead of issuing a
/// command, and it exists so that reason cannot quietly stop being true. If this refusal is
/// ever lifted - phase 74's LINK-05 is where that would happen - this row goes red and the
/// person changing it is standing exactly where the docblock's instruction applies.
///
/// RED ON HEAD BECAUSE: it is not, and it says so out loud. This row is GREEN on HEAD by
/// construction: `Err(CommandError::InvalidDock)` was measured on the pre-fix tree. It pins
/// a PRECONDITION of the other three rows rather than new behaviour, and a file whose every
/// row measured only new behaviour would let that precondition rot unnoticed.
#[test]
fn a_forged_dock_naming_a_wire_through_the_live_seam_is_still_refused() {
    let mut session = GridSession::new(SEED);
    session
        .place_router_preset(Medium::Electrical, 0, 0)
        .expect("place the source-side electrical Router preset");
    let a = session.core().state.occupied((0, 0)).expect("router at (0,0)");
    session
        .place_router_preset(Medium::Electrical, 10, 10)
        .expect("place the target-side electrical Router preset");
    let b = session
        .core()
        .state
        .occupied((10, 10))
        .expect("router at (10,10)");
    let a_h = session.view().handle_of(a).expect("source router got a handle");
    let b_h = session.view().handle_of(b).expect("target router got a handle");
    session
        .apply(GridCommand::DrawWire {
            from_node: a_h,
            from_port: WIRE_OUT_PORT,
            to_node: b_h,
            to_port: WIRE_IN_PORT,
        })
        .expect("draw the wire");
    let wire = only_wire(&session);
    let wire_h = session.view().handle_of(wire).expect("the wire got a handle");

    let links_before = link_set(&session);
    let verdict = session.apply(GridCommand::Dock {
        belt: wire_h,
        endpoint: BeltEnd::Tail,
        node: a_h,
        port: WIRE_OUT_PORT,
    });

    assert!(
        matches!(verdict, Err(CommandError::InvalidDock)),
        "a Dock naming a wire is a TYPED refusal at validate time, got {verdict:?}"
    );
    assert_eq!(
        link_set(&session),
        links_before,
        "the refusal produced NOTHING, so the links map is byte-identical"
    );
}
