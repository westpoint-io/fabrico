//! A request still on a wire when the board is saved cannot answer a new caller after
//! the board is loaded (todo 2026-10-18-endpoint-correlation-counter-restarts-at-zero).
//!
//! # The hole this closes
//! `SimLoop` mints endpoint correlations from `correlation_next`, which started at 0 in
//! every new loop and every loaded board. Correlations are logged on each `WireRequest`
//! and carried inside the snapshot on in-flight wire messages, so a request saved on its
//! forward wire keeps its id across the Load. The fresh loop then minted that same id for
//! the next caller, and the old request's `Effect::Reply` resolved the NEW caller's parked
//! socket with the old request's answer.
//!
//! # Shape
//! Request A is admitted and left on the forward wire, then the board is saved. B has to be
//! parked on the loaded board before A's reply comes back: pushed a tick later, A's reply
//! runs first, finds nothing parked and is dropped, and the collision hides (seen in
//! triage). B can't be queued before the step that services the Load, because a swap refuses
//! whatever is queued on the board it replaces. So the fresh loop holds the board first:
//! with the Load serviced on a paused board no tick runs between the swap and B, and the
//! step that services the Resume mints B ahead of the loaded board's first tick.
//!
//! Run target: `cargo test -p fabrico-host --test endpoint_correlation_after_load`

// `fabrico-host` is the project's sanctioned I/O home; writing the `.fab` under a
// tempdir is test IO that belongs here (same allow, same reason, as
// `tests/route_handler_save_load.rs`).
#![allow(clippy::disallowed_methods)]

use std::time::Duration;

use fabrico_core::core::Core;
use fabrico_core::event::{EventPayload, LogHeader, SCHEMA_VERSION};
use fabrico_core::ids::NodeId;
use fabrico_core::persist::RedbStore;
use fabrico_core::state::{Medium, Node, Role};
use fabrico_host::config::HostConfig;
use fabrico_host::driver::Host;
use fabrico_host::ingress::endpoint::{ENDPOINT_INGRESS_CAPACITY, EndpointIngress, HttpResponse};
use fabrico_host::ledger::DispatchLedger;
use fabrico_host::project::save_project;
use fabrico_host::render_packet::RenderProducer;
use fabrico_host::sim_loop::{ControlMsg, GestureSink, GestureTx, SimLoop, gesture_channel};
use fabrico_protocol::{GridCommand, MachineConfig, machine_kind};
use tokio::sync::mpsc::{Sender, channel, unbounded_channel};
use tokio::sync::oneshot;

const ROUTE_CELL: (i32, i32) = (8, 8);
const HANDLER_CELL: (i32, i32) = (12, 7);

/// A Handler that answers each request with its own envelope, so a caller can tell
/// whose answer it received.
const ECHO_JS: &str = "export default function (input, ctx) {\n  ctx.command({\n    \
                       status: 200,\n    headers: { \"content-type\": \"application/json\" },\n    \
                       body: JSON.stringify(input),\n  }, 0);\n}";

fn header() -> LogHeader {
    LogHeader {
        schema_version: SCHEMA_VERSION,
        seed: 0x0026_1018,
    }
}

fn sim_cfg() -> HostConfig {
    HostConfig {
        webhook_addr: "127.0.0.1:0".parse().expect("loopback addr"),
    }
}

fn rt() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("build runtime")
}

fn host_over(dir: &std::path::Path) -> Host {
    let core = Core::genesis(header());
    let store = RedbStore::open(dir.join("log.redb")).expect("open log");
    let ledger = DispatchLedger::open(dir.join("ledger.redb")).expect("open ledger");
    Host::new(core, store, ledger, None).expect("open host")
}

fn gesture(sim: &mut SimLoop, gtx: &GestureTx, cmd: GridCommand) {
    gtx.send_gesture(cmd).expect("send gesture");
    sim.run(Some(1), Duration::ZERO).expect("fold the gesture");
}

fn place(sim: &mut SimLoop, gtx: &GestureTx, kind: u8, (cell_x, cell_y): (i32, i32)) -> NodeId {
    gesture(sim, gtx, GridCommand::Place { kind, cell_x, cell_y });
    *sim.host()
        .core()
        .last_tick
        .placed
        .last()
        .expect("the placement minted an id")
}

fn electrical(sim: &SimLoop, node: NodeId, role: Role) -> u16 {
    let ports = sim
        .host()
        .core()
        .state
        .ports_of(node)
        .expect("the placed machine declares ports");
    let i = ports
        .iter()
        .position(|p| p.role == role && p.medium == Medium::Electrical)
        .expect("the machine declares an electrical port of this role");
    u16::try_from(i).expect("a port index fits u16")
}

fn handle(sim: &SimLoop, node: NodeId) -> u64 {
    sim.handle_for_node(node).expect("the node has a render handle")
}

