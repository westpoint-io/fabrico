//! `wire` — the request/response WIRE transport PRIMITIVE (WIRE-01..04, Phase 37).
//!
//! This is the leaf transport primitive of Phase 37, the exact sibling of
//! [`crate::belt_slots`]: a pure, standalone, proptest-certified module with NO
//! grid / `Core` / `tick` access, landed BEFORE any fold wiring, schema bump, or
//! golden-corpus re-bless (those never happen — Phase 37 grows only zero-instance
//! shapes). Adding this module is zero serialized-byte impact: `lib.rs` gains one
//! `pub mod` line, nothing else.
//!
//! # The two bounds (WIRE-03 — neither hang nor OOM under fan-out)
//! A wire carries in-flight request/response messages that can fan out (a handler
//! re-emits N requests per request). Two independent, deterministic bounds keep an
//! exponential fan-out from either hanging or exhausting memory:
//! - **[`WIRE_INFLIGHT_CAP`]** bounds SPACE (breadth): a wire's in-flight FIFO
//!   REFUSES admission past the cap — the belt `admit_tail` refuse-on-full analog
//!   ([`crate::belt_slots`] `belt_slots.rs:89-103`). Over-cap is an overflow signal,
//!   never silent growth.
//! - **[`DEFAULT_WIRE_BUDGET`]** bounds DEPTH (hop count): a per-request budget spent
//!   one unit per wire-to-wire FORWARD. Precisely (IN-01): the ENTRY/ADMIT hop is FREE
//!   — a request admitted directly into its entry wire's `in_flight`
//!   (`manual_inject.rs`), and a reply admitted directly into its return wire
//!   (`tick.rs::route_replies`), do NOT decrement; the budget is spent only when a
//!   message is DELIVERED INTO a wire's inbox and re-forwarded (`tick.rs::step_wire`
//!   ingest). So the effective depth bound is `budget + free-admit-hops`, not `budget`.
//!   This is deliberate and does NOT weaken termination: every CYCLIC traversal passes
//!   through ≥1 ingest, so the budget strictly decreases and reaches 0 in a bounded
//!   number of hops regardless of the free entry hop. A child/derived message inherits
//!   `parent.budget - 1`, so a doubling recursion still trips the depth bound within a
//!   bounded number of hops. Do NOT "fix" the free admit hop into a decrement — it would
//!   change every wire fixture's fault tick (a re-bless).
//!
//! Cap alone bounds breadth but not depth; budget alone bounds depth but not breadth
//! — enforcing BOTH is what makes any fan-out terminate in a bounded number of steps
//! with an overflow signal (proven by [`tests`]'s bounded-termination proptest).
//!
//! # The hop-time contract (WIRE_HOP_TICKS)
//! Every wire hop costs at least one tick ([`WIRE_HOP_TICKS`] = 1): a message
//! admitted at `entry_tick` matures for delivery only once
//! `entry_tick + WIRE_HOP_TICKS <= now` ([`is_matured`]). There are no zero-tick
//! wires this milestone (CONTEXT), so a reply can never be observed on the same tick
//! it was emitted — a load-bearing determinism property for the reply transport.
//!
//! # On-the-wire form ([`WireEnvelope`] — the `Fault::encode` precedent)
//! A message travels wire-to-wire as OPAQUE `Item(Vec<u8>)` bytes: [`WireEnvelope`]
//! postcards its `correlation`/`return_addr`/`budget`/`payload` INTO an [`Item`] via
//! [`WireEnvelope::encode`], and [`WireEnvelope::decode`] recovers it behind a
//! `Result` — TOTAL over any malformed bytes, never a panic (mirrors
//! [`crate::fault::Fault`] `fault.rs:161-176`, the untrusted-belt-bytes discipline).
//! This lets multi-hop transport carry the correlation/return-address WITHOUT ever
//! touching [`Item`]'s shape. A [`WireInFlight`] is simply a [`WireEnvelope`] plus the
//! per-wire `entry_tick` (the hop-maturation clock), so the two convert freely.
//!
//! All types are plain serde data (CORE-09): no floats, no HashMaps, no pointers,
//! no OS entropy — this module is under the crate determinism clippy gate.

// Every public symbol here is consumed by the Phase-37 fold (Plans 02-06) and the
// grown `WireLink.in_flight`, but the transport helper fns have no non-test caller
// in THIS plan (which lands the primitive + grows the zero-instance shapes only).
// Allow dead_code so the determinism clippy gate (`--all-targets -- -D warnings`)
// stays green until a later plan wires the fold — the `belt_slots.rs:55` precedent.
#![allow(dead_code)]

