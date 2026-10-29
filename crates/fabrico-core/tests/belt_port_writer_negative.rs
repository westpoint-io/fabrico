//! LINK-08 clause (iii): the NEGATIVE ON THE WRITER. No fold path that mints or edits a
//! belt ever emits a belt port anywhere but `local_offset (0, 0)`, asserted on the FOLDED
//! OUTPUT of `DrawBelt`, `Dock`, `Unlink` and Delete-undo.
//!
//! # Why the trust gate and the 33-snapshot re-bless are NOT substitutes for this file
//!
//! `crates/fabrico-core/src/snapshot.rs` invariant 7 rejects a port whose `local_offset`
//! falls outside its node's rot-0 footprint box, with an absent footprint defaulting to
//! `1x1`. A belt records no footprint, so that invariant already refuses every belt port
//! but `(0, 0)`, and it runs on `restore()` across all 33 blessed genesis snapshots. That
//! is the RE-BLESS, and it is a READER-side check: it can only ever see the fold paths
//! that some blessed fixture happens to exercise. A `fold_dock` that emitted a belt port
//! at a non-`(0, 0)` offset on a path no golden fixture reaches would pass every one of
//! those 33 restores and ship green.
//!
//! LINK-08's own `Confirmed by` note records that decision explicitly: its first pass
//! carried a round-trip-Ok clause and a forged-port-rejected clause, both measured
//! ALREADY GREEN with zero v9.0 work, and both "were removed and the writer negative
//! replaces them". This file IS that replacement. It asserts on what the WRITER produced,
//! one layer earlier than any gate that reads a snapshot back.
//!
//! # The sweep is fed folded output only
//!
//! Every state swept below came out of a fold. The sweep never writes a port record
//! itself, and it never hand-builds a `Port` literal to feed itself: it drives a real
//! `DrawBelt`, a real belt-to-belt `Dock`, a real `Unlink` and a real Delete-then-Undo,
//! then reads whatever the writer left in `GridState.ports`. A file that forged the state
//! it then inspected would be asserting its own arithmetic, which is precisely the
//! substitution clause (iii) forbids.
//!
//! # The non-vacuity guard is the point, not decoration
//!
//! `sweep_belt_ports` is universally quantified over "every belt in this state", and a
//! universally-quantified assertion over an EMPTY set passes. That is this repository's
//! signature defect in its purest form. So the helper RETURNS the number of belts it
//! swept, PRINTS that number, and every scenario asserts the count is non-zero BEFORE it
//! trusts anything the sweep said. `the_sweep_returns_zero_on_a_beltless_board` is the
//! proof that the guard is load-bearing: it exhibits a real state on which this sweep
//! reports success while having examined nothing.
//!
//! # What used to be true here
//!
//! Through v8.0 a belt declared no port records at all, and two belt runs could not dock
//! to each other. Phase 74 (LINK-08, D-04, D-06) ended both: a belt is a ported node
//! whose Tail is `Role::In` at catalog index 0 and whose Head is `Role::Out` at index 1,
//! and a belt-to-belt `Dock` is accepted by the certified command path. Every sentence in
//! this file is written against the second state of affairs.
//!
//! Run target: `cargo test -p fabrico-core --test belt_port_writer_negative`.

use fabrico_command::{GridSession, route};
use fabrico_core::edit::{EDIT_SCHEMA_VERSION, EditOp, EditRecord};
use fabrico_core::ids::NodeId;
use fabrico_core::state::{GridState, Medium, Node, Role};
use fabrico_protocol::{BeltEnd, GridCommand, machine_kind};

/// Pinned so a rerun folds the identical scene. Any value works; nothing here is random.
const SEED: u64 = 0x0074_0011_B017;

// ---------------------------------------------------------------------------
// The one shared sweep.
// ---------------------------------------------------------------------------

