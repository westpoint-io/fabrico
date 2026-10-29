//! LINK-07, the undo half: ONE undo hands back every node the delete removed, on a board
//! where a MULTI-BELT run feeds the deleted machine.
//!
//! Phase 74 lets two belt runs join, so `a -> b -> c -> SINK` is a board a user can now
//! build with four gestures. Deleting the SINK takes the SINK and the belt touching it
//! (`c`), and one Undo has to put both back AND re-link `b -> c` - a link whose two
//! endpoints are BOTH belts, which is a shape the undo's re-mint translation had never
//! seen before this phase.
//!
//! # TWO COMPARISONS ARE FORBIDDEN HERE, and here is why each one is
//!
//! 1. **Raw `NodeId`s across the Delete/Undo pair.** The undo of a Delete RE-MINTS every
//!    node it restores, so the restored SINK and the restored belt carry ids the pre-delete
//!    board never held; comparing ids directly asserts that a re-mint did not happen, which
//!    is the opposite of what the undo is for. Everything below is compared through
//!    `GridSession::id_translation`, the session's own original-to-current re-mint table.
//!
//! 2. **Snapshot or `Core` bytes across two applies.** `Core::tick` is a SERIALIZED field
//!    (`core.rs`) and `GridSession::apply` advances it on every record, so any byte
//!    comparison of a `Core` taken before an apply against one taken after is unsatisfiable
//!    BY CONSTRUCTION - it can never pass, and the next person to hit it rewrites it into
//!    something weaker without knowing that is what they did. Neither the snapshot function
//!    nor a postcard encode of the core is called anywhere in this file, deliberately, and
//!    a grep for both is one of this plan's acceptance criteria.
//!
//! What IS compared is a PROJECTION: for every node the board held before the delete, its
//! dense render handle presence, its kind, its geometry (belts) or anchor cell (machines),
//! plus the whole link set with both endpoints translated through the re-mint table.
//!
//! Run target: `cargo test -p fabrico-command --test belt_run_delete_undo`.

use std::collections::{BTreeMap, BTreeSet};

use fabrico_command::{CommandError, GridSession};
use fabrico_core::edit::{EDIT_SCHEMA_VERSION, EditOp, EditRecord};
use fabrico_core::ids::{NodeId, PortId};
use fabrico_core::state::Node;
use fabrico_protocol::{BeltEnd, GridCommand, machine_kind};

const SEED: u64 = 0x0074_0003_11A7;

/// One directed link, `(from_node, from_port) -> (to_node, to_port)`.
type Link = ((NodeId, PortId), (NodeId, PortId));

/// What one node looks like on the board, with nothing id-shaped in it.
///
/// `handle` is `true` when the node holds a dense render handle: a node the undo restored
/// into `GridState` but not into the handle table is a node the user cannot see or click,
/// which is a restore that only looks complete from the core's side.
#[derive(Debug, PartialEq, Eq)]
struct Shape {
    handle: bool,
    /// `0` machine, `1` belt - the discriminant this projection needs, not the wire kind.
    belt: bool,
    /// A belt's drawn tile cells; a machine's anchor cell as a one-element vector.
    cells: Vec<(i32, i32)>,
}

/// The board as this file compares it. Keyed by the node's ORIGINAL `NodeId`, resolved
/// through the re-mint table at read time, so the same function answers before the delete
/// (where the table is empty and every id is its own) and after the undo (where it is not).
#[derive(Debug, PartialEq, Eq)]
struct Projection {
    nodes: BTreeMap<NodeId, Option<Shape>>,
    links: BTreeSet<Link>,
}

/// `id`'s CURRENT id, through the session's own original-to-current re-mint table. The
/// identity for a node no undo has re-minted.
fn live(session: &GridSession, id: NodeId) -> NodeId {
    // CHASED to a fixpoint, not read once. The table maps each id to the id that
    // SUPERSEDED it, and a second Delete-Undo round trip re-mints an already-re-minted
    // node, so the original's entry then points at an id that is itself superseded. A
    // single lookup answers with a dead id from the middle of the chain.
    let mut at = id;
    for _ in 0..8 {
        match session.id_translation().get(&at).copied() {
            Some(next) if next != at => at = next,
            _ => return at,
        }
    }
    panic!("the re-mint chain for {id:?} did not settle in 8 steps");
}

