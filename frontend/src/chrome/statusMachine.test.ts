// statusMachine.test.ts — the SHELL-07 honesty latch (WR-02/WR-03).
//
// Drives makeStatusMachine with a FAKE timer seam so the load cut-off + auto-clear
// races are deterministic. Asserts the honesty invariants: a Save, a notice or a cancelled
// dialog during a Load leaves it pending, only a Load's own swap keyframe announces
// "Loaded" (an Undo's never does, D-06), and a Load the host is still draining is
// never called failed.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LOAD_TICK_BUDGET,
  makeStatusMachine,
  type KeyframeFields,
  type StatusMachine,
  type StatusMachineDeps,
} from './statusMachine.ts';
import { STATUS_COPY, type StatusKind } from './controlHandlers.ts';
import { makeHostWorkGate, makeStatusWatchdog } from './statusWatchdog.ts';

const LOAD_TIMEOUT_MS = 10_000;
const AUTOCLEAR_MS = 4_000;

/** The swap keyframe of a Load dispatched over a board whose swap floor is 0 (D-06). */
const SWAP: KeyframeFields = { full: true, generation: 1, swap_floor: 1 };
/** A diff of the board still on screen while the host drains (no swap yet). */
const diffAt = (tick: number): KeyframeFields => ({ full: false, generation: 0, swap_floor: 0, tick });

/**
 * A controllable fake timer: records armed callbacks with their delay and a live
 * flag, and `advance(ms)` fires exactly those whose deadline has elapsed (in arm
 * order). Cancelled timers never fire. This models setTimeout/clearTimeout tightly
 * enough for the latch without leaning on vitest's global fake timers.
 */
function fakeClock() {
  interface Timer {
    id: number;
    at: number;
    fn: () => void;
    live: boolean;
  }
  let nextId = 1;
  let nowMs = 0;
  const timers: Timer[] = [];
  const setTimer = (fn: () => void, ms: number): number => {
    const id = nextId++;
    timers.push({ id, at: nowMs + ms, fn, live: true });
    return id;
  };
  const clearTimer = (id: number): void => {
    const t = timers.find((x) => x.id === id);
    if (t) t.live = false;
  };
  const advance = (ms: number): void => {
    const deadline = nowMs + ms;
    // Fire due, live timers in arm order; a fired timer is spent. Loop so a timer
    // armed BY a fired callback within the window can also fire.
    for (;;) {
      const due = timers.find((t) => t.live && t.at <= deadline);
      if (!due) break;
      due.live = false;
      nowMs = due.at;
      due.fn();
    }
    nowMs = deadline;
  };
  const liveCount = (): number => timers.filter((t) => t.live).length;
  return { setTimer, clearTimer, advance, liveCount };
}

function harnessWith(extra: Partial<StatusMachineDeps<number>>) {
  const emitted: StatusKind[] = [];
  const clock = fakeClock();
  const machine: StatusMachine = makeStatusMachine({
    setStatus: (kind) => emitted.push(kind),
    loadTimeoutMs: LOAD_TIMEOUT_MS,
    autoClearMs: AUTOCLEAR_MS,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    ...extra,
  });
  return { emitted, clock, machine };
}

function harness() {
  return harnessWith({});
}

