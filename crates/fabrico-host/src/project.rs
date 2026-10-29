//! The portable project file — a single `postcard` bundle of pure deterministic
//! substrate (SAVE-01/SAVE-02). A factory is shareable as ONE file, decoupled
//! from redb internals, that loads back to an identical running state.
//!
//! # What is in the bundle (and what is NOT)
//! A [`ProjectFile`] carries ONLY the deterministic substrate: the envelope
//! `version`, the `head_tick` it was saved at (a cheap replay-target sanity
//! value), a `snapshot` blob (a tick-boundary [`fabrico_core::snapshot::snapshot`]
//! that internally carries its own `SNAPSHOT_SCHEMA_VERSION` tag), and the full
//! ordered event `log`. The host executor's redb dispatch ledger / in-flight set
//! is deliberately NOT bundled (CONTEXT "Save Scope — Host State Boundary"): a
//! loaded project gets a FRESH empty ledger and reaches at-most-once for free via
//! the reused [`Host::recover`]. Host-side settings live in `HostConfig` (host
//! memory) and never enter the portable file.
//!
//! # Determinism (SAVE-02)
//! Every field is plain ordered serde data — NO `HashMap`/`HashSet` — so the
//! postcard output is byte-deterministic and re-encodes byte-identically
//! (`bundle_round_trips_byte_identical`).
//!
//! # The untrusted-bytes trust boundary (load)
//! A project file is fully untrusted on load. `load_project` (added in plan
//! 06-02 task 2) NEVER panics: a forward `version` is refused with
//! [`ProjectError::UnknownVersion`], garbage bytes with [`ProjectError::Malformed`],
//! and a structurally-valid-but-invariant-violating snapshot is rejected with
//! [`ProjectError::InvalidSnapshot`] (via the HARDENED
//! [`fabrico_core::snapshot::restore`], plan 06-01's `validate_invariants`).

use std::path::Path;

use fabrico_core::core::Core;
use fabrico_core::edit::{
    EDIT_SCHEMA_VERSION, EditOp, EditRecord, MAX_LABEL_BYTES, MAX_ROUTE_EXPECT_BYTES, MAX_ROUTES,
    MachineConfig,
};
use fabrico_core::state::{GRID_MAX, GRID_MIN, MAX_FOOTPRINT_DIM};
use fabrico_core::event::{DecodeError, Event, LogHeader, SCHEMA_VERSION};
use fabrico_core::persist::{MAX_RECORD_BYTES, PersistenceStore, RedbStore, StoreError};

use crate::driver::{Host, RecoverError};
use crate::ingress::seen_set::SeenSet;
use crate::ledger::DispatchLedger;

/// The project-file envelope schema version. Forward-refused on load (mirroring
/// `SNAPSHOT_SCHEMA_VERSION` and `Event::schema_version`). Bump only when the
/// bundle SHAPE changes.
///
/// # v4 (09-04): the SPAT-01 clean break — spatial layout moves into core
/// Bumped from `3` to `4` when the host-side `NodeId → cell` layout sidecar was
/// DELETED: the spatial layout now lives in core [`GridState`](fabrico_core::state::GridState)
/// and rides the embedded Core snapshot, so the `ProjectFile` no longer carries a
/// separate `layout` field. This is a CLEAN BREAK (pre-release, no real saves): the
/// V1/V2 migration shims are dropped and any bundle older than v4 is refused with a
/// typed [`ProjectError::TooOld`] — never migrated, never a panic. An old bundle's
/// embedded snapshot would in any case be refused as
/// [`SnapshotTooOld`](fabrico_core::event::DecodeError::SnapshotTooOld) by
/// [`fabrico_core::snapshot::restore`]; the envelope refusal short-circuits ahead of it.
///
/// # v5 (10-02): the multi-cell footprint clean break — the embedded snapshot tag moved
/// Bumped from `4` to `5` because the embedded Core
/// [`SNAPSHOT_SCHEMA_VERSION`](fabrico_core::snapshot::SNAPSHOT_SCHEMA_VERSION) moved
/// `4 → 5` (the `GridState` `footprints`/`ports` maps joined the wire). The bundle's
/// own SHAPE is otherwise unchanged, but because a v4 bundle embeds a v4 snapshot —
/// which [`fabrico_core::snapshot::restore`] now refuses as
/// [`SnapshotTooOld`](fabrico_core::event::DecodeError::SnapshotTooOld) — the envelope
/// version bumps in lock-step so the refusal is a single, clean, O(1) envelope-level
/// [`ProjectError::TooOld`] rather than a deferred inner snapshot error. CLEAN BREAK
/// (pre-release, no real saves): a bundle older than v5 is refused as `TooOld`, a v6+
/// bundle as `UnknownVersion` — never migrated, never a panic, no shim.
///
/// # v7 (60-02): the belt slot-density clean break, the embedded snapshot tag moved again
/// Bumped from `6` to `7` for EXACTLY the reason the v5 section above records, and it
/// is cited here as the precedent rather than reasoned from scratch. The embedded Core
/// [`SNAPSHOT_SCHEMA_VERSION`](fabrico_core::snapshot::SNAPSHOT_SCHEMA_VERSION) moved
/// `8 -> 9` because a belt's slot vector grew from three entries per tile to four
/// (`60-CONTEXT.md`, 2026-08-09), so every stored belt's serialized shape changed. The
/// bundle's own SHAPE is otherwise unchanged, but a v6 bundle embeds a v8 snapshot,
/// which [`fabrico_core::snapshot::restore`] now refuses as
/// [`SnapshotTooOld`](fabrico_core::event::DecodeError::SnapshotTooOld), so the
/// envelope version bumps in LOCKSTEP and in the same commit.
///
/// This half is load-bearing rather than tidiness. Left at 6, the envelope would admit
/// the bundle and the failure would surface deeper still: past the inner snapshot tag
/// check, at the structural
/// [`StateInvariant::BeltSlotCount`](fabrico_core::event::StateInvariant::BeltSlotCount)
/// trust gate, as `project file snapshot rejected: InvalidState(BeltSlotCount)`. A user
/// would reasonably file that as a corruption bug. A single O(1) envelope-level
/// [`ProjectError::TooOld`] is what D-02's clean break decided on instead. CLEAN BREAK
/// (pre-release, no real saves): never migrated, never a panic, no shim.
///
/// # v8 (62-06): the per-belt advance-interval clean break, the snapshot tag moved again
/// Bumped from `7` to `8` for EXACTLY the reason the v5 and v7 sections above record. The
/// embedded Core [`SNAPSHOT_SCHEMA_VERSION`](fabrico_core::snapshot::SNAPSHOT_SCHEMA_VERSION)
/// moved `9 -> 10` because `Belt` gained a serialized per-belt advance interval
/// (`Belt.ticks_per_slot`, SLOT-03, `62-CONTEXT.md` D-01/D-14, 2026-08-13), so every stored
/// belt's serialized shape changed again. The bundle's own SHAPE is otherwise unchanged, but
/// a v7 bundle embeds a v9 snapshot, which [`fabrico_core::snapshot::restore`] now refuses,
/// so the envelope version bumps in LOCKSTEP and in the same commit.
///
/// The forcing is SHARPER here than at Phase 60, and the difference is worth stating because
/// it is what the message has to be honest about. postcard is not self-describing and the new
/// field is APPENDED, so a v9 body does not reach a structural gate at all: it runs out of
/// bytes and comes back as
/// [`DecodeError::Malformed`](fabrico_core::event::DecodeError::Malformed), the most
/// corruption-shaped error this decoder has, about a file that is byte-for-byte intact. And
/// note WHAT changed, because it bounds what the refusal may say: the SHAPE moved, not the
/// value. The interval ships at its pre-change identity, and a file written from here carries
/// its OWN per-belt intervals, so it replays correctly whatever the construction default later
/// becomes. The refusal therefore names the shape change and carries NO interval value, which
/// keeps it true at every future belt tier.
///
/// # v9 (72-12): the Route-path clean break, the snapshot tag moved again
/// Bumped from `8` to `9` for EXACTLY the reason the v5, v7 and v8 sections above record.
/// The embedded Core
/// [`SNAPSHOT_SCHEMA_VERSION`](fabrico_core::snapshot::SNAPSHOT_SCHEMA_VERSION) moved
/// `10 -> 11` because `Node::Endpoint` stopped being a zero-field marker and gained its
/// Route path `String` (SERVE-08, plan 72-07, `72-CONTEXT.md` D-20), so every stored board
/// holding a Route changed shape. The bundle's own SHAPE is otherwise unchanged, but a v8
/// bundle embeds a v10 snapshot, which [`fabrico_core::snapshot::restore`] now refuses, so
/// the envelope version bumps in LOCKSTEP and in the same commit.
///
/// The forcing has the SAME sharpness Phase 62 recorded, and the same consequence: the new
/// field is APPENDED and postcard is not self-describing, so a v10 body left to reach the
/// decoder runs out of bytes and returns
/// [`DecodeError::Malformed`](fabrico_core::event::DecodeError::Malformed) about a file
/// that is byte-for-byte intact. The envelope refusal is what keeps the answer honest.
///
/// This break earns NO dedicated `ProjectError` variant. A v8 bundle falls through to the
/// generic [`ProjectError::TooOld`], which is the correct outcome and is stated rather than
/// left to be discovered: the dedicated variants exist for breaks whose CAUSE a user could
/// otherwise mistake for corruption of their own board (a re-timed belt, a re-spaced slot
/// vector). A Route gaining a path is not that; the board is unchanged and only its address
/// is newly recorded. The four-way split therefore keeps its shape and its arm count.
///
/// # v12 (85-09): the log-only board, defined once
/// Bumped from `11` to `12` in ONE commit, in its final shape for phase 85 (`85-CONTEXT.md`
/// D-07, DEMO-03). Three things changed, and each would on its own have needed the bump:
///
/// - The `ProjectFile` lost its last field, the record of nodes minted onto a saved board
///   without an edit-log record. Every node on every board this build writes is minted by
///   an edit-log record (the demo's caller and handler are ordinary logged commands since
///   plan 85-08), so the field had nothing left to say. postcard is POSITIONAL and ignores
///   trailing bytes, so dropping the last field changes the bundle SHAPE silently: a v11
///   body read through the v12 shape would decode with its old tail ignored. That is why
///   the field, its type and this number leave in the same commit.
/// - The undo floor rides INSIDE the edit log as the `SealHistory` record (D-10, plan 85-06),
///   so it needs no file field; a v12 file carries it by carrying its log.
/// - The embedded shapes moved with the Email removal (D-08, plan 85-05): a v12 file embeds
///   a SNAPSHOT 13 core and EDIT 12 records, through which an Email sink cannot be written.
///
/// A v11 file joins the generic too-old set below. It earns no dedicated variant, on the
/// v9 precedent recorded above: nothing about a user's board changed meaning, the
/// existing [`ProjectError::TooOld`] sentence already names the file's version and this
/// build's, and a pre-release clean break refuses the file whole rather than migrating it.
/// `a_file_saved_by_the_v11_build_is_refused_naming_11_and_13` holds that against a real
/// v11 file saved by the earlier build.
///
/// # v13 (87-03): phase 87's four core fields, the snapshot tag moved again
/// Bumped from `12` to `13` in LOCKSTEP with the embedded Core
/// [`SNAPSHOT_SCHEMA_VERSION`](fabrico_core::snapshot::SNAPSHOT_SCHEMA_VERSION) `13 -> 14`,
/// for the reason the 74-02 paragraph below records: a `ProjectFile` embeds a snapshot, and
/// an envelope version that did not move with it would accept a bundle whose payload the
/// snapshot decoder then refuses. The snapshot moved because four fields were appended
/// last in their structs (`Balancer::next_in`, `Tee::faults`, `Factory::pending_emits` and
/// `Scheduler::blocked`; phase 87, no permanent jams). The bundle's own SHAPE is unchanged,
/// and [`EDIT_SCHEMA_VERSION`](fabrico_core::edit::EDIT_SCHEMA_VERSION) stays 13.
///
/// A v12 file joins the generic too-old set below and earns no dedicated variant, on the
/// v9 and v11 precedent: nothing about a user's board changed meaning, and the
/// [`ProjectError::TooOld`] sentence already names the file's version and this build's.
/// `a_v12_project_file_is_refused_as_too_old` (in `tests/forged_files.rs`) holds that
/// against a byte copy of a v12 file committed before the bump.
///
/// The refusal is a FOUR-WAY split, stated once here in the order the guard evaluates it:
///
/// | Envelope version | Outcome |
/// |---|---|
/// | `> PROJECT_FILE_VERSION` (v14+) | [`ProjectError::UnknownVersion`] |
/// | `== PROJECT_FILE_VERSION` (v13) | decoded through the current `ProjectFile` shape |
/// | `== PRE_SPEED_CHANGE_PROJECT_VERSION` (v7) | [`ProjectError::BeltSpeedModelChanged`], which NAMES the per-belt advance-interval change |
/// | `== PRE_SLOT_CHANGE_PROJECT_VERSION` (v6) | [`ProjectError::SlotModelChanged`], which NAMES the belt slot change |
/// | anything else older (v12, v11, v10, v9, v8, and v5 and below) | the generic [`ProjectError::TooOld`] |
///
/// A file too short to hold its version varint (an empty file, or one byte that promises
/// more) is [`ProjectError::Malformed`] before any row above is consulted.
///
/// 73-12 (73-REVIEW WR-05): THE TABLE ABOVE WAS NOT REGENERATED ON THE 9 TO 10 BUMP, in the
/// very docblock whose closing paragraph makes regenerating it whole the rule. It said the
/// accepted row was v9, put the forward row one off at `v10+`, and let v9 join the too-old
/// set without appearing in it. The GUARD was always correct; only the description lied,
/// which is worse than an ordinary stale comment here because a reader who trusts this
/// table is a reader deciding what a user's file will do.
///
/// Note the last row, which is the row a bump keeps changing and the reason the table is
/// regenerated whole: the too-old set is not a contiguous "v5 and below". v12, v11, v10, v9
/// and v8 are too old and fall in the generic arm, while v7 and v6 keep their named arms BELOW
/// them. A reader who assumed the generic arm was a floor would get that wrong.
///
/// 74-02 (D-03, LINK-08): the table above is REGENERATED WHOLE for the 10 to 11 bump, on
/// the rule the paragraph below states rather than by patching the three rows that moved.
/// v10 joins the generic too-old set, which is the row that grows every time, and v7 and
/// v6 stay exactly where they are. The bump itself is not a choice this file made: a
/// `ProjectFile` embeds a snapshot, `SNAPSHOT_SCHEMA_VERSION` moved 11 to 12 because a
/// belt now declares two stored ports, and an envelope version that did not move with it
/// would accept a bundle whose payload the snapshot decoder then refuses.
///
/// The two named arms are ordered speed-first inside the too-old branch because v7 is the
/// more recent NAMED boundary and therefore the one a real file is likelier to sit on; the
/// ordering is otherwise immaterial, since the two constants are distinct literals and no
/// version can match both. Both stay HARD LITERALS at 7 and 6 across this bump, exactly as
/// their own docblocks instruct: the facts they encode are historical and permanent.
///
/// Naming each break inside the refusal MESSAGE is the standing rule (plan 60-03 established
/// it for the slot change, 62-06 follows it for the speed change). This description is
/// REWRITTEN on every bump rather than appended to, and that discipline was learned here: it
/// used to open "a bundle older than v7 is refused as `TooOld`, a v8+ bundle as
/// `UnknownVersion`", which was false for v6 and was contradicted two sentences later by its
/// own text. The v5-era precedent sentence had been copied verbatim and then PATCHED rather
/// than rewritten, so a reader who stopped at the first sentence had the wrong model of the
/// gate they were about to touch. That is this repository's recorded instance of the shortcut,
/// and it is why the table above is regenerated whole every time.
pub const PROJECT_FILE_VERSION: u16 = 13;

/// The LAST envelope version that predates the Phase 60 belt slot-spacing change, and
/// therefore the one version whose refusal gets the dedicated, self-documenting
/// [`ProjectError::SlotModelChanged`] instead of the generic [`ProjectError::TooOld`]
/// (60-03, D-02/D-05).
///
/// # Why this is a HARD LITERAL and not `PROJECT_FILE_VERSION - 1`
/// Written as arithmetic it would silently RE-POINT at the next envelope bump, and the
/// message it selects would then tell the owner of a v7 board that their save predates a
/// belt slot-spacing change it does not predate. The fact this constant encodes is
/// historical and permanent: v6 is the last version written with three item slots per
/// belt tile, and that stays true at every future value of [`PROJECT_FILE_VERSION`]. This
/// is the same "never derive an expectation from the thing it checks" discipline the rest
/// of Phase 60 applies to its hand-pinned literals.
///
/// **On the next envelope bump:** leave this alone. A v6 bundle keeps the slot message
/// (still true), and the newly-prior version falls through to the generic `TooOld` unless
/// that break earns a dedicated variant of its own.
///
/// `pub` because the two public items above document themselves in terms of it (a private
/// target there is a `rustdoc::private_intra_doc_links` warning), and because the
/// integration-level decode fuzz needs to address the boundary from outside the crate to
/// tell the two too-old arms apart.
pub const PRE_SLOT_CHANGE_PROJECT_VERSION: u16 = 6;

/// The LAST envelope version that predates the Phase 62 per-belt advance-interval change,
/// and therefore the one version whose refusal gets the dedicated, self-documenting
/// [`ProjectError::BeltSpeedModelChanged`] instead of the generic [`ProjectError::TooOld`]
/// (62-06, D-14).
///
/// # Why this is a HARD LITERAL and not `PROJECT_FILE_VERSION - 1`
/// The argument is the one the constant above makes, and it is copied rather than
/// paraphrased because this constant faces the identical question exactly one version
/// later. Written as arithmetic it would silently RE-POINT at the next envelope bump, and
/// the message it selects would then tell the owner of a v8 board that their save predates
/// a belt advance-interval change it does not predate. The fact this constant encodes is
/// historical and permanent: v7 is the last version written when every belt advanced one
/// slot per tick unconditionally, and that stays true at every future value of
/// [`PROJECT_FILE_VERSION`]. It is the same "never derive an expectation from the thing it
/// checks" discipline (`62-CONTEXT.md` D-22) that the rest of this phase applies to its
/// hand-pinned literals.
///
/// **On the next envelope bump:** leave this alone, and leave
/// [`PRE_SLOT_CHANGE_PROJECT_VERSION`] alone as well. A v7 bundle keeps the speed message
/// and a v6 bundle keeps the slot message, both still true; the newly-prior version falls
/// through to the generic `TooOld` unless that break earns a dedicated variant of its own.
/// Phase 62 earned one. Not every break will.
///
/// `pub` for the reasons the sibling constant gives: the public items above document
/// themselves in terms of it, and the integration-level decode fuzz addresses the boundary
/// from outside the crate to tell the three too-old arms apart.
pub const PRE_SPEED_CHANGE_PROJECT_VERSION: u16 = 7;

/// The maximum on-disk size of a project file accepted by [`load_project`].
///
/// The load path decodes a FULLY UNTRUSTED `.fab` file; without a ceiling a
/// hostile/oversized bundle exhausts memory (`std::fs::read` allocates the whole
/// file) BEFORE the layered per-record [`MAX_RECORD_BYTES`] defenses engage
/// (WR-01). The ceiling mirrors that persistence-layer bound: a project file is
/// one snapshot blob (<= `MAX_RECORD_BYTES`) plus its event log, so four records'
/// worth (256 MiB) is a generous-but-bounded envelope. `saturating_mul` keeps the
/// arithmetic panic-free on any platform.
pub const MAX_PROJECT_BYTES: u64 = (MAX_RECORD_BYTES as u64).saturating_mul(4);

/// The maximum number of ticks [`load_project`] will replay forward on load — the
/// span between the bundled base snapshot's tick and the bundle's `head_tick`.
///
/// `recover()` replays the log by looping `while core.tick <= max_event_tick`,
/// stepping ONE idle tick per iteration (`core.tick += 1`). Both `base_tick` (the
/// snapshot's `Core.tick`) and every `Event.tick` are attacker-controlled `u64`s
/// in a fully untrusted `.fab` file, so without a ceiling a hostile bundle with a
/// gigantic `head_tick`/event tick (e.g. `2^40`) drives that loop ~a trillion
/// times — a non-terminating DoS hang that the existing post-replay `head_tick`
/// consistency check (which runs AFTER `recover()`) is powerless to prevent
/// (T-06-LOAD-DOS).
///
/// The ceiling is `10_000_000` ticks. At the 60 ticks/s target that is ~46 hours
/// of continuous simulated time — orders of magnitude beyond any sane snapshot
/// cadence (the default is 600 ticks ≈ 10 s; even a deliberately sparse 1 000 000
/// -tick cadence stays 10× under), so a legitimately-saved project always loads.
/// Yet it is finite, so a hostile file declaring a multi-year tick gap is refused
/// in O(1) — BEFORE any replay loop runs — with [`ProjectError::ReplaySpanTooLong`].
/// Replaying up to this many idle ticks is bounded, sub-second-to-seconds work,
/// never an unbounded loop.
pub const MAX_REPLAY_SPAN: u64 = 10_000_000;

/// A portable factory save: pure deterministic substrate (snapshot + log), no
/// host executor state. Plain ordered serde data (NO `HashMap`/`HashSet`) so the
/// postcard encoding is deterministic and re-encodes byte-identically (SAVE-02).
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct ProjectFile {
    /// Envelope schema version (forward-version refusal on load).
    pub version: u16,
    /// The tick the running factory was at when saved — the replay target and a
    /// cheap post-load sanity value (`host.core().tick == head_tick`).
    pub head_tick: u64,
    /// A tick-boundary snapshot blob at `base_tick <= head_tick`. It carries its
    /// own little-endian `SNAPSHOT_SCHEMA_VERSION` prefix internally, so the
    /// hardened [`fabrico_core::snapshot::restore`] decode applies on load.
    pub snapshot: Vec<u8>,
    /// The full ordered event log (`Vec<Event>`) in fold order — plain data.
    pub log: Vec<Event>,
    /// **v3 (08-05):** the topology edit-log (`Vec<EditRecord>`, ELOG-01) — the
    /// SECOND ordered log, bundled alongside the runtime event `log`. Appended LAST
    /// as an additive serde field (which shifts the bundle SHAPE — postcard reads it
    /// as a trailing `Vec`), exactly why [`PROJECT_FILE_VERSION`] bumped to `3`. On
    /// load it is validated reject-only per record (exact-match version since the v8.0
    /// clean break, monotonic key), hydrated into the fresh store's EDITS table, and replayed forward
    /// edits-first by [`Host::recover`] alongside the event log. A v2 bundle (no
    /// edit_log) migrates to an empty edit-log.
    pub edit_log: Vec<EditRecord>,
}

