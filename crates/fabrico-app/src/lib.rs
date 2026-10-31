//! The Fabrico Tauri 2 production shell — "one renderer, two transports".
//!
//! # Exactly two capability-scoped commands
//! This shell exposes ONLY two IPC commands (threat T-07-CMD-EXPOSE — no
//! shell/fs/dialog surface):
//! - [`subscribe_render`] — a `Channel` that streams the IDENTICAL postcard
//!   render-packet bytes the dev WebSocket (07-06) sends. It is a pure SUBSCRIBER
//!   of the single [`RenderProducer`](fabrico_host::render_packet::RenderProducer):
//!   it sends the current keyframe then forwards each per-tick diff, never
//!   building or re-encoding a packet.
//! - [`submit_input`] — decodes a [`GridCommand`] behind a `Result` (never
//!   `unwrap`) and forwards it to the sim thread, which applies it via
//!   `apply_gesture` (validate -> log -> fold; SC5 — never a direct state write).
//!   It is a BLOCKING command that enqueues inline and returns at once; the host's
//!   verdict comes home OUT OF BAND on [`subscribe_gesture_verdicts`], so a refused
//!   gesture reaches the user as a sentence instead of as nothing.
//! - [`subscribe_gesture_verdicts`] — a `Channel` the webview opens once, down which
//!   EVERY gesture's one verdict is pushed (phase 88, D-06): `gestureRefused`,
//!   `gestureAccepted` (naming the handles it minted) or `gestureDiscarded`, the
//!   identical frames the dev WebSocket writes on its TEXT relay, forwarded with no time
//!   bound. Each subscription is its own verdict route (phase 88 review, CR-01): a gesture
//!   is answered only on the route that was current when it was sent, so a webview reload
//!   never hands the old page's verdicts to the new page.
//!
//! # The managed sim loop is the per-tick PRODUCER OWNER (W2)
//! Because [`Core`](fabrico_core::core::Core) is `!Send`, the `Host` + the
//! `RenderProducer` live on a dedicated thread. That thread is the per-tick OWNER:
//! each tick it drains gestures (applying them on the sim thread), calls
//! `host.tick_once`, then `producer.on_tick` (the explicit
//! `layout.update -> build -> encode -> broadcast.send` step). The two commands are
//! pure subscribers/forwarders that reach the sim thread only through Send channel
//! handles — the webview never touches `Host`.
//!
//! Desktop-window run/packaging is DEFERRED to the developer (CONTEXT); the shell
//! boots THE command-built default demo scene (LIVE-01: `boot_scene` at genesis, the
//! identical call the dev render server boots with) and
//! streams it — the user builds on top via gestures (or re-loads it via the
//! "Load demo scene" CTA). The live scene Chrome validates is
//! `cargo run -p fabrico-host --example dev_render_server`.

use std::net::SocketAddr;
use std::sync::{Arc, Mutex, PoisonError};
use std::thread;

use fabrico_core::core::Core;
// `MachineConfig` is now referenced only by the tick-boundary oneshot channel in
// tests — the `machine_config` command maps core -> `ConfigView` at the boundary, so
// the core enum no longer appears in non-test code (gate the import to avoid an
// unused-import warning while keeping `machine_config_forwards_reply` green).
#[cfg(test)]
use fabrico_core::edit::MachineConfig;
use fabrico_core::event::{LogHeader, SCHEMA_VERSION};
use fabrico_core::persist::{MAX_RECORD_BYTES, RedbStore};
use fabrico_host::config::HostConfig;
use fabrico_host::config_view::ConfigView;
use fabrico_host::demo_scene::{DEMO_GENESIS_SEED, SceneId, boot_scene};
use fabrico_host::driver::Host;
use fabrico_host::ingress::endpoint::{ENDPOINT_INGRESS_CAPACITY, EndpointIngress};
use fabrico_host::ingress::seen_set::SeenSet;
use fabrico_host::ingress::webhook::{Ingress, WEBHOOK_INGRESS_CAPACITY, run_webhook_listener};
use fabrico_host::ledger::DispatchLedger;
use fabrico_host::render_packet::{RenderFrame, RenderProducer, RenderRelay};
use fabrico_host::gesture_verdict::{VerdictFrame, VerdictRx, VerdictTx, verdict_channel};
use std::future::Future;
use fabrico_host::sim_loop::{ControlMsg, GestureRx, GestureTx, SimLoop, gesture_channel};
// ONE decoder and ONE `kind` discriminator for BOTH transports. `decode_gesture` also
// carries the dev WebSocket's `MAX_GESTURE_FRAME` cap (threat T-07-DOS-BODY), which a
// bare `postcard::from_bytes` here did not, and its typed `CommandError::Malformed` is
// what lets an undecodable gesture answer the user instead of vanishing.
use fabrico_host::sim_fatal::{fatal_reason, panic_reason};
use fabrico_host::transport_ws::{
    LOAD_REFUSAL_KIND, SAVE_FAILURE_KIND, SIM_FATAL_KIND, decode_gesture, wire_envelope,
};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::State;
use tokio::sync::broadcast;
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};
use tokio::sync::oneshot;
use tokio::sync::watch;

/// The per-connection render subscription handles, published once by the sim
/// thread. Both are cheap, `Send` channel receivers the [`subscribe_render`]
/// command clones/resubscribes per webview connection.
type RenderHandles = (
    watch::Receiver<RenderFrame>,
    broadcast::Receiver<RenderFrame>,
);

/// The shared, `Send + Sync` state the two Tauri commands use to reach the sim
/// thread. Holds NO `Host` reference (Core is `!Send`); it talks to the sim loop
/// only through these channel handles.
struct AppState {
    /// The producer's latest-keyframe watch — cloned per connection so a fresh
    /// subscriber resyncs from the latest full frame.
    keyframe_rx: watch::Receiver<RenderFrame>,
    /// The producer's per-tick diff broadcast — `resubscribe`d per connection so
    /// each webview receives the live diff stream after its keyframe.
    diff_rx: broadcast::Receiver<RenderFrame>,
    /// The gesture sink: a decoded `GridCommand` is wrapped in a
    /// [`GestureEnvelope`](fabrico_host::sim_loop::GestureEnvelope) and forwarded here,
    /// then applied on the sim thread (mirrors `transport_ws`'s gesture forwarding; SC5
    /// preserved). [`submit_input`] attaches a verdict sink on the current [`AppState::verdicts`] route, so
    /// the verdict comes home OUT OF BAND (ERR-01) while the enqueue itself stays inline.
    gesture_tx: GestureTx,
    /// The verdict routes (phase 88, D-06; review CR-01): one per
    /// [`subscribe_gesture_verdicts`] call, each with its own sender and its own
    /// [`forward_verdicts`] task. [`submit_input`] attaches a sink on the CURRENT route's
    /// sender, so a gesture is answered on the subscription that was current when it was
    /// sent and on no other. There is no task per gesture, so nothing needs a time bound.
    verdicts: VerdictRoutes,
    /// The webview's LOAD-refusal `Channel` (UNDO-09), registered once by
    /// [`subscribe_load_refusals`]. Cloned into the sim thread's load-refusal sink at
    /// construction, so a refused `.fab` reaches a screen in the SHIPPED binary and not
    /// only in the dev harness the live suite drives.
    load_refusals: LoadRefusalChannel,
    /// The held fatal sim error (phase 90, FAIL-01, D-11): the reason once the sim loop has
    /// ended, and the webview's channel, under one lock. [`subscribe_sim_fatal`] registers
    /// the channel; the sim thread raises the reason.
    sim_fatal: SimFatalSlot,
    /// The control sink: each discrete control command enqueues a typed
    /// [`ControlMsg`] the sim thread services at the tick boundary (HOST-02..05).
    /// The webview never touches `Host` — it only enqueues a typed intent.
    control_tx: UnboundedSender<ControlMsg>,
    /// The bound webhook [`SocketAddr`] captured at listener-bind time (CFG-03).
    /// `Copy` + fixed for the process lifetime; the `webhook_url` command threads it
    /// onto its [`ControlMsg::QueryWebhookUrl`] so the sim thread formats the
    /// loopback URL with the real bound port.
    webhook_addr: SocketAddr,
}

/// Stream the render packets to the webview over a binary `Channel` — a pure
/// SUBSCRIBER of the single [`RenderProducer`] (W2). Sends the current keyframe,
/// then forwards each per-tick diff as the IDENTICAL postcard bytes the dev
/// WebSocket carries — never building or re-encoding a packet.
///
/// # Errors
/// Returns a string error only if the `Channel` send fails (the webview dropped
/// it); a lagged broadcast resyncs from the keyframe rather than erroring.
#[tauri::command]
async fn subscribe_render(
    channel: Channel<InvokeResponseBody>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut keyframe_rx = state.keyframe_rx.clone();
    let mut diff_rx = state.diff_rx.resubscribe();

    // On connect: send the latest keyframe (skip an empty initial frame).
    // The relay remembers the client's handle-table generation so a later lag knows
    // whether it spanned a reset (plan 76-19 refuter round), shared with `transport_ws`.
    let (mut relay, keyframe) = RenderRelay::open(&keyframe_rx.borrow_and_update());
    if !keyframe.is_empty() {
        channel
            .send(InvokeResponseBody::Raw(keyframe))
            .map_err(|e| e.to_string())?;
    }

    loop {
        match diff_rx.recv().await {
            // Forward each per-tick diff frame (identical producer bytes, W2). `None` is a
            // frame at or below the keyframe a lag just resent (FAIL-05, D-09), not sent.
            Ok(frame) => {
                if let Some(bytes) = relay.forward(frame) {
                    channel
                        .send(InvokeResponseBody::Raw(bytes))
                        .map_err(|e| e.to_string())?;
                }
            }
            // Lagged past the bounded broadcast: resync from the latest keyframe.
            Err(broadcast::error::RecvError::Lagged(_)) => {
                // 73-12 (73-REVIEW WR-01) and the plan 76-19 refuter round: tagged as a
                // resync only when no reset fell among the dropped frames, decided by the
                // SAME `RenderRelay::lagged` `transport_ws`'s Lagged arm calls. See
                // `fabrico_host::render_packet::RenderRelay`.
                let kf = relay.lagged(&keyframe_rx.borrow_and_update());
                if !kf.is_empty() {
                    channel
                        .send(InvokeResponseBody::Raw(kf))
                        .map_err(|e| e.to_string())?;
                }
            }
            // The producer is gone (sim thread ended) — end the stream cleanly.
            Err(broadcast::error::RecvError::Closed) => break,
        }
    }
    Ok(())
}

// Phase 88 (D-06) DELETED the 30-second `GESTURE_VERDICT_BOUND` this place held, with the
// per-gesture delivery task it bounded. That task awaited one oneshot reply per gesture, so
// a gesture made on a paused board stranded it, and the bound freed it after 30 seconds,
// in SILENCE. Silence was harmless while only refusals were answered; once every gesture is
// answered, a client waits on each accept to send the gesture's follow-ups (a Place's
// Rotate, a belt's Dock), and a paused period over 30 seconds would have stranded them in
// the shipped binary only (research Pitfall 2). Verdicts now ride ONE channel and ONE
// forwarder ([`forward_verdicts`]); nothing waits per gesture, so nothing is bounded, and
// `a_verdict_answered_after_a_long_pause_is_still_emitted` pins that a verdict produced 120
// seconds after its gesture still reaches the webview.

/// The webview's verdict ROUTES (phase 88 review, CR-01): one per
/// [`subscribe_gesture_verdicts`] call, each its own [`verdict_channel`] and its own
/// [`forward_verdicts`] task, and only the newest is CURRENT.
///
/// # Why a route per subscription and not one channel slot
/// The gesture id is the page's own counter, from 1 on every page load, and the client
/// pairs each verdict with its gesture by that id alone. Until this fix the shell had ONE
/// verdict sender for the life of the process and one channel slot a subscribe swapped. A
/// webview reload (F5 or Ctrl+R, which WebView2 enables by default) does not drain the
/// host's gesture queue, so every gesture the old page sent and the host had not answered
/// yet, a paused board's queue above all, was answered on the NEW page's channel, under an
/// id the new page was about to reuse. The new page then paired the old page's Place with
/// its own gesture 1 and sent that gesture's Rotate to the old page's Source (the WORK-04
/// defect, through phase 88's own pairing); an old refusal with a high id raised the
/// stale-drop bar and hid the new page's refusals.
///
/// Now each sink carries the sender of the route that was current when its gesture was
/// enqueued ([`VerdictRoutes::sender`]), so an answer can only travel down that route, and a
/// route's forwarder delivers only while its route is current ([`VerdictRoutes::is_current`]).
/// A verdict for a gesture the old page sent cannot reach the new page: the two pages never
/// share a sender. A superseded route's forwarder ends by itself once the last sink holding
/// its sender is answered or dropped.
///
/// # What is given up, stated plainly
/// A gesture sent BEFORE the page subscribed is answered on no page. The page opens the
/// verdict channel first, before the render stream, so it cannot have drawn a board to
/// gesture on yet; the old slot's "a late subscriber still receives verdicts for gestures
/// already in flight" was the very property the reload defect rode on.
///
/// One current route for the process: this shell has one webview. A second webview would
/// need its routes keyed by webview, not swapped.
#[derive(Clone, Default)]
struct VerdictRoutes(Arc<Mutex<VerdictRoute>>);

/// The current route: its number (0 before any subscription) and its sender (`None` before
/// any subscription).
#[derive(Default)]
struct VerdictRoute {
    epoch: u64,
    tx: Option<VerdictTx>,
}

impl VerdictRoutes {
    /// Open a NEW route and make it the current one, returning its number and its receiver.
    /// The previous route's sender is dropped here, so only the sinks already holding it
    /// keep it alive.
    ///
    /// `unwrap_or_else(PoisonError::into_inner)` rather than `unwrap`: a poisoned lock
    /// would otherwise turn one panic into a permanently silent verdict path.
    fn open(&self) -> (u64, VerdictRx) {
        let (tx, rx) = verdict_channel();
        let mut route = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        route.epoch += 1;
        route.tx = Some(tx);
        (route.epoch, rx)
    }

    /// The current route's sender, for one gesture's sink. Before any subscription there is
    /// no page to answer, and the sender handed out is one whose receiver is already gone:
    /// the answer is dropped, which every sink tolerates.
    fn sender(&self) -> VerdictTx {
        let route = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        route.tx.clone().unwrap_or_else(|| verdict_channel().0)
    }

