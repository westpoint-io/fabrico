//! The designed-in command / dispatch / result-event seam (types only).
//!
//! Per CONTEXT "define the types now and stub the executor": the core emits
//! [`Command`]s as *intent*, the executor (Phase 5) turns them into real side
//! effects (HTTP) off the sim thread and returns [`ResultEvent`]s that
//! re-enter the deterministic fold as logged events. In Phase 1 the only
//! [`Effect`] is [`Effect::Noop`] and the only [`Dispatch`] impl is
//! [`NoopExecutor`], which does nothing — but the contract is versioned from
//! commit zero ([`EVENT_VERSION`]) so logs written now stay forward-compatible.
//!
//! Everything here is plain serde data (CORE-09); the only behaviour is the
//! muted no-op dispatch.

use crate::ids::{CommandId, Item, PartitionKey};

/// Version stamped onto every [`Command`] / [`ResultEvent`] from commit zero.
/// Bumped when the command/result wire shape changes so the Phase 5 executor
/// can upcast older intents. Bumped `1 -> 2` in Phase 5 when [`Effect`] gained the
/// `Debug`/`Email`/`Http` variants and [`Outcome`] gained `Success`/`Failure`
/// (an append-only change; the golden corpus carries no `Command` payloads, so
/// this has zero corpus impact). Bumped `2 -> 3` by the v6.0 coordinated re-bless
/// (35-03): it rides in LOCKSTEP with the byte-forced SNAPSHOT `7 -> 8` (`Port.medium`)
/// and the EDIT `5 -> 6` / PROJECT `5 -> 6` / event `SCHEMA_VERSION` `1 -> 2` bumps -
/// the single coordinated act that spends the corpus blast radius exactly once for all
/// of v6.0. Still zero corpus impact (no `Command` payloads in the corpus).
///
/// Bumped `3 -> 4` by Phase 72 (72-12, D-20). This one is a PURE WIRE-FORMAT
/// declaration and it MOVES ZERO CORPUS BYTES, measured rather than assumed: golden
/// `log.postcard` files carry
/// [`EventPayload`](crate::event::EventPayload), never a `Command` or an
/// [`Effect`], and `Core` does not serialize commands at all. Do not attribute any
/// fixture move to this constant.
///
/// It still has to be taken. Phase 72 (D-07) grew a serialized [`Effect`] variant that
/// rides the redb command log at RUNTIME, so a stored intent written before this phase
/// no longer has the shape this code decodes. A wire version that does not move when the
/// wire moves is worse than no version at all: it tells the executor that an old intent
/// is current. In lockstep with SNAPSHOT `10 -> 11` and PROJECT `8 -> 9`; EDIT stays 7
/// and event `SCHEMA_VERSION` stays 2 (D-21).
///
/// Bumped `4 -> 5` by Phase 85 (plan 85-05, D-08, CHROME-04): `Effect::Email` is DELETED,
/// with no placeholder left in its place, so `Http` moves from discriminant 3 to 2 and
/// `Reply` from 4 to 3. A stored v4 intent carrying an Email effect would otherwise
/// decode as an `Http` effect against the shifted enum. Before this bump nothing read
/// `Command.event_version` on decode at all; [`decode_command`] now refuses any value
/// other than this one through [`check_event_version`], and the host's command ledger
/// applies the same check when it reads a stored row. Frozen witness:
/// `frozen_v4_email_command_is_refused_under_v5`. MEASURED corpus cost: zero (golden
/// `log.postcard` files carry `EventPayload`, never a `Command`). In lockstep with
/// SNAPSHOT `12 -> 13` and EDIT `11 -> 12`; event `SCHEMA_VERSION` stays 2 and PROJECT
/// stays 11 (it moves once, with its final v12 shape, in plan 85-09).
pub const EVENT_VERSION: u16 = 5;

/// The ONE stored-command version predicate: `Ok(())` for exactly [`EVENT_VERSION`],
/// [`DecodeError::UnknownVersion`](crate::event::DecodeError::UnknownVersion) naming the
/// found version for every other value, older or newer (the pre-v1 clean break: no
/// upcast shim exists for an older intent).
pub fn check_event_version(found: u16) -> Result<(), crate::event::DecodeError> {
    if found != EVENT_VERSION {
        return Err(crate::event::DecodeError::UnknownVersion(found));
    }
    Ok(())
}

