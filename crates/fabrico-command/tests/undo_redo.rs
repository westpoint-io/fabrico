//! Phase 12-03 — the SC#3 reconstruction kernel proof.
//!
//! Two guarantees are exercised here:
//!
//! 1. **`redo_cursor_equals_fold`** (proptest): for ANY sequence of normal public
//!    applies, the live in-memory projection (`undoable`, `cursor`, `xlate`, AND the
//!    core snapshot) equals a FRESH re-fold via [`GridSession::replay`] — i.e. the
//!    projection is a strict optimization that always equals the pure fold (Q1.2).
//!
//! 2. **Open Q3** (focused): a delete-then-undo-then-redo marker log, re-folded from
//!    genesis via `replay`, reconstructs the same cursor/undoable AND the same core
//!    snapshot hash as the incremental fold (SC#3 — "a given log replays to the same
//!    hash"); and a redo-of-an-undone-PLACE remaps `xlate` (original -> re-minted id)
//!    PURELY from the re-folded log. The undo-restore re-mint of a delete is the
//!    documented FLAG (functional-not-byte-identical), which SC#3 does not require.
//!
//! THIS plan has no `GridCommand::Undo/Redo` driver yet (that lands in 12-04), so the
//! undo/redo marker GROUPS are hand-built here by driving a `Core` to discover the
//! deterministically-minted ids and stamping the frozen records exactly as the future
//! driver will — the reconstruction fold is then proven a pure function of the log.

use std::collections::BTreeMap;

use fabrico_command::{CommandError, GridSession};
use fabrico_core::core::Core;
use fabrico_core::edit::{DeletedSubgraph, EDIT_SCHEMA_VERSION, EditOp, EditRecord};
use fabrico_core::event::{LogHeader, SCHEMA_VERSION};
use fabrico_core::ids::NodeId;
use fabrico_core::snapshot::snapshot;
use fabrico_protocol::{GridCommand, machine_kind};
use proptest::prelude::*;

const SEED: u64 = 0xFAB_C0DE;

/// Assert the live session's projection AND core snapshot equal a fresh re-fold of
/// its own edit-log via `replay` — the SC#3 invariant the rest of the phase rests on.
fn assert_projection_equals_fold(session: &GridSession, seed: u64) {
    let refold = GridSession::replay(seed, session.edit_log());
    assert_eq!(
        session.undoable_stack(),
        refold.undoable_stack(),
        "undoable stack must equal a fresh fold of the log"
    );
    assert_eq!(
        session.redo_cursor(),
        refold.redo_cursor(),
        "redo cursor must equal a fresh fold of the log"
    );
    assert_eq!(
        session.id_translation(),
        refold.id_translation(),
        "xlate must equal a fresh fold of the log"
    );
    assert_eq!(
        session.undo_floor(),
        refold.undo_floor(),
        "undo floor must equal a fresh fold of the log (D-10: the floor is read from the logged seal)"
    );
    assert_eq!(
        snapshot(session.core()),
        snapshot(refold.core()),
        "core snapshot must equal a fresh fold of the log (ELOG-02 / SC#3)"
    );
}

/// Resolve the most-recently-minted node's dense render handle from the view.
fn last_minted_handle(session: &GridSession) -> Option<u64> {
    let id = *session.core().last_tick.placed.last()?;
    session.view().handle_of(id)
}

proptest! {
    // The live projection equals a fresh re-fold for EVERY generated sequence of
    // normal applies (place fresh / delete-last-live / move-last-live). Undo/redo
    // marker groups are proven separately (the focused Open-Q3 tests below), since
    // there is no public driver to generate them in THIS plan.
    //
    // Plan 85-06 (D-10): op 3 seals the history. The floor is read from the logged seal by
    // the same projection the refold runs, so it joins the compared fields above, and a
    // generated log can hold several seals (the floor is the cursor at the LAST one).
    #[test]
    fn redo_cursor_equals_fold(ops in prop::collection::vec(0u8..4, 0..24)) {
        let mut session = GridSession::new(SEED);
        // Track the live render handles so deletes/moves target real nodes; a fresh
        // cell counter keeps every placement collision-free (deterministic layout).
        let mut live: Vec<u64> = Vec::new();
        let mut next_cell: i32 = 0;

        // The genesis projection already equals the (empty) fold.
        assert_projection_equals_fold(&session, SEED);

        for op in ops {
            match op {
                // Place a fresh source at a never-used cell (always accepted).
                0 => {
                    let cell_x = next_cell * 2;
                    next_cell += 1;
                    session
                        .apply(GridCommand::Place {
                            kind: machine_kind::SOURCE,
                            cell_x,
                            cell_y: 0,
                        })
                        .expect("a place at a fresh cell is accepted");
                    let h = last_minted_handle(&session).expect("source got a handle");
                    live.push(h);
                }
                // Delete the most-recent live node (skip if the grid is empty).
                1 => {
                    if let Some(node) = live.pop() {
                        session
                            .apply(GridCommand::Delete { node })
                            .expect("deleting a live node is accepted");
                    }
                }
                // Seal the history (plan 85-06): the floor becomes the cursor; nothing
                // below it is undoable, and the board does not change.
                3 => {
                    session.seal_history().expect("sealing the history is always accepted");
                }
                // Move the most-recent live node to a fresh cell (Delete+Place under
                // one shared action — exercises multi-record, multi-tick coalescing).
                _ => {
                    if let Some(node) = live.pop() {
                        let cell_x = next_cell * 2;
                        next_cell += 1;
                        session
                            .move_machine(node, machine_kind::SOURCE, cell_x, 5)
                            .expect("moving a live node to a fresh cell is accepted");
                        let h = last_minted_handle(&session).expect("moved node re-minted");
                        live.push(h);
                    }
                }
            }
            // After EVERY accepted action the live projection equals the fresh fold.
            assert_projection_equals_fold(&session, SEED);
        }
    }
}

// ---- Open Q3: redo of an undone delete / place, reconstructed purely from the log ----

/// Builds an edit-log group-by-group while driving a reference `Core`, so each group's
/// deterministically-minted ids are known as the frozen records are crafted (exactly
/// what the 12-04 driver will do at issue time through `xlate`). Each group folds in
/// ONE tick (mirroring the session's one-tick undo/redo append), so `replay`'s
/// `run_log_two_logs` regroups it identically and reproduces the same snapshot.
struct LogBuilder {
    core: Core,
    log: Vec<EditRecord>,
    seq: u64,
    action: u64,
}

impl LogBuilder {
    fn new(seed: u64) -> Self {
        Self {
            core: Core::genesis(LogHeader { schema_version: SCHEMA_VERSION, seed }),
            log: Vec::new(),
            seq: 0,
            action: 0,
        }
    }

    /// Append one action group (its `ops`, in order) at the current tick under one new
    /// shared action id, fold it on the reference core, and return the ids it minted.
    fn group(&mut self, ops: Vec<EditOp>) -> Vec<NodeId> {
        let action = self.action;
        self.action += 1;
        let tick = self.core.tick;
        let start = self.log.len();
        for op in ops {
            self.log.push(EditRecord {
                schema_version: EDIT_SCHEMA_VERSION,
                partition: 0,
                sequence: self.seq,
                tick,
                action,
                op,
            });
            self.seq += 1;
        }
        let slice = self.log[start..].to_vec();
        self.core.advance_edits(&slice, &[]);
        self.core.last_tick.placed.clone()
    }
}

fn place_source(cell_x: i32, cell_y: i32) -> EditOp {
    EditOp::Place {
        kind: machine_kind::SOURCE,
        cell_x,
        cell_y,
        w: 1,
        h: 1,
        ports: vec![],
        rot: 0,
    }
}

fn delete_source(node: NodeId, cell_x: i32, cell_y: i32) -> EditOp {
    EditOp::Delete {
        node,
        kind: machine_kind::SOURCE,
        cell_x,
        cell_y,
        captured: DeletedSubgraph::default(),
    }
}

/// Open Q3 (the named case): build a grid, DELETE a node, UNDO the delete (restore),
/// then REDO it (re-delete). Re-folding the whole log from genesis via `replay`
/// reconstructs the SAME cursor/undoable and the SAME core snapshot hash as the
/// incremental fold — SC#3 ("a given log replays to the same hash") holds for a
/// redo-of-a-delete. The undo-restore re-mints a fresh NodeId (the documented FLAG:
/// functional, not byte-identical), which SC#3 does not require.
#[test]
fn redo_of_an_undone_delete_reconstructs_from_the_log() {
    let mut b = LogBuilder::new(SEED);

    // action 0: Place a source.
    let s0 = b.group(vec![place_source(0, 0)])[0];
    // action 1: Delete it (a normal, undoable action).
    b.group(vec![delete_source(s0, 0, 0)]);
    // action 2: UNDO{target = 1} — marker + the restore (re-Place); re-mints s1 != s0.
    let restored = b.group(vec![EditOp::Undo { target_action: 1 }, place_source(0, 0)]);
    let s1 = restored[0];
    // action 3: REDO{target = 1} — marker + the re-delete of the restored node.
    b.group(vec![EditOp::Redo { target_action: 1 }, delete_source(s1, 0, 0)]);

    // The FLAG: the undo-restore re-minted a DISTINCT id (slotmap bumps the generation).
    assert_ne!(s0, s1, "the restore re-mints a fresh NodeId (functional, not byte-identical)");

    // Reconstruct purely from the log; it must equal the incremental fold (SC#3).
    let reconstructed = GridSession::replay(SEED, &b.log);
    assert_eq!(
        snapshot(reconstructed.core()),
        snapshot(&b.core),
        "replay reproduces the incremental fold's core snapshot byte-for-byte (SC#3)"
    );
    // Two live actions (the Place + the Delete); both currently applied after redo.
    assert_eq!(reconstructed.undoable_stack(), &[0, 1], "two undoable actions");
    assert_eq!(reconstructed.redo_cursor(), 2, "both live after the redo (re-deleted)");
    assert!(reconstructed.can_undo(), "the redo left an undoable action");
    assert!(!reconstructed.can_redo(), "nothing redoable after the redo");

    // Save -> load idempotence: re-folding the reconstructed log is byte-identical
    // (core snapshot AND projection) — the persisted log round-trips deterministically.
    let re_refold = GridSession::replay(SEED, reconstructed.edit_log());
    assert_eq!(
        snapshot(re_refold.core()),
        snapshot(reconstructed.core()),
        "the persisted log re-folds to the same hash on every load (SC#3)"
    );
    assert_eq!(re_refold.undoable_stack(), reconstructed.undoable_stack(), "stack survives re-fold");
    assert_eq!(re_refold.redo_cursor(), reconstructed.redo_cursor(), "cursor survives re-fold");
    assert_eq!(re_refold.id_translation(), reconstructed.id_translation(), "xlate survives re-fold");
}

