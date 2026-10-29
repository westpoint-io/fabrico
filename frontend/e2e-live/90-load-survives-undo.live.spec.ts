import { test, expect, type Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEMO_NODE_COUNT,
  armAndPlaceAt,
  clickAt,
  expectRenderLoopAlive,
  pollScene,
  readScene,
  recordStatusStripDuring,
  resetToDemo,
  restoreHostAfterFailedTest,
  screenCellCentre,
  waitForAppReady,
  waitForCameraSettle,
  waitForFile,
  watchPageErrors,
} from './support/oracle';
import { GUARD_QUEUED_WORDS } from '../src/chrome/configCopy';

// 90-load-survives-undo.live.spec.ts (phase 90, WORK-10, D-06, success criterion 3, UI-SPEC
// section 6 and walk step 9): Ctrl+Z pressed while a board loads leaves the Load's own
// message in place, `Loaded` or `Load failed`, on the real dev host.
//
// WHAT WAS BROKEN (90-MEASURE.md, "WORK-10: still broken"). The status machine could not
// tell a Load's swap keyframe from an Undo's keyframe, so every Undo cancelled the pending
// Load to avoid a false `Loaded`: the strip stuck on `Loading…` for good, and a refused file
// showed its card but never `Load failed`. The held-undo notice on a paused board cancelled
// it the same way, and the strip faded to blank. Phase 88's swap floor tells the two apart:
// only a full packet whose swap floor equals its generation, above the floor at dispatch, is
// the Load's swap (`isLoadSwap`, src/chrome/dirtyState.ts).
//
// THE LEGS, each on the demo board with the strip recorded on every change
// (`recordStatusStripDuring`) from the Open to the Load's answer:
//   1. Running board, one Sink placed (so an Undo has something to undo), saved, opened
//      again, Ctrl+Z at once: `Loading…` then `Loaded`, never `Load failed` and never
//      `Disconnected` (review WR-B-02: the stall watchdog stands down over the swap's silence),
//      and the scene is the file's board (the Undo went to the board the swap replaced).
//   2. Running board, one Sink placed and saved, the refused file (eight 0xff bytes, as
//      29-load-refused-card.spec.ts writes it) opened, Ctrl+Z: the refusal card, and the
//      strip reads `Load failed` within 3 s of it (UI-SPEC A9). The board is kept, so the
//      Ctrl+Z, held by the host through the drain, then undoes the Sink on it.
//   3. A saved board, then Pause and a Sink placed (queued). The Open asks first and says the
//      queued edits will be lost (review WR-C-10: until review pass 2 it met no guard and the
//      leg graded the loss as the pass); its Discard runs the Open, and Ctrl+Z is pressed in the
//      SAME page task (review WR-C-09), so the swap's keyframe, a WebSocket message and a later
//      task, cannot land between them: the held-undo notice shows first, then `Loaded`.
//   4. (review CR-B-01) A paused board with NOTHING queued and an Undo available: the Open and
//      Ctrl+Z in one page task. The Undo is itself queued (`Paused - edits queued until Play`),
//      and that notice used to drop the Load: the strip never read `Loaded`. Now it does.
//   5. (review CR-B-01, the refused twin) The same with the refused file: the strip reads
//      `Load failed` with the card, after the queued notice.
// A running board drains before it swaps (since D-08 the Save before the Open runs on), up
// to the host's 512-tick settle budget, measured at up to 18.9 s under the CPU quota. Every
// wait for the Load's answer is 45 s, so a long drain is never graded as a failure.
//
// Focus: clicking Load leaves focus on the button and LW-02 stands the canvas keys down, so
// each Ctrl+Z follows a click on empty floor (30-post-load-undo.spec.ts, BLUR_CELL).
// MODEL FIRST, THEN RENDER HEALTH: `watchPageErrors` before `goto`, `expectRenderLoopAlive`
// after each phase, `assertNone` at the end.

const LOADING = 'Loading…';
const LOADED = 'Loaded';
const LOAD_FAILED = 'Load failed';
/** `STATUS_COPY.undoHeld`, transcribed, not imported. */
const HELD = 'Paused - press Play before undo or redo';
/** `STATUS_COPY.editsQueued`, transcribed, not imported. */
const QUEUED = 'Paused - edits queued until Play';
/** `STATUS_COPY.disconnected`'s first word, transcribed. */
const DISCONNECTED = 'Disconnected';
/** The budget for a Load's answer: the host's longest drain under the CPU quota, with room. */
const ANSWER_MS = 45_000;
/** A free cell well clear of the demo (30-post-load-undo.spec.ts). */
const SINK_CELL: [number, number] = [10, 12];
/** An empty cell clicked only to take focus off a toolbar button. */
const BLUR_CELL: [number, number] = [2, 14];
const STRIP_READOUT = '[data-fab-status-strip] [role="status"]';

