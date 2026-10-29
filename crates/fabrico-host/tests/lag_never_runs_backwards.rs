//! Phase 90 red-first probes (plan 90-01, D-14): FAIL-05, what a client that fell behind the
//! bounded diff broadcast is sent AFTER its lag keyframe (D-09, D-10).
//!
//! After a lag the transport sends the latest keyframe through `RenderRelay::lagged` and then
//! goes back to the broadcast, which resumes a lagged receiver at the oldest frame it still
//! holds. At `PHASE90_START` the relay forwarded every one of them, so the client applied up to 256
//! frames OLDER than the keyframe it had just been sent: its tick counter ran backwards, and after
//! an Undo in the gap it applied old-generation diffs on top of the new board's keyframe. Since
//! plan 90-03 the relay drops them (below).
//!
//! The producer sends each diff BEFORE it updates the keyframe watch, so a lag read can see
//! keyframe T-1 while diff T is still buffered: the fix keeps any frame newer than the keyframe
//! and drops the rest, comparing generation first and then tick (D-09). These probes read every
//! frame the relay forwards after the lag keyframe, the way a transport sends it, and assert
//! `(generation, tick)` never decreases. Plan 90-03 turned them on: `forward` now returns
//! `Option<Vec<u8>>`, `None` for a frame at or below the lag keyframe, and the client helpers
//! read it directly (90-01 read it through `Option::<Vec<u8>>::from(..)` so the probes compiled
//! against both signatures; that wrapper became a same-type conversion clippy refuses, so it went
//! from the helpers, and no probe body changed).
//!
//! Each probe prints its measured facts (`P90-` lines) before it asserts.

use std::time::Duration;

use fabrico_core::core::Core;
use fabrico_core::event::{LogHeader, SCHEMA_VERSION};
use fabrico_core::persist::RedbStore;
use fabrico_host::config::HostConfig;
use fabrico_host::driver::Host;
use fabrico_host::ledger::DispatchLedger;
use fabrico_host::render_packet::{RenderFrame, RenderProducer, RenderRelay};
use fabrico_host::sim_loop::{ControlMsg, GestureSink, SimLoop, gesture_channel};
use fabrico_protocol::{GridCommand, RenderPacket, machine_kind};
use tokio::sync::broadcast::{self, error::TryRecvError};
use tokio::sync::watch;

/// More ticks than the diff broadcast holds (256), so the subscriber lags.
const LAG_TICKS: u64 = 300;

fn rt() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("runtime")
}

fn cfg() -> HostConfig {
    HostConfig {
        webhook_addr: "127.0.0.1:0".parse().expect("addr"),
    }
}

fn host(dir: &std::path::Path) -> Host {
    let core = Core::genesis(LogHeader {
        schema_version: SCHEMA_VERSION,
        seed: 1,
    });
    let store = RedbStore::open(dir.join("log.redb")).expect("store");
    let ledger = DispatchLedger::open(dir.join("ledger.redb")).expect("ledger");
    Host::new(core, store, ledger, None).expect("host")
}

fn decode(bytes: &[u8]) -> RenderPacket {
    postcard::from_bytes(bytes).expect("decode a render packet")
}

/// A connected client, as in `lag_resync_across_reset.rs`, that also reads what the relay
/// forwards after its lag keyframe.
struct Client {
    relay: RenderRelay,
    kf: watch::Receiver<RenderFrame>,
    diff: broadcast::Receiver<RenderFrame>,
}

impl Client {
    fn connect(subscription: (watch::Receiver<RenderFrame>, broadcast::Receiver<RenderFrame>)) -> Self {
        let (mut kf, diff) = subscription;
        let (relay, bytes) = RenderRelay::open(&kf.borrow_and_update());
        assert!(!bytes.is_empty(), "PRECONDITION: a keyframe to open on");
        Self { relay, kf, diff }
    }

    /// Read every frame the broadcast holds, as a connection that keeps up does.
    fn keep_up(&mut self) {
        loop {
            match self.diff.try_recv() {
                Ok(frame) => {
                    let _ = self.relay.forward(frame);
                }
                Err(TryRecvError::Empty) => return,
                Err(e) => panic!("PRECONDITION: the client keeps up, got {e:?}"),
            }
        }
    }