/// A typed, non-panicking failure from the project save/load path.
///
/// Every untrusted-byte decode on load maps to one of these via `?`, so a
/// malformed / forward-versioned / hostile project file is ALWAYS a returned
/// error, never a panic (threat T-06-02-PANIC). Mirrors the `StoreError` /
/// `ledger.rs` error style.
#[derive(Debug)]
pub enum ProjectError {
    /// Reading or writing the project file on disk failed.
    Io(std::io::Error),
    /// Hydrating / reading the fresh redb store or ledger failed.
    Store(StoreError),
    /// The bytes did not postcard-decode into a [`ProjectFile`] (layer-1 decode).
    Malformed,
    /// The bundle `version` is newer than this code can read — forward-version
    /// refusal (the outermost of the three-layer version refusal).
    UnknownVersion(u16),
    /// The bundle `version` is OLDER than this code reads — the SPAT-01 clean break
    /// (09-04) dropped the pre-v4 migration shims, so a v1/v2/v3 bundle is refused
    /// with this typed too-old error rather than migrated (CONTEXT Q3 clean break,
    /// symmetric with the snapshot's [`SnapshotTooOld`](fabrico_core::event::DecodeError::SnapshotTooOld)).
    /// Never a panic. Carries the found and minimum-readable versions.
    TooOld { found: u16, expected: u16 },
    /// The bundled snapshot failed the HARDENED core decode — a forward snapshot
    /// tag, malformed snapshot body, or a structurally-valid-but-invariant
    /// -violating `Core` (plan 06-01's `validate_invariants`). Carried as the
    /// typed [`DecodeError`], never a panic.
    InvalidSnapshot(DecodeError),
    /// The project file on disk exceeds the [`MAX_PROJECT_BYTES`] ceiling. Refused
    /// AFTER a cheap metadata stat but BEFORE the whole file is read into memory —
    /// the memory-exhaustion-DoS guard on the untrusted load path (WR-01), mirroring
    /// the persistence layer's per-record [`MAX_RECORD_BYTES`] bound.
    TooLarge { size: u64, limit: u64 },
    /// [`save_project`] was called while commands are still in-flight (a
    /// non-quiescent save). The bundle would carry a log with an unresolved command
    /// that reloads as a spurious Timeout/fault — a silent semantic loss. Refused
    /// loudly so the caller ticks to quiescence first (WR-02). Carries the in-flight
    /// count.
    NotQuiescent(usize),
    /// The bundled `head_tick` disagrees with the tick the restored snapshot + log
    /// actually replays to — a tampered / inconsistent bundle. The documented
    /// post-load sanity invariant (`host.core().tick == head_tick`) is now ENFORCED
    /// on load (IN-01).
    HeadTickMismatch { expected: u64, actual: u64 },
    /// A bundled log event is unreadable: its `schema_version` is newer than this
    /// build can decode. Validated UP FRONT (mirroring `Host::logged_events`) before
    /// the fresh store is hydrated, so a forward-versioned bundled log is a precise
    /// typed error rather than a generic deep `Store` failure (IN-02a).
    UnreadableLogEvent(u16),
    /// The bundled log is not in strictly-increasing `(partition, sequence)` order —
    /// a duplicate or out-of-order key that would silently COLLAPSE log entries when
    /// re-appended by key (`append_event` has no monotonicity check). Rejected up
    /// front before the fresh store is hydrated (IN-02b).
    NonMonotonicLog { partition: u64, sequence: u64 },
    /// A bundled EDIT record is unreadable: its `schema_version` is not EXACTLY the
    /// version this build reads, newer OR older (the edit-log mirror of
    /// [`UnreadableLogEvent`](Self::UnreadableLogEvent), which is still forward-only
    /// because the EVENT log took no clean break). Validated UP FRONT (mirroring
    /// `Host::logged_edits`; both call `fabrico_core::edit::check_version`) before the
    /// fresh store is hydrated, so a wrong-versioned bundled edit-log is a precise typed
    /// error (ELOG-05, threat T-8-LOAD-EDIT-VER). Carries the offending schema version.
    ///
    /// Since the v8.0 clean break (Phase 63) this is the variant a pre-v8.0 `.fab` file
    /// comes back as. That is a deliberate trade the maintainer accepted on 2026-08-18, not a
    /// regression.
    UnreadableEditRecord(u16),
    /// The bundled EDIT log is not in strictly-increasing `(partition, sequence)`
    /// order — a duplicate/out-of-order key that would silently COLLAPSE entries
    /// when re-appended by key (`append_edit` has no monotonicity check). Rejected
    /// up front before the fresh store is hydrated (ELOG-05, threat
    /// T-8-LOAD-EDIT-COLLAPSE).
    NonMonotonicEditLog { partition: u64, sequence: u64 },
    /// A bundled `Event.tick` is so large that the replay target
    /// (`max_event_tick.checked_add(1)`) overflows `u64`. `recover()` would drive
    /// `run_log`'s `while core.tick <= max_event_tick` loop into `core.tick += 1`
    /// AT `u64::MAX` and PANIC with "attempt to add with overflow" (Mode A of
    /// T-06-LOAD-DOS). The attacker fully controls `Event.tick`, so this
    /// CHECKED-arithmetic guard rejects it up front as a typed error — never a
    /// panic. Carries the offending max event tick.
    TickOverflow { max_event_tick: u64 },
    /// The bundle would replay more than [`MAX_REPLAY_SPAN`] ticks forward from its
    /// base snapshot — a hostile `head_tick`/`Event.tick` gap (e.g. `2^40`) that
    /// drives `recover()`'s idle-tick replay loop ~a trillion times into an
    /// effectively non-terminating HANG (Mode B of T-06-LOAD-DOS, a DoS that bites
    /// even in release where the Mode A overflow does not). Bounded with SATURATING
    /// arithmetic and refused BEFORE `recover()` runs, so a hostile file is a typed
    /// error returned in O(1), never a hang. Carries the requested span and limit.
    ReplaySpanTooLong { span: u64, limit: u64 },
    /// A bundled `EditOp::Place` carries footprint dims outside the verified
    /// `1..=MAX_FOOTPRINT_DIM` envelope (CR-01, threat T-06-01-DOS). `recover()`
    /// replays the edit log VERBATIM through `fold_place`/`claim_footprint` (decision
    /// Q2 — no fold-time re-validation), so a forged `w = h = u16::MAX` Place would
    /// expand to ~4.3 billion `occupancy` cells — a tiny-input/multi-GiB-allocation
    /// amplification bomb. Rejected UP FRONT — mirroring the snapshot gate's
    /// [`FootprintTooLarge`](fabrico_core::event::StateInvariant::FootprintTooLarge)
    /// and `edit::upcast`'s `Malformed` guard — BEFORE the fresh store is hydrated or
    /// any edit is folded, so a hostile two-log `.fab` is a typed error, never an OOM.
    /// Carries the offending dims.
    EditFootprintOutOfRange { w: u16, h: u16 },
    /// A bundled `EditOp::Place` carries a footprint anchor (`cell_x`/`cell_y`) outside
    /// the `[GRID_MIN, GRID_MAX]` grid extent (WR-01). The snapshot decode gate
    /// (`validate_footprint_bounds`) bounds every decoded anchor, but the edit-log
    /// replay path applied `Place` anchors VERBATIM through `fold_place`/`claim_footprint`
    /// (decision Q2 — no fold-time re-validation). The CR-02 `i64` arithmetic prevents a
    /// panic/OOM (off-`i32` cells are dropped), but an out-of-extent anchor still builds a
    /// `Core` the snapshot gate would reject (`CellOutOfBounds`/`CellCollision`) — an
    /// internally-inconsistent state that cannot round-trip. Mirroring the snapshot
    /// anchor bound on the edit-log path closes the asymmetry. Carries the offending
    /// anchor.
    EditAnchorOutOfBounds { cell_x: i32, cell_y: i32 },
    /// A bundled `EditOp::Place` carries a `ports[i].local_offset` outside its node's
    /// `[0,w)×[0,h)` rot-0 footprint box (WR-02). The snapshot trust gate rejects an
    /// out-of-footprint port (`PortOutOfFootprint`), but the edit-log replay path applied
    /// a `Place`'s ports VERBATIM via `set_ports` with no equivalent check, letting a
    /// forged/tampered `.fab` install ports that the gate would reject on the next
    /// restore — the same snapshot-vs-edit-log asymmetry as
    /// [`EditAnchorOutOfBounds`](Self::EditAnchorOutOfBounds). Carries the offending
    /// local offset and the footprint dims it violated.
    EditPortOutOfFootprint {
        local_offset: (i32, i32),
        w: u16,
        h: u16,
    },
    /// A bundled `EditOp::Configure{Router}` carries more than
    /// [`MAX_ROUTES`](fabrico_core::edit::MAX_ROUTES) routes (63-04, threat T-63-01).
    /// The route table is the second unbounded allocation surface in the serialized
    /// model after the Factory JS source, and `recover()` replays the edit log VERBATIM
    /// through `fold_configure` (decision Q2 — no fold-time re-validation), so a forged
    /// table of millions of rules becomes a live `Router` that the per-item first-match
    /// walk then traverses. Rejected UP FRONT, the load-path twin of `edit::upcast`'s
    /// `Malformed` guard, reading the SAME constant. Carries the offending count and the
    /// cap so the message is actionable.
    EditRouteTableTooLong { routes: usize, cap: usize },
    /// A bundled `EditOp::Configure{Router}` carries a single `RouteKey.expect` pattern
    /// longer than [`MAX_ROUTE_EXPECT_BYTES`](fabrico_core::edit::MAX_ROUTE_EXPECT_BYTES)
    /// (63-04, threat T-63-01). The second dimension of the same bomb: `routes` is a Vec
    /// of Vecs, so bounding only the outer length would leave one enormous pattern
    /// unbounded. Carries the offending length and the cap.
    EditRoutePatternTooLong { len: usize, cap: usize },
    /// The bundle is at exactly [`PRE_SLOT_CHANGE_PROJECT_VERSION`], so it was written
    /// before the Phase 60 belt slot-spacing change (SLOT-02, `60-CONTEXT.md` D-02,
    /// 2026-08-09). A specialisation of [`TooOld`](Self::TooOld): same O(1) envelope
    /// guard, same reject-only clean break, but a message that NAMES the cause instead of
    /// leaving the user to guess.
    ///
    /// Why it exists at all: without it the honest-refusal chain ends in a message that
    /// reads like data loss. Left un-named, a v6 board surfaces either as a bare "too old"
    /// or (with no envelope bump at all) as
    /// `project file snapshot rejected: InvalidState(BeltSlotCount)`, which any reasonable
    /// person files as a corruption bug against a save that is in fact intact. D-02 decided
    /// the refusal must say what actually happened.
    ///
    /// Why it is scoped to ONE version: the generic `TooOld` will outlive this phase, so
    /// welding a slot-specific reason onto it would leave every future break explaining
    /// itself with the wrong cause. A dedicated variant keyed to a fixed historical version
    /// makes the one-time break self-documenting and leaves `TooOld` generic.
    ///
    /// # Append-last, and which enums that discipline actually binds
    /// Appended LAST so no existing discriminant shifts. That rule is load-bearing for
    /// [`StateInvariant`](fabrico_core::event::StateInvariant) and
    /// [`DecodeError`](fabrico_core::event::DecodeError), which derive `Clone, Copy` and are
    /// reachable from decoded wire data, so a shifted discriminant there is a correctness
    /// hazard. `ProjectError` derives only `Debug`, is a RETURN type and never crosses the
    /// wire, so nothing strictly binds it here. It follows the house style anyway because
    /// matching the neighbouring convention costs nothing and a future reader should not
    /// have to work out which of the three enums the rule was really about. Recorded so
    /// they do not have to.
    ///
    /// Carries the found version. The readable version is [`PROJECT_FILE_VERSION`].
    SlotModelChanged { found: u16 },
    /// The bundle is at exactly [`PRE_SPEED_CHANGE_PROJECT_VERSION`], so it was written
    /// before the Phase 62 per-belt advance-interval change (SLOT-03/SLOT-04,
    /// `62-CONTEXT.md` D-01/D-14, 2026-08-13). A specialisation of [`TooOld`](Self::TooOld)
    /// on the model of [`SlotModelChanged`](Self::SlotModelChanged): same O(1) envelope
    /// guard, same reject-only clean break, but a message that NAMES the cause instead of
    /// leaving the user to guess.
    ///
    /// Why it exists at all: without it the honest-refusal chain ends in a message that
    /// reads like data loss, and here it reads WORSE than it did at Phase 60. `Belt` gained
    /// an APPENDED serialized field, so with no envelope bump a v7 board does not even reach
    /// a structural invariant: postcard runs out of bytes and the user is shown
    /// `project file snapshot rejected: Malformed` about a file that is byte-for-byte
    /// intact. Left merely un-named it surfaces as a bare "too old". D-14 decided the
    /// refusal must say what actually happened.
    ///
    /// Why it is scoped to ONE version: the generic `TooOld` will outlive this phase, so
    /// welding a speed-specific reason onto it would leave every future break explaining
    /// itself with the wrong cause. A dedicated variant keyed to a fixed historical version
    /// makes the one-time break self-documenting and leaves `TooOld` generic. The same
    /// scoping is what lets `SlotModelChanged` stay exactly as it was: a v6 bundle still
    /// gets the slot message, and that message is still true.
    ///
    /// # Append-last, and which enums that discipline actually binds
    /// Appended LAST so no existing discriminant shifts. The variant above already worked
    /// out which enums that rule really binds and recorded the answer, so it is reused here
    /// rather than re-derived: `ProjectError` derives only `Debug`, is a RETURN type and
    /// never crosses the wire, so nothing STRICTLY binds the discipline here. It follows
    /// the house style anyway because matching the neighbouring convention costs nothing.
    ///
    /// # D-15: this refusal reaches no user in the shipped binary TODAY
    /// Recorded in place so nobody rediscovers it. `SimLoop::load_swap` renders a
    /// `ProjectError` into a standard-error print and nothing reaches the webview, so the
    /// message written below is, today, seen only by someone running the binary from a
    /// terminal. That is a real gap (D-60-2, carried forward as `62-CONTEXT.md` D-15), it is
    /// recorded as deferred, and it is explicitly NOT Phase 62's to fix. It does not weaken
    /// the case for the variant: the refusal itself is what protects the bytes, and the
    /// message is what will be correct on the day the gap is closed.
    ///
    /// Carries the found version. The readable version is [`PROJECT_FILE_VERSION`].
    BeltSpeedModelChanged { found: u16 },
    /// A bundled `AddPort { seat: Captured }` carries a slot outside
    /// `[0, MAX_FOOTPRINT_DIM)`, or a bundled `RemovePort.restore` box lies outside its
    /// envelope (plan 74.1-23, review WR-02 of round 3). Judged by
    /// [`fabrico_core::edit::port_edit_in_envelope`], the ONE predicate `upcast` and
    /// `Host::logged_edits` also call. `recover()` replays the edit log VERBATIM (decision
    /// Q2), so a forged captured seat would put a port outside every box the snapshot
    /// gate accepts and leave a session whose next save will not load. Refused UP FRONT,
    /// before the fresh store is hydrated. Carries the record's sequence.
    ///
    /// Appended last when it was added, following the append-last house style (see
    /// [`SlotModelChanged`](Self::SlotModelChanged) for why nothing strictly binds it here).
    EditPortEditOutOfEnvelope { sequence: u64 },
    /// The bundled edit log replays to a core the snapshot trust gate refuses (plan
    /// 74.1-23, the round-4 checker): the REPLAY-TIME TWIN of
    /// [`EditPortOutOfFootprint`](Self::EditPortOutOfFootprint).
    ///
    /// # Why it exists
    /// Every per-record check in `load_project` judges one record without the board's
    /// state, so a record can pass all of them and still replay into a state the gate
    /// refuses: a forged `RemovePort{restore: Some}` whose box is inside the envelope but
    /// too small for the ports that survive leaves a surviving port outside it. Before
    /// this variant that core was installed unchecked, so the session ran on a state the
    /// NEXT load refuses (`PortOutOfFootprint`), the asymmetry `EditPortOutOfFootprint`
    /// already names as a defect for `Place`. The replay is where the state exists, so
    /// `Host::recover_gated` runs the gate's own `restore` on the replayed core before
    /// anything is installed and this carries its refusal.
    ///
    /// The `DecodeError` is carried for a developer (the load-refusal path prints `{e:?}`
    /// to standard error); the `Display` copy never names it, for the reason the
    /// [`InvalidSnapshot`](Self::InvalidSnapshot) arm records.
    ///
    /// Appended LAST, the append-last house style its neighbours follow.
    EditReplayStateInvalid(DecodeError),
    /// A bundled `EditOp::Configure{Label}` carries a `text` longer than
    /// [`MAX_LABEL_BYTES`](fabrico_core::edit::MAX_LABEL_BYTES) (Phase 76, plan 76-04,
    /// SHAPE-13, D-06, threat T-76-12). The label's words are the first user-authored
    /// string in the edit log since a Route's path, and `recover()` replays the log
    /// VERBATIM through `fold_configure` (decision Q2), so a forged multi-megabyte text
    /// would be allocated and carried into every later snapshot. Refused UP FRONT, the
    /// load-path twin of `edit::upcast`'s `Malformed` guard and of `snapshot::restore`'s
    /// `LabelTextTooLong`, reading the SAME constant the write gate reads. Carries the
    /// offending length and the cap. Appended LAST.
    EditLabelTextTooLong { len: usize, cap: usize },
    /// A bundled `EditOp::Configure{Label}` carries a width or depth outside
    /// `1..=MAX_FOOTPRINT_DIM` (Phase 76, plan 76-04, threat T-76-13). The fold clamps a
    /// label's box into that envelope, so this is not an allocation bomb; it is a record
    /// no build ever writes, named rather than silently clamped. The label panel's 16 by 8
    /// caps are NOT checked here: they are a write-side policy, and enforcing them on load
    /// would let a later cap change make a saved board unloadable (the `PaceOutOfRange`
    /// lesson). Carries the offending size and the envelope cap. Appended LAST.
    EditLabelSizeOutOfRange { w: u16, h: u16, cap: u16 },
    /// The bundled edit log's undo history reaches BELOW its own undo floor (plan 85-06,
    /// D-10, DEMO-05, threat T-85-14). A seeded scene ends with an `EditOp::SealHistory`
    /// record, and everything under it is the scene's own commands, which Undo refuses
    /// to touch. A log this build writes therefore never holds an Undo marker naming an
    /// action under the floor, nor a cursor below it; a file that does was edited by hand
    /// or damaged, and opening it would install a board whose scene was taken apart behind
    /// the floor while the toolbar claimed there was nothing to undo.
    ///
    /// Judged after the replay (`GridSession::undo_floor_breached`), because the floor and
    /// the cursor exist only in the rebuilt projection. Carries both numbers so the
    /// sentence can name them. Appended LAST, the append-last house style.
    UndoFloorBreached { floor: u64, cursor: u64 },
    /// A bundled `EditOp::Place`, or the capture of a bundled `EditOp::Delete`, names a
    /// rotation above 3 (plan 86-02, EDIT 13, threat T-86-05). A rotation is a count of
    /// quarter-turns, `0..=3`; no build writes another, and a footprint holding one is a
    /// state the snapshot gate refuses as `FootprintBadRot`. Refused before the replay, so
    /// a forged turn never reaches `fold_place`. Carries the offending value. Appended
    /// LAST.
    EditRotationOutOfRange { rot: u8 },
    /// The file joins a label to something (plan 86-07, D-08, WORK-09, threats T-86-18 to
    /// T-86-20): its edit log gives a label a port, docks a belt to one (on any port, the
    /// fault port included) or draws a cable to or from one, or its snapshot holds a label
    /// with a port or a link. A label is a note and never connects; every such gesture is
    /// refused as `LabelDoesNotConnect`, so only a hand-edited or damaged file holds one.
    ///
    /// Judged after the replay from `GridSession::label_connect_forged` (the re-fold from
    /// genesis is the one walk that sees every bundled record), and from the snapshot
    /// gate's `StateInvariant::LabelConnected` on the base snapshot or the replayed core.
    /// Also judged per record before the replay (phase 86 security audit, T-86-27): a
    /// `Place` of kind LABEL carrying ports, or a `Delete` of kind LABEL whose capture
    /// carries ports, whose Ctrl+Z would put a label with a port back on the board.
    /// Refused rather than opened with the record dropped (D-08). Payload-free. Appended
    /// LAST.
    LabelConnected,
}

impl std::fmt::Display for ProjectError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ProjectError::Io(e) => write!(f, "project file io error: {e}."),
            ProjectError::Store(e) => write!(f, "project store error: {e}."),
            ProjectError::Malformed => {
                write!(f, "malformed project file (postcard decode failed).")
            }
            ProjectError::UnknownVersion(v) => write!(
                f,
                "unreadable project file version {v} (this build reads <= {PROJECT_FILE_VERSION})."
            ),
            ProjectError::TooOld { found, expected } => write!(
                f,
                "project file version {found} is too old: this build reads only v{expected}, \
                 and pre-v{expected} bundles are no longer migrated. That is a deliberate \
                 clean break."
            ),
            // NO `{e:?}`, AND THAT WAS A REAL DEFECT rather than a style point. This arm
            // rendered its inner `DecodeError` with `Debug`, so a user whose board hit a
            // structural invariant was shown, verbatim,
            // `project file snapshot rejected: InvalidState(BeltSlotCount)` about a file
            // that is byte-for-byte intact. `SlotModelChanged`'s docblock below already
            // names that exact string as the message "any reasonable person files as a
            // corruption bug against a save that is in fact intact". Plan 73-04 puts
            // these sentences on screen, so the debug payload had to go.
            //
            // WHY A BOUNDED SUMMARY HERE AND NOT `Display` ON `DecodeError`. Measured on
            // 2026-09-05: `fabrico_core::event::DecodeError` implements no `Display`, and
            // neither does the `StateInvariant` its `InvalidState` arm carries. Giving it
            // one means authoring 25 new user-facing sentences (4 + 21) inside
            // `fabrico-core`, a crate no copy gate covers and which this plan's
            // `files_modified` does not name. The summary below keeps the authored copy in
            // the one place every other `ProjectError` sentence lives, under the gate this
            // plan builds. The Debug detail is NOT lost: `sim_loop.rs`'s `eprintln!` on the
            // refusal path prints `{e:?}` alongside the `Display`, which is where a
            // developer wants it and a user does not.
            //
            // The match is EXHAUSTIVE, so a new `DecodeError` variant is a compile error
            // here rather than a silent fallback into vaguer copy.
            ProjectError::InvalidSnapshot(e) => match e {
                DecodeError::UnknownVersion(v) => write!(
                    f,
                    "project file snapshot rejected: it is written in snapshot format \
                     v{v}, which is newer than this build reads."
                ),
                DecodeError::Malformed => write!(
                    f,
                    "project file snapshot rejected: the snapshot bytes did not decode."
                ),
                // The invariant's IDENTITY is deliberately not named. It is an internal
                // enum variant, it means nothing to the person reading this, and printing
                // it is what made the old copy read like a corruption report.
                DecodeError::InvalidState(_) => write!(
                    f,
                    "project file snapshot rejected: the snapshot decoded, but it breaks \
                     a grid rule this build enforces."
                ),
                DecodeError::SnapshotTooOld(v) => write!(
                    f,
                    "project file snapshot rejected: it is written in snapshot format \
                     v{v}, which is older than this build reads."
                ),
            },
            ProjectError::TooLarge { size, limit } => write!(
                f,
                "project file too large ({size} bytes exceeds the {limit}-byte ceiling)."
            ),
            ProjectError::NotQuiescent(n) => write!(
                f,
                "refusing to save a non-quiescent factory ({n} command(s) in-flight): \
                 tick to quiescence before saving."
            ),
            ProjectError::HeadTickMismatch { expected, actual } => write!(
                f,
                "project file head_tick {expected} disagrees with the replayed tick {actual} \
                 (inconsistent/tampered bundle)."
            ),
            ProjectError::UnreadableLogEvent(v) => write!(
                f,
                "bundled log event schema_version {v} exceeds readable {SCHEMA_VERSION}."
            ),
            ProjectError::NonMonotonicLog {
                partition,
                sequence,
            } => write!(
                f,
                "bundled log is not strictly increasing at (partition {partition}, \
                 sequence {sequence}): a duplicate or out-of-order key."
            ),
            ProjectError::UnreadableEditRecord(v) => write!(
                f,
                "bundled edit record schema_version {v} is not the version this build \
                 reads ({EDIT_SCHEMA_VERSION})."
            ),
            ProjectError::NonMonotonicEditLog {
                partition,
                sequence,
            } => write!(
                f,
                "bundled edit-log is not strictly increasing at (partition {partition}, \
                 sequence {sequence}): a duplicate or out-of-order key."
            ),
            ProjectError::TickOverflow { max_event_tick } => write!(
                f,
                "bundled log max event tick {max_event_tick} + 1 overflows u64 \
                 (hostile/tampered tick field)."
            ),
            ProjectError::ReplaySpanTooLong { span, limit } => write!(
                f,
                "project file would replay {span} ticks forward, above the {limit}-tick \
                 ceiling, so it is refused as a load-time replay DoS."
            ),
            ProjectError::EditFootprintOutOfRange { w, h } => write!(
                f,
                "bundled Place footprint {w}x{h} is outside the 1..={MAX_FOOTPRINT_DIM} \
                 dimension envelope (hostile/tampered edit record), so it is refused as a \
                 load-time occupancy-allocation DoS."
            ),
            ProjectError::EditAnchorOutOfBounds { cell_x, cell_y } => write!(
                f,
                "bundled Place anchor ({cell_x}, {cell_y}) is outside the \
                 [{GRID_MIN}, {GRID_MAX}] grid extent (hostile/tampered edit record), so it \
                 is refused as an internally-inconsistent (non-round-tripping) state."
            ),
            ProjectError::EditPortOutOfFootprint {
                local_offset: (x, y),
                w,
                h,
            } => write!(
                f,
                "bundled Place port local_offset ({x}, {y}) lies outside its \
                 [0,{w})x[0,{h}) footprint box (hostile/tampered edit record), so it is \
                 refused as a state the snapshot gate would reject as PortOutOfFootprint."
            ),
            ProjectError::EditRouteTableTooLong { routes, cap } => write!(
                f,
                "bundled Configure carries a {routes}-route routing table, above the \
                 {cap}-route cap (hostile/tampered edit record), so it is refused as a \
                 load-time route-table allocation DoS."
            ),
            ProjectError::EditRoutePatternTooLong { len, cap } => write!(
                f,
                "bundled Configure carries a {len}-byte route match pattern, above the \
                 {cap}-byte cap (hostile/tampered edit record), so it is refused as a \
                 load-time route-table allocation DoS."
            ),
            // Written for a person looking at a card, not for a log line. Three facts,
            // in this order: what the file claims, what this build will do, and that the
            // consequence of accepting it would be real work rather than a rule being
            // enforced for its own sake. No em dash, no en dash, a terminal period, no
            // debug payload and no path - the four properties `project_error_copy.rs`
            // asserts over every arm, and this arm was written knowing it is enumerated
            // through a compiler-checked exhaustive match rather than a hand-picked list.
            ProjectError::EditPortEditOutOfEnvelope { sequence } => write!(
                f,
                "bundled port edit at sequence {sequence} seats a port, or restores a box, \
                 outside the range this build accepts (hostile/tampered edit record), so it \
                 is refused as a state the snapshot gate would reject."
            ),
            // Plain user copy in the house voice. The invariant's identity is never
            // named, for the reason the `InvalidSnapshot` arm records.
            ProjectError::EditReplayStateInvalid(_) => write!(
                f,
                "the edit history in this factory file replays to a board that breaks a \
                 grid rule this build enforces, so it is refused. A save this build writes \
                 never does that."
            ),
            // Plan 76-04: the two label load refusals, plain user copy in the house voice.
            // No number, no path, no debug payload, a terminal period: a person reading
            // the card needs to know the file holds something this build will not load,
            // not the byte count of a forged field.
            ProjectError::EditLabelTextTooLong { .. } => write!(
                f,
                "This file holds a label whose text is longer than this build allows."
            ),
            ProjectError::EditLabelSizeOutOfRange { .. } => write!(
                f,
                "This file holds a label whose size is outside what this build allows."
            ),
            // Plan 85-06 (T-85-14): plain user copy naming both numbers, no em dash, a
            // terminal period; gated with every other arm in `project_error_copy.rs`.
            ProjectError::UndoFloorBreached { floor, cursor } => write!(
                f,
                "this project file's undo history reaches below the loaded scene's own \
                 actions (it marks {floor} as the scene's, and {cursor} are live), so it was \
                 edited by hand or damaged and is not opened."
            ),
            // Plan 86-02 (T-86-05): plain user copy in the house voice, no number, no em
            // dash, a terminal period; gated with every other arm in `project_error_copy.rs`.
            ProjectError::EditRotationOutOfRange { .. } => write!(
                f,
                "This file holds a machine turned a way the app cannot turn it, so it was not \
                 opened."
            ),
            // Plan 86-07 (D-08): one sentence true of all five forged shapes and of a forged
            // snapshot. "Label" is the palette's and the panel's word. No number, no path, no
            // dash, a terminal period; gated in `project_error_copy.rs`.
            ProjectError::LabelConnected => write!(
                f,
                "This file gives a label a port or joins it to a belt or cable. \
                 Labels do not connect, so the file was not opened."
            ),
            // Four facts, in this order, and nothing decorative. (1) the found version and
            // the version this build reads; (2) the named cause, with its requirement id
            // and phase so it is traceable back to 60-CONTEXT.md; (3) that this is NOT
            // corruption, in plain words, which is the entire reason this variant exists;
            // (4) why no migration exists, on correctness grounds rather than effort.
            // The 3 and the 4 are deliberate LITERALS, not `SLOTS_PER_TILE`: they state a
            // fixed historical fact about the v6/v7 boundary, and read from the live
            // constant they would silently restate themselves at every future value.
            ProjectError::SlotModelChanged { found } => write!(
                f,
                "this factory (save format v{found}) predates a deliberate change to belt \
                 item spacing and cannot be opened by this build, which reads v{PROJECT_FILE_VERSION}. \
                 Your file is NOT corrupt: Phase 60 (SLOT-02) changed a belt from 3 item slots \
                 per tile to 4 so that items sit on an exact 8 px pitch, which changed the \
                 shape every saved belt is written in. There is deliberately no migration, \
                 because padding each tile from 3 slots to 4 would move every item already \
                 riding a belt to a different position, so the board would silently resume in \
                 a state you never saved. Refusing is the honest outcome."
            ),
            // The same four facts, in the same order, on the same template. (1) the found
            // version and the version this build reads; (2) the named cause, with its
            // requirement id and phase so it is traceable back to 62-CONTEXT.md; (3) that
            // this is NOT corruption, in plain words, which is the entire reason this
            // variant exists; (4) why no migration exists, on correctness grounds rather
            // than effort.
            //
            // Two things this message deliberately does NOT do. It does not state the
            // cause as a VALUE, because the value did not change here: the SHAPE did. A
            // belt used to be a thing that always stepped one slot every tick; it is now a
            // thing that carries its own advance interval, and a file written from v8
            // onward carries its own intervals and replays correctly whatever the shipped
            // construction default later becomes. And it carries NO interval number at all,
            // which follows from that: a number here would have to restate itself at every
            // future belt tier, and D-19 reserves the shipped value for the owner in any
            // case. The message must stay true at every future value.
            ProjectError::BeltSpeedModelChanged { found } => write!(
                f,
                "this factory (save format v{found}) predates a deliberate change to how \
                 belts carry their speed and cannot be opened by this build, which reads \
                 v{PROJECT_FILE_VERSION}. Your file is NOT corrupt: Phase 62 (SLOT-03, \
                 SLOT-04) changed what a belt IS, not how fast it goes. A belt used to be a \
                 thing that always stepped one slot every tick; a belt now carries its own \
                 advance interval as saved state. That changed the shape every saved belt \
                 is written in, so an older file no longer decodes. There is deliberately \
                 no migration, because opening your board would mean picking an advance \
                 interval for every belt on it, and any choice would re-time a factory you \
                 never re-timed. Refusing is the honest outcome."
            ),
        }
    }
}

