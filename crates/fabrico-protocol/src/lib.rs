//! `fabrico-protocol` — the sim→render wire contract.
//!
//! This crate defines the **integer-only** serde DTOs that travel between the
//! deterministic Rust sim and the renderer:
//!
//! - [`RenderPacket`] (+ [`NodeView`], [`BeltView`], [`ItemView`]) — the sim→render
//!   frame the host builds (07-04) and both transports (dev WebSocket + the Tauri
//!   `Channel`) postcard-encode to *identical* bytes; the hand-rolled TS decoder
//!   (07-05) verifies its decode against the frozen `0007` golden fixture.
//! - [`GridCommand`] — the render→sim / harness→sim command (place / wire / delete)
//!   the frontend encodes and `input_apply.rs` (08-06) decodes. (The legacy
//!   single-log gesture command type was removed in the Phase-8 clean break,
//!   decision Q4 — `GridCommand` is now the ONE command schema both producers drive
//!   the grid through.)
//!
//! # Determinism & wire discipline (RESEARCH Pitfalls 3 & 4)
//! Every numeric field is a plain signed/unsigned integer. There are **no**
//! `f32`/`f64` and **no** `fixed`-point types anywhere on the wire: the sim is
//! fixed-point, so positions, ticks and fill are integers, and the renderer
//! converts to floating-point only canvas-side. Item motion ships analytically —
//! [`ItemView::arrival_tick`] plus [`BeltView::latency`] let the renderer derive
//! item progress render-side (VIS-01/VIS-02) with no fixed-point on the wire.
//! Keeping the grammar integer-only gives the hand-rolled TS varint decoder a
//! fixed, simple shape (threat T-07-WIRE-FLOAT).
//!
//! # Render handle convention (Assumption A3)
//! The `id` on [`NodeView`] / [`BeltView`] (and the entries of
//! [`RenderPacket::removed`]) is a **dense, host-assigned `u64` render handle** —
//! NOT `NodeId::as_ffi()` (which packs a generation counter in the high bits, can
//! exceed 2^53, and would force `BigInt` in TS). The host owns the dense↔NodeId
//! mapping; the wire only ever sees the dense handle, which stays inside the plain
//! JS `number` range.
//!
//! # Trust boundary
//! This crate only DEFINES the shape. Postcard bytes (from either transport or the
//! frozen fixture) are untrusted; bounds-safe `Result`-returning decode lives in
//! fabrico-host (07-06) and the TS decoder (07-05), never here.

#![forbid(unsafe_code)]

use serde::{Deserialize, Serialize};
use ts_rs::TS;

// ---------------------------------------------------------------------------
// Shared u8 conventions — ONE source of truth for 07-02 (core fold), 07-04
// (host derive) and 07-09 (palette). Encoded as bare `u8` on the wire (not a
// Rust enum) so the renderer maps the byte to a sprite/colour without a
// variant-index coupling.
// ---------------------------------------------------------------------------

/// The `kind: u8` convention carried by [`NodeView::kind`].
///
/// | byte | machine  |
/// |------|----------|
/// | 0    | Source   |
/// | 1    | Belt     |
/// | 2    | Factory  |
/// | 3    | Tee      |
/// | 4    | Balancer |
/// | 5    | Router   |
/// | 6    | Merge    |
/// | 7    | Sink     |
/// | 8    | Wire     |
/// | 9    | Endpoint |
/// | 10   | Handler  |
/// | 11   | Label    |
pub mod machine_kind {
    /// External event ingress (webhook/manual): the "source" of items.
    pub const SOURCE: u8 = 0;
    /// A conveyor segment carrying items between nodes.
    pub const BELT: u8 = 1;
    /// User-code (JS) transform node.
    pub const FACTORY: u8 = 2;
    /// One-input fan-out splitter.
    pub const TEE: u8 = 3;
    /// Round-robin load balancer.
    pub const BALANCER: u8 = 4;
    /// Predicate/route selector.
    pub const ROUTER: u8 = 5;
    /// Round-robin many-input merge.
    pub const MERGE: u8 = 6;
    /// Real-world side effect (an HTTP call): the "launch the rocket" sink.
    pub const SINK: u8 = 7;
    /// Request/response transport wire (Phase-37 WIRE seam). **Appended LAST** at
    /// the next free byte (8) — the machine_kind u8 order is DELIBERATELY distinct
    /// from the `Node` enum discriminant order; the explicit `Node::X => WIRE` match
    /// at each mapper site is the only bridge (never `as u8`). A live byte: wires carry
    /// traffic since Phase 37 and are user-drawable since Phase 63, so a wrong arm at a
    /// mapper site is a wrong node, not a dormant mapping.
    pub const WIRE: u8 = 8;
    /// Host-bridge endpoint (Phase-38 ENDPOINT seam). **Appended LAST** at the next
    /// free byte (9) — same distinct-ordering discipline as WIRE. A live byte: endpoints
    /// bridge to the host since Phase 38, and `fold_place` mints one from this byte since
    /// 63-04.
    pub const ENDPOINT: u8 = 9;
    /// HTTP Handler (Phase-72 SERVE-03): user code that a webhook reaches over a
    /// `Node::Wire`, and whose computed reply travels back out the same way.
    /// **Appended LAST** at the next free byte (10), the same
    /// append-at-the-next-free-byte discipline WIRE and ENDPOINT already carry: the
    /// `machine_kind` u8 order is DELIBERATELY distinct from the `Node` enum
    /// discriminant order, and the explicit `Node::X => KIND` match at each mapper
    /// site is the only bridge (never `as u8`).
    ///
    /// A Handler FOLDS TO A `Node::Factory` (72-CONTEXT D-11): there is no
    /// `Node::Handler` variant, no new serialized node shape and no port editing. What
    /// distinguishes a Handler from a Factory is the DECLARED MEDIUM of its catalog
    /// port 0, which is electrical, and which `step_factory` reads through
    /// `admit::inbox_class` to decide how the machine is serviced (D-16, plan 72-03).
    ///
    /// This byte is what the render packet, the palette row, the config heading and
    /// BOTH LOD tables (`SUBJECT_OF`, `GEN_KEY_OF`) read to tell a Handler from a
    /// Factory. A wrong arm at a mapper site is a wrong machine on screen, not a
    /// dormant mapping.
    pub const HANDLER: u8 = 10;
    /// A note on the board (phase 76, SHAPE-10): a `Node::Label` carrying the user's words
    /// and one of six colours. **Appended LAST** at the next free byte (11), the same
    /// append-at-the-next-free-byte discipline WIRE, ENDPOINT and HANDLER carry: the
    /// `machine_kind` u8 order is DELIBERATELY distinct from the `Node` enum discriminant
    /// order (a label is `Node` discriminant 10 and kind byte 11), and the explicit
    /// `Node::Label(_) => LABEL` arm at each mapper site is the only bridge (never
    /// `as u8`). The mapper sites are `fabrico-command` `grid_view::kind_byte` and
    /// `fabrico-host` `render_packet::machine_kind_of` and `input_apply::kind_byte`.
    ///
    /// The frontend reads this byte in `kinds.ts` (`LABEL: 11`, locked by
    /// `ts_label_mirror.rs`), the `MACHINE_CATALOG` row in `decode.ts`, the palette row,
    /// the config heading, and the machines layer's own label branch. A label is in
    /// NEITHER LOD table (`SUBJECT_OF`, `GEN_KEY_OF`): it is drawn by its own branch at
    /// every zoom. A wrong arm at a mapper site is a wrong object on screen.
    pub const LABEL: u8 = 11;
}