/// Assert the belt port contract over EVERY belt in `state`, and return how many belts
/// were examined.
///
/// The contract, per belt, in the order a failure is easiest to read in:
///
/// 1. `ports_of(id)` is `Some`. D-06: a belt is present in the map ALWAYS, geometry-empty
///    ones included, never `Some` for some belts and `None` for others.
/// 2. exactly two entries, no more and no fewer.
/// 3. index 0 is `Role::In` (the Tail, the admit end) and index 1 is `Role::Out` (the
///    Head, the deliver end). IN FIRST IS A CONTRACT: `fabrico-command`'s catalog parity
///    sweep `port_catalog_every_kind_lists_in_ports_first` structurally cannot see a belt
///    (its `CATALOG_KINDS` list deliberately omits BELT and BELT's catalog arm is empty),
///    and `command.rs`'s own warning says an `Out` declared before an `In` mis-keys every
///    Head dock into the wrong inbox, because a Head dock key is the RAW catalog index
///    while a Tail dock key is an `Out`-filtered routing index.
/// 4. BOTH entries at `local_offset (0, 0)`. This is the clause (iii) property.
/// 5. both `Medium::Mechanical`. A belt is a mechanical carrier at both ends; an
///    `Electrical` belt end would make `resolve_wire_leg` treat a belt as a wire endpoint.
///
/// Every message names the belt id, the port index, what was found and what the contract
/// requires, so a failure is diagnosable from the panic line alone.
///
/// # It returns a COUNT, and the caller is required to check it
/// A sweep over zero belts asserts nothing and reports success. The count is returned AND
/// printed so that outcome is visible in `--nocapture` output rather than silently green.
#[must_use]
fn sweep_belt_ports(state: &GridState, scenario: &str) -> usize {
    let belts: Vec<NodeId> = state
        .node_ids()
        .filter(|&id| matches!(state.node(id), Some(Node::Belt(_))))
        .collect();

    for &id in &belts {
        let geometry_len = match state.node(id) {
            Some(Node::Belt(b)) => b.geometry.len(),
            _ => unreachable!("the id was just filtered to a live belt"),
        };
        let ports = state.ports_of(id).unwrap_or_else(|| {
            panic!(
                "[{scenario}] belt {id:?} (geometry tiles: {geometry_len}) has NO port \
                 record at all. D-06: every belt is present in GridState.ports, drawn or \
                 not"
            )
        });
        assert_eq!(
            ports.len(),
            2,
            "[{scenario}] belt {id:?} (geometry tiles: {geometry_len}) declares {} ports; \
             the contract is exactly two, Tail then Head",
            ports.len(),
        );
        assert_eq!(
            ports[0].role,
            Role::In,
            "[{scenario}] belt {id:?} port 0 has role {:?}; index 0 is the TAIL and must \
             be Role::In. An Out-first belt mis-keys every Head dock into the wrong inbox",
            ports[0].role,
        );
        assert_eq!(
            ports[1].role,
            Role::Out,
            "[{scenario}] belt {id:?} port 1 has role {:?}; index 1 is the HEAD and must \
             be Role::Out",
            ports[1].role,
        );
        for (index, port) in ports.iter().enumerate() {
            assert_eq!(
                port.local_offset,
                (0, 0),
                "[{scenario}] belt {id:?} port {index} sits at local_offset {:?}; the \
                 contract requires (0, 0). A belt records no footprint, so trust-gate \
                 invariant 7 defaults its box to 1x1 and (0, 0) is the only offset that \
                 decodes: a board carrying this port would save and then refuse to load",
                port.local_offset,
            );
            assert_eq!(
                port.medium,
                Medium::Mechanical,
                "[{scenario}] belt {id:?} port {index} carries medium {:?}; a belt is a \
                 Mechanical carrier at both ends",
                port.medium,
            );
        }
    }

    // Printed, not merely returned: a run that swept zero belts is then visible in the
    // test output instead of passing quietly.
    println!("[{scenario}] swept {} belts", belts.len());
    belts.len()
}

/// The board every scenario below starts from: two ABUTTING belt runs on row 0, built
/// through the CERTIFIED command path one gesture per apply.
///
/// Belt A runs `(1,0) -> (2,0)`, belt B runs `(3,0) -> (4,0)`. A's Head outward side is E
/// and B's Tail outward side is W, so each end's outward step lands exactly on the other's
/// end tile. That is the ADJACENCY EDGE: the two belts genuinely abut, and the join below
/// is the one a user can build rather than a link written straight into the map.
///
/// Returns `(session, belt_a, belt_b)`. Dense handles are assigned in mint order, so belt
/// A is handle 0 and belt B is handle 1.
fn two_abutting_runs() -> (GridSession, NodeId, NodeId) {
    let mut session = GridSession::new(SEED);
    let mut minted: Vec<NodeId> = Vec::new();
    for (cells, what) in [
        (vec![(1, 0), (2, 0)], "draw belt A, the upstream run"),
        (vec![(3, 0), (4, 0)], "draw belt B, the downstream run"),
    ] {
        session
            .apply(GridCommand::DrawBelt { cells })
            .unwrap_or_else(|e| panic!("{what}: rejected with {e:?}"));
        minted.extend(session.core().last_tick.placed.iter().copied());
    }
    assert_eq!(
        minted.len(),
        2,
        "the board minted exactly two belts, in gesture order"
    );
    (session, minted[0], minted[1])
}

