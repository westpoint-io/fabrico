//! The request envelope: the JSON bytes an HTTP request becomes when it enters the sim as an
//! opaque item.
//!
//! The desktop host's endpoint builds one from a real request, and a board with no host can
//! build one from a scripted request. Both go through [`encode_request_envelope`], so the two
//! produce the same bytes.

use std::collections::BTreeMap;

use serde::Serialize;

/// The default reply deadline for an endpoint request, in logical ticks:
/// `deadline_tick = tick_at_ingress + DEFAULT_ENDPOINT_DEADLINE_TICKS`. That is about 5 seconds
/// at the live rate of about 62.5 ticks a second, and the value is tunable. This is logged data
/// the per-tick sweep compares against `core.tick`, never a wall-clock duration, because the
/// determinism of the reply path rests on the deadline being a tick count.
pub const DEFAULT_ENDPOINT_DEADLINE_TICKS: u64 = 300;

/// The JSON request envelope, forwarded as opaque `Item` bytes. The headers are a `BTreeMap`
/// so the serialized envelope is order-stable. The field order below is the order of the JSON
/// keys, so reordering the fields changes the bytes every Factory reads and every replay
/// compares.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct RequestEnvelope {
    /// The HTTP method string (always `POST` today).
    pub method: String,
    /// The request path (for example `/endpoint/route-1`).
    pub path: String,
    /// The raw query string (empty when absent).
    pub query: String,
    /// Request headers, in lexical order. Duplicate names collapse to the last value in
    /// iteration order.
    pub headers: BTreeMap<String, String>,
    /// The body as UTF-8 (lossy).
    pub body: String,
}

/// Encode an envelope to its item bytes. Serializing this plain data can't realistically fail,
/// and an impossible failure folds to empty bytes for the sim's reject-only decode to handle,
/// never a panic.
#[must_use]
pub fn encode_request_envelope(envelope: &RequestEnvelope) -> Vec<u8> {
    serde_json::to_vec(envelope).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The bytes are the contract between a real request and a scripted one, so they are
    /// pinned to a literal. Reordering a field in the struct fails here by name.
    #[test]
    fn an_envelope_encodes_to_these_exact_bytes() {
        let envelope = RequestEnvelope {
            method: "POST".to_owned(),
            path: "/endpoint/route-1".to_owned(),
            query: String::new(),
            headers: BTreeMap::from([
                ("x-trace".to_owned(), "abc".to_owned()),
                ("content-type".to_owned(), "application/json".to_owned()),
            ]),
            body: r#"{"a":1}"#.to_owned(),
        };

        let bytes = encode_request_envelope(&envelope);

        assert_eq!(
            String::from_utf8(bytes).expect("the envelope is UTF-8"),
            r#"{"method":"POST","path":"/endpoint/route-1","query":"","headers":{"content-type":"application/json","x-trace":"abc"},"body":"{\"a\":1}"}"#,
        );
    }
}
