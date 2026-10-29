//! Phase 88 (every edit lands where you aimed), WORK-03, D-02 and D-03: an edit queued
//! behind an Undo lands on the node the user picked, never on whatever a re-minted handle
//! names afterwards.
//!
//! # The defect these probes measure
//! A render handle is a dense alias the host mints per handle table. An Undo or a Redo
//! resets the render producer (`sim_loop.rs` `tick_body`, `producer.reset`), which installs
//! a fresh table minting from 0. The gesture drain ends a pass at an Undo
//! (`acquire_input`), so an edit sent in the same burst as the Undo is resolved in the NEXT
//! pass, against the NEW table: the handle the user read off the old packet now names a
//! different node. The todo `2026-10-07-queued-edit-behind-undo-names-a-reminted-handle.md`
//! measured it live on a paused board (the 76-18 command-path probe); research P88-W3a and
//! P88-W3b measured it on the real `SimLoop` at a pre-release revision.
//!
//! # The legs plan 88-04 added (D-03, D-05)
//! Below the two probes, each case the kept tables cannot answer is driven on the same
//! harness and must be refused or discarded with the board unchanged: a node the Undo
//! removed, a generation past the kept history, a generation from the future, and a gesture
//! from before a board swap. Each reads its verdict off a test sink, as a transport would,
//! AND compares the board before and after, so a refusal that still changed the board reds.
//!
//! # Each probe is the test plan 88-04 turns on
//! Both are `#[ignore]`d with the plan that turns them on named in the reason, and were
//! seen FAILED at `PHASE88_START` in a throwaway worktree (88-EVIDENCE.md `## Red-first
//! record`). Plan 88-04 (D-02) gives each handle table a generation that rides the render
//! packet and the gesture frame, and resolves a gesture's handle against the table of the
//! generation the client saw. The ONLY line it may change here is the body of
//! [`send_as_seen`], so the frame carries the generation the test read; no assertion moves.
//!
//! The harness is `lag_resync_across_reset.rs`'s: the real `SimLoop`, the real
//! `RenderProducer`, every gesture through `GestureSink::send_gesture`, and the scene read
//! back off the render frames the producer broadcasts, as a transport forwards them.
//!
//! Run target: `cargo test -p fabrico-host --test edit_lands_where_aimed -- --include-ignored`

use std::collections::BTreeMap;
use std::time::Duration;

use fabrico_core::core::Core;
use fabrico_core::event::{LogHeader, SCHEMA_VERSION};
use fabrico_core::persist::RedbStore;
use fabrico_host::config::HostConfig;
use fabrico_host::driver::Host;
use fabrico_host::ledger::DispatchLedger;
use fabrico_host::command_error_view::CommandErrorView;
use fabrico_host::gesture_verdict::{VerdictFrame, VerdictRx, VerdictTx, verdict_channel};
use fabrico_host::render_packet::{KEPT_GENERATIONS, RenderFrame, RenderProducer};
use fabrico_host::sim_loop::{ControlMsg, GestureSink, GestureTx, SimLoop, gesture_channel};
use fabrico_host::transport_ws::{
    GESTURE_ACCEPT_KIND, GESTURE_REFUSAL_KIND, decode_gesture, frame_gesture, wire_envelope,
};
use tokio::sync::mpsc::unbounded_channel;
use fabrico_protocol::{GridCommand, MachineConfig, NodeView, RenderPacket, machine_kind};
use tokio::sync::broadcast::{self, error::TryRecvError};

/// Ticks each folded gesture block is given before the scene is read. Two is enough for a
/// pass that ends at an Undo and the pass after it; four leaves room.
const FOLD_TICKS: u64 = 4;

fn rt() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("runtime")
}

fn cfg() -> HostConfig {
    HostConfig {
        webhook_addr: "127.0.0.1:0".parse().expect("addr"),
    }
}

fn host(dir: &std::path::Path) -> Host {
    let core = Core::genesis(LogHeader {
        schema_version: SCHEMA_VERSION,
        seed: 1,
    });
    let store = RedbStore::open(dir.join("log.redb")).expect("store");
    let ledger = DispatchLedger::open(dir.join("ledger.redb")).expect("ledger");
    Host::new(core, store, ledger, None).expect("host")
}

