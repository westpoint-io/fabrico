//! Forged project files: real host boards with ONE field of their history changed, written
//! to `tests/fixtures/` so the live suite can open the same bytes through the toolbar.
//!
//! WHY A FORGED FILE AT ALL. Some host guards are unreachable from any ordinary gesture and
//! exist only to keep every board loadable against a forged or corrupted history. A guard
//! with no reach is still graded (standing constraint 1): a test builds the one board that
//! meets it, from a real host, and changes only the field the guard reads.
//!
//! HOW EACH FILE IS MADE AND KEPT CURRENT. The bytes are GENERATED, never hand-written: a
//! builder drives a real [`Host`] through `apply_gesture` and `tick_once` at a fixed seed,
//! saves it with the shipped `save_project`, decodes the bundle, changes the one field and
//! re-encodes it. An ignored writer test writes the result to the fixture path (`cargo test
//! -p fabrico-host --test forged_files -- --ignored`); a plain currency test rebuilds the
//! bytes and requires them equal to the committed file. So a later edit-schema or project
//! version bump turns the currency test red BY NAME, instead of leaving a fixture that is
//! refused at its envelope for the wrong reason while its own leg still reads green.
//!
//! THE FILES
//! - `86-undo-space-taken.fab` (plan 86-06, D-04, WORK-02): a Factory at (20,20) and a
//!   Source at (23,20) just east of it, the Factory deleted last. Its Delete capture is
//!   widened from 3 to 4 columns, so the box an Undo would put back reaches the Source's
//!   cell; the anchor, the ports and every other byte stay real. Opened, its Ctrl+Z must be
//!   refused `UndoSpaceTaken` with the board unchanged and the step still on top of the
//!   undo stack. With linear undo no ordinary gesture reaches that guard (anything placed
//!   after a Delete is undone before it); this file is its only reach, and
//!   `frontend/e2e-live/86-undo-space-taken.live.spec.ts` opens it on the real app.
//!
//! - `86-label-given-a-port.fab` (plan 86-07, D-08, WORK-09): a Source, a Sink and a label
//!   placed from the palette, saved, then ONE forged `AddPort` record appended that gives the
//!   label an output port. A label is a note and never connects, and no gesture can send
//!   that record (validation refuses it as `LabelDoesNotConnect`); a hand-edited file can.
//!   Opened, it must be refused `LabelConnected` with a sentence, the running board left
//!   alone. `frontend/e2e-live/86-forged-label-file.live.spec.ts` opens it on the real app.
//!
//!   Before plan 86-07 this file OPENED: the fold gave the label the port and widened its
//!   box, with no collision check (`label-file-red.out`).
//!
//!   WHY APPENDED AND NOT SWAPPED. The forged record is appended as a fresh action at the
//!   saved head tick and the head moved on by the one tick it folds in (the
//!   `write_forged_undo` shape in `project.rs`), so the head-tick agreement and every other
//!   load check pass and only the label rule can refuse it.
//!
//!   FINDING THE LABEL. Every id in the edit log is the id the live board minted, because
//!   the board is built only through `apply_gesture`, so the forged record names the
//!   label's real id and the load's re-fold from genesis mints the same one.
//!
//! - `86-label-17-by-9.fab` (plan 86-07, D-09, WORK-11): the same label board, saved, then ONE
//!   forged `Configure` appended that sizes the label 17 by 9, one past the panel's 16 by 8 on
//!   each side (a board a later build with a larger cap could write). Opened, its label must
//!   take new words and a new colour at its own 17 by 9; before plan 86-07 every Apply on it
//!   was refused, because the panel resends the current size and the cap refused it.
//!   `frontend/e2e-live/86-over-cap-label-edit.live.spec.ts` opens it on the real app.
//!
//! - `86-label-delete-box-lie.fab` (phase 86 security audit, threat T-86-15, D-04): a
//!   Source, a Sink and a 4 by 1 label, the label deleted last. Its Delete capture is shrunk
//!   to 1 by 1 and its anchor moved three cells west of the Source, so the captured box is
//!   free but the 4 by 1 box the label's own config re-grows on Ctrl+Z reaches the Source.
//!   Opened, its Ctrl+Z must be refused `UndoSpaceTaken` with the board unchanged. No live
//!   spec opens it yet; the fixture is kept current so one can.
//!
//! - `86-label-delete-gives-a-port.fab` (phase 86 security audit, threat T-86-27, D-08):
//!   the label board with its label deleted, then ONE forged Delete appended that names the
//!   Sink with kind LABEL and a capture holding one port. Before the fix its Ctrl+Z put a
//!   label with a port where the Sink stood and the saved board was refused on reopen.
//!   Opened, it must be refused `LabelConnected` with the label sentence. No live spec opens
//!   it yet.
//!
//! - `v12-label-17-by-9.fab` (plan 87-03, threat T-87-08): NOT generated and never
//!   regenerated. It is a BYTE COPY of `86-label-17-by-9.fab` as committed at plan 87-03's
//!   start revision, when `PROJECT_FILE_VERSION` read 12 and the embedded
//!   snapshot 13, taken before the lockstep bump to 13 and 14 and kept frozen as the
//!   witness that a real v12 save is refused whole as too old, naming both versions
//!   (`a_v12_project_file_is_refused_as_too_old`). The five `86-*.fab` files above were
//!   re-authored through their writers at that bump; this one keeps the old bytes.
//!
//! - `88-undo-does-not-fit.fab` (plan 88-02, FAIL-09, WINDOWS 81, D-11): a Source, and a Sink
//!   fed by one docked belt, the Sink deleted last. Its Delete's captured cascade belt keeps
//!   its tiles and loses its links, so `compute_inverse` cannot tell which node was the belt
//!   and refuses the undo before anything folds. Opened, its Ctrl+Z must be refused
//!   `UndoDoesNotFit` with the board unchanged; until plan 88-02 the same refusal read the
//!   no-cause `Malformed` sentence. `frontend/e2e-live/88-refusal-sentences.live.spec.ts` leg
//!   4 opens it on the real app.
//!
//! Every leg added for T-86-15 and T-86-27 also walks EVERY board the forged file reaches
//! (as opened, then each Ctrl+Z and Ctrl+Y) and requires each to save into a file that
//! opens again (`walk_reachable_boards`).
//!
//! Run target: `cargo test -p fabrico-host --test forged_files`

// `fabrico-host` is the sanctioned I/O home (see `project.rs`), and these tests read and
// write the fixture file itself, which is the whole point of the file.
#![allow(clippy::disallowed_methods)]

use std::collections::BTreeMap;
use std::path::PathBuf;

use fabrico_command::CommandError;
use fabrico_core::command::{Command, ResultEvent};
use fabrico_core::core::Core;
use fabrico_core::edit::{EDIT_SCHEMA_VERSION, EditOp, EditRecord, PortSeat};
use fabrico_core::event::{EventPayload, LogHeader, SCHEMA_VERSION};
use fabrico_core::ids::NodeId;
use fabrico_core::persist::RedbStore;
use fabrico_core::snapshot::{restore, snapshot};
use fabrico_core::state::{Footprint, Medium, Node, Port, Role, Side};
use fabrico_host::driver::Host;
use fabrico_host::input_apply::apply_gesture;
use fabrico_host::ledger::DispatchLedger;
use fabrico_host::project::{ProjectFile, load_project, save_project};
use fabrico_protocol::{GridCommand, machine_kind};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};

/// The genesis seed every forged board is built at, so the bytes are one function of the
/// code that wrote them.
const SEED: u64 = 0x8606_5ACE;

/// The Factory's anchor and the Source's cell, one column east of the Factory's 3 by 3 box.
const FACTORY_AT: (i32, i32) = (20, 20);
const SOURCE_AT: (i32, i32) = (23, 20);

/// The window every cell owner is read over: the two machines and a margin round them.
const WINDOW_X: std::ops::RangeInclusive<i32> = 15..=28;
const WINDOW_Y: std::ops::RangeInclusive<i32> = 15..=26;

/// The label board (plan 86-07): a Source, a Sink east of it, and a label below them, all
/// clear of one another.
const LB_SOURCE_AT: (i32, i32) = (20, 20);
const LB_SINK_AT: (i32, i32) = (24, 20);
const LB_LABEL_AT: (i32, i32) = (20, 24);

/// The sentence a user reads when a file joins a label to anything (plan 86-07, D-08),
/// transcribed here so this file compiled, and was seen red, before the arm existed.
const LABEL_CONNECTED_SENTENCE: &str = "This file gives a label a port or joins it to a belt or \
    cable. Labels do not connect, so the file was not opened.";

/// The committed fixture the live spec opens.
fn undo_space_taken_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/86-undo-space-taken.fab")
}

/// A host plus the channel triple `tick_once` requires.
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

/// Wrap `host` (whose stores live in `dir`) with fresh channels.
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

