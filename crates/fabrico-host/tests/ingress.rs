//! End-to-end ingress coverage — the two host-driven sources that feed the grid
//! as logged events.
//!
//! - `timer_injects_on_schedule`: a tick-interval timer injects one logged
//!   `ManualInject` event on exactly its `tick % interval == 0` ticks, driven
//!   through the real driver loop — a pure function of the tick (SRC-03).
//! - `webhook_one_event`: a single real loopback `POST /hook/{target}` results
//!   in exactly ONE logged `ManualInject` event reaching the grid (SRC-01).
//! - `dedup_persists`: two POSTs with the SAME delivery id yield one logged
//!   event (in-run dedup), and a duplicate replayed AFTER a host restart (the
//!   same redb seen-set reopened) still yields exactly one logged event total
//!   (INGRESS-02 across a restart).
//!
//! All traffic stays on `127.0.0.1` (loopback only this phase).

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use fabrico_core::command::{Command, ResultEvent};
use fabrico_core::core::Core;
use fabrico_core::event::{EventPayload, LogHeader, SCHEMA_VERSION};
use fabrico_core::ids::NodeId;
use fabrico_core::persist::{MAX_RECORD_BYTES, RedbStore};
use fabrico_host::config::{HostConfig, TimerConfig};
use fabrico_host::driver::Host;
use fabrico_host::ingress::seen_set::SeenSet;
use fabrico_host::ingress::timer::TimerSet;
use fabrico_host::ingress::endpoint::EndpointIngress;
use fabrico_host::ingress::webhook::{Ingress, RouteTable, RoutesRx, WEBHOOK_INGRESS_CAPACITY, webhook_router};
use fabrico_host::ledger::DispatchLedger;
use fabrico_host::render_packet::RenderProducer;
use fabrico_host::sim_loop::{GestureSink, SimLoop, gesture_channel};
use fabrico_protocol::{machine_kind, GridCommand};
use std::sync::atomic::AtomicBool;
use tokio::net::TcpListener;
use tokio::sync::mpsc::{Receiver, Sender, channel, unbounded_channel};

/// A fixed always-Playing signal for the ingress tests that never pause the sim
/// (Gate A stays open; these exercise the normal one-POST-one-event path).
fn playing() -> Arc<AtomicBool> {
    Arc::new(AtomicBool::new(true))
}

/// A real-time driver window long enough for a loopback POST (and its
/// host-loop ack) to complete well within the run: `TICKS * TICK_PAUSE`.
const TICKS: u64 = 120;
const TICK_PAUSE: Duration = Duration::from_millis(5);

fn header() -> LogHeader {
    LogHeader {
        schema_version: SCHEMA_VERSION,
        seed: 1,
    }
}

/// A single `{label} -> node` webhook route table.
fn route_to(label: &str, node: NodeId) -> BTreeMap<String, NodeId> {
    let mut routes = BTreeMap::new();
    routes.insert(label.to_owned(), node);
    routes
}

/// Count the logged `ManualInject` events targeting `source`.
fn injects_for(host: &Host, source: NodeId) -> usize {
    host.logged_events()
        .expect("read log")
        .iter()
        .filter(|e| matches!(&e.payload, EventPayload::ManualInject { target, .. } if *target == source))
        .count()
}

#[test]
fn timer_injects_on_schedule() {
    // The driver injects timer events as part of tick_once on a pure tick%interval
    // schedule: interval 2 over ticks 0..5 fires on exactly 0, 2, 4 (SRC-03).
    let dir = tempfile::tempdir().expect("tempdir");
    let mut core = Core::genesis(header());
    let source = core.state.add_source();
    let store = RedbStore::open(dir.path().join("log.redb")).expect("open log");
    let ledger = DispatchLedger::open(dir.path().join("ledger.redb")).expect("open ledger");
    let timers = TimerSet::new(vec![TimerConfig {
        target: source,
        interval: 2,
        item: b"{}".to_vec(),
    }]);
    let mut host = Host::new(core, store, ledger, None).expect("open host").with_timers(timers);

    let (cmd_tx, _cmd_rx) = unbounded_channel::<Command>();
    let (_res_tx, mut res_rx) = unbounded_channel::<ResultEvent>();
    let (_ing_tx, mut ing_rx) = unbounded_channel::<EventPayload>();

    for _ in 0..5u64 {
        host.tick_once(&mut ing_rx, &mut res_rx, &cmd_tx)
            .expect("tick");
    }

    let fired_ticks: Vec<u64> = host
        .logged_events()
        .expect("read log")
        .iter()
        .filter_map(|e| match &e.payload {
            EventPayload::ManualInject { target, .. } if *target == source => Some(e.tick),
            _ => None,
        })
        .collect();
    assert_eq!(
        fired_ticks,
        vec![0, 2, 4],
        "the timer fires on exactly the multiples of its interval (no clock)"
    );
}

