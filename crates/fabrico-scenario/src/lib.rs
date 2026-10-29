//! `fabrico-scenario` — THE headless Rust scenario-test harness.
//!
//! This crate builds, drives, and digests deterministic `Core` scenarios entirely
//! from Rust: no renderer, no host, no async runtime, no desktop shell. Its normal
//! dependency tree is fenced by `tests/deps_headless.rs` (the `deps_are_headless`
//! cargo-tree FORBIDDEN check), exactly like `fabrico-command`.
//!
//! Single-digest-path rule (threat T-13-HASH): [`oracle::tick_hash`] is the ONE
//! public state-equality digest in the whole project — `blake3(snapshot(core))`.
//! It is promoted verbatim from `fabrico-core`'s test-private oracle, and
//! `fabrico-core`'s test common module re-exports it, so there is exactly ONE
//! semantic digest path. Never fork it or add a second/field-walking digest.

pub mod determinism;
pub mod fixture;
pub mod oracle;
pub mod scene;

pub use determinism::*;
pub use fixture::Scenario;
pub use oracle::tick_hash;
pub use scene::{Handle, Scene, StateSummary};
