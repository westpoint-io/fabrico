//! The async executor: the ONE shared dispatch contract every sink routes
//! through (command → effect → `Outcome`).
//!
//! [`dispatch`] matches on `cmd.effect` and hands off to the matching sink
//! (`Effect::Debug` to debug, `Effect::Http` to http), folding the provider
//! result into an `fabrico_core::command::Outcome` that a later-tick driver
//! stamps into a logged `CommandResult` (EXEC-02). Host-side settings come from
//! [`crate::config::HostConfig`] at dispatch time, never from the logged
//! `Effect` (Pitfall 6). There is no mail effect: phase 85 removed the Email
//! target from the core (plan 85-05) after removing the host's mail sender (85-04).
//!
//! [`command_id_string`] derives the single deterministic idempotency token from
//! the logged `CommandId = (tick, node, seq)`, threaded into the HTTP
//! `Idempotency-Key` header. No second token is ever minted
//! ([`fabrico_core::ids::CommandId`] is already the deterministic key).
//!
//! [`CountingExecutor`] is the replay-muting probe: a `Dispatch` impl that counts
//! calls and performs no real effect, used by a later plan to prove the executor
//! is muted on replay (zero dispatch) yet fires on live forward ticks.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use fabrico_core::command::{Command, Dispatch, Effect, Outcome};
use fabrico_core::ids::CommandId;
use slotmap::Key;

use crate::config::HostConfig;
use crate::sinks::{debug, http};

/// The single dispatch router: turn one `Command` of intent into a real,
/// off-thread side effect and fold the result into an `Outcome`.
///
/// Routes purely on `cmd.effect`:
/// - `Effect::Noop` — nothing to do; trivially `Success`.
/// - `Effect::Debug` — the in-host, I/O-free debug sink (SINK-01).
/// - `Effect::Http` — a reqwest request on the logged verb, carrying the
///   `CommandId` idempotency header (SINK-03).
///
/// The returned `Outcome` is exactly the value a driver stamps into a logged
/// `CommandResult` (EXEC-02 — the result re-enters the fold off-thread).
///
/// `_cfg` is the host-side settings seam every sink is handed. No sink reads it
/// today: the mail credentials it used to carry left with the mail sender in
/// phase 85, and the HTTP sink builds its own client.
pub async fn dispatch(_cfg: &HostConfig, cmd: &Command) -> Outcome {
    match &cmd.effect {
        // No side effect — the muted placeholder; succeeds trivially.
        Effect::Noop => Outcome::Success,
        // The first, I/O-free sink: surfaces the bytes in-host (SINK-01).
        Effect::Debug { message } => debug::dispatch_debug(message),
        // Arbitrary outbound HTTP via reqwest, carrying the CommandId as the
        // Idempotency-Key header (SINK-03) and the user's chosen verb.
        //
        // `method` USED TO BE DESTRUCTURED AS `method: _` HERE, under a 35-03 comment
        // saying it was inert "until Phase 39". Phase 39 shipped 2026-07-18 and the
        // placeholder outlived it by four months, so every HTTP sink dispatched POST
        // no matter what the panel showed. It is threaded now; `sinks/http.rs` holds
        // the verb mapping and the bodyless-GET/DELETE rule.
        Effect::Http { url, body, method } => {
            let client = http::default_client();
            http::dispatch_http(&client, cmd, url, body, *method).await
        }
        // A Reply that reaches THIS function has already missed its bridge, and this arm
        // stays a trivial, I/O-free Success on purpose (mirroring Noop): never open a
        // socket, never panic.
        //
        // Phase 38 did NOT replace this arm, which is what the 35-02 comment here used to
        // promise. It put the correlated-reply dispatch UPSTREAM instead: `sim_loop`
        // intercepts an `Effect::Reply` for a parked endpoint request before the
        // executor is reached (ENDP-01/04) and resolves the socket there. So a Reply
        // arriving here is one with no parked request left to answer — a late reply after
        // a timeout, most often — and doing nothing is the correct answer for it.
        Effect::Reply { .. } => Outcome::Success,
    }
}

