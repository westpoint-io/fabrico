//! A saved file opens again, to the board it was saved with (phase 86, plan 86-06, a
//! deviation outside the plan's file list with the reason "phase goal: a saved file loads
//! to an editable board").
//!
//! THE DEFECT THIS FILE PINS. Open any `.fab`, let it run one tick with no edits, save,
//! open the saved file: before the fix the open was refused `HeadTickMismatch` ("head_tick
//! N disagrees with the replayed tick M"). Opening a file stores its snapshot as the host's
//! restart point, and `save_project` reused the latest stored restart point as the file's
//! base. A load replays from that base only to one tick past the last logged record, so a
//! board that had run on past its last record named a head tick the replay never reaches.
//! The same shape held for a host that snapshots on a cadence and runs past its last
//! snapshot with nothing logged. A new board never met it: it has no stored restart point,
//! so the save fell back to the head snapshot.
//!
//! WHAT EACH LEG GRADES, from the user's side: the file opens (no refusal card), the
//! opened board is byte for byte the board that was saved (its snapshot, both logs, Undo
//! and Redo availability), and it is editable (its Undo takes back the last edit).
//!
//! RED BEFORE THE FIX (a throwaway worktree at the plan's start revision): the two opened-board legs and the cadence leg FAILED
//! with `HeadTickMismatch`; the new-board leg passed, as it must.
//!
//! Run target: `cargo test -p fabrico-host --test saved_file_reopens`

// `fabrico-host` is the sanctioned I/O home (see `project.rs`); these tests write and read
// real project files, which is the whole point of the file.
#![allow(clippy::disallowed_methods)]

use std::path::Path;

use fabrico_core::command::{Command, ResultEvent};
use fabrico_core::core::Core;
use fabrico_core::event::{EventPayload, LogHeader, SCHEMA_VERSION};
use fabrico_core::persist::RedbStore;
use fabrico_host::driver::Host;
use fabrico_host::input_apply::apply_gesture;
use fabrico_host::ledger::DispatchLedger;
use fabrico_host::project::{load_project, save_project};
use fabrico_protocol::{GridCommand, machine_kind};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};

/// The genesis seed of every board here.
const SEED: u64 = 0x8606_5A7E;

/// How many idle ticks each board runs before it is saved: many more than one, so the
/// saved head tick sits well past the last logged record.
const IDLE_TICKS: u32 = 30;

/// A host plus the channel triple `tick_once` requires, and the dir its stores live in.
struct Rig {
    host: Host,
    ingress_rx: UnboundedReceiver<EventPayload>,
    results_rx: UnboundedReceiver<ResultEvent>,
    cmd_tx: UnboundedSender<Command>,
    _ingress_tx: UnboundedSender<EventPayload>,
    _res_tx: UnboundedSender<ResultEvent>,
    _cmd_rx: UnboundedReceiver<Command>,
    _dir: tempfile::TempDir,
}

fn rig_over(host: Host, dir: tempfile::TempDir) -> Rig {
    let (ingress_tx, ingress_rx) = unbounded_channel::<EventPayload>();
    let (cmd_tx, cmd_rx) = unbounded_channel::<Command>();
    let (res_tx, results_rx) = unbounded_channel::<ResultEvent>();
    Rig {
        host,
        ingress_rx,
        results_rx,
        cmd_tx,
        _ingress_tx: ingress_tx,
        _res_tx: res_tx,
        _cmd_rx: cmd_rx,
        _dir: dir,
    }
}

/// A new, empty board over fresh temp stores, snapshotting every `snapshot_every` ticks
/// when given (the shipped app passes `None`).
fn new_board(snapshot_every: Option<u64>) -> Rig {
    let dir = tempfile::tempdir().expect("tempdir");
    let core = Core::genesis(LogHeader {
        schema_version: SCHEMA_VERSION,
        seed: SEED,
    });
    let store = RedbStore::open(dir.path().join("log.redb")).expect("open log");
    let ledger = DispatchLedger::open(dir.path().join("ledger.redb")).expect("open ledger");
    let host = Host::new(core, store, ledger, snapshot_every).expect("open host");
    rig_over(host, dir)
}

fn fold(rig: &mut Rig) {
    rig.host
        .tick_once(&mut rig.ingress_rx, &mut rig.results_rx, &rig.cmd_tx)
        .expect("tick_once persists and folds");
}

fn run_idle(rig: &mut Rig) {
    for _ in 0..IDLE_TICKS {
        fold(rig);
    }
}

/// A user's Place through the shipped gesture path, then one folded tick.
fn place(rig: &mut Rig, kind: u8, at: (i32, i32)) {
    let verdict = apply_gesture(
        &mut rig.host,
        GridCommand::Place {
            kind,
            cell_x: at.0,
            cell_y: at.1,
        },
        |_| None,
    );
    assert_eq!(
        verdict,
        Ok(()),
        "measured: a Place on empty floor at {at:?} is accepted"
    );
    fold(rig);
}

/// The user's Open: `load_project` into a fresh work dir, as the toolbar's Open does.
fn open(path: &Path) -> Result<Rig, String> {
    let work = tempfile::tempdir().expect("load work dir");
    match load_project(path, work.path(), None) {
        Ok(host) => Ok(rig_over(host, work)),
        Err(e) => Err(format!("{e:?}")),
    }
}