/// The `state: u8` convention carried by [`NodeView::state`].
///
/// | byte | state     |
/// |------|-----------|
/// | 0    | idle      |
/// | 1    | working   |
/// | 2    | faulted   |
/// | 3    | backed up |
pub mod state_tag {
    /// Node has nothing to do this tick.
    pub const IDLE: u8 = 0;
    /// Node is actively processing.
    pub const WORKING: u8 = 1;
    /// Node hit a fault (visualised distinctly).
    pub const FAULTED: u8 = 2;
    /// The jam mark. Two meanings, one byte:
    ///
    /// * the node is REFUSING: its mechanical inbox is AT the admission cap, so it is
    ///   refusing further belt deliveries (PILE-08, D-05), or, for a Source, its backlog is
    ///   at its own cap (JAM-06);
    /// * since phase 87 (JAM-04, D-06), the node did not step this tick and WAITS behind an
    ///   output that cannot take one more item, holding work (an inbox item, a Source's
    ///   backlog or a Factory's waiting emits). A blocked machine now sleeps out of the
    ///   active set, so without this reading a machine stuck behind its output would paint
    ///   IDLE and a jammed board would look empty.
    ///
    /// **Appended LAST** at the next free byte (3), the same distinct-ordering discipline
    /// [`machine_kind::ENDPOINT`] follows.
    ///
    /// The host derives the byte in this order: FAULTED, then refusing (BACKED_UP), then
    /// WORKING (the node stepped), then waiting (BACKED_UP), then IDLE. Refusing comes before
    /// WORKING because a full machine woken and held back by the output gate on a tick is in
    /// the tick observation's active set, so a `stepped` arm checked first would paint the
    /// jammed machine green; waiting comes after WORKING so a tick on which the machine steps
    /// reads what it read before phase 87 (the one-tick drip of a steady jam stays WORKING).
    /// See `fabrico_host::render_packet::derive_state`.
    ///
    /// It pairs with [`NodeView::load`], which carries the magnitude: this byte says
    /// WHICH machine is jammed, the gauge says HOW full its inbox is, so a waiting machine's
    /// gauge can sit below the full bar. A machine that is both faulted and full reports
    /// FAULTED here and still carries `load == 4`, because the two are separate channels.
    pub const BACKED_UP: u8 = 3;
}

/// The `role: u8` convention carried by [`PortView::role`]. A PROTOCOL-level tag
/// independent of core `Role` (which has only In/Out today): `Fault = 2` is a
/// RESERVED WIRE capability (PORT-02) with no core source in this phase — Phase 17's
/// core `Role::Fault` fills it in with a single host match arm and no wire change.
/// Encoded as a bare `u8` (not a Rust enum), mirroring [`machine_kind`]/[`state_tag`].
///
/// | byte | role  |
/// |------|-------|
/// | 0    | In    |
/// | 1    | Out   |
/// | 2    | Fault |
pub mod port_role {
    /// An input port — a belt Head docks here (LOAD).
    pub const IN: u8 = 0;
    /// An output port — a belt Tail docks here (OFFLOAD).
    pub const OUT: u8 = 1;
    /// A reserved fault-emitter port. No core node sources this yet (Phase 17);
    /// the golden pins the byte so the renderer can style it distinctly.
    pub const FAULT: u8 = 2;
}

/// The `medium: u8` convention carried by [`PortView::medium`]/[`CatalogPortView::medium`].
/// A PROTOCOL-level tag mirroring core `Medium` (35-03): `Mechanical = 0` (belt/item
/// transport), `Electrical = 1` (the Phase-37 request/response WIRE). Encoded as a bare
/// `u8` (not a Rust enum), mirroring [`port_role`]/[`machine_kind`]/[`state_tag`].
///
/// | byte | medium     |
/// |------|------------|
/// | 0    | Mechanical |
/// | 1    | Electrical |
pub mod port_medium {
    /// Belt / item transport — the default medium every pre-`medium` port rides as.
    pub const MECHANICAL: u8 = 0;
    /// The Phase-37 request/response WIRE medium (electrical request/reply transport).
    pub const ELECTRICAL: u8 = 1;
}

// ---------------------------------------------------------------------------
// sim -> render
// ---------------------------------------------------------------------------

/// One sim→render frame. A `full` packet is a keyframe (every live cell); a
/// non-`full` packet is an active-set diff (only nodes/belts that changed this
/// tick), which is what keeps a quiet grid nearly free.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct RenderPacket {
    /// The sim tick this packet describes.
    #[ts(type = "number")]
    pub tick: u64,
    /// `true` = keyframe (all live cells); `false` = active-set diff.
    pub full: bool,
    /// Nodes added, or whose `(kind | state | rot | ports | load)` changed this packet.
    pub placed: Vec<NodeView>,
    /// Dense `u64` render handles removed this packet.
    #[ts(type = "number[]")]
    pub removed: Vec<u64>,
    /// Belts whose `items`/`fill` changed this packet.
    pub belts: Vec<BeltView>,
    /// Live undo availability (UNDO-06). RENDER-ONLY: sourced from the host's
    /// `GridSession::can_undo()` each tick, rides EVERY packet (diff AND keyframe)
    /// so the toolbar enables on the first placement (a diff), never in
    /// `snapshot(core)` and never hashed. Appended AFTER `belts` (append-only
    /// preserves postcard field order + cross-language decode).
    pub can_undo: bool,
    /// Live redo availability (UNDO-06). RENDER-ONLY; see [`can_undo`](Self::can_undo).
    pub can_redo: bool,
    /// The live electrical-wire projections (WUI-01) — every `Node::Wire` becomes a
    /// drawable/animatable [`WireView`] (endpoints + `wire_route()` path + in-flight
    /// pulses + the host-derived direction byte). **Appended LAST** (after
    /// `can_redo`) so the existing reader prefix stays byte-stable: this is
    /// EPHEMERAL sim->render IPC (PORT-05), so growing it re-freezes ONLY the 0008
    /// render golden and drives NO snapshot/edit/event/command version bump. EMPTY
    /// for a grid with no wires (the active-set discipline).
    pub wires: Vec<WireView>,
    /// WHY this keyframe was sent: `true` = a LAG RESYNC, `false` = everything else
    /// (73-12, 73-REVIEW WR-01). Meaningless on a diff packet, where it is always
    /// `false`. **Appended LAST** (after `wires`) so the existing reader prefix stays
    /// byte-stable; this is ephemeral sim->render IPC (PORT-05), so it re-freezes only
    /// the render goldens and drives NO snapshot/edit/event/command version bump.
    ///
    /// # Why one bit, and what reads it
    /// `full` alone conflates two events that mean opposite things to a client holding
    /// an unacknowledged edit:
    ///
    /// - A RESTRUCTURE (an undo, a redo, a load, a New, a scene swap) re-writes the
    ///   timeline, after which the packet index an in-flight edit was addressed against
    ///   means nothing. `frontend/src/chrome/portEditLatch.ts` releases its latch on it,
    ///   because holding one is a dead end with no cause the user can see.
    /// - A LAG RESYNC re-sends the CURRENT keyframe to a connection that fell past the
    ///   bounded diff broadcast. The timeline did not move; the client simply missed
    ///   frames. Releasing a latch here is the releases-too-early direction that killed
    ///   the port-edit latch's first iteration: the pending `RemovePort` may still be
    ///   sitting unfolded in the host's gesture channel, and the user's obvious response
    ///   to a released latch - click again - queues the exact duplicate the latch exists
    ///   to prevent.
    ///
    /// Both transports (`fabrico_host::transport_ws` and `fabrico_app`) set it on their
    /// `broadcast::error::RecvError::Lagged` arm and nowhere else, and there only when no
    /// `RenderProducer::reset` fell among the frames the connection missed
    /// (`fabrico_host::render_packet::RenderRelay::lagged`, plan 76-19 refuter round). A
    /// lag that spanned a reset spanned a restructure, so its keyframe goes out with the
    /// bit false, as the reset's own keyframe would have. `RenderProducer` never sets it:
    /// every packet it publishes is either a diff or a genuine restructure.
    pub resync: bool,
    /// The BOARD GENERATION of the handle table every handle in this packet belongs to
    /// (phase 88, D-02, D-05). **Appended LAST** (after `resync`) so the existing reader
    /// prefix stays byte-stable; this is ephemeral sim->render IPC (PORT-05), so it
    /// re-freezes only the render golden and drives NO snapshot/edit/event/command version
    /// bump.
    ///
    /// # What it counts, and why a client needs it
    /// Every `RenderProducer::reset` (an undo, a redo, a load, a New, a scene swap) installs
    /// a fresh handle table that mints every render handle again from 0, and raises this
    /// number by one. A handle is therefore only meaningful TOGETHER with the generation it
    /// was read under: handle 4 of generation 2 and handle 4 of generation 3 can be two
    /// different machines. The client echoes the generation of the packet it read a handle
    /// from on every gesture frame, so the host can tell which table the user was looking
    /// at. It is set by the producer on every diff and every keyframe, and equals the
    /// generation the producer sends beside the bytes (`RenderFrame.generation`).
    ///
    /// The TypeScript decoder reads it STRICTLY: a packet without it fails to decode rather
    /// than defaulting to 0, because a defaulted generation would address the wrong table.
    /// Exported to TypeScript as a `number`, like `tick`: it counts resets, which stay far
    /// below 2^53 for the life of any board.
    #[ts(type = "number")]
    pub generation: u64,
    /// The generation the last BOARD SWAP installed (phase 88 security, T-88-11): the
    /// host's swap floor. **Appended LAST** (after `generation`), ephemeral sim->render IPC
    /// like it, so it re-freezes only the render golden and drives no version bump.
    ///
    /// # Why a client needs it
    /// A Load, LoadDemo, LoadScene or New replaces the board and raises the generation, as an
    /// undo or a redo does, so the generation alone cannot say which of the two happened. A
    /// handle read on a replaced board names nothing on the new one, and the host discards a
    /// gesture stamped below this floor. A client that names a machine or a belt AGAIN in a
    /// newer table (an accept the scene overtook) must not do so across a swap, and it learns
    /// of a swap from this field on the keyframe itself, whichever page or client asked for
    /// it. Equal to `generation` on the swap's own keyframe; 0 before any swap.
    ///
    /// Read STRICTLY by the TypeScript decoder, like `generation`.
    #[ts(type = "number")]
    pub swap_floor: u64,
}

