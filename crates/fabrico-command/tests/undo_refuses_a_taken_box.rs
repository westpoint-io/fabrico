//! THE RESTORE-SPACE GUARD, headless (phase 86, plan 86-06, WORK-02, D-04).
//!
//! The undo of a Delete puts the machine back on the box its capture names and re-draws
//! every belt the Delete took. When any of those cells is held by something else, the Undo
//! is refused `UndoSpaceTaken` before anything folds: no record is written, the board is
//! byte for byte what it was, and the step stays on top of the undo stack.
//!
//! The check reads the PREDICTION board, the board as the undo group's earlier records
//! leave it, never the live core. Two legs here hold that in place: the undo of a move
//! (whose `Place` inverse frees the moved machine's own cells first) and the undo of a
//! turned machine (whose turned cells are free while its unturned box is not) must both be
//! accepted.
//!
//! WITH LINEAR UNDO NO ORDINARY GESTURE REACHES THE GUARD: anything placed after a Delete
//! is undone before the Delete is, and plan 86-02 restores a turned machine on exactly the
//! cells it held. So the two refusal legs build a real board, change ONE field of its edit
//! log by hand, and load it with `GridSession::replay`, the same fold a saved file goes
//! through.
//!
//! SEEN FAILING (two mutation runs, recorded in the phase 86 evidence): with the cell checks removed both refusal legs fail; with the checks
//! reading the live core instead of the prediction board the move-undo leg fails.
//!
//! Run target: `cargo test -p fabrico-command --test undo_refuses_a_taken_box`

use fabrico_command::{CommandError, GridSession};
use fabrico_core::edit::{EditOp, EditRecord};
use fabrico_core::ids::NodeId;
use fabrico_core::snapshot::{restore, snapshot};
use fabrico_core::state::Footprint;
use fabrico_protocol::{BeltEnd, GridCommand, machine_kind};

const SEED: u64 = 0x8606_B0C5;

/// Place `kind` at a cell through the session and return the id it minted.
fn place(session: &mut GridSession, kind: u8, at: (i32, i32)) -> NodeId {
    session
        .apply(GridCommand::Place {
            kind,
            cell_x: at.0,
            cell_y: at.1,
        })
        .unwrap_or_else(|e| panic!("measured: a Place at {at:?} on free floor, got {e:?}"));
    *session
        .core()
        .last_tick
        .placed
        .last()
        .expect("the placed node minted an id")
}

/// The dense render handle for a live node.
fn handle_of(session: &GridSession, id: NodeId) -> u64 {
    session
        .view()
        .handle_of(id)
        .expect("a live node has a handle")
}

/// Delete `id` through the session, the keyboard Delete's command.
fn delete(session: &mut GridSession, id: NodeId) {
    let node = handle_of(session, id);
    session
        .apply(GridCommand::Delete { node })
        .expect("measured: the Delete is accepted");
}

/// The board's serialized grid, so "the refusal changed nothing" is a byte comparison.
fn grid_bytes(session: &GridSession) -> Vec<u8> {
    postcard::to_allocvec(&session.core().state).expect("serialize GridState")
}

/// Serialize the edit log exactly as a saved project carries it, decode it back and fold
/// it from genesis: the save-load path. `None` when the folded board equals `session`'s.
fn save_and_load_differs(session: &GridSession) -> Option<String> {
    let bytes = postcard::to_allocvec(&session.edit_log().to_vec()).expect("edit-log encodes");
    let records: Vec<EditRecord> = postcard::from_bytes(&bytes).expect("edit-log decodes");
    let back = GridSession::replay(SEED, &records);
    if let Err(e) = restore(&snapshot(back.core())) {
        return Some(format!("the reloaded board fails the snapshot gate: {e:?}"));
    }
    (grid_bytes(&back) != grid_bytes(session)).then(|| "the reloaded board differs".to_owned())
}

/// The last record of `session`'s log, which the caller has measured to be a Delete, with
/// `forge` applied to its op, folded again from genesis.
fn replay_with_last_delete_forged(
    session: &GridSession,
    forge: impl FnOnce(&mut EditOp),
) -> GridSession {
    let mut records = session.edit_log().to_vec();
    let last = records.last_mut().expect("the board has an edit log");
    assert!(
        matches!(last.op, EditOp::Delete { .. }),
        "measured: the last record is the Delete, found {:?}",
        last.op
    );
    forge(&mut last.op);
    GridSession::replay(SEED, &records)
}

