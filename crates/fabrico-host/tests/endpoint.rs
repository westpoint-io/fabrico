//! End-to-end host-bridge coverage for the Endpoint node (Phase 38, ENDP-01..05).
//!
//! These are the exit-wave proofs that the parked-socket bridge holds across the
//! WHOLE stack — the axum router, the endpoint ingress channel, the sim-thread
//! mint+park, the correlation registry, the deadline sweep, and crash recovery —
//! and that none of it leaked state into the deterministic core:
//!
//! - `round_trip` (ENDP-01/02): a REAL loopback `POST /endpoint/<path>` mints a
//!   WireRequest, parks the caller's socket, and — once the reply arm resolves the
//!   correlation with a `{status,headers,body}` descriptor — the held-open caller
//!   receives that exact status + header + body.
//! - `deadline_times_out` (ENDP-03): a parked request left unresolved past its
//!   deadline is swept to a `504` host-side, logging NO event (the core fold is
//!   untouched — the determinism boundary).
//! - `timeout_then_late_reply_single_write` (ENDP-04a): after a sweep 504s a
//!   correlation, a LATE reply for it is a socket no-op — written exactly once.
//! - `replay_registry_empty_zero_writes` (ENDP-04b/05): recovering a host from a
//!   log carrying endpoint traffic reconstructs an EMPTY registry and writes ZERO
//!   sockets on replay — proven with a collecting sender parked exactly where a
//!   replayed reply arm would write (the `driver.rs` CountingExecutor analog).
//! - `route_reregisters` (ENDP-05): a saved Endpoint scene re-registers its
//!   path-keyed route after a Load host-swap (`force_republish_routes`), AND the
//!   endpoint and source key namespaces stay disjoint across that swap. Both boards
//!   it walks carry a Source as well as a Route, because a namespace claim over a map
//!   holding one kind of key cannot fail (finding V-4).
//! - `core_version_consts_are_frozen`: the CORE-FROZEN tripwire — the five
//!   serialized-shape version consts equal their frozen values (the fast in-crate
//!   guard beside the golden cross-platform corpus cert).
//!
//! All traffic stays on `127.0.0.1` (loopback only this phase).

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use fabrico_core::belt_slots::DEFAULT_TICKS_PER_SLOT;
use fabrico_core::core::Core;
use fabrico_core::event::{EventPayload, LogHeader, SCHEMA_VERSION};
use fabrico_core::ids::{Item, NodeId};
use fabrico_core::persist::{MAX_RECORD_BYTES, RedbStore};
use fabrico_core::state::{Node, SinkTemplate};
use fabrico_host::config::HostConfig;
use fabrico_host::driver::Host;
use fabrico_host::ingress::endpoint::{
    descriptor_to_response, EndpointIngress, HttpResponse, ResponseDescriptor,
    ENDPOINT_INGRESS_CAPACITY,
};
use fabrico_host::ingress::webhook::{WEBHOOK_INGRESS_CAPACITY, webhook_router, Ingress};
use fabrico_host::ledger::DispatchLedger;
use fabrico_host::project::save_project;
use fabrico_host::render_packet::RenderProducer;
use fabrico_host::sim_loop::{ControlMsg, SimLoop, endpoint_route_key, gesture_channel};
use slotmap::Key;
use tokio::net::TcpListener;
use tokio::sync::mpsc::{channel, unbounded_channel};
use tokio::sync::oneshot;

/// A real-time driver window long enough for a loopback POST (mint, reply-arm
/// resolve, and the caller's read) to complete well within the run.
const TICKS: u64 = 120;
const TICK_PAUSE: Duration = Duration::from_millis(5);

/// A fixed always-Playing signal for the endpoint tests (the shared webhook door is
/// never paused here; these exercise the `/endpoint` round-trip path).
fn playing() -> Arc<AtomicBool> {
    Arc::new(AtomicBool::new(true))
}

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

/// A genesis host carrying ONE inert `Node::Endpoint`; returns `(host, ep_id)`.
/// The caller keeps the `TempDir` alive (the redb store lives under it).
fn host_with_ep(dir: &std::path::Path) -> (Host, NodeId) {
    let mut core = Core::genesis(header());
    let ep = core.state.add_endpoint();
    let store = RedbStore::open(dir.join("log.redb")).expect("open log");
    let ledger = DispatchLedger::open(dir.join("ledger.redb")).expect("open ledger");
    (Host::new(core, store, ledger, None).expect("open host"), ep)
}

/// A genesis host carrying ONE `Node::Endpoint` AND ONE `Node::Source`; returns
/// `(host, ep_id, src_id)`. The caller keeps the `TempDir` alive.
///
/// # Why a SECOND helper rather than a Source added to `host_with_ep`
/// The four round-trip tests that use `host_with_ep` assert against a board holding
/// exactly one routable node, and a Source silently added under them would change what
/// those assertions are about. This scene exists for ONE claim: that the two route
/// namespaces stay disjoint across a Load host-swap, which needs a key of EACH kind in
/// the map at once. A test whose map holds only endpoint keys cannot see a source key
/// move, which is exactly the hole `route_reregisters` used to have.
fn host_with_ep_and_source(dir: &std::path::Path) -> (Host, NodeId, NodeId) {
    let mut core = Core::genesis(header());
    let ep = core.state.add_endpoint();
    let src = core.state.add_source();
    let store = RedbStore::open(dir.join("log.redb")).expect("open log");
    let ledger = DispatchLedger::open(dir.join("ledger.redb")).expect("open ledger");
    (
        Host::new(core, store, ledger, None).expect("open host"),
        ep,
        src,
    )
}

/// The route-map key a Source answers at, `src-<id>`: NO leading slash, ever.
fn src_label(id: NodeId) -> String {
    format!("src-{}", id.data().as_ffi())
}