impl std::error::Error for ProjectError {}

impl From<std::io::Error> for ProjectError {
    fn from(e: std::io::Error) -> Self {
        ProjectError::Io(e)
    }
}

impl From<StoreError> for ProjectError {
    fn from(e: StoreError) -> Self {
        ProjectError::Store(e)
    }
}

impl From<DecodeError> for ProjectError {
    fn from(e: DecodeError) -> Self {
        ProjectError::InvalidSnapshot(e)
    }
}

/// A snapshot-gate refusal as the load error a user reads (plan 86-07, D-08): a label
/// holding a port or a link is [`ProjectError::LabelConnected`], the same sentence the
/// edit-log forgeries get, and every other refusal keeps its own arm via `other`.
fn label_refusal_or(d: DecodeError, other: fn(DecodeError) -> ProjectError) -> ProjectError {
    match d {
        DecodeError::InvalidState(fabrico_core::event::StateInvariant::LabelConnected) => {
            ProjectError::LabelConnected
        }
        d => other(d),
    }
}

/// The tick a load deterministically reaches from a base snapshot at `base_tick`: `run_log`
/// starts at `base_tick` and loops to one past the MAX tick across BOTH logs when
/// `base_tick <= max`, else stays at `base_tick` (empty logs, or a base already at or
/// after the last record). The one home of this rule: `load_project`'s pre-flight
/// head-tick check and `save_project`'s choice of base both call it (plan 86-06).
///
/// # Errors
/// [`ProjectError::TickOverflow`] when the highest logged tick is `u64::MAX` (the
/// checked add that kills the T-06-LOAD-DOS Mode A panic).
fn replay_end(base_tick: u64, log: &[Event], edit_log: &[EditRecord]) -> Result<u64, ProjectError> {
    let max_event_tick = log.iter().map(|ev| ev.tick).max();
    let max_edit_tick = edit_log.iter().map(|er| er.tick).max();
    // The replay target is driven by the MAX tick across BOTH logs (recover() folds
    // tick-by-tick up to the highest tick in either log).
    let max_tick = match (max_event_tick, max_edit_tick) {
        (Some(a), Some(b)) => Some(a.max(b)),
        (Some(a), None) | (None, Some(a)) => Some(a),
        (None, None) => None,
    };
    match max_tick {
        Some(max) if base_tick <= max => max
            .checked_add(1)
            .ok_or(ProjectError::TickOverflow { max_event_tick: max }),
        _ => Ok(base_tick),
    }
}

/// Write a portable project file: bundle the host's pure deterministic substrate
/// (snapshot + log) into a single `postcard` file at `path` (SAVE-01).
///
/// The base snapshot is the latest PERSISTED snapshot
/// ([`Host::latest_persisted_snapshot`]) when one exists AND a load replaying from it
/// reaches the saved head tick (so `base_tick <= head_tick`, making the load-time
/// replay-forward path non-trivial), else the head snapshot ([`Host::snapshot_bytes`],
/// `base_tick == head_tick`). Either way load is genesis-free: `recover()` restores the
/// snapshot whose advanced ChaCha8 state wins.
///
/// # Why the persisted base is checked against the head tick (plan 86-06)
/// A load replays from the base only to one tick past the highest logged record
/// ([`replay_end`]). A host that ran on past its last record with nothing logged (an
/// opened file, whose snapshot the open stored as the restart point, or a host past its
/// last cadence snapshot) holds a persisted base that never reaches its head tick, so a
/// file saved on it was refused `HeadTickMismatch` at the next open. The same
/// [`replay_end`] the load applies decides here, so the two cannot drift; the head
/// snapshot is always a base the load reaches, since every logged record is stamped
/// below the head tick. The host executor state (ledger / in-flight) is NEVER
/// bundled — only snapshot + log cross the file (CONTEXT "Save Scope").
///
/// # Errors
/// [`ProjectError::Store`] if the log / persisted snapshot cannot be read, or
/// [`ProjectError::Io`] if the file cannot be written.
// The workspace `clippy.toml` disallows `std::fs` to keep IO out of the
// deterministic sim core; it is enforced at deny ONLY inside `fabrico-core`, but
// `fabrico-host`'s `#![warn(clippy::all)]` + CI's `-D warnings` promotes it here
// too. `fabrico-host` is the project's SANCTIONED I/O home (see `lib.rs` module
// doc) and writing the user-facing project file is exactly the file IO that
// belongs here, off the sim thread — so scope the allow to this IO boundary fn.
#[allow(clippy::disallowed_methods)]
pub fn save_project(host: &Host, path: &Path) -> Result<(), ProjectError> {
    // (0) Enforce the QUIESCENT-save precondition (WR-02). Exactly-once + a faithful
    //     reload rest on the save being taken with no command in-flight. Saving with
    //     an unresolved command (an InFlight ledger row, no CommandResult logged yet)
    //     bundles a log the fresh-ledger recover() re-emits muted and reinstates to
    //     TIME OUT at its deadline — silently degrading a successful effect into a
    //     Timeout/fault on reload. Make it a loud, recoverable error rather than a
    //     silent semantic loss: the caller ticks to quiescence and retries.
    let in_flight = host.in_flight_len();
    if in_flight != 0 {
        return Err(ProjectError::NotQuiescent(in_flight));
    }
    let head_tick = host.core().tick;
    let log = host.logged_events()?;
    // The topology edit-log (08-05, ELOG-01): the SECOND ordered log, bundled
    // alongside the event log. The MAX_PROJECT_BYTES stat-guard already bounds
    // the whole file including this added log.
    let edit_log = host.logged_edits()?;
    // Prefer the latest persisted (cadence/on-demand) snapshot as the replay base
    // so base_tick <= head_tick, but ONLY when a load replaying from it reaches
    // head_tick (plan 86-06, see the doc above); otherwise, and when none persisted,
    // the head snapshot, which every load reaches.
    let snapshot = match host.latest_persisted_snapshot()? {
        Some((base_tick, bytes))
            if replay_end(base_tick, &log, &edit_log).ok() == Some(head_tick) =>
        {
            bytes
        }
        _ => host.snapshot_bytes(),
    };
    let bundle = ProjectFile {
        version: PROJECT_FILE_VERSION,
        head_tick,
        snapshot,
        log,
        edit_log,
    };
    let bytes = postcard::to_allocvec(&bundle)
        .map_err(|e| ProjectError::Store(StoreError::Backend(format!("project encode: {e}"))))?;
    std::fs::write(path, bytes)?;
    Ok(())
}

/// Load a portable project file into a running [`Host`] (SAVE-01) — hydrate a
/// FRESH store + a FRESH empty ledger, then reuse the proven [`Host::recover`].
///
/// Steps (every untrusted decode is behind `?` mapping to [`ProjectError`] —
/// NEVER a panic):
/// 1. read + postcard-decode the file (layer-1 → [`ProjectError::Malformed`]);
/// 2. refuse a forward `version` (outermost layer → [`ProjectError::UnknownVersion`])
///    BEFORE touching the fresh store;
/// 3. validate + read `base_tick` via the HARDENED [`fabrico_core::snapshot::restore`]
///    (plan 06-01's `validate_invariants` rejects a hostile / forward / malformed
///    snapshot here, BEFORE anything is written → [`ProjectError::InvalidSnapshot`]);
/// 4. hydrate a FRESH [`RedbStore`] in `work_dir` (write the base snapshot, then
///    re-append each logged event in fold order — the per-event `schema_version`
///    refusal lives in `Host::logged_events` on the read side);
/// 5. open a FRESH empty [`DispatchLedger`] (host executor state is NOT bundled);
/// 6. build a `Host` over a throwaway-genesis `Core` (its seed is irrelevant —
///    `recover()` overwrites it from the restored snapshot's advanced state) and
///    call `recover()` exactly once (restore base → replay log forward MUTED →
///    rebuild in-flight from the empty ledger). The result reaches
///    `host.core().tick == bundle.head_tick`;
/// 7. install a FRESH persisted [`SeenSet`] opened inside `work_dir` (20-review
///    CR-01: the boot paths install one and document it as load-bearing — without
///    it `Host::record_delivery` returns `true` for every id and webhook dedup
///    silently no-ops, so a provider's at-least-once retry double-fires a Source
///    on any loaded scene).
///
/// `work_dir` MUST be a FRESH / empty directory (never the saved path or a
/// populated store) so `Host::new`'s next-sequence high-water mark is correct by
/// construction (RESEARCH Pitfall 4).
///
/// # Errors
/// [`ProjectError::Io`] (read), [`ProjectError::Malformed`] (bad bundle),
/// [`ProjectError::UnknownVersion`] (forward bundle), [`ProjectError::InvalidSnapshot`]
/// (hostile / forward / malformed snapshot), or [`ProjectError::Store`] (fresh
/// store / ledger / recovery failure). Since plan 74.1-23 also
/// [`ProjectError::EditPortEditOutOfEnvelope`] (a forged captured seat or restore box,
/// per record) and [`ProjectError::EditReplayStateInvalid`] (the replayed core fails the
/// snapshot trust gate, checked by `Host::recover_gated` before the host is returned).
// See `save_project` — `fabrico-host` is the sanctioned I/O home; reading the
// user-facing project file is the file IO that belongs here. Scope the determinism
// -gate allow to this single IO boundary fn (the gate's real target is the core).
#[allow(clippy::disallowed_methods)]
pub fn load_project(
    path: &Path,
    work_dir: &Path,
    snapshot_every: Option<u64>,
) -> Result<Host, ProjectError> {
    // (1) Bound the read BEFORE allocating the whole untrusted file into memory
    //     (WR-01). Stat the file and refuse an oversized bundle up front — a
    //     memory-exhaustion-DoS guard that engages BEFORE the layered per-record
    //     MAX_RECORD_BYTES defenses, mirroring the persistence read boundary the
    //     event-log invariant advertises. A hostile/oversized `.fab` is a typed
    //     TooLarge, never an OOM/abort.
    let size = std::fs::metadata(path)?.len();
    if size > MAX_PROJECT_BYTES {
        return Err(ProjectError::TooLarge {
            size,
            limit: MAX_PROJECT_BYTES,
        });
    }
    // Read + decode the untrusted file. A bad decode is Malformed, not a panic.
    let bytes = std::fs::read(path)?;
    // (2) Version gate BEFORE touching the fresh store (outermost layer). postcard is
    //     NOT self-describing, so the bundle SHAPE differs by version. The SPAT-01
    //     clean break (09-04) dropped the pre-v4 migration shims: peek the leading
    //     `version` varint (the struct's first field) WITHOUT committing to a shape,
    //     then refuse anything that is not exactly PROJECT_FILE_VERSION. A forward
    //     bundle is a typed `UnknownVersion`; an older one is a typed `TooOld`, except
    //     at PRE_SPEED_CHANGE_PROJECT_VERSION and PRE_SLOT_CHANGE_PROJECT_VERSION, which
    //     get the more specific `BeltSpeedModelChanged` / `SlotModelChanged` respectively
    //     (never migrated, never a panic). Only a bundle at exactly
    //     PROJECT_FILE_VERSION is decoded through the current `ProjectFile` shape.
    //     (Version numbers are named rather than spelled out here on purpose: the
    //     spelled-out v4/v5 prose this replaces had drifted three bumps out of date.)
    let (peeked_version, _) =
        postcard::take_from_bytes::<u16>(&bytes).map_err(|_| ProjectError::Malformed)?;
    if peeked_version > PROJECT_FILE_VERSION {
        return Err(ProjectError::UnknownVersion(peeked_version));
    }
    if peeked_version < PROJECT_FILE_VERSION {
        // (2b) The too-old branch splits TWO ways (60-03 D-02/D-05, then 62-06 D-14), and
        //      the SPEED arm is tested FIRST because v7 is the more recent boundary. A
        //      bundle at exactly PRE_SPEED_CHANGE_PROJECT_VERSION predates the per-belt
        //      advance-interval change, and one at exactly PRE_SLOT_CHANGE_PROJECT_VERSION
        //      predates the belt slot-spacing change; each gets a refusal that says so.
        //      Everything older keeps the generic TooOld verbatim, so the generic error
        //      stays generic and does not inherit a version-specific reason it will outlive.
        //      These are TWO integer comparisons inside a guard that already runs before any
        //      body decode, any allocation and any store access, so the refusal keeps its
        //      O(1), reject-only character (T-60-14, T-62-02) and the accepted window is
        //      unchanged: all three arms still refuse. The two constants are distinct hard
        //      literals, so no version can match both and the ordering cannot change an
        //      outcome; it is written most-recent-first for the reader.
        if peeked_version == PRE_SPEED_CHANGE_PROJECT_VERSION {
            return Err(ProjectError::BeltSpeedModelChanged {
                found: peeked_version,
            });
        }
        if peeked_version == PRE_SLOT_CHANGE_PROJECT_VERSION {
            return Err(ProjectError::SlotModelChanged {
                found: peeked_version,
            });
        }
        return Err(ProjectError::TooOld {
            found: peeked_version,
            expected: PROJECT_FILE_VERSION,
        });
    }
    let bundle: ProjectFile =
        postcard::from_bytes(&bytes).map_err(|_| ProjectError::Malformed)?;

    // (3) Validate the snapshot through the HARDENED decode and read its base tick.
    //     This is where plan 06-01's validate_invariants rejects a hostile bundle
    //     (DecodeError -> ProjectError::InvalidSnapshot) BEFORE anything is written.
    //     Plan 86-07 (D-08): a snapshot whose label holds a port or a link is the label
    //     refusal, named in words, not the generic snapshot one.
    let base_tick = fabrico_core::snapshot::restore(&bundle.snapshot)
        .map_err(|d| label_refusal_or(d, ProjectError::InvalidSnapshot))?
        .tick;

    // (3b) Validate the bundled log UP FRONT (IN-02) — BEFORE the fresh store is
    //      hydrated, so a malformed log is rejected before anything is written:
    //      (a) refuse a forward-versioned event (mirroring `Host::logged_events`'s
    //          read-side refusal) so a bad bundle is a precise typed
    //          `UnreadableLogEvent`, not a generic deep `Store` failure surfaced only
    //          after the fresh store is hydrated; and
    //      (b) require strictly-increasing `(partition, sequence)` keys — a
    //          duplicate/out-of-order key would silently COLLAPSE entries when
    //          re-appended by key (`append_event` has no monotonicity check),
    //          mis-decoding a hostile bundle deeper in. Either is a typed error here,
    //          never a panic.
    let mut prev: Option<(u64, u64)> = None;
    for ev in &bundle.log {
        if ev.schema_version > SCHEMA_VERSION {
            return Err(ProjectError::UnreadableLogEvent(ev.schema_version));
        }
        let key = (ev.partition, ev.sequence);
        if prev.is_some_and(|p| key <= p) {
            return Err(ProjectError::NonMonotonicLog {
                partition: ev.partition,
                sequence: ev.sequence,
            });
        }
        prev = Some(key);
    }

    // (3b') Validate the bundled EDIT log UP FRONT (ELOG-05) — the exact mirror of
    //       the event-log loop, applied to the SECOND log BEFORE the fresh store is
    //       hydrated. THE dominant security surface of this phase: a hostile two-log
    //       `.fab` must always be a typed error, never a panic/OOM/hang.
    //       (a) refuse an edit record whose schema_version is not EXACTLY the running
    //           EDIT_SCHEMA_VERSION, newer OR older (mirror `Host::logged_edits`; both
    //           call the one predicate `fabrico_core::edit::check_version` since Phase
    //           63) -> `UnreadableEditRecord` (T-8-LOAD-EDIT-VER). This is the
    //           user-reachable half of the v8.0 clean break: a `.fab` file saved before
    //           milestone v8.0 is refused HERE, and it is the boundary SCHEMA-01's
    //           criterion is about. `edit::upcast` is NOT a boundary any caller
    //           reaches; and
    //       (b) require strictly-increasing `(partition, sequence)` keys — a
    //           duplicate/out-of-order key would silently COLLAPSE entries when
    //           re-appended by key (`append_edit` has no monotonicity check)
    //           -> `NonMonotonicEditLog` (T-8-LOAD-EDIT-COLLAPSE).
    let mut prev_edit: Option<(u64, u64)> = None;
    for er in &bundle.edit_log {
        if fabrico_core::edit::check_version(er.schema_version).is_err() {
            return Err(ProjectError::UnreadableEditRecord(er.schema_version));
        }
        let key = (er.partition, er.sequence);
        if prev_edit.is_some_and(|p| key <= p) {
            return Err(ProjectError::NonMonotonicEditLog {
                partition: er.partition,
                sequence: er.sequence,
            });
        }
        prev_edit = Some(key);
        // (3b'-74.1-23) The port-edit envelope (review WR-02, round 3): a forged captured
        // seat's slot or restore box, judged by the ONE predicate `upcast` and
        // `Host::logged_edits` also call, so the three boundaries cannot drift. A
        // restore box inside the envelope yet too small for the surviving ports is the
        // state-aware half, refused after the replay (`EditReplayStateInvalid`).
        if !fabrico_core::edit::port_edit_in_envelope(&er.op) {
            return Err(ProjectError::EditPortEditOutOfEnvelope { sequence: er.sequence });
        }
        // (3b'-CR-01) Bound the attacker-controlled footprint dims on every bundled
        // `Place` BEFORE recover() replays it through `fold_place`/`claim_footprint`
        // (verbatim, no fold-time re-validation — decision Q2). A forged
        // `w = h = u16::MAX` Place would expand to ~4.3 billion occupancy cells (a
        // tiny-input/multi-GiB amplification bomb, T-06-01-DOS); refuse it up front as
        // a typed error, the load-path twin of `edit::upcast`'s `Malformed` guard and
        // the snapshot gate's `FootprintTooLarge`. `1 <= w,h <= MAX_FOOTPRINT_DIM`.
        // (3b'-86-02) A rotation is a quarter-turn count, `0..=3`, on a `Place` (EDIT 13)
        // and on a `Delete` capture, which the Delete inverse re-Places at. A larger value
        // names no orientation; refuse it before the replay, the load-path twin of
        // `edit::upcast`'s `Malformed` and the snapshot gate's `FootprintBadRot`.
        match &er.op {
            EditOp::Place { rot, .. } if *rot > 3 => {
                return Err(ProjectError::EditRotationOutOfRange { rot: *rot });
            }
            EditOp::Delete { captured, .. } if captured.rot > 3 => {
                return Err(ProjectError::EditRotationOutOfRange { rot: captured.rot });
            }
            _ => {}
        }
        // (3b'-T-86-27) A label never holds a port (D-08), so a bundled `Place` of kind
        // LABEL carrying ports, or a `Delete` of kind LABEL whose capture carries ports, is
        // a hand-edited or damaged file, refused here as `LabelConnected` with the label
        // sentence. Read off the record alone, before the replay, because the replay cannot
        // be relied on to see it: a label Place with a port that a later record deletes
        // leaves no port at the end, and a forged label Delete's capture folds nothing at
        // all until a Ctrl+Z re-Places it, a label WITH that port (no re-Configure strips it
        // when the config misses or names another kind). Measured before this check (phase
        // 86 security audit, threat T-86-27): such a file opened, its Ctrl+Z was accepted,
        // and the board saved into a file refused `LabelConnected` on the next open. No
        // gesture writes either record: a label is placed from the catalog with no ports,
        // `AddPort` on one is refused `LabelDoesNotConnect`, and a Delete captures the ports
        // the label holds, which are none.
        match &er.op {
            EditOp::Place { kind, ports, .. }
                if *kind == fabrico_protocol::machine_kind::LABEL && !ports.is_empty() =>
            {
                return Err(ProjectError::LabelConnected);
            }
            EditOp::Delete { kind, captured, .. }
                if *kind == fabrico_protocol::machine_kind::LABEL
                    && !captured.ports.is_empty() =>
            {
                return Err(ProjectError::LabelConnected);
            }
            _ => {}
        }
        if let EditOp::Place {
            cell_x,
            cell_y,
            w,
            h,
            ports,
            ..
        } = &er.op
        {
            let (w, h, cell_x, cell_y) = (*w, *h, *cell_x, *cell_y);
            // (a) dim envelope (CR-01) — the allocation-bomb guard, as before.
            if w == 0 || h == 0 || w > MAX_FOOTPRINT_DIM || h > MAX_FOOTPRINT_DIM {
                return Err(ProjectError::EditFootprintOutOfRange { w, h });
            }
            // (b-WR-01) anchor extent — mirror the snapshot gate's `[GRID_MIN, GRID_MAX]`
            //   bound so the edit-log path cannot build an out-of-extent (non-round-
            //   tripping) `Core` the snapshot gate would reject as `CellOutOfBounds`.
            if !(GRID_MIN..=GRID_MAX).contains(&cell_x) || !(GRID_MIN..=GRID_MAX).contains(&cell_y)
            {
                return Err(ProjectError::EditAnchorOutOfBounds { cell_x, cell_y });
            }
            // (c-WR-02) port-in-footprint — mirror the snapshot gate's
            //   `PortOutOfFootprint`: every rot-0 `local_offset` must lie in
            //   `[0,w)×[0,h)`, else `fold_place`→`set_ports` would install a port the
            //   gate rejects on the next restore. Dims are bounded by (a), so the
            //   `i32::from` comparison is overflow-free.
            let (wi, hi) = (i32::from(w), i32::from(h));
            for p in ports {
                let (px, py) = p.local_offset;
                if px < 0 || py < 0 || px >= wi || py >= hi {
                    return Err(ProjectError::EditPortOutOfFootprint {
                        local_offset: p.local_offset,
                        w,
                        h,
                    });
                }
            }
        }
        // (3b''-T-63-01, 63-04) Bound the attacker-controlled ROUTE TABLE on every
        // bundled `Configure{Router}` BEFORE recover() replays it through
        // `fold_configure` (verbatim, no fold-time re-validation — Q2). `routes` is a Vec
        // whose every element carries a `RouteKey.expect: Vec<u8>`, so a forged record
        // can carry millions of rules OR one multi-gigabyte pattern; both dimensions are
        // bounded, reading `MAX_ROUTES` / `MAX_ROUTE_EXPECT_BYTES` straight out of
        // `fabrico_core::edit` rather than redeclaring them here. This is the same pair
        // of constants `edit::upcast` applies, exactly as `MAX_FOOTPRINT_DIM` / `GRID_MIN`
        // / `GRID_MAX` are already shared across these two files: ONE home for the bound,
        // two typed refusals.
        //
        // NAMED DEBT (T-63-26): this loop re-implements a SUBSET of `upcast`'s guards and
        // the two sets are NOT identical. `upcast` is the stricter of the two — it also
        // bounds `DrawBelt` tile lists, the `Delete` capture Vecs and the Factory
        // `Configure` source length, none of which is checked here. The asymmetry is
        // pre-existing and is deliberately NOT widened or unified in this plan: the two
        // boundaries return different typed error families ON PURPOSE, and collapsing
        // them would replace `ProjectError`'s per-class variants — each of which names
        // what actually went wrong — with a generic decode error that tells a user
        // nothing. The NEW surface Phase 63 opens is guarded at both boundaries; the old
        // gap is recorded here rather than left to be rediscovered.
        //
        // Phase 76 (plan 76-04): the label arm below is in this loop, so a label's text and
        // size are bounded at both boundaries. The Route path (`Configure{Endpoint}`,
        // WINDOWS 184) is STILL unbounded in this loop, and that is deliberately not fixed
        // in this plan: it stays named here and in WINDOWS.
        if let EditOp::Configure {
            config: MachineConfig::Router { routes, .. },
            ..
        } = &er.op
        {
            if routes.len() > MAX_ROUTES {
                return Err(ProjectError::EditRouteTableTooLong {
                    routes: routes.len(),
                    cap: MAX_ROUTES,
                });
            }
            if let Some((key, _)) = routes
                .iter()
                .find(|(key, _)| key.expect.len() > MAX_ROUTE_EXPECT_BYTES)
            {
                return Err(ProjectError::EditRoutePatternTooLong {
                    len: key.expect.len(),
                    cap: MAX_ROUTE_EXPECT_BYTES,
                });
            }
        }
        // (3b'''-T-76-12/13, 76-04) Bound a bundled `Configure{Label}` BEFORE recover()
        // replays it: the text against `MAX_LABEL_BYTES` (the write gate's own number,
        // read, never restated) and the box against `1..=MAX_FOOTPRINT_DIM`, the envelope
        // the fold clamps to. Never the 16 by 8 panel caps, which are write-side policy:
        // a later cap change must not make a saved board unloadable.
        if let EditOp::Configure {
            config: MachineConfig::Label { text, w, h, .. },
            ..
        } = &er.op
        {
            if text.len() > MAX_LABEL_BYTES {
                return Err(ProjectError::EditLabelTextTooLong {
                    len: text.len(),
                    cap: MAX_LABEL_BYTES,
                });
            }
            if !(1..=MAX_FOOTPRINT_DIM).contains(w) || !(1..=MAX_FOOTPRINT_DIM).contains(h) {
                return Err(ProjectError::EditLabelSizeOutOfRange {
                    w: *w,
                    h: *h,
                    cap: MAX_FOOTPRINT_DIM,
                });
            }
        }
    }

    // (3c) Bound the attacker-controlled tick fields BEFORE recover() restores the
    //      snapshot and replays the log (T-06-LOAD-DOS). Both `base_tick` (the
    //      snapshot's Core.tick) and every `Event.tick` are untrusted u64s, and
    //      recover() restores the base snapshot then `run_log`s the events —
    //      looping `while core.tick <= max_event_tick { core.tick += 1 }` — BEFORE
    //      load_project's existing post-recover head_tick check (step 7) can run.
    //      So the post-recover check cannot prevent either failure: a tick at
    //      u64::MAX PANICS on the `+= 1` overflow (Mode A), and a huge tick gap
    //      HANGS the idle-tick loop (Mode B). Both are killed here with checked /
    //      saturating arithmetic and a finite replay-span ceiling — typed errors,
    //      never a panic or hang.
    //
    //      `replay_end` is the tick recover() will deterministically reach: run_log
    //      starts at `base_tick` and loops to `max_event_tick + 1` when
    //      `base_tick <= max_event_tick`, else stays at `base_tick` (an empty log,
    //      or a base snapshot already at/after the last event — the head-snapshot
    //      save). The CHECKED add kills Mode A; the SATURATING span check kills
    //      Mode B. This is the pre-flight twin of the step-7 head_tick invariant,
    //      moved ahead of the untrusted replay so it actually guards it.
    //      BOTH logs' tick spans must be bounded (ELOG-05, T-8-LOAD-EDIT-DOS): a
    //      hostile edit-tick gap drives recover()'s two-log replay loop exactly like
    //      a hostile event tick, so fold the edit-log max tick into `replay_end` too.
    let replay_end = replay_end(base_tick, &bundle.log, &bundle.edit_log)?;
    // The bundled head_tick MUST equal the tick the restored snapshot + log folds
    // to (the documented post-load invariant) — verified UP FRONT so a tampered /
    // inconsistent bundle is refused before anything is written or replayed. Field
    // semantics match the step-7 check (expected = claimed head_tick, actual =
    // computed replay target) so the error is identical whether caught here or there.
    if bundle.head_tick != replay_end {
        return Err(ProjectError::HeadTickMismatch {
            expected: bundle.head_tick,
            actual: replay_end,
        });
    }
    // Bound the forward replay span to a finite ceiling (Mode B DoS guard). The
    // run_log loop steps one idle tick per `replay_end - base_tick` iteration;
    // saturating arithmetic keeps the bound itself panic-free on any input.
    let span = replay_end.saturating_sub(base_tick);
    if span > MAX_REPLAY_SPAN {
        return Err(ProjectError::ReplaySpanTooLong {
            span,
            limit: MAX_REPLAY_SPAN,
        });
    }

    // (4) Hydrate a FRESH redb store in work_dir (MUST be fresh/empty — Pitfall 4):
    //     write the base snapshot, then re-append every logged event in fold order.
    let mut store = RedbStore::open(work_dir.join("log.redb"))?;
    store.write_snapshot(base_tick, &bundle.snapshot)?;
    for ev in &bundle.log {
        let raw = postcard::to_allocvec(ev).map_err(|e| {
            ProjectError::Store(StoreError::Backend(format!("event re-encode: {e}")))
        })?;
        store.append_event(ev.partition, ev.sequence, &raw)?;
    }
    // Hydrate the EDITS table from the validated bundled edit-log (08-05, ELOG-01),
    // so recover()'s two-log replay (run_log_two_logs) sees the topology edits. The
    // strictly-increasing-key check above guarantees no two records collide here.
    for er in &bundle.edit_log {
        let raw = postcard::to_allocvec(er).map_err(|e| {
            ProjectError::Store(StoreError::Backend(format!("edit re-encode: {e}")))
        })?;
        store.append_edit(er.partition, er.sequence, &raw)?;
    }

    // (5) FRESH empty ledger — the host executor state is NOT bundled (Save Scope).
    let ledger = DispatchLedger::open(work_dir.join("ledger.redb"))?;

    // (6) Build over a throwaway genesis (seed irrelevant — recover() restores the
    //     snapshot's advanced state) and REUSE Host::recover() (restore base ->
    //     replay log forward MUTED -> rebuild in-flight from the empty ledger). Do
    //     NOT re-implement restore/replay.
    let core = Core::genesis(LogHeader {
        schema_version: SCHEMA_VERSION,
        seed: 0,
    });
    let mut host = Host::new(core, store, ledger, snapshot_every)?;
    // (6c) Plan 74.1-23: replay through `recover_gated`, so the replayed core passes the
    //      snapshot trust gate BEFORE this host is returned; a refusal is its own typed
    //      variant, the replay-time twin of `EditPortOutOfFootprint`.
    host.recover_gated().map_err(|e| match e {
        RecoverError::Store(e) => ProjectError::Store(e),
        RecoverError::ReplayStateInvalid(d) => {
            label_refusal_or(d, ProjectError::EditReplayStateInvalid)
        }
    })?;

    // (6d) Plan 85-06 (D-10, T-85-14): the undo floor read from the logged history seal
    //      must not be reached below. Only a hand-edited or damaged file can hold an Undo
    //      marker naming a sealed scene command, or a cursor under the floor; such a file
    //      is refused with both numbers rather than opened with its scene undone behind a
    //      greyed Undo button. A user's own history above the floor is untouched (UNDO-07).
    let session = host.session();
    if session.undo_floor_breached() {
        return Err(ProjectError::UndoFloorBreached {
            floor: u64::try_from(session.undo_floor()).unwrap_or(u64::MAX),
            cursor: u64::try_from(session.redo_cursor()).unwrap_or(u64::MAX),
        });
    }

    // (6e) Plan 86-07 (D-08, WORK-09): a record joining a label to a port, a belt or a cable.
    //      The fold changed nothing on it; the re-fold from genesis saw it. Refused in
    //      words rather than opened with the record silently dropped.
    if session.label_connect_forged() {
        return Err(ProjectError::LabelConnected);
    }

    // The spatial layout is no longer a host sidecar (SPAT-01 clean break, 09-04):
    // cells ride the embedded Core snapshot and are restored by `recover()` above,
    // so there is nothing extra to hydrate here.

    // (7) Enforce the documented post-load sanity invariant (IN-01): the bundled
    //     head_tick MUST equal the tick the restored snapshot + replayed log
    //     actually folds to. A bundle whose head_tick disagrees is inconsistent /
    //     tampered — reject it with a typed error instead of silently loading to a
    //     different tick than the bundle claims.
    let actual = host.core().tick;
    if actual != bundle.head_tick {
        return Err(ProjectError::HeadTickMismatch {
            expected: bundle.head_tick,
            actual,
        });
    }

    // (8) Install a FRESH persisted seen-set inside work_dir (20-review CR-01,
    //     HOST-06 parity with both boot paths). Without one, `record_delivery`
    //     hits its `None => Ok(true)` arm for EVERY delivery id — the webhook
    //     listener stays bound across a host swap and the swap force-republishes
    //     routes, so ingress actively flows into the loaded host with dedup
    //     silently disabled, and a provider's at-least-once retry double-fires a
    //     Source (double-logging the event and double-firing every downstream
    //     sink effect). The set is fresh (dedup history is host-executor state,
    //     never bundled in the .fab), mirroring the fresh ledger in step (5).
    let seen = SeenSet::open(work_dir.join("seen.redb"))?;
    Ok(host.with_seen_set(seen))
}

