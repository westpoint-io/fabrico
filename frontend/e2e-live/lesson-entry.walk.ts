import { expect, test, type Locator, type Page } from '@playwright/test';
import { frameBudgetMs, tickBudgetMs } from '../e2e/support/frameSampler';
import { CELL } from '../shared/geometry';
import { machine_kind } from '../src/protocol/kinds';
import { YOUR_FIRST_LINE as LESSON } from '../src/tutorial/lessons/yourFirstLine';
import { expectLessonRow, openLessonsFromHelp, readProbe, startLesson, walkLesson } from './support/lessonRunner';
import {
  armAndPlaceAt,
  cameraOf,
  expectRenderLoopAlive,
  guardWillAsk,
  loadDemoViaExamples,
  newBoard,
  readScene,
  resetToDemo,
  restoreHostAfterFailedTest,
  waitForAppReady,
  waitForChromeAndTick,
  waitForEditVerdicts,
  watchPageErrors,
} from './support/oracle';

// lesson-entry.walk.ts - the ways into a lesson and back out of it, on the real host: the list from
// Help and from the welcome card, Leave, Resume and Restart, the unsaved-work question, a Source placed
// while away, Undo and a swapped board. A step finished "by the hint" goes through `walkLesson`, so
// these tests read rings through the same read the generated walk uses.

const CARD = '[data-fab-step-card]';
const PANEL = '#fab-lessons-panel';
const START = `Start ${LESSON.title}`;
const RESUME = `Resume ${LESSON.title}`;
const RESTART = `Restart ${LESSON.title}`;
const GUARD_HEADING = 'Start a new board?';
const STEP_COUNT = LESSON.steps.length;

/** Drawn frames for the app to show what a press asked for. */
const STAGE_FRAMES = 20;
/** Drawn frames a New may take to arrive: a playing board drains before it swaps. */
const SWAP_FRAMES = 60;
/** Sim ticks a read of the clock waits through. */
const RISE_TICKS = 4;

test.afterEach(async ({ page }, testInfo) => {
  await restoreHostAfterFailedTest(page, testInfo);
});

const guardButton = (page: Page, name: 'Cancel' | 'Discard'): Locator => page.locator('.fab-dialog-panel').getByRole('button', { name });
const guardHeading = (page: Page): Locator => page.getByRole('alertdialog').getByText(GUARD_HEADING);
const cardButton = (page: Page, name: string): Locator => page.locator(CARD).getByRole('button', { name, exact: true });

/** The app's demo, clean and running, as a user would first see it. */
async function fromDemo(page: Page): Promise<void> {
  await page.goto('/');
  await waitForAppReady(page);
  await resetToDemo(page);
}

/** Leave closes the card, and the probe agrees. */
async function pressLeave(page: Page): Promise<void> {
  await cardButton(page, 'Leave').click();
  await expect(page.locator(CARD), 'Leave closes the card').toHaveCount(0);
  expect((await readProbe(page)).card, 'the lesson is no longer on screen').toBe('none');
}

/** Step 1 of the lesson, on the empty board its New brought. */
async function expectFirstStepOnEmptyBoard(page: Page, what: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const probe = await readProbe(page);
        return `${probe.card}:${probe.stepIndex}`;
      },
      { message: `${what}: the lesson reached step 1`, timeout: frameBudgetMs(SWAP_FRAMES) },
    )
    .toBe('running:0');
  await expect(page.locator(CARD), `${what}: the card reads step 1`).toContainText(`Step 1 of ${STEP_COUNT}`);
  const scene = await readScene(page);
  expect(scene.nodes, `${what}: no machine came through`).toEqual([]);
  expect(scene.belts, `${what}: no belt came through`).toEqual([]);
}

/** The world cell under a share of the window, clear of the palette and the panels. */
async function freeCell(page: Page): Promise<readonly [number, number]> {
  const view = page.viewportSize();
  if (view === null) throw new Error('the page has no viewport');
  const cam = await cameraOf(page);
  const size = CELL * cam.scale;
  return [Math.floor((view.width * 0.45 - cam.x) / size), Math.floor((view.height * 0.45 - cam.y) / size)];
}

