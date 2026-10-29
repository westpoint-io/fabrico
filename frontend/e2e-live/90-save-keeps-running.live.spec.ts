import { test, expect, type Page } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  demoCallerAndHandler,
  expectRenderLoopAlive,
  pollScene,
  readScene,
  recordStatusStripDuring,
  resetToDemo,
  restoreHostAfterFailedTest,
  waitForAppReady,
  waitForFile,
  watchPageErrors,
} from './support/oracle';

// 90-save-keeps-running.live.spec.ts (phase 90, plan 90-02, FAIL-04, D-08, success criterion 3,
// UI-SPEC section 3, walk step 8) - a Save on a running board keeps it running, on the REAL host
// (dev_render_server, real Core -> RenderProducer -> postcard -> WS). Zero mocks, zero injected
// packets: the save is the shipped Ctrl+S, the endpoint is the demo Route's own URL.
//
// ---------------------------------------------------------------------------
// WHAT WAS BROKEN (90-MEASURE.md `## FAIL-04: still broken`)
// ---------------------------------------------------------------------------
//
// A Save on a board with items in flight latches and drains to quiescence, writes the file, and
// then left the host Frozen: only a latched Load, New or example resumed after the drain. The page
// is never told, so its transport kept reading `Pause` while no packet arrived, the stall watchdog
// wrote `Disconnected - live view frozen` over the board after 800 ms and dimmed it, and every
// endpoint and webhook got a 503 until the user loaded something. D-08: a Save on a running board
// drains, writes, and carries on running; a Save on a board the user paused stays paused.
//
// ---------------------------------------------------------------------------
// THE LEGS, GRADED ON WHAT THE USER SEES
// ---------------------------------------------------------------------------
//
//   1. A running demo board with an item on a belt (the drain path, not the inline save), saved
//      with Ctrl+S to a real file: once the file is written whole (two equal reads, bytes in it),
//      for 3 s sampled every 200 ms, the status strip never shows `Disconnected - live view
//      frozen` (recorded on every change, not read twice), the disconnected dim is never in the
//      page, the transport button stays `Pause`, and the tick at the end is at least 30 past the
//      tick when the file appeared. Then a POST to the demo Route's endpoint is answered 200 (a
//      held host answers 503). Then the page is reloaded and the same grades hold for 3 s more
//      with the tick rising.
//
//      WHICH GRADES DISCRIMINATE (review IN-C-03). Under the FAIL-04 bug the page was never told the
//      host froze, so the transport kept reading `Pause` and that grade passes on the broken build.
//      The tick rule carries the leg: a host the save held stands still, and since review pass 2 a
//      one-tick rise (a late packet) no longer counts as running on. The POST's 200 discriminates
//      too (a held host answers 503). The dim and strip grades caught the original bug (its red run
//      failed on the dim), but since review WR-B-02 the page gives a host working on a Save its
//      settle window (10 s) before it says Disconnected, so inside this 3 s window they now guard
//      only the page's own stall handling, not a held host.
//   2. A paused demo board, saved with Ctrl+S: the file is written, the button stays `Play`, the
//      tick holds, and the status strip never shows Disconnected. Play is pressed at its end so
//      the shared host is left running.
//   3. (review WR-B-05, the page's view of CR-A-01) A running board with an item on a belt: Ctrl+S,
//      then Space twice (Pause, then Play) in ONE page task, so all three controls reach the host
//      while its Save drains. Until review pass 1 the Resume cancelled the latched Save without a
//      word: no file, and the badge already read saved. Now the file is written whole, the board
//      runs on 30 ticks and more with the transport reading Pause, and the strip never shows
//      Disconnected.
//   4. (review WR-B-05) The same with an Open of a file saved first: Open, Pause, Play in one page
//      task. The strip reads `Loaded`, never `Load failed`, and the opened board runs on.
//
// RED FIRST (D-14): run once against PHASE90_START (the frontend from the kept start worktree with
// this spec copied in, the host built there): leg 1 read red (90-EVIDENCE.md, `LIVE_RED
// 90-save-keeps-running`).
//
// Render health in every test: `watchPageErrors` before `goto`, `expectRenderLoopAlive` while the
// board runs (the render clock follows the sim clock, so a paused board holds it by design) and
// the watcher's `assertNone` at its end (fabrico-model-oracle-blindspot).

