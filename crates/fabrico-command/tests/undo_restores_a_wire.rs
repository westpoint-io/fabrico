//! Phase 73-03 (UNDO-01) - THE CABLE COMES BACK.
//!
//! Pressing Disconnect on a machine's wire row emits `Delete { node: <the wire> }`
//! (`frontend/src/chrome/ConfigPanel.tsx`), and until this commit the undo of that delete
//! could not be BUILT. `compute_inverse`'s Delete arm inverted every delete through
//! `EditOp::Place`, and `fold_place` has an arm for every machine kind EXCEPT BELT (1)
//! and WIRE (8) - its own `_ => return` comment names those two as the kinds it
//! deliberately never mints. So the re-Place minted nothing, `pred.last_tick.placed` came
//! back empty, and the whole group was refused `CommandError::Malformed` before any
//! mutation. The user pressed Ctrl+Z, read "The host could not read that gesture" across
//! the top of the screen, and the cable was gone for good.
//!
//! The refusal was CORRECT on a leg that cannot work. The fix is to stop taking that leg:
//! a `Delete` whose `kind` is `WIRE` now inverts through `EditOp::DrawWire`, which mints
//! the node AND re-writes the canonical `(wire, 0) -> to` link from the two endpoints it
//! is handed. Those endpoints come off `DeletedSubgraph.self_record`, the field appended
//! in this same commit, which is half of what forces `EDIT_SCHEMA_VERSION` to 8.
//!
//! # The assertion discipline, and why it is spelled out rather than assumed
//! The `links` leg below compares SETS after substituting the re-minted ids, and never a
//! length or a count. That is not fastidiousness: a count-based assertion passes on a
//! build that restores one edge and drops another, which is the exact class of defect
//! UNDO-01 and UNDO-03 exist to close. The same rule is already written into
//! `crates/fabrico-command/tests/rotate_undo_redock.rs` and is copied here on purpose.
//!
//! Every test carries a `// RED ON HEAD BECAUSE:` line stating what it measured on the
//! pre-fix tree, so no row here is a green that was never able to be red.

use std::collections::BTreeSet;

use fabrico_command::{CommandError, GridSession};
use fabrico_core::edit::{DeletedSubgraph, EditOp, EditRecord};
use fabrico_core::ids::{NodeId, PortId};
use fabrico_core::state::{Medium, Node};
use fabrico_protocol::{GridCommand, machine_kind};

const SEED: u64 = 0x0073_0003_C0FF_EE00;

/// One directed link, `(from_node, from_port) -> (to_node, to_port)`.
type Link = ((NodeId, PortId), (NodeId, PortId));

/// The grid's directed links as a SET - the oracle every restore leg here asserts on.
type LinkSet = BTreeSet<Link>;

/// The port indices `place_router_preset(Medium::Electrical, ..)` seeds: index 0 is the
/// `In`/W and indices 1.. are the `Out`/E ports, all `Electrical`. Lifted from
/// `crates/fabrico-core/tests/regen.rs`'s `gen_0031`, which freezes this same board.
const WIRE_IN_PORT: PortId = 0;
const WIRE_OUT_PORT: PortId = 1;

/// The Route (`ENDPOINT`) and Handler electrical port indices, from
/// `crates/fabrico-command/tests/wire_pair.rs`.
const ROUTE_IN: PortId = 0;
const ROUTE_OUT: PortId = 1;

/// Every directed link in the grid, as a SET. The oracle the restore legs assert on.
///
/// A set and not a `Vec`: the restore is a claim about WHICH edges exist, not about the
/// order a `BTreeMap` walk happens to yield them in, and comparing ordered vectors would
/// make this test fail on a re-ordering that changed nothing a user can see.
fn link_set(session: &GridSession) -> LinkSet {
    session.core().state.links_iter().collect()
}

/// Every live `Node::Wire`'s endpoints, as a SET, with the wire's OWN id dropped.
///
/// The id is dropped deliberately: a restored wire is a NEWLY MINTED node with a new
/// `NodeId`, so an id-carrying comparison could never pass. What a user means by "the
/// same cable" is the same two endpoints, and that is exactly what this reads.
fn wire_endpoint_set(session: &GridSession) -> LinkSet {
    let state = &session.core().state;
    state
        .node_ids()
        .filter_map(|id| match state.node(id) {
            Some(Node::Wire(link)) => Some((link.from, link.to)),
            _ => None,
        })
        .collect()
}

