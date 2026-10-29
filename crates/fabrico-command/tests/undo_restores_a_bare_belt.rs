//! Phase 73-05 (UNDO-02) - THE BELT COMES BACK.
//!
//! Deleting a drawn belt and pressing Ctrl+Z returned `Err(CommandError::Malformed)` and
//! restored nothing. `compute_inverse`'s Delete arm inverted every non-wire delete through
//! `EditOp::Place`, and `fold_place` has an arm for every machine kind EXCEPT BELT (1) and
//! WIRE (8) - its own `_ => return` comment names those two as the kinds it deliberately
//! never mints. So the re-Place minted nothing, `pred.last_tick.placed` came back empty,
//! and the whole group was refused before any mutation.
//!
//! That refusal is unreachable from the shipped UI today only because belts are not
//! selectable, and it becomes a user-facing "Ctrl+Z did nothing" the day phase 74's
//! LINK-05 makes them selectable. Plan 73-03 gave the WIRE half of this its `DrawWire`
//! leg; this plan gives the BELT half its `DrawBelt` leg, off the same
//! `DeletedSubgraph.self_record` field.
//!
//! # The measured RED, taken on this tree before the fix
//! A throwaway probe ran the ten-kind sweep below against HEAD and printed, per kind, the
//! undo verdict and the live count afterwards:
//!
//! ```text
//! kind 0: undo verdict Ok(()),          live count after = 1
//! kind 1: undo verdict Err(Malformed),  live count after = 0
//! kind 2..7, 9, 10: undo verdict Ok(()), live count after = 1
//! ```
//!
//! EXACTLY ONE of the ten rows (BELT) was red and the other nine were green. That is what
//! stops this sweep passing by accident, and it is also what stops it being satisfiable by
//! weakening the belt row alone: nine rows would have to be broken for the sweep to become
//! vacuous, and any one of them breaking is itself a failure.
//!
//! # The assertion discipline, spelled out rather than assumed
//! The link legs below compare SETS after substituting the re-minted ids, and never a
//! length or a count. A count-based assertion passes on a build that restores one edge and
//! drops another, which is the exact class of defect UNDO-02 and UNDO-03 exist to close.
//! The same rule is written into `undo_restores_a_wire.rs` and `rotate_undo_redock.rs` and
//! is copied here on purpose.
//!
//! Every test carries a `// RED ON HEAD BECAUSE:` line stating what it measured on the
//! pre-fix tree, so no row here is a green that was never able to be red.

use std::collections::BTreeSet;

use fabrico_command::{CommandError, GridLookup, GridSession};
use fabrico_core::edit::{DeletedSubgraph, EditOp, EditRecord};
use fabrico_core::ids::{Item, NodeId, PortId};
use fabrico_core::state::Node;
use fabrico_protocol::{BeltEnd, GridCommand, machine_kind};

const SEED: u64 = 0x0073_0005_C0FF_EE00;

/// One directed link, `(from_node, from_port) -> (to_node, to_port)`.
type Link = ((NodeId, PortId), (NodeId, PortId));

/// The grid's directed links as a SET - the oracle every restore leg here asserts on.
type LinkSet = BTreeSet<Link>;

/// UNDO-02's sweep, TEN rows (ruling R-19). The requirement text lists nine; it was
/// written before `machine_kind::HANDLER` (10) existed, and `fold_place` gained its
/// HANDLER arm in plan 72-06. A sweep that silently omits the NEWEST placeable kind has
/// its hole in exactly the place a hole is most likely, so HANDLER is a row.
///
/// WIRE (8) is deliberately absent: it belongs to UNDO-01 and its restore leg is covered
/// by `crates/fabrico-command/tests/undo_restores_a_wire.rs`, which plan 73-03 wrote.
///
/// Both halves of that shape are ENFORCED rather than trusted, by two verify arms plan
/// 73-05 carries: one greps this file's NON-COMMENT lines for `HANDLER` and fails if the
/// count is zero (the sweep is ten rows, not the requirement text's nine), and one greps
/// them for `WIRE` and fails if the count is above zero (the sweep does not double-count
/// UNDO-01's fix). Those greps are why no runtime guard for either appears below: a
/// runtime `assert_ne!(kind, machine_kind::WIRE)` would itself put the token on a
/// non-comment line and turn the second arm permanently red.
const EVERY_PLACEABLE_KIND: [u8; 10] = [
    machine_kind::SOURCE,
    machine_kind::BELT,
    machine_kind::FACTORY,
    machine_kind::TEE,
    machine_kind::BALANCER,
    machine_kind::ROUTER,
    machine_kind::MERGE,
    machine_kind::SINK,
    machine_kind::ENDPOINT,
    machine_kind::HANDLER,
];

