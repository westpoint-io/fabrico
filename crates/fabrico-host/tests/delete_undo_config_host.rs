//! Phase 86 plans 03 and 04 (WORK-01, D-01, D-10): a machine deleted and restored by Undo
//! comes back with its config on a real `Host`, live and after a save and a reopen.
//!
//! # Plan 86-03: a Source keeps its Timer across an Undo taken AFTER a reopen
//! A Source's trigger is not core state: a `Configure{Source}` folds to nothing in the
//! core, and the host's timer projection (`project_timers`) reads the newest logged
//! `Configure{Source}` per node. So an undo can only give a Timer back by appending a
//! `Configure{Source}` that carries it, and the command layer can only build that record
//! from the trigger it captured when the Delete (or the Configure being undone) folded.
//! After a reopen the session is rebuilt from the saved log, and the live capture read
//! the trigger from a running map that starts empty, so it read Webhook.
//!
//! - `source_timer_after_load_then_delete_then_undo`: a Timer Source, saved and reopened,
//!   then Delete and Undo. The restored Source's newest logged trigger is the Timer, and
//!   the timer projection holds its interval.
//! - `source_configure_undo_after_load_restores_the_timer`: the same board reopened, the
//!   Source configured to Webhook, then Undo: the Timer is back, in the log and in the
//!   projection.
//!
//! # Plan 86-04: one leg per kind, each through Delete, Undo, a save, a reopen, and a
//! second Delete and Undo on the reopened host
//! - `route_path_survives_delete_then_undo_live_and_after_reopen`: a Route at `/orders` on
//!   a RUNNING loop with a real loopback server. After every Undo the live route table maps
//!   `/orders` to the re-minted Route and a POST there gets the status it got before the
//!   Delete (404 while deleted). The reopen is a `ControlMsg::Load` into a second running
//!   loop, the app's Load path (the `route_handler_save_load.rs` shape).
//! - `source_timer_survives_delete_then_undo_and_its_door_stays_shut`: a Timer Source on a
//!   running loop. After every Undo the loop's live timer set holds its interval, the live
//!   route table gives it no door, the host answers no URL for it (what the panel shows),
//!   and a POST to the URL it had on Webhook gets 404.
//! - `factory_js_and_code_hash_survive_delete_then_undo`,
//!   `handler_js_and_code_hash_survive_delete_then_undo`: the JS comes back, and the
//!   undo group's `Configure{Factory}` carries `code_hash == blake3(source)` (the host's
//!   `stamp_factory_code_hashes`, threat T-86-12), never the command layer's zero.
//! - `sink_target_survives_delete_then_undo`, `router_rules_survive_delete_then_undo`,
//!   `label_survives_delete_then_undo_on_the_host` (a regression leg: 76-05 restored a
//!   label before this phase).
//! - `docked_belt_pace_survives_a_machine_delete_then_undo`: a belt docked to a Router at a
//!   non-default pace comes back docked, at that pace.
//! - `bare_belt_pace_survives_delete_then_undo_on_the_host`: a belt deleted on its own
//!   through `apply_gesture` (the client has no belt Delete until BELT-02, phase 89) comes
//!   back at its pace.
//!
//! Every configured value differs from the kind's placement default, asserted, so a host
//! that restored defaults could not pass. Every new leg was run FAILED against a mutated
//! copy of the plan's start revision (the Delete inverse's re-Configure narrowed back to
//! labels and the cascade belt Configure removed); readings in `86-EVIDENCE.md`.
//!
//! Run target: `cargo test -p fabrico-host --test delete_undo_config_host`

// Writing the `.fab` under a tempdir and serving a loopback socket is test IO, the same
// allow and reason as `route_handler_save_load.rs`.
#![allow(clippy::disallowed_methods)]

use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::Duration;

use fabrico_core::command::{Command, ResultEvent};
use fabrico_core::core::Core;
use fabrico_core::edit::{EditOp, MachineConfig as CoreConfig, SourceTrigger as CoreTrigger};
use fabrico_core::event::{EventPayload, LogHeader, SCHEMA_VERSION};
use fabrico_core::ids::NodeId;
use fabrico_core::persist::{MAX_RECORD_BYTES, RedbStore};
use fabrico_core::state::{Footprint, Node, Role};
use fabrico_host::config::HostConfig;
use fabrico_host::driver::Host;
use fabrico_host::ingress::endpoint::{ENDPOINT_INGRESS_CAPACITY, EndpointIngress};
use fabrico_host::ingress::timer::project_timers;
use fabrico_host::ingress::webhook::{Ingress, WEBHOOK_INGRESS_CAPACITY, webhook_router};
use fabrico_host::input_apply::apply_gesture;
use fabrico_host::ledger::DispatchLedger;
use fabrico_host::project::{load_project, save_project};
use fabrico_host::render_packet::RenderProducer;
use fabrico_host::sim_loop::{ControlMsg, GestureSink, GestureTx, SimLoop, gesture_channel};
use fabrico_protocol::{
    BeltEnd, GridCommand, HttpMethod, MachineConfig, RouteKey, SinkTemplate, SourceTrigger, machine_kind,
};
use tokio::net::TcpListener;
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, channel, unbounded_channel};
use tokio::sync::oneshot;