/// The route-map key the Route `id` answers at: its COMMITTED path, read off `core`,
/// through the host's own `endpoint_route_key`.
///
/// Read rather than spelled, so no test here restates the core's default path a second
/// time (phase 91, D-13). The leading slash is 72-07's: every endpoint key carries one
/// and no `src-` key can, which keeps the two namespaces disjoint.
fn ep_key(core: &Core, id: NodeId) -> String {
    match core.state.node(id) {
        Some(Node::Endpoint(ep)) => endpoint_route_key(&ep.path),
        other => panic!("expected a live Node::Endpoint at {id:?}, found {other:?}"),
    }
}

/// A `{status, headers, body}` [`ResponseDescriptor`] packed as `Effect::Reply`
/// payload `Item` bytes (the handler's encode path).
fn descriptor_item(status: u16, headers: &[(&str, &str)], body: &str) -> Item {
    let mut hm = BTreeMap::new();
    for (k, v) in headers {
        hm.insert((*k).to_string(), (*v).to_string());
    }
    let desc = ResponseDescriptor {
        status,
        headers: hm,
        body: body.to_string(),
    };
    Item(serde_json::to_vec(&desc).expect("encode descriptor"))
}

/// The number of logged `WireRequest` events (an endpoint hit mints a WireRequest,
/// NEVER a ManualInject).
fn wire_requests(sim: &SimLoop) -> usize {
    sim.host()
        .logged_events()
        .expect("read log")
        .iter()
        .filter(|e| matches!(e.payload, EventPayload::WireRequest { .. }))
        .count()
}

/// Bounded spin (no wall-clock ASSERTION — a yield budget) awaiting a parked
/// socket to resolve. Panics if unresolved within the budget.
///
/// # A BUDGET, therefore DERIVED (SLOT-03, plan 62-03)
/// The 400 iterations at 5 ms are ~2 s of wall clock, i.e. ~125 sim ticks at the
/// measured ~62.3 ticks/sec, and one caller (`live_then_recover`, below) waits on a
/// socket whose answer is behind a belt. A belt advances one slot every
/// `ticks_per_slot` ticks, so that leg scales one-for-one with the interval and the
/// budget is multiplied by it.
///
/// # REASONED, NOT MEASURED, and said so on purpose
/// No probe was run against this budget under a longer interval. It is also the one
/// budget in this plan denominated in WALL CLOCK rather than in sim ticks, so its
/// failure is a flaky panic on a loaded machine rather than a deterministic one, and
/// stretching it trades a longer worst-case hang for that flakiness. The raise is an
/// argument, not an observation.
fn poll_socket(rx: &mut oneshot::Receiver<HttpResponse>) -> HttpResponse {
    for _ in 0..(400 * DEFAULT_TICKS_PER_SLOT.get()) {
        match rx.try_recv() {
            Ok(resp) => return resp,
            Err(oneshot::error::TryRecvError::Empty) => {
                std::thread::sleep(Duration::from_millis(5));
            }
            Err(oneshot::error::TryRecvError::Closed) => {
                panic!("socket sender dropped without answering")
            }
        }
    }
    panic!("parked socket was not resolved within the bounded spin")
}