/// Join belt A's HEAD to belt B's TAIL through the certified path (handles 0 and 1).
///
/// B's Tail is its catalog index 0, its `Role::In` record, which is exactly the port the
/// sweep asserts about.
fn join_a_to_b(session: &mut GridSession) {
    session
        .apply(GridCommand::Dock {
            belt: 0,
            endpoint: BeltEnd::Head,
            node: 1,
            port: 0,
        })
        .expect("belt A's head joins belt B's tail through the certified path");
}

// ---------------------------------------------------------------------------
// Scenario 1: DrawBelt.
// ---------------------------------------------------------------------------

#[test]
fn a_drawbelt_fold_writes_both_belt_ports_at_the_origin() {
    let (session, a, b) = two_abutting_runs();

    // The subject really is a pair of DRAWN belts, so the sweep below is reading the
    // output of `fold_draw_belt` rather than of some other minter.
    for (id, name) in [(a, "A"), (b, "B")] {
        assert!(
            matches!(session.core().state.node(id), Some(Node::Belt(belt)) if belt.geometry.len() == 2),
            "belt {name} was folded from a DrawBelt carrying two tiles",
        );
    }

    let swept = sweep_belt_ports(&session.core().state, "DrawBelt");
    assert!(
        swept >= 2,
        "the DrawBelt sweep saw {swept} belts; it must see the two this board drew, or \
         its universally-quantified assertions examined nothing"
    );
}

// ---------------------------------------------------------------------------
// Scenario 1b: the EMPTY EDGE, folded from the log.
// ---------------------------------------------------------------------------

#[test]
fn a_geometry_empty_belt_is_swept_with_the_drawn_ones_and_reads_the_same() {
    // THE EMPTY EDGE (D-06). A geometry-empty belt has no `geometry[0]` for its Tail port
    // to derive a cell from, which is exactly the shape from which a non-(0,0) offset
    // would be invented, and a sweep that only ever sees drawn belts never reaches it.
    //
    // The certified command path cannot mint one: `route(&[])` refuses an empty path, so
    // `GridCommand::DrawBelt { cells: vec![] }` is rejected before any fold. The route in
    // is the log, through `GridSession::replay`, which is the same primitive a persisted
    // or forged edit log arrives through and the reason nine of the 33 blessed genesis
    // snapshots hold geometry-empty belts at all. The FOLD is the real one either way:
    // both records below land in `fold_draw_belt`.
    let drawn = route(&[(1, 0), (2, 0)]).expect("a two-cell straight run routes");
    let records = vec![
        EditRecord {
            schema_version: EDIT_SCHEMA_VERSION,
            partition: 0,
            sequence: 0,
            tick: 0,
            action: 0,
            op: EditOp::DrawBelt { tiles: drawn },
        },
        EditRecord {
            schema_version: EDIT_SCHEMA_VERSION,
            partition: 0,
            sequence: 1,
            tick: 1,
            action: 1,
            op: EditOp::DrawBelt { tiles: Vec::new() },
        },
    ];
    let session = GridSession::replay(SEED, &records);

    let belts: Vec<NodeId> = session
        .core()
        .state
        .node_ids()
        .filter(|&id| matches!(session.core().state.node(id), Some(Node::Belt(_))))
        .collect();
    assert_eq!(
        belts.len(),
        2,
        "the replay folded both records into belts: one drawn, one geometry-empty"
    );
    let empties = belts
        .iter()
        .filter(|&&id| {
            matches!(session.core().state.node(id), Some(Node::Belt(b)) if b.geometry.is_empty())
        })
        .count();
    assert_eq!(
        empties, 1,
        "exactly one of the swept belts is the geometry-empty subject this case exists \
         for; without it the sweep below never reaches the empty edge"
    );

    let swept = sweep_belt_ports(&session.core().state, "DrawBelt/geometry-empty");
    assert!(
        swept >= 2,
        "the geometry-empty sweep saw {swept} belts; it must see both, or the empty edge \
         went unexamined"
    );
}

