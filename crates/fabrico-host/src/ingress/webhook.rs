//! The webhook source: an axum router bound to `127.0.0.1:PORT` that turns one
//! inbound request into exactly one logged event, after a persisted dedup on the
//! provider delivery id (SRC-01 / INGRESS-02).
//!
//! # One request -> one logged event, loopback-only, body-bounded
//!
//! Each `POST /hook/{target}` extracts the provider's delivery-id header (opaque
//! bytes), looks the `{target}` path label up in a route table to its source
//! [`NodeId`], and hands an [`Ingress`] message — `(target, delivery_id, body,
//! oneshot ack)` — to the host loop over a channel. The host loop is the single
//! redb writer: it runs the persisted seen-set dedup BEFORE logging, appends
//! exactly one `ManualInject` event on a new delivery id (or nothing on a
//! duplicate), and acks the oneshot either way (an idempotent `200`). A DROPPED ack is
//! how the host says it did not take a request, and the caller reads it as a `503`.
//!
//! Two untrusted inputs cross the boundary here and are bounded:
//! - the **body** is capped by a `tower-http` [`RequestBodyLimitLayer`] (DoS
//!   mitigation, threat T-05-07-DOS-BODY) before it is ever buffered;
//! - the **delivery id** is treated as opaque bytes and is length-bounded by the
//!   seen-set's own `MAX_RECORD_BYTES` cap on the host loop (threat
//!   T-05-07-DES) — never decoded, never trusted as structure.
//!
//! The listener binds loopback (`127.0.0.1`) ONLY this phase (threat
//! T-05-07-EXPOSE); a public tunnel with explicit auth is deferred to Phase 6.

use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::ops::Deref;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::post;
use fabrico_core::ids::NodeId;
use tokio::net::TcpListener;
use tokio::sync::mpsc::Sender;
use tokio::sync::oneshot;
use tokio::sync::watch;
use tower_http::limit::RequestBodyLimitLayer;

use crate::ingress::endpoint::{EndpointTx, endpoint};

/// The bound on in-flight webhook ingress (ROBUST-01). Aliased to
/// [`ENDPOINT_INGRESS_CAPACITY`](crate::ingress::endpoint::ENDPOINT_INGRESS_CAPACITY)
/// so BOTH front doors read as ONE mental model (256). Past this many un-drained
/// accepted requests the handler's `try_send` fails and answers a deterministic 503
/// (Gate B) instead of growing host memory / FDs / ack oneshots without bound.
pub const WEBHOOK_INGRESS_CAPACITY: usize = crate::ingress::endpoint::ENDPOINT_INGRESS_CAPACITY;

/// The channel the axum handler hands each accepted request to the host loop on.
///
/// BOUNDED at [`WEBHOOK_INGRESS_CAPACITY`] (ROBUST-01): a full channel yields a
/// deterministic 503 from `try_send`, never unbounded growth while the sim is
/// Draining/Frozen — mirroring the shipped endpoint door's [`EndpointTx`].
pub type IngressTx = Sender<Ingress>;

/// The published route map, plus the board it belongs to.
///
/// Each request takes its `NodeId` and its `board` from one snapshot of this table, and the
/// sim loop refuses a request whose `board` is not the current one. A POST handler isn't
/// ordered against the sim thread, so a handler that read this table before a board swap can
/// enqueue after it, and the new board may give the same id to a different machine. One value
/// on the watch means the number and the map can't come from two publishes.
///
/// `board` stays on the host side: it never enters an event, the fold, the log or a snapshot.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RouteTable {
    /// The number of the board this table was published for. It moves only on a host swap.
    pub board: u64,
    /// The `{target}` label -> node map.
    pub routes: BTreeMap<String, NodeId>,
}

impl Deref for RouteTable {
    type Target = BTreeMap<String, NodeId>;

    fn deref(&self) -> &Self::Target {
        &self.routes
    }
}

/// The receiver onto the LIVE route table the sim thread publishes.
pub type RoutesRx = watch::Receiver<Arc<RouteTable>>;

/// The header carrying the provider's delivery id (the dedup key). Opaque bytes.
const DELIVERY_ID_HEADER: &str = "x-delivery-id";

