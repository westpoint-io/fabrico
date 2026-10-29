import { test, expect, type Page } from '@playwright/test';
import {
  addWaitBudget,
  startFrameSampler,
  tickBudgetMs,
  waitForFramesAtFloor,
} from '../e2e/support/frameSampler';
import {
  cameraOf,
  expectRenderLoopAlive,
  handPlaceAt,
  newBoard,
  nodeAtAnchor,
  pendingShimmerInstructions,
  pollScene,
  readScene,
  resetZoomToActualSize,
  restoreHostAfterFailedTest,
  screenCellCentre,
  waitForAppReady,
  waitForCameraSettle,
  watchPageErrors,
} from './support/oracle';

// 88-refused-place-flash-only.live.spec.ts (plan 88-05, FAIL-07, WINDOWS 87, D-10, phase 88
// success criterion 4) - a refused placement shows the red flash alone. On the REAL host
// (dev_render_server, real Core -> RenderProducer -> postcard -> WS). Zero mocks, zero injected
// packets: every Source comes off the palette by hand, the board is paused and played from the
// toolbar.
//
// ---------------------------------------------------------------------------
// THE RULING
// ---------------------------------------------------------------------------
//
// D-10: a refused Place clears its own "waiting" shimmer when its verdict arrives, so the red
// flash is the only mark on the cell. Until plan 88-05 the gesture layer never heard a verdict:
// the shimmer (the neutral pulsing outline that says "the host has not answered yet") stayed up
// until 120 ticks had passed with no echo, beside the band's "That space is taken" sentence
// (WINDOWS 87). Since plan 88-05 each pending Place is paired with the host's answer by the
// gesture id it was sent under, and a refusal ends it and clears the shimmer slot when the slot
// shows it (`gestures.ts` `onVerdict`, `endPlacement`).
//
// ---------------------------------------------------------------------------
// THE LEGS
// ---------------------------------------------------------------------------
//
//   1. PLAYING. An empty board at zoom 1. A Source is placed by hand on a cell near the middle
//      of the view and echoes. A second Source is dropped by hand on the same cell: the ghost
//      knows the cell is taken, so the red flash fires, and the Place is still sent (the host
//      is the judge). Graded per drawn frame from before the drop: the reject flash Graphics
//      held geometry on some frame, the band showed the FootprintCollision sentence, and from
//      the sentence's first drawn frame on the shimmer Graphics holds no geometry after
//      `FEW_FRAMES` frames.
//   2. PAUSED. The same board, paused from the toolbar before the second drop. The Place waits
//      (the host answers nothing while paused) and its shimmer is up, read off the overlay's
//      Graphics. Then Play: the refusal comes back, and the shimmer is gone within
//      `FEW_FRAMES` frames of the sentence, not 120 ticks later.
//
// WHAT IS GRADED IS WHAT IS DRAWN (memory fabrico-model-oracle-blindspot). Both reads are plot
// reads: `window.__fabrico.rejectFlashInstructions()` and `window.__fabrico.pendingInstructions()`
// count the instructions the overlay's flash and shimmer `Graphics` hold, never a model flag.
// Render health in every test: `watchPageErrors` before `goto`, `expectRenderLoopAlive` on a
// ticking board after each gesture block, and the watcher's `assertNone`.
//
// Pause is HOST-global: leg 2 presses Play again in a `finally`, and a failed test restores the
// shared host (`restoreHostAfterFailedTest`).
//
// RED FIRST (88-EVIDENCE.md `## Plan 88-05`): served from a throwaway worktree at plan 88-05's
// start revision with only the plot read added, both legs read red: the shimmer outlived the
// refusal sentence.

/** `FootprintCollision`'s sentence (`REFUSAL_COPY`, `src/chrome/RefusalMessage.tsx`), transcribed. */
const FOOTPRINT_COLLISION = 'That space is taken. Clear it or try elsewhere.';
/**
 * The frames from the sentence's first drawn frame within which the shimmer must be gone. The
 * shimmer is cleared in the same call that hands the band its sentence, and React draws the
 * sentence on its next commit, so on a fixed build the count is 0; 3 allows for the band and the
 * overlay landing on different frames.
 */
const FEW_FRAMES = 3;
/**
 * The frames graded after the sentence first shows. Before the fix the shimmer stayed for 120
 * ticks, about 6 s at the 20 ticks a second phase 87 measured under the CPU quota, which is far
 * more than these frames at any rate the page draws, so a shimmer that outlives the refusal is
 * seen on them.
 */