async function expectNodeKinds(page: Page, kinds: readonly number[], what: string): Promise<void> {
  await expect
    .poll(async () => (await readScene(page)).nodes.map((n) => n.kind), { message: what, timeout: frameBudgetMs(STAGE_FRAMES) })
    .toEqual([...kinds]);
}

async function expectTickRises(page: Page, what: string): Promise<void> {
  const tick0 = (await readScene(page)).tick;
  await expect
    .poll(async () => (await readScene(page)).tick, { message: what, timeout: tickBudgetMs(RISE_TICKS) + frameBudgetMs(STAGE_FRAMES) })
    .toBeGreaterThan(tick0);
}

/** The two counters a swap check could read. `readScene`'s facts hold neither. */
async function swapFacts(page: Page): Promise<{ generation: number; swapFloor: number }> {
  return page.evaluate(() => {
    const scene = (window as unknown as { __fabrico: { scene(): { generation: number; swapFloor: number } } }).__fabrico.scene();
    return { generation: scene.generation, swapFloor: scene.swapFloor };
  });
}

test('Help opens the list, and a lesson can be left, resumed and restarted', async ({ page }) => {
  const errors = watchPageErrors(page);
  await fromDemo(page);

  await openLessonsFromHelp(page);
  await expectLessonRow(page, LESSON, 'Not started', [START]);
  await startLesson(page, LESSON);
  await expect(page.locator(PANEL), 'Start closes the list').toHaveCount(0);

  await walkLesson(page, LESSON, { until: 'place-sink' });
  const placed = (await readProbe(page)).bound.source;
  expect(placed, 'step 1 bound the Source it asked for').toBeDefined();

  await pressLeave(page);
  await expectNodeKinds(page, [machine_kind.SOURCE], 'Leave left the Source on the board');
  expect((await readScene(page)).nodes[0]?.id, 'and it is the same machine').toBe(placed);
  await expect(page.locator('[data-fab-hint-layer]'), 'the ring went with the card').toHaveCount(0);
  await expectRenderLoopAlive(page, 'after Leave');

  await openLessonsFromHelp(page);
  await expectLessonRow(page, LESSON, 'In progress', [RESUME, RESTART]);
  await page.getByRole('button', { name: RESUME, exact: true }).click();
  await expect(page.locator(CARD), 'Resume comes back on the saved step').toContainText(`Step 2 of ${STEP_COUNT}`);
  await expect(page.locator(PANEL), 'Resume closes the list').toHaveCount(0);
  const resumed = await readProbe(page);
  expect(resumed.stepId).toBe('place-sink');
  expect(resumed.card).toBe('running');
  await expectNodeKinds(page, [machine_kind.SOURCE], 'Resume left the board as it was');

  await pressLeave(page);
  await openLessonsFromHelp(page);
  await waitForEditVerdicts(page);
  expect(await guardWillAsk(page), 'the placed Source is unsaved work').toBe(true);
  await page.getByRole('button', { name: RESTART, exact: true }).click();
  await expect(guardHeading(page), 'Restart asks the question New asks').toBeVisible();
  await guardButton(page, 'Discard').click();
  await expectFirstStepOnEmptyBoard(page, 'Restart');

  await expectRenderLoopAlive(page, 'after Restart');
  errors.assertNone('during leave, resume and restart');
});

test('the welcome card opens the list', async ({ page }) => {
  const errors = watchPageErrors(page);
  // A fresh context holds no first-run flag, and this readiness wait doesn't set one.
  await page.goto('/');
  await waitForChromeAndTick(page);

  const heading = page.getByRole('heading', { name: 'Welcome to Fabrico' });
  await expect(heading, 'the first-run card shows').toBeVisible();
  await page.getByRole('button', { name: 'Start a lesson', exact: true }).click();

  await expect(page.locator(PANEL), 'the list opens').toBeVisible();
  await expect(heading, 'the card goes').toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('fab.onboarding.seen.v1')), 'and it stays gone').toBe('1');
  await expectLessonRow(page, LESSON, 'Not started', [START]);

  await startLesson(page, LESSON);
  await expectFirstStepOnEmptyBoard(page, 'Start from the welcome card');
  await expectRenderLoopAlive(page, 'after the welcome card');
  errors.assertNone('during the welcome card');
});