/// A placed machine. `kind`/`state` use the [`machine_kind`]/[`state_tag`]
/// conventions.
///
/// # Footprint model (REND-01)
/// `w`/`h`/`rot` carry the machine's multi-cell footprint sourced from core
/// [`footprint_of`](fabrico_core::state::GridState::footprint_of) (ABSENT ⇒ the
/// faithful `1×1 rot0` default). `w`/`h` are the rot-0 frame dims; the renderer
/// drives orientation from the authoritative `rot` (the legacy cosmetic `orient`
/// facing was removed in Phase 16 — the renderer drives entirely off `rot` + the
/// host-resolved `ports`, CLEAN-02).
///
/// # Ports (PORT-01)
/// `ports` carries the machine's host-resolved WORLD port geometry (cell + side +
/// role + index) built from core
/// [`port_world`](fabrico_core::state::port_world) — the rotation is applied in the
/// deterministic core, so the renderer draws each nub with ZERO rotation math.
/// EMPTY for a port-less node. Appended LAST (after `rot`) so the existing reader
/// prefix stays byte-stable (RESEARCH §Wire encoding A2).
///
/// # Load (PILE-08)
/// `load` carries the machine's inbox fill as a LEVEL of 0 through 4, never a raw
/// count: 0 is empty, 4 is at the mechanical admission cap, and the three bands
/// between are quantised HOST-side in
/// `fabrico_host::render_packet::derive_load`. The level rather than the count is
/// what rides the wire so the frontend never has to hold a TypeScript mirror of the
/// cap in order to draw anything: one derivation, one place, one cap.
/// Appended LAST (after `ports`) so the existing reader prefix stays byte-stable,
/// the same discipline `ports` itself followed. Postcard field order after this
/// append: `id, kind, cell_x, cell_y, state, w, h, rot, ports, load`.
///
/// **The reader is POSITIONAL and hand-written.** `frontend/src/protocol/decode.ts`
/// decodes this struct field by field off a byte reader, so a `u8` added here
/// without a matching `r.u8()` at the same position does NOT produce a missing
/// value: it desynchronises the reader mid-node and corrupts `ports` and every node
/// after it in the packet. That has shipped here once already (the `medium` append,
/// fixed in Phase 36). The `ts-rs` binding does not cover it, because `decode.ts`
/// declares its OWN local `NodeView` interface that nothing compares to the
/// generated one.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct NodeView {
    /// Dense, host-assigned `u64` render handle (NOT `NodeId::as_ffi()`).
    #[ts(type = "number")]
    pub id: u64,
    /// Machine class — see [`machine_kind`].
    pub kind: u8,
    /// Grid cell X (integer cell coordinate).
    pub cell_x: i32,
    /// Grid cell Y (integer cell coordinate).
    pub cell_y: i32,
    /// Visual state — see [`state_tag`].
    pub state: u8,
    /// Footprint width in the rot-0 frame (ABSENT core footprint ⇒ `1`).
    pub w: u16,
    /// Footprint height in the rot-0 frame (ABSENT core footprint ⇒ `1`).
    pub h: u16,
    /// Footprint orientation — number of 90° clockwise quarter-turns (`0..=3`).
    /// The authoritative orientation the renderer rotates the glyph/ports by.
    pub rot: u8,
    /// Host-resolved WORLD port geometry (PORT-01), in rot-0 port-index order.
    /// EMPTY for a port-less node. Every value is the authoritative output of core
    /// [`port_world`](fabrico_core::state::port_world) (rot already applied).
    pub ports: Vec<PortView>,
    /// Mechanical inbox fill as a LEVEL, `0..=4` (PILE-08). Quantised host-side; see
    /// the `# Load` paragraph above. The wire keyspace is OPEN like `role`/`side`/
    /// `medium`: a byte outside `0..=4` decodes raw and is clamped at the draw call,
    /// never rejected.
    pub load: u8,
    /// A label's words and colour (phase 76, plan 76-02, D-02), `Some` for a
    /// `Node::Label` and `None` for every other kind. Appended LAST (after `load`) so the
    /// existing reader prefix stays byte-stable, the discipline `ports` and `load` followed.
    /// Postcard field order after this append: `id, kind, cell_x, cell_y, state, w, h,
    /// rot, ports, load, label`. The label's SIZE is not here: it rides `w` and `h` like
    /// every machine's box.
    ///
    /// **TWO HAND-WRITTEN CODECS MUST MOVE WITH THIS FIELD, IN THE SAME COMMIT.** The
    /// positional reader `readNodeView` in `frontend/src/protocol/decode.ts` (one option
    /// tag byte, then the string and the colour byte; `None` decodes to `null`, which is
    /// what the 0008 golden's JSON carries), and the mock encoder `buildPacket` in
    /// `frontend/e2e/support/wire.ts` (writes `0`, or `1` then the text and the colour
    /// byte). Either one missed desynchronises every node after the first, and the mock
    /// suite's scenes come back empty (research Pitfall 1). The 0008 golden carries one
    /// label with multibyte text so a string length read in characters shows there.
    pub label: Option<LabelView>,
}

/// A label's words and colour on the wire (phase 76, plan 76-02): the render-side mirror
/// of `fabrico_core::state::Label`. `colour` is the `LabelColour` byte (Sand 0, Stone 1,
/// Moss 2, Lilac 3, Rose 4, Clay 5), a plain integer because this crate's wire grammar
/// permits plain integers only (the `BeltView::ticks_per_slot` precedent).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct LabelView {
    /// The committed words, verbatim. Bounded by `fabrico_core::edit::MAX_LABEL_BYTES`
    /// at the command layer; the board draws them as text, never as markup.
    pub text: String,
    /// The box tint byte, `0..=5`.
    pub colour: u8,
}

