//! Snapshot / restore at a clean tick boundary (REPLAY-01/02) plus the
//! configurable snapshot cadence (CONTEXT-locked: default periodic interval +
//! on-demand).
//!
//! A snapshot is the **whole [`Core`] serialized at a tick boundary** — postcard
//! captures every field with no hidden in-flight state (RESEARCH Pitfall 6/7):
//! `tick`, the [`GridState`](crate::state::GridState) projection (including each
//! belt's per-tile `slots`/`geometry` line), the [`Scheduler`](crate::scheduler::Scheduler)
//! (its `wake_wheel` *and* `active_now`), the [`SimRng`](crate::rng::SimRng)'s
//! **advanced counter state** (not just the genesis seed), and the log `cursor`.
//! Because nothing the sim needs to resume lives outside these fields, restoring
//! and continuing reaches the exact state an uninterrupted run would — the SC#2
//! guarantee proven by the proof suite.
//!
//! # Tick-boundary discipline
//! [`snapshot`] is valid **only at a clean tick boundary** — between
//! [`Core::advance`](crate::core::Core::advance) calls, after the fold has done
//! `tick += 1`. Mid-fold the active set and port buffers are transient; the
//! `Core` driver never exposes that intermediate state, so callers naturally
//! snapshot at the boundary.
//!
//! # State-equality oracle
//! The [`snapshot`] bytes double as the Phase-1 **state-equality oracle**
//! (RESEARCH A4): two `Core`s are equal iff their snapshot byte-vectors are
//! equal. The replay (SC#1) and snapshot/restore (SC#2) proofs compare these
//! byte-vectors directly.
//!
//! # Integrity discipline (threat T-1-DES)
//! [`restore`] decodes **untrusted** bytes (a snapshot is, later, a user save
//! file). It never panics: it bounds the input to
//! [`MAX_RECORD_BYTES`](crate::persist::MAX_RECORD_BYTES) and maps any decode
//! failure to a typed [`DecodeError`], consistent with the persistence-layer
//! read hardening.

use crate::core::Core;
use crate::edit::MAX_BELT_TILES;
use crate::event::{DecodeError, StateInvariant};
use crate::persist::{MAX_RECORD_BYTES, PersistenceStore};
use crate::state::{GRID_MAX, GRID_MIN, MAX_FOOTPRINT_DIM, Node, cells_of_footprint};

/// Default periodic snapshot interval, in ticks — the CONTEXT-locked "default
/// periodic interval + on-demand" cadence (600 ticks ≈ 10 s at the 60 ticks/s
/// target). The always-on driver loop (Phase 7 shell) reads this into its
/// config; passing `None` to the cadence helpers overrides it to on-demand-only.
pub const DEFAULT_SNAPSHOT_EVERY: Option<u64> = Some(600);

/// The snapshot wire-format schema version, prefixed (little-endian `u16`) onto
/// every snapshot blob. [`restore`] refuses any tag GREATER than this with
/// [`DecodeError::UnknownVersion`] (forward-version refusal) AND, as of Phase 9,
/// any tag LESS than this with [`DecodeError::SnapshotTooOld`] (clean-break
/// backward refusal), mirroring [`crate::event::upcast`] for the event log so a
/// future `Core`/`GridState`/`Scheduler` schema change can never silently
/// mis-decode an old save file into a structurally-valid-but-semantically-wrong
/// `Core` (threat T-1-DES). Bump this whenever the snapshotted `Core` shape changes.
///
/// Phase 2 bumps this 1 → 2: adding `Node::Tee`/`Node::Balancer` (and later
/// router/merge) variants changes the serialized `GridState`/`Core` shape. This
/// is forward-hygiene — no shipped v1 save files exist (SAVE-01 is Phase 6), so
/// there is no migration burden; one bump covers the whole unreleased Phase 2
/// shape evolution (the version stays 2 across plans 02/03).
///
/// Phase 4 bumps this 2 → 3: appending the `Node::Factory` variant (plain data:
/// source, gas budget, per-node `SimRng`, `ctx.state` bytes) changes the serialized
/// `Node`/`GridState`/`Core` shape. The live engine cache (`Core::factory_runtimes`)
/// is `#[serde(skip)]`, so it is NOT in the bytes — only plain factory data crosses
/// the snapshot (threat T-04-SNAP). Still forward-hygiene only: no shipped saves exist
/// (SAVE-01 is Phase 6), so there is no migration burden, and because `Factory` is
/// appended LAST (discriminant 6, with `Source`..`Router` frozen at 0..5) a tag-2
/// blob still restores (`2 <= 3`) with unchanged discriminants.
///
/// Phase 9 bumps this 3 → 4 — the spatial model moves INTO the deterministic core:
/// `GridState` gains a serialized `cells: BTreeMap<NodeId,(i32,i32)>` field appended
/// LAST (the derived `occupancy` reverse index is `#[serde(skip)]`, so it never hits
/// the wire and is rebuilt post-decode). Because `cells` now enters `blake3(snapshot)`,
/// every golden-corpus hash necessarily moves; the bump + the v4-native corpus regen
/// land as ONE isolated, separately-reviewed commit (SC#3/Q4). Unlike the prior
/// forward-hygiene-only bumps this is a **CLEAN BREAK** (decision Q1): there is NO
/// 3→4 migration shim, so [`restore`] refuses any tag `< 4` with
/// [`DecodeError::SnapshotTooOld`] (symmetric with the forward `UnknownVersion`
/// refusal). No shipped save files exist (SAVE-01 is a later milestone), so there is
/// no migration burden.
///
/// Phase 10 bumps this 4 → 5 — the multi-cell footprint model joins the serialized
/// grid: [`GridState`](crate::state::GridState) gains a `footprints: BTreeMap<NodeId,
/// Footprint>` then a `ports: BTreeMap<NodeId, Vec<Port>>` field, BOTH **appended
/// LAST** (after `cells`; the derived `occupancy` stays `#[serde(skip)]`). Because an
/// ABSENT entry means a 1×1 rot0 / port-less default, an all-1×1 grid serializes both
/// maps EMPTY — so a v4-shaped corpus body differs from its v5 re-bless by ONLY the
/// leading tag (`04 00` → `05 00`) and two trailing zero-length prefixes: the bump
/// "only generalizes" (the fold writes no map entry for a 1×1). This lands as ONE
/// isolated, separately-reviewed commit with the `EDIT_SCHEMA_VERSION` `1 → 2` bump
/// and the full corpus regen (the Phase-9 SC#3/Q4 discipline). Like the 3→4 bump it
/// is a **CLEAN BREAK** (decision Q1): [`restore`] refuses any tag `< 5` with
/// [`DecodeError::SnapshotTooOld`] (no 4→5 migration shim) and any tag `> 5` with
/// [`DecodeError::UnknownVersion`]. No shipped saves exist, so there is no migration
/// burden. The refusal arms are UNCHANGED in shape — they auto-refuse v4 now.
///
/// Phase 11 bumps this 5 → 6 — the per-tile slot-belt clean break: `Node::Belt`
/// changes shape from `{ latency, in_flight }` to `{ tiles, slots, geometry }`, so
/// EVERY snapshot byte containing a belt (and every belt's per-tick replay hash)
/// moves. This is the deliberate CLEAN BREAK (CONTEXT, pre-v1 policy): the golden
/// corpus 0001-0011 is re-blessed and the bump lands ALONGSIDE the
/// [`EDIT_SCHEMA_VERSION`](crate::edit::EDIT_SCHEMA_VERSION) `2 → 3` bump as one
/// isolated, separately-reviewed act (the Phase-9 SC#3/Q4 discipline). Like the
/// prior clean breaks [`restore`] refuses any tag `< 6` with
/// [`DecodeError::SnapshotTooOld`] (no 5→6 migration shim) and any tag `> 6` with
/// [`DecodeError::UnknownVersion`]. No shipped saves exist, so there is no migration
/// burden. The refusal arms are UNCHANGED in shape — they auto-refuse v5 now.
///
/// Phase 17 bumps this 6 → 7 — the coordinated core re-bless. This bump is
/// **POLICY-driven, NOT byte-forced**: the phase's headline model change,
/// [`Role::Fault`](crate::state::Role) appended LAST on the `Role` enum, is a pure
/// ADDITIVE postcard varint index — every existing serialized `In`/`Out` port stays
/// byte-identical, so `Role::Fault` alone would NOT require a bump. The DELIBERATE
/// reason to spend the bump here is the [`Factory::faults`](crate::state::Factory)
/// counter field (appended LAST on `Factory`, the undocked-fault DROP counter,
/// CONTEXT Area 2): it changes the `Factory` machine-state layout, and it lands in
/// the SAME quarantined, separately-reviewed commit as the new-model corpus regen
/// (Wire-removed + 3×3 factory + fault-dock) — the Phase-9/10/11/12 discipline of
/// spending the snapshot blast-radius EXACTLY ONCE rather than taking a second bump
/// later. Like the prior clean breaks [`restore`] refuses any tag `< 7` with
/// [`DecodeError::SnapshotTooOld`] (no 6→7 migration shim) and any tag `> 7` with
/// [`DecodeError::UnknownVersion`]. No shipped saves exist, so there is no migration
/// burden. The refusal arms are UNCHANGED in shape — they auto-refuse v6 now.
///
/// Phase 35 bumps this 7 -> 8 - the v6.0 coordinated re-bless ("The One Re-bless"),
/// BYTE-FORCED by the new [`Port.medium`](crate::state::Port) field: each stored port
/// grows one varint, so every snapshot byte containing a port (and every per-tick
/// replay hash) moves. It lands in LOCKSTEP with
/// [`EDIT_SCHEMA_VERSION`](crate::edit::EDIT_SCHEMA_VERSION) `5 -> 6`, `PROJECT_FILE_VERSION`
/// `5 -> 6`, event [`SCHEMA_VERSION`](crate::event::SCHEMA_VERSION) `1 -> 2`, and cmd-wire
/// [`EVENT_VERSION`](crate::command::EVENT_VERSION) `2 -> 3` - the single coordinated act
/// that spends the corpus blast radius EXACTLY ONCE for all of v6.0 (the Phase-9/10/11/12/17
/// discipline). Pre-v1 CLEAN BREAK: [`restore`] refuses any tag `< 8` with
/// [`DecodeError::SnapshotTooOld`] (see the frozen-v7 witness), any tag `> 8` with
/// [`DecodeError::UnknownVersion`]. No shipped saves; no migration shim. The single
/// coordinated golden re-bless is quarantined to its own commit.
///
/// Phase 60 bumps this 8 -> 9, BYTE-FORCED by the belt slot-density change
/// (`60-CONTEXT.md`, 2026-08-09): a belt's slot vector grows from three entries per
/// tile to four, so the serialized shape of EVERY stored belt changes and every
/// per-tick replay hash of every belt-bearing fixture moves with it. An empty slot
/// serialises as a one-byte postcard none-marker, so a genesis blob grows by exactly
/// one byte per belt tile. It lands in LOCKSTEP with `PROJECT_FILE_VERSION` `6 -> 7`
/// and with NOTHING else: unlike the v6.0 re-bless above, which moved all five
/// version constants because a new `Port` field genuinely byte-forced all five, here
/// only the SNAPSHOT shape moves. [`EDIT_SCHEMA_VERSION`](crate::edit::EDIT_SCHEMA_VERSION),
/// event [`SCHEMA_VERSION`](crate::event::SCHEMA_VERSION) and cmd-wire
/// [`EVENT_VERSION`](crate::command::EVENT_VERSION) are deliberately UNCHANGED, since
/// bumping them would be cargo-culting that precedent rather than following it.
///
/// This is the constant that actually REFUSES, and that is why it is the one bumped.
/// Without it a pre-change save would decode straight past the version gate and then
/// fail the structural
/// [`StateInvariant::BeltSlotCount`](crate::event::StateInvariant::BeltSlotCount)
/// trust gate, which surfaces to a user as something indistinguishable from file
/// corruption. Refusing on the VERSION instead is the whole of D-02's clean break.
/// Pre-v1 CLEAN BREAK, and the padding migration (`3N` slots to `4N` on decode) was
/// REJECTED on correctness grounds, not effort: inserting a slot per tile moves every
/// resident item, so a migrated board would silently resume in a state its owner
/// never saved. A save that quietly resumes wrong is worse than one that honestly
/// refuses. [`restore`] refuses any tag `< 9` with [`DecodeError::SnapshotTooOld`]
/// (see the frozen-v8 belt-bearing witness) and any tag `> 9` with
/// [`DecodeError::UnknownVersion`]. The refusal arms are UNCHANGED in shape: they
/// auto-refuse tag 8 from here.
///
/// Phase 62 bumps this 9 -> 10, BYTE-FORCED by the per-belt advance interval
/// (`62-CONTEXT.md` D-01/D-14, SLOT-03/SLOT-04, 2026-08-13): `Belt` gained a
/// serialized `ticks_per_slot` field, so every stored belt grows one trailing varint
/// and every per-tick replay hash of every belt-bearing fixture moves with it. It
/// lands in LOCKSTEP with `PROJECT_FILE_VERSION` `7 -> 8` and with NOTHING else, for
/// the same scoping reason the Phase 60 paragraph above gives: only the SNAPSHOT
/// shape moved, so [`EDIT_SCHEMA_VERSION`](crate::edit::EDIT_SCHEMA_VERSION), event
/// [`SCHEMA_VERSION`](crate::event::SCHEMA_VERSION) and cmd-wire
/// [`EVENT_VERSION`](crate::command::EVENT_VERSION) are deliberately UNCHANGED.
///
/// This bump is FORCED rather than chosen, and the forcing is sharper here than at
/// Phase 60. postcard is not self-describing, so without it a pre-change blob does
/// not merely fail a later structural gate: it runs OUT OF BYTES decoding the
/// appended field and returns [`DecodeError::Malformed`], which is the single most
/// corruption-shaped error this decoder has. A user shown "malformed" about a file
/// that is byte-for-byte intact has been told something false. Refusing on the
/// VERSION is what makes the refusal honest.
///
/// Note WHAT the refusal is about, because it changes what the message may say: the
/// SHAPE changed, not the value. The interval ships at its pre-change identity, and
/// once it is per-belt serialized state a saved file carries its OWN intervals and
/// replays correctly whatever the construction default later becomes. So no
/// migration is possible on correctness grounds (a migration would have to pick an
/// interval for every saved belt, re-timing a board its owner never re-timed), and
/// no interval VALUE belongs in any refusal message. Pre-v1 CLEAN BREAK: [`restore`]
/// refuses any tag `< 10` with [`DecodeError::SnapshotTooOld`] (see the frozen-v9
/// belt-bearing witness, whose bytes are a real committed corpus fixture) and any tag
/// `> 10` with [`DecodeError::UnknownVersion`]. The refusal arms are UNCHANGED in
/// shape: they auto-refuse tag 9 from here.
///
/// # NOT moved by the v8.0 edit-log clean break (Phase 63, `63-11`)
/// The list above records which bumps moved which constants, so a later reader can tell
/// "deliberately unmoved" from "forgotten". It now runs in the opposite direction and
/// must say so: at Phase 63,
/// [`EDIT_SCHEMA_VERSION`](crate::edit::EDIT_SCHEMA_VERSION) moves `6 -> 7` and THIS
/// constant deliberately does NOT move, along with `PROJECT_FILE_VERSION`, event
/// [`SCHEMA_VERSION`](crate::event::SCHEMA_VERSION) and cmd-wire
/// [`EVENT_VERSION`](crate::command::EVENT_VERSION).
///
/// The reason is the same scoping rule the Phase 60 and Phase 62 paragraphs above
/// apply, read the other way: no `GridState` shape changed in milestone v8.0, so a
/// stored snapshot decodes byte-for-byte as it always did. The edit-log bump is not
/// byte-forced at all - it is a deliberate refusal of pre-v8.0 edit logs, authorised by
/// the maintainer on 2026-08-18 on the grounds that the system is not in production use. Bumping
/// this constant alongside it would be cargo-culting the v6.0 re-bless, which moved all
/// five only because a new `Port` field genuinely byte-forced all five.
///
/// The one visible consequence, so it is not re-derived wrongly: a pre-v8.0 `.fab`
/// project file is refused, but it is refused by
/// [`check_version`](crate::edit::check_version) on its EDIT LOG, not by [`restore`] on
/// its snapshot. `core_version_consts_are_frozen` in `fabrico-host/tests/endpoint.rs`
/// pins all five as hand-written literals and is what makes "exactly one of the five
/// moved" machine-checked rather than asserted here.
///
/// # `10 -> 11`, the Phase 72 Route-path break (72-07, D-20, plan 72-12)
/// Byte-forced, and the force is nameable in one sentence: `Node::Endpoint` was a
/// ZERO-FIELD marker from Phase 38 until Phase 72, and it now carries one
/// length-prefixed `String` (its Route path, the address the user types). Any board
/// holding an `Endpoint` therefore serializes DIFFERENTLY, which plan 72-07 measured on
/// two scenario digests and the host-side demo digest rather than predicted.
///
/// Without this bump `restore` would demand `tag == 10` on a v10 file whose body is
/// SHORT by the appended path, so an intact pre-Phase-72 save would come back as
/// [`DecodeError::Malformed`] - the most corruption-shaped error this decoder has, about
/// a file that is byte-for-byte intact. With it, that save is refused as
/// [`DecodeError::SnapshotTooOld(10)`](DecodeError::SnapshotTooOld), which is the honest
/// answer and the one the refusal arms already knew how to give. Pre-v1 CLEAN BREAK, no
/// upcast shim: a migration would have to invent a path for every saved Route.
///
/// In lockstep with `PROJECT_FILE_VERSION` `8 -> 9` and cmd-wire
/// [`EVENT_VERSION`](crate::command::EVENT_VERSION) `3 -> 4`, and with NOTHING else:
/// [`EDIT_SCHEMA_VERSION`](crate::edit::EDIT_SCHEMA_VERSION) stays 7 and event
/// [`SCHEMA_VERSION`](crate::event::SCHEMA_VERSION) stays 2, because every edit-side
/// change this phase made is an APPEND AT THE LAST POSITION (D-21). Three of five moved,
/// and `core_version_consts_are_frozen` is what makes that claim machine-checked.
///
/// # `11 -> 12`, the Phase 74 belt-is-a-ported-node break (74-02, D-09, LINK-08)
/// A `Belt` declared NO ports until Phase 74 and now declares TWO, written into the
/// same `GridState.ports` map machine ports have always lived in (D-04: STORED in the
/// core, not derived on read). Every stored belt therefore grows two `Port` records, so
/// every belt-bearing board serializes differently and every per-tick replay hash that
/// rides those bytes moves with it. MEASURED rather than predicted, by plan 74-01 in a
/// scratch worktree: 11 of the 33 golden fixtures hold 13 belts at genesis and gain 26
/// port records between them, while all 33 move on the version tag alone.
///
/// Why a belt gets ports at all: until this phase a belt end and a machine port were
/// two different nouns, so two belt runs could not be joined and the only junction a
/// user could build was a machine. From here there is ONE noun, a ported node's port,
/// and the belt-to-belt dock is judged by the SAME adjacency, facing and role rule in
/// the SAME validate arm. A pre-thaw board's belts carry no ports and are therefore
/// un-linkable, which is what makes this a break rather than an append: deriving the
/// ports on read instead would leave a second source of truth for them AND would not
/// make an old board's belts joinable.
///
/// # THIS BUMP IS NOT BYTE-FORCED, AND THE DANGER IT PREVENTS IS WORSE THAN THE USUAL ONE
/// Stated plainly because every SNAPSHOT bump above this one except Phase 63's EDIT bump
/// WAS byte-forced, and a reader who assumed the pattern held would draw the wrong
/// conclusion about what a pre-thaw file does without the refusal.
///
/// `ports` is a `BTreeMap` that has existed since Phase 10, and no struct gained a field
/// here: a belt simply gains an ENTRY in a map that was already serialized. So postcard
/// does NOT run out of bytes on a v11 body, the way it does on the Phase 60, 62 and 72
/// bodies. MEASURED, not reasoned: a v11 blob re-tagged forward to 12 DECODES
/// SUCCESSFULLY, passes the trust gate, and comes back as a board whose belts answer
/// `ports_of(belt) == None`.
///
/// That is a SILENT MIS-DECODE, and it is strictly worse than the corruption-shaped
/// `Malformed` the earlier paragraphs argue against. A `Malformed` at least tells the
/// user something happened. This would open their board, show it, and let them try to
/// join two runs on it - and the join would refuse, from the same `InvalidDock` a
/// genuinely illegal dock earns, with nothing anywhere naming the real cause. The
/// refusal is therefore DELIBERATE rather than forced, on the Phase 63 precedent, and
/// the frozen v10 and v11 witnesses below demonstrate exactly this: their re-tagged
/// companions assert the un-ported decode rather than a decode error, because asserting
/// an error would be asserting something untrue.
///
/// Pre-v1 CLEAN BREAK, no upcast shim: [`restore`] refuses any tag `< 12` with
/// [`DecodeError::SnapshotTooOld`] and any tag `> 12` with
/// [`DecodeError::UnknownVersion`]. TWO frozen witnesses land with this bump rather
/// than one: a v11 blob (this bump's own red) and a v10 blob (phase 72 spent version
/// 10 without adding one, so the chain had a hole at 10 and it is filled here).
///
/// In lockstep with `PROJECT_FILE_VERSION` `10 -> 11` and with NOTHING else: a
/// ProjectFile embeds a snapshot, so it moves with it, while
/// [`EDIT_SCHEMA_VERSION`](crate::edit::EDIT_SCHEMA_VERSION) stays 8, event
/// [`SCHEMA_VERSION`](crate::event::SCHEMA_VERSION) stays 2 and cmd-wire
/// [`EVENT_VERSION`](crate::command::EVENT_VERSION) stays 4. TWO of the five moved,
/// and `core_version_consts_are_frozen` is what makes that claim machine-checked.
///
/// # `12 -> 13`, the Phase 85 Email removal (85-05, D-08, CHROME-04)
/// WHAT MOVED: `SinkTemplate::Email` was DELETED, with no placeholder variant, so
/// `SinkTemplate::Http` moved from discriminant 2 to 1. Every snapshot holding an HTTP
/// sink therefore means something different byte for byte, and postcard is not
/// self-describing: an old blob would restore with its sinks read against the shifted
/// list. WHY: the shipped app could never send mail (no SMTP sender was ever
/// configured, and plan 85-04 removed the sender), so the target was removed rather
/// than kept dormant. MEASURED: all 35 golden fixtures move on the tag; golden 0006 also
/// carries an HTTP sink whose discriminant byte moves. Pre-v1 CLEAN BREAK, no upcast
/// shim: [`restore`] refuses any tag `< 13` with [`DecodeError::SnapshotTooOld`] and any
/// tag `> 13` with [`DecodeError::UnknownVersion`]. Frozen witness:
/// `frozen_v12_http_sink_snapshot_is_refused_as_snapshot_too_old_under_v13`.
///
/// In lockstep with [`EDIT_SCHEMA_VERSION`](crate::edit::EDIT_SCHEMA_VERSION) `11 -> 12`
/// (a `Configure` record can carry a `SinkTemplate`) and cmd-wire
/// [`EVENT_VERSION`](crate::command::EVENT_VERSION) `4 -> 5` (`Effect::Email` left the same
/// way). Event [`SCHEMA_VERSION`](crate::event::SCHEMA_VERSION) stays 2, and
/// `PROJECT_FILE_VERSION` stays 11 until its final v12 shape lands in plan 85-09 (D-07).
/// Three of five moved, and `core_version_consts_are_frozen` checks it.
///
/// # `13 -> 14`, phase 87's four fields (87-03, JAM-01, D-02 to D-07)
/// WHAT MOVED: four fields, each appended LAST in its struct so every earlier field
/// keeps its postcard position: `Balancer::next_in: u16` (the input pointer the
/// two-input scan needs, JAM-01), `Tee::faults: u64` (copies a busy branch could not
/// take, JAM-02), `Factory::pending_emits: BTreeMap<PortId, VecDeque<Item>>` (emits
/// waiting for the belt, JAM-05) and `Scheduler::blocked: BTreeSet<NodeId>` (machines
/// asleep behind a blocked output, JAM-04). Postcard is positional and not
/// self-describing, so a v13 body would decode its Balancers, Tees and Factories one
/// field short and its scheduler with no `blocked` set: a silent mis-decode, refused
/// by the tag instead. WHY ONE BUMP: all four are serialized state phase 87 adds, and
/// a second bump would move every fixture a second time ("no tricks, take the schema
/// bump"; the plans that fill the other three fields, 87-04 to 87-06, take none). Every
/// golden fixture moves on the tag and on its own `Scheduler`. Pre-v1 CLEAN BREAK, no
/// upcast shim: [`restore`] refuses any tag `< 14` with [`DecodeError::SnapshotTooOld`]
/// and any tag `> 14` with [`DecodeError::UnknownVersion`]. Frozen witness:
/// `frozen_v13_snapshot_is_refused_as_snapshot_too_old_under_v14`, a v13 board holding
/// a Balancer, a Tee and a Factory.
///
/// In lockstep with `PROJECT_FILE_VERSION` `12 -> 13` and with nothing else: a
/// ProjectFile embeds a snapshot, so it moves with it (the 74-02 reason), while
/// [`EDIT_SCHEMA_VERSION`](crate::edit::EDIT_SCHEMA_VERSION) stays 13, event
/// [`SCHEMA_VERSION`](crate::event::SCHEMA_VERSION) stays 2 and cmd-wire
/// [`EVENT_VERSION`](crate::command::EVENT_VERSION) stays 5: no `EditOp`, event or
/// `Effect` changes. Two of five moved, and `core_version_consts_are_frozen` checks it.
pub const SNAPSHOT_SCHEMA_VERSION: u16 = 14;