#[cfg(test)]
// The save/load tests round-trip real files on disk (the host is the I/O home);
// scope the determinism-gate allow to the test module, matching the two IO fns.
#[allow(clippy::disallowed_methods)]
mod tests {
    // `super::*` brings in Core, LogHeader, SCHEMA_VERSION, RedbStore,
    // DispatchLedger, Host, PersistenceStore, the bundle types and fns.
    use super::*;
    use fabrico_core::command::{Command, Outcome, ResultEvent};
    use fabrico_core::event::EventPayload;
    use fabrico_core::ids::{Item, NodeId};
    use fabrico_core::state::SinkTemplate;
    use tokio::sync::mpsc::unbounded_channel;

    fn header() -> LogHeader {
        LogHeader {
            schema_version: SCHEMA_VERSION,
            seed: 7,
        }
    }

    /// Build a `source -> sink` host on temp redb, inject one item, and tick it
    /// twice so the log is non-empty and (with `snapshot_every`) a snapshot is
    /// persisted at `base_tick <= head_tick`.
    fn ticked_host(snapshot_every: Option<u64>) -> (tempfile::TempDir, Host, NodeId) {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut core = Core::genesis(header());
        let source = core.state.add_source();
        let sink = core.state.add_sink(SinkTemplate::Debug, 5);
        core.state.link((source, 0), (sink, 0));
        let store = RedbStore::open(dir.path().join("log.redb")).expect("open log");
        let ledger = DispatchLedger::open(dir.path().join("ledger.redb")).expect("open ledger");
        let mut host = Host::new(core, store, ledger, snapshot_every).expect("open host");

        let (cmd_tx, _cmd_rx) = unbounded_channel::<Command>();
        let (_res_tx, mut res_rx) = unbounded_channel::<ResultEvent>();
        let (ing_tx, mut ing_rx) = unbounded_channel::<EventPayload>();
        ing_tx
            .send(EventPayload::ManualInject {
                target: source,
                port: 0,
                item: Item(vec![0xAB]),
            })
            .expect("seed ingress");
        host.tick_once(&mut ing_rx, &mut res_rx, &cmd_tx).expect("tick 1");
        host.tick_once(&mut ing_rx, &mut res_rx, &cmd_tx).expect("tick 2");
        (dir, host, source)
    }

    /// Like [`ticked_host`] but driven to a QUIESCENT boundary (in-flight empty):
    /// the Debug sink's one emitted command is resolved with a trivial `Success`
    /// fed back one tick later (modelling the real async executor), so the loop
    /// stops the instant the command is folded and nothing is in flight. Required
    /// for the `save_project` tests because saving now REFUSES a non-quiescent host
    /// (WR-02).
    fn quiesced_host(snapshot_every: Option<u64>) -> (tempfile::TempDir, Host, NodeId) {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut core = Core::genesis(header());
        let source = core.state.add_source();
        let sink = core.state.add_sink(SinkTemplate::Debug, 5);
        core.state.link((source, 0), (sink, 0));
        let store = RedbStore::open(dir.path().join("log.redb")).expect("open log");
        let ledger = DispatchLedger::open(dir.path().join("ledger.redb")).expect("open ledger");
        let mut host = Host::new(core, store, ledger, snapshot_every).expect("open host");

        let (cmd_tx, mut cmd_rx) = unbounded_channel::<Command>();
        let (res_tx, mut res_rx) = unbounded_channel::<ResultEvent>();
        let (ing_tx, mut ing_rx) = unbounded_channel::<EventPayload>();
        ing_tx
            .send(EventPayload::ManualInject {
                target: source,
                port: 0,
                item: Item(vec![0xAB]),
            })
            .expect("seed ingress");

        // A result queued this iteration is delivered on the next (one-tick async
        // latency). Stop only AFTER the sink's command has been emitted AND resolved.
        let mut pending: Option<ResultEvent> = None;
        let mut saw_command = false;
        let mut guard = 0u32;
        loop {
            host.tick_once(&mut ing_rx, &mut res_rx, &cmd_tx).expect("tick");
            if let Some(re) = pending.take() {
                let _ = res_tx.send(re);
            }
            while let Ok(cmd) = cmd_rx.try_recv() {
                saw_command = true;
                pending = Some(ResultEvent {
                    command_id: cmd.id,
                    tick: 0, // the host stamps the real admit tick on fold
                    outcome: Outcome::Success,
                });
            }
            if saw_command && host.in_flight_len() == 0 && pending.is_none() {
                break;
            }
            guard += 1;
            assert!(guard < 64, "the host failed to quiesce within 64 ticks");
        }
        (dir, host, source)
    }

    /// An unstamped `Place` edit the host will stamp + fold (mirror the driver test
    /// helper). The host overwrites `partition`/`sequence`/`tick` on enqueue.
    fn place_edit(kind: u8, cell_x: i32, cell_y: i32) -> EditRecord {
        EditRecord {
            schema_version: EDIT_SCHEMA_VERSION,
            partition: 0,
            sequence: 0,
            tick: 0,
            action: 0,
            op: EditOp::Place {
                kind,
                cell_x,
                cell_y,
                w: 1,
                h: 1,
                ports: vec![],
                rot: 0,
            },
        }
    }

    #[test]
    fn project_v5_round_trips() {
        // SPAT-01 / 10-02 clean break: a v5 ProjectFile carries BOTH logs (event-log +
        // edit-log) and NO layout sidecar — the spatial layout now rides the embedded
        // Core snapshot (now v5: footprints/ports maps joined the wire). Save + load
        // round-trips: load replays both logs forward to head_tick, rebuilds the
        // edit-minted topology, and reconstructs the spatial cells from the snapshot
        // alone (no host-side sidecar).
        let (dir, mut host, _source) = quiesced_host(Some(1));

        // Add a real topology edit to the edit-log: enqueue a Place + tick (folds it
        // edits-first; mints a node AT a cell in core, emits no command -> quiescent).
        let nodes_before = host.core().state.node_count();
        host.enqueue_edit(place_edit(0, 7, 7));
        let (cmd_tx, _cmd_rx) = unbounded_channel::<Command>();
        let (_res_tx, mut res_rx) = unbounded_channel::<ResultEvent>();
        let (_ing_tx, mut ing_rx) = unbounded_channel::<EventPayload>();
        host.tick_once(&mut ing_rx, &mut res_rx, &cmd_tx)
            .expect("fold the edit");
        assert_eq!(
            host.core().state.node_count(),
            nodes_before + 1,
            "the Place edit minted a node"
        );
        assert_eq!(host.in_flight_len(), 0, "still quiescent after the edit fold");
        // The minted node landed a cell in CORE (SPAT-01), not a host sidecar.
        let placed = *host.core().last_tick.placed.last().expect("a node was minted");
        assert_eq!(
            host.core().state.cell_of(placed),
            Some((7, 7)),
            "the Place edit set the cell in core GridState"
        );

        let path = dir.path().join("v5.fab");
        save_project(&host, &path).expect("save v5");

        // The saved bundle is v5, carries the edit-log, and has NO layout field.
        let bytes = std::fs::read(&path).expect("read v5");
        let bundle: ProjectFile = postcard::from_bytes(&bytes).expect("decode v5");
        assert_eq!(
            bundle.version, PROJECT_FILE_VERSION,
            "saved at the current PROJECT_FILE_VERSION (10 as of 72-12)"
        );
        assert_eq!(bundle.edit_log.len(), 1, "the edit-log is bundled");

        // load restores BOTH logs to a byte-identical Core, reaching head_tick — and
        // the spatial cell reconstructs from the snapshot with NO sidecar present.
        let load_dir = tempfile::tempdir().expect("fresh work_dir");
        let loaded = load_project(&path, load_dir.path(), Some(1)).expect("load v4");
        assert_eq!(loaded.core().tick, host.core().tick, "loaded reaches head_tick");
        assert_eq!(
            loaded.logged_edits().expect("edits").len(),
            1,
            "v4 load restores the edit-log"
        );
        assert_eq!(
            loaded.core().state.cell_of(placed),
            Some((7, 7)),
            "v4 load reconstructs the spatial cell from the snapshot (no sidecar)"
        );
        assert_eq!(
            loaded.snapshot_bytes(),
            host.snapshot_bytes(),
            "both logs replayed to a byte-identical Core"
        );
    }

    #[test]
    fn old_bundle_refused_as_too_old() {
        // SPAT-01 clean break: the pre-v4 migration shims are DROPPED, so an older
        // (v1/v2/v3) bundle is refused UP FRONT with a typed TooOld error — never
        // migrated, never a panic. The version is peeked from the leading varint
        // before any shape is committed, so even a truncated/old-shape bundle is a
        // clean typed refusal.
        let (dir, host, _source) = quiesced_host(Some(1));
        let (_base, snapshot) = host
            .latest_persisted_snapshot()
            .expect("read persisted snapshot")
            .expect("a base snapshot was persisted");
        // Forge a v3-versioned bundle (the immediately-prior shape would have carried
        // a `layout` field; we only need the leading version varint to read as 3 for
        // the peek-and-refuse path).
        let bundle = ProjectFile {
            version: 3, // an OLD version, below PROJECT_FILE_VERSION (now 10) and below
            // both named boundary constants, so it takes the GENERIC too-old arm
            head_tick: host.core().tick,
            snapshot,
            log: host.logged_events().expect("logged events"),
            edit_log: Vec::new(),
        };
        let path = dir.path().join("v3_old.fab");
        std::fs::write(&path, postcard::to_allocvec(&bundle).expect("encode")).expect("write");

        let load_dir = tempfile::tempdir().expect("fresh work_dir");
        let result = load_project(&path, load_dir.path(), Some(1));
        assert!(
            matches!(
                result,
                Err(ProjectError::TooOld { found, expected })
                    if found == 3 && expected == PROJECT_FILE_VERSION
            ),
            "a pre-v4 bundle must be refused with a typed TooOld error (no migration, no panic)"
        );
        assert!(
            !load_dir.path().join("log.redb").exists(),
            "a refused too-old bundle must not hydrate the fresh store"
        );
    }

    #[test]
    fn a_pre_phase_72_v8_bundle_is_refused_as_the_typed_generic_too_old() {
        // R-78 / D-23, the ONE consequence of plan 72-12's SNAPSHOT 10 -> 11 bump that a
        // user can see: every `.fab` written before Phase 72 stops loading, and that is
        // the intended outcome rather than a cost to mitigate. `Node::Endpoint` gained a
        // serialized path (SERVE-08), so a v10 body is SHORT by that length-prefixed
        // string and there is no honest way to read it. Pre-v1 CLEAN BREAK, no upcast
        // shim: a migration would have to invent a path for every saved Route.
        //
        // WHAT THIS TEST IS ACTUALLY FOR, because "an old file is refused" is not the
        // interesting half. The refusal must be the TYPED envelope one, so the user is
        // told "this save predates a schema change" in words the host already wrote. Left
        // at 8, the envelope would have admitted the bundle and the failure would have
        // surfaced two layers deeper as `DecodeError::Malformed` - the most
        // corruption-shaped error this decoder has - about a file that is byte-for-byte
        // intact. That is the exact substitution D-14 named as unacceptable at Phase 62
        // and it would have been reintroduced here.
        //
        // v8 takes the GENERIC arm and earns no dedicated variant, which is the one row
        // the four-way table on `PROJECT_FILE_VERSION` changed: the too-old set is no
        // longer contiguous below the named arms, since v8 is generic while v7 and v6
        // keep their named ones. This test is what makes that claim checkable.
        let (dir, host, _source) = quiesced_host(Some(1));
        let (_base, snapshot) = host
            .latest_persisted_snapshot()
            .expect("read persisted snapshot")
            .expect("a base snapshot was persisted");
        let bundle = ProjectFile {
            // The LAST pre-Phase-72 envelope version, written as a literal rather than as
            // `PROJECT_FILE_VERSION - 1`: the fact is historical and stays true at every
            // future value, exactly as the two named boundary constants argue for
            // themselves. Derived, this test would re-point on the next bump and stop
            // being a witness to this one.
            version: 8,
            head_tick: host.core().tick,
            snapshot,
            log: host.logged_events().expect("logged events"),
            edit_log: Vec::new(),
        };
        let path = dir.path().join("v8_pre_route_path.fab");
        std::fs::write(&path, postcard::to_allocvec(&bundle).expect("encode")).expect("write");

        let load_dir = tempfile::tempdir().expect("fresh work_dir");
        // `Host` is not `Debug`, so discard the Ok payload to report the error side -
        // the same shape `snapshot.rs`'s frozen-version witnesses use.
        let result = load_project(&path, load_dir.path(), Some(1)).map(|_| ());
        assert!(
            matches!(
                result,
                Err(ProjectError::TooOld { found, expected })
                    if found == 8 && expected == PROJECT_FILE_VERSION
            ),
            "a pre-Phase-72 v8 bundle must be refused with the typed generic TooOld at the \
             envelope, NOT with a corruption-shaped Malformed from the short inner body: \
             got {result:?}"
        );
        assert!(
            !load_dir.path().join("log.redb").exists(),
            "a refused too-old bundle must not hydrate the fresh store"
        );
    }