/// The xlate proof: redo of an undone PLACE remaps the original-minted id to the
/// freshly re-minted id PURELY from the re-folded log (12-RESEARCH Pitfall 1). This is
/// the affirmative half of Open Q3 — `xlate` reconstructs the cross-undo/redo id
/// remap from the persisted log alone, no heavier persisted lineage required.
#[test]
fn redo_of_an_undone_place_remaps_xlate_from_the_log() {
    let mut b = LogBuilder::new(SEED);

    // action 0: Place a source -> s0.
    let s0 = b.group(vec![place_source(0, 0)])[0];
    // action 1: UNDO{target = 0} — marker + Delete(s0) (undoing the place removes it).
    b.group(vec![EditOp::Undo { target_action: 0 }, delete_source(s0, 0, 0)]);
    // action 2: REDO{target = 0} — marker + re-Place; re-mints s1 != s0.
    let remint = b.group(vec![EditOp::Redo { target_action: 0 }, place_source(0, 0)]);
    let s1 = remint[0];
    assert_ne!(s0, s1, "redo re-mints a fresh NodeId");

    let reconstructed = GridSession::replay(SEED, &b.log);
    assert_eq!(
        snapshot(reconstructed.core()),
        snapshot(&b.core),
        "replay reproduces the incremental fold (SC#3)"
    );
    // One undoable action, currently live (placed) after the redo.
    assert_eq!(reconstructed.undoable_stack(), &[0], "one undoable action");
    assert_eq!(reconstructed.redo_cursor(), 1, "live after redo");

    // The kernel claim: xlate maps the ORIGINAL minted id to the CURRENT live id,
    // reconstructed purely from the re-folded log.
    let xlate = reconstructed.id_translation();
    assert_eq!(
        xlate.get(&s0),
        Some(&s1),
        "xlate remaps the original-minted id to the redo-re-minted id, from the log alone"
    );

    // Idempotent across a re-fold (save -> load).
    let re_refold = GridSession::replay(SEED, reconstructed.edit_log());
    assert_eq!(re_refold.id_translation(), reconstructed.id_translation(), "xlate survives re-fold");
    assert_eq!(
        snapshot(re_refold.core()),
        snapshot(reconstructed.core()),
        "the log re-folds to the same hash on every load (SC#3)"
    );
}

// ============================================================================
// Phase 12-04 — the real GridCommand::Undo/Redo driver (the public surface).
//
// Every test below drives undo/redo through `GridSession::apply(GridCommand::
// Undo/Redo)` — the SAME schema both producers (UI, harness) use (CMD-01/04).
// Topology is asserted via observable counts (`node_count`, `links_iter`,
// `occupied`) — id-relabeling on re-mint is the accepted FLAG, so functional
// equivalence (not byte-identity) is the per-op bar.
// ============================================================================

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

// ---- One unit test per simple op: apply -> undo (restore) -> redo (re-apply) ----

#[test]
fn undo_inverse_place() {
    let mut session = GridSession::new(SEED);
    place(&mut session, machine_kind::SOURCE, 0, 0);
    assert_eq!(node_count(&session), 1, "node placed");
    assert!(occupied(&session, (0, 0)), "the cell is claimed");

    session.apply(GridCommand::Undo).expect("undo the place");
    assert_eq!(node_count(&session), 0, "undo removed the node");
    assert!(!occupied(&session, (0, 0)), "the cell is freed");

    session.apply(GridCommand::Redo).expect("redo the place");
    assert_eq!(node_count(&session), 1, "redo restored the node (re-minted)");
    assert!(occupied(&session, (0, 0)), "the cell is re-claimed (functional equivalence)");
}

// (17-02: `undo_inverse_wire` removed — node→node Wire no longer exists. Belt-minting
// undo/redo is covered by `undo_inverse_drawbelt`; dock link undo/redo by
// `undo_inverse_dock`.)

#[test]
fn undo_inverse_drawbelt() {
    let mut session = GridSession::new(SEED);
    draw(&mut session, vec![(10, 10), (11, 10)]);
    assert_eq!(node_count(&session), 1, "the drawn belt is one node");

    session.apply(GridCommand::Undo).expect("undo the drawbelt");
    assert_eq!(node_count(&session), 0, "undo removed the belt");

    session.apply(GridCommand::Redo).expect("redo the drawbelt");
    assert_eq!(node_count(&session), 1, "redo re-drew the belt (re-minted)");
}

#[test]
fn undo_inverse_rotate() {
    // A ROUTER is the 2×3 exemplar: rot0 occupies x{0,1}×y{0,1,2}; a CW rotate to
    // rot1 occupies x{0,1,2}×y{0,1}. So (0,2) is occupied at rot0 and free at rot1,
    // and (2,0) is the mirror — an observable, id-stable topology flip.
    let mut session = GridSession::new(SEED);
    let r = place(&mut session, machine_kind::ROUTER, 0, 0);
    assert!(occupied(&session, (0, 2)) && !occupied(&session, (2, 0)), "rot0 footprint");

    session
        .apply(GridCommand::Rotate { node: r, ccw: false })
        .expect("rotate the router CW");
    assert!(occupied(&session, (2, 0)) && !occupied(&session, (0, 2)), "rot1 footprint");

    session.apply(GridCommand::Undo).expect("undo the rotate");
    assert!(occupied(&session, (0, 2)) && !occupied(&session, (2, 0)), "rot0 restored by undo");

    session.apply(GridCommand::Redo).expect("redo the rotate");
    assert!(occupied(&session, (2, 0)) && !occupied(&session, (0, 2)), "rot1 re-applied by redo");
}

#[test]
fn undo_inverse_dock() {
    // OFFLOAD dock (the proven-valid geometry): ROUTER at (0,0) has Out port 1 at
    // world (1,1) facing E (the middle row since plan 74.1-14; it was (1,2)); a belt
    // drawn tail-first at (2,1)->(3,1) presents its tail
    // one step E of the port, facing W = opposite(E). Docking the Tail to port 1
    // (Out) links exactly one directed edge — undo Unlinks it, redo re-Docks it.
    let mut session = GridSession::new(SEED);
    let r = place(&mut session, machine_kind::ROUTER, 0, 0);
    let b = draw(&mut session, vec![(2, 1), (3, 1)]);
    let links_pre = link_count(&session);

    session
        .apply(GridCommand::Dock {
            belt: b,
            endpoint: fabrico_protocol::BeltEnd::Tail,
            node: r,
            port: 1,
        })
        .expect("a valid offload dock is accepted");
    let links_docked = link_count(&session);
    assert_eq!(links_docked, links_pre + 1, "the dock added exactly one link");

    session.apply(GridCommand::Undo).expect("undo the dock");
    assert_eq!(link_count(&session), links_pre, "undo Unlinked exactly that link");
    assert_eq!(node_count(&session), 2, "undo of a dock removes NO node (router + belt stay)");

    session.apply(GridCommand::Redo).expect("redo the dock");
    assert_eq!(link_count(&session), links_docked, "redo re-Docked the link");
}

// ---- 12-05: delete-time subgraph capture + delete-undo full-subgraph restore ----

/// The drawn belt geometry the docked-belt scenarios reuse: tail-first at (2,1)->(3,1),
/// presenting its tail one step E of the ROUTER's Out port (1,1) for a valid OFFLOAD dock
/// (the proven-valid geometry from `undo_inverse_dock`; the Out sits on the middle row
/// since plan 74.1-14, it was (1,2) with the belt at (2,2)->(3,2)).
const DOCK_BELT_CELLS: [(i32, i32); 2] = [(2, 1), (3, 1)];

/// Task 1: a Delete's PERSISTED record carries the REAL removed subgraph — the machine's
/// footprint + every cascade-removed belt's geometry + incident links — captured from the
/// LIVE pre-fold state, in `docked_wire_belts` order.
#[test]
fn delete_captures_docked_subgraph() {
    use fabrico_core::edit::EditOp;

    let mut session = GridSession::new(SEED);
    let r = place(&mut session, machine_kind::ROUTER, 0, 0);
    let b = draw(&mut session, DOCK_BELT_CELLS.to_vec());
    session
        .apply(GridCommand::Dock {
            belt: b,
            endpoint: fabrico_protocol::BeltEnd::Tail,
            node: r,
            port: 1,
        })
        .expect("offload dock");

    // Delete the ROUTER (cascade-detaches the docked drawn belt).
    session.apply(GridCommand::Delete { node: r }).expect("delete the router");

    // The LAST normal Delete record in the persisted log carries the real capture.
    let captured = session
        .edit_log()
        .iter()
        .rev()
        .find_map(|rec| match &rec.op {
            EditOp::Delete { captured, .. } => Some(captured.clone()),
            _ => None,
        })
        .expect("a Delete record exists in the log");

    // Machine footprint: the ROUTER 2x3 exemplar with EVERY declared port. The port
    // count is read from the catalog, not written down: 63-07 widened the Router's Out
    // arity (ROUTE-02) and a literal here would have failed on the number instead of on
    // the claim, which is that the capture takes the machine's WHOLE port list.
    let (base, catalog_ports) = fabrico_command::port_catalog(machine_kind::ROUTER);
    assert_eq!((captured.w, captured.h), (base.w, base.h), "router footprint captured");
    assert_eq!(
        captured.ports.len(),
        catalog_ports.len(),
        "every declared router port is captured"
    );
    // Exactly one cascade-removed belt, carrying its drawn geometry + the dock link.
    assert_eq!(captured.belts.len(), 1, "the one docked belt is captured");
    let belt = &captured.belts[0];
    assert_eq!(
        belt.geometry.iter().map(|t| t.cell).collect::<Vec<_>>(),
        DOCK_BELT_CELLS.to_vec(),
        "the belt's drawn geometry is captured"
    );
    assert!(!belt.links.is_empty(), "the belt's incident dock link is captured");
}

/// A simple 1×1 belt-less delete captures an EMPTY cascade-belt list and the SOURCE's
/// catalog footprint+ports (post-17-01 SOURCE is a 1×1 with a single Out port — the
/// "empty subgraph" now means no CASCADE BELTS, not a port-less machine).
#[test]
fn delete_of_bare_machine_captures_empty_subgraph() {
    use fabrico_command::command::port_catalog;
    use fabrico_core::edit::EditOp;

    let mut session = GridSession::new(SEED);
    let s = place(&mut session, machine_kind::SOURCE, 0, 0);
    session.apply(GridCommand::Delete { node: s }).expect("delete the source");

    let captured = session
        .edit_log()
        .iter()
        .rev()
        .find_map(|rec| match &rec.op {
            EditOp::Delete { captured, .. } => Some(captured.clone()),
            _ => None,
        })
        .expect("a Delete record exists");
    // The capture reflects the SOURCE's catalog: a 1×1 footprint with a single Out port.
    let (fp, ports) = port_catalog(machine_kind::SOURCE);
    assert_eq!((captured.w, captured.h), (fp.w, fp.h), "SOURCE 1×1 catalog footprint");
    assert_eq!(captured.ports, ports, "SOURCE carries its catalog Out port");
    assert!(captured.belts.is_empty(), "no cascade belts for a bare machine");
}

