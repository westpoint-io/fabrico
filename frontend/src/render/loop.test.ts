import { describe, expect, it } from 'vitest';
import type { Application } from 'pixi.js';
import { startRenderLoop, SIM_TICK_MS } from './loop.ts';
import { quantizedFrame, SIM_TICKS_PER_FRAME } from './interp.ts';
import type { SceneState } from './sceneState.ts';
import type { MachineLayer } from './layers/machines.ts';
import type { BeltLayer } from './layers/belts.ts';
import type { ItemLayer } from './layers/items.ts';
import type { WireLayer } from './layers/wires.ts';

// The MOTION-04 pinned-clock hook (Pattern 3). This suite is Pixi-free: it drives
// startRenderLoop through a fake Application whose ticker exposes a single captured
// callback we invoke by hand (mirrors the frameProbe.test.ts "don't touch Pixi"
// discipline). Everything asserted here is at the frame-INDEX level - no pixels,
// no style coupling - so nothing produced by this test is a Phase 28 quarantine
// candidate. It proves the ONE deterministic probe spine every downstream frame
// probe (belt march, fault blink, working sweep) rides on.

/** A fake Pixi Application whose ticker hands us the loop's tick callback. */
function makeFakeApp() {
  let tickFn: (() => void) | null = null;
  const ticker = {
    deltaMS: SIM_TICK_MS, // one sim tick advanced per invoked frame
    add: (fn: () => void): void => {
      tickFn = fn;
    },
    remove: (fn: () => void): void => {
      if (tickFn === fn) tickFn = null;
    },
  };
  return {
    app: { ticker } as unknown as Application,
    /** Invoke the loop's per-frame tick once. */
    frame: (): void => tickFn?.(),
    setDelta: (ms: number): void => {
      ticker.deltaMS = ms;
    },
  };
}

/** Spy layer set: captures the frame/clock each draw consumer receives. */
function makeSpies() {
  const machineFrames: number[] = [];
  const beltFrames: number[] = [];
  const beltClocks: Array<number | undefined> = [];
  const itemClocks: number[] = [];
  const wireClocks: number[] = [];
  // Plan 75-06: the wire layer's THIRD argument, the re-route mark's clock.
  const wireMarkClocks: number[] = [];
  const overlayTimes: number[] = [];
  // SAFE-02 (D-25): the overlay's SECOND argument, the motion flag. It is captured
  // in a parallel array so a test can assert the flag independently of the fed
  // nowMs — the two used to be conflated in one frozen number, which is the shape
  // of the bug this phase removes.
  const overlayFlags: Array<boolean | undefined> = [];
  const machines = {
    layer: {} as MachineLayer['layer'],
    draw: (_s: SceneState, frame: number): void => {
      machineFrames.push(frame);
    },
  } as MachineLayer;
  // Phase 53: the belt layer receives BOTH the quantized frame and the RAW clock.
  // Capture both so the loop's third argument is asserted, not assumed.
  const belts = {
    layer: {} as BeltLayer['layer'],
    draw: (_s: SceneState, frame: number, clock?: number): void => {
      beltFrames.push(frame);
      beltClocks.push(clock);
    },
    setPainter: (): void => {},
    // 74-09's paint probe. The loop never calls it - it is a read-only plot probe the
    // App delegates - so the stand-in answers the same 0 an unknown belt id answers.
    endInstructionsOn: (): number => 0,
    // The review's collar probe (CR-C-01), likewise never called by the loop.
    collarCentresOn: (): Array<{ x: number; y: number }> => [],
    // 74.1-20's drawn-tiles read, likewise never called by the loop.
    drawnTilesOf: (): null => null,
    // 89-03's tread rotation read, likewise never called by the loop.
    treadRotationAt: (): null => null,
  } as BeltLayer;
  const items = {
    layer: {} as ItemLayer['layer'],
    draw: (_s: SceneState, clock: number): void => {
      itemClocks.push(clock);
    },
  } as ItemLayer;
  // WUI-01: the wire layer reads the SAME effectiveClock the item layer does, so a
  // pin/freeze covers it for free. Capture the clock it receives to assert that.
  // Two Containers since the plan-66-05 split (`cables` + `terminals`, no `layer`).
  // The loop never touches either: it only calls `draw`, which is why this stub is a
  // pair of empty objects rather than a fake scene graph.
  const wires = {
    cables: {} as WireLayer['cables'],
    terminals: {} as WireLayer['terminals'],
    draw: (_s: SceneState, clock: number, markClock: number): void => {
      wireClocks.push(clock);
      wireMarkClocks.push(markClock);
    },
    // 75-06's plot read. The loop never calls it.
    rerouteMarkStrokes: (): number => 0,
  } as WireLayer;
  const overlay = {
    tick: (nowMs: number, motionFrozen?: boolean): void => {
      overlayTimes.push(nowMs);
      overlayFlags.push(motionFrozen);
    },
  };
  return {
    machines,
    belts,
    items,
    wires,
    overlay,
    machineFrames,
    beltFrames,
    beltClocks,
    itemClocks,
    wireClocks,
    wireMarkClocks,
    overlayTimes,
    overlayFlags,
  };
}

