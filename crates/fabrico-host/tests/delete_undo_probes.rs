//! Probes for the Delete-capture and turned-Delete defects next to phase 76's label work
//! (plan 76-12). Each probe measures one shape on the board the shipped app boots and
//! asserts the HEALTHY outcome, so a red names the defect and a green pins the fix.
//!
//! WHAT EACH PROBE MEASURES
//! - [`probe_p1`]: a growing AddPort then a Delete of the same unturned Factory in ONE
//!   drain pass, then Undo. Red until plan 86-05: `apply_gesture` captured the Delete
//!   from the board before the pass, so the add was missing from what came back. Since
//!   86-05 the whole capture is read from the board the fold sees, so it is a plain test.
//! - [`probe_p2`]: an Undo whose group carries a shrinking `RemovePort { restore: Some }`,
//!   a Place on the row it frees and a Delete of the Factory, in ONE pass, then Undo. A
//!   capture of the 3 by 4 box before the pass re-Placed it on the Source. No live drain
//!   forms this pass (see its doc comment); plan 86-05 grades it anyway, because the
//!   capture rule must hold for any record order the host accepts.
//! - [`probe_p3`]: a growing AddPort then a Delete of a TURNED Factory in ONE pass, then
//!   Undo. It needed BOTH todos fixed (the add was lost AND the turn was lost): the turn
//!   came back with plan 86-02, the add with plan 86-05. A plain test since 86-05.
//! - [`probe_p3_box_stays_inside_what_the_machine_held`]: the same shape, graded on one
//!   fact only: every cell the restored Factory holds was the Factory's when it was
//!   deleted. A same-pass capture fix landed without the turned fix would re-Place a 3 by
//!   4 box at rot 0 and break it; it stays green with both.
//! - [`probe_p4`]: a Router turned once, a Source on a cell only its rot-0 body covers,
//!   the Router deleted, Undo, each step in its own pass. Red until plan 86-02 (EDIT 13):
//!   `DeletedSubgraph` had no rotation and the Delete inverse re-Placed at rot 0. Now the
//!   capture records the turn and the re-Place claims the turned box in one step, so it
//!   is a plain test.
//! - [`probe_p4l`]: the same with a LABEL as the victim. A red here is an open D-01
//!   violation: a machine on a label's cell, and a saved board that fails to load. Plain
//!   since plan 86-02, like `probe_p4`.
//!   P4 and P4L grade the D-01 facts (the victim keeps its cells, the board restores,
//!   saves and loads) and accept EITHER fix route the turned-Delete todo names: the
//!   Undo brings the Router back turned, or the host refuses the Undo and places
//!   nothing. Plan 86-02 took the first route (D-03).
//! - `probe_c1` to `probe_c7` (76-12 refuter round): a record earlier in the same drain
//!   pass that takes a belt or a wire out of a Delete's cascade (Unlink, Rotate, a Delete
//!   of the belt, the wire or a neighbour sharing it). Each runs one gesture list in one
//!   pass and one pass per gesture and grades the two boards equal. Plain tests: they
//!   pinned the 76-12 cascade prune, and since plan 86-05 the one-board capture that
//!   replaced it.
//! - [`probe_c8_delete_then_its_cascade_belt`] and [`probe_c9_delete_then_its_wire`] (phase
//!   86 review, CR-01): the other order, the machine first and then the belt or the cable its
//!   Delete takes with it. Red before the fix: the second Delete was accepted with a capture
//!   read off nothing, and its Undo was refused `Malformed` on every press. The host now
//!   refuses it as separate passes do (`UnknownNode`) and one Ctrl+Z brings the board back.
//! - [`probe_d1_dock_then_delete`] and [`probe_d2_draw_wire_then_delete`] (plan 86-05, the
//!   Dock and DrawWire row of the same-pass todo): a belt docked, or a cable drawn, to the
//!   machine earlier in the pass puts it INTO the cascade. Measured red at the start of
//!   86-05 (the Undo brought the machine back without the belt, or without the cable);
//!   plain tests since, in the `probe_c*` shape.
//!
//! THE IGNORE RULE
//! A probe measured red is kept `#[ignore = "open defect: <todo path>"]`, naming EVERY
//! todo whose fix it needs, so it never reddens a gate and turns green the day those
//! todos are fixed (run the file with `--include-ignored` to see it). A probe measured green is a plain test and pins the
//! healthy outcome. Every probe prints each fact it reads (`eprintln!`) and asserts ONE
//! labelled-pair `Vec`, so a red reads `FAILED` with every fact.
//!
//! The helpers are copied from `label_same_pass.rs` (an integration test file cannot
//! import another's).

use fabrico_command::CommandError;
use fabrico_core::command::{Command, ResultEvent};
use fabrico_core::core::Core;
use fabrico_core::edit::EditOp;
use fabrico_core::event::{EventPayload, LogHeader, SCHEMA_VERSION};
use fabrico_core::ids::NodeId;
use fabrico_core::persist::RedbStore;
use fabrico_core::snapshot::{restore, snapshot};
use fabrico_core::state::{Footprint, Node, Side};
use fabrico_host::demo_scene::{DEMO_GENESIS_SEED, demo_commands, seed_scene};
use fabrico_host::driver::Host;
use fabrico_host::input_apply::apply_gesture;
use fabrico_host::ledger::DispatchLedger;
use fabrico_host::project::{load_project, save_project};
use fabrico_protocol::{GridCommand, machine_kind, port_medium, port_role};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};

/// A demo-booted host plus the channel triple `tick_once` requires.
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

/// A `Host` booted the way the shipped app boots: genesis at [`DEMO_GENESIS_SEED`], the
/// demo's commands through `seed_scene` (the request pair included, every node logged).
fn demo_host() -> Probe {
    let dir = tempfile::tempdir().expect("tempdir");
    let core = Core::genesis(LogHeader {
        schema_version: SCHEMA_VERSION,
        seed: DEMO_GENESIS_SEED,
    });
    let store = RedbStore::open(dir.path().join("log.redb")).expect("open log");
    let ledger = DispatchLedger::open(dir.path().join("ledger.redb")).expect("open ledger");
    let mut host = Host::new(core, store, ledger, None).expect("open host");
    seed_scene(&mut host, &demo_commands()).expect("seed_scene folds every demo command");

    let (ingress_tx, ingress_rx) = unbounded_channel::<EventPayload>();
    let (cmd_tx, cmd_rx) = unbounded_channel::<Command>();
    let (res_tx, results_rx) = unbounded_channel::<ResultEvent>();
    Probe {
        host,
        ingress_rx,
        results_rx,
        cmd_tx,
        _ingress_tx: ingress_tx,
        _res_tx: res_tx,
        _cmd_rx: cmd_rx,
        _dirs: vec![dir],
    }
}