/// The projection of `originals` (ids as the board first minted them).
fn projection(session: &GridSession, originals: &[NodeId]) -> Projection {
    let state = &session.core().state;
    // Current id -> the original id it stands for, so the live link map can be read back
    // into the space the pre-delete board was recorded in.
    let mut back: BTreeMap<NodeId, NodeId> = BTreeMap::new();
    let mut nodes = BTreeMap::new();
    for &orig in originals {
        let now = live(session, orig);
        back.insert(now, orig);
        let shape = state.node(now).map(|node| match node {
            Node::Belt(b) => Shape {
                handle: session.view().handle_of(now).is_some(),
                belt: true,
                cells: b.geometry.iter().map(|tile| tile.cell).collect(),
            },
            _ => Shape {
                handle: session.view().handle_of(now).is_some(),
                belt: false,
                cells: state.cell_of(now).into_iter().collect(),
            },
        });
        nodes.insert(orig, shape);
    }
    let links = state
        .links_iter()
        .map(|((f, fp), (t, tp))| {
            let f = back.get(&f).copied().unwrap_or(f);
            let t = back.get(&t).copied().unwrap_or(t);
            ((f, fp), (t, tp))
        })
        .collect();
    Projection { nodes, links }
}

/// The board: `a -> b -> c -> SINK`, every edge built through the CERTIFIED gesture path.
///
/// Layout on row 0, left to right: belt `a` on `(5,0)-(6,0)`, belt `b` on `(7,0)-(8,0)`,
/// belt `c` on `(9,0)-(10,0)`, SINK at `(11,0)`. A SINK's In port is its own cell facing
/// W, so `c`'s Head at `(10,0)` abuts it. Each belt's Head then docks to the NEXT node's
/// port 0, which for a belt is its Tail.
///
/// Returns `(session, [sink, a, b, c])` with the ids in that order.
fn belt_run_into_a_sink() -> (GridSession, Vec<NodeId>) {
    let mut session = GridSession::new(SEED);
    let mut minted: Vec<NodeId> = Vec::new();
    let mut apply = |session: &mut GridSession, cmd: GridCommand, what: &str| {
        session
            .apply(cmd)
            .unwrap_or_else(|e| panic!("{what}: rejected with {e:?}"));
        let placed: Vec<NodeId> = session.core().last_tick.placed.to_vec();
        minted.extend(placed);
    };
    apply(
        &mut session,
        GridCommand::Place {
            kind: machine_kind::SINK,
            cell_x: 11,
            cell_y: 0,
        },
        "place the SINK",
    );
    apply(
        &mut session,
        GridCommand::DrawBelt {
            cells: vec![(9, 0), (10, 0)],
        },
        "draw belt c, the one touching the SINK",
    );
    apply(
        &mut session,
        GridCommand::DrawBelt {
            cells: vec![(7, 0), (8, 0)],
        },
        "draw belt b",
    );
    apply(
        &mut session,
        GridCommand::DrawBelt {
            cells: vec![(5, 0), (6, 0)],
        },
        "draw belt a",
    );
    // Handles are dense and assigned in mint order: SINK 0, c 1, b 2, a 3.
    apply(
        &mut session,
        GridCommand::Dock {
            belt: 1,
            endpoint: BeltEnd::Head,
            node: 0,
            port: 0,
        },
        "dock c's HEAD into the SINK In",
    );
    apply(
        &mut session,
        GridCommand::Dock {
            belt: 2,
            endpoint: BeltEnd::Head,
            node: 1,
            port: 0,
        },
        "dock b's HEAD to c's Tail - the belt-to-belt join",
    );
    apply(
        &mut session,
        GridCommand::Dock {
            belt: 3,
            endpoint: BeltEnd::Head,
            node: 2,
            port: 0,
        },
        "dock a's HEAD to b's Tail - the second belt-to-belt join",
    );
    assert_eq!(
        minted.len(),
        4,
        "the board minted exactly the SINK and three belts, in gesture order"
    );
    (session, minted)
}

