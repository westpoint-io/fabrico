//! The fault output port + faulted-event metadata (API-05).
//!
//! "Faults are routed events, not a subsystem" (PROJECT decision): a machine that
//! can fault exposes a single **reserved** output [`FAULT_PORT`] that the existing
//! tick fold routes exactly like any other output port. Wire it to a sink for a
//! dead-letter queue, or back through a delay belt for a retry loop — no special
//! plumbing. The first real Phase-2 fault producer is the router's
//! no-match-without-a-default (see [`crate::router`]).
//!
//! # Reserved port (Assumption A4)
//! Normal output ports are small ascending indices (`0..N`), so [`FAULT_PORT`] is
//! fixed at `u16::MAX` — the top of the [`PortId`](crate::ids::PortId) space — and
//! cannot collide with a normal port on any realistic topology. The reservation is
//! documented here so a future topology never hands a real machine port `u16::MAX`.
//!
//! # Trust boundary (threat T-2-FAULTDEC, mirrors [`crate::event::upcast`])
//! A [`Fault`] looped back through a retry belt re-enters as untrusted bytes.
//! [`Fault::decode`] therefore returns a [`Result`] and **never unwraps**: malformed
//! fault bytes yield `Err`, never a panic of the deterministic core (the same
//! decode-behind-a-`Result` discipline `event::upcast` applies at the on-disk
//! boundary). Encoding is plain serde data and cannot fail (`expect` is a true
//! invariant, not a runtime trust boundary).
//!
//! All types are plain serde data (CORE-09): no floats, no HashMaps, no pointers.

use crate::ids::{Item, NodeId, PortId};

/// The reserved fault output port — the top of the [`PortId`](crate::ids::PortId)
/// space. Normal output ports are small ascending indices (`0..N`), so this value
/// can never collide with a normal port (Assumption A4). Wired through the fold's
/// `links` map like any other output port; unwired, a fault emitted here is
/// dropped by the fold's existing missing-link no-op (threat T-2-FAULTPORT).
pub const FAULT_PORT: PortId = u16::MAX;

