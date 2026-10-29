//! THE ORDER-PROCESSING FLOW PROOF (Phase 55, EX-02 — the SC1 Rust half): the
//! shipped `order_processing.ron` teaching scene, seeded through the certified
//! one-command-per-tick path onto a real `Host`, proven end-to-end — a real
//! order JSON body injected at the webhook Source flows
//! `source -> validate/split Factory -> both corridors over belts -> both sinks`,
//! dispatching exactly ONE `Effect::Debug` invoice (resolved by the real
//! `sinks::debug::dispatch_debug` and recorded by the test, no socket; plan 85-03
//! moved the invoice sink from Email to Debug) and exactly ONE `Effect::Http` POST
//! (captured by an in-process axum loopback) per valid order; then the whole
//! cycle survives replay byte-for-byte with ZERO re-dispatch, the fault posture
//! is pinned at both validation boundaries, and the scene's UI-producible
//! vocabulary is enforced by census.
//!
//! Harness lineage: `flow_proof.rs` (test_host/channels/inject over tempfile
//! redb + a live `cmd_rx`), `vertical_slice.rs` (the hand-rolled deterministic
//! mini-executor + the muted-recover replay proof), `sinks.rs`
//! (`spawn_loopback`: axum on `127.0.0.1:0`, recording `Idempotency-Key`s).
//!
//! The scene's shipped HTTP sink target is the harmless user-editable
//! `http://localhost:8799/fulfillment` (T-55-02); the flow tests re-Configure
//! it to the loopback's ephemeral URL through ONE more `apply_gesture`
//! Configure — itself UI-producible (the config panel's URL field), so the
//! tests exercise nothing a user could not do.
//!
//! Quiescence discipline (load-bearing for the replay test): the slice runner
//! stops the INSTANT the expected dispatches are captured and their results
//! folded (in-flight empty) — no trailing idle ticks, which would advance
//! `core.tick` past the last logged event and diverge a log-only replay
//! (vertical_slice.rs's documented hazard).

use std::collections::BTreeSet;
use std::sync::{Arc, Mutex};

use axum::{
    Router,
    extract::State,
    http::{HeaderMap, StatusCode},
    routing::any,
};
use fabrico_core::belt_slots::DEFAULT_TICKS_PER_SLOT;
use fabrico_core::command::{Command, Effect, Outcome, ResultEvent};
use fabrico_core::core::Core;
use fabrico_core::event::{Event, EventPayload, LogHeader, SCHEMA_VERSION};
use fabrico_core::ids::{CommandId, Item, NodeId};
use fabrico_core::persist::RedbStore;
use fabrico_host::demo_scene::{ORDER_GENESIS_SEED, order_commands, seed_scene};
use fabrico_host::driver::Host;
use fabrico_host::input_apply::apply_gesture;
use fabrico_host::ledger::DispatchLedger;
use fabrico_host::sinks::debug::dispatch_debug;
use fabrico_host::sinks::http::{default_client, dispatch_http};
use fabrico_protocol::{GridCommand, MachineConfig, SinkTemplate, machine_kind};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};

/// A real order body — valid JSON with `id` + an `items` array (the splitter's
/// validation contract).
const ORDER_BODY: &[u8] = br#"{"id":"ord-1","items":[{"sku":"widget","qty":2,"price":5}]}"#;

/// A second real order — the back-to-back exactly-once probe.
const ORDER_BODY_2: &[u8] = br#"{"id":"ord-2","items":[{"sku":"gear","qty":1,"price":3}]}"#;

/// Valid JSON that is structurally NOT an order (no `id`, no `items` array):
/// the splitter's JS throws on it — the adjacency edge.
const NOT_AN_ORDER: &[u8] = br#"{"note":"no id, no items"}"#;

/// Not JSON at all: faults at the sandbox's canonical-JSON boundary BEFORE the
/// splitter JS runs — the empty/malformed edge.
const NOT_JSON: &[u8] = b"not json{{";