/// The single live `Node::Wire` on a board that has exactly one.
fn only_wire(session: &GridSession) -> NodeId {
    let state = &session.core().state;
    let mut found: Vec<NodeId> = state
        .node_ids()
        .filter(|id| matches!(state.node(*id), Some(Node::Wire(_))))
        .collect();
    assert_eq!(found.len(), 1, "this board is built to hold exactly one wire");
    found.pop().expect("the length was just asserted to be 1")
}

/// Substitute every occurrence of `old` with `new` in a link set - the SAME old-to-new
/// remapping seam `compute_inverse` performs through its `remap` map, applied on the test
/// side so the captured pre-delete map and the post-undo map become comparable.
///
/// A restored node is re-MINTED, so its `NodeId` is necessarily new. Without this
/// substitution the two sets could never be equal and the only assertions left would be
/// counts, which is precisely what this file refuses to do.
fn remap_links(links: &LinkSet, old: NodeId, new: NodeId) -> LinkSet {
    let sub = |n: NodeId| if n == old { new } else { n };
    links
        .iter()
        .map(|&((f, fp), (t, tp))| ((sub(f), fp), (sub(t), tp)))
        .collect()
}

/// Two electrical Router presets at `(0,0)` and `(10,10)` with one wire drawn from the
/// first's Out to the second's In. Returns `(session, wire_id)`.
///
/// This is `gen_0031-undo-delete-of-a-wire`'s board, built the same way on purpose: the
/// golden fixture and this test are two views of one claim, and a board that drifted
/// between them would let one go green while the other stayed broken.
fn wired_pair() -> (GridSession, NodeId) {
    let mut session = GridSession::new(SEED);
    session
        .place_router_preset(Medium::Electrical, 0, 0)
        .expect("place the source-side electrical Router preset");
    let a = session.core().state.occupied((0, 0)).expect("router at (0,0)");
    session
        .place_router_preset(Medium::Electrical, 10, 10)
        .expect("place the target-side electrical Router preset");
    let b = session.core().state.occupied((10, 10)).expect("router at (10,10)");

    let a_h = session.view().handle_of(a).expect("source router got a handle");
    let b_h = session.view().handle_of(b).expect("target router got a handle");
    session
        .apply(GridCommand::DrawWire {
            from_node: a_h,
            from_port: WIRE_OUT_PORT,
            to_node: b_h,
            to_port: WIRE_IN_PORT,
        })
        .expect("draw the wire between the two electrical Out/In ports");

    let wire = only_wire(&session);
    (session, wire)
}

/// UNDO-01, the headline. Delete a live wire, press Ctrl+Z, and the cable is back with
/// the IDENTICAL endpoints.
///
/// RED ON HEAD BECAUSE: measured on the pre-fix tree by plan 73-02's throwaway probe and
/// frozen into `0031-undo-delete-of-a-wire`, `apply(Undo)` returns `Err(Malformed)` and
/// the node count stays at 2. The `Delete` inverted through `Place`, `fold_place` never
/// mints kind 8, and the empty `placed` tripped the typed refusal.
#[test]
fn undo_of_a_wire_delete_returns_ok_and_the_wire_is_live_again() {
    let (mut session, wire) = wired_pair();
    let endpoints_before = wire_endpoint_set(&session);
    assert_eq!(
        session.core().state.node_count(),
        3,
        "two routers plus the minted wire"
    );

    let wire_h = session.view().handle_of(wire).expect("the wire got a handle");
    session
        .apply(GridCommand::Delete { node: wire_h })
        .expect("a live wire is deletable");
    assert_eq!(
        session.core().state.node_count(),
        2,
        "the delete removed exactly the wire"
    );

    // The VERDICT itself is the first half of the claim. On HEAD this is the Err.
    session
        .apply(GridCommand::Undo)
        .expect("undoing the delete of a bare wire is buildable from its self-record");

    assert_eq!(
        session.core().state.node_count(),
        3,
        "the undo put the wire back and minted nothing else"
    );
    // The second half: the SAME cable, not merely A cable. Endpoints, not ids.
    assert_eq!(
        wire_endpoint_set(&session),
        endpoints_before,
        "the restored wire runs between the identical (node, port) endpoints"
    );
}

