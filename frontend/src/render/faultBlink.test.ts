import { describe, expect, it } from 'vitest';
import { FRAMES, faultBlinkAlpha, phaseOffset } from './faultBlink.ts';

// MOTION-03 fault-blink contract (docs/style-bible.md section 4). These unit
// invariants ARE the authored fault cadence the bible placeholder points to:
// asymmetric alarm envelope (fast attack, slow release, hold at floor), capped
// peak, non-zero floor, and a deterministic per-node phase desync keyed on the
// STABLE origin cell (never node.id - it re-mints on keyframes, Pitfall 2).

describe('faultBlinkAlpha - asymmetric alarm envelope (MOTION-03)', () => {
  const cycle = Array.from({ length: FRAMES }, (_, f) => faultBlinkAlpha(f));

  it('bounds the master loop at FRAMES = 24 (the quantizedFrame loop)', () => {
    expect(FRAMES).toBe(24);
  });

  it('caps the peak at <= 0.8 and never reaches full 1.0', () => {
    const max = Math.max(...cycle);
    expect(max).toBeLessThanOrEqual(0.8);
    expect(max).toBeLessThan(1.0);
  });

  it('holds a non-zero floor (> 0, approx 0.25) and never goes fully off', () => {
    const min = Math.min(...cycle);
    expect(min).toBeGreaterThan(0);
    expect(min).toBeGreaterThanOrEqual(0.2);
    expect(min).toBeLessThanOrEqual(0.3);
  });

  it('is ASYMMETRIC: attack duration < release duration (alarm, not a sine breathe)', () => {
    // Peak frame = argmax; attack span = frames from cycle start up to the peak.
    let peakFrame = 0;
    for (let f = 1; f < FRAMES; f++) {
      if (cycle[f] > cycle[peakFrame]) peakFrame = f;
    }
    const attackFrames = peakFrame; // 0 -> peak
    // Release span = frames from the peak until the alpha first returns to floor.
    const floor = Math.min(...cycle);
    let releaseEnd = peakFrame;
    for (let f = peakFrame + 1; f < FRAMES; f++) {
      if (cycle[f] <= floor + 1e-9) {
        releaseEnd = f;
        break;
      }
    }
    const releaseFrames = releaseEnd - peakFrame;
    expect(attackFrames).toBeGreaterThan(0);
    expect(releaseFrames).toBeGreaterThan(0);
    expect(attackFrames).toBeLessThan(releaseFrames);
  });

  it('rises monotonically on the attack, then decays monotonically on the release', () => {
    let peakFrame = 0;
    for (let f = 1; f < FRAMES; f++) {
      if (cycle[f] > cycle[peakFrame]) peakFrame = f;
    }
    for (let f = 1; f <= peakFrame; f++) {
      expect(cycle[f]).toBeGreaterThanOrEqual(cycle[f - 1]);
    }
    // Decay from the peak down to (and holding at) the floor - never increases.
    for (let f = peakFrame + 1; f < FRAMES; f++) {
      expect(cycle[f]).toBeLessThanOrEqual(cycle[f - 1] + 1e-9);
    }
  });

  it('is a PURE function of localFrame (same input -> same output)', () => {
    for (let f = 0; f < FRAMES; f++) {
      expect(faultBlinkAlpha(f)).toBe(faultBlinkAlpha(f));
    }
  });

  it('Euclidean-wraps negative and out-of-range frames (never throws)', () => {
    expect(faultBlinkAlpha(-1)).toBe(faultBlinkAlpha(FRAMES - 1));
    expect(faultBlinkAlpha(-24)).toBe(faultBlinkAlpha(0));
    expect(faultBlinkAlpha(-25)).toBe(faultBlinkAlpha(FRAMES - 1));
    expect(faultBlinkAlpha(25)).toBe(faultBlinkAlpha(1));
    expect(faultBlinkAlpha(48)).toBe(faultBlinkAlpha(0));
    // Fractional inputs floor into a valid frame rather than throwing.
    expect(Number.isFinite(faultBlinkAlpha(3.7))).toBe(true);
  });
});

describe('phaseOffset - deterministic origin-cell desync (MOTION-03, Pitfall 2)', () => {
  it('is deterministic: the same cell hashes to the same offset every call', () => {
    expect(phaseOffset(5, 7)).toBe(phaseOffset(5, 7));
    expect(phaseOffset(0, 0)).toBe(phaseOffset(0, 0));
    expect(phaseOffset(-3, 12)).toBe(phaseOffset(-3, 12));
  });

  it('returns an integer in [0, FRAMES)', () => {
    for (let x = -2; x < 20; x++) {
      for (let y = -2; y < 20; y++) {
        const o = phaseOffset(x, y);
        expect(Number.isInteger(o)).toBe(true);
        expect(o).toBeGreaterThanOrEqual(0);
        expect(o).toBeLessThan(FRAMES);
      }
    }
  });

  it('desyncs adjacent cells (never a grid-synchronized blink)', () => {
    // Representative adjacent pairs (horizontal + vertical neighbours) must differ,
    // so a grid full of faults never reads as one synchronized pulse.
    const pairs: Array<[number, number, number, number]> = [
      [5, 7, 6, 7],
      [5, 7, 5, 8],
      [10, 3, 11, 3],
      [10, 3, 10, 4],
      [0, 0, 1, 0],
      [0, 0, 0, 1],
    ];
    for (const [x0, y0, x1, y1] of pairs) {
      expect(phaseOffset(x0, y0)).not.toBe(phaseOffset(x1, y1));
    }
  });

  it('spreads offsets across the cycle (a small grid is not clustered on one phase)', () => {
    const seen = new Set<number>();
    for (let x = 0; x < 8; x++) {
      for (let y = 0; y < 8; y++) {
        seen.add(phaseOffset(x, y));
      }
    }
    // 64 cells over 24 phases: expect broad coverage, not a single collapsed phase.
    expect(seen.size).toBeGreaterThan(12);
  });
});
