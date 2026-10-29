//! The event envelope — the unit the log stores and the tick loop folds.
//!
//! The event log is the source of truth (CORE-02): every non-pure input (clock,
//! randomness, external results, user input) enters the core ONLY as a logged
//! [`Event`]. Each event carries a logical [`PartitionKey`] (CORE-08, ignored in
//! single-partition mode but reserved for the forward-compatible sharded
//! design), a monotonic `sequence` (the ROUTE-06 deterministic tie-break id),
//! the `tick` it is admitted at, and a [`schema_version`](Event::schema_version)
//! (CORE-10) keyed for upcast-on-read.
//!
//! # Trust boundary (RESEARCH §Security V5)
//! Bytes decoded from disk / future save files are untrusted. [`upcast`] is the
//! single decode entry point at that boundary: it **refuses any record whose
//! `schema_version` is newer than the running [`SCHEMA_VERSION`]** with a typed
//! [`DecodeError::UnknownVersion`] (never a panic), and decodes behind a
//! `Result` so malformed bytes yield [`DecodeError::Malformed`] rather than an
//! `unwrap` panic. Allocation bounding for arbitrary on-disk blobs is enforced
//! at the persistence read boundary (plan 03 / plan 06).
//!
//! All types are plain serde data (CORE-09): no floats, no HashMaps, no pointers.

use crate::command::ResultEvent;
use crate::ids::{CommandId, Item, NodeId, PartitionKey, PortId};

/// The schema version the running code writes and can decode. [`upcast`] refuses
/// records stamped with a version greater than this (forward-version refusal).
pub const SCHEMA_VERSION: u16 = 2;

/// A logged event — the atomic unit of the source-of-truth log and the tick
/// fold. Plain serializable data (CORE-09).
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Event {
    /// Schema version for upcast-on-read (CORE-10).
    pub schema_version: u16,
    /// Logical partition key (CORE-08).
    pub partition: PartitionKey,
    /// Monotonic sequence within the partition; the ROUTE-06 tie-break id.
    pub sequence: u64,
    /// The tick this event is admitted at.
    pub tick: u64,
    /// The event payload.
    pub payload: EventPayload,
}

/// The payload variants an [`Event`] can carry. Extended in later phases; the
/// `schema_version` guards old logs against new variants.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum EventPayload {
    /// Manual "drop one item on the belt" injection (SRC-02).
    ManualInject {
        /// Target node.
        target: NodeId,
        /// Target input port.
        port: PortId,
        /// The item injected.
        item: Item,
    },
    /// An item arriving at a node's input port from a belt.
    Input {
        /// Target node.
        target: NodeId,
        /// Target input port.
        port: PortId,
        /// The item delivered.
        item: Item,
    },
    /// A dispatched command's result, re-entering the fold (Phase 5).
    CommandResult(ResultEvent),
    /// A core-synthesized command timeout (Phase 5) at the frozen discriminant 3.
    /// The Phase-7 `Place`/`Wire`/`Delete` gesture variants were removed in the
    /// Phase-8 clean break (decision Q4) — topology edits now flow through the
    /// separate, schema-versioned EDIT log
    /// ([`EditRecord`](crate::edit::EditRecord)) and its
    /// [`apply_edit`](crate::tick) fold, never the runtime event log. Removing them
    /// shifts NO surviving discriminant (`ManualInject=0 … Timeout=3` stay frozen),
    /// so non-gesture corpus logs decode byte-identically. This variant does not itself
    /// force a version bump; `SCHEMA_VERSION` is `2` after the coordinated v6.0 re-bless
    /// (35-03), which is byte-forced by the unrelated `Port.medium` change.
    Timeout {
        /// The command that timed out.
        command_id: CommandId,
    },
    /// An inbound request/response WIRE request (WR-01, Phase 37) — a correlated
    /// external request that enters the fold and awaits a matching
    /// [`Effect::Reply`](crate::command::Effect::Reply) before its `deadline_tick`.
    /// **Appended LAST** at discriminant 4 (byte-additive: `ManualInject=0 …
    /// Timeout=3` stay frozen, so the golden event-log corpus decodes byte-identically
    /// and zero corpus instances land here). This variant does not itself force a bump;
    /// `SCHEMA_VERSION` is `2` after the coordinated v6.0 re-bless (35-03). Carries ONLY
    /// scalars — the request body appends append-LAST in Phase 37, keeping this a
    /// zero-cap surface now (no `Vec`, so no new decode allocation bound). ADMITTED
    /// since Phase 37: `manual_inject::admit` pushes a logged request into its entry
    /// wire's in-flight FIFO.
    WireRequest {
        /// The correlation id a later [`Effect::Reply`](crate::command::Effect::Reply)
        /// matches to resolve this request.
        correlation: u64,
        /// The logical tick by which a reply must arrive (deterministic deadline —
        /// logged data, never a wall-clock read). This is ALSO the Phase-38 reply
        /// deadline, so no further deadline field is ever appended.
        deadline_tick: u64,
        /// The per-request hop/depth budget (the DEPTH bound; default
        /// [`crate::wire::DEFAULT_WIRE_BUDGET`]). A
        /// [`FaultReason::WireOverflow`](crate::fault::FaultReason::WireOverflow) trips
        /// when it is exhausted (Phase 37).
        budget: u64,
        /// The logical reply address the response routes back to — a `(node, port)`
        /// handle, never a raw pointer (API-03), Hewitt's "customer"/continuation.
        /// **Appended LAST** (after `budget`, byte-additive) so the frozen golden
        /// event-log corpus decodes byte-identically (zero corpus instances land here).
        return_addr: (NodeId, PortId),
        /// The opaque request body bytes. **Appended LAST** (after `return_addr`) —
        /// this is the FINAL Phase-37+38 shape, so the request carries its full body
        /// with no further serialized growth. Carried through the wire transport since
        /// Phase 37.
        payload: Item,
    },
}

