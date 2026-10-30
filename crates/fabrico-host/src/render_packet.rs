//! The per-tick render-packet builder + the single [`RenderProducer`] that owns
//! the explicit `layout.update → build → encode → broadcast.send` pipeline (W2).
//!
//! # The one producer of the bytes both transports send
//! The deterministic core models machine *state* (idle/working/faulted) as a
//! presentation concern derived host-side, but on-screen *position* (cells) now lives
//! in core [`GridState`](fabrico_core::state::GridState) (folded from the edit-log,
//! captured in the snapshot — SPAT-01). This module joins the Core read-state
//! (`node_ids`/`node`/`links_iter`/`cell_of`, belt `in_flight`) with the per-tick
//! [`TickObservation`] (state derivation), then serializes the
//! **integer-only** [`RenderPacket`] with `postcard`. Those bytes are what BOTH the
//! dev WebSocket (07-06) and the Tauri `Channel` (07-08) send — identical regardless
//! of which transport carries them (the locked "one builder, identical bytes").
//!
//! # Active-set diff (idle ticks nearly free)
//! [`RenderPacketBuilder::build`] keeps the previously-emitted `(NodeView, BeltView)`
//! snapshot keyed by a dense host-assigned `u64` handle and emits ONLY the
//! nodes/belts that changed this tick (plus removed handles), with `full:false`.
//! A steady grid emits an empty diff — mirroring the engine's active-set scheduler.
//! [`RenderPacketBuilder::build_keyframe`] emits everything (`full:true`) for a
//! freshly-subscribed transport.
//!
//! # Integer-only wire (Pitfall 4, T-07-WIRE-FLOAT)
//! No `f32`/`f64`/`fixed` ever crosses the wire: item motion ships
//! `arrival_tick:u64` + `latency:u32`, `fill` is a `u16`, cells are `i32`. The
//! renderer derives float positions canvas-side.
//!
//! # Dense handle, not `as_ffi` (Assumption A3)
//! Handles are host-assigned monotonically from `0`, NOT `NodeId::data().as_ffi()`
//! (which packs a generation counter in the high bits, can exceed `2^53`, and would
//! force `BigInt` in TS). The builder owns the dense `NodeId → u64` table.
//!
//! # The builder moved
//! [`RenderPacketBuilder`] and its pure helpers live in `fabrico_engine::render_packet`, so a
//! board with no host can emit real packets. This file re-exports them under the old paths and
//! keeps [`RenderProducer`], [`RenderRelay`] and their fan-out, which are the part that needs
//! tokio.

use std::collections::{BTreeMap, VecDeque};

use fabrico_core::core::Core;
use fabrico_core::ids::NodeId;
use fabrico_protocol::RenderPacket;
use tokio::sync::{broadcast, watch};

use crate::driver::Host;

pub use fabrico_engine::render_packet::*;

/// The diff broadcast channel depth. Bounded (a slow subscriber lags rather than
/// growing memory unboundedly); the watch-held keyframe lets a lagged subscriber
/// resync from the latest full frame.
const DIFF_CHANNEL_CAPACITY: usize = 256;

impl RenderSource for Host {
    fn core(&self) -> &Core {
        Host::core(self)
    }

    fn can_undo(&self) -> bool {
        Host::can_undo(self)
    }

    fn can_redo(&self) -> bool {
        Host::can_redo(self)
    }
}

/// Re-tag encoded keyframe bytes as a LAG RESYNC (73-12, 73-REVIEW WR-01), returning the
/// re-encoded frame.
///
/// # Private, and reached only through [`RenderRelay::lagged`]
/// Until the 76-19 refuter round both transports called this directly on every lag, and
/// that was wrong whenever the dropped frames held a [`RenderProducer::reset`]: the resent
/// keyframe is then a restructure the client never saw, not "the same timeline, frames
/// missed". Whether to tag is decided in [`RenderRelay::lagged`], the one place both
/// transports go through, so a transport cannot tag a frame without that decision.
///
/// # It decodes and re-encodes, on the arm where that is free
/// The watch holds ENCODED bytes so the common path costs one clone and no work at all.
/// This runs ONLY when a connection has already fallen past the bounded diff broadcast
/// (`DIFF_CHANNEL_CAPACITY`, 256 frames), which is rare by construction and already the slow
/// path. Patching the trailing byte in place was
/// rejected: postcard is positional and not self-describing, so a "the flag is the last
/// byte" assumption is exactly the kind that survives a later append and then silently
/// corrupts a `wires` length prefix.
///
/// # A frame it cannot decode is passed through UNCHANGED, never dropped
/// The alternative to a resync frame is no frame, and a client that lagged and then got
/// nothing holds a stale scene forever. An undecodable keyframe is a host bug that this
/// function must not turn into a blank canvas, so the original bytes go out and the client
/// reads them exactly as it did before this field existed.
#[must_use]
fn tag_keyframe_as_resync(bytes: Vec<u8>) -> Vec<u8> {
    let Ok(mut pkt) = postcard::from_bytes::<RenderPacket>(&bytes) else {
        return bytes;
    };
    pkt.resync = true;
    postcard::to_allocvec(&pkt).unwrap_or(bytes)
}

/// One frame on a [`RenderProducer`] channel: the encoded [`RenderPacket`] and the
/// handle-table GENERATION that numbered it (plan 76-19 refuter round).
///
/// # Why the generation rides beside the bytes
/// Every [`RenderProducer::reset`] (an undo, a redo, a Load, a New, a scene swap)
/// installs a fresh builder, so every render handle is minted again from 0. A client
/// that lags past the bounded diff broadcast is resent the latest keyframe, and whether
/// that keyframe is "the same timeline, you missed frames" (`resync: true`) or "the
/// timeline was restructured" (`resync: false`) depends on ONE fact: did a reset happen
/// among the frames it missed. The generation says so. Since phase 88 (D-02) it ALSO
/// crosses the wire, as [`RenderPacket::generation`], stamped by the producer before the
/// bytes are encoded, so the two are always equal; the relay keeps reading it here because
/// a lag decision should not have to decode the frame it is deciding about.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RenderFrame {
    /// How many [`RenderProducer::reset`] calls preceded the build of this frame.
    pub generation: u64,
    /// The packet's own [`RenderPacket::tick`], so a relay can order frames without decoding
    /// them (phase 90, D-09). Host-only, like the struct: never serialized, the wire bytes
    /// are `bytes` alone.
    pub tick: u64,
    /// The postcard-encoded [`RenderPacket`], the bytes a transport sends.
    pub bytes: Vec<u8>,
}

