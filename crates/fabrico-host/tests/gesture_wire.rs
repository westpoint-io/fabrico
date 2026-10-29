//! Phase 88 (every edit lands where you aimed), D-02, D-05 and D-06: the gesture wire on
//! the real `SimLoop` and the real `RenderProducer`.
//!
//! # What crosses the wire after plan 88-03
//! - Every render packet names the board generation of the handle table its handles belong
//!   to (`RenderPacket.generation`, appended after `resync`), and a reset (an Undo, a Redo,
//!   a Load, a New, a scene swap) raises it by one.
//! - Every gesture frame is `[varint generation][varint gesture id][body]`: the generation of
//!   the packet the client read its handles from, and the client's own id for the gesture.
//!   The body is byte-identical to what it always was.
//! - Every gesture gets exactly one verdict back, naming it by that id: refused at once,
//!   accepted after the tick that folded it (naming the handles it minted, in the generation
//!   of the packet that tick broadcast), or discarded by a board swap.
//!
//! The harness is `lag_resync_across_reset.rs`'s: the real `SimLoop`, the real
//! `RenderProducer`, and the scene read back off the render frames the producer broadcasts,
//! as a transport forwards them. Frames are decoded through `transport_ws::decode_gesture`,
//! the one decoder both transports call.
//!
//! # New sim-loop tests live HERE, not in `sim_loop.rs`
//! `crates/fabrico-host/src/sim_loop.rs` carried a parallel change's uncommitted test at the
//! end of `mod endpoint` (phase 88 D-15). A test added beside it would share a diff hunk
//! with it and make staging this phase's own lines unsafe, so every phase 88 test that
//! drives the sim loop is written in a file under `tests/`.
//!
//! Run target: `cargo test -p fabrico-host --test gesture_wire`

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
use fabrico_host::render_packet::{RenderFrame, RenderProducer};
use fabrico_host::sim_loop::{ControlMsg, GestureFrame, GestureSink, GestureTx, SimLoop, gesture_channel};
use fabrico_host::transport_ws::{
    GESTURE_ACCEPT_KIND, GESTURE_DISCARD_KIND, GESTURE_REFUSAL_KIND, decode_gesture, frame_gesture,
    wire_envelope,
};
use fabrico_protocol::{GridCommand, NodeView, RenderPacket, machine_kind};
use tokio::sync::broadcast::{self, error::TryRecvError};
use tokio::sync::mpsc::unbounded_channel;

/// Ticks each folded gesture block is given before the scene is read.
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

fn encode(cmd: &GridCommand) -> Vec<u8> {
    postcard::to_allocvec(cmd).expect("encode a GridCommand body")
}

fn place(kind: u8, x: i32, y: i32) -> GridCommand {
    GridCommand::Place {
        kind,
        cell_x: x,
        cell_y: y,
    }
}

/// The scene as a connected client holds it: every frame on the diff broadcast applied in
/// order, and the `generation` the last applied PACKET carried, read off the decoded bytes
/// (the wire field), never off the `RenderFrame` beside them.
struct Scene {
    diff: broadcast::Receiver<RenderFrame>,
    nodes: BTreeMap<u64, NodeView>,
    generation: u64,
    /// Every packet applied, in order.
    packets: Vec<RenderPacket>,
}

impl Scene {
    /// Subscribe BEFORE the first tick, so no frame is missed.
    fn subscribe(sim: &SimLoop) -> Self {
        let (_kf, diff) = sim.subscribe();
        Self {
            diff,
            nodes: BTreeMap::new(),
            generation: 0,
            packets: Vec::new(),
        }
    }