function transport(page: Page) {
  return page.getByRole('button', { name: /^(Play|Pause)$/ });
}

async function readout(page: Page): Promise<string> {
  return ((await page.locator(STRIP_READOUT).first().textContent()) ?? '').trim();
}

/** The status copy a recorded strip text holds (the strip also holds the Unsaved badge). */
function statusOf(text: string): string {
  for (const copy of [LOAD_FAILED, LOADED, LOADING, HELD, QUEUED]) if (text.includes(copy)) return copy;
  return text;
}

/** The recorded strip as the status copies it showed, repeats folded. */
function statuses(strip: string[]): string[] {
  const out: string[] = [];
  for (const t of strip.map(statusOf)) if (out.at(-1) !== t) out.push(t);
  return out;
}

/**
 * Wrap a `recordStatusStripDuring` body so that, when it throws, the strip recorded so far is
 * printed: a red reading then says what the user saw, not only which wait ran out.
 */
function printingStripOnFailure(page: Page, leg: string, until: () => Promise<void>): () => Promise<void> {
  return async () => {
    try {
      await until();
    } catch (e) {
      const sofar = await page
        .evaluate(() => [...((window as unknown as { __fabStripSeen?: string[] }).__fabStripSeen ?? [])])
        .catch(() => [] as string[]);
      console.log(`P90-WORK-10 ${leg} FAILED strip=${JSON.stringify(sofar)} statuses=${JSON.stringify(statuses(sofar))}`);
      throw e;
    }
  };
}

async function blurToolbarFocus(page: Page): Promise<void> {
  const pt = await screenCellCentre(page, BLUR_CELL[0], BLUR_CELL[1]);
  await clickAt(page, pt.x, pt.y);
}

async function swapFloorOf(page: Page): Promise<number> {
  return ((await readScene(page)) as unknown as { swapFloor: number }).swapFloor;
}

async function placeSink(page: Page, expected: number): Promise<void> {
  await armAndPlaceAt(page, 'Sink', SINK_CELL[0], SINK_CELL[1]);
  await pollScene(page, (s) => s.nodes.length, { message: 'the Sink placement folded on the live host' }).toBe(expected);
}

/** Save through the toolbar prompt to a fresh path and wait for the file on disk. */
async function saveTo(page: Page, name: string): Promise<string> {
  const fab = join(tmpdir(), `fabrico-e2e-90-load-undo-${name}-${Date.now()}.fab`);
  page.once('dialog', (d) => d.accept(fab));
  await page.getByTitle('Save (Ctrl+S) - Shift for Save As').click();
  await waitForFile(fab, `${name}: the host wrote the .fab`);
  return fab;
}

/**
 * Review WR-C-09 / CR-B-01: in ONE page task, click `selector` (the toolbar's Load, or the open
 * guard's Discard), which runs the Open synchronously through the dev prompt (`onLoad` reaches its
 * dispatch before its first await), then press Ctrl+Z. The swap's keyframe is a WebSocket message,
 * a later task, so it cannot land between the two: the Ctrl+Z always meets the Load in flight. A
 * guard's Discard closes the dialog through React state, so the key waits two microtasks (still
 * this task) for React to commit, and throws if a dialog is still up rather than press into it.
 */
async function openThenUndoInOneTask(page: Page, path: string, selector: string): Promise<void> {
  page.once('dialog', (d) => d.accept(path));
  await page.evaluate(async (sel) => {
    const target = document.querySelector(sel);
    if (!(target instanceof HTMLElement)) throw new Error(`openThenUndoInOneTask: ${sel} is not on the page`);
    target.click();
    await Promise.resolve();
    await Promise.resolve();
    if (document.querySelector('.fab-dialog-panel') !== null) {
      throw new Error('openThenUndoInOneTask: a dialog is still open, the Ctrl+Z would go to it');
    }
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
  }, selector);
}

