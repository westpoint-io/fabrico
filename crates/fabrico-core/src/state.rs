//! Deterministic grid state: the node store, port buffers, and logical wiring.
//!
//! Everything here is **plain serde data** (CORE-09) — accessors only, no
//! authority and no behavior. The machine behavior (belt advance, manual-inject
//! fire) is added as `Machine` impls in plan 05; this module only holds the
//! state those impls mutate.
//!
//! # Ordering discipline (CORE-06, RESEARCH Pitfall 3/4)
//! The authoritative ordered store of nodes is `BTreeMap<NodeId, Node>`. A
//! `SlotMap<NodeId, ()>` is used ONLY to mint generational ids + O(1) liveness;
//! it is **never iterated** for order-observed logic. Inboxes, links, and the
//! per-port queues are all `BTreeMap`/`VecDeque` so every iteration is in a
//! deterministic, serializable order.
//!
//! # ROUTE-06 deterministic port resolution
//! When a node has items waiting on several input ports, [`PortInbox::ports_sorted`]
//! hands them out in ascending `PortId` order (lowest port = "left" priority);
//! within a port, items come out FIFO carrying their originating `event_seq`,
//! which is the cross-port tie-break — never wall-clock arrival order.

use crate::command::Effect;
use crate::ids::{Item, NodeId, PortId};
use crate::rng::SimRng;
use slotmap::Key;
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::num::NonZeroU32;

/// The canonical JSON bytes of an empty `ctx.state` — a fresh factory starts with
/// an empty object. This is the SOLE cross-tick / snapshotted factory state.
const EMPTY_STATE_JSON: &[u8] = b"{}";

/// Per-node **input** buffer: one FIFO queue per input port.
///
/// Each queued item carries its originating `event_seq` (the monotonic log
/// sequence) so that cross-port resolution can tie-break deterministically by
/// `(port_index asc, event_seq asc)` — the ROUTE-06 rule over logged data.
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct PortInbox(BTreeMap<PortId, VecDeque<(u64, Item)>>);

impl PortInbox {
    /// An empty inbox.
    pub fn new() -> Self {
        Self::default()
    }

    /// Enqueue `item` (originating from log `seq`) on `port`, FIFO.
    pub fn push(&mut self, port: PortId, seq: u64, item: Item) {
        self.0.entry(port).or_default().push_back((seq, item));
    }

    /// Pop the front item of `port` (FIFO), returning `(event_seq, item)`.
    /// Empties the port bucket lazily when it drains.
    pub fn take(&mut self, port: PortId) -> Option<(u64, Item)> {
        let q = self.0.get_mut(&port)?;
        let front = q.pop_front();
        if q.is_empty() {
            self.0.remove(&port);
        }
        front
    }

    /// The input ports that currently hold at least one item, in ascending
    /// `PortId` order (ROUTE-06 lowest-port "left" priority). `BTreeMap` keys
    /// already iterate ascending, so this is the deterministic resolution order.
    pub fn ports_sorted(&self) -> impl Iterator<Item = PortId> + '_ {
        self.0.keys().copied()
    }

    /// True when no port holds any item.
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// True when `port` currently holds at least one item. A read-only,
    /// port-scoped variant of [`is_empty`](Self::is_empty) so operators can ask
    /// "is there in-range work left?" without scanning the whole inbox — used by
    /// the merge re-wake gate to ignore items stranded on out-of-range ports
    /// (WR-01).
    pub fn has_on(&self, port: PortId) -> bool {
        self.0.get(&port).is_some_and(|q| !q.is_empty())
    }

    /// How many items `port` currently holds. A read-only, port-scoped variant of
    /// [`has_on`](Self::has_on) - the same shape and the same reason, one step
    /// further: the mechanical admission bound
    /// ([`crate::admit::MECHANICAL_INBOX_CAP`]) needs a LENGTH, not just a
    /// non-emptiness, and `PortInbox` had no length accessor at all before Phase 71.
    /// An absent bucket reads 0 (buckets are removed lazily when they drain, so
    /// "absent" and "empty" are the same statement).
    pub fn len_on(&self, port: PortId) -> usize {
        self.0.get(&port).map_or(0, VecDeque::len)
    }

    /// The items resting on `port`, in FIFO (delivery) order. A read-only,
    /// port-scoped variant of [`has_on`](Self::has_on) - the same shape and the same
    /// reason: it answers "what is stuck here?" without draining anything and without
    /// scanning the whole inbox.
    ///
    /// Its consumers are the assertions that have to look INSIDE a bounded queue
    /// rather than merely measure it: plan 71-03's count of
    /// [`FaultReason::OutputRefused`](crate::fault::FaultReason::OutputRefused) faults
    /// on a gated board, and plan 71-04's fault-cap tests. It is an accessor with
    /// named callers, not an unused convenience.
    pub fn items_on(&self, port: PortId) -> impl Iterator<Item = &Item> + '_ {
        self.0
            .get(&port)
            .into_iter()
            .flatten()
            .map(|(_seq, item)| item)
    }

    /// Keep only the items on `port` for which `keep` answers true, preserving the FIFO
    /// order of the survivors, and return how many were removed (Phase 72, SERVE-08).
    ///
    /// # Why a targeted removal exists at all, when nothing needed one before
    /// Every other consumer of this type drains from the FRONT ([`take`](Self::take)) or
    /// reads without mutating ([`items_on`](Self::items_on)), because every other
    /// consumer processes a queue in order. D-25 grants ONE fault reason
    /// ([`crate::fault::FaultReason::NoEntryWire`]) a self-clear when the user draws the
    /// cable that was missing, and that is a removal FROM THE MIDDLE of a queue that may
    /// also hold faults which must survive. `take`-and-push-back would work and was
    /// rejected: it renumbers nothing but reads as a drain, and a later editor would
    /// have no way to see that the surviving entries' order was load-bearing.
    ///
    /// The bucket is REMOVED when it empties, exactly as `take` does, so "absent" and
    /// "empty" stay the same statement for [`has_on`](Self::has_on) and
    /// [`len_on`](Self::len_on).
    ///
    /// Deterministic: a `VecDeque::retain` walks in order and the predicate sees only
    /// the item bytes, so the result is a pure function of the queue contents.
    pub fn retain_on(&mut self, port: PortId, mut keep: impl FnMut(&Item) -> bool) -> usize {
        let Some(q) = self.0.get_mut(&port) else {
            return 0;
        };
        let before = q.len();
        q.retain(|(_seq, item)| keep(item));
        let removed = before - q.len();
        if q.is_empty() {
            self.0.remove(&port);
        }
        removed
    }
}

/// Per-node **output** buffer: one FIFO queue per output port. Drained in
/// ascending port order to feed downstream belts deterministically.
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct PortOutbox(BTreeMap<PortId, VecDeque<Item>>);

impl PortOutbox {
    /// An empty outbox.
    pub fn new() -> Self {
        Self::default()
    }

    /// Enqueue `item` on output `port`, FIFO.
    pub fn push(&mut self, port: PortId, item: Item) {
        self.0.entry(port).or_default().push_back(item);
    }

    /// True when no output port holds any item.
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// Drain every queued output as `(PortId, Item)` in ascending port order,
    /// FIFO within a port, clearing the outbox. This is the deterministic order
    /// the fold uses to route outputs onto belts (plan 05).
    pub fn drain_sorted(&mut self) -> Vec<(PortId, Item)> {
        let mut out = Vec::new();
        // BTreeMap drains ascending by key.
        for (port, queue) in std::mem::take(&mut self.0) {
            for item in queue {
                out.push((port, item));
            }
        }
        out
    }
}

/// The axis of a STRAIGHT belt tile — **plain data** (BELT-01). The serialized
/// geometry vocabulary the `Belt`, [`EditOp::DrawBelt`](crate::edit::EditOp) and
/// the (11-05) `route()` normalizer all share. Integer-only, no float.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum Axis {
    /// East–west (horizontal) run.
    #[default]
    X,
    /// North–south (vertical) run.
    Y,
}

/// A travel direction on the pinned **y-down** axis (mirrors [`Side`]'s numeric
/// order `N=0, E=1, S=2, W=3`) — **plain data** (BELT-01). Used by a corner tile
/// to record the in/out directions the player drew. Distinct from [`Side`] (a
/// cell *edge* a port faces); a `Dir` is the *flow* direction along a belt.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum Dir {
    /// North — `(0, -1)`.
    #[default]
    N = 0,
    /// East — `(+1, 0)`.
    E = 1,
    /// South — `(0, +1)`.
    S = 2,
    /// West — `(-1, 0)`.
    W = 3,
}

/// The typed shape of one drawn belt tile — **plain data** (BELT-01). A
/// `Straight` run along an [`Axis`], or a 90° `Corner` recording the flow `from`
/// one [`Dir`] `to` another. The (11-05) `route()` normalizer is the SOLE producer;
/// the fold applies the resolved tiles VERBATIM (BELT-04, replay never re-routes).
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum TileKind {
    /// A straight run along `axis`.
    Straight {
        /// The run axis.
        axis: Axis,
    },
    /// A 90° corner: flow enters facing `from` and leaves facing `to`. `route()` stores
    /// only 90° corners; the seam table ([`seam_end_kind`], derived on every read and never
    /// stored) also answers the zero-turn `Corner { from: e, to: e }` for a one-tile belt,
    /// so its flow direction reaches the render packet (phase 89, D-15).
    Corner {
        /// The inbound flow direction.
        from: Dir,
        /// The outbound flow direction.
        to: Dir,
    },
}

impl Default for TileKind {
    fn default() -> Self {
        TileKind::Straight { axis: Axis::X }
    }
}

/// One drawn belt tile: its grid `cell` plus its typed [`TileKind`] geometry —
/// **plain data** (BELT-01/06). The belt claims each `cell` into the SAME unified
/// [`occupancy`](GridState::occupied) index machine footprints use, so a belt can
/// never overlap another belt or a machine body.
///
/// # Why `kind` is private (plan 74.1-21, review WR-04)
///
/// Since plan 74.1-07 a docked end has two kinds: the STORED kind `route()` authored
/// (hashed, snapshotted, logged, replayed) and the DRAWN kind
/// [`GridState::effective_belt_tiles`] derives from the seam. A reader of the stored kind
/// would disagree with the picture at every perpendicular dock. A source guard that
/// matched `.kind` by line text missed the likeliest read shapes (a loop binding, an
/// end-tile binding, a destructure), so the TYPE now holds the rule: outside this module
/// the field cannot be named, a tile is built with [`BeltTile::new`], and the one read
/// path is [`BeltTile::tile_kind`], which `fabrico-host/tests/tile_kind_readers.rs`
/// counts outside the files allowed to read a kind.
///
/// Serde reads and writes the field by position whatever its visibility, so this
/// changes no serialized byte.
///
/// Naming the field from another crate does not compile:
///
/// ```compile_fail
/// let t = fabrico_core::state::BeltTile::default();
/// let _ = t.kind;
/// ```
///
/// and neither does destructuring it:
///
/// ```compile_fail
/// let fabrico_core::state::BeltTile { kind, .. } = fabrico_core::state::BeltTile::default();
/// let _ = kind;
/// ```
///
/// while the accessor and the constructor do (the control for both cases above):
///
/// ```
/// use fabrico_core::state::{BeltTile, TileKind};
/// let t = BeltTile::new((1, 2), TileKind::default());
/// assert_eq!(t.tile_kind(), TileKind::default());
/// assert_eq!(t.cell, (1, 2));
/// ```
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct BeltTile {
    /// The grid cell this tile occupies.
    pub cell: (i32, i32),
    /// The tile's typed straight/corner geometry. PRIVATE: read it through
    /// [`BeltTile::tile_kind`] (see the type's docs).
    kind: TileKind,
}

impl BeltTile {
    /// A tile at `cell` with the stored `kind`. The one way to build a tile outside this
    /// module, since `kind` is private.
    pub const fn new(cell: (i32, i32), kind: TileKind) -> BeltTile {
        BeltTile { cell, kind }
    }

    /// This tile's kind: the one read path for a tile kind outside this module.
    ///
    /// On a tile from a belt's stored `geometry` this is the STORED kind `route()` typed.
    /// On a tile returned by [`GridState::effective_belt_tiles`] it is the DRAWN kind,
    /// with each docked end re-kinded from its seam. Only the four files
    /// `tile_kind_readers.rs` allows may call it in non-test code; a sim reader that needs
    /// a kind calls `effective_belt_tiles` from inside the fold, a declared replay move.
    pub fn tile_kind(&self) -> TileKind {
        self.kind
    }
}

/// A belt (channel) as a **per-tile slot line** — **plain data** (BELT-05/07).
///
/// The v1.0 single-delay-line `{ latency, in_flight }` is RETIRED (Phase-11 clean
/// break): a belt now models items PER TILE. `slots` is a flat
/// `[Option<Item>]` of length `SLOTS_PER_TILE * tiles` (slot 0 = HEAD/deliver end,
/// slot `M-1` = TAIL/admit end); items advance one slot toward the head on each of
/// the belt's own DUE TICKS and visibly bunch under backpressure.
///
/// # The ONE-knob doctrine is RETIRED too (Phase-62 clean break, SLOT-03)
/// This paragraph read *"items advance one slot/tick toward the head"* and *"Length
/// couples BOTH transport latency AND buffer capacity (ONE knob, BELT-05)"*. Both
/// sentences are superseded and are corrected in place rather than deleted, in the
/// same shape the Phase-11 retirement above uses. A belt now carries its OWN advance
/// interval ([`ticks_per_slot`](Belt::ticks_per_slot), `62-CONTEXT.md` D-01/D-02), so
/// it advances one slot every `ticks_per_slot` ticks rather than every tick. Length
/// still couples capacity and latency, and capacity is still `SLOTS_PER_TILE * tiles`
/// off the length knob alone; latency now scales with length AND with the interval.
/// The full supersession, with the retired sentences quoted, is recorded on
/// `SLOTS_PER_TILE` in [`crate::belt_slots`], which is the one place it is stated at
/// length. `geometry` is the drawn tile cells (for the
/// unified occupancy claim + render): EMPTY for a `Wire`-minted logical belt,
/// length `== tiles` for a `DrawBelt`-drawn belt. Both `slots` and `geometry` are
/// integer-indexed plain serde data, so a belt mid-transport snapshots byte-exactly
/// (CORE-09). The advance/admit behavior is [`crate::belt`]; the fold delivers the
/// head ([`crate::tick`]).
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Belt {
    /// Number of tiles (= drawn cell count). Capacity = `SLOTS_PER_TILE * tiles`.
    pub tiles: u32,
    /// Per-slot single-lane occupancy, length `== SLOTS_PER_TILE * tiles`. A `Vec`
    /// of `Option<Item>` (NOT a `VecDeque`): items hold true per-slot positions.
    pub slots: Vec<Option<Item>>,
    /// The drawn tile cells (for occupancy/render). EMPTY for a `Wire`-minted
    /// logical belt; length `== tiles` for a `DrawBelt`-drawn belt.
    pub geometry: Vec<BeltTile>,
    /// Sim TICKS between one slot advance for THIS belt (SLOT-03, `62-CONTEXT.md`
    /// D-01). Larger means slower; [`crate::belt`]'s `step` advances only on a tick
    /// `T` where `T % ticks_per_slot == 0`.
    ///
    /// **The invariant is `> 0`, and it is enforced by the TYPE.** `NonZeroU32` makes
    /// the modulo in `Belt::step` structurally panic-free, and a forged snapshot
    /// carrying a zero fails inside postcard and surfaces as the existing typed
    /// `DecodeError::Malformed` — reject-only, never a panic. That is why there is no
    /// new `StateInvariant` arm for this field; the reasoning is recorded in full at
    /// the `BeltSlotCount` arm in [`crate::snapshot`]'s `validate_invariants`.
    ///
    /// Set from [`crate::belt_slots::DEFAULT_TICKS_PER_SLOT`] at construction and
    /// SERIALIZED, so a per-belt override costs no further core change (the deferred
    /// belt-tier phase adds a `kind` byte ALONGSIDE this field and does not move it).
    pub ticks_per_slot: NonZeroU32,
}

/// A `Belt` has no meaningful zero value, so `Default` is the zero-tile belt built
/// through the ONE constructor rather than a derive.
///
/// The derive was removed in Phase 62 because `NonZeroU32` has no `Default` and
/// deriving one would have had to invent a zero interval — precisely the state the
/// type exists to make unrepresentable. Routing through [`Belt::new`] instead means
/// `Default` and `Belt::new(0)` can never disagree about what a fresh belt carries.
/// The live consumer is `state_factory_is_the_last_node_discriminant` below, which
/// serializes `Node::Belt(Belt::new(0))` to pin the frozen discriminant.
impl Default for Belt {
    fn default() -> Self {
        Self::new(0)
    }
}

impl Belt {
    /// A fresh, empty belt of `tiles` tiles: `SLOTS_PER_TILE * tiles` empty slots,
    /// no drawn geometry (a `Wire`-minted logical belt), and the crate's default
    /// advance interval. A `DrawBelt` fold sets `geometry` after minting.
    pub fn new(tiles: u32) -> Self {
        Self {
            tiles,
            slots: vec![None; crate::belt_slots::slot_count(tiles)],
            geometry: Vec::new(),
            // SLOT-03: the ONLY read of DEFAULT_TICKS_PER_SLOT in the executable
            // path. `Belt::step` reads `self.ticks_per_slot`, never the constant.
            ticks_per_slot: crate::belt_slots::DEFAULT_TICKS_PER_SLOT,
        }
    }
}

/// The manual-inject source — **plain data** (SRC-02). `fire` (the `Machine`
/// impl that drops one queued item onto the belt) is plan 05.
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ManualInject {
    /// Items queued for injection, fired one logged event at a time.
    pub pending: VecDeque<Item>,
}

impl ManualInject {
    /// A fresh manual-inject source with nothing queued.
    pub fn new() -> Self {
        Self::default()
    }
}

/// A broadcast / tee operator — **plain data** (ROUTE-02).
///
/// Copies each inbound item to ALL output ports (`0..outputs`) as independent
/// deep clones. The behavior (`Machine` impl) lives in [`crate::tee`]; this
/// struct only holds the fan-out arity. A zero-arity tee drains its input and
/// emits nothing (guarded in `step`, never panics — threat T-2-ARITY).
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Tee {
    /// Number of output ports to broadcast to (ports `0..outputs`).
    pub outputs: u16,
    /// Snapshot-captured count of copies a busy branch could not take (phase 87,
    /// JAM-02, D-03): each such copy goes to the Tee's fault port as a fault naming the
    /// branch, and this counts them, in the shape of [`Router::faults`]. Plan 87-05
    /// increments it; plan 87-03 only adds it.
    ///
    /// # Appended LAST (SNAPSHOT 13 to 14)
    /// After `outputs`, so every earlier field keeps its postcard position. It rides the
    /// phase's ONE snapshot bump with `Balancer::next_in`, `Factory::pending_emits` and
    /// `Scheduler::blocked`.
    pub faults: u64,
}

impl Tee {
    /// A tee fanning out to `outputs` ports, fault count at 0.
    pub fn new(outputs: u16) -> Self {
        Self { outputs, faults: 0 }
    }
}

/// A balancer operator — **plain data** (ROUTE-03).
///
/// Sends each inbound item to exactly ONE output port, advancing the round-robin
/// pointer `next` each item (visibly distinct from a tee). The behavior lives in
/// [`crate::balancer`].
///
/// `next` is a **public field** so the whole-node snapshot captures it: a restore
/// taken mid-rotation MUST continue the round-robin from the same port (REPLAY/
/// SC#2 extended to selection state; RESEARCH Pitfall 1). It must NEVER live in a
/// static, thread-local, or `Core`-level side map, or snapshot/replay diverges
/// (threat T-2-ROT).
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Balancer {
    /// Number of output ports to spread across (ports `0..outputs`).
    pub outputs: u16,
    /// Round-robin rotation pointer — the next output port to use. Snapshot-
    /// captured (inside the Node variant serde data) so a mid-rotation restore
    /// resumes identically (RESEARCH Pitfall 1, threat T-2-ROT).
    pub next: u16,
    /// Round-robin INPUT pointer (phase 87, JAM-01, D-02, WINDOWS 175): the catalog In
    /// port (`0..DEFAULT_ARITY`) the next pass scans first. Separate from `next` on
    /// purpose: starting the input scan at the OUTPUT pointer would lock In 0 to Out 0
    /// and In 1 to Out 1 on a two-output Balancer, and starve In 1 on a one-output one
    /// (87-RESEARCH Finding 1). Snapshot-captured like `next`, so a restore taken
    /// mid-rotation resumes the input rotation identically (threat T-2-ROT); the trust
    /// gate refuses `next_in >= DEFAULT_ARITY` (`StateInvariant::BalancerInputPointer`).
    ///
    /// # Appended LAST (SNAPSHOT 13 to 14)
    /// After `next`, so every earlier field keeps its postcard position.
    pub next_in: u16,
}

impl Balancer {
    /// A balancer spreading across `outputs` ports, both pointers at the first port.
    pub fn new(outputs: u16) -> Self {
        Self {
            outputs,
            next: 0,
            next_in: 0,
        }
    }
}

/// A merge / funnel operator — **plain data** (ROUTE-05).
///
/// Combines N input belts into ONE output (always port 0). When several inputs
/// have items ready on the same tick, the merge serves them by **deterministic
/// round-robin across non-empty input ports** (FIFO within a port), one item per
/// non-empty input per step, re-waking itself at `tick+1` while any input still
/// holds a backlog (bounded per-tick work; CORE-07). The behavior lives in
/// [`crate::merge`]; this struct only holds the fan-in arity and the rotation
/// pointer.
///
/// `next` is the round-robin **start** port for the next pass — a **public field**
/// so the whole-node snapshot captures it: a restore taken mid-rotation MUST
/// continue the funnel from the same start port (REPLAY/SC#2 extended to merge
/// selection state; RESEARCH Pitfall 1). It must NEVER live in a static,
/// thread-local, or `Core`-level side map, or snapshot/replay diverges (threat
/// T-2-ROT-MERGE). A zero-arity merge no-ops (guarded in `step`, never `% 0`,
/// never panics — threat T-2-ARITY-M).
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Merge {
    /// Number of input ports to funnel from (ports `0..inputs`).
    pub inputs: u16,
    /// Round-robin rotation pointer — the start input port for the next pass.
    /// Snapshot-captured (inside the Node variant serde data) so a mid-rotation
    /// restore resumes identically (RESEARCH Pitfall 1, threat T-2-ROT-MERGE).
    pub next: u16,
}

impl Merge {
    /// A merge funnelling `inputs` ports to output port 0, pointer at the first.
    pub fn new(inputs: u16) -> Self {
        Self { inputs, next: 0 }
    }
}

/// A single routing rule — **plain data** (ROUTE-04).
///
/// A route matches when the byte slice of the item at `[offset .. offset+len]`
/// equals `expect`. The match is a **bounds-safe range read** (RESEARCH Pattern 6,
/// Pitfall 4 / Security V5): a short or crafted item that is too small for the
/// requested slice yields no-match, never a panic — a panic here would be a DoS of
/// the deterministic core. Equality / set-membership over logged item bytes is the
/// "condition over logged data" ROUTE-04 demands; the item bytes are reproducible
/// on replay, so the routing decision is deterministic with no `Event` change.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct RouteKey {
    /// Byte offset into the item at which to compare.
    pub offset: u16,
    /// The expected bytes at `[offset .. offset+expect.len()]`.
    pub expect: Vec<u8>,
}

impl RouteKey {
    /// A route keyed on `expect` appearing at byte `offset` of the item.
    pub fn new(offset: u16, expect: Vec<u8>) -> Self {
        Self { offset, expect }
    }

    /// True when the item's bytes at `[offset .. offset+expect.len()]` equal
    /// `expect`. **Bounds-safe**: `item.0.get(lo..hi)` returns `None` (no-match)
    /// for a short/crafted item — NEVER `item.0[offset]` indexing, which would
    /// panic (RESEARCH Pitfall 4 / threat T-2-ITEM, a DoS of the deterministic
    /// core).
    pub fn matches(&self, item: &Item) -> bool {
        let lo = self.offset as usize;
        let hi = lo + self.expect.len();
        item.0.get(lo..hi) == Some(self.expect.as_slice())
    }
}

/// A router / switch operator — **plain data** (ROUTE-04).
///
/// Switches each inbound item to the output port of the **first** matching route
/// (`routes` is an ORDERED `Vec` so first-match is deterministic — never a
/// `HashMap`, threat T-2-DET). With no matching route the item goes to the
/// configured `default` ("else") output; if `default` is `None`, the item is
/// emitted on the reserved [`FAULT_PORT`](crate::fault::FAULT_PORT) as a
/// [`Fault::no_match`](crate::fault::Fault::no_match) — the first Phase-2 fault
/// producer. The behavior lives in [`crate::router`].
///
/// `faults` is a snapshot-captured debug counter (CONTEXT "unwired fault port:
/// drop with a debug counter") incremented each time the router emits on
/// `FAULT_PORT` — a **producer-side** count. Whether a wired fault belt later
/// delivers it is a wiring question the share-nothing router cannot observe, so
/// this counts production, honoring the debug-counter intent within share-nothing.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Router {
    /// Ordered match table; the FIRST matching route wins (deterministic).
    pub routes: Vec<(RouteKey, PortId)>,
    /// The default ("else") output port; `None` => route no-match to the fault
    /// port (`FAULT_PORT`).
    pub default: Option<PortId>,
    /// Snapshot-captured debug counter: how many faults this router has produced
    /// (incremented on each `FAULT_PORT` emission).
    pub faults: u64,
}

impl Router {
    /// A router with the given ordered `routes` and optional `default` port,
    /// fault counter at 0.
    pub fn new(routes: Vec<(RouteKey, PortId)>, default: Option<PortId>) -> Self {
        Self {
            routes,
            default,
            faults: 0,
        }
    }
}

/// A factory machine — **plain data** (FACT-01..04, the Phase-4 sandbox node).
///
/// A factory runs untrusted user JavaScript through an embedded `rquickjs`
/// (QuickJS-NG) engine once per input item. To keep `Node::Factory` snapshot-clean
/// and free of any live-engine handles (RESEARCH primary recommendation), this
/// struct holds ONLY pure serializable data; the non-serializable live engine
/// (`Runtime`/`Context`/`Persistent`) lives in a `#[serde(skip)]`
/// [`FactoryRuntimeCache`](crate::factory::FactoryRuntimeCache) on `Core`, keyed by
/// `NodeId` and rebuilt lazily from this plain data on a cold cache / after restore.
///
/// # `state_json` is the SOLE cross-tick / snapshotted factory state (CONTEXT)
/// `ctx.state` is the only thing that crosses a tick boundary AND the only thing
/// captured in the whole-`Core` snapshot. Arbitrary JS globals stashed by user code
/// are per-tick scratch and are deliberately NOT persisted — the live engine is
/// rebuilt fresh on restore, so a global stash diverges immediately (caught by the
/// per-tick determinism hash). `state_json` is the canonical `JSON.stringify(ctx.state)`
/// bytes produced inside the engine; a fresh factory starts at `{}`.
///
/// # `rng` is a per-node deterministic substream
/// Sub-seeded from the genesis seed mixed with the node id at
/// [`add_factory`](GridState::add_factory) time, then advanced-and-snapshotted exactly
/// like the global [`SimRng`] — backing `ctx.random()`/`ctx.randomInt()` with seeded,
/// reproducible draws (groundwork for Phase-1's deferred per-partition RNG, WR-06).
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Factory {
    /// The user JavaScript source: an `export default function(input, ctx) { … }`
    /// module compiled once into the live engine.
    pub source: String,
    /// The per-tick gas budget (interrupt-callback count) — a logged config constant
    /// passed to the engine's deterministic fuse. Snapshotted so a restore rebuilds
    /// the engine with the identical fence.
    pub gas_budget: u64,
    /// The per-node ChaCha8 substream backing `ctx.random`/`ctx.randomInt`. Its
    /// advanced counter state is snapshotted, so a restored run continues the
    /// identical draw sequence.
    pub rng: SimRng,
    /// The canonical JSON bytes of `ctx.state` — the SOLE cross-tick / snapshotted
    /// factory state. Initialized to an empty object (`{}`); advanced each tick by
    /// the factory's `run`, rolled back unchanged on a fault.
    pub state_json: Vec<u8>,
    /// Snapshot-captured per-machine counter of faults this factory emitted on the
    /// reserved [`FAULT_PORT`](crate::fault::FAULT_PORT) with **no belt docked**
    /// there — the fold's undocked-fault DROP point (CONTEXT Area 2: an unwired
    /// fault is counted, never silently dropped). The producer-side sibling of
    /// [`Router::faults`], but semantically a DROP counter (incremented at the
    /// fold's route/drop point, not at production) — so a docked fault belt does
    /// NOT increment it.
    ///
    /// Since 87-REVIEW CR-01 it also counts the waiting emits of [`pending_emits`](Self::pending_emits)
    /// dropped when their port's link is released ([`GridState::unlink`]), the other point
    /// where a Factory loses an accepted item.
    ///
    /// # Appended LAST (byte-additive, SNAPSHOT 6→7)
    /// This field is appended AFTER `state_json` so every existing serialized
    /// `Factory` prefix stays byte-identical (postcard is positional). Its layout
    /// change is the DELIBERATE reason the SNAPSHOT schema bumps 6→7 this phase —
    /// the bump is policy-driven (spend the blast-radius once), not byte-forced by
    /// `Role::Fault` (which is a pure additive enum append).
    pub faults: u64,
    /// Emits beyond the first per port of one run, waiting for the belt (phase 87,
    /// JAM-05, D-07, WINDOWS 165). Keyed by the Factory's own output port; each queue
    /// leaves one item per tick as the belt takes it, and while any queue is non-empty
    /// the Factory takes no new input. Plain serialized state, so a snapshot captures
    /// it. Plan 87-04 fills it; plan 87-03 only adds it. The trust gate bounds it
    /// (`StateInvariant::FactoryPendingEmits`): no [`FAULT_PORT`](crate::fault::FAULT_PORT)
    /// key, no key without a link from this Factory, no empty queue, and every queue
    /// under [`FACTORY_EMITS_PER_PORT`](crate::factory::FACTORY_EMITS_PER_PORT).
    ///
    /// # Appended LAST (SNAPSHOT 13 to 14)
    /// After `faults`. A `BTreeMap`, so its encoding is in ascending port order.
    pub pending_emits: BTreeMap<PortId, VecDeque<Item>>,
}

impl Factory {
    /// A fresh factory with the given `source`, `gas_budget`, and per-node `rng`
    /// substream, starting from an empty-object `ctx.state` and a zero fault count.
    pub fn new(source: String, gas_budget: u64, rng: SimRng) -> Self {
        Self {
            source,
            gas_budget,
            rng,
            state_json: EMPTY_STATE_JSON.to_vec(),
            faults: 0,
            pending_emits: BTreeMap::new(),
        }
    }
}

/// The effect-shape a [`Sink`] machine stamps onto each item it consumes —
/// **plain data** (Phase-5 EXEC seam). A sink holds only the *template*
/// (the routing intent: which kind of effect, and the static `url`/`method`
/// fields); the per-item payload bytes are filled in at [`Sink::step`] time by
/// [`SinkTemplate::to_effect`].
///
/// # No secrets ride here (Pitfall 6, threat T-05-01-SECRET)
/// Like [`Effect`], a `SinkTemplate` is captured in the whole-grid snapshot and
/// is therefore persisted. It carries intent ONLY — auth tokens live in host config
/// and are injected at dispatch time, never stored on a `SinkTemplate` field.
///
/// Discriminants: `Debug` 0, `Http` 1. Phase 85 (D-08, CHROME-04) deleted the Email
/// target that sat at 1, with no placeholder, so `Http` moved from 2 to 1 under the
/// SNAPSHOT `12 -> 13` and EDIT `11 -> 12` bumps that refuse every older shape.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum SinkTemplate {
    /// Emit an [`Effect::Debug`] carrying the item bytes (the I/O-free sink).
    Debug,
    /// Emit an [`Effect::Http`] dispatching the item bytes to `url` with `method`.
    Http {
        /// Target URL (routing intent, not a secret).
        url: String,
        /// The HTTP verb to dispatch with (CFG-01). Default [`HttpMethod::Post`].
        method: HttpMethod,
    },
}

impl SinkTemplate {
    /// Stamp `payload` (the consumed item's bytes) onto this template, producing
    /// the concrete [`Effect`] the [`Sink`] emits as command intent.
    pub fn to_effect(&self, payload: Vec<u8>) -> Effect {
        match self {
            SinkTemplate::Debug => Effect::Debug { message: payload },
            SinkTemplate::Http { url, method } => Effect::Http {
                url: url.clone(),
                body: payload,
                method: *method,
            },
        }
    }
}

/// A terminal sink machine (Phase-5 EXEC seam) — **plain data**.
///
/// A sink consumes items on input port 0 and, for each, emits exactly one
/// [`Command`](crate::command::Command) of side-effecting intent via
/// [`StepCtx::emit`](crate::machine::StepCtx::emit) — it produces NO belt output
/// (terminal). The host executor (a later plan) turns that intent into real I/O
/// off the sim thread and feeds the [`Outcome`](crate::command::Outcome) back as
/// a logged event. The behavior lives in [`crate::sink`]; this struct holds only
/// the effect template and the per-command timeout deadline (in ticks).
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Sink {
    /// The effect-shape stamped onto each consumed item.
    pub template: SinkTemplate,
    /// Ticks-from-emit deadline carried on each emitted command; the host uses it
    /// to synthesize a [`Timeout`](crate::event::EventPayload::Timeout).
    pub deadline_ticks: u64,
}

impl Sink {
    /// A sink emitting `template`-shaped commands with the given tick deadline.
    pub fn new(template: SinkTemplate, deadline_ticks: u64) -> Self {
        Self {
            template,
            deadline_ticks,
        }
    }
}