/// The genesis header record (first log entry): carries the RNG seed (CORE-05)
/// so a replay from genesis reconstructs the identical random stream.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct LogHeader {
    /// Schema version of the log.
    pub schema_version: u16,
    /// Genesis RNG seed (fed to [`crate::rng::SimRng::from_seed_u64`]).
    pub seed: u64,
}

/// A violated grid/scheduler **class invariant** detected on an already-decoded
/// `Core` at the snapshot trust gate (`crate::snapshot::validate_invariants`).
///
/// Each variant names a structurally-valid-but-corrupt decoded state that would
/// otherwise drive `tick::step_node` / output routing / the scheduler into a
/// panic (RESEARCH A1, threat T-06-01-DOS). The check is REJECT-ONLY: the
/// decoded bytes are never mutated/normalized — a violation is reported, not
/// repaired. `Copy` so [`DecodeError`] keeps its `Copy` derive (no `String`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StateInvariant {
    /// A `Node::Balancer` with `outputs > 0` whose round-robin pointer
    /// `next >= outputs` — the out-of-range operator pointer the blocker rejects
    /// (the zero-arity `outputs == 0` drain-and-stop state is legitimate).
    BalancerPointer,
    /// A `Node::Merge` with `inputs > 0` whose round-robin start pointer
    /// `next >= inputs` — the out-of-range operator pointer the blocker rejects
    /// (the zero-arity `inputs == 0` no-op state is legitimate).
    MergePointer,
    /// A node present in the node store but with no provisioned inbox — `step_node`
    /// would `inbox_mut(id).expect(..)`-panic on this live-but-inbox-less node.
    MissingInbox,
    /// A link whose **target** `(to_node, _)` is not a live node — output routing
    /// would `inbox_mut(dest)`-panic delivering to this dangling wire target.
    DanglingLink,
    /// A scheduler-referenced node id (in `active_now` or any `wake_wheel` bucket)
    /// that is not a live node — `step_node` would `node_mut(id).expect(..)`-panic
    /// stepping this dangling active id.
    DanglingSchedule,
    /// A belt with an `in_flight` arrival tick that is NOT present in the scheduler
    /// `wake_wheel` (or is already past-due relative to `core.tick`) — the silent
    /// item-strand divergence (AR-3). A belt schedules its own delivery wake at
    /// `arrival = now + latency` (`belt.rs::step`); if a forged snapshot carries the
    /// in-flight item but drops that wheel entry, the belt is never re-stepped, the
    /// item never re-delivers, and the replay hash drifts with no panic. **Appended
    /// LAST** so no existing discriminant shifts (keeps `DecodeError` `Copy`).
    BeltWakeMissing,
    /// A `cells` entry keyed by a `NodeId` that is NOT a live node (WR-09-02) — a
    /// forged v4 snapshot mapping a dead id to a cell. `rebuild_occupancy` would
    /// index it into `occupancy`, so `occupied(cell)` would resolve a dangling id.
    /// Mirrors [`DanglingLink`](Self::DanglingLink)/[`DanglingSchedule`](Self::DanglingSchedule).
    /// **Appended LAST** so no existing discriminant shifts (keeps `StateInvariant`/
    /// `DecodeError` `Copy`).
    DanglingCell,
    /// Two live `cells` entries mapped to the SAME grid cell (WR-09-02) — a forged
    /// v4 snapshot placing two nodes on one cell. `set_cell` keeps `cells` injective
    /// on positions; a colliding `cells` map collapses the derived `occupancy`
    /// reverse index so it is no longer a faithful bijection of `cells`. **Appended
    /// LAST** after `DanglingCell`. As of FOOT-01 (10-03) the collision is detected
    /// over EXPANDED footprint BODY cells, so two distinct-anchor but body-overlapping
    /// footprints trip this too (`cells_of_footprint` expansion).
    CellCollision,
    /// A `footprints` OR `ports` entry keyed by a `NodeId` that is NOT a live node
    /// (FOOT-01, V5) — a forged v5 snapshot carrying a footprint/port map for a dead
    /// id. Mirrors [`DanglingCell`](Self::DanglingCell)/[`DanglingLink`](Self::DanglingLink):
    /// the multi-cell rebuild/dock paths would otherwise consume a dangling id.
    /// **Appended LAST** after `CellCollision` so no existing discriminant shifts
    /// (keeps `StateInvariant`/`DecodeError` `Copy`).
    DanglingFootprint,
    /// A `Port.local_offset` that lies OUTSIDE the `[0,w)×[0,h)` rot-0 box of its
    /// node's footprint (FOOT-01, V5) — a forged v5 snapshot with an out-of-footprint
    /// port the dock math (`port_world`) would otherwise place off-body. Reject-only,
    /// small-dim integer bounds (no overflow/panic). **Appended LAST** after
    /// `DanglingFootprint`.
    PortOutOfFootprint,
    /// A `Footprint` whose `w` or `h` falls OUTSIDE `1..=MAX_FOOTPRINT_DIM`
    /// (`crate::state::MAX_FOOTPRINT_DIM`) — a forged v5 snapshot carrying an
    /// attacker-controlled dimension (CR-01). `w`/`h` are `u16`, so a forged
    /// `w = h = u16::MAX` would expand through `cells_of_footprint` to ~4.3 billion
    /// occupancy cells — a tiny-input/multi-GiB-allocation amplification bomb that
    /// `rebuild_occupancy`/the trust gate would otherwise OOM/abort on. The bound is
    /// the documented overflow-safety envelope `cells_of_footprint`/`port_world` rely
    /// on; checking it BEFORE expansion turns the DoS into a typed rejection. A `w`
    /// OR `h` of `0` (a degenerate placed-but-unoccupied node) trips this too.
    /// **Appended LAST** after `PortOutOfFootprint` so no existing discriminant
    /// shifts (keeps `StateInvariant`/`DecodeError` `Copy`).
    FootprintTooLarge,
    /// A `cells` anchor `(x, y)` outside the verified grid extent
    /// `[GRID_MIN, GRID_MAX]` (`crate::state::GRID_MIN`/`GRID_MAX`) on either axis
    /// (CR-02) — a forged snapshot with an attacker-controlled anchor. `cells` is
    /// decoded from untrusted bytes, so an anchor at `i32::MAX` paired with any
    /// multi-cell footprint would compute `anchor + (dim-1)` in `cells_of_footprint`
    /// and overflow `i32` — a debug-build panic / release-build wrap on the untrusted
    /// `rebuild_occupancy` path (which runs ahead of the gate), violating restore's
    /// reject-only-no-panic guarantee. Bounding the anchor to the documented extent
    /// (paired with the [`FootprintTooLarge`](Self::FootprintTooLarge) dim cap) makes
    /// `anchor + (dim-1)` provably overflow-free. **Appended LAST** after
    /// `FootprintTooLarge` so no existing discriminant shifts (keeps `Copy`).
    CellOutOfBounds,
    /// A `Footprint.rot` outside the documented `0..=3` quarter-turn range (WR-02) — a
    /// forged v5 snapshot. Every live consumer masks (`rot & 3` / `rot & 1`) so an
    /// unmasked value is currently HARMLESS to the math, but the `Footprint` contract
    /// asserts `rot ∈ {0,1,2,3}`, and the reject-only gate must not hand back a
    /// validated `Core` carrying an out-of-contract `rot` a future consumer could read
    /// unmasked. A live grid only ever stores a masked `rot`, so a valid snapshot is
    /// untouched. **Appended LAST** after `CellOutOfBounds` so no existing discriminant
    /// shifts (keeps `StateInvariant`/`DecodeError` `Copy`).
    FootprintBadRot,
    /// A `Node::Belt` whose `slots.len()` does NOT equal `SLOTS_PER_TILE * tiles`
    /// (Phase 11, BELT-05) — a forged snapshot desyncing the per-tile slot vector
    /// from the tile count. The slot model couples capacity to length, so a
    /// mismatched vector breaks the advance/admit invariants; the trust gate rejects
    /// it reject-only (no panic). **Appended LAST** after `FootprintBadRot` so no
    /// existing discriminant shifts (keeps `StateInvariant`/`DecodeError` `Copy`).
    ///
    /// The invariant is expressed SYMBOLICALLY, so it re-derived with no code change
    /// when `SLOTS_PER_TILE` moved from three to four in Phase 60 (`60-CONTEXT.md`,
    /// 2026-08-09). Only this prose moved, and the discriminant did not: the
    /// append-last discipline noted above still holds unchanged. What DID change is
    /// who is expected to hit this arm. A save written before Phase 60 carries a
    /// `3N` slot vector and would fail HERE, which reads to a user like file
    /// corruption; that is why `SNAPSHOT_SCHEMA_VERSION` and `PROJECT_FILE_VERSION`
    /// were bumped in lockstep in the same commit, so such a save is refused on the
    /// VERSION first (D-02, the clean break) and never reaches this invariant.
    /// Reaching this arm now means a genuinely forged or damaged snapshot, which is
    /// what it was always for.
    BeltSlotCount,
    /// A `Node::Belt` whose drawn `geometry` carries MORE than `MAX_BELT_TILES`
    /// tiles (`crate::edit::MAX_BELT_TILES`) (Phase 11, RESEARCH Pitfall 3) — a
    /// forged snapshot allocation bomb. `rebuild_occupancy` expands every belt tile
    /// cell into the `occupancy` index BEFORE the trust gate, so an unbounded belt
    /// geometry would drive an unbounded allocation; the pre-rebuild cap (mirror
    /// [`FootprintTooLarge`](Self::FootprintTooLarge)) turns that DoS into a typed
    /// rejection. **Appended LAST** after `BeltSlotCount`.
    BeltTilesTooMany,
    /// A `Node::Wire` (`crate::state::WireLink`) whose `in_flight` FIFO holds MORE
    /// than [`crate::wire::WIRE_INFLIGHT_CAP`] messages (Phase 37, WIRE-03) — a forged
    /// snapshot fan-out bomb. The live [`crate::wire::admit`] REFUSES admission at the
    /// cap (never grows past it), so an over-cap FIFO is unreachable from a live grid;
    /// only a hand-forged save-file can carry one. It is bounded in the pre-rebuild
    /// phase (mirror [`BeltTilesTooMany`](Self::BeltTilesTooMany)) so an
    /// attacker-controlled in-flight length can never drive an unbounded allocation as
    /// the fold's admit/deliver paths walk it. Reject-only (no panic/OOM). **Appended
    /// LAST** after `BeltTilesTooMany` so no existing discriminant shifts (keeps
    /// `StateInvariant`/`DecodeError` `Copy`).
    WireInFlightTooMany,
    /// A `Node::Wire` (`crate::state::WireLink`) whose `from`/`to` endpoint OR any
    /// in-flight message's `return_addr` names a `NodeId` that is NOT a live node
    /// (Phase 37, WIRE-03) — a forged dangling wire address. These are the exact
    /// `(node, port)` handles the fold's admit/deliver/reply paths dereference
    /// (`node_mut`/`inbox_mut`), so a dangling one would otherwise panic. Mirrors
    /// [`DanglingLink`](Self::DanglingLink)/[`DanglingSchedule`](Self::DanglingSchedule):
    /// the trust gate rejects it reject-only before the fold touches it. **Appended
    /// LAST** after `WireInFlightTooMany` so no existing discriminant shifts (keeps
    /// `StateInvariant`/`DecodeError` `Copy`).
    DanglingWireEndpoint,
    /// A `Node::Wire` (`crate::state::WireLink`) holding a NON-EMPTY `in_flight` FIFO
    /// but with NO scheduler wake at `core.tick` (Phase 37, WR-01) — the wire analog of
    /// [`BeltWakeMissing`](Self::BeltWakeMissing). `step_wire` self-re-wakes an occupied
    /// wire at `now + 1` (`tick.rs` SELF-REWAKE), so at a clean snapshot boundary a wire
    /// carrying in-flight messages is ALWAYS wheel-held at exactly `core.tick`
    /// (`take_due(core.tick)` has NOT run yet). A forged save that keeps the in-flight
    /// messages but drops that wheel entry would SILENTLY strand them — the wire never
    /// re-enters the active set, `step_wire` never runs, and the messages never
    /// mature/forward while the replay hash drifts, with no panic. This turns that
    /// silent-strand into a typed rejection, closing the belt/wire trust-gate asymmetry
    /// (reject-only, no mutation). **Appended LAST** after `DanglingWireEndpoint` so no
    /// existing discriminant shifts (keeps `StateInvariant`/`DecodeError` `Copy`).
    WireWakeMissing,
    /// A node whose inbox holds MORE items on ONE port than that port's governing
    /// admission bound (Phase 71, PILE-09) - a forged snapshot queue bomb, the
    /// `PortInbox` analog of [`WireInFlightTooMany`](Self::WireInFlightTooMany). Two
    /// bounds are checked and they are the only two whose class a snapshot can name
    /// with no ambiguity: the reserved `FAULT_PORT` bucket against
    /// [`crate::admit::FAULT_QUEUE_CAP`], and a port DECLARED
    /// [`Medium::Mechanical`](crate::state::Medium) against
    /// [`crate::admit::MECHANICAL_INBOX_CAP`].
    ///
    /// **What an occurrence MEANS.** The live [`crate::admit::try_admit`] REFUSES at
    /// both caps and never grows a bucket past one, so an over-cap inbox is unreachable
    /// from any live grid: only a hand-forged save file can carry one. The check runs in
    /// the pre-`rebuild_occupancy` phase so an attacker-controlled queue length becomes
    /// a typed rejection rather than an unbounded walk (the
    /// [`WireInFlightTooMany`](Self::WireInFlightTooMany) precedent).
    ///
    /// **An UNDECLARED port is deliberately NOT bounded here, and that is a design
    /// clause rather than an omission** - see `snapshot::validate_footprint_bounds` for
    /// the reason in full. **Appended LAST** after `WireWakeMissing` so no existing
    /// discriminant shifts (keeps `StateInvariant`/`DecodeError` `Copy`).
    InboxTooMany,
    /// A `Node::Source` ([`crate::state::ManualInject`]) whose serialized `pending`
    /// deque holds MORE than [`crate::admit::SOURCE_PENDING_CAP`] items (Phase 71,
    /// PILE-04) - a forged snapshot queue bomb at the TOP of the chain.
    ///
    /// **What an occurrence MEANS.** [`crate::manual_inject::admit`] refuses a
    /// `ManualInject` past the cap and never enqueues past it, so an over-cap `pending`
    /// is unreachable from a live grid and only a forged save can carry one.
    ///
    /// **It is its OWN variant rather than sharing
    /// [`InboxTooMany`](Self::InboxTooMany)** because a shared variant would report a
    /// PENDING overflow as an INBOX overflow, and the message would then be false about
    /// which queue the forgery targeted. `pending` is a `VecDeque` inside `Node::Source`
    /// and an inbox bucket is a `PortInbox` entry; they are different queues on
    /// different sides of the admission boundary. **Appended LAST** after `InboxTooMany`
    /// so no existing discriminant shifts (keeps `StateInvariant`/`DecodeError` `Copy`).
    SourcePendingTooMany,
    /// A [`Node::Endpoint`](crate::state::Node::Endpoint) whose serialized `path` is
    /// LONGER than [`crate::edit::MAX_ENDPOINT_PATH_BYTES`] (Phase 72, SERVE-08, threat
    /// T-72-07-01) - a forged snapshot allocation bomb on a brand-new surface.
    ///
    /// **Why it is a NEW member of a list that was thought closed.**
    /// `snapshot::restore`'s own docblock enumerates every attacker-controlled LENGTH
    /// the rebuild or the fold would otherwise walk: footprint dimensions, grid anchors,
    /// belt geometry, the wire `in_flight` FIFO, and since Phase 71 the inbox buckets
    /// and a source's `pending` deque. A `String` ON A SERIALIZED NODE joins that list
    /// the moment one exists, and before 72-07 none did. Without this arm a forged
    /// `.fab` allocates a multi-gigabyte path on LOAD, before any fold runs.
    ///
    /// **The bound is the SAME NUMBER the write gate reads**, not a second literal.
    /// Phase 71's ruling (`snapshot.rs:443-453`) is cited rather than re-taken: the
    /// restore bound must ACCEPT WHAT THE LIVE PATH CAN PRODUCE, because a restore bound
    /// tighter than the writer turns a board the command layer accepted into a save the
    /// user cannot open. The accepting boundary case has its own test
    /// (`route_path::a_path_at_the_bound_restores_fine`) so a later "tightening"
    /// reddens rather than silently refusing a legitimate board.
    ///
    /// **LENGTH only, never the character rule.** The unreserved-byte rule is a
    /// write-side policy (`crate::edit::endpoint_path_is_valid`); enforcing it here
    /// would make a later widening of the allowed alphabet retroactively unload already
    /// saved boards. Reject-only like every other arm: the decoded bytes are never
    /// mutated. **Appended LAST** after `SourcePendingTooMany` so no existing
    /// discriminant shifts (keeps `StateInvariant`/`DecodeError` `Copy`).
    EndpointPathTooLong,
    /// A [`Node::Label`](crate::state::Node::Label) whose serialized `text` is LONGER than
    /// [`crate::edit::MAX_LABEL_BYTES`] (Phase 76, plan 76-04, SHAPE-13, D-06, threat
    /// T-76-12) - a forged snapshot allocation bomb on the second user-authored string a
    /// serialized node carries, after a Route's path.
    ///
    /// **The bound is the SAME NUMBER the write gate reads**, for the reason
    /// [`EndpointPathTooLong`](Self::EndpointPathTooLong) gives: the restore bound must
    /// ACCEPT WHAT THE LIVE PATH CAN PRODUCE, so a label of exactly the cap restores
    /// (`snapshot::tests::restore_accepts_a_label_text_exactly_at_the_cap`). LENGTH only;
    /// the label's size is already bounded by
    /// [`FootprintTooLarge`](Self::FootprintTooLarge) and its colour is a closed enum that
    /// fails to decode past the last colour. Reject-only like every other arm.
    /// **Appended LAST** after `EndpointPathTooLong` so no existing discriminant shifts
    /// (keeps `StateInvariant`/`DecodeError` `Copy`).
    LabelTextTooLong,
    /// A [`Node::Label`](crate::state::Node::Label) that holds a `ports` entry with any
    /// port in it, is named by a `links` entry at either end, or is an end of a
    /// `Node::Wire` (plan 86-07, D-08, WORK-09, threat T-86-20) - a forged snapshot that
    /// joins a note to the flow.
    ///
    /// **What an occurrence MEANS.** A label is a note and never connects: every gesture
    /// that would give one a port, dock a belt to one or draw a cable to or from one is
    /// refused (`LabelDoesNotConnect`), and the three connect folds change nothing when a
    /// forged record names one. So no live grid holds a connected label, and only a
    /// hand-edited or damaged save can. Without this a forged link would jam a belt on a
    /// connection nobody can see or remove. Reject-only; the load path names it in words.
    /// **Appended LAST** after `LabelTextTooLong` so no existing discriminant shifts (keeps
    /// `StateInvariant`/`DecodeError` `Copy`).
    LabelConnected,
    /// A `Node::Balancer` whose INPUT pointer `next_in` is outside the catalog In ports,
    /// `next_in >= DEFAULT_ARITY` (phase 87, JAM-01, D-02, threat T-87-05). The scan
    /// widens to u32 before its modulo, so an out-of-range pointer could not panic the
    /// fold, but no live grid holds one: `Balancer::new` sets 0 and every pass leaves it
    /// `< DEFAULT_ARITY`. Only a hand-edited or damaged save can, and it is refused here
    /// as the sibling of [`BalancerPointer`](Self::BalancerPointer). Reject-only.
    /// **Appended LAST** after `LabelConnected` so no existing discriminant shifts (keeps
    /// `StateInvariant`/`DecodeError` `Copy`).
    BalancerInputPointer,
    /// A `Node::Factory` whose `pending_emits` queue (phase 87, JAM-05, D-07, threat
    /// T-87-06) holds a [`FAULT_PORT`](crate::fault::FAULT_PORT) key, a key on a port with
    /// no link from that Factory, an EMPTY per-port queue, or a queue of
    /// [`FACTORY_EMITS_PER_PORT`](crate::factory::FACTORY_EMITS_PER_PORT) items or more.
    ///
    /// **What an occurrence MEANS.** The queue holds the emits of one run beyond the first
    /// per port, waiting for the belt on that port: a run never queues on the fault port
    /// (a fault leaves through the drain), never queues on a port nothing is docked to, a
    /// drained queue is removed rather than left empty, and the first emit of each run
    /// leaves at once, so a live queue stays under the cap. Only a hand-edited or damaged
    /// save can hold any of the four, and an oversized one would cost unbounded memory and
    /// drain work. One variant for the four, because each is the same queue lying about
    /// what one run could have left. Reject-only. **Appended LAST** after
    /// `BalancerInputPointer` so no existing discriminant shifts.
    FactoryPendingEmits,
    /// A member of the scheduler's sleep set `Scheduler::blocked` that is not a belt and
    /// whose gate would let it step (`tick::node_gated` is false), phase 87, JAM-04, D-06,
    /// threat T-87-17.
    ///
    /// **What an occurrence MEANS.** A machine enters the set only when the gate holds it
    /// back, and leaves it the moment anything can lift the block: the consumer that frees
    /// its slot, a delivery or an edit takes it out. So at a tick boundary every sleeper is
    /// still gated. A sleeper that could move would never be stepped again, because the
    /// wakes that reach a sleeper all assume it is blocked; only a hand-edited or damaged
    /// save can hold one, and it would silently stop a user's automation. Reject-only.
    /// **Appended LAST** after `FactoryPendingEmits` so no existing discriminant shifts.
    BlockedNotGated,
    /// A BELT in the scheduler's sleep set `Scheduler::blocked` that is not settled
    /// (`tick::belt_settled` is false), phase 87, JAM-04, D-06, threat T-87-19.
    ///
    /// **What an occurrence MEANS.** A belt sleeps only once it cannot do anything: its head
    /// is held (no head link, or its destination cannot take one more), its items are packed
    /// from the head with no gap, and its tail can admit nothing. Anything that changes one
    /// of those wakes it and takes it out of the set: a delivery into it, the consumer that
    /// frees its head's destination, a downstream belt whose tail slot comes free, or an
    /// edit. So at a tick boundary every sleeping belt is settled. A sleeping belt that could
    /// still advance, deliver or admit would freeze its items where they stand with nothing
    /// left to wake it; only a hand-edited or damaged save can hold one. Reject-only.
    /// **Appended LAST** after `BlockedNotGated` so no existing discriminant shifts.
    BlockedBeltNotSettled,
    /// A machine that holds work its own step takes, neither scheduled at `core.tick` (nor
    /// already in the current tick's active set) nor asleep in `Scheduler::blocked`: a
    /// `Node::Source` with a queued backlog, a `Node::Factory` with waiting emits, or an
    /// item on an In the machine's step reads (`tick::holds_work_its_step_takes`). Phase 87
    /// security audit, threat T-87-28: the machine twin of `BeltWakeMissing` and
    /// `WireWakeMissing`.
    ///
    /// **What an occurrence MEANS.** Every machine's step re-wakes itself at `now + 1` while
    /// it still holds such work, and a gated machine sleeps in the set instead, so at a tick
    /// boundary every machine holding work is scheduled at `core.tick` or asleep. One that is
    /// neither would never step again: no tick, no edit and no Configure wakes it (an edit
    /// tick wakes only the sleep set), and since phase 87 the feeder behind it falls asleep
    /// for good too. Only a hand-edited or damaged save can hold one. Reject-only.
    /// **Appended LAST** after `BlockedBeltNotSettled` so no existing discriminant shifts.
    MachineWakeMissing,
}