/// Serialize the whole [`Core`] at a clean tick boundary into snapshot bytes.
///
/// postcard captures every field — `tick`, `GridState` (incl. belt `slots`/`geometry`),
/// `Scheduler` (`wake_wheel` + `active_now`), the advanced `SimRng` state, and
/// `cursor` — so there is **no hidden in-flight state** (REPLAY-01, RESEARCH
/// Pitfall 6/7). The bytes are also the Phase-1 state-equality oracle.
///
/// Valid ONLY between `advance()` calls (after the fold's `tick += 1`).
///
/// The bytes are prefixed with a little-endian [`SNAPSHOT_SCHEMA_VERSION`] tag so
/// [`restore`] can refuse a forward-versioned blob instead of mis-decoding it.
pub fn snapshot(core: &Core) -> Vec<u8> {
    // Prefix the schema tag, then the postcard body.
    let mut bytes = SNAPSHOT_SCHEMA_VERSION.to_le_bytes().to_vec();
    // `Core` is plain serde data (no maps with non-serializable keys, no
    // unbounded recursion), so allocvec serialization is infallible in practice;
    // an `expect` here documents that invariant rather than threading a `Result`
    // through every caller of the equality oracle.
    let body = postcard::to_allocvec(core)
        .expect("Core is plain serde data; snapshot serialization is infallible");
    bytes.extend_from_slice(&body);
    bytes
}

/// Decode a [`Core`] from snapshot bytes taken at a tick boundary.
///
/// Never panics. Bounds the input to [`MAX_RECORD_BYTES`] (threat T-1-DES),
/// strips and checks the leading little-endian [`SNAPSHOT_SCHEMA_VERSION`] tag —
/// refusing a forward-versioned blob with [`DecodeError::UnknownVersion`] and a
/// too-old blob (`tag < SNAPSHOT_SCHEMA_VERSION`) with [`DecodeError::SnapshotTooOld`]
/// (the Phase-9 clean break, decision Q1 — no migration shim), both mirroring
/// [`crate::event::upcast`] — and maps any postcard failure on the body to
/// [`DecodeError::Malformed`]. A blob too short to carry the 2-byte tag, or
/// oversized, is refused as `Malformed`. After a successful decode it rebuilds the
/// `#[serde(skip)]` occupancy index from the serialized `cells` source (Pitfall 3)
/// BEFORE the trust gate.
///
/// Between the decode and that rebuild it runs [`validate_footprint_bounds`], which
/// bounds every attacker-controlled LENGTH the rebuild or the fold would otherwise walk:
/// footprint dimensions, grid anchors, belt geometry, the wire `in_flight` FIFO, since
/// Phase 71 the inbox buckets ([`StateInvariant::InboxTooMany`]) and a source's
/// `pending` deque ([`StateInvariant::SourcePendingTooMany`]), and since Phase 72 a
/// Route's `path` ([`StateInvariant::EndpointPathTooLong`]) - the first STRING on a
/// serialized node, and therefore the first member of this list that is not a
/// collection length.
pub fn restore(bytes: &[u8]) -> Result<Core, DecodeError> {
    // Bound the allocation an oversized / hostile blob can trigger before
    // touching the bytes.
    if bytes.len() > MAX_RECORD_BYTES {
        return Err(DecodeError::Malformed);
    }
    // Strip and check the schema tag before decoding the body. `split_at_checked`
    // yields `None` (→ Malformed) for a blob too short to even carry the tag.
    let (tag, body) = bytes.split_at_checked(2).ok_or(DecodeError::Malformed)?;
    let tag = u16::from_le_bytes([tag[0], tag[1]]);
    if tag > SNAPSHOT_SCHEMA_VERSION {
        return Err(DecodeError::UnknownVersion(tag));
    }
    // Phase-9 clean break (Q1): a too-old blob is refused with a typed error, never
    // a panic and never a silent mis-decode — symmetric with the forward refusal.
    // No migration switch exists (no shipped saves predate v4).
    if tag < SNAPSHOT_SCHEMA_VERSION {
        return Err(DecodeError::SnapshotTooOld(tag));
    }
    let mut core = postcard::from_bytes::<Core>(body).map_err(|_| DecodeError::Malformed)?;
    // CR-01: bound the attacker-controlled footprint DIMENSIONS *before*
    // `rebuild_occupancy` (and the class-invariant gate) expand them. `rebuild_occupancy`
    // runs ahead of `validate_invariants`, so a forged `w = h = u16::MAX` footprint
    // would otherwise drive an unbounded multi-GiB `occupancy` allocation here — a
    // tiny-input amplification bomb. This pre-rebuild check rejects out-of-envelope
    // dims with a typed `FootprintTooLarge`, so expansion is provably bounded
    // (≤ MAX_FOOTPRINT_DIM² cells per node). Reject-only — a valid Core is untouched.
    validate_footprint_bounds(&core)?;
    // Rebuild the derived (#[serde(skip)]) occupancy index from the trusted
    // serialized `cells` source — it decodes EMPTY on the wire (Pitfall 3) — before
    // the trust gate / return, so `occupied`/`cell_of` are valid on the restored Core.
    core.state.rebuild_occupancy();
    // And the derived (#[serde(skip)]) reverse link index from the serialized `links`
    // (phase 87, JAM-04, D-06): without it a machine restored asleep behind a blocked
    // output would never be woken by the consumer that frees its slot.
    core.state.rebuild_feeders();
    // Post-decode trust gate: a structurally-valid `Core` can still encode a
    // corrupt grid/scheduler state that would panic the deterministic core
    // (RESEARCH A1, threat T-06-01-DOS). Reject it with a typed error before
    // handing the `Core` back. REJECT-ONLY — the decoded bytes are never
    // mutated, so a valid `Core` (corpus 0001-0006) is returned identical and
    // SNAPSHOT_SCHEMA_VERSION is NOT bumped.
    validate_invariants(&core)?;
    Ok(core)
}

/// Pre-rebuild bound check on the attacker-controlled SPATIAL fields (CR-01) — runs
/// in [`restore`] BEFORE [`crate::state::GridState::rebuild_occupancy`] expands any
/// footprint into the `occupancy` index, so an out-of-envelope dimension is rejected
/// before it can drive an unbounded allocation.
///
/// **REJECT-ONLY**: borrows `core`, never mutates. Every recorded [`Footprint`]
/// (`crate::state::Footprint`) must carry `1 <= w,h <= MAX_FOOTPRINT_DIM` — the
/// documented overflow-safety envelope `cells_of_footprint`/`port_world` rely on, and
/// the cap that bounds each node's occupancy expansion to at most
/// `MAX_FOOTPRINT_DIM²` cells. A forged `w = h = u16::MAX` (which would expand to ~4.3
/// billion cells) — or a degenerate `w == 0`/`h == 0` — is refused with
/// [`StateInvariant::FootprintTooLarge`]. A live `Core` never trips this (the catalog
/// only emits `1 <= w,h <= MAX_FOOTPRINT_DIM`), so a valid snapshot round-trips
/// byte-identically (no corpus drift, no version bump).
///
/// It ALSO bounds every decoded `cells` anchor to the verified grid extent
/// `[GRID_MIN, GRID_MAX]` on both axes (CR-02). `cells` is attacker-controlled, so an
/// anchor at `i32::MAX` paired with a multi-cell footprint would overflow the
/// `anchor + (dim-1)` arithmetic in `cells_of_footprint` on the pre-gate
/// `rebuild_occupancy` path. Bounding the anchor here (paired with the dim cap above)
/// makes that arithmetic provably overflow-free; an out-of-extent anchor is refused
/// with [`StateInvariant::CellOutOfBounds`]. A live grid's anchors are command-layer
/// bounds-checked, so a valid snapshot is untouched.
///
/// # It has outgrown its name, and the name is kept deliberately
///
/// Since Phase 11 this function has also bounded belt geometry, since Phase 37 the wire
/// `in_flight` FIFO, and since Phase 71 the inbox buckets and the source `pending`
/// deque. What it actually is, and always was, is THE PRE-`rebuild_occupancy` BOUND
/// PHASE: every check whose absence would let attacker-controlled bytes drive an
/// unbounded allocation before the trust gate runs. Renaming it would move every one of
/// those checks in a diff for no behaviour, so the name stays and this paragraph says
/// what it means.
///
/// # The Phase 71 queue bounds, and the ONE case deliberately left open
///
/// [`StateInvariant::InboxTooMany`] bounds two classes and only two: the reserved
/// [`crate::fault::FAULT_PORT`] bucket on every node, and any bucket on a port DECLARED
/// [`Medium`](crate::state::Medium)`::Mechanical`. An UNDECLARED port is NOT bounded,
/// because a snapshot does not carry the EMITTER and an over-cap electrical fan-in into
/// a port-less collector (golden `0026-wire-cap-overflow-fanin`) is byte-identical to a
/// forged over-cap mechanical inbox. The reasoning is written out in full at the check
/// itself; the accepting case has its own test so a later "tightening" reddens rather
/// than silently refusing a legitimate board.
fn validate_footprint_bounds(core: &Core) -> Result<(), DecodeError> {
    for (_id, fp) in core.state.footprints_iter() {
        if fp.w == 0 || fp.h == 0 || fp.w > MAX_FOOTPRINT_DIM || fp.h > MAX_FOOTPRINT_DIM {
            return Err(DecodeError::InvalidState(StateInvariant::FootprintTooLarge));
        }
        // WR-02: `rot` must lie in the documented `0..=3` quarter-turn range. Consumers
        // mask, so this is contract-hygiene (a validated Core must not carry an
        // out-of-contract rot); a live grid only stores masked rots, so valid bytes pass.
        if fp.rot > 3 {
            return Err(DecodeError::InvalidState(StateInvariant::FootprintBadRot));
        }
    }
    for (_id, (x, y)) in core.state.cells_iter() {
        if !(GRID_MIN..=GRID_MAX).contains(&x) || !(GRID_MIN..=GRID_MAX).contains(&y) {
            return Err(DecodeError::InvalidState(StateInvariant::CellOutOfBounds));
        }
    }
    // T-11-DRAWBELT-BOMB (Phase 11): bound the attacker-controlled belt geometry
    // BEFORE `rebuild_occupancy` expands every tile cell into the `occupancy` index.
    // A forged belt carrying millions of tiles would otherwise drive an unbounded
    // allocation here; the cap (mirror `FootprintTooLarge`) turns that DoS into a
    // typed rejection. A live drawn belt is a hand-dragged path far below the cap.
    for id in core.state.node_ids() {
        if let Some(Node::Belt(belt)) = core.state.node(id) {
            if belt.geometry.len() as u64 > u64::from(MAX_BELT_TILES) {
                return Err(DecodeError::InvalidState(StateInvariant::BeltTilesTooMany));
            }
            // WR-01: bound every belt tile cell to the grid extent `[GRID_MIN, GRID_MAX]`,
            // mirroring the machine-anchor check above and the command-layer
            // (`command.rs`) + edit-log decode (`edit.rs`) guards. Without this the gate
            // accepts a forged off-grid belt tile that the equivalent forged edit-record
            // is refused — a reject-only envelope ASYMMETRY on a security-critical gate
            // meant to refuse forged/non-round-tripping state symmetrically. (Belt tile
            // cells are only `BTreeMap` keys / collision-dedup entries, never fed to the
            // `anchor + (dim-1)` arithmetic, so this closes the envelope, not an overflow.)
            for tile in &belt.geometry {
                if !(GRID_MIN..=GRID_MAX).contains(&tile.cell.0)
                    || !(GRID_MIN..=GRID_MAX).contains(&tile.cell.1)
                {
                    return Err(DecodeError::InvalidState(StateInvariant::CellOutOfBounds));
                }
            }
        }
    }
    // T-37-10-OVERSIZE (Phase 37, WIRE-03): bound the attacker-controlled wire
    // `in_flight` FIFO BEFORE the trust gate / fold walk it, mirroring the belt-tiles
    // cap above. The live `crate::wire::admit` REFUSES admission at
    // `WIRE_INFLIGHT_CAP` (never grows past it), so an over-cap FIFO is unreachable
    // from any live fan-out — only a hand-forged snapshot can carry one. Rejecting it
    // here (in the pre-`rebuild_occupancy` phase, the DRAWBELT-BOMB precedent) turns a
    // forged unbounded in-flight length into a typed rejection, never an OOM. A live
    // wire's FIFO is bounded at admission, so a valid snapshot never trips this.
    for id in core.state.node_ids() {
        if let Some(Node::Wire(link)) = core.state.node(id)
            && link.in_flight.len() as u64 > crate::wire::WIRE_INFLIGHT_CAP as u64
        {
            return Err(DecodeError::InvalidState(StateInvariant::WireInFlightTooMany));
        }
    }
    // T-72-07-01 (Phase 72, SERVE-08): bound the attacker-controlled Route `path`, the
    // FIRST `String` on a serialized node and therefore a NEW member of the list this
    // function's caller enumerates. Same pre-`rebuild_occupancy` phase as the wire and
    // belt caps above and for the same reason: a forged unbounded length must become a
    // typed rejection before the trust gate or the fold walks it, never an OOM.
    //
    // THE NUMBER IS READ, NOT RESTATED. `MAX_ENDPOINT_PATH_BYTES` is the SAME constant
    // `fabrico-command`'s `Configure` validate arm reads, because phase 71's ruling
    // (see the `wire_terminals` exemption below, and `:443-453`) says the restore bound
    // must ACCEPT WHAT THE LIVE PATH CAN PRODUCE. A restore bound one byte tighter than
    // the write bound turns a board the command layer accepted into a save that will not
    // open, which is data loss arriving long after the edit that caused it. Two literals
    // is the drift `68-UI-SPEC` FINDING 1 is the worked example of.
    //
    // LENGTH ONLY. The unreserved-byte rule (`edit::endpoint_path_is_valid`) is
    // deliberately NOT applied here: it is a write-side policy, and enforcing a policy
    // on the load path makes a later widening of the allowed alphabet retroactively
    // unload boards that were legal when they were saved. That is the same distinction
    // `CommandError::PaceOutOfRange`'s docblock draws between a data invariant and a UI
    // range choice, and it is drawn the same way here.
    //
    // Phase 76 (plan 76-04, SHAPE-13, D-06, threat T-76-12): a label's `text` is the
    // SECOND string on a serialized node, and the same loop bounds it, in the same
    // pre-`rebuild_occupancy` phase, reading `crate::edit::MAX_LABEL_BYTES` (the write
    // gate's number, never restated). It accepts exactly what the live path can produce:
    // a label of exactly the cap restores. LENGTH only, no content policy; the size is
    // `FootprintTooLarge` above and the colour is a closed enum that fails to decode.
    for id in core.state.node_ids() {
        match core.state.node(id) {
            Some(Node::Endpoint(ep)) if ep.path.len() > crate::edit::MAX_ENDPOINT_PATH_BYTES => {
                return Err(DecodeError::InvalidState(
                    StateInvariant::EndpointPathTooLong,
                ));
            }
            Some(Node::Label(label)) if label.text.len() > crate::edit::MAX_LABEL_BYTES => {
                return Err(DecodeError::InvalidState(StateInvariant::LabelTextTooLong));
            }
            _ => {}
        }
    }
    // T-71-04-01 (Phase 71, PILE-09): bound the attacker-controlled INBOX buckets, the
    // `PortInbox` analog of the wire cap above and in the same pre-`rebuild_occupancy`
    // phase for the same reason - a forged unbounded queue length must become a typed
    // rejection before the trust gate or the fold walk it, never an OOM.
    //
    // EXACTLY TWO CLAUSES ARE CHECKED, and the third case a reader will expect is
    // DELIBERATELY ABSENT (ruling R-19):
    //
    //   1. Every node's reserved `FAULT_PORT` bucket, against `FAULT_QUEUE_CAP`. This
    //      needs no port declaration to be unambiguous: `FAULT_PORT` is `u16::MAX` and
    //      is never a declared port index, so its admission class is fixed by clause 1
    //      of `admit::inbox_class` for every node in the grid.
    //   2. Every bucket on a port DECLARED `Medium::Mechanical`, against
    //      `MECHANICAL_INBOX_CAP` - EXCEPT where a live `Node::Wire` terminates, which
    //      is the WR-07 exemption spelled out above the walk itself.
    //
    // AN UNDECLARED PORT IS NOT BOUNDED HERE, AND THAT IS THE DESIGN. The same proof
    // that forced the emitter-side classifier in `admit::admit_class` applies again one
    // level harder: a snapshot does not carry the EMITTER. An inbox holding 256
    // electrically-delivered items on an undeclared port is byte-indistinguishable from
    // a forged over-cap mechanical inbox, and golden `0026-wire-cap-overflow-fanin`
    // holds exactly that state on a port-less `add_source()` collector. Bounding an
    // undeclared port would refuse a legitimate corpus board.
    //
    // What is left uncovered is bounded, not unbounded: `restore` already refuses any
    // blob over `MAX_RECORD_BYTES` before decoding, so the residual is a bounded
    // allocation. And every USER-REACHABLE board is catalog-placed and therefore has
    // declared ports; the port-less nodes in the corpus are core-built test collectors.
    //
    // A LATER READER WILL WANT TO "TIGHTEN" THIS. The accepting case is pinned by its
    // own test (`restore_accepts_over_cap_inbox_on_a_port_less_node`) so that tightening
    // reddens instead of silently refusing golden 0026's board shape (threat
    // T-71-04-05).
    //
    // WIRE TERMINALS ARE EXEMPT, AND THAT IS THE SAME PROOF ONE STEP FURTHER (WR-07).
    // Live admission classifies by EMITTER FIRST (`admit::admit_class` clause 2): a
    // delivery whose emitter is a `Node::Wire` is `Electrical` and exempt WHATEVER
    // medium the destination port declares. Clause 2 above reads the DESTINATION MEDIUM
    // only, so before this exemption the restore bound was STRICTER than the path that
    // produces the state - and a state the fold can legitimately produce could not be
    // reloaded. `fold_draw_wire` applies frozen records VERBATIM and never re-validates,
    // so a wire whose `to` names a declared-Mechanical port is minted, delivers past
    // sixteen legally, and the resulting save file was then refused on load naming a
    // forgery. Save/load is the project's core value; the two readings must agree, and
    // the honest agreement is to accept what the live path can produce.
    //
    // Computed ONCE into a `BTreeSet` rather than per port: a `BTreeSet` walk keeps the
    // refusal a pure function of the bytes (no `HashMap` iteration order anywhere on the
    // trust path), and the alternative - scanning every node for every occupied bucket -
    // is quadratic on exactly the input an attacker chooses the size of.
    let wire_terminals: std::collections::BTreeSet<(crate::ids::NodeId, crate::ids::PortId)> = core
        .state
        .node_ids()
        .filter_map(|id| match core.state.node(id) {
            Some(Node::Wire(link)) => Some(link.to),
            _ => None,
        })
        .collect();
    for id in core.state.node_ids() {
        let Some(inbox) = core.state.inbox_of(id) else {
            continue;
        };
        // `ports_sorted` yields only the buckets that actually hold something, in
        // ascending `PortId` order - a `BTreeMap` key walk, so the refusal a forged
        // snapshot gets is a pure function of its bytes and never of an arrival order.
        for port in inbox.ports_sorted() {
            let cap = if port == crate::fault::FAULT_PORT {
                crate::admit::FAULT_QUEUE_CAP
            } else if wire_terminals.contains(&(id, port)) {
                // A live wire terminates here, so clause 2 of `admit_class` governs
                // every delivery into it and the mechanical cap never applied.
                continue;
            } else if core
                .state
                .ports_of(id)
                .and_then(|ports| ports.get(port as usize))
                .is_some_and(|p| matches!(p.medium, crate::state::Medium::Mechanical))
            {
                crate::admit::MECHANICAL_INBOX_CAP
            } else {
                // Undeclared, or declared Electrical. Deliberately unbounded here.
                continue;
            };
            if inbox.len_on(port) > cap {
                return Err(DecodeError::InvalidState(StateInvariant::InboxTooMany));
            }
        }
    }
    // T-71-04-02 (Phase 71, PILE-04): bound the attacker-controlled `pending` deque on
    // every `Node::Source`, against `SOURCE_PENDING_CAP`. `manual_inject::admit` refuses
    // past that bound and never enqueues past it, so an over-cap `pending` is
    // unreachable from a live grid. Its OWN variant, never `InboxTooMany`: a shared one
    // would report a pending overflow as an inbox overflow and the message would lie
    // about which queue was forged.
    for id in core.state.node_ids() {
        if let Some(Node::Source(source)) = core.state.node(id)
            && source.pending.len() > crate::admit::SOURCE_PENDING_CAP
        {
            return Err(DecodeError::InvalidState(
                StateInvariant::SourcePendingTooMany,
            ));
        }
    }
    Ok(())
}

