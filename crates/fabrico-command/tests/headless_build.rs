//! The headless build-a-grid integration suite (SC#1 / SC#2 / ELOG-02).
//!
//! A Rust program builds a grid end-to-end through [`GridSession::apply`] with NO
//! renderer and NO host present (SC#1/CMD-01), an invalid command leaves the grid
//! byte-identical (SC#2/CMD-02), and the session's edit-log replays from genesis to
//! a byte-identical `Core` with no re-validation (ELOG-02/CMD-05).

use fabrico_command::{CommandError, GridSession};
use fabrico_core::core::Core;
use fabrico_core::event::{LogHeader, SCHEMA_VERSION};
use fabrico_core::snapshot::snapshot;
use fabrico_core::state::Node;
use fabrico_protocol::{BeltEnd, GridCommand, machine_kind};

const SEED: u64 = 0xFAB_C0DE;

/// Place a SOURCE, place a SINK, then DrawBelt + Dock both ends (source Out -> belt ->
/// sink In; the post-Wire model): the DrawBelt mints a belt, so the grid ends with 3
/// nodes (source + sink + belt). The edit-log holds 5 RESOLVED records with monotonic
/// sequence + per-command action ids, and the core reflects the folded topology.
#[test]
fn headless_build() {
    let mut session = GridSession::new(SEED);

    let src_handle = {
        let rec = session
            .apply(GridCommand::Place {
                kind: machine_kind::SOURCE,
                cell_x: 0,
                cell_y: 0,
            })
            .expect("placing a source is accepted");
        assert_eq!(rec.sequence, 0, "first record sequence is 0");
        assert_eq!(rec.action, 0, "first command action is 0");
        assert_eq!(rec.tick, 0, "first record is stamped at tick 0");
        // Resolve the source's dense handle from the view for the wire below.
        let id = *session.core().last_tick.placed.last().expect("source minted");
        session.view().handle_of(id).expect("source got a handle")
    };

    let sink_handle = {
        let rec = session
            .apply(GridCommand::Place {
                kind: machine_kind::SINK,
                cell_x: 2,
                cell_y: 0,
            })
            .expect("placing a sink is accepted");
        assert_eq!(rec.sequence, 1, "second record sequence is 1 (monotonic)");
        assert_eq!(rec.action, 1, "second command action is 1 (monotonic)");
        assert_eq!(rec.tick, 1, "second record is stamped at tick 1");
        let id = *session.core().last_tick.placed.last().expect("sink minted");
        session.view().handle_of(id).expect("sink got a handle")
    };

    // Draw a belt at (1,0) — the source Out (world (0,0) faces E) and the sink In (world
    // (2,0) faces W) share the facing cell (1,0), so a single-tile belt docks both ends.
    let drawbelt_rec = session
        .apply(GridCommand::DrawBelt { cells: vec![(1, 0)] })
        .expect("a drawn belt is accepted");
    assert_eq!(drawbelt_rec.sequence, 2, "third record sequence is 2");
    assert_eq!(drawbelt_rec.action, 2, "third command action is 2");
    assert_eq!(drawbelt_rec.tick, 2, "third record is stamped at tick 2");
    // The DrawBelt minted exactly one belt this tick — capture it BEFORE the docks (a
    // Dock pushes no `placed` entry).
    let belt = *session
        .core()
        .last_tick
        .placed
        .last()
        .expect("the DrawBelt minted a belt");
    let belt_handle = session.view().handle_of(belt).expect("belt got a handle");
    assert!(
        matches!(session.core().state.node(belt), Some(Node::Belt(_))),
        "the DrawBelt minted a belt node"
    );

    // Dock the belt Tail to the source Out and the Head to the sink In (post-Wire model).
    let dock_tail_rec = session
        .apply(GridCommand::Dock { belt: belt_handle, endpoint: BeltEnd::Tail, node: src_handle, port: 0 })
        .expect("the Tail OFFLOAD dock is accepted");
    assert_eq!(dock_tail_rec.sequence, 3, "fourth record sequence is 3");
    assert_eq!(dock_tail_rec.tick, 3, "fourth record is stamped at tick 3");
    let dock_head_rec = session
        .apply(GridCommand::Dock { belt: belt_handle, endpoint: BeltEnd::Head, node: sink_handle, port: 0 })
        .expect("the Head LOAD dock is accepted");
    assert_eq!(dock_head_rec.sequence, 4, "fifth record sequence is 4");
    assert_eq!(dock_head_rec.tick, 4, "fifth record is stamped at tick 4");

    // The grid has 3 nodes: source + sink + the drawn belt (docks add links, not nodes).
    assert_eq!(
        session.core().state.node_count(),
        3,
        "place + place + drawbelt builds a 3-node grid (the DrawBelt mints a belt)"
    );

    // The edit-log holds the 5 RESOLVED records in order.
    let log = session.edit_log();
    assert_eq!(log.len(), 5, "five commands -> five logged records");
    let seqs: Vec<u64> = log.iter().map(|r| r.sequence).collect();
    assert_eq!(seqs, vec![0, 1, 2, 3, 4], "sequences are monotonic");
    let ticks: Vec<u64> = log.iter().map(|r| r.tick).collect();
    assert_eq!(ticks, vec![0, 1, 2, 3, 4], "each apply is its own tick (W3)");
}