/// One connection's relay of the render stream, shared by BOTH transports
/// (`fabrico_host::transport_ws` and `fabrico_app`) so the lag decision cannot drift.
/// It remembers the generation of the last frame the client was sent.
///
/// # The lag decision (plan 76-19 refuter round)
/// [`lagged`](Self::lagged) tags the resent keyframe `resync: true` ONLY when the client
/// is still on the keyframe's generation. When a reset fell among the dropped frames the
/// keyframe goes out untagged, as the restructure it is for this client, exactly as the
/// reset's own keyframe would have arrived had the client kept up. Before this, every lag
/// was tagged, and the frontend held a pending port-edit latch across a resync that
/// spanned an undo of that very edit, or that handed its handle to another machine with
/// the same origin cell and kind: the panel disabled Add output and Remove for an edit
/// that would never fold.
///
/// # The lag floor (phase 90, FAIL-05, D-09)
/// After a lag the broadcast resumes this receiver at the oldest frame it still buffers,
/// and every one of those frames is at or below the keyframe [`lagged`](Self::lagged) just
/// sent: forwarding them walked the client's tick back by up to 256 frames, and after an
/// Undo in the gap laid the old handle table's diffs over the new board. So `lagged`
/// records the keyframe's `(generation, tick)` as a floor and [`forward`](Self::forward)
/// returns `None` for any frame at or below it, generation compared first and then tick
/// (a reset re-seeds the tick inside a higher generation). The filter is race-safe against
/// the producer's order: [`RenderProducer::on_tick`] sends a diff BEFORE it updates the
/// keyframe watch, so the one diff a lag read can land between is newer than the keyframe
/// read and is forwarded, never lost (a resubscribe there would lose it). The floor stays
/// until the next lag: once a newer frame is forwarded, every later one is newer still.
#[derive(Debug)]
pub struct RenderRelay {
    /// The generation of the last frame this connection was sent.
    generation: u64,
    /// The `(generation, tick)` of the last keyframe this connection was sent, the opening one
    /// or the one the last lag resent; `None` when that keyframe was empty.
    floor: Option<(u64, u64)>,
}

impl RenderRelay {
    /// Open a connection on the latest keyframe. Returns the relay and the bytes to send
    /// first (empty before the first tick: the caller skips an empty frame).
    ///
    /// The opening keyframe is a floor, as a lag keyframe is (phase 90 review IN-A-01): both
    /// transports resubscribe to the diff broadcast BEFORE they read the keyframe watch, and
    /// the producer sends a tick's diff before it updates the watch, so a connection opened
    /// between the two holds the keyframe for tick T and then reads the diff for tick T, which
    /// that keyframe already contains. An empty keyframe (before the first tick) sets no floor.
    #[must_use]
    pub fn open(keyframe: &RenderFrame) -> (Self, Vec<u8>) {
        (
            Self {
                generation: keyframe.generation,
                floor: (!keyframe.bytes.is_empty()).then_some((keyframe.generation, keyframe.tick)),
            },
            keyframe.bytes.clone(),
        )
    }

    /// Forward one diff-broadcast frame unchanged, remembering its generation (a reset's
    /// own keyframe rides the broadcast too, so this is how the client moves to the next
    /// generation when it keeps up). `None` for a frame at or below the lag floor, which the
    /// client must not be sent (see the type's doc); a transport skips it.
    #[must_use]
    pub fn forward(&mut self, frame: RenderFrame) -> Option<Vec<u8>> {
        if self.floor.is_some_and(|floor| (frame.generation, frame.tick) <= floor) {
            return None;
        }
        self.generation = frame.generation;
        Some(frame.bytes)
    }

    /// The connection lagged past the bounded diff broadcast: the bytes to send are the
    /// latest keyframe, tagged as a lag resync only when no reset happened since the last
    /// frame the client was sent, and that keyframe becomes the floor below which
    /// [`forward`](Self::forward) sends nothing. An empty keyframe (before the first tick) is
    /// never sent, so it sets no floor. See the type's doc.
    #[must_use]
    pub fn lagged(&mut self, keyframe: &RenderFrame) -> Vec<u8> {
        let same_timeline = keyframe.generation == self.generation;
        self.generation = keyframe.generation;
        if !keyframe.bytes.is_empty() {
            self.floor = Some((keyframe.generation, keyframe.tick));
        }
        if same_timeline {
            tag_keyframe_as_resync(keyframe.bytes.clone())
        } else {
            keyframe.bytes.clone()
        }
    }
}

/// How many handle tables before the current one a [`RenderProducer`] keeps (phase 88,
/// D-02). A chosen default (D-02 left the size to the plan): a paused board holds every
/// Undo or Redo after the first (App's `undoHeld`), a playing board falls at most two or
/// three resets behind in one round trip, and a connection that fell further behind than
/// this is better refused with a sentence than resolved from a deeper history. Each kept
/// table is a `handle -> NodeId` map only.
pub const KEPT_GENERATIONS: usize = 8;

/// What a gesture's `(generation, handle)` names, read by [`RenderProducer::resolve_at`]
/// (phase 88, D-02, D-03, D-05). The pair is compared, never the handle alone: handle 3 of
/// one table and handle 3 of the next are different names.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Resolved {
    /// The node the named table gave this handle. It may since have been removed (an Undo
    /// can take it back); a dead id then fails `validate_normalize` as `UnknownNode`, so an
    /// old handle reaches only nodes the board still has.
    Node(NodeId),
    /// The named table never minted this handle.
    Gone,
    /// The generation is on this board but older than the [`KEPT_GENERATIONS`] tables kept:
    /// the host cannot say which node the user picked, so the edit is refused
    /// `BoardChanged` (D-03).
    TooOld,
    /// The generation is from before a board swap (Load, LoadDemo, LoadScene, New): the edit
    /// was made on a board that no longer exists and is answered discarded (D-05).
    Discard,
    /// The generation is above the board's current one, which no client was ever sent: a
    /// forged header, refused as the cannot-read tag `Malformed`.
    Ahead,
}