    /// The FROZEN v11 witness (plan 85-09, D-07, DEMO-03). A real `.fab` saved by the build
    /// at the phase's start revision: the shipped demo board, booted the way
    /// that build's dev host booted it, ticked to quiescence and written by that build's own
    /// `save_project`. Its sha256 and the capture are recorded in `85-EVIDENCE.md`.
    ///
    /// Frozen BYTES rather than a struct literal, because the v12 `ProjectFile` cannot
    /// express a v11 bundle: the v11 shape carried a field v12 removed, so a literal built
    /// here would be a v12 body with an 11 written in front of it, a witness to nothing.
    /// The same file is opened on screen by `85-v11-file-refused.live.spec.ts`.
    const V11_DEMO_BOARD: &[u8] = include_bytes!("../tests/fixtures/v11-demo-board.fab");

    #[test]
    fn a_file_saved_by_the_v11_build_is_refused_naming_11_and_13() {
        assert_eq!(V11_DEMO_BOARD.first(), Some(&11u8), "the witness's envelope varint reads 11");
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("v11-demo-board.fab");
        std::fs::write(&path, V11_DEMO_BOARD).expect("write the witness");

        let load_dir = tempfile::tempdir().expect("fresh work_dir");
        let result = load_project(&path, load_dir.path(), Some(1)).map(|_| ());
        // Both numbers are literals: the file's version is a historical fact, and 13 is the
        // version this build reads (moved by hand from 12 by plan 87-03's lockstep bump).
        // Derived from the constant, the test would re-point silently on the next bump.
        assert!(
            matches!(result, Err(ProjectError::TooOld { found: 11, expected: 13 })),
            "a file saved by the v11 build must be refused whole as TooOld {{ found: 11, \
             expected: 13 }} at the envelope, before any decode: got {result:?}"
        );
        assert!(
            !load_dir.path().join("log.redb").exists(),
            "a refused v11 file must not hydrate the fresh store"
        );
        let shown = result.expect_err("refused").to_string();
        assert!(
            shown.contains("11") && shown.contains("v13"),
            "the sentence the user reads names both versions: {shown}"
        );
    }

    /// The accepted side of the v13 boundary (plan 87-03, moved from the v12 one plan 85-09
    /// wrote): a board saved by this build is stamped 13 in its first byte and opens back to
    /// the same core and logs.
    #[test]
    fn a_v13_bundle_round_trips() {
        let (dir, mut host, _source) = quiesced_host(Some(1));
        host.enqueue_edit(place_edit(0, 7, 7));
        let (cmd_tx, _cmd_rx) = unbounded_channel::<Command>();
        let (_res_tx, mut res_rx) = unbounded_channel::<ResultEvent>();
        let (_ing_tx, mut ing_rx) = unbounded_channel::<EventPayload>();
        host.tick_once(&mut ing_rx, &mut res_rx, &cmd_tx)
            .expect("fold the edit");

        let path = dir.path().join("v13.fab");
        save_project(&host, &path).expect("save");
        let bytes = std::fs::read(&path).expect("read");
        // A literal, for the reason the v11 witness gives.
        assert_eq!(bytes.first(), Some(&13u8), "the envelope varint reads 13");
        let bundle: ProjectFile = postcard::from_bytes(&bytes).expect("decode v13");
        assert_eq!(bundle.version, 13, "stamped with the v13 envelope");

        let load_dir = tempfile::tempdir().expect("fresh work_dir");
        let loaded = load_project(&path, load_dir.path(), Some(1)).expect("open v13");
        assert_eq!(loaded.core().tick, host.core().tick, "reopened at the saved tick");
        assert_eq!(
            loaded.logged_edits().expect("edits"),
            host.logged_edits().expect("edits"),
            "the edit log came back record for record"
        );
        assert_eq!(
            loaded.snapshot_bytes(),
            host.snapshot_bytes(),
            "both logs replayed to a byte-identical core"
        );
        // And the reopened board saves back to the same bytes.
        let again = dir.path().join("v13-again.fab");
        save_project(&loaded, &again).expect("save the reopened board");
        assert_eq!(std::fs::read(&again).expect("read"), bytes, "save, open, save is stable");
    }

    /// The forward side of the v13 boundary: an envelope reading 14 is refused before any
    /// decode, and nothing is hydrated.
    #[test]
    fn a_v14_envelope_is_refused_as_unknown_version() {
        let (dir, host, _source) = quiesced_host(Some(1));
        let (_base, snapshot) = host
            .latest_persisted_snapshot()
            .expect("read persisted snapshot")
            .expect("a base snapshot was persisted");
        let bundle = ProjectFile {
            version: 14,
            head_tick: host.core().tick,
            snapshot,
            log: host.logged_events().expect("logged events"),
            edit_log: Vec::new(),
        };
        let path = dir.path().join("v14.fab");
        std::fs::write(&path, postcard::to_allocvec(&bundle).expect("encode")).expect("write");

        let load_dir = tempfile::tempdir().expect("fresh work_dir");
        let result = load_project(&path, load_dir.path(), Some(1)).map(|_| ());
        assert!(
            matches!(result, Err(ProjectError::UnknownVersion(14))),
            "a v14 envelope is UnknownVersion(14): got {result:?}"
        );
        assert!(
            !load_dir.path().join("log.redb").exists(),
            "a refused forward bundle must not hydrate the fresh store"
        );
    }

    /// The empty edge (DEMO-03): a file too short to hold its own version varint is
    /// `Malformed`, never `TooOld` and never a panic. Three shapes: no bytes at all; one
    /// byte with the varint's continuation bit set, which promises a second byte that is
    /// not there; and one byte that is a complete version 13 (this build's) with no body
    /// behind it.
    #[test]
    fn a_file_shorter_than_its_version_is_refused_as_malformed() {
        let dir = tempfile::tempdir().expect("tempdir");
        let shapes: [(&str, &[u8]); 3] = [
            ("empty", &[]),
            ("varint_cut_short", &[0x8C]),
            ("version_without_body", &[13]),
        ];
        for (name, bytes) in shapes {
            let path = dir.path().join(format!("{name}.fab"));
            std::fs::write(&path, bytes).expect("write");
            let load_dir = tempfile::tempdir().expect("fresh work_dir");
            let result = load_project(&path, load_dir.path(), Some(1)).map(|_| ());
            assert!(
                matches!(result, Err(ProjectError::Malformed)),
                "a '{name}' file is Malformed: got {result:?}"
            );
            assert!(
                !load_dir.path().join("log.redb").exists(),
                "a '{name}' file must not hydrate the fresh store"
            );
        }
    }

    // ── Plan 85-06 (D-10, DEMO-05, UNDO-07, T-85-14): the undo floor across Save and Open ──

    /// A host at the demo genesis seed over a temp store, no timers (so it is quiescent
    /// and a save is legal), with its throwaway tick channels.
    fn floor_host() -> (tempfile::TempDir, Host) {
        let dir = tempfile::tempdir().expect("tempdir");
        let core = Core::genesis(LogHeader {
            schema_version: SCHEMA_VERSION,
            seed: crate::demo_scene::DEMO_GENESIS_SEED,
        });
        let store = RedbStore::open(dir.path().join("log.redb")).expect("open log");
        let ledger = DispatchLedger::open(dir.path().join("ledger.redb")).expect("open ledger");
        let host = Host::new(core, store, ledger, None).expect("open host");
        (dir, host)
    }

    /// Apply one gesture through the certified live path and fold it in one tick.
    fn gesture_and_tick(host: &mut Host, cmd: fabrico_protocol::GridCommand) {
        crate::input_apply::apply_gesture(host, cmd, |_| None).expect("the gesture is accepted");
        let (_ing_tx, mut ing_rx) = unbounded_channel::<EventPayload>();
        let (cmd_tx, _cmd_rx) = unbounded_channel::<Command>();
        let (_res_tx, mut res_rx) = unbounded_channel::<ResultEvent>();
        host.tick_once(&mut ing_rx, &mut res_rx, &cmd_tx).expect("tick");
    }

    /// A user's Place of a Source at `(x, y)`.
    fn user_place(x: i32, y: i32) -> fabrico_protocol::GridCommand {
        fabrico_protocol::GridCommand::Place {
            kind: fabrico_protocol::machine_kind::SOURCE,
            cell_x: x,
            cell_y: y,
        }
    }

    /// Save `host` to `name` in `dir` and read the real bundle back off disk.
    fn saved_bundle(host: &Host, dir: &Path, name: &str) -> ProjectFile {
        let path = dir.join(name);
        save_project(host, &path).expect("save the sealed board");
        postcard::from_bytes(&std::fs::read(&path).expect("read the saved file")).expect("decode the saved bundle")
    }

    /// Append ONE forged `Undo` marker naming `target_action` to a real saved bundle, as a
    /// careful hand edit would: a fresh action, the next sequence, stamped at the saved head
    /// tick and the head moved on by the one tick it folds in, so every OTHER load check
    /// (the head-tick agreement included) passes and only the undo floor can refuse it.
    fn write_forged_undo(mut bundle: ProjectFile, target_action: u64, path: &Path) {
        let last = bundle.edit_log.last().cloned().expect("the saved board has an edit log");
        let action = bundle.edit_log.iter().map(|r| r.action).max().unwrap_or(0) + 1;
        bundle.edit_log.push(EditRecord {
            schema_version: fabrico_core::edit::EDIT_SCHEMA_VERSION,
            partition: last.partition,
            sequence: last.sequence + 1,
            tick: bundle.head_tick,
            action,
            op: EditOp::Undo { target_action },
        });
        bundle.head_tick += 1;
        std::fs::write(path, postcard::to_allocvec(&bundle).expect("encode")).expect("write the forged file");
    }

    /// The action id of the bundle's first `Place` (the sealed scene command).
    fn first_place_action(bundle: &ProjectFile) -> u64 {
        bundle
            .edit_log
            .iter()
            .find(|r| matches!(r.op, EditOp::Place { .. }))
            .expect("the scene placed a machine")
            .action
    }

    #[test]
    fn a_forged_undo_below_the_seal_is_refused_as_undo_floor_breached() {
        // [Place, SealHistory, Undo(target = the Place)]: the scene of one command, sealed
        // by the production seeding function, saved for real, then one hand-written Undo of
        // the sealed Place appended. The cursor falls under the floor.
        let (dir, mut host) = floor_host();
        crate::demo_scene::seed_scene(&mut host, &[user_place(0, 0)]).expect("seed a one-command scene");
        assert!(!host.can_undo(), "non-vacuity: the sealed scene has nothing to undo");
        let bundle = saved_bundle(&host, dir.path(), "sealed.fab");
        assert!(
            bundle.edit_log.iter().any(|r| matches!(r.op, EditOp::SealHistory)),
            "non-vacuity: the saved log carries the seal"
        );
        let honest_dir = tempfile::tempdir().expect("work_dir");
        assert!(
            load_project(&dir.path().join("sealed.fab"), honest_dir.path(), None).is_ok(),
            "non-vacuity: the honest sealed file opens"
        );

        let target = first_place_action(&bundle);
        let forged = dir.path().join("forged-below.fab");
        write_forged_undo(bundle, target, &forged);
        let load_dir = tempfile::tempdir().expect("work_dir");
        let result = load_project(&forged, load_dir.path(), None).map(|_| ());
        assert!(
            matches!(result, Err(ProjectError::UndoFloorBreached { floor: 1, cursor: 0 })),
            "an Undo of a sealed scene command is refused naming floor 1 and cursor 0: got {result:?}"
        );
    }

    #[test]
    fn a_forged_undo_under_the_floor_behind_a_later_action_is_refused_as_undo_floor_breached() {
        // [Place A, SealHistory, Place B, Undo(target = A)]: the user's later Place B keeps
        // the cursor at the floor, so only the Undo marker's target position shows the reach
        // under the seal. Still refused.
        let (dir, mut host) = floor_host();
        crate::demo_scene::seed_scene(&mut host, &[user_place(0, 0)]).expect("seed a one-command scene");
        gesture_and_tick(&mut host, user_place(4, 0));
        assert!(host.can_undo(), "non-vacuity: the user's Place B is undoable");
        let bundle = saved_bundle(&host, dir.path(), "sealed-plus-b.fab");
        let target = first_place_action(&bundle);
        let forged = dir.path().join("forged-behind.fab");
        write_forged_undo(bundle, target, &forged);
        let load_dir = tempfile::tempdir().expect("work_dir");
        let result = load_project(&forged, load_dir.path(), None).map(|_| ());
        assert!(
            matches!(result, Err(ProjectError::UndoFloorBreached { floor: 1, cursor: 1 })),
            "an Undo naming an action under the floor is refused even with the cursor at the \
             floor: got {result:?}"
        );
    }

    // ── Plan 86-07 (D-08, WORK-09, T-86-18 to T-86-20): a forged label connection ─────
    //
    // A label is a note and never connects. Every gesture that would give one a port, dock a
    // belt to one or draw a cable to or from one is refused (`LabelDoesNotConnect`), so only
    // a hand-edited file carries one. Each leg below saves a REAL board built through
    // `apply_gesture` (a Source, a belt docked to it, a Sink and a label), proves the honest
    // file opens, then appends ONE forged record in the `write_forged_undo` shape and requires
    // the load refused as `LabelConnected`. The last leg forges the SNAPSHOT instead.
    //
    // RED BEFORE THE CHANGE (plan 86-07 task 2, `shapes-red.out`): every Dock, cable and
    // snapshot leg OPENED (the fold linked the label; the snapshot gate had no label rule).
    // The AddPort leg was already green there: task 1 landed its fold guard and the forged
    // file test that saw it red.

    /// The label board's cells: a Source, a three-tile belt east of it, a Sink, and a label
    /// on the row below the belt, clear of every other cell.
    const LC_SOURCE: (i32, i32) = (0, 0);
    const LC_BELT: [(i32, i32); 3] = [(1, 0), (2, 0), (3, 0)];
    const LC_SINK: (i32, i32) = (4, 0);
    const LC_LABEL: (i32, i32) = (1, 2);

    /// The ids a forged record names on the label board.
    struct LabelBoard {
        dir: tempfile::TempDir,
        host: Host,
        label: NodeId,
        belt: NodeId,
        source: NodeId,
        sink: NodeId,
    }

    /// The id holding `cell` on `host`.
    fn id_at(host: &Host, cell: (i32, i32)) -> NodeId {
        host.core().state.occupied(cell).unwrap_or_else(|| panic!("measured: a node holds {cell:?}"))
    }

    /// A real board built only through `apply_gesture`, so every id in its edit log is the
    /// id the load's re-fold from genesis mints too.
    fn label_board() -> LabelBoard {
        use fabrico_protocol::{GridCommand, machine_kind};
        let (dir, mut host) = floor_host();
        gesture_and_tick(&mut host, GridCommand::Place { kind: machine_kind::SOURCE, cell_x: LC_SOURCE.0, cell_y: LC_SOURCE.1 });
        gesture_and_tick(&mut host, GridCommand::DrawBelt { cells: LC_BELT.to_vec() });
        gesture_and_tick(&mut host, GridCommand::Place { kind: machine_kind::SINK, cell_x: LC_SINK.0, cell_y: LC_SINK.1 });
        gesture_and_tick(&mut host, GridCommand::Place { kind: machine_kind::LABEL, cell_x: LC_LABEL.0, cell_y: LC_LABEL.1 });
        let (label, belt, source, sink) = (id_at(&host, LC_LABEL), id_at(&host, LC_BELT[0]), id_at(&host, LC_SOURCE), id_at(&host, LC_SINK));
        assert!(
            matches!(host.core().state.node(label), Some(fabrico_core::state::Node::Label(_))),
            "measured: the node at {LC_LABEL:?} is a label"
        );
        assert!(
            matches!(host.core().state.node(belt), Some(fabrico_core::state::Node::Belt(_))),
            "measured: the node at {:?} is a belt",
            LC_BELT[0]
        );
        LabelBoard { dir, host, label, belt, source, sink }
    }

    /// Save `board`, prove the honest file opens, append ONE forged record carrying `op`
    /// (a fresh action, the next sequence, stamped at the saved head tick and the head moved
    /// on by the tick it folds in), and load the forged file.
    fn load_with_label_connect(board: &LabelBoard, op: EditOp) -> Result<(), ProjectError> {
        load_with_forged_records(board, vec![op])
    }

    /// [`load_with_label_connect`] for several forged records, each its own action and tick,
    /// in order.
    fn load_with_forged_records(board: &LabelBoard, ops: Vec<EditOp>) -> Result<(), ProjectError> {
        let honest = board.dir.path().join("label-board.fab");
        save_project(&board.host, &honest).expect("save the real label board");
        let honest_dir = tempfile::tempdir().expect("work_dir");
        assert!(
            load_project(&honest, honest_dir.path(), None).is_ok(),
            "non-vacuity: the honest label board opens"
        );
        let mut bundle: ProjectFile =
            postcard::from_bytes(&std::fs::read(&honest).expect("read the saved file")).expect("decode");
        for op in ops {
            let last = bundle.edit_log.last().cloned().expect("the saved board has an edit log");
            let action = bundle.edit_log.iter().map(|r| r.action).max().unwrap_or(0) + 1;
            bundle.edit_log.push(EditRecord {
                schema_version: fabrico_core::edit::EDIT_SCHEMA_VERSION,
                partition: last.partition,
                sequence: last.sequence + 1,
                tick: bundle.head_tick,
                action,
                op,
            });
            bundle.head_tick += 1;
        }
        let forged = board.dir.path().join("forged-label.fab");
        std::fs::write(&forged, postcard::to_allocvec(&bundle).expect("encode")).expect("write the forged file");
        let load_dir = tempfile::tempdir().expect("work_dir");
        load_project(&forged, load_dir.path(), None).map(|_| ())
    }

    /// The verdict a leg requires, spelled as text so every leg compiled, and was seen red,
    /// before the refusal reached its shape.
    fn verdict(result: Result<(), ProjectError>) -> String {
        match result {
            Ok(()) => "opened".to_owned(),
            Err(e) => format!("{e:?}"),
        }
    }

    #[test]
    fn a_forged_label_add_port_is_refused_as_label_connected() {
        let board = label_board();
        let op = EditOp::AddPort {
            node: board.label,
            port: fabrico_core::state::Port {
                local_offset: (0, 0),
                side: fabrico_core::state::Side::E,
                role: fabrico_core::state::Role::Out,
                medium: fabrico_core::state::Medium::Mechanical,
            },
            index: 0,
            seat: fabrico_core::edit::PortSeat::Auto,
        };
        assert_eq!(verdict(load_with_label_connect(&board, op)), "LabelConnected", "an AddPort on a label");
    }

    #[test]
    fn a_forged_label_dock_head_is_refused_as_label_connected() {
        let board = label_board();
        let op = EditOp::Dock { belt: board.belt, endpoint: fabrico_core::edit::BeltEnd::Head, node: board.label, port: 0 };
        assert_eq!(verdict(load_with_label_connect(&board, op)), "LabelConnected", "a belt's head docked into a label");
    }

    #[test]
    fn a_forged_label_dock_tail_is_refused_as_label_connected() {
        let board = label_board();
        let op = EditOp::Dock { belt: board.belt, endpoint: fabrico_core::edit::BeltEnd::Tail, node: board.label, port: 0 };
        assert_eq!(verdict(load_with_label_connect(&board, op)), "LabelConnected", "a belt's tail docked from a label");
    }

    #[test]
    fn a_forged_label_dock_on_its_fault_port_is_refused_as_label_connected() {
        let board = label_board();
        let op = EditOp::Dock {
            belt: board.belt,
            endpoint: fabrico_core::edit::BeltEnd::Tail,
            node: board.label,
            port: fabrico_core::fault::FAULT_PORT,
        };
        assert_eq!(verdict(load_with_label_connect(&board, op)), "LabelConnected", "a belt docked on a label's fault port");
    }

    /// A forged Dock that names the LABEL as its belt (phase 86 review, WR-03), Head into the
    /// Sink, followed by a forged Delete of the label. The Delete takes the link with it, so
    /// the board at the end of the replay holds no label link and the snapshot gate has
    /// nothing to see: only the fold's own refusal can refuse the file. Red until WR-03: the
    /// fold checked only the machine operand, linked the label into the Sink, and the file
    /// opened.
    #[test]
    fn a_forged_dock_naming_a_label_as_its_belt_is_refused_as_label_connected() {
        let board = label_board();
        let dock = EditOp::Dock { belt: board.label, endpoint: fabrico_core::edit::BeltEnd::Head, node: board.sink, port: 0 };
        let delete = EditOp::Delete {
            node: board.label,
            kind: fabrico_protocol::machine_kind::LABEL,
            cell_x: LC_LABEL.0,
            cell_y: LC_LABEL.1,
            captured: fabrico_core::edit::DeletedSubgraph::default(),
        };
        assert_eq!(
            verdict(load_with_forged_records(&board, vec![dock, delete])),
            "LabelConnected",
            "a label docked as a belt into a Sink, then deleted"
        );
    }

    #[test]
    fn a_forged_label_cable_from_it_is_refused_as_label_connected() {
        let board = label_board();
        let op = EditOp::DrawWire { from_node: board.label, from_port: 0, to_node: board.sink, to_port: 0 };
        assert_eq!(verdict(load_with_label_connect(&board, op)), "LabelConnected", "a cable from a label");
    }

    #[test]
    fn a_forged_label_cable_to_it_is_refused_as_label_connected() {
        let board = label_board();
        let op = EditOp::DrawWire { from_node: board.source, from_port: 0, to_node: board.label, to_port: 0 };
        assert_eq!(verdict(load_with_label_connect(&board, op)), "LabelConnected", "a cable to a label");
    }

    #[test]
    fn a_forged_snapshot_label_with_a_port_is_refused_as_label_connected() {
        // The SNAPSHOT is the forged part: the head snapshot of the real board with one port
        // set on the label. Its edit log is untouched, and the head snapshot as the base means
        // no record replays after it, so only the snapshot gate can refuse it.
        let board = label_board();
        let path = board.dir.path().join("snapshot-label.fab");
        let mut bundle = ProjectFile {
            version: PROJECT_FILE_VERSION,
            head_tick: board.host.core().tick,
            snapshot: board.host.snapshot_bytes(),
            log: board.host.logged_events().expect("logged events"),
            edit_log: board.host.logged_edits().expect("logged edits"),
        };
        std::fs::write(&path, postcard::to_allocvec(&bundle).expect("encode")).expect("write");
        let honest_dir = tempfile::tempdir().expect("work_dir");
        assert!(
            load_project(&path, honest_dir.path(), None).is_ok(),
            "non-vacuity: the board with its own head snapshot opens"
        );
        let mut core = fabrico_core::snapshot::restore(&bundle.snapshot).expect("the real snapshot restores");
        core.state.set_ports(
            board.label,
            vec![fabrico_core::state::Port {
                local_offset: (0, 0),
                side: fabrico_core::state::Side::E,
                role: fabrico_core::state::Role::Out,
                medium: fabrico_core::state::Medium::Mechanical,
            }],
        );
        bundle.snapshot = fabrico_core::snapshot::snapshot(&core);
        let (err, _load_dir) = load_forged(board.dir.path(), "forged-snapshot-label.fab", &bundle);
        assert_eq!(
            err.map_or_else(|| "opened".to_owned(), |e| format!("{e:?}")),
            "LabelConnected",
            "a snapshot whose label holds a port"
        );
    }