fn decode(bytes: &[u8]) -> RenderPacket {
    postcard::from_bytes(bytes).expect("decode a render packet")
}

/// The scene as a connected client holds it: every frame on the diff broadcast applied in
/// order (a keyframe replaces the node set, a diff removes then upserts), plus the
/// `RenderFrame.generation` of the last frame applied, the handle table the client's
/// handles were read from.
struct Scene {
    diff: broadcast::Receiver<RenderFrame>,
    nodes: BTreeMap<u64, NodeView>,
    generation: u64,
}

impl Scene {
    /// Subscribe BEFORE the first tick, so no frame is missed.
    fn subscribe(sim: &SimLoop) -> Self {
        let (_kf, diff) = sim.subscribe();
        Self {
            diff,
            nodes: BTreeMap::new(),
            generation: 0,
        }
    }

    /// Apply every frame the broadcast holds, as a connection that keeps up does.
    fn keep_up(&mut self) {
        loop {
            match self.diff.try_recv() {
                Ok(frame) => {
                    let p = decode(&frame.bytes);
                    if p.full {
                        self.nodes.clear();
                    }
                    for h in &p.removed {
                        self.nodes.remove(h);
                    }
                    for n in p.placed {
                        self.nodes.insert(n.id, n);
                    }
                    self.generation = frame.generation;
                }
                Err(TryRecvError::Empty) => return,
                Err(e) => panic!("PRECONDITION: the client keeps up, got {e:?}"),
            }
        }
    }

    /// The node whose anchor is `(x, y)`.
    fn at(&self, x: i32, y: i32) -> Option<&NodeView> {
        self.nodes.values().find(|n| n.cell_x == x && n.cell_y == y)
    }

    /// The handle of the node anchored at `(x, y)`, which must be there.
    fn handle_at(&self, x: i32, y: i32, what: &str) -> u64 {
        self.at(x, y).unwrap_or_else(|| panic!("PRECONDITION: {what} is on the board at ({x},{y})")).id
    }

    /// The scene in the research's P88-W3 form: `h<handle>:k<kind>@(x,y)` per node, with a
    /// label's words.
    fn describe(&self) -> String {
        self.nodes
            .values()
            .map(|n| {
                let words = n.label.as_ref().map(|l| format!("{:?}", l.text)).unwrap_or_default();
                format!("h{}:k{}@({},{}){words}", n.id, n.kind, n.cell_x, n.cell_y)
            })
            .collect::<Vec<_>>()
            .join(" ")
    }
}

/// Send `cmd` as a gesture the client made while it held the handle table of generation
/// `seen`.
///
/// Since plan 88-04 (D-02) the gesture goes as a transport sends it: framed with `seen` and a
/// gesture id, decoded by the one decoder, enveloped by the one builder. Its verdict goes to
/// a receiver dropped here, as a closed socket's would. At `PHASE88_START` this called
/// `send_gesture(cmd)` and ignored `seen`; this body is the only thing plan 88-04 changed.
fn send_as_seen(gtx: &impl GestureSink, cmd: GridCommand, seen: u64) {
    let body = postcard::to_allocvec(&cmd).expect("encode a GridCommand body");
    let decoded = fabrico_host::transport_ws::decode_gesture(&fabrico_host::transport_ws::frame_gesture(seen, 0, &body))
        .expect("a framed gesture decodes");
    let (verdict_tx, _verdict_rx) = fabrico_host::gesture_verdict::verdict_channel();
    gtx.send_envelope(fabrico_host::transport_ws::wire_envelope(decoded, &verdict_tx))
        .expect("send gesture");
}

/// Send `cmd` and fold it, then bring the scene up to date.
fn fold(sim: &mut SimLoop, scene: &mut Scene, gtx: &impl GestureSink, cmd: GridCommand) {
    send_as_seen(gtx, cmd, scene.generation);
    sim.run(Some(FOLD_TICKS), Duration::ZERO).expect("fold");
    scene.keep_up();
}

fn place(kind: u8, x: i32, y: i32) -> GridCommand {
    GridCommand::Place {
        kind,
        cell_x: x,
        cell_y: y,
    }
}

/// A label's words, keeping the box the label already has.
fn words(view: &NodeView, text: &str) -> GridCommand {
    GridCommand::Configure {
        node: view.id,
        config: MachineConfig::Label {
            text: text.to_owned(),
            colour: view.label.as_ref().map_or(0, |l| l.colour),
            w: view.w,
            h: view.h,
        },
    }
}