test('declining leaves the board and the lesson as they were', async ({ page }) => {
  const errors = watchPageErrors(page);
  await fromDemo(page);
  await newBoard(page);

  const [cx, cy] = await freeCell(page);
  await armAndPlaceAt(page, 'Source', cx, cy);
  await expectNodeKinds(page, [machine_kind.SOURCE], 'the machine reached the board');
  await waitForEditVerdicts(page);
  expect(await guardWillAsk(page), 'the machine is unsaved work').toBe(true);

  await openLessonsFromHelp(page);
  await expectLessonRow(page, LESSON, 'Not started', [START]);
  await page.getByRole('button', { name: START, exact: true }).click();
  await expect(guardHeading(page), 'Start asks the question New asks').toBeVisible();
  await guardButton(page, 'Cancel').click();
  await expect(page.getByRole('alertdialog'), 'Cancel closes the question').toHaveCount(0);

  await expectNodeKinds(page, [machine_kind.SOURCE], 'the machine is still there');
  await expectTickRises(page, 'the board kept running');
  const probe = await readProbe(page);
  expect(probe.card, 'no lesson runs').toBe('none');
  expect(probe.lessonId, 'and none was marked').toBeNull();
  await expect(page.locator(CARD), 'no card came up').toHaveCount(0);
  await expect(page.locator(PANEL), 'the list is still open').toBeVisible();
  await expectLessonRow(page, LESSON, 'Not started', [START]);

  await page.getByRole('button', { name: START, exact: true }).click();
  await expect(guardHeading(page), 'the second Start asks again').toBeVisible();
  await guardButton(page, 'Discard').click();
  await expectFirstStepOnEmptyBoard(page, 'Start after Discard');

  await expectRenderLoopAlive(page, 'after declining');
  errors.assertNone('during the declined start');
});

test('a Source placed while the lesson is left finishes step 1 on Resume', async ({ page }) => {
  const errors = watchPageErrors(page);
  await fromDemo(page);
  await openLessonsFromHelp(page);
  await startLesson(page, LESSON);
  await pressLeave(page);

  const [cx, cy] = await freeCell(page);
  await armAndPlaceAt(page, 'Source', cx, cy);
  await expectNodeKinds(page, [machine_kind.SOURCE], 'the Source reached the board');

  await openLessonsFromHelp(page);
  await expectLessonRow(page, LESSON, 'In progress', [RESUME, RESTART]);
  await page.getByRole('button', { name: RESUME, exact: true }).click();

  const card = page.locator(CARD);
  await expect(card, 'the lesson moved on').toContainText(`Step 2 of ${STEP_COUNT}`);
  await expect(card, 'and the note says why').toContainText('Step 1 was already done, so the lesson moved on.');
  const probe = await readProbe(page);
  expect(probe.stepId).toBe('place-sink');
  expect(probe.bound.source, 'the lesson bound the Source that was already there').toBe((await readScene(page)).nodes[0]?.id);

  await expectRenderLoopAlive(page, 'after Resume');
  errors.assertNone('during Resume');
});

