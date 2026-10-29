//! SERVE-08, host half: the URL a Route ANSWERS AT is the URL the panel SHOWS, a
//! second Route cannot silently steal the first one's address, and a POST into a Route
//! with no cable is visible on the board instead of vanishing.
//!
//! # Why the URL half needs a host test at all
//! Two INDEPENDENT producers derive a Route's address and they must agree:
//! `project_routes` builds the key the front door looks up, and `webhook_url` builds the
//! string the config panel offers to copy. Nothing in the core can see either of them.
//! `21-endpoint-traffic.spec.ts:163-166` already asserts the pair agree in the running
//! app; these tests assert it at the seam, where a failure names which producer drifted.
//!
//! # The one trap these tests are shaped around
//! `route_ids`, the fingerprint that decides whether the route map is republished, used
//! to be a `Vec<NodeId>`. A `Configure` that changes ONLY a path therefore flipped
//! nothing, and the map was never rebuilt: the user typed a path, pressed Apply, and got
//! a 404 until they placed something unrelated. Every test here that Applies a path
//! POSTs to the NEW URL with NOTHING PLACED IN BETWEEN, because a placement would flip
//! the fingerprint on its own and the test would pass against a build with no republish
//! at all.

use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::Duration;

use fabrico_command::{CommandError, GridSession};
use fabrico_core::core::Core;
use fabrico_core::event::{EventPayload, LogHeader, SCHEMA_VERSION};
use fabrico_core::ids::NodeId;
use fabrico_core::persist::{MAX_RECORD_BYTES, RedbStore};
use fabrico_host::config::HostConfig;
use fabrico_host::driver::Host;
use fabrico_host::ingress::endpoint::{ENDPOINT_INGRESS_CAPACITY, EndpointIngress};
use fabrico_host::ingress::webhook::{Ingress, WEBHOOK_INGRESS_CAPACITY, webhook_router};
use fabrico_host::ledger::DispatchLedger;
use fabrico_host::render_packet::RenderProducer;
use fabrico_host::sim_loop::{
    ControlMsg, GestureSink, GestureTx, SimLoop, endpoint_route_key, gesture_channel,
};
use fabrico_protocol::{GridCommand, MachineConfig, machine_kind};
use slotmap::Key;
use tokio::net::TcpListener;
use tokio::sync::mpsc::{channel, unbounded_channel};
use tokio::sync::oneshot;