/// UNDO-01 / UNDO-03. The restored `links` map is SET-EQUAL to the captured one after
/// substituting the re-minted id, with no edge dropped and none added.
///
/// RED ON HEAD BECAUSE: the undo is refused outright on the pre-fix tree, so the
/// post-undo link set is the POST-DELETE one - the `(wire, 0) -> to` edge is missing and
/// the difference below is non-empty.
#[test]
fn the_restored_links_map_is_set_equal_after_remapping() {
    let (mut session, wire) = wired_pair();
    let links_before = link_set(&session);
    assert!(
        !links_before.is_empty(),
        "the board must carry at least one edge or this test asserts nothing"
    );

    let wire_h = session.view().handle_of(wire).expect("the wire got a handle");
    session
        .apply(GridCommand::Delete { node: wire_h })
        .expect("a live wire is deletable");
    session
        .apply(GridCommand::Undo)
        .expect("the undo of a bare-wire delete is buildable");

    // Harvest the re-minted id through the SAME seam `compute_inverse`'s `remap` uses:
    // the ids the fold reports in `last_tick.placed`. Reading it any other way (by
    // position, by "the highest id", by re-finding the only wire) would be a second,
    // parallel rule that could agree with the real one by luck.
    let reminted = *session
        .core()
        .last_tick
        .placed
        .last()
        .expect("the undo's DrawWire minted the restored wire");
    let expected = remap_links(&links_before, wire, reminted);
    let actual = link_set(&session);

    // NEVER a length comparison, and this comment is part of the test. `links.len()`
    // is satisfied by a build that restores one edge and drops another - the exact
    // defect UNDO-01 and UNDO-03 exist to close - so the two directions are asserted
    // SEPARATELY and by name, and a failure says which way it went.
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
    assert_eq!(actual, expected, "the links map is set-equal after remapping");
}

/// T-73-03-04. A `Delete { kind: WIRE }` carrying NO self-record - every record written
/// before this field existed, and every forged one - is REFUSED with a typed error,
/// before any mutation, and never a panic.
///
/// This is the negative control on the leg above. Restoring a cable whose endpoints were
/// never recorded is not expressible: inventing them would restore a DIFFERENT cable, so
/// the honest answer is the refusal that already shipped.
///
/// RED ON HEAD BECAUSE: it is not. This row is GREEN on HEAD by construction and says so
/// out loud - it pins that the pre-existing typed refusal SURVIVES the fix rather than
/// being widened into an unwrap. A row that only ever measured new behaviour would let
/// the fix quietly turn a refusal into a panic on the forged path.
#[test]
fn a_wire_delete_undo_refuses_before_any_mutation_when_the_capture_is_absent() {
    let (session, wire) = wired_pair();
    let mut records: Vec<EditRecord> = session.edit_log().to_vec();
    let next_tick = records.iter().map(|r| r.tick).max().map_or(0, |t| t + 1);
    let next_sequence = records.iter().map(|r| r.sequence).max().map_or(0, |s| s + 1);
    let next_action = records.iter().map(|r| r.action).max().map_or(0, |a| a + 1);

    // A HAND-BUILT delete: the shape a forged log carries. `DeletedSubgraph::default()`
    // has `w == 0`, so `is_empty()` is true, the kind-catalog fallback fires, and the
    // inverse takes the `Place` leg - which cannot mint kind 8.
    records.push(EditRecord {
        schema_version: fabrico_core::edit::EDIT_SCHEMA_VERSION,
        partition: 0,
        sequence: next_sequence,
        tick: next_tick,
        action: next_action,
        op: EditOp::Delete {
            node: wire,
            kind: machine_kind::WIRE,
            cell_x: 0,
            cell_y: 0,
            captured: DeletedSubgraph::default(),
        },
    });

    let mut replayed = GridSession::replay(SEED, &records);
    let links_before = link_set(&replayed);
    let nodes_before = replayed.core().state.node_count();

    let verdict = replayed.apply(GridCommand::Undo);

    assert!(
        matches!(verdict, Err(CommandError::UndoDoesNotFit)),
        "a capture-less wire delete inverts to nothing buildable and must be a TYPED \
         refusal, got {verdict:?}"
    );
    // REFUSED BEFORE ANY MUTATION is the second half, and the one a typed error alone
    // does not prove: an inverse that mutated and then errored would satisfy the line
    // above while leaving the board half-restored.
    assert_eq!(
        link_set(&replayed),
        links_before,
        "a refused undo leaves the links map byte-identical"
    );
    assert_eq!(
        replayed.core().state.node_count(),
        nodes_before,
        "a refused undo mints and removes nothing"
    );
}

