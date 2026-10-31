//! The browser-dev render host: serve the canonical command-built demo scene over
//! the loopback render WebSocket so the frontend (`cd frontend && npm run dev`) +
//! Chrome can drive it live.
//!
//! Run it with:
//! ```text
//! cargo run -p fabrico-host --example dev_render_server
//! ```
//! then in another terminal:
//! ```text
//! cd frontend && npm run dev
//! ```
//! and open <http://localhost:5173> in Chrome. The frontend's default dev socket
//! is `ws://127.0.0.1:8787/render` ([`DEV_WS_ADDR`]).
//!
//! # The per-tick PRODUCER OWNER (W2)
//! This host owns the `Host` + the single [`RenderProducer`] on the MAIN thread
//! (Core is `!Send`). Each tick it drains gestures (applying them HERE), calls
//! `host.tick_once`, then `producer.on_tick` (the explicit
//! `layout.update -> build -> encode -> broadcast.send`). Demo injection is the
//! host's deterministic `TimerConfig` ingress (projected by `boot_scene`, D-04): logged,
//! replay-safe, and IDENTICAL in the shell + this dev server + a post-CTA swap —
//! no dev-only pre-tick closure. The render WebSocket and the Tauri Channel
//! (fabrico-app) are pure SUBSCRIBERS of the identical producer bytes — the
//! locked "one renderer, two transports".
//!
//! # Self-contained + loopback-only
//! All redb lives under a temp dir; the WS binds `127.0.0.1` ONLY (threat
//! T-07-EXPOSE). The host carries no mail sender, so the demo is fully
//! offline-safe.

use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use fabrico_core::core::Core;
use fabrico_core::event::{LogHeader, SCHEMA_VERSION};
use fabrico_core::persist::{MAX_RECORD_BYTES, RedbStore};
use fabrico_host::config::HostConfig;
use fabrico_host::demo_scene::{DEMO_GENESIS_SEED, SceneId, boot_scene};
use fabrico_host::driver::Host;
use fabrico_host::ingress::seen_set::SeenSet;
use fabrico_host::ingress::webhook::{Ingress, WEBHOOK_INGRESS_CAPACITY, run_webhook_listener};
use fabrico_host::ledger::DispatchLedger;
use fabrico_host::render_packet::RenderProducer;
use fabrico_host::sim_fatal::fatal_reason;
use fabrico_host::sim_loop::{ControlMsg, SimLoop, gesture_channel};
use fabrico_host::transport_ws::{
    MAX_GESTURE_FRAME, RenderSubscription, load_refusal_channel, load_refused_frame, save_failed_frame,
    run_render_listener,
};
use tokio::sync::mpsc::unbounded_channel;
use tokio::sync::watch;

/// The loopback render-WS address the frontend's `DEFAULT_DEV_WS_URL` points at.
const DEV_WS_ADDR: &str = "127.0.0.1:8787";

