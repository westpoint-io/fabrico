import { expect, test, type Page } from '@playwright/test';
import { addWaitBudget, frameBudgetMs, tickBudgetMs } from '../e2e/support/frameSampler';
import { CELL } from '../shared/geometry';
import type { HintRect, TutorialProbe } from '../src/chrome/tutorial/TutorialLayer';
import { doorstepCell, dropHitRadiusWorld, unitDelta } from '../src/protocol/ports';
import { YOUR_FIRST_LINE as LESSON } from '../src/tutorial/lessons/yourFirstLine';
import type { Stage } from '../src/tutorial/types';
import { MAX_ZOOM } from '../src/render/camera';
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
  handPath,
  pointerTravel,
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
//
// The last two tests are the off-screen flag and Show me on the real host (HINT-03). A ring outside the
// free area makes the card say so, and Show me moves the camera and nothing else. Each reads the board
// and the toolbar's Undo and Redo buttons before the press and checks them over the ticks after it,
// before it looks at the camera or the rings, so a Show me that changes the board fails there.

/** The device scale a 1080p laptop panel at 118% gives, where a CSS px is not a whole device px. */
const DPR = 1.18;
/** Drawn frames for a stage to follow a press, a wheel notch or a release. */
const STAGE_FRAMES = 20;
/** Sim ticks for a released belt to come back from the host with its docks. */
const DOCK_TICKS = 30;
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
const PLACE_SINK = LESSON.steps.findIndex((s) => s.id === 'place-sink');

test.use({ deviceScaleFactor: DPR });

test.afterEach(async ({ page }, testInfo) => {
  await restoreHostAfterFailedTest(page, testInfo);
});