#[test]
fn timer_gate_holds_injections() {
    // set_timers_gated(true) HOLDS timer ingress: tick_once runs but appends NO
    // timer events (Finding 3: a Draining Pause must be able to reach
    // quiescence). Releasing the gate resumes the pure tick%interval schedule —
    // gating only changes which events get LOGGED, never the schedule itself.
    let dir = tempfile::tempdir().expect("tempdir");
    let mut core = Core::genesis(header());
    let source = core.state.add_source();
    let store = RedbStore::open(dir.path().join("log.redb")).expect("open log");
    let ledger = DispatchLedger::open(dir.path().join("ledger.redb")).expect("open ledger");
    let timers = TimerSet::new(vec![TimerConfig {
        target: source,
        interval: 1, // fire EVERY tick, so any gated tick that fires is loud
        item: b"{}".to_vec(),
    }]);
    let mut host = Host::new(core, store, ledger, None).expect("open host").with_timers(timers);

    let (cmd_tx, _cmd_rx) = unbounded_channel::<Command>();
    let (_res_tx, mut res_rx) = unbounded_channel::<ResultEvent>();
    let (_ing_tx, mut ing_rx) = unbounded_channel::<EventPayload>();

    // Ungated (the default): 2 ticks -> 2 injections.
    for _ in 0..2u64 {
        host.tick_once(&mut ing_rx, &mut res_rx, &cmd_tx).expect("tick");
    }
    assert_eq!(injects_for(&host, source), 2, "ungated timers fire every tick");

    // Gated: 3 more ticks -> the injection count is FROZEN.
    host.set_timers_gated(true);
    for _ in 0..3u64 {
        host.tick_once(&mut ing_rx, &mut res_rx, &cmd_tx).expect("gated tick");
    }
    assert_eq!(
        injects_for(&host, source),
        2,
        "a gated tick appends NO timer events (drain can reach quiescence)"
    );

    // Released: the schedule resumes (pure function of the tick, unperturbed).
    host.set_timers_gated(false);
    host.tick_once(&mut ing_rx, &mut res_rx, &cmd_tx).expect("released tick");
    assert_eq!(injects_for(&host, source), 3, "releasing the gate resumes firing");
}

/// Bind a loopback webhook listener serving `routes` on a shared runtime,
/// returning the bound base URL and the receiver the host loop drains.
fn spawn_webhook(
    rt: &tokio::runtime::Runtime,
    routes: BTreeMap<String, NodeId>,
    is_playing: Arc<AtomicBool>,
) -> (String, Receiver<Ingress>, tokio::task::JoinHandle<()>) {
    let (web_tx, web_rx) = channel::<Ingress>(WEBHOOK_INGRESS_CAPACITY);
    // Wrap the static route table in a `watch` channel: dropping the sender is fine
    // (a receiver still `borrow()`s the last value after all senders drop, and the
    // handler only ever borrows). The LIVE-projection path is exercised by
    // `spawn_webhook_watched` below.
    let (_routes_tx, routes_rx) = tokio::sync::watch::channel(std::sync::Arc::new(RouteTable { board: 0, routes }));
    let listener = rt
        .block_on(async { TcpListener::bind("127.0.0.1:0").await })
        .expect("bind loopback");
    let addr = listener.local_addr().expect("local addr");
    // These webhook tests never POST `/endpoint/...`; a throwaway endpoint ingress
    // sender satisfies the shared-router signature (38-02).
    let (endpoint_tx, _endpoint_rx) = tokio::sync::mpsc::channel::<EndpointIngress>(fabrico_host::ingress::endpoint::ENDPOINT_INGRESS_CAPACITY);
    let app = webhook_router(routes_rx, web_tx, endpoint_tx, MAX_RECORD_BYTES, is_playing);
    let server = rt.spawn(async move {
        axum::serve(listener, app).await.expect("serve");
    });
    (format!("http://{addr}"), web_rx, server)
}

