//! LINK-07 behaviour spec: deleting a machine a MULTI-BELT run feeds destroys only the
//! belt actually touching it, and the links the delete did not touch survive it.
//!
//! Phase 74 made belts dockable to belts. Before that, `GridState::remove_node` could
//! recurse uniformly through `docked_wire_belts` and terminate after one hop by accident,
//! because no belt ever had another belt as a neighbour. The day two runs can join, that
//! same recursion walks the WHOLE run: one click on a sink at the end of `a -> b -> c`
//! took four nodes where two is correct, and destroyed the `a -> b` link on the way out.
//!
//! Every assertion below compares a `BTreeSet<NodeId>` against a NAMED expected set. A
//! size bound on the removed-node count is deliberately never written here, in any form:
//! a bound of two is also
//! satisfied by an implementation that stops cascading altogether, and that implementation
//! silently breaks goldens `0010-delete-cascade-detach` and `0014-undo-delete-with-docked-belt`
//! while this file stays green.
//!
//! # This file now specifies TWO rules, and the difference between them is the point
//!
//! Deleting a MACHINE takes the belt touching it. That belt was docked to the machine and
//! to nothing else on that end, so leaving it behind strands a belt docked to a node that
//! no longer exists, and the user gets back a segment with a dead end they did not ask for.
//! The cases from `the_cascade_takes_the_machine_and_the_belt_touching_it_and_stops`
//! downwards are written against that rule and it has not moved.
//!
//! Deleting a BELT takes that belt and NOTHING across a belt-to-belt dock. A belt
//! neighbour does not strand: it loses a link, which is exactly the outcome
//! `GridState::judge_docks` already produces for its `None` RELEASE verdict on a rotate,
//! where the directed link is dropped and the belt node survives disconnected. Before this
//! rule existed, a two-belt run went from two belts to ZERO on one Delete, because the one
//! shared cascade query collected every belt reachable across one link from the deleted
//! node and since phase 74 a belt's dock neighbour can itself be a belt. MEASURED by plan
//! 74-11 and recorded as WINDOWS row 231; narrowed by plan 74-12.
//!
//! The two rules meet in ONE expression, `GridState::cascade_neighbours`, which asks what
//! the removed node IS before it asks what is docked to it. A change that stops the belt
//! cascade for a machine delete as well is a regression dressed as a fix, which is why the
//! machine cases and the belt cases live side by side in this one file where a reader meets
//! both at once.
//!
//! Run target: `cargo test -p fabrico-core --test belt_run_delete_cascade`.

use std::collections::BTreeSet;

use fabrico_core::core::Core;
use fabrico_core::edit::{DeletedSelf, DeletedSubgraph, EDIT_SCHEMA_VERSION, EditOp, EditRecord};
use fabrico_core::event::{LogHeader, SCHEMA_VERSION};
use fabrico_core::ids::{NodeId, PortId};
use fabrico_core::snapshot::{restore, snapshot};
use fabrico_core::state::{Node, SinkTemplate};

/// A genesis header carrying `seed`.
fn header(seed: u64) -> LogHeader {
    LogHeader {
        schema_version: SCHEMA_VERSION,
        seed,
    }
}

/// An `EditOp::Delete` record for `node`, stamped at `tick`. The kind/cell fields are
/// provenance the fold ignores (it removes by id), so a placeholder is faithful.
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
            captured: Default::default(),
        },
    }
}

/// The board this file is written against: a SINK fed by a three-belt run.
///
/// `a -> b -> c -> sink`, built at the core seam (the same seam
/// `fabrico-host/tests/belt_backpressure_meet.rs` uses for its junction), so the case
/// does not depend on the belt-to-belt `Dock` gesture landing in the command layer.
struct Run {
    core: Core,
    sink: NodeId,
    a: NodeId,
    b: NodeId,
    c: NodeId,
}

fn three_belt_run() -> Run {
    let mut core = Core::genesis(header(74));
    let sink = core.state.add_sink(SinkTemplate::Debug, 0);
    let a = core.state.add_belt(1);
    let b = core.state.add_belt(1);
    let c = core.state.add_belt(1);
    // The junction links, in the direction `fold_dock` writes them: a belt's downstream
    // link is keyed on its OWN port 0 (`BeltEnd::Head` => `link((belt, 0), (node, port))`).
    core.state.link((a, 0), (b, 0));
    core.state.link((b, 0), (c, 0));
    core.state.link((c, 0), (sink, 0));
    Run {
        core,
        sink,
        a,
        b,
        c,
    }
}