/// An invalid command (a Place onto an occupied cell) returns a typed error and
/// leaves the core snapshot AND the edit-log byte-identical to before the attempt
/// (SC#2): nothing produced, nothing folded.
#[test]
fn invalid_command_state_unchanged() {
    let mut session = GridSession::new(SEED);
    session
        .apply(GridCommand::Place {
            kind: machine_kind::SOURCE,
            cell_x: 4,
            cell_y: 4,
        })
        .expect("the first place is accepted");

    // Snapshot the core + the edit-log BEFORE the invalid attempt.
    let core_before = snapshot(session.core());
    let log_before = session.edit_log().to_vec();

    // A second place onto the now-occupied (4, 4) is rejected.
    let result = session.apply(GridCommand::Place {
        kind: machine_kind::SOURCE,
        cell_x: 4,
        cell_y: 4,
    });
    assert_eq!(
        result,
        Err(CommandError::FootprintCollision),
        "occupied place rejected"
    );

    // The core snapshot and the edit-log are byte-identical (nothing changed).
    assert_eq!(
        snapshot(session.core()),
        core_before,
        "a rejected command leaves the Core snapshot byte-identical (SC#2)"
    );
    assert_eq!(
        session.edit_log(),
        log_before.as_slice(),
        "a rejected command appends nothing to the edit-log (SC#2)"
    );
}

/// Replaying the session's edit-log from a fresh genesis `Core` via
/// `run_log_two_logs` reproduces a byte-identical `Core` (ELOG-02): replay applies
/// the frozen RESOLVED records with NO re-validation, and the stamped ticks regroup
/// identically (no tick divergence — W3).
#[test]
fn edit_log_replays_byte_identical() {
    let mut session = GridSession::new(SEED);
    let src = session_place(&mut session, machine_kind::SOURCE, 0, 0);
    let sink = session_place(&mut session, machine_kind::SINK, 3, 0);
    // source@(0,0) Out (facing (1,0)) -> belt (1,0)-(2,0) -> sink@(3,0) In (facing (2,0)).
    session
        .apply(GridCommand::DrawBelt { cells: vec![(1, 0), (2, 0)] })
        .expect("drawbelt accepted");
    let belt = *session.core().last_tick.placed.last().expect("belt minted");
    let belt_h = session.view().handle_of(belt).expect("belt handle");
    session
        .apply(GridCommand::Dock { belt: belt_h, endpoint: BeltEnd::Tail, node: src, port: 0 })
        .expect("tail dock accepted");
    session
        .apply(GridCommand::Dock { belt: belt_h, endpoint: BeltEnd::Head, node: sink, port: 0 })
        .expect("head dock accepted");
    // A second source + a delete of the first, to exercise every EditOp on replay.
    let extra = session_place(&mut session, machine_kind::FACTORY, 5, 0);
    session
        .apply(GridCommand::Delete { node: extra })
        .expect("delete accepted");

    // Replay the edit-log from a fresh genesis Core (NO re-validation — the records
    // are applied verbatim by the fold).
    let mut replay = Core::genesis(LogHeader {
        schema_version: SCHEMA_VERSION,
        seed: SEED,
    });
    replay.run_log_two_logs(session.edit_log(), &[]).expect("replay within MAX_REPLAY_SPAN");

    assert_eq!(
        snapshot(&replay),
        snapshot(session.core()),
        "replaying the edit-log from genesis reproduces a byte-identical Core (ELOG-02)"
    );
}

