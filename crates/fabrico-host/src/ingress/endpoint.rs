//! The Endpoint node's host-side HTTP response model (ENDP-02).
//!
//! An Endpoint handler answers an external caller by emitting a JSON
//! [`ResponseDescriptor`] `{status, headers, body}`. That descriptor rides
//! INSIDE the already-final `Effect::Reply.payload` as opaque `Item` bytes
//! (`serde_json::to_vec` — the `factory.rs` `Item(effect_json)` encode
//! precedent); the core effect gains NO new serialized field. The host decodes
//! those UNTRUSTED bytes into an owned [`HttpResponse`] here.
//!
//! # Reject-only decode (trust boundary)
//! The reply payload is untrusted (a message looped in from a belt, a forged
//! save-file, a buggy handler). [`descriptor_to_response`] therefore decodes
//! behind a `Result`: a decode failure — malformed bytes, a non-descriptor
//! shape, an out-of-range status, or an unrepresentable header — folds to a
//! `502 Bad Gateway`, NEVER a panic, OOM, or hang. This mirrors the
//! `WireEnvelope::decode` trust-gate discipline in the core.
//!
//! # Owned, `Send` parts
//! [`HttpResponse`] holds the response as owned `(StatusCode, HeaderMap,
//! Vec<u8>)` parts rather than a built `axum::response::Response`, so it is
//! trivially `Send` and can sit in a `oneshot::Sender<HttpResponse>` crossing
//! the executor-consumer thread boundary (38-03). [`HttpResponse::into_axum_response`]
//! materialises the axum response only at the handler's return edge (38-02).

use std::collections::BTreeMap;

use axum::body::{Body, Bytes};
use axum::extract::{Path, State};
use axum::http::header::CONTENT_TYPE;
use axum::http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use fabrico_core::ids::{Item, NodeId};
use fabrico_engine::envelope::{RequestEnvelope, encode_request_envelope};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc::Sender;
use tokio::sync::oneshot;

use crate::ingress::webhook::WebhookState;

/// The canonical JSON reply descriptor a handler emits, packed as `Item` bytes
/// INSIDE `Effect::Reply.payload` (the core effect gains no typed field).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResponseDescriptor {
    /// HTTP status code. An out-of-range value folds to `502` on decode.
    pub status: u16,
    /// Response headers. `BTreeMap` (NEVER `HashMap`) so header emission order is
    /// deterministic / lexical — replay- and test-stable. Defaults to empty.
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    /// UTF-8 response body. Binary-via-base64 is DEFERRED (plan decision D5): a
    /// v1 handler emits text/JSON bodies only. Defaults to empty.
    #[serde(default)]
    pub body: String,
}

/// An owned, `Send` HTTP response the parked-socket registry carries across the
/// executor-consumer thread boundary (38-03).
///
/// Owned parts, not a built `axum::response::Response`, so it is trivially `Send`
/// and can sit in a `oneshot::Sender<HttpResponse>`. Materialise the axum
/// response only at the handler edge via [`HttpResponse::into_axum_response`].
#[derive(Clone, Debug)]
pub struct HttpResponse {
    status: StatusCode,
    headers: HeaderMap,
    body: Vec<u8>,
}

impl HttpResponse {
    /// The `504` timeout response, synthesized ENTIRELY host-side (the core emits
    /// no Timeout event for an endpoint request). Body is the canonical
    /// `{"error":"timeout"}` JSON object.
    pub fn timeout_504() -> Self {
        Self {
            status: StatusCode::GATEWAY_TIMEOUT,
            headers: json_content_type(),
            body: br#"{"error":"timeout"}"#.to_vec(),
        }
    }

    /// A `200` whose body is `bytes` returned verbatim as the JSON body — the
    /// fallback authoring UX for a bare handler value (final UX is Phase 39).
    pub fn ok_json(bytes: Vec<u8>) -> Self {
        Self {
            status: StatusCode::OK,
            headers: json_content_type(),
            body: bytes,
        }
    }

