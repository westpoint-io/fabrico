//! The in-memory correlation registry — the ENDP-04 exactly-once + replay-mute
//! foundation.
//!
//! An Endpoint request parks its caller's response socket here under a `u64`
//! correlation, keyed against the request's logged `deadline_tick`. Exactly one
//! of two host-side writers later resolves it: the executor-consumer reply arm
//! (on an `Effect::Reply`) OR the per-tick deadline sweep (a `timeout_504`).
//! Whichever [`Registry::resolve`]s the correlation FIRST `remove`s it and writes
//! the socket; the other finds `None` and drops. This is the same at-most-once
//! `remove`-gate the driver uses for one Timeout XOR one CommandResult, realized
//! over an in-memory map instead of redb.
//!
//! # Never serialized — the replay-mute property
//! The registry is host-side state that is NEVER persisted (not a core field, not
//! in any snapshot) and is always reconstructed EMPTY — the `factory_runtimes`
//! `#[serde(skip)]` discipline. A recovered / replayed host parks nothing, so
//! neither writer resolves any socket on replay: a timeout-then-late-reply can
//! never double-write, and replay writes zero sockets. This empty-on-construct
//! property IS the ENDP-04 replay-mute proof.
//!
//! # `BTreeMap`, never `HashMap`
//! The deadline sweep (38-03) iterates this map; a `BTreeMap` keeps the
//! 504-emission order deterministic — determinism-discipline parity with the
//! driver's ordered in-flight sweep. A `HashMap`'s per-process seed would make
//! same-tick timeout order non-deterministic.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use tokio::sync::oneshot;

use crate::ingress::endpoint::HttpResponse;

/// The maximum number of simultaneously parked endpoint requests.
///
/// A DoS fence (SECURITY CONTROL, plan decision D2 — TUNABLE): past this cap a
/// [`Registry::try_park`] is REFUSED (the caller 503s the sender it is handed
/// back) so a flood of held-open callers cannot grow the host's memory / FD
/// footprint unboundedly. Mirrors the wire-cap philosophy in the core.
pub const MAX_PARKED_ENDPOINTS: usize = 1024;

/// `correlation -> (deadline_tick, respond)`. `BTreeMap` for deterministic
/// sweep order (see module docs).
type Parked = BTreeMap<u64, (u64, oneshot::Sender<HttpResponse>)>;

/// Host-side parked-request store. Cloning shares the inner `Arc<Mutex<_>>` so the
/// sim thread and the off-thread executor consumer both hold the same registry.
///
/// A fresh / recovered `Registry::default()` is EMPTY — the replay-mute starting
/// condition (see module docs).
#[derive(Clone, Default)]
pub struct Registry(Arc<Mutex<Parked>>);

impl Registry {
    /// Park a caller's response socket under `correlation`, keyed on
    /// `deadline_tick`.
    ///
    /// Returns `Err(respond)` — handing the sender BACK so the caller can `503`
    /// it — when the registry is already at [`MAX_PARKED_ENDPOINTS`] (the DoS
    /// refusal). Otherwise inserts and returns `Ok(())`.
    pub fn try_park(
        &self,
        correlation: u64,
        deadline_tick: u64,
        respond: oneshot::Sender<HttpResponse>,
    ) -> Result<(), oneshot::Sender<HttpResponse>> {
        let mut guard = self.0.lock().expect("registry poisoned");
        if guard.len() >= MAX_PARKED_ENDPOINTS {
            // Refuse deterministically rather than growing host memory unboundedly.
            return Err(respond);
        }
        guard.insert(correlation, (deadline_tick, respond));
        Ok(())
    }

    /// Resolve `correlation` exactly once (the single-writer gate).
    ///
    /// Holds the lock ONLY for the `remove`, then sends OUTSIDE the critical
    /// section — never `.send()` under the lock. The FIRST resolver (reply arm
    /// XOR deadline sweep) removes-and-sends; a second resolve of the same
    /// correlation finds `None` and drops. A dropped receiver (caller already
    /// disconnected) makes `send` return `Err`, which is fine — the socket is
    /// simply gone.
    pub fn resolve(&self, correlation: u64, resp: HttpResponse) {
        let parked = {
            let mut guard = self.0.lock().expect("registry poisoned");
            guard.remove(&correlation)
        }; // guard dropped here — send happens with the lock released.
        if let Some((_deadline, tx)) = parked {
            let _ = tx.send(resp);
        }
    }

    /// Drain EVERY parked socket, resolving each with a freshly built `resp` and
    /// leaving the map EMPTY (F4 — the host-swap orphan sweep).
    ///
    /// A Load / LoadDemo swap re-seeds the loop tick from the loaded scene but the
    /// sockets parked against the DISCARDED pre-swap timeline cannot be answered by
    /// the loaded scene (leaked forever while Frozen, or prematurely 504'd against a
    /// higher loaded tick). Draining them here — resolve-then-clear — makes the loaded
    /// scene start with an empty registry, matching crash-recovery (which rebuilds a
    /// fresh empty registry). `resp` is a factory so each caller gets its OWN owned
    /// [`HttpResponse`]. Like [`resolve`](Self::resolve), the sends happen OUTSIDE the
    /// lock (the map is `take`n under the lock, then drained after release) so a
    /// dropped receiver can never deadlock the swap.
    pub fn drain_all(&self, resp: impl Fn() -> HttpResponse) {
        let drained: Parked = {
            let mut guard = self.0.lock().expect("registry poisoned");
            std::mem::take(&mut *guard)
        }; // guard dropped here — sends happen with the lock released.
        for (_correlation, (_deadline, tx)) in drained {
            let _ = tx.send(resp());
        }
    }

