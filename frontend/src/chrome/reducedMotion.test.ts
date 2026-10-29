// reducedMotion.test.ts — the SAFE-02 pure reduced-motion mapping (two gates).
//
// A DOM-free, React-free vitest suite (mirrors statusMachine.test.ts discipline):
// it proves the pure `matches -> pins` decision and the load-bearing frame choice
// against faultBlink.ts, so the App effect stays a thin caller of a proven mapping.

import { describe, expect, it } from 'vitest';
import { REDUCED_MOTION_FRAME, reducedMotionPins } from './reducedMotion.ts';
import { quantizedFrame, SIM_TICKS_PER_FRAME } from '../render/interp.ts';
import { faultBlinkAlpha, phaseOffset, FRAMES } from '../render/faultBlink.ts';

describe('reducedMotionPins - SAFE-02 two-gate mapping', () => {
  it('reduce -> pins the representative frame AND freezes the overlay', () => {
    expect(reducedMotionPins(true)).toEqual({
      frame: REDUCED_MOTION_FRAME,
      overlayFrozen: true,
    });
  });

  it('no-reduce -> releases the render clock (null) AND unfreezes the overlay', () => {
    expect(reducedMotionPins(false)).toEqual({ frame: null, overlayFrozen: false });
  });

  it('both gates move together off the ONE match read (no half-frozen state)', () => {
    const on = reducedMotionPins(true);
    const off = reducedMotionPins(false);
    // gate 1 (frame) and gate 2 (overlayFrozen) are consistent within each branch:
    expect(on.frame).not.toBeNull();
    expect(on.overlayFrozen).toBe(true);
    expect(off.frame).toBeNull();
    expect(off.overlayFrozen).toBe(false);
  });
});

describe('REDUCED_MOTION_FRAME - fault legibility invariants', () => {
  const pinnedFrameIndex = quantizedFrame(REDUCED_MOTION_FRAME);

  it('is the fault-alarm PEAK at zero phase offset (reads clearly ON, not the floor)', () => {
    // The chosen frame lands on the brightest point of the whole 24-frame envelope
    // at zero phase, so a frozen fault shows its most prominent "ON" reading.
    const alphas = Array.from({ length: FRAMES }, (_, f) => faultBlinkAlpha(f));
    const peak = Math.max(...alphas);
    expect(faultBlinkAlpha(pinnedFrameIndex)).toBe(peak);
  });

  it('never lands ANY faulted machine mid-blink-OFF - fault stays visible for every phase', () => {
    // Per-node phase desync means different machines see different localFrames from
    // the same global pinned frame. Assert the fault marker is visible (alpha > 0)
    // at the frozen frame for EVERY possible phase offset - the FLOOR guarantees it,
    // so reduced motion can never HIDE a machine's fault state (only still the pulse).
    for (let off = 0; off < FRAMES; off++) {
      const localFrame = pinnedFrameIndex + off;
      expect(faultBlinkAlpha(localFrame)).toBeGreaterThan(0);
    }
  });

  it('the pinned frame is a whole MOTION-01 frame (clean 6-tick multiple)', () => {
    expect(REDUCED_MOTION_FRAME % SIM_TICKS_PER_FRAME).toBe(0);
    expect(pinnedFrameIndex).toBe(3); // frame index 3 == ATTACK peak
  });

  it('phaseOffset stays within [0, FRAMES) so the invariant sweep above is exhaustive', () => {
    // Guard the assumption the fault-never-off sweep rests on: every real node maps
    // to an offset the loop above covered.
    for (const [x, y] of [
      [0, 0],
      [3, 7],
      [12, 5],
      [-4, 9],
    ] as const) {
      const off = phaseOffset(x, y);
      expect(off).toBeGreaterThanOrEqual(0);
      expect(off).toBeLessThan(FRAMES);
    }
  });
});