/// Why an item faulted. A **closed** enum — each producer maps to one variant.
/// The router's no-match (`NoMatch`) is the Phase-2 producer; Phase 4 adds the
/// two factory-sandbox variants (`FactoryError`, `FactoryTimeout`). Keeping it
/// closed means a new fault kind is a deliberate, reviewed addition rather than
/// an open-ended string.
///
/// # Wire-format discipline (variant ordering is LOAD-BEARING)
/// postcard encodes an enum by its variant **discriminant** (declaration index),
/// which is NOT self-describing. New variants are therefore **appended after**
/// the existing ones so prior discriminants never shift: `NoMatch` stays at 0,
/// so the frozen Phase-2 golden corpus (e.g. `0004-router-fault-mix`, which
/// encodes `NoMatch` faults) keeps decoding byte-identically after this addition.
/// Never reorder or insert before an existing variant.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum FaultReason {
    /// The router found no matching route and had no configured default output.
    /// Discriminant 0 — frozen by the Phase-2 golden corpus; never move it.
    NoMatch,
    /// A factory (Phase 4) tick failed with a non-timeout sandbox error: an
    /// uncaught JS throw, a reference to a withheld global, a `JSON.parse`
    /// failure on the input bytes, or a memory/stack-limit hit. The JS error
    /// string rides in [`Fault::payload`] for dead-letter inspection. Appended
    /// after `NoMatch` (discriminant 1) to preserve the existing wire format.
    FactoryError,
    /// A factory (Phase 4) tick tripped the deterministic per-tick gas fuse
    /// (the execution-driven interrupt-callback budget was exhausted — NOT a
    /// wall-clock timeout). Distinct from [`FaultReason::FactoryError`] so the
    /// fold can tell a runaway loop from a thrown error. Appended after
    /// `FactoryError` (discriminant 2) to preserve the existing wire format.
    FactoryTimeout,
    /// A dispatched command (Phase 5) did not resolve before its logged deadline:
    /// the host synthesized an [`crate::event::EventPayload::Timeout`], which
    /// [`crate::manual_inject::admit`] routes back to the emitting node's
    /// [`FAULT_PORT`] as this fault (EXEC-03). The deadline is logged data, so the
    /// routing is deterministic and platform-independent — NOT a wall-clock read.
    /// Appended after `FactoryTimeout` (discriminant 3) to preserve the wire format.
    CommandTimeout,
    /// A dispatched command (Phase 5) resolved with [`crate::command::Outcome::Failure`]
    /// (transport / status / dispatch error): [`crate::manual_inject::admit`] routes
    /// the logged failure back to the emitting node's [`FAULT_PORT`] as this fault
    /// (EXEC-02). Appended after `CommandTimeout` (discriminant 4) to preserve the
    /// wire format.
    CommandFailure,
    /// A request/response WIRE request (Phase 37) exceeded its per-request `budget`
    /// (WR-01) — too many in-flight/queued wire requests for the configured bound.
    /// The overflowing request faults to its emitting node's [`FAULT_PORT`] instead of
    /// being admitted. Appended after `CommandFailure` (discriminant 5) to preserve the
    /// existing wire format. PRODUCED since Phase 37 by two accountings: the per-request
    /// budget exhaustion in the tick's wire hop, and the entry-wire in-flight cap in
    /// `manual_inject::admit`.
    WireOverflow,
    /// A MECHANICAL delivery (Phase 71) that the destination inbox refused at
    /// [`crate::admit::MECHANICAL_INBOX_CAP`], emitted at the fold's generic outbox
    /// drain. Appended after `WireOverflow` (discriminant 6) to preserve the existing
    /// wire format; no prior discriminant moves, so every already-encoded fault in the
    /// frozen corpus decodes byte-identically.
    ///
    /// # Why this site faults where the belt-head site retains (ruling R-4)
    /// `PortOutbox::drain_sorted` is a `std::mem::take`, so by the time the drain loop
    /// body runs the item is already OUT of the outbox and there is nowhere to put a
    /// refused one back. The outbox is constructed fresh inside `step_node` and never
    /// crosses a tick boundary, and serializing it would be a `GridState` shape change
    /// that 71-CONTEXT D-09 forbids. So the refused item does not travel: it rides here
    /// as this fault's [`Fault::payload`] on the EMITTING node's [`FAULT_PORT`], for
    /// dead-letter inspection, exactly as [`FaultReason::NoMatch`] carries its item.
    /// The belt-head delivery has somewhere to put a refusal - slot 0 - so it RETAINS
    /// instead, and never mints this.
    ///
    /// # It is an INSTRUMENT, not decoration
    /// Plan 71-03's gate skips a node whose linked output cannot accept, which makes
    /// this path UNREACHABLE on a gated board. That plan asserts zero `OutputRefused`
    /// faults across a long run of the jammed demo board, and that assertion is the
    /// gate's own non-vacuity check: if the gate regresses, this count goes non-zero
    /// and the test reddens.
    OutputRefused,
    /// A request arrived for a node with NO WIRE LEAVING IT (Phase 72, SERVE-08) —
    /// there is nowhere for it to go, so it faults to the addressed node's
    /// [`FAULT_PORT`] and that node is woken.
    ///
    /// # The discriminant, ENUMERATED so the next reader does not have to count
    /// `NoMatch` 0, `FactoryError` 1, `FactoryTimeout` 2, `CommandTimeout` 3,
    /// `CommandFailure` 4, `WireOverflow` 5, `OutputRefused` 6. SEVEN exist, and this is
    /// the eighth, at **discriminant 7**, appended after `OutputRefused` to preserve the
    /// existing wire format. An older requirements note said there were six with a
    /// seventh appended at 6; THAT IS STALE, and a reader who inherits it and appends at
    /// 6 REORDERS A FROZEN ENUM, silently re-typing every already-encoded fault in the
    /// golden corpus. It is recorded here so the correction travels with the enum rather
    /// than living only in a plan summary.
    /// `route_path::the_new_variant_appends_at_discriminant_seven` pins all eight.
    ///
    /// # What it replaces, which is nothing at all
    /// `manual_inject`'s `WireRequest` admit arm found the entry wire with an
    /// `if let Some(..)` that had NO `else`. A request addressed to a node with no wire
    /// was DISCARDED INSIDE THE FOLD: no fault, no wake, the node's state byte IDLE
    /// forever, and the caller's only signal a host-side 504 three hundred ticks later
    /// naming nothing on the board. A request that looks accepted and never happens is
    /// the worst shape this codebase has, and this variant is what makes it visible.
    ///
    /// # Its payload is EMPTY, and that is deliberate
    /// [`Fault::payload`] carries the original faulted bytes for dead-letter inspection.
    /// This fault carries none, so there is NO DEAD LETTER here and clearing it destroys
    /// no evidence. That is precisely what makes the one self-clear D-25 grants
    /// (a `DrawWire` from the faulted node drains it) safe, where a blanket drain over
    /// every reason would eat a `CommandFailure`'s real payload.
    NoEntryWire,
    /// A Tee's output `branch` was BUSY when the Tee took an item (phase 87, JAM-02,
    /// 87-CONTEXT D-03): that branch's destination could not take one more item, so the
    /// branch did not get its copy. The copy rides here as [`Fault::payload`] on the Tee's
    /// [`FAULT_PORT`], the Tee counts it on `Tee.faults`, and the emission marks the Tee
    /// FAULTED on that tick, so the copy shows on the board and in the count and never
    /// vanishes. The Tee's other branches got their copies on the same step.
    ///
    /// # The discriminant, ENUMERATED
    /// `NoMatch` 0, `FactoryError` 1, `FactoryTimeout` 2, `CommandTimeout` 3,
    /// `CommandFailure` 4, `WireOverflow` 5, `OutputRefused` 6, `NoEntryWire` 7. NINE exist
    /// with this one, at **discriminant 8**, appended after `NoEntryWire` so no earlier
    /// discriminant moves. Its `branch` field is written by postcard AFTER the
    /// discriminant byte, so carrying data does not shift any earlier reason either.
    /// `route_path::the_branch_busy_variant_appends_at_discriminant_eight` pins all nine.
    BranchBusy {
        /// The Tee output port whose destination was full.
        branch: PortId,
    },
}

