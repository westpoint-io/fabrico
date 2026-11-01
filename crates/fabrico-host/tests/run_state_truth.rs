//! Phase 90 red-first probes (plan 90-01, D-14): what the run state is after a Save or a Step
//! on a running board, on the real `SimLoop` over the real demo board.
//!
//! FAIL-04 (D-08). At `PHASE90_START` a Save on a running board latched, drained to quiescence,
//! wrote the file and then left the host Frozen: only a latched Load, New or example resumed after
//! the drain (`sim_loop.rs` Draining-to-Frozen arm). The page was never told, so it read the
//! silence as a dropped stream, and every webhook got a 503 until the user Loaded. Since plan 90-02
//! (D-08) a Save on a running board carries on running once the file is written; one the user
//! paused stays paused.
//!
//! FAIL-03 (D-07, research Finding C). At `PHASE90_START` the Step arm set Frozen from any state
//! without recording the user's hold (`drain_from_user_pause`), so a demo load after a Step from
//! Playing resumed over it; and a Step that landed while a latched Save drained froze the drain on
//! the spot, so the file was never written. Since plan 90-02 a Step from Playing counts as a user
//! Pause, and a Step during a Save drain still writes the file.
//!
//! Each probe prints its measured facts (`P90-` lines) before it asserts. Each was `#[ignore]`d at
//! `PHASE90_START` and plan 90-02 turned all three on (no body edit).
//!
//! The dev fault seam (D-13, research Finding A, plan 90-02). `SimLoop::with_dev_fault` hands the
//! loop a flag that, once set, makes the next `step()` return the injected store error, checked as
//! the first thing `step()` does, so it fires from every run state (a paused board is Frozen, and
//! the Frozen arm never ticks). Only `dev_render_server` wires it (plan 90-06); the shell never
//! calls it. The last four tests here pin it.

use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use fabrico_core::core::Core;
use fabrico_core::event::{LogHeader, SCHEMA_VERSION};
use fabrico_core::persist::{RedbStore, StoreError};
use fabrico_host::config::HostConfig;
use fabrico_host::demo_scene::{DEMO_GENESIS_SEED, SceneId, boot_scene};
use fabrico_host::driver::Host;
use fabrico_host::ingress::seen_set::SeenSet;
use fabrico_host::ledger::DispatchLedger;
use fabrico_host::project::load_project;
use fabrico_host::render_packet::{RenderFrame, RenderProducer};
use fabrico_host::sim_loop::{
    ControlMsg, DEV_FAULT_REASON, GestureTx, MAX_SETTLE_TICKS, SimLoop, gesture_channel,
};
use tokio::sync::mpsc::{UnboundedSender, unbounded_channel};
use tokio::sync::{broadcast, watch};

/// How many steps `busy` may take to see the demo put an item in flight.
const BUSY_BUDGET: u64 = 600;
/// The most steps a latched drain can take, plus a margin for the control round trip.
const DRAIN_BUDGET: u64 = MAX_SETTLE_TICKS + 8;
/// How many steps the FAIL-04 probe watches the tick after the save.
const RUN_ON_STEPS: u64 = 30;

/// The demo board on a real `SimLoop`, as `dev_render_server` boots it.
struct Demo {
    sim: SimLoop,
    ctl: UnboundedSender<ControlMsg>,
    playing: Arc<AtomicBool>,
    dir: tempfile::TempDir,
    // Held so the gesture and render channels stay open for the whole probe.
    _gestures: GestureTx,
    _sub: (watch::Receiver<RenderFrame>, broadcast::Receiver<RenderFrame>),
    _rt: tokio::runtime::Runtime,
}

fn demo() -> Demo {
    demo_with(|sim| sim)
}

/// The demo board on a real `SimLoop`, with the dev fault seam wired to a fresh flag.
fn demo_with_dev_fault() -> (Demo, Arc<AtomicBool>) {
    let flag = Arc::new(AtomicBool::new(false));
    let wired = Arc::clone(&flag);
    (demo_with(move |sim| sim.with_dev_fault(wired)), flag)
}

