//! Ingress — the ways the outside world enters the sim as logged events:
//! `seen_set` (delivery-id dedup), `webhook` (the axum listener), and `timer`
//! (tick-interval source).

pub mod endpoint;
pub mod seen_set;
pub mod webhook;
pub mod timer;