/// One machine port on the wire (PORT-01/02): its host-resolved WORLD position +
/// role. Every value is the AUTHORITATIVE output of core
/// [`port_world`](fabrico_core::state::port_world) (rot already applied), so the
/// renderer draws the nub with ZERO rotation math.
///
/// **Postcard field order (load-bearing):** `index` (u16 varint), `cell_x`
/// (i32 zigzag), `cell_y` (i32 zigzag), `side` (u8), `role` (u8), `medium` (u8).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct PortView {
    /// The port's index in the node's rot-0 port list (identity-stable — "port 5
    /// stays port 5"); the wire/dock commands address a port by THIS index.
    pub index: u16,
    /// World cell X (from `port_world`, rot-applied).
    pub cell_x: i32,
    /// World cell Y (from `port_world`, rot-applied).
    pub cell_y: i32,
    /// World side the port faces — the `Side` numeric order (`N=0, E=1, S=2, W=3`),
    /// already rot-applied by `port_world`.
    pub side: u8,
    /// Port role — see [`port_role`] (`In=0, Out=1, Fault=2`).
    pub role: u8,
    /// Port transport medium — see [`port_medium`] (`Mechanical=0, Electrical=1`).
    /// **Appended LAST** (35-03) so the existing reader prefix stays byte-stable.
    pub medium: u8,
}

/// One port in a pre-placement machine-kind CATALOG entry (CAT-05). Unlike
/// [`PortView`] — which carries a PLACED node's rot-applied WORLD cell — a catalog
/// port carries the ROT-0 FRAME `local_offset`: a ghost is not yet placed, so the
/// frontend sizes the ghost and positions each nub RELATIVE to the placement cursor,
/// applying rotation itself. This is the pre-placement sibling of [`PortView`].
///
/// **Postcard field order (load-bearing):** `index` (u16 varint), `local_x`
/// (i32 zigzag), `local_y` (i32 zigzag), `side` (u8), `role` (u8), `medium` (u8).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CatalogPortView {
    /// The port's index in the kind's rot-0 port list (identity-stable — "port 5
    /// stays port 5"); dock commands address a port by THIS index.
    pub index: u16,
    /// Rot-0 frame local X offset (`0 ≤ x < w`).
    pub local_x: i32,
    /// Rot-0 frame local Y offset (`0 ≤ y < h`).
    pub local_y: i32,
    /// The cell edge this port faces in the rot-0 frame (`N=0, E=1, S=2, W=3`).
    pub side: u8,
    /// Port role — see [`port_role`] (`In=0, Out=1, Fault=2`).
    pub role: u8,
    /// Port transport medium — see [`port_medium`] (`Mechanical=0, Electrical=1`).
    /// **Appended LAST** (35-03) so the existing reader prefix stays byte-stable.
    pub medium: u8,
}

/// The authoritative pre-placement CATALOG entry for one machine kind (CAT-05): the
/// footprint dims + rot-0 port set the placement GHOST sizes itself from, so the
/// frontend never re-derives geometry from a hand-maintained TS table (`dimsForKind`
/// is deleted in 17-03). It is produced FROM the single-source `port_catalog` in
/// `fabrico-command` (`catalog_entry`) — NEVER hand-copied (threat T-17-CAT-DRIFT).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct MachineCatalogEntry {
    /// The machine kind byte — see [`machine_kind`].
    pub kind: u8,
    /// Rot-0 footprint width.
    pub w: u16,
    /// Rot-0 footprint height.
    pub h: u16,
    /// Declared orientation — `0` for a fresh ghost (the frontend rotates the glyph).
    pub rot: u8,
    /// The rot-0 port set in port-index order (empty for a portless kind).
    pub ports: Vec<CatalogPortView>,
}

/// One belt-end dock (PORT-03): which machine port a belt END attaches to. Carries
/// the docked machine's dense render handle + port index + which end docks (FORK B)
/// — NOT a pre-resolved cell, so the frontend resolves the nub from that node's
/// [`ports`](NodeView::ports) and re-resolves for free on node move/rotate (the
/// belt stays UNCHANGED in the active-set diff when its docked machine moves).
///
/// **Postcard field order:** `end` (`BeltEnd` discriminant, `Head=0, Tail=1`),
/// `node` (u64 varint), `port` (u16 varint).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct BeltDockView {
    /// Which belt end docks (`Head` = deliver/LOAD, `Tail` = admit/OFFLOAD).
    pub end: BeltEnd,
    /// The docked machine's dense render handle.
    #[ts(type = "number")]
    pub node: u64,
    /// The machine port index this end docks to.
    pub port: u16,
}

/// The typed straight/corner geometry of one belt tile on the wire — a
/// protocol-local mirror of `fabrico_core::state::TileKind` (RESEARCH A3: keep
/// `fabrico-protocol` the sole wire-DTO owner; the core type is NOT `TS`-derived
/// to avoid cross-crate coupling). Integer-only: the `Axis`/`Dir` enums ride as
/// their numeric `u8` (Axis: `X=0, Y=1`; Dir: `N=0, E=1, S=2, W=3`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub enum TileKindView {
    /// A straight run along `axis` (`X=0, Y=1`).
    Straight {
        /// The run axis as a numeric `u8` (`X=0, Y=1`).
        axis: u8,
    },
    /// A 90° corner: flow enters facing `from` and leaves facing `to`
    /// (`Dir`: `N=0, E=1, S=2, W=3`).
    Corner {
        /// The inbound flow direction as a numeric `u8`.
        from: u8,
        /// The outbound flow direction as a numeric `u8`.
        to: u8,
    },
}

/// One drawn belt tile on the wire — its grid `cell` plus its typed
/// [`TileKindView`] geometry. The protocol-local mirror of
/// `fabrico_core::state::BeltTile` (REND-01); integer-only, no float.
///
/// # `kind` is the tile AS DRAWN (phase 74.1, plan 74.1-07)
/// At a DOCKED belt end, `kind` is what `GridState::effective_belt_tiles` derives
/// from the seam: a belt that turns at a dock ships a 90 degree `Corner` there even
/// though the core still stores the `Straight` that `route()` authored. Everywhere
/// else it is the stored kind. The postcard shape is unchanged (same fields, same
/// order), and the host and the renderer ship together pre-v1, so the change of
/// MEANING moves no version constant.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct TileView {
    /// The grid cell X this tile occupies.
    pub cell_x: i32,
    /// The grid cell Y this tile occupies.
    pub cell_y: i32,
    /// The tile's typed straight/corner geometry AS DRAWN: the seam-derived kind at a
    /// docked end, the stored kind elsewhere.
    pub kind: TileKindView,
}

