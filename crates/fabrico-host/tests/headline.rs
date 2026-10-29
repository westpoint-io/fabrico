//! WUI-02 — the live headline acceptance test (the determinism capstone).
//!
//! This is the milestone's load-bearing e2e: it runs the whole request/response wire
//! LIVE through the REAL stack and then proves the recorded run replays byte-identical.
//!
//! - `headline_live_round_trip_and_replay` (WUI-02 crit 1+3): a REAL loopback
//!   `POST /endpoint/<the Route's path>` drives an HTTP Router whose handler factory (authored via
//!   the certified `GridCommand::Configure` edit-op, NOT a hardcoded fixture) BOTH
//!   replies to the caller (`Effect::Reply`, intercepted in the executor consumer) AND
//!   drops an item on its `Out`->belt to a downstream factory — the caller reads back
//!   the exact computed `{status, headers, body}` over HTTP. Then the live-recorded
//!   edit-log + event-log are read back from the host's `RedbStore` and replayed from
//!   genesis twice (`GridSession::replay_two_logs`); the two snapshots are byte-identical
//!   over a PROVEN-NON-EMPTY log (the 38-04 non-vacuity guard).
//! - `oversized_request_body_is_rejected` (threat T-40-06-BODY): the shipped
//!   reject-only, body-limited ingress refuses an oversized UNTRUSTED body without
//!   panic/hang — the ingress hardening is exercised, never weakened.
//!
//! # The determinism boundary (T-40-06-DET)
//! Every wall-clock / socket / network fact stays host-side: the sim sees ONLY the
//! logged `WireRequest` (request entered at tick T) and the `Effect::Reply` command
//! (reply emitted at a later tick). The socket write NEVER re-enters the core fold —
//! the byte-identical replay is the proof that no network fact leaked into the sim.
//!
//! # Both ways of minting the wire scaffold, and why the tests drive both
//! A FUNCTIONAL request/response wire (`Endpoint -> forward_wire -> Factory`) is minted
//! either through the core `add_wire` seam the goldens use (0023/0024) or by folding one
//! `EditOp::DrawWire` record, whose arm lives in `fabrico-core/src/tick.rs` as
//! `fold_draw_wire` (63-02). The `WireMint` enum below drives the SAME round-trip body
//! down both paths, and `folded_draw_wire_board_is_byte_identical_to_the_seeded_one`
//! compares two independently built boards' full snapshot bytes.
//!
//! # What plan 85-08 changed here
//! The shipped demo used to build its request pair through the core seam, and the
//! byte-identity test compared against that demo function. Since plan 85-08 the demo
//! places, configures and wires its pair with logged commands, so there is no demo seam
//! left to compare against. The PROPERTY the test proves is about the code, not the demo,
//! and it is kept: a board whose forward wire is minted by the core `add_wire` seam
//! (built here, in [`seam_board`]) is byte-identical to the same board with the forward
//! wire folded from a `DrawWire` record. What only described the deleted demo seam (that
//! the shipped board used it) is dropped. The HANDLER — the
//! behavior under test — is authored the certified way on both: a real
//! `GridCommand::Configure` swaps the genesis passthrough for the reply+belt handler,
//! landing a `Configure` record in the edit-log.
//! All traffic stays on `127.0.0.1` (loopback only this milestone).

use std::time::Duration;

use fabrico_command::GridSession;
use fabrico_core::core::Core;
use fabrico_core::edit::{EDIT_SCHEMA_VERSION, EditOp, EditRecord};
use fabrico_core::event::{DecodeError, EventPayload, LogHeader, SCHEMA_VERSION, StateInvariant};
use fabrico_core::ids::NodeId;
use fabrico_core::persist::{MAX_RECORD_BYTES, RedbStore};
use fabrico_core::snapshot::{restore, snapshot};
use fabrico_core::state::{Footprint, Medium, Node, Port, Role, Side};
use fabrico_host::demo_scene::DEMO_GENESIS_SEED;
use fabrico_host::config::HostConfig;
use fabrico_host::driver::Host;
use fabrico_host::ingress::endpoint::{EndpointIngress, ENDPOINT_INGRESS_CAPACITY};
use fabrico_host::ingress::webhook::{WEBHOOK_INGRESS_CAPACITY, webhook_router, Ingress};
use fabrico_host::ledger::DispatchLedger;
use fabrico_host::render_packet::RenderProducer;
use fabrico_host::sim_loop::{GestureSink, SimLoop, endpoint_route_key, gesture_channel};
use fabrico_protocol::{GridCommand, MachineConfig};
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use tokio::net::TcpListener;
use tokio::sync::mpsc::channel;