/// The post-decode class-invariant trust gate consumed by [`restore`] (and so by
/// every later `restore` caller — `Host::recover`, `load_project`).
///
/// **REJECT-ONLY**: it borrows `core`, never mutates / normalizes / clamps, and
/// returns the FIRST violation as a typed [`DecodeError::InvalidState`] — never a
/// panic. Returning `Ok(())` leaves the decoded bytes untouched, so a valid
/// snapshot round-trips byte-identically (corpus 0001-0006 stays frozen, no
/// version bump; threat T-06-01-TAMPER). The change is purely additive: only
/// previously-undetected INVALID bytes are newly rejected.
///
/// Checks (deterministic order; closes the RESEARCH A1 panic surfaces):
/// 1. Per node (ascending `node_ids`): a live node with no inbox →
///    [`StateInvariant::MissingInbox`]; a `Balancer`/`Merge` whose round-robin
///    pointer is out of range → `BalancerPointer`/`MergePointer` (the
///    `outputs/inputs > 0` guard preserves the legitimate zero-arity state); and,
///    since SNAPSHOT 14, a `Balancer` whose input pointer `next_in` is not a catalog In
///    (`>= DEFAULT_ARITY`) → [`StateInvariant::BalancerInputPointer`], and a `Factory`
///    whose `pending_emits` holds a fault-port key, a key with no link, an empty queue or
///    a queue at the cap → [`StateInvariant::FactoryPendingEmits`]. A `Scheduler::blocked`
///    member that is not live is step 3's `DanglingSchedule`, through `referenced_ids`, and
///    one that is live, not a belt and not gated is step 3b's
///    [`StateInvariant::BlockedNotGated`] (phase 87, JAM-04); one that is a belt and not
///    settled (`tick::belt_settled`) is step 3b's [`StateInvariant::BlockedBeltNotSettled`]
///    (plan 87-07). A machine holding work its own step takes
///    (`tick::holds_work_its_step_takes`) that is neither scheduled at `core.tick` nor in
///    the sleep set is step 3c's [`StateInvariant::MachineWakeMissing`] (phase 87 security
///    audit, threat T-87-28).
/// 2. Every link whose **target** node is not live → [`StateInvariant::DanglingLink`]
///    (the output-routing `inbox_mut(dest)` panic surface).
/// 3. Every scheduler-referenced id that is not live →
///    [`StateInvariant::DanglingSchedule`] (the `step_node` panic surface).
/// 4. Per belt (Phase 11 slot model — REDEFINED from the retired v1.0 `in_flight`
///    AR-3): (a) `slots.len() == SLOTS_PER_TILE * tiles`, else
///    [`StateInvariant::BeltSlotCount`] (a forged snapshot desyncing the slot vector
///    from the tile count); and (b) a belt with ANY occupied slot, or an item staged on
///    its inbox port 0 (the port `Belt::step` admits from; threat T-87-28), MUST be scheduled
///    to wake at `core.tick`, or be asleep in `Scheduler::blocked` (a settled belt, since
///    plan 87-07; step 3b has checked it is settled) → [`StateInvariant::BeltWakeMissing`]
///    otherwise. A belt
///    re-wakes itself at `tick+1` while ANY slot is occupied ([`crate::belt`]); at a
///    clean snapshot boundary `take_due(core.tick)` has NOT run yet, so that re-wake
///    sits at `core.tick`. A forged snapshot that keeps an occupied slot but drops
///    the wheel entry would SILENTLY strand the belt (it never re-steps, the replay
///    hash drifts) with no panic — this loop turns that into a typed rejection.
/// 5. Every `cells` key must be a live node → [`StateInvariant::DanglingCell`]
///    otherwise (mirrors `DanglingLink`/`DanglingSchedule`: `rebuild_occupancy`
///    would index a dead id so `occupied(cell)` resolves a dangling node), and no
///    two nodes' EXPANDED footprint BODY cells may share one grid cell →
///    [`StateInvariant::CellCollision`] (a forged map collapses the derived
///    `occupancy` bijection). As of FOOT-01 (10-03) the collision set is built by
///    expanding each node through [`cells_of_footprint`] (absent footprint ⇒ 1×1
///    rot0), so two distinct-anchor but body-overlapping footprints are rejected.
///    The validated fold keeps bodies live + disjoint, so a valid snapshot never
///    trips this (WR-09-02 / Pitfall 3). Belt tile cells join the SAME collision set
///    (5b, BELT-06).
/// 6. Every `footprints`/`ports` key must be a live node →
///    [`StateInvariant::DanglingFootprint`] otherwise (mirrors `DanglingCell`).
/// 7. Every `Port.local_offset` must lie within `[0,w)×[0,h)` of its node's rot-0
///    footprint box → [`StateInvariant::PortOutOfFootprint`] otherwise (small-dim
///    integer bounds; no overflow/panic). FOOT-01 / V5.
/// 8. Per `Node::Wire` (Phase 37, WIRE-03): its `from`/`to` endpoint and every
///    in-flight message's `return_addr` must name a live node →
///    [`StateInvariant::DanglingWireEndpoint`] otherwise (the admit/deliver/reply
///    dereference panic surface, mirroring `DanglingLink`); AND a wire holding a
///    non-empty `in_flight` FIFO must be scheduled at `core.tick` →
///    [`StateInvariant::WireWakeMissing`] otherwise (WR-01, the wire analog of step 4's
///    belt `BeltWakeMissing` self-rewake boundary — a dropped wake silently strands the
///    in-flight messages). The oversized-in-flight bound
///    ([`StateInvariant::WireInFlightTooMany`]) is enforced earlier in
///    [`validate_footprint_bounds`] (pre-`rebuild_occupancy`).
///
/// A live node always has an inbox (provisioned at add, re-checked by step 1), so
/// steps 2-3 only need liveness via `node(..).is_some()`.
///
/// # AR-3 arrival boundary (RESEARCH Pitfall 5 / A4 — empirically pinned)
/// A snapshot is taken at a CLEAN tick boundary: the fold runs
/// `take_due(core.tick)` then steps belts at `now == core.tick`, then `tick += 1`.
/// At the boundary `take_due` for the NEW `core.tick` has NOT yet run, so a belt
/// holding ANY occupied slot is LEGITIMATELY still wheel-held at `core.tick` — that
/// is the belt's own `tick+1` re-wake set when it last stepped (the slot model has no
/// separate `in_flight`/`latency` queue; an occupied slot IS the in-transit state).
/// Therefore an occupied belt MUST carry a scheduler entry at exactly `core.tick`;
/// the predicate is `slots.any(is_some) => is_scheduled_at(id, core.tick)`, with ONE
/// exemption since phase 87 (JAM-04, plan 87-07): a SETTLED belt, whose next-tick wake the
/// fold withdrew and put to sleep in `Scheduler::blocked`, carries no entry. It is exempt
/// only as a member of the sleep set, and step 3b refuses a member that is not settled
/// ([`StateInvariant::BlockedBeltNotSettled`]), so the exemption cannot strand a belt that
/// could still move.
fn validate_invariants(core: &Core) -> Result<(), DecodeError> {
    // 1. Per-node: inbox presence + operator-pointer range.
    for id in core.state.node_ids() {
        if core.state.inbox_of(id).is_none() {
            return Err(DecodeError::InvalidState(StateInvariant::MissingInbox));
        }
        match core.state.node(id) {
            Some(Node::Balancer(b)) if b.outputs > 0 && b.next >= b.outputs => {
                return Err(DecodeError::InvalidState(StateInvariant::BalancerPointer));
            }
            // Phase 87 (D-02, T-87-05): the INPUT pointer must name a catalog In. Checked
            // for every Balancer, a zero-output one included, because its zero-arity
            // guard scans the Ins too.
            Some(Node::Balancer(b)) if b.next_in >= crate::tick::DEFAULT_ARITY => {
                return Err(DecodeError::InvalidState(StateInvariant::BalancerInputPointer));
            }
            // Phase 87 (D-07, T-87-06): a Factory's pending emits name only its own linked
            // output ports, never the fault port, never an empty queue, and every queue is
            // under the per-run cap (a run's first emit per port leaves at once).
            Some(Node::Factory(f))
                if f.pending_emits.iter().any(|(&port, queue)| {
                    port == crate::fault::FAULT_PORT
                        || core.state.link_target((id, port)).is_none()
                        || queue.is_empty()
                        || queue.len() >= crate::factory::FACTORY_EMITS_PER_PORT
                }) =>
            {
                return Err(DecodeError::InvalidState(StateInvariant::FactoryPendingEmits));
            }
            Some(Node::Merge(m)) if m.inputs > 0 && m.next >= m.inputs => {
                return Err(DecodeError::InvalidState(StateInvariant::MergePointer));
            }
            _ => {}
        }
    }
    // 2. Links: the routing target must be a live node.
    for (_from, (to_node, _to_port)) in core.state.links_iter() {
        if core.state.node(to_node).is_none() {
            return Err(DecodeError::InvalidState(StateInvariant::DanglingLink));
        }
    }
    // 3. Scheduler-referenced ids must be live nodes.
    for id in core.sched.referenced_ids() {
        if core.state.node(id).is_none() {
            return Err(DecodeError::InvalidState(StateInvariant::DanglingSchedule));
        }
    }
    // 3b. Every sleeper that is not a belt must still be gated (phase 87, JAM-04, D-06,
    //     T-87-17). A machine sleeps only while `node_gated` holds, and every way a block
    //     lifts takes it out of the set, so a forged sleeper that could move is refused
    //     here rather than stranded forever. Read through the gate's own predicate, never
    //     a second reading of "is this machine held back". After step 2, so every link the
    //     predicate follows names a live node.
    //
    //     A BELT in the set is read by its own predicate instead (plan 87-07, T-87-19): a
    //     belt is never gated, it sleeps once SETTLED (`tick::belt_settled`: head held,
    //     items packed from the head, nothing admissible at the tail), and every way it can
    //     stop being settled takes it out of the set. A sleeping belt that is not settled
    //     is refused as `BlockedBeltNotSettled`, so a forged file cannot freeze a belt that
    //     could advance, deliver or admit.
    for id in core.sched.blocked_ids() {
        if matches!(core.state.node(id), Some(Node::Belt(_))) {
            if !crate::tick::belt_settled(&core.state, id) {
                return Err(DecodeError::InvalidState(StateInvariant::BlockedBeltNotSettled));
            }
        } else if !crate::tick::node_gated(&core.state, id) {
            return Err(DecodeError::InvalidState(StateInvariant::BlockedNotGated));
        }
    }
    // 3c. Every MACHINE holding work its own step takes must step again with no outside
    //     event: scheduled at `core.tick` (or already in the active set) or asleep in the
    //     sleep set (phase 87 security audit, threat T-87-28; the machine twin of step 4's
    //     `BeltWakeMissing` and step 8's `WireWakeMissing`). The work is read by
    //     `tick::holds_work_its_step_takes`, the way each machine's step reads its own: a
    //     Source's backlog, a Factory's waiting emits, an item on an In the step reads.
    //     Every such step re-wakes itself at `now + 1` while it still holds the work, and a
    //     gated machine sleeps instead, so a live board meets this at every boundary. A
    //     machine that is neither would never step: no tick, no edit (an edit tick wakes
    //     only the sleep set) and no Configure wakes it, and the feeder behind it then falls
    //     asleep for good. Refused, never repaired, the way step 3b treats the sleep set: a
    //     snapshot that would need its wake restored is a snapshot no fold wrote. After step
    //     3b, so a sleeper here is known to be gated.
    for id in core.state.node_ids() {
        if crate::tick::holds_work_its_step_takes(&core.state, id)
            && !core.sched.is_awake_at(id, core.tick)
            && !core.sched.is_blocked(id)
        {
            return Err(DecodeError::InvalidState(StateInvariant::MachineWakeMissing));
        }
    }
    // 4. Belt slot invariants (Phase 11 slot model — REDEFINED from the v1.0
    //    `in_flight` AR-3):
    //    (a) BeltSlotCount — `slots.len() == SLOTS_PER_TILE * tiles`. A forged
    //        snapshot desyncing the slot vector from the tile count is rejected.
    //    (b) AR-3-for-slots — a belt with ANY occupied slot MUST be scheduled (it
    //        re-wakes itself at `tick+1` while occupied, [`crate::belt`]). At a clean
    //        snapshot boundary that wake sits at `core.tick` (take_due(core.tick) has
    //        NOT run yet), so the predicate is `slots.any(is_some) =>
    //        is_scheduled_at(id, core.tick)`. A forged snapshot that keeps an occupied
    //        slot but drops the wake would SILENTLY strand the belt (it never
    //        re-steps, the replay hash drifts) — this turns that into a typed
    //        rejection, no panic (RESEARCH Pitfall 2).
    //    (c) `ticks_per_slot` — DELIBERATELY NO ARM HERE, and RECORDING THE ABSENCE
    //        IS THE DECISION (Phase 62, SLOT-03, `62-CONTEXT.md` D-01). Two separate
    //        questions were asked and both answered no:
    //          - A FORGED ZERO cannot reach this function. The field is `NonZeroU32`,
    //            so a zero fails inside `postcard::from_bytes` and surfaces as the
    //            existing typed `DecodeError::Malformed` at `restore()` above —
    //            reject-only, never a panic, and never a division by zero in
    //            `Belt::step`'s modulo. The type IS the invariant, so a
    //            `StateInvariant::BeltSpeedZero` arm would be unreachable code
    //            asserting something already structurally impossible. Gated by
    //            `tests/snapshot_invariants.rs::rejects_forged_zero_belt_interval`,
    //            which forges the byte rather than arguing.
    //          - NO UPPER BOUND is added either, and that is NOT an oversight. The
    //            bounded-allocation family here (`BeltTilesTooMany`,
    //            `WireInFlightTooMany`, `FootprintTooLarge`) exists to cap what an
    //            attacker-controlled number can ALLOCATE. `ticks_per_slot` caps no
    //            allocation, bounds no loop and spans no replay: a huge interval is a
    //            STOPPED belt, which is a boring grid, not a DoS. A ceiling would be a
    //            literal nobody could justify, and the next reader would have to
    //            reverse-engineer why it is the number it is.
    for id in core.state.node_ids() {
        if let Some(Node::Belt(belt)) = core.state.node(id) {
            if belt.slots.len() != crate::belt_slots::slot_count(belt.tiles) {
                return Err(DecodeError::InvalidState(StateInvariant::BeltSlotCount));
            }
            // A settled belt ASLEEP holds no wake (plan 87-07): the fold withdrew it. Step 3b
            // has already refused a sleeping belt that is not settled, so membership of the
            // sleep set is the whole exemption, and an occupied belt neither scheduled nor
            // asleep is still `BeltWakeMissing`.
            //
            // AN ITEM STAGED ON PORT 0 IS WORK TOO (phase 87 security audit, threat T-87-28):
            // `Belt::step` admits from it whenever the tail slot is free. A live belt never
            // holds one with no wake: every delivery into the staging inbox schedules the belt
            // at `now + 1`, and a step that leaves an item staged has an occupied tail slot,
            // so it re-wakes or settles. A forged belt with every slot empty and an item
            // staged, neither scheduled nor asleep, would hold that item forever.
            let staged = core.state.inbox_of(id).is_some_and(|inbox| inbox.has_on(0));
            if (belt.slots.iter().any(Option::is_some) || staged)
                && !core.sched.is_scheduled_at(id, core.tick)
                && !core.sched.is_blocked(id)
            {
                return Err(DecodeError::InvalidState(StateInvariant::BeltWakeMissing));
            }
        }
    }
    // 5. Cells: every cell key must be a LIVE node (mirror DanglingLink/
    //    DanglingSchedule — `rebuild_occupancy` would otherwise index a dead id), and
    //    no two nodes' EXPANDED footprint BODY cells may share one grid cell (the
    //    `occupancy` reverse index must stay a faithful bijection of the expanded
    //    bodies — FOOT-01 / Pitfall 3). Deterministic ascending-`NodeId` order;
    //    dangling is checked before collision per entry (WR-09-02).
    let mut seen_cells: std::collections::BTreeSet<(i32, i32)> = std::collections::BTreeSet::new();
    for (id, anchor) in core.state.cells_iter() {
        if core.state.node(id).is_none() {
            return Err(DecodeError::InvalidState(StateInvariant::DanglingCell));
        }
        // Expand this node's footprint (absent ⇒ 1×1 rot0) and reject the first
        // duplicate BODY cell — catches body-overlap an anchor-only check would miss.
        let (w, h, rot) = match core.state.footprint_of(id) {
            Some(fp) => (fp.w, fp.h, fp.rot),
            None => (1, 1, 0),
        };
        for cell in cells_of_footprint(anchor, w, h, rot) {
            if !seen_cells.insert(cell) {
                return Err(DecodeError::InvalidState(StateInvariant::CellCollision));
            }
        }
    }
    // 5b. Belt tiles participate in the SAME unified occupancy collision set
    //     (BELT-06): no drawn belt tile cell may overlap a machine body cell or
    //     another belt's tile (the `occupancy` index must stay a faithful bijection
    //     of the expanded bodies + belt geometry). Deterministic ascending-`NodeId`
    //     order (after the machine bodies). A `Wire`-minted belt has empty geometry,
    //     so the 0001-0011 corpus never trips this.
    for id in core.state.node_ids() {
        if let Some(Node::Belt(belt)) = core.state.node(id) {
            for tile in &belt.geometry {
                if !seen_cells.insert(tile.cell) {
                    return Err(DecodeError::InvalidState(StateInvariant::CellCollision));
                }
            }
        }
    }
    // 6. Footprints: every footprints key must be a LIVE node → DanglingFootprint.
    for (id, _fp) in core.state.footprints_iter() {
        if core.state.node(id).is_none() {
            return Err(DecodeError::InvalidState(StateInvariant::DanglingFootprint));
        }
    }
    // 7. Ports: every ports key must be a LIVE node (DanglingFootprint), and every
    //    port `local_offset` must lie within `[0,w)×[0,h)` of that node's rot-0
    //    footprint box (absent footprint ⇒ 1×1) → PortOutOfFootprint otherwise.
    for (id, ports) in core.state.ports_iter() {
        if core.state.node(id).is_none() {
            return Err(DecodeError::InvalidState(StateInvariant::DanglingFootprint));
        }
        let (w, h) = match core.state.footprint_of(id) {
            Some(fp) => (i32::from(fp.w), i32::from(fp.h)),
            None => (1, 1),
        };
        for p in ports {
            let (x, y) = p.local_offset;
            if x < 0 || y < 0 || x >= w || y >= h {
                return Err(DecodeError::InvalidState(StateInvariant::PortOutOfFootprint));
            }
        }
    }
    // 8. Wires (Phase 37, WIRE-03): every `Node::Wire`'s `from`/`to` endpoint and
    //    every in-flight message's `return_addr` must name a LIVE node — these are the
    //    exact `(node, port)` handles the fold's admit/deliver/reply paths dereference
    //    (`node_mut`/`inbox_mut`), so a forged dangling address would otherwise panic
    //    (mirror `DanglingLink`, step 2). Deterministic ascending-`NodeId` order. A
    //    validated fold keeps every wire endpoint + return address live, so a valid
    //    snapshot never trips this (WIRE-03 / reject-only).
    for id in core.state.node_ids() {
        if let Some(Node::Wire(link)) = core.state.node(id) {
            if core.state.node(link.from.0).is_none() || core.state.node(link.to.0).is_none() {
                return Err(DecodeError::InvalidState(StateInvariant::DanglingWireEndpoint));
            }
            for msg in &link.in_flight {
                if core.state.node(msg.return_addr.0).is_none() {
                    return Err(DecodeError::InvalidState(StateInvariant::DanglingWireEndpoint));
                }
            }
            // WR-01 (the wire analog of step 4's belt `BeltWakeMissing`, symmetric with
            // that reject-only guard): a wire holding ANY in-flight message MUST be
            // scheduled at `core.tick`. `step_wire` re-wakes an occupied wire at `now + 1`
            // (SELF-REWAKE, `tick.rs`), so at a clean snapshot boundary that wake sits at
            // exactly `core.tick` (`take_due(core.tick)` has NOT run yet — mirror the belt
            // AR-3-for-slots boundary). A forged snapshot that keeps the in-flight FIFO but
            // drops the wheel entry would SILENTLY strand the messages (the wire never
            // re-steps, the replay hash drifts) — this turns that into a typed rejection,
            // no panic. A legitimately-built wire (admit/deliver/reply always wake it when
            // it holds in-flight) never trips this, so a valid snapshot is untouched.
            if !link.in_flight.is_empty() && !core.sched.is_scheduled_at(id, core.tick) {
                return Err(DecodeError::InvalidState(StateInvariant::WireWakeMissing));
            }
        }
    }
    // 9. Labels (plan 86-07, D-08, WORK-09): a label never connects. Refused when one holds
    //    any port, is named by a link at either end, or is an end of a wire. No live grid
    //    holds such a label (validation refuses every connect gesture and the connect folds
    //    change nothing on a label), so a valid snapshot is untouched; deterministic
    //    ascending order over the ordered maps, reject-only.
    let is_label = |id: crate::ids::NodeId| matches!(core.state.node(id), Some(Node::Label(_)));
    for (id, ports) in core.state.ports_iter() {
        if !ports.is_empty() && is_label(id) {
            return Err(DecodeError::InvalidState(StateInvariant::LabelConnected));
        }
    }
    for ((from_node, _from_port), (to_node, _to_port)) in core.state.links_iter() {
        if is_label(from_node) || is_label(to_node) {
            return Err(DecodeError::InvalidState(StateInvariant::LabelConnected));
        }
    }
    for id in core.state.node_ids() {
        if let Some(Node::Wire(link)) = core.state.node(id)
            && (is_label(link.from.0) || is_label(link.to.0))
        {
            return Err(DecodeError::InvalidState(StateInvariant::LabelConnected));
        }
    }
    Ok(())
}

