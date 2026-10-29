//! `fabrico-host` — the project's first and only home for I/O.
//!
//! `fabrico-core` is the headless, structurally-deterministic sim: its crate
//! root opts into a hard determinism clippy gate (see `fabrico-core/src/lib.rs`)
//! that bans floats, `HashMap`/`HashSet`, the ambient wall clock, and all IO.
//! Those lints sit at clippy's default `allow` level and are only promoted to
//! `deny` by that crate-local attribute — and crate attributes do NOT cross the
//! crate boundary.
//!
//! This crate is the deliberate INVERSE: it OMITS that determinism gate so it
//! may use tokio, axum, reqwest, `SystemTime`, and `TcpListener` freely
//! — while still staying `clippy::all`-clean. All side effects (the real
//! "launch the rocket") live here, off the single-threaded deterministic sim,
//! and re-enter the core only as logged events.
//!
//! The module tree below is declared in full now (Wave-2+ plans fill the
//! still-stubbed bodies without ever editing this file): `config` (host-only
//! settings), `executor`/`driver`/`ledger` (the dispatch loop + write-ahead
//! ledger), `sinks` (debug/http effect handlers), and `ingress`
//! (seen_set/webhook/timer).
#![forbid(unsafe_code)]
#![warn(clippy::all)]
// NOTE: this crate intentionally does NOT opt into the determinism deny-gate
// that fabrico-core's crate root carries — that gate is crate-scoped to
// fabrico-core, and host I/O lives outside it (see the module doc above).

pub mod config;
pub mod command_error_view;
pub mod config_view;
pub mod demo_scene;
pub mod executor;
pub mod gesture_verdict;
pub mod driver;
pub mod input_apply;
pub mod ledger;
pub mod project;
pub mod registry;
pub mod render_packet;
pub mod sim_fatal;
pub mod sim_loop;
pub mod sinks;
pub mod transport_ws;
pub mod ingress;
