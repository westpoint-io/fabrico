//! A runnable, watchable vertical slice: fire a REAL loopback webhook through a
//! JS factory transform to a CAPTURED Debug effect, printing every stage.
//!
//! Run it with:
//! ```text
//! cargo run -p fabrico-host --example vertical_slice
//! ```
//!
//! The flow is the same `source -> factory -> debug-sink` topology the
//! `tests/vertical_slice.rs` integration test proves, driven by the same
//! hand-rolled mini-executor that records each Debug effect and resolves it with
//! the real debug sink (RESEARCH Pitfall 6, zero production change). The
//! difference: this binds a genuine axum webhook listener and POSTs to it over
//! the loopback interface so the slice is end-to-end observable. (It ended in an
//! email sink until phase 85 removed the mail sender, D-08.)
//!
//! # Hardening folded in (Phase-5 H-1)
//! The listener binds `127.0.0.1:0` and the example ASSERTS
//! `addr.ip().is_loopback()` before serving: the webhook is never reachable
//! off-host. The Debug sink opens no socket, exactly like CI.

use std::collections::BTreeMap;

use fabrico_core::command::{Command, Effect, Outcome, ResultEvent};
use fabrico_core::core::Core;
use fabrico_core::event::{EventPayload, LogHeader, SCHEMA_VERSION};
use fabrico_core::factory::DEFAULT_GAS_BUDGET;
use fabrico_core::ids::{Item, NodeId};
use fabrico_core::persist::RedbStore;
use fabrico_core::state::SinkTemplate;
use fabrico_host::driver::Host;
use fabrico_host::ingress::seen_set::SeenSet;
use fabrico_host::ingress::endpoint::EndpointIngress;
use fabrico_host::ingress::webhook::{Ingress, RouteTable, WEBHOOK_INGRESS_CAPACITY, webhook_router};
use fabrico_host::ledger::DispatchLedger;
use fabrico_host::sinks::debug::dispatch_debug;
use slotmap::Key;
use tokio::net::TcpListener;
use tokio::sync::mpsc::unbounded_channel;

/// Genesis seed (also the factory RNG sub-seed) — fixed for determinism.
const SEED: u64 = 7;

/// The factory transform: parse the inbound webhook JSON and emit a line built
/// from `input.name` (the POST body MUST be valid JSON, Pitfall 5).
const TRANSFORM_JS: &str = r#"export default function (input, ctx) {
  var name = (input && input.name) ? input.name : "world";
  ctx.emit(0, "fabrico received an event for " + name);
}"#;

const WEBHOOK_BODY: &[u8] = br#"{"name":"Ada"}"#;
const DELIVERY_ID: &str = "demo-delivery-1";

fn header() -> LogHeader {
    LogHeader {
        schema_version: SCHEMA_VERSION,
        seed: SEED,
    }
}

/// Wire `source -> factory -> debug-sink`, returning the source node id (the
/// webhook target).
fn wire(core: &mut Core) -> NodeId {
    let src = core.state.add_source();
    let fact = core
        .state
        .add_factory(TRANSFORM_JS.to_owned(), DEFAULT_GAS_BUDGET, SEED);
    let sink = core.state.add_sink(SinkTemplate::Debug, 10);
    core.state.link((src, 0), (fact, 0));
    core.state.link((fact, 0), (sink, 0));
    src
}

