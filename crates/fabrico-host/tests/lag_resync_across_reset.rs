//! Plan 76-19 refuter round: what a transport resends a connection that lagged past the
//! bounded diff broadcast, when a `RenderProducer::reset` fell among the dropped frames.
//!
//! A reset (an undo, a redo, a Load, a New, a scene swap) remints every render handle and
//! is a timeline restructure. A client that kept up gets the reset's own keyframe with
//! `resync: false`, and the frontend releases a pending port-edit latch on it (73-08,
//! 73-12). Before this round both transports tagged EVERY lag keyframe `resync: true`, so a
//! client that lagged across a reset held the latch: on the user's own AddPort undone in
//! the lag, and on another Factory that landed on the latched handle with the same origin
//! cell and kind (the frontend's `remintedLatchHandles` cannot tell that one apart, the
//! bytes are the same). The panel then disabled Add output and Remove for an edit that
//! would never fold.
//!
//! These tests drive the real `SimLoop` and producer channels through `RenderRelay`, the
//! one relay both transports (`transport_ws` and the Tauri `subscribe_render`) call, and
//! read the `resync` bit off the keyframe the relay hands back. The controls hold the
//! 73-12 rule: a lag with no reset in it is still a resync.

use std::time::Duration;

use fabrico_core::core::Core;
use fabrico_core::event::{LogHeader, SCHEMA_VERSION};
use fabrico_core::persist::RedbStore;
use fabrico_host::config::HostConfig;
use fabrico_host::driver::Host;
use fabrico_host::ledger::DispatchLedger;
use fabrico_host::render_packet::{RenderFrame, RenderProducer, RenderRelay};
use fabrico_host::sim_loop::{ControlMsg, GestureSink, SimLoop, gesture_channel};
use fabrico_protocol::{GridCommand, NodeView, RenderPacket, machine_kind};
use tokio::sync::broadcast::{self, error::TryRecvError};
use tokio::sync::mpsc::unbounded_channel;
use tokio::sync::watch;

/// More ticks than the diff broadcast holds (256), so the subscriber lags.
const LAG_TICKS: u64 = 300;

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

/// The one Factory a packet carries.
fn the_factory(p: &RenderPacket) -> NodeView {
    let mut f = p.placed.iter().filter(|n| n.kind == machine_kind::FACTORY);
    let one = f.next().cloned().expect("a Factory in the packet");
    assert!(f.next().is_none(), "exactly one Factory in the packet");
    one
}

/// The core node ids, to tell the same machine from another one.
fn core_ids(sim: &SimLoop) -> Vec<String> {
    sim.host()
        .core()
        .state
        .node_ids()
        .map(|i| format!("{i:?}"))
        .collect()
}

/// A connected client: a relay opened on the latest keyframe, then kept up with every
/// diff frame on the broadcast (forwarded through the relay, as a transport does).
struct Client {
    relay: RenderRelay,
    kf: watch::Receiver<RenderFrame>,
    diff: broadcast::Receiver<RenderFrame>,
    /// The packet the client last applied a keyframe from.
    last_keyframe: RenderPacket,
}

impl Client {
    /// Open on the latest keyframe of a subscription taken BEFORE the first tick (the
    /// producer's keyframe watch keeps no value sent while it has no receiver, which is
    /// why every shell subscribes before it runs the loop).
    fn connect(subscription: (watch::Receiver<RenderFrame>, broadcast::Receiver<RenderFrame>)) -> Self {
        let (mut kf, diff) = subscription;
        let (relay, bytes) = RenderRelay::open(&kf.borrow_and_update());
        assert!(!bytes.is_empty(), "PRECONDITION: a keyframe to open on");
        Self {
            relay,
            kf,
            diff,
            last_keyframe: decode(&bytes),
        }
    }

    /// Read every frame the broadcast holds, as a connection that keeps up does.
    fn keep_up(&mut self) {
        loop {
            match self.diff.try_recv() {
                Ok(frame) => {
                    let Some(bytes) = self.relay.forward(frame) else { continue };
                    let p = decode(&bytes);
                    if p.full {
                        self.last_keyframe = p;
                    }
                }
                Err(TryRecvError::Empty) => return,
                Err(e) => panic!("PRECONDITION: the client keeps up, got {e:?}"),
            }
        }
    }

    /// The client fell behind: the broadcast says Lagged, and the transport resends the
    /// latest keyframe through the relay. Returns that keyframe as the client reads it.
    fn lagged(&mut self) -> RenderPacket {
        match self.diff.try_recv() {
            Err(TryRecvError::Lagged(_)) => {}
            other => panic!(
                "PRECONDITION: the client lagged past the broadcast, got {:?}",
                other.map(|f| f.bytes.len())
            ),
        }
        let p = decode(&self.relay.lagged(&self.kf.borrow_and_update()));
        assert!(p.full, "PRECONDITION: a lag resends a keyframe");
        p
    }
}

