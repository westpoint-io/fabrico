import { describe, expect, it } from 'vitest';
import { FRAME_SAMPLE_CAP, createRollingWindow } from './frameProbe.ts';

// The frame-time probe's averaging is a PURE bounded rolling window over frame
// deltas (ms). It is unit-tested here WITHOUT Pixi (the ticker wiring in
// createFrameProbe is the only Pixi-touching part and is not exercised here):
// the v3.0 frame-time baseline number this feeds (Phase 28 GATE-05) is only
// trustworthy if the mean-of-last-N math is exact and the window is bounded.

describe('createRollingWindow - bounded frame-time average', () => {
  it('avg() over an empty window returns 0', () => {
    const w = createRollingWindow();
    expect(w.samples()).toBe(0);
    expect(w.avg()).toBe(0);
  });

  it('avg() equals the arithmetic mean of the fed samples', () => {
    const w = createRollingWindow();
    for (const s of [10, 20, 30]) w.push(s);
    expect(w.samples()).toBe(3);
    expect(w.avg()).toBeCloseTo(20, 10); // (10 + 20 + 30) / 3
  });

  it('avg() is a pure read - calling it does not mutate the window', () => {
    const w = createRollingWindow();
    for (const s of [4, 8, 12]) w.push(s);
    const first = w.avg();
    const second = w.avg();
    expect(second).toBe(first);
    expect(w.samples()).toBe(3);
  });

  it('the window is bounded - oldest samples drop past the cap', () => {
    const cap = 4;
    const w = createRollingWindow(cap);
    // Feed 2*cap ascending samples; only the LAST `cap` survive.
    for (let i = 1; i <= cap * 2; i++) w.push(i);
    expect(w.samples()).toBe(cap); // never grows past the cap
    // Surviving samples are the last four: 5, 6, 7, 8 -> mean 6.5.
    expect(w.avg()).toBeCloseTo((5 + 6 + 7 + 8) / cap, 10);
  });

  it('avg() over a full window at the default cap equals the mean of the last N', () => {
    const w = createRollingWindow();
    // Push cap constant 16ms frames, then cap more constant 8ms frames: the
    // window holds only the last cap (all 8ms) -> mean 8.
    for (let i = 0; i < FRAME_SAMPLE_CAP; i++) w.push(16);
    for (let i = 0; i < FRAME_SAMPLE_CAP; i++) w.push(8);
    expect(w.samples()).toBe(FRAME_SAMPLE_CAP);
    expect(w.avg()).toBeCloseTo(8, 10);
  });
});