    #[test]
    fn a_saved_demo_board_keeps_its_floor_after_reopen() {
        // UNDO-07 with the floor: the shipped demo, edited once by the user, saved and
        // reopened. The user's edit is still undoable; one undo removes it; Undo is then
        // greyed at the scene's floor and a further Undo is refused.
        let (dir, mut host) = floor_host();
        crate::demo_scene::seed_scene(&mut host, &crate::demo_scene::demo_commands()).expect("seed the demo");
        let demo_nodes = host.core().state.node_count();
        let floor = host.session().undo_floor();
        assert!(floor > 0, "non-vacuity: the demo's commands sit under a floor");
        gesture_and_tick(&mut host, user_place(10, 12));
        assert_eq!(host.core().state.node_count(), demo_nodes + 1, "the user's Place folded");
        let path = dir.path().join("demo-plus-one.fab");
        save_project(&host, &path).expect("save the edited demo");

        let load_dir = tempfile::tempdir().expect("work_dir");
        let mut reopened = load_project(&path, load_dir.path(), None).expect("the edited demo reopens");
        assert_eq!(reopened.session().undo_floor(), floor, "the floor survives Save and Open");
        assert!(reopened.can_undo(), "the user's own edit is undoable after the reopen (UNDO-07)");
        gesture_and_tick(&mut reopened, fabrico_protocol::GridCommand::Undo);
        assert_eq!(reopened.core().state.node_count(), demo_nodes, "one undo removed the user's Source");
        assert!(reopened.core().state.occupied((10, 12)).is_none(), "the Source's cell is free again");
        assert!(!reopened.can_undo(), "Undo is greyed at the scene's floor");
        let refused = crate::input_apply::apply_gesture(&mut reopened, fabrico_protocol::GridCommand::Undo, |_| None);
        assert_eq!(
            refused,
            Err(fabrico_command::CommandError::NothingToUndo),
            "a further Undo is refused at the floor"
        );
    }

    #[test]
    fn v5_bundle_refused_as_generic_too_old_under_v8() {
        // v6.0 clean break (35-03): the coordinated PROJECT 5->6 bump (lock-stepped with
        // the byte-forced SNAPSHOT 7->8) means a v5 bundle is refused UP FRONT with a
        // typed generic `TooOld`, never migrated, never a panic. The version is peeked
        // from the leading varint before any shape is committed, so even a v5-shaped
        // bundle is a clean typed refusal at the single O(1) envelope gate (no per-log
        // too-old arm needed, RESEARCH A1).
        //
        // The stale `{ found: 5, expected: 6 }` this comment and the assert message used
        // to spell out is corrected in place (60-03): `expected` is PROJECT_FILE_VERSION,
        // now 8. v5 is two versions below the oldest NAMED arm, which is what keeps this the
        // generic-arm edge rather than a duplicate of the v6 or v7 cases below. The test is
        // renamed on each bump rather than left asserting a version its own name denies.
        let (dir, host, _source) = quiesced_host(Some(1));
        let (_base, snapshot) = host
            .latest_persisted_snapshot()
            .expect("read persisted snapshot")
            .expect("a base snapshot was persisted");
        let bundle = ProjectFile {
            version: 5, // an OLD version, below PROJECT_FILE_VERSION (now 10) and below
            // both named boundary constants, so it takes the GENERIC too-old arm
            head_tick: host.core().tick,
            snapshot,
            log: host.logged_events().expect("logged events"),
            edit_log: Vec::new(),
        };
        let path = dir.path().join("v5_old.fab");
        std::fs::write(&path, postcard::to_allocvec(&bundle).expect("encode")).expect("write");

        let load_dir = tempfile::tempdir().expect("fresh work_dir");
        let result = load_project(&path, load_dir.path(), Some(1));
        assert!(
            matches!(
                result,
                Err(ProjectError::TooOld { found, expected })
                    if found == 5 && expected == PROJECT_FILE_VERSION
            ),
            "a v5 bundle must be refused with the GENERIC typed TooOld \
             {{ found: 5, expected: PROJECT_FILE_VERSION }}"
        );
        assert!(
            !load_dir.path().join("log.redb").exists(),
            "a refused too-old bundle must not hydrate the fresh store"
        );
    }

    /// The SAME unreproducible pre-change snapshot blob the core-side frozen witness
    /// embeds (`fabrico_core::snapshot`'s
    /// `frozen_v8_belt_snapshot_is_refused_as_snapshot_too_old_under_v9`), captured ONCE at
    /// `PHASE_60_BASE` (the pre-release tree phase 60 started from) from a real belt-bearing
    /// `Core` while `SLOTS_PER_TILE` was still 3. A 2-tile belt with a 6-entry slot vector
    /// under an `08 00` tag. See `60-CORPUS-REVIEW.md` Stage 0.
    ///
    /// It is duplicated here rather than imported because it is frozen on BOTH sides and
    /// neither copy is ever regenerated; the shape/length/tag assertions in both witnesses
    /// redden immediately if either paste drifts. Importing it would also make the host
    /// witness depend on a core TEST-module private, which does not cross the crate line.
    const FROZEN_V8_BELT_SNAPSHOT: &[u8] = &[
        0x08, 0x00, 0x00, 0x04, 0x00, 0x00, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x03, 0x01,
        0x01, 0x00, 0x00, 0x02, 0x01, 0x01, 0x02, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x03, 0x01, 0x00, 0x00, 0x03, 0x01, 0x01, 0x00, 0x02, 0x01, 0x00, 0x03, 0x01,
        0x00, 0x02, 0x01, 0x01, 0x00, 0x02, 0x01, 0x00, 0x02, 0x01, 0x00, 0x03, 0x01, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x38, 0x3B, 0xF2, 0xC3, 0x35, 0x90, 0x8C, 0xDF, 0x0C,
        0xD2, 0xC3, 0x0C, 0x8F, 0x2F, 0xFF, 0xC9, 0x96, 0x35, 0x14, 0x29, 0x52, 0x51, 0x51,
        0x93, 0x08, 0x19, 0x65, 0x34, 0x15, 0x82, 0x93, 0xE4, 0x00, 0x00, 0x00,
    ];

    #[test]
    fn frozen_pre_slot_change_bundle_is_refused_with_the_slot_change_named() {
        // The host-side frozen witness (60-03, D-02/D-05). A REAL pre-change board, wrapped
        // at the envelope version it would genuinely have carried, must be refused with the
        // dedicated `SlotModelChanged` and a message that TELLS THE USER WHAT HAPPENED.
        //
        // Why the blob matters even though the envelope gate never decodes it: a witness
        // built on a synthetic snapshot would assert only that the code agrees with itself
        // (T-60-12). These bytes came off a tree that no longer exists.
        assert_eq!(FROZEN_V8_BELT_SNAPSHOT.len(), 96, "the captured blob is 96 bytes");
        assert_eq!(
            &FROZEN_V8_BELT_SNAPSHOT[0..2],
            &[0x08, 0x00],
            "the captured blob carries a genuine pre-bump little-endian snapshot tag of 8"
        );
        assert_eq!(
            FROZEN_V8_BELT_SNAPSHOT[21], 0x06,
            "byte 21 is the 6-entry (3 slots x 2 tiles) slot vector, the witnessing byte"
        );

        let (dir, host, _source) = quiesced_host(Some(1));
        let bundle = ProjectFile {
            version: PRE_SLOT_CHANGE_PROJECT_VERSION,
            head_tick: host.core().tick,
            snapshot: FROZEN_V8_BELT_SNAPSHOT.to_vec(),
            log: host.logged_events().expect("logged events"),
            edit_log: Vec::new(),
        };
        let path = dir.path().join("pre_slot_change.fab");
        std::fs::write(&path, postcard::to_allocvec(&bundle).expect("encode")).expect("write");

        let load_dir = tempfile::tempdir().expect("fresh work_dir");
        let result = load_project(&path, load_dir.path(), Some(1));
        assert!(
            matches!(
                result,
                Err(ProjectError::SlotModelChanged { found })
                    if found == PRE_SLOT_CHANGE_PROJECT_VERSION
            ),
            "a pre-slot-change bundle must be refused with SlotModelChanged carrying the found version"
        );
        assert!(
            !load_dir.path().join("log.redb").exists(),
            "a refused pre-slot-change bundle must not hydrate the fresh store"
        );

        // Assert on the CONTENT of the rendered message, never on the exact sentence: the
        // wording is discretionary (D-05) and improving it must not redden a gate that is
        // really about the message being informative. What is NOT discretionary is that it
        // names the cause, denies corruption, and gives the reason no migration exists.
        let rendered = format!(
            "{}",
            ProjectError::SlotModelChanged {
                found: PRE_SLOT_CHANGE_PROJECT_VERSION
            }
        );
        let lower = rendered.to_lowercase();
        assert!(
            lower.contains("belt") && lower.contains("slot"),
            "the refusal must NAME the belt slot change as the cause, got: {rendered}"
        );
        assert!(
            lower.contains("not corrupt"),
            "the refusal must say plainly that the file is not corrupt, got: {rendered}"
        );
        assert!(
            lower.contains("migration") || lower.contains("migrat"),
            "the refusal must say why there is no migration, got: {rendered}"
        );
        assert!(
            lower.contains("never saved") || lower.contains("silently resume"),
            "the refusal must give the correctness reason (a padded board resumes in a state \
             that was never saved), got: {rendered}"
        );
        assert!(
            rendered.contains(&format!("v{PRE_SLOT_CHANGE_PROJECT_VERSION}"))
                && rendered.contains(&format!("v{PROJECT_FILE_VERSION}")),
            "the refusal must carry both the found and the readable version, got: {rendered}"
        );

        // The layering, demonstrated rather than described, and the host-side mirror of the
        // core witness's re-tagged assertion. Stamp the SAME frozen blob into a CURRENT-
        // version envelope so the envelope gate waves it through: the failure then lands
        // deeper, on the inner snapshot tag, as `InvalidSnapshot(SnapshotTooOld(8))`. That
        // is the deferred, corruption-shaped class of error the O(1) envelope refusal above
        // now fires ahead of (60-02's bump made it fire; 60-03 made it say why).
        let deferred = ProjectFile {
            version: PROJECT_FILE_VERSION,
            head_tick: host.core().tick,
            snapshot: FROZEN_V8_BELT_SNAPSHOT.to_vec(),
            log: host.logged_events().expect("logged events"),
            edit_log: Vec::new(),
        };
        let deferred_path = dir.path().join("stale_snapshot_current_envelope.fab");
        std::fs::write(
            &deferred_path,
            postcard::to_allocvec(&deferred).expect("encode"),
        )
        .expect("write");
        let deferred_dir = tempfile::tempdir().expect("fresh work_dir");
        assert!(
            matches!(
                load_project(&deferred_path, deferred_dir.path(), Some(1)),
                Err(ProjectError::InvalidSnapshot(
                    fabrico_core::event::DecodeError::SnapshotTooOld(8)
                ))
            ),
            "without the envelope refusal, the same bytes surface as a DEFERRED inner \
             snapshot error rather than an honest named one"
        );
    }

    /// The SAME unreproducible pre-change snapshot blob the core-side frozen witness
    /// embeds (`fabrico_core::snapshot`'s
    /// `frozen_v9_belt_snapshot_is_refused_as_snapshot_too_old_under_v10`). These 102
    /// bytes are the committed golden fixture
    /// `crates/fabrico-core/tests/golden/0001-source-belt-collector/genesis.snapshot`,
    /// read at the tree plan 62-05 left behind, i.e. BEFORE this plan's bump: a
    /// belt-bearing `Core` under an `09 00` tag whose belt carries NO `ticks_per_slot`.
    ///
    /// It is duplicated here rather than imported for the reason the v8 pair gives: it is
    /// frozen on BOTH sides, neither copy is ever regenerated, and the shape/length/tag
    /// assertions in both witnesses redden immediately if either paste drifts. It is also
    /// pasted rather than `include_bytes!`d off the live fixture because plan 62-09
    /// RE-BLESSES that fixture, and a live embed would silently re-point at a v10 blob.
    const FROZEN_V9_BELT_SNAPSHOT: &[u8] = &[
        0x09, 0x00, 0x00, 0x04, 0x00, 0x00, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x03, 0x01,
        0x01, 0x00, 0x00, 0x02, 0x01, 0x01, 0x03, 0x0C, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0x01, 0x00, 0x00, 0x03, 0x01, 0x01,
        0x00, 0x02, 0x01, 0x00, 0x03, 0x01, 0x00, 0x02, 0x01, 0x01, 0x00, 0x02, 0x01, 0x00,
        0x02, 0x01, 0x00, 0x03, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0xA6, 0xA9,
        0x02, 0x3B, 0x06, 0x47, 0x92, 0x39, 0xFE, 0xB5, 0x3C, 0xA7, 0xB0, 0xEC, 0xD0, 0x04,
        0xDD, 0x1E, 0x1F, 0x40, 0x66, 0x05, 0x62, 0xA8, 0xD2, 0xF1, 0x73, 0xB3, 0xA5, 0x04,
        0x9E, 0x00, 0x00, 0x00,
    ];

    #[test]
    fn frozen_pre_speed_change_bundle_is_refused_with_the_speed_change_named() {
        // The host-side frozen witness (62-06, D-14), mirroring the Phase 60 one above. A
        // REAL pre-change board, wrapped at the envelope version it would genuinely have
        // carried, must be refused with the dedicated `BeltSpeedModelChanged` and a message
        // that TELLS THE USER WHAT HAPPENED.
        //
        // Why the blob matters even though the envelope gate never decodes it: a witness
        // built on a synthetic snapshot would assert only that the code agrees with itself
        // (T-60-12). These bytes came off the corpus as it stood before this plan.
        assert_eq!(
            FROZEN_V9_BELT_SNAPSHOT.len(),
            102,
            "the captured blob is 102 bytes"
        );
        assert_eq!(
            &FROZEN_V9_BELT_SNAPSHOT[0..2],
            &[0x09, 0x00],
            "the captured blob carries a genuine pre-bump little-endian snapshot tag of 9"
        );
        assert_eq!(
            FROZEN_V9_BELT_SNAPSHOT[21], 0x0C,
            "byte 21 is the 12-entry (4 slots x 3 tiles) slot vector, the witnessing byte"
        );

        let (dir, host, _source) = quiesced_host(Some(1));
        let bundle = ProjectFile {
            version: PRE_SPEED_CHANGE_PROJECT_VERSION,
            head_tick: host.core().tick,
            snapshot: FROZEN_V9_BELT_SNAPSHOT.to_vec(),
            log: host.logged_events().expect("logged events"),
            edit_log: Vec::new(),
        };
        let path = dir.path().join("pre_speed_change.fab");
        std::fs::write(&path, postcard::to_allocvec(&bundle).expect("encode")).expect("write");

        let load_dir = tempfile::tempdir().expect("fresh work_dir");
        // `Host` is not `Debug`, so discard the Ok payload to report the error side.
        let result = load_project(&path, load_dir.path(), Some(1)).map(|_| ());
        assert!(
            matches!(
                result,
                Err(ProjectError::BeltSpeedModelChanged { found })
                    if found == PRE_SPEED_CHANGE_PROJECT_VERSION
            ),
            "a pre-speed-change bundle must be refused with BeltSpeedModelChanged carrying \
             the found version, got: {result:?}"
        );
        assert!(
            !load_dir.path().join("log.redb").exists(),
            "a refused pre-speed-change bundle must not hydrate the fresh store"
        );

        // Assert on the CONTENT of the rendered message, never on the exact sentence: the
        // wording is discretionary and improving it must not redden a gate that is really
        // about the message being informative. What is NOT discretionary is that it names
        // the cause AS A SHAPE CHANGE, denies corruption, gives the reason no migration
        // exists, stays traceable to 62-CONTEXT.md, and carries no interval value.
        let rendered = format!(
            "{}",
            ProjectError::BeltSpeedModelChanged {
                found: PRE_SPEED_CHANGE_PROJECT_VERSION
            }
        );
        let lower = rendered.to_lowercase();
        assert!(
            lower.contains("belt") && lower.contains("advance interval"),
            "the refusal must NAME the per-belt advance interval as the cause, got: {rendered}"
        );
        assert!(
            lower.contains("not corrupt"),
            "the refusal must say plainly that the file is not corrupt, got: {rendered}"
        );
        assert!(
            lower.contains("migration"),
            "the refusal must say why there is no migration, got: {rendered}"
        );
        assert!(
            lower.contains("never re-timed") || lower.contains("re-time"),
            "the refusal must give the correctness reason (a migrated board would be \
             re-timed by a choice its owner never made), got: {rendered}"
        );
        assert!(
            rendered.contains("SLOT-03") || rendered.contains("SLOT-04"),
            "the refusal must carry a requirement id so it is traceable, got: {rendered}"
        );
        assert!(
            rendered.contains("Phase 62"),
            "the refusal must name the phase so it is traceable to 62-CONTEXT.md, got: {rendered}"
        );
        assert!(
            rendered.contains(&format!("v{PRE_SPEED_CHANGE_PROJECT_VERSION}"))
                && rendered.contains(&format!("v{PROJECT_FILE_VERSION}")),
            "the refusal must carry both the found and the readable version, got: {rendered}"
        );

        // The message must remain true at EVERY future belt tier, which means it may not
        // state an advance interval. D-19 reserves the shipped value for the owner, and a
        // number here would restate itself at each tier. The check is on the SHAPE half of
        // the sentence: it says what a belt IS, never how fast one goes.
        assert!(
            !lower.contains("ticks per slot")
                && !lower.contains("ticks_per_slot")
                && !lower.contains("px/s")
                && !lower.contains("per second"),
            "the refusal must not state a rate or an interval value, got: {rendered}"
        );

        // THE O(1) ORDERING, PROVED RATHER THAN DESCRIBED. The whole claim of this variant
        // is that the version refusal fires at the OUTERMOST envelope gate, ahead of any
        // body decode, allocation or store access. Assert it on a bundle whose body past
        // the leading version varint is deliberate GARBAGE: if any body decode ran first
        // this would come back `Malformed`, so a pass is positive evidence about ORDER and
        // not merely about the arm. The version varint is written by postcard exactly as
        // the real encoder writes it, so the peek reads a genuine v7 envelope.
        let mut garbage = postcard::to_allocvec(&PRE_SPEED_CHANGE_PROJECT_VERSION)
            .expect("encode the leading version varint");
        assert_eq!(
            garbage.len(),
            1,
            "v7 is a single-byte postcard varint; the garbage below starts after it"
        );
        garbage.extend_from_slice(&[0xFF; 64]);
        let garbage_path = dir.path().join("pre_speed_change_garbage_body.fab");
        std::fs::write(&garbage_path, &garbage).expect("write");
        let garbage_dir = tempfile::tempdir().expect("fresh work_dir");
        let garbage_result = load_project(&garbage_path, garbage_dir.path(), Some(1)).map(|_| ());
        assert!(
            matches!(
                garbage_result,
                Err(ProjectError::BeltSpeedModelChanged { found })
                    if found == PRE_SPEED_CHANGE_PROJECT_VERSION
            ),
            "the version gate must refuse BEFORE any body decode: a v7 envelope with a \
             garbage body is still BeltSpeedModelChanged, not Malformed, got: {garbage_result:?}"
        );
        assert!(
            !garbage_dir.path().join("log.redb").exists(),
            "the O(1) refusal must not hydrate the fresh store"
        );

        // The layering, demonstrated rather than described, and the host-side mirror of the
        // core witness's re-tagged assertion. Stamp the SAME frozen blob into a CURRENT-
        // version envelope so the envelope gate waves it through: the failure then lands
        // deeper, on the inner snapshot tag, as `InvalidSnapshot(SnapshotTooOld(9))`. That
        // is the deferred class of error the O(1) envelope refusal above now fires ahead of.
        let deferred = ProjectFile {
            version: PROJECT_FILE_VERSION,
            head_tick: host.core().tick,
            snapshot: FROZEN_V9_BELT_SNAPSHOT.to_vec(),
            log: host.logged_events().expect("logged events"),
            edit_log: Vec::new(),
        };
        let deferred_path = dir.path().join("stale_v9_snapshot_current_envelope.fab");
        std::fs::write(
            &deferred_path,
            postcard::to_allocvec(&deferred).expect("encode"),
        )
        .expect("write");
        let deferred_dir = tempfile::tempdir().expect("fresh work_dir");
        assert!(
            matches!(
                load_project(&deferred_path, deferred_dir.path(), Some(1)),
                Err(ProjectError::InvalidSnapshot(
                    fabrico_core::event::DecodeError::SnapshotTooOld(9)
                ))
            ),
            "without the envelope refusal, the same bytes surface as a DEFERRED inner \
             snapshot error rather than an honest named one"
        );
    }

    #[test]
    fn the_five_version_boundary_edges_land_on_five_different_typed_errors() {
        // T-60-13 / T-62-02: splitting the too-old branch must not silently WIDEN the
        // accepted window. The whole boundary is walked in one place, and each of the five
        // edges is asserted to land on a DIFFERENT typed outcome. The individual tests above
        // carry the detail (store non-hydration, message content, pre-decode ordering); this
        // one exists so the boundary reads as a table and so a future edit that collapses
        // two arms into one reddens here even if every detail test still passes.
        //
        //   version 5 (older)             -> TooOld                 (the GENERIC arm)
        //   version 6 (pre-slot-change)   -> SlotModelChanged       (Phase 60's named arm)
        //   version 7 (pre-speed-change)  -> BeltSpeedModelChanged  (Phase 62's named arm)
        //   version 8 (current)           -> loads
        //   version 9 (forward)           -> UnknownVersion         (ahead of any body decode)
        //
        // Edge 1 is written as `PRE_SLOT_CHANGE_PROJECT_VERSION - 1` and NOT as
        // `PROJECT_FILE_VERSION - 3`: it must keep naming the version below the OLDEST named
        // arm, which is a fact about the slot boundary and not about the current version.
        let (dir, host, _source) = quiesced_host(Some(1));
        let (_base, snapshot) = host
            .latest_persisted_snapshot()
            .expect("read persisted snapshot")
            .expect("a base snapshot was persisted");
        let log = host.logged_events().expect("logged events");

        let write_at = |version: u16, snapshot: Vec<u8>| {
            let bundle = ProjectFile {
                version,
                head_tick: host.core().tick,
                snapshot,
                log: log.clone(),
                edit_log: Vec::new(),
                };
            let path = dir.path().join(format!("edge_v{version}.fab"));
            std::fs::write(&path, postcard::to_allocvec(&bundle).expect("encode")).expect("write");
            path
        };

        // Edge 1: older than the slot break. The generic arm, and this is the assertion
        // that keeps the generic error generic.
        let older = write_at(PRE_SLOT_CHANGE_PROJECT_VERSION - 1, snapshot.clone());
        let d1 = tempfile::tempdir().expect("fresh work_dir");
        assert!(
            matches!(
                load_project(&older, d1.path(), Some(1)),
                Err(ProjectError::TooOld { found, expected })
                    if found == PRE_SLOT_CHANGE_PROJECT_VERSION - 1
                        && expected == PROJECT_FILE_VERSION
            ),
            "an older bundle must keep the GENERIC TooOld, not inherit the slot message"
        );

        // Edge 2: the pre-slot-change version. The new named arm.
        let prior = write_at(PRE_SLOT_CHANGE_PROJECT_VERSION, snapshot.clone());
        let d2 = tempfile::tempdir().expect("fresh work_dir");
        assert!(
            matches!(
                load_project(&prior, d2.path(), Some(1)),
                Err(ProjectError::SlotModelChanged { found })
                    if found == PRE_SLOT_CHANGE_PROJECT_VERSION
            ),
            "the pre-slot-change bundle must get the SlotModelChanged arm"
        );

        // Edge 2b: the pre-speed-change version. Phase 62's named arm. This edge and the one
        // above are what prove the two named arms are DISTINCT rather than one arm that
        // swallowed the other: a guard that fired the speed message on v6, or the slot
        // message on v7, would redden exactly one of this pair.
        let pre_speed = write_at(PRE_SPEED_CHANGE_PROJECT_VERSION, snapshot.clone());
        let d2b = tempfile::tempdir().expect("fresh work_dir");
        assert!(
            matches!(
                load_project(&pre_speed, d2b.path(), Some(1)),
                Err(ProjectError::BeltSpeedModelChanged { found })
                    if found == PRE_SPEED_CHANGE_PROJECT_VERSION
            ),
            "the pre-speed-change bundle must get the BeltSpeedModelChanged arm"
        );

        // Edge 3: the current version. Loads. This is what proves the split did not widen
        // the refusal into the readable version.
        let current = write_at(PROJECT_FILE_VERSION, snapshot.clone());
        let d3 = tempfile::tempdir().expect("fresh work_dir");
        assert!(
            load_project(&current, d3.path(), Some(1)).is_ok(),
            "a current-version bundle must still LOAD"
        );

        // Edge 4: forward. Refused as unknown, ahead of any body decode.
        let forward = write_at(PROJECT_FILE_VERSION + 1, snapshot);
        let d4 = tempfile::tempdir().expect("fresh work_dir");
        assert!(
            matches!(
                load_project(&forward, d4.path(), Some(1)),
                Err(ProjectError::UnknownVersion(v)) if v == PROJECT_FILE_VERSION + 1
            ),
            "a forward bundle must be refused as UnknownVersion"
        );
    }