/// The single per-tick render producer (W2): it OWNS the explicit
/// `build → encode → broadcast.send` pipeline and the fan-out channels both
/// transports subscribe to. Cells are sourced from core `GridState` (SPAT-01), so
/// the producer no longer maintains a host-side layout projection.
///
/// The per-tick OWNER that drives [`on_tick`](Self::on_tick) is the 07-08 sim loop;
/// 07-06's `transport_ws` and 07-08's `subscribe_render` are pure SUBSCRIBERS that
/// call [`subscribe`](Self::subscribe) and forward the identical postcard bytes.
pub struct RenderProducer {
    /// The packet builder (handle table + diff baseline).
    builder: RenderPacketBuilder,
    /// Per-tick diff bytes — the live broadcast every subscriber reads.
    diff_tx: broadcast::Sender<RenderFrame>,
    /// The latest full keyframe bytes — a new subscriber's resync point.
    keyframe_tx: watch::Sender<RenderFrame>,
    /// How many [`reset`](Self::reset) calls this producer has run: the generation every
    /// frame it sends carries ([`RenderFrame`], plan 76-19 refuter round).
    generation: u64,
    /// The `handle -> NodeId` tables of the last [`KEPT_GENERATIONS`] generations before the
    /// current one, oldest first, each under the generation it was current at (phase 88,
    /// D-02). Same-board only: a swap clears it ([`reset_for_swap`](Self::reset_for_swap)).
    kept: VecDeque<(u64, BTreeMap<u64, NodeId>)>,
    /// The generation the last board swap installed (phase 88, D-05). A gesture stamped
    /// below it was made on a board that no longer exists. NodeIds are per board, so a
    /// pre-swap id can equal a live id of the new board; nothing below the floor is ever
    /// resolved.
    swap_floor: u64,
}

impl RenderProducer {
    /// A fresh producer with both fan-out channels (an empty initial keyframe).
    #[must_use]
    pub fn new() -> Self {
        let (diff_tx, _diff_rx) = broadcast::channel(DIFF_CHANNEL_CAPACITY);
        let (keyframe_tx, _keyframe_rx) = watch::channel(RenderFrame::default());
        Self {
            builder: RenderPacketBuilder::new(),
            diff_tx,
            keyframe_tx,
            generation: 0,
            kept: VecDeque::new(),
            swap_floor: 0,
        }
    }

    /// The EXPLICIT per-tick call site (W2): build the diff packet, encode it,
    /// broadcast it, then refresh the latest-keyframe watch. Called once per tick by
    /// the sim-loop owner. Cells ride in core `GridState` (the 09-02 fold writes each
    /// `Place`'s cell), so the producer no longer drains a pending-cell buffer or
    /// updates a host-side layout — it just reads `core.state.cell_of` (SPAT-01).
    ///
    /// # Errors
    /// Returns the `postcard` encode error if either the diff or keyframe packet
    /// fails to serialize (never expected for the integer-only DTOs).
    pub fn on_tick(&mut self, host: &Host) -> Result<(), postcard::Error> {
        // 1. Build + encode + broadcast the active-set diff.
        let built = self.builder.build(host);
        let pkt = self.stamp(built);
        let bytes = postcard::to_allocvec(&pkt)?;
        // A send error only means "no subscribers yet" — not fatal; the keyframe
        // watch still holds the latest full frame for a future subscriber.
        let _ = self.diff_tx.send(RenderFrame {
            generation: self.generation,
            tick: pkt.tick,
            bytes,
        });

        // 2. Refresh the latest-keyframe watch (a new subscriber resyncs from this).
        let built = self.builder.build_keyframe(host);
        let keyframe = self.stamp(built);
        let keyframe_bytes = postcard::to_allocvec(&keyframe)?;
        let _ = self.keyframe_tx.send(RenderFrame {
            generation: self.generation,
            tick: keyframe.tick,
            bytes: keyframe_bytes,
        });

        Ok(())
    }

    /// RESET the producer for a host SWAP (Load, HOST-05) — the never-dark
    /// re-sync. Replaces the builder ONLY (dropping the stale `NodeId->u64`
    /// handle table + diff baseline) and KEEPS both fan-out channels, then pushes
    /// a `full:true` keyframe of the NEW scene over BOTH the diff broadcast AND
    /// the keyframe watch.
    ///
    /// The `diff_tx.send` is the LOAD-BEARING line: an already-connected
    /// subscriber sits in `diff_rx.recv()` and only re-reads the keyframe watch on
    /// connect / `Lagged`, so a watch-only reset would leave live webviews
    /// rendering the OLD scene. Riding the diff broadcast makes the frontend
    /// decoder clear its buffer on `full:true` (`sceneState.ts`) and repopulate
    /// inline — the subscriber keeps its channel (never a `Closed` stream, which
    /// a rebuild would cause). Handle reuse from 0 is safe because the `full:true`
    /// packet clears the decoder buffer entirely before repopulating (Pitfall 3).
    ///
    /// A send error means "no subscribers yet" and is non-fatal (`let _ =`),
    /// matching [`on_tick`](Self::on_tick)'s convention.
    ///
    /// # Errors
    /// Returns the `postcard` encode error if the keyframe fails to serialize
    /// (never expected for the integer-only DTOs).
    pub fn reset(&mut self, host: &Host) -> Result<(), postcard::Error> {
        self.reset_as(host, false)
    }

