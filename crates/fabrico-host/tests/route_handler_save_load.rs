//! A user-built Route and HTTP Handler still answer after the board is saved and loaded
//! (quick 261009-rhl; v9.0 milestone audit, Part 1 gap 1; SERVE-04, SERVE-05, UNDO-07).
//!
//! # The hole this closes
//! Two host tests each hold half of the claim and neither holds the whole of it.
//! `headline.rs` round-trips a real POST through a real Handler but never saves or loads.
//! `endpoint.rs::route_reregisters` saves and loads a Route and reads the route MAP back,
//! but never sends a request, and its Route has no Handler behind it. So a board that
//! loaded with its Route registered and its Handler unable to answer (its JS lost in the
//! save, its wire not rebuilt, the endpoint ingress not reattached to the swapped host)
//! passed both. This test builds the board the way a user does, through gestures,
//! saves it to a real `.fab`, loads it into a running sim, and asks it a real question.
//!
//! # Shaped like the app, on purpose
//! - The board is built by GESTURES (`Place`, `DrawWire`, `Configure`), the path the
//!   palette, the wire drag and the Handler panel take, not by the core's seed helpers.
//! - The loopback server is bound BEFORE the Load and serves the sim's live route
//!   projection, as the app's one long-lived server does. A Load that published its
//!   routes somewhere the running server does not read is red here.
//! - The URL is asked of the host the way the Route's panel asks it
//!   (`ControlMsg::QueryWebhookUrl`), for the Route found BY ITS CELL on the loaded
//!   board, never derived from the route map under test or carried over from before the
//!   save.
//! - The answer is graded on status AND body, and the body is the one the Configure
//!   typed, distinct from the Handler preset's, so a Handler that came back holding its
//!   preset is red.
//!
//! # Mutation proof (run 2026-10-09, recorded in the quick task's SUMMARY)
//! - M1: in `sim_loop.rs` `load_swap`, publish an EMPTY route map right after the swap
//!   while the route fingerprint says the loaded set is published. Red: the POST is a 404.
//!   (Removing the `force_republish_routes` call alone does not bite: the per-tick
//!   fingerprint republish publishes the loaded set on the next tick.)
//! - M2: the expected body altered. Red on the body assertion.
//!
//! Run target: `cargo test -p fabrico-host --test route_handler_save_load`

// `fabrico-host` is the project's sanctioned I/O home; writing the `.fab` under a
// tempdir is test IO that belongs here (same allow, same reason, as
// `tests/route_table_write_load_agreement.rs`).
#![allow(clippy::disallowed_methods)]

use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::Duration;

use fabrico_core::core::Core;
use fabrico_core::event::{EventPayload, LogHeader, SCHEMA_VERSION};
use fabrico_core::ids::NodeId;
use fabrico_core::persist::{MAX_RECORD_BYTES, RedbStore};
use fabrico_core::state::{Medium, Node, Role};
use fabrico_host::config::HostConfig;
use fabrico_host::driver::Host;
use fabrico_host::ingress::endpoint::{ENDPOINT_INGRESS_CAPACITY, EndpointIngress};
use fabrico_host::ingress::webhook::{Ingress, WEBHOOK_INGRESS_CAPACITY, webhook_router};
use fabrico_host::ledger::DispatchLedger;
use fabrico_host::project::save_project;
use fabrico_host::render_packet::RenderProducer;
use fabrico_host::sim_loop::{ControlMsg, GestureSink, GestureTx, SimLoop, gesture_channel};
use fabrico_protocol::{GridCommand, MachineConfig, machine_kind};
use tokio::net::TcpListener;
use tokio::sync::mpsc::{channel, unbounded_channel};
use tokio::sync::oneshot;

/// The Route's anchor cell, and the Handler's: the composed walk's leg 1 geometry
/// (`77-one-board-all-five.live.spec.ts` `ROUTE_CELL`, `HANDLER_CELL`).
const ROUTE_CELL: (i32, i32) = (8, 8);
const HANDLER_CELL: (i32, i32) = (12, 7);