    /// The `503` refusal, synthesized host-side when the parked-request registry
    /// is already at [`MAX_PARKED_ENDPOINTS`](crate::registry::MAX_PARKED_ENDPOINTS)
    /// (the DoS fence, ENDP-04): the sim loop resolves the over-cap caller's socket
    /// with this instead of parking + enqueuing a WireRequest. Body is the canonical
    /// `{"error":"overloaded"}` JSON object.
    pub fn service_unavailable_503() -> Self {
        Self {
            status: StatusCode::SERVICE_UNAVAILABLE,
            headers: json_content_type(),
            body: br#"{"error":"overloaded"}"#.to_vec(),
        }
    }

    /// The `503` a host swap (Load / LoadDemo) resolves every ORPHANED parked socket
    /// with (F4). Sockets parked against the discarded pre-swap timeline cannot be
    /// answered by the loaded scene (their correlation/deadline belong to a timeline
    /// that no longer exists), so on swap the registry is drained: each parked caller
    /// gets this deterministic `503` and the map is cleared, so the loaded scene
    /// starts with an EMPTY registry (matching crash-recovery semantics). It also answers
    /// a request still queued at the swap, and one refused later because the route table
    /// it read belongs to the replaced board. Body is the canonical
    /// `{"error":"scene reloaded"}` JSON object.
    pub fn reloaded_503() -> Self {
        Self {
            status: StatusCode::SERVICE_UNAVAILABLE,
            headers: json_content_type(),
            body: br#"{"error":"scene reloaded"}"#.to_vec(),
        }
    }

    /// The reject-only `502` form: any decode failure or unrepresentable
    /// response part folds here, NEVER a panic/OOM/hang (the reject-only
    /// decode-failure discipline; a bad-gateway status carries no body).
    fn bad_gateway() -> Self {
        Self {
            status: StatusCode::BAD_GATEWAY,
            headers: HeaderMap::new(),
            body: Vec::new(),
        }
    }

    /// The response status.
    pub fn status(&self) -> StatusCode {
        self.status
    }

    /// The response headers (BTreeMap-sourced, deterministic emission order).
    pub fn headers(&self) -> &HeaderMap {
        &self.headers
    }

    /// The response body bytes (borrowed, so tests need not consume an axum body).
    pub fn body_bytes(&self) -> &[u8] {
        &self.body
    }

    /// Materialise the owned parts into an `axum::response::Response` at the
    /// handler's return edge (38-02).
    pub fn into_axum_response(self) -> Response {
        let mut resp = Response::new(Body::from(self.body));
        *resp.status_mut() = self.status;
        *resp.headers_mut() = self.headers;
        resp
    }
}

impl IntoResponse for HttpResponse {
    fn into_response(self) -> Response {
        self.into_axum_response()
    }
}

/// A one-entry `application/json` header map for the host-synthesized responses.
fn json_content_type() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers
}

/// Decode the reply descriptor from UNTRUSTED `Effect::Reply.payload` bytes and
/// build the host response.
///
/// Reject-only: malformed / non-descriptor bytes, an out-of-range status, or a
/// header name/value the client cannot legally carry all fold to `502` — NEVER a
/// panic, OOM, or hang (the reject-only decode-failure trust-gate discipline).
pub fn descriptor_to_response(payload: &Item) -> HttpResponse {
    let Ok(desc) = serde_json::from_slice::<ResponseDescriptor>(&payload.0) else {
        // The bytes are not a descriptor — fold to a bad-gateway status.
        return HttpResponse::bad_gateway();
    };
    let Ok(status) = StatusCode::from_u16(desc.status) else {
        return HttpResponse::bad_gateway();
    };
    let mut headers = HeaderMap::new();
    // Iterate the source BTreeMap (lexical order) so header emission is
    // deterministic; an unrepresentable name/value folds the whole response.
    for (k, v) in &desc.headers {
        let (Ok(name), Ok(value)) = (HeaderName::from_bytes(k.as_bytes()), HeaderValue::from_str(v))
        else {
            return HttpResponse::bad_gateway();
        };
        headers.insert(name, value);
    }
    HttpResponse {
        status,
        headers,
        body: desc.body.into_bytes(),
    }
}