/// Task 2: undo of a delete of a docked-belt machine restores the machine AND re-draws +
/// re-docks the cascade-removed belt from the capture ALONE — node/belt counts + tile
/// occupancy return to pre-delete (up to id-relabeling). Redo re-deletes the whole subgraph.
#[test]
fn undo_inverse_delete() {
    let mut session = GridSession::new(SEED);
    let r = place(&mut session, machine_kind::ROUTER, 0, 0);
    let b = draw(&mut session, DOCK_BELT_CELLS.to_vec());
    session
        .apply(GridCommand::Dock {
            belt: b,
            endpoint: fabrico_protocol::BeltEnd::Tail,
            node: r,
            port: 1,
        })
        .expect("offload dock");

    let nodes_pre = node_count(&session); // router + belt
    let links_pre = link_count(&session); // the dock link
    assert_eq!(nodes_pre, 2, "router + docked belt");
    assert!(occupied(&session, (0, 0)), "router body occupied");
    assert!(occupied(&session, DOCK_BELT_CELLS[0]), "belt tile occupied");
    assert!(occupied(&session, DOCK_BELT_CELLS[1]), "belt tile occupied");

    // Delete the router → cascade-removes the docked belt + frees every tile cell.
    session.apply(GridCommand::Delete { node: r }).expect("delete the router");
    assert_eq!(node_count(&session), 0, "router + belt both gone");
    assert!(!occupied(&session, (0, 0)), "router cells freed");
    assert!(!occupied(&session, DOCK_BELT_CELLS[0]), "belt tile freed");
    assert!(!occupied(&session, DOCK_BELT_CELLS[1]), "belt tile freed");

    // Undo → restores the machine AND the docked belt (re-drawn + re-docked) from capture.
    session.apply(GridCommand::Undo).expect("undo the delete");
    assert_eq!(node_count(&session), nodes_pre, "node + belt counts restored");
    assert_eq!(link_count(&session), links_pre, "the dock link is restored");
    assert!(occupied(&session, (0, 0)), "router body re-occupied");
    assert!(occupied(&session, DOCK_BELT_CELLS[0]), "belt tile re-claimed");
    assert!(occupied(&session, DOCK_BELT_CELLS[1]), "belt tile re-claimed");

    // Redo → re-deletes the machine + the cascade belt again.
    session.apply(GridCommand::Redo).expect("redo the delete");
    assert_eq!(node_count(&session), 0, "redo re-removes router + belt");
    assert!(!occupied(&session, DOCK_BELT_CELLS[0]), "belt tile freed again");
}

/// Pitfall 3: undo of a DEGRADED move (the Delete folded, the Place leg rejected, so the
/// action group holds ONLY a Delete) restores ONLY the deleted machine — the inverse
/// operates on the records actually present, not the semantic "move".
#[test]
fn undo_degraded_move() {
    let mut session = GridSession::new(SEED);
    let a = place(&mut session, machine_kind::SOURCE, 0, 0);
    place(&mut session, machine_kind::SOURCE, 5, 0); // blocks the move target

    // Move A onto B's occupied cell: the Delete of A folds, the Place rejects → degraded.
    let moved = session.move_machine(a, machine_kind::SOURCE, 5, 0);
    assert!(moved.is_err(), "the move degrades (Place leg rejected after the Delete folded)");
    assert!(!occupied(&session, (0, 0)), "A was deleted (the degraded leg)");
    assert_eq!(node_count(&session), 1, "only B remains");

    // Undo the orphaned Delete → restores ONLY A at its old cell (no second leg).
    session.apply(GridCommand::Undo).expect("undo the degraded move's Delete");
    assert!(occupied(&session, (0, 0)), "A restored at its old cell");
    assert_eq!(node_count(&session), 2, "A is back; B untouched");
}

/// Task 3: undo -> redo -> undo of a delete-with-docked-belt oscillates the topology
/// correctly (restored -> re-deleted -> restored), and the edit-log ONLY ever grows
/// (strictly append-only across every step).
#[test]
fn undo_redo_undo() {
    let mut session = GridSession::new(SEED);
    let r = place(&mut session, machine_kind::ROUTER, 0, 0);
    let b = draw(&mut session, DOCK_BELT_CELLS.to_vec());
    session
        .apply(GridCommand::Dock {
            belt: b,
            endpoint: fabrico_protocol::BeltEnd::Tail,
            node: r,
            port: 1,
        })
        .expect("offload dock");
    let restored_nodes = node_count(&session); // router + belt
    let restored_links = link_count(&session); // the dock link

    let mut log_len = session.edit_log().len();
    let grew = |session: &GridSession, log_len: &mut usize| {
        let now = session.edit_log().len();
        assert!(now > *log_len, "the edit-log only ever grows (append-only)");
        *log_len = now;
    };

    // Delete → undo → redo → undo, asserting the count oscillation + monotonic log.
    session.apply(GridCommand::Delete { node: r }).expect("delete");
    grew(&session, &mut log_len);
    assert_eq!(node_count(&session), 0, "deleted: router + belt gone");

    session.apply(GridCommand::Undo).expect("undo #1");
    grew(&session, &mut log_len);
    assert_eq!(node_count(&session), restored_nodes, "undo #1 restored the subgraph");
    assert_eq!(link_count(&session), restored_links, "undo #1 restored the dock link");

    session.apply(GridCommand::Redo).expect("redo");
    grew(&session, &mut log_len);
    assert_eq!(node_count(&session), 0, "redo re-deleted the subgraph");
    assert!(!occupied(&session, DOCK_BELT_CELLS[0]), "belt tile freed by redo");

    session.apply(GridCommand::Undo).expect("undo #2");
    grew(&session, &mut log_len);
    assert_eq!(node_count(&session), restored_nodes, "undo #2 restored the subgraph again");
    assert_eq!(link_count(&session), restored_links, "undo #2 restored the dock link again");
    assert!(occupied(&session, DOCK_BELT_CELLS[0]), "belt tile re-claimed by undo #2");
    assert!(occupied(&session, DOCK_BELT_CELLS[1]), "belt tile re-claimed by undo #2");

    // The whole oscillation reconstructs purely from the persisted log (SC#3).
    assert_replay_reproduces_live(&session);
}

// ---- Coalescing: one logical action = one undo step ----

#[test]
fn one_action_one_undo_step() {
    // A move (Delete+Place under one shared action) reverses in ONE undo call.
    let mut session = GridSession::new(SEED);
    let id_handle = place(&mut session, machine_kind::SOURCE, 0, 0);
    session
        .move_machine(id_handle, machine_kind::SOURCE, 7, 7)
        .expect("move the source");
    assert!(occupied(&session, (7, 7)) && !occupied(&session, (0, 0)), "moved");

    session.apply(GridCommand::Undo).expect("ONE undo reverses the whole move");
    assert!(occupied(&session, (0, 0)) && !occupied(&session, (7, 7)), "move undone in one step");
    // The original place survives (the move was the second logical action).
    assert!(session.can_undo(), "the original place remains undoable");

    // A DrawBelt is one record = one action: it also reverses in one undo call.
    let mut s2 = GridSession::new(SEED);
    draw(&mut s2, vec![(0, 0), (1, 0), (2, 0)]);
    assert_eq!(node_count(&s2), 1, "belt drawn");
    s2.apply(GridCommand::Undo).expect("one undo removes the whole belt");
    assert_eq!(node_count(&s2), 0, "the drawbelt reversed in one step");
}

// ---- Empty-stack typed rejects (byte-identical, T-12-06) ----

#[test]
fn empty_stack_typed_reject() {
    let mut session = GridSession::new(SEED);
    let genesis = snapshot(session.core());

    assert_eq!(
        session.apply(GridCommand::Undo).err(),
        Some(CommandError::NothingToUndo),
        "undo on genesis is a typed reject"
    );
    assert_eq!(
        session.apply(GridCommand::Redo).err(),
        Some(CommandError::NothingToRedo),
        "redo with a full cursor is a typed reject"
    );
    assert_eq!(snapshot(session.core()), genesis, "both rejects leave the core byte-identical");
    assert!(session.edit_log().is_empty(), "neither reject appended a record");

    // After a place + undo, the redo stack is non-empty but a SECOND redo is empty.
    place(&mut session, machine_kind::SOURCE, 0, 0);
    session.apply(GridCommand::Undo).expect("undo");
    session.apply(GridCommand::Redo).expect("redo");
    let after_redo = snapshot(session.core());
    assert_eq!(
        session.apply(GridCommand::Redo).err(),
        Some(CommandError::NothingToRedo),
        "a second redo with nothing undone is NothingToRedo"
    );
    assert_eq!(snapshot(session.core()), after_redo, "the empty redo is byte-identical");
}

// ---- A fresh normal action after an undo invalidates the redo stack (Q1.1) ----

#[test]
fn fresh_action_kills_redo() {
    let mut session = GridSession::new(SEED);
    place(&mut session, machine_kind::SOURCE, 0, 0);
    session.apply(GridCommand::Undo).expect("undo the place");
    assert!(session.can_redo(), "redoable right after the undo");

    // A fresh place truncates the redo tail (linear history).
    place(&mut session, machine_kind::SOURCE, 2, 0);
    assert!(!session.can_redo(), "the fresh action killed the redo stack");
    assert_eq!(
        session.apply(GridCommand::Redo).err(),
        Some(CommandError::NothingToRedo),
        "redo after the fresh action is NothingToRedo"
    );
}

// ---- Append-only property: the log only ever grows; prior records never mutate ----

proptest! {
    #[test]
    fn undo_is_append_only(ops in prop::collection::vec(0u8..3, 0..30)) {
        let mut session = GridSession::new(SEED);
        let mut next_cell: i32 = 0;
        // The log before each op — every step must keep this as an exact prefix.
        let mut prev: Vec<_> = session.edit_log().to_vec();

        for op in ops {
            match op {
                // Place a fresh source (always accepted, collision-free layout).
                0 => {
                    session
                        .apply(GridCommand::Place {
                            kind: machine_kind::SOURCE,
                            cell_x: next_cell * 2,
                            cell_y: 0,
                        })
                        .expect("a place at a fresh cell is accepted");
                    next_cell += 1;
                }
                // Undo / Redo may be empty-stack rejects — both leave the log unchanged.
                1 => { let _ = session.apply(GridCommand::Undo); }
                _ => { let _ = session.apply(GridCommand::Redo); }
            }
            let now: Vec<_> = session.edit_log().to_vec();
            prop_assert!(now.len() >= prev.len(), "the edit-log length is monotonic (append-only)");
            prop_assert_eq!(&now[..prev.len()], &prev[..], "no prior record is ever mutated");
            prev = now;
        }
    }
}