/// The logical transport payload of a [`Node::Wire`] (Phase-37 request/response
/// transport) — **plain data**, carrying live traffic since Phase 37.
///
/// A wire carries its two *logical* endpoints — `(node, port)` handles, never raw
/// pointers (API-03) — plus its bounded in-flight request/response FIFO. A snapshot
/// round-trips byte-faithfully and a restored wire can be re-addressed after id
/// reassignment. `in_flight` is the wire's own transport state (the `Belt.slots`
/// analog): it is a `VecDeque` on the stack (pointer+len+cap), so `Node::Wire` still
/// does NOT grow the `Node` enum (the boxed `Factory` remains the largest variant).
///
/// # `in_flight` is the ONLY reply-routing snapshot state (append-LAST, Phase 37)
/// The `in_flight` field is appended AFTER `from`/`to` (postcard is positional), so a
/// snapshot minted before it exists stays byte-faithful and a grid with no wire (the
/// whole frozen golden corpus) serializes byte-identically. It is the single field
/// the snapshot needs for reply routing: the correlation-to-return-address binding
/// rides ON each [`crate::wire::WireInFlight`] message, never a separate router-side
/// table (stateless forward routing), and the Phase-38 parked-socket/correlation
/// registry is host-side `#[serde(skip)]` (the `factory_runtimes` precedent), so this
/// shape needs ZERO further serialized growth for Phase 38.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct WireLink {
    /// The output side the wire originates from — a logical `(node, port)` handle.
    pub from: (NodeId, PortId),
    /// The input side the wire terminates at — a logical `(node, port)` handle.
    pub to: (NodeId, PortId),
    /// The wire's bounded in-flight request/response FIFO (the `Belt.slots` analog).
    /// Bounded at [`crate::wire::WIRE_INFLIGHT_CAP`] by [`crate::wire::admit`];
    /// **appended LAST** so pre-`in_flight` snapshots stay byte-faithful and a grid
    /// with no wire serializes byte-identically to before this append.
    pub in_flight: VecDeque<crate::wire::WireInFlight>,
}

/// The payload of a [`Node::Endpoint`] (Phase-38 host bridge) — **plain data**.
///
/// # It carries ONE field, and this docblock is rewritten whole rather than patched
/// From Phase 38 until 72-07 this struct had no fields at all, and the text that stood
/// here asserted three consequences of that: that the struct had never grown one, that
/// it therefore cost no wire bytes, and that a grid holding an endpoint serialized
/// byte-identically because of it. All three are FALSE from this commit. They are
/// DELETED rather than quoted back and annotated: a superseded claim left in place, even
/// under a correction, is the sentence a later engineer greps for and reasons from, and
/// this repository has a recorded instance of exactly that (`project.rs:130-135`). The
/// old wording lives in the project history for plan 72-07, where a reader chasing it
/// lands on the reason it changed.
///
/// What survives from the old text, because it is still true, is the reason the
/// PENDING-REQUEST REGISTRY is not here: Phase 38 put it host-side (`#[serde(skip)]`,
/// the `factory_runtimes` precedent) because it is in-flight host state, not board
/// configuration.
///
/// # Why the path IS here, when the registry is not (D-12, SERVE-08)
/// A Route's address is BOARD CONFIGURATION: the user typed it, it is part of what the
/// factory IS, and this project's standing rule is that state is fully capturable at a
/// tick boundary with no hidden state outside snapshots. Re-deriving it by walking the
/// edit log was considered and REJECTED as wrong rather than as one option of two,
/// because a log walk puts configuration where a snapshot cannot see it.
/// `project_timers` re-deriving from the log is recorded DEBT, not a pattern to copy.
///
/// # The wire consequence, stated plainly because it is a real cost
/// A grid holding an Endpoint no longer serializes to the bytes it did before this
/// commit: the struct grew from zero fields to one length-prefixed `String`. Every
/// frozen fixture carrying an Endpoint moves, which is a DECLARED move for this
/// milestone and is why `SNAPSHOT_SCHEMA_VERSION` is owed a bump. That bump is NOT
/// taken here: it rides plan 72-12's single constants commit together with the corpus
/// re-bless, so the version and the fixtures move in one reviewed step (R-2 / R-74).
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Endpoint {
    /// The URL path this Route answers at, INCLUDING its leading `/` (SERVE-08).
    ///
    /// Seeded by [`GridState::add_endpoint`] to a readable `/route-N`, N the smallest
    /// positive number no Endpoint on the board holds as its path (phase 91, D-13). The
    /// host keys the Route by this path, so it answers at `POST /endpoint/route-N` until
    /// the user types another.
    ///
    /// It is the ONLY field, so there is no ordering hazard within this struct; the
    /// append discipline that matters is at the enclosing [`Node`] level and is
    /// untouched. Bounded at [`crate::edit::MAX_ENDPOINT_PATH_BYTES`] at BOTH the
    /// `Configure` write gate and the snapshot restore gate, from ONE constant.
    pub path: String,
}

/// A label's colour (phase 76, D-05): a CLOSED set of six, never a free string.
///
/// The variant order IS the postcard byte (Sand 0, Stone 1, Moss 2, Lilac 3, Rose 4,
/// Clay 5) and it is the order of the TypeScript `LABEL_COLOURS` array in
/// `frontend/src/render/synth/skin.ts`; `crates/fabrico-command/tests/ts_label_mirror.rs`
/// locks the two orders together. A byte past the last variant FAILS to decode, so a
/// forged colour is a decode error, never a silent default (the `NonZeroU32` precedent).
/// None of these is a state colour: green, red and blue mean working, fault and build,
/// and a label has no state. Append new colours after `Clay`, never between.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum LabelColour {
    /// Byte 0, the default: a placed label is Sand.
    #[default]
    Sand,
    /// Byte 1, the neutral.
    Stone,
    /// Byte 2.
    Moss,
    /// Byte 3.
    Lilac,
    /// Byte 4.
    Rose,
    /// Byte 5.
    Clay,
}

impl LabelColour {
    /// The colour's byte: its declaration index, which is also its postcard encoding and
    /// the `colour` byte the render packet and the wire `MachineConfig::Label` carry
    /// (plan 76-02). `ts_label_mirror.rs` holds the order to the TypeScript one.
    #[must_use]
    pub const fn to_byte(self) -> u8 {
        match self {
            LabelColour::Sand => 0,
            LabelColour::Stone => 1,
            LabelColour::Moss => 2,
            LabelColour::Lilac => 3,
            LabelColour::Rose => 4,
            LabelColour::Clay => 5,
        }
    }

    /// The colour a byte names, or `None` above 5: the set is closed, so an unknown byte
    /// is refused by the caller (`Malformed` at the command layer), never defaulted.
    #[must_use]
    pub const fn from_byte(byte: u8) -> Option<LabelColour> {
        match byte {
            0 => Some(LabelColour::Sand),
            1 => Some(LabelColour::Stone),
            2 => Some(LabelColour::Moss),
            3 => Some(LabelColour::Lilac),
            4 => Some(LabelColour::Rose),
            5 => Some(LabelColour::Clay),
            _ => None,
        }
    }
}

/// A note on the board (phase 76, SHAPE-10, design ruling of 2026-07-23: labels
/// are a real `Node` kind, their text and colour are plain data, and a label steps to
/// nothing).
///
/// Its SIZE is not here: it lives in `GridState.footprints` like every machine's box, so a
/// label takes its floor cells exactly like a machine (D-01) through the same occupancy
/// code, with no special case anywhere.
///
/// Plain data, two fields, appended to no existing type: a grid holding no label is
/// byte-identical to one built before this struct existed.
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Label {
    /// The words on the label, typed by the user. Empty on placement. Bounded by
    /// `crate::edit::MAX_LABEL_BYTES` at the write gate and at every load gate from plan
    /// 76-02 onward, from ONE constant.
    pub text: String,
    /// The box tint, one of six (D-05). Sand on placement.
    pub colour: LabelColour,
}

/// A node in the grid. Phase 1 has the two built-in kinds; Phase 2 adds the
/// routing-operator variants (tee/balancer/merge/router); Phase 4 appends the
/// factory sandbox node; Phase 5 appends the sink node.
///
/// # Variant ordering is LOAD-BEARING (wire-format discipline)
/// postcard encodes an enum by its variant **discriminant** (declaration index),
/// which is NOT self-describing. New variants are therefore **appended after** the
/// existing ones so prior discriminants never shift: `Source=0 … Router=5` stay
/// frozen, so the Phase-2/3 golden corpus (`0001`-`0004`) keeps decoding
/// byte-identically after `Factory` is added at discriminant 6. Never reorder or
/// insert before an existing variant.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum Node {
    /// A manual-inject source (SRC-02). Discriminant 0 — frozen by the golden corpus.
    Source(ManualInject),
    /// A belt / channel (ROUTE-01).
    Belt(Belt),
    /// A broadcast / tee operator (ROUTE-02).
    Tee(Tee),
    /// A balancer operator (ROUTE-03).
    Balancer(Balancer),
    /// A merge / funnel operator (ROUTE-05).
    Merge(Merge),
    /// A router / switch operator (ROUTE-04). Discriminant 5 — the last Phase-2
    /// variant; the frozen corpus depends on this staying put.
    Router(Router),
    /// A factory sandbox node (FACT-01..04). **Appended LAST** (discriminant 6) to
    /// preserve every existing discriminant — see the type-level ordering note.
    ///
    /// `Box`ed because [`Factory`] (a `String` + a ~136-byte `SimRng` + a `Vec`) is
    /// far larger than the other variants; boxing keeps every `Node` small (the enum
    /// is sized to its largest variant, and most nodes are tiny belts/operators). The
    /// box is serde-transparent — `Box<Factory>` serializes byte-for-byte as `Factory`
    /// — so discriminants and snapshot bytes are unaffected.
    Factory(Box<Factory>),
    /// A terminal sink machine (Phase-5 EXEC seam). **Appended LAST** at the next
    /// discriminant after `Factory` (so `Factory` stays at 6 and `Sink` takes 7) to
    /// preserve every existing discriminant — see the type-level ordering note.
    /// Unboxed: [`Sink`] is small (a `SinkTemplate` plus a `u64`), far smaller than
    /// the boxed `Factory`, so it does not grow the enum. The snapshot version is
    /// deliberately NOT bumped: a grid that contains no `Sink` serializes
    /// byte-identically to before this append (every earlier variant is unshifted),
    /// so the frozen golden corpus stays literally unchanged.
    Sink(Sink),
    /// A request/response transport wire (Phase-37 WIRE seam). **Appended LAST**
    /// at discriminant 8 (so `Sink` stays at 7) to preserve every existing
    /// discriminant — see the type-level ordering note. Unboxed: [`WireLink`] is
    /// tiny (two `(NodeId, PortId)` pairs), far smaller than the boxed `Factory`,
    /// so it does not grow the enum. The snapshot version is deliberately NOT
    /// bumped: a grid that contains no `Wire` serializes byte-identically to
    /// before this append, so the frozen golden corpus stays literally unchanged.
    /// Carrying live traffic since Phase 37, and drawable by the user since Phase 63 —
    /// a forged snapshot carrying this discriminant still restores and steps to a typed
    /// no-op, never a panic (SCHEMA-03).
    Wire(WireLink),
    /// A host-bridge endpoint (Phase-38 ENDPOINT seam). **Appended LAST** at the
    /// next discriminant after `Wire` (so `Wire` stays at 8 and `Endpoint` takes 9)
    /// to preserve every existing discriminant — see the type-level ordering note.
    /// Unboxed: [`Endpoint`] is one `String`, so it does not meaningfully grow the enum.
    ///
    /// THE CLAIM THAT USED TO STAND HERE IS FALSE FROM 72-07 and is DELETED rather than
    /// quoted back. It said the payload had no fields, that the snapshot version was
    /// therefore deliberately not bumped, and that the frozen golden corpus stayed
    /// literally unchanged. The `path` field (SERVE-08, D-12) makes a grid that CONTAINS
    /// an endpoint serialize differently, and the golden corpus DOES move. That move is
    /// declared, and `SNAPSHOT_SCHEMA_VERSION` is owed a bump which plan 72-12 takes in
    /// one commit together with the re-bless (R-2 / R-74). A grid with NO endpoint on it
    /// is still byte-identical, which is the narrower claim that survives.
    /// Live
    /// since Phase 38, with its behaviour host-side rather than in the core step, and
    /// mintable by the fold since 63-04 — a forged snapshot carrying this discriminant
    /// still restores and steps to a typed no-op, never a panic (SCHEMA-03).
    Endpoint(Endpoint),
    /// A note on the board (phase 76, SHAPE-10). **Appended LAST** at discriminant 10, so
    /// `Endpoint` stays at 9 - see the type-level ordering note. A grid that holds no label
    /// serializes byte-identically to one built before this append, so no snapshot bump
    /// is owed and the frozen golden corpus stays literally unchanged (D-02). It is minted
    /// by `fold_place` from `machine_kind` byte 11 through [`GridState::add_label`], draws
    /// no random number, has an inbox and no ports, and its step is a typed no-op: a forged
    /// snapshot carrying this discriminant restores and steps to nothing, never a panic
    /// (SCHEMA-03).
    Label(Label),
}

// ───────────────────────── Spatial footprint primitives (FOOT-02) ─────────────────────────
//
// Plain-data spatial types + the two verified closed-form rotation helpers
// (`cells_of_footprint`, `port_world`) derived in 10-RESEARCH §The Rotation
// Spike. These are PURE integer functions — the ONE shared primitive every
// later Phase-10 plan (validate, fold, rebuild, trust gate, dock) reuses, so
// validate and fold can never diverge on rotation. They touch NO `GridState`
// field, NO `EditOp`, and NO schema version: the wire format and golden corpus
// are byte-for-byte unchanged by this plan. All math is `i32` — no `f32`/`f64`
// and no trig (clippy hard-denies floats in the sim).

/// The four orthogonal sides of a cell, ordered clockwise `N=0, E=1, S=2, W=3`
/// so a 90° CW quarter-turn is simply `(side + rot) & 3`. The numeric order is
/// load-bearing for the rotation closed-form and must not be reordered.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum Side {
    /// North — the `(0, -1)` direction on the pinned y-down axis (Assumption A4).
    #[default]
    N = 0,
    /// East — `(+1, 0)`.
    E = 1,
    /// South — `(0, +1)`.
    S = 2,
    /// West — `(-1, 0)`.
    W = 3,
}

impl From<u8> for Side {
    /// Maps any byte to a `Side` via `n & 3`, so rotation arithmetic
    /// `(side + rot) & 3` is total and overflow-free (no invalid `Side` exists).
    fn from(n: u8) -> Self {
        match n & 3 {
            0 => Side::N,
            1 => Side::E,
            2 => Side::S,
            _ => Side::W,
        }
    }
}

/// Whether a port consumes (`In`), produces (`Out`), or emits errors (`Fault`).
/// Identity-stable under rotation — only a port's world-cell and world-side move,
/// never its role.
///
/// **Variant order is load-bearing (appended LAST discipline).** Postcard encodes a
/// fieldless enum as a varint of the DECLARATION index, so `In = 0` and `Out = 1`
/// must never be reordered — every already-serialized `Port` carrying `In`/`Out`
/// stays byte-identical across this evolution. `Fault` is appended LAST at index 2
/// (byte-additive: it introduces no new bytes for existing `In`/`Out` ports — the
/// SNAPSHOT 6→7 bump is therefore policy-driven, not byte-forced by `Fault`; 17-RESEARCH A4).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum Role {
    /// An input port — sink end of a dock. Declaration index `0`.
    #[default]
    In,
    /// An output port — source end of a dock. Declaration index `1`.
    Out,
    /// A fault-emitter port — an OUTPUT role: errors are emitted OUT of it (behaves
    /// like [`Role::Out`] for docking — a belt may dock in the OFFLOAD direction to
    /// carry faults away; a belt never flows IN). Its routing identity reconciles to
    /// the reserved `FAULT_PORT = u16::MAX` sentinel (that reconciliation lands in
    /// 17-04; here the variant is only DECLARED). Appended LAST at declaration index
    /// `2`, so under the ROUTE-06 `(role/port_index asc)` ordering it sorts LAST.
    Fault,
}

/// The transport MEDIUM a [`Port`] speaks — belt/item transport (`Mechanical`) or
/// the Phase-37 request/response WIRE (`Electrical`). The SOLE genuine byte-forcer
/// of the v6.0 re-bless: appending `medium` to [`Port`] grows every already-stored
/// port by one varint, forcing the coordinated SNAPSHOT+EDIT re-bless (35-RESEARCH).
///
/// **Variant order is load-bearing (appended-LAST discipline).** postcard encodes a
/// fieldless enum as a varint of the DECLARATION index, so `Mechanical = 0` (the
/// [`#[default]`](Default)) and `Electrical = 1` must never be reordered. Default =
/// `Mechanical` so every port that existed before this field keeps belt semantics
/// once the field is byte-forced on. A THIRD medium (the deferred waiting-room the
/// wire's request/response pairing needs) appends LAST at discriminant `2` with NO
/// further version bump — the shape is designed so no future byte change is required.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum Medium {
    /// Belt / item transport — the classic conveyor medium. Declaration index `0`,
    /// the [`#[default]`](Default): every pre-`medium` port decodes as `Mechanical`.
    #[default]
    Mechanical,
    /// The Phase-37 request/response WIRE medium — electrical request/reply transport.
    /// Declaration index `1`. Live: `mediums_compatible` decides every dock and every
    /// drawn wire against it.
    Electrical,
}

/// The HTTP verb a [`SinkTemplate::Http`]/[`Effect::Http`] dispatches — completing the
/// CFG-01 "HTTP + method" surface end-to-end (config -> sink template -> effect ->
/// host). Threaded in 35-03 so Phase 39 needed no second schema bump, and dispatched as
/// the actual verb since Phase 39 (`executor.rs` passes it to `dispatch_http`).
///
/// **Variant order is load-bearing (appended-LAST discipline).** postcard encodes a
/// fieldless enum as a varint of the DECLARATION index, so `Get = 0`, `Post = 1`
/// (the [`#[default]`](Default)), `Put = 2`, `Patch = 3`, `Delete = 4` must never be
/// reordered. Default = `Post` (the classic webhook verb) so an [`Effect::Http`] that
/// existed before this field keeps POST semantics once the field is byte-forced on.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum HttpMethod {
    /// HTTP GET. Declaration index `0`.
    Get,
    /// HTTP POST — the [`#[default]`](Default) webhook verb. Declaration index `1`.
    #[default]
    Post,
    /// HTTP PUT. Declaration index `2`.
    Put,
    /// HTTP PATCH. Declaration index `3`.
    Patch,
    /// HTTP DELETE. Declaration index `4`.
    Delete,
}

/// A machine port declared in the **rot-0 frame**: `local_offset (x, y)` with
/// `0 ≤ x < w`, `0 ≤ y < h`; `side` is the cell edge it faces; `role` its
/// direction. Its world position under a rotation comes from [`port_world`];
/// the `(node, port)` identity itself never re-numbers (the anchor-preserving
/// decision: "port 5 stays port 5").
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Port {
    /// Position inside the rot-0 box, `0 ≤ x < w`, `0 ≤ y < h`.
    pub local_offset: (i32, i32),
    /// The cell edge this port faces in the rot-0 frame.
    pub side: Side,
    /// Whether the port is an input or an output.
    pub role: Role,
    /// The transport MEDIUM this port speaks (belt vs WIRE). **Appended LAST** (the
    /// v6.0 byte-forcer): every already-stored port grows by one varint, forcing the
    /// coordinated SNAPSHOT+EDIT re-bless. Default [`Medium::Mechanical`] preserves
    /// belt semantics for every pre-`medium` port.
    pub medium: Medium,
}

/// A machine's rectangular footprint: declared dims `(w, h)` in the rot-0 frame
/// plus `rot ∈ {0,1,2,3}` (number of 90° CW quarter-turns). The *effective box*
/// swaps to `(h, w)` on odd `rot`; the anchor (min-corner) is fixed across
/// rotation (the CONTEXT anchor-preserving-pivot rule).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Footprint {
    /// Width in the rot-0 frame.
    pub w: u16,
    /// Height in the rot-0 frame.
    pub h: u16,
    /// Orientation: number of 90° clockwise quarter-turns, `0..=3`.
    pub rot: u8,
}

/// The rectangular-footprint dimension cap (per axis). With `0 ≤ x,y < dim` and
/// `dim ≤ MAX_FOOTPRINT_DIM`, the `h-1-y` / `w-1-x` rotation terms never
/// underflow and world cells (`anchor ∈ [-512, 512]` + a sub-`MAX` local) stay
/// far from `i32` limits — keeping the rotation arithmetic overflow-free
/// (FOOT-02 / 10-RESEARCH §overflow safety).
pub const MAX_FOOTPRINT_DIM: u16 = 64;

/// The box a placed Label takes (phase 76, UI-SPEC U-2): 4 cells wide, 1 deep, rot 0. Four
/// cells hold about fourteen characters on one line at zoom 1. Read by [`base_footprint`]
/// AND by `fabrico_command::port_catalog(LABEL)`, so the in-core floor and the catalog's
/// mint dims are one value rather than two that agree.
pub const LABEL_PLACED_FOOTPRINT: Footprint = Footprint { w: 4, h: 1, rot: 0 };

/// The inclusive upper grid extent (per axis) a decoded `cells` anchor may occupy —
/// the deterministic-core mirror of the command layer's `GRID_MAX` (CR-02). The
/// spatial model now lives in the core, so the trust gate
/// ([`crate::snapshot::restore`]) bounds every decoded anchor to `[GRID_MIN, GRID_MAX]`
/// on both axes. Paired with the [`MAX_FOOTPRINT_DIM`] cap this makes the
/// `anchor + (dim-1)` arithmetic in [`cells_of_footprint`]/[`port_world`] provably
/// overflow-free: `GRID_MAX + MAX_FOOTPRINT_DIM` is far inside `i32`. A live grid
/// never exceeds this (placement is bounds-checked at the command layer), so a valid
/// snapshot round-trips byte-identically.
pub const GRID_MAX: i32 = 512;
/// The inclusive lower grid extent (per axis) — see [`GRID_MAX`].
pub const GRID_MIN: i32 = -512;

/// The unit step toward `side` on the pinned **y-down** axis convention
/// (Assumption A4, golden-tested in 10-04 dock validation): `N=(0,-1)`,
/// `E=(+1,0)`, `S=(0,+1)`, `W=(-1,0)`. Adding this to a port's world-cell yields
/// the adjacent cell a dock must face.
pub fn unit_delta(side: Side) -> (i32, i32) {
    match side {
        Side::N => (0, -1),
        Side::E => (1, 0),
        Side::S => (0, 1),
        Side::W => (-1, 0),
    }
}

/// The side directly opposite `side`: `(s + 2) & 3`. It no longer states a dock rule:
/// since phase 74.1 a belt end docked to a port may leave it straight (outward opposite
/// the port side) or turn at its facing cell (outward perpendicular); only an outward
/// EQUAL to the port side is refused (`GridState::dock_still_reaches`, D-02).
pub fn opposite(side: Side) -> Side {
    Side::from(side as u8 + 2)
}

/// The exact inverse of [`unit_delta`]: the [`Side`] a one-cell orthogonal step
/// points at, or `None` for any other vector (a zero step, a diagonal, a
/// multi-cell jump). Total and non-panicking, so a FORGED belt geometry whose
/// tiles are not orthogonally contiguous answers `None` rather than being
/// coerced into a side.
///
/// Lived as a private `side_of_unit_delta` in `fabrico-command` until Phase 74.
/// It moved here so [`belt_end_world`] below can answer in SIDES rather than in
/// raw deltas, which is what let the two byte-parallel belt-end derivations
/// collapse into one definition (LINK-11).
pub fn side_of_unit_delta(d: (i32, i32)) -> Option<Side> {
    match d {
        (0, -1) => Some(Side::N),
        (1, 0) => Some(Side::E),
        (0, 1) => Some(Side::S),
        (-1, 0) => Some(Side::W),
        _ => None,
    }
}

/// THE TWO PORT RECORDS EVERY BELT DECLARES (Phase 74, LINK-08 clause (ii), D-06):
/// one definition, so the mint path and any future re-mint path cannot disagree.
///
/// # IN FIRST IS A CONTRACT, NOT A CONVENTION
/// `fabrico_command`'s port catalog warns in its own words that an `Out` declared
/// before an `In` MIS-KEYS EVERY HEAD DOCK INTO THE WRONG INBOX, because a Head dock
/// key is the RAW catalog index while a Tail dock key is an `Out`-filtered routing
/// index. Tail (`Role::In`, the admit end) is therefore index 0 and Head
/// (`Role::Out`, the deliver end) is index 1, and the order is derived from the belt's
/// flow direction rather than from any map walk. The catalog parity sweep in
/// `fabrico-command` structurally CANNOT see this: its `CATALOG_KINDS` list has nine
/// entries and BELT is deliberately absent, and BELT's own catalog arm is `vec![]`.
/// An Out-first belt would ship with every existing test green, which is why the
/// ordering carries its own case in this crate.
///
/// # Both offsets are `(0, 0)`, and that is the ONLY legal choice
/// Trust-gate invariant 7 (`crate::snapshot`) requires every port's `local_offset` to
/// lie within `[0,w) x [0,h)` of its node's rot-0 footprint box, and an ABSENT
/// footprint defaults to `1x1`. A belt records no footprint, so `(0, 0)` is the only
/// offset that decodes. Two ports on one cell is precedented: the ENDPOINT catalog arm
/// ships exactly that shape.
///
/// # `side` is `Side::default()`, and that is a decision rather than a placeholder
/// A belt end's real outward side is a pure function of its `geometry` and is answered
/// by [`belt_end_world`]. Copying that answer onto the stored `Port` would create a
/// SECOND source of truth for it (the failure class this phase exists to retire), and
/// it is not even computable here: `add_belt` mints a belt BEFORE its geometry is set,
/// and a `Wire`-minted belt never gets geometry at all. Nothing reads a belt port's
/// `side`: the dock path asks [`belt_end_world`], and the trust gate bounds
/// `local_offset` only. So the field carries the type's own default and the resolver
/// carries the meaning.
#[must_use]
pub fn belt_ports() -> Vec<Port> {
    vec![
        // Index 0: the TAIL, where items are admitted. `Role::In`.
        Port {
            local_offset: (0, 0),
            side: Side::default(),
            role: Role::In,
            medium: Medium::Mechanical,
        },
        // Index 1: the HEAD, where items are delivered. `Role::Out`.
        Port {
            local_offset: (0, 0),
            side: Side::default(),
            role: Role::Out,
            medium: Medium::Mechanical,
        },
    ]
}

/// THE ONE DEFINITION of a drawn belt's end: the world cell of the `end` tile plus
/// the OUTWARD side at that end (LINK-11). The belt analog of [`port_world`], and
/// the same shape: pure, takes the pieces, returns `(cell, side)`, touches no
/// `GridState` field and no schema version.
///
/// # Why this exists as ONE `pub fn`
/// Until Phase 74 this derivation was written out TWICE, byte for byte: once in
/// [`GridState::dock_still_reaches`] and once in the `GridCommand::Dock` validate
/// arm in `fabrico-command`. One of the two even commented itself as a mirror of
/// the other, citing a line number that had since rotted. Two copies of the rule
/// that decides whether a dock reaches is exactly the second-source-of-truth
/// failure this repository has named before; from Phase 74 there is one copy and
/// the callers name it.
///
/// # The reading, and every answer it can give
/// Belt flow runs TAIL (first tile) to HEAD (last tile). The OUTWARD step at an end
/// is `end_cell - inner_neighbour`: a HEAD continues the final flow away from the
/// belt, a TAIL points back the way the items came. So:
///
/// - EMPTY geometry (a `Wire`-minted belt) has no spatial end at all → `None`.
/// - A SINGLE-TILE belt has an end cell but no inner neighbour and therefore no
///   inherent direction → `Some((cell, None))`. Adjacency alone must decide for it.
/// - A MULTI-TILE belt answers `Some((cell, Some(side)))`.
/// - A belt whose end tile and its inner neighbour are NOT one orthogonal step
///   apart is not a shape the validated fold can build; it can only arrive from
///   forged bytes, and it answers `None` so every caller refuses it. That is the
///   same answer both pre-collapse copies gave (each ran the raw delta through a
///   unit-step check that failed), so the collapse moved no behaviour.
///
/// Pure `i32`; no `f32`/`f64` and no trig.
pub fn belt_end_world(
    geometry: &[BeltTile],
    end: crate::edit::BeltEnd,
) -> Option<((i32, i32), Option<Side>)> {
    let (end_cell, inner) = match end {
        crate::edit::BeltEnd::Head => {
            let last = geometry.last()?.cell;
            // `len - 2` is the tile BEFORE the head; `checked_sub` is what makes a
            // single-tile belt (len 1) answer "no inner neighbour" instead of wrapping.
            let inner = geometry.len().checked_sub(2).map(|i| geometry[i].cell);
            (last, inner)
        }
        crate::edit::BeltEnd::Tail => {
            let first = geometry.first()?.cell;
            let inner = geometry.get(1).map(|t| t.cell);
            (first, inner)
        }
    };
    match inner {
        None => Some((end_cell, None)),
        Some(i) => {
            let side = side_of_unit_delta((end_cell.0 - i.0, end_cell.1 - i.1))?;
            Some((end_cell, Some(side)))
        }
    }
}

/// The flow [`Dir`] that points the same way as the cell edge `side`. The two enums share
/// one numeric order (`N=0, E=1, S=2, W=3`) and one y-down meaning, but they name different
/// things ([`Side`] is an edge a port faces, [`Dir`] is the way items travel), so the
/// conversion is an explicit match and never a cast: a reorder of either enum is then a
/// compile-visible change here rather than a silent re-meaning.
pub fn dir_toward(side: Side) -> Dir {
    match side {
        Side::N => Dir::N,
        Side::E => Dir::E,
        Side::S => Dir::S,
        Side::W => Dir::W,
    }
}

/// The run axis a flow along `d` travels: N/S on [`Axis::Y`], E/W on [`Axis::X`].
fn travel_axis(d: Dir) -> Axis {
    match d {
        Dir::N | Dir::S => Axis::Y,
        Dir::E | Dir::W => Axis::X,
    }
}

/// The flow directly against `d`.
fn reverse_dir(d: Dir) -> Dir {
    match d {
        Dir::N => Dir::S,
        Dir::E => Dir::W,
        Dir::S => Dir::N,
        Dir::W => Dir::E,
    }
}

/// THE SEAM TABLE (phase 74.1 gap closure, 74.1-SEAM-DESIGN.md section 2): the kind a
/// docked belt END tile is DRAWN as, given what the seams at that end say.
///
/// - `stored` is the end tile's authored kind, the one `route()` typed at DrawBelt.
/// - `own_in` / `own_out` are the belt's OWN in- and out-direction at this tile, from its
///   own cells: for a multi-tile belt both are the step between the end tile and its inner
///   neighbour (`Some(d)`); a single-tile belt has no own direction (`None`, `None`).
/// - `feeds` are the flows arriving into the tile from every partner linked onto the
///   belt's Tail, in ascending link-key order (empty at a Head end).
/// - `drain` is the flow leaving the tile into the partner the belt's Head is linked to
///   (`None` at a Tail end, or when nothing is linked).
///
/// The entry `e` is the single feed when there is exactly one, else `own_in`; the exit `x`
/// is the drain when there is one, else `own_out`. A single tile with one seam takes that
/// seam for both. Then:
///
/// - `e == x` on a SINGLE tile (no own direction on either side): the zero-turn
///   [`TileKind::Corner`] `{ from: e, to: e }` (phase 89, BELT-10, D-15). A straight
///   carries only an axis, so a one-tile belt flowing West or North would be drawn
///   flowing East or South; the zero-turn corner keeps the flow direction, and the
///   renderers draw a corner whose ends agree as a straight running along `from`;
/// - `e == x` on a multi-tile end: [`TileKind::Straight`] on that axis (its own cells
///   already say which way it runs);
/// - `e` perpendicular to `x`: [`TileKind::Corner`] `{ from: e, to: x }`;
/// - every other case keeps `stored`: no seam at all; a fan-in of two or more feeds (a
///   straight feed plus a side feed is a side-load, two side feeds are a merge, so the
///   answer never depends on which link key sorts first); and a reversing feed, which only
///   a forged log can hold.
///
/// THE RESULT IS NEVER STORED. It is derived on every read by
/// [`GridState::effective_belt_tiles`]; the fold, the snapshot, the edit log and the state
/// hash keep `route()`'s authored kind, which is why this table moves no replay byte. Pure,
/// integer-only, allocation-free.
pub fn seam_end_kind(
    stored: TileKind,
    own_in: Option<Dir>,
    own_out: Option<Dir>,
    feeds: &[Dir],
    drain: Option<Dir>,
) -> TileKind {
    // A fan-in keeps the authored kind whatever the feeds' order (side-load or merge).
    if feeds.len() >= 2 {
        return stored;
    }
    let feed = feeds.first().copied();
    // No seam at this tile: nothing to derive.
    if feed.is_none() && drain.is_none() {
        return stored;
    }
    let (e, x) = match (feed.or(own_in), drain.or(own_out)) {
        (Some(e), Some(x)) => (e, x),
        // A single tile with exactly one seam: that seam is both its entry and its exit.
        (Some(e), None) => (e, e),
        (None, Some(x)) => (x, x),
        (None, None) => return stored,
    };
    if e == x && own_in.is_none() && own_out.is_none() {
        // A single tile keeps its flow direction (D-15): a zero-turn corner, not a bare axis.
        TileKind::Corner { from: e, to: e }
    } else if e == x {
        TileKind::Straight {
            axis: travel_axis(e),
        }
    } else if e == reverse_dir(x) {
        // A reversing seam: no command builds it, so it is never drawn as anything new.
        stored
    } else {
        TileKind::Corner { from: e, to: x }
    }
}

/// The EFFECTIVE BOX of a footprint: `(w, h)` when `rot` is even, `(h, w)` when odd.
///
/// # THE SINGLE SOURCE OF THE SWAP PARITY IN THIS LANGUAGE
/// The TypeScript analogue is `frontend/src/protocol/footprint.ts::effectiveBox`, and it
/// has been the sole owner of the swap on that side since it was written: `cellsOfFootprint`
/// and the renderer's multi-cell body rect both derive their extent from it. Rust had no
/// such owner. Until 2026-09-04 (phase 72 review WR-01) the swap was written out twice -
/// here inside [`cells_of_footprint`], and again in `fabrico-host`'s `resolve_wire_dock`,
/// whose docblock described its copy as "copied verbatim from core `cells_of_footprint`",
/// which is an accurate description of a duplication and not of a shared source.
///
/// WHY THAT DUPLICATION WAS THE DANGEROUS KIND. `wire_route.rs`'s `WireBody` docblock
/// records the design reason the wire router is handed a RESOLVED rectangle rather than
/// `{w, h, rot}`: a `rot` decode at a call site is a drift surface the cross-language
/// parity corpus structurally CANNOT see, because the corpus supplies resolved rectangles
/// as literal numbers. A transposition in the host's copy would change every rotated
/// multi-cell machine's cable shape, pass all 3920 corpus rows, pass `wire_golden.rs`
/// (`rot: 0`, swap-invariant), and surface only as a wrong-looking cable on a rotated
/// Handler. TypeScript was gated for exactly that (`gestures.test.ts` counts occurrences of
/// the raw decode in the gesture layer and requires zero); Rust was not.
///
/// Returns `i32` because every caller wants signed cell arithmetic immediately.
#[must_use]
pub fn effective_box(w: u16, h: u16, rot: u8) -> (i32, i32) {
    if rot & 1 == 0 {
        (i32::from(w), i32::from(h))
    } else {
        (i32::from(h), i32::from(w))
    }
}