/// Persist `snapshot(core)` into `store`, keyed at the current `core.tick`.
///
/// On-demand half of the cadence: call it whenever an explicit snapshot is
/// wanted (e.g. before shutdown, or a user-triggered save).
pub fn persist_snapshot<S: PersistenceStore>(core: &Core, store: &mut S) -> Result<(), S::Error> {
    store.write_snapshot(core.tick, &snapshot(core))
}

/// The periodic-cadence predicate: is a snapshot **due** at `tick`?
///
/// - `Some(n)` with `n > 0` ⇒ due at every n-th tick boundary (`tick % n == 0`),
///   so tick 0 and every multiple of `n` thereafter fire.
/// - `None` (and the degenerate `Some(0)`) ⇒ **never** auto-due — on-demand only.
///
/// This is the periodic-interval half of the CONTEXT-locked snapshot cadence,
/// exposed as a pure, consultable function the driver checks at the boundary.
pub fn snapshot_due(snapshot_every: Option<u64>, tick: u64) -> bool {
    match snapshot_every {
        Some(n) if n > 0 => tick.is_multiple_of(n),
        _ => false,
    }
}

/// Consult the cadence at the current tick boundary and persist a snapshot iff
/// it is due. Returns `true` when a snapshot was written, `false` otherwise.
///
/// This is the real, consultable mechanism the always-on driver loop (Phase 7)
/// calls every tick; wiring it into that loop is the shell's job, but the policy
/// and the configurable interval ship and are proven here.
pub fn persist_snapshot_if_due<S: PersistenceStore>(
    core: &Core,
    store: &mut S,
    snapshot_every: Option<u64>,
) -> Result<bool, S::Error> {
    if snapshot_due(snapshot_every, core.tick) {
        persist_snapshot(core, store)?;
        Ok(true)
    } else {
        Ok(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The path a FORGED inert `Node::Endpoint` carries in this module's snapshot
    /// trust-gate tests.
    ///
    /// These sites use `test_insert_inert` precisely BECAUSE it bypasses
    /// `GridState::add_endpoint`: the subject is a hand-forged node proving the
    /// kind-agnostic gate checks generalize, so the node is deliberately not one the
    /// live path would produce. `add_endpoint` mints its own default path, `/route-N`
    /// (R-44, D-13), and no caller can hand it a path, so a forge test cannot use it and
    /// still be a forge test. The literal is therefore honest about what it is rather
    /// than imitating the default.
    const TEST_ENDPOINT_PATH: &str = "/ep-forged";
    use crate::event::{LogHeader, SCHEMA_VERSION};
    use crate::ids::{Item, NodeId};
    use crate::persist::MemStore;

    fn header(seed: u64) -> LogHeader {
        LogHeader {
            schema_version: SCHEMA_VERSION,
            seed,
        }
    }

    /// A `NodeId` guaranteed to be absent from any grid built with `add_*` (which
    /// only ever insert — so every live node id is version 1). Inserting, removing,
    /// then re-inserting reuses slot index 0 with a BUMPED version (2), yielding a
    /// `NodeId` that can never collide with a live grid id — the rigorous "dangling
    /// id" the trust gate must reject.
    fn ghost_id() -> NodeId {
        let mut foreign: slotmap::SlotMap<NodeId, ()> = slotmap::SlotMap::with_key();
        let k = foreign.insert(());
        foreign.remove(k); // frees slot 0, bumping its version
        foreign.insert(()) // slot 0, version 2 — distinct from any v1 grid id
    }

    /// A small live Core with a populated topology, an in-flight belt item, an
    /// advanced rng, and a non-zero tick — so a round-trip exercises every field.
    fn live_core() -> Core {
        let mut core = Core::genesis(header(0xC0FFEE));
        let s = core.state.add_source();
        let b = core.state.add_belt(5);
        let c = core.state.add_source();
        core.state.link((s, 0), (b, 0));
        core.state.link((b, 0), (c, 0));
        // Fire an item so something is mid-transport on the belt at the boundary.
        core.run_log(&[crate::event::Event {
            schema_version: SCHEMA_VERSION,
            partition: 0,
            sequence: 1,
            tick: 0,
            payload: crate::event::EventPayload::ManualInject {
                target: s,
                port: 0,
                item: Item(vec![1, 2, 3]),
            },
        }]).expect("replay within MAX_REPLAY_SPAN");
        // Advance the rng so its state is non-genesis at the boundary.
        let _ = core.rng.next_u64();
        let _ = core.rng.next_u64();
        core
    }

    #[test]
    fn snapshot_restore_round_trip_is_byte_identical() {
        let core = live_core();
        let bytes = snapshot(&core);
        let restored = restore(&bytes).expect("restore valid snapshot");
        // Re-serializing the restored Core yields byte-identical snapshot bytes
        // (the state-equality oracle), proving every field round-tripped.
        assert_eq!(bytes, snapshot(&restored), "restore(snapshot(core)) == core");
    }

    #[test]
    fn snapshot_factory_round_trips_byte_identical_with_cold_cache_after_restore() {
        // A Core with a Node::Factory snapshots and restores byte-identically: the
        // live engine cache is #[serde(skip)] (NOT in the bytes), and the restored
        // Core's runtime cache is empty (cold) — it rebuilds lazily on the next step.
        let mut core = Core::genesis(header(0xFAC0));
        let s = core.state.add_source();
        let f = core.state.add_factory(
            "export default function (input, ctx) { ctx.state.n = (ctx.state.n||0) + input; ctx.emit(0, ctx.state.n); }".to_owned(),
            crate::factory::DEFAULT_GAS_BUDGET,
            0xFAC0,
        );
        let c = core.state.add_source(); // collector (ignores its input)
        core.state.link((s, 0), (f, 0));
        core.state.link((f, 0), (c, 0));

        // Drive a couple of ticks so the factory runs: this advances ctx.state +
        // the per-node rng AND populates the (non-serialized) live engine cache.
        core.run_log(&[
            crate::event::Event {
                schema_version: SCHEMA_VERSION,
                partition: 0,
                sequence: 1,
                tick: 0,
                payload: crate::event::EventPayload::ManualInject {
                    target: s,
                    port: 0,
                    item: Item(b"5".to_vec()),
                },
            },
            crate::event::Event {
                schema_version: SCHEMA_VERSION,
                partition: 0,
                sequence: 2,
                tick: 1,
                payload: crate::event::EventPayload::ManualInject {
                    target: s,
                    port: 0,
                    item: Item(b"3".to_vec()),
                },
            },
        ]).expect("replay within MAX_REPLAY_SPAN");
        // The live engine was built and cached during the run.
        assert!(
            !core.factory_runtimes.is_empty(),
            "stepping the factory populated the live engine cache"
        );

        let bytes = snapshot(&core);
        let restored = restore(&bytes).expect("restore a Core with a Node::Factory");

        // Byte-identical: every plain field (incl. the factory's advanced ctx.state
        // + rng) round-tripped; the live engine was correctly excluded.
        assert_eq!(
            bytes,
            snapshot(&restored),
            "restore(snapshot(core)) == core for a Node::Factory grid"
        );
        // The restored Core's runtime cache is cold (the engine is rebuilt lazily).
        assert!(
            restored.factory_runtimes.is_empty(),
            "a restored Core starts with a cold (empty) runtime cache"
        );

        // The factory's persisted ctx.state crossed the snapshot (5 + 3 == 8).
        match restored.state.node(f) {
            Some(crate::state::Node::Factory(factory)) => {
                assert_eq!(
                    factory.state_json, b"{\"n\":8}",
                    "ctx.state advanced across ticks is captured in the snapshot"
                );
            }
            other => panic!("expected a restored Factory node, got {other:?}"),
        }
    }

    #[test]
    fn snapshot_survives_store_write_read_restore() {
        let core = live_core();
        let mut store = MemStore::new();
        persist_snapshot(&core, &mut store).expect("persist snapshot");

        let (tick, bytes) = store
            .latest_snapshot()
            .expect("read latest")
            .expect("a snapshot exists");
        assert_eq!(tick, core.tick, "snapshot keyed at the current tick");

        let restored = restore(&bytes).expect("restore from store bytes");
        assert_eq!(
            snapshot(&core),
            snapshot(&restored),
            "store round-trip preserves the whole Core"
        );
    }

    #[test]
    fn snapshot_restore_malformed_bytes_returns_err_no_panic() {
        // Truncated / garbage bytes must not panic (Core is not Debug, so match
        // the error variant rather than unwrap_err).
        // Too short to even carry the 2-byte schema tag => Malformed.
        assert!(matches!(restore(&[]), Err(DecodeError::Malformed)));
        assert!(matches!(restore(&[0x01]), Err(DecodeError::Malformed)));
        // A valid current tag but a garbage body => Malformed.
        let mut garbage = SNAPSHOT_SCHEMA_VERSION.to_le_bytes().to_vec();
        garbage.extend_from_slice(&[0xFF; 3]);
        assert!(matches!(restore(&garbage), Err(DecodeError::Malformed)));
        // Oversized input is refused before decoding (threat T-1-DES).
        let oversized = vec![0u8; MAX_RECORD_BYTES + 1];
        assert!(matches!(restore(&oversized), Err(DecodeError::Malformed)));
    }

    /// A valid `live_core()` still restores byte-identically AFTER the validator is
    /// inserted — the reject-only gate returns the decoded Core untouched, so the
    /// state-equality oracle holds (no normalize/clamp, no corpus drift).
    #[test]
    fn validate_invariants_passes_valid_core_byte_identical() {
        let core = live_core();
        let bytes = snapshot(&core);
        let restored = restore(&bytes).expect("valid live_core restores through the gate");
        assert_eq!(
            bytes,
            snapshot(&restored),
            "reject-only validation returns the same Core for valid input"
        );
    }

    /// A balancer at full arity with `next == outputs` (out of range) is rejected.
    #[test]
    fn validate_invariants_rejects_balancer_pointer() {
        let mut core = Core::genesis(header(1));
        let bal = core.state.add_balancer(3);
        if let Some(crate::state::Node::Balancer(b)) = core.state.node_mut(bal) {
            b.next = b.outputs; // 3 >= 3 -> out of range
        }
        let bytes = snapshot(&core);
        assert!(matches!(
            restore(&bytes),
            Err(DecodeError::InvalidState(StateInvariant::BalancerPointer))
        ));
    }

    /// A merge with `next >= inputs` (out of range) is rejected.
    #[test]
    fn validate_invariants_rejects_merge_pointer() {
        let mut core = Core::genesis(header(2));
        let mrg = core.state.add_merge(2);
        if let Some(crate::state::Node::Merge(m)) = core.state.node_mut(mrg) {
            m.next = 5; // 5 >= 2 -> out of range
        }
        let bytes = snapshot(&core);
        assert!(matches!(
            restore(&bytes),
            Err(DecodeError::InvalidState(StateInvariant::MergePointer))
        ));
    }

    /// A node present in the store but stripped of its inbox is rejected.
    #[test]
    fn validate_invariants_rejects_missing_inbox() {
        let mut core = Core::genesis(header(3));
        let s = core.state.add_source();
        core.state.test_remove_inbox(s); // forge the impossible-via-public-API state
        let bytes = snapshot(&core);
        assert!(matches!(
            restore(&bytes),
            Err(DecodeError::InvalidState(StateInvariant::MissingInbox))
        ));
    }

    /// Plan 86-07 (D-08, WORK-09): a label never connects. A snapshot whose label holds a
    /// port, is either end of a link, or is either end of a wire is refused
    /// `LabelConnected`; a plain label, and one with an empty port list, restore. Each
    /// forged state LOADED before the check (no rule named a label).
    #[test]
    fn validate_invariants_rejects_a_connected_label() {
        use crate::state::{Medium, Port, Role, Side};
        let port = Port { local_offset: (0, 0), side: Side::E, role: Role::Out, medium: Medium::Mechanical };
        let refused = |core: &Core| {
            matches!(restore(&snapshot(core)), Err(DecodeError::InvalidState(StateInvariant::LabelConnected)))
        };

        let mut plain = Core::genesis(header(86));
        let label = plain.state.add_label();
        let source = plain.state.add_source();
        assert!(restore(&snapshot(&plain)).is_ok(), "non-vacuity: a plain label restores");
        let mut empty = plain.clone();
        empty.state.set_ports(label, Vec::new());
        assert!(restore(&snapshot(&empty)).is_ok(), "an empty port list is not a port");

        let mut with_port = plain.clone();
        with_port.state.set_ports(label, vec![port]);
        assert!(refused(&with_port), "a label holding a port");

        let mut into = plain.clone();
        into.state.link((source, 0), (label, 0));
        assert!(refused(&into), "a link into a label");
        let mut out_of = plain.clone();
        out_of.state.link((label, 0), (source, 0));
        assert!(refused(&out_of), "a link out of a label");

        let mut cable_from = plain.clone();
        cable_from.state.add_wire((label, 0), (source, 0));
        assert!(refused(&cable_from), "a cable from a label");
        let mut cable_to = plain.clone();
        cable_to.state.add_wire((source, 0), (label, 0));
        assert!(refused(&cable_to), "a cable to a label");
    }

    /// A link whose target node id is not live is rejected.
    #[test]
    fn validate_invariants_rejects_dangling_link() {
        let mut core = Core::genesis(header(4));
        let s = core.state.add_source();
        let ghost = ghost_id(); // a NodeId guaranteed absent from this grid
        core.state.link((s, 0), (ghost, 0)); // wire to a dangling target
        let bytes = snapshot(&core);
        assert!(matches!(
            restore(&bytes),
            Err(DecodeError::InvalidState(StateInvariant::DanglingLink))
        ));
    }

    /// A scheduler-referenced node id that is not live is rejected.
    #[test]
    fn validate_invariants_rejects_dangling_schedule() {
        let mut core = Core::genesis(header(5));
        let _s = core.state.add_source();
        let ghost = ghost_id(); // a NodeId guaranteed absent from this grid
        core.sched.schedule_wake(ghost, 7); // schedule a non-grid id
        let bytes = snapshot(&core);
        assert!(matches!(
            restore(&bytes),
            Err(DecodeError::InvalidState(StateInvariant::DanglingSchedule))
        ));
    }

    /// A small `source -> belt(1) -> collector` Core driven so the belt carries
    /// exactly one item in its slots at the boundary (Phase-11 slot model). Returns
    /// the Core plus the belt id. The belt re-wakes itself at `tick+1` while occupied,
    /// so at the clean snapshot boundary that wake sits at exactly `core.tick` — the
    /// boundary AR-3-for-slots must accept.
    ///
    /// Feeding a belt is transport WITH LATENCY, NOT a 0-latency instant-wire (CR-01):
    /// the source's item lands in the belt's INBOX at the fire tick (the source
    /// `schedule_wake`s the belt for the next tick), and the belt admits it to its
    /// tail on that NEXT tick. So we fire at tick 0, then advance one empty tick to
    /// let the belt admit — leaving the item resident in the belt slots at the
    /// boundary.
    ///
    /// The ADMIT is what this helper depends on and the admit is UNGATED (SLOT-03:
    /// the interval gates the advance and only the advance), so the one settling tick
    /// is correct at every `ticks_per_slot` and is deliberately not a derived budget.
    /// This docblock said "1-slot/tick transport", which is retired: a belt advances
    /// one slot every `ticks_per_slot` ticks. The load-bearing half of the sentence,
    /// that a belt is not a 0-latency instant-wire, is unchanged and survives above.
    fn in_flight_belt_core() -> (Core, NodeId) {
        let mut core = Core::genesis(header(0xBE17));
        let s = core.state.add_source();
        let b = core.state.add_belt(1);
        let c = core.state.add_source();
        core.state.link((s, 0), (b, 0));
        core.state.link((b, 0), (c, 0));
        core.run_log(&[crate::event::Event {
            schema_version: SCHEMA_VERSION,
            partition: 0,
            sequence: 1,
            tick: 0,
            payload: crate::event::EventPayload::ManualInject {
                target: s,
                port: 0,
                item: Item(vec![0xAB]),
            },
        }])
        .expect("replay within MAX_REPLAY_SPAN");
        // Advance one empty tick so the belt (scheduled at this tick by the source)
        // steps and admits the item into its tail.
        core.advance(&[]);
        match core.state.node(b) {
            Some(Node::Belt(belt)) => {
                assert!(belt.slots.iter().any(Option::is_some), "an item rides the belt slots");
            }
            other => panic!("expected an in-flight belt, got {other:?}"),
        }
        (core, b)
    }

    /// AR-3-for-slots: a forged snapshot whose occupied-slot belt has had its
    /// `wake_wheel` entry stripped (the item rides a slot but the re-advance wake is
    /// gone) is REJECTED with `BeltWakeMissing` — a typed error, never a panic, never
    /// a silently stranded belt (RESEARCH Pitfall 2).
    #[test]
    fn validate_invariants_rejects_belt_wake_missing() {
        let (mut core, belt) = in_flight_belt_core();
        // Forge the strand: drop the boundary wheel entry, leave the occupied slot.
        core.sched.test_remove_wake(belt, core.tick);
        let bytes = snapshot(&core);
        assert!(matches!(
            restore(&bytes),
            Err(DecodeError::InvalidState(StateInvariant::BeltWakeMissing))
        ));
    }

    /// AR-3-for-slots (no false-trip): the SAME mid-flight belt WITHOUT the forge
    /// passes `validate_invariants` and restores byte-identically. Empirically pins
    /// the boundary: an occupied belt's re-wake sits at exactly `core.tick` and is
    /// still wheel-held (take_due(core.tick) has NOT run yet at the boundary).
    #[test]
    fn validate_invariants_passes_valid_in_flight_belt() {
        let (core, belt) = in_flight_belt_core();
        assert!(
            core.sched.is_scheduled_at(belt, core.tick),
            "an occupied belt is legitimately wheel-held at core.tick at the boundary"
        );
        // It passes the gate and round-trips byte-identically (reject-only).
        let bytes = snapshot(&core);
        let restored = restore(&bytes).expect("valid in-flight belt restores");
        assert_eq!(
            bytes,
            snapshot(&restored),
            "a valid mid-flight belt round-trips byte-identically through AR-3-for-slots"
        );
    }

    /// T-11-DRAWBELT-BOMB: a forged snapshot belt carrying MORE than `MAX_BELT_TILES`
    /// geometry tiles is rejected with `BeltTilesTooMany` BEFORE `rebuild_occupancy`
    /// expands them (the allocation-bomb guard), reject-only, no panic/OOM.
    #[test]
    fn validate_footprint_bounds_rejects_belt_tiles_too_many() {
        use crate::state::BeltTile;
        let mut core = Core::genesis(header(0xB17E));
        let b = core.state.add_belt(0); // 0 slots; we forge an oversized geometry
        if let Some(Node::Belt(belt)) = core.state.node_mut(b) {
            belt.geometry = vec![BeltTile::default(); MAX_BELT_TILES as usize + 1];
        }
        let bytes = snapshot(&core);
        assert!(matches!(
            restore(&bytes),
            Err(DecodeError::InvalidState(StateInvariant::BeltTilesTooMany))
        ));
    }

    /// WR-01: a forged snapshot belt with a geometry tile cell OUTSIDE the grid extent
    /// `[GRID_MIN, GRID_MAX]` is rejected with `CellOutOfBounds`, mirroring the machine-
    /// anchor bound and the command-layer / edit-log decode guards (the trust gate must
    /// refuse forged off-grid state symmetrically — reject-only, no panic).
    #[test]
    fn validate_footprint_bounds_rejects_off_grid_belt_tile() {
        use crate::state::BeltTile;
        let mut core = Core::genesis(header(0x0FF6));
        let b = core.state.add_belt(0); // 0 slots; we forge a single off-grid tile
        if let Some(Node::Belt(belt)) = core.state.node_mut(b) {
            belt.geometry = vec![BeltTile::new((GRID_MAX + 1, 0), Default::default())];
        }
        let bytes = snapshot(&core);
        assert!(matches!(
            restore(&bytes),
            Err(DecodeError::InvalidState(StateInvariant::CellOutOfBounds))
        ));
    }

    /// AR-3-for-slots: a forged snapshot whose belt `slots.len()` does not equal
    /// `SLOTS_PER_TILE * tiles` is rejected with `BeltSlotCount` (reject-only).
    #[test]
    fn validate_invariants_rejects_belt_slot_count_mismatch() {
        let mut core = Core::genesis(header(0xB57C));
        let b = core.state.add_belt(2);
        // Desync the slot vector from the tile count (impossible via the public API).
        if let Some(Node::Belt(belt)) = core.state.node_mut(b) {
            belt.slots.truncate(1);
        }
        let bytes = snapshot(&core);
        assert!(matches!(
            restore(&bytes),
            Err(DecodeError::InvalidState(StateInvariant::BeltSlotCount))
        ));
    }

    /// WR-09-02: a forged v4 snapshot mapping a cell to a non-live `NodeId` is
    /// rejected with `DanglingCell` — `rebuild_occupancy` would otherwise index the
    /// dead id so `occupied(cell)` resolves a dangling node.
    #[test]
    fn validate_invariants_rejects_dangling_cell() {
        let mut core = Core::genesis(header(6));
        let _s = core.state.add_source();
        let ghost = ghost_id(); // a NodeId guaranteed absent from this grid
        core.state.set_cell(ghost, (3, 4)); // a cell keyed by a non-live node
        let bytes = snapshot(&core);
        assert!(matches!(
            restore(&bytes),
            Err(DecodeError::InvalidState(StateInvariant::DanglingCell))
        ));
    }

    /// WR-09-02: a forged v4 snapshot placing TWO live nodes on one cell is rejected
    /// with `CellCollision`. `set_cell` keeps `cells` injective (it would evict), so
    /// the collision is forged via the raw test-support insert.
    #[test]
    fn validate_invariants_rejects_cell_collision() {
        let mut core = Core::genesis(header(7));
        let a = core.state.add_source();
        let b = core.state.add_source();
        // Raw forced inserts (set_cell would evict a colliding node) put two LIVE
        // nodes on one cell — the impossible-via-public-API collision the gate rejects.
        core.state.test_force_cell(a, (2, 2));
        core.state.test_force_cell(b, (2, 2));
        let bytes = snapshot(&core);
        assert!(matches!(
            restore(&bytes),
            Err(DecodeError::InvalidState(StateInvariant::CellCollision))
        ));
    }

    /// WR-09-02 (no false-trip): a Core with valid distinct live cells passes the
    /// gate and restores byte-identically (reject-only — no corpus drift).
    #[test]
    fn validate_invariants_passes_valid_cells() {
        let mut core = Core::genesis(header(8));
        let a = core.state.add_source();
        let b = core.state.add_source();
        core.state.set_cell(a, (1, 1));
        core.state.set_cell(b, (2, 2));
        let bytes = snapshot(&core);
        let restored = restore(&bytes).expect("valid distinct live cells restore clean");
        assert_eq!(
            bytes,
            snapshot(&restored),
            "reject-only: a valid cells map round-trips byte-identically"
        );
    }

    #[test]
    fn snapshot_restore_refuses_forward_version_without_panic() {
        // Regression for WR-04: a snapshot tagged with a newer schema version is
        // refused with a typed error, never silently mis-decoded (threat T-1-DES),
        // mirroring the event-log forward-version refusal.
        //
        // The `+ 1` is DERIVED and cannot re-point: the forward branch is a single arm
        // (`tag > SNAPSHOT_SCHEMA_VERSION` -> `UnknownVersion`) and a bump moves the value
        // it probes without moving the arm it lands on.
        let core = live_core();
        let mut bytes = snapshot(&core);
        // Bump the leading u16 tag past the readable version.
        let forward = (SNAPSHOT_SCHEMA_VERSION + 1).to_le_bytes();
        bytes[0] = forward[0];
        bytes[1] = forward[1];
        assert!(matches!(
            restore(&bytes),
            Err(DecodeError::UnknownVersion(v)) if v == SNAPSHOT_SCHEMA_VERSION + 1
        ));
    }

    #[test]
    fn snapshot_restore_refuses_too_old_version() {
        // Phase-9 clean break (Q1): a snapshot tagged with an OLDER schema version is
        // refused with a typed `SnapshotTooOld` — never a panic, no migration shim —
        // symmetric with the forward-version refusal. The tag is checked before the
        // body is decoded, so the (v4-shaped) body is irrelevant.
        //
        // The `- 1` is DERIVED on purpose and it is safe to derive here, which is worth
        // stating because the equivalent form in the project envelope is NOT. `restore`'s
        // too-old branch has exactly ONE arm and always will: it refuses and returns
        // `SnapshotTooOld(tag)` with no per-version specialisation, so this case cannot
        // silently re-point onto a different arm on a bump. It re-points only its VALUE
        // (tag 8 before Phase 62, tag 9 after), and pinning a specific historical version
        // is the job of the frozen v6/v7/v8/v9 witnesses below, not of this case. Contrast
        // `fuzz_two_log::class_too_old`, which had to be re-anchored on a hard literal at
        // Phase 60 precisely because the project envelope's too-old branch DID grow arms.
        let core = live_core();
        let mut bytes = snapshot(&core);
        let old = (SNAPSHOT_SCHEMA_VERSION - 1).to_le_bytes();
        bytes[0] = old[0];
        bytes[1] = old[1];
        assert!(matches!(
            restore(&bytes),
            Err(DecodeError::SnapshotTooOld(v)) if v == SNAPSHOT_SCHEMA_VERSION - 1
        ));
    }

    #[test]
    fn frozen_v6_snapshot_is_refused_as_snapshot_too_old_under_v7() {
        // DET-03 / clean break (17-04): a REAL, frozen v6-era snapshot blob must be
        // REFUSED as a typed `SnapshotTooOld(6)` under the v7 schema — never a panic,
        // never a silent mis-decode of the stale body against the new `Factory`
        // layout. The tag is checked BEFORE the body is decoded, so this holds
        // regardless of the (v6-shaped) body content.
        //
        // The literal below was captured ONCE from a genuine pre-bump v6 encode of a
        // genesis `Core` (`snapshot(&Core::genesis(header(0xC0FFEE)))` at
        // SNAPSHOT_SCHEMA_VERSION == 6): a `06 00` little-endian tag followed by the
        // real postcard `Core` body. It is HARD-CODED (not a
        // `SNAPSHOT_SCHEMA_VERSION - 1` arithmetic tag on a freshly-encoded body) so
        // it will NOT drift on the next schema bump — it is a genuine stale-bytes
        // witness that a real old save stays refused forever.
        const FROZEN_V6_GENESIS: &[u8] = &[
            0x06, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x38, 0x3B, 0xF2, 0xC3, 0x35, 0x90, 0x8C, 0xDF, 0x0C, 0xD2, 0xC3, 0x0C, 0x8F, 0x2F,
            0xFF, 0xC9, 0x96, 0x35, 0x14, 0x29, 0x52, 0x51, 0x51, 0x93, 0x08, 0x19, 0x65, 0x34,
            0x15, 0x82, 0x93, 0xE4, 0x00, 0x00, 0x00,
        ];

        assert!(
            matches!(
                restore(FROZEN_V6_GENESIS),
                Err(DecodeError::SnapshotTooOld(6))
            ),
            "a frozen v6 snapshot must be refused as SnapshotTooOld(6) under v7+/v8"
        );
    }

    #[test]
    fn frozen_v7_snapshot_is_refused_as_snapshot_too_old_under_v8() {
        // v6.0 clean break (35-03): the coordinated SNAPSHOT 7->8 bump (byte-forced by
        // `Port.medium`) means a REAL, frozen v7-era snapshot blob must be REFUSED as a
        // typed `SnapshotTooOld(7)` under the v8 schema — never a panic, never a silent
        // mis-decode of the stale (pre-`medium`) port bytes against the new layout. The
        // tag is checked BEFORE the body is decoded, so this holds regardless of the
        // (v7-shaped) body content.
        //
        // The literal below was captured ONCE from a genuine pre-bump v7 encode of a
        // genesis `Core` (`snapshot(&Core::genesis(header(0xC0FFEE)))` at
        // SNAPSHOT_SCHEMA_VERSION == 7): an `07 00` little-endian tag followed by the
        // real postcard `Core` body. It is HARD-CODED (not a
        // `SNAPSHOT_SCHEMA_VERSION - 1` arithmetic tag on a freshly-encoded body) so it
        // will NOT drift on the next schema bump — it is a genuine stale-bytes witness
        // that a real old save stays refused forever.
        const FROZEN_V7_GENESIS: &[u8] = &[
            0x07, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x38, 0x3B, 0xF2, 0xC3, 0x35, 0x90, 0x8C, 0xDF, 0x0C, 0xD2, 0xC3, 0x0C, 0x8F, 0x2F,
            0xFF, 0xC9, 0x96, 0x35, 0x14, 0x29, 0x52, 0x51, 0x51, 0x93, 0x08, 0x19, 0x65, 0x34,
            0x15, 0x82, 0x93, 0xE4, 0x00, 0x00, 0x00,
        ];

        assert!(
            matches!(
                restore(FROZEN_V7_GENESIS),
                Err(DecodeError::SnapshotTooOld(7))
            ),
            "a frozen v7 snapshot must be refused as SnapshotTooOld(7) under v8"
        );
    }

    #[test]
    fn frozen_v8_belt_snapshot_is_refused_as_snapshot_too_old_under_v9() {
        // Phase 60 clean break (60-02/60-03, D-02): the SNAPSHOT 8->9 bump byte-forced by
        // the belt slot vector growing from three entries per tile to four means a REAL,
        // frozen v8-era snapshot blob must be REFUSED as a typed `SnapshotTooOld(8)` under
        // the v9 schema. Never a panic, never a silent mis-decode of the stale (3-per-tile)
        // slot bytes against the new 4-per-tile layout. The tag is checked BEFORE the body
        // is decoded, so this holds regardless of the (v8-shaped) body content.
        //
        // The literal below was captured ONCE, at `PHASE_60_BASE` (the pre-release tree
        // phase 60 started from), from a genuine pre-bump v8 encode of a
        // real belt-bearing `Core` while `SLOTS_PER_TILE` was still 3: an `08 00`
        // little-endian tag followed by the real postcard `Core` body. It is HARD-CODED
        // (not a `SNAPSHOT_SCHEMA_VERSION - 1` arithmetic tag on a freshly-encoded body) so
        // it will NOT drift on the next schema bump. It is a genuine stale-bytes witness
        // that a real old save stays refused forever.
        //
        // The fact the earlier two frozen witnesses could not carry: this blob is
        // BELT-BEARING. It holds a 2-tile belt with a 6-entry slot vector (`3 * 2`, byte 21
        // = 0x06), built as `Core::genesis(header(0x0000_0000_00C0_FFEE))` then
        // source -> belt(2) -> collector. That matters because a bare genesis has no belt
        // and so cannot fail the structural belt-slot invariant, which is exactly what the
        // second half of this test needs it to do. These 96 bytes are UNREPRODUCIBLE: no
        // tree in this repository can emit a 6-entry slot vector under a tag-8 snapshot now
        // that `SLOTS_PER_TILE` is 4. See `60-CORPUS-REVIEW.md` Stage 0.
        const FROZEN_V8_BELT_GENESIS: &[u8] = &[
            0x08, 0x00, 0x00, 0x04, 0x00, 0x00, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x03, 0x01,
            0x01, 0x00, 0x00, 0x02, 0x01, 0x01, 0x02, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x03, 0x01, 0x00, 0x00, 0x03, 0x01, 0x01, 0x00, 0x02, 0x01, 0x00, 0x03, 0x01,
            0x00, 0x02, 0x01, 0x01, 0x00, 0x02, 0x01, 0x00, 0x02, 0x01, 0x00, 0x03, 0x01, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x38, 0x3B, 0xF2, 0xC3, 0x35, 0x90, 0x8C, 0xDF, 0x0C,
            0xD2, 0xC3, 0x0C, 0x8F, 0x2F, 0xFF, 0xC9, 0x96, 0x35, 0x14, 0x29, 0x52, 0x51, 0x51,
            0x93, 0x08, 0x19, 0x65, 0x34, 0x15, 0x82, 0x93, 0xE4, 0x00, 0x00, 0x00,
        ];

        // The blob did not drift in transit from `60-CORPUS-REVIEW.md`: 96 bytes, an `08 00`
        // tag, and byte 21 = 0x06, the old `SLOTS_PER_TILE(3) * 2` slot-vector length that
        // must become 0x08 for any post-change belt of the same shape.
        assert_eq!(FROZEN_V8_BELT_GENESIS.len(), 96, "the captured blob is 96 bytes");
        assert_eq!(
            &FROZEN_V8_BELT_GENESIS[0..2],
            &[0x08, 0x00],
            "the captured blob carries a genuine pre-bump little-endian tag of 8"
        );
        assert_eq!(
            FROZEN_V8_BELT_GENESIS[21], 0x06,
            "byte 21 is the 6-entry slot vector: this is what makes the blob a witness"
        );

        assert!(
            matches!(
                restore(FROZEN_V8_BELT_GENESIS),
                Err(DecodeError::SnapshotTooOld(8))
            ),
            "a frozen v8 snapshot must be refused as SnapshotTooOld(8) under v9"
        );

        // What the version refusal SPARES the user, demonstrated rather than described.
        // Re-tag the SAME frozen body forward so the version gate waves it through, and the
        // stale body then fails with a corruption-shaped typed error, which is precisely
        // what `60-CONTEXT.md` names as unacceptable to show a user and which the
        // envelope/tag refusal above now fires AHEAD of. Without this half, the frozen
        // witness would prove only that a bumped constant refuses an old tag; with it, the
        // bump is proved to have done the job D-02 actually asked of it.
        //
        // WHICH corruption-shaped error THE RE-TAGGED BODY PRODUCES MOVED AT PHASE 62, and
        // the assertion is corrected in place rather than loosened. Until Phase 62 the
        // stale 6-entry slot vector DECODED (a `Belt` was three `Vec`s, all present in the
        // v8 bytes) and then failed the STRUCTURAL gate as
        // `InvalidState(BeltSlotCount)`. Phase 62 appends `Belt.ticks_per_slot`
        // (SLOT-03, `62-CONTEXT.md` D-01), so the v8 body is now SHORT: postcard runs out
        // of bytes decoding the new field and `restore()` returns `Malformed` BEFORE
        // `validate_invariants` is ever reached. Both are typed, reject-only refusals and
        // the claim this half exists to make is unchanged — a re-tagged stale save is
        // refused with a corruption-shaped error, never a panic and never a silent
        // mis-decode. Only the variant moved, and it moved for a cause this test can name.
        //
        // The assertion is on the EXACT variant, deliberately not widened to `is_err()`:
        // an `is_err()` here would survive any future decode regression and would stop
        // being a witness to anything.
        let mut retagged = FROZEN_V8_BELT_GENESIS.to_vec();
        let current = SNAPSHOT_SCHEMA_VERSION.to_le_bytes();
        retagged[0] = current[0];
        retagged[1] = current[1];
        assert!(
            matches!(restore(&retagged), Err(DecodeError::Malformed)),
            "re-tagged forward, the same pre-change body is refused with a corruption-shaped \
             typed error (Malformed since Phase 62's Belt.ticks_per_slot append; \
             InvalidState(BeltSlotCount) before it): got {:?}",
            // `Core` is not `Debug`, so discard the Ok payload to report the error side.
            restore(&retagged).map(|_| ())
        );
    }

    #[test]
    fn frozen_v9_belt_snapshot_is_refused_as_snapshot_too_old_under_v10() {
        // Phase 62 clean break (62-06, D-14): the SNAPSHOT 9->10 bump byte-forced by
        // `Belt.ticks_per_slot` (SLOT-03, `62-CONTEXT.md` D-01) means a REAL, frozen
        // v9-era snapshot blob must be REFUSED as a typed `SnapshotTooOld(9)` under the
        // v10 schema. Never a panic, never a silent mis-decode of a stale belt body
        // against the new layout. The tag is checked BEFORE the body is decoded, so this
        // holds regardless of the (v9-shaped) body content.
        //
        // PROVENANCE, and why these bytes are a genuine witness rather than a synthetic
        // one. They are the committed golden corpus fixture
        // `tests/golden/0001-source-belt-collector/genesis.snapshot`, read at the tree
        // that plan 62-05 left behind, i.e. BEFORE this plan's bump. That fixture was
        // frozen at Phase 60 and no tree in this repository can emit it again: `Belt`
        // gained `ticks_per_slot` at plan 62-01, so a freshly-encoded belt now carries a
        // trailing varint these bytes do not have. It is HARD-CODED here (not
        // `include_bytes!` of the live fixture) for two reasons that both matter. First,
        // the same reason the v6/v7/v8 witnesses above give: an arithmetic or live-file
        // tag would drift on the next schema bump and stop witnessing a real old save.
        // Second and specific to this phase: plan 62-09 RE-BLESSES that fixture, so a
        // live embed would silently re-point at a v10 blob and this test would quietly
        // stop asserting anything about a pre-change save.
        //
        // Byte 21 is `0x0C`: a 12-entry slot vector (`SLOTS_PER_TILE(4) * 3 tiles`),
        // which is what makes the blob BELT-BEARING and therefore the only kind of blob
        // whose body is actually short under v10.
        const FROZEN_V9_BELT_GENESIS: &[u8] = &[
            0x09, 0x00, 0x00, 0x04, 0x00, 0x00, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x03, 0x01,
            0x01, 0x00, 0x00, 0x02, 0x01, 0x01, 0x03, 0x0C, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0x01, 0x00, 0x00, 0x03, 0x01, 0x01,
            0x00, 0x02, 0x01, 0x00, 0x03, 0x01, 0x00, 0x02, 0x01, 0x01, 0x00, 0x02, 0x01, 0x00,
            0x02, 0x01, 0x00, 0x03, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0xA6, 0xA9,
            0x02, 0x3B, 0x06, 0x47, 0x92, 0x39, 0xFE, 0xB5, 0x3C, 0xA7, 0xB0, 0xEC, 0xD0, 0x04,
            0xDD, 0x1E, 0x1F, 0x40, 0x66, 0x05, 0x62, 0xA8, 0xD2, 0xF1, 0x73, 0xB3, 0xA5, 0x04,
            0x9E, 0x00, 0x00, 0x00,
        ];

        // The blob did not drift in transit: 102 bytes, an `09 00` tag, and byte 21 =
        // 0x0C, the 12-entry slot vector that makes it belt-bearing.
        assert_eq!(
            FROZEN_V9_BELT_GENESIS.len(),
            102,
            "the captured blob is 102 bytes"
        );
        assert_eq!(
            &FROZEN_V9_BELT_GENESIS[0..2],
            &[0x09, 0x00],
            "the captured blob carries a genuine pre-bump little-endian tag of 9"
        );
        assert_eq!(
            FROZEN_V9_BELT_GENESIS[21], 0x0C,
            "byte 21 is the 12-entry slot vector: this is what makes the blob a witness"
        );

        assert!(
            matches!(
                restore(FROZEN_V9_BELT_GENESIS),
                Err(DecodeError::SnapshotTooOld(9))
            ),
            "a frozen v9 snapshot must be refused as SnapshotTooOld(9) under v10: got {:?}",
            // `Core` is not `Debug`, so discard the Ok payload to report the error side.
            restore(FROZEN_V9_BELT_GENESIS).map(|_| ())
        );

        // What the version refusal SPARES the user, demonstrated rather than described,
        // exactly as the v8 witness above does it. Re-tag the SAME frozen body forward so
        // the version gate waves it through: postcard then runs out of bytes decoding the
        // appended `Belt.ticks_per_slot` and `restore` returns the corruption-shaped
        // `Malformed`. That is what a user would have been shown WITHOUT this bump, and it
        // is what `62-CONTEXT.md` D-14 names as unacceptable to show them. The assertion is
        // on the EXACT variant, deliberately not widened to `is_err()`, which would survive
        // any future decode regression and stop being a witness to anything.
        let mut retagged = FROZEN_V9_BELT_GENESIS.to_vec();
        let current = SNAPSHOT_SCHEMA_VERSION.to_le_bytes();
        retagged[0] = current[0];
        retagged[1] = current[1];
        assert!(
            matches!(restore(&retagged), Err(DecodeError::Malformed)),
            "re-tagged forward, the same pre-change body is refused with a corruption-shaped \
             typed error (Malformed: the v9 body is SHORT by the appended ticks_per_slot \
             varint): got {:?}",
            restore(&retagged).map(|_| ())
        );
    }

    #[test]
    fn frozen_v10_belt_snapshot_is_refused_as_snapshot_too_old_under_v12() {
        // PHASE 72'S DEBT, PAID HERE (74-CONTEXT.md D-10, LINK-14). Every other spent
        // schema version in this file has a witness; version 10 did not, because plan
        // 72-12 bumped 10 -> 11 without adding one. The chain therefore had a HOLE at 10,
        // and the hole gets harder to fill honestly with every further bump, which is the
        // argument for filling it in the phase that takes the next one rather than later.
        //
        // THIS WITNESS IS GREEN ON ARRIVAL, AND THAT IS CORRECT RATHER THAN A DEFECT.
        // Stated in words so nobody later reads its green as evidence for this phase's
        // bump. At the tree BEFORE plan 74-02, `SNAPSHOT_SCHEMA_VERSION` was already 11,
        // so a tag-10 blob was ALREADY refused as `SnapshotTooOld(10)`; this test would
        // have passed the moment it was written, on either side of the constant edit. It
        // earns its keep through its drift asserts and its re-tagged companion, not
        // through its primary assertion. **THE WITNESS THAT IS THIS PHASE'S OWN RED IS THE
        // v11 ONE BELOW**, which asserts `SnapshotTooOld(11)` and is false until the
        // constant reads 12.
        //
        // PROVENANCE, and why these bytes are a genuine witness rather than a synthetic
        // one. They are the committed golden corpus fixture
        // `tests/golden/0001-source-belt-collector/genesis.snapshot`, read from the newest
        // pre-release tree whose `crates/fabrico-core/src/snapshot.rs` literally read
        // `pub const SNAPSHOT_SCHEMA_VERSION: u16 = 10;`. It was the direct parent of plan
        // 72-12's SNAPSHOT 10 -> 11 bump, so it was the last tree that could emit a v10
        // blob at all. That history predates this repository and is not reproducible here,
        // which is why the bytes are frozen below.
        //
        // THE BOARD. Three nodes and two links: a manual-inject Source, a 3-tile Belt
        // (12 slots, `SLOTS_PER_TILE` 4 times 3 tiles) and a collector Source, wired
        // `source -> belt -> collector`. Genesis seed 0xBE17. No items are in flight; this
        // is the board at tick 0, before any event.
        //
        // CORROBORATED BY A SECOND, INDEPENDENT SOURCE before it was trusted: plan 74-01
        // built the same board through the minting path that existed in that tree, inside a
        // detached worktree, and encoded it live. 103 bytes, tag `0A 00`, byte 21
        // `0x0C`, byte 35 `0x02`, byte-identical to the committed fixture for its first 68
        // bytes and diverging only in the ChaCha RNG tail, where the fixture's generator
        // draws a different sub-seed. Never through `git stash`: the stash stack is global to
        // the repository and would catch any other uncommitted work in the tree.
        //
        // The bytes are HARD-CODED here rather than `include_bytes!` of the live fixture,
        // for the reasons the v6, v7, v8 and v9 witnesses above already give and for one
        // more that is specific to this phase: plan 74-02 RE-BLESSES all 33 golden
        // fixtures, so a live embed would silently re-point at a v12 blob and this test
        // would quietly stop asserting anything about a pre-thaw save. An arithmetic tag
        // (`SNAPSHOT_SCHEMA_VERSION - 2`) is refused for the same reason: it drifts forward
        // on the next bump and stops witnessing a real old save.
        const FROZEN_V10_BELT_GENESIS: &[u8] = &[
            0x0A, 0x00, 0x00, 0x04, 0x00, 0x00, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x03, 0x01,
            0x01, 0x00, 0x00, 0x02, 0x01, 0x01, 0x03, 0x0C, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0x03, 0x01, 0x00, 0x00, 0x03, 0x01,
            0x01, 0x00, 0x02, 0x01, 0x00, 0x03, 0x01, 0x00, 0x02, 0x01, 0x01, 0x00, 0x02, 0x01,
            0x00, 0x02, 0x01, 0x00, 0x03, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0xA6,
            0xA9, 0x02, 0x3B, 0x06, 0x47, 0x92, 0x39, 0xFE, 0xB5, 0x3C, 0xA7, 0xB0, 0xEC, 0xD0,
            0x04, 0xDD, 0x1E, 0x1F, 0x40, 0x66, 0x05, 0x62, 0xA8, 0xD2, 0xF1, 0x73, 0xB3, 0xA5,
            0x04, 0x9E, 0x00, 0x00, 0x00,
        ];

        // The blob did not drift in transit. FOUR asserts, one more than the v9 witness
        // carries, and the fourth is the one a forgery fails.
        assert_eq!(
            FROZEN_V10_BELT_GENESIS.len(),
            103,
            "the captured blob is 103 bytes"
        );
        assert_eq!(
            &FROZEN_V10_BELT_GENESIS[0..2],
            &[0x0A, 0x00],
            "the captured blob carries a genuine pre-thaw little-endian tag of 10"
        );
        assert_eq!(
            FROZEN_V10_BELT_GENESIS[21], 0x0C,
            "byte 21 is the 12-entry slot vector: this is what makes the blob BELT-BEARING, \
             and therefore a witness to a belt-bearing pre-thaw save rather than to any old save"
        );
        assert_eq!(
            FROZEN_V10_BELT_GENESIS[35], 0x02,
            "byte 35 is Belt.ticks_per_slot, appended by plan 62-01 and therefore ABSENT from \
             every v9 blob. A re-tagged v9 forgery (FROZEN_V9_BELT_GENESIS with byte 0 \
             overwritten) is 102 bytes and has 0x03 here, so this assert plus the length \
             assert make a re-tag detectable - the substitution LINK-14 forbids"
        );

        assert!(
            matches!(
                restore(FROZEN_V10_BELT_GENESIS),
                Err(DecodeError::SnapshotTooOld(10))
            ),
            "a frozen v10 snapshot must be refused as SnapshotTooOld(10) under v12: got {:?}",
            // `Core` is not `Debug`, so discard the Ok payload to report the error side.
            restore(FROZEN_V10_BELT_GENESIS).map(|_| ())
        );

        // WHAT THE VERSION REFUSAL SPARES THE USER, demonstrated rather than described -
        // and for THIS bump the demonstration is a different one from the v8 and v9
        // witnesses above, because this bump is not byte-forced. See
        // `SNAPSHOT_SCHEMA_VERSION`'s own docblock. Re-tag the SAME frozen body forward so
        // the version gate waves it through: postcard does NOT run out of bytes, because
        // `ports` is a map that already existed and no struct gained a field. The body
        // DECODES, passes the trust gate, and yields a board whose belt answers
        // `ports_of(belt) == None`.
        //
        // That is the silent mis-decode, and it is what a user would have got WITHOUT this
        // bump: their board opens, looks right, and every attempt to join two runs on it
        // refuses with the same `InvalidDock` an illegal dock earns, with nothing naming
        // the cause. Asserting a `Malformed` here instead would be asserting something
        // untrue, and a companion that asserted `is_err()` would be a check that cannot
        // fail. This one fails on any tree where a re-tagged pre-thaw belt comes back
        // ported.
        //
        // SINCE SNAPSHOT 14 (plan 87-03) the answer moved again, and the companion follows
        // the truth: phase 87 appended `Scheduler::blocked` and three node fields, so the
        // re-tagged body no longer lines up and comes back `Malformed`. The un-ported
        // reading above held from SNAPSHOT 12 through 13 and is kept as the record of why
        // the Phase 74 refusal was deliberate. See the helper.
        assert_retagged_body_is_refused_as_malformed_since_v14(FROZEN_V10_BELT_GENESIS);
    }

    #[test]
    fn frozen_v11_belt_snapshot_is_refused_as_snapshot_too_old_under_v12() {
        // THIS IS PHASE 74'S OWN RED (74-CONTEXT.md D-10, LINK-14). Unlike the v10 witness
        // above, this test is FALSE until `SNAPSHOT_SCHEMA_VERSION` reads 12: a tag-11 blob
        // decodes perfectly well under an 11 schema, so `SnapshotTooOld(11)` is exactly the
        // assertion a tree without this phase's bump fails.
        //
        // PROVENANCE. The committed golden corpus fixture
        // `tests/golden/0001-source-belt-collector/genesis.snapshot`, read from this plan's
        // own parent tree (pre-release history, not in this repository) - the last tree
        // whose corpus was still blessed at schema 11, immediately before plan 74-02's
        // re-bless. The same
        // board, the same seed and the same fixture the v9 and v10 witnesses carry, which
        // is what makes the chain readable end to end.
        //
        // IT IS THE v10 BODY WITH ONE BYTE CHANGED, AND THAT IS A FACT ABOUT PHASE 72
        // RATHER THAN A SHORTCUT TAKEN HERE. Say so plainly, because a reader who noticed
        // it unaided would be right to suspect a re-tag. MEASURED: these 103 bytes differ
        // from `FROZEN_V10_BELT_GENESIS` at index 0 and NOWHERE ELSE. The reason is that
        // plan 72-12's bump was byte-forced by `Node::Endpoint` gaining its Route path, and
        // THIS BOARD HOLDS NO ENDPOINT - a Source, a Belt and a Source - so nothing in its
        // body could move. These are the bytes the repository actually committed under
        // schema 11; that they are a one-byte neighbour of the v10 ones is what a
        // tag-only bump looks like from the corpus, not evidence of a forgery.
        //
        // Hard-coded rather than `include_bytes!`, for the reasons the witnesses above
        // give and because this plan re-blesses that very fixture to v12 in the commit
        // before this one.
        const FROZEN_V11_BELT_GENESIS: &[u8] = &[
            0x0B, 0x00, 0x00, 0x04, 0x00, 0x00, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x03, 0x01,
            0x01, 0x00, 0x00, 0x02, 0x01, 0x01, 0x03, 0x0C, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0x03, 0x01, 0x00, 0x00, 0x03, 0x01,
            0x01, 0x00, 0x02, 0x01, 0x00, 0x03, 0x01, 0x00, 0x02, 0x01, 0x01, 0x00, 0x02, 0x01,
            0x00, 0x02, 0x01, 0x00, 0x03, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0xA6,
            0xA9, 0x02, 0x3B, 0x06, 0x47, 0x92, 0x39, 0xFE, 0xB5, 0x3C, 0xA7, 0xB0, 0xEC, 0xD0,
            0x04, 0xDD, 0x1E, 0x1F, 0x40, 0x66, 0x05, 0x62, 0xA8, 0xD2, 0xF1, 0x73, 0xB3, 0xA5,
            0x04, 0x9E, 0x00, 0x00, 0x00,
        ];

        // The blob did not drift in transit. FOUR asserts, the same four the v10 witness
        // carries, because it is the same board one tag apart and a reader comparing the
        // two should be able to compare them line for line.
        assert_eq!(
            FROZEN_V11_BELT_GENESIS.len(),
            103,
            "the captured blob is 103 bytes"
        );
        assert_eq!(
            &FROZEN_V11_BELT_GENESIS[0..2],
            &[0x0B, 0x00],
            "the captured blob carries a genuine pre-bump little-endian tag of 11"
        );
        assert_eq!(
            FROZEN_V11_BELT_GENESIS[21], 0x0C,
            "byte 21 is the 12-entry slot vector: this is what makes the blob BELT-BEARING, \
             and a belt-bearing blob is the only kind whose belts this bump changes"
        );
        assert_eq!(
            FROZEN_V11_BELT_GENESIS[35], 0x02,
            "byte 35 is Belt.ticks_per_slot, ABSENT from every v9 blob, so this assert plus \
             the length assert make a re-tagged v9 forgery detectable here too"
        );

        assert!(
            matches!(
                restore(FROZEN_V11_BELT_GENESIS),
                Err(DecodeError::SnapshotTooOld(11))
            ),
            "a frozen v11 snapshot must be refused as SnapshotTooOld(11) under v12 - this is \
             the assertion a tree WITHOUT the Phase 74 bump fails: got {:?}",
            restore(FROZEN_V11_BELT_GENESIS).map(|_| ())
        );

        // The same demonstration the v10 witness carries, on the version this phase
        // actually retires. See its comment for why the companion asserted an un-ported
        // decode through SNAPSHOT 13 and asserts `Malformed` since SNAPSHOT 14.
        assert_retagged_body_is_refused_as_malformed_since_v14(FROZEN_V11_BELT_GENESIS);
    }

    #[test]
    fn frozen_v12_http_sink_snapshot_is_refused_as_snapshot_too_old_under_v13() {
        // PHASE 85'S OWN RED (85-CONTEXT.md D-08, CHROME-04). Removing the Email sink
        // target shifts `SinkTemplate::Http` from discriminant 2 to 1 inside every
        // snapshot that holds an HTTP sink, so a v12 blob must be refused by its tag,
        // never decoded positionally against the shifted enum. FALSE until
        // `SNAPSHOT_SCHEMA_VERSION` reads 13: a tag-12 blob restores cleanly under 12.
        //
        // PROVENANCE. Captured ONCE at plan 85-05's start revision (SNAPSHOT 12) from
        // `snapshot(&core)` of `Core::genesis` at seed 0xC0FFEE holding
        // one sink added by `add_sink(SinkTemplate::Http { url:
        // "https://example.com/hook", method: Post }, 1)`. Byte 12 is that template's
        // v12 discriminant, 2 (Http with Email still at 1). Hard-coded, never
        // regenerated: it is the stale-bytes witness that a v12 board stays refused.
        const FROZEN_V12_HTTP_SINK: &[u8] = &[
            0x0C, 0x00, 0x00, 0x02, 0x00, 0x00, 0x01, 0x01, 0x01, 0x01, 0x01, 0x07, 0x02, 0x18,
            0x68, 0x74, 0x74, 0x70, 0x73, 0x3A, 0x2F, 0x2F, 0x65, 0x78, 0x61, 0x6D, 0x70, 0x6C,
            0x65, 0x2E, 0x63, 0x6F, 0x6D, 0x2F, 0x68, 0x6F, 0x6F, 0x6B, 0x01, 0x01, 0x01, 0x01,
            0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x38, 0x3B, 0xF2, 0xC3, 0x35, 0x90,
            0x8C, 0xDF, 0x0C, 0xD2, 0xC3, 0x0C, 0x8F, 0x2F, 0xFF, 0xC9, 0x96, 0x35, 0x14, 0x29,
            0x52, 0x51, 0x51, 0x93, 0x08, 0x19, 0x65, 0x34, 0x15, 0x82, 0x93, 0xE4, 0x00, 0x00,
            0x00,
        ];
        assert_eq!(
            &FROZEN_V12_HTTP_SINK[0..2],
            &[0x0C, 0x00],
            "the captured blob carries a genuine pre-bump little-endian tag of 12"
        );
        assert_eq!(
            FROZEN_V12_HTTP_SINK[12], 0x02,
            "byte 12 is the sink's v12 SinkTemplate discriminant: Http sat at 2 before the mail target left"
        );
        assert!(
            matches!(
                restore(FROZEN_V12_HTTP_SINK),
                Err(DecodeError::SnapshotTooOld(12))
            ),
            "a frozen v12 snapshot holding an Http sink must be refused as SnapshotTooOld(12) \
             under v13 - this is the assertion a tree WITHOUT the phase 85 bump fails: got {:?}",
            restore(FROZEN_V12_HTTP_SINK).map(|_| ())
        );
    }

    #[test]
    fn frozen_v13_snapshot_is_refused_as_snapshot_too_old_under_v14() {
        // PHASE 87'S OWN RED (87-03, JAM-01, D-02 to D-07). Four fields were appended last
        // (`Balancer::next_in`, `Tee::faults`, `Factory::pending_emits`,
        // `Scheduler::blocked`), so a v13 body decoded positionally against the v14 shape
        // would read its Balancers, Tees and Factories one field short and its scheduler
        // with no `blocked` set. It must be refused by its tag. FALSE until
        // `SNAPSHOT_SCHEMA_VERSION` reads 14: a tag-13 blob restores cleanly under 13
        // (seen FAILED there, `87-EVIDENCE.md` `## Plan 87-03`).
        //
        // PROVENANCE. Captured ONCE at plan 87-03's start revision (SNAPSHOT 13) from
        // `snapshot(&core)` of `Core::genesis` at seed 0x87_0003 holding a
        // Source, a Factory running the one-line passthrough
        // `export default function (input, ctx) { ctx.emit(0, input); }` (gas
        // `DEFAULT_GAS_BUDGET`, rng seed 3), a 1-tile belt, a 2-output Balancer, a 2-output
        // Tee and two Debug sinks, linked Source -> Factory -> belt -> Balancer In 0,
        // Balancer Out 0 -> Tee, Tee Outs -> the sinks, after 30 ticks with one fired item
        // per tick. Hard-coded, never regenerated: it is the stale-bytes witness that a v13
        // board holding all three node kinds that gained a field stays refused.
        const FROZEN_V13_BALANCER_TEE_FACTORY: &[u8] = &[
            0x0D, 0x00, 0x1E, 0x08, 0x00, 0x00, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01,
            0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x07, 0x01, 0x01, 0x00, 0x00, 0x02, 0x01, 0x06,
            0x3C, 0x65, 0x78, 0x70, 0x6F, 0x72, 0x74, 0x20, 0x64, 0x65, 0x66, 0x61, 0x75, 0x6C,
            0x74, 0x20, 0x66, 0x75, 0x6E, 0x63, 0x74, 0x69, 0x6F, 0x6E, 0x20, 0x28, 0x69, 0x6E,
            0x70, 0x75, 0x74, 0x2C, 0x20, 0x63, 0x74, 0x78, 0x29, 0x20, 0x7B, 0x20, 0x63, 0x74,
            0x78, 0x2E, 0x65, 0x6D, 0x69, 0x74, 0x28, 0x30, 0x2C, 0x20, 0x69, 0x6E, 0x70, 0x75,
            0x74, 0x29, 0x3B, 0x20, 0x7D, 0x80, 0x02, 0xD6, 0xF3, 0xA0, 0x8E, 0xC9, 0x9E, 0x15,
            0x62, 0x07, 0xC5, 0x94, 0xD9, 0xF1, 0x9C, 0xA8, 0x11, 0x5D, 0x88, 0x86, 0xD0, 0x2A,
            0x83, 0xC4, 0x0D, 0x34, 0x7E, 0x3E, 0x1F, 0x5F, 0xA2, 0xF8, 0x81, 0x00, 0x00, 0x02,
            0x7B, 0x7D, 0x1E, 0x03, 0x01, 0x01, 0x01, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02,
            0x04, 0x01, 0x03, 0x02, 0x00, 0x05, 0x01, 0x02, 0x02, 0x06, 0x01, 0x07, 0x00, 0x00,
            0x07, 0x01, 0x07, 0x00, 0x00, 0x07, 0x01, 0x01, 0x00, 0x02, 0x01, 0x00, 0x03, 0x01,
            0x00, 0x04, 0x01, 0x00, 0x05, 0x01, 0x00, 0x06, 0x01, 0x00, 0x07, 0x01, 0x00, 0x06,
            0x01, 0x01, 0x00, 0x02, 0x01, 0x00, 0x02, 0x01, 0x00, 0x03, 0x01, 0x00, 0x03, 0x01,
            0x00, 0x04, 0x01, 0x00, 0x04, 0x01, 0x00, 0x05, 0x01, 0x00, 0x05, 0x01, 0x00, 0x06,
            0x01, 0x00, 0x05, 0x01, 0x01, 0x07, 0x01, 0x00, 0x00, 0x00, 0x01, 0x03, 0x01, 0x02,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x8F, 0x4F,
            0x86, 0xD1, 0x82, 0x79, 0x89, 0xF2, 0x7E, 0xBA, 0x60, 0x33, 0x85, 0x12, 0x87, 0xFD,
            0x4B, 0x95, 0x92, 0x4C, 0x6E, 0xEB, 0xAF, 0x9D, 0x34, 0xFE, 0x26, 0xC9, 0xFC, 0x34,
            0x0F, 0x5D, 0x00, 0x00, 0x00,
        ];
        assert_eq!(
            FROZEN_V13_BALANCER_TEE_FACTORY.len(),
            271,
            "the captured blob is 271 bytes"
        );
        assert_eq!(
            &FROZEN_V13_BALANCER_TEE_FACTORY[0..2],
            &[0x0D, 0x00],
            "the captured blob carries a genuine pre-bump little-endian tag of 13"
        );
        assert!(
            matches!(
                restore(FROZEN_V13_BALANCER_TEE_FACTORY),
                Err(DecodeError::SnapshotTooOld(13))
            ),
            "a frozen v13 snapshot holding a Balancer, a Tee and a Factory must be refused as \
             SnapshotTooOld(13) under v14 - this is the assertion a tree WITHOUT the phase 87 \
             bump fails: got {:?}",
            restore(FROZEN_V13_BALANCER_TEE_FACTORY).map(|_| ())
        );
    }

    /// The re-tagged-forward companion the frozen v10 and v11 witnesses share: take a
    /// pre-thaw body, overwrite bytes 0 and 1 with the CURRENT
    /// `SNAPSHOT_SCHEMA_VERSION.to_le_bytes()` so the version gate waves it through, and
    /// assert what the user would then be shown.
    ///
    /// For the Phase 60, 62 and 72 bumps that answer was a corruption-shaped
    /// `DecodeError::Malformed`, and the v8 and v9 witnesses above assert exactly that on
    /// the exact variant. **For the Phase 74 bump the answer is different and worse**, and
    /// this helper asserts the truth rather than the pattern: the body DECODES, because
    /// `ports` is a map that already existed and no struct gained a field, and the board it
    /// yields has a belt with NO PORTS. MEASURED before it was written, not assumed.
    ///
    /// It was a check that CAN fail, which is the property that matters: on a tree where a
    /// re-tagged pre-thaw belt came back ported - by a migration shim, by a derive-on-read
    /// implementation, or by any future `restore` that back-filled the map - its second
    /// assertion went red. Through SNAPSHOT 13 an `is_err()`, or a `Malformed`, would have
    /// been a check that cannot fail, since neither was what the decoder did.
    ///
    /// # Since SNAPSHOT 14 (plan 87-03, MEASURED)
    /// Phase 87 appended `Scheduler::blocked` and three node fields, so a re-tagged v10 or
    /// v11 body no longer lines up with the current shape: its bytes after the scheduler
    /// are read as the new set, and the decode fails. `restore` now answers
    /// [`DecodeError::Malformed`], which is the truth this helper asserts, measured on both
    /// frozen bodies at the bump. It is still a check that can fail: a decoder that
    /// back-filled the missing fields, or any shim that read the old body as current, would
    /// return `Ok` and go red here. The un-ported-belt reading above is the record of why
    /// the Phase 74 refusal was deliberate; the tag refusal in each witness is what still
    /// stands between a user and either answer.
    fn assert_retagged_body_is_refused_as_malformed_since_v14(blob: &[u8]) {
        let mut retagged = blob.to_vec();
        let current = SNAPSHOT_SCHEMA_VERSION.to_le_bytes();
        retagged[0] = current[0];
        retagged[1] = current[1];
        let got = restore(&retagged).map(|_| ());
        assert!(
            matches!(got, Err(DecodeError::Malformed)),
            "re-tagged forward to SNAPSHOT 14, this pre-thaw body no longer lines up with the \
             phase 87 shape and must be refused as Malformed, never read as a current board: \
             got {got:?}"
        );
    }

    #[test]
    fn snapshot_schema_version_is_fourteen_after_phase_87s_four_fields() {
        // Direct value pin mirroring the event/edit/render-packet pins
        // (`schema_version_is_two_after_v6_rebless`,
        // `edit_schema_version_is_six_after_v6_rebless`). The frozen-v7 refusal test above
        // pins the version only INDIRECTLY (an accidental bump with no new frozen witness
        // would slip past it); this catches a silent future change to the snapshot schema
        // DIRECTLY. Bumped 7->8 by the v6.0 re-bless (35-03), byte-forced by
        // `Port.medium`, in lockstep with EDIT 5->6 / PROJECT 5->6 / event SCHEMA_VERSION
        // 1->2 / cmd EVENT_VERSION 2->3.
        //
        // Bumped 8->9 by Phase 60 (60-02), byte-forced by the belt slot vector growing
        // from three entries per tile to four, in lockstep with PROJECT 6->7 and with
        // NOTHING else: EDIT, event and cmd-wire shapes are unchanged and their own pins
        // stay put, which is the positive evidence that this bump was scoped.
        //
        // Bumped 9->10 by Phase 62 (62-06), byte-forced by `Belt.ticks_per_slot`
        // (SLOT-03), in lockstep with PROJECT 7->8 and again with NOTHING else. The three
        // unmoved pins are the positive evidence that this bump was scoped too, and the
        // five-constant tripwire at `fabrico-host/tests/endpoint.rs` machine-checks that
        // claim rather than leaving it asserted.
        //
        // Bumped 10->11 by Phase 72 (72-12, D-20), byte-forced by `Node::Endpoint`
        // gaining its Route path `String` (72-07, SERVE-08), in lockstep with PROJECT
        // 8->9 and cmd EVENT_VERSION 3->4. THREE of the five moved this time, which is a
        // wider lockstep than the last two bumps took, and the two that did NOT move
        // (EDIT_SCHEMA_VERSION, event SCHEMA_VERSION) are the positive evidence that even
        // this wider bump was scoped: every edit-side change Phase 72 made is an append at
        // the last position (D-21).
        //
        // Bumped 11->12 by Phase 74 (74-02, D-09, LINK-08), byte-forced by a `Belt`
        // gaining TWO stored `Port` records so belts and machines share one link model,
        // in lockstep with PROJECT 10->11 and with NOTHING else. TWO of the five moved.
        // The three unmoved pins (EDIT_SCHEMA_VERSION, event SCHEMA_VERSION, cmd
        // EVENT_VERSION) are again the positive evidence that the bump was scoped: the
        // belt ports are a `GridState` shape and nothing else about the edit, event or
        // command wire changed.
        //
        // RENAMED at every bump, deliberately rather than left with a stale name
        // asserting a new number: off the eight-naming name at Phase 60, off the
        // nine-naming one at Phase 62, and off the ten-naming one here. Those three
        // superseded spellings are NOT transcribed, and that is not squeamishness: the
        // repository greps this file for a name that encodes the old value as the
        // machine-checkable half of this discipline (72-12 gate), so quoting one back
        // would be the stale name it exists to exclude. The old spellings live only in the
        // pre-release history, which this repository does not carry.
        //
        // Bumped 12->13 by Phase 85 (85-05, D-08, CHROME-04), byte-forced by the Email
        // sink target's deletion (`SinkTemplate::Http` moves from discriminant 2 to 1), in
        // lockstep with EDIT 11->12 and cmd EVENT_VERSION 4->5. THREE of the five moved;
        // PROJECT holds at 11 until plan 85-09 and event SCHEMA_VERSION at 2. Renamed off
        // the twelve-naming name, by the same rule.
        //
        // Bumped 13->14 by Phase 87 (87-03, JAM-01, D-02 to D-07), byte-forced by four
        // fields appended last (`Balancer::next_in`, `Tee::faults`,
        // `Factory::pending_emits`, `Scheduler::blocked`), in lockstep with PROJECT 12->13
        // and with NOTHING else. TWO of the five moved; EDIT holds at 13, event
        // SCHEMA_VERSION at 2 and cmd EVENT_VERSION at 5. Renamed off the thirteen-naming
        // name, by the same rule.
        //
        // It is a HAND-WRITTEN literal and must stay one: derived from
        // `SNAPSHOT_SCHEMA_VERSION` it would agree at every value.
        assert_eq!(
            SNAPSHOT_SCHEMA_VERSION, 14,
            "phase 87's four appended fields pin the snapshot schema to 14"
        );
    }

    // ───────────────── v6.0 re-bless forge-reject coverage (SCHEMA-03, 35-04) ─────────────────
    //
    // Reject-only trust-gate proof that EVERY new decoded shape the v6.0 re-bless added
    // maps to a typed reject (or a no-panic Ok) on the untrusted-load path — never a
    // panic/OOM/hang. RESEARCH A2 predicted ZERO new `StateInvariant` variants were
    // required (the Phase-10 `DanglingFootprint`/`PortOutOfFootprint` checks are
    // node-kind-agnostic and `Medium` is a total enum postcard rejects natively); these
    // tests are the automated evidence. None mutate the wire format or re-bless a
    // fixture — the golden corpus stays at its frozen v6.0 hashes.

    /// SCHEMA-03 / threat T-35-12-MEDIUMDISC: a forged snapshot carrying a `Port` whose
    /// `medium` varint is PAST the last valid `Medium` discriminant is refused as a
    /// typed [`DecodeError::Malformed`] — postcard rejects the total fieldless enum
    /// natively, so there is NO partial state, no panic, and no new `StateInvariant`.
    ///
    /// The medium byte is located by diffing two otherwise-identical snapshots that
    /// differ ONLY in one stored port's medium (`Mechanical = 0` vs `Electrical = 1`);
    /// that sole differing byte is then bumped to an out-of-range discriminant (`2`).
    #[test]
    fn restore_rejects_out_of_range_port_medium_as_malformed() {
        use crate::state::{Footprint, Medium, Port, Role, Side};
        // Two VALID Cores, identical but for one stored port's `medium`.
        let build = |medium: Medium| {
            let mut core = Core::genesis(header(0x0ED1));
            let s = core.state.add_source();
            core.state.test_force_footprint(
                s,
                Footprint { w: 1, h: 1, rot: 0 },
                vec![Port { local_offset: (0, 0), side: Side::N, role: Role::In, medium }],
            );
            core
        };
        let mech = snapshot(&build(Medium::Mechanical));
        let elec = snapshot(&build(Medium::Electrical));
        // Sanity: both base snapshots are legitimate and restore Ok.
        assert!(restore(&mech).is_ok(), "the Mechanical-medium base snapshot is valid");
        assert!(restore(&elec).is_ok(), "the Electrical-medium base snapshot is valid");
        // The medium varint is the SOLE differing byte (a test-setup invariant — if this
        // ever trips it is the harness, NOT a bless trigger).
        assert_eq!(mech.len(), elec.len(), "same-shape snapshots are equal length");
        let diffs: Vec<usize> = (0..mech.len()).filter(|&i| mech[i] != elec[i]).collect();
        assert_eq!(diffs.len(), 1, "the Port.medium varint is the only differing byte");
        let medium_pos = diffs[0];
        assert_eq!(
            (mech[medium_pos], elec[medium_pos]),
            (0x00, 0x01),
            "Medium::Mechanical encodes as 0, Electrical as 1",
        );
        // Forge an out-of-range discriminant (2 — no such `Medium` variant) → Malformed.
        let mut forged = elec;
        forged[medium_pos] = 0x02;
        assert!(
            matches!(restore(&forged), Err(DecodeError::Malformed)),
            "an out-of-range Port.medium discriminant is refused as postcard Malformed",
        );
    }

    /// SCHEMA-03 / threat T-35-13-DANGLEKIND: with a LIVE `Node::Wire` AND
    /// `Node::Endpoint` occupying the store, a forged `footprints` entry keyed to a
    /// NON-live `NodeId` is refused via the EXISTING node-kind-agnostic
    /// [`StateInvariant::DanglingFootprint`] check — proving the Phase-10 gate already
    /// generalizes to the v6.0 kinds (RESEARCH A2: no new invariant needed). Reject-only.
    #[test]
    fn restore_rejects_dangling_footprint_with_wire_endpoint_in_store() {
        use crate::state::{Endpoint, Footprint, Node, WireLink};
        let mut core = Core::genesis(header(0xDA47));
        let s = core.state.add_source();
        // The v6.0 inert kinds LIVE in the store while the gate runs.
        let _w = core
            .state
            .test_insert_inert(Node::Wire(WireLink { from: (s, 0), to: (s, 1), in_flight: std::collections::VecDeque::new() }));
        let _e = core.state.test_insert_inert(Node::Endpoint(Endpoint { path: TEST_ENDPOINT_PATH.to_owned() }));
        // A footprint keyed to a ghost id (no live node) — the node-agnostic reject.
        let ghost = ghost_id();
        core.state
            .test_force_footprint(ghost, Footprint { w: 2, h: 2, rot: 0 }, vec![]);
        let bytes = snapshot(&core);
        assert!(matches!(
            restore(&bytes),
            Err(DecodeError::InvalidState(StateInvariant::DanglingFootprint))
        ));
    }

    /// SCHEMA-03 / threat T-35-13-DANGLEKIND: a LIVE `Node::Wire` given a `Port` whose
    /// `local_offset` lies OUTSIDE its `[0,w)×[0,h)` footprint box is refused with the
    /// EXISTING [`StateInvariant::PortOutOfFootprint`] check — the gate is
    /// node-kind-agnostic, so the v6.0 wire kind is covered with no new invariant.
    #[test]
    fn restore_rejects_wire_port_out_of_footprint() {
        use crate::state::{Footprint, Medium, Node, Port, Role, Side, WireLink};
        let mut core = Core::genesis(header(0x0B0C));
        let s = core.state.add_source();
        let w = core
            .state
            .test_insert_inert(Node::Wire(WireLink { from: (s, 0), to: (s, 1), in_flight: std::collections::VecDeque::new() }));
        // A 2×2 footprint with a port at (5,5) — far outside [0,2)×[0,2).
        core.state.test_force_footprint(
            w,
            Footprint { w: 2, h: 2, rot: 0 },
            vec![Port { local_offset: (5, 5), side: Side::E, role: Role::Out, medium: Medium::Mechanical }],
        );
        let bytes = snapshot(&core);
        assert!(matches!(
            restore(&bytes),
            Err(DecodeError::InvalidState(StateInvariant::PortOutOfFootprint))
        ));
    }

    /// SCHEMA-03 / threat T-35-14-INERTSTEP: a structurally-valid snapshot carrying a
    /// LIVE `Node::Wire` AND `Node::Endpoint` — both SCHEDULED to wake — restores `Ok`
    /// through the trust gate, and a subsequent `advance` STEPS both with no panic and
    /// no hang. The dispatch is no longer a typed no-op for BOTH: a wire is driven by
    /// the tick's transport pass since Phase 37, while an endpoint still has no core
    /// step because Phase 38 put its behaviour host-side. What the test asserts is
    /// unchanged and is the point — whatever a forged node reaches, it cannot crash the
    /// untrusted-load path.
    #[test]
    fn restore_ok_and_steps_inert_wire_endpoint_without_panic() {
        use crate::state::{Endpoint, Node, WireLink};
        let mut core = Core::genesis(header(0x1EE7));
        let s = core.state.add_source();
        let w = core
            .state
            .test_insert_inert(Node::Wire(WireLink { from: (s, 0), to: (s, 1), in_flight: std::collections::VecDeque::new() }));
        let e = core.state.test_insert_inert(Node::Endpoint(Endpoint { path: TEST_ENDPOINT_PATH.to_owned() }));
        // Schedule both to wake at the boundary tick so the restored Core ACTUALLY
        // steps them through the inert dispatch arm (the no-panic proof on the load path).
        core.sched.schedule_wake(w, core.tick);
        core.sched.schedule_wake(e, core.tick);
        let bytes = snapshot(&core);
        // The structurally-valid inert-node snapshot restores Ok (the gate accepts it).
        let mut restored =
            restore(&bytes).expect("a valid inert wire/endpoint snapshot restores Ok");
        // Stepping the scheduled inert nodes is a typed no-op — never a panic/hang.
        let _ = restored.advance(&[]);
        // Both inert nodes survive the step unchanged; time advanced (idle-safe).
        assert_eq!(
            restored.state.node(w),
            Some(&Node::Wire(WireLink { from: (s, 0), to: (s, 1), in_flight: std::collections::VecDeque::new() })),
        );
        assert_eq!(restored.state.node(e), Some(&Node::Endpoint(Endpoint { path: TEST_ENDPOINT_PATH.to_owned() })));
    }

    // ---------------------------------------------------------------------------
    // PILE-09 / PILE-04: the forged over-cap queues, and the ONE case the design
    // deliberately does NOT refuse (ruling R-19).
    // ---------------------------------------------------------------------------

    /// A node with ONE DECLARED port. Which `medium` it speaks is the only field the
    /// bounded and the unbounded arms below differ in, which is what makes the pair a
    /// test of the declared-medium clause rather than of two unrelated boards.
    fn declare_one_in_port(core: &mut Core, id: NodeId, medium: crate::state::Medium) {
        core.state.set_ports(
            id,
            vec![crate::state::Port {
                local_offset: (0, 0),
                side: crate::state::Side::W,
                role: crate::state::Role::In,
                medium,
            }],
        );
    }

    /// Forge `n` items onto `(id, port)` DIRECTLY, bypassing `admit::try_admit`. That
    /// bypass is the point: the live admission path refuses at the cap, so an over-cap
    /// bucket is unreachable from any live grid and only a hand-forged save file can
    /// carry one. This helper IS the forgery.
    fn forge_inbox(core: &mut Core, id: NodeId, port: crate::ids::PortId, n: usize) {
        for i in 0..n {
            core.state
                .inbox_mut(id)
                .push(port, i as u64, Item(vec![(i & 0xFF) as u8]));
        }
    }

    /// PILE-09 clause 2: a forged inbox over `MECHANICAL_INBOX_CAP` on a port DECLARED
    /// `Medium::Mechanical` is a typed rejection, not an allocation.
    #[test]
    fn restore_rejects_forged_over_cap_declared_mechanical_inbox() {
        let mut core = Core::genesis(header(0x7104_0001));
        let d = core.state.add_source();
        declare_one_in_port(&mut core, d, crate::state::Medium::Mechanical);
        forge_inbox(&mut core, d, 0, crate::admit::MECHANICAL_INBOX_CAP + 1);
        let bytes = snapshot(&core);
        assert!(matches!(
            restore(&bytes),
            Err(DecodeError::InvalidState(StateInvariant::InboxTooMany))
        ));
    }

    /// PILE-09 clause 1: a forged `FAULT_PORT` bucket over `FAULT_QUEUE_CAP` is a typed
    /// rejection on ANY node, declared ports or not. `FAULT_PORT` is `u16::MAX` and is
    /// never a declared port index, so its class is unambiguous from the bytes alone -
    /// which is exactly why this clause needs no port declaration and clause 2 does.
    #[test]
    fn restore_rejects_forged_over_cap_fault_queue() {
        let mut core = Core::genesis(header(0x7104_0002));
        let d = core.state.add_source();
        forge_inbox(
            &mut core,
            d,
            crate::fault::FAULT_PORT,
            crate::admit::FAULT_QUEUE_CAP + 1,
        );
        let bytes = snapshot(&core);
        assert!(matches!(
            restore(&bytes),
            Err(DecodeError::InvalidState(StateInvariant::InboxTooMany))
        ));
    }

    /// **THE REGRESSION ANCHOR FOR RULING R-19, AND IT ASSERTS AN ACCEPTANCE.**
    ///
    /// A PORT-LESS node carrying far more than `MECHANICAL_INBOX_CAP` items on port 0 is
    /// ACCEPTED. That is the golden `0026-wire-cap-overflow-fanin` board shape: 256
    /// same-tick wire messages delivered into a port-less `add_source()` collector, every
    /// one of which must arrive. A snapshot does not carry the EMITTER, so those bytes
    /// are indistinguishable from a forged over-cap mechanical inbox, and refusing them
    /// would refuse a legitimate board.
    ///
    /// Without this test the rule reads as an oversight, a later reader "tightens" the
    /// walk to cover undeclared ports, and the corpus breaks (threat T-71-04-05). The
    /// forged count is deliberately far past the cap rather than one past it, so the
    /// acceptance cannot be an off-by-one.
    #[test]
    fn restore_accepts_over_cap_inbox_on_a_port_less_node() {
        let mut core = Core::genesis(header(0x7104_0003));
        let d = core.state.add_source();
        assert!(
            core.state.ports_of(d).is_none(),
            "non-vacuity: the node under test must be PORT-LESS, or this asserts nothing \
             about the undeclared-port clause"
        );
        forge_inbox(&mut core, d, 0, crate::admit::MECHANICAL_INBOX_CAP * 16);
        let bytes = snapshot(&core);
        let restored = restore(&bytes).expect("a port-less over-cap inbox is ACCEPTED (R-19)");
        assert_eq!(
            restored.state.inbox_of(d).map_or(0, |i| i.len_on(0)),
            crate::admit::MECHANICAL_INBOX_CAP * 16,
            "and it round-trips with every item intact"
        );
    }

    /// PILE-04: a forged `ManualInject.pending` over `SOURCE_PENDING_CAP` gets its OWN
    /// variant. Asserted as an exact match rather than "some InvalidState", because the
    /// whole reason it is a second variant is that a shared one would name the wrong
    /// queue.
    #[test]
    fn restore_rejects_forged_over_cap_source_pending() {
        let mut core = Core::genesis(header(0x7104_0004));
        let d = core.state.add_source();
        if let Some(Node::Source(source)) = core.state.node_mut(d) {
            for i in 0..=crate::admit::SOURCE_PENDING_CAP {
                source.pending.push_back(Item(vec![(i & 0xFF) as u8]));
            }
        }
        let bytes = snapshot(&core);
        assert_eq!(
            restore(&bytes).err(),
            Some(DecodeError::InvalidState(
                StateInvariant::SourcePendingTooMany
            )),
            "a forged pending overflow names PENDING, not the inbox"
        );
    }

    /// THE OFF-BY-ONE ANCHOR: a board sitting EXACTLY AT all three bounds is ACCEPTED.
    /// This is what separates a correct `>` from a `>=`, and no rejecting test can make
    /// that separation on its own - the three rejecting tests above would all still pass
    /// against a walk that refused at the cap instead of past it, and every live board
    /// that ever filled a queue would then fail to load.
    ///
    /// Forged rather than driven, deliberately: this asserts the COMPARISON, and the
    /// live-path claim is the separate test below it.
    #[test]
    fn restore_accepts_a_board_sitting_exactly_at_every_bound() {
        use crate::admit::{FAULT_QUEUE_CAP, MECHANICAL_INBOX_CAP, SOURCE_PENDING_CAP};

        let mut core = Core::genesis(header(0x7104_0006));
        let d = core.state.add_source();
        declare_one_in_port(&mut core, d, crate::state::Medium::Mechanical);
        forge_inbox(&mut core, d, 0, MECHANICAL_INBOX_CAP);
        forge_inbox(&mut core, d, crate::fault::FAULT_PORT, FAULT_QUEUE_CAP);
        if let Some(Node::Source(source)) = core.state.node_mut(d) {
            for i in 0..SOURCE_PENDING_CAP {
                source.pending.push_back(Item(vec![(i & 0xFF) as u8]));
            }
        }
        // A Source holding a backlog re-wakes itself at `now + 1`, so a live one sits at
        // `core.tick`; with no wake the backlog would never leave and the board is refused as
        // `MachineWakeMissing` (phase 87 security audit, threat T-87-28), which is not the
        // comparison this test pins.
        core.sched.schedule_wake(d, core.tick);
        let bytes = snapshot(&core);
        let restored = restore(&bytes).expect("EXACTLY AT the bound is accepted, not refused");
        assert_eq!(
            snapshot(&restored),
            bytes,
            "and it round-trips byte-identically"
        );
    }

    /// The LIVE-PATH claim: a real board driven PAST every bound through
    /// `Core::advance` still restores, because the admission path refused rather than
    /// grew. Never forged - this is the assertion that the checks above can only ever
    /// fire on a forgery.
    ///
    /// `pending` is asserted as BOUNDED rather than as exactly AT its cap, and the
    /// reason is a measured fact rather than a hedge: a Source is STEPPED inside the
    /// same `advance` that admits the injections, and since ruling R-12 a step takes ONE
    /// item off `pending`. So a live source under continuous load rests at `cap - 1`,
    /// not at `cap`. The exact-boundary claim is the forged test above, where nothing
    /// steps.
    #[test]
    fn restore_accepts_a_live_board_driven_past_every_bound() {
        use crate::admit::{FAULT_QUEUE_CAP, MECHANICAL_INBOX_CAP, SOURCE_PENDING_CAP};
        use crate::command::{Outcome, ResultEvent};
        use crate::event::{Event, EventPayload};

        let mut core = Core::genesis(header(0x7104_0005));
        let d = core.state.add_source();
        declare_one_in_port(&mut core, d, crate::state::Medium::Mechanical);

        // Offer each queue MORE than its bound; the admission path is what stops each
        // one exactly AT it.
        let over = 8usize;
        let mut seq = 1u64;
        let mut evs: Vec<Event> = Vec::new();
        for i in 0..MECHANICAL_INBOX_CAP + over {
            evs.push(Event {
                schema_version: SCHEMA_VERSION,
                partition: 0,
                sequence: seq,
                tick: 0,
                payload: EventPayload::Input {
                    target: d,
                    port: 0,
                    item: Item(vec![(i & 0xFF) as u8]),
                },
            });
            seq += 1;
        }
        for i in 0..FAULT_QUEUE_CAP + over {
            evs.push(Event {
                schema_version: SCHEMA_VERSION,
                partition: 0,
                sequence: seq,
                tick: 0,
                payload: EventPayload::CommandResult(ResultEvent {
                    command_id: (0, d, i as u32),
                    tick: 0,
                    outcome: Outcome::Failure,
                }),
            });
            seq += 1;
        }
        for i in 0..SOURCE_PENDING_CAP + over {
            evs.push(Event {
                schema_version: SCHEMA_VERSION,
                partition: 0,
                sequence: seq,
                tick: 0,
                payload: EventPayload::ManualInject {
                    target: d,
                    port: 0,
                    item: Item(vec![(i & 0xFF) as u8]),
                },
            });
            seq += 1;
        }
        core.advance(&evs);

        // NON-VACUITY: each queue is AT its bound, so the acceptance below is a boundary
        // acceptance and not an acceptance of an empty board.
        let inbox_len = core.state.inbox_of(d).map_or(0, |i| i.len_on(0));
        let fault_len = core
            .state
            .inbox_of(d)
            .map_or(0, |i| i.len_on(crate::fault::FAULT_PORT));
        let pending_len = match core.state.node(d) {
            Some(Node::Source(s)) => s.pending.len(),
            _ => 0,
        };
        assert_eq!(inbox_len, MECHANICAL_INBOX_CAP, "the inbox stopped AT its cap");
        assert_eq!(fault_len, FAULT_QUEUE_CAP, "the fault queue stopped AT its cap");
        assert!(
            pending_len <= SOURCE_PENDING_CAP,
            "pending is bounded ({pending_len} of {SOURCE_PENDING_CAP}) even though \
             {} injections were offered",
            SOURCE_PENDING_CAP + over
        );
        assert!(
            pending_len > 0,
            "non-vacuity: pending must actually hold something, or the bound above is \
             satisfied by an empty queue"
        );

        let bytes = snapshot(&core);
        let restored = restore(&bytes).expect("a live board past every bound restores");
        assert_eq!(
            snapshot(&restored),
            bytes,
            "and it round-trips byte-identically"
        );
    }

    /// **WR-07: THE TWO BOUNDS MUST AGREE, AND THIS IS THE BOARD THAT SEPARATES THEM.**
    ///
    /// Live admission classifies by EMITTER first, so a `Node::Wire` delivers under the
    /// electrical exemption WHATEVER medium the destination port declares. The restore
    /// walk classified by DESTINATION MEDIUM only. A wire pointed at a port declared
    /// `Medium::Mechanical` therefore produced, through `Core::advance` and nothing
    /// else, a board that the engine's own loader refused with
    /// `StateInvariant::InboxTooMany` - a user jams a board, saves it, and cannot load
    /// it, on a save file the engine minted.
    ///
    /// Driven, never forged: every one of these items went through `wire::admit` and
    /// the fold's delivery. The declared-Mechanical port is asserted before the
    /// round-trip, because the whole disagreement lives in that declaration - against a
    /// port-less node this board would be covered by
    /// `restore_accepts_over_cap_inbox_on_a_port_less_node` instead and would prove
    /// nothing new.
    #[test]
    fn restore_accepts_a_live_wire_fan_in_past_the_mechanical_cap() {
        use crate::admit::MECHANICAL_INBOX_CAP;
        use crate::event::{Event, EventPayload};
        use crate::ids::PortId;

        let mut core = Core::genesis(header(0x7107_0001));
        let caller = core.state.add_source();
        let handler = core.state.add_source();
        // THE DECLARATION THAT MAKES THE TWO READINGS DISAGREE.
        declare_one_in_port(&mut core, handler, crate::state::Medium::Mechanical);
        let wire = core.state.add_wire((caller, 0), (handler, 0));
        core.state.link((wire, 0), (handler, 0));

        let over = MECHANICAL_INBOX_CAP + 8;
        let evs: Vec<Event> = (0..over)
            .map(|i| Event {
                schema_version: SCHEMA_VERSION,
                partition: 0,
                sequence: i as u64 + 1,
                tick: 0,
                payload: EventPayload::WireRequest {
                    correlation: i as u64,
                    deadline_tick: 100,
                    budget: 8,
                    return_addr: (caller, 0),
                    payload: Item(vec![(i & 0xFF) as u8]),
                },
            })
            .collect();
        core.advance(&evs);
        // One tick of maturity, then let the wire drain its whole in-flight FIFO.
        for _ in 0..8 {
            core.advance(&[]);
        }

        let landed = core
            .state
            .inbox_of(handler)
            .map_or(0, |i| i.len_on(0 as PortId));
        // NON-VACUITY: the bucket must be PAST the mechanical cap, or the acceptance
        // below is an acceptance of a board no bound was ever asked about.
        assert!(
            landed > MECHANICAL_INBOX_CAP,
            "the wire delivered {landed} items into a declared-Mechanical port, which \
             must exceed MECHANICAL_INBOX_CAP {MECHANICAL_INBOX_CAP} for this test to \
             separate the two readings"
        );
        assert!(
            core.state
                .ports_of(handler)
                .and_then(|p| p.first())
                .is_some_and(|p| matches!(p.medium, crate::state::Medium::Mechanical)),
            "non-vacuity: the destination port is DECLARED Mechanical, which is the \
             only reason the restore walk ever looked at it"
        );

        let bytes = snapshot(&core);
        let restored = restore(&bytes)
            .expect("a board the fold itself produced must reload (WR-07)");
        assert_eq!(
            snapshot(&restored),
            bytes,
            "and it round-trips byte-identically"
        );
        assert_eq!(
            restored.state.inbox_of(handler).map_or(0, |i| i.len_on(0)),
            landed,
            "with every delivered item intact"
        );
    }

    /// The exemption above is scoped to a LIVE wire terminal and nothing wider: a
    /// declared-Mechanical port with NO wire pointing at it is still bounded, so
    /// `restore_rejects_forged_over_cap_declared_mechanical_inbox` did not become
    /// vacuous. Asserted on the same shape as the accepting test with the wire's `to`
    /// aimed ELSEWHERE, so the two differ in exactly one endpoint.
    #[test]
    fn restore_still_rejects_over_cap_mechanical_when_the_wire_points_elsewhere() {
        use crate::admit::MECHANICAL_INBOX_CAP;

        let mut core = Core::genesis(header(0x7107_0002));
        let caller = core.state.add_source();
        let handler = core.state.add_source();
        let other = core.state.add_source();
        declare_one_in_port(&mut core, handler, crate::state::Medium::Mechanical);
        // The wire terminates at `other`, NOT at `handler`.
        let _wire = core.state.add_wire((caller, 0), (other, 0));
        forge_inbox(&mut core, handler, 0, MECHANICAL_INBOX_CAP + 1);

        let bytes = snapshot(&core);
        assert_eq!(
            restore(&bytes).err(),
            Some(DecodeError::InvalidState(StateInvariant::InboxTooMany)),
            "the wire exemption is per TERMINAL, not per board"
        );
    }

    #[test]
    fn snapshot_due_periodic_fires_only_at_multiples() {
        // Some(n): due exactly at multiples of n (tick 0 included).
        let n = 7u64;
        for tick in 0..30u64 {
            assert_eq!(
                snapshot_due(Some(n), tick),
                tick.is_multiple_of(n),
                "snapshot_due(Some({n}), {tick})"
            );
        }
    }

    #[test]
    fn snapshot_due_none_never_fires() {
        for tick in 0..100u64 {
            assert!(!snapshot_due(None, tick), "None cadence is on-demand only");
        }
        // The degenerate Some(0) is also never auto-due (no divide-by-zero).
        for tick in 0..10u64 {
            assert!(!snapshot_due(Some(0), tick), "Some(0) is on-demand only");
        }
    }

    #[test]
    fn snapshot_persist_if_due_writes_exactly_when_due() {
        let mut core = live_core();
        let mut store = MemStore::new();
        let every = Some(3u64);

        // Drive a handful of ticks, persisting only when due, and record which
        // ticks actually wrote a snapshot.
        let mut fired_at = Vec::new();
        for _ in 0..10 {
            let fired = persist_snapshot_if_due(&core, &mut store, every).expect("cadence write");
            if fired {
                fired_at.push(core.tick);
            }
            core.advance(&[]);
        }

        // live_core() leaves core.tick == 1, so the boundaries seen are 1..=10;
        // multiples of 3 in that range are 3, 6, 9.
        assert_eq!(fired_at, vec![3, 6, 9], "fired exactly at the due ticks");

        // None never fires; on-demand still works regardless of cadence.
        assert!(
            !persist_snapshot_if_due(&core, &mut store, None).expect("none cadence"),
            "None cadence never auto-fires"
        );
        persist_snapshot(&core, &mut store).expect("on-demand snapshot always writes");
    }

    // ── the label restore bound (Phase 76, plan 76-04, SHAPE-13, D-06) ─────────────
    //
    // A label's text is the first user-authored string on a serialized node since a
    // Route's path, so a forged snapshot can carry any length. `restore` refuses one over
    // `crate::edit::MAX_LABEL_BYTES` as `InvalidState(LabelTextTooLong)` and accepts one
    // exactly at it (the write gate's number, read not restated). The colour is a closed
    // enum: a byte past the last colour fails to decode at all.
    //
    // MEASURED BEFORE THE GUARD (recorded in 76-04-SUMMARY.md): a 513-byte label restored
    // `Ok`.

    /// A Core holding one live label (no cell, as `add_label` makes it) with `text` and
    /// `colour`.
    fn label_core(text: String, colour: crate::state::LabelColour) -> Core {
        let mut core = Core::genesis(header(0x0076_0004));
        let id = core.state.add_label();
        match core.state.node_mut(id) {
            Some(Node::Label(label)) => {
                label.text = text;
                label.colour = colour;
            }
            _ => panic!("add_label must mint a Node::Label"),
        }
        core
    }

    #[test]
    fn restore_refuses_a_label_text_one_byte_over_the_cap() {
        let forged = "a".repeat(crate::edit::MAX_LABEL_BYTES + 1);
        let verdict = restore(&snapshot(&label_core(forged, crate::state::LabelColour::Sand)));
        assert!(
            matches!(
                verdict,
                Err(DecodeError::InvalidState(StateInvariant::LabelTextTooLong))
            ),
            "a label text one byte over MAX_LABEL_BYTES must be a TYPED refusal at the trust \
             gate, never an unbounded allocation and never a panic; got {:?}",
            verdict.err()
        );
    }

    #[test]
    fn restore_accepts_a_label_text_exactly_at_the_cap() {
        let at_cap = "a".repeat(crate::edit::MAX_LABEL_BYTES);
        let core = label_core(at_cap.clone(), crate::state::LabelColour::Clay);
        let bytes = snapshot(&core);
        let restored = restore(&bytes)
            .unwrap_or_else(|e| panic!("a label text of exactly the cap restores, got {e:?}"));
        assert_eq!(snapshot(&restored), bytes, "and round-trips byte-identically");
        let text = restored.state.node_ids().find_map(|id| match restored.state.node(id) {
            Some(Node::Label(label)) => Some(label.text.clone()),
            _ => None,
        });
        assert_eq!(text, Some(at_cap), "the words survive the restore verbatim");
    }

    #[test]
    fn restore_refuses_an_unknown_label_colour_byte() {
        use crate::state::LabelColour;
        // Two VALID Cores, identical but for the label's colour: Rose (4) and Clay (5),
        // the last colour. The colour varint is the one differing byte.
        let rose = snapshot(&label_core(String::new(), LabelColour::Rose));
        let clay = snapshot(&label_core(String::new(), LabelColour::Clay));
        assert!(restore(&rose).is_ok(), "the Rose base snapshot is valid");
        assert!(restore(&clay).is_ok(), "the Clay base snapshot is valid");
        assert_eq!(rose.len(), clay.len(), "same-shape snapshots are equal length");
        let diffs: Vec<usize> = (0..rose.len()).filter(|&i| rose[i] != clay[i]).collect();
        assert_eq!(diffs.len(), 1, "the colour byte is the only differing byte");
        let at = diffs[0];
        assert_eq!((rose[at], clay[at]), (4, 5), "Rose encodes as 4, Clay as 5");
        // Byte 6 names no colour: the closed set fails to decode.
        let mut forged = clay;
        forged[at] = 6;
        assert!(
            matches!(restore(&forged), Err(DecodeError::Malformed)),
            "a label colour byte past Clay is refused as postcard Malformed"
        );
    }
}