/// A board with two machines on it, saved once and opened again: the file a user has.
fn an_opened_board(dir: &Path) -> Rig {
    let mut rig = new_board(None);
    place(&mut rig, machine_kind::FACTORY, (20, 20));
    place(&mut rig, machine_kind::SOURCE, (24, 20));
    let first = dir.join("first.fab");
    save_project(&rig.host, &first).expect("the new board saves");
    match open(&first) {
        Ok(r) => r,
        Err(e) => panic!("measured: a file saved straight from a new board opens, got {e}"),
    }
}

/// What the user can see of a board, as text: its snapshot bytes, both logs, Undo and Redo.
fn board_of(host: &Host) -> (Vec<u8>, String, String, bool, bool) {
    (
        host.snapshot_bytes(),
        format!("{:?}", host.logged_events().expect("read the event log")),
        format!("{:?}", host.logged_edits().expect("read the edit log")),
        host.can_undo(),
        host.can_redo(),
    )
}

/// SAVE the board, OPEN the saved file, and grade it: it opens, it is the board that was
/// saved, and its Undo takes back the last edit. One fact list, so a red names every part.
fn save_reopen_facts(rig: &Rig, dir: &Path) -> Vec<(&'static str, String)> {
    let saved = board_of(&rig.host);
    let fab = dir.join("saved.fab");
    let save = save_project(&rig.host, &fab).map_err(|e| format!("{e:?}"));
    let mut facts = vec![("save", format!("{:?}", save.as_ref().map(|_| ())))];
    match open(&fab) {
        Err(e) => facts.push(("reopen", format!("Err({e})"))),
        Ok(mut back) => {
            facts.push(("reopen", "Ok".to_owned()));
            let got = board_of(&back.host);
            facts.push((
                "same_tick",
                (back.host.core().tick == rig.host.core().tick).to_string(),
            ));
            facts.push(("same_snapshot", (got.0 == saved.0).to_string()));
            facts.push(("same_events", (got.1 == saved.1).to_string()));
            facts.push(("same_edits", (got.2 == saved.2).to_string()));
            facts.push((
                "same_undo_redo",
                ((got.3, got.4) == (saved.3, saved.4)).to_string(),
            ));
            let undo = apply_gesture(&mut back.host, GridCommand::Undo, |_| None);
            fold(&mut back);
            facts.push(("undo_after_reopen", format!("{undo:?}")));
        }
    }
    for (k, v) in &facts {
        eprintln!("saved_file_reopens {k} = {v}");
    }
    facts
}

fn reopens() -> Vec<(&'static str, String)> {
    vec![
        ("save", "Ok(())".to_owned()),
        ("reopen", "Ok".to_owned()),
        ("same_tick", "true".to_owned()),
        ("same_snapshot", "true".to_owned()),
        ("same_events", "true".to_owned()),
        ("same_edits", "true".to_owned()),
        ("same_undo_redo", "true".to_owned()),
        ("undo_after_reopen", "Ok(())".to_owned()),
    ]
}

/// OPEN, RUN, SAVE, OPEN: the reported defect. An opened board that only ran, with no
/// edit, saves a file that opens to the same board.
#[test]
fn an_opened_board_that_ran_with_no_edits_saves_a_file_that_reopens() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut rig = an_opened_board(dir.path());
    run_idle(&mut rig);
    assert_eq!(
        save_reopen_facts(&rig, dir.path()),
        reopens(),
        "the saved file reopens"
    );
}

/// OPEN, EDIT, RUN, SAVE, OPEN. An edit after the open, then running on past it.
#[test]
fn an_opened_board_edited_then_run_saves_a_file_that_reopens() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut rig = an_opened_board(dir.path());
    place(&mut rig, machine_kind::SOURCE, (30, 20));
    run_idle(&mut rig);
    assert_eq!(
        save_reopen_facts(&rig, dir.path()),
        reopens(),
        "the saved file reopens"
    );
}

/// NEW, RUN, SAVE, OPEN. A new board never stored a restart point, so it already
/// reopened before the fix; this leg proves the fix did not move it.
#[test]
fn a_new_board_that_ran_saves_a_file_that_reopens() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut rig = new_board(None);
    place(&mut rig, machine_kind::FACTORY, (20, 20));
    run_idle(&mut rig);
    assert_eq!(
        save_reopen_facts(&rig, dir.path()),
        reopens(),
        "the saved file reopens"
    );
}

/// A host snapshotting every 5 ticks, run past its last snapshot with nothing logged: the
/// same shape as the opened board, reached without an open.
#[test]
fn a_board_run_past_its_last_cadence_snapshot_saves_a_file_that_reopens() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut rig = new_board(Some(5));
    place(&mut rig, machine_kind::FACTORY, (20, 20));
    for _ in 0..7 {
        fold(&mut rig);
    }
    assert!(
        !rig.host.core().tick.is_multiple_of(5),
        "measured: the board stops between two cadence snapshots (tick {})",
        rig.host.core().tick
    );
    assert_eq!(
        save_reopen_facts(&rig, dir.path()),
        reopens(),
        "the saved file reopens"
    );
}
