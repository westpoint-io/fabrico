//! Phase 12-06 (Wave 6) — the SC#3 / UNDO-03 SAVE/LOAD SURVIVAL proof.
//!
//! This is the milestone-headline certification: undo/redo history SURVIVES a
//! serialized save→load round-trip BECAUSE it rides the strictly-append-only
//! edit-log, and the saved log replays FORWARD to the SAME core state hash.
//!
//! Mechanism (deliberately self-contained in the command crate): the on-disk
//! representation `ProjectFile` v5 bundles is exactly `Vec<EditRecord>` (project.rs
//! :104-126); `PROJECT_FILE_VERSION`/`SNAPSHOT_SCHEMA_VERSION` do NOT bump for undo
//! (12-RESEARCH A2 — undo adds no snapshot-resident field). So the genuine save/load
//! path is proven here by serializing `session.edit_log()` through `postcard` (THE
//! on-disk format), decoding it back, re-folding via `GridSession::replay`, and
//! asserting the replayed core snapshot hash AND the full projection equal the live
//! session. The host `save_project`/`load_project` inherit this for free because they
//! wrap the same `Vec<EditRecord>` and already validate reject-only + replay-to-
//! matching-hash (project.rs:380-460).
//!
//! The accepted FLAG (12-RESEARCH Q2.4 / Pitfall 1): an undo→redo round-trip re-mints
//! fresh `NodeId`s (slotmap bumps the generation), so the round-trip is FUNCTIONALLY
//! equivalent (topology up to id-relabeling) but NOT byte-identical. SC#3 — "a given
//! log replays forward to the same hash" — is UNAFFECTED by that id drift: a fixed log
//! always re-folds deterministically. The functional-equivalence side is proven by
//! `undo_redo_functional_equiv` (in `undo_redo.rs`); THIS file proves the save/load
//! survival of the SAME hash from the persisted edit-log.

use fabrico_command::GridSession;
use fabrico_core::edit::{EditOp, EditRecord};
use fabrico_core::snapshot::snapshot;
use fabrico_protocol::{GridCommand, machine_kind};
use proptest::prelude::*;

const SEED: u64 = 0xFAB_C0DE;

/// Resolve the most-recently-minted node's dense render handle from the view.
fn last_minted_handle(session: &GridSession) -> Option<u64> {
    let id = *session.core().last_tick.placed.last()?;
    session.view().handle_of(id)
}

/// Place a machine of `kind` at a cell and return its dense render handle.
fn place(session: &mut GridSession, kind: u8, cell_x: i32, cell_y: i32) -> u64 {
    session
        .apply(GridCommand::Place { kind, cell_x, cell_y })
        .expect("place at a free cell");
    last_minted_handle(session).expect("the placed node got a handle")
}

/// Draw a belt along `cells` and return the minted belt's dense handle.
fn draw(session: &mut GridSession, cells: Vec<(i32, i32)>) -> u64 {
    session
        .apply(GridCommand::DrawBelt { cells })
        .expect("a clear drawn path is accepted");
    last_minted_handle(session).expect("the belt got a handle")
}

/// The number of live nodes (machines + belts) in the folded core.
fn node_count(session: &GridSession) -> usize {
    session.core().state.node_count()
}

/// The number of directed dock/wire links in the folded core.
fn link_count(session: &GridSession) -> usize {
    session.core().state.links_iter().count()
}

/// True iff `cell` is occupied in the folded core.
fn occupied(session: &GridSession, cell: (i32, i32)) -> bool {
    session.core().state.occupied(cell).is_some()
}

