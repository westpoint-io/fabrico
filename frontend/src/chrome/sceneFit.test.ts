import { describe, expect, it } from 'vitest';
import { takeFit } from './sceneFit.ts';

// sceneFit.test.ts (DEMO-07, D-12, plan 85-06) - the take-the-fit rule.
//
// A board load (the demo, an example, or a user's .fab) sets a pending fit; the next
// TIMELINE-RESTRUCTURE keyframe (full, not a lag resync) that carries at least one node
// takes it. Every other packet leaves it pending: a diff never re-fits (a user's first
// placement must not yank the camera, WR-01), a lag resync is the same timeline resent,
// and an empty board has nothing to frame.

const RESTRUCTURE = { full: true, resync: false };

describe('takeFit: the pending fit is taken by the next restructure keyframe with nodes', () => {
  it('takes a pending fit on a full, non-resync keyframe carrying nodes', () => {
    expect(takeFit(true, RESTRUCTURE, 5)).toBe(true);
  });

  it('does not take it on a lag resync (the same timeline, resent)', () => {
    expect(takeFit(true, { full: true, resync: true }, 5)).toBe(false);
  });

  it('does not take it on a diff packet (a user edit never re-fits)', () => {
    expect(takeFit(true, { full: false, resync: false }, 5)).toBe(false);
  });

  it('does not take it on a keyframe of an empty board (nothing to frame)', () => {
    expect(takeFit(true, RESTRUCTURE, 0)).toBe(false);
  });

  it('never fits when no fit is pending (New, or a board already framed)', () => {
    expect(takeFit(false, RESTRUCTURE, 5)).toBe(false);
  });
});