/// A `BTreeSet` of the named ids, so every assertion in this file is a set comparison.
fn set(ids: &[NodeId]) -> BTreeSet<NodeId> {
    ids.iter().copied().collect()
}

/// The belts DIRECTLY docked to `id`: every `Node::Belt` reachable across a SINGLE link
/// whose other endpoint is `id`.
///
/// Computed here from the public `links_iter` rather than by calling the crate-private
/// `docked_wire_belts`, so the expected set is derived independently of the code under
/// test. This is also the set the frontend's `inFlightForNode` sums over; see
/// [`the_cascade_removed_belt_set_is_the_set_the_delete_guard_already_counts`].
fn directly_docked_belts(core: &Core, id: NodeId) -> BTreeSet<NodeId> {
    let mut belts = BTreeSet::new();
    for (from, to) in core.state.links_iter() {
        let other = if from.0 == id {
            Some(to.0)
        } else if to.0 == id {
            Some(from.0)
        } else {
            None
        };
        if let Some(o) = other
            && matches!(core.state.node(o), Some(Node::Belt(_)))
        {
            belts.insert(o);
        }
    }
    belts
}

/// The node id of ONE captured cascade belt, derived from its `links` tuples.
///
/// A `DeletedBelt` carries NO node id (the record is kind + geometry + incident links), so
/// the undo re-mint path has to infer it, and so does this test. The belt is the endpoint
/// common to EVERY one of its incident links; when the machine is also common to all of
/// them (a belt docked to the same machine at both ends) the machine is excluded. Panics
/// when the answer is not unique, which is a real failure and not a fallback.
fn captured_belt_id(links: &[(NodeId, PortId, NodeId, PortId)], machine: NodeId) -> NodeId {
    let mut common: Option<BTreeSet<NodeId>> = None;
    for &(f, _, t, _) in links {
        let endpoints: BTreeSet<NodeId> = [f, t].into_iter().collect();
        common = Some(match common {
            None => endpoints,
            Some(prev) => prev.intersection(&endpoints).copied().collect(),
        });
    }
    let mut candidates = common.expect("a captured belt record carries at least one link");
    if candidates.len() > 1 {
        candidates.remove(&machine);
    }
    assert_eq!(
        candidates.len(),
        1,
        "a captured belt's incident links name exactly one common non-machine endpoint, got {candidates:?}"
    );
    candidates.into_iter().next().expect("checked non-empty")
}

/// Every belt named by a capture, as a set.
fn captured_belt_ids(capture: &DeletedSubgraph, machine: NodeId) -> BTreeSet<NodeId> {
    capture
        .belts
        .iter()
        .map(|belt| captured_belt_id(&belt.links, machine))
        .collect()
}

#[test]
fn the_cascade_takes_the_machine_and_the_belt_touching_it_and_stops() {
    // ADJACENCY EDGE (LINK-07): `c` is docked to the machine at one end and to another
    // BELT at the other. The two links are distinguishable and the cascade takes exactly
    // the machine-touching belt; two links that merely meet at `c` never merge into one
    // cascade decision.
    let mut run = three_belt_run();
    let removed: BTreeSet<NodeId> = run.core.state.remove_node(run.sink).into_iter().collect();
    assert_eq!(
        removed,
        set(&[run.sink, run.c]),
        "the delete takes the machine and the ONE belt touching it; a run-eating cascade \
         returns {{sink, c, b, a}} and a stopped one returns {{sink}}"
    );
    assert!(run.core.state.node(run.a).is_some(), "belt a survives");
    assert!(run.core.state.node(run.b).is_some(), "belt b survives");
}

#[test]
fn the_capture_names_exactly_the_belts_the_removal_takes() {
    // The capture is read BEFORE the delete folds (the subgraph is live only then), and
    // it must name the SAME set the removal then takes - not a subset, which is what an
    // undo that hands back a different board is made of.
    let mut run = three_belt_run();
    let capture = run.core.state.capture_deleted_subgraph(run.sink);
    let captured = captured_belt_ids(&capture, run.sink);
    let removed: BTreeSet<NodeId> = run.core.state.remove_node(run.sink).into_iter().collect();
    let removed_belts: BTreeSet<NodeId> = removed
        .iter()
        .copied()
        .filter(|id| *id != run.sink)
        .collect();
    assert_eq!(
        captured, removed_belts,
        "the capture and the removal agree on the SAME belt set, structurally and not by \
         coincidence"
    );
    assert_eq!(captured, set(&[run.c]), "and that set is exactly {{c}}");
}