/// Derive the single deterministic idempotency token from a logged `CommandId`.
///
/// The token is a stable, collision-resistant ASCII string built only from
/// `(tick, node-ffi, seq)`, safe to place in an HTTP header value. Because
/// `CommandId` is itself derived from logged data, the same command always yields
/// the same token across processes and replays, so a provider that dedups on it
/// cannot double-deliver on a safe retry. Do NOT mint a second key.
#[must_use]
pub fn command_id_string(id: &CommandId) -> String {
    let (tick, node, seq) = id;
    // `as_ffi()` is the slotmap key's stable (index, generation) bit-packing —
    // deterministic and unique per live node id.
    format!("fabrico-cmd-{}-{}-{}", tick, node.data().as_ffi(), seq)
}

/// A `Dispatch` impl that counts calls and performs no real effect — the
/// replay-muting probe.
///
/// A later plan wires this on the replay/recovery path and asserts the counter
/// stays `0` (the executor is muted on replay), then asserts it equals the
/// number of commands on a live forward run. It never opens a socket.
#[derive(Clone, Debug, Default)]
pub struct CountingExecutor(pub Arc<AtomicUsize>);

impl CountingExecutor {
    /// The number of `dispatch` calls observed so far.
    #[must_use]
    pub fn count(&self) -> usize {
        self.0.load(Ordering::Relaxed)
    }
}

impl Dispatch for CountingExecutor {
    fn dispatch(&mut self, _cmd: &Command) {
        // Count only — no real effect. Proves replay-muting in a later plan.
        self.0.fetch_add(1, Ordering::Relaxed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use fabrico_core::command::EVENT_VERSION;
    use fabrico_core::ids::NodeId;
    use slotmap::SlotMap;

    fn test_config() -> HostConfig {
        HostConfig {
            webhook_addr: "127.0.0.1:0".parse().expect("loopback addr"),
        }
    }

    fn mint_node() -> NodeId {
        let mut alloc: SlotMap<NodeId, ()> = SlotMap::with_key();
        alloc.insert(())
    }

    fn debug_command(node: NodeId, message: Vec<u8>) -> Command {
        Command {
            event_version: EVENT_VERSION,
            id: (5, node, 0),
            partition: 0,
            effect: Effect::Debug { message },
            deadline: 100,
        }
    }

    #[tokio::test]
    async fn executor_dispatch_debug_returns_success() {
        let cfg = test_config();
        let cmd = debug_command(mint_node(), b"payload".to_vec());
        // A debug command dispatches with no socket and yields Success.
        assert_eq!(dispatch(&cfg, &cmd).await, Outcome::Success);
    }

    #[tokio::test]
    async fn executor_dispatch_noop_returns_success() {
        let cfg = test_config();
        let mut cmd = debug_command(mint_node(), Vec::new());
        cmd.effect = Effect::Noop;
        assert_eq!(dispatch(&cfg, &cmd).await, Outcome::Success);
    }

    #[test]
    fn executor_command_id_string_is_stable_and_distinct() {
        let node = mint_node();
        let id_a: CommandId = (5, node, 0);
        // Same id → same token (deterministic).
        assert_eq!(command_id_string(&id_a), command_id_string(&id_a));
        // Differing tick / seq → different token.
        let id_b: CommandId = (6, node, 0);
        let id_c: CommandId = (5, node, 1);
        assert_ne!(command_id_string(&id_a), command_id_string(&id_b));
        assert_ne!(command_id_string(&id_a), command_id_string(&id_c));
        // The token is header-safe ASCII (no spaces / control chars).
        assert!(command_id_string(&id_a).bytes().all(|b| b.is_ascii_graphic()));
    }

    #[test]
    fn executor_counting_executor_counts() {
        let counter = CountingExecutor::default();
        assert_eq!(counter.count(), 0);
        let cmd = debug_command(mint_node(), Vec::new());
        let mut c = counter.clone();
        c.dispatch(&cmd);
        c.dispatch(&cmd);
        // The shared AtomicUsize counts every dispatch (used for replay-muting).
        assert_eq!(counter.count(), 2);
    }
}
