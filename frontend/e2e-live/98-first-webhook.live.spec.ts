import { execFileSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { addWaitBudget, frameBudgetMs, tickBudgetMs } from '../e2e/support/frameSampler';
import {
  DRAWN_STATE_FRAMES,
  ensurePlaying,
  expectRenderLoopAlive,
  itemDotsPerCell,
  pollScene,
  readScene,
  restoreHostAfterFailedTest,
  selectMachineAt,
  waitForAppReady,
  watchPageErrors,
  webhookUrl,
} from './support/oracle';
import { beltOn, deselectOnFloor, rowCells } from './support/beltBoard';
import {
  FLOOR,
  SINK_AT,
  SOURCE_AT,
  boardLayout,
  buildStepOne,
  liveLayout,
  readOutletWatch,
  startOutletWatch,
  stepBoardPath,
  stopOutletWatch,
} from './support/firstFactory';
import { curlArgs, readFirstWebhookCurl } from './support/pageCurl';

// 98-first-webhook.live.spec.ts - the "Send your first webhook" docs page
// (`site/src/content/docs/get-started/first-webhook.mdx`) run on the REAL host (dev_render_server,
// real Core -> RenderProducer -> postcard -> WS), with the real curl binary. Zero mocks, zero
// injected packets.
//
// ---------------------------------------------------------------------------
// WHAT IT PROVES
// ---------------------------------------------------------------------------
//
// The page tells a reader to copy a Source's Webhook URL from the inspector, put its port and id
// into the page's curl command, and run it. This spec does that: it builds the tutorial's step 1
// board by hand (the live host can't load a docs board), reads the URL the inspector shows, reads
// the curl block from the page at run time with `support/pageCurl.ts`, and runs curl with an
// argument array through `execFileSync`. The page text never reaches a shell.
//
// ---------------------------------------------------------------------------
// THE LEGS, GRADED ON WHAT THE USER SEES
// ---------------------------------------------------------------------------
//
//   1. Step 1 built by gestures equals `start-first-factory-1.board.ron`. The Source's inspector
//      shows the label Webhook URL and a URL equal to the host's own (`webhookUrl`).
//   2. With the board playing, curl posts the page's body to the page's URL, with that port and id
//      filled in and a delivery id unique to this run, and prints 200. This is what shows the
//      page's URL works: a wrong path gets 404 here. In one poll, the model lists an item on the step 1 belt and the item layer
//      draws a dot inside one of its cells. A dead renderer fails this leg while the model moves.
//   3. Once the belt is empty, curl sends again with the SAME delivery id and prints 200, as the
//      page says it will. An in-page watch on every drawn frame then sees no item on the belt, in
//      the model or drawn, for twice the belt's crossing time, while the tick keeps rising.
//
// Render health throughout: `watchPageErrors` before `goto`, `expectRenderLoopAlive` after each
// leg, and the watcher's `assertNone` at the end (fabrico-model-oracle-blindspot).

/** The step 1 belt: every cell between the Source and the Sink, tail first. */
const BELT = rowCells(SOURCE_AT[0] + 1, SINK_AT[0] - 1, SOURCE_AT[1]);
/** Ticks an item takes per belt cell at the default pace: plan 03 measured 24 for three cells. */
const TICKS_PER_CELL = 8;
/** The step 1 belt's crossing time, 72 ticks for nine cells. Natively the step 1 board's Source
 *  makes its first item on tick 41 and the Sink takes it on tick 111, 70 ticks later. */
const CROSS_TICKS = BELT.length * TICKS_PER_CELL;
/** How long leg 3 watches for a repeat. A repeat that made an item would put it on the belt on
 *  the tick that took the request, before the 200, and it would stay there the whole crossing;
 *  twice the crossing covers an item that came on late as well as its whole stay. */
const REPEAT_WINDOW_TICKS = 2 * CROSS_TICKS;
/** How many times slower than full speed the host may tick and still be graded (the 87 specs' 3). */
const SLOW_BOARD = 3;

/** Run the real curl with an argument array and return the status code it printed. */
function sendWithCurl(url: string, deliveryId: string, body: string): string {
  return execFileSync('curl', curlArgs(url, deliveryId, body), {
    encoding: 'utf8',
    timeout: tickBudgetMs(SLOW_BOARD * CROSS_TICKS),
  }).trim();
}

test.afterEach(async ({ page }, testInfo) => {
  await stopOutletWatch(page).catch(() => undefined);
  await restoreHostAfterFailedTest(page, testInfo);
});

test.describe('98 live: Send your first webhook, with the page curl on the real host', () => {
  test("the page's curl reaches the step 1 Source and an item crosses the belt; the same delivery id again is answered 200 and makes none", async ({
    page,
  }) => {
    const errs = watchPageErrors(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');
    await waitForAppReady(page);

    // The page's command, read now so a broken block fails before the board is built.
    const pageCurl = readFirstWebhookCurl();

    // Leg 1: the step 1 board, and the URL the inspector shows.
    await buildStepOne(page);
    expect(await liveLayout(page), 'the live board holds the machines and belt of start-first-factory-1').toEqual(
      boardLayout(stepBoardPath(1)),
    );
    const source = await selectMachineAt(page, SOURCE_AT[0], SOURCE_AT[1]);
    const hostUrl = await webhookUrl(page, source.id);
    const parts = /^http:\/\/127\.0\.0\.1:(\d+)\/hook\/src-(\d+)$/.exec(hostUrl ?? '');
    expect(parts, `the host gives the Source a loopback /hook/src-<id> URL (got ${hostUrl})`).not.toBeNull();
    await expect(page.getByText('Webhook URL', { exact: true }), 'the inspector shows the Webhook URL row').toBeVisible();
    await expect(
      page.locator('span.fab-field', { hasText: 'http://127.0.0.1:' }),
      "the inspector's Webhook URL is the host's own URL for this Source",
    ).toHaveText(hostUrl!);
    // The page's URL with the inspector's port and id filled in. No assertion compares it with
    // hostUrl: parseFirstWebhookCurl already requires the page's URL to equal URL_TEMPLATE, and
    // the regex above has the same shape, so that comparison could never fail. Leg 2 is the check:
    // curl posts to this URL and has to get 200 and an item on the belt.
    const url = pageCurl.urlFor(Number(parts![1]), Number(parts![2]));
    await deselectOnFloor(page, FLOOR, 'after reading the Webhook URL');
    await expectRenderLoopAlive(page, 'after step 1 and the Webhook URL');

    // Leg 2: the page's curl, a fresh delivery id, an item on the belt in the model and drawn.
    await ensurePlaying(page);
    const deliveryId = `${pageCurl.deliveryId}-${Date.now()}`;
    expect(sendWithCurl(url, deliveryId, pageCurl.body), 'curl prints 200: the app took the webhook').toBe('200');
    await expect
      .poll(
        async () => {
          const carried = (beltOn(await readScene(page), BELT)?.items ?? 0) > 0;
          const dots = await itemDotsPerCell(page);
          const drawn = BELT.some(([x, y]) => (dots[`${x},${y}`] ?? 0) > 0);
          return `carried=${carried} drawn=${drawn}`;
        },
        {
          timeout: addWaitBudget(
            tickBudgetMs(SLOW_BOARD * CROSS_TICKS) + frameBudgetMs(DRAWN_STATE_FRAMES),
            'the webhook becomes an item on the step 1 belt and is drawn there',
          ),
          intervals: [100],
          message: 'the model lists an item on the step 1 belt and the item layer draws a dot in one of its cells',
        },
      )
      .toBe('carried=true drawn=true');
    await expectRenderLoopAlive(page, 'after the first webhook');

    // Leg 3: the belt empties, then the same delivery id again is a repeat: 200 and no item.
    await pollScene(page, (s) => beltOn(s, BELT)?.items ?? -1, {
      timeout: addWaitBudget(tickBudgetMs(SLOW_BOARD * CROSS_TICKS), 'the first item reaches the Sink'),
      message: 'the first item left the belt for the Sink',
    }).toBe(0);
    await startOutletWatch(page, BELT);
    try {
      const t0 = (await readScene(page)).tick;
      expect(sendWithCurl(url, deliveryId, pageCurl.body), 'curl prints 200 for a repeated delivery id too').toBe('200');
      await pollScene(page, (s) => s.tick, {
        timeout: addWaitBudget(tickBudgetMs(SLOW_BOARD * REPEAT_WINDOW_TICKS), 'the repeat window runs out'),
        message: `the tick runs on ${REPEAT_WINDOW_TICKS} past ${t0} after the repeat`,
      }).toBeGreaterThanOrEqual(t0 + REPEAT_WINDOW_TICKS);
      const watch = await readOutletWatch(page);
      console.log(
        `REPEAT window=${REPEAT_WINDOW_TICKS} carried=${watch.carried} drawn=${watch.drawn} faulted=${JSON.stringify(watch.faulted)}`,
      );
      expect(
        { carried: watch.carried, drawn: watch.drawn },
        `no item on the step 1 belt, in the model or drawn, for ${REPEAT_WINDOW_TICKS} ticks after the repeat`,
      ).toEqual({ carried: false, drawn: false });
      expect(watch.faulted, 'no machine read FAULTED in the repeat window').toEqual([]);
    } finally {
      await stopOutletWatch(page);
    }
    await expectRenderLoopAlive(page, 'after the repeated webhook');

    errs.assertNone('while the page curl ran against the step 1 board');
  });
});