/// An empty board at [`SEED`] over fresh temp stores.
fn empty_rig() -> Rig {
    let dir = tempfile::tempdir().expect("tempdir");
    let core = Core::genesis(LogHeader { schema_version: SCHEMA_VERSION, seed: SEED });
    let store = RedbStore::open(dir.path().join("log.redb")).expect("open log");
    let ledger = DispatchLedger::open(dir.path().join("ledger.redb")).expect("open ledger");
    let host = Host::new(core, store, ledger, None).expect("open host");
    rig_over(host, dir)
}

/// Fold ONE tick.
fn fold(rig: &mut Rig) {
    rig.host
        .tick_once(&mut rig.ingress_rx, &mut rig.results_rx, &rig.cmd_tx)
        .expect("tick_once persists and folds");
}

/// One gesture through the shipped host path, handle 0 naming `node` when given, then
/// one folded tick (a refused gesture enqueues nothing, so the tick folds nothing).
fn gesture(rig: &mut Rig, node: Option<NodeId>, cmd: GridCommand) -> Result<(), CommandError> {
    let verdict = apply_gesture(&mut rig.host, cmd, |h| if h == 0 { node } else { None });
    fold(rig);
    verdict
}

fn dbg<T: std::fmt::Debug>(v: T) -> String {
    format!("{v:?}")
}

/// Every cell owner in the window, as `(x, y) -> node`.
fn owners(host: &Host) -> BTreeMap<(i32, i32), NodeId> {
    let mut out = BTreeMap::new();
    for y in WINDOW_Y {
        for x in WINDOW_X {
            if let Some(n) = host.core().state.occupied((x, y)) {
                out.insert((x, y), n);
            }
        }
    }
    out
}

/// The node set, in id order.
fn nodes(host: &Host) -> Vec<NodeId> {
    let mut ids: Vec<NodeId> = host.core().state.node_ids().collect();
    ids.sort();
    ids
}

/// `save_project` then `load_project` on fresh dirs, as one verdict string.
fn save_and_load(host: &Host) -> String {
    let save_dir = tempfile::tempdir().expect("save tempdir");
    let fab = save_dir.path().join("reopen.fab");
    if let Err(e) = save_project(host, &fab) {
        return format!("save {e:?}");
    }
    let load_dir = tempfile::tempdir().expect("load work dir");
    match load_project(&fab, load_dir.path(), None) {
        Ok(_) => "Ok".to_owned(),
        Err(e) => format!("load {e:?}"),
    }
}

/// THE BUILDER for `86-undo-space-taken.fab`. A real board: a Factory placed at (20,20), a
/// Source at (23,20), the Factory deleted, each through `apply_gesture` and folded. The save
/// is the shipped `save_project`; the ONE forged field is the Delete record's `captured.w`,
/// 3 (what the Factory held, x 20 to 22) widened to 4, so the re-Place box an Undo would
/// fold reaches x 23, the Source's column.
fn undo_space_taken_bundle() -> ProjectFile {
    let mut rig = empty_rig();
    assert_eq!(
        gesture(&mut rig, None, GridCommand::Place {
            kind: machine_kind::FACTORY,
            cell_x: FACTORY_AT.0,
            cell_y: FACTORY_AT.1,
        }),
        Ok(()),
        "measured: a Factory on empty floor is accepted"
    );
    let factory = rig.host.core().state.occupied(FACTORY_AT).expect("the Factory holds its anchor");
    assert_eq!(
        rig.host.core().state.footprint_of(factory),
        Some(Footprint { w: 3, h: 3, rot: 0 }),
        "measured: a placed Factory is 3 by 3, x 20 to 22"
    );
    assert_eq!(
        gesture(&mut rig, None, GridCommand::Place {
            kind: machine_kind::SOURCE,
            cell_x: SOURCE_AT.0,
            cell_y: SOURCE_AT.1,
        }),
        Ok(()),
        "measured: a Source one column east of the Factory is accepted"
    );
    let source = rig.host.core().state.occupied(SOURCE_AT).expect("the Source holds its cell");
    assert_ne!(source, factory, "measured: the Source is its own node");
    assert_eq!(
        gesture(&mut rig, Some(factory), GridCommand::Delete { node: 0 }),
        Ok(()),
        "measured: the Factory's Delete is accepted"
    );
    assert_eq!(rig.host.core().state.node(factory), None, "measured: the Factory is gone");
    assert!(rig.host.can_undo(), "measured: the Delete is undoable");

    let save_dir = tempfile::tempdir().expect("save tempdir");
    let fab = save_dir.path().join("undo-space-taken.fab");
    save_project(&rig.host, &fab).expect("the real board saves");
    let bytes = std::fs::read(&fab).expect("the saved file reads back");
    let mut bundle: ProjectFile = postcard::from_bytes(&bytes).expect("the saved bundle decodes");

    let last = bundle.edit_log.last_mut().expect("the board has an edit log");
    match &mut last.op {
        EditOp::Delete { node, kind, cell_x, cell_y, captured } => {
            assert_eq!(*node, factory, "measured: the last record deletes the Factory");
            assert_eq!(*kind, machine_kind::FACTORY, "measured: a Factory Delete");
            assert_eq!((*cell_x, *cell_y), FACTORY_AT, "measured: at the Factory's anchor");
            assert_eq!(
                (captured.w, captured.h, captured.rot),
                (3, 3, 0),
                "measured: the real capture is the 3 by 3 box the Factory held"
            );
            captured.w = 4;
        }
        other => panic!("measured: the last record is the Factory's Delete, found {other:?}"),
    }
    bundle
}

/// The fixture's bytes, as the builder makes them today.
fn undo_space_taken_bytes() -> Vec<u8> {
    postcard::to_allocvec(&undo_space_taken_bundle()).expect("the forged bundle encodes")
}

/// THE WRITER. Ignored: run it (`-- --ignored`) only to regenerate the committed fixture,
/// after a change that the currency test below names.
#[test]
#[ignore = "writer: regenerates tests/fixtures/86-undo-space-taken.fab"]
fn write_the_undo_space_taken_fixture() {
    std::fs::write(undo_space_taken_path(), undo_space_taken_bytes()).expect("write the fixture");
}

/// THE CURRENCY TEST. The committed bytes are exactly what the builder makes now, so the
/// file the live spec opens is the board this file describes, at this build's versions.
#[test]
fn the_undo_space_taken_fixture_is_current() {
    let committed = std::fs::read(undo_space_taken_path()).expect("the fixture is committed");
    assert!(
        committed == undo_space_taken_bytes(),
        "tests/fixtures/86-undo-space-taken.fab is stale: rebuild it with `cargo test -p \
         fabrico-host --test forged_files -- --ignored` and commit the bytes"
    );
}

/// THE GUARD ON THE HOST (D-04). The committed file opens; Ctrl+Z on it is refused
/// `UndoSpaceTaken`, nothing is placed or logged, every cell owner and the node set are as
/// they were, the step stays on top of the undo stack, and the board still restores, saves
/// and opens.
///
/// No ordinary gesture reaches this guard: with linear undo, anything placed after a
/// Delete is undone before the Delete is. This file is its only reach.
///
/// RED BEFORE THE GUARD (plan 86-06 task 1, `forged-red.out`): the Undo was accepted and
/// the 4 by 3 re-Place folded over the Source, whose cell the Factory then owned.
#[test]
fn the_undo_space_taken_file_loads_and_its_undo_is_refused() {
    let dir = tempfile::tempdir().expect("load work dir");
    let host = match load_project(&undo_space_taken_path(), dir.path(), None) {
        Ok(h) => h,
        Err(e) => panic!("the committed fixture must open, got {e:?}"),
    };
    let work = tempfile::tempdir().expect("rig dir");
    let mut rig = rig_over(host, work);
    let edits_before = rig.host.logged_edits().expect("read the edit log").len();
    let nodes_before = nodes(&rig.host);
    let owners_before = owners(&rig.host);
    let source = rig.host.core().state.occupied(SOURCE_AT);
    assert!(source.is_some(), "measured: the opened board holds the Source at (23,20)");
    assert!(rig.host.can_undo(), "measured: the opened board offers Undo");

    let undo = gesture(&mut rig, None, GridCommand::Undo);
    let facts: Vec<(&'static str, String)> = vec![
        ("undo", dbg(undo)),
        (
            "edits_unchanged",
            (rig.host.logged_edits().expect("read the edit log").len() == edits_before).to_string(),
        ),
        ("nodes_unchanged", (nodes(&rig.host) == nodes_before).to_string()),
        ("owners_unchanged", (owners(&rig.host) == owners_before).to_string()),
        ("source_keeps_23_20", (rig.host.core().state.occupied(SOURCE_AT) == source).to_string()),
        ("can_undo", rig.host.can_undo().to_string()),
        ("restores", dbg(restore(&snapshot(rig.host.core())).err().map(|e| format!("{e:?}")))),
        ("save_and_load", save_and_load(&rig.host)),
    ];
    for (k, v) in &facts {
        eprintln!("undo_space_taken {k} = {v}");
    }
    let expected: Vec<(&'static str, String)> = vec![
        // Spelled as text so this leg compiled, and was seen red, before the tag existed.
        ("undo", "Err(UndoSpaceTaken)".to_owned()),
        ("edits_unchanged", "true".to_owned()),
        ("nodes_unchanged", "true".to_owned()),
        ("owners_unchanged", "true".to_owned()),
        ("source_keeps_23_20", "true".to_owned()),
        ("can_undo", "true".to_owned()),
        ("restores", "None".to_owned()),
        ("save_and_load", "Ok".to_owned()),
    ];
    assert_eq!(facts, expected, "the forged Undo is refused and changes nothing");
}