/// Bind a loopback webhook listener onto a LIVE route projection (`routes_rx` from
/// a `SimLoop`), returning the bound base URL + server handle. Unlike
/// [`spawn_webhook`], the route table here is the real `watch` snapshot the sim
/// thread publishes — a POST resolves through the PROJECTED id-derived label, not a
/// hand-built table (HOST-07).
fn spawn_webhook_live(
    rt: &tokio::runtime::Runtime,
    routes_rx: RoutesRx,
    web_tx: Sender<Ingress>,
    is_playing: Arc<AtomicBool>,
) -> (String, tokio::task::JoinHandle<()>) {
    let listener = rt
        .block_on(async { TcpListener::bind("127.0.0.1:0").await })
        .expect("bind loopback");
    let addr = listener.local_addr().expect("local addr");
    let (endpoint_tx, _endpoint_rx) = tokio::sync::mpsc::channel::<EndpointIngress>(fabrico_host::ingress::endpoint::ENDPOINT_INGRESS_CAPACITY);
    let app = webhook_router(routes_rx, web_tx, endpoint_tx, MAX_RECORD_BYTES, is_playing);
    let server = rt.spawn(async move {
        axum::serve(listener, app).await.expect("serve");
    });
    (format!("http://{addr}"), server)
}

/// Spawn a delayed POST to `url` carrying `delivery_id` + `body` (a provider's
/// at-least-once delivery), so it arrives while the driver loop is ticking.
fn spawn_post(rt: &tokio::runtime::Runtime, url: String, delivery_id: &'static str, body: &'static str) {
    rt.spawn(async move {
        tokio::time::sleep(Duration::from_millis(20)).await;
        let client = reqwest::Client::new();
        let _ = client
            .post(&url)
            .header("x-delivery-id", delivery_id)
            .body(body)
            .send()
            .await;
    });
}

#[test]
fn webhook_one_event() {
    // A single real loopback POST -> exactly ONE logged ManualInject event
    // reaching the grid (SRC-01).
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("runtime");
    let dir = tempfile::tempdir().expect("tempdir");

    let mut core = Core::genesis(header());
    let source = core.state.add_source();
    let store = RedbStore::open(dir.path().join("log.redb")).expect("open log");
    let ledger = DispatchLedger::open(dir.path().join("ledger.redb")).expect("open ledger");
    let seen = SeenSet::open(dir.path().join("seen.redb")).expect("open seen-set");
    let host = Host::new(core, store, ledger, None).expect("open host").with_seen_set(seen);

    let (base, web_rx, server) = spawn_webhook(&rt, route_to("src-1", source), playing());
    spawn_post(&rt, format!("{base}/hook/src-1"), "d1", "hello");

    let cfg = HostConfig {
        webhook_addr: "127.0.0.1:0".parse().expect("addr"),
    };
    let (_gesture_tx, gesture_rx) = gesture_channel();
    let mut sim = SimLoop::new(host, RenderProducer::new(), rt.handle(), cfg, gesture_rx)
        .with_webhook(web_rx);
    sim.run(Some(TICKS), TICK_PAUSE).expect("run");
    server.abort();

    assert_eq!(
        injects_for(sim.host(), source),
        1,
        "one POST -> exactly one logged event (SRC-01)"
    );
}