/// Ticks between one slot advance on every belt this scene builds (SLOT-03). Every
/// tick BUDGET below is multiplied by it; no expectation is. See
/// `crates/fabrico-core/tests/belt_per_tile.rs`'s module docblock for why the two
/// sides are kept apart.
const ADVANCE_INTERVAL: u32 = DEFAULT_TICKS_PER_SLOT.get();

/// Quiescence guard (mirrors `flow_proof.rs`'s settle headroom): the longest
/// corridor is ~13 belt tiles at `SLOTS_PER_TILE = 4` (Phase 60 / SLOT-01 moved it
/// from 3), so ~52 belt ticks at an interval of one, plus three factory hops.
///
/// A BUDGET, therefore DERIVED (plan 62-03): the belt leg scales one-for-one with
/// the advance interval, so the number stretches with it rather than being a literal
/// somebody has to remember to move. The runner stops the INSTANT the expected
/// dispatches are captured, so a generous guard costs nothing on a healthy run. The
/// one interaction worth naming: the debug sink synthesizes a Timeout at 600 ticks,
/// and a corridor that actually took that long would need an interval around 12, far
/// outside anything this phase runs.
const GUARD_TICKS: u32 = 400 * ADVANCE_INTERVAL;

/// The fault-posture deadline used by both validation-boundary tests below: an
/// invalid order must reach the splitter and fault within it, over a 4-tile belt
/// (~17 ticks at an interval of one).
///
/// A BUDGET, therefore DERIVED (plan 62-03). Its failure mode is the interesting
/// one and it is not the final assertion: `assert!(splitter_faulted)` fails loudly
/// at the boundary, but the two per-tick "the corridor factories never see the
/// rejected item" assertions INSIDE the loop go vacuous long before that. They are
/// true of every tick after the item is gone, so a window that is merely too short
/// still runs them and they still pass, having observed nothing.
const FAULT_DEADLINE_TICKS: u32 = 120 * ADVANCE_INTERVAL;

/// A real `Host` over tempfile redb stores at the ORDER genesis seed, on an
/// EMPTY grid: the entire scene enters through the edit-log (commands).
fn test_host(dir: &std::path::Path) -> Host {
    let core = Core::genesis(LogHeader {
        schema_version: SCHEMA_VERSION,
        seed: ORDER_GENESIS_SEED,
    });
    let store = RedbStore::open(dir.join("log.redb")).expect("open log");
    let ledger = DispatchLedger::open(dir.join("ledger.redb")).expect("open ledger");
    Host::new(core, store, ledger, None).expect("open host")
}

/// The per-tick channels — ALL six halves returned alive: the tests count sink
/// Commands on `cmd_rx` AND feed `ResultEvent`s back through `res_tx` (the
/// mini-executor loop), unlike `flow_proof.rs` which drops the result sender.
#[allow(clippy::type_complexity)]
fn channels() -> (
    UnboundedSender<EventPayload>,
    UnboundedReceiver<EventPayload>,
    UnboundedSender<Command>,
    UnboundedReceiver<Command>,
    UnboundedSender<ResultEvent>,
    UnboundedReceiver<ResultEvent>,
) {
    let (ingress_tx, ingress_rx) = unbounded_channel::<EventPayload>();
    let (cmd_tx, cmd_rx) = unbounded_channel::<Command>();
    let (res_tx, res_rx) = unbounded_channel::<ResultEvent>();
    (ingress_tx, ingress_rx, cmd_tx, cmd_rx, res_tx, res_rx)
}

/// One `ManualInject` of `item` into `target` on port 0 — the exact ingress
/// payload shape the webhook door produces (`POST /hook/src-<id>` carries the
/// body verbatim as the item bytes).
fn inject(target: NodeId, item: &[u8]) -> EventPayload {
    EventPayload::ManualInject {
        target,
        port: 0,
        item: Item(item.to_vec()),
    }
}

/// The loopback's captured POSTs: `(idempotency_key, body)` pairs.
type SeenPosts = Arc<Mutex<Vec<(String, String)>>>;

/// The invoice Debug sink's dispatches, recorded by the mini-executor as each
/// `Effect::Debug` is resolved through the real `dispatch_debug`: `(command id,
/// item bytes)` pairs. The command id is the deterministic idempotency token the
/// executor keys exactly-once on (the role the email's `Message-ID` played before
/// plan 85-03 moved the invoice sink from Email to Debug).
type SeenInvoices = Vec<(CommandId, Vec<u8>)>;

