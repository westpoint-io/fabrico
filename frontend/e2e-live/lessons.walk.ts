import { expect, test } from '@playwright/test';
import { frameBudgetMs } from '../e2e/support/frameSampler';
import { YOUR_FIRST_LINE } from '../src/tutorial/lessons/yourFirstLine';
import type { TutorialProbe } from '../src/chrome/tutorial/TutorialLayer';
import { expectRenderLoopAlive, readScene, resetToDemo, restoreHostAfterFailedTest, waitForAppReady, watchPageErrors } from './support/oracle';

// lessons.walk.ts - plays each lesson on the real host, the way a user would.

/**
 * Drawn frames a New may take to arrive: a playing board drains before it swaps, which is the
 * host's own round trip and can run to some seconds.
 */
const SWAP_FRAMES = 60;

test.afterEach(async ({ page }, testInfo) => {
  await restoreHostAfterFailedTest(page, testInfo);
});

test(`lesson ${YOUR_FIRST_LINE.id}`, async ({ page }) => {
  const errors = watchPageErrors(page);
  await page.goto('/');
  await waitForAppReady(page);
  await resetToDemo(page);

  await page.getByRole('button', { name: 'Help', exact: true }).click();
  await page.locator('#fab-help-panel').getByRole('button', { name: 'Lessons', exact: true }).click();
  await page.getByRole('button', { name: `Start ${YOUR_FIRST_LINE.title}`, exact: true }).click();

  const probe = (): Promise<TutorialProbe> =>
    page.evaluate(() => {
      const hook = (window as unknown as { __fabrico?: { tutorial?(): TutorialProbe } }).__fabrico;
      if (typeof hook?.tutorial !== 'function') throw new Error('window.__fabrico.tutorial() not installed');
      return hook.tutorial();
    });
  await expect
    .poll(async () => (await probe()).card, {
      message: `${YOUR_FIRST_LINE.id}: the lesson reached running after Start`,
      timeout: frameBudgetMs(SWAP_FRAMES),
    })
    .toBe('running');

  const running = await probe();
  expect(running.stepIndex, `${YOUR_FIRST_LINE.id}: the lesson starts on its first step`).toBe(0);
  expect(running.stepCount, `${YOUR_FIRST_LINE.id}: the probe counts the lesson's steps`).toBe(2);
  const scene = await readScene(page);
  expect(scene.nodes, `${YOUR_FIRST_LINE.id}: Start left no machine from the old board`).toEqual([]);
  expect(scene.belts, `${YOUR_FIRST_LINE.id}: Start left no belt from the old board`).toEqual([]);

  await expectRenderLoopAlive(page, 'after a lesson started');
  errors.assertNone('while a lesson started');
});
