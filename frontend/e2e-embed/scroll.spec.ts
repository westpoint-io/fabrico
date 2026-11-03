import { expect, test, type Page } from '@playwright/test';
import { PNG } from 'playwright-core/lib/utilsBundle';
import type { BoardProbe } from '../src/embed/probe.ts';
import {
  autoContinueCaptions,
  fileCaptions,
  expectBoardDrawingAt,
  glCounts,
  installGlCounter,
  pageUrl,
  readProbeAt,
  recordConsoleErrors,
  recordRequests,
  watchPageErrors,
} from './support/health.ts';

// Boards come and go with the scroll. scroll.html has three boards in a row at the top, a spacer
// taller than three viewports, and three more at the bottom. Five times the test scrolls the
// bottom row to the top of the viewport and then scrolls back to the top of the page. After each
// move it waits until the row in view is mounted and the other row isn't, then checks:
//
// - the live WebGL context count, read by an init script that wraps getContext (never by the
//   embed), is at most 8 and is one per mounted board, and no mounted board's canvas got
//   webglcontextlost;
// - each board that came back is on the tick it left at or later, is playing if it was playing
//   when it left, and shows the picture it showed when it left (a new Pixi app on the kept
//   scene); a board away from the viewport doesn't step;
// - every mounted board draws: its frame count rises and a compositor screenshot of a belt
//   region changes;
// - each stage has the size it had before its board first loaded.
//
// Two of these boards go quiet for most of their run (order_processing after tick 256, the
// arrival-order board after its two webhooks), and a quiet board draws the same picture every
// frame, and the probe's belt region is the board's longest belt, which on the script-outcomes
// board carries one item, on tick 60. So just before a row leaves, the test presses Restart on
// each of its boards and waits 10 ticks: each board then leaves early in its run and comes back
// with items still to move on that belt. Ten ticks past the boot tick also tells a board that
// resumed apart from one that booted again. Each board also runs at 0.25x from its first mount,
// so the 23 ticks the script-outcomes item spends on that belt last 1.5 s rather than 0.4 s. The
// speed survives every unmount, which the test checks too.

const PAGE = pageUrl('scroll.html');
const TOP = ['top-0', 'top-1', 'top-2'] as const;
const BOTTOM = ['bottom-0', 'bottom-1', 'bottom-2'] as const;
const CYCLES = 5;
/** The stage's background, `--fab-substrate`. */
const SUBSTRATE = [0x1b, 0x1f, 0x27] as const;
/** Measured: 0.0 to 0.6 percent of a stage's pixels move between leaving and coming back. */
const MAX_CHANGED_PERCENT = 4;
/** Measured: 11 to 22 percent of a running stage differs from the substrate. */
const MIN_DRAWN_PERCENT = 5;

type Slot = (typeof TOP)[number] | (typeof BOTTOM)[number];

/** The caption ticks of a board, read from its file. */
const captionTicks = (id: string): number[] => fileCaptions(id).map((c) => c.tick);

const sel = (slot: Slot): string => `[data-slot="${slot}"] fabrico-board`;

async function probes(page: Page, slots: readonly Slot[]): Promise<BoardProbe[]> {
  return Promise.all(slots.map((slot) => readProbeAt(page, sel(slot))));
}

async function stageBox(page: Page, slot: Slot): Promise<{ x: number; y: number; width: number; height: number }> {
  return page.evaluate((s) => {
    const el = document.querySelector(s) as HTMLElement;
    const box = ((el.shadowRoot as ShadowRoot).querySelector('.stage') as HTMLElement).getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  }, sel(slot));
}

/** A compositor screenshot of a board's stage, decoded. */
async function stageShot(page: Page, slot: Slot): Promise<{ width: number; height: number; data: Uint8Array }> {
  return PNG.sync.read(await page.screenshot({ clip: await stageBox(page, slot), animations: 'allow' }));
}

/** Percent of pixels that differ by more than a small amount between two shots of one size. */
function changedPercent(a: { data: Uint8Array }, b: { data: Uint8Array }): number {
  let n = 0;
  const len = Math.min(a.data.length, b.data.length);
  for (let i = 0; i < len; i += 4) {
    const d = Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]);
    if (d > 24) n += 1;
  }
  return (n / (len / 4)) * 100;
}

/** Percent of pixels that aren't the stage's background colour. */
function drawnPercent(a: { data: Uint8Array }): number {
  let n = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const d = Math.abs(a.data[i] - SUBSTRATE[0]) + Math.abs(a.data[i + 1] - SUBSTRATE[1]) + Math.abs(a.data[i + 2] - SUBSTRATE[2]);
    if (d > 24) n += 1;
  }
  return (n / (a.data.length / 4)) * 100;
}