/// Resolve one `Effect::Debug` command through the real Debug sink, recording it.
fn dispatch_invoice(seen: &mut SeenInvoices, cmd: &Command, message: &[u8]) -> Outcome {
    seen.push((cmd.id, message.to_vec()));
    dispatch_debug(message)
}

async fn fulfillment_handler(
    State(seen): State<SeenPosts>,
    headers: HeaderMap,
    body: String,
) -> StatusCode {
    let key = headers
        .get("idempotency-key")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_owned();
    seen.lock().expect("seen mutex").push((key, body));
    StatusCode::OK
}

/// Spin an in-process axum server on an ephemeral loopback port with a
/// `/fulfillment` route (the shipped sink's path), recording every POST's
/// `Idempotency-Key` + body. Mirrors `tests/sinks.rs::spawn_loopback`.
async fn spawn_loopback() -> (String, SeenPosts) {
    let seen: SeenPosts = Arc::new(Mutex::new(Vec::new()));
    let app = Router::new()
        // `any`, not `post`: a verb-specific route turns a wrong-verb dispatch
        // into an unrelated-looking 405 instead of a legible failure.
        .route("/fulfillment", any(fulfillment_handler))
        .with_state(seen.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind loopback");
    let addr = listener.local_addr().expect("local addr");
    tokio::spawn(async move {
        axum::serve(listener, app).await.expect("serve");
    });
    (format!("http://{addr}"), seen)
}

/// Seed the order scene through the ONE shared applier and return the full
/// mint-order handle ledger (machines 0..=5, belts 6..=10).
fn seed_order_scene(host: &mut Host) -> Vec<NodeId> {
    let ledger =
        seed_scene(host, &order_commands()).expect("every order-scene command is accepted");
    assert_eq!(
        ledger.len(),
        11,
        "6 machines + 5 belts mint through the one-command-per-tick applier"
    );
    ledger
}

/// Re-Configure the HTTP sink (ledger index 5) to `url` through the certified
/// gesture path — itself a UI-producible panel edit (the cleaner option per
/// 55-PATTERNS: the shipped scene keeps its harmless fixed-port default; the
/// tests point it at the ephemeral loopback).
fn retarget_http_sink(host: &mut Host, ledger: &[NodeId], url: String) {
    let (_itx, mut irx, ctx, _crx, _rtx, mut rrx) = channels();
    let minted: Vec<NodeId> = ledger.to_vec();
    apply_gesture(
        host,
        GridCommand::Configure {
            node: 5,
            config: MachineConfig::Sink {
                target: SinkTemplate::Http {
                    url,
                    method: fabrico_protocol::HttpMethod::Post,
                },
            },
        },
        |h| minted.get(h as usize).copied(),
    )
    .expect("re-Configure of the HTTP sink is accepted (UI-producible)");
    host.tick_once(&mut irx, &mut rrx, &ctx)
        .expect("tick folds the sink re-Configure");
}

/// The command ids already resolved (a logged `CommandResult` or `Timeout`) in
/// `events` — the at-most-once set the muted replay must NOT re-dispatch.
/// Cloned from `vertical_slice.rs`.
fn resolved_ids(events: &[Event]) -> BTreeSet<CommandId> {
    let mut resolved = BTreeSet::new();
    for ev in events {
        match &ev.payload {
            EventPayload::CommandResult(re) => {
                resolved.insert(re.command_id);
            }
            EventPayload::Timeout { command_id } => {
                resolved.insert(*command_id);
            }
            _ => {}
        }
    }
    resolved
}

/// Build the order scene on temp redb under `dir`, retarget the HTTP sink at a
/// fresh loopback, inject each of `bodies` at the webhook Source, and drive the
/// hand-rolled deterministic mini-executor (vertical_slice.rs lineage: tick,
/// deliver last iteration's results one tick later, drain + resolve fresh
/// commands: Debug through the real `dispatch_debug`, recorded, Http through a
/// real reqwest POST) to a QUIESCENT boundary: `bodies.len()` invoices recorded,
/// `bodies.len()` POSTs captured, in-flight empty, nothing pending. Stops the
/// instant the slice quiesces — NO trailing idle ticks (replay byte-identity).
async fn run_order_slice(
    dir: &std::path::Path,
    bodies: &[&[u8]],
) -> (Host, SeenInvoices, SeenPosts) {
    let mut host = test_host(dir);
    let ledger = seed_order_scene(&mut host);

    let (base, seen) = spawn_loopback().await;
    retarget_http_sink(&mut host, &ledger, format!("{base}/fulfillment"));

    let (ingress_tx, mut ingress_rx, cmd_tx, mut cmd_rx, res_tx, mut res_rx) = channels();
    let mut invoices: SeenInvoices = Vec::new();
    let client = default_client();

    for body in bodies {
        ingress_tx
            .send(inject(ledger[0], body))
            .expect("send order inject");
    }

    let expected = bodies.len();
    let mut pending: Vec<ResultEvent> = Vec::new();
    let mut guard = 0u32;
    loop {
        host.tick_once(&mut ingress_rx, &mut res_rx, &cmd_tx)
            .expect("tick");
        // Deliver the previous iteration's results now (one-tick async latency;
        // they fold on the NEXT tick, stamped with the host's admit tick).
        for re in pending.drain(..) {
            let _ = res_tx.send(re);
        }
        // Resolve each freshly-emitted command through the REAL sink dispatch
        // seams (no socket for the Debug invoice; a real POST for http).
        while let Ok(cmd) = cmd_rx.try_recv() {
            let outcome = match &cmd.effect {
                Effect::Debug { message } => dispatch_invoice(&mut invoices, &cmd, message),
                Effect::Http { url, body, method } => {
                    dispatch_http(&client, &cmd, url, body, *method).await
                }
                _ => Outcome::Success,
            };
            pending.push(ResultEvent {
                command_id: cmd.id,
                tick: 0, // the host stamps the real admit tick on fold
                outcome,
            });
        }
        let posts = seen.lock().expect("seen mutex").len();
        if host.in_flight_len() == 0
            && invoices.len() == expected
            && posts == expected
            && pending.is_empty()
        {
            break;
        }
        guard += 1;
        assert!(
            guard < GUARD_TICKS,
            "the order slice failed to quiesce within {GUARD_TICKS} ticks \
             (invoices={}, posts={posts}, in_flight={})",
            invoices.len(),
            host.in_flight_len()
        );
    }

    (host, invoices, seen)
}

/// THE TRACER (SC1 end-to-end): one real order in at the webhook Source, the
/// splitter validates + splits, BOTH corridors flow over belts, and BOTH sinks
/// dispatch: exactly one Debug invoice (the order id and its computed total) and
/// exactly one captured loopback POST carrying the order's fulfillment content.
#[tokio::test]
async fn one_order_splits_and_both_sinks_dispatch() {
    let dir = tempfile::tempdir().expect("tempdir");
    let (_host, invoices, seen) = run_order_slice(dir.path(), &[ORDER_BODY]).await;

    // ── The invoice corridor: exactly ONE Debug dispatch, correct routing ──
    assert_eq!(invoices.len(), 1, "exactly one Effect::Debug invoice per valid order");
    let invoice = String::from_utf8(invoices[0].1.clone()).expect("utf-8 invoice");
    assert!(
        invoice.contains("ord-1"),
        "the invoice the Debug sink received is this order's (got: {invoice})"
    );
    assert!(
        invoice.contains("\"total\":10"),
        "the invoice carries the invoice factory's computed total, 2 x 5 (got: {invoice})"
    );

    // ── The HTTP corridor: exactly ONE captured loopback POST ──────────────
    let posts = seen.lock().expect("seen mutex").clone();
    assert_eq!(posts.len(), 1, "exactly one Effect::Http dispatch per valid order");
    assert!(
        posts[0].1.contains("ord-1"),
        "the fulfillment POST body carries the order id (got: {})",
        posts[0].1
    );
    assert!(
        posts[0].1.contains("ship"),
        "the fulfillment POST body is the prepare-fulfillment factory's emission"
    );
    assert!(!posts[0].0.is_empty(), "the POST carried an Idempotency-Key");
}

/// SC1 replay half (vertical_slice.rs:212-265's shape against the order
/// harness): after the flow's dispatches, drop the live host, reopen the SAME
/// redb, `Host::recover()` muted — snapshot_bytes byte-equal to the live head,
/// tick folded to head, and ZERO re-dispatch (both sink commands' results are
/// already resolved in the log).
#[tokio::test]
async fn replay_reproduces_order_state_exactly_once() {
    let dir = tempfile::tempdir().expect("tempdir");
    let (host, invoices, seen) = run_order_slice(dir.path(), &[ORDER_BODY]).await;
    assert_eq!(invoices.len(), 1, "the live run dispatched one Debug invoice");
    assert_eq!(
        seen.lock().expect("seen mutex").len(),
        1,
        "the live run captured one POST"
    );

    let original = host.snapshot_bytes();
    let head = host.core().tick;
    // Drop the live host so its redb file locks release before we reopen the
    // SAME store in a fresh "process".
    drop(host);

    // Fresh genesis over the SAME persisted stores. Unlike vertical_slice.rs
    // (whose topology was direct-core and had to be re-wired by hand), the
    // ENTIRE order scene entered through the edit log (seed_scene is
    // gesture-path), so the muted recover() rebuilds it from genesis — the
    // strictly stronger replay proof.
    let core = Core::genesis(LogHeader {
        schema_version: SCHEMA_VERSION,
        seed: ORDER_GENESIS_SEED,
    });
    let store = RedbStore::open(dir.path().join("log.redb")).expect("reopen log");
    let ledger = DispatchLedger::open(dir.path().join("ledger.redb")).expect("reopen ledger");
    let mut recovered = Host::new(core, store, ledger, None).expect("open host");
    let emitted = recovered.recover().expect("recover");

    // The muted replay reproduced the live trajectory byte-for-byte.
    assert_eq!(
        recovered.snapshot_bytes(),
        original,
        "recovered state == live head state (byte-equality oracle)"
    );
    assert_eq!(recovered.core().tick, head, "replay folded forward to head_tick");

    // Exactly-once: the muted replay re-emits BOTH sink commands, but their
    // results are already in the log — nothing is re-dispatched.
    assert!(
        emitted.iter().any(|c| matches!(c.effect, Effect::Debug { .. })),
        "the muted replay re-emitted the Debug invoice command"
    );
    assert!(
        emitted.iter().any(|c| matches!(c.effect, Effect::Http { .. })),
        "the muted replay re-emitted the http command"
    );
    let resolved = resolved_ids(&recovered.logged_events().expect("read log"));
    let mut replay_cap: SeenInvoices = Vec::new();
    let mut would_redispatch = 0usize;
    for cmd in &emitted {
        if matches!(cmd.effect, Effect::Debug { .. } | Effect::Http { .. })
            && !resolved.contains(&cmd.id)
        {
            // Unreachable for the slice's commands (they ARE resolved) — present
            // to prove the gate, never to fire a second dispatch.
            would_redispatch += 1;
            if let Effect::Debug { message } = &cmd.effect {
                let _ = dispatch_invoice(&mut replay_cap, cmd, message);
            }
        }
    }
    assert_eq!(
        would_redispatch, 0,
        "every re-emitted sink command is already resolved in the log (zero re-dispatch)"
    );
    assert!(
        replay_cap.is_empty(),
        "the muted replay fired no second invoice (exactly-once on replay)"
    );
}

/// Ordering edge: two orders back-to-back produce exactly 2 Debug invoices + 2 HTTP
/// dispatches — exactly-once per order, distinct CommandIds (distinct
/// `Idempotency-Key`s on the POSTs, distinct command ids on the invoices), and
/// the branch assignment is fixed in data (invoice = emit 0 = Debug corridor,
/// fulfillment = emit 1 = HTTP corridor — every POST body is fulfillment
/// content, never an invoice).
#[tokio::test]
async fn two_orders_dispatch_exactly_once_each() {
    let dir = tempfile::tempdir().expect("tempdir");
    let (_host, invoices, seen) = run_order_slice(dir.path(), &[ORDER_BODY, ORDER_BODY_2]).await;

    // ── Exactly 2 Debug invoices, distinct CommandIds (the idempotency token) ─
    assert_eq!(invoices.len(), 2, "exactly one Debug invoice per order, two orders");
    let i0 = String::from_utf8(invoices[0].1.clone()).expect("utf-8 invoice");
    let i1 = String::from_utf8(invoices[1].1.clone()).expect("utf-8 invoice");
    assert!(
        [&i0, &i1].iter().all(|b| b.contains("total") && !b.contains("ship")),
        "each Debug dispatch is an invoice, never fulfillment content (got: {i0}, {i1})"
    );
    assert_ne!(
        invoices[0].0, invoices[1].0,
        "the two invoices carry DISTINCT CommandId tokens (exactly-once per order)"
    );

    // ── Exactly 2 POSTs, distinct Idempotency-Keys, both fulfillment ───────
    let posts = seen.lock().expect("seen mutex").clone();
    assert_eq!(posts.len(), 2, "exactly one HTTP dispatch per order, two orders");
    assert_ne!(
        posts[0].0, posts[1].0,
        "the two POSTs carry DISTINCT Idempotency-Keys (exactly-once per order)"
    );
    let bodies: Vec<&str> = posts.iter().map(|(_, b)| b.as_str()).collect();
    assert!(
        bodies.iter().any(|b| b.contains("ord-1")) && bodies.iter().any(|b| b.contains("ord-2")),
        "each order produced its own fulfillment POST (got: {bodies:?})"
    );
    assert!(
        bodies.iter().all(|b| b.contains("ship") && !b.contains("total")),
        "the HTTP corridor carries FULFILLMENT content only - the branch \
         assignment (invoice = emit 0 = Debug, fulfillment = emit 1 = HTTP) is \
         fixed in data (got: {bodies:?})"
    );
}

/// Adjacency edge (the pass/fail validation boundary): valid JSON that is
/// structurally NOT an order throws in the splitter JS — the machine is
/// FAULTED for that item, with zero emissions on either corridor and zero sink
/// Commands on the live cmd_rx. Verifies the shipped sandbox fence, not a
/// rebuilt one (threat T-55-01).
#[test]
fn invalid_order_faults_splitter_without_dispatch() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut host = test_host(dir.path());
    let ledger = seed_order_scene(&mut host);
    let (splitter, invoice, fulfillment) = (ledger[1], ledger[2], ledger[3]);

    let (ingress_tx, mut ingress_rx, cmd_tx, mut cmd_rx, _res_tx, mut res_rx) = channels();
    ingress_tx
        .send(inject(ledger[0], NOT_AN_ORDER))
        .expect("send invalid-order inject");

    let mut splitter_faulted = false;
    for _ in 0..FAULT_DEADLINE_TICKS {
        host.tick_once(&mut ingress_rx, &mut res_rx, &cmd_tx)
            .expect("tick");
        let faulted = &host.core().last_tick.faulted;
        if faulted.contains(&splitter) {
            splitter_faulted = true;
        }
        assert!(
            !faulted.contains(&invoice) && !faulted.contains(&fulfillment),
            "the corridor factories never see the rejected item (zero emissions)"
        );
    }
    assert!(
        splitter_faulted,
        "a structurally-non-order body throws in the splitter JS -> FAULTED \
         (the honest red-state teaching moment)"
    );
    assert!(
        cmd_rx.try_recv().is_err(),
        "zero sink Commands dispatched for a rejected order"
    );
}