/// A conveyor segment plus the items currently riding it. The renderer derives
/// each item's position analytically from `arrival_tick`, `latency` and the belt
/// tile geometry — no fixed-point on the wire (VIS-01/VIS-02).
///
/// # Tile geometry (REND-01), AS DRAWN (phase 74.1, plan 74.1-07)
/// `tiles` carries the belt's per-tile straight/corner geometry AS DRAWN: core
/// `Belt.geometry` with each DOCKED end re-kinded by `GridState::effective_belt_tiles`
/// from what its seam says now (a perpendicular dock draws a 90 degree corner), never
/// written back to the core. EMPTY for a `Wire`-minted logical belt, length `== tiles`
/// for a `DrawBelt`-drawn belt. The postcard shape is unchanged; only the meaning of a
/// docked end's `kind` moved, from "stored" to "as drawn".
///
/// # Dock endpoints (PORT-03, CLEAN-03)
/// `docks` carries per-end `(node, port, BeltEnd)` dock metadata derived from the
/// core `(belt, 0)` link graph (replacing the removed `from_x/from_y/to_x/to_y`
/// belt-endpoint cells). The frontend resolves each endpoint's world position from
/// the docked node's [`ports`](NodeView::ports). Appended LAST (after `tiles`) so
/// the existing reader prefix stays byte-stable (RESEARCH §Wire encoding A2).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct BeltView {
    /// Dense, host-assigned `u64` render handle.
    #[ts(type = "number")]
    pub id: u64,
    /// End-to-end transport latency in ticks (>0); the renderer divides elapsed
    /// ticks by this to get fractional belt progress.
    pub latency: u32,
    /// Occupancy hint (0..=u16::MAX) for the belt-fill shimmer.
    pub fill: u16,
    /// Items riding this belt.
    pub items: Vec<ItemView>,
    /// Per-tile geometry (straight/corner) AS DRAWN: the seam-derived kind at a docked
    /// end, the stored kind elsewhere. EMPTY for a `Wire`-minted belt; length `== tiles`
    /// for a `DrawBelt`-drawn belt.
    pub tiles: Vec<TileView>,
    /// Per-end dock metadata (PORT-03): `(node, port, BeltEnd)` derived from the
    /// core `(belt, 0)` link graph, deterministic Head-before-Tail. The frontend
    /// resolves each endpoint's world cell from the docked node's `ports`.
    pub docks: Vec<BeltDockView>,
    /// This belt's own advance interval in SIM TICKS per slot (SLOT-03,
    /// `62-CONTEXT.md` D-01/D-08). Larger means slower: the belt advances its items
    /// one slot on every tick `T` where `T % ticks_per_slot == 0`.
    ///
    /// **Appended LAST** (after `docks`) so the existing reader prefix stays
    /// byte-stable — the same discipline `wires` and `NodeView.ports` state above.
    ///
    /// The renderer needs it because the belt's painted TREAD is derived from the
    /// speed of the cargo it carries (D-05), and `frontend/src/render/interp.ts`
    /// forbids re-typing a core constant render-side: a render-side copy would be a
    /// second source of truth that a core bump could silently desynchronise. So the
    /// interval travels on the wire rather than being agreed by two code paths.
    ///
    /// The core holds this as `NonZeroU32`; the host writes `.get()` because this
    /// crate's wire grammar (see the module docblock) permits plain integers only.
    /// The invariant therefore lives in the CORE, not here — a zero arriving on this
    /// field is a broken producer, and the renderer floors it rather than dividing
    /// by it.
    ///
    /// This crate is EPHEMERAL sim-to-render IPC (PORT-05), so growing it re-freezes
    /// ONLY the `0008` render golden and drives NO snapshot/edit/event/command
    /// version bump. The snapshot and project-file bump this phase also carries is
    /// forced by the CORE field and lands separately (plan 62-06); the two are
    /// independent and must not be conflated.
    pub ticks_per_slot: u32,
}

/// One item on a belt. `arrival_tick` is the absolute sim tick the item is due to
/// reach the belt's destination; combined with [`BeltView::latency`] the renderer
/// interpolates its current position. `tag` is a small visual class derived from
/// the item bytes (a colour/sprite bucket), not the item payload.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ItemView {
    /// Absolute sim tick this item arrives at the belt's destination.
    #[ts(type = "number")]
    pub arrival_tick: u64,
    /// Small visual class (colour/sprite bucket) derived from item bytes.
    pub tag: u8,
}

/// One electrical-wire endpoint dock on the wire (WUI-01): the docked machine's
/// dense render handle + the port index the wire terminal attaches to. The FORK-B
/// discipline `BeltDockView` uses — carries the `(node, port)` HANDLE, not a
/// pre-resolved cell, so the frontend resolves the electrical nub anchor from that
/// node's [`ports`](NodeView::ports) and re-resolves for free on a node move/rotate.
///
/// **Postcard field order (load-bearing):** `node` (u64 varint), `port` (u16 varint).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct WireDockView {
    /// The docked machine's dense render handle.
    #[ts(type = "number")]
    pub node: u64,
    /// The machine port index this wire endpoint attaches to.
    pub port: u16,
}

/// One in-flight wire pulse on the wire (WUI-01) — the request/reply energy pulse
/// the renderer animates along the cable. Integer-only: the pulse's on-cable
/// position is derived render-side from `(effectiveClock - entry_tick) / hop_ticks`,
/// so NO float ever crosses the packet (the belt `ItemView` analytic-motion
/// precedent). `direction` is the HOST-DERIVED forward/reply byte (see
/// [`WIRE_FORWARD`]/[`WIRE_REPLY`] in `fabrico-host`) — never a snapshotted sim
/// field (the frozen-schema discipline).
///
/// **Postcard field order (load-bearing):** `entry_tick` (u64 varint), `hop_ticks`
/// (u32 varint), `direction` (u8).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct WirePulseView {
    /// The sim tick this message was admitted to the wire — the render-side
    /// interpolation anchor (`frac = (clock - entry_tick) / hop_ticks`).
    #[ts(type = "number")]
    pub entry_tick: u64,
    /// The wire hop duration in ticks (>=1); the renderer divides elapsed ticks by
    /// this to get the pulse's fractional progress along the cable.
    pub hop_ticks: u32,
    /// Host-derived direction byte: `0` = FORWARD (request travelling out), `1` =
    /// REPLY (response travelling home). Derived at packet-build time from
    /// observable topology, NEVER a stored/snapshotted sim field.
    pub direction: u8,
}

/// An electrical request/response transport wire projected for the renderer
/// (WUI-01) — a `Node::Wire` becomes a real drawable/animatable cable instead of a
/// degenerate `NodeView(0,0)`. EPHEMERAL sim->render IPC (PORT-05): appended LAST
/// on the [`RenderPacket`], NEVER a snapshotted shape.
///
/// # What it carries
/// - `from`/`to`: the two endpoint docks (`(node, port)` handles, FORK-B resolved
///   frontend-side like belt docks).
/// - `path`: the `wire_route()`-normalized orthogonal cell path (wire corners
///   inherit the parity-pinned belt corner geometry) — integer-only [`TileView`]s.
/// - `pulses`: the in-flight request/reply pulses (EMPTY for an idle wire — the
///   active-set discipline: an idle wire has nothing to animate).
///
/// **Postcard field order (load-bearing):** `id` (u64 varint), `from`
/// ([`WireDockView`]), `to` ([`WireDockView`]), `path` (`Vec<TileView>`), `pulses`
/// (`Vec<WirePulseView>`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct WireView {
    /// Dense, host-assigned `u64` render handle.
    #[ts(type = "number")]
    pub id: u64,
    /// The wire's originating endpoint dock (the `from` `(node, port)` handle).
    pub from: WireDockView,
    /// The wire's terminating endpoint dock (the `to` `(node, port)` handle).
    pub to: WireDockView,
    /// The `wire_route()`-normalized orthogonal cell path connecting the two
    /// endpoints — wire corners inherit the parity-pinned belt corner geometry.
    pub path: Vec<TileView>,
    /// The in-flight request/reply pulses (EMPTY for an idle wire).
    pub pulses: Vec<WirePulseView>,
}

// ---------------------------------------------------------------------------
// render -> sim (command)
// ---------------------------------------------------------------------------