/// THE DELETE. Sources A (4,4), B (8,4) and C (12,4); A deleted, the Delete undone, then
/// redone, each folded. The scene now holds B and C, C on a handle read off the last
/// packet. The user picks C and presses Delete in the same burst as an Undo (a held Ctrl+Z,
/// or an Undo queued on a paused board, then Play). The Undo brings A back; the Delete must
/// take C, the node the user picked, and leave B.
///
/// RED AT `PHASE88_START` (research P88-W3a at a pre-release revision): B is deleted and C stays, under a
/// fresh handle.
#[test]
fn a_delete_behind_an_undo_lands_on_the_picked_machine() {
    let rt = rt();
    let dir = tempfile::tempdir().expect("tempdir");
    let (gtx, grx) = gesture_channel();
    let mut sim = SimLoop::new(host(dir.path()), RenderProducer::new(), rt.handle(), cfg(), grx);
    let mut scene = Scene::subscribe(&sim);

    for (x, y) in [(4, 4), (8, 4), (12, 4)] {
        fold(&mut sim, &mut scene, &gtx, place(machine_kind::SOURCE, x, y));
    }
    assert_eq!(scene.nodes.len(), 3, "PRECONDITION: three Sources on the board: {}", scene.describe());
    let a = scene.handle_at(4, 4, "A");
    fold(&mut sim, &mut scene, &gtx, GridCommand::Delete { node: a });
    assert!(scene.at(4, 4).is_none(), "PRECONDITION: the Delete removed A: {}", scene.describe());
    fold(&mut sim, &mut scene, &gtx, GridCommand::Undo);
    assert!(scene.at(4, 4).is_some(), "PRECONDITION: the Undo put A back: {}", scene.describe());
    fold(&mut sim, &mut scene, &gtx, GridCommand::Redo);
    assert!(scene.at(4, 4).is_none(), "PRECONDITION: the Redo deleted A again: {}", scene.describe());

    let c = scene.handle_at(12, 4, "C");
    let seen = scene.generation;
    eprintln!(
        "P88-W3a BEFORE scene=[{}] user picks C(12,4)=h{c} generation={seen}",
        scene.describe()
    );

    // ONE burst: the Undo and the Delete the user aimed at C, both in the channel before
    // any tick drains them.
    send_as_seen(&gtx, GridCommand::Undo, seen);
    send_as_seen(&gtx, GridCommand::Delete { node: c }, seen);
    sim.run(Some(FOLD_TICKS), Duration::ZERO).expect("drain the burst");
    scene.keep_up();

    let kind = |x: i32, y: i32| scene.at(x, y).map(|n| n.kind);
    eprintln!(
        "P88-W3a AFTER scene=[{}] (4,4)={:?} (8,4)={:?} (12,4)={:?} generation={}",
        scene.describe(),
        scene.at(4, 4).map(|n| n.id),
        scene.at(8, 4).map(|n| n.id),
        scene.at(12, 4).map(|n| n.id),
        scene.generation
    );
    assert_eq!(
        (kind(4, 4), kind(8, 4), kind(12, 4)),
        (Some(machine_kind::SOURCE), Some(machine_kind::SOURCE), None),
        "the Undo restores A at (4,4), B stays at (8,4), and the Delete the user aimed at C \
         removes C at (12,4)"
    );
}