/// The fixed seed the whole run is stamped with (header + replay seed must match).
const SEED: u64 = 1;

/// A fixed always-Playing signal for the headline tests (the throwaway webhook door
/// is never paused; these exercise the endpoint round-trip / item-flow path).
fn playing() -> Arc<AtomicBool> {
    Arc::new(AtomicBool::new(true))
}

/// A real-time driver window long enough for a loopback POST (mint, wire hop, factory
/// reply, and the caller's read) plus the belt hop to the downstream collector.
const TICKS: u64 = 200;
const TICK_PAUSE: Duration = Duration::from_millis(5);

/// The genesis Factory JS: an inert passthrough that the certified `Configure` swaps
/// out for the real reply+belt handler before any request is driven.
const PASSTHROUGH_JS: &str = "export default function (input, ctx) {}";

/// The handler authored LIVE via `GridCommand::Configure`. Servicing a wire request it
/// does BOTH observable things in ONE tick:
///  - `ctx.emit(1, ...)` drops an item on its `Out`(port 1)->belt to the downstream
///    collector (drop-on-belt), and
///  - `ctx.command({status, headers, body}, 0)` is mapped by the 37-03 reply seam to an
///    `Effect::Reply { correlation, payload }` reverse-routed to the caller
///    (reply-to-caller). The payload is the canonical `{status, headers, body}`
///    descriptor the endpoint bridge decodes into the caller's HTTP response.
const REPLY_BELT_HANDLER_JS: &str = "export default function (input, ctx) { \
     ctx.emit(1, { belt: 1 }); \
     ctx.command({ status: 201, headers: { \"x-fab\": \"wire\" }, body: \"pong\" }, 0); \
     }";