use crate::ids::{Item, NodeId, PortId};
use std::collections::VecDeque;

/// Per-wire in-flight SIZE cap — the SPACE (breadth / fan-out) bound.
///
/// A wire's in-flight FIFO refuses admission once it holds this many messages
/// ([`admit`] returns the refused message). A wire is a logical link (not spatial),
/// so 256 concurrent in-flight is generous without being unbounded (cf. the belt
/// `SLOTS_PER_TILE = 4` / `MAX_BELT_TILES = 1024` and factory `DEFAULT_GAS_BUDGET =
/// 256` precedents). CONTEXT/RESEARCH §5-locked; baked into fixture `0025`.
///
/// The belt cross-reference is prose only. The slot count moved from three to four
/// in Phase 60 (`60-CONTEXT.md`, 2026-08-09); `WIRE_INFLIGHT_CAP` did NOT move, and
/// nothing about the wire in-flight bound is derived from the belt.
pub const WIRE_INFLIGHT_CAP: usize = 256;

/// Default per-request hop DEPTH budget — the TIME (depth / recursion) bound.
///
/// A request enters carrying this budget; each wire-to-wire FORWARD spends one unit
/// ([`step_budget`]) — the entry/admit hop is FREE (IN-01, see the module doc) — and a
/// derived child inherits `parent.budget - 1`. 64 forwards is deeper than any realistic
/// hand-built chain yet shallow enough that a doubling recursion trips the depth bound
/// within a bounded tick count. CONTEXT/RESEARCH §5-locked.
pub const DEFAULT_WIRE_BUDGET: u64 = 64;

/// Ticks a single wire hop costs — every hop is at least one tick (no zero-tick
/// wires this milestone, CONTEXT). A message admitted at `entry_tick` matures for
/// delivery only when `entry_tick + WIRE_HOP_TICKS <= now` ([`is_matured`]).
pub const WIRE_HOP_TICKS: u64 = 1;

/// A request/response message resident in a wire's in-flight FIFO — **plain data**
/// (no pointers, integer/fixed only, no floats), serde-round-trippable so it lives
/// on [`crate::state::WireLink::in_flight`] in a snapshot.
///
/// It is a [`WireEnvelope`] (the on-the-wire form) plus the per-wire `entry_tick`,
/// the hop-maturation clock. Field order is LOAD-BEARING (postcard is positional):
/// never reorder, only append.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct WireInFlight {
    /// The tick this message was admitted to THIS wire — the `>= 1`-tick hop gate
    /// (matures when `entry_tick + WIRE_HOP_TICKS <= now`).
    pub entry_tick: u64,
    /// The correlation id a later [`crate::command::Effect::Reply`] matches to
    /// resolve the originating request.
    pub correlation: u64,
    /// The logical reply address the response routes back to — a `(node, port)`
    /// handle, never a raw pointer (API-03). Hewitt's "customer"/continuation.
    pub return_addr: (NodeId, PortId),
    /// The remaining hop budget (the DEPTH bound); a hop spends one via
    /// [`step_budget`], a child inherits this minus one.
    pub budget: u64,
    /// The opaque request/response body bytes.
    pub payload: Item,
}

/// The on-the-wire form of a message: a [`WireInFlight`] WITHOUT the per-wire
/// `entry_tick`, so it can hop wire-to-wire as OPAQUE [`Item`] bytes (the
/// `Fault::encode -> Item` precedent) and pick up a fresh `entry_tick` at each wire.
///
/// Field order matches [`WireInFlight`]'s tail (correlation, return_addr, budget,
/// payload) and is LOAD-BEARING (postcard positional): never reorder, only append.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct WireEnvelope {
    /// The correlation id a later [`crate::command::Effect::Reply`] matches.
    pub correlation: u64,
    /// The logical reply address — a `(node, port)` handle (API-03).
    pub return_addr: (NodeId, PortId),
    /// The remaining hop budget (the DEPTH bound).
    pub budget: u64,
    /// The opaque request/response body bytes.
    pub payload: Item,
}

impl WireEnvelope {
    /// Encode the envelope as an [`Item`] (postcard plain data) so it rides
    /// wire-to-wire as opaque bytes. Cannot fail — `WireEnvelope` is plain serde
    /// data — so the `expect` is a true invariant, not a runtime trust boundary
    /// (the [`crate::fault::Fault::encode`] precedent).
    pub fn encode(&self) -> Item {
        Item(postcard::to_allocvec(self).expect("WireEnvelope is plain serde data"))
    }

