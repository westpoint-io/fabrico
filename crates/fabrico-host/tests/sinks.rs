//! Integration coverage for the two effect sinks behind the one shared
//! dispatch contract (SINK-01/03, EXEC-02). The email sink (SINK-02) and its
//! offline capture case left with the mail sender in phase 85.
//!
//! - `http_loopback` / `http_500_*` / `http_timeout_*`: a real reqwest request
//!   against an in-process axum server bound to `127.0.0.1:0` (an ephemeral
//!   loopback port — never the public network). Proves the 2xx→Success,
//!   non-2xx→Failure, timeout→Failure mapping and that the server observed the
//!   `Idempotency-Key` equal to the CommandId token.
//! - `http_dispatches_the_logged_verb`: every `HttpMethod` variant arrives as
//!   itself. **The routes here are registered with `any`, not `post`, and that
//!   is load-bearing.** They used to be `post`-only with no assertion reading
//!   the request method, which is precisely why the host hard-coding POST for
//!   every verb survived this suite: a POST-that-should-have-been-DELETE was
//!   indistinguishable from a correct dispatch. A route that only accepts the
//!   verb under test cannot detect a substituted one.
//! - `http_result_folds_back`: the dispatched `Outcome` is exactly what a driver
//!   stamps into a logged `ResultEvent` (EXEC-02 — the result returns off-thread).
//! - `debug_through_sink`: the I/O-free debug sink, exercised through the public
//!   sink API.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::{
    Router,
    extract::State,
    http::{HeaderMap, Method, StatusCode},
    routing::any,
};
use fabrico_core::command::{Command, EVENT_VERSION, Effect, Outcome, ResultEvent};
use fabrico_core::ids::NodeId;
use fabrico_core::state::HttpMethod;
use fabrico_host::executor::command_id_string;
use fabrico_host::sinks::debug::dispatch_debug;
use fabrico_host::sinks::http::{default_client, dispatch_http};
use slotmap::SlotMap;

/// Shared slot recording the last `Idempotency-Key` the server observed.
type SeenKey = Arc<Mutex<Option<String>>>;

/// Shared slot recording the last request METHOD the server observed, so a
/// substituted verb is detectable rather than silently accepted.
type SeenMethod = Arc<Mutex<Option<String>>>;

/// What the loopback server observed on its most recent request.
#[derive(Clone)]
struct Observed {
    key: SeenKey,
    method: SeenMethod,
}

fn mint_node() -> NodeId {
    let mut alloc: SlotMap<NodeId, ()> = SlotMap::with_key();
    alloc.insert(())
}

fn http_command(node: NodeId, url: &str, body: &[u8]) -> Command {
    Command {
        event_version: EVENT_VERSION,
        id: (5, node, 0),
        partition: 0,
        effect: Effect::Http {
            url: url.to_owned(),
            body: body.to_vec(),
            method: HttpMethod::Post,
        },
        deadline: 100,
    }
}

async fn ok_handler(State(obs): State<Observed>, method: Method, headers: HeaderMap) -> StatusCode {
    if let Some(v) = headers.get("idempotency-key").and_then(|v| v.to_str().ok()) {
        *obs.key.lock().expect("seen mutex") = Some(v.to_owned());
    }
    *obs.method.lock().expect("method mutex") = Some(method.as_str().to_owned());
    StatusCode::OK
}

async fn fail_handler() -> StatusCode {
    StatusCode::INTERNAL_SERVER_ERROR
}

async fn slow_handler() -> StatusCode {
    // Sleep well past the short client timeout used in the timeout test.
    tokio::time::sleep(Duration::from_secs(2)).await;
    StatusCode::OK
}

/// Spin an in-process axum server on an ephemeral loopback port. Returns the
/// bound base URL (e.g. `http://127.0.0.1:54321`) and what it observed.
///
/// Routes are `any`, never `post`: see the module header. A verb-specific route
/// would 405 the very substitution this suite exists to catch, turning a
/// wrong-verb bug into an unrelated-looking transport failure.
async fn spawn_loopback() -> (String, Observed) {
    let obs = Observed {
        key: Arc::new(Mutex::new(None)),
        method: Arc::new(Mutex::new(None)),
    };
    let app = Router::new()
        .route("/ok", any(ok_handler))
        .route("/fail", any(fail_handler))
        .route("/slow", any(slow_handler))
        .with_state(obs.clone());

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind loopback");
    let addr = listener.local_addr().expect("local addr");
    tokio::spawn(async move {
        axum::serve(listener, app).await.expect("serve");
    });
    (format!("http://{addr}"), obs)
}