// ---------------------------------------------------------------------------
// Plan 86-07 (D-08, WORK-09): a file that gives a label a port
// ---------------------------------------------------------------------------

/// The committed label-given-a-port fixture the live spec opens.
fn label_given_a_port_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/86-label-given-a-port.fab")
}

/// The id of the node holding `cell`, or a panic naming what was expected there.
fn node_at(host: &Host, cell: (i32, i32), what: &str) -> NodeId {
    host.core()
        .state
        .occupied(cell)
        .unwrap_or_else(|| panic!("measured: {what} holds {cell:?}"))
}

/// A real board built from the palette: a Source, a Sink and a label, each through
/// `apply_gesture` and folded. Returns the rig and the label's id.
fn label_board() -> (Rig, NodeId) {
    let mut rig = empty_rig();
    for (kind, at, what) in [
        (machine_kind::SOURCE, LB_SOURCE_AT, "the Source"),
        (machine_kind::SINK, LB_SINK_AT, "the Sink"),
        (machine_kind::LABEL, LB_LABEL_AT, "the label"),
    ] {
        assert_eq!(
            gesture(&mut rig, None, GridCommand::Place { kind, cell_x: at.0, cell_y: at.1 }),
            Ok(()),
            "measured: {what} on empty floor is accepted"
        );
    }
    let label = node_at(&rig.host, LB_LABEL_AT, "the label");
    assert!(
        matches!(rig.host.core().state.node(label), Some(Node::Label(_))),
        "measured: the node at {LB_LABEL_AT:?} is a label"
    );
    assert!(
        rig.host.core().state.ports_of(label).is_none_or(<[Port]>::is_empty),
        "measured: a placed label has no ports"
    );
    (rig, label)
}

/// `save_project` on `host`, decoded back off disk.
fn saved(host: &Host) -> ProjectFile {
    let save_dir = tempfile::tempdir().expect("save tempdir");
    let fab = save_dir.path().join("board.fab");
    save_project(host, &fab).expect("the real board saves");
    postcard::from_bytes(&std::fs::read(&fab).expect("the saved file reads back"))
        .expect("the saved bundle decodes")
}

/// Append ONE forged record carrying `op` to a real saved bundle, as a careful hand edit
/// would: a fresh action, the next sequence, the current edit schema, stamped at the saved
/// head tick, and the head moved on by the one tick it folds in.
fn append_forged(bundle: &mut ProjectFile, op: EditOp) {
    let last = bundle.edit_log.last().cloned().expect("the board has an edit log");
    let action = bundle.edit_log.iter().map(|r| r.action).max().unwrap_or(0) + 1;
    bundle.edit_log.push(EditRecord {
        schema_version: EDIT_SCHEMA_VERSION,
        partition: last.partition,
        sequence: last.sequence + 1,
        tick: bundle.head_tick,
        action,
        op,
    });
    bundle.head_tick += 1;
}

/// THE BUILDER for `86-label-given-a-port.fab`: the label board saved, then one forged
/// `AddPort` giving the label an east-facing output at its first cell, the shape a forward
/// "add an output" gesture writes (`index` the end of the list, `seat: Auto`).
fn label_given_a_port_bundle() -> ProjectFile {
    let (rig, label) = label_board();
    let mut bundle = saved(&rig.host);
    append_forged(
        &mut bundle,
        EditOp::AddPort {
            node: label,
            port: Port {
                local_offset: (0, 0),
                side: Side::E,
                role: Role::Out,
                medium: Medium::Mechanical,
            },
            index: 0,
            seat: PortSeat::Auto,
        },
    );
    bundle
}

/// The fixture's bytes, as the builder makes them today.
fn label_given_a_port_bytes() -> Vec<u8> {
    postcard::to_allocvec(&label_given_a_port_bundle()).expect("the forged bundle encodes")
}

/// THE WRITER. Ignored: run it (`-- --ignored`) only to regenerate the committed fixture.
#[test]
#[ignore = "writer: regenerates tests/fixtures/86-label-given-a-port.fab"]
fn write_the_label_given_a_port_fixture() {
    std::fs::write(label_given_a_port_path(), label_given_a_port_bytes())
        .expect("write the fixture");
}

/// THE CURRENCY TEST for `86-label-given-a-port.fab`.
#[test]
fn the_label_given_a_port_fixture_is_current() {
    let committed = std::fs::read(label_given_a_port_path()).expect("the fixture is committed");
    assert!(
        committed == label_given_a_port_bytes(),
        "tests/fixtures/86-label-given-a-port.fab is stale: rebuild it with `cargo test -p \
         fabrico-host --test forged_files -- --ignored` and commit the bytes"
    );
}

/// THE REFUSAL (D-08). The committed file is refused on open as `LabelConnected`, and the
/// sentence the card renders names the problem in plain words.
///
/// RED BEFORE THE CHANGE (plan 86-07 task 1, `label-file-red.out`): the file opened, with
/// the label holding the forged port.
#[test]
fn the_label_given_a_port_file_is_refused_in_words() {
    let dir = tempfile::tempdir().expect("load work dir");
    let verdict = match load_project(&label_given_a_port_path(), dir.path(), None) {
        Ok(host) => {
            let label = host.core().state.occupied(LB_LABEL_AT);
            let ports = label.and_then(|l| host.core().state.ports_of(l)).map(<[Port]>::len);
            format!("opened, label ports {ports:?}")
        }
        Err(e) => format!("{e:?} / {e}"),
    };
    // Spelled as text so this leg compiled, and was seen red, before the arm existed.
    assert_eq!(
        verdict,
        format!("LabelConnected / {LABEL_CONNECTED_SENTENCE}"),
        "a file that gives a label a port is refused with the sentence"
    );
}

// ---------------------------------------------------------------------------
// Plan 86-07 (D-09, WORK-11): a label past the panel's cap still takes new words
// ---------------------------------------------------------------------------

/// The committed 17 by 9 label fixture the live spec opens.
fn label_17_by_9_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/86-label-17-by-9.fab")
}

/// The words the forged Configure gives the 17 by 9 label.
const OVER_CAP_WORDS: &str = "Order intake";

/// THE BUILDER for `86-label-17-by-9.fab`: the label board saved, then one forged
/// `Configure` that sizes the label 17 by 9 with words and the Stone colour.
fn label_17_by_9_bundle() -> ProjectFile {
    let (rig, label) = label_board();
    let mut bundle = saved(&rig.host);
    append_forged(
        &mut bundle,
        EditOp::Configure {
            node: label,
            config: fabrico_core::edit::MachineConfig::Label {
                text: OVER_CAP_WORDS.to_owned(),
                colour: fabrico_core::state::LabelColour::Stone,
                w: 17,
                h: 9,
            },
            code_hash: [0u8; 32],
        },
    );
    bundle
}

/// The fixture's bytes, as the builder makes them today.
fn label_17_by_9_bytes() -> Vec<u8> {
    postcard::to_allocvec(&label_17_by_9_bundle()).expect("the forged bundle encodes")
}

/// THE WRITER. Ignored: run it (`-- --ignored`) only to regenerate the committed fixture.
#[test]
#[ignore = "writer: regenerates tests/fixtures/86-label-17-by-9.fab"]
fn write_the_17_by_9_label_fixture() {
    std::fs::write(label_17_by_9_path(), label_17_by_9_bytes()).expect("write the fixture");
}

/// THE CURRENCY TEST for `86-label-17-by-9.fab`.
#[test]
fn the_17_by_9_label_fixture_is_current() {
    let committed = std::fs::read(label_17_by_9_path()).expect("the fixture is committed");
    assert!(
        committed == label_17_by_9_bytes(),
        "tests/fixtures/86-label-17-by-9.fab is stale: rebuild it with `cargo test -p \
         fabrico-host --test forged_files -- --ignored` and commit the bytes"
    );
}

/// The label's words, colour byte and box on `host`.
fn label_facts(host: &Host, label: NodeId) -> String {
    let words = match host.core().state.node(label) {
        Some(Node::Label(l)) => format!("{:?} colour {}", l.text, l.colour.to_byte()),
        other => format!("not a label: {other:?}"),
    };
    format!("{words} box {:?}", host.core().state.footprint_of(label))
}