/// What a refused Undo must leave, as one fact list, so a red names every part.
fn refusal_facts(
    mut session: GridSession,
    held: (i32, i32),
    holder: NodeId,
) -> Vec<(&'static str, String)> {
    let edits_before = session.edit_log().len();
    let grid_before = grid_bytes(&session);
    assert!(session.can_undo(), "measured: the forged board offers Undo");
    let undo = session.apply(GridCommand::Undo).map(|_| ());
    vec![
        ("undo", format!("{undo:?}")),
        (
            "edits_unchanged",
            (session.edit_log().len() == edits_before).to_string(),
        ),
        (
            "board_unchanged",
            (grid_bytes(&session) == grid_before).to_string(),
        ),
        (
            "neighbour_keeps_its_cell",
            (session.core().state.occupied(held) == Some(holder)).to_string(),
        ),
        ("can_undo", session.can_undo().to_string()),
        (
            "restores",
            format!(
                "{:?}",
                restore(&snapshot(session.core()))
                    .err()
                    .map(|e| format!("{e:?}"))
            ),
        ),
        (
            "save_and_load",
            format!("{:?}", save_and_load_differs(&session)),
        ),
    ]
}

fn refused() -> Vec<(&'static str, String)> {
    refused_as(CommandError::UndoSpaceTaken)
}

/// What a refused Undo leaves, refused as `err`.
fn refused_as(err: CommandError) -> Vec<(&'static str, String)> {
    vec![
        ("undo", format!("{:?}", Err::<(), _>(err))),
        ("edits_unchanged", "true".to_owned()),
        ("board_unchanged", "true".to_owned()),
        ("neighbour_keeps_its_cell", "true".to_owned()),
        ("can_undo", "true".to_owned()),
        ("restores", "None".to_owned()),
        ("save_and_load", "None".to_owned()),
    ]
}

/// THE MACHINE HALF. A Factory at (20,20) (3 by 3, x 20 to 22) and a Source at (23,20) just
/// east of it, the Factory deleted; the Delete's captured box is widened from 3 to 4
/// columns, so the box an Undo would put back reaches the Source's cell. The Undo is
/// refused and places nothing.
///
/// No ordinary gesture reaches this guard: with linear undo anything placed after a Delete
/// is undone first. The forged log is its only reach (the host's twin is the committed
/// `86-undo-space-taken.fab`).
#[test]
fn a_forged_capture_over_a_neighbour_is_refused_and_places_nothing() {
    let mut session = GridSession::new(SEED);
    let factory = place(&mut session, machine_kind::FACTORY, (20, 20));
    assert_eq!(
        session.core().state.footprint_of(factory),
        Some(Footprint { w: 3, h: 3, rot: 0 }),
        "measured: a placed Factory is 3 by 3"
    );
    let source = place(&mut session, machine_kind::SOURCE, (23, 20));
    delete(&mut session, factory);
    let forged = replay_with_last_delete_forged(&session, |op| match op {
        EditOp::Delete { captured, .. } => {
            assert_eq!(
                (captured.w, captured.h),
                (3, 3),
                "measured: the real capture is 3 by 3"
            );
            captured.w = 4;
        }
        _ => unreachable!("measured above"),
    });
    assert_eq!(
        forged.core().state.occupied((23, 20)),
        Some(source),
        "measured: the forged board holds the Source at (23,20)"
    );
    assert_eq!(
        refusal_facts(forged, (23, 20), source),
        refused(),
        "the forged Undo is refused and changes nothing"
    );
}

