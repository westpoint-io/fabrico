//! Phase 88, WINDOWS 228 (with WORK-03), D-04: the undo of a Delete pairs each captured
//! belt with the belt id ITS re-mint produced, never with the id at the same position.
//!
//! # The defect
//! `GridSession::reconstruct_projection`'s Undo arm rebuilds the re-mint table (`xlate`)
//! for a Delete-undo group by pairing `captured.belts[idx]` with `group_placed[idx + 1]`
//! for EVERY captured belt, while `compute_inverse`, which wrote that group, SKIPS a
//! captured belt whose geometry is empty before minting anything for it. On a capture
//! `[empty, real]` the group mints `[machine, real_new]`: the empty record is paired with
//! `real_new` (and, naming no belt, inserts nothing), and the real belt is paired with
//! `group_placed[2]`, which does not exist, so the real belt's entry is never written. A
//! later step that names the real belt through the table then names its ORIGINAL id, a
//! node that no longer exists.
//!
//! WHICH STEPS SEE IT, measured at `PHASE88_START`: not the Undo, Redo and Undo of the
//! Delete itself (each re-derives the belt from the capture or the Sink's cascade, and all
//! three read right), but the two older steps whose records name the belt by the id it was
//! first minted with. On the forged board the undo of the belt's Dock answers `Ok` and leaves
//! the belt docked, and the undo of its DrawBelt is refused `Malformed` with the belt still on
//! the board. The same history unforged (the control) walks cleanly.
//!
//! `compute_inverse` says an empty-geometry cascade capture "can no longer be produced", so
//! the only reach is a forged or old history. This file builds a real board, changes ONE
//! field of its edit log by hand (the Delete's capture gains an empty-geometry belt ahead
//! of the real one) and loads it with `GridSession::replay`, the fold a saved file goes
//! through, the `undo_refuses_a_taken_box.rs` precedent.
//!
//! # The probe plan 88-02 turned on
//! `#[ignore]`d with its plan named until then, and seen FAILED at `PHASE88_START` in a
//! throwaway worktree (88-EVIDENCE.md `## Red-first record`). Plan 88-02 walks both lists with
//! the one skip predicate, through one shared helper (`command.rs`
//! `pair_captured_belts_with_minted`), and a throwaway-worktree mutation back to positional
//! pairing in the projection reddens it (`## Plan 88-02`, `PROOF W228`).
//!
//! Run target: `cargo test -p fabrico-command --test undo_remint_pairs_by_identity`

use fabrico_command::GridSession;
use fabrico_core::edit::{DeletedBelt, EditOp};
use fabrico_core::ids::NodeId;
use fabrico_core::state::Node;
use fabrico_protocol::{BeltEnd, GridCommand, machine_kind};

const SEED: u64 = 0x0088_0228_0000_0001;

/// The Sink's anchor and the real belt's cells, its Head on the Sink's In doorstep.
const SINK_AT: (i32, i32) = (11, 0);
const BELT_CELLS: [(i32, i32); 2] = [(9, 0), (10, 0)];

/// The id the last apply minted.
fn minted(session: &GridSession) -> NodeId {
    *session
        .core()
        .last_tick
        .placed
        .last()
        .expect("the apply minted a node")
}

fn handle(session: &GridSession, id: NodeId) -> u64 {
    session.view().handle_of(id).expect("a live node has a handle")
}

/// The belt on the real belt's cells, by what the board holds there: its id and its cells.
fn real_belt(session: &GridSession) -> Option<(NodeId, Vec<(i32, i32)>)> {
    let state = &session.core().state;
    let id = state.occupied(BELT_CELLS[0])?;
    match state.node(id)? {
        Node::Belt(b) => Some((id, b.geometry.iter().map(|t| t.cell).collect())),
        _ => None,
    }
}

/// Whether the Sink is on its cell.
fn sink_there(session: &GridSession) -> bool {
    session.core().state.occupied(SINK_AT).is_some()
}