/// Expand a footprint into its occupied world cells — the one shared primitive
/// reused by validate, fold, rebuild, and the trust gate.
///
/// The effective box `(W, H)` is `(w, h)` when `rot` is even and `(h, w)` when
/// odd (dim swap), anchored at the fixed min-corner. Yields exactly `W*H` cells
/// `{ (ax+i, ay+j) | 0 ≤ i < W, 0 ≤ j < H }` in row-major (`j` outer, `i` inner)
/// deterministic order. A 1×1 footprint yields its single anchor cell for every
/// `rot`. Body cells are regenerated from the box — never rotated individually.
pub fn cells_of_footprint(
    anchor: (i32, i32),
    w: u16,
    h: u16,
    rot: u8,
) -> impl Iterator<Item = (i32, i32)> {
    // THE SWAP IS NOT WRITTEN HERE. [`effective_box`] owns it for this language; see its
    // docblock for why a second copy at a call site is the drift surface the parity corpus
    // cannot see. Byte-identical to the expression this replaced.
    let (we, he) = effective_box(w, h, rot);
    // CR-02: compute `anchor + offset` in `i64` and drop any cell that does not fit
    // `i32`, so an untrusted `anchor` near `i32::MAX` on the `rebuild_occupancy` decode
    // path can never overflow-panic (debug) / wrap (release). For every VALID input
    // (anchor in `[GRID_MIN, GRID_MAX]`, dims `<= MAX_FOOTPRINT_DIM`) every sum fits,
    // so the yielded cells — and their order — are byte-identical to the prior `i32`
    // arithmetic (no corpus drift). This is the defensive second line behind the trust
    // gate's anchor bound; together they make the expansion total over forged bytes.
    let (ax, ay) = (i64::from(anchor.0), i64::from(anchor.1));
    (0..he).flat_map(move |j| {
        (0..we).filter_map(move |i| {
            let x = i32::try_from(ax + i64::from(i)).ok()?;
            let y = i32::try_from(ay + i64::from(j)).ok()?;
            Some((x, y))
        })
    })
}

/// Map a rot-0 port to its world cell + world side under `rot`, via the verified
/// closed-form table (10-RESEARCH §The Rotation Spike).
///
/// Local offset transform per CW quarter-turn count:
/// `rot0:(x,y)`, `rot1:(h-1-y, x)`, `rot2:(w-1-x, h-1-y)`, `rot3:(y, w-1-x)`;
/// world cell = `anchor + local`; world side = `(side + rot) & 3`. Applying
/// `rot=1` four times returns the original local offset, side AND box —
/// `rotate90⁴ == identity`. Pure `i32`; no `f32`/`f64`/trig.
pub fn port_world(
    anchor: (i32, i32),
    w: u16,
    h: u16,
    rot: u8,
    p: &Port,
) -> ((i32, i32), Side) {
    let (x, y) = p.local_offset;
    let (w, h) = (i32::from(w), i32::from(h));
    let (lx, ly) = match rot & 3 {
        0 => (x, y),
        1 => (h - 1 - y, x),
        2 => (w - 1 - x, h - 1 - y),
        _ => (y, w - 1 - x), // rot 3
    };
    (
        (anchor.0 + lx, anchor.1 + ly),
        Side::from(p.side as u8 + rot),
    )
}

/// The per-kind FLOOR [`Footprint`] a port-edited machine can never shrink below —
/// the SINGLE in-core authority for an operator's seeded base (PORT-07). Hard-coded
/// to EVERY operator's TRUE frozen base so [`grow_to_fit`] can clamp a port-driven
/// resize to it: Source/Sink `1×1`, Factory `3×3`, Tee/Balancer/Merge `2×2`, Router
/// `2×3` — byte-for-byte the dims [`fabrico_command::command::port_catalog`] mints
/// at `Place` (a `fabrico-command` parity test in plan 02 asserts that equality).
///
/// # No `{1,1,0}` catch-all (the FOOT-05 / determinism guard)
/// The match is EXHAUSTIVE — every `Node` variant names its own base explicitly, so a
/// future variant is a compile error here, NOT a silent `1×1` that would shrink a
/// deliberately-non-minimal frozen base (Tee/Balancer/Merge `2×2`, Factory `3×3`)
/// below its keep-current-dims size. That silent shrink was the milestone's top risk;
/// this fn refuses it structurally. A BELT DOES CARRY PORTS from phase 74 (two of them,
/// Tail then Head, on every belt including a geometry-empty one - see [`belt_ports`]),
/// but it is still never port-edited and its base is still not derived from them, which
/// is why its arm returns a flat `1x1` rather than a `grow_to_fit`. Until LINK-12 this
/// paragraph asserted BOTH halves of that in the present tense; plan 74-02 falsified the
/// first half and left the second standing, and the sentence was corrected rather than
/// deleted so the reason the arm is flat survives.
/// `Wire`/`Endpoint` carry no ports either — each returns its own `1×1` base, an
/// explicit arm, never a fallback. `rot` is always `0`: the frozen base is declared
/// in the rot-0 frame and the resize preserves it as the pure `grow_to_fit(base, ports)`
/// output (making undo exact in plan 02).
///
/// `pub` (widened from `pub(crate)` in 36-02) so the `fabrico-command` W1 base-parity
/// test can assert `base_footprint(node) == port_catalog(kind).0` for EVERY operator
/// kind — the covering test that pins the in-core FLOOR to the command catalog and
/// forbids drift (FOOT-05). Pure function, no serialized shape: widening is byte-inert.
pub fn base_footprint(node: &Node) -> Footprint {
    match node {
        Node::Source(_) => Footprint { w: 1, h: 1, rot: 0 },
        Node::Sink(_) => Footprint { w: 1, h: 1, rot: 0 },
        Node::Factory(_) => Footprint { w: 3, h: 3, rot: 0 },
        Node::Tee(_) => Footprint { w: 2, h: 2, rot: 0 },
        Node::Balancer(_) => Footprint { w: 2, h: 2, rot: 0 },
        Node::Merge(_) => Footprint { w: 2, h: 2, rot: 0 },
        Node::Router(_) => Footprint { w: 2, h: 3, rot: 0 },
        // Port-less kinds: each names its OWN frozen base (1×1) — an explicit arm,
        // never a catch-all that could shrink a non-minimal base.
        Node::Belt(_) => Footprint { w: 1, h: 1, rot: 0 },
        Node::Wire(_) => Footprint { w: 1, h: 1, rot: 0 },
        Node::Endpoint(_) => Footprint { w: 1, h: 1, rot: 0 },
        // A label is placed 4 by 1 (UI-SPEC U-2). The ONE constant the command catalog
        // reads too, so the W1 base-parity test holds by construction.
        Node::Label(_) => LABEL_PLACED_FOOTPRINT,
    }
}

/// The SMALLEST role-edge rectangle that fits `ports`, floored component-wise to
/// `base` (never below) with `rot` preserved from `base`: the box of a FRESH layout
/// (PORT-07), which `router_preset_ports` and the catalog pins read.
///
/// # Port edits no longer apply it (plan 74.1-16)
/// Until 74.1-16 this was the footprint every port-edit fold wrote, so a removal shrank
/// the box back to fit and a grown box kept its anchor. Since the design ruling of 2026-10-04
/// a removal never shrinks the machine and an add grows it only as far as its slots need
/// on its far edges ([`add_port_geometry`]); on a hole-free list the two boxes agree.
///
/// # The min-rect rule (rot-0 frame, pure `i32`)
/// Ports live on role edges: `In` on the W column, `Out` on the E column, `Fault` on
/// the S row (see [`reseat_ports`], which seats them centre-out from the catalog box, so
/// the box this fn returns for a catalog port list is the catalog box). With `n_in`/`n_out`/`n_fault` the role counts:
/// - `min_h = max(1, n_in, n_out)` — In and Out stack down their columns.
/// - `vertical_cols = (n_in>0) + (n_out>0)` — the In and/or Out columns needed.
/// - `min_w = max(1, vertical_cols, n_fault)` — Fault ports spread along the S row.
///
/// The result is `w = clamp(max(base.w, min_w))`, `h = clamp(max(base.h, min_h))`,
/// each clamped UP by the base FLOOR and DOWN by [`MAX_FOOTPRINT_DIM`].
///
/// # Totality + determinism (threat T-36-01)
/// Any [`Port`] multiset returns without panic: every count is accumulated in `i64`
/// and the result SATURATES at [`MAX_FOOTPRINT_DIM`] = 64, so a forged multi-thousand-
/// port load can never overflow `u16` nor make [`cells_of_footprint`] wrap/OOM (it
/// mirrors that fn's `i64`+`try_from` discipline). Purity: no `f32`/`f64`/trig, no
/// `HashMap`; `ports` is walked in list order, so the same input always yields the
/// same output. Idempotent on a preset seed: for the Router base `{2,3,0}` and a
/// 1-in/2-out seed, `grow_to_fit == {2,3,0}` — it grows past `2×3` only above 3
/// outputs and NEVER shrinks below the `2×3` floor.
pub fn grow_to_fit(base: Footprint, ports: &[Port]) -> Footprint {
    // Role counts in i64 (a forged over-cap arity cannot overflow the accumulator).
    let mut n_in: i64 = 0;
    let mut n_out: i64 = 0;
    let mut n_fault: i64 = 0;
    for p in ports {
        match p.role {
            Role::In => n_in += 1,
            Role::Out => n_out += 1,
            Role::Fault => n_fault += 1,
        }
    }
    // Min-rect: In/Out stack down their columns; the vertical columns + fault row set
    // the width.
    let min_h = n_in.max(n_out).max(1);
    let vertical_cols = i64::from(n_in > 0) + i64::from(n_out > 0);
    let min_w = vertical_cols.max(n_fault).max(1);
    // Clamp UP by the per-kind base FLOOR, DOWN by MAX_FOOTPRINT_DIM (saturate).
    let cap = i64::from(MAX_FOOTPRINT_DIM);
    let w = i64::from(base.w).max(min_w).min(cap);
    let h = i64::from(base.h).max(min_h).min(cap);
    // Both are in `[1, MAX_FOOTPRINT_DIM]`, so the `as u16` casts never truncate.
    Footprint {
        w: w as u16,
        h: h as u16,
        rot: base.rot,
    }
}

/// The slot the `k`-th port of a role takes on a side whose CATALOG length is
/// `base_len` (CORNER-06, plan 74.1-14): the centre first, then alternately the slot
/// below and the slot above it until the side is used, then `k` itself.
///
/// With `c = (base_len - 1) / 2` (integer division):
/// - `k = 0` takes `c`;
/// - for `1 <= k <= 2c`, an odd `k` takes `c + (k + 1) / 2` and an even `k` takes
///   `c - k / 2`;
/// - every `k > 2c` takes `k`.
///
/// On a 3-long side (`c = 1`) that is 1, 2, 0, then 3, 4, 5 and on: one port sits in the
/// middle, two take the middle and the slot below it, three fill the side, and a fourth
/// grows the box. On a 1- or 2-long side (`c = 0`) every `k` takes `k`, which is exactly
/// the index rule this replaced. Pure `i32`, no float. Total: a `base_len` of 0 (no real
/// footprint has one) gives `c = 0` and the index rule.
#[must_use]
pub fn role_slot(k: i32, base_len: u16) -> i32 {
    let c = (i32::from(base_len) - 1) / 2;
    if k == 0 {
        c
    } else if k <= 2 * c {
        if k % 2 == 1 { c + (k + 1) / 2 } else { c - k / 2 }
    } else {
        k
    }
}

/// Recompute each port's `local_offset` + `side` as a PURE function of its list
/// position, for a `w x h` rot-0 box whose CATALOG box is `base` (PORT-07, CORNER-06).
///
/// # The rule ("Edits keep middle layout")
/// A port's slot is decided ONLY by its role, its 0-based index `k` AMONG ITS ROLE in
/// list order, and the length of its side of the CATALOG box, through [`role_slot`]:
/// - `In_k`    -> `(0, role_slot(k, base.h))` facing **W** (the input column).
/// - `Out_k`   -> `(w - 1, role_slot(k, base.h))` facing **E** (the output column).
/// - `Fault_k` -> `(min(role_slot(k, base.w), w - 1), h - 1)` facing **S** (the fault
///   row, x-clamped to the box).
///
/// `base`'s `rot` is ignored: `base` carries the per-kind rot-0 dims
/// ([`base_footprint`]), and `w`/`h` are the rot-0 dims of the box being seated.
///
/// # Why the centre comes from the catalog box, never the current one
/// A machine's catalog layout is a fixed point of this rule: `reseat_ports(base, catalog
/// box, catalog ports) == catalog ports` for every catalog arm. So the FIRST port edit on
/// a catalog-placed machine moves nothing, appending a port moves no existing In or Out,
/// and one undo puts every port back on its own cell. Growing a machine never re-centres
/// it: a 3-tall Factory grown to 5 keeps its first Out on row 1, where a centre taken
/// from the grown box would move it to row 2 and let go of its belt. On a 1- or 2-long
/// side the rule is the index rule it replaced, so the Tee, Balancer, Merge, Source,
/// Sink and Endpoint boards fold exactly as before; the Router's Fault row is 2 wide and
/// keeps its index slots too.
///
/// # The layouts, stated
/// On a 3-long side (the Factory, Handler and Router In/Out columns, the Factory and
/// Handler Fault row): one port takes the middle (slot 1); two take 1, 2; three take
/// 1, 2, 0; a fourth grows the box and takes 3, then 4, 5 and on.
///
/// # Why a centred symmetric spread was rejected
/// A spread that centres the whole group (two ports over three rows on rows 0 and 2)
/// moves the middle port the moment a second one is added, which is the defect the
/// layout rule exists to prevent: the first `+ Add output` would still move a belt off its nub.
///
/// # Beyond the side
/// Only a forged list past [`MAX_FOOTPRINT_DIM`], which the command layer refuses as
/// `OutOfBounds`, reaches past the saturated box. There an In or Out keeps the
/// out-of-box row `k` (the snapshot trust gate refuses it on load as
/// `PortOutOfFootprint`) and a Fault keeps the clamp to column `w - 1`. This fn stays
/// panic-free either way. For a box sized by [`grow_to_fit`] on the SAME ports every
/// slot lands inside it, because every slot is below `max(base side, role count)`.
///
/// # Port edits no longer call this (plan 74.1-16)
/// Until 74.1-16 every `AddPort` and `RemovePort` fold re-seated the WHOLE list through
/// this function, so removing the first of two outputs moved the second into its row and
/// let go of its belt. It was ruled on 2026-10-04 that a port edit moves no existing port
/// (existing ports are not auto-arranged), so both folds now go through
/// [`add_port_geometry`] and [`remove_port_geometry`], which keep every port's slot. This
/// function stays as the FRESH-layout rule: `router_preset_ports` seats a new Router with
/// it, and the catalog fixed-point pin (`reseat_ports_reproduces_every_catalog_arm_exactly`)
/// holds every catalog arm to it. On a hole-free list the two agree: seating a catalog
/// arm's ports one at a time with [`PortSeat::Auto`](crate::edit::PortSeat::Auto)
/// reproduces this function's layout (pinned in `reseat_catalog_layout.rs`).
///
/// Pure `i32`, no float/trig, walked in list order.
#[must_use]
pub fn reseat_ports(base: Footprint, w: u16, h: u16, ports: &[Port]) -> Vec<Port> {
    let wi = i32::from(w);
    let hi = i32::from(h);
    let mut k_in: i32 = 0;
    let mut k_out: i32 = 0;
    let mut k_fault: i32 = 0;
    ports
        .iter()
        .map(|p| {
            let (local_offset, side) = match p.role {
                Role::In => {
                    let o = (0, role_slot(k_in, base.h));
                    k_in += 1;
                    (o, Side::W)
                }
                Role::Out => {
                    let o = (wi - 1, role_slot(k_out, base.h));
                    k_out += 1;
                    (o, Side::E)
                }
                Role::Fault => {
                    let o = (role_slot(k_fault, base.w).min(wi - 1), hi - 1);
                    k_fault += 1;
                    (o, Side::S)
                }
            };
            Port {
                local_offset,
                side,
                role: p.role,
                medium: p.medium,
            }
        })
        .collect()
}

/// The SLOT a port holds along its role's edge (plan 74.1-16): its row for an In or an
/// Out (the W and E columns), its column for a Fault (the S row). The other coordinate is
/// the edge itself and is re-derived from the box by [`edge_port`].
#[must_use]
pub fn port_slot(p: &Port) -> i32 {
    match p.role {
        Role::In | Role::Out => p.local_offset.1,
        Role::Fault => p.local_offset.0,
    }
}

/// `p` placed on its role's edge of a rot-0 `w x h` box at its own slot: an In on column
/// 0 facing W, an Out on column `w - 1` facing E, a Fault on row `h - 1` facing S. The
/// slot along the edge is kept. Pure `i32`, saturating.
#[must_use]
fn edge_port(p: Port, w: u16, h: u16) -> Port {
    let slot = port_slot(&p);
    let (local_offset, side) = match p.role {
        Role::In => ((0, slot), Side::W),
        Role::Out => ((i32::from(w) - 1, slot), Side::E),
        Role::Fault => ((slot, i32::from(h) - 1), Side::S),
    };
    Port { local_offset, side, ..p }
}

/// The FIRST FREE slot of `role` on a machine whose catalog box is `base` (plan 74.1-16):
/// the first `role_slot(k, B)` for `k = 0, 1, 2, ...` that no port of `role` in `ports`
/// holds, with `B` the catalog side length (`base.h` for In and Out, `base.w` for Fault).
///
/// On an unedited catalog machine that is exactly the slot plan 74.1-14's centre-out
/// re-seat gave the next port (the first `n` values of `role_slot` are the slots of a
/// hole-free list of `n`), and after a removal it is the freed slot, so `+ Add output`
/// after removing the middle output fills the middle row. Integer only; the taken slots
/// are collected into a `BTreeSet` once, so a forged list costs `O(n log n)`, never a
/// quadratic scan, and the walk ends within `ports.len() + B + 1` steps because
/// `role_slot` gives `k` itself past `2c`.
#[must_use]
pub fn first_free_slot(base: Footprint, ports: &[Port], role: Role) -> i32 {
    let side_len = match role {
        Role::In | Role::Out => base.h,
        Role::Fault => base.w,
    };
    let taken: std::collections::BTreeSet<i32> =
        ports.iter().filter(|p| p.role == role).map(port_slot).collect();
    let mut k: i32 = 0;
    loop {
        let slot = role_slot(k, side_len);
        if !taken.contains(&slot) {
            return slot;
        }
        k = k.saturating_add(1);
        if k == i32::MAX {
            return k;
        }
    }
}

/// What a port edit writes: the anchor, the footprint and the port list, plus the rot-0
/// box BEFORE the [`MAX_FOOTPRINT_DIM`] clamp (plan 74.1-16).
///
/// One value, computed by ONE function per edit ([`add_port_geometry`] or
/// [`remove_port_geometry`]), read by the fold that writes it AND by the command layer's
/// `AddPort` validate arm that collision-checks it, so the box the command layer accepts
/// is byte for byte the box the fold claims (threat T-74.1-58).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PortEditGeometry {
    /// The anchor (min-corner world cell) the machine takes.
    pub anchor: (i32, i32),
    /// The footprint it takes, clamped to `[1, MAX_FOOTPRINT_DIM]`, its `rot` unchanged.
    pub footprint: Footprint,
    /// The port list, every port on its role's edge of the new box.
    pub ports: Vec<Port>,
    /// The rot-0 `(w, h)` the slots need before the clamp. The `AddPort` validate arm
    /// refuses an add whose unclamped box passes the cap, because the clamped box would
    /// leave a port outside it (the snapshot `PortOutOfFootprint` refusal on load).
    pub unclamped: (i64, i64),
}

/// The geometry an `AddPort` writes (plan 74.1-16, CORNER-06, design ruling N5 of
/// 2026-10-04 and review WR-01): NO EXISTING PORT MOVES OFF ITS SLOT, and the box grows
/// only on its far edges.
///
/// - `port` is seated at the first free slot of its role ([`first_free_slot`]) for
///   [`PortSeat::Auto`](crate::edit::PortSeat::Auto), the forward gesture, or at its OWN
///   slot (read off its `local_offset`) for
///   [`PortSeat::Captured`](crate::edit::PortSeat::Captured), the inverse of a removal,
///   and inserted at list position `index` (clamped to the append position).
/// - The box grows only as far as the slots need, never below the current box: height to
///   the highest In or Out slot plus one, width to the In and Out columns needed (one per
///   role present) and the highest Fault slot plus one.
/// - Every port is then put on its role's edge of the new box at its kept slot (In
///   column 0, Out column `w - 1`, Fault row `h - 1`).
/// - The ANCHOR shifts by the growth `(dw, dh)` so the growth lands on the rot-0 EAST
///   (width) and SOUTH (height) edges wherever the turn has put them in world space:
///   rot 0 `(0, 0)`, rot 1 `(-dh, 0)`, rot 2 `(-dw, -dh)`, rot 3 `(0, -dw)`. Read off
///   [`port_world`]'s table: at rot 1 local `y` maps to world `x` as `h - 1 - y`, so a
///   taller box would move every In and Out one cell east unless the anchor moves one
///   cell west. So no In ever moves, an Out moves only when the box widens, and a Fault
///   only when it grows taller, at every rotation.
///
/// Pure and total: integer only, saturating, no panic on a forged slot or a forged
/// index; the clamp to `MAX_FOOTPRINT_DIM` is what the fold writes and `unclamped` is what
/// the command layer refuses on.
#[must_use]
pub fn add_port_geometry(
    base: Footprint,
    anchor: (i32, i32),
    footprint: Footprint,
    ports: &[Port],
    index: PortId,
    port: Port,
    seat: crate::edit::PortSeat,
) -> PortEditGeometry {
    let slot = match seat {
        crate::edit::PortSeat::Auto => first_free_slot(base, ports, port.role),
        crate::edit::PortSeat::Captured => port_slot(&port),
    };
    // The new port at its slot; its edge coordinate is re-derived below with the rest.
    let seated = match port.role {
        Role::In | Role::Out => Port { local_offset: (port.local_offset.0, slot), ..port },
        Role::Fault => Port { local_offset: (slot, port.local_offset.1), ..port },
    };
    let mut list = ports.to_vec();
    let idx = usize::from(index).min(list.len());
    list.insert(idx, seated);

    // The box the slots need, in i64 so a forged slot near i32::MAX cannot overflow.
    let mut need_h: i64 = 1;
    let mut need_fault_w: i64 = 1;
    let (mut has_in, mut has_out) = (false, false);
    for p in &list {
        let s = i64::from(port_slot(p)) + 1;
        match p.role {
            Role::In => {
                has_in = true;
                need_h = need_h.max(s);
            }
            Role::Out => {
                has_out = true;
                need_h = need_h.max(s);
            }
            Role::Fault => need_fault_w = need_fault_w.max(s),
        }
    }
    let need_w = (i64::from(has_in) + i64::from(has_out)).max(need_fault_w).max(1);
    let uw = i64::from(footprint.w).max(need_w);
    let uh = i64::from(footprint.h).max(need_h);
    let cap = i64::from(MAX_FOOTPRINT_DIM);
    // Both in `[1, MAX_FOOTPRINT_DIM]`, so the casts never truncate.
    let w = uw.clamp(1, cap) as u16;
    let h = uh.clamp(1, cap) as u16;
    // The growth, never negative: the box is never below the current one (a current box
    // past the cap, only reachable by forged bytes, clamps down and shifts nothing).
    let dw = (i32::from(w) - i32::from(footprint.w)).max(0);
    let dh = (i32::from(h) - i32::from(footprint.h)).max(0);
    let (sx, sy) = match footprint.rot & 3 {
        0 => (0, 0),
        1 => (-dh, 0),
        2 => (-dw, -dh),
        _ => (0, -dw),
    };
    PortEditGeometry {
        anchor: (anchor.0.saturating_add(sx), anchor.1.saturating_add(sy)),
        footprint: Footprint { w, h, rot: footprint.rot },
        ports: list.into_iter().map(|p| edge_port(p, w, h)).collect(),
        unclamped: (uw, uh),
    }
}

/// The geometry a `RemovePort` writes (plan 74.1-16): the list without the port at
/// `index`, and NOTHING ELSE MOVES.
///
/// - `restore: None` (every forward removal): the SAME anchor, the SAME footprint and the
///   SAME slots. A removal never shrinks the machine and never re-seats a survivor, so
///   only the removed port's own docks are released (design rule, 2026-10-04: deleting an output does not shuffle positions; the
///   never-shrink half is a stated assumption that was not reversed).
/// - `restore: Some(r)` (only the inverse of an `AddPort` carries one): the box and anchor
///   the add grew from, `r.w x r.h` at `(r.anchor_x, r.anchor_y)`, the `rot` kept, and
///   every port put back on its role's edge of that box at its kept slot. That is what
///   makes one Ctrl+Z of a growing add shrink the box and move the anchor back.
///
/// An out-of-range `index` returns the input unchanged (the fold's own guard runs first;
/// this is total on its own). A forged restore box clamps to `[1, MAX_FOOTPRINT_DIM]`;
/// the snapshot trust gate refuses a port it leaves outside the box on load.
#[must_use]
pub fn remove_port_geometry(
    anchor: (i32, i32),
    footprint: Footprint,
    ports: &[Port],
    index: PortId,
    restore: Option<crate::edit::BoxRestore>,
) -> PortEditGeometry {
    let mut list = ports.to_vec();
    if usize::from(index) < list.len() {
        list.remove(usize::from(index));
    }
    match restore {
        None => PortEditGeometry {
            anchor,
            footprint,
            ports: list,
            unclamped: (i64::from(footprint.w), i64::from(footprint.h)),
        },
        Some(r) => {
            let cap = MAX_FOOTPRINT_DIM;
            let (w, h) = (r.w.clamp(1, cap), r.h.clamp(1, cap));
            PortEditGeometry {
                anchor: (r.anchor_x, r.anchor_y),
                footprint: Footprint { w, h, rot: footprint.rot },
                ports: list.into_iter().map(|p| edge_port(p, w, h)).collect(),
                unclamped: (i64::from(r.w), i64::from(r.h)),
            }
        }
    }
}

/// WHICH KIND OF ATTACHMENT a [`judge_docks`](GridState::judge_docks) candidate is, and
/// therefore what a verdict about it means (73-12, 73-REVIEW CR-02).
///
/// Until 73-12 this seam knew only about belts, and `judge_docks` collected a candidate
/// only where the neighbour was a [`Node::Belt`]. A [`Node::Wire`]'s endpoints are ALSO
/// `(node, port)` handles into the machine's port list - raw CATALOG indices, the same
/// keyspace a Head dock uses - so a port removal shifted every catalog index above it and
/// left every wire endpoint naming the port that USED to be there. That is why this is one
/// enum rather than a second collection pass: a wire endpoint is a dock candidate, it just
/// lives somewhere else.
///
/// # Why the two wire variants are distinct
/// They are written back to DIFFERENT places. `WireFrom` is recorded ONLY on the
/// `WireLink.from` field - a wire's source endpoint has no `links` entry at all, which is
/// the trap [`docked_wires`](GridState::docked_wires) records in capitals. `WireTo` is
/// recorded TWICE: on `WireLink.to` AND as the value of the `(wire, 0) -> (machine, port)`
/// edge [`fold_draw_wire`](crate::tick) writes beside it. A fix that moved one of the two
/// would mis-deliver silently.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DockEnd {
    /// A drawn BELT docked to the machine, at the named end. The pre-73-12 whole set.
    Belt(crate::edit::BeltEnd),
    /// A [`Node::Wire`] whose SOURCE endpoint (`WireLink.from`) names the machine.
    WireFrom,
    /// A [`Node::Wire`] whose TARGET endpoint (`WireLink.to`) names the machine.
    WireTo,
}

/// What one [`judge_docks`](GridState::judge_docks) pass did, in the two shapes a caller
/// has to act on (73-12).
///
/// It is a struct rather than a bare `Vec<UnlinkedDock>` because releasing a BELT dock and
/// releasing a WIRE endpoint are not the same act and cannot be reported the same way. A
/// released belt keeps its node and loses one link, which is exactly what
/// [`UnlinkedDock`] describes. A wire endpoint has no representable "attached to nothing"
/// state - `WireLink.from`/`.to` are non-optional `(NodeId, PortId)` pairs - so the wire
/// itself has to go, and only the FOLD can do that: removing a node must be PAIRED with
/// `sched.remove` (the AR-3 pairing), and this type has no scheduler.
pub(crate) struct JudgedDocks {
    /// Every BELT dock released, in `links` key order - the `last_tick.unlinked` payload.
    pub unlinked: Vec<UnlinkedDock>,
    /// Every WIRE whose endpoint named the removed port, in ascending `NodeId` order.
    /// The caller removes them and pairs `sched.remove` with each.
    pub released_wires: Vec<NodeId>,
}

/// One dock deterministically UNLINKED by a [`rotate_footprint`](GridState::rotate_footprint)
/// (CAT-06, the SPIKE) — telemetry, NOT snapshot state. When a rotate spins a port
/// so it no longer FACES its docked belt end-tile, that ONE directed dock link is
/// dropped and an `UnlinkedDock` is recorded (in `links` key order) so the fold can
/// surface it via [`last_tick.unlinked`](crate::core::TickObservation) for the
/// Phase-21 visual disconnect indicator. The belt NODE survives (never removed, never
/// re-drawn — A* is a locked anti-feature); only the link is gone.
///
/// Plain ordered data (mirrors the `last_tick.removed` `NodeId` usage): a `Copy`
/// record of `(belt, endpoint, node, port)`. Not serialized (rides `TickObservation`,
/// which is ephemeral and never snapshotted).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct UnlinkedDock {
    /// The belt whose dock was dropped (its node SURVIVES disconnected).
    pub belt: NodeId,
    /// Which end of the belt was docked (`Head` = deliver/last tile, `Tail` =
    /// admit/first tile) — the direction the dropped link encoded.
    pub endpoint: crate::edit::BeltEnd,
    /// The rotated machine the belt had been docked to.
    pub node: NodeId,
    /// The machine port id the dock keyed on (`FAULT_PORT` for a fault dock, else the
    /// spatial port index).
    pub port: PortId,
}

/// The deterministic grid state container (CORE-06, API-03).
///
/// `nodes` is the authoritative ordered store; `allocator` only mints ids.
/// `inboxes` holds per-node input buffers; `links` records directed
/// output→input wiring as `(from_node, from_port) -> (to_node, to_port)`.
/// Every field is a `BTreeMap`/serde-plain type so the whole grid snapshots and
/// round-trips byte-identically.
#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct GridState {
    /// Generational id allocator — minting + liveness ONLY, never iterated for
    /// order-observed logic (RESEARCH Pitfall 3/4).
    allocator: slotmap::SlotMap<NodeId, ()>,
    /// Authoritative ordered node store (deterministic iteration, CORE-06).
    nodes: BTreeMap<NodeId, Node>,
    /// Per-node input buffers.
    inboxes: BTreeMap<NodeId, PortInbox>,
    /// Directed wiring: `(from_node, from_port) -> (to_node, to_port)`.
    links: BTreeMap<(NodeId, PortId), (NodeId, PortId)>,
    /// Logical grid cell of each placed machine (SPAT-01). **The SERIALIZED source
    /// of truth** for the spatial model, reversing v1.0's "cells never in core"
    /// decision so multi-cell collision is a pure function of logged data (Phase
    /// 9). **Appended LAST** so postcard's positional layout of every prior field is
    /// unchanged — the frozen corpus only gains a trailing empty-map marker (the
    /// `SNAPSHOT_SCHEMA_VERSION` 3→4 bump quarantines this). Belts minted by a
    /// `Wire` stay cell-less (their on-screen span derives from endpoint cells);
    /// only [`fold_place`](crate::tick)d machines get a cell via [`set_cell`](Self::set_cell).
    cells: BTreeMap<NodeId, (i32, i32)>,
    /// DERIVED reverse occupancy index `cell -> node`, the O(1) "what is here?"
    /// collision lookup. `#[serde(skip)]` — **never serialized** — mirroring the
    /// [`Core::factory_runtimes`](crate::core::Core) cold-cache doctrine: there is a
    /// single trusted serialized source (`cells`) and this index is rebuilt from it
    /// post-decode via [`rebuild_occupancy`](Self::rebuild_occupancy) (RESEARCH
    /// Pitfall 3, threat T-9-04 — no second serialized map to forge/disagree).
    #[serde(skip)]
    occupancy: BTreeMap<(i32, i32), NodeId>,
    /// Per-node multi-cell [`Footprint`] (SPAT/FOOT, Phase 10). **Appended LAST**
    /// (after `cells`/`occupancy`) so postcard's positional layout of every prior
    /// field is byte-for-byte unchanged — exactly the Phase-9 `cells`-appended-last
    /// discipline. **An ABSENT entry means a 1×1 rot0 footprint** (the faithful
    /// default), so an all-1×1 grid serializes this map EMPTY (a single trailing
    /// zero-length prefix) and stays semantically identical to the v1.0 point
    /// machine. The `SNAPSHOT_SCHEMA_VERSION` `4 → 5` bump quarantines the wire
    /// change. The generalized multi-cell claim + trust-gate invariants that consume
    /// a NON-empty map land in 10-03; this plan keeps it empty via the public API.
    footprints: BTreeMap<NodeId, Footprint>,
    /// Per-node rot-0 [`Port`] declarations (Phase 10). **Appended LAST** after
    /// `footprints`, same append-only discipline — an ABSENT entry means a port-less
    /// machine, so an all-1×1 corpus grid serializes this map EMPTY too (the second
    /// trailing zero-length prefix). The dock/port mechanics that consume it land in
    /// 10-04+; this plan keeps it empty via the public API.
    ports: BTreeMap<NodeId, Vec<Port>>,
    /// DERIVED reverse link index `destination node -> the source nodes linking into it`
    /// (phase 87, JAM-04, D-06). `#[serde(skip)]`, **never serialized**, in the
    /// [`occupancy`](Self::occupied) precedent's words: there is a single trusted
    /// serialized source (`links`) and this index is rebuilt from it post-decode via
    /// [`rebuild_feeders`](Self::rebuild_feeders), so there is no second serialized map
    /// to forge or to disagree with it.
    ///
    /// Its consumer is the consumer wake in `tick.rs` `step_node`: a node whose inbox
    /// shrank wakes the feeders asleep behind it, and finds them here without walking
    /// every link (the project's performance rule: no full-grid scans on the hot path). It is maintained at
    /// the only two places `links` changes, [`link`](Self::link) and
    /// [`unlink`](Self::unlink); the delete's dangling-link loop goes through `unlink`.
    /// A source stays in a destination's set while ANY of its ports links there, so
    /// removing one of two links to the same destination keeps it. Ordered collections
    /// only (CORE-06). Appended LAST and skipped, so no serialized position moves.
    #[serde(skip)]
    feeders: BTreeMap<NodeId, BTreeSet<NodeId>>,
}