/** Wait until the boards in view are mounted and running, and the others are not mounted. */
async function settle(page: Page, inView: readonly Slot[], away: readonly Slot[], context: string): Promise<void> {
  const ids = async (slots: readonly Slot[]): Promise<string[]> => (await probes(page, slots)).map((p) => p.id);
  const want = {
    inView: (await ids(inView)).map((id) => `${id}:mounted:running`),
    away: (await ids(away)).map((id) => `${id}:not mounted`),
  };
  await expect
    .poll(
      async () => ({
        inView: (await probes(page, inView)).map((p) => `${p.id}:${p.mounted ? 'mounted' : 'not mounted'}:${p.state}`),
        away: (await probes(page, away)).map((p) => `${p.id}:${p.mounted ? 'mounted' : 'not mounted'}`),
      }),
      { message: `${context}: the row in view mounts and the other row unmounts`, timeout: 20_000, intervals: [50] },
    )
    .toEqual(want);
}

test('five scroll round trips keep at most 8 live contexts and every returning board picks up where it left', async ({ page }) => {
  test.setTimeout(300_000);
  const errors = watchPageErrors(page);
  const consoleErrors = recordConsoleErrors(page);
  const requests = recordRequests(page);
  await installGlCounter(page);
  // A board stops at each caption it has; press Continue at once, as a reader would.
  await autoContinueCaptions(page);
  await page.goto(PAGE);

  // Before the bottom row has ever been near the viewport, its stages already have their size.
  const sizes = new Map<Slot, { width: number; height: number }>();
  for (const slot of [...TOP, ...BOTTOM]) sizes.set(slot, await stageBox(page, slot));
  for (const p of await probes(page, BOTTOM)) {
    expect(p.mounted, `${p.id} at the bottom is not mounted while the page is at the top`).toBe(false);
    expect(p.state, `${p.id} at the bottom has not loaded`).toBe('loading');
  }

  let maxLive = 0;
  const pictureChanges: number[] = [];
  /** What each board was doing, and showing, just before its row left the viewport. */
  const left = new Map<
    Slot,
    {
      /** Read by the test just before the scroll. */
      tick: number;
      playing: boolean;
      held: boolean;
      shot: { data: Uint8Array };
      /** Read from the board while it was away: the tick it held and what it says it was doing. */
      leftTick: number;
      wasPlaying: boolean | null;
      heldThen: boolean;
    }
  >();

  const slowed = new Set<Slot>();
  const check = async (inView: readonly Slot[], away: readonly Slot[], context: string): Promise<void> => {
    await settle(page, inView, away, context);
    for (const slot of inView) {
      if (slowed.has(slot)) {
        expect((await readProbeAt(page, sel(slot))).speed, `${context}: ${slot} kept its speed while away`).toBe(0.25);
        continue;
      }
      await page.locator(sel(slot)).locator('select').selectOption({ label: '0.25x' });
      slowed.add(slot);
    }

    // The returning boards show what they showed when they left, before they move on much.
    for (const slot of inView) {
      const before = left.get(slot);
      if (before === undefined) continue;
      const shot = await stageShot(page, slot);
      const changed = changedPercent(before.shot, shot);
      pictureChanges.push(changed);
      expect(drawnPercent(shot), `${context}: ${slot} draws its board on the stage when it comes back`).toBeGreaterThan(MIN_DRAWN_PERCENT);
      expect(changed, `${context}: ${slot} comes back showing the picture it left with`).toBeLessThan(MAX_CHANGED_PERCENT);
    }

    const counts = await glCounts(page);
    maxLive = Math.max(maxLive, counts.live);
    expect(counts.live, `${context}: live WebGL contexts, counted from outside the page`).toBeLessThanOrEqual(8);
    expect(counts.live, `${context}: one live context per mounted board`).toBe(inView.length);
    expect(counts.lost, `${context}: no mounted board lost its context`).toBe(0);

    // The boards away from the viewport don't step. The tick each one holds is the tick it left
    // at, and its probe says whether it was playing then.
    const awayBefore = await probes(page, away);
    await page.waitForTimeout(300);
    const awayAfter = await probes(page, away);
    for (let i = 0; i < away.length; i++) {
      const p = awayAfter[i];
      expect(p.tick, `${context}: ${away[i]} (${p.id}) holds its tick while away`).toBe(awayBefore[i].tick);
      expect(p.playing, `${context}: ${away[i]} (${p.id}) is paused while away`).toBe(false);
      const seen = left.get(away[i]);
      if (seen === undefined) continue;
      expect(p.tick, `${context}: ${away[i]} (${p.id}) left on tick ${seen.tick} or later`).toBeGreaterThanOrEqual(seen.tick);
      // The test saw the board playing a moment before the scroll; in that moment it may have
      // reached a caption or its end tick and stopped there itself. Any other "not playing" is a
      // board that forgot it was playing.
      const stoppedItself = p.tick === p.endTick || captionTicks(p.id).includes(p.tick);
      if (seen.playing && !stoppedItself) {
        expect(p.wasPlaying, `${context}: ${away[i]} (${p.id}) was playing when it left on tick ${p.tick}`).toBe(true);
      }
      if (!seen.playing && !seen.held) {
        expect(p.wasPlaying, `${context}: ${away[i]} (${p.id}) was stopped when it left`).toBe(false);
      }
      seen.leftTick = p.tick;
      seen.wasPlaying = p.wasPlaying;
      seen.heldThen = !seen.playing && seen.held ? true : captionTicks(p.id).includes(p.tick);
    }

    for (const slot of inView) {
      const p = await readProbeAt(page, sel(slot));
      const before = left.get(slot);
      if (before !== undefined) {
        expect(p.wasPlaying, `${context}: ${slot} (${p.id}) still reports what it was doing when it left`).toBe(before.wasPlaying);
        expect(p.tick, `${context}: ${slot} (${p.id}) is on the tick it left at, ${before.leftTick}, or later`).toBeGreaterThanOrEqual(before.leftTick);
        if (before.wasPlaying === true && p.tick < p.endTick) {
          // Playing, or stopped by its own next caption after playing on to it.
          const heldLater = p.caption !== null && p.tick > before.leftTick;
          expect(p.playing || heldLater, `${context}: ${slot} (${p.id}) was playing when it left, so it plays again`).toBe(true);
        }
        // A board held on a caption is paused too, but the page presses Continue for it once
        // it is back, so only a board that had stopped for good is held to its tick.
        if (before.wasPlaying === false && !before.heldThen) {
          expect(p.tick, `${context}: ${slot} (${p.id}) was stopped when it left, so it is on the same tick`).toBe(before.leftTick);
          expect(p.playing, `${context}: ${slot} (${p.id}) was stopped when it left, so it stays stopped`).toBe(false);
        }
      }
      const size = await stageBox(page, slot);
      const want = sizes.get(slot) ?? { width: 0, height: 0 };
      expect(Math.abs(size.width - want.width), `${context}: ${slot} (${p.id}) stage width`).toBeLessThanOrEqual(0.5);
      expect(Math.abs(size.height - want.height), `${context}: ${slot} (${p.id}) stage height`).toBeLessThanOrEqual(0.5);
    }

    for (const slot of inView) {
      const p = await readProbeAt(page, sel(slot));
      await expectBoardDrawingAt(page, sel(slot), context, `${slot} (${p.id})`);
    }
  };

  /** Restart each board in the row, let it run 10 ticks, and write down what it is doing. */
  const leave = async (slots: readonly Slot[]): Promise<void> => {
    for (const slot of slots) await page.locator(sel(slot)).locator('button[data-control="restart"]').click();
    for (const slot of slots) {
      await expect
        .poll(async () => {
          const p = await readProbeAt(page, sel(slot));
          return p.tick - p.bootTick;
        }, { message: `${slot} runs 10 ticks after Restart`, intervals: [20] })
        .toBeGreaterThanOrEqual(10);
    }
    for (const slot of slots) {
      const p = await readProbeAt(page, sel(slot));
      left.set(slot, {
        tick: p.tick,
        playing: p.playing,
        held: p.caption !== null,
        shot: await stageShot(page, slot),
        leftTick: p.tick,
        wasPlaying: null,
        heldThen: false,
      });
    }
  };

  await check(TOP, BOTTOM, 'at load');
  for (let cycle = 1; cycle <= CYCLES; cycle++) {
    await leave(TOP);
    await page.evaluate(() => document.getElementById('bottom')?.scrollIntoView({ block: 'start' }));
    await check(BOTTOM, TOP, `cycle ${cycle}, at the bottom`);
    await leave(BOTTOM);
    await page.evaluate(() => window.scrollTo(0, 0));
    await check(TOP, BOTTOM, `cycle ${cycle}, back at the top`);
    const counts = await glCounts(page);
    console.log(`cycle ${cycle}: live ${counts.live}, lost ${counts.lost}, contexts made ${counts.made}, highest live so far ${maxLive}`);
  }
  console.log(
    `${CYCLES} cycles, highest live context count ${maxLive}; a returning stage changed by ` +
      `${Math.min(...pictureChanges).toFixed(2)} to ${Math.max(...pictureChanges).toFixed(2)} percent of its pixels`,
  );

  errors.assertNone('over five scroll cycles');
  expect(consoleErrors).toEqual([]);
  expect(requests).toEqual([PAGE]);
});