    /// Whether route `epoch` is still the current one.
    fn is_current(&self, epoch: u64) -> bool {
        self.0.lock().unwrap_or_else(PoisonError::into_inner).epoch == epoch
    }
}

/// Open a verdict route for one subscription and return its forwarder, ready to spawn.
///
/// The route is opened HERE, synchronously, before the future exists, so a gesture
/// submitted after the subscribe returns is already tagged with the new route. The
/// forwarder hands each frame to `emit` only while the route is current: a frame arriving
/// after a newer subscription goes to no page.
///
/// A free function taking `emit` for the reason [`forward_verdicts`] is one: unit tests
/// drive it with no Tauri `State` harness, and `npm run e2e:live` never runs this binary.
fn open_verdict_route(
    routes: &VerdictRoutes,
    mut emit: impl FnMut(VerdictFrame) + Send + 'static,
) -> impl Future<Output = ()> + Send + 'static {
    let (epoch, rx) = routes.open();
    let routes = routes.clone();
    forward_verdicts(rx, move |frame| {
        if routes.is_current(epoch) {
            emit(frame);
        }
    })
}

/// Open the gesture-verdict `Channel` (ERR-01). The webview calls this ONCE per page
/// load, before it subscribes to the render stream, and every verdict on the gestures it
/// sends from then on arrives on it (and on no later page's channel; review CR-01).
///
/// It must be opened BEFORE [`subscribe_render`], which does not return while the sim runs - that command is
/// the forever diff-forwarding loop, so an `await` on it would strand any later
/// subscription call in the webview's own promise chain.
///
/// A send failure means the webview dropped the channel, and the frame is DISCARDED: there
/// is no user left to tell.
#[tauri::command]
fn subscribe_gesture_verdicts(channel: Channel<VerdictFrame>, state: State<'_, AppState>) {
    tauri::async_runtime::spawn(open_verdict_route(&state.verdicts, move |frame| {
        let _ = channel.send(frame);
    }));
}

/// The LOAD-REFUSAL frame this shell pushes down the webview's load-refusal `Channel`
/// (UNDO-09).
///
/// It is FIELD-FOR-FIELD the dev WebSocket's `LoadRefusedFrame`
/// (`fabrico_host::transport_ws`), down to the shared [`LOAD_REFUSAL_KIND`]
/// discriminator, so the frontend parses both transports with ONE function and neither
/// can drift into a frame shape of its own.
///
/// # Why it exists at all, given the gesture verdict already does
/// Because a gesture verdict CANNOT carry this. That frame is payload-free by design -
/// a fieldless tag and an integer, so no filesystem path, node handle, internal index or
/// host `Display` string can ride it (T-64-05-02). UNDO-09's requirement is the reason
/// "in the words the host already wrote", which is exactly such a `Display` string. The
/// two frames must never be merged on the assumption that the payload-free property is
/// shared; what replaces it here is
/// `crates/fabrico-host/tests/project_error_copy.rs`, a gate over every `ProjectError`
/// variant asserting no debug payload and no leaked path.
#[derive(serde::Serialize, Clone, Debug, PartialEq, Eq)]
struct LoadRefused {
    /// Always [`LOAD_REFUSAL_KIND`].
    kind: &'static str,
    /// The host's `ProjectError` `Display` sentence, verbatim.
    reason: String,
}

/// The webview's load-refusal sink: the `Channel` [`subscribe_load_refusals`] registers,
/// shared with the sim thread's sink closure.
///
/// The channel is looked up at DELIVERY time and not captured at send time: a captured
/// clone would be pinned to whichever channel existed when the sink was built - which is
/// `None` before the webview has subscribed, and stale across a webview reload. A load
/// refusal names no gesture id, so unlike a gesture verdict ([`VerdictRoutes`]) it cannot
/// be paired with the wrong gesture on the new page.
#[derive(Clone, Default)]
struct LoadRefusalChannel(Arc<Mutex<Option<Channel<LoadRefused>>>>);

impl LoadRefusalChannel {
    /// Adopt the webview's channel, replacing any previous one (a webview reload opens a
    /// fresh channel and the old one is dead).
    fn register(&self, channel: Channel<LoadRefused>) {
        *self.0.lock().unwrap_or_else(PoisonError::into_inner) = Some(channel);
    }

    /// Push one load refusal to the webview, if it has subscribed. A send failure means
    /// the webview dropped the channel and is DISCARDED: there is no user left to tell.
    ///
    /// `unwrap_or_else(PoisonError::into_inner)` rather than `unwrap`, and it is
    /// load-bearing for the identical reason it is on [`VerdictRoutes::open`]: a
    /// poisoned lock would turn one panicking task into a permanently silent refusal
    /// path, which is this plan's own bug arriving by a side door.
    fn emit(&self, refusal: LoadRefused) {
        if let Some(channel) = self.0.lock().unwrap_or_else(PoisonError::into_inner).as_ref() {
            let _ = channel.send(refusal);
        }
    }
}

/// Open the load-refusal `Channel` (UNDO-09). The webview calls this once per page load, beside
/// [`subscribe_gesture_verdicts`] and for the same reason: it must be opened BEFORE
/// [`subscribe_render`], which does not return while the sim runs.
#[tauri::command]
fn subscribe_load_refusals(channel: Channel<LoadRefused>, state: State<'_, AppState>) {
    state.load_refusals.register(channel);
}

/// The SIM-FATAL frame this shell pushes down the webview's fatal `Channel` (phase 90,
/// FAIL-01, D-11): the sim loop ended and will not come back. Field for field the dev
/// WebSocket's `SimFatalFrame` (`fabrico_host::transport_ws`), on the shared
/// [`SIM_FATAL_KIND`], so the frontend parses both transports with one function.
#[derive(serde::Serialize, Clone, Debug, PartialEq, Eq)]
struct SimFatal {
    /// Always [`SIM_FATAL_KIND`].
    kind: &'static str,
    /// The host's reason sentence (`fabrico_host::sim_fatal::fatal_reason`), verbatim.
    reason: String,
}

/// What [`SimFatalSlot`] holds under its one lock: the reason once raised, and the webview's
/// channel once registered.
#[derive(Default)]
struct SimFatalState {
    reason: Option<String>,
    channel: Option<Channel<SimFatal>>,
}

/// The held fatal sim error (phase 90, FAIL-01, D-11). Unlike [`LoadRefusalChannel`], which
/// holds only the channel, this holds the VALUE too: a fatal is a lasting fact, so a page that
/// subscribes after it (the sim can fail before the webview loads, and a reload opens a new
/// channel) must still be told. The reason and the channel share one lock, so neither order
/// of `raise` and `register` can lose it: a reason raised first is sent on `register`, one
/// raised after is sent by `raise`, once.
#[derive(Clone, Default)]
struct SimFatalSlot(Arc<Mutex<SimFatalState>>);

impl SimFatalSlot {
    /// Adopt the webview's channel (a reload's new one replaces the old) and, under the same
    /// lock, send it the held reason if the sim has already stopped.
    fn register(&self, channel: Channel<SimFatal>) {
        let mut state = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(reason) = state.reason.clone() {
            deliver_sim_fatal(reason, |f| {
                let _ = channel.send(f);
            });
        }
        state.channel = Some(channel);
    }

    /// Hold the reason and send it to the registered channel, if any. A send failure means
    /// the webview dropped the channel and is discarded; the reason stays held for the next
    /// subscription. `unwrap_or_else(PoisonError::into_inner)` for the
    /// [`LoadRefusalChannel::emit`] reason: a poisoned lock must not silence a stopped sim.
    fn raise(&self, reason: String) {
        let mut state = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        state.reason = Some(reason.clone());
        if let Some(channel) = state.channel.as_ref() {
            deliver_sim_fatal(reason, |f| {
                let _ = channel.send(f);
            });
        }
    }
}

/// Open the fatal sim error `Channel` (phase 90, FAIL-01). The webview calls this once per page
/// load (the slot's reload test relies on it), beside [`subscribe_load_refusals`] and BEFORE
/// [`subscribe_render`], which does not return while the sim runs (phase 90 review IN-A-05: after
/// a fatal the shell drops the sim, the broadcast reads `Closed` and it returns `Ok`). A reason
/// the host already holds is sent at once.
#[tauri::command]
fn subscribe_sim_fatal(channel: Channel<SimFatal>, state: State<'_, AppState>) {
    state.sim_fatal.register(channel);
}

/// Hand ONE fatal reason to `emit`, as the frame. A free function taking `emit`, the
/// [`deliver_load_refusal`] shape, so the slot's decisions are tested with no Tauri `State`.
fn deliver_sim_fatal(reason: String, emit: impl FnOnce(SimFatal)) {
    emit(SimFatal {
        kind: SIM_FATAL_KIND,
        reason,
    });
}

/// Hand ONE refused load's reason to `emit`.
///
/// A free function taking `emit` rather than a method on [`LoadRefusalChannel`], for the
/// same reason [`forward_verdicts`] is one: it makes the decision unit-testable with no
/// Tauri `State` harness and no live webview. Without that shape the Tauri half of
/// UNDO-09 would have NO automated coverage at all, because `npm run e2e:live` drives
/// `dev_render_server` and never this binary (ruling R-14).
///
/// There is no silent arm and no bound. Unlike a gesture verdict, which is silent for an
/// accept and bounded because a paused board never answers, a refusal reaches this
/// function only when `load_swap` has ALREADY decided: the reason is in hand, the current
/// scene was kept, and there is nothing to wait for.
fn deliver_load_refusal(reason: String, emit: impl FnOnce(LoadRefused)) {
    emit(LoadRefused {
        kind: LOAD_REFUSAL_KIND,
        reason,
    });
}

/// Hand ONE failed Save's reason to `emit` (phase 90 review WR-A-03): the [`LoadRefused`] frame
/// under [`SAVE_FAILURE_KIND`], down the same load-refusal `Channel`, so the shipped app's page
/// shows `Save failed` and keeps the board unsaved. The dev WebSocket sends the identical frame
/// (`fabrico_host::transport_ws::save_failed_frame`), so one frontend parser reads both.
fn deliver_save_failure(reason: String, emit: impl FnOnce(LoadRefused)) {
    emit(LoadRefused {
        kind: SAVE_FAILURE_KIND,
        reason,
    });
}

/// Forward EVERY verdict one route's gestures receive to `emit`, until the last sender of
/// the route is gone (phase 88, D-06): one task per subscription ([`open_verdict_route`]),
/// which replaced a task per gesture and its 30-second bound.
///
/// A free function taking `emit` rather than a method on [`VerdictRoutes`], for the reason
/// [`deliver_load_refusal`] is one: the forwarding is then driven directly by unit tests
/// without a Tauri `State` harness or a live webview, which matters because `npm run
/// e2e:live` drives `dev_render_server` and never this binary.
///
/// # Ordering
/// The sim thread answers on one channel in the order it decides, so this forwards in that
/// order. Verdicts and render packets still arrive in either order relative to each other
/// (two channels), which is the client's to reconcile (research Pitfall 3).
async fn forward_verdicts(mut rx: VerdictRx, mut emit: impl FnMut(VerdictFrame)) {
    while let Some(frame) = rx.recv().await {
        emit(frame);
    }
}

/// The whole of [`submit_input`], split out so it is unit-testable WITHOUT a Tauri `State`
/// harness: decode the header and body, and enqueue with a verdict sink on `verdict_tx`.
///
/// Every statement here runs INLINE on the caller's thread. Nothing awaits, nothing is
/// spawned, and the envelope is in the sim thread's channel before the function returns
/// - which is what makes a burst of gestures arrive in submission order.
///
/// # The gesture id is the client's (phase 88, D-06)
/// Until plan 88-03 this shell counted the gestures it received and a refusal named that
/// count, which the webview matched by counting its own sends: a scheme a webview reload
/// broke, since the shell's counter lived for the process and the webview's restarted. The
/// frame header now carries the client's own id, read by the one `decode_gesture` both
/// transports call, and the verdict echoes it.
///
/// # A malformed gesture is ANSWERED, not dropped
/// An undecodable or oversized frame is a refusal the user should see, and the answer is
/// already known here - no sim round trip - so it goes straight onto `verdict_tx`. It names
/// the gesture id when the header read and the body did not, and nothing when the header
/// itself was unreadable. This mirrors `service_gesture`'s inline reject arm exactly.
///
/// # A BELT-RUN PACE frame rides this path too (Phase 68, D-68-16)
/// `decode_gesture` answers a [`GestureFrame`](fabrico_host::sim_loop::GestureFrame), which is
/// either an ordinary
/// `GridCommand` or the `0xFE`-sentinel run-pace frame. Whichever it is goes onto the
/// gesture channel WHOLE - this path never narrows the frame back to a command, and
/// narrowing it would drop the run frame on the only transport the shipped binary
/// has, silently, with every other suite in the tree still green.
///
/// # Errors
/// `"decode"` if the bytes are not a valid gesture frame (the user has ALREADY been told
/// via `verdict_tx`; the string is a devtools DIAGNOSTIC, never user copy); `"sim
/// unavailable"` if the sim thread's gesture receiver has been dropped - there is nothing
/// to say about a gesture no host will ever see, so that arm answers nothing.
fn enqueue_gesture(bytes: &[u8], gesture_tx: &GestureTx, verdict_tx: &VerdictTx) -> Result<(), String> {
    match decode_gesture(bytes) {
        Ok(decoded) => gesture_tx
            .send(wire_envelope(decoded, verdict_tx))
            .map_err(|_| "sim unavailable".to_string()),
        // An undecodable frame names no command: neither `cmd` nor `node` rides it.
        Err(reject) => {
            let _ = verdict_tx.send(VerdictFrame::refused(reject.gesture_id, reject.error.into(), None));
            Err("decode".to_string())
        }
    }
}