/// The canonical render→sim / harness→sim command schema — the ONE semantic
/// command shape both producers drive the grid through (CMD-01/CMD-04, "one
/// schema, two producers": the live UI and the Playwright/Rust test harness).
///
/// `GridCommand` carries only wire-plain integers and dense, host-assigned
/// render handles — nothing about the mouse, pixels, or screen-space (CMD-01).
/// It is integer-only on the wire; every `u64` handle is rendered as a TS
/// `number` (not a bigint) via the dense-handle convention (Assumption A3) so it
/// stays inside the JS `number` range.
///
/// `GridCommand` is the SOLE render→sim command type. It REPLACED the legacy
/// single-log gesture command type, removed in the Phase-8 clean break (decision
/// Q4) once every consumer was repointed at it. The headless `fabrico-command`
/// crate (08-04) validates it and the live host (08-06) consumes it; ts-rs exports
/// it for the UI and a Playwright layer (Phase 13/14) to drive the identical schema.
/// Which END of a belt a [`GridCommand::Dock`] attaches to — and, with the resolved
/// machine port role, the dock DIRECTION.
///
/// Belt flow runs from the **TAIL** (admit / entry, the FIRST drawn cell) toward the
/// **HEAD** (deliver / exit, the LAST drawn cell) — the direction `route()`'s corner
/// inference already assumes (`in_dir = c[i] - c[i-1]`). Docking is a SEPARATE
/// explicit action (CONTEXT: a secondary action that declares where a belt
/// offloads/loads and the direction of travel), NEVER auto-applied on `DrawBelt`:
/// - [`Tail`](BeltEnd::Tail) docks to a machine `Out` port — an **OFFLOAD** (the
///   machine feeds items onto the belt's admit end).
/// - [`Head`](BeltEnd::Head) docks to a machine `In` port — a **LOAD** (the belt
///   delivers items into the machine).
///
/// A plain unit-variant enum — integer-only on the wire (ts-rs exports the string
/// union `"Head" | "Tail"`), no float, no payload.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub enum BeltEnd {
    /// The deliver / exit end (the LAST drawn cell, belt slot 0). Docks to a machine
    /// `In` port — a LOAD (belt -> machine).
    Head,
    /// The admit / entry end (the FIRST drawn cell, belt slot `M-1`). Docks to a
    /// machine `Out` port — an OFFLOAD (machine -> belt).
    Tail,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub enum GridCommand {
    /// Place a machine of `kind` (see [`machine_kind`]) at a grid cell.
    Place {
        /// Machine class — see [`machine_kind`].
        kind: u8,
        /// Target grid cell X.
        cell_x: i32,
        /// Target grid cell Y.
        cell_y: i32,
    },
    /// Delete a node by its dense render handle.
    Delete {
        /// Node render handle to remove.
        #[ts(type = "number")]
        node: u64,
    },
    /// Rotate a placed machine by ONE 90° quarter-turn (FOOT-02). The form is
    /// RELATIVE (Open Q2 resolved: a relative quarter-turn is the most UI-natural —
    /// the user clicks "rotate", the command does not carry an absolute angle); the
    /// command layer resolves it against the node's current orientation into the
    /// absolute `EditOp::Rotate { new_rot, old_rot }` it freezes. The anchor is
    /// preserved (an anchor-preserving pivot, never a relocation). Discriminant 2
    /// (Phase 17-02 removed the node→node `Wire` variant at disc 1, shifting
    /// `Delete 2→1, Rotate 3→2` — the byte-forced renumber re-frozen in 17-06).
    Rotate {
        /// Node render handle to rotate.
        #[ts(type = "number")]
        node: u64,
        /// Quarter-turn direction: `true` = counter-clockwise, `false` = clockwise.
        ccw: bool,
    },
    /// Draw a belt along a player-ordered, orthogonally-adjacent list of grid `cells`
    /// (BELT-01..03). Carries the RAW drawn cells; the command layer runs the shared
    /// pure `route()` normalizer to resolve them into typed/oriented tiles (the
    /// IDENTICAL fn the UI ghost preview calls — preview == commit), then atomically
    /// collision-checks every resolved tile cell against the unified occupancy before
    /// freezing `EditOp::DrawBelt { tiles }`. A*/auto-routing is NEVER used (BELT-02);
    /// a malformed/overlapping path rejects the WHOLE belt (BELT-03/06). Discriminant
    /// 3 after the 17-02 `Wire` removal (`Place`/`Delete`/`Rotate` at 0/1/2);
    /// integer-only on the wire (each cell is a `[number, number]` tuple).
    DrawBelt {
        /// The player-ordered, orthogonally-adjacent drawn cells (raw — resolved by
        /// `route()` at validate time, never carried as resolved tiles on the wire).
        cells: Vec<(i32, i32)>,
    },
    /// Dock a belt ENDPOINT to a machine port — a SEPARATE explicit action
    /// (CONTEXT: docking is a secondary action that declares where a belt
    /// offloads/loads and the direction of travel), NEVER auto-applied on
    /// `DrawBelt`. The DIRECTION is implied by `endpoint` + the resolved machine
    /// port `role`: docking the belt's [`Tail`](BeltEnd::Tail) to a machine `Out`
    /// is an OFFLOAD (machine -> belt), docking its [`Head`](BeltEnd::Head) to a
    /// machine `In` is a LOAD (belt -> machine). The command layer reuses the
    /// Phase-10 dock geometry check (Out/In role + `port_world` adjacency +
    /// facing-opposite) and freezes the resolved `EditOp::Dock`. Discriminant 4
    /// after the 17-02 `Wire` removal (`Place`/`Delete`/`Rotate`/`DrawBelt` at
    /// 0/1/2/3); dense `u64` handles ride as `number` on the wire.
    Dock {
        /// The belt render handle to dock.
        #[ts(type = "number")]
        belt: u64,
        /// Which belt end docks (implies the direction with the port role).
        endpoint: BeltEnd,
        /// The machine node render handle.
        #[ts(type = "number")]
        node: u64,
        /// The machine port index to dock to.
        port: u16,
    },
    /// Undo the last still-live action group (UNDO-02). A FIELDLESS, single-step
    /// command (Q4.3 — no `UndoTo(action_id)`): the command layer resolves the
    /// target from its linear undo cursor (Q1.1 linear history). This command is
    /// NEVER stored and NEVER replayed (Q4.2, ELOG-02): `GridSession::apply` routes
    /// it to `undo()`, which appends the frozen compensating records (a lineage
    /// marker + the retargeted inverses) to the append-only edit-log — the only
    /// thing persisted. Appended after `Dock` (append-only — all prior variants
    /// unchanged); fieldless, so it adds no wire bytes to the existing commands.
    Undo,
    /// Redo the next undone action group (the mirror of [`Undo`](GridCommand::Undo);
    /// linear history, Q1.1). Also fieldless, also never stored/replayed: `apply`
    /// routes it to `redo()`, which appends a `Redo` marker + the re-applied
    /// (xlate-retargeted) original records. Appended after `Undo` (append-only).
    Redo,
    /// Add a design-time port to a placed machine (PORT-06/07). Discriminant 7 —
    /// **appended LAST after `Redo`** (byte-additive: every prior variant's postcard
    /// discriminant is unchanged, so `golden_gridcommand.rs` stays byte-identical and
    /// the cmd-wire version stays 3 — this is the SOLE serialized-wire touch of Phase
    /// 36, forcing NO version bump, exactly like the `Undo`/`Redo` appends above).
    ///
    /// Carries ONLY `role`/`side`/`medium` (as the render-packet wire bytes: `role`
    /// In=0/Out=1/Fault=2, `side` N=0/E=1/S=2/W=3, `medium` Mechanical=0/Electrical=1)
    /// — NOT the port's `local_offset`. The command layer builds a
    /// `Port { local_offset: default, .. }` and the fold's `grow_to_fit`/`reseat_ports`
    /// RE-SEAT it deterministically as a pure function of its list position, so a
    /// carried offset would be redundant (and immediately overwritten). `medium =
    /// Electrical` is how the first design-time `Medium::Electrical` port is produced
    /// (PORT-06). `node` rides as a dense `u64` render handle (`number` on the wire).
    AddPort {
        /// The machine node the port is added to (a dense `u64` render handle).
        #[ts(type = "number")]
        node: u64,
        /// Port role wire byte: `In=0`, `Out=1`, `Fault=2` (mirrors `port_role`).
        role: u8,
        /// Port facing-side wire byte: `N=0`, `E=1`, `S=2`, `W=3` (re-seated by the
        /// fold from the role, so carried only for shape completeness).
        side: u8,
        /// Port transport-medium wire byte: `Mechanical=0`, `Electrical=1` (PORT-06).
        medium: u8,
    },
    /// Remove a design-time port from a placed machine by index (PORT-07). Discriminant
    /// 8 — **appended LAST after `AddPort`** (byte-additive; same append-only
    /// discipline: no prior discriminant shifts, `golden_gridcommand.rs` stays
    /// byte-green, cmd-wire version stays 3). Carries only fixed-size scalars → NO new
    /// unbounded wire surface. The command layer floors the shrunk footprint to the
    /// machine's frozen per-kind base (never shrinks an operator below it — FOOT-05).
    RemovePort {
        /// The machine node the port is removed from (a dense `u64` render handle).
        #[ts(type = "number")]
        node: u64,
        /// The 0-based index (into the node's rot-0 port list) of the port to remove.
        index: u16,
    },
    /// Configure a machine's behavior (CFG-01/CFG-02). Discriminant 9 — **appended
    /// LAST after `RemovePort`** (byte-additive: every prior discriminant is unchanged,
    /// so `golden_gridcommand`/`gridcommand.bin` stays byte-identical and the cmd-wire
    /// `EVENT_VERSION` stays 3 — the exact `AddPort`/`RemovePort` append discipline).
    ///
    /// # NO `code_hash` on the wire (the blake3 fence)
    /// This transient wire command carries the machine [`config`](GridCommand::Configure::config)
    /// but NEVER the blake3 `code_hash`: the command layer resolves the handle and
    /// freezes `EditOp::Configure { code_hash: [0u8; 32] }`, and the HOST (Phase 39-04)
    /// stamps the real blake3 of the exact Factory JS bytes. The command/protocol layers
    /// are blake3-fenced and never compute it.
    ///
    /// # Load-bearing wire shape (the cross-language byte contract)
    /// [`MachineConfig`] (and its nested [`SourceTrigger`]/[`SinkTemplate`]/[`HttpMethod`])
    /// is a protocol-local TS-derived wire mirror whose variant order matches
    /// `fabrico_core::edit::MachineConfig` / `fabrico_core::state::SinkTemplate` EXACTLY
    /// (Factory=0/Source=1/Sink=2/Belt=3/Router=4/Endpoint=5/Label=6; Webhook=0/Timer=1;
    /// Debug=0/Http=1; Get=0/Post=1/Put=2/Patch=3/Delete=4). The command
    /// validator converts this wire shape into the byte-identical core shape; the frozen
    /// `configure-gridcommand.bin` fixture pins the exact bytes the 39-05 TS encoder
    /// must reproduce.
    ///
    /// This discriminant list is one fact written in two places — here and in the
    /// [`MachineConfig`] enum's own header — and both go stale together. Since Phase 63
    /// `crates/fabrico-command/tests/machine_config_parity.rs` is the machine that
    /// checks the claim, so appending to one enum and not the other is a named test
    /// failure rather than a byte-level surprise later.
    Configure {
        /// The machine node this configuration targets (a dense `u64` render handle).
        #[ts(type = "number")]
        node: u64,
        /// The complete CFG-01 machine configuration (Factory/Source/Sink).
        config: MachineConfig,
    },
    /// Draw a request/response WIRE from a declared OUTPUT port to a declared INPUT
    /// port (WIRE-01/WIRE-02). Discriminant 10 - **appended LAST after `Configure`**
    /// (byte-additive: every prior variant's postcard discriminant is unchanged, so
    /// `gridcommand.bin` and `configure-gridcommand.bin` stay byte-identical and the
    /// cmd-wire `EVENT_VERSION` does NOT move - the exact `AddPort`/`RemovePort`/
    /// `Configure` append discipline). Carries only fixed-size scalars, so it adds NO
    /// new unbounded wire surface.
    ///
    /// # The command layer is the ONE endpoint-legality gate
    /// `validate_normalize` resolves both handles, refuses a self-loop, requires
    /// `Role::Out` on the source side and `Role::In` on the target side, applies the
    /// SHARED `mediums_compatible` predicate the `Dock` arm already calls (one rule,
    /// both directions), and refuses an already-linked output port. Only then does it
    /// freeze `EditOp::DrawWire`. The core fold NEVER re-validates (decision Q2), so a
    /// forged log record is a panic-free no-op rather than a second rejection site.
    ///
    /// Before Phase 63 a wire could only be minted from Rust through the core
    /// `add_wire` seam: `GridCommand` had no `DrawWire`, so the wire tool had no way
    /// onto the command wire at all.
    DrawWire {
        /// The node the wire originates from (a dense `u64` render handle). Its
        /// `from_port` must be a declared `Role::Out` `Medium::Electrical` port.
        #[ts(type = "number")]
        from_node: u64,
        /// The 0-based output port index on `from_node`.
        from_port: u16,
        /// The node the wire terminates at (a dense `u64` render handle). Its
        /// `to_port` must be a declared `Role::In` `Medium::Electrical` port.
        #[ts(type = "number")]
        to_node: u64,
        /// The 0-based input port index on `to_node`.
        to_port: u16,
    },
    /// Remove a single directed dock link — the explicit DISCONNECT verb
    /// (CONNECT-01). Discriminant 11 — **appended LAST after `DrawWire`**
    /// (byte-additive: every prior variant's postcard discriminant is unchanged, so
    /// `gridcommand.bin` and `configure-gridcommand.bin` stay byte-identical and the
    /// cmd-wire `EVENT_VERSION` does NOT move — the exact `AddPort`/`RemovePort`/
    /// `Configure`/`DrawWire` append discipline). Carries only fixed-size scalars, so
    /// it adds NO new unbounded wire surface.
    ///
    /// # Why `Unlink` and not `Disconnect`
    /// It maps one-to-one onto the existing `fabrico_core::edit::EditOp::Unlink`,
    /// which `fold_unlink` has applied since Phase 12. A second name for one operation
    /// is how two vocabularies for one concept start, and this codebase pays for that
    /// every time a reader has to hold both.
    ///
    /// # The field set is `Dock`'s, exactly
    /// An unlink and the dock that created it name the SAME link from the SAME side,
    /// so a different field set would make the two impossible to pair. Before Phase 63
    /// `EditOp::Unlink` was reachable only from inside the undo driver, as a `Dock`'s
    /// computed inverse: no `GridCommand` mapped to it and `validate_normalize` had no
    /// arm for it.
    ///
    /// # `port` is a CATALOG index, translated at validate time
    /// Like [`Dock`](GridCommand::Dock), this carries the machine port's SPATIAL
    /// catalog index and the command layer translates it into the link keyspace
    /// `fold_dock` wrote (`Role::Out` → its 0-based position among the node's Out
    /// ports; `Role::Fault` → the reserved `FAULT_PORT` sentinel; `Role::In` →
    /// unchanged). The two keyspaces genuinely collide — a ROUTER's In has catalog
    /// index 0 and its Out has routing key 0 — so the arm applies `Dock`'s direction
    /// rule (`Head` → `In`, `Tail` → `Out`/`Fault`) rather than carrying an ambiguous
    /// index through.
    Unlink {
        /// The belt render handle whose dock link is being removed.
        #[ts(type = "number")]
        belt: u64,
        /// Which belt end the original dock attached (implies the directed key to
        /// remove: a `Head` unlink removes the belt-keyed entry, a `Tail` unlink the
        /// machine-keyed one).
        endpoint: BeltEnd,
        /// The machine node render handle the original dock referenced.
        #[ts(type = "number")]
        node: u64,
        /// The machine port's SPATIAL catalog index (translated to the link key at
        /// validate time, exactly as `Dock` translates it).
        port: u16,
    },
}

