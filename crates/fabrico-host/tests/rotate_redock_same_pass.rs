//! Phase 89 (BELT-07, D-08): a turn away and a turn back queued on a PAUSED board end
//! docked after Play, and step back one at a time on Undo.
//!
//! WHY THIS IS A HOST TEST AND NOT A SESSION TEST (research Pitfall 1 and assumption A3).
//! `SimLoop::acquire_input` applies every queued gesture through `apply_gesture` with no
//! fold between them, and a paused board queues every gesture until Play, so R then
//! Shift+R on a paused board are validated against the board BEFORE either folds. Until
//! plan 89-02 the host's lookup replayed pending rotations and Docks but not the severances
//! a pending Rotate causes (those are derived inside the fold), so the second Rotate saw the
//! belt still docked on its original port. The whole pass then folds in ONE
//! `GridSession::fold_live` call (`crates/fabrico-host/src/driver.rs`), where
//! `attribute_severances` (`crates/fabrico-command/src/command.rs`) keyed the severances
//! by node and checked with a `debug_assert!` that no batch names one node in two
//! severing records (it fired here at `PHASE89_START`). Since plan 89-02 the host answers
//! the turn back's dock read from the board the fold will see, and a batch naming one node
//! twice is attributed record by record. A headless `GridSession` test folds each command
//! alone and can see none of this.
//!
//! THE HARNESS is `label_same_pass.rs`'s, copied: consecutive `apply_gesture` calls with
//! no `tick_once` between them ARE the paused drain pass ([`pass`]), and [`fold`] is the
//! tick Play runs. Every leg runs on [`demo_host`], the board the shipped app boots. The
//! Audit Sink at (14,4) and belt 21 (cells (11,4) to (13,4), its Head docked to the
//! Sink's In) are found by cell, never by a handle number.
//!
//! RED FIRST (D-01, D-16): both legs were written at `PHASE89_START` and seen FAILED
//! there; plan 89-02 removed each `#[ignore]` and changed nothing else. A panic in
//! `attribute_severances` counts as FAILED. Each leg asserts ONE labelled-pair `Vec` in
//! ONE `assert_eq!` (`label_same_pass.rs`'s rule), so a red prints every fact.

use fabrico_command::{CommandError, GridSession};
use fabrico_core::command::{Command, ResultEvent};
use fabrico_core::core::Core;
use fabrico_core::edit::{EditOp, EditRecord};
use fabrico_core::event::{EventPayload, LogHeader, SCHEMA_VERSION};
use fabrico_core::ids::{NodeId, PortId};
use fabrico_core::persist::RedbStore;
use fabrico_core::state::{Footprint, GridState, Node};
use fabrico_host::demo_scene::{DEMO_GENESIS_SEED, demo_commands, seed_scene};
use fabrico_host::driver::Host;
use fabrico_host::input_apply::apply_gesture;
use fabrico_host::ledger::DispatchLedger;
use fabrico_protocol::{BeltEnd, GridCommand, machine_kind};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};

/// A demo-booted host plus the channel triple `tick_once` requires (`label_same_pass.rs`).
struct Probe {
    host: Host,
    ingress_rx: UnboundedReceiver<EventPayload>,
    results_rx: UnboundedReceiver<ResultEvent>,
    cmd_tx: UnboundedSender<Command>,
    _ingress_tx: UnboundedSender<EventPayload>,
    _res_tx: UnboundedSender<ResultEvent>,
    _cmd_rx: UnboundedReceiver<Command>,
    _dirs: Vec<tempfile::TempDir>,
}

/// A `Host` booted the way the shipped app boots (genesis at [`DEMO_GENESIS_SEED`], the
/// demo's commands through `seed_scene`). No timers, so the board stays quiescent.
fn demo_host() -> Probe {
    host_with(&demo_commands()).0
}