    /// The broadcast says Lagged and the transport resends the latest keyframe through the
    /// relay. Returns that keyframe's `(generation, tick)` as the client reads it.
    fn lagged(&mut self) -> (u64, u64) {
        match self.diff.try_recv() {
            Err(TryRecvError::Lagged(n)) => eprintln!("P90-FAIL-05 lagged_by={n}"),
            other => panic!(
                "PRECONDITION: the client lagged past the broadcast, got {:?}",
                other.map(|f| f.bytes.len())
            ),
        }
        let p = decode(&self.relay.lagged(&self.kf.borrow_and_update()));
        assert!(p.full, "PRECONDITION: a lag resends a keyframe");
        (p.generation, p.tick)
    }

    /// After the lag keyframe: every frame the relay forwards, decoded to `(generation, tick)`,
    /// in the order the client is sent them.
    fn drain_after_lag(&mut self) -> Vec<(u64, u64, bool)> {
        let mut sent = Vec::new();
        loop {
            match self.diff.try_recv() {
                Ok(frame) => {
                    if let Some(bytes) = self.relay.forward(frame) {
                        let p = decode(&bytes);
                        sent.push((p.generation, p.tick, p.full));
                    }
                }
                Err(TryRecvError::Empty) => return sent,
                Err(e) => panic!("PRECONDITION: the drain after the lag reads the buffer, got {e:?}"),
            }
        }
    }
}

fn send(gtx: &impl GestureSink, cmd: GridCommand) {
    gtx.send_gesture(cmd).expect("send gesture");
}

/// Print what the client was sent after its lag keyframe; returns how many frames broke order.
fn report(case: &str, kf: (u64, u64), sent: &[(u64, u64, bool)]) -> usize {
    let at_or_below = sent.iter().filter(|(g, t, _)| (*g, *t) <= kf).count();
    let older_gen = sent.iter().filter(|(g, _, _)| *g < kf.0).count();
    let mut prev = kf;
    let mut backwards = 0;
    for (g, t, _) in sent {
        if (*g, *t) < prev {
            backwards += 1;
        }
        prev = prev.max((*g, *t));
    }
    let first = sent.first().map(|(g, t, _)| (*g, *t));
    let last = sent.last().map(|(g, t, _)| (*g, *t));
    eprintln!(
        "P90-{case} keyframe_gen={} keyframe_tick={} forwarded={} at_or_below_keyframe={at_or_below} older_generation={older_gen} backwards={backwards} first={first:?} last={last:?} full_frames={}",
        kf.0,
        kf.1,
        sent.len(),
        sent.iter().filter(|(_, _, f)| *f).count()
    );
    backwards
}

/// FAIL-05, no reset in the gap: the tick a lagged client is sent never goes back.
#[test]
fn a_lagged_client_never_sees_its_tick_go_back() {
    let rt = rt();
    let dir = tempfile::tempdir().expect("tempdir");
    let (gtx, grx) = gesture_channel();
    let mut sim = SimLoop::new(host(dir.path()), RenderProducer::new(), rt.handle(), cfg(), grx);
    let sub = sim.subscribe();
    send(
        &gtx,
        GridCommand::Place {
            kind: machine_kind::FACTORY,
            cell_x: 10,
            cell_y: 8,
        },
    );
    sim.run(Some(1), Duration::ZERO).expect("place");
    let mut client = Client::connect(sub);
    client.keep_up();

    sim.run(Some(LAG_TICKS), Duration::ZERO).expect("run past the broadcast");
    let kf = client.lagged();
    let sent = client.drain_after_lag();
    let backwards = report("FAIL-05-idle", kf, &sent);
    assert_eq!(
        backwards, 0,
        "A LAGGED CLIENT'S TICK NEVER GOES BACK: no frame forwarded after the lag keyframe \
         {kf:?} is older than the one before it"
    );
}