fn send(gtx: &impl GestureSink, cmd: GridCommand) {
    gtx.send_gesture(cmd).expect("send gesture");
}

fn place_factory() -> GridCommand {
    GridCommand::Place {
        kind: machine_kind::FACTORY,
        cell_x: 10,
        cell_y: 8,
    }
}

/// The refuter's case 3: the user's own AddPort folds and is undone inside the lag. The
/// keyframe the client gets has the same handle, cell, kind, core node and port list as
/// the one the latch was sent against, so only the `resync` bit can release the latch,
/// and the undo was a restructure.
#[test]
fn own_add_port_undone_inside_a_lag_arrives_as_a_restructure() {
    let rt = rt();
    let dir = tempfile::tempdir().expect("tempdir");
    let (gtx, grx) = gesture_channel();
    let mut sim = SimLoop::new(host(dir.path()), RenderProducer::new(), rt.handle(), cfg(), grx);
    let sub = sim.subscribe();
    send(&gtx, place_factory());
    sim.run(Some(1), Duration::ZERO).expect("place");
    let mut client = Client::connect(sub);
    client.keep_up();
    let a = the_factory(&client.last_keyframe);
    let a_core = core_ids(&sim);

    send(
        &gtx,
        GridCommand::AddPort {
            node: a.id,
            role: 1,
            side: 1,
            medium: 0,
        },
    );
    sim.run(Some(1), Duration::ZERO).expect("fold the AddPort");
    send(&gtx, GridCommand::Undo);
    sim.run(Some(1), Duration::ZERO).expect("fold the Undo");
    sim.run(Some(LAG_TICKS), Duration::ZERO).expect("run past the broadcast");

    let p = client.lagged();
    let after = the_factory(&p);
    assert_eq!(
        (after.id, after.cell_x, after.cell_y, after.kind, &after.ports),
        (a.id, a.cell_x, a.cell_y, a.kind, &a.ports),
        "PRECONDITION: same handle, cell, kind and ports as the latch was sent against"
    );
    assert_eq!(core_ids(&sim), a_core, "PRECONDITION: the same core node");
    assert!(
        !p.resync,
        "LAG ACROSS AN UNDO: the keyframe is a restructure (resync false), so the client \
         releases the latch on the AddPort the Undo took back"
    );
}

/// The refuter's case 2: A is deleted, another Factory is placed on A's origin cell, and
/// an Undo resets the producer inside the lag. The new Factory lands on A's handle with
/// A's cell, kind and catalog port list, but it is another core node.
#[test]
fn another_factory_on_the_latched_handle_after_a_reset_arrives_as_a_restructure() {
    let rt = rt();
    let dir = tempfile::tempdir().expect("tempdir");
    let (gtx, grx) = gesture_channel();
    let mut sim = SimLoop::new(host(dir.path()), RenderProducer::new(), rt.handle(), cfg(), grx);
    let sub = sim.subscribe();
    send(&gtx, place_factory());
    sim.run(Some(1), Duration::ZERO).expect("place A");
    let mut client = Client::connect(sub);
    client.keep_up();
    let a = the_factory(&client.last_keyframe);
    let a_core = core_ids(&sim);

    send(
        &gtx,
        GridCommand::AddPort {
            node: a.id,
            role: 1,
            side: 1,
            medium: 0,
        },
    );
    sim.run(Some(1), Duration::ZERO).expect("fold the AddPort");
    send(&gtx, GridCommand::Delete { node: a.id });
    sim.run(Some(1), Duration::ZERO).expect("delete A");
    send(&gtx, place_factory());
    sim.run(Some(1), Duration::ZERO).expect("place B on A's cell");
    send(
        &gtx,
        GridCommand::Place {
            kind: machine_kind::SOURCE,
            cell_x: 30,
            cell_y: 30,
        },
    );
    sim.run(Some(1), Duration::ZERO).expect("place a Source");
    send(&gtx, GridCommand::Undo);
    sim.run(Some(1), Duration::ZERO).expect("undo the Source");
    sim.run(Some(LAG_TICKS), Duration::ZERO).expect("run past the broadcast");

    let p = client.lagged();
    let b = the_factory(&p);
    assert_eq!(
        (b.id, b.cell_x, b.cell_y, b.kind, &b.ports),
        (a.id, a.cell_x, a.cell_y, a.kind, &a.ports),
        "PRECONDITION: B sits on A's handle, cell and kind with A's sent port key"
    );
    assert_ne!(core_ids(&sim), a_core, "PRECONDITION: B is another core node");
    assert!(
        !p.resync,
        "LAG ACROSS A RESET: B's keyframe is a restructure (resync false), so A's latch is \
         released and never shown on B"
    );
}