fn header() -> LogHeader {
    LogHeader {
        schema_version: SCHEMA_VERSION,
        seed: SEED,
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

/// How a board's FORWARD wire (`Endpoint -> Factory`) is minted.
///
/// The two arms produce the SAME wire. That is the WIRE-01 claim, and
/// `folded_draw_wire_board_is_byte_identical_to_the_seeded_one` proves it on full
/// snapshot bytes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum WireMint {
    /// `GridState::add_wire` plus `GridState::link`, called directly from Rust. This is
    /// how the `0023/0024` goldens are seeded, and how every wire in the system was
    /// seeded before Phase 63 gave `EditOp::DrawWire` its fold.
    GenesisSeam,
    /// ONE `EditOp::DrawWire` record folded through `apply_edit` - the WIRE-01 path, and
    /// the path Phase 66's wire tool will drive.
    FoldedDrawWire,
}

/// A `DrawWire` edit record naming `(from, 0) -> (to, 0)`.
fn draw_wire_record(from: NodeId, to: NodeId) -> EditRecord {
    EditRecord {
        schema_version: EDIT_SCHEMA_VERSION,
        partition: 0,
        sequence: 0,
        tick: 0,
        action: 0,
        op: EditOp::DrawWire {
            from_node: from,
            from_port: 0,
            to_node: to,
            to_port: 0,
        },
    }
}

/// Mint the forward wire `from -> to` by `mint`, returning its `NodeId`.
fn mint_forward_wire(core: &mut Core, mint: WireMint, from: NodeId, to: NodeId) -> NodeId {
    let wire = match mint {
        WireMint::GenesisSeam => {
            let w = core.state.add_wire((from, 0), (to, 0));
            core.state.link((w, 0), (to, 0)); // forwards into the target's inbox
            w
        }
        WireMint::FoldedDrawWire => {
            core.advance_edits(&[draw_wire_record(from, to)], &[]);
            *core
                .last_tick
                .placed
                .last()
                .expect("the DrawWire fold minted a wire and recorded its id")
        }
    };
    assert!(
        matches!(core.state.node(wire), Some(Node::Wire(_))),
        "{mint:?} minted a Node::Wire"
    );
    wire
}

/// The FUNCTIONAL headline topology:
///
/// ```text
///   Endpoint --forward_wire--> Factory --(Out port 1)--> belt --> collector
/// ```
///
/// The Endpoint is the POST target AND the request's `return_addr`; the forward wire is
/// its entry wire (`from.node == endpoint`), so a minted `WireRequest` hops into the
/// Factory. The Factory's reply resolves the caller's socket through the executor
/// consumer's `Effect::Reply` arm; its `Out`->belt emit lands at the collector.
///
/// `mint` selects how the forward wire is built. Everything downstream is identical,
/// which is the point: the live round-trip runs unchanged over a hand-drawn wire.
///
/// Returns `(host, endpoint, factory, collector)`; the caller keeps the `TempDir` alive
/// (the redb store lives under it). The Factory carries the inert passthrough — the live
/// `Configure` installs the real handler.
fn genesis_host(dir: &std::path::Path, mint: WireMint) -> (Host, NodeId, NodeId, NodeId) {
    let mut core = Core::genesis(header());
    let ep = core.state.add_endpoint();
    let factory = core.state.add_factory(PASSTHROUGH_JS.to_owned(), 256, 7);
    // THE HANDLER DECLARES AN ELECTRICAL In AT PORT 0, as every HTTP Handler does. After
    // phase 72 that declaration is what
    // makes a delivery a WIRE REQUEST (D-16): `add_factory` inserts an inbox and NO
    // ports, a port-less node reads MECHANICAL (`admit::inbox_class` clause 3), and an
    // unserviced handler never replies, so the loopback POST below would simply TIME
    // OUT. A board that wants its own code called must say so on the board.
    core.state.set_ports(
        factory,
        vec![Port {
            local_offset: (0, 0),
            side: Side::W,
            role: Role::In,
            medium: Medium::Electrical,
        }],
    );
    mint_forward_wire(&mut core, mint, ep, factory); // entry (from.node == ep)
    // The belt lane: the Factory's Out (port 1) drops onto a 1-tile belt to a collector.
    let belt = core.state.add_belt(1);
    let collector = core.state.add_source();
    core.state.link((factory, 1), (belt, 0)); // Factory Out -> belt (tail)
    core.state.link((belt, 0), (collector, 0)); // belt -> collector inbox (port 0)

    let store = RedbStore::open(dir.join("log.redb")).expect("open log");
    let ledger = DispatchLedger::open(dir.join("ledger.redb")).expect("open ledger");
    (
        Host::new(core, store, ledger, None).expect("open host"),
        ep,
        factory,
        collector,
    )
}

/// True once the downstream collector's port-0 inbox holds the belt-dropped item (a
/// read-only clone+take, so the live core is untouched).
fn collector_received(sim: &SimLoop, collector: NodeId) -> bool {
    sim.host()
        .core()
        .state
        .inbox_of(collector)
        .map(|ib| ib.clone().take(0).is_some())
        .unwrap_or(false)
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

/// WUI-02 crit 1+3 — the live headline: a REAL loopback POST drives the real ingress ->
/// HTTP Router -> a `Configure`-authored handler that replies to the caller AND drops on
/// its Out->belt; then the recorded log replays byte-identical from genesis over a
/// proven-non-empty log.
#[test]
fn headline_live_round_trip_and_replay() {
    live_round_trip_and_replay(WireMint::GenesisSeam);
}

/// WIRE-01 — the SAME live round-trip, over a wire minted by folding an
/// `EditOp::DrawWire` instead of by the genesis `add_wire` seam. A real loopback POST
/// enters the endpoint, travels the HAND-DRAWN wire, reaches the handler, and the
/// handler's computed reply reaches the caller.
///
/// This drives the identical harness rather than a second driver: if the drawn wire
/// carried requests differently in any observable way, this call would fail where the
/// seeded one passes.
#[test]
fn headline_round_trip_over_a_hand_drawn_wire() {
    live_round_trip_and_replay(WireMint::FoldedDrawWire);
}

/// The live round-trip body, run once per [`WireMint`].
fn live_round_trip_and_replay(mint: WireMint) {
    let rt = rt();
    let dir = tempfile::tempdir().expect("tempdir");
    let (host, ep, factory, collector) = genesis_host(dir.path(), mint);
    let label = ep_key(host.core(), ep);
    let (endpoint_tx, endpoint_rx) = channel::<EndpointIngress>(ENDPOINT_INGRESS_CAPACITY);
    let (gtx, grx) = gesture_channel();
    let mut sim = SimLoop::new(host, RenderProducer::new(), rt.handle(), cfg(), grx)
        .with_endpoint(endpoint_rx);

    // The genesis Endpoint is seeded into the LIVE route table by SimLoop::new (ENDP-05).
    let routes_rx = sim.routes_receiver();
    assert_eq!(
        routes_rx.borrow().get(&label),
        Some(&ep),
        "the Route's key is live at construction (endpoint seeding)"
    );

    // Tick once so the render producer assigns the genesis Factory a dense handle, then
    // AUTHOR the reply+belt handler through the certified `GridCommand::Configure` edit-op
    // (NOT a hardcoded fixture) and fold it — the Configure lands in the edit-log.
    sim.run(Some(1), TICK_PAUSE).expect("assign handles");
    let factory_handle = sim
        .handle_for_node(factory)
        .expect("the genesis factory has a render handle after one tick");
    gtx.send_gesture(GridCommand::Configure {
        node: factory_handle,
        config: MachineConfig::Factory {
            source: REPLY_BELT_HANDLER_JS.to_owned(),
        },
    })
    .expect("send Configure gesture");
    sim.run(Some(1), TICK_PAUSE).expect("fold the Configure");

    // Bind a REAL loopback listener serving the shared webhook+endpoint router with the
    // SHIPPED body limit (MAX_RECORD_BYTES) — one server, both routes.
    let listener = rt
        .block_on(async { TcpListener::bind("127.0.0.1:0").await })
        .expect("bind loopback");
    let addr = listener.local_addr().expect("local addr");
    let (web_tx, _web_rx) = channel::<Ingress>(WEBHOOK_INGRESS_CAPACITY);
    let app = webhook_router(routes_rx, web_tx, endpoint_tx, MAX_RECORD_BYTES, playing());
    let server = rt.spawn(async move {
        axum::serve(listener, app).await.expect("serve");
    });

    // Drive a REAL loopback POST; capture the caller's response back over a std channel.
    let (resp_tx, resp_rx) = std::sync::mpsc::channel();
    let url = format!("http://{addr}/endpoint{label}");
    rt.spawn(async move {
        tokio::time::sleep(Duration::from_millis(30)).await;
        let client = reqwest::Client::new();
        let r = client
            .post(&url)
            .body("{\"n\":1}")
            .send()
            .await
            .expect("POST sent");
        let status = r.status().as_u16();
        let hv = r
            .headers()
            .get("x-fab")
            .map(|v| v.to_str().expect("header utf-8").to_string());
        let body = r.text().await.expect("read body");
        let _ = resp_tx.send((status, hv, body));
    });

    // Drain + mint + wire-hop + factory reply + belt hop. No reg.resolve seam here: the
    // reply comes from the REAL Configure-authored handler through the executor consumer.
    sim.run(Some(TICKS), TICK_PAUSE).expect("drive the live round-trip");
    server.abort();

    // (1) reply-to-caller: the caller received the EXACT computed descriptor over HTTP.
    let (status, hv, body) = resp_rx
        .recv_timeout(Duration::from_secs(10))
        .expect("the caller received a response over loopback");
    assert_eq!(status, 201, "the handler-computed status reaches the caller (WUI-02)");
    assert_eq!(
        hv.as_deref(),
        Some("wire"),
        "the handler-computed header reaches the caller (WUI-02)"
    );
    assert_eq!(body, "pong", "the handler-computed body reaches the caller (WUI-02)");
    assert_eq!(
        wire_requests(&sim),
        1,
        "the endpoint hit minted exactly one WireRequest (never a ManualInject)"
    );

    // (2) drop-on-belt: the SAME handler tick dropped an item on its Out->belt, which the
    // downstream collector received — reply AND belt drop are both observable.
    assert!(
        collector_received(&sim, collector),
        "the handler dropped an item on its Out->belt to the downstream collector"
    );

    // (3) WUI-02 crit 3 — byte-identical replay from genesis over a NON-EMPTY log.
    // Read back the live run's recorded edit-log + event-log from the host's RedbStore
    // and replay from genesis twice; the two snapshots must be byte-identical.
    //
    // Non-vacuity guard (the 38-04 lesson, MANDATORY): assert BOTH recorded logs are
    // non-empty BEFORE the byte-identity assertion, so a byte-identical replay cannot
    // pass by construction over an empty log. The edit-log carries the live Configure;
    // the event-log carries the minted WireRequest.
    let edits = sim.host().logged_edits().expect("read edit log");
    let events = sim.host().logged_events().expect("read event log");
    assert!(
        !edits.is_empty(),
        "non-vacuity (38-04): the recorded edit-log is non-empty (the Configure landed)"
    );
    assert!(
        !events.is_empty(),
        "non-vacuity (38-04): the recorded event-log is non-empty (the WireRequest landed)"
    );
    let a = GridSession::replay_two_logs(SEED, &edits, &events);
    let b = GridSession::replay_two_logs(SEED, &edits, &events);
    assert_eq!(
        snapshot(a.core()),
        snapshot(b.core()),
        "replay-from-genesis is a byte-identical deterministic re-fold (WUI-02 crit 3)"
    );
}

/// The four nodes of a seam-built request pair, as [`seam_board`] returns them.
struct SeamPair {
    endpoint: NodeId,
    factory: NodeId,
    forward: NodeId,
    return_wire: NodeId,
}

/// A request pair built entirely through the core seam: a 1x1 Endpoint, a 1x1 handler
/// Factory with an electrical In (port 0) and Out (port 1), the FORWARD wire by `add_wire`
/// plus `link`, and the RETURN wire by `add_wire` alone. This is the shape the shipped demo
/// carried until plan 85-08; it is built here so the byte-identity test below compares the
/// two ways of minting a wire on one board shape, with nothing taken from the demo.
fn seam_board(core: &mut Core) -> SeamPair {
    let endpoint = core.state.add_endpoint();
    core.state.claim_footprint(endpoint, (10, 6), 1, 1, 0);
    core.state.set_cell(endpoint, (10, 6));
    core.state.set_ports(
        endpoint,
        vec![Port {
            local_offset: (0, 0),
            side: Side::E,
            role: Role::Out,
            medium: Medium::Electrical,
        }],
    );
    let factory = core
        .state
        .add_factory(REPLY_BELT_HANDLER_JS.to_owned(), 256, DEMO_GENESIS_SEED);
    core.state.claim_footprint(factory, (14, 6), 1, 1, 0);
    core.state.set_cell(factory, (14, 6));
    core.state.set_ports(
        factory,
        vec![
            Port {
                local_offset: (0, 0),
                side: Side::W,
                role: Role::In,
                medium: Medium::Electrical,
            },
            Port {
                local_offset: (0, 0),
                side: Side::E,
                role: Role::Out,
                medium: Medium::Electrical,
            },
        ],
    );
    let forward = core.state.add_wire((endpoint, 0), (factory, 0));
    core.state.link((forward, 0), (factory, 0));
    let return_wire = core.state.add_wire((factory, 1), (endpoint, 0));
    SeamPair {
        endpoint,
        factory,
        forward,
        return_wire,
    }
}

/// WIRE-01 — the cross-crate half of the indistinguishability proof: a board whose forward
/// wire was minted by folding an `EditOp::DrawWire` is BYTE-IDENTICAL to the same board
/// with the forward wire minted by the core seam ([`seam_board`]).
///
/// Board A is [`seam_board`] verbatim. Board B replicates the endpoint and the factory from
/// board A's own observed values (cell, footprint, ports, JS source, gas budget), then mints
/// the forward wire by FOLDING a `DrawWire` record and the return wire the way the seam
/// does. The seam's two wires are deliberately NOT symmetric - the forward one gets
/// `add_wire` plus `link`, the return one gets `add_wire` alone - so board B reproduces that
/// asymmetry rather than making both wires the same.
///
/// The comparison is FULL snapshot bytes, not a selected field set. Node ids are part of
/// those bytes, so the two builds are made to allocate in the same order rather than the
/// comparison being weakened: an id that differs is a real difference and catching one is
/// the test's value.
#[test]
fn folded_draw_wire_board_is_byte_identical_to_the_seeded_one() {
    // Board A: the seam, then one empty tick so both boards sit at tick 1.
    let mut a = Core::genesis(header());
    let seeded = seam_board(&mut a);
    a.advance_edits(&[], &[]);

    // Read the seam's own values off board A, so board B mirrors whatever the seam built
    // rather than a second copy of its literals.
    let ep_cell = a.state.cell_of(seeded.endpoint).expect("the endpoint has a cell");
    // `footprint_of` yields None for the faithful 1x1-rot0 default (an absent entry IS
    // 1x1 rot0). Replicating through the same default keeps board B from writing a
    // footprints entry board A does not have.
    let ep_foot = a
        .state
        .footprint_of(seeded.endpoint)
        .unwrap_or(Footprint { w: 1, h: 1, rot: 0 });
    let ep_ports = a
        .state
        .ports_of(seeded.endpoint)
        .expect("the endpoint declares ports")
        .to_vec();
    let fac_cell = a.state.cell_of(seeded.factory).expect("the factory has a cell");
    let fac_foot = a
        .state
        .footprint_of(seeded.factory)
        .unwrap_or(Footprint { w: 1, h: 1, rot: 0 });
    let fac_ports = a
        .state
        .ports_of(seeded.factory)
        .expect("the factory declares ports")
        .to_vec();
    let (fac_js, fac_gas) = match a.state.node(seeded.factory) {
        Some(Node::Factory(f)) => (f.source.clone(), f.gas_budget),
        other => panic!("the seam's handler is a Factory, got {other:?}"),
    };

    // Board B: the same two machines, in the same allocation order, then the forward
    // wire minted by FOLDING one DrawWire record.
    let mut b = Core::genesis(header());
    let ep_b = b.state.add_endpoint();
    b.state
        .claim_footprint(ep_b, ep_cell, ep_foot.w, ep_foot.h, ep_foot.rot);
    b.state.set_cell(ep_b, ep_cell);
    b.state.set_ports(ep_b, ep_ports);
    let fac_b = b.state.add_factory(fac_js, fac_gas, DEMO_GENESIS_SEED);
    b.state
        .claim_footprint(fac_b, fac_cell, fac_foot.w, fac_foot.h, fac_foot.rot);
    b.state.set_cell(fac_b, fac_cell);
    b.state.set_ports(fac_b, fac_ports);
    // The FORWARD wire, hand-drawn. This is the one and only difference between the
    // two boards, and it also supplies the empty-tick parity board A took above.
    let drawn = mint_forward_wire(&mut b, WireMint::FoldedDrawWire, ep_b, fac_b);
    // The RETURN wire, the seam's way: `add_wire` with NO link (the reply
    // reverse-transports, it does not route out of the wire's port 0). Its source port is
    // read off board A's own live `WireLink`, so board B stays a mirror of the seam.
    let return_from_port = match a.state.node(seeded.return_wire) {
        Some(Node::Wire(link)) => link.from.1,
        other => panic!("the seam's return wire is a Node::Wire, got {other:?}"),
    };
    let return_b = b.state.add_wire((fac_b, return_from_port), (ep_b, 0));

    assert_eq!(
        (ep_b, fac_b, drawn, return_b),
        (
            seeded.endpoint,
            seeded.factory,
            seeded.forward,
            seeded.return_wire
        ),
        "both boards allocated the same four NodeIds, in the same order"
    );
    assert_eq!(
        snapshot(&b),
        snapshot(&a),
        "a hand-drawn wire is byte-identical to the same wire minted by the core seam"
    );
}

/// WIRE-01 — a board carrying a hand-drawn wire survives a snapshot round trip, and the
/// gate that lets it through is proved to still bite.
///
/// Snapshot invariant 8 rejects a wire whose endpoints are not live
/// (`StateInvariant::DanglingWireEndpoint`). A restore that accepted everything would
/// pass the first half of this test, so the second half mutates the same board to
/// carry a dangling wire endpoint and asserts it is REFUSED.
#[test]
fn hand_drawn_wire_board_survives_snapshot_restore() {
    let dir = tempfile::tempdir().expect("tempdir");
    let (host, _ep, _factory, _collector) = genesis_host(dir.path(), WireMint::FoldedDrawWire);
    let bytes = snapshot(host.core());

    let restored = restore(&bytes).expect("a board with a live hand-drawn wire restores");
    assert_eq!(
        snapshot(&restored),
        bytes,
        "the restored board re-serializes to the same bytes"
    );

    // Now break it the one way invariant 8 exists to catch: re-point the drawn wire's
    // target at a node that is not live, and assert the SAME restore refuses it.
    let mut broken = restore(&bytes).expect("restore the board again to mutate it");
    let ghost = {
        let doomed = broken.state.add_source();
        broken.state.remove_node(doomed);
        doomed
    };
    let wire = broken
        .state
        .node_ids()
        .find(|&id| matches!(broken.state.node(id), Some(Node::Wire(_))))
        .expect("the board carries a wire");
    match broken.state.node_mut(wire) {
        Some(Node::Wire(w)) => w.to = (ghost, 0),
        other => panic!("expected the wire node, got {other:?}"),
    }
    assert!(
        matches!(
            restore(&snapshot(&broken)),
            Err(DecodeError::InvalidState(StateInvariant::DanglingWireEndpoint))
        ),
        "invariant 8 still bites, so the accept above is not a restore that accepts everything"
    );
}

/// Threat T-40-06-BODY — the shipped reject-only, body-limited ingress refuses an
/// oversized UNTRUSTED body without panic/hang. Drives a REAL loopback POST of a body
/// over `MAX_RECORD_BYTES` and asserts the caller gets a rejection (not a hang, not a
/// buffered accept) — the ingress hardening is exercised, never weakened by the headline.
#[test]
fn oversized_request_body_is_rejected() {
    let rt = rt();
    let dir = tempfile::tempdir().expect("tempdir");
    let (host, ep, _factory, _collector) = genesis_host(dir.path(), WireMint::GenesisSeam);
    let label = ep_key(host.core(), ep);
    let (endpoint_tx, endpoint_rx) = channel::<EndpointIngress>(ENDPOINT_INGRESS_CAPACITY);
    let (_gtx, grx) = gesture_channel();
    let sim = SimLoop::new(host, RenderProducer::new(), rt.handle(), cfg(), grx)
        .with_endpoint(endpoint_rx);
    let routes_rx = sim.routes_receiver();

    let listener = rt
        .block_on(async { TcpListener::bind("127.0.0.1:0").await })
        .expect("bind loopback");
    let addr = listener.local_addr().expect("local addr");
    let (web_tx, _web_rx) = channel::<Ingress>(WEBHOOK_INGRESS_CAPACITY);
    let app = webhook_router(routes_rx, web_tx, endpoint_tx, MAX_RECORD_BYTES, playing());
    let server = rt.spawn(async move {
        axum::serve(listener, app).await.expect("serve");
    });

    // A body strictly over the shipped limit — the RequestBodyLimitLayer must reject it.
    // A valid rejection is EITHER a 4xx status (413/400) OR a transport-level refusal
    // (the layer resets the connection mid-stream → a body-write / broken-pipe error).
    // Both are "reject-only, no panic/OOM/hang"; only a HANG (timeout) or an ACCEPT
    // (2xx) would be a hardening regression. A short client timeout makes a hang a
    // distinguishable, failing outcome rather than an indefinite block.
    let oversized = vec![b'x'; MAX_RECORD_BYTES + 1];
    let url = format!("http://{addr}/endpoint{label}");
    let outcome = rt.block_on(async move {
        tokio::time::sleep(Duration::from_millis(30)).await;
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(8))
            .build()
            .expect("build client");
        client.post(&url).body(oversized).send().await
    });
    server.abort();

    match outcome {
        Ok(resp) => {
            let status = resp.status().as_u16();
            assert!(
                status >= 400,
                "an over-limit body must be rejected, never accepted (got {status})"
            );
        }
        Err(err) => {
            assert!(
                !err.is_timeout(),
                "the ingress must reject an over-limit body promptly, never hang: {err}"
            );
            // A non-timeout transport error (connection reset / broken pipe) is the
            // body-limit layer refusing the stream — a valid reject-only outcome.
        }
    }
}