#[test]
fn the_links_the_delete_did_not_touch_survive_it() {
    // MEASURED on the pre-fix tree: `link_target((a, 0))` was `None` after the delete.
    // The run-eating cascade did not merely remove extra nodes, it destroyed the links
    // between the nodes a user still has on the board. This is its own assertion with its
    // own failure message because a fix to the recursion DEPTH alone can leave it red.
    let mut run = three_belt_run();
    run.core.state.remove_node(run.sink);
    assert_eq!(
        run.core.state.link_target((run.a, 0)),
        Some((run.b, 0)),
        "the a -> b link is nowhere near the deleted machine and must still be there"
    );
    // And the OTHER half of the same rule, which points the opposite way: the b -> c link
    // must NOT survive, because `c` was removed and a link whose target is a dead node is
    // `StateInvariant::DanglingLink` - a board that saves and then refuses to load. The
    // positive form of this assertion is the trust-gate replay below, which is what can
    // actually fail: an implementation that kept b -> c alive to satisfy a naive reading
    // of "the links survive" fails `restore`.
    assert_eq!(
        run.core.state.link_target((run.b, 0)),
        None,
        "the b -> c link goes with c; keeping it would be a dangling link"
    );
}

#[test]
fn the_delete_leaves_a_board_that_still_saves_and_loads() {
    // Driven through the PUBLIC fold path (`advance_edits` with an `EditOp::Delete`), not
    // the bare `remove_node`, so the scheduler pairing runs too. `restore` runs
    // `validate_invariants`, so `is_ok()` IS the no-dangling-link proof.
    let mut run = three_belt_run();
    run.core.advance_edits(&[edit_delete(run.sink, 1, 0)], &[]);
    assert_eq!(
        run.core.last_tick.removed.iter().copied().collect::<BTreeSet<_>>(),
        set(&[run.sink, run.c]),
        "the fold path removes the same set the state call does"
    );
    assert!(
        restore(&snapshot(&run.core)).is_ok(),
        "no DanglingLink, no DanglingSchedule: the board saves and loads after the delete"
    );
}

#[test]
fn a_machine_with_no_docked_belt_removes_only_itself() {
    // EMPTY EDGE (LINK-07).
    let mut core = Core::genesis(header(3));
    let sink = core.state.add_sink(SinkTemplate::Debug, 0);
    let capture = core.state.capture_deleted_subgraph(sink);
    assert!(
        capture.belts.is_empty(),
        "an undocked machine's capture names no belt at all"
    );
    let removed: BTreeSet<NodeId> = core.state.remove_node(sink).into_iter().collect();
    assert_eq!(removed, set(&[sink]), "the machine and nothing else");
}

#[test]
fn a_single_belt_run_behaves_identically_at_depth_one() {
    // EMPTY EDGE, second half: the depth-one case is the three-belt case with the run cut
    // short, and it must answer the same way.
    let mut core = Core::genesis(header(4));
    let sink = core.state.add_sink(SinkTemplate::Debug, 0);
    let only = core.state.add_belt(1);
    core.state.link((only, 0), (sink, 0));
    let capture = core.state.capture_deleted_subgraph(sink);
    assert_eq!(
        captured_belt_ids(&capture, sink),
        set(&[only]),
        "the capture names the one belt"
    );
    let removed: BTreeSet<NodeId> = core.state.remove_node(sink).into_iter().collect();
    assert_eq!(removed, set(&[sink, only]), "and the removal takes the same two");
}

#[test]
fn removing_an_id_that_is_not_in_nodes_is_a_no_op() {
    // IDEMPOTENCY EDGE (LINK-07), first half: never a panic, never a cascade.
    let mut run = three_belt_run();
    let absent = run.core.state.add_belt(1);
    run.core.state.remove_node(absent);
    // `absent` is now a freed generational slot: a stale handle of exactly the shape a
    // second Delete of an already-deleted node arrives with.
    let before = snapshot(&run.core);
    let removed = run.core.state.remove_node(absent);
    assert!(
        removed.is_empty(),
        "removing an id that is not in `nodes` returns an empty vector"
    );
    assert_eq!(
        snapshot(&run.core),
        before,
        "and mutates nothing: the state is byte-identical across the no-op call"
    );
}