    /// Decode an envelope from an [`Item`]'s UNTRUSTED bytes (a message looped in
    /// from a belt / a forged save-file). Returns `Err(())` on ANY malformed bytes —
    /// **never** panics, never OOMs — feeding the Phase-37 trust gate (mirrors
    /// [`crate::fault::Fault::decode`]). The unit error is deliberate: the sole
    /// failure mode is "the bytes are not a `WireEnvelope`".
    #[allow(clippy::result_unit_err)]
    pub fn decode(item: &Item) -> Result<Self, ()> {
        postcard::from_bytes(&item.0).map_err(|_| ())
    }
}

impl WireInFlight {
    /// Lift an on-the-wire [`WireEnvelope`] into an in-flight message by stamping the
    /// per-wire `entry_tick` (the hop-maturation clock).
    pub fn from_envelope(env: WireEnvelope, entry_tick: u64) -> Self {
        Self {
            entry_tick,
            correlation: env.correlation,
            return_addr: env.return_addr,
            budget: env.budget,
            payload: env.payload,
        }
    }

    /// Drop the per-wire `entry_tick` to recover the on-the-wire [`WireEnvelope`]
    /// (for the next hop). Clones the payload bytes.
    pub fn to_envelope(&self) -> WireEnvelope {
        WireEnvelope {
            correlation: self.correlation,
            return_addr: self.return_addr,
            budget: self.budget,
            payload: self.payload.clone(),
        }
    }
}

/// Admit `msg` to the BACK of a wire's in-flight FIFO, or REFUSE on a full wire.
///
/// Returns `None` when the message was placed (the FIFO held fewer than
/// [`WIRE_INFLIGHT_CAP`]), or `Some(msg)` — the overflow signal — when the FIFO is
/// already at the cap, in which case the FIFO is left UNCHANGED and never grows past
/// the cap. The exact analog of [`crate::belt_slots`]'s `admit_tail` refuse-on-full
/// (`belt_slots.rs:94-103`): over-cap refuses, never silently drops or grows.
pub(crate) fn admit(fifo: &mut VecDeque<WireInFlight>, msg: WireInFlight) -> Option<WireInFlight> {
    if fifo.len() >= WIRE_INFLIGHT_CAP {
        // At the cap: refuse (overflow signal), leave the FIFO unchanged.
        Some(msg)
    } else {
        fifo.push_back(msg);
        None
    }
}

/// The hop-maturation predicate: `true` once `msg` has been resident at least
/// [`WIRE_HOP_TICKS`] ticks (`entry_tick + WIRE_HOP_TICKS <= now`). Saturating so an
/// absurd `entry_tick` can never wrap.
pub(crate) fn is_matured(msg: &WireInFlight, now: u64) -> bool {
    msg.entry_tick.saturating_add(WIRE_HOP_TICKS) <= now
}