/// Delete the SINK through the certified path, by its dense handle.
fn delete_the_sink(session: &mut GridSession, sink: NodeId) {
    let handle = session
        .view()
        .handle_of(sink)
        .expect("the SINK holds a dense handle before it is deleted");
    session
        .apply(GridCommand::Delete { node: handle })
        .expect("deleting the SINK is buildable");
}

#[test]
fn one_undo_restores_every_node_the_delete_removed() {
    let (mut session, ids) = belt_run_into_a_sink();
    let (sink, c, b, a) = (ids[0], ids[1], ids[2], ids[3]);
    let before = projection(&session, &ids);
    assert!(
        before.links.contains(&((b, 0), (c, 0))),
        "the board really carries the belt-to-belt link this case is about: {:?}",
        before.links
    );

    delete_the_sink(&mut session, sink);
    let after_delete = projection(&session, &ids);
    assert_ne!(
        after_delete, before,
        "the delete really changed the board, so the restore below is a real change"
    );
    assert_eq!(
        after_delete.nodes.get(&c),
        Some(&None),
        "the belt touching the SINK went with it"
    );
    assert_eq!(
        after_delete.nodes.get(&b).map(Option::is_some),
        Some(true),
        "and belt b, one hop further out, did NOT"
    );

    session
        .apply(GridCommand::Undo)
        .expect("undoing the delete of a SINK a belt run feeds is buildable");

    assert_eq!(
        projection(&session, &ids),
        before,
        "one undo hands back the whole board: every node, its handle, its geometry, and \
         every link, read through the session's re-mint table"
    );
    // Named separately so a failure reads as a sentence rather than a diff of two maps.
    // This is the edge whose two endpoints are BOTH belts.
    let restored = projection(&session, &ids);
    assert!(
        restored.links.contains(&((b, 0), (c, 0))),
        "the belt-to-belt link is back, with the re-minted belt on the far end"
    );
    assert!(
        restored.links.contains(&((c, 0), (sink, 0))),
        "and so is the link into the restored SINK"
    );
    let _ = a;
}

#[test]
fn identify_belt_names_the_belt_that_was_removed_and_not_its_surviving_neighbour() {
    // BOTH ENDPOINTS OF A CAPTURED CASCADE LINK ARE BELTS. The capture of a Delete of the
    // SINK records ONE cascade belt, `c`, and `c`'s incident links are
    // `[(b,0) -> (c,0), (c,0) -> (sink,0)]`. The first of those names two belts and no
    // machine, and a `DeletedBelt` carries NO node id, so the undo has to INFER which of
    // the two the record is about. Getting it wrong does not crash: it writes
    // `b -> <the re-minted belt>` into the re-mint table and re-links the SURVIVING
    // neighbour instead of the node that was actually removed, silently.
    //
    // The assertion is on the table itself, which is where a wrong answer lands.
    let (mut session, ids) = belt_run_into_a_sink();
    let (sink, c, b, _a) = (ids[0], ids[1], ids[2], ids[3]);
    delete_the_sink(&mut session, sink);
    session.apply(GridCommand::Undo).expect("undo the delete");

    // MEASURED, and it is why the assertion below is written as a SET of the ids whose
    // entry MOVED rather than as the presence of a key: the table is seeded with an
    // identity entry for every node the board ever minted, so `contains_key` is true for
    // all four ids before anything is deleted and could never fail.
    let xlate = session.id_translation().clone();
    let re_minted: BTreeSet<NodeId> = xlate
        .iter()
        .filter(|(orig, now)| orig != now)
        .map(|(orig, _)| *orig)
        .collect();
    assert_eq!(
        re_minted,
        [sink, c].into_iter().collect::<BTreeSet<NodeId>>(),
        "exactly the SINK and the belt that touched it were re-minted. An `identify_belt` \
         that read the belt-to-belt link from the wrong end names b here instead of c, and \
         then the undo re-links the SURVIVING neighbour rather than the node that was \
         actually removed - got {xlate:?}"
    );
    let c_new = xlate.get(&c).copied().expect("c has an entry");
    assert!(
        matches!(session.core().state.node(c_new), Some(Node::Belt(_))),
        "the id it names is a live BELT, not a stale id and not the machine"
    );
    // The consequence of the right answer, stated as board truth: the surviving belt `b`
    // is linked to the RESTORED belt, not to a stale or wrong id.
    assert_eq!(
        session.core().state.link_target((b, 0)),
        Some((c_new, 0)),
        "b's downstream link points at the belt the undo re-minted"
    );
}