/** The status strip's sentence for a dropped stream (`controlHandlers.ts` `STATUS_COPY`). */
const DISCONNECTED = 'Disconnected - live view frozen';
/** The dim the page lays over the board while it believes the stream dropped (`App.tsx`). */
const DIM = '[data-fab-disconnected-dim]';
/** How many samples each watched window takes, and how far apart: 3 s at 200 ms. */
const WATCH_SAMPLES = 15;
const SAMPLE_MS = 200;
/** The paused leg's shorter window: 2 s at 200 ms. */
const PAUSED_SAMPLES = 10;
/** How long the paused board's tick must stand still before the save, to count as settled. */
const SETTLE_MS = 1_000;

/** The transport button. Icon-only: its accessible name is its `aria-label`, `Pause` while the
 *  page believes the sim runs and `Play` while it believes it is paused. */
function transportOf(page: Page) {
  return page.getByRole('button', { name: /^(Play|Pause)$/ });
}

/** Nothing focused, so a shortcut reaches the board and not a chrome button (`gestures.ts`). */
async function blurChrome(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

/** The tick rises across two reads: the host is running and streaming. */
async function expectTickRising(page: Page, message: string): Promise<void> {
  const t0 = (await readScene(page)).tick;
  await pollScene(page, (s) => s.tick, { message: `${message} (the tick was ${t0})` }).toBeGreaterThan(t0);
}

/** One sample of what the user sees: the dim count, the transport's name and the tick. */
async function sample(page: Page): Promise<{ dim: number; button: string | null; tick: number }> {
  return {
    dim: await page.locator(DIM).count(),
    button: await transportOf(page).getAttribute('aria-label'),
    tick: (await readScene(page)).tick,
  };
}

/**
 * Watch the board for `samples` samples `SAMPLE_MS` apart while the status strip is recorded on
 * every change. Each sample must show no dim and the transport reading `button`; the recorded
 * strip texts must never hold the Disconnected sentence. Returns the first and last tick read.
 */
async function watchBoard(
  page: Page,
  samples: number,
  button: 'Pause' | 'Play',
  context: string,
): Promise<{ first: number; last: number; strip: string[] }> {
  let first = -1;
  let last = -1;
  const strip = await recordStatusStripDuring(page, async () => {
    for (let i = 0; i < samples; i += 1) {
      await page.waitForTimeout(SAMPLE_MS);
      const s = await sample(page);
      if (first < 0) first = s.tick;
      last = s.tick;
      expect(s.dim, `${context}: sample ${i + 1} of ${samples}: the disconnected dim is not over the board`).toBe(0);
      expect(s.button, `${context}: sample ${i + 1} of ${samples}: the transport button reads ${button}`).toBe(button);
    }
  });
  console.log(`P90-FAIL-04 ${context.replace(/\s+/g, '-')} first=${first} last=${last} strip=${JSON.stringify(strip)}`);
  expect(
    strip.filter((t) => t.includes(DISCONNECTED)),
    `${context}: the status strip never read "${DISCONNECTED}" (every text it showed: ${JSON.stringify(strip)})`,
  ).toEqual([]);
  return { first, last, strip };
}

/**
 * Review WR-B-05: in ONE page task, the action (`Ctrl+S`, or a click on `selector`, which runs the
 * Save or the Open synchronously through the dev prompt), then Space twice: Pause, then Play. All
 * three controls reach the host in one batch, so the Pause and the Play land in the drain.
 */
async function actThenPauseAndPlay(page: Page, action: { key: 's' } | { click: string }): Promise<void> {
  await page.evaluate((a) => {
    (document.activeElement as HTMLElement | null)?.blur();
    const press = (key: string, ctrlKey = false): void => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey, bubbles: true, cancelable: true }));
    };
    if ('key' in a) {
      press(a.key, true);
    } else {
      const target = document.querySelector(a.click);
      if (!(target instanceof HTMLElement)) throw new Error(`actThenPauseAndPlay: ${a.click} is not on the page`);
      target.click();
    }
    press(' ');
    press(' ');
  }, action);
}

/** The status strip's readout (`Loaded` after an Open's swap). */
const STRIP_READOUT = '[data-fab-status-strip] [role="status"]';