/// Messages currently travelling on any wire leg.
fn in_flight(sim: &SimLoop) -> usize {
    let state = &sim.host().core().state;
    state
        .node_ids()
        .filter_map(|id| match state.node(id) {
            Some(Node::Wire(w)) => Some(w.in_flight.len()),
            _ => None,
        })
        .sum()
}

/// The correlation of every logged `WireRequest`, in log order.
fn logged_correlations(sim: &SimLoop) -> Vec<u64> {
    sim.host()
        .logged_events()
        .expect("read log")
        .iter()
        .filter_map(|e| match e.payload {
            EventPayload::WireRequest { correlation, .. } => Some(correlation),
            _ => None,
        })
        .collect()
}

fn ask(tx: &Sender<EndpointIngress>, target: NodeId, body: &str) -> oneshot::Receiver<HttpResponse> {
    let (respond, rx) = oneshot::channel();
    tx.try_send(EndpointIngress {
        target,
        envelope: format!("{{\"body\":\"{body}\"}}").into_bytes(),
        respond,
    })
    .expect("queue the request");
    rx
}

/// Build Route + echo Handler by gestures, admit request A, and save while A is still on
/// the forward wire. Returns the Route's id (stable across the Load's replay).
fn build_and_save_with_a_on_the_wire(rt: &tokio::runtime::Runtime, fab: &std::path::Path) -> NodeId {
    let dir = tempfile::tempdir().expect("tempdir");
    let (gtx, grx) = gesture_channel();
    let (endpoint_tx, endpoint_rx) = channel::<EndpointIngress>(ENDPOINT_INGRESS_CAPACITY);
    let mut sim = SimLoop::new(host_over(dir.path()), RenderProducer::new(), rt.handle(), sim_cfg(), grx)
        .with_endpoint(endpoint_rx);

    let route = place(&mut sim, &gtx, machine_kind::ENDPOINT, ROUTE_CELL);
    let handler = place(&mut sim, &gtx, machine_kind::HANDLER, HANDLER_CELL);
    let (route_out, handler_in) = (
        electrical(&sim, route, Role::Out),
        electrical(&sim, handler, Role::In),
    );
    let (hr, hh) = (handle(&sim, route), handle(&sim, handler));
    gesture(
        &mut sim,
        &gtx,
        GridCommand::DrawWire {
            from_node: hr,
            from_port: route_out,
            to_node: hh,
            to_port: handler_in,
        },
    );
    gesture(
        &mut sim,
        &gtx,
        GridCommand::Configure {
            node: hh,
            config: MachineConfig::Factory { source: ECHO_JS.to_owned() },
        },
    );

    let _a_on_the_old_board = ask(&endpoint_tx, route, "AAAA");
    sim.run(Some(1), Duration::ZERO).expect("admit A");
    assert_eq!(
        (logged_correlations(&sim).len(), in_flight(&sim)),
        (1, 1),
        "precondition: A is logged and still travelling on the forward wire at the save"
    );
    save_project(sim.host(), fab).expect("save with A on the wire");
    route
}

#[test]
fn a_request_saved_on_the_wire_does_not_answer_the_next_caller_after_load() {
    let rt = rt();
    let save_dir = tempfile::tempdir().expect("save tempdir");
    let fab = save_dir.path().join("a-on-the-wire.fab");
    let route = build_and_save_with_a_on_the_wire(&rt, &fab);

    let dir = tempfile::tempdir().expect("tempdir");
    let (_gtx, grx) = gesture_channel();
    let (ctx, crx) = unbounded_channel::<ControlMsg>();
    let (endpoint_tx, endpoint_rx) = channel::<EndpointIngress>(ENDPOINT_INGRESS_CAPACITY);
    let mut sim = SimLoop::new(host_over(dir.path()), RenderProducer::new(), rt.handle(), sim_cfg(), grx)
        .with_control(crx)
        .with_endpoint(endpoint_rx);

    // Held so no tick runs between the swap and B, which is parked before A's reply comes back.
    ctx.send(ControlMsg::Pause).expect("send pause");
    sim.step().expect("hold the fresh board");
    ctx.send(ControlMsg::Load(fab)).expect("send load");
    sim.step().expect("service the Load on the held board");
    ctx.send(ControlMsg::Resume).expect("send resume");
    let mut b = ask(&endpoint_tx, route, "BBBB");
    sim.step().expect("resume and admit B");
    sim.run(Some(60), Duration::from_millis(2)).expect("drive both round trips");

    let answer = b.try_recv().expect("B received an answer");
    assert_eq!(
        (answer.status().as_u16(), String::from_utf8_lossy(answer.body_bytes()).into_owned()),
        (200, "{\"body\":\"BBBB\"}".to_owned()),
        "B is answered with B's own echo, never the reply to A saved on the wire"
    );

    let correlations = logged_correlations(&sim);
    let mut distinct = correlations.clone();
    distinct.sort_unstable();
    distinct.dedup();
    assert_eq!(
        distinct.len(),
        correlations.len(),
        "every logged WireRequest has its own correlation across the Load, got {correlations:?}"
    );
}