/// The body the Handler's configured JS answers with. NOT the preset's
/// `hello from fabrico`, so a Handler that loaded holding its preset fails the body check.
const SAVED_BODY: &str = "made in the panel, saved and loaded";

/// The Handler JS, in the shape the composed walk's leg 1 types into the panel.
fn handler_js() -> String {
    format!(
        "export default function (input, ctx) {{\n  ctx.command({{\n    status: 200,\n    \
         headers: {{ \"content-type\": \"text/plain\" }},\n    body: \"{SAVED_BODY}\",\n  }}, 0);\n}}"
    )
}

fn header() -> LogHeader {
    LogHeader {
        schema_version: SCHEMA_VERSION,
        seed: 0x0026_1009,
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

/// An EMPTY genesis host over tempfile redb stores: the board a user starts on.
fn host_over(dir: &std::path::Path) -> Host {
    let core = Core::genesis(header());
    let store = RedbStore::open(dir.join("log.redb")).expect("open log");
    let ledger = DispatchLedger::open(dir.join("ledger.redb")).expect("open ledger");
    Host::new(core, store, ledger, None).expect("open host")
}

/// Send one gesture and fold it one tick.
fn gesture(sim: &mut SimLoop, gtx: &GestureTx, cmd: GridCommand) {
    gtx.send_gesture(cmd).expect("send gesture");
    sim.run(Some(1), Duration::ZERO).expect("fold the gesture");
}

/// Place a machine of `kind` from the palette and return its id.
fn place(sim: &mut SimLoop, gtx: &GestureTx, kind: u8, (cell_x, cell_y): (i32, i32)) -> NodeId {
    gesture(sim, gtx, GridCommand::Place { kind, cell_x, cell_y });
    *sim.host()
        .core()
        .last_tick
        .placed
        .last()
        .expect("the placement minted an id")
}

/// The index of `node`'s declared electrical port of `role`, read off the folded board
/// (the way the live walk reads `ports.find(role, medium)`), never a hard-coded index.
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
    sim.handle_for_node(node)
        .expect("the node has a render handle")
}

/// The number of `Node::Wire`s on the folded board.
fn wire_count(sim: &SimLoop) -> usize {
    let state = &sim.host().core().state;
    state
        .node_ids()
        .filter(|id| matches!(state.node(*id), Some(Node::Wire(_))))
        .count()
}

/// The number of logged `WireRequest` events.
fn wire_requests(sim: &SimLoop) -> usize {
    sim.host()
        .logged_events()
        .expect("read log")
        .iter()
        .filter(|e| matches!(e.payload, EventPayload::WireRequest { .. }))
        .count()
}

/// Build the board by gestures (Route, Handler, one wire drag, the Handler's JS from its
/// panel) and save it to `fab`.
fn build_and_save(rt: &tokio::runtime::Runtime, fab: &std::path::Path) {
    let dir = tempfile::tempdir().expect("tempdir");
    let (gtx, grx) = gesture_channel();
    let mut sim = SimLoop::new(host_over(dir.path()), RenderProducer::new(), rt.handle(), sim_cfg(), grx);

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
    assert_eq!(
        wire_count(&sim),
        2,
        "precondition: the one drag minted the forward and the return leg (72 D-04)"
    );
    gesture(
        &mut sim,
        &gtx,
        GridCommand::Configure {
            node: hh,
            config: MachineConfig::Factory { source: handler_js() },
        },
    );
    match sim.host().core().state.node(handler) {
        Some(Node::Factory(f)) => assert!(
            f.source.contains(SAVED_BODY),
            "precondition: the Configure installed the panel JS before the save"
        ),
        other => panic!("the Handler is a Factory node, got {other:?}"),
    }
    save_project(sim.host(), fab).expect("save the hand-built board");
}

/// Bind a real loopback listener serving the sim's LIVE route projection.
fn serve(
    rt: &tokio::runtime::Runtime,
    sim: &SimLoop,
    endpoint_tx: tokio::sync::mpsc::Sender<EndpointIngress>,
) -> (SocketAddr, tokio::task::JoinHandle<()>) {
    let listener = rt
        .block_on(async { TcpListener::bind("127.0.0.1:0").await })
        .expect("bind loopback");
    let addr = listener.local_addr().expect("local addr");
    let (web_tx, _web_rx) = channel::<Ingress>(WEBHOOK_INGRESS_CAPACITY);
    let app = webhook_router(
        sim.routes_receiver(),
        web_tx,
        endpoint_tx,
        MAX_RECORD_BYTES,
        Arc::new(AtomicBool::new(true)),
    );
    let server = rt.spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (addr, server)
}

#[test]
fn a_user_built_route_and_handler_answer_after_save_and_load() {
    let rt = rt();
    let save_dir = tempfile::tempdir().expect("save tempdir");
    let fab = save_dir.path().join("route-and-handler.fab");
    build_and_save(&rt, &fab);

    // A running sim on an EMPTY board, its server already listening, as the app is when
    // the user presses Load.
    let dir = tempfile::tempdir().expect("tempdir");
    let (_gtx, grx) = gesture_channel();
    let (ctx, crx) = unbounded_channel::<ControlMsg>();
    let (endpoint_tx, endpoint_rx) = channel::<EndpointIngress>(ENDPOINT_INGRESS_CAPACITY);
    let mut sim = SimLoop::new(host_over(dir.path()), RenderProducer::new(), rt.handle(), sim_cfg(), grx)
        .with_control(crx)
        .with_endpoint(endpoint_rx);
    let (addr, server) = serve(&rt, &sim, endpoint_tx);
    assert!(
        sim.routes_receiver().borrow().is_empty(),
        "precondition: the board the Load replaces has no route at all"
    );

    ctx.send(ControlMsg::Load(fab)).expect("send load");
    sim.step().expect("service the Load");
    sim.run(Some(1), Duration::ZERO).expect("one tick on the loaded board");

    // The loaded Route, found BY ITS CELL, and its URL asked of the host the way the panel
    // asks it.
    let route = sim
        .host()
        .core()
        .state
        .occupied(ROUTE_CELL)
        .expect("the loaded board holds a machine at the Route's cell");
    assert!(
        matches!(sim.host().core().state.node(route), Some(Node::Endpoint(_))),
        "the machine at the Route's cell is the Route"
    );
    assert_eq!(wire_count(&sim), 2, "the loaded board holds both wire legs");
    let (reply, mut url_rx) = oneshot::channel();
    ctx.send(ControlMsg::QueryWebhookUrl {
        node: handle(&sim, route),
        addr,
        reply,
    })
    .expect("send QueryWebhookUrl");
    sim.run(Some(1), Duration::ZERO).expect("service the URL query");
    let url = url_rx
        .try_recv()
        .expect("the URL query replied")
        .expect("the loaded Route has a URL");

    // A real POST over a real socket, answered by the loaded Handler's own JS.
    let before = wire_requests(&sim);
    let (resp_tx, resp_rx) = std::sync::mpsc::channel();
    let post_url = url.clone();
    rt.spawn(async move {
        tokio::time::sleep(Duration::from_millis(30)).await;
        let r = reqwest::Client::new()
            .post(&post_url)
            .header("content-type", "application/json")
            .body("{\"probe\":\"after-load\"}")
            .send()
            .await
            .expect("POST sent");
        let status = r.status().as_u16();
        let body = r.text().await.expect("read body");
        let _ = resp_tx.send((status, body));
    });
    sim.run(Some(200), Duration::from_millis(5))
        .expect("drive the round trip on the loaded board");
    server.abort();

    let (status, body) = resp_rx
        .recv_timeout(Duration::from_secs(10))
        .expect("the caller received an answer from the loaded board");
    assert_eq!(
        (status, body.as_str()),
        (200, SAVED_BODY),
        "POST {url} on the LOADED board: the Route answers 200 with the body its Handler's \
         saved JS produces (SERVE-04, SERVE-05, UNDO-07)"
    );
    assert_eq!(
        wire_requests(&sim) - before,
        1,
        "the answer came through the sim: the POST minted exactly one WireRequest"
    );
}
