//! The dev render transport — a loopback axum WebSocket that streams the render
//! producer's postcard bytes OUT and accepts gesture frames IN, on one socket.
//!
//! # One socket, identical bytes, pure subscriber
//! This transport is a pure SUBSCRIBER of the single
//! [`RenderProducer`](crate::render_packet::RenderProducer) (W2): it NEVER builds or
//! encodes a packet itself. On connect it sends the latest keyframe (the producer's
//! `watch`), then forwards each per-tick diff (the producer's `broadcast`). Those
//! bytes are byte-identical to the ones the Tauri `Channel` path (07-08) sends — the
//! locked "one builder, identical bytes" invariant. The per-tick OWNER that drives
//! `producer.on_tick` is the 07-08 sim loop; this transport only relays.
//!
//! # Gestures forward to the sim thread (mirrors webhook.rs)
//! An inbound binary frame is `postcard`-decoded into a [`GridCommand`] behind a
//! `Result` ([`decode_gesture`], never `unwrap`); a valid one is forwarded over the
//! gesture sink (`GestureTx`, an `UnboundedSender<GestureEnvelope>`) to the host loop,
//! which applies it
//! on the SIM THREAD via [`apply_gesture`](crate::input_apply::apply_gesture) (the core
//! is `!Send` and never crosses a thread — exactly the webhook's "handler forwards,
//! host loop applies" discipline). The gesture still enters the core only as a
//! validated, logged event (SC5); the async handler never touches `Host`.
//!
//! # The frame header (phase 88, D-02, D-06)
//! Every inbound binary frame is `[version byte][varint generation][varint gesture id][body]`,
//! the body byte-identical to what it always was. The version byte is
//! [`GESTURE_FRAME_VERSION`] (security T-88-09): a frame without it, which is every frame a
//! page on an older wire sends, is refused as unreadable instead of being read as a
//! different gesture. The generation is the board generation of the render packet the
//! client read its handles from; the gesture id is the client's own, monotonic per page
//! load. [`decode_gesture`] reads the header first and the body second.
//!
//! # Every gesture gets one answer (Phase 64 ERR-01, phase 88 D-06)
//! Each decoded gesture's envelope carries a
//! [`VerdictSink`](crate::gesture_verdict::VerdictSink) on ONE unbounded verdict channel per
//! connection, and the connection's select loop writes whatever arrives on it as a TEXT frame:
//! `gestureRefused`, `gestureAccepted` (after the tick that folded the gesture, naming the
//! handles it minted) or `gestureDiscarded` (dropped by a board swap). Every frame names the
//! gesture by the client's own id, read off the header; see
//! [`gesture_verdict`](crate::gesture_verdict). A verdict reaches only the connection that
//! sent the gesture: each socket has its own channel.
//!
//! # Security carry-over (mirror webhook.rs)
//! - Binds `127.0.0.1` ONLY this phase (threat T-07-EXPOSE) — never a public
//!   interface; [`run_render_listener`] `debug_assert`s the loopback discipline.
//! - Each inbound frame is size-capped ([`MAX_GESTURE_FRAME`] +
//!   [`WebSocketUpgrade::max_message_size`]) and decoded behind a `Result`
//!   (threat T-07-DOS-BODY) — a malformed/oversized frame is a typed reject, the
//!   loop stays alive, nothing panics.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use axum::Router;
use axum::extract::State;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::response::Response;
use axum::routing::get;
use fabrico_command::CommandError;
use fabrico_core::edit::MachineConfig;
use fabrico_protocol::GridCommand;
use serde_json::Value;
use tokio::net::TcpListener;
use tokio::sync::broadcast;
use tokio::sync::mpsc;
use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::oneshot;
use tokio::sync::watch;
use tower_http::limit::RequestBodyLimitLayer;

use crate::config_view::ConfigView;
use crate::gesture_verdict::{VerdictFrame, VerdictSink, VerdictTx};
use crate::demo_scene::SceneId;
use crate::render_packet::{RenderFrame, RenderProducer, RenderRelay};
use crate::sim_loop::{
    BELT_RUN_PACE_LEAD, BeltRunPace, ControlMsg, GestureEnvelope, GestureFrame, MAX_RUN_PACE_BELTS,
};

/// The maximum accepted gesture-frame size (bytes). A bigger inbound frame is a
/// typed reject before decode (threat T-07-DOS-BODY) — a `GridCommand` is a handful
/// of integers, so this is generous. Also fed to [`WebSocketUpgrade::max_message_size`]
/// so the WebSocket layer drops an oversized frame before it is buffered.
pub const MAX_GESTURE_FRAME: usize = 64 * 1024;

/// The first byte of every gesture frame (security T-88-09): the wire version of the
/// frame header, version 1 being `[version][varint generation][varint gesture id][body]`.
/// Mirrored by `GESTURE_FRAME_VERSION` in `frontend/src/protocol/decode.ts`, and locked to
/// it by a test that reads that file.
///
/// # Why 0xF1 and not 1
/// The byte must be one no older page's frame starts with, or a stale page's gesture
/// would read as a different one. A page from before phase 88 sends a bare body, whose
/// first byte is a `GridCommand` discriminant (`0..=11`, Place through Unlink) or the
/// run-pace lead [`BELT_RUN_PACE_LEAD`] (`0xFE`); `0xFF` is the byte the run-pace
/// non-collision argument keeps invalid. A version of 1 would make a bare Delete look
/// like a versioned frame. `0xF1` is none of those, and reads as "F, version 1". A later
/// header change takes the next unused value of that kind and refuses this one.
///
/// A phase 88 page from before this byte starts with its generation varint, so a
/// generation whose first byte is `0xF1` (113 plus a positive multiple of 128) would read as
/// versioned. Only a dev-WebSocket page kept open across a host rebuild can send one; a
/// release build ships the page and the host together.
pub const GESTURE_FRAME_VERSION: u8 = 0xF1;

/// The gesture sink: the channel an accepted [`GridCommand`] is forwarded on to the
/// host loop, which applies it on the sim thread (mirrors `webhook::IngressTx`).
///
/// RE-EXPORTED, never re-declared. The alias and the
/// [`GestureEnvelope`](crate::sim_loop::GestureEnvelope) it carries live together in
/// [`sim_loop`](crate::sim_loop) beside the drain that reads them, so this transport and
/// the Tauri shell cannot drift onto two different channel item types.
pub use crate::sim_loop::GestureTx;

/// The control sink: the channel an accepted control frame's [`ControlMsg`] is
/// forwarded on to the sim thread (which services it at the tick boundary). Mirrors
/// [`GestureTx`] — the async WS handler NEVER touches `Host`, it only forwards a
/// typed intent (CLEAN-04).
pub type ControlTx = UnboundedSender<ControlMsg>;

/// The maximum accepted control-frame size (bytes). A control frame is a short
/// keyword plus an optional path, so this is generous; a bigger inbound TEXT frame
/// is a typed reject before decode (threat T-18-CTRL-WS).
pub const MAX_CONTROL_FRAME: usize = 4 * 1024;

/// Decode an inbound control TEXT frame into a [`ControlMsg`] behind a `Result` —
/// NEVER a panic (mirrors [`decode_gesture`]). The dev-WS control wire is a tiny,
/// dependency-free line grammar so 18-05 can encode it trivially on the TS side:
///
/// ```text
/// "pause" | "resume" | "step" | "load_demo" | "new"   (no argument)
/// "save\n<path>" | "load\n<path>"              (kind, newline, then the path)
/// "load_example\n<scene-id>"                   (kind, newline, then the scene id)
/// ```
///
/// The `kind` is the text up to the first `\n`; anything after it is the argument
/// (the path for Save/Load, the scene id for `load_example`). The ONLY legal scene
/// ids are the three shipped scenes, `demo_scene`, `order_processing` and `advanced`:
/// [`SceneId::parse`] is the typed boundary (T-55-04); an unknown id is `Malformed`, never a silent demo load. An
/// unknown kind, a missing/empty argument where one is required, or an argument on
/// an argument-less kind is a typed [`CommandError::Malformed`] — the transport
/// drops the frame and keeps the socket alive (threat T-18-CTRL-WS).
///
/// # Errors
/// [`CommandError::Malformed`] if the frame is oversized or not a valid control frame.
pub fn decode_control(text: &str) -> Result<ControlMsg, CommandError> {
    if text.len() > MAX_CONTROL_FRAME {
        return Err(CommandError::Malformed);
    }
    let (kind, path) = match text.split_once('\n') {
        Some((k, p)) => (k, Some(p)),
        None => (text, None),
    };
    match (kind, path) {
        ("pause", None) => Ok(ControlMsg::Pause),
        ("resume", None) => Ok(ControlMsg::Resume),
        ("step", None) => Ok(ControlMsg::Step),
        ("load_demo", None) => Ok(ControlMsg::LoadDemo),
        ("new", None) => Ok(ControlMsg::New),
        ("save", Some(p)) if !p.is_empty() => Ok(ControlMsg::Save(PathBuf::from(p))),
        ("load", Some(p)) if !p.is_empty() => Ok(ControlMsg::Load(PathBuf::from(p))),
        // The typed scene-id boundary (T-55-04): parse through SceneId; an
        // unknown or absent id falls to Malformed (frame dropped, socket
        // alive) — NEVER a silent demo fallback.
        ("load_example", Some(id)) => SceneId::parse(id)
            .map(ControlMsg::LoadScene)
            .ok_or(CommandError::Malformed),
        _ => Err(CommandError::Malformed),
    }
}

/// The dev host's fault switch (phase 90, D-13, research Finding A): an inbound TEXT frame
/// whose whole text is this word sets the flag `SimLoop::with_dev_fault` reads at the top of
/// `step()`, so the next step returns the dev fault's `StoreError` through the shipped fatal
/// path. Honoured ONLY when the router was built with a flag ([`render_ws_router`]'s
/// `dev_fault`), which only `dev_render_server` does; otherwise the frame is dropped like a
/// malformed control frame. It never reaches [`decode_control`], so `ControlMsg` and the
/// frontend's control kinds are unchanged and the Tauri shell has no path to it.
pub const DEV_FAULT_FRAME: &str = "dev_fault";

/// Decide ONE inbound TEXT frame against the dev fault switch (phase 90, D-13): `None` when
/// the frame is not [`DEV_FAULT_FRAME`] (the caller goes on to the query and control
/// grammars), `Some(true)` when it is and the flag was set, `Some(false)` when it is and this
/// router holds no switch (the frame is dropped).
///
/// A function rather than inline in the `select` arm for the [`service_gesture`] reason: the
/// per-socket loop cannot be driven without a WebSocket client, a function can.
fn service_dev_fault(text: &str, dev_fault: Option<&Arc<AtomicBool>>) -> Option<bool> {
    if text != DEV_FAULT_FRAME {
        return None;
    }
    match dev_fault {
        Some(flag) => {
            flag.store(true, Ordering::Release);
            Some(true)
        }
        None => Some(false),
    }
}

/// The dev host's hold switch: an inbound TEXT frame whose whole text is this word sets the
/// flag `SimLoop::with_dev_hold` reads at the top of `step()`, so a live check can put a POST
/// and a control message in front of the sim at once. Honoured ONLY when the router was built
/// with a flag ([`render_ws_router`]'s `dev_hold`), which only `dev_render_server` does;
/// otherwise the frame is dropped like a malformed control frame. It never reaches
/// [`decode_control`], so `ControlMsg` and the frontend's control kinds are unchanged and the
/// Tauri shell has no path to it.
pub const DEV_HOLD_FRAME: &str = "dev_hold";

/// Decide ONE inbound TEXT frame against the dev hold switch: `None` when the frame is not
/// [`DEV_HOLD_FRAME`] (the caller goes on to the query and control grammars), `Some(true)` when
/// it is and the flag was set, `Some(false)` when it is and this router holds no switch (the
/// frame is dropped).
fn service_dev_hold(text: &str, dev_hold: Option<&Arc<AtomicBool>>) -> Option<bool> {
    if text != DEV_HOLD_FRAME {
        return None;
    }
    match dev_hold {
        Some(flag) => {
            flag.store(true, Ordering::Release);
            Some(true)
        }
        None => Some(false),
    }
}

/// The bounded capacity of the per-socket outbound config-query REPLY channel
/// (threat T-40-05-UNBOUNDED). A frozen sim behind an UNbounded reply channel is a
/// DoS (the 38-review F2 lesson); this caps queued replies so a flood of query
/// frames can never grow memory without bound. A full channel drops the reply
/// (try_send) rather than blocking the diff-forwarding relay.
pub const REPLY_CHANNEL_CAPACITY: usize = 32;