/// Every directed link in the grid, as a SET.
///
/// A set and not a `Vec`: a restore is a claim about WHICH edges exist, not about the
/// order a `BTreeMap` walk happens to yield them in.
fn link_set(session: &GridSession) -> LinkSet {
    session.core().state.links_iter().collect()
}

/// Substitute every occurrence of `old` with `new` in a link set - the SAME old-to-new
/// remapping seam `compute_inverse` performs through its `remap` map, applied on the test
/// side so the pre-delete map and the post-undo map become comparable.
///
/// A restored node is re-MINTED, so its `NodeId` is necessarily new. Without this
/// substitution the two sets could never be equal and the only assertion left would be a
/// count, which is precisely what this file refuses to do.
fn remap_links(links: &LinkSet, old: NodeId, new: NodeId) -> LinkSet {
    let sub = |n: NodeId| if n == old { new } else { n };
    links
        .iter()
        .map(|&((f, fp), (t, tp))| ((sub(f), fp), (sub(t), tp)))
        .collect()
}

/// The id of the most recently minted node, read off the SAME seam `compute_inverse`'s
/// `remap` harvests from: `core.last_tick.placed`. Reading it any other way (by position,
/// by "the highest id", by re-finding the only belt) would be a second, parallel rule that
/// could agree with the real one by luck.
fn last_minted(session: &GridSession) -> NodeId {
    *session
        .core()
        .last_tick
        .placed
        .last()
        .expect("the last accepted command minted a node")
}

/// The most recently minted node's dense render handle.
fn last_minted_handle(session: &GridSession) -> u64 {
    let id = last_minted(session);
    session
        .view()
        .handle_of(id)
        .expect("the minted node got a render handle")
}

/// How many LIVE nodes currently project to `kind`.
///
/// Read through `GridLookup::kind_of`, which is the Delete-time kind capture itself, so
/// this asks the same question the command layer asks. It matters for HANDLER: a Handler
/// folds to a `Node::Factory` (72-CONTEXT D-11) and only the shared `is_handler_shape`
/// predicate tells the two apart, so a `Node`-variant match would report every restored
/// Handler as a Factory and the HANDLER row would assert nothing.
fn live_count_of_kind(session: &GridSession, kind: u8) -> usize {
    let core = session.core();
    let lookup = session.view().lookup(core);
    core.state
        .node_ids()
        .filter(|id| lookup.kind_of(*id) == Some(kind))
        .count()
}

/// Build ONE live node of `kind` on a fresh session and return `(session, id, handle)`.
///
/// BELT takes `DrawBelt` and every other kind takes `Place`: `validate_normalize` rejects
/// `Place { kind: BELT }` with `BeltNotPlaceable` (17-02, CAT-04), so a belt can only ever
/// arrive through the draw seam. That asymmetry is the reason the sweep is a table of
/// builders rather than one loop over `Place`.
fn one_node_of_kind(kind: u8) -> (GridSession, NodeId, u64) {
    let mut session = GridSession::new(SEED);
    if kind == machine_kind::BELT {
        session
            .apply(GridCommand::DrawBelt {
                cells: vec![(2, 2), (3, 2), (4, 2)],
            })
            .expect("a clear drawn path is accepted");
    } else {
        session
            .apply(GridCommand::Place {
                kind,
                cell_x: 0,
                cell_y: 0,
            })
            .expect("a placeable kind at a free cell is accepted");
    }
    let id = last_minted(&session);
    let handle = last_minted_handle(&session);
    (session, id, handle)
}