test('Undo goes back and a swap pauses', async ({ page }) => {
  const errors = watchPageErrors(page);
  await fromDemo(page);
  await openLessonsFromHelp(page);
  await startLesson(page, LESSON);
  await walkLesson(page, LESSON, { until: 'set-timer' });
  const card = page.locator(CARD);
  await expect(card).toContainText(`Step 3 of ${STEP_COUNT}`);

  // Undo takes back the Sink. The generation rises, the floor doesn't, and the lesson keeps going.
  const before = await swapFacts(page);
  await waitForEditVerdicts(page);
  await page.keyboard.press('Control+z');
  // The card and the step together, so a failure says whether the lesson read this Undo as a swap.
  await expect
    .poll(
      async () => {
        const probe = await readProbe(page);
        return `${probe.card}:${probe.stepId}`;
      },
      { message: 'Undo sent the lesson back to the Sink step, still running', timeout: frameBudgetMs(SWAP_FRAMES) },
    )
    .toBe('running:place-sink');
  const back = await readProbe(page);
  await expect(card, 'the note says why').toContainText('Step 2 needs doing again, so the lesson went back.');
  await expect(card).not.toContainText('Lesson paused');
  const undone = await readScene(page);
  const after = await swapFacts(page);
  expect(after.generation, 'the Undo raised the generation').toBeGreaterThan(before.generation);
  expect(after.swapFloor, 'and left the floor alone').toBe(before.swapFloor);
  expect(undone.nodes.map((n) => n.kind), 'the Source stays').toEqual([machine_kind.SOURCE]);
  expect(back.bound.source, 'and its binding follows the handle Undo minted').toBe(undone.nodes[0]?.id);
  expect(back.bound.sink, 'the Sink is unbound').toBeUndefined();

  // A board this lesson didn't ask for.
  await loadDemoViaExamples(page);
  await expect(card, 'the card says the lesson stopped').toContainText('Lesson paused');
  await expect(card).toContainText('The board changed, so this lesson stopped. Restart it, or leave it.');
  await expect(card).not.toContainText(/Step \d/);
  await expect
    .poll(async () => (await readProbe(page)).hint, { message: 'the ring goes with the board', timeout: frameBudgetMs(STAGE_FRAMES) })
    .toBeNull();
  expect((await readProbe(page)).card).toBe('swapped');

  await waitForEditVerdicts(page);
  const asks = await guardWillAsk(page);
  await cardButton(page, 'Restart').click();
  if (asks) await guardButton(page, 'Discard').click();
  await expectFirstStepOnEmptyBoard(page, 'Restart from the paused card');

  await expectRenderLoopAlive(page, 'after the swap');
  errors.assertNone('during Undo and the swap');
});

test('a corrupt stored value boots to an empty list, and a start and a reset are stored', async ({ page }) => {
  const errors = watchPageErrors(page);
  const KEY = 'fab.tutorial.v1';
  const stored = (): Promise<string | null> => page.evaluate((k) => localStorage.getItem(k), KEY);
  await fromDemo(page);

  // Through the page, as a user's own script could, and never by editing WebKit's storage file.
  await page.evaluate((k) => localStorage.setItem(k, 'not json'), KEY);
  await page.reload();
  await waitForAppReady(page);
  await expectRenderLoopAlive(page, 'after a reload on a corrupt value');
  errors.assertNone('booting on a corrupt value');
  expect(await stored(), 'the corrupt value is still there, so the boot read it').toBe('not json');
  await openLessonsFromHelp(page);
  await expectLessonRow(page, LESSON, 'Not started', [START]);

  // A Start is stored, and a reload reads it with no run to resume.
  await startLesson(page, LESSON);
  const inProgress = JSON.stringify({ version: 1, lessons: { [LESSON.id]: 'inProgress' } });
  await expect.poll(stored, { message: 'Start stored In progress', timeout: frameBudgetMs(STAGE_FRAMES) }).toBe(inProgress);
  await page.reload();
  await waitForAppReady(page);
  await openLessonsFromHelp(page);
  await expectLessonRow(page, LESSON, 'In progress', [RESTART]);

  // A reset is stored too.
  const footer = page.locator(`${PANEL} [data-fab-lessons-footer]`);
  await footer.getByRole('button', { name: 'Reset progress', exact: true }).click();
  await expect(footer.getByRole('button', { name: 'Keep progress', exact: true }), 'the question focuses Keep progress').toBeFocused();
  await footer.getByRole('button', { name: 'Clear progress', exact: true }).click();
  await expect(footer.locator('[aria-live="polite"]')).toHaveText('Progress cleared.');
  await expectLessonRow(page, LESSON, 'Not started', [START]);
  expect(await stored(), 'Clear progress removed the key').toBeNull();
  await page.reload();
  await waitForAppReady(page);
  await openLessonsFromHelp(page);
  await expectLessonRow(page, LESSON, 'Not started', [START]);

  await expectRenderLoopAlive(page, 'after the reset and a reload');
  errors.assertNone('during the corrupt value, the start and the reset');
});
