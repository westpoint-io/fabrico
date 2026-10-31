//! ROBUST-01 — the committed runtime-robustness characterization (Phase 41).
//!
//! This is the CI-guarded regression for an acute bug hit in the live app: a webhook barrage plus an interaction (Pause/Save/Load) FROZE the app —
//! the unbounded Source ingress channel piled up (each delivery = a body `Vec` + an `ack`
//! oneshot + a held TCP FD) and every caller hung forever on `ack_rx.await`, and on resume
//! the whole backlog drained in ONE giant catch-up tick. Wave 1 (41-01) mirrored the
//! shipped endpoint door onto the webhook door: a BOUNDED channel (`try_send`->503, Gate B)
//! plus a lock-free `is_playing` fast-503 gate (Gate A) so a POST while the sim is
//! Draining/Frozen is refused BEFORE any enqueue (drop-with-503-never-200), and a sim-side
//! refuser closes the enqueue-then-pause race.
//!
//! `webhook_burst_pause_resume_stays_live` reproduces the ~5-POST characterization AND a
//! `> WEBHOOK_INGRESS_CAPACITY` burst over a REAL loopback listener wired to the sim's real
//! `is_playing` signal, and asserts the FIXED behavior:
//!  1. a low-volume POST stream while Playing logs every accepted delivery and its item
//!     reaches the downstream collector (item flow stays live);
//!  2. a POST while the sim is Draining/Frozen returns a prompt 503 and logs NOTHING
//!     (the not-Playing refusal — Gate A — never a silent 200);
//!  3. a `> WEBHOOK_INGRESS_CAPACITY` burst returns 503 past capacity with the channel
//!     bounded (no unbounded growth — Gate B), and the whole burst COMPLETES (no caller
//!     hung on `ack_rx.await` — completion IS the no-hang proof);
//!  4. after Resume a fresh POST logs and its item reaches the collector (flow resumes,
//!     no giant catch-up tick: the 256 bound caps the per-tick drain by construction).
//!
//! # The determinism boundary (host-only)
//! Every socket / run-state / wall-clock fact stays host-side: the `is_playing` signal is
//! read ONLY by the axum handler and never re-enters the sim fold. `crates/fabrico-core`
//! and every serialized byte stay frozen (the golden corpus is byte-identical).
//!
//! All traffic stays on `127.0.0.1` (loopback only this milestone).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use fabrico_core::core::Core;
use fabrico_core::event::{EventPayload, LogHeader, SCHEMA_VERSION};
use fabrico_core::ids::NodeId;
use fabrico_core::persist::{MAX_RECORD_BYTES, RedbStore};
use fabrico_host::config::HostConfig;
use fabrico_host::driver::Host;
use fabrico_host::ingress::endpoint::{EndpointIngress, ENDPOINT_INGRESS_CAPACITY};
use fabrico_host::ingress::seen_set::SeenSet;
use fabrico_host::ingress::webhook::{webhook_router, Ingress, RoutesRx, WEBHOOK_INGRESS_CAPACITY};
use fabrico_host::ledger::DispatchLedger;
use fabrico_host::render_packet::RenderProducer;
use fabrico_host::sim_loop::{ControlMsg, SimLoop, gesture_channel};
use slotmap::Key;
use tokio::net::TcpListener;
use tokio::sync::mpsc::{channel, unbounded_channel, Sender};
use tokio::sync::oneshot;

/// A real-time driver window generous enough for a stream of loopback POSTs (each POST's
/// ack) plus the belt hop to the downstream collector to complete within the run.
const TICKS: u64 = 200;
const TICK_PAUSE: Duration = Duration::from_millis(5);

/// The over-capacity burst size: strictly `> WEBHOOK_INGRESS_CAPACITY` so the channel
/// saturates and every burst POST is refused past capacity.
const BURST: usize = WEBHOOK_INGRESS_CAPACITY + 16;

fn header() -> LogHeader {
    LogHeader {
        schema_version: SCHEMA_VERSION,
        seed: 1,
    }
}