/// Fold ONE tick.
fn fold(probe: &mut Probe) {
    probe
        .host
        .tick_once(&mut probe.ingress_rx, &mut probe.results_rx, &probe.cmd_tx)
        .expect("tick_once persists and folds");
}

/// Place a `kind` at `cell`, fold it, and return the minted id.
fn place(probe: &mut Probe, kind: u8, cell: (i32, i32)) -> NodeId {
    apply_gesture(
        &mut probe.host,
        GridCommand::Place { kind, cell_x: cell.0, cell_y: cell.1 },
        |_| None,
    )
    .expect("the place is accepted");
    fold(probe);
    probe.host.core().last_tick.placed[0]
}

/// Apply `cmds` in order through ONE handle table with NO fold between them (one
/// `acquire_input` drain pass) and return every verdict.
fn pass(probe: &mut Probe, table: &[(u64, NodeId)], cmds: Vec<GridCommand>) -> Vec<Result<(), CommandError>> {
    cmds.into_iter()
        .map(|cmd| {
            apply_gesture(&mut probe.host, cmd, |h| {
                table.iter().find(|(k, _)| *k == h).map(|(_, n)| *n)
            })
        })
        .collect()
}

/// The snapshot trust gate: `restore(&snapshot(core))`'s error, `None` when it loads.
fn restores(core: &Core) -> Option<String> {
    restore(&snapshot(core)).err().map(|e| format!("{e:?}"))
}

fn dbg<T: std::fmt::Debug>(v: T) -> String {
    format!("{v:?}")
}

/// The panel's `+ Add output` on handle 0.
fn add_out() -> GridCommand {
    GridCommand::AddPort {
        node: 0,
        role: port_role::OUT,
        side: Side::E as u8,
        medium: port_medium::MECHANICAL,
    }
}

/// `save_project` then `load_project` on a fresh work dir, each as its verdict text.
fn save_and_load(host: &Host) -> (String, String) {
    let save_dir = tempfile::tempdir().expect("save tempdir");
    let fab = save_dir.path().join("delete_undo_probe.fab");
    let saved = save_project(host, &fab);
    let load_dir = tempfile::tempdir().expect("load work dir");
    let loaded = match load_project(&fab, load_dir.path(), None) {
        Ok(_) => "Ok(())".to_owned(),
        Err(e) => dbg(Err::<(), _>(e)),
    };
    (dbg(&saved), loaded)
}

/// Print every fact under the probe's name, then assert them in one `assert_eq!`.
fn grade(name: &str, facts: &[(&'static str, String)], expected: &[(&'static str, String)]) {
    for (k, v) in facts {
        eprintln!("{name} {k} = {v}");
    }
    assert_eq!(facts, expected, "{name}: the healthy outcome");
}

/// The id of the one node of kind `pick` owning any cell of the window x `xs`, y `ys`.
fn node_in(core: &Core, xs: std::ops::RangeInclusive<i32>, ys: std::ops::RangeInclusive<i32>, pick: fn(&Node) -> bool) -> Option<NodeId> {
    let mut found: Vec<NodeId> = Vec::new();
    for y in ys {
        for x in xs.clone() {
            if let Some(n) = core.state.occupied((x, y))
                && core.state.node(n).is_some_and(pick)
                && !found.contains(&n)
            {
                found.push(n);
            }
        }
    }
    assert!(found.len() <= 1, "measured: at most one such node in the window, found {found:?}");
    found.first().copied()
}

fn is_factory(n: &Node) -> bool {
    matches!(n, Node::Factory(_))
}

/// The Delete record for `node` in the edit log: `(cell_x, cell_y, captured w, captured
/// h, captured port count)`.
fn logged_delete(probe: &Probe, node: NodeId) -> Option<(i32, i32, u16, u16, usize)> {
    probe.host.logged_edits().expect("read the edit log").iter().rev().find_map(|r| match &r.op {
        EditOp::Delete { node: n, cell_x, cell_y, captured, .. } if *n == node => {
            Some((*cell_x, *cell_y, captured.w, captured.h, captured.ports.len()))
        }
        _ => None,
    })
}

/// A Factory at `cell`, optionally turned once clockwise, then two `add_out`s, every
/// step folded. Asserts the window x 17 to 24, y 18 to 25 held no Factory first.
fn factory_with_two_outs(probe: &mut Probe, cell: (i32, i32), turned: bool) -> NodeId {
    assert_eq!(
        node_in(probe.host.core(), 17..=24, 18..=25, |_| true),
        None,
        "measured: the probe window is clear floor"
    );
    let f = place(probe, machine_kind::FACTORY, cell);
    if turned {
        let t = pass(probe, &[(0, f)], vec![GridCommand::Rotate { node: 0, ccw: false }]);
        assert_eq!(t, vec![Ok(())], "measured: an undocked Factory turns on clear floor");
        fold(probe);
    }
    for _ in 0..2 {
        let v = pass(probe, &[(0, f)], vec![add_out()]);
        assert_eq!(v, vec![Ok(())], "measured: an add on clear floor is accepted");
        fold(probe);
    }
    assert_eq!(
        probe.host.core().state.footprint_of(f),
        Some(Footprint { w: 3, h: 3, rot: u8::from(turned) }),
        "measured: a two-output Factory is 3 by 3"
    );
    f
}

/// The Factory as it stands after ONE more `add_out` folds, measured on its own
/// demo-booted host: `(anchor, footprint, ports)`.
fn factory_after_third_add(cell: (i32, i32), turned: bool) -> (String, String, String) {
    let mut probe = demo_host();
    let f = factory_with_two_outs(&mut probe, cell, turned);
    let v = pass(&mut probe, &[(0, f)], vec![add_out()]);
    assert_eq!(v, vec![Ok(())], "measured: the third add on clear floor is accepted");
    fold(&mut probe);
    let core = probe.host.core();
    (
        dbg(core.state.cell_of(f)),
        dbg(core.state.footprint_of(f)),
        dbg(core.state.ports_of(f).map(<[_]>::to_vec)),
    )
}