#[test]
fn one_undo_of_a_belt_delete_gives_the_belt_and_both_of_its_joins_back() {
    // THE BELT-SOURCE HALF (74-12, WINDOWS row 231). Every case above deletes the SINK.
    // This one deletes belt `b`, which is joined to a BELT on both sides, so it is the
    // board on which the un-narrowed cascade had two belts to reach for. Since 74-12 the
    // Delete takes `b` alone, which means the join `a` shared with it is a link the undo
    // now has to put back on its own rather than getting it for free from re-minting both
    // belts together.
    //
    // The undo leg needed NO source change in this crate. `self_record_links` returns
    // `dock_legs(&b.links, node, None)` for a `DeletedSelf::Belt`, with no skip, so a bare
    // belt delete already owed a re-`Dock` for EVERY link the belt carried, and 74-02 made
    // a `Dock` naming a belt legal. This case is what proves that rather than asserting it.
    let (mut session, ids) = belt_run_into_a_sink();
    let (sink, c, b, a) = (ids[0], ids[1], ids[2], ids[3]);
    let before = projection(&session, &ids);
    assert!(
        before.links.contains(&((a, 0), (b, 0))) && before.links.contains(&((b, 0), (c, 0))),
        "the deleted belt really is joined at BOTH ends before the delete: {:?}",
        before.links
    );
    let live_nodes_before = before.nodes.values().filter(|s| s.is_some()).count();

    let handle = session
        .view()
        .handle_of(b)
        .expect("belt b holds a dense handle before it is deleted");
    session
        .apply(GridCommand::Delete { node: handle })
        .expect("deleting one belt of a joined run is buildable");

    let after_delete = projection(&session, &ids);
    for (id, name) in [(a, "belt a"), (c, "belt c"), (sink, "the SINK")] {
        assert_eq!(
            after_delete.nodes.get(&id).map(Option::is_some),
            Some(true),
            "{name} is still on the board: the delete took the belt the user selected and \
             nothing across a belt-to-belt dock"
        );
    }
    assert_eq!(
        after_delete.nodes.get(&b),
        Some(&None),
        "and the belt the user selected is gone"
    );
    assert_eq!(
        after_delete.nodes.values().filter(|s| s.is_some()).count(),
        live_nodes_before - 1,
        "the board holds exactly ONE fewer node than it did: {after_delete:?}"
    );

    session
        .apply(GridCommand::Undo)
        .expect("undoing the delete of one belt of a joined run is buildable");

    // The strong claim: every node, its handle, its geometry and the WHOLE link set, read
    // back through the session's re-mint table into the space the pre-delete board was
    // recorded in.
    assert_eq!(
        projection(&session, &ids),
        before,
        "one undo hands the belt back with the board exactly as it was"
    );

    // The two named legs. These overlap the projection equality deliberately: the equality
    // is what actually holds the line, and these are what make a failure diagnosable from
    // the panic line. Both endpoints are resolved through `id_translation`, never as raw
    // pre-delete ids.
    let (a_now, b_now, c_now) = (live(&session, a), live(&session, b), live(&session, c));
    assert_eq!(
        session.core().state.link_target((a_now, 0)),
        Some((b_now, 0)),
        "the join belt a shared with the deleted belt is back, naming the re-minted belt"
    );
    assert_eq!(
        session.core().state.link_target((b_now, 0)),
        Some((c_now, 0)),
        "and so is the join on the other end: the re-minted belt is docked at BOTH ends"
    );
}

