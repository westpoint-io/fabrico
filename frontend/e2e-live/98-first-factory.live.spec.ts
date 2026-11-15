import { test, expect } from '@playwright/test';
import { expectRenderLoopAlive, restoreHostAfterFailedTest, waitForAppReady, watchPageErrors } from './support/oracle';
import { boardLayout, buildStepOne, liveLayout, stepBoardPath } from './support/firstFactory';

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
//
// Render health throughout: `watchPageErrors` before `goto`, `expectRenderLoopAlive` after each
// step, and the watcher's `assertNone` at the end (fabrico-model-oracle-blindspot).

test.afterEach(async ({ page }, testInfo) => {
  await restoreHostAfterFailedTest(page, testInfo);
});

test.describe('98 live: Your first factory, done by hand in the app', () => {
  test('step 1 built by hand matches the step 1 board file', async ({ page }) => {
    const errs = watchPageErrors(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');
    await waitForAppReady(page);

    await buildStepOne(page);
    expect(await liveLayout(page), 'step 1: the live board holds the machines and belt of start-first-factory-1').toEqual(
      boardLayout(stepBoardPath(1)),
    );
    await expectRenderLoopAlive(page, 'after step 1');

    errs.assertNone('while the tutorial was built by hand');
  });
});