/// P1: a Factory at (20,20) with two outputs (3 by 3, rot 0). ONE pass: `add_out`, then
/// Delete the Factory; fold; Undo; fold. Healthy: the Factory comes back as it stood
/// after the add (anchor, footprint and port list measured on a second host) and the
/// board loads.
#[test]
fn probe_p1() {
    let (ref_anchor, ref_fp, ref_ports) = factory_after_third_add((20, 20), false);
    let mut probe = demo_host();
    let f = factory_with_two_outs(&mut probe, (20, 20), false);
    let v = pass(&mut probe, &[(0, f)], vec![add_out(), GridCommand::Delete { node: 0 }]);
    fold(&mut probe);
    let logged = logged_delete(&probe, f);
    let undo = pass(&mut probe, &[], vec![GridCommand::Undo]);
    fold(&mut probe);
    let core = probe.host.core();
    let back = node_in(core, 17..=24, 18..=25, is_factory);
    let facts: Vec<(&'static str, String)> = vec![
        ("add", dbg(v[0])),
        ("delete", dbg(v[1])),
        ("logged_delete_cell_and_capture", dbg(logged)),
        ("undo", dbg(undo[0])),
        ("restored_anchor", dbg(back.and_then(|n| core.state.cell_of(n)))),
        ("restored_fp", dbg(back.and_then(|n| core.state.footprint_of(n)))),
        ("restored_ports", dbg(back.and_then(|n| core.state.ports_of(n)).map(<[_]>::to_vec))),
        ("restores", dbg(restores(core))),
    ];
    let mut expected = facts.clone();
    expected[0].1 = "Ok(())".to_owned();
    expected[1].1 = "Ok(())".to_owned();
    expected[2].1 = facts[2].1.clone(); // printed, not graded
    expected[3].1 = "Ok(())".to_owned();
    expected[4].1 = ref_anchor;
    expected[5].1 = ref_fp;
    expected[6].1 = ref_ports;
    expected[7].1 = "None".to_owned();
    grade("probe_p1", &facts, &expected);
}

/// P2: the same Factory with a third `add_out` folded (3 by 4, row y 23 claimed). Then,
/// with no fold between: Undo (its group's RemovePort carries `restore`, freeing row
/// y 23), Place a Source at (20,23), Delete the Factory; fold; Undo (the Delete); fold.
/// Healthy: the Source keeps (20,23) and the board saves and loads.
///
/// The live drain never forms this pass: `acquire_input` applies an Undo only at the
/// start of a pass and ends the pass after it (`sim_loop.rs` 1982-1995, the `break` at
/// 2059), and the panel's RemovePort freezes `restore: None` (`command.rs` 2549). Read
/// from code. It is graded anyway (D-10), because the capture rule must hold for any record
/// order the host accepts: red until plan 86-05 (the pre-pass 3 by 4 box was re-Placed over
/// the Source and the saved board did not load, `CellCollision`); since 86-05 the Delete is
/// captured at the 3 by 3 box the Undo's RemovePort leaves, so it is a plain test.
#[test]
fn probe_p2() {
    let mut probe = demo_host();
    let f = factory_with_two_outs(&mut probe, (20, 20), false);
    let third = pass(&mut probe, &[(0, f)], vec![add_out()]);
    assert_eq!(third, vec![Ok(())], "measured: the third add on clear floor is accepted");
    fold(&mut probe);
    assert_eq!(
        probe.host.core().state.footprint_of(f),
        Some(Footprint { w: 3, h: 4, rot: 0 }),
        "measured: a three-output Factory is 3 by 4"
    );
    assert_eq!(probe.host.core().state.occupied((20, 23)), Some(f), "measured: (20,23) is the Factory's");
    assert!(probe.host.pending_edits().is_empty(), "measured: the buffer is empty before the Undo");

    let undo1 = pass(&mut probe, &[], vec![GridCommand::Undo]);
    let restore_some = probe
        .host
        .pending_edits()
        .iter()
        .any(|r| matches!(r.op, EditOp::RemovePort { node, restore: Some(_), .. } if node == f));
    assert!(restore_some, "measured: the Undo's group holds the Factory's RemovePort with restore Some");
    let v = pass(
        &mut probe,
        &[(0, f)],
        vec![
            GridCommand::Place { kind: machine_kind::SOURCE, cell_x: 20, cell_y: 23 },
            GridCommand::Delete { node: 0 },
        ],
    );
    fold(&mut probe);
    let logged = logged_delete(&probe, f);
    let undo2 = pass(&mut probe, &[], vec![GridCommand::Undo]);
    fold(&mut probe);
    let core = probe.host.core();
    let owner = core.state.occupied((20, 23));
    let back = node_in(core, 17..=24, 18..=22, is_factory);
    let restores_now = restores(core);
    let restored_fp = back.and_then(|n| core.state.footprint_of(n));
    let owner_is_source = owner.and_then(|n| core.state.node(n)).is_some_and(|n| matches!(n, Node::Source(_)));
    let (save, load) = save_and_load(&probe.host);
    let facts: Vec<(&'static str, String)> = vec![
        ("undo_add", dbg(undo1[0])),
        ("place", dbg(v[0])),
        ("delete", dbg(v[1])),
        ("logged_delete_cell_and_capture", dbg(logged)),
        ("undo_delete", dbg(undo2[0])),
        ("restored_factory_fp", dbg(restored_fp)),
        ("owner_20_23_is_source", owner_is_source.to_string()),
        ("restores", dbg(restores_now)),
        ("save", save),
        ("load", load),
    ];
    let mut expected = facts.clone();
    expected[0].1 = "Ok(())".to_owned();
    expected[1].1 = "Ok(())".to_owned();
    expected[2].1 = "Ok(())".to_owned();
    expected[4].1 = "Ok(())".to_owned();
    expected[6].1 = "true".to_owned();
    expected[7].1 = "None".to_owned();
    expected[8].1 = "Ok(())".to_owned();
    expected[9].1 = "Ok(())".to_owned();
    grade("probe_p2", &facts, &expected);
}