fn main() {
    // A multi-thread runtime for the OFF-sim-thread executor + the WS listener.
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("build tokio runtime");

    // Self-contained, deterministic: all redb lives under a temp dir.
    let dir = tempfile::tempdir().expect("tempdir");
    let core = Core::genesis(LogHeader {
        schema_version: SCHEMA_VERSION,
        seed: DEMO_GENESIS_SEED,
    });
    let store = RedbStore::open(dir.path().join("log.redb")).expect("open log");
    let ledger = DispatchLedger::open(dir.path().join("ledger.redb")).expect("open ledger");
    // Build the Host WITH a real persisted seen-set (HOST-06) — the same two-line
    // fix as the shell: without it `record_delivery` returns `true` for every id and
    // a duplicate webhook delivery double-fires a Source (the browser-path live gate
    // can now `curl` the same delivery twice and see exactly one inject).
    let seen = SeenSet::open(dir.path().join("seen.redb")).expect("open seen-set");
    let host = Host::new(core, store, ledger, None)
        .expect("open host")
        .with_seen_set(seen);

    // Boot the canonical command-built demo scene through THE one boot function the
    // Tauri shell and every LoadScene swap use (plan 85-08, D-02): seed through the
    // certified gesture path, seal the history, then project the timers from the seeded
    // edit log (timers strictly AFTER seeding). THIS binary is what the LIVE e2e suite
    // drives, so the live suite sees exactly the board the shipped app boots. A failure
    // is a startup-fatal authoring bug in a dev binary, and the panic names the scene.
    let host = boot_scene(host, SceneId::Demo).unwrap_or_else(|e| panic!("dev_render_server: {e}"));

    // Offline-safe executor config: no real bind, no extra timers. SimLoop
    // spawns the off-thread executor consumer on `rt`'s handle.
    let cfg = HostConfig {
        webhook_addr: "127.0.0.1:0".parse().expect("loopback addr"),
    };
    // The webhook bind address is `Copy`; capture it before `cfg` moves into SimLoop.
    let webhook_addr = cfg.webhook_addr;

    // The gesture path: the receiver moves into SimLoop; the sender feeds the WS.
    let (gesture_tx, gesture_rx) = gesture_channel();
    // The control path: the receiver moves into SimLoop (`.with_control`); the sender
    // feeds the render WS so the BROWSER path (18-06 live gate) can Pause/Step/etc.
    let (control_tx, control_rx) = unbounded_channel::<ControlMsg>();
    // The webhook ingress path: the listener's handler forwards accepted requests on
    // `webhook_tx`; the sim thread drains `webhook_rx` (dedup-before-log).
    let (webhook_tx, webhook_rx) =
        tokio::sync::mpsc::channel::<Ingress>(WEBHOOK_INGRESS_CAPACITY);
    // The endpoint ingress path (ENDP-01, WUI-01): the shared listener forwards a
    // `POST /endpoint/<path>` (a new Route's default is `/route-<n>`) on `endpoint_tx`;
    // SimLoop::with_endpoint mints the
    // parked socket + WireRequest on the sim thread. Previously dropped (endpoints
    // 404'd) — now wired so the demo headline wire can be driven live. BOUNDED (F2).
    let (endpoint_tx, endpoint_rx) = tokio::sync::mpsc::channel::<
        fabrico_host::ingress::endpoint::EndpointIngress,
    >(fabrico_host::ingress::endpoint::ENDPOINT_INGRESS_CAPACITY);
    // The load-refusal fan-out (UNDO-09): the sim thread's sink pushes onto the sender,
    // every live WebSocket connection subscribes. Built BEFORE `SimLoop::new` so a clone
    // can be moved into the sink closure below and the original handed to the listener.
    let load_refusals = load_refusal_channel();
    // The dev fault switch (phase 90, D-13): ONE flag shared by the sim loop, which reads it
    // at the top of `step()`, and the render WS, which sets it on a `dev_fault` TEXT frame.
    // THIS binary is the seam's only caller: the Tauri shell never builds it (the same rule
    // as `with_pre_tick`), so the shipped app has no path to it.
    let dev_fault = Arc::new(AtomicBool::new(false));
    // The dev hold switch: ONE flag shared the same way, set by a `dev_hold` TEXT frame. It lets
    // a live check put a POST and a control message in front of the sim at once. This binary is
    // its only caller too.
    let dev_hold = Arc::new(AtomicBool::new(false));
    // The held fatal reason (phase 90, FAIL-01, D-11): `None` while the sim runs, the reason
    // once its loop ends. Every render socket is sent it after its opening keyframe and on
    // change, so a page that connects or reloads after the fatal still learns of it.
    let (sim_fatal_tx, sim_fatal_rx) = watch::channel::<Option<String>>(None);

    // Construct the ONE canonical loop; it owns the Host + RenderProducer. The
    // demo stays animated via the host's deterministic timer ingress installed
    // above (by boot_scene): logged, replay-safe injections identical to the shell
    // and to a post-CTA swap — no dev-only pre-tick closure.
    let mut sim = SimLoop::new(host, RenderProducer::new(), rt.handle(), cfg, gesture_rx)
        // WR-03: the demo was seeded above, outside the loop - declare it so the
        // `loaded_scene` query can answer honestly after a webview reload.
        .with_loaded_scene(SceneId::Demo)
        .with_control(control_rx)
        .with_webhook(webhook_rx)
        .with_endpoint(endpoint_rx)
        .with_dev_fault(Arc::clone(&dev_fault))
        .with_dev_hold(Arc::clone(&dev_hold))
        // UNDO-09: a refused `.fab` load now reaches the browser instead of dying at
        // the `eprintln!` on the sim thread. The sink hands the host's own sentence to
        // the fan-out below; every live WebSocket connection relays it as a TEXT frame.
        // Phase 90 review WR-A-03: a Save the host could not write reaches every page too, on
        // the same fan-out under its own `kind`, so the strip shows `Save failed`.
        .with_save_failure_sink({
            let tx = load_refusals.clone();
            Box::new(move |reason: String| {
                let _ = tx.send(save_failed_frame(&reason));
            })
        })
        .with_load_refusal_sink({
            let tx = load_refusals.clone();
            Box::new(move |reason: String| {
                // Never panics and never blocks the sim thread: a full or
                // subscriber-less fan-out is a named drop, exactly as the gesture
                // refusal's bounded reply channel is.
                let _ = tx.send(load_refused_frame(&reason));
            })
        });

    // The producer has moved into SimLoop, so build the WS subscription from the
    // sim.subscribe() handles (Pitfall 3) — the WS streams its identical bytes (W2).
    let (keyframe_rx, diff_rx) = sim.subscribe();
    let sub = RenderSubscription::from_handles(keyframe_rx, diff_rx);

    // Wire the webhook server to the LIVE route projection (HOST-07): bind
    // synchronously so the resolved loopback port is known + printed, then the serve
    // loop runs in the background. A `curl -X POST http://127.0.0.1:PORT/hook/src-<id>`
    // fires a Source live (the browser-path ingress check in 18-06).
    let routes_rx = sim.routes_receiver();
    // ROBUST-01: the not-Playing signal for the webhook handler's Gate A.
    let is_playing = sim.is_playing_flag();
    // Capture the RESOLVED bound webhook addr (the `:0` bind picks a real port) so a
    // dev-WS `webhook_url` config-query can format the SAME loopback URL the Tauri
    // path does (40-05). `None` when the listener fails to bind.
    let mut bound_webhook_addr: Option<SocketAddr> = None;
    let webhook_url = match rt.block_on(run_webhook_listener(
        webhook_addr,
        routes_rx,
        webhook_tx,
        endpoint_tx,
        MAX_RECORD_BYTES,
        is_playing,
    )) {
        Ok(bound) => {
            bound_webhook_addr = Some(bound);
            format!("http://{bound}/hook/src-<id>")
        }
        Err(e) => {
            eprintln!("dev render server: webhook listener failed to bind: {e}");
            "(webhook listener failed to bind)".to_owned()
        }
    };

    // The loopback render-WS listener: a pure SUBSCRIBER relaying the producer's
    // per-tick diffs OUT and forwarding gesture frames IN + control frames IN to the
    // sim thread (the browser path drives Pause/Step over the same socket).
    let addr: SocketAddr = DEV_WS_ADDR.parse().expect("parse dev ws addr");
    let ws_gesture_tx = gesture_tx.clone();
    let ws_control_tx = control_tx.clone();
    let ws_load_refusals = load_refusals.clone();
    let ws_dev_fault = Some(Arc::clone(&dev_fault));
    let ws_dev_hold = Some(Arc::clone(&dev_hold));
    let ws_sim_fatal = sim_fatal_rx.clone();
    rt.spawn(async move {
        if let Err(e) = run_render_listener(
            addr,
            sub,
            ws_gesture_tx,
            ws_control_tx,
            bound_webhook_addr,
            MAX_GESTURE_FRAME,
            ws_load_refusals,
            ws_dev_fault,
            ws_dev_hold,
            ws_sim_fatal,
        )
        .await
        {
            eprintln!("dev render server: render WS listener exited: {e}");
        }
    });
    // FABRICO_BOOT_SCENE (ALWAYS-ON, closed-set boot override, Phase 55): parse
    // through the SAME typed SceneId boundary every load path uses; the seam maps
    // ids to build-embedded scenes ONLY — never a path, never a runtime file read
    // (T-55-05). The enqueued control is serviced at the sim loop's first tick
    // boundary through the certified swap + full-keyframe path.
    //
    // NOT dev-gated. This example binary is dev-only, but its twin in
    // `fabrico-app/src/lib.rs` is NOT gated either and ships in the release binary.
    // The T-55-05 acceptance rests on the closed set, not on any build gate: keep
    // the two ONLYs above intact, or the threat needs re-dispositioning.
    //
    // `std::env::var` is on the workspace `clippy.toml` disallowed-methods list, and its
    // stated reason is "no ambient environment in the SIM CORE". This is the dev host
    // binary, not the sim core: the sim never observes this variable, it only receives the
    // resulting `ControlMsg::LoadScene` through the same control channel every other load
    // path uses. The ban is deny-level where it means something (`fabrico-core/src/lib.rs`
    // `#![deny(clippy::disallowed_methods)]`); allowing it HERE does not weaken it there.
    #[allow(clippy::disallowed_methods)]
    let boot_scene_env = std::env::var("FABRICO_BOOT_SCENE");
    // Absent -> the shipped demo boot, untouched. `booted` is the scene this server
    // streams, named in the start banner below (plan 85-10).
    let booted = match boot_scene_env {
        Err(_) => SceneId::Demo,
        Ok(val) => match SceneId::parse(&val) {
            Some(SceneId::OrderProcessing) => {
                let _ = control_tx.send(ControlMsg::LoadScene(SceneId::OrderProcessing));
                SceneId::OrderProcessing
            }
            Some(SceneId::Advanced) => {
                let _ = control_tx.send(ControlMsg::LoadScene(SceneId::Advanced));
                SceneId::Advanced
            }
            // `demo_scene` names the shipped demo boot: already seeded, untouched.
            Some(SceneId::Demo) => SceneId::Demo,
            None => {
                eprintln!(
                    "dev render server: FABRICO_BOOT_SCENE={val:?} is not a known scene id \
                     (expected \"demo_scene\", \"order_processing\", or \"advanced\") - booting the demo scene"
                );
                SceneId::Demo
            }
        },
    };
    let booted_id = booted.wire_id();

    // The clones above keep the WS sinks alive; drop our extra handles so only the WS
    // holds them (the sim loop reads its gesture + control receivers).
    drop(gesture_tx);
    drop(control_tx);

    println!("== fabrico dev render server ==");
    println!("render WebSocket: ws://{addr}/render  (loopback only)");
    println!("webhook ingress:  {webhook_url}  (loopback only)");
    println!("now run the frontend:  cd frontend && npm run dev");
    println!("then open:             http://localhost:5173");
    println!("booted scene:          {booted_id}  (it streams live; Ctrl-C to stop)");

    // Drive the canonical loop forever on THIS (main) thread (Core is !Send). It returns only
    // when it ends (a store error, or a panic contained by `fatal_reason`); the reason is the
    // one sentence both hosts use (FAIL-01, D-11).
    let reason = fatal_reason(|| sim.run(None, fabrico_host::sim_loop::TICK_PAUSE));
    // Phase 90 review WR-A-01: the parked host answers no webhook or endpoint request again, so
    // its doors refuse with a 503 at once. `run` already did this for a store error; a panic
    // contained by `fatal_reason` skipped it.
    sim.close_ingress();
    eprintln!("dev render server: {reason}");
    sim_fatal_tx.send_replace(Some(reason));
    // Park instead of exiting: `sim` and its channels stay alive, so the render sockets stay
    // open, a reloaded page still gets the last keyframe, and every socket is told the reason.
    // The process ends when it is killed, as it always did.
    loop {
        std::thread::park();
    }
}