/// The proven-valid OFFLOAD geometry, lifted verbatim from `rotate_undo_redock.rs`'s
/// `docked_router`: a 2x3 ROUTER anchored at `(0, 0)` presents an Out port on its E edge,
/// and a belt drawn tail-first at `(2, 1) -> (3, 1)` (the Out's middle-row doorstep since
/// plan 74.1-14; it was `(2, 2) -> (3, 2)`) presents its tail one step E of that
/// port facing W. Docking the belt's Tail is a single directed edge
/// `(router, port) -> (belt, 0)`.
///
/// Returns `(session, router_id, belt_id, belt_handle)`.
fn docked_belt() -> (GridSession, NodeId, NodeId, u64) {
    let mut session = GridSession::new(SEED);
    session
        .apply(GridCommand::Place {
            kind: machine_kind::ROUTER,
            cell_x: 0,
            cell_y: 0,
        })
        .expect("place the router");
    let router = last_minted(&session);
    let router_h = last_minted_handle(&session);

    session
        .apply(GridCommand::DrawBelt {
            cells: vec![(2, 1), (3, 1)],
        })
        .expect("a clear drawn path is accepted");
    let belt = last_minted(&session);
    let belt_h = last_minted_handle(&session);

    session
        .apply(GridCommand::Dock {
            belt: belt_h,
            endpoint: BeltEnd::Tail,
            node: router_h,
            port: 1,
        })
        .expect("a valid offload dock is accepted");

    (session, router, belt, belt_h)
}

/// The drawn geometry of a live belt, cloned so it survives the delete.
fn geometry_of(session: &GridSession, belt: NodeId) -> Vec<fabrico_core::state::BeltTile> {
    match session.core().state.node(belt) {
        Some(Node::Belt(b)) => b.geometry.clone(),
        _ => panic!("the node under test is a live Node::Belt"),
    }
}

/// UNDO-02's sweep. TEN placeable kinds, each built through the public command seam, each
/// deleted, each undone. Every row asserts the verdict is `Ok` AND that a live node of
/// that kind exists again.
///
/// EXACTLY ONE ROW (BELT) IS RED BEFORE THIS PLAN AND THE OTHER NINE ARE GREEN. That is
/// measured, printed in this file's module docblock, and it is the whole non-vacuity
/// argument: the sweep cannot pass by accident, and it cannot be satisfied by weakening
/// the belt row alone, because nine independently-green rows would have to break for it to
/// stop measuring anything.
///
/// RED ON HEAD BECAUSE: the BELT row's `apply(Undo)` returns `Err(Malformed)` and the live
/// belt count stays at 0. Measured on this tree, printed above.
#[test]
fn every_placeable_kind_survives_a_delete_and_an_undo() {
    for kind in EVERY_PLACEABLE_KIND {
        let (mut session, _id, handle) = one_node_of_kind(kind);
        assert_eq!(
            live_count_of_kind(&session, kind),
            1,
            "kind {kind}: the build seam produced exactly one live node of this kind, \
             without which the post-undo assertion below would be vacuous"
        );

        session
            .apply(GridCommand::Delete { node: handle })
            .expect("a live node is deletable");
        assert_eq!(
            live_count_of_kind(&session, kind),
            0,
            "kind {kind}: the delete really removed it, so the undo has something to owe"
        );

        let verdict = session.apply(GridCommand::Undo);
        assert!(
            verdict.is_ok(),
            "kind {kind}: undoing the delete must return Ok, got {:?}",
            verdict.map(|_| ())
        );
        assert_eq!(
            live_count_of_kind(&session, kind),
            1,
            "kind {kind}: the undo put a live node of this kind back"
        );
    }
}

/// UNDO-02's headline detail. The restored belt is the SAME belt: identical drawn tiles,
/// and every one of those tile cells re-claimed in the unified occupancy index.
///
/// Geometry equality and cell re-claim are two different claims and both are asserted. A
/// `DrawBelt` that re-minted a belt with the right tiles but failed to claim their cells
/// would leave the board silently placeable-over, and vice versa.
///
/// RED ON HEAD BECAUSE: `apply(Undo)` returns `Err(Malformed)` on this board, so there is
/// no restored belt to read a geometry off at all.
#[test]
fn the_restored_belt_has_the_same_tiles_and_reclaims_its_cells() {
    let (mut session, _router, belt, belt_h) = docked_belt();
    let geometry_before = geometry_of(&session, belt);
    assert!(
        !geometry_before.is_empty(),
        "the belt under test carries tiles, without which the equality below is vacuous"
    );
    let cells_before: Vec<(i32, i32)> = geometry_before.iter().map(|t| t.cell).collect();

    session
        .apply(GridCommand::Delete { node: belt_h })
        .expect("a live belt is deletable");
    for &cell in &cells_before {
        assert_eq!(
            session.core().state.occupied(cell),
            None,
            "the delete released tile cell {cell:?}, so the re-claim below is a real change"
        );
    }

    session
        .apply(GridCommand::Undo)
        .expect("undoing the delete of a drawn belt is buildable from its self-record");

    let restored = last_minted(&session);
    assert_eq!(
        geometry_of(&session, restored),
        geometry_before,
        "the restored belt carries the IDENTICAL drawn tiles, cell for cell and shape for \
         shape"
    );
    for &cell in &cells_before {
        assert_eq!(
            session.core().state.occupied(cell),
            Some(restored),
            "tile cell {cell:?} is claimed by the restored belt again; a belt whose tiles \
             came back unclaimed is silently placeable-over"
        );
    }
}