/// P3: a Factory at (20,20) turned once with two outputs (3 by 3, rot 1; the
/// `turned_factory_growth` shape of `label_same_pass.rs`). ONE pass: `add_out`, then
/// Delete; fold; Undo; fold. Healthy: the Factory comes back at the anchor, footprint
/// and rot it had after the add (measured on a second host) and the board loads. Prints
/// the logged Delete's `cell_x`, `cell_y` beside its `captured` w, h and port count.
///
/// Red until BOTH todos were fixed: the turn came back with plan 86-02 (EDIT 13) and the
/// grown box with plan 86-05, which reads the whole capture from the board the fold sees.
/// Fixing the same-pass todo alone would have been worse than neither: see
/// [`probe_p3_box_stays_inside_what_the_machine_held`].
#[test]
fn probe_p3() {
    let (ref_anchor, ref_fp, _ref_ports) = factory_after_third_add((20, 20), true);
    let mut probe = demo_host();
    let f = factory_with_two_outs(&mut probe, (20, 20), true);
    let v = pass(&mut probe, &[(0, f)], vec![add_out(), GridCommand::Delete { node: 0 }]);
    fold(&mut probe);
    let logged = logged_delete(&probe, f);
    let undo = pass(&mut probe, &[], vec![GridCommand::Undo]);
    fold(&mut probe);
    let core = probe.host.core();
    let back = node_in(core, 17..=24, 18..=25, is_factory);
    let facts: Vec<(&'static str, String)> = vec![
        ("add", dbg(v[0])),
        ("delete", dbg(v[1])),
        ("logged_delete_cell_and_capture", dbg(logged)),
        ("undo", dbg(undo[0])),
        ("restored_anchor", dbg(back.and_then(|n| core.state.cell_of(n)))),
        ("restored_fp", dbg(back.and_then(|n| core.state.footprint_of(n)))),
        ("restores", dbg(restores(core))),
    ];
    let mut expected = facts.clone();
    expected[0].1 = "Ok(())".to_owned();
    expected[1].1 = "Ok(())".to_owned();
    expected[3].1 = "Ok(())".to_owned();
    expected[4].1 = ref_anchor;
    expected[5].1 = ref_fp;
    expected[6].1 = "None".to_owned();
    grade("probe_p3", &facts, &expected);
}

/// Every cell `node` owns in the window x 15 to 26, y 16 to 27.
fn cells_of(core: &Core, node: NodeId) -> Vec<(i32, i32)> {
    let mut cells = Vec::new();
    for y in 16..=27 {
        for x in 15..=26 {
            if core.state.occupied((x, y)) == Some(node) {
                cells.push((x, y));
            }
        }
    }
    cells
}

/// P3's shape graded on the one fact that holds today: the Factory the Undo brings back
/// claims no cell the Factory did not hold when it was deleted (the post-add rot-1 box,
/// x 19 to 22, y 20 to 22, measured on a second host). The re-Place lays the pre-pass
/// 3 by 3 box at rot 0 at the replayed anchor (19,20); a square box covers the same
/// cells at either rot, so it lands inside. A label next to it is safe on this path.
///
/// It goes red if the same-pass todo is fixed WITHOUT the turned-Delete todo: the capture
/// would then carry the post-add 3 by 4 box, and the rot-0 re-Place would take row y 23,
/// which a label may hold.
#[test]
fn probe_p3_box_stays_inside_what_the_machine_held() {
    let held = {
        let mut reference = demo_host();
        let f = factory_with_two_outs(&mut reference, (20, 20), true);
        let v = pass(&mut reference, &[(0, f)], vec![add_out()]);
        assert_eq!(v, vec![Ok(())], "measured: the third add on clear floor is accepted");
        fold(&mut reference);
        cells_of(reference.host.core(), f)
    };
    let mut probe = demo_host();
    let f = factory_with_two_outs(&mut probe, (20, 20), true);
    let v = pass(&mut probe, &[(0, f)], vec![add_out(), GridCommand::Delete { node: 0 }]);
    fold(&mut probe);
    let undo = pass(&mut probe, &[], vec![GridCommand::Undo]);
    fold(&mut probe);
    let core = probe.host.core();
    let back = node_in(core, 17..=24, 18..=25, is_factory);
    let restored = back.map(|n| cells_of(core, n)).unwrap_or_default();
    let outside: Vec<(i32, i32)> = restored.iter().filter(|c| !held.contains(c)).copied().collect();
    let facts: Vec<(&'static str, String)> = vec![
        ("add", dbg(v[0])),
        ("delete", dbg(v[1])),
        ("undo", dbg(undo[0])),
        ("held_at_delete", dbg(&held)),
        ("restored", dbg(&restored)),
        ("restored_outside_held", dbg(&outside)),
        ("restores", dbg(restores(core))),
    ];
    let mut expected = facts.clone();
    expected[0].1 = "Ok(())".to_owned();
    expected[1].1 = "Ok(())".to_owned();
    expected[2].1 = "Ok(())".to_owned();
    expected[5].1 = "[]".to_owned();
    expected[6].1 = "None".to_owned();
    assert!(!restored.is_empty(), "measured: the Undo brings a Factory back");
    grade("probe_p3_box", &facts, &expected);
}

/// A Router at (20,28) turned once clockwise and folded: rot 1 covers x 20 to 22, y 28
/// to 29, so (20,30) and (21,30), which its rot-0 body covers, are free. Asserted.
fn turned_router(probe: &mut Probe) -> NodeId {
    let r = place(probe, machine_kind::ROUTER, (20, 28));
    let t = pass(probe, &[(0, r)], vec![GridCommand::Rotate { node: 0, ccw: false }]);
    assert_eq!(t, vec![Ok(())], "measured: an undocked Router turns on clear floor");
    fold(probe);
    let core = probe.host.core();
    assert_eq!(core.state.footprint_of(r), Some(Footprint { w: 2, h: 3, rot: 1 }), "measured: turned once");
    assert_eq!(core.state.cell_of(r), Some((20, 28)), "measured: the turn keeps the anchor");
    assert_eq!(core.state.occupied((22, 29)), Some(r), "measured: rot 1 covers x 20 to 22, y 28 to 29");
    assert_eq!(core.state.occupied((20, 30)), None, "measured: (20,30) is free while the Router is turned");
    assert_eq!(core.state.occupied((21, 30)), None, "measured: (21,30) is free while the Router is turned");
    r
}

/// Delete `router` in its own pass and fold, then Undo in its own pass and fold.
/// Returns the two verdicts.
fn delete_then_undo(probe: &mut Probe, router: NodeId) -> (String, Result<(), CommandError>) {
    let d = pass(probe, &[(0, router)], vec![GridCommand::Delete { node: 0 }]);
    fold(probe);
    let u = pass(probe, &[], vec![GridCommand::Undo]);
    fold(probe);
    (dbg(d[0]), u[0])
}