/** A minimal live scene buffer - the loop only reads `.tick`. */
function sceneAt(tick: number): () => SceneState {
  const scene = { tick } as unknown as SceneState;
  return () => scene;
}

describe('startRenderLoop - MOTION-04 pinned clock hook (production-inert)', () => {
  it('pinClock(n) makes frame() a deterministic function of the pinned clock', () => {
    const fake = makeFakeApp();
    const s = makeSpies();
    const loop = startRenderLoop(fake.app, sceneAt(0), s.machines, s.belts, s.items, s.wires, s.overlay);

    // frame = quantizedFrame(pinned): advances one per SIM_TICKS_PER_FRAME (6),
    // wraps modulo FRAMES (24).
    loop.pinClock(0);
    expect(loop.frame()).toBe(0);
    loop.pinClock(SIM_TICKS_PER_FRAME); // 6
    expect(loop.frame()).toBe(1);
    loop.pinClock(23 * SIM_TICKS_PER_FRAME); // 138 -> frame 23 (last before wrap)
    expect(loop.frame()).toBe(23);
    loop.pinClock(144); // 24 * 6 -> wraps back to 0
    expect(loop.frame()).toBe(0);

    loop.stop();
  });

  it('pinClock(null) restores the live clock-derived frame', () => {
    const fake = makeFakeApp();
    const s = makeSpies();
    // Seed from a running sim: scene.tick=13 -> clock seeds to 13 - LAG_TICKS(1) = 12.
    const loop = startRenderLoop(fake.app, sceneAt(13), s.machines, s.belts, s.items, s.wires, s.overlay);
    fake.frame(); // seed the clock

    const liveFrame = quantizedFrame(12); // floor(12/6) % 24 === 2
    expect(loop.frame()).toBe(liveFrame);

    loop.pinClock(SIM_TICKS_PER_FRAME); // override to frame 1
    expect(loop.frame()).toBe(1);
    expect(loop.frame()).not.toBe(liveFrame);

    loop.pinClock(null); // release -> back to the live clock-derived frame
    expect(loop.frame()).toBe(liveFrame);

    loop.stop();
  });

  it('pinClock never changes renderClock() - the raw loop clock is untouched', () => {
    const fake = makeFakeApp();
    const s = makeSpies();
    const loop = startRenderLoop(fake.app, sceneAt(13), s.machines, s.belts, s.items, s.wires, s.overlay);
    fake.frame(); // seed clock to 12

    expect(loop.renderClock()).toBe(12);
    loop.pinClock(600); // pin far away
    expect(loop.renderClock()).toBe(12); // raw clock semantics unchanged
    expect(loop.frame()).toBe(quantizedFrame(600)); // only the frame readout follows the pin
    loop.pinClock(null);
    expect(loop.renderClock()).toBe(12);

    loop.stop();
  });

  it('when pinned, effectiveClock feeds machines(frame) and items(raw) but NOT the overlay', () => {
    const fake = makeFakeApp();
    const s = makeSpies();
    const loop = startRenderLoop(fake.app, sceneAt(13), s.machines, s.belts, s.items, s.wires, s.overlay);

    const pinned = 6; // frame 1
    loop.pinClock(pinned);
    const before = performance.now();
    fake.frame();
    const after = performance.now();

    // machines receive the quantized frame of the pinned clock...
    expect(s.machineFrames.at(-1)).toBe(quantizedFrame(pinned)); // 1
    // ...items receive the RAW effectiveClock (the pinned value verbatim)...
    expect(s.itemClocks.at(-1)).toBe(pinned);
    // ...the wire layer (WUI-01) rides the SAME effectiveClock as items, so a pin
    // freezes its request/reply pulse for free (no new freeze gate)...
    expect(s.wireClocks.at(-1)).toBe(pinned);
    expect(s.wireClocks.at(-1)).toBe(s.itemClocks.at(-1));
    // ...the belt layer (Phase 53) receives BOTH: the quantized frame the shipped
    // quantum-6 painter actually uses, AND the raw effectiveClock a sub-6-quantum
    // painter needs. Passing the third argument is byte-neutral for the default.
    expect(s.beltFrames.at(-1)).toBe(quantizedFrame(pinned));
    expect(s.beltClocks.at(-1)).toBe(pinned);
    // ...while the re-route mark (plan 75-06, CABLE-07) rides the UNPINNED render clock:
    // reduced motion pins `effectiveClock`, and a mark on the pin would never expire.
    expect(s.wireMarkClocks.at(-1)).toBe(loop.renderClock());
    expect(s.wireMarkClocks.at(-1)).not.toBe(pinned);
    // ...but the overlay pulse rides the WALL clock (performance.now()), never the
    // pinned sim clock - the one deliberate exception (alert ring keeps pulsing).
    const overlayNow = s.overlayTimes.at(-1)!;
    expect(overlayNow).not.toBe(pinned);
    expect(overlayNow).toBeGreaterThanOrEqual(before);
    expect(overlayNow).toBeLessThanOrEqual(after);

    loop.stop();
  });

  it('unpinned (production default) draws exactly as before - machines get quantizedFrame(clock), items get raw clock', () => {
    const fake = makeFakeApp();
    const s = makeSpies();
    const loop = startRenderLoop(fake.app, sceneAt(13), s.machines, s.belts, s.items, s.wires, s.overlay);
    fake.frame(); // seed to clock=12, and this frame draws once

    expect(loop.renderClock()).toBe(12);
    expect(s.machineFrames.at(-1)).toBe(quantizedFrame(12)); // 2
    expect(s.itemClocks.at(-1)).toBe(12); // raw clock, unchanged production behavior

    loop.stop();
  });
});