/// THE EDIT ON THE HOST (D-09). The committed file opens with its label 17 by 9; a
/// text-only Apply (the panel resends the current size) is accepted and folds, and the box
/// stays 17 by 9.
///
/// RED BEFORE THE CHANGE (plan 86-07 task 3, `cap-red.out`'s host twin): the Apply was
/// refused `Malformed`, so the label's words could never change.
#[test]
fn the_17_by_9_label_file_loads_and_takes_new_words() {
    let dir = tempfile::tempdir().expect("load work dir");
    let host = match load_project(&label_17_by_9_path(), dir.path(), None) {
        Ok(h) => h,
        Err(e) => panic!("the committed fixture must open, got {e:?}"),
    };
    let work = tempfile::tempdir().expect("rig dir");
    let mut rig = rig_over(host, work);
    let label = node_at(&rig.host, LB_LABEL_AT, "the label");
    assert_eq!(
        label_facts(&rig.host, label),
        format!("{OVER_CAP_WORDS:?} colour 1 box Some(Footprint {{ w: 17, h: 9, rot: 0 }})"),
        "measured: the opened label is 17 by 9, Stone"
    );
    let verdict = gesture(
        &mut rig,
        Some(label),
        GridCommand::Configure {
            node: 0,
            config: fabrico_protocol::MachineConfig::Label {
                text: "Dispatch".to_owned(),
                colour: 1,
                w: 17,
                h: 9,
            },
        },
    );
    assert_eq!(
        (dbg(verdict), label_facts(&rig.host, label)),
        ("Ok(())".to_owned(), "\"Dispatch\" colour 1 box Some(Footprint { w: 17, h: 9, rot: 0 })".to_owned()),
        "a text-only Apply on the over-cap label is accepted and the box stays 17 by 9"
    );
}

// ---------------------------------------------------------------------------
// Phase 86 security audit, T-86-15 and T-86-27: every board a forged file reaches reopens
// ---------------------------------------------------------------------------

/// Open `fab` and, if it opens, walk every board a user reaches from it with Ctrl+Z and
/// Ctrl+Y, saving and reopening each one. One line per board: the gesture that reached it,
/// its verdict, and what `save_and_load` said. A refused gesture changes nothing, so the walk
/// stops at it (a second press would reach the same board). Bounded: the boards here hold a
/// handful of steps.
///
/// A file refused on open reaches no board at all, and the walk is the one line naming the
/// refusal and its sentence.
fn walk_reachable_boards(fab: &std::path::Path) -> Vec<String> {
    let dir = tempfile::tempdir().expect("load work dir");
    let host = match load_project(fab, dir.path(), None) {
        Ok(h) => h,
        Err(e) => return vec![format!("refused on open: {e:?} / {e}")],
    };
    let work = tempfile::tempdir().expect("rig dir");
    let mut rig = rig_over(host, work);
    let mut out = vec![format!("opened, save {}", save_and_load(&rig.host))];
    for (press, can) in [(GridCommand::Undo, Host::can_undo as fn(&Host) -> bool), (GridCommand::Redo, Host::can_redo)] {
        for _ in 0..16 {
            if !can(&rig.host) {
                break;
            }
            let verdict = gesture(&mut rig, None, press.clone());
            let refused = verdict.is_err();
            out.push(format!("{press:?} {verdict:?}, save {}", save_and_load(&rig.host)));
            if refused {
                break;
            }
        }
    }
    out
}

/// Every board in `walk` saves into a file that opens again.
fn assert_every_reachable_board_reopens(walk: &[String], what: &str) {
    for line in walk {
        assert!(
            line.starts_with("refused on open: ") || line.ends_with("save Ok"),
            "{what}: a reachable board saves into a file refused on reopen: {line}\nwalk: {walk:#?}"
        );
    }
}

/// Write `bundle` to a fresh temp file and walk it.
fn walk_bundle(bundle: &ProjectFile) -> Vec<String> {
    let dir = tempfile::tempdir().expect("bundle tempdir");
    let fab = dir.path().join("forged.fab");
    std::fs::write(&fab, postcard::to_allocvec(bundle).expect("the forged bundle encodes"))
        .expect("write the forged bundle");
    walk_reachable_boards(&fab)
}

// --- T-86-15: a label Delete whose capture box is smaller than the label it restores ---

/// The committed label-box-lie fixture.
fn label_box_lie_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/86-label-delete-box-lie.fab")
}

/// The real label's size: 4 cells wide, 1 deep.
const LIE_LABEL_W: u16 = 4;

/// Where the forged Delete puts the label's anchor: three cells west of the Source, so the
/// 1 by 1 capture lands on free floor at (17,20) and the 4 by 1 box the label's own config
/// re-grows reaches (20,20), the Source's cell.
const LIE_ANCHOR: (i32, i32) = (LB_SOURCE_AT.0 - 3, LB_SOURCE_AT.1);

/// The real board behind the lie: a Source, a Sink and a label, the label configured 4 by
/// 1 from the panel and then deleted, each through `apply_gesture` and folded. Saved with
/// the shipped `save_project` and decoded back. Returns the bundle and the label's id.
fn label_box_lie_board() -> (ProjectFile, NodeId) {
    let (mut rig, label) = label_board();
    assert_eq!(
        gesture(
            &mut rig,
            Some(label),
            GridCommand::Configure {
                node: 0,
                config: fabrico_protocol::MachineConfig::Label {
                    text: "Intake".to_owned(),
                    colour: 0,
                    w: LIE_LABEL_W,
                    h: 1,
                },
            },
        ),
        Ok(()),
        "measured: a 4 by 1 label on free floor is accepted"
    );
    assert_eq!(
        rig.host.core().state.footprint_of(label),
        Some(Footprint { w: LIE_LABEL_W, h: 1, rot: 0 }),
        "measured: the label is 4 by 1"
    );
    assert_eq!(
        gesture(&mut rig, Some(label), GridCommand::Delete { node: 0 }),
        Ok(()),
        "measured: the label's Delete is accepted"
    );
    (saved(&rig.host), label)
}

/// THE BUILDER for `86-label-delete-box-lie.fab` (T-86-15). ONE record is changed: the
/// label's real Delete. Its capture is shrunk from 4 by 1 to 1 by 1 and its anchor moved to
/// [`LIE_ANCHOR`]. The 1 by 1 box an Undo re-Places is free; the label's config (4 by 1,
/// read from the history, not from the record) then re-grows the box over the Source.
fn label_box_lie_bundle_at(anchor: (i32, i32)) -> ProjectFile {
    let (mut bundle, label) = label_box_lie_board();
    let last = bundle.edit_log.last_mut().expect("the board has an edit log");
    match &mut last.op {
        EditOp::Delete { node, kind, cell_x, cell_y, captured } => {
            assert_eq!(*node, label, "measured: the last record deletes the label");
            assert_eq!(*kind, machine_kind::LABEL, "measured: a label Delete");
            assert_eq!((*cell_x, *cell_y), LB_LABEL_AT, "measured: at the label's anchor");
            assert_eq!(
                (captured.w, captured.h, captured.rot, captured.ports.len()),
                (LIE_LABEL_W, 1, 0, 0),
                "measured: the real capture is the 4 by 1 portless box the label held"
            );
            captured.w = 1;
            (*cell_x, *cell_y) = anchor;
        }
        other => panic!("measured: the last record is the label's Delete, found {other:?}"),
    }
    bundle
}

fn label_box_lie_bytes() -> Vec<u8> {
    postcard::to_allocvec(&label_box_lie_bundle_at(LIE_ANCHOR)).expect("the forged bundle encodes")
}

/// THE WRITER. Ignored: run it (`-- --ignored`) only to regenerate the committed fixture.
#[test]
#[ignore = "writer: regenerates tests/fixtures/86-label-delete-box-lie.fab"]
fn write_the_label_box_lie_fixture() {
    std::fs::write(label_box_lie_path(), label_box_lie_bytes()).expect("write the fixture");
}

/// THE CURRENCY TEST for `86-label-delete-box-lie.fab`.
#[test]
fn the_label_box_lie_fixture_is_current() {
    let committed = std::fs::read(label_box_lie_path()).expect("the fixture is committed");
    assert!(
        committed == label_box_lie_bytes(),
        "tests/fixtures/86-label-delete-box-lie.fab is stale: rebuild it with `cargo test -p \
         fabrico-host --test forged_files -- --ignored` and commit the bytes"
    );
}