    /// Apply every frame the broadcast holds, as a connection that keeps up does.
    fn keep_up(&mut self) {
        loop {
            match self.diff.try_recv() {
                Ok(frame) => {
                    let p = decode(&frame.bytes);
                    assert_eq!(
                        p.generation, frame.generation,
                        "the packet names the generation the producer sent it under"
                    );
                    if p.full {
                        self.nodes.clear();
                    }
                    for h in &p.removed {
                        self.nodes.remove(h);
                    }
                    for n in &p.placed {
                        self.nodes.insert(n.id, n.clone());
                    }
                    self.generation = p.generation;
                    self.packets.push(p);
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
}

/// Send `cmd` in-process and fold it, then bring the scene up to date.
fn fold(sim: &mut SimLoop, scene: &mut Scene, gtx: &impl GestureSink, cmd: GridCommand) {
    gtx.send_gesture(cmd).expect("send gesture");
    sim.run(Some(FOLD_TICKS), Duration::ZERO).expect("fold");
    scene.keep_up();
}

/// THE TRACER (D-02). The board generation crosses end to end: the producer stamps it on the
/// packet, the client reads it there, the client's next gesture carries it in its header with
/// its own gesture id, the one decoder reads both, and the envelope the drain receives holds
/// the generation.
///
/// An Undo is the reset that matters here: it remints every handle, so after it the packet
/// reads generation 1, and a gesture made from that packet says 1.
///
/// The envelope is read off a channel exactly as the drain reads `gesture_rx`
/// (`try_recv`), then handed to the sim loop, which applies it: the Delete it carries
/// removes the machine the user picked.
#[test]
fn a_gesture_carries_the_generation_of_the_packet_it_was_made_from() {
    let rt = rt();
    let dir = tempfile::tempdir().expect("tempdir");
    let (gtx, grx) = gesture_channel();
    let mut sim = SimLoop::new(host(dir.path()), RenderProducer::new(), rt.handle(), cfg(), grx);
    let mut scene = Scene::subscribe(&sim);

    fold(&mut sim, &mut scene, &gtx, place(machine_kind::SOURCE, 4, 4));
    assert_eq!(scene.generation, 0, "PRECONDITION: no reset yet, generation 0");
    fold(&mut sim, &mut scene, &gtx, place(machine_kind::SOURCE, 8, 4));
    fold(&mut sim, &mut scene, &gtx, GridCommand::Undo);
    assert!(scene.at(8, 4).is_none(), "PRECONDITION: the Undo took the second Source back");
    assert_eq!(
        scene.generation, 1,
        "after one Undo the last packet reads generation 1: {:?}",
        scene.packets.iter().map(|p| (p.tick, p.full, p.generation)).collect::<Vec<_>>()
    );
    let picked = scene.at(4, 4).expect("PRECONDITION: the first Source is drawn").id;

    // The client's gesture, made from that packet: header then the unchanged body.
    let bytes = frame_gesture(scene.generation, 7, &encode(&GridCommand::Delete { node: picked }));
    let decoded = decode_gesture(&bytes).expect("a headered frame decodes");
    assert_eq!((decoded.generation, decoded.gesture_id), (1, 7), "the header reads back");
    assert_eq!(decoded.frame, GestureFrame::Cmd(GridCommand::Delete { node: picked }));

    // The envelope as both transports build it, read off a channel the way the drain does.
    let (verdict_tx, _verdict_rx) = verdict_channel();
    let (tap_tx, mut tap_rx) = gesture_channel();
    tap_tx.send(wire_envelope(decoded, &verdict_tx)).expect("tap");
    let env = tap_rx.try_recv().expect("the envelope is in the channel");
    assert_eq!(env.generation, Some(1), "the envelope the drain receives names generation 1");

    gtx.send(env).expect("hand the envelope to the sim loop");
    sim.run(Some(FOLD_TICKS), Duration::ZERO).expect("drain it");
    scene.keep_up();
    assert!(
        scene.at(4, 4).is_none(),
        "the headered Delete was drained and applied: the picked Source is gone"
    );
}

/// Send `cmd` as a transport does: framed with the client's generation and gesture id,
/// decoded by the one decoder, enveloped by the one builder with a sink on `verdict_tx`.
fn send_framed(gtx: &GestureTx, verdict_tx: &VerdictTx, generation: u64, gesture_id: u64, cmd: &GridCommand) {
    let decoded = decode_gesture(&frame_gesture(generation, gesture_id, &encode(cmd))).expect("a framed gesture decodes");
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

/// D-06, THE PLACE. A headered Place is answered, after the tick that folded it, with
/// `gestureAccepted`, its own gesture id, the generation of the packet that tick broadcast, and
/// `minted` equal to the new Source's `NodeView.id` in that packet. Nothing is answered before
/// that tick: the handle does not exist until the producer builds the packet.
#[test]
fn an_accepted_place_is_answered_with_the_handle_it_minted() {
    let rt = rt();
    let dir = tempfile::tempdir().expect("tempdir");
    let (gtx, grx) = gesture_channel();
    let mut sim = SimLoop::new(host(dir.path()), RenderProducer::new(), rt.handle(), cfg(), grx);
    let mut scene = Scene::subscribe(&sim);
    let (verdict_tx, mut verdict_rx) = verdict_channel();

    // A reset first, so the generation the accept names is not the trivial 0.
    fold(&mut sim, &mut scene, &gtx, place(machine_kind::SINK, 2, 2));
    fold(&mut sim, &mut scene, &gtx, GridCommand::Undo);
    assert_eq!(scene.generation, 1, "PRECONDITION: one reset, generation 1");
    let before = scene.packets.len();

    send_framed(&gtx, &verdict_tx, scene.generation, 21, &place(machine_kind::SOURCE, 6, 6));
    assert!(verdicts(&mut verdict_rx).is_empty(), "nothing is answered before the drain runs");
    sim.run(Some(1), Duration::ZERO).expect("one tick drains and folds it");
    scene.keep_up();

    let source = scene.at(6, 6).expect("the Source is drawn");
    let tick_packet = scene.packets.get(before).expect("the tick broadcast a packet");
    assert!(
        tick_packet.placed.iter().any(|n| n.id == source.id),
        "PRECONDITION: the tick's own packet carries the new Source"
    );
    let got = verdicts(&mut verdict_rx);
    eprintln!("P88-03-ACCEPT verdicts={got:?} source_id={} packet_generation={}", source.id, tick_packet.generation);
    assert_eq!(
        got,
        vec![VerdictFrame::accepted(21, tick_packet.generation, vec![source.id])],
        "one accept: gesture 21, the generation of the packet that drew it, and the handle drawn"
    );
    assert_eq!(got[0].kind(), GESTURE_ACCEPT_KIND);
}

/// D-06, THE WIRE. One DrawWire drag mints two wires, the forward leg and its paired return
/// leg (72 D-04, as `route_handler_save_load.rs` pins), so its accept names TWO handles, both
/// wires in the packet that tick broadcast.
#[test]
fn a_draw_wire_is_answered_with_both_minted_handles() {
    let rt = rt();
    let dir = tempfile::tempdir().expect("tempdir");
    let (gtx, grx) = gesture_channel();
    let mut sim = SimLoop::new(host(dir.path()), RenderProducer::new(), rt.handle(), cfg(), grx);
    let mut scene = Scene::subscribe(&sim);
    let (verdict_tx, mut verdict_rx) = verdict_channel();

    fold(&mut sim, &mut scene, &gtx, place(machine_kind::ENDPOINT, 4, 4));
    fold(&mut sim, &mut scene, &gtx, place(machine_kind::HANDLER, 12, 4));
    let endpoint = scene.at(4, 4).expect("PRECONDITION: the Endpoint is drawn").clone();
    let handler = scene.at(12, 4).expect("PRECONDITION: the Handler is drawn").clone();
    let electrical = |n: &NodeView, role: u8| {
        n.ports
            .iter()
            .find(|p| p.role == role && p.medium == fabrico_protocol::port_medium::ELECTRICAL)
            .unwrap_or_else(|| panic!("PRECONDITION: node {} has an electrical port of role {role}: {:?}", n.id, n.ports))
            .index
    };
    let draw = GridCommand::DrawWire {
        from_node: endpoint.id,
        from_port: electrical(&endpoint, fabrico_protocol::port_role::OUT),
        to_node: handler.id,
        to_port: electrical(&handler, fabrico_protocol::port_role::IN),
    };
    let before = scene.packets.len();
    send_framed(&gtx, &verdict_tx, scene.generation, 5, &draw);
    sim.run(Some(1), Duration::ZERO).expect("one tick folds the wire");
    scene.keep_up();

    let got = verdicts(&mut verdict_rx);
    eprintln!("P88-03-WIRE verdicts={got:?}");
    assert_eq!(got.len(), 1, "exactly one verdict: {got:?}");
    assert_eq!(got[0].kind(), GESTURE_ACCEPT_KIND, "the wire was accepted: {got:?}");
    let minted = got[0].minted().expect("an accept names its minted handles").to_vec();
    assert_eq!(minted.len(), 2, "a DrawWire names two handles, the leg and its return: {minted:?}");
    let tick_packet = scene.packets.get(before).expect("the tick broadcast a packet");
    let in_packet: Vec<u64> = tick_packet.wires.iter().map(|w| w.id).collect();
    for h in &minted {
        assert!(in_packet.contains(h), "minted handle {h} is a wire in that tick's packet: {in_packet:?}");
    }
    assert_eq!(got[0].generation(), Some(tick_packet.generation));
}

/// D-06, THE REFUSAL. A Place on an occupied cell is answered at once, in the drain, with
/// `gestureRefused`, its own gesture id, the tag and the command name.
#[test]
fn a_refused_gesture_is_answered_with_its_own_gesture_id() {
    let rt = rt();
    let dir = tempfile::tempdir().expect("tempdir");
    let (gtx, grx) = gesture_channel();
    let mut sim = SimLoop::new(host(dir.path()), RenderProducer::new(), rt.handle(), cfg(), grx);
    let mut scene = Scene::subscribe(&sim);
    let (verdict_tx, mut verdict_rx) = verdict_channel();

    fold(&mut sim, &mut scene, &gtx, place(machine_kind::SOURCE, 6, 6));
    send_framed(&gtx, &verdict_tx, scene.generation, 33, &place(machine_kind::SOURCE, 6, 6));
    sim.run(Some(1), Duration::ZERO).expect("drain it");

    let got = verdicts(&mut verdict_rx);
    assert_eq!(got.len(), 1, "exactly one verdict: {got:?}");
    let json = serde_json::to_value(&got[0]).expect("JSON");
    assert_eq!(
        json,
        serde_json::json!({"kind": GESTURE_REFUSAL_KIND, "seq": 33, "tag": "FootprintCollision", "cmd": "Place"}),
    );
    assert_eq!(got[0].tag(), Some(CommandErrorView::FootprintCollision));
}

/// D-05 and D-06, THE SWAP. Pause, a Delete queued, a New board: the Delete is answered
/// `gestureDiscarded` with its id, nothing is deleted on either board, and no refusal is sent.
#[test]
fn a_gesture_queued_on_a_replaced_board_is_answered_discarded() {
    let rt = rt();
    let dir = tempfile::tempdir().expect("tempdir");
    let (gtx, grx) = gesture_channel();
    let (ctx, crx) = unbounded_channel::<ControlMsg>();
    let mut sim = SimLoop::new(host(dir.path()), RenderProducer::new(), rt.handle(), cfg(), grx).with_control(crx);
    let mut scene = Scene::subscribe(&sim);
    let (verdict_tx, mut verdict_rx) = verdict_channel();

    fold(&mut sim, &mut scene, &gtx, place(machine_kind::SOURCE, 6, 6));
    let source = scene.at(6, 6).expect("PRECONDITION: the Source is drawn").id;
    ctx.send(ControlMsg::Pause).expect("pause");
    for _ in 0..4 {
        sim.step().expect("paused step");
    }
    assert!(sim.is_paused(), "PRECONDITION: paused");

    send_framed(&gtx, &verdict_tx, scene.generation, 44, &GridCommand::Delete { node: source });
    sim.step().expect("a paused step drains nothing");
    assert!(verdicts(&mut verdict_rx).is_empty(), "PRECONDITION: the paused Delete waits unanswered");
    let old_nodes = sim.host().core().state.node_count();
    assert_eq!(old_nodes, 1, "PRECONDITION: the Source is still on the old board");

    ctx.send(ControlMsg::New).expect("send New");
    sim.step().expect("the swap");
    ctx.send(ControlMsg::Resume).expect("resume");
    for _ in 0..3 {
        sim.step().expect("live steps on the new board");
    }
    scene.keep_up();

    assert_eq!(
        verdicts(&mut verdict_rx),
        vec![VerdictFrame::discarded(44)],
        "the Delete is answered discarded, exactly once, and never refused"
    );
    assert_eq!(sim.host().core().state.node_count(), 0, "the new board is empty: nothing was deleted on it");
    assert_eq!(verdicts(&mut verdict_rx).first().map(VerdictFrame::kind), None);
    assert_ne!(GESTURE_DISCARD_KIND, GESTURE_REFUSAL_KIND);
}