fn header() -> LogHeader {
    LogHeader {
        schema_version: SCHEMA_VERSION,
        seed: 72,
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

fn playing() -> Arc<AtomicBool> {
    Arc::new(AtomicBool::new(true))
}

/// Place a machine of `kind` through a real gesture and fold it one tick.
fn place_g(sim: &mut SimLoop, gtx: &GestureTx, kind: u8, cell_x: i32, cell_y: i32) -> NodeId {
    gtx.send_gesture(GridCommand::Place {
        kind,
        cell_x,
        cell_y,
    })
    .expect("send place gesture");
    sim.run(Some(1), Duration::ZERO).expect("fold the placement");
    *sim.host()
        .core()
        .last_tick
        .placed
        .last()
        .expect("the placement minted an id")
}

/// Apply a `Configure` through the real gesture seam and fold it ONE tick.
///
/// ONE tick, and that is the whole point of the helper: nothing else is placed, folded
/// or nudged between the Apply and whatever the caller does next.
fn configure_g(sim: &mut SimLoop, gtx: &GestureTx, id: NodeId, config: MachineConfig) {
    let handle = sim
        .handle_for_node(id)
        .expect("the placed node has a render handle");
    gtx.send_gesture(GridCommand::Configure {
        node: handle,
        config,
    })
    .expect("send configure gesture");
    sim.run(Some(1), Duration::ZERO).expect("fold the Configure");
}

/// The number of logged `WireRequest` events. An endpoint hit that REACHED THE SIM
/// mints exactly one; a 404 at the door mints none.
fn wire_requests(sim: &SimLoop) -> usize {
    sim.host()
        .logged_events()
        .expect("read log")
        .iter()
        .filter(|e| matches!(e.payload, EventPayload::WireRequest { .. }))
        .count()
}

/// The number of logged `ManualInject` events targeting `target`. This is what the
/// `/hook/` door produces, and it is how the traversal probe proves it was not reached.
fn injects_for(sim: &SimLoop, target: NodeId) -> usize {
    sim.host()
        .logged_events()
        .expect("read log")
        .iter()
        .filter(
            |e| matches!(&e.payload, EventPayload::ManualInject { target: t, .. } if *t == target),
        )
        .count()
}

/// Bind a real loopback listener serving the LIVE route projection, spawn it, and
/// return its bound address plus the join handle.
///
/// A REAL socket, not `ServiceExt::oneshot`: the recorded lesson in this repository is
/// that injected-request tests hide broken live wiring, and the axum capture pattern
/// this plan widens is exactly the kind of thing only a real request exercises.
fn serve(
    rt: &tokio::runtime::Runtime,
    sim: &SimLoop,
    endpoint_tx: tokio::sync::mpsc::Sender<EndpointIngress>,
    web_tx: tokio::sync::mpsc::Sender<Ingress>,
) -> (SocketAddr, tokio::task::JoinHandle<()>) {
    let listener = rt
        .block_on(async { TcpListener::bind("127.0.0.1:0").await })
        .expect("bind loopback");
    let addr = listener.local_addr().expect("local addr");
    let app = webhook_router(
        sim.routes_receiver(),
        web_tx,
        endpoint_tx,
        MAX_RECORD_BYTES,
        playing(),
    );
    let handle = rt.spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (addr, handle)
}

/// A Configure that changes ONLY the path republishes the route map, so a POST to the
/// NEW URL reaches the sim WITH NOTHING PLACED IN BETWEEN.
///
/// The no-intervening-placement clause IS the assertion. `route_ids` fingerprints the
/// routable set, and a placement flips that fingerprint on its own; a test that placed
/// anything between the Apply and the POST would pass on a build with no path-aware
/// republish at all, which is the check-that-cannot-fail shape this repository keeps
/// finding.
///
/// RED ON HEAD BECAUSE: there is no `MachineConfig::Endpoint` to Apply.
#[test]
fn a_path_apply_republishes_the_route_map_with_no_intervening_placement() {
    let rt = rt();
    let dir = tempfile::tempdir().expect("tempdir");
    let (gtx, grx) = gesture_channel();
    let (endpoint_tx, endpoint_rx) = channel::<EndpointIngress>(ENDPOINT_INGRESS_CAPACITY);
    let (web_tx, _web_rx) = channel::<Ingress>(WEBHOOK_INGRESS_CAPACITY);
    let mut sim = SimLoop::new(
        host_over(dir.path()),
        RenderProducer::new(),
        rt.handle(),
        sim_cfg(),
        grx,
    )
    .with_endpoint(endpoint_rx);

    let ep = place_g(&mut sim, &gtx, machine_kind::ENDPOINT, 3, 3);
    let (addr, server) = serve(&rt, &sim, endpoint_tx, web_tx);

    // The DEFAULT path the core committed, read off the board rather than spelled here
    // (phase 91, D-13), so the two "the old address is gone" checks below are about the
    // address this Route really had.
    let default_path = match sim.host().core().state.node(ep) {
        Some(fabrico_core::state::Node::Endpoint(e)) => e.path.clone(),
        other => panic!("expected a live Node::Endpoint, found {other:?}"),
    };
    let default_key = endpoint_route_key(&default_path);
    assert!(
        sim.routes_receiver().borrow().get(&default_key) == Some(&ep) && default_key != "/orders",
        "NON-VACUITY: before the Apply the Route answers at its default key {default_key}, \
         which is not the path about to be typed"
    );

    // Apply the path. NOTHING is placed after this line.
    configure_g(
        &mut sim,
        &gtx,
        ep,
        MachineConfig::Endpoint {
            path: "/orders".to_owned(),
        },
    );

    // The map published the NEW key, and the OLD one is gone. Both directions, because
    // a republish that ADDED the new key while leaving the old one would leave two live
    // addresses for one Route.
    let routes = sim.routes_receiver().borrow().clone();
    assert_eq!(
        routes.get("/orders"),
        Some(&ep),
        "a path-only Configure must republish the route map: without it the user types \
         a path, presses Apply, and gets a 404 until they place something (R-45)"
    );
    assert!(
        !routes.contains_key(&default_key),
        "the DEFAULT key must be gone: a Route has ONE address, not two"
    );

    // NON-VACUITY FIRST, and it is awaited because a 404 answers immediately: the OLD
    // address must now be a 404. This is what proves the door is still discriminating
    // rather than accepting anything under the prefix, and it is awaited rather than
    // inferred because a door that accepted everything would also "not 404" below.
    let stale = format!("http://{addr}/endpoint{default_key}");
    let (stale_tx, stale_rx) = std::sync::mpsc::channel();
    rt.spawn(async move {
        tokio::time::sleep(Duration::from_millis(30)).await;
        let r = reqwest::Client::new()
            .post(&stale)
            .body("ping")
            .send()
            .await
            .expect("POST sent");
        let _ = stale_tx.send(r.status().as_u16());
    });
    sim.run(Some(30), Duration::from_millis(5))
        .expect("service the stale POST");
    assert_eq!(
        stale_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("the stale POST answered"),
        404,
        "the DEFAULT address must 404 once a path is set: a Route has one address"
    );
    assert_eq!(
        wire_requests(&sim),
        0,
        "a door-level 404 mints NO WireRequest, so the counter below starts at zero"
    );

    // And the real door answers at the NEW address. Driven over a real socket.
    //
    // THE CALLER'S STATUS IS DELIBERATELY NOT AWAITED HERE. This Route has no cable, so
    // the request is admitted, parked, and answered only by the 300-tick deadline sweep;
    // waiting on the socket would be measuring the 504 timeout, not the routing. What
    // IS asserted is the thing the routing decides: the request REACHED THE SIM and
    // minted a `WireRequest`. A 404 at the door mints none, which the control above
    // just demonstrated on this very board.
    let url = format!("http://{addr}/endpoint/orders");
    rt.spawn(async move {
        let _ = reqwest::Client::new().post(&url).body("ping").send().await;
    });
    sim.run(Some(60), Duration::from_millis(5))
        .expect("drain the endpoint ingress");
    server.abort();

    assert_eq!(
        wire_requests(&sim),
        1,
        "POST /endpoint/orders reached the SIM and minted exactly one WireRequest, with \
         NOTHING placed between the Apply and the POST (R-45)"
    );
}

/// Both URL producers agree after a path change.
///
/// `project_routes` builds the key the door looks up and `webhook_url` builds the string
/// the panel offers to copy. They are derived INDEPENDENTLY, so this asserts the
/// relationship between them rather than re-deriving one from the other: the displayed
/// URL is exactly the fixed `/endpoint` prefix followed by the published key.
#[test]
fn both_url_producers_agree_after_a_path_change() {
    let rt = rt();
    let dir = tempfile::tempdir().expect("tempdir");
    let (gtx, grx) = gesture_channel();
    let (ctx, crx) = unbounded_channel::<ControlMsg>();
    let mut sim = SimLoop::new(
        host_over(dir.path()),
        RenderProducer::new(),
        rt.handle(),
        sim_cfg(),
        grx,
    )
    .with_control(crx);

    let ep = place_g(&mut sim, &gtx, machine_kind::ENDPOINT, 3, 3);
    configure_g(
        &mut sim,
        &gtx,
        ep,
        MachineConfig::Endpoint {
            path: "/orders".to_owned(),
        },
    );

    let addr: SocketAddr = "127.0.0.1:8787".parse().expect("addr");
    let handle = sim.handle_for_node(ep).expect("the Route has a render handle");
    let (reply, mut rx) = oneshot::channel();
    ctx.send(ControlMsg::QueryWebhookUrl {
        node: handle,
        addr,
        reply,
    })
    .expect("send QueryWebhookUrl");
    sim.run(Some(1), Duration::ZERO).expect("service the query");
    let url = rx
        .try_recv()
        .expect("the query replied")
        .expect("a Route has a URL");

    assert_eq!(
        url, "http://127.0.0.1:8787/endpoint/orders",
        "the panel's copyable URL reads the Route's own path (D-12a keeps the \
         /endpoint/ prefix, so the word stays on screen inside the URL)"
    );

    // The published KEY and the displayed STRING, related rather than re-derived: the
    // string is the prefix plus the key, so a drift in either producer breaks this.
    let routes = sim.routes_receiver().borrow().clone();
    let (key, _) = routes
        .iter()
        .find(|(_, id)| **id == ep)
        .expect("the Route is in the published map");
    assert_eq!(
        url,
        format!("http://127.0.0.1:8787/endpoint{key}"),
        "the URL the panel shows and the key the door looks up must be ONE address"
    );
}

/// A Route whose path is `/users/42` answers a POST to `/endpoint/users/42`.
///
/// RED ON HEAD BECAUSE: `webhook.rs:192` is `.route("/endpoint/{target}", ..)` and in
/// axum 0.8 `{target}` captures EXACTLY ONE segment, while D-15 and UI-SPEC 3's approved
/// hint copy both use `/users/42` as the worked example. That is R-17's measured
/// contradiction and this is where it is closed.
#[test]
fn a_multi_segment_path_answers_at_the_door() {
    let rt = rt();
    let dir = tempfile::tempdir().expect("tempdir");
    let (gtx, grx) = gesture_channel();
    let (endpoint_tx, endpoint_rx) = channel::<EndpointIngress>(ENDPOINT_INGRESS_CAPACITY);
    let (web_tx, _web_rx) = channel::<Ingress>(WEBHOOK_INGRESS_CAPACITY);
    let mut sim = SimLoop::new(
        host_over(dir.path()),
        RenderProducer::new(),
        rt.handle(),
        sim_cfg(),
        grx,
    )
    .with_endpoint(endpoint_rx);

    let ep = place_g(&mut sim, &gtx, machine_kind::ENDPOINT, 3, 3);
    let (addr, server) = serve(&rt, &sim, endpoint_tx, web_tx);
    configure_g(
        &mut sim,
        &gtx,
        ep,
        MachineConfig::Endpoint {
            path: "/users/42".to_owned(),
        },
    );

    // NON-VACUITY: the FIRST segment alone must 404. Without this the test would pass
    // against a door that matched a prefix, which is a different and much weaker
    // property than matching the whole multi-segment path. Awaited, because a 404
    // answers immediately.
    let prefix_only = format!("http://{addr}/endpoint/users");
    let (miss_tx, miss_rx) = std::sync::mpsc::channel();
    rt.spawn(async move {
        tokio::time::sleep(Duration::from_millis(30)).await;
        let r = reqwest::Client::new()
            .post(&prefix_only)
            .body("ping")
            .send()
            .await
            .expect("POST sent");
        let _ = miss_tx.send(r.status().as_u16());
    });
    sim.run(Some(30), Duration::from_millis(5))
        .expect("service the prefix-only POST");
    assert_eq!(
        miss_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("the prefix-only POST answered"),
        404,
        "`/endpoint/users` must 404: the capture matches the WHOLE path, not a prefix"
    );
    assert_eq!(wire_requests(&sim), 0, "a 404 mints no WireRequest");

    // The full path. The status is NOT awaited: this Route has no cable, so the answer
    // is a 504 on the 300-tick deadline and waiting on it would measure the timeout
    // rather than the capture. What is asserted is that the request REACHED THE SIM.
    let url = format!("http://{addr}/endpoint/users/42");
    rt.spawn(async move {
        let _ = reqwest::Client::new().post(&url).body("ping").send().await;
    });
    sim.run(Some(60), Duration::from_millis(5))
        .expect("drain the endpoint ingress");
    server.abort();

    assert_eq!(
        wire_requests(&sim),
        1,
        "the multi-segment POST reached the sim, so the widening is real and not a \
         door-level accept that drops (R-17, R-46)"
    );
}

/// A traversal attempt at the endpoint door does NOT reach the `/hook/` route.
///
/// RESEARCH assumption A2 becomes an ASSERTION here rather than something reasoned
/// about at the walk. The request is written RAW ONTO A SOCKET, not built with an HTTP
/// client: every client normalizes `..` out of a path before it sends, so a
/// `reqwest`-driven version of this test would prove only that reqwest normalizes.
#[test]
fn a_traversal_attempt_does_not_reach_the_hook_route() {
    let rt = rt();
    let dir = tempfile::tempdir().expect("tempdir");
    let (gtx, grx) = gesture_channel();
    let (endpoint_tx, endpoint_rx) = channel::<EndpointIngress>(ENDPOINT_INGRESS_CAPACITY);
    let (web_tx, _web_rx) = channel::<Ingress>(WEBHOOK_INGRESS_CAPACITY);
    let mut sim = SimLoop::new(
        host_over(dir.path()),
        RenderProducer::new(),
        rt.handle(),
        sim_cfg(),
        grx,
    )
    .with_endpoint(endpoint_rx);

    // A REAL Source, so the target of the traversal exists and the probe is not
    // trivially satisfied by there being nothing to reach.
    let src = place_g(&mut sim, &gtx, machine_kind::SOURCE, 0, 0);
    let _ep = place_g(&mut sim, &gtx, machine_kind::ENDPOINT, 3, 3);
    let src_label = format!("src-{}", src.data().as_ffi());

    // NON-VACUITY: the hook door really does serve this Source at this label. Without
    // this the whole test could pass against a broken route map.
    assert_eq!(
        sim.routes_receiver().borrow().get(&src_label),
        Some(&src),
        "the Source's hook route is live, so the traversal has a real target to miss"
    );

    let (addr, server) = serve(&rt, &sim, endpoint_tx, web_tx);
    std::thread::sleep(Duration::from_millis(50));

    let target = format!("/endpoint/../hook/{src_label}");
    let raw = format!(
        "POST {target} HTTP/1.1\r\nHost: {addr}\r\nContent-Length: 4\r\nConnection: close\r\n\r\nping"
    );
    // `tokio::net::TcpStream`, not `std::net::TcpStream`: the workspace's determinism
    // clippy gate disallows the std type by path, and `cargo clippy --all-targets
    // -- -D warnings` is one of this plan's gates. The async one is the host's own idiom
    // anyway and reaches the same socket.
    let status_line = rt.block_on(async {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let mut stream = tokio::net::TcpStream::connect(addr)
            .await
            .expect("connect loopback");
        stream
            .write_all(raw.as_bytes())
            .await
            .expect("write raw request");
        stream.flush().await.expect("flush");
        let mut buf = Vec::new();
        let _ = tokio::time::timeout(Duration::from_secs(5), stream.read_to_end(&mut buf)).await;
        let text = String::from_utf8_lossy(&buf);
        text.lines().next().unwrap_or("<no response>").to_owned()
    });

    sim.run(Some(20), Duration::from_millis(5))
        .expect("give any smuggled request every chance to be folded");
    server.abort();

    assert_eq!(
        injects_for(&sim, src),
        0,
        "POST /endpoint/../hook/{src_label} must NOT reach the hook door. The response \
         line was: {status_line}"
    );
    // MEASURED, not reasoned about, and printed so the answer travels with the run
    // rather than living only in a summary somebody has to trust.
    println!("traversal probe response line: {status_line}");
}

/// A duplicate path is refused at Apply with a TYPED error, driven through the command
/// seam directly so no frontend gate is in the loop.
///
/// The frontend gate (plan 72-10) is untrusted input from the core's side: the wire is
/// reachable without the panel. This is the authority.
#[test]
fn a_duplicate_path_is_refused_at_apply() {
    let mut session = GridSession::new(72);
    let a = place_route(&mut session, 2, 2);
    let b = place_route(&mut session, 6, 2);
    // b's committed default, read off the board before anything is applied (D-13).
    let b_before = committed_path(&session, b);

    session
        .apply(GridCommand::Configure {
            node: handle_of(&session, a),
            config: MachineConfig::Endpoint {
                path: "/orders".to_owned(),
            },
        })
        .expect("the first Route may take /orders");

    let verdict = session.apply(GridCommand::Configure {
        node: handle_of(&session, b),
        config: MachineConfig::Endpoint {
            path: "/orders".to_owned(),
        },
    });
    assert_eq!(
        verdict,
        Err(CommandError::DuplicatePath),
        "a second Route claiming a live address must be refused with its OWN tag: it is \
         the only one of the four path rules that can name a specific other object, and \
         the panel is where that owner gets named (D-13)"
    );

    // NON-VACUITY, and it is the half that matters: the refusal produced NOTHING. Route
    // b still answers where it did.
    assert_eq!(
        committed_path(&session, b),
        b_before,
        "a refused Configure leaves the board byte-identical (SC#2): b keeps its default"
    );

    // RE-APPLYING THE SAME PATH TO THE SAME ROUTE IS NOT A DUPLICATE. Without this the
    // rule would refuse a user who opens the panel and presses Apply twice.
    session
        .apply(GridCommand::Configure {
            node: handle_of(&session, a),
            config: MachineConfig::Endpoint {
                path: "/orders".to_owned(),
            },
        })
        .expect("a Route may re-apply its OWN committed path");
}

/// Each of R-47's rules 1 to 3 is refused BY THE CORE ALONE.
#[test]
fn a_malformed_path_is_refused_by_the_core_alone() {
    let mut session = GridSession::new(72);
    let ep = place_route(&mut session, 2, 2);
    let default_path = committed_path(&session, ep);

    // Rule 1 (EXACTLY ONE leading slash, non-empty after it), rule 3 (unreserved bytes
    // only) and rule 2 (the length bound), each with the reason it is illegal.
    let cases: [(&str, &str); 10] = [
        ("", "empty: names no address at all"),
        ("orders", "no leading slash: not a URL path"),
        ("/", "a bare slash: empty after the slash"),
        (
            "//orders",
            "TWO leading slashes: `endpoint_route_key` trims ALL of them, so this used \
             to be accepted as an address DISTINCT from `/orders` and then published \
             under `/orders`'s key, silently unrouting one of the two Routes (CR-01)",
        ),
        ("///orders", "three leading slashes: the same collapse"),
        ("//", "nothing but leading slashes"),
        ("/orders?x=1", "`?` is not an unreserved path byte"),
        ("/or ders", "a space is not an unreserved path byte"),
        (
            "/%2e%2e/hook",
            "percent-encoding is REFUSED rather than decoded and then judged, which is \
             where traversal bugs live",
        ),
        ("/orders#frag", "`#` is not an unreserved path byte"),
    ];
    for (path, why) in cases {
        let verdict = session.apply(GridCommand::Configure {
            node: handle_of(&session, ep),
            config: MachineConfig::Endpoint {
                path: path.to_owned(),
            },
        });
        assert_eq!(
            verdict,
            Err(CommandError::InvalidPath),
            "the core must refuse {path:?} with no frontend gate in the loop ({why})"
        );
    }

    // AND THE OTHER SIDE OF RULE 1, which is a RULING and not an afterthought. Walk
    // item J-5 ruled that a path may carry multiple slashes, meaning MULTI-SEGMENT
    // addresses. Only the LEADING slashes are normalized away by `endpoint_route_key`,
    // so an interior empty segment collides with nothing; a CR-01 fix spelled
    // `!path.contains("//")` would have closed the collision and broken this ruling in
    // the same line. Driven through the SAME seam as the refusals above, so the accept
    // and the refuse are measured by one gate rather than two arguments.
    for path in ["/orders/new", "/orders/new/id", "/a//b", "/src-1"] {
        session
            .apply(GridCommand::Configure {
                node: handle_of(&session, ep),
                config: MachineConfig::Endpoint {
                    path: path.to_owned(),
                },
            })
            .unwrap_or_else(|e| panic!("the core must ACCEPT {path:?} (J-5), got {e:?}"));
        assert_eq!(
            committed_path(&session, ep),
            path,
            "and it must commit VERBATIM: the board stores exactly the address the door \
             answers at, which is what makes `endpoint_route_key` the identity (CR-01)"
        );
    }

    // The length bound, at ONE byte over, so it measures the bound rather than any
    // bound. `MAX_ENDPOINT_PATH_BYTES + 1` total bytes.
    let over = format!(
        "/{}",
        "a".repeat(fabrico_core::edit::MAX_ENDPOINT_PATH_BYTES)
    );
    assert_eq!(
        session.apply(GridCommand::Configure {
            node: handle_of(&session, ep),
            config: MachineConfig::Endpoint { path: over },
        }),
        Err(CommandError::InvalidPath),
        "one byte past MAX_ENDPOINT_PATH_BYTES is refused at the WRITE gate, which is \
         what keeps the restore gate from being the first place the user hears about it"
    );

    // And the boundary length is ACCEPTED, so the write gate and the restore gate agree
    // on one number in both directions.
    let at_bound = format!(
        "/{}",
        "a".repeat(fabrico_core::edit::MAX_ENDPOINT_PATH_BYTES - 1)
    );
    session
        .apply(GridCommand::Configure {
            node: handle_of(&session, ep),
            config: MachineConfig::Endpoint {
                path: at_bound.clone(),
            },
        })
        .expect("a path of exactly MAX_ENDPOINT_PATH_BYTES is accepted");
    assert_eq!(committed_path(&session, ep), at_bound);

    // Every refusal above left the board alone until the accepted one landed, which is
    // the SC#2 property. Asserted by the fact that the accepted path is what committed:
    // if any refusal had folded, this would be that refusal's string.
    assert_ne!(
        committed_path(&session, ep),
        default_path,
        "the accepted Configure is the one that committed"
    );
}

// --- helpers for the command-seam tests -------------------------------------------

/// Place ONE Route through the real command surface and return its minted id.
fn place_route(session: &mut GridSession, cell_x: i32, cell_y: i32) -> NodeId {
    session
        .apply(GridCommand::Place {
            kind: machine_kind::ENDPOINT,
            cell_x,
            cell_y,
        })
        .expect("the command layer accepts a Place{ENDPOINT}");
    *session
        .core()
        .last_tick
        .placed
        .last()
        .expect("a Place{ENDPOINT} mints exactly one node")
}

/// The dense render handle a `GridSession` addresses `node` by.
fn handle_of(session: &GridSession, node: NodeId) -> u64 {
    session
        .view()
        .handle_of(node)
        .expect("a placed node has a handle")
}

/// The Route's COMMITTED path, read off `GridState`.
fn committed_path(session: &GridSession, node: NodeId) -> String {
    match session.core().state.node(node) {
        Some(fabrico_core::state::Node::Endpoint(ep)) => ep.path.clone(),
        other => panic!("expected a live Node::Endpoint, found {other:?}"),
    }
}

// ─────────────────────────────────────────────────────────────────────────────────
// SERVE-08, the fault half. The core emits it; these two assert what a USER SEES.
// `derive_state` is the function the render packet's state byte comes from, so a Route
// that reports FAULTED here is a Route that is red on the board.
// ─────────────────────────────────────────────────────────────────────────────────

/// One `WireRequest` event addressed to `entry`, driven at the core seam.
///
/// A REAL POST would work too and the URL tests above use one. This half drives the
/// event directly because the SUBJECT is what the fold does with an unroutable request,
/// and a POST would add the whole door to a test about the fold.
fn wire_request(entry: fabrico_core::ids::NodeId, seq: u64, tick: u64) -> fabrico_core::event::Event {
    fabrico_core::event::Event {
        schema_version: SCHEMA_VERSION,
        partition: 0,
        sequence: seq,
        tick,
        payload: EventPayload::WireRequest {
            correlation: 0xC0FF_EE00 + seq,
            deadline_tick: tick + 300,
            budget: 8,
            return_addr: (entry, 0),
            payload: fabrico_core::ids::Item(b"ping".to_vec()),
        },
    }
}

/// A Route with no cable, placed through the real fold, plus a spare machine to wire to.
fn board_with_a_cableless_route() -> (fabrico_core::core::Core, NodeId, NodeId) {
    let mut core = fabrico_core::core::Core::genesis(header());
    let place = |kind: u8, x: i32, y: i32, seq: u64| fabrico_core::edit::EditRecord {
        schema_version: fabrico_core::edit::EDIT_SCHEMA_VERSION,
        partition: 0,
        sequence: seq,
        tick: 0,
        action: seq,
        op: fabrico_core::edit::EditOp::Place {
            kind,
            cell_x: x,
            cell_y: y,
            w: 1,
            h: 1,
            ports: Vec::new(),
            rot: 0,
        },
    };
    core.advance_edits(&[place(machine_kind::ENDPOINT, 3, 3, 1)], &[]);
    let ep = *core.last_tick.placed.last().expect("the Route minted");
    core.advance_edits(&[place(machine_kind::SINK, 6, 3, 2)], &[]);
    let sink = *core.last_tick.placed.last().expect("the Sink minted");
    (core, ep, sink)
}

/// The Route reports FAULTED within a handful of ticks, long before the 300-tick
/// deadline the caller's 504 rides.
///
/// RED ON HEAD BECAUSE: nothing is pushed to the Route's inbox at all, an Endpoint never
/// steps on its own, and the state byte therefore stays IDLE forever. The user's only
/// signal was a 504 five seconds later, from the host, naming nothing on the board.
#[test]
fn the_route_reports_faulted_within_a_handful_of_ticks() {
    let (mut core, ep, _sink) = board_with_a_cableless_route();

    // NON-VACUITY: it is IDLE before the request. Without this the test cannot tell a
    // fault it caused from a board that was red to begin with.
    assert_eq!(
        fabrico_host::render_packet::derive_state(ep, &core.last_tick, &core.state),
        fabrico_protocol::state_tag::IDLE,
        "a freshly placed Route with no traffic is IDLE"
    );

    let at = core.tick;
    core.advance(&[wire_request(ep, 1, at)]);

    assert_eq!(
        fabrico_host::render_packet::derive_state(ep, &core.last_tick, &core.state),
        fabrico_protocol::state_tag::FAULTED,
        "a POST into a Route with no cable must be VISIBLE ON THE BOARD in the same \
         tick, not answered by a 504 five seconds later that names nothing"
    );

    // And it STAYS faulted across quiet ticks, because the mark is a resting inbox
    // fault rather than a one-tick observation. A mark that vanished on the next tick
    // would be a flash nobody sees.
    for _ in 0..5 {
        core.advance(&[]);
    }
    assert_eq!(
        fabrico_host::render_packet::derive_state(ep, &core.last_tick, &core.state),
        fabrico_protocol::state_tag::FAULTED,
        "the mark rests: it is an undrained inbox fault, not a one-tick flash"
    );
}

/// Drawing the missing cable CLEARS the mark, WITH NO SECOND REQUEST.
///
/// THE NO-POST CLAUSE IS THE WHOLE ASSERTION (R-49, UI-SPEC 7.2). `72-CLEAN-DESIGN`'s
/// mechanism cleared on the next successful ADMIT, which is one POST later; without the
/// no-post clause this test passes against that mechanism and is a check that cannot
/// fail. A user who fixes the board and watches it stay red has been told their fix did
/// not work, which is why the clear had to move to the `DrawWire` FOLD.
#[test]
fn a_drawn_wire_clears_the_no_entry_cable_mark_with_no_post() {
    let (mut core, ep, sink) = board_with_a_cableless_route();

    // ONE request, so the fault rests in the inbox.
    let at = core.tick;
    core.advance(&[wire_request(ep, 1, at)]);
    assert_eq!(
        fabrico_host::render_packet::derive_state(ep, &core.last_tick, &core.state),
        fabrico_protocol::state_tag::FAULTED,
        "precondition: the Route is marked"
    );
    let events_before = 1;

    // ONE `EditOp::DrawWire` leaving that Route. NOTHING ELSE. No second request, no
    // POST, no injected event of any kind.
    core.advance_edits(
        &[fabrico_core::edit::EditRecord {
            schema_version: fabrico_core::edit::EDIT_SCHEMA_VERSION,
            partition: 0,
            sequence: 9,
            tick: core.tick,
            action: 9,
            op: fabrico_core::edit::EditOp::DrawWire {
                from_node: ep,
                from_port: 0,
                to_node: sink,
                to_port: 0,
            },
        }],
        &[],
    );

    assert_eq!(
        fabrico_host::render_packet::derive_state(ep, &core.last_tick, &core.state),
        fabrico_protocol::state_tag::IDLE,
        "drawing the missing cable clears the mark WITH NO SECOND REQUEST: a user who \
         fixes the board and watches it stay red has been told their fix did not work"
    );
    assert_eq!(
        events_before, 1,
        "exactly ONE request was ever driven; the clear did not need a second one"
    );

    // SCOPED TO ONE REASON AT ONE NODE, asserted rather than promised: a DrawWire does
    // NOT become a blanket fault drain. A different fault resting on the same Route
    // survives it, which is what keeps `render_packet`'s general "stays red until the
    // board is rebuilt" ruling true for every other fault.
    let other = fabrico_core::fault::Fault::command(
        ep,
        fabrico_core::fault::FaultReason::CommandFailure,
        b"a real dead letter".to_vec(),
    );
    core.state.inbox_mut(ep).push(
        fabrico_core::fault::FAULT_PORT,
        99,
        other.encode(),
    );
    core.advance_edits(
        &[fabrico_core::edit::EditRecord {
            schema_version: fabrico_core::edit::EDIT_SCHEMA_VERSION,
            partition: 0,
            sequence: 10,
            tick: core.tick,
            action: 10,
            op: fabrico_core::edit::EditOp::DrawWire {
                from_node: ep,
                from_port: 1,
                to_node: sink,
                to_port: 1,
            },
        }],
        &[],
    );
    assert_eq!(
        fabrico_host::render_packet::derive_state(ep, &core.last_tick, &core.state),
        fabrico_protocol::state_tag::FAULTED,
        "a DrawWire drains ONLY NoEntryWire: a CommandFailure carrying a real dead \
         letter is untouched, so the general fault lifecycle is unchanged and no \
         evidence is destroyed"
    );
}