/// The demo board, its `SimLoop` passed through `wire` before anything subscribes to it.
fn demo_with(wire: impl FnOnce(SimLoop) -> SimLoop) -> Demo {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("runtime");
    let dir = tempfile::tempdir().expect("tempdir");
    let core = Core::genesis(LogHeader {
        schema_version: SCHEMA_VERSION,
        seed: DEMO_GENESIS_SEED,
    });
    let store = RedbStore::open(dir.path().join("log.redb")).expect("store");
    let ledger = DispatchLedger::open(dir.path().join("ledger.redb")).expect("ledger");
    let seen = SeenSet::open(dir.path().join("seen.redb")).expect("seen-set");
    let host = Host::new(core, store, ledger, None)
        .expect("host")
        .with_seen_set(seen);
    let host = boot_scene(host, SceneId::Demo).expect("boot the demo board");
    let cfg = HostConfig {
        webhook_addr: "127.0.0.1:0".parse().expect("addr"),
    };
    let (gtx, grx) = gesture_channel();
    let (ctl, crx) = unbounded_channel::<ControlMsg>();
    let sim = wire(
        SimLoop::new(host, RenderProducer::new(), rt.handle(), cfg, grx)
            .with_loaded_scene(SceneId::Demo)
            .with_control(crx),
    );
    let sub = sim.subscribe();
    let playing = sim.is_playing_flag();
    Demo {
        sim,
        ctl,
        playing,
        dir,
        _gestures: gtx,
        _sub: sub,
        _rt: rt,
    }
}

impl Demo {
    fn in_flight(&self) -> (usize, usize) {
        (
            self.sim.host().in_flight_len(),
            self.sim.host().belt_items_in_flight(),
        )
    }

    fn tick(&self) -> u64 {
        self.sim.host().core().tick
    }

    fn step(&mut self) {
        self.sim.run(Some(1), Duration::ZERO).expect("one step");
    }

    fn send(&self, msg: ControlMsg) {
        self.ctl.send(msg).expect("send a control message");
    }

    /// One line of facts: the run state the page would be told, the in-flight counts, the tick.
    fn facts(&self, case: &str, phase: &str) {
        let (fx, belt) = self.in_flight();
        eprintln!(
            "P90-{case} phase={phase} paused={} playing={} in_flight={fx} belt_items={belt} tick={}",
            self.sim.is_paused(),
            self.playing.load(Ordering::Acquire),
            self.tick()
        );
    }

    /// Step until the demo has something in flight, so a Save or a Load latches and drains.
    fn busy(&mut self, case: &str) {
        for _ in 0..BUSY_BUDGET {
            let (fx, belt) = self.in_flight();
            if fx + belt > 0 {
                self.facts(case, "busy");
                return;
            }
            self.step();
        }
        panic!("PRECONDITION: the demo board put an item in flight within {BUSY_BUDGET} steps");
    }

    /// Step until `path` exists, at most `DRAIN_BUDGET` steps; returns the steps taken or None.
    fn until_written(&mut self, path: &Path) -> Option<u64> {
        for n in 1..=DRAIN_BUDGET {
            self.step();
            if path.exists() {
                return Some(n);
            }
        }
        None
    }
}

/// FAIL-04 (D-08): a Save on a running board writes the file and then keeps playing.
#[test]
fn a_save_on_a_running_board_writes_the_file_and_keeps_playing() {
    let mut d = demo();
    d.busy("FAIL-04");
    let path = d.dir.path().join("running.fab");
    d.send(ControlMsg::Save(path.clone()));
    let steps = d.until_written(&path);
    eprintln!("P90-FAIL-04 written_after_steps={steps:?}");
    assert!(
        steps.is_some(),
        "PRECONDITION: the latched Save wrote {} within {DRAIN_BUDGET} steps",
        path.display()
    );
    // Review IN-C-05: the probe is about the Draining arm D-08 changed, so the save must have
    // latched and drained; an inline save (written on the first step) never froze anything.
    assert!(
        steps.unwrap() > 1,
        "PRECONDITION: the save latched and drained (it took {steps:?} steps)"
    );
    d.facts("FAIL-04", "file-written");
    let at_save = d.tick();
    for _ in 0..RUN_ON_STEPS {
        d.step();
    }
    d.facts("FAIL-04", "after-30-steps");
    eprintln!("P90-FAIL-04 tick_at_save={at_save} tick_after={}", d.tick());
    assert!(
        !d.sim.is_paused(),
        "A SAVE ON A RUNNING BOARD KEEPS PLAYING: the sim is not paused once the file exists"
    );
    assert!(
        d.playing.load(Ordering::Acquire),
        "A SAVE ON A RUNNING BOARD KEEPS PLAYING: the not-Playing flag webhooks read says Playing"
    );
    assert!(
        d.tick() > at_save,
        "A SAVE ON A RUNNING BOARD KEEPS PLAYING: the core tick advanced over the next {RUN_ON_STEPS} steps"
    );
}

