import { expect, test, type Page } from '@playwright/test';
import { addWaitBudget, frameBudgetMs, tickBudgetMs } from '../e2e/support/frameSampler';
import { CELL } from '../shared/geometry';
import type { HintRect } from '../src/chrome/tutorial/TutorialLayer';
import { doorstepCell, dropHitRadiusWorld, unitDelta } from '../src/protocol/ports';
import { YOUR_FIRST_LINE as LESSON } from '../src/tutorial/lessons/yourFirstLine';
import type { Stage } from '../src/tutorial/types';
import {
  dragByHand,
  hintsForStage,
  openLessonsFromHelp,
  pointInRect,
  pressPointByHand,
  pressShortcut,
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
  type SceneFacts,
} from './support/oracle';

// lesson-hints.walk.ts - the drop disc is the spot a belt release docks in, on the real host (HINT-02).
//
// The lesson draws the ring where a drag ends as a disc whose inner edge is the release's hit circle.
// Each test drops a belt just outside that disc, where the host must not dock it, and then just inside,
// where it must, at device scale 1.18 and at one of two zooms (the radius formula changes at zoom 1).
// The points come from the probe's `hitCentre` and `hitRadiusPx`, the disc as painted this frame, so a
// disc drawn bigger than the hit circle sends the inside drop past it and the test fails there.
//
// The outside drop never lands on the Sink's In doorstep tile, because a release whose head is on that
// tile docks by auto-dock wherever the hand is. It goes into the Sink's body first and sideways only
// when that point breaks a rule, and each run logs the side it used.

/** The device scale a 1080p laptop panel at 118% gives, where a CSS px is not a whole device px. */
const DPR = 1.18;
/** Drawn frames for a stage to follow a press, a wheel notch or a release. */
const STAGE_FRAMES = 20;
/** Sim ticks for a released belt to come back from the host with its docks. */
const DOCK_TICKS = 30;
/** Sim ticks a release has had to land before its absence is read: four rises of the counter. */
const SETTLE_TICKS = 4;
/**
 * One wheel notch, sent with Control held. At device scale 1.18 Chromium hands the page a wheel's deltaY
 * divided by the scale (60 arrives as 50.847), and the camera reads a fractional delta as a trackpad
 * scroll and pans. Control makes the camera zoom whatever the delta. A notch moves the scale by about
 * e^0.076 here, narrower than either zoom range, so the loop can't step over one.
 */
const WHEEL_NOTCH = 60;
/** How far outside the hit circle the outside drop lands at least, in CSS px (CONTEXT "Hint size"). */
const OUTSIDE_MARGIN_PX = 2;
/** How far inside the hit circle the inside drop lands, in CSS px. */
const INSIDE_MARGIN_PX = 1;
/** How far a painted radius may sit from the gesture's own, in CSS px. */
const TOLERANCE_PX = 1;

const DRAW_BELT = LESSON.steps.findIndex((s) => s.id === 'draw-belt');

test.use({ deviceScaleFactor: DPR });

test.afterEach(async ({ page }, testInfo) => {
  await restoreHostAfterFailedTest(page, testInfo);
});

function stageNamed(id: string): Stage {
  const stage = LESSON.steps[DRAW_BELT]?.stages.find((s) => s.id === id);
  if (stage === undefined) throw new Error(`draw-belt has no stage ${id}`);
  return stage;
}

async function reachStage(page: Page, id: string): Promise<void> {
  await expect
    .poll(async () => (await probeAtStage(page, DRAW_BELT, id)) !== null, {
      message: `draw-belt reached stage ${id}`,
      timeout: frameBudgetMs(STAGE_FRAMES),
    })
    .toBe(true);
}

async function ringsAt(page: Page, id: string): Promise<{ hint: HintRect; hintTo: HintRect | null }> {
  const rects = await hintsForStage(page, LESSON, DRAW_BELT, stageNamed(id));
  if (rects === null) throw new Error(`draw-belt: the app left stage ${id}`);
  return rects;
}

type Pt = { x: number; y: number };
type Rect = { left: number; top: number; right: number; bottom: number };

