import { test, expect } from '@playwright/test';
import { addWaitBudget, frameBudgetMs, tickBudgetMs } from '../e2e/support/frameSampler';
import {
  DRAWN_STATE_FRAMES,
  ensurePlaying,
  expectRenderLoopAlive,
  nodeAtAnchor,
  readScene,
  restoreHostAfterFailedTest,
  waitForAppReady,
  watchPageErrors,
  webhookUrl,
} from './support/oracle';
import {
  SOURCE_AT,
  boardLayout,
  buildStepOne,
  buildStepThree,
  buildStepTwo,
  liveLayout,
  outletCells,
  pageFactoryCode,
  readOutletWatch,
  startOutletWatch,
  stepBoardPath,
  stopOutletWatch,
} from './support/firstFactory';

// 98-first-factory.live.spec.ts - the first-factory tutorial page (`site/src/content/docs/
// get-started/first-factory.mdx`) done by hand on the REAL host (dev_render_server, real Core ->
// RenderProducer -> postcard -> WS). Zero mocks, zero injected packets.
//
// ---------------------------------------------------------------------------
// WHAT IT PROVES
// ---------------------------------------------------------------------------
//
// The tutorial tells a reader to build a board in the app, and shows a running board for each
// step. The docs boards run on the page; this spec proves the steps can be done in the app and give
// the same board. The live host's Examples menu loads only its three scenes, so the spec can't load
// a docs board; it builds each step with the palette clicks and belt drags the page lists
// (`support/firstFactory.ts`).
//
// ---------------------------------------------------------------------------
// THE LEGS, GRADED ON WHAT THE USER SEES
// ---------------------------------------------------------------------------
//
//   1. Step 1: New, a Source, a Sink eight cells to its right, and a belt dragged from the Source's
//      output to the Sink's input. The machines and belts on the live board, by kind and cell,
//      equal the Place and DrawBelt commands of `start-first-factory-1.board.ron`, and the belt is
//      docked at both ends. The cells the gestures use are the support module's own, so a gesture
//      one cell off fails the comparison and names the machine.
//   2. Step 2: the long belt is clicked and deleted with the Delete key (Delete anyway if the app
//      asks, which it doesn't on an empty belt), a Factory is placed in the gap and two belts are
//      drawn. The live board equals `start-first-factory-2.board.ron` the same way. The app has no
//      move, so the tutorial and this spec both delete and place.
//   3. Step 3: the Factory is selected, the `Factory code` block is read from the page at run
//      time and pasted into the inspector, and Apply is pressed. The inspector then holds exactly
//      the page's code, and the board equals `start-first-factory-3.board.ron`.
//   4. One webhook is POSTed to the Source's own URL with a fresh `x-delivery-id`. In-page, on
//      every drawn frame, a watch reads the model and the item layer: it has to see a frame where
//      the model lists an item on the Factory-to-Sink belt and the item layer draws a dot inside
//      one of that belt's cells (the per-cell rule of `itemDotsPerCell`). A dead renderer fails
//      this leg even while the model moves. No machine reads FAULTED in any frame.
//
// Render health throughout: `watchPageErrors` before `goto`, `expectRenderLoopAlive` after each
// step, and the watcher's `assertNone` at the end (fabrico-model-oracle-blindspot).

/** The state byte for a faulted machine (`fabrico-protocol` `state_tag`). */
const FAULTED = 2;
/** Ticks from the POST to the item on the outlet: the Source's next step, the two-cell inlet at
 *  2 ticks a slot (16), the Factory's step, and the outlet's first slot, rounded up to 40. */
const TRAVEL_TICKS = 40;
/** How many times slower than full speed the host may tick and still be graded (the 87 specs' 3). */
const SLOW_BOARD = 3;

test.afterEach(async ({ page }, testInfo) => {
  await restoreHostAfterFailedTest(page, testInfo);
});

test.describe('98 live: Your first factory, done by hand in the app', () => {
  test('steps 1 to 3 built by hand match their board files, the inspector holds the page code, and a webhook crosses the Factory onto the Sink belt', async ({ page }) => {
    const errs = watchPageErrors(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');
    await waitForAppReady(page);

    await buildStepOne(page);
    expect(await liveLayout(page), 'step 1: the live board holds the machines and belt of start-first-factory-1').toEqual(
      boardLayout(stepBoardPath(1)),
    );
    await expectRenderLoopAlive(page, 'after step 1');

    await buildStepTwo(page);
    expect(await liveLayout(page), 'step 2: the live board holds the machines and belts of start-first-factory-2').toEqual(
      boardLayout(stepBoardPath(2)),
    );
    await expectRenderLoopAlive(page, 'after step 2');

    const code = pageFactoryCode();
    const applied = await buildStepThree(page, code);
    expect(applied, "step 3: after Apply the inspector holds the page's Factory code exactly").toBe(code);
    expect(await liveLayout(page), 'step 3: the live board holds the machines and belts of start-first-factory-3').toEqual(
      boardLayout(stepBoardPath(3)),
    );
    await expectRenderLoopAlive(page, 'after step 3');

    // The webhook, sent to the Source's own loopback URL, crosses the Factory onto the outlet.
    await ensurePlaying(page);
    const source = nodeAtAnchor(await readScene(page), SOURCE_AT[0], SOURCE_AT[1]);
    expect(source, 'the Source is on the board to send to').toBeDefined();
    const url = await webhookUrl(page, source!.id);
    expect(url, 'the Source answers on its own loopback /hook/src-<id> URL').toMatch(/\/hook\/src-\d+$/);
    await startOutletWatch(page, outletCells());
    try {
      const resp = await page.request.post(url!, {
        data: { order: 1 },
        headers: { 'x-delivery-id': `first-factory-${Date.now()}` },
      });
      expect(resp.status(), 'the webhook is answered 200').toBe(200);
      await expect
        .poll(async () => (await readOutletWatch(page)).bothFrames, {
          timeout: addWaitBudget(
            tickBudgetMs(SLOW_BOARD * TRAVEL_TICKS) + frameBudgetMs(DRAWN_STATE_FRAMES),
            'one item crosses the inlet and the Factory and is drawn on the outlet',
          ),
          message: 'a frame where the model lists an item on the Factory-to-Sink belt and a dot is drawn on one of its cells',
        })
        .toBeGreaterThan(0);
      const watch = await readOutletWatch(page);
      console.log(`OUTLET carried=${watch.carried} drawn=${watch.drawn} bothFrames=${watch.bothFrames} faulted=${JSON.stringify(watch.faulted)}`);
      expect(watch.faulted, 'no machine read FAULTED while the item crossed').toEqual([]);
    } finally {
      await stopOutletWatch(page);
    }
    expect(
      (await readScene(page)).nodes.filter((n) => n.state === FAULTED).map((n) => n.id),
      'no machine reads FAULTED at the end',
    ).toEqual([]);
    await expectRenderLoopAlive(page, 'after the webhook crossed the Factory');

    errs.assertNone('while the tutorial was built by hand');
  });
});
