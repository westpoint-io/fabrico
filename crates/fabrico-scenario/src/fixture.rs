//! The [`Scenario`] two-log fixture bundle — the on-disk authoring format.
//!
//! A `Scenario` is the harness analog of the host's `ProjectFile` (project.rs:101)
//! MINUS the snapshot: it bundles the genesis `seed` with BOTH ordered logs (the
//! topology `edit_log` and the runtime `event_log`) and nothing else. A fixture is
//! REPLAYED from genesis (via [`GridSession::replay_two_logs`](fabrico_command::GridSession::replay_two_logs)),
//! never restored from a snapshot, so the bundle carries no derived state — only the
//! two source-of-truth logs the deterministic core folds.
//!
//! # Plain ordered serde — byte-determinism (SAVE-02 discipline)
//! Like `ProjectFile`, every field is plain ordered serde data: two `Vec`s, no
//! `HashMap`/`HashSet` anywhere in the struct or the types it nests. `postcard` then
//! re-encodes a `Scenario` BYTE-IDENTICALLY across runs (a `HashMap` would serialize
//! in a per-process-random order and break that). [`Scenario::to_bytes`] /
//! [`Scenario::from_bytes`] are the round-trip pair the golden corpus freezes.
//!
//! # Untrusted-decode discipline (threat T-13-08)
//! [`Scenario::from_bytes`] decodes behind a typed `Result<Scenario, postcard::Error>`
//! and NEVER unwraps — arbitrary / hostile bytes fail as a returned error, never a
//! panic, mirroring the host `load_project` reject-only principle. (The DEEPER trust
//! gate — that the decoded logs themselves are well-formed — is enforced downstream by
//! `run_log_two_logs`' span bound when the scenario is actually replayed; decoding the
//! bundle is only the first layer.)
//!
//! # There is NO version gate on this path, and that is deliberate
//! This paragraph used to name "`upcast`'s forward-version refusal" as part of the
//! downstream gate. That was false and is corrected here rather than left to be
//! re-derived: replay goes `Scenario::from_bytes` -> `run_log_two_logs`, and NEITHER
//! consults `EditRecord::schema_version`. `edit::upcast` is never called on this path,
//! and Phase 63's RESEARCH FINDING 3 established it has no production callers anywhere.
//!
//! The consequence is worth stating plainly, because it is what makes the golden-corpus
//! measurement necessary: after an `EDIT_SCHEMA_VERSION` bump a committed fixture goes
//! STALE, not red. It keeps replaying to its frozen hashes at the old version forever,
//! and nothing in this crate would ever tell you. The guard that DOES fire is
//! `bless_fixtures::committed_fixtures_match_authoring`, which compares committed bytes
//! against freshly authored ones - an AUTHORING-equality check, not a version check.
//! `scripts/measure-golden-corpus.sh` is the equivalent instrument for the
//! `fabrico-core` golden corpus, which has no such guard at all.

use fabrico_core::edit::EditRecord;
use fabrico_core::event::Event;
use serde::{Deserialize, Serialize};

/// A portable, replayable test scenario: the genesis `seed` plus the two ordered
/// logs a [`GridSession`](fabrico_command::GridSession) owns. Equivalent to the host
/// `ProjectFile` (project.rs:101) with the snapshot field removed — a fixture always
/// rebuilds from genesis, so it needs no snapshot.
///
/// Plain ordered serde data (no `HashMap`/`HashSet`) so `postcard` encodes it
/// deterministically and byte-identically (SAVE-02 discipline).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Scenario {
    /// The genesis RNG seed — fed to `GridSession::replay_two_logs` so the replayed
    /// core reconstructs the identical random stream.
    pub seed: u64,
    /// The topology edit-log (RESOLVED records) — the FIRST ordered log, folded
    /// EDITS-FIRST per tick.
    pub edit_log: Vec<EditRecord>,
    /// The runtime event-log (pumped events) — the SECOND ordered log, folded after
    /// the same-tick edits.
    pub event_log: Vec<Event>,
}

impl Scenario {
    /// A scenario bundling `seed` with both ordered logs.
    #[must_use]
    pub fn new(seed: u64, edit_log: Vec<EditRecord>, event_log: Vec<Event>) -> Self {
        Self {
            seed,
            edit_log,
            event_log,
        }
    }

    /// Encode to the canonical `postcard` bytes. Plain ordered serde data serializes
    /// infallibly + deterministically; the `expect` is unreachable for a well-formed
    /// in-memory `Scenario` (it would only fire on an allocator failure).
    #[must_use]
    pub fn to_bytes(&self) -> Vec<u8> {
        postcard::to_allocvec(self).expect("a plain-data Scenario always serializes")
    }

    /// Decode from untrusted `postcard` bytes — REJECT-ONLY (threat T-13-08): returns
    /// the typed [`postcard::Error`] on malformed input and NEVER unwraps/panics,
    /// mirroring the host `load_project` discipline.
    ///
    /// # Errors
    /// [`postcard::Error`] when `bytes` is not a valid `postcard`-encoded `Scenario`.
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, postcard::Error> {
        postcard::from_bytes(bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use fabrico_core::edit::{EditOp, EditRecord};
    use fabrico_core::event::{Event, EventPayload};
    use fabrico_core::ids::{Item, NodeId};

    /// Build a small non-trivial two-log bundle (an edit record + a runtime event) so
    /// the round-trip exercises BOTH nested log types, not just the empty case.
    fn sample() -> Scenario {
        let edit = EditRecord {
            schema_version: fabrico_core::edit::EDIT_SCHEMA_VERSION,
            partition: 0,
            sequence: 0,
            tick: 0,
            action: 0,
            op: EditOp::Place {
                kind: fabrico_protocol::machine_kind::SOURCE,
                cell_x: 1,
                cell_y: 2,
                w: 1,
                h: 1,
                ports: Vec::new(),
                rot: 0,
            },
        };
        let event = Event {
            schema_version: fabrico_core::event::SCHEMA_VERSION,
            partition: 0,
            sequence: 0,
            tick: 0,
            payload: EventPayload::ManualInject {
                target: NodeId::default(),
                port: 0,
                item: Item(vec![7, 8, 9]),
            },
        };
        Scenario::new(0xFAB_C0DE, vec![edit], vec![event])
    }

    #[test]
    fn scenario_round_trips_byte_identical() {
        let s = sample();
        let bytes = s.to_bytes();
        let decoded = Scenario::from_bytes(&bytes).expect("a well-formed bundle decodes");
        assert_eq!(decoded, s, "decode reproduces the Scenario");
        // Byte-identity: re-encoding the decoded value yields the SAME bytes (SAVE-02).
        assert_eq!(
            decoded.to_bytes(),
            bytes,
            "re-encoding is byte-identical (plain ordered serde, no HashMap)"
        );
    }

    #[test]
    fn empty_scenario_round_trips() {
        let s = Scenario::new(42, Vec::new(), Vec::new());
        let bytes = s.to_bytes();
        assert_eq!(Scenario::from_bytes(&bytes).expect("empty bundle decodes"), s);
    }

    #[test]
    fn from_bytes_rejects_garbage_without_panicking() {
        // Arbitrary / truncated bytes decode to a typed Err, NEVER a panic (T-13-08).
        let garbage = [0xFFu8; 3];
        assert!(
            Scenario::from_bytes(&garbage).is_err(),
            "hostile bytes are a typed Err, not a panic"
        );
    }
}
