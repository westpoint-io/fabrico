import { expect, test, type Page } from '@playwright/test';
import { frameBudgetMs, tickBudgetMs } from '../e2e/support/frameSampler';
import { CELL } from '../shared/geometry';
import { machine_kind } from '../src/protocol/kinds';
import { YOUR_FIRST_LINE as LESSON } from '../src/tutorial/lessons/yourFirstLine';
import type { HintRect } from '../src/chrome/tutorial/TutorialLayer';
import type { Stage } from '../src/tutorial/types';
import {
  continueLesson,
  dragByHand,
  hintsForStage,
  openLessonsFromHelp,
  pointInRect,
  pressPointByHand,
  probeAtStage,
  readProbe,
  startLesson,
  walkLesson,
} from './support/lessonRunner';
import {
  cameraOf,
  expectRenderLoopAlive,
  readScene,
  resetToDemo,
  restoreHostAfterFailedTest,
  screenCellCentre,
  waitForAppReady,
  watchPageErrors,
} from './support/oracle';

// lesson-variants.walk.ts - the same lesson under hands the generated walk doesn't have: a belt drawn
// backwards, a click that means nothing, machines placed out of order, a board paused at the wrong
// moment. Each test takes a ring's rect from `hintsForStage` and names the stage it expects.

/** Drawn frames for a stage to follow a press. */
const STAGE_FRAMES = 20;
/** Sim ticks a press has had to land after two rises of the counter. */
const TWO_RISES_TICKS = 4;

test.afterEach(async ({ page }, testInfo) => {
  await restoreHostAfterFailedTest(page, testInfo);
});

/** From the demo, through Help and Lessons, onto the lesson's empty board. */
async function startFromDemo(page: Page): Promise<void> {
  await page.goto('/');
  await waitForAppReady(page);
  await resetToDemo(page);
  await openLessonsFromHelp(page);
  await startLesson(page, LESSON);
}

function stageNamed(stepIndex: number, id: string): Stage {
  const stage = LESSON.steps[stepIndex]?.stages.find((s) => s.id === id);
  if (stage === undefined) throw new Error(`step ${stepIndex + 1} has no stage ${id}`);
  return stage;
}

/** Wait until the app shows this stage. It moves a frame after the press, and `hintsForStage` won't wait across stages. */
async function reachStage(page: Page, stepIndex: number, id: string): Promise<void> {
  await expect
    .poll(async () => (await probeAtStage(page, stepIndex, id)) !== null, {
      message: `step ${stepIndex + 1} reached stage ${id}`,
      timeout: frameBudgetMs(STAGE_FRAMES),
    })
    .toBe(true);
}

/** Both rects of a stage the test expects to be on now. */
async function ringsAt(page: Page, stepIndex: number, id: string): Promise<{ hint: HintRect; hintTo: HintRect | null }> {
  const rects = await hintsForStage(page, LESSON, stepIndex, stageNamed(stepIndex, id));
  if (rects === null) throw new Error(`step ${stepIndex + 1}: the app left stage ${id}`);
  return rects;
}

/** The world cell under a share of the viewport, and that cell's centre on screen. */
async function cellUnder(page: Page, across: number, down: number): Promise<readonly [number, number]> {
  const view = page.viewportSize();
  if (view === null) throw new Error('the page has no viewport');
  const cam = await cameraOf(page);
  const size = CELL * cam.scale;
  return [Math.floor((view.width * across - cam.x) / size), Math.floor((view.height * down - cam.y) / size)];
}

async function waitTwoTickRises(page: Page): Promise<void> {
  const tick0 = (await readScene(page)).tick;
  await expect
    .poll(async () => (await readScene(page)).tick, {
      message: 'the board kept ticking, so a press has had time to land',
      timeout: tickBudgetMs(TWO_RISES_TICKS) + frameBudgetMs(STAGE_FRAMES),
    })
    .toBeGreaterThanOrEqual(tick0 + 2);
}

const PLACE_SOURCE = LESSON.steps.findIndex((s) => s.id === 'place-source');
const DRAW_BELT = LESSON.steps.findIndex((s) => s.id === 'draw-belt');

