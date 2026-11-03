// The page-wide slot list: at most `cap` boards hold a renderer, the rest wait in arrival order.
import { describe, expect, it } from 'vitest';
import { createScheduler, createSlots, MAX_LIVE_BOARDS, MOUNT_MARGIN, type ScheduledBoard } from './scheduler';

describe('createSlots', () => {
  it('the page cap is 8 boards and the mount margin is 200 px', () => {
    expect(MAX_LIVE_BOARDS).toBe(8);
    expect(MOUNT_MARGIN).toBe('200px');
  });

  it('with a cap of 8, the ninth board that asks is queued', () => {
    const slots = createSlots<string>(8);
    for (let i = 0; i < 8; i++) expect(slots.want(`b${i}`)).toBe('mount');
    expect(slots.want('b8')).toBe('queued');
    expect(slots.live()).toEqual(['b0', 'b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7']);
    expect(slots.queued()).toEqual(['b8']);
    expect(slots.isLive('b8')).toBe(false);
    expect(slots.isQueued('b8')).toBe(true);
  });

  it('a queued board mounts when a mounted board releases its slot', () => {
    const slots = createSlots<string>(8);
    for (let i = 0; i < 9; i++) slots.want(`b${i}`);
    expect(slots.release('b3')).toBe('b8');
    expect(slots.isLive('b8')).toBe(true);
    expect(slots.isLive('b3')).toBe(false);
    expect(slots.queued()).toEqual([]);
    expect(slots.live()).toHaveLength(8);
  });

  it('queued boards take freed slots in the order they asked', () => {
    const slots = createSlots<string>(2);
    slots.want('a');
    slots.want('b');
    expect(slots.want('c')).toBe('queued');
    expect(slots.want('d')).toBe('queued');
    expect(slots.release('a')).toBe('c');
    expect(slots.release('b')).toBe('d');
    expect(slots.live()).toEqual(['c', 'd']);
  });

  it('a board that leaves the margin releases its slot, and coming back takes a slot again', () => {
    const slots = createSlots<string>(8);
    slots.want('a');
    expect(slots.release('a')).toBeNull();
    expect(slots.isLive('a')).toBe(false);
    expect(slots.live()).toEqual([]);
    expect(slots.want('a')).toBe('mount');
    expect(slots.isLive('a')).toBe(true);
  });

  it('releasing a board that is not mounted does nothing', () => {
    const slots = createSlots<string>(1);
    slots.want('a');
    slots.want('b');
    expect(slots.release('nobody')).toBeNull();
    expect(slots.live()).toEqual(['a']);
    expect(slots.queued()).toEqual(['b']);
  });

  it('a queued board that leaves drops out of the queue and frees nothing', () => {
    const slots = createSlots<string>(1);
    slots.want('a');
    slots.want('b');
    slots.want('c');
    expect(slots.release('b')).toBeNull();
    expect(slots.queued()).toEqual(['c']);
    expect(slots.live()).toEqual(['a']);
    expect(slots.release('a')).toBe('c');
  });

  it('asking twice does not take two slots or queue twice', () => {
    const slots = createSlots<string>(1);
    expect(slots.want('a')).toBe('mount');
    expect(slots.want('a')).toBe('mount');
    expect(slots.want('b')).toBe('queued');
    expect(slots.want('b')).toBe('queued');
    expect(slots.live()).toEqual(['a']);
    expect(slots.queued()).toEqual(['b']);
  });

  it('refuses a cap below 1', () => {
    expect(() => createSlots<string>(0)).toThrow(RangeError);
  });
});

/** A board that writes down what the scheduler told it. */
function fakeBoard(name: string, log: string[]): ScheduledBoard {
  return {
    element: { name } as unknown as Element,
    mount: () => log.push(`${name} mount`),
    unmount: () => log.push(`${name} unmount`),
    setCapped: (capped) => log.push(`${name} capped=${capped}`),
  };
}

describe('createScheduler', () => {
  it('mounts boards near the viewport up to the cap and caps the rest', () => {
    const log: string[] = [];
    const s = createScheduler(2);
    const [a, b, c] = ['a', 'b', 'c'].map((n) => fakeBoard(n, log));
    for (const board of [a, b, c]) s.add(board);
    s.report([a, b, c].map((board) => ({ board, near: true })));
    expect(log).toEqual(['a mount', 'b mount', 'c capped=true']);
  });

  it('a board leaving unmounts it and hands its slot to the first one waiting', () => {
    const log: string[] = [];
    const s = createScheduler(1);
    const [a, b] = ['a', 'b'].map((n) => fakeBoard(n, log));
    s.add(a);
    s.add(b);
    s.report([
      { board: a, near: true },
      { board: b, near: true },
    ]);
    log.length = 0;
    s.report([{ board: a, near: false }]);
    expect(log).toEqual(['a unmount', 'b capped=false', 'b mount']);
    expect(s.isLive(b)).toBe(true);
  });

  it('in one batch, leaves are handled before arrivals', () => {
    const log: string[] = [];
    const s = createScheduler(1);
    const [a, b] = ['a', 'b'].map((n) => fakeBoard(n, log));
    s.add(a);
    s.add(b);
    s.report([{ board: a, near: true }]);
    log.length = 0;
    s.report([
      { board: b, near: true },
      { board: a, near: false },
    ]);
    expect(log).toEqual(['a unmount', 'b mount']);
  });

  it('a waiting board that leaves stops waiting and is not mounted later', () => {
    const log: string[] = [];
    const s = createScheduler(1);
    const [a, b] = ['a', 'b'].map((n) => fakeBoard(n, log));
    s.add(a);
    s.add(b);
    s.report([
      { board: a, near: true },
      { board: b, near: true },
    ]);
    s.report([{ board: b, near: false }]);
    log.length = 0;
    s.report([{ board: a, near: false }]);
    expect(log).toEqual(['a unmount']);
  });

  it('removing a mounted board frees its slot for the next one; a board not watched is ignored', () => {
    const log: string[] = [];
    const s = createScheduler(1);
    const [a, b, stranger] = ['a', 'b', 'x'].map((n) => fakeBoard(n, log));
    s.add(a);
    s.add(b);
    s.report([
      { board: a, near: true },
      { board: b, near: true },
      { board: stranger, near: true },
    ]);
    log.length = 0;
    s.remove(a);
    expect(log).toEqual(['b capped=false', 'b mount']);
  });

  it('a second "near" report for a mounted board does not mount it again', () => {
    const log: string[] = [];
    const s = createScheduler(2);
    const a = fakeBoard('a', log);
    s.add(a);
    s.report([{ board: a, near: true }]);
    s.report([{ board: a, near: true }]);
    expect(log).toEqual(['a mount']);
  });
});