/// One accepted webhook request, handed to the host loop for dedup + logging.
///
/// The host loop owns the dedup decision and the log append (single writer); the
/// handler only forwards the request and awaits the `ack`.
pub struct Ingress {
    /// The resolved source node this request injects into (from the route table).
    pub target: NodeId,
    /// The board the table that gave `target` was published for ([`RouteTable::board`]).
    pub board: u64,
    /// The provider delivery id — opaque, length-bounded bytes (the dedup key).
    ///
    /// `None` when the request carried no `x-delivery-id` header: such a request is
    /// treated as ALWAYS unique (never deduped), so a provider that does not set the
    /// header has every distinct delivery logged rather than collapsing all
    /// header-less deliveries onto one empty key (WR-01).
    pub delivery_id: Option<Vec<u8>>,
    /// The request body, carried verbatim as the injected item's bytes.
    pub body: Vec<u8>,
    /// Acked by the host loop once the request was logged OR deduped (idempotent).
    /// Dropping it unsent is how the host says it did not take the request, which the
    /// caller reads as a `503`.
    pub ack: oneshot::Sender<()>,
}

/// Shared handler state: the ingress channel + a `watch` receiver onto the LIVE
/// `{target}` -> source-node route table (HOST-07). Both cheap to clone (a sender
/// handle + a watch receiver). The route table is a fold-projection of
/// `core.state`'s Source set published by the sim thread as an immutable `Arc`; the
/// handler NEVER mutates it — it reads the latest snapshot per request via a
/// lock-free `borrow().clone()` (a cheap `Arc` clone).
///
/// It also carries `endpoint_tx`, the response-carrying sibling channel the
/// `POST /endpoint/{target}` handler ([`endpoint`]) forwards its parked-socket
/// ingress on. Both routes ride this ONE shared state on the ONE router (one
/// server, one body-limit); `pub(crate)` so the sibling `endpoint` module's
/// handler can read `endpoint_tx` + `routes_rx`.
#[derive(Clone)]
pub(crate) struct WebhookState {
    pub(crate) tx: IngressTx,
    pub(crate) endpoint_tx: EndpointTx,
    pub(crate) routes_rx: RoutesRx,
    /// The not-Playing signal (ROBUST-01): `true` iff the sim is Playing, published
    /// by the sim loop at the end of every `step()` (mirrors the `paused` Arc). The
    /// handler reads it lock-free per request (Gate A) to fast-503 while the sim is
    /// Draining/Frozen — BEFORE any enqueue, so a refused request records nothing.
    pub(crate) is_playing: Arc<AtomicBool>,
}