const INTERVAL: u64 = 45;
const CELL: (i32, i32) = (4, 4);

/// A host plus the channel triple `tick_once` requires, and the dirs it lives in.
struct Rig {
    host: Host,
    ingress_rx: UnboundedReceiver<EventPayload>,
    results_rx: UnboundedReceiver<ResultEvent>,
    cmd_tx: UnboundedSender<Command>,
    _ingress_tx: UnboundedSender<EventPayload>,
    _res_tx: UnboundedSender<ResultEvent>,
    _cmd_rx: UnboundedReceiver<Command>,
    _dirs: Vec<tempfile::TempDir>,
}

fn rig(host: Host, dirs: Vec<tempfile::TempDir>) -> Rig {
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
        _dirs: dirs,
    }
}

/// A genesis host over tempfile redb stores.
fn fresh_rig() -> Rig {
    let dir = tempfile::tempdir().expect("tempdir");
    let core = Core::genesis(LogHeader { schema_version: SCHEMA_VERSION, seed: 0x86_03 });
    let store = RedbStore::open(dir.path().join("log.redb")).expect("open log");
    let ledger = DispatchLedger::open(dir.path().join("ledger.redb")).expect("open ledger");
    let host = Host::new(core, store, ledger, None).expect("open host");
    rig(host, vec![dir])
}

/// Apply one gesture whose only handle (0) names `id`, then fold one tick.
fn gesture(rig: &mut Rig, cmd: GridCommand, id: Option<NodeId>) {
    apply_gesture(&mut rig.host, cmd, move |h| if h == 0 { id } else { None })
        .expect("the gesture is accepted");
    rig.host
        .tick_once(&mut rig.ingress_rx, &mut rig.results_rx, &rig.cmd_tx)
        .expect("tick_once persists and folds");
}

fn timer_config() -> MachineConfig {
    MachineConfig::Source { trigger: SourceTrigger::Timer { interval_ticks: INTERVAL } }
}

/// A host holding one Timer Source at [`CELL`], saved, then reopened into a fresh work
/// dir: the reopened rig and the Source's id on it.
fn reopened_timer_source() -> (Rig, NodeId) {
    let mut first = fresh_rig();
    gesture(&mut first, GridCommand::Place { kind: machine_kind::SOURCE, cell_x: CELL.0, cell_y: CELL.1 }, None);
    let source = first.host.core().state.occupied(CELL).expect("the Source stands on its cell");
    gesture(&mut first, GridCommand::Configure { node: 0, config: timer_config() }, Some(source));
    assert_eq!(the_trigger(&first.host, source), timer(), "the Timer landed before the save");

    let save_dir = tempfile::tempdir().expect("save dir");
    let fab = save_dir.path().join("timer-source.fab");
    save_project(&first.host, &fab).expect("the board saves");
    let work = tempfile::tempdir().expect("load work dir");
    let host = load_project(&fab, work.path(), None).expect("the board opens");
    let reopened = rig(host, vec![save_dir, work]);
    let id = reopened.host.core().state.occupied(CELL).expect("the reopened board holds the Source");
    assert_eq!(the_trigger(&reopened.host, id), timer(), "the reopened log still names the Timer");
    (reopened, id)
}

fn timer() -> (CoreTrigger, Option<u64>) {
    (CoreTrigger::Timer { interval_ticks: INTERVAL }, Some(INTERVAL))
}

/// The Source's trigger as the host sees it: the newest logged `Configure{Source}` naming
/// `id` (Webhook when none) and the interval the host's timer projection holds for it.
fn the_trigger(host: &Host, id: NodeId) -> (CoreTrigger, Option<u64>) {
    let edits = host.logged_edits().expect("read the edit log");
    let logged = edits
        .iter()
        .rev()
        .find_map(|r| match &r.op {
            EditOp::Configure { node, config: CoreConfig::Source { trigger }, .. } if *node == id => {
                Some(trigger.clone())
            }
            _ => None,
        })
        .unwrap_or(CoreTrigger::Webhook);
    (logged, project_timers(&edits).interval_for(id))
}