// ---------------------------------------------------------------------------
// Scenario 2: Dock.
// ---------------------------------------------------------------------------

#[test]
fn a_belt_to_belt_dock_fold_moves_no_belt_port() {
    let (mut session, a, b) = two_abutting_runs();
    let before: Vec<_> = session
        .core()
        .state
        .ports_of(b)
        .expect("belt B is a ported node before the dock")
        .to_vec();

    join_a_to_b(&mut session);

    // The dock ACTUALLY HAPPENED. A `Dock` that silently did nothing would leave the
    // sweep below passing on a board where the fold under test never ran.
    assert_eq!(
        session.core().state.link_target((a, 0)),
        Some((b, 0)),
        "the accepted belt-to-belt Dock wrote the link (A,0) -> (B,0)"
    );

    let swept = sweep_belt_ports(&session.core().state, "Dock");
    assert!(
        swept >= 2,
        "the Dock sweep saw {swept} belts; it must see both ends of the join"
    );

    // Stronger than the sweep alone: the dock did not merely leave LEGAL ports, it left
    // the SAME ones. A fold that rewrote B's port records to something else legal would
    // pass the sweep and fail here.
    assert_eq!(
        session.core().state.ports_of(b).map(<[_]>::to_vec),
        Some(before),
        "a Dock adds a link, not a port record: belt B's two ports are byte-identical \
         across the fold"
    );
}

// ---------------------------------------------------------------------------
// Scenario 3: Unlink.
// ---------------------------------------------------------------------------

#[test]
fn an_unlink_fold_removes_the_link_and_no_belt_port() {
    let (mut session, a, b) = two_abutting_runs();
    join_a_to_b(&mut session);
    assert_eq!(
        session.core().state.link_target((a, 0)),
        Some((b, 0)),
        "the link exists before the Unlink that removes it"
    );

    session
        .apply(GridCommand::Unlink {
            belt: 0,
            endpoint: BeltEnd::Head,
            node: 1,
            port: 0,
        })
        .expect("the belt-to-belt junction disconnects through the certified path");

    assert_eq!(
        session.core().state.link_target((a, 0)),
        None,
        "the Unlink removed the link it named"
    );

    let swept = sweep_belt_ports(&session.core().state, "Unlink");
    assert!(
        swept >= 2,
        "the Unlink sweep saw {swept} belts; both belts survive an unlink, so both must \
         be examined"
    );

    // The regression this arm exists for: an `Unlink` that tore down a Port record along
    // with the link. Removing a link must not remove the end it was attached to.
    for (id, name) in [(a, "A"), (b, "B")] {
        assert_eq!(
            session.core().state.ports_of(id).map(<[_]>::len),
            Some(2),
            "belt {name} still declares both of its ends after the disconnect",
        );
    }
}

// ---------------------------------------------------------------------------
// Scenario 4: Delete, then Undo.
// ---------------------------------------------------------------------------