/// THE SC#3 ASSERTION. Serialize the live `session.edit_log()` through `postcard`
/// (the EXACT on-disk representation `ProjectFile` v5 persists), decode it back, then
/// re-fold via `GridSession::replay(seed, …)` — the genuine save→load path. Assert the
/// replayed core snapshot hash AND the full undo/redo projection (`undoable`/`cursor`/
/// `can_undo`/`can_redo`/`xlate`) equal the live session's. Equality here IS UNDO-03:
/// the undo/redo lineage survived a serialized round-trip and the log replayed forward
/// to the same hash.
fn assert_save_load_reproduces(session: &GridSession, seed: u64) {
    // 1. SAVE: encode the edit-log exactly as it is persisted on disk.
    let bytes = postcard::to_allocvec(&session.edit_log().to_vec())
        .expect("the edit-log postcard-encodes (the on-disk format)");
    // 2. LOAD: decode it back from the serialized bytes.
    let records: Vec<EditRecord> =
        postcard::from_bytes(&bytes).expect("the persisted edit-log decodes");
    // The persisted bytes carry the WHOLE lineage — every record survives the round-trip.
    assert_eq!(
        records.as_slice(),
        session.edit_log(),
        "the serialized round-trip preserves every edit-log record (UNDO-01: append-only, never mutated)"
    );
    // 3. REPLAY: re-fold the loaded log from genesis.
    let refold = GridSession::replay(seed, &records);

    // The replayed CORE snapshot hash equals the live one (the headline SC#3 claim).
    assert_eq!(
        snapshot(refold.core()),
        snapshot(session.core()),
        "the save→load→replay reproduces the live core snapshot hash (UNDO-03 / SC#3)"
    );
    // The replayed PROJECTION (the undo/redo history itself) reconstructs identically.
    assert_eq!(
        refold.undoable_stack(),
        session.undoable_stack(),
        "the undoable stack survives save/load"
    );
    assert_eq!(
        refold.redo_cursor(),
        session.redo_cursor(),
        "the redo cursor survives save/load"
    );
    assert_eq!(refold.can_undo(), session.can_undo(), "can_undo survives save/load");
    assert_eq!(refold.can_redo(), session.can_redo(), "can_redo survives save/load");
    assert_eq!(
        refold.id_translation(),
        session.id_translation(),
        "the cross-undo/redo id remap (xlate) reconstructs purely from the persisted log"
    );
}

proptest! {
    /// UNDO-03 / SC#3 (the headline proof): drive a RANDOM valid command sequence that
    /// mixes normal actions (place / move) with undo/redo, and after EVERY step assert
    /// the live session is reproduced by a postcard save→load→replay of its own edit-log.
    /// The move op (Delete+Place under one shared action) guarantees delete-records ride
    /// the persisted log; the focused `delete_undo_survives_save_load` test below pins a
    /// delete-undo capture round-trip specifically.
    #[test]
    fn undo_survives_save_load(ops in prop::collection::vec(0u8..5, 0..40)) {
        let mut session = GridSession::new(SEED);
        // Live render handles so deletes/moves can target real nodes; a fresh cell
        // counter keeps every placement collision-free (deterministic layout).
        let mut live: Vec<u64> = Vec::new();
        let mut next_cell: i32 = 0;

        // The genesis (empty) session already round-trips.
        assert_save_load_reproduces(&session, SEED);

        for op in ops {
            match op {
                // Place a fresh source at a never-used cell (always accepted).
                0 => {
                    let cell_x = next_cell * 2;
                    next_cell += 1;
                    let h = place(&mut session, machine_kind::SOURCE, cell_x, 0);
                    live.push(h);
                }
                // Delete the most-recent live node (skip if empty). May reject if the
                // handle was already undone away — that is a harmless no-op for the log.
                1 => {
                    if let Some(node) = live.pop() {
                        let _ = session.apply(GridCommand::Delete { node });
                    }
                }
                // Move the most-recent live node to a fresh cell (Delete+Place under one
                // shared action — multi-record coalescing rides the persisted log).
                2 => {
                    if let Some(node) = live.pop() {
                        let cell_x = next_cell * 2;
                        next_cell += 1;
                        if session.move_machine(node, machine_kind::SOURCE, cell_x, 5).is_ok()
                            && let Some(h) = last_minted_handle(&session)
                        {
                            live.push(h);
                        }
                    }
                }
                // Undo — may be an empty-stack typed reject (leaves the log unchanged).
                3 => { let _ = session.apply(GridCommand::Undo); }
                // Redo — may be an empty-stack typed reject (leaves the log unchanged).
                _ => { let _ = session.apply(GridCommand::Redo); }
            }
            // The invariant under test: after EVERY accepted-or-rejected step, the live
            // session is exactly reproduced by a serialized save→load→replay of its log.
            assert_save_load_reproduces(&session, SEED);
        }
    }
}

