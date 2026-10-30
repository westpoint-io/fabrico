//! The Fabrico engine without a desktop host.
//!
//! This crate loads a board, runs it tick by tick on the deterministic core and builds the
//! render packets, using plain data and no I/O. The desktop host and any other front end sit
//! on top of it. `tests/deps_headless.rs` fails the build if an async runtime, an HTTP stack, a
//! file database or the desktop shell enters its dependency tree.

#![forbid(unsafe_code)]
#![deny(clippy::disallowed_types, clippy::disallowed_methods)]
#![warn(clippy::all)]

pub mod board;
pub mod engine;
pub mod envelope;
pub mod gesture;
pub mod render_packet;
pub mod timer;