/// THE LABEL CONFIGURE. Labels LA (4,8) `A words`, LB (10,8) `B words` and LC (16,8)
/// `C words`; LA deleted, undone, redone. The user picks LC and types new words, sent in the
/// same burst as an Undo. The words must land on LC and leave LB's alone.
///
/// RED AT `PHASE88_START` (research P88-W3b at a pre-release revision): LB takes the words and LC keeps
/// its own.
#[test]
fn a_label_configure_behind_an_undo_lands_on_the_picked_label() {
    let rt = rt();
    let dir = tempfile::tempdir().expect("tempdir");
    let (gtx, grx) = gesture_channel();
    let mut sim = SimLoop::new(host(dir.path()), RenderProducer::new(), rt.handle(), cfg(), grx);
    let mut scene = Scene::subscribe(&sim);

    for ((x, y), text) in [((4, 8), "A words"), ((10, 8), "B words"), ((16, 8), "C words")] {
        fold(&mut sim, &mut scene, &gtx, place(machine_kind::LABEL, x, y));
        let view = scene
            .at(x, y)
            .unwrap_or_else(|| panic!("PRECONDITION: a label at ({x},{y}): {}", scene.describe()))
            .clone();
        fold(&mut sim, &mut scene, &gtx, words(&view, text));
    }
    let text_at = |s: &Scene, x: i32, y: i32| s.at(x, y).and_then(|n| n.label.as_ref()).map(|l| l.text.clone());
    assert_eq!(
        (text_at(&scene, 4, 8), text_at(&scene, 10, 8), text_at(&scene, 16, 8)),
        (Some("A words".to_owned()), Some("B words".to_owned()), Some("C words".to_owned())),
        "PRECONDITION: three labels with their words: {}",
        scene.describe()
    );
    let la = scene.handle_at(4, 8, "LA");
    fold(&mut sim, &mut scene, &gtx, GridCommand::Delete { node: la });
    assert!(scene.at(4, 8).is_none(), "PRECONDITION: the Delete removed LA: {}", scene.describe());
    fold(&mut sim, &mut scene, &gtx, GridCommand::Undo);
    assert!(scene.at(4, 8).is_some(), "PRECONDITION: the Undo put LA back: {}", scene.describe());
    fold(&mut sim, &mut scene, &gtx, GridCommand::Redo);
    assert!(scene.at(4, 8).is_none(), "PRECONDITION: the Redo deleted LA again: {}", scene.describe());

    let lc = scene
        .at(16, 8)
        .unwrap_or_else(|| panic!("PRECONDITION: LC is on the board: {}", scene.describe()))
        .clone();
    let seen = scene.generation;
    eprintln!(
        "P88-W3b BEFORE scene=[{}] user picks LC(16,8)=h{} generation={seen}",
        scene.describe(),
        lc.id
    );

    send_as_seen(&gtx, GridCommand::Undo, seen);
    send_as_seen(&gtx, words(&lc, "Probe words"), seen);
    sim.run(Some(FOLD_TICKS), Duration::ZERO).expect("drain the burst");
    scene.keep_up();

    eprintln!(
        "P88-W3b AFTER scene=[{}] (4,8)={:?} (10,8)={:?} (16,8)={:?} generation={}",
        scene.describe(),
        text_at(&scene, 4, 8),
        text_at(&scene, 10, 8),
        text_at(&scene, 16, 8),
        scene.generation
    );
    assert_eq!(
        (text_at(&scene, 4, 8), text_at(&scene, 10, 8), text_at(&scene, 16, 8)),
        (Some("A words".to_owned()), Some("B words".to_owned()), Some("Probe words".to_owned())),
        "the Undo restores LA, LB keeps its words, and the words the user typed into LC land \
         on LC"
    );
}

// ---------------------------------------------------------------------------
// Plan 88-04 (D-03, D-05): every case the kept tables cannot answer is refused or discarded,
// and changes nothing.
// ---------------------------------------------------------------------------

/// Send `cmd` as a transport does, stamped `generation` with gesture id `id`, its verdict to
/// `verdict_tx`.
fn send_framed(gtx: &GestureTx, verdict_tx: &VerdictTx, generation: u64, id: u64, cmd: &GridCommand) {
    let body = postcard::to_allocvec(cmd).expect("encode a GridCommand body");
    let decoded = decode_gesture(&frame_gesture(generation, id, &body)).expect("a framed gesture decodes");
    gtx.send(wire_envelope(decoded, verdict_tx)).expect("send the envelope");
}

/// Every verdict on `rx` so far.
fn verdicts(rx: &mut VerdictRx) -> Vec<VerdictFrame> {
    let mut out = Vec::new();
    while let Ok(v) = rx.try_recv() {
        out.push(v);
    }
    out
}

/// Each verdict as `(kind, gesture id, refusal tag)`.
fn summary(got: &[VerdictFrame]) -> Vec<(&'static str, Option<u64>, Option<CommandErrorView>)> {
    got.iter().map(|v| (v.kind(), v.seq(), v.tag())).collect()
}