/// Decode a stored [`Command`] from untrusted bytes, refusing any other wire version
/// BEFORE the body is touched.
///
/// `event_version` is the struct's first field, so it is the leading varint of the
/// bytes. It is peeked and checked with [`check_event_version`] first: an old intent
/// whose effect discriminant now names a different variant is refused as
/// `UnknownVersion(found)`, never decoded as that variant. Bytes that do not decode are
/// [`DecodeError::Malformed`](crate::event::DecodeError::Malformed), never a panic.
pub fn decode_command(bytes: &[u8]) -> Result<Command, crate::event::DecodeError> {
    let (found, _) = postcard::take_from_bytes::<u16>(bytes)
        .map_err(|_| crate::event::DecodeError::Malformed)?;
    check_event_version(found)?;
    postcard::from_bytes::<Command>(bytes).map_err(|_| crate::event::DecodeError::Malformed)
}

/// A unit of side-effecting intent emitted by the sim core.
///
/// The core never performs the effect itself; it hands the `Command` to a
/// [`Dispatch`] implementation. `id` is the deterministic idempotency key
/// (`(tick, source node, seq)`), enabling exactly-once in Phase 5.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Command {
    /// Wire version, equal to [`EVENT_VERSION`] at emit time.
    pub event_version: u16,
    /// Deterministic idempotency key.
    pub id: CommandId,
    /// Partition this command belongs to (CORE-08).
    pub partition: PartitionKey,
    /// The intended effect (only [`Effect::Noop`] in Phase 1).
    pub effect: Effect,
    /// Tick-based deadline; the Phase 5 executor uses it for timeouts.
    pub deadline: u64,
}