/// THE GUARD READS THE BOX THE UNDO CLAIMS (T-86-15, D-04). The committed file opens; its
/// Ctrl+Z is refused `UndoSpaceTaken` because the label's re-grown 4 by 1 box reaches the
/// Source, though the record's 1 by 1 capture does not; nothing changes; and every board
/// the file reaches (as opened, after the refused Ctrl+Z) saves into a file that opens.
///
/// RED BEFORE THE FIX (security audit probe, re-measured here): the Ctrl+Z was accepted, the
/// label grew over the Source, the board saved, and the saved file was refused
/// `InvalidSnapshot(CellCollision)`.
#[test]
fn the_label_box_lie_file_loads_and_its_undo_is_refused() {
    let dir = tempfile::tempdir().expect("load work dir");
    let host = match load_project(&label_box_lie_path(), dir.path(), None) {
        Ok(h) => h,
        Err(e) => panic!("the committed fixture must open, got {e:?}"),
    };
    let work = tempfile::tempdir().expect("rig dir");
    let mut rig = rig_over(host, work);
    let edits_before = rig.host.logged_edits().expect("read the edit log").len();
    let nodes_before = nodes(&rig.host);
    let owners_before = owners(&rig.host);
    let source = rig.host.core().state.occupied(LB_SOURCE_AT);
    assert!(source.is_some(), "measured: the opened board holds the Source at (20,20)");
    assert!(rig.host.can_undo(), "measured: the opened board offers Undo");

    let undo = gesture(&mut rig, None, GridCommand::Undo);
    let facts: Vec<(&'static str, String)> = vec![
        ("undo", dbg(undo)),
        (
            "edits_unchanged",
            (rig.host.logged_edits().expect("read the edit log").len() == edits_before).to_string(),
        ),
        ("nodes_unchanged", (nodes(&rig.host) == nodes_before).to_string()),
        ("owners_unchanged", (owners(&rig.host) == owners_before).to_string()),
        ("source_keeps_20_20", (rig.host.core().state.occupied(LB_SOURCE_AT) == source).to_string()),
        ("can_undo", rig.host.can_undo().to_string()),
        ("restores", dbg(restore(&snapshot(rig.host.core())).err().map(|e| format!("{e:?}")))),
        ("save_and_load", save_and_load(&rig.host)),
    ];
    for (k, v) in &facts {
        eprintln!("label_box_lie {k} = {v}");
    }
    let expected: Vec<(&'static str, String)> = vec![
        ("undo", "Err(UndoSpaceTaken)".to_owned()),
        ("edits_unchanged", "true".to_owned()),
        ("nodes_unchanged", "true".to_owned()),
        ("owners_unchanged", "true".to_owned()),
        ("source_keeps_20_20", "true".to_owned()),
        ("can_undo", "true".to_owned()),
        ("restores", "None".to_owned()),
        ("save_and_load", "Ok".to_owned()),
    ];
    assert_eq!(facts, expected, "the label's Undo is refused against the box it would re-grow");

    let walk = walk_reachable_boards(&label_box_lie_path());
    eprintln!("label_box_lie walk = {walk:#?}");
    assert_eq!(
        walk,
        vec!["opened, save Ok".to_owned(), "Undo Err(UndoSpaceTaken), save Ok".to_owned()],
        "the file reaches two boards, and both save into a file that opens"
    );
}

/// THE CONTROL: the same 1 by 1 lie with the anchor moved onto free floor, where the 4 by 1
/// box the label re-grows is free too. The guard does not refuse it: Ctrl+Z brings the
/// label back 4 by 1 at the moved anchor, and every board the file reaches saves into a file
/// that opens.
#[test]
fn a_label_box_lie_over_free_floor_is_undone_and_every_board_reopens() {
    let walk = walk_bundle(&label_box_lie_bundle_at((20, 28)));
    eprintln!("label_box_lie_free walk = {walk:#?}");
    assert_eq!(
        walk.get(1).map(String::as_str),
        Some("Undo Ok(()), save Ok"),
        "the Undo over free floor is accepted; walk: {walk:#?}"
    );
    assert_every_reachable_board_reopens(&walk, "a label box lie over free floor");
}

// --- T-86-27: a forged record that gives a label ports ---

/// The committed label-delete-gives-a-port fixture.
fn label_delete_gives_a_port_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/86-label-delete-gives-a-port.fab")
}

/// The one port every forged label record in this section carries: an east-facing output
/// at the box's first cell, the shape a forward "add an output" writes.
fn forged_label_port() -> Port {
    Port { local_offset: (0, 0), side: Side::E, role: Role::Out, medium: Medium::Mechanical }
}

/// The label board with its label really deleted, saved: the last record is the label's
/// honest Delete (a 1 by 1 portless capture). Returns the bundle, the label's id and the
/// Sink's id.
fn deleted_label_board() -> (ProjectFile, NodeId, NodeId) {
    let (mut rig, label) = label_board();
    let sink = node_at(&rig.host, LB_SINK_AT, "the Sink");
    assert_eq!(
        gesture(&mut rig, Some(label), GridCommand::Delete { node: 0 }),
        Ok(()),
        "measured: the label's Delete is accepted"
    );
    (saved(&rig.host), label, sink)
}

/// A forged label Delete: the honest label Delete's capture, given `ports`, naming `node`
/// at `cell` with kind LABEL, appended as a fresh action.
fn append_forged_label_delete(
    bundle: &mut ProjectFile,
    node: NodeId,
    cell: (i32, i32),
    ports: Vec<Port>,
) {
    let mut captured = match &bundle.edit_log.last().expect("the board has an edit log").op {
        EditOp::Delete { kind, captured, .. } => {
            assert_eq!(*kind, machine_kind::LABEL, "measured: the last record is a label Delete");
            assert!(captured.ports.is_empty(), "measured: the honest capture has no ports");
            captured.clone()
        }
        other => panic!("measured: the last record is the label's Delete, found {other:?}"),
    };
    captured.ports = ports;
    append_forged(
        bundle,
        EditOp::Delete { node, kind: machine_kind::LABEL, cell_x: cell.0, cell_y: cell.1, captured },
    );
}

/// THE BUILDER for `86-label-delete-gives-a-port.fab` (T-86-27, the audit's probe b): ONE
/// forged Delete appended, naming the Sink with kind LABEL and a capture holding one port.
/// Its Ctrl+Z re-Places a LABEL with that port where the Sink stood; the Sink's config does
/// not match a label, so no re-Configure strips the port.
fn label_delete_gives_a_port_bundle() -> ProjectFile {
    let (mut bundle, _label, sink) = deleted_label_board();
    append_forged_label_delete(&mut bundle, sink, LB_SINK_AT, vec![forged_label_port()]);
    bundle
}

fn label_delete_gives_a_port_bytes() -> Vec<u8> {
    postcard::to_allocvec(&label_delete_gives_a_port_bundle()).expect("the forged bundle encodes")
}

/// THE WRITER. Ignored: run it (`-- --ignored`) only to regenerate the committed fixture.
#[test]
#[ignore = "writer: regenerates tests/fixtures/86-label-delete-gives-a-port.fab"]
fn write_the_label_delete_gives_a_port_fixture() {
    std::fs::write(label_delete_gives_a_port_path(), label_delete_gives_a_port_bytes())
        .expect("write the fixture");
}

/// THE CURRENCY TEST for `86-label-delete-gives-a-port.fab`.
#[test]
fn the_label_delete_gives_a_port_fixture_is_current() {
    let committed =
        std::fs::read(label_delete_gives_a_port_path()).expect("the fixture is committed");
    assert!(
        committed == label_delete_gives_a_port_bytes(),
        "tests/fixtures/86-label-delete-gives-a-port.fab is stale: rebuild it with `cargo test \
         -p fabrico-host --test forged_files -- --ignored` and commit the bytes"
    );
}

/// The one walk line a file refused on open as `LabelConnected` produces.
fn refused_label_connected() -> Vec<String> {
    vec![format!("refused on open: LabelConnected / {LABEL_CONNECTED_SENTENCE}")]
}

/// THE REFUSAL (T-86-27, D-08). The committed file is refused on open as `LabelConnected`,
/// with the label sentence, so it reaches no board at all.
///
/// RED BEFORE THE FIX (security audit probe b, re-measured here): the file opened, its Ctrl+Z
/// was accepted and put a label with a port where the Sink stood, the board saved, and the
/// saved file was refused `LabelConnected`.
#[test]
fn the_label_delete_gives_a_port_file_is_refused_in_words() {
    let walk = walk_reachable_boards(&label_delete_gives_a_port_path());
    eprintln!("label_delete_gives_a_port walk = {walk:#?}");
    assert_eq!(walk, refused_label_connected(), "a Delete giving a label a port is refused on open");
}