/// FAIL-03 (D-07): a Step taken from Playing is the user's own hold, so a demo load after it
/// installs the demo and stays paused.
#[test]
fn a_step_from_playing_then_a_demo_load_stays_paused() {
    let mut d = demo();
    d.busy("FAIL-03-host");
    // Run the board on so its tick is well past where the demo's genesis restarts.
    for _ in 0..200 {
        d.step();
    }
    assert!(
        d.playing.load(Ordering::Acquire),
        "PRECONDITION: the demo is playing before the Step"
    );
    d.facts("FAIL-03-host", "before-step");
    let before_step = d.tick();
    d.send(ControlMsg::Step);
    d.step();
    d.facts("FAIL-03-host", "after-step");
    // Review fix pass 1, WR-C-07: D-07 says a Step from Playing runs exactly one tick and
    // holds, and does not drain first (a drain on a busy board advances many ticks).
    assert_eq!(
        d.tick(),
        before_step + 1,
        "A STEP FROM PLAYING MOVES EXACTLY ONE TICK (no drain)"
    );
    assert!(d.sim.is_paused(), "A STEP FROM PLAYING HOLDS AT ONCE");
    let (fx, belt) = d.in_flight();
    assert!(
        fx + belt > 0,
        "PRECONDITION and proof: the board was not drained (items still in flight)"
    );
    let before = d.tick();
    d.send(ControlMsg::LoadDemo);
    let mut swapped = None;
    for n in 1..=DRAIN_BUDGET {
        d.step();
        if d.tick() < before {
            swapped = Some(n);
            break;
        }
    }
    eprintln!("P90-FAIL-03-host tick_before_load={before} swapped_after_steps={swapped:?}");
    assert!(
        swapped.is_some(),
        "PRECONDITION: the demo load swapped the board (its tick restarted below {before}) within {DRAIN_BUDGET} steps"
    );
    d.facts("FAIL-03-host", "after-swap");
    assert!(
        d.sim.is_paused(),
        "A STEP FROM PLAYING IS A HOLD: the demo load after it stays paused"
    );
    assert!(
        !d.playing.load(Ordering::Acquire),
        "A STEP FROM PLAYING IS A HOLD: the not-Playing flag says not Playing after the swap"
    );
}

/// FAIL-03 (research Finding C): a Step that lands while a latched Save drains does not strand
/// the Save. The drain runs on, the file is written, and the sim is paused (the user stepped).
#[test]
fn a_step_while_a_save_drains_still_writes_the_file() {
    let mut d = demo();
    d.busy("FAIL-03-drain");
    let path = d.dir.path().join("stepped.fab");
    // Both in one control batch: the Save latches and drains, then the Step arrives.
    d.send(ControlMsg::Save(path.clone()));
    d.send(ControlMsg::Step);
    let steps = d.until_written(&path);
    d.facts("FAIL-03-drain", "after-budget");
    eprintln!(
        "P90-FAIL-03-drain written_after_steps={steps:?} file_exists={}",
        path.exists()
    );
    assert!(
        steps.is_some(),
        "A STEP DURING A SAVE DRAIN STILL SAVES: {} written within {DRAIN_BUDGET} steps",
        path.display()
    );
    // Review IN-C-05: the Step must have landed in a drain, not after an inline save.
    assert!(
        steps.unwrap() > 1,
        "PRECONDITION: the save latched and drained (it took {steps:?} steps)"
    );
    assert!(
        d.sim.is_paused(),
        "A STEP DURING A SAVE DRAIN STILL SAVES: the sim is paused afterwards (the user stepped)"
    );
}