    /// [`reset`](Self::reset), and for a board swap also the swap's own bookkeeping, done
    /// BEFORE the keyframe is stamped so that keyframe already names the new floor
    /// (phase 88 security, T-88-11).
    fn reset_as(&mut self, host: &Host, swap: bool) -> Result<(), postcard::Error> {
        // Drop the stale handle table + diff baseline. A new handle table is a new
        // generation: a connection that lags across this reset is resent the keyframe as
        // a restructure, never as a resync (`RenderRelay::lagged`, plan 76-19 refuter).
        //
        // Phase 88 (D-02): the outgoing table is KEPT under the outgoing generation, so a
        // gesture made from it (an edit queued behind an Undo) resolves to the node the user
        // picked. The oldest past `KEPT_GENERATIONS` is dropped.
        let outgoing = std::mem::take(&mut self.builder);
        self.kept.push_back((self.generation, outgoing.into_handle_table()));
        while self.kept.len() > KEPT_GENERATIONS {
            self.kept.pop_front();
        }
        self.generation += 1;
        if swap {
            // A swap's history is cleared and its floor set here, before anything can fail,
            // so no pre-swap table survives an encode error; and before the keyframe below is
            // stamped, so the swap's own keyframe tells every client the board was replaced.
            self.kept.clear();
            self.swap_floor = self.generation;
        }
        // PRIME prev_nodes/prev_belts to the NEW scene (the `build` side effect)
        // so the NEXT on_tick diff is empty — no spurious re-emit of the scene we
        // are about to keyframe.
        let _prime = self.builder.build(host);
        // The full keyframe of the new scene. `build_keyframe` does not touch the
        // diff baseline, so the prime above must run first. Stamped AFTER the increment
        // above, so it names the NEW table's generation (phase 88, D-02).
        let built = self.builder.build_keyframe(host);
        let keyframe = self.stamp(built);
        let frame = RenderFrame {
            generation: self.generation,
            tick: keyframe.tick,
            bytes: postcard::to_allocvec(&keyframe)?,
        };
        // LIVE subscribers: clear + repopulate inline (the load-bearing send).
        let _ = self.diff_tx.send(frame.clone());
        // FUTURE subscribers: the new resync baseline.
        let _ = self.keyframe_tx.send(frame);
        Ok(())
    }

    /// RESET the producer for a BOARD SWAP (Load, LoadDemo, LoadScene, New; phase 88, D-05):
    /// what [`reset`](Self::reset) does, then the kept tables are cleared and the swap floor
    /// set to the new generation. A swap starts a new NodeId allocator, so a table of the
    /// replaced board could name a live node of the new one (Pitfall 1); after this, every
    /// gesture stamped before the swap reads [`Resolved::Discard`].
    ///
    /// The history is cleared and the floor set even when the keyframe fails to encode, so
    /// no pre-swap table survives an error. Both happen before the swap's keyframe is
    /// stamped, so that keyframe carries the new floor in [`RenderPacket::swap_floor`]
    /// (phase 88 security, T-88-11): a client learns of the swap from the packet, whichever
    /// page asked for it.
    ///
    /// # Errors
    /// The `postcard` encode error [`reset`](Self::reset) returns.
    pub fn reset_for_swap(&mut self, host: &Host) -> Result<(), postcard::Error> {
        self.reset_as(host, true)
    }

    /// What generation `generation` lets a gesture read (phase 88, D-02, D-03, D-05), before
    /// any handle is looked at: `Ok` when its table is the current one or a kept one, else
    /// the one answer that applies, which is only ever [`Resolved::Discard`] (below the
    /// swap floor), [`Resolved::Ahead`] (above the current generation) or
    /// [`Resolved::TooOld`] (on this board but past the kept history).
    ///
    /// # Errors
    /// The [`Resolved`] answer for a generation whose table the producer does not hold.
    pub fn check_generation(&self, generation: u64) -> Result<(), Resolved> {
        self.table_at(generation).map(|_| ())
    }

    /// The node handle `handle` named in the table of generation `generation`: the table
    /// the client read the handle from (phase 88, D-02). The current generation reads the
    /// live builder, a kept generation its kept table; see [`Resolved`] for the rest.
    #[must_use]
    pub fn resolve_at(&self, generation: u64, handle: u64) -> Resolved {
        match self.table_at(generation) {
            Ok(table) => table.get(&handle).map_or(Resolved::Gone, |&id| Resolved::Node(id)),
            Err(answer) => answer,
        }
    }

    /// The `handle -> NodeId` table of `generation`, or why there is none.
    fn table_at(&self, generation: u64) -> Result<&BTreeMap<u64, NodeId>, Resolved> {
        if generation < self.swap_floor {
            return Err(Resolved::Discard);
        }
        if generation > self.generation {
            return Err(Resolved::Ahead);
        }
        if generation == self.generation {
            return Ok(self.builder.handle_table());
        }
        self.kept
            .iter()
            .find(|(g, _)| *g == generation)
            .map(|(_, table)| table)
            .ok_or(Resolved::TooOld)
    }

    /// Subscribe a transport: returns `(latest-keyframe watch receiver, live-diff
    /// broadcast receiver)`. The transport sends the watched keyframe first, then
    /// forwards each diff frame. Both carry the IDENTICAL postcard bytes the other
    /// transport sends.
    #[must_use]
    pub fn subscribe(&self) -> (watch::Receiver<RenderFrame>, broadcast::Receiver<RenderFrame>) {
        (self.keyframe_tx.subscribe(), self.diff_tx.subscribe())
    }

    /// The live [`NodeId`] a dense render handle maps to (the gesture-resolver source
    /// `input_apply` uses, 07-06). Delegates to the builder's inverse handle table;
    /// the per-tick owner (07-08) builds `|h| producer.node_for_handle(h)` and hands
    /// it to `apply_gesture`.
    pub fn node_for_handle(&self, handle: u64) -> Option<NodeId> {
        self.builder.node_for_handle(handle)
    }

    /// The dense render handle currently assigned to `id` (the inverse of
    /// [`node_for_handle`](Self::node_for_handle)). Delegates to the builder's handle
    /// table; `None` for a node not yet emitted. Read-only, never mints.
    #[must_use]
    pub fn handle_for_node(&self, id: NodeId) -> Option<u64> {
        self.builder.handle_for_node(id)
    }