const AFTER_REFUSAL_FRAMES = 30;
/** The ticks a single echo is allowed to take on a playing board, for the derived budgets. */
const ECHO_TICKS = 120;
/** Phase 87 measured about 20 ticks a second under the CPU quota, under the floor's 28. */
const SLOW_BOARD = 3;

let CELL_AT: [number, number] = [0, 0];

function transport(page: Page) {
  return page.getByRole('button', { name: /^(Play|Pause)$/ });
}

async function resumeIfPaused(page: Page): Promise<void> {
  if ((await transport(page).getAttribute('aria-label').catch(() => null)) === 'Play') {
    await transport(page).click();
  }
}

/** Pause from the toolbar and wait until the host stops ticking (two reads in a row agree). */
async function pauseAndSettle(page: Page): Promise<number> {
  await transport(page).click();
  await expect(transport(page), 'the sim is paused (the toggle offers Play)').toHaveAttribute('aria-label', 'Play');
  let pausedAt = -1;
  await expect
    .poll(
      async () => {
        const t = (await readScene(page)).tick;
        const settled = t === pausedAt;
        pausedAt = t;
        return settled;
      },
      {
        message: 'the host stopped ticking',
        intervals: [200],
        timeout: addWaitBudget(tickBudgetMs(SLOW_BOARD * ECHO_TICKS), 'the paused host settles'),
      },
    )
    .toBe(true);
  return pausedAt;
}

/** An empty board at zoom 1, and the cell nearest the middle of the view, checked to be canvas. */
async function emptyBoard(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await waitForAppReady(page);
  await newBoard(page);
  await resetZoomToActualSize(page);
  await waitForCameraSettle(page);
  expect((await cameraOf(page)).scale, 'zoom 1').toBe(1);
  const a = await screenCellCentre(page, 0, 0);
  const b = await screenCellCentre(page, 1, 1);
  CELL_AT = [Math.max(2, Math.round((640 - a.x) / (b.x - a.x))), Math.max(2, Math.round((400 - a.y) / (b.y - a.y)))];
  const m = await screenCellCentre(page, ...CELL_AT);
  const under = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName ?? 'NONE', m);
  expect(under, `the cell (${CELL_AT}) is on the canvas`).toBe('CANVAS');
  console.log(`CELL ${CELL_AT} screen=${Math.round(m.x)},${Math.round(m.y)}`);
}

/** The blocker: a Source placed by hand on the cell, echoed, the tool put down. */
async function placeBlocker(page: Page): Promise<void> {
  await handPlaceAt(page, 'Source', ...CELL_AT);
  await page.keyboard.press('Escape');
  await pollScene(page, (s) => !!nodeAtAnchor(s, ...CELL_AT), { message: 'the blocker echoed' }).toBe(true);
}

interface FlashTallies extends Record<string, number> {
  /** Frames on which the reject flash Graphics held geometry. */
  flashFrames: number;
  /** Frames before the sentence first showed on which the shimmer Graphics held geometry. */
  shimmerBefore: number;
  /** Frames from the sentence's first drawn frame on, that one included. */
  afterRefusal: number;
  /** Frames past the first `few` after the sentence on which the shimmer still held geometry. */
  lateShimmer: number;
  /** The most shimmer instructions seen after the sentence, on any frame. */
  shimmerAfterMax: number;
}

/** Start the per-frame read of both marks and the band under `window[key]`. */
async function startFlashSampler(page: Page, key: string): Promise<void> {
  await startFrameSampler<FlashTallies, { sentence: string; few: number }>(
    page,
    key,
    { minMs: 300, frames: 5, tallyAtLeast: { key: 'afterRefusal', frames: AFTER_REFUSAL_FRAMES } },
    { flashFrames: 0, shimmerBefore: 0, afterRefusal: 0, lateShimmer: 0, shimmerAfterMax: 0 },
    (t, a) => {
      const hook = (window as unknown as {
        __fabrico: { rejectFlashInstructions(): number; pendingInstructions(): number };
      }).__fabrico;
      if (hook.rejectFlashInstructions() > 0) t.flashFrames++;
      const shimmer = hook.pendingInstructions();
      const shows = (document.getElementById('fab-refusal')?.textContent ?? '').trim() === a.sentence;
      if (t.afterRefusal === 0 && !shows) {
        if (shimmer > 0) t.shimmerBefore++;
        return;
      }
      t.afterRefusal++;
      if (shimmer > t.shimmerAfterMax) t.shimmerAfterMax = shimmer;
      if (t.afterRefusal > a.few && shimmer > 0) t.lateShimmer++;
    },
    { sentence: FOOTPRINT_COLLISION, few: FEW_FRAMES },
  );
}