/// The faulted-event metadata that rides a faulted item down the [`FAULT_PORT`].
///
/// It carries the [`reason`](Fault::reason), the [`source`](Fault::source) node
/// that produced the fault, an [`attempt`](Fault::attempt) count (set to 1 on
/// production; auto-increment-on-retry is RES-01/v2, Assumption A2), and the
/// original item bytes as [`payload`](Fault::payload) for dead-letter inspection
/// or retry re-processing. Plain serde data (CORE-09) so it encodes onto a belt
/// and round-trips byte-identically.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Fault {
    /// Why the item faulted.
    pub reason: FaultReason,
    /// The node that produced the fault.
    pub source: NodeId,
    /// Attempt count, riding the item. Set to 1 on production; retry-loop
    /// auto-increment is RES-01/v2 (Assumption A2), out of scope for Phase 2.
    pub attempt: u32,
    /// The original faulted item bytes — for dead-letter inspection and retry
    /// re-processing.
    pub payload: Vec<u8>,
}

impl Fault {
    /// Build a `NoMatch` fault for `item` produced by `source`, attempt = 1. The
    /// item's bytes are carried as the payload so a dead-letter sink can inspect
    /// them and a retry belt can re-process them.
    pub fn no_match(source: NodeId, item: Item) -> Self {
        Self {
            reason: FaultReason::NoMatch,
            source,
            attempt: 1,
            payload: item.0,
        }
    }

    /// Build a factory fault (Phase 4) for `source` with the given `reason`
    /// ([`FaultReason::FactoryError`] or [`FaultReason::FactoryTimeout`]),
    /// attempt = 1, carrying `message` — the JS error string bytes — as the
    /// [`payload`](Fault::payload) for dead-letter inspection.
    ///
    /// Mirrors [`Fault::no_match`]: the producer stamps `attempt = 1`; retry-loop
    /// auto-increment is RES-01/v2. Unlike `no_match` (whose payload is the
    /// original item bytes), a factory fault's payload is the error message so a
    /// dead-letter sink can see *why* the tick failed.
    pub fn factory(source: NodeId, reason: FaultReason, message: Vec<u8>) -> Self {
        Self {
            reason,
            source,
            attempt: 1,
            payload: message,
        }
    }

    /// Build a command fault (Phase 5) for `source` with the given `reason`
    /// ([`FaultReason::CommandTimeout`] or [`FaultReason::CommandFailure`]),
    /// attempt = 1, carrying `payload` for dead-letter inspection.
    ///
    /// Mirrors [`Fault::factory`]: the producer (here, [`crate::manual_inject::admit`]
    /// folding a logged `Timeout`/`CommandResult{Failure}`) stamps `attempt = 1`;
    /// retry-loop auto-increment is RES-01/v2. The `payload` is the dispatch
    /// diagnostic bytes (empty for v1, where the failure carries no body) — never a
    /// secret (the host strips any auth material before logging).
    pub fn command(source: NodeId, reason: FaultReason, payload: Vec<u8>) -> Self {
        Self {
            reason,
            source,
            attempt: 1,
            payload,
        }
    }