    /// The board generation of the CURRENT handle table: how many [`reset`](Self::reset)
    /// calls this producer has run (phase 88, D-02). Every packet it encodes carries this
    /// number in [`RenderPacket::generation`], and every frame carries it beside the bytes
    /// in [`RenderFrame::generation`].
    #[must_use]
    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// Put this producer's generation and swap floor on a packet the builder built (phase
    /// 88, D-02, D-05; the floor since the security audit, T-88-11). The builder owns the
    /// handle table but not the count of tables; the producer owns the count, so it stamps
    /// every packet in ONE place before it encodes it, and the wire field and the
    /// `RenderFrame` beside it cannot disagree.
    fn stamp(&self, mut pkt: RenderPacket) -> RenderPacket {
        pkt.generation = self.generation;
        pkt.swap_floor = self.swap_floor;
        pkt
    }
}

impl Default for RenderProducer {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use fabrico_core::core::Core;
    use fabrico_core::event::{LogHeader, SCHEMA_VERSION};
    use fabrico_core::persist::RedbStore;

    use crate::ledger::DispatchLedger;

    fn test_host() -> (tempfile::TempDir, Host) {
        let dir = tempfile::tempdir().expect("tempdir");
        let core = Core::genesis(LogHeader {
            schema_version: SCHEMA_VERSION,
            seed: 7,
        });
        let store = RedbStore::open(dir.path().join("log.redb")).expect("open log");
        let ledger = DispatchLedger::open(dir.path().join("ledger.redb")).expect("open ledger");
        let host = Host::new(core, store, ledger, None).expect("open host");
        (dir, host)
    }

    #[test]
    fn producer_emits_packet_per_tick() {
        // After one on_tick, a subscriber's broadcast receiver yields exactly one
        // diff frame and the keyframe watch holds a non-empty full frame.
        let (_dir, mut host) = test_host();
        host.core_mut().state.add_source(); // one node so the diff is non-empty
        let mut producer = RenderProducer::new();
        let (keyframe_rx, mut diff_rx) = producer.subscribe();

        producer.on_tick(&host).expect("on_tick encodes + sends");

        let frame = diff_rx.try_recv().expect("exactly one diff frame");
        assert!(!frame.bytes.is_empty(), "the diff frame carries bytes");
        assert!(
            diff_rx.try_recv().is_err(),
            "exactly one frame per on_tick (no second frame)"
        );
        assert!(
            !keyframe_rx.borrow().bytes.is_empty(),
            "the keyframe watch holds a non-empty full frame"
        );
    }

    #[test]
    fn reset_pushes_full_over_diff_broadcast_subscribers_stay_live() {
        // HOST-05: an already-connected diff subscriber receives a `full:true`
        // packet after reset (its stream is NOT Closed), so a live webview clears
        // + repopulates inline across a Load host-swap instead of going dark.
        let (_dir, mut host) = test_host();
        host.core_mut().state.add_source();
        let mut producer = RenderProducer::new();
        // Subscribe BEFORE the reset (an already-connected webview).
        let (_keyframe_rx, mut diff_rx) = producer.subscribe();

        producer.reset(&host).expect("reset encodes + sends");

        // The pre-existing subscriber receives the reset packet over the DIFF
        // broadcast (not a RecvError::Closed) and it is a full:true keyframe.
        let bytes = diff_rx
            .try_recv()
            .expect("the reset rides the diff broadcast (subscriber stays live)")
            .bytes;
        let pkt: RenderPacket = postcard::from_bytes(&bytes).expect("decode reset packet");
        assert!(pkt.full, "the reset packet is a full:true keyframe");
        assert_eq!(
            pkt.placed.len(),
            1,
            "the reset keyframe carries the new scene's node"
        );
    }

    #[test]
    fn on_tick_after_reset_emits_empty_diff_no_re_emit() {
        // After a reset primes the diff baseline to the new scene, the NEXT
        // on_tick produces an EMPTY diff (no spurious re-emit of the just-
        // keyframed scene) — proving `reset` primed prev_nodes/prev_belts.
        let (_dir, mut host) = test_host();
        host.core_mut().state.add_source();
        let mut producer = RenderProducer::new();
        let (_keyframe_rx, mut diff_rx) = producer.subscribe();

        producer.reset(&host).expect("reset");
        // Drain the reset's full packet.
        let _full = diff_rx.try_recv().expect("reset packet present");

        // A no-change tick after the reset emits an empty diff.
        producer.on_tick(&host).expect("on_tick after reset");
        let bytes = diff_rx.try_recv().expect("exactly one diff frame").bytes;
        let pkt: RenderPacket = postcard::from_bytes(&bytes).expect("decode diff");
        assert!(!pkt.full, "a diff, not a keyframe");
        assert!(
            pkt.placed.is_empty() && pkt.belts.is_empty() && pkt.removed.is_empty(),
            "the tick after a reset re-emits nothing (baseline was primed)"
        );
    }

    // ── 73-12 (73-REVIEW WR-01): the resync tag ──────────────────────────────────

    /// A minimal packet whose only interesting field is the one under test.
    fn bare_keyframe() -> RenderPacket {
        RenderPacket {
            tick: 7,
            full: true,
            placed: Vec::new(),
            removed: Vec::new(),
            belts: Vec::new(),
            can_undo: true,
            can_redo: false,
            wires: Vec::new(),
            resync: false,
            generation: 4,
            swap_floor: 2,
        }
    }

    /// THE WR-01 HEADLINE. A producer keyframe says "the timeline was restructured";
    /// the same bytes resent on a lag must say "you merely missed frames".
    #[test]
    fn the_resync_tag_flips_exactly_one_bit_and_nothing_else() {
        let pkt = bare_keyframe();
        assert!(!pkt.resync, "a producer keyframe is never a resync");
        let bytes = postcard::to_allocvec(&pkt).expect("encode");

        let tagged = tag_keyframe_as_resync(bytes.clone());
        assert_ne!(tagged, bytes, "the tag really changed the frame");

        let back: RenderPacket = postcard::from_bytes(&tagged).expect("decode the tagged frame");
        assert!(back.resync, "and the client can read it");
        // Every OTHER field is byte-identical, asserted by re-clearing the one bit and
        // comparing whole packets rather than field by field - a field-by-field check
        // is satisfied by a tagger that dropped a field this test forgot to name.
        let mut cleared = back;
        cleared.resync = false;
        assert_eq!(cleared, pkt, "the tag touched nothing but its own bit");
    }