impl GridState {
    /// An empty grid.
    pub fn new() -> Self {
        Self::default()
    }

    /// Add a manual-inject source, returning its minted [`NodeId`].
    pub fn add_source(&mut self) -> NodeId {
        let id = self.allocator.insert(());
        self.nodes.insert(id, Node::Source(ManualInject::new()));
        self.inboxes.insert(id, PortInbox::new());
        id
    }

    /// Add a belt of `tiles` tiles (`SLOTS_PER_TILE * tiles` slots), returning its
    /// [`NodeId`]. A `Wire`-minted belt passes `tiles = 1` (a 1-tile logical belt,
    /// geometry-empty); a `DrawBelt` fold passes the drawn tile count and then sets
    /// the belt's geometry + claims its tile cells via
    /// [`claim_belt_tiles`](Self::claim_belt_tiles).
    pub fn add_belt(&mut self, tiles: u32) -> NodeId {
        let id = self.allocator.insert(());
        self.nodes.insert(id, Node::Belt(Belt::new(tiles)));
        self.inboxes.insert(id, PortInbox::new());
        // A BELT IS A PORTED NODE (Phase 74, LINK-08 / D-04 / D-06). Its two ends are
        // Port records in the SAME `ports` map machine ports live in, so one link model
        // serves belts and wires and `ports_of(belt)` is never the odd answer out.
        //
        // THE WRITE IS UNCONDITIONAL, AND THAT DELIBERATELY BREAKS THE NEIGHBOURING
        // CONVENTION. `resolve_footprint` a few hundred lines below keeps an
        // `absent ⇒ port-less` rule: an empty port list writes NO entry so a port-less
        // machine stays byte-identical. D-06 rules the opposite for belts. EVERY belt is
        // present in `ports`, geometry-empty (`Wire`-minted) ones included, because
        // `Some` for some belts and `None` for others is an undefined answer a third of
        // the certified corpus would carry, and `resolve_spatial_port` would then behave
        // differently per belt. A geometry-empty belt has ports but no resolvable WORLD
        // cell, so a `Dock` naming one refuses on the GEOMETRY check, never on
        // port-absence. Read the two rules together: absent means port-less for a
        // machine, and a belt is never absent.
        self.ports.insert(id, belt_ports());
        id
    }

    /// Claim a drawn belt's `geometry` tile cells into the unified
    /// [`occupancy`](Self::occupied) index → `id` (BELT-06) — the belt analog of
    /// [`claim_footprint`](Self::claim_footprint). Belts are NOT rectangles, so NO
    /// `cells`/`footprints` entry is written; the belt's `geometry` (stored ON the
    /// `Node::Belt`) is the single SERIALIZED truth, and
    /// [`rebuild_occupancy`](Self::rebuild_occupancy) re-claims it post-decode
    /// (RESEARCH Pitfall 5 — never a second serialized map that can disagree).
    pub fn claim_belt_tiles(&mut self, id: NodeId, geometry: &[BeltTile]) {
        for tile in geometry {
            self.occupancy.insert(tile.cell, id);
        }
    }

    /// Add a broadcast / tee fanning out to `outputs` ports (ROUTE-02),
    /// returning its [`NodeId`]. Mirrors [`add_belt`](Self::add_belt).
    pub fn add_tee(&mut self, outputs: u16) -> NodeId {
        let id = self.allocator.insert(());
        self.nodes.insert(id, Node::Tee(Tee::new(outputs)));
        self.inboxes.insert(id, PortInbox::new());
        id
    }

    /// Add a balancer spreading across `outputs` ports (ROUTE-03), its
    /// round-robin pointer starting at 0, returning its [`NodeId`]. Mirrors
    /// [`add_belt`](Self::add_belt).
    pub fn add_balancer(&mut self, outputs: u16) -> NodeId {
        let id = self.allocator.insert(());
        self.nodes.insert(id, Node::Balancer(Balancer::new(outputs)));
        self.inboxes.insert(id, PortInbox::new());
        id
    }

    /// Add a merge funnelling `inputs` input ports into one output (ROUTE-05),
    /// its round-robin pointer starting at 0, returning its [`NodeId`]. Mirrors
    /// [`add_belt`](Self::add_belt).
    pub fn add_merge(&mut self, inputs: u16) -> NodeId {
        let id = self.allocator.insert(());
        self.nodes.insert(id, Node::Merge(Merge::new(inputs)));
        self.inboxes.insert(id, PortInbox::new());
        id
    }

    /// Add a router switching by the ordered `routes` table (first match wins),
    /// with an optional `default` ("else") output port — no-match falls through to
    /// `default` if `Some`, else to the reserved fault port (ROUTE-04). Its fault
    /// counter starts at 0. Returns its [`NodeId`]. Mirrors
    /// [`add_belt`](Self::add_belt).
    pub fn add_router(
        &mut self,
        routes: Vec<(RouteKey, PortId)>,
        default: Option<PortId>,
    ) -> NodeId {
        let id = self.allocator.insert(());
        self.nodes
            .insert(id, Node::Router(Router::new(routes, default)));
        self.inboxes.insert(id, PortInbox::new());
        id
    }

    /// Add a factory sandbox node (FACT-01..04) running the user JS `source` under
    /// the per-tick `gas_budget`, returning its [`NodeId`]. Mirrors
    /// [`add_router`](Self::add_router): mint the id, insert the `Node::Factory`
    /// plain data and an inbox.
    ///
    /// # Per-node RNG sub-seed (CONTEXT, RESEARCH Code Example)
    /// The factory's `ctx.random` substream is sub-seeded from the genesis `seed`
    /// mixed with the node-id key via a splitmix-style derivation. The mix uses the
    /// node's stable [`slotmap`] `KeyData::as_ffi` value — stable across restore — so
    /// the sub-seed is reproducible and two factories in the same grid get distinct,
    /// deterministic substreams. The sub-seed is consumed ONCE here; thereafter the
    /// advanced `SimRng` state is snapshotted in the `Factory` plain data exactly like
    /// the global RNG, so no genesis-seed re-derivation is ever needed on restore.
    ///
    /// # Why `seed` is a parameter (not a stored field)
    /// The genesis seed is supplied by the caller (it lives in the log header that
    /// `Core::genesis` already holds) rather than stored on `GridState`. Storing it
    /// would change the serialized `GridState` shape and break the frozen golden
    /// corpus (`0001`-`0004`); a construction-time-only parameter keeps the snapshot
    /// bytes of every existing grid unchanged, and the seed is never needed again
    /// after the substream is minted.
    pub fn add_factory(&mut self, source: String, gas_budget: u64, seed: u64) -> NodeId {
        let id = self.allocator.insert(());
        // Stable, serialized-across-restore node key → a deterministic sub-seed.
        let node_key: u64 = id.data().as_ffi();
        let sub_seed = seed
            .wrapping_mul(0x9E37_79B9_7F4A_7C15) // splitmix-style mixing constant
            .wrapping_add(node_key.rotate_left(32));
        let rng = SimRng::from_seed_u64(sub_seed);
        self.nodes
            .insert(id, Node::Factory(Box::new(Factory::new(source, gas_budget, rng))));
        self.inboxes.insert(id, PortInbox::new());
        id
    }

    /// Add a terminal sink node (Phase-5 EXEC seam) emitting `template`-shaped
    /// commands with the given per-command tick `deadline_ticks`, returning its
    /// [`NodeId`]. Mirrors [`add_factory`](Self::add_factory)/[`add_router`](Self::add_router):
    /// mint the id, insert the `Node::Sink` plain data and an inbox.
    pub fn add_sink(&mut self, template: SinkTemplate, deadline_ticks: u64) -> NodeId {
        let id = self.allocator.insert(());
        self.nodes
            .insert(id, Node::Sink(Sink::new(template, deadline_ticks)));
        self.inboxes.insert(id, PortInbox::new());
        id
    }

    /// Add a request/response transport [`Node::Wire`] (Phase-37 WIRE seam) linking
    /// output `from` to input `to`, with an empty in-flight FIFO, returning its
    /// [`NodeId`]. Mirrors [`add_sink`](Self::add_sink)/[`add_factory`](Self::add_factory):
    /// mint the id, insert the `Node::Wire` plain data and an inbox.
    ///
    /// # The Phase-38 no-further-growth claim, and where it STOPPED being true
    /// The three wire shapes carry their final Phase-37+38 fields: `WireLink` gains
    /// only `in_flight` (reply routing), `WireRequest` already carries `deadline_tick`
    /// plus `return_addr`/`payload`, and `Effect::Reply` carries `payload`. Those three
    /// are still settled, and 72-04 appending `return_addr`/`budget` to `Effect::Reply`
    /// was this crate's own deliberate thaw rather than a contradiction of them.
    ///
    /// What this docblock USED to add, and what is now false, is its clause about the
    /// endpoint: it claimed the endpoint payload would never grow a field and that no
    /// serialized wire shape would grow again. 72-07 gives [`Endpoint`] a `path`
    /// (SERVE-08, D-12), so a shape did grow. The part of the old claim that SURVIVES
    /// is the reason it named: the Phase-38
    /// parked-socket/correlation registry is still host-side `#[serde(skip)]` (the
    /// `factory_runtimes` precedent, `core.rs:159-160`) and is still not a snapshot
    /// field. In-flight host state stays out; board configuration the user authored
    /// comes in.
    pub fn add_wire(&mut self, from: (NodeId, PortId), to: (NodeId, PortId)) -> NodeId {
        let id = self.allocator.insert(());
        self.nodes.insert(
            id,
            Node::Wire(WireLink {
                from,
                to,
                in_flight: VecDeque::new(),
            }),
        );
        self.inboxes.insert(id, PortInbox::new());
        id
    }

    /// Add a request/response [`Node::Endpoint`] host-bridge node (Phase-38 ENDPOINT
    /// seam), returning its minted [`NodeId`]. Mirrors [`add_wire`](Self::add_wire) /
    /// [`add_source`](Self::add_source): mint the id, insert the [`Endpoint`] plain
    /// data and an inbox.
    ///
    /// # It MINTS the default path rather than taking one (R-44, SERVE-08, D-13)
    /// The default is `/route-N`, N the smallest positive integer such that no
    /// [`Node::Endpoint`] on the board holds the path `/route-N`. The path cannot be
    /// supplied by a caller, so NO CALLER CAN MINT A PATHLESS ROUTE: a `path` parameter
    /// would put the invariant in every call site instead of in one function.
    ///
    /// Phase 91 replaced the id-derived `/ep-<as_ffi>` default, which showed a user a
    /// ten-digit slot packing in the Path field and the POST URL of every Route they
    /// placed. The readable number is read off the board itself: the set of Route keys
    /// the Endpoints answer at right now ([`crate::edit::endpoint_route_key`]), compared as
    /// whole strings. So a Route renamed away from `/route-1` frees that number, one
    /// configured to `/route-01` holds nothing but `/route-01`, and a forged slashless
    /// `route-1` holds `/route-1` (phase 91 review WR-A-04).
    ///
    /// # Determinism
    /// The mint is a pure function of state. It reads set MEMBERSHIP over the
    /// `BTreeMap` of nodes, never an iteration order, an id packing, a clock or the RNG,
    /// so a replay of the same log mints the same path at the same fold. Two Routes in
    /// one edit batch fold in record order and take consecutive numbers.
    ///
    /// # Why the leading slash matters
    /// The host keys a Route by its path through `endpoint_route_key`, which keeps the
    /// leading `/`, and a Source by `src-<as_ffi>`, which has none. The slash is what
    /// keeps the two key spaces disjoint, so a minted `/route-N` can never shadow a
    /// Source, and the mint reads Route keys, so it can never shadow another Route. Every minted path also passes [`crate::edit::endpoint_path_is_valid`],
    /// the gate a typed path must pass.
    ///
    /// # There are TWO minters and they produce identical nodes (63-04)
    /// This one, called by any non-gesture endpoint seed a host may run; and the edit-log
    /// fold, since `fold_place` gained
    /// its `machine_kind::ENDPOINT` arm for WIRE-03 and that arm calls straight into
    /// here. An endpoint that arrived through a `Place` record is therefore
    /// indistinguishable from a seeded one, byte for byte — asserted by
    /// `a_fold_minted_endpoint_is_identical_to_an_add_endpoint_one` in
    /// [`crate::tick`]'s tests, not just claimed here.
    ///
    /// Routing the default through THIS function rather than through the fold arm is
    /// what keeps that byte-identity true.
    ///
    /// Either way the `SimLoop::new` route table publishes the node's route from the
    /// node's own `path` (ENDP-05, as widened by SERVE-08). A serialized shape DOES
    /// grow here, unlike every earlier claim on this seam: see [`Endpoint`].
    pub fn add_endpoint(&mut self) -> NodeId {
        let id = self.allocator.insert(());
        let path = self.unused_route_path();
        self.nodes.insert(id, Node::Endpoint(Endpoint { path }));
        self.inboxes.insert(id, PortInbox::new());
        id
    }

    /// The default path for a new Route: `/route-N`, N the smallest positive integer
    /// such that no [`Node::Endpoint`] on the board answers at the Route key `/route-N`
    /// (D-13).
    ///
    /// Membership over the set of held KEYS ([`crate::edit::endpoint_route_key`], the one
    /// normalizer the host's route map keys by; phase 91 review WR-A-04), so a forged
    /// slashless `route-1` holds the number 1 exactly as `/route-1` does, and the answer
    /// depends only on which keys the board's Endpoints answer at, never on the order the
    /// map is walked. The loop ends after at most one more candidate than there are
    /// Endpoints.
    fn unused_route_path(&self) -> String {
        let taken: BTreeSet<String> = self
            .nodes
            .values()
            .filter_map(|node| match node {
                Node::Endpoint(ep) => Some(crate::edit::endpoint_route_key(&ep.path)),
                _ => None,
            })
            .collect();
        let mut n: u64 = 1;
        loop {
            let candidate = format!("/route-{n}");
            if !taken.contains(&candidate) {
                return candidate;
            }
            n += 1;
        }
    }

    /// Add a Label (phase 76, SHAPE-10): empty text, `LabelColour::Sand`, and an inbox.
    ///
    /// The inbox is load-bearing even though nothing is ever delivered into it: the
    /// snapshot load check refuses any node without one (`MissingInbox`), so a label
    /// minted without it would save and then fail to load. It draws NO random number and
    /// takes no seed (D-03), and it is the ONE minting seam, so a fold-minted label and
    /// one minted here are byte-identical.
    pub fn add_label(&mut self) -> NodeId {
        let id = self.allocator.insert(());
        self.nodes.insert(id, Node::Label(Label::default()));
        self.inboxes.insert(id, PortInbox::new());
        id
    }

    /// Re-box a label to `w` by `h` cells (phase 76, plan 76-02, D-04): the anchor stays
    /// where it is, so a label grows right and down; rot stays 0 and the port list stays
    /// empty.
    ///
    /// The body is ONE [`write_port_geometry`](Self::write_port_geometry) call, the
    /// shipped writer that frees every old body cell, writes or removes the `footprints`
    /// entry (removed for 1x1 rot 0, the absent-means-default convention) and claims the
    /// new cells, so occupancy stays exactly what `rebuild_occupancy` reconstructs.
    ///
    /// # The clamp is the allocation guard, and it lives HERE, in the fold's path
    /// `w` and `h` are clamped to `1..=MAX_FOOTPRINT_DIM` before any cell is written (the
    /// [`remove_port_geometry`] restore-clamp precedent). The fold applies a record
    /// verbatim on every replay, including a forged one no gate validated, and a
    /// `65535 x 65535` box would otherwise expand about 4.3 billion occupancy cells
    /// (threat T-76-05). `unclamped` records the request as made.
    ///
    /// A node with no cell is a panic-free no-op (the `write_port_geometry` rule); the
    /// caller has already checked the node IS a label.
    pub(crate) fn resize_label_box(&mut self, id: NodeId, w: u16, h: u16) {
        let Some((anchor, footprint)) = self.label_box_after_resize(id, w, h) else {
            return;
        };
        self.write_port_geometry(
            id,
            &PortEditGeometry {
                anchor,
                footprint,
                ports: Vec::new(),
                unclamped: (i64::from(w), i64::from(h)),
            },
        );
    }

    /// The anchor and box [`resize_label_box`](Self::resize_label_box) gives node `id` for
    /// a requested `w` by `h`: the anchor unchanged, rot 0, each side clamped to
    /// `1..=MAX_FOOTPRINT_DIM`. `None` for a node with no cell (the resize is then a no-op).
    /// Read-only, no authority.
    ///
    /// The ONE home of that rule, so a reader asking "which cells will this label's
    /// Configure claim?" cannot drift from the fold that claims them. Its reader is the
    /// Delete undo's restore-space guard in `fabrico-command` (phase 86 security audit,
    /// threat T-86-15): a label's re-Configure re-grows its box AFTER the re-Place, so the
    /// guard must check this box, not only the captured one.
    pub fn label_box_after_resize(
        &self,
        id: NodeId,
        w: u16,
        h: u16,
    ) -> Option<((i32, i32), Footprint)> {
        let anchor = self.cells.get(&id).copied()?;
        let cap = MAX_FOOTPRINT_DIM;
        Some((anchor, Footprint { w: w.clamp(1, cap), h: h.clamp(1, cap), rot: 0 }))
    }

    /// Record a directed wiring from an output port to an input port. Logical
    /// `(node, port)` addressing only — never a raw pointer (API-03).
    ///
    /// Re-linking a `from` that already had a target moves it: the old destination keeps
    /// `from.0` in its [`feeders`](Self::feeders_of) only while another port of that
    /// source still links there (phase 87, JAM-04).
    pub fn link(&mut self, from: (NodeId, PortId), to: (NodeId, PortId)) {
        if let Some(old) = self.links.insert(from, to)
            && old.0 != to.0
        {
            self.drop_feeder_if_unlinked(from.0, old.0);
        }
        self.feeders.entry(to.0).or_default().insert(from.0);
    }

    /// Remove a single directed link keyed by its `from` `(node, port)` — the exact
    /// mirror of [`link`](Self::link) (Phase 12, 12-01). Removing an ABSENT key is a
    /// panic-free no-op (strictly safer than `fold_dock`'s missing-node guard), so
    /// `fold_unlink` of a forged inverse record can never panic. Logical
    /// `(node, port)` addressing only — never a raw pointer (API-03).
    ///
    /// # A removed Factory output drops that port's queue (phase 87, JAM-05, D-07)
    /// When `from` is a Factory's output, the emits waiting on that port in
    /// [`Factory::pending_emits`] are dropped with the link, in the same call. The snapshot
    /// trust gate refuses a queue on a port with no link
    /// (`StateInvariant::FactoryPendingEmits`), so a link removed while items wait would
    /// otherwise leave a live board that saves into a file the gate will not reopen. Every
    /// link removal goes through here: a Disconnect (`fold_unlink`), a port edit or rotate
    /// (`judge_docks`) and a delete (`remove_node_traces`).
    ///
    /// The dropped items are COUNTED in [`Factory::faults`] (saturating), the Factory's
    /// drop counter, so an accepted item never vanishes without a trace (87-CONTEXT D-03,
    /// T-87-11; 87-REVIEW CR-01). This is a real release only: a port edit that merely
    /// RE-KEYS a dock takes the queue out before it calls this and puts it back on the new
    /// key afterwards ([`judge_docks`](Self::judge_docks)), so a re-keyed queue is neither
    /// dropped nor counted.
    pub fn unlink(&mut self, from: (NodeId, PortId)) {
        if let Some(old) = self.links.remove(&from) {
            self.drop_feeder_if_unlinked(from.0, old.0);
        }
        if let Some(Node::Factory(factory)) = self.nodes.get_mut(&from.0)
            && let Some(dropped) = factory.pending_emits.remove(&from.1)
        {
            let n = u64::try_from(dropped.len()).unwrap_or(u64::MAX);
            factory.faults = factory.faults.saturating_add(n);
        }
    }

    /// Keep the reverse link index exact after one link `src -> dest` went away: `src`
    /// leaves `dest`'s feeders only when no other port of `src` still links to `dest`.
    /// A `links_from(src)` range read, never a walk of every link.
    fn drop_feeder_if_unlinked(&mut self, src: NodeId, dest: NodeId) {
        if self.links_from(src).any(|(_, (to, _))| to == dest) {
            return;
        }
        if let Some(set) = self.feeders.get_mut(&dest) {
            set.remove(&src);
            if set.is_empty() {
                self.feeders.remove(&dest);
            }
        }
    }