    /// Collect the correlations whose deadline has STRICTLY passed `now`
    /// (`deadline < now` — reply wins ties, plan decision D1), in `BTreeMap`
    /// (deterministic) order. The 38-03 sweep resolves each with a `timeout_504`.
    ///
    /// `now` is `host.core().tick` (a deterministic logical tick, NEVER a
    /// wall-clock read).
    pub fn expired_correlations(&self, now: u64) -> Vec<u64> {
        let guard = self.0.lock().expect("registry poisoned");
        guard
            .iter()
            .filter(|(_, (deadline, _))| *deadline < now)
            .map(|(correlation, _)| *correlation)
            .collect()
    }

    /// The number of currently parked requests (0 on a fresh construct).
    pub fn len(&self) -> usize {
        self.0.lock().expect("registry poisoned").len()
    }

    /// Whether no request is parked.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod registry_tests {
    use super::*;
    use crate::ingress::endpoint::HttpResponse;

    #[test]
    fn fresh_registry_is_empty() {
        // The replay-mute starting condition: a recovered host parks nothing.
        let reg = Registry::default();
        assert_eq!(reg.len(), 0);
        assert!(reg.is_empty());
    }

    #[test]
    fn double_resolve_writes_the_socket_exactly_once() {
        let reg = Registry::default();
        let (tx, mut rx) = oneshot::channel();
        reg.try_park(7, 10, tx).expect("park under cap");
        assert_eq!(reg.len(), 1);

        // First resolve wins and removes the entry.
        reg.resolve(7, HttpResponse::ok_json(b"first".to_vec()));
        // Second resolve of the SAME correlation finds None and drops.
        reg.resolve(7, HttpResponse::timeout_504());

        assert_eq!(reg.len(), 0, "entry removed after first resolve");
        let got = rx.try_recv().expect("exactly one value delivered");
        assert_eq!(got.body_bytes(), b"first", "the first resolve wins");
        // No second value: the sender was consumed by the first send.
        assert!(rx.try_recv().is_err(), "no second value reaches the receiver");
    }

    #[test]
    fn resolve_absent_correlation_is_a_noop() {
        let reg = Registry::default();
        // No panic, no send, nothing parked.
        reg.resolve(999, HttpResponse::timeout_504());
        assert_eq!(reg.len(), 0);
    }

    #[test]
    fn park_past_cap_hands_the_sender_back_for_503() {
        let reg = Registry::default();
        // Keep receivers alive so senders stay valid in the map.
        let mut _receivers = Vec::with_capacity(MAX_PARKED_ENDPOINTS);
        for correlation in 0..MAX_PARKED_ENDPOINTS as u64 {
            let (tx, rx) = oneshot::channel();
            reg.try_park(correlation, 10, tx).expect("under cap");
            _receivers.push(rx);
        }
        assert_eq!(reg.len(), MAX_PARKED_ENDPOINTS);

        // The next park is refused and hands the sender back.
        let (tx, _rx) = oneshot::channel();
        let refused = reg.try_park(MAX_PARKED_ENDPOINTS as u64, 10, tx);
        assert!(refused.is_err(), "park past the cap is refused");
        // The caller can now 503 the returned sender.
        let handed_back = refused.unwrap_err();
        let _ = handed_back.send(HttpResponse::ok_json(b"503".to_vec()));
        assert_eq!(reg.len(), MAX_PARKED_ENDPOINTS, "cap not exceeded");
    }

    #[test]
    fn expired_uses_strictly_less_and_btreemap_order() {
        let reg = Registry::default();
        let (tx_a, _rx_a) = oneshot::channel();
        let (tx_b, _rx_b) = oneshot::channel();
        // Insert out of key order to prove BTreeMap re-orders deterministically.
        reg.try_park(200, 20, tx_b).unwrap();
        reg.try_park(100, 10, tx_a).unwrap();

        // At now == deadline, nothing is expired (strictly-less: reply wins ties).
        assert!(reg.expired_correlations(10).is_empty(), "10 < 10 is false");
        // Past the first deadline, only correlation 100 (deadline 10) expires.
        assert_eq!(reg.expired_correlations(11), vec![100]);
        // Past both, keys come back in BTreeMap (ascending) order.
        assert_eq!(reg.expired_correlations(21), vec![100, 200]);
    }

    #[test]
    fn drain_all_resolves_every_socket_and_empties_the_map() {
        // F4: a host swap drains the registry — every parked socket is resolved with
        // a fresh response and the map is left EMPTY.
        let reg = Registry::default();
        let mut receivers = Vec::new();
        for correlation in 0..5u64 {
            let (tx, rx) = oneshot::channel();
            reg.try_park(correlation, u64::MAX, tx).expect("park under cap");
            receivers.push(rx);
        }
        assert_eq!(reg.len(), 5);

        reg.drain_all(HttpResponse::reloaded_503);

        assert!(reg.is_empty(), "the map is empty after drain_all");
        for mut rx in receivers {
            let got = rx.try_recv().expect("every parked socket was resolved");
            assert_eq!(got.status().as_u16(), 503, "each socket got the 503");
            assert_eq!(got.body_bytes(), br#"{"error":"scene reloaded"}"#);
        }
    }

    #[test]
    fn resolve_does_not_deadlock_under_repeated_calls() {
        // A by-construction proof that resolve holds the lock only for the remove
        // (the send is outside the critical section): repeated resolves on a live
        // registry never deadlock.
        let reg = Registry::default();
        for correlation in 0..8u64 {
            let (tx, _rx) = oneshot::channel();
            reg.try_park(correlation, 100, tx).unwrap();
            reg.resolve(correlation, HttpResponse::ok_json(b"ok".to_vec()));
            reg.resolve(correlation, HttpResponse::timeout_504()); // no-op, no deadlock
        }
        assert_eq!(reg.len(), 0);
    }
}
