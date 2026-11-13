import { expect, test } from '@playwright/test';
import { LESSONS } from '../src/tutorial/lessons';
import { nodeKey } from '../src/tutorial/check';
import { frameBudgetMs } from '../e2e/support/frameSampler';
import { expectLessonRow, openLessonsFromHelp, readProbe, startLesson, walkLesson } from './support/lessonRunner';
import { LESSON_WALKS } from './support/lessonWalks';
import { cameraOf, expectRenderLoopAlive, readScene, resetToDemo, restoreHostAfterFailedTest, waitForAppReady, watchPageErrors } from './support/oracle';

// lessons.walk.ts - plays each lesson on the real host, the way a user would. One test per entry in the
// walk table, each playing the data the app runs, so a lesson that adds steps needs no edit here. A
// lesson missing from the table gets no test, and `lessonCoverage.source.test.ts` fails by its name.

/** Drawn frames for Keep building to take the card off the probe. */
const CLOSE_FRAMES = 20;
/** Drawn frames for a prepared board's framing to settle once step 1 is up. */
const FRAME_FRAMES = 60;
/** How far from 1 the camera's zoom may read on a prepared board's first step. */
const SCALE_TOLERANCE = 0.01;

test.afterEach(async ({ page }, testInfo) => {
  await restoreHostAfterFailedTest(page, testInfo);
});

for (const id of Object.keys(LESSON_WALKS)) {
  test(`lesson ${id}`, async ({ page }) => {
    const lesson = LESSONS.find((l) => l.id === id);
    if (lesson === undefined) throw new Error(`${id}: the walk table names a lesson LESSONS doesn't hold`);

    const errors = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await resetToDemo(page);

    await openLessonsFromHelp(page);
    await startLesson(page, lesson);

    const running = await readProbe(page);
    expect(running.stepIndex, `${lesson.id}: the lesson starts on its first step`).toBe(0);
    expect(running.stepCount, `${lesson.id}: the probe counts the lesson's steps`).toBe(lesson.steps.length);
    // Each lesson starts on its own board: an empty one, or the prepared board it declares. The demo's
    // machines would finish the first step if they had survived Start.
    const scene = await readScene(page);
    if (lesson.board === undefined) {
      expect(scene.nodes, `${lesson.id}: Start left no machine from the old board`).toEqual([]);
      expect(scene.belts, `${lesson.id}: Start left no belt from the old board`).toEqual([]);
    } else {
      const declared = lesson.board.machines.map((m) => m.nodeKey).sort();
      expect(scene.nodes.map((n) => nodeKey(n)).sort(), `${lesson.id}: Start brought exactly the lesson board's machines`).toEqual(declared);
      expect(scene.belts, `${lesson.id}: the lesson board starts with one belt`).toHaveLength(1);
      await expect(page.locator('[data-fab-step-card]'), `${lesson.id}: the card reads step 1`).toContainText(
        `Step 1 of ${lesson.steps.length}`,
      );
      await expect
        .poll(async () => Math.abs((await cameraOf(page)).scale - 1), {
          message: `${lesson.id}: the lesson board is framed at zoom 1 on step 1`,
          timeout: frameBudgetMs(FRAME_FRAMES),
        })
        .toBeLessThanOrEqual(SCALE_TOLERANCE);
    }

    await walkLesson(page, lesson);

    expect((await readProbe(page)).card, `${lesson.id}: the lesson finished`).toBe('finished');

    // Done is read after Keep building, not with the finished card up: the row reads Done from that
    // card too, so only once the card has gone does the row say what the store holds.
    await page.locator('[data-fab-step-card]').getByRole('button', { name: 'Keep building', exact: true }).click();
    await expect(page.locator('[data-fab-step-card]'), `${lesson.id}: Keep building closes the card`).toHaveCount(0);
    await expect
      .poll(async () => (await readProbe(page)).card, {
        message: `${lesson.id}: the lesson is off screen after Keep building`,
        timeout: frameBudgetMs(CLOSE_FRAMES),
      })
      .toBe('none');
    await openLessonsFromHelp(page);
    await expectLessonRow(page, lesson, 'Done', [`Restart ${lesson.title}`]);

    await expectRenderLoopAlive(page, `after lesson ${lesson.id}`);
    errors.assertNone(`during lesson ${lesson.id}`);
  });
}
