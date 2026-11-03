// The page-wide mount scheduler for `<fabrico-board>` elements.
//
// Each board owns one Pixi Application and so one WebGL context, and Chromium and WebKitGTK keep at
// most 16 live contexts a page: the 17th kills the oldest, even when that board is on screen. So a
// board holds a renderer only while it is within 200 px of the viewport, and at most 8 boards hold
// one at a time. One `IntersectionObserver` for the whole page watches every board. A board that
// comes within the margin asks for a slot: with one free it mounts, and with all 8 taken it waits
// in a queue, in the order boards asked, and shows its poster until a mounted board leaves.
//
// The slot list is plain logic (`createSlots`), so a unit test can drive it. The browser part only
// turns observer entries into `want` and `release` calls and tells each board what to do.

/** The most boards on one page that hold a WebGL context at once. */
export const MAX_LIVE_BOARDS = 8;
/** How far outside the viewport a board still counts as near enough to mount. */
export const MOUNT_MARGIN = '200px';

export interface Slots<K> {
  /** Ask for a slot. `mount` when the board has one (now or already), `queued` when it waits. */
  want(key: K): 'mount' | 'queued';
  /**
   * Give up a slot or a place in the queue. Returns the queued board that takes the freed slot, or
   * null when the key held no slot or nobody was waiting. A key that held nothing changes nothing.
   */
  release(key: K): K | null;
  isLive(key: K): boolean;
  isQueued(key: K): boolean;
  /** The boards holding a slot, in the order they got it. */
  live(): K[];
  /** The boards waiting, in the order they asked. */
  queued(): K[];
}

export function createSlots<K>(cap: number): Slots<K> {
  if (!Number.isInteger(cap) || cap < 1) throw new RangeError(`the page cap is a whole number of at least 1, not ${cap}`);
  const live: K[] = [];
  const queue: K[] = [];
  return {
    want(key) {
      if (live.includes(key)) return 'mount';
      if (live.length < cap) {
        live.push(key);
        return 'mount';
      }
      if (!queue.includes(key)) queue.push(key);
      return 'queued';
    },
    release(key) {
      const waiting = queue.indexOf(key);
      if (waiting >= 0) {
        queue.splice(waiting, 1);
        return null;
      }
      const at = live.indexOf(key);
      if (at < 0) return null;
      live.splice(at, 1);
      const next = queue.shift();
      if (next === undefined) return null;
      live.push(next);
      return next;
    },
    isLive: (key) => live.includes(key),
    isQueued: (key) => queue.includes(key),
    live: () => [...live],
    queued: () => [...queue],
  };
}

/** What the scheduler asks of a board. */
export interface ScheduledBoard {
  /** The element the observer watches. */
  readonly element: Element;
  /** The board has a slot: start its renderer. */
  mount(): void;
  /** The board left the margin: free its renderer, keep its player and its scene. */
  unmount(): void;
  /** True while the board waits on the page cap, false once it doesn't. */
  setCapped(capped: boolean): void;
}

export interface Scheduler {
  /** Start watching a board. The observer reports it once at once, in or out of the margin. */
  add(board: ScheduledBoard): void;
  /** Stop watching a board and give back its slot or its place in the queue. */
  remove(board: ScheduledBoard): void;
  /** Whether the board holds one of the page's slots. */
  isLive(board: ScheduledBoard): boolean;
}

/** The scheduler logic over any source of "near the viewport" reports, for tests and the page. */
export function createScheduler(cap = MAX_LIVE_BOARDS): Scheduler & {
  /** Feed one batch of reports: each board and whether it is within the margin now. */
  report(entries: readonly { board: ScheduledBoard; near: boolean }[]): void;
} {
  const slots = createSlots<ScheduledBoard>(cap);
  const watched = new Set<ScheduledBoard>();

  const grant = (board: ScheduledBoard | null): void => {
    if (board === null) return;
    board.setCapped(false);
    board.mount();
  };

  const leave = (board: ScheduledBoard): void => {
    if (slots.isQueued(board)) {
      slots.release(board);
      board.setCapped(false);
      return;
    }
    if (!slots.isLive(board)) return;
    board.unmount();
    grant(slots.release(board));
  };

  const enter = (board: ScheduledBoard): void => {
    if (slots.isLive(board) || slots.isQueued(board)) return;
    if (slots.want(board) === 'mount') board.mount();
    else board.setCapped(true);
  };

  return {
    add(board) {
      watched.add(board);
    },
    remove(board) {
      if (!watched.delete(board)) return;
      if (slots.isQueued(board)) {
        slots.release(board);
        return;
      }
      // The board tears itself down on disconnect; this only frees the slot for the next one.
      grant(slots.release(board));
    },
    isLive: (board) => slots.isLive(board),
    report(entries) {
      // The last report per board in a batch is the current one. Leaves go first, so a fast
      // scroll frees slots before the boards coming into view ask for them.
      const latest = new Map<ScheduledBoard, boolean>();
      for (const { board, near } of entries) if (watched.has(board)) latest.set(board, near);
      for (const [board, near] of latest) if (!near) leave(board);
      for (const [board, near] of latest) if (near) enter(board);
    },
  };
}

let page: Scheduler | null = null;

/** The one scheduler for this page, with its one IntersectionObserver. */
export function pageScheduler(): Scheduler {
  if (page !== null) return page;
  const core = createScheduler();
  const byElement = new Map<Element, ScheduledBoard>();
  const observer = new IntersectionObserver(
    (entries) => {
      const reports: { board: ScheduledBoard; near: boolean }[] = [];
      for (const entry of entries) {
        const board = byElement.get(entry.target);
        if (board !== undefined) reports.push({ board, near: entry.isIntersecting });
      }
      core.report(reports);
    },
    { rootMargin: MOUNT_MARGIN },
  );
  page = {
    add(board) {
      byElement.set(board.element, board);
      core.add(board);
      observer.observe(board.element);
    },
    remove(board) {
      observer.unobserve(board.element);
      byElement.delete(board.element);
      core.remove(board);
    },
    isLive: (board) => core.isLive(board),
  };
  return page;
}