/// One accepted endpoint request, handed to the sim loop for a WireRequest mint +
/// a parked socket (38-03). The response-carrying parallel of
/// [`Ingress`](crate::ingress::webhook::Ingress): where the webhook forwards an
/// `ack: oneshot::Sender<()>` (idempotent 200), the endpoint forwards a
/// `respond: oneshot::Sender<HttpResponse>` whose fulfilment IS the caller's
/// answer. A NEW struct (not an `Ingress` variant) — the two ingress kinds carry
/// disjoint payloads and cross on disjoint channels.
pub struct EndpointIngress {
    /// The resolved endpoint node this request targets (from the route table).
    pub target: NodeId,
    /// The board the table that gave `target` was published for
    /// ([`RouteTable::board`](crate::ingress::webhook::RouteTable::board)).
    pub board: u64,
    /// The request as an opaque JSON envelope `{method,path,query,headers,body}`
    /// — carried verbatim as the injected item's bytes. NEVER decoded/trusted as
    /// structure by the sim; it is opaque `Item` bytes the moment it crosses in.
    pub envelope: Vec<u8>,
    /// The parked caller's socket: resolving this with an [`HttpResponse`] answers
    /// the held-open connection exactly once (38-03). A DROPPED sender resolves the
    /// parked socket to a deterministic 503 (Pitfall 1), never a hang.
    pub respond: oneshot::Sender<HttpResponse>,
}

/// The capacity of the BOUNDED endpoint-ingress channel (F2 — DoS fence).
///
/// The endpoint channel is bounded (NOT `unbounded`) so a flood of
/// `POST /endpoint/{known}` while the sim is Frozen/Draining — when neither
/// `acquire_input` (the parked-socket cap) nor the deadline sweep runs — cannot grow
/// the host's memory without limit. Past this many un-drained accepted requests the
/// handler `try_send` fails and answers a deterministic `503` instead of enqueuing
/// unboundedly or hanging the caller forever. Sized to the parked-socket cap so a
/// request that made it through the channel can still find a parking slot in the
/// common case; the two caps together bound the in-memory backlog.
pub const ENDPOINT_INGRESS_CAPACITY: usize = 256;

/// The channel the axum endpoint handler hands each accepted request to the sim
/// loop on (the response-carrying parallel of
/// [`IngressTx`](crate::ingress::webhook::IngressTx)).
///
/// BOUNDED at [`ENDPOINT_INGRESS_CAPACITY`] (F2): a full channel yields a
/// deterministic `503` from `try_send`, never unbounded growth while the sim is
/// paused. (The webhook `IngressTx` is likewise bounded as of ROBUST-01 / Phase 41,
/// which added a bounded channel plus a fast-503-while-not-Playing gate; both front
/// doors now refuse rather than accumulate while the sim is Draining/Frozen.)
pub type EndpointTx = Sender<EndpointIngress>;

/// Build the opaque JSON request envelope from the untrusted request parts. The
/// bytes are NEVER decoded or trusted as structure downstream — they cross into
/// the sim as opaque `Item` bytes. The bytes come from
/// [`encode_request_envelope`], so a scripted request produces the same ones.
fn build_request_envelope(method: &Method, uri: &Uri, headers: &HeaderMap, body: &[u8]) -> Vec<u8> {
    let mut header_map: BTreeMap<String, String> = BTreeMap::new();
    for (name, value) in headers {
        header_map.insert(
            name.as_str().to_owned(),
            String::from_utf8_lossy(value.as_bytes()).into_owned(),
        );
    }
    let envelope = RequestEnvelope {
        method: method.as_str().to_owned(),
        path: uri.path().to_owned(),
        query: uri.query().unwrap_or_default().to_owned(),
        headers: header_map,
        body: String::from_utf8_lossy(body).into_owned(),
    };
    encode_request_envelope(&envelope)
}

