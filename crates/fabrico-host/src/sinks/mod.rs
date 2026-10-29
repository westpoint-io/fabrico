//! Effect sinks: the `Dispatch` handlers behind the one shared executor
//! contract, `debug` (in-host, no I/O) and `http` (reqwest).
//!
//! Both are reached through the single [`crate::executor::dispatch`] router
//! that matches on `cmd.effect` and folds the provider result into an
//! `fabrico_core::command::Outcome`. Neither returns a typed error: the debug
//! sink is infallible, and the http sink folds every transport, timeout and
//! status failure straight into `Outcome::Failure`.

pub mod debug;
pub mod http;