/// Spend one unit of hop `budget` (the DEPTH bound). Returns `Some(budget - 1)` for
/// the child/derived message when `budget > 0`, or `None` — the overflow signal —
/// when `budget == 0` (the depth bound has fired, so the message faults instead of
/// hopping again). A message therefore makes at most [`DEFAULT_WIRE_BUDGET`]
/// budget-spending wire-to-wire FORWARDS (the entry/admit hop is free — IN-01).
pub(crate) fn step_budget(budget: u64) -> Option<u64> {
    budget.checked_sub(1)
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;
    use slotmap::SlotMap;

    /// Mint one real generational `NodeId` for a return address.
    fn one_id() -> NodeId {
        let mut alloc: SlotMap<NodeId, ()> = SlotMap::with_key();
        alloc.insert(())
    }

    /// A minimal in-flight message with the given budget/entry_tick (empty payload).
    fn msg(entry_tick: u64, budget: u64) -> WireInFlight {
        WireInFlight {
            entry_tick,
            correlation: 0,
            return_addr: (one_id(), 0),
            budget,
            payload: Item(vec![]),
        }
    }

    /// The three transport constants carry their CONTEXT/RESEARCH §5-locked values.
    #[test]
    fn constants_are_context_locked() {
        assert_eq!(WIRE_INFLIGHT_CAP, 256);
        assert_eq!(DEFAULT_WIRE_BUDGET, 64);
        assert_eq!(WIRE_HOP_TICKS, 1);
    }

    /// `admit` places into a FIFO with room and returns None.
    #[test]
    fn admit_places_when_room() {
        let mut fifo: VecDeque<WireInFlight> = VecDeque::new();
        let ret = admit(&mut fifo, msg(0, 4));
        assert_eq!(ret, None, "admitted -> nothing returned");
        assert_eq!(fifo.len(), 1, "message placed at the back");
    }

    /// `admit` REFUSES (returns Some) and leaves the FIFO unchanged at the cap —
    /// the belt `admit_tail` refuse-on-full analog, never grows past the cap.
    #[test]
    fn admit_refuses_at_cap() {
        let mut fifo: VecDeque<WireInFlight> = VecDeque::new();
        for _ in 0..WIRE_INFLIGHT_CAP {
            assert_eq!(admit(&mut fifo, msg(0, 1)), None);
        }
        assert_eq!(fifo.len(), WIRE_INFLIGHT_CAP, "filled exactly to the cap");
        let refused = msg(0, 9);
        let ret = admit(&mut fifo, refused.clone());
        assert_eq!(ret, Some(refused), "at cap -> overflow signal (message returned)");
        assert_eq!(fifo.len(), WIRE_INFLIGHT_CAP, "FIFO never grows past the cap");
    }

    /// `step_budget` spends one unit; 0 is the depth-overflow signal.
    #[test]
    fn step_budget_decrements_and_overflows_at_zero() {
        assert_eq!(step_budget(DEFAULT_WIRE_BUDGET), Some(DEFAULT_WIRE_BUDGET - 1));
        assert_eq!(step_budget(1), Some(0), "a child inherits parent budget minus one");
        assert_eq!(step_budget(0), None, "budget 0 hop -> overflow signal");
    }

    /// `is_matured` fires exactly at the `entry_tick + WIRE_HOP_TICKS` boundary
    /// (every hop costs at least one tick).
    #[test]
    fn is_matured_at_one_tick_boundary() {
        let m = msg(5, 4);
        assert!(!is_matured(&m, 5), "same tick it entered: not yet matured");
        assert!(is_matured(&m, 6), "matured exactly one tick later");
        assert!(is_matured(&m, 100), "still matured well after");
    }

    /// `is_matured` is saturating — an absurd `entry_tick` never wraps/panics. A
    /// naive `entry_tick + 1` would wrap `u64::MAX + 1` to 0 and report a max-tick
    /// message as ALREADY matured at `now == 0`; `saturating_add` keeps it unmatured.
    #[test]
    fn is_matured_is_overflow_safe() {
        let m = msg(u64::MAX, 1);
        assert!(!is_matured(&m, 0), "no wrap: max entry_tick is not matured at now=0");
        assert!(!is_matured(&m, u64::MAX - 1), "still not matured just below the max");
        // Saturated boundary: at the maximum tick it does mature (degenerate, but
        // never a panic/wrap — the overflow-safety guarantee holds).
        assert!(is_matured(&m, u64::MAX), "saturated boundary matures, no panic");
    }

    /// A `WireEnvelope` round-trips through opaque `Item` bytes byte-faithfully.
    #[test]
    fn envelope_encode_decode_round_trips() {
        let env = WireEnvelope {
            correlation: 0xDEAD_BEEF,
            return_addr: (one_id(), 7),
            budget: DEFAULT_WIRE_BUDGET,
            payload: Item(vec![0x01, 0x02, 0x03]),
        };
        let encoded = env.encode();
        let decoded = WireEnvelope::decode(&encoded).expect("a well-formed envelope decodes");
        assert_eq!(decoded, env, "encode -> decode round-trips byte-faithfully");
    }

    /// Decode is TOTAL over malformed bytes — Err, never a panic/OOM (the trust
    /// boundary the Phase-37 gate feeds; mirrors `Fault::decode`).
    #[test]
    fn envelope_decode_garbage_is_err_not_panic() {
        for garbage in [
            Item(vec![]),
            Item(vec![0x00]),
            Item(vec![0xFF; 3]),
            Item(vec![0xFF; 256]),
        ] {
            assert!(
                WireEnvelope::decode(&garbage).is_err(),
                "garbage bytes {:?} decode to Err, never panic",
                garbage.0
            );
        }
    }

    /// `WireInFlight` is a `WireEnvelope` plus `entry_tick`: the conversions are
    /// mutually inverse (modulo the entry_tick the envelope does not carry).
    #[test]
    fn in_flight_envelope_conversions_are_inverse() {
        let env = WireEnvelope {
            correlation: 42,
            return_addr: (one_id(), 3),
            budget: 9,
            payload: Item(vec![0xAA, 0xBB]),
        };
        let inflight = WireInFlight::from_envelope(env.clone(), 100);
        assert_eq!(inflight.entry_tick, 100, "entry_tick stamped on lift");
        assert_eq!(inflight.correlation, env.correlation);
        assert_eq!(inflight.return_addr, env.return_addr);
        assert_eq!(inflight.budget, env.budget);
        assert_eq!(inflight.payload, env.payload);
        assert_eq!(inflight.to_envelope(), env, "to_envelope drops entry_tick, recovers env");
    }

    /// Drive a fan-out storm through the two bounds and report `(overflow_seen,
    /// max_len, steps, drained)`. Each step pops the FIFO front (a matured hop) and,
    /// if its budget permits ([`step_budget`]), admits `fanout` derived children each
    /// carrying `parent.budget - 1`; a refused admit ([`admit`] returns `Some`) or a
    /// budget-0 hop is an overflow signal. A PURE, deterministic function of inputs.
    ///
    /// `HARD_LIMIT` is a generous ceiling: reaching it means the run did NOT
    /// terminate, which the proptest treats as a failure (the loop must drain).
    fn run_fanout(fanout: u64, start_budget: u64) -> (bool, usize, usize, bool) {
        let mut fifo: VecDeque<WireInFlight> = VecDeque::new();
        // Seed one request; a full wire could even refuse the seed (cap 0 is not our
        // case, but admit is honored uniformly).
        let mut overflow_seen = admit(&mut fifo, msg(0, start_budget)).is_some();
        let mut max_len = fifo.len();
        let mut steps = 0usize;
        // Every successful admit is popped exactly once, concurrency is capped at
        // WIRE_INFLIGHT_CAP, and budgets strictly decrease with depth (bounded by
        // start_budget) — so total steps are bounded. This ceiling is deliberately
        // far above that bound; hitting it is a non-termination failure.
        let hard_limit =
            WIRE_INFLIGHT_CAP.saturating_mul(start_budget as usize + 2) + fanout as usize + 16;
        let mut now = 1u64;
        let mut drained = true;

        while let Some(front) = fifo.pop_front() {
            steps += 1;
            if steps > hard_limit {
                drained = false; // did not terminate under the bound
                break;
            }
            match step_budget(front.budget) {
                None => overflow_seen = true, // depth bound fired -> fault, no children
                Some(child_budget) => {
                    for _ in 0..fanout {
                        let child = msg(now, child_budget);
                        if admit(&mut fifo, child).is_some() {
                            overflow_seen = true; // space bound fired -> refused
                        }
                    }
                }
            }
            max_len = max_len.max(fifo.len());
            now = now.saturating_add(1);
        }
        (overflow_seen, max_len, steps, drained)
    }

    proptest! {
        #![proptest_config(ProptestConfig::default())] // honors PROPTEST_CASES (CI=1024)

        /// THE bounded-termination anchor (WIRE-03): for ANY fan-out factor and
        /// starting depth, a request storm (1) TERMINATES in a bounded number of
        /// steps (the FIFO drains — never loops), (2) never grows the FIFO past
        /// [`WIRE_INFLIGHT_CAP`], and (3) never panics. A genuine storm (fan-out
        /// >= 2 with depth to spend) is caught by an overflow signal.
        #[test]
        fn fanout_storm_terminates_bounded_never_oom(
            fanout in 0u64..=8,
            start_budget in 0u64..=DEFAULT_WIRE_BUDGET,
        ) {
            let (overflow_seen, max_len, _steps, drained) = run_fanout(fanout, start_budget);
            prop_assert!(drained, "the storm terminated (FIFO drained) — never loops");
            prop_assert!(
                max_len <= WIRE_INFLIGHT_CAP,
                "in-flight never grew past the cap: {max_len} <= {WIRE_INFLIGHT_CAP}"
            );
            // A real doubling storm with depth to spend MUST hit an overflow signal
            // (space or depth) — the neither-hang-nor-OOM guarantee.
            if fanout >= 2 && start_budget >= 1 {
                prop_assert!(overflow_seen, "a real fan-out storm trips an overflow signal");
            }
        }

        /// Determinism anchor: the transport is a pure function of its inputs — a
        /// second identical run yields the identical outcome tuple.
        #[test]
        fn fanout_run_is_deterministic(
            fanout in 0u64..=8,
            start_budget in 0u64..=DEFAULT_WIRE_BUDGET,
        ) {
            let a = run_fanout(fanout, start_budget);
            let b = run_fanout(fanout, start_budget);
            prop_assert_eq!(a, b, "identical inputs -> identical outcome");
        }
    }
}