    /// The source nodes with at least one link into `dest`, in ascending [`NodeId`] order
    /// (phase 87, JAM-04, D-06): the derived reverse link index, valid on a live grid and,
    /// after [`rebuild_feeders`](Self::rebuild_feeders), on a restored one. Read-only.
    pub fn feeders_of(&self, dest: NodeId) -> impl Iterator<Item = NodeId> + '_ {
        self.feeders.get(&dest).into_iter().flatten().copied()
    }

    /// Rebuild the `#[serde(skip)]` reverse link index from the serialized `links` in one
    /// O(links) pass (phase 87, JAM-04). The skipped index decodes EMPTY;
    /// [`crate::snapshot::restore`] calls this beside
    /// [`rebuild_occupancy`](Self::rebuild_occupancy), so a machine restored asleep behind
    /// a blocked output can still be woken by the consumer that frees its slot.
    pub fn rebuild_feeders(&mut self) {
        self.feeders.clear();
        for (&(src, _), &(dest, _)) in &self.links {
            self.feeders.entry(dest).or_default().insert(src);
        }
    }

    /// The wiring target of `from`, if any.
    pub fn link_target(&self, from: (NodeId, PortId)) -> Option<(NodeId, PortId)> {
        self.links.get(&from).copied()
    }

    /// Iterate every directed link as `(from:(node,port), to:(node,port))` in
    /// deterministic ascending key order (the `links` `BTreeMap` order).
    ///
    /// Additive, read-only, **no authority** (mirrors `link_target`/`node_ids`):
    /// it copies the `(from, to)` pairs out of the private `links` map and changes
    /// no field. Consumed by the snapshot trust gate
    /// (`crate::snapshot::validate_invariants`) to reject a link whose target is
    /// not a live node (the routing panic surface, RESEARCH A1).
    pub fn links_iter(&self) -> impl Iterator<Item = ((NodeId, PortId), (NodeId, PortId))> + '_ {
        self.links.iter().map(|(&from, &to)| (from, to))
    }

    /// Every directed link whose `from` node is `id`, as `(from, to)` pairs.
    ///
    /// A `BTreeMap` RANGE read over `links` from `(id, 0)` to `(id, PortId::MAX)`
    /// inclusive, so it visits only this node's own keys and yields them in
    /// deterministic ascending NodeId-then-PortId order - the map's own key order,
    /// never an arrival order and never a `HashMap` scan. Additive, read-only, **no
    /// authority** (mirrors [`links_iter`](Self::links_iter)).
    ///
    /// Its consumer is plan 71-03's PILE-02 gate, which must ask "can EVERY linked
    /// output of this node accept?" before letting the node consume its inbox, and
    /// therefore needs this node's outgoing links without walking the whole map.
    pub fn links_from(
        &self,
        id: NodeId,
    ) -> impl Iterator<Item = ((NodeId, PortId), (NodeId, PortId))> + '_ {
        self.links
            .range((id, PortId::MIN)..=(id, PortId::MAX))
            .map(|(&from, &to)| (from, to))
    }

    /// The FIRST live [`Node::Wire`] whose `from` endpoint sits on `node` (i.e.
    /// `WireLink.from.0 == node`), in ascending [`NodeId`] order — the `nodes`
    /// `BTreeMap` iteration order, a DEFINED, deterministic tie-break (never
    /// arrival-order, never a `HashMap` scan).
    ///
    /// # WHICH WIRE LEAVES THIS NODE (the ENTRY question). NODE-ONLY, on purpose
    /// This answers "which cable leaves `node`", nothing more, and if a node has more
    /// than one outgoing wire the ascending-`NodeId` FIRST is chosen deterministically.
    ///
    /// Its ONE production caller is now the
    /// [`WireRequest`](crate::event::EventPayload::WireRequest) admit arm in
    /// `manual_inject.rs`, locating the ENTRY wire out of the caller. It is deliberately
    /// NOT port-exact and NOT address-exact: D-19, measured. The shipped scenario-07
    /// board draws its forward wire from the endpoint's port 1 while the host stamps
    /// `return_addr = (endpoint, 0)`, so a port-exact entry match finds no wire, drops
    /// the request and moves a frozen fixture. The reason is written at the call site
    /// too, which is where a reader meets the asymmetry.
    ///
    /// # It NO LONGER serves the reply path (Phase 72 plan 04)
    /// Until Phase 72 this function also chose the RETURN wire out of a replying handler,
    /// under a docblock that scoped itself to an assumed ONE-wire-per-endpoint Phase-37
    /// topology. That assumption is what broke on a board where two callers share one
    /// handler: the handler has TWO outgoing cables and this function takes the lowest
    /// `NodeId`, so the second caller's reply rode the first caller's cable (WINDOWS 124).
    /// The return question is now asked by [`return_wire_from`](Self::return_wire_from),
    /// which is a SEPARATE function rather than an `Option` parameter here precisely so a
    /// future caller cannot re-create that defect by passing `None` at the return site
    /// with no diff a reviewer would notice.
    ///
    /// Read-only, no authority (mirrors [`link_target`](Self::link_target)).
    pub fn wire_from_node(&self, node: NodeId) -> Option<NodeId> {
        self.nodes.iter().find_map(|(&id, n)| match n {
            Node::Wire(link) if link.from.0 == node => Some(id),
            _ => None,
        })
    }

    /// WHICH WIRE OUT OF THIS NODE POINTS AT THAT CALLER (the RETURN question).
    /// ADDRESS-EXACT on the DESTINATION half.
    ///
    /// The live `Node::Wire` whose `from.node == from` AND whose `to.node == toward`.
    /// [`route_replies`](crate::tick) calls it with `toward = reply.return_addr.0`, the
    /// address the reply CARRIES, so a reply can only ever be admitted to a cable that
    /// actually points at the caller it is owed to. A handler with two return cables
    /// therefore sends each caller's answer home on that caller's own cable, and a reply
    /// naming an address no cable points at is dropped rather than misdelivered.
    ///
    /// # Why this is a second function and not a parameter on `wire_from_node`
    /// The two lookups are two different questions with two different precision rules,
    /// and D-19 rules them differently on measured evidence (see
    /// [`wire_from_node`](Self::wire_from_node)). Folding them into one function with an
    /// optional destination would let a caller at the return site pass "no destination"
    /// and silently restore the lowest-`NodeId` scan that WINDOWS 124 records.
    ///
    /// Note the asymmetry is on the DESTINATION half, not the source half: both functions
    /// match `from.node` node-only and ignore the source PORT. Only this one constrains
    /// where the cable goes.
    ///
    /// Ascending-`NodeId` FIRST among cables that satisfy BOTH endpoints, which is a
    /// defined deterministic tie-break (`nodes` is a `BTreeMap`) for the case of two
    /// parallel cables between the same pair of nodes. Read-only, no authority.
    pub fn return_wire_from(&self, from: NodeId, toward: NodeId) -> Option<NodeId> {
        self.nodes.iter().find_map(|(&id, n)| match n {
            Node::Wire(link) if link.from.0 == from && link.to.0 == toward => Some(id),
            _ => None,
        })
    }

    /// Set (or move) `id`'s logical grid cell (SPAT-01), maintaining the derived
    /// reverse [`occupancy`](Self::occupied) index as a FAITHFUL bijection of
    /// `cells` (WR-09-01).
    ///
    /// Two invariants are enforced at this single mutation site rather than
    /// trusted to every caller:
    /// 1. **No stale reverse entry on a move** — the node's PRIOR cell is dropped
    ///    from `occupancy` (if it still points at this node) before the new cell is
    ///    indexed.
    /// 2. **`cells` is INJECTIVE on positions** (one node per cell) — if the target
    ///    cell is already held by a DIFFERENT node, that node's `cells` entry is
    ///    evicted so `cells`↔`occupancy` stays a true bijection. This is what makes
    ///    the live `occupancy` index byte-identical to what
    ///    [`rebuild_occupancy`](Self::rebuild_occupancy) reconstructs from `cells`
    ///    after a snapshot round-trip: a live `Core` and its restored twin can never
    ///    disagree on [`occupied`](Self::occupied).
    ///
    /// The eviction path is unreachable through the validated fold (the command
    /// layer rejects a same-cell `Place`, and [`fold_place`](crate::tick) only ever
    /// `set_cell`s a freshly-minted id), so the golden corpus is untouched; the
    /// guard only defends a rogue/future caller from silently desyncing the index.
    /// Belts minted by a `Wire` never call it (they stay cell-less).
    pub fn set_cell(&mut self, id: NodeId, cell: (i32, i32)) {
        // (1) Drop this node's stale reverse entry on a move.
        if let Some(old) = self.cells.insert(id, cell)
            && self.occupancy.get(&old) == Some(&id)
        {
            self.occupancy.remove(&old);
        }
        // (2) Index the new cell; if a DIFFERENT node held it, evict that node's
        // `cells` entry to keep `cells` injective on positions (bijective with
        // `occupancy`, matching `rebuild_occupancy`).
        if let Some(prev) = self.occupancy.insert(cell, id)
            && prev != id
        {
            self.cells.remove(&prev);
        }
    }

    /// Claim a full multi-cell [`Footprint`] for `id` (FOOT-01) — the multi-cell
    /// **generalization** of [`set_cell`](Self::set_cell). Records `anchor` (the
    /// min-corner) as `id`'s canonical cell, then expands the rectangle via
    /// [`cells_of_footprint`] and indexes EVERY body cell into the single
    /// [`occupancy`](Self::occupied) index → `id`. A `footprints[id]` entry is
    /// written ONLY when the shape is non-trivial (`w > 1 || h > 1 || rot != 0`);
    /// an absent entry means the faithful 1×1-rot0 default, so an all-1×1 grid
    /// stays byte-identical to the v1.0 point machine (no map entry).
    ///
    /// # CLAIM, never EVICT (the anti-pattern `set_cell` carries)
    /// Unlike `set_cell` — whose injective-on-positions eviction silently overwrites
    /// a colliding node — `claim_footprint` ASSERTS/TRUSTS the cells are free: the
    /// command layer (10-04) rejects a colliding placement BEFORE the fold, and
    /// [`fold_place`](crate::tick) only ever claims a freshly-minted id, so no
    /// eviction is ever needed on the validated path. Silently overwriting a
    /// multi-cell body would be the wrong default (threat T-9-04 / RESEARCH
    /// §Atomic Multi-Cell Collision: claim/reject, never evict). For a 1×1 with no
    /// footprint entry this is behaviourally identical to `set_cell` on a fresh
    /// mint (one occupancy entry, no map entry written). Ports are written
    /// separately via [`set_ports`](Self::set_ports) (only when non-empty), keeping
    /// the port-less corpus byte-faithful.
    pub fn claim_footprint(&mut self, id: NodeId, anchor: (i32, i32), w: u16, h: u16, rot: u8) {
        // The anchor (min-corner) is the node's canonical cell.
        self.cells.insert(id, anchor);
        // CLAIM every body cell into the single occupancy index (never evict).
        for cell in cells_of_footprint(anchor, w, h, rot) {
            self.occupancy.insert(cell, id);
        }
        // Write a footprints entry ONLY for a non-trivial shape (absent ⇒ 1×1 rot0,
        // the faithful default that keeps all-1×1 grids minimal/byte-identical).
        if w > 1 || h > 1 || rot != 0 {
            self.footprints.insert(id, Footprint { w, h, rot });
        }
    }

    /// Rotate `id`'s footprint in place to the ABSOLUTE `new_rot` (FOOT-02, 10-06) —
    /// an anchor-preserving pivot. Frees `id`'s current footprint cells from
    /// occupancy, re-stamps its orientation (anchor unchanged), re-expands the
    /// new-rot rectangle into occupancy, then SELECTIVELY UNLINKS only the docked
    /// belts the rotated ports can no longer reach (CAT-06, the SPIKE, decision "a").
    ///
    /// # Selective de-dock (was: unconditional cascade-destroy)
    /// Because a dock is a directed `links` entry keyed LOGICALLY on `(node, port)`
    /// and a port id is invariant under rotation, a KEPT dock "follows its port" to
    /// the new world cell for free — no link is ever rewritten to keep a dock. The
    /// only behavioural change is: for each directed dock incident to `id`, KEEP it
    /// iff the rotated port still FACES the belt's docked end-tile (the facing-side
    /// mirror of the `validate_normalize` dock-accept predicate, `command.rs:442-455`,
    /// via [`dock_still_reaches`](Self::dock_still_reaches)); otherwise drop JUST that
    /// one link ([`unlink`](Self::unlink)) and record an [`UnlinkedDock`]. The belt
    /// NODE always SURVIVES — never `remove_node`d, never re-drawn (A* is a locked
    /// anti-feature). Its AR-3 wake is untouched, so a de-docked belt keeps ticking.
    ///
    /// Landmine 1 (both-ends): the candidate walk iterates the RAW `self.links` (one
    /// verdict per directed dock), NOT the deduped [`docked_wire_belts`](Self::docked_wire_belts)
    /// — a belt docked Head+Tail to the same rotating node gets TWO independent
    /// verdicts (one end may survive while the other de-docks). Candidates are
    /// collected FIRST (never mutate `links` while iterating), in ascending
    /// `(NodeId, PortId)` key order (the certified cascade order), so the returned
    /// `Vec<UnlinkedDock>` is a stable, byte-replayable telemetry surface.
    ///
    /// A node with no cell (absent, or a `Wire`-minted belt) is a panic-free no-op
    /// (returns EMPTY, claims nothing). A 1×1 is an occupancy no-op (its single
    /// anchor cell is unchanged) but still re-stamps `rot` (so a port-bearing 1×1's
    /// world-side spins) AND re-judges its docked belts. The `absent ⇒ 1×1-rot0`
    /// convention is preserved: a rotation that lands back on a trivial `1×1 rot0`
    /// shape REMOVES the `footprints` entry (so a BARE-machine `rotate90⁴` returns
    /// byte-identical), while every non-trivial shape writes/updates one. (A DOCKED
    /// machine's 4-turn is NOT identity — turn 1 may de-dock and the link is not
    /// restored on turn 4; Landmine 4.)
    ///
    /// THAT SEVERANCE IS NO LONGER PERMANENT ABOVE THIS LAYER (Phase 67-03, decision
    /// D2). Nothing in the paragraph above moved: `GridState` still severs, and a docked
    /// 4-turn is still not identity AT THIS LEVEL. What changed is that the command
    /// layer's undo path emits one compensating `EditOp::Dock` per link the rotate
    /// severed, read off `last_tick.unlinked` at fold time, so
    /// undo re-docks what turn 1 severed. The two notes are held in parity by
    /// `crates/fabrico-command/tests/rotate_undo_redock.rs`, which reads BOTH files off
    /// disk and asserts each quoted fragment appears exactly once in each; do not
    /// re-quote them elsewhere. This note closes a known-gap item deferred from
    /// Phase 67 because the byte-freeze reddened a comment-only edit
    /// here exactly as it reddened a code edit.
    ///
    /// Applied VERBATIM — NO collision re-check here (legality was decided by
    /// `validate_normalize`, decision Q2). Mirrors [`claim_footprint`](Self::claim_footprint)'s
    /// CLAIM-never-EVICT discipline on the re-expand. The de-dock is a deterministic
    /// DERIVED consequence of `Rotate` (recomputable from frozen geometry + `new_rot`
    /// on every replay), so `EditOp::Rotate`'s byte shape is UNCHANGED (A3, no logged op).
    pub(crate) fn rotate_footprint(&mut self, id: NodeId, new_rot: u8) -> Vec<UnlinkedDock> {
        // No-op for a node with no cell (absent / a Wire-minted belt).
        let Some(anchor) = self.cells.get(&id).copied() else {
            return Vec::new();
        };
        let new_rot = new_rot & 3;
        // Read the current dims + orientation (absent ⇒ 1×1 rot0) and free every old
        // body cell this node still owns from occupancy.
        let (w, h, old_rot) = match self.footprints.get(&id) {
            Some(fp) => (fp.w, fp.h, fp.rot),
            None => (1, 1, 0),
        };
        for cell in cells_of_footprint(anchor, w, h, old_rot) {
            if self.occupancy.get(&cell) == Some(&id) {
                self.occupancy.remove(&cell);
            }
        }
        // Re-stamp the orientation (anchor fixed), keeping the `absent ⇒ 1×1-rot0`
        // convention: a trivial 1×1-rot0 shape writes NO entry (so a full turn returns
        // byte-identical), every other shape writes/updates one.
        if w == 1 && h == 1 && new_rot == 0 {
            self.footprints.remove(&id);
        } else {
            self.footprints.insert(id, Footprint { w, h, rot: new_rot });
        }
        // Re-expand the new-rot rectangle into occupancy (CLAIM, never evict).
        for cell in cells_of_footprint(anchor, w, h, new_rot) {
            self.occupancy.insert(cell, id);
        }
        // --- Selective de-dock, through the ONE shared machinery ---
        // The candidate collection, the unlink and the record all live in
        // [`judge_docks`](Self::judge_docks); what `Rotate` supplies is its VERDICT.
        // Rotate's verdict is the FACING-SIDE one: a dock that still reaches keeps the
        // key it already had (`Some(port)`), and one that does not is released (`None`).
        // A rotate never re-keys, because a rotate never changes the port LIST.
        //
        // 73-12: a WIRE endpoint is never disturbed by a rotate and the verdict says so
        // explicitly rather than by omission. A rotate severs a BELT dock because the port
        // moves in world space and the belt's end-tile no longer abuts it; a wire has no
        // spatial endpoint to sever, and a rotate changes no port's INDEX, so both wire
        // arms keep the key they had. `docked_wires`'s docblock records the same rule from
        // the delete-cascade side.
        let judged = self.judge_docks(id, |state, port, other, end| match end {
            DockEnd::Belt(endpoint) => state
                .dock_still_reaches(id, anchor, w, h, new_rot, port, other, endpoint)
                .then_some(port),
            DockEnd::WireFrom | DockEnd::WireTo => Some(port),
        });
        debug_assert!(
            judged.released_wires.is_empty(),
            "a Rotate releases no wire: its verdict returns Some for every wire candidate"
        );
        judged.unlinked
    }

    /// The ONE keep-or-re-key-or-release machinery every fold that disturbs a machine's
    /// docks runs through, with the VERDICT passed in (73-06, D-07).
    ///
    /// Collect one candidate per attachment incident to `id` FIRST (never mutating `links`
    /// or `nodes` while iterating). Belts come from `links` in ascending
    /// `(NodeId, PortId)` `BTreeMap` key order, then wires from `nodes` in ascending
    /// `NodeId` order:
    ///   - Head dock: `(belt,0) -> (id, port)` => `to.0 == id`, belt = `from.0`, key = `(belt,0)`
    ///   - Tail dock: `(id, port) -> (belt,0)` => `from.0 == id`, belt = `to.0`, key = `(id,port)`
    ///   - `WireFrom`: a `Node::Wire` whose `WireLink.from.0 == id`, port = `from.1`
    ///   - `WireTo`: a `Node::Wire` whose `WireLink.to.0 == id`, port = `to.1`
    ///
    /// # WIRES ARE COLLECTED FROM `nodes`, NOT FROM `links` (73-12, 73-REVIEW CR-02)
    /// A drawn wire's ONLY `links` entry is the forward `(wire, 0) -> to` edge, so a
    /// `links` walk sees a wire when the machine is its TARGET and misses every wire whose
    /// SOURCE is the machine. That is the shipped demo board's return cable, and it is the
    /// same trap [`docked_wires`](Self::docked_wires) records: a wire needs a different
    /// WALK, not a different matcher.
    ///
    /// A wire endpoint is a RAW CATALOG INDEX, exactly like a Head dock's link key - which
    /// is why extending this seam was the whole fix rather than a second predicate. Until
    /// 73-12 the collection took belts alone, so `fold_remove_port` shifted every catalog
    /// index above the removed port and left every wire endpoint naming whatever port now
    /// sat at the old number.
    ///
    /// Then apply `verdict` to each candidate in that order, then unlink and record. That
    /// ORDER is not stylistic: determinism and the certified cascade order both depend on
    /// it, and so does the byte-replayability of the returned `Vec<UnlinkedDock>`.
    ///
    /// # The verdict returns `Option<PortId>`, and the three answers are distinct
    /// - `Some(k)` where `k` equals the candidate's current machine-side port: KEEP,
    ///   untouched.
    /// - `Some(k)` where `k` differs: KEEP but RE-KEY to `k`. For a Tail dock that rewrites
    ///   the link's KEY (`(id, old) -> (id, k)`); for a Head dock it rewrites the link's
    ///   VALUE (`(belt,0) -> (id, k)`); for `WireFrom` it rewrites `WireLink.from.1`; for
    ///   `WireTo` it rewrites `WireLink.to.1` AND the `(wire,0)` link's VALUE, which are
    ///   the two recordings of that one endpoint. The neighbour NODE is never touched.
    /// - `None`: RELEASE. For a belt the one directed link is dropped and an
    ///   [`UnlinkedDock`] is recorded, so the command layer's undo can emit a compensating
    ///   `Dock`; the belt node survives disconnected. For a wire the id is REPORTED on
    ///   [`JudgedDocks::released_wires`] and the caller removes it, because a wire has no
    ///   representable disconnected state - `WireLink.from`/`.to` are non-optional pairs.
    ///
    /// # THE VERDICTS DIFFER PER CALLER BY DESIGN, and that is the point of this seam
    /// Sharing the verdict would be WRONG, and the cost of getting that backwards is a
    /// user-visible defect rather than a style question. Today there are two verdicts
    /// (a Rotate's, and the one both port edits share) and phase 76's SHAPE-06 may add a
    /// third:
    ///
    /// - [`rotate_footprint`](Self::rotate_footprint) asks a GEOMETRY question: the port
    ///   LIST is unchanged and only the nub's facing moved, so `dock_still_reaches` is the
    ///   right predicate and no dock is ever re-keyed.
    /// - `fold_remove_port` and `fold_add_port` (`tick.rs`) ask IDENTITY, THEN FACING
    ///   (74.1-12). Identity first: the port list changed, so the dock that named a
    ///   removed port is released and every other dock is re-keyed to keep naming the
    ///   port it named. Then facing, for a belt only: a re-keyed belt dock is kept only
    ///   while `dock_still_reaches` says its port still faces the belt end, and is
    ///   released with its pre-edit key otherwise. A kept link must touch its port, or the
    ///   user sees a belt drawn onto nothing (the reseat hole, 74.1-SEAM-DESIGN.md section
    ///   3). A wire keeps the identity verdict: it routes and has no doorstep.
    ///
    ///   WHAT THE FACING HALF CATCHES CHANGED TWICE. From 74.1-12 to 74.1-16 every port
    ///   edit re-seated the whole list (`reseat_ports`), so removing an output moved every
    ///   later output into the previous slot and the facing half released their belts too;
    ///   that reversed UNDO-06's "exactly one strand". This was caught in manual testing,
    ///   and it was ruled on 2026-10-04 that a port edit moves no existing port (existing
    ///   ports are not auto-arranged). Since 74.1-16 the folds write [`add_port_geometry`] and
    ///   [`remove_port_geometry`], which keep every slot, so on a command-built board a
    ///   removal releases only the removed port's own docks (by identity) and an accepted
    ///   add releases nothing; the facing half stays as the forged-log defence.
    /// - A footprint resize (phase 76) asks whichever of those its own change implies.
    ///
    /// Write a NEW verdict for a new caller. Do not write a second copy of this function:
    /// two hand-maintained copies of the machinery is the drift D-07 exists to prevent,
    /// and it is the same defect shape 67-REVIEW WR-04 merged out of `attribute_severances`.
    ///
    /// The verdict is handed `&Self` rather than capturing it, so a caller's closure can
    /// read live state (as `Rotate`'s does) while this method holds `&mut self`.
    pub(crate) fn judge_docks<F>(&mut self, id: NodeId, mut verdict: F) -> JudgedDocks
    where
        F: FnMut(&Self, PortId, NodeId, DockEnd) -> Option<PortId>,
    {
        // (link_key, machine_port, neighbour, end). `link_key` is meaningless for a
        // `WireFrom` candidate (a wire's source endpoint has no `links` entry) and is
        // carried as the wire's own `(wire, 0)` key so the tuple stays one shape.
        let mut candidates: Vec<((NodeId, PortId), PortId, NodeId, DockEnd)> = Vec::new();
        for (&from, &to) in &self.links {
            if to.0 == id && matches!(self.nodes.get(&from.0), Some(Node::Belt(_))) {
                // Head dock: the belt delivers INTO this machine.
                candidates.push((from, to.1, from.0, DockEnd::Belt(crate::edit::BeltEnd::Head)));
            } else if from.0 == id && matches!(self.nodes.get(&to.0), Some(Node::Belt(_))) {
                // Tail dock: this machine offloads onto the belt.
                candidates.push((from, from.1, to.0, DockEnd::Belt(crate::edit::BeltEnd::Tail)));
            }
        }
        // 73-12 (73-REVIEW CR-02): THE WIRE ENDPOINTS, COLLECTED FROM `nodes` AND NOT FROM
        // `links`, for the reason [`docked_wires`](Self::docked_wires) states in capitals.
        // A drawn wire's ONLY `links` entry is the forward `(wire, 0) -> to` one, so a
        // `links` walk finds a wire when the machine is its TARGET and misses every wire
        // whose SOURCE is the machine - which is exactly the shipped demo board's return
        // cable. Widening the `matches!` in the loop above would be a HALF fix that looks
        // like a whole one. `nodes` is a `BTreeMap`, so ascending-`NodeId` is
        // deterministic, and a wire naming this machine at BOTH ends contributes two
        // independent candidates because its two endpoints are two ports.
        for (&wire_id, node) in &self.nodes {
            if let Node::Wire(link) = node {
                if link.from.0 == id {
                    candidates.push(((wire_id, 0), link.from.1, wire_id, DockEnd::WireFrom));
                }
                if link.to.0 == id {
                    candidates.push(((wire_id, 0), link.to.1, wire_id, DockEnd::WireTo));
                }
            }
        }
        // Every verdict is taken FIRST, against the state as the candidate collection saw
        // it, so no closure can observe a half-applied re-key.
        let verdicts: Vec<Option<PortId>> = candidates
            .iter()
            .map(|&(_, port, other, end)| verdict(self, port, other, end))
            .collect();

        // VACATE, THEN WRITE, and never interleave the two. A verdict may move a Tail key
        // UP as easily as down (a port INSERT shifts every key above it up by one), and
        // under a single interleaved pass an upward move writes into a slot a later
        // candidate still occupies and silently destroys that candidate's link. Removing
        // every moving key before writing any of them makes the pass independent of the
        // direction the keys travel, which is what lets the two callers' verdicts differ
        // without this machinery having to know which one it is serving.
        //
        // A FACTORY'S WAITING EMITS MOVE WITH THEIR PORT (87-REVIEW CR-01). A Tail dock
        // that is re-keyed, not released, keeps its belt, so the items queued for that
        // port (`Factory::pending_emits`, keyed by the same Out routing key) still have
        // somewhere to go. `unlink` drops and counts the queue on the key it removes, so
        // every moving queue is taken out HERE, before the vacate pass, and written back
        // on its new key after the relink pass; taking them all out first is what keeps
        // two queues swapping keys from clobbering each other, as the links do above. A
        // released dock (`None`) keeps its queue in place, so `unlink` drops and counts it.
        let mut carried: Vec<(PortId, VecDeque<Item>)> = Vec::new();
        if let Some(Node::Factory(factory)) = self.nodes.get_mut(&id) {
            for (&(_, port, _, end), v) in candidates.iter().zip(&verdicts) {
                if let (Some(new_port), DockEnd::Belt(crate::edit::BeltEnd::Tail)) = (v, end)
                    && *new_port != port
                    && let Some(queue) = factory.pending_emits.remove(&port)
                {
                    carried.push((*new_port, queue));
                }
            }
        }
        for (&(link_key, port, _, end), v) in candidates.iter().zip(&verdicts) {
            let moves = match v {
                None => true,
                Some(new_port) => *new_port != port,
            };
            // Only a Tail dock is keyed BY the machine port, so only a Tail re-key vacates
            // anything. A Head dock is keyed by the BELT and its re-key rewrites the link's
            // VALUE in place, which can never collide - and BOTH wire edges are keyed by
            // the WIRE's own port 0, so neither can collide either.
            if moves && matches!(end, DockEnd::Belt(crate::edit::BeltEnd::Tail)) {
                self.unlink(link_key);
            }
        }

        let mut unlinked = Vec::new();
        let mut released_wires = Vec::new();
        for (&(link_key, port, other, end), v) in candidates.iter().zip(&verdicts) {
            match (v, end) {
                (Some(new_port), DockEnd::Belt(crate::edit::BeltEnd::Tail)) => {
                    // Re-written even when the key did not move, because the vacate
                    // pass above left an unmoved Tail key in place and a moved one
                    // absent; writing unconditionally is the same map either way.
                    self.link((id, *new_port), (other, 0));
                }
                (Some(new_port), DockEnd::Belt(crate::edit::BeltEnd::Head)) => {
                    self.link(link_key, (id, *new_port));
                }
                (Some(new_port), DockEnd::WireFrom) => {
                    if let Some(Node::Wire(w)) = self.nodes.get_mut(&other) {
                        w.from.1 = *new_port;
                    }
                }
                (Some(new_port), DockEnd::WireTo) => {
                    // BOTH recordings of the one endpoint, or the fix mis-delivers: the
                    // `WireLink.to` field is what the render layer resolves the nub from,
                    // and the `(wire, 0)` link VALUE is what the fold delivers through.
                    if let Some(Node::Wire(w)) = self.nodes.get_mut(&other) {
                        w.to.1 = *new_port;
                    }
                    self.link((other, 0), (id, *new_port));
                }
                (None, DockEnd::Belt(endpoint)) => {
                    // Already vacated above for a Tail. A released HEAD dock is keyed by
                    // the belt, so it is dropped here.
                    if matches!(endpoint, crate::edit::BeltEnd::Head) {
                        self.unlink(link_key);
                    }
                    unlinked.push(UnlinkedDock {
                        belt: other,
                        endpoint,
                        node: id,
                        port,
                    });
                }
                (None, DockEnd::WireFrom | DockEnd::WireTo) => {
                    // REPORTED, never removed here. `remove_node` cascades and the caller
                    // owes `sched.remove` for every id it returns (the AR-3 pairing), and
                    // this type holds no scheduler. Deduplicated because a self-loop wire
                    // can be released at both of its ends in one pass.
                    if !released_wires.contains(&other) {
                        released_wires.push(other);
                    }
                }
            }
        }
        // The carried queues go back on their new keys, now that every re-keyed Tail link
        // is written (87-REVIEW CR-01). Two queues can meet on one key only through a
        // forged log whose verdict maps two docks onto one port; they are then joined in
        // candidate order and anything past the trust gate's bound (under
        // `FACTORY_EMITS_PER_PORT`) is dropped and counted, so the board still saves.
        if let Some(Node::Factory(factory)) = self.nodes.get_mut(&id) {
            let bound = crate::factory::FACTORY_EMITS_PER_PORT - 1;
            for (port, queue) in carried {
                let slot = factory.pending_emits.entry(port).or_default();
                slot.extend(queue);
                if slot.len() > bound {
                    let excess = u64::try_from(slot.len() - bound).unwrap_or(u64::MAX);
                    slot.truncate(bound);
                    factory.faults = factory.faults.saturating_add(excess);
                }
            }
        }
        JudgedDocks {
            unlinked,
            released_wires,
        }
    }

    /// Write a port edit's [`PortEditGeometry`] onto `id` (plan 74.1-16): free the old
    /// body cells, write the anchor, the footprint and the ports, and claim the new cells,
    /// in [`rotate_footprint`](Self::rotate_footprint)'s CLAIM-never-EVICT discipline.
    ///
    /// The geometry is computed by [`add_port_geometry`] or [`remove_port_geometry`], the
    /// SAME functions the command layer's `AddPort` validate arm collision-checks, so this
    /// writes exactly the box that was accepted. It replaces the pre-74.1-16
    /// `resize_footprint_for_ports`, which re-seated every port by list position on every
    /// edit and grew the box with its anchor fixed (review WR-01).
    ///
    /// Applied VERBATIM, no collision re-check (legality is decided at command validate
    /// time). A node with no cell (absent, or a `Wire`-minted belt) is a panic-free no-op
    /// that writes NO map entry (threat T-36-04). The absent-means-default conventions are
    /// kept: a trivial `1x1 rot0` footprint REMOVES the `footprints` entry and an empty port
    /// list REMOVES the `ports` entry, so a port-less or 1x1 machine stays byte-faithful.
    pub(crate) fn write_port_geometry(&mut self, id: NodeId, g: &PortEditGeometry) {
        let Some(old_anchor) = self.cells.get(&id).copied() else {
            return;
        };
        // Free every OLD body cell this node still owns (absent footprint is 1x1 rot0).
        let (w0, h0, rot0) = match self.footprints.get(&id) {
            Some(fp) => (fp.w, fp.h, fp.rot),
            None => (1, 1, 0),
        };
        for cell in cells_of_footprint(old_anchor, w0, h0, rot0) {
            if self.occupancy.get(&cell) == Some(&id) {
                self.occupancy.remove(&cell);
            }
        }
        // The anchor (a growing add on a turned machine shifts it; nothing else does).
        self.cells.insert(id, g.anchor);
        let fp = g.footprint;
        if fp.w == 1 && fp.h == 1 && fp.rot == 0 {
            self.footprints.remove(&id);
        } else {
            self.footprints.insert(id, fp);
        }
        if g.ports.is_empty() {
            self.ports.remove(&id);
        } else {
            self.ports.insert(id, g.ports.clone());
        }
        // Re-claim the NEW body cells into occupancy (CLAIM, never evict).
        for cell in cells_of_footprint(g.anchor, fp.w, fp.h, fp.rot) {
            self.occupancy.insert(cell, id);
        }
    }

    /// The fold's copy of the dock-accept predicate (the `GridCommand::Dock` validate
    /// arm in `fabrico-command`): after rotating machine `node` (footprint
    /// `anchor,w,h`) to `new_rot`, does its port `port_id` still FACE the docked
    /// `endpoint` end-tile of `belt`? (CAT-06.)
    ///
    /// # Machine targets only, and that is measured (plan 74.1-15)
    /// This is the fold's copy of the MACHINE branch of the Dock arm (the doorstep rule)
    /// and it has no belt branch, because no fold ever asks it about a belt target. Its
    /// three callers each pass the EDITED node as `node`, and each of those folds is a
    /// no-op for a cell-less belt before it reaches the call:
    ///
    /// - `rotate_footprint` (this file, the `judge_docks` verdict), reached from
    ///   `fold_rotate` (`tick.rs`); it returns early when `node` has no `cells` entry.
    /// - `fold_add_port` (`tick.rs`); it returns early on `cell_of(node).is_none()`.
    /// - `fold_remove_port` (`tick.rs`); the same early return.
    ///
    /// A belt records no `cells` entry, so `node` is always a placed machine here. Plan
    /// 74.1-15 widened the Dock arm's BELT branch (a carrier end one orthogonal step from
    /// a belt target's end, not on its inner tile) and left the machine branch byte for
    /// byte, so this predicate did not move and no replay byte did either. A belt arm
    /// added here would be a check no path reaches.
    ///
    /// KEEP iff the port's NEW facing cell `(pcell + unit_delta(pside))` is the belt's
    /// end cell AND, for a multi-tile belt only, the belt's outward side is NOT the
    /// port's own side. An outward equal to the port side is the one geometry where the
    /// carrier's inner tile sits on the port's own cell; a belt that leaves the facing
    /// cell straight (outward opposite the port side) or turns at it (outward
    /// perpendicular) is kept. This is the SAME two-part check `validate_normalize`
    /// accepts a dock with, narrowed together with it in phase 74.1 (D-02), so a dock is
    /// judged by one rule when it is made and every time its machine turns. The refused
    /// term is reachable only from a forged or hand-edited log, because no command
    /// leaves a belt tile on a machine cell; it is kept as that defence (D-13). Pure
    /// `i32`; no float/trig.
    ///
    /// # Port edits ask it too (74.1-12)
    /// `fold_remove_port` and `fold_add_port` call this after their identity re-key, with
    /// the re-keyed port id and the machine's anchor, footprint and rotation after the
    /// edit, so a belt dock survives a port edit only while it still touches its port. See
    /// [`judge_docks`](Self::judge_docks)' "verdicts differ per caller" section for why,
    /// since 74.1-16, that releases nothing beyond the removed port's own docks on a
    /// command-built board.
    ///
    /// # The replay change this narrowing declared (phase 74.1, CORNER-06)
    /// Nothing in the log carries this verdict, so narrowing it changed what a replay
    /// produces, and only here: a quarter turn of a `w x (2w + 1)` machine (or its
    /// transpose) docked at the middle port of a long edge, with the belt's outward
    /// opposite the port side before the turn. The port's facing cell survives that
    /// turn and the belt's outward becomes perpendicular to the new side, which the
    /// pre-74.1 clause released and this one keeps. Declared as a
    /// golden move in plan 74.1-03 and pinned as geometry by
    /// `crates/fabrico-core/tests/dock_facing_rotate.rs`.
    ///
    /// De-dock (`false`) when the dock cannot reach: a port-less node (Landmine 6), a
    /// link key with no matching port, a `FAULT_PORT` on a node with no `Role::Fault`
    /// nub, or a geometry-less (Wire-minted) belt. The belt end itself is resolved by
    /// [`belt_end_world`], the ONE definition this crate and `fabrico-command` now
    /// share (LINK-11), which is also where the single-tile case (Landmine 3) is
    /// handled: it yields an end cell with NO inherent outward direction, so adjacency
    /// plus facing alone decides for it, with no panic.
    ///
    /// # Two link keyspaces
    /// A dock link key is NOT always a catalog array index. The rule that resolves it is
    /// written ONCE, in [`resolve_link_port`](Self::resolve_link_port), which this
    /// predicate and the seam derivation ([`effective_belt_tiles`](Self::effective_belt_tiles))
    /// both call; its docblock carries the keyspace table.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn dock_still_reaches(
        &self,
        node: NodeId,
        anchor: (i32, i32),
        w: u16,
        h: u16,
        new_rot: u8,
        port_id: PortId,
        belt: NodeId,
        endpoint: crate::edit::BeltEnd,
    ) -> bool {
        // Resolve the rot-0 port declaration IN THE LINK KEY'S KEYSPACE, through the one
        // shared resolver. `None` covers a port-less node (Landmine 6), a FAULT_PORT on a
        // node with no Fault nub, a missing n-th Out and an out-of-range catalog index:
        // every one of them cannot reach.
        let Some(port) = self.resolve_link_port(node, port_id, endpoint) else {
            return false;
        };
        // The belt's docked end-tile + its outward side, through the SINGLE shared
        // definition ([`belt_end_world`], LINK-11). A Wire-minted belt (empty geometry)
        // has no spatial endpoint, and neither does a forged non-contiguous one, so both
        // answer `None` => de-dock. This block used to write the derivation out longhand
        // and comment itself as a mirror of a `command.rs` line number that had rotted;
        // the resolver is named directly now, so there is nothing left to rot.
        let Some(Node::Belt(b)) = self.nodes.get(&belt) else {
            return false;
        };
        let Some((end_cell, outward)) = belt_end_world(&b.geometry, endpoint) else {
            return false;
        };
        // The port's NEW world cell + facing side; its facing cell must land EXACTLY on
        // the belt end-tile (facing-adjacency), and (multi-tile only) the belt's
        // outward side must not be the port's own side (the carrier's inner tile would
        // be the port's cell). Narrowed in phase 74.1 with the command layer (D-02).
        let (pcell, pside) = port_world(anchor, w, h, new_rot, &port);
        let (dx, dy) = unit_delta(pside);
        if (pcell.0 + dx, pcell.1 + dy) != end_cell {
            return false;
        }
        if let Some(o) = outward
            && o == pside
        {
            return false;
        }
        true
    }

    /// THE ONE LINK-KEY-TO-PORT RESOLVER: the rot-0 [`Port`] declaration a dock link key
    /// names on machine `node`, for a dock at the belt's `endpoint`. Read by
    /// [`dock_still_reaches`](Self::dock_still_reaches) (does a kept dock still face after a
    /// Rotate?) and by the seam derivation's `seam_flow` (which way does a docked machine
    /// push or take items at the seam?), so the keyspace rule has exactly one copy.
    ///
    /// # Two link keyspaces (Finding 1, the mirror of command.rs's forward translation)
    /// A dock link key is NOT always a catalog array index; it lives in the keyspace the
    /// fold ROUTES on, resolved per endpoint:
    /// - `FAULT_PORT` (the routed sentinel) resolves to the node's `Role::Fault` port
    ///   (17-04 reconciliation).
    /// - A `Tail` (offload) key is an Out ROUTING key, the 0-based index among the node's
    ///   `Role::Out` ports (machines emit on 0..n-outs; command.rs freezes the dock in that
    ///   keyspace), so it resolves via a `Role::Out`-filtered `nth()`.
    /// - A `Head` (load) key is the raw catalog index (In ports come FIRST in every catalog
    ///   entry, so the inbox key == the catalog index; no translation).
    ///
    /// `None` when nothing spatial answers: a port-less node, a `FAULT_PORT` on a node with
    /// no Fault nub, a missing n-th Out, or an out-of-range catalog index. Read-only.
    fn resolve_link_port(
        &self,
        node: NodeId,
        port_id: PortId,
        endpoint: crate::edit::BeltEnd,
    ) -> Option<Port> {
        let ports = self.ports.get(&node)?;
        if port_id == crate::fault::FAULT_PORT {
            return ports.iter().find(|p| p.role == Role::Fault).copied();
        }
        match endpoint {
            crate::edit::BeltEnd::Tail => ports
                .iter()
                .filter(|p| p.role == Role::Out)
                .nth(port_id as usize)
                .copied(),
            crate::edit::BeltEnd::Head => ports.get(port_id as usize).copied(),
        }
    }

    /// The flow [`Dir`] across the seam between belt end tile `end_cell` and the partner
    /// `(node, port_id)` it is linked to, or `None` when the partner does not spatially
    /// meet that tile. `endpoint` is THIS belt's end: `Tail` when the partner FEEDS the
    /// belt (the link targets `(belt, 0)`), `Head` when the belt DRAINS into the partner
    /// (the link is keyed `(belt, 0)`).
    ///
    /// - A BELT partner counts only when its matching end cell (its Head for a feed, its
    ///   Tail for a drain) is exactly one orthogonal step from `end_cell`. The flow is that
    ///   CELL STEP (partner end to this end for a feed, this end to partner end for a
    ///   drain), never the partner's own outward side. Since plan 74.1-15 the Dock arm
    ///   accepts a belt join from either belt (the carrier end one orthogonal step from
    ///   the target end, not on its inner tile), so EITHER belt may turn at the seam, and
    ///   both may: the cell step is what says which.
    /// - A MACHINE partner is resolved in the link key's keyspace by
    ///   [`resolve_link_port`](Self::resolve_link_port), placed with [`port_world`] at its
    ///   CURRENT rotation, and counts only when its facing cell IS `end_cell`. An Out or a
    ///   Fault pushes items along its side; an In takes them against it.
    /// - Every other partner (no node, a geometry-less belt, a port-less node, an
    ///   unresolvable key, or anything that does not meet the tile) answers `None`, and the
    ///   caller keeps the stored kind. Nothing here invents a cell.
    fn seam_flow(
        &self,
        end_cell: (i32, i32),
        node: NodeId,
        port_id: PortId,
        endpoint: crate::edit::BeltEnd,
    ) -> Option<Dir> {
        if let Node::Belt(partner) = self.nodes.get(&node)? {
            let (from, to) = match endpoint {
                // The partner feeds: its HEAD meets our Tail, and items step from it to us.
                crate::edit::BeltEnd::Tail => (partner.geometry.last()?.cell, end_cell),
                // We drain into the partner: its TAIL meets our Head, items step to it.
                crate::edit::BeltEnd::Head => (end_cell, partner.geometry.first()?.cell),
            };
            let side = side_of_unit_delta((to.0 - from.0, to.1 - from.1))?;
            return Some(dir_toward(side));
        }
        let port = self.resolve_link_port(node, port_id, endpoint)?;
        let anchor = self.cells.get(&node).copied()?;
        let fp = self
            .footprints
            .get(&node)
            .copied()
            .unwrap_or(Footprint { w: 1, h: 1, rot: 0 });
        let (pcell, pside) = port_world(anchor, fp.w, fp.h, fp.rot, &port);
        let (dx, dy) = unit_delta(pside);
        if (pcell.0 + dx, pcell.1 + dy) != end_cell {
            return None;
        }
        Some(match port.role {
            Role::Out | Role::Fault => dir_toward(pside),
            Role::In => dir_toward(opposite(pside)),
        })
    }

    /// The belt's tiles AS DRAWN: its stored geometry with each DOCKED end re-kinded by
    /// [`seam_end_kind`] from what its seams say now (74.1-SEAM-DESIGN.md section 2).
    ///
    /// - Tail feeds are every link whose TARGET is `(belt, 0)`, in ascending link-key
    ///   (`BTreeMap`) order; the Head drain is the one link keyed `(belt, 0)`.
    /// - `tail_feeds` is the caller's PRECOMPUTED copy of that feed list. `None` walks the
    ///   link map here (O(links) per belt, the convenience form). The render packet passes
    ///   `Some`, read off ONE reverse link index it builds per packet and shares with its
    ///   dock list, so a whole packet costs O(links) rather than O(belts x links). A
    ///   caller passing `Some` owns its correctness: the same sources, in ascending
    ///   link-key order.
    /// - Each partner's flow comes from `seam_flow`. If ANY partner at an end does not
    ///   meet that end spatially (a forged link, a non-spatial key), that end keeps its
    ///   stored kind: a link no command would accept never draws a corner.
    /// - A single-tile belt takes both seams on its one tile; a multi-tile belt's Tail and
    ///   Head are judged separately, each against its own in/out direction.
    ///
    /// `None` for a non-belt (or absent) node; an EMPTY vector for a `Wire`-minted belt.
    ///
    /// # READ-ONLY, AND WHY THAT IS LOAD-BEARING
    /// This derives on every call and writes NOTHING back, so the fold, the snapshot, the
    /// edit log and the state hash all keep `route()`'s authored kind and no replay byte
    /// moves for a dock, an unlink, a rotate, an undo or a redo. The render packet
    /// (`fabrico-host` `render_packet.rs` `current_views`) is its display reader. If a
    /// future SIM reader needs a tile kind (a corner's length or speed), it must call this
    /// from inside the fold, and that is a declared replay move at that point.
    pub fn effective_belt_tiles(
        &self,
        belt: NodeId,
        tail_feeds: Option<&[(NodeId, PortId)]>,
    ) -> Option<Vec<BeltTile>> {
        let Node::Belt(b) = self.nodes.get(&belt)? else {
            return None;
        };
        let mut tiles = b.geometry.clone();
        let n = tiles.len();
        if n == 0 {
            return Some(tiles);
        }
        let tail_cell = tiles[0].cell;
        let head_cell = tiles[n - 1].cell;
        // The Tail feeds' flows; `None` overall when any feed does not meet the tile.
        let flow = |&(node, port): &(NodeId, PortId)| {
            self.seam_flow(tail_cell, node, port, crate::edit::BeltEnd::Tail)
        };
        let feeds: Option<Vec<Dir>> = match tail_feeds {
            Some(sources) => sources.iter().map(flow).collect(),
            None => self
                .links
                .iter()
                .filter(|(_, to)| **to == (belt, 0))
                .map(|(from, _)| flow(from))
                .collect(),
        };
        // The Head drain's flow: `Some(None)` when nothing is linked, `None` when the
        // linked partner does not meet the tile.
        let drain: Option<Option<Dir>> = match self.links.get(&(belt, 0)) {
            None => Some(None),
            Some(&(node, port)) => self
                .seam_flow(head_cell, node, port, crate::edit::BeltEnd::Head)
                .map(Some),
        };
        if n == 1 {
            if let (Some(feeds), Some(drain)) = (&feeds, drain) {
                tiles[0].kind = seam_end_kind(tiles[0].kind, None, None, feeds, drain);
            }
            return Some(tiles);
        }
        if let Some(feeds) = &feeds
            && let Some(own) =
                side_of_unit_delta((tiles[1].cell.0 - tail_cell.0, tiles[1].cell.1 - tail_cell.1))
        {
            let own = dir_toward(own);
            tiles[0].kind = seam_end_kind(tiles[0].kind, Some(own), Some(own), feeds, None);
        }
        if let Some(drain) = drain {
            let inner = tiles[n - 2].cell;
            if let Some(own) = side_of_unit_delta((head_cell.0 - inner.0, head_cell.1 - inner.1)) {
                let own = dir_toward(own);
                tiles[n - 1].kind =
                    seam_end_kind(tiles[n - 1].kind, Some(own), Some(own), &[], drain);
            }
        }
        Some(tiles)
    }

    /// The logical grid cell of `id`, if it has one (`Wire`-minted belts have none).
    pub fn cell_of(&self, id: NodeId) -> Option<(i32, i32)> {
        self.cells.get(&id).copied()
    }

    /// Iterate every placed cell as `(NodeId, (x, y))` in deterministic ascending
    /// `NodeId` order (the `cells` `BTreeMap` order).
    ///
    /// Additive, read-only, **no authority** (mirrors [`links_iter`](Self::links_iter)/
    /// [`cell_of`](Self::cell_of)): it copies the `(id, cell)` pairs out of the
    /// private `cells` map and changes no field. Consumed by the snapshot trust gate
    /// ([`crate::snapshot::validate_invariants`]) to reject a `cells` key that is not
    /// a live node (dangling) or two nodes mapped to one cell (collision) — WR-09-02.
    pub fn cells_iter(&self) -> impl Iterator<Item = (NodeId, (i32, i32))> + '_ {
        self.cells.iter().map(|(&id, &cell)| (id, cell))
    }

    /// The node occupying `cell`, if any — the derived reverse-index collision
    /// lookup (rebuilt on restore, so valid only after [`rebuild_occupancy`](Self::rebuild_occupancy)
    /// has run on a freshly-decoded grid).
    pub fn occupied(&self, cell: (i32, i32)) -> Option<NodeId> {
        self.occupancy.get(&cell).copied()
    }

    /// Rebuild the `#[serde(skip)]` [`occupancy`](Self::occupied) index from the
    /// serialized [`cells`](Self::cell_of) + [`footprints`](Self::footprint_of)
    /// sources in one O(cells) pass. The skipped index decodes EMPTY (Pitfall 3);
    /// [`crate::snapshot::restore`] calls this after `postcard::from_bytes` and
    /// before the trust gate so `occupied`/`cell_of` survive a round-trip. Mirrors
    /// the `factory_runtimes` cold-cache rebuild.
    ///
    /// # Multi-cell (FOOT-01): EXPAND every footprint on restore
    /// Each `(id, anchor)` is expanded through [`cells_of_footprint`] using the
    /// node's recorded footprint dims (an ABSENT entry ⇒ the faithful 1×1-rot0
    /// default), so a restored multi-cell machine's non-anchor body cells read
    /// occupied — a restored twin agrees cell-for-cell with the live index built by
    /// [`claim_footprint`](Self::claim_footprint). A node with no footprint entry
    /// expands to its single anchor, identical to the pre-FOOT-01 behavior (the
    /// 0001-0008 corpus rebuilds byte-faithfully).
    pub fn rebuild_occupancy(&mut self) {
        self.occupancy.clear();
        for (&id, &anchor) in &self.cells {
            let (w, h, rot) = match self.footprints.get(&id) {
                Some(fp) => (fp.w, fp.h, fp.rot),
                None => (1, 1, 0),
            };
            for cell in cells_of_footprint(anchor, w, h, rot) {
                self.occupancy.insert(cell, id);
            }
        }
        // Belts (BELT-06): re-claim each `Node::Belt`'s drawn `geometry` tile cells
        // from the single SERIALIZED truth (the belt node), exactly as machines
        // re-claim footprint cells from `cells` (RESEARCH Pitfall 5 — one source,
        // never a second serialized map). A `Wire`-minted belt has empty geometry,
        // so the 0001-0011 corpus rebuilds byte-faithfully (no belt tile cells).
        for (&id, node) in &self.nodes {
            if let Node::Belt(belt) = node {
                for tile in &belt.geometry {
                    self.occupancy.insert(tile.cell, id);
                }
            }
        }
    }

    /// Record `id`'s multi-cell [`Footprint`] (Phase 10). An ABSENT entry means a
    /// 1×1 rot0 footprint (the faithful default), so a 1×1 placement need NOT call
    /// this — the [`fold_place`](crate::tick) path deliberately writes no entry for a
    /// 1×1 to keep the corpus "only generalizes". This direct setter exists for the
    /// multi-cell resolution path (10-03+) and the equivalence harness. It is purely
    /// additive to the serialized map; the generalized occupancy claim + trust-gate
    /// invariants for a non-1×1 footprint land in 10-03.
    pub fn set_footprint(&mut self, id: NodeId, footprint: Footprint) {
        self.footprints.insert(id, footprint);
    }

    /// The [`Footprint`] of `id`, if one was explicitly recorded. `None` means the
    /// faithful 1×1 rot0 default (absent ⇒ 1×1 rot0).
    pub fn footprint_of(&self, id: NodeId) -> Option<Footprint> {
        self.footprints.get(&id).copied()
    }

    /// Iterate every recorded footprint as `(NodeId, Footprint)` in deterministic
    /// ascending `NodeId` order. Additive, read-only, **no authority** (mirrors
    /// [`cells_iter`](Self::cells_iter)) — for the multi-cell trust gate (10-03).
    pub fn footprints_iter(&self) -> impl Iterator<Item = (NodeId, Footprint)> + '_ {
        self.footprints.iter().map(|(&id, &fp)| (id, fp))
    }

    /// Record `id`'s rot-0 [`Port`] declarations (Phase 10). An ABSENT entry means a
    /// port-less machine; the dock/port mechanics that consume this land in 10-04+.
    pub fn set_ports(&mut self, id: NodeId, ports: Vec<Port>) {
        self.ports.insert(id, ports);
    }

    /// The recorded rot-0 ports of `id`, if any. `None` means port-less.
    pub fn ports_of(&self, id: NodeId) -> Option<&[Port]> {
        self.ports.get(&id).map(Vec::as_slice)
    }

    /// Iterate every recorded port list as `(NodeId, &[Port])` in deterministic
    /// ascending `NodeId` order. Additive, read-only, **no authority** — for the
    /// dock/port validation path (10-04+).
    pub fn ports_iter(&self) -> impl Iterator<Item = (NodeId, &[Port])> + '_ {
        self.ports.iter().map(|(&id, p)| (id, p.as_slice()))
    }

    /// Mutable access to a node's input inbox (panics if the node is unknown —
    /// callers hold a valid `NodeId` minted by this grid).
    pub fn inbox_mut(&mut self, node: NodeId) -> &mut PortInbox {
        self.inboxes
            .get_mut(&node)
            .expect("inbox_mut: unknown NodeId")
    }

    /// Read access to a node's inbox (for tests / inspection).
    pub fn inbox_of(&self, node: NodeId) -> Option<&PortInbox> {
        self.inboxes.get(&node)
    }

    /// Read access to a node's data.
    pub fn node(&self, id: NodeId) -> Option<&Node> {
        self.nodes.get(&id)
    }

    /// Mutable access to a node's data — used by the event-admission path (plan
    /// 05) to enqueue an injection into a source, and by the fold to step a
    /// node in place. Logical `NodeId` addressing only (API-03).
    pub fn node_mut(&mut self, id: NodeId) -> Option<&mut Node> {
        self.nodes.get_mut(&id)
    }

    /// Count a fault that a machine emitted on its [`FAULT_PORT`](crate::fault::FAULT_PORT)
    /// with **no belt docked** there (the fold's undocked-fault DROP point) — CONTEXT
    /// Area 2: an unwired fault is COUNTED, never silently dropped.
    ///
    /// Deterministic per-machine + snapshot-captured: it mutates only the plain
    /// [`Factory::faults`] counter, so identical starting state + identical ordered
    /// events yields identical counts on replay, and the count survives snapshot/
    /// restore. Scoped to [`Node::Factory`] (the FACTORY fault nub, CAT-02) — a
    /// no-op for any other node kind (the [`Router`](Router) keeps its own
    /// production-side counter, incremented at emit, not here). Logical `NodeId`
    /// addressing only (API-03); an unknown id is a panic-free no-op.
    pub fn count_dropped_fault(&mut self, id: NodeId) {
        if let Some(Node::Factory(f)) = self.nodes.get_mut(&id) {
            f.faults = f.faults.saturating_add(1);
        }
    }

    /// The number of nodes in the grid.
    pub fn node_count(&self) -> usize {
        self.nodes.len()
    }

    /// Iterate node ids in ascending (deterministic) order. This is the ONLY
    /// sanctioned order-observed iteration of the store; the active-set fold
    /// (plan 05) iterates the scheduler, not this.
    pub fn node_ids(&self) -> impl Iterator<Item = NodeId> + '_ {
        self.nodes.keys().copied()
    }

    /// The total number of items resting in belt slots across the whole grid —
    /// the belt half of "quiescence" (the executor half is
    /// [`Host::in_flight_len`](crate::state) — folds every [`Node::Belt`]'s
    /// occupied `slots`, using the SAME occupied-slot idiom the per-belt fold
    /// uses (`slots.iter().filter(|s| s.is_some()).count()`), summed across all
    /// belts. The sum is order-independent, so it is deterministic regardless of
    /// iteration order (integer add is commutative) — no float, no HashMap
    /// iteration (BELT-quiescence). This is the core-side aggregate of the exact
    /// quantity the frontend delete drain-guard sums per belt: the sim has
    /// drained its belts when this reaches `0`.
    #[must_use]
    pub fn belt_items_in_flight(&self) -> usize {
        self.node_ids()
            .filter_map(|id| match self.node(id) {
                Some(Node::Belt(b)) => Some(b.slots.iter().filter(|s| s.is_some()).count()),
                _ => None,
            })
            .sum()
    }

    /// The Wire-minted belts docked to one of `id`'s ports — every [`Node::Belt`]
    /// reachable across a single link whose other endpoint is `id` — in `links`
    /// `BTreeMap` key (`(NodeId, PortId)`) ascending order, deduplicated.
    ///
    /// This is the deterministic cascade-detach SET + ORDER for BELTS (FOOT-04, 10-05):
    /// a [`remove_node`](Self::remove_node) of a machine must detach exactly these
    /// belts, and [`capture_deleted_subgraph`](Self::capture_deleted_subgraph) must
    /// record exactly these belts in exactly this order. `pub(crate)` so both same-crate
    /// callers reuse the ONE collection rule (no two cascade orders can drift).
    /// Read-only: walks `links`, mutates nothing.
    ///
    /// **Corrected 63-06: `fold_rotate` does NOT call this.** The doc used to name it as
    /// a second caller, and the call graph says otherwise:
    /// [`rotate_footprint`](Self::rotate_footprint) walks the RAW `links` map with its
    /// own `Node::Belt` matcher, because it needs one verdict per DIRECTED dock rather
    /// than this deduplicated node set (its "Landmine 1" paragraph says so at the line).
    /// The correction matters here: widening this matcher would not have changed
    /// rotation at all, so "it would change rotate" is not the reason the wire cascade is
    /// a separate function. The real reason is in [`docked_wires`](Self::docked_wires).
    pub(crate) fn docked_wire_belts(&self, id: NodeId) -> Vec<NodeId> {
        let mut belts = Vec::new();
        for (&from, &to) in &self.links {
            let other = if from.0 == id {
                Some(to.0)
            } else if to.0 == id {
                Some(from.0)
            } else {
                None
            };
            if let Some(o) = other
                && matches!(self.nodes.get(&o), Some(Node::Belt(_)))
                && !belts.contains(&o)
            {
                belts.push(o);
            }
        }
        belts
    }

    /// Every [`Node::Wire`] attached to `id` on EITHER side - its `from` or its `to`
    /// endpoint names `id` - in ascending `NodeId` order, deduplicated.
    ///
    /// This is the ONE wire cascade SET + ORDER rule (63-06), the wire sibling of
    /// [`docked_wire_belts`](Self::docked_wire_belts). Both
    /// [`remove_node`](Self::remove_node) and
    /// [`capture_deleted_subgraph`](Self::capture_deleted_subgraph) call THIS function,
    /// so a captured wire can never be restored in an order the removal did not use.
    /// `pub(crate)` for the same reason its belt sibling is. Read-only: walks `nodes`,
    /// mutates nothing.
    ///
    /// # Why it walks `nodes` and not `links` - the obvious implementation is WRONG
    /// A wire's SOURCE endpoint has NO `links` entry at all. `add_wire` records the
    /// endpoints INSIDE the [`WireLink`] node, and the only `links` entry a wire ever
    /// gets is the forward `(wire, 0) -> to` one that
    /// [`fold_draw_wire`](crate::tick) writes beside it. So a `links` walk finds a wire
    /// only when the deleted node is its TARGET, and misses every wire whose source is
    /// the deleted node - which is exactly the demo scene's endpoint. Scanning `nodes`
    /// for a `Node::Wire` naming the id is the existing precedent:
    /// [`wire_from_node`](Self::wire_from_node) has always done it that way. `nodes` is a
    /// `BTreeMap`, so ascending-`NodeId` iteration is deterministic.
    ///
    /// # Why this is a SIBLING and not a widened `docked_wire_belts` matcher
    /// Because widening that `matches!` would be a HALF fix that looks like a whole one:
    /// it walks `links`, so it would start catching target-side wires and go on missing
    /// every source-side wire, silently. A wire needs a different WALK, not a different
    /// matcher. (Rotation is a non-reason: `rotate_footprint` has its own `Node::Belt`
    /// matcher over the raw `links` map and never calls the belt collector - see the
    /// correction on that function. Rotation must not detach wires and does not: a
    /// rotate severs a BELT dock because the port moves in world space and the belt's
    /// end-tile no longer abuts it, and a wire has no spatial endpoint to sever.)
    pub(crate) fn docked_wires(&self, id: NodeId) -> Vec<NodeId> {
        let mut wires = Vec::new();
        for (&wire_id, node) in &self.nodes {
            if let Node::Wire(link) = node
                && (link.from.0 == id || link.to.0 == id)
                && !wires.contains(&wire_id)
            {
                wires.push(wire_id);
            }
        }
        wires
    }

    /// The WHOLE cascade a delete of `id` takes with it: `(docked belts, attached wires)`,
    /// ONE HOP out from `id` and no further, each half in its own deterministic order
    /// ([`docked_wire_belts`](Self::docked_wire_belts) walks `links` ascending,
    /// [`docked_wires`](Self::docked_wires) walks `nodes` ascending).
    ///
    /// # This function exists so the removal and the capture cannot drift apart
    /// [`remove_node`](Self::remove_node) and
    /// [`capture_deleted_subgraph`](Self::capture_deleted_subgraph) BOTH get their cascade
    /// from here, so the depth of the delete and the depth of the undo payload are the
    /// SAME expression rather than two expressions that happen to agree. They used to
    /// agree by accident and phase 74 is what broke the accident (see
    /// [`remove_node`](Self::remove_node)'s "ONE HOP" paragraph): a capture that names
    /// fewer nodes than the removal takes is an undo that reports success and hands back a
    /// different board.
    ///
    /// # THE BELT-SOURCE RULE (74-12, WINDOWS row 231): what the removed node IS comes first
    /// When `id` is itself a [`Node::Belt`] the belt half is EMPTY. A belt delete takes
    /// that belt and nothing across a belt-to-belt dock.
    ///
    /// The reason is the same one that makes the machine rule right, read the other way
    /// round. A belt docked to a machine has that machine as one whole end of it, so a
    /// delete of the machine leaves it docked to a node that is gone: it STRANDS, and
    /// taking it is what the user could see coming. A belt docked to another belt does not
    /// strand. It loses a link, and a belt that has lost a link is a shipped, ordinary
    /// board state: it is exactly what [`judge_docks`](Self::judge_docks) produces for its
    /// `None` RELEASE verdict on a rotate, where the one directed link is dropped and the
    /// belt node survives disconnected. Nothing extra is needed here to sever the join,
    /// because [`remove_node_traces`](Self::remove_node_traces) already drops every link
    /// naming the removed node on either side.
    ///
    /// MEASURED, which is why this is a narrowing and not a preference. 74-02 made a
    /// belt's dock neighbour able to BE a belt, and from that commit
    /// [`docked_wire_belts`](Self::docked_wire_belts) collected it: plan 74-11 drove a
    /// Delete of one belt of a joined two-belt run and got back a board with ZERO belts on
    /// it. That is a cascade delete of a node the user did not select, on the exact
    /// topology phase 74 exists to make buildable.
    ///
    /// The predicate lives HERE and nowhere else, for two reasons. It is the one
    /// expression the removal and the capture share, so both sides move together and
    /// neither needs its own edit. And `docked_wire_belts` stays a pure query: its own
    /// docblock already scopes its contract to a machine, an in-crate unit test uses the
    /// raw query as an independent oracle, and a query that carries a policy is how these
    /// two sides drifted apart in the first place.
    ///
    /// The WIRE half is unconditional and deliberately so. A wire is always an Electrical
    /// carrier and a belt's two ports are Mechanical, so `resolve_wire_leg` already
    /// refuses the pairing and no user-reachable board has a wire attached to a belt.
    ///
    /// Read-only: walks `links` and `nodes`, mutates nothing.
    pub(crate) fn cascade_neighbours(&self, id: NodeId) -> (Vec<NodeId>, Vec<NodeId>) {
        // Ask what the removed node IS before asking what is docked to it. A belt source
        // cascades no belt (74-12); every other node kind cascades exactly the belts
        // touching it, unchanged.
        let belts = match self.nodes.get(&id) {
            Some(Node::Belt(_)) => Vec::new(),
            _ => self.docked_wire_belts(id),
        };
        (belts, self.docked_wires(id))
    }

    /// Tear down a SINGLE node's own traces: its `nodes`/`inboxes` entries, its
    /// allocator slot, its `cells`/`footprints`/`ports` entries, EVERY occupancy
    /// cell of its WHOLE footprint (expanded via [`cells_of_footprint`], not just
    /// the anchor — FOOT-04), and every link referencing it as either endpoint. No
    /// cascade (the caller drives the docked-belt cascade). Assumes the node exists.
    fn remove_node_traces(&mut self, id: NodeId) {
        // Free a deleted belt's drawn `geometry` tile cells from the unified
        // occupancy index (BELT-08) — the inverse of `claim_belt_tiles` /
        // `rebuild_occupancy`, symmetric with the footprint-cell free below.
        // A `Wire`-minted belt has empty geometry ⇒ this loop is a no-op (the
        // 0008/0010 corpus delete fixtures are untouched). The slots (and their
        // in-flight items) drop WITH the node when `nodes.remove` runs — the
        // deterministic discard, no separate item handling. Read the geometry
        // BEFORE removing the node from `nodes`. Guarded by ownership (only free a
        // cell this id still owns) exactly like the footprint-cell free.
        if let Some(Node::Belt(belt)) = self.nodes.get(&id) {
            let cells: Vec<(i32, i32)> = belt.geometry.iter().map(|tile| tile.cell).collect();
            for cell in cells {
                if self.occupancy.get(&cell) == Some(&id) {
                    self.occupancy.remove(&cell);
                }
            }
        }
        self.nodes.remove(&id);
        self.inboxes.remove(&id);
        // Free the WHOLE footprint from occupancy — expand the node's footprint
        // (absent entry ⇒ 1×1 rot0) and drop every body cell it still owns, not
        // just the anchor. Read the dims BEFORE removing the `footprints` entry.
        if let Some(anchor) = self.cells.remove(&id) {
            let (w, h, rot) = match self.footprints.get(&id) {
                Some(fp) => (fp.w, fp.h, fp.rot),
                None => (1, 1, 0),
            };
            for cell in cells_of_footprint(anchor, w, h, rot) {
                if self.occupancy.get(&cell) == Some(&id) {
                    self.occupancy.remove(&cell);
                }
            }
        }
        self.footprints.remove(&id);
        self.ports.remove(&id);
        // Free the generational slot (deterministic; a future mint may reuse it
        // with a bumped generation — never colliding with the removed id).
        self.allocator.remove(id);
        // Drop every link referencing the node as either endpoint, so no dangling
        // wire survives (the routing panic surface). Collect-then-remove to avoid
        // mutating `links` while iterating it.
        let dangling: Vec<(NodeId, PortId)> = self
            .links
            .iter()
            .filter(|(from, to)| from.0 == id || to.0 == id)
            .map(|(from, _)| *from)
            .collect();
        // Through `unlink`, so a Factory whose output fed the removed node drops that
        // port's waiting emits with the link (phase 87, JAM-05: the trust gate refuses a
        // queue on a port with no link).
        for key in dangling {
            self.unlink(key);
        }
    }

    /// Remove a node and EVERY trace of it — its `nodes`/`inboxes`/allocator-slot
    /// entries, its WHOLE multi-cell footprint (all occupancy cells +
    /// `footprints`/`ports` entries, not just the anchor — FOOT-04), and every link
    /// whose **source or target** endpoint is the node - AND, WHEN THE NODE IS NOT ITSELF
    /// A BELT (74-12, see the belt-source paragraph below), cascade-remove every
    /// Wire-minted belt docked to one of its ports, in `(NodeId, PortId)` ascending
    /// order ([`docked_wire_belts`](Self::docked_wire_belts)), AND (63-06) every
    /// [`Node::Wire`] attached to it on either side, in ascending `NodeId` order
    /// ([`docked_wires`](Self::docked_wires)). Returns the ids of
    /// every node removed (the primary FIRST, then each cascade-detached belt in
    /// order, then each cascade-removed wire in order); EMPTY if `id` was already
    /// absent (a no-op - never panics, threat T-07-FOLD-PANIC).
    ///
    /// # ONE HOP (LINK-07, phase 74), and what it replaced
    /// The cascade reaches the primary's OWN neighbours
    /// ([`cascade_neighbours`](Self::cascade_neighbours)) and stops. It used to recurse -
    /// `removed.extend(self.remove_node(belt))` - under a comment saying that terminated
    /// immediately "in practice" because belts do not neighbour belts. Phase 74's
    /// belt-to-belt join made that false, and a uniform recursion then ate the whole run:
    /// MEASURED on `a -> b -> c -> sink`, `remove_node(sink)` returned FOUR ids where two
    /// is correct, and destroyed the `a -> b` link on the way out. A delete is authorised
    /// by ONE click on ONE node, and the set it removes has to be the set the user could
    /// see: that node and the belts touching it.
    ///
    /// A belt the cascade takes still loses its own links in both directions - a link
    /// whose target is a dead node is [`StateInvariant::DanglingLink`], so the `b -> c`
    /// link goes with `c`. "The links survive" is a claim about the links between nodes
    /// the delete did NOT touch, and `a -> b` is the one it is written against.
    ///
    /// # AND ONE HOP ONLY WHEN THE DELETED NODE IS NOT ITSELF A BELT (74-12)
    /// One hop was measured for deleting a MACHINE, where taking the touching belt is
    /// right because that belt would otherwise be left docked to a node that is gone. A
    /// belt-to-belt neighbour does not strand: it loses a link, which is the outcome
    /// [`judge_docks`](Self::judge_docks) already produces on a rotate. Until 74-12 the
    /// one-hop rule made no such distinction, so a Delete of one belt of a joined two-belt
    /// run returned BOTH belts and the user got back an empty board from one click on one
    /// segment. MEASURED by plan 74-11, recorded as WINDOWS row 231, and narrowed at the
    /// one shared source in [`cascade_neighbours`](Self::cascade_neighbours) so the
    /// removal and the capture could not answer differently.
    ///
    /// The machine rule is NARROWED, never removed: `remove_node` of a SINK a run feeds
    /// still returns that sink and the one belt touching it. A change that stopped the
    /// belt cascade for a machine delete too would be a regression dressed as a fix.
    ///
    /// **The wire leg is not tidiness.** A surviving `Node::Wire` naming a dead
    /// endpoint is rejected by the snapshot trust gate as
    /// [`StateInvariant::DanglingWireEndpoint`](crate::event::StateInvariant), so
    /// leaving one behind means the board SAVES and then refuses to LOAD.
    ///
    /// This is the fold target for [`EditOp::Delete`](crate::edit::EditOp::Delete)
    /// (Phase 7 SC5 / FOOT-04): deleting only the node would strand dangling links
    /// that the routing path (`inbox_mut(dest)`) would later panic on, and leaving a
    /// docked belt behind would orphan its `in_flight`⟷wake pairing — so it drops
    /// the links AND the docked belts, leaving a structurally-valid grid the
    /// snapshot trust gate accepts. The CALLER ([`fold_delete`](crate::tick)) pairs
    /// `sched.remove` with each returned id (the AR-3 pairing, Pitfall 4); an
    /// in-flight item on a detached belt DROPs via the missing-link no-op (Q3, NOT a
    /// fault). **Additive + byte-stable**: it only mutates existing maps, never
    /// changing the serialized `GridState` shape, so the frozen corpus is untouched.
    /// Logical `NodeId` addressing only (API-03).
    pub fn remove_node(&mut self, id: NodeId) -> Vec<NodeId> {
        if !self.nodes.contains_key(&id) {
            return Vec::new();
        }
        // Collect the docked belts AND the attached wires BEFORE tearing down `id`'s
        // own traces (so both are still present to walk) - collect-then-remove,
        // mirroring the dangling-link drop, so nothing iterates `links` or `nodes`
        // while it is being mutated. The wire walk in particular MUST run before
        // `remove_node_traces`, which drops `id` from `nodes`: a wire is found by its
        // endpoints naming `id`, and those endpoints stay readable, but the walk also
        // reads `nodes` and must see a stable map.
        let (docked, wires) = self.cascade_neighbours(id);
        self.remove_node_traces(id);
        let mut removed = vec![id];
        // Cascade-detach each docked belt in deterministic order. A belt carries no
        // footprint; removing it drops its node/inbox/slot + its remaining link
        // (incl. its downstream link - so an in-flight item DROPs via the
        // missing-link no-op, Q3). ONE HOP, never a recursion: since phase 74 a belt
        // CAN dock to another belt (LINK-01), so a uniform `remove_node(belt)` recursion
        // walks the whole run - MEASURED as four nodes removed where two is correct on
        // `a -> b -> c -> sink`, with the `a -> b` link destroyed on the way out. What a
        // user selected is one machine; what they get back is that machine and the belts
        // TOUCHING it, which is also exactly the set the delete-guard dialog counted
        // in-flight items over before they confirmed.
        //
        // AND THIS LOOP IS EMPTY WHEN `id` IS ITSELF A BELT (74-12, WINDOWS row 231).
        // `cascade_neighbours` returns no belt for a belt source, because a belt-to-belt
        // neighbour does not strand the way a machine's belt does: it just loses the link,
        // which `remove_node_traces` above has already dropped. One hop out of a MACHINE
        // was the measured rule; one hop out of a BELT ate the segment next to the one the
        // user selected.
        for belt in docked {
            if self.nodes.contains_key(&belt) {
                self.remove_node_traces(belt);
                removed.push(belt);
            }
        }
        // Cascade-remove each attached wire AFTER the belts, in ascending `NodeId`
        // order. Same `contains_key` guard and the same one-hop rule: a self-loop wire
        // is in the set exactly once (`docked_wires` deduplicates), and a wire attached
        // to another wire is not a topology the fold can build. A wire carries no
        // footprint and no cell; removing it drops its node/inbox/slot and its single
        // forward link, and the caller (`fold_delete`) pairs `sched.remove` with the
        // returned id - which matters for a wire, because the trust gate's
        // `WireWakeMissing` invariant reads the wheel.
        //
        // # One hop cannot strand a wire on a cascade-removed BELT
        // The stranding worth worrying about is a `Node::Wire` left naming a dead belt:
        // the trust gate calls that `DanglingWireEndpoint`, so the board would save and
        // then refuse to load. It is unreachable, and not by luck. A wire is ALWAYS an
        // Electrical carrier and `resolve_wire_leg` refuses either endpoint whose port
        // is not Electrical (`MediumMismatch`); a belt's two ports are Mechanical. So no
        // user-reachable board has a wire attached to a belt at all.
        for wire in wires {
            if self.nodes.contains_key(&wire) {
                self.remove_node_traces(wire);
                removed.push(wire);
            }
        }
        removed
    }

    /// Capture the FULL subgraph an [`EditOp::Delete`](crate::edit::EditOp::Delete) of
    /// `id` will cascade-remove, as the persisted Phase-12 undo payload (12-05, RESEARCH
    /// Pitfall 2). Read **before** the delete folds (the subgraph is live only then), so
    /// a later undo can rebuild the machine AND rewire every cascade-removed belt from the
    /// capture ALONE.
    ///
    /// Determinism (the whole point): it reads the cascade from the SAME function
    /// [`remove_node`](Self::remove_node) reads it from -
    /// [`cascade_neighbours`](Self::cascade_neighbours), which is
    /// [`docked_wire_belts`](Self::docked_wire_belts) (walks `links` ascending) for the
    /// belts and, since 63-06, [`docked_wires`](Self::docked_wires) (walks `nodes`
    /// ascending) for the wires. Sharing the ONE call is what makes the agreement
    /// structural: phase 74 (LINK-07) found these two agreeing only by accident, the
    /// removal recursing to the end of a belt run while this side named the first hop, so
    /// a delete tore down three belts and the undo payload knew about one. Plus the
    /// `(NodeId, PortId)`-ordered [`links_iter`](Self::links_iter); NO `HashMap`
    /// iteration. Captured: the machine's resolved footprint `(w, h)` (absent ⇒ faithful
    /// `1×1`) + rot-0 `ports`; for EACH cascade-removed belt its kind (always BELT),
    /// drawn `geometry` (empty for a Wire-minted belt), and every directed link incident
    /// to it; and for EACH cascade-removed wire its kind (always WIRE), its `from`/`to`
    /// endpoints, and every directed link incident to it. Read-only - mutates nothing;
    /// the fold ([`fold_delete`](crate::tick)) never
    /// consumes the result (so a re-bless stays per-tick-hash-identical).
    ///
    /// # A BELT delete captures no cascade belt, by rule (74-12)
    /// `belts` is EMPTY whenever `id` is itself a [`Node::Belt`], because
    /// [`cascade_neighbours`](Self::cascade_neighbours) returns no belt for a belt source.
    /// A belt delete's own two joins ride the `self_record` arm below as a
    /// [`DeletedSelf::Belt`](crate::edit::DeletedSelf::Belt), with no skip, and that is
    /// the material the command layer's undo re-`Dock`s from. This side needed no edit for
    /// that narrowing, which is the whole reason both sides read the one shared query.
    ///
    /// # A Route-and-Handler PAIR is captured as TWO records, not one subgraph (72-08)
    /// Since 72-08 a `Delete` of either leg of a Route-and-Handler cable removes BOTH
    /// legs, and the command layer expresses that as TWO `EditOp::Delete` records under
    /// ONE action id. `fabrico_command`'s `enrich_delete_capture` therefore calls this
    /// function ONCE PER RECORD and each leg carries its own capture; this function does
    /// NOT reach across to the sibling. See [`fold_delete`](crate::tick)'s docblock for
    /// why the pairing rule cannot live in this crate.
    ///
    /// **PHASE 73 OWNS RESTORING THE PAIR AS ONE UNDO STEP.** The two captures are the
    /// material an undo has to work from, and restoring only one of them restores the
    /// forward-only board D-06 rules unreachable. D-04's reversibility is recorded as
    /// costly for exactly this reason, and a phase 73 planner who splits the pairing has
    /// to re-open the command-layer cascade these two captures feed.
    pub fn capture_deleted_subgraph(&self, id: NodeId) -> crate::edit::DeletedSubgraph {
        use crate::edit::{DeletedBelt, DeletedSubgraph, DeletedWire};
        // A node that is not on the board has nothing to capture: the EMPTY capture
        // (`is_empty()`, `w == 0`), never a 1 by 1 read off nothing (phase 86 review, CR-01:
        // a same-pass Delete of a belt its machine's Delete had already taken wrote that
        // fabricated record, and its Undo was refused on every press). The host refuses such
        // a Delete before it reaches here; this keeps any other caller from writing one.
        if !self.nodes.contains_key(&id) {
            return DeletedSubgraph::default();
        }
        // The machine's resolved footprint (absent ⇒ faithful 1×1 rot 0) + its rot-0 ports,
        // and (EDIT 13, plan 86-02) the rotation it holds, so the Delete inverse re-Places
        // the turned box in one claim.
        let (w, h, rot) = self.footprint_of(id).map_or((1, 1, 0), |f| (f.w, f.h, f.rot));
        let ports = self.ports_of(id).map(<[Port]>::to_vec).unwrap_or_default();
        // EVERY cascade-removed belt, in `docked_wire_belts` order (the deterministic
        // cascade set+order remove_node uses), each with its kind + geometry + the
        // directed links incident to it (links_iter is BTreeMap order).
        let (cascade_belts, cascade_wires) = self.cascade_neighbours(id);
        let mut belts = Vec::new();
        for belt_id in cascade_belts {
            // The belt's drawn tiles and (EDIT 13, plan 86-02) its pace, which plan 86-03's
            // cascade re-Configure applies after the re-draw.
            let (geometry, ticks_per_slot) = match self.nodes.get(&belt_id) {
                Some(Node::Belt(b)) => (b.geometry.clone(), b.ticks_per_slot),
                _ => (Vec::new(), crate::belt_slots::DEFAULT_TICKS_PER_SLOT),
            };
            let links = self
                .links_iter()
                .filter(|((f, _), (t, _))| *f == belt_id || *t == belt_id)
                .map(|((f, fp), (t, tp))| (f, fp, t, tp))
                .collect();
            // A cascade-detached belt is always a `Node::Belt` → machine_kind BELT (1),
            // the lockstep convention (fabrico-core is protocol-free, mirrors tick.rs).
            belts.push(DeletedBelt {
                kind: 1,
                geometry,
                links,
                ticks_per_slot,
            });
        }
        // EVERY cascade-removed WIRE, in `docked_wires` order (the same ascending-NodeId
        // set+order `remove_node` removes them in), each with its endpoints + the
        // directed links incident to it (links_iter is BTreeMap order).
        let mut wires = Vec::new();
        for wire_id in cascade_wires {
            let Some(Node::Wire(link)) = self.nodes.get(&wire_id) else {
                continue;
            };
            let links = self
                .links_iter()
                .filter(|((f, _), (t, _))| *f == wire_id || *t == wire_id)
                .map(|((f, fp), (t, tp))| (f, fp, t, tp))
                .collect();
            // A cascade-removed wire is always a `Node::Wire` → machine_kind WIRE (8),
            // the lockstep convention (fabrico-core is protocol-free, mirrors tick.rs).
            wires.push(DeletedWire {
                kind: 8,
                from: link.from,
                to: link.to,
                links,
            });
        }
        // Phase 73 (73-03): the DELETED NODE'S OWN record, when the delete's target is
        // itself a bare belt or a bare wire rather than a machine. Everything above this
        // point describes a MACHINE and the cascade around it, and for a bare wire all
        // four of those are empty while `w` is still 1, so the capture came out REAL and
        // useless: `is_empty()` false, catalog fallback never fired, and the inverse walked
        // into a `Place { kind: WIRE }` that `fold_place` deliberately never mints.
        //
        // `None` for a machine, which is what keeps a machine delete's capture byte-shaped
        // exactly as it was apart from the one discriminant byte the append costs.
        let self_record = match self.nodes.get(&id) {
            Some(Node::Wire(link)) => {
                let links = self
                    .links_iter()
                    .filter(|((f, _), (t, _))| *f == id || *t == id)
                    .map(|((f, fp), (t, tp))| (f, fp, t, tp))
                    .collect();
                // Same lockstep convention the cascade arm above uses: a `Node::Wire` is
                // machine_kind WIRE (8). fabrico-core is protocol-free and mirrors tick.rs.
                Some(crate::edit::DeletedSelf::Wire(DeletedWire {
                    kind: 8,
                    from: link.from,
                    to: link.to,
                    links,
                }))
            }
            Some(Node::Belt(b)) => {
                let links = self
                    .links_iter()
                    .filter(|((f, _), (t, _))| *f == id || *t == id)
                    .map(|((f, fp), (t, tp))| (f, fp, t, tp))
                    .collect();
                // A `Node::Belt` is machine_kind BELT (1). The belt half is captured HERE
                // because it is the same shape as the wire half and costs nothing extra;
                // plan 73-05 owns its RESTORE leg and its tests.
                Some(crate::edit::DeletedSelf::Belt(DeletedBelt {
                    kind: 1,
                    geometry: b.geometry.clone(),
                    links,
                    ticks_per_slot: b.ticks_per_slot,
                }))
            }
            _ => None,
        };
        DeletedSubgraph {
            w,
            h,
            ports,
            belts,
            wires,
            self_record,
            rot,
        }
    }

    /// **Test-support only — never compiled into a normal build.** Forge the
    /// `MissingInbox` invalid state (a node present in `nodes` with no entry in
    /// `inboxes`) so the snapshot trust gate's rejection can be exercised. No
    /// `add_*` path can produce this — every node provisions an inbox — so this
    /// scaffolding is the only way a test can construct the corrupt-but-decodable
    /// Core. Gated behind `cfg(test)` (in-crate unit tests) OR the `test-support`
    /// feature (cross-crate integration tests).
    #[cfg(any(test, feature = "test-support"))]
    pub fn test_remove_inbox(&mut self, id: NodeId) {
        self.inboxes.remove(&id);
    }

    /// **Test-support only — never compiled into a normal build.** Force a RAW
    /// `cells` entry, bypassing the injective-on-positions eviction
    /// [`set_cell`](Self::set_cell) enforces, so a test can forge the otherwise
    /// impossible-via-public-API `CellCollision` state (two live nodes on one cell)
    /// the snapshot trust gate must reject (WR-09-02). Gated like
    /// [`test_remove_inbox`](Self::test_remove_inbox).
    #[cfg(any(test, feature = "test-support"))]
    pub fn test_force_cell(&mut self, id: NodeId, cell: (i32, i32)) {
        self.cells.insert(id, cell);
    }

    /// **Test-support only — never compiled into a normal build.** Force RAW
    /// `footprints` (and, when non-empty, `ports`) entries for `id`, bypassing the
    /// [`claim_footprint`](Self::claim_footprint) path, so a test can forge the
    /// otherwise impossible-via-public-API states the snapshot trust gate must
    /// reject (FOOT-01 / V5): two distinct-anchor footprints with OVERLAPPING bodies
    /// (`CellCollision` over expanded cells), a footprints/ports key with no live
    /// node (`DanglingFootprint`), or a port `local_offset` outside the footprint box
    /// (`PortOutOfFootprint`). Gated like [`test_force_cell`](Self::test_force_cell).
    #[cfg(any(test, feature = "test-support"))]
    pub fn test_force_footprint(&mut self, id: NodeId, footprint: Footprint, ports: Vec<Port>) {
        self.footprints.insert(id, footprint);
        if !ports.is_empty() {
            self.ports.insert(id, ports);
        }
    }

    /// **Test-support only — never compiled into a normal build.** Insert a
    /// `Node::Wire`/`Node::Endpoint` at an arbitrary point in the store with an inbox
    /// provisioned, mirroring [`add_sink`](Self::add_sink)'s mint path. Both kinds DO
    /// have real minters now ([`add_wire`](Self::add_wire) and
    /// [`add_endpoint`](Self::add_endpoint), both reachable from the fold), but those
    /// mint a well-formed node; this scaffolding is how a snapshot forge test places one
    /// to prove the node-kind-agnostic trust-gate checks
    /// (`DanglingFootprint`/`PortOutOfFootprint`) generalize to the v6.0 kinds and that
    /// a forged inert node restores + steps without a panic (SCHEMA-03, RESEARCH A2).
    /// Provisions an inbox so a placed inert node never trips the `MissingInbox` gate.
    /// Gated like [`test_force_footprint`](Self::test_force_footprint).
    #[cfg(any(test, feature = "test-support"))]
    pub fn test_insert_inert(&mut self, node: Node) -> NodeId {
        let id = self.allocator.insert(());
        self.nodes.insert(id, node);
        self.inboxes.insert(id, PortInbox::new());
        id
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

    /// Phase 87, JAM-04, D-06: the derived reverse link index stays exactly what
    /// `rebuild_feeders` reconstructs from `links`, across a link, a relink to a new
    /// destination, two links to one destination with one removed, an unlink, and a
    /// delete that drops every link touching a node.
    #[test]
    fn feeders_index_tracks_every_link_change() {
        fn agrees(g: &GridState) {
            let mut twin = g.clone();
            twin.rebuild_feeders();
            assert_eq!(g.feeders, twin.feeders, "the live index equals the rebuilt one");
        }
        let mut g = GridState::new();
        let a = g.add_tee(2);
        let b = g.add_source();
        let c = g.add_source();
        g.link((a, 0), (b, 0));
        agrees(&g);
        assert_eq!(g.feeders_of(b).collect::<Vec<_>>(), vec![a]);
        // Relink Out 0 to c: a leaves b's feeders.
        g.link((a, 0), (c, 0));
        agrees(&g);
        assert_eq!(g.feeders_of(b).count(), 0);
        assert_eq!(g.feeders_of(c).collect::<Vec<_>>(), vec![a]);
        // Two ports into one destination; removing one keeps a as c's feeder.
        g.link((a, 1), (c, 1));
        g.unlink((a, 0));
        agrees(&g);
        assert_eq!(g.feeders_of(c).collect::<Vec<_>>(), vec![a]);
        g.unlink((a, 1));
        agrees(&g);
        assert_eq!(g.feeders_of(c).count(), 0);
        // A delete drops every link touching the node, through `unlink`.
        g.link((b, 0), (c, 0));
        g.link((a, 0), (b, 0));
        g.remove_node(b);
        agrees(&g);
        assert_eq!(g.feeders_of(c).count(), 0);
        assert_eq!(g.feeders_of(b).count(), 0);
    }

    #[test]
    fn belt_items_in_flight_counts_occupied_slots() {
        // The belt-quiescence primitive the Draining->Frozen condition folds:
        // the whole-grid aggregate of occupied belt slots. Build two belts,
        // place K items across their `slots`, and assert the aggregate == K;
        // drain them and assert it returns to 0 (BELT-quiescence).
        let mut grid = GridState::new();
        let a = grid.add_belt(2);
        let b = grid.add_belt(3);

        // Empty grid of empty belts is quiescent.
        assert_eq!(grid.belt_items_in_flight(), 0, "fresh belts hold no items");

        // Place 2 items on belt `a`, 1 item on belt `b` — K = 3 total.
        if let Some(Node::Belt(belt)) = grid.node_mut(a) {
            belt.slots[0] = Some(Item(vec![0x01]));
            belt.slots[1] = Some(Item(vec![0x02]));
        }
        if let Some(Node::Belt(belt)) = grid.node_mut(b) {
            belt.slots[0] = Some(Item(vec![0x03]));
        }
        assert_eq!(
            grid.belt_items_in_flight(),
            3,
            "the aggregate equals the placed-item count across all belts"
        );

        // Drain every belt slot — the aggregate returns to 0 (quiescent).
        if let Some(Node::Belt(belt)) = grid.node_mut(a) {
            belt.slots.iter_mut().for_each(|s| *s = None);
        }
        if let Some(Node::Belt(belt)) = grid.node_mut(b) {
            belt.slots.iter_mut().for_each(|s| *s = None);
        }
        assert_eq!(
            grid.belt_items_in_flight(),
            0,
            "a fully drained grid reports zero belt items in flight"
        );
    }

    /// LINK-08 clause (ii) / D-06, the EMPTY-GEOMETRY EDGE, on the mint path itself.
    ///
    /// A `Wire`-minted belt has empty geometry and no spatial end, and it STILL declares
    /// both Port records. That is the whole point of D-06: `ports_of(belt)` is `Some` for
    /// EVERY belt, never `Some` for some and `None` for others, so `resolve_spatial_port`
    /// cannot behave differently per belt and a `Dock` naming a geometry-empty belt
    /// refuses on the GEOMETRY check rather than on port-absence.
    ///
    /// The refusal side of that sentence is asserted rather than assumed: the same belt
    /// resolves to NO belt end through [`belt_end_world`], which is the check the Dock
    /// arm dies on.
    #[test]
    fn a_geometry_empty_belt_still_declares_both_ports() {
        let mut grid = GridState::new();
        let belt = grid.add_belt(1);

        assert!(
            matches!(grid.node(belt), Some(Node::Belt(b)) if b.geometry.is_empty()),
            "the subject is a Wire-minted belt: geometry is empty",
        );
        let ports = grid
            .ports_of(belt)
            .expect("D-06: a belt is ALWAYS present in `ports`, geometry-empty ones included");
        assert_eq!(ports.len(), 2, "a belt declares exactly two ports, Tail and Head");
        assert_eq!(ports[0].role, Role::In, "index 0 is the TAIL, Role::In");
        assert_eq!(ports[1].role, Role::Out, "index 1 is the HEAD, Role::Out");
        assert_eq!(ports[0].local_offset, (0, 0), "trust-gate invariant 7: (0,0) is the only legal belt port offset");
        assert_eq!(ports[1].local_offset, (0, 0), "trust-gate invariant 7: (0,0) is the only legal belt port offset");
        assert_eq!(ports[0].medium, Medium::Mechanical, "a belt is always a Mechanical carrier");
        assert_eq!(ports[1].medium, Medium::Mechanical, "a belt is always a Mechanical carrier");

        // The refusal a geometry-empty belt earns is a GEOMETRY refusal, not a
        // port-absence one, and this is the site the Dock arm reads to produce it.
        assert!(
            belt_end_world(&[], crate::edit::BeltEnd::Tail).is_none(),
            "an empty geometry resolves to no belt end, which is what a Dock naming this \
             belt refuses on",
        );
    }

    /// LINK-08 clause (i), the ORDERING EDGE, in its own case and in THIS crate.
    ///
    /// `fabrico-command`'s `port_catalog_every_kind_lists_in_ports_first` parity sweep
    /// structurally CANNOT see this: its `CATALOG_KINDS` list has nine entries with BELT
    /// deliberately absent, and BELT's own catalog arm is `vec![]`. Belt ports are written
    /// here, in `fabrico-core`, which that sweep never reads, so an Out-first belt would
    /// ship with every existing test green. That is exactly why the ordering carries its
    /// own assertion, and why the assertion lives here.
    ///
    /// What an Out-first belt would break, in the command layer's own words: a Head dock
    /// key is the RAW catalog index while a Tail dock key is an `Out`-filtered routing
    /// index, so an `Out` declared before an `In` mis-keys every Head dock into the wrong
    /// inbox.
    #[test]
    fn belt_ports_are_ordered_in_before_out_which_is_a_contract_not_a_convention() {
        let roles: Vec<Role> = belt_ports().iter().map(|p| p.role).collect();
        assert_eq!(
            roles,
            vec![Role::In, Role::Out],
            "IN FIRST: index 0 must be the Tail's Role::In and index 1 the Head's Role::Out",
        );
        // The order is derived from the belt's flow direction and is FIXED, not read off
        // any map walk: two independent mints agree element for element.
        let mut grid = GridState::new();
        let a = grid.add_belt(2);
        let b = grid.add_belt(3);
        assert_eq!(
            grid.ports_of(a),
            grid.ports_of(b),
            "every belt declares the same two records in the same order, whatever its size",
        );
    }

    #[test]
    fn role_fault_is_appended_last_at_index_2_in_out_unchanged() {
        // Fieldless-enum `as u8` yields the DECLARATION index — the load-bearing
        // varint postcard encodes. In/Out MUST stay at 0/1; Fault is LAST at 2.
        assert_eq!(Role::In as u8, 0, "In must stay declaration index 0");
        assert_eq!(Role::Out as u8, 1, "Out must stay declaration index 1");
        assert_eq!(Role::Fault as u8, 2, "Fault is appended LAST at index 2");
        assert_eq!(Role::default(), Role::In, "#[default] stays on In");
    }

    #[test]
    fn role_serialization_is_byte_additive_in_out_stable_fault_is_2() {
        // A Port's role encodes as a single varint index: In=0, Out=1, Fault=2.
        // 35-03: `medium` is appended LAST after `role`, so the Port now serializes
        // as `[local_offset..][side][role][medium]` — the role varint is the
        // SECOND-to-last byte and the medium varint (Mechanical=0) is the trailing
        // byte. This is the v6.0 byte-forcer: every stored port grows by one varint.
        let in_port = Port { local_offset: (0, 1), side: Side::W, role: Role::In, medium: Medium::Mechanical };
        let out_port = Port { local_offset: (2, 1), side: Side::E, role: Role::Out, medium: Medium::Mechanical };
        let fault_port = Port { local_offset: (1, 2), side: Side::S, role: Role::Fault, medium: Medium::Mechanical };

        // The role varint is now the second-to-last byte (medium rides last).
        let in_bytes = postcard::to_allocvec(&in_port).expect("serialize In port");
        let out_bytes = postcard::to_allocvec(&out_port).expect("serialize Out port");
        let fault_bytes = postcard::to_allocvec(&fault_port).expect("serialize Fault port");
        let role_byte = |b: &[u8]| b[b.len() - 2];
        assert_eq!(role_byte(&in_bytes), 0, "In role encodes to varint 0");
        assert_eq!(role_byte(&out_bytes), 1, "Out role encodes to varint 1");
        assert_eq!(role_byte(&fault_bytes), 2, "Fault role encodes to varint 2");

        // The appended medium varint is the trailing byte: Mechanical=0, Electrical=1.
        assert_eq!(*in_bytes.last().unwrap(), 0, "Mechanical medium encodes to varint 0");
        let elec_port = Port { local_offset: (0, 0), side: Side::N, role: Role::In, medium: Medium::Electrical };
        let elec_bytes = postcard::to_allocvec(&elec_port).expect("serialize Electrical port");
        assert_eq!(*elec_bytes.last().unwrap(), 1, "Electrical medium encodes to varint 1");

        // Round-trips cleanly at the new four-field shape.
        let back: Port = postcard::from_bytes(&fault_bytes).expect("round-trip Fault port");
        assert_eq!(back.role, Role::Fault);
        assert_eq!(back.medium, Medium::Mechanical);
    }

    /// SLOT-03: a belt built by the ONE constructor carries the crate's construction
    /// default, and the hand-written `Default` agrees with `Belt::new(0)`.
    ///
    /// The `Default` half is the one that would rot silently. `NonZeroU32` has no
    /// `Default`, so Phase 62 had to replace the derive with a hand-written impl; a
    /// later edit that made that impl build a `Belt` field-by-field instead of routing
    /// through `Belt::new` would give `Default` and `Belt::new(0)` two different ideas
    /// of what a fresh belt carries, and nothing else in the tree would notice.
    #[test]
    fn state_belt_new_seeds_the_construction_default_and_default_agrees() {
        assert_eq!(
            Belt::new(1).ticks_per_slot,
            crate::belt_slots::DEFAULT_TICKS_PER_SLOT,
            "Belt::new seeds the interval from the crate's construction default"
        );
        assert_eq!(
            Belt::default(),
            Belt::new(0),
            "Default routes through the ONE constructor, it is not a derive"
        );
    }

    #[test]
    fn state_add_source_and_belt_mint_distinct_ids_and_store_them() {
        let mut g = GridState::new();
        let s = g.add_source();
        let b = g.add_belt(3);
        assert_ne!(s, b, "minted ids are distinct");
        assert_eq!(g.node_count(), 2);
        assert!(matches!(g.node(s), Some(Node::Source(_))));
        // A 3-tile belt has SLOTS_PER_TILE*3 empty slots and no drawn geometry.
        match g.node(b) {
            Some(Node::Belt(belt)) => {
                assert_eq!(belt.tiles, 3);
                assert_eq!(belt.slots.len(), crate::belt_slots::slot_count(3));
                assert!(belt.slots.iter().all(Option::is_none), "fresh belt is empty");
                assert!(belt.geometry.is_empty(), "a Wire-minted belt is geometry-less");
            }
            other => panic!("expected a Belt node, got {other:?}"),
        }
        // Both have an inbox provisioned.
        assert!(g.inbox_of(s).is_some());
        assert!(g.inbox_of(b).is_some());
    }

    #[test]
    fn state_add_tee_and_balancer_mint_distinct_ids_and_store_them() {
        let mut g = GridState::new();
        let t = g.add_tee(3);
        let bal = g.add_balancer(4);
        assert_ne!(t, bal, "minted ids are distinct");
        assert_eq!(g.node_count(), 2);
        assert!(matches!(g.node(t), Some(Node::Tee(Tee { outputs: 3, faults: 0 }))));
        assert!(matches!(
            g.node(bal),
            Some(Node::Balancer(Balancer {
                outputs: 4,
                next: 0,
                next_in: 0
            }))
        ));
        // Both have an inbox provisioned (mirror add_source/add_belt).
        assert!(g.inbox_of(t).is_some());
        assert!(g.inbox_of(bal).is_some());
    }

    #[test]
    fn state_add_merge_mints_id_and_stores_it() {
        let mut g = GridState::new();
        let m = g.add_merge(3);
        assert_eq!(g.node_count(), 1);
        assert!(matches!(
            g.node(m),
            Some(Node::Merge(Merge { inputs: 3, next: 0 }))
        ));
        // Has an inbox provisioned (mirror add_source/add_belt).
        assert!(g.inbox_of(m).is_some());
    }

    #[test]
    fn state_add_router_mints_id_and_stores_it() {
        let mut g = GridState::new();
        let r = g.add_router(vec![(RouteKey::new(0, vec![0x01]), 0)], Some(1));
        assert_eq!(g.node_count(), 1);
        match g.node(r) {
            Some(Node::Router(router)) => {
                assert_eq!(router.routes.len(), 1);
                assert_eq!(router.default, Some(1));
                assert_eq!(router.faults, 0, "fault counter starts at 0");
            }
            other => panic!("expected a Router node, got {other:?}"),
        }
        // Has an inbox provisioned (mirror add_source/add_belt).
        assert!(g.inbox_of(r).is_some());
    }

    #[test]
    fn state_add_factory_mints_id_stores_plain_data_and_inbox() {
        // add_factory mints an id, stores a Node::Factory with the source, the
        // gas budget, an empty-object ctx.state, and provisions an inbox.
        let mut g = GridState::new();
        let src = "export default function (input, ctx) { ctx.emit(0, input); }".to_owned();
        let f = g.add_factory(src.clone(), 256, 0xC0FFEE);
        assert_eq!(g.node_count(), 1);
        match g.node(f) {
            Some(Node::Factory(factory)) => {
                assert_eq!(factory.source, src);
                assert_eq!(factory.gas_budget, 256);
                assert_eq!(
                    factory.state_json, b"{}",
                    "a fresh factory's ctx.state is an empty object"
                );
            }
            other => panic!("expected a Factory node, got {other:?}"),
        }
        // Has an inbox provisioned (mirror add_source/add_belt).
        assert!(g.inbox_of(f).is_some());
    }

    #[test]
    fn state_factory_is_the_last_node_discriminant() {
        // Node::Factory must serialize at discriminant 6 (appended LAST) so the
        // frozen golden corpus 0001-0004 (Source..Router = 0..5) still decodes.
        // postcard encodes the leading enum discriminant as a varint, so the first
        // byte of an encoded Node::Factory is 6.
        let mut g = GridState::new();
        let f = g.add_factory("export default function (i, c) {}".to_owned(), 8, 1);
        let node = g.node(f).expect("factory node");
        let bytes = postcard::to_allocvec(node).expect("serialize node");
        assert_eq!(
            bytes.first(),
            Some(&6u8),
            "Factory is the 7th variant (discriminant 6), appended last"
        );
        // And the Phase-1/2 variants keep their frozen discriminants 0..5.
        for (want, node) in [
            (0u8, Node::Source(ManualInject::new())),
            (1u8, Node::Belt(Belt::new(0))),
            (2u8, Node::Tee(Tee::new(1))),
            (3u8, Node::Balancer(Balancer::new(1))),
            (4u8, Node::Merge(Merge::new(1))),
            (5u8, Node::Router(Router::new(Vec::new(), None))),
        ] {
            let bytes = postcard::to_allocvec(&node).expect("serialize node");
            assert_eq!(bytes.first(), Some(&want), "existing discriminant frozen");
        }
    }

    #[test]
    fn state_two_factories_get_distinct_deterministic_sub_seeds() {
        // Two factories in the same grid get distinct (deterministic) RNG
        // substreams: their first draws differ, and rebuilding the same grid from
        // the same seed reproduces the identical substreams.
        let build = || {
            let mut g = GridState::new();
            let f0 = g.add_factory("export default function (i, c) {}".to_owned(), 8, 99);
            let f1 = g.add_factory("export default function (i, c) {}".to_owned(), 8, 99);
            (g, f0, f1)
        };
        let (mut a, a0, a1) = build();
        let draw = |g: &mut GridState, id: NodeId| -> u64 {
            match g.node_mut(id) {
                Some(Node::Factory(factory)) => factory.rng.next_u64(),
                _ => panic!("expected a factory"),
            }
        };
        let a0_draw = draw(&mut a, a0);
        let a1_draw = draw(&mut a, a1);
        assert_ne!(
            a0_draw, a1_draw,
            "distinct node ids => distinct deterministic sub-seeds"
        );

        // Deterministic: the same seed + same construction order reproduces both.
        let (mut b, b0, b1) = build();
        assert_eq!(draw(&mut b, b0), a0_draw, "sub-seed is deterministic per node");
        assert_eq!(draw(&mut b, b1), a1_draw, "sub-seed is deterministic per node");
    }

    #[test]
    fn state_factory_grid_serde_round_trips_byte_identical() {
        // A GridState containing a Node::Factory serde round-trips byte-identically
        // (the Factory plain data + its embedded SimRng + state_json all serialize).
        let mut g = GridState::new();
        let s = g.add_source();
        let f = g.add_factory(
            "export default function (input, ctx) { ctx.state.n = (ctx.state.n||0)+1; }".to_owned(),
            128,
            0xABCD_1234,
        );
        g.link((s, 0), (f, 0));
        // Advance the factory's rng and mutate its state so the round-trip exercises
        // the non-genesis substream + a non-empty ctx.state.
        if let Some(Node::Factory(factory)) = g.node_mut(f) {
            let _ = factory.rng.next_u64();
            factory.state_json = b"{\"n\":3}".to_vec();
        }

        let bytes = postcard::to_allocvec(&g).expect("serialize factory grid");
        let restored: GridState = postcard::from_bytes(&bytes).expect("deserialize factory grid");
        let bytes2 = postcard::to_allocvec(&restored).expect("re-serialize factory grid");
        assert_eq!(
            bytes, bytes2,
            "GridState with a Node::Factory postcard round-trip is byte-identical"
        );
        // The restored factory observably matches.
        match restored.node(f) {
            Some(Node::Factory(factory)) => {
                assert_eq!(factory.gas_budget, 128);
                assert_eq!(factory.state_json, b"{\"n\":3}");
            }
            other => panic!("expected a restored Factory node, got {other:?}"),
        }
    }

    #[test]
    fn state_inert_wire_endpoint_nodes_round_trip_and_restore_ok() {
        // SCHEMA-03 / threat T-35-01-INERT: a GridState carrying the Phase-37/38
        // inert kinds (Node::Wire=8, Node::Endpoint=9) serializes, `restore`s Ok, and
        // round-trips byte-identically — the no-panic proof for a forged save-file.
        let mut g = GridState::new();
        let s = g.add_source();
        // No public minter for the inert kinds (they are validate-time rejects until
        // Phase 36/37/38); insert directly via the same private path add_sink uses.
        let w = g.allocator.insert(());
        g.nodes.insert(w, Node::Wire(WireLink { from: (s, 0), to: (s, 1), in_flight: VecDeque::new() }));
        let e = g.allocator.insert(());
        g.nodes.insert(e, Node::Endpoint(Endpoint { path: TEST_ENDPOINT_PATH.to_owned() }));

        let bytes = postcard::to_allocvec(&g).expect("serialize grid with inert nodes");
        // `restore` (deserialize) MUST succeed — a structurally-valid inert node.
        let restored: GridState =
            postcard::from_bytes(&bytes).expect("restore grid with inert nodes returns Ok");
        // Byte-identical re-encode (deterministic-container discipline).
        let bytes2 = postcard::to_allocvec(&restored).expect("re-serialize");
        assert_eq!(
            bytes, bytes2,
            "GridState with inert Wire/Endpoint nodes round-trips byte-identically"
        );
        // The restored inert kinds observably survive as their own variants.
        assert_eq!(
            restored.node(w),
            Some(&Node::Wire(WireLink { from: (s, 0), to: (s, 1), in_flight: VecDeque::new() })),
        );
        assert_eq!(restored.node(e), Some(&Node::Endpoint(Endpoint { path: TEST_ENDPOINT_PATH.to_owned() })));
    }

    #[test]
    fn state_routekey_matches_is_bounds_safe() {
        // Exact slice match at the offset.
        let key = RouteKey::new(1, vec![0x02, 0x03]);
        assert!(key.matches(&Item(vec![0x01, 0x02, 0x03, 0x04])));
        // Wrong bytes at the offset => no match.
        assert!(!key.matches(&Item(vec![0x01, 0x99, 0x03])));
        // Too-short item for the requested slice => no match, NEVER a panic
        // (RESEARCH Pitfall 4 / threat T-2-ITEM).
        assert!(!key.matches(&Item(vec![0x01])));
        assert!(!key.matches(&Item(vec![])));
        // Offset past the end => bounds-safe no-match.
        assert!(!RouteKey::new(10, vec![0xAA]).matches(&Item(vec![0x01, 0x02])));
    }

    #[test]
    fn state_link_records_directed_wiring() {
        let mut g = GridState::new();
        let a = g.add_source();
        let b = g.add_belt(0);
        g.link((a, 0), (b, 0));
        assert_eq!(g.link_target((a, 0)), Some((b, 0)));
        assert_eq!(g.link_target((a, 1)), None);
    }

    #[test]
    fn state_links_iter_yields_pairs_in_ascending_key_order() {
        // links_iter() is an additive read-only accessor: it returns every wired
        // (from, to) pair of a small grid in ascending BTreeMap key order, with no
        // field change (the snapshot trust gate reads it to find dangling targets).
        let mut g = GridState::new();
        let s = g.add_source();
        let b = g.add_belt(0);
        let c = g.add_source();
        // Insert links out of order; the iterator must still yield ascending keys.
        g.link((b, 0), (c, 0));
        g.link((s, 0), (b, 0));

        let pairs: Vec<((NodeId, PortId), (NodeId, PortId))> = g.links_iter().collect();
        // Ascending by (NodeId, PortId): s < b < c (ids minted in that order).
        assert_eq!(pairs, vec![((s, 0), (b, 0)), ((b, 0), (c, 0))]);

        // Read-only: the wiring is unchanged, link_target still resolves.
        assert_eq!(g.link_target((s, 0)), Some((b, 0)));
        assert_eq!(g.node_count(), 3);
    }

    #[test]
    fn state_ports_sorted_resolves_lowest_port_first_route06() {
        // ROUTE-06: items on port 2 and port 0 resolve port 0 first.
        let mut inbox = PortInbox::new();
        // Push to port 2 BEFORE port 0 to prove order is by port index, not
        // insertion / arrival order.
        inbox.push(2, /*seq*/ 10, Item(vec![0xB2]));
        inbox.push(0, /*seq*/ 11, Item(vec![0xA0]));
        // And a second item on port 0 with a later seq — FIFO within a port.
        inbox.push(0, /*seq*/ 12, Item(vec![0xA1]));

        let ports: Vec<PortId> = inbox.ports_sorted().collect();
        assert_eq!(ports, vec![0, 2], "lowest port resolves first (left priority)");

        // Within port 0, FIFO order with event_seq attached for tie-break.
        assert_eq!(inbox.take(0), Some((11, Item(vec![0xA0]))));
        assert_eq!(inbox.take(0), Some((12, Item(vec![0xA1]))));
        assert_eq!(inbox.take(0), None, "port 0 drained");
        // Port 2 still holds its item.
        assert_eq!(inbox.take(2), Some((10, Item(vec![0xB2]))));
        assert!(inbox.is_empty());
    }

    #[test]
    fn state_outbox_drains_in_ascending_port_order() {
        let mut out = PortOutbox::new();
        out.push(2, Item(vec![2]));
        out.push(0, Item(vec![0]));
        out.push(0, Item(vec![1])); // FIFO within port 0
        let drained = out.drain_sorted();
        assert_eq!(
            drained,
            vec![
                (0u16, Item(vec![0])),
                (0u16, Item(vec![1])),
                (2u16, Item(vec![2])),
            ]
        );
        assert!(out.is_empty(), "drain clears the outbox");
    }

    #[test]
    fn state_grid_serde_round_trips_byte_identical() {
        let mut g = GridState::new();
        let s = g.add_source();
        let b = g.add_belt(5);
        g.link((s, 0), (b, 0));
        g.inbox_mut(b).push(0, 7, Item(vec![1, 2, 3]));

        let bytes = postcard::to_allocvec(&g).expect("serialize grid");
        let restored: GridState = postcard::from_bytes(&bytes).expect("deserialize grid");
        // Re-encode must be byte-identical (deterministic-container discipline).
        let bytes2 = postcard::to_allocvec(&restored).expect("re-serialize grid");
        assert_eq!(bytes, bytes2, "GridState postcard round-trip is byte-identical");

        // And the restored grid observably matches.
        assert_eq!(restored.node_count(), 2);
        assert_eq!(restored.link_target((s, 0)), Some((b, 0)));
        assert_eq!(
            restored.inbox_of(b).and_then(|i| {
                let mut i = i.clone();
                i.take(0)
            }),
            Some((7, Item(vec![1, 2, 3])))
        );
    }

    #[test]
    fn state_cells_round_trip_rebuilds_occupancy() {
        // SPAT-01 (RESEARCH Pitfall 3): the serialized `cells` source round-trips
        // byte-identically; the #[serde(skip)] `occupancy` index decodes EMPTY and is
        // rebuilt from `cells` via rebuild_occupancy, so occupied/cell_of survive.
        let mut g = GridState::new();
        let n = g.add_source();
        g.set_cell(n, (3, -4));
        assert_eq!(g.cell_of(n), Some((3, -4)));
        assert_eq!(g.occupied((3, -4)), Some(n));

        let bytes = postcard::to_allocvec(&g).expect("serialize grid with a cell");
        let mut restored: GridState = postcard::from_bytes(&bytes).expect("deserialize");
        // The derived index is cold (empty) immediately after decode.
        assert_eq!(
            restored.occupied((3, -4)),
            None,
            "occupancy is #[serde(skip)] — cold after decode"
        );
        restored.rebuild_occupancy();
        assert_eq!(restored.cell_of(n), Some((3, -4)), "cells survived the round-trip");
        assert_eq!(restored.occupied((3, -4)), Some(n), "occupancy rebuilt from cells");
        // Re-encode is byte-identical (occupancy skipped, cells ordered BTreeMap).
        let bytes2 = postcard::to_allocvec(&restored).expect("re-serialize");
        assert_eq!(bytes, bytes2, "cells round-trip is byte-identical");
    }

    #[test]
    fn state_set_cell_move_drops_stale_occupancy() {
        // Moving a node to a new cell frees its old occupancy entry (occupancy stays
        // a faithful inverse of cells).
        let mut g = GridState::new();
        let n = g.add_source();
        g.set_cell(n, (0, 0));
        g.set_cell(n, (5, 5)); // move
        assert_eq!(g.cell_of(n), Some((5, 5)));
        assert_eq!(g.occupied((5, 5)), Some(n));
        assert_eq!(g.occupied((0, 0)), None, "stale reverse entry dropped on move");
    }

    #[test]
    fn state_set_cell_occupancy_matches_rebuild_after_move_and_collision() {
        // WR-09-01: a live set_cell sequence (incl. a MOVE and a would-COLLIDE)
        // keeps `occupancy` byte-identical to what rebuild_occupancy reconstructs
        // from `cells`, so a live Core and its restored twin can never disagree on
        // occupied(). `cells` stays injective on positions (the colliding node is
        // evicted).
        let mut g = GridState::new();
        let a = g.add_source();
        let b = g.add_source();
        let c = g.add_source();
        g.set_cell(a, (0, 0));
        g.set_cell(b, (1, 1));
        g.set_cell(a, (2, 2)); // MOVE a: (0,0) -> (2,2), frees (0,0)
        g.set_cell(c, (1, 1)); // COLLIDE: c lands on b's cell -> b evicted

        // A twin rebuilt from the SAME `cells` must agree cell-for-cell with the
        // live index — the exact live-vs-restored equivalence the fix guarantees.
        let mut twin = g.clone();
        twin.rebuild_occupancy();
        for &cell in &[(0, 0), (1, 1), (2, 2)] {
            assert_eq!(
                g.occupied(cell),
                twin.occupied(cell),
                "live occupancy must equal rebuild_occupancy at {cell:?}"
            );
        }
        // Concrete end state: (0,0) freed, c won (1,1) (b evicted), a at (2,2).
        assert_eq!(g.occupied((0, 0)), None, "moved-from cell freed");
        assert_eq!(g.occupied((1, 1)), Some(c), "collision: last writer wins the cell");
        assert_eq!(g.occupied((2, 2)), Some(a));
        assert_eq!(g.cell_of(b), None, "b evicted from cells on collision (injective)");
        assert_eq!(g.cell_of(c), Some((1, 1)));
        assert_eq!(g.cell_of(a), Some((2, 2)));
    }

    #[test]
    fn state_remove_node_clears_cell_and_occupancy() {
        // remove_node drops EVERY trace incl. the cell + its reverse occupancy entry.
        let mut g = GridState::new();
        let n = g.add_source();
        g.set_cell(n, (1, 2));
        assert_eq!(g.remove_node(n), vec![n], "node removed (no docked belts)");
        assert_eq!(g.cell_of(n), None, "cell cleared");
        assert_eq!(g.occupied((1, 2)), None, "occupancy cleared");
    }

    #[test]
    fn state_remove_belt_frees_geometry_cells_and_drops_items() {
        // BELT-08: deleting a DrawBelt belt frees EVERY tile cell it claimed in the
        // unified occupancy AND drops its in-flight items (the slots go with the
        // node — the deterministic discard, not a fault).
        let mut g = GridState::new();
        let b = g.add_belt(2);
        let geometry = [
            BeltTile { cell: (3, 3), kind: TileKind::default() },
            BeltTile { cell: (4, 3), kind: TileKind::default() },
        ];
        g.claim_belt_tiles(b, &geometry);
        // Record the geometry ON the node (the single SERIALIZED truth) plus an
        // in-flight item in a slot — both must vanish with the node.
        match g.node_mut(b) {
            Some(Node::Belt(belt)) => {
                belt.geometry = geometry.to_vec();
                belt.slots[0] = Some(Item(vec![0xAB]));
            }
            other => panic!("expected a Belt node, got {other:?}"),
        }
        assert_eq!(g.occupied((3, 3)), Some(b), "geometry claimed before delete");
        assert_eq!(g.occupied((4, 3)), Some(b), "geometry claimed before delete");

        assert_eq!(g.remove_node(b), vec![b], "belt removed (no cascade)");
        assert_eq!(g.occupied((3, 3)), None, "geometry cell freed on delete");
        assert_eq!(g.occupied((4, 3)), None, "geometry cell freed on delete");
        assert!(g.node(b).is_none(), "belt node gone (slots + items dropped with it)");
        assert!(g.inbox_of(b).is_none(), "belt inbox gone");
    }

    #[test]
    fn state_delete_machine_cascade_frees_both_footprint_and_belt_geometry() {
        // Deleting a machine cascade-detaches its docked DrawBelt belt (FOOT-04) and
        // frees BOTH the machine footprint cells AND the belt's geometry tile cells
        // (whole-footprint + whole-geometry free).
        let mut g = GridState::new();
        let m = g.add_source();
        g.claim_footprint(m, (0, 0), 2, 1, 0); // footprint cells (0,0),(1,0)
        let b = g.add_belt(1);
        let geometry = [BeltTile { cell: (2, 0), kind: TileKind::default() }];
        g.claim_belt_tiles(b, &geometry);
        match g.node_mut(b) {
            Some(Node::Belt(belt)) => belt.geometry = geometry.to_vec(),
            other => panic!("expected a Belt node, got {other:?}"),
        }
        // Dock the belt to the machine: a link makes docked_wire_belts pick it up.
        g.link((m, 0), (b, 0));
        assert_eq!(g.occupied((0, 0)), Some(m), "footprint cell claimed");
        assert_eq!(g.occupied((1, 0)), Some(m), "footprint cell claimed");
        assert_eq!(g.occupied((2, 0)), Some(b), "belt geometry claimed");

        let removed = g.remove_node(m);
        assert_eq!(removed, vec![m, b], "machine first, then cascade-detached belt");
        assert_eq!(g.occupied((0, 0)), None, "footprint cell freed");
        assert_eq!(g.occupied((1, 0)), None, "footprint cell freed");
        assert_eq!(g.occupied((2, 0)), None, "belt geometry cell freed by cascade");
    }

    #[test]
    fn state_capture_deleted_subgraph_mirrors_the_cascade_set() {
        // 12-05: capture_deleted_subgraph reads the SAME deterministic cascade set
        // remove_node uses, recording the machine footprint + every docked belt's
        // geometry + incident links BEFORE the delete folds (the undo payload).
        let mut g = GridState::new();
        let m = g.add_source();
        g.claim_footprint(m, (0, 0), 2, 1, 0);
        g.set_ports(
            m,
            vec![Port { local_offset: (1, 0), side: Side::E, role: Role::Out, medium: Medium::Mechanical }],
        );
        let b = g.add_belt(1);
        let geometry = [BeltTile { cell: (2, 0), kind: TileKind::default() }];
        g.claim_belt_tiles(b, &geometry);
        if let Some(Node::Belt(belt)) = g.node_mut(b) {
            belt.geometry = geometry.to_vec();
        }
        g.link((m, 0), (b, 0)); // dock the belt to the machine's Out port

        let captured = g.capture_deleted_subgraph(m);
        // The machine's resolved footprint + its one declared port are captured.
        assert_eq!((captured.w, captured.h), (2, 1), "machine footprint captured");
        assert_eq!(captured.ports.len(), 1, "the declared Out port is captured");
        // The cascade set matches docked_wire_belts exactly (one belt), with geometry.
        assert_eq!(captured.belts.len(), g.docked_wire_belts(m).len());
        assert_eq!(captured.belts.len(), 1, "the one docked belt is captured");
        let belt = &captured.belts[0];
        assert_eq!(belt.kind, 1, "a cascade belt is machine_kind BELT");
        assert_eq!(belt.geometry, geometry.to_vec(), "belt geometry captured");
        assert_eq!(belt.links, vec![(m, 0, b, 0)], "the dock link captured (BTreeMap order)");

        // A bare 1×1 belt-less machine captures the trivially-empty subgraph.
        let lone = g.add_source();
        let empty = g.capture_deleted_subgraph(lone);
        assert_eq!((empty.w, empty.h), (1, 1), "absent footprint ⇒ faithful 1×1");
        assert!(empty.ports.is_empty() && empty.belts.is_empty(), "no ports / no belts");

        // A node that is no longer on the board captures the EMPTY subgraph, not a 1 by 1
        // read off nothing (phase 86 review, CR-01).
        let _ = g.remove_node(lone);
        assert!(g.capture_deleted_subgraph(lone).is_empty(), "an absent node captures nothing");
    }

    #[test]
    fn state_post_delete_snapshot_round_trips_clean_no_occupancy_ghost() {
        // After a belt delete, a snapshot restores byte-identically: the freed cells
        // stay free through rebuild_occupancy (no leaked/ghost occupancy entry), and
        // a surviving belt's cells are re-claimed from the serialized geometry truth.
        let mut g = GridState::new();
        let keep = g.add_belt(1);
        let keep_geo = [BeltTile { cell: (10, 10), kind: TileKind::default() }];
        g.claim_belt_tiles(keep, &keep_geo);
        if let Some(Node::Belt(belt)) = g.node_mut(keep) {
            belt.geometry = keep_geo.to_vec();
        }
        let doomed = g.add_belt(1);
        let doomed_geo = [BeltTile { cell: (11, 10), kind: TileKind::default() }];
        g.claim_belt_tiles(doomed, &doomed_geo);
        if let Some(Node::Belt(belt)) = g.node_mut(doomed) {
            belt.geometry = doomed_geo.to_vec();
            belt.slots[0] = Some(Item(vec![0x01]));
        }
        g.remove_node(doomed);

        let bytes = postcard::to_allocvec(&g).expect("serialize post-delete grid");
        let mut twin: GridState = postcard::from_bytes(&bytes).expect("deserialize");
        // occupancy is #[serde(skip)] — cold after decode until rebuilt.
        twin.rebuild_occupancy();
        assert_eq!(
            twin.occupied((11, 10)),
            None,
            "freed cell stays free after rebuild (no occupancy ghost)"
        );
        assert_eq!(
            twin.occupied((10, 10)),
            Some(keep),
            "surviving belt's geometry cell re-claimed from the serialized truth"
        );
        let bytes2 = postcard::to_allocvec(&twin).expect("re-serialize");
        assert_eq!(bytes, bytes2, "post-delete grid round-trips byte-identically");
    }

    #[test]
    fn state_claim_footprint_1x1_is_identical_to_set_cell() {
        // FOOT-01 faithfulness: claim_footprint(1×1) writes exactly ONE occupancy
        // entry, the canonical cell, and NO footprints/ports entry — byte-identical
        // to set_cell on a fresh mint.
        let mut claimed = GridState::new();
        let a = claimed.add_source();
        claimed.claim_footprint(a, (3, -4), 1, 1, 0);

        let mut set = GridState::new();
        let b = set.add_source();
        set.set_cell(b, (3, -4));

        assert_eq!(claimed.cell_of(a), Some((3, -4)));
        assert_eq!(claimed.occupied((3, -4)), Some(a));
        assert_eq!(claimed.footprint_of(a), None, "a 1×1 writes NO footprints entry");
        assert_eq!(claimed.ports_of(a), None, "a 1×1 writes NO ports entry");
        // Byte-identical serialization to the set_cell path (ids match: both first mint).
        let cb = postcard::to_allocvec(&claimed).expect("serialize claimed");
        let sb = postcard::to_allocvec(&set).expect("serialize set_cell");
        assert_eq!(cb, sb, "claim_footprint(1×1) == set_cell byte-for-byte on a fresh mint");
    }

    #[test]
    fn state_claim_footprint_multicell_indexes_every_body_cell() {
        // A 2×3 claim at (2,2) indexes all 6 body cells → id and records the footprint.
        let mut g = GridState::new();
        let m = g.add_source();
        g.claim_footprint(m, (2, 2), 2, 3, 0);
        assert_eq!(g.cell_of(m), Some((2, 2)), "anchor is the canonical cell");
        assert_eq!(g.footprint_of(m), Some(Footprint { w: 2, h: 3, rot: 0 }));
        let body: Vec<_> = cells_of_footprint((2, 2), 2, 3, 0).collect();
        assert_eq!(body.len(), 6);
        for cell in &body {
            assert_eq!(g.occupied(*cell), Some(m), "every body cell {cell:?} reads occupied");
        }
        assert_eq!(g.occupied((4, 2)), None, "a cell outside the body is free");
    }

    #[test]
    fn state_claim_footprint_multicell_rebuild_round_trip_agrees_cell_for_cell() {
        // A restored twin (rebuilt from cells+footprints) agrees cell-for-cell with
        // the live index for a multi-cell grid — the FOOT-01 restore guarantee.
        let mut g = GridState::new();
        let m = g.add_source();
        g.claim_footprint(m, (5, 5), 2, 3, 0);

        let bytes = postcard::to_allocvec(&g).expect("serialize multi-cell grid");
        let mut twin: GridState = postcard::from_bytes(&bytes).expect("deserialize");
        // occupancy is #[serde(skip)] — cold after decode until rebuilt.
        assert_eq!(twin.occupied((5, 5)), None, "occupancy cold after decode");
        twin.rebuild_occupancy();
        for cell in cells_of_footprint((5, 5), 2, 3, 0) {
            assert_eq!(
                g.occupied(cell),
                twin.occupied(cell),
                "live vs restored occupancy must agree at {cell:?}"
            );
        }
        // Re-encode is byte-identical (occupancy skipped; cells+footprints ordered).
        let bytes2 = postcard::to_allocvec(&twin).expect("re-serialize");
        assert_eq!(bytes, bytes2, "multi-cell grid round-trips byte-identically");
    }

    #[test]
    fn state_cells_of_footprint_swaps_box_on_odd_rot_and_yields_w_times_h() {
        // rot-0 2×3 box anchored at (10,20): 6 cells, row-major order.
        let even: Vec<_> = cells_of_footprint((10, 20), 2, 3, 0).collect();
        assert_eq!(even.len(), 6);
        assert_eq!(even[0], (10, 20), "first cell is the anchor (min-corner)");
        assert_eq!(even[1], (11, 20), "i inner advances x first");
        assert_eq!(even[2], (10, 21), "j outer advances y");
        // odd rot swaps the effective box to 3×2 — still 6 cells, anchor fixed.
        let odd: Vec<_> = cells_of_footprint((10, 20), 2, 3, 1).collect();
        assert_eq!(odd.len(), 6);
        assert_eq!(odd[0], (10, 20), "anchor preserved under rotation");
        assert_eq!(odd[1], (11, 20));
        assert_eq!(odd[2], (12, 20), "effective width is now h=3");
    }

    #[test]
    fn state_one_by_one_rotation_is_a_noop() {
        let p = Port { local_offset: (0, 0), side: Side::E, role: Role::Out, medium: Medium::Mechanical };
        for rot in 0u8..4 {
            let cells: Vec<_> = cells_of_footprint((5, 7), 1, 1, rot).collect();
            assert_eq!(cells, vec![(5, 7)], "1×1 yields only its anchor at rot {rot}");
            let (cell, _side) = port_world((5, 7), 1, 1, rot, &p);
            assert_eq!(cell, (5, 7), "1×1 port world-cell is the anchor at rot {rot}");
        }
    }

    #[test]
    fn state_port_world_matches_verified_rot_table() {
        // Asymmetric 2×3 with a port at local (1,2) facing East.
        let p = Port { local_offset: (1, 2), side: Side::E, role: Role::In, medium: Medium::Mechanical };
        let a = (0, 0);
        assert_eq!(port_world(a, 2, 3, 0, &p), ((1, 2), Side::E));
        assert_eq!(port_world(a, 2, 3, 1, &p), ((0, 1), Side::S)); // (h-1-y, x)=(0,1), (E+1)=S
        assert_eq!(port_world(a, 2, 3, 2, &p), ((0, 0), Side::W)); // (w-1-x, h-1-y)=(0,0), (E+2)=W
        assert_eq!(port_world(a, 2, 3, 3, &p), ((2, 0), Side::N)); // (y, w-1-x)=(2,0), (E+3)=N
    }

    #[test]
    fn state_unit_delta_and_opposite_use_pinned_y_down_axis() {
        assert_eq!(unit_delta(Side::N), (0, -1));
        assert_eq!(unit_delta(Side::E), (1, 0));
        assert_eq!(unit_delta(Side::S), (0, 1));
        assert_eq!(unit_delta(Side::W), (-1, 0));
        assert_eq!(opposite(Side::N), Side::S);
        assert_eq!(opposite(Side::E), Side::W);
        assert_eq!(opposite(Side::S), Side::N);
        assert_eq!(opposite(Side::W), Side::E);
    }

    // ───────────────── PORT-07: grow_to_fit / reseat / base_footprint (36-01) ─────────────────

    /// A rot-0 mechanical port of `role` — a compact builder for the geometry tests
    /// (local_offset/side are recomputed by `reseat_ports`, so any placeholder is fine).
    fn mech(role: Role) -> Port {
        Port { local_offset: (0, 0), side: Side::N, role, medium: Medium::Mechanical }
    }

    const ROUTER_BASE: Footprint = Footprint { w: 2, h: 3, rot: 0 };

    #[test]
    fn grow_to_fit_is_idempotent_on_the_router_1in2out_seed() {
        // The FLOOR directive: the Router preset seed (1 in / 2 out) sizes to EXACTLY
        // its frozen 2×3 base — grow_to_fit never shrinks a non-minimal base below it.
        let seed = [mech(Role::In), mech(Role::Out), mech(Role::Out)];
        assert_eq!(grow_to_fit(ROUTER_BASE, &seed), ROUTER_BASE);
    }

    #[test]
    fn grow_to_fit_floors_at_base_when_ports_shrink() {
        // Remove an output (1 in / 1 out): min-rect wants 2×1 but the 2×3 FLOOR holds.
        let one_out = [mech(Role::In), mech(Role::Out)];
        assert_eq!(grow_to_fit(ROUTER_BASE, &one_out), ROUTER_BASE);
        // Even a single port cannot shrink the Router below its 2×3 base.
        assert_eq!(grow_to_fit(ROUTER_BASE, &[mech(Role::In)]), ROUTER_BASE);
        // A Source (1×1 base) with its single Out stays 1×1 (base == min-rect).
        let src_base = Footprint { w: 1, h: 1, rot: 0 };
        assert_eq!(grow_to_fit(src_base, &[mech(Role::Out)]), src_base);
    }

    #[test]
    fn grow_to_fit_grows_height_above_the_base_output_count() {
        // A 4th output (1 in / 4 out): min_h = 4 > base.h(3) ⇒ grows to 2×4; width
        // stays at the base (only 2 vertical columns needed).
        let four_out = [
            mech(Role::In),
            mech(Role::Out),
            mech(Role::Out),
            mech(Role::Out),
            mech(Role::Out),
        ];
        assert_eq!(grow_to_fit(ROUTER_BASE, &four_out), Footprint { w: 2, h: 4, rot: 0 });
    }

    #[test]
    fn grow_to_fit_widens_for_many_fault_ports() {
        // Fault ports spread along the S row → they drive WIDTH. Base 2×3, 5 faults +
        // 1 in + 1 out: min_w = max(vertical_cols=2, n_fault=5) = 5 ⇒ 5×3.
        let mut ports = vec![mech(Role::In), mech(Role::Out)];
        ports.extend(std::iter::repeat_n(mech(Role::Fault), 5));
        assert_eq!(grow_to_fit(ROUTER_BASE, &ports), Footprint { w: 5, h: 3, rot: 0 });
    }

    #[test]
    fn grow_to_fit_preserves_base_rot() {
        // rot is carried from the base (the frozen rot-0 declaration in this plan).
        let rotated_base = Footprint { w: 2, h: 3, rot: 2 };
        let seed = [mech(Role::In), mech(Role::Out)];
        assert_eq!(grow_to_fit(rotated_base, &seed).rot, 2);
    }

    #[test]
    fn base_footprint_hard_codes_every_operators_true_frozen_base() {
        // The per-kind FLOOR — byte-for-byte the port_catalog dims (parity-tested in
        // fabrico-command, plan 02). NO {1,1,0} catch-all that could shrink a base.
        let mut g = GridState::new();
        let checks: [(NodeId, Footprint); 7] = [
            (g.add_source(), Footprint { w: 1, h: 1, rot: 0 }),
            (g.add_sink(SinkTemplate::Debug, 600), Footprint { w: 1, h: 1, rot: 0 }),
            (g.add_factory(String::new(), 0, 0), Footprint { w: 3, h: 3, rot: 0 }),
            (g.add_tee(2), Footprint { w: 2, h: 2, rot: 0 }),
            (g.add_balancer(2), Footprint { w: 2, h: 2, rot: 0 }),
            (g.add_merge(2), Footprint { w: 2, h: 2, rot: 0 }),
            (g.add_router(Vec::new(), Some(0)), Footprint { w: 2, h: 3, rot: 0 }),
        ];
        for (id, want) in checks {
            let node = g.node(id).unwrap();
            assert_eq!(base_footprint(node), want, "base_footprint drift for {node:?}");
        }
    }

    /// The catalog boxes a `reseat_ports` base can be (every `base_footprint` arm's dims).
    const BASES: [Footprint; 4] = [
        Footprint { w: 1, h: 1, rot: 0 },
        Footprint { w: 2, h: 2, rot: 0 },
        Footprint { w: 2, h: 3, rot: 0 },
        Footprint { w: 3, h: 3, rot: 0 },
    ];

    #[test]
    fn role_slot_fills_middle_then_below_then_above_then_grows() {
        // (layout ruling 2026-10-04): a 3-long side fills 1, 2, 0, then grows
        // 3, 4, 5; a 2- or 1-long side keeps the index slots.
        assert_eq!((0..6).map(|k| role_slot(k, 3)).collect::<Vec<_>>(), vec![1, 2, 0, 3, 4, 5]);
        assert_eq!((0..4).map(|k| role_slot(k, 2)).collect::<Vec<_>>(), vec![0, 1, 2, 3]);
        assert_eq!((0..3).map(|k| role_slot(k, 1)).collect::<Vec<_>>(), vec![0, 1, 2]);
        // A 5-long side: 2, 3, 1, 4, 0, then 5.
        assert_eq!((0..6).map(|k| role_slot(k, 5)).collect::<Vec<_>>(), vec![2, 3, 1, 4, 0, 5]);
        // Total on a zero-length side (no real footprint has one): the index rule.
        assert_eq!(role_slot(0, 0), 0);
    }

    #[test]
    fn reseat_ports_fills_each_side_centre_out_from_the_catalog_box() {
        // A 3x3 base (the Factory): In_k -> (0, [1,2,0][k]) W; Out_k -> (w-1, ..) E;
        // Fault_k -> ([1,2,0][k], h-1) S, in a 3x3 box.
        let three = Footprint { w: 3, h: 3, rot: 0 };
        let ports = [
            mech(Role::In),
            mech(Role::Out),
            mech(Role::Fault),
            mech(Role::In),
            mech(Role::Out),
            mech(Role::Out),
            mech(Role::Fault),
        ];
        let seated = reseat_ports(three, 3, 3, &ports);
        let got: Vec<_> = seated.iter().map(|p| (p.local_offset, p.side)).collect();
        assert_eq!(
            got,
            vec![
                ((0, 1), Side::W),
                ((2, 1), Side::E),
                ((1, 2), Side::S),
                ((0, 2), Side::W),
                ((2, 2), Side::E),
                ((2, 0), Side::E),
                ((2, 2), Side::S),
            ]
        );
        // A 2x2 base (the Tee, Balancer, Merge): the index rows, as before 74.1-14.
        let two = Footprint { w: 2, h: 2, rot: 0 };
        let seated = reseat_ports(two, 2, 3, &[mech(Role::In), mech(Role::Out), mech(Role::Out), mech(Role::Out)]);
        let got: Vec<_> = seated.iter().map(|p| p.local_offset).collect();
        assert_eq!(got, vec![(0, 0), (1, 0), (1, 1), (1, 2)]);
        // A 1x1 base (the Source, Sink, Endpoint): the index rows too.
        let one = Footprint { w: 1, h: 1, rot: 0 };
        let seated = reseat_ports(one, 2, 2, &[mech(Role::In), mech(Role::Out), mech(Role::Out)]);
        let got: Vec<_> = seated.iter().map(|p| p.local_offset).collect();
        assert_eq!(got, vec![(0, 0), (1, 0), (1, 1)]);
        // Role + medium are preserved; only offset/side move.
        for (s, o) in reseat_ports(three, 3, 3, &ports).iter().zip(ports.iter()) {
            assert_eq!(s.role, o.role);
            assert_eq!(s.medium, o.medium);
        }
    }

    #[test]
    fn reseat_ports_clamps_fault_x_into_the_box() {
        // Two faults on a width-1 box both clamp to x = w-1 = 0 (min(slot, w-1)).
        let one = Footprint { w: 1, h: 1, rot: 0 };
        let seated = reseat_ports(one, 1, 1, &[mech(Role::Fault), mech(Role::Fault)]);
        assert_eq!(seated[0].local_offset, (0, 0));
        assert_eq!(seated[1].local_offset, (0, 0));
    }

    #[test]
    fn write_port_geometry_is_absent_node_noop() {
        // A node with no cell writes NO map entry (threat T-36-04).
        let mut g = GridState::new();
        let id = g.add_router(Vec::new(), Some(0)); // minted but not placed: no cell
        g.set_ports(id, vec![mech(Role::In), mech(Role::Out)]);
        let before = g.clone();
        let geom = add_port_geometry(
            ROUTER_BASE,
            (0, 0),
            ROUTER_BASE,
            &[],
            0,
            mech(Role::Out),
            crate::edit::PortSeat::Auto,
        );
        g.write_port_geometry(id, &geom);
        assert_eq!(g.footprint_of(id), before.footprint_of(id));
        assert_eq!(g.ports_of(id), before.ports_of(id));
        assert_eq!(g.cell_of(id), None);
    }

    #[test]
    fn a_fourth_out_grows_the_router_and_claims_only_the_new_row() {
        // A 2x3 Router at (10,10) carrying its catalog Outs on rows 1, 2, 0: a fourth Out
        // takes the first free slot, row 3, the box grows to 2x4, every existing port keeps
        // its slot, and the 4th row of cells is claimed.
        let mut g = GridState::new();
        let id = g.add_router(Vec::new(), Some(0));
        g.claim_footprint(id, (10, 10), 2, 3, 0);
        let at = |x: i32, y: i32, side: Side, role: Role| Port {
            local_offset: (x, y),
            side,
            role,
            medium: Medium::Mechanical,
        };
        let catalog = vec![
            at(0, 1, Side::W, Role::In),
            at(1, 1, Side::E, Role::Out),
            at(1, 2, Side::E, Role::Out),
            at(1, 0, Side::E, Role::Out),
        ];
        g.set_ports(id, catalog.clone());
        let geom = add_port_geometry(
            ROUTER_BASE,
            (10, 10),
            ROUTER_BASE,
            &catalog,
            4,
            mech(Role::Out),
            crate::edit::PortSeat::Auto,
        );
        g.write_port_geometry(id, &geom);
        assert_eq!(g.footprint_of(id), Some(Footprint { w: 2, h: 4, rot: 0 }));
        assert_eq!(g.cell_of(id), Some((10, 10)), "rot 0 grows south: the anchor stays");
        assert_eq!(g.occupied((10, 13)), Some(id));
        assert_eq!(g.occupied((11, 13)), Some(id));
        let got: Vec<_> = g.ports_of(id).unwrap().iter().map(|p| (p.local_offset, p.side)).collect();
        assert_eq!(
            got,
            vec![
                ((0, 1), Side::W),
                ((1, 1), Side::E),
                ((1, 2), Side::E),
                ((1, 0), Side::E),
                ((1, 3), Side::E),
            ]
        );
    }

    #[test]
    fn a_growing_add_shifts_the_anchor_by_the_rotation_table() {
        // A 3x3 box grown to 3x4 (dh = 1) and, separately, to 4x3 (dw = 1), at each turn.
        // The anchor shift is rot 0 (0,0), rot 1 (-dh,0), rot 2 (-dw,-dh), rot 3 (0,-dw).
        let base = Footprint { w: 3, h: 3, rot: 0 };
        let full_outs: Vec<Port> = [1, 2, 0]
            .iter()
            .map(|&y| Port { local_offset: (2, y), side: Side::E, role: Role::Out, medium: Medium::Mechanical })
            .collect();
        let full_faults: Vec<Port> = [1, 2, 0]
            .iter()
            .map(|&x| Port { local_offset: (x, 2), side: Side::S, role: Role::Fault, medium: Medium::Mechanical })
            .collect();
        let taller = [(0, 0), (-1, 0), (0, -1), (0, 0)];
        let wider = [(0, 0), (0, 0), (-1, 0), (0, -1)];
        for rot in 0..4u8 {
            let fp = Footprint { rot, ..base };
            let g = add_port_geometry(base, (20, 20), fp, &full_outs, 3, mech(Role::Out), crate::edit::PortSeat::Auto);
            assert_eq!(g.footprint, Footprint { w: 3, h: 4, rot });
            let (dx, dy) = taller[usize::from(rot)];
            assert_eq!(g.anchor, (20 + dx, 20 + dy), "rot {rot}: taller");
            // Every existing Out keeps its world cell.
            for (before, after) in full_outs.iter().zip(&g.ports) {
                assert_eq!(port_world((20, 20), 3, 3, rot, before), port_world(g.anchor, 3, 4, rot, after));
            }
            let g = add_port_geometry(base, (20, 20), fp, &full_faults, 3, mech(Role::Fault), crate::edit::PortSeat::Auto);
            assert_eq!(g.footprint, Footprint { w: 4, h: 3, rot });
            let (dx, dy) = wider[usize::from(rot)];
            assert_eq!(g.anchor, (20 + dx, 20 + dy), "rot {rot}: wider");
            for (before, after) in full_faults.iter().zip(&g.ports) {
                assert_eq!(port_world((20, 20), 3, 3, rot, before), port_world(g.anchor, 4, 3, rot, after));
            }
        }
    }

    #[test]
    fn first_free_slot_fills_a_hole_before_growing() {
        let base = Footprint { w: 3, h: 3, rot: 0 };
        let out = |y: i32| Port { local_offset: (2, y), side: Side::E, role: Role::Out, medium: Medium::Mechanical };
        assert_eq!(first_free_slot(base, &[], Role::Out), 1, "the middle row first");
        assert_eq!(first_free_slot(base, &[out(1)], Role::Out), 2);
        assert_eq!(first_free_slot(base, &[out(1), out(2)], Role::Out), 0);
        assert_eq!(first_free_slot(base, &[out(1), out(2), out(0)], Role::Out), 3, "then it grows");
        assert_eq!(first_free_slot(base, &[out(2), out(0)], Role::Out), 1, "a freed middle row is refilled");
        assert_eq!(first_free_slot(base, &[out(1), out(0)], Role::Out), 2, "a freed lower row is refilled");
    }

    #[test]
    fn a_removal_keeps_the_box_and_a_restore_puts_the_pre_add_box_back() {
        let fp = Footprint { w: 3, h: 4, rot: 1 };
        let ports = vec![
            Port { local_offset: (0, 1), side: Side::W, role: Role::In, medium: Medium::Mechanical },
            Port { local_offset: (2, 1), side: Side::E, role: Role::Out, medium: Medium::Mechanical },
            Port { local_offset: (1, 3), side: Side::S, role: Role::Fault, medium: Medium::Mechanical },
            Port { local_offset: (2, 3), side: Side::E, role: Role::Out, medium: Medium::Mechanical },
        ];
        let kept = remove_port_geometry((19, 20), fp, &ports, 1, None);
        assert_eq!(kept.anchor, (19, 20));
        assert_eq!(kept.footprint, fp, "a removal never shrinks");
        assert_eq!(kept.ports, vec![ports[0], ports[2], ports[3]], "and moves no survivor");
        let restored = remove_port_geometry(
            (19, 20),
            fp,
            &ports,
            3,
            Some(crate::edit::BoxRestore { w: 3, h: 3, anchor_x: 20, anchor_y: 20 }),
        );
        assert_eq!(restored.anchor, (20, 20));
        assert_eq!(restored.footprint, Footprint { w: 3, h: 3, rot: 1 });
        assert_eq!(restored.ports[2].local_offset, (1, 2), "the Fault returns to the restored bottom row");
        // An out-of-range index is total and changes nothing.
        let same = remove_port_geometry((19, 20), fp, &ports, 9, None);
        assert_eq!(same.ports, ports);
    }

    use proptest::prelude::*;

    proptest! {
        /// Totality (T-36-01): ANY port multiset (incl. thousands, forged over-cap)
        /// returns without panic and saturates at MAX_FOOTPRINT_DIM.
        #[test]
        fn prop_grow_to_fit_is_total_and_saturates(
            n_in in 0usize..5000,
            n_out in 0usize..5000,
            n_fault in 0usize..5000,
            bw in 1u16..=MAX_FOOTPRINT_DIM,
            bh in 1u16..=MAX_FOOTPRINT_DIM,
        ) {
            let mut ports = Vec::new();
            ports.extend(std::iter::repeat_n(mech(Role::In), n_in));
            ports.extend(std::iter::repeat_n(mech(Role::Out), n_out));
            ports.extend(std::iter::repeat_n(mech(Role::Fault), n_fault));
            let base = Footprint { w: bw, h: bh, rot: 0 };
            let fp = grow_to_fit(base, &ports);
            prop_assert!(fp.w >= 1 && fp.w <= MAX_FOOTPRINT_DIM);
            prop_assert!(fp.h >= 1 && fp.h <= MAX_FOOTPRINT_DIM);
            // FLOOR: never below the base (until the cap forces saturation, which for a
            // base already ≤ cap only ever holds ≥ base).
            prop_assert!(fp.w >= base.w);
            prop_assert!(fp.h >= base.h);
        }

        /// Determinism: the same input always yields the same output (pure fn).
        #[test]
        fn prop_grow_to_fit_is_deterministic(
            n_in in 0usize..300, n_out in 0usize..300, n_fault in 0usize..300,
        ) {
            let mut ports = Vec::new();
            ports.extend(std::iter::repeat_n(mech(Role::In), n_in));
            ports.extend(std::iter::repeat_n(mech(Role::Out), n_out));
            ports.extend(std::iter::repeat_n(mech(Role::Fault), n_fault));
            prop_assert_eq!(grow_to_fit(ROUTER_BASE, &ports), grow_to_fit(ROUTER_BASE, &ports));
        }

        /// Every re-seated port lands INSIDE the grow_to_fit box for a valid (sub-cap)
        /// arity, on every catalog base - the invariant the snapshot trust gate
        /// (PortOutOfFootprint) relies on.
        #[test]
        fn prop_reseat_ports_are_in_box_for_valid_arity(
            n_in in 0usize..=60, n_out in 0usize..=60, n_fault in 0usize..=60,
            b in 0usize..BASES.len(),
        ) {
            let base = BASES[b];
            let mut ports = Vec::new();
            ports.extend(std::iter::repeat_n(mech(Role::In), n_in));
            ports.extend(std::iter::repeat_n(mech(Role::Out), n_out));
            ports.extend(std::iter::repeat_n(mech(Role::Fault), n_fault));
            let fp = grow_to_fit(base, &ports);
            for p in reseat_ports(base, fp.w, fp.h, &ports) {
                prop_assert!(p.local_offset.0 >= 0 && p.local_offset.0 < i32::from(fp.w));
                prop_assert!(p.local_offset.1 >= 0 && p.local_offset.1 < i32::from(fp.h));
            }
        }

        /// No two ports of one role share a cell, on any catalog base, for a valid
        /// arity: the centre-out fill is a permutation of the side, then the grown rows.
        #[test]
        fn prop_reseat_ports_give_each_role_distinct_cells(
            n_in in 0usize..=60, n_out in 0usize..=60, n_fault in 0usize..=60,
            b in 0usize..BASES.len(),
        ) {
            let base = BASES[b];
            let mut ports = Vec::new();
            ports.extend(std::iter::repeat_n(mech(Role::In), n_in));
            ports.extend(std::iter::repeat_n(mech(Role::Out), n_out));
            ports.extend(std::iter::repeat_n(mech(Role::Fault), n_fault));
            let fp = grow_to_fit(base, &ports);
            let seated = reseat_ports(base, fp.w, fp.h, &ports);
            for role in [Role::In, Role::Out, Role::Fault] {
                let cells: Vec<_> = seated.iter().filter(|p| p.role == role).map(|p| p.local_offset).collect();
                let mut uniq = cells.clone();
                uniq.sort_unstable();
                uniq.dedup();
                prop_assert_eq!(uniq.len(), cells.len(), "two {:?} ports share a cell", role);
            }
        }

        /// Prefix stability, through `reseat_ports` and `grow_to_fit`: on one catalog
        /// base, the first n - 1 ports of a role seated with n are on the slots the
        /// same n - 1 ports take alone. The slot is read along the side (y for an In
        /// or Out, x for a Fault); the column or row itself may move when the box
        /// grows, which the fold's facing check judges separately. A rule that read
        /// the role COUNT (a centred symmetric spread) fails this.
        #[test]
        fn prop_reseat_ports_are_prefix_stable(
            n in 1usize..=60,
            b in 0usize..BASES.len(),
            r in 0usize..3,
        ) {
            let base = BASES[b];
            let role = [Role::In, Role::Out, Role::Fault][r];
            let slot = |p: &Port| if role == Role::Fault { p.local_offset.0 } else { p.local_offset.1 };
            let seat = |count: usize| -> Vec<i32> {
                let ports = vec![mech(role); count];
                let fp = grow_to_fit(base, &ports);
                reseat_ports(base, fp.w, fp.h, &ports).iter().map(slot).collect()
            };
            let longer = seat(n);
            let shorter = seat(n - 1);
            prop_assert_eq!(&longer[..shorter.len()], &shorter[..]);
        }
    }
}