/// A `Host` booted from genesis at [`DEMO_GENESIS_SEED`] with `commands` folded through
/// `seed_scene` (one command per tick, the shipped applier), and the mint-order ledger it
/// returns (scene handle `h` is `ledger[h]`).
fn host_with(commands: &[GridCommand]) -> (Probe, Vec<NodeId>) {
    let dir = tempfile::tempdir().expect("tempdir");
    let core = Core::genesis(LogHeader { schema_version: SCHEMA_VERSION, seed: DEMO_GENESIS_SEED });
    let store = RedbStore::open(dir.path().join("log.redb")).expect("open log");
    let ledger = DispatchLedger::open(dir.path().join("ledger.redb")).expect("open ledger");
    let mut host = Host::new(core, store, ledger, None).expect("open host");
    let minted = seed_scene(&mut host, commands).expect("seed_scene folds every scene command");
    let (ingress_tx, ingress_rx) = unbounded_channel::<EventPayload>();
    let (cmd_tx, cmd_rx) = unbounded_channel::<Command>();
    let (res_tx, results_rx) = unbounded_channel::<ResultEvent>();
    let probe = Probe {
        host,
        ingress_rx,
        results_rx,
        cmd_tx,
        _ingress_tx: ingress_tx,
        _res_tx: res_tx,
        _cmd_rx: cmd_rx,
        _dirs: vec![dir],
    };
    (probe, minted)
}

/// The same `commands` folded headlessly: a `GridSession` from [`DEMO_GENESIS_SEED`]
/// applying them one at a time (applier B of `demo_regenerability.rs`), sealed at the same
/// point `seed_scene` seals, with its mint-order ledger.
fn session_with(commands: &[GridCommand]) -> (GridSession, Vec<NodeId>) {
    let mut session = GridSession::new(DEMO_GENESIS_SEED);
    let mut minted = Vec::new();
    for cmd in commands {
        session.apply(cmd.clone()).expect("the session accepts every scene command");
        minted.extend(session.core().last_tick.placed.iter().copied());
    }
    session.seal_history().expect("the session seals its history");
    (session, minted)
}

/// The op names of `records`, in order: what one producer logged, comparable across two.
fn op_names(records: &[EditRecord]) -> Vec<&'static str> {
    records
        .iter()
        .map(|r| match r.op {
            EditOp::Place { .. } => "Place",
            EditOp::Delete { .. } => "Delete",
            EditOp::Rotate { .. } => "Rotate",
            EditOp::Dock { .. } => "Dock",
            EditOp::Unlink { .. } => "Unlink",
            EditOp::DrawBelt { .. } => "DrawBelt",
            EditOp::DrawWire { .. } => "DrawWire",
            EditOp::Configure { .. } => "Configure",
            EditOp::AddPort { .. } => "AddPort",
            EditOp::RemovePort { .. } => "RemovePort",
            EditOp::Undo { .. } => "Undo",
            EditOp::Redo { .. } => "Redo",
            EditOp::SealHistory => "SealHistory",
        })
        .collect()
}

/// A link with each side named by cell (see [`named_links`]).
type NamedLink = (((i32, i32), PortId), ((i32, i32), PortId));

/// Every link touching `node`, each side named by where it stands (a machine by its anchor
/// cell, a belt by its Tail tile), so two producers compare without sharing ids.
fn named_links(state: &GridState, node: NodeId) -> Vec<NamedLink> {
    let at = |id: NodeId| -> (i32, i32) {
        match state.node(id) {
            Some(Node::Belt(b)) => b.geometry.first().map_or((i32::MIN, i32::MIN), |t| t.cell),
            _ => state.cell_of(id).unwrap_or((i32::MIN, i32::MIN)),
        }
    };
    state
        .links_iter()
        .filter(|(from, to)| from.0 == node || to.0 == node)
        .map(|(from, to)| ((at(from.0), from.1), (at(to.0), to.1)))
        .collect()
}

/// Fold ONE tick: what Play runs after the drain pass.
fn fold(probe: &mut Probe) {
    probe
        .host
        .tick_once(&mut probe.ingress_rx, &mut probe.results_rx, &probe.cmd_tx)
        .expect("tick_once persists and folds");
}

/// Apply `cmds` through `apply_gesture` in order, every handle resolved through ONE
/// table, with NO fold between them (one drain pass), and return every verdict.
fn pass(probe: &mut Probe, table: &[(u64, NodeId)], cmds: Vec<GridCommand>) -> Vec<Result<(), CommandError>> {
    cmds.into_iter()
        .map(|cmd| apply_gesture(&mut probe.host, cmd, |h| table.iter().find(|(k, _)| *k == h).map(|(_, n)| *n)))
        .collect()
}

/// The Audit Sink (on cell (14,4)) and belt 21 (on cell (12,4)), found by cell.
fn audit_pair(probe: &Probe) -> (NodeId, NodeId) {
    let st = &probe.host.core().state;
    let sink = st.occupied((14, 4)).expect("the Audit Sink stands on (14,4)");
    let belt = st.occupied((12, 4)).expect("belt 21 runs over (12,4)");
    (sink, belt)
}