/// The side effect a [`Command`] intends. The Debug and HTTP variants landed in Phase 5;
/// Phase 1 carried only the muted [`Effect::Noop`].
///
/// # Wire-format discipline (variant ordering is LOAD-BEARING)
/// postcard encodes an enum by its variant **discriminant** (declaration index),
/// which is NOT self-describing. New variants are therefore **appended after** the
/// existing ones so prior discriminants never shift: `Noop` stays at 0, so any
/// frozen log that encoded a `Noop` effect keeps decoding byte-identically after
/// these Phase-5 appends. Never reorder or insert before an existing variant.
///
/// The one sanctioned exception is a DELETION under a version bump. Phase 85 (D-08)
/// deleted the Email variant that sat at 2, with no placeholder kept, so the
/// discriminants are now `Noop` 0, `Debug` 1, `Http` 2, `Reply` 3, and
/// [`EVENT_VERSION`] moved `4 -> 5` so an older stored intent is refused rather than
/// read against the shifted list.
///
/// # No secrets ride on an `Effect` (Pitfall 6, threat T-05-01-SECRET)
/// An `Effect` is *intent only* and is written to the forever-log. Auth tokens and
/// any other secret are injected by the host executor from its (never-logged) config
/// at dispatch time; they MUST NEVER appear on any field here. The `body`/`message`
/// bytes are the per-item payload; `url` is routing intent, not authentication
/// material.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum Effect {
    /// No side effect — the Phase 1 placeholder. Discriminant 0 — FROZEN, never move.
    Noop,
    /// Log/inspect the per-item bytes in-host (the first, I/O-free Phase-5 sink).
    /// `message` is the per-item payload bytes. Appended at discriminant 1.
    Debug {
        /// The per-item payload bytes to surface to the debug sink. No secrets.
        message: Vec<u8>,
    },
    /// POST `body` to `url`. Intent only — any auth header references a host-config
    /// key resolved at dispatch time, never the secret itself (Pitfall 6).
    /// Discriminant 2 since Phase 85 deleted the Email variant before it (it was 3).
    Http {
        /// Target URL (routing intent, not a secret).
        url: String,
        /// The per-item payload bytes (the request body). No secrets.
        body: Vec<u8>,
        /// The HTTP verb to dispatch with (CFG-01). **Appended LAST** so a frozen
        /// log carrying the old two-field `Http` shape is refused by the coordinated
        /// v6.0 version bump, never silently mis-decoded. Default [`HttpMethod::Post`];
        /// dispatched by the host as the actual verb since Phase 39 (`executor.rs` passes
        /// it straight to `dispatch_http`); it is no longer an unconditional POST.
        method: crate::state::HttpMethod,
    },
    /// Reply to a correlated request/response WIRE request (WR-01, Phase 38) — the
    /// intent that resolves a pending
    /// [`EventPayload::WireRequest`](crate::event::EventPayload::WireRequest) by its
    /// `correlation` id. Appended LAST at discriminant 4 in Phase 38; discriminant 3
    /// since Phase 85 deleted the Email variant (zero corpus instances land here).
    /// Resolved by the host since Phase 38 (the pending-request registry retires the
    /// correlation on it). Minimal by design: it
    /// carries
    /// ONLY the correlation/routing intent, honoring the "no secrets ride on an
    /// `Effect`" discipline — NO auth material, NO response body here. The full HTTP
    /// response payload (status/headers/body, ENDP-02) appends append-LAST in Phase
    /// 38 (keeping this a zero-cap surface now).
    Reply {
        /// The correlation id of the [`WireRequest`](crate::event::EventPayload::WireRequest)
        /// this reply resolves (routing intent, not a secret).
        correlation: u64,
        /// The per-item response body bytes. **Appended LAST** (after `correlation`,
        /// byte-additive) so any frozen log decodes byte-identically — zero corpus
        /// instances land here.
        ///
        /// # CORRECTION (Phase 72 plan 04): this is NOT the final shape
        /// From Phase 38 until Phase 72 this docblock declared the variant's shape FINAL
        /// and promised the serialized form would never grow again. THAT CLAIM IS NOW
        /// FALSE, so it is DELETED here rather than left standing beside its own
        /// contradiction (it is not quoted back either: a sentence a later engineer could
        /// build on should not survive in the file in any form, asserted or requoted).
        /// Two fields grew AFTER `payload` in Phase 72: `return_addr` and `budget`. WHAT
        /// GREW: the reply now carries the caller's own reply address and the request's
        /// remaining hop budget. WHY: the return cable used to be chosen by scanning for
        /// the lowest-`NodeId` wire out of the handler, with no reference to who was owed
        /// the answer, so on a board where two callers share one handler the second
        /// caller's reply rode the first caller's cable (WINDOWS 124). An address the
        /// reply carries is the only thing that can pick the right cable.
        ///
        /// It still honors the "no secrets ride on an `Effect`" discipline: payload is
        /// per-item body bytes / routing intent, NEVER auth material. Carried end to end
        /// since Phase 38.
        payload: Item,
        /// The caller's logical reply address: the `(node, port)` handle the answer is
        /// owed to (API-03: a handle, never a raw pointer). Read by
        /// `tick::route_replies` to select the RETURN WIRE BY ADDRESS (the wire out of
        /// the handler whose `to.node` equals `return_addr.0`) instead of by an
        /// ascending-`NodeId` scan.
        ///
        /// **Appended after `payload`** (byte-additive; postcard encodes a struct
        /// variant field by field in DECLARATION ORDER, so appending moves no earlier
        /// byte). MEASURED cost to the frozen corpus: ZERO. Event logs carry
        /// [`crate::event::EventPayload`], not `Command`/`Effect`, and `Core` does not
        /// serialize commands at all, so no corpus fixture holds a `Reply` instance to
        /// re-encode. That is the argument a reader can check, not one to trust:
        /// `grep -rn 'Effect::Reply' crates/fabrico-core/tests/golden` finds nothing.
        ///
        /// Sourced from the [`crate::wire::WireEnvelope`] the handler was servicing,
        /// which already recorded who asked. It is never re-derived from a second place.
        return_addr: (crate::ids::NodeId, crate::ids::PortId),
        /// The request's REMAINING hop budget at the moment the handler was reached, so
        /// the reply INHERITS it rather than starting a fresh one and the whole
        /// forward-plus-return round trip stays bounded by ONE budget (the DEPTH bound,
        /// [`crate::wire::DEFAULT_WIRE_BUDGET`]).
        ///
        /// **Appended after `return_addr`**, same byte-additive rule and same measured
        /// zero corpus cost as above. Sourced from the same
        /// [`crate::wire::WireEnvelope`], never re-derived.
        budget: u64,
    },
}

/// The logged result of a dispatched command, re-entering the fold as an event
/// ([`crate::event::EventPayload::CommandResult`]).
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ResultEvent {
    /// The command this result corresponds to.
    pub command_id: CommandId,
    /// Tick at which the result is admitted back into the sim.
    pub tick: u64,
    /// The outcome (only [`Outcome::Pending`] in Phase 1).
    pub outcome: Outcome,
}