/// The error the dev fault seam returns, as `step()` hands it to `run` (research Finding L).
fn dev_fault_error() -> StoreError {
    StoreError::Backend(DEV_FAULT_REASON.to_owned())
}

/// D-13: a dev fault set while the board plays makes the next step return the store error.
#[test]
fn a_dev_fault_set_while_playing_fails_the_next_step() {
    let (mut d, flag) = demo_with_dev_fault();
    d.busy("FAIL-01-seam-playing");
    assert!(
        d.playing.load(Ordering::Acquire),
        "PRECONDITION: the demo is playing when the fault is set"
    );
    flag.store(true, Ordering::Release);
    let got = d.sim.step();
    eprintln!("P90-FAIL-01-seam phase=playing step={got:?}");
    assert_eq!(
        got,
        Err(dev_fault_error()),
        "THE DEV FAULT FIRES WHILE PLAYING: the next step returns the injected store error"
    );
}

/// D-13, research Finding A: a dev fault set on a paused board (Frozen, where no tick runs)
/// still fires, because it is checked at the top of `step()` and not in `tick_body`.
#[test]
fn a_dev_fault_set_while_frozen_fails_the_next_step() {
    let (mut d, flag) = demo_with_dev_fault();
    d.busy("FAIL-01-seam-frozen");
    d.send(ControlMsg::Pause);
    for _ in 0..DRAIN_BUDGET {
        d.step();
        if d.sim.is_paused() {
            break;
        }
    }
    d.facts("FAIL-01-seam-frozen", "paused");
    assert!(
        d.sim.is_paused() && !d.playing.load(Ordering::Acquire),
        "PRECONDITION: the Pause settled the board to Frozen within {DRAIN_BUDGET} steps"
    );
    flag.store(true, Ordering::Release);
    let got = d.sim.step();
    eprintln!("P90-FAIL-01-seam phase=frozen step={got:?}");
    assert_eq!(
        got,
        Err(dev_fault_error()),
        "THE DEV FAULT FIRES WHILE FROZEN: the next step returns the injected store error"
    );
}

/// D-13: a seam that is wired but never set changes nothing: 50 steps, every one `Ok`, and the
/// board keeps ticking.
#[test]
fn an_unset_dev_fault_changes_nothing() {
    let (mut d, flag) = demo_with_dev_fault();
    let before = d.tick();
    let mut errors = Vec::new();
    for _ in 0..50 {
        if let Err(e) = d.sim.step() {
            errors.push(e);
        }
    }
    eprintln!(
        "P90-FAIL-01-seam phase=unset errors={} tick_before={before} tick_after={}",
        errors.len(),
        d.tick()
    );
    assert!(errors.is_empty(), "AN UNSET DEV FAULT CHANGES NOTHING: no step failed ({errors:?})");
    assert!(!flag.load(Ordering::Acquire), "the flag was never set");
    assert!(d.tick() > before, "the board kept ticking over the 50 steps");
}

/// D-13: the dev fault fires once: the flag reads false after it fired, and the step after it
/// is `Ok` (whoever drives the seam decides whether to stop; `run` stops on the first error).
#[test]
fn a_dev_fault_fires_once() {
    let (mut d, flag) = demo_with_dev_fault();
    flag.store(true, Ordering::Release);
    let first = d.sim.step();
    let flag_after = flag.load(Ordering::Acquire);
    let second = d.sim.step();
    eprintln!("P90-FAIL-01-seam phase=once first={first:?} flag_after={flag_after} second={second:?}");
    assert_eq!(first, Err(dev_fault_error()), "the set fault fired on the first step");
    assert!(!flag_after, "THE DEV FAULT FIRES ONCE: the flag reads false after it fired");
    assert_eq!(second, Ok(()), "THE DEV FAULT FIRES ONCE: the next step is Ok");
}