#[test]
fn removing_the_same_machine_twice_does_not_cascade_again() {
    // IDEMPOTENCY EDGE (LINK-07), second half.
    let mut run = three_belt_run();
    let first: BTreeSet<NodeId> = run.core.state.remove_node(run.sink).into_iter().collect();
    assert_eq!(first, set(&[run.sink, run.c]), "the first call takes the two");
    let second = run.core.state.remove_node(run.sink);
    assert!(
        second.is_empty(),
        "the second call takes nothing and does not reach for b or a"
    );
    assert_eq!(
        directly_docked_belts(&run.core, run.b),
        set(&[run.a]),
        "a and b are still linked to each other after both calls"
    );
}

#[test]
fn the_cascade_removed_belt_set_is_the_set_the_delete_guard_already_counts() {
    // THE UI CLAUSE, pinned in the core (LINK-07, UI-SPEC 5.1 and 6.3).
    //
    // Two SHIPPED readers have to agree for the delete-guard dialog to be telling the
    // truth, and neither of them is changed by this phase:
    //   - `frontend/src/input/gestures.ts:353` (`inFlightForNode`) sums `items.length`
    //     over the belts docked DIRECTLY to the node being deleted;
    //   - `frontend/src/chrome/DeleteGuardDialog.tsx:152-155` renders that sum as the
    //     "N items in flight" sentence the user reads before they confirm.
    //
    // On the pre-fix tree the dialog counted the items on ONE belt and the delete then
    // discarded the items on THREE. The sentence starts being true the moment the cascade
    // set equals the directly-docked set, with not a word of its copy moving. This case is
    // what stops a later widening of the cascade from quietly making it false again.
    let mut run = three_belt_run();
    let guard_counted = directly_docked_belts(&run.core, run.sink);
    assert_eq!(
        guard_counted,
        set(&[run.c]),
        "the dialog's own set: the belts docked directly to the node"
    );
    let removed: BTreeSet<NodeId> = run.core.state.remove_node(run.sink).into_iter().collect();
    let removed_belts: BTreeSet<NodeId> = removed
        .iter()
        .copied()
        .filter(|id| *id != run.sink)
        .collect();
    assert_eq!(
        removed_belts, guard_counted,
        "the belts the delete destroys are exactly the belts the delete guard counted"
    );
}

// ---------------------------------------------------------------------------
// The BELT-source rule (74-12, WINDOWS row 231). Deleting one belt of a joined run
// takes that belt and nothing else.
// ---------------------------------------------------------------------------

#[test]
fn deleting_one_belt_of_a_joined_run_takes_that_belt_and_nothing_else() {
    // ADJACENCY EDGE (LINK-07): `b` is joined to a BELT on BOTH sides, so this is the
    // strongest board available - the un-narrowed cascade had two belts to reach for and
    // the narrowed one reaches for neither. A belt joined on one side only is the weaker
    // case and is covered by the same assertion.
    //
    // The criterion here is SET EQUALITY, and saying so is not decoration. The mechanical
    // arm of this file's header rule is a grep for a length compared against a numeric
    // literal by operator, and that grep does not see an `assert_eq!` whose first argument
    // is a `.len()` call. It is therefore a partial check, and what actually holds the line
    // is the named expected set below: a bound of one is also satisfied by a build that
    // removed the wrong single node.
    let mut run = three_belt_run();
    let removed: BTreeSet<NodeId> = run.core.state.remove_node(run.b).into_iter().collect();
    assert_eq!(
        removed,
        set(&[run.b]),
        "deleting one belt of a joined run takes that belt alone; the un-narrowed cascade \
         returns {{b, a, c}} and a cascade narrowed in the wrong direction returns {{b, c}}"
    );

    // IDEMPOTENCY EDGE (LINK-07): the second call takes nothing and does not reach for the
    // neighbours it declined to take the first time.
    let after_first = snapshot(&run.core);
    let second = run.core.state.remove_node(run.b);
    assert!(
        second.is_empty(),
        "the second delete of the same belt takes nothing: {second:?}"
    );
    assert_eq!(
        snapshot(&run.core),
        after_first,
        "and mutates nothing: a, c and the sink are exactly as the first call left them"
    );

    // THE MACHINE RULE IS NOT RESTATED HERE, and the omission is deliberate. It is already
    // asserted four times over by 74-03's cases in this same file, and repeating it inside
    // a belt case would blur the one signal that tells a NARROWING from a DELETION: a
    // `cascade_neighbours` emptied unconditionally reddens the machine cases and leaves the
    // belt cases green, and a belt case that also asserts the machine rule cannot show that.
}