#[test]
fn dedup_persists() {
    // In-run dedup AND dedup across a restart: the persisted seen-set collapses an
    // at-least-once provider re-delivery to exactly one logged event, even after
    // the host is dropped and reopened on the same redb files (INGRESS-02).
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("runtime");
    let dir = tempfile::tempdir().expect("tempdir");
    let log_path = dir.path().join("log.redb");
    let ledger_path = dir.path().join("ledger.redb");
    let seen_path = dir.path().join("seen.redb");

    // A source-only topology rebuilt identically each run (slotmap mints the same
    // NodeId for the same insertion sequence, so the logged target routes).
    let build = || {
        let mut core = Core::genesis(header());
        let source = core.state.add_source();
        (core, source)
    };

    // --- Run 1: POST the SAME delivery id twice -> exactly one logged event. ---
    {
        let (core, source) = build();
        let store = RedbStore::open(&log_path).expect("open log");
        let ledger = DispatchLedger::open(&ledger_path).expect("open ledger");
        let seen = SeenSet::open(&seen_path).expect("open seen-set");
        let host = Host::new(core, store, ledger, None).expect("open host").with_seen_set(seen);

        let (base, web_rx, server) = spawn_webhook(&rt, route_to("src-1", source), playing());
        // Two sequential POSTs carrying the SAME delivery id ("dup").
        let url = format!("{base}/hook/src-1");
        rt.spawn(async move {
            tokio::time::sleep(Duration::from_millis(20)).await;
            let client = reqwest::Client::new();
            let _ = client.post(&url).header("x-delivery-id", "dup").body("a").send().await;
            let _ = client.post(&url).header("x-delivery-id", "dup").body("b").send().await;
        });

        let cfg = HostConfig {
            webhook_addr: "127.0.0.1:0".parse().expect("addr"),
        };
        let (_gesture_tx, gesture_rx) = gesture_channel();
        let mut sim = SimLoop::new(host, RenderProducer::new(), rt.handle(), cfg, gesture_rx)
            .with_webhook(web_rx);
        sim.run(Some(TICKS), TICK_PAUSE).expect("run 1");
        server.abort();

        assert_eq!(
            injects_for(sim.host(), source),
            1,
            "same delivery id twice in one run -> exactly one logged event"
        );
        // sim (owning the host) dropped here -> releases the redb file locks
        // (simulates a restart).
    }

    // --- Run 2: reopen the SAME redb files; re-POST the duplicate id. ---
    {
        let (core, source) = build();
        let store = RedbStore::open(&log_path).expect("reopen log");
        let ledger = DispatchLedger::open(&ledger_path).expect("reopen ledger");
        let seen = SeenSet::open(&seen_path).expect("reopen seen-set");
        let mut host = Host::new(core, store, ledger, None).expect("open host").with_seen_set(seen);
        // Model a real restart: rebuild Core from the persisted log + reconcile the
        // ledger (and advance the host sequence past the existing log).
        host.recover().expect("recover");

        let (base, web_rx, server) = spawn_webhook(&rt, route_to("src-1", source), playing());
        spawn_post(&rt, format!("{base}/hook/src-1"), "dup", "c");

        let cfg = HostConfig {
            webhook_addr: "127.0.0.1:0".parse().expect("addr"),
        };
        let (_gesture_tx, gesture_rx) = gesture_channel();
        let mut sim = SimLoop::new(host, RenderProducer::new(), rt.handle(), cfg, gesture_rx)
            .with_webhook(web_rx);
        sim.run(Some(TICKS), TICK_PAUSE).expect("run 2");
        server.abort();

        assert_eq!(
            injects_for(sim.host(), source),
            1,
            "a duplicate delivery id replayed across a restart -> still exactly one logged event (INGRESS-02)"
        );
    }
}

/// Build a genesis Host with a REAL persisted seen-set (mirrors `webhook_one_event`)
/// over fresh temp redb files.
fn host_with_seen_set(dir: &std::path::Path) -> Host {
    let core = Core::genesis(header());
    let store = RedbStore::open(dir.join("log.redb")).expect("open log");
    let ledger = DispatchLedger::open(dir.join("ledger.redb")).expect("open ledger");
    let seen = SeenSet::open(dir.join("seen.redb")).expect("open seen-set");
    Host::new(core, store, ledger, None)
        .expect("open host")
        .with_seen_set(seen)
}