function stageNamed(id: string, stepIndex = DRAW_BELT): Stage {
  const stage = LESSON.steps[stepIndex]?.stages.find((s) => s.id === id);
  if (stage === undefined) throw new Error(`${LESSON.steps[stepIndex]?.id} has no stage ${id}`);
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

/**
 * Watch the board for `ticks` sim ticks after a release, or until a belt docks on the Sink's In, and
 * return the scene that ended the watch. A belt reaches the board before its docks do, so a read a few
 * ticks after the release can miss a dock that is on its way. The outside drop is watched for as long
 * as the inside drop is given to dock.
 */
async function watchForDock(page: Page, ticks: number, sinkId: number, inIndex: number): Promise<{ docked: boolean; scene: SceneFacts }> {
  const tick0 = (await readScene(page)).tick;
  let last: SceneFacts | null = null;
  await expect
    .poll(
      async () => {
        last = await readScene(page);
        if (dockedOnIn(last, sinkId, inIndex)) return 'docked';
        return last.tick >= tick0 + ticks ? 'quiet' : 'watching';
      },
      {
        message: `the board kept ticking for ${ticks} ticks after the release`,
        timeout: tickBudgetMs(ticks) + frameBudgetMs(STAGE_FRAMES),
      },
    )
    .not.toBe('watching');
  const scene = last as SceneFacts | null;
  if (scene === null) throw new Error('the watch read no scene');
  return { docked: dockedOnIn(scene, sinkId, inIndex), scene };
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
  const { docked, scene: after } = await watchForDock(page, DOCK_TICKS, sink.id, into.index);
  expect(docked, `a drop ${dist.toFixed(1)} px from the dot (${outside.side}) docked a belt on the Sink's In`).toBe(false);
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

// --- HINT-03 on the real host: the off-screen flag and Show me ---

const CARD = '[data-fab-step-card]';
const ROW = `${CARD} [data-fab-offscreen-row]`;
const SHOW_ME = `${ROW} button`;
/** Sim ticks the board is watched for after Show me. An Undo's answer comes back well inside this. */
const HOLD_TICKS = 30;
/** The `machine_kind` byte that `KIND_NAMES` calls Sink. */
const SINK_KIND = 7;

type Free = { left: number; right: number; top: number; bottom: number };

/**
 * The free area by the rule `readFreeArea` in TutorialLayer.tsx uses, worked out again from the page:
 * right of the palette dock, left of the window less 24 and the inspector's reserve of
 * `min(420, 33vw) + 52`, under 116 px, and above the card.
 */
async function freeAreaOf(page: Page): Promise<Free> {
  return page.evaluate(() => {
    const dock = document.querySelector('[data-fab-left-dock]');
    const card = document.querySelector('[data-fab-step-card]');
    return {
      left: dock === null ? 0 : dock.getBoundingClientRect().right,
      right: window.innerWidth - 24 - (Math.min(420, 0.33 * window.innerWidth) + 2 * 22 + 8),
      top: 116,
      bottom: card === null ? window.innerHeight : card.getBoundingClientRect().top,
    };
  });
}

const insideFree = (r: HintRect, f: Free): boolean => r.x >= f.left && r.x + r.width <= f.right && r.y >= f.top && r.y + r.height <= f.bottom;
const sharesFree = (r: HintRect, f: Free): boolean =>
  Math.min(r.x + r.width, f.right) > Math.max(r.x, f.left) && Math.min(r.y + r.height, f.bottom) > Math.max(r.y, f.top);

/**
 * The board's layout and history as the scene holds it: machines, belts with their docks, wires, and
 * whether Undo and Redo have anything. The tick, item counts and machine states move on their own on a
 * running board, so they are left out; an Undo, a placement or a dock changes what is kept.
 */
function layoutOf(scene: SceneFacts): string {
  return JSON.stringify({
    canUndo: scene.canUndo,
    canRedo: scene.canRedo,
    nodes: scene.nodes.map((n) => ({ id: n.id, kind: n.kind, cells: n.cells, ports: n.ports, label: n.label })),
    belts: scene.belts.map((b) => ({ id: b.id, tiles: b.tiles, docks: b.docks })),
    wires: scene.wires.map((w) => ({ id: w.id, from: w.from, to: w.to, path: w.path })),
  });
}

/** The toolbar's Undo and Redo buttons as a person sees them: enabled or not, and the title. */
async function undoButtonsOf(page: Page): Promise<string> {
  return page.evaluate(() =>
    JSON.stringify(
      ['Undo', 'Redo'].map((name) => {
        const b = document.querySelector<HTMLButtonElement>(`header button[aria-label="${name}"]`);
        return b === null ? null : { name, disabled: b.disabled, title: b.title };
      }),
    ),
  );
}

/**
 * Press Show me by hand, then check the board and the Undo and Redo buttons stay as they were for
 * `HOLD_TICKS` ticks. Nothing about the camera or the rings is read here, so a Show me that changes
 * the board fails on this check whatever else it does.
 */
async function pressShowMeAndHoldBoard(page: Page, what: string): Promise<void> {
  const box = await page.locator(SHOW_ME).boundingBox();
  if (box === null) throw new Error(`${what}: Show me has no box on screen`);
  const before = await readScene(page);
  const layout = layoutOf(before);
  const buttons = await undoButtonsOf(page);
  await pressPointByHand(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
  let changed: string | null = null;
  await expect
    .poll(
      async () => {
        const now = await readScene(page);
        const was = layoutOf(now);
        if (was !== layout) {
          changed = was;
          return 'changed';
        }
        return now.tick >= before.tick + HOLD_TICKS ? 'held' : 'watching';
      },
      { message: `${what}: the board ran ${HOLD_TICKS} ticks after Show me`, timeout: tickBudgetMs(HOLD_TICKS) + frameBudgetMs(STAGE_FRAMES) },
    )
    .not.toBe('watching');
  expect(changed ?? layout, `${what}: the board and its Undo history are as they were before Show me`).toBe(layout);
  expect(await undoButtonsOf(page), `${what}: the toolbar's Undo and Redo buttons are as they were before Show me`).toBe(buttons);
}

/** The card's flag, the row and its line, read together until they agree on `on`. */
async function expectCardFlag(page: Page, on: boolean, what: string): Promise<void> {
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const card = document.querySelector('[data-fab-step-card]');
          const row = card?.querySelector<HTMLElement>('[data-fab-offscreen-row]') ?? null;
          return {
            flag: card?.getAttribute('data-fab-offscreen') ?? null,
            row: row === null ? null : getComputedStyle(row).visibility,
            line: row?.textContent?.includes('The ring is out of view.') ?? false,
          };
        }),
      { message: `${what}: the card's data-fab-offscreen, the row's visibility and its line`, timeout: frameBudgetMs(STAGE_FRAMES) },
    )
    .toEqual({ flag: on ? 'true' : 'false', row: on ? 'visible' : 'hidden', line: true });
}