/// The outcome of a dispatched command. Success/Failure variants are Phase 5;
/// Phase 1 carried only [`Outcome::Pending`].
///
/// # Wire-format discipline (variant ordering is LOAD-BEARING)
/// New variants are **appended after** the existing ones so prior discriminants
/// never shift: `Pending` stays at 0. Never reorder or insert before an existing
/// variant.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum Outcome {
    /// Not yet resolved — the Phase 1 placeholder. Discriminant 0 — FROZEN.
    Pending,
    /// The effect dispatched successfully. Appended at discriminant 1. A
    /// validated-then-fire-and-forget result for v1 sinks (re-enters the fold as
    /// a logged audit event; see [`crate::manual_inject::admit`]).
    Success,
    /// The effect failed (transport / status / timeout-at-dispatch error).
    /// Appended at discriminant 2. Routes to the emitting node's fault port via
    /// [`crate::manual_inject::admit`].
    Failure,
}

/// The executor seam. Phase 5 implements a real dispatcher; Phase 1 ships the
/// muted [`NoopExecutor`] so the fold can emit intent and compile.
pub trait Dispatch {
    /// Consume a command's intent. Implementations perform the side effect
    /// off the sim thread and later feed a [`ResultEvent`] back as a log event.
    fn dispatch(&mut self, cmd: &Command);
}

/// A do-nothing [`Dispatch`] — the Phase 1 executor stub.
#[derive(Clone, Copy, Debug, Default)]
pub struct NoopExecutor;