/// Submit one render->sim gesture. Decodes the [`GridCommand`] behind a `Result` (NEVER
/// `unwrap` - threat T-07-DOS-BODY), enqueues it for the sim thread with a verdict sink
/// attached, and RETURNS - the verdict is delivered out of band on the channel
/// [`subscribe_gesture_verdicts`] opened. The sim thread still applies it via
/// `apply_gesture` (validate -> log -> fold) and the webview still never writes grid
/// state directly (SC5).
///
/// # THIS COMMAND MUST STAY NON-`async`. That is the entire point of its shape.
/// `#[tauri::command]` reads the function's `asyncness`: an `async fn` becomes
/// `ExecutionContext::Async`, whose generated body is
/// `resolver.respond_async_serialized(async move { .. })` -> `async_runtime::spawn`, and
/// the default Tauri runtime is MULTI-THREADED. Every invocation would then reach the
/// gesture channel from its own spawned task, in whatever order the scheduler picked. A
/// synchronous `fn` is `ExecutionContext::Blocking`: the body runs INLINE on the IPC
/// handler, so N back-to-back invokes enqueue in N's own order.
///
/// That ordering is load-bearing, not theoretical. `seedRouterPreset`
/// (`frontend/src/input/gestures.ts`) fires five gestures in ONE synchronous burst whose
/// order is stated in its own comment: `RemovePort{1}` then `RemovePort{0}` - highest
/// index FIRST, so the lower index stays valid as each fold lands. An inversion makes
/// the second `RemovePort` an out-of-range `CommandError::NoSuchPort` (`Malformed` until plan
/// 88-02), and the user gets "That port is not on the machine." for a plain palette click.
///
/// It was `async` between plan 64-07 and this fix, purely so it could await the verdict.
/// Nothing needed the await once the verdict rides its own channel, and since phase 88 it
/// spawns nothing either: the sink rides the envelope and the one forwarder delivers.
///
/// # Errors
/// `"decode"` for bytes that are not a valid `GridCommand`, `"sim unavailable"` if the
/// sim thread's gesture receiver has been dropped. BOTH are devtools DIAGNOSTICS and not
/// user copy - the frontend swallows the rejected promise (T-64-07-01). The user-facing
/// answer for a malformed gesture is the `Malformed` refusal pushed on the verdict
/// channel, not this string.
#[tauri::command]
fn submit_input(bytes: Vec<u8>, state: State<'_, AppState>) -> Result<(), String> {
    // INLINE. The envelope is in the sim thread's channel before this line returns, its
    // sink on the route current now (review CR-01).
    enqueue_gesture(&bytes, &state.gesture_tx, &state.verdicts.sender())
}

/// Enqueue a typed [`ControlMsg`] onto the sim thread's control channel — the ONE
/// thing every discrete control command does (SC5: never a direct state write; the
/// sim thread services the message at the tick boundary). Each command below is an
/// individually capability-scoped IPC surface (threat T-18-CMD).
///
/// # Errors
/// `"sim unavailable"` if the sim thread's control receiver has been dropped.
fn enqueue_control(state: &State<'_, AppState>, msg: ControlMsg) -> Result<(), String> {
    state
        .control_tx
        .send(msg)
        .map_err(|_| "sim unavailable".to_string())
}

/// Pause the sim: drain to quiescence, then freeze (HOST-02).
#[tauri::command]
fn pause(state: State<'_, AppState>) -> Result<(), String> {
    enqueue_control(&state, ControlMsg::Pause)
}

/// Resume live ticking from a paused/frozen sim (HOST-02).
#[tauri::command]
fn resume(state: State<'_, AppState>) -> Result<(), String> {
    enqueue_control(&state, ControlMsg::Resume)
}

/// Advance exactly one input-applying tick from frozen, staying frozen (HOST-03).
#[tauri::command]
fn step(state: State<'_, AppState>) -> Result<(), String> {
    enqueue_control(&state, ControlMsg::Step)
}

/// Save the project to `path` at quiescence via the hardened `save_project`
/// (HOST-04). `path` is the `PathBuf` the native dialog chose — the plugin yields
/// ONLY the path; this command owns the byte I/O (trust boundary T-18-DIALOG).
#[tauri::command]
fn save_project_cmd(path: String, state: State<'_, AppState>) -> Result<(), String> {
    enqueue_control(&state, ControlMsg::Save(std::path::PathBuf::from(path)))
}

/// Load the project file at `path`: swap the `!Send` Host on the sim thread via the
/// hardened `load_project` (HOST-05). `path` is the dialog-chosen `PathBuf`.
#[tauri::command]
fn load_project_cmd(path: String, state: State<'_, AppState>) -> Result<(), String> {
    enqueue_control(&state, ControlMsg::Load(std::path::PathBuf::from(path)))
}

/// Swap in THE command-built default demo scene through the host-swap path
/// (HOST-05 + LIVE-03: the toolbar "Load demo scene" CTA).
#[tauri::command]
fn load_demo(state: State<'_, AppState>) -> Result<(), String> {
    enqueue_control(&state, ControlMsg::LoadDemo)
}

/// Swap in a truly EMPTY genesis board through the host-swap path (SAVE-04: the
/// toolbar "New" CTA). Enqueues a [`ControlMsg::New`] serviced at the tick
/// boundary — the webview never touches Host state (T-18-FE-CTRL).
#[tauri::command]
fn ctrl_new(state: State<'_, AppState>) -> Result<(), String> {
    enqueue_control(&state, ControlMsg::New)
}

/// Load a shipped build-embedded example scene by wire id (EX-02: the Examples
/// popover). `scene_id` parses through the ONE typed [`SceneId`] boundary the
/// dev-WS `load_example` verb uses (T-55-04); an unknown id is a typed `Err`
/// naming the id — NEVER a silent demo load. (The JS side calls
/// `invoke('load_example', { sceneId })`; Tauri maps camelCase to this param.)
///
/// # Errors
/// `"unknown scene: <id>"` for an id that is not one of the three shipped scenes
/// (`demo_scene`, `order_processing`, `advanced`); `"sim unavailable"` if the control
/// receiver is gone.
#[tauri::command]
fn load_example(scene_id: String, state: State<'_, AppState>) -> Result<(), String> {
    match SceneId::parse(&scene_id) {
        Some(id) => enqueue_control(&state, ControlMsg::LoadScene(id)),
        None => Err(format!("unknown scene: {scene_id}")),
    }
}

/// Read a selected node's CURRENT config (CFG-01/03): send a
/// [`ControlMsg::QueryConfig`] carrying the node's dense render handle and AWAIT the
/// tick-boundary oneshot reply. Config rides the LOW-frequency control channel,
/// NEVER the 60Hz render packet (active-set discipline). `node` is the handle the
/// frontend already holds from `NodeView.id`.
///
/// # Errors
/// `"sim unavailable"` if the control receiver is gone; `"sim dropped the query"` if
/// the reply channel closed before the tick boundary answered.
#[tauri::command]
async fn machine_config(
    node: u64,
    state: State<'_, AppState>,
) -> Result<Option<ConfigView>, String> {
    let rx = send_query(&state.control_tx, |reply| ControlMsg::QueryConfig { node, reply })?;
    rx.await
        .map(|opt| opt.map(ConfigView::from))
        .map_err(|_| "sim dropped the query".to_string())
}

/// Resolve a Source node's copyable loopback webhook URL (CFG-03): send a
/// [`ControlMsg::QueryWebhookUrl`] with the node handle + the captured bound
/// [`SocketAddr`], and await the reply. `None` for a non-Source / unmapped node.
///
/// # Errors
/// `"sim unavailable"` / `"sim dropped the query"` as [`machine_config`].
#[tauri::command]
async fn webhook_url(node: u64, state: State<'_, AppState>) -> Result<Option<String>, String> {
    let addr = state.webhook_addr;
    let rx = send_query(&state.control_tx, |reply| ControlMsg::QueryWebhookUrl { node, addr, reply })?;
    rx.await.map_err(|_| "sim dropped the query".to_string())
}

/// Which SHIPPED scene the host currently holds (WR-03): the wire id of one of the three
/// shipped scenes (`Some("demo_scene")`, `Some("order_processing")` or `Some("advanced")`),
/// or `None` for a user board (`New` / a loaded `.fab`).
/// Serviced at the tick boundary over the same oneshot seam as `machine_config`.
///
/// The scene BADGE is derived from this on mount rather than from the click that
/// requested the load: the host is a long-lived process whose scene survives a
/// webview reload, so local optimistic state could name a scene the board no longer
/// (or never) held. Takes no arguments, so there is no caller input to validate.
///
/// # Errors
/// `"sim unavailable"` if the control receiver is gone; `"sim dropped the query"` if
/// the reply channel closed before the tick boundary answered.
#[tauri::command]
async fn loaded_scene(state: State<'_, AppState>) -> Result<Option<String>, String> {
    let rx = send_query(&state.control_tx, |reply| ControlMsg::QueryScene { reply })?;
    rx.await
        .map(|opt| opt.map(|id| id.wire_id().to_owned()))
        .map_err(|_| "sim dropped the query".to_string())
}

/// Pre-check Factory JS before a Configure is committed (CFG-02): send a
/// [`ControlMsg::ValidateFactoryJs`] and await `Ok(())` (compiles) or `Err(message)`
/// (the build error). The frontend gates Apply on `Ok`, so bad JS is never enqueued.
/// The inner build `Result` is flattened onto the command's own `Result`.
///
/// # Errors
/// `"sim unavailable"` / `"sim dropped the query"` on a channel failure; otherwise the
/// build error string for uncompilable JS.
#[tauri::command]
async fn validate_factory_js(source: String, state: State<'_, AppState>) -> Result<(), String> {
    let rx = send_query(&state.control_tx, |reply| ControlMsg::ValidateFactoryJs { source, reply })?;
    // Flatten: the oneshot channel error, then the inner FactoryRuntime::build Result.
    rx.await.map_err(|_| "sim dropped the query".to_string())?
}

/// Shared tick-boundary query seam (CFG-01/02/03): mint a oneshot, build the
/// [`ControlMsg`] via `make`, and send it onto the sim thread's control channel —
/// returning the receiver the caller `await`s. Factoring the send half out of the
/// three async commands keeps them thin AND makes the app-side wiring
/// (channel-forwarding + the bound-addr threading) unit-testable WITHOUT a Tauri
/// `State` harness (the sim-side resolution/formatting is host-tested).
///
/// # Errors
/// `"sim unavailable"` if the control receiver has been dropped.
fn send_query<T>(
    control_tx: &UnboundedSender<ControlMsg>,
    make: impl FnOnce(oneshot::Sender<T>) -> ControlMsg,
) -> Result<oneshot::Receiver<T>, String> {
    let (reply, rx) = oneshot::channel();
    control_tx
        .send(make(reply))
        .map_err(|_| "sim unavailable".to_string())?;
    Ok(rx)
}

/// Run the sim thread's SETUP (everything before the loop: the runtime, the store, the demo
/// boot, the listener) so that a panic in it reaches the stopped card (phase 90 review IN-A-06).
/// `fatal_reason` contains a panic only once the loop runs; a panic before it killed the sim
/// thread before it published its handles, `run()` then panicked at `handles_rx.recv()`, and
/// the app exited with no window and no message. Here a setup panic becomes the same reason
/// sentence (`sim thread panicked: ...`), raised into the held slot, and `None` comes back so
/// the caller can still let the shell open.
fn start_or_raise<T>(setup: impl FnOnce() -> T, sim_fatal: &SimFatalSlot) -> Option<T> {
    // `AssertUnwindSafe` is sound for the reason `fatal_reason` gives: after a panic nothing the
    // setup built is used again; the caller only reports and lets the shell open.
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(setup)) {
        Ok(started) => Some(started),
        Err(payload) => {
            let reason = panic_reason(payload.as_ref());
            eprintln!("fabrico: {reason}");
            sim_fatal.raise(reason);
            None
        }
    }
}

/// What the sim thread's setup builds, held for as long as the loop runs. The runtime and the
/// work folder must outlive the loop (Pitfall 4, and the store lives under the folder), so the
/// caller drops them after it, in that order.
struct StartedSim {
    rt: tokio::runtime::Runtime,
    dir: tempfile::TempDir,
    sim: SimLoop,
    bound_addr: SocketAddr,
}