    /// The tagger must never turn a frame it cannot read into NO frame: a client that
    /// lagged and then got nothing holds a stale scene forever.
    #[test]
    fn an_undecodable_frame_is_passed_through_unchanged_rather_than_dropped() {
        let junk = vec![0xFFu8; 12];
        assert_eq!(
            tag_keyframe_as_resync(junk.clone()),
            junk,
            "an undecodable keyframe goes out as-is; the client reads it exactly as it did \
             before this field existed"
        );
    }

    /// The NEGATIVE CONTROL, declared as one: the producer sets the bit on NEITHER of
    /// the two packets it builds. Without this row `tag_keyframe_as_resync` could be a
    /// no-op wrapper around a producer that already set the flag, and the row above
    /// would still pass.
    #[test]
    fn neither_producer_packet_is_ever_tagged_a_resync() {
        assert!(!bare_keyframe().resync);
    }

    // ── Phase 88 (D-02, D-05): the board generation crosses the wire ──────────────

    /// THE GENERATION RIDES EVERY PACKET. A diff and a keyframe from `on_tick`, and the
    /// keyframe from `reset`, each decode to a `generation` equal to the
    /// `RenderFrame.generation` the producer sent beside the bytes, and `reset` raises it
    /// by exactly one. The lag tagger decodes and re-encodes, so the field survives it.
    ///
    /// Two `on_tick` rounds are read, one before and one after the reset, so a producer
    /// that stamped a constant (0, or the value it had at construction) is caught on the
    /// second round rather than passing on a fresh producer where every value is 0.
    #[test]
    fn every_frame_carries_the_producer_generation() {
        let (_dir, mut host) = test_host();
        host.core_mut().state.add_source();
        let mut producer = RenderProducer::new();
        let (mut keyframe_rx, mut diff_rx) = producer.subscribe();
        let read = |frame: &RenderFrame| -> RenderPacket {
            postcard::from_bytes(&frame.bytes).expect("decode a producer frame")
        };

        producer.on_tick(&host).expect("on_tick");
        let diff = diff_rx.try_recv().expect("a diff frame");
        let kf = keyframe_rx.borrow_and_update().clone();
        assert_eq!(producer.generation(), 0, "PRECONDITION: a fresh producer is at 0");
        assert_eq!((read(&diff).generation, diff.generation), (0, 0), "diff before any reset");
        assert_eq!((read(&kf).generation, kf.generation), (0, 0), "keyframe before any reset");

        producer.reset(&host).expect("reset");
        assert_eq!(producer.generation(), 1, "a reset raises the generation by exactly one");
        let reset_frame = diff_rx.try_recv().expect("the reset keyframe rides the diff broadcast");
        let reset_pkt = read(&reset_frame);
        assert!(reset_pkt.full, "PRECONDITION: the reset frame is a keyframe");
        assert_eq!(
            (reset_pkt.generation, reset_frame.generation),
            (1, 1),
            "the reset keyframe names the NEW table's generation"
        );

        producer.on_tick(&host).expect("on_tick after the reset");
        let diff = diff_rx.try_recv().expect("a diff frame");
        let kf = keyframe_rx.borrow_and_update().clone();
        assert_eq!((read(&diff).generation, diff.generation), (1, 1), "diff after the reset");
        assert_eq!((read(&kf).generation, kf.generation), (1, 1), "keyframe after the reset");

        let tagged: RenderPacket =
            postcard::from_bytes(&tag_keyframe_as_resync(kf.bytes.clone())).expect("decode tagged");
        assert!(tagged.resync, "PRECONDITION: the tagger set the bit");
        assert_eq!(tagged.generation, 1, "the lag tagger keeps the generation");
    }

    // ── Phase 88 (D-02, D-03, D-05): a gesture resolves against the table it was read from ──

    /// THE TABLE THE CLIENT SAW. Two Sources are minted at generation 0 as `a = 0`, `b = 1`;
    /// `a` is removed and `c` added, minted at 0 as handle 2. A reset to generation 1
    /// re-mints in node order, which puts `c` (in the slot `a` left) first: the new table
    /// gives `c` handle 0, so handle 0 now names a different node. `resolve_at(0, h)` still names what
    /// the generation-0 table gave `h` (handle 0 is `a`, dead, which `validate_normalize`
    /// refuses), and `resolve_at(1, h)` what the new table gives it.
    #[test]
    fn resolve_at_reads_the_table_the_client_saw() {
        let (_dir, mut host) = test_host();
        let a = host.core_mut().state.add_source();
        let b = host.core_mut().state.add_source();
        let mut producer = RenderProducer::new();
        producer.on_tick(&host).expect("on_tick mints a and b");
        assert_eq!(
            (producer.handle_for_node(a), producer.handle_for_node(b)),
            (Some(0), Some(1)),
            "PRECONDITION: generation 0 mints a = 0, b = 1"
        );
        host.core_mut().state.remove_node(a);
        let c = host.core_mut().state.add_source();
        producer.on_tick(&host).expect("on_tick mints c");
        assert_eq!(producer.handle_for_node(c), Some(2), "PRECONDITION: c is minted 2 at generation 0");

        producer.reset(&host).expect("reset to generation 1");
        assert_eq!(producer.generation(), 1, "PRECONDITION: one reset");
        let new_c = producer.handle_for_node(c).expect("c is drawn at generation 1");
        let new_b = producer.handle_for_node(b).expect("b is drawn at generation 1");
        assert!(
            new_c != 2 && producer.node_for_handle(0).is_some_and(|id| id != a),
            "PRECONDITION: the reset reorders the handles (c leaves 2, handle 0 names a live node \
             other than a), or this proves nothing: b={new_b} c={new_c}"
        );

        assert_eq!(producer.resolve_at(0, 0), Resolved::Node(a), "generation 0, handle 0: a, as the client saw it");
        assert_eq!(producer.resolve_at(0, 1), Resolved::Node(b), "generation 0, handle 1: b");
        assert_eq!(producer.resolve_at(0, 2), Resolved::Node(c), "generation 0, handle 2: c");
        assert_eq!(producer.resolve_at(1, new_b), Resolved::Node(b), "generation 1 reads the new table for b");
        assert_eq!(producer.resolve_at(1, new_c), Resolved::Node(c), "generation 1 reads the new table for c");
        assert_eq!(producer.resolve_at(1, 2), Resolved::Gone, "the new table never minted handle 2");
        assert_eq!(producer.resolve_at(0, 3), Resolved::Gone, "the old table never minted handle 3");
        assert_eq!(producer.node_for_handle(new_c), Some(c), "node_for_handle reads the current table");
    }