/// What the Undo did with the turned Router, in words, so either route of the
/// turned-Delete todo reads healthy: route 1 brings it back as it was (2 by 3, rot 1,
/// at (20,28)); route 2 refuses the Undo and places nothing.
fn router_outcome(core: &Core, undo: Result<(), CommandError>) -> String {
    let back = core.state.occupied((20, 28));
    let fp = back.and_then(|n| core.state.footprint_of(n));
    let at = back.and_then(|n| core.state.cell_of(n));
    match (undo, back) {
        (Ok(()), Some(_)) if fp == Some(Footprint { w: 2, h: 3, rot: 1 }) && at == Some((20, 28)) => {
            "restored as it was".to_owned()
        }
        (Ok(()), Some(_)) => format!("restored {fp:?} at {at:?}"),
        (Ok(()), None) => "accepted but nothing placed".to_owned(),
        (Err(_), None) => "refused, nothing placed".to_owned(),
        (Err(e), Some(_)) => format!("refused {e:?} but {fp:?} placed at {at:?}"),
    }
}

/// P4: the turned Router, a Source placed at (20,30) (free while the Router is turned),
/// the Router deleted, Undo, each step in its own pass. Healthy: the Source keeps (20,30),
/// the board restores, saves and loads, and the Undo is accepted and the Router comes back
/// `Footprint { w: 2, h: 3, rot: 1 }` at (20,28). A refusal is red: the turned cells are
/// free, so the D-04 guard has nothing to refuse and a refusal means the turn was lost.
#[test]
fn probe_p4() {
    let mut probe = demo_host();
    let router = turned_router(&mut probe);
    let source = place(&mut probe, machine_kind::SOURCE, (20, 30));
    let (delete, undo) = delete_then_undo(&mut probe, router);
    let core = probe.host.core();
    let restores_now = restores(core);
    let facts_core: Vec<(&'static str, String)> = vec![
        ("delete", delete),
        ("undo", dbg(undo)),
        ("router", router_outcome(core, undo)),
        ("owner_20_30_is_source", (core.state.occupied((20, 30)) == Some(source)).to_string()),
        ("restores", dbg(restores_now)),
    ];
    let (save, load) = save_and_load(&probe.host);
    let mut facts = facts_core;
    facts.push(("save", save));
    facts.push(("load", load));
    let expected: Vec<(&'static str, String)> = vec![
        ("delete", "Ok(())".to_owned()),
        ("undo", "Ok(())".to_owned()),
        ("router", "restored as it was".to_owned()),
        ("owner_20_30_is_source", "true".to_owned()),
        ("restores", "None".to_owned()),
        ("save", "Ok(())".to_owned()),
        ("load", "Ok(())".to_owned()),
    ];
    grade("probe_p4", &facts, &expected);
}

/// P4L: the same with a LABEL as the victim. The turned Router, a label placed at (20,30)
/// (4 by 1, x 20 to 23, free while the Router is turned), the Router deleted, Undo, each
/// step in its own pass. Healthy: the label keeps (20,30) and (21,30), the board
/// restores, saves and loads, and the Undo is accepted and the Router comes back turned
/// at (20,28). A refused Undo is red. A red is an open D-01 or WORK-02 violation.
#[test]
fn probe_p4l() {
    let mut probe = demo_host();
    let router = turned_router(&mut probe);
    for x in 22..=23 {
        assert_eq!(probe.host.core().state.occupied((x, 30)), None, "measured: ({x},30) is free");
    }
    let label = place(&mut probe, machine_kind::LABEL, (20, 30));
    assert_eq!(
        probe.host.core().state.footprint_of(label),
        Some(Footprint { w: 4, h: 1, rot: 0 }),
        "measured: a placed label is 4 by 1"
    );
    let (delete, undo) = delete_then_undo(&mut probe, router);
    let core = probe.host.core();
    let restores_now = restores(core);
    let facts_core: Vec<(&'static str, String)> = vec![
        ("delete", delete),
        ("undo", dbg(undo)),
        ("router", router_outcome(core, undo)),
        ("owner_20_30_is_label", (core.state.occupied((20, 30)) == Some(label)).to_string()),
        ("owner_21_30_is_label", (core.state.occupied((21, 30)) == Some(label)).to_string()),
        ("restores", dbg(restores_now)),
    ];
    let (save, load) = save_and_load(&probe.host);
    let mut facts = facts_core;
    facts.push(("save", save));
    facts.push(("load", load));
    let expected: Vec<(&'static str, String)> = vec![
        ("delete", "Ok(())".to_owned()),
        ("undo", "Ok(())".to_owned()),
        ("router", "restored as it was".to_owned()),
        ("owner_20_30_is_label", "true".to_owned()),
        ("owner_21_30_is_label", "true".to_owned()),
        ("restores", "None".to_owned()),
        ("save", "Ok(())".to_owned()),
        ("load", "Ok(())".to_owned()),
    ];
    grade("probe_p4l", &facts, &expected);
}

// ---------------------------------------------------------------------------------------
// SAME-PASS CASCADE (76-12 refuter round). A Delete's capture lists the belts and wires
// the Delete takes with the machine (its cascade). It is read off the PRE-PASS core, so a
// record earlier in the same drain pass that already took a belt or a wire out of that
// cascade (an Unlink, a Rotate that releases a dock, a Delete of the belt, the wire or a
// neighbour that shares it) left it in the capture, and the Undo redrew it a second time.
// Each probe below runs ONE gesture list two ways on two demo-booted hosts: all in one
// drain pass, and one pass per gesture (the control, which folds before each capture).
// Then the same number of Undos, each in its own pass. Healthy: the board after the pass
// and after every Undo has the same shape both ways, and the control's last board
// restores, saves and loads (asserted, so two broken boards cannot agree into a pass).
// ---------------------------------------------------------------------------------------

/// A demo node's id by its boot-time slot, e.g. `demo_id(6)` is `NodeId(6v1)`. Both hosts
/// of a probe boot the same demo, so the ids agree before the gestures run.
fn demo_id(probe: &Probe, slot: u32) -> NodeId {
    let want = format!("NodeId({slot}v1)");
    probe.host.core().state.node_ids().find(|id| format!("{id:?}") == want).expect("measured: the demo holds this slot")
}

fn kind_name(n: &Node) -> &'static str {
    match n {
        Node::Source(_) => "Source",
        Node::Belt(_) => "Belt",
        Node::Router(_) => "Router",
        Node::Factory(_) => "Factory",
        Node::Sink(_) => "Sink",
        Node::Wire(_) => "Wire",
        Node::Label(_) => "Label",
        _ => "other",
    }
}

