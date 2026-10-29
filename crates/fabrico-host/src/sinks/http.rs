//! The `Effect::Http` sink: a reqwest request carrying the `CommandId` as an
//! `Idempotency-Key` header (SINK-03) — proves the executor contract is generic
//! over arbitrary outbound effects.
//!
//! The request body is the per-item payload bytes; the target URL and the verb
//! are routing intent from the logged `Effect`. Any auth would be overlaid from
//! host config at dispatch time (never from the `Effect`). The provider result
//! folds into an `Outcome` the driver stamps into a logged `CommandResult`
//! (EXEC-02): a 2xx is `Success`; a non-2xx status, a transport error, or a
//! timeout is `Failure`.
//!
//! **THE VERB USED TO BE IGNORED HERE, AND THAT WAS THE DEFECT.** Every layer
//! above this one carried [`HttpMethod`] faithfully — the config panel, the
//! wire encoding, the certified edit log, the frozen `Effect` — and this
//! function hard-coded `client.post(url)`, so a user who selected DELETE fired
//! a POST at a live third-party endpoint. Silently doing the *wrong* thing on a
//! real network call is worse than refusing, which is why this was fixed ahead
//! of the unreachable-email gap it was filed behind.

use std::time::Duration;

use fabrico_core::command::{Command, Outcome};
use fabrico_core::state::HttpMethod;

use crate::executor::command_id_string;

/// Map the logged [`HttpMethod`] onto the reqwest verb.
///
/// **Exhaustive on purpose — no wildcard arm.** A new `HttpMethod` variant must
/// fail this build rather than fall through to a default verb, because the
/// failure mode this whole function exists to fix was exactly a silent
/// substitution of one verb for another.
fn verb(method: HttpMethod) -> reqwest::Method {
    match method {
        HttpMethod::Get => reqwest::Method::GET,
        HttpMethod::Post => reqwest::Method::POST,
        HttpMethod::Put => reqwest::Method::PUT,
        HttpMethod::Patch => reqwest::Method::PATCH,
        HttpMethod::Delete => reqwest::Method::DELETE,
    }
}

/// Whether this verb carries the item payload as a request body.
///
/// POST, PUT and PATCH carry the payload. GET and DELETE are dispatched
/// bodyless: a GET with a `Content-Length` is accepted by the spec but rejected
/// or mishandled by enough real servers that sending one would trade a visible
/// bug for an intermittent one.
fn carries_body(method: HttpMethod) -> bool {
    match method {
        HttpMethod::Post | HttpMethod::Put | HttpMethod::Patch => true,
        HttpMethod::Get | HttpMethod::Delete => false,
    }
}

/// The default request timeout for the HTTP sink.
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

/// Build the shared reqwest client (built once, reused for every dispatch).
///
/// rustls TLS, with a bounded request timeout so a hung endpoint folds to a
/// `Failure` rather than blocking an executor task forever.
///
/// # Panics
/// Panics only if the TLS backend cannot be initialised, which indicates a
/// broken build environment rather than a runtime condition.
#[must_use]
pub fn default_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(DEFAULT_TIMEOUT)
        .build()
        .expect("reqwest client builds with rustls")
}

/// Send `body` to `url` using the logged `method`, stamping the deterministic
/// `CommandId` idempotency token as the `Idempotency-Key` header, and fold the
/// result into an `Outcome`.
///
/// - 2xx response → `Outcome::Success`.
/// - non-2xx status → `Outcome::Failure`.
/// - timeout / transport error → `Outcome::Failure`.
///
/// The `Idempotency-Key` rides on every verb, including the safe ones. It is
/// meaningless on a GET and harmless there, and making it unconditional means
/// the header cannot go missing because a verb was added to the wrong list.
pub async fn dispatch_http(
    client: &reqwest::Client,
    cmd: &Command,
    url: &str,
    body: &[u8],
    method: HttpMethod,
) -> Outcome {
    let mut req = client
        .request(verb(method), url)
        .header("Idempotency-Key", command_id_string(&cmd.id));
    if carries_body(method) {
        req = req.body(body.to_vec());
    }

    let result = req
        .send()
        .await
        .and_then(reqwest::Response::error_for_status);

    match result {
        Ok(_resp) => Outcome::Success,
        // A timeout is a distinct shape but folds to the same Failure for v1;
        // the explicit arm documents the EXEC-03-adjacent timeout case.
        Err(e) if e.is_timeout() => Outcome::Failure,
        Err(_e) => Outcome::Failure,
    }
}