/// Empty/malformed edge: a non-JSON webhook body faults the splitter at the
/// sandbox's canonical-JSON boundary (before the JS even runs) — no panic, no
/// dispatch, and the host keeps ticking (the tick counter still climbs after
/// the fault). Verifies the shipped fence handles arbitrary external bytes
/// (threat T-55-01).
#[test]
fn malformed_body_faults_without_crash() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut host = test_host(dir.path());
    let ledger = seed_order_scene(&mut host);
    let splitter = ledger[1];

    let (ingress_tx, mut ingress_rx, cmd_tx, mut cmd_rx, _res_tx, mut res_rx) = channels();
    ingress_tx
        .send(inject(ledger[0], NOT_JSON))
        .expect("send malformed inject");

    let mut splitter_faulted = false;
    for _ in 0..FAULT_DEADLINE_TICKS {
        host.tick_once(&mut ingress_rx, &mut res_rx, &cmd_tx)
            .expect("tick never panics on a malformed external body");
        if host.core().last_tick.faulted.contains(&splitter) {
            splitter_faulted = true;
        }
    }
    assert!(
        splitter_faulted,
        "a non-JSON body faults at the canonical-JSON sandbox boundary"
    );
    assert!(
        cmd_rx.try_recv().is_err(),
        "zero sink Commands dispatched for a malformed body"
    );

    // The host keeps ticking after the fault — fault, not crash.
    let tick_before = host.core().tick;
    for _ in 0..10 {
        host.tick_once(&mut ingress_rx, &mut res_rx, &cmd_tx)
            .expect("post-fault tick");
    }
    assert_eq!(
        host.core().tick,
        tick_before + 10,
        "the tick counter still climbs after the fault (the host keeps ticking)"
    );
}