/// The COMPLETE CFG-01 machine-configuration surface a [`GridCommand::Configure`]
/// carries on the wire — a **protocol-local TS-derived mirror** of
/// `fabrico_core::edit::MachineConfig` (the A3 wire-DTO-owner discipline: the core
/// type is deliberately NOT `TS`-derived, so the protocol owns the exported wire
/// shape). The command validator ([`fabrico-command`]) converts this into the
/// byte-identical core `MachineConfig` before freezing an `EditOp::Configure`.
///
/// # Wire-format discipline (variant ordering is LOAD-BEARING)
/// postcard encodes an enum by its variant **discriminant** (declaration index),
/// which MUST match `fabrico_core::edit::MachineConfig` EXACTLY:
/// `Factory = 0`, `Source = 1`, `Sink = 2`, `Belt = 3`, `Router = 4`, `Endpoint = 5`,
/// `Label = 6`.
/// The 39-05 TS encoder mirrors this order; the frozen `configure-gridcommand.bin`
/// fixture is the byte anchor.
///
/// This list is hand-maintained PROSE, and so is its copy in
/// [`GridCommand::Configure`]'s doc. Until Phase 63 nothing checked either of them —
/// not even for the three original variants. `crates/fabrico-command/tests/machine_config_parity.rs`
/// is now the machine that holds the two enums together: it encodes an equivalent value
/// on each side of all SEVEN variants and asserts byte equality plus the leading
/// discriminant byte. Append a variant to one enum and not the other and that test
/// fails, by name.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub enum MachineConfig {
    /// A Factory machine's authored JS (CFG-02) — the EXACT user source bytes the
    /// sandbox runs, carried verbatim (no reformatting). Discriminant 0.
    Factory {
        /// The EXACT authored JS source bytes (CFG-02 — no reformatting).
        source: String,
    },
    /// A Source machine's trigger configuration (CFG-01 webhook/timer). Discriminant 1.
    Source {
        /// How the source fires (webhook or timer).
        trigger: SourceTrigger,
    },
    /// A Sink machine's effect target (CFG-01). Discriminant 2.
    Sink {
        /// The effect target this sink stamps onto each consumed item.
        target: SinkTemplate,
    },
    /// A belt's own advance interval in sim TICKS per slot (BELT-02). Discriminant 3.
    ///
    /// # Why this carries a plain `u32` while the core carries `NonZeroU32`
    /// The [`BeltView::ticks_per_slot`] precedent above states the rule: "The core holds
    /// this as `NonZeroU32`; the host writes `.get()` because this crate's wire grammar
    /// permits plain integers only." The asymmetry is a DECISION, not an oversight —
    /// the invariant lives in the core type, and `fabrico-command` refuses a wire-side
    /// zero with a typed error rather than converting it into an invented speed.
    ///
    /// postcard encodes `NonZeroU32` exactly as its inner `u32`, so the mirror stays
    /// byte-compatible with the core variant. That is not assumed: it is asserted by
    /// `crates/fabrico-command/tests/machine_config_parity.rs`, which encodes both sides
    /// of all five variants and compares the bytes.
    Belt {
        /// Sim ticks between one slot advance for the target belt (larger is slower).
        /// Zero is refused at the command layer; the core type makes it unrepresentable.
        ticks_per_slot: u32,
    },
    /// A router's ordered routing table and its default ("else") output port
    /// (ROUTE-03). Discriminant 4.
    ///
    /// `routes` is ORDERED and the FIRST matching rule wins, so the sequence the user
    /// authored is the sequence the router applies — the wire must not sort or dedupe it.
    /// An empty table with `default: None` is legal and means every item goes to the
    /// fault port.
    Router {
        /// The ordered match table: each rule pairs a [`RouteKey`] with the output port
        /// it selects.
        routes: Vec<(RouteKey, u16)>,
        /// The default ("else") output port; `None` routes a no-match to the fault port.
        default: Option<u16>,
    },
    /// A Route's URL path (SERVE-08). Discriminant 5, appended STRICTLY LAST after
    /// `Router` so no already-encoded byte moves and `EDIT_SCHEMA_VERSION` stays 7.
    ///
    /// The stored value INCLUDES its leading `/`. A Route whose path is `/orders`
    /// answers at `http://127.0.0.1:PORT/endpoint/orders`: the `/endpoint/` prefix is a
    /// HOST route prefix that D-12a deliberately keeps, not a leftover of the Phase-72
    /// rename, so the word "endpoint" stays on screen inside a copyable URL.
    Endpoint {
        /// The URL path this Route answers at, INCLUDING its leading `/`. The command
        /// layer refuses one that is empty, slashless, over
        /// `fabrico_core::edit::MAX_ENDPOINT_PATH_BYTES`, carrying a byte outside the
        /// unreserved URL-path set, or already owned by another Route.
        path: String,
    },
    /// A label's words, colour and size (phase 76, plan 76-02, D-02, D-04).
    /// Discriminant 6, appended STRICTLY LAST after `Endpoint`, so no already-encoded
    /// byte moves and `EDIT_SCHEMA_VERSION` stays 11.
    ///
    /// `colour` is a plain `u8` where the core carries the closed `LabelColour` enum: the
    /// `Belt` asymmetry again, and for the same reason. postcard encodes a fieldless enum
    /// by its declaration index, so the two sides are byte-identical for colours 0 to 5
    /// (`machine_config_parity.rs` checks all six), and `fabrico-command`'s
    /// `wire_config_to_core` is the CLOSED-SET CHECK that refuses a byte above 5 as
    /// `Malformed` rather than inventing a colour.
    Label {
        /// The words, verbatim. Refused over `fabrico_core::edit::MAX_LABEL_BYTES`.
        text: String,
        /// The `LabelColour` byte, `0..=5`.
        colour: u8,
        /// Width in cells (grows right from the anchor), `1..=LABEL_MAX_W` at the write
        /// gate.
        w: u16,
        /// Depth in cells (grows down from the anchor), `1..=LABEL_MAX_H` at the write
        /// gate.
        h: u16,
    },
}