/// The board as the core holds it, independent of handles: `(kind, x, y, words)` per node,
/// sorted. Two boards are equal when this is.
fn board(sim: &SimLoop, scene: &Scene) -> Vec<(u8, i32, i32, Option<String>)> {
    let mut out: Vec<_> = scene
        .nodes
        .values()
        .map(|n| (n.kind, n.cell_x, n.cell_y, n.label.as_ref().map(|l| l.text.clone())))
        .collect();
    out.sort();
    assert_eq!(
        out.len(),
        sim.host().core().state.node_count(),
        "PRECONDITION: the scene the client holds is the whole board: {}",
        scene.describe()
    );
    out
}

fn new_sim(dir: &std::path::Path, rt: &tokio::runtime::Runtime) -> (SimLoop, GestureTx, Scene) {
    let (gtx, grx) = gesture_channel();
    let sim = SimLoop::new(host(dir), RenderProducer::new(), rt.handle(), cfg(), grx);
    let scene = Scene::subscribe(&sim);
    (sim, gtx, scene)
}

/// D-03, A NODE THE UNDO REMOVED. Sources X (4,4) and Y (8,4); X deleted and Z placed at
/// (12,4) in the slot X left; W placed at (16,4) and undone, so the reset re-mints Z ahead of
/// Y. The user, on that table, picks Z, and an Undo (which takes Z's Place back) and a Delete
/// of Z go in one burst. Z is gone by the time the Delete is drained: the kept table names
/// Z's dead id, which is refused `UnknownNode`, and the board equals the board the Undo
/// alone leaves, Y on (8,4). Resolved against the table the Undo installed, Z's old handle
/// would name Y, and the Delete would take it.
#[test]
fn an_edit_naming_a_node_the_undo_removed_is_refused() {
    let rt = rt();
    let dir = tempfile::tempdir().expect("tempdir");
    let (mut sim, gtx, mut scene) = new_sim(dir.path(), &rt);
    let (verdict_tx, mut verdict_rx) = verdict_channel();

    fold(&mut sim, &mut scene, &gtx, place(machine_kind::SOURCE, 4, 4));
    fold(&mut sim, &mut scene, &gtx, place(machine_kind::SOURCE, 8, 4));
    let x = scene.handle_at(4, 4, "X");
    fold(&mut sim, &mut scene, &gtx, GridCommand::Delete { node: x });
    fold(&mut sim, &mut scene, &gtx, place(machine_kind::SOURCE, 12, 4));
    fold(&mut sim, &mut scene, &gtx, place(machine_kind::SOURCE, 16, 4));
    fold(&mut sim, &mut scene, &gtx, GridCommand::Undo);
    assert!(scene.at(16, 4).is_none(), "PRECONDITION: the Undo took W back: {}", scene.describe());

    let z = scene.handle_at(12, 4, "Z");
    let seen = scene.generation;
    let before = board(&sim, &scene);
    eprintln!("P88-04-GONE BEFORE scene=[{}] user picks Z(12,4)=h{z} generation={seen}", scene.describe());

    send_framed(&gtx, &verdict_tx, seen, 61, &GridCommand::Undo);
    send_framed(&gtx, &verdict_tx, seen, 62, &GridCommand::Delete { node: z });
    sim.run(Some(FOLD_TICKS), Duration::ZERO).expect("drain the burst");
    scene.keep_up();
    let got = verdicts(&mut verdict_rx);
    eprintln!("P88-04-GONE AFTER scene=[{}] verdicts={got:?}", scene.describe());

    let undo_alone: Vec<_> = before.into_iter().filter(|n| (n.1, n.2) != (12, 4)).collect();
    assert_eq!(board(&sim, &scene), undo_alone, "the board is the board the Undo alone leaves: Y on (8,4), nothing else");
    assert_eq!(
        summary(&got),
        vec![
            (GESTURE_ACCEPT_KIND, Some(61), None),
            (GESTURE_REFUSAL_KIND, Some(62), Some(CommandErrorView::UnknownNode)),
        ],
        "the Undo is accepted after its tick, and the Delete of Z, drained on the pass after it, \
         is refused UnknownNode"
    );
}