test('a belt drawn from the Sink back to the Source finishes the same step', async ({ page }) => {
  const errors = watchPageErrors(page);
  await startFromDemo(page);
  await walkLesson(page, LESSON, { until: 'draw-belt' });

  await reachStage(page, DRAW_BELT, 'belt-tool');
  const tool = await ringsAt(page, DRAW_BELT, 'belt-tool');
  await pressPointByHand(page, pointInRect(tool.hint, { x: -6, y: 3 }));

  await reachStage(page, DRAW_BELT, 'belt-draw');
  const rings = await ringsAt(page, DRAW_BELT, 'belt-draw');
  if (rings.hintTo === null) throw new Error('belt-draw reported no release ring');
  // The other way round from the rings' order: press at the Sink's input, release at the Source's
  // output. The Sink's input faces west and a press only starts a belt on the free cell outside the
  // dot, so the press lands on the ring's west half and the release on the east half of the other.
  await dragByHand(page, pointInRect(rings.hintTo, { x: -3, y: 2 }), pointInRect(rings.hint, { x: 2, y: -3 }));

  await expect
    .poll(async () => (await readProbe(page)).stepIndex, {
      message: 'a belt drawn from the Sink finished draw-belt',
      timeout: frameBudgetMs(STAGE_FRAMES),
    })
    .toBeGreaterThan(DRAW_BELT);

  const probe = await readProbe(page);
  const scene = await readScene(page);
  const belt = scene.belts.find((b) => b.id === probe.bound.belt);
  expect(belt, 'the lesson bound the belt it asked for').toBeDefined();
  const kindAtEnd = (end: string): number | undefined => {
    const dock = belt?.docks.find((d) => d.end === end);
    return scene.nodes.find((n) => n.id === dock?.node)?.kind;
  };
  const tailKind = kindAtEnd('Tail');
  const headKind = kindAtEnd('Head');
  console.log(`MEASURE reversed-belt docks=${tailKind === machine_kind.SOURCE ? 'Source' : tailKind},${headKind === machine_kind.SINK ? 'Sink' : headKind}`);
  expect(tailKind, "the belt's Tail docks the Source").toBe(machine_kind.SOURCE);
  expect(headKind, "the belt's Head docks the Sink").toBe(machine_kind.SINK);

  // The arrival check, on a belt drawn this way.
  await continueLesson(page, LESSON, { from: 'press-play' });
  expect((await readProbe(page)).card, 'the lesson finished').toBe('finished');
  await expectRenderLoopAlive(page, 'after the reversed belt');
  errors.assertNone('during the reversed belt');
});

test('a click finishes nothing, and a Sink placed first waits for its step', async ({ page }) => {
  const errors = watchPageErrors(page);
  await startFromDemo(page);

  // A press on the free floor with no tool armed.
  const empty = await cellUnder(page, 0.55, 0.45);
  const emptyAt = await screenCellCentre(page, empty[0], empty[1]);
  const before = await readProbe(page);
  await pressPointByHand(page, { x: emptyAt.x + 4, y: emptyAt.y + 6 });
  await waitTwoTickRises(page);
  const after = await readProbe(page);
  expect(after.stepIndex, 'the click finished no step').toBe(before.stepIndex);
  expect(after.stageId, 'the click moved no stage').toBe(before.stageId);
  expect((await readScene(page)).nodes, 'the click placed nothing').toEqual([]);

  // A Sink first. The stage stays source-tool, because its condition is that the Source tool isn't armed,
  // so the ring is on the Source row and there's no floor ring to go by: the test picks its own cell.
  await page.getByRole('button', { name: 'Place Sink', exact: true }).click();
  const sinkAt = await screenCellCentre(page, empty[0], empty[1]);
  await pressPointByHand(page, { x: sinkAt.x - 3, y: sinkAt.y + 5 });
  await expect
    .poll(async () => (await readScene(page)).nodes.map((n) => n.kind), {
      message: 'the Sink reached the board',
      timeout: frameBudgetMs(STAGE_FRAMES),
    })
    .toEqual([machine_kind.SINK]);
  await waitTwoTickRises(page);
  const withSink = await readProbe(page);
  expect(withSink.stepIndex, 'the Sink finished nothing: step 1 asks for a Source').toBe(0);
  expect(withSink.stageId, 'and the ring is still on the Source row').toBe('source-tool');

  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Place Source', exact: true }).click();
  const sourceAt = await screenCellCentre(page, empty[0], empty[1] + 2);
  await pressPointByHand(page, { x: sourceAt.x + 6, y: sourceAt.y - 3 });

  // The step index leaves 0 for 2 in one read.
  await expect
    .poll(async () => (await readProbe(page)).stepIndex, {
      message: 'the Source landed',
      timeout: frameBudgetMs(STAGE_FRAMES),
    })
    .not.toBe(0);
  expect((await readProbe(page)).stepId, 'the waiting Sink finished its step with the Source').toBe('set-timer');
  await expect(page.locator('[data-fab-step-card]'), 'the note says so').toContainText('Step 2 was already done, so the lesson moved on.');
  await expectRenderLoopAlive(page, 'after the machines placed out of order');
  errors.assertNone('during the machines placed out of order');
});

test('a paused board sends the user to Play', async ({ page }) => {
  const errors = watchPageErrors(page);
  await startFromDemo(page);

  await page.locator('header button[aria-label="Pause"]').click();
  await reachStage(page, PLACE_SOURCE, 'board-paused');
  const { hint } = await ringsAt(page, PLACE_SOURCE, 'board-paused');
  const play = await page.locator('header button[aria-label="Play"]').boundingBox();
  if (play === null) throw new Error('the Play button has no box');
  const off = Math.max(
    Math.abs(hint.x + hint.width / 2 - (play.x + play.width / 2)),
    Math.abs(hint.y + hint.height / 2 - (play.y + play.height / 2)),
  );
  expect(off, 'the ring sits on the Play button').toBeLessThanOrEqual(1);

  const tick0 = (await readScene(page)).tick;
  await pressPointByHand(page, pointInRect(hint, { x: 4, y: 5 }));
  await reachStage(page, PLACE_SOURCE, 'source-tool');
  await expect
    .poll(async () => (await readScene(page)).tick, {
      message: 'Play set the board running',
      timeout: tickBudgetMs(TWO_RISES_TICKS) + frameBudgetMs(STAGE_FRAMES),
    })
    .toBeGreaterThan(tick0);
  await expectRenderLoopAlive(page, 'after Play');
  errors.assertNone('during the paused board');
});
