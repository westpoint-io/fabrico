//! `fabrico-core` — the headless, deterministic fixed-tick simulation core.
//!
//! The whole crate is structured so determinism is *structurally impossible to
//! violate*: the only non-pure input (randomness) arrives through a single `Ctx`
//! capability object, and four clippy lints (`disallowed-types` /
//! `disallowed-methods`, defined in the workspace-root `clippy.toml`) hard-deny
//! floats, `HashMap`/`HashSet`, the ambient wall clock, and IO/`thread_rng`
//! inside the crate. Wired to `cargo clippy --all-targets -- -D warnings`, a
//! determinism-killer fails the build (SC#5).
//!
//! Module bodies are filled by later plans in phase 01; this plan establishes
//! the flat module skeleton and the enforcement spine.
#![forbid(unsafe_code)]
#![deny(clippy::disallowed_types, clippy::disallowed_methods)]
#![warn(clippy::all)]

pub mod fixedpoint;
pub mod rng;
pub mod ids;
pub mod event;
pub mod edit;
pub mod command;
pub mod persist;
pub mod scheduler;
pub mod state;
pub mod machine;
pub mod fault;
pub mod belt;
pub mod belt_slots;
pub mod admit;
pub mod wire;
pub mod tee;
pub mod balancer;
pub mod merge;
pub mod router;
pub mod factory;
pub mod sink;
pub mod manual_inject;
pub mod tick;
pub mod core;
pub mod snapshot;