#[test]
fn source_timer_after_load_then_delete_then_undo() {
    let (mut rig, source) = reopened_timer_source();
    gesture(&mut rig, GridCommand::Delete { node: 0 }, Some(source));
    assert!(rig.host.core().state.occupied(CELL).is_none(), "the Delete took the Source");
    assert_eq!(project_timers(&rig.host.logged_edits().expect("log")).interval_for(source), None, "no timer for a deleted Source");

    gesture(&mut rig, GridCommand::Undo, None);
    let back = rig.host.core().state.occupied(CELL).expect("the Source is back on its cell");
    assert!(matches!(rig.host.core().state.node(back), Some(Node::Source(_))), "a Source came back");
    assert_eq!(the_trigger(&rig.host, back), timer(), "the restored Source is a Timer source with its interval");
}

#[test]
fn source_configure_undo_after_load_restores_the_timer() {
    let (mut rig, source) = reopened_timer_source();
    gesture(
        &mut rig,
        GridCommand::Configure { node: 0, config: MachineConfig::Source { trigger: SourceTrigger::Webhook } },
        Some(source),
    );
    assert_eq!(the_trigger(&rig.host, source), (CoreTrigger::Webhook, None), "the Configure made it a webhook source");

    gesture(&mut rig, GridCommand::Undo, None);
    assert_eq!(the_trigger(&rig.host, source), timer(), "the Undo gives the Timer back");
}

// ---------------------------------------------------------------------------
// Plan 86-04: a running loop with a real loopback server, the app's shape
// ---------------------------------------------------------------------------

/// The Route's anchor cell on both loops.
const ROUTE_CELL: (i32, i32) = (8, 8);
/// The path the user gives the Route, and the route-table key it publishes under.
const TYPED_PATH: &str = "/orders";

fn rt() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_multi_thread().enable_all().build().expect("build runtime")
}

/// A running sim loop on an EMPTY board, its control and gesture channels, and a real
/// loopback server serving the loop's LIVE route projection (bound before any gesture, as
/// the app's one long-lived server is).
struct Running {
    sim: SimLoop,
    gtx: GestureTx,
    ctx: UnboundedSender<ControlMsg>,
    addr: SocketAddr,
    server: tokio::task::JoinHandle<()>,
    _web_rx: tokio::sync::mpsc::Receiver<Ingress>,
    _dir: tempfile::TempDir,
}

impl Drop for Running {
    fn drop(&mut self) {
        self.server.abort();
    }
}

fn running(rt: &tokio::runtime::Runtime) -> Running {
    let dir = tempfile::tempdir().expect("tempdir");
    let core = Core::genesis(LogHeader { schema_version: SCHEMA_VERSION, seed: 0x86_04 });
    let store = RedbStore::open(dir.path().join("log.redb")).expect("open log");
    let ledger = DispatchLedger::open(dir.path().join("ledger.redb")).expect("open ledger");
    let host = Host::new(core, store, ledger, None).expect("open host");
    let (gtx, grx) = gesture_channel();
    let (ctx, crx) = unbounded_channel::<ControlMsg>();
    let (endpoint_tx, endpoint_rx) = channel::<EndpointIngress>(ENDPOINT_INGRESS_CAPACITY);
    let cfg = HostConfig { webhook_addr: "127.0.0.1:0".parse().expect("loopback addr") };
    let sim = SimLoop::new(host, RenderProducer::new(), rt.handle(), cfg, grx)
        .with_control(crx)
        .with_endpoint(endpoint_rx);
    let listener = rt.block_on(async { TcpListener::bind("127.0.0.1:0").await }).expect("bind loopback");
    let addr = listener.local_addr().expect("local addr");
    let (web_tx, web_rx) = channel::<Ingress>(WEBHOOK_INGRESS_CAPACITY);
    let app = webhook_router(sim.routes_receiver(), web_tx, endpoint_tx, MAX_RECORD_BYTES, Arc::new(AtomicBool::new(true)));
    let server = rt.spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    Running { sim, gtx, ctx, addr, server, _web_rx: web_rx, _dir: dir }
}

/// Send one gesture and fold it with a few ticks.
fn send(l: &mut Running, cmd: GridCommand) {
    l.gtx.send_gesture(cmd).expect("send gesture");
    l.sim.run(Some(2), Duration::ZERO).expect("fold the gesture");
}

fn handle(l: &Running, id: NodeId) -> u64 {
    l.sim.handle_for_node(id).expect("a live node has a render handle")
}

fn occupant(l: &Running, cell: (i32, i32)) -> Option<NodeId> {
    l.sim.host().core().state.occupied(cell)
}

/// The URL the host answers for `id`, asked the way the config panel asks it.
fn url_of(l: &mut Running, id: NodeId) -> Option<String> {
    let (reply, mut rx) = oneshot::channel();
    let node = handle(l, id);
    l.ctx.send(ControlMsg::QueryWebhookUrl { node, addr: l.addr, reply }).expect("send QueryWebhookUrl");
    l.sim.run(Some(1), Duration::ZERO).expect("service the URL query");
    rx.try_recv().expect("the URL query replied")
}