/// FOCUSED delete-undo survival (the dominant UNDO-01 complexity): a Delete record
/// carries the REAL captured subgraph (the machine footprint + every cascade-removed
/// belt + incident links). Undo restores that subgraph from the capture ALONE; the
/// captured `DeletedSubgraph` must survive the postcard save→load and re-fold to the
/// SAME pre-delete topology + hash. This is the scenario `ProjectFile` v5 must persist
/// faithfully for the host's reject-only/replay-to-matching-hash load to succeed.
#[test]
fn delete_undo_survives_save_load() {
    // The proven-valid OFFLOAD geometry (mirrors `undo_inverse_dock`): a 2×3 ROUTER's
    // Out port 1 sits at world (1,1) facing E (the middle row since plan 74.1-14; it was
    // (1,2)); a belt drawn tail-first at (2,1)->(3,1) presents its tail one step E of the
    // port (facing W = opposite) for a valid dock.
    const DOCK_BELT: [(i32, i32); 2] = [(2, 1), (3, 1)];

    let mut session = GridSession::new(SEED);
    let r = place(&mut session, machine_kind::ROUTER, 0, 0);
    let b = draw(&mut session, DOCK_BELT.to_vec());
    session
        .apply(GridCommand::Dock {
            belt: b,
            endpoint: fabrico_protocol::BeltEnd::Tail,
            node: r,
            port: 1,
        })
        .expect("offload-dock the belt tail to the router Out port");

    let nodes_pre = node_count(&session); // router + docked belt
    let links_pre = link_count(&session); // the dock link
    assert_eq!(nodes_pre, 2, "router + docked belt before the delete");

    // Delete the router → cascade-detaches the docked belt; the persisted Delete record
    // carries the captured subgraph (real footprint + the belt's geometry + the link).
    session
        .apply(GridCommand::Delete { node: r })
        .expect("delete the router (cascade-detaches the belt)");
    assert_eq!(node_count(&session), 0, "router + belt both gone after the delete");

    // Sanity: the persisted log holds a Delete record with a NON-EMPTY real capture.
    assert!(
        session.edit_log().iter().any(|rec| matches!(
            &rec.op,
            EditOp::Delete { captured, .. } if !captured.belts.is_empty()
        )),
        "a persisted Delete record carries the captured cascade subgraph"
    );

    // Undo the delete → restores the machine AND re-draws + re-docks the belt from the
    // capture ALONE; counts + occupancy return to pre-delete (up to id-relabeling).
    session.apply(GridCommand::Undo).expect("undo the delete (restore the subgraph)");
    assert_eq!(node_count(&session), nodes_pre, "undo restored the machine + cascade belt");
    assert_eq!(link_count(&session), links_pre, "undo restored the dock link");
    assert!(occupied(&session, (0, 0)), "router body re-occupied by the undo");
    assert!(occupied(&session, DOCK_BELT[0]), "belt tile re-claimed by the undo");
    assert!(occupied(&session, DOCK_BELT[1]), "belt tile re-claimed by the undo");

    // THE PROOF: the captured-subgraph Delete + the frozen undo group survive a real
    // postcard save→load and re-fold to the SAME core hash + projection (UNDO-03 / SC#3).
    assert_save_load_reproduces(&session, SEED);

    // And again after a REDO (re-delete) — the whole oscillation rides the persisted log.
    session.apply(GridCommand::Redo).expect("redo the delete (re-remove the subgraph)");
    assert_eq!(node_count(&session), 0, "redo re-removed the router + cascade belt");
    assert_save_load_reproduces(&session, SEED);
}