    #[test]
    fn bundle_round_trips_byte_identical() {
        // A constructed bundle encodes -> decodes -> re-encodes byte-identically:
        // the SAVE-02 deterministic-substrate guarantee (plain ordered serde data,
        // no HashMap/HashSet).
        let (_dir, host, _source) = ticked_host(Some(1));
        let bundle = ProjectFile {
            version: PROJECT_FILE_VERSION,
            head_tick: host.core().tick,
            snapshot: host.snapshot_bytes(),
            log: host.logged_events().expect("logged events"),
            edit_log: Vec::new(),
        };
        let bytes = postcard::to_allocvec(&bundle).expect("encode");
        let decoded: ProjectFile = postcard::from_bytes(&bytes).expect("decode");
        let bytes2 = postcard::to_allocvec(&decoded).expect("re-encode");
        assert_eq!(bytes, bytes2, "re-encode must be byte-identical (SAVE-02)");
    }

    #[test]
    fn saves_a_portable_bundle() {
        // save_project writes a file that decodes to a ProjectFile carrying the
        // host's head_tick, a non-empty log, the current version, and a snapshot
        // whose restore().tick <= head_tick. Saved at a QUIESCENT boundary (WR-02).
        let (dir, host, _source) = quiesced_host(Some(1));
        let path = dir.path().join("factory.fab");
        save_project(&host, &path).expect("save");

        let bytes = std::fs::read(&path).expect("read back");
        let bundle: ProjectFile = postcard::from_bytes(&bytes).expect("decode saved file");
        assert_eq!(bundle.version, PROJECT_FILE_VERSION, "version stamped");
        assert_eq!(
            bundle.head_tick,
            host.core().tick,
            "head_tick == host.core().tick"
        );
        assert!(!bundle.log.is_empty(), "the log is non-empty");
        assert!(!bundle.snapshot.is_empty(), "the snapshot is non-empty");
        let base_tick = fabrico_core::snapshot::restore(&bundle.snapshot)
            .expect("snapshot restores")
            .tick;
        assert!(
            base_tick <= bundle.head_tick,
            "base_tick {base_tick} must be <= head_tick {}",
            bundle.head_tick
        );
    }

    #[test]
    fn save_refuses_non_quiescent_host() {
        // WR-02: saving while a command is still in-flight would bundle a log with
        // an unresolved command that reloads as a spurious Timeout/fault (silent
        // semantic loss). save_project refuses it LOUDLY with NotQuiescent rather
        // than silently degrading the effect on reload.
        let (dir, host, _source) = ticked_host(Some(1));
        assert_eq!(host.in_flight_len(), 1, "the live host is non-quiescent");
        let path = dir.path().join("midflight.fab");
        let result = save_project(&host, &path);
        assert!(
            matches!(result, Err(ProjectError::NotQuiescent(1))),
            "a non-quiescent save must be refused with NotQuiescent(1)"
        );
        assert!(
            !path.exists(),
            "a refused save must not write a (silently-degrading) file"
        );
    }

    #[test]
    fn save_requires_quiescence() {
        // HOST-04 (plan 18-02): the NotQuiescent Save backstop the sim-loop Save
        // arm relies on, plus the settled happy-path round-trip THROUGH the real
        // save_project + load_project (not a hand-built bundle).
        //
        // (1) NON-QUIESCENT: a Save with an unresolved in-flight command is refused
        //     with NotQuiescent(n) where n is EXACTLY host.in_flight_len() — the
        //     count the caller drains to zero before retrying.
        let (nq_dir, nq_host, _s) = ticked_host(Some(1));
        let n = nq_host.in_flight_len();
        assert!(n > 0, "the ticked host has at least one in-flight command");
        let nq_path = nq_dir.path().join("nonquiescent.fab");
        let result = save_project(&nq_host, &nq_path);
        assert!(
            matches!(result, Err(ProjectError::NotQuiescent(got)) if got == n),
            "a non-quiescent Save is refused with NotQuiescent(n), n == in_flight_len() ({n})"
        );
        assert!(!nq_path.exists(), "a refused Save writes no file");

        // (2) SETTLED: a Save from a quiescent host reaches save_project, writes a
        //     .fab, and load_project re-opens it to the saved head_tick — the full
        //     round-trip the sim-loop Save arm produces from the Frozen state.
        let (q_dir, q_host, _s2) = quiesced_host(Some(1));
        assert_eq!(q_host.in_flight_len(), 0, "the quiesced host is settled");
        let q_path = q_dir.path().join("quiescent.fab");
        save_project(&q_host, &q_path).expect("a settled Save reaches save_project");
        assert!(q_path.exists(), "a settled Save writes the .fab");

        let load_dir = tempfile::tempdir().expect("fresh work_dir");
        let loaded = load_project(&q_path, load_dir.path(), Some(1)).expect("load the saved .fab");
        assert_eq!(
            loaded.core().tick,
            q_host.core().tick,
            "the settled Save round-trips through load_project to head_tick"
        );
    }

    #[test]
    fn load_round_trips_to_head() {
        // load into a FRESH work_dir reaches the saved head_tick via the reused
        // Host::recover() (restore base snapshot -> replay log forward), and proves
        // the host executor state (ledger/in-flight) is NOT bundled.
        let (dir, host, _source) = ticked_host(Some(1));
        let path = dir.path().join("factory.fab");
        // The live host has a dispatched-but-unresolved command: a non-empty
        // in-flight set backed by a populated dispatch ledger (an InFlight row).
        assert_eq!(
            host.in_flight_len(),
            1,
            "the live host has one in-flight command (a populated source ledger)"
        );
        // save_project now REFUSES this non-quiescent host (WR-02), so build the
        // portable bundle DIRECTLY — the same snapshot+log save_project would write
        // (the latest persisted snapshot base; here base_tick == head_tick under
        // snapshot_every=1) — to still exercise the load path's ledger-not-bundled
        // proof. The bundle deliberately carries the log of an unresolved command.
        let (base_tick, snapshot) = host
            .latest_persisted_snapshot()
            .expect("read persisted snapshot")
            .expect("a base snapshot was persisted");
        assert_eq!(
            base_tick,
            host.core().tick,
            "snapshot_every=1 -> base_tick == head_tick"
        );
        let bundle = ProjectFile {
            version: PROJECT_FILE_VERSION,
            head_tick: host.core().tick,
            snapshot,
            log: host.logged_events().expect("logged events"),
            edit_log: Vec::new(),
        };
        std::fs::write(&path, postcard::to_allocvec(&bundle).expect("encode")).expect("write");

        let load_dir = tempfile::tempdir().expect("fresh work_dir");
        let loaded = load_project(&path, load_dir.path(), Some(1)).expect("load");
        assert_eq!(
            loaded.core().tick,
            host.core().tick,
            "loaded host reaches the saved head_tick"
        );
        // The bundle carried ONLY snapshot + log — NOT the source ledger / in-flight
        // set. recover() over the FRESH empty ledger (with the head-snapshot base, so
        // no post-snapshot command is replayed-forward) reinstates nothing: in-flight
        // is 0. Had the populated ledger been bundled, recover() would have reinstated
        // that InFlight row and in-flight would be 1 — proving the host executor state
        // is NOT in the portable file (Save Scope).
        assert_eq!(
            loaded.in_flight_len(),
            0,
            "fresh-empty-ledger recover() carries no bundled in-flight state"
        );
    }

    #[test]
    fn refuses_forward_version() {
        // A bundle whose version exceeds PROJECT_FILE_VERSION is refused BEFORE the
        // fresh store is touched — typed UnknownVersion, never a panic.
        let (dir, host, _source) = ticked_host(Some(1));
        let bundle = ProjectFile {
            version: PROJECT_FILE_VERSION + 1,
            head_tick: host.core().tick,
            snapshot: host.snapshot_bytes(),
            log: host.logged_events().expect("log"),
            edit_log: Vec::new(),
        };
        let path = dir.path().join("forward.fab");
        std::fs::write(&path, postcard::to_allocvec(&bundle).expect("encode")).expect("write");

        let load_dir = tempfile::tempdir().expect("fresh work_dir");
        // Host is not Debug, so match on the Result shape directly (no expect_err).
        let result = load_project(&path, load_dir.path(), None);
        assert!(
            matches!(result, Err(ProjectError::UnknownVersion(v)) if v == PROJECT_FILE_VERSION + 1),
            "forward version must be refused as UnknownVersion"
        );
        assert!(
            !load_dir.path().join("log.redb").exists(),
            "a refused forward bundle must not hydrate the fresh store"
        );

        // Extended (60-03): the forward refusal fires AHEAD of any body decode, which the
        // assertion above cannot show on its own because that bundle's body was valid.
        // Peek the leading version varint off a bundle whose remaining bytes are garbage:
        // a version gate that ran after the decode would report Malformed instead.
        let mut forged = postcard::to_allocvec(&(PROJECT_FILE_VERSION + 1)).expect("encode version");
        forged.extend_from_slice(&[0xFFu8; 64]);
        let garbage_path = dir.path().join("forward_garbage.fab");
        std::fs::write(&garbage_path, &forged).expect("write");
        let garbage_dir = tempfile::tempdir().expect("fresh work_dir");
        assert!(
            matches!(
                load_project(&garbage_path, garbage_dir.path(), None),
                Err(ProjectError::UnknownVersion(v)) if v == PROJECT_FILE_VERSION + 1
            ),
            "the forward refusal must fire on the peeked version, BEFORE the body is decoded"
        );
    }

    #[test]
    fn malformed_bundle_is_typed_error_no_panic() {
        // Garbage / truncated bundle bytes return a typed Malformed error, never a
        // panic.
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("garbage.fab");
        std::fs::write(&path, [0xFFu8; 32]).expect("write garbage");

        let load_dir = tempfile::tempdir().expect("fresh work_dir");
        let result = load_project(&path, load_dir.path(), None);
        assert!(
            matches!(result, Err(ProjectError::Malformed)),
            "garbage bytes must be a typed Malformed error (no panic)"
        );
    }

    #[test]
    fn hostile_snapshot_rejected() {
        // A bundle whose snapshot decodes structurally but violates a class
        // invariant (a node with no provisioned inbox -> MissingInbox) is rejected
        // by the HARDENED restore (plan 06-01) as a typed InvalidSnapshot BEFORE the
        // fresh store is hydrated — never a panic.
        let mut core = Core::genesis(header());
        let node = core.state.add_source(); // provisions an inbox
        core.state.test_remove_inbox(node); // forge the MissingInbox invariant
        let hostile = fabrico_core::snapshot::snapshot(&core);
        let bundle = ProjectFile {
            version: PROJECT_FILE_VERSION,
            head_tick: core.tick,
            snapshot: hostile,
            log: Vec::new(),
            edit_log: Vec::new(),
        };
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("hostile.fab");
        std::fs::write(&path, postcard::to_allocvec(&bundle).expect("encode")).expect("write");

        let load_dir = tempfile::tempdir().expect("fresh work_dir");
        let result = load_project(&path, load_dir.path(), None);
        assert!(
            matches!(
                result,
                Err(ProjectError::InvalidSnapshot(DecodeError::InvalidState(_)))
            ),
            "a hostile invariant-violating snapshot must be a typed InvalidSnapshot (no panic)"
        );
    }

    #[test]
    fn oversized_file_is_typed_error_no_panic() {
        // WR-01: a project file larger than MAX_PROJECT_BYTES is refused with a
        // typed TooLarge BEFORE the whole file is read into memory (a
        // memory-exhaustion-DoS guard) — never an OOM/abort. A SPARSE file declares
        // a length past the ceiling without allocating it, so the test stays cheap
        // and exercises the metadata-stat guard, not the read.
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("huge.fab");
        let f = std::fs::File::create(&path).expect("create");
        f.set_len(MAX_PROJECT_BYTES + 1).expect("set_len (sparse)");
        drop(f);

        let load_dir = tempfile::tempdir().expect("fresh work_dir");
        let result = load_project(&path, load_dir.path(), None);
        assert!(
            matches!(
                result,
                Err(ProjectError::TooLarge { size, limit })
                    if size == MAX_PROJECT_BYTES + 1 && limit == MAX_PROJECT_BYTES
            ),
            "an oversized project file must be a typed TooLarge error (no OOM/panic)"
        );
    }

    #[test]
    fn tampered_head_tick_rejected() {
        // IN-01: a bundle whose head_tick disagrees with the tick the restored
        // snapshot + replayed log actually folds to is rejected with a typed
        // HeadTickMismatch (the documented post-load sanity invariant is now
        // ENFORCED), never silently loaded to a different tick than it claims.
        let (dir, host, _source) = ticked_host(Some(1));
        let (_base_tick, snapshot) = host
            .latest_persisted_snapshot()
            .expect("read persisted snapshot")
            .expect("a base snapshot was persisted");
        let real_head = host.core().tick;
        let bundle = ProjectFile {
            version: PROJECT_FILE_VERSION,
            head_tick: real_head + 1, // forge an inconsistent head_tick
            snapshot,
            log: host.logged_events().expect("logged events"),
            edit_log: Vec::new(),
        };
        let path = dir.path().join("tampered_head.fab");
        std::fs::write(&path, postcard::to_allocvec(&bundle).expect("encode")).expect("write");

        let load_dir = tempfile::tempdir().expect("fresh work_dir");
        let result = load_project(&path, load_dir.path(), Some(1));
        assert!(
            matches!(
                result,
                Err(ProjectError::HeadTickMismatch { expected, actual })
                    if expected == real_head + 1 && actual == real_head
            ),
            "a head_tick disagreeing with the replayed log must be HeadTickMismatch"
        );
    }

    #[test]
    fn forward_versioned_log_event_rejected() {
        // IN-02a: a bundled log event whose schema_version exceeds the readable
        // SCHEMA_VERSION is refused UP FRONT (before the fresh store is hydrated)
        // with a precise typed UnreadableLogEvent — not a generic deep Store error
        // surfaced only after the store was written, and never a panic.
        let (dir, host, _source) = ticked_host(Some(1));
        let snapshot = host.snapshot_bytes();
        let mut log = host.logged_events().expect("logged events");
        assert!(!log.is_empty(), "the log is non-empty");
        log[0].schema_version = SCHEMA_VERSION + 1; // forge a forward-versioned event
        let bundle = ProjectFile {
            version: PROJECT_FILE_VERSION,
            head_tick: host.core().tick,
            snapshot,
            log,
            edit_log: Vec::new(),
        };
        let path = dir.path().join("forward_log.fab");
        std::fs::write(&path, postcard::to_allocvec(&bundle).expect("encode")).expect("write");

        let load_dir = tempfile::tempdir().expect("fresh work_dir");
        let result = load_project(&path, load_dir.path(), Some(1));
        assert!(
            matches!(result, Err(ProjectError::UnreadableLogEvent(v)) if v == SCHEMA_VERSION + 1),
            "a forward-versioned bundled log event must be UnreadableLogEvent"
        );
        assert!(
            !load_dir.path().join("log.redb").exists(),
            "the fresh store must not be hydrated by a rejected bundle"
        );
    }

    #[test]
    fn out_of_order_log_rejected() {
        // IN-02b: a bundled log with a duplicate / out-of-order (partition, sequence)
        // key is refused UP FRONT with NonMonotonicLog. Re-appending such a key would
        // silently COLLAPSE log entries (append_event has no monotonicity check),
        // mis-decoding a hostile bundle — rejected before the store is hydrated,
        // never a panic.
        let (dir, host, _source) = ticked_host(Some(1));
        let snapshot = host.snapshot_bytes();
        let mut log = host.logged_events().expect("logged events");
        assert!(!log.is_empty(), "the log is non-empty");
        // Append a duplicate of the first event: its (partition, sequence) key is
        // <= the running max, tripping the strictly-increasing requirement.
        let dup = log[0].clone();
        log.push(dup.clone());
        let bundle = ProjectFile {
            version: PROJECT_FILE_VERSION,
            head_tick: host.core().tick,
            snapshot,
            log,
            edit_log: Vec::new(),
        };
        let path = dir.path().join("out_of_order.fab");
        std::fs::write(&path, postcard::to_allocvec(&bundle).expect("encode")).expect("write");

        let load_dir = tempfile::tempdir().expect("fresh work_dir");
        let result = load_project(&path, load_dir.path(), Some(1));
        assert!(
            matches!(
                result,
                Err(ProjectError::NonMonotonicLog { partition, sequence })
                    if partition == dup.partition && sequence == dup.sequence
            ),
            "a duplicate/out-of-order bundled log key must be NonMonotonicLog"
        );
    }

    /// Build a `.fab` bundle carrying ONE forged `Configure{Router}` edit record.
    fn bundle_with_router_config(
        host: &crate::driver::Host,
        routes: Vec<(fabrico_core::state::RouteKey, u16)>,
    ) -> ProjectFile {
        ProjectFile {
            version: PROJECT_FILE_VERSION,
            head_tick: host.core().tick,
            snapshot: host.snapshot_bytes(),
            log: host.logged_events().expect("logged events"),
            edit_log: vec![EditRecord {
                schema_version: EDIT_SCHEMA_VERSION,
                partition: 0,
                sequence: 1,
                tick: 0,
                action: 0,
                op: EditOp::Configure {
                    node: host
                        .core()
                        .state
                        .node_ids()
                        .next()
                        .expect("the ticked host holds at least one node"),
                    config: MachineConfig::Router { routes, default: None },
                    code_hash: [0u8; 32],
                },
            }],
        }
    }

    /// Write `bundle` into `dir` as `name` and try to load it, returning the outcome plus
    /// the fresh work dir so the caller can prove nothing was hydrated.
    fn load_forged(
        dir: &Path,
        name: &str,
        bundle: &ProjectFile,
    ) -> (Option<ProjectError>, tempfile::TempDir) {
        let path = dir.join(name);
        std::fs::write(&path, postcard::to_allocvec(bundle).expect("encode")).expect("write");
        let load_dir = tempfile::tempdir().expect("fresh work_dir");
        let err = load_project(&path, load_dir.path(), Some(1)).err();
        (err, load_dir)
    }

    #[test]
    fn oversized_router_route_table_edit_record_rejected() {
        use fabrico_core::state::RouteKey;
        // T-63-01 / 63-04: `MachineConfig::Router`'s table is the second unbounded
        // allocation surface in the serialized model, and `load_project` is the REACHABLE
        // decode boundary (`edit::upcast` has zero production callers). A bundled
        // over-cap table is a TYPED refusal here, not a panic and not a generic error.
        let (dir, host, _source) = ticked_host(Some(1));
        let over = (0..=MAX_ROUTES)
            .map(|i| (RouteKey::new(0, vec![i as u8]), 0u16))
            .collect();
        let path = dir.path().join("oversized_router.fab");
        std::fs::write(
            &path,
            postcard::to_allocvec(&bundle_with_router_config(&host, over)).expect("encode"),
        )
        .expect("write");

        let load_dir = tempfile::tempdir().expect("fresh work_dir");
        let err = load_project(&path, load_dir.path(), Some(1)).err();
        assert!(
            matches!(
                err,
                Some(ProjectError::EditRouteTableTooLong { routes, cap })
                    if routes == MAX_ROUTES + 1 && cap == MAX_ROUTES
            ),
            "an over-cap bundled route table must be EditRouteTableTooLong, got {err:?}"
        );
        assert!(
            !load_dir.path().join("log.redb").exists(),
            "the fresh store must not be hydrated by a rejected bundle"
        );
    }

    #[test]
    fn oversized_router_expect_pattern_edit_record_rejected() {
        use fabrico_core::state::RouteKey;
        // The second dimension: ONE rule whose match pattern is unbounded. `routes` is a
        // Vec of Vecs, so capping only the outer length would leave this open.
        let (dir, host, _source) = ticked_host(Some(1));
        let over = vec![(
            RouteKey::new(0, vec![0u8; MAX_ROUTE_EXPECT_BYTES + 1]),
            0u16,
        )];
        let path = dir.path().join("oversized_route_pattern.fab");
        std::fs::write(
            &path,
            postcard::to_allocvec(&bundle_with_router_config(&host, over)).expect("encode"),
        )
        .expect("write");

        let load_dir = tempfile::tempdir().expect("fresh work_dir");
        let err = load_project(&path, load_dir.path(), Some(1)).err();
        assert!(
            matches!(
                err,
                Some(ProjectError::EditRoutePatternTooLong { len, cap })
                    if len == MAX_ROUTE_EXPECT_BYTES + 1 && cap == MAX_ROUTE_EXPECT_BYTES
            ),
            "an over-cap bundled match pattern must be EditRoutePatternTooLong, got {err:?}"
        );
    }

    // ── plan 76-04 (SHAPE-13, D-06): the label bound at the reachable load gate ──────
    //
    // `load_project` is the REACHABLE decode boundary (`edit::upcast` has no production
    // caller). A bundled `Configure{Label}` whose text exceeds `MAX_LABEL_BYTES`, or whose
    // width or depth is outside 1 to `MAX_FOOTPRINT_DIM`, is a typed refusal here, before
    // the fresh store is hydrated; one exactly at each limit loads. The 16 by 8 panel caps
    // are NOT enforced (a later cap change must not make saved boards unloadable). A
    // snapshot holding an over-long label is a typed refusal too, never a panic.
    //
    // MEASURED BEFORE THE GUARD (recorded in 76-04-SUMMARY.md): every forged bundle below
    // LOADED.

    /// A bundle over `host` whose one edit record is a `Configure{Label}` aimed at the
    /// host's first node, carrying `text` and a `w` by `h` box. Everything else is the
    /// host's real, valid substrate, so the label record is the only thing under test (the
    /// `bundle_with_router_config` shape).
    fn bundle_with_label_config(
        host: &crate::driver::Host,
        text: String,
        w: u16,
        h: u16,
    ) -> ProjectFile {
        ProjectFile {
            version: PROJECT_FILE_VERSION,
            head_tick: host.core().tick,
            snapshot: host.snapshot_bytes(),
            log: host.logged_events().expect("logged events"),
            edit_log: vec![EditRecord {
                schema_version: EDIT_SCHEMA_VERSION,
                partition: 0,
                sequence: 1,
                tick: 0,
                action: 0,
                op: EditOp::Configure {
                    node: host
                        .core()
                        .state
                        .node_ids()
                        .next()
                        .expect("the ticked host holds at least one node"),
                    config: MachineConfig::Label {
                        text,
                        colour: fabrico_core::state::LabelColour::Moss,
                        w,
                        h,
                    },
                    code_hash: [0u8; 32],
                },
            }],
        }
    }

    #[test]
    fn a_bundled_label_text_one_byte_over_the_cap_is_refused_at_load() {
        let (dir, host, _source) = ticked_host(Some(1));
        let bundle =
            bundle_with_label_config(&host, "a".repeat(fabrico_core::edit::MAX_LABEL_BYTES + 1), 4, 1);
        let (err, load_dir) = load_forged(dir.path(), "long_label.fab", &bundle);
        assert!(
            matches!(
                err,
                Some(ProjectError::EditLabelTextTooLong { len, cap })
                    if len == fabrico_core::edit::MAX_LABEL_BYTES + 1
                        && cap == fabrico_core::edit::MAX_LABEL_BYTES
            ),
            "an over-cap bundled label text must be EditLabelTextTooLong, got {err:?}"
        );
        assert!(
            !load_dir.path().join("log.redb").exists(),
            "the fresh store must not be hydrated by a rejected bundle"
        );
    }

    #[test]
    fn a_bundled_label_text_exactly_at_the_cap_loads() {
        let (dir, host, _source) = ticked_host(Some(1));
        let bundle =
            bundle_with_label_config(&host, "a".repeat(fabrico_core::edit::MAX_LABEL_BYTES), 4, 1);
        let (err, _load_dir) = load_forged(dir.path(), "at_cap_label.fab", &bundle);
        assert!(err.is_none(), "a label text of exactly the cap loads, got {err:?}");
    }

    #[test]
    fn a_bundled_label_size_outside_the_envelope_is_refused_at_load() {
        let (dir, host, _source) = ticked_host(Some(1));
        for (i, (w, h)) in
            [(MAX_FOOTPRINT_DIM + 1, 1), (1, MAX_FOOTPRINT_DIM + 1), (0, 1), (1, 0)].into_iter().enumerate()
        {
            let bundle = bundle_with_label_config(&host, String::new(), w, h);
            let (err, load_dir) = load_forged(dir.path(), &format!("bad_size_{i}.fab"), &bundle);
            assert!(
                matches!(
                    err,
                    Some(ProjectError::EditLabelSizeOutOfRange { w: ew, h: eh, cap })
                        if ew == w && eh == h && cap == MAX_FOOTPRINT_DIM
                ),
                "a bundled label size {w} by {h} must be EditLabelSizeOutOfRange, got {err:?}"
            );
            assert!(
                !load_dir.path().join("log.redb").exists(),
                "the fresh store must not be hydrated by a rejected bundle"
            );
        }
    }