/// POST once to `url` over a real socket and drive the loop until the caller has an
/// answer: the status it got. A Route with no Handler behind it is answered by the
/// deadline sweep, so this drives up to a few deadlines' worth of ticks.
fn status_at(rt: &tokio::runtime::Runtime, l: &mut Running, url: &str) -> u16 {
    let (tx, rx) = std::sync::mpsc::channel();
    let u = url.to_owned();
    rt.spawn(async move {
        let r = reqwest::Client::new()
            .post(&u)
            .header("content-type", "application/json")
            .body("{\"probe\":\"86-04\"}")
            .send()
            .await
            .map(|r| r.status().as_u16())
            .map_err(|e| e.to_string());
        let _ = tx.send(r);
    });
    for _ in 0..3000 {
        l.sim.run(Some(1), Duration::from_millis(1)).expect("drive the loop");
        if let Ok(r) = rx.try_recv() {
            return r.expect("the POST got an answer");
        }
    }
    panic!("POST {url}: no answer within 3000 ticks");
}

/// The live route table's entry for `key`, as the running server reads it.
fn routed(l: &Running, key: &str) -> Option<NodeId> {
    l.sim.routes_receiver().borrow().get(key).copied()
}

/// Save the running loop's board to a `.fab` and Load it into a SECOND running loop, the
/// app's Load path (`ControlMsg::Load` into a loop whose server already listens).
fn save_and_load_into_a_running_loop(rt: &tokio::runtime::Runtime, l: &Running) -> (Running, tempfile::TempDir) {
    let save_dir = tempfile::tempdir().expect("save dir");
    let fab = save_dir.path().join("delete-undo-config.fab");
    save_project(l.sim.host(), &fab).expect("the board saves");
    let mut loaded = running(rt);
    loaded.ctx.send(ControlMsg::Load(fab)).expect("send load");
    loaded.sim.step().expect("service the Load");
    loaded.sim.run(Some(2), Duration::ZERO).expect("ticks on the loaded board");
    (loaded, save_dir)
}

/// Delete the Route at [`ROUTE_CELL`] (a POST to `url` is 404 while it is gone), then Undo,
/// and grade the restored Route: the table maps the typed path to it, the host answers the
/// same URL for it, and a POST there gets `want`. Returns the restored id.
fn route_delete_then_undo(rt: &tokio::runtime::Runtime, l: &mut Running, url: &str, want: u16, when: &str) -> NodeId {
    let id = occupant(l, ROUTE_CELL).expect("the Route stands on its cell");
    let node = handle(l, id);
    send(l, GridCommand::Delete { node });
    assert_eq!(occupant(l, ROUTE_CELL), None, "{when}: the Delete took the Route");
    assert_eq!(routed(l, TYPED_PATH), None, "{when}: with the Route deleted the table has no {TYPED_PATH}");
    assert_eq!(status_at(rt, l, url), 404, "{when}: with the Route deleted, {url} is not found");

    send(l, GridCommand::Undo);
    let back = occupant(l, ROUTE_CELL).expect("the Undo put a machine back on the Route's cell");
    assert!(matches!(l.sim.host().core().state.node(back), Some(Node::Endpoint(_))), "{when}: a Route came back");
    assert_eq!(routed(l, TYPED_PATH), Some(back), "{when}: the live table maps {TYPED_PATH} to the restored Route");
    assert_eq!(url_of(l, back).as_deref(), Some(url), "{when}: the panel's URL for the restored Route is the typed one");
    assert_eq!(status_at(rt, l, url), want, "{when}: {url} answers as it did before the Delete");
    back
}