/// Review fix pass 1, CR-A-01: a Resume that follows a Step during a Save drain does not cancel
/// the Save. The page cleared its Unsaved badge when it sent the Save, so a cancelled Save lost
/// the user's edits in silence. Since D-08 a Save drain resumes after the write, so the Resume
/// only lifts the user's hold: the drain finishes, the file is written and the board plays on.
#[test]
fn a_resume_after_a_step_during_a_save_drain_still_writes_the_file_and_plays() {
    let mut d = demo();
    d.busy("CR-A-01-step");
    let path = d.dir.path().join("step-then-play.fab");
    // One control batch: the Save latches and drains, the Step joins the drain, Play follows.
    d.send(ControlMsg::Save(path.clone()));
    d.send(ControlMsg::Step);
    d.send(ControlMsg::Resume);
    let steps = d.until_written(&path);
    d.facts("CR-A-01-step", "after");
    eprintln!("P90-CR-A-01-step written_after_steps={steps:?}");
    assert!(
        steps.is_some(),
        "A RESUME DURING A SAVE DRAIN KEEPS THE SAVE: {} written within {DRAIN_BUDGET} steps",
        path.display()
    );
    d.step();
    assert!(
        !d.sim.is_paused() && d.playing.load(Ordering::Acquire),
        "A RESUME DURING A SAVE DRAIN KEEPS THE SAVE: the board plays once the file is written"
    );
}

/// Review fix pass 1, CR-A-01: the same with Pause then Play while the Save drains.
#[test]
fn a_pause_then_resume_during_a_save_drain_still_writes_the_file_and_plays() {
    let mut d = demo();
    d.busy("CR-A-01-pause");
    let path = d.dir.path().join("pause-then-play.fab");
    d.send(ControlMsg::Save(path.clone()));
    d.step();
    assert!(!path.exists(), "PRECONDITION: the Save latched behind a drain (no file after one step)");
    d.send(ControlMsg::Pause);
    d.step();
    d.send(ControlMsg::Resume);
    let steps = d.until_written(&path);
    d.facts("CR-A-01-pause", "after");
    eprintln!("P90-CR-A-01-pause written_after_steps={steps:?}");
    assert!(
        steps.is_some(),
        "PAUSE THEN PLAY DURING A SAVE DRAIN KEEPS THE SAVE: {} written within {DRAIN_BUDGET} steps",
        path.display()
    );
    d.step();
    assert!(
        !d.sim.is_paused() && d.playing.load(Ordering::Acquire),
        "PAUSE THEN PLAY DURING A SAVE DRAIN KEEPS THE SAVE: the board plays once the file is written"
    );
}

/// Review fix pass 1, WR-B-05 (host half): Pause then Play while a New drains does not cancel
/// the New. The page has already cleared the save target and the dirty flag for it, so the host
/// keeps it, swaps at the drain's settle and plays (the hold was lifted).
#[test]
fn a_pause_then_resume_during_a_latched_new_still_swaps_and_plays() {
    let mut d = demo();
    d.busy("WR-B-05-new");
    d.send(ControlMsg::New);
    d.step();
    assert!(
        d.sim.host().core().state.node_count() > 0,
        "PRECONDITION: the New latched behind a drain (the demo is still on the board)"
    );
    d.send(ControlMsg::Pause);
    d.step();
    d.send(ControlMsg::Resume);
    let mut swapped = None;
    for n in 1..=DRAIN_BUDGET {
        d.step();
        if d.sim.host().core().state.node_count() == 0 {
            swapped = Some(n);
            break;
        }
    }
    d.facts("WR-B-05-new", "after");
    eprintln!("P90-WR-B-05-new swapped_after_steps={swapped:?}");
    assert!(swapped.is_some(), "A RESUME DURING A LATCHED NEW KEEPS IT: the empty board is installed");
    d.step();
    assert!(
        !d.sim.is_paused() && d.playing.load(Ordering::Acquire),
        "A RESUME DURING A LATCHED NEW KEEPS IT: the new board plays (the hold was lifted)"
    );
}