/// D-03, A GENERATION PAST THE KEPT HISTORY. Sources S1 (4,4) and S2 (8,4); the user reads
/// S1's handle, then `KEPT_GENERATIONS + 1` resets (S2's Place undone and redone in turn)
/// pass before the Delete of S1 arrives. The host keeps no table that old, so it cannot say
/// which node the user picked: the Delete is refused `BoardChanged`, and S1 is still there.
#[test]
fn an_edit_from_a_generation_past_the_kept_history_is_refused_board_changed() {
    let rt = rt();
    let dir = tempfile::tempdir().expect("tempdir");
    let (mut sim, gtx, mut scene) = new_sim(dir.path(), &rt);
    let (verdict_tx, mut verdict_rx) = verdict_channel();

    fold(&mut sim, &mut scene, &gtx, place(machine_kind::SOURCE, 4, 4));
    fold(&mut sim, &mut scene, &gtx, place(machine_kind::SOURCE, 8, 4));
    let s1 = scene.handle_at(4, 4, "S1");
    let seen = scene.generation;
    for k in 0..=KEPT_GENERATIONS {
        let cmd = if k % 2 == 0 { GridCommand::Undo } else { GridCommand::Redo };
        fold(&mut sim, &mut scene, &gtx, cmd);
    }
    assert_eq!(
        scene.generation,
        seen + KEPT_GENERATIONS as u64 + 1,
        "PRECONDITION: {} resets since the read",
        KEPT_GENERATIONS + 1
    );
    let before = board(&sim, &scene);
    assert!(scene.at(4, 4).is_some(), "PRECONDITION: S1 is on the board: {}", scene.describe());

    send_framed(&gtx, &verdict_tx, seen, 71, &GridCommand::Delete { node: s1 });
    sim.run(Some(FOLD_TICKS), Duration::ZERO).expect("drain");
    scene.keep_up();
    let got = verdicts(&mut verdict_rx);
    eprintln!("P88-04-TOO-OLD seen={seen} now={} verdicts={got:?} scene=[{}]", scene.generation, scene.describe());

    assert_eq!(
        summary(&got),
        vec![(GESTURE_REFUSAL_KIND, Some(71), Some(CommandErrorView::BoardChanged))],
        "the Delete is refused BoardChanged, once"
    );
    assert_eq!(board(&sim, &scene), before, "the board is unchanged: S1 is still on (4,4)");
}

/// Phase 88 review IN-03, A HANDLE-LESS GESTURE PAST THE KEPT HISTORY. The same lag as the
/// leg above, but the gestures name no handle: a Place of a Source at (12,4) and then an Undo,
/// both stamped with the generation the user read before `KEPT_GENERATIONS + 1` resets. They
/// read no handle table, so the host has nothing it cannot name: both are applied (the Place
/// lands, the Undo takes it back), each answered with an accept. Refusing them `BoardChanged`
/// ("The board changed first. That edit was not made.") would be a sentence about a table the
/// gesture never read.
#[test]
fn a_handle_less_gesture_past_the_kept_history_is_applied() {
    let rt = rt();
    let dir = tempfile::tempdir().expect("tempdir");
    let (mut sim, gtx, mut scene) = new_sim(dir.path(), &rt);
    let (verdict_tx, mut verdict_rx) = verdict_channel();

    fold(&mut sim, &mut scene, &gtx, place(machine_kind::SOURCE, 4, 4));
    fold(&mut sim, &mut scene, &gtx, place(machine_kind::SOURCE, 8, 4));
    let seen = scene.generation;
    for k in 0..=KEPT_GENERATIONS {
        let cmd = if k % 2 == 0 { GridCommand::Undo } else { GridCommand::Redo };
        fold(&mut sim, &mut scene, &gtx, cmd);
    }
    assert_eq!(
        scene.generation,
        seen + KEPT_GENERATIONS as u64 + 1,
        "PRECONDITION: {} resets since the read",
        KEPT_GENERATIONS + 1
    );
    assert!(scene.at(12, 4).is_none(), "PRECONDITION: (12,4) is empty: {}", scene.describe());

    send_framed(&gtx, &verdict_tx, seen, 72, &place(machine_kind::SOURCE, 12, 4));
    sim.run(Some(FOLD_TICKS), Duration::ZERO).expect("drain the Place");
    scene.keep_up();
    let placed = scene.at(12, 4).map(|n| n.kind);
    send_framed(&gtx, &verdict_tx, seen, 73, &GridCommand::Undo);
    sim.run(Some(FOLD_TICKS), Duration::ZERO).expect("drain the Undo");
    scene.keep_up();
    let got = verdicts(&mut verdict_rx);
    eprintln!("IN-03 seen={seen} now={} verdicts={got:?} scene=[{}]", scene.generation, scene.describe());

    assert_eq!(
        summary(&got),
        vec![(GESTURE_ACCEPT_KIND, Some(72), None), (GESTURE_ACCEPT_KIND, Some(73), None)],
        "the Place and the Undo are each accepted, once"
    );
    assert_eq!(placed, Some(machine_kind::SOURCE), "the Place landed on (12,4)");
    assert!(scene.at(12, 4).is_none(), "and the Undo took it back: {}", scene.describe());
}