test.afterEach(async ({ page }, testInfo) => {
  await restoreHostAfterFailedTest(page, testInfo);
});

test.describe('a refused Place shows the red flash alone (FAIL-07, D-10)', () => {
  test('leg 1: playing board, a Source dropped on a Source: the flash, the sentence, and no shimmer after it', async ({
    page,
  }) => {
    const errs = watchPageErrors(page);
    await emptyBoard(page);
    await expectRenderLoopAlive(page, 'leg 1 start');
    await placeBlocker(page);
    await startFlashSampler(page, '__flashOnly1');
    await handPlaceAt(page, 'Source', ...CELL_AT);
    const sample = await waitForFramesAtFloor<FlashTallies>(page, '__flashOnly1');
    await page.keyboard.press('Escape');
    const t = sample.tallies;
    const shimmerNow = await pendingShimmerInstructions(page);
    console.log(`leg 1: ${JSON.stringify(t)} frames=${sample.frames} shimmerNow=${shimmerNow}`);
    expect(t.flashFrames, 'leg 1: the red flash was drawn at the drop').toBeGreaterThan(0);
    expect(t.afterRefusal, 'leg 1: the band showed the refusal sentence').toBeGreaterThanOrEqual(AFTER_REFUSAL_FRAMES);
    expect(t.lateShimmer, `leg 1: no shimmer drawn ${FEW_FRAMES} frames after the sentence`).toBe(0);
    expect(shimmerNow, 'leg 1: and none now').toBe(0);
    const s = await readScene(page);
    expect(s.nodes.filter((n) => n.kind === 0).length, 'leg 1: the one blocker, nothing minted').toBe(1);
    await expectRenderLoopAlive(page, 'leg 1 after the refusal');
    errs.assertNone('leg 1');
  });

  test('leg 2: paused board, the same drop waits with its shimmer, then Play: the shimmer goes with the refusal', async ({
    page,
  }) => {
    const errs = watchPageErrors(page);
    try {
      await emptyBoard(page);
      await expectRenderLoopAlive(page, 'leg 2 start');
      await placeBlocker(page);
      const t0 = await pauseAndSettle(page);
      await startFlashSampler(page, '__flashOnly2');
      await handPlaceAt(page, 'Source', ...CELL_AT);
      await page.keyboard.press('Escape');
      expect((await readScene(page)).tick, 'leg 2: still paused').toBe(t0);
      const waiting = await pendingShimmerInstructions(page);
      expect(waiting, 'leg 2: the waiting shimmer is drawn while the Place is queued').toBeGreaterThan(0);
      await transport(page).click();
      await expect(transport(page)).toHaveAttribute('aria-label', 'Pause');
      const sample = await waitForFramesAtFloor<FlashTallies>(page, '__flashOnly2');
      const t = sample.tallies;
      const shimmerNow = await pendingShimmerInstructions(page);
      console.log(`leg 2: ${JSON.stringify(t)} frames=${sample.frames} waiting=${waiting} shimmerNow=${shimmerNow}`);
      expect(t.flashFrames, 'leg 2: the red flash was drawn at the drop').toBeGreaterThan(0);
      expect(t.shimmerBefore, 'leg 2: the shimmer was drawn while the Place waited').toBeGreaterThan(0);
      expect(t.afterRefusal, 'leg 2: the band showed the refusal sentence after Play').toBeGreaterThanOrEqual(
        AFTER_REFUSAL_FRAMES,
      );
      expect(t.lateShimmer, `leg 2: no shimmer drawn ${FEW_FRAMES} frames after the sentence`).toBe(0);
      expect(shimmerNow, 'leg 2: and none now').toBe(0);
      const s = await readScene(page);
      expect(s.nodes.filter((n) => n.kind === 0).length, 'leg 2: the one blocker, nothing minted').toBe(1);
      await expectRenderLoopAlive(page, 'leg 2 after Play');
      errs.assertNone('leg 2');
    } finally {
      await resumeIfPaused(page);
    }
  });
});