describe('statusMachine — SHELL-07 honest latch', () => {
  it('a plain load resolves to "loaded" on its swap keyframe', () => {
    const { emitted, machine } = harness();
    machine.apply('loading');
    expect(machine.isLoadInFlight()).toBe(true);
    machine.resolveKeyframe(SWAP);
    expect(machine.isLoadInFlight()).toBe(false);
    expect(emitted).toEqual(['loading', 'loaded']);
  });

  it('a diff packet (full===false) never resolves a pending load, even one at the new floor', () => {
    const { emitted, machine } = harness();
    machine.apply('loading');
    machine.resolveKeyframe(diffAt(10));
    // A diff after a swap also has swap_floor === generation: `full` is the term that excludes it.
    machine.resolveKeyframe({ full: false, generation: 1, swap_floor: 1, tick: 11 });
    expect(machine.isLoadInFlight()).toBe(true);
    expect(emitted).toEqual(['loading']);
  });

  it('a load the host never answers, with no packet at all for the window, fails honestly', () => {
    const { emitted, clock, machine } = harness();
    machine.apply('loading');
    clock.advance(LOAD_TIMEOUT_MS);
    expect(machine.isLoadInFlight()).toBe(false);
    expect(emitted).toEqual(['loading', 'loadFailed']);
  });

  // WR-02, as review pass 2 has it: a Save issued while a Load is still in flight leaves the Load
  // pending (the host runs the Save, then the Load). Its swap resolves `Loaded`, and no stale
  // cut-off writes `Load failed` afterwards, over the Save or at idle.
  it('WR-02: a Save during a pending Load the host answers never surfaces "loadFailed"', () => {
    const { emitted, clock, machine } = harness();
    machine.apply('loading');
    machine.apply('saveRequested');
    expect(machine.isLoadInFlight()).toBe(true);
    machine.resolveKeyframe(SWAP);
    clock.advance(LOAD_TIMEOUT_MS + AUTOCLEAR_MS + 1);
    expect(emitted).not.toContain('loadFailed');
    expect(emitted).toEqual(['loading', 'saveRequested', 'loaded', 'idle']);
    expect(clock.liveCount()).toBe(0);
  });

  // WR-03, as D-06 has it: an Undo or Redo keyframe that arrives during a load-in-flight
  // window must NOT announce "Loaded", and it no longer cancels the Load either: the Load's
  // own swap keyframe still resolves it, and no stale cut-off fires afterwards.
  it('WR-03: an Undo keyframe during a load resolves nothing, and the swap then resolves it', () => {
    const { emitted, clock, machine } = harness();
    machine.apply('loading');
    // The Undo's keyframe: full, generation above the swap floor the last swap left.
    machine.resolveKeyframe({ full: true, generation: 1, swap_floor: 0 });
    expect(machine.isLoadInFlight(), 'the Load is still pending').toBe(true);
    expect(emitted).toEqual(['loading']);
    machine.resolveKeyframe({ full: true, generation: 2, swap_floor: 2 });
    expect(emitted).toEqual(['loading', 'loaded']);
    clock.advance(LOAD_TIMEOUT_MS + AUTOCLEAR_MS);
    expect(emitted).toEqual(['loading', 'loaded', 'idle']);
    expect(clock.liveCount()).toBe(0);
  });

  // New or an example during a Load (WR-03's supersede, kept for the two real swaps): the
  // Load's `Loading…` is cleared, its swap resolves nothing, and no cut-off fires later.
  it('supersedeLoad clears a pending Loading, and the superseded swap resolves nothing', () => {
    const { emitted, clock, machine } = harness();
    machine.apply('loading');
    machine.supersedeLoad();
    expect(machine.isLoadInFlight()).toBe(false);
    expect(emitted).toEqual(['loading', 'idle']);
    machine.resolveKeyframe(SWAP);
    clock.advance(LOAD_TIMEOUT_MS + 1);
    expect(emitted).toEqual(['loading', 'idle']);
    expect(clock.liveCount()).toBe(0);
  });

  it('supersedeLoad with no Load on the strip writes nothing', () => {
    const { emitted, machine } = harness();
    machine.apply('saveRequested');
    machine.supersedeLoad();
    expect(emitted).toEqual(['saveRequested']);
  });

  // The slow Load (deferred from plan 90-02, 76-same-pass-delete-cascade leg 1): since D-08
  // an Open after a Save on a running board drains first, and under the CPU quota that drain
  // was measured at 17.6 s from dispatch to swap. The fixed 10 s timeout wrote `Load failed`
  // over a Load the host never refused, then the board swapped anyway. A draining host
  // sends a packet every tick, so its Load is pending, not lost.
  it('a_long_drain_never_reads_load_failed', () => {
    const { emitted, clock, machine } = harness();
    machine.apply('loading');
    // 18 s of drain: a diff every 100 ms (180 ticks, well inside the host's 512-tick budget).
    for (let t = 1; t <= 180; t += 1) {
      clock.advance(100);
      machine.resolveKeyframe(diffAt(1000 + t));
    }
    expect(emitted, 'past the old 10 s timeout the strip still reads Loading').toEqual(['loading']);
    machine.resolveKeyframe({ ...SWAP, tick: 1181 });
    expect(emitted, 'the swap resolves Loaded, and Load failed was never written').toEqual(['loading', 'loaded']);
  });

  it('a host that keeps ticking past its settle budget with no swap has lost the Load', () => {
    const { emitted, machine } = harnessWith({ loadTickBudget: LOAD_TICK_BUDGET });
    machine.apply('loading');
    machine.resolveKeyframe(diffAt(500));
    machine.resolveKeyframe(diffAt(500 + LOAD_TICK_BUDGET));
    expect(emitted, 'at the budget the Load is still pending').toEqual(['loading']);
    machine.resolveKeyframe(diffAt(501 + LOAD_TICK_BUDGET));
    expect(emitted).toEqual(['loading', 'loadFailed']);
    expect(machine.isLoadInFlight()).toBe(false);
  });

  it('a swap that still arrives after a cut-off resolves Loaded over Load failed', () => {
    const { emitted, clock, machine } = harness();
    machine.apply('loading');
    clock.advance(LOAD_TIMEOUT_MS);
    expect(emitted).toEqual(['loading', 'loadFailed']);
    clock.advance(AUTOCLEAR_MS);
    machine.resolveKeyframe({ ...SWAP, tick: 2 });
    expect(emitted).toEqual(['loading', 'loadFailed', 'idle', 'loaded']);
  });

  it('a refusal the page applies closes the Load: a later swap resolves nothing', () => {
    const { emitted, machine } = harness();
    machine.apply('loading');
    machine.refuseLoad();
    machine.resolveKeyframe(SWAP);
    expect(emitted).toEqual(['loading', 'loadFailed']);
  });

  it('the tick budget is above the host settle budget plus the diff broadcast backlog', () => {
    const root = join(import.meta.dirname, '..', '..', '..', 'crates', 'fabrico-host', 'src');
    const settle = /pub const MAX_SETTLE_TICKS: u64 = (\d+);/.exec(readFileSync(join(root, 'sim_loop.rs'), 'utf8'));
    const backlog = /const DIFF_CHANNEL_CAPACITY: usize = (\d+);/.exec(readFileSync(join(root, 'render_packet.rs'), 'utf8'));
    expect(settle, 'sim_loop.rs still declares MAX_SETTLE_TICKS').not.toBeNull();
    expect(backlog, 'render_packet.rs still declares DIFF_CHANNEL_CAPACITY').not.toBeNull();
    expect(LOAD_TICK_BUDGET).toBeGreaterThan(Number(settle![1]) + Number(backlog![1]));
  });

  // WR-03 (the disconnect re-assert): the SAFE-01 watchdog fires 'disconnected'
  // exactly once per stall and only re-clears on a reconnecting packet. On a
  // genuinely dead stream a transient status (e.g. a user Save's 'Save requested')
  // displaces the sticky 'disconnected' readout; when that transient auto-clears
  // it must RE-ASSERT 'disconnected' rather than quiescing to 'idle', or the
  // frozen board passes as a normal idle board forever.
  it('WR-03: a transient status auto-clearing while the stream is DOWN re-asserts disconnected', () => {
    const emitted: StatusKind[] = [];
    const clock = fakeClock();
    let streamDown = false;
    const machine: StatusMachine = makeStatusMachine({
      setStatus: (kind) => emitted.push(kind),
      loadTimeoutMs: LOAD_TIMEOUT_MS,
      autoClearMs: AUTOCLEAR_MS,
      isStreamDown: () => streamDown,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });

    // The stream dies: the watchdog latch is set (modelled by streamDown=true).
    // A user Save then displaces the 'disconnected' readout with 'Save requested'.
    streamDown = true;
    machine.apply('saveRequested');
    expect(emitted).toEqual(['saveRequested']);

    // The transient auto-clears - but the stream is STILL down, so it must
    // re-assert 'disconnected', NOT quiesce to 'idle'.
    clock.advance(AUTOCLEAR_MS + 1);
    expect(emitted).toEqual(['saveRequested', 'disconnected']);
    expect(emitted).not.toContain('idle');

    // Once the stream reconnects, a later transient auto-clears to idle normally.
    streamDown = false;
    machine.apply('saveRequested');
    clock.advance(AUTOCLEAR_MS + 1);
    expect(emitted).toEqual(['saveRequested', 'disconnected', 'saveRequested', 'idle']);
  });

  it('a fresh Load supersedes a prior in-flight load (only one timeout armed)', () => {
    const { emitted, clock, machine } = harness();
    machine.apply('loading');
    machine.apply('loading'); // second load supersedes the first
    // Exactly one live timeout should remain (the second load's).
    expect(clock.liveCount()).toBe(1);
    machine.resolveKeyframe(SWAP);
    clock.advance(LOAD_TIMEOUT_MS + 1);
    // Resolves once to 'loaded'; the auto-clear then returns to idle.
    expect(emitted.filter((k) => k === 'loadFailed')).toHaveLength(0);
    expect(emitted.slice(0, 3)).toEqual(['loading', 'loading', 'loaded']);
  });

  // quick/260825-iae: the paused-edit notice is a TRANSIENT kind, so it must fade
  // like a Save does - and a user editing steadily on a paused board must not
  // watch it expire under them mid-session.
  it('editsQueued auto-clears to idle after the budget, and a further edit re-arms it', () => {
    const { emitted, clock, machine } = harness();

    machine.apply('editsQueued');
    expect(emitted).toEqual(['editsQueued']);

    // Just short of the deadline: still showing, nothing cleared.
    clock.advance(AUTOCLEAR_MS - 1);
    expect(emitted).toEqual(['editsQueued']);

    // A SECOND queued edit lands before the first window closes. It must re-arm a
    // fresh window rather than letting the first timer fire early underneath it -
    // otherwise the notice vanishes 1ms after the user's most recent edit.
    machine.apply('editsQueued');
    expect(clock.liveCount(), 'exactly one auto-clear timer is ever armed').toBe(1);
    clock.advance(AUTOCLEAR_MS - 1);
    expect(emitted, 'the re-applied kind holds its own full window').toEqual([
      'editsQueued',
      'editsQueued',
    ]);

    // The second window now closes on its own deadline.
    clock.advance(2);
    expect(emitted).toEqual(['editsQueued', 'editsQueued', 'idle']);
    expect(clock.liveCount()).toBe(0);
  });

  // WR-03 again, now covering this kind: the re-assert rule is a property of the
  // auto-clear branch, so every kind that enters the transient tier inherits it.
  it('editsQueued auto-clearing while the stream is DOWN re-asserts disconnected', () => {
    const emitted: StatusKind[] = [];
    const clock = fakeClock();
    let streamDown = false;
    const machine: StatusMachine = makeStatusMachine({
      setStatus: (kind) => emitted.push(kind),
      loadTimeoutMs: LOAD_TIMEOUT_MS,
      autoClearMs: AUTOCLEAR_MS,
      isStreamDown: () => streamDown,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });

    streamDown = true;
    machine.apply('editsQueued');
    clock.advance(AUTOCLEAR_MS + 1);

    // A frozen board must not pass as a normal idle board just because a paused
    // edit displaced the sticky readout on its way past.
    expect(emitted).toEqual(['editsQueued', 'disconnected']);
    expect(emitted).not.toContain('idle');
  });

  // Plan 74.1-31 (PAUSE-TOOLBAR): the held-undo notice joins the same transient tier.
  it('undoHeld auto-clears to idle after the budget, and a further held press re-arms it', () => {
    const { emitted, clock, machine } = harness();
    machine.apply('undoHeld');
    clock.advance(AUTOCLEAR_MS - 1);
    machine.apply('undoHeld');
    expect(clock.liveCount(), 'exactly one auto-clear timer is ever armed').toBe(1);
    clock.advance(AUTOCLEAR_MS - 1);
    expect(emitted).toEqual(['undoHeld', 'undoHeld']);
    clock.advance(2);
    expect(emitted).toEqual(['undoHeld', 'undoHeld', 'idle']);
    expect(clock.liveCount()).toBe(0);
  });

  // D-06 flipped WR-02 for the held-undo notice; review pass 2 (CR-B-01) for the queued-edits
  // notice too: each says something about the paused board, which leaves the Load as pending.
  it('undoHeld and editsQueued both keep a pending load', () => {
    const { emitted, machine } = harness();
    machine.apply('loading');
    machine.apply('undoHeld');
    expect(machine.isLoadInFlight()).toBe(true);
    machine.resolveKeyframe(SWAP);
    expect(emitted).toEqual(['loading', 'undoHeld', 'loaded']);
    machine.apply('loading');
    machine.apply('editsQueued');
    expect(machine.isLoadInFlight()).toBe(true);
  });

  it('STATUS_COPY holds the held-undo sentence exactly: 39 characters, no em dash', () => {
    expect(STATUS_COPY.undoHeld).toBe('Paused - press Play before undo or redo');
    expect(STATUS_COPY.undoHeld).toHaveLength(39);
    expect(STATUS_COPY.undoHeld).not.toContain('\u2014');
  });

  // ---------------------------------------------------------------------------
  // Phase 90 red-first probes (plan 90-01, D-14), seen red at PHASE90_START behind the red-first
  // gate and turned on by plans 90-04 (WORK-10) and 90-06 (FAIL-01). Review IN-B-07: they reach the
  // API each plan added directly, so tsc checks it, and print nothing.
  // ---------------------------------------------------------------------------

  /** The harness with the swap floor read plan 90-04 adds (`readSwapFloor`). */
  function swapHarness(floor: () => number) {
    const emitted: StatusKind[] = [];
    const clock = fakeClock();
    const deps: StatusMachineDeps<number> = {
      setStatus: (kind: StatusKind) => emitted.push(kind),
      loadTimeoutMs: LOAD_TIMEOUT_MS,
      autoClearMs: AUTOCLEAR_MS,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      readSwapFloor: floor,
    };
    const machine = makeStatusMachine(deps);
    const resolve = (p: KeyframeFields): void => machine.resolveKeyframe(p);
    return { emitted, clock, machine, resolve };
  }

  it('an_undo_keyframe_during_a_load_does_not_resolve_it', () => {
    const { emitted, machine, resolve } = swapHarness(() => 0);
    machine.apply('loading');
    resolve({ full: true, generation: 2, swap_floor: 0 });
    expect(emitted, 'an Undo keyframe (generation above its swap floor) is not the swap').toEqual(['loading']);
    resolve({ full: true, generation: 3, swap_floor: 3 });
    expect(emitted, 'the swap keyframe resolves the load').toEqual(['loading', 'loaded']);
  });

  it('the_held_undo_notice_keeps_a_pending_load', () => {
    const { emitted, machine, resolve } = swapHarness(() => 0);
    machine.apply('loading');
    machine.apply('undoHeld');
    resolve({ full: true, generation: 3, swap_floor: 3 });
    expect(emitted.at(-1), 'the swap keyframe still resolves the load after the held-undo notice').toBe('loaded');
  });

  it('the_auto_clear_keeps_a_pending_load_on_screen', () => {
    const { emitted, clock, machine, resolve } = swapHarness(() => 0);
    machine.apply('loading');
    machine.apply('undoHeld');
    clock.advance(AUTOCLEAR_MS);
    expect(emitted.at(-1), 'the held-undo notice clears back to the pending load, not to idle').toBe('loading');
    resolve({ full: true, generation: 3, swap_floor: 3 });
    expect(emitted.at(-1), 'the swap keyframe still resolves the load').toBe('loaded');
  });

  it('a_stopped_status_is_never_replaced', () => {
    const { emitted, clock, machine } = harness();
    machine.apply('loading');
    machine.stop();
    machine.apply('loaded');
    clock.advance(LOAD_TIMEOUT_MS + AUTOCLEAR_MS);
    const at = emitted.lastIndexOf('simStopped');
    expect(at, 'the stop wrote the stopped status').toBeGreaterThanOrEqual(0);
    expect(emitted.at(-1), 'the readout ends on the stopped status').toBe('simStopped');
    expect(emitted.slice(at + 1).filter((k) => k === 'idle' || k === 'loaded'), 'nothing replaces it').toEqual([]);
  });

  // Phase 90 (FAIL-01, D-12): the stopped status is sticky and highest.
  it('stop() drops a latched load and both timers, and nothing after it changes the status', () => {
    const { emitted, clock, machine, resolve } = swapHarness(() => 0);
    machine.apply('saveRequested');
    machine.apply('loading');
    expect(machine.isStopped()).toBe(false);
    machine.stop();
    expect(machine.isStopped(), 'the machine reports itself stopped').toBe(true);
    expect(machine.isLoadInFlight(), 'the latched load is dropped').toBe(false);
    expect(clock.liveCount(), 'both timers are cancelled').toBe(0);
    const at = emitted.length;
    machine.apply('loaded');
    machine.apply('saveRequested');
    machine.apply('loading');
    machine.supersedeLoad();
    resolve({ full: true, generation: 3, swap_floor: 3 });
    clock.advance(LOAD_TIMEOUT_MS + AUTOCLEAR_MS);
    expect(emitted.at(at - 1), 'the stop committed the stopped status').toBe('simStopped');
    expect(emitted.slice(at), 'no later apply, supersede, swap keyframe or timer wrote anything').toEqual([]);
    expect(clock.liveCount(), 'no call after the stop armed a timer').toBe(0);
  });

  it('a second stop() writes nothing more', () => {
    const { emitted, machine } = harness();
    machine.stop();
    machine.stop();
    expect(emitted).toEqual(['simStopped']);
  });

  it('dispose cancels all pending timers (no leak across StrictMode double-boot)', () => {
    const { emitted, clock, machine } = harness();
    machine.apply('loading');
    machine.dispose();
    clock.advance(LOAD_TIMEOUT_MS + AUTOCLEAR_MS);
    expect(emitted).toEqual(['loading']);
    expect(clock.liveCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Phase 90 review fix pass 2 (90-REVIEW.md CR-B-01, WR-B-01, WR-B-07): a pending Load ends only
// when the host answers it (its swap, its refusal, its silence) or the page swaps the board itself
// (New, an example). A notice the page writes about itself, a Save, or a cancelled dialog leaves the
// Load exactly as pending as it was.
// ---------------------------------------------------------------------------

describe('statusMachine - only the host or a swap ends a pending Load (review pass 2)', () => {
  // CR-B-01: a Ctrl+Z (or any edit) on a paused board during a Load is itself queued, and its
  // `editsQueued` notice used to drop the Load: neither `Loaded` nor `Load failed` was then written.
  it('an_edit_queued_during_a_load_keeps_it_pending_and_the_swap_reads_loaded', () => {
    const { emitted, clock, machine } = harness();
    machine.apply('loading');
    machine.apply('editsQueued');
    expect(machine.isLoadInFlight(), 'the queued-edits notice leaves the Load pending').toBe(true);
    clock.advance(AUTOCLEAR_MS);
    expect(emitted.at(-1), 'the notice clears back to the pending Load').toBe('loading');
    machine.resolveKeyframe(SWAP);
    expect(emitted).toEqual(['loading', 'editsQueued', 'loading', 'loaded']);
  });

  it('an_edit_queued_during_a_refused_load_still_reads_load_failed', () => {
    const { emitted, machine } = harness();
    machine.apply('loading');
    machine.apply('editsQueued');
    expect(machine.isAwaitingSwap(), 'the page still awaits the Load').toBe(true);
    machine.refuseLoad();
    expect(emitted).toEqual(['loading', 'editsQueued', 'loadFailed']);
    expect(machine.isAwaitingSwap()).toBe(false);
    machine.resolveKeyframe(SWAP);
    expect(emitted, 'a later swap is not this refused Load').toEqual(['loading', 'editsQueued', 'loadFailed']);
  });

  // WR-B-01: a cancelled Save As or Open dialog emits `idle`.
  it('a_cancelled_dialog_during_a_load_leaves_loading_on_the_strip', () => {
    const { emitted, machine } = harness();
    machine.apply('loading');
    machine.apply('idle');
    expect(machine.isLoadInFlight()).toBe(true);
    expect(emitted.at(-1), 'the strip still says the Load is running').toBe('loading');
    machine.resolveKeyframe(SWAP);
    expect(emitted.at(-1)).toBe('loaded');
  });

  // WR-B-01: the host runs a Save latched during a drain before the Load (sim_loop.rs Draining).
  it('a_save_during_a_load_keeps_it_pending_and_the_swap_reads_loaded', () => {
    const { emitted, clock, machine } = harness();
    machine.apply('loading');
    machine.apply('saveRequested');
    expect(machine.isLoadInFlight()).toBe(true);
    clock.advance(AUTOCLEAR_MS);
    machine.resolveKeyframe(SWAP);
    expect(emitted).toEqual(['loading', 'saveRequested', 'loading', 'loaded']);
  });

  it('a_failed_save_during_a_load_keeps_it_pending', () => {
    const { emitted, machine } = harness();
    machine.apply('loading');
    machine.apply('saveFailed');
    expect(machine.isLoadInFlight()).toBe(true);
    machine.resolveKeyframe(SWAP);
    expect(emitted).toEqual(['loading', 'saveFailed', 'loaded']);
  });

  // A second Open whose dialog fails (`loadFailed` from `onLoad`'s catch) never reached the host;
  // the first Load is still on its way.
  it('a_second_open_that_fails_at_its_dialog_leaves_the_first_load_pending', () => {
    const { emitted, machine } = harness();
    machine.apply('loading');
    machine.apply('loadFailed');
    expect(machine.isLoadInFlight()).toBe(true);
    machine.resolveKeyframe(SWAP);
    expect(emitted.at(-1)).toBe('loaded');
  });

  // A Load the host stopped answering is still a failure, whatever the page wrote meanwhile.
  it('a_save_during_a_load_the_host_never_answers_reads_load_failed_at_the_cut_off', () => {
    const { emitted, clock, machine } = harness();
    machine.apply('loading');
    machine.apply('saveRequested');
    // In two steps: the fake clock fires due timers in the order they were armed.
    clock.advance(AUTOCLEAR_MS);
    clock.advance(LOAD_TIMEOUT_MS - AUTOCLEAR_MS);
    expect(emitted).toEqual(['loading', 'saveRequested', 'loading', 'loadFailed']);
  });

  // WR-B-07: App ties its pending save target to this answer, not to `isLoadInFlight`.
  it('is_awaiting_swap_holds_from_the_dispatch_through_the_cut_off_until_the_host_answers', () => {
    const { clock, machine } = harness();
    expect(machine.isAwaitingSwap()).toBe(false);
    machine.apply('loading');
    expect(machine.isAwaitingSwap()).toBe(true);
    clock.advance(LOAD_TIMEOUT_MS);
    expect(machine.isLoadInFlight(), 'the cut-off ended the in-flight latch').toBe(false);
    expect(machine.isAwaitingSwap(), 'a swap that still comes is still this Load').toBe(true);
    machine.resolveKeyframe(SWAP);
    expect(machine.isAwaitingSwap()).toBe(false);
    machine.apply('loading');
    machine.supersedeLoad();
    expect(machine.isAwaitingSwap(), 'New or an example ends it').toBe(false);
    machine.apply('loading');
    machine.stop();
    expect(machine.isAwaitingSwap(), 'the stop ends it').toBe(false);
  });
});

// Phase 90 validation audit (FAIL-04's client half) and review WR-B-02: a Save on a playing board, as
// the page sees it since D-08. The host drains (a packet a tick), writes the file in silence, then
// plays on. The machine, the stall watchdog and the host-work gate are wired as App wires them, on
// one fake clock: the strip never reads `Disconnected`.
describe('a Save on a playing board never reads Disconnected (FAIL-04, WR-B-02)', () => {
  function playingPage() {
    const emitted: StatusKind[] = [];
    const clock = fakeClock();
    let playing = true;
    let gate: ReturnType<typeof makeHostWorkGate<number>>;
    let machine: StatusMachine | null = null;
    const watchdog = makeStatusWatchdog<number>({
      isPlaying: () => playing,
      onDisconnect: () => gate.onStall(),
      onReconnect: () => {
        gate.onReconnect();
        if (emitted.at(-1) === 'disconnected') emitted.push('idle');
      },
      thresholdMs: 800,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    gate = makeHostWorkGate<number>({
      isStreamDown: () => watchdog.isDisconnected(),
      isLoadInFlight: () => machine?.isLoadInFlight() === true,
      isStopped: () => false,
      writeDisconnected: () => emitted.push('disconnected'),
      windowMs: LOAD_TIMEOUT_MS,
      tickBudget: LOAD_TICK_BUDGET,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    machine = makeStatusMachine<number>({
      setStatus: (k) => emitted.push(k),
      loadTimeoutMs: LOAD_TIMEOUT_MS,
      loadTickBudget: LOAD_TICK_BUDGET,
      autoClearMs: AUTOCLEAR_MS,
      isStreamDown: () => watchdog.isDisconnected() && !gate.isHoldingStall(),
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    let tick = 100;
    /** `ms` of a playing host: a packet every 16 ms. */
    const stream = (ms: number): void => {
      for (let t = 0; t < ms; t += 16) {
        clock.advance(16);
        watchdog.onPacket();
        gate.onPacket(tick++, false);
      }
    };
    return { emitted, clock, machine, gate, stream, setPlaying: (p: boolean) => (playing = p) };
  }

  it('a_save_while_playing_drains_writes_in_silence_and_plays_on_without_disconnected', () => {
    const { emitted, clock, machine, gate, stream } = playingPage();
    stream(500);
    // The Save is sent (App: `saveRequested`, and the gate begins because the board plays).
    machine.apply('saveRequested');
    gate.begin('save');
    // The drain, a packet a tick, up to just before `Save requested` fades.
    stream(AUTOCLEAR_MS - 1_500);
    // The write: no packet for 2 s, across the fade at 4 s.
    clock.advance(2_000);
    // The host plays on.
    stream(2_000);
    expect(emitted, `never Disconnected: ${JSON.stringify(emitted)}`).not.toContain('disconnected');
    expect(emitted).toEqual(['saveRequested', 'idle']);
  });

  it('a_save_to_a_host_that_dies_is_still_named_disconnected', () => {
    const { emitted, clock, machine, gate, stream } = playingPage();
    stream(500);
    machine.apply('saveRequested');
    gate.begin('save');
    clock.advance(LOAD_TIMEOUT_MS + 1_000);
    expect(emitted.at(-1)).toBe('disconnected');
  });
});