#[tokio::test]
async fn http_loopback() {
    let (base, obs) = spawn_loopback().await;
    let client = default_client();
    let node = mint_node();
    let cmd = http_command(node, &format!("{base}/ok"), b"payload");

    // 200 route → Success.
    assert_eq!(
        dispatch_http(&client, &cmd, &format!("{base}/ok"), b"payload", HttpMethod::Post).await,
        Outcome::Success
    );
    // The server observed the Idempotency-Key == the CommandId token.
    let observed = obs.key.lock().expect("seen mutex").clone();
    assert_eq!(observed.as_deref(), Some(command_id_string(&cmd.id).as_str()));
}

/// EVERY `HttpMethod` VARIANT ARRIVES AS ITSELF.
///
/// This is the test whose absence let the defect ship. The host destructured
/// the verb as `method: _` under a comment saying it was inert "until Phase
/// 39", Phase 39 shipped on 2026-07-18, and the placeholder outlived it by four
/// months — so a user selecting DELETE fired a POST at whatever endpoint they
/// had typed in. Every layer above the host carried the verb correctly; only
/// the last hop dropped it, and no assertion anywhere read a request method.
///
/// Watched RED first against the pre-fix host: with `client.post(url)`
/// hard-coded, all five iterations observe "POST" and four of the five
/// assertions fail naming the expected verb.
#[tokio::test]
async fn http_dispatches_the_logged_verb() {
    let (base, obs) = spawn_loopback().await;
    let client = default_client();

    for (method, expected) in [
        (HttpMethod::Get, "GET"),
        (HttpMethod::Post, "POST"),
        (HttpMethod::Put, "PUT"),
        (HttpMethod::Patch, "PATCH"),
        (HttpMethod::Delete, "DELETE"),
    ] {
        let cmd = http_command(mint_node(), &format!("{base}/ok"), b"payload");
        assert_eq!(
            dispatch_http(&client, &cmd, &format!("{base}/ok"), b"payload", method).await,
            Outcome::Success,
            "{expected} against the 200 route folds to Success"
        );
        assert_eq!(
            obs.method.lock().expect("method mutex").as_deref(),
            Some(expected),
            "the server observed {expected}, not a substituted verb"
        );
        // The idempotency token rides on every verb, safe ones included.
        assert_eq!(
            obs.key.lock().expect("seen mutex").as_deref(),
            Some(command_id_string(&cmd.id).as_str()),
            "{expected} still carries the Idempotency-Key"
        );
    }
}

#[tokio::test]
async fn http_500_maps_to_failure() {
    let (base, _obs) = spawn_loopback().await;
    let client = default_client();
    let cmd = http_command(mint_node(), &format!("{base}/fail"), b"x");
    // 500 route → Failure.
    assert_eq!(
        dispatch_http(&client, &cmd, &format!("{base}/fail"), b"x", HttpMethod::Post).await,
        Outcome::Failure
    );
}

#[tokio::test]
async fn http_timeout_maps_to_failure() {
    let (base, _obs) = spawn_loopback().await;
    // A deliberately tiny timeout so the /slow route (2s) trips is_timeout.
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(200))
        .build()
        .expect("client");
    let cmd = http_command(mint_node(), &format!("{base}/slow"), b"x");
    assert_eq!(
        dispatch_http(&client, &cmd, &format!("{base}/slow"), b"x", HttpMethod::Post).await,
        Outcome::Failure
    );
}

#[tokio::test]
async fn http_result_folds_back() {
    let (base, _obs) = spawn_loopback().await;
    let client = default_client();
    let cmd = http_command(mint_node(), &format!("{base}/ok"), b"payload");

    // The dispatched Outcome is exactly what a driver stamps into a logged
    // ResultEvent at a later tick (EXEC-02 — result returns off-thread).
    let outcome = dispatch_http(&client, &cmd, &format!("{base}/ok"), b"payload", HttpMethod::Post).await;
    let result = ResultEvent {
        command_id: cmd.id,
        tick: cmd.deadline,
        outcome,
    };
    assert_eq!(result.outcome, Outcome::Success);
    assert_eq!(result.command_id, cmd.id);

    // And it round-trips through the wire format the log would persist.
    let bytes = postcard::to_allocvec(&result).expect("serialize result");
    let restored: ResultEvent = postcard::from_bytes(&bytes).expect("deserialize result");
    assert_eq!(restored, result);
}

#[test]
fn debug_through_sink() {
    // The debug sink (SINK-01): in-host, no socket, always Success.
    assert_eq!(dispatch_debug(b"inspect me"), Outcome::Success);
}