/// The TEXT-frame prefix that marks a config-query REQUEST (vs a bare control
/// frame). A query frame is `query\n<json>`; the control grammar
/// ([`decode_control`]) is the newline line-grammar with NO leading `query\n`, so
/// the two never collide. Kept dependency-free + tiny so 40-05's TS side encodes it
/// with one `JSON.stringify`.
pub const QUERY_FRAME_PREFIX: &str = "query\n";

/// An inbound config-query REQUEST frame (dev harness → host), decoded behind a
/// `Result` — the ephemeral dev-transport request shape (NOT a serialized snapshot/
/// command/edit; the COMMIT still rides the certified [`GridCommand::Configure`]).
/// `reqId` correlates the reply; `verb` selects which [`ControlMsg::Query*`] the
/// SAME tick-boundary oneshot seam the Tauri path uses (39-06) is minted for.
#[derive(serde::Deserialize)]
pub struct QueryRequest {
    /// The frontend-allocated correlation id echoed back on the reply.
    #[serde(rename = "reqId")]
    pub req_id: u64,
    /// `machine_config` | `webhook_url` | `validate_factory_js` | `loaded_scene`.
    pub verb: String,
    /// The verb args (`node` for the reads, `source` for the JS pre-check).
    #[serde(default)]
    pub args: QueryArgs,
}

/// The union of config-query args (all optional; the verb selects which apply).
#[derive(serde::Deserialize, Default)]
pub struct QueryArgs {
    /// The dense render handle for `machine_config` / `webhook_url`.
    #[serde(default)]
    pub node: Option<u64>,
    /// The candidate Factory JS for `validate_factory_js`.
    #[serde(default)]
    pub source: Option<String>,
}

/// Decode a config-query REQUEST frame behind a `Result` — NEVER a panic (mirrors
/// [`decode_control`] / [`decode_gesture`]). Size-capped by [`MAX_CONTROL_FRAME`]
/// BEFORE the `serde_json` parse (threat T-40-05-MALFORM: drop-and-stay-alive on a
/// malformed/oversized frame). A frame without the [`QUERY_FRAME_PREFIX`], oversized,
/// or with invalid JSON is a typed [`CommandError::Malformed`].
///
/// # Errors
/// [`CommandError::Malformed`] if the frame is oversized, unprefixed, or invalid JSON.
pub fn decode_query(text: &str) -> Result<QueryRequest, CommandError> {
    if text.len() > MAX_CONTROL_FRAME {
        return Err(CommandError::Malformed);
    }
    let body = text
        .strip_prefix(QUERY_FRAME_PREFIX)
        .ok_or(CommandError::Malformed)?;
    serde_json::from_str::<QueryRequest>(body).map_err(|_| CommandError::Malformed)
}

/// The config-query REPLY envelope (host → dev harness), correlated by `reqId`. On
/// success `value` carries the JSON payload (`ConfigView` / URL string / `null`);
/// on failure `error` carries the reason. The reply is BOUNDED (`serde_json` of a
/// small shape) and never echoes untrusted bytes unbounded (threat T-40-05-UNBOUNDED).
#[derive(serde::Serialize)]
struct QueryReply {
    #[serde(rename = "reqId")]
    req_id: u64,
    ok: bool,
    value: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

/// Build an `ok` reply frame carrying `value` (never panics; a serialize failure
/// degrades to an empty frame the frontend simply ignores).
fn ok_reply(req_id: u64, value: Value) -> String {
    serde_json::to_string(&QueryReply {
        req_id,
        ok: true,
        value,
        error: None,
    })
    .unwrap_or_default()
}

/// Build an `error` reply frame carrying `msg`.
fn err_reply(req_id: u64, msg: &str) -> String {
    serde_json::to_string(&QueryReply {
        req_id,
        ok: false,
        value: Value::Null,
        error: Some(msg.to_owned()),
    })
    .unwrap_or_default()
}

/// Encode an optional [`MachineConfig`] as its `kind`-tagged JSON value (or `null`
/// for a non-configurable / unmapped node).
fn config_value(cfg: Option<MachineConfig>) -> Value {
    match cfg {
        Some(c) => serde_json::to_value(ConfigView::from(c)).unwrap_or(Value::Null),
        None => Value::Null,
    }
}

/// The `kind` discriminator every refusal [`VerdictFrame`] carries. The TypeScript side
/// exports the SAME literal as `GESTURE_REFUSAL_KIND` in
/// `frontend/src/transport/transport.ts`; the two must not drift.
///
/// `pub` since the Tauri gesture-verdict redesign: `fabrico-app` stamps the SAME
/// discriminator onto the refusal it pushes down its verdict `Channel`, so the two
/// transports carry one frame shape and the frontend parses them with one function.
/// A second literal spelled out in the app crate is exactly the kind of quiet drift
/// that turns one transport's refusal into the other transport's silence.
pub const GESTURE_REFUSAL_KIND: &str = "gestureRefused";

/// The `kind` discriminator of an ACCEPT verdict (phase 88, D-06): the gesture folded, and the
/// frame names the handles it minted. The TypeScript side exports the SAME literal as
/// `GESTURE_ACCEPT_KIND` in `frontend/src/transport/transport.ts`, and
/// `command_error_view::the_frontend_gesture_accept_kind_matches_this_crates_wire_kind` compares
/// the two, so a rename on one side alone reddens.
pub const GESTURE_ACCEPT_KIND: &str = "gestureAccepted";

/// The `kind` discriminator of a DISCARD verdict (phase 88, D-05, D-06): a board swap dropped
/// the gesture before it folded. Mirrored as `GESTURE_DISCARD_KIND` in `transport.ts`, pinned by
/// `command_error_view::the_frontend_gesture_discard_kind_matches_this_crates_wire_kind`.
pub const GESTURE_DISCARD_KIND: &str = "gestureDiscarded";

/// The `kind` discriminator every [`LoadRefusedFrame`] carries. The TypeScript side
/// exports the SAME literal as `LOAD_REFUSAL_KIND` in
/// `frontend/src/transport/transport.ts`; the two must not drift.
///
/// That is a CHECK and not a comment:
/// `command_error_view::the_frontend_load_refusal_kind_matches_this_crates_wire_kind`
/// `include_str!`s the TypeScript file and compares the two literals, so renaming
/// either side alone reddens.
pub const LOAD_REFUSAL_KIND: &str = "loadRefused";

/// How many undelivered load-refusal frames the fan-out holds before the oldest is
/// dropped. A load refusal is a rare, user-initiated event (one per Open of an
/// unreadable file), so a small bound is generous; what it buys is that the channel can
/// never grow without bound if a socket stops reading.
const LOAD_REFUSAL_CHANNEL_CAPACITY: usize = 16;

/// The fan-out the sim thread pushes a load refusal onto, and every live WebSocket
/// connection subscribes to (UNDO-09).
///
/// A BROADCAST rather than the per-socket [`mpsc::Sender<String>`] the gesture refusal
/// uses, and the difference is structural rather than stylistic: a gesture arrives ON a
/// socket, so its verdict has an obvious return address, whereas
/// [`ControlMsg::Load`](crate::sim_loop::ControlMsg::Load) carries no reply channel at
/// all and is serviced on the sim thread with no memory of who asked. Every connected
/// webview is showing the same board, so every connected webview is the right audience.
pub type LoadRefusalTx = broadcast::Sender<String>;

/// Build the fan-out half of the load-refusal path: the sender the sim-thread sink
/// pushes onto, ready to be handed to [`render_ws_router`] / [`run_render_listener`].
#[must_use]
pub fn load_refusal_channel() -> LoadRefusalTx {
    broadcast::channel::<String>(LOAD_REFUSAL_CHANNEL_CAPACITY).0
}

/// The LOAD-REFUSAL frame (host -> dev harness, UNDO-09): the host's own
/// [`ProjectError`](crate::project::ProjectError) `Display` sentence, carried to a
/// screen for the first time.
///
/// # What carries over from the gesture refusal frame, and the ONE property that does not
/// Carried over: there is no request id, for the reason spelled out on `VerdictFrame`
/// (the frontend's config-query resolver keys on `reqId` alone and would resolve an
/// unrelated in-flight query, T-64-05-01); and `kind` exists because the resolver
/// returns `false` for an unrecognised frame with NO console warning and no else
/// branch, so an untagged frame is swallowed in complete silence.
///
/// **NOT carried over, and this is the whole point of a second frame.** The gesture refusal
/// is PAYLOAD-FREE BY DESIGN: "no filesystem path, node handle, internal index or host
/// `Display` string can ride this frame" (T-64-05-02), and `RefusalMessage.tsx` renders
/// only the 18 authored sentences its closed `Record` holds. This frame DELIBERATELY
/// carries exactly such a host `Display` string, because UNDO-09's requirement is the
/// reason "in the words the host already wrote". The two frames must therefore never be
/// merged on the assumption that the payload-free property is shared.
///
/// What replaces that property as the guarantee is a test, not a shape:
/// `crates/fabrico-host/tests/project_error_copy.rs` constructs every `ProjectError`
/// variant through a compiler-checked exhaustive match and asserts that no arm renders a
/// debug payload and that no variant produced from a load of a known path ever contains
/// that path (threat T-73-04-01, T-32-06-01 applied to a new surface).
#[derive(serde::Serialize)]
struct LoadRefusedFrame {
    /// Always [`LOAD_REFUSAL_KIND`] - the discriminator, see above.
    kind: &'static str,
    /// The host's `ProjectError` `Display` sentence, verbatim. The frontend renders it
    /// without re-authoring it.
    reason: String,
}

/// Build a load-refusal frame (never panics; a serialize failure degrades to an empty
/// frame the frontend's reject-only parser simply ignores - the [`refusal_frame`]
/// idiom).
#[must_use]
pub fn load_refused_frame(reason: &str) -> String {
    serde_json::to_string(&LoadRefusedFrame {
        kind: LOAD_REFUSAL_KIND,
        reason: reason.to_owned(),
    })
    .unwrap_or_default()
}

/// The `kind` discriminator of a SAVE-FAILURE frame (phase 90 review WR-A-03): the host could
/// not write a Save the page sent (a disk error, or a drain out of budget with an effect still in
/// flight). Mirrored as `SAVE_FAILURE_KIND` in `frontend/src/transport/transport.ts`, pinned by
/// `command_error_view::the_frontend_save_failure_kind_matches_this_crates_wire_kind`.
///
/// It rides the LOAD-REFUSAL fan-out on this transport (and the load-refusal `Channel` on the
/// Tauri one): both are out-of-band host announcements of a file operation that did not happen,
/// with no return address, and the distinct `kind` keeps the two grammars apart on the page.
pub const SAVE_FAILURE_KIND: &str = "saveFailed";

/// Build a save-failure frame: `{"kind":"saveFailed","reason":<the host's sentence>}`, the
/// [`load_refused_frame`] shape under its own kind. The page shows only `Save failed` in its
/// status line; the reason is carried for parity with the load refusal and is not rendered.
#[must_use]
pub fn save_failed_frame(reason: &str) -> String {
    serde_json::to_string(&LoadRefusedFrame {
        kind: SAVE_FAILURE_KIND,
        reason: reason.to_owned(),
    })
    .unwrap_or_default()
}

/// The `kind` discriminator every [`SimFatalFrame`] carries (phase 90, FAIL-01, D-11). The
/// TypeScript side exports the SAME literal as `SIM_FATAL_KIND` in
/// `frontend/src/transport/transport.ts`; the two must not drift.
///
/// That is a CHECK and not a comment:
/// `command_error_view::the_frontend_sim_fatal_kind_matches_this_crates_wire_kind`
/// `include_str!`s the TypeScript file and compares the two literals, so renaming either
/// side alone reddens.
pub const SIM_FATAL_KIND: &str = "simFatal";

/// The SIM-FATAL frame (host -> dev harness, FAIL-01, D-11): the sim loop ended and will not
/// come back, with the host's one reason sentence
/// ([`fatal_reason`](crate::sim_fatal::fatal_reason)).
///
/// Like [`LoadRefusedFrame`] it carries a host `Display` string on purpose (the stopped card
/// shows it, plan 90-07) and no request id. Unlike a load refusal it is not a point-in-time
/// announcement: the dev host HOLDS the reason in a `watch`, and every socket is sent it after
/// its opening keyframe and again on change, so a page that connects or reloads after the
/// fatal still learns of it ([`render_ws_router`]'s `sim_fatal`).
#[derive(serde::Serialize)]
struct SimFatalFrame {
    /// Always [`SIM_FATAL_KIND`].
    kind: &'static str,
    /// The host's reason sentence, verbatim.
    reason: String,
}

/// Build a sim-fatal frame (never panics; a serialize failure degrades to an empty frame the
/// frontend's reject-only parser ignores, the [`load_refused_frame`] idiom).
#[must_use]
pub fn sim_fatal_frame(reason: &str) -> String {
    serde_json::to_string(&SimFatalFrame {
        kind: SIM_FATAL_KIND,
        reason: reason.to_owned(),
    })
    .unwrap_or_default()
}

/// The frame a socket is sent for the held fatal reason, if any (phase 90, D-11): `Some` when
/// the watch holds a reason, `None` before the sim has stopped. Read after the opening keyframe
/// and on every change, so the decision lives in one function the tests can call.
///
/// The read MARKS the value seen (`borrow_and_update`, phase 90 review IN-A-03), so a reason
/// raised between the socket's subscribe and its opening read is sent once, by that read, and
/// the change arm does not send it again. Before, the opening read was `mark_unchanged` and
/// then a plain `borrow`, and a raise between the two was sent twice.
fn held_sim_fatal_frame(sim_fatal: &mut watch::Receiver<Option<String>>) -> Option<String> {
    sim_fatal.borrow_and_update().as_deref().map(sim_fatal_frame)
}

/// Service ONE inbound BINARY gesture frame: decode its header and body, and hand the
/// envelope to the drain with this connection's [`VerdictSink`] attached, so exactly one
/// verdict comes home on `verdict_tx` (phase 88, D-06).
///
/// # Why this is a function and not inline in the `select` arm
/// The same reason [`service_query`] is: the per-socket loop is untestable without a
/// live WebSocket client (which would be a new dev-dependency, and this phase adds
/// ZERO packages), while a function can be driven directly.
///
/// # No counter, and no task per gesture (phase 88, D-06)
/// Until plan 88-03 each socket counted the frames it received and a refusal named that
/// count, which the client had to match by counting its own sends; and each gesture spawned
/// a task that awaited its oneshot reply and wrote only a refusal. The client now names each
/// gesture in the frame header, and the drain answers through the sink on this connection's
/// one verdict channel, which the select loop drains. Nothing waits per gesture.
fn service_gesture(bytes: &[u8], gesture_tx: &GestureTx, verdict_tx: &VerdictTx) {
    match decode_gesture(bytes) {
        Ok(decoded) => {
            // If the send fails the sim is gone and no verdict will ever come. The socket
            // stays alive and says nothing.
            let _ = gesture_tx.send(wire_envelope(decoded, verdict_tx));
        }
        // Malformed/oversized is itself a refusal the user should SEE, answered INLINE -
        // no sim round trip. It names the gesture id when the header read and the body did
        // not, and nothing when the header itself could not be read. An undecodable frame
        // names no command either: neither `cmd` nor `node` rides it.
        Err(reject) => {
            let _ = verdict_tx.send(VerdictFrame::refused(reject.gesture_id, reject.error.into(), None));
        }
    }
}

/// Service ONE config-query request off the relay's `select` loop (spawned so the
/// diff-forwarding arm NEVER blocks on the oneshot, RESEARCH Anti-Pattern). A pure
/// forwarder: it re-frames the request onto the SAME [`ControlMsg::Query*`] +
/// `oneshot` tick-boundary seam the Tauri host uses (39-06), awaits the reply,
/// `serde_json`-encodes it, and `try_send`s it through the BOUNDED per-socket reply
/// channel (drop-safe on a full/closed channel). It NEVER touches the `!Send` Host,
/// enqueues no logged event, and mutates no serialized state (READ/validate only).
async fn service_query(
    req: QueryRequest,
    control_tx: ControlTx,
    webhook_addr: Option<SocketAddr>,
    reply_tx: mpsc::Sender<String>,
) {
    let req_id = req.req_id;
    let reply = match req.verb.as_str() {
        "machine_config" => match req.args.node {
            Some(node) => {
                let (tx, rx) = oneshot::channel();
                if control_tx
                    .send(ControlMsg::QueryConfig { node, reply: tx })
                    .is_err()
                {
                    err_reply(req_id, "sim unavailable")
                } else {
                    match rx.await {
                        Ok(cfg) => ok_reply(req_id, config_value(cfg)),
                        Err(_) => err_reply(req_id, "sim dropped the query"),
                    }
                }
            }
            None => err_reply(req_id, "machine_config requires a node handle"),
        },
        "webhook_url" => match (req.args.node, webhook_addr) {
            (Some(node), Some(addr)) => {
                let (tx, rx) = oneshot::channel();
                if control_tx
                    .send(ControlMsg::QueryWebhookUrl {
                        node,
                        addr,
                        reply: tx,
                    })
                    .is_err()
                {
                    err_reply(req_id, "sim unavailable")
                } else {
                    match rx.await {
                        Ok(url) => ok_reply(req_id, url.map_or(Value::Null, Value::String)),
                        Err(_) => err_reply(req_id, "sim dropped the query"),
                    }
                }
            }
            (None, _) => err_reply(req_id, "webhook_url requires a node handle"),
            (_, None) => err_reply(req_id, "webhook address unavailable"),
        },
        "validate_factory_js" => match req.args.source {
            Some(source) => {
                let (tx, rx) = oneshot::channel();
                if control_tx
                    .send(ControlMsg::ValidateFactoryJs { source, reply: tx })
                    .is_err()
                {
                    err_reply(req_id, "sim unavailable")
                } else {
                    match rx.await {
                        Ok(Ok(())) => ok_reply(req_id, Value::Null),
                        Ok(Err(msg)) => err_reply(req_id, &msg),
                        Err(_) => err_reply(req_id, "sim dropped the query"),
                    }
                }
            }
            None => err_reply(req_id, "validate_factory_js requires source"),
        },
        // WR-03: which SHIPPED scene the host currently holds (`"demo_scene"` /
        // `"order_processing"`), or JSON `null` for a user board. Takes NO args, so
        // there is no untrusted input to echo. The frontend re-derives its scene
        // badge from this on mount, instead of guessing from a click it may not
        // have made (a webview reload loses that local state; the host does not).
        "loaded_scene" => {
            let (tx, rx) = oneshot::channel();
            if control_tx.send(ControlMsg::QueryScene { reply: tx }).is_err() {
                err_reply(req_id, "sim unavailable")
            } else {
                match rx.await {
                    Ok(id) => ok_reply(
                        req_id,
                        id.map_or(Value::Null, |i| Value::String(i.wire_id().to_owned())),
                    ),
                    Err(_) => err_reply(req_id, "sim dropped the query"),
                }
            }
        }
        _ => err_reply(req_id, "unknown query verb"),
    };
    // Drop-safe: a full (bounded) or closed reply channel drops this reply rather
    // than blocking or growing unbounded (threat T-40-05-UNBOUNDED). The relay's
    // reply arm drains promptly, so the cap is never hit in normal use.
    let _ = reply_tx.try_send(reply);
}

/// A transport's live render subscription — the producer's latest-keyframe `watch`
/// receiver + a per-tick-diff `broadcast` receiver (W2). Built from
/// [`RenderProducer::subscribe`]; each WebSocket connection gets its own fresh
/// receivers ([`Clone`] resubscribes the broadcast so a new connection starts from
/// the keyframe, then live diffs).
pub struct RenderSubscription {
    /// The latest full keyframe bytes — a new connection's resync point.
    keyframe_rx: watch::Receiver<RenderFrame>,
    /// The live per-tick diff bytes.
    diff_rx: broadcast::Receiver<RenderFrame>,
}

impl RenderSubscription {
    /// Subscribe to a [`RenderProducer`] (the W2 fan-out). The producer stays the
    /// single owner of the bytes; this is a read-only subscription.
    #[must_use]
    pub fn from_producer(producer: &RenderProducer) -> Self {
        let (keyframe_rx, diff_rx) = producer.subscribe();
        Self {
            keyframe_rx,
            diff_rx,
        }
    }