/// UNDO-02. A dock made before the delete is a dock again after the undo, asserted as a
/// RESOLVED LINK KEY and never as the mere presence of "a dock".
///
/// The whole link set is compared after substituting the belt's re-minted id, in both
/// directions and separately by name, and the specific restored edge is then named on its
/// own so a failure is legible rather than a diff of two maps.
///
/// RED ON HEAD BECAUSE: the undo is refused outright, so the post-undo link set is the
/// POST-DELETE one - empty - and the difference below is non-empty.
#[test]
fn the_restored_belt_is_docked_again() {
    let (mut session, router, belt, belt_h) = docked_belt();
    let links_before = link_set(&session);
    assert!(
        !links_before.is_empty(),
        "the board carries at least one edge or this test asserts nothing"
    );

    session
        .apply(GridCommand::Delete { node: belt_h })
        .expect("a live belt is deletable");
    assert!(
        link_set(&session).is_empty(),
        "the delete tore the dock down, so the restore below is a real change"
    );

    session
        .apply(GridCommand::Undo)
        .expect("undoing the delete of a docked belt is buildable from its self-record");

    let restored = last_minted(&session);
    let expected = remap_links(&links_before, belt, restored);
    let actual = link_set(&session);

    // NEVER a length comparison, and this comment is part of the test. `links.len()` is
    // satisfied by a build that restores one edge and drops another, so the two directions
    // are asserted SEPARATELY and by name, and a failure says which way it went.
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

    // And the same claim once more, named, so a failure reads as a sentence. The dock was
    // an OFFLOAD (Tail), so the machine is the link SOURCE and the belt is the TARGET.
    let offload = expected
        .iter()
        .find(|((f, _), _)| *f == router)
        .copied()
        .expect("the pre-delete board carried exactly one offload out of the router");
    assert!(
        actual.contains(&offload),
        "the restored belt is docked to the SAME router port again: {offload:?}"
    );
}

/// UNDO-02, and ruling R-21. A belt carrying items comes back EMPTY, and that is a
/// recorded decision rather than an accident.
///
/// `GridState::remove_node_traces` drops a belt's slots - and the in-flight items in them -
/// WITH the node when `nodes.remove` runs (`crates/fabrico-core/src/state.rs:2274-2277`,
/// inside a fn that opens at `:2269`). That discard is deliberate and deterministic: the
/// undo restores TOPOLOGY from the edit log, and the items a belt was carrying are SIM
/// state that no log record describes. Restoring the belt with invented items would hand
/// back a board the replay cannot reproduce, which is the one thing this project's core
/// promise forbids.
///
/// So this test PINS the discard rather than repairing it. UNDO-02's own wording asks for
/// the belt back "empty of the items it was carrying", and this row is what makes that a
/// written decision instead of something a later reader has to rediscover and then argue
/// about.
///
/// RED ON HEAD BECAUSE: `apply(Undo)` returns `Err(Malformed)`, so there is no restored
/// belt whose slots could be read - the Ok verdict and the live belt are both absent.
#[test]
fn a_belt_carrying_items_comes_back_empty_and_that_is_deliberate() {
    let (mut session, _router, belt, belt_h) = docked_belt();

    // Load the belt through the core's own mutable node accessor - the same seam
    // `GridState`'s own belt-quiescence tests use. Items are sim state, not log state, so
    // there is no command that puts one on a belt directly.
    let loaded = match session.core_mut().state.node_mut(belt) {
        Some(Node::Belt(b)) => {
            b.slots[0] = Some(Item(vec![0x01]));
            let last = b.slots.len() - 1;
            b.slots[last] = Some(Item(vec![0x02]));
            2
        }
        _ => panic!("the node under test is a live Node::Belt"),
    };
    assert_eq!(
        session.core().state.belt_items_in_flight(),
        loaded,
        "the belt really is carrying items, without which the empty assertion below is \
         vacuous"
    );

    session
        .apply(GridCommand::Delete { node: belt_h })
        .expect("a live belt is deletable");

    // The FIRST half of the claim, and the half UNDO-02 is actually about.
    session
        .apply(GridCommand::Undo)
        .expect("a belt that was carrying items is still restorable");

    let restored = last_minted(&session);
    let slots = match session.core().state.node(restored) {
        Some(Node::Belt(b)) => b.slots.clone(),
        _ => panic!("the undo restored a live Node::Belt"),
    };
    assert!(
        !slots.is_empty(),
        "the restored belt has slots to be empty; a zero-slot belt would satisfy the \
         emptiness assertion below without restoring anything"
    );
    assert!(
        slots.iter().all(Option::is_none),
        "every slot on the restored belt is empty: the items went with the node at delete \
         time and the log does not describe them, so putting any back would be inventing \
         sim state the replay cannot reproduce"
    );
    assert_eq!(
        session.core().state.belt_items_in_flight(),
        0,
        "and the board-wide in-flight count agrees: nothing was resurrected anywhere"
    );
}