/// SC#4 (SPAT-01): the headless `fabrico-command` layer reconstructs FULL grid
/// topology INCLUDING the spatial layout (cells + occupancy) from the command log
/// alone — with NO host and NO sidecar present. Build a sub-graph via `GridCommand`s,
/// then assert `cell_of`/`occupied` directly on `core.state` (the single spatial
/// authority since 09-02), prove a same-cell placement is rejected, and prove the
/// whole spatial layout survives a snapshot -> restore round-trip from the log alone.
#[test]
fn headless_reconstructs_spatial_topology_from_log() {
    let mut session = GridSession::new(SEED);

    // Place three machines at DISTINCT cells (collinear on row 1 so the chain docks with
    // straight belts), capturing each minted NodeId + cell. The FACTORY is a 3×3
    // multi-cell occupant anchored at (3,0) — body (3,0)..=(5,2), In world (3,1) faces W,
    // Out (port 1) world (5,1) faces E.
    let placements = [
        (machine_kind::SOURCE, (0, 1)),
        (machine_kind::FACTORY, (3, 0)),
        (machine_kind::SINK, (9, 1)),
    ];
    let mut placed: Vec<(fabrico_core::ids::NodeId, (i32, i32))> = Vec::new();
    for (kind, (cell_x, cell_y)) in placements {
        session
            .apply(GridCommand::Place { kind, cell_x, cell_y })
            .expect("placing at a free cell is accepted");
        let id = *session.core().last_tick.placed.last().expect("node minted");
        placed.push((id, (cell_x, cell_y)));
    }

    // Chain source -> factory -> sink via DrawBelt + Dock (post-Wire model; each drawn
    // belt carries no cell). source Out -> factory In, then factory Out -> sink In.
    let handle = |session: &GridSession, id| session.view().handle_of(id).expect("handle");
    let src = handle(&session, placed[0].0);
    let fac = handle(&session, placed[1].0);
    let snk = handle(&session, placed[2].0);
    // source@(0,1) Out (facing (1,1)) -> belt (1,1)-(2,1) -> factory In (world (3,1) faces W, facing (2,1)).
    {
        session
            .apply(GridCommand::DrawBelt { cells: vec![(1, 1), (2, 1)] })
            .expect("source -> factory belt accepted");
        let belt = *session.core().last_tick.placed.last().expect("belt minted");
        let belt_h = handle(&session, belt);
        session
            .apply(GridCommand::Dock { belt: belt_h, endpoint: BeltEnd::Tail, node: src, port: 0 })
            .expect("dock belt Tail to the source Out");
        session
            .apply(GridCommand::Dock { belt: belt_h, endpoint: BeltEnd::Head, node: fac, port: 0 })
            .expect("dock belt Head to the factory In");
    }
    // factory Out port 1 (world (5,1) faces E, facing (6,1)) -> belt (6,1)-(8,1) -> sink@(9,1) In (facing (8,1)).
    {
        session
            .apply(GridCommand::DrawBelt { cells: vec![(6, 1), (7, 1), (8, 1)] })
            .expect("factory -> sink belt accepted");
        let belt = *session.core().last_tick.placed.last().expect("belt minted");
        let belt_h = handle(&session, belt);
        session
            .apply(GridCommand::Dock { belt: belt_h, endpoint: BeltEnd::Tail, node: fac, port: 1 })
            .expect("dock belt Tail to the factory Out");
        session
            .apply(GridCommand::Dock { belt: belt_h, endpoint: BeltEnd::Head, node: snk, port: 0 })
            .expect("dock belt Head to the sink In");
    }

    // (1) The spatial layout reconstructs from the log alone — no host, no sidecar.
    //     Every placed machine's cell is in core.state; each occupied cell maps back
    //     to its node; a free cell is unoccupied.
    for (id, cell) in &placed {
        assert_eq!(
            session.core().state.cell_of(*id),
            Some(*cell),
            "cell_of reconstructs the placed machine's cell from the log"
        );
        assert_eq!(
            session.core().state.occupied(*cell),
            Some(*id),
            "occupied maps the cell back to its placing node"
        );
    }
    assert_eq!(
        session.core().state.occupied((99, 99)),
        None,
        "a never-placed cell is unoccupied"
    );
    // Belts (drawn) carry no cell (W1).
    for id in session.core().state.node_ids() {
        if matches!(session.core().state.node(id), Some(Node::Belt(_))) {
            assert_eq!(
                session.core().state.cell_of(id),
                None,
                "a drawn belt carries no spatial cell (W1)"
            );
        }
    }

    // (2) Occupancy is enforced from core: a same-cell placement is rejected, and the
    //     rejection changes nothing (the headless reproject-per-command invariant).
    let occupied_cell = placed[1].1; // the factory's cell
    let core_before = snapshot(session.core());
    let result = session.apply(GridCommand::Place {
        kind: machine_kind::SOURCE,
        cell_x: occupied_cell.0,
        cell_y: occupied_cell.1,
    });
    assert_eq!(
        result,
        Err(CommandError::FootprintCollision),
        "same-cell place rejected"
    );
    assert_eq!(
        snapshot(session.core()),
        core_before,
        "a rejected same-cell place leaves the Core byte-identical"
    );

    // (3) The full spatial topology survives a snapshot -> restore round-trip rebuilt
    //     from the log: restore the snapshot into a fresh Core and re-assert cells +
    //     occupancy (the derived occupancy index rebuilds on restore, 09-02).
    let restored = fabrico_core::snapshot::restore(&snapshot(session.core()))
        .expect("the headless-built snapshot restores");
    for (id, cell) in &placed {
        assert_eq!(
            restored.state.cell_of(*id),
            Some(*cell),
            "cell_of survives snapshot/restore (spatial layout rides the snapshot)"
        );
        assert_eq!(
            restored.state.occupied(*cell),
            Some(*id),
            "occupied rebuilds on restore (the reverse index is reconstructed)"
        );
    }
}

/// Apply a Place and return the minted node's dense handle (test helper).
fn session_place(session: &mut GridSession, kind: u8, cell_x: i32, cell_y: i32) -> u64 {
    session
        .apply(GridCommand::Place {
            kind,
            cell_x,
            cell_y,
        })
        .expect("place accepted");
    let id = *session.core().last_tick.placed.last().expect("node minted");
    session.view().handle_of(id).expect("minted node got a handle")
}