/// The refuter's case 1: a board swap (New) inside the lag discards the queued AddPort
/// (`install_swapped_host` drains the gesture channel), and a Factory placed on the new
/// board takes handle 0 at A's origin cell with A's catalog port list.
#[test]
fn a_board_swap_inside_a_lag_arrives_as_a_restructure() {
    let rt = rt();
    let dir = tempfile::tempdir().expect("tempdir");
    let (gtx, grx) = gesture_channel();
    let (ctx, crx) = unbounded_channel::<ControlMsg>();
    let mut sim = SimLoop::new(host(dir.path()), RenderProducer::new(), rt.handle(), cfg(), grx)
        .with_control(crx);
    let sub = sim.subscribe();
    send(&gtx, place_factory());
    sim.run(Some(1), Duration::ZERO).expect("place A");
    let mut client = Client::connect(sub);
    client.keep_up();
    let a = the_factory(&client.last_keyframe);

    // The AddPort is queued, then New swaps the board before it folds and discards it.
    send(
        &gtx,
        GridCommand::AddPort {
            node: a.id,
            role: 1,
            side: 1,
            medium: 0,
        },
    );
    ctx.send(ControlMsg::New).expect("send New");
    sim.run(Some(1), Duration::ZERO).expect("swap to a new board");
    send(&gtx, place_factory());
    sim.run(Some(1), Duration::ZERO).expect("place C on the new board");
    sim.run(Some(LAG_TICKS), Duration::ZERO).expect("run past the broadcast");

    let p = client.lagged();
    let c = the_factory(&p);
    assert_eq!(
        (c.id, c.cell_x, c.cell_y, c.kind, &c.ports),
        (a.id, a.cell_x, a.cell_y, a.kind, &a.ports),
        "PRECONDITION: C sits on A's handle, cell and kind with A's sent port key"
    );
    assert!(
        !p.resync,
        "LAG ACROSS A BOARD SWAP: the keyframe is a restructure (resync false), so the \
         latch on the discarded AddPort is released"
    );
}

/// CONTROL (73-12 still holds): a lag with no reset in it is a resync. The AddPort folds
/// inside the lag and nothing restructures, so the client must keep its latch until it
/// sees the fold, and the bit says so.
#[test]
fn a_lag_with_no_reset_in_it_is_still_a_resync() {
    let rt = rt();
    let dir = tempfile::tempdir().expect("tempdir");
    let (gtx, grx) = gesture_channel();
    let mut sim = SimLoop::new(host(dir.path()), RenderProducer::new(), rt.handle(), cfg(), grx);
    let sub = sim.subscribe();
    send(&gtx, place_factory());
    sim.run(Some(1), Duration::ZERO).expect("place");
    let mut client = Client::connect(sub);
    client.keep_up();
    let a = the_factory(&client.last_keyframe);

    send(
        &gtx,
        GridCommand::AddPort {
            node: a.id,
            role: 1,
            side: 1,
            medium: 0,
        },
    );
    sim.run(Some(1), Duration::ZERO).expect("fold the AddPort");
    sim.run(Some(LAG_TICKS), Duration::ZERO).expect("run past the broadcast");

    let p = client.lagged();
    assert_eq!(
        the_factory(&p).ports.len(),
        a.ports.len() + 1,
        "PRECONDITION: the AddPort folded inside the lag"
    );
    assert!(
        p.resync,
        "CONTROL: no reset among the dropped frames, so the keyframe is a lag resync"
    );
}

/// CONTROL: a client that KEPT UP through a reset (it was sent the reset's own keyframe)
/// and then lagged with no further reset gets a resync. This is what proves the relay
/// tracks the generation of the frames it forwards, not only the one it opened on.
#[test]
fn a_lag_after_a_reset_the_client_saw_is_a_resync() {
    let rt = rt();
    let dir = tempfile::tempdir().expect("tempdir");
    let (gtx, grx) = gesture_channel();
    let mut sim = SimLoop::new(host(dir.path()), RenderProducer::new(), rt.handle(), cfg(), grx);
    let sub = sim.subscribe();
    send(&gtx, place_factory());
    sim.run(Some(1), Duration::ZERO).expect("place");
    let mut client = Client::connect(sub);
    client.keep_up();
    send(
        &gtx,
        GridCommand::Place {
            kind: machine_kind::SOURCE,
            cell_x: 30,
            cell_y: 30,
        },
    );
    sim.run(Some(1), Duration::ZERO).expect("place a Source");
    send(&gtx, GridCommand::Undo);
    sim.run(Some(1), Duration::ZERO).expect("undo it");
    let before = client.last_keyframe.tick;
    client.keep_up();
    assert!(
        client.last_keyframe.tick > before,
        "PRECONDITION: the client was sent the Undo's own keyframe"
    );

    sim.run(Some(LAG_TICKS), Duration::ZERO).expect("run past the broadcast");
    let p = client.lagged();
    assert!(
        p.resync,
        "CONTROL: the only reset was one the client saw, so this lag is a resync"
    );
}