/// FAIL-05, an Undo about 100 ticks before the gap ends: no frame of the old board is applied
/// on top of the new board's keyframe.
#[test]
fn a_lagged_client_never_sees_an_older_board_after_an_undo_in_the_gap() {
    let rt = rt();
    let dir = tempfile::tempdir().expect("tempdir");
    let (gtx, grx) = gesture_channel();
    let mut sim = SimLoop::new(host(dir.path()), RenderProducer::new(), rt.handle(), cfg(), grx);
    let sub = sim.subscribe();
    send(
        &gtx,
        GridCommand::Place {
            kind: machine_kind::FACTORY,
            cell_x: 10,
            cell_y: 8,
        },
    );
    sim.run(Some(1), Duration::ZERO).expect("place a Factory");
    let mut client = Client::connect(sub);
    client.keep_up();

    // The gap: a Source placed, about 200 ticks, the Undo that takes it away (a reset), and
    // about 100 ticks more, LAG_TICKS in all.
    send(
        &gtx,
        GridCommand::Place {
            kind: machine_kind::SOURCE,
            cell_x: 30,
            cell_y: 30,
        },
    );
    sim.run(Some(1), Duration::ZERO).expect("place a Source");
    sim.run(Some(LAG_TICKS - 102), Duration::ZERO).expect("the gap before the Undo");
    send(&gtx, GridCommand::Undo);
    sim.run(Some(1), Duration::ZERO).expect("fold the Undo");
    sim.run(Some(100), Duration::ZERO).expect("the gap after the Undo");

    let kf = client.lagged();
    assert!(kf.0 >= 1, "PRECONDITION: the Undo reset the producer (keyframe generation {})", kf.0);
    let sent = client.drain_after_lag();
    report("FAIL-05-undo", kf, &sent);
    let older = sent.iter().filter(|(g, _, _)| *g < kf.0).count();
    assert_eq!(
        older, 0,
        "A LAGGED CLIENT NEVER SEES AN OLDER BOARD: no frame forwarded after the lag keyframe \
         {kf:?} carries a generation below it"
    );
}

/// FAIL-05's other side (T-90-09, plan 90-03): the floor drops only what the lag keyframe
/// already covers. The ticks the sim runs after the lag reach the client, every one, in order,
/// so a relay that dropped everything after a lag would fail here, not pass the two probes above
/// with nothing forwarded.
#[test]
fn a_lagged_client_is_sent_every_frame_newer_than_its_keyframe() {
    const AFTER: u64 = 10;
    let rt = rt();
    let dir = tempfile::tempdir().expect("tempdir");
    let (gtx, grx) = gesture_channel();
    let mut sim = SimLoop::new(host(dir.path()), RenderProducer::new(), rt.handle(), cfg(), grx);
    let sub = sim.subscribe();
    send(
        &gtx,
        GridCommand::Place {
            kind: machine_kind::FACTORY,
            cell_x: 10,
            cell_y: 8,
        },
    );
    sim.run(Some(1), Duration::ZERO).expect("place");
    let mut client = Client::connect(sub);
    client.keep_up();

    sim.run(Some(LAG_TICKS), Duration::ZERO).expect("run past the broadcast");
    let kf = client.lagged();
    let backlog = client.drain_after_lag();
    sim.run(Some(AFTER), Duration::ZERO).expect("run on after the lag");
    let after = client.drain_after_lag();
    let ticks: Vec<u64> = after.iter().map(|(_, t, _)| *t).collect();
    eprintln!(
        "P90-FAIL-05-after keyframe={kf:?} backlog_forwarded={} after_forwarded={} ticks={ticks:?}",
        backlog.len(),
        after.len()
    );
    let expected: Vec<u64> = (kf.1 + 1..=kf.1 + AFTER).collect();
    assert_eq!(
        ticks, expected,
        "EVERY FRAME NEWER THAN THE LAG KEYFRAME {kf:?} IS SENT: the {AFTER} ticks run after the \
         lag reach the client in order"
    );
    assert!(
        after.iter().all(|(g, _, _)| *g == kf.0),
        "PRECONDITION: no reset after the lag, every frame on the keyframe's generation"
    );
}