#[test]
fn delete_undo_delete_undo_lands_on_the_same_board_as_one_delete_undo() {
    // IDEMPOTENCY EDGE (LINK-07). The second round trip must not accumulate: not an extra
    // node, not a stale link, not a re-mint table entry that points at a dead id.
    let (mut session, ids) = belt_run_into_a_sink();
    let sink = ids[0];
    let before = projection(&session, &ids);

    delete_the_sink(&mut session, sink);
    session.apply(GridCommand::Undo).expect("first undo");
    let once = projection(&session, &ids);
    assert_eq!(once, before, "one Delete-Undo is a round trip");

    // The SINK now lives under a re-minted id, so the second delete has to be aimed
    // through the re-mint table exactly as any later gesture would be.
    let sink_now = live(&session, sink);
    delete_the_sink(&mut session, sink_now);
    session.apply(GridCommand::Undo).expect("second undo");
    assert_eq!(
        projection(&session, &ids),
        once,
        "and so is the second: Delete-Undo-Delete-Undo lands on the same board"
    );
}


/// T-74-14, the tampering half of LINK-07: a capture whose cascade-belt record names NO
/// links cannot say which belt it is about, and the answer must be a typed refusal rather
/// than a guess.
///
/// MEASURED on the pre-fix tree, through the public `GridSession::replay` primitive (the
/// same forged-log idiom `undo_restores_every_link.rs` uses, and the same one a corrupt or
/// hand-edited project file arrives through): `identify_belt` fell back to returning the
/// MACHINE's id, and the xlate rebuild then wrote `machine -> <the re-minted BELT>` on top
/// of the entry naming the re-minted machine. `apply(Undo)` returned `Ok(())`. From that
/// point on every gesture aimed at the machine resolved to a belt, and nothing had told
/// anyone. That is the exact shape this phase exists to close: not a crash, a board that
/// is quietly not the board it says it is.
#[test]
fn a_capture_whose_belt_record_names_no_links_is_refused_and_never_renames_the_machine() {
    let (session, ids) = belt_run_into_a_sink();
    let sink = ids[0];
    let mut records: Vec<EditRecord> = session.edit_log().to_vec();
    // The capture is the REAL one, taken with the same function the live enrichment path
    // calls, then damaged in exactly one way. A hand-written capture would let this pass
    // against a build whose capture had gone empty for its own reasons.
    let mut captured = session.core().state.capture_deleted_subgraph(sink);
    assert!(
        !captured.belts.is_empty(),
        "the delete really does cascade a belt, so clearing its links damages something"
    );
    captured.belts[0].links.clear();
    let next = |records: &[EditRecord], f: fn(&EditRecord) -> u64| {
        records.iter().map(f).max().map_or(0, |v| v + 1)
    };
    records.push(EditRecord {
        schema_version: EDIT_SCHEMA_VERSION,
        partition: 0,
        sequence: next(&records, |r| r.sequence),
        tick: next(&records, |r| r.tick),
        action: next(&records, |r| r.action),
        op: EditOp::Delete {
            node: sink,
            kind: machine_kind::SINK,
            cell_x: 11,
            cell_y: 0,
            captured,
        },
    });
    let mut forged = GridSession::replay(SEED, &records);
    assert_eq!(
        forged.apply(GridCommand::Undo).map(|_| ()),
        Err(CommandError::UndoDoesNotFit),
        "an undo that cannot tell which belt the capture is about refuses BEFORE it \
         mutates, rather than restoring a board that is not the one the delete took"
    );
    // And the refusal left the re-mint table honest: whatever the machine's entry names,
    // it is not a belt.
    let machine_now = forged
        .id_translation()
        .get(&sink)
        .copied()
        .expect("the machine has an entry");
    assert!(
        !matches!(forged.core().state.node(machine_now), Some(Node::Belt(_))),
        "the machine's re-mint entry names a machine or nothing at all, never a belt"
    );
}
