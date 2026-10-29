//! Host configuration: the single home for host-side settings the logged
//! `Effect` payload deliberately omits, today the webhook bind address.
//! (Timer sources are NOT startup config: they are installed per-host via
//! `Host::with_timers`, strictly AFTER any scene seeding — the
//! timers-after-seeding contract in `demo_scene.rs`. A startup-config timer
//! field existed once, was consumed by nothing, and was deleted per the pre-v1
//! clean-break policy — 20-review WR-04.)
//!
//! # Host config never reaches the log (Pitfall 6)
//!
//! [`HostConfig`] is built host-side at startup and lives ONLY in this crate's
//! memory. It is **never** serialized into an `Event`/snapshot and so never
//! reaches `fabrico_core`'s `append_event`. The analog is
//! `RedbStore::open(path)` (`persist.rs:191`): an explicit, caller-provided
//! input, never ambient authority and never logged.
//!
//! These types deliberately do NOT derive `serde::Serialize` toward the event
//! log. Host config describes this machine, not the factory: a replay on another
//! machine must reproduce the same state without it. The host holds no
//! credentials today (the SMTP settings left with the mail sender in phase 85);
//! a future secret added here inherits the same rule and needs a redacting
//! `Debug`, because `HostConfig` derives one.

use std::net::SocketAddr;

use fabrico_core::ids::NodeId;

/// All host-side configuration. Built at startup; never serialized into the
/// event log (see the module docs).
#[derive(Clone, Debug)]
pub struct HostConfig {
    /// The address the webhook source binds. Loopback-only this phase
    /// (`127.0.0.1:PORT`); a public tunnel is deferred to Phase 6.
    pub webhook_addr: SocketAddr,
}

/// A tick-interval timer source: every `interval` ticks, inject one event into
/// `target`.
#[derive(Clone, Debug)]
pub struct TimerConfig {
    /// The source node the timer injects into.
    pub target: NodeId,
    /// The tick period between injections.
    pub interval: u64,
    /// The item payload every injection from this timer carries: plain data,
    /// constant per timer, byte-stable across runs and replays — the same
    /// determinism contract the old fixed marker byte had, now caller-chosen so
    /// a JSON-parsing factory receives valid input (e.g. canonical `b"{}"`)
    /// instead of faulting on every fire (Finding 2 / LIVE-05).
    pub item: Vec<u8>,
}