const inRect = (p: Pt, r: Rect): boolean => p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom;

/** A world cell's square on screen. */
async function cellRect(page: Page, cell: readonly [number, number]): Promise<Rect> {
  const c = await screenCellCentre(page, cell[0], cell[1]);
  const half = (CELL * (await cameraOf(page)).scale) / 2;
  return { left: c.x - half, top: c.y - half, right: c.x + half, bottom: c.y + half };
}

/** The bound Source and Sink, with the Source's Out and the Sink's In as the host reports them. */
async function boundMachines(page: Page) {
  const { bound } = await readProbe(page);
  const scene = await readScene(page);
  const source = scene.nodes.find((n) => n.id === bound.source);
  const sink = scene.nodes.find((n) => n.id === bound.sink);
  const out = source?.ports.find((p) => p.role === 1);
  const into = sink?.ports.find((p) => p.role === 0);
  if (source === undefined || sink === undefined || out === undefined || into === undefined) {
    throw new Error('the bound Source and Sink, with an Out and an In, are not both on the board');
  }
  return { source, sink, out, into };
}

/** Wheel at `at` one Control-held notch at a time until the scale reads in `[lo, hi]`. */
async function zoomInto(page: Page, at: Pt, lo: number, hi: number): Promise<number> {
  const tag = await page.evaluate((p) => document.elementFromPoint(p.x, p.y)?.tagName ?? null, at);
  expect(tag, 'the wheel lands on the board, not on a panel').toBe('CANVAS');
  await page.mouse.move(at.x, at.y);
  for (let notch = 0; notch < 40; notch++) {
    const { scale } = await cameraOf(page);
    if (scale >= lo && scale <= hi) return scale;
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, scale > hi ? WHEEL_NOTCH : -WHEEL_NOTCH);
    await page.keyboard.up('Control');
    await expect
      .poll(async () => (await cameraOf(page)).scale, { message: 'the wheel notch moved the zoom', timeout: frameBudgetMs(STAGE_FRAMES) })
      .not.toBe(scale);
  }
  throw new Error(`the zoom never reached [${lo}, ${hi}]`);
}

/** Does any belt hold a Head dock on the Sink's In? */
function dockedOnIn(scene: SceneFacts, sinkId: number, inIndex: number): boolean {
  return scene.belts.some((b) => b.docks.some((d) => d.end === 'Head' && d.node === sinkId && d.port === inIndex));
}

/** Wait for the board's tick to rise `ticks` times, so a release has had time to come back from the host. */
async function waitTicks(page: Page, ticks: number): Promise<void> {
  const tick0 = (await readScene(page)).tick;
  await expect
    .poll(async () => (await readScene(page)).tick, {
      message: 'the board kept ticking, so the release has had time to land',
      timeout: tickBudgetMs(ticks) + frameBudgetMs(STAGE_FRAMES),
    })
    .toBeGreaterThanOrEqual(tick0 + ticks);
}

/** Press the Undo key by hand until the board holds no belt. Undo takes a belt's docks back before the belt. */
async function undoEveryBelt(page: Page, what: string): Promise<void> {
  for (let press = 0; press < 4; press++) {
    const scene = await readScene(page);
    if (scene.belts.length === 0) return;
    const before = JSON.stringify(scene.belts.map((b) => [b.id, b.docks.length]));
    await pressShortcut(page, 'undo');
    await expect
      .poll(async () => JSON.stringify((await readScene(page)).belts.map((b) => [b.id, b.docks.length])), {
        message: `${what}: Undo press ${press + 1} changed the belts`,
        timeout: addWaitBudget(frameBudgetMs(STAGE_FRAMES), 'one Undo press'),
      })
      .not.toBe(before);
  }
  expect((await readScene(page)).belts, `${what}: Undo took every belt`).toEqual([]);
}

/** The point at `dist` from `from` along `dir`. */
const along = (from: Pt, dir: readonly [number, number], dist: number): Pt => ({ x: from.x + dir[0] * dist, y: from.y + dir[1] * dist });

const SIDE_NAMES = ['north', 'east', 'south', 'west'] as const;