    /// Build a subscription directly from a `(keyframe watch, diff broadcast)` handle
    /// pair — exactly what [`RenderProducer::subscribe`] (and `SimLoop::subscribe`)
    /// returns. The dev render server needs this AFTER the producer has moved into
    /// `SimLoop`, when no `&RenderProducer` is in scope for [`from_producer`]
    /// (Pitfall 3); the struct's two fields ARE this pair.
    #[must_use]
    pub fn from_handles(
        keyframe_rx: watch::Receiver<RenderFrame>,
        diff_rx: broadcast::Receiver<RenderFrame>,
    ) -> Self {
        Self {
            keyframe_rx,
            diff_rx,
        }
    }
}

impl Clone for RenderSubscription {
    /// A fresh per-connection subscription: clone the keyframe watch and
    /// `resubscribe` the diff broadcast (a new receiver that yields diffs sent AFTER
    /// this point — the connection resyncs from the keyframe first, so no gap).
    fn clone(&self) -> Self {
        Self {
            keyframe_rx: self.keyframe_rx.clone(),
            diff_rx: self.diff_rx.resubscribe(),
        }
    }
}

/// Shared handler state: the render subscription (bytes out) + the gesture sink
/// (BINARY gestures in) + the control sink (TEXT control frames in). All cheap to
/// clone (channel handles).
#[derive(Clone)]
struct RenderWsState {
    sub: RenderSubscription,
    gesture_tx: GestureTx,
    control_tx: ControlTx,
    /// The bound webhook [`SocketAddr`], threaded so a `webhook_url` config-query can
    /// mint [`ControlMsg::QueryWebhookUrl`] with the SAME port the Tauri path uses.
    /// `None` when the dev harness has no bound webhook listener (a `webhook_url`
    /// query then replies with a typed "webhook address unavailable").
    webhook_addr: Option<SocketAddr>,
    /// The load-refusal fan-out (UNDO-09). Held as the SENDER rather than a receiver so
    /// each connection `subscribe()`s its own, and so the channel can never read
    /// `Closed` while the router is alive.
    load_refusals: LoadRefusalTx,
    /// The dev fault switch (phase 90, D-13): `Some` only in `dev_render_server`, which
    /// shares this flag with `SimLoop::with_dev_fault`. `None` drops [`DEV_FAULT_FRAME`].
    dev_fault: Option<Arc<AtomicBool>>,
    /// The dev hold switch: `Some` only in `dev_render_server`, which shares this flag with
    /// `SimLoop::with_dev_hold`. `None` drops [`DEV_HOLD_FRAME`].
    dev_hold: Option<Arc<AtomicBool>>,
    /// The held fatal reason (phase 90, D-11): `None` while the sim runs, `Some(reason)` once
    /// its loop has ended. Each connection clones it, sends the held reason after its opening
    /// keyframe and again on every change.
    sim_fatal: watch::Receiver<Option<String>>,
}

/// One inbound gesture frame, read (phase 88, D-02, D-06): the header's two fields and the
/// body they precede.
#[derive(Clone, Debug, PartialEq)]
pub struct DecodedGesture {
    /// The board generation of the render packet the client read this gesture's handles
    /// from (`RenderPacket.generation`, echoed by the client).
    pub generation: u64,
    /// The client's own id for this gesture, monotonic per page load. The verdict on this
    /// gesture carries it back as `seq`, so the client can pair the answer with the gesture.
    pub gesture_id: u64,
    /// The body: a `GridCommand` or a run-pace frame, byte-identical to what it always was.
    pub frame: GestureFrame,
}

/// Why a gesture frame could not be decoded (phase 88, D-06): the typed refusal, and the
/// client's gesture id when the HEADER was read and only the body failed. `None` means the
/// header itself was unreadable, so the frame names no gesture and its refusal carries no
/// `seq`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GestureDecodeError {
    /// The gesture id read off the header, or `None` if the header could not be read.
    pub gesture_id: Option<u64>,
    /// The refusal: always [`CommandError::Malformed`] today, a frame the host cannot read.
    pub error: CommandError,
}