#[test]
fn the_belt_a_delete_undo_re_mints_declares_both_ports_at_the_origin() {
    // NOT AN INVERSE FOLD. `EditOp::Undo` is a lineage MARKER that folds to zero
    // GridState bytes (`tick.rs`, pinned by
    // `fold_undo_redo_markers_change_zero_gridstate_bytes`), so the inverse group is
    // built one layer up by `GridSession::compute_inverse` and the deleted belt is
    // RE-MINTED by replaying a compensating `DrawBelt`. That makes this the fold path
    // most likely to mint a belt through a route that forgets the port write, which is
    // why it is swept separately from scenario 1 even though both end in
    // `fold_draw_belt`.
    let (mut session, a, b) = two_abutting_runs();
    join_a_to_b(&mut session);

    // Delete belt B by its dense handle, through the certified path.
    let handle = session
        .view()
        .handle_of(b)
        .expect("belt B holds a dense handle before it is deleted");
    session
        .apply(GridCommand::Delete { node: handle })
        .expect("deleting one belt of a joined run is buildable");

    // NARROWED BY PLAN 74-12, and this block asserts the fixed shape rather than the
    // measured-wrong one it replaces. Plan 74-11 wrote this case against a board on which
    // the Delete of belt B removed its joined neighbour too, leaving no belt at all:
    // `cascade_neighbours` collected every belt reachable across one link from the deleted
    // node, and since phase 74 a belt's dock neighbour can itself be a belt. That was
    // pinned here deliberately so a later fix would redden it rather than pass silently,
    // and recorded as WINDOWS row 231. 74-12 is that fix: `cascade_neighbours` returns no
    // belt when the removed node is itself a belt, so a belt-to-belt neighbour now loses
    // only the link it shared, which is the outcome `judge_docks` already produces on a
    // rotate.
    //
    // The case keeps its name because the property that name states, about the re-minted
    // belt's ports, has not moved: what moved is what the board around it looks like.
    let after_delete: Vec<NodeId> = session
        .core()
        .state
        .node_ids()
        .filter(|&id| matches!(session.core().state.node(id), Some(Node::Belt(_))))
        .collect();
    assert_eq!(
        after_delete,
        vec![a],
        "the delete took belt B and left belt A standing under its ORIGINAL id, so belt A \
         is a survivor and not a re-mint: {after_delete:?}"
    );
    assert!(
        matches!(session.core().state.ports_of(a), Some([_, _])),
        "and the survivor kept BOTH of its ends: {:?}",
        session.core().state.ports_of(a)
    );
    assert_eq!(
        session.core().state.link_target((a, 0)),
        None,
        "what belt A lost is the LINK it shared with the deleted belt, and nothing else"
    );

    session
        .apply(GridCommand::Undo)
        .expect("undoing the delete of a joined belt is buildable");

    let restored: Vec<NodeId> = session
        .core()
        .state
        .node_ids()
        .filter(|&id| matches!(session.core().state.node(id), Some(Node::Belt(_))))
        .collect();
    assert_eq!(
        restored.len(),
        2,
        "one undo handed the deleted belt back beside the survivor: {restored:?}"
    );
    assert!(
        restored.contains(&a),
        "belt A is still on the board under the id it always had; an A that changed id \
         would mean the undo re-minted a belt the delete never took: {restored:?}"
    );
    // EXACTLY ONE of the two is a fresh mint, and that one is the reason this path can
    // forget the port write: it is a new node, not a revived one. The sweep below reads
    // both, so it reads the re-mint.
    let fresh: Vec<NodeId> = restored
        .iter()
        .copied()
        .filter(|id| *id != a && *id != b)
        .collect();
    assert_eq!(
        fresh.len(),
        1,
        "exactly one restored belt carries an id neither A nor B held before, which is \
         the re-mint this sweep exists to read: restored {restored:?}, fresh {fresh:?}"
    );

    let swept = sweep_belt_ports(&session.core().state, "Delete-undo");
    assert_eq!(
        swept, 2,
        "the Delete-undo sweep saw {swept} belts; it must see BOTH re-minted belts"
    );
}

// ---------------------------------------------------------------------------
// The non-vacuity guard, exhibited rather than argued.
// ---------------------------------------------------------------------------

#[test]
fn the_sweep_returns_zero_on_a_beltless_board_which_is_why_every_scenario_checks_the_count() {
    // THIS IS THE PROOF THAT THE COUNT ASSERTIONS ABOVE ARE LOAD-BEARING. `sweep_belt_ports`
    // is universally quantified over the belts in a state, and a universally-quantified
    // assertion over an empty set passes while examining nothing. Here is a real, live,
    // perfectly ordinary board on which this sweep reports success having looked at
    // nothing at all. Delete the `swept >= 2` line from any scenario above and that
    // scenario becomes this: green, and evidence for nothing.
    let mut session = GridSession::new(SEED);
    session
        .apply(GridCommand::Place {
            kind: machine_kind::SINK,
            cell_x: 11,
            cell_y: 0,
        })
        .expect("placing a SINK is buildable");
    assert_eq!(
        session.core().state.node_count(),
        1,
        "the board holds exactly one node, and it is not a belt"
    );

    let swept = sweep_belt_ports(&session.core().state, "beltless control");
    assert_eq!(
        swept, 0,
        "the sweep examined no belts on a beltless board and still returned normally, \
         which is exactly the failure mode the non-zero assertions in every scenario \
         above exist to catch"
    );
}