/// The sim thread's setup (see [`run_sim_thread`]): build the runtime, the store, the demo board,
/// the loop and the webhook listener. A panic in here is contained by [`start_or_raise`].
fn start_sim(
    gesture_rx: GestureRx,
    control_rx: UnboundedReceiver<ControlMsg>,
    load_refusals: LoadRefusalChannel,
) -> StartedSim {
    // A dedicated multi-thread runtime for the OFF-sim-thread executor consumer
    // (real effects run on tokio workers; the sim loop stays single-threaded). Owned
    // by THIS thread so it outlives the forever `run` below (Pitfall 4).
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("build executor runtime");

    // Self-contained redb (desktop run deferred — no persisted user data yet).
    let dir = tempfile::tempdir().expect("tempdir");
    let core = Core::genesis(LogHeader {
        schema_version: SCHEMA_VERSION,
        seed: DEMO_GENESIS_SEED,
    });
    let store = RedbStore::open(dir.path().join("log.redb")).expect("open log");
    let ledger = DispatchLedger::open(dir.path().join("ledger.redb")).expect("open ledger");
    // Build the Host WITH a real persisted seen-set (HOST-06): without it
    // `record_delivery` returns `true` for every id and webhook dedup silently
    // no-ops, so a provider's at-least-once retry double-fires a Source. The
    // durable redb set survives restart (the two-line fix `tests/ingress.rs` uses).
    let seen = SeenSet::open(dir.path().join("seen.redb")).expect("open seen-set");
    let host = Host::new(core, store, ledger, None)
        .expect("open host")
        .with_seen_set(seen);

    // Boot THE command-built default demo scene at genesis (LIVE-01) through THE one
    // boot function every scene uses (plan 85-08, D-02): seed through the certified
    // gesture path, seal the history, then project the timers from the edit log the seed
    // just wrote (timers strictly AFTER seeding: a pre-installed timer would fire during
    // the seed ticks). Every node, the Route and HTTP Handler included, is a logged
    // command, so nothing is minted outside the edit log. A boot failure is a broken
    // build, not a runtime control message, so it is startup-fatal here, and the panic
    // names the scene (D-25). SimLoop::new needs no change: it reads host.core().tick as
    // its start tick (IN-01) and builds its route projection from the seeded core, so the
    // demo's Source and its Route are reachable immediately.
    let host = boot_scene(host, SceneId::Demo).unwrap_or_else(|e| panic!("fabrico: {e}"));

    // Offline-safe executor config: bind nothing real, no timers.
    // SimLoop spawns the off-thread executor consumer on `rt`'s handle.
    let cfg = HostConfig {
        webhook_addr: "127.0.0.1:0".parse().expect("loopback addr"),
    };
    // The webhook bind address is `Copy`; capture it before `cfg` moves into SimLoop.
    let webhook_addr = cfg.webhook_addr;

    // The webhook ingress channel: the listener's handler forwards each accepted
    // request on `webhook_tx`; the sim thread drains `webhook_rx` (dedup-before-log)
    // at the tick boundary. `.with_control` wires the shell's ControlMsg channel.
    // BOUNDED at WEBHOOK_INGRESS_CAPACITY (ROBUST-01) so a flood while the sim is
    // Draining/Frozen 503s deterministically (Gate B) instead of growing host memory
    // / FDs / ack oneshots without bound — mirroring the endpoint door below.
    let (webhook_tx, webhook_rx) =
        tokio::sync::mpsc::channel::<Ingress>(WEBHOOK_INGRESS_CAPACITY);
    // The endpoint ingress channel (ENDP-01): ONE channel feeds SimLoop::with_endpoint
    // so a placed/loaded Endpoint's parked socket is minted on the sim thread and
    // fulfilled by the executor-consumer reply arm. It rides the SAME loopback listener
    // + body-limit as the webhook (one server, one port). BOUNDED (F2) so a flood
    // while the sim is Frozen/Draining 503s deterministically instead of growing
    // host memory without bound.
    let (endpoint_tx, endpoint_rx) =
        tokio::sync::mpsc::channel::<EndpointIngress>(ENDPOINT_INGRESS_CAPACITY);

    // Construct the canonical loop (owns Host + RenderProducer + channels), publish a
    // render subscription to the shell BEFORE running so `subscribe_render` can
    // clone/resubscribe per connection, then drive it forever (None = live).
    let sim = SimLoop::new(host, RenderProducer::new(), rt.handle(), cfg, gesture_rx)
        // WR-03: the demo was seeded ABOVE, outside the loop, so tell the loop what
        // it is holding. Every later swap maintains the identity from inside, and
        // the `loaded_scene` query answers it - so the scene badge is derived from
        // the host rather than guessed from a click the webview may not have made.
        .with_loaded_scene(SceneId::Demo)
        .with_control(control_rx)
        .with_webhook(webhook_rx)
        .with_endpoint(endpoint_rx)
        // UNDO-09, the half `npm run e2e:live` CANNOT see: that suite drives
        // `dev_render_server`, so a WebSocket-only implementation passes every automated
        // gate in this repository and leaves the SHIPPED binary silent (ruling R-14).
        // A refused `.fab` hands its reason here, and it reaches the webview on the
        // load-refusal `Channel` the slot below holds.
        .with_save_failure_sink({
            // Phase 90 review WR-A-03: a Save the host could not write reaches the page on the
            // load-refusal channel, under its own kind.
            let channel = load_refusals.clone();
            Box::new(move |reason: String| {
                deliver_save_failure(reason, |r| channel.emit(r));
            })
        })
        .with_load_refusal_sink(Box::new(move |reason: String| {
            deliver_load_refusal(reason, |r| load_refusals.emit(r));
        }));

    // Wire the shared server to the LIVE route projection (HOST-07 / ENDP-05): the sim
    // thread publishes the `{src-<id>|/<route path> -> NodeId}` fold over this watch; the
    // handler reads the latest snapshot per request. Bind synchronously so the resolved
    // port is known. The ONE listener serves both `/hook/...` and `/endpoint/...`.
    let routes_rx = sim.routes_receiver();
    // ROBUST-01: the not-Playing signal for the webhook handler's Gate A. The sim
    // publishes `run_state == Playing` into this Arc at the end of every `step()`.
    let is_playing = sim.is_playing_flag();
    // Capture the CONCRETE bound SocketAddr (CFG-03): `webhook_addr` above requests
    // an ephemeral port (`:0`), so only the listener knows the resolved port. It is
    // threaded into `AppState` so the `webhook_url` command can format the copyable
    // loopback URL. On a bind failure fall back to the requested addr (a degraded URL
    // whose port never bound — harmless, and the eprintln already surfaces the fault).
    let bound_addr = match rt.block_on(run_webhook_listener(
        webhook_addr,
        routes_rx,
        webhook_tx,
        endpoint_tx,
        MAX_RECORD_BYTES,
        is_playing,
    )) {
        Ok(bound) => {
            println!("fabrico: webhook ingress live on http://{bound}/hook/src-<id> (loopback)");
            println!("fabrico: endpoint ingress live on http://{bound}/endpoint/route-<n> (loopback)");
            bound
        }
        Err(e) => {
            eprintln!("fabrico: webhook listener failed to bind: {e}");
            webhook_addr
        }
    };

    StartedSim {
        rt,
        dir,
        sim,
        bound_addr,
    }
}

/// The per-tick PRODUCER OWNER (W2): constructs and drives the ONE canonical
/// [`SimLoop`] on this dedicated thread (Core is `!Send`). The loop owns the `Host`
/// plus `RenderProducer` plus every internal channel and runs the unified `step()`
/// each tick (gesture drain+apply, then `tick_once`, then `producer.on_tick`). It
/// publishes the render subscription handles back to the shell once, then drives
/// `run` forever.
///
/// The shell wires NO seams: it never wires a pre-tick hook and never injects into
/// a USER's factory — the demo's timer is the DEMO board's own logged Configure,
/// projected by `boot_scene` (a `Load(path)` swap builds via `load_project` and
/// projects the user's own log). The shell boots THE command-built default scene at
/// genesis (LIVE-01: `boot_scene` before `SimLoop::new`) instead of an empty grid. `SimLoop` owns its internal ingress
/// sender, so the held-open placeholder this function used to keep is gone
/// (CLEAN-07).
fn run_sim_thread(
    gesture_rx: GestureRx,
    control_rx: UnboundedReceiver<ControlMsg>,
    handles_tx: std::sync::mpsc::Sender<(RenderHandles, SocketAddr)>,
    sim_fatal: SimFatalSlot,
    load_refusals: LoadRefusalChannel,
) {
    // Phase 90 review IN-A-06: the setup runs inside `start_or_raise`, so a panic in it (a demo
    // that does not boot, a store that does not open) reaches the stopped card instead of
    // killing this thread before it publishes its handles. The shell is then handed render
    // handles whose producer is already gone, so `subscribe_render` returns at once, the window
    // opens, and `subscribe_sim_fatal` tells the page why the simulation is not running.
    let Some(StartedSim { rt, dir, mut sim, bound_addr }) =
        start_or_raise(|| start_sim(gesture_rx, control_rx, load_refusals), &sim_fatal)
    else {
        let stopped = RenderProducer::new();
        let unbound: SocketAddr = "127.0.0.1:0".parse().expect("loopback addr");
        let _ = handles_tx.send((stopped.subscribe(), unbound));
        return;
    };
    handles_tx
        .send((sim.subscribe(), bound_addr))
        .expect("publish render subscription to the shell");
    // `run(None)` only returns on a terminal store error (the live loop is otherwise
    // forever), and a panic on this thread would end it too. `fatal_reason` runs it inside
    // `catch_unwind` and turns either into the one reason sentence both hosts use (phase 90,
    // FAIL-01, D-11). It is printed, then raised into the held slot: the slot sends it down
    // the webview's `subscribe_sim_fatal` channel now if the page has subscribed, and on
    // subscribe if it has not, so a reload is told too. The frontend opens that channel
    // before `subscribe_render` and shows `Simulation stopped`.
    let reason = fatal_reason(|| sim.run(None, fabrico_host::sim_loop::TICK_PAUSE));
    eprintln!("fabrico: {reason}");
    sim_fatal.raise(reason);
    // The loop first, then the folder its store lives under, then the runtime (the order the
    // locals dropped in before the setup moved into `start_sim`).
    drop(sim);
    drop(dir);
    drop(rt);
}