#[tokio::main]
async fn main() {
    // Self-contained, deterministic: all redb lives under a temp dir.
    let dir = tempfile::tempdir().expect("tempdir");
    let mut core = Core::genesis(header());
    let src = wire(&mut core);
    let store = RedbStore::open(dir.path().join("log.redb")).expect("open log");
    let ledger = DispatchLedger::open(dir.path().join("ledger.redb")).expect("open ledger");
    let seen = SeenSet::open(dir.path().join("seen.redb")).expect("open seen-set");
    let mut host = Host::new(core, store, ledger, None)
        .expect("open host")
        .with_seen_set(seen);

    // ── Bind a REAL loopback webhook listener (H-1) ──────────────────────────────
    let (ingress_tx, mut ingress_rx) =
        tokio::sync::mpsc::channel::<Ingress>(WEBHOOK_INGRESS_CAPACITY);
    // The webhook door serves only `src-<ffi>` keys (the F1 cross-door guard), the
    // same key the live route projection mints. A bare "src" key is a 404 there.
    let route_key = format!("src-{}", src.data().as_ffi());
    let mut routes = BTreeMap::new();
    routes.insert(route_key.clone(), src);
    // The route table now crosses the boundary as a `watch` snapshot (HOST-07). This
    // example uses a static table, so wrap it once and drop the sender (a receiver
    // still borrows the last value after all senders drop).
    let (_routes_tx, routes_rx) = tokio::sync::watch::channel(std::sync::Arc::new(RouteTable { board: 0, routes }));
    // This slice exercises only `/hook/...`; a throwaway endpoint ingress sender
    // satisfies the shared-router signature (38-02).
    let (endpoint_tx, _endpoint_rx) = tokio::sync::mpsc::channel::<EndpointIngress>(fabrico_host::ingress::endpoint::ENDPOINT_INGRESS_CAPACITY);
    // A demo with no SimLoop: a fixed always-Playing signal keeps Gate A open.
    let is_playing = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
    let app = webhook_router(routes_rx, ingress_tx, endpoint_tx, 64 * 1024, is_playing);
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind loopback");
    let addr = listener.local_addr().expect("local addr");
    // Phase-5 hardening H-1: the webhook listener is loopback-only this phase.
    assert!(
        addr.ip().is_loopback(),
        "the webhook listener must bind a loopback address (H-1)"
    );
    println!("== fabrico vertical slice (headless) ==");
    println!("webhook listener bound on http://{addr}  (loopback: {})", addr.ip().is_loopback());
    tokio::spawn(async move {
        axum::serve(listener, app).await.expect("serve");
    });

    // ── Fire the webhook over loopback (spawned: it awaits the host-loop ack) ─────
    let url = format!("http://{addr}/hook/{route_key}");
    println!();
    println!("--> POST {url}");
    println!("    x-delivery-id: {DELIVERY_ID}");
    println!("    inbound webhook body: {}", String::from_utf8_lossy(WEBHOOK_BODY));
    let post = tokio::spawn(async move {
        reqwest::Client::new()
            .post(&url)
            .header("x-delivery-id", DELIVERY_ID)
            .body(WEBHOOK_BODY.to_vec())
            .send()
            .await
    });

    // ── The hand-rolled mini-executor (records each Debug effect, no socket) ──────
    let mut capture: Vec<Vec<u8>> = Vec::new();
    let (cmd_tx, mut cmd_rx) = unbounded_channel::<Command>();
    let (res_tx, mut res_rx) = unbounded_channel::<ResultEvent>();
    let (sim_ing_tx, mut sim_ing_rx) = unbounded_channel::<EventPayload>();

    // Await the REAL webhook delivery (the spawned POST is blocked on our ack, so
    // this resolves the instant axum forwards the request). Dedup BEFORE log exactly
    // as `run()` does (INGRESS-02): a NEW delivery id becomes a ManualInject into the
    // sim; a duplicate would be dropped.
    let Ingress {
        target,
        board: _,
        delivery_id,
        body,
        ack,
    } = tokio::time::timeout(std::time::Duration::from_secs(10), ingress_rx.recv())
        .await
        .expect("the webhook reached the host within 10s (a 404 means a wrong route key)")
        .expect("webhook ingress arrived");
    let is_new = match &delivery_id {
        Some(id) => host.record_delivery(id).expect("record delivery"),
        None => true,
    };
    if is_new {
        let _ = sim_ing_tx.send(EventPayload::ManualInject {
            target,
            port: 0,
            item: Item(body),
        });
    }
    // Ack after the first tick has logged the inject (idempotent 200).
    let mut ack = Some(ack);

    let mut guard = 0u32;
    loop {
        host.tick_once(&mut sim_ing_rx, &mut res_rx, &cmd_tx)
            .expect("tick");

        if let Some(ack) = ack.take() {
            let _ = ack.send(());
        }

        // Resolve freshly-emitted commands: the Debug effect is recorded and
        // resolved by the real debug sink (no socket), feeding its Outcome back as
        // a ResultEvent the host folds next tick.
        while let Ok(cmd) = cmd_rx.try_recv() {
            let outcome = match &cmd.effect {
                Effect::Debug { message } => {
                    println!();
                    println!("factory transform -> debug sink:");
                    println!("    message: {}", String::from_utf8_lossy(message));
                    capture.push(message.clone());
                    dispatch_debug(message)
                }
                _ => Outcome::Success,
            };
            let _ = res_tx.send(ResultEvent {
                command_id: cmd.id,
                tick: 0,
                outcome,
            });
        }

        // Quiescent: the effect captured and its result folded (in-flight empty).
        if host.in_flight_len() == 0 && capture.len() == 1 {
            break;
        }

        guard += 1;
        assert!(guard < 256, "the demo failed to quiesce within 256 ticks");
    }

    // The host-loop ack released the POST — confirm the idempotent 200.
    let status = post
        .await
        .expect("post task joined")
        .expect("webhook POST sent")
        .status();
    println!();
    println!("<-- webhook responded {status}");
    assert!(status.is_success(), "the webhook POST was taken (200), got {status}");

    println!();
    println!(
        "captured {} Debug effect at the executor seam, no outbound socket was opened",
        capture.len()
    );
    assert_eq!(capture.len(), 1, "exactly one Debug effect captured end-to-end");
    println!("slice complete: webhook -> factory -> debug sink, exactly once.");
}