/// Decode an inbound gesture frame behind a `Result` - NEVER a panic (mirrors
/// `event::upcast`), and the ONE decoder both transports call (`fabrico-app`'s
/// `enqueue_gesture` is the other caller).
///
/// # The frame (phase 88, D-02, D-06; version byte, security T-88-09)
/// `[version byte][varint generation][varint gesture id][body]`. The header is read FIRST,
/// under the existing [`MAX_GESTURE_FRAME`] cap (threat T-07-DOS-BODY): the version byte,
/// which must be [`GESTURE_FRAME_VERSION`], then two LEB128 unsigned varints of at most ten
/// bytes each whose values fit in a `u64`. Only then is the body read, exactly as it always
/// was ([`decode_gesture_body`]). The header sits OUTSIDE the body, so no `GridCommand` byte
/// moved and the `gridcommand.bin` goldens did not move.
///
/// # Errors
/// [`GestureDecodeError`] with `gesture_id: None` for a frame over the cap, an empty frame,
/// a first byte that is not [`GESTURE_FRAME_VERSION`] (a page on an older wire), or a
/// header varint that is truncated, longer than ten bytes or past `u64`; with
/// `gesture_id: Some(id)` for a readable header over a body that does not decode. The
/// refusal is [`CommandError::Malformed`] either way.
pub fn decode_gesture(bytes: &[u8]) -> Result<DecodedGesture, GestureDecodeError> {
    let unreadable = GestureDecodeError {
        gesture_id: None,
        error: CommandError::Malformed,
    };
    if bytes.len() > MAX_GESTURE_FRAME {
        return Err(unreadable);
    }
    // The version byte first: a frame without it is from a page on an older wire, and
    // reading its bytes as a header would read a different gesture (T-88-09).
    let Some((&GESTURE_FRAME_VERSION, header)) = bytes.split_first() else {
        return Err(unreadable);
    };
    let (generation, rest) = read_header_varint(header).ok_or(unreadable)?;
    let (gesture_id, body) = read_header_varint(rest).ok_or(unreadable)?;
    let frame = decode_gesture_body(body).map_err(|error| GestureDecodeError {
        gesture_id: Some(gesture_id),
        error,
    })?;
    Ok(DecodedGesture {
        generation,
        gesture_id,
        frame,
    })
}

/// Read ONE header field: a LEB128 unsigned varint of at most ten bytes whose value fits
/// in a `u64`, returning it and the bytes after it, or `None` if it is absent, truncated,
/// longer than ten bytes or past `u64` (a tenth byte above 1). Bounded by construction:
/// at most ten shifts, so a hostile all-continuation-bit frame cannot spin.
fn read_header_varint(bytes: &[u8]) -> Option<(u64, &[u8])> {
    let mut out: u64 = 0;
    for (i, &byte) in bytes.iter().take(10).enumerate() {
        let low = u64::from(byte & 0x7f);
        // The tenth byte carries bit 63 alone; anything above 1 there is past `u64`.
        if i == 9 && low > 1 {
            return None;
        }
        out |= low << (7 * i);
        if byte & 0x80 == 0 {
            return Some((out, &bytes[i + 1..]));
        }
    }
    None
}

/// Write the gesture header in front of `body` (the version byte, then the two varints):
/// the exact inverse of [`decode_gesture`]'s header read, and the Rust mirror of `encodeGestureFrame` in
/// `frontend/src/protocol/decode.ts` (phase 88, D-02, D-06). The host never sends a gesture;
/// the tests that drive the real decoder build their frames with this, so a test frame and
/// a browser frame are one grammar.
#[must_use]
pub fn frame_gesture(generation: u64, gesture_id: u64, body: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(body.len() + 5);
    out.push(GESTURE_FRAME_VERSION);
    for mut v in [generation, gesture_id] {
        while v >= 0x80 {
            out.push((v as u8 & 0x7f) | 0x80);
            v >>= 7;
        }
        out.push(v as u8);
    }
    out.extend_from_slice(body);
    out
}

/// The envelope a transport hands the drain for one decoded gesture (phase 88): the body,
/// the generation the client read its handles under, and a [`VerdictSink`] that answers on
/// `verdict_tx` by the client's gesture id. ONE builder for both transports, so neither can
/// forget the generation or the answer.
#[must_use]
pub fn wire_envelope(decoded: DecodedGesture, verdict_tx: &VerdictTx) -> GestureEnvelope {
    let subject = decoded.frame.subject();
    GestureEnvelope {
        cmd: decoded.frame,
        generation: Some(decoded.generation),
        verdict: Some(VerdictSink::new(decoded.gesture_id, subject, verdict_tx.clone())),
    }
}

/// Decode one gesture BODY (the bytes after the header) into a [`GestureFrame`] behind a
/// `Result` - NEVER a panic. One that fails to `postcard`-decode is a typed
/// [`CommandError::Malformed`]; the transport answers it and keeps the socket alive
/// (threat T-07-DOS-BODY). The size cap is [`decode_gesture`]'s, applied to the whole frame.
///
/// # The `0xFE` sentinel (D-68-16, route R1), and why it cannot collide
/// A lead byte of `0xFE` routes the REST of the frame to the [`BeltRunPace`] body
/// decode; ANY other lead byte takes the `postcard::from_bytes::<GridCommand>` path
/// over the WHOLE slice, completely unchanged - so every frame the app has ever sent
/// is byte-identical and no shipped encoding moved.
///
/// `GridCommand`'s discriminants occupy `0..=11` (Place=0 through Unlink=11) and the
/// enum is FROZEN for this milestone, so 254 names no variant and can name none.
/// That claim keeps a live check behind it:
/// `crates/fabrico-app/src/lib.rs`'s `a_malformed_gesture_consumes_a_sequence_number_and_is_answered`
/// asserts that `0xFF` is still rejected as an invalid frame, and that a bare `0xFE`
/// with no body is rejected too.
///
/// An EMPTY slice is [`CommandError::Malformed`], never an index panic: the length
/// check below runs before the byte-0 peek.
///
/// # Errors
/// [`CommandError::Malformed`] if the body is empty, declares more than
/// [`MAX_RUN_PACE_BELTS`] belts, or is not a valid `GridCommand` / run-pace body.
fn decode_gesture_body(bytes: &[u8]) -> Result<GestureFrame, CommandError> {
    // An empty body has no byte 0 to peek at. Typed reject, never `bytes[0]`.
    let Some(&lead) = bytes.first() else {
        return Err(CommandError::Malformed);
    };
    if lead == BELT_RUN_PACE_LEAD {
        let body = &bytes[1..];
        // REFUSE BEFORE ALLOCATING (threat T-68-02-01). The body's leading varint is
        // the `Vec<u64>` length, and a forged one is refused HERE, before postcard is
        // asked to build a sequence for it. `apply_gesture_frame` re-checks the
        // DECODED length as well, so the bound holds even for a caller that reaches
        // the fan-out by another route.
        let declared = peek_varint_u64(body).ok_or(CommandError::Malformed)?;
        if declared > MAX_RUN_PACE_BELTS as u64 {
            return Err(CommandError::Malformed);
        }
        let run = postcard::from_bytes::<BeltRunPace>(body).map_err(|_| CommandError::Malformed)?;
        return Ok(GestureFrame::RunPace(run));
    }
    postcard::from_bytes::<GridCommand>(bytes)
        .map(GestureFrame::Cmd)
        .map_err(|_| CommandError::Malformed)
}

/// Read the LEB128 unsigned varint at the head of `bytes` WITHOUT allocating, or
/// `None` if it is absent, truncated, or over-long for a `u64`.
///
/// Bounded by construction: at most ten shifts, so a hostile all-continuation-bit
/// frame cannot spin. Used only for the pre-allocation length refusal above; the
/// authoritative decode is still postcard's.
fn peek_varint_u64(bytes: &[u8]) -> Option<u64> {
    let mut out: u64 = 0;
    for (i, byte) in bytes.iter().take(10).enumerate() {
        out |= u64::from(byte & 0x7f) << (7 * i);
        if byte & 0x80 == 0 {
            return Some(out);
        }
    }
    None
}

/// Whether a WebSocket upgrade's `Origin` may open the dev render socket (phase 90 review
/// IN-A-04). The socket binds loopback only (T-07-EXPOSE), but any web page open in the
/// developer's browser could still open `ws://127.0.0.1:8787/render` and send `dev_fault`, or
/// a Save or Load with a path of its choosing. So a page must be served from this machine's
/// loopback (`localhost`, `127.0.0.1` or `[::1]`, any port: the Vite dev server). A request
/// with NO `Origin` passes: browsers always send one on a WebSocket upgrade, and its absence
/// is a non-browser client on this machine (Node's `WebSocket`, which the live specs' fault
/// switch uses, measured to send none). `null` (a sandboxed or `file:` page) is refused.
fn origin_allowed(origin: Option<&str>) -> bool {
    let Some(origin) = origin else {
        return true;
    };
    let Some(authority) = origin.strip_prefix("http://").or_else(|| origin.strip_prefix("https://")) else {
        return false;
    };
    let host = match authority.rsplit_once(':') {
        Some((host, port)) if !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()) => host,
        _ => authority,
    };
    matches!(host, "localhost" | "127.0.0.1" | "[::1]")
}

/// `GET /render`: upgrade to a WebSocket and run the per-connection relay. The
/// inbound frame size is capped at [`MAX_GESTURE_FRAME`] before the upgrade buffers
/// it (threat T-07-DOS-BODY). An upgrade from a page that is not on loopback is refused with
/// a 403 before anything else ([`origin_allowed`]).
async fn render_ws(
    headers: axum::http::HeaderMap,
    State(state): State<RenderWsState>,
    ws: Result<WebSocketUpgrade, axum::extract::ws::rejection::WebSocketUpgradeRejection>,
) -> Response {
    use axum::response::IntoResponse;
    let origin = headers.get(axum::http::header::ORIGIN).map(|v| v.to_str().unwrap_or("\u{0}"));
    if !origin_allowed(origin) {
        return axum::http::StatusCode::FORBIDDEN.into_response();
    }
    let ws = match ws {
        Ok(ws) => ws,
        Err(rejection) => return rejection.into_response(),
    };
    ws.max_message_size(MAX_GESTURE_FRAME)
        .max_frame_size(MAX_GESTURE_FRAME)
        .on_upgrade(move |socket| handle_socket(socket, state))
}