/// Review fix pass 1, WR-B-05 (host half): Pause then Play while a file Load drains does not
/// cancel the Load, so the page's pending `Loading...` resolves on the swap instead of a
/// reasonless `Load failed` at the page's cut-off.
#[test]
fn a_pause_then_resume_during_a_latched_file_load_still_swaps_and_plays() {
    let mut d = demo();
    d.busy("WR-B-05-load");
    let path = d.dir.path().join("to-open.fab");
    d.send(ControlMsg::Save(path.clone()));
    assert!(d.until_written(&path).is_some(), "PRECONDITION: the file to open was written");
    let saved_at = d.tick();
    for _ in 0..200 {
        d.step();
    }
    d.busy("WR-B-05-load");
    let before = d.tick();
    d.send(ControlMsg::Load(path));
    d.step();
    assert!(d.tick() > before, "PRECONDITION: the Load latched behind a drain (the board ran on)");
    d.send(ControlMsg::Pause);
    d.step();
    d.send(ControlMsg::Resume);
    let mut swapped = None;
    for n in 1..=DRAIN_BUDGET {
        d.step();
        if d.tick() < before {
            swapped = Some(n);
            break;
        }
    }
    d.facts("WR-B-05-load", "after");
    eprintln!("P90-WR-B-05-load saved_at={saved_at} before={before} swapped_after_steps={swapped:?}");
    assert!(
        swapped.is_some(),
        "A RESUME DURING A LATCHED LOAD KEEPS IT: the file's board (tick restarted below {before}) is installed"
    );
    d.step();
    assert!(
        !d.sim.is_paused() && d.playing.load(Ordering::Acquire),
        "A RESUME DURING A LATCHED LOAD KEEPS IT: the loaded board plays (the hold was lifted)"
    );
}

/// Review fix pass 1, IN-A-02: a Step during a plain Pause drain (no Save or Load latched)
/// steps one tick and holds, as it did before phase 90. Joining the drain is for a latched
/// Save or Load only, which a freeze would strand; with nothing latched, joining made the `.`
/// press do nothing visible until the drain settled.
#[test]
fn a_step_during_a_plain_pause_drain_steps_one_tick_and_holds() {
    let mut d = demo();
    d.busy("IN-A-02");
    d.send(ControlMsg::Pause);
    d.step();
    assert!(
        !d.sim.is_paused(),
        "PRECONDITION: the Pause entered a drain (the busy board did not settle in one tick)"
    );
    let before = d.tick();
    d.send(ControlMsg::Step);
    d.step();
    d.facts("IN-A-02", "after-step");
    assert_eq!(d.tick(), before + 1, "A STEP DURING A PAUSE DRAIN MOVES EXACTLY ONE TICK");
    assert!(d.sim.is_paused(), "A STEP DURING A PAUSE DRAIN HOLDS AT ONCE");
    d.step();
    assert_eq!(d.tick(), before + 1, "and the board stays where the Step left it");
}

impl Demo {
    /// Run the board on, then Step from Playing until the frozen board holds belt items and no
    /// executor effect: the held board WR-A-02 is about (D-07 freezes it on the spot).
    ///
    /// A Step holds the board, and a command the executor hasn't picked up by then parks until a
    /// Resume. On a slow machine those pile up and the count of effects in flight only climbs. So
    /// each Step starts from no effect in flight, with a 1 ms sleep per tick to give the executor
    /// time, and a Step that leaves an effect in flight is followed by a Resume so the board runs
    /// on until that effect has folded. The last control message is always a Step, so the board
    /// this returns is held by a Step, as it would be for a user pressing it. The wait for effects
    /// stops at 10 drain budgets across all the Steps, so a board whose effects never fold fails
    /// in seconds, not minutes.
    fn stepped_with_items_on_the_belts(&mut self, case: &str) {
        self.busy(case);
        for _ in 0..200 {
            self.step();
        }
        let mut waited = 0;
        for _ in 0..BUSY_BUDGET {
            for _ in 0..DRAIN_BUDGET {
                if self.in_flight().0 == 0 {
                    break;
                }
                waited += 1;
                assert!(
                    waited <= 10 * DRAIN_BUDGET,
                    "PRECONDITION: the effects in flight folded within {} ticks of waiting",
                    10 * DRAIN_BUDGET
                );
                std::thread::sleep(Duration::from_millis(1));
                self.step();
            }
            self.send(ControlMsg::Step);
            self.step();
            let (fx, belt) = self.in_flight();
            if fx == 0 && belt > 0 {
                self.facts(case, "stepped");
                assert!(self.sim.is_paused(), "PRECONDITION: the Step holds the board");
                return;
            }
            if fx > 0 {
                self.send(ControlMsg::Resume);
            }
        }
        panic!("PRECONDITION: a Step left belt items and no effect in flight within {BUSY_BUDGET} steps");
    }
}

