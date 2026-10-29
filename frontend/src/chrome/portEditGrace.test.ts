import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PORT_EDIT_PENDING_GRACE_MS, createPortEditGrace, type GraceTimers } from './portEditGrace';
import { anyPortEditUnfolded } from './portEditGrace';
import { IDLE_PORT_EDIT, beginPortEdit, portsKeyOf, type PortEditLatch } from './portEditLatch';

// portEditGrace.test.ts (plan 74.1-19, re-walk J10): the pending status waits before it
// speaks. A manual walk saw "Waiting for the host to apply this change." paint for 59 to 173 ms on
// every `+ Add output` press; this controller decides when that line may show, and these
// cases pin the rule with fake timers.

const timers: GraceTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

describe('portEditGrace', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('the grace is 400 ms: above the slowest fold observed (173 ms)', () => {
    expect(PORT_EDIT_PENDING_GRACE_MS).toBe(400);
  });

  it('an edit that folds inside the grace never makes the status visible', () => {
    const seen: boolean[] = [];
    const g = createPortEditGrace(timers, (v) => seen.push(v));
    g.arm(false);
    expect(g.visible(), 'hidden at send').toBe(false);
    vi.advanceTimersByTime(173);
    g.release();
    vi.advanceTimersByTime(2000);
    expect(g.visible()).toBe(false);
    expect(seen, 'no visible frame was ever announced').toEqual([]);
  });

  it('an edit still unfolded at 400 ms makes the status visible, and not a millisecond before', () => {
    const seen: boolean[] = [];
    const g = createPortEditGrace(timers, (v) => seen.push(v));
    g.arm(false);
    vi.advanceTimersByTime(PORT_EDIT_PENDING_GRACE_MS - 1);
    expect(g.visible()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(g.visible()).toBe(true);
    expect(seen).toEqual([true]);
  });

  it('a paused sim makes it visible at once: the edit is held, and saying so is not a flash', () => {
    const seen: boolean[] = [];
    const g = createPortEditGrace(timers, (v) => seen.push(v));
    g.arm(true);
    expect(g.visible()).toBe(true);
    expect(seen).toEqual([true]);
    vi.advanceTimersByTime(1000);
    expect(seen, 'no second announcement').toEqual([true]);
  });

  it('pausing during the grace makes it visible at once and cancels the timer', () => {
    const seen: boolean[] = [];
    const g = createPortEditGrace(timers, (v) => seen.push(v));
    g.arm(false);
    vi.advanceTimersByTime(100);
    g.setPaused(true);
    expect(g.visible()).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(seen).toEqual([true]);
    // Pausing with nothing armed shows nothing.
    const idle = createPortEditGrace(timers, (v) => seen.push(v));
    idle.setPaused(true);
    expect(idle.visible()).toBe(false);
  });

  it('release hides it and cancels the timer', () => {
    const seen: boolean[] = [];
    const g = createPortEditGrace(timers, (v) => seen.push(v));
    g.arm(false);
    vi.advanceTimersByTime(500);
    expect(g.visible()).toBe(true);
    g.release();
    expect(g.visible()).toBe(false);
    expect(seen).toEqual([true, false]);
    // A release mid-grace cancels: the timer never fires after it.
    g.arm(false);
    vi.advanceTimersByTime(200);
    g.release();
    vi.advanceTimersByTime(1000);
    expect(g.visible()).toBe(false);
    expect(seen).toEqual([true, false]);
    expect(vi.getTimerCount(), 'no timer left behind').toBe(0);
  });

  it('re-arming restarts the grace from the new send', () => {
    const g = createPortEditGrace(timers, () => {});
    g.arm(false);
    vi.advanceTimersByTime(300);
    g.release();
    g.arm(false);
    vi.advanceTimersByTime(300);
    expect(g.visible(), '300 ms into the second edit').toBe(false);
    vi.advanceTimersByTime(100);
    expect(g.visible()).toBe(true);
  });

  // Plan 74.1-28 (round-3 review WR-05): RESUME NEVER FLASHES THE WAITING LINE. The paused
  // wording shows at once on a paused add; on Resume the panel switched to "Waiting for
  // the host to apply this change." for the 60 to 170 ms until the fold, the flash the maintainer
  // rejected at J10, reached by the resume path.
  it('Resume hides the line at once, so a fold inside the new grace announces nothing more', () => {
    const seen: boolean[] = [];
    const g = createPortEditGrace(timers, (v) => seen.push(v));
    g.arm(true);
    expect(seen, 'the paused wording shows at once').toEqual([true]);
    g.setPaused(false);
    expect(g.visible(), 'hidden on Resume').toBe(false);
    expect(seen, 'hidden the moment the sim resumes, not at the fold').toEqual([true, false]);
    vi.advanceTimersByTime(170);
    g.release();
    vi.advanceTimersByTime(1000);
    expect(seen, 'only [true, false]: no waiting line between Resume and the fold').toEqual([true, false]);
    expect(vi.getTimerCount(), 'no timer left behind').toBe(0);
  });

  it('Resume restarts the grace: a real stall after Resume still speaks at 400 ms', () => {
    const seen: boolean[] = [];
    const g = createPortEditGrace(timers, (v) => seen.push(v));
    g.arm(true);
    g.setPaused(false);
    vi.advanceTimersByTime(PORT_EDIT_PENDING_GRACE_MS - 1);
    expect(g.visible()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(g.visible(), 'the unfolded edit speaks after the grace').toBe(true);
    expect(seen).toEqual([true, false, true]);
  });

  it('Resume with nothing armed does nothing, and Pause still shows at once', () => {
    const seen: boolean[] = [];
    const g = createPortEditGrace(timers, (v) => seen.push(v));
    g.setPaused(false);
    expect(seen).toEqual([]);
    expect(vi.getTimerCount(), 'no grace started for nothing').toBe(0);
    // Armed but still inside the grace (playing): a Resume edge restarts nothing and
    // shows nothing; the original grace runs on.
    g.arm(false);
    vi.advanceTimersByTime(300);
    g.setPaused(false);
    vi.advanceTimersByTime(100);
    expect(g.visible(), 'the first grace was not restarted').toBe(true);
    expect(seen).toEqual([true]);
    // And pausing a hidden armed edit shows it at once, unchanged.
    const h = createPortEditGrace(timers, (v) => seen.push(v));
    h.arm(false);
    h.setPaused(true);
    expect(h.visible()).toBe(true);
  });
});

// Plan 84-17: THE WAITING LINE AFTER THE HOST APPLIED THE ADD. Measured at the GPU proxy (the live
// suite's model of CI's 4 to 5 frames a second renderer, 84-EVIDENCE.md `### Plan 84-17: the Resume
// leg of the add note, measured and graded (Task 1)`): Resume at 0 ms, the page's scene showed the
// held add applied 24 to 63 ms later, and still "Waiting for the host to apply this change." went
// into the Ports section at 406 to 412 ms. The grace's timer runs on wall time and showed the line
// at 400 ms because the edit was still latched; the latch is released only by the chrome poll,
// which runs on animation frames, and at about 4 frames a second its next run came 448 to 641 ms
// after the click. So the grace now asks, when it runs out, whether the scene still shows the edit
// unapplied, and says nothing if it does not.
describe('portEditGrace, the scene asked when the grace runs out (plan 84-17)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('Resume, the held add applied 56 ms later, the poll not run until 632 ms: no waiting line', () => {
    const seen: boolean[] = [];
    let applied = false;
    const g = createPortEditGrace(timers, (v) => seen.push(v), () => !applied);
    g.arm(true);
    g.setPaused(false);
    vi.advanceTimersByTime(56);
    applied = true;
    vi.advanceTimersByTime(PORT_EDIT_PENDING_GRACE_MS - 56);
    expect(g.visible(), 'the grace ran out after the scene showed the add applied: no line').toBe(false);
    vi.advanceTimersByTime(632 - PORT_EDIT_PENDING_GRACE_MS);
    g.release();
    expect(seen, 'only the paused wording and its clearing on Resume').toEqual([true, false]);
    expect(vi.getTimerCount(), 'no timer left behind').toBe(0);
  });

  it('a real stall still speaks at 400 ms: the scene still shows the add unapplied', () => {
    const seen: boolean[] = [];
    const g = createPortEditGrace(timers, (v) => seen.push(v), () => true);
    g.arm(true);
    g.setPaused(false);
    vi.advanceTimersByTime(PORT_EDIT_PENDING_GRACE_MS - 1);
    expect(g.visible()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(g.visible(), 'the unapplied edit speaks after the grace').toBe(true);
    expect(seen).toEqual([true, false, true]);
  });

  it('an add sent while playing that the host applied inside the grace, the poll late: no waiting line', () => {
    const seen: boolean[] = [];
    let applied = false;
    const g = createPortEditGrace(timers, (v) => seen.push(v), () => !applied);
    g.arm(false);
    vi.advanceTimersByTime(300);
    applied = true;
    vi.advanceTimersByTime(PORT_EDIT_PENDING_GRACE_MS);
    expect(g.visible()).toBe(false);
    expect(seen).toEqual([]);
  });

  it('anyPortEditUnfolded reads each latch against the ports the scene shows now', () => {
    const before = [
      { index: 0, role: 0 },
      { index: 1, role: 1 },
    ];
    const after = [...before, { index: 2, role: 1 }];
    const latch = beginPortEdit(IDLE_PORT_EDIT, 'add', portsKeyOf(before), 100) as PortEditLatch;
    const latches = new Map<number, PortEditLatch>([[7, latch]]);
    expect(anyPortEditUnfolded(latches, () => before, new Set()), 'the scene still shows the old ports').toBe(true);
    expect(anyPortEditUnfolded(latches, () => after, new Set()), 'the scene shows the add applied').toBe(false);
    expect(anyPortEditUnfolded(latches, () => undefined, new Set()), 'the machine left the scene').toBe(false);
    expect(anyPortEditUnfolded(latches, () => before, new Set([7])), 'a restructure keyframe since the send').toBe(false);
    expect(anyPortEditUnfolded(new Map(), () => before, new Set()), 'no edit in flight').toBe(false);
  });
});