fn cfg() -> HostConfig {
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

/// The `src-<id>` route label for a Source node (the id-derived projection SimLoop::new
/// seeds into the LIVE route table for every genesis Source).
fn src_label(id: NodeId) -> String {
    format!("src-{}", id.data().as_ffi())
}

/// The genesis robustness topology: `Source --belt(4)--> collector(Source)` over a REAL
/// persisted seen-set. A webhook POST to `source` logs a `ManualInject` and the item
/// travels the 4-tile belt into `collector`'s inbox (the downstream flow oracle). A
/// 4-tile belt keeps an in-flight item on the belt for several ticks so the Pause enters
/// the DRAINING window deterministically (rather than freezing instantly on a quiescent
/// grid). Returns `(host, source, collector)`; the caller keeps the `TempDir` alive.
fn genesis_topology(dir: &std::path::Path) -> (Host, NodeId, NodeId) {
    let mut core = Core::genesis(header());
    let source = core.state.add_source();
    let belt = core.state.add_belt(4);
    let collector = core.state.add_source();
    core.state.link((source, 0), (belt, 0)); // source Out -> belt tail
    core.state.link((belt, 0), (collector, 0)); // belt head -> collector inbox
    let store = RedbStore::open(dir.join("log.redb")).expect("open log");
    let ledger = DispatchLedger::open(dir.join("ledger.redb")).expect("open ledger");
    let seen = SeenSet::open(dir.join("seen.redb")).expect("open seen-set");
    let host = Host::new(core, store, ledger, None)
        .expect("open host")
        .with_seen_set(seen);
    (host, source, collector)
}

/// Count the logged `ManualInject` events targeting `source` (the ingress-logged oracle).
fn injects_for(host: &Host, source: NodeId) -> usize {
    host.logged_events()
        .expect("read log")
        .iter()
        .filter(|e| matches!(&e.payload, EventPayload::ManualInject { target, .. } if *target == source))
        .count()
}

/// The number of items resting in `collector`'s port-0 inbox (a read-only clone+drain, so
/// the LIVE core is untouched). The downstream flow oracle: a webhook item that traverses
/// the belt lands here and stays (a terminal Source with no output link never consumes it).
fn collector_depth(sim: &SimLoop, collector: NodeId) -> usize {
    sim.host()
        .core()
        .state
        .inbox_of(collector)
        .map(|ib| {
            let mut clone = ib.clone();
            let mut n = 0;
            while clone.take(0).is_some() {
                n += 1;
            }
            n
        })
        .unwrap_or(0)
}

/// Bind a REAL loopback webhook listener onto a LIVE route projection + the sim's real
/// `is_playing` signal (the headline topology shape), SPAWN the serve loop, and return the
/// bound base URL + server handle. POSTs to it are real HTTP over `127.0.0.1`.
fn spawn_live_listener(
    rt: &tokio::runtime::Runtime,
    routes_rx: RoutesRx,
    web_tx: Sender<Ingress>,
    is_playing: Arc<AtomicBool>,
) -> (String, tokio::task::JoinHandle<()>) {
    let listener = rt
        .block_on(async { TcpListener::bind("127.0.0.1:0").await })
        .expect("bind loopback");
    let addr = listener.local_addr().expect("local addr");
    // This test never POSTs `/endpoint/...`; a throwaway endpoint sender satisfies the
    // shared-router signature (one server, both routes).
    let (endpoint_tx, _endpoint_rx) = channel::<EndpointIngress>(ENDPOINT_INGRESS_CAPACITY);
    let app = webhook_router(routes_rx, web_tx, endpoint_tx, MAX_RECORD_BYTES, is_playing);
    let server = rt.spawn(async move {
        axum::serve(listener, app).await.expect("serve");
    });
    (format!("http://{addr}"), server)
}

/// Spawn a task firing `ids.len()` SEQUENTIAL loopback POSTs (each a distinct at-least-once
/// delivery id) to `url`, so they arrive while the driver loop is ticking + acking. Each
/// `send().await` completes only once the host loop acks it (a genuine round-trip).
fn spawn_source_posts(
    rt: &tokio::runtime::Runtime,
    url: String,
    ids: Vec<String>,
) -> tokio::task::JoinHandle<()> {
    rt.spawn(async move {
        tokio::time::sleep(Duration::from_millis(20)).await;
        let client = reqwest::Client::new();
        for id in ids {
            let _ = client
                .post(&url)
                .header("x-delivery-id", &id)
                .body("x")
                .send()
                .await;
        }
    })
}

/// A single BLOCKING loopback POST returning the HTTP status — for the refusal paths that
/// answer WITHOUT the sim ticking (Gate A / Gate B 503s return immediately, no ack wait).
/// A short client timeout makes a REGRESSION (a hung caller) a distinguishable, failing
/// outcome (`0`) rather than an indefinite block.
fn post_status(rt: &tokio::runtime::Runtime, url: &str, delivery_id: &str) -> u16 {
    rt.block_on(async {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .expect("build client");
        match client
            .post(url)
            .header("x-delivery-id", delivery_id)
            .body("x")
            .send()
            .await
        {
            Ok(r) => r.status().as_u16(),
            Err(_) => 0, // a timeout/transport error -> sentinel (a hang would surface here)
        }
    })
}

/// ROBUST-01 — the burst-then-pause-then-resume characterization. Reproduces the acute bug
/// (a webhook barrage around a Pause/Resume) and asserts the FIXED behavior: bounded -> 503,
/// prompt 503 while not Playing with NOTHING logged, no caller hang, and live/resuming flow.
#[test]
fn webhook_burst_pause_resume_stays_live() {
    let rt = rt();
    let dir = tempfile::tempdir().expect("tempdir");
    let (host, source, collector) = genesis_topology(dir.path());

    // The webhook seam: the server sends Ingress on web_tx; the sim drains web_rx. A cloned
    // `probe` lets the test observe the bounded channel's capacity (no growth past cap) and
    // pre-fill it to saturation without holding hundreds of real sockets.
    let (web_tx, web_rx) = channel::<Ingress>(WEBHOOK_INGRESS_CAPACITY);
    let probe = web_tx.clone();
    let (_gesture_tx, gesture_rx) = gesture_channel();
    let (control_tx, control_rx) = unbounded_channel::<ControlMsg>();
    let mut sim = SimLoop::new(host, RenderProducer::new(), rt.handle(), cfg(), gesture_rx)
        .with_webhook(web_rx)
        .with_control(control_rx);

    // The genesis Source is seeded into the LIVE route table by SimLoop::new (HOST-07).
    let label = src_label(source);
    assert_eq!(
        sim.routes_receiver().borrow().get(&label),
        Some(&source),
        "the src- route is live at construction (Source seeding)"
    );
    let (base, server) =
        spawn_live_listener(&rt, sim.routes_receiver(), web_tx, sim.is_playing_flag());
    let hook_url = format!("{base}/hook/{label}");

    // Warm-up: a couple of Playing ticks so `is_playing` is published `true`.
    sim.run(Some(2), Duration::ZERO).expect("warm-up ticks");

    // === (1) ~5-POST characterization while Playing: every accepted delivery logs and its
    //     item reaches the downstream collector (item flow stays live). ===
    let five: Vec<String> = (0..5).map(|i| format!("post-{i}")).collect();
    spawn_source_posts(&rt, hook_url.clone(), five);
    sim.run(Some(TICKS), TICK_PAUSE).expect("drain the ~5-POST stream");
    assert_eq!(
        injects_for(sim.host(), source),
        5,
        "each of the ~5 accepted POSTs logged exactly one ManualInject (flow live)"
    );
    assert_eq!(
        collector_depth(&sim, collector),
        5,
        "all five injected items traversed the belt into the collector (downstream flow live)"
    );

    // === (2) not-Playing refusal — the DRAINING window then the FROZEN window. A POST while
    //     the sim is not Playing returns a prompt 503 and logs NOTHING (Gate A). ===
    let baseline_inj = injects_for(sim.host(), source);
    let baseline_depth = collector_depth(&sim, collector);

    // Put one real item in flight on the belt (via the in-process probe, bypassing the HTTP
    // door), so the imminent Pause enters DRAINING (a non-quiescent grid) rather than
    // freezing instantly. This item logs one ManualInject on the Playing step that drains it.
    let (np_ack, _np_ack_rx) = oneshot::channel();
    probe
        .try_send(Ingress {
            target: source,
            board: 0,
            delivery_id: Some(b"np-inflight".to_vec()),
            body: b"x".to_vec(),
            ack: np_ack,
        })
        .expect("enqueue the in-flight probe item");
    // Tick Playing until the item is ON the belt (in flight) so Pause enters DRAINING.
    let mut guard = 0;
    while sim.host().belt_items_in_flight() == 0 {
        sim.run(Some(1), Duration::ZERO).expect("tick toward in-flight");
        guard += 1;
        assert!(guard < 32, "the probe item reached the belt within a bounded window");
    }
    assert_eq!(
        injects_for(sim.host(), source),
        baseline_inj + 1,
        "the in-flight probe item logged exactly one ManualInject"
    );

    // Pause -> the non-quiescent grid enters DRAINING. In DRAINING the `is_playing` signal
    // is FALSE (Gate A would refuse) yet the sim is NOT yet Frozen (`is_paused()` false).
    control_tx.send(ControlMsg::Pause).expect("send Pause");
    sim.run(Some(1), Duration::ZERO).expect("service the Pause (enter DRAINING)");
    assert!(
        !sim.is_playing_flag().load(Ordering::Acquire),
        "the DRAINING window publishes is_playing=false (Gate A refuses a POST here)"
    );
    assert!(
        !sim.is_paused(),
        "the sim is still DRAINING (not yet Frozen) — the not-Playing signal covers the \
         Draining window, not only Frozen"
    );

    // Drive the drain to its freeze.
    let mut guard = 0;
    while !sim.is_paused() {
        sim.run(Some(1), Duration::ZERO).expect("drain toward Frozen");
        guard += 1;
        assert!(guard < 300, "the drain reached Frozen within the settle budget");
    }
    assert!(
        !sim.is_playing_flag().load(Ordering::Acquire),
        "the FROZEN window also publishes is_playing=false"
    );

    // A REAL POST while Frozen: Gate A fast-503s BEFORE any enqueue — nothing is logged.
    let frozen_inj = injects_for(sim.host(), source);
    let status = post_status(&rt, &hook_url, "while-frozen");
    assert_eq!(
        status, 503,
        "a POST while not Playing returns a prompt 503 (Gate A), never a hang, never a 200"
    );
    assert_eq!(
        injects_for(sim.host(), source),
        frozen_inj,
        "the not-Playing refusal logged NOTHING (drop-with-503-never-200)"
    );

    // Resume so the in-flight probe item finishes its belt hop and the sim returns to Playing.
    control_tx.send(ControlMsg::Resume).expect("send Resume");
    sim.run(Some(TICKS), TICK_PAUSE).expect("resume + flush the in-flight item");
    assert_eq!(
        collector_depth(&sim, collector),
        baseline_depth + 1,
        "the in-flight probe item reached the collector after Resume"
    );

    // === (3) `> WEBHOOK_INGRESS_CAPACITY` burst while Playing: bounded backpressure. The
    //     channel saturates and every over-capacity POST is refused with 503, the channel
    //     never grows past capacity, and the whole burst COMPLETES (no caller hang). ===
    assert!(
        sim.is_playing_flag().load(Ordering::Acquire),
        "the sim is Playing before the burst (Gate A open, so 503s come from Gate B)"
    );
    // Pre-fill the bounded channel to saturation via the in-process probe (cheap, no held
    // sockets). These entries are NEVER Playing-drained: the cleanup Pause below drops them
    // via the sim-side refuser (no log), so they cannot contaminate the injects oracle.
    let mut prefilled = 0;
    while probe
        .try_send(Ingress {
            target: source,
            board: 0,
            delivery_id: None,
            body: Vec::new(),
            ack: oneshot::channel().0,
        })
        .is_ok()
    {
        prefilled += 1;
    }
    assert_eq!(
        prefilled, WEBHOOK_INGRESS_CAPACITY,
        "the bounded channel accepts exactly its capacity, then refuses (no unbounded growth)"
    );
    assert_eq!(probe.capacity(), 0, "the channel is saturated (0 free slots)");

    // Fire the real `> capacity` burst concurrently over loopback. With the channel full and
    // the sim not draining, every POST hits Gate B (`try_send` Full) -> 503, returned
    // immediately (never a held socket, never a hang). Awaiting all of them IS the no-hang
    // proof; a regression (an unbounded queue that hangs the caller) surfaces as a `0` here.
    let burst_url = hook_url.clone();
    let statuses: Vec<u16> = rt.block_on(async move {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .expect("build client");
        let mut set = tokio::task::JoinSet::new();
        for i in 0..BURST {
            let client = client.clone();
            let url = burst_url.clone();
            set.spawn(async move {
                match client
                    .post(&url)
                    .header("x-delivery-id", format!("burst-{i}"))
                    .body("x")
                    .send()
                    .await
                {
                    Ok(r) => r.status().as_u16(),
                    Err(_) => 0,
                }
            });
        }
        let mut out = Vec::with_capacity(BURST);
        while let Some(joined) = set.join_next().await {
            out.push(joined.expect("burst task joined"));
        }
        out
    });
    assert_eq!(
        statuses.len(),
        BURST,
        "every one of the {BURST} burst POSTs COMPLETED — no caller left on ack_rx.await (no hang)"
    );
    assert!(
        statuses.iter().all(|&s| s == 503),
        "every over-capacity burst POST is 503 (bounded backpressure, Gate B); got {statuses:?}"
    );
    assert_eq!(
        probe.capacity(),
        0,
        "the channel never grew past capacity under the burst (the refused POSTs enqueued nothing)"
    );

    // Cleanup: Pause -> Frozen drains the pre-filled entries via the sim-side refuser (drops
    // each ack, logs NOTHING), emptying the channel for the resume-flow proof.
    control_tx.send(ControlMsg::Pause).expect("send Pause (cleanup)");
    sim.run(Some(1), Duration::ZERO).expect("freeze + refuse-drain the pre-fill");
    assert_eq!(
        probe.capacity(),
        WEBHOOK_INGRESS_CAPACITY,
        "the sim-side refuser drained the saturated channel EMPTY at the freeze (bounded, no leak)"
    );

    // === (4) flow resumes: after Resume a FRESH POST logs and its item reaches the collector
    //     (no giant catch-up tick — the 256 bound caps the per-tick drain by construction). ===
    control_tx.send(ControlMsg::Resume).expect("send Resume");
    sim.run(Some(2), Duration::ZERO).expect("return to Playing");
    let before_inj = injects_for(sim.host(), source);
    let before_depth = collector_depth(&sim, collector);
    spawn_source_posts(&rt, hook_url.clone(), vec!["resume-1".to_string()]);
    sim.run(Some(TICKS), TICK_PAUSE).expect("drain the post-Resume POST");
    assert_eq!(
        injects_for(sim.host(), source),
        before_inj + 1,
        "a fresh POST after Resume logs exactly one ManualInject (ingress flow resumes live)"
    );
    assert_eq!(
        collector_depth(&sim, collector),
        before_depth + 1,
        "the post-Resume item traversed the belt to the collector (downstream flow resumes)"
    );

    server.abort();
}
