//! The ONE canonical sim-loop body.
//!
//! Three per-tick loop bodies — the Tauri shell's `run_sim_thread`
//! (`fabrico-app/src/lib.rs`), the dev render server's inline loop
//! (`examples/dev_render_server.rs`), and `driver::run` — each re-derived the
//! same `drain -> tick_once -> on_tick -> pace` sequence around the identical
//! `Host::tick_once` fold. This module collapses them into ONE owning
//! [`SimLoop`] struct that holds the `!Send` [`Host`] + [`RenderProducer`] +
//! internal channels on one thread, exposes the canonical per-tick [`SimLoop::step`]
//! and a paced [`SimLoop::run`], plus four present-but-inert seams:
//!
//! | Seam | Type | Fed this phase by | Wired by |
//! |------|------|-------------------|----------|
//! | render producer | owned [`RenderProducer`] + [`SimLoop::subscribe`] | both entrypoints (live now) | — |
//! | webhook ingress | `Option<UnboundedReceiver<Ingress>>` | tests (`Some`); shell/dev pass `None` | Phase 18 |
//! | control | `Option<UnboundedReceiver<ControlMsg>>` (drained-and-ignored) | nobody (inert) | Phase 18 |
//! | dev pre-tick | `Option<PreTick>` demo-injection hook | dev server only | — |
//!
//! This module touches NO core sim math, no `tick_once`/`on_tick` internals, and
//! no render-packet schema — it is pure host wiring (HOST-01).

use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Duration;

use fabrico_core::command::{Command, Effect, Outcome, ResultEvent};
use fabrico_core::core::Core;
use fabrico_core::edit::{MachineConfig, SourceTrigger};
use fabrico_core::event::{EventPayload, LogHeader, SCHEMA_VERSION};
use fabrico_core::factory::FactoryRuntime;
use fabrico_core::ids::{Item, NodeId};
use fabrico_core::persist::{RedbStore, StoreError};
use fabrico_core::state::Node;
use slotmap::Key;
use fabrico_protocol::GridCommand;
use tokio::sync::mpsc::error::SendError;
use tokio::sync::mpsc::{Receiver, UnboundedReceiver, UnboundedSender, unbounded_channel};
use tokio::sync::oneshot;
use tokio::sync::{Notify, broadcast, watch};

use crate::command_error_view::CommandErrorView;
use crate::config::HostConfig;
use crate::gesture_verdict::VerdictSink;
use crate::demo_scene::{SceneId, boot_scene, timers_from_log};
use crate::driver::Host;
use crate::executor::dispatch;
use crate::ingress::endpoint::{EndpointIngress, HttpResponse, descriptor_to_response};
use crate::ingress::seen_set::SeenSet;
use crate::ingress::webhook::Ingress;
use crate::registry::Registry;
use crate::ingress::timer::{TimerSet, project_timers};
use crate::input_apply::apply_gesture_frame;
use crate::ledger::DispatchLedger;
use crate::project::{load_project, save_project};
use crate::render_packet::{RenderFrame, RenderProducer, Resolved};
use fabrico_command::CommandError;

/// Real-time pacing — ~62.5 t/s, the exact cadence both live loops use today
/// (`fabrico-app/src/lib.rs`, `examples/dev_render_server.rs`). MUST stay 16ms.
pub const TICK_PAUSE: Duration = Duration::from_millis(16);

/// A loop-control message serviced at the TICK BOUNDARY on the sim thread
/// ([`SimLoop::service_control`]). `#[non_exhaustive]`.
///
/// - [`Pause`](ControlMsg::Pause) — begin the DRAIN-TO-QUIESCENCE-THEN-FREEZE:
///   hold new upstream input — AND timer ingress (`Host::set_timers_gated`,
///   Finding 3: a timer re-feeding the belts every tick would make quiescence
///   unreachable) — but keep ticking to drain in-flight belt items + executor
///   effects, then freeze once settled (or the max-settle budget is spent).
///   "Paused" always means settled + frozen (CONTEXT Area 1).
/// - [`Resume`](ControlMsg::Resume) — return to Playing, wake the gated
///   executor, and apply any input buffered while draining.
/// - [`Step`](ControlMsg::Step) — advance exactly one input-applying
///   `acquire_input()` + `tick_body()` from a frozen state and stay frozen; the
///   IDENTICAL pair the live path runs, so `step×N` == `live×N` (HOST-03).
/// - [`Save`](ControlMsg::Save) — persist the project to a chosen path at
///   QUIESCENCE via the hardened `save_project` (HOST-04). If the sim is not yet
///   settled the Save is LATCHED and runs once the drain reaches Frozen, and the
///   sim then plays on unless the user's own Pause or Step held it (D-08).
/// - [`Load`](ControlMsg::Load) — swap the `!Send` Host (built by the hardened
///   `load_project`) on the sim thread, RESET the producer (never dark), and
///   re-seed the loop tick from the loaded core (HOST-05 + IN-01).
/// - [`LoadDemo`](ControlMsg::LoadDemo) — swap in THE command-built default
///   demo scene (seeded via the certified gesture path, demo timers installed)
///   through the same host-swap path (LIVE-03).
/// - [`LoadScene`](ControlMsg::LoadScene) — the parameterized scene-select
///   control (EX-02): swap in ANY shipped build-embedded scene by typed
///   [`SceneId`], through the identical host-swap path. `LoadDemo` is the
///   wire-compatible legacy verb routing to `LoadScene(SceneId::Demo)`.
#[non_exhaustive]
pub enum ControlMsg {
    /// Drain to quiescence then freeze (HOST-02).
    Pause,
    /// Resume live ticking and wake the executor.
    Resume,
    /// One input-applying advance from frozen, staying frozen (HOST-03).
    Step,
    /// Save the project to a chosen path at quiescence (HOST-04).
    Save(PathBuf),
    /// Load a project file: swap the Host + reset the producer + re-seed the
    /// tick, all on the sim thread (HOST-05).
    Load(PathBuf),
    /// Load THE command-built default demo scene through the host-swap path
    /// (LIVE-03: the legacy wire verb; handled as `LoadScene(SceneId::Demo)`).
    LoadDemo,
    /// Load a shipped build-embedded scene by typed [`SceneId`] (EX-02): the
    /// dev-WS `load_example\n<id>` verb and the Tauri `load_example(scene_id)`
    /// command both land here AFTER parsing through [`SceneId::parse`] — an
    /// unknown id is a typed error at each decode boundary and never reaches
    /// this variant (T-55-04). Same swap-safety latch as [`LoadDemo`](ControlMsg::LoadDemo).
    LoadScene(SceneId),
    /// Swap in a truly EMPTY genesis board (SAVE-04: the toolbar "New" CTA). Same
    /// host-swap path as [`LoadDemo`](ControlMsg::LoadDemo) but seeds NOTHING — a
    /// 0-node board. Never postcard-serialized (a live host verb only).
    New,
    /// Read a node's CURRENT config (CFG-01/03), serviced at the tick boundary and
    /// answered over the `reply` oneshot — NEVER a lock on the `!Send` Core. `node`
    /// is the dense render handle the frontend holds; the sim thread resolves it to a
    /// [`NodeId`] and reads `core.state` (Factory `source` / Sink `template`) MERGED,
    /// for a Source, with the host Timer projection (the trigger is NOT a snapshot
    /// field). `None` for an unmapped handle or a non-configurable node.
    QueryConfig {
        /// The dense render handle of the node to read.
        node: u64,
        /// The tick-boundary reply channel.
        reply: oneshot::Sender<Option<MachineConfig>>,
    },
    /// Which SHIPPED scene the board currently holds, or `None` for a user board
    /// (a `New` swap, or a `Load` of a `.fab`). Serviced at the tick boundary over
    /// the same oneshot seam as [`QueryConfig`](ControlMsg::QueryConfig).
    ///
    /// WR-03: the scene badge used to be LOCAL optimistic frontend state derived
    /// from the click, while the host is a long-lived process whose scene survives
    /// a webview reload. Reloading the page after loading `order_processing` made
    /// the toolbar read "Demo scene" over an order-processing board. This is the
    /// authoritative answer the frontend re-derives the badge from on mount.
    QueryScene {
        /// The tick-boundary reply channel.
        reply: oneshot::Sender<Option<SceneId>>,
    },
    /// Resolve a Source node's copyable loopback webhook URL (CFG-03). `node` is the
    /// dense render handle; `addr` is the bound webhook [`SocketAddr`] threaded in
    /// from `AppState` (the simpler seam than storing it on the loop). The sim thread
    /// resolves the handle to a [`NodeId`], and — for a Source only — replies with
    /// `http://127.0.0.1:PORT/hook/src-<as_ffi>`. `None` for a non-Source / unmapped
    /// handle.
    QueryWebhookUrl {
        /// The dense render handle of the node to describe.
        node: u64,
        /// The bound webhook socket address (its port fills the URL).
        addr: SocketAddr,
        /// The tick-boundary reply channel.
        reply: oneshot::Sender<Option<String>>,
    },
    /// Pre-check Factory JS by COMPILING it via [`FactoryRuntime::build`] (CFG-02),
    /// WITHOUT committing a Configure — the frontend gates Apply on `Ok` so bad JS is
    /// never enqueued (T-39-BAD-JS-COMMIT). Replies `Ok(())` if the source compiles,
    /// or `Err(message)` with the build error. Enqueues NOTHING either way.
    ValidateFactoryJs {
        /// The candidate Factory JS source to compile-check.
        source: String,
        /// The tick-boundary reply channel.
        reply: oneshot::Sender<Result<(), String>>,
    },
}

/// The sim-thread run model (CONTEXT Area 1). Drives [`SimLoop::step`]'s gate.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RunState {
    /// Live: every `step()` runs `acquire_input()` then `tick_body()`.
    Playing,
    /// Draining-to-quiescence: new input HELD (`acquire_input()` SKIPPED) and
    /// timer ingress HELD (`tick_body` gates `Host::set_timers_gated` in this
    /// state ONLY — Finding 3), but `tick_body()` keeps running so in-flight
    /// belt items + executor effects drain; transitions to
    /// [`Frozen`](RunState::Frozen) once
    /// `in_flight_len()==0 && belt_items_in_flight()==0`, or the bounded
    /// max-settle-tick budget is exhausted.
    Draining,
    /// Settled + frozen: `step()` is a no-op (no input, no tick). The executor
    /// gate (`paused`) is `true` only in this state.
    Frozen,
}

/// A host-swap LATCHED while the sim was still non-quiescent (WR-02). Like a
/// [`SimLoop::pending_save`], it is performed the instant the drain reaches
/// [`RunState::Frozen`], so no stray OLD-scene executor effect can cross into the
/// loaded host. Carries WHICH swap to perform.
enum PendingLoad {
    /// A [`ControlMsg::Load`] of a `.fab` at `path`.
    File(PathBuf),
    /// A [`ControlMsg::LoadDemo`] / [`ControlMsg::LoadScene`] command-built
    /// scene swap, parameterized by the typed [`SceneId`] (Phase 55 clean
    /// break: the old `Demo` variant IS `Scene(SceneId::Demo)`).
    Scene(SceneId),
    /// A [`ControlMsg::New`] blank genesis-empty-board swap (SAVE-04).
    New,
}

/// The fixed genesis seed for a blank `New` board (SAVE-04). Mirrors the
/// [`DEMO_GENESIS_SEED`](crate::demo_scene::DEMO_GENESIS_SEED) discipline: a
/// determinism-critical FIXED literal, NEVER derived from wall-clock or entropy,
/// so the same New always produces the identical (empty) genesis Core on every
/// replay. Distinct from the demo seed only for clarity; the board is 0-node
/// either way.
const NEW_GENESIS_SEED: u64 = 0;

/// The bound on the drain-to-quiescence settle: a hung / never-resolving
/// executor effect (or a permanently-stuck belt) cannot make Pause spin forever
/// — after this many Draining ticks the loop freezes regardless. At the ~62.5
/// t/s live cadence this is a few seconds of settle headroom; `save_project`'s
/// `in_flight_len() != 0` refusal is the persistence-side backstop.
pub const MAX_SETTLE_TICKS: u64 = 512;

/// The reason the dev fault seam ([`SimLoop::with_dev_fault`]) returns, inside
/// `StoreError::Backend`. The fatal sentence a page shows for it is therefore
/// `sim loop terminated with a fatal store error: persistence backend error:
/// dev fault injected by dev_render_server` (phase 90, research Finding L).
pub const DEV_FAULT_REASON: &str = "dev fault injected by dev_render_server";

/// The load-refusal sentence when a Load cannot create the work folder its store lives in
/// (phase 90 review, the deferred plan 90-04 item). Held to the card's house voice like every
/// `ProjectError` sentence (`project_error_copy.rs`), and it names no path.
pub const LOAD_WORK_DIR_REFUSAL: &str =
    "project file not opened: a working folder for it could not be created.";

/// The load-refusal sentence when a Load cannot read the timers from the opened file's edit
/// log (phase 90 review, the deferred plan 90-04 item). Names no path.
pub const LOAD_TIMERS_REFUSAL: &str =
    "project file not opened: the timers in its edit log could not be read.";

pub use fabrico_engine::envelope::DEFAULT_ENDPOINT_DEADLINE_TICKS;

/// One gesture crossing the render->sim boundary, plus the OPTIONAL verdict sink the
/// drain answers it through.
///
/// `verdict: None` is the fire-and-forget case: every in-process construction (tests, the
/// demo seeder, [`GestureSink::send_gesture`]) takes it, nothing is answered for them, and
/// that is not an error. `Some` is a real user gesture from either transport, built by
/// `transport_ws::wire_envelope`, and the drain in [`acquire_input`](SimLoop::acquire_input)
/// answers it exactly once (phase 88, D-06): a refusal at once, an accept after the tick that
/// folded it (naming the handles it minted), or a discard if a board swap drops it first.
///
/// The answer carries [`CommandErrorView`], the wire view, NOT the headless
/// `CommandError`: the conversion happens ONCE at the drain, so both transports handle
/// the same shape and `fabrico-app` never has to name a type it cannot reach without a
/// new dependency edge.
pub struct GestureEnvelope {
    /// The gesture itself, moved into `apply_gesture_frame` on the sim thread.
    pub cmd: GestureFrame,
    /// The board generation of the render packet the client read this gesture's handles
    /// from, off the frame header (phase 88, D-02). `Some` for every gesture a transport
    /// decoded (`transport_ws::wire_envelope`); `None` only for an in-process sender (a test,
    /// the demo seeder, [`GestureSink::send_gesture`]), which names handles in the CURRENT
    /// table.
    pub generation: Option<u64>,
    /// Where the verdict goes, or `None` for a fire-and-forget gesture.
    pub verdict: Option<VerdictSink>,
}

/// An ACCEPTED gesture waiting for the tick that folds it (phase 88, D-06). Its records sit in
/// `Host::pending_edits` at minting positions `first..first + count` (a minting record is a
/// `Place`, `DrawBelt` or `DrawWire`), and after the fold those positions are the same
/// positions in `core.last_tick.placed`, which is 1:1 with them in fold order. An entry is
/// kept for a fire-and-forget gesture too (`sink: None`), so the positions of the ones after
/// it stay right.
struct PendingAccept {
    sink: Option<VerdictSink>,
    first: usize,
    count: usize,
}

/// How many of `edits` mint a node, belt or wire: the records `core.last_tick.placed` lists
/// one id for, in order (`fabrico_core::core::TickObservation`, the W1 contract). The list of
/// minting folds is hand-maintained there; if it grows without this, the accepts flushed
/// after a tick see a count mismatch and answer with an empty `minted` list rather than
/// pairing a gesture with another gesture's handle.
fn minting_records(edits: &[fabrico_core::edit::EditRecord]) -> usize {
    use fabrico_core::edit::EditOp;
    edits
        .iter()
        .filter(|r| matches!(r.op, EditOp::Place { .. } | EditOp::DrawBelt { .. } | EditOp::DrawWire { .. }))
        .count()
}

/// The postcard body of a BELT-RUN PACE frame (D-68-16, route R1): the belts a
/// single Apply writes to, and the interval every one of them takes.
///
/// The frontend mirror is `encodeBeltRunPace` in `frontend/src/protocol/decode.ts`.
/// Field order is LOAD-BEARING: postcard encodes a struct POSITIONALLY, so the two
/// declarations are one wire format written twice and neither may move alone.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct BeltRunPace {
    /// The dense `u64` render handles of every belt in the run, in flow order.
    pub belts: Vec<u64>,
    /// The advance interval, in sim ticks per slot, to write to ALL of them.
    /// Carried as a plain `u32` exactly as `MachineConfig::Belt` does; a zero is
    /// refused by `validate_normalize` with `CommandError::ZeroBeltInterval`
    /// rather than defaulted into an invented speed.
    pub ticks_per_slot: u32,
}

/// The RUN-PACE frame lead byte (D-68-16, route R1). ONE RAW BYTE, 254.
///
/// The frontend mirror is `BELT_RUN_PACE_LEAD` in `frontend/src/protocol/decode.ts`,
/// which writes it with `w.u8`, never `w.varintU` (`varintU(0xFE)` is TWO bytes and
/// would put a stray `0x01` in front of the body).
pub const BELT_RUN_PACE_LEAD: u8 = 0xFE;

/// The most belts ONE run-pace frame may name.
///
/// The handle list is the first VARIABLE-LENGTH payload on the gesture channel that
/// is not already bounded by a core constant, and in the dev build that channel is a
/// local WebSocket any process on the machine can write to. A forged count is
/// therefore refused as a TYPED ERROR before any per-belt work happens, never as an
/// allocation (threat T-68-02-01). `MAX_GESTURE_FRAME` still caps the frame itself,
/// but a 64 KiB frame can declare thousands of handles, so the frame cap alone is
/// not this bound.
///
/// 256 is far above any run a board can hold: a run is a contiguous chain of belt
/// NODES, and `MAX_BELT_TILES` (1024) bounds the TILES of a single belt, so a
/// 256-belt run is already an order of magnitude past anything the shipped
/// traversal produces.
pub const MAX_RUN_PACE_BELTS: usize = 256;

/// ONE decoded frame crossing the render->sim boundary: either a `GridCommand` (every
/// frame the app has ever sent) or the Phase 68 run-pace frame.
///
/// # Why this exists instead of a twelfth `GridCommand` variant
/// `fabrico-protocol` is FROZEN for phases 64-68 and only Phase 63 and Phase 65 were
/// permitted to touch it, so `GridCommand` cannot grow. A belt-run pace edit must
/// nevertheless arrive as ONE frame: the host mints one action id per frame, so N
/// frames would be N `Ctrl+Z` steps (68-UI-SPEC FINDING 2, D-68-16). The run
/// therefore rides a SENTINEL-PREFIXED frame on the same channel, decoded here, and
/// inherits the Phase 64 sequence-numbering and refusal machinery with no new
/// plumbing.
///
/// [`From<GridCommand>`] exists so every construction site that already spells
/// `GestureEnvelope { cmd, .. }` WRAPS rather than changes shape.
#[derive(Clone, Debug, PartialEq)]
pub enum GestureFrame {
    /// An ordinary `GridCommand` frame: byte-identical to what it always was.
    Cmd(GridCommand),
    /// A belt-run pace edit: N belts, ONE interval, ONE action id.
    RunPace(BeltRunPace),
}

impl From<GridCommand> for GestureFrame {
    fn from(cmd: GridCommand) -> Self {
        GestureFrame::Cmd(cmd)
    }
}

/// What a gesture REFUSAL may say about the gesture it refuses (plan 74.1-28, re-walk
/// G1): the command's variant name and, for a command that names exactly one node, that
/// node's dense render handle.
///
/// # Why a refusal names its gesture at all
/// The panel's port-edit latch (`frontend/src/chrome/portEditLatch.ts`) holds
/// `+ Add output` and the Disconnect controls while an `AddPort` / `RemovePort` is in
/// flight, and before this it could not tell which refusal was its own: a refused fourth
/// output left the panel saying "The host has not applied this yet." with every control
/// greyed until an undo. A refusal naming the latched node's port edit is proof that edit
/// will never fold, so the latch releases on it. The sequence number cannot do that job:
/// the frontend does not count its own gestures.
///
/// # Why this discloses nothing new (T-64-05-02, T-74.1-98)
/// `node` is the dense render handle every render packet already carries as
/// `NodeView.id`, and `cmd` is a fixed variant name from a closed set. No path, internal
/// index or host `Display` string rides with them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GestureSubject {
    /// The refused command's variant name (`"AddPort"`, `"RemovePort"`, ...).
    pub cmd: &'static str,
    /// The one node the command names, for `Delete`, `Rotate`, `AddPort`, `RemovePort`
    /// and `Configure`; `None` for a command naming no node or more than one handle.
    pub node: Option<u64>,
}

impl GestureFrame {
    /// The [`GestureSubject`] a refusal of this frame carries. Exhaustive over
    /// `GridCommand` with no wildcard, so a new variant cannot ride a refusal unnamed.
    #[must_use]
    pub fn subject(&self) -> GestureSubject {
        let (cmd, node) = match self {
            GestureFrame::RunPace(_) => ("RunPace", None),
            GestureFrame::Cmd(cmd) => match cmd {
                GridCommand::Place { .. } => ("Place", None),
                GridCommand::Delete { node } => ("Delete", Some(*node)),
                GridCommand::Rotate { node, .. } => ("Rotate", Some(*node)),
                GridCommand::DrawBelt { .. } => ("DrawBelt", None),
                // A dock and an unlink name a belt AND a node; a wire names two nodes.
                // None of them is "one node", so none carries a handle.
                GridCommand::Dock { .. } => ("Dock", None),
                GridCommand::Undo => ("Undo", None),
                GridCommand::Redo => ("Redo", None),
                GridCommand::AddPort { node, .. } => ("AddPort", Some(*node)),
                GridCommand::RemovePort { node, .. } => ("RemovePort", Some(*node)),
                GridCommand::Configure { node, .. } => ("Configure", Some(*node)),
                GridCommand::DrawWire { .. } => ("DrawWire", None),
                GridCommand::Unlink { .. } => ("Unlink", None),
            },
        };
        GestureSubject { cmd, node }
    }

    /// Whether this frame names any render handle, so resolving it needs a handle table
    /// (phase 88 review, IN-03). A Place, a DrawBelt, an Undo and a Redo carry cells or
    /// nothing; every other frame names one handle or more (a Dock, a DrawWire and an Unlink
    /// name two, a run-pace frame a list). Exhaustive with no wildcard, so a new variant must
    /// say which it is.
    #[must_use]
    pub fn names_a_handle(&self) -> bool {
        match self {
            GestureFrame::RunPace(_) => true,
            GestureFrame::Cmd(cmd) => match cmd {
                GridCommand::Place { .. } | GridCommand::DrawBelt { .. } | GridCommand::Undo | GridCommand::Redo => {
                    false
                }
                GridCommand::Delete { .. }
                | GridCommand::Rotate { .. }
                | GridCommand::Dock { .. }
                | GridCommand::AddPort { .. }
                | GridCommand::RemovePort { .. }
                | GridCommand::Configure { .. }
                | GridCommand::DrawWire { .. }
                | GridCommand::Unlink { .. } => true,
            },
        }
    }
}

/// The render->sim gesture sender. Cloned per transport; never bounded, because a
/// blocked gesture send on the UI thread is a frozen interface.
pub type GestureTx = UnboundedSender<GestureEnvelope>;

/// The sim-side gesture receiver, drained at the top of every played tick.
pub type GestureRx = UnboundedReceiver<GestureEnvelope>;

/// The ONE gesture-channel constructor. Every construction site in the workspace calls
/// this, so the channel's item type is named in exactly one place and the other
/// constructions cannot drift from it when the envelope grows a field.
pub fn gesture_channel() -> (GestureTx, GestureRx) {
    unbounded_channel()
}

/// Send a gesture with NO reply attached. Exists so a test or demo-seed call site stays
/// a one-liner instead of spelling the envelope, and so the fire-and-forget case is
/// spelled the same way everywhere it is taken.
pub trait GestureSink {
    /// Enqueue `cmd` with no generation and no verdict sink.
    ///
    /// # Errors
    /// The channel's `SendError` if the sim thread's receiver has been dropped.
    fn send_gesture(&self, cmd: GridCommand) -> Result<(), SendError<GestureEnvelope>>;

    /// Enqueue a whole envelope, as a transport does (phase 88): a test that builds one
    /// with `transport_ws::wire_envelope`, carrying the generation it read, sends it here.
    ///
    /// # Errors
    /// The channel's `SendError` if the sim thread's receiver has been dropped.
    fn send_envelope(&self, env: GestureEnvelope) -> Result<(), SendError<GestureEnvelope>>;
}

impl GestureSink for GestureTx {
    fn send_gesture(&self, cmd: GridCommand) -> Result<(), SendError<GestureEnvelope>> {
        self.send(GestureEnvelope {
            cmd: cmd.into(),
            generation: None,
            verdict: None,
        })
    }

    fn send_envelope(&self, env: GestureEnvelope) -> Result<(), SendError<GestureEnvelope>> {
        self.send(env)
    }
}

/// A caller-supplied pre-tick hook: `(tick, &ingress_tx)`. The dev entrypoint uses
/// it for demo-source injection on a cadence; the shell passes `None`, so no demo
/// behavior ever leaks into production.
pub type PreTick = Box<dyn FnMut(u64, &UnboundedSender<EventPayload>)>;

/// The webhook/endpoint route table as a FOLD-PROJECTION of `core.state`'s
/// routable node set (HOST-07 / ENDP-05 / SERVE-08): `{ "src-<as_ffi>" -> NodeId }` for
/// every [`Node::Source`] AND `{ "<the Route's own path>" -> NodeId }` for every
/// [`Node::Endpoint`], folded into the ONE map. Iterates
/// [`node_ids`](fabrico_core::state::GridState::node_ids) in ascending
/// (deterministic) order. This is the ONLY sanctioned way the route table is built — it
/// is never an imperatively-mutated map; the sim thread recomputes it whenever the
/// routable set changes and swaps the whole immutable `Arc` over the `watch` channel.
///
/// # THE ENDPOINT KEY KEEPS ITS LEADING SLASH, AND THAT IS A SECURITY PROPERTY (72-07)
/// Until SERVE-08 the endpoint key was `ep-<as_ffi>`, and the two namespaces were kept
/// apart by their PREFIXES: `src-` and `ep-` can never collide, which is what let both
/// front doors share one map (Pitfall 4). Both handlers still carry a prefix guard
/// (`hook` refuses a non-`src-` target, `endpoint` refused a non-`ep-` one) as the
/// cross-door check F1 added.
///
/// A USER-TYPED PATH BREAKS THAT ARGUMENT, because `/src-1` is a perfectly legal path
/// under R-47's rules. Stripping the leading slash, as an earlier draft of this change
/// did, would key such a Route as `src-1` and collide it with a real Source in the ONE
/// shared `BTreeMap`, where `collect` silently keeps whichever came later in node order.
/// A `POST /hook/src-1` would then resolve an ENDPOINT, pass the `starts_with("src-")`
/// guard because the guard reads the KEY, and log a ManualInject against a node that
/// cannot take one.
///
/// So the key is NORMALIZED TO EXACTLY ONE LEADING SLASH and keeps it. An endpoint key
/// ALWAYS begins with `/` and a source key NEVER does, so the namespaces are disjoint
/// STRUCTURALLY rather than by a naming convention a user can now write into. The
/// normalization (`trim_start_matches`, not `strip_prefix`) covers a FORGED path too: a
/// hand-edited `.fab` can carry a slashless path because `fold_configure` applies
/// records verbatim and never re-validates, and that forgery must not be able to mint a
/// key in the Source namespace either.
///
/// The DEFAULT path is `/route-N`, minted by `GridState::add_endpoint` as the smallest
/// number no Route on the board holds (phase 91, D-13), so a Route the user has not
/// touched keys as `/route-N` and answers at `POST /endpoint/route-N`. The host derives
/// nothing from the id: the key is always the node's own path.
///
/// # A Source on Timer has no door (DEMO-08, D-20)
/// The map is the set of doors that ACCEPT. A Source whose APPLIED trigger is Timer is fed
/// by the host's own clock, so it is left out: a `POST /hook/src-<id>` to it misses the map
/// and the handler's existing unknown-target branch answers 404 with an empty body, before
/// anything is enqueued, so nothing reaches the event log, the seen-set or the core. The
/// trigger is not a snapshot field (`fold_configure` writes no state bytes for it), so it
/// is read from `timers`, the host's projection of the edit log, never from `core`.
#[must_use]
pub fn project_routes(core: &Core, timers: &TimerSet) -> BTreeMap<String, NodeId> {
    core.state
        .node_ids()
        .filter_map(|id| match core.state.node(id) {
            Some(Node::Source(_)) if timers.interval_for(id).is_none() => {
                Some((format!("src-{}", id.data().as_ffi()), id))
            }
            Some(Node::Source(_)) => None,
            Some(Node::Endpoint(ep)) => Some((endpoint_route_key(&ep.path), id)),
            _ => None,
        })
        .collect()
}

/// The route-map key for a Route holding `path`: exactly one leading `/`, then the rest
/// of the path verbatim.
///
/// ONE function, called by `project_routes` (which publishes the key) and by the
/// `/endpoint` handler (which looks it up), so the two cannot spell it differently. See
/// [`project_routes`] for why the slash is kept rather than stripped.
///
/// The rule itself lives in the core ([`fabrico_core::edit::endpoint_route_key`], phase 91
/// review WR-A-04), because the default-path mint and both producers' duplicate-path reads
/// must compare by the same key this map is built on, and the core cannot import the host.
#[must_use]
pub fn endpoint_route_key(path: &str) -> String {
    fabrico_core::edit::endpoint_route_key(path)
}

/// The cheap ROUTABLE-set FINGERPRINT the recompute guard compares tick-to-tick: the
/// ascending (deterministic) list of every [`Node::Source`] AND every
/// [`Node::Endpoint`], each paired with THE ADDRESS IT ANSWERS AT. Tracking BOTH kinds
/// is THE ENDP-05 lever: a placed/deleted Endpoint flips this fingerprint, so
/// `maybe_republish_routes` (place/delete/undo/redo) and `force_republish_routes` (Load)
/// re-publish endpoint routes with ZERO new hook (Pitfall 4 — a Source-only fingerprint
/// would never fire for endpoints). Recomputing the projection only when THIS changes
/// avoids churning an `Arc` allocation on idle grids (Pitfall 5) and on non-routable
/// gestures (a Rotate, or placing a non-Source/non-Endpoint node).
///
/// # It fingerprints THE ADDRESS, not just the id, and that is 72-07's fix (R-45)
/// Until SERVE-08 this returned a bare `Vec<NodeId>`. A `Configure` that changed ONLY a
/// Route's path therefore flipped NOTHING, and the map was never rebuilt: the user typed
/// a path, pressed Apply, and got a 404 until they placed something unrelated. The
/// membership of the routable set had not changed, but the SET OF ADDRESSES had, and
/// the addresses are what the map is.
///
/// Ruling R-45 named a different mechanism, hooking the path `Configure` fold to
/// `force_republish_routes`. That was considered and this was taken instead, for a
/// reason worth writing down rather than leaving as a diff a reviewer has to reconcile
/// with the plan: a hook fires for the ONE gesture somebody remembered to hook, while
/// this is DERIVED FROM STATE and therefore fires for every way a path can change,
/// including an undo, a redo and a Load. That is the same discipline `project_routes`
/// states about itself one screen up ("never an imperatively-mutated map"), and it means
/// a future path writer cannot forget to republish. The idle-grid cost is unchanged: the
/// walk already visited exactly these nodes, and it now clones one short `String` per
/// Route rather than none.
///
/// # A Source carries its timer interval (DEMO-08, D-20)
/// A Source's address is derived from its id alone, but whether it HAS a door is decided
/// by its trigger ([`project_routes`]). So the Source entry carries its timer interval
/// (`None` on Webhook): a Configure that flips Timer and Webhook, an Undo or a Redo of
/// one, and a Load all change this fingerprint and republish the map with no hook, for
/// the same derived-from-state reason as the Route path above.
fn route_ids(core: &Core, timers: &TimerSet) -> Vec<(NodeId, RouteAddress)> {
    core.state
        .node_ids()
        .filter_map(|id| match core.state.node(id) {
            Some(Node::Source(_)) => Some((
                id,
                RouteAddress::Source {
                    timer_interval: timers.interval_for(id),
                },
            )),
            Some(Node::Endpoint(ep)) => Some((
                id,
                RouteAddress::Endpoint {
                    path: ep.path.clone(),
                },
            )),
            _ => None,
        })
        .collect()
}

/// What a routable node's entry in the [`route_ids`] fingerprint tracks besides its id:
/// everything that decides whether, and where, it answers.
#[derive(Clone, Debug, PartialEq, Eq)]
enum RouteAddress {
    /// A Source answers at `src-<id>` only while it has no timer; `None` is Webhook.
    Source { timer_interval: Option<u64> },
    /// A Route answers at its own path.
    Endpoint { path: String },
}

/// The first endpoint correlation no logged `WireRequest` has used. A loaded or
/// recovered board can still hold a request on a wire under its logged correlation,
/// so the counter must start past every one of them, never at 0.
fn correlation_after_log(host: &Host) -> u64 {
    host.logged_events()
        .map(|events| {
            events
                .iter()
                .filter_map(|e| match e.payload {
                    EventPayload::WireRequest { correlation, .. } => correlation.checked_add(1),
                    _ => None,
                })
                .max()
                .unwrap_or(0)
        })
        .unwrap_or(0)
}

/// The single owning struct for the canonical sim loop: the `!Send` [`Host`] +
/// [`RenderProducer`] + every internal channel live here, on one thread.
pub struct SimLoop {
    host: Host,
    producer: RenderProducer,
    gesture_rx: GestureRx,
    // The internal runtime-event ingress `tick_once` drains. Owned here; both the
    // webhook seam and the dev pre-tick hook feed it (the shell holds no separate
    // `_ingress_tx` open anymore — CLEAN-07).
    ingress_tx: UnboundedSender<EventPayload>,
    ingress_rx: UnboundedReceiver<EventPayload>,
    cmd_tx: UnboundedSender<Command>,
    results_rx: UnboundedReceiver<ResultEvent>,
    // ── SEAMS (present, inert in the shell this phase) ──
    webhook_rx: Option<Receiver<Ingress>>,
    control_rx: Option<UnboundedReceiver<ControlMsg>>,
    pre_tick: Option<PreTick>,
    tick: u64,
    // ── Endpoint host bridge (Phase 38, plan 38-03) ──
    /// The endpoint-ingress seam: each accepted `POST /endpoint/{target}` arrives
    /// here (parallel to `webhook_rx`). `acquire_input` drains it, mints a
    /// correlation, parks the caller's socket in `registry`, and enqueues a
    /// `WireRequest` (NOT a `ManualInject`). `None` until `with_endpoint` wires it.
    /// BOUNDED (F2): the axum handler `try_send`s onto this channel and 503s a caller
    /// when it is full, so a flood while the sim is Frozen/Draining (when this drain
    /// does not run) cannot grow host memory without bound.
    endpoint_rx: Option<Receiver<EndpointIngress>>,
    /// The in-memory correlation registry (ENDP-04): the parked-socket store both
    /// the sim thread (mint + deadline sweep) and the off-thread executor consumer
    /// (the `Effect::Reply` arm) share. A clone is captured by the consumer closure
    /// in `new()`; the `remove` inside `resolve` is the single-writer exactly-once
    /// gate. Never serialized (empty-on-construct) — the replay-mute property.
    registry: Registry,
    /// The monotonic `u64` correlation counter, minted SINGLE-THREADED on the sim
    /// thread in `acquire_input` (Pitfall 5). A per-endpoint / NodeId-derived value
    /// would collide across the many requests that hit ONE endpoint; a monotonic
    /// counter guarantees a unique live correlation per parked request.
    correlation_next: u64,
    // ── Run-state + drain-to-quiescence machinery (Phase 18) ──
    /// The sim-thread run model; gates `step()`.
    run_state: RunState,
    /// The executor hold flag: `true` ONLY while [`RunState::Frozen`]. Cloned
    /// into the off-thread executor consumer (Send+Sync; never references the
    /// `!Send` Host) so it holds NEW dispatch while frozen.
    paused: Arc<AtomicBool>,
    /// The not-Playing signal published OUT to the webhook axum handler (ROBUST-01):
    /// `true` iff `run_state == RunState::Playing`, stored once at the end of every
    /// `step()`. Mirrors the `paused` Arc that already crosses the thread boundary,
    /// but is derived from `run_state` (NOT `paused`) because `paused` is `false`
    /// during Draining — the exact window the webhook door must refuse. The handler
    /// reads it lock-free per request to fast-503 while the sim is Draining/Frozen
    /// (Gate A), a one-way host publish that never re-enters the deterministic fold.
    is_playing: Arc<AtomicBool>,
    /// Wakes the parked executor consumer on Resume.
    resume_notify: Arc<Notify>,
    /// Draining-tick counter, reset on entering [`RunState::Draining`]; the
    /// max-settle budget ([`MAX_SETTLE_TICKS`]) forces Frozen when it overruns.
    draining_ticks: u64,
    /// Webhook acks collected during [`SimLoop::acquire_input`] and flushed AFTER
    /// the tick in [`SimLoop::tick_body`] (empty — hence a no-op — whenever
    /// `acquire_input` was skipped while Draining).
    pending_acks: Vec<oneshot::Sender<()>>,
    /// Gestures accepted in [`SimLoop::acquire_input`] and answered AFTER the tick that folds
    /// them, in [`SimLoop::tick_body`] beside the `pending_acks` flush (phase 88, D-06): the
    /// accept names the render handles each minted, which exist only once the producer has
    /// built the tick's packet.
    pending_accepts: Vec<PendingAccept>,
    /// Test-only fault injection (phase 88 review, IN-04): when set, the next producer step in
    /// [`SimLoop::tick_body`] fails, as a render-packet encode failure would, after the fold.
    #[cfg(test)]
    fail_next_producer_step: bool,
    /// Test-only fault injection (phase 90 review, the deferred "two host Load failures"): the
    /// next [`SimLoop::load_swap`] fails to create its work folder, or fails to project the
    /// loaded file's timers, as a full disk or an unreadable edit log would.
    #[cfg(test)]
    fail_next_load_work_dir: bool,
    #[cfg(test)]
    fail_next_load_timers: bool,
    /// The DEV-ONLY fault seam (phase 90, D-13, research Finding A): when wired and set, the
    /// next [`SimLoop::step`] returns `StoreError::Backend(DEV_FAULT_REASON)` through the
    /// same path a real store failure takes to `run` and the fatal sentence. Wired ONLY by
    /// `dev_render_server` through [`SimLoop::with_dev_fault`]; the Tauri shell never calls
    /// it (the `with_pre_tick` rule), so in the shipped app it is always `None`. Compiled only
    /// with the `dev-seams` feature (phase 90 review IN-A-04), which the shipped build lacks.
    #[cfg(feature = "dev-seams")]
    dev_fault: Option<Arc<AtomicBool>>,
    /// Count of commands the executor consumer has picked up for dispatch
    /// (incremented AFTER the pause gate). The executor-gate test reads it to
    /// prove dispatch is held while frozen and resumes on wake. Only read behind
    /// `#[cfg(test)]`, so the field is write-only in a non-test build.
    #[cfg_attr(not(test), allow(dead_code))]
    dispatched: Arc<AtomicUsize>,
    // ── Save/Load host-swap machinery (Phase 18, plan 18-02) ──
    /// Owns the FRESH `work_dir` the currently-loaded store lives under. It MUST
    /// outlive the swapped [`Host`] (the `Host`'s `RedbStore` references files
    /// under it — RESEARCH Pattern 4 ownership trap), so on a Load the OLD dir is
    /// only dropped AFTER the new Host is installed. `None` until the first Load /
    /// LoadDemo (the genesis Host owns its own store elsewhere).
    _work_dir: Option<tempfile::TempDir>,
    /// The snapshot cadence handed to [`load_project`] for a loaded store (and to
    /// the LoadDemo genesis Host). Threaded from construction; `None` = no
    /// on-cadence snapshotting (the shell wires a real value in a later plan).
    snapshot_every: Option<u64>,
    /// A Save LATCHED while the sim was still non-quiescent: it runs the instant
    /// the drain reaches [`RunState::Frozen`] (HOST-04). `None` when no Save is
    /// pending.
    pending_save: Option<PathBuf>,
    /// A Load / LoadDemo LATCHED while the sim was still non-quiescent (WR-02): the
    /// host swap runs the instant the drain reaches [`RunState::Frozen`], so no
    /// stray OLD-scene executor effect crosses into the loaded host. `None` when no
    /// swap is pending.
    pending_load: Option<PendingLoad>,
    /// Whether the current/last drain ORIGINATED FROM (or was JOINED BY) an
    /// explicit user [`ControlMsg::Pause`] (20-review WR-01). Set in the Pause arm
    /// when a drain is entered or already in progress; cleared ONLY by an explicit
    /// [`ControlMsg::Resume`]. A latched Load/LoadDemo swap consults it at the
    /// freeze: a swap-safety drain auto-resumes Playing (the 20-05 live-CTA
    /// guarantee — the CTA is never a dead click), but a drain the user explicitly
    /// paused stays Frozen after the swap (the scene still visibly repopulates via
    /// the producer reset; the user's Pause is respected, never silently discarded).
    drain_from_user_pause: bool,
    /// Whether the current drain settles once no executor effect is in flight, belt items or
    /// not (phase 90 review WR-A-02). Set when a Save, Load, New or example enters a drain from
    /// a HELD board ([`RunState::Frozen`], the user's own Pause or Step) because an effect is
    /// in flight: the effect must finish (a save with one in flight is refused NotQuiescent,
    /// and a swap must not let its result fold into the next board), but the belt items need
    /// not move, because a save captures them and a swap discards them. Cleared by every drain
    /// entered from Playing, which still settles the whole board as before.
    drain_settles_on_effects: bool,
    // ── Live webhook route projection (Phase 18, plan 18-03) ──
    /// The publish half of the LIVE webhook route table (HOST-07). The sim thread
    /// swaps a FRESH immutable `Arc<BTreeMap<String,NodeId>>` over this whenever the
    /// Source set changes; the axum webhook handler holds the paired
    /// [`watch::Receiver`] (obtained via [`SimLoop::routes_receiver`]) and reads the
    /// latest snapshot per request. NEVER an imperatively-mutated map.
    routes_tx: watch::Sender<Arc<BTreeMap<String, NodeId>>>,
    /// The routable-set fingerprint the recompute guard compares each tick (see
    /// [`route_ids`] — Source and Endpoint ids, each paired with the ADDRESS it answers
    /// at). The projection is re-published ONLY when this changes. The address half is
    /// 72-07's fix: a `Configure` that changed only a Route's path used to flip nothing
    /// here, so the map was never rebuilt and the user got a 404 at the address they
    /// had just typed.
    route_fingerprint: Vec<(NodeId, RouteAddress)>,
    // ── Loaded-scene identity (Phase 55, WR-03) ──
    /// Which SHIPPED scene the board holds, or `None` for a user board. Written at
    /// exactly three sites, each on a SUCCESSFUL swap: `load_scene_swap` sets
    /// `Some(id)`, `new_swap` and `load_swap` set `None`. A refused swap leaves it
    /// untouched, matching "keep the current scene". Boot sites that pre-seed a
    /// scene OUTSIDE the loop declare it via [`SimLoop::with_loaded_scene`];
    /// the default is `None` (a bare host is not a shipped scene), so the answer is
    /// never a guess. Answered over [`ControlMsg::QueryScene`].
    loaded_scene: Option<SceneId>,
    // ── Load-refusal sink (Phase 73, UNDO-09) ──
    /// Where a REFUSED [`ControlMsg::Load`] sends the host's own reason, so it reaches a
    /// screen instead of only standard error. `None` until a transport wires it (the
    /// bounded tests and every headless caller leave it unset, and the refusal then
    /// behaves exactly as it did before this phase).
    ///
    /// It is a SINK and not a reply channel because `ControlMsg::Load(PathBuf)` carries
    /// no reply channel: on the Tauri path `load_project_cmd` is a synchronous fn that
    /// returns the instant the control message is enqueued, so the verdict cannot ride
    /// the command's return on either transport. This is the same out-of-band shape the
    /// gesture verdict already takes, and for the same reason.
    load_refusal_sink: Option<LoadRefusalSink>,
    /// Where a FAILED [`ControlMsg::Save`] sends the host's own reason (phase 90 review
    /// WR-A-03), the save twin of [`load_refusal_sink`](Self::load_refusal_sink) and for the
    /// same reason: `ControlMsg::Save(PathBuf)` carries no reply channel. The page marks the
    /// board clean when it sends a Save, so without this a write that failed (a disk error, or
    /// a drain that ran out of budget with an effect still in flight) read as saved. `None`
    /// until a transport wires it.
    save_failure_sink: Option<LoadRefusalSink>,
    // ── The held undo (plan 74.1-23, GAP N3-RACE) ──
    /// At most one Undo or Redo envelope the gesture drain met AFTER another gesture had
    /// already enqueued records in the same pass. It is held here, its reply untouched,
    /// and applied first on the next pass, once those records have folded, so it resolves
    /// against a projection that includes them. Applied in the pass that met it, it
    /// resolved against a projection one action behind: a Ctrl+Z on the same tick as a
    /// join undid the second belt's draw and deleted that belt (the walk's seq 73 to 75).
    /// See [`acquire_input`](Self::acquire_input) for the rule. A successful board swap
    /// drops it, together with every gesture still queued in `gesture_rx`, answering each
    /// `gestureDiscarded` ([`install_swapped_host`](Self::install_swapped_host), review round 4
    /// WR-01 and round 5 CR-01, phase 88 D-05), so no edit made on one board is ever applied to
    /// another.
    held_undo_redo: Option<GestureEnvelope>,
}

/// The sink a refused [`ControlMsg::Load`] hands its reason to (UNDO-09).
///
/// Takes the host's `ProjectError` `Display` sentence as a `String` and NOT a built
/// frame, because the two transports frame it differently: the dev WebSocket serializes
/// a `LoadRefusedFrame` onto its outbound TEXT relay, and the Tauri shell pushes a
/// `LoadRefused` down the webview's `Channel`. One sentence, two envelopes, and the
/// cross-language parity test is what keeps the envelopes' discriminator identical.
///
/// Not `Send`: `SimLoop` lives on the sim thread and never crosses one.
pub type LoadRefusalSink = Box<dyn Fn(String)>;

impl SimLoop {
    /// Build the loop and spawn the OFF-thread executor consumer on the caller's
    /// runtime `Handle` (the runtime MUST outlive the loop — Pitfall 4). The
    /// [`Host`] + [`RenderProducer`] stay here on the constructing thread (Core is
    /// `!Send`). The spawned consumer block is lifted VERBATIM from the three
    /// existing loops.
    pub fn new(
        host: Host,
        producer: RenderProducer,
        rt: &tokio::runtime::Handle,
        cfg: HostConfig,
        gesture_rx: GestureRx,
    ) -> Self {
        let (cmd_tx, mut cmd_rx) = unbounded_channel::<Command>();
        let (res_tx, results_rx) = unbounded_channel::<ResultEvent>();
        let (ingress_tx, ingress_rx) = unbounded_channel::<EventPayload>();

        // IN-01: seed the loop tick from core, not an independent 0 counter, so a
        // pre_tick injection cadence keyed on `self.tick` stays aligned with
        // `core.tick` (load-bearing the moment Load resumes at core.tick == N).
        let start_tick = host.core().tick;
        let correlation_start = correlation_after_log(&host);

        // HOST-07 / ENDP-05: seed the LIVE route projection from the genesis/loaded
        // core's routable set (Sources AND Endpoints) so any node already present
        // routes from the very first request, and prime the fingerprint so the first
        // membership CHANGE (not the seed) triggers the next re-publish.
        // DEMO-08: the host arrives with its timers already installed (`with_timers`
        // after seeding), so a Source the seed put on Timer is left out from the start.
        let route_fingerprint = route_ids(host.core(), host.timers());
        let (routes_tx, _routes_rx) =
            watch::channel(Arc::new(project_routes(host.core(), host.timers())));

        // The executor gate + wake primitives. BOTH are Send+Sync and NEITHER
        // references the `!Send` Host, so cloning them into the off-thread
        // consumer creates no reference cycle back into the sim thread.
        let paused = Arc::new(AtomicBool::new(false));
        // ROBUST-01: the not-Playing signal to the webhook handler. Starts `true`
        // (a fresh SimLoop is Playing); the end-of-step publish keeps it in sync.
        let is_playing = Arc::new(AtomicBool::new(true));
        let resume_notify = Arc::new(Notify::new());
        let dispatched = Arc::new(AtomicUsize::new(0));

        // ENDP-04: the correlation registry. Built BEFORE the executor spawn so a
        // clone can be MOVED into the consumer closure (exactly as `cfg`/`res_tx`
        // are) — the reply arm resolves parked sockets off-thread through the same
        // registry the sim thread parks into and sweeps. The original stays on the
        // SimLoop for `acquire_input` (mint/park) + `sweep_endpoint_deadlines`.
        let registry = Registry::default();
        let registry_c = registry.clone();

        // Clones handed to the consumer closure BEFORE the spawn (the originals
        // stay on the SimLoop for service_control to flip).
        let paused_c = Arc::clone(&paused);
        let notify_c = Arc::clone(&resume_notify);
        let dispatched_c = Arc::clone(&dispatched);

        // The executor consumer, off the sim thread (tokio workers): dispatch each
        // Command's real effect and fold the Outcome back as a ResultEvent. The host
        // stamps the admit tick on log-append; the executor sends 0.
        rt.spawn(async move {
            while let Some(cmd) = cmd_rx.recv().await {
                // PAUSE GATE: hold NEW dispatch while the sim is Frozen. Park on
                // `resume_notify` until Resume clears `paused`. A command already
                // handed to `dispatch()` still completes (you cannot un-send an
                // HTTP/email); only NEW pickups are held. The `enable()`-before-
                // check pattern makes this race-free against a `notify_waiters()`
                // that fires between the load and the await.
                loop {
                    let notified = notify_c.notified();
                    tokio::pin!(notified);
                    notified.as_mut().enable();
                    if !paused_c.load(Ordering::Acquire) {
                        break;
                    }
                    notified.await;
                }
                // ENDP-01/04: intercept a Reply to a parked endpoint request BEFORE
                // `dispatch`. Resolve the caller's socket off-thread via the shared
                // registry (the `remove` inside `resolve` is the single-writer gate),
                // then STILL send an `Outcome::Success` ResultEvent so the command
                // clears in-flight — `dispatch` would only return Success anyway, so
                // it stays registry-free (RESEARCH Open Q2/Q3). The socket write NEVER
                // re-enters the sim fold (the determinism boundary).
                // `return_addr` / `budget` (Phase 72 plan 04) are IN-SIM routing facts:
                // they pick the return cable inside the fold. The parked socket is resolved
                // by CORRELATION off the command stream and reads nothing from the grid
                // (D-08), so this arm deliberately ignores both rather than starting to
                // depend on a cable existing.
                if let Effect::Reply { correlation, payload, .. } = &cmd.effect {
                    registry_c.resolve(*correlation, descriptor_to_response(payload));
                    let _ = res_tx.send(ResultEvent {
                        command_id: cmd.id,
                        tick: 0,
                        outcome: Outcome::Success,
                    });
                    continue;
                }
                // Past the gate: count this dispatch pickup, then fire the effect.
                dispatched_c.fetch_add(1, Ordering::Relaxed);
                let res_tx = res_tx.clone();
                let cfg = cfg.clone();
                tokio::spawn(async move {
                    let outcome = dispatch(&cfg, &cmd).await;
                    let _ = res_tx.send(ResultEvent {
                        command_id: cmd.id,
                        tick: 0,
                        outcome,
                    });
                });
            }
        });

        Self {
            host,
            producer,
            gesture_rx,
            ingress_tx,
            ingress_rx,
            cmd_tx,
            results_rx,
            webhook_rx: None,
            control_rx: None,
            pre_tick: None,
            tick: start_tick,
            endpoint_rx: None,
            registry,
            correlation_next: correlation_start,
            run_state: RunState::Playing,
            paused,
            is_playing,
            resume_notify,
            draining_ticks: 0,
            pending_acks: Vec::new(),
            pending_accepts: Vec::new(),
            #[cfg(test)]
            fail_next_producer_step: false,
            #[cfg(test)]
            fail_next_load_work_dir: false,
            #[cfg(test)]
            fail_next_load_timers: false,
            #[cfg(feature = "dev-seams")]
            dev_fault: None,
            dispatched,
            _work_dir: None,
            snapshot_every: None,
            pending_save: None,
            pending_load: None,
            drain_from_user_pause: false,
            drain_settles_on_effects: false,
            routes_tx,
            route_fingerprint,
            loaded_scene: None,
            load_refusal_sink: None,
            save_failure_sink: None,
            held_undo_redo: None,
        }
    }

    /// Wire the load-refusal sink (UNDO-09): a REFUSED [`ControlMsg::Load`] hands the
    /// host's own `ProjectError` `Display` sentence here, and the transport that
    /// installed it carries it to a screen.
    ///
    /// Unset by default, and deliberately so: every headless caller and every bounded
    /// test leaves it `None`, where a refused load behaves exactly as it did before this
    /// phase (the current scene is kept and the reason goes to standard error only).
    #[must_use]
    pub fn with_load_refusal_sink(mut self, sink: LoadRefusalSink) -> Self {
        self.load_refusal_sink = Some(sink);
        self
    }

    /// Wire the save-failure sink (phase 90 review WR-A-03): a FAILED [`ControlMsg::Save`]
    /// hands the host's own `ProjectError` `Display` sentence here, and the transport that
    /// installed it tells the page, which shows `Save failed` and keeps the board unsaved.
    /// Unset by default, where a failed save is warned on standard error only, as before.
    #[must_use]
    pub fn with_save_failure_sink(mut self, sink: LoadRefusalSink) -> Self {
        self.save_failure_sink = Some(sink);
        self
    }

    /// Declare which SHIPPED scene the host was pre-seeded with BEFORE the loop was
    /// built (WR-03). Both boot sites seed their scene outside `SimLoop` (the app's
    /// `run_sim_thread` and the dev harness both call `boot_scene` before
    /// `SimLoop::new`), so without this the loop would have to GUESS, which is the
    /// exact failure this seam exists to remove. Defaults to `None`; every later
    /// swap maintains it from inside the loop.
    #[must_use]
    pub fn with_loaded_scene(mut self, id: SceneId) -> Self {
        self.loaded_scene = Some(id);
        self
    }

    /// Obtain a [`watch::Receiver`] onto the LIVE webhook route projection (HOST-07)
    /// to hand
    /// [`run_webhook_listener`](crate::ingress::webhook::run_webhook_listener). Each
    /// receiver reads the latest immutable `Arc` the sim thread published; the shell
    /// / dev entrypoint (18-04) calls this to wire the webhook server to the live
    /// route table.
    #[must_use]
    pub fn routes_receiver(&self) -> watch::Receiver<Arc<BTreeMap<String, NodeId>>> {
        self.routes_tx.subscribe()
    }

    /// Clone the not-Playing signal Arc for the webhook axum handler (ROBUST-01):
    /// the shell / dev entrypoint hands this to `run_webhook_listener` right where it
    /// calls [`routes_receiver`](Self::routes_receiver). The handler reads it lock-free
    /// per request (Gate A) to fast-503 while the sim is Draining/Frozen; the sim
    /// publishes `run_state == Playing` into it once at the end of every `step()`.
    #[must_use]
    pub fn is_playing_flag(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.is_playing)
    }

    /// Set the snapshot cadence handed to [`load_project`] on a Load (and to the
    /// LoadDemo genesis Host). Defaults to `None` (no on-cadence snapshotting).
    #[must_use]
    pub fn with_snapshot_every(mut self, snapshot_every: Option<u64>) -> Self {
        self.snapshot_every = snapshot_every;
        self
    }

    /// Wire the webhook-ingress seam (tests pass `Some`; the shell passes `None`
    /// this phase, Phase 18 wires it).
    #[must_use]
    pub fn with_webhook(mut self, rx: Receiver<Ingress>) -> Self {
        self.webhook_rx = Some(rx);
        self
    }

    /// Wire the endpoint-ingress seam (ENDP-01): each accepted
    /// `POST /endpoint/{target}` arrives on `rx`; `acquire_input` mints a
    /// correlation, parks the caller's socket in the registry, and enqueues a
    /// `WireRequest`. The 38-04 app wiring hands the real receiver; tests pass
    /// `Some` directly.
    #[must_use]
    pub fn with_endpoint(mut self, rx: Receiver<EndpointIngress>) -> Self {
        self.endpoint_rx = Some(rx);
        self
    }

    /// Wire the control seam (drained-and-ignored this phase; Phase 18 acts on it).
    #[must_use]
    pub fn with_control(mut self, rx: UnboundedReceiver<ControlMsg>) -> Self {
        self.control_rx = Some(rx);
        self
    }

    /// Wire the dev-only pre-tick demo-injection hook (the shell never injects).
    #[must_use]
    pub fn with_pre_tick(mut self, hook: PreTick) -> Self {
        self.pre_tick = Some(hook);
        self
    }

    /// Wire the dev-only fault seam (phase 90, D-13; the shell never wires it, the
    /// `with_pre_tick` rule). Setting `flag` makes the next [`SimLoop::step`] return
    /// `StoreError::Backend(DEV_FAULT_REASON)` once, from any run state; the flag is
    /// cleared as it fires. Only with the `dev-seams` feature (phase 90 review IN-A-04): the
    /// shipped Tauri build compiles without it.
    #[cfg(feature = "dev-seams")]
    #[must_use]
    pub fn with_dev_fault(mut self, flag: Arc<AtomicBool>) -> Self {
        self.dev_fault = Some(flag);
        self
    }

    /// Publish render handles BEFORE running (callers hand these to their transport
    /// AFTER the producer has moved into the loop — Pitfall 3). Delegates to
    /// [`RenderProducer::subscribe`].
    #[must_use]
    pub fn subscribe(&self) -> (watch::Receiver<RenderFrame>, broadcast::Receiver<RenderFrame>) {
        self.producer.subscribe()
    }

    /// A read-only borrow of the owned [`Host`] (the retargeted bounded tests read
    /// the log / inspect state through this).
    #[must_use]
    pub fn host(&self) -> &Host {
        &self.host
    }

    /// The dense render handle the producer currently assigns to `id` (the inverse of
    /// the handle table the frontend sees on every `NodeView.id`). The config-query
    /// commands (`QueryConfig` / `QueryWebhookUrl`) take that handle; this
    /// `#[doc(hidden)] pub` accessor lets the integration suite reverse a known
    /// [`NodeId`] (e.g. `core().last_tick.placed`) back to the handle to drive them.
    /// Read-only; delegates to [`RenderProducer::handle_for_node`].
    #[doc(hidden)]
    #[must_use]
    pub fn handle_for_node(&self, id: NodeId) -> Option<u64> {
        self.producer.handle_for_node(id)
    }

    /// TEST-ONLY seam for the `tests/endpoint.rs` integration suite (ENDP-04/05):
    /// a clone-handle of the shared correlation [`Registry`].
    ///
    /// Integration tests live in a SEPARATE crate that links the library built
    /// WITHOUT `--cfg test`, so the in-crate `#[cfg(test)]` `pub(crate)` seams
    /// (`registry`, `test_send_command`) are invisible across that boundary. This
    /// `#[doc(hidden)] pub` handle is the minimal public surface that lets the
    /// end-to-end suite (a) read parked-length after a recover (the replay-mute
    /// EMPTY assertion) and (b) simulate the executor-consumer `Effect::Reply`
    /// arm's `resolve` for the parked-socket round-trip — the reverse in-sim
    /// transport is decorative until Phase 40, so no core-produced reply exists to
    /// drive it yet. It only clones an `Arc<Mutex<_>>`; it adds no new state and
    /// leaks no private type.
    #[doc(hidden)]
    #[must_use]
    pub fn registry_handle(&self) -> Registry {
        self.registry.clone()
    }

    /// Whether the sim is settled + frozen (`true` only in [`RunState::Frozen`]).
    /// This is the executor-hold flag the off-thread consumer reads; the shell
    /// can query it to reflect the optimistic Play/Pause glyph. During Draining
    /// it is still `false` (the sim is ticking to settle).
    #[must_use]
    pub fn is_paused(&self) -> bool {
        self.paused.load(Ordering::Acquire)
    }

    /// TEST-ONLY: the number of commands the off-thread executor consumer has
    /// picked up for dispatch (incremented AFTER the pause gate). Stable while
    /// frozen; increases once Resume wakes the parked consumer.
    #[cfg(test)]
    pub(crate) fn dispatched_count(&self) -> usize {
        self.dispatched.load(Ordering::Relaxed)
    }

    /// TEST-ONLY: enqueue a raw [`Command`] straight onto the executor channel so
    /// the executor-gate test can prove dispatch is held while frozen without a
    /// full Sink topology emitting it.
    #[cfg(test)]
    pub(crate) fn test_send_command(&self, cmd: Command) {
        let _ = self.cmd_tx.send(cmd);
    }

    /// Service the control channel at the TICK BOUNDARY (CONTEXT Area 1) — the
    /// FIRST thing `step()` does, before any input. Drains `control_rx` FIFO and
    /// acts on each message:
    ///
    /// - `Pause` (from Playing): if ALREADY quiescent
    ///   (`in_flight_len()==0 && belt_items_in_flight()==0`) freeze immediately
    ///   ("Paused" always means settled + frozen); otherwise begin Draining
    ///   (hold new input, keep ticking to drain what is in flight).
    /// - `Resume`: return to Playing, clear the executor hold, and wake the
    ///   parked consumer so buffered dispatch fires.
    /// - `Step`: run exactly ONE input-applying `acquire_input()` + `tick_body()`
    ///   (the IDENTICAL pair the live path runs — HOST-03) and stay Frozen.
    ///
    /// The drain is bounded (`while try_recv()`), so a control-message flood is
    /// serviced FIFO within one tick boundary (threat T-18-02).
    ///
    /// # Errors
    /// Propagates a [`StoreError`] from a `Step`'s `tick_body`.
    fn service_control(&mut self) -> Result<(), StoreError> {
        // Drain into a buffer first so we don't hold `&mut self.control_rx` across
        // the `&mut self` calls a `Step` makes.
        let mut msgs: Vec<ControlMsg> = Vec::new();
        if let Some(rx) = self.control_rx.as_mut() {
            while let Ok(m) = rx.try_recv() {
                msgs.push(m);
            }
        }
        for msg in msgs {
            match msg {
                ControlMsg::Pause => match self.run_state {
                    RunState::Playing => {
                        if self.host.in_flight_len() == 0
                            && self.host.belt_items_in_flight() == 0
                        {
                            // Already settled — freeze now (Paused == settled + frozen).
                            self.run_state = RunState::Frozen;
                            self.paused.store(true, Ordering::Release);
                            // CR-01 (40-review): record the user's Pause intent even on
                            // the quiescent (no-drain) path, so a later LoadDemo's
                            // `!drain_from_user_pause` auto-resume (immediate arm) does
                            // NOT run the demo over an explicit user pause. Without this
                            // the flag was set ONLY on the draining branch, so a
                            // Pause-while-settled then LoadDemo would silently resume.
                            self.drain_from_user_pause = true;
                        } else {
                            // Drain to quiescence first: hold new input, keep ticking.
                            self.run_state = RunState::Draining;
                            self.draining_ticks = 0;
                            self.drain_settles_on_effects = false;
                            // WR-01: this drain originated from an explicit user
                            // Pause — a latched Load/LoadDemo firing at its freeze
                            // must NOT auto-resume over it.
                            self.drain_from_user_pause = true;
                        }
                    }
                    RunState::Draining => {
                        // WR-01: an explicit Pause JOINS an in-progress drain (e.g.
                        // one a latched Save/Load entered as swap-safety). The drain
                        // already freezes on settle; recording the user's intent
                        // here stops a latched swap's auto-resume from silently
                        // discarding this Pause.
                        self.drain_from_user_pause = true;
                    }
                    RunState::Frozen => {
                        // Frozen already holds the user's hold (phase 90 review WR-A-04: the
                        // invariant at the end of `step()`), settled or budget-frozen alike,
                        // so a Pause here is a no-op. The budget-frozen branch iter-2 WR-01
                        // added recorded a hold for a "Frozen without a hold" state that no
                        // longer exists.
                    }
                },
                ControlMsg::Resume => {
                    // An explicit Resume supersedes any recorded user Pause (WR-01).
                    self.drain_from_user_pause = false;
                    if self.run_state == RunState::Draining
                        && (self.pending_save.is_some() || self.pending_load.is_some())
                    {
                        // Phase 90 review CR-A-01 and WR-B-05: a Resume while a Save, Load,
                        // New or example is latched behind a drain KEEPS the latch and only
                        // lifts the user's hold. The drain runs on to settle, the latch fires
                        // there (the file is written, the swap installs), and the tails in
                        // `step()` restore Playing because the hold is now lifted (D-08 for a
                        // Save, the latched-Load resume for the rest). Cancelling it here, as
                        // 20-review CR-01 did, lost a Save in silence after the page had
                        // already cleared its Unsaved badge, and left a page's pending Load to
                        // time out with no reason. The latch still fires at THIS drain's
                        // settle, never at some later unrelated freeze (the CR-01 hazard), and
                        // the executor is already running (`paused` is false while Draining).
                    } else {
                        self.run_state = RunState::Playing;
                        self.paused.store(false, Ordering::Release);
                        // Outside a latched drain no latch is armed (a latch is `Some` only
                        // between a non-quiescent Save or Load and the freeze that consumes
                        // it), so clearing them is a guard, never a cancel.
                        self.pending_load = None;
                        self.pending_save = None;
                        // Wake the parked executor consumer (race-free against its
                        // enable()-before-check gate).
                        self.resume_notify.notify_waiters();
                    }
                }
                ControlMsg::Step => {
                    // D-07 (phase 90, FAIL-03): a Step is always the user's own hold,
                    // recorded the way a Pause records it, so a later demo load, example
                    // or New does not resume over it (only an explicit Resume clears it).
                    self.drain_from_user_pause = true;
                    if self.run_state == RunState::Draining
                        && (self.pending_save.is_some() || self.pending_load.is_some())
                    {
                        // Research Finding C: a Step that lands while a latched Save or
                        // Load drains JOINS the drain, exactly as a Pause does, and runs
                        // no tick of its own. The drain keeps ticking to settle, fires
                        // its latch there (the file is written, the swap installs) and
                        // stays Frozen because the user stepped. Freezing here instead
                        // would strand the latch: it fires only in the Draining arm.
                        // Phase 90 review IN-A-02: only a LATCHED drain is joined. A plain
                        // Pause drain has nothing to strand, so a Step there steps one tick
                        // and holds below, as it did before phase 90.
                    } else {
                        // One input-applying advance, IDENTICAL to the live path
                        // (acquire_input THEN tick_body), staying Frozen. This is the
                        // `step×N == live×N` structure (Task 3 guards byte-identity).
                        self.acquire_input()?;
                        self.tick_body()?;
                        self.run_state = RunState::Frozen;
                        self.paused.store(true, Ordering::Release);
                    }
                }
                ControlMsg::Save(path) => {
                    // HOST-04: Save at QUIESCENCE via the hardened `save_project`.
                    // From a settled state (Frozen, or Playing with nothing in
                    // flight) the save runs immediately. Otherwise LATCH it and
                    // begin the drain-to-quiescence Pause; the latch fires the
                    // instant `step()` reaches Frozen. `save_project`'s
                    // `in_flight_len()!=0` refusal (NotQuiescent) is the backstop.
                    if self.ready_to_save_or_swap() {
                        self.do_save(&path);
                    } else {
                        // WR-01: re-enter the drain from Playing OR a budget-frozen
                        // (Frozen + non-quiescent) state so the latch ACTUALLY fires.
                        // Before this, a Save latched from a budget-frozen state (a
                        // stuck effect that exhausted MAX_SETTLE_TICKS) was silently
                        // dropped: `run_state` was Frozen (not Playing) so no drain
                        // re-entered, the Frozen arm of `step()` is a no-op forever,
                        // and `pending_save` never fired. Re-entering Draining either
                        // settles-then-saves, or — if the budget re-expires on a hung
                        // effect — reaches Frozen and lets `save_project`'s
                        // NotQuiescent refusal surface the error (never a silent
                        // no-op).
                        self.begin_drain_to_settle();
                        self.pending_save = Some(path);
                    }
                }
                ControlMsg::Load(path) => {
                    // WR-02: reach QUIESCENCE before the swap (the same
                    // drain-to-quiescence model Save uses), so queued OLD-scene
                    // executor commands finish in the OLD host and no stray result
                    // folds into the loaded scene. From a settled state swap now;
                    // otherwise latch it and (re-)enter the drain — the swap fires
                    // the instant `step()` reaches Frozen.
                    if self.ready_to_save_or_swap() {
                        // HOST-05: swap the `!Send` Host on THIS sim thread via the
                        // hardened `load_project`, reset the producer (never dark),
                        // and re-seed the tick. On a ProjectError the scene is kept.
                        //
                        // No resume tail (phase 90 review WR-A-04). This arm is reached from
                        // Playing, which stays Playing, or from Frozen, which always holds the
                        // user's hold (the invariant at the end of `step()`), so the board the
                        // user paused or stepped stays paused, loaded or refused. 73-07 added a
                        // tail that resumed a Frozen board with no hold, the state a Save drain
                        // left before D-08; that state no longer exists. The refused-Load gate
                        // 73-12 put on it went with it: a refusal keeps the board as it was.
                        let _swapped = self.load_swap(&path);
                    } else {
                        self.begin_drain_to_settle();
                        self.pending_load = Some(PendingLoad::File(path));
                    }
                }
                ControlMsg::LoadDemo => {
                    // LIVE-03: the wire-compatible legacy verb — routes through
                    // the SAME typed Scene(SceneId::Demo) latch as LoadScene
                    // (Phase 55), so the demo load and an example load share
                    // one certified quiescence + swap + auto-resume path.
                    self.control_load_scene(SceneId::Demo);
                }
                ControlMsg::LoadScene(id) => {
                    // EX-02: the parameterized scene-select control. The id
                    // was parsed through SceneId::parse at the transport's own
                    // decode boundary (dev-WS load_example verb / Tauri
                    // load_example command) — never a silent demo fallback.
                    self.control_load_scene(id);
                }
                ControlMsg::New => {
                    // SAVE-04: same drain-to-quiescence-before-swap contract as
                    // Load / LoadDemo, but the swapped-in board is genesis-EMPTY
                    // (seeds nothing). From a settled state swap now; otherwise
                    // latch it and (re-)enter the drain.
                    if self.ready_to_save_or_swap() {
                        // No resume tail (phase 90 review WR-A-04): from Playing the board
                        // plays on, and a Frozen board is always one the user holds, so it
                        // stays paused, as the immediate Load arm does.
                        self.new_swap();
                    } else {
                        self.begin_drain_to_settle();
                        self.pending_load = Some(PendingLoad::New);
                    }
                }
                ControlMsg::QueryConfig { node, reply } => {
                    // A tick-boundary READ (CFG-01/03): resolve + read on the sim
                    // thread, answer over the oneshot. Enqueues nothing; never locks
                    // Core off-thread (T-39-CORE-RACE). A dropped receiver is a benign
                    // ignore (the frontend abandoned the query).
                    let _ = reply.send(self.machine_config(node));
                }
                ControlMsg::QueryScene { reply } => {
                    // A tick-boundary READ (WR-03): which shipped scene the board
                    // holds, or None for a user board. Enqueues nothing.
                    let _ = reply.send(self.loaded_scene);
                }
                ControlMsg::QueryWebhookUrl { node, addr, reply } => {
                    // A tick-boundary READ (CFG-03): format the loopback URL host-side.
                    let _ = reply.send(self.webhook_url(node, addr));
                }
                ControlMsg::ValidateFactoryJs { source, reply } => {
                    // A pre-check COMPILE (CFG-02): build the JS on the sim thread (the
                    // transient rquickjs runtime is affine to it) and reply Ok/Err —
                    // committing NOTHING, so bad JS is never enqueued.
                    let result = FactoryRuntime::build_default(&source)
                        .map(|_| ())
                        .map_err(|e| e.to_string());
                    let _ = reply.send(result);
                }
            }
        }
        Ok(())
    }

    /// Resolve a node's CURRENT [`MachineConfig`] at the tick boundary (CFG-01/03).
    /// Reads ONLY on the sim thread (never a lock on the `!Send` Core, T-39-CORE-RACE):
    /// resolve the dense render `handle` to a [`NodeId`] via the producer's handle
    /// table, then read `core.state`: a Factory's `source`, a Sink's `template`, a
    /// Router's `routes` + `default` (ROUTE-03, 65-02: both ARE snapshot fields, so
    /// that arm is a plain clone off folded state), a Belt's `ticks_per_slot` (BELT-02,
    /// 68-01: also a snapshot field, so also a plain read), or, for a Source, MERGE
    /// the host Timer projection (the trigger is NOT a snapshot field, so it is read
    /// from the certified edit-log via [`project_timers`], not from folded state).
    /// `None` for an unmapped handle or a non-configurable node.
    ///
    /// The match over [`Node`] is EXHAUSTIVE with no catch-all, the discipline
    /// `config_view.rs`'s `From<MachineConfig>` states verbatim: a `_ =>` would turn a
    /// future appended `Node` variant into a config panel that silently reads back
    /// nothing instead of a compile error.
    #[must_use]
    fn machine_config(&self, handle: u64) -> Option<MachineConfig> {
        let id = self.producer.node_for_handle(handle)?;
        match self.host.core().state.node(id)? {
            Node::Factory(factory) => Some(MachineConfig::Factory {
                source: factory.source.clone(),
            }),
            Node::Sink(sink) => Some(MachineConfig::Sink {
                target: sink.template.clone(),
            }),
            Node::Source(_) => {
                // MERGE the host Timer projection: a live Timer{interval} if the
                // edit-log configured one for this node, else the Webhook default.
                let edits = self.host.logged_edits().ok()?;
                let trigger = match project_timers(&edits).interval_for(id) {
                    Some(interval_ticks) => SourceTrigger::Timer { interval_ticks },
                    None => SourceTrigger::Webhook,
                };
                Some(MachineConfig::Source { trigger })
            }
            // ROUTE-03 (65-02). A PLAIN CLONE off folded state, deliberately NOT the
            // `Node::Source` shape immediately above: a Source's trigger is not a
            // snapshot field, so that arm has to walk the certified edit-log, while a
            // Router's `routes` and `default` ARE snapshot fields on `Node::Router`.
            // A `project_timers` walk here would be pure cost on every panel open.
            //
            // `faults` is carried NOWHERE, and that is the frozen core's own stated
            // rule rather than a preference here: `MachineConfig::Router`'s docblock
            // (`crates/fabrico-core/src/edit.rs`) records that `Router::faults` is
            // deliberately absent because `fold_configure` writes the two config fields
            // individually, so a reconfigure never zeroes the counter.
            Node::Router(router) => Some(MachineConfig::Router {
                routes: router.routes.clone(),
                default: router.default,
            }),
            // BELT-02 (68-01). A PLAIN READ off folded state, the `Node::Router` shape
            // above rather than the `Node::Source` one: a belt's advance interval IS a
            // snapshot field (`Belt::ticks_per_slot`), so this arm needs no edit-log
            // walk and a `project_timers` walk here would be pure cost per panel open.
            //
            // The `NonZeroU32` travels WHOLE. `MachineConfig` is the frozen CORE enum
            // and its `Belt` variant carries the non-zero type; the `.get()` that
            // flattens it to the plain `u32` the frontend decoder expects happens ONCE,
            // in `config_view.rs`'s `From<MachineConfig> for ConfigView`, which both
            // transports already share. Flattening here as well would put two
            // conversions on a path that needs one.
            //
            // This reads the SAME core field `render_packet.rs` reads for
            // `BeltView.ticks_per_slot`: two producers, one core reading. That they
            // agree is ASSERTED, not assumed:
            // `tests/configure_host.rs::belt_config_read_back_equals_the_render_packets_pace`
            // compares the two readings for one core state in one run (68-UI-SPEC 3.3).
            Node::Belt(belt) => Some(MachineConfig::Belt {
                ticks_per_slot: belt.ticks_per_slot,
            }),
            // SERVE-05 (72-13, RULE 2 auto-fix). A ROUTE ANSWERS WITH ITS PATH, and
            // until this commit it answered `None` alongside the genuinely
            // non-configurable operators below.
            //
            // THIS WAS A LIVE DEFECT, FOUND BY DRIVING THE REAL APP AND NOT BY READING.
            // Plan 72-07 gave `Node::Endpoint` a serialized `path` and a `fold_configure`
            // arm for it; plan 72-10 built the whole Path field, its four-rule client
            // gate, its copy and its 39 unit cases (`RouteConfigBody.tsx`), and wired the
            // sixth `config &&` arm in `ConfigPanel.tsx`. Every one of those tests mounts
            // the body DIRECTLY. `ConfigPanel` renders that arm only under
            // `!loading && config`, and `config` is whatever THIS FUNCTION answers - so
            // with `None` here the shipped app rendered a Route card with a POST URL row,
            // a ports section and NO Path field and NO Apply, on every board, forever.
            // The feature was complete in three layers and unreachable in the running
            // binary. `25-route-and-handler.spec.ts` is what found it, at the first
            // `fill('#fab-route-path')` any test in this repository had ever attempted.
            //
            // A PLAIN CLONE OFF FOLDED STATE, the `Node::Router` and `Node::Belt` shape
            // rather than the `Node::Source` one: the path IS a snapshot field
            // (`Endpoint::path`), so this arm needs no edit-log walk, and a
            // `project_timers`-style projection here would be pure cost per panel open.
            // It is the same field `project_routes` and `webhook_url` read, through
            // `endpoint_route_key`, so the panel and the URL cannot disagree about which
            // path this Route answers at.
            Node::Endpoint(endpoint) => Some(MachineConfig::Endpoint {
                path: endpoint.path.clone(),
            }),
            Node::Tee(_) | Node::Balancer(_) | Node::Merge(_) | Node::Wire(_) => None,
            // Phase 76 (plan 76-02, D-04): a LABEL ANSWERS WITH ITS WORDS, COLOUR AND
            // SIZE, a plain read off folded state like the Router and Belt arms above:
            // the text and colour are fields on the node and the size is its
            // `footprints` entry (absent means the 1x1 rot-0 default). Plan 76-01 answered
            // `None` here, which opened the panel on its heading alone; with a config the
            // panel's Text field and Apply appear under the shipped `!loading && config`
            // guard with no new gate.
            Node::Label(label) => {
                let fp = self
                    .host
                    .core()
                    .state
                    .footprint_of(id)
                    .unwrap_or(fabrico_core::state::Footprint { w: 1, h: 1, rot: 0 });
                Some(MachineConfig::Label {
                    text: label.text.clone(),
                    colour: label.colour,
                    w: fp.w,
                    h: fp.h,
                })
            }
        }
    }

    /// The copyable loopback URL for a routable node (CFG-03 / WUI-01 / SERVE-08),
    /// resolved at the tick boundary. Resolve the dense render `handle` to a [`NodeId`]
    /// on the sim thread, then format `http://127.0.0.1:PORT/hook/src-<as_ffi>` for a
    /// [`Node::Source`] and `http://127.0.0.1:PORT/endpoint<key>` for a
    /// [`Node::Endpoint`], both using the bound `addr`'s port and the SAME labels
    /// [`project_routes`] publishes (so the URL routes to exactly this node).
    /// Loopback-only by construction (the `127.0.0.1` literal, no secret material).
    /// `None` for a non-routable or unmapped handle, and `None` for a Source on Timer
    /// (DEMO-08, D-20): [`project_routes`] gives that Source no door, so a URL for it would
    /// be a 404 handed over with a Copy button. Both read the host's one timer set.
    #[must_use]
    fn webhook_url(&self, handle: u64, addr: SocketAddr) -> Option<String> {
        let id = self.producer.node_for_handle(handle)?;
        match self.host.core().state.node(id)? {
            Node::Source(_) if self.host.timers().interval_for(id).is_some() => None,
            Node::Source(_) => Some(format!(
                "http://127.0.0.1:{}/hook/src-{}",
                addr.port(),
                id.data().as_ffi()
            )),
            // WUI-01 / SERVE-08: a Node::Endpoint resolves to its POST URL, built from
            // the Route's OWN `path` through the SAME `endpoint_route_key` normalization
            // `project_routes` publishes with. The two producers are independent (this
            // one builds a string for the panel, that one builds a map key for the door)
            // and they must agree; sharing the key function is what makes them agree by
            // construction instead of by two format strings that happen to match.
            //
            // The `/endpoint` PREFIX STAYS (D-12a, a deliberate design choice). It is a host route
            // prefix, not a leftover of the Phase-72 rename, so a Route whose path is
            // `/orders` answers at `http://127.0.0.1:PORT/endpoint/orders` and the word
            // "endpoint" remains on screen inside a copyable URL. No acceptance
            // criterion in this phase may claim the word is gone from the app (R-10).
            // The prefix is also what makes a user path structurally unable to reach
            // `/hook/`, which is why widening the capture BELOW it costs nothing
            // (T-72-07-02).
            Node::Endpoint(ep) => Some(format!(
                "http://127.0.0.1:{}/endpoint{}",
                addr.port(),
                endpoint_route_key(&ep.path)
            )),
            _ => None,
        }
    }

    /// Execute a quiescent [`ControlMsg::Save`] via the hardened
    /// [`save_project`] (HOST-04). A [`ProjectError`](crate::project::ProjectError)
    /// is NON-FATAL: the loop keeps running. `save_project`'s own NotQuiescent
    /// refusal is the persistence-side backstop, reached when a Save drain ran out of its
    /// settle budget with an effect still in flight.
    ///
    /// **THIS RETURNS NOTHING.** Until plan 68-07 it returned `Result<(), &'static str>` for
    /// one `Err`, the determinism fence of the retired development pace switch; that switch is
    /// gone (BELT-05 / D-68-12), and the run state after a Save does not depend on whether it
    /// was written (D-08: a Save restores the state the board had before it, see the tails in
    /// [`step`](Self::step)).
    ///
    /// A failure is warned on standard error AND, since the phase 90 review (WR-A-03), handed
    /// to the save-failure sink when a transport wired one, so the page shows `Save failed`
    /// and keeps the board unsaved. Before, D-60-2's gap stood: nothing from this path reached
    /// the webview, and the page had already marked the board clean when it sent the Save.
    fn do_save(&self, path: &Path) {
        if let Err(e) = save_project(&self.host, path) {
            eprintln!("fabrico-host: Save failed (loop continues): {e}");
            if let Some(sink) = self.save_failure_sink.as_ref() {
                sink(e.to_string());
            }
        }
    }

    /// Whether a Save, Load, New or example can act now rather than latch behind a drain
    /// (phase 90 review WR-A-02). Always when nothing at all is in flight. On a HELD board
    /// ([`RunState::Frozen`]: the user paused or stepped it, D-07, D-08) also when only belt
    /// items are in flight: a save captures them (the state is fully capturable at a tick
    /// boundary, and `save_project` refuses only an executor effect in flight), and a swap
    /// discards them with the old board. Draining a held board instead ran it on for up to
    /// [`MAX_SETTLE_TICKS`] ticks under a page that reads Paused (measured on the demo after a
    /// Step: 17 belt items, no effect, 127 ticks run before the file was written). From
    /// Playing the board still settles first, as it always did.
    fn ready_to_save_or_swap(&self) -> bool {
        self.host.in_flight_len() == 0
            && (self.host.belt_items_in_flight() == 0 || self.run_state == RunState::Frozen)
    }

    /// (Re-)enter the drain-to-quiescence so a latched Save / Load (WR-01, WR-02)
    /// actually fires. Enters [`RunState::Draining`] from Playing OR a
    /// budget-frozen ([`RunState::Frozen`] + non-quiescent) state and un-freezes so
    /// `step()`'s Draining arm ticks to settle. Idempotent while already Draining
    /// (does NOT reset `draining_ticks`, so a concurrent drain's budget is
    /// preserved).
    fn begin_drain_to_settle(&mut self) {
        if self.run_state != RunState::Draining {
            // WR-A-02: a drain entered from a held board waits for the executor effects only
            // (see `drain_settles_on_effects`); one entered from Playing settles the board.
            self.drain_settles_on_effects = self.run_state == RunState::Frozen;
            self.run_state = RunState::Draining;
            self.draining_ticks = 0;
            self.paused.store(false, Ordering::Release);
        }
    }

    /// Swap the Host for a [`ControlMsg::Load`] (HOST-05 + IN-01). Build the fresh
    /// `!Send` Host via the hardened [`load_project`] over a NEW work_dir; on `Ok`
    /// install it, RESET the producer (full:true over the diff broadcast), re-seed
    /// the loop tick from the loaded core, and only THEN drop the old work_dir (the
    /// old store must not be freed while the old Host still holds it — RESEARCH
    /// Pattern 4). On a [`ProjectError`](crate::project::ProjectError) the current
    /// Host/scene is KEPT (a hostile / oversized `.fab` is a typed error, never a
    /// panic — the 7-step hardened path owns that, threat T-18-LOAD).
    fn load_swap(&mut self, path: &Path) -> bool {
        #[cfg(test)]
        let new_dir = if std::mem::take(&mut self.fail_next_load_work_dir) {
            Err(std::io::Error::other("test: work folder creation failed"))
        } else {
            tempfile::tempdir()
        };
        #[cfg(not(test))]
        let new_dir = tempfile::tempdir();
        let new_dir = match new_dir {
            Ok(d) => d,
            Err(e) => {
                eprintln!(
                    "fabrico-host: Load aborted (work_dir create failed, loop continues): {e}"
                );
                // Phase 90 review (the deferred plan 90-04 item): said on the screen too, at
                // once, as a refused file is. The page showed `Loading...` until its cut-off.
                self.refuse_load(LOAD_WORK_DIR_REFUSAL);
                return false;
            }
        };
        match load_project(path, new_dir.path(), self.snapshot_every) {
            Ok(new_host) => {
                // CFG-01 (Pitfall 5, T-39-SILENT-TIMER): build the host Timer projection
                // from the LOADED user edit-log so a configured Source Timer keeps firing
                // after the swap. `load_project` builds the host with an EMPTY `TimerSet`,
                // so without this a timer-driven board goes silent after a Load.
                //
                // DEMO-08 (plan 85-01): projected onto the loaded host BEFORE
                // `install_swapped_host`, never after it. The swap force-republishes the
                // route table, and the route table now reads the timer set (a Source on
                // Timer has no door), so a projection taken after the swap would publish
                // the loaded file's Timer Sources as open doors until the next edit. This
                // is the same order `load_scene_swap` uses, through the same
                // `timers_from_log`. A failed edit-log read aborts the Load in the same
                // warn-and-keep style as every other early failure here: the current board
                // stays, rather than a loaded board installed with no timers.
                #[cfg(test)]
                let timers = if std::mem::take(&mut self.fail_next_load_timers) {
                    Err(StoreError::Backend("test: edit log unreadable".to_owned()))
                } else {
                    timers_from_log(&new_host)
                };
                #[cfg(not(test))]
                let timers = timers_from_log(&new_host);
                let new_host = match timers {
                    Ok(timers) => new_host.with_timers(timers),
                    Err(e) => {
                        eprintln!(
                            "fabrico-host: Load aborted (timer projection failed, kept current \
                             scene): {e}"
                        );
                        // Phase 90 review (the deferred plan 90-04 item): said on the screen.
                        self.refuse_load(LOAD_TIMERS_REFUSAL);
                        return false;
                    }
                };
                self.install_swapped_host(new_host, new_dir);
                // WR-03: a loaded `.fab` is a USER board - no shipped-scene badge.
                self.loaded_scene = None;
                true
            }
            Err(e) => {
                // KEEP the current scene; `new_dir` drops harmlessly here.
                //
                // The `eprintln!` STAYS. Developer logging is not the thing UNDO-09
                // removes, and it is the only place the Debug shape of the error
                // survives: the user-facing sentence below is the `Display`, which this
                // phase's copy gate holds to no debug payload and no filesystem path.
                eprintln!("fabrico-host: Load refused (kept current scene): {e} ({e:?})");
                // UNDO-09: and now it also reaches a SCREEN. Before this phase the line
                // above was the whole of it: on the shipped desktop binary the user
                // clicked Open, nothing whatsoever happened, and a generic "Load failed"
                // appeared much later on a timeout. `Display`, not `Debug` - the sentence
                // the host already wrote, verbatim.
                self.refuse_load(&e.to_string());
                false
            }
        }
    }

    /// Hand a refused Load's sentence to the load-refusal sink, when a transport wired one
    /// (UNDO-09). Every way `load_swap` keeps the current board goes through here.
    fn refuse_load(&self, reason: &str) {
        if let Some(sink) = self.load_refusal_sink.as_ref() {
            sink(reason.to_owned());
        }
    }

    /// Service a scene-load control ([`ControlMsg::LoadDemo`] /
    /// [`ControlMsg::LoadScene`]): the quiescence check + [`PendingLoad`] latch +
    /// auto-resume tail, parameterized by [`SceneId`] (Phase 55). Every scene
    /// load — demo or example — rides the SAME WR-02 swap-safety latch and
    /// full-keyframe-as-feedback semantics.
    fn control_load_scene(&mut self, id: SceneId) {
        // WR-02: same drain-to-quiescence-before-swap contract as Load.
        if self.ready_to_save_or_swap() {
            // LIVE-03/EX-02: swap in the command-built scene via the host-swap
            // path.
            // No resume tail (phase 90 review WR-A-04): 40-review CR-01's tail resumed a
            // Frozen board with no user hold, which no path reaches any more (the invariant
            // at the end of `step()`). From Playing the demo plays on; a board the user holds
            // stays paused, matching the latched arm and the pause_joined_by_latched tests.
            self.load_scene_swap(id);
        } else {
            self.begin_drain_to_settle();
            self.pending_load = Some(PendingLoad::Scene(id));
        }
    }

    /// Swap in a canonical command-built shipped scene for a
    /// [`ControlMsg::LoadDemo`] / [`ControlMsg::LoadScene`] (LIVE-03 generalized
    /// by EX-02). Build a FRESH genesis Host on THIS sim thread (Core + its
    /// lazily-created rquickjs runtimes are affine to the sim thread - correct
    /// by construction) at the scene's own [`SceneId::genesis_seed`], hand it to
    /// [`boot_scene`] (the ONE boot function every scene and every boot site uses, plan
    /// 85-08, D-02: seed through the certified gesture path, seal, project timers), then
    /// swap + reset + re-seed exactly like Load. Every scene takes the same path; nothing
    /// is minted outside the edit log. Any store/host/scene error is NON-FATAL (warn +
    /// keep the current scene), and every warning names the scene (D-25).
    ///
    /// THE ROUTE TABLE IS NEVER HALF-SEEDED. The whole scene is seeded on the fresh host
    /// before [`install_swapped_host`](Self::install_swapped_host) republishes the routes,
    /// so a POST that arrives during the swap reaches the old board's table or the new
    /// one's, never a board part-way through its commands.
    fn load_scene_swap(&mut self, id: SceneId) {
        let scene = id.wire_id();
        let new_dir = match tempfile::tempdir() {
            Ok(d) => d,
            Err(e) => {
                eprintln!(
                    "fabrico-host: LoadScene \"{scene}\" aborted (work_dir create failed, loop continues): {e}"
                );
                return;
            }
        };
        let core = Core::genesis(LogHeader {
            schema_version: SCHEMA_VERSION,
            seed: id.genesis_seed(),
        });
        let store = match RedbStore::open(new_dir.path().join("log.redb")) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("fabrico-host: LoadScene \"{scene}\" aborted (store open failed): {e}");
                return;
            }
        };
        let ledger = match DispatchLedger::open(new_dir.path().join("ledger.redb")) {
            Ok(l) => l,
            Err(e) => {
                eprintln!("fabrico-host: LoadScene \"{scene}\" aborted (ledger open failed): {e}");
                return;
            }
        };
        // 20-review CR-01 (HOST-06 parity): mirror the boot order - install a
        // persisted seen-set in the new work_dir BEFORE the swap. The webhook
        // listener stays bound across the swap and `install_swapped_host`
        // force-republishes routes, so ingress actively flows into the swapped
        // host; without a seen-set `record_delivery` returns `true` for every
        // delivery id and a provider's at-least-once retry double-fires a Source.
        let seen = match SeenSet::open(new_dir.path().join("seen.redb")) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("fabrico-host: LoadScene \"{scene}\" aborted (seen-set open failed): {e}");
                return;
            }
        };
        let new_host = match Host::new(core, store, ledger, self.snapshot_every) {
            Ok(h) => h.with_seen_set(seen),
            Err(e) => {
                eprintln!("fabrico-host: LoadScene \"{scene}\" aborted (host open failed): {e}");
                return;
            }
        };
        // WR-08: a scene that fails to materialize or seed is NON-FATAL here, like the
        // five siblings above: the single-threaded sim thread must not abort at an
        // arbitrary user click. The error's own sentence leads with the scene's wire id.
        let new_host = match boot_scene(new_host, id) {
            Ok(h) => h,
            Err(e) => {
                eprintln!("fabrico-host: LoadScene aborted (loop continues): {e}");
                return;
            }
        };
        self.install_swapped_host(new_host, new_dir);
        // WR-03: the board now HOLDS this shipped scene. Written only here, after
        // the swap actually installed - every early `return` above keeps the
        // current scene AND therefore the current identity.
        self.loaded_scene = Some(id);
    }

    /// Swap in a truly EMPTY genesis board for a [`ControlMsg::New`] (SAVE-04: the
    /// toolbar "New" CTA). This is [`load_scene_swap`](Self::load_scene_swap) with the
    /// scene boot removed (no commands seeded, no timers projected): a fresh genesis Host built on THIS sim thread at the
    /// fixed [`NEW_GENESIS_SEED`], swapped + reset + re-seeded exactly like Load, but
    /// with ZERO nodes and NO timers (a New board must never inject the demo item
    /// stream). Any store/host error is NON-FATAL (warn + keep the current scene),
    /// mirroring `load_scene_swap`. Seeds NOTHING — reintroducing any seed step here
    /// would reintroduce the demo/cert surface.
    fn new_swap(&mut self) {
        let new_dir = match tempfile::tempdir() {
            Ok(d) => d,
            Err(e) => {
                eprintln!(
                    "fabrico-host: New aborted (work_dir create failed, loop continues): {e}"
                );
                return;
            }
        };
        let core = Core::genesis(LogHeader {
            schema_version: SCHEMA_VERSION,
            seed: NEW_GENESIS_SEED,
        });
        let store = match RedbStore::open(new_dir.path().join("log.redb")) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("fabrico-host: New aborted (store open failed): {e}");
                return;
            }
        };
        let ledger = match DispatchLedger::open(new_dir.path().join("ledger.redb")) {
            Ok(l) => l,
            Err(e) => {
                eprintln!("fabrico-host: New aborted (ledger open failed): {e}");
                return;
            }
        };
        // HOST-06 parity (same rationale as load_scene_swap): install a persisted
        // seen-set in the new work_dir BEFORE the swap so a provider's at-least-once
        // retry cannot double-fire a Source on the swapped-in (empty) host.
        let seen = match SeenSet::open(new_dir.path().join("seen.redb")) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("fabrico-host: New aborted (seen-set open failed): {e}");
                return;
            }
        };
        let new_host = match Host::new(core, store, ledger, self.snapshot_every) {
            Ok(h) => h.with_seen_set(seen),
            Err(e) => {
                eprintln!("fabrico-host: New aborted (host open failed): {e}");
                return;
            }
        };
        // Seeds NOTHING (SAVE-04): no scene commands and no timer projection
        // run here — the board is genesis-empty (0 nodes). Swap it in
        // via the shared Load/LoadDemo tail (producer reset + tick re-seed + route
        // republish).
        self.install_swapped_host(new_host, new_dir);
        // WR-03: an empty board is a USER board, not a shipped scene - the badge
        // must go absent, exactly as `doNew` already clears it frontend-side.
        self.loaded_scene = None;
    }

    /// The shared tail of a host swap (Load + LoadDemo): install the new Host,
    /// RESET the producer over the diff broadcast (HOST-05 — never dark), re-seed
    /// the loop tick from the loaded core (IN-01), and only then take ownership of
    /// the new work_dir so the OLD dir drops AFTER the old Host is released.
    fn install_swapped_host(&mut self, new_host: Host, new_dir: tempfile::TempDir) {
        // F4: drain the correlation registry BEFORE the swap. Sockets parked against
        // the DISCARDED pre-swap timeline cannot be answered by the loaded scene
        // (their correlation/deadline belong to a timeline that no longer exists), so
        // resolve each with a deterministic 503 ("scene reloaded") and clear the map.
        // The loaded scene then starts with an EMPTY registry — matching crash
        // recovery, which rebuilds a fresh empty registry (the asymmetry this fixes).
        // Host-side socket writes only: nothing enters the sim fold or the log.
        self.registry.drain_all(HttpResponse::reloaded_503);
        // REVIEW ROUND 4 WR-01 (plan 74.1-32) AND ROUND 5 CR-01 (plan 74.1-35): DISCARD
        // EVERY EDIT QUEUED ON THE BOARD BEING REPLACED, before the new board is installed.
        //
        // Two things can be waiting. (a) An Undo or Redo HELD by plan 74.1-23's rule: it
        // was met behind other records in a drain pass and is applied first on the next
        // pass. (b) Every envelope still in `gesture_rx`: while the sim is Frozen (a user
        // pause) or Draining, `step()` never calls `acquire_input`, so a Place, DrawBelt,
        // Delete or Dock made on a paused board waits there. Left alone, either one was
        // applied to the NEW board by the first pass after the swap: a held Undo took the
        // loaded file's last action back, and a queued Delete removed whatever node the new
        // board gave its handle (the review reproduced both against the real host), while
        // the transport was told "Ok".
        //
        // Every successful swap reaches this tail: `load_swap` (only on `Ok`, so a REFUSED
        // Load drains nothing and its queued edit still folds onto the board it was made
        // on), `load_scene_swap` and `new_swap`, through the immediate Load, LoadDemo,
        // LoadScene and New arms and the latched `PendingLoad` arm in `step()`.
        //
        // WHY DRAINING THE CHANNEL HERE IS EXACT. Both transports enqueue a gesture inline,
        // before any control sent after it: Tauri `submit_input` is a blocking command
        // (pinned by `submit_input_is_a_blocking_command_so_the_enqueue_is_inline` in
        // `fabrico-app`) and the swap commands enqueue inline after it; the dev WebSocket
        // forwards binary and text frames from one loop in arrival order. `step()` services
        // control before `acquire_input`. So at the swap `gesture_rx` holds exactly what was
        // sent before the swap was serviced: every gesture a hand made on the old board,
        // and nothing sent after it. An AUTOMATIC follow-up send (an owed Dock, a queued
        // Rotate) fired by an old-board echo packet still in transit at the swap instant
        // arrives after this drain, but since phase 88 (plan 88-04, D-02, D-05) every gesture
        // frame carries the generation its handles were read from, and `reset_for_swap` sets
        // a floor above every pre-swap generation, so `apply_as_seen` answers such a frame
        // `gestureDiscarded` and applies nothing (threat T-74.1-122, closed; measured by
        // `a_gesture_from_before_a_load_is_discarded` in `tests/edit_lands_where_aimed.rs`).
        //
        // Each dropped envelope is ANSWERED `gestureDiscarded` (phase 88, D-05, D-06), so the
        // client can end that gesture's pending entry at once instead of waiting it out. No
        // sentence goes with it (a default, open to change): the user
        // asked for the old board to be replaced, and a message on the new board about the
        // old one would be noise; "Nothing left to undo." would also be false of a loaded
        // board that carries history. An accept still waiting for its tick is answered the
        // same way: its records were in the old host's pending buffer and never fold. The one
        // host-side record is a standard-error line naming how many were dropped. Nothing
        // dropped here ever reached the log, so the fold and every replay are unchanged.
        let mut discarded = 0usize;
        if let Some(env) = self.held_undo_redo.take() {
            discarded += 1;
            if let Some(sink) = env.verdict {
                sink.discarded();
            }
        }
        while let Ok(env) = self.gesture_rx.try_recv() {
            discarded += 1;
            if let Some(sink) = env.verdict {
                sink.discarded();
            }
        }
        for pending in self.pending_accepts.drain(..) {
            discarded += 1;
            if let Some(sink) = pending.sink {
                sink.discarded();
            }
        }
        if discarded > 0 {
            eprintln!(
                "fabrico-host: board swap discarded {discarded} edit(s) queued on the replaced board"
            );
        }
        // Installing the new Host DROPS the old one first (releasing the old
        // store's file handles) BEFORE the old work_dir is freed below.
        self.host = new_host;
        // Phase 88 (D-05, Pitfall 1): a swap clears the kept handle tables and sets the swap
        // floor, so a gesture stamped on the replaced board (including an automatic
        // follow-up an old-board echo fires after this point) is answered discarded in
        // `acquire_input` and never resolves to a node of this board.
        if let Err(e) = self.producer.reset_for_swap(&self.host) {
            eprintln!("fabrico-host: swap producer reset encode error (loop continues): {e}");
        }
        // IN-01: re-seed the loop tick from the loaded core at the swap.
        self.tick = self.host.core().tick;
        self.correlation_next = self.correlation_next.max(correlation_after_log(&self.host));
        // HOST-07: FORCE one route-projection re-publish from the loaded core's
        // Source set so the loaded scene's Sources are reachable over the webhook
        // immediately (the swap bypasses the per-tick gesture-fold recompute path).
        self.force_republish_routes();
        // Take ownership of the new work_dir; the OLD one drops HERE (after the
        // old Host was released above), never before.
        self._work_dir = Some(new_dir);
    }

    /// The input-acquisition / drain seam — the ONLY place upstream input enters
    /// the sim, gated OUTSIDE the shared [`tick_body`](Self::tick_body) so its
    /// held-input semantics can never leak into the single-path body. Playing and
    /// Step both call it; Draining SKIPS it (holding new input while it settles).
    ///
    /// Order (lifted verbatim from the old combined `step`):
    /// 1. **pre_tick hook** — dev-only demo injection on a cadence; no-op when
    ///    `None` (the shell).
    /// 2. **webhook drain + dedup** — the seen-set delivery-id dedup + non-fatal
    ///    `WR-03` swallow; acks are collected into `pending_acks` and flushed
    ///    AFTER the tick in `tick_body`.
    /// 3. **gesture drain + apply** — disjoint FIELD borrows (Pitfall 1).
    ///
    /// # Errors
    /// Currently infallible in practice (returns `Ok`); the `Result` keeps the
    /// seam symmetric with `tick_body` for a future fallible input source.
    fn acquire_input(&mut self) -> Result<(), StoreError> {
        // (1) dev pre-tick demo injection — no-op when None (shell).
        if let Some(hook) = self.pre_tick.as_mut() {
            hook(self.tick, &self.ingress_tx);
        }

        // (2) Webhook ingress: dedup on the host loop BEFORE logging (INGRESS-02),
        //     absorbed VERBATIM from the old driver::run. A NEW delivery id is
        //     recorded durably and enqueued as a ManualInject for this tick's
        //     append; a duplicate is dropped. Acks are buffered on `pending_acks`
        //     and sent AFTER the tick (in tick_body).
        if let Some(rx) = self.webhook_rx.as_mut() {
            while let Ok(ing) = rx.try_recv() {
                let Ingress {
                    target,
                    delivery_id,
                    body,
                    ack,
                } = ing;
                // Dedup ONLY when a delivery id is present. An absent id (`None`) is
                // always unique (WR-01). A seen-set store error here is NON-FATAL
                // (WR-03): drop just this one request, warn, ack it, keep ticking —
                // a failed record committed nothing, so the single-writer invariant
                // holds.
                let is_new = match &delivery_id {
                    Some(id) => match self.host.record_delivery(id) {
                        Ok(new) => new,
                        Err(e) => {
                            eprintln!(
                                "fabrico-host: dropping webhook delivery (seen-set error, \
                                 loop continues): {e}"
                            );
                            false
                        }
                    },
                    None => true,
                };
                if is_new {
                    let _ = self.ingress_tx.send(EventPayload::ManualInject {
                        target,
                        port: 0,
                        item: Item(body),
                    });
                }
                self.pending_acks.push(ack);
            }
        }

        // (2b) Endpoint ingress (ENDP-01): mint a monotonic correlation on the SIM
        //      THREAD (single-threaded -> deterministic-ordered, no collision across
        //      the many requests hitting one endpoint — Pitfall 5), park the caller's
        //      socket in the shared registry keyed on the LOGGED deadline_tick, and
        //      enqueue an `EventPayload::WireRequest` (NOT a ManualInject). Past the
        //      registry cap `try_park` hands the sender BACK (Err): resolve it with a
        //      503 and DO NOT enqueue (the DoS space bound, ENDP-04). The deadline is
        //      `self.tick + DEFAULT_ENDPOINT_DEADLINE_TICKS` — the deterministic core
        //      tick at ingress, never a wall clock.
        if let Some(rx) = self.endpoint_rx.as_mut() {
            while let Ok(ing) = rx.try_recv() {
                let EndpointIngress {
                    target,
                    envelope,
                    respond,
                } = ing;
                let correlation = self.correlation_next;
                self.correlation_next += 1;
                let deadline_tick = self.tick + DEFAULT_ENDPOINT_DEADLINE_TICKS;
                if let Err(respond) = self.registry.try_park(correlation, deadline_tick, respond) {
                    // Over the cap: refuse deterministically with a 503, enqueue nothing.
                    let _ = respond.send(HttpResponse::service_unavailable_503());
                    continue;
                }
                // The reply routes back to the endpoint node's reply port. Port 0 by
                // convention: Node::Endpoint is inert in `step_node` this milestone
                // (the reverse transport is decorative until Phase 40), so the exact
                // index is not correctness-load-bearing yet.
                let _ = self.ingress_tx.send(EventPayload::WireRequest {
                    correlation,
                    deadline_tick,
                    budget: fabrico_core::wire::DEFAULT_WIRE_BUDGET,
                    return_addr: (target, 0),
                    payload: Item(envelope),
                });
            }
        }

        // (3) Gestures — DISJOINT field borrows (Pitfall 1): bind &producer first so
        //     the closure does not re-borrow all of `self` while `&mut self.host` is
        //     live.
        //
        // CR-01 AND N3-RACE: THE UNDO RULE HAS TWO HALVES.
        //
        // An Undo/Redo gesture resolves against the session's frozen `&self` projection
        // (undo cursor / xlate), which is ONLY refreshed by `reconstruct_projection`
        // inside `fold_live`, i.e. once per tick, AFTER this drain. Every record already
        // enqueued in this pass is therefore INVISIBLE to an Undo resolved now.
        //
        // 1. An Undo or Redo is applied ONLY AT THE START OF A PASS, when the host's
        //    pending buffer is empty (plan 74.1-23, GAP N3-RACE). One met after any
        //    gesture that enqueued records in this pass is HELD in `held_undo_redo`,
        //    its reply untouched, and applied first on the next pass, where its reply
        //    is sent. Before this, a Dock and a Ctrl+Z drained together resolved the
        //    Undo against a projection without the Dock: it named the previous action
        //    (the second belt's DrawBelt) and deleted that belt, and the projection
        //    then left undo dead (the walk log: seq 73 Dock, 74 Undo{target 53}, 75
        //    Delete, one tick).
        // 2. An Undo or Redo STILL ENDS THE PASS (CR-01). Two drained in one pass would
        //    both resolve against the same not-yet-folded cursor, target the same
        //    action, and desync the cursor from the core (duplicate inverse groups, a
        //    later redo re-mints a live node, a leak). Remaining queued gestures stay in
        //    the channel for the next tick.
        //
        // Normal gestures still batch freely: they enqueue resolved records that fold
        // EDITS-FIRST and do not read the cursor. Only undo/redo pays a tick boundary
        // (~16ms each, imperceptible). A held envelope is answered exactly once, by the
        // pass that applies it; while it is held nothing behind it in the channel is
        // drained, so gestures keep their order. A successful board swap drops the held
        // envelope AND every gesture still queued behind it, answering each discarded
        // (`install_swapped_host`, review round 4 WR-01 and round 5 CR-01, phase 88 D-05), so
        // nothing drained here was made on a board other than the one it is applied to.
        let producer = &self.producer;
        if let Some(env) = self.held_undo_redo.take() {
            if !self.host.pending_edits().is_empty() {
                // Still records ahead of it (only reachable when a caller drains twice
                // without a tick between): keep holding, drain nothing behind it.
                self.held_undo_redo = Some(env);
                return Ok(());
            }
            let first = minting_records(self.host.pending_edits());
            match Self::apply_as_seen(&mut self.host, producer, env.cmd, env.generation) {
                Some(verdict) => Self::answer_or_defer(
                    &mut self.pending_accepts,
                    &self.host,
                    env.verdict,
                    first,
                    verdict,
                ),
                None => Self::answer_discarded(env.verdict),
            }
            // Half 2: the undo/redo ends the pass.
            return Ok(());
        }
        while let Ok(env) = self.gesture_rx.try_recv() {
            // Captured BEFORE the call, because `env.cmd` moves into
            // `apply_gesture_frame`.
            //
            // A RUN-PACE FRAME IS NOT A TICK-BOUNDARY GESTURE, and the narrowing below
            // is deliberate rather than incidental: the match names the `Cmd` variant
            // explicitly and has NO catch-all arm that could sweep the run frame in.
            // The rule and its reason are stated above - undo and redo resolve against
            // a projection refreshed only once per tick, whereas "Normal gestures still
            // batch freely (they enqueue resolved records that fold EDITS-FIRST and do
            // not read the cursor)". A run frame enqueues resolved records, so it
            // batches like every other normal gesture.
            let is_undo_redo = matches!(
                env.cmd,
                GestureFrame::Cmd(GridCommand::Undo | GridCommand::Redo)
            );
            // Half 1: an undo/redo behind records enqueued in this pass waits for them
            // to fold. The `held` envelope is applied first on the next pass.
            if is_undo_redo && !self.host.pending_edits().is_empty() {
                self.held_undo_redo = Some(env);
                break;
            }
            // ERR-01: this verdict used to be discarded here, which is why every typed
            // refusal the command layer produces - a MediumMismatch, an occupancy
            // conflict, an invalid dock - presented to the user as nothing happening.
            // The taxonomy crosses to the wire ONCE, here, so both transports carry the
            // same shape and neither can invent a spelling of its own (D-31).
            let first = minting_records(self.host.pending_edits());
            // A refusal is answered now; an accept waits for its tick (`tick_body`); a
            // gesture made on a board a swap replaced is answered discarded and applies
            // nothing. The receiver may already be gone - the webview reloaded, the socket
            // closed - and that is not an error and never aborts the drain.
            match Self::apply_as_seen(&mut self.host, producer, env.cmd, env.generation) {
                Some(verdict) => Self::answer_or_defer(
                    &mut self.pending_accepts,
                    &self.host,
                    env.verdict,
                    first,
                    verdict,
                ),
                None => Self::answer_discarded(env.verdict),
            }
            if is_undo_redo {
                break;
            }
        }

        Ok(())
    }

    /// Apply one drained gesture with its handles resolved against the handle table its
    /// header names (phase 88, D-02, D-03, D-05): the table the client read them from, so an
    /// edit queued behind an Undo lands on the node the user picked, never on whatever a
    /// re-minted handle names after the Undo's reset. Both drain sites (the held Undo or
    /// Redo and the loop) come through here.
    ///
    /// - `generation: None` (an in-process sender) resolves against the current table.
    /// - Below the swap floor: `None`, nothing applied; the caller answers it discarded.
    /// - Above the board's current generation: refused `Malformed` (only a forged header
    ///   can say it), nothing applied.
    /// - On this board but past the kept history: a frame that names a handle is refused
    ///   `BoardChanged`, nothing applied: the edit is refused rather than applied to a node
    ///   the host cannot name. A frame that names none (a Place, a DrawBelt, an Undo, a Redo)
    ///   reads no table, so it is applied (phase 88 review, IN-03): refusing it would be a
    ///   sentence about a table the gesture never read.
    /// - Otherwise each handle resolves through that table; a handle the table never
    ///   minted, or one naming a node since removed, fails as `UnknownNode`.
    ///
    /// Every gesture takes the floor and the ahead checks, Undo and Redo included: they carry
    /// no handle, but a gesture made on a board a swap replaced, or a forged generation, reads
    /// the same on them as on any edit.
    fn apply_as_seen(
        host: &mut Host,
        producer: &RenderProducer,
        cmd: GestureFrame,
        generation: Option<u64>,
    ) -> Option<Result<(), CommandErrorView>> {
        let Some(seen) = generation else {
            return Some(
                apply_gesture_frame(host, cmd, |h| producer.node_for_handle(h))
                    .map_err(CommandErrorView::from),
            );
        };
        match producer.check_generation(seen) {
            Ok(()) => Some(
                apply_gesture_frame(host, cmd, |h| match producer.resolve_at(seen, h) {
                    Resolved::Node(id) => Some(id),
                    Resolved::Gone | Resolved::TooOld | Resolved::Discard | Resolved::Ahead => None,
                })
                .map_err(CommandErrorView::from),
            ),
            Err(Resolved::Discard) => None,
            Err(Resolved::Ahead) => Some(Err(CommandErrorView::from(CommandError::Malformed))),
            // Past the kept history but naming no handle: nothing to resolve, so applied. The
            // resolver answers nothing, so it could not misname a node if it were ever asked.
            Err(Resolved::TooOld) if !cmd.names_a_handle() => {
                Some(apply_gesture_frame(host, cmd, |_| None).map_err(CommandErrorView::from))
            }
            // `check_generation` answers only Discard, Ahead or TooOld; Node and Gone are
            // handle answers and cannot come back from it.
            Err(Resolved::TooOld | Resolved::Node(_) | Resolved::Gone) => {
                Some(Err(CommandErrorView::from(CommandError::BoardChanged)))
            }
        }
    }

    /// Answer a gesture made on a board a swap replaced (phase 88, D-05): discarded, no
    /// sentence, as `install_swapped_host` answers the gestures it drops.
    fn answer_discarded(sink: Option<VerdictSink>) {
        if let Some(sink) = sink {
            sink.discarded();
        }
    }

    /// Answer one drained gesture (phase 88, D-06): a refusal through its sink at once, an
    /// accept deferred to [`tick_body`](Self::tick_body) with the minting positions its records
    /// took (`first` counted before it was applied, the count after). An entry is kept for a
    /// sink-less accept too, so the positions of the accepts after it stay aligned.
    fn answer_or_defer(
        pending_accepts: &mut Vec<PendingAccept>,
        host: &Host,
        sink: Option<VerdictSink>,
        first: usize,
        verdict: Result<(), CommandErrorView>,
    ) {
        match verdict {
            Err(tag) => {
                if let Some(sink) = sink {
                    sink.refused(tag);
                }
            }
            Ok(()) => {
                let count = minting_records(host.pending_edits()).saturating_sub(first);
                pending_accepts.push(PendingAccept { sink, first, count });
            }
        }
    }

    /// THE single-path per-tick body Step and the live path BOTH call — it
    /// carries NO run-state / pause / draining branch and NO input drain (input
    /// acquisition lives ONLY in [`acquire_input`](Self::acquire_input)). Because
    /// one code path cannot diverge from itself, this is what makes
    /// `step×N == live×N` true BY CONSTRUCTION (Task 3's `step_equals_live` is the
    /// guard against a future refactor splitting them).
    ///
    /// Order:
    /// 1. **`host.tick_once`** — the shared deterministic fold (unchanged).
    /// 2. **`producer.on_tick`** — the W2 single-producer step (read-only on
    ///    Core/log; its `postcard::Error` is mapped into [`StoreError::Backend`]).
    /// 3. **ack AFTER the tick** — flush the `pending_acks` collected in
    ///    `acquire_input` (empty — hence a no-op — whenever `acquire_input` was
    ///    skipped while Draining).
    /// 4. **IN-01 tick seed** — `self.tick = host.core().tick` (seed from core,
    ///    never an independent counter), so a pre_tick cadence stays aligned.
    ///
    /// # Errors
    /// Returns [`StoreError`] if `tick_once` fails to append/persist, or if
    /// `producer.on_tick` fails to encode (mapped to [`StoreError::Backend`]).
    fn tick_body(&mut self) -> Result<(), StoreError> {
        // (0a) CFG-01 re-projection guard: capture whether THIS tick folds any topology
        //      edit BEFORE `tick_once` drains the buffer. A gesture tick (Place /
        //      Configure / Delete / Undo / Redo) may have installed, changed, or cleared
        //      a Source `Timer` trigger, so the host Timer projection must be re-derived
        //      after the fold. Cheap: `pending_edits` is an in-memory `Vec` (O(1)
        //      is_empty), and it is empty on every IDLE tick and while Draining (input is
        //      held) — so the re-projection never churns an idle/quiescing grid
        //      (Pitfall 5), mirroring how the route re-derive is fingerprint-guarded.
        let folded_edits = !self.host.pending_edits().is_empty();
        // (0b) Phase 88 (D-06): how many minting records this tick folds, so the accepts
        //      flushed after it can check `core.last_tick.placed` lists exactly that many.
        let minting_folded = minting_records(self.host.pending_edits());
        // (0c) Phase 88 review IN-04: this tick's accepts are taken out NOW, before any fallible
        //      step. Their minting positions are slices of THIS tick's `last_tick.placed`, so if
        //      a `?` below returns they must not survive to be sliced out of the next tick's list
        //      (an accept paired with another gesture's handle, the misattribution the deferral
        //      exists to prevent). On an early return the local is dropped: each sink is dropped
        //      unanswered, which is silence, and the client's own fallback ends the gesture.
        let accepts = std::mem::take(&mut self.pending_accepts);

        // (0) Timer-ingress gate (Finding 3): HOLD timers while Draining ONLY, so
        //     the drain can reach quiescence instead of being re-fed every tick.
        //     Computed here from run_state so the body stays genuinely
        //     single-path: Playing reaches tick_body with run_state == Playing and
        //     the Step control arm reaches it with run_state == Frozen — BOTH fire
        //     timers identically (step×N == live×N, HOST-03); only the Draining
        //     arm holds them, the exact analog of acquire_input being skipped
        //     while Draining.
        self.host.set_timers_gated(self.run_state == RunState::Draining);

        // (1) The shared deterministic fold.
        self.host.tick_once(&mut self.ingress_rx, &mut self.results_rx, &self.cmd_tx)?;

        // (1a) CFG-01: re-project the host Timer set after any edit folds this tick
        //      (a `Configure{Source, Timer/Webhook}` installs/changes/clears a live
        //      timer). This is the per-change re-derive analog of `maybe_republish_routes`
        //      below: the Source Timer trigger is NOT a snapshot field, so it is
        //      projected from the certified edit-log (`project_timers`), and the swap
        //      takes effect from the NEXT tick's `due_events`. Guarded by `folded_edits`
        //      so it runs only on gesture ticks, never idle/quiescing ones (Pitfall 5).
        //
        //      It runs BEFORE (1b), never after (DEMO-08, plan 85-01): the route table
        //      leaves out every Source on Timer and its fingerprint carries each Source's
        //      interval, both read from this timer set. Republishing first would build the
        //      doors from the PREVIOUS gesture's triggers, so a Timer/Webhook flip, or an
        //      Undo or Redo of one, would move its door one gesture late.
        if folded_edits {
            let edits = self.host.logged_edits()?;
            self.host.set_timers(project_timers(&edits));
        }

        // (1b) HOST-07 / ENDP-05: a gesture folded EDITS-FIRST in `tick_once` above
        //      may have placed or deleted a Source OR an Endpoint, or flipped a Source's
        //      trigger. Re-publish the LIVE route projection ONLY when the routable set
        //      actually changed (fingerprint guard), never every tick (Pitfall 5: Arc
        //      churn on idle grids) and never on a non-routable gesture (a Rotate, or a
        //      non-Source/non-Endpoint placement).
        //      NOTE (Area 3 Q4): the SAME fingerprint-guarded republish is the ONLY
        //      route-table rebuild an undo/redo needs: an undo/redo that changes the
        //      routable set flips the `route_ids` fingerprint here and republishes the
        //      routes via the existing path; an undo/redo that leaves the routable set
        //      unchanged is deduped to a no-op. NO bespoke post-undo route hook is added
        //      (Pitfall: double-publish / Arc churn).
        self.maybe_republish_routes();

        // (1c) ENDP-03: the per-tick host-side deadline sweep. Runs AFTER the fold so
        //      a reply that resolved this tick has already removed its correlation
        //      (reply wins ties). Reads ONLY the deterministic core tick + each
        //      request's LOGGED deadline_tick — never a wall clock — and writes only
        //      sockets, never the fold (the determinism boundary).
        self.sweep_endpoint_deadlines();

        // (2) The W2 per-tick producer step; unify its postcard::Error (Pitfall 6).
        //     UNDO-06 never-dark (Pitfall 3): a tick that folded an undo/redo group
        //     re-mints render ids and cascade-restores belts — a diff CANNOT express
        //     that, so instead of the normal diff broadcast we push a `full:true`
        //     keyframe over the diff channel (RenderProducer::reset, the Phase 18
        //     never-dark mechanism). Already-connected subscribers clear+repopulate
        //     inline; the primed builder baseline makes the next tick's diff empty.
        //     Fires EXACTLY on undo/redo-folding ticks — every other tick takes the
        //     normal active-set diff path.
        #[cfg(test)]
        if std::mem::take(&mut self.fail_next_producer_step) {
            return Err(StoreError::Backend("producer: injected failure (test)".to_owned()));
        }
        if self.host.took_undo_redo_this_tick() {
            self.producer
                .reset(&self.host)
                .map_err(|e| StoreError::Backend(format!("producer reset: {e}")))?;
        } else {
            self.producer
                .on_tick(&self.host)
                .map_err(|e| StoreError::Backend(format!("producer: {e}")))?;
        }

        // (3) Ack every accepted request AFTER the tick that logged it (idempotent).
        //     Empty (no-op) when acquire_input was skipped this tick (Draining).
        for ack in self.pending_acks.drain(..) {
            let _ = ack.send(());
        }

        // (3a) Phase 88 (D-06): answer every gesture accepted in this pass, AFTER the tick
        //      that folded it and after the producer step above, the way the webhook acks
        //      above are answered. Each accept names the render handles its records minted:
        //      its slice of `core.last_tick.placed` (1:1 with the tick's minting records, in
        //      fold order) mapped through the handle table the producer just built, in that
        //      table's generation. If the list does not have exactly the count the drain
        //      enqueued (a minting fold added in `fabrico-core` without updating
        //      `minting_records`), every accept goes out with an EMPTY `minted` list and one
        //      standard-error line, so the client falls back on its own timer rather than
        //      pairing a gesture with another gesture's handle. Empty (no-op) while Draining.
        if !accepts.is_empty() {
            let placed = &self.host.core().last_tick.placed;
            let agree = placed.len() == minting_folded;
            if !agree {
                eprintln!(
                    "fabrico-host: {} accept(s) answered with no minted handles: the tick minted {} id(s) for {} minting record(s)",
                    accepts.len(),
                    placed.len(),
                    minting_folded
                );
            }
            let generation = self.producer.generation();
            for pending in accepts {
                let Some(sink) = pending.sink else { continue };
                let minted = if agree {
                    placed
                        .get(pending.first..pending.first + pending.count)
                        .unwrap_or_default()
                        .iter()
                        .filter_map(|id| self.producer.handle_for_node(*id))
                        .collect()
                } else {
                    Vec::new()
                };
                sink.accepted(generation, minted);
            }
        }

        // (4) IN-01: seed the loop tick from core, not an independent counter.
        self.tick = self.host.core().tick;
        Ok(())
    }

    /// Re-publish the LIVE webhook route projection (HOST-07) IFF the Source-set
    /// membership changed since the last publish. Compares the cheap
    /// [`route_ids`] fingerprint (Sources AND Endpoints); on a change it stores the
    /// new fingerprint and swaps a FRESH immutable `Arc<BTreeMap>` (a fold of
    /// `core.state`) over the `watch` — so every currently-connected webhook/endpoint
    /// handler sees the new label on its next request. An unchanged routable set is a
    /// no-op (no `Arc` allocation, no `watch` send), which is what keeps idle-grid
    /// ticks free of route churn.
    fn maybe_republish_routes(&mut self) {
        let fingerprint = route_ids(self.host.core(), self.host.timers());
        if fingerprint != self.route_fingerprint {
            self.route_fingerprint = fingerprint;
            // `send_replace` (not `send`): the route table is SHARED STATE that must
            // persist even when no webhook handler has subscribed YET — a plain
            // `send` errors and DISCARDS the update when the receiver count is zero,
            // so a Source placed before the listener connects would be lost. A later
            // `routes_receiver()` then sees the up-to-date snapshot (HOST-07).
            self.routes_tx
                .send_replace(Arc::new(project_routes(self.host.core(), self.host.timers())));
        }
    }

    /// FORCE one route-projection re-publish (HOST-07) regardless of the fingerprint
    /// — used right after a host swap (Load / LoadDemo) so the loaded scene's
    /// Sources route IMMEDIATELY, even though the swap did not go through the
    /// per-tick gesture-fold path. Resets the fingerprint to the loaded core's
    /// Source set and swaps a fresh `Arc`.
    fn force_republish_routes(&mut self) {
        self.route_fingerprint = route_ids(self.host.core(), self.host.timers());
        // `send_replace` so the loaded scene's routes persist even if no webhook
        // handler has subscribed yet (see `maybe_republish_routes`). Every swap path
        // installs the new host's timers BEFORE it reaches here (DEMO-08), so a loaded
        // Source on Timer is published without a door from the first request.
        self.routes_tx
            .send_replace(Arc::new(project_routes(self.host.core(), self.host.timers())));
    }

    /// The per-tick host-side deadline sweep (ENDP-03). Reads ONLY `now =
    /// core.tick` (the deterministic logical clock the `WireRequest.deadline_tick`
    /// was minted against — NEVER a wall-clock read) and 504s every parked
    /// correlation whose deadline STRICTLY passed `now` (`deadline < now`, so a
    /// reply that lands ON the deadline tick wins the tie — Pitfall 3 / D1). The
    /// `remove` inside [`Registry::resolve`] is the single-writer exactly-once gate
    /// (ENDP-04): a timeout racing a late `Effect::Reply` writes the socket exactly
    /// once with NO cross-thread synchronization — whichever resolves first wins,
    /// the loser finds `None` and drops. The core emits NO Timeout event for an
    /// endpoint request; the sweep touches only sockets, never the fold, so the
    /// golden corpus stays frozen (the determinism boundary).
    fn sweep_endpoint_deadlines(&mut self) {
        let now = self.host.core().tick;
        for correlation in self.registry.expired_correlations(now) {
            self.registry.resolve(correlation, HttpResponse::timeout_504());
        }
    }

    /// CR-01 (40-review): the no-hang guarantee for endpoint ingress while the sim
    /// is NOT actively ticking. The per-tick endpoint drain (`acquire_input`) and the
    /// 504 deadline sweep (`tick_body`) run only under `Playing`, so a
    /// `POST /endpoint/<path>` arriving while `Frozen`/`Draining` would otherwise sit
    /// in the bounded channel with its `respond` oneshot held forever (no timeout
    /// path — the F2 over-cap 503 and F4 dropped-sender 503 do not fire for a merely
    /// HELD request). A quiescent/frozen scene cannot answer it, so drain the channel
    /// and refuse each newly-arriving request with a deterministic 503 — the same
    /// host-side-socket-only refusal as the over-cap and swap paths (nothing enters
    /// the fold or the log, the golden corpus stays frozen).
    fn refuse_endpoint_ingress_while_not_playing(&mut self) {
        if let Some(rx) = self.endpoint_rx.as_mut() {
            while let Ok(ing) = rx.try_recv() {
                let _ = ing.respond.send(HttpResponse::service_unavailable_503());
            }
        }
    }

    /// The webhook analog of [`refuse_endpoint_ingress_while_not_playing`]
    /// (ROBUST-01, race-closer): `acquire_input` — the only webhook drain — runs ONLY
    /// under `Playing`, so a request that passed Gate A while Playing and was enqueued
    /// just before the sim transitioned to Draining/Frozen would otherwise sit in the
    /// bounded channel with its `ack` oneshot held until Resume. Drain the channel and
    /// DROP each ack: the handler's existing `Err(RecvError) => 503` arm
    /// (`webhook.rs`) turns a dropped ack into a deterministic 503, so nothing is
    /// recorded, logged, or left parked across a pause (drop-with-503-never-200). With
    /// Gate A present this almost never has work, but it closes the enqueue-then-pause
    /// race deterministically. Nothing enters the fold or the log — the golden corpus
    /// stays frozen.
    fn refuse_webhook_ingress_while_not_playing(&mut self) {
        if let Some(rx) = self.webhook_rx.as_mut() {
            while let Ok(ing) = rx.try_recv() {
                drop(ing.ack);
            }
        }
    }

    /// THE canonical per-tick entrypoint every loop drives. Services control at
    /// the tick boundary, then gates on the run model:
    ///
    /// - **Playing** → `acquire_input()` then `tick_body()` (input applied).
    /// - **Draining** → `tick_body()` ONLY (SKIP `acquire_input()` so new
    ///   upstream input is HELD — buffered webhooks/gestures stay FIFO); after the
    ///   body, freeze once quiescent
    ///   (`in_flight_len()==0 && belt_items_in_flight()==0`) OR the bounded
    ///   max-settle-tick budget is exhausted (a hung effect can't spin forever).
    /// - **Frozen** → a no-op (no input, no tick).
    ///
    /// The held-input gating lives ENTIRELY in this run-state match; it never
    /// enters `tick_body`, so Playing and Step keep a genuinely single-path body.
    ///
    /// # Errors
    /// Returns [`StoreError`] if `service_control` / `tick_body` fails.
    pub fn step(&mut self) -> Result<(), StoreError> {
        // D-13 (phase 90, research Finding A): the dev-only fault seam, checked FIRST and
        // not in `tick_body`, because a paused board is Frozen and the Frozen arm never
        // ticks. A set flag fires once (it is cleared as it is read) and returns through
        // the same `StoreError` path to `run` that a real store failure takes. Unwired
        // (`None`) this is one branch on an `Option`; the shipped app compiles without it
        // (`dev-seams`, phase 90 review IN-A-04).
        #[cfg(feature = "dev-seams")]
        if let Some(flag) = &self.dev_fault
            && flag.swap(false, Ordering::AcqRel)
        {
            return Err(StoreError::Backend(DEV_FAULT_REASON.to_owned()));
        }
        self.service_control()?;
        match self.run_state {
            RunState::Playing => {
                self.acquire_input()?;
                self.tick_body()?;
            }
            RunState::Draining => {
                // Keep ticking to drain in-flight belt items + executor effects,
                // but HOLD new input (acquire_input skipped). CR-01: acquire_input is
                // skipped here, so refuse any newly-arriving endpoint request with a
                // 503 rather than let it hang un-drained.
                self.refuse_endpoint_ingress_while_not_playing();
                self.refuse_webhook_ingress_while_not_playing();
                self.tick_body()?;
                self.draining_ticks += 1;
                let quiescent = self.host.in_flight_len() == 0
                    && (self.host.belt_items_in_flight() == 0 || self.drain_settles_on_effects);
                if quiescent || self.draining_ticks >= MAX_SETTLE_TICKS {
                    self.run_state = RunState::Frozen;
                    self.paused.store(true, Ordering::Release);
                    // HOST-04: a Save latched while non-quiescent runs the instant
                    // the drain settles. `do_save` is quiescent iff we froze on
                    // `quiescent`; if the max-settle budget forced Frozen with an
                    // effect still in flight, `save_project`'s NotQuiescent refusal
                    // is the loud backstop (warned, loop continues). The Save does not
                    // end the run: a Save on a running board carries on running after
                    // the write and one on a board the user paused stays paused (D-08,
                    // the resume tail below).
                    let saved = if let Some(path) = self.pending_save.take() {
                        self.do_save(&path);
                        true
                    } else {
                        false
                    };
                    // WR-02: a Load / LoadDemo latched while non-quiescent performs
                    // its host swap only NOW, at quiescence — so no stray OLD-scene
                    // executor effect crosses into the loaded host. Runs AFTER a
                    // pending Save so a Save+Load pair persists the OLD scene first.
                    if let Some(load) = self.pending_load.take() {
                        match load {
                            // 73-12 (WR-02): the verdict is deliberately DISCARDED on
                            // this arm. See the immediate arm's note: a latched drain
                            // entered FROM Playing, so the resume below restores the
                            // pre-latch state rather than inventing one, refused or not.
                            PendingLoad::File(path) => {
                                let _swapped = self.load_swap(&path);
                            }
                            PendingLoad::Scene(id) => self.load_scene_swap(id),
                            PendingLoad::New => self.new_swap(),
                        }
                        // LIVE-03 (the 20-05 live-CTA finding), refined by 20-review
                        // WR-01: a latch entered as a SWAP-SAFETY drain (from
                        // Playing; a drain entered from Frozen is one the user holds)
                        // restores Playing here — without
                        // this, clicking "Load demo scene" while items were in
                        // flight repopulated the grid and left the sim Frozen
                        // forever, a dead-looking CTA (frontend sends ONLY
                        // `load_demo`, no follow-up resume). But a drain that
                        // ORIGINATED FROM — or was JOINED BY — an explicit user
                        // Pause (Pause then Load while the drain still ran) must NOT
                        // be auto-resumed over: the swap still installs and the
                        // producer reset still repopulates the grid (the CTA is not
                        // dead), the sim just stays Frozen as the user asked. This
                        // also covers a REFUSED latched Load (load_swap kept the
                        // current scene): swap-safety resumes to its pre-latch
                        // Playing; a user-paused drain stays paused.
                        if !self.drain_from_user_pause {
                            self.run_state = RunState::Playing;
                            self.paused.store(false, Ordering::Release);
                            self.resume_notify.notify_waiters();
                        }
                    } else if saved && !self.drain_from_user_pause {
                        // D-08 (phase 90, FAIL-04): a Save on a running board carries on
                        // running once the file is written. The drain was entered for the
                        // Save alone from Playing (or a Resume lifted the hold during it), so
                        // restoring Playing here restores the pre-latch state, exactly as
                        // the latched-Load tail above does; a held host would read as a
                        // dropped stream on the page and answer every endpoint and webhook
                        // with a 503. A drain the user's own Pause or Step began or joined
                        // stays Frozen: a Save on a board the user paused stays paused.
                        // When a Load was latched too, the Load arm above owns the resume.
                        self.run_state = RunState::Playing;
                        self.paused.store(false, Ordering::Release);
                        self.resume_notify.notify_waiters();
                    }
                }
            }
            RunState::Frozen => {
                // CR-01: a Frozen sim never ticks, so the endpoint drain + 504 sweep
                // never run. Refuse newly-arriving endpoint requests with a 503 (the
                // frozen scene cannot answer them) so a POST can never hang forever.
                self.refuse_endpoint_ingress_while_not_playing();
                self.refuse_webhook_ingress_while_not_playing();
            }
        }
        // ROBUST-01: publish the not-Playing signal to the webhook handler from ONE
        // site. Every `run_state` mutation happens inside `step()` (via
        // `service_control()` and the Draining arm above), so this single end-of-step
        // store cannot miss a transition; latency to the handler is bounded by one
        // tick. Derived from `run_state == Playing` (NOT `self.paused`, which is
        // `false` during Draining — the exact window Gate A must refuse).
        self.is_playing
            .store(self.run_state == RunState::Playing, Ordering::Release);
        // Phase 90 review WR-A-04: Frozen implies the user's hold. Every path into Frozen is a
        // Pause, a Step, or a drain one of them began or joined (a drain entered for a Save or
        // Load from Playing restores Playing at its settle), and only Resume, which moves to
        // Playing, clears the hold. The swap tails rely on it: none resumes a Frozen board.
        debug_assert!(
            self.run_state != RunState::Frozen || self.drain_from_user_pause,
            "FROZEN IMPLIES A USER HOLD (phase 90 review WR-A-04)"
        );
        Ok(())
    }

    /// Pace the canonical body. `None` = forever (both live entrypoints); `Some(n)`
    /// = bounded (the tests). This is the ONLY loop-over-`step()` in the codebase.
    ///
    /// # Errors
    /// Propagates the first [`StoreError`] any `step()` returns.
    pub fn run(&mut self, ticks: Option<u64>, tick_pause: Duration) -> Result<(), StoreError> {
        let ended = match ticks {
            None => loop {
                if let Err(e) = self.step() {
                    break Err(e);
                }
                std::thread::sleep(tick_pause);
            },
            Some(n) => (|| {
                for _ in 0..n {
                    self.step()?;
                    if !tick_pause.is_zero() {
                        std::thread::sleep(tick_pause);
                    }
                }
                Ok(())
            })(),
        };
        // Phase 90 review WR-A-01: a loop that ended on an error answers no request again, so
        // its doors are shut before the error is handed back (see `close_ingress`).
        if ended.is_err() {
            self.close_ingress();
        }
        ended
    }

    /// Shut every door into a loop that has stopped for good (phase 90 review WR-A-01): the
    /// not-Playing flag the webhook and endpoint handlers read is cleared, so a new request is
    /// refused with a 503 at the door; the webhook, endpoint and control receivers are
    /// dropped, so a request already queued, or one that raced the flag, reads its dropped
    /// answer as a 503; every endpoint caller parked in the correlation registry is answered
    /// 503; and the gesture receiver is replaced with a closed one, so nothing piles up
    /// unread. `run` calls it when the loop ends on an error; a host that contained a PANIC
    /// with `fatal_reason` calls it itself (the dev host parks with the loop alive). Idempotent.
    /// Host-side channel and socket work only: nothing enters the fold or the log.
    pub fn close_ingress(&mut self) {
        self.is_playing.store(false, Ordering::Release);
        self.webhook_rx = None;
        self.endpoint_rx = None;
        self.control_rx = None;
        self.registry.drain_all(HttpResponse::service_unavailable_503);
        self.pending_acks.clear();
        self.pending_accepts.clear();
        self.held_undo_redo = None;
        let (_closed_tx, closed_rx) = gesture_channel();
        self.gesture_rx = closed_rx;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use fabrico_core::core::Core;
    use fabrico_core::event::{LogHeader, SCHEMA_VERSION};
    use fabrico_core::persist::RedbStore;
    use fabrico_core::state::SinkTemplate;
    use fabrico_protocol::machine_kind;

    use crate::config::TimerConfig;
    use crate::demo_scene::{HISTORY_SEAL_TICKS, demo_commands, order_commands};
    use crate::ingress::timer::TimerSet;
    use crate::ingress::webhook::WEBHOOK_INGRESS_CAPACITY;
    use crate::ledger::DispatchLedger;
    use tokio::sync::mpsc::{Sender, channel};

    /// Plan 74.1-28: a refusal names the port edit and its node, names a command with no
    /// single node by name alone, and a run-pace frame by its own name.
    #[test]
    fn a_gesture_subject_names_the_command_and_its_one_node() {
        let subject = |cmd: GridCommand| GestureFrame::Cmd(cmd).subject();
        assert_eq!(
            subject(GridCommand::AddPort {
                node: 9,
                role: 1,
                side: 1,
                medium: 0
            }),
            GestureSubject {
                cmd: "AddPort",
                node: Some(9)
            }
        );
        assert_eq!(
            subject(GridCommand::RemovePort { node: 4, index: 2 }),
            GestureSubject {
                cmd: "RemovePort",
                node: Some(4)
            }
        );
        assert_eq!(
            subject(GridCommand::Rotate { node: 5, ccw: true }),
            GestureSubject {
                cmd: "Rotate",
                node: Some(5)
            }
        );
        assert_eq!(
            subject(GridCommand::Delete { node: 6 }),
            GestureSubject {
                cmd: "Delete",
                node: Some(6)
            }
        );
        assert_eq!(
            subject(GridCommand::Undo),
            GestureSubject {
                cmd: "Undo",
                node: None
            }
        );
        assert_eq!(
            subject(GridCommand::Unlink {
                belt: 1,
                endpoint: fabrico_protocol::BeltEnd::Tail,
                node: 2,
                port: 0
            }),
            GestureSubject {
                cmd: "Unlink",
                node: None
            },
            "a belt-and-node command is not a one-node command"
        );
        assert_eq!(
            GestureFrame::RunPace(BeltRunPace {
                belts: vec![1],
                ticks_per_slot: 4
            })
            .subject(),
            GestureSubject {
                cmd: "RunPace",
                node: None
            }
        );
    }

    fn test_rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("build executor runtime")
    }

    fn header() -> LogHeader {
        LogHeader {
            schema_version: SCHEMA_VERSION,
            seed: 1,
        }
    }

    fn test_cfg() -> HostConfig {
        HostConfig {
            webhook_addr: "127.0.0.1:0".parse().expect("loopback addr"),
        }
    }

    /// Build an offline-safe host on temp redb, running `build` against its
    /// [`Core`] first (topology construction), mirroring `tests/driver.rs`.
    fn build_host(dir: &std::path::Path, build: impl FnOnce(&mut Core)) -> Host {
        let mut core = Core::genesis(header());
        build(&mut core);
        let store = RedbStore::open(dir.join("log.redb")).expect("open log");
        let ledger = DispatchLedger::open(dir.join("ledger.redb")).expect("open ledger");
        Host::new(core, store, ledger, None).expect("open host")
    }

    /// Count the logged `ManualInject` events — the held-input oracle (a
    /// pre_tick injection that fires only via `acquire_input`).
    fn count_injects(sim: &SimLoop) -> usize {
        sim.host()
            .logged_events()
            .expect("read log")
            .iter()
            .filter(|e| matches!(e.payload, EventPayload::ManualInject { .. }))
            .count()
    }

    /// HOST-07: the webhook route table is a LIVE fold-projection of `core.state`'s
    /// Source set, published as a FRESH immutable `Arc` over the `watch` ONLY when
    /// the Source set changes. Placing a second Source (via a real gesture, not a
    /// hand-built table) swaps a new Arc (identity changed) carrying the new
    /// id-derived label; a non-Source placement and idle ticks leave the Arc
    /// identity untouched (the fingerprint guard against Arc churn, Pitfall 5).
    #[test]
    fn route_projection_tracks_source_set() {
        let rt = test_rt();
        let dir = tempfile::tempdir().expect("tempdir");
        // Genesis with ONE source already present (directly minted, no footprint).
        let host = build_host(dir.path(), |c| {
            c.state.add_source();
        });
        let (gtx, grx) = gesture_channel();
        let mut sim = SimLoop::new(host, RenderProducer::new(), rt.handle(), test_cfg(), grx);

        // The webhook server's view onto the LIVE route table.
        let mut routes_rx = sim.routes_receiver();
        let before = routes_rx.borrow_and_update().clone();
        assert_eq!(
            before.len(),
            1,
            "the genesis Source is projected into the route table at construction"
        );

        // Place a SECOND Source via a real gesture; the fold mints it EDITS-FIRST.
        gtx.send_gesture(GridCommand::Place {
            kind: machine_kind::SOURCE,
            cell_x: 0,
            cell_y: 0,
        })
        .expect("send place-source gesture");
        sim.run(Some(1), Duration::ZERO).expect("fold the Source place");

        let after = routes_rx.borrow_and_update().clone();
        assert!(
            !Arc::ptr_eq(&before, &after),
            "placing a Source publishes a FRESH routes Arc (identity changed)"
        );
        assert_eq!(after.len(), 2, "the new Source joins the projection");

        // The newly-minted Source's id-derived label maps to its NodeId.
        let new_id = sim
            .host()
            .core()
            .last_tick
            .placed
            .iter()
            .copied()
            .find(|&id| matches!(sim.host().core().state.node(id), Some(Node::Source(_))))
            .expect("the placed node is a Source");
        let label = format!("src-{}", new_id.data().as_ffi());
        assert_eq!(
            after.get(&label),
            Some(&new_id),
            "the new id-derived label maps to the new NodeId"
        );

        // A NON-Source gesture (place a Sink) grows the NODE set but not the SOURCE
        // set -> the routes Arc identity is UNCHANGED (fingerprint guard).
        let nodes_before_sink = sim.host().core().state.node_count();
        gtx.send_gesture(GridCommand::Place {
            kind: machine_kind::SINK,
            cell_x: 5,
            cell_y: 0,
        })
        .expect("send place-sink gesture");
        sim.run(Some(1), Duration::ZERO).expect("fold the Sink place");
        assert_eq!(
            sim.host().core().state.node_count(),
            nodes_before_sink + 1,
            "the Sink placement added a node (a real non-Source gesture)"
        );
        let after_sink = routes_rx.borrow_and_update().clone();
        assert!(
            Arc::ptr_eq(&after, &after_sink),
            "a non-Source placement does NOT re-publish the routes Arc"
        );

        // Idle ticks never churn the Arc either.
        sim.run(Some(3), Duration::ZERO).expect("idle ticks");
        let after_idle = routes_rx.borrow().clone();
        assert!(
            Arc::ptr_eq(&after, &after_idle),
            "idle ticks leave the routes Arc identity unchanged (no per-tick churn)"
        );
    }

    /// A bare, seamless [`SimLoop`] run advances the canonical loop body N times
    /// without error and never regresses the event log (Wave-0 Nyquist coverage for
    /// HOST-01: the unified `step()` ticks with NO seams wired). `Duration::ZERO`
    /// pacing keeps it well under a second; no render bytes are subscribed, so
    /// `on_tick`'s broadcast error is harmlessly swallowed (Pitfall 2).
    #[test]
    fn bounded_run_advances_the_loop() {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("build executor runtime");

        // Self-contained, offline-safe host on temp redb (mirrors tests/driver.rs).
        let dir = tempfile::tempdir().expect("tempdir");
        let core = Core::genesis(LogHeader {
            schema_version: SCHEMA_VERSION,
            seed: 1,
        });
        let store = RedbStore::open(dir.path().join("log.redb")).expect("open log");
        let ledger = DispatchLedger::open(dir.path().join("ledger.redb")).expect("open ledger");
        let host = Host::new(core, store, ledger, None).expect("open host");

        let cfg = HostConfig {
            webhook_addr: "127.0.0.1:0".parse().expect("loopback addr"),
        };
        // A throwaway gesture sink kept open so the receiver never closes.
        let (_gesture_tx, gesture_rx) = gesture_channel();

        let mut sim = SimLoop::new(host, RenderProducer::new(), rt.handle(), cfg, gesture_rx);

        let before = sim.host().logged_events().expect("read log before").len();
        // Bounded, NO seams (no webhook, no control, no pre_tick) — prove the bare
        // canonical body ticks. ZERO pacing => fast.
        sim.run(Some(5), Duration::ZERO)
            .expect("a bounded seamless run advances the loop");
        let after = sim.host().logged_events().expect("read log after").len();

        assert!(
            after >= before,
            "the event log is non-decreasing across N empty ticks ({after} >= {before})"
        );
    }

    /// EMPTY-drain case: an already-quiescent Pause freezes immediately and the
    /// sim then does not tick (the logged-event count is likewise stable). The
    /// REAL draining phase is `pause_drains_then_freezes` below.
    #[test]
    fn pause_freezes_tick() {
        let rt = test_rt();
        let dir = tempfile::tempdir().expect("tempdir");
        let host = build_host(dir.path(), |_| {}); // genesis: nothing in flight
        let (_gtx, grx) = gesture_channel();
        let (ctx, crx) = unbounded_channel::<ControlMsg>();
        let mut sim = SimLoop::new(host, RenderProducer::new(), rt.handle(), test_cfg(), grx)
            .with_control(crx);

        // A few live ticks first.
        sim.run(Some(3), Duration::ZERO).expect("live ticks");
        // Pause: genesis is already quiescent -> Frozen immediately on next step.
        ctx.send(ControlMsg::Pause).expect("send pause");
        sim.step().expect("service pause");
        assert!(sim.is_paused(), "an already-quiescent Pause freezes immediately");

        let frozen_tick = sim.host().core().tick;
        for _ in 0..10 {
            sim.step().expect("a frozen step is a no-op");
        }
        assert_eq!(
            sim.host().core().tick,
            frozen_tick,
            "the sim does not tick while frozen"
        );
    }

    /// THE real DRAINING-phase guard (HOST-08 livelock closure). Two scenarios:
    /// (A) a non-quiescent Pause keeps ticking with input HELD until belts +
    /// executor drain to zero, THEN freezes; (B) a deliberately stalled drain is
    /// forced Frozen by the bounded max-settle budget rather than spinning
    /// forever.
    #[test]
    fn pause_drains_then_freezes() {
        let rt = test_rt();

        // ── Part A: clean drain (belt items + executor effects) + held input ──
        let dir = tempfile::tempdir().expect("tempdir");
        let mut source = None;
        let host = build_host(dir.path(), |c| {
            let src = c.state.add_source();
            let belt = c.state.add_belt(4); // several slots -> multi-tick transit
            let sink = c.state.add_sink(SinkTemplate::Debug, 1000);
            c.state.link((src, 0), (belt, 0));
            c.state.link((belt, 0), (sink, 0));
            source = Some(src);
        });
        let source = source.expect("source built");
        let (_gtx, grx) = gesture_channel();
        let (ctx, crx) = unbounded_channel::<ControlMsg>();
        // Inject EVERY tick: while Playing this keeps the belt non-empty; while
        // Draining pre_tick (inside acquire_input) is SKIPPED, so NO new items
        // enter — the held-input proof.
        let mut sim = SimLoop::new(host, RenderProducer::new(), rt.handle(), test_cfg(), grx)
            .with_control(crx)
            .with_pre_tick(Box::new(move |_t, ingress| {
                let _ = ingress.send(EventPayload::ManualInject {
                    target: source,
                    port: 0,
                    item: Item(vec![0x1]),
                });
            }));

        // Prime: run live ticks so items populate the belt / executor.
        sim.run(Some(6), Duration::from_millis(2)).expect("prime run");
        assert!(
            sim.host().belt_items_in_flight() > 0,
            "the belt is non-quiescent at Pause time"
        );
        let injects_at_pause = count_injects(&sim);

        // Pause -> Draining (not quiescent). Drive to Frozen.
        ctx.send(ControlMsg::Pause).expect("send pause");
        let mut guard = 0;
        let mut ticked_while_draining = false;
        let mut prev_tick = sim.host().core().tick;
        while !sim.is_paused() {
            sim.step().expect("draining step");
            // Give the off-thread executor time to fold results back.
            std::thread::sleep(Duration::from_millis(2));
            if sim.host().core().tick > prev_tick {
                ticked_while_draining = true;
            }
            prev_tick = sim.host().core().tick;
            assert_eq!(
                count_injects(&sim),
                injects_at_pause,
                "new upstream input is HELD while Draining (pre_tick skipped)"
            );
            guard += 1;
            assert!(guard < 2000, "the drain did not converge");
        }
        assert!(ticked_while_draining, "the sim keeps ticking while draining");
        assert!(sim.is_paused(), "the sim freezes once quiescent");
        assert_eq!(
            sim.host().belt_items_in_flight(),
            0,
            "belts drained to zero before freezing"
        );
        assert_eq!(
            sim.host().in_flight_len(),
            0,
            "the executor drained to zero before freezing"
        );

        // ── Part B: a stalled drain hits the bounded max-settle budget ──
        let dir2 = tempfile::tempdir().expect("tempdir2");
        let mut node2 = None;
        let mut host2 = build_host(dir2.path(), |c| {
            node2 = Some(c.state.add_source());
        });
        // A never-resolving in-flight command (deadline u64::MAX: never times
        // out, no result ever folds it) keeps in_flight_len() > 0 forever.
        host2.test_insert_in_flight((0u64, node2.expect("node"), 0u32), u64::MAX);
        let (_gtx2, grx2) = gesture_channel();
        let (ctx2, crx2) = unbounded_channel::<ControlMsg>();
        let mut sim2 = SimLoop::new(host2, RenderProducer::new(), rt.handle(), test_cfg(), grx2)
            .with_control(crx2);
        assert!(
            sim2.host().in_flight_len() > 0,
            "the stalled command is in flight at Pause time"
        );

        ctx2.send(ControlMsg::Pause).expect("send pause2");
        let mut guard = 0;
        while !sim2.is_paused() {
            sim2.step().expect("stalled draining step");
            guard += 1;
            assert!(
                guard <= MAX_SETTLE_TICKS + 50,
                "the max-settle budget must force Frozen on a stalled drain"
            );
        }
        assert!(
            sim2.is_paused(),
            "the bounded budget forced Frozen despite an unresolved effect"
        );
        assert!(
            sim2.host().in_flight_len() > 0,
            "the stalled effect never resolved — the budget (not quiescence) froze it"
        );
    }

    /// From Frozen, Resume returns to Playing: the log grows again and any input
    /// held while frozen is applied once more.
    #[test]
    fn resume_resumes() {
        let rt = test_rt();
        let dir = tempfile::tempdir().expect("tempdir");
        let mut source = None;
        let host = build_host(dir.path(), |c| {
            source = Some(c.state.add_source());
        });
        let source = source.expect("source");
        let (_gtx, grx) = gesture_channel();
        let (ctx, crx) = unbounded_channel::<ControlMsg>();
        let mut sim = SimLoop::new(host, RenderProducer::new(), rt.handle(), test_cfg(), grx)
            .with_control(crx)
            .with_pre_tick(Box::new(move |_t, ingress| {
                let _ = ingress.send(EventPayload::ManualInject {
                    target: source,
                    port: 0,
                    item: Item(vec![0x7]),
                });
            }));

        // Freeze at genesis (quiescent).
        ctx.send(ControlMsg::Pause).expect("pause");
        sim.step().expect("freeze");
        assert!(sim.is_paused());
        let frozen_tick = sim.host().core().tick;
        for _ in 0..5 {
            sim.step().expect("frozen no-op");
        }
        assert_eq!(sim.host().core().tick, frozen_tick, "frozen: no advance");

        // Resume -> Playing; the log grows again (held input applied).
        let before = sim.host().logged_events().expect("log").len();
        ctx.send(ControlMsg::Resume).expect("resume");
        sim.run(Some(4), Duration::ZERO).expect("resumed run");
        assert!(!sim.is_paused(), "the resumed sim is not paused");
        assert!(
            sim.host().core().tick > frozen_tick,
            "the tick advances again after Resume"
        );
        let after = sim.host().logged_events().expect("log").len();
        assert!(
            after > before,
            "held input is applied again after Resume ({after} > {before})"
        );
    }

    /// From Frozen, one Step advances exactly one input-applying
    /// acquire_input()+tick_body() and stays Frozen.
    #[test]
    fn step_from_frozen_advances_exactly_one() {
        let rt = test_rt();
        let dir = tempfile::tempdir().expect("tempdir");
        let mut source = None;
        let host = build_host(dir.path(), |c| {
            source = Some(c.state.add_source());
        });
        let source = source.expect("source");
        let (_gtx, grx) = gesture_channel();
        let (ctx, crx) = unbounded_channel::<ControlMsg>();
        let mut sim = SimLoop::new(host, RenderProducer::new(), rt.handle(), test_cfg(), grx)
            .with_control(crx)
            .with_pre_tick(Box::new(move |_t, ingress| {
                let _ = ingress.send(EventPayload::ManualInject {
                    target: source,
                    port: 0,
                    item: Item(vec![0x9]),
                });
            }));

        // Freeze at genesis.
        ctx.send(ControlMsg::Pause).expect("pause");
        sim.step().expect("freeze");
        assert!(sim.is_paused());
        let t0 = sim.host().core().tick;
        let l0 = sim.host().logged_events().expect("log").len();

        // One Step -> exactly one acquire_input()+tick_body() (one injected event).
        ctx.send(ControlMsg::Step).expect("step msg");
        sim.step().expect("service step");
        assert_eq!(
            sim.host().core().tick,
            t0 + 1,
            "Step advances exactly one tick"
        );
        assert_eq!(
            sim.host().logged_events().expect("log").len(),
            l0 + 1,
            "Step logs exactly one injected event"
        );
        assert!(sim.is_paused(), "run-state stays Frozen after a Step");

        // A plain step (no Step message) does NOT advance (still Frozen).
        sim.step().expect("frozen no-op");
        assert_eq!(
            sim.host().core().tick,
            t0 + 1,
            "no advance without a Step message"
        );
    }

    /// The off-thread executor holds NEW dispatch while the sim is Frozen and
    /// resumes on Resume — with no reference cycle back into the `!Send` Host
    /// (the consumer captures only Send+Sync `Arc` clones). Dispatch pickups are
    /// counted via the consumer's post-gate counter (`dispatched_count`), the
    /// dispatch-count probe this test needs.
    #[test]
    fn executor_gated_by_pause() {
        use fabrico_core::command::{Command, EVENT_VERSION, Effect};

        let rt = test_rt();
        let dir = tempfile::tempdir().expect("tempdir");
        let mut node = None;
        let host = build_host(dir.path(), |c| {
            node = Some(c.state.add_source());
        });
        let node = node.expect("node");
        let (_gtx, grx) = gesture_channel();
        let (ctx, crx) = unbounded_channel::<ControlMsg>();
        let mut sim = SimLoop::new(host, RenderProducer::new(), rt.handle(), test_cfg(), grx)
            .with_control(crx);

        // Freeze at genesis (quiescent -> Frozen, paused=true).
        ctx.send(ControlMsg::Pause).expect("pause");
        sim.step().expect("freeze");
        assert!(sim.is_paused(), "sim is frozen (executor gate engaged)");

        // Enqueue commands that would dispatch. I/O-free Noop effects: they never
        // open a socket, so counting is deterministic.
        let n = 3;
        for seq in 0..n {
            sim.test_send_command(Command {
                event_version: EVENT_VERSION,
                id: (0, node, seq as u32),
                partition: 0,
                effect: Effect::Noop,
                deadline: 1000,
            });
        }

        // While frozen the consumer parks on resume_notify: the dispatch count is
        // STABLE (commands queue in cmd_rx undispatched).
        std::thread::sleep(Duration::from_millis(50));
        assert_eq!(
            sim.dispatched_count(),
            0,
            "no NEW dispatch fires while the sim is frozen"
        );

        // Resume wakes the parked consumer -> the queued commands dispatch.
        ctx.send(ControlMsg::Resume).expect("resume");
        sim.step().expect("service resume");
        // Poll (bounded iterations, no wall-clock) until the woken consumer has
        // drained the queue — up to ~2s at 5ms per spin.
        for _ in 0..400 {
            if sim.dispatched_count() >= n {
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(
            sim.dispatched_count(),
            n,
            "queued commands dispatch once Resume wakes the consumer"
        );
    }

    /// HOST-03: `step×N` produces a byte-identical event log to `live×N`. It
    /// passes BY CONSTRUCTION — Step (service_control) and live (Playing) both
    /// run the IDENTICAL acquire_input() + single-path tick_body() pair, so one
    /// code path cannot diverge from itself. This test is the guard against a
    /// future refactor splitting them (or leaking the Draining held-input branch
    /// into the shared body).
    ///
    /// A source-only topology + a fixed pre_tick injection cadence keeps the log
    /// free of async-effect timing (no Sink → no off-thread CommandResult whose
    /// arrival tick could differ between two live runs); the log is then a pure,
    /// synchronously-appended ManualInject sequence identical for both drivers.
    #[test]
    fn step_equals_live() {
        let rt = test_rt();

        // Identical genesis (same seed) → add_source mints the SAME NodeId for
        // both, so the injected ManualInject target is byte-identical.
        let build_source_only = |c: &mut Core| {
            c.state.add_source();
        };
        // The shared deterministic input script: inject to the (identical) source
        // on every tick, keyed on the loop tick (== core.tick via IN-01).
        fn injecting_pre_tick(source: fabrico_core::ids::NodeId) -> PreTick {
            Box::new(move |_tick, ingress| {
                let _ = ingress.send(EventPayload::ManualInject {
                    target: source,
                    port: 0,
                    item: Item(vec![0xAB]),
                });
            })
        }

        const N: u64 = 12;

        // ── Host A: LIVE, never paused ──
        let dir_a = tempfile::tempdir().expect("tempdir a");
        let mut src_a = None;
        let host_a = build_host(dir_a.path(), |c| {
            build_source_only(c);
            src_a = Some(c.state.node_ids().next().expect("source a"));
        });
        let src_a = src_a.expect("src a");
        let (_gtx_a, grx_a) = gesture_channel();
        let mut sim_a = SimLoop::new(host_a, RenderProducer::new(), rt.handle(), test_cfg(), grx_a)
            .with_pre_tick(injecting_pre_tick(src_a));
        sim_a.run(Some(N), Duration::ZERO).expect("live run");

        // ── Host B: Pause (freezes at genesis, nothing in flight) then N Steps ──
        let dir_b = tempfile::tempdir().expect("tempdir b");
        let mut src_b = None;
        let host_b = build_host(dir_b.path(), |c| {
            build_source_only(c);
            src_b = Some(c.state.node_ids().next().expect("source b"));
        });
        let src_b = src_b.expect("src b");
        assert_eq!(src_a, src_b, "identical genesis mints identical source ids");
        let (_gtx_b, grx_b) = gesture_channel();
        let (ctx_b, crx_b) = unbounded_channel::<ControlMsg>();
        let mut sim_b = SimLoop::new(host_b, RenderProducer::new(), rt.handle(), test_cfg(), grx_b)
            .with_control(crx_b)
            .with_pre_tick(injecting_pre_tick(src_b));

        // Freeze at genesis (quiescent → Frozen with NO tick, so B starts Stepping
        // from core.tick 0 exactly like A starts its first live tick).
        ctx_b.send(ControlMsg::Pause).expect("pause");
        sim_b.step().expect("freeze");
        assert!(sim_b.is_paused());
        assert_eq!(sim_b.host().core().tick, 0, "Pause at genesis does not tick");
        for _ in 0..N {
            ctx_b.send(ControlMsg::Step).expect("step msg");
            sim_b.step().expect("service step");
        }

        // The two logs must be byte-identical (HOST-03).
        let log_a = sim_a.host().logged_events().expect("log a");
        let log_b = sim_b.host().logged_events().expect("log b");
        let bytes_a = postcard::to_allocvec(&log_a).expect("encode a");
        let bytes_b = postcard::to_allocvec(&log_b).expect("encode b");
        assert_eq!(
            bytes_a, bytes_b,
            "step×N and live×N produce a byte-identical event log (HOST-03)"
        );
        assert_eq!(sim_a.host().core().tick, sim_b.host().core().tick, "same tick");
    }

    /// Finding 3 pinned: a Pause on a TIMER-DRIVEN scene settles in
    /// pipeline-latency ticks — never the full [`MAX_SETTLE_TICKS`] budget —
    /// because `tick_body` HOLDS timer ingress while Draining. A Save sent after
    /// the freeze then succeeds (the path Finding 3 said would hit
    /// `save_project`'s NotQuiescent refusal if timers kept re-feeding the belts
    /// through the drain). This is the demo scene's user-facing contract
    /// (LIVE-05): Pause is snappy, Save works, on the FIRST scene a user sees.
    #[test]
    fn pause_settles_fast_with_timers_then_save() {
        let rt = test_rt();
        let dir = tempfile::tempdir().expect("tempdir");
        let mut source = None;
        let host = build_host(dir.path(), |c| {
            let src = c.state.add_source();
            let belt = c.state.add_belt(4); // several slots -> multi-tick transit
            let sink = c.state.add_sink(SinkTemplate::Debug, 1000);
            c.state.link((src, 0), (belt, 0));
            c.state.link((belt, 0), (sink, 0));
            source = Some(src);
        });
        let source = source.expect("source built");
        // The REAL timer ingress (not a pre_tick hook), carrying the canonical
        // JSON payload the demo factory parses (Finding 2's b"{}" contract).
        let host = host.with_timers(TimerSet::new(vec![TimerConfig {
            target: source,
            interval: 4,
            item: b"{}".to_vec(),
        }]));
        let (_gtx, grx) = gesture_channel();
        let (ctx, crx) = unbounded_channel::<ControlMsg>();
        let mut sim = SimLoop::new(host, RenderProducer::new(), rt.handle(), test_cfg(), grx)
            .with_control(crx);

        // Prime: live ticks so timer items populate the belt / executor (the 2ms
        // pacing gives the off-thread executor time to fold results back — the
        // existing executor-fold pattern).
        sim.run(Some(12), Duration::from_millis(2)).expect("prime run");
        assert!(
            sim.host().belt_items_in_flight() > 0 || sim.host().in_flight_len() > 0,
            "the timer-driven scene is non-quiescent at Pause time"
        );
        let injects_at_pause = count_injects(&sim);

        // Pause -> Draining. WITHOUT the timer gate this can NEVER settle (the
        // interval-4 timer re-feeds the belt through the whole drain) and burns
        // all MAX_SETTLE_TICKS; WITH it the drain is pipeline-latency only.
        ctx.send(ControlMsg::Pause).expect("send pause");
        let mut steps = 0u64;
        while !sim.is_paused() {
            sim.step().expect("draining step");
            // Give the off-thread executor time to fold results back.
            std::thread::sleep(Duration::from_millis(2));
            assert_eq!(
                count_injects(&sim),
                injects_at_pause,
                "timer ingress is HELD while Draining (the logged injection \
                 count stops growing the moment the drain begins)"
            );
            steps += 1;
            assert!(
                steps < 200,
                "a timer-driven Pause must settle in pipeline-latency ticks, \
                 WELL under the MAX_SETTLE_TICKS budget"
            );
        }
        assert_eq!(
            sim.host().belt_items_in_flight(),
            0,
            "belts drained to zero before freezing"
        );
        assert_eq!(
            sim.host().in_flight_len(),
            0,
            "the executor drained to zero before freezing"
        );

        // The Save that Finding 3 said would refuse (NotQuiescent) without the
        // gate: the sim is quiescent + frozen, so it runs immediately and the
        // .fab lands on disk.
        let save_path = dir.path().join("timer-scene.fab");
        ctx.send(ControlMsg::Save(save_path.clone())).expect("send save");
        sim.step().expect("service save");
        assert!(
            save_path.exists(),
            "Save succeeds after a timer-driven drain (the .fab exists on disk)"
        );
    }

    /// HOST-03 WITH TIMERS: `step×N` == `live×N` byte-identical with a REAL
    /// timer installed on BOTH hosts — pinning that Step FIRES timers (the Step
    /// control arm reaches `tick_body` with `run_state` Frozen, not Draining, so
    /// the gate stays open). A regression that suppressed timers on Step would
    /// diverge the logs and fail loudly here.
    #[test]
    fn step_equals_live_with_timers() {
        use fabrico_core::snapshot::snapshot;

        let rt = test_rt();

        const N: u64 = 12;
        // IDENTICAL timers on both hosts: interval 3, the canonical b"{}" payload.
        let timers_for = |source: fabrico_core::ids::NodeId| {
            TimerSet::new(vec![TimerConfig {
                target: source,
                interval: 3,
                item: b"{}".to_vec(),
            }])
        };

        // ── Host A: LIVE, never paused ──
        let dir_a = tempfile::tempdir().expect("tempdir a");
        let mut src_a = None;
        let host_a = build_host(dir_a.path(), |c| {
            src_a = Some(c.state.add_source());
        });
        let src_a = src_a.expect("src a");
        let host_a = host_a.with_timers(timers_for(src_a));
        let (_gtx_a, grx_a) = gesture_channel();
        let mut sim_a =
            SimLoop::new(host_a, RenderProducer::new(), rt.handle(), test_cfg(), grx_a);
        sim_a.run(Some(N), Duration::ZERO).expect("live run");

        // ── Host B: Pause (freezes at genesis, nothing in flight) then N Steps ──
        let dir_b = tempfile::tempdir().expect("tempdir b");
        let mut src_b = None;
        let host_b = build_host(dir_b.path(), |c| {
            src_b = Some(c.state.add_source());
        });
        let src_b = src_b.expect("src b");
        assert_eq!(src_a, src_b, "identical genesis mints identical source ids");
        let host_b = host_b.with_timers(timers_for(src_b));
        let (_gtx_b, grx_b) = gesture_channel();
        let (ctx_b, crx_b) = unbounded_channel::<ControlMsg>();
        let mut sim_b =
            SimLoop::new(host_b, RenderProducer::new(), rt.handle(), test_cfg(), grx_b)
                .with_control(crx_b);

        // Freeze at genesis (quiescent → Frozen with NO tick, so B starts Stepping
        // from core.tick 0 exactly like A starts its first live tick).
        ctx_b.send(ControlMsg::Pause).expect("pause");
        sim_b.step().expect("freeze");
        assert!(sim_b.is_paused());
        assert_eq!(sim_b.host().core().tick, 0, "Pause at genesis does not tick");
        for _ in 0..N {
            ctx_b.send(ControlMsg::Step).expect("step msg");
            sim_b.step().expect("service step");
        }

        // The two logs — pure timer-injected ManualInject sequences — must be
        // byte-identical (HOST-03), and so must the core snapshots.
        let log_a = sim_a.host().logged_events().expect("log a");
        let log_b = sim_b.host().logged_events().expect("log b");
        assert!(
            log_a
                .iter()
                .any(|e| matches!(e.payload, EventPayload::ManualInject { .. })),
            "the timer actually fired during the live run (a non-vacuous log)"
        );
        assert_eq!(
            postcard::to_allocvec(&log_a).expect("encode a"),
            postcard::to_allocvec(&log_b).expect("encode b"),
            "step×N and live×N produce a byte-identical event log WITH timers (HOST-03)"
        );
        assert_eq!(
            postcard::to_allocvec(&snapshot(sim_a.host().core())).expect("snap a"),
            postcard::to_allocvec(&snapshot(sim_b.host().core())).expect("snap b"),
            "step×N and live×N produce a byte-identical core snapshot WITH timers"
        );
        assert_eq!(sim_a.host().core().tick, sim_b.host().core().tick, "same tick");
    }

    /// PROOF 2 (HOST-03 not regressed — the second REQUIRED determinism proof):
    /// `step×N == live×N` byte-identical ACROSS an Undo and a Redo. It extends
    /// [`step_equals_live`] with an IDENTICAL gesture script that INCLUDES a
    /// `GridCommand::Undo` and a `GridCommand::Redo` folded live on host A and via
    /// `Step` on host B, then asserts byte-identical event LOGS *and* byte-identical
    /// `snapshot(core)`.
    ///
    /// It passes BY CONSTRUCTION — Step (service_control) and live (Playing) run the
    /// SAME `acquire_input()` + `tick_body()` pair, and undo/redo fold EDITS-FIRST like
    /// any gesture — so this guards against a FUTURE fold-on-apply regression or a
    /// Draining held-input leak splitting the two drivers across an undo/redo.
    ///
    /// A genesis source + a fixed per-tick injection cadence keeps the event log free
    /// of async-effect timing (no Sink → no off-thread `CommandResult`); the gesture
    /// script places/undoes/redoes an ADDITIONAL source on top (topology-only, in the
    /// snapshot, not the event log).
    #[test]
    fn step_equals_live_across_undo() {
        use fabrico_core::snapshot::snapshot;

        let rt = test_rt();

        // Identical genesis (same seed) mints the SAME genesis source NodeId for both,
        // so the injected ManualInject target is byte-identical.
        let build_source_only = |c: &mut Core| {
            c.state.add_source();
        };
        fn injecting_pre_tick(source: fabrico_core::ids::NodeId) -> PreTick {
            Box::new(move |_tick, ingress| {
                let _ = ingress.send(EventPayload::ManualInject {
                    target: source,
                    port: 0,
                    item: Item(vec![0xAB]),
                });
            })
        }
        // The shared gesture script keyed on the loop tick: place two sources, undo the
        // second, redo it. Identical for both drivers -> byte-identical stamped edits.
        fn gesture_for(tick: u64) -> Option<GridCommand> {
            match tick {
                0 => Some(GridCommand::Place {
                    kind: machine_kind::SOURCE,
                    cell_x: 0,
                    cell_y: 0,
                }),
                1 => Some(GridCommand::Place {
                    kind: machine_kind::SOURCE,
                    cell_x: 2,
                    cell_y: 0,
                }),
                2 => Some(GridCommand::Undo),
                3 => Some(GridCommand::Redo),
                _ => None,
            }
        }

        const N: u64 = 8;

        // ── Host A: LIVE, never paused — one gesture per tick, then a live tick ──
        let dir_a = tempfile::tempdir().expect("tempdir a");
        let mut src_a = None;
        let host_a = build_host(dir_a.path(), |c| {
            build_source_only(c);
            src_a = Some(c.state.node_ids().next().expect("source a"));
        });
        let src_a = src_a.expect("src a");
        let (gtx_a, grx_a) = gesture_channel();
        let mut sim_a = SimLoop::new(host_a, RenderProducer::new(), rt.handle(), test_cfg(), grx_a)
            .with_pre_tick(injecting_pre_tick(src_a));
        for tick in 0..N {
            if let Some(g) = gesture_for(tick) {
                gtx_a.send_gesture(g).expect("send gesture a");
            }
            sim_a.run(Some(1), Duration::ZERO).expect("live tick");
        }

        // ── Host B: Pause (freeze at genesis) then N Steps, same gesture per tick ──
        let dir_b = tempfile::tempdir().expect("tempdir b");
        let mut src_b = None;
        let host_b = build_host(dir_b.path(), |c| {
            build_source_only(c);
            src_b = Some(c.state.node_ids().next().expect("source b"));
        });
        let src_b = src_b.expect("src b");
        assert_eq!(src_a, src_b, "identical genesis mints identical source ids");
        let (gtx_b, grx_b) = gesture_channel();
        let (ctx_b, crx_b) = unbounded_channel::<ControlMsg>();
        let mut sim_b = SimLoop::new(host_b, RenderProducer::new(), rt.handle(), test_cfg(), grx_b)
            .with_control(crx_b)
            .with_pre_tick(injecting_pre_tick(src_b));

        // Freeze at genesis (quiescent → Frozen with NO tick), matching A's tick 0 start.
        ctx_b.send(ControlMsg::Pause).expect("pause");
        sim_b.step().expect("freeze");
        assert!(sim_b.is_paused());
        assert_eq!(sim_b.host().core().tick, 0, "Pause at genesis does not tick");
        for tick in 0..N {
            if let Some(g) = gesture_for(tick) {
                gtx_b.send_gesture(g).expect("send gesture b");
            }
            ctx_b.send(ControlMsg::Step).expect("step msg");
            sim_b.step().expect("service step");
        }

        // Both drivers folded the SAME undo/redo script over N ticks. The event logs
        // must be byte-identical (HOST-03) AND the core snapshots byte-identical
        // (Proof 2 — the undo/redo fold cannot diverge Step from live).
        let log_a = sim_a.host().logged_events().expect("log a");
        let log_b = sim_b.host().logged_events().expect("log b");
        assert_eq!(
            postcard::to_allocvec(&log_a).expect("encode a"),
            postcard::to_allocvec(&log_b).expect("encode b"),
            "step×N and live×N produce a byte-identical event log across an undo/redo"
        );
        assert_eq!(
            snapshot(sim_a.host().core()),
            snapshot(sim_b.host().core()),
            "step×N and live×N produce a byte-identical snapshot across an undo/redo (Proof 2)"
        );
        assert_eq!(
            sim_a.host().core().tick,
            sim_b.host().core().tick,
            "same tick after N steps"
        );
    }

    /// Save a scene to a `.fab` via the hardened `save_project`, using a settled
    /// SimLoop, that `load_project` can re-open. Also proves a Load into a live
    /// SimLoop RESETS the producer so a PRE-Load diff subscriber receives a
    /// `full:true` packet (its stream is NOT Closed) carrying the loaded scene
    /// (HOST-05).
    #[test]
    fn load_resets_producer_subscribers_stay_live() {
        let rt = test_rt();

        // Build + save a DISTINCT scene-to-load (two sources) to a .fab. A genesis
        // host with nothing dispatched is quiescent, so save_project accepts it.
        let save_dir = tempfile::tempdir().expect("save tempdir");
        let host_to_save = build_host(save_dir.path(), |c| {
            c.state.add_source();
            c.state.add_source();
        });
        assert_eq!(host_to_save.in_flight_len(), 0, "the scene-to-save is quiescent");
        let fab = save_dir.path().join("scene.fab");
        save_project(&host_to_save, &fab).expect("save the scene-to-load");

        // A live SimLoop over a DIFFERENT scene A (one source).
        let dir = tempfile::tempdir().expect("tempdir");
        let host_a = build_host(dir.path(), |c| {
            c.state.add_source();
        });
        let (_gtx, grx) = gesture_channel();
        let (ctx, crx) = unbounded_channel::<ControlMsg>();
        let mut sim = SimLoop::new(host_a, RenderProducer::new(), rt.handle(), test_cfg(), grx)
            .with_control(crx);

        // An already-connected subscriber (a live webview) BEFORE the Load.
        let (_kf_rx, mut diff_rx) = sim.subscribe();

        // Load the saved scene: swap + producer reset on the sim thread.
        ctx.send(ControlMsg::Load(fab.clone())).expect("send load");
        sim.step().expect("service load");

        // The pre-existing subscriber receives a full:true reset packet over the
        // DIFF broadcast (NOT a Closed stream), carrying the loaded scene.
        let bytes = diff_rx
            .try_recv()
            .expect("the Load reset rides the diff broadcast (subscriber not Closed)");
        let pkt: fabrico_protocol::RenderPacket =
            postcard::from_bytes(&bytes.bytes).expect("decode reset packet");
        assert!(pkt.full, "the post-Load packet is a full:true keyframe");
        assert_eq!(
            pkt.placed.len(),
            2,
            "the loaded scene (two sources) repopulates the live subscriber"
        );
    }

    /// UNDO-06 never-dark (Pitfall 3): a tick that folds an undo/redo group pushes
    /// a `full:true` keyframe over the DIFF broadcast (`RenderProducer::reset`), not
    /// a diff — a diff cannot express re-minted ids + cascade restores. A normal
    /// placement tick still rides the active-set DIFF path (`full:false`), and its
    /// diff carries `can_undo:true` (availability rides diffs, Pitfall 5). A later
    /// idle tick takes the DIFF path too — the reset fires EXACTLY on undo/redo ticks.
    #[test]
    fn undo_redo_tick_broadcasts_full_keyframe_others_diff() {
        let rt = test_rt();
        let dir = tempfile::tempdir().expect("tempdir");
        // Empty genesis grid: the Place below is the only live action.
        let host = build_host(dir.path(), |_c| {});
        let (gtx, grx) = gesture_channel();
        let mut sim = SimLoop::new(host, RenderProducer::new(), rt.handle(), test_cfg(), grx);

        // A live subscriber (a webview) on the diff broadcast, before any gesture.
        let (_kf_rx, mut diff_rx) = sim.subscribe();

        // (1) A normal Place gesture -> a DIFF packet (full:false) carrying can_undo.
        gtx.send_gesture(GridCommand::Place {
            kind: machine_kind::SOURCE,
            cell_x: 0,
            cell_y: 0,
        })
        .expect("send place gesture");
        sim.run(Some(1), Duration::ZERO).expect("fold the place");
        let place_bytes = diff_rx.try_recv().expect("place broadcast");
        let place_pkt: fabrico_protocol::RenderPacket =
            postcard::from_bytes(&place_bytes.bytes).expect("decode place packet");
        assert!(!place_pkt.full, "a normal placement rides the active-set DIFF path");
        assert!(
            place_pkt.can_undo,
            "can_undo flips true on the DIFF after the first placement (Pitfall 5)"
        );

        // Drain any queued packets so the next try_recv sees only the undo tick.
        while diff_rx.try_recv().is_ok() {}

        // (2) An Undo gesture -> a full:true keyframe over the diff broadcast.
        gtx.send_gesture(GridCommand::Undo).expect("send undo gesture");
        sim.run(Some(1), Duration::ZERO).expect("fold the undo");
        let undo_bytes = diff_rx
            .try_recv()
            .expect("undo broadcast (reset rides the diff channel, subscriber not Closed)");
        let undo_pkt: fabrico_protocol::RenderPacket =
            postcard::from_bytes(&undo_bytes.bytes).expect("decode undo packet");
        assert!(
            undo_pkt.full,
            "the undo-folding tick emits a full:true keyframe (Pitfall 3)"
        );
        assert!(
            undo_pkt.placed.is_empty(),
            "undo removed the only placed Source -> empty keyframe scene"
        );
        assert!(
            !undo_pkt.can_undo,
            "nothing left to undo after undoing the only gesture"
        );
        assert!(undo_pkt.can_redo, "the undone placement is now redoable");

        // (3) A subsequent idle tick takes the normal DIFF path again — the reset
        //     fires ONLY on undo/redo ticks, never on a plain tick.
        while diff_rx.try_recv().is_ok() {}
        sim.run(Some(1), Duration::ZERO).expect("idle tick");
        let idle_bytes = diff_rx.try_recv().expect("idle broadcast");
        let idle_pkt: fabrico_protocol::RenderPacket =
            postcard::from_bytes(&idle_bytes.bytes).expect("decode idle packet");
        assert!(
            !idle_pkt.full,
            "a non-undo/redo tick takes the DIFF path (reset fires exactly on undo/redo ticks)"
        );
    }

    /// After a Load swap, `SimLoop::tick` equals the loaded `host.core().tick`
    /// (IN-01 re-seed at the swap). The saved scene is advanced past tick 0 so a
    /// stale independent counter would be caught.
    #[test]
    fn load_seeds_tick_from_core() {
        let rt = test_rt();

        // Build a scene, tick it a few times to a non-zero, QUIESCENT head_tick,
        // then save it. A source-only topology never dispatches, so it stays
        // quiescent while its tick advances.
        let save_dir = tempfile::tempdir().expect("save tempdir");
        let mut source = None;
        let host_to_save = build_host(save_dir.path(), |c| {
            source = Some(c.state.add_source());
        });
        let _source = source.expect("source");
        let (_gtx0, grx0) = gesture_channel();
        let mut save_sim =
            SimLoop::new(host_to_save, RenderProducer::new(), rt.handle(), test_cfg(), grx0);
        save_sim.run(Some(5), Duration::ZERO).expect("advance the scene-to-save");
        let saved_tick = save_sim.host().core().tick;
        assert!(saved_tick > 0, "the scene-to-save advanced past genesis");
        assert_eq!(
            save_sim.host().in_flight_len(),
            0,
            "the source-only scene is quiescent at save time"
        );
        let fab = save_dir.path().join("advanced.fab");
        save_project(save_sim.host(), &fab).expect("save the advanced scene");

        // A fresh SimLoop at genesis (tick 0). Freeze it FIRST (Pause → Frozen at
        // genesis quiescence) so the Load swap is serviced with NO trailing tick —
        // isolating the re-seed AT the swap. A live Playing step would tick the
        // loaded host once more right after the swap (also correct — the IN-01
        // invariant `tick == core.tick` still holds — but it would obscure the
        // exact re-seed value asserted here).
        let dir = tempfile::tempdir().expect("tempdir");
        let host_a = build_host(dir.path(), |c| {
            c.state.add_source();
        });
        let (_gtx, grx) = gesture_channel();
        let (ctx, crx) = unbounded_channel::<ControlMsg>();
        let mut sim = SimLoop::new(host_a, RenderProducer::new(), rt.handle(), test_cfg(), grx)
            .with_control(crx);
        assert_eq!(sim.tick, 0, "the fresh loop starts at genesis tick 0");
        ctx.send(ControlMsg::Pause).expect("pause");
        sim.step().expect("freeze");
        assert!(sim.is_paused(), "frozen at genesis before the Load");

        ctx.send(ControlMsg::Load(fab)).expect("send load");
        sim.step().expect("service load");

        assert_eq!(
            sim.tick,
            sim.host().core().tick,
            "SimLoop::tick == host.core().tick after the Load swap (IN-01)"
        );
        assert_eq!(
            sim.tick, saved_tick,
            "the re-seeded tick equals the loaded scene's head_tick (Frozen: no trailing tick)"
        );
    }

    /// A Save from a settled/frozen SimLoop reaches the real `save_project` and
    /// writes a `.fab` that `load_project` re-opens to the same head_tick (HOST-04
    /// happy path; the NotQuiescent backstop is proven in `project.rs`).
    #[test]
    fn save_from_frozen_writes_loadable_file() {
        let rt = test_rt();
        let dir = tempfile::tempdir().expect("tempdir");
        let host = build_host(dir.path(), |c| {
            c.state.add_source();
        });
        let (_gtx, grx) = gesture_channel();
        let (ctx, crx) = unbounded_channel::<ControlMsg>();
        let mut sim = SimLoop::new(host, RenderProducer::new(), rt.handle(), test_cfg(), grx)
            .with_control(crx);

        // Advance a few live ticks, then Pause -> Frozen (genesis-quiescent source
        // only, so it freezes immediately) and Save from the settled state.
        sim.run(Some(3), Duration::ZERO).expect("live ticks");
        ctx.send(ControlMsg::Pause).expect("pause");
        sim.step().expect("freeze");
        assert!(sim.is_paused(), "the sim is settled + frozen before Save");
        let head = sim.host().core().tick;

        let fab = dir.path().join("saved.fab");
        ctx.send(ControlMsg::Save(fab.clone())).expect("send save");
        sim.step().expect("service save");
        assert!(fab.exists(), "Save from Frozen wrote the .fab file");

        // The written file re-opens via the hardened load_project to head_tick.
        let load_dir = tempfile::tempdir().expect("fresh work_dir");
        let loaded = load_project(&fab, load_dir.path(), None).expect("load the saved .fab");
        assert_eq!(
            loaded.core().tick,
            head,
            "the loaded scene reaches the saved head_tick"
        );
    }

    /// WR-01: a Save requested from a BUDGET-FROZEN, non-quiescent state (the
    /// state `step()` lands in when `MAX_SETTLE_TICKS` is exhausted on a stuck
    /// effect) is NOT silently dropped. Before the fix, `run_state` was Frozen
    /// (not Playing), so the Save latch never re-entered the drain and the Frozen
    /// arm of `step()` was a no-op forever — the Save neither ran nor errored.
    /// Now the Save re-enters the drain; with a resolvable (finite-deadline)
    /// effect it settles-then-saves and writes the `.fab`.
    #[test]
    fn save_from_budget_frozen_settles_then_saves() {
        let rt = test_rt();
        let dir = tempfile::tempdir().expect("tempdir");
        let mut node = None;
        let mut host = build_host(dir.path(), |c| {
            node = Some(c.state.add_source());
        });
        let node = node.expect("node");
        // A finite-deadline in-flight effect: it TIMES OUT during the re-drain
        // (deadline <= tick) and folds to quiescence, unlike a u64::MAX hung one.
        host.test_insert_in_flight((0u64, node, 0u32), 3);

        let (_gtx, grx) = gesture_channel();
        let (ctx, crx) = unbounded_channel::<ControlMsg>();
        let mut sim = SimLoop::new(host, RenderProducer::new(), rt.handle(), test_cfg(), grx)
            .with_control(crx);

        // Force the exact BUDGET-FREEZE state: Frozen WHILE an effect is still in
        // flight (what a max-settle overrun on a stuck effect produces). The
        // same-module test reaches the private run-state fields directly.
        sim.run_state = RunState::Frozen;
        sim.paused.store(true, Ordering::Release);
        // Phase 90 review WR-A-04: a real budget freeze is the end of a drain the user's
        // Pause began, so it carries the hold (`pause_on_budget_frozen_then_latched_load_demo_
        // stays_frozen` reaches it through that Pause). Forced without one, the state would
        // be one no path reaches and the end-of-step invariant would refuse it.
        sim.drain_from_user_pause = true;
        assert!(
            sim.host().in_flight_len() > 0,
            "the sim is budget-frozen but NOT quiescent (an effect is in flight)"
        );

        // Save from this budget-frozen, non-quiescent state.
        let fab = dir.path().join("budget-frozen.fab");
        ctx.send(ControlMsg::Save(fab.clone())).expect("send save");
        sim.step().expect("service save (must re-enter the drain, not no-op)");
        assert_eq!(
            sim.run_state,
            RunState::Draining,
            "a Save from a budget-frozen non-quiescent state RE-ENTERS the drain \
             (WR-01: never a silent no-op)"
        );
        assert!(
            !sim.is_paused(),
            "re-entering the drain un-freezes so step() can tick to settle"
        );

        // Drive the bounded re-drain to Frozen; the finite deadline times out, the
        // scene settles to quiescence, and the latched Save runs.
        let mut guard = 0;
        while !fab.exists() {
            sim.step().expect("re-drain step");
            guard += 1;
            assert!(
                guard < (MAX_SETTLE_TICKS as usize) + 50,
                "the re-drain settled and the latched Save fired within the budget"
            );
        }
        assert!(fab.exists(), "the latched Save wrote the .fab after settling (WR-01)");
        assert_eq!(
            sim.host().in_flight_len(),
            0,
            "the effect drained to zero before the Save fired"
        );
    }

    /// Phase 90 review WR-A-02: a Save on a HELD board (the user stepped it) with an executor
    /// effect in flight still drains, because the effect must finish (`save_project` refuses
    /// NotQuiescent), but it waits for that effect ONLY: the belt items need not move, a save
    /// captures them. Before the review fix the drain ran until every belt was empty or
    /// `MAX_SETTLE_TICKS` passed, under a page that reads Paused.
    #[test]
    fn a_save_on_a_held_board_with_an_effect_in_flight_waits_for_the_effect_only() {
        let rt = test_rt();
        let dir = tempfile::tempdir().expect("tempdir");
        let (_gtx, grx) = gesture_channel();
        let (ctx, crx) = unbounded_channel::<ControlMsg>();
        let mut sim = SimLoop::new(build_host(dir.path(), |_| {}), RenderProducer::new(), rt.handle(), test_cfg(), grx)
            .with_control(crx);
        ctx.send(ControlMsg::LoadDemo).expect("send load-demo");
        sim.step().expect("the demo swaps in");
        let mut held = false;
        for _ in 0..1200 {
            sim.step().expect("live tick");
            if sim.host().belt_items_in_flight() > 4 && sim.host().in_flight_len() == 0 {
                ctx.send(ControlMsg::Step).expect("send step");
                sim.step().expect("service step");
                if sim.host().belt_items_in_flight() > 0 && sim.host().in_flight_len() == 0 {
                    held = true;
                    break;
                }
                ctx.send(ControlMsg::Resume).expect("send resume");
            }
        }
        assert!(held, "PRECONDITION: a Step held the demo with belt items and no effect in flight");
        assert_eq!(sim.run_state, RunState::Frozen, "PRECONDITION: the board is held");
        let node = sim.host().core().state.node_ids().next().expect("a node");
        let at = sim.host().core().tick;
        // An effect that times out four ticks on (`deadline <= tick` synthesizes the timeout).
        sim.host.test_insert_in_flight((0u64, node, 0u32), at + 4);
        let fab = dir.path().join("held-effect.fab");
        ctx.send(ControlMsg::Save(fab.clone())).expect("send save");
        let mut steps = 0;
        while !fab.exists() {
            sim.step().expect("drain tick");
            steps += 1;
            assert!(steps <= (MAX_SETTLE_TICKS as usize) + 8, "the Save was written within the budget");
        }
        eprintln!(
            "P90-WR-A-02-effect steps={steps} ticks_run={} belt_items={}",
            sim.host().core().tick - at,
            sim.host().belt_items_in_flight()
        );
        assert!(
            sim.host().core().tick - at <= 8,
            "A HELD BOARD'S SAVE WAITS FOR THE EFFECT ONLY: it ran {} ticks, not until the belts emptied",
            sim.host().core().tick - at
        );
        assert_eq!(sim.run_state, RunState::Frozen, "and the held board stays paused after the write");
    }

    /// Phase 90 review WR-A-04: every path into `Frozen` records the user's hold (a Pause, a
    /// Step, or a drain one of them began or joined; a drain entered for a Save or Load from
    /// Playing restores Playing at its settle), and only Resume clears the hold, moving to
    /// Playing as it does. So "Frozen with no hold" is unreachable, and the code that handled it
    /// was removed with this invariant. A test that forces that state trips the invariant at
    /// the end of the next step instead of grading a path no user can reach.
    #[test]
    #[cfg(debug_assertions)]
    #[should_panic(expected = "FROZEN IMPLIES A USER HOLD")]
    fn a_frozen_board_without_a_user_hold_trips_the_invariant() {
        let rt = test_rt();
        let dir = tempfile::tempdir().expect("tempdir");
        let (_gtx, grx) = gesture_channel();
        let mut sim = SimLoop::new(build_host(dir.path(), |_| {}), RenderProducer::new(), rt.handle(), test_cfg(), grx);
        sim.run_state = RunState::Frozen;
        sim.paused.store(true, Ordering::Release);
        let _ = sim.step();
    }

    /// `LoadDemo` swaps in THE command-built default scene through the host-swap
    /// path (LIVE-03): the producer resets (a pre-existing subscriber stays live
    /// with a full:true keyframe carrying the REAL scene — 6 machines + 5 drawn
    /// belts, Plan 20-03's topology), the loop tick re-seeds from the SEEDED core
    /// (one command folded per tick, so it sits at `demo_commands().len()`, not
    /// 0), and the installed demo timers make items actually FLOW after the swap
    /// — the CTA is not dead.
    #[test]
    fn load_demo_swaps_in_command_built_scene_and_flows() {
        let rt = test_rt();
        let dir = tempfile::tempdir().expect("tempdir");
        let host_a = build_host(dir.path(), |c| {
            c.state.add_source();
        });
        let (_gtx, grx) = gesture_channel();
        let (ctx, crx) = unbounded_channel::<ControlMsg>();
        let mut sim = SimLoop::new(host_a, RenderProducer::new(), rt.handle(), test_cfg(), grx)
            .with_control(crx);
        let (_kf_rx, mut diff_rx) = sim.subscribe();

        // Freeze FIRST (genesis-quiescent, so Pause freezes immediately) so the
        // swap is serviced with NO trailing live tick — isolating the exact IN-01
        // re-seed value (the same pattern `load_seeds_tick_from_core` uses).
        ctx.send(ControlMsg::Pause).expect("pause");
        sim.step().expect("freeze");
        assert!(sim.is_paused(), "frozen before the LoadDemo");

        ctx.send(ControlMsg::LoadDemo).expect("send load-demo");
        sim.step().expect("service load-demo");

        // Producer reset: the pre-existing subscriber receives a full:true packet
        // carrying THE canonical command-built scene (LIVE-03 content assertion).
        let bytes = diff_rx
            .try_recv()
            .expect("LoadDemo reset rides the diff broadcast");
        let pkt: fabrico_protocol::RenderPacket =
            postcard::from_bytes(&bytes.bytes).expect("decode reset packet");
        assert!(pkt.full, "the LoadDemo packet is a full:true keyframe");
        assert_eq!(
            pkt.placed.len(),
            20,
            "the keyframe carries the demo's 11 machines (SOURCE + FACTORY + TEE + 5 SINKs + \
             BALANCER + ROUTER + MERGE), its 7 section labels, the caller Route and the HTTP \
             Handler, all placed by logged commands (the same board a fresh boot builds)"
        );
        assert_eq!(
            pkt.belts.len(),
            11,
            "the keyframe carries the REAL scene's 11 drawn belts"
        );
        assert_eq!(
            pkt.wires.len(),
            2,
            "the keyframe carries the request and reply cables (dormant)"
        );
        // Tick re-seeded from the SEEDED demo core (IN-01): boot_scene folds one
        // command per tick and then the history seal (plan 85-06), so the swapped-in core
        // sits at the list length plus the seal's tick, not 0.
        assert_eq!(sim.tick, sim.host().core().tick, "tick re-seeded at the swap");
        assert_eq!(
            sim.host().core().tick,
            demo_commands().len() as u64 + HISTORY_SEAL_TICKS,
            "the seeded demo core starts at tick == demo_commands().len() + the seal"
        );

        // LIVE-03 "not dead" at the host level: Resume, then the demo timers
        // installed by the swap inject items that ride the belts within ~64
        // post-swap live ticks.
        ctx.send(ControlMsg::Resume).expect("resume");
        let mut flowed = false;
        for _ in 0..64 {
            sim.step().expect("post-swap live tick");
            if sim.host().belt_items_in_flight() > 0 {
                flowed = true;
                break;
            }
        }
        assert!(
            flowed,
            "demo timers drive items onto the belts after the CTA swap (LIVE-03)"
        );
    }

    /// WR-01: `ControlMsg::LoadScene(SceneId::OrderProcessing)` drives the REAL
    /// control path and must inherit NEITHER demo fixture.
    ///
    /// Since plan 85-08 every scene boots through `boot_scene`, so the demo's request
    /// pair and its timer are the demo's own logged commands and cannot reach another
    /// scene by a misplaced arm. This test keeps proving the outcome a user would see if
    /// they did: the order board carries no cable, no Route and no injected item. The
    /// consequence is not cosmetic: demo timers
    /// inject empty-object `{}` items, which the order splitter's `if (!input.id ...)
    /// throw` rejects, faulting the splitter on every fire.
    ///
    /// This is the MIRROR of `load_demo_swaps_in_command_built_scene_and_flows`
    /// above (which asserts the demo arm DOES get the wire and DOES flow), so
    /// neither test can pass by the swap silently failing: this one proves the
    /// order scene actually landed (6 machines, 5 belts, tick re-seeded at the
    /// order command count) before it proves the fixtures are absent.
    #[test]
    fn load_scene_order_processing_seeds_no_demo_fixtures() {
        let rt = test_rt();
        let dir = tempfile::tempdir().expect("tempdir");
        // Start from a NON-empty board so a no-op swap cannot masquerade as success.
        let host_a = build_host(dir.path(), |c| {
            c.state.add_source();
        });
        let (_gtx, grx) = gesture_channel();
        let (ctx, crx) = unbounded_channel::<ControlMsg>();
        let mut sim = SimLoop::new(host_a, RenderProducer::new(), rt.handle(), test_cfg(), grx)
            .with_control(crx);
        let (_kf_rx, mut diff_rx) = sim.subscribe();

        // Freeze FIRST (genesis-quiescent, so Pause freezes immediately) so the swap
        // is serviced with NO trailing live tick, isolating the IN-01 re-seed value.
        ctx.send(ControlMsg::Pause).expect("pause");
        sim.step().expect("freeze");
        assert!(sim.is_paused(), "frozen before the LoadScene");

        ctx.send(ControlMsg::LoadScene(SceneId::OrderProcessing))
            .expect("send load-scene");
        sim.step().expect("service load-scene");

        // ── The swap LANDED (anti-vacuity: every absence assert below is only
        //    meaningful once the order scene is provably on the board). ──────────
        let bytes = diff_rx
            .try_recv()
            .expect("LoadScene reset rides the diff broadcast");
        let pkt: fabrico_protocol::RenderPacket =
            postcard::from_bytes(&bytes.bytes).expect("decode reset packet");
        assert!(pkt.full, "the LoadScene packet is a full:true keyframe");
        assert_eq!(
            pkt.placed.len(),
            6,
            "the keyframe carries the order scene's six machines \
             (Source + 3 Factories + Debug Sink + HTTP Sink)"
        );
        assert_eq!(
            pkt.belts.len(),
            5,
            "the keyframe carries the order scene's five authored belts"
        );
        assert_eq!(sim.tick, sim.host().core().tick, "tick re-seeded at the swap");
        assert_eq!(
            sim.host().core().tick,
            order_commands().len() as u64 + HISTORY_SEAL_TICKS,
            "the swapped-in core starts at tick == order_commands().len() + the seal \
             (one authored command folded per seed tick, then the history seal)"
        );

        // ── FIXTURE 1: the demo headline wire must NOT come across. ────────────
        assert_eq!(
            pkt.wires.len(),
            0,
            "the order arm must NOT inherit the demo's WUI-01 headline wire"
        );
        // ...read straight off the CORE too, not just the packet projection: the
        // headline fixture mints a caller Endpoint + a handler Factory alongside
        // the two wires, and none of the three may exist here.
        let st = &sim.host().core().state;
        assert_eq!(
            st.node_ids()
                .filter(|&i| matches!(
                    st.node(i),
                    Some(fabrico_core::state::Node::Wire(_))
                        | Some(fabrico_core::state::Node::Endpoint(_))
                ))
                .count(),
            0,
            "and the swapped-in CORE carries neither a Wire nor the headline \
             caller Endpoint (the packet is a projection; this reads the state \
             the packet was built from)"
        );

        // ── FIXTURE 2: the demo timers must NOT come across. ───────────────────
        // Demo timers fire every DEMO_INJECT_EVERY (8) ticks; run well past three
        // full periods live. A single logged ManualInject would mean the order
        // scene inherited the demo's `{}` item stream.
        let injects_before = count_injects(&sim);
        ctx.send(ControlMsg::Resume).expect("resume");
        for _ in 0..64 {
            sim.step().expect("post-swap live tick");
        }
        assert_eq!(
            count_injects(&sim),
            injects_before,
            "the order arm installs NO demo timers: 64 live ticks (8x DEMO_INJECT_EVERY) \
             logged zero ManualInject events"
        );
        assert_eq!(
            sim.host().belt_items_in_flight(),
            0,
            "and nothing rode the belts - the order scene animates only on a real \
             webhook POST, never on its own"
        );
    }

    /// quick 260929-p7p (review WR-03): `ControlMsg::LoadScene(SceneId::Advanced)`
    /// drives the REAL control path, and its arm is the only thing that installs the
    /// advanced scene's Timer (`with_timers(timers_from_log(..))`). Without it a
    /// menu-loaded or `FABRICO_BOOT_SCENE` advanced board sits dead until the first
    /// edit, and nothing else in the crate would notice: `advanced_flow.rs` seeds and
    /// projects timers by hand, never through `load_scene_swap`.
    ///
    /// Anti-vacuity first (the scene provably landed: 12 machines, 12 belts, the
    /// identity set), then the two fixture facts: no demo headline wire, and the
    /// Timer fires into the NEW board's Source 0 (the Source at cell (0,6)).
    #[test]
    fn load_scene_advanced_installs_its_timer_and_no_demo_wire() {
        let rt = test_rt();
        let dir = tempfile::tempdir().expect("tempdir");
        // Start from a NON-empty board so a no-op swap cannot masquerade as success.
        let host_a = build_host(dir.path(), |c| {
            c.state.add_source();
        });
        let (_gtx, grx) = gesture_channel();
        let (ctx, crx) = unbounded_channel::<ControlMsg>();
        let mut sim = SimLoop::new(host_a, RenderProducer::new(), rt.handle(), test_cfg(), grx)
            .with_control(crx);
        let (_kf_rx, mut diff_rx) = sim.subscribe();

        ctx.send(ControlMsg::Pause).expect("pause");
        sim.step().expect("freeze");
        assert!(sim.is_paused(), "frozen before the LoadScene");

        ctx.send(ControlMsg::LoadScene(SceneId::Advanced))
            .expect("send load-scene");
        sim.step().expect("service load-scene");

        // ── The swap LANDED. ─────────────────────────────────────────────────
        let bytes = diff_rx
            .try_recv()
            .expect("LoadScene reset rides the diff broadcast");
        let pkt: fabrico_protocol::RenderPacket =
            postcard::from_bytes(&bytes.bytes).expect("decode reset packet");
        assert!(pkt.full, "the LoadScene packet is a full:true keyframe");
        assert_eq!(pkt.placed.len(), 12, "the advanced scene's twelve machines");
        assert_eq!(pkt.belts.len(), 12, "the advanced scene's twelve belts");
        assert_eq!(sim.loaded_scene, Some(SceneId::Advanced), "identity set");

        // ── No demo headline wire, read off the core. ────────────────────────
        assert_eq!(pkt.wires.len(), 0, "no demo headline wire in the packet");
        let st = &sim.host().core().state;
        assert_eq!(
            st.node_ids()
                .filter(|&i| matches!(
                    st.node(i),
                    Some(fabrico_core::state::Node::Wire(_))
                        | Some(fabrico_core::state::Node::Endpoint(_))
                ))
                .count(),
            0,
            "the advanced arm mints neither a Wire nor the headline caller Endpoint"
        );
        let source0 = st
            .node_ids()
            .find(|&i| {
                matches!(st.node(i), Some(fabrico_core::state::Node::Source(_)))
                    && st.cell_of(i) == Some((0, 6))
            })
            .expect("the new board's Source 0 sits at (0,6)");

        // ── The Timer is installed: it fires into Source 0 within ~100 ticks. ─
        let fired = |sim: &SimLoop| {
            sim.host()
                .logged_events()
                .expect("read log")
                .iter()
                .filter(|e| {
                    matches!(e.payload, EventPayload::ManualInject { target, .. } if target == source0)
                })
                .count()
        };
        assert_eq!(fired(&sim), 0, "nothing fired before Resume");
        ctx.send(ControlMsg::Resume).expect("resume");
        for _ in 0..100 {
            sim.step().expect("post-swap live tick");
        }
        assert!(
            fired(&sim) > 0,
            "the advanced arm installs the scene's Timer: 100 live ticks (6x its \
             16-tick interval) logged a ManualInject into the new Source 0"
        );
    }

    /// WR-03: the host, not the click, is the authority on WHICH shipped scene the
    /// board holds. `ControlMsg::QueryScene` answers it at the tick boundary, and a
    /// swap maintains it: LoadScene sets the id, New clears it (a user board has no
    /// shipped-scene badge). Without this the frontend badge was local optimistic
    /// state and a webview reload made it name the wrong example.
    #[test]
    fn query_scene_tracks_the_loaded_shipped_scene_across_swaps() {
        let rt = test_rt();
        let dir = tempfile::tempdir().expect("tempdir");
        let host = build_host(dir.path(), |_| {});
        let (_gtx, grx) = gesture_channel();
        let (ctx, crx) = unbounded_channel::<ControlMsg>();
        let mut sim = SimLoop::new(host, RenderProducer::new(), rt.handle(), test_cfg(), grx)
            .with_loaded_scene(SceneId::Demo)
            .with_control(crx);

        /// Ask the loop, servicing exactly one control drain.
        fn ask(sim: &mut SimLoop, ctx: &UnboundedSender<ControlMsg>) -> Option<SceneId> {
            let (tx, rx) = oneshot::channel();
            ctx.send(ControlMsg::QueryScene { reply: tx })
                .expect("send query");
            sim.step().expect("service query");
            rx.blocking_recv().expect("the tick boundary answered")
        }

        // The boot site DECLARED the pre-seeded demo (both shells seed it outside
        // the loop), so the very first answer is already honest.
        assert_eq!(
            ask(&mut sim, &ctx),
            Some(SceneId::Demo),
            "the declared boot scene is what the host reports"
        );

        ctx.send(ControlMsg::LoadScene(SceneId::OrderProcessing))
            .expect("send load-scene");
        sim.step().expect("service load-scene");
        assert_eq!(
            ask(&mut sim, &ctx),
            Some(SceneId::OrderProcessing),
            "a LoadScene swap re-identifies the board"
        );

        ctx.send(ControlMsg::New).expect("send new");
        sim.step().expect("service new");
        assert_eq!(
            ask(&mut sim, &ctx),
            None,
            "a New board is a USER board: no shipped-scene identity, so no badge"
        );

        ctx.send(ControlMsg::LoadDemo).expect("send load-demo");
        sim.step().expect("service load-demo");
        assert_eq!(
            ask(&mut sim, &ctx),
            Some(SceneId::Demo),
            "the legacy LoadDemo verb routes through the same typed identity"
        );
    }

    /// SAVE-04 host lock: `ControlMsg::New` swaps in a truly EMPTY genesis board.
    /// Starting from a host that HAS a node (one Source), a New swap must leave the
    /// core with ZERO nodes and an EMPTY route table (genesis-empty), re-seed the
    /// loop tick to 0 (no command folded — `new_swap` seeds nothing), emit a
    /// full:true keyframe carrying no machines/belts/wires, and stay non-fatal +
    /// resumable (never a dead click). Mirrors `load_demo_swaps_in_command_built_scene_and_flows`.
    #[test]
    fn new_swap_yields_zero_node_genesis_empty_board_and_is_resumable() {
        let rt = test_rt();
        let dir = tempfile::tempdir().expect("tempdir");
        // Start with a NON-empty board so the swap has something to wipe.
        let host_a = build_host(dir.path(), |c| {
            c.state.add_source();
        });
        let (_gtx, grx) = gesture_channel();
        let (ctx, crx) = unbounded_channel::<ControlMsg>();
        let mut sim = SimLoop::new(host_a, RenderProducer::new(), rt.handle(), test_cfg(), grx)
            .with_control(crx);
        let (_kf_rx, mut diff_rx) = sim.subscribe();

        // The pre-swap board really does have the one Source (proves New wiped it).
        assert_eq!(
            sim.host().core().state.node_count(),
            1,
            "pre-New board has the one seeded Source"
        );

        // Freeze FIRST (genesis-quiescent → Pause freezes immediately) so the swap is
        // serviced with NO trailing live tick, isolating the exact IN-01 re-seed value.
        ctx.send(ControlMsg::Pause).expect("pause");
        sim.step().expect("freeze");
        assert!(sim.is_paused(), "frozen before the New");

        ctx.send(ControlMsg::New).expect("send new");
        sim.step().expect("service new");

        // Producer reset: the pre-existing subscriber receives a full:true keyframe
        // carrying an EMPTY scene (SAVE-04: 0 machines, 0 belts, 0 wires).
        let bytes = diff_rx
            .try_recv()
            .expect("New reset rides the diff broadcast");
        let pkt: fabrico_protocol::RenderPacket =
            postcard::from_bytes(&bytes.bytes).expect("decode reset packet");
        assert!(pkt.full, "the New packet is a full:true keyframe");
        assert_eq!(pkt.placed.len(), 0, "New keyframe carries ZERO machines");
        assert_eq!(pkt.belts.len(), 0, "New keyframe carries ZERO belts");
        assert_eq!(pkt.wires.len(), 0, "New keyframe carries ZERO wires");

        // The swapped-in core is genesis-EMPTY: zero nodes and an empty route table.
        assert_eq!(
            sim.host().core().state.node_count(),
            0,
            "New yields a zero-node genesis-empty board (SAVE-04 host lock)"
        );
        assert!(
            project_routes(sim.host().core(), sim.host().timers()).is_empty(),
            "New re-publishes an EMPTY route table (no nodes → no routes)"
        );
        // Tick re-seeded from the genesis-empty core (IN-01): `new_swap` folds NO
        // command, so the swapped-in core sits at tick 0.
        assert_eq!(sim.tick, sim.host().core().tick, "tick re-seeded at the swap");
        assert_eq!(
            sim.host().core().tick,
            0,
            "the genesis-empty New core starts at tick 0 (nothing seeded)"
        );

        // Non-fatal + resumable: New is never a dead click — Resume returns to
        // Playing and the loop keeps ticking cleanly over the empty board.
        ctx.send(ControlMsg::Resume).expect("resume");
        for _ in 0..8 {
            sim.step().expect("post-New live tick over the empty board");
        }
        assert!(!sim.is_paused(), "New leaves the loop resumable (not a dead click)");
        assert_eq!(
            sim.host().core().state.node_count(),
            0,
            "the empty board stays empty as it ticks (nothing to inject)"
        );
    }

    /// The LIVE CTA contract (LIVE-03, the 20-05 live finding): `LoadDemo` sent
    /// while the sim is PLAYING with work in flight (the default live situation —
    /// the demo always has items flowing) latches, drains to quiescence, swaps,
    /// and then RESUMES ON ITS OWN. The frontend CTA sends ONLY `load_demo` (no
    /// follow-up resume), so a latched swap that stayed Frozen was a dead-looking
    /// button: the grid repopulated but the sim never ticked again.
    #[test]
    fn load_demo_latched_while_playing_resumes_flow_without_manual_resume() {
        let rt = test_rt();
        let dir = tempfile::tempdir().expect("tempdir");
        let mut node = None;
        let mut host_a = build_host(dir.path(), |c| {
            node = Some(c.state.add_source());
        });
        // A finite-deadline in-flight effect: non-quiescent at CTA time, so the
        // LoadDemo LATCHES (the live-app case); it times out during the drain.
        host_a.test_insert_in_flight((0u64, node.expect("node"), 0u32), 3);

        let (_gtx, grx) = gesture_channel();
        let (ctx, crx) = unbounded_channel::<ControlMsg>();
        let mut sim = SimLoop::new(host_a, RenderProducer::new(), rt.handle(), test_cfg(), grx)
            .with_control(crx);
        assert_eq!(sim.run_state, RunState::Playing, "the sim is live-playing");
        assert!(
            sim.host().in_flight_len() > 0,
            "work is in flight at CTA time (the latch path, not the immediate swap)"
        );

        // The CTA: exactly ONE control frame, `load_demo` — nothing else.
        ctx.send(ControlMsg::LoadDemo).expect("send load-demo");
        sim.step().expect("service load-demo (latches + re-enters the drain)");
        assert_eq!(
            sim.run_state,
            RunState::Draining,
            "a non-quiescent LoadDemo drains before the swap (WR-02)"
        );

        // Drive to the swap; then — with NO Resume ever sent — the demo timers
        // must put items on the belts (the "items keep flowing" truth).
        let mut flowed = false;
        for _ in 0..((MAX_SETTLE_TICKS as usize) + 128) {
            sim.step().expect("drain/swap/post-swap step");
            if sim.host().belt_items_in_flight() > 0 {
                flowed = true;
                break;
            }
        }
        assert!(
            flowed,
            "after a latched LoadDemo the sim resumes on its own and items flow \
             (LIVE-03: the CTA is never a dead click)"
        );
        assert_eq!(
            sim.run_state,
            RunState::Playing,
            "the latched swap restored Playing (the latch was swap-safety, not a user Pause)"
        );
        assert!(!sim.is_paused(), "the executor hold flag cleared at the auto-resume");
    }

    /// 20-review WR-01: a latched load must NOT discard an explicit user Pause.
    /// Interleaving: Pause a non-quiescent sim (-> Draining), then LoadDemo while
    /// the drain is still running (-> latched). When the drain freezes, the swap
    /// installs the demo scene (the CTA visibly lands — the producer reset
    /// repopulates the grid), but the sim STAYS Frozen: the user's Pause is
    /// respected instead of being auto-resumed over. An explicit Resume then
    /// plays the swapped-in demo (the pause record is superseded, not sticky).
    #[test]
    fn pause_joined_by_latched_load_demo_stays_frozen_after_swap() {
        let rt = test_rt();
        let dir = tempfile::tempdir().expect("tempdir");
        let mut node = None;
        let mut host_a = build_host(dir.path(), |c| {
            node = Some(c.state.add_source());
        });
        // A finite-deadline in-flight effect: non-quiescent at Pause time (so the
        // Pause enters Draining); it times out during the drain.
        host_a.test_insert_in_flight((0u64, node.expect("node"), 0u32), 3);

        let (_gtx, grx) = gesture_channel();
        let (ctx, crx) = unbounded_channel::<ControlMsg>();
        let mut sim = SimLoop::new(host_a, RenderProducer::new(), rt.handle(), test_cfg(), grx)
            .with_control(crx);

        // The user's explicit Pause first (non-quiescent -> Draining) ...
        ctx.send(ControlMsg::Pause).expect("send pause");
        sim.step().expect("service pause (enters the drain)");
        assert_eq!(sim.run_state, RunState::Draining, "the Pause entered the drain");
        // ... then the CTA while the drain is still running -> the load LATCHES.
        ctx.send(ControlMsg::LoadDemo).expect("send load-demo");
        sim.step().expect("service load-demo (latches behind the drain)");

        // Drive the drain to its freeze; the latched swap fires there. The old
        // scene has ONE node; the swapped-in demo has many — the count is the
        // swap oracle.
        let mut guard = 0;
        while sim.host().core().state.node_count() < 2 {
            sim.step().expect("drain/swap step");
            guard += 1;
            assert!(
                guard < (MAX_SETTLE_TICKS as usize) + 50,
                "the drain froze and the latched swap fired within the budget"
            );
        }
        // The swap installed the seeded demo core (the CTA is not a dead click).
        assert_eq!(
            sim.host().core().tick,
            demo_commands().len() as u64 + HISTORY_SEAL_TICKS,
            "the demo scene installed at the freeze (seeded core and its seal, no trailing tick)"
        );

        // ... but the user's Pause is RESPECTED: Frozen, executor held, no tick.
        assert_eq!(
            sim.run_state,
            RunState::Frozen,
            "a user-paused drain stays Frozen after the latched swap (WR-01)"
        );
        assert!(sim.is_paused(), "the executor hold flag stays set (no auto-resume)");
        let frozen_tick = sim.host().core().tick;
        for _ in 0..10 {
            sim.step().expect("frozen no-op");
        }
        assert_eq!(
            sim.host().core().tick,
            frozen_tick,
            "the sim does not tick after the swap — the explicit Pause was not discarded"
        );

        // An explicit Resume supersedes the recorded Pause: the demo flows.
        ctx.send(ControlMsg::Resume).expect("resume");
        let mut flowed = false;
        for _ in 0..64 {
            sim.step().expect("post-resume live tick");
            if sim.host().belt_items_in_flight() > 0 {
                flowed = true;
                break;
            }
        }
        assert!(
            flowed,
            "an explicit Resume after the paused swap plays the demo (the pause \
             record is cleared by Resume, not sticky)"
        );
    }

    /// 20-review iter-2 WR-01: a LoadDemo on a BUDGET-frozen sim (frozen by the
    /// max-settle budget with an effect still in flight, i.e. frozen WITHOUT being
    /// settled) keeps the user's Pause: the swap installs, the sim stays Frozen, and
    /// only an explicit Resume plays the loaded scene.
    ///
    /// Phase 90 review WR-A-04: the budget freeze is now REACHED, through the user's
    /// own Pause on a board whose effect outlives the settle budget, instead of being
    /// forced by hand with no hold recorded (a state no path reaches: the invariant at
    /// the end of `step()`). A second Pause on the budget-frozen board is a no-op.
    #[test]
    fn pause_on_budget_frozen_then_latched_load_demo_stays_frozen() {
        let rt = test_rt();
        let dir = tempfile::tempdir().expect("tempdir");
        let mut node = None;
        let mut host = build_host(dir.path(), |c| {
            node = Some(c.state.add_source());
        });
        // A finite-deadline in-flight effect that OUTLIVES the Pause's settle budget,
        // so the Pause drain budget-freezes with it still in flight, and then TIMES OUT
        // during the LoadDemo's re-drain so the latched swap actually fires.
        let deadline = host.core().tick + MAX_SETTLE_TICKS + 20;
        host.test_insert_in_flight((0u64, node.expect("node"), 0u32), deadline);

        let (_gtx, grx) = gesture_channel();
        let (ctx, crx) = unbounded_channel::<ControlMsg>();
        let mut sim = SimLoop::new(host, RenderProducer::new(), rt.handle(), test_cfg(), grx)
            .with_control(crx);

        // The user's Pause drains until the budget runs out: Frozen WHILE the effect
        // is still in flight, the BUDGET-FREEZE state, with the Pause's hold.
        ctx.send(ControlMsg::Pause).expect("send pause");
        let mut guard = 0;
        while sim.run_state != RunState::Frozen {
            sim.step().expect("pause drain tick");
            guard += 1;
            assert!(guard <= (MAX_SETTLE_TICKS as usize) + 8, "the Pause drain budget-froze");
        }
        assert!(
            sim.host().in_flight_len() > 0,
            "the sim is budget-frozen but NOT quiescent (an effect is in flight)"
        );
        assert!(sim.drain_from_user_pause, "the budget freeze carries the Pause's hold");

        // A second Pause on the budget-frozen sim is a no-op.
        ctx.send(ControlMsg::Pause).expect("send pause");
        sim.step().expect("service pause on budget-frozen (no-op)");
        assert_eq!(
            sim.run_state,
            RunState::Frozen,
            "Pause on a budget-frozen sim stays Frozen (no state change)"
        );

        // Then the CTA: LoadDemo from budget-frozen re-enters the drain and
        // latches (the WR-01 iter-1 Save/Load re-drain contract).
        ctx.send(ControlMsg::LoadDemo).expect("send load-demo");
        sim.step().expect("service load-demo (re-enters the drain, latches)");
        assert_eq!(
            sim.run_state,
            RunState::Draining,
            "a non-quiescent LoadDemo from budget-frozen re-enters the drain"
        );

        // Drive to the freeze; the effect times out, the latched swap fires.
        // The old scene has ONE node; the demo has many - the count is the
        // swap oracle.
        let mut guard = 0;
        while sim.host().core().state.node_count() < 2 {
            sim.step().expect("drain/swap step");
            guard += 1;
            assert!(
                guard < (MAX_SETTLE_TICKS as usize) + 50,
                "the re-drain froze and the latched swap fired within the budget"
            );
        }
        assert_eq!(
            sim.host().core().tick,
            demo_commands().len() as u64 + HISTORY_SEAL_TICKS,
            "the demo scene installed at the freeze (the CTA is not a dead click)"
        );

        // The user's Pause is RESPECTED - the SAME envelope the settled-frozen
        // Pause-then-Load story gets: swap installed, sim stays Frozen.
        assert_eq!(
            sim.run_state,
            RunState::Frozen,
            "a budget-frozen user Pause survives the latched swap: no auto-resume \
             (iter-2 WR-01)"
        );
        assert!(sim.is_paused(), "the executor hold flag stays set (no auto-resume)");
        let frozen_tick = sim.host().core().tick;
        for _ in 0..10 {
            sim.step().expect("frozen no-op");
        }
        assert_eq!(
            sim.host().core().tick,
            frozen_tick,
            "the sim does not tick after the swap - the Pause intent was recorded"
        );

        // An explicit Resume supersedes the recorded Pause: the demo flows.
        ctx.send(ControlMsg::Resume).expect("resume");
        let mut flowed = false;
        for _ in 0..64 {
            sim.step().expect("post-resume live tick");
            if sim.host().belt_items_in_flight() > 0 {
                flowed = true;
                break;
            }
        }
        assert!(
            flowed,
            "an explicit Resume after the paused swap plays the demo (the pause \
             record is cleared by Resume, not sticky)"
        );
    }

    /// 73-07 (deviation Rule 1): a reopened board is never a dead board. Found by
    /// `frontend/e2e-live/30-post-load-undo.spec.ts`, whose render-health assertion reddened
    /// on a Pixi frame index frozen at 19 after "save, then open the file again".
    ///
    /// # Reached through real commands since the phase 90 review (WR-A-04)
    /// This test was `a_file_load_after_a_save_drain_resumes_the_sim`, and after D-08 it
    /// FORCED its starting state by hand: Frozen with no user hold, what a Save drain left
    /// before D-08. No path reaches that state now (the invariant at the end of `step()`),
    /// so the resume tail it pinned was removed. What a user reaches is pinned instead: the
    /// ordinary path is a Save on a running board, which plays on (D-08), and then an Open,
    /// which keeps the board playing on the loaded file.
    #[test]
    fn a_file_load_after_a_save_on_a_running_board_keeps_it_playing() {
        let rt = tokio::runtime::Runtime::new().expect("rt");
        let _g = rt.enter();

        // Save a two-source scene to a real `.fab` - the file the user will reopen.
        let save_dir = tempfile::tempdir().expect("tempdir");
        let host_to_save = build_host(save_dir.path(), |c| {
            c.state.add_source();
            c.state.add_source();
        });
        let fab = save_dir.path().join("resume.fab");
        save_project(&host_to_save, &fab).expect("save the scene-to-load");

        let dir = tempfile::tempdir().expect("tempdir");
        let host_a = build_host(dir.path(), |c| {
            c.state.add_source();
        });
        let (_gtx, grx) = gesture_channel();
        let (ctx, crx) = unbounded_channel::<ControlMsg>();
        let mut sim = SimLoop::new(host_a, RenderProducer::new(), rt.handle(), test_cfg(), grx)
            .with_control(crx);
        sim.step().expect("one live tick on the still board");

        // (1) SAVE the running board: it plays on (D-08).
        let own = dir.path().join("own.fab");
        ctx.send(ControlMsg::Save(own.clone())).expect("send save");
        sim.step().expect("service save");
        assert!(own.exists(), "PRECONDITION: the Save on the quiescent running board wrote at once");
        assert_eq!(sim.run_state, RunState::Playing, "PRECONDITION: the Save left the board playing");

        // (2) LOAD the other file onto that board, the immediate arm.
        ctx.send(ControlMsg::Load(fab)).expect("send load");
        sim.step().expect("service load");
        assert_eq!(
            sim.host().core().state.node_ids().count(),
            2,
            "the loaded scene (two sources) replaced the board"
        );

        // (3) AND THE SIM IS RUNNING. A `Frozen` sim never reaches `acquire_input`, so it
        // drains NO gestures: the user's next Ctrl+Z on a reopened board would never be seen.
        assert_eq!(sim.run_state, RunState::Playing, "the reopened board is PLAYING, not Frozen");
        assert!(!sim.is_paused(), "and the executor hold flag is clear, so gestures are drained");
        let after_swap = sim.host().core().tick;
        for _ in 0..8 {
            sim.step().expect("post-load live tick");
        }
        assert!(
            sim.host().core().tick > after_swap,
            "the reopened board keeps ticking - it was {after_swap} and it has not moved"
        );
    }

    /// 73-12 (73-REVIEW WR-02): a REFUSED file Load does NOT resume a paused sim, and the user
    /// is told why. Before 73-12 the immediate arm's resume tail started the OLD board running
    /// at the moment the user asked to open a different one.
    ///
    /// # Reached through real commands since the phase 90 review (WR-A-04)
    /// This test FORCED its Frozen state by hand with no user hold, a state no path reaches
    /// (the invariant at the end of `step()`). It is reached now through the user's own Pause
    /// on the quiescent board, which is what a Frozen board always is.
    ///
    /// RED BEFORE THE 73-12 GATE: `run_state` read `Playing`.
    #[test]
    fn a_refused_file_load_on_a_paused_board_leaves_it_frozen_and_says_why() {
        let rt = tokio::runtime::Runtime::new().expect("rt");
        let _g = rt.enter();

        // A path `load_project` cannot load: the file simply is not there. The refusal REASON
        // is `project_error_copy.rs`'s subject; this row measures the RUN STATE afterwards.
        let dir = tempfile::tempdir().expect("tempdir");
        let bogus = dir.path().join("no-such-board.fab");

        let host_a = build_host(dir.path(), |c| {
            c.state.add_source();
        });
        let (_gtx, grx) = gesture_channel();
        let (ctx, crx) = unbounded_channel::<ControlMsg>();
        let refusals: std::sync::Arc<std::sync::Mutex<Vec<String>>> =
            std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink_target = std::sync::Arc::clone(&refusals);
        let mut sim = SimLoop::new(host_a, RenderProducer::new(), rt.handle(), test_cfg(), grx)
            .with_control(crx)
            .with_load_refusal_sink(Box::new(move |reason| {
                sink_target.lock().expect("sink lock").push(reason);
            }));

        sim.step().expect("one live tick on the still board");
        // The user's Pause on the quiescent board freezes it at once, with the hold.
        ctx.send(ControlMsg::Pause).expect("send pause");
        sim.step().expect("service pause");
        assert_eq!(sim.run_state, RunState::Frozen, "PRECONDITION: the Pause froze the still board");
        let nodes_before = sim.host().core().state.node_ids().count();

        // THE REFUSED LOAD, on the immediate arm.
        ctx.send(ControlMsg::Load(bogus)).expect("send the refused load");
        sim.step().expect("service the refused load");

        assert_eq!(
            sim.host().core().state.node_ids().count(),
            nodes_before,
            "the current scene is KEPT"
        );
        assert_eq!(
            refusals.lock().expect("sink lock").len(),
            1,
            "and the user is told - read FIRST, so a build that refused silently fails here"
        );
        assert_eq!(sim.run_state, RunState::Frozen, "a REFUSED load leaves the paused sim Frozen");
        assert!(sim.is_paused(), "and the executor hold flag stays set");
        let after = sim.host().core().tick;
        for _ in 0..8 {
            sim.step().expect("post-refusal tick");
        }
        assert_eq!(
            sim.host().core().tick,
            after,
            "the kept board is not secretly running - it was {after} and it has moved"
        );
    }

    /// Phase 90 review WR-A-04, the reachable twin the review asked for: Pause a BUSY board,
    /// let the Pause drain settle it, then open a file. The board swaps and stays Frozen,
    /// because the user paused it.
    #[test]
    fn a_file_load_on_a_board_paused_after_its_drain_stays_frozen() {
        let rt = tokio::runtime::Runtime::new().expect("rt");
        let _g = rt.enter();
        let save_dir = tempfile::tempdir().expect("tempdir");
        let host_to_save = build_host(save_dir.path(), |c| {
            c.state.add_source();
            c.state.add_source();
        });
        let fab = save_dir.path().join("to-open.fab");
        save_project(&host_to_save, &fab).expect("save the scene-to-load");

        let dir = tempfile::tempdir().expect("tempdir");
        let mut node = None;
        let mut host_a = build_host(dir.path(), |c| {
            node = Some(c.state.add_source());
        });
        // Busy: an effect in flight that times out a few ticks into the Pause drain.
        host_a.test_insert_in_flight((0u64, node.expect("node"), 0u32), 3);
        let (_gtx, grx) = gesture_channel();
        let (ctx, crx) = unbounded_channel::<ControlMsg>();
        let mut sim = SimLoop::new(host_a, RenderProducer::new(), rt.handle(), test_cfg(), grx)
            .with_control(crx);

        ctx.send(ControlMsg::Pause).expect("send pause");
        sim.step().expect("service pause (the busy board drains)");
        assert_eq!(sim.run_state, RunState::Draining, "PRECONDITION: the busy board drained first");
        let mut guard = 0;
        while sim.run_state != RunState::Frozen {
            sim.step().expect("drain tick");
            guard += 1;
            assert!(guard < 50, "the Pause drain settled");
        }
        assert_eq!(sim.host().in_flight_len(), 0, "PRECONDITION: settled, not budget-frozen");

        ctx.send(ControlMsg::Load(fab)).expect("send load");
        sim.step().expect("service load");
        assert_eq!(sim.host().core().state.node_ids().count(), 2, "the file's board is installed");
        assert_eq!(sim.run_state, RunState::Frozen, "A LOAD ON A PAUSED BOARD STAYS FROZEN");
        assert!(sim.is_paused(), "and the executor hold flag stays set");
    }

    /// Phase 90 review CR-A-01 and WR-B-05 (this replaces 20-review iter-2 CR-01's
    /// `resume_mid_drain_disarms_latched_load`): an explicit Resume mid-drain KEEPS a latched
    /// Load/LoadDemo (and Save) and only lifts the hold. CR-01 cancelled the latch, because a
    /// latch left armed after its drain was aborted fired at some arbitrary LATER freeze. The
    /// Resume no longer aborts the drain: the latch fires at THIS drain's settle, the board then
    /// plays (the hold is lifted), and a later unrelated Pause installs nothing. Cancelling lost a
    /// Save in silence after the page had cleared its Unsaved badge.
    #[test]
    fn resume_mid_drain_keeps_the_latched_load_and_fires_it_at_this_settle() {
        let rt = test_rt();
        let dir = tempfile::tempdir().expect("tempdir");
        let mut node = None;
        let mut host_a = build_host(dir.path(), |c| {
            node = Some(c.state.add_source());
        });
        // A finite-deadline in-flight effect: non-quiescent at CTA time, so the
        // LoadDemo LATCHES and enters the swap-safety drain; the effect times
        // out on its own a few ticks later.
        host_a.test_insert_in_flight((0u64, node.expect("node"), 0u32), 3);

        let (_gtx, grx) = gesture_channel();
        let (ctx, crx) = unbounded_channel::<ControlMsg>();
        let mut sim = SimLoop::new(host_a, RenderProducer::new(), rt.handle(), test_cfg(), grx)
            .with_control(crx);

        // The CTA latches behind a swap-safety drain ...
        ctx.send(ControlMsg::LoadDemo).expect("send load-demo");
        sim.step().expect("service load-demo (latches + enters the drain)");
        assert_eq!(sim.run_state, RunState::Draining, "the LoadDemo entered the drain");
        assert!(sim.pending_load.is_some(), "the LoadDemo latched behind the drain");

        // ... and a Pause then a Resume arrive MID-DRAIN. The drain runs on and the latch is kept.
        ctx.send(ControlMsg::Pause).expect("send pause");
        sim.step().expect("service pause (joins the drain)");
        ctx.send(ControlMsg::Resume).expect("send resume");
        sim.step().expect("service resume (lifts the hold, keeps the drain)");
        assert!(!sim.drain_from_user_pause, "the Resume lifted the user's hold");

        // The drain settles at THIS freeze: the demo is installed and the board plays.
        let mut guard = 0;
        while sim.host().core().state.node_count() == 1 {
            sim.step().expect("drain tick");
            guard += 1;
            assert!(guard < 50, "the latched LoadDemo fired at this drain's settle (CR-A-01)");
        }
        assert_eq!(sim.run_state, RunState::Playing, "the hold was lifted, so the demo plays");
        assert!(sim.pending_load.is_none(), "the latch was consumed by its own drain");
        let demo_nodes = sim.host().core().state.node_count();
        assert!(demo_nodes > 1, "the demo board replaced the one-source board");

        // A LATER unrelated Pause installs nothing more: no stale latch survives.
        ctx.send(ControlMsg::Pause).expect("send pause");
        let mut guard = 0;
        while sim.run_state != RunState::Frozen {
            sim.step().expect("pause drain tick");
            guard += 1;
            assert!(guard < (MAX_SETTLE_TICKS as usize) + 8, "the later Pause froze the sim");
        }
        assert_eq!(
            sim.host().core().state.node_count(),
            demo_nodes,
            "the LATER freeze installs NOTHING: the latch fired once, at its own drain"
        );
    }

    /// A quiescent playing one-source board with a recording load-refusal sink, and a saved
    /// two-source `.fab` to open on it (the deferred "two host Load failures" rig).
    fn refusal_rig(
        rt: &tokio::runtime::Runtime,
        dir: &std::path::Path,
    ) -> (SimLoop, UnboundedSender<ControlMsg>, PathBuf, std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
        let to_save = tempfile::tempdir().expect("tempdir");
        let host_to_save = build_host(to_save.path(), |c| {
            c.state.add_source();
            c.state.add_source();
        });
        let fab = dir.join("good.fab");
        save_project(&host_to_save, &fab).expect("save the scene-to-load");
        let host_a = build_host(dir, |c| {
            c.state.add_source();
        });
        let (_gtx, grx) = gesture_channel();
        let (ctx, crx) = unbounded_channel::<ControlMsg>();
        let refusals = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink_target = std::sync::Arc::clone(&refusals);
        let mut sim = SimLoop::new(host_a, RenderProducer::new(), rt.handle(), test_cfg(), grx)
            .with_control(crx)
            .with_load_refusal_sink(Box::new(move |reason| {
                sink_target.lock().expect("sink lock").push(reason);
            }));
        sim.step().expect("one live tick on the still board");
        (sim, ctx, fab, refusals)
    }

    /// The house voice the load-refusal card holds every sentence to (`project_error_copy.rs`
    /// GATE 1): no em or en dash, a terminal period.
    fn assert_house_voice(reason: &str) {
        assert!(!reason.contains('\u{2014}') && !reason.contains('\u{2013}'), "no dash: {reason}");
        assert!(reason.ends_with('.'), "a terminal period: {reason}");
    }

    /// Phase 90 review, the deferred item "Two host Load failures send no refusal" (plan 90-04):
    /// a Load whose work folder cannot be created reaches the page as a refusal with a reason,
    /// at once, instead of `Loading...` until the page's cut-off.
    #[test]
    fn a_load_whose_work_folder_cannot_be_made_is_refused_with_a_reason() {
        let rt = test_rt();
        let dir = tempfile::tempdir().expect("tempdir");
        let (mut sim, ctx, fab, refusals) = refusal_rig(&rt, dir.path());
        sim.fail_next_load_work_dir = true;
        ctx.send(ControlMsg::Load(fab)).expect("send load");
        sim.step().expect("service load");
        let seen = refusals.lock().expect("sink lock").clone();
        assert_eq!(seen, vec![LOAD_WORK_DIR_REFUSAL.to_owned()], "THE WORK-FOLDER FAILURE IS SAID");
        assert_house_voice(LOAD_WORK_DIR_REFUSAL);
        assert_eq!(sim.host().core().state.node_count(), 1, "the current board is kept");
    }

    /// The same deferred item: a Load whose timers cannot be projected from its edit log.
    #[test]
    fn a_load_whose_timers_cannot_be_read_is_refused_with_a_reason() {
        let rt = test_rt();
        let dir = tempfile::tempdir().expect("tempdir");
        let (mut sim, ctx, fab, refusals) = refusal_rig(&rt, dir.path());
        sim.fail_next_load_timers = true;
        ctx.send(ControlMsg::Load(fab)).expect("send load");
        sim.step().expect("service load");
        let seen = refusals.lock().expect("sink lock").clone();
        assert_eq!(seen, vec![LOAD_TIMERS_REFUSAL.to_owned()], "THE TIMER FAILURE IS SAID");
        assert_house_voice(LOAD_TIMERS_REFUSAL);
        assert_eq!(sim.host().core().state.node_count(), 1, "the current board is kept");
    }

    /// A playing one-source board with a recording save-failure sink.
    fn save_failure_rig(
        rt: &tokio::runtime::Runtime,
        dir: &std::path::Path,
        hung_effect: bool,
    ) -> (SimLoop, UnboundedSender<ControlMsg>, std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
        let mut node = None;
        let mut host = build_host(dir, |c| {
            node = Some(c.state.add_source());
        });
        if hung_effect {
            // An effect that never resolves, so a Save drain runs out of its settle budget.
            host.test_insert_in_flight((0u64, node.expect("node"), 0u32), u64::MAX);
        }
        let (_gtx, grx) = gesture_channel();
        let (ctx, crx) = unbounded_channel::<ControlMsg>();
        let failures = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink_target = std::sync::Arc::clone(&failures);
        let sim = SimLoop::new(host, RenderProducer::new(), rt.handle(), test_cfg(), grx)
            .with_control(crx)
            .with_save_failure_sink(Box::new(move |reason| {
                sink_target.lock().expect("sink lock").push(reason);
            }));
        (sim, ctx, failures)
    }

    /// Phase 90 review WR-A-03: a Save the host cannot write reaches the save-failure sink with
    /// the host's sentence, so the page can say `Save failed` instead of reading the board saved.
    #[test]
    fn a_save_the_host_cannot_write_reaches_the_save_failure_sink() {
        let rt = test_rt();
        let dir = tempfile::tempdir().expect("tempdir");
        let (mut sim, ctx, failures) = save_failure_rig(&rt, dir.path(), false);
        sim.step().expect("one live tick on the still board");
        let path = dir.path().join("no-such-folder").join("board.fab");
        ctx.send(ControlMsg::Save(path.clone())).expect("send save");
        sim.step().expect("service save");
        let seen = failures.lock().expect("sink lock").clone();
        eprintln!("P90-WR-A-03-io failures={seen:?}");
        assert!(!path.exists(), "PRECONDITION: the file could not be written");
        assert_eq!(seen.len(), 1, "A FAILED SAVE IS SAID: one sentence reached the sink");
        assert!(
            !seen[0].contains(&*dir.path().to_string_lossy()),
            "and it names no filesystem path: {}",
            seen[0]
        );
        assert_eq!(sim.run_state, RunState::Playing, "the running board runs on");
    }

    /// Phase 90 review WR-A-03: a Save drain that runs out of its settle budget with an effect
    /// still in flight is refused NotQuiescent, and that refusal reaches the sink. The board then
    /// restores the state it had before the Save (Playing), as D-08 says, but it no longer does so
    /// as if the file had been written.
    #[test]
    fn a_save_drain_that_runs_out_of_budget_is_said_and_the_board_plays_on() {
        let rt = test_rt();
        let dir = tempfile::tempdir().expect("tempdir");
        let (mut sim, ctx, failures) = save_failure_rig(&rt, dir.path(), true);
        let path = dir.path().join("budget.fab");
        ctx.send(ControlMsg::Save(path.clone())).expect("send save");
        sim.step().expect("service save (latches, drains)");
        assert_eq!(sim.run_state, RunState::Draining, "PRECONDITION: the Save drained first");
        for _ in 0..(MAX_SETTLE_TICKS + 4) {
            sim.step().expect("drain tick");
        }
        let seen = failures.lock().expect("sink lock").clone();
        eprintln!("P90-WR-A-03-budget failures={seen:?} run_state={:?}", sim.run_state);
        assert!(!path.exists(), "PRECONDITION: the file was not written");
        assert_eq!(seen.len(), 1, "A SAVE DRAIN OUT OF BUDGET IS SAID: one sentence reached the sink");
        assert_eq!(sim.run_state, RunState::Playing, "and the board plays on, as it did before the Save");
    }

    /// D-04 / T-20-08: a `Load` of a USER project installs NO demo timers — user
    /// scenes are driven by real webhooks, never host-forged demo injections. A
    /// minimal quiescent user scene (one Source) is saved, Loaded through the
    /// host-swap path, and run ~32 live ticks: no item ever rides a belt and no
    /// `ManualInject` event is ever logged.
    #[test]
    fn load_of_user_project_installs_no_timers() {
        let rt = test_rt();

        // A minimal quiescent USER scene (one Source), saved to a .fab.
        let save_dir = tempfile::tempdir().expect("save tempdir");
        let host_to_save = build_host(save_dir.path(), |c| {
            c.state.add_source();
        });
        assert_eq!(host_to_save.in_flight_len(), 0, "the user scene is quiescent");
        let fab = save_dir.path().join("user-scene.fab");
        save_project(&host_to_save, &fab).expect("save the user scene");

        // A fresh sim; Load the user project (quiescent: swaps immediately).
        let dir = tempfile::tempdir().expect("tempdir");
        let host_a = build_host(dir.path(), |c| {
            c.state.add_source();
        });
        let (_gtx, grx) = gesture_channel();
        let (ctx, crx) = unbounded_channel::<ControlMsg>();
        let mut sim = SimLoop::new(host_a, RenderProducer::new(), rt.handle(), test_cfg(), grx)
            .with_control(crx);
        ctx.send(ControlMsg::Load(fab)).expect("send load");
        sim.step().expect("service load");

        // ~32 live ticks: NO timer exists on the loaded host, so nothing is ever
        // injected — no belt item and zero logged ManualInject events.
        for _ in 0..32 {
            sim.step().expect("post-load live tick");
            assert_eq!(
                sim.host().belt_items_in_flight(),
                0,
                "a user Load never gains demo timers (no item ever rides a belt)"
            );
        }
        assert_eq!(
            count_injects(&sim),
            0,
            "zero ManualInject events logged after a user-project Load (T-20-08)"
        );
    }

    /// WR-02: a `Load` requested while the OLD scene still has an outstanding
    /// executor command does NOT swap immediately. It drains-to-quiescence FIRST
    /// (the same model Save uses), so the OLD command resolves in the OLD host and
    /// no stray old-scene result folds into the loaded scene. The swap installs the
    /// loaded scene only AFTER quiescence. Observed via `node_count`: the old scene
    /// (one source) stays installed while draining; the loaded scene (two sources)
    /// appears only post-drain.
    #[test]
    fn load_drains_to_quiescence_before_swap() {
        let rt = test_rt();

        // A DISTINCT scene-to-load (two sources), saved quiescent.
        let save_dir = tempfile::tempdir().expect("save tempdir");
        let host_to_save = build_host(save_dir.path(), |c| {
            c.state.add_source();
            c.state.add_source();
        });
        assert_eq!(host_to_save.in_flight_len(), 0, "the scene-to-load is quiescent");
        let fab = save_dir.path().join("two-source.fab");
        save_project(&host_to_save, &fab).expect("save the scene-to-load");

        // Scene A (one source) with an OUTSTANDING in-flight executor command: a
        // finite deadline so it TIMES OUT (resolves in the OLD host) during the
        // drain, then quiescence permits the swap.
        let dir = tempfile::tempdir().expect("tempdir");
        let mut node = None;
        let mut host_a = build_host(dir.path(), |c| {
            node = Some(c.state.add_source());
        });
        host_a.test_insert_in_flight((0u64, node.expect("node"), 0u32), 4);
        let (_gtx, grx) = gesture_channel();
        let (ctx, crx) = unbounded_channel::<ControlMsg>();
        let mut sim = SimLoop::new(host_a, RenderProducer::new(), rt.handle(), test_cfg(), grx)
            .with_control(crx);
        assert!(
            sim.host().in_flight_len() > 0,
            "scene A has an outstanding executor command at Load time (non-quiescent)"
        );
        assert_eq!(sim.host().core().state.node_count(), 1, "scene A has one source");

        // Load while non-quiescent: the swap is DEFERRED (drain first), NOT immediate.
        ctx.send(ControlMsg::Load(fab.clone())).expect("send load");
        sim.step().expect("service load (defers the swap, re-enters draining)");
        assert_eq!(
            sim.run_state,
            RunState::Draining,
            "a non-quiescent Load re-enters the drain instead of swapping immediately"
        );
        assert_eq!(
            sim.host().core().state.node_count(),
            1,
            "the OLD scene is still installed while draining (swap deferred, WR-02)"
        );

        // Drive the bounded drain to quiescence; the OLD command times out in the
        // OLD host, THEN the swap installs the loaded (two-source) scene.
        let mut guard = 0;
        while sim.host().core().state.node_count() != 2 {
            sim.step().expect("drain-then-swap step");
            guard += 1;
            assert!(
                guard < (MAX_SETTLE_TICKS as usize) + 50,
                "the Load drained to quiescence then swapped within the budget"
            );
        }
        assert_eq!(
            sim.host().core().state.node_count(),
            2,
            "the loaded scene installs only AFTER the OLD scene reached quiescence"
        );
        assert_eq!(
            sim.host().in_flight_len(),
            0,
            "no OLD-scene effect is in flight in the loaded host (drained before swap)"
        );
        assert!(
            sim.pending_load.is_none(),
            "the latched Load was consumed at the swap"
        );
    }

    /// Count the logged `ManualInject` events carrying exactly `body` — the
    /// webhook-delivery oracle for the swap-path dedup tests (distinguishes
    /// webhook injections from demo-timer injections by payload).
    fn count_injects_with_body(sim: &SimLoop, body: &[u8]) -> usize {
        sim.host()
            .logged_events()
            .expect("read log")
            .iter()
            .filter(
                |e| matches!(&e.payload, EventPayload::ManualInject { item, .. } if item.0 == body),
            )
            .count()
    }

    /// Send two webhook deliveries carrying the SAME delivery id (a provider's
    /// at-least-once retry) into the sim's webhook seam. Bodies differ so a
    /// broken dedup would log TWO distinct events.
    fn send_duplicate_deliveries(
        web_tx: &Sender<Ingress>,
        target: NodeId,
        body: &[u8],
    ) {
        for _ in 0..2 {
            let (ack, _ack_rx) = oneshot::channel();
            web_tx
                .try_send(Ingress {
                    target,
                    delivery_id: Some(b"dup-across-swap".to_vec()),
                    body: body.to_vec(),
                    ack,
                })
                .expect("send webhook delivery");
        }
    }

    /// The first live Source on the current core (the loaded/swapped scene's
    /// webhook target).
    fn first_source(sim: &SimLoop) -> NodeId {
        sim.host()
            .core()
            .state
            .node_ids()
            .find(|&id| matches!(sim.host().core().state.node(id), Some(Node::Source(_))))
            .expect("the swapped scene has a Source")
    }

    /// 20-review CR-01 (HOST-06 on the shipped CTA path): the `LoadDemo` host
    /// swap installs a persisted seen-set, so a provider's at-least-once webhook
    /// retry arriving AFTER the swap is deduped to exactly ONE logged event.
    /// Before the fix the swapped host had NO seen-set (`record_delivery` hit its
    /// `None => Ok(true)` arm), so the duplicate double-fired the Source.
    #[test]
    fn load_demo_swap_installs_seen_set_dedups_webhook_retries() {
        let rt = test_rt();
        let dir = tempfile::tempdir().expect("tempdir");
        // A quiescent Playing genesis: LoadDemo swaps IMMEDIATELY in
        // service_control and the sim keeps Playing (webhook drain stays live).
        let host = build_host(dir.path(), |_| {});
        let (_gtx, grx) = gesture_channel();
        let (ctx, crx) = unbounded_channel::<ControlMsg>();
        let (web_tx, web_rx) = channel::<Ingress>(WEBHOOK_INGRESS_CAPACITY);
        let mut sim = SimLoop::new(host, RenderProducer::new(), rt.handle(), test_cfg(), grx)
            .with_control(crx)
            .with_webhook(web_rx);

        ctx.send(ControlMsg::LoadDemo).expect("send load-demo");
        sim.step().expect("service load-demo (immediate swap)");

        // The retry pair targets the DEMO scene's Source; the body distinguishes
        // these webhook injections from the demo timer's own injections.
        let body = b"cr01-demo-swap";
        send_duplicate_deliveries(&web_tx, first_source(&sim), body);
        sim.run(Some(4), Duration::ZERO).expect("post-swap ticks");

        assert_eq!(
            count_injects_with_body(&sim, body),
            1,
            "a duplicate delivery id after the LoadDemo swap is deduped to exactly \
             one logged event (the swap installed a seen-set — HOST-06)"
        );
    }

    /// 20-review CR-01, the `Load(path)` twin: `load_project` installs a fresh
    /// persisted seen-set inside the new work_dir, so webhook dedup survives a
    /// user-project host swap too.
    #[test]
    fn load_swap_installs_seen_set_dedups_webhook_retries() {
        let rt = test_rt();

        // A minimal quiescent user scene (one Source), saved to a .fab.
        let save_dir = tempfile::tempdir().expect("save tempdir");
        let host_to_save = build_host(save_dir.path(), |c| {
            c.state.add_source();
        });
        let fab = save_dir.path().join("user-scene.fab");
        save_project(&host_to_save, &fab).expect("save the user scene");

        // A fresh Playing sim; Load swaps immediately (quiescent genesis).
        let dir = tempfile::tempdir().expect("tempdir");
        let host = build_host(dir.path(), |_| {});
        let (_gtx, grx) = gesture_channel();
        let (ctx, crx) = unbounded_channel::<ControlMsg>();
        let (web_tx, web_rx) = channel::<Ingress>(WEBHOOK_INGRESS_CAPACITY);
        let mut sim = SimLoop::new(host, RenderProducer::new(), rt.handle(), test_cfg(), grx)
            .with_control(crx)
            .with_webhook(web_rx);

        ctx.send(ControlMsg::Load(fab)).expect("send load");
        sim.step().expect("service load (immediate swap)");

        let body = b"cr01-user-swap";
        send_duplicate_deliveries(&web_tx, first_source(&sim), body);
        sim.run(Some(4), Duration::ZERO).expect("post-swap ticks");

        assert_eq!(
            count_injects_with_body(&sim, body),
            1,
            "a duplicate delivery id after a user-project Load swap is deduped to \
             exactly one logged event (load_project installed a seen-set — HOST-06)"
        );
    }
    // ── ERR-01: the gesture drain answers the verdict ───────────────────────────
    //
    // Before Phase 64 the drain read `let _ = apply_gesture(..)`, so every typed
    // refusal the command layer produces died at that line and the user saw nothing
    // happen. These five lock the seam: an accept and a refusal both reach the
    // envelope's sink, a sink-less gesture is still fire-and-forget, a dead receiver
    // cannot abort the drain, and the undo tick boundary still yields one per pass.
    //
    // Phase 88 (plan 88-03, D-06): the reply oneshot became a `VerdictSink` on a channel,
    // and an ACCEPT is answered after the tick that folds it, naming the handles it minted.
    // So each test below that reads an accept runs `tick_body` first; a refusal is still
    // answered in the drain itself.

    /// A gesture's verdict sink and the channel its answer arrives on, as a transport holds
    /// them. `id` is the client's gesture id the answer names.
    fn test_sink(id: u64) -> (VerdictSink, VerdictRx) {
        let (tx, rx) = crate::gesture_verdict::verdict_channel();
        let subject = GestureSubject { cmd: "Test", node: None };
        (VerdictSink::new(id, subject, tx), rx)
    }

    /// The next answer on `rx` as the old reply shape: `Ok(())` for an accept, `Err(tag)` for
    /// a refusal, `None` when nothing has been answered yet. A discard panics: use
    /// `assert_answered_discarded`.
    fn outcome(rx: &mut VerdictRx) -> Option<Result<(), CommandErrorView>> {
        let frame = rx.try_recv().ok()?;
        match frame.kind() {
            k if k == crate::transport_ws::GESTURE_ACCEPT_KIND => Some(Ok(())),
            k if k == crate::transport_ws::GESTURE_REFUSAL_KIND => {
                Some(Err(frame.tag().expect("a refusal carries a tag")))
            }
            other => panic!("expected an accept or a refusal, got {other}: {frame:?}"),
        }
    }

    /// A one-Source genesis loop plus its gesture sender, for the drain tests.
    fn drain_rig(
        dir: &std::path::Path,
        rt: &tokio::runtime::Runtime,
    ) -> (SimLoop, GestureTx) {
        let host = build_host(dir, |c| {
            c.state.add_source();
        });
        let (gtx, grx) = gesture_channel();
        let sim = SimLoop::new(host, RenderProducer::new(), rt.handle(), test_cfg(), grx);
        (sim, gtx)
    }

    #[test]
    fn an_accepted_gesture_resolves_its_reply_to_the_accepted_arm() {
        let rt = test_rt();
        let dir = tempfile::tempdir().expect("tempdir");
        let (mut sim, gtx) = drain_rig(dir.path(), &rt);

        let (sink, mut verdict_rx) = test_sink(1);
        gtx.send(GestureEnvelope {
            cmd: GestureFrame::Cmd(GridCommand::Place {
                kind: machine_kind::SOURCE,
                cell_x: 3,
                cell_y: 3,
            }),
            generation: None,
            verdict: Some(sink),
        })
        .expect("enqueue the placement");

        sim.acquire_input().expect("drain the gesture");
        assert_eq!(outcome(&mut verdict_rx), None, "an accept waits for the tick that folds it");
        sim.tick_body().expect("fold it");

        assert_eq!(
            outcome(&mut verdict_rx).expect("answered after the tick"),
            Ok(()),
            "a placement the host accepts resolves to the accepted arm"
        );
    }

    #[test]
    fn a_refused_gesture_resolves_its_reply_to_the_exact_tag() {
        let rt = test_rt();
        let dir = tempfile::tempdir().expect("tempdir");
        let (mut sim, gtx) = drain_rig(dir.path(), &rt);

        // An Undo against a genesis board with an empty undo stack is a deterministic
        // typed refusal that needs no prior edit to set up.
        let (sink, mut verdict_rx) = test_sink(1);
        gtx.send(GestureEnvelope {
            cmd: GestureFrame::Cmd(GridCommand::Undo),
            generation: None,
            verdict: Some(sink),
        })
        .expect("enqueue the undo");

        sim.acquire_input().expect("drain the gesture");

        // ROADMAP criterion 2 at the drain: not merely "some error", THIS error. A refusal is
        // answered in the drain itself, before any tick.
        assert_eq!(
            outcome(&mut verdict_rx).expect("the drain answered"),
            Err(CommandErrorView::NothingToUndo),
            "the refusal carries the exact tag the command layer produced"
        );
    }

    #[test]
    fn a_reply_less_gesture_is_applied_and_raises_nothing() {
        let rt = test_rt();
        let dir = tempfile::tempdir().expect("tempdir");
        let (mut sim, gtx) = drain_rig(dir.path(), &rt);

        // ERR-02's empty case: `send_gesture` builds `verdict: None`, the drain answers
        // nothing for it, and that is not an error.
        let before = sim.host().core().state.node_count();
        gtx.send_gesture(GridCommand::Place {
            kind: machine_kind::SINK,
            cell_x: 5,
            cell_y: 5,
        })
        .expect("enqueue the placement");

        sim.acquire_input().expect("drain the gesture");
        sim.run(Some(1), Duration::ZERO).expect("fold the placement");

        assert_eq!(
            sim.host().core().state.node_count(),
            before + 1,
            "a fire-and-forget gesture is applied normally, with no reply attempted"
        );
    }

    #[test]
    fn a_dropped_reply_receiver_never_aborts_the_drain() {
        let rt = test_rt();
        let dir = tempfile::tempdir().expect("tempdir");
        let (mut sim, gtx) = drain_rig(dir.path(), &rt);

        // The webview reloaded / the socket closed between send and drain.
        let (dead_sink, dead_rx) = test_sink(1);
        drop(dead_rx);
        gtx.send(GestureEnvelope {
            cmd: GestureFrame::Cmd(GridCommand::Place {
                kind: machine_kind::SOURCE,
                cell_x: 2,
                cell_y: 2,
            }),
            generation: None,
            verdict: Some(dead_sink),
        })
        .expect("enqueue the orphaned gesture");

        let (live_sink, mut live_rx) = test_sink(2);
        gtx.send(GestureEnvelope {
            cmd: GestureFrame::Cmd(GridCommand::Place {
                kind: machine_kind::SINK,
                cell_x: 4,
                cell_y: 4,
            }),
            generation: None,
            verdict: Some(live_sink),
        })
        .expect("enqueue the following gesture");

        sim.acquire_input().expect("drain both gestures");
        sim.tick_body().expect("fold both, answering both accepts");

        assert_eq!(
            outcome(&mut live_rx).expect("the drain reached the second envelope"),
            Ok(()),
            "a dead receiver is discarded, and the drain continues to the next envelope"
        );
    }

    #[test]
    fn two_queued_undos_yield_one_verdict_per_drain_pass() {
        let rt = test_rt();
        let dir = tempfile::tempdir().expect("tempdir");
        let (mut sim, gtx) = drain_rig(dir.path(), &rt);

        let (first_sink, mut first_rx) = test_sink(1);
        gtx.send(GestureEnvelope {
            cmd: GestureFrame::Cmd(GridCommand::Undo),
            generation: None,
            verdict: Some(first_sink),
        })
        .expect("enqueue the first undo");
        let (second_sink, mut second_rx) = test_sink(2);
        gtx.send(GestureEnvelope {
            cmd: GestureFrame::Cmd(GridCommand::Undo),
            generation: None,
            verdict: Some(second_sink),
        })
        .expect("enqueue the second undo");

        sim.acquire_input().expect("drain one undo");

        // CR-01: an undo/redo forces a TICK BOUNDARY, so a queued burst yields exactly
        // one verdict per pass rather than N resolved against the same stale cursor.
        // Both undos are refusals here (nothing to undo), answered in the drain itself.
        assert!(
            outcome(&mut first_rx).is_some(),
            "the first undo is answered in this pass"
        );
        assert_eq!(
            outcome(&mut second_rx),
            None,
            "the second undo is still queued, not answered in the same pass"
        );

        sim.acquire_input().expect("drain the second undo");
        assert!(
            outcome(&mut second_rx).is_some(),
            "the next pass answers it"
        );
    }

    /// N3-RACE (plan 74.1-23): an Undo met AFTER another gesture in the same drain pass is
    /// held, not applied, and its reply is sent on the pass that applies it. Applied in the
    /// pass that met it, it would resolve against a projection that does not yet hold the
    /// placement queued before it, and undo the wrong action.
    #[test]
    fn an_undo_after_a_gesture_in_one_pass_is_held_and_answered_on_the_next() {
        let rt = test_rt();
        let dir = tempfile::tempdir().expect("tempdir");
        let (mut sim, gtx) = drain_rig(dir.path(), &rt);
        let before = sim.host().core().state.node_count();

        let (place_sink, mut place_rx) = test_sink(1);
        gtx.send(GestureEnvelope {
            cmd: GestureFrame::Cmd(GridCommand::Place {
                kind: machine_kind::SOURCE,
                cell_x: 3,
                cell_y: 3,
            }),
            generation: None,
            verdict: Some(place_sink),
        })
        .expect("enqueue the placement");
        let (undo_sink, mut undo_rx) = test_sink(2);
        gtx.send(GestureEnvelope {
            cmd: GestureFrame::Cmd(GridCommand::Undo),
            generation: None,
            verdict: Some(undo_sink),
        })
        .expect("enqueue the undo");

        sim.acquire_input().expect("first pass");
        assert_eq!(
            outcome(&mut undo_rx),
            None,
            "the undo met after the placement is held, its answer not yet sent"
        );

        sim.tick_body().expect("fold the placement");
        assert_eq!(outcome(&mut place_rx).expect("answered"), Ok(()), "placement applied");
        assert_eq!(sim.host().core().state.node_count(), before + 1, "placement folded");

        sim.acquire_input().expect("second pass");
        sim.tick_body().expect("fold the undo");
        assert_eq!(
            outcome(&mut undo_rx).expect("the held undo is answered"),
            Ok(()),
            "the held undo is applied first on the next pass"
        );
        assert_eq!(
            sim.host().core().state.node_count(),
            before,
            "the held undo undid the placement queued before it"
        );
    }

    /// The other half of the rule: an Undo FIRST in a pass is applied in that pass, exactly
    /// as before plan 74.1-23, and still ends the pass.
    #[test]
    fn an_undo_first_in_a_pass_is_applied_in_that_pass_and_ends_it() {
        let rt = test_rt();
        let dir = tempfile::tempdir().expect("tempdir");
        let (mut sim, gtx) = drain_rig(dir.path(), &rt);

        gtx.send_gesture(GridCommand::Place {
            kind: machine_kind::SOURCE,
            cell_x: 3,
            cell_y: 3,
        })
        .expect("enqueue the placement");
        sim.acquire_input().expect("drain the placement");
        sim.tick_body().expect("fold the placement");
        let placed = sim.host().core().state.node_count();

        let (undo_sink, mut undo_rx) = test_sink(1);
        gtx.send(GestureEnvelope {
            cmd: GestureFrame::Cmd(GridCommand::Undo),
            generation: None,
            verdict: Some(undo_sink),
        })
        .expect("enqueue the undo");
        let (after_sink, mut after_rx) = test_sink(2);
        gtx.send(GestureEnvelope {
            cmd: GestureFrame::Cmd(GridCommand::Place {
                kind: machine_kind::SINK,
                cell_x: 6,
                cell_y: 6,
            }),
            generation: None,
            verdict: Some(after_sink),
        })
        .expect("enqueue a placement behind the undo");

        sim.acquire_input().expect("one pass");
        sim.tick_body().expect("fold the undo");
        assert_eq!(outcome(&mut undo_rx).expect("answered"), Ok(()), "applied in this pass");
        assert_eq!(outcome(&mut after_rx), None, "the undo still ends the pass");
        assert_eq!(sim.host().core().state.node_count(), placed - 1, "the placement undone");
    }

    // REVIEW ROUND 4 WR-01 (plan 74.1-32): A HELD UNDO NEVER CROSSES A BOARD SWAP.
    //
    // Plan 74.1-23 holds an Undo met behind other records in a drain pass and applies it
    // first on the next pass. `step()` runs `service_control` BEFORE `acquire_input`, so an
    // Open, an example or New landing between the two passes installed the new board and the
    // next pass applied the old board's Undo to it: the loaded file lost its last action, and
    // the old board's gesture was told "Ok". Each case below holds an Undo, swaps, steps, and
    // asserts the swapped-in board is exactly as the swap left it and the held gesture is
    // answered `gestureDiscarded` (phase 88, D-05), never applied and never refused.

    /// A saved two-node user board CARRYING UNDO HISTORY, written by the host's own save
    /// path from two real Place gestures.
    fn saved_two_node_board(rt: &tokio::runtime::Runtime) -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().expect("save tempdir");
        let host = build_host(dir.path(), |_c| {});
        let (gtx, grx) = gesture_channel();
        let mut sim = SimLoop::new(host, RenderProducer::new(), rt.handle(), test_cfg(), grx);
        for (x, y) in [(3, 3), (6, 6)] {
            gtx.send_gesture(GridCommand::Place { kind: machine_kind::SOURCE, cell_x: x, cell_y: y })
                .expect("enqueue a placement");
        }
        sim.run(Some(2), Duration::ZERO).expect("fold both placements");
        assert_eq!(sim.host().core().state.node_count(), 2, "the board to save holds two nodes");
        assert!(sim.host().can_undo(), "and carries undo history");
        let fab = dir.path().join("two.fab");
        save_project(sim.host(), &fab).expect("save the two-node board");
        (dir, fab)
    }

    /// A one-Source loop with a control channel and a gesture sender.
    fn swap_rig(
        dir: &std::path::Path,
        rt: &tokio::runtime::Runtime,
    ) -> (SimLoop, GestureTx, UnboundedSender<ControlMsg>) {
        let host = build_host(dir, |c| {
            c.state.add_source();
        });
        let (gtx, grx) = gesture_channel();
        let (ctx, crx) = unbounded_channel::<ControlMsg>();
        let sim = SimLoop::new(host, RenderProducer::new(), rt.handle(), test_cfg(), grx)
            .with_control(crx);
        (sim, gtx, ctx)
    }

    /// A gesture's verdict channel, as a transport holds it.
    type VerdictRx = crate::gesture_verdict::VerdictRx;

    /// Enqueue a Place then an Undo, both carrying sinks, so ONE drain pass applies the
    /// Place and holds the Undo. Returns the Place's and the held Undo's verdict channels.
    fn enqueue_place_then_undo(gtx: &GestureTx) -> (VerdictRx, VerdictRx) {
        let (place_sink, place_rx) = test_sink(1);
        gtx.send(GestureEnvelope {
            cmd: GestureFrame::Cmd(GridCommand::Place { kind: machine_kind::SINK, cell_x: 9, cell_y: 9 }),
            generation: None,
            verdict: Some(place_sink),
        })
        .expect("enqueue the placement");
        let (undo_sink, undo_rx) = test_sink(2);
        gtx.send(GestureEnvelope { cmd: GestureFrame::Cmd(GridCommand::Undo), generation: None, verdict: Some(undo_sink) })
            .expect("enqueue the undo");
        (place_rx, undo_rx)
    }

    /// MOVED BY PLAN 88-03 (D-05, D-06). This was `assert_dropped_unanswered`: the swap dropped
    /// the envelope with its reply sender and the transport stayed silent. Now the swap ANSWERS
    /// it `gestureDiscarded`, exactly once, and never accepts or refuses it.
    fn assert_answered_discarded(rx: &mut VerdictRx, swap: &str) {
        let got = rx.try_recv().unwrap_or_else(|e| {
            panic!("{swap}: the dropped gesture (a held Undo or a gesture queued on the replaced board) is answered, got {e:?}")
        });
        assert_eq!(
            got.kind(),
            crate::transport_ws::GESTURE_DISCARD_KIND,
            "{swap}: it is answered discarded, never applied or refused: {got:?}"
        );
        assert!(rx.try_recv().is_err(), "{swap}: and answered exactly once");
    }

    /// WR-01, Load while playing: Place and Undo in one pass (the Undo held), then an Open
    /// of a saved two-node board carrying undo history, then a step.
    #[test]
    fn a_held_undo_is_dropped_by_a_load_and_never_reaches_the_loaded_board() {
        let rt = test_rt();
        let (_save_dir, fab) = saved_two_node_board(&rt);
        let dir = tempfile::tempdir().expect("tempdir");
        let (mut sim, gtx, ctx) = swap_rig(dir.path(), &rt);

        let (mut place_rx, mut undo_rx) = enqueue_place_then_undo(&gtx);
        sim.step().expect("one live pass: the Place applies and folds, the Undo is held");
        assert_eq!(outcome(&mut place_rx).expect("answered"), Ok(()), "the Place applied");
        assert!(sim.held_undo_redo.is_some(), "the Undo is held for the next pass");

        ctx.send(ControlMsg::Load(fab)).expect("send load");
        sim.step().expect("the swap, then a live pass on the loaded board");

        assert_eq!(sim.host().core().state.node_count(), 2, "the loaded board keeps both nodes");
        assert!(sim.host().can_undo(), "and its undo history, as saved");
        assert!(!sim.host().can_redo(), "nothing was undone on it");
        assert!(sim.held_undo_redo.is_none(), "the hold is gone");
        assert_answered_discarded(&mut undo_rx, "Load");
    }

    /// WR-01, an example load: the same hold, then LoadScene(Demo). The demo board must be
    /// exactly the one a load with nothing held gives (counts read off that board, never typed).
    #[test]
    fn a_held_undo_is_dropped_by_a_scene_load_and_the_demo_keeps_its_last_command() {
        let rt = test_rt();
        // The control: the demo loaded with nothing held, one step, measured.
        let control_dir = tempfile::tempdir().expect("tempdir");
        let (mut control, _cgtx, cctx) = swap_rig(control_dir.path(), &rt);
        cctx.send(ControlMsg::LoadScene(SceneId::Demo)).expect("send load-scene");
        control.step().expect("load the demo with nothing held");
        let demo_nodes = control.host().core().state.node_count();
        let demo_edits = control.host().logged_edits().expect("read the edit log").len();
        assert!(demo_nodes > 1, "MEASURED: the demo holds a real board ({demo_nodes} nodes)");
        // Plan 85-06 (D-10, DEMO-05): a freshly loaded scene has nothing to undo. Until
        // 85-06 this line MEASURED the demo's availability (it was true: every scene command
        // was an undo step) and the swapped board was compared to that measurement.
        assert!(!control.host().can_undo(), "the freshly loaded demo has nothing to undo (the history seal)");

        let dir = tempfile::tempdir().expect("tempdir");
        let (mut sim, gtx, ctx) = swap_rig(dir.path(), &rt);
        let (_place_rx, mut undo_rx) = enqueue_place_then_undo(&gtx);
        sim.step().expect("one live pass: the Undo is held");
        assert!(sim.held_undo_redo.is_some(), "the Undo is held for the next pass");

        ctx.send(ControlMsg::LoadScene(SceneId::Demo)).expect("send load-scene");
        sim.step().expect("the swap, then a live pass on the demo");

        assert_eq!(sim.host().core().state.node_count(), demo_nodes, "the demo's node count unchanged");
        assert_eq!(
            sim.host().logged_edits().expect("read the edit log").len(),
            demo_edits,
            "no Undo was logged on the demo"
        );
        assert!(!sim.host().can_undo(), "the demo still has nothing to undo: the held Undo never reached it");
        assert!(!sim.host().can_redo(), "nothing was undone on the demo");
        assert_answered_discarded(&mut undo_rx, "LoadScene(Demo)");
    }

    /// DEMO-05 / D-10 (plan 85-06): EVERY shipped scene arrives with Undo greyed. For each
    /// `SceneId`, a `LoadScene` swap installs a board whose history is sealed: `can_undo` is
    /// false, the floor is above zero (the scene's commands sit under it), an Undo sent on
    /// the loaded board is answered `NothingToUndo`, and it logs nothing and removes nothing.
    #[test]
    fn every_scene_load_arrives_with_nothing_to_undo() {
        let rt = test_rt();
        for scene in [SceneId::Demo, SceneId::OrderProcessing, SceneId::Advanced] {
            let dir = tempfile::tempdir().expect("tempdir");
            let (mut sim, gtx, ctx) = swap_rig(dir.path(), &rt);
            ctx.send(ControlMsg::LoadScene(scene)).expect("send load-scene");
            sim.step().expect("the swap");
            let nodes = sim.host().core().state.node_count();
            let edits = sim.host().logged_edits().expect("read the edit log").len();
            assert!(nodes > 1, "{scene:?}: MEASURED, the scene holds a real board ({nodes} nodes)");
            assert!(sim.host().session().undo_floor() > 0, "{scene:?}: the scene's commands sit under the floor");
            assert!(!sim.host().can_undo(), "{scene:?}: Undo is greyed right after the load");

            let (undo_sink, mut undo_rx) = test_sink(1);
            gtx.send(GestureEnvelope { cmd: GestureFrame::Cmd(GridCommand::Undo), generation: None, verdict: Some(undo_sink) })
                .expect("enqueue an undo on the loaded scene");
            sim.step().expect("a live pass on the loaded scene");
            assert_eq!(
                outcome(&mut undo_rx).expect("the undo is answered"),
                Err(CommandErrorView::NothingToUndo),
                "{scene:?}: an Undo on the freshly loaded scene is refused"
            );
            assert_eq!(sim.host().core().state.node_count(), nodes, "{scene:?}: the refused Undo removed nothing");
            assert_eq!(
                sim.host().logged_edits().expect("read the edit log").len(),
                edits,
                "{scene:?}: and logged nothing"
            );
        }
    }

    /// WR-01, New: the same hold, then New. The board is empty with nothing to undo, and the
    /// held reply is dropped rather than answered `NothingToUndo` ("Nothing left to undo."
    /// is a sentence about a board the Undo was never pressed on).
    #[test]
    fn a_held_undo_is_dropped_by_new_and_never_answered() {
        let rt = test_rt();
        let dir = tempfile::tempdir().expect("tempdir");
        let (mut sim, gtx, ctx) = swap_rig(dir.path(), &rt);
        let (_place_rx, mut undo_rx) = enqueue_place_then_undo(&gtx);
        sim.step().expect("one live pass: the Undo is held");
        assert!(sim.held_undo_redo.is_some(), "the Undo is held for the next pass");

        ctx.send(ControlMsg::New).expect("send new");
        sim.step().expect("the swap, then a live pass on the empty board");

        assert_eq!(sim.host().core().state.node_count(), 0, "New is empty");
        assert!(!sim.host().can_undo(), "with nothing to undo");
        assert!(sim.held_undo_redo.is_none(), "the hold is gone");
        assert_answered_discarded(&mut undo_rx, "New");
    }

    /// WR-01, the race-free paused path: Pause, Place and Undo, Step (it drains: the Place
    /// applies, the Undo is held), Open, then Step again.
    #[test]
    fn a_held_undo_from_a_paused_step_is_dropped_by_a_load() {
        let rt = test_rt();
        let (_save_dir, fab) = saved_two_node_board(&rt);
        let dir = tempfile::tempdir().expect("tempdir");
        let (mut sim, gtx, ctx) = swap_rig(dir.path(), &rt);

        ctx.send(ControlMsg::Pause).expect("pause");
        sim.step().expect("freeze");
        assert!(sim.is_paused(), "paused before the edits");

        let (_place_rx, mut undo_rx) = enqueue_place_then_undo(&gtx);
        ctx.send(ControlMsg::Step).expect("step");
        sim.step().expect("Step drains: the Place applies, the Undo is held");
        assert!(sim.held_undo_redo.is_some(), "the Undo is held for the next pass");

        ctx.send(ControlMsg::Load(fab)).expect("send load");
        sim.step().expect("the swap, still paused");
        assert!(sim.is_paused(), "a load over a user pause stays paused");
        assert_eq!(sim.host().core().state.node_count(), 2, "the loaded board as saved");

        ctx.send(ControlMsg::Step).expect("step");
        sim.step().expect("a Step on the loaded board");
        assert_eq!(sim.host().core().state.node_count(), 2, "the Step left the loaded board as saved");
        assert!(sim.host().can_undo(), "with its undo history");
        assert!(!sim.host().can_redo(), "nothing was undone on it");
        assert_answered_discarded(&mut undo_rx, "paused Load");
    }

    // REVIEW ROUND 5 CR-01 (plan 74.1-35): A BOARD SWAP DISCARDS EVERY EDIT QUEUED ON THE
    // BOARD IT REPLACES.
    //
    // While the sim is Frozen `step()` never calls `acquire_input`, so every Place, DrawBelt,
    // Delete or Dock sent on a paused board waits in `gesture_rx`. Before this plan a swap
    // left them there and the first Play folded them into the NEW board: a queued Delete
    // removed a node of the opened file and the transport was told "Ok". Each case below
    // queues an edit on a paused board, swaps, plays, and asserts the swapped-in board is
    // exactly as the swap left it and the queued reply is dropped unanswered. Two controls
    // prove the drain is not too wide: a REFUSED Load reaches no swap and drains nothing, and
    // a gesture sent AFTER the swap lands on the new board.

    /// A gesture with a verdict sink attached, as either transport sends it.
    fn send_with_reply(gtx: &GestureTx, cmd: GridCommand) -> VerdictRx {
        let (sink, rx) = test_sink(1);
        gtx.send(GestureEnvelope { cmd: GestureFrame::Cmd(cmd), generation: None, verdict: Some(sink) })
            .expect("enqueue the gesture");
        rx
    }

    /// Pause the swap rig and step until it is Frozen (the rig's board is quiescent).
    fn pause_to_frozen(sim: &mut SimLoop, ctx: &UnboundedSender<ControlMsg>, steps: usize) {
        ctx.send(ControlMsg::Pause).expect("pause");
        for _ in 0..steps {
            sim.step().expect("paused step");
        }
        assert!(sim.is_paused(), "paused before the edit");
        assert_eq!(sim.run_state, RunState::Frozen, "and Frozen, so no pass drains a gesture");
    }

    /// Resume and take `steps` live passes.
    fn resume_and_step(sim: &mut SimLoop, ctx: &UnboundedSender<ControlMsg>, steps: usize) {
        ctx.send(ControlMsg::Resume).expect("resume");
        for _ in 0..steps {
            sim.step().expect("live step after Play");
        }
    }

    /// The number of belts on the board (a belt is a node).
    fn belt_count(sim: &SimLoop) -> usize {
        let state = &sim.host().core().state;
        state
            .node_ids()
            .filter(|id| matches!(state.node(*id), Some(fabrico_core::state::Node::Belt(_))))
            .count()
    }

    /// A free run far from every shipped scene's machines, so the draw is accepted on the
    /// demo board if it ever reaches it (the test is red for the right reason).
    fn far_draw() -> GridCommand {
        GridCommand::DrawBelt { cells: vec![(200, 200), (201, 200), (202, 200)] }
    }

    /// CR-01, New: a Place queued on a paused board never reaches the empty board.
    #[test]
    fn a_paused_place_queued_before_new_never_reaches_the_new_board() {
        let rt = test_rt();
        let dir = tempfile::tempdir().expect("tempdir");
        let (mut sim, gtx, ctx) = swap_rig(dir.path(), &rt);
        pause_to_frozen(&mut sim, &ctx, 1);

        let mut place_rx = send_with_reply(
            &gtx,
            GridCommand::Place { kind: machine_kind::SINK, cell_x: 9, cell_y: 9 },
        );
        ctx.send(ControlMsg::New).expect("send new");
        sim.step().expect("the swap, still paused");
        assert!(sim.is_paused(), "New over a user pause stays paused");

        resume_and_step(&mut sim, &ctx, 2);
        assert_eq!(
            sim.host().core().state.node_count(),
            0,
            "the new board stays empty after Play: the old board's Place never reached it"
        );
        assert_answered_discarded(&mut place_rx, "New");
    }

    /// CR-01, the review's own reproduction: Pause, six steps, Place SINK (12,12), step, Load
    /// of a saved two-node file, step, Resume, two steps.
    #[test]
    fn a_paused_place_queued_before_a_load_never_reaches_the_loaded_board() {
        let rt = test_rt();
        let (_save_dir, fab) = saved_two_node_board(&rt);
        let dir = tempfile::tempdir().expect("tempdir");
        let (mut sim, gtx, ctx) = swap_rig(dir.path(), &rt);
        pause_to_frozen(&mut sim, &ctx, 6);

        let mut place_rx = send_with_reply(
            &gtx,
            GridCommand::Place { kind: machine_kind::SINK, cell_x: 12, cell_y: 12 },
        );
        sim.step().expect("a frozen step");
        ctx.send(ControlMsg::Load(fab)).expect("send load");
        sim.step().expect("the swap, still paused");
        assert_eq!(sim.host().core().state.node_count(), 2, "the loaded board as saved");

        resume_and_step(&mut sim, &ctx, 2);
        assert_eq!(
            sim.host().core().state.node_count(),
            2,
            "Play leaves the loaded board as saved: the old board's Place never reached it"
        );
        assert_answered_discarded(&mut place_rx, "Load");
    }

    /// CR-01, the harmful case: a Delete queued on a paused board would remove a node of the
    /// opened file. The loaded board must equal one loaded with nothing queued.
    #[test]
    fn a_paused_delete_queued_before_a_load_leaves_the_loaded_file_whole() {
        let rt = test_rt();
        let (_save_dir, fab) = saved_two_node_board(&rt);

        // The control: the same steps with nothing queued, measured.
        let control_dir = tempfile::tempdir().expect("tempdir");
        let (mut control, _cgtx, cctx) = swap_rig(control_dir.path(), &rt);
        pause_to_frozen(&mut control, &cctx, 6);
        control.step().expect("a frozen step");
        cctx.send(ControlMsg::Load(fab.clone())).expect("send load");
        control.step().expect("the swap");
        resume_and_step(&mut control, &cctx, 2);
        let want_nodes = control.host().core().state.node_count();
        let want_edits = control.host().logged_edits().expect("read the edit log").len();
        assert_eq!(want_nodes, 2, "MEASURED: the file loads with its two nodes");

        let dir = tempfile::tempdir().expect("tempdir");
        let (mut sim, gtx, ctx) = swap_rig(dir.path(), &rt);
        pause_to_frozen(&mut sim, &ctx, 6);
        let mut delete_rx = send_with_reply(&gtx, GridCommand::Delete { node: 0 });
        sim.step().expect("a frozen step");
        ctx.send(ControlMsg::Load(fab)).expect("send load");
        sim.step().expect("the swap, still paused");
        resume_and_step(&mut sim, &ctx, 2);

        assert_eq!(
            sim.host().core().state.node_count(),
            want_nodes,
            "the opened file keeps every node: the old board's Delete never reached it"
        );
        assert_eq!(
            sim.host().logged_edits().expect("read the edit log").len(),
            want_edits,
            "no edit was logged on the opened file"
        );
        assert_answered_discarded(&mut delete_rx, "Load");
    }

    /// CR-01, an example load: a DrawBelt queued on a paused board, then LoadScene(Demo). The
    /// demo must equal one loaded with nothing queued (counts read off that loop, never typed).
    #[test]
    fn a_paused_draw_queued_before_a_scene_load_leaves_the_demo_as_loaded() {
        let rt = test_rt();
        let control_dir = tempfile::tempdir().expect("tempdir");
        let (mut control, _cgtx, cctx) = swap_rig(control_dir.path(), &rt);
        pause_to_frozen(&mut control, &cctx, 1);
        cctx.send(ControlMsg::LoadScene(SceneId::Demo)).expect("send load-scene");
        control.step().expect("the swap");
        resume_and_step(&mut control, &cctx, 2);
        let want_nodes = control.host().core().state.node_count();
        let want_belts = belt_count(&control);
        let want_edits = control.host().logged_edits().expect("read the edit log").len();
        assert!(want_belts > 0, "MEASURED: the demo carries belts ({want_belts})");

        let dir = tempfile::tempdir().expect("tempdir");
        let (mut sim, gtx, ctx) = swap_rig(dir.path(), &rt);
        pause_to_frozen(&mut sim, &ctx, 1);
        let mut draw_rx = send_with_reply(&gtx, far_draw());
        ctx.send(ControlMsg::LoadScene(SceneId::Demo)).expect("send load-scene");
        sim.step().expect("the swap, still paused");
        resume_and_step(&mut sim, &ctx, 2);

        assert_eq!(sim.host().core().state.node_count(), want_nodes, "the demo's node count");
        assert_eq!(belt_count(&sim), want_belts, "the demo's belt count: no belt from the old board");
        assert_eq!(
            sim.host().logged_edits().expect("read the edit log").len(),
            want_edits,
            "no edit was logged on the demo"
        );
        assert_answered_discarded(&mut draw_rx, "LoadScene(Demo)");
    }

    /// The latched rig of `pause_joined_by_latched_load_demo_stays_frozen_after_swap`: a
    /// one-Source board with a finite in-flight effect, so a Pause enters Draining.
    fn latched_rig(
        dir: &std::path::Path,
        rt: &tokio::runtime::Runtime,
    ) -> (SimLoop, GestureTx, UnboundedSender<ControlMsg>) {
        let mut node = None;
        let mut host = build_host(dir, |c| {
            node = Some(c.state.add_source());
        });
        host.test_insert_in_flight((0u64, node.expect("node"), 0u32), 3);
        let (gtx, grx) = gesture_channel();
        let (ctx, crx) = unbounded_channel::<ControlMsg>();
        let sim = SimLoop::new(host, RenderProducer::new(), rt.handle(), test_cfg(), grx)
            .with_control(crx);
        (sim, gtx, ctx)
    }

    /// Pause the latched rig (it drains), optionally queue a gesture during the drain, latch
    /// LoadScene(Demo), step until the swap, then Resume and step. Returns the reply, if any.
    fn latched_swap_then_play(
        sim: &mut SimLoop,
        gtx: &GestureTx,
        ctx: &UnboundedSender<ControlMsg>,
        queued: Option<GridCommand>,
    ) -> Option<VerdictRx> {
        ctx.send(ControlMsg::Pause).expect("send pause");
        sim.step().expect("service pause (enters the drain)");
        assert_eq!(sim.run_state, RunState::Draining, "the Pause entered the drain");
        let rx = queued.map(|cmd| send_with_reply(gtx, cmd));
        ctx.send(ControlMsg::LoadScene(SceneId::Demo)).expect("send load-scene");
        sim.step().expect("service load-scene (latches behind the drain)");
        let mut guard = 0;
        while sim.host().core().state.node_count() < 2 {
            sim.step().expect("drain/swap step");
            guard += 1;
            assert!(guard < (MAX_SETTLE_TICKS as usize) + 50, "the latched swap fired");
        }
        assert_eq!(sim.run_state, RunState::Frozen, "the user's Pause holds after the swap");
        resume_and_step(sim, ctx, 2);
        rx
    }

    /// CR-01, the drain variant: a DrawBelt queued while the Pause still drains, an example
    /// latched behind the drain; the swap fires at the freeze and must discard the draw.
    #[test]
    fn a_draw_queued_during_a_latched_swap_drain_is_discarded_at_the_swap() {
        let rt = test_rt();
        let control_dir = tempfile::tempdir().expect("tempdir");
        let (mut control, cgtx, cctx) = latched_rig(control_dir.path(), &rt);
        let _ = latched_swap_then_play(&mut control, &cgtx, &cctx, None);
        let want_nodes = control.host().core().state.node_count();
        let want_belts = belt_count(&control);
        let want_edits = control.host().logged_edits().expect("read the edit log").len();

        let dir = tempfile::tempdir().expect("tempdir");
        let (mut sim, gtx, ctx) = latched_rig(dir.path(), &rt);
        let mut draw_rx =
            latched_swap_then_play(&mut sim, &gtx, &ctx, Some(far_draw())).expect("a reply");

        assert_eq!(sim.host().core().state.node_count(), want_nodes, "the demo's node count");
        assert_eq!(belt_count(&sim), want_belts, "the demo's belt count: the drained draw is gone");
        assert_eq!(
            sim.host().logged_edits().expect("read the edit log").len(),
            want_edits,
            "no edit was logged on the demo"
        );
        assert_answered_discarded(&mut draw_rx, "latched LoadScene(Demo)");
    }

    /// CONTROL: a REFUSED Load reaches no swap, so it drains nothing. The Place queued on the
    /// paused board folds onto that same board on Play and is answered `Ok`.
    #[test]
    // Test-only IO: the refused file is written into the test's own temp dir, as
    // `project.rs`'s test module allows it (the host is the I/O home).
    #[allow(clippy::disallowed_methods)]
    fn a_refused_load_keeps_the_edit_queued_for_the_board_it_was_made_on() {
        let rt = test_rt();
        let dir = tempfile::tempdir().expect("tempdir");
        let bad = dir.path().join("not-a-board.fab");
        std::fs::write(&bad, b"this is not a fabrico project file").expect("write garbage");
        let (mut sim, gtx, ctx) = swap_rig(dir.path(), &rt);
        pause_to_frozen(&mut sim, &ctx, 1);
        let nodes_before = sim.host().core().state.node_count();

        let mut place_rx = send_with_reply(
            &gtx,
            GridCommand::Place { kind: machine_kind::SINK, cell_x: 9, cell_y: 9 },
        );
        ctx.send(ControlMsg::Load(bad)).expect("send load");
        sim.step().expect("the refused load, still paused");
        assert!(sim.is_paused(), "a refused load keeps the board paused");

        resume_and_step(&mut sim, &ctx, 2);
        assert_eq!(
            outcome(&mut place_rx).expect("the Place is answered: the refused load drained nothing"),
            Ok(()),
            "the Place is answered accepted"
        );
        assert_eq!(
            sim.host().core().state.node_count(),
            nodes_before + 1,
            "the Place folded on the board it was made on"
        );
    }

    /// CONTROL: a gesture sent AFTER the swap is not the old board's and lands on the new one.
    #[test]
    fn a_gesture_queued_after_the_swap_applies_to_the_new_board() {
        let rt = test_rt();
        let dir = tempfile::tempdir().expect("tempdir");
        let (mut sim, gtx, ctx) = swap_rig(dir.path(), &rt);
        pause_to_frozen(&mut sim, &ctx, 1);

        let mut place_a = send_with_reply(
            &gtx,
            GridCommand::Place { kind: machine_kind::SINK, cell_x: 9, cell_y: 9 },
        );
        ctx.send(ControlMsg::New).expect("send new");
        sim.step().expect("the swap, still paused");
        let mut place_b = send_with_reply(
            &gtx,
            GridCommand::Place { kind: machine_kind::SINK, cell_x: 20, cell_y: 20 },
        );
        resume_and_step(&mut sim, &ctx, 2);

        assert_eq!(
            outcome(&mut place_b).expect("Place B, sent after the swap, is answered"),
            Ok(()),
            "Place B is answered accepted"
        );
        assert_eq!(
            sim.host().core().state.node_count(),
            1,
            "exactly one node on the new board: B landed and A did not"
        );
        assert_answered_discarded(&mut place_a, "New");
    }

    /// Phase 88 review IN-04: a tick that fails after the drain must not leave its accepts to
    /// the next tick. Place A is drained and folded, then the producer step fails (injected,
    /// as an encode failure would), so `tick_body` returns before it answers A. Place B is
    /// drained and folded on the next tick. B's accept names B's handle, and A is never
    /// answered with another gesture's handle: its sink is dropped, which is silence, and the
    /// client's own fallback ends it.
    ///
    /// RED BEFORE THE FIX: A's pending accept kept the failed tick's slice (`first` 0, `count`
    /// 1) and was answered on the next tick from that tick's `placed` list, naming B's handle.
    #[test]
    fn a_failed_tick_never_answers_its_accepts_from_the_next_tick() {
        let rt = test_rt();
        let dir = tempfile::tempdir().expect("tempdir");
        let (gtx, grx) = gesture_channel();
        let mut sim = SimLoop::new(build_host(dir.path(), |_| {}), RenderProducer::new(), rt.handle(), test_cfg(), grx);
        let (_keyframe, mut diff) = sim.subscribe();

        let mut place_a =
            send_with_reply(&gtx, GridCommand::Place { kind: machine_kind::SOURCE, cell_x: 4, cell_y: 4 });
        sim.fail_next_producer_step = true;
        assert!(sim.step().is_err(), "PRECONDITION: the injected producer failure ends the tick");
        let mut place_b =
            send_with_reply(&gtx, GridCommand::Place { kind: machine_kind::SOURCE, cell_x: 10, cell_y: 4 });
        sim.step().expect("the next tick");

        let mut cells = std::collections::BTreeMap::new();
        while let Ok(frame) = diff.try_recv() {
            let p: fabrico_protocol::RenderPacket = postcard::from_bytes(&frame.bytes).expect("a render packet");
            if p.full {
                cells.clear();
            }
            for h in &p.removed {
                cells.remove(h);
            }
            for n in p.placed {
                cells.insert(n.id, (n.cell_x, n.cell_y));
            }
        }
        let b = cells
            .iter()
            .find(|(_, at)| **at == (10, 4))
            .map(|(h, _)| *h)
            .unwrap_or_else(|| panic!("PRECONDITION: B is drawn at (10,4): {cells:?}"));
        let a_frames: Vec<_> = std::iter::from_fn(|| place_a.try_recv().ok()).collect();
        let b_frames: Vec<_> = std::iter::from_fn(|| place_b.try_recv().ok()).collect();
        eprintln!("IN-04 b=h{b} a={a_frames:?} b_frames={b_frames:?}");
        assert!(
            a_frames.iter().all(|f| f.minted() != Some(&[b][..])),
            "A is never answered with B's handle: {a_frames:?}"
        );
        assert!(a_frames.is_empty(), "A's accept went with its failed tick: silence, never a guess");
        assert_eq!(b_frames.len(), 1, "B is answered once");
        assert_eq!(b_frames[0].minted(), Some(&[b][..]), "naming B's own handle");
    }
}

#[cfg(test)]
mod endpoint {
    //! ENDP-05: `project_routes` + the recompute fingerprint project BOTH
    //! `Node::Source` (`src-`) and `Node::Endpoint` (its own `/`-led path) into the ONE
    //! live route map, so a placed/deleted/loaded Endpoint auto-(re)registers its route with
    //! ZERO bespoke hook (the fingerprint change drives `maybe_republish_routes`).
    mod route {
        use super::super::*;
        use fabrico_core::state::SinkTemplate;

        fn genesis() -> Core {
            Core::genesis(LogHeader {
                schema_version: SCHEMA_VERSION,
                seed: 1,
            })
        }

        /// The route-map key the Route `id` answers at: its COMMITTED path, read off
        /// the core state, through `endpoint_route_key`.
        ///
        /// Read rather than spelled, so no test here restates the core's default a
        /// second time (phase 91, D-13). It carries the leading slash from 72-07 on:
        /// `endpoint_route_key` normalizes every endpoint key to exactly one `/`, which
        /// is what keeps the endpoint and source namespaces disjoint STRUCTURALLY now
        /// that a user chooses the path.
        fn ep_key(core: &Core, id: NodeId) -> String {
            match core.state.node(id) {
                Some(Node::Endpoint(ep)) => endpoint_route_key(&ep.path),
                other => panic!("expected a live Node::Endpoint at {id:?}, found {other:?}"),
            }
        }
        fn src_label(id: NodeId) -> String {
            format!("src-{}", id.data().as_ffi())
        }

        #[test]
        fn project_routes_projects_an_endpoint_at_its_own_path() {
            // A placed Endpoint projects the key its own committed path makes,
            // resolving to its node: the src- analog over the SAME projection.
            let mut core = genesis();
            let ep = core.state.add_endpoint();
            let routes = project_routes(&core, &TimerSet::default());
            assert_eq!(
                routes.get(&ep_key(&core, ep)),
                Some(&ep),
                "a placed Endpoint is routable at the key its own path makes"
            );
        }

        /// The host half of `fabrico-core`'s `a_placed_route_answers_at_a_readable_url`
        /// (phase 91, CHROME-13, D-13): a Route placed on a fresh host is routable at
        /// `/route-1` through the LIVE projection, so it answers at
        /// `POST /endpoint/route-1` with no host change.
        ///
        /// The one test in this module that spells the default, on purpose: it is the
        /// claim. RED AT THE START REVISION BECAUSE: the default was id-derived, so the
        /// live table held `/ep-<as_ffi>` and no `/route-1`.
        #[test]
        fn a_placed_route_answers_at_a_readable_url() {
            let rt = tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
                .expect("build runtime");
            let dir = tempfile::tempdir().expect("tempdir");
            let mut core = genesis();
            let ep = core.state.add_endpoint();
            assert_eq!(
                ep_key(&core, ep),
                "/route-1",
                "the core's committed path for the first Route keys as /route-1"
            );
            let store = RedbStore::open(dir.path().join("log.redb")).expect("open log");
            let ledger = DispatchLedger::open(dir.path().join("ledger.redb")).expect("open ledger");
            let host = Host::new(core, store, ledger, None).expect("open host");
            let (_gtx, grx) = gesture_channel();
            let cfg = HostConfig {
                webhook_addr: "127.0.0.1:0".parse().expect("loopback addr"),
            };
            let sim = SimLoop::new(host, RenderProducer::new(), rt.handle(), cfg, grx);
            let routes = sim.routes_receiver().borrow().clone();
            assert_eq!(
                routes.get("/route-1"),
                Some(&ep),
                "the first Route on a fresh host answers at POST /endpoint/route-1"
            );
            assert_eq!(routes.len(), 1, "one Route, one key: no id-derived second address");
        }

        #[test]
        fn a_user_typed_path_keys_the_route_and_replaces_the_default() {
            // SERVE-08: the key is the Route's OWN path, not its id. Both directions,
            // because a projection that ADDED the new key without dropping the default
            // would leave one Route with two live addresses.
            let mut core = genesis();
            let ep = core.state.add_endpoint();
            let default_key = ep_key(&core, ep);
            match core.state.node_mut(ep) {
                Some(Node::Endpoint(e)) => e.path = "/orders".to_owned(),
                other => panic!("expected a live endpoint, found {other:?}"),
            }
            let routes = project_routes(&core, &TimerSet::default());
            assert_eq!(routes.get("/orders"), Some(&ep), "the typed path is the key");
            assert!(
                !routes.contains_key(&default_key),
                "a Route has ONE address: the default key is gone once a path is set"
            );
        }

        #[test]
        fn a_forged_slashless_path_cannot_mint_a_key_in_the_source_namespace() {
            // THE CROSS-DOOR PROPERTY, ASSERTED RATHER THAN ARGUED (T-72-07-02).
            //
            // `fold_configure` applies records VERBATIM and never re-validates, so a
            // hand-edited `.fab` can give a Route a slashless path naming a real
            // Source's label. If `project_routes` stripped the leading slash (as an
            // earlier draft did) that Route would collide with the Source in the ONE
            // shared map, where `collect` silently keeps whichever came later, and a
            // `POST /hook/src-N` would resolve an ENDPOINT.
            //
            // The normalization is what stops it, so this forges exactly that path.
            let mut core = genesis();
            let src = core.state.add_source();
            let ep = core.state.add_endpoint();
            let stolen = src_label(src);
            match core.state.node_mut(ep) {
                Some(Node::Endpoint(e)) => e.path = stolen.clone(),
                other => panic!("expected a live endpoint, found {other:?}"),
            }
            let routes = project_routes(&core, &TimerSet::default());
            assert_eq!(
                routes.get(&stolen),
                Some(&src),
                "the Source still owns its own hook label; the forged Route did not                  take it over"
            );
            assert_eq!(
                routes.get(&format!("/{stolen}")),
                Some(&ep),
                "the forged Route keys in the ENDPOINT namespace, under a slash"
            );
            assert_eq!(routes.len(), 2, "two nodes, two distinct keys, no collapse");
        }

        #[test]
        fn src_and_ep_coexist_with_disjoint_prefixes() {
            // A Source AND an Endpoint fold into the ONE map with DISJOINT prefixes —
            // the two namespaces never collide (Pitfall 4).
            let mut core = genesis();
            let src = core.state.add_source();
            let ep = core.state.add_endpoint();
            let routes = project_routes(&core, &TimerSet::default());
            assert_eq!(routes.len(), 2, "both a Source and an Endpoint project");
            assert_eq!(routes.get(&src_label(src)), Some(&src), "src- label resolves");
            assert_eq!(routes.get(&ep_key(&core, ep)), Some(&ep), "the Route's key resolves");
            // THE DISJOINTNESS RULE, RESTATED FOR 72-07. It used to be a test on two
            // PREFIXES (`src-` and `ep-`), and that argument died the moment a user
            // could type `/src-1` as a path. The rule now is a SLASH: every endpoint
            // key begins with one and no source key can, so the two namespaces cannot
            // meet whatever the user or a forged file writes.
            for k in routes.keys() {
                assert!(
                    k.starts_with('/') ^ k.starts_with("src-"),
                    "key {k} is in exactly one namespace (endpoint keys lead with a                      slash, source keys never do)"
                );
            }
        }

        /// CR-01, the host half: `endpoint_route_key` is the IDENTITY on every path the
        /// write gate accepts, so two accepted paths can never share one route key.
        ///
        /// # The defect, and why it needed a test in THIS crate
        /// `fabrico_core::edit::endpoint_path_is_valid` used to accept `//orders`: `/`
        /// is an unreserved path byte, so the string passed every rule. Rule 4
        /// (uniqueness, `grid_view::endpoint_path_owner`) compares RAW strings, so
        /// `//orders` and `/orders` were two distinct addresses and neither refused the
        /// other. `endpoint_route_key` then normalized both onto `/orders`, because
        /// `trim_start_matches` strips ALL leading slashes rather than one, and
        /// `project_routes`'s `collect` kept whichever node came later. One Route
        /// silently stopped existing, and its own config card showed a POST URL that ran
        /// the OTHER Route's Handler.
        ///
        /// Neither crate can see that on its own: `fabrico-core` owns the gate and
        /// `fabrico-host` owns the key, and the bug was that the two disagreed. This is
        /// the crate that can see both, so this is where the agreement is asserted.
        ///
        /// # Written as a PROPERTY over a table, not as one repaired example
        /// Pinning `endpoint_path_is_valid("//orders") == false` alone would leave the
        /// next widening of the alphabet free to reopen the gap somewhere else. The
        /// property is that the gate and the key AGREE, so the table is filtered by the
        /// gate and every survivor must key as itself and own a distinct map entry.
        #[test]
        fn every_path_the_write_gate_accepts_keys_as_itself_and_owns_its_own_route() {
            use fabrico_core::edit::endpoint_path_is_valid;

            // The candidate addresses, INCLUDING the two that used to collide. Nothing
            // here is pre-filtered: the gate decides which survive, so the test measures
            // the gate rather than restating it.
            const CANDIDATES: [&str; 10] = [
                "/orders",
                "//orders",
                "///orders",
                "/orders/new",
                "/orders/new/id",
                "/a//b",
                "/src-1",
                "/ep-1",
                "orders",
                "/or ders",
            ];

            let accepted: Vec<&str> = CANDIDATES
                .into_iter()
                .filter(|p| endpoint_path_is_valid(p))
                .collect();

            // NON-VACUITY. A gate that refused everything would satisfy both assertions
            // below over an empty set. The multi-segment path is named explicitly
            // because walk item J-5 ruled that it must stay legal.
            assert!(
                accepted.len() >= 5,
                "the gate must still accept ordinary addresses; it accepted {accepted:?}"
            );
            assert!(
                accepted.contains(&"/orders/new/id"),
                "J-5: a multi-segment path is legal, so a fix that closed CR-01 by \
                 refusing every repeated slash would be the WRONG fix"
            );

            // HALF ONE: the key function is the identity on the accepted set. This is
            // what makes the two functions agree by construction; the `trim` in
            // `endpoint_route_key` is defensive-only against a FORGED path from here on.
            for path in &accepted {
                assert_eq!(
                    &endpoint_route_key(path),
                    path,
                    "an accepted path must key as ITSELF, or the address the board \
                     stores is not the address the door answers at (CR-01)"
                );
            }

            // HALF TWO: the same claim seen from the map, which is where the user met
            // it. One Route per accepted path, and every Route keeps its own entry.
            let mut core = genesis();
            for path in &accepted {
                let ep = core.state.add_endpoint();
                match core.state.node_mut(ep) {
                    Some(Node::Endpoint(e)) => e.path = (*path).to_owned(),
                    other => panic!("expected a live endpoint, found {other:?}"),
                }
            }
            let routes = project_routes(&core, &TimerSet::default());
            assert_eq!(
                routes.len(),
                accepted.len(),
                "{} accepted paths must publish {} distinct routes; a smaller map means \
                 `collect` dropped a Route the write gate had already committed, and \
                 that Route is unreachable at the URL its own panel shows",
                accepted.len(),
                accepted.len()
            );
        }

        #[test]
        fn route_fingerprint_tracks_endpoint_ids() {
            // THE ENDP-05 lever: the recompute fingerprint MUST include Endpoint ids,
            // or maybe_republish_routes never fires for a placed/deleted endpoint
            // (Pitfall 4). Adding an Endpoint flips the fingerprint (republish fires);
            // removing it flips back (the ep- label is removed).
            let mut core = genesis();
            let before = route_ids(&core, &TimerSet::default());
            let ep = core.state.add_endpoint();
            let placed_key = ep_key(&core, ep);
            let after = route_ids(&core, &TimerSet::default());
            let holds = |f: &[(NodeId, RouteAddress)], id: NodeId| f.iter().any(|e| e.0 == id);
            assert!(
                !holds(&before, ep) && holds(&after, ep),
                "the fingerprint tracks the Endpoint id"
            );
            assert_ne!(before, after, "an Endpoint place flips the fingerprint -> republish");

            // SERVE-08 (R-45): a path-only change flips it TOO. Before 72-07 the
            // fingerprint was a bare `Vec<NodeId>`, so this assertion would have failed
            // and the map would never have been rebuilt for a user who typed an address
            // and pressed Apply. Nothing is placed or deleted between the two reads.
            let addressed_before = route_ids(&core, &TimerSet::default());
            match core.state.node_mut(ep) {
                Some(Node::Endpoint(e)) => e.path = "/orders".to_owned(),
                other => panic!("expected a live endpoint, found {other:?}"),
            }
            assert_ne!(
                route_ids(&core, &TimerSet::default()),
                addressed_before,
                "a path-only change must flip the fingerprint with NOTHING placed, or                  the route map is never republished and the user gets a 404 at the                  address they just typed (R-45)"
            );

            // Simulate the delete: a core WITHOUT the endpoint has the ORIGINAL
            // fingerprint again, so the guard fires and project_routes drops its key.
            let deleted = genesis();
            let restored = route_ids(&deleted, &TimerSet::default());
            assert_eq!(restored, before, "removing the Endpoint restores the prior fingerprint");
            assert!(
                !project_routes(&deleted, &TimerSet::default()).contains_key(&placed_key),
                "a core without the Endpoint no longer projects the key it was placed at"
            );
        }

        #[test]
        fn non_route_node_does_not_change_fingerprint() {
            // A non-Source/non-Endpoint node (a Sink) must NOT flip the fingerprint ->
            // no route Arc churn on a non-routable gesture (Pitfall 5).
            let mut core = genesis();
            let ep = core.state.add_endpoint();
            let before = route_ids(&core, &TimerSet::default());
            core.state.add_sink(SinkTemplate::Debug, 64);
            let after = route_ids(&core, &TimerSet::default());
            assert_eq!(before, after, "a non-routable node leaves the fingerprint unchanged");
            let routes = project_routes(&core, &TimerSet::default());
            assert_eq!(routes.len(), 1, "only the Endpoint routes (the Sink is not routable)");
            assert!(routes.contains_key(&ep_key(&core, ep)), "the Route's key still resolves");
        }

        #[test]
        fn genesis_endpoint_is_routable_through_the_live_projection() {
            // End-to-end through the SEAM: an Endpoint present at construction is
            // SEEDED into the LIVE route table by SimLoop::new (project_routes), so a
            // loaded/placed endpoint routes from the very first request (ENDP-05).
            let rt = tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
                .expect("build runtime");
            let dir = tempfile::tempdir().expect("tempdir");
            let mut core = genesis();
            let ep = core.state.add_endpoint();
            let key = ep_key(&core, ep);
            let store = RedbStore::open(dir.path().join("log.redb")).expect("open log");
            let ledger = DispatchLedger::open(dir.path().join("ledger.redb")).expect("open ledger");
            let host = Host::new(core, store, ledger, None).expect("open host");
            let (_gtx, grx) = gesture_channel();
            let cfg = HostConfig {
                webhook_addr: "127.0.0.1:0".parse().expect("loopback addr"),
            };
            let sim = SimLoop::new(host, RenderProducer::new(), rt.handle(), cfg, grx);
            let routes = sim.routes_receiver().borrow().clone();
            assert_eq!(
                routes.get(&key),
                Some(&ep),
                "a genesis Endpoint is projected into the LIVE route table at construction"
            );
        }

        // ---------------------------------------------------------------------------
        // DEMO-08 (plan 85-01, D-20): A TIMER SOURCE HAS NO DOOR.
        //
        // The route table is the set of doors that ACCEPT. A Source whose applied trigger
        // is Timer is fed by the host's own clock, so a `POST /hook/src-<id>` to it is
        // answered by the handler's existing unknown-target branch: 404, empty body,
        // nothing forwarded, nothing logged. The trigger is not a snapshot field, so the
        // projection reads the host's `TimerSet` beside the core, and the fingerprint
        // carries each Source's interval so a flip republishes with no hook.
        // ---------------------------------------------------------------------------

        /// A one-entry timer set naming `node` at `interval` ticks, the shape
        /// `project_timers` builds from a logged `Configure{Source, Timer}`.
        fn timer_on(node: NodeId, interval: u64) -> TimerSet {
            TimerSet::new(vec![crate::config::TimerConfig {
                target: node,
                interval,
                item: b"{}".to_vec(),
            }])
        }

        #[test]
        fn a_timer_source_has_no_route_and_a_webhook_source_has_one() {
            let mut core = genesis();
            let timed = core.state.add_source();
            let hooked = core.state.add_source();
            let routes = project_routes(&core, &timer_on(timed, 8));
            assert!(
                !routes.contains_key(&src_label(timed)),
                "a Source on Timer has no door: a POST to it falls into the 404 branch"
            );
            assert_eq!(
                routes.get(&src_label(hooked)),
                Some(&hooked),
                "the Source on Webhook keeps its door"
            );
            assert_eq!(routes.len(), 1, "one Webhook Source, one door");
            assert_eq!(
                project_routes(&core, &TimerSet::default()).len(),
                2,
                "with no timers both Sources are on Webhook and both answer"
            );
        }

        #[test]
        fn a_trigger_flip_changes_the_route_fingerprint() {
            // The same core read with and without the timer entry: the fingerprint must
            // differ, or a Configure that flips Timer and Webhook changes nothing the
            // republish guard watches and the door never moves (D-20).
            let mut core = genesis();
            let src = core.state.add_source();
            let on_webhook = route_ids(&core, &TimerSet::default());
            let on_timer = route_ids(&core, &timer_on(src, 8));
            assert_ne!(on_webhook, on_timer, "a trigger flip flips the fingerprint");
            assert_eq!(
                on_timer,
                route_ids(&core, &timer_on(src, 8)),
                "the fingerprint is a pure function of the core and the timer set"
            );
        }

        /// A genesis host with nothing on it; the caller keeps `dir` alive.
        fn empty_host(dir: &std::path::Path) -> Host {
            let store = RedbStore::open(dir.join("log.redb")).expect("open log");
            let ledger = DispatchLedger::open(dir.join("ledger.redb")).expect("open ledger");
            Host::new(genesis(), store, ledger, None).expect("open host")
        }

        /// Send one gesture through the real loop and fold it in one tick.
        fn fold(sim: &mut SimLoop, gtx: &GestureTx, cmd: GridCommand) {
            gtx.send_gesture(cmd).expect("send gesture");
            sim.run(Some(1), Duration::ZERO).expect("fold the gesture");
        }

        /// Place a Source from the palette's own command, returning its id and handle.
        fn place_source(sim: &mut SimLoop, gtx: &GestureTx) -> (NodeId, u64) {
            fold(
                sim,
                gtx,
                GridCommand::Place {
                    kind: fabrico_protocol::machine_kind::SOURCE,
                    cell_x: 0,
                    cell_y: 0,
                },
            );
            let id = *sim
                .host()
                .core()
                .last_tick
                .placed
                .last()
                .expect("the placed Source minted an id");
            let handle = sim.handle_for_node(id).expect("the placed Source has a render handle");
            (id, handle)
        }

        /// Configure a Source's trigger through the wire-level command the panel sends.
        fn configure_trigger(
            sim: &mut SimLoop,
            gtx: &GestureTx,
            handle: u64,
            trigger: fabrico_protocol::SourceTrigger,
        ) {
            fold(
                sim,
                gtx,
                GridCommand::Configure {
                    node: handle,
                    config: fabrico_protocol::MachineConfig::Source { trigger },
                },
            );
        }

        /// Every `src-` key the LIVE route snapshot holds right now, sorted.
        fn live_source_doors(sim: &SimLoop) -> Vec<String> {
            sim.routes_receiver()
                .borrow()
                .keys()
                .filter(|k| k.starts_with("src-"))
                .cloned()
                .collect()
        }

        /// The `src-` key of every Source on the CURRENT core (an Undo may re-mint).
        fn sources_on_core(sim: &SimLoop) -> Vec<String> {
            let core = sim.host().core();
            core.state
                .node_ids()
                .filter(|id| matches!(core.state.node(*id), Some(Node::Source(_))))
                .map(src_label)
                .collect()
        }

        #[test]
        fn webhook_url_is_none_for_a_timer_source() {
            // The panel's URL and the door share ONE reading of the trigger: a Source on
            // Timer has no door, so it has no URL to copy (72-UI-SPEC 3.1, D-20).
            let rt = super::support::rt();
            let dir = tempfile::tempdir().expect("tempdir");
            let (gtx, grx) = gesture_channel();
            let mut sim = SimLoop::new(
                empty_host(dir.path()),
                RenderProducer::new(),
                rt.handle(),
                super::support::cfg(),
                grx,
            );
            let addr: SocketAddr = "127.0.0.1:8787".parse().expect("loopback addr");
            let (id, handle) = place_source(&mut sim, &gtx);
            assert_eq!(
                sim.webhook_url(handle, addr),
                Some(format!("http://127.0.0.1:8787/hook/{}", src_label(id))),
                "a freshly placed Source is on Webhook and offers its URL"
            );
            configure_trigger(&mut sim, &gtx, handle, fabrico_protocol::SourceTrigger::Timer { interval_ticks: 5 });
            assert_eq!(
                sim.webhook_url(handle, addr),
                None,
                "a Source on Timer offers no URL: the door it would name answers 404"
            );
            configure_trigger(&mut sim, &gtx, handle, fabrico_protocol::SourceTrigger::Webhook);
            assert!(
                sim.webhook_url(handle, addr).is_some(),
                "back on Webhook, the URL is offered again"
            );
        }

        #[test]
        fn flipping_a_sources_trigger_both_ways_republishes_its_route() {
            // On a LIVE loop, through the real gesture path: every way a trigger can
            // change (Configure either way, Undo, Redo) moves the door in the same tick
            // that folds it. This is the test the fingerprint and the timer-before-routes
            // ordering in `tick_body` are for: without either, the door lags a gesture.
            let rt = super::support::rt();
            let dir = tempfile::tempdir().expect("tempdir");
            let (gtx, grx) = gesture_channel();
            let mut sim = SimLoop::new(
                empty_host(dir.path()),
                RenderProducer::new(),
                rt.handle(),
                super::support::cfg(),
                grx,
            );
            let (id, handle) = place_source(&mut sim, &gtx);
            assert_eq!(
                live_source_doors(&sim),
                vec![src_label(id)],
                "a freshly placed Source is on Webhook and has a door"
            );

            configure_trigger(&mut sim, &gtx, handle, fabrico_protocol::SourceTrigger::Timer { interval_ticks: 5 });
            assert_eq!(
                live_source_doors(&sim),
                Vec::<String>::new(),
                "Configure Timer closes the door in the tick that folds it"
            );

            configure_trigger(&mut sim, &gtx, handle, fabrico_protocol::SourceTrigger::Webhook);
            assert_eq!(
                live_source_doors(&sim),
                vec![src_label(id)],
                "Configure Webhook opens it again"
            );

            fold(&mut sim, &gtx, GridCommand::Undo);
            assert_eq!(sources_on_core(&sim).len(), 1, "the Undo took back a Configure, not the Source");
            assert_eq!(
                live_source_doors(&sim),
                Vec::<String>::new(),
                "undoing the Webhook Configure puts the Source back on Timer, and the door closes"
            );

            fold(&mut sim, &gtx, GridCommand::Redo);
            assert_eq!(
                live_source_doors(&sim),
                sources_on_core(&sim),
                "redoing the Webhook Configure opens the door of the Source on the board"
            );
            assert_eq!(live_source_doors(&sim).len(), 1, "exactly one door, for the one Source");
        }
    }

    /// Shared harness for the 38-03 host-bridge tests (mint / reply / deadline /
    /// exactly-once). Builds a host carrying ONE inert Endpoint node and provides
    /// the bounded (no-wall-clock-assertion) poll helpers the cross-thread reply
    /// arm needs.
    mod support {
        use super::super::*;
        use fabrico_core::command::EVENT_VERSION;
        use fabrico_core::core::Core;

        pub(super) fn rt() -> tokio::runtime::Runtime {
            tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
                .expect("build executor runtime")
        }

        pub(super) fn cfg() -> HostConfig {
            HostConfig {
                webhook_addr: "127.0.0.1:0".parse().expect("loopback addr"),
            }
        }

        /// A genesis host with ONE inert Endpoint node; returns `(host, ep_id)`.
        /// The caller keeps the `TempDir` alive (the redb store lives under it).
        pub(super) fn host_with_ep(dir: &std::path::Path) -> (Host, NodeId) {
            let mut core = Core::genesis(LogHeader {
                schema_version: SCHEMA_VERSION,
                seed: 1,
            });
            let ep = core.state.add_endpoint();
            let store = RedbStore::open(dir.join("log.redb")).expect("open log");
            let ledger = DispatchLedger::open(dir.join("ledger.redb")).expect("open ledger");
            (Host::new(core, store, ledger, None).expect("open host"), ep)
        }

        /// A `{status, body}` [`ResponseDescriptor`](crate::ingress::endpoint::ResponseDescriptor)
        /// packed as `Effect::Reply.payload` `Item` bytes (the handler encode path).
        pub(super) fn descriptor_item(status: u16, body: &str) -> Item {
            let desc = crate::ingress::endpoint::ResponseDescriptor {
                status,
                headers: std::collections::BTreeMap::new(),
                body: body.to_string(),
            };
            Item(serde_json::to_vec(&desc).expect("encode descriptor"))
        }

        /// A `Reply` command carrying `correlation` + a `{status, body}` descriptor.
        pub(super) fn reply_command(node: NodeId, correlation: u64, status: u16, body: &str) -> Command {
            Command {
                event_version: EVENT_VERSION,
                id: (0, node, correlation as u32),
                partition: 0,
                effect: Effect::Reply {
                    correlation,
                    payload: descriptor_item(status, body),
                    // A FIFTH construction/destructure site the plan's R-28 table did not
                    // list, found by `cargo build --all-targets` (the lib-test build).
                    // This helper FABRICATES a Reply command directly, never through the
                    // fold, to exercise the host's parked-socket arm. That arm resolves by
                    // CORRELATION and reads neither field (D-08), so these two are the
                    // honest values for a reply owed to `node`, not load-bearing input.
                    return_addr: (node, 0),
                    budget: fabrico_core::wire::DEFAULT_WIRE_BUDGET,
                },
                deadline: 10_000,
            }
        }

        /// Bounded spin (no wall-clock ASSERTION — just a yield budget) awaiting the
        /// off-thread reply arm to resolve a parked socket. Panics if unresolved.
        pub(super) fn poll_socket(rx: &mut oneshot::Receiver<HttpResponse>) -> HttpResponse {
            for _ in 0..400 {
                match rx.try_recv() {
                    Ok(resp) => return resp,
                    Err(oneshot::error::TryRecvError::Empty) => {
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    Err(oneshot::error::TryRecvError::Closed) => {
                        panic!("socket sender dropped without answering")
                    }
                }
            }
            panic!("parked socket was not resolved within the bounded spin")
        }

        /// Bounded spin awaiting a `ResultEvent` back on the loop's results channel
        /// (the "the command still closed in-flight" oracle).
        pub(super) fn poll_result(rx: &mut UnboundedReceiver<ResultEvent>) -> ResultEvent {
            for _ in 0..400 {
                if let Ok(ev) = rx.try_recv() {
                    return ev;
                }
                std::thread::sleep(Duration::from_millis(5));
            }
            panic!("no ResultEvent arrived within the bounded spin")
        }

        /// Every logged `WireRequest` as `(correlation, deadline_tick, budget)` — the
        /// mint oracle (a WireRequest, NEVER a ManualInject, per endpoint hit).
        pub(super) fn wire_requests(sim: &SimLoop) -> Vec<(u64, u64, u64)> {
            sim.host()
                .logged_events()
                .expect("read log")
                .iter()
                .filter_map(|e| match e.payload {
                    EventPayload::WireRequest {
                        correlation,
                        deadline_tick,
                        budget,
                        ..
                    } => Some((correlation, deadline_tick, budget)),
                    _ => None,
                })
                .collect()
        }

        /// Count logged `ManualInject` events (proves an endpoint hit mints a
        /// WireRequest, NOT a ManualInject).
        pub(super) fn manual_injects(sim: &SimLoop) -> usize {
            sim.host()
                .logged_events()
                .expect("read log")
                .iter()
                .filter(|e| matches!(e.payload, EventPayload::ManualInject { .. }))
                .count()
        }
    }

    /// Task 1 — the executor-consumer `Effect::Reply` interception (ENDP-01/04):
    /// the reply arm resolves the parked socket off-thread through the shared
    /// registry and STILL closes the command; `dispatch` stays registry-free.
    mod reply {
        use super::super::*;
        use super::support::*;

        #[test]
        fn a_parked_reply_resolves_the_socket_and_closes_the_command() {
            let rt = rt();
            let dir = tempfile::tempdir().expect("tempdir");
            let (host, ep) = host_with_ep(dir.path());
            let (_gtx, grx) = gesture_channel();
            let mut sim = SimLoop::new(host, RenderProducer::new(), rt.handle(), cfg(), grx);

            // Park a caller socket under correlation 42 (the sim-loop mint precursor).
            let (tx, mut socket) = oneshot::channel();
            sim.registry.try_park(42, 1000, tx).expect("park under cap");

            // A Reply for 42 crosses the consumer: resolve the socket, close the cmd.
            sim.test_send_command(reply_command(ep, 42, 200, "pong"));

            let resp = poll_socket(&mut socket);
            assert_eq!(resp.status().as_u16(), 200, "the descriptor status reaches the caller");
            assert_eq!(resp.body_bytes(), b"pong", "the descriptor body reaches the caller");

            let ev = poll_result(&mut sim.results_rx);
            assert_eq!(ev.outcome, Outcome::Success, "the command still closes in-flight");
            assert!(sim.registry.is_empty(), "resolve removed the parked entry");
        }

        #[test]
        fn an_unparked_reply_is_a_socket_noop_but_still_closes_the_command() {
            let rt = rt();
            let dir = tempfile::tempdir().expect("tempdir");
            let (host, ep) = host_with_ep(dir.path());
            let (_gtx, grx) = gesture_channel();
            let mut sim = SimLoop::new(host, RenderProducer::new(), rt.handle(), cfg(), grx);

            // Nothing parked under 7: resolve finds None (a socket no-op).
            sim.test_send_command(reply_command(ep, 7, 200, "x"));

            let ev = poll_result(&mut sim.results_rx);
            assert_eq!(ev.outcome, Outcome::Success, "an unparked reply still closes the command");
            assert!(sim.registry.is_empty(), "no socket was written (nothing parked)");
        }

        #[test]
        fn with_endpoint_stores_the_receiver_and_a_fresh_registry_is_empty() {
            let rt = rt();
            let dir = tempfile::tempdir().expect("tempdir");
            let (host, _ep) = host_with_ep(dir.path());
            let (_gtx, grx) = gesture_channel();
            let sim = SimLoop::new(host, RenderProducer::new(), rt.handle(), cfg(), grx);

            assert!(sim.registry.is_empty(), "a fresh SimLoop parks nothing (replay-mute)");
            assert!(sim.endpoint_rx.is_none(), "no endpoint seam until with_endpoint");
            assert_eq!(sim.correlation_next, 0, "the correlation counter starts at 0");

            let (_etx, erx) = tokio::sync::mpsc::channel::<EndpointIngress>(crate::ingress::endpoint::ENDPOINT_INGRESS_CAPACITY);
            let sim = sim.with_endpoint(erx);
            assert!(sim.endpoint_rx.is_some(), "with_endpoint stored the receiver");
        }

        #[test]
        fn a_non_reply_effect_still_dispatches_and_reply_is_intercepted_before_the_counter() {
            let rt = rt();
            let dir = tempfile::tempdir().expect("tempdir");
            let (host, ep) = host_with_ep(dir.path());
            let (_gtx, grx) = gesture_channel();
            let mut sim = SimLoop::new(host, RenderProducer::new(), rt.handle(), cfg(), grx);

            // A Noop takes the NORMAL dispatch path (dispatched_count increments).
            sim.test_send_command(Command {
                event_version: fabrico_core::command::EVENT_VERSION,
                id: (0, ep, 0),
                partition: 0,
                effect: Effect::Noop,
                deadline: 1000,
            });
            for _ in 0..400 {
                if sim.dispatched_count() >= 1 {
                    break;
                }
                std::thread::sleep(Duration::from_millis(5));
            }
            assert_eq!(sim.dispatched_count(), 1, "a Noop takes the normal dispatch path");

            // A Reply is INTERCEPTED before the dispatch counter — it never reaches
            // `dispatch`, so the count stays put while the command still closes.
            sim.test_send_command(reply_command(ep, 99, 200, "y"));
            let ev = poll_result(&mut sim.results_rx);
            assert_eq!(ev.outcome, Outcome::Success);
            std::thread::sleep(Duration::from_millis(30));
            assert_eq!(
                sim.dispatched_count(),
                1,
                "a Reply is intercepted in the consumer, never dispatched (dispatch stays registry-free)"
            );
        }
    }

    /// Task 2 — `acquire_input` mints a WireRequest + parks the socket (ENDP-01),
    /// with the DoS cap refusing over-cap hits with a 503 (ENDP-04).
    mod mint {
        use super::super::*;
        use super::support::*;

        #[test]
        fn an_endpoint_hit_mints_a_wire_request_with_deadline_and_budget() {
            let rt = rt();
            let dir = tempfile::tempdir().expect("tempdir");
            let (host, ep) = host_with_ep(dir.path());
            let (etx, erx) = tokio::sync::mpsc::channel::<EndpointIngress>(crate::ingress::endpoint::ENDPOINT_INGRESS_CAPACITY);
            let (_gtx, grx) = gesture_channel();
            let mut sim =
                SimLoop::new(host, RenderProducer::new(), rt.handle(), cfg(), grx).with_endpoint(erx);

            // One endpoint hit (socket receiver kept alive so the sender stays valid).
            let (tx, _socket) = oneshot::channel();
            etx.try_send(EndpointIngress {
                target: ep,
                envelope: br#"{"body":1}"#.to_vec(),
                respond: tx,
            })
            .expect("send endpoint ingress");

            sim.run(Some(1), Duration::ZERO).expect("drain + fold one tick");

            let reqs = wire_requests(&sim);
            assert_eq!(reqs.len(), 1, "an endpoint hit mints exactly one WireRequest");
            let (correlation, deadline_tick, budget) = reqs[0];
            assert_eq!(correlation, 0, "the first correlation is 0");
            assert_eq!(
                deadline_tick, DEFAULT_ENDPOINT_DEADLINE_TICKS,
                "deadline_tick == tick_at_ingress(0) + DEFAULT_ENDPOINT_DEADLINE_TICKS"
            );
            assert_eq!(
                budget,
                fabrico_core::wire::DEFAULT_WIRE_BUDGET,
                "the request carries the default wire budget"
            );
            assert_eq!(manual_injects(&sim), 0, "an endpoint hit is NEVER a ManualInject");
            assert_eq!(sim.registry.len(), 1, "the socket stays parked awaiting a reply");
        }

        #[test]
        fn two_hits_mint_two_distinct_monotonic_correlations() {
            let rt = rt();
            let dir = tempfile::tempdir().expect("tempdir");
            let (host, ep) = host_with_ep(dir.path());
            let (etx, erx) = tokio::sync::mpsc::channel::<EndpointIngress>(crate::ingress::endpoint::ENDPOINT_INGRESS_CAPACITY);
            let (_gtx, grx) = gesture_channel();
            let mut sim =
                SimLoop::new(host, RenderProducer::new(), rt.handle(), cfg(), grx).with_endpoint(erx);

            let mut _keep = Vec::new();
            for _ in 0..2 {
                let (tx, rx) = oneshot::channel();
                _keep.push(rx);
                etx.try_send(EndpointIngress {
                    target: ep,
                    envelope: Vec::new(),
                    respond: tx,
                })
                .expect("send endpoint ingress");
            }
            sim.run(Some(1), Duration::ZERO).expect("drain both + fold");

            let corrs: Vec<u64> = wire_requests(&sim).iter().map(|r| r.0).collect();
            assert_eq!(corrs, vec![0, 1], "two hits mint distinct monotonic correlations");
            assert_eq!(sim.registry.len(), 2, "both sockets parked");
        }

        #[test]
        fn an_over_cap_hit_503s_and_enqueues_no_wire_request() {
            let rt = rt();
            let dir = tempfile::tempdir().expect("tempdir");
            let (host, ep) = host_with_ep(dir.path());
            let (etx, erx) = tokio::sync::mpsc::channel::<EndpointIngress>(crate::ingress::endpoint::ENDPOINT_INGRESS_CAPACITY);
            let (_gtx, grx) = gesture_channel();
            let mut sim =
                SimLoop::new(host, RenderProducer::new(), rt.handle(), cfg(), grx).with_endpoint(erx);

            // Fill the registry to the cap directly (receivers kept alive).
            let mut _keep = Vec::with_capacity(crate::registry::MAX_PARKED_ENDPOINTS);
            for c in 0..crate::registry::MAX_PARKED_ENDPOINTS as u64 {
                let (tx, rx) = oneshot::channel();
                sim.registry.try_park(c, 10_000, tx).expect("park under cap");
                _keep.push(rx);
            }
            assert_eq!(sim.registry.len(), crate::registry::MAX_PARKED_ENDPOINTS);

            // One more hit: the socket must 503 and NO WireRequest be enqueued.
            let (tx, mut socket) = oneshot::channel();
            etx.try_send(EndpointIngress {
                target: ep,
                envelope: Vec::new(),
                respond: tx,
            })
            .expect("send endpoint ingress");
            sim.run(Some(1), Duration::ZERO).expect("drain (refused) + fold");

            let resp = poll_socket(&mut socket);
            assert_eq!(resp.status().as_u16(), 503, "an over-cap hit is refused with a 503");
            assert_eq!(wire_requests(&sim).len(), 0, "the over-cap hit enqueued no WireRequest");
            assert_eq!(
                sim.registry.len(),
                crate::registry::MAX_PARKED_ENDPOINTS,
                "the cap is never exceeded"
            );
        }
    }

    /// Task 2 — the per-tick host-side deadline sweep (ENDP-03): 504 expired
    /// requests against `core.tick`, strictly-less so a reply wins ties, and the
    /// core fold/snapshot is UNTOUCHED by a timeout (the determinism boundary).
    mod deadline {
        use super::super::*;
        use super::support::*;

        #[test]
        fn the_sweep_504s_an_expired_request_without_touching_the_core() {
            let rt = rt();
            let dir = tempfile::tempdir().expect("tempdir");
            let (host, _ep) = host_with_ep(dir.path());
            let (_gtx, grx) = gesture_channel();
            let mut sim = SimLoop::new(host, RenderProducer::new(), rt.handle(), cfg(), grx);

            sim.run(Some(1), Duration::ZERO).expect("advance to tick 1");

            // Park a request already past its deadline (0 < now == 1).
            let (tx, mut socket) = oneshot::channel();
            sim.registry.try_park(5, 0, tx).expect("park");

            let log_before = sim.host().logged_events().expect("log").len();
            let snap_before = sim.host().snapshot_bytes();

            sim.sweep_endpoint_deadlines();

            let resp = poll_socket(&mut socket);
            assert_eq!(resp.status().as_u16(), 504, "an expired request is 504'd host-side");
            assert_eq!(resp.body_bytes(), br#"{"error":"timeout"}"#, "the canonical timeout body");
            assert!(sim.registry.is_empty(), "the swept entry was removed");
            assert_eq!(
                sim.host().logged_events().expect("log").len(),
                log_before,
                "the sweep logs NO event (the core fold is untouched)"
            );
            assert_eq!(
                sim.host().snapshot_bytes(),
                snap_before,
                "the timeout leaves the core snapshot byte-identical (determinism boundary)"
            );
        }

        #[test]
        fn strictly_less_means_deadline_equals_now_is_not_swept_this_tick() {
            let rt = rt();
            let dir = tempfile::tempdir().expect("tempdir");
            let (host, _ep) = host_with_ep(dir.path());
            let (_gtx, grx) = gesture_channel();
            let mut sim = SimLoop::new(host, RenderProducer::new(), rt.handle(), cfg(), grx);

            sim.run(Some(5), Duration::ZERO).expect("advance to tick 5");
            assert_eq!(sim.host().core().tick, 5);

            // deadline_tick == now: NOT swept this tick (reply wins ties).
            let (tx, mut socket) = oneshot::channel();
            sim.registry.try_park(9, 5, tx).expect("park");
            sim.sweep_endpoint_deadlines();
            assert!(
                socket.try_recv().is_err(),
                "deadline == now is NOT swept this tick (strictly-less; reply wins the tie)"
            );
            assert_eq!(sim.registry.len(), 1, "the entry survives the tie tick");

            // The NEXT tick advances now to 6 and the internal sweep fires.
            sim.run(Some(1), Duration::ZERO).expect("advance to tick 6");
            let resp = poll_socket(&mut socket);
            assert_eq!(resp.status().as_u16(), 504, "swept only on the next tick (deadline < now)");
            assert!(sim.registry.is_empty());
        }
    }

    /// Task 2 — ENDP-04a exactly-once: a timeout then a LATE reply for the same
    /// correlation writes the socket exactly once (the registry `remove` gate).
    mod exactly_once {
        use super::super::*;
        use super::support::*;

        #[test]
        fn a_timeout_then_a_late_reply_writes_the_socket_exactly_once() {
            let rt = rt();
            let dir = tempfile::tempdir().expect("tempdir");
            let (host, ep) = host_with_ep(dir.path());
            let (_gtx, grx) = gesture_channel();
            let mut sim = SimLoop::new(host, RenderProducer::new(), rt.handle(), cfg(), grx);

            sim.run(Some(1), Duration::ZERO).expect("advance to tick 1");

            // Park an already-expired request and let the sweep 504 it.
            let (tx, mut socket) = oneshot::channel();
            sim.registry.try_park(3, 0, tx).expect("park");
            sim.sweep_endpoint_deadlines();

            let resp = poll_socket(&mut socket);
            assert_eq!(resp.status().as_u16(), 504, "the sweep wins and 504s the socket");
            assert!(sim.registry.is_empty(), "the remove gate cleared correlation 3");

            // A LATE reply for the SAME correlation now finds None and drops — the
            // socket is never written a second time.
            sim.test_send_command(reply_command(ep, 3, 200, "late"));
            let ev = poll_result(&mut sim.results_rx);
            assert_eq!(ev.outcome, Outcome::Success, "the late reply still closes its command");
            assert!(
                socket.try_recv().is_err(),
                "the socket was written exactly once (the late reply found no parked entry)"
            );
        }
    }

}