#[test]
fn webhook_routes_to_a_gesture_placed_source() {
    // HOST-06 + HOST-07 over the REAL projection: a Source PLACED via a gesture (not
    // a hand-built route table) becomes reachable at its PROJECTED id-derived label,
    // and a single loopback POST to that label fires exactly ONE logged ManualInject
    // through the dedup-before-log path.
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("runtime");
    let dir = tempfile::tempdir().expect("tempdir");
    let host = host_with_seen_set(dir.path());

    // The webhook seam: the server sends Ingress on web_tx; the sim drains web_rx.
    let (web_tx, web_rx) = channel::<Ingress>(WEBHOOK_INGRESS_CAPACITY);
    let (gesture_tx, gesture_rx) = gesture_channel();
    let cfg = HostConfig {
        webhook_addr: "127.0.0.1:0".parse().expect("addr"),
    };
    let mut sim = SimLoop::new(host, RenderProducer::new(), rt.handle(), cfg, gesture_rx)
        .with_webhook(web_rx);

    // PLACE a Source via a real gesture, then tick once to fold it EDITS-FIRST —
    // the route projection re-publishes with the new Source's id-derived label.
    gesture_tx
        .send_gesture(GridCommand::Place {
            kind: machine_kind::SOURCE,
            cell_x: 0,
            cell_y: 0,
        })
        .expect("send place-source gesture");
    sim.run(Some(1), Duration::ZERO).expect("fold the placed Source");

    // Read the PROJECTED label (and its NodeId) from the LIVE route table — never a
    // hand-built map. Exactly one Source exists, so one entry.
    let routes = sim.routes_receiver().borrow().clone();
    assert_eq!(routes.len(), 1, "the gesture-placed Source is projected");
    let (label, source) = {
        let (l, s) = routes.iter().next().expect("a projected source label");
        (l.clone(), *s)
    };
    assert!(label.starts_with("src-"), "the label is id-derived (src-<as_ffi>)");

    // Bind a loopback listener onto the LIVE projection and POST to the projected
    // label.
    let (base, server) = spawn_webhook_live(&rt, sim.routes_receiver(), web_tx, sim.is_playing_flag());
    spawn_post(&rt, format!("{base}/hook/{label}"), "d1", "hello");
    sim.run(Some(TICKS), TICK_PAUSE).expect("drain the POST");
    server.abort();

    assert_eq!(
        injects_for(sim.host(), source),
        1,
        "a POST to the PROJECTED label fires the gesture-placed Source exactly once (HOST-07)"
    );
}

#[test]
fn dedup_over_the_projected_label() {
    // HOST-06 over the REAL projection: two POSTs carrying the SAME delivery id to a
    // PROJECTED (gesture-placed) label collapse to exactly ONE logged event — the
    // dedup-before-log path holds through the live route table, not just a
    // hand-built one (closes the Wave-0 "dedup passes falsely" gap once the shell
    // seen-set lands in 18-04).
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("runtime");
    let dir = tempfile::tempdir().expect("tempdir");
    let host = host_with_seen_set(dir.path());

    let (web_tx, web_rx) = channel::<Ingress>(WEBHOOK_INGRESS_CAPACITY);
    let (gesture_tx, gesture_rx) = gesture_channel();
    let cfg = HostConfig {
        webhook_addr: "127.0.0.1:0".parse().expect("addr"),
    };
    let mut sim = SimLoop::new(host, RenderProducer::new(), rt.handle(), cfg, gesture_rx)
        .with_webhook(web_rx);

    gesture_tx
        .send_gesture(GridCommand::Place {
            kind: machine_kind::SOURCE,
            cell_x: 0,
            cell_y: 0,
        })
        .expect("send place-source gesture");
    sim.run(Some(1), Duration::ZERO).expect("fold the placed Source");

    let routes = sim.routes_receiver().borrow().clone();
    let (label, source) = {
        let (l, s) = routes.iter().next().expect("a projected source label");
        (l.clone(), *s)
    };

    let (base, server) = spawn_webhook_live(&rt, sim.routes_receiver(), web_tx, sim.is_playing_flag());
    // Two sequential POSTs carrying the SAME delivery id ("dup") to the projected label.
    let url = format!("{base}/hook/{label}");
    rt.spawn(async move {
        tokio::time::sleep(Duration::from_millis(20)).await;
        let client = reqwest::Client::new();
        let _ = client.post(&url).header("x-delivery-id", "dup").body("a").send().await;
        let _ = client.post(&url).header("x-delivery-id", "dup").body("b").send().await;
    });
    sim.run(Some(TICKS), TICK_PAUSE).expect("drain the POSTs");
    server.abort();

    assert_eq!(
        injects_for(sim.host(), source),
        1,
        "same delivery id twice to a PROJECTED label -> exactly one logged event (HOST-06)"
    );
}