    /// Build a [`FaultReason::BranchBusy`] fault (phase 87, JAM-02, D-03) for the Tee
    /// `source` whose output `branch` could not take `item`, attempt = 1. The copy's bytes
    /// are the payload, as [`Fault::no_match`] carries its item, so a dead-letter reader
    /// sees exactly what the busy branch missed.
    pub fn branch_busy(source: NodeId, branch: PortId, item: Item) -> Self {
        Self {
            reason: FaultReason::BranchBusy { branch },
            source,
            attempt: 1,
            payload: item.0,
        }
    }

    /// Encode the fault as an [`Item`] (postcard plain data) to ride a belt. This
    /// cannot fail — `Fault` is plain serde data — so the `expect` is a true
    /// invariant, not a runtime trust boundary.
    pub fn encode(&self) -> Item {
        Item(postcard::to_allocvec(self).expect("Fault is plain serde data"))
    }

    /// Decode a fault from an [`Item`]'s untrusted bytes (a fault looped back
    /// through a retry belt). Returns `Err(())` on malformed bytes — **never**
    /// panics (threat T-2-FAULTDEC, mirroring [`crate::event::upcast`]).
    ///
    /// The unit error is deliberate: there is a single failure mode (the bytes
    /// are not a `Fault`), so a richer typed error would carry no extra signal —
    /// the boundary's whole job is "decode or refuse, never panic". `clippy`'s
    /// `result_unit_err` style lint is allowed here for that reason.
    #[allow(clippy::result_unit_err)]
    pub fn decode(item: &Item) -> Result<Self, ()> {
        postcard::from_bytes(&item.0).map_err(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use slotmap::SlotMap;

    /// Mint one real generational `NodeId`.
    fn one_id() -> NodeId {
        let mut alloc: SlotMap<NodeId, ()> = SlotMap::with_key();
        alloc.insert(())
    }

    #[test]
    fn fault_encode_decode_round_trips() {
        // A NoMatch fault encodes to an Item and decodes back to an equal Fault
        // carrying reason=NoMatch, the source node id, attempt=1, and the original
        // item bytes as payload.
        let source = one_id();
        let item = Item(vec![0x01, 0x02, 0x03]);
        let fault = Fault::no_match(source, item.clone());

        assert_eq!(fault.reason, FaultReason::NoMatch);
        assert_eq!(fault.source, source);
        assert_eq!(fault.attempt, 1);
        assert_eq!(fault.payload, item.0);

        let encoded = fault.encode();
        let decoded = Fault::decode(&encoded).expect("a well-formed fault decodes");
        assert_eq!(decoded, fault, "encode -> decode round-trips byte-faithfully");
    }

    #[test]
    fn fault_decode_garbage_is_err_not_panic() {
        // Arbitrary / short bytes looped back from a belt must yield Err, never a
        // panic (threat T-2-FAULTDEC). Postcard is not self-describing, so most
        // random bytes fail to decode into a Fault; we assert the boundary holds
        // for several adversarial inputs (empty, short, all-0xFF).
        for garbage in [
            Item(vec![]),
            Item(vec![0x00]),
            Item(vec![0xFF; 3]),
            Item(vec![0xFF; 64]),
        ] {
            let result = Fault::decode(&garbage);
            assert!(
                result.is_err(),
                "garbage bytes {:?} decode to Err, never panic",
                garbage.0
            );
        }
    }

    #[test]
    fn fault_factory_encode_decode_round_trips() {
        // A factory fault (FactoryError) carries the JS error message bytes as
        // payload, attempt=1, and round-trips byte-faithfully through postcard.
        let source = one_id();
        let message = b"TypeError: Math.sin is not a function".to_vec();
        let fault = Fault::factory(source, FaultReason::FactoryError, message.clone());

        assert_eq!(fault.reason, FaultReason::FactoryError);
        assert_eq!(fault.source, source);
        assert_eq!(fault.attempt, 1);
        assert_eq!(fault.payload, message);

        let encoded = fault.encode();
        let decoded = Fault::decode(&encoded).expect("a well-formed factory fault decodes");
        assert_eq!(decoded, fault, "factory fault encode -> decode round-trips");

        // A FactoryTimeout fault also round-trips.
        let timeout = Fault::factory(source, FaultReason::FactoryTimeout, b"gas fuse tripped".to_vec());
        let decoded_timeout =
            Fault::decode(&timeout.encode()).expect("a FactoryTimeout fault decodes");
        assert_eq!(decoded_timeout, timeout);
    }

    #[test]
    fn fault_factory_reasons_are_distinct() {
        // FactoryError and FactoryTimeout are distinct variants the fold can
        // disambiguate (a thrown error vs a runaway-loop fuse trip).
        assert_ne!(FaultReason::FactoryError, FaultReason::FactoryTimeout);
        assert_ne!(FaultReason::FactoryError, FaultReason::NoMatch);
        assert_ne!(FaultReason::FactoryTimeout, FaultReason::NoMatch);
    }

    #[test]
    fn fault_nomatch_still_decodes_after_variant_additions() {
        // Discriminant-preservation regression: appending FactoryError/
        // FactoryTimeout AFTER NoMatch must keep NoMatch at discriminant 0, so a
        // NoMatch fault encoded with the old wire format still decodes equal. We
        // assert this by encoding-then-decoding (the wire shape is unchanged) AND
        // by pinning the exact discriminant byte postcard emits for NoMatch (0).
        let source = one_id();
        let item = Item(vec![0xDE, 0xAD, 0xBE, 0xEF]);
        let fault = Fault::no_match(source, item);

        let encoded = fault.encode();
        let decoded = Fault::decode(&encoded).expect("a NoMatch fault still decodes");
        assert_eq!(decoded, fault, "NoMatch round-trips unchanged after appends");

        // postcard encodes the leading enum discriminant as a varint; NoMatch is
        // declared first, so its discriminant byte is 0 — frozen by the golden
        // corpus. This locks the load-bearing variant ordering.
        assert_eq!(encoded.0.first(), Some(&0u8), "NoMatch discriminant is 0");
    }

    #[test]
    fn fault_command_encode_decode_round_trips() {
        // A command fault (CommandFailure / CommandTimeout) carries attempt=1 and
        // its payload bytes, and round-trips byte-faithfully through postcard.
        let source = one_id();
        let failure = Fault::command(source, FaultReason::CommandFailure, vec![0x01, 0x02]);
        assert_eq!(failure.reason, FaultReason::CommandFailure);
        assert_eq!(failure.source, source);
        assert_eq!(failure.attempt, 1);
        assert_eq!(failure.payload, vec![0x01, 0x02]);
        let decoded = Fault::decode(&failure.encode()).expect("a CommandFailure fault decodes");
        assert_eq!(decoded, failure, "command fault encode -> decode round-trips");

        // A CommandTimeout fault (empty payload, the v1 shape) also round-trips.
        let timeout = Fault::command(source, FaultReason::CommandTimeout, Vec::new());
        let decoded_timeout =
            Fault::decode(&timeout.encode()).expect("a CommandTimeout fault decodes");
        assert_eq!(decoded_timeout, timeout);
    }

    #[test]
    fn fault_command_reasons_appended_after_factory_reasons() {
        // Append discipline: CommandTimeout/CommandFailure are distinct, follow the
        // factory reasons, and the leading discriminant byte postcard emits for the
        // reason field pins their declaration index (3, 4). We assert via a bare
        // FaultReason encode (a single varint discriminant for a fieldless variant).
        assert_ne!(FaultReason::CommandTimeout, FaultReason::CommandFailure);
        assert_ne!(FaultReason::CommandTimeout, FaultReason::FactoryTimeout);
        let timeout = postcard::to_allocvec(&FaultReason::CommandTimeout).expect("encode reason");
        assert_eq!(timeout.first(), Some(&3u8), "CommandTimeout discriminant is 3");
        let failure = postcard::to_allocvec(&FaultReason::CommandFailure).expect("encode reason");
        assert_eq!(failure.first(), Some(&4u8), "CommandFailure discriminant is 4");
        // The frozen earlier discriminants are unchanged.
        assert_eq!(
            postcard::to_allocvec(&FaultReason::NoMatch).expect("encode").first(),
            Some(&0u8)
        );
    }

    #[test]
    fn fault_port_constant() {
        // The reserved fault port is u16::MAX — it cannot collide with the small
        // ascending output indices 0..N normal ports use (Assumption A4).
        assert_eq!(FAULT_PORT, u16::MAX);
    }
}