/// ENDP-01/02 — the full parked-socket round-trip over a REAL loopback listener:
/// a `POST /endpoint/<path>` -> `EndpointIngress` -> sim mint+park -> the reply
/// arm resolves the correlation with a `{201, x-k:v, "pong"}` descriptor -> the
/// held-open caller receives that exact status, header, and body.
///
/// Drives a REAL loopback POST (not only `ServiceExt::oneshot`) so the default
/// live wiring is exercised (MEMORY v5.0 lesson: injected-packet tests hid broken
/// live wiring).
#[test]
fn round_trip() {
    let rt = rt();
    let dir = tempfile::tempdir().expect("tempdir");
    let (host, ep) = host_with_ep(dir.path());
    let label = ep_key(host.core(), ep);
    let (endpoint_tx, endpoint_rx) = channel::<EndpointIngress>(ENDPOINT_INGRESS_CAPACITY);
    let (_gtx, grx) = gesture_channel();
    let mut sim =
        SimLoop::new(host, RenderProducer::new(), rt.handle(), cfg(), grx).with_endpoint(endpoint_rx);

    // The genesis Endpoint is seeded into the LIVE route table by SimLoop::new.
    let routes_rx = sim.routes_receiver();
    assert_eq!(
        routes_rx.borrow().get(&label),
        Some(&ep),
        "the ep- route is live at construction (ENDP-05 seeding)"
    );

    // Bind a REAL loopback listener onto the LIVE endpoint projection.
    let listener = rt
        .block_on(async { TcpListener::bind("127.0.0.1:0").await })
        .expect("bind loopback");
    let addr = listener.local_addr().expect("local addr");
    // This test never POSTs `/hook/...`; a throwaway webhook sender satisfies the
    // shared-router signature (one server serves both routes).
    let (web_tx, _web_rx) = channel::<Ingress>(WEBHOOK_INGRESS_CAPACITY);
    let app = webhook_router(routes_rx, web_tx, endpoint_tx, MAX_RECORD_BYTES, playing());
    let server = rt.spawn(async move {
        axum::serve(listener, app).await.expect("serve");
    });

    // Drive a REAL POST; capture the caller's response back over a std channel.
    let (resp_tx, resp_rx) = std::sync::mpsc::channel();
    let url = format!("http://{addr}/endpoint{label}");
    rt.spawn(async move {
        tokio::time::sleep(Duration::from_millis(30)).await;
        let client = reqwest::Client::new();
        let r = client.post(&url).body("ping").send().await.expect("POST sent");
        let status = r.status().as_u16();
        let hv = r
            .headers()
            .get("x-k")
            .map(|v| v.to_str().expect("header utf-8").to_string());
        let body = r.text().await.expect("read body");
        let _ = resp_tx.send((status, hv, body));
    });

    // The reply-arm seam: once the socket parks (the mint ran), resolve correlation
    // 0 with the descriptor — simulating the executor consumer's `Effect::Reply`
    // arm (the in-sim reverse transport is decorative until Phase 40).
    let reg = sim.registry_handle();
    rt.spawn(async move {
        loop {
            if !reg.is_empty() {
                reg.resolve(
                    0,
                    descriptor_to_response(&descriptor_item(201, &[("x-k", "v")], "pong")),
                );
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    });

    sim.run(Some(TICKS), TICK_PAUSE).expect("drain + mint + fold");
    server.abort();

    let (status, hv, body) = resp_rx
        .recv_timeout(Duration::from_secs(5))
        .expect("the caller received a response");
    assert_eq!(status, 201, "the descriptor status reaches the caller (ENDP-02)");
    assert_eq!(
        hv.as_deref(),
        Some("v"),
        "the descriptor header reaches the caller (ENDP-02)"
    );
    assert_eq!(body, "pong", "the descriptor body reaches the caller (ENDP-01/02)");
    assert_eq!(
        wire_requests(&sim),
        1,
        "the endpoint hit minted exactly one WireRequest (ENDP-01)"
    );
}

/// ENDP-03 — a parked request left unresolved past its deadline is swept to a
/// `504` host-side, and the sweep logs NO event (the core fold is byte-untouched
/// by the timeout — the determinism boundary).
#[test]
fn deadline_times_out() {
    let rt = rt();
    let dir = tempfile::tempdir().expect("tempdir");
    let (host, _ep) = host_with_ep(dir.path());
    let (_gtx, grx) = gesture_channel();
    let mut sim = SimLoop::new(host, RenderProducer::new(), rt.handle(), cfg(), grx);

    sim.run(Some(2), Duration::ZERO).expect("advance to tick 2");

    // Park an ALREADY-expired request (deadline 0 < the next tick).
    let reg = sim.registry_handle();
    let (tx, mut socket) = oneshot::channel();
    reg.try_park(0, 0, tx).expect("park under cap");

    let log_before = sim.host().logged_events().expect("log").len();

    // The next tick's internal deadline sweep 504s it (0 < 3).
    sim.run(Some(1), Duration::ZERO).expect("sweep tick");

    let resp = poll_socket(&mut socket);
    assert_eq!(
        resp.status().as_u16(),
        504,
        "an expired parked request is swept to 504 (ENDP-03)"
    );
    assert_eq!(
        resp.body_bytes(),
        br#"{"error":"timeout"}"#,
        "the canonical host-side timeout body"
    );
    assert!(reg.is_empty(), "the swept entry was removed");
    assert_eq!(
        sim.host().logged_events().expect("log").len(),
        log_before,
        "the timeout logged NO event — the core fold is untouched by the 504 (determinism boundary)"
    );
}

/// ENDP-04a — after the sweep 504s a correlation, a LATE reply for the SAME
/// correlation finds no parked entry and drops: the socket is written exactly once.
#[test]
fn timeout_then_late_reply_single_write() {
    let rt = rt();
    let dir = tempfile::tempdir().expect("tempdir");
    let (host, _ep) = host_with_ep(dir.path());
    let (_gtx, grx) = gesture_channel();
    let mut sim = SimLoop::new(host, RenderProducer::new(), rt.handle(), cfg(), grx);

    sim.run(Some(1), Duration::ZERO).expect("advance to tick 1");

    // Park an already-expired request; the next tick's sweep 504s it.
    let reg = sim.registry_handle();
    let (tx, mut socket) = oneshot::channel();
    reg.try_park(3, 0, tx).expect("park expired");
    sim.run(Some(1), Duration::ZERO).expect("sweep tick");

    let resp = poll_socket(&mut socket);
    assert_eq!(resp.status().as_u16(), 504, "the sweep wins and 504s the socket");
    assert!(reg.is_empty(), "the remove gate cleared correlation 3");

    // A LATE reply for the SAME correlation now finds None and drops — the socket is
    // never written a second time.
    reg.resolve(3, descriptor_to_response(&descriptor_item(200, &[], "late")));
    assert!(
        socket.try_recv().is_err(),
        "the socket was written exactly once (the late reply found no parked entry, ENDP-04a)"
    );
}

/// ENDP-04b/05 — recovering a host from a log carrying endpoint traffic reconstructs
/// an EMPTY registry and dispatches ZERO commands on replay, so no socket is written.
///
/// # Why the topology carries a command-emitting Sink (the non-vacuous fix, F3)
/// An earlier form of this test used a BARE inert `Node::Endpoint` with no wire. That
/// made the "zero writes on replay" hold BY CONSTRUCTION — the logged `WireRequest`
/// targets a node with no entry wire, so the core DROPS it and re-emits NO command on
/// replay regardless of whether the executor is muted. The proof was vacuous.
///
/// This version adds a `Source -> Sink(Debug)` and injects one item, so the LIVE log
/// contains a REAL command-emitting scenario: the Debug sink emits an `Effect::Debug`
/// command the live executor dispatches (a genuine side effect). On recover, the muted
/// two-log replay RE-EMITS that command — `recover()` RETURNS it — but the driver
/// dispatches NONE of the returned commands (the `driver.rs` recover contract, the
/// `replay_dispatches_zero` / CountingExecutor analog: returning-not-dispatching IS
/// the mute). We assert `recover()` returned a NON-EMPTY command set (proving the log
/// really would re-run a side effect if muting were broken) yet zero were dispatched,
/// so the collecting reply probe stays silent. The endpoint `WireRequest` proves the
/// registry-empty half: a parked socket cannot survive the restart.
///
/// Three genuine properties, none vacuous:
///  1. the reconstructed correlation registry is EMPTY (no parked socket survives);
///  2. the recovered core state is byte-identical to the live core (deterministic);
///  3. `recover()` re-emits >= 1 real command yet dispatches ZERO — the executor
///     (and its `Effect::Reply` socket-write arm) is muted on replay.
#[test]
fn replay_registry_empty_zero_writes() {
    let rt = rt();
    let dir = tempfile::tempdir().expect("tempdir");
    let log_path = dir.path().join("log.redb");
    let ledger_path = dir.path().join("ledger.redb");

    // Rebuilt identically each pass (slotmap mints the same NodeId for the same
    // insertion sequence, so the logged ids route on replay). Carries an inert
    // Endpoint (the registry-empty proof) AND a Source -> Sink(Debug) command chain
    // (the non-vacuous zero-dispatch proof).
    let build_topology = || {
        let mut core = Core::genesis(header());
        let ep = core.state.add_endpoint();
        let source = core.state.add_source();
        let sink = core.state.add_sink(SinkTemplate::Debug, 5);
        core.state.link((source, 0), (sink, 0));
        (core, ep, source)
    };

    let live_snapshot;
    // --- LIVE pass: mint+park one endpoint correlation AND inject one Source item so
    //     the Debug sink emits a REAL command the executor dispatches. ---
    {
        let (core, ep, source) = build_topology();
        let store = RedbStore::open(&log_path).expect("open log");
        let ledger = DispatchLedger::open(&ledger_path).expect("open ledger");
        let host = Host::new(core, store, ledger, None).expect("open host");
        let (etx, erx) = channel::<EndpointIngress>(ENDPOINT_INGRESS_CAPACITY);
        let (wtx, wrx) = channel::<Ingress>(WEBHOOK_INGRESS_CAPACITY);
        let (_gtx, grx) = gesture_channel();
        let mut sim = SimLoop::new(host, RenderProducer::new(), rt.handle(), cfg(), grx)
            .with_endpoint(erx)
            .with_webhook(wrx);

        // (1) The endpoint hit: parks a socket + logs a WireRequest.
        let (tx, mut socket) = oneshot::channel();
        etx.try_send(EndpointIngress {
            target: ep,
            board: 0,
            envelope: br#"{"body":1}"#.to_vec(),
            respond: tx,
        })
        .expect("send endpoint ingress");
        // (2) The Source item (via the webhook ingress): travels the belt to the Debug
        //     sink, which emits an Effect::Debug command the live executor dispatches.
        let (ack_tx, _ack_rx) = oneshot::channel();
        wtx.try_send(Ingress {
            target: source,
            board: 0,
            delivery_id: None,
            body: vec![0xAB],
            ack: ack_tx,
        })
        .expect("send source ingress");

        // Drive to quiescence: tick until the endpoint socket is resolved AND the sink
        // command has been dispatched+resolved (in_flight back to 0) AND belts drained.
        // Snapshot AT first quiescence so the live core tick equals recover's replay
        // tick (byte-identical). `saw_inflight` guards against an early break before
        // the sink command was ever in flight.
        let reg = sim.registry_handle();
        let mut resolved_ep = false;
        let mut saw_inflight = false;
        let mut guard = 0u32;
        loop {
            sim.run(Some(1), Duration::ZERO).expect("tick");
            if !resolved_ep && !reg.is_empty() {
                reg.resolve(0, descriptor_to_response(&descriptor_item(201, &[], "live")));
                resolved_ep = true;
            }
            if sim.host().in_flight_len() > 0 {
                saw_inflight = true;
            }
            let quiescent = sim.host().in_flight_len() == 0
                && sim.host().belt_items_in_flight() == 0;
            if resolved_ep && saw_inflight && quiescent {
                break;
            }
            guard += 1;
            // BUDGET (derived): quiescence here explicitly waits on
            // `belt_items_in_flight() == 0`, so the window must outlast the belt leg
            // and stretches with the advance interval. Research section 5 enumerated
            // this file's wall-clock spin and missed this one, which is the sharper
            // of the two: it is a sim-tick budget, so its under-run is deterministic
            // rather than machine-dependent.
            assert!(
                guard < 300 * DEFAULT_TICKS_PER_SLOT.get(),
                "the live pass failed to quiesce"
            );
        }

        assert_eq!(wire_requests(&sim), 1, "the live pass logged one endpoint WireRequest");
        let resp = poll_socket(&mut socket);
        assert_eq!(resp.status().as_u16(), 201, "the live caller got its answer");

        live_snapshot = sim.host().snapshot_bytes();
        // sim (owning the host) dropped here -> releases the redb file locks.
    }

    // --- REPLAY pass: recover a FRESH host over the SAME redb. `recover()` RETURNS the
    //     muted-replay commands and dispatches NONE (the mute). ---
    let (core, _ep, _source) = build_topology();
    let store = RedbStore::open(&log_path).expect("reopen log");
    let ledger = DispatchLedger::open(&ledger_path).expect("reopen ledger");
    let mut host = Host::new(core, store, ledger, None).expect("reopen host");
    let replayed_commands = host.recover().expect("recover"); // re-fold, muted.

    // (3) NON-VACUOUS zero-dispatch mute: the muted replay RE-EMITTED >= 1 real command
    // (the Debug sink's) — proving the log genuinely WOULD re-run a side effect if the
    // executor were not muted — yet `recover` dispatched NONE of them (it returns them
    // for the caller to discard; the driver never hands them to an executor). If the
    // topology emitted nothing on replay this would be vacuous; it does not.
    assert!(
        !replayed_commands.is_empty(),
        "the muted replay re-emitted a real command (the Debug sink) — non-vacuous proof \
         that recover returns-but-does-not-dispatch"
    );

    let (_etx2, erx2) = channel::<EndpointIngress>(ENDPOINT_INGRESS_CAPACITY);
    let (_gtx2, grx2) = gesture_channel();
    let mut sim2 =
        SimLoop::new(host, RenderProducer::new(), rt.handle(), cfg(), grx2).with_endpoint(erx2);

    let reg = sim2.registry_handle();
    // (1) the reconstructed registry is EMPTY — no parked socket survived the restart.
    assert_eq!(
        reg.len(),
        0,
        "a recovered host parks nothing — the registry is EMPTY (replay-mute, ENDP-04/05)"
    );
    // (2) the recovered core state is byte-identical to the live core.
    assert_eq!(
        sim2.host().snapshot_bytes(),
        live_snapshot,
        "replay reproduced the live core state byte-for-byte"
    );

    // A COLLECTING sender parked exactly where a replayed reply arm would write
    // (far-future deadline so the sweep never fires): it stays silent because the muted
    // replay dispatches nothing, so no Effect::Reply reaches the consumer arm.
    let writes = Arc::new(AtomicUsize::new(0));
    let (probe_tx, probe_rx) = oneshot::channel::<HttpResponse>();
    {
        let writes = Arc::clone(&writes);
        rt.spawn(async move {
            if probe_rx.await.is_ok() {
                writes.fetch_add(1, Ordering::SeqCst);
            }
        });
    }
    reg.try_park(0, u64::MAX, probe_tx)
        .expect("park the collecting probe under the log correlation");
    sim2.run(Some(50), Duration::ZERO).expect("drive replay-side ticks");

    assert_eq!(
        writes.load(Ordering::SeqCst),
        0,
        "ZERO sockets written on replay — the replayed reply arm is muted (ENDP-04b)"
    );
}

/// ENDP-05 — a saved Endpoint scene re-registers its path-keyed route after a Load
/// host-swap. `force_republish_routes` runs on the swap, so the loaded scene's
/// endpoint is routable from the first post-Load request. An in-flight request at
/// the (simulated) crash is lost by design (a parked socket cannot survive a
/// restart — proven by `replay_registry_empty_zero_writes`).
///
/// # AND the 72-07 namespace rule, over a map that CONTAINS BOTH KINDS (V-4)
/// This test's slash assertions used to be VACUOUS, and the vacuity sweep proved it by
/// mutation: giving Source keys a leading slash at `sim_loop.rs`'s `project_routes`,
/// which collapses the endpoint and source namespaces onto one, left this test GREEN.
/// Both boards it walked held ONLY endpoint keys - the pre-Load board held nothing at
/// all - so `.all(|k| !k.starts_with('/'))` was true over an EMPTY iterator and no
/// implementation change could redden it.
///
/// A namespace claim needs a key of EACH kind in the SAME map to be a claim at all. So
/// both boards now carry a Source as well as a Route, both boards are asserted
/// NON-EMPTY before anything is asserted about their keys, and the post-Load board is
/// asserted to hold exactly one key of each kind resolving to a node of the matching
/// KIND. Under the mutation above the source key becomes `/src-<id>` and this reddens
/// three times over.
#[test]
fn route_reregisters() {
    let rt = rt();

    // Save a scene CONTAINING an Endpoint AND a Source to a `.fab`.
    let save_dir = tempfile::tempdir().expect("save tempdir");
    let fab = save_dir.path().join("scene.fab");
    let (saved_ep, saved_src, saved_key) = {
        let (host, ep, src) = host_with_ep_and_source(save_dir.path());
        let (_gtx, grx) = gesture_channel();
        let sim = SimLoop::new(host, RenderProducer::new(), rt.handle(), cfg(), grx);
        let key = ep_key(sim.host().core(), ep);
        // Sanity: the placed Endpoint routes live at its own path's key before the save,
        // and the Source routes live at src-<id> beside it under NO slash.
        assert_eq!(
            sim.routes_receiver().borrow().get(&key),
            Some(&ep),
            "the placed Endpoint routes at its own path's key before the save"
        );
        assert_eq!(
            sim.routes_receiver().borrow().get(&src_label(src)),
            Some(&src),
            "and the placed Source routes at src-<id>, in the OTHER namespace"
        );
        save_project(sim.host(), &fab).expect("save the endpoint scene");
        (ep, src, key)
    };

    // A fresh genesis sim carrying a SOURCE and no Endpoint; Load swaps the saved scene
    // in. The Source is what makes the pre-Load assertion below an assertion: a genesis
    // board with no routable node at all publishes an EMPTY map, and every claim about
    // the shape of its keys is then true by vacuity.
    let dir = tempfile::tempdir().expect("tempdir");
    let mut core = Core::genesis(header());
    let pre_src = core.state.add_source();
    let store = RedbStore::open(dir.path().join("log.redb")).expect("open log");
    let ledger = DispatchLedger::open(dir.path().join("ledger.redb")).expect("open ledger");
    let host = Host::new(core, store, ledger, None).expect("open host");
    let (_gtx, grx) = gesture_channel();
    let (ctx, crx) = unbounded_channel::<ControlMsg>();
    let mut sim =
        SimLoop::new(host, RenderProducer::new(), rt.handle(), cfg(), grx).with_control(crx);

    // Before the Load, the scene has NO endpoint route. Tested on the SLASH, which is
    // the namespace rule since 72-07, rather than on the `ep-` prefix, which a
    // user-typed path no longer has to carry.
    {
        let pre = sim.routes_receiver().borrow().clone();
        // NON-VACUITY FIRST, and by NAME rather than by count: the map must hold this
        // Source's own key, spelled the way a source key is spelled. An empty map, or a
        // map whose one key had moved into the endpoint namespace, fails HERE rather
        // than passing the `.all()` below by holding nothing to walk.
        assert_eq!(
            pre.get(&src_label(pre_src)),
            Some(&pre_src),
            "the pre-Load board publishes its Source at src-<id>, with NO leading slash \
             (V-4: this is what gives the `.all()` below something to be false about)"
        );
        assert!(
            pre.keys().all(|k| !k.starts_with('/')),
            "the scene has no endpoint route before the Load, and no source key may \
             carry the endpoint namespace's leading slash: keys were {:?}",
            pre.keys().collect::<Vec<_>>()
        );
    }

    ctx.send(ControlMsg::Load(fab)).expect("send load");
    sim.step().expect("service the Load (immediate swap on a quiescent genesis)");

    // After the host-swap, force_republish_routes made the loaded Endpoint routable.
    let routes = sim.routes_receiver().borrow().clone();
    let (_label, &node) = routes
        .iter()
        .find(|(k, _)| k.starts_with('/'))
        .expect("the loaded Endpoint re-registered its route after Load (ENDP-05)");
    assert!(
        matches!(sim.host().core().state.node(node), Some(Node::Endpoint(_))),
        "the endpoint route resolves to the loaded Endpoint node"
    );

    // THE NAMESPACE CLAIM, over a map that now holds one key of EACH KIND. The saved
    // scene carried both, so the loaded board does too, and the split is asserted BOTH
    // ways: the key each node answers at, and the kind each key resolves to. A build
    // that keyed sources under a slash fails the first pair; a build that keyed
    // endpoints without one fails the second.
    assert_eq!(
        routes.get(&saved_key),
        Some(&saved_ep),
        "the loaded Route keeps the key its saved path made, under the slash"
    );
    assert_eq!(
        routes.get(&src_label(saved_src)),
        Some(&saved_src),
        "and the loaded Source keeps its src-<id> key, with no slash: the host-swap \
         republish must not move a key between namespaces"
    );
    assert_eq!(
        routes.len(),
        2,
        "two routable nodes, two keys, no collapse: {:?}",
        routes.keys().collect::<Vec<_>>()
    );
    for (key, id) in routes.iter() {
        let node = sim.host().core().state.node(*id);
        assert_eq!(
            key.starts_with('/'),
            matches!(node, Some(Node::Endpoint(_))),
            "key {key} must lead with a slash for an Endpoint and must NOT for a \
             Source; it resolved to {node:?}"
        );
        assert_eq!(
            key.starts_with("src-"),
            matches!(node, Some(Node::Source(_))),
            "and the two namespaces are DISJOINT, which is what lets one map serve \
             both front doors: key {key} resolved to {node:?}"
        );
    }
}

/// F4 — a host swap (Load / LoadDemo) drains the correlation registry: every socket
/// parked against the DISCARDED pre-swap timeline is resolved with a `503`
/// ("scene reloaded") and the registry is left EMPTY, so the loaded scene starts
/// clean (matching crash-recovery). Without this, a socket parked pre-swap leaks
/// forever (held while Frozen → accumulates toward the cap) or is prematurely 504'd
/// against a higher loaded tick.
#[test]
fn swap_drains_orphaned_parked_socket_with_503() {
    let rt = rt();

    // A fresh genesis sim (quiescent) wired for control messages.
    let dir = tempfile::tempdir().expect("tempdir");
    let core = Core::genesis(header());
    let store = RedbStore::open(dir.path().join("log.redb")).expect("open log");
    let ledger = DispatchLedger::open(dir.path().join("ledger.redb")).expect("open ledger");
    let host = Host::new(core, store, ledger, None).expect("open host");
    let (_gtx, grx) = gesture_channel();
    let (ctx, crx) = unbounded_channel::<ControlMsg>();
    let mut sim =
        SimLoop::new(host, RenderProducer::new(), rt.handle(), cfg(), grx).with_control(crx);

    // Park a socket against the CURRENT (pre-swap) timeline with a far-future deadline
    // so the deadline sweep can never 504 it before the swap does its drain.
    let reg = sim.registry_handle();
    let (tx, mut socket) = oneshot::channel();
    reg.try_park(0, u64::MAX, tx).expect("park a socket under the cap");
    assert_eq!(reg.len(), 1, "the socket is parked before the swap");

    // Swap in the command-built demo scene (LoadDemo) — an immediate swap on a
    // quiescent genesis. `install_swapped_host` must drain the orphaned socket.
    ctx.send(ControlMsg::LoadDemo).expect("send load_demo");
    sim.step().expect("service the LoadDemo swap");

    // The orphaned caller received a deterministic 503; the loaded scene's registry
    // is EMPTY (matching crash-recovery).
    let resp = poll_socket(&mut socket);
    assert_eq!(
        resp.status().as_u16(),
        503,
        "the orphaned parked socket is resolved with a 503 on swap (F4)"
    );
    assert_eq!(
        resp.body_bytes(),
        br#"{"error":"scene reloaded"}"#,
        "the canonical scene-reloaded 503 body"
    );
    assert!(
        reg.is_empty(),
        "the registry is drained EMPTY after the swap (crash-recovery parity)"
    );
}

/// CORE-FROZEN tripwire (the fast in-crate guard beside the golden cross-platform
/// corpus cert): the five serialized-shape version consts equal their frozen
/// values. A bump here without the Phase-35 re-bless is a HARD-STOP — the host
/// design must leave the core's wire shapes byte-identical (fixtures 0001-0026).
///
/// Phase 60 (`60-02`) moved exactly TWO of the five, in lockstep, and the other
/// three assertions below were the positive proof that it moved no more than that.
/// SNAPSHOT went 8 to 9, byte-forced by the belt slot vector growing from three
/// entries per tile to four; PROJECT went 6 to 7 so the refusal of a pre-change
/// save is a single O(1) envelope error rather than a deferred inner snapshot
/// error that reads like corruption.
///
/// Phase 62 (`62-06`) moves exactly the SAME TWO, in lockstep, for the same class of
/// reason: SNAPSHOT goes 9 to 10, byte-forced by `Belt.ticks_per_slot` (SLOT-03), and
/// PROJECT goes 7 to 8 so a pre-change save is refused at the envelope rather than
/// coming back as a corruption-shaped `Malformed` from a short body. EDIT, event and
/// cmd-wire deliberately do NOT move, at Phase 60 and again here: no `EditRecord`,
/// `Event` or command shape changes, so bumping them would cargo-cult the v6.0
/// re-bless (which moved all five only because a new `Port` field genuinely
/// byte-forced all five) rather than follow it. This test is what makes "only two of
/// the five moved" MACHINE-CHECKED rather than asserted in a summary.
///
/// Phase 63 (`63-11`) moves exactly ONE of the five, and it is the first bump in this
/// list that is not byte-forced. EDIT goes 6 to 7 as a deliberate CLEAN BREAK: no
/// `EditRecord` field moved, so a pre-v8.0 log would decode perfectly well, and that is
/// precisely why the version has to refuse it. The change was accepted on the
/// grounds that the system is not in production use. SNAPSHOT, PROJECT, event and
/// cmd-wire deliberately do NOT move: no `GridState`, `Event` or command shape changed
/// in milestone v8.0, so bumping them would cargo-cult the v6.0 re-bless. The other
/// four assertions below are the positive proof of that scope.
///
/// Phase 72 (`72-12`) moves exactly THREE of the five, which is the widest lockstep
/// since the v6.0 re-bless, and the two that stay put are what bounds it.
/// SNAPSHOT goes 10 to 11, byte-forced by `Node::Endpoint` gaining its Route path
/// `String` (SERVE-08, plan 72-07) so every stored board holding a Route changed shape.
/// PROJECT goes 8 to 9 so a pre-change save is refused at the envelope rather than
/// coming back as a corruption-shaped `Malformed` from a short body, exactly as at
/// Phases 60 and 62. Cmd-wire EVENT_VERSION goes 3 to 4, and that one moves ZERO corpus
/// bytes: it is a pure runtime wire declaration, taken because D-07 grew a serialized
/// `Effect` variant that rides the redb command log.
///
/// EDIT and event `SCHEMA_VERSION` deliberately do NOT move, and the reason is a rule
/// rather than an oversight (D-21): every edit-side change Phase 72 made is an APPEND AT
/// THE LAST POSITION, so a pre-phase `EditRecord` or `Event` decodes exactly as it always
/// did. Those two assertions below are the positive proof that a three-constant bump did
/// not become a five-constant one by momentum.
///
/// Phase 73 (`73-03`) moves exactly ONE of the five, and unlike Phase 63's it IS
/// byte-forced. EDIT goes 7 to 8, forced by two fields on two EXISTING variants:
/// `EditOp::AddPort` gains an `index` (so a removed output can be put back in the slot it
/// came out of rather than at the end of the list) and `DeletedSubgraph` gains a
/// `self_record` (so a deleted bare wire's own endpoints are in the log and the cable can
/// be rebuilt). A field on an existing variant shifts every byte after it under postcard,
/// which is what separates this from the `AddPort`/`RemovePort` VARIANT appends of Phase
/// 36 that forced nothing. Both corpora are re-blessed in the same commit as the
/// constant, not quarantined to a later plan, because both fields are forced by this one
/// constant and splitting them would mean two re-blesses.
///
/// The other four deliberately do NOT move here, and each has its own reason rather than
/// one shared one. SNAPSHOT does not move because no `GridState` shape changed: the
/// capture that grew is an EDIT-LOG payload, and `fold_delete` has never consumed it.
/// Event `SCHEMA_VERSION` and cmd-wire `EVENT_VERSION` do not move because the wire
/// `GridCommand::AddPort` does NOT gain the index - a forward add always appends, so the
/// command layer resolves the slot at validate time and the user gesture is unchanged.
/// PROJECT did not move in `73-03` specifically: it goes 9 to 10 later in this same
/// phase, in plan `73-07`, for an unrelated out-of-log-seed marker, so a reader who finds
/// it at 9 in a commit between the two is looking at a correct intermediate state and not
/// a missed bump.
///
/// Phase 73 (`73-07`) takes that second move, and it is the SECOND envelope bump inside
/// one phase. PROJECT goes 9 to 10, byte-forced by `ProjectFile` gaining, at the LAST
/// position, a field recording nodes minted outside the edit log: postcard is positional and not
/// self-describing, so a v9 bundle read through the v10 shape would come back as a
/// corruption-shaped `Malformed` from a short body rather than as a refusal that says
/// what happened. The change was accepted deliberately, as a separate one-way spend
/// from `73-03`'s on a different constant. What softened the cost, and both halves were
/// weighed: `73-03` already
/// refuses every earlier `.fab` at the edit-record layer regardless, so this adds no
/// user-visible loss on top of a bump already taken; and `73-04` already landed the card
/// that says WHY a file will not open, so unlike the first bump this refusal is visible
/// from the moment it exists.
///
/// The other four do NOT move for `73-07`, and the reason is one rule: the marker is a
/// HOST-side envelope field. It is not a `GridState` shape (so SNAPSHOT holds at 11), it
/// is not an `EditRecord` field (so EDIT holds at 8 where `73-03` put it), and it is
/// neither a runtime event nor a command (so both wire versions hold). A board's stored
/// bytes are unchanged; only the file that wraps them grew.
///
/// `74-02` (D-09/D-03, LINK-08) moves TWO of the five, and the paragraph above is now
/// history rather than the current reading: SNAPSHOT goes 11 to 12 and PROJECT 10 to 11.
/// The cause is a `GridState` shape change this time, which is why it lands the other way
/// round from `73-07`: a `Belt` declared no ports and now declares two. The bump is NOT
/// byte-forced - `ports` is a map that already existed, so a v11 body re-tagged forward
/// DECODES, and comes back with un-ported belts. That silent mis-decode is what the
/// refusal prevents, and `fabrico-core`'s `SNAPSHOT_SCHEMA_VERSION` docblock carries the
/// measurement. PROJECT moves in lockstep because a `ProjectFile` embeds a snapshot. The other
/// three hold for the same rule read the same way: belt ports are not an `EditRecord`
/// field (EDIT holds at 8), and they are neither a runtime event nor a command (both wire
/// versions hold). That "exactly these two moved" claim is what this test machine-checks.
///
/// `74.1-12` (CORNER-06, review WR-01) moves ONE of the five: EDIT goes 8 to 9, and like
/// `63-11` it is decision-forced rather than byte-forced. No `EditOp` byte moved; two fold
/// verdicts changed what an unchanged log folds to (the `74.1-03` rotate facing narrowing,
/// and the `74.1-12` port-edit release of a belt whose port no longer faces it), so every
/// version-8 log is refused rather than mis-folded. SNAPSHOT holds at 12 (no `GridState`
/// shape moved), PROJECT holds at 11 (the per-record edit check refuses an old bundle on
/// its own), and both wire versions hold. Again exactly one moved, machine-checked here.
///
/// `74.1-14` (CORNER-06, the "Edits keep middle layout" rule) moves ONE
/// of the five again: EDIT goes 9 to 10, decision-forced like `74.1-12`. No `EditOp` byte
/// moved; the port-edit reseat rule became centre-out from the catalog box and the Router
/// catalog took its output, so an unchanged version-9 log folds to different port cells
/// and different kept docks, and is refused rather than mis-folded. SNAPSHOT holds at 12
/// (a snapshot restores its stored cells unchanged), PROJECT at 11, both wire versions
/// hold. Exactly one moved, machine-checked here.
///
/// `74.1-16` (CORNER-06, the remove-output layout rule, review WR-01) moves ONE of the
/// five again: EDIT goes 10 to 11, BYTE-forced by `EditOp::AddPort.seat` and
/// `EditOp::RemovePort.restore` (trailing fields on live variants) and decision-forced (no
/// port edit moves an existing port, so an unchanged version-10 log folds to a different
/// board). SNAPSHOT holds at 12 (no snapshot byte shape moved and a snapshot restores its
/// stored cells unchanged), PROJECT at 11 (the per-record edit check refuses an old bundle
/// on its own), and both wire versions hold (no cmd-wire byte moved). Exactly one moved,
/// machine-checked here.
///
/// `85-05` (CHROME-04, D-08) moves THREE of the five in lockstep, all BYTE-forced by one
/// deletion: the Email sink target and effect leave the core with no placeholder, so
/// `SinkTemplate::Http` shifts from discriminant 2 to 1 and `Effect::Http`/`Reply` from 3/4
/// to 2/3. SNAPSHOT goes 12 to 13 (a snapshot holds sink templates), EDIT 11 to 12 (a
/// `Configure` record holds one; the history-seal record also lands inside this shape)
/// and command EVENT 4 to 5 (a stored intent holds an effect, now checked on read).
/// PROJECT holds at 11 until its final v12 shape lands in plan 85-09 (D-07), and event
/// SCHEMA holds at 2 (an event log carries no effect or template). Three moved,
/// machine-checked here.
///
/// `85-09` (DEMO-03, D-07) moves ONE of the five: PROJECT goes 11 to 12, in its final shape
/// for phase 85 and in one commit. BYTE-forced: `ProjectFile` lost its last field, the
/// record of nodes minted outside the edit log, which no board this build writes needs
/// (the demo's caller and handler are logged commands since `85-08`); postcard is
/// positional and ignores trailing bytes, so a v11 body read through the v12 shape would
/// decode silently. The undo floor needs no file field (it rides in the edit log as the
/// seal record), and the v12 file embeds the SNAPSHOT 13 and EDIT 12 shapes `85-05` set.
/// SNAPSHOT, EDIT and both wire versions hold: no core or wire byte moved. A v11 file is
/// the generic `TooOld { found: 11, expected: 12 }`, held against a real v11 save by
/// `project.rs`'s witness. Exactly one moved, machine-checked here.
///
/// `86-02` (WORK-02, D-03) moves ONE of the five: EDIT goes 12 to 13, BYTE-forced by three
/// appended fields, `EditOp::Place.rot`, `DeletedSubgraph.rot` and
/// `DeletedBelt.ticks_per_slot`, so a turned machine that is deleted comes back turned in
/// one step and the cascade's belt pace is recorded beside it. SNAPSHOT holds at 13 (a
/// turned footprint was already stored with its rotation), PROJECT at 12 (the per-record
/// edit check refuses a v12 record as `UnreadableEditRecord(12)` on its own), and both
/// wire versions hold (no cmd-wire byte moved). Exactly one moved, machine-checked here.
///
/// `87-03` (JAM-01, D-02 to D-07) moves TWO of the five: SNAPSHOT goes 13 to 14, BYTE-forced
/// by four fields appended last (`Balancer::next_in`, `Tee::faults`,
/// `Factory::pending_emits`, `Scheduler::blocked`), all of phase 87's new serialized state
/// in one bump, and PROJECT goes 12 to 13 in lockstep because a project file embeds a
/// snapshot. EDIT holds at 13 (no `EditOp` changed) and both wire versions hold (no event
/// or `Effect` changed). Two moved, machine-checked here.
///
/// These are HAND-WRITTEN literals and must stay literals. Deriving any of them
/// from the constant it checks would make this tripwire agree with any value.
#[test]
fn core_version_consts_are_frozen() {
    assert_eq!(
        fabrico_core::snapshot::SNAPSHOT_SCHEMA_VERSION,
        14,
        "SNAPSHOT schema version is frozen at 14"
    );
    assert_eq!(
        fabrico_core::edit::EDIT_SCHEMA_VERSION,
        13,
        "EDIT schema version is frozen at 13"
    );
    assert_eq!(
        fabrico_host::project::PROJECT_FILE_VERSION,
        13,
        "PROJECT file version is frozen at 13"
    );
    assert_eq!(
        fabrico_core::event::SCHEMA_VERSION,
        2,
        "event SCHEMA_VERSION is frozen at 2"
    );
    assert_eq!(
        fabrico_core::command::EVENT_VERSION,
        5,
        "command EVENT_VERSION is frozen at 5"
    );
}