/// A Sink fed by one docked belt, the Sink deleted (taking the belt with it), and the log
/// loaded again from genesis. With `forge`, the Delete's capture carries an empty-geometry
/// belt AHEAD of the real one first; without it, the board is the CONTROL, the same history
/// unchanged.
fn board(forge: bool) -> GridSession {
    let mut session = GridSession::new(SEED);
    session
        .apply(GridCommand::Place { kind: machine_kind::SINK, cell_x: SINK_AT.0, cell_y: SINK_AT.1 })
        .expect("measured: a Sink places on free floor");
    let sink = minted(&session);
    session
        .apply(GridCommand::DrawBelt { cells: BELT_CELLS.to_vec() })
        .expect("measured: the belt draws on free floor");
    let belt = minted(&session);
    session
        .apply(GridCommand::Dock {
            belt: handle(&session, belt),
            endpoint: BeltEnd::Head,
            node: handle(&session, sink),
            port: 0,
        })
        .expect("measured: the belt's Head docks into the Sink's In");
    session
        .apply(GridCommand::Delete { node: handle(&session, sink) })
        .expect("measured: the Delete is accepted");
    assert!(real_belt(&session).is_none(), "measured: the Delete took the docked belt with the Sink");

    let mut records = session.edit_log().to_vec();
    let last = records.last_mut().expect("the board has an edit log");
    match &mut last.op {
        EditOp::Delete { captured, .. } => {
            assert_eq!(captured.belts.len(), 1, "measured: the Delete captured the one docked belt");
            assert!(!captured.belts[0].geometry.is_empty(), "measured: the real capture has its geometry");
            if forge {
                let empty = DeletedBelt {
                    kind: captured.belts[0].kind,
                    geometry: Vec::new(),
                    links: Vec::new(),
                    ticks_per_slot: captured.belts[0].ticks_per_slot,
                };
                captured.belts.insert(0, empty);
            }
        }
        other => panic!("measured: the last record is the Delete, found {other:?}"),
    }
    let loaded = GridSession::replay(SEED, &records);
    assert!(!sink_there(&loaded), "measured: the board loads with the Sink deleted");
    assert!(real_belt(&loaded).is_none(), "measured: and the belt gone");
    loaded
}

/// Whether the real belt's Head is docked into the Sink's In.
fn docked(session: &GridSession) -> bool {
    let state = &session.core().state;
    match (real_belt(session), state.occupied(SINK_AT)) {
        (Some((belt, _)), Some(sink)) => state.links_iter().any(|((f, _), (t, _))| f == belt && t == sink),
        _ => false,
    }
}

/// What each step leaves, one line per step: its verdict, the Sink, the real belt's cells,
/// and whether the belt is docked into the Sink.
type Facts = Vec<(String, String, bool, Option<Vec<(i32, i32)>>, bool)>;

/// Undo the Delete, Redo it, Undo it again, then Undo the Dock and the DrawBelt that came
/// before it. The last two are the steps that reach the real belt through the session's
/// re-mint table: their records name the belt by the id it was first minted with.
fn walk(mut session: GridSession, board: &str) -> Facts {
    let mut facts = Vec::new();
    for (name, cmd) in [
        ("undo-delete", GridCommand::Undo),
        ("redo-delete", GridCommand::Redo),
        ("undo-delete-again", GridCommand::Undo),
        ("undo-dock", GridCommand::Undo),
        ("undo-draw", GridCommand::Undo),
    ] {
        let verdict = format!("{:?}", session.apply(cmd).map(|_| ()));
        let belt = real_belt(&session).map(|(_, c)| c);
        eprintln!(
            "P88-W228 board={board} step={name} verdict={verdict} sink={} belt={belt:?} docked={}",
            sink_there(&session),
            docked(&session)
        );
        facts.push((name.to_owned(), verdict, sink_there(&session), belt, docked(&session)));
    }
    facts
}

/// Undo, Redo and Undo of the forged Delete, then the undo of the Dock and of the DrawBelt
/// before it. Each Undo of the Delete puts the Sink AND the real belt back, docked; the
/// Redo takes both away; the undo of the Dock leaves the belt undocked; the undo of the
/// DrawBelt removes it. The control (the same history, unforged) is walked the same way
/// and must read the same, so the probe cannot pass on a board where the walk itself
/// is wrong.
///
/// RED AT `PHASE88_START`: the positional pairing left the real belt out of the re-mint table
/// (above), so the two steps that reach the belt through the table missed it.
#[test]
fn an_undo_redo_undo_of_a_delete_with_an_empty_belt_keeps_the_real_belt() {
    let control = walk(board(false), "control");
    let restored = Some(BELT_CELLS.to_vec());
    let ok = "Ok(())".to_owned();
    let want: Facts = vec![
        ("undo-delete".to_owned(), ok.clone(), true, restored.clone(), true),
        ("redo-delete".to_owned(), ok.clone(), false, None, false),
        ("undo-delete-again".to_owned(), ok.clone(), true, restored.clone(), true),
        ("undo-dock".to_owned(), ok.clone(), true, restored, false),
        ("undo-draw".to_owned(), ok, true, None, false),
    ];
    assert_eq!(control, want, "PRECONDITION: the unforged history walks as a user expects");
    let forged = walk(board(true), "forged");
    assert_eq!(
        forged, want,
        "the forged history walks the same: every step that names the real belt finds it"
    );
}