/// The other three forged label shapes, each refused on open with the label sentence:
/// - the audit's probe a: a label Delete naming an id no node holds (the label, already
///   deleted), its capture holding one port;
/// - the todo's second shape: a label Place carrying a port, deleted again before the end
///   of the replay, so no end-of-replay rule sees the port (this file used to open, and its
///   Ctrl+Z brought the label back portless);
/// - the same Place left standing (refused before this fix too, by the end-of-replay rule).
#[test]
fn every_forged_label_record_carrying_ports_is_refused_on_open() {
    // Probe a.
    let (mut absent, label, _sink) = deleted_label_board();
    append_forged_label_delete(&mut absent, label, LB_LABEL_AT, vec![forged_label_port()]);

    // A label Place with a port, at free floor, then that label deleted again. The Place
    // mints the next id, so the Delete names it by reading the honest replay.
    let (rig, _) = label_board();
    let mut placed = saved(&rig.host);
    let place_at = (20, 28);
    append_forged(
        &mut placed,
        EditOp::Place {
            kind: machine_kind::LABEL,
            cell_x: place_at.0,
            cell_y: place_at.1,
            w: 1,
            h: 1,
            ports: vec![forged_label_port()],
            rot: 0,
        },
    );
    let standing = placed.clone();
    let minted = {
        let dir = tempfile::tempdir().expect("bundle tempdir");
        let fab = dir.path().join("probe.fab");
        let mut honest = placed.clone();
        if let Some(EditOp::Place { ports, .. }) = honest.edit_log.last_mut().map(|r| &mut r.op) {
            ports.clear();
        }
        std::fs::write(&fab, postcard::to_allocvec(&honest).expect("encodes")).expect("write");
        let ldir = tempfile::tempdir().expect("load dir");
        let host = load_project(&fab, ldir.path(), None).expect("the portless twin opens");
        host.core().state.occupied(place_at).expect("measured: the twin's label holds its cell")
    };
    append_forged(
        &mut placed,
        EditOp::Delete {
            node: minted,
            kind: machine_kind::LABEL,
            cell_x: place_at.0,
            cell_y: place_at.1,
            captured: fabrico_core::edit::DeletedSubgraph {
                w: 1,
                h: 1,
                ports: Vec::new(),
                belts: Vec::new(),
                wires: Vec::new(),
                self_record: None,
                rot: 0,
            },
        },
    );

    for (what, bundle) in [
        ("a label Delete naming an absent id, with a port", &absent),
        ("a label Place with a port, deleted again", &placed),
        ("a label Place with a port, left standing", &standing),
    ] {
        let walk = walk_bundle(bundle);
        eprintln!("{what}: walk = {walk:#?}");
        assert_eq!(walk, refused_label_connected(), "{what} is refused on open");
    }
}

/// THE CONTROL: each forged label Delete above with its port taken out opens, and every
/// board it reaches saves into a file that opens. So the refusal is the port's, and an
/// honest label Delete (or a portless lie about its node) is untouched.
#[test]
fn the_portless_twins_of_the_forged_label_deletes_open_and_every_board_reopens() {
    let (mut on_sink, _label, sink) = deleted_label_board();
    append_forged_label_delete(&mut on_sink, sink, LB_SINK_AT, Vec::new());
    let (mut absent, label, _sink) = deleted_label_board();
    append_forged_label_delete(&mut absent, label, LB_LABEL_AT, Vec::new());
    let (honest, _, _) = deleted_label_board();
    for (what, bundle) in [
        ("the Sink-named label Delete without its port", &on_sink),
        ("the absent-id label Delete without its port", &absent),
        ("the honest label Delete", &honest),
    ] {
        let walk = walk_bundle(bundle);
        eprintln!("{what}: walk = {walk:#?}");
        assert!(walk[0].starts_with("opened"), "{what} opens; walk: {walk:#?}");
        assert_every_reachable_board_reopens(&walk, what);
    }
}

// ── Plan 87-03 (threat T-87-08): a real v12 save is refused as too old ──

/// The frozen v12 copy: the bytes of `86-label-17-by-9.fab` at plan 87-03's start revision,
/// never regenerated (see the module docs).
const V12_LABEL_17_BY_9: &[u8] = include_bytes!("fixtures/v12-label-17-by-9.fab");

/// A file saved by the v12 build is refused whole at its envelope as `TooOld { found: 12,
/// expected: 13 }`, before any decode and before the fresh store is touched, and the
/// sentence the user reads names both versions. Both numbers are literals, for the reason
/// the v11 witness in `project.rs` gives: derived from the constant, the test would re-point
/// on the next bump and stop witnessing this one.
#[test]
fn a_v12_project_file_is_refused_as_too_old() {
    assert_eq!(V12_LABEL_17_BY_9.first(), Some(&12u8), "the witness's envelope varint reads 12");
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("v12-label-17-by-9.fab");
    std::fs::write(&path, V12_LABEL_17_BY_9).expect("write the witness");

    let load_dir = tempfile::tempdir().expect("fresh work_dir");
    let result = load_project(&path, load_dir.path(), Some(1)).map(|_| ());
    assert!(
        matches!(
            result,
            Err(fabrico_host::project::ProjectError::TooOld { found: 12, expected: 13 })
        ),
        "a file saved by the v12 build must be refused whole as TooOld {{ found: 12, expected: \
         13 }} at the envelope: got {result:?}"
    );
    assert!(
        !load_dir.path().join("log.redb").exists(),
        "a refused v12 file must not hydrate the fresh store"
    );
    let shown = result.expect_err("refused").to_string();
    assert!(
        shown.contains("12") && shown.contains("v13"),
        "the sentence the user reads names both versions: {shown}"
    );
}

// ── Phase 87 security audit (threat T-87-28): a machine holding work with no wake ──

/// The sentence a user reads when a file's snapshot breaks a grid rule, transcribed here so
/// this leg compiled, and was seen red, before the arm existed.
const SNAPSHOT_RULE_SENTENCE: &str = "project file snapshot rejected: the snapshot decoded, but it \
    breaks a grid rule this build enforces.";

/// The genesis seed of the snapshot-only boards below.
const NO_WAKE_SEED: u64 = 0x8728_0000;

/// A forged board and what to read off it: the bundle, then a reader naming the items still
/// waiting (one line, the same on every board shape).
struct NoWakeBoard {
    what: &'static str,
    bundle: ProjectFile,
    read: Box<dyn Fn(&Core) -> String>,
}

fn inbox_len(core: &Core, id: NodeId, port: u16) -> usize {
    core.state.inbox_of(id).map_or(0, |i| i.len_on(port))
}

fn source_backlog(core: &Core, id: NodeId) -> usize {
    match core.state.node(id) {
        Some(Node::Source(s)) => s.pending.len(),
        _ => 0,
    }
}

fn factory_queue(core: &Core, id: NodeId) -> usize {
    match core.state.node(id) {
        Some(Node::Factory(f)) => f.pending_emits.values().map(std::collections::VecDeque::len).sum(),
        _ => 0,
    }
}

/// THE PALETTE BOARD, FORGED: a Factory at (20,20) and a Source at (23,20), each placed
/// through `apply_gesture` and folded, saved, with the bundle's snapshot replaced by the
/// board's own head snapshot changed in four fields: the Source's Out 0 is linked to the
/// Factory's In 0, that In holds `MECHANICAL_INBOX_CAP` items, the Source holds 3 queued
/// items, and the Source is asleep (`feeder_asleep`) or scheduled at the head tick. The
/// Factory is scheduled at the head tick only when `consumer_wake` holds: without it the
/// Factory holds work its step takes and nothing will ever step it. Every node is the one
/// the edit log minted, so the walk's Ctrl+Z and Ctrl+Y fold against real ids. A Factory and
/// not a Sink, so the board emits no command and every board the walk reaches can be saved.
fn feeder_board(what: &'static str, feeder_asleep: bool, consumer_wake: bool) -> NoWakeBoard {
    let mut rig = empty_rig();
    for (kind, at) in [(machine_kind::FACTORY, FACTORY_AT), (machine_kind::SOURCE, SOURCE_AT)] {
        assert_eq!(
            gesture(&mut rig, None, GridCommand::Place { kind, cell_x: at.0, cell_y: at.1 }),
            Ok(()),
            "measured: a palette machine on empty floor is accepted"
        );
    }
    let factory = node_at(&rig.host, FACTORY_AT, "the Factory");
    let source = node_at(&rig.host, SOURCE_AT, "the Source");
    let mut bundle = saved(&rig.host);
    let mut core = restore(&rig.host.snapshot_bytes()).expect("the real board's head snapshot restores");
    assert_eq!(core.tick, bundle.head_tick, "measured: the head snapshot is at the saved head tick");
    core.state.link((source, 0), (factory, 0));
    for i in 0..fabrico_core::admit::MECHANICAL_INBOX_CAP {
        core.state.inbox_mut(factory).push(0, i as u64, fabrico_core::ids::Item(vec![b'1']));
    }
    if let Some(Node::Source(s)) = core.state.node_mut(source) {
        for i in 0..3u8 {
            s.pending.push_back(fabrico_core::ids::Item(vec![b'1' + i]));
        }
    }
    if feeder_asleep {
        core.sched.test_insert_blocked(source);
    } else {
        core.sched.schedule_wake(source, core.tick);
    }
    if consumer_wake {
        core.sched.schedule_wake(factory, core.tick);
    }
    bundle.snapshot = snapshot(&core);
    NoWakeBoard {
        what,
        bundle,
        read: Box::new(move |c: &Core| {
            format!(
                "Factory In 0 holds {}, Source holds {} (asleep {})",
                inbox_len(c, factory, 0),
                source_backlog(c, source),
                c.sched.is_blocked(source)
            )
        }),
    }
}