/**
 * The probe's rings for `stageId` once they are painted under the camera as it stands: two drawn
 * frames inside one read, with the camera the same before and after them.
 */
async function ringsUnderCamera(page: Page, stepIndex: number, stageId: string): Promise<{ hint: HintRect; hintTo: HintRect | null; scale: number }> {
  let held: { hint: HintRect; hintTo: HintRect | null; scale: number } | null = null;
  await expect
    .poll(
      async () => {
        const read = await page.evaluate(async () => {
          const hook = (window as unknown as { __fabrico: { tutorial(): TutorialProbe; camera(): { x: number; y: number; scale: number } } }).__fabrico;
          const cam = hook.camera();
          for (let i = 0; i < 2; i++) await new Promise((r) => requestAnimationFrame(() => r(undefined)));
          return { probe: hook.tutorial(), cam, now: hook.camera() };
        });
        if (read.probe.stepIndex !== stepIndex || read.probe.stageId !== stageId) return 'left';
        if (read.cam.x !== read.now.x || read.cam.y !== read.now.y || read.cam.scale !== read.now.scale) return 'moving';
        if (read.probe.hint === null) return 'moving';
        held = { hint: read.probe.hint, hintTo: read.probe.hintTo, scale: read.now.scale };
        return 'held';
      },
      { message: `the ${stageId} rings painted under a still camera`, timeout: frameBudgetMs(STAGE_FRAMES) },
    )
    .toBe('held');
  return held as unknown as { hint: HintRect; hintTo: HintRect | null; scale: number };
}

/** A middle-button drag on the board by `(dx, dy)` from `from`, the way a hand pans. */
async function panByHand(page: Page, from: Pt, dx: number, dy: number): Promise<void> {
  const tag = await page.evaluate((p) => document.elementFromPoint(p.x, p.y)?.tagName ?? null, from);
  expect(tag, 'the pan starts on the board, not on a panel').toBe('CANVAS');
  const before = await cameraOf(page);
  await pointerTravel(page, from.x, from.y);
  await page.mouse.down({ button: 'middle' });
  for (const p of handPath(from, { x: from.x + dx, y: from.y + dy })) await pointerTravel(page, p.x, p.y);
  await page.mouse.up({ button: 'middle' });
  await expect
    .poll(
      async () => {
        const cam = await cameraOf(page);
        return Math.max(Math.abs(cam.x - before.x - dx), Math.abs(cam.y - before.y - dy));
      },
      { message: `the middle drag panned the board by (${dx}, ${dy})`, timeout: frameBudgetMs(STAGE_FRAMES) },
    )
    .toBeLessThanOrEqual(TOLERANCE_PX);
}

async function toLesson(page: Page, until: string): Promise<ReturnType<typeof watchPageErrors>> {
  const errors = watchPageErrors(page);
  await page.goto('/');
  await waitForAppReady(page);
  expect(await page.evaluate(() => window.devicePixelRatio), 'the page runs at device scale 1.18').toBeCloseTo(DPR, 5);
  await resetToDemo(page);
  await openLessonsFromHelp(page);
  await startLesson(page, LESSON);
  await walkLesson(page, LESSON, { until });
  return errors;
}