#[test]
fn route_path_survives_delete_then_undo_live_and_after_reopen() {
    let rt = rt();
    let mut l = running(&rt);
    send(&mut l, GridCommand::Place { kind: machine_kind::ENDPOINT, cell_x: ROUTE_CELL.0, cell_y: ROUTE_CELL.1 });
    let route = occupant(&l, ROUTE_CELL).expect("the Route was placed");
    let seeded = url_of(&mut l, route).expect("a placed Route has a URL");
    assert!(!seeded.ends_with(&format!("/endpoint{TYPED_PATH}")), "the placed Route starts away from the typed path: {seeded}");
    let node = handle(&l, route);
    send(&mut l, GridCommand::Configure { node, config: MachineConfig::Endpoint { path: TYPED_PATH.to_owned() } });
    let url = url_of(&mut l, route).expect("the configured Route has a URL");
    assert!(url.ends_with(&format!("/endpoint{TYPED_PATH}")), "the URL ends at the typed path: {url}");
    assert_eq!(routed(&l, TYPED_PATH), Some(route), "the table maps the typed path to the Route");
    let before = status_at(&rt, &mut l, &url);
    assert_ne!(before, 404, "a Route standing at {TYPED_PATH} answers with something other than 404");

    route_delete_then_undo(&rt, &mut l, &url, before, "live");

    let (mut loaded, _save) = save_and_load_into_a_running_loop(&rt, &l);
    drop(l);
    let reopened = occupant(&loaded, ROUTE_CELL).expect("the reopened board holds the Route");
    assert_eq!(routed(&loaded, TYPED_PATH), Some(reopened), "after the reopen the table maps the typed path to the Route");
    let reopened_url = url_of(&mut loaded, reopened).expect("the reopened Route has a URL");
    assert!(reopened_url.ends_with(&format!("/endpoint{TYPED_PATH}")), "after the reopen the URL ends at the typed path: {reopened_url}");
    assert_eq!(status_at(&rt, &mut loaded, &reopened_url), before, "after the reopen the path answers as before");

    route_delete_then_undo(&rt, &mut loaded, &reopened_url, before, "after the reopen");
}

#[test]
fn source_timer_survives_delete_then_undo_and_its_door_stays_shut() {
    let rt = rt();
    let mut l = running(&rt);
    send(&mut l, GridCommand::Place { kind: machine_kind::SOURCE, cell_x: CELL.0, cell_y: CELL.1 });
    let source = occupant(&l, CELL).expect("the Source was placed");
    let webhook_url = url_of(&mut l, source).expect("a placed Source is on Webhook and has a URL");
    assert!(webhook_url.contains("/hook/src-"), "the Webhook URL is a Source door: {webhook_url}");
    assert_eq!(l.sim.host().timers().interval_for(source), None, "a placed Source has no timer (the default)");
    let node = handle(&l, source);
    send(&mut l, GridCommand::Configure { node, config: timer_config() });
    timer_door_shut(&rt, &mut l, source, &webhook_url, "after the Configure");

    let back = source_delete_then_undo(&rt, &mut l, &webhook_url, "live");
    let (mut loaded, _save) = save_and_load_into_a_running_loop(&rt, &l);
    drop(l);
    let reopened = occupant(&loaded, CELL).expect("the reopened board holds the Source");
    assert_eq!(reopened, back, "the reopened board's Source is the one the Undo restored");
    // The same door on the second loop's own server (the app has one server, so its port
    // does not move; this rig binds a second one).
    let path = &webhook_url[webhook_url.find("/hook/").expect("a Source URL has a /hook/ path")..];
    let webhook_url = format!("http://{}{path}", loaded.addr);
    timer_door_shut(&rt, &mut loaded, reopened, &webhook_url, "after the reopen");
    source_delete_then_undo(&rt, &mut loaded, &webhook_url, "after the reopen");
}

/// The Source `id` is on its Timer as the user left it: the loop's LIVE timer set holds the
/// interval, the live route table gives it no door, the host answers no URL for it (the
/// panel shows none), and a POST to the URL it had on Webhook is 404.
fn timer_door_shut(rt: &tokio::runtime::Runtime, l: &mut Running, id: NodeId, webhook_url: &str, when: &str) {
    assert_eq!(l.sim.host().timers().interval_for(id), Some(INTERVAL), "{when}: the live timer set holds the interval");
    assert_eq!(the_trigger(l.sim.host(), id), timer(), "{when}: the log and its projection name the Timer");
    assert!(
        !l.sim.routes_receiver().borrow().values().any(|v| *v == id),
        "{when}: the live route table gives a Timer Source no door"
    );
    assert_eq!(url_of(l, id), None, "{when}: the host answers no URL for a Timer Source (the panel shows none)");
    assert_eq!(status_at(rt, l, webhook_url), 404, "{when}: a POST to the Webhook URL is refused with 404");
}

/// Delete the Source at [`CELL`], then Undo, and grade the restored Source with
/// [`timer_door_shut`]. Returns the restored id.
fn source_delete_then_undo(rt: &tokio::runtime::Runtime, l: &mut Running, webhook_url: &str, when: &str) -> NodeId {
    let id = occupant(l, CELL).expect("the Source stands on its cell");
    let node = handle(l, id);
    send(l, GridCommand::Delete { node });
    assert_eq!(occupant(l, CELL), None, "{when}: the Delete took the Source");
    assert_eq!(l.sim.host().timers().interval_for(id), None, "{when}: no timer for a deleted Source");
    send(l, GridCommand::Undo);
    let back = occupant(l, CELL).expect("the Undo put a machine back on the Source's cell");
    assert!(matches!(l.sim.host().core().state.node(back), Some(Node::Source(_))), "{when}: a Source came back");
    timer_door_shut(rt, l, back, webhook_url, when);
    back
}