describe('startRenderLoop - SAFE-02 second reduced-motion gate (pinOverlay)', () => {
  it('pinOverlay(true) freezes the overlay PULSE, never the clock: the fed nowMs keeps advancing', () => {
    // THE REGRESSION TEST FOR THE SHIPPED BUG (D-25). This test previously asserted
    // the opposite - that the fed nowMs stopped advancing - and passing it is what
    // certified the defect. Holding the timestamp made the overlay's 180ms reject
    // flash decay over zero elapsed time (a permanent red box on the canvas) and
    // drove the 5000ms alert TTL negative against App.tsx's live-stamped birth, so
    // neither ever expired. The pin is now a FLAG: the clock runs, the pulse stops.
    const fake = makeFakeApp();
    const s = makeSpies();
    const loop = startRenderLoop(fake.app, sceneAt(0), s.machines, s.belts, s.items, s.wires, s.overlay);

    // Unpinned: successive frames feed the LIVE (advancing) wall clock, flag false.
    fake.frame();
    const liveA = s.overlayTimes.at(-1)!;
    expect(s.overlayFlags.at(-1)).toBe(false);
    // Busy-spin a hair so performance.now() advances between the two live frames.
    const spinUntil = performance.now() + 1;
    while (performance.now() < spinUntil) {
      /* advance the wall clock */
    }
    fake.frame();
    const liveB = s.overlayTimes.at(-1)!;
    expect(liveB).toBeGreaterThan(liveA);

    // Pinned: the flag flips true and the fed clock KEEPS ADVANCING, so every
    // elapsed / TTL / decay computation inside the overlay still runs.
    loop.pinOverlay(true);
    fake.frame();
    const pinnedA = s.overlayTimes.at(-1)!;
    expect(s.overlayFlags.at(-1)).toBe(true);
    const spinAgain = performance.now() + 1;
    while (performance.now() < spinAgain) {
      /* advance the wall clock again */
    }
    fake.frame();
    expect(s.overlayTimes.at(-1)!).toBeGreaterThan(pinnedA);
    expect(s.overlayFlags.at(-1)).toBe(true);

    loop.stop();
  });

  it('pinOverlay(false) flips the motion flag back to false (the clock was never frozen)', () => {
    // A before/after CLOCK comparison would mean nothing now - the clock advances in
    // both states - so the release is asserted on the flag, which is what moved.
    const fake = makeFakeApp();
    const s = makeSpies();
    const loop = startRenderLoop(fake.app, sceneAt(0), s.machines, s.belts, s.items, s.wires, s.overlay);

    loop.pinOverlay(true);
    fake.frame();
    expect(s.overlayFlags.at(-1)).toBe(true);
    const whilePinned = s.overlayTimes.at(-1)!;

    loop.pinOverlay(false); // release -> the pulse animates again
    const before = performance.now();
    fake.frame();
    const after = performance.now();
    expect(s.overlayFlags.at(-1)).toBe(false);
    // ...and the clock is the live wall clock in this state too, as it was in the
    // pinned one: it is bounded by the real time either side of the frame, and it
    // has not gone backwards from the pinned frame.
    const live = s.overlayTimes.at(-1)!;
    expect(live).toBeGreaterThanOrEqual(before);
    expect(live).toBeLessThanOrEqual(after);
    expect(live).toBeGreaterThanOrEqual(whilePinned);

    loop.stop();
  });

  it('pinOverlay touches ONLY the overlay motion flag - never the clock, frame, or the draws', () => {
    const fake = makeFakeApp();
    const s = makeSpies();
    const loop = startRenderLoop(fake.app, sceneAt(13), s.machines, s.belts, s.items, s.wires, s.overlay);
    fake.frame(); // seed to clock=12

    const rawClock = loop.renderClock();
    const rawFrame = loop.frame();
    loop.pinOverlay(true);
    fake.frame();

    // The gate fired...
    expect(s.overlayFlags.at(-1)).toBe(true);
    // ...the clock/frame readouts are untouched by the overlay gate...
    expect(loop.renderClock()).toBe(rawClock);
    expect(loop.frame()).toBe(rawFrame);
    // ...and the machines/items still ride the (unpinned) effective clock exactly.
    expect(s.machineFrames.at(-1)).toBe(quantizedFrame(loop.renderClock()));
    expect(s.itemClocks.at(-1)).toBe(loop.renderClock());

    loop.stop();
  });

  it('pinClock and pinOverlay are INDEPENDENT gates - each can fire without the other', () => {
    const fake = makeFakeApp();
    const s = makeSpies();
    const loop = startRenderLoop(fake.app, sceneAt(0), s.machines, s.belts, s.items, s.wires, s.overlay);

    // Gate 1 only: pin the render clock, leave the overlay live -> ring keeps moving.
    loop.pinClock(6); // frame 1
    fake.frame();
    const overlayLive1 = s.overlayTimes.at(-1)!;
    const spin = performance.now() + 1;
    while (performance.now() < spin) {
      /* advance wall clock */
    }
    fake.frame();
    expect(s.machineFrames.at(-1)).toBe(1); // gate 1 held the frame...
    expect(s.overlayTimes.at(-1)).toBeGreaterThan(overlayLive1); // ...overlay still live
    expect(s.overlayFlags.at(-1)).toBe(false); // ...and its pulse gate is still open

    // Now add gate 2: BOTH gates fired (the prefers-reduced-motion state). The
    // observable for gate 2 is the FLAG, not a stalled overlay timestamp - the
    // overlay clock advances in every state, which is what lets its TTLs expire.
    loop.pinOverlay(true);
    fake.frame();
    const withBoth = s.overlayTimes.at(-1)!;
    const spin2 = performance.now() + 1;
    while (performance.now() < spin2) {
      /* advance wall clock */
    }
    fake.frame();
    expect(s.machineFrames.at(-1)).toBe(1); // gate 1: machine frame still pinned
    expect(s.overlayFlags.at(-1)).toBe(true); // gate 2: overlay pulse quieted
    expect(s.overlayTimes.at(-1)!).toBeGreaterThan(withBoth); // ...clock still runs

    loop.stop();
  });
});