/// Every link joining `belt` and `node`, either direction.
fn links_between(probe: &Probe, belt: NodeId, node: NodeId) -> Vec<((NodeId, PortId), (NodeId, PortId))> {
    probe
        .host
        .core()
        .state
        .links_iter()
        .filter(|(from, to)| (from.0 == belt && to.0 == node) || (from.0 == node && to.0 == belt))
        .collect()
}

/// A node's live rotation.
fn rot_of(probe: &Probe, id: NodeId) -> u8 {
    probe.host.core().state.footprint_of(id).unwrap_or(Footprint { w: 1, h: 1, rot: 0 }).rot
}

/// Debug text of any fact, for the labelled-pair `Vec`.
fn dbg<T: std::fmt::Debug>(v: T) -> String {
    format!("{v:?}")
}

/// Handles the gestures below address: 1 the Sink.
const SINK_H: u64 = 1;

/// R then Shift+R on the Audit Sink, both queued in one paused drain pass, then Play:
/// the Sink is back at rot 0 and belt 21's Head is docked to its In, exactly as before.
#[test]
fn a_paused_turn_away_and_back_ends_docked_after_play() {
    let mut probe = demo_host();
    let (sink, belt) = audit_pair(&probe);
    let before = links_between(&probe, belt, sink);
    let table = [(SINK_H, sink)];
    let verdicts = pass(
        &mut probe,
        &table,
        vec![
            GridCommand::Rotate { node: SINK_H, ccw: false },
            GridCommand::Rotate { node: SINK_H, ccw: true },
        ],
    );
    let folded = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| fold(&mut probe)));
    let after = links_between(&probe, belt, sink);
    eprintln!(
        "P89-BELT-07-paused away-and-back verdicts={verdicts:?} folded_ok={} rot={} before={before:?} after={after:?}",
        folded.is_ok(),
        rot_of(&probe, sink)
    );
    if let Err(p) = folded {
        std::panic::resume_unwind(p);
    }
    assert_eq!(
        vec![
            ("verdicts", dbg(&verdicts)),
            ("before_links", dbg(before.len())),
            ("rot", dbg(rot_of(&probe, sink))),
            ("after_links", dbg(&after)),
        ],
        vec![
            ("verdicts", dbg(vec![Ok::<(), CommandError>(()), Ok(())])),
            ("before_links", dbg(1usize)),
            ("rot", dbg(0u8)),
            ("after_links", dbg(&before)),
        ],
        "a turn away and back queued on a paused board ends with belt 21 docked to the Sink after Play"
    );
}