/// One routing rule on the wire — the protocol-local TS-derived mirror of
/// `fabrico_core::state::RouteKey`, which is deliberately NOT `TS`-derived (the A3
/// wire-DTO-owner discipline: the protocol owns every exported wire shape).
///
/// A rule matches when the inbound item's bytes at `[offset .. offset+expect.len()]`
/// equal `expect`. The field ORDER matches the core struct exactly, because postcard
/// encodes a struct positionally and the two are compared byte for byte by
/// `crates/fabrico-command/tests/machine_config_parity.rs`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct RouteKey {
    /// Byte offset into the item at which to compare.
    pub offset: u16,
    /// The expected bytes at `[offset .. offset+expect.len()]`.
    pub expect: Vec<u8>,
}

/// How a Source machine fires (CFG-01) — the protocol-local wire mirror of
/// `fabrico_core::edit::SourceTrigger`.
///
/// # Wire-format discipline (variant ordering is LOAD-BEARING)
/// `Webhook = 0`, `Timer = 1` — must match the core enum EXACTLY.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub enum SourceTrigger {
    /// Fire on an inbound webhook (CFG-01). Discriminant 0, fieldless.
    Webhook,
    /// Fire every `interval_ticks` on a deterministic logical timer (CFG-01).
    /// Discriminant 1.
    Timer {
        /// The fixed logical-tick interval between fires.
        #[ts(type = "number")]
        interval_ticks: u64,
    },
}

/// A Sink machine's effect target on the wire (CFG-01) — the protocol-local mirror of
/// `fabrico_core::state::SinkTemplate`. Carries routing INTENT only; no secrets ride
/// here (auth lives host-side).
///
/// # Wire-format discipline (variant ordering is LOAD-BEARING)
/// `Debug = 0`, `Http = 1` — must match the core enum EXACTLY. Phase 85 (D-08,
/// CHROME-04) deleted the Email target that sat at 1, with no placeholder, in lockstep
/// with the core enum and its SNAPSHOT and EDIT bumps.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub enum SinkTemplate {
    /// Emit a debug effect carrying the item bytes (the I/O-free sink). Discriminant 0.
    Debug,
    /// Emit an HTTP request to `url` with `method`. Discriminant 1.
    Http {
        /// Target URL (routing intent, not a secret).
        url: String,
        /// The HTTP verb to dispatch with (default POST).
        method: HttpMethod,
    },
}

/// The HTTP verb an [`SinkTemplate::Http`] dispatches with (CFG-01) — the
/// protocol-local mirror of `fabrico_core::state::HttpMethod`.
///
/// # Wire-format discipline (variant ordering is LOAD-BEARING)
/// `Get = 0`, `Post = 1`, `Put = 2`, `Patch = 3`, `Delete = 4` — must match the core
/// enum EXACTLY (POST is the core default; the wire always carries an explicit verb).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub enum HttpMethod {
    /// HTTP GET. Discriminant 0.
    Get,
    /// HTTP POST — the default webhook verb. Discriminant 1.
    Post,
    /// HTTP PUT. Discriminant 2.
    Put,
    /// HTTP PATCH. Discriminant 3.
    Patch,
    /// HTTP DELETE. Discriminant 4.
    Delete,
}