// ---------------------------------------------------------------------------
// Plan 86-04: the other kinds, on a `Host` driven by `apply_gesture` and `tick_once`
// ---------------------------------------------------------------------------

/// Apply one gesture whose handle `i` names `ids[i]`, then fold one tick.
fn gesture_on(rig: &mut Rig, cmd: GridCommand, ids: &[NodeId]) {
    let ids = ids.to_vec();
    apply_gesture(&mut rig.host, cmd, move |h| usize::try_from(h).ok().and_then(|i| ids.get(i).copied()))
        .expect("the gesture is accepted");
    rig.host
        .tick_once(&mut rig.ingress_rx, &mut rig.results_rx, &rig.cmd_tx)
        .expect("tick_once persists and folds");
}

fn placed(rig: &mut Rig, kind: u8, cell: (i32, i32)) -> NodeId {
    gesture_on(rig, GridCommand::Place { kind, cell_x: cell.0, cell_y: cell.1 }, &[]);
    rig.host.core().state.occupied(cell).expect("the placed machine stands on its cell")
}

fn drawn(rig: &mut Rig, cells: &[(i32, i32)]) -> NodeId {
    gesture_on(rig, GridCommand::DrawBelt { cells: cells.to_vec() }, &[]);
    rig.host.core().state.occupied(cells[0]).expect("the drawn belt stands on its first cell")
}

/// The node's whole config read off the host, by the test's own reader (the core for every
/// kind but a Source, whose trigger is the newest logged `Configure{Source}`).
fn config_of(host: &Host, id: NodeId) -> Option<CoreConfig> {
    let state = &host.core().state;
    Some(match state.node(id)? {
        Node::Factory(f) => CoreConfig::Factory { source: f.source.clone() },
        Node::Sink(s) => CoreConfig::Sink { target: s.template.clone() },
        Node::Source(_) => CoreConfig::Source { trigger: the_trigger(host, id).0 },
        Node::Belt(b) => CoreConfig::Belt { ticks_per_slot: b.ticks_per_slot },
        Node::Router(r) => CoreConfig::Router { routes: r.routes.clone(), default: r.default },
        Node::Endpoint(e) => CoreConfig::Endpoint { path: e.path.clone() },
        Node::Label(lb) => {
            let fp = state.footprint_of(id).unwrap_or(Footprint { w: 1, h: 1, rot: 0 });
            CoreConfig::Label { text: lb.text.clone(), colour: lb.colour, w: fp.w, h: fp.h }
        }
        Node::Tee(_) | Node::Balancer(_) | Node::Merge(_) | Node::Wire(_) => return None,
    })
}

/// Save the rig's board and open it into a fresh work dir: `load_project`, the call the
/// app's Load makes.
fn save_and_reopen(saved: &Rig) -> Rig {
    let save_dir = tempfile::tempdir().expect("save dir");
    let fab = save_dir.path().join("delete-undo-config.fab");
    save_project(&saved.host, &fab).expect("the board saves");
    let work = tempfile::tempdir().expect("load work dir");
    let host = load_project(&fab, work.path(), None).expect("the board opens");
    rig(host, vec![save_dir, work])
}

/// Delete `id` (standing at `cell`), then Undo: the restored node's id, and the log length
/// just before the Undo (so a check can read the Undo's own group).
fn delete_then_undo(rig: &mut Rig, id: NodeId, cell: (i32, i32), when: &str) -> (NodeId, usize) {
    gesture_on(rig, GridCommand::Delete { node: 0 }, &[id]);
    assert!(rig.host.core().state.node(id).is_none(), "{when}: the Delete took the node");
    assert_eq!(rig.host.core().state.occupied(cell), None, "{when}: the Delete freed its cell");
    let before = rig.host.logged_edits().expect("read the edit log").len();
    gesture_on(rig, GridCommand::Undo, &[]);
    let back = rig.host.core().state.occupied(cell).expect("the Undo put a node back on its cell");
    (back, before)
}

/// A check on the restored node beyond its config: the rig, the restored id, the log
/// length before the Undo, and when.
type Also = fn(&Rig, NodeId, usize, &str);

fn nothing_more(_: &Rig, _: NodeId, _: usize, _: &str) {}