/// THE BELT HALF. A Sink at (11,0) fed by a belt on (9,0) and (10,0), its Head docked into
/// the Sink's In, and a Source at (9,1) just below the belt; the Sink is deleted (the belt
/// goes with it, as a cascade belt in the capture). The cascade belt's first tile is moved
/// from (9,0) to (9,1), so its re-draw would cross the Source. The Sink's own cell is free,
/// so only the belt check can refuse it.
///
/// No ordinary gesture reaches this guard: with linear undo anything placed after a Delete
/// is undone first. The forged log is its only reach.
#[test]
fn a_forged_cascade_belt_over_a_neighbour_is_refused() {
    let mut session = GridSession::new(SEED);
    let sink = place(&mut session, machine_kind::SINK, (11, 0));
    session
        .apply(GridCommand::DrawBelt {
            cells: vec![(9, 0), (10, 0)],
        })
        .expect("measured: a clear belt path is accepted");
    let belt = *session
        .core()
        .last_tick
        .placed
        .last()
        .expect("the belt minted");
    let (sink_h, belt_h) = (handle_of(&session, sink), handle_of(&session, belt));
    session
        .apply(GridCommand::Dock {
            belt: belt_h,
            endpoint: BeltEnd::Head,
            node: sink_h,
            port: 0,
        })
        .expect("measured: the belt's Head docks into the Sink's In");
    let source = place(&mut session, machine_kind::SOURCE, (9, 1));
    delete(&mut session, sink);
    assert_eq!(
        session.core().state.node(belt),
        None,
        "measured: the docked belt went with the Sink"
    );
    let forged = replay_with_last_delete_forged(&session, |op| match op {
        EditOp::Delete { captured, .. } => {
            assert_eq!(
                captured.belts.len(),
                1,
                "measured: the capture holds the one cascade belt"
            );
            let tile = &mut captured.belts[0].geometry[0];
            assert_eq!(
                tile.cell,
                (9, 0),
                "measured: the cascade belt starts at (9,0)"
            );
            tile.cell = (9, 1);
        }
        _ => unreachable!("measured above"),
    });
    assert_eq!(
        forged.core().state.occupied((11, 0)),
        None,
        "measured: the Sink's own cell is free, so the machine check passes"
    );
    assert_eq!(
        refusal_facts(forged, (9, 1), source),
        refused(),
        "the forged Undo is refused before the belt crosses the Source"
    );
}

/// MALFORMED WINS OVER A TAKEN SPACE, AT A LATER CHECK (phase 86 review, WR-02). The belt
/// half's board, a Source just east of the Sink instead of below the belt. The Delete's
/// capture is forged twice: the Sink's box is widened one column onto the Source (the space
/// check fails), and the cascade belt's links are cleared, so they name no belt (the
/// `identify_belt` check, which runs AFTER the box check, fails). Clearing the space would
/// not bring this record back, so "that space is taken" would be a false sentence: the Undo
/// is refused `Malformed`.
///
/// Red until WR-02: the box check returned `UndoSpaceTaken` before the walk reached the belt.
#[test]
fn a_taken_box_with_an_unrestorable_cascade_belt_is_refused_malformed() {
    let mut session = GridSession::new(SEED);
    let sink = place(&mut session, machine_kind::SINK, (11, 0));
    // A 1 by 1 machine carries no stored footprint; the capture resolves it to 1 by 1.
    let fp = session
        .core()
        .state
        .footprint_of(sink)
        .unwrap_or(Footprint { w: 1, h: 1, rot: 0 });
    session
        .apply(GridCommand::DrawBelt {
            cells: vec![(9, 0), (10, 0)],
        })
        .expect("measured: a clear belt path is accepted");
    let belt = *session
        .core()
        .last_tick
        .placed
        .last()
        .expect("the belt minted");
    let (sink_h, belt_h) = (handle_of(&session, sink), handle_of(&session, belt));
    session
        .apply(GridCommand::Dock {
            belt: belt_h,
            endpoint: BeltEnd::Head,
            node: sink_h,
            port: 0,
        })
        .expect("measured: the belt's Head docks into the Sink's In");
    let east = (11 + i32::from(fp.w), 0);
    let source = place(&mut session, machine_kind::SOURCE, east);
    delete(&mut session, sink);
    let forged = replay_with_last_delete_forged(&session, |op| match op {
        EditOp::Delete { captured, .. } => {
            assert_eq!(
                (captured.w, captured.belts.len()),
                (fp.w, 1),
                "measured: the capture holds the Sink's box and the one cascade belt"
            );
            captured.w += 1;
            captured.belts[0].links.clear();
        }
        _ => unreachable!("measured above"),
    });
    assert_eq!(
        forged.core().state.occupied(east),
        Some(source),
        "measured: the forged board holds the Source just east of the Sink's box"
    );
    assert_eq!(
        refusal_facts(forged, east, source),
        refused_as(CommandError::UndoDoesNotFit),
        "the record cannot be restored at all, so the Undo is refused UndoDoesNotFit, not UndoSpaceTaken"
    );
}