/// D-04 / UNDO-01. A Route-and-Handler cable is TWO wire legs frozen under ONE action id
/// since 72-08, so ONE Ctrl+Z must bring BOTH back.
///
/// `capture_deleted_subgraph`'s own docblock and `fold_delete`'s both say in capitals
/// that phase 73 owns restoring the pair as one undo step. Without a named assertion, a
/// build that restored ONE of the two legs ships green against every other row in this
/// file - and a forward-only cable is exactly the board D-06 rules unreachable.
///
/// RED ON HEAD BECAUSE: both legs are wires, so both `Delete` records inverted through
/// `Place`, and the FIRST one refused the whole group. On HEAD this undo returns
/// `Err(Malformed)` and neither leg comes back.
#[test]
fn the_route_and_handler_pair_restores_as_one_undo_step() {
    let mut session = GridSession::new(SEED);
    session
        .apply(GridCommand::Place {
            kind: machine_kind::ENDPOINT,
            cell_x: 0,
            cell_y: 0,
        })
        .expect("place the Route");
    let route = session.core().state.occupied((0, 0)).expect("Route at (0,0)");
    session
        .apply(GridCommand::Place {
            kind: machine_kind::HANDLER,
            cell_x: 10,
            cell_y: 10,
        })
        .expect("place the Handler");
    let handler = session
        .core()
        .state
        .occupied((10, 10))
        .expect("Handler at (10,10)");

    let route_h = session.view().handle_of(route).expect("the Route got a handle");
    let handler_h = session
        .view()
        .handle_of(handler)
        .expect("the Handler got a handle");
    session
        .apply(GridCommand::DrawWire {
            from_node: route_h,
            from_port: ROUTE_OUT,
            to_node: handler_h,
            to_port: ROUTE_IN,
        })
        .expect("one drag between a Route and a Handler mints BOTH cable legs");

    let legs: Vec<NodeId> = {
        let state = &session.core().state;
        state
            .node_ids()
            .filter(|id| matches!(state.node(*id), Some(Node::Wire(_))))
            .collect()
    };
    assert_eq!(
        legs.len(),
        2,
        "72-08: one Route-to-Handler drag mints the forward leg AND the return leg"
    );
    let endpoints_before = wire_endpoint_set(&session);
    let nodes_before = session.core().state.node_count();

    // Delete EITHER leg: the paired-delete cascade freezes two Delete records under one
    // action id, so this is one gesture and must be one undo step.
    let leg_h = session
        .view()
        .handle_of(legs[0])
        .expect("the first leg got a handle");
    session
        .apply(GridCommand::Delete { node: leg_h })
        .expect("deleting one leg of a paired cable is accepted");
    assert_eq!(
        session
            .core()
            .state
            .node_ids()
            .filter(|id| matches!(session.core().state.node(*id), Some(Node::Wire(_))))
            .count(),
        0,
        "the paired delete tore down BOTH legs, which is what makes one undo step owe two"
    );

    session
        .apply(GridCommand::Undo)
        .expect("ONE Ctrl+Z restores the whole cable");

    let legs_after = session
        .core()
        .state
        .node_ids()
        .filter(|id| matches!(session.core().state.node(*id), Some(Node::Wire(_))))
        .count();
    assert_eq!(
        legs_after, 2,
        "BOTH legs came back on one undo - restoring one of two is the forward-only \
         board D-06 rules unreachable"
    );
    assert_eq!(
        session.core().state.node_count(),
        nodes_before,
        "the undo restored the pair and minted nothing else"
    );
    assert_eq!(
        wire_endpoint_set(&session),
        endpoints_before,
        "both restored legs run between the identical endpoints, in both directions"
    );
}
