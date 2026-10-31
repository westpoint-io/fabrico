import { expect, test } from '@playwright/test';
import { LESSONS } from '../src/tutorial/lessons';
import { openLessonsFromHelp, readProbe, startLesson, walkLesson } from './support/lessonRunner';
import { LESSON_WALKS } from './support/lessonWalks';
import { expectRenderLoopAlive, readScene, resetToDemo, restoreHostAfterFailedTest, waitForAppReady, watchPageErrors } from './support/oracle';

// lessons.walk.ts - plays each lesson on the real host, the way a user would. One test per entry in the
// walk table, each playing the data the app runs, so a lesson that adds steps needs no edit here. A
// lesson missing from the table gets no test, and `lessonCoverage.source.test.ts` fails by its name.

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
    // The demo's machines would finish the first step if they had survived Start.
    const scene = await readScene(page);
    expect(scene.nodes, `${lesson.id}: Start left no machine from the old board`).toEqual([]);
    expect(scene.belts, `${lesson.id}: Start left no belt from the old board`).toEqual([]);

    await walkLesson(page, lesson);

    expect((await readProbe(page)).card, `${lesson.id}: the lesson finished`).toBe('finished');
    await expectRenderLoopAlive(page, `after lesson ${lesson.id}`);
    errors.assertNone(`during lesson ${lesson.id}`);
  });
}