// ---- The real-driver SC#3 spot-check (Wave 4, not deferred to Wave 6) ----

/// After EACH real `Undo`/`Redo`, a fresh `GridSession::replay(seed, edit_log())`
/// reproduces the LIVE projection (`undoable`, `cursor`, `can_undo`, `can_redo`,
/// `xlate`) AND the live core snapshot hash — proving the kernel reconstructs from
/// REAL driver-produced marker groups + frozen inverses (12-03 only proved it over
/// simulated/hand-appended groups; 12-06 proves the full serialized save->load).
fn assert_replay_reproduces_live(session: &GridSession) {
    let refold = GridSession::replay(SEED, session.edit_log());
    assert_eq!(refold.undoable_stack(), session.undoable_stack(), "undoable stack reconstructs");
    assert_eq!(refold.redo_cursor(), session.redo_cursor(), "cursor reconstructs");
    assert_eq!(refold.can_undo(), session.can_undo(), "can_undo reconstructs");
    assert_eq!(refold.can_redo(), session.can_redo(), "can_redo reconstructs");
    assert_eq!(refold.id_translation(), session.id_translation(), "xlate reconstructs");
    assert_eq!(
        snapshot(refold.core()),
        snapshot(session.core()),
        "the live core snapshot hash reconstructs from the REAL driver records (SC#3)"
    );
}

#[test]
fn undo_redo_replay_equality() {
    // A scripted REAL command sequence exercising undo/redo of DrawBelt, Dock and
    // Rotate (with a redo and a fresh-action redo-kill in the middle), driven entirely
    // through the public `GridCommand` surface.
    let mut session = GridSession::new(SEED);
    let r = place(&mut session, machine_kind::ROUTER, 0, 0);
    // RE-AUTHORED IN 74.1-14: the belt stays on the row-2 doorstep (2,2) and docks the
    // Out that sits there now, catalog 2 (the first Out moved to the middle row, whose
    // doorstep a clockwise turn of the router would cover, refusing the Rotate below).
    let b = draw(&mut session, vec![(2, 2), (3, 2)]);
    session
        .apply(GridCommand::Dock {
            belt: b,
            endpoint: fabrico_protocol::BeltEnd::Tail,
            node: r,
            port: 2,
        })
        .expect("offload dock");

    // Undo the dock, then undo the belt; each lands a REAL marker group.
    session.apply(GridCommand::Undo).expect("undo dock");
    assert_replay_reproduces_live(&session);
    session.apply(GridCommand::Undo).expect("undo belt");
    assert_replay_reproduces_live(&session);

    // Redo the belt (re-mints it under a fresh id — the FLAG).
    session.apply(GridCommand::Redo).expect("redo belt");
    assert_replay_reproduces_live(&session);

    // A FRESH normal action (rotate the router) truncates the still-undone dock from
    // the redo tail (Q1.1) — the router's rot1 (x{0,1,2}×y{0,1}) clears the belt at y=2.
    session
        .apply(GridCommand::Rotate { node: r, ccw: false })
        .expect("a fresh rotate after the redo");
    assert_replay_reproduces_live(&session);

    // Undo the rotate; the projection + hash still reconstruct from the real records.
    session.apply(GridCommand::Undo).expect("undo rotate");
    assert_replay_reproduces_live(&session);
}

// ============================================================================
// Phase 12-06 (Wave 6) — the accepted FLAG, proven (Q2.4 / RESEARCH Pitfall 1).
//
// An undo→redo round-trip re-mints fresh NodeIds (slotmap bumps the generation),
// so the result is FUNCTIONALLY equivalent to never-undone — identical node/belt/
// link counts and tile occupancy — but NOT byte-identical (the raw snapshot differs
// by id labels). Byte-identity is INTENTIONALLY relaxed to functional equivalence
// here; SC#3 ("the saved log replays forward to its own hash") is independent of the
// id drift and is re-affirmed below via a postcard round-trip of the post-redo log.
// ============================================================================

proptest! {
    /// For a generated sequence of always-accepted actions (place a source at a fresh
    /// row-0 cell, or draw a 2-tile belt at a fresh row-4 cell — never colliding), record
    /// the never-undone topology, then UNDO every action and REDO every action. The
    /// post-redo topology must be FUNCTIONALLY equivalent to never-undone (same node /
    /// link counts + same occupied cells), while the saved log still replays to its OWN
    /// hash. Id labels may differ (the accepted FLAG) — that is why this asserts counts +
    /// occupancy, NOT raw snapshot bytes, against the baseline.
    #[test]
    fn undo_redo_functional_equiv(ops in prop::collection::vec(0u8..2, 1..16)) {
        let mut session = GridSession::new(SEED);
        // The cells the never-undone build occupies — the functional-equivalence oracle.
        let mut occupied_cells: Vec<(i32, i32)> = Vec::new();
        let mut action_count = 0usize;

        for (idx, op) in (0_i32..).zip(ops.iter()) {
            match op {
                // A bare source at (2*idx, 0): one undoable action, always accepted.
                0 => {
                    place(&mut session, machine_kind::SOURCE, idx * 2, 0);
                    occupied_cells.push((idx * 2, 0));
                }
                // A 2-tile straight belt at row 4: one undoable action, never colliding
                // with the row-0 sources or any other belt (distinct idx ⇒ distinct x).
                _ => {
                    draw(&mut session, vec![(idx * 2, 4), (idx * 2 + 1, 4)]);
                    occupied_cells.push((idx * 2, 4));
                    occupied_cells.push((idx * 2 + 1, 4));
                }
            }
            action_count += 1;
        }

        // The NEVER-UNDONE baseline topology (the functional-equivalence oracle).
        let nodes_baseline = node_count(&session);
        let links_baseline = link_count(&session);
        for c in &occupied_cells {
            prop_assert!(occupied(&session, *c), "baseline cell {:?} is occupied", c);
        }

        // Undo EVERY action → the grid empties (each op was exactly one undoable action).
        for _ in 0..action_count {
            session.apply(GridCommand::Undo).expect("undo a built action");
        }
        prop_assert_eq!(node_count(&session), 0, "undoing every action empties the grid");

        // Redo EVERY action → the topology returns, re-minted under FRESH ids (the FLAG).
        for _ in 0..action_count {
            session.apply(GridCommand::Redo).expect("redo a built action");
        }

        // FUNCTIONAL equivalence (NOT byte-identity): counts + occupancy match the
        // never-undone baseline. The id labels are allowed to differ (slotmap re-mint).
        prop_assert_eq!(node_count(&session), nodes_baseline, "node count returns to baseline");
        prop_assert_eq!(link_count(&session), links_baseline, "link count returns to baseline");
        for c in &occupied_cells {
            prop_assert!(occupied(&session, *c), "post-redo cell {:?} re-claimed", c);
        }

        // SC#3 re-affirmed independent of the id drift: the saved (post-redo) log
        // replays FORWARD to its OWN hash across a real postcard save→load round-trip.
        let bytes = postcard::to_allocvec(&session.edit_log().to_vec())
            .expect("the post-redo edit-log postcard-encodes");
        let records: Vec<EditRecord> =
            postcard::from_bytes(&bytes).expect("the post-redo edit-log decodes");
        let refold = GridSession::replay(SEED, &records);
        prop_assert_eq!(
            snapshot(refold.core()),
            snapshot(session.core()),
            "the post-redo log replays to its own hash on save→load (SC#3, id-drift-independent)"
        );
    }
}

// ============================================================================
// Phase 19-01 — the live-host engine seam.
//
// `resolve_undo`/`resolve_redo` are the `&self` "compute the resolved records" half:
// they reuse `compute_inverse` VERBATIM and return FROZEN, UNSTAMPED records for the
// host to stamp. `fold_live` is the `&mut self` "fold + project" half: it folds a
// host-stamped batch through the certified `advance_edits` and refreshes the
// projection. Split so the host stamps provenance in between (decision (c) Option B).
// ============================================================================

/// Assert every record in a resolved group is UNSTAMPED — all four provenance fields
/// `0`, schema at `EDIT_SCHEMA_VERSION`. The host stamps these before folding.
fn assert_unstamped(records: &[EditRecord]) {
    for r in records {
        assert_eq!(r.partition, 0, "partition must be unstamped (0) — host stamps it");
        assert_eq!(r.sequence, 0, "sequence must be unstamped (0) — host stamps it");
        assert_eq!(r.tick, 0, "tick must be unstamped (0) — host stamps it");
        assert_eq!(r.action, 0, "action must be unstamped (0) — host stamps it");
        assert_eq!(r.schema_version, EDIT_SCHEMA_VERSION, "schema is the current version");
    }
}

#[test]
fn resolve_undo_redo_empty_stack_is_typed_error() {
    let session = GridSession::new(SEED);
    assert_eq!(
        session.resolve_undo().err(),
        Some(CommandError::NothingToUndo),
        "resolve_undo on a fresh session is a typed NothingToUndo (never a panic)"
    );
    assert_eq!(
        session.resolve_redo().err(),
        Some(CommandError::NothingToRedo),
        "resolve_redo with a full cursor is a typed NothingToRedo"
    );
}

#[test]
fn resolve_undo_after_place_is_unstamped_nonempty() {
    let mut session = GridSession::new(SEED);
    place(&mut session, machine_kind::SOURCE, 0, 0);

    let group = session.resolve_undo().expect("undo is resolvable after a place");
    assert!(!group.is_empty(), "the inverse group is non-empty");
    assert_unstamped(&group);
    assert!(
        matches!(group[0].op, EditOp::Undo { .. }),
        "the resolved group leads with the Undo lineage marker"
    );
    assert!(
        group.iter().any(|r| matches!(r.op, EditOp::Delete { .. })),
        "a Place inverts to a Delete of the live node"
    );
}

#[test]
fn resolve_undo_does_not_mutate() {
    let mut session = GridSession::new(SEED);
    place(&mut session, machine_kind::SOURCE, 0, 0);

    let before = snapshot(session.core());
    let log_len = session.edit_log().len();
    let cursor = session.redo_cursor();
    let can_undo = session.can_undo();

    let first = session.resolve_undo().expect("resolve once");
    let second = session.resolve_undo().expect("resolve twice");
    assert_eq!(first, second, "resolve_undo is idempotent (identical result each call)");

    assert_eq!(snapshot(session.core()), before, "resolve_undo does not touch the core");
    assert_eq!(session.edit_log().len(), log_len, "resolve_undo appends nothing");
    assert_eq!(session.redo_cursor(), cursor, "the cursor is unchanged");
    assert_eq!(session.can_undo(), can_undo, "can_undo is unchanged");
}