    /// THE BOUND (T-88-12). After `KEPT_GENERATIONS + 1` resets the current generation is
    /// `g`; generation `g - KEPT_GENERATIONS` still reads its table and `g - KEPT_GENERATIONS - 1`
    /// is `TooOld`, for `resolve_at` and `check_generation` alike.
    #[test]
    fn resolve_at_keeps_eight_generations_and_no_more() {
        assert_eq!(KEPT_GENERATIONS, 8, "the kept history is eight tables");
        let (_dir, mut host) = test_host();
        let s = host.core_mut().state.add_source();
        let mut producer = RenderProducer::new();
        producer.on_tick(&host).expect("on_tick mints the Source");
        for _ in 0..=KEPT_GENERATIONS {
            producer.reset(&host).expect("reset");
        }
        let g = producer.generation();
        assert_eq!(g, KEPT_GENERATIONS as u64 + 1, "PRECONDITION: nine resets");
        let oldest = g - KEPT_GENERATIONS as u64;
        for kept in oldest..g {
            assert_eq!(producer.resolve_at(kept, 0), Resolved::Node(s), "generation {kept} is kept");
            assert_eq!(producer.check_generation(kept), Ok(()), "generation {kept} is readable");
        }
        assert_eq!(producer.resolve_at(g, 0), Resolved::Node(s), "the current generation reads the live table");
        assert_eq!(producer.resolve_at(oldest - 1, 0), Resolved::TooOld, "generation {} is past the kept history", oldest - 1);
        assert_eq!(producer.check_generation(oldest - 1), Err(Resolved::TooOld));
        assert_eq!(producer.resolve_at(0, 0), Resolved::TooOld, "generation 0 is long gone");
    }

    /// THE FLOOR AND THE CEILING (D-05, T-88-11, T-88-13). A swap clears the kept tables and
    /// sets the floor at its own generation: every generation under it reads `Discard`, even
    /// one that a plain reset would have kept. A generation above the current one reads
    /// `Ahead`. A plain reset after the swap keeps the swap's table as usual.
    #[test]
    fn resolve_at_refuses_below_the_swap_floor_and_ahead_of_the_board() {
        let (_dir, mut host) = test_host();
        let s = host.core_mut().state.add_source();
        let mut producer = RenderProducer::new();
        producer.on_tick(&host).expect("on_tick mints the Source");
        producer.reset(&host).expect("reset to 1");
        assert_eq!(producer.resolve_at(0, 0), Resolved::Node(s), "PRECONDITION: a plain reset keeps generation 0");

        producer.reset_for_swap(&host).expect("swap to 2");
        assert_eq!(producer.generation(), 2, "PRECONDITION: the swap is a reset");
        assert_eq!(producer.resolve_at(0, 0), Resolved::Discard, "generation 0 is from the replaced board");
        assert_eq!(producer.resolve_at(1, 0), Resolved::Discard, "generation 1 is from the replaced board");
        assert_eq!(producer.check_generation(1), Err(Resolved::Discard));
        assert_eq!(producer.resolve_at(2, 0), Resolved::Node(s), "the swap's own generation reads the new board");
        assert_eq!(producer.resolve_at(3, 0), Resolved::Ahead, "no client was sent generation 3");
        assert_eq!(producer.check_generation(3), Err(Resolved::Ahead));
        assert_eq!(producer.resolve_at(u64::MAX, 0), Resolved::Ahead, "nor any above it");

        producer.reset(&host).expect("reset to 3");
        assert_eq!(producer.resolve_at(2, 0), Resolved::Node(s), "a reset after the swap keeps the swap's table");
        assert_eq!(producer.resolve_at(1, 0), Resolved::Discard, "the floor stays where the swap set it");
        assert_eq!(producer.resolve_at(4, 0), Resolved::Ahead);
    }