    #[test]
    fn a_bundled_label_size_at_the_envelope_loads() {
        // 64 by 64 is the envelope's corner, and 17 by 9 is past the 16 by 8 panel caps:
        // those are write-side policy and must never refuse a saved board.
        let (dir, host, _source) = ticked_host(Some(1));
        for (i, (w, h)) in [(MAX_FOOTPRINT_DIM, MAX_FOOTPRINT_DIM), (17, 9), (1, 1)].into_iter().enumerate() {
            let bundle = bundle_with_label_config(&host, "Order intake".to_owned(), w, h);
            let (err, _load_dir) = load_forged(dir.path(), &format!("ok_size_{i}.fab"), &bundle);
            assert!(err.is_none(), "a bundled label size {w} by {h} loads, got {err:?}");
        }
    }

    #[test]
    fn a_snapshot_label_text_over_the_cap_is_a_typed_load_refusal() {
        // The other way an over-long label enters: inside the bundle's SNAPSHOT rather
        // than its edit log. `restore`'s `LabelTextTooLong` surfaces as a typed
        // `ProjectError`, never a panic and never a load.
        let (dir, host, _source) = ticked_host(Some(1));
        let mut core = fabrico_core::snapshot::restore(&host.snapshot_bytes())
            .unwrap_or_else(|e| panic!("the host's own snapshot restores, got {e:?}"));
        let id = core.state.add_label();
        match core.state.node_mut(id) {
            Some(fabrico_core::state::Node::Label(label)) => {
                label.text = "a".repeat(fabrico_core::edit::MAX_LABEL_BYTES + 1);
            }
            _ => panic!("add_label must mint a Node::Label"),
        }
        let bundle = ProjectFile {
            version: PROJECT_FILE_VERSION,
            head_tick: host.core().tick,
            snapshot: fabrico_core::snapshot::snapshot(&core),
            log: host.logged_events().expect("logged events"),
            edit_log: host.logged_edits().expect("logged edits"),
        };
        let (err, load_dir) = load_forged(dir.path(), "long_label_snapshot.fab", &bundle);
        assert!(
            matches!(
                err,
                Some(ProjectError::InvalidSnapshot(DecodeError::InvalidState(
                    fabrico_core::event::StateInvariant::LabelTextTooLong
                )))
            ),
            "a snapshot holding an over-cap label must be InvalidSnapshot(LabelTextTooLong), \
             got {err:?}"
        );
        assert!(
            !load_dir.path().join("log.redb").exists(),
            "the fresh store must not be hydrated by a rejected bundle"
        );
    }

    #[test]
    fn an_at_cap_router_route_table_loads_cleanly() {
        use fabrico_core::state::RouteKey;
        // The boundary is INCLUSIVE and pinned in both dimensions, so a later off-by-one
        // is a failing test rather than a reading of the source.
        let (dir, host, _source) = ticked_host(Some(1));
        let at_cap = (0..MAX_ROUTES)
            .map(|i| {
                (
                    RouteKey::new(0, vec![i as u8; MAX_ROUTE_EXPECT_BYTES]),
                    0u16,
                )
            })
            .collect();
        let path = dir.path().join("at_cap_router.fab");
        std::fs::write(
            &path,
            postcard::to_allocvec(&bundle_with_router_config(&host, at_cap)).expect("encode"),
        )
        .expect("write");

        let load_dir = tempfile::tempdir().expect("fresh work_dir");
        let result = load_project(&path, load_dir.path(), Some(1));
        let ok = result.is_ok();
        let err = result.err();
        assert!(
            ok,
            "a route table at exactly the cap in BOTH dimensions loads, got {err:?}"
        );
    }

    #[test]
    fn oversized_place_edit_record_rejected() {
        // CR-01 / T-06-01-DOS: a bundled `EditOp::Place` at `w = h = u16::MAX` would be
        // replayed VERBATIM by recover() through fold_place/claim_footprint, expanding
        // ~4.3 billion occupancy cells — a tiny-input/multi-GiB amplification bomb. The
        // up-front bound rejects it with EditFootprintOutOfRange BEFORE the fresh store
        // is hydrated or any edit is folded. This test returning a typed error (rather
        // than OOM/unwind) is the no-allocation-bomb proof.
        let (dir, host, _source) = ticked_host(Some(1));
        let snapshot = host.snapshot_bytes();
        let forged = EditRecord {
            schema_version: EDIT_SCHEMA_VERSION,
            partition: 0,
            sequence: 1,
            tick: 0,
            action: 0,
            op: EditOp::Place {
                kind: 0,
                cell_x: 0,
                cell_y: 0,
                w: u16::MAX,
                h: u16::MAX,
                ports: Vec::new(),
                rot: 0,
            },
        };
        let bundle = ProjectFile {
            version: PROJECT_FILE_VERSION,
            head_tick: host.core().tick,
            snapshot,
            log: host.logged_events().expect("logged events"),
            edit_log: vec![forged],
        };
        let path = dir.path().join("oversized_place.fab");
        std::fs::write(&path, postcard::to_allocvec(&bundle).expect("encode")).expect("write");

        let load_dir = tempfile::tempdir().expect("fresh work_dir");
        let result = load_project(&path, load_dir.path(), Some(1));
        assert!(
            matches!(
                result,
                Err(ProjectError::EditFootprintOutOfRange { w, h })
                    if w == u16::MAX && h == u16::MAX
            ),
            "a bundled oversized Place footprint must be EditFootprintOutOfRange"
        );
        assert!(
            !load_dir.path().join("log.redb").exists(),
            "the fresh store must not be hydrated by a rejected bundle"
        );
    }

    /// Plan 86-02 (EDIT 13, threat T-86-05): a bundled record naming a rotation above 3 is
    /// refused up front as `EditRotationOutOfRange`, on a `Place` and on a `Delete`
    /// capture alike, before the fresh store is hydrated or any edit is folded. A rotation
    /// is a quarter-turn count, so 7 names no orientation a machine can hold.
    #[test]
    fn a_place_or_a_delete_capture_turned_past_3_is_refused_at_load() {
        let forged_ops = [
            EditOp::Place {
                kind: 0,
                cell_x: 0,
                cell_y: 0,
                w: 1,
                h: 1,
                ports: Vec::new(),
                rot: 7,
            },
            EditOp::Delete {
                node: fabrico_core::ids::NodeId::default(),
                kind: 5,
                cell_x: 0,
                cell_y: 0,
                captured: fabrico_core::edit::DeletedSubgraph {
                    w: 2,
                    h: 3,
                    rot: 7,
                    ..Default::default()
                },
            },
        ];
        for (i, op) in forged_ops.into_iter().enumerate() {
            let (dir, host, _source) = ticked_host(Some(1));
            let bundle = ProjectFile {
                version: PROJECT_FILE_VERSION,
                head_tick: host.core().tick,
                snapshot: host.snapshot_bytes(),
                log: host.logged_events().expect("logged events"),
                edit_log: vec![EditRecord {
                    schema_version: EDIT_SCHEMA_VERSION,
                    partition: 0,
                    sequence: 1,
                    tick: 0,
                    action: 0,
                    op,
                }],
            };
            let path = dir.path().join(format!("turned_past_three_{i}.fab"));
            std::fs::write(&path, postcard::to_allocvec(&bundle).expect("encode")).expect("write");
            let load_dir = tempfile::tempdir().expect("fresh work_dir");
            let result = load_project(&path, load_dir.path(), Some(1));
            assert!(
                matches!(result, Err(ProjectError::EditRotationOutOfRange { rot: 7 })),
                "record {i}: a bundled rotation of 7 must be EditRotationOutOfRange, got {:?}",
                result.err()
            );
            assert!(
                !load_dir.path().join("log.redb").exists(),
                "record {i}: the fresh store must not be hydrated by a rejected bundle"
            );
        }
    }

    #[test]
    fn out_of_extent_place_anchor_edit_record_rejected() {
        // WR-01: a bundled `EditOp::Place` whose anchor lies outside `[GRID_MIN, GRID_MAX]`
        // is refused UP FRONT with EditAnchorOutOfBounds — the edit-log mirror of the
        // snapshot gate's anchor bound. Without it, recover() would replay the anchor
        // verbatim and build a `Core` the snapshot gate rejects (CellOutOfBounds), i.e. a
        // non-round-tripping state. Rejected before the fresh store is hydrated.
        use fabrico_core::state::GRID_MAX;
        let (dir, host, _source) = ticked_host(Some(1));
        let snapshot = host.snapshot_bytes();
        let forged = EditRecord {
            schema_version: EDIT_SCHEMA_VERSION,
            partition: 0,
            sequence: 1,
            tick: 0,
            action: 0,
            op: EditOp::Place {
                kind: 0,
                cell_x: GRID_MAX + 1,
                cell_y: 0,
                w: 1,
                h: 1,
                ports: Vec::new(),
                rot: 0,
            },
        };
        let bundle = ProjectFile {
            version: PROJECT_FILE_VERSION,
            head_tick: host.core().tick,
            snapshot,
            log: host.logged_events().expect("logged events"),
            edit_log: vec![forged],
        };
        let path = dir.path().join("out_of_extent_anchor.fab");
        std::fs::write(&path, postcard::to_allocvec(&bundle).expect("encode")).expect("write");

        let load_dir = tempfile::tempdir().expect("fresh work_dir");
        let result = load_project(&path, load_dir.path(), Some(1));
        assert!(
            matches!(
                result,
                Err(ProjectError::EditAnchorOutOfBounds { cell_x, cell_y })
                    if cell_x == GRID_MAX + 1 && cell_y == 0
            ),
            "a bundled out-of-extent Place anchor must be EditAnchorOutOfBounds"
        );
        assert!(
            !load_dir.path().join("log.redb").exists(),
            "the fresh store must not be hydrated by a rejected bundle"
        );
    }

    #[test]
    fn out_of_footprint_place_port_edit_record_rejected() {
        // WR-02: a bundled `EditOp::Place` whose port `local_offset` lies outside its
        // `[0,w)×[0,h)` rot-0 box is refused UP FRONT with EditPortOutOfFootprint — the
        // edit-log mirror of the snapshot gate's PortOutOfFootprint. Without it,
        // recover() would `set_ports` the forged port verbatim and build a `Core` the
        // gate rejects on the next restore. Rejected before the fresh store is hydrated.
        use fabrico_core::state::{Medium, Port, Role, Side};
        let (dir, host, _source) = ticked_host(Some(1));
        let snapshot = host.snapshot_bytes();
        let forged = EditRecord {
            schema_version: EDIT_SCHEMA_VERSION,
            partition: 0,
            sequence: 1,
            tick: 0,
            action: 0,
            op: EditOp::Place {
                kind: 0,
                cell_x: 0,
                cell_y: 0,
                w: 2,
                h: 2,
                // (2, 0) is outside [0,2)×[0,2) on the x axis (x must be < w == 2).
                ports: vec![Port {
                    local_offset: (2, 0),
                    side: Side::E,
                    role: Role::Out, medium: Medium::Mechanical,
                }],
                rot: 0,
            },
        };
        let bundle = ProjectFile {
            version: PROJECT_FILE_VERSION,
            head_tick: host.core().tick,
            snapshot,
            log: host.logged_events().expect("logged events"),
            edit_log: vec![forged],
        };
        let path = dir.path().join("out_of_footprint_port.fab");
        std::fs::write(&path, postcard::to_allocvec(&bundle).expect("encode")).expect("write");

        let load_dir = tempfile::tempdir().expect("fresh work_dir");
        let result = load_project(&path, load_dir.path(), Some(1));
        assert!(
            matches!(
                result,
                Err(ProjectError::EditPortOutOfFootprint { local_offset, w, h })
                    if local_offset == (2, 0) && w == 2 && h == 2
            ),
            "a bundled out-of-footprint Place port must be EditPortOutOfFootprint"
        );
        assert!(
            !load_dir.path().join("log.redb").exists(),
            "the fresh store must not be hydrated by a rejected bundle"
        );
    }

    #[test]
    fn hostile_max_tick_bundle_is_typed_error_no_panic() {
        // Mode A of T-06-LOAD-DOS: a bundle whose base-snapshot tick AND log event
        // tick are u64::MAX would drive recover()'s run_log into `core.tick += 1`
        // AT u64::MAX and PANIC ("attempt to add with overflow"). The pre-flight
        // CHECKED-arithmetic guard rejects it as a typed TickOverflow BEFORE
        // recover() runs — no panic, and the fresh store is never hydrated. This
        // test returning a typed error (rather than unwinding) is the no-panic proof.
        let mut core = Core::genesis(header());
        let source = core.state.add_source(); // a valid node (passes validate_invariants)
        core.tick = u64::MAX; // forge a hostile boundary tick
        let snapshot = fabrico_core::snapshot::snapshot(&core);
        let bundle = ProjectFile {
            version: PROJECT_FILE_VERSION,
            head_tick: u64::MAX,
            snapshot,
            log: vec![Event {
                schema_version: SCHEMA_VERSION,
                partition: 0,
                sequence: 0,
                tick: u64::MAX, // the max event tick whose +1 overflows
                payload: EventPayload::ManualInject {
                    target: source,
                    port: 0,
                    item: Item(vec![0x01]),
                },
            }],
            edit_log: Vec::new(),
        };
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("hostile_max_tick.fab");
        std::fs::write(&path, postcard::to_allocvec(&bundle).expect("encode")).expect("write");

        let load_dir = tempfile::tempdir().expect("fresh work_dir");
        let result = load_project(&path, load_dir.path(), None);
        assert!(
            matches!(
                result,
                Err(ProjectError::TickOverflow { max_event_tick }) if max_event_tick == u64::MAX
            ),
            "a u64::MAX-tick bundle must be a typed TickOverflow (no add-overflow panic)"
        );
        assert!(
            !load_dir.path().join("log.redb").exists(),
            "the fresh store must not be hydrated by a rejected bundle"
        );
    }

    #[test]
    fn hostile_replay_span_is_typed_error_no_hang() {
        // Mode B of T-06-LOAD-DOS (bites in release too): a bundle with base tick 0
        // and an event tick of 2^40 would drive recover()'s idle-tick replay loop
        // ~10^12 iterations — an effectively non-terminating HANG. The pre-flight
        // SATURATING span check refuses it as a typed ReplaySpanTooLong BEFORE
        // recover() runs, so the load returns in O(1). This test completing FAST
        // (it never enters the replay loop) is the no-hang proof.
        const HOSTILE_TICK: u64 = 1 << 40; // ~1.1e12 ticks — far past MAX_REPLAY_SPAN
        let mut core = Core::genesis(header());
        let source = core.state.add_source();
        // base_tick stays 0 (genesis) — so the replay span is the full 2^40 gap.
        let snapshot = fabrico_core::snapshot::snapshot(&core);
        let bundle = ProjectFile {
            version: PROJECT_FILE_VERSION,
            // head_tick == max_event_tick + 1, so the head-tick consistency check
            // PASSES and the span ceiling is what actually catches the DoS.
            head_tick: HOSTILE_TICK + 1,
            snapshot,
            log: vec![Event {
                schema_version: SCHEMA_VERSION,
                partition: 0,
                sequence: 0,
                tick: HOSTILE_TICK,
                payload: EventPayload::ManualInject {
                    target: source,
                    port: 0,
                    item: Item(vec![0x02]),
                },
            }],
            edit_log: Vec::new(),
        };
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("hostile_span.fab");
        std::fs::write(&path, postcard::to_allocvec(&bundle).expect("encode")).expect("write");

        let load_dir = tempfile::tempdir().expect("fresh work_dir");
        let result = load_project(&path, load_dir.path(), None);
        assert!(
            matches!(
                result,
                Err(ProjectError::ReplaySpanTooLong { span, limit })
                    if span == HOSTILE_TICK + 1 && limit == MAX_REPLAY_SPAN
            ),
            "a multi-year tick gap must be a typed ReplaySpanTooLong (no replay-loop hang)"
        );
        assert!(
            !load_dir.path().join("log.redb").exists(),
            "the fresh store must not be hydrated by a rejected bundle"
        );
    }

    #[test]
    fn forward_versioned_edit_record_rejected() {
        // ELOG-05 / T-8-LOAD-EDIT-VER: a bundled edit record whose schema_version
        // exceeds the readable EDIT_SCHEMA_VERSION is refused UP FRONT (before the
        // fresh store is hydrated) with a precise typed UnreadableEditRecord — the
        // edit-log mirror of forward_versioned_log_event_rejected. Never a panic.
        let mut core = Core::genesis(header());
        let _source = core.state.add_source(); // a valid node (passes validate_invariants)
        let snapshot = fabrico_core::snapshot::snapshot(&core);
        let mut bad_edit = place_edit(0, 1, 1);
        bad_edit.schema_version = EDIT_SCHEMA_VERSION + 1; // forge a forward-versioned record
        let bundle = ProjectFile {
            version: PROJECT_FILE_VERSION,
            head_tick: core.tick,
            snapshot,
            log: Vec::new(),
            edit_log: vec![bad_edit],
        };
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("forward_edit.fab");
        std::fs::write(&path, postcard::to_allocvec(&bundle).expect("encode")).expect("write");

        let load_dir = tempfile::tempdir().expect("fresh work_dir");
        let result = load_project(&path, load_dir.path(), None);
        assert!(
            matches!(result, Err(ProjectError::UnreadableEditRecord(v)) if v == EDIT_SCHEMA_VERSION + 1),
            "a forward-versioned bundled edit record must be UnreadableEditRecord"
        );
        assert!(
            !load_dir.path().join("log.redb").exists(),
            "the fresh store must not be hydrated by a rejected bundle"
        );
    }

    #[test]
    fn version_six_edit_record_in_a_saved_project_file_is_refused_by_load_project() {
        // SCHEMA-01, THE criterion-critical test of plan 63-11, and the reason it is
        // written HERE rather than beside `edit::upcast`.
        //
        // The criterion is "an edit log written at the previous version is refused with
        // a typed error rather than silently mis-decoded". `edit::upcast` looks like
        // that boundary and is not one: it has ZERO production callers (Phase 63
        // RESEARCH FINDING 3). A test that constructs bytes and calls `upcast` would be
        // green whether or not a user's version-6 `.fab` file still loaded.
        //
        // So this test writes a REAL project file to disk through the same
        // postcard-encoded bundle a save produces, and calls the real `load_project`.
        // That is the path a user takes.
        //
        // The version is a HAND-WRITTEN 6, not `EDIT_SCHEMA_VERSION - 1`. It is the
        // actual version every pre-v8.0 saved board carries, so it stays a genuine
        // stale-file witness after the next bump instead of silently following it.
        //
        // Note what makes this refusal necessary rather than merely tidy: no
        // `EditRecord` field moved between 6 and 7, so a version-6 record decodes
        // CLEANLY under v7. Nothing downstream would fail. It would just be replayed as
        // though it had been written by this build. The version predicate is the only
        // thing standing between a stale board and a silent mis-replay.
        const PREVIOUS_MILESTONE_EDIT_VERSION: u16 = 6;

        let mut core = Core::genesis(header());
        let _source = core.state.add_source();
        let snapshot = fabrico_core::snapshot::snapshot(&core);
        let mut stale_edit = place_edit(0, 1, 1);
        stale_edit.schema_version = PREVIOUS_MILESTONE_EDIT_VERSION;
        let bundle = ProjectFile {
            version: PROJECT_FILE_VERSION,
            head_tick: core.tick,
            snapshot,
            log: Vec::new(),
            edit_log: vec![stale_edit],
        };
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("pre_v8_board.fab");
        std::fs::write(&path, postcard::to_allocvec(&bundle).expect("encode")).expect("write");
        assert!(path.exists(), "the stale board must really be on disk");

        let load_dir = tempfile::tempdir().expect("fresh work_dir");
        let result = load_project(&path, load_dir.path(), None);
        assert!(
            matches!(
                result,
                Err(ProjectError::UnreadableEditRecord(v)) if v == PREVIOUS_MILESTONE_EDIT_VERSION
            ),
            "a version-6 edit record in a saved project file must be \
             UnreadableEditRecord(6), got {:?}",
            result.err()
        );
        assert!(
            !load_dir.path().join("log.redb").exists(),
            "the fresh store must not be hydrated by a refused pre-v8.0 board"
        );

        // NON-VACUITY: the identical bundle at the CURRENT version loads. Without this
        // the assertion above would pass just as well if `load_project` had started
        // refusing every project file for some unrelated reason.
        let mut core = Core::genesis(header());
        let _source = core.state.add_source();
        let current = ProjectFile {
            version: PROJECT_FILE_VERSION,
            // One edit at tick 0 folds and advances the core to tick 1, so the bundle's
            // head_tick is 1. The stale bundle above never reaches this bookkeeping -
            // it is refused before the store is hydrated.
            head_tick: core.tick + 1,
            snapshot: fabrico_core::snapshot::snapshot(&core),
            log: Vec::new(),
            edit_log: vec![place_edit(0, 1, 1)], // stamped at EDIT_SCHEMA_VERSION
        };
        let ok_path = dir.path().join("current_board.fab");
        std::fs::write(&ok_path, postcard::to_allocvec(&current).expect("encode")).expect("write");
        let ok_dir = tempfile::tempdir().expect("fresh work_dir");
        let ok_result = load_project(&ok_path, ok_dir.path(), None);
        assert!(
            ok_result.is_ok(),
            "the same bundle at the current edit version must still load, got {:?}",
            ok_result.err()
        );
    }

    #[test]
    fn out_of_order_edit_log_rejected() {
        // ELOG-05 / T-8-LOAD-EDIT-COLLAPSE: a bundled edit-log with a duplicate /
        // out-of-order (partition, sequence) key is refused UP FRONT with
        // NonMonotonicEditLog. Re-appending such a key would silently COLLAPSE
        // entries (append_edit has no monotonicity check) — rejected before the store
        // is hydrated, never a panic.
        let mut core = Core::genesis(header());
        let _source = core.state.add_source();
        let snapshot = fabrico_core::snapshot::snapshot(&core);
        // Two records with the SAME (partition, sequence) key — the second trips the
        // strictly-increasing requirement.
        let mut a = place_edit(0, 1, 1);
        a.partition = 0;
        a.sequence = 0;
        a.tick = 0;
        let dup = a.clone();
        let bundle = ProjectFile {
            version: PROJECT_FILE_VERSION,
            head_tick: core.tick,
            snapshot,
            log: Vec::new(),
            edit_log: vec![a, dup.clone()],
        };
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("out_of_order_edit.fab");
        std::fs::write(&path, postcard::to_allocvec(&bundle).expect("encode")).expect("write");

        let load_dir = tempfile::tempdir().expect("fresh work_dir");
        let result = load_project(&path, load_dir.path(), None);
        assert!(
            matches!(
                result,
                Err(ProjectError::NonMonotonicEditLog { partition, sequence })
                    if partition == dup.partition && sequence == dup.sequence
            ),
            "a duplicate/out-of-order bundled edit key must be NonMonotonicEditLog"
        );
        assert!(
            !load_dir.path().join("log.redb").exists(),
            "the fresh store must not be hydrated by a rejected bundle"
        );
    }

    #[test]
    fn hostile_edit_replay_span_is_typed_error_no_hang() {
        // ELOG-05 / T-8-LOAD-EDIT-DOS: a bundle whose EDIT-log tick gap is 2^40 would
        // drive recover()'s two-log idle-tick replay loop ~10^12 iterations — an
        // effectively non-terminating HANG, exactly like a hostile event tick. The
        // edit-log max tick is folded into replay_end, so the pre-flight SATURATING
        // span check refuses it as a typed ReplaySpanTooLong BEFORE recover() runs.
        // This test completing FAST (it never enters the replay loop) is the no-hang
        // proof.
        const HOSTILE_TICK: u64 = 1 << 40; // ~1.1e12 ticks — far past MAX_REPLAY_SPAN
        let mut core = Core::genesis(header());
        let _source = core.state.add_source();
        // base_tick stays 0 (genesis) — so the replay span is the full 2^40 gap.
        let snapshot = fabrico_core::snapshot::snapshot(&core);
        let mut edit = place_edit(0, 1, 1);
        edit.partition = 0;
        edit.sequence = 0;
        edit.tick = HOSTILE_TICK; // a hostile edit tick (no event log at all)
        let bundle = ProjectFile {
            version: PROJECT_FILE_VERSION,
            // head_tick == max_edit_tick + 1, so the head-tick consistency check
            // PASSES and the span ceiling is what actually catches the DoS.
            head_tick: HOSTILE_TICK + 1,
            snapshot,
            log: Vec::new(),
            edit_log: vec![edit],
        };
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("hostile_edit_span.fab");
        std::fs::write(&path, postcard::to_allocvec(&bundle).expect("encode")).expect("write");

        let load_dir = tempfile::tempdir().expect("fresh work_dir");
        let result = load_project(&path, load_dir.path(), None);
        assert!(
            matches!(
                result,
                Err(ProjectError::ReplaySpanTooLong { span, limit })
                    if span == HOSTILE_TICK + 1 && limit == MAX_REPLAY_SPAN
            ),
            "a multi-year EDIT tick gap must be a typed ReplaySpanTooLong (no replay-loop hang)"
        );
        assert!(
            !load_dir.path().join("log.redb").exists(),
            "the fresh store must not be hydrated by a rejected bundle"
        );
    }
}