/// NO FALSE REFUSAL: a move. A Factory at (20,20) moved one cell east to (21,20) (its new
/// box overlaps its old one), then Undo. The undo's first record deletes the moved Factory,
/// which frees x 21 to 23 on the prediction board, so the re-Place at (20,20) finds its
/// cells free. Read against the live core it would find the moved Factory there.
#[test]
fn a_move_undo_is_never_refused_against_its_own_cells() {
    let mut session = GridSession::new(SEED);
    let factory = place(&mut session, machine_kind::FACTORY, (20, 20));
    let node = handle_of(&session, factory);
    session
        .move_machine(node, machine_kind::FACTORY, 21, 20)
        .expect("measured: a one-cell move onto its own cells is accepted");
    let moved = session
        .core()
        .state
        .occupied((21, 20))
        .expect("the moved Factory holds (21,20)");
    assert_eq!(
        session.core().state.occupied((20, 20)),
        None,
        "measured: (20,20) is free after the move"
    );
    assert_eq!(
        session.core().state.occupied((23, 22)),
        Some(moved),
        "measured: the moved box reaches x 23"
    );

    let undo = session.apply(GridCommand::Undo).map(|_| ());
    assert_eq!(undo, Ok(()), "the move's undo is accepted");
    let back = session
        .core()
        .state
        .occupied((20, 20))
        .expect("a machine is back at (20,20)");
    assert_eq!(
        session.core().state.cell_of(back),
        Some((20, 20)),
        "it is anchored where it started"
    );
    for x in 20..=22 {
        for y in 20..=22 {
            assert_eq!(
                session.core().state.occupied((x, y)),
                Some(back),
                "it owns ({x},{y})"
            );
        }
    }
    for y in 20..=22 {
        assert_eq!(
            session.core().state.occupied((23, y)),
            None,
            "(23,{y}) is free again"
        );
    }
    assert_eq!(
        save_and_load_differs(&session),
        None,
        "the board saves and loads"
    );
}

/// NO FALSE REFUSAL: a turned machine (plan 86-02's shape). A Router at (20,28) is 2 by 3
/// (x 20 to 21, y 28 to 30); turned once it is 3 by 2 (x 20 to 22, y 28 to 29), freeing
/// (20,30), where a Source then stands. The Router deleted and Undo: its turned box is
/// free, so the Undo is accepted and the Router comes back turned; the Source keeps its
/// cell. A guard checking the unturned box would refuse it.
#[test]
fn a_turned_machine_undo_with_free_cells_is_not_refused() {
    let mut session = GridSession::new(SEED);
    let router = place(&mut session, machine_kind::ROUTER, (20, 28));
    let node = handle_of(&session, router);
    session
        .apply(GridCommand::Rotate { node, ccw: false })
        .expect("measured: an undocked Router turns on clear floor");
    assert_eq!(
        session.core().state.footprint_of(router),
        Some(Footprint { w: 2, h: 3, rot: 1 }),
        "measured: turned once"
    );
    assert_eq!(
        session.core().state.occupied((20, 30)),
        None,
        "measured: (20,30) is free while turned"
    );
    let source = place(&mut session, machine_kind::SOURCE, (20, 30));
    delete(&mut session, router);

    let undo = session.apply(GridCommand::Undo).map(|_| ());
    assert_eq!(undo, Ok(()), "the turned Router's undo is accepted");
    let back = session
        .core()
        .state
        .occupied((20, 28))
        .expect("the Router is back at (20,28)");
    assert_eq!(
        session.core().state.footprint_of(back),
        Some(Footprint { w: 2, h: 3, rot: 1 }),
        "it comes back turned"
    );
    assert_eq!(
        session.core().state.occupied((22, 29)),
        Some(back),
        "it owns its turned cells"
    );
    assert_eq!(
        session.core().state.occupied((20, 30)),
        Some(source),
        "the Source keeps (20,30)"
    );
    assert_eq!(
        save_and_load_differs(&session),
        None,
        "the board saves and loads"
    );
}