#[test]
fn resolve_redo_mirrors_after_undo() {
    let mut session = GridSession::new(SEED);
    place(&mut session, machine_kind::SOURCE, 0, 0);
    // Nothing undone yet: redo is a typed reject.
    assert_eq!(
        session.resolve_redo().err(),
        Some(CommandError::NothingToRedo),
        "resolve_redo with a full cursor is NothingToRedo"
    );

    session.apply(GridCommand::Undo).expect("undo the place");
    let group = session.resolve_redo().expect("redo is resolvable after an undo");
    assert!(!group.is_empty(), "the redo group is non-empty");
    assert_unstamped(&group);
    assert!(
        matches!(group[0].op, EditOp::Redo { .. }),
        "the resolved group leads with the Redo lineage marker"
    );
}

#[test]
fn resolve_undo_on_forged_log_is_typed_not_panic() {
    // A forged/corrupted log loaded via `replay`: a Place with an UNKNOWN kind folds
    // to a NO-OP (mints nothing) yet is reconstructed as a normal undoable group, so
    // compute_inverse's minting-op/minted-id parity guard (CR-01) must reject it
    // TYPED — never a panic (the no-panic-on-hostile-decode mandate, threat T-19-01).
    let forged = vec![EditRecord {
        schema_version: EDIT_SCHEMA_VERSION,
        partition: 0,
        sequence: 0,
        tick: 0,
        action: 0,
        op: EditOp::Place { kind: 250, cell_x: 0, cell_y: 0, w: 1, h: 1, ports: Vec::new(), rot: 0 },
    }];
    let session = GridSession::replay(SEED, &forged);
    match session.resolve_undo() {
        Err(CommandError::UndoDoesNotFit) | Err(CommandError::NothingToUndo) => {}
        other => panic!("forged-log resolve_undo must be a typed reject, got {other:?}"),
    }
}

// ---- fold_live: the &mut self fold + project half (certified advance_edits) ----

#[test]
fn fold_live_matches_apply_place_state() {
    // Produce a RESOLVED Place record via the certified `apply` path (scratch session),
    // then fold the same host-stamped record via `fold_live` on a fresh session — the
    // two cores must be byte-identical (fold_live folds through the same advance_edits).
    let mut scratch = GridSession::new(SEED);
    let place_op = scratch
        .apply(GridCommand::Place { kind: machine_kind::SOURCE, cell_x: 0, cell_y: 0 })
        .expect("place at a free cell")
        .op
        .clone();

    let stamped = EditRecord {
        schema_version: EDIT_SCHEMA_VERSION,
        partition: 0,
        sequence: 0,
        tick: 0,
        action: 0,
        op: place_op,
    };
    let mut live = GridSession::new(SEED);
    let cmds = live.fold_live(&[stamped], &[]);

    assert_eq!(
        snapshot(live.core()),
        snapshot(scratch.core()),
        "fold_live folds the host-stamped Place to the SAME core state as the apply path"
    );
    assert!(cmds.is_empty(), "a Place emits no command intent this tick");
    // The projection refreshed: the just-folded action is now undoable + resolvable.
    assert!(live.can_undo(), "fold_live refreshed the projection (can_undo)");
    let undo_group = live.resolve_undo().expect("the just-folded Place is undoable");
    assert!(
        undo_group.iter().any(|r| matches!(r.op, EditOp::Delete { .. })),
        "a subsequent resolve_undo targets the just-folded Place (inverts to a Delete)"
    );
}

#[test]
fn fold_live_stores_host_stamps_verbatim() {
    // Records arrive ALREADY host-stamped; fold_live must NOT re-stamp them. Use
    // distinctive non-zero host provenance and assert the stored record is verbatim.
    let mut scratch = GridSession::new(SEED);
    let place_op = scratch
        .apply(GridCommand::Place { kind: machine_kind::SOURCE, cell_x: 3, cell_y: 4 })
        .expect("place at a free cell")
        .op
        .clone();

    let stamped = EditRecord {
        schema_version: EDIT_SCHEMA_VERSION,
        partition: 0,
        sequence: 42,
        tick: 0,
        action: 7,
        op: place_op,
    };
    let mut live = GridSession::new(SEED);
    live.fold_live(std::slice::from_ref(&stamped), &[]);

    assert_eq!(live.edit_log().len(), 1, "fold_live appended exactly the host batch");
    assert_eq!(
        live.edit_log()[0],
        stamped,
        "fold_live stores the host-stamped record VERBATIM (no re-stamp of partition/sequence/tick/action)"
    );
    // The host-stamped action drives the projection (grouped by record.action).
    assert_eq!(live.undoable_stack(), &[7], "the projection groups by the host-stamped action");
    assert!(live.can_undo(), "the folded action is undoable");
}

#[test]
fn fold_live_empty_tick_leaves_projection_unchanged() {
    // WR-02: `fold_live` skips `reconstruct_projection` when the edit batch is empty
    // (an idle tick), because the projection is a pure function of the edit-log and an
    // empty batch changes nothing. This test pins that the SKIP is behaviour-preserving:
    // the undo projection after an EMPTY fold_live is byte-identical to the pre-fold one.
    let mut scratch = GridSession::new(SEED);
    let place_op = scratch
        .apply(GridCommand::Place { kind: machine_kind::SOURCE, cell_x: 1, cell_y: 1 })
        .expect("place at a free cell")
        .op
        .clone();
    let stamped = EditRecord {
        schema_version: EDIT_SCHEMA_VERSION,
        partition: 0,
        sequence: 0,
        tick: 0,
        action: 0,
        op: place_op,
    };
    let mut live = GridSession::new(SEED);
    live.fold_live(&[stamped], &[]);

    // Capture the projection after the edit tick.
    let stack_before = live.undoable_stack().to_vec();
    let can_undo_before = live.can_undo();
    let can_redo_before = live.can_redo();
    let log_len_before = live.edit_log().len();

    // An IDLE tick: no edits, no events. reconstruct_projection is skipped. (The core
    // tick advances every fold — that is not part of the undo PROJECTION WR-02 guards.)
    let cmds = live.fold_live(&[], &[]);
    assert!(cmds.is_empty(), "an idle fold emits no command intent");

    assert_eq!(live.undoable_stack(), stack_before.as_slice(), "undoable stack unchanged by an idle tick");
    assert_eq!(live.can_undo(), can_undo_before, "can_undo unchanged by an idle tick");
    assert_eq!(live.can_redo(), can_redo_before, "can_redo unchanged by an idle tick");
    assert_eq!(live.edit_log().len(), log_len_before, "edit-log length unchanged by an idle tick");

    // And the projection is still LIVE: the folded action stays resolvable.
    let undo_group = live.resolve_undo().expect("the pre-idle Place is still undoable");
    assert!(
        undo_group.iter().any(|r| matches!(r.op, EditOp::Delete { .. })),
        "resolve_undo still targets the folded Place after an idle tick"
    );
}

#[test]
fn fold_live_replays_to_its_own_hash() {
    // fold_live's edit_log must remain a faithful replay source: a fresh replay of the
    // host-stamped log reproduces the live core (the determinism invariant, T-19-04).
    let mut scratch = GridSession::new(SEED);
    let place_op = scratch
        .apply(GridCommand::Place { kind: machine_kind::SOURCE, cell_x: 5, cell_y: 5 })
        .expect("place at a free cell")
        .op
        .clone();
    let stamped = EditRecord {
        schema_version: EDIT_SCHEMA_VERSION,
        partition: 0,
        sequence: 0,
        tick: 0,
        action: 0,
        op: place_op,
    };
    let mut live = GridSession::new(SEED);
    live.fold_live(&[stamped], &[]);

    let refold = GridSession::replay(SEED, live.edit_log());
    assert_eq!(
        snapshot(refold.core()),
        snapshot(live.core()),
        "the fold_live log replays forward to its own hash (ELOG-02 / T-19-04)"
    );
}

// ============================================================================
// Phase 63-03 (WIRE-01) — a DRAWN WIRE is undoable.
//
// Plan 63-02 gave `EditOp::DrawWire` a fold that MINTS, and pushes the minted id
// into `last_tick.placed`. Everything below is the consequence: the inverse of a
// minting op is a `Delete` of the id it minted, and TWO hand-maintained positional
// lists have to know that a third op mints (the parity filter in `compute_inverse`
// and the harvest matcher in `capture_after_fold`).
//
// The wire endpoints are electrical preset Routers, for the reason
// `tests/draw_wire.rs` documents: `place_router_preset(Medium::Electrical, ..)` is
// the ONLY command path to a `Medium::Electrical` port, and a `DrawWire` between two
// Mechanical ports is a `MediumMismatch` at validate time.
// ============================================================================

/// The port indices an electrical `place_router_preset` seeds: index 0 is the `In`/W
/// and indices 1.. are its `fabrico_command::ROUTER_OUT_ARITY` `Out`/E ports, all
/// `Electrical`. These two are the same constants `tests/draw_wire.rs` pins with its
/// own catalog test, and they are unchanged by plan 65-05's widening because the
/// widening APPENDS.
const WIRE_IN_PORT: u16 = 0;
const WIRE_OUT_PORT: u16 = 1;

/// Place an electrical preset Router at `(x, y)` and return its minted `NodeId`.
fn electrical_router(session: &mut GridSession, x: i32, y: i32) -> NodeId {
    session
        .place_router_preset(fabrico_core::state::Medium::Electrical, x, y)
        .expect("an electrical router preset places on a free cell");
    session
        .core()
        .state
        .occupied((x, y))
        .expect("the preset router occupies its anchor cell")
}

/// The dense render handle for a `NodeId` (what a `GridCommand` targets).
fn handle_of(session: &GridSession, id: NodeId) -> u64 {
    session.view().handle_of(id).expect("live node has a handle")
}

/// A session holding two electrical preset Routers, plus their ids.
fn two_electrical_routers() -> (GridSession, NodeId, NodeId) {
    let mut session = GridSession::new(SEED);
    let a = electrical_router(&mut session, 0, 0);
    let b = electrical_router(&mut session, 10, 10);
    (session, a, b)
}

/// The `DrawWire` command wiring `a`'s first Out port to `b`'s In port, by handle.
fn draw_wire_cmd(session: &GridSession, a: NodeId, b: NodeId) -> GridCommand {
    GridCommand::DrawWire {
        from_node: handle_of(session, a),
        from_port: WIRE_OUT_PORT,
        to_node: handle_of(session, b),
        to_port: WIRE_IN_PORT,
    }
}

/// Every live `Node::Wire` id, in deterministic id order.
fn wire_ids(session: &GridSession) -> Vec<NodeId> {
    session
        .core()
        .state
        .node_ids()
        .filter(|id| matches!(session.core().state.node(*id), Some(fabrico_core::state::Node::Wire(_))))
        .collect()
}