/// D-03, A GENERATION FROM THE FUTURE. A Delete stamped one past the board's current
/// generation names a table no client was ever sent: refused `Malformed`, the board
/// unchanged.
#[test]
fn an_edit_from_a_future_generation_is_refused_malformed() {
    let rt = rt();
    let dir = tempfile::tempdir().expect("tempdir");
    let (mut sim, gtx, mut scene) = new_sim(dir.path(), &rt);
    let (verdict_tx, mut verdict_rx) = verdict_channel();

    fold(&mut sim, &mut scene, &gtx, place(machine_kind::SOURCE, 4, 4));
    fold(&mut sim, &mut scene, &gtx, GridCommand::Undo);
    fold(&mut sim, &mut scene, &gtx, GridCommand::Redo);
    let s = scene.handle_at(4, 4, "the Source");
    let before = board(&sim, &scene);

    send_framed(&gtx, &verdict_tx, scene.generation + 1, 81, &GridCommand::Delete { node: s });
    sim.run(Some(FOLD_TICKS), Duration::ZERO).expect("drain");
    scene.keep_up();
    let got = verdicts(&mut verdict_rx);
    eprintln!("P88-04-AHEAD now={} verdicts={got:?}", scene.generation);

    assert_eq!(
        summary(&got),
        vec![(GESTURE_REFUSAL_KIND, Some(81), Some(CommandErrorView::Malformed))],
        "the Delete is refused Malformed, once"
    );
    assert_eq!(board(&sim, &scene), before, "the board is unchanged");
}

/// D-05, A GESTURE FROM BEFORE A LOAD. The user reads a board, then a New board replaces it
/// and a Source is placed on the new one (handle 0 there). A Place and a Delete stamped with
/// the OLD generation arrive after the swap, as an automatic follow-up fired by an old-board
/// echo would (the swap-transit residual of `2026-10-06-swap-transit-window.md`); the Delete's
/// handle names the new board's live Source. Both are answered `gestureDiscarded`, no
/// sentence, and the new board is unchanged.
#[test]
fn a_gesture_from_before_a_load_is_discarded() {
    let rt = rt();
    let dir = tempfile::tempdir().expect("tempdir");
    let (gtx, grx) = gesture_channel();
    let (ctx, crx) = unbounded_channel::<ControlMsg>();
    let mut sim = SimLoop::new(host(dir.path()), RenderProducer::new(), rt.handle(), cfg(), grx).with_control(crx);
    let mut scene = Scene::subscribe(&sim);
    let (verdict_tx, mut verdict_rx) = verdict_channel();

    fold(&mut sim, &mut scene, &gtx, place(machine_kind::SOURCE, 4, 4));
    let old = scene.handle_at(4, 4, "the old board's Source");
    let old_generation = scene.generation;

    ctx.send(ControlMsg::New).expect("send New");
    sim.step().expect("the swap");
    scene.keep_up();
    assert!(scene.generation > old_generation, "PRECONDITION: the swap raised the generation");
    fold(&mut sim, &mut scene, &gtx, place(machine_kind::SOURCE, 10, 10));
    let live = scene.handle_at(10, 10, "the new board's Source");
    assert_eq!(live, old, "PRECONDITION: the new board's Source has the handle the old board's had, so the stale Delete names it");
    let before = board(&sim, &scene);

    send_framed(&gtx, &verdict_tx, old_generation, 91, &place(machine_kind::SOURCE, 6, 6));
    send_framed(&gtx, &verdict_tx, old_generation, 92, &GridCommand::Delete { node: old });
    sim.run(Some(FOLD_TICKS), Duration::ZERO).expect("drain");
    scene.keep_up();
    let got = verdicts(&mut verdict_rx);
    eprintln!("P88-04-PRE-SWAP old={old_generation} now={} verdicts={got:?} scene=[{}]", scene.generation, scene.describe());

    assert_eq!(
        got,
        vec![VerdictFrame::discarded(91), VerdictFrame::discarded(92)],
        "both are answered discarded, once each, with no sentence"
    );
    assert_eq!(board(&sim, &scene), before, "the new board is unchanged: its Source stays, nothing is placed");
}