/// `POST /hook/{target}`: resolve the target label, extract the delivery id,
/// forward an [`Ingress`] to the host loop, and return `200` once acked.
///
/// Returns `404` for an unknown target label and `503` if the host loop is gone
/// (channel closed or the ack dropped) — never panics on untrusted input.
async fn hook(
    State(state): State<WebhookState>,
    Path(target): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> StatusCode {
    // Read the LATEST projected route snapshot for THIS request: a lock-free
    // `borrow().clone()` is a cheap `Arc` clone of the immutable map the sim thread
    // last published (HOST-07). A Source placed/deleted since the last request is
    // reflected here without ever mutating a shared map in place.
    let routes = state.routes_rx.borrow().clone();
    let Some(&node) = routes.get(&target) else {
        return StatusCode::NOT_FOUND;
    };
    // CROSS-DOOR GUARD (F1): the route map is shared with `/endpoint` and carries
    // both Source keys (`src-<ffi>`) and Route keys. A Route key always leads with `/`
    // (its own path through `endpoint_route_key`, the default `/route-N` since phase 91)
    // and a Source key never does. This door serves ONLY `src-` nodes; a POST here naming
    // a Route must NOT log a spurious ManualInject the core silently drops behind a
    // misleading 200, so a non-`src-` target is a 404 here: nothing forwarded, nothing
    // logged.
    if !target.starts_with("src-") {
        return StatusCode::NOT_FOUND;
    }
    // GATE A (ROBUST-01) — the not-Playing fast-503. It sits FIRST, immediately after
    // the door guards and BEFORE delivery-id extraction / any enqueue, so a request
    // refused while the sim is Draining/Frozen records NOTHING, enqueues NOTHING, and
    // logs NOTHING. This is drop-with-503-never-200: a silent 200 without logging
    // would drop an un-logged webhook and break at-least-once / the seen-set (a 503 is
    // an explicit "I did not take it" the caller retries on). Derived from the sim's
    // `run_state == Playing` signal (false in BOTH Draining and Frozen), NOT `paused`.
    if !state.is_playing.load(Ordering::Acquire) {
        return StatusCode::SERVICE_UNAVAILABLE;
    }
    // The delivery id is opaque bytes — never decoded or trusted as structure. An
    // ABSENT header is `None` (treated as always-unique / never deduped), NOT the
    // empty key — collapsing all header-less deliveries onto `b""` would silently
    // drop every header-less delivery after the first (WR-01).
    let delivery_id = headers
        .get(DELIVERY_ID_HEADER)
        .map(|v| v.as_bytes().to_vec());
    let (ack_tx, ack_rx) = oneshot::channel();
    // GATE B (ROBUST-01) — bounded backpressure. `try_send` (NEVER an awaited `send`,
    // which would hold the socket when full) folds `Full` (channel at
    // WEBHOOK_INGRESS_CAPACITY — the sim is Draining/Frozen or simply overloaded) and
    // `Closed` (host loop's receiver dropped) to ONE deterministic 503, so nothing
    // accumulates past capacity and no caller ever blocks on a full channel.
    if state
        .tx
        .try_send(Ingress {
            target: node,
            // From the same snapshot as `node`, so the two can't disagree about the board.
            board: routes.board,
            delivery_id,
            body: body.to_vec(),
            ack: ack_tx,
        })
        .is_err()
    {
        return StatusCode::SERVICE_UNAVAILABLE;
    }
    match ack_rx.await {
        // 200 whether the request was newly logged OR deduped (idempotent).
        Ok(()) => StatusCode::OK,
        Err(_) => StatusCode::SERVICE_UNAVAILABLE,
    }
}

/// Build the webhook [`Router`]: `POST /hook/{target}`, a body-size limit layer
/// (DoS mitigation), and the ingress/route state. `routes_rx` is a `watch`
/// receiver onto the LIVE fold-projection of `core.state`'s Source set (HOST-07) —
/// the handler reads the latest published snapshot per request; the sim thread
/// swaps whole `Arc`s over it, never mutating a shared map. Exposed so tests can
/// drive it over a bound loopback listener (and read back the bound port).
pub fn webhook_router(
    routes_rx: RoutesRx,
    tx: IngressTx,
    endpoint_tx: EndpointTx,
    body_limit: usize,
    is_playing: Arc<AtomicBool>,
) -> Router {
    Router::new()
        .route("/hook/{target}", post(hook))
        // The Endpoint front door rides the SAME router + body-limit as the webhook
        // (ENDP-01): one loopback listener, one server, one port — NEVER a second
        // bind. It parks the caller's socket on a response-carrying oneshot.
        //
        // `{*target}` IS A MULTI-SEGMENT CAPTURE AND THE WIDENING IS DELIBERATE (R-46,
        // SERVE-08). It read `{target}` until 72-07, and in axum 0.8 `{target}` captures
        // EXACTLY ONE segment, while D-15 and UI-SPEC 3's approved hint copy both use
        // `/users/42` as the worked example of a path a user may type. That measured
        // contradiction is R-17, and this is where it is closed.
        //
        // THE WIDENING COSTS NOTHING THAT D-12a BOUGHT, and this is the reason the
        // prefix decision and the capture decision are not in tension. `/endpoint/` is a
        // FIXED prefix and it does not move: everything the wildcard can capture sits
        // BELOW it, so no path a user types can reach `/hook/` or any other host route.
        // That is threat T-72-07-02's mitigation, and it is STRUCTURAL rather than a
        // reserved-prefix blacklist. A default Route URL, `/endpoint/route-<n>` since
        // phase 91, matches under either capture.
        //
        // THE HOOK ROUTE ABOVE IS DELIBERATELY UNCHANGED. A source label is one segment
        // by construction (`src-<as_ffi>`), so widening that capture would buy nothing
        // and would widen an untrusted surface for no reason.
        .route("/endpoint/{*target}", post(endpoint))
        // Bound the untrusted body before it is buffered, covering BOTH routes
        // (threat T-05-07-DOS-BODY / T-38-04 — one cap, two routes).
        .layer(RequestBodyLimitLayer::new(body_limit))
        .with_state(WebhookState {
            tx,
            endpoint_tx,
            routes_rx,
            is_playing,
        })
}

/// Bind the webhook listener on `addr` (loopback this phase), SPAWN the serve loop
/// as a background task, and return the concrete bound [`SocketAddr`]. The bind is
/// synchronous (so a port-0 request resolves to a knowable port the shell can
/// surface as `http://127.0.0.1:PORT/hook/src-<id>` — Runtime State Inventory);
/// the serve loop then runs until the process exits. `routes_rx` is the LIVE route
/// projection (HOST-07); `body_limit` caps the untrusted request body.
///
/// # Errors
/// Returns the bind [`std::io::Error`] if the address cannot be bound or its local
/// address cannot be read.
pub async fn run_webhook_listener(
    addr: SocketAddr,
    routes_rx: RoutesRx,
    tx: IngressTx,
    endpoint_tx: EndpointTx,
    body_limit: usize,
    is_playing: Arc<AtomicBool>,
) -> std::io::Result<SocketAddr> {
    let app = webhook_router(routes_rx, tx, endpoint_tx, body_limit, is_playing);
    let listener = TcpListener::bind(addr).await?;
    // Read the concrete bound address BEFORE moving the listener into the serve
    // loop, so a port-0 bind yields a knowable port the caller can surface.
    let bound = listener.local_addr()?;
    tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, app).await {
            eprintln!("fabrico-host: webhook listener stopped: {e}");
        }
    });
    Ok(bound)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use slotmap::SlotMap;
    use tokio::sync::mpsc::channel;
    use tower::ServiceExt; // `oneshot` — drive the router with no bound socket.

    /// A fixed always-Playing signal for the webhook-only unit tests (Gate A open).
    fn playing() -> Arc<AtomicBool> {
        Arc::new(AtomicBool::new(true))
    }

    /// Mint a single real generational [`NodeId`] (key-minting only).
    fn a_node() -> NodeId {
        let mut alloc: SlotMap<NodeId, ()> = SlotMap::with_key();
        alloc.insert(())
    }

    fn route_to(label: &str, node: NodeId) -> RouteTable {
        let mut routes = BTreeMap::new();
        routes.insert(label.to_owned(), node);
        RouteTable { board: 0, routes }
    }

    /// A throwaway endpoint ingress sender for the webhook-only tests (they never
    /// POST `/endpoint/...`, so the receiver is dropped — the sender is inert).
    fn no_endpoint_tx() -> EndpointTx {
        use crate::ingress::endpoint::{EndpointIngress, ENDPOINT_INGRESS_CAPACITY};
        tokio::sync::mpsc::channel::<EndpointIngress>(ENDPOINT_INGRESS_CAPACITY).0
    }

    /// Wrap a static route map in a `watch` channel and hand back only the
    /// receiver (the tests that never update the table). Dropping the sender is
    /// fine: a `watch::Receiver::borrow()` still returns the last-published value
    /// after all senders drop, and `hook` only ever borrows (never `changed()`).
    fn watched(routes: RouteTable) -> RoutesRx {
        let (_tx, rx) = watch::channel(Arc::new(routes));
        rx
    }

    #[tokio::test]
    async fn webhook_routes_request_to_ingress_and_acks() {
        // A POST to a known target forwards exactly one Ingress carrying the
        // resolved node, the delivery-id bytes, and the body — and returns 200
        // once the host loop acks (one request -> one ingress message).
        let node = a_node();
        let (tx, mut rx) = channel::<Ingress>(WEBHOOK_INGRESS_CAPACITY);
        let app = webhook_router(watched(route_to("src-1", node)), tx, no_endpoint_tx(), 4096, playing());

        // The host loop's role: receive the Ingress and ack it.
        let drained = tokio::spawn(async move {
            let ing = rx.recv().await.expect("an ingress message");
            let _ = ing.ack.send(());
            (ing.target, ing.delivery_id, ing.body)
        });

        let req = Request::builder()
            .method("POST")
            .uri("/hook/src-1")
            .header(DELIVERY_ID_HEADER, "deliver-1")
            .body(Body::from("payload-bytes"))
            .expect("build request");
        let resp = app.oneshot(req).await.expect("route the request");
        assert_eq!(resp.status(), StatusCode::OK, "an acked request is 200");

        let (target, delivery_id, body) = drained.await.expect("drain task");
        assert_eq!(target, node, "the {{target}} label resolved to its node");
        assert_eq!(
            delivery_id,
            Some(b"deliver-1".to_vec()),
            "a present delivery id is Some(opaque header bytes)"
        );
        assert_eq!(body, b"payload-bytes", "the body is carried verbatim");
    }

    #[tokio::test]
    async fn a_forwarded_webhook_carries_the_stamp_of_the_table_it_read() {
        // The sim loop refuses a request by this number, so it has to be the number of the
        // table the node came from.
        let node = a_node();
        let (tx, mut rx) = channel::<Ingress>(WEBHOOK_INGRESS_CAPACITY);
        let table = RouteTable { board: 7, ..route_to("src-1", node) };
        let app = webhook_router(watched(table), tx, no_endpoint_tx(), 4096, playing());
        let drained = tokio::spawn(async move {
            let ing = rx.recv().await.expect("an ingress message");
            let _ = ing.ack.send(());
            ing.board
        });

        let req = Request::builder()
            .method("POST")
            .uri("/hook/src-1")
            .body(Body::from("x"))
            .expect("build request");
        let resp = app.oneshot(req).await.expect("route the request");
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(drained.await.expect("drain task"), 7);
    }

    #[tokio::test]
    async fn webhook_absent_delivery_id_is_none_not_empty_key() {
        // A request with NO x-delivery-id header forwards `delivery_id: None`, not
        // the empty key — so the host loop treats it as always-unique and never
        // collapses all header-less deliveries onto one dedup key (WR-01).
        let node = a_node();
        let (tx, mut rx) = channel::<Ingress>(WEBHOOK_INGRESS_CAPACITY);
        let app = webhook_router(watched(route_to("src-1", node)), tx, no_endpoint_tx(), 4096, playing());

        let drained = tokio::spawn(async move {
            let ing = rx.recv().await.expect("an ingress message");
            let _ = ing.ack.send(());
            ing.delivery_id
        });

        let req = Request::builder()
            .method("POST")
            .uri("/hook/src-1")
            .body(Body::from("payload-bytes"))
            .expect("build request");
        let resp = app.oneshot(req).await.expect("route the request");
        assert_eq!(resp.status(), StatusCode::OK, "an acked request is 200");

        let delivery_id = drained.await.expect("drain task");
        assert_eq!(
            delivery_id, None,
            "an absent x-delivery-id header is None (always unique), never the empty key"
        );
    }

    #[tokio::test]
    async fn webhook_unknown_target_is_404() {
        // A POST to a target label absent from the route table is rejected with
        // 404 — never panics, never forwards an ingress for a non-existent node.
        let (tx, mut rx) = channel::<Ingress>(WEBHOOK_INGRESS_CAPACITY);
        let app = webhook_router(watched(route_to("src-1", a_node())), tx, no_endpoint_tx(), 4096, playing());

        let req = Request::builder()
            .method("POST")
            .uri("/hook/nope")
            .body(Body::from("x"))
            .expect("build request");
        let resp = app.oneshot(req).await.expect("route the request");
        assert_eq!(resp.status(), StatusCode::NOT_FOUND, "unknown target -> 404");
        assert!(rx.try_recv().is_err(), "no ingress forwarded for an unknown target");
    }

    #[tokio::test]
    async fn webhook_wrong_door_ep_target_is_404_no_ingress() {
        // F1 cross-door guard: `/hook` serves ONLY `src-` nodes. A POST aimed at a live
        // ENDPOINT must 404 and forward NO ingress — never a misleading 200 over a
        // ManualInject the core drops.
        //
        // TWO THINGS REFUSE IT NOW, and the key is the stronger of the two (72-07). The
        // map key is `/ep-9`, a slash-led endpoint key as `project_routes` publishes
        // one (this test's own label, not the default path), so a
        // `POST /hook/ep-9` MISSES the map outright: an endpoint key always leads with a
        // slash and a hook target never can. The `starts_with("src-")` prefix guard is
        // still there behind it as defence in depth, but it is no longer what is doing
        // the work, and that matters because the prefix argument stopped being sound the
        // moment a user could type `/src-1` as a Route path.
        let ep = a_node();
        let (tx, mut rx) = channel::<Ingress>(WEBHOOK_INGRESS_CAPACITY);
        let app = webhook_router(
            watched(route_to("/ep-9", ep)),
            tx,
            no_endpoint_tx(),
            4096,
            playing(),
        );

        let req = Request::builder()
            .method("POST")
            .uri("/hook/ep-9")
            .body(Body::from("x"))
            .expect("build request");
        let resp = app.oneshot(req).await.expect("route the request");
        assert_eq!(
            resp.status(),
            StatusCode::NOT_FOUND,
            "a wrong-door ep- target on /hook is 404 (F1)"
        );
        assert!(
            rx.try_recv().is_err(),
            "no ingress forwarded for a wrong-door ep- target"
        );
    }

    #[tokio::test]
    async fn webhook_body_over_limit_is_rejected() {
        // The RequestBodyLimitLayer rejects an oversized body before the handler
        // runs (DoS mitigation, threat T-05-07-DOS-BODY).
        let (tx, _rx) = channel::<Ingress>(WEBHOOK_INGRESS_CAPACITY);
        let limit = 8usize;
        let app = webhook_router(watched(route_to("src-1", a_node())), tx, no_endpoint_tx(), limit, playing());

        let req = Request::builder()
            .method("POST")
            .uri("/hook/src-1")
            .body(Body::from(vec![0u8; limit + 64]))
            .expect("build request");
        let resp = app.oneshot(req).await.expect("route the request");
        assert_eq!(
            resp.status(),
            StatusCode::PAYLOAD_TOO_LARGE,
            "a body over the limit is rejected, not buffered"
        );
    }

    #[tokio::test]
    async fn watch_update_adds_a_routable_label() {
        // The route table is LIVE: after the sim thread publishes a NEW Arc over the
        // watch (adding a label), a POST to that newly-added label routes to its node
        // — even though the router was built over an EMPTY table (HOST-07). This is
        // the whole point of the watch snapshot: no imperative map mutation, only a
        // whole-Arc swap that the handler picks up on its next `borrow()`.
        let node = a_node();
        let (routes_tx, routes_rx) = watch::channel(Arc::new(RouteTable::default()));
        let (tx, mut rx) = channel::<Ingress>(WEBHOOK_INGRESS_CAPACITY);
        let app = webhook_router(routes_rx, tx, no_endpoint_tx(), 4096, playing());

        // A POST to "src-late" 404s while the table is still empty.
        let req = Request::builder()
            .method("POST")
            .uri("/hook/src-late")
            .body(Body::from("x"))
            .expect("build request");
        let resp = app.clone().oneshot(req).await.expect("route the request");
        assert_eq!(
            resp.status(),
            StatusCode::NOT_FOUND,
            "an as-yet-unpublished label 404s"
        );

        // The sim thread publishes a fresh Arc adding `src-late -> node`.
        routes_tx
            .send(Arc::new(route_to("src-late", node)))
            .expect("publish new routes Arc");

        let drained = tokio::spawn(async move {
            let ing = rx.recv().await.expect("an ingress message");
            let _ = ing.ack.send(());
            ing.target
        });

        let req = Request::builder()
            .method("POST")
            .uri("/hook/src-late")
            .body(Body::from("x"))
            .expect("build request");
        let resp = app.oneshot(req).await.expect("route the request");
        assert_eq!(
            resp.status(),
            StatusCode::OK,
            "a label added by a watch update now routes (live route table)"
        );
        assert_eq!(
            drained.await.expect("drain task"),
            node,
            "the newly-published label resolved to its node"
        );
    }

    #[tokio::test]
    async fn webhook_saturated_channel_is_503_no_unbounded_growth() {
        // GATE B (ROBUST-01): the webhook ingress channel is BOUNDED. When it is already
        // full — the sim is Frozen/Draining (or simply overloaded) and not draining it —
        // a new POST `try_send`s, fails, and gets a deterministic 503 INSTEAD of growing
        // the channel without bound or hanging the caller forever. Prove it with a
        // capacity-1 channel pre-filled to saturation: the POST cannot enqueue and is
        // refused immediately (no unbounded queue, no hang). Mirrors the endpoint door's
        // `saturated_channel_is_503_no_unbounded_growth`.
        let node = a_node();
        // Capacity 1; the receiver is held but NEVER drained (models a paused sim).
        let (tx, _rx) = channel::<Ingress>(1);
        // Occupy the single slot so the channel is at capacity before the request.
        let (fill_ack, _fill_ack_rx) = oneshot::channel();
        tx.try_send(Ingress {
            target: node,
            board: 0,
            delivery_id: None,
            body: Vec::new(),
            ack: fill_ack,
        })
        .expect("pre-fill the one channel slot");

        // The router shares the SAME saturated sender (a cheap clone).
        let app = webhook_router(
            watched(route_to("src-1", node)),
            tx.clone(),
            no_endpoint_tx(),
            4096,
            playing(),
        );
        let req = Request::builder()
            .method("POST")
            .uri("/hook/src-1")
            .body(Body::from("x"))
            .expect("build request");
        let resp = app.oneshot(req).await.expect("route the request");
        assert_eq!(
            resp.status(),
            StatusCode::SERVICE_UNAVAILABLE,
            "an over-capacity webhook POST is 503, never an unbounded enqueue or a hang (Gate B)"
        );
        // The channel never grew past its capacity of 1 (the refused request enqueued
        // nothing): only the pre-fill occupies it.
        assert_eq!(
            tx.capacity(),
            0,
            "the bounded channel stayed at capacity (no growth)"
        );
    }

    #[tokio::test]
    async fn webhook_closed_ingress_is_503() {
        // If the sim-loop receiver is gone (channel closed), `try_send` fails Closed and
        // the handler answers a deterministic 503 — never a hang. Mirrors the endpoint
        // door's `closed_ingress_is_503`.
        let node = a_node();
        let (tx, rx) = channel::<Ingress>(WEBHOOK_INGRESS_CAPACITY);
        drop(rx); // the sim is gone before the request arrives.
        let app = webhook_router(
            watched(route_to("src-1", node)),
            tx,
            no_endpoint_tx(),
            4096,
            playing(),
        );
        let req = Request::builder()
            .method("POST")
            .uri("/hook/src-1")
            .body(Body::from("x"))
            .expect("build request");
        let resp = app.oneshot(req).await.expect("route the request");
        assert_eq!(
            resp.status(),
            StatusCode::SERVICE_UNAVAILABLE,
            "a closed webhook ingress -> 503 (Gate B folds Full|Closed to one 503)"
        );
    }

    #[tokio::test]
    async fn webhook_not_playing_503_no_forward() {
        // GATE A (ROBUST-01): while the sim is NOT Playing (Draining/Frozen) the handler
        // fast-503s BEFORE any enqueue, so a refused request forwards NOTHING — nothing is
        // recorded, enqueued, or logged (drop-with-503-never-200). A silent 200 without
        // logging would drop an un-logged webhook and break at-least-once / the seen-set;
        // a 503 is an explicit "I did not take it" the caller retries on.
        let node = a_node();
        let (tx, mut rx) = channel::<Ingress>(WEBHOOK_INGRESS_CAPACITY);
        // is_playing = false: the sim is Draining/Frozen from the handler's view.
        let not_playing = Arc::new(AtomicBool::new(false));
        let app = webhook_router(
            watched(route_to("src-1", node)),
            tx,
            no_endpoint_tx(),
            4096,
            not_playing,
        );
        let req = Request::builder()
            .method("POST")
            .uri("/hook/src-1")
            .header(DELIVERY_ID_HEADER, "deliver-while-paused")
            .body(Body::from("payload-bytes"))
            .expect("build request");
        let resp = app.oneshot(req).await.expect("route the request");
        assert_eq!(
            resp.status(),
            StatusCode::SERVICE_UNAVAILABLE,
            "a POST while not Playing -> 503 (Gate A short-circuits before enqueue)"
        );
        assert!(
            rx.try_recv().is_err(),
            "nothing was forwarded: Gate A refused before any enqueue (nothing recorded/logged)"
        );
    }

    #[tokio::test]
    async fn endpoint_not_playing_503_no_forward() {
        // Phase 90 review WR-A-01: the endpoint door carries GATE A too. While the sim is not
        // Playing (Draining, Frozen, or stopped after a fatal) a POST is refused with the
        // sim thread's own not-Playing 503 before any enqueue, so no caller waits on a sim
        // that will not answer.
        use crate::ingress::endpoint::{ENDPOINT_INGRESS_CAPACITY, EndpointIngress};
        let node = a_node();
        let (tx, _rx) = channel::<Ingress>(WEBHOOK_INGRESS_CAPACITY);
        let (etx, mut erx) = tokio::sync::mpsc::channel::<EndpointIngress>(ENDPOINT_INGRESS_CAPACITY);
        let app = webhook_router(
            watched(route_to("/orders", node)),
            tx,
            etx,
            4096,
            Arc::new(AtomicBool::new(false)),
        );
        let req = Request::builder()
            .method("POST")
            .uri("/endpoint/orders")
            .body(Body::from("{}"))
            .expect("build request");
        let resp = app.oneshot(req).await.expect("route the request");
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE, "a POST while not Playing -> 503");
        assert!(erx.try_recv().is_err(), "nothing was forwarded to the sim");
    }
}