/// Where a node is, with its id erased: a belt by its first tile, anything else by its
/// anchor cell, each with its kind.
fn place_of(core: &Core, id: NodeId) -> String {
    match core.state.node(id) {
        Some(Node::Belt(b)) => format!("Belt@{:?}", b.geometry.first().map(|t| t.cell)),
        Some(Node::Wire(w)) => format!("Wire[{}.{} -> {}.{}]", place_of(core, w.from.0), w.from.1, place_of(core, w.to.0), w.to.1),
        Some(n) => format!("{}@{:?}", kind_name(n), core.state.cell_of(id)),
        None => format!("gone {id:?}"),
    }
}

/// The board with every id erased: every machine and label by kind, anchor and box, every
/// belt's tiles, every wire and every link (each end by place), how many cells the
/// occupancy index holds, and the trust gate's verdict.
fn board_shape(core: &Core) -> String {
    let mut nodes: Vec<String> = Vec::new();
    for id in core.state.node_ids() {
        match core.state.node(id) {
            Some(Node::Belt(b)) => nodes.push(format!("Belt{:?}", b.geometry.iter().map(|t| t.cell).collect::<Vec<_>>())),
            Some(Node::Wire(_)) => nodes.push(place_of(core, id)),
            Some(_) => nodes.push(format!("{} {:?}", place_of(core, id), core.state.footprint_of(id))),
            None => {}
        }
    }
    nodes.sort();
    let mut links: Vec<String> = core
        .state
        .links_iter()
        .map(|((f, fp), (t, tp))| format!("{}.{fp} -> {}.{tp}", place_of(core, f), place_of(core, t)))
        .collect();
    links.sort();
    let mut occupied = 0;
    for y in -1..=36 {
        for x in -1..=44 {
            occupied += usize::from(core.state.occupied((x, y)).is_some());
        }
    }
    format!("nodes {nodes:?} links {links:?} occupied {occupied} restores {:?}", restores(core))
}

/// Run `cmds` (handles are demo slots) on two hosts, all in one pass and one pass per
/// gesture, then `undos` Undos each in its own pass; grade every board against the
/// control's.
fn same_pass_vs_separate(name: &str, slots: &[u32], cmds: &[GridCommand], undos: usize) {
    same_pass_vs_separate_after(
        name,
        |probe| slots.iter().map(|&s| (u64::from(s), demo_id(probe, s))).collect(),
        cmds,
        undos,
    );
}