/// Ruling R-20. The self-record belt leg is keyed off the `Delete` record's OWN `node`
/// field and NEVER routes through `identify_belt`.
///
/// `identify_belt` infers a belt's id from its incident links. Handed a self-record belt's
/// links and the deleted node's own id as `machine`, its single-link fast path returns the
/// NON-machine endpoint - which for a docked belt is the ROUTER. `remap` would then map
/// the router onto the freshly minted belt, and every subsequent retarget in the group
/// would aim at the wrong node. It produces no error at all, which is why it needs a named
/// row.
///
/// The structural half of this claim is a verify arm on the plan: `identify_belt` has
/// exactly ONE call site in `command.rs`, the cascade belt leg. This is the behavioural
/// half.
///
/// RED ON HEAD BECAUSE: the undo is refused outright and no `remap` entry is produced at
/// all, so the `id_translation` lookup below finds nothing and the router-identity
/// assertion has no restored board to make its claim about.
#[test]
fn a_bare_belt_self_record_never_routes_through_identify_belt() {
    let (mut session, router, belt, belt_h) = docked_belt();
    let router_ports_before = session
        .core()
        .state
        .ports_of(router)
        .map(<[fabrico_core::state::Port]>::to_vec)
        .expect("the router carries a resolved port array");

    session
        .apply(GridCommand::Delete { node: belt_h })
        .expect("a live belt is deletable");
    session
        .apply(GridCommand::Undo)
        .expect("undoing the delete of a docked belt is buildable from its self-record");

    let restored = last_minted(&session);

    // The DELETED NODE is what maps onto the re-minted belt. If the leg had gone through
    // `identify_belt` the router would be the key instead, and the belt would not be.
    assert_eq!(
        session.id_translation().get(&belt).copied(),
        Some(restored),
        "the deleted belt's id translates to the re-minted BELT; that mapping is keyed off \
         EditOp::Delete's own `node` field, which is the whole reason the self-record \
         needs no id of its own"
    );
    assert_ne!(
        session.id_translation().get(&router).copied(),
        Some(restored),
        "the ROUTER does not translate to the re-minted belt. It would if the self-record \
         leg had asked `identify_belt` which node the capture describes: handed one link \
         and the deleted belt's id as `machine`, that function returns the non-machine \
         endpoint, which here is the router"
    );

    // And the router itself is untouched: still live, still carrying the same ports. A
    // remap that had aimed at the router would have redirected this group's docks onto the
    // belt and left the router stranded.
    assert_eq!(
        session
            .core()
            .state
            .ports_of(router)
            .map(<[fabrico_core::state::Port]>::to_vec),
        Some(router_ports_before),
        "the router survived the round trip unchanged"
    );
    assert_ne!(
        restored, router,
        "the re-minted node is the belt, not the router"
    );
}