/// A Step on a held board folds a result the executor has sent since the hold. The sleep gives the
/// executor time to answer, and a slow answer or a newly dispatched effect just takes another round.
#[test]
fn a_step_on_a_held_board_folds_an_answered_effect() {
    let mut d = demo();
    d.busy("step-folds");
    for _ in 0..200 {
        d.step();
    }
    let mut folded = false;
    for _ in 0..BUSY_BUDGET {
        d.send(ControlMsg::Step);
        d.step();
        let before = d.in_flight().0;
        if before > 0 {
            std::thread::sleep(Duration::from_millis(20));
            d.send(ControlMsg::Step);
            d.step();
            if d.in_flight().0 < before {
                folded = true;
                break;
            }
        }
        d.send(ControlMsg::Resume);
        d.step();
    }
    assert!(folded, "A STEP ON A HELD BOARD FOLDS AN ANSWERED EFFECT");
}

/// Review fix pass 1, WR-A-02: a Save on a board the user stepped or paused, with items still
/// on its belts, writes the file from where the board stands. It does not drain the board on
/// under a page that reads Paused. The belt items are part of the saved state (a tick boundary
/// captures everything); only an executor effect in flight makes a save unsafe (`save_project`'s
/// NotQuiescent check), and there is none here.
#[test]
fn a_save_on_a_stepped_board_writes_where_it_stands() {
    let mut d = demo();
    d.stepped_with_items_on_the_belts("WR-A-02-save");
    let (tick, belt) = (d.tick(), d.in_flight().1);
    let path = d.dir.path().join("held.fab");
    d.send(ControlMsg::Save(path.clone()));
    d.step();
    d.facts("WR-A-02-save", "after-one-step");
    assert!(path.exists(), "A SAVE ON A HELD BOARD IS WRITTEN AT ONCE: {} exists after one step", path.display());
    assert_eq!(d.tick(), tick, "A SAVE ON A HELD BOARD DOES NOT RUN IT ON: the tick did not move");
    assert!(d.sim.is_paused(), "A SAVE ON A HELD BOARD STAYS PAUSED");
    let work = tempfile::tempdir().expect("tempdir");
    let reopened = load_project(&path, work.path(), None).expect("the saved file opens");
    assert_eq!(
        (reopened.core().tick, reopened.belt_items_in_flight()),
        (tick, belt),
        "THE SAVED FILE HOLDS THE BOARD AS IT STOOD: its tick and its belt items"
    );
}

/// Review fix pass 1, WR-A-02: a New on a held board swaps at once and stays paused.
#[test]
fn a_new_on_a_stepped_board_swaps_where_it_stands() {
    let mut d = demo();
    d.stepped_with_items_on_the_belts("WR-A-02-new");
    d.send(ControlMsg::New);
    d.step();
    d.facts("WR-A-02-new", "after-one-step");
    assert_eq!(
        d.sim.host().core().state.node_count(),
        0,
        "A NEW ON A HELD BOARD SWAPS AT ONCE: the empty board is installed after one step"
    );
    assert!(d.sim.is_paused(), "A NEW ON A HELD BOARD STAYS PAUSED");
}

