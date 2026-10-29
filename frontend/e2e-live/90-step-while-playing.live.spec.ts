import { test, expect, type Page } from '@playwright/test';
import {
  DEMO_NODE_COUNT,
  expectRenderLoopAlive,
  loadDemoViaExamples,
  pollScene,
  readScene,
  recordStatusStripDuring,
  resetToDemo,
  restoreHostAfterFailedTest,
  waitForAppReady,
  watchPageErrors,
} from './support/oracle';

// 90-step-while-playing.live.spec.ts (phase 90, plan 90-02, FAIL-03, D-07, success criterion 3,
// UI-SPEC section 2, walk step 7) - Step pressed on a playing board pauses it and moves it exactly
// one tick, with the view still live, on the REAL host (dev_render_server, real Core ->
// RenderProducer -> postcard -> WS). Zero mocks, zero injected packets: the `.` key and the
// toolbar's Step button.
//
// ---------------------------------------------------------------------------
// WHAT WAS BROKEN (90-MEASURE.md `## FAIL-03: still broken`)
// ---------------------------------------------------------------------------
//
// `.` and the Step button sent `step` and nothing else. The host ran one tick and froze, but the
// page kept believing it was playing: the transport kept reading `Pause` over a board that no
// longer moved, and the stall watchdog read the silence as a dropped stream and wrote
// `Disconnected - live view frozen` over the board, dimmed. The host never recorded the Step as
// the user's own hold either, so a demo load after it resumed the board over the user's Step.
// D-07: one step handler for both entry points flips the page to paused before it sends `step`,
// and the host records a Step as the user's hold.
//
// ---------------------------------------------------------------------------
// THE LEGS, GRADED ON WHAT THE USER SEES
// ---------------------------------------------------------------------------
//
//   1. `.` on a playing board with nothing focused: the transport reads `Play` at once, the tick
//      settles and then, for 3 s sampled every 200 ms, holds that value with no dim over the board,
//      while the status strip (recorded on every change) never shows Disconnected. The settled
//      tick is at most `STEP_FROM_PLAYING_MAX_TICKS` above the tick the page had drawn when the
//      key went down, read in the same page task as the press (review WR-C-07: D-07's "freezes on
//      the spot, does not drain"; a drain on the demo board runs on 100 ticks or more). `.` again:
//      the tick is the settled tick plus exactly one, and holds. Play: the tick runs on.
//   2. The same with the toolbar's Step button (`Step one tick (.)`).
//   3. `.` on a playing board, then the demo loaded through Examples: after the swap the transport
//      still reads `Play` and the tick holds for 2 s (the Step was the user's hold, so the load
//      does not resume over it). Play at its end leaves the shared host running.
//
// RED FIRST (D-14): run once against PHASE90_START (the frontend from the kept start worktree with
// this spec copied in, the host built there): all three legs read red (90-EVIDENCE.md, `LIVE_RED
// 90-step-while-playing`).
//
// Render health in every test: `watchPageErrors` before `goto`, `expectRenderLoopAlive` while the
// board runs (the render clock follows the sim clock, so a paused board holds it by design) and
// the watcher's `assertNone` at its end (fabrico-model-oracle-blindspot).

/** The status strip's sentence for a dropped stream (`controlHandlers.ts` `STATUS_COPY`). */
const DISCONNECTED = 'Disconnected - live view frozen';
/** The dim the page lays over the board while it believes the stream dropped (`App.tsx`). */
const DIM = '[data-fab-disconnected-dim]';
/** The toolbar's Step button title (`Toolbar.tsx`). */
const STEP_TITLE = 'Step one tick (.)';
/** How far apart samples are taken. */
const SAMPLE_MS = 200;
/** 3 s of samples after the first Step, 1 s after the second, 2 s after the load. */
const WATCH_SAMPLES = 15;
const SECOND_STEP_SAMPLES = 5;
const AFTER_LOAD_SAMPLES = 10;
/**
 * The most ticks the first Step's settled tick may stand above the tick the page had drawn at the
 * press (review WR-C-07). The host runs exactly one tick (`a_step_from_playing_then_a_demo_load_
 * stays_paused` pins that on the host), and the rest is the frames already in flight to the page at
 * the press: packets were measured landing over 300 ms apart under the CPU quota, about 19 ticks at
 * 62.5 ticks a second. A Step that drained instead would run on to quiescence: on the demo board a
 * Pause's drain was measured at 122 ticks (66 to 188, plan 74.1-31), and the review measured 13 to
 * 117 on busier boards.
 */