// ---------------------------------------------------------------------------
// Phase 88 security, T-88-24 (third challenge): a paused board's gestures are answered on Play,
// however many paused steps the sim thread takes first.
// ---------------------------------------------------------------------------

/// The sim thread's steps in two minutes of a paused board: the shipped loop calls `step()`
/// once every [`TICK_PAUSE`](fabrico_host::sim_loop::TICK_PAUSE), Frozen or not.
const TWO_MINUTES_OF_STEPS: u64 = {
    let pause_ms = fabrico_host::sim_loop::TICK_PAUSE.as_millis() as u64;
    120_000 / pause_ms
};
// Two minutes is thousands of steps, checked at compile time.
const _: () = assert!(TWO_MINUTES_OF_STEPS >= 7_000);

/// T-88-24, THE SIM THREAD'S HALF. A Place sent on a paused board waits in the gesture channel
/// (a Frozen `step()` never calls `acquire_input`), so its accept can come minutes after it was
/// sent. `fabrico-app`'s `a_verdict_answered_after_a_long_pause_is_still_emitted` pins the
/// shell's verdict route across a long pause, but answers the gesture by hand: a bound on the
/// sim side, one that drops or answers a held gesture once the board has been paused for N
/// steps, passed it. The third security challenge named that gap. A bound of that kind needs no
/// clock (a wall-clock read is denied workspace-wide by `clippy.toml`, so it would fail the
/// clippy gate), so it is measured here in the sim thread's own steps: two minutes of them,
/// then a second Place sent only now, then Play. Both are accepted and both machines land.
#[test]
fn a_gesture_held_through_two_minutes_of_paused_steps_is_accepted_on_play() {
    let rt = rt();
    let dir = tempfile::tempdir().expect("tempdir");
    let (gtx, grx) = gesture_channel();
    let (ctx, crx) = unbounded_channel::<ControlMsg>();
    let mut sim = SimLoop::new(host(dir.path()), RenderProducer::new(), rt.handle(), cfg(), grx).with_control(crx);
    let mut scene = Scene::subscribe(&sim);
    let (verdict_tx, mut verdict_rx) = verdict_channel();

    ctx.send(ControlMsg::Pause).expect("send Pause");
    sim.step().expect("an empty board freezes at once");
    assert!(sim.is_paused(), "PRECONDITION: the board is paused");
    scene.keep_up();

    send_framed(&gtx, &verdict_tx, scene.generation, 71, &place(machine_kind::SOURCE, 6, 6));
    sim.run(Some(TWO_MINUTES_OF_STEPS), Duration::ZERO).expect("two minutes of paused steps");
    send_framed(&gtx, &verdict_tx, scene.generation, 72, &place(machine_kind::SOURCE, 10, 6));
    sim.run(Some(TWO_MINUTES_OF_STEPS), Duration::ZERO).expect("two more minutes of paused steps");
    assert!(sim.is_paused(), "PRECONDITION: still paused after four minutes");
    assert_eq!(verdicts(&mut verdict_rx), Vec::new(), "nothing is answered while the board is paused");
    assert_eq!(sim.host().core().state.node_count(), 0, "and nothing is applied");

    ctx.send(ControlMsg::Resume).expect("send Resume");
    sim.run(Some(FOLD_TICKS), Duration::ZERO).expect("Play");
    scene.keep_up();
    let got = verdicts(&mut verdict_rx);
    assert_eq!(
        summary(&got),
        vec![("gestureAccepted", Some(71), None), ("gestureAccepted", Some(72), None)],
        "both are accepted on Play: the one held four minutes and the one sent two minutes in: {got:?}"
    );
    assert!(scene.at(6, 6).is_some(), "the first Source landed: {}", scene.describe());
    assert!(scene.at(10, 6).is_some(), "and the second: {}", scene.describe());
}