test.describe('90 live: a save never holds a running board (FAIL-04)', () => {
  test.afterEach(async ({ page }, testInfo) => {
    await restoreHostAfterFailedTest(page, testInfo);
  });

  test('1: a save on a running board keeps it running and never shows Disconnected', async ({ page }) => {
    const errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await resetToDemo(page);
    await expectTickRising(page, 'the demo board is playing before the save');
    await pollScene(page, (s) => s.belts.some((b) => b.items > 0), {
      message: 'an item is on a belt, so the save takes the drain path and not the inline one',
    }).toBe(true);
    await expect(transportOf(page), 'the board is playing: the transport offers Pause').toHaveAttribute('aria-label', 'Pause');

    const savePath = join(tmpdir(), `fabrico-e2e-90-save-running-${Date.now()}.fab`);
    let dialogFired = false;
    page.once('dialog', (d) => {
      dialogFired = true;
      void d.accept(savePath);
    });
    await blurChrome(page);
    await page.keyboard.press('Control+s');
    await waitForFile(savePath, `the save wrote the file ${savePath}`, 30_000);
    expect(dialogFired, 'Ctrl+S opened the save prompt and the walk answered it').toBe(true);
    const tickAtFile = (await readScene(page)).tick;

    const after = await watchBoard(page, WATCH_SAMPLES, 'Pause', 'after the save');
    expect(
      after.last,
      `after the save: the tick ran on at least 30 past ${tickAtFile}, the tick when the file appeared (review IN-C-03: a one-tick rise is a late packet, not a run)`,
    ).toBeGreaterThanOrEqual(tickAtFile + 30);
    await expectRenderLoopAlive(page, 'after the save on a running board');

    const { callerUrl } = await demoCallerAndHandler(page);
    const resp = await page.request.post(callerUrl, {
      data: '{"from":"90-save-keeps-running"}',
      headers: { 'content-type': 'application/json' },
      timeout: 15_000,
      failOnStatusCode: false,
    });
    console.log(`P90-FAIL-04 endpoint_after_save url=${callerUrl} status=${resp.status()}`);
    expect(resp.status(), 'after the save the demo Route still answers its POST (a held host answers 503)').toBe(200);

    await page.reload();
    await waitForAppReady(page);
    const reloaded = await watchBoard(page, WATCH_SAMPLES, 'Pause', 'after the reload');
    expect(reloaded.last, 'after the reload: the tick rises across the window').toBeGreaterThan(reloaded.first);
    await expectRenderLoopAlive(page, 'after the reload');
    errs.assertNone('the save on a running board');
  });

  test('2: a save on a paused board stays paused', async ({ page }) => {
    const errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await resetToDemo(page);
    await expectTickRising(page, 'the demo board is playing before the pause');

    await transportOf(page).click();
    await expect(transportOf(page), 'Pause pressed: the transport offers Play').toHaveAttribute('aria-label', 'Play');
    // The pause drains in-flight items first, so the tick settles a few ticks later: read it once
    // it has stood still for `SETTLE_MS` (a packet can land over 300 ms late under the CPU quota).
    let settled = (await readScene(page)).tick;
    let since = Date.now();
    await expect
      .poll(
        async () => {
          const now = (await readScene(page)).tick;
          if (now !== settled) {
            settled = now;
            since = Date.now();
          }
          return Date.now() - since;
        },
        { timeout: 15_000, intervals: [100, 250], message: `the paused board settles: the tick stands still for ${SETTLE_MS} ms` },
      )
      .toBeGreaterThanOrEqual(SETTLE_MS);

    const savePath = join(tmpdir(), `fabrico-e2e-90-save-paused-${Date.now()}.fab`);
    page.once('dialog', (d) => void d.accept(savePath));
    await blurChrome(page);
    await page.keyboard.press('Control+s');
    await waitForFile(savePath, `the save on the paused board wrote the file ${savePath}`, 30_000);

    const held = await watchBoard(page, PAUSED_SAMPLES, 'Play', 'after the save on the paused board');
    expect(
      { first: held.first, last: held.last },
      `after the save on the paused board: the tick holds at ${settled}`,
    ).toEqual({ first: settled, last: settled });

    // Leave the shared host running for the next spec.
    await transportOf(page).click();
    await expect(transportOf(page), 'Play pressed: the transport offers Pause').toHaveAttribute('aria-label', 'Pause');
    await expectTickRising(page, 'Play after the paused save runs the board on');
    await expectRenderLoopAlive(page, 'after Play on the saved board');
    errs.assertNone('the save on a paused board');
  });

  test('3: Pause then Play while a Save drains: the file is written and the board runs on', async ({ page }) => {
    const errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await resetToDemo(page);
    await expectTickRising(page, 'leg 3: the demo board is playing before the save');
    await pollScene(page, (s) => s.belts.some((b) => b.items > 0), {
      message: 'leg 3: an item is on a belt, so the save latches and drains',
    }).toBe(true);
    const savePath = join(tmpdir(), `fabrico-e2e-90-save-pause-play-${Date.now()}.fab`);
    page.once('dialog', (d) => void d.accept(savePath));
    const strip = await recordStatusStripDuring(page, async () => {
      await actThenPauseAndPlay(page, { key: 's' });
      await waitForFile(savePath, `leg 3: the Save that a Pause and a Play met in its drain wrote ${savePath}`, 45_000);
      const tickAtFile = (await readScene(page)).tick;
      await pollScene(page, (s) => s.tick, {
        timeout: 15_000,
        message: `leg 3: after the file the board ran on 30 ticks past ${tickAtFile}`,
      }).toBeGreaterThanOrEqual(tickAtFile + 30);
    });
    console.log(`P90-WR-B-05 leg-3 strip=${JSON.stringify(strip)}`);
    await expect(transportOf(page), 'leg 3: the transport reads Pause, the board plays').toHaveAttribute('aria-label', 'Pause');
    expect(strip.filter((t) => t.includes(DISCONNECTED)), 'leg 3: the strip never read Disconnected').toEqual([]);
    await expect(page.getByText('Unsaved', { exact: true }), 'leg 3: the board reads saved, and it is').toHaveCount(0);
    await expectRenderLoopAlive(page, 'after leg 3');
    errs.assertNone('leg 3');
  });

  test('4: Pause then Play while an Open drains: Loaded, and the opened board runs on', async ({ page }) => {
    test.setTimeout(150_000);
    const errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await resetToDemo(page);
    const savePath = join(tmpdir(), `fabrico-e2e-90-open-pause-play-${Date.now()}.fab`);
    page.once('dialog', (d) => void d.accept(savePath));
    await blurChrome(page);
    await page.keyboard.press('Control+s');
    await waitForFile(savePath, `leg 4: the board was saved to ${savePath}`, 45_000);
    await expectTickRising(page, 'leg 4: the saved board plays on');
    await pollScene(page, (s) => s.belts.some((b) => b.items > 0), {
      message: 'leg 4: an item is on a belt, so the Open latches and drains',
    }).toBe(true);
    page.once('dialog', (d) => void d.accept(savePath));
    const strip = await recordStatusStripDuring(page, async () => {
      await actThenPauseAndPlay(page, { click: 'button[title^="Load a saved factory"]' });
      await expect
        .poll(async () => ((await page.locator(STRIP_READOUT).first().textContent()) ?? '').trim(), {
          timeout: 45_000,
          intervals: [50, 100, 250],
          message: 'leg 4: the Open that a Pause and a Play met in its drain reads Loaded',
        })
        .toBe('Loaded');
    });
    console.log(`P90-WR-B-05 leg-4 strip=${JSON.stringify(strip)}`);
    expect(strip.filter((t) => t.includes('Load failed')), 'leg 4: never Load failed').toEqual([]);
    expect(strip.filter((t) => t.includes(DISCONNECTED)), 'leg 4: never Disconnected').toEqual([]);
    const t0 = (await readScene(page)).tick;
    await pollScene(page, (s) => s.tick, { timeout: 15_000, message: `leg 4: the opened board runs on 30 ticks past ${t0}` }).toBeGreaterThanOrEqual(t0 + 30);
    await expect(transportOf(page), 'leg 4: the transport reads Pause, the board plays').toHaveAttribute('aria-label', 'Pause');
    await expectRenderLoopAlive(page, 'after leg 4');
    errs.assertNone('leg 4');
  });
});