/// The per-connection relay: send the current keyframe, then forward each diff OUT
/// and decode+forward each gesture IN, until either side closes. Never panics on an
/// untrusted inbound frame (decode is behind a `Result`).
async fn handle_socket(mut socket: WebSocket, state: RenderWsState) {
    let mut keyframe_rx = state.sub.keyframe_rx.clone();
    let mut diff_rx = state.sub.diff_rx.resubscribe();

    // The BOUNDED per-socket outbound config-query reply channel (T-40-05-UNBOUNDED):
    // a spawned `service_query` awaits the tick-boundary oneshot OFF this loop and
    // `try_send`s the encoded reply here, so the diff-forwarding arm never blocks on
    // a query. `reply_tx` stays owned here (clones go to the spawns), so `recv`
    // never yields `None` while the connection is alive.
    let (reply_tx, mut reply_rx) = mpsc::channel::<String>(REPLY_CHANNEL_CAPACITY);

    // Phase 88 (D-06): this connection's ONE verdict channel. Every gesture decoded on this
    // socket carries a sink on it, the drain answers each exactly once, and the arm below
    // writes each answer as a TEXT frame. Unbounded, and never `try_send`-dropped as the
    // 32-slot query channel is: one verdict per frame received, so it grows no faster than
    // the unbounded gesture channel it mirrors (T-88-07), and a resume burst of accepts
    // cannot overflow it. `verdict_tx` stays owned here, so `recv` never yields `None`
    // while the connection is alive. A verdict reaches only the socket that sent its gesture.
    let (verdict_tx, mut verdict_rx) = crate::gesture_verdict::verdict_channel();

    // UNDO-09: this connection's view of the load-refusal fan-out. Subscribed here
    // rather than shared, so a slow connection's lag cannot stall any other.
    let mut load_refusal_rx = state.load_refusals.subscribe();

    // On connect: send the latest keyframe so the renderer has a full frame to
    // resync from (skip an empty initial keyframe — nothing produced yet).
    // The relay remembers which handle-table generation the client is on, so a later
    // lag knows whether it spanned a reset (plan 76-19 refuter round).
    let (mut relay, keyframe) = RenderRelay::open(&keyframe_rx.borrow_and_update());
    if !keyframe.is_empty() && socket.send(Message::Binary(keyframe.into())).await.is_err() {
        return;
    }

    // FAIL-01 (D-11): a sim that has already stopped says so right after the keyframe, so a
    // page that connects or reloads after the fatal still learns of it. The read marks the
    // reason seen in the same step, so the change arm below does not send it a second time.
    let mut sim_fatal_rx = state.sim_fatal.clone();
    if let Some(text) = held_sim_fatal_frame(&mut sim_fatal_rx)
        && socket.send(Message::Text(text.into())).await.is_err()
    {
        return;
    }
    // The change arm runs while the sender lives. Once every sender is gone `changed()` returns
    // `Err` at once and forever, so the arm is switched off rather than left to spin the select
    // (the hazard the load-refusal arm's `Closed => break` names); the relay itself goes on.
    let mut sim_fatal_live = true;

    loop {
        tokio::select! {
            // OUT: forward each queued config-query reply as a TEXT frame (the
            // request/reply seam, correlated by reqId on the TS side).
            reply = reply_rx.recv() => match reply {
                Some(text) => {
                    if socket.send(Message::Text(text.into())).await.is_err() {
                        break; // peer gone
                    }
                }
                // Only reachable if every sender dropped (connection tearing down).
                None => break,
            },
            // OUT: write each gesture VERDICT as a TEXT frame (phase 88, D-06): a refusal, an
            // accept naming the handles it minted, or a swap's discard.
            verdict = verdict_rx.recv() => match verdict {
                Some(frame) => {
                    if socket.send(Message::Text(frame.to_json().into())).await.is_err() {
                        break; // peer gone
                    }
                }
                // Only reachable if every sender dropped (connection tearing down).
                None => break,
            },
            // OUT: forward each LOAD REFUSAL as a TEXT frame (UNDO-09). Unlike a gesture
            // verdict this has no return address - `ControlMsg::Load` carries no reply
            // channel - so every connection showing this board is told.
            refusal = load_refusal_rx.recv() => match refusal {
                Ok(text) => {
                    if socket.send(Message::Text(text.into())).await.is_err() {
                        break; // peer gone
                    }
                }
                // A connection that lagged past the bounded fan-out lost a refusal. It is
                // NOT resent and the connection is NOT dropped: a refusal is a
                // point-in-time announcement with no keyframe to resync from, and there
                // is nothing honest to say about one that has already scrolled past.
                Err(broadcast::error::RecvError::Lagged(_)) => {}
                // Every sender dropped: the host is tearing down. Ends the relay exactly
                // as a closed diff broadcast does, and - load-bearing - stops this arm
                // from returning `Closed` forever and spinning the select.
                Err(broadcast::error::RecvError::Closed) => break,
            },
            // OUT: the held fatal reason on change (FAIL-01, D-11): the sim loop ended while
            // this socket was open.
            changed = sim_fatal_rx.changed(), if sim_fatal_live => match changed {
                Ok(()) => {
                    if let Some(text) = held_sim_fatal_frame(&mut sim_fatal_rx)
                        && socket.send(Message::Text(text.into())).await.is_err()
                    {
                        break; // peer gone
                    }
                }
                Err(_) => sim_fatal_live = false,
            },
            // OUT: forward each per-tick diff frame (identical producer bytes — W2).
            diff = diff_rx.recv() => match diff {
                Ok(frame) => {
                    // `None` is a frame at or below the keyframe a lag just resent (FAIL-05,
                    // D-09): the client already holds a newer scene, so it is not sent.
                    let Some(bytes) = relay.forward(frame) else {
                        continue;
                    };
                    if socket.send(Message::Binary(bytes.into())).await.is_err() {
                        break; // peer gone
                    }
                }
                // A slow connection lagged past the bounded broadcast: resync from
                // the latest keyframe rather than dropping the connection.
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    // 73-12 (73-REVIEW WR-01): TAGGED AS A RESYNC when the timeline did
                    // not move, so a client holding an unacknowledged port edit keeps its
                    // latch. Plan 76-19 refuter round: NOT tagged when a reset fell among
                    // the dropped frames, because then it is a restructure this client
                    // never saw. `RenderRelay::lagged` decides, shared with the Tauri
                    // transport so the two cannot drift.
                    let kf = relay.lagged(&keyframe_rx.borrow_and_update());
                    if !kf.is_empty() && socket.send(Message::Binary(kf.into())).await.is_err() {
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Closed) => break, // producer gone
            },
            // IN: decode a gesture (BINARY) or a control frame (TEXT) behind a
            // Result; forward valid, drop malformed. The handler NEVER touches Host —
            // it forwards a typed intent the sim thread services at the tick boundary.
            inbound = socket.recv() => match inbound {
                Some(Ok(Message::Binary(bytes))) => {
                    // Decodes the header and body; the drain answers through this
                    // connection's verdict channel, written by the arm above.
                    service_gesture(&bytes, &state.gesture_tx, &verdict_tx);
                }
                // Inbound TEXT is EITHER a config-query request (prefixed `query\n`)
                // OR a bare control frame (the newline line-grammar). Both decode
                // behind a Result (never unwrap), size-capped; a malformed/oversized
                // frame is a typed drop and the socket stays alive (T-40-05-MALFORM).
                Some(Ok(Message::Text(text))) => {
                    if service_dev_fault(&text, state.dev_fault.as_ref()).is_some() {
                        // The dev fault switch (D-13): set when this router holds one,
                        // dropped otherwise; never decoded as a control frame.
                    } else if service_dev_hold(&text, state.dev_hold.as_ref()).is_some() {
                        // The dev hold switch: the same rule as the fault switch above.
                    } else if text.starts_with(QUERY_FRAME_PREFIX) {
                        // A config-query: re-frame onto the SAME ControlMsg::Query*
                        // tick-boundary oneshot seam the Tauri path uses (39-06),
                        // serviced OFF this loop so the diff arm never blocks.
                        match decode_query(&text) {
                            Ok(req) => {
                                tokio::spawn(service_query(
                                    req,
                                    state.control_tx.clone(),
                                    state.webhook_addr,
                                    reply_tx.clone(),
                                ));
                            }
                            // Malformed/oversized query frame: a typed drop, stay alive.
                            Err(_reject) => {}
                        }
                    } else {
                        // A control frame: forward the ControlMsg on the control sink
                        // so the browser path can drive Pause/Step/etc.
                        match decode_control(&text) {
                            Ok(msg) => { let _ = state.control_tx.send(msg); }
                            // Malformed/oversized control frame: a typed drop, stay alive.
                            Err(_reject) => {}
                        }
                    }
                }
                // Other frames (ping/pong) are ignored; Close/Err ends it.
                Some(Ok(_)) => {}
                Some(Err(_)) | None => break,
            },
        }
    }
}

/// Build the render-WS [`Router`]: `GET /render`, a body-size limit layer (mirrors
/// webhook.rs, threat T-07-DOS-BODY), and the subscription + gesture-sink state.
/// Exposed so tests can drive it without binding a socket.
// Each argument is one channel handle the per-connection relay needs; the two phase 90 ones
// (the dev fault switch and the held fatal reason) take it past clippy's seven. One caller.
#[allow(clippy::too_many_arguments)]
pub fn render_ws_router(
    sub: RenderSubscription,
    gesture_tx: GestureTx,
    control_tx: ControlTx,
    webhook_addr: Option<SocketAddr>,
    body_limit: usize,
    load_refusals: LoadRefusalTx,
    dev_fault: Option<Arc<AtomicBool>>,
    dev_hold: Option<Arc<AtomicBool>>,
    sim_fatal: watch::Receiver<Option<String>>,
) -> Router {
    Router::new()
        .route("/render", get(render_ws))
        // Bound any untrusted request body before it is buffered (T-07-DOS-BODY);
        // per-frame WS messages are additionally capped in `render_ws`.
        .layer(RequestBodyLimitLayer::new(body_limit))
        .with_state(RenderWsState {
            sub,
            gesture_tx,
            control_tx,
            webhook_addr,
            load_refusals,
            dev_fault,
            dev_hold,
            sim_fatal,
        })
}