/// Typed decode failures at the untrusted-bytes boundary — never a panic.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DecodeError {
    /// The record's `schema_version` is newer than the running code can read
    /// (forward-version refusal — V5 integrity control).
    UnknownVersion(u16),
    /// The bytes did not postcard-decode into an [`Event`].
    Malformed,
    /// The bytes decoded into a structurally-valid `Core` that violates a grid/
    /// scheduler class invariant (`crate::snapshot::validate_invariants`). The
    /// post-decode trust gate rejects it instead of letting a corrupt-but-valid
    /// save file DoS the deterministic core (threat T-06-01-DOS). Append-only:
    /// added AFTER `Malformed` so no existing discriminant shifts.
    InvalidState(StateInvariant),
    /// The record's `schema_version` is OLDER than the running code supports — a
    /// clean-break refusal (no migration shim exists for the older shape).
    /// Symmetric with [`UnknownVersion`](DecodeError::UnknownVersion); both `Copy`.
    /// Consumed by the snapshot restore path's too-old arm (09-02). **Appended
    /// LAST** so no existing discriminant shifts.
    SnapshotTooOld(u16),
}

/// Decode an [`Event`] from untrusted bytes, keyed off its declared `version`.
///
/// Refuses any `version` greater than [`SCHEMA_VERSION`] with
/// [`DecodeError::UnknownVersion`] *before* touching the bytes, and returns
/// [`DecodeError::Malformed`] (never panics) if the bytes fail to decode.
///
/// Older versions are accepted here and would be migrated forward as upcast
/// rules accrue in later phases (Phase 1 has a single version, so there is no
/// migration to apply yet).
pub fn upcast(bytes: &[u8], version: u16) -> Result<Event, DecodeError> {
    if version > SCHEMA_VERSION {
        return Err(DecodeError::UnknownVersion(version));
    }
    postcard::from_bytes::<Event>(bytes).map_err(|_| DecodeError::Malformed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use slotmap::SlotMap;

    fn sample_event() -> Event {
        let mut alloc: SlotMap<NodeId, ()> = SlotMap::with_key();
        let target = alloc.insert(());
        Event {
            schema_version: SCHEMA_VERSION,
            partition: 0,
            sequence: 1,
            tick: 3,
            payload: EventPayload::ManualInject {
                target,
                port: 0,
                item: Item(vec![9, 8, 7]),
            },
        }
    }

    #[test]
    fn event_round_trips_byte_identical() {
        let ev = sample_event();
        let bytes = postcard::to_allocvec(&ev).expect("serialize event");
        let restored: Event = postcard::from_bytes(&bytes).expect("deserialize event");
        assert_eq!(ev, restored);
        // Re-encode is byte-identical.
        let bytes2 = postcard::to_allocvec(&restored).expect("re-serialize event");
        assert_eq!(bytes, bytes2);
    }

    #[test]
    fn event_log_header_round_trips_with_seed() {
        let header = LogHeader {
            schema_version: SCHEMA_VERSION,
            seed: 0xDEAD_BEEF,
        };
        let bytes = postcard::to_allocvec(&header).expect("serialize header");
        let restored: LogHeader = postcard::from_bytes(&bytes).expect("deserialize header");
        assert_eq!(header, restored);
        assert_eq!(restored.seed, 0xDEAD_BEEF);
    }

    #[test]
    fn event_upcast_accepts_current_version() {
        let ev = sample_event();
        let bytes = postcard::to_allocvec(&ev).expect("serialize event");
        let decoded = upcast(&bytes, SCHEMA_VERSION).expect("current version decodes");
        assert_eq!(decoded, ev);
    }

    #[test]
    fn event_upcast_refuses_forward_version_without_panic() {
        let ev = sample_event();
        let bytes = postcard::to_allocvec(&ev).expect("serialize event");
        // A version newer than the running code is refused with a typed error.
        let result = upcast(&bytes, SCHEMA_VERSION + 1);
        assert_eq!(result, Err(DecodeError::UnknownVersion(SCHEMA_VERSION + 1)));
    }

    #[test]
    fn event_upcast_malformed_bytes_return_typed_error() {
        // Garbage bytes at the current version yield Malformed, never a panic.
        let garbage = [0xFFu8; 4];
        let result = upcast(&garbage, SCHEMA_VERSION);
        assert!(matches!(result, Err(DecodeError::Malformed)));
    }

    #[test]
    fn surviving_variants_keep_frozen_discriminants_and_timeout_is_last() {
        // postcard encodes the leading enum discriminant as a varint. After the
        // Phase-8 clean break (decision Q4) the gesture variants are GONE; the four
        // runtime payloads keep their frozen leading discriminants (ManualInject=0,
        // Input=1, CommandResult=2, Timeout=3). The 35-02 `WireRequest` is appended
        // LAST at discriminant 4 (byte-additive), so none of the frozen discriminants
        // shift, the golden corpus stays byte-identical, and SCHEMA_VERSION stays 1.
        let mut alloc: SlotMap<NodeId, ()> = SlotMap::with_key();
        let n = alloc.insert(());

        let manual = EventPayload::ManualInject {
            target: n,
            port: 0,
            item: Item(vec![1]),
        };
        assert_eq!(
            postcard::to_allocvec(&manual).expect("encode ManualInject").first(),
            Some(&0u8),
            "ManualInject discriminant 0 frozen"
        );
        let input = EventPayload::Input {
            target: n,
            port: 0,
            item: Item(vec![1]),
        };
        assert_eq!(
            postcard::to_allocvec(&input).expect("encode Input").first(),
            Some(&1u8),
            "Input discriminant 1 frozen"
        );
        // CommandResult (discriminant 2) carries a ResultEvent; assert only its
        // leading discriminant byte.
        let command_id = (0u64, n, 0u32);
        let command_result = EventPayload::CommandResult(ResultEvent {
            command_id,
            tick: 0,
            outcome: crate::command::Outcome::Success,
        });
        assert_eq!(
            postcard::to_allocvec(&command_result)
                .expect("encode CommandResult")
                .first(),
            Some(&2u8),
            "CommandResult discriminant 2 frozen"
        );
        // Timeout stays at the frozen discriminant 3.
        let timeout = EventPayload::Timeout { command_id };
        assert_eq!(
            postcard::to_allocvec(&timeout).expect("encode Timeout").first(),
            Some(&3u8),
            "Timeout stays at the frozen discriminant 3"
        );
        // WireRequest (35-02) is the LAST variant, appended byte-additive at 4.
        let wire_request = EventPayload::WireRequest {
            correlation: 7,
            deadline_tick: 99,
            budget: 3,
            return_addr: (NodeId::default(), 0),
            payload: Item(vec![0x01, 0x02]),
        };
        assert_eq!(
            postcard::to_allocvec(&wire_request)
                .expect("encode WireRequest")
                .first(),
            Some(&4u8),
            "WireRequest is the last variant, appended at discriminant 4"
        );
        // And it serde-round-trips (encode -> decode == identity).
        let bytes = postcard::to_allocvec(&wire_request).expect("encode WireRequest");
        let decoded: EventPayload = postcard::from_bytes(&bytes).expect("decode WireRequest");
        assert_eq!(decoded, wire_request, "WireRequest serde-round-trips");
    }

    #[test]
    fn schema_version_is_two_after_v6_rebless() {
        // v6.0 re-bless (35-03): the event SCHEMA_VERSION is bumped 1->2 in lockstep
        // with the byte-forced SNAPSHOT 7->8 (Port.medium) and the EDIT/PROJECT/cmd
        // bumps — the coordinated one-quarantined re-bless spends the corpus blast
        // radius exactly once for all of v6.0. The constant is the public contract the
        // corpus depends on; a forward (`> 2`) record is refused as UnknownVersion.
        assert_eq!(SCHEMA_VERSION, 2, "v6.0 re-bless bumps the event schema version to 2");
    }
}