/** The toolbar's Load button: its title starts `Load a saved factory` (phase 91 added the `(Ctrl+O)`). */
const LOAD_BUTTON = 'button[title^="Load a saved factory"]';
/** The open discard guard's Discard button. */
const GUARD_DISCARD = '.fab-dialog-panel button.fab-dialog-btn--danger';

/** Open `path` through the toolbar prompt, then Ctrl+Z on the canvas at once. */
async function openThenUndo(page: Page, path: string): Promise<void> {
  page.once('dialog', (d) => d.accept(path));
  await page.getByTitle('Load a saved factory').click();
  await blurToolbarFocus(page);
  await page.keyboard.press('Control+z');
}

async function boot(page: Page): Promise<void> {
  await page.goto('/');
  await waitForAppReady(page);
  await resetToDemo(page, DEMO_NODE_COUNT);
  await waitForCameraSettle(page);
}

async function resumeIfPaused(page: Page): Promise<void> {
  if ((await transport(page).getAttribute('aria-label')) === 'Play') await transport(page).click();
  await expect(transport(page), 'the sim runs again (the toggle offers Pause)').toHaveAttribute('aria-label', 'Pause');
}

test.describe('90 live: Ctrl+Z during a Load leaves the Load its message (WORK-10)', () => {
  test.afterEach(async ({ page }, testInfo) => {
    await restoreHostAfterFailedTest(page, testInfo);
  });

  test('1: a running board saved and opened again, Ctrl+Z at once: Loading then Loaded, and the file\'s board', async ({
    page,
  }) => {
    test.setTimeout(150_000);
    const errs = watchPageErrors(page);
    await boot(page);
    await expectRenderLoopAlive(page, 'leg 1, on the demo board');
    await placeSink(page, DEMO_NODE_COUNT + 1);
    const fab = await saveTo(page, 'leg1');
    const floorBefore = await swapFloorOf(page);

    const strip = await recordStatusStripDuring(page, printingStripOnFailure(page, 'leg-1', async () => {
      await openThenUndo(page, fab);
      await expect
        .poll(() => readout(page), { timeout: ANSWER_MS, intervals: [50, 100, 250], message: 'leg 1: the Load reads Loaded after the Ctrl+Z' })
        .toBe(LOADED);
    }));
    const seen = statuses(strip);
    console.log(`P90-WORK-10 leg-1 strip=${JSON.stringify(strip)} statuses=${JSON.stringify(seen)}`);
    expect(seen, 'leg 1: the strip read Loading before Loaded').toContain(LOADING);
    expect(seen.indexOf(LOADING), 'leg 1: Loading came first').toBeLessThan(seen.indexOf(LOADED));
    expect(seen, 'leg 1: Load failed was never written over a Load the host answered').not.toContain(LOAD_FAILED);
    expect(
      strip.filter((t) => t.includes(DISCONNECTED)),
      'leg 1: the strip never read Disconnected through the swap (review WR-B-02)',
    ).toEqual([]);

    const scene = (await readScene(page)) as unknown as { swapFloor: number; generation: number; nodes: unknown[] };
    expect(scene.swapFloor, 'leg 1: the board on screen is a swap newer than the one before the Open').toBeGreaterThan(floorBefore);
    await pollScene(page, (s) => s.nodes.length, {
      message: 'leg 1: the scene is the file\'s board, the demo plus the saved Sink (the Undo went to the replaced board)',
    }).toBe(DEMO_NODE_COUNT + 1);
    await expectRenderLoopAlive(page, 'after leg 1');
    errs.assertNone('leg 1');
  });

  test('2: the refused file opened, Ctrl+Z: the refusal card, and Load failed within 3 s of it', async ({ page }) => {
    test.setTimeout(150_000);
    const errs = watchPageErrors(page);
    await boot(page);
    await expectRenderLoopAlive(page, 'leg 2, on the demo board');
    await placeSink(page, DEMO_NODE_COUNT + 1);
    // Saved, so the Open meets no discard guard, and the Sink keeps an Undo available.
    await saveTo(page, 'leg2');
    const refused = join(tmpdir(), `fabrico-e2e-90-load-undo-refused-${Date.now()}.fab`);
    writeFileSync(refused, Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]));
    const card = page.getByRole('alert');
    await expect(card, 'leg 2: no refusal card at rest').toHaveCount(0);

    let cardAt = 0;
    let failedAt = 0;
    const strip = await recordStatusStripDuring(page, printingStripOnFailure(page, 'leg-2', async () => {
      await openThenUndo(page, refused);
      await expect
        .poll(
          async () => {
            if (cardAt === 0 && (await card.count()) > 0) cardAt = Date.now();
            return cardAt > 0;
          },
          { timeout: ANSWER_MS, intervals: [50, 100, 250], message: 'leg 2: the host refused the file and the card is up' },
        )
        .toBe(true);
      await expect
        .poll(
          async () => {
            if (failedAt === 0 && (await readout(page)) === LOAD_FAILED) failedAt = Date.now();
            return failedAt > 0;
          },
          { timeout: 3_000, intervals: [50, 100, 250], message: 'leg 2: the strip reads Load failed within 3 s of the card' },
        )
        .toBe(true);
    }));
    const seen = statuses(strip);
    console.log(`P90-WORK-10 leg-2 strip=${JSON.stringify(strip)} statuses=${JSON.stringify(seen)} failed_after_card_ms=${failedAt - cardAt}`);
    await expect(card, 'leg 2: the refusal card is on screen').toBeVisible();
    expect(seen, 'leg 2: the strip never read Loaded for a refused file').not.toContain(LOADED);
    // The refused Load kept the board, so the Ctrl+Z pressed during it was not discarded by a
    // swap: the host held it through the drain and then undid the Sink on the kept board.
    await pollScene(page, (s) => s.nodes.length, {
      message: 'leg 2: the refused Load kept the board, and the Ctrl+Z pressed during it undid the Sink there',
    }).toBe(DEMO_NODE_COUNT);
    await page.getByRole('button', { name: 'Close' }).click();
    await expect(card, 'leg 2: Close takes the card away').toHaveCount(0);
    await expectRenderLoopAlive(page, 'after leg 2');
    errs.assertNone('leg 2');
  });

  test('3: a paused board with a queued edit: the Open asks first, Ctrl+Z in the same task, the held notice then Loaded', async ({ page }) => {
    test.setTimeout(150_000);
    const errs = watchPageErrors(page);
    await boot(page);
    await expectRenderLoopAlive(page, 'leg 3, on the demo board');
    const fab = await saveTo(page, 'leg3');
    try {
      await transport(page).click();
      await expect(transport(page), 'leg 3: the sim is paused (the toggle offers Play)').toHaveAttribute('aria-label', 'Play');
      await armAndPlaceAt(page, 'Sink', SINK_CELL[0], SINK_CELL[1]);
      await expect.poll(() => readout(page), { message: 'leg 3: the paused placement is queued' }).toBe(QUEUED);

      // WR-C-10: the Open asks first, and says the queued edit would be lost.
      await page.getByTitle('Load a saved factory').click();
      const guard = page.locator('.fab-dialog-panel');
      await expect(guard.getByText('Open another board?', { exact: true }), 'leg 3: the Open asks first').toBeVisible();
      await expect(guard, 'leg 3: the guard says the queued edits will be lost').toContainText(GUARD_QUEUED_WORDS);

      const strip = await recordStatusStripDuring(page, printingStripOnFailure(page, 'leg-3', async () => {
        await openThenUndoInOneTask(page, fab, GUARD_DISCARD);
        await expect
          .poll(() => readout(page), { timeout: ANSWER_MS, intervals: [50, 100, 250], message: 'leg 3: the Load reads Loaded after the held Ctrl+Z' })
          .toBe(LOADED);
      }));
      const seen = statuses(strip);
      console.log(`P90-WORK-10 leg-3 strip=${JSON.stringify(strip)} statuses=${JSON.stringify(seen)}`);
      expect(seen, 'leg 3: the held-undo notice was shown').toContain(HELD);
      expect(seen.indexOf(HELD), 'leg 3: the notice came first, then Loaded replaced it').toBeLessThan(seen.lastIndexOf(LOADED));
      expect(seen, 'leg 3: Load failed was never written').not.toContain(LOAD_FAILED);
      await pollScene(page, (s) => s.nodes.length, {
        message: 'leg 3: the scene is the file\'s board (the user chose Discard, so the swap dropped the queued Sink)',
      }).toBe(DEMO_NODE_COUNT);
      // No render-loop check here: `frame()` is the sim-tick render clock, which a paused
      // board does not advance. It is read after the resume below.
    } finally {
      await resumeIfPaused(page);
    }
    await expectRenderLoopAlive(page, 'after leg 3');
    errs.assertNone('leg 3');
  });

  /** Legs 4 and 5: a Sink placed and landed (an Undo is available), the board saved, then paused. */
  async function pausedWithAnUndo(page: Page, leg: string): Promise<string> {
    await boot(page);
    await expectRenderLoopAlive(page, `${leg}, on the demo board`);
    await placeSink(page, DEMO_NODE_COUNT + 1);
    const fab = await saveTo(page, leg.replace(/\s+/g, ''));
    await transport(page).click();
    await expect(transport(page), `${leg}: the sim is paused (the toggle offers Play)`).toHaveAttribute('aria-label', 'Play');
    expect(
      await page.evaluate(() => (window as unknown as { __fabrico: { hasUnsavedWork(): boolean } }).__fabrico.hasUnsavedWork()),
      `${leg}: PRECONDITION: nothing is queued and the board is saved, so the Open asks nothing`,
    ).toBe(false);
    return fab;
  }

  test('4: a paused board with nothing queued, the Open and Ctrl+Z in one task: the queued notice, then Loaded', async ({ page }) => {
    test.setTimeout(150_000);
    const errs = watchPageErrors(page);
    try {
      const fab = await pausedWithAnUndo(page, 'leg 4');
      const strip = await recordStatusStripDuring(page, printingStripOnFailure(page, 'leg-4', async () => {
        await openThenUndoInOneTask(page, fab, LOAD_BUTTON);
        await expect
          .poll(() => readout(page), { timeout: ANSWER_MS, intervals: [50, 100, 250], message: 'leg 4: the Load reads Loaded after the queued Ctrl+Z' })
          .toBe(LOADED);
      }));
      const seen = statuses(strip);
      console.log(`P90-WORK-10 leg-4 strip=${JSON.stringify(strip)} statuses=${JSON.stringify(seen)}`);
      expect(seen, 'leg 4: the Ctrl+Z was queued on the paused board').toContain(QUEUED);
      expect(seen.indexOf(QUEUED), 'leg 4: the queued notice came first, then Loaded').toBeLessThan(seen.lastIndexOf(LOADED));
      expect(seen, 'leg 4: Load failed was never written').not.toContain(LOAD_FAILED);
      await pollScene(page, (s) => s.nodes.length, {
        message: 'leg 4: the scene is the file\'s board, the demo plus the saved Sink (the queued Undo went with the old board)',
      }).toBe(DEMO_NODE_COUNT + 1);
    } finally {
      await resumeIfPaused(page);
    }
    await expectRenderLoopAlive(page, 'after leg 4');
    errs.assertNone('leg 4');
  });

  test('5: the refused file on a paused board, the Open and Ctrl+Z in one task: Load failed with the card', async ({ page }) => {
    test.setTimeout(150_000);
    const errs = watchPageErrors(page);
    try {
      await pausedWithAnUndo(page, 'leg 5');
      const refused = join(tmpdir(), `fabrico-e2e-90-load-undo-refused5-${Date.now()}.fab`);
      writeFileSync(refused, Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]));
      const card = page.getByRole('alert');
      const strip = await recordStatusStripDuring(page, printingStripOnFailure(page, 'leg-5', async () => {
        await openThenUndoInOneTask(page, refused, LOAD_BUTTON);
        await expect(card, 'leg 5: the host refused the file and the card is up').toBeVisible({ timeout: ANSWER_MS });
        await expect
          .poll(() => readout(page), { timeout: 3_000, intervals: [50, 100, 250], message: 'leg 5: the strip reads Load failed with the card' })
          .toBe(LOAD_FAILED);
      }));
      const seen = statuses(strip);
      console.log(`P90-WORK-10 leg-5 strip=${JSON.stringify(strip)} statuses=${JSON.stringify(seen)}`);
      expect(seen, 'leg 5: the Ctrl+Z was queued on the paused board').toContain(QUEUED);
      expect(seen, 'leg 5: the strip never read Loaded for a refused file').not.toContain(LOADED);
      await page.getByRole('button', { name: 'Close' }).click();
      await expect(card, 'leg 5: Close takes the card away').toHaveCount(0);
    } finally {
      await resumeIfPaused(page);
    }
    await expectRenderLoopAlive(page, 'after leg 5');
    errs.assertNone('leg 5');
  });
});