#[test]
fn the_neighbours_of_a_deleted_belt_survive_it_and_keep_the_links_it_never_touched() {
    // The survivors are the whole point of the narrowing, so they are asserted as board
    // truth rather than inferred from the removed set.
    let mut run = three_belt_run();
    run.core.state.remove_node(run.b);

    for (id, name) in [(run.a, "a"), (run.c, "c"), (run.sink, "the sink")] {
        assert!(
            run.core.state.node(id).is_some(),
            "{name} survives the delete of the belt it was joined to"
        );
    }

    // The link `a` shared with the deleted belt died WITH it - `remove_node_traces` drops
    // every link naming the removed node on either side, so nothing extra is needed to
    // sever the join. This is the `judge_docks` RELEASE outcome, reached by a different
    // route: the belt survives, disconnected.
    assert_eq!(
        run.core.state.link_target((run.a, 0)),
        None,
        "the a -> b join went with b; keeping it would be a StateInvariant::DanglingLink"
    );
    // A link the delete never touched, one hop the other side of the deleted belt. On the
    // un-narrowed tree this was gone too, because `c` itself was removed.
    assert_eq!(
        run.core.state.link_target((run.c, 0)),
        Some((run.sink, 0)),
        "the c -> sink link is nowhere near the deleted belt and must still be there"
    );

    // D-04 / D-06: the survivor kept BOTH of its ends. A belt is a ported node since
    // 74-02, and a survivor that lost a port record is not a survivor.
    let ports = run
        .core
        .state
        .ports_of(run.a)
        .expect("the surviving belt still declares its ports");
    assert_eq!(
        ports,
        run.core
            .state
            .ports_of(run.c)
            .expect("and so does the belt on the other side"),
        "both survivors carry the same two-record belt port catalog they were minted with"
    );
    assert!(
        matches!(ports, [_, _]),
        "the survivor declares exactly its Tail and its Head: {ports:?}"
    );
}

#[test]
fn the_capture_of_a_belt_delete_names_no_cascade_belt_and_carries_the_belts_own_links() {
    // The capture and the removal read the ONE narrowed `cascade_neighbours`, so the two
    // cannot disagree on the new depth any more than they could on the old one. That is
    // asserted here rather than argued: the capture names no cascade belt, and the removal
    // takes none.
    let mut run = three_belt_run();
    let capture = run.core.state.capture_deleted_subgraph(run.b);
    assert!(
        capture.belts.is_empty(),
        "a belt delete cascades no belt at all, so the capture names none: {:?}",
        captured_belt_ids(&capture, run.b)
    );

    // The belt's OWN links ride `self_record`, which is the material the undo re-docks
    // from. Both joins must be there: one where the belt is the link SOURCE and one where
    // it is the TARGET, which `dock_legs` reads as a Head leg and a Tail leg.
    let Some(DeletedSelf::Belt(deleted)) = &capture.self_record else {
        panic!(
            "the deleted node was a bare belt, so its capture carries a DeletedSelf::Belt: \
             {:?}",
            capture.self_record
        );
    };
    let carried: BTreeSet<(NodeId, PortId, NodeId, PortId)> =
        deleted.links.iter().copied().collect();
    assert_eq!(
        carried,
        [(run.a, 0, run.b, 0), (run.b, 0, run.c, 0)]
            .into_iter()
            .collect::<BTreeSet<_>>(),
        "the self record names BOTH of the deleted belt's joins, with no skip; a record \
         short one leg is an undo that hands back a board joined at one end only"
    );

    let removed: BTreeSet<NodeId> = run.core.state.remove_node(run.b).into_iter().collect();
    assert_eq!(
        removed,
        set(&[run.b]),
        "and the removal agrees with the capture, structurally: both read the same query"
    );
}

#[test]
fn a_belt_delete_leaves_a_board_that_still_saves_and_loads() {
    // Driven through the PUBLIC fold path, not the bare `remove_node`, so the scheduler
    // pairing runs too. `restore` runs `validate_invariants`, so `is_ok()` IS the proof
    // that the surviving disconnected belt is not a `DanglingLink` or any other trust-gate
    // refusal. A belt left standing with a link to a dead node would fail here.
    let mut run = three_belt_run();
    run.core.advance_edits(&[edit_delete(run.b, 1, 0)], &[]);
    assert_eq!(
        run.core
            .last_tick
            .removed
            .iter()
            .copied()
            .collect::<BTreeSet<_>>(),
        set(&[run.b]),
        "the fold path removes the same set the state call does"
    );
    assert!(
        restore(&snapshot(&run.core)).is_ok(),
        "the board a belt delete leaves still saves and loads, disconnected belt and all"
    );
}