/// The same paused pass, then two Undos: the first steps back over the turn back (rot 1,
/// no link: the turn back and the dock it made go together), the second over the turn away
/// (rot 0, docked again by CONNECT-03's compensation). The leg first reads the board after
/// Play, which must be docked, so it cannot pass on a build whose turn back docks nothing.
#[test]
fn two_undos_after_a_paused_turn_away_and_back_step_back_once_each() {
    let mut probe = demo_host();
    let (sink, belt) = audit_pair(&probe);
    let before = links_between(&probe, belt, sink);
    let table = [(SINK_H, sink)];
    let verdicts = pass(
        &mut probe,
        &table,
        vec![
            GridCommand::Rotate { node: SINK_H, ccw: false },
            GridCommand::Rotate { node: SINK_H, ccw: true },
        ],
    );
    let mut facts: Vec<(&'static str, String)> = vec![("verdicts", dbg(&verdicts))];
    let folded = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| fold(&mut probe)));
    eprintln!("P89-BELT-07-paused two-undos folded_ok={}", folded.is_ok());
    if let Err(p) = folded {
        std::panic::resume_unwind(p);
    }
    facts.push(("played_rot", dbg(rot_of(&probe, sink))));
    facts.push(("played_links", dbg(links_between(&probe, belt, sink))));

    let u1 = pass(&mut probe, &[], vec![GridCommand::Undo]);
    fold(&mut probe);
    let (sink1, belt1) = audit_pair(&probe);
    let first = (rot_of(&probe, sink1), links_between(&probe, belt1, sink1));
    facts.push(("undo1", dbg(&u1)));
    facts.push(("undo1_rot", dbg(first.0)));
    facts.push(("undo1_links", dbg(first.1.len())));

    let u2 = pass(&mut probe, &[], vec![GridCommand::Undo]);
    let undone = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| fold(&mut probe)));
    eprintln!("P89-BELT-07-paused two-undos second_fold_ok={} facts={facts:?}", undone.is_ok());
    if let Err(p) = undone {
        std::panic::resume_unwind(p);
    }
    let (sink2, belt2) = audit_pair(&probe);
    facts.push(("undo2", dbg(&u2)));
    facts.push(("undo2_rot", dbg(rot_of(&probe, sink2))));
    // Review WR-A-03: the EXACT link, never a count. A Sink holds an In and a Fault, so one
    // link between the pair cannot tell the In restored from a dock keyed on the wrong port.
    // Neither node is deleted in this leg, so the cell lookup finds the same ids.
    facts.push(("undo2_ids", dbg((sink2 == sink, belt2 == belt))));
    facts.push(("undo2_links", dbg(links_between(&probe, belt2, sink2))));
    eprintln!("P89-BELT-07-paused two-undos facts={facts:?}");

    assert_eq!(
        facts,
        vec![
            ("verdicts", dbg(vec![Ok::<(), CommandError>(()), Ok(())])),
            ("played_rot", dbg(0u8)),
            ("played_links", dbg(&before)),
            ("undo1", dbg(vec![Ok::<(), CommandError>(())])),
            ("undo1_rot", dbg(1u8)),
            ("undo1_links", dbg(0usize)),
            ("undo2", dbg(vec![Ok::<(), CommandError>(())])),
            ("undo2_rot", dbg(0u8)),
            ("undo2_ids", dbg((true, true))),
            ("undo2_links", dbg(&before)),
        ],
        "two Undos after a paused turn away and back step back one turn each"
    );
}

/// Review CR-A-01 (2026-10-23): on a paused board a belt drawn EARLIER in the pass is docked
/// by a later turn whose In now faces its Head, exactly as the headless session docks it.
///
/// The pass is a DrawBelt over (14,7) to (14,5), Head flowing North onto (14,5), then a
/// counter-clockwise turn of the Audit Sink, which puts its In on the South edge facing that
/// Head. The headless `GridSession` folds the DrawBelt before it validates the Rotate, so its
/// turn group is `[Rotate, Dock]`. Until the fix the host read the doorstep from its pending
/// replay, where a pending belt is the reserved null id with no geometry, so its group was a
/// bare `[Rotate]` and the Sink sat facing the Head with no link.
///
/// Both producers' records and links are graded in ONE `assert_eq!`, each link named by
/// cells, so the leg reads red on the missing Dock and on any Dock that names the wrong end.
#[test]
fn a_belt_drawn_earlier_in_a_paused_pass_is_docked_by_a_later_turn() {
    let cells = vec![(14, 7), (14, 6), (14, 5)];
    let mut probe = demo_host();
    let (sink, _) = audit_pair(&probe);
    let table = [(SINK_H, sink)];
    let logged = probe.host.pending_edits().len();
    let verdicts = pass(
        &mut probe,
        &table,
        vec![GridCommand::DrawBelt { cells: cells.clone() }, GridCommand::Rotate { node: SINK_H, ccw: true }],
    );
    let host_ops = op_names(&probe.host.pending_edits()[logged..]);
    fold(&mut probe);
    let host_links = named_links(&probe.host.core().state, sink);

    let (mut session, minted) = session_with(&demo_commands());
    let s_sink = minted[4];
    let s_handle = session.view().handle_of(s_sink).expect("the Audit Sink has a handle");
    let before = session.edit_log().len();
    session.apply(GridCommand::DrawBelt { cells }).expect("the session draws the belt");
    session.apply(GridCommand::Rotate { node: s_handle, ccw: true }).expect("the session turns the Sink");
    let session_ops = op_names(&session.edit_log()[before..]);
    let session_links = named_links(&session.core().state, s_sink);
    eprintln!(
        "P89-CR-A-01 verdicts={verdicts:?} host_ops={host_ops:?} session_ops={session_ops:?} host_links={host_links:?} session_links={session_links:?}"
    );

    let docked: Vec<NamedLink> = vec![(((14, 7), 0), ((14, 4), 0))];
    assert_eq!(
        vec![
            ("verdicts", dbg(&verdicts)),
            ("session_ops", dbg(&session_ops)),
            ("host_ops", dbg(&host_ops)),
            ("session_links", dbg(&session_links)),
            ("host_links", dbg(&host_links)),
        ],
        vec![
            ("verdicts", dbg(vec![Ok::<(), CommandError>(()), Ok(())])),
            ("session_ops", dbg(vec!["DrawBelt", "Rotate", "Dock"])),
            ("host_ops", dbg(vec!["DrawBelt", "Rotate", "Dock"])),
            ("session_links", dbg(&docked)),
            ("host_links", dbg(&docked)),
        ],
        "a turn on a paused board docks a belt drawn earlier in the same pass, as the session does"
    );
}