async function dropTest(page: Page, lo: number, hi: number): Promise<void> {
  const errors = watchPageErrors(page);
  await page.goto('/');
  await waitForAppReady(page);
  expect(await page.evaluate(() => window.devicePixelRatio), 'the page runs at device scale 1.18').toBeCloseTo(DPR, 5);
  await resetToDemo(page);
  await openLessonsFromHelp(page);
  await startLesson(page, LESSON);
  await walkLesson(page, LESSON, { until: 'draw-belt' });

  // 1. The Belt tool's ring, pressed by hand.
  await reachStage(page, 'belt-tool');
  const tool = await ringsAt(page, 'belt-tool');
  await pressPointByHand(page, pointInRect(tool.hint, { x: -6, y: 3 }));
  await reachStage(page, 'belt-draw');

  // 2. The zoom, by the wheel, at the floor between the two machines.
  const { source, sink, out, into } = await boundMachines(page);
  const door = doorstepCell(out);
  const inDoor = doorstepCell(into);
  const doorAt = await screenCellCentre(page, door[0], door[1]);
  const inDoorAt = await screenCellCentre(page, inDoor[0], inDoor[1]);
  const scale = await zoomInto(page, { x: (doorAt.x + inDoorAt.x) / 2, y: (doorAt.y + inDoorAt.y) / 2 }, lo, hi);
  console.log(`MEASURE disc zoom=${scale.toFixed(3)} dpr=${DPR}`);

  // 3. The rings at belt-draw: a square around the Source's doorstep cell, and a disc on the Sink's In.
  const rings = await ringsAt(page, 'belt-draw');
  const disc = rings.hintTo;
  if (disc === null) throw new Error('belt-draw reported no drop ring');
  expect(rings.hint.shape, 'the press ring is a square').toBe('square');
  expect(disc.shape, 'the drop ring is a disc').toBe('circle');
  if (disc.hitCentre === undefined || disc.hitRadiusPx === undefined) throw new Error('the drop disc reports no hit circle');
  const doorRect = await cellRect(page, door);
  const outset = (rings.hint.width - (doorRect.right - doorRect.left)) / 2;
  expect(
    Math.max(Math.abs(rings.hint.x + outset - doorRect.left), Math.abs(rings.hint.y + outset - doorRect.top), Math.abs(outset - 4)),
    "the press square sits on the Source's doorstep cell, 4 px out each side",
  ).toBeLessThanOrEqual(TOLERANCE_PX);
  const centre = disc.hitCentre;
  const hitR = disc.hitRadiusPx;

  // 4. The outside drop: at least the hit radius plus 2 px from the centre, off the Sink's In doorstep
  // tile, where auto-dock would take it, and off the Source. The Sink's body first, then sideways.
  const inDoorRect = await cellRect(page, inDoor);
  const sourceRects = await Promise.all(source.cells.map((c) => cellRect(page, c)));
  const outward = unitDelta(into.side);
  const body: [number, number] = [-outward[0], -outward[1]];
  const sideways: Array<{ side: string; dir: [number, number] }> = [
    { side: SIDE_NAMES[(into.side + 1) & 3], dir: [-outward[1], outward[0]] },
    { side: SIDE_NAMES[(into.side + 3) & 3], dir: [outward[1], -outward[0]] },
  ];
  const candidates = [{ side: 'body', dir: body }, ...sideways];
  const step = CELL * scale;
  let outside: { side: string; point: Pt; dist: number } | null = null;
  for (const c of candidates) {
    for (let dist = hitR + OUTSIDE_MARGIN_PX; dist <= hitR + OUTSIDE_MARGIN_PX + step; dist += 1) {
      const point = along(centre, c.dir, dist);
      if (!inRect(point, inDoorRect) && !sourceRects.some((r) => inRect(point, r))) {
        outside = { side: c.side, point, dist };
        break;
      }
    }
    if (outside !== null) break;
  }
  if (outside === null) throw new Error('no point outside the disc is off the doorstep tile and the Source');
  const dist = Math.hypot(outside.point.x - centre.x, outside.point.y - centre.y);
  expect(dist, 'the outside drop is at least 2 px past the hit circle').toBeGreaterThanOrEqual(hitR + OUTSIDE_MARGIN_PX - 0.01);
  expect(inRect(outside.point, inDoorRect), "the outside drop is off the Sink's In doorstep tile").toBe(false);
  expect(sourceRects.some((r) => inRect(outside.point, r)), "the outside drop is off the Source").toBe(false);
  console.log(`MEASURE disc-outside zoom=${scale.toFixed(3)} side=${outside.side} dist=${dist.toFixed(2)}`);

  // The press: off the square's centre and inside the doorstep cell, read from the cell and not from
  // the ring, because pointInRect clamps to the middle half of a rect.
  const pressAt = await screenCellCentre(page, door[0], door[1]);
  const start = { x: pressAt.x + 0.2 * step, y: pressAt.y - 0.15 * step };
  expect(inRect(start, doorRect), 'the press lands inside the doorstep cell').toBe(true);
  await dragByHand(page, start, outside.point);
  await waitTicks(page, SETTLE_TICKS);
  const after = await readScene(page);
  expect(dockedOnIn(after, sink.id, into.index), `a drop ${dist.toFixed(1)} px from the dot (${outside.side}) docked a belt on the Sink's In`).toBe(false);
  const held = await readProbe(page);
  console.log(
    `MEASURE disc-outside-result zoom=${scale.toFixed(3)} stage=${held.stageId} belts=${JSON.stringify(after.belts.map((b) => ({ tiles: b.tiles.length, docks: b.docks })))}`,
  );
  expect(held.stepId, 'the outside drop leaves the lesson on draw-belt').toBe('draw-belt');
  await undoEveryBelt(page, 'after the outside drop');
  await reachStage(page, 'belt-draw');

  // 5. The inside drop: 1 px inside the hit circle on the Sink's side, past the doorstep tile, so
  // auto-dock on that tile can't rescue a miss.
  const again = await ringsAt(page, 'belt-draw');
  const disc2 = again.hintTo;
  if (disc2 === null || disc2.hitCentre === undefined || disc2.hitRadiusPx === undefined) throw new Error('belt-draw lost its drop disc');
  const inside = along(disc2.hitCentre, body, disc2.hitRadiusPx - INSIDE_MARGIN_PX);
  expect(inRect(inside, await cellRect(page, inDoor)), 'the inside drop is off the doorstep tile').toBe(false);
  const pressAgain = await screenCellCentre(page, door[0], door[1]);
  await dragByHand(page, { x: pressAgain.x + 0.2 * step, y: pressAgain.y - 0.15 * step }, inside);
  await expect
    .poll(async () => dockedOnIn(await readScene(page), sink.id, into.index), {
      message: `a drop ${(disc2.hitRadiusPx - INSIDE_MARGIN_PX).toFixed(1)} px from the dot, inside the disc, docked a belt on the Sink's In`,
      timeout: tickBudgetMs(DOCK_TICKS) + frameBudgetMs(STAGE_FRAMES),
    })
    .toBe(true);
  await expect
    .poll(async () => (await readProbe(page)).stepIndex, {
      message: 'the docked belt moved the lesson past draw-belt',
      timeout: frameBudgetMs(STAGE_FRAMES),
    })
    .toBeGreaterThan(DRAW_BELT);

  // The disc as painted is the release's own circle at this zoom.
  expect(Math.abs(hitR - dropHitRadiusWorld(scale) * scale), "the disc's hit radius is the release's, in CSS px").toBeLessThanOrEqual(TOLERANCE_PX);

  // 6. Render health.
  await expectRenderLoopAlive(page, `after the disc drops at zoom ${scale.toFixed(2)}`);
  errors.assertNone(`during the disc drops at zoom ${scale.toFixed(2)}`);
}

test('the drop disc docks inside and not outside, zoom at or below 1', async ({ page }) => {
  await dropTest(page, 0.9, 1.0);
});

test('the drop disc docks inside and not outside, zoom near 2', async ({ page }) => {
  await dropTest(page, 1.9, 2.1);
});