/// Launch the Fabrico desktop shell: spawn the sim thread (the per-tick producer
/// owner), wire the two capability-scoped commands to it, and run the Tauri app.
///
/// # Panics
/// Panics if the sim thread fails to publish its render subscription or if the
/// Tauri runtime fails to start (desktop run is developer-deferred this phase).
//
// `tauri::generate_context!()` expands a `std::collections::HashMap` into this
// call site, which the workspace determinism `clippy.toml` bans. That gate guards
// the deterministic SIM (fabrico-core) against order-observed iteration; this is
// generated Tauri shell wiring (config/icons), never sim state, and is never
// iterated for replay. Scope the allow narrowly to the macro site only.
#[allow(clippy::disallowed_types)]
pub fn run() {
    // Channels shared with the IPC commands (created here so they are `Send`).
    let (gesture_tx, gesture_rx) = gesture_channel();
    // Phase 88 (D-06, review CR-01): the verdict routes. Each `subscribe_gesture_verdicts`
    // opens one with its own forwarder; every gesture's sink answers on the route current
    // when it was sent.
    let verdicts = VerdictRoutes::default();
    let (control_tx, control_rx) = unbounded_channel::<ControlMsg>();
    let (handles_tx, handles_rx) = std::sync::mpsc::channel::<(RenderHandles, SocketAddr)>();
    // FAIL-01 (phase 90, D-11): the held fatal reason, shared by the sim thread (which raises
    // it) and `AppState` (whose `subscribe_sim_fatal` registers the webview's channel).
    let sim_fatal = SimFatalSlot::default();
    let sim_fatal_for_sim = sim_fatal.clone();

    // UNDO-09: the load-refusal channel slot, built HERE (it is `Send + Sync`) so one
    // clone can move into the sim thread's sink and the original can live on `AppState`
    // for `subscribe_load_refusals` to register the webview's channel into. The slot is
    // shared, so the webview subscribing LATER than the sink was built loses nothing.
    let load_refusals = LoadRefusalChannel::default();
    let load_refusals_for_sim = load_refusals.clone();
    let load_refusals_for_state = load_refusals;

    // The sim thread owns the !Send Core/Host/RenderProducer.
    thread::spawn(move || {
        run_sim_thread(
            gesture_rx,
            control_rx,
            handles_tx,
            sim_fatal_for_sim,
            load_refusals_for_sim,
        );
    });

    let ((keyframe_rx, diff_rx), webhook_addr) = handles_rx
        .recv()
        .expect("sim thread published the render subscription");

    // FABRICO_BOOT_SCENE (ALWAYS-ON, closed-set boot override, Phase 55 — RESEARCH
    // Open Question 2, option 1 ADOPTED): parse through the SAME typed SceneId
    // boundary every load path uses; the seam maps ids to build-embedded scenes
    // ONLY — it never accepts a path and never reads a file at runtime (T-55-05).
    // The sim loop is up (handles published above), so the enqueued control rides
    // the certified swap + full-keyframe path at the first tick boundary.
    //
    // NOT dev-gated, and do NOT describe it as such. There is no
    // `cfg(debug_assertions)` or feature flag on this block: it runs verbatim in a
    // release build. That is ACCEPTED (55-SECURITY.md, T-55-05) precisely BECAUSE
    // the seam is a closed set rather than an input channel, and anyone who can set
    // this env var already owns the process environment. The safety therefore rests
    // entirely on the two ONLYs above. If you widen this seam to accept a path, read
    // a file, or take any open-ended value, that acceptance no longer holds and the
    // threat must be re-dispositioned. An earlier revision of this comment claimed a
    // dev gate that never existed; the audit that caught it is why this note is here.
    //
    // `std::env::var` is on the workspace `clippy.toml` disallowed-methods list, and its
    // stated reason is "no ambient environment in the SIM CORE". This is the Tauri shell,
    // not the sim core: the sim never observes this variable, it only receives the
    // resulting `ControlMsg::LoadScene` through the same control channel every other load
    // path uses. The ban is deny-level where it means something (`fabrico-core/src/lib.rs`
    // `#![deny(clippy::disallowed_methods)]`); allowing it HERE does not weaken it there.
    #[allow(clippy::disallowed_methods)]
    let boot_scene_env = std::env::var("FABRICO_BOOT_SCENE");
    // Absent -> the shipped demo boot, untouched.
    if let Ok(val) = boot_scene_env {
        match SceneId::parse(&val) {
            Some(SceneId::OrderProcessing) => {
                let _ = control_tx.send(ControlMsg::LoadScene(SceneId::OrderProcessing));
            }
            Some(SceneId::Advanced) => {
                let _ = control_tx.send(ControlMsg::LoadScene(SceneId::Advanced));
            }
            // `demo_scene` names the shipped demo boot — already seeded, untouched.
            Some(SceneId::Demo) => {}
            None => eprintln!(
                "fabrico: FABRICO_BOOT_SCENE={val:?} is not a known scene id \
                 (expected \"demo_scene\", \"order_processing\", or \"advanced\") - booting the demo scene"
            ),
        }
    }

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(AppState {
            keyframe_rx,
            diff_rx,
            gesture_tx,
            verdicts,
            load_refusals: load_refusals_for_state,
            sim_fatal,
            control_tx,
            webhook_addr,
        });

    // THE COMMAND SURFACE. ONE list, unconditionally. Until plan 68-07 this was
    // written out TWICE - the shipped list, and a `#[cfg]`'d copy of it carrying one
    // extra development-only verb - because `generate_handler!` is a macro over a
    // fixed path list and cannot carry a `cfg` on a list ITEM. That duplicate is gone
    // with the switch it existed for (BELT-05 / D-68-12), so there is no longer a
    // second list that can silently drift from this one.
    let builder = builder.invoke_handler(tauri::generate_handler![
        subscribe_render,
        submit_input,
        subscribe_gesture_verdicts,
        subscribe_load_refusals,
        subscribe_sim_fatal,
        pause,
        resume,
        step,
        save_project_cmd,
        load_project_cmd,
        load_demo,
        load_example,
        ctrl_new,
        machine_config,
        webhook_url,
        loaded_scene,
        validate_factory_js
    ]);
    builder
        .run(tauri::generate_context!())
        .expect("error while running the Fabrico Tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use fabrico_host::command_error_view::CommandErrorView;
    use fabrico_host::sim_loop::{BeltRunPace, GestureFrame};
    use std::time::Duration;
    use fabrico_host::transport_ws::{GESTURE_FRAME_VERSION, frame_gesture};
    use std::sync::{Arc, Mutex};
    use fabrico_protocol::GridCommand;

    /// CFG-03: `webhook_url` threads the CAPTURED bound `SocketAddr` onto its
    /// `ControlMsg::QueryWebhookUrl` and forwards the sim thread's reply verbatim.
    /// Drives the real `send_query` seam + a simulated sim-thread responder (the
    /// URL-formatting itself is host-tested in `configure_host::query_webhook_url_format`).
    #[tokio::test]
    async fn webhook_url_threads_bound_addr_and_forwards_reply() {
        let (control_tx, mut control_rx) = unbounded_channel::<ControlMsg>();
        let addr: SocketAddr = "127.0.0.1:9099".parse().expect("addr");

        // The app-side send half (what the `webhook_url` command runs before await).
        let rx =
            send_query(&control_tx, |reply| ControlMsg::QueryWebhookUrl { node: 7, addr, reply })
                .expect("control channel open");

        // Simulate the sim thread servicing the control message at the tick boundary.
        match control_rx.try_recv().expect("a control message was enqueued") {
            ControlMsg::QueryWebhookUrl { node, addr: got, reply } => {
                assert_eq!(node, 7, "the selected node handle is forwarded");
                assert_eq!(got, addr, "the captured bound addr is threaded onto the query");
                let _ = reply.send(Some(format!("http://127.0.0.1:{}/hook/src-1", got.port())));
            }
            _ => panic!("expected a QueryWebhookUrl control message"),
        }

        assert_eq!(
            rx.await.expect("reply delivered"),
            Some("http://127.0.0.1:9099/hook/src-1".to_string()),
            "the command forwards the sim thread's URL reply verbatim",
        );
    }

    /// CFG-01: `machine_config` forwards the tick-boundary config reply verbatim.
    #[tokio::test]
    async fn machine_config_forwards_reply() {
        let (control_tx, mut control_rx) = unbounded_channel::<ControlMsg>();
        let rx = send_query(&control_tx, |reply| ControlMsg::QueryConfig { node: 3, reply })
            .expect("control channel open");
        match control_rx.try_recv().expect("enqueued") {
            ControlMsg::QueryConfig { node, reply } => {
                assert_eq!(node, 3);
                let _ = reply.send(Some(MachineConfig::Factory { source: "x".to_string() }));
            }
            _ => panic!("expected a QueryConfig control message"),
        }
        assert_eq!(
            rx.await.expect("reply delivered"),
            Some(MachineConfig::Factory { source: "x".to_string() }),
        );
    }

    /// CFG-02: `validate_factory_js`'s flatten forwards the inner build `Err` string.
    #[tokio::test]
    async fn validate_factory_js_flattens_build_error() {
        let (control_tx, mut control_rx) = unbounded_channel::<ControlMsg>();
        let rx =
            send_query(&control_tx, |reply| ControlMsg::ValidateFactoryJs {
                source: "bad(".to_string(),
                reply,
            })
            .expect("control channel open");
        match control_rx.try_recv().expect("enqueued") {
            ControlMsg::ValidateFactoryJs { source, reply } => {
                assert_eq!(source, "bad(");
                let _ = reply.send(Err("compile error".to_string()));
            }
            _ => panic!("expected a ValidateFactoryJs control message"),
        }
        // The command flattens `rx.await?` -> the inner build Result.
        let inner: Result<(), String> = rx.await.expect("reply delivered");
        assert_eq!(inner, Err("compile error".to_string()));
    }

    /// A dropped control receiver surfaces `"sim unavailable"` (never a panic).
    #[test]
    fn send_query_reports_sim_unavailable_when_receiver_dropped() {
        let (control_tx, control_rx) = unbounded_channel::<ControlMsg>();
        drop(control_rx);
        let result = send_query(&control_tx, |reply| ControlMsg::QueryConfig { node: 0, reply });
        assert!(matches!(result, Err(e) if e == "sim unavailable"));
    }

    // ---- ERR-01 / ROADMAP criterion 3a: the Tauri gesture verdict path -------
    //
    // THIS IS THE ONLY AUTOMATED COVERAGE THE TAURI HALF HAS ON THE RUST SIDE.
    // `crates/fabrico-app` launches no binary in CI, and Playwright-WebKit does not
    // start on every Linux distribution, so the live Playwright evidence exercises the
    // dev WebSocket only. `cargo test --workspace` - which CI runs twice - is the leg
    // that covers the transport users actually run, which is why criterion 3a names it.
    // The JavaScript half is `frontend/src/transport/tauriChannel.test.ts`.

    /// Frame a `GridCommand` exactly as the frontend does (phase 88): the header (the
    /// version byte, generation 0 and the client's gesture id), then the postcard body, so the tests below
    /// drive the real decoder over real bytes rather than a hand-built enum.
    fn encoded(cmd: &GridCommand, gesture_id: u64) -> Vec<u8> {
        frame_gesture(0, gesture_id, &postcard::to_stdvec(cmd).expect("encode a GridCommand"))
    }

    /// A fresh gesture channel. The webview's `Channel` is stood in for by a `Vec` sink in
    /// each test, since no unit test can open one.
    fn gesture_harness() -> (GestureTx, GestureRx) {
        gesture_channel()
    }

    /// THE ORDERING LOCK, and the one assertion that actually guards the defect.
    ///
    /// `#[tauri::command]` picks its execution context from the function's `asyncness`:
    /// an `async fn` is `ExecutionContext::Async` and its body is handed to
    /// `async_runtime::spawn` on a MULTI-THREADED runtime, so N invokes reach the
    /// gesture channel in whatever order the scheduler picks. A plain `fn` is
    /// `ExecutionContext::Blocking` and runs inline on the IPC handler.
    ///
    /// This coercion compiles ONLY while `submit_input` is a plain `fn` returning its
    /// `Result` directly. Make it `async` again and the item's type becomes
    /// `fn(..) -> impl Future<..>`, this line stops compiling, and `cargo test` fails to
    /// build - the loudest failure available.
    ///
    /// # What this does NOT prove, stated plainly
    /// It pins the SHAPE that makes the enqueue inline. It cannot prove Tauri's
    /// generated wrapper honours that shape, because reproducing the wry IPC handler
    /// in-process would mean reimplementing the very code under test. That half rests on
    /// `tauri-macros`' `asyncness` branch and `ipc/mod.rs`'s `ExecutionContext::Blocking`
    /// arm, which are read, not executed, here.
    #[test]
    fn submit_input_is_a_blocking_command_so_the_enqueue_is_inline() {
        let _blocking_command: for<'a> fn(Vec<u8>, State<'a, AppState>) -> Result<(), String> =
            submit_input;
    }

    /// A synchronous BURST is enqueued in submission order, and every envelope is
    /// already in the channel by the time the last call returns - no runtime, no await,
    /// no spawn anywhere in this test.
    ///
    /// The five gestures are `seedRouterPreset`'s own burst
    /// (`frontend/src/input/gestures.ts`), whose order its comment states is load
    /// bearing: `RemovePort{index:1}` BEFORE `RemovePort{index:0}`, highest index first
    /// so the lower one stays valid as each fold lands. An inversion makes the second
    /// removal out of range, which `fabrico-command` refuses as `NoSuchPort` (`Malformed`
    /// until plan 88-02) - the user gets "That port is not on the machine." for a plain
    /// palette click.
    #[test]
    fn a_burst_of_gestures_is_enqueued_in_submission_order() {
        let (gesture_tx, mut gesture_rx) = gesture_harness();
        let (verdict_tx, mut verdict_rx) = verdict_channel();
        let burst = [
            GridCommand::RemovePort { node: 9, index: 1 },
            GridCommand::RemovePort { node: 9, index: 0 },
            // The three preset legs, `ROUTER_PRESET_PORT_LEGS` verbatim: In@W, Out@E,
            // Out@E, all at the Mechanical medium.
            GridCommand::AddPort { node: 9, role: 0, side: 3, medium: 0 },
            GridCommand::AddPort { node: 9, role: 1, side: 1, medium: 0 },
            GridCommand::AddPort { node: 9, role: 1, side: 1, medium: 0 },
        ];
        for (i, cmd) in burst.iter().enumerate() {
            enqueue_gesture(&encoded(cmd, i as u64 + 1), &gesture_tx, &verdict_tx)
                .expect("gesture channel open");
        }
        assert!(verdict_rx.try_recv().is_err(), "a well-formed gesture is answered by the sim, not here");
        // ALREADY queued: `try_recv` never waits, so a `submit_input` that deferred its
        // send to a spawned task could not satisfy this loop.
        for (i, expected) in burst.into_iter().enumerate() {
            let env = gesture_rx.try_recv().expect("the envelope was enqueued inline");
            assert_eq!(
                env.cmd,
                GestureFrame::Cmd(expected),
                "the burst arrives in submission order"
            );
            assert_eq!(
                env.verdict.as_ref().map(fabrico_host::gesture_verdict::VerdictSink::gesture_id),
                Some(i as u64 + 1),
                "a verdict sink naming the client's own gesture id is attached to every gesture"
            );
            assert_eq!(env.generation, Some(0), "the envelope carries the header's generation");
        }
    }

    /// A MALFORMED gesture is ANSWERED with `Malformed` rather than dropped, naming the
    /// client's gesture id when the header read and nothing when it did not (phase 88, D-06).
    ///
    /// # MOVED BY PLAN 88-03
    /// This case was `a_malformed_gesture_consumes_a_sequence_number_and_is_answered` and
    /// pinned D-04's paired counters: a malformed frame bumped this shell's counter like a
    /// valid one, so the next gesture got seq 3. The counter is gone; the client names each
    /// gesture in the frame header, so what is pinned now is which id a refusal carries.
    ///
    /// # It still covers the run-pace sentinel's non-collision (Phase 68)
    /// `0xFF` is still rejected as a body (the neighbouring byte the non-collision argument
    /// cites), and a BARE `0xFE` body with nothing behind it is rejected too - the
    /// sentinel's own truncated-frame case, which must be a typed refusal and never a panic.
    #[test]
    fn a_malformed_gesture_is_answered_with_its_own_id_or_none() {
        let (gesture_tx, mut gesture_rx) = gesture_harness();
        let (verdict_tx, mut verdict_rx) = verdict_channel();
        let malformed = |seq: Option<u64>| VerdictFrame::refused(seq, CommandErrorView::Malformed, None);

        // A frame whose HEADER cannot be read: the version byte, then three continuation
        // bytes and nothing after.
        let err = enqueue_gesture(&[GESTURE_FRAME_VERSION, 0xFF, 0xFF, 0xFF], &gesture_tx, &verdict_tx)
            .expect_err("an unreadable header is rejected");
        assert_eq!(err, "decode", "the diagnostic string is unchanged");
        assert_eq!(
            verdict_rx.try_recv().expect("answered"),
            malformed(None),
            "the user is TOLD the gesture was unreadable, and it names no gesture id",
        );

        // A readable header (gesture 1) over a body that is not a `GridCommand`: `0xFF` is
        // not a valid postcard discriminant, and it is not the run-pace sentinel either.
        let err = enqueue_gesture(&frame_gesture(0, 1, &[0xFF, 0xFF, 0xFF]), &gesture_tx, &verdict_tx)
            .expect_err("an undecodable body is rejected");
        assert_eq!(err, "decode");
        assert_eq!(verdict_rx.try_recv().expect("answered"), malformed(Some(1)), "names gesture 1");

        // A BARE 0xFE body: the run-pace sentinel with NO body. It routes into the run-pace
        // branch and must come back a typed refusal - never an index panic, never a frame
        // forwarded to the sim.
        let err = enqueue_gesture(&frame_gesture(0, 2, &[0xFE]), &gesture_tx, &verdict_tx)
            .expect_err("a bare sentinel with no body is rejected");
        assert_eq!(err, "decode");
        assert_eq!(
            verdict_rx.try_recv().expect("answered"),
            malformed(Some(2)),
            "the truncated run frame is ANSWERED, on the same seam as any other",
        );
        assert!(
            gesture_rx.try_recv().is_err(),
            "nothing is forwarded to the sim for an undecodable gesture",
        );

        // A valid gesture names its own id, whatever came before it.
        enqueue_gesture(
            &encoded(&GridCommand::Place { kind: 0, cell_x: 4, cell_y: 5 }, 3),
            &gesture_tx,
            &verdict_tx,
        )
        .expect("gesture channel open");
        let env = gesture_rx.try_recv().expect("enqueued");
        assert_eq!(
            env.verdict.as_ref().map(fabrico_host::gesture_verdict::VerdictSink::gesture_id),
            Some(3),
            "the id is the one the frame header carries"
        );
        assert!(verdict_rx.try_recv().is_err(), "and nothing was answered for it here");
    }

    /// Security T-88-09 on the Tauri transport: a frame from a page on an older wire is
    /// refused as unreadable, naming no gesture, and nothing reaches the sim. A pre-88 bare
    /// `Dock { belt 9, Tail, node 5, port 0 }` once read here as gesture 9, `Delete { node: 5 }`.
    #[test]
    fn a_frame_from_an_older_wire_is_refused_on_the_tauri_transport() {
        let (gesture_tx, mut gesture_rx) = gesture_harness();
        let (verdict_tx, mut verdict_rx) = verdict_channel();
        let dock = GridCommand::Dock {
            belt: 9,
            endpoint: fabrico_protocol::BeltEnd::Tail,
            node: 5,
            port: 0,
        };
        let bare = postcard::to_stdvec(&dock).expect("encode a GridCommand");
        let err = enqueue_gesture(&bare, &gesture_tx, &verdict_tx).expect_err("a pre-88 bare frame is rejected");
        assert_eq!(err, "decode");
        assert_eq!(
            verdict_rx.try_recv().expect("answered"),
            VerdictFrame::refused(None, CommandErrorView::Malformed, None),
            "refused as unreadable, naming no gesture id",
        );
        assert!(gesture_rx.try_recv().is_err(), "nothing is forwarded to the sim");

        // The control: the same Dock on this wire reaches the sim as the Dock.
        enqueue_gesture(&encoded(&dock, 9), &gesture_tx, &verdict_tx).expect("gesture channel open");
        assert_eq!(gesture_rx.try_recv().expect("enqueued").cmd, GestureFrame::Cmd(dock));
    }

    /// THE SECOND TRANSPORT (Phase 68, threat T-68-02-08). A VALID three-belt run
    /// frame handed to the TAURI ingress puts a RUN-PACE envelope on the gesture
    /// channel.
    ///
    /// # Why this case exists when the host already has thirteen of them
    /// Every other run-frame assertion in this phase rides the host decode path, the
    /// mock browser socket or the dev WebSocket server. NOT ONE of them touches
    /// `enqueue_gesture`, which is the only transport the shipped binary has. A build
    /// that narrowed the decoded frame back to a `GridCommand` here would drop or reject
    /// every run frame on the real app while `belt_run_pace.rs`, the mock spec and the
    /// live spec all stayed green.
    ///
    /// The assertion is therefore on the envelope's VARIANT AND CONTENTS, never on an
    /// `Ok` return: a narrowed path still returns `Ok` for an ordinary `GridCommand`
    /// frame, so the run frame is the only input that separates the two.
    #[test]
    fn a_run_pace_frame_reaches_the_gesture_channel_on_the_tauri_transport() {
        let (gesture_tx, mut gesture_rx) = gesture_harness();
        let (verdict_tx, _verdict_rx) = verdict_channel();

        // The browser's bytes, assembled by hand: the phase 88 header (the version byte,
        // generation 2, gesture 1), then the `encodeBeltRunPace` grammar: the sentinel as
        // ONE RAW BYTE, then varintU(3), three handles, the interval.
        let frame: Vec<u8> = vec![0xF1, 2, 1, 0xFE, 3, 4, 9, 21, 10];
        enqueue_gesture(&frame, &gesture_tx, &verdict_tx).expect("gesture channel open");

        let env = gesture_rx
            .try_recv()
            .expect("the run envelope was enqueued INLINE, like every other gesture");
        assert_eq!(
            env.cmd,
            GestureFrame::RunPace(BeltRunPace {
                belts: vec![4, 9, 21],
                ticks_per_slot: 10,
            }),
            "the TAURI path carries the run frame WHOLE - variant and contents",
        );
        assert_eq!(
            env.verdict.as_ref().map(fabrico_host::gesture_verdict::VerdictSink::gesture_id),
            Some(1),
            "the verdict seam is inherited by the run frame with no new plumbing",
        );
        assert_eq!(env.generation, Some(2), "and so is the header's generation");
    }

    /// A dropped gesture RECEIVER (the sim thread is gone) surfaces `"sim unavailable"`
    /// and never a panic, and answers nothing. Mirrors
    /// `send_query_reports_sim_unavailable_when_receiver_dropped`.
    #[test]
    fn enqueue_reports_sim_unavailable_when_receiver_dropped() {
        let (gesture_tx, gesture_rx) = gesture_channel();
        let (verdict_tx, mut verdict_rx) = verdict_channel();
        drop(gesture_rx);
        let result = enqueue_gesture(
            &encoded(&GridCommand::Place { kind: 0, cell_x: 0, cell_y: 0 }, 1),
            &gesture_tx,
            &verdict_tx,
        );
        assert!(matches!(result, Err(e) if e == "sim unavailable"));
        assert!(verdict_rx.try_recv().is_err(), "there is nothing to say about a gesture no host will see");
    }

    /// Run the one forwarder over `rx` into a shared `Vec`, as `run()` runs it into the
    /// webview's channel, and return the `Vec`.
    fn spawn_forwarder(rx: VerdictRx) -> Arc<Mutex<Vec<VerdictFrame>>> {
        let emitted = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&emitted);
        tokio::spawn(forward_verdicts(rx, move |frame| {
            sink.lock().expect("unpoisoned").push(frame);
        }));
        emitted
    }

    /// Let the forwarder task run until it has emitted `n` frames (bounded, never a hang).
    async fn settle(emitted: &Arc<Mutex<Vec<VerdictFrame>>>, n: usize) {
        for _ in 0..100 {
            if emitted.lock().expect("unpoisoned").len() >= n {
                return;
            }
            tokio::task::yield_now().await;
        }
    }

    /// Plan 74.1-28 (re-walk G1): on the TAURI transport too, a refused `AddPort` names
    /// its command and node, read off the decoded frame with the SAME
    /// `GestureFrame::subject` the dev WebSocket uses, and serialized as
    /// `{kind, seq, tag, cmd, node}` exactly.
    #[tokio::test]
    async fn a_refused_add_port_names_its_command_and_node_on_the_tauri_transport() {
        let (gesture_tx, mut gesture_rx) = gesture_harness();
        let (verdict_tx, verdict_rx) = verdict_channel();
        let emitted = spawn_forwarder(verdict_rx);
        let cmd = GridCommand::AddPort { node: 300, role: 1, side: 1, medium: 0 };
        enqueue_gesture(&encoded(&cmd, 1), &gesture_tx, &verdict_tx).expect("gesture channel open");
        let env = gesture_rx.try_recv().expect("enqueued inline");
        env.verdict.expect("a sink").refused(CommandErrorView::GrowCoversBelt);
        settle(&emitted, 1).await;
        let emitted = emitted.lock().expect("unpoisoned").clone();
        assert_eq!(emitted.len(), 1, "one refusal");
        assert_eq!(
            serde_json::to_value(&emitted[0]).unwrap(),
            serde_json::json!({
                "kind": "gestureRefused",
                "seq": 1,
                "tag": "GrowCoversBelt",
                "cmd": "AddPort",
                "node": 300,
            }),
            "the refusal names the AddPort and its node, field for field the dev wire's",
        );
    }

    /// ROADMAP criterion 3, CI-blocking half: a specific typed refusal reaches the TAURI
    /// surface as THAT EXACT tag - not as "an error", not as a generic string, and not
    /// as the silence phase 64 existed to end.
    ///
    /// MOVED BY PLAN 88-03: this was `deliver_verdict_emits_the_exact_refusal_tag_roadmap_criterion_3a`,
    /// over the per-gesture delivery task phase 88 deleted; it now drives the one forwarder.
    #[tokio::test]
    async fn the_forwarder_emits_the_exact_refusal_tag_roadmap_criterion_3a() {
        let (verdict_tx, verdict_rx) = verdict_channel();
        let emitted = spawn_forwarder(verdict_rx);
        let subject = fabrico_host::sim_loop::GestureSubject { cmd: "Place", node: None };
        fabrico_host::gesture_verdict::VerdictSink::new(7, subject, verdict_tx)
            .refused(CommandErrorView::MediumMismatch);
        settle(&emitted, 1).await;
        assert_eq!(
            *emitted.lock().expect("unpoisoned"),
            vec![VerdictFrame::refused(Some(7), CommandErrorView::MediumMismatch, Some(subject))],
            "the refusal arrives as MediumMismatch on the gesture it answers, not merely as \
             some error",
        );
    }

    /// Phase 88 (D-06): an ACCEPTED gesture is answered on this transport too, naming the
    /// handles it minted and their generation.
    ///
    /// MOVED BY PLAN 88-03 (Pitfall 8): this was `deliver_verdict_is_silent_for_an_accepted_gesture`
    /// (D-30, "an Ok writes nothing"). What stays silent is the USER-facing side: the
    /// webview shows no sentence for an accept.
    #[tokio::test]
    async fn an_accepted_gesture_is_emitted_naming_the_handles_it_minted() {
        let (gesture_tx, mut gesture_rx) = gesture_harness();
        let (verdict_tx, verdict_rx) = verdict_channel();
        let emitted = spawn_forwarder(verdict_rx);
        let place = GridCommand::Place { kind: 0, cell_x: 2, cell_y: 2 };
        enqueue_gesture(&encoded(&place, 4), &gesture_tx, &verdict_tx).expect("enqueued");
        gesture_rx.try_recv().expect("enqueued").verdict.expect("a sink").accepted(3, vec![12]);
        settle(&emitted, 1).await;
        assert_eq!(
            serde_json::to_value(&emitted.lock().expect("unpoisoned")[0]).unwrap(),
            serde_json::json!({"kind": "gestureAccepted", "seq": 4, "generation": 3, "minted": [12]}),
        );
    }

    /// A sink dropped UNANSWERED - the sim died mid-flight after taking the envelope -
    /// yields SILENCE, never a fabricated failure. The gesture may well have been applied;
    /// telling the user it failed would be an invented answer.
    ///
    /// MOVED BY PLAN 88-03: this was `deliver_verdict_is_silent_when_the_sim_drops_the_reply_sender`;
    /// the dropped thing is now the envelope's sink rather than a oneshot sender.
    #[tokio::test]
    async fn a_sink_dropped_unanswered_emits_nothing() {
        let (gesture_tx, mut gesture_rx) = gesture_harness();
        let (verdict_tx, verdict_rx) = verdict_channel();
        let emitted = spawn_forwarder(verdict_rx);
        enqueue_gesture(&encoded(&GridCommand::Undo, 1), &gesture_tx, &verdict_tx).expect("enqueued");
        drop(gesture_rx.try_recv().expect("enqueued"));
        settle(&emitted, 1).await;
        assert!(
            emitted.lock().expect("unpoisoned").is_empty(),
            "a dead sim is silence, never a fabricated refusal",
        );
    }

    /// PITFALL 2, PINNED (phase 88, D-06). On a PAUSED board the drain never runs, so a
    /// gesture's answer can come minutes after it was sent. The per-gesture delivery task
    /// this shell had until plan 88-03 freed itself after `GESTURE_VERDICT_BOUND` (30 s) in
    /// silence, which, once every accept is answered, would strand the gesture's follow-ups
    /// in the shipped binary only. With the one forwarder there is no bound: on a paused
    /// clock advanced 120 seconds, a verdict answered afterwards is still emitted.
    ///
    /// MOVED BY PLAN 88-03: this replaces `the_verdict_bound_frees_a_delivery_task_no_one_answers`,
    /// which pinned the bound this test now pins the absence of.
    ///
    /// THROUGH THE ROUTE LAYER (phase 88 security, T-88-24). Since review CR-01 the shipped
    /// path is not the bare forwarder: `subscribe_gesture_verdicts` spawns
    /// [`open_verdict_route`], and `submit_input` hands the sink [`VerdictRoutes::sender`].
    /// This test drove `forward_verdicts` directly until then, so a time bound added in
    /// `open_verdict_route` or in the route's current-check passed it. It now subscribes and
    /// enqueues exactly as those two commands do, so either bound turns it red (both measured
    /// as scratch mutations: a 30-second `timeout` around the route's forwarder, and a route
    /// that stops counting as current 30 seconds after it opened). A second gesture is sent
    /// two minutes into the pause, so a bound on the route's age inside `sender()` turns it
    /// red too (the re-audit's mutation: a dead sender once the route is 30 seconds old).
    ///
    /// WHAT THIS TEST CANNOT SEE (the third security challenge, T-88-24). It moves only tokio's
    /// paused clock, so a bound read from `std::time::Instant` or `SystemTime` passes it
    /// (measured: green under a 30-second `std::time::Instant` age bound in `sender()`). That
    /// bound fails the clippy gate instead: `clippy.toml` denies both types and their `now` and
    /// `elapsed` workspace-wide, and `-D warnings` makes that an error (measured: four errors on
    /// the same mutation). A bound on the sim thread, counted in its own paused steps, needs no
    /// clock; `tests/edit_lands_where_aimed.rs` in `fabrico-host` pins that half
    /// (`a_gesture_held_through_two_minutes_of_paused_steps_is_accepted_on_play`).
    #[tokio::test(start_paused = true)]
    async fn a_verdict_answered_after_a_long_pause_is_still_emitted() {
        let (gesture_tx, mut gesture_rx) = gesture_harness();
        let routes = VerdictRoutes::default();
        // The page subscribes, as `subscribe_gesture_verdicts` does: open a route and spawn
        // its forwarder (onto this test's paused runtime rather than Tauri's).
        let emitted = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&emitted);
        tokio::spawn(open_verdict_route(&routes, move |frame| {
            sink.lock().expect("unpoisoned").push(frame);
        }));
        let place = GridCommand::Place { kind: 0, cell_x: 6, cell_y: 6 };
        // The page sends a gesture, as `submit_input` does: its sink rides the current route.
        enqueue_gesture(&encoded(&place, 9), &gesture_tx, &routes.sender()).expect("enqueued");
        let early = gesture_rx.try_recv().expect("enqueued: the board is paused, the gesture waits");

        // Let the forwarder run up to its wait on the channel BEFORE the clock moves, so any
        // timer it arms is armed at the start of the pause. Without this the spawned task is
        // first polled after the jump, a bound it arms starts there, and the test cannot see
        // one (a 30-second idle bound put back on the forwarder passed it until this line).
        let start = tokio::time::Instant::now();
        pause_for(Duration::from_secs(120)).await;

        // A SECOND gesture, sent only now, on a route that has been open for two minutes
        // (phase 88 security re-audit, T-88-24). Every other `sender()` call in this file runs
        // at zero elapsed time, so a bound on the route's age inside `VerdictRoutes::sender`
        // (a dead sender handed out once the route is 30 seconds old) passed this test while
        // only the first gesture was sent, before the clock moved. In the shipped app the page
        // subscribes once per load, so such a bound would silence every gesture after the
        // first 30 seconds of page life.
        let rotate = GridCommand::Rotate { node: 5, ccw: false };
        enqueue_gesture(&encoded(&rotate, 10), &gesture_tx, &routes.sender()).expect("enqueued");
        let late = gesture_rx.try_recv().expect("enqueued: the board is still paused");
        pause_for(Duration::from_secs(120)).await;

        assert!(start.elapsed() >= Duration::from_secs(240), "PRECONDITION: four minutes passed");
        settle(&emitted, 2).await;
        assert!(
            emitted.lock().expect("unpoisoned").is_empty(),
            "nothing is emitted while the gestures wait: no timeout invents an answer"
        );

        early.verdict.expect("a sink").accepted(1, vec![5]);
        late.verdict.expect("a sink").accepted(1, vec![]);
        settle(&emitted, 2).await;
        assert_eq!(
            *emitted.lock().expect("unpoisoned"),
            vec![VerdictFrame::accepted(9, 1, vec![5]), VerdictFrame::accepted(10, 1, vec![])],
            "both accepts reach the webview: the one sent before a four-minute pause, and the one \
             sent two minutes into it on a route opened at the start"
        );
    }

    /// Hold a paused tokio clock still for `pause` (T-88-24): the spawned forwarder runs up to
    /// its wait first, the clock jumps, and every task then reacts to whatever the jump fired.
    async fn pause_for(pause: Duration) {
        for _ in 0..10 {
            tokio::task::yield_now().await;
        }
        tokio::time::advance(pause).await;
        for _ in 0..10 {
            tokio::task::yield_now().await;
        }
    }

    /// A page's channel as `subscribe_gesture_verdicts` builds it: a REAL
    /// `tauri::ipc::Channel` whose messages land, as JSON, in the returned receiver.
    fn page_channel() -> (Channel<VerdictFrame>, std::sync::mpsc::Receiver<serde_json::Value>) {
        let (tx, rx) = std::sync::mpsc::channel::<serde_json::Value>();
        let channel = Channel::new(move |body: InvokeResponseBody| {
            let _ = tx.send(body.deserialize::<serde_json::Value>().expect("JSON"));
            Ok(())
        });
        (channel, rx)
    }

    /// Subscribe `channel` exactly as `subscribe_gesture_verdicts` does: open a route on
    /// `routes` and spawn its forwarder onto `rt`.
    fn subscribe(routes: &VerdictRoutes, channel: Channel<VerdictFrame>, rt: &tokio::runtime::Handle) {
        rt.spawn(open_verdict_route(routes, move |frame| {
            let _ = channel.send(frame);
        }));
    }

    /// Wait (bounded) until `rx` has `n` frames, then return every frame it holds.
    fn frames_after(rx: &std::sync::mpsc::Receiver<serde_json::Value>, n: usize) -> Vec<serde_json::Value> {
        // A bounded count of short waits (about 5 s at most), never a wall-clock read: the
        // workspace bans `Instant` outside the shell's own wiring.
        let mut got = Vec::new();
        for _ in 0..250 {
            if got.len() >= n {
                break;
            }
            if let Ok(v) = rx.recv_timeout(Duration::from_millis(20)) {
                got.push(v);
            }
        }
        // Anything more that is already on its way.
        std::thread::sleep(Duration::from_millis(100));
        got.extend(rx.try_iter());
        got
    }

    /// The verdict route itself, driven through a REAL `tauri::ipc::Channel`, so the JSON
    /// the webview receives is pinned here rather than inferred.
    ///
    /// This is the exact frame `frontend/src/transport/transport.ts::parseGestureVerdict`
    /// parses, and the exact frame `transport_ws` writes on the dev wire.
    ///
    /// MOVED BY THE PHASE 88 REVIEW FIX (CR-01): this drove the one channel slot
    /// (`VerdictChannel`) the fix replaced with a route per subscription.
    #[test]
    fn a_subscribed_verdict_route_receives_the_dev_wire_frame_verbatim() {
        let rt = tokio::runtime::Runtime::new().expect("runtime");
        let routes = VerdictRoutes::default();

        // Before any subscription, a verdict is dropped rather than panicking.
        let _ = routes
            .sender()
            .send(VerdictFrame::refused(Some(1), CommandErrorView::OutOfBounds, None));

        let (channel, rx) = page_channel();
        subscribe(&routes, channel, rt.handle());
        let tx = routes.sender();
        let _ = tx.send(VerdictFrame::refused(Some(4), CommandErrorView::MediumMismatch, None));
        let _ = tx.send(VerdictFrame::accepted(5, 2, vec![8, 9]));
        let _ = tx.send(VerdictFrame::discarded(6));

        let frames = frames_after(&rx, 3);
        assert_eq!(
            frames,
            vec![
                serde_json::json!({"kind": "gestureRefused", "seq": 4, "tag": "MediumMismatch"}),
                serde_json::json!({"kind": "gestureAccepted", "seq": 5, "generation": 2, "minted": [8, 9]}),
                serde_json::json!({"kind": "gestureDiscarded", "seq": 6}),
            ],
            "the Tauri verdict frames are field-for-field the dev WebSocket's, and nothing sent \
             before the subscription arrives",
        );
        assert!(
            frames[0]["tag"].is_string(),
            "the tag is a BARE string the copy table keys on, never an object",
        );
    }

    /// THE WEBVIEW RELOAD (phase 88 review, CR-01), on the Tauri transport end to end: the
    /// real `enqueue_gesture` (`submit_input`'s whole body), the real route a
    /// `subscribe_gesture_verdicts` opens, real `tauri::ipc::Channel`s, and the real
    /// `SimLoop` drain and tick that answer the gestures.
    ///
    /// The old page sends gesture 1, a Place of Source A at (4,4), which the host holds
    /// queued. The webview reloads: the new page subscribes and its counter restarts, so its
    /// first gesture is gesture 1 again, a Place of Source B at (10,4). One drain folds both.
    /// The new page must hear exactly one verdict, its own: the accept naming B's handle.
    ///
    /// RED BEFORE THE FIX (the one-slot shell), measured with this test's twin over that
    /// API: the new page heard TWO accepts with seq 1, A's first (`minted [0]`), so it would
    /// have paired A's handle with B's gesture and sent B's Rotate to A.
    #[test]
    fn a_webview_reload_never_hands_the_old_pages_verdict_to_the_new_page() {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("runtime");
        let dir = tempfile::tempdir().expect("tempdir");
        let core = Core::genesis(LogHeader {
            schema_version: SCHEMA_VERSION,
            seed: 1,
        });
        let store = RedbStore::open(dir.path().join("log.redb")).expect("store");
        let ledger = DispatchLedger::open(dir.path().join("ledger.redb")).expect("ledger");
        let host = Host::new(core, store, ledger, None).expect("host");
        let cfg = HostConfig {
            webhook_addr: "127.0.0.1:0".parse().expect("loopback addr"),
        };
        let (gesture_tx, gesture_rx) = gesture_channel();
        let mut sim = SimLoop::new(host, RenderProducer::new(), rt.handle(), cfg, gesture_rx);
        let (_keyframe, mut diff) = sim.subscribe();
        let routes = VerdictRoutes::default();
        let place = |x: i32, y: i32| GridCommand::Place {
            kind: fabrico_protocol::machine_kind::SOURCE,
            cell_x: x,
            cell_y: y,
        };

        // The old page: subscribe, then gesture 1, held in the host's queue.
        let (old_page, old_rx) = page_channel();
        subscribe(&routes, old_page, rt.handle());
        enqueue_gesture(&encoded(&place(4, 4), 1), &gesture_tx, &routes.sender()).expect("old page's gesture 1");
        // The reload: the new page subscribes, and its first gesture is gesture 1 again.
        let (new_page, new_rx) = page_channel();
        subscribe(&routes, new_page, rt.handle());
        enqueue_gesture(&encoded(&place(10, 4), 1), &gesture_tx, &routes.sender()).expect("new page's gesture 1");

        sim.run(Some(4), Duration::ZERO).expect("drain and fold both");
        // B's handle, read off the packets the producer broadcast, as the new page reads it.
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
        let handle_at = |c: (i32, i32)| {
            cells
                .iter()
                .find(|(_, at)| **at == c)
                .map(|(h, _)| *h)
                .unwrap_or_else(|| panic!("PRECONDITION: a Source is drawn at {c:?}: {cells:?}"))
        };
        let (a, b) = (handle_at((4, 4)), handle_at((10, 4)));
        assert_ne!(a, b, "PRECONDITION: A and B are two nodes");

        let heard = frames_after(&new_rx, 1);
        eprintln!("CR-01 RELOAD a=h{a} b=h{b} new_page={heard:?}");
        assert_eq!(
            heard,
            vec![serde_json::json!({"kind": "gestureAccepted", "seq": 1, "generation": 0, "minted": [b]})],
            "the new page hears exactly one verdict, its own gesture's accept naming B; the old \
             page's gesture 1 is never answered on the new page"
        );
        assert!(
            old_rx.try_iter().next().is_none(),
            "and the superseded route delivers nothing: its page is gone"
        );
    }

    // ---- UNDO-09: the Tauri half of the load refusal -------------------------
    //
    // WHY THESE EXIST AND WHAT THEY REPLACE. `npm run e2e:live` builds and runs
    // `cargo build -p fabrico-host --example dev_render_server`, so the LIVE suite
    // exercises the WebSocket transport and NOTHING ELSE. A WebSocket-only
    // implementation of UNDO-09 would pass all five gates and be invisible in the
    // shipped binary - the same class as the three live defects plan 72-13 found, and
    // the same class as 73-03's dead `capture_deleted_subgraph`, whose one production
    // caller the host gesture path never reached. Ruling R-14 splits the coverage
    // explicitly; these three tests plus the cross-language parity test in
    // `fabrico_host::command_error_view` are this half of it. The residual - the whole
    // path on the real WebKitGTK binary - is checked by a manual walk-through of the
    // built app, and it is a STATED residual rather than silence.

    /// The emit decision, driven as the free function it is written as. No Tauri `State`
    /// harness and no live webview, which is the whole reason `deliver_load_refusal`
    /// takes `emit` rather than being a method on `LoadRefusalChannel`.
    #[test]
    fn a_load_refusal_is_emitted_with_the_hosts_reason() {
        let mut emitted = Vec::new();
        deliver_load_refusal(
            "malformed project file (postcard decode failed).".to_owned(),
            |r| emitted.push(r),
        );
        assert_eq!(
            emitted,
            vec![LoadRefused {
                kind: LOAD_REFUSAL_KIND,
                reason: "malformed project file (postcard decode failed).".to_owned(),
            }],
            "the host's own sentence crosses VERBATIM, on the shared discriminator - not \
             re-authored, not summarised, not replaced by a generic string",
        );
    }

    /// Phase 90 review WR-A-03: a failed Save crosses on the load-refusal channel under the
    /// save-failure kind, the host's sentence verbatim.
    #[test]
    fn a_save_failure_is_emitted_with_the_hosts_reason_under_its_own_kind() {
        let mut emitted = Vec::new();
        deliver_save_failure("project file io error: disk full.".to_owned(), |r| emitted.push(r));
        assert_eq!(
            emitted,
            vec![LoadRefused {
                kind: SAVE_FAILURE_KIND,
                reason: "project file io error: disk full.".to_owned(),
            }],
            "the failed Save's sentence crosses on its own kind, not as a load refusal",
        );
    }

    /// A webview that dropped its channel is DISCARDED rather than propagated: there is
    /// no user left to tell. Asserted through a real `tauri::ipc::Channel` whose handler
    /// returns an error, which is the shape a torn-down webview presents.
    #[test]
    fn a_dropped_subscriber_discards_the_refusal_without_panicking() {
        let refusals = LoadRefusalChannel::default();

        // Before ANY subscription: dropped, and not a panic. This is also the honest
        // baseline for the assertion below.
        refusals.emit(LoadRefused {
            kind: LOAD_REFUSAL_KIND,
            reason: "nobody is listening yet.".to_owned(),
        });

        // A channel whose handler fails, exactly as a dropped webview's does.
        refusals.register(Channel::new(|_body: InvokeResponseBody| {
            Err(tauri::Error::WebviewNotFound)
        }));
        refusals.emit(LoadRefused {
            kind: LOAD_REFUSAL_KIND,
            reason: "the webview went away mid-load.".to_owned(),
        });
        // Reaching here at all is the assertion: a send failure must never unwind onto
        // the SIM THREAD, which is where this sink is called from.
    }

    /// The `PoisonError::into_inner` path is EXERCISED, not merely written. A poisoned
    /// lock must not turn one panicking task into a permanently silent refusal path,
    /// which is precisely the defect UNDO-09 exists to end arriving by a side door.
    #[test]
    fn a_poisoned_channel_lock_still_delivers() {
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        let refusals = LoadRefusalChannel::default();
        refusals.register(Channel::new(move |body: InvokeResponseBody| {
            let _ = tx.send(body.deserialize::<serde_json::Value>().unwrap().to_string());
            Ok(())
        }));

        // POISON THE LOCK FOR REAL: panic while holding it, on a thread whose panic is
        // caught. `unwrap()` in `emit` would propagate this forever after.
        let poisoner = refusals.clone();
        let joined = std::thread::spawn(move || {
            let _guard = poisoner.0.lock().expect("first lock is unpoisoned");
            panic!("poison the mutex");
        })
        .join();
        assert!(joined.is_err(), "the poisoning thread must actually have panicked");
        assert!(
            refusals.0.lock().is_err(),
            "control: the lock is genuinely poisoned, so the next assertion is not vacuous",
        );

        refusals.emit(LoadRefused {
            kind: LOAD_REFUSAL_KIND,
            reason: "a poisoned lock must not silence this.".to_owned(),
        });
        let frame: serde_json::Value =
            serde_json::from_str(&rx.try_recv().expect("the refusal reached the channel")).unwrap();
        assert_eq!(
            frame,
            serde_json::json!({
                "kind": "loadRefused",
                "reason": "a poisoned lock must not silence this.",
            }),
            "the Tauri load-refusal frame is field-for-field the dev WebSocket's \
             LoadRefusedFrame, and a poisoned lock does not stop it",
        );
    }

    /// `subscribe_load_refusals` is REGISTERED in the one command surface, not merely
    /// defined. A command defined and never registered is a webview that can never
    /// subscribe, and the shipped binary goes silent with every Rust test green.
    #[test]
    fn subscribe_load_refusals_is_in_the_registered_command_surface() {
        const LIB_RS: &str = include_str!("lib.rs");
        let handler_start = LIB_RS
            .find("tauri::generate_handler![")
            .expect("the one command surface must be findable");
        let handler_end = LIB_RS[handler_start..]
            .find(']')
            .expect("the handler list must close")
            + handler_start;
        let list = &LIB_RS[handler_start..handler_end];
        assert!(
            list.contains("subscribe_gesture_verdicts"),
            "parser control: the handler list was found and carries its known members",
        );
        assert!(
            list.contains("subscribe_load_refusals"),
            "subscribe_load_refusals is defined but NOT registered, so the webview can \
             never open the channel and every refused load is silent in the shipped \
             binary.\n  list: {list}",
        );
    }

    // ---- FAIL-01 (phase 90, D-11): the held fatal reason --------------------------

    /// A recording `Channel`: every frame it is sent, as JSON, in order.
    fn sim_fatal_recorder() -> (Channel<SimFatal>, std::sync::mpsc::Receiver<serde_json::Value>) {
        let (tx, rx) = std::sync::mpsc::channel::<serde_json::Value>();
        let channel = Channel::new(move |body: InvokeResponseBody| {
            let _ = tx.send(body.deserialize::<serde_json::Value>().expect("a JSON frame"));
            Ok(())
        });
        (channel, rx)
    }

    /// Every frame a recorder has been sent so far.
    fn sent(rx: &std::sync::mpsc::Receiver<serde_json::Value>) -> Vec<serde_json::Value> {
        rx.try_iter().collect()
    }

    /// The frame for `reason`, field for field the dev WebSocket's `SimFatalFrame`.
    fn sim_fatal_json(reason: &str) -> serde_json::Value {
        serde_json::json!({ "kind": "simFatal", "reason": reason })
    }

    /// A fatal raised before the webview has subscribed (the sim thread can fail at any
    /// time, a page loads later) is held and sent the moment the channel registers.
    #[test]
    fn a_sim_fatal_raised_before_subscribe_is_sent_on_subscribe() {
        let slot = SimFatalSlot::default();
        slot.raise("the sim stopped early".to_owned());
        let (channel, rx) = sim_fatal_recorder();
        slot.register(channel);
        assert_eq!(sent(&rx), vec![sim_fatal_json("the sim stopped early")]);
    }

    /// Phase 90 review IN-A-06: a panic in the sim thread's setup, before the loop runs, is
    /// raised into the held slot as the stopped card's reason, and the caller is told to go on
    /// without a sim instead of the thread dying unheard.
    #[test]
    fn a_panic_in_the_sim_thread_setup_is_raised_as_the_stopped_reason() {
        let slot = SimFatalSlot::default();
        let got = start_or_raise(|| -> u8 { panic!("fabrico: the demo scene did not boot") }, &slot);
        assert_eq!(got, None, "A SETUP PANIC IS CONTAINED: no sim comes back");
        let (channel, rx) = sim_fatal_recorder();
        slot.register(channel);
        assert_eq!(
            sent(&rx),
            vec![sim_fatal_json("sim thread panicked: fabrico: the demo scene did not boot")],
            "A SETUP PANIC IS SAID: the page that subscribes is sent the reason"
        );
        let ok = start_or_raise(|| 7u8, &SimFatalSlot::default());
        assert_eq!(ok, Some(7), "a setup that does not panic hands its result back");
    }

    /// A fatal raised after the webview subscribed is sent once, and only once.
    #[test]
    fn a_sim_fatal_raised_after_subscribe_is_sent_once() {
        let slot = SimFatalSlot::default();
        let (channel, rx) = sim_fatal_recorder();
        slot.register(channel);
        assert_eq!(sent(&rx), Vec::<serde_json::Value>::new(), "nothing on subscribe");
        slot.raise("the sim stopped".to_owned());
        assert_eq!(sent(&rx), vec![sim_fatal_json("the sim stopped")]);
        assert_eq!(sent(&rx), Vec::<serde_json::Value>::new(), "and not again");
    }

    /// A webview reload opens a new channel; it is sent the held reason too.
    #[test]
    fn a_reload_resubscribe_gets_the_held_sim_fatal() {
        let slot = SimFatalSlot::default();
        let (first, first_rx) = sim_fatal_recorder();
        slot.register(first);
        slot.raise("stopped before the reload".to_owned());
        assert_eq!(sent(&first_rx), vec![sim_fatal_json("stopped before the reload")]);
        let (second, second_rx) = sim_fatal_recorder();
        slot.register(second);
        assert_eq!(sent(&second_rx), vec![sim_fatal_json("stopped before the reload")]);
        assert_eq!(sent(&first_rx), Vec::<serde_json::Value>::new(), "the old page is sent nothing more");
    }

    /// Before any fatal, a subscription is sent nothing at all.
    #[test]
    fn no_sim_fatal_is_sent_before_one_is_raised() {
        let slot = SimFatalSlot::default();
        let (channel, rx) = sim_fatal_recorder();
        slot.register(channel);
        let (again, again_rx) = sim_fatal_recorder();
        slot.register(again);
        assert_eq!(sent(&rx), Vec::<serde_json::Value>::new());
        assert_eq!(sent(&again_rx), Vec::<serde_json::Value>::new());
    }

    /// The delivery is the free function's frame, on the shared discriminator.
    #[test]
    fn a_sim_fatal_is_delivered_with_the_hosts_reason() {
        let mut emitted = Vec::new();
        deliver_sim_fatal("r".to_owned(), |f| emitted.push(f));
        assert_eq!(emitted, vec![SimFatal { kind: SIM_FATAL_KIND, reason: "r".to_owned() }]);
    }

    /// `subscribe_sim_fatal` is REGISTERED in the one command surface, not merely defined.
    #[test]
    fn subscribe_sim_fatal_is_in_the_registered_command_surface() {
        const LIB_RS: &str = include_str!("lib.rs");
        let handler_start = LIB_RS
            .find("tauri::generate_handler![")
            .expect("the one command surface must be findable");
        let handler_end = LIB_RS[handler_start..]
            .find(']')
            .expect("the handler list must close")
            + handler_start;
        let list = &LIB_RS[handler_start..handler_end];
        assert!(
            list.contains("subscribe_load_refusals"),
            "parser control: the handler list was found and carries its known members",
        );
        assert!(
            list.contains("subscribe_sim_fatal"),
            "subscribe_sim_fatal is defined but NOT registered, so the webview can never \
             open the channel and a fatal sim error is silent in the shipped binary.\n  list: {list}",
        );
    }

    /// D-13: the shell never wires the dev fault seam. The code part of this file (cut at the
    /// `#[cfg(test)]` that opens `mod tests`) holds no call of the builder. The needle is
    /// assembled at run time, so this test's own text can neither satisfy nor defeat it.
    #[test]
    fn the_shell_never_wires_the_dev_fault_seam() {
        const LIB_RS: &str = include_str!("lib.rs");
        let tests_at = LIB_RS
            .find(concat!("#[cfg(test)]\n", "mod tests {"))
            .expect("the test module's opening must be findable");
        let code = &LIB_RS[..tests_at];
        assert!(
            code.contains("SimLoop::new("),
            "parser control: the code part holds the sim loop's construction",
        );
        let needle = [".with_dev", "_fault("].concat();
        assert!(
            !code.contains(&needle),
            "the Tauri shell calls the dev fault builder ({needle}); only dev_render_server may",
        );
        let word = ["with_dev", "_fault"].concat();
        assert!(!code.contains(&word), "the Tauri shell names the dev fault builder at all");
    }

    /// The shell never wires the dev hold seam either, checked the same way as the fault seam
    /// above: the needle is assembled at run time, so this test's own text can't defeat it.
    #[test]
    fn the_shell_never_wires_the_dev_hold_seam() {
        const LIB_RS: &str = include_str!("lib.rs");
        let tests_at = LIB_RS
            .find(concat!("#[cfg(test)]\n", "mod tests {"))
            .expect("the test module's opening must be findable");
        let code = &LIB_RS[..tests_at];
        assert!(
            code.contains("SimLoop::new("),
            "parser control: the code part holds the sim loop's construction",
        );
        let needle = [".with_dev", "_hold("].concat();
        assert!(
            !code.contains(&needle),
            "the Tauri shell calls the dev hold builder ({needle}); only dev_render_server may",
        );
        let word = ["with_dev", "_hold"].concat();
        assert!(!code.contains(&word), "the Tauri shell names the dev hold builder at all");
    }

    // ---- QA-01: the clipboard capability grant is ASSERTED, not assumed -------
    //
    // Why this is not redundant with `cargo build`: `tauri-build` regenerates the
    // desktop schema from the registered plugins and validates
    // `capabilities/default.json` against it, so the BUILD proves the permission id
    // is a real id the schema knows. It does not prove that THIS app grants it, and
    // it does not prove the app grants nothing wider. That is what the two tests
    // below pin, independently.
    //
    // Nothing else in the repo can observe this file at all. The frontend node lock
    // (`clipboardCopy.test.ts`) drives the copy branches through an injected writer
    // and never sees a capability; a Playwright e2e runs in Chromium, where the web
    // clipboard API exists and the Tauri capability layer is not in the picture at
    // all. A missing grant is a runtime rejection inside the real WebKitGTK binary
    // ONLY, which is exactly the blind spot that shipped this bug.

    /// Every permission identifier granted by EVERY capability file this app
    /// ships, as the identifiers Tauri itself resolves.
    ///
    /// This replaces an earlier hand parser that read `include_str!` of one file
    /// and split the bracketed array on `,`. That parser certified a widened app
    /// green through two independent escapes, both of which this function is
    /// shaped to close:
    ///
    ///   (a) A permission entry may be a bare id string OR a scoped OBJECT
    ///       (`{"identifier": "...", "allow": [...]}`) - the normal shape for any
    ///       scoped grant. Splitting on `,` turned an object into garbage
    ///       fragments starting with `{`, which the `starts_with("clipboard-manager:")`
    ///       filter in the least-privilege test then skipped entirely. A
    ///       `clipboard-manager:allow-read-text` written in object form was
    ///       therefore INVISIBLE to the one control guarding the read grant.
    ///       Both shapes are now resolved to their identifier, and any third
    ///       shape panics rather than being dropped.
    ///
    ///   (b) Tauri loads EVERY file in `capabilities/`, and `tauri.conf.json`
    ///       declares no `app.security.capabilities` filter, so all of them are
    ///       live. Reading one hard-coded filename meant a second file granting
    ///       anything at all left both tests green. The directory is enumerated.
    ///
    /// It PANICS on a missing directory, unreadable file, invalid JSON, a missing
    /// `permissions` array or an unrecognised entry shape, by design: a parser
    /// that quietly returned an empty list would make the negative assertion in
    /// `no_clipboard_permission_beyond_write_text` pass vacuously, which is
    /// precisely the failure mode this lock exists to prevent. The `files > 0`
    /// assertion is the structural anti-vacuity control; the `dialog:allow-save`
    /// assertion below is the second, behavioural one on top of it.
    fn granted_permissions() -> Vec<String> {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("capabilities");
        // `read_dir` order is filesystem-dependent. Sort so the identifier list -
        // and therefore any assertion failure message built from it - is the same
        // on every machine, the same discipline the sim applies to iteration order.
        let mut paths: Vec<std::path::PathBuf> = std::fs::read_dir(&dir)
            .unwrap_or_else(|e| panic!("read capabilities dir {}: {e}", dir.display()))
            .map(|entry| entry.expect("capabilities dir entry").path())
            .filter(|path| path.extension().and_then(|e| e.to_str()) == Some("json"))
            .collect();
        paths.sort();
        let mut out = Vec::new();
        let mut files = 0usize;
        for path in paths {
            files += 1;
            // `std::fs::read_to_string` is on the workspace `clippy.toml`
            // disallowed-methods list with the reason "no IO in the SIM CORE". This is a
            // `#[cfg(test)]` helper in the Tauri shell whose entire job is to read the
            // shipped capability JSON off disk and assert on it; refusing the read would
            // delete the test. The ban stays deny-level in `fabrico-core/src/lib.rs`.
            #[allow(clippy::disallowed_methods)]
            let text = std::fs::read_to_string(&path)
                .unwrap_or_else(|e| panic!("read capability {}: {e}", path.display()));
            let value: serde_json::Value = serde_json::from_str(&text)
                .unwrap_or_else(|e| panic!("capability {} is valid JSON: {e}", path.display()));
            let perms = value
                .get("permissions")
                .and_then(|p| p.as_array())
                .unwrap_or_else(|| {
                    panic!(
                        "capability {} declares a \"permissions\" array",
                        path.display()
                    )
                });
            for permission in perms {
                // A permission is either a bare id OR a scoped object. BOTH count.
                let id = match permission {
                    serde_json::Value::String(s) => s.clone(),
                    serde_json::Value::Object(o) => o
                        .get("identifier")
                        .and_then(|i| i.as_str())
                        .unwrap_or_else(|| {
                            panic!(
                                "object permission in {} has a string \"identifier\": {permission}",
                                path.display()
                            )
                        })
                        .to_string(),
                    other => panic!(
                        "unrecognised permission entry shape in {}: {other}",
                        path.display()
                    ),
                };
                out.push(id);
            }
        }
        // Anti-vacuity: at least one capability file was actually read. Without
        // this an empty or renamed directory would silently grant "nothing", and
        // every negative assertion below would pass on a file it never opened.
        assert!(
            files > 0,
            "no capability files found under {} - the least-privilege assertions would pass vacuously",
            dir.display(),
        );
        out
    }

    /// QA-01: the app actually GRANTS the native clipboard write the Copy button
    /// now depends on. Without this grant the plugin call is rejected at runtime
    /// and the button correctly, but pointlessly, reads "Copy failed" forever.
    #[test]
    fn default_capability_grants_clipboard_write_text() {
        let permissions = granted_permissions();
        // Anti-vacuity control: a permission that has been in this file since
        // Phase 18. If the parser is broken this fails FIRST, so a green result
        // from the grant assertion below is never trusted on its own.
        assert!(
            permissions.iter().any(|p| p == "dialog:allow-save"),
            "parser control: the long-standing dialog:allow-save grant must parse, got {permissions:?}",
        );
        assert!(
            permissions.iter().any(|p| p == "clipboard-manager:allow-write-text"),
            "the webview is granted the OS-native clipboard write, got {permissions:?}",
        );
    }

    /// T-52-01, least privilege: the app only ever PUTS the endpoint URL on the
    /// clipboard, so a later read or clear grant must fail HERE rather than
    /// silently handing the webview the user's whole clipboard.
    ///
    /// This sees EVERY capability file and resolves BOTH permission shapes, so
    /// neither a second capability file nor an object-form
    /// `{"identifier": "clipboard-manager:allow-read-text"}` can slip past it.
    /// The fix was proved by widening the real capability file both ways and
    /// confirming this test FAILS on each, then restoring it.
    #[test]
    fn no_clipboard_permission_beyond_write_text() {
        let permissions = granted_permissions();
        let granted: Vec<&str> = permissions
            .iter()
            .map(String::as_str)
            .filter(|p| p.starts_with("clipboard-manager:"))
            .collect();
        assert_eq!(
            granted,
            ["clipboard-manager:allow-write-text"],
            "exactly one clipboard permission is granted and it is write-text (no read, no clear)",
        );
    }
}