/// One kind, the whole D-10 sequence on a real host: place `kind` at `cell`, configure it
/// away from its placement default, then Delete and Undo, save and reopen, and Delete and
/// Undo on the reopened host. The config read off the folded node equals the configured
/// one at every read, and `also` grades what hangs off it.
fn kind_leg(kind: u8, cell: (i32, i32), config_for: fn(&Host, NodeId) -> MachineConfig, also: Also) {
    let mut rig = fresh_rig();
    let id = placed(&mut rig, kind, cell);
    let default = config_of(&rig.host, id);
    let config = config_for(&rig.host, id);
    gesture_on(&mut rig, GridCommand::Configure { node: 0, config }, &[id]);
    let want = config_of(&rig.host, id).expect("a configurable kind has a config");
    assert_ne!(Some(&want), default.as_ref(), "the leg configures away from the kind's placement default");

    let (back, before) = delete_then_undo(&mut rig, id, cell, "live");
    assert_eq!(config_of(&rig.host, back), Some(want.clone()), "live: the restored node carries its config");
    also(&rig, back, before, "live");

    let mut rig = save_and_reopen(&rig);
    let id = rig.host.core().state.occupied(cell).expect("the reopened board holds the node");
    assert_eq!(config_of(&rig.host, id), Some(want.clone()), "after the reopen: the node carries its config");
    let (back, before) = delete_then_undo(&mut rig, id, cell, "after the reopen");
    assert_eq!(config_of(&rig.host, back), Some(want), "after the reopen: the restored node carries its config");
    also(&rig, back, before, "after the reopen");
}

/// The Undo group's `Configure{Factory}` for the restored node carries
/// `code_hash == blake3(source)`, the stamp the host puts on every Factory Configure it
/// enqueues (threat T-86-12), never the command layer's zero fence.
fn code_hash_is_blake3_of_the_source(rig: &Rig, back: NodeId, before: usize, when: &str) {
    let edits = rig.host.logged_edits().expect("read the edit log");
    let group = &edits[before..];
    let (source, code_hash) = group
        .iter()
        .find_map(|r| match &r.op {
            EditOp::Configure { node, config: CoreConfig::Factory { source }, code_hash } if *node == back => {
                Some((source.clone(), *code_hash))
            }
            _ => None,
        })
        .unwrap_or_else(|| panic!("{when}: the Undo group re-Configures the restored Factory: {group:?}"));
    assert_ne!(code_hash, [0u8; 32], "{when}: the restored Factory's Configure is not left at the zero fence");
    assert_eq!(code_hash, *blake3::hash(source.as_bytes()).as_bytes(), "{when}: code_hash == blake3(source)");
}

fn factory_js(_: &Host, _: NodeId) -> MachineConfig {
    MachineConfig::Factory { source: "export default (payload) => ({ seen: 8604, payload });".to_owned() }
}

fn handler_js(_: &Host, _: NodeId) -> MachineConfig {
    MachineConfig::Factory {
        source: "export default function (input, ctx) {\n  ctx.command({ status: 201, headers: {}, body: \"86-04\" }, 0);\n}"
            .to_owned(),
    }
}

fn sink_target(_: &Host, _: NodeId) -> MachineConfig {
    MachineConfig::Sink { target: SinkTemplate::Http { url: "http://127.0.0.1:9/orders".to_owned(), method: HttpMethod::Put } }
}

fn router_rules(host: &Host, id: NodeId) -> MachineConfig {
    let outs = host
        .core()
        .state
        .ports_of(id)
        .expect("a placed Router declares ports")
        .iter()
        .filter(|p| p.role == Role::Out)
        .count();
    let outs = u16::try_from(outs).expect("an Out count fits a u16");
    assert!(outs >= 3, "the Router leg names three different Outs");
    MachineConfig::Router {
        routes: vec![
            (RouteKey { offset: 0, expect: b"A".to_vec() }, 1),
            (RouteKey { offset: 2, expect: b"refund".to_vec() }, 2),
        ],
        default: Some(outs - 1),
    }
}

fn label_words(_: &Host, _: NodeId) -> MachineConfig {
    MachineConfig::Label { text: "Order intake".to_owned(), colour: 3, w: 6, h: 2 }
}

#[test]
fn factory_js_and_code_hash_survive_delete_then_undo() {
    kind_leg(machine_kind::FACTORY, CELL, factory_js, code_hash_is_blake3_of_the_source);
}

#[test]
fn handler_js_and_code_hash_survive_delete_then_undo() {
    kind_leg(machine_kind::HANDLER, CELL, handler_js, code_hash_is_blake3_of_the_source);
}

#[test]
fn sink_target_survives_delete_then_undo() {
    kind_leg(machine_kind::SINK, CELL, sink_target, nothing_more);
}

#[test]
fn router_rules_survive_delete_then_undo() {
    kind_leg(machine_kind::ROUTER, CELL, router_rules, nothing_more);
}

#[test]
fn label_survives_delete_then_undo_on_the_host() {
    kind_leg(machine_kind::LABEL, CELL, label_words, nothing_more);
}

/// The pace of the belt standing on `cell`, `None` when no belt stands there.
fn pace_at(host: &Host, cell: (i32, i32)) -> Option<u32> {
    let id = host.core().state.occupied(cell)?;
    match host.core().state.node(id)? {
        Node::Belt(b) => Some(b.ticks_per_slot.get()),
        _ => None,
    }
}