/// T-73-05-02. A `Delete { kind: BELT }` carrying NO self-record - every record written
/// before that field existed, and every forged one - is REFUSED with a typed error, before
/// any mutation, and never a panic.
///
/// This is the negative control on the leg above. A belt whose geometry was never recorded
/// cannot be rebuilt: `fold_place` mints no BELT, and inventing tiles would restore a
/// DIFFERENT belt on cells the user may have filled since. The honest answer is the
/// refusal that already shipped, and this row pins that the fix does not widen it into an
/// unwrap.
///
/// RED ON HEAD BECAUSE: it is not, and it says so out loud. This row is GREEN on HEAD by
/// construction. A file whose every row only measured NEW behaviour would let the fix
/// quietly turn a refusal into a panic on the forged path, which is precisely the class
/// plan 63-03 existed to close.
#[test]
fn a_belt_delete_undo_refuses_before_any_mutation_when_the_capture_is_absent() {
    let (session, _router, belt, _belt_h) = docked_belt();
    let mut records: Vec<EditRecord> = session.edit_log().to_vec();
    let next_tick = records.iter().map(|r| r.tick).max().map_or(0, |t| t + 1);
    let next_sequence = records.iter().map(|r| r.sequence).max().map_or(0, |s| s + 1);
    let next_action = records.iter().map(|r| r.action).max().map_or(0, |a| a + 1);

    // A HAND-BUILT delete: the shape a forged log carries. `DeletedSubgraph::default()`
    // has `w == 0` and `self_record: None`, so there is no geometry anywhere to draw from.
    records.push(EditRecord {
        schema_version: fabrico_core::edit::EDIT_SCHEMA_VERSION,
        partition: 0,
        sequence: next_sequence,
        tick: next_tick,
        action: next_action,
        op: EditOp::Delete {
            node: belt,
            kind: machine_kind::BELT,
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
        "a capture-less belt delete inverts to nothing buildable and must be a TYPED \
         refusal, got {verdict:?}"
    );
    // REFUSED BEFORE ANY MUTATION is the second half, and the one a typed error alone does
    // not prove: an inverse that mutated and then errored would satisfy the line above
    // while leaving the board half-restored.
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

/// T-73-05-02, second arm. A self-record belt whose `geometry` is EMPTY is refused too.
///
/// No live gesture produces one: `validate_normalize` rejects an empty `DrawBelt` before it
/// reaches the log, and the `Wire`-minted geometry-less belt was removed in 17-02. So an
/// empty-geometry self-record is a forged capture, and folding it would mint a ZERO-TILE
/// belt - a node with no slots and no cells that then gets this group's docks hung off it.
/// That is a different board from the one the delete took away, restored under an `Ok`
/// verdict, which is the exact reporting-success-while-getting-it-wrong shape this phase
/// exists to close.
///
/// RED ON HEAD BECAUSE: it is not, and like the row above it says so. On HEAD this record
/// takes the `Place` leg and is refused for the OLD reason (`fold_place` mints no BELT).
/// The row exists so the fix cannot silently convert that refusal into a degenerate
/// success, which is what a bare "emit the DrawBelt and harvest what it minted" leg would
/// have done: `fold_draw_belt` mints unconditionally, even for zero tiles.
#[test]
fn a_belt_delete_undo_refuses_a_self_record_with_no_geometry() {
    use fabrico_core::edit::{DeletedBelt, DeletedSelf};

    let (session, _router, belt, _belt_h) = docked_belt();
    let mut records: Vec<EditRecord> = session.edit_log().to_vec();
    let next_tick = records.iter().map(|r| r.tick).max().map_or(0, |t| t + 1);
    let next_sequence = records.iter().map(|r| r.sequence).max().map_or(0, |s| s + 1);
    let next_action = records.iter().map(|r| r.action).max().map_or(0, |a| a + 1);

    records.push(EditRecord {
        schema_version: fabrico_core::edit::EDIT_SCHEMA_VERSION,
        partition: 0,
        sequence: next_sequence,
        tick: next_tick,
        action: next_action,
        op: EditOp::Delete {
            node: belt,
            kind: machine_kind::BELT,
            cell_x: 0,
            cell_y: 0,
            captured: DeletedSubgraph {
                w: 1,
                h: 1,
                ports: Vec::new(),
                belts: Vec::new(),
                wires: Vec::new(),
                self_record: Some(DeletedSelf::Belt(DeletedBelt {
                    kind: machine_kind::BELT,
                    geometry: Vec::new(),
                    links: Vec::new(),
                    ..DeletedBelt::default()
                })),
                rot: 0,
            },
        },
    });

    let mut replayed = GridSession::replay(SEED, &records);
    let nodes_before = replayed.core().state.node_count();

    let verdict = replayed.apply(GridCommand::Undo);

    assert!(
        matches!(verdict, Err(CommandError::UndoDoesNotFit)),
        "a self-record belt with no tiles describes no belt, and restoring a zero-tile \
         node under an Ok verdict would be a different board reported as the same one, \
         got {verdict:?}"
    );
    assert_eq!(
        replayed.core().state.node_count(),
        nodes_before,
        "a refused undo mints nothing, not even the degenerate zero-tile belt"
    );
}