/// Fold ONE action group of `[DrawWire, Place]` — in that order — through
/// [`GridSession::fold_live`], the seam the live host drives and the only one that
/// hands `capture_after_fold` a MULTI-record slice in one tick. Returns
/// `(minted_wire, minted_machine)` read off `last_tick.placed`, whose order is the
/// fold order and therefore the RECORD order: the wire is slot 0, the machine slot 1.
///
/// The group is stamped under an action id ABOVE every action the session has spent,
/// so the inverse group a later `GridCommand::Undo` appends (which takes the session's
/// own next action id) can never collide with it.
fn fold_wire_first_group(
    session: &mut GridSession,
    a: NodeId,
    b: NodeId,
) -> (NodeId, NodeId) {
    let action = 1_000;
    let seq = session.edit_log().len() as u64;
    let tick = session.core().tick;
    let stamp = |sequence: u64, op: EditOp| EditRecord {
        schema_version: EDIT_SCHEMA_VERSION,
        partition: 0,
        sequence,
        tick,
        action,
        op,
    };
    let group = vec![
        stamp(
            seq,
            EditOp::DrawWire {
                from_node: a,
                from_port: WIRE_OUT_PORT,
                to_node: b,
                to_port: WIRE_IN_PORT,
            },
        ),
        stamp(seq + 1, place_source(20, 20)),
    ];
    session.fold_live(&group, &[]);
    let placed = session.core().last_tick.placed.clone();
    assert_eq!(placed.len(), 2, "the group minted a wire AND a machine, in record order");
    (placed[0], placed[1])
}

/// The GRID-STATE bytes — the topology oracle these tests compare on.
///
/// # Why not `snapshot(core)`, and why not against the PRE-DRAW state
/// Plan 63-03 asked for byte equality between the post-undo state and the PRE-DRAW
/// state. That is not attainable in this codebase for ANY op, and it is not a wire
/// defect. Two independent reasons, both measured before this test was written:
///
/// 1. `snapshot` serializes the whole `Core`, whose FIRST field is the monotonic
///    `tick`. A draw is one tick and its undo is another, so the two blobs differ in
///    their second byte no matter what the fold did.
/// 2. `GridState` alone still differs, because the node store is a slotmap and its
///    serialization carries the slot vector INCLUDING freed slots and their bumped
///    generations. Placing and undoing a bare `SOURCE` — no wire in sight — moves
///    those bytes exactly the same way.
///
/// That is the id-relabeling FLAG this file's header already records: functional
/// equivalence, not byte-identity, is the per-op bar. So the byte oracle is kept and
/// the REFERENCE is changed: the post-undo state is compared against a session that
/// reached the same place through an EXPLICIT `GridCommand::Delete` of the same wire.
/// That reference shares the allocator history exactly, so the comparison is a real
/// byte comparison, and it says something a node count cannot: the inverse of a
/// `DrawWire` is a Delete of the id it minted and NOTHING else — not a different
/// node, not a Delete that leaves the forward link standing.
fn state_bytes(session: &GridSession) -> Vec<u8> {
    postcard::to_allocvec(&session.core().state).expect("GridState is plain serde data")
}

/// A reference session holding two electrical Routers that drew the same wire and then
/// DELETED it through an explicit `GridCommand::Delete` — the allocator-faithful
/// twin of "drew it and undid it".
fn reference_draw_then_delete() -> GridSession {
    let (mut session, a, b) = two_electrical_routers();
    let cmd = draw_wire_cmd(&session, a, b);
    session.apply(cmd).expect("a legal wire is drawn");
    let wire = wire_ids(&session)[0];
    session
        .apply(GridCommand::Delete { node: handle_of(&session, wire) })
        .expect("a live wire is deletable");
    session
}

#[test]
fn undo_of_a_drawn_wire_removes_exactly_the_minted_wire() {
    let (mut session, a, b) = two_electrical_routers();
    let pre_draw_nodes = node_count(&session);
    let pre_draw_links = link_count(&session);

    let cmd = draw_wire_cmd(&session, a, b);
    session.apply(cmd).expect("a legal wire is drawn");
    assert_eq!(node_count(&session), pre_draw_nodes + 1, "the wire is one new node");
    assert_eq!(link_count(&session), pre_draw_links + 1, "the wire records one forward link");
    let wire = wire_ids(&session)[0];

    session.apply(GridCommand::Undo).expect("a drawn wire is undoable");

    // RESEARCH Pitfall 2's warning sign is a post-undo node count ONE HIGHER than
    // pre-draw. That is the first thing asserted, by count, deliberately.
    assert_eq!(node_count(&session), pre_draw_nodes, "undo removed exactly the minted wire");
    assert_eq!(link_count(&session), pre_draw_links, "undo removed the wire's forward link");
    assert!(wire_ids(&session).is_empty(), "no Node::Wire survives the undo");
    assert!(session.core().state.node(wire).is_none(), "the minted id is dead");
    // The byte oracle (see `state_bytes`): identical to an explicit Delete of the wire.
    assert_eq!(
        state_bytes(&session),
        state_bytes(&reference_draw_then_delete()),
        "undo of a DrawWire leaves the SAME grid bytes an explicit Delete of it leaves"
    );
    // And the whole log still replays from genesis to the live state (ELOG-02 / SC#3).
    assert_replay_reproduces_live(&session);
}

#[test]
fn redo_of_an_undone_drawn_wire_re_mints_the_same_wire() {
    let (mut session, a, b) = two_electrical_routers();
    let cmd = draw_wire_cmd(&session, a, b);
    session.apply(cmd).expect("a legal wire is drawn");
    let post_draw_nodes = node_count(&session);
    let post_draw_links = link_count(&session);
    let drawn_endpoints = wire_endpoints(&session);

    session.apply(GridCommand::Undo).expect("a drawn wire is undoable");
    session.apply(GridCommand::Redo).expect("an undone wire is redoable");

    assert_eq!(node_count(&session), post_draw_nodes, "redo re-minted the wire");
    assert_eq!(link_count(&session), post_draw_links, "redo re-recorded the forward link");
    assert_eq!(
        wire_endpoints(&session),
        drawn_endpoints,
        "redo re-mints a wire carrying the SAME WireLink from/to"
    );
    // The byte oracle: identical to drawing, deleting, and drawing the wire AGAIN —
    // the allocator-faithful twin of undo-then-redo.
    let mut redrawn = reference_draw_then_delete();
    let (a2, b2) = (
        redrawn.core().state.occupied((0, 0)).expect("router A"),
        redrawn.core().state.occupied((10, 10)).expect("router B"),
    );
    let cmd = draw_wire_cmd(&redrawn, a2, b2);
    redrawn.apply(cmd).expect("the wire is drawn again");
    assert_eq!(
        state_bytes(&session),
        state_bytes(&redrawn),
        "redo of an undone DrawWire leaves the SAME grid bytes a fresh redraw leaves"
    );
    assert_replay_reproduces_live(&session);
}

/// The `(from, to)` endpoints of the session's single live wire.
fn wire_endpoints(session: &GridSession) -> ((NodeId, u16), (NodeId, u16)) {
    let ids = wire_ids(session);
    assert_eq!(ids.len(), 1, "exactly one wire is live");
    match session.core().state.node(ids[0]) {
        Some(fabrico_core::state::Node::Wire(w)) => (w.from, w.to),
        other => panic!("the minted node must be a Node::Wire, got {other:?}"),
    }
}

#[test]
fn a_group_mixing_a_place_and_a_drawn_wire_undoes_both() {
    // A move is the only PUBLIC multi-record action, and it cannot carry a DrawWire,
    // so the mixed group is folded through `fold_live` — the seam the LIVE host drives,
    // and the ONLY seam that hands `capture_after_fold` more than one record at a time.
    let (mut session, a, b) = two_electrical_routers();
    let pre_nodes = node_count(&session);
    let pre_links = link_count(&session);

    let (wire, machine) = fold_wire_first_group(&mut session, a, b);
    assert_eq!(node_count(&session), pre_nodes + 2, "the group minted a wire AND a machine");
    assert_ne!(wire, machine, "the two minted ids are distinct");

    session.apply(GridCommand::Undo).expect("a mixed Place+DrawWire group is undoable");

    assert_eq!(node_count(&session), pre_nodes, "undo removed BOTH minted nodes");
    assert_eq!(link_count(&session), pre_links, "undo removed the wire's forward link too");
    assert!(session.core().state.node(wire).is_none(), "the wire is gone");
    assert!(session.core().state.node(machine).is_none(), "the machine is gone");
    // A byte comparison against the PRE-GROUP state is not available here for the
    // reason `state_bytes` records (freed slotmap slots and their bumped generations
    // survive in the serialization), so the log-replay oracle carries the byte weight:
    // the whole log, re-folded from genesis, reproduces the live core EXACTLY.
    assert_replay_reproduces_live(&session);
}

#[test]
fn a_drawwire_first_group_attributes_the_wire_id_to_the_drawwire() {
    // THE HARVEST-ORDER CASE (T-63-50). `capture_after_fold` walks the record slice
    // POSITIONALLY against `core.last_tick.placed`, stepping one slot per minting op.
    // With the DrawWire FIRST, the wire is `placed[0]` and the machine is `placed[1]`,
    // so a harvest that does not count `DrawWire` as a minting op hands `placed[0]` —
    // the WIRE — to the `Place`'s action.
    //
    // The assertion is by IDENTITY, not by count: it reads the emitted inverse group
    // and requires the `Delete` naming the wire to carry `machine_kind::WIRE` and the
    // `Delete` naming the machine to carry `machine_kind::SOURCE`. A count-only test
    // passes against the mis-attribution.
    let (mut session, a, b) = two_electrical_routers();
    let (wire, machine) = fold_wire_first_group(&mut session, a, b);

    let inverse = session
        .resolve_undo()
        .expect("a DrawWire-first mixed group resolves an inverse");
    assert!(
        matches!(inverse[0].op, EditOp::Undo { .. }),
        "the inverse group leads with the Undo lineage marker"
    );
    // Records invert in REVERSE order: the Place's Delete first, the wire's second.
    let deletes: Vec<(NodeId, u8)> = inverse
        .iter()
        .filter_map(|r| match &r.op {
            EditOp::Delete { node, kind, .. } => Some((*node, *kind)),
            _ => None,
        })
        .collect();
    assert_eq!(
        deletes,
        vec![(machine, machine_kind::SOURCE), (wire, machine_kind::WIRE)],
        "each minted id is attributed to the record that actually minted it"
    );

    session.apply(GridCommand::Undo).expect("the group undoes");
    assert!(session.core().state.node(wire).is_none(), "the wire was deleted");
    assert!(session.core().state.node(machine).is_none(), "the machine was deleted");
}