test('a Sink spot under the palette reads out of view, and Show me brings it back', async ({ page }) => {
  const errors = await toLesson(page, 'place-sink');

  // 1. Zoom to about 2 at the Source, while the Sink tool is still in the palette, so the Sink's spot
  // is worked out at this zoom. Six cells east is past the free area's right edge there, so it goes
  // six cells west, under the palette.
  const tool = await hintsForStage(page, LESSON, PLACE_SINK, stageNamed('sink-tool', PLACE_SINK));
  if (tool === null) throw new Error('place-sink: the app left the sink-tool stage');
  const { bound } = await readProbe(page);
  const source = (await readScene(page)).nodes.find((n) => n.id === bound.source);
  if (source === undefined) throw new Error('the bound Source is not on the board');
  const [sc] = source.cells;
  if (sc === undefined) throw new Error('the Source has no cell');
  const scale = await zoomInto(page, await screenCellCentre(page, sc[0], sc[1]), 1.9, 2.1);
  await pressPointByHand(page, pointInRect(tool.hint, { x: -6, y: 3 }));

  // 2. The floor ring, out of the free area. If it lands inside, pan it out to the left by hand.
  let ring = (await ringsUnderCamera(page, PLACE_SINK, 'sink-floor')).hint;
  let free = await freeAreaOf(page);
  let how = 'under-palette';
  if (sharesFree(ring, free)) {
    how = 'panned';
    const from = { x: (free.left + free.right) / 2, y: free.top + 0.75 * (free.bottom - free.top) };
    await panByHand(page, from, Math.round(free.left - (ring.x + ring.width) - 20), 0);
    ring = (await ringsUnderCamera(page, PLACE_SINK, 'sink-floor')).hint;
    free = await freeAreaOf(page);
  }
  console.log(`MEASURE showme-floor zoom=${scale.toFixed(3)} ring-x=${ring.x.toFixed(1)} free-left=${free.left.toFixed(1)} how=${how}`);
  expect(sharesFree(ring, free), 'the Sink floor ring is out of the free area').toBe(false);
  await expectCardFlag(page, true, 'with the Sink floor ring out of view');

  // 3. Show me by hand: the board and the Undo buttons first, then the ring and the row.
  await pressShowMeAndHoldBoard(page, 'the floor stage');
  const after = await ringsUnderCamera(page, PLACE_SINK, 'sink-floor');
  free = await freeAreaOf(page);
  expect(insideFree(after.hint, free), 'after Show me the Sink floor ring is inside the free area').toBe(true);
  await expectCardFlag(page, false, 'after Show me');

  // 4. The ring pressed by hand places the Sink, and the step moves on.
  const sinks = (await readScene(page)).nodes.filter((n) => n.kind === SINK_KIND).length;
  await pressPointByHand(page, pointInRect(after.hint, { x: -6, y: 3 }));
  await expect
    .poll(async () => (await readScene(page)).nodes.filter((n) => n.kind === SINK_KIND).length, {
      message: 'the press on the floor ring placed a Sink',
      timeout: tickBudgetMs(DOCK_TICKS) + frameBudgetMs(STAGE_FRAMES),
    })
    .toBe(sinks + 1);
  await expect
    .poll(async () => (await readProbe(page)).stepIndex, { message: 'the placed Sink moved the lesson past place-sink', timeout: frameBudgetMs(STAGE_FRAMES) })
    .toBeGreaterThan(PLACE_SINK);

  await expectRenderLoopAlive(page, 'after Show me on the floor stage');
  errors.assertNone('during Show me on the floor stage');
});