/// Review WR-A-01 (2026-10-23): on a paused board a turn never docks a belt an earlier
/// Delete in the same pass removes along with its machine.
///
/// The board: a Source at (0,0) whose Out feeds belt B over (1,0) to (3,0), Head loose on
/// (3,0) flowing East, and a Sink at (4,0) turned once so its In faces North. The pass
/// deletes the Source (the fold removes B with it, one hop) and turns the Sink back
/// counter-clockwise, so its In faces B's Head cell. The headless session sees B gone and
/// logs a bare Rotate. Until the fix the host read B's cells and geometry from the pre-pass
/// core and logged a dead `Dock { belt: B, .. }` in the turn's group.
#[test]
fn a_turn_never_docks_a_belt_an_earlier_delete_in_the_pass_removes() {
    let scene = vec![
        GridCommand::Place { kind: machine_kind::SOURCE, cell_x: 0, cell_y: 0 },
        GridCommand::Place { kind: machine_kind::SINK, cell_x: 4, cell_y: 0 },
        GridCommand::Rotate { node: 1, ccw: false },
        GridCommand::DrawBelt { cells: vec![(1, 0), (2, 0), (3, 0)] },
        GridCommand::Dock { belt: 2, endpoint: BeltEnd::Tail, node: 0, port: 0 },
    ];
    let (mut probe, minted) = host_with(&scene);
    let (source, sink, belt) = (minted[0], minted[1], minted[2]);
    let precondition = (
        named_links(&probe.host.core().state, belt),
        named_links(&probe.host.core().state, sink),
    );
    let table = [(1u64, source), (2u64, sink)];
    let logged = probe.host.pending_edits().len();
    let verdicts = pass(
        &mut probe,
        &table,
        vec![GridCommand::Delete { node: 1 }, GridCommand::Rotate { node: 2, ccw: true }],
    );
    let host_ops = op_names(&probe.host.pending_edits()[logged..]);
    fold(&mut probe);
    let host_after = (probe.host.core().state.node(belt).is_some(), named_links(&probe.host.core().state, sink));

    let (mut session, s_minted) = session_with(&scene);
    let handle = |id: NodeId| session.view().handle_of(id).expect("a live handle");
    let (s_source, s_sink) = (handle(s_minted[0]), handle(s_minted[1]));
    let before = session.edit_log().len();
    session.apply(GridCommand::Delete { node: s_source }).expect("the session deletes the Source");
    session.apply(GridCommand::Rotate { node: s_sink, ccw: true }).expect("the session turns the Sink");
    let session_ops = op_names(&session.edit_log()[before..]);
    eprintln!(
        "P89-WR-A-01 precondition={precondition:?} verdicts={verdicts:?} host_ops={host_ops:?} session_ops={session_ops:?} host_after={host_after:?}"
    );

    assert_eq!(
        vec![
            ("precondition_belt", dbg(&precondition.0)),
            ("precondition_sink", dbg(&precondition.1)),
            ("verdicts", dbg(&verdicts)),
            ("session_ops", dbg(&session_ops)),
            ("host_ops", dbg(&host_ops)),
            ("host_after", dbg(&host_after)),
        ],
        vec![
            ("precondition_belt", dbg(vec![(((0, 0), 0u16), ((1, 0), 0u16))])),
            ("precondition_sink", dbg(Vec::<NamedLink>::new())),
            ("verdicts", dbg(vec![Ok::<(), CommandError>(()), Ok(())])),
            ("session_ops", dbg(vec!["Delete", "Rotate"])),
            ("host_ops", dbg(vec!["Delete", "Rotate"])),
            ("host_after", dbg((false, Vec::<NamedLink>::new()))),
        ],
        "a turn on a paused board logs no Dock onto a belt an earlier Delete in the pass removes"
    );
}