#[test]
fn a_forged_group_whose_minting_count_disagrees_is_still_malformed() {
    // The parity check is WIDENED to count the third minting op, not removed. A forged
    // log whose `DrawWire` names a node that is not live folds to a NO-OP (it mints
    // nothing) yet is still reconstructed as a normal undoable group — so its
    // minting-op count (1) disagrees with its minted-id count (0) and the group must
    // still be refused as a typed `Malformed` BEFORE any mutation (CR-01, T-63-19).
    let ghost = NodeId::default();
    let forged = vec![EditRecord {
        schema_version: EDIT_SCHEMA_VERSION,
        partition: 0,
        sequence: 0,
        tick: 0,
        action: 0,
        op: EditOp::DrawWire {
            from_node: ghost,
            from_port: 0,
            to_node: ghost,
            to_port: 0,
        },
    }];
    let session = GridSession::replay(SEED, &forged);
    assert_eq!(
        session.resolve_undo(),
        Err(CommandError::UndoDoesNotFit),
        "a DrawWire that minted nothing breaks parity and is refused, never a panic"
    );
}

#[test]
fn undo_of_a_drawn_wire_whose_target_is_dead_is_refused_not_destructive() {
    // The TARGET-IDENTITY GUARD on the DrawWire undo arm (T-63-20). It fires when the
    // id the group minted is no longer the wire it minted, which on a self-produced
    // log cannot happen — so the case is built the way the guard's own docblock says
    // it arrives: a FORGED/corrupted log loaded through the pub `replay` primitive.
    //
    // The forged log below drives the cursor back onto the DrawWire action with a
    // `Redo` marker group that re-applies NOTHING, after a separate group already
    // deleted the wire. The minted id is therefore dead when the undo resolves. The
    // OTHER half of the guard — a target that is live but is not a wire — is
    // structurally unreachable from any log: `NodeId` is a generational slotmap key,
    // so a freed slot never re-issues the same id to a different node. It can only
    // arrive through a misaligned `xlate`, which is the projection defect the guard
    // was added for in the first place, and the kind clause covers it identically.
    let mut b = LogBuilder::new(SEED);
    let placed = b.group(vec![place_source(0, 0)]);
    let source = placed[0];
    let minted = b.group(vec![EditOp::DrawWire {
        from_node: source,
        from_port: 0,
        to_node: source,
        to_port: 0,
    }]);
    let wire = minted[0];
    // An Undo-marker group that ALSO deletes the wire (the honest inverse shape).
    b.group(vec![
        EditOp::Undo { target_action: 1 },
        EditOp::Delete {
            node: wire,
            kind: machine_kind::WIRE,
            cell_x: 0,
            cell_y: 0,
            captured: DeletedSubgraph::default(),
        },
    ]);
    // A Redo-marker group that re-applies NOTHING — the forgery. It steps the cursor
    // back onto the DrawWire action while the wire stays dead.
    b.group(vec![EditOp::Redo { target_action: 1 }]);

    let session = GridSession::replay(SEED, &b.log);
    assert!(session.core().state.node(wire).is_none(), "the forged log left the wire dead");
    let before = state_bytes(&session);

    assert_eq!(
        session.resolve_undo(),
        Err(CommandError::UndoDoesNotFit),
        "an undo whose DrawWire target is no longer live is REFUSED by the guard, \
         never a Delete emitted against whatever else that id could name"
    );
    assert_eq!(state_bytes(&session), before, "the refusal mutated nothing (SC#2)");
}

// ============================================================================
// 63-06: undoing a delete that CASCADED a wire.
//
// Plan 63-03 left a typed `Malformed` refusal on this leg because the capture had
// nowhere to record a wire. `DeletedSubgraph.wires` is that place, and this is the
// test that says the refusal became a real restore.
// ============================================================================

/// A reference session that reached "machine deleted, then rebuilt with its wire" by
/// EXPLICIT commands rather than by undo - the allocator-faithful twin.
///
/// # Why the reference is a twin and not the pre-delete state
/// `GridState`'s first serialized field is the generational allocator, whose slot
/// vector carries FREED slots and their bumped generations. A delete frees two slots
/// and the restore re-mints into them, so the post-undo bytes can never equal the
/// pre-delete bytes - for a wire, for a belt, or for a bare `SOURCE`. Plans 63-03 and
/// 63-05 both measured this and both kept the byte comparison while changing the
/// REFERENCE, and this test does the same.
///
/// The twin mints exactly the same nodes in exactly the same order the undo group
/// does - one machine, then one wire - so the allocator histories are identical and
/// the comparison below is a genuine byte comparison, not a normalized one.
fn reference_delete_then_rebuild(x: i32, y: i32) -> GridSession {
    let (mut session, a, b) = two_electrical_routers();
    let cmd = draw_wire_cmd(&session, a, b);
    session.apply(cmd).expect("a legal wire is drawn");
    session
        .apply(GridCommand::Delete { node: handle_of(&session, a) })
        .expect("a live wired machine is deletable");
    let a2 = electrical_router(&mut session, x, y);
    let cmd = draw_wire_cmd(&session, a2, b);
    session.apply(cmd).expect("the rebuilt machine takes the same wire");
    session
}

#[test]
fn undo_of_a_delete_that_cascaded_a_wire_restores_the_wire() {
    let (mut session, a, b) = two_electrical_routers();
    let cmd = draw_wire_cmd(&session, a, b);
    session.apply(cmd).expect("a legal wire is drawn");
    let pre_delete_nodes = node_count(&session);
    let pre_delete_links = link_count(&session);
    assert_eq!(wire_ids(&session).len(), 1, "one wire before the delete");

    // Delete the wire's SOURCE machine - the direction a links-only cascade misses.
    session
        .apply(GridCommand::Delete { node: handle_of(&session, a) })
        .expect("a live wired machine is deletable");
    assert!(wire_ids(&session).is_empty(), "the delete cascaded the wire away");

    session
        .apply(GridCommand::Undo)
        .expect("a delete that cascaded a wire is undoable - not a typed refusal");

    assert_eq!(node_count(&session), pre_delete_nodes, "the machine AND its wire are back");
    assert_eq!(link_count(&session), pre_delete_links, "the wire's forward link is back");
    let wires = wire_ids(&session);
    assert_eq!(wires.len(), 1, "exactly one wire was restored");
    let ((from_node, from_port), (to_node, to_port)) = wire_endpoints(&session);
    assert_eq!(to_node, b, "the untouched endpoint is still the same live node");
    assert_eq!((from_port, to_port), (WIRE_OUT_PORT, WIRE_IN_PORT), "both ports survive");
    assert!(
        session.core().state.node(from_node).is_some(),
        "the restored wire's source names the RE-MINTED machine, live"
    );
    assert_eq!(
        session.core().state.link_target((wires[0], 0)),
        Some((b, WIRE_IN_PORT)),
        "the restored wire carries the same forward link the fold writes"
    );

    // The byte oracle: identical to the allocator-faithful twin that rebuilt the same
    // machine and redrew the same wire through explicit commands.
    assert_eq!(
        state_bytes(&session),
        state_bytes(&reference_delete_then_rebuild(0, 0)),
        "undo of a wire-cascading delete leaves the SAME grid bytes an explicit rebuild leaves"
    );
    assert_replay_reproduces_live(&session);
}

// ============================================================================
// Plan 74.1-23 (GAP N3-RACE): a marker moves exactly the action it names.
//
// The old build drained a Dock and a Ctrl+Z in one pass, so the Undo resolved against
// a projection that did not yet hold the Dock and named the PREVIOUS action (the second
// belt's DrawBelt). Both folded on one tick. `reconstruct_projection` then stepped the
// cursor back by one whatever the marker named, which moved the DOCK into the redo tail;
// every later Undo targeted the already-deleted belt's DrawBelt and was refused
// `Malformed`. These tests build that log, and its two Redo twins, by hand: each record
// is one the old build really produced (resolved by a `GridSession` against the stale
// state), stamped onto one tick the way the host stamps a drain pass.
// ============================================================================

/// Stamp `ops` as one action on `tick`, continuing `log`'s sequence and action counters.
fn stamp_group(log: &mut Vec<EditRecord>, tick: u64, ops: Vec<EditOp>) -> u64 {
    let action = log.iter().map(|r| r.action).max().map_or(0, |m| m + 1);
    for op in ops {
        let sequence = log.iter().map(|r| r.sequence).max().map_or(0, |m| m + 1);
        log.push(EditRecord {
            schema_version: EDIT_SCHEMA_VERSION,
            partition: 0,
            sequence,
            tick,
            action,
            op,
        });
    }
    action
}

/// The live node set, in `NodeId` order.
fn live_nodes(session: &GridSession) -> Vec<NodeId> {
    session.core().state.node_ids().collect()
}

/// The action the last `Undo` marker in the log names.
fn last_undo_target(session: &GridSession) -> Option<u64> {
    session.edit_log().iter().rev().find_map(|r| match r.op {
        EditOp::Undo { target_action } => Some(target_action),
        _ => None,
    })
}

/// Undo until the stack is empty. Every Undo must return `Ok` or `NothingToUndo`, never
/// `Malformed`, and an `Ok` may remove only the nodes `named[target]` lists.
fn undo_to_empty(session: &mut GridSession, named: &BTreeMap<u64, Vec<NodeId>>) -> usize {
    // Every pass before the one that answers `NothingToUndo` was an `Ok`, so the step
    // number at that pass is the count of accepted undos.
    for step in 0..16 {
        let before = live_nodes(session);
        match session.apply(GridCommand::Undo).map(|_| ()) {
            Ok(()) => {}
            Err(CommandError::NothingToUndo) => return step,
            Err(e) => panic!("undo {step} answered {e:?}: undo went dead"),
        }
        let target = last_undo_target(session).expect("an accepted undo logs its marker");
        let after = live_nodes(session);
        let allowed = named.get(&target).cloned().unwrap_or_default();
        for id in before.iter().filter(|id| !after.contains(id)) {
            assert!(
                allowed.contains(id),
                "undo {step} (target {target}) removed {id:?}, a node its target does not name"
            );
        }
    }
    panic!("the undo stack never emptied");
}