/// [`same_pass_vs_separate`] on a board `setup` first builds on both demo-booted hosts
/// (each of its steps folded), `setup` returning the handle table the gestures use.
fn same_pass_vs_separate_after(
    name: &str,
    setup: impl Fn(&mut Probe) -> Vec<(u64, NodeId)>,
    cmds: &[GridCommand],
    undos: usize,
) {
    let mut one = demo_host();
    let mut each = demo_host();
    let table = setup(&mut one);
    let control = setup(&mut each);
    assert_eq!(table, control, "measured: both hosts boot the same ids");

    let v_one = pass(&mut one, &table, cmds.to_vec());
    fold(&mut one);
    let mut v_each = Vec::new();
    for cmd in cmds {
        v_each.extend(pass(&mut each, &control, vec![cmd.clone()]));
        fold(&mut each);
    }
    let mut facts: Vec<(&'static str, String)> = vec![("verdicts", dbg(&v_one)), ("after_pass", board_shape(one.host.core()))];
    let mut expected: Vec<(&'static str, String)> = vec![("verdicts", dbg(&v_each)), ("after_pass", board_shape(each.host.core()))];
    const UNDO: [&str; 3] = ["undo_1", "undo_2", "undo_3"];
    for label in UNDO.iter().take(undos) {
        let u_one = pass(&mut one, &[], vec![GridCommand::Undo]);
        fold(&mut one);
        let u_each = pass(&mut each, &[], vec![GridCommand::Undo]);
        fold(&mut each);
        assert!(u_each.iter().all(Result::is_ok), "measured: the control accepts {label}: {u_each:?}");
        facts.push((label, format!("{u_one:?}\n{}", board_shape(one.host.core()))));
        expected.push((label, format!("{u_each:?}\n{}", board_shape(each.host.core()))));
    }
    let (save, load) = save_and_load(&one.host);
    facts.push(("save", save));
    facts.push(("load", load));
    let (c_save, c_load) = save_and_load(&each.host);
    assert!(v_each.iter().all(Result::is_ok), "measured: the control accepts every gesture: {v_each:?}");
    assert_eq!(restores(each.host.core()), None, "measured: the control's last board restores");
    assert_eq!((c_save.as_str(), c_load.as_str()), ("Ok(())", "Ok(())"), "measured: the control's board saves and loads");
    expected.push(("save", c_save));
    expected.push(("load", c_load));
    grade(name, &facts, &expected);
}

/// The panel's Disconnect on the belt docked to the Sink at (5,8) (an Unlink), then the
/// keyboard Delete of that Sink, on a paused board; Play; Ctrl+Z. Before the fix the
/// capture still listed the unlinked belt, which survives the fold, and the Undo drew a
/// second belt on its tiles.
#[test]
fn probe_c1_unlink_then_delete() {
    same_pass_vs_separate(
        "probe_c1",
        &[6, 23],
        &[
            GridCommand::Unlink { belt: 23, endpoint: fabrico_protocol::BeltEnd::Head, node: 6, port: 0 },
            GridCommand::Delete { node: 6 },
        ],
        1,
    );
}

/// R then Delete on the same docked machine on a paused board; Play; Ctrl+Z. The turn
/// releases the belt dock, so the belt survives the fold.
#[test]
fn probe_c2_rotate_then_delete() {
    same_pass_vs_separate(
        "probe_c2",
        &[6],
        &[GridCommand::Rotate { node: 6, ccw: false }, GridCommand::Delete { node: 6 }],
        1,
    );
}

/// Delete two machines that share a belt (slot 2's fault port feeds belt 23 into the
/// Sink at slot 6) on a paused board; Play; Ctrl+Z twice. Both captures listed the belt.
#[test]
fn probe_c3_two_machines_sharing_a_belt() {
    same_pass_vs_separate("probe_c3", &[2, 6], &[GridCommand::Delete { node: 2 }, GridCommand::Delete { node: 6 }], 2);
}

/// The panel's Disconnect on a wire row (it sends a Delete of the wire), then the Delete
/// of the machine at the wire's source, one pass; Ctrl+Z twice. The machine's capture
/// still listed the wire, so the second Undo drew it again.
#[test]
fn probe_c4_wire_disconnect_then_delete() {
    same_pass_vs_separate("probe_c4", &[30, 32], &[GridCommand::Delete { node: 32 }, GridCommand::Delete { node: 30 }], 2);
}

/// Delete the two machines the demo's two wires join, one pass; Ctrl+Z twice. Both
/// captures listed both wires.
#[test]
fn probe_c5_two_wired_machines() {
    same_pass_vs_separate("probe_c5", &[30, 31], &[GridCommand::Delete { node: 30 }, GridCommand::Delete { node: 31 }], 2);
}

/// Host-accepted, sent by no shipped client (it has no belt Delete): Delete the docked
/// belt, Place a LABEL on a tile it freed, Delete the Sink, one pass; Ctrl+Z. Before the
/// fix the Undo redrew the belt over the label (truth 6: a belt on a label's cell).
#[test]
fn probe_c6_belt_delete_label_place_machine_delete() {
    same_pass_vs_separate(
        "probe_c6",
        &[6, 23],
        &[
            GridCommand::Delete { node: 23 },
            // (5,7): a tile the belt freed, whose 4x1 label box (5..8, 7) is otherwise empty
            // on the demo since plan 85-08 ((5,6) would now reach the Web request label).
            GridCommand::Place { kind: machine_kind::LABEL, cell_x: 5, cell_y: 7 },
            GridCommand::Delete { node: 6 },
        ],
        1,
    );
}

/// Host-accepted, sent by no shipped client: Delete the docked belt, then the Sink, one
/// pass; Ctrl+Z twice.
#[test]
fn probe_c7_belt_delete_then_machine_delete() {
    same_pass_vs_separate("probe_c7", &[6, 23], &[GridCommand::Delete { node: 23 }, GridCommand::Delete { node: 6 }], 2);
}

// ---------------------------------------------------------------------------------------
// A DELETE OF SOMETHING AN EARLIER DELETE ALREADY TAKES (phase 86 review, CR-01). The
// `probe_c*` rows above delete the belt or the wire FIRST. In the other order the machine's
// Delete takes the belt or the cable with it, so by the time the second Delete folds there is
// nothing left to delete. On separate passes the host refuses that second Delete, because the
// node is gone (`UnknownNode`, "That machine is no longer there."). In one paused pass it was
// accepted, its capture was read off a board with no such node (a fabricated 1 by 1 at (0,0)),
// and its Undo was refused `Malformed` on every press, so the machine's Delete below it, and
// everything before that, could never be undone. Both rows were measured red before the fix.
// ---------------------------------------------------------------------------------------

/// [`same_pass_vs_separate`] for a gesture list the control REFUSES part of: `control` is the
/// verdict list the separate passes give (asserted), and the one-pass host must give the same.
/// After the first Ctrl+Z the one-pass board must be exactly the board before the gestures.
fn same_pass_vs_separate_refused(
    name: &str,
    slots: &[u32],
    cmds: &[GridCommand],
    control: &[Result<(), CommandError>],
    undos: usize,
) {
    let mut one = demo_host();
    let mut each = demo_host();
    let table: Vec<(u64, NodeId)> = slots.iter().map(|&s| (u64::from(s), demo_id(&one, s))).collect();
    let c_table: Vec<(u64, NodeId)> = slots.iter().map(|&s| (u64::from(s), demo_id(&each, s))).collect();
    assert_eq!(table, c_table, "measured: both hosts boot the same ids");
    let start = board_shape(one.host.core());

    let v_one = pass(&mut one, &table, cmds.to_vec());
    fold(&mut one);
    let mut v_each = Vec::new();
    for cmd in cmds {
        v_each.extend(pass(&mut each, &c_table, vec![cmd.clone()]));
        fold(&mut each);
    }
    assert_eq!(v_each, control, "measured: the separate passes give these verdicts");
    let mut facts: Vec<(&'static str, String)> = vec![("verdicts", dbg(&v_one)), ("after_pass", board_shape(one.host.core()))];
    let mut expected: Vec<(&'static str, String)> = vec![("verdicts", dbg(&v_each)), ("after_pass", board_shape(each.host.core()))];
    const UNDO: [&str; 3] = ["undo_1", "undo_2", "undo_3"];
    for (i, label) in UNDO.iter().take(undos).enumerate() {
        let u_one = pass(&mut one, &[], vec![GridCommand::Undo]);
        fold(&mut one);
        let u_each = pass(&mut each, &[], vec![GridCommand::Undo]);
        fold(&mut each);
        facts.push((label, format!("{u_one:?}\n{}", board_shape(one.host.core()))));
        expected.push((label, format!("{u_each:?}\n{}", board_shape(each.host.core()))));
        if i == 0 {
            facts.push(("undo_1_is_the_start", dbg(board_shape(one.host.core()) == start)));
            expected.push(("undo_1_is_the_start", dbg(true)));
        }
    }
    let (save, load) = save_and_load(&one.host);
    facts.push(("save", save));
    facts.push(("load", load));
    expected.push(("save", "Ok(())".to_owned()));
    expected.push(("load", "Ok(())".to_owned()));
    grade(name, &facts, &expected);
}

/// C8: on a paused board, Delete the Sink at (5,8) (slot 6), then Delete the fault belt docked
/// into it (slot 23, which the Sink's Delete takes with it), one pass; Ctrl+Z twice. Healthy: the
/// belt's Delete is refused as it is on separate passes, and the first Ctrl+Z brings the Sink
/// back with its belt, exactly the board before the pass. Sent by no shipped client (it has no
/// belt Delete); host-accepted, so graded.
#[test]
fn probe_c8_delete_then_its_cascade_belt() {
    same_pass_vs_separate_refused(
        "probe_c8",
        &[6, 23],
        &[GridCommand::Delete { node: 6 }, GridCommand::Delete { node: 23 }],
        &[Ok(()), Err(CommandError::UnknownNode)],
        2,
    );
}

/// C9: on a paused board, Delete the caller Route (slot 30), then the panel's Disconnect on its
/// request cable row (a Delete of wire slot 32, which the Route's Delete takes with it), one
/// pass; Ctrl+Z twice. The shipped app sends this pair. Healthy: as `probe_c8`.
#[test]
fn probe_c9_delete_then_its_wire() {
    same_pass_vs_separate_refused(
        "probe_c9",
        &[30, 32],
        &[GridCommand::Delete { node: 30 }, GridCommand::Delete { node: 32 }],
        &[Ok(()), Err(CommandError::UnknownNode)],
        2,
    );
}

// ---------------------------------------------------------------------------------------
// SAME-PASS JOINS (plan 86-05, the Dock and DrawWire row of the same-pass todo). A record
// earlier in the pass that JOINS a belt or a cable to the machine puts it INTO the
// Delete's cascade: the fold takes it with the machine, so the capture must list it or the
// Undo brings the machine back without it. A belt drawn in the same pass has no handle
// yet (its id is minted at the fold), so the belt is drawn and folded first and only the
// join rides the pass, which is also the only order the app sends: a drawn belt's own
// Docks wait for its echo, and a handle drag docks a belt that already stands.
// ---------------------------------------------------------------------------------------

/// Apply `cmd` with `table` as the handle table, assert it is accepted, and fold.
fn step(probe: &mut Probe, table: &[(u64, NodeId)], cmd: GridCommand) {
    let v = pass(probe, table, vec![cmd.clone()]);
    assert_eq!(v, vec![Ok(())], "measured: the set-up gesture {cmd:?} is accepted");
    fold(probe);
}

/// The occupant of `cell`, asserted present.
fn on(probe: &Probe, cell: (i32, i32)) -> NodeId {
    probe.host.core().state.occupied(cell).expect("measured: the set-up node stands on its cell")
}

/// A palette Factory at (20,20) (3 by 3; its Out, catalog index 1, at (22,21) faces E onto
/// (23,21)), a palette Sink at (26,21) (its In faces W onto (25,21)), and a belt drawn
/// (23,21) to (25,21) with its Head docked to the Sink and its Tail free. Handles: 0 the
/// Factory, 1 the belt, 2 the Sink.
fn factory_belt_sink(probe: &mut Probe) -> Vec<(u64, NodeId)> {
    for y in 19..=23 {
        for x in 19..=27 {
            assert_eq!(probe.host.core().state.occupied((x, y)), None, "measured: ({x},{y}) is clear floor");
        }
    }
    let factory = place(probe, machine_kind::FACTORY, (20, 20));
    let sink = place(probe, machine_kind::SINK, (26, 21));
    step(probe, &[], GridCommand::DrawBelt { cells: vec![(23, 21), (24, 21), (25, 21)] });
    let belt = on(probe, (23, 21));
    let table = vec![(0, factory), (1, belt), (2, sink)];
    step(probe, &table, GridCommand::Dock { belt: 1, endpoint: fabrico_protocol::BeltEnd::Head, node: 2, port: 0 });
    assert_eq!(probe.host.core().state.links_iter().filter(|((f, _), (t, _))| *f == belt || *t == belt).count(), 1, "measured: the belt is docked at its Head only");
    table
}

/// D1: on a paused board a belt's free Tail is dragged onto the Factory's Out (a Dock),
/// then the Factory is deleted, one pass; Ctrl+Z. The fold takes the newly docked belt
/// with the Factory; a capture read off the board before the pass lists no belt, so the
/// Undo would bring the Factory back without it.
#[test]
fn probe_d1_dock_then_delete() {
    same_pass_vs_separate_after(
        "probe_d1",
        factory_belt_sink,
        &[
            GridCommand::Dock { belt: 1, endpoint: fabrico_protocol::BeltEnd::Tail, node: 0, port: 1 },
            GridCommand::Delete { node: 0 },
        ],
        1,
    );
}

/// A palette Factory at (20,20) given an electrical output (`AddPort`, E side), and a
/// palette Route at (28,21) whose electrical In faces W. Handles: 0 the Factory, 1 the
/// Route. The added output is the Factory's catalog index 3.
fn factory_and_route(probe: &mut Probe) -> Vec<(u64, NodeId)> {
    for y in 19..=24 {
        for x in 19..=29 {
            assert_eq!(probe.host.core().state.occupied((x, y)), None, "measured: ({x},{y}) is clear floor");
        }
    }
    let factory = place(probe, machine_kind::FACTORY, (20, 20));
    let route = place(probe, machine_kind::ENDPOINT, (28, 21));
    let table = vec![(0, factory), (1, route)];
    step(
        probe,
        &table,
        GridCommand::AddPort { node: 0, role: port_role::OUT, side: Side::E as u8, medium: port_medium::ELECTRICAL },
    );
    table
}

/// D2: on a paused board a cable is drawn from the Factory's electrical output to the
/// Route (a DrawWire), then the Factory is deleted, one pass; Ctrl+Z. The fold takes the
/// new cable with the Factory; a capture read off the board before the pass lists no wire.
#[test]
fn probe_d2_draw_wire_then_delete() {
    same_pass_vs_separate_after(
        "probe_d2",
        factory_and_route,
        &[
            GridCommand::DrawWire { from_node: 0, from_port: 3, to_node: 1, to_port: 0 },
            GridCommand::Delete { node: 0 },
        ],
        1,
    );
}

/// The slots the probes above name are the machines they mean, MEASURED on the demo board
/// (a slot is its node's mint-order handle plus one). Re-measured by plan 85-08 when the
/// demo gained its labels and lanes: the Factory, the Rejects sink and its fault belt, the
/// Route, the HTTP Handler and the request cable.
#[test]
fn the_probe_slots_name_the_nodes_the_probes_mean() {
    let probe = demo_host();
    let core = probe.host.core();
    let at = |slot: u32| place_of(core, demo_id(&probe, slot));
    assert_eq!(at(2), "Factory@Some((4, 2))", "slot 2 is the order Factory");
    assert_eq!(at(6), "Sink@Some((5, 8))", "slot 6 is the Rejects sink");
    assert_eq!(at(23), "Belt@Some((5, 5))", "slot 23 is the fault belt into the Rejects sink");
    assert!(matches!(core.state.node(demo_id(&probe, 30)), Some(Node::Endpoint(_))), "slot 30 is the caller Route");
    assert_eq!(at(31), "Factory@Some((16, 5))", "slot 31 is the HTTP Handler (a Handler folds to a Factory)");
    assert!(
        at(32).starts_with("Wire[") && at(32).contains("-> Factory@Some((16, 5)).0"),
        "slot 32 is the request cable into the Handler's In: {}",
        at(32)
    );
}