impl Dispatch for NoopExecutor {
    fn dispatch(&mut self, _cmd: &Command) {
        // Muted in Phase 1; the real executor arrives in Phase 5.
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ids::NodeId;
    use slotmap::SlotMap;

    fn sample_command() -> Command {
        let mut alloc: SlotMap<NodeId, ()> = SlotMap::with_key();
        let src = alloc.insert(());
        Command {
            event_version: EVENT_VERSION,
            id: (5, src, 0),
            partition: 0,
            effect: Effect::Noop,
            deadline: 100,
        }
    }

    #[test]
    fn command_carries_event_version_and_round_trips() {
        let cmd = sample_command();
        assert_eq!(cmd.event_version, EVENT_VERSION);

        let bytes = postcard::to_allocvec(&cmd).expect("serialize command");
        let restored: Command = postcard::from_bytes(&bytes).expect("deserialize command");
        assert_eq!(cmd, restored);

        // Re-encode is byte-identical.
        let bytes2 = postcard::to_allocvec(&restored).expect("re-serialize command");
        assert_eq!(bytes, bytes2);
    }

    #[test]
    fn frozen_v4_email_command_is_refused_under_v5() {
        // PHASE 85'S OWN RED (85-CONTEXT.md D-08, CHROME-04). A stored v4 `Command` whose
        // effect is the removed `Effect::Email` must be refused by its version, never
        // decoded against the shifted enum (where its discriminant, 2, now names `Http`).
        // FALSE until `EVENT_VERSION` reads 5 and `decode_command` checks it.
        //
        // PROVENANCE. Captured ONCE at a pre-release commit (plan 85-05's start revision,
        // EVENT 4) from a postcard encode of:
        //   Command { event_version: 4, id: (5, <a slotmap NodeId>, 0), partition: 0,
        //             effect: Effect::Email { to: "a@b.c", subject: "x", body: b"{}" },
        //             deadline: 100 }
        // Byte 6 is the v4 Effect discriminant of Email, 2. Hard-coded, never regenerated.
        const FROZEN_V4_EMAIL_COMMAND: &[u8] = &[
            0x04, 0x05, 0x01, 0x01, 0x00, 0x00, 0x02, 0x05, 0x61, 0x40, 0x62, 0x2E, 0x63, 0x01,
            0x78, 0x02, 0x7B, 0x7D, 0x64,
        ];
        assert_eq!(FROZEN_V4_EMAIL_COMMAND[0], 0x04, "the witness declares event_version 4");
        assert_eq!(
            FROZEN_V4_EMAIL_COMMAND[6], 0x02,
            "byte 6 is the v4 Effect discriminant of the removed mail effect"
        );
        assert_eq!(
            decode_command(FROZEN_V4_EMAIL_COMMAND),
            Err(crate::event::DecodeError::UnknownVersion(4)),
            "a frozen v4 mail-effect command must be refused as UnknownVersion(4) under v5"
        );

        // And a current command still round-trips through the same door.
        let cmd = sample_command();
        let bytes = postcard::to_allocvec(&cmd).expect("serialize command");
        assert_eq!(decode_command(&bytes), Ok(cmd), "a current command decodes");
    }

    #[test]
    fn command_noop_executor_dispatch_is_a_noop() {
        let cmd = sample_command();
        let mut exec = NoopExecutor;
        // Compiles and performs no side effect; nothing to assert beyond
        // "does not panic / does not mutate observable state".
        exec.dispatch(&cmd);
    }

    #[test]
    fn command_result_event_round_trips() {
        let mut alloc: SlotMap<NodeId, ()> = SlotMap::with_key();
        let src = alloc.insert(());
        let re = ResultEvent {
            command_id: (7, src, 1),
            tick: 9,
            outcome: Outcome::Pending,
        };
        let bytes = postcard::to_allocvec(&re).expect("serialize result");
        let restored: ResultEvent = postcard::from_bytes(&bytes).expect("deserialize result");
        assert_eq!(re, restored);
    }

    #[test]
    fn command_effect_new_variants_round_trip() {
        // Each appended Phase-5 Effect variant round-trips through postcard.
        for effect in [
            Effect::Debug {
                message: vec![0x01, 0x02, 0x03],
            },
            Effect::Http {
                url: "https://example.com/hook".to_owned(),
                body: vec![0xDE, 0xAD],
                method: crate::state::HttpMethod::Post,
            },
        ] {
            let bytes = postcard::to_allocvec(&effect).expect("serialize effect");
            let restored: Effect = postcard::from_bytes(&bytes).expect("deserialize effect");
            assert_eq!(effect, restored, "effect round-trips byte-faithfully");
        }
    }

    #[test]
    fn command_effect_noop_discriminant_pinned_at_zero() {
        // Append discipline: Noop must stay at discriminant 0 so a frozen log that
        // encoded a Noop effect keeps decoding after the Phase-5 appends. postcard
        // encodes the leading enum discriminant as a varint.
        let bytes = postcard::to_allocvec(&Effect::Noop).expect("serialize Noop");
        assert_eq!(bytes.first(), Some(&0u8), "Noop discriminant is 0");
        // And the appended variants take the next discriminants in order.
        let debug = postcard::to_allocvec(&Effect::Debug { message: Vec::new() })
            .expect("serialize Debug");
        assert_eq!(debug.first(), Some(&1u8), "Debug discriminant is 1");
        // Phase 85 deleted Email (it sat at 2) with no placeholder: Http and Reply
        // each moved down one, under the EVENT_VERSION 4 -> 5 bump.
        let http = postcard::to_allocvec(&Effect::Http {
            url: String::new(),
            body: Vec::new(),
            method: crate::state::HttpMethod::Post,
        })
        .expect("serialize Http");
        assert_eq!(http.first(), Some(&2u8), "Http discriminant is 2");
        let mut alloc: SlotMap<NodeId, ()> = SlotMap::with_key();
        let node = alloc.insert(());
        let reply = postcard::to_allocvec(&Effect::Reply {
            correlation: 0,
            payload: Item(Vec::new()),
            return_addr: (node, 0),
            budget: 0,
        })
        .expect("serialize Reply");
        assert_eq!(reply.first(), Some(&3u8), "Reply discriminant is 3");
    }

    #[test]
    fn command_outcome_new_variants_round_trip() {
        for outcome in [Outcome::Success, Outcome::Failure] {
            let bytes = postcard::to_allocvec(&outcome).expect("serialize outcome");
            let restored: Outcome = postcard::from_bytes(&bytes).expect("deserialize outcome");
            assert_eq!(outcome, restored, "outcome round-trips byte-faithfully");
        }
    }

    #[test]
    fn command_outcome_pending_discriminant_pinned_at_zero() {
        // Pending stays at discriminant 0; Success/Failure are appended after.
        let pending = postcard::to_allocvec(&Outcome::Pending).expect("serialize Pending");
        assert_eq!(pending.first(), Some(&0u8), "Pending discriminant is 0");
        let success = postcard::to_allocvec(&Outcome::Success).expect("serialize Success");
        assert_eq!(success.first(), Some(&1u8), "Success discriminant is 1");
        let failure = postcard::to_allocvec(&Outcome::Failure).expect("serialize Failure");
        assert_eq!(failure.first(), Some(&2u8), "Failure discriminant is 2");
    }
}