/// THE CENSUS (the done-test contract, enforced in Rust before the live
/// rebuild spec exists): every command in the shipped order scene is
/// UI-producible by hand — the exact multiset is 6 Place (kinds only in
/// {SOURCE, FACTORY, SINK}) + 1 AddPort (role Out, medium Mechanical, on the
/// splitter) + 5 DrawBelt (every run >= 2 cells) + 10 Dock + 6 Configure = 28
/// commands; no Undo/Redo/Delete/Rotate present.
#[test]
fn order_scene_vocabulary_is_ui_producible() {
    let cmds = order_commands();
    assert_eq!(cmds.len(), 28, "the scene is exactly 28 commands");

    let (mut places, mut addports, mut belts, mut docks, mut configs) = (0, 0, 0, 0, 0);
    for cmd in &cmds {
        match cmd {
            GridCommand::Place { kind, .. } => {
                assert!(
                    matches!(
                        *kind,
                        machine_kind::SOURCE | machine_kind::FACTORY | machine_kind::SINK
                    ),
                    "every placed kind is palette-producible (SOURCE/FACTORY/SINK), got {kind}"
                );
                places += 1;
            }
            GridCommand::AddPort {
                node,
                role,
                medium,
                ..
            } => {
                // The ONLY UI-producible AddPort is an Out (role 1) Mechanical
                // (medium 0) on a FACTORY - the Ports section "+ output".
                assert_eq!(*node, 1, "the one AddPort targets the splitter handle");
                assert_eq!(*role, 1, "role is Out (the only UI-addable role)");
                assert_eq!(*medium, 0, "medium is Mechanical (never Electrical)");
                addports += 1;
            }
            GridCommand::DrawBelt { cells } => {
                assert!(
                    cells.len() >= 2,
                    "every belt run is >= 2 cells (the breathing-room floor)"
                );
                belts += 1;
            }
            GridCommand::Dock { .. } => docks += 1,
            GridCommand::Configure { .. } => configs += 1,
            other => panic!(
                "non-UI-producible (or pointless) command in the shipped scene: {other:?} \
                 - the done-test rebuilds this scene BY HAND; Endpoint/wire/Undo/Redo/\
                 Delete/Rotate must not appear"
            ),
        }
    }
    assert_eq!(places, 6, "6 machines: 1 SOURCE + 3 FACTORYs + 2 SINKs");
    assert_eq!(addports, 1, "exactly one grown Out (the splitter's second corridor)");
    assert_eq!(belts, 5, "5 drawn belts");
    assert_eq!(docks, 10, "every belt end is docked (5 belts x 2 ends)");
    assert_eq!(configs, 6, "every machine is configured (1 Source + 3 Factory + 2 Sink)");
}