/// THE WALK'S LOG (seq 73 Dock, 74 Undo{target 53}, 75 Delete, one tick), replayed: the
/// Undos that follow each return `Ok` or `NothingToUndo`, never `Malformed`, and none
/// deletes a node its own target does not name.
#[test]
fn an_old_build_same_tick_undo_after_a_join_leaves_undo_alive_after_replay() {
    let belt_a = vec![(5, 9), (5, 8), (5, 7), (5, 6)];
    let belt_b = vec![(6, 6), (7, 6), (8, 6)];

    // The stale session: both belts drawn, the Dock not yet folded.
    let mut stale = GridSession::new(SEED);
    draw(&mut stale, belt_a.clone());
    let a = *stale.core().last_tick.placed.last().expect("belt A");
    draw(&mut stale, belt_b.clone());
    let b = *stale.core().last_tick.placed.last().expect("belt B");
    let a_action = stale.edit_log()[0].action;
    let b_action = stale.edit_log()[1].action;
    let stale_undo: Vec<EditOp> =
        stale.resolve_undo().expect("B's draw is undoable").into_iter().map(|r| r.op).collect();
    assert!(
        matches!(stale_undo[0], EditOp::Undo { target_action } if target_action == b_action),
        "against the stale projection the Undo names B's draw (the walk's Undo{{target 53}})"
    );

    // The Dock record, resolved by the same commands on a twin session.
    let mut twin = GridSession::new(SEED);
    let ta = draw(&mut twin, belt_a);
    let tb = draw(&mut twin, belt_b);
    let dock_op = twin
        .apply(GridCommand::Dock { belt: ta, endpoint: fabrico_protocol::BeltEnd::Head, node: tb, port: 0 })
        .expect("the N3 join is accepted")
        .op
        .clone();

    // The old build's log: the Dock and the stale Undo group on ONE tick.
    let mut log = stale.edit_log().to_vec();
    let tick = log.last().expect("two draws").tick + 1;
    let dock_action = stamp_group(&mut log, tick, vec![dock_op]);
    stamp_group(&mut log, tick, stale_undo);

    let mut replayed = GridSession::replay(SEED, &log);
    assert!(replayed.core().state.node(b).is_none(), "the old build deleted belt B");
    assert!(replayed.core().state.node(a).is_some(), "and left belt A");

    let named: BTreeMap<u64, Vec<NodeId>> =
        [(a_action, vec![a]), (b_action, vec![b]), (dock_action, Vec::new())].into();
    let oks = undo_to_empty(&mut replayed, &named);
    assert_eq!(oks, 2, "two live actions remain to undo: the join and belt A's draw");
    assert!(replayed.core().state.node(a).is_none(), "belt A's draw was undone last");
}

/// A Redo marker naming an action that is NOT the next one (the redo twin of the race).
/// The projection moves that action to the boundary, so the next Undo targets the node
/// the Redo actually re-placed, and it is `Ok`.
#[test]
fn a_redo_marker_naming_an_action_that_is_not_next_projects_a_working_undo() {
    // The stale session: P1 and P2 placed, P2 undone. Its redo names P2.
    let mut stale = GridSession::new(SEED);
    place(&mut stale, machine_kind::SOURCE, 0, 0);
    place(&mut stale, machine_kind::SOURCE, 3, 0);
    stale.apply(GridCommand::Undo).expect("undo P2");
    let stale_redo: Vec<EditOp> =
        stale.resolve_redo().expect("P2 is redoable").into_iter().map(|r| r.op).collect();

    // The log the redo lands on: P1 undone as well, so P1 is next and P2 is not.
    stale.apply(GridCommand::Undo).expect("undo P1");
    let mut log = stale.edit_log().to_vec();
    let tick = log.last().expect("four records").tick + 1;
    stamp_group(&mut log, tick, stale_redo);

    let mut replayed = GridSession::replay(SEED, &log);
    assert!(occupied(&replayed, (3, 0)), "the redo re-placed P2");
    assert!(!occupied(&replayed, (0, 0)), "P1 stays undone");
    replayed.apply(GridCommand::Undo).map(|_| ()).expect("the next undo works");
    assert!(!occupied(&replayed, (3, 0)), "the next undo takes back the P2 the redo placed");
    assert_eq!(node_count(&replayed), 0, "and nothing else was on the board");
}

/// A Redo marker naming an action a same-tick forward edit CUT from the stack: the
/// forward edit folded first and truncated the redo tail, then the Redo re-applied the
/// action anyway. The projection pushes it on top as live, so the next Undo takes back
/// the node the Redo placed, and the one after takes back the forward edit.
#[test]
fn a_redo_marker_naming_an_action_a_same_tick_edit_cut_projects_a_working_undo() {
    let mut stale = GridSession::new(SEED);
    place(&mut stale, machine_kind::SOURCE, 0, 0);
    stale.apply(GridCommand::Undo).expect("undo P1");
    let stale_redo: Vec<EditOp> =
        stale.resolve_redo().expect("P1 is redoable").into_iter().map(|r| r.op).collect();

    // The forward edit, resolved against the same state on a twin.
    let mut twin = GridSession::new(SEED);
    place(&mut twin, machine_kind::SOURCE, 0, 0);
    twin.apply(GridCommand::Undo).expect("undo P1 on the twin");
    let forward = twin
        .apply(GridCommand::Place { kind: machine_kind::SOURCE, cell_x: 5, cell_y: 0 })
        .expect("place P3")
        .op
        .clone();

    let mut log = stale.edit_log().to_vec();
    let tick = log.last().expect("two records").tick + 1;
    stamp_group(&mut log, tick, vec![forward]);
    stamp_group(&mut log, tick, stale_redo);

    let mut replayed = GridSession::replay(SEED, &log);
    assert!(occupied(&replayed, (0, 0)) && occupied(&replayed, (5, 0)), "P1 and P3 stand");
    replayed.apply(GridCommand::Undo).map(|_| ()).expect("the next undo works");
    assert!(!occupied(&replayed, (0, 0)), "the next undo takes back the P1 the redo placed");
    assert!(occupied(&replayed, (5, 0)), "and leaves P3");
    replayed.apply(GridCommand::Undo).map(|_| ()).expect("the one after works too");
    assert!(!occupied(&replayed, (5, 0)), "then P3 is taken back");
    assert_eq!(
        replayed.apply(GridCommand::Undo).map(|_| ()),
        Err(CommandError::NothingToUndo),
        "and the stack is empty"
    );
}

// Phase 85-05 (D-10) — the history seal is a logged no-op the projection never stacks.

/// `log` with one `EditOp::SealHistory` record appended one tick after its last record,
/// under a fresh action, exactly as the host writes it after seeding a scene.
fn with_seal_appended(log: &[EditRecord]) -> Vec<EditRecord> {
    let last = log.last().expect("a non-empty log to seal");
    let next_action = log.iter().map(|r| r.action).max().unwrap_or(0) + 1;
    let mut sealed = log.to_vec();
    sealed.push(EditRecord {
        schema_version: EDIT_SCHEMA_VERSION,
        partition: last.partition,
        sequence: last.sequence + 1,
        tick: last.tick + 1,
        action: next_action,
        op: EditOp::SealHistory,
    });
    sealed
}

#[test]
fn a_seal_history_record_is_never_an_undo_target() {
    // A board with two placements and one of them undone, so the log carries both a live
    // action and a redo tail: the seal must neither become an undoable action nor cut
    // that tail (Pitfall 2: without the projection's explicit arm it would fall into the
    // normal-group arm, push itself, and truncate the redo tail).
    let mut session = GridSession::new(SEED);
    place(&mut session, machine_kind::SOURCE, 0, 0);
    place(&mut session, machine_kind::SOURCE, 4, 0);
    session.apply(GridCommand::Undo).expect("undo the second place");
    let unsealed = GridSession::replay(SEED, session.edit_log());
    assert_eq!(unsealed.undoable_stack().len(), 2, "non-vacuity: two actions are stacked");
    assert_eq!(unsealed.redo_cursor(), 1, "non-vacuity: one is undone, so there is a redo tail");

    let sealed = GridSession::replay(SEED, &with_seal_appended(session.edit_log()));
    assert!(
        matches!(sealed.edit_log().last().map(|r| &r.op), Some(EditOp::SealHistory)),
        "the replayed log really ends in the seal"
    );
    assert_eq!(
        sealed.undoable_stack(),
        unsealed.undoable_stack(),
        "the seal never joins the undoable stack"
    );
    assert_eq!(
        sealed.redo_cursor(),
        unsealed.redo_cursor(),
        "the seal neither advances the cursor nor truncates the redo tail"
    );
    // Plan 85-06 (D-10) re-points this one line. Until 85-06 the seal was a pure no-op and
    // the line read `sealed.can_undo() == unsealed.can_undo()`; the seal IS the undo floor
    // now, so the one live action under it is no longer undoable, while the redo tail the
    // seal must not cut stays redoable. The stack and cursor checks above are unchanged.
    assert!(unsealed.can_undo(), "non-vacuity: the unsealed log has an undoable action");
    assert!(!sealed.can_undo(), "the seal is the undo floor: nothing under it is undoable");
    assert_eq!(sealed.can_redo(), unsealed.can_redo(), "Redo availability is unchanged by the seal");
    assert_eq!(
        postcard::to_allocvec(&sealed.core().state).expect("serialize sealed grid"),
        postcard::to_allocvec(&unsealed.core().state).expect("serialize unsealed grid"),
        "and the seal changes no grid byte"
    );
}

// Phase 85-06 (D-10, DEMO-05) — the seal is the undo floor, and the floor is a pure function
// of the log.

/// Two seals in a row, then a third with a live action between: the floor is the cursor at
/// the LAST seal, and a fresh fold of the log agrees (the DEMO-05 idempotency edge).
#[test]
fn two_seals_leave_the_floor_at_the_last_one_and_the_refold_agrees() {
    let mut session = GridSession::new(SEED);
    place(&mut session, machine_kind::SOURCE, 0, 0);
    session.seal_history().expect("first seal");
    session.seal_history().expect("a second seal straight after");
    assert_eq!(session.undo_floor(), 1, "two seals in a row: the floor is the cursor at the last");
    assert!(!session.can_undo(), "nothing under the floor is undoable");
    assert_projection_equals_fold(&session, SEED);

    place(&mut session, machine_kind::SOURCE, 4, 0);
    session.seal_history().expect("a seal after a later action");
    assert_eq!(session.undo_floor(), 2, "the floor moves up to the last seal");
    assert!(!session.can_undo(), "and the later action is under it too");
    assert_eq!(
        session.apply(GridCommand::Undo).err(),
        Some(CommandError::NothingToUndo),
        "Undo at the floor is refused"
    );
    assert_projection_equals_fold(&session, SEED);
    assert!(!session.undo_floor_breached(), "a log this build writes never breaches its floor");
}

/// Undo and redo above the floor, with the floor compared to a fresh fold after each step:
/// an undo stops at the floor and a redo above it climbs back, and the refold agrees.
#[test]
fn undo_and_redo_above_the_floor_stop_at_the_floor_and_the_refold_agrees() {
    let mut session = GridSession::new(SEED);
    place(&mut session, machine_kind::SOURCE, 0, 0);
    session.seal_history().expect("seal the scene");
    place(&mut session, machine_kind::SOURCE, 4, 0);
    place(&mut session, machine_kind::SOURCE, 8, 0);
    assert_projection_equals_fold(&session, SEED);
    session.apply(GridCommand::Undo).expect("undo the second user place");
    session.apply(GridCommand::Undo).expect("undo the first user place");
    assert_projection_equals_fold(&session, SEED);
    assert!(!session.can_undo(), "two undos reach the floor");
    assert!(occupied(&session, (0, 0)), "the scene's own place survives every undo");
    assert_eq!(
        session.apply(GridCommand::Undo).err(),
        Some(CommandError::NothingToUndo),
        "a third undo is refused at the floor"
    );
    session.apply(GridCommand::Redo).expect("redo above the floor");
    assert!(session.can_undo(), "a redone user edit is undoable again");
    assert_projection_equals_fold(&session, SEED);
}