/// `POST /endpoint/{target}`: resolve the target label, build the request envelope,
/// forward an [`EndpointIngress`] to the sim loop, and PARK the caller's socket on
/// the `respond` oneshot until the grid computes the answer (ENDP-01).
///
/// Deterministic failure modes, never a hang or panic on untrusted input:
/// - unknown `{target}` (no live [`Node::Endpoint`](fabrico_core::state::Node)) →
///   `404`, no ingress forwarded;
/// - the sim-loop receiver gone (channel closed) → `503`;
/// - the `respond` sender DROPPED without a send (sim resolved elsewhere / gone) →
///   `503` via the `RecvError` guard (Pitfall 1), never a hang.
///
/// An oversized body is rejected by the SHARED [`RequestBodyLimitLayer`] before it
/// is ever buffered (the same layer the webhook uses — one server, one body cap).
///
/// `pub(crate)`: mounted only via `webhook_router`'s `post(endpoint)` inside this
/// crate; it takes the `pub(crate)` [`WebhookState`], so a wider visibility would
/// leak a private type.
pub(crate) async fn endpoint(
    State(state): State<WebhookState>,
    Path(target): Path<String>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    // The LATEST projected route snapshot for THIS request: a lock-free
    // `borrow().clone()` (a cheap `Arc` clone) of the immutable map the sim thread
    // last published. An Endpoint placed/deleted since the last request is reflected
    // here without ever mutating a shared map in place (ENDP-05).
    let routes = state.routes_rx.borrow().clone();
    // CROSS-DOOR GUARD (F1), NOW STRUCTURAL RATHER THAN A PREFIX TEST (72-07, SERVE-08).
    //
    // `/hook` and `/endpoint` share ONE unioned route map. Without a kind check,
    // `POST /endpoint/src-A` would resolve a SOURCE, park a socket, and log a spurious
    // WireRequest against it. Until SERVE-08 the check was `target.starts_with("ep-")`,
    // which worked only because every endpoint key was `ep-<as_ffi>`.
    //
    // THAT GUARD HAD TO GO, because the whole point of this phase is that the user
    // chooses the path and `/orders` does not start with `ep-`. Deleting a guard needs
    // the property it bought to be bought some other way, and here it is bought by the
    // KEY SHAPE: `endpoint_route_key` normalizes every endpoint key to exactly one
    // leading `/`, and a Source key is `src-<as_ffi>` with no slash at all. So the
    // lookup below CANNOT resolve a Source however the caller spells the target, and it
    // cannot even if a forged `.fab` gave a Route the path `src-1` (the normalization
    // re-adds the slash on the way into the map and on the way in here).
    //
    // ONE function builds the key on both sides: `project_routes` publishes with
    // `endpoint_route_key` and this looks up with it. Two format strings that happened
    // to agree would be the drift this closes.
    let Some(&node) = routes.get(&crate::sim_loop::endpoint_route_key(&target)) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    // GATE A, the endpoint's twin of the webhook door's (phase 90 review WR-A-01): while the
    // sim is not Playing (Draining, Frozen, or stopped for good after a fatal) the request is
    // refused at the door with the same 503 the sim thread gives a request it drains while
    // not Playing (`refuse_endpoint_ingress_while_not_playing`), so nothing is enqueued and
    // no caller waits on a sim that will not answer.
    if !state.is_playing.load(std::sync::atomic::Ordering::Acquire) {
        return HttpResponse::service_unavailable_503().into_axum_response();
    }
    let envelope = build_request_envelope(&method, &uri, &headers, &body);
    // Park the caller's socket on a response-carrying oneshot: the sim loop stores
    // `resp_tx` in the correlation registry at ingest (38-03) and resolves it once
    // the grid computes the reply.
    let (resp_tx, resp_rx) = oneshot::channel::<HttpResponse>();
    if state
        .endpoint_tx
        .try_send(EndpointIngress {
            target: node,
            // From the same snapshot as `node`, so the two can't disagree about the board.
            board: routes.board,
            envelope,
            respond: resp_tx,
        })
        .is_err()
    {
        // Either the BOUNDED channel is FULL — the sim is Frozen/Draining or simply
        // overloaded, so neither `acquire_input` nor the sweep is draining it — or the
        // sim loop's receiver was dropped. Both fold to a deterministic `503` via
        // `try_send` (never a hang-forever `await` and never unbounded growth, F2).
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    // Hold the connection open while the grid computes. A resolved `HttpResponse`
    // becomes the caller's answer; a DROPPED sender (`Err(RecvError)`) folds to a
    // deterministic 503 rather than hanging the socket forever (Pitfall 1).
    match resp_rx.await {
        Ok(resp) => resp.into_axum_response(),
        Err(_) => StatusCode::SERVICE_UNAVAILABLE.into_response(),
    }
}

#[cfg(test)]
mod response_tests {
    use super::*;

    fn descriptor_item(desc: &ResponseDescriptor) -> Item {
        Item(serde_json::to_vec(desc).expect("descriptor is plain serde data"))
    }

    #[test]
    fn descriptor_builds_response_with_status_headers_body() {
        let mut headers = BTreeMap::new();
        headers.insert("x-a".to_string(), "1".to_string());
        headers.insert("x-b".to_string(), "2".to_string());
        let desc = ResponseDescriptor {
            status: 201,
            headers,
            body: "hi".to_string(),
        };

        let resp = descriptor_to_response(&descriptor_item(&desc));

        assert_eq!(resp.status(), StatusCode::from_u16(201).unwrap());
        assert_eq!(resp.headers().get("x-a").unwrap(), "1");
        assert_eq!(resp.headers().get("x-b").unwrap(), "2");
        assert_eq!(resp.body_bytes(), b"hi");
    }

    #[test]
    fn headers_serialize_in_btreemap_lexical_order() {
        // BTreeMap guarantees lexical key order on serialize -> deterministic,
        // replay-stable header emission regardless of insertion order.
        let mut headers = BTreeMap::new();
        headers.insert("z-last".to_string(), "z".to_string());
        headers.insert("a-first".to_string(), "a".to_string());
        headers.insert("m-mid".to_string(), "m".to_string());
        let desc = ResponseDescriptor {
            status: 200,
            headers,
            body: String::new(),
        };

        let json = serde_json::to_string(&desc).unwrap();
        let a = json.find("a-first").unwrap();
        let m = json.find("m-mid").unwrap();
        let z = json.find("z-last").unwrap();
        assert!(a < m && m < z, "headers must serialize lexically: {json}");
    }

    #[test]
    fn out_of_range_status_folds_to_502_never_panics() {
        // 0 is below the valid 100..1000 range; 1000 is above it. Both fold to 502.
        for bad in [0u16, 1000u16] {
            let desc = ResponseDescriptor {
                status: bad,
                headers: BTreeMap::new(),
                body: "x".to_string(),
            };
            let resp = descriptor_to_response(&descriptor_item(&desc));
            assert_eq!(resp.status(), StatusCode::BAD_GATEWAY, "status {bad} -> 502");
        }
    }

    #[test]
    fn malformed_bytes_fold_to_502_never_panics() {
        let junk = Item(b"this is not a descriptor {".to_vec());
        let resp = descriptor_to_response(&junk);
        assert_eq!(resp.status(), StatusCode::BAD_GATEWAY);

        let empty = Item(Vec::new());
        assert_eq!(descriptor_to_response(&empty).status(), StatusCode::BAD_GATEWAY);
    }

    #[test]
    fn unrepresentable_header_folds_to_502() {
        // A newline in a header value cannot legally cross the boundary.
        let mut headers = BTreeMap::new();
        headers.insert("x-bad".to_string(), "line1\nline2".to_string());
        let desc = ResponseDescriptor {
            status: 200,
            headers,
            body: String::new(),
        };
        let resp = descriptor_to_response(&descriptor_item(&desc));
        assert_eq!(resp.status(), StatusCode::BAD_GATEWAY);
    }

    #[test]
    fn timeout_504_has_status_and_json_body() {
        let resp = HttpResponse::timeout_504();
        assert_eq!(resp.status(), StatusCode::GATEWAY_TIMEOUT);
        assert_eq!(resp.body_bytes(), br#"{"error":"timeout"}"#);
    }

    #[test]
    fn ok_json_wraps_bytes_as_200_body() {
        let resp = HttpResponse::ok_json(br#"{"k":1}"#.to_vec());
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(resp.body_bytes(), br#"{"k":1}"#);
    }
}

#[cfg(test)]
mod handler_tests {
    use super::*;
    use crate::ingress::webhook::{
        Ingress, RouteTable, RoutesRx, WEBHOOK_INGRESS_CAPACITY, webhook_router,
    };
    use axum::body::Body;
    use axum::http::Request;
    use std::sync::Arc;
    use std::sync::atomic::AtomicBool;
    use slotmap::SlotMap;
    use tokio::sync::mpsc::channel;
    use tokio::sync::watch;
    use tower::ServiceExt; // `oneshot`: drive the router with no bound socket.

    /// Mint a single real generational [`NodeId`] (key-minting only).
    fn a_node() -> NodeId {
        let mut alloc: SlotMap<NodeId, ()> = SlotMap::with_key();
        alloc.insert(())
    }

    /// A fixed always-Playing signal for the endpoint handler tests (Gate A open on
    /// the shared webhook route; these tests exercise the `/endpoint` door only).
    fn playing() -> Arc<AtomicBool> {
        Arc::new(AtomicBool::new(true))
    }

    /// A one-label live route table wrapped in a `watch` receiver (the sender is
    /// dropped: `borrow()` still yields the published value and the handler only
    /// ever borrows).
    /// A one-entry route map holding `key` VERBATIM.
    ///
    /// `key` is a ROUTE-MAP KEY, not a URL segment, and the difference is load-bearing
    /// since 72-07: an ENDPOINT key carries a leading slash (`/route-1`, `/orders`) and a
    /// SOURCE key never does (`src-9`). Normalizing here would be wrong in both
    /// directions - it would silently move a source key into the endpoint namespace, and
    /// the cross-door test below would then be asserting the opposite of what it says.
    /// So the caller spells the namespace and this inserts what it is given.
    fn watched(key: &str, node: NodeId) -> RoutesRx {
        watched_on_board(key, node, 0)
    }

    /// [`watched`], with the table published for board number `board`.
    fn watched_on_board(key: &str, node: NodeId, board: u64) -> RoutesRx {
        let mut routes = BTreeMap::new();
        routes.insert(key.to_owned(), node);
        let (_tx, rx) = watch::channel(Arc::new(RouteTable { board, routes }));
        rx
    }

    /// A throwaway webhook ingress sender (these tests only POST `/endpoint/...`).
    fn no_webhook_tx() -> crate::ingress::webhook::IngressTx {
        channel::<Ingress>(WEBHOOK_INGRESS_CAPACITY).0
    }

    #[tokio::test]
    async fn a_forwarded_endpoint_request_carries_the_stamp_of_the_table_it_read() {
        // The sim loop refuses a request by this number, so it has to be the number of the
        // table the node came from.
        let node = a_node();
        let (ep_tx, mut ep_rx) = channel::<EndpointIngress>(ENDPOINT_INGRESS_CAPACITY);
        let app = webhook_router(
            watched_on_board("/ep-1", node, 7),
            no_webhook_tx(),
            ep_tx,
            4096,
            playing(),
        );
        let drained = tokio::spawn(async move {
            let ing = ep_rx.recv().await.expect("an endpoint ingress");
            let _ = ing.respond.send(HttpResponse::reloaded_503());
            ing.board
        });

        let req = Request::builder()
            .method("POST")
            .uri("/endpoint/ep-1")
            .body(Body::from("x"))
            .expect("build request");
        app.oneshot(req).await.expect("route the request");
        assert_eq!(drained.await.expect("drain task"), 7);
    }

    #[tokio::test]
    async fn known_target_round_trips_a_resolved_response() {
        // A POST to a known ep- label forwards exactly one EndpointIngress carrying
        // the resolved node; when the sim resolves `respond` with an HttpResponse,
        // the caller gets that status + body (the parked socket is fulfilled).
        let node = a_node();
        let (ep_tx, mut ep_rx) = channel::<EndpointIngress>(ENDPOINT_INGRESS_CAPACITY);
        let app = webhook_router(watched("/ep-1", node), no_webhook_tx(), ep_tx, 4096, playing());

        // The sim's role: receive the ingress and resolve the parked socket.
        let sim = tokio::spawn(async move {
            let ing = ep_rx.recv().await.expect("an endpoint ingress");
            assert_eq!(ing.target, node, "the ep- label resolved to its node");
            let _ = ing.respond.send(HttpResponse::ok_json(br#"{"ok":true}"#.to_vec()));
            ing.envelope
        });

        let req = Request::builder()
            .method("POST")
            .uri("/endpoint/ep-1")
            .body(Body::from("payload"))
            .expect("build request");
        let resp = app.oneshot(req).await.expect("route the request");
        assert_eq!(resp.status(), StatusCode::OK, "the resolved response status");
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .expect("read body");
        assert_eq!(&body[..], br#"{"ok":true}"#, "the resolved response body");
        let _ = sim.await.expect("sim task");
    }

    #[tokio::test]
    async fn unknown_target_is_404_no_ingress() {
        // A POST to a label absent from the route table is 404 and forwards no
        // ingress (never mints a WireRequest for a non-existent endpoint).
        let (ep_tx, mut ep_rx) = channel::<EndpointIngress>(ENDPOINT_INGRESS_CAPACITY);
        let app = webhook_router(watched("/ep-1", a_node()), no_webhook_tx(), ep_tx, 4096, playing());

        let req = Request::builder()
            .method("POST")
            .uri("/endpoint/nope")
            .body(Body::from("x"))
            .expect("build request");
        let resp = app.oneshot(req).await.expect("route the request");
        assert_eq!(resp.status(), StatusCode::NOT_FOUND, "unknown target -> 404");
        assert!(
            ep_rx.try_recv().is_err(),
            "no ingress forwarded for an unknown target"
        );
    }

    #[tokio::test]
    async fn wrong_door_src_target_is_404_no_ingress() {
        // F1 cross-door guard: `/endpoint` never resolves a SOURCE. A POST naming a
        // live `src-<id>` key (present in the SHARED route map) must 404 and forward NO
        // ingress — never park a socket or mint a spurious WireRequest against a Source.
        //
        // WHAT REFUSES IT CHANGED IN 72-07, and the test did not have to. It used to be
        // a `target.starts_with("ep-")` prefix guard, which had to go the moment a user
        // could type `/orders` as a path. It is now the KEY SHAPE: the handler looks up
        // `endpoint_route_key(target)`, which always leads with a slash, and a source key
        // never does, so `/src-9` simply is not in the map. That is structural rather
        // than a naming convention, which matters because the naming convention stopped
        // being safe once `/src-9` became a legal path a user could type.
        let src = a_node();
        let (ep_tx, mut ep_rx) = channel::<EndpointIngress>(ENDPOINT_INGRESS_CAPACITY);
        let app = webhook_router(watched("src-9", src), no_webhook_tx(), ep_tx, 4096, playing());

        let req = Request::builder()
            .method("POST")
            .uri("/endpoint/src-9")
            .body(Body::from("x"))
            .expect("build request");
        let resp = app.oneshot(req).await.expect("route the request");
        assert_eq!(
            resp.status(),
            StatusCode::NOT_FOUND,
            "a wrong-door src- target on /endpoint is 404 (F1)"
        );
        assert!(
            ep_rx.try_recv().is_err(),
            "no ingress forwarded (no socket parked, no WireRequest) for a wrong-door src- target"
        );
    }

    #[tokio::test]
    async fn closed_ingress_is_503() {
        // If the sim-loop receiver is gone (channel closed), the send fails and the
        // handler answers a deterministic 503.
        let node = a_node();
        let (ep_tx, ep_rx) = channel::<EndpointIngress>(ENDPOINT_INGRESS_CAPACITY);
        drop(ep_rx); // the sim is gone before the request arrives.
        let app = webhook_router(watched("/ep-1", node), no_webhook_tx(), ep_tx, 4096, playing());

        let req = Request::builder()
            .method("POST")
            .uri("/endpoint/ep-1")
            .body(Body::from("x"))
            .expect("build request");
        let resp = app.oneshot(req).await.expect("route the request");
        assert_eq!(
            resp.status(),
            StatusCode::SERVICE_UNAVAILABLE,
            "a closed ingress -> 503"
        );
    }

    #[tokio::test]
    async fn saturated_channel_is_503_no_unbounded_growth() {
        // F2: the endpoint ingress channel is BOUNDED. When it is already full — the
        // sim is Frozen/Draining (or simply overloaded) and not draining it — a new
        // request `try_send`s, fails, and gets a deterministic 503 INSTEAD of growing
        // the channel without bound or hanging the caller forever. Prove it with a
        // capacity-1 channel pre-filled to saturation: the POST cannot enqueue and is
        // refused immediately (no park, no unbounded queue).
        let node = a_node();
        // Capacity 1; the receiver is held but NEVER drained (models a paused sim).
        let (ep_tx, _ep_rx) = channel::<EndpointIngress>(1);
        // Occupy the single slot so the channel is at capacity before the request.
        let (fill_tx, _fill_rx) = oneshot::channel::<HttpResponse>();
        ep_tx
            .try_send(EndpointIngress {
                target: node,
                board: 0,
                envelope: Vec::new(),
                respond: fill_tx,
            })
            .expect("pre-fill the one channel slot");

        // The router shares the SAME saturated sender (a cheap clone).
        let app = webhook_router(watched("/ep-1", node), no_webhook_tx(), ep_tx.clone(), 4096, playing());
        let req = Request::builder()
            .method("POST")
            .uri("/endpoint/ep-1")
            .body(Body::from("x"))
            .expect("build request");
        let resp = app.oneshot(req).await.expect("route the request");
        assert_eq!(
            resp.status(),
            StatusCode::SERVICE_UNAVAILABLE,
            "an over-capacity request is 503, never an unbounded enqueue or a hang (F2)"
        );
        // The channel never grew past its capacity of 1 (the refused request enqueued
        // nothing): only the pre-fill occupies it.
        assert_eq!(ep_tx.capacity(), 0, "the bounded channel stayed at capacity (no growth)");
    }

    #[tokio::test]
    async fn dropped_respond_sender_is_503_never_hangs() {
        // Pitfall 1: the socket is parked, then the `respond` sender is DROPPED
        // without a send (the sim resolved the correlation elsewhere, or is gone).
        // `resp_rx.await` yields `Err(RecvError)` -> a deterministic 503, NEVER a
        // hang. The test completing at all is the no-hang proof.
        let node = a_node();
        let (ep_tx, mut ep_rx) = channel::<EndpointIngress>(ENDPOINT_INGRESS_CAPACITY);
        let app = webhook_router(watched("/ep-1", node), no_webhook_tx(), ep_tx, 4096, playing());

        let sim = tokio::spawn(async move {
            let ing = ep_rx.recv().await.expect("an endpoint ingress");
            drop(ing.respond); // park, then drop the sender.
        });

        let req = Request::builder()
            .method("POST")
            .uri("/endpoint/ep-1")
            .body(Body::from("x"))
            .expect("build request");
        let resp = app.oneshot(req).await.expect("route the request");
        assert_eq!(
            resp.status(),
            StatusCode::SERVICE_UNAVAILABLE,
            "a dropped respond sender -> 503, never a hang"
        );
        sim.await.expect("sim task");
    }

    #[tokio::test]
    async fn oversized_body_is_413() {
        // The SHARED RequestBodyLimitLayer rejects an oversized body before the
        // handler runs — the same cap the webhook uses (one server, one body cap).
        let (ep_tx, _ep_rx) = channel::<EndpointIngress>(ENDPOINT_INGRESS_CAPACITY);
        let limit = 8usize;
        let app = webhook_router(watched("/ep-1", a_node()), no_webhook_tx(), ep_tx, limit, playing());

        let req = Request::builder()
            .method("POST")
            .uri("/endpoint/ep-1")
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
    async fn request_envelope_is_valid_json_with_five_keys() {
        // The forwarded envelope is valid JSON with method/path/query/headers/body
        // (branch-future-proof though v1 is POST-only). Deterministic BTreeMap
        // headers.
        let node = a_node();
        let (ep_tx, mut ep_rx) = channel::<EndpointIngress>(ENDPOINT_INGRESS_CAPACITY);
        let app = webhook_router(watched("/ep-1", node), no_webhook_tx(), ep_tx, 4096, playing());

        let sim = tokio::spawn(async move {
            let ing = ep_rx.recv().await.expect("an endpoint ingress");
            let _ = ing.respond.send(HttpResponse::ok_json(Vec::new()));
            ing.envelope
        });

        let req = Request::builder()
            .method("POST")
            .uri("/endpoint/ep-1?foo=bar&baz=qux")
            .header("x-test", "1")
            .body(Body::from("hello"))
            .expect("build request");
        let resp = app.oneshot(req).await.expect("route the request");
        assert_eq!(resp.status(), StatusCode::OK);

        let envelope = sim.await.expect("sim task");
        let v: serde_json::Value =
            serde_json::from_slice(&envelope).expect("the envelope is valid JSON");
        assert_eq!(v["method"], "POST", "method key");
        assert_eq!(v["path"], "/endpoint/ep-1", "path key");
        assert_eq!(v["query"], "foo=bar&baz=qux", "query key");
        assert!(v["headers"].is_object(), "headers key is an object");
        assert_eq!(v["headers"]["x-test"], "1", "header value carried");
        assert_eq!(v["body"], "hello", "body key");
    }
}