/// Review fix pass 1, WR-A-02: a file Load on a held board swaps at once and stays paused.
#[test]
fn a_file_load_on_a_stepped_board_swaps_where_it_stands() {
    let mut d = demo();
    d.busy("WR-A-02-load");
    let path = d.dir.path().join("to-open.fab");
    d.send(ControlMsg::Save(path.clone()));
    assert!(d.until_written(&path).is_some(), "PRECONDITION: the file to open was written");
    let saved = load_project(&path, tempfile::tempdir().expect("tempdir").path(), None)
        .expect("the file opens")
        .core()
        .tick;
    d.stepped_with_items_on_the_belts("WR-A-02-load");
    d.send(ControlMsg::Load(path));
    d.step();
    d.facts("WR-A-02-load", "after-one-step");
    assert_eq!(d.tick(), saved, "A LOAD ON A HELD BOARD SWAPS AT ONCE: the file's tick after one step");
    assert!(d.sim.is_paused(), "A LOAD ON A HELD BOARD STAYS PAUSED");
}

/// Review fix pass 1, WR-A-01: once the sim loop has ended on a fatal, the webhook and endpoint
/// doors refuse at once with a 503. Before the fix the dev host parked with the loop's receivers
/// alive and the not-Playing flag left at its last value (usually Playing), so a POST was
/// enqueued and then waited forever for an answer no sim thread would give.
#[test]
fn after_a_fatal_the_webhook_and_endpoint_doors_refuse_at_once() {
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use fabrico_host::ingress::endpoint::{ENDPOINT_INGRESS_CAPACITY, EndpointIngress};
    use fabrico_host::ingress::webhook::{Ingress, WEBHOOK_INGRESS_CAPACITY, webhook_router};
    use tower::ServiceExt;

    let flag = Arc::new(AtomicBool::new(false));
    let wired = Arc::clone(&flag);
    let (wtx, wrx) = tokio::sync::mpsc::channel::<Ingress>(WEBHOOK_INGRESS_CAPACITY);
    let (etx, erx) = tokio::sync::mpsc::channel::<EndpointIngress>(ENDPOINT_INGRESS_CAPACITY);
    let mut d = demo_with(move |sim| sim.with_dev_fault(wired).with_webhook(wrx).with_endpoint(erx));
    let app = webhook_router(d.sim.routes_receiver(), wtx, etx, 4096, d.sim.is_playing_flag());
    // The demo's Source runs on a timer and has no webhook door: place one that does, far from
    // the demo's machines (a placed Source starts on Webhook).
    {
        use fabrico_host::sim_loop::GestureSink;
        d._gestures
            .send_gesture(fabrico_protocol::GridCommand::Place {
                kind: fabrico_protocol::machine_kind::SOURCE,
                cell_x: 60,
                cell_y: 60,
            })
            .expect("send the Place");
    }
    for _ in 0..3 {
        d.step();
    }
    let keys: Vec<String> = d.sim.routes_receiver().borrow().keys().cloned().collect();
    eprintln!("P90-WR-A-01 routes={keys:?}");
    let hook = keys.iter().find(|k| k.starts_with("src-")).expect("PRECONDITION: the demo has a webhook Source");
    let endpoint = keys.iter().find(|k| k.starts_with('/')).expect("PRECONDITION: the demo has an Endpoint route");
    assert!(d.playing.load(Ordering::Acquire), "PRECONDITION: the demo is playing when the fault fires");

    flag.store(true, Ordering::Release);
    let ended = d.sim.run(None, Duration::ZERO);
    assert_eq!(ended, Err(dev_fault_error()), "PRECONDITION: the loop ended on the injected fault");

    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("runtime");
    for uri in [format!("/hook/{hook}"), format!("/endpoint{endpoint}")] {
        let req = Request::builder().method("POST").uri(&uri).body(Body::from("{}")).expect("request");
        let answered = rt.block_on(async { tokio::time::timeout(Duration::from_secs(2), app.clone().oneshot(req)).await });
        eprintln!("P90-WR-A-01 uri={uri} answered={:?}", answered.as_ref().map(|r| r.as_ref().map(|r| r.status())));
        let status = answered
            .unwrap_or_else(|_| panic!("AFTER A FATAL {uri} IS ANSWERED AT ONCE: no answer within 2 s"))
            .expect("route the request")
            .status();
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "AFTER A FATAL {uri} IS REFUSED WITH A 503");
    }
}