/// THE AUDIT'S MEASURED BOARD, as a snapshot-only file: a Source with 3 queued items whose
/// Out 0 feeds a Sink whose In 0 holds `MECHANICAL_INBOX_CAP` items, the Source asleep or
/// scheduled, the Sink scheduled only when `sink_wake` holds.
fn sink_board(what: &'static str, source_asleep: bool, sink_wake: bool) -> NoWakeBoard {
    let mut core = Core::genesis(LogHeader { schema_version: SCHEMA_VERSION, seed: NO_WAKE_SEED + 2 });
    let source = core.state.add_source();
    let sink = core.state.add_sink(fabrico_core::state::SinkTemplate::Debug, 0);
    core.state.link((source, 0), (sink, 0));
    for i in 0..fabrico_core::admit::MECHANICAL_INBOX_CAP {
        core.state.inbox_mut(sink).push(0, i as u64, fabrico_core::ids::Item(vec![1]));
    }
    if let Some(Node::Source(s)) = core.state.node_mut(source) {
        for i in 0..3u8 {
            s.pending.push_back(fabrico_core::ids::Item(vec![0xA0 + i]));
        }
    }
    if source_asleep {
        core.sched.test_insert_blocked(source);
    } else {
        core.sched.schedule_wake(source, core.tick);
    }
    if sink_wake {
        core.sched.schedule_wake(sink, core.tick);
    }
    NoWakeBoard {
        what,
        bundle: snapshot_only(&core),
        read: Box::new(move |c: &Core| {
            format!(
                "Sink In 0 holds {}, Source holds {} (asleep {})",
                inbox_len(c, sink, 0),
                source_backlog(c, source),
                c.sched.is_blocked(source)
            )
        }),
    }
}

/// A SNAPSHOT-ONLY FILE (no edit log, no event log), the shape a hand-edited `.fab` takes:
/// `build` mints the board on a genesis core, and the bundle carries its snapshot alone.
fn snapshot_only(core: &Core) -> ProjectFile {
    ProjectFile {
        version: fabrico_host::project::PROJECT_FILE_VERSION,
        head_tick: core.tick,
        snapshot: snapshot(core),
        log: Vec::new(),
        edit_log: Vec::new(),
    }
}

/// A Factory with 3 emits waiting on its linked Out 0 (a Sink with room), scheduled only
/// when `wake` holds. The phase 87 part of the threat: the queue is new in this phase.
fn factory_queue_board(what: &'static str, wake: bool) -> NoWakeBoard {
    let mut core = Core::genesis(LogHeader { schema_version: SCHEMA_VERSION, seed: NO_WAKE_SEED });
    let f = core.state.add_factory(
        "export default function (input, ctx) { ctx.emit(0, input); }".to_owned(),
        fabrico_core::factory::DEFAULT_GAS_BUDGET,
        6,
    );
    let k = core.state.add_sink(fabrico_core::state::SinkTemplate::Debug, 0);
    core.state.link((f, 0), (k, 0));
    if let Some(Node::Factory(factory)) = core.state.node_mut(f) {
        factory
            .pending_emits
            .insert(0, (0..3u8).map(|i| fabrico_core::ids::Item(vec![b'1' + i])).collect());
    }
    if wake {
        core.sched.schedule_wake(f, core.tick);
    }
    NoWakeBoard {
        what,
        bundle: snapshot_only(&core),
        read: Box::new(move |c: &Core| format!("Factory queue holds {}", factory_queue(c, f))),
    }
}

/// A Merge holding 5 items on In 0, feeding a Sink with room, scheduled only when `wake`
/// holds. The class that predates phase 87: an item on an In the machine's step reads.
fn merge_inbox_board(what: &'static str, wake: bool) -> NoWakeBoard {
    let mut core = Core::genesis(LogHeader { schema_version: SCHEMA_VERSION, seed: NO_WAKE_SEED + 1 });
    let m = core.state.add_merge(2);
    let k = core.state.add_sink(fabrico_core::state::SinkTemplate::Debug, 0);
    core.state.link((m, 0), (k, 0));
    for i in 0..5u8 {
        core.state.inbox_mut(m).push(0, u64::from(i), fabrico_core::ids::Item(vec![i]));
    }
    if wake {
        core.sched.schedule_wake(m, core.tick);
    }
    NoWakeBoard {
        what,
        bundle: snapshot_only(&core),
        read: Box::new(move |c: &Core| format!("Merge In 0 holds {}", inbox_len(c, m, 0))),
    }
}

/// What a user meets on opening `board`: the refusal and its sentence, or, if the file opens,
/// the items still waiting after 2000 ticks and again after an edit tick (a `SealHistory`
/// record, the one edit that changes nothing) and 200 more. A stuck board reads the same
/// count at both points; a board that runs drains.
fn no_wake_verdict(board: &NoWakeBoard) -> String {
    let dir = tempfile::tempdir().expect("bundle tempdir");
    let fab = dir.path().join("no-wake.fab");
    std::fs::write(&fab, postcard::to_allocvec(&board.bundle).expect("the forged bundle encodes"))
        .expect("write the forged bundle");
    let load_dir = tempfile::tempdir().expect("load work dir");
    let host = match load_project(&fab, load_dir.path(), None) {
        Ok(h) => h,
        Err(e) => return format!("refused on open: {e:?} / {e}"),
    };
    let mut core = restore(&host.snapshot_bytes()).expect("an opened board's own snapshot restores");
    for _ in 0..2000 {
        core.advance(&[]);
    }
    let after_run = (board.read)(&core);
    let tick = core.tick;
    core.advance_edits(
        &[EditRecord {
            schema_version: EDIT_SCHEMA_VERSION,
            partition: 0,
            sequence: u64::MAX - 1,
            tick,
            action: u64::MAX - 1,
            op: EditOp::SealHistory,
        }],
        &[],
    );
    for _ in 0..200 {
        core.advance(&[]);
    }
    format!("opened; after 2000 ticks: {after_run}; after an edit tick and 200 more: {}", (board.read)(&core))
}

/// THE REFUSAL (threat T-87-28). Each forged file holds a machine with work its own step
/// takes and no wake: a full In 0 behind an asleep feeder and behind a scheduled one (on the
/// palette board and on the audit's Sink board), a Factory's waiting emits, and a Merge's
/// In 0. Each must be refused on open as `MachineWakeMissing`, with the sentence every
/// broken-rule snapshot gets. Every verdict is read before any is graded, so a red names
/// them all.
///
/// Seen red before the fix: every file opened and stayed
/// stuck, reading the same waiting count after 2000 ticks and again after the edit tick.
#[test]
fn a_file_holding_work_with_no_wake_is_refused_on_open() {
    let refused = format!(
        "refused on open: InvalidSnapshot(InvalidState(MachineWakeMissing)) / {SNAPSHOT_RULE_SENTENCE}"
    );
    let boards = [
        feeder_board("a full Factory In with no wake, its Source asleep behind it", true, false),
        feeder_board("a full Factory In with no wake, its Source scheduled", false, false),
        sink_board("a full Sink with no wake, its Source asleep behind it", true, false),
        sink_board("a full Sink with no wake, its Source scheduled", false, false),
        factory_queue_board("a Factory's waiting emits with no wake", false),
        merge_inbox_board("a Merge holding items on In 0 with no wake", false),
    ];
    let verdicts: Vec<String> = boards
        .iter()
        .map(|board| {
            let verdict = no_wake_verdict(board);
            eprintln!("{}: {verdict}", board.what);
            format!("{}: {verdict}", board.what)
        })
        .collect();
    let expected: Vec<String> = boards.iter().map(|b| format!("{}: {refused}", b.what)).collect();
    assert_eq!(verdicts, expected, "every file holding work with no wake is refused on open");
}

/// THE CONTROL (threat T-87-28). The same boards with the stuck machine scheduled at the
/// head tick open, run, and drain, and every board each one reaches (as opened, then each
/// Ctrl+Z and Ctrl+Y on the palette board) saves into a file that opens again. So the
/// refusal is the missing wake's, and the check refuses no board a good file reaches.
#[test]
fn the_same_files_with_their_wake_open_drain_and_every_board_reopens() {
    let drained_feeder = "Factory In 0 holds 0, Source holds 0 (asleep false)";
    let drained_sink = "Sink In 0 holds 0, Source holds 0 (asleep false)";
    for (board, drained) in [
        (feeder_board("the palette board, Source asleep, Factory scheduled", true, true), drained_feeder),
        (feeder_board("the palette board, Source scheduled, Factory scheduled", false, true), drained_feeder),
        (sink_board("the Sink board, Source asleep, Sink scheduled", true, true), drained_sink),
        (sink_board("the Sink board, Source scheduled, Sink scheduled", false, true), drained_sink),
        (factory_queue_board("the Factory queue board, Factory scheduled", true), "Factory queue holds 0"),
        (merge_inbox_board("the Merge board, Merge scheduled", true), "Merge In 0 holds 0"),
    ] {
        let verdict = no_wake_verdict(&board);
        eprintln!("{}: {verdict}", board.what);
        assert_eq!(
            verdict,
            format!("opened; after 2000 ticks: {drained}; after an edit tick and 200 more: {drained}"),
            "{} opens and drains",
            board.what
        );
        let walk = walk_bundle(&board.bundle);
        eprintln!("{}: walk = {walk:#?}", board.what);
        assert!(walk[0].starts_with("opened"), "{} opens; walk: {walk:#?}", board.what);
        assert_every_reachable_board_reopens(&walk, board.what);
    }
}

