// statusWatchdog.test.ts - the SAFE-01 playing-gated stall watchdog (T-34-DISCONNECT-FALSE).
//
// Drives makeStatusWatchdog with a FAKE timer seam so the stall races are
// deterministic (no wall-clock wait), mirroring statusMachine.test.ts. The
// load-bearing case is the KEYSTONE: a PAUSED sim emits zero packets by design
// (render_packet.rs on_tick only sends while playing), so arming while paused
// must NEVER fire 'disconnected' - otherwise the readout falsely reports
// "Disconnected" on every Pause. That invariant is proven here without a DOM.

import { describe, expect, it } from 'vitest';
import { makeHostWorkGate, makeStatusWatchdog, type StatusWatchdog } from './statusWatchdog.ts';

const THRESHOLD_MS = 800;

/**
 * A controllable fake timer: records armed callbacks with their delay and a live
 * flag; `advance(ms)` fires exactly those whose deadline elapsed (in arm order).
 * Cancelled timers never fire. Same shape as statusMachine.test.ts's clock.
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

function harness(playing: boolean) {
  let isPlaying = playing;
  const events: string[] = [];
  const clock = fakeClock();
  const watchdog: StatusWatchdog = makeStatusWatchdog({
    isPlaying: () => isPlaying,
    onDisconnect: () => events.push('disconnect'),
    onReconnect: () => events.push('reconnect'),
    thresholdMs: THRESHOLD_MS,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return {
    events,
    clock,
    watchdog,
    setPlaying: (p: boolean) => {
      isPlaying = p;
    },
  };
}

describe('statusWatchdog - SAFE-01 playing-gated stall detection', () => {
  it('the first packet arms and letting the timer expire fires onDisconnect exactly once', () => {
    const { events, clock, watchdog } = harness(true);
    // WR-01: the first packet marks the stream started AND arms the stall timer.
    watchdog.onPacket();
    expect(clock.liveCount()).toBe(1);
    clock.advance(THRESHOLD_MS);
    expect(events).toEqual(['disconnect']);
    // Fires exactly once per stall: no fresh timer was armed by the fire.
    clock.advance(THRESHOLD_MS * 10);
    expect(events).toEqual(['disconnect']);
    expect(watchdog.isDisconnected()).toBe(true);
  });

  // WR-01 (the cold-boot cousin of T-34-DISCONNECT-FALSE): the sim boots playing,
  // so the App arms the watchdog at mount BEFORE any packet - before the transport
  // even exists. arm() must no-op until the first packet, or a cold boot slower
  // than the threshold flashes a false "Disconnected" before a frame ever arrives.
  it('arm() before the first packet never arms and never fires onDisconnect', () => {
    const { events, clock, watchdog } = harness(true);
    watchdog.arm(); // playing, but no packet has been delivered yet
    expect(clock.liveCount()).toBe(0);
    clock.advance(THRESHOLD_MS * 100);
    expect(events).toEqual([]);
    expect(watchdog.isDisconnected()).toBe(false);
    // The first packet is what actually starts + arms the watchdog.
    watchdog.onPacket();
    expect(clock.liveCount()).toBe(1);
    clock.advance(THRESHOLD_MS);
    expect(events).toEqual(['disconnect']);
  });

  // THE KEYSTONE (T-34-DISCONNECT-FALSE): a paused sim legitimately emits zero
  // packets, so arming while paused must never arm a timer nor fire disconnect.
  it('arming while PAUSED never arms a timer and never fires onDisconnect', () => {
    const { events, clock, watchdog } = harness(false);
    // WR-01: even after the stream has started (a prior packet), a paused sim's
    // silence is expected - arm() must still no-op while paused (the KEYSTONE).
    watchdog.onPacket();
    watchdog.arm();
    expect(clock.liveCount()).toBe(0);
    clock.advance(THRESHOLD_MS * 100);
    expect(events).toEqual([]);
    expect(watchdog.isDisconnected()).toBe(false);
  });

  it('a packet arriving BEFORE expiry resets the timer (no onDisconnect)', () => {
    const { events, clock, watchdog } = harness(true);
    watchdog.onPacket(); // WR-01: the first packet starts the stream + arms
    // Keep feeding packets just under the threshold - the stall never completes.
    for (let i = 0; i < 5; i += 1) {
      clock.advance(THRESHOLD_MS - 100);
      watchdog.onPacket();
    }
    expect(events).toEqual([]);
    expect(watchdog.isDisconnected()).toBe(false);
    // Exactly one live timer at all times (the reset one).
    expect(clock.liveCount()).toBe(1);
  });

  it('a packet arriving AFTER a disconnect signals reconnect, then re-arms', () => {
    const { events, clock, watchdog } = harness(true);
    watchdog.onPacket(); // WR-01: the first packet starts the stream + arms
    clock.advance(THRESHOLD_MS);
    expect(events).toEqual(['disconnect']);
    // The reconnecting packet clears the latch and re-arms while still playing.
    watchdog.onPacket();
    expect(events).toEqual(['disconnect', 'reconnect']);
    expect(watchdog.isDisconnected()).toBe(false);
    // A second stall can fire again (proves the cycle re-arms).
    clock.advance(THRESHOLD_MS);
    expect(events).toEqual(['disconnect', 'reconnect', 'disconnect']);
  });

  it('pausing (clear) disarms a pending timer so it never fires while paused', () => {
    const { events, clock, watchdog, setPlaying } = harness(true);
    watchdog.onPacket(); // WR-01: the first packet starts the stream + arms
    expect(clock.liveCount()).toBe(1);
    // User hits Pause: the App disarms and flips isPlaying false.
    watchdog.clear();
    setPlaying(false);
    clock.advance(THRESHOLD_MS * 100);
    expect(events).toEqual([]);
    expect(clock.liveCount()).toBe(0);
  });

  it('onPacket does NOT re-arm while paused (the gate holds through the packet path)', () => {
    const { events, clock, watchdog } = harness(false);
    // A stray packet while paused must not arm the stall timer.
    watchdog.onPacket();
    expect(clock.liveCount()).toBe(0);
    clock.advance(THRESHOLD_MS * 100);
    expect(events).toEqual([]);
  });

  // IN-01 (defense-in-depth): if a pause lands AFTER the timer was armed but BEFORE
  // it fires and the App's clear() is somehow missed/raced, the fired callback must
  // still re-check the gate and NOT emit a false 'disconnected'.
  it('a pause between arm and fire suppresses onDisconnect even without a clear()', () => {
    const { events, clock, watchdog, setPlaying } = harness(true);
    watchdog.onPacket(); // start + arm while playing
    expect(clock.liveCount()).toBe(1);
    // Pause WITHOUT calling clear() (simulating a missed/raced disarm).
    setPlaying(false);
    clock.advance(THRESHOLD_MS);
    expect(events).toEqual([]);
    expect(watchdog.isDisconnected()).toBe(false);
  });

  it('dispose cancels the pending timer (no leak across StrictMode double-boot)', () => {
    const { events, clock, watchdog } = harness(true);
    watchdog.onPacket(); // WR-01: the first packet starts the stream + arms
    watchdog.dispose();
    clock.advance(THRESHOLD_MS * 10);
    expect(events).toEqual([]);
    expect(clock.liveCount()).toBe(0);
  });
});

// Phase 90 review WR-B-02 (walk todo 2026-10-24): the host sends nothing while it swaps a board or
// writes a file, so on a playing board the watchdog fires during a Load, a Save, a New or an example
// that then succeeds. The gate decides what its stall writes: nothing during a Load (the Load's own
// cut-off names a dead host), a deferred check during a Save, New or example (the host is still
// named down if it stays silent past the window), the write at once otherwise.
describe('makeHostWorkGate - the stall during a request the host is working on (WR-B-02)', () => {
  const WINDOW_MS = 10_000;
  const BUDGET = 1024;

  function gateHarness() {
    const clock = fakeClock();
    const writes: string[] = [];
    let down = false;
    let loading = false;
    let stopped = false;
    const gate = makeHostWorkGate({
      isStreamDown: () => down,
      isLoadInFlight: () => loading,
      isStopped: () => stopped,
      writeDisconnected: () => writes.push('disconnected'),
      windowMs: WINDOW_MS,
      tickBudget: BUDGET,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    return {
      clock,
      writes,
      gate,
      setDown: (v: boolean) => (down = v),
      setLoading: (v: boolean) => (loading = v),
      setStopped: (v: boolean) => (stopped = v),
    };
  }

  it('a_stall_with_no_request_in_flight_is_written_at_once', () => {
    const { gate, writes, setDown } = gateHarness();
    setDown(true);
    gate.onStall();
    expect(writes).toEqual(['disconnected']);
  });

  it('a_stall_during_a_load_is_left_to_the_loads_own_cut_off', () => {
    const { gate, writes, clock, setDown, setLoading } = gateHarness();
    setLoading(true);
    setDown(true);
    gate.onStall();
    clock.advance(WINDOW_MS * 2);
    expect(writes, 'nothing: the status machine writes Load failed, then re-asserts Disconnected').toEqual([]);
  });

  it('a_stall_during_a_save_that_then_speaks_writes_nothing', () => {
    const { gate, writes, clock, setDown } = gateHarness();
    gate.begin('save');
    gate.onPacket(100, false);
    setDown(true);
    gate.onStall();
    clock.advance(1_500);
    setDown(false);
    gate.onReconnect();
    clock.advance(WINDOW_MS);
    expect(writes).toEqual([]);
    expect(gate.isWorking(), 'the quiet work is over once the host speaks again').toBe(false);
  });

  it('a_stall_during_a_save_the_host_never_answers_is_written_after_the_window', () => {
    const { gate, writes, clock, setDown } = gateHarness();
    gate.begin('save');
    setDown(true);
    gate.onStall();
    clock.advance(WINDOW_MS - 1);
    expect(writes).toEqual([]);
    clock.advance(1);
    expect(writes).toEqual(['disconnected']);
  });

  it('a_request_is_over_after_the_tick_budget_so_a_later_stall_is_written_at_once', () => {
    const { gate, writes, setDown } = gateHarness();
    gate.begin('save');
    gate.onPacket(10, false);
    gate.onPacket(10 + BUDGET, false);
    expect(gate.isWorking()).toBe(true);
    gate.onPacket(11 + BUDGET, false);
    expect(gate.isWorking()).toBe(false);
    setDown(true);
    gate.onStall();
    expect(writes).toEqual(['disconnected']);
  });

  it('a_stopped_page_writes_nothing_now_or_later', () => {
    const { gate, writes, clock, setDown, setStopped } = gateHarness();
    gate.begin('save');
    setDown(true);
    gate.onStall();
    setStopped(true);
    clock.advance(WINDOW_MS);
    gate.onStall();
    expect(writes).toEqual([]);
  });

  it('a_deferred_stall_is_held_until_its_window_closes', () => {
    const { gate, clock, setDown } = gateHarness();
    gate.begin('save');
    setDown(true);
    expect(gate.isHoldingStall()).toBe(false);
    gate.onStall();
    expect(gate.isHoldingStall(), 'the status machine must not re-assert Disconnected meanwhile').toBe(true);
    clock.advance(WINDOW_MS);
    expect(gate.isHoldingStall()).toBe(false);
  });

  it('a_swaps_work_ends_on_its_restructure_keyframe_so_a_later_stall_is_written_at_once', () => {
    const { gate, writes, setDown } = gateHarness();
    gate.begin('swap');
    gate.onPacket(10, false);
    expect(gate.isWorking(), 'the drain before the swap is still the request').toBe(true);
    gate.onPacket(1, true);
    expect(gate.isWorking(), 'the swap keyframe ends it').toBe(false);
    setDown(true);
    gate.onStall();
    expect(writes).toEqual(['disconnected']);
  });

  it('a_saves_work_does_not_end_on_a_keyframe', () => {
    const { gate } = gateHarness();
    gate.begin('save');
    gate.onPacket(10, true);
    expect(gate.isWorking(), 'a Save swaps nothing: a keyframe (an Undo, a resync) is not its end').toBe(true);
  });

  it('end_cancels_a_deferred_check', () => {
    const { gate, writes, clock, setDown } = gateHarness();
    gate.begin('save');
    setDown(true);
    gate.onStall();
    gate.end();
    clock.advance(WINDOW_MS);
    expect(writes).toEqual([]);
    expect(clock.liveCount()).toBe(0);
  });
});