    /// THE SWAP FLOOR RIDES EVERY PACKET (phase 88 security, T-88-11). An undo's keyframe and
    /// a swap's keyframe both raise the generation, so only the floor tells a client which one
    /// it holds. The swap's OWN keyframe already names the new floor (it is set before the
    /// keyframe is stamped), every diff and keyframe after it carries it, and a plain reset
    /// leaves it where the swap put it. Before the field a client learned of a swap only when
    /// it had asked for one itself, so a Load from another client let it name a pre-swap belt
    /// again on the loaded board.
    #[test]
    fn every_frame_carries_the_swap_floor_from_the_swap_keyframe_on() {
        let (_dir, mut host) = test_host();
        host.core_mut().state.add_source();
        let mut producer = RenderProducer::new();
        let (mut keyframe_rx, mut diff_rx) = producer.subscribe();
        let read = |frame: &RenderFrame| -> RenderPacket {
            postcard::from_bytes(&frame.bytes).expect("decode a producer frame")
        };
        let floors = |pkt: &RenderPacket| (pkt.generation, pkt.swap_floor);

        producer.on_tick(&host).expect("on_tick");
        assert_eq!(floors(&read(&diff_rx.try_recv().expect("a diff"))), (0, 0), "before any swap");

        producer.reset(&host).expect("an undo's reset");
        let undo = read(&diff_rx.try_recv().expect("the reset keyframe"));
        assert!(undo.full, "PRECONDITION: a keyframe");
        assert_eq!(floors(&undo), (1, 0), "an undo's keyframe raises the generation and not the floor");

        producer.reset_for_swap(&host).expect("a swap");
        let swap = read(&diff_rx.try_recv().expect("the swap keyframe"));
        assert!(swap.full, "PRECONDITION: a keyframe");
        assert_eq!(floors(&swap), (2, 2), "the swap's own keyframe names the new floor");

        producer.on_tick(&host).expect("on_tick after the swap");
        assert_eq!(floors(&read(&diff_rx.try_recv().expect("a diff"))), (2, 2), "a diff after the swap");
        assert_eq!(floors(&read(&keyframe_rx.borrow_and_update().clone())), (2, 2), "the resync keyframe too");

        producer.reset(&host).expect("an undo after the swap");
        let after = read(&diff_rx.try_recv().expect("the reset keyframe"));
        assert_eq!(floors(&after), (3, 2), "a plain reset keeps the floor where the swap set it");
        let tagged: RenderPacket =
            postcard::from_bytes(&tag_keyframe_as_resync(keyframe_rx.borrow_and_update().bytes.clone()))
                .expect("decode tagged");
        assert_eq!(floors(&tagged), (3, 2), "the lag tagger keeps the floor");
    }

    /// A frame as the producer would send it, with stand-in bytes that name it.
    fn relay_frame(generation: u64, tick: u64) -> RenderFrame {
        RenderFrame {
            generation,
            tick,
            bytes: [generation.to_le_bytes(), tick.to_le_bytes()].concat(),
        }
    }

    #[test]
    fn relay_forwards_every_frame_without_a_lag() {
        let (mut relay, first) = RenderRelay::open(&relay_frame(0, 1));
        assert_eq!(first, relay_frame(0, 1).bytes);
        // In order, an equal tick (a paused diff), a reset's lower tick in a higher
        // generation, and an older frame: with no lag the relay is a pass-through.
        for (g, t) in [(0, 2), (0, 3), (0, 3), (1, 1), (1, 2), (0, 9)] {
            let frame = relay_frame(g, t);
            let bytes = frame.bytes.clone();
            assert_eq!(relay.forward(frame), Some(bytes), "frame ({g}, {t}) forwarded");
        }
    }

    /// Phase 90 review IN-A-01: both transports resubscribe to the diff broadcast BEFORE they
    /// read the keyframe watch, and the producer sends a tick's diff before it updates the
    /// watch, so a connection opened between the two is sent keyframe T and then diff T, which
    /// the keyframe already holds. `open` floors at its own keyframe, the rule `lagged` applies.
    #[test]
    fn relay_open_drops_the_diff_its_keyframe_already_holds() {
        let (mut relay, first) = RenderRelay::open(&relay_frame(0, 5));
        assert_eq!(first, relay_frame(0, 5).bytes, "the opening keyframe is sent");
        assert_eq!(
            relay.forward(relay_frame(0, 5)),
            None,
            "the diff for the opening keyframe's own tick is not sent again"
        );
        let next = relay_frame(0, 6);
        let bytes = next.bytes.clone();
        assert_eq!(relay.forward(next), Some(bytes), "the next tick is sent");
    }

    #[test]
    fn relay_drops_frames_at_or_below_the_lag_floor() {
        let (mut relay, _) = RenderRelay::open(&relay_frame(1, 40));
        let kf = relay.lagged(&relay_frame(1, 301));
        assert!(!kf.is_empty(), "the lag keyframe is sent");
        for (g, t) in [(0, 400), (1, 46), (1, 300), (1, 301)] {
            assert_eq!(
                relay.forward(relay_frame(g, t)),
                None,
                "frame ({g}, {t}) is at or below the lag floor (1, 301) and is dropped"
            );
        }
        let newer = relay_frame(1, 302);
        let bytes = newer.bytes.clone();
        assert_eq!(relay.forward(newer), Some(bytes), "frame (1, 302) is newer than the floor");
    }

    #[test]
    fn relay_passes_a_newer_generation_with_a_lower_tick() {
        let (mut relay, _) = RenderRelay::open(&relay_frame(1, 40));
        let _ = relay.lagged(&relay_frame(1, 301));
        // A reset after the lag keyframe (a New restarts the tick near 0): the generation is
        // compared first, so its lower tick does not drop it.
        let reset = relay_frame(2, 3);
        let bytes = reset.bytes.clone();
        assert_eq!(relay.forward(reset), Some(bytes), "frame (2, 3) passes a floor of (1, 301)");
        assert!(relay.forward(relay_frame(2, 4)).is_some(), "the new generation runs on");
    }

    #[test]
    fn relay_moves_its_floor_on_each_lag() {
        let (mut relay, _) = RenderRelay::open(&relay_frame(0, 1));
        let _ = relay.lagged(&relay_frame(0, 301));
        assert_eq!(relay.forward(relay_frame(0, 301)), None, "at the first floor");
        assert!(relay.forward(relay_frame(0, 302)).is_some(), "past the first floor");
        let _ = relay.lagged(&relay_frame(0, 700));
        assert_eq!(
            relay.forward(relay_frame(0, 500)),
            None,
            "a frame past the first floor but at or below the second is dropped"
        );
        assert!(relay.forward(relay_frame(0, 701)).is_some(), "past the second floor");
    }

    #[test]
    fn relay_takes_no_floor_from_an_empty_keyframe() {
        // Before the first tick the keyframe watch holds an empty default frame. A transport
        // sends nothing for it, so it must not become a floor that drops the first real frame.
        let (mut relay, first) = RenderRelay::open(&RenderFrame::default());
        assert!(first.is_empty());
        assert!(relay.lagged(&RenderFrame::default()).is_empty());
        let frame = relay_frame(0, 0);
        let bytes = frame.bytes.clone();
        assert_eq!(relay.forward(frame), Some(bytes), "frame (0, 0) after an empty lag keyframe");
    }
}