const STEP_FROM_PLAYING_MAX_TICKS = 30;
/** How far past the demo's genesis tick the board runs before leg 3's Step, so the load's
 *  restart reads as a drop below the stepped tick (the demo restarts near tick 50). */
const RUN_PAST_TICK = 200;

/** The transport button. Icon-only: its accessible name is its `aria-label`, `Pause` while the
 *  page believes the sim runs and `Play` while it believes it is paused. */
function transportOf(page: Page) {
  return page.getByRole('button', { name: /^(Play|Pause)$/ });
}

/** Nothing focused, so `.` reaches the board and not a chrome button (`gestures.ts`). */
async function blurChrome(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

/** The tick rises across two reads: the host is running and streaming. */
async function expectTickRising(page: Page, message: string): Promise<void> {
  const t0 = (await readScene(page)).tick;
  await pollScene(page, (s) => s.tick, { message: `${message} (the tick was ${t0})` }).toBeGreaterThan(t0);
}

/** How long the tick must stand still to count as settled. Under the CPU quota a packet has been
 *  seen landing over 300 ms after the one before it (this spec's first green run, leg 2: 125 read
 *  twice 300 ms apart, then the Step's own 126), so the stand-still is read over a whole second. */
const SETTLE_MS = 1_000;

/** The tick once it has stood still for `SETTLE_MS`, polled on model reads. */
async function settledTick(page: Page, message: string): Promise<number> {
  let at = (await readScene(page)).tick;
  let since = Date.now();
  await expect
    .poll(
      async () => {
        const now = (await readScene(page)).tick;
        if (now !== at) {
          at = now;
          since = Date.now();
        }
        return Date.now() - since;
      },
      { timeout: 15_000, intervals: [100, 250], message },
    )
    .toBeGreaterThanOrEqual(SETTLE_MS);
  return at;
}

/**
 * Watch the board for `samples` samples `SAMPLE_MS` apart while the status strip is recorded on
 * every change: at every sample no dim, the transport reading `Play` and the tick equal to
 * `tick`; across the window the strip never holds the Disconnected sentence.
 */
async function expectHeldLive(page: Page, samples: number, tick: number, context: string): Promise<void> {
  const ticks: number[] = [];
  const strip = await recordStatusStripDuring(page, async () => {
    for (let i = 0; i < samples; i += 1) {
      await page.waitForTimeout(SAMPLE_MS);
      const dim = await page.locator(DIM).count();
      const button = await transportOf(page).getAttribute('aria-label');
      ticks.push((await readScene(page)).tick);
      expect(dim, `${context}: sample ${i + 1} of ${samples}: the disconnected dim is not over the board`).toBe(0);
      expect(button, `${context}: sample ${i + 1} of ${samples}: the transport button reads Play`).toBe('Play');
    }
  });
  console.log(`P90-FAIL-03 ${context.replace(/\s+/g, '-')} tick=${tick} ticks=${JSON.stringify(ticks)} strip=${JSON.stringify(strip)}`);
  expect(ticks, `${context}: the tick holds at ${tick} at every sample`).toEqual(ticks.map(() => tick));
  expect(
    strip.filter((t) => t.includes(DISCONNECTED)),
    `${context}: the status strip never read "${DISCONNECTED}" (every text it showed: ${JSON.stringify(strip)})`,
  ).toEqual([]);
}

/** Press Play and see the board run on, leaving the shared host running. */
async function playOn(page: Page, context: string): Promise<void> {
  await transportOf(page).click();
  await expect(transportOf(page), `${context}: Play pressed, the transport offers Pause`).toHaveAttribute('aria-label', 'Pause');
  await expectTickRising(page, `${context}: Play runs the board on`);
}

/**
 * Press `.` (nothing focused) or click the Step button inside ONE page task, and return the tick the
 * page had drawn at that moment (review WR-C-07), so no packet can land between the read and the
 * press.
 */
async function stepInOneTask(page: Page, how: 'key' | 'button'): Promise<number> {
  return page.evaluate(
    ([kind, title]) => {
      const scene = (window as unknown as { __fabrico: { scene(): { tick: number } } }).__fabrico.scene();
      if (kind === 'key') {
        (document.activeElement as HTMLElement | null)?.blur();
        window.dispatchEvent(new KeyboardEvent('keydown', { key: '.', bubbles: true }));
      } else {
        const button = document.querySelector(`button[title="${title}"]`);
        if (!(button instanceof HTMLButtonElement)) throw new Error(`stepInOneTask: no button titled ${title}`);
        button.click();
      }
      return scene.tick;
    },
    [how, STEP_TITLE] as const,
  );
}

/** Legs 1 and 2: one Step on a playing board, a second Step, then Play. */
async function stepWalk(page: Page, step: () => Promise<void>, how: string, kind: 'key' | 'button'): Promise<void> {
  await resetToDemo(page);
  await expectTickRising(page, `${how}: the demo board is playing before the Step`);
  await expect(transportOf(page), `${how}: the board is playing, the transport offers Pause`).toHaveAttribute('aria-label', 'Pause');
  await expectRenderLoopAlive(page, `${how}: before the Step`);

  const tickAtPress = await stepInOneTask(page, kind);
  await expect(transportOf(page), `${how}: Step on a playing board flips the transport to Play at once`).toHaveAttribute(
    'aria-label',
    'Play',
    { timeout: 2_000 },
  );
  const settled = await settledTick(page, `${how}: after the Step the tick stands still for ${SETTLE_MS} ms`);
  console.log(`P90-FAIL-03 ${how.replace(/\s+/g, '-')} tick_at_press=${tickAtPress} settled=${settled} moved=${settled - tickAtPress}`);
  expect(settled, `${how}: the first Step moved the board on (one tick, plus the frames in flight)`).toBeGreaterThan(tickAtPress);
  expect(
    settled - tickAtPress,
    `${how}: the first Step froze on the spot and did not drain (at most ${STEP_FROM_PLAYING_MAX_TICKS} ticks past the press)`,
  ).toBeLessThanOrEqual(STEP_FROM_PLAYING_MAX_TICKS);
  await expectHeldLive(page, WATCH_SAMPLES, settled, `${how}: after the first Step`);

  await step();
  await pollScene(page, (s) => s.tick, { message: `${how}: the second Step moves the tick to ${settled} + 1` }).toBe(settled + 1);
  await expectHeldLive(page, SECOND_STEP_SAMPLES, settled + 1, `${how}: after the second Step`);

  await playOn(page, how);
  await expectRenderLoopAlive(page, `${how}: after Play`);
}

test.describe('90 live: Step on a playing board pauses and steps once (FAIL-03)', () => {
  test.afterEach(async ({ page }, testInfo) => {
    await restoreHostAfterFailedTest(page, testInfo);
  });

  test('1: the . key on a playing board pauses, steps once and leaves the view live', async ({ page }) => {
    const errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await stepWalk(
      page,
      async () => {
        await blurChrome(page);
        await page.keyboard.press('.');
      },
      'the . key',
      'key',
    );
    errs.assertNone('Step by the . key');
  });

  test('2: the Step button on a playing board pauses, steps once and leaves the view live', async ({ page }) => {
    const errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await stepWalk(page, () => page.getByTitle(STEP_TITLE).click(), 'the Step button', 'button');
    errs.assertNone('Step by the button');
  });

  test('3: a demo load after a Step from playing leaves the board paused', async ({ page }) => {
    const errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await resetToDemo(page);
    await pollScene(page, (s) => s.tick, {
      timeout: 30_000,
      message: `the demo board runs past tick ${RUN_PAST_TICK}, so the load's restart reads as a drop`,
    }).toBeGreaterThan(RUN_PAST_TICK);
    await expectRenderLoopAlive(page, 'before the Step');

    await blurChrome(page);
    await page.keyboard.press('.');
    await expect(transportOf(page), 'Step on a playing board flips the transport to Play').toHaveAttribute('aria-label', 'Play', {
      timeout: 2_000,
    });
    const stepped = await settledTick(page, 'after the Step the tick stands still');

    await loadDemoViaExamples(page);
    await pollScene(page, (s) => s.tick < stepped && s.nodes.length === DEMO_NODE_COUNT && s.wires.length === 2, {
      timeout: 30_000,
      message: `the demo load swapped the board (its tick restarted below ${stepped} on the demo's nodes and wires)`,
    }).toBe(true);
    const afterSwap = await settledTick(page, 'after the swap the tick stands still');
    await expectHeldLive(page, AFTER_LOAD_SAMPLES, afterSwap, 'after the demo load');

    await playOn(page, 'after the demo load');
    await expectRenderLoopAlive(page, 'after Play on the loaded demo');
    errs.assertNone('the demo load after a Step');
  });
});