/// Review fix pass 1, WR-C-08: the race D-09 names, built by hand. The producer sends a tick's
/// diff BEFORE it updates the keyframe watch, so a lag read can see keyframe T-1 while diff T is
/// still buffered. The relay must forward that diff: a relay that dropped the whole backlog on a
/// lag would leave the client one tick stale until the next full packet.
#[test]
fn a_diff_newer_than_a_stale_lag_keyframe_is_forwarded() {
    let rt = rt();
    let dir = tempfile::tempdir().expect("tempdir");
    let (gtx, grx) = gesture_channel();
    let mut sim = SimLoop::new(host(dir.path()), RenderProducer::new(), rt.handle(), cfg(), grx);
    let sub = sim.subscribe();
    send(
        &gtx,
        GridCommand::Place {
            kind: machine_kind::FACTORY,
            cell_x: 10,
            cell_y: 8,
        },
    );
    sim.run(Some(1), Duration::ZERO).expect("place");
    let mut client = Client::connect(sub);
    client.keep_up();

    sim.run(Some(LAG_TICKS - 1), Duration::ZERO).expect("run to just before the race");
    let stale = client.kf.borrow().clone();
    sim.run(Some(1), Duration::ZERO).expect("one more tick: its diff is buffered, the watch moved on");
    match client.diff.try_recv() {
        Err(TryRecvError::Lagged(n)) => eprintln!("P90-WR-C-08-race lagged_by={n}"),
        other => panic!("PRECONDITION: the client lagged, got {:?}", other.map(|f| f.bytes.len())),
    }
    let kf = decode(&client.relay.lagged(&stale));
    let sent = client.drain_after_lag();
    let ticks: Vec<u64> = sent.iter().map(|(_, t, _)| *t).collect();
    eprintln!("P90-WR-C-08-race stale_keyframe_tick={} forwarded_ticks={ticks:?}", kf.tick);
    assert_eq!(
        ticks,
        vec![kf.tick + 1],
        "THE DIFF NEWER THAN A STALE LAG KEYFRAME IS FORWARDED, and nothing at or below it"
    );
}

/// Review fix pass 1, WR-C-08: the same race across a reset. The lag reads a keyframe of the OLD
/// generation while a New's own keyframe (the new generation, its tick re-seeded near 0) is
/// already buffered. The relay compares generation first, so that keyframe is forwarded despite
/// its lower tick, and nothing of the old generation at or below the stale keyframe is.
#[test]
fn a_reset_buffered_behind_a_stale_lag_keyframe_is_forwarded() {
    let rt = rt();
    let dir = tempfile::tempdir().expect("tempdir");
    let (gtx, grx) = gesture_channel();
    let (ctx, crx) = tokio::sync::mpsc::unbounded_channel::<ControlMsg>();
    let mut sim = SimLoop::new(host(dir.path()), RenderProducer::new(), rt.handle(), cfg(), grx)
        .with_control(crx);
    let sub = sim.subscribe();
    send(
        &gtx,
        GridCommand::Place {
            kind: machine_kind::FACTORY,
            cell_x: 10,
            cell_y: 8,
        },
    );
    sim.run(Some(1), Duration::ZERO).expect("place a Factory");
    let mut client = Client::connect(sub);
    client.keep_up();
    sim.run(Some(LAG_TICKS), Duration::ZERO).expect("run past the broadcast");
    let stale = client.kf.borrow().clone();
    ctx.send(ControlMsg::New).expect("send New");
    sim.run(Some(1), Duration::ZERO).expect("the New swaps: its keyframe is buffered");
    match client.diff.try_recv() {
        Err(TryRecvError::Lagged(n)) => eprintln!("P90-WR-C-08-reset lagged_by={n}"),
        other => panic!("PRECONDITION: the client lagged, got {:?}", other.map(|f| f.bytes.len())),
    }
    let kf = decode(&client.relay.lagged(&stale));
    let sent = client.drain_after_lag();
    eprintln!("P90-WR-C-08-reset stale_keyframe={:?} forwarded={sent:?}", (kf.generation, kf.tick));
    let reset = sent.iter().find(|(g, _, full)| *g == kf.generation + 1 && *full);
    let Some((_, reset_tick, _)) = reset else {
        panic!("THE RESET BUFFERED BEHIND A STALE LAG KEYFRAME IS FORWARDED: the new generation's keyframe");
    };
    assert!(
        *reset_tick < kf.tick,
        "PRECONDITION: the New's keyframe re-seeded the tick ({reset_tick}) below the stale keyframe's {}",
        kf.tick
    );
    assert!(
        sent.iter().all(|(g, t, _)| (*g, *t) > (kf.generation, kf.tick)),
        "and nothing at or below the stale keyframe is"
    );
}