test('after Show me zooms out, the next drop on the disc docks', async ({ page }) => {
  const errors = await toLesson(page, 'draw-belt');
  await reachStage(page, 'belt-tool');
  const { sink, out, into } = await boundMachines(page);
  const door = doorstepCell(out);
  const inDoor = doorstepCell(into);

  // 1. Zoom to about 1 between the machines, so the start is the same whatever zoom the walk left,
  // then to 4 at the free area's corner farthest from them, which carries both rings out of it.
  const doorAt = await screenCellCentre(page, door[0], door[1]);
  const inDoorAt = await screenCellCentre(page, inDoor[0], inDoor[1]);
  // The wheel keeps the point under the pointer still, so the machines' midpoint stays where it was.
  const mid = { x: (doorAt.x + inDoorAt.x) / 2, y: (doorAt.y + inDoorAt.y) / 2 };
  await zoomInto(page, mid, 0.9, 1.1);
  const free = await freeAreaOf(page);
  const corners = [
    { x: free.left + 12, y: free.top + 12 },
    { x: free.right - 12, y: free.top + 12 },
    { x: free.left + 12, y: free.bottom - 12 },
    { x: free.right - 12, y: free.bottom - 12 },
  ];
  const far = corners.reduce((a, b) => (Math.hypot(b.x - mid.x, b.y - mid.y) > Math.hypot(a.x - mid.x, a.y - mid.y) ? b : a));
  const before = await zoomInto(page, far, 3.9, MAX_ZOOM);

  // 2. The Belt's palette ring, so the belt-draw stage begins at zoom 4 with both rings out of view.
  const tool = await ringsAt(page, 'belt-tool');
  await pressPointByHand(page, pointInRect(tool.hint, { x: -6, y: 3 }));
  await reachStage(page, 'belt-draw');
  const out4 = await ringsUnderCamera(page, DRAW_BELT, 'belt-draw');
  if (out4.hintTo === null) throw new Error('belt-draw reported no drop ring');
  const free4 = await freeAreaOf(page);
  expect(out4.scale, 'the belt-draw stage began at zoom 4').toBe(before);
  expect(sharesFree(out4.hint, free4), 'the doorstep square is out of the free area').toBe(false);
  expect(sharesFree(out4.hintTo, free4), 'the drop disc is out of the free area').toBe(false);
  await expectCardFlag(page, true, 'with both belt-draw rings out of view at zoom 4');

  // 3. Show me by hand: the board and the Undo buttons first, then the camera and the rings.
  await pressShowMeAndHoldBoard(page, 'the belt-draw stage at zoom 4');
  const shown = await ringsUnderCamera(page, DRAW_BELT, 'belt-draw');
  console.log(`MEASURE showme zoom-before=${before.toFixed(3)} zoom-after=${shown.scale.toFixed(3)}`);
  expect(shown.scale, 'Show me zoomed out from 4').toBeLessThan(before);
  const freeNow = await freeAreaOf(page);
  const disc = shown.hintTo;
  if (disc === null || disc.hitCentre === undefined || disc.hitRadiusPx === undefined) throw new Error('the drop disc reports no hit circle after Show me');
  expect(insideFree(shown.hint, freeNow), 'after Show me the doorstep square is inside the free area').toBe(true);
  expect(insideFree(disc, freeNow), 'after Show me the drop disc is inside the free area').toBe(true);
  await expectCardFlag(page, false, 'after Show me at the belt-draw stage');
  expect(
    Math.abs(disc.hitRadiusPx - dropHitRadiusWorld(shown.scale) * shown.scale),
    `the disc's hit radius after Show me is the release's at zoom ${shown.scale.toFixed(3)}, in CSS px`,
  ).toBeLessThanOrEqual(TOLERANCE_PX);

  // 4. Straight away, a drop 1 px inside the hit circle on the Sink's body side docks on the Sink's In.
  const step = CELL * shown.scale;
  const body: [number, number] = [-unitDelta(into.side)[0], -unitDelta(into.side)[1]];
  const inside = along(disc.hitCentre, body, disc.hitRadiusPx - INSIDE_MARGIN_PX);
  expect(inRect(inside, await cellRect(page, inDoor)), 'the inside drop is off the doorstep tile').toBe(false);
  const pressAt = await screenCellCentre(page, door[0], door[1]);
  const start = { x: pressAt.x + 0.2 * step, y: pressAt.y - 0.15 * step };
  expect(inRect(start, await cellRect(page, door)), 'the press lands inside the doorstep cell').toBe(true);
  await dragByHand(page, start, inside);
  await expect
    .poll(async () => dockedOnIn(await readScene(page), sink.id, into.index), {
      message: `a drop ${(disc.hitRadiusPx - INSIDE_MARGIN_PX).toFixed(1)} px from the dot after Show me docked a belt on the Sink's In`,
      timeout: tickBudgetMs(DOCK_TICKS) + frameBudgetMs(STAGE_FRAMES),
    })
    .toBe(true);
  await expect
    .poll(async () => (await readProbe(page)).stepIndex, { message: 'the docked belt moved the lesson past draw-belt', timeout: frameBudgetMs(STAGE_FRAMES) })
    .toBeGreaterThan(DRAW_BELT);

  await expectRenderLoopAlive(page, 'after Show me and the drop');
  errors.assertNone('during Show me and the drop');
});