/// Whether some link joins the belt on `cell` and `machine`, in either direction.
fn docked(host: &Host, cell: (i32, i32), machine: NodeId) -> bool {
    let Some(belt) = host.core().state.occupied(cell) else { return false };
    host.core()
        .state
        .links_iter()
        .any(|((f, _), (t, _))| (f == belt && t == machine) || (f == machine && t == belt))
}

/// The router's cell, and the two cells of the belt docked to its Out 1 (the
/// `delete_undo_config.rs` board).
const DOCK_ROUTER_CELL: (i32, i32) = (0, 0);
const DOCK_BELT_CELLS: [(i32, i32); 2] = [(2, 1), (3, 1)];
const DOCKED_PACE: u32 = 9;
const BARE_PACE: u32 = 7;

#[test]
fn docked_belt_pace_survives_a_machine_delete_then_undo() {
    let mut rig = fresh_rig();
    let router = placed(&mut rig, machine_kind::ROUTER, DOCK_ROUTER_CELL);
    let belt = drawn(&mut rig, &DOCK_BELT_CELLS);
    gesture_on(&mut rig, GridCommand::Dock { belt: 0, endpoint: BeltEnd::Tail, node: 1, port: 1 }, &[belt, router]);
    assert!(docked(&rig.host, DOCK_BELT_CELLS[0], router), "the belt docks to the Router");
    let default = pace_at(&rig.host, DOCK_BELT_CELLS[0]);
    assert_ne!(default, Some(DOCKED_PACE), "a drawn belt does not start at the leg's pace");
    gesture_on(&mut rig, GridCommand::Configure { node: 0, config: MachineConfig::Belt { ticks_per_slot: DOCKED_PACE } }, &[belt]);
    assert_eq!(pace_at(&rig.host, DOCK_BELT_CELLS[0]), Some(DOCKED_PACE), "the belt runs at the configured pace");
    let links = rig.host.core().state.links_iter().count();

    let check = |rig: &Rig, back: NodeId, when: &str| {
        assert!(matches!(rig.host.core().state.node(back), Some(Node::Router(_))), "{when}: the Router is back");
        for cell in DOCK_BELT_CELLS {
            assert_eq!(pace_at(&rig.host, cell), Some(DOCKED_PACE), "{when}: the docked belt comes back at its pace at {cell:?}");
        }
        assert!(docked(&rig.host, DOCK_BELT_CELLS[0], back), "{when}: the belt is docked to the restored Router");
        assert_eq!(rig.host.core().state.links_iter().count(), links, "{when}: every dock is back");
    };

    let (back, _) = delete_then_undo(&mut rig, router, DOCK_ROUTER_CELL, "live");
    check(&rig, back, "live");
    let mut rig = save_and_reopen(&rig);
    let router = rig.host.core().state.occupied(DOCK_ROUTER_CELL).expect("the reopened board holds the Router");
    check(&rig, router, "after the reopen");
    assert!(pace_at(&rig.host, DOCK_BELT_CELLS[0]).is_some(), "after the reopen the docked belt stands");
    let (back, _) = delete_then_undo(&mut rig, router, DOCK_ROUTER_CELL, "after the reopen");
    assert!(pace_at(&rig.host, DOCK_BELT_CELLS[0]).is_some(), "after the reopen the Undo re-drew the docked belt");
    check(&rig, back, "after the reopen");
}

#[test]
fn bare_belt_pace_survives_delete_then_undo_on_the_host() {
    let cells = [(10, 10), (11, 10), (12, 10)];
    let mut rig = fresh_rig();
    let belt = drawn(&mut rig, &cells);
    assert_ne!(pace_at(&rig.host, cells[0]), Some(BARE_PACE), "a drawn belt does not start at the leg's pace");
    gesture_on(&mut rig, GridCommand::Configure { node: 0, config: MachineConfig::Belt { ticks_per_slot: BARE_PACE } }, &[belt]);
    let check = |rig: &Rig, when: &str| {
        for cell in cells {
            assert_eq!(pace_at(&rig.host, cell), Some(BARE_PACE), "{when}: the bare belt is at its pace at {cell:?}");
        }
    };
    check(&rig, "before the Delete");

    let (_, _) = delete_then_undo(&mut rig, belt, cells[0], "live");
    check(&rig, "live");
    let mut rig = save_and_reopen(&rig);
    check(&rig, "after the reopen");
    let belt = rig.host.core().state.occupied(cells[0]).expect("the reopened board holds the belt");
    let (_, _) = delete_then_undo(&mut rig, belt, cells[0], "after the reopen");
    check(&rig, "after the reopen, deleted and undone");
}