// ---------------------------------------------------------------------------
// Plan 88-02 (FAIL-09, WINDOWS 81, D-11): a file whose Ctrl+Z no longer fits the board
// ---------------------------------------------------------------------------

/// The Sink's anchor, the two cells of the belt that feeds it (its Head on the Sink's In
/// doorstep), and a Source well clear of both that stays on the board as a witness.
const UF_SINK_AT: (i32, i32) = (20, 20);
const UF_BELT_CELLS: [(i32, i32); 2] = [(18, 20), (19, 20)];
const UF_SOURCE_AT: (i32, i32) = (16, 16);

/// The committed fixture `frontend/e2e-live/88-refusal-sentences.live.spec.ts` leg 4 opens.
fn undo_does_not_fit_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/88-undo-does-not-fit.fab")
}

/// THE BUILDER for `88-undo-does-not-fit.fab`. A real board: a Source at (16,16), a Sink at
/// (20,20), a belt drawn on (18,20) and (19,20) with its Head docked into the Sink's In, and
/// the Sink deleted last (taking the belt with it), each through `apply_gesture` and folded.
/// The save is the shipped `save_project`.
///
/// THE ONE FORGED FIELD, and the `compute_inverse` check it fails (chosen by measurement,
/// `88-EVIDENCE.md` `## Plan 88-02`): the Delete's captured cascade belt keeps its tiles but
/// loses its links, so the capture no longer names which node was the belt. The Delete arm of
/// `GridSession::compute_inverse` asks `identify_belt` for the belt's id after the geometry
/// skip, finds none, and refuses the whole undo group before anything folds: the inverse no
/// longer fits the board, which reaches the user as `UndoDoesNotFit` since plan 88-02 (it was
/// `Malformed`, "The host could not carry out that gesture.", before). The file opens: the
/// load re-folds the forward history and never computes this inverse.
fn undo_does_not_fit_bundle() -> ProjectFile {
    let mut rig = empty_rig();
    for (kind, at) in [(machine_kind::SOURCE, UF_SOURCE_AT), (machine_kind::SINK, UF_SINK_AT)] {
        assert_eq!(
            gesture(&mut rig, None, GridCommand::Place { kind, cell_x: at.0, cell_y: at.1 }),
            Ok(()),
            "measured: a kind {kind} Place on empty floor at {at:?} is accepted"
        );
    }
    let sink = rig.host.core().state.occupied(UF_SINK_AT).expect("the Sink holds its cell");
    assert_eq!(
        gesture(&mut rig, None, GridCommand::DrawBelt { cells: UF_BELT_CELLS.to_vec() }),
        Ok(()),
        "measured: the belt draws on free floor"
    );
    let belt = rig.host.core().state.occupied(UF_BELT_CELLS[0]).expect("the belt holds its first tile");
    let dock = apply_gesture(
        &mut rig.host,
        GridCommand::Dock { belt: 0, endpoint: fabrico_protocol::BeltEnd::Head, node: 1, port: 0 },
        |h| match h {
            0 => Some(belt),
            1 => Some(sink),
            _ => None,
        },
    );
    fold(&mut rig);
    assert_eq!(dock, Ok(()), "measured: the belt's Head docks into the Sink's In");
    assert_eq!(
        gesture(&mut rig, Some(sink), GridCommand::Delete { node: 0 }),
        Ok(()),
        "measured: the Sink's Delete is accepted"
    );
    assert_eq!(rig.host.core().state.node(sink), None, "measured: the Sink is gone");
    assert_eq!(rig.host.core().state.node(belt), None, "measured: and the docked belt with it");
    assert!(rig.host.can_undo(), "measured: the Delete is undoable");

    let save_dir = tempfile::tempdir().expect("save tempdir");
    let fab = save_dir.path().join("undo-does-not-fit.fab");
    save_project(&rig.host, &fab).expect("the real board saves");
    let bytes = std::fs::read(&fab).expect("the saved file reads back");
    let mut bundle: ProjectFile = postcard::from_bytes(&bytes).expect("the saved bundle decodes");

    let last = bundle.edit_log.last_mut().expect("the board has an edit log");
    match &mut last.op {
        EditOp::Delete { node, kind, captured, .. } => {
            assert_eq!(*node, sink, "measured: the last record deletes the Sink");
            assert_eq!(*kind, machine_kind::SINK, "measured: a Sink Delete");
            assert_eq!(captured.belts.len(), 1, "measured: the Delete captured the one docked belt");
            assert_eq!(
                captured.belts[0].geometry.iter().map(|t| t.cell).collect::<Vec<_>>(),
                UF_BELT_CELLS.to_vec(),
                "measured: the capture keeps the belt's two tiles"
            );
            assert!(!captured.belts[0].links.is_empty(), "measured: the real capture names the belt by its links");
            captured.belts[0].links.clear();
        }
        other => panic!("measured: the last record is the Sink's Delete, found {other:?}"),
    }
    bundle
}

/// The fixture's bytes, as the builder makes them today.
fn undo_does_not_fit_bytes() -> Vec<u8> {
    postcard::to_allocvec(&undo_does_not_fit_bundle()).expect("the forged bundle encodes")
}

/// THE WRITER. Ignored: run it (`-- --ignored`) only to regenerate the committed fixture,
/// after a change that the currency test below names.
#[test]
#[ignore = "writer: regenerates tests/fixtures/88-undo-does-not-fit.fab"]
fn write_the_undo_does_not_fit_fixture() {
    std::fs::write(undo_does_not_fit_path(), undo_does_not_fit_bytes()).expect("write the fixture");
}

/// THE CURRENCY TEST. The committed bytes are exactly what the builder makes now.
#[test]
fn the_undo_does_not_fit_fixture_is_current() {
    let committed = std::fs::read(undo_does_not_fit_path()).expect("the fixture is committed");
    assert!(
        committed == undo_does_not_fit_bytes(),
        "tests/fixtures/88-undo-does-not-fit.fab is stale: rebuild it with `cargo test -p \
         fabrico-host --test forged_files -- --ignored` and commit the bytes"
    );
}

/// THE GUARD ON THE HOST (FAIL-09). The committed file opens; Ctrl+Z on it is refused
/// `UndoDoesNotFit`, nothing is placed or logged, the node set and every cell owner are as
/// they were, and the board still saves and opens.
#[test]
fn the_undo_does_not_fit_file_loads_and_its_undo_is_refused_in_its_own_words() {
    let dir = tempfile::tempdir().expect("load work dir");
    let host = match load_project(&undo_does_not_fit_path(), dir.path(), None) {
        Ok(h) => h,
        Err(e) => panic!("the committed fixture must open, got {e:?}"),
    };
    let work = tempfile::tempdir().expect("rig dir");
    let mut rig = rig_over(host, work);
    let edits_before = rig.host.logged_edits().expect("read the edit log").len();
    let nodes_before = nodes(&rig.host);
    let owners_before = owners(&rig.host);
    assert!(rig.host.core().state.occupied(UF_SOURCE_AT).is_some(), "measured: the witness Source is on the board");
    assert_eq!(rig.host.core().state.occupied(UF_SINK_AT), None, "measured: the Sink is deleted");
    assert!(rig.host.can_undo(), "measured: the opened board offers Undo");

    let undo = gesture(&mut rig, None, GridCommand::Undo);
    let facts: Vec<(&'static str, String)> = vec![
        ("undo", dbg(undo)),
        (
            "edits_unchanged",
            (rig.host.logged_edits().expect("read the edit log").len() == edits_before).to_string(),
        ),
        ("nodes_unchanged", (nodes(&rig.host) == nodes_before).to_string()),
        ("owners_unchanged", (owners(&rig.host) == owners_before).to_string()),
        ("can_undo", rig.host.can_undo().to_string()),
        ("save_and_load", save_and_load(&rig.host)),
    ];
    for (k, v) in &facts {
        eprintln!("undo_does_not_fit {k} = {v}");
    }
    let expected: Vec<(&'static str, String)> = vec![
        // Spelled as text so this leg compiled, and was seen red, before the tag existed.
        ("undo", "Err(UndoDoesNotFit)".to_owned()),
        ("edits_unchanged", "true".to_owned()),
        ("nodes_unchanged", "true".to_owned()),
        ("owners_unchanged", "true".to_owned()),
        ("can_undo", "true".to_owned()),
        ("save_and_load", "Ok".to_owned()),
    ];
    assert_eq!(facts, expected, "the forged Undo is refused in its own words and changes nothing");
}