/// Bind the render-WS listener on `addr` (LOOPBACK only this phase, threat
/// T-07-EXPOSE — mirror `webhook::run_webhook_listener`) and serve until the process
/// exits. The dev WS is NEVER bound to a public interface.
///
/// # Panics (debug)
/// `debug_assert`s `addr` is a loopback address — the dev WS must never be exposed.
///
/// # Errors
/// Returns the bind / serve [`std::io::Error`] if the address cannot be bound or the
/// server loop fails.
// Each argument is one channel handle the per-connection relay needs; the two phase 90 ones
// (the dev fault switch and the held fatal reason) take it past clippy's seven. One caller.
#[allow(clippy::too_many_arguments)]
pub async fn run_render_listener(
    addr: SocketAddr,
    sub: RenderSubscription,
    gesture_tx: GestureTx,
    control_tx: ControlTx,
    webhook_addr: Option<SocketAddr>,
    body_limit: usize,
    load_refusals: LoadRefusalTx,
    dev_fault: Option<Arc<AtomicBool>>,
    dev_hold: Option<Arc<AtomicBool>>,
    sim_fatal: watch::Receiver<Option<String>>,
) -> std::io::Result<()> {
    // The dev WS binds a loopback address ONLY (threat T-07-EXPOSE); never a public
    // / all-interfaces bind. Enforced by the debug_assert below.
    debug_assert!(
        addr.ip().is_loopback(),
        "the dev render WS must bind a loopback address only (T-07-EXPOSE)"
    );
    let app = render_ws_router(
        sub,
        gesture_tx,
        control_tx,
        webhook_addr,
        body_limit,
        load_refusals,
        dev_fault,
        dev_hold,
        sim_fatal,
    );
    let listener = TcpListener::bind(addr).await?;
    axum::serve(listener, app).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use fabrico_core::core::Core;
    use fabrico_core::event::{LogHeader, SCHEMA_VERSION};
    use fabrico_core::persist::RedbStore;
    use fabrico_protocol::machine_kind;

    use crate::command_error_view::CommandErrorView;
    use crate::driver::Host;
    use crate::gesture_verdict::verdict_channel;
    use crate::ledger::DispatchLedger;
    use crate::sim_loop::gesture_channel;

    /// The next verdict on a connection's channel, as the JSON the socket writes.
    fn verdict_json(rx: &mut crate::gesture_verdict::VerdictRx) -> serde_json::Value {
        let frame = rx.try_recv().expect("a verdict frame");
        serde_json::from_str(&frame.to_json()).expect("the frame is JSON")
    }

    /// A `GridCommand` as the client frames it (phase 88): generation 0, gesture `id`, then
    /// the unchanged postcard body.
    fn headered(id: u64, cmd: &GridCommand) -> Vec<u8> {
        frame_gesture(0, id, &postcard::to_allocvec(cmd).expect("encode"))
    }

    /// A real `Host` over tempfile redb stores (mirrors `render_packet.rs`).
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

    /// D-13 (phase 90): a router built without the dev fault switch DROPS the `dev_fault`
    /// frame (the shipped shape: only `dev_render_server` wires one), and the word is not a
    /// control frame either, so it cannot reach the sim by the control path.
    #[test]
    fn an_unwired_router_drops_the_dev_fault_frame() {
        assert_eq!(
            service_dev_fault(DEV_FAULT_FRAME, None),
            Some(false),
            "the dev fault frame is consumed and dropped when no switch is wired"
        );
        assert_eq!(
            decode_control(DEV_FAULT_FRAME).err(),
            Some(CommandError::Malformed),
            "the dev fault word is no control frame, so it cannot reach the sim by that path"
        );
    }

    /// D-13 (phase 90): a wired router SETS the shared flag on the `dev_fault` frame, and
    /// every other TEXT frame is left to the query and control grammars with the flag unset.
    #[test]
    fn a_wired_router_sets_the_dev_fault_flag_and_nothing_else_does() {
        let flag = Arc::new(AtomicBool::new(false));
        for other in ["pause", "resume", "dev_fault\n", " dev_fault", "query\n{}", ""] {
            assert_eq!(
                service_dev_fault(other, Some(&flag)),
                None,
                "{other:?} is not the dev fault frame"
            );
            assert!(!flag.load(Ordering::Acquire), "{other:?} must not set the flag");
        }
        assert_eq!(service_dev_fault(DEV_FAULT_FRAME, Some(&flag)), Some(true));
        assert!(flag.load(Ordering::Acquire), "the dev fault frame sets the shared flag");
    }

    /// A router built without the dev hold switch drops the frame (the shipped shape), and the
    /// word is not a control frame either, so it can't reach the sim by the control path.
    #[test]
    fn an_unwired_router_drops_the_dev_hold_frame() {
        assert_eq!(service_dev_hold(DEV_HOLD_FRAME, None), Some(false));
        assert_eq!(decode_control(DEV_HOLD_FRAME).err(), Some(CommandError::Malformed));
    }

    /// A wired router sets the shared flag on the frame, and other TEXT frames are left to the
    /// query and control grammars with the flag unset.
    #[test]
    fn a_wired_router_sets_the_dev_hold_flag_and_nothing_else_does() {
        let flag = Arc::new(AtomicBool::new(false));
        for other in ["pause", "resume", "dev_hold\n", " dev_hold", "dev_fault", "query\n{}", ""] {
            assert_eq!(service_dev_hold(other, Some(&flag)), None, "{other:?} is not the hold frame");
            assert!(!flag.load(Ordering::Acquire), "{other:?} must not set the flag");
        }
        assert_eq!(service_dev_hold(DEV_HOLD_FRAME, Some(&flag)), Some(true));
        assert!(flag.load(Ordering::Acquire), "the hold frame sets the shared flag");
    }

    /// FAIL-01 (D-11): the sim-fatal frame is `{"kind":"simFatal","reason":...}`, the reason
    /// verbatim, an empty one included.
    #[test]
    fn the_sim_fatal_frame_carries_its_kind_and_reason() {
        let v: serde_json::Value = serde_json::from_str(&sim_fatal_frame("r")).expect("JSON");
        assert_eq!(v, serde_json::json!({ "kind": "simFatal", "reason": "r" }));
        assert_eq!(sim_fatal_frame("r"), r#"{"kind":"simFatal","reason":"r"}"#);
        let empty: serde_json::Value = serde_json::from_str(&sim_fatal_frame("")).expect("JSON");
        assert_eq!(empty["reason"], "");
    }

    /// FAIL-01 (D-11): a socket is sent nothing before the sim stops, and the held reason on
    /// connect and after a change once it has; a dropped sender keeps the last reason held.
    #[test]
    fn a_socket_is_sent_the_held_sim_fatal_reason() {
        let (tx, mut rx) = watch::channel::<Option<String>>(None);
        assert_eq!(held_sim_fatal_frame(&mut rx), None, "nothing before the sim stops");
        tx.send_replace(Some("stopped".to_owned()));
        assert_eq!(held_sim_fatal_frame(&mut rx), Some(sim_fatal_frame("stopped")));
        let mut late = rx.clone();
        drop(tx);
        assert_eq!(
            held_sim_fatal_frame(&mut late),
            Some(sim_fatal_frame("stopped")),
            "a socket that connects after the sender is gone still reads the held reason"
        );
    }

    /// Phase 90 review IN-A-03: the opening read marks the held reason SEEN in the same step, so
    /// a fatal raised between the socket's subscribe and that read is sent once, by the opening
    /// read, and the change arm does not send it a second time.
    #[test]
    fn the_opening_fatal_read_marks_the_reason_seen() {
        let (tx, rx) = watch::channel::<Option<String>>(None);
        let mut socket = rx.clone();
        tx.send_replace(Some("stopped".to_owned()));
        assert_eq!(held_sim_fatal_frame(&mut socket), Some(sim_fatal_frame("stopped")));
        assert!(
            !socket.has_changed().expect("the sender is alive"),
            "THE OPENING READ MARKS THE REASON SEEN: the change arm would send it again"
        );
    }

    /// The render-WS router over throwaway handles, for the upgrade-door tests.
    fn door_router() -> Router {
        let producer = RenderProducer::new();
        let (kf, diff) = producer.subscribe();
        let (gesture_tx, _grx) = gesture_channel();
        let (control_tx, _crx) = tokio::sync::mpsc::unbounded_channel();
        let (_fatal_tx, fatal_rx) = watch::channel::<Option<String>>(None);
        render_ws_router(
            RenderSubscription::from_handles(kf, diff),
            gesture_tx,
            control_tx,
            None,
            MAX_GESTURE_FRAME,
            load_refusal_channel(),
            None,
            None,
            fatal_rx,
        )
    }

    /// The status `GET /render` answers, with `origin` as its `Origin` header (or none).
    fn upgrade_status(origin: Option<&str>) -> axum::http::StatusCode {
        use tower::ServiceExt;
        let mut req = axum::http::Request::builder()
            .method("GET")
            .uri("/render")
            .header("connection", "upgrade")
            .header("upgrade", "websocket")
            .header("sec-websocket-version", "13")
            .header("sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ==");
        if let Some(o) = origin {
            req = req.header("origin", o);
        }
        let req = req.body(axum::body::Body::empty()).expect("request");
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("rt");
        rt.block_on(async { door_router().oneshot(req).await.expect("route").status() })
    }

    /// Phase 90 review IN-A-04: the dev render socket refuses an upgrade from a web page that is
    /// not on this machine's loopback, so a page open in the developer's browser cannot send
    /// `dev_fault`, Save or Load with a path of its choosing. A loopback page (the Vite dev
    /// server) and a client that sends no Origin (Node, the live specs' fault switch) pass.
    #[test]
    fn the_render_socket_refuses_an_upgrade_from_a_foreign_origin() {
        use axum::http::StatusCode;
        for foreign in ["https://example.com", "http://localhost.example.com:5173", "null", "http://192.168.1.4:5173"] {
            assert_eq!(upgrade_status(Some(foreign)), StatusCode::FORBIDDEN, "A FOREIGN ORIGIN IS REFUSED: {foreign}");
        }
        for local in [None, Some("http://localhost:5173"), Some("http://127.0.0.1:5173"), Some("http://[::1]:5173")] {
            assert_ne!(upgrade_status(local), StatusCode::FORBIDDEN, "a loopback page or no Origin passes the door: {local:?}");
        }
    }

    #[test]
    fn transport_ws_decode_rejects_malformed() {
        // A valid GridCommand round-trips through decode; garbage bytes are a typed
        // reject (never a panic), so no gesture is applied for a malformed frame.
        let cmd = GridCommand::Place {
            kind: machine_kind::SOURCE,
            cell_x: 1,
            cell_y: 2,
        };
        assert_eq!(
            decode_gesture(&headered(1, &cmd)).map(|d| d.frame),
            Ok(GestureFrame::Cmd(cmd)),
            "a valid frame decodes"
        );

        // Bytes that cannot decode into a GridCommand -> typed Malformed reject, both as a
        // whole frame (no readable header) and as a body behind a good header.
        let garbage = vec![0xFFu8, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF];
        assert_eq!(
            decode_gesture(&garbage).map_err(|e| e.error),
            Err(CommandError::Malformed),
            "a malformed frame is a typed reject, not a panic"
        );
        assert_eq!(
            decode_gesture(&frame_gesture(0, 1, &garbage)).map_err(|e| e.error),
            Err(CommandError::Malformed),
            "a malformed body is a typed reject, not a panic"
        );
    }

    #[test]
    fn transport_ws_decode_control_frames() {
        // Argument-less kinds decode (ControlMsg has no PartialEq, so match on the
        // variant); Save/Load carry the path after the newline.
        assert!(matches!(decode_control("pause"), Ok(ControlMsg::Pause)));
        assert!(matches!(decode_control("resume"), Ok(ControlMsg::Resume)));
        assert!(matches!(decode_control("step"), Ok(ControlMsg::Step)));
        assert!(matches!(
            decode_control("load_demo"),
            Ok(ControlMsg::LoadDemo)
        ));
        assert!(
            matches!(decode_control("save\n/tmp/factory.fab"), Ok(ControlMsg::Save(p)) if p.to_str() == Some("/tmp/factory.fab"))
        );
        assert!(
            matches!(decode_control("load\n/tmp/factory.fab"), Ok(ControlMsg::Load(p)) if p.to_str() == Some("/tmp/factory.fab"))
        );

        // Unknown kind, a missing path where one is required, or an argument on an
        // argument-less kind is a typed reject — never a panic (threat T-18-CTRL-WS).
        // (ControlMsg has no PartialEq, so `matches!` rather than `assert_eq!`.)
        assert!(matches!(
            decode_control("nope"),
            Err(CommandError::Malformed)
        ));
        assert!(matches!(
            decode_control("save"),
            Err(CommandError::Malformed)
        ));
        assert!(matches!(
            decode_control("save\n"),
            Err(CommandError::Malformed)
        ));
        assert!(matches!(
            decode_control("pause\nx"),
            Err(CommandError::Malformed)
        ));

        // An oversized control frame hits the size cap before decode.
        let oversized = "pause".to_owned() + &"x".repeat(MAX_CONTROL_FRAME);
        assert!(matches!(
            decode_control(&oversized),
            Err(CommandError::Malformed)
        ));
    }

    /// T-55-04: the `load_example` verb parses its scene id through the ONE
    /// typed [`SceneId`] boundary — both good ids decode to `LoadScene`, and an
    /// unknown id or a bare (arg-less) frame is a typed `Malformed` reject
    /// (frame dropped, socket alive) — NEVER a silent demo load.
    #[test]
    fn transport_ws_decode_load_example_frames() {
        assert!(matches!(
            decode_control("load_example\ndemo_scene"),
            Ok(ControlMsg::LoadScene(SceneId::Demo))
        ));
        assert!(matches!(
            decode_control("load_example\norder_processing"),
            Ok(ControlMsg::LoadScene(SceneId::OrderProcessing))
        ));
        assert!(matches!(
            decode_control("load_example\nbogus"),
            Err(CommandError::Malformed)
        ));
        assert!(matches!(
            decode_control("load_example"),
            Err(CommandError::Malformed)
        ));
    }

    #[test]
    fn decode_query_parses_verb_and_args() {
        // A well-formed query frame (reqId + verb + args) decodes behind a Result.
        let frame = "query\n{\"reqId\":7,\"verb\":\"machine_config\",\"args\":{\"node\":42}}";
        let req = decode_query(frame).expect("a valid query frame decodes");
        assert_eq!(req.req_id, 7);
        assert_eq!(req.verb, "machine_config");
        assert_eq!(req.args.node, Some(42));

        // The validate verb carries a `source` arg, not a node.
        let vframe = "query\n{\"reqId\":9,\"verb\":\"validate_factory_js\",\"args\":{\"source\":\"export default (x)=>x;\"}}";
        let vreq = decode_query(vframe).expect("a valid validate frame decodes");
        assert_eq!(vreq.verb, "validate_factory_js");
        assert_eq!(vreq.args.source.as_deref(), Some("export default (x)=>x;"));
    }

    #[test]
    fn decode_query_rejects_malformed_and_oversized() {
        // A frame WITHOUT the `query\n` prefix is a control frame, not a query —
        // typed reject (the query branch never swallows a control frame).
        assert!(matches!(decode_query("pause"), Err(CommandError::Malformed)));
        // Prefixed but invalid JSON -> typed reject (never a panic, T-40-05-MALFORM).
        assert!(matches!(
            decode_query("query\n{not json"),
            Err(CommandError::Malformed)
        ));
        // An oversized query frame hits the size cap BEFORE the JSON parse.
        let oversized = format!("query\n{}", "x".repeat(MAX_CONTROL_FRAME));
        assert!(matches!(
            decode_query(&oversized),
            Err(CommandError::Malformed)
        ));
    }

    #[test]
    fn reply_envelopes_carry_reqid_and_outcome() {
        // An ok reply tags reqId + ok:true and carries the value; a null value is a
        // legitimate "not configurable / unmapped" answer.
        let ok = ok_reply(3, config_value(None));
        let v: serde_json::Value = serde_json::from_str(&ok).unwrap();
        assert_eq!(v["reqId"], 3);
        assert_eq!(v["ok"], true);
        assert_eq!(v["value"], serde_json::Value::Null);

        // An error reply tags ok:false + the reason (never echoes untrusted bytes).
        let err = err_reply(4, "sim dropped the query");
        let v: serde_json::Value = serde_json::from_str(&err).unwrap();
        assert_eq!(v["reqId"], 4);
        assert_eq!(v["ok"], false);
        assert_eq!(v["error"], "sim dropped the query");
    }

    #[test]
    fn reply_channel_is_bounded_and_drop_safe() {
        // The per-socket reply channel is BOUNDED (T-40-05-UNBOUNDED): a full channel
        // rejects `try_send` rather than growing memory without bound or blocking the
        // relay. `mpsc::channel(REPLY_CHANNEL_CAPACITY)` — never `unbounded_channel`.
        let (tx, _rx) = mpsc::channel::<String>(REPLY_CHANNEL_CAPACITY);
        for _ in 0..REPLY_CHANNEL_CAPACITY {
            tx.try_send("reply".to_owned())
                .expect("sends within capacity succeed");
        }
        assert!(
            tx.try_send("overflow".to_owned()).is_err(),
            "a full bounded channel rejects the overflow (drop-safe, never unbounded)"
        );
    }

    /// A MALFORMED binary frame is answered INLINE with the `Malformed` tag - it is not the
    /// silent drop it was before Phase 64 - naming the client's gesture id when the header
    /// read, and nothing when it did not (phase 88, D-06).
    ///
    /// MOVED BY PLAN 88-03. This was `a_malformed_gesture_frame_advances_the_counter_and_is_answered_inline`
    /// and pinned D-04's per-socket counter: a malformed frame consumed a sequence number, so
    /// the host's count could not desync from the frontend's. The counter is gone (the client
    /// names each gesture in the header), so what is pinned now is the id a refusal carries.
    #[test]
    fn a_malformed_gesture_frame_is_answered_inline_naming_its_id_or_none() {
        let (gesture_tx, mut gesture_rx) = gesture_channel();
        let (verdict_tx, mut verdict_rx) = verdict_channel();

        // A readable header (gesture 5) over bytes that cannot decode into a GridCommand.
        let garbage = vec![0xFFu8, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF];
        service_gesture(&frame_gesture(2, 5, &garbage), &gesture_tx, &verdict_tx);
        let v = verdict_json(&mut verdict_rx);
        assert_eq!(v["kind"], "gestureRefused");
        assert_eq!(v["seq"], 5, "the refusal names the gesture id the header carried");
        assert_eq!(v["tag"], "Malformed");

        // No readable header at all: refused, and the frame names no gesture.
        service_gesture(&garbage, &gesture_tx, &verdict_tx);
        let v = verdict_json(&mut verdict_rx);
        assert_eq!(v["tag"], "Malformed");
        assert!(
            !v.as_object().unwrap().contains_key("seq"),
            "an unreadable header names no gesture id; `seq` is omitted, never null: {v}"
        );
        assert!(gesture_rx.try_recv().is_err(), "nothing undecodable reaches the sim");
    }

    /// The frame's SHAPE is the contract two suites parse: exactly `kind`, `seq` and
    /// `tag`, and crucially NO request-id field. `resolveDevWsReply` keys on `reqId`
    /// alone and its `nextReqId` starts at 1 just as this counter does, so a request
    /// id here would resolve an unrelated config-query promise with a refusal tag
    /// (threat T-64-05-01).
    #[test]
    fn a_refusal_frame_carries_kind_seq_tag_and_no_request_id() {
        let frame = VerdictFrame::refused(Some(7), CommandErrorView::FootprintCollision, None).to_json();
        let v: serde_json::Value = serde_json::from_str(&frame).unwrap();
        let obj = v.as_object().expect("the frame is a JSON object");

        assert_eq!(obj.len(), 3, "exactly three fields, got {obj:?}");
        assert!(obj.contains_key("kind"));
        assert!(obj.contains_key("seq"));
        assert!(obj.contains_key("tag"));
        for key in obj.keys() {
            assert!(
                !key.to_ascii_lowercase().contains("reqid"),
                "a refusal frame must carry NO request id, found {key:?}"
            );
        }
        assert_eq!(obj["kind"], "gestureRefused");
        assert_eq!(obj["seq"], 7);
    }

    /// The `tag` rides as the BARE variant string the frontend copy table keys on -
    /// never a nested `{"MediumMismatch":null}` wrapper, and never a host `Display`
    /// string (T-64-05-02: the tag type is fieldless, so nothing else can ride it).
    #[test]
    fn a_refusal_frame_tag_is_the_bare_variant_string() {
        for (tag, expected) in [
            (CommandErrorView::MediumMismatch, "MediumMismatch"),
            (CommandErrorView::InvalidDock, "InvalidDock"),
            (CommandErrorView::RouteSelfCrossing, "RouteSelfCrossing"),
        ] {
            let v: serde_json::Value = serde_json::from_str(&VerdictFrame::refused(Some(1), tag, None).to_json()).unwrap();
            assert_eq!(v["tag"], expected, "{tag:?} must ride as {expected:?}");
            assert!(
                v["tag"].is_string(),
                "the tag is a bare string, not an object"
            );
        }
    }

    /// MOVED BY PLAN 88-03 (Pitfall 8). This was `the_refusal_channel_drops_at_capacity_rather_than_growing`:
    /// refusals shared the 32-slot config-query reply channel, a 33rd was a named drop, and
    /// that was tolerable only because an accept wrote nothing (D-30). Every gesture now gets
    /// an answer, so a resume burst of accepts would overflow 32 slots and drop answers the
    /// client is waiting on. Verdicts ride their own UNBOUNDED per-connection channel, whose
    /// size is bounded by the frames received (one answer each, T-88-07); the query reply
    /// channel keeps its bound (`reply_channel_is_bounded_and_drop_safe` above). What is
    /// pinned now: a burst far past 32 answers arrives whole and in order.
    #[test]
    fn a_resume_burst_of_verdicts_arrives_whole_where_the_query_channel_would_drop() {
        let (gesture_tx, mut gesture_rx) = gesture_channel();
        let (verdict_tx, mut verdict_rx) = verdict_channel();
        let burst = (REPLY_CHANNEL_CAPACITY as u64) * 3;
        for id in 1..=burst {
            let place = GridCommand::Place {
                kind: machine_kind::SOURCE,
                cell_x: i32::try_from(id).expect("small"),
                cell_y: 0,
            };
            service_gesture(&headered(id, &place), &gesture_tx, &verdict_tx);
        }
        for id in 1..=burst {
            let env = gesture_rx.try_recv().expect("every gesture reached the sim");
            env.verdict.expect("a transport gesture carries a sink").accepted(0, vec![id]);
        }
        for id in 1..=burst {
            let v = verdict_json(&mut verdict_rx);
            assert_eq!((v["kind"].as_str(), v["seq"].as_u64()), (Some("gestureAccepted"), Some(id)));
        }
        assert!(verdict_rx.try_recv().is_err(), "exactly one answer per gesture");
    }

    /// Phase 88 (D-06): an ACCEPTED gesture now writes a frame of its own, the accept naming
    /// the handles it minted and the generation they belong to. The envelope reaches the sim
    /// with the header's generation and a sink for this connection attached, and answering it
    /// accepted puts exactly one `gestureAccepted` text frame on this connection's verdict
    /// channel. The query reply channel is not used for it and stays bounded.
    ///
    /// MOVED BY PLAN 88-03 (Pitfall 8). This was `an_accepted_gesture_is_counted_but_writes_no_frame`
    /// (D-30: "an accept writes nothing"). What stays silent is the USER-facing side: an
    /// accept shows no sentence (`e2e/gesture-verdict.spec.ts`, unchanged).
    #[test]
    fn an_accepted_gesture_writes_an_accept_frame() {
        let (gesture_tx, mut gesture_rx) = gesture_channel();
        let (verdict_tx, mut verdict_rx) = verdict_channel();

        let cmd = GridCommand::Place {
            kind: machine_kind::SOURCE,
            cell_x: 1,
            cell_y: 2,
        };
        service_gesture(
            &frame_gesture(4, 11, &postcard::to_allocvec(&cmd).expect("encode")),
            &gesture_tx,
            &verdict_tx,
        );
        let env = gesture_rx.try_recv().expect("the envelope reaches the sim");
        assert_eq!(env.cmd, GestureFrame::Cmd(cmd), "the gesture body is unchanged by the header");
        assert_eq!(env.generation, Some(4), "the envelope carries the header's generation");
        let sink = env.verdict.expect("a transport gesture carries a sink");
        assert_eq!(sink.gesture_id(), 11, "the sink answers by the client's own id");
        assert!(verdict_rx.try_recv().is_err(), "nothing is written before the sim answers");

        sink.accepted(5, vec![7]);
        let frame = verdict_rx.try_recv().expect("the accept is written");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&frame.to_json()).unwrap(),
            serde_json::json!({"kind": "gestureAccepted", "seq": 11, "generation": 5, "minted": [7]}),
        );
        assert!(verdict_rx.try_recv().is_err(), "exactly one frame per accepted gesture");
    }

    /// WORK-04's concurrency edge: a verdict reaches ONLY the connection that sent the
    /// gesture. Each socket has its own verdict channel, so a second dev-server tab never
    /// receives another tab's accepts.
    #[test]
    fn each_connection_hears_only_its_own_verdicts() {
        let (gesture_tx, mut gesture_rx) = gesture_channel();
        let (tab_a, mut rx_a) = verdict_channel();
        let (tab_b, mut rx_b) = verdict_channel();
        let place = GridCommand::Place {
            kind: machine_kind::SOURCE,
            cell_x: 1,
            cell_y: 1,
        };
        service_gesture(&headered(1, &place), &gesture_tx, &tab_a);
        service_gesture(&headered(1, &place), &gesture_tx, &tab_b);
        gesture_rx.try_recv().expect("tab A's gesture").verdict.expect("sink").accepted(0, vec![3]);
        let a = verdict_json(&mut rx_a);
        assert_eq!(a["minted"], serde_json::json!([3]), "tab A hears its own accept");
        assert!(rx_b.try_recv().is_err(), "tab B hears nothing of tab A's gesture");
        gesture_rx.try_recv().expect("tab B's gesture").verdict.expect("sink").discarded();
        assert_eq!(verdict_json(&mut rx_b)["kind"], "gestureDiscarded");
        assert!(rx_a.try_recv().is_err(), "and tab A nothing of tab B's");
    }

    /// The whole ERR-01 crossing on this transport in one test: a refused gesture
    /// leaves the host as `{kind, seq, tag}` carrying the EXACT typed tag, correlated
    /// by the sequence number the frame consumed on receipt.
    #[test]
    fn a_refused_gesture_leaves_the_host_as_its_exact_tag() {
        let (gesture_tx, mut gesture_rx) = gesture_channel();
        let (verdict_tx, mut verdict_rx) = verdict_channel();

        let bytes = headered(
            9,
            &GridCommand::Place {
                kind: machine_kind::SOURCE,
                cell_x: 3,
                cell_y: 4,
            },
        );
        service_gesture(&bytes, &gesture_tx, &verdict_tx);

        let env = gesture_rx.try_recv().expect("the envelope reaches the sim");
        env.verdict
            .expect("a transport gesture carries a sink")
            .refused(CommandErrorView::FootprintCollision);

        let v = verdict_json(&mut verdict_rx);
        assert_eq!(v["kind"], "gestureRefused");
        assert_eq!(v["seq"], 9, "correlated by the client's own gesture id");
        assert_eq!(
            v["tag"], "FootprintCollision",
            "the SPECIFIC refusal survives the crossing, not a generic one"
        );
        assert!(
            verdict_rx.try_recv().is_err(),
            "exactly ONE frame per refused gesture"
        );
    }

    /// Plan 74.1-28 (re-walk G1): a refused `AddPort` names itself, `{kind, seq, tag,
    /// cmd: "AddPort", node: <handle>}` and nothing else, so the panel's latch can tell
    /// its own refusal from any other. The handle is the one the frame carried.
    #[test]
    fn a_refused_add_port_names_its_command_and_node() {
        let (gesture_tx, mut gesture_rx) = gesture_channel();
        let (verdict_tx, mut verdict_rx) = verdict_channel();

        let bytes = headered(
            1,
            &GridCommand::AddPort {
                node: 300,
                role: 1,
                side: 1,
                medium: 0,
            },
        );
        service_gesture(&bytes, &gesture_tx, &verdict_tx);
        let env = gesture_rx.try_recv().expect("the envelope reaches the sim");
        env.verdict
            .expect("a transport gesture carries a sink")
            .refused(CommandErrorView::GrowCoversBelt);

        let v = verdict_json(&mut verdict_rx);
        let obj = v.as_object().expect("the frame is a JSON object");
        assert_eq!(obj.len(), 5, "kind, seq, tag, cmd and node, got {obj:?}");
        assert_eq!(v["kind"], "gestureRefused");
        assert_eq!(v["seq"], 1);
        assert_eq!(v["tag"], "GrowCoversBelt");
        assert_eq!(v["cmd"], "AddPort");
        assert_eq!(v["node"], 300, "the node handle the frame carried");
    }

    /// A refused command naming no single node carries `cmd` alone, and an undecodable
    /// frame names nothing at all: both fields are OMITTED, never `null`.
    #[test]
    fn a_refusal_names_no_node_it_cannot_and_an_undecodable_frame_names_nothing() {
        let (gesture_tx, mut gesture_rx) = gesture_channel();
        let (verdict_tx, mut verdict_rx) = verdict_channel();

        let bytes = headered(
            1,
            &GridCommand::Place {
                kind: machine_kind::SOURCE,
                cell_x: 3,
                cell_y: 4,
            },
        );
        service_gesture(&bytes, &gesture_tx, &verdict_tx);
        let env = gesture_rx.try_recv().expect("the envelope reaches the sim");
        env.verdict
            .expect("a transport gesture carries a sink")
            .refused(CommandErrorView::FootprintCollision);
        let v = verdict_json(&mut verdict_rx);
        assert_eq!(v["cmd"], "Place");
        assert!(
            !v.as_object().unwrap().contains_key("node"),
            "a Place names no node, so `node` is omitted: {v}"
        );

        service_gesture(&frame_gesture(0, 2, &[0xFF, 0xFF, 0xFF]), &gesture_tx, &verdict_tx);
        let v = verdict_json(&mut verdict_rx);
        let obj = v.as_object().unwrap();
        assert_eq!(v["seq"], 2, "the header read, so the refusal names its gesture id");
        assert!(
            !obj.contains_key("cmd") && !obj.contains_key("node"),
            "an undecodable body names no command: {v}"
        );
    }

    /// Phase 88 (D-02, D-06; version byte T-88-09): a gesture frame is `[version byte]
    /// [varint generation][varint gesture id]` then the body, and the body is byte-identical
    /// to what it always was. The header is
    /// read FIRST, behind a `Result`: a frame whose header cannot be read is refused
    /// `Malformed` naming no gesture id, because it has none; a readable header over a bad
    /// body is refused `Malformed` WITH its id, so the client can pair the refusal.
    #[test]
    fn decode_gesture_reads_the_header_before_the_body() {
        let place = GridCommand::Place {
            kind: machine_kind::SOURCE,
            cell_x: 1,
            cell_y: 2,
        };
        let body = postcard::to_allocvec(&place).expect("encode");
        const V: u8 = GESTURE_FRAME_VERSION;

        // One-byte varints: the frame the TypeScript twin pins byte for byte.
        let mut frame = vec![0xF1u8, 3, 41];
        frame.extend_from_slice(&body);
        assert_eq!(
            decode_gesture(&frame),
            Ok(DecodedGesture {
                generation: 3,
                gesture_id: 41,
                frame: GestureFrame::Cmd(place.clone()),
            }),
            "version 0xF1, generation 3, gesture id 41, then the Place body unchanged"
        );
        assert_eq!(
            frame_gesture(3, 41, &body),
            frame,
            "the header writer is the exact inverse of the reader"
        );

        // Multi-byte varints on both fields, through the writer.
        let wide = frame_gesture(300, 70_000, &body);
        assert_eq!(&wide[..6], &[V, 0xAC, 0x02, 0xF0, 0xA2, 0x04], "the version, then LEB128 of 300 then 70000");
        let d = decode_gesture(&wide).expect("a wide header decodes");
        assert_eq!((d.generation, d.gesture_id), (300, 70_000));
        assert_eq!(d.frame, GestureFrame::Cmd(place.clone()));

        // A run-pace body after the header still decodes: the 0xFE lead is the BODY's
        // first byte, not the frame's.
        let run = frame_gesture(1, 2, &[BELT_RUN_PACE_LEAD, 1, 9, 4]);
        assert_eq!(
            decode_gesture(&run).map(|d| d.frame),
            Ok(GestureFrame::RunPace(BeltRunPace {
                belts: vec![9],
                ticks_per_slot: 4,
            })),
        );

        let unreadable = |bytes: &[u8], what: &str| {
            assert_eq!(
                decode_gesture(bytes),
                Err(GestureDecodeError {
                    gesture_id: None,
                    error: CommandError::Malformed,
                }),
                "{what}: refused Malformed and names no gesture id"
            );
        };
        unreadable(&[], "an empty frame");
        unreadable(&[V], "a version byte with no generation");
        unreadable(&[V, 0x80], "a generation varint cut short");
        unreadable(&[V, 3], "a header with no gesture id");
        unreadable(&[V, 3, 0x80, 0x80], "a gesture-id varint cut short");
        let mut eleven = vec![V];
        eleven.extend_from_slice(&[0x80u8; 10]);
        eleven.push(0x01);
        unreadable(&eleven, "an eleven-byte varint");
        // Past u64 (security T-88-06). The generation's tenth byte is 0x02, and a readable
        // gesture id (7) and a valid Place body follow it, so the tenth-byte guard in
        // `read_header_varint` is the ONLY thing that can refuse this frame. Without the
        // guard the high bit drops and the frame decodes as generation 2^63 - 1, gesture 7.
        let mut past_u64 = vec![V];
        past_u64.extend_from_slice(&[0xFFu8; 9]);
        past_u64.extend_from_slice(&[0x02, 0x07]);
        past_u64.extend_from_slice(&body);
        unreadable(&past_u64, "a ten-byte varint whose value does not fit in u64");
        // The control: the same frame with the largest legal tenth byte decodes, to
        // u64::MAX, so the refusal above is the value check and not the bytes after it.
        let mut at_u64_max = vec![V];
        at_u64_max.extend_from_slice(&[0xFFu8; 9]);
        at_u64_max.extend_from_slice(&[0x01, 0x07]);
        at_u64_max.extend_from_slice(&body);
        assert_eq!(
            decode_gesture(&at_u64_max),
            Ok(DecodedGesture {
                generation: u64::MAX,
                gesture_id: 7,
                frame: GestureFrame::Cmd(place.clone()),
            }),
            "a ten-byte varint of exactly u64::MAX, then id 7 and the Place body, decodes"
        );
        unreadable(&vec![0u8; MAX_GESTURE_FRAME + 1], "a frame over the size cap");

        // The header read, the body did not: refused WITH the id it carried.
        for (bytes, what) in [
            (vec![V, 3, 41], "a header with no body"),
            (vec![V, 3, 41, 0xFF, 0xFF, 0xFF], "a header over an undecodable body"),
            (vec![V, 3, 41, BELT_RUN_PACE_LEAD], "a header over a run-pace lead with no body"),
        ] {
            assert_eq!(
                decode_gesture(&bytes),
                Err(GestureDecodeError {
                    gesture_id: Some(41),
                    error: CommandError::Malformed,
                }),
                "{what}: refused Malformed naming gesture 41"
            );
        }
    }

    /// Security T-88-09: a frame from a page on an older wire is refused, never read as a
    /// different gesture. A page built before phase 88 sends a bare `GridCommand`; a page
    /// from phase 88 before the version byte sends the two varints and the body. Neither
    /// starts with the version byte, so both get the could-not-read refusal (`Malformed`,
    /// no gesture id) and nothing reaches the sim.
    ///
    /// Without the version byte the bare Dock below read as generation 4 (the Dock
    /// discriminant), gesture 9 (the belt) and `Delete { node: 5 }` (the Tail byte, then the
    /// node), with the trailing port byte ignored: a stale page's Dock deleted the machine
    /// it meant to dock to.
    #[test]
    fn a_frame_from_an_older_wire_is_refused_not_read_as_another_gesture() {
        let unreadable = Err(GestureDecodeError {
            gesture_id: None,
            error: CommandError::Malformed,
        });
        let dock = GridCommand::Dock {
            belt: 9,
            endpoint: fabrico_protocol::BeltEnd::Tail,
            node: 5,
            port: 0,
        };
        let bare_dock = postcard::to_allocvec(&dock).expect("encode");
        assert_eq!(bare_dock, vec![4, 9, 1, 5, 0], "the pre-88 bytes: Dock, belt 9, Tail, node 5, port 0");
        assert_eq!(
            decode_gesture(&bare_dock),
            unreadable,
            "a pre-88 bare Dock is refused as unreadable, not read as a Delete of node 5"
        );

        // Every pre-88 bare body is refused the same way, whatever its lead byte.
        let bare_place = postcard::to_allocvec(&GridCommand::Place {
            kind: machine_kind::SOURCE,
            cell_x: 1,
            cell_y: 2,
        })
        .expect("encode");
        for (bytes, what) in [
            (bare_place.clone(), "a bare Place"),
            (postcard::to_allocvec(&GridCommand::Undo).expect("encode"), "a bare Undo"),
            (vec![BELT_RUN_PACE_LEAD, 1, 9, 4], "a bare run-pace frame"),
        ] {
            assert_eq!(decode_gesture(&bytes), unreadable, "{what} from a pre-88 page is refused");
        }

        // A phase 88 frame from before the version byte: generation 3, gesture 41, Place.
        let mut versionless = vec![3u8, 41];
        versionless.extend_from_slice(&bare_place);
        assert_eq!(
            decode_gesture(&versionless),
            unreadable,
            "a header with no version byte is refused"
        );

        // A version this host does not speak is refused the same way.
        let mut other_version = frame_gesture(3, 41, &bare_place);
        other_version[0] = GESTURE_FRAME_VERSION + 1;
        assert_eq!(decode_gesture(&other_version), unreadable, "a different version byte is refused");

        // The control: the same Dock framed on this wire decodes as the Dock it is.
        assert_eq!(
            decode_gesture(&frame_gesture(4, 9, &bare_dock)),
            Ok(DecodedGesture {
                generation: 4,
                gesture_id: 9,
                frame: GestureFrame::Cmd(dock),
            }),
            "a versioned Dock decodes as the Dock"
        );
    }

    /// The version byte is one value on both sides of the language boundary (T-88-09).
    /// `include_str!`, so a moved or renamed TypeScript file fails the build, not the test.
    #[test]
    fn the_frontend_gesture_frame_version_matches_this_crates() {
        const DECODE_TS: &str = include_str!("../../../frontend/src/protocol/decode.ts");
        let decl = "export const GESTURE_FRAME_VERSION = ";
        let start = DECODE_TS
            .find(decl)
            .map(|i| i + decl.len())
            .expect("decode.ts declares `export const GESTURE_FRAME_VERSION = `");
        let literal: String = DECODE_TS[start..]
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric())
            .collect();
        let ts = literal
            .strip_prefix("0x")
            .and_then(|hex| u8::from_str_radix(hex, 16).ok())
            .unwrap_or_else(|| panic!("GESTURE_FRAME_VERSION in decode.ts is not a hex byte: {literal:?}"));
        assert_eq!(
            ts, GESTURE_FRAME_VERSION,
            "the page and the host disagree on the gesture frame's version byte, so every \
             gesture the page sends is refused as unreadable. Change both sides or neither."
        );
    }

    #[test]
    fn transport_ws_oversized_frame_rejected() {
        // A frame over the size cap is rejected BEFORE decode (T-07-DOS-BODY) — the
        // loop stays alive, nothing is buffered unboundedly.
        let oversized = vec![0u8; MAX_GESTURE_FRAME + 1];
        assert_eq!(
            decode_gesture(&oversized),
            Err(GestureDecodeError {
                gesture_id: None,
                error: CommandError::Malformed,
            }),
            "an oversized frame hits the size cap, before its header is read"
        );
        // A frame exactly at the cap is NOT rejected by size (it may still fail to
        // decode, but not for being oversized — proves the boundary is inclusive).
        let at_cap = vec![0u8; MAX_GESTURE_FRAME];
        // 0x00.. decodes as GridCommand::Place{kind:0,...} prefix then runs out -> a
        // decode error, but crucially it passed the size gate (we only assert it is
        // not panicking and yields a typed result).
        let _ = decode_gesture(&at_cap);
    }

    #[test]
    fn producer_diff_reaches_subscriber() {
        // The transport SUBSCRIBES to the producer (W2): one producer.on_tick yields
        // exactly one diff frame to the transport's subscription — proving the
        // per-tick producer→transport wiring (the live packet-stream confirmation is
        // the chrome-devtools step in 07-08).
        let (_dir, mut host) = test_host();
        host.core_mut().state.add_source(); // one node so the diff is non-empty
        let mut producer = RenderProducer::new();
        let sub = RenderSubscription::from_producer(&producer);
        // The transport's own per-connection diff receiver.
        let mut diff_rx = sub.diff_rx.resubscribe();

        producer
            .on_tick(&host)
            .expect("on_tick encodes + broadcasts");

        let frame = diff_rx
            .try_recv()
            .expect("exactly one diff frame reaches the subscriber");
        assert!(
            !frame.bytes.is_empty(),
            "the diff frame carries the producer's bytes"
        );
        assert!(
            diff_rx.try_recv().is_err(),
            "exactly one frame per on_tick (the per-tick emission)"
        );
        // And the keyframe watch holds a non-empty full frame for a fresh connect.
        assert!(
            !sub.keyframe_rx.borrow().bytes.is_empty(),
            "the subscription's keyframe watch holds a full frame"
        );
    }
}
