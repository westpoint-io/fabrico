import { expect, test, type Page } from '@playwright/test';
import { addWaitBudget, frameBudgetMs, tickBudgetMs } from '../e2e/support/frameSampler';
import { CELL } from '../shared/geometry';
import { machine_kind } from '../src/protocol/kinds';
import { lineDoorstep } from '../src/tutorial/check';
import { YOUR_FIRST_LINE as LESSON } from '../src/tutorial/lessons/yourFirstLine';
import { phrasePlain } from '../src/tutorial/phrase';
import type { HintRect } from '../src/chrome/tutorial/TutorialLayer';
import type { Stage } from '../src/tutorial/types';
import {
  continueLesson,
  dragAlongByHand,
  dragByHand,
  hintsForStage,
  inputsSent,
  openLessonsFromHelp,
  pointInRect,
  pressPointByHand,
  pressShortcut,
  probeAtStage,
  readProbe,
  readRecord,
  startLesson,
  stepOnce,
  walkLesson,
} from './support/lessonRunner';
import { resumeIfPaused, transport } from './support/beltBoard';
import {
  cameraOf,
  expectRenderLoopAlive,
  pollScene,
  readScene,
  resetToDemo,
  restoreHostAfterFailedTest,
  screenCellCentre,
  targetRingsPlotted,
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
/** Sim ticks for the first item to reach the Sink on a redrawn line, as the runner allows on its watch stage. */
const ARRIVAL_TICKS = 200;
/** Drawn frames the page may take to see the echoed belt and send its Docks, as parity.walk.ts allows. */
const DOCKS_SENT_FRAMES = 8;
/**
 * Sim ticks a paused host may run on before it stops: `MAX_SETTLE_TICKS` (512, `sim_loop.rs`), plus 64
 * for the fold and the round trip, as `EDIT_VERDICT_TICKS` in oracle.ts allows.
 */
const HOST_SETTLE_TICKS = 512 + 64;

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

/** Step 4 with the Belt tool armed, the plain drag's rings, and where the bound machines stand. */
async function armedForTheBelt(page: Page): Promise<{
  rings: { hint: HintRect; hintTo: HintRect };
  sourceId: number;
  sinkId: number;
  source: readonly [number, number];
  sink: readonly [number, number];
}> {
  await startFromDemo(page);
  await walkLesson(page, LESSON, { until: 'draw-belt' });
  await reachStage(page, DRAW_BELT, 'belt-tool');
  const tool = await ringsAt(page, DRAW_BELT, 'belt-tool');
  await pressPointByHand(page, pointInRect(tool.hint, { x: -6, y: 3 }));
  await reachStage(page, DRAW_BELT, 'belt-draw');
  const { hint, hintTo } = await ringsAt(page, DRAW_BELT, 'belt-draw');
  if (hintTo === null) throw new Error('belt-draw reported no release ring');
  const { bound } = await readProbe(page);
  const { nodes } = await readScene(page);
  const source = nodes.find((n) => n.id === bound.source)?.cells[0] as readonly [number, number] | undefined;
  const sink = nodes.find((n) => n.id === bound.sink)?.cells[0] as readonly [number, number] | undefined;
  if (source === undefined || sink === undefined) throw new Error('the bound machines are not both on the board');
  expect(sink[1], 'the two machines share a row, so these belts lie where the test says').toBe(source[1]);
  return { rings: { hint, hintTo }, sourceId: bound.source as number, sinkId: bound.sink as number, source, sink };
}

/** The card a stuck belt gets, with no ring: nothing on the board can start the way on. */
async function expectUndoCard(page: Page, what: string): Promise<void> {
  await reachStage(page, DRAW_BELT, 'belt-undo');
  const text = phrasePlain(stageNamed(DRAW_BELT, 'belt-undo').text);
  await expect(page.locator('[data-fab-step-card]'), `${what}: the card says to undo it, and names the key`).toContainText(text);
  expect((await readProbe(page)).hint, `${what}: no ring marks a press that can't work`).toBeNull();
}

/**
 * Press the key the card names until the belt has gone. Undo takes the belt's docks back first, so the
 * first press leaves the belt on the board with no docks, and the plain drag would still be refused. The
 * card has to stay up for that, so this reads it again after the press.
 */
async function undoTheBelt(page: Page, beltsAfter: number, what: string): Promise<void> {
  const before = (await readScene(page)).belts.length;
  await pressShortcut(page, 'undo');
  await expect
    .poll(async () => (await readScene(page)).belts.filter((b) => b.docks.length === 0).length, {
      message: `${what}: the first press took the docks back`,
      timeout: frameBudgetMs(STAGE_FRAMES),
    })
    .toBe(1);
  expect((await readScene(page)).belts, `${what}: the belt is still on the board`).toHaveLength(before);
  await waitTwoTickRises(page);
  await expectUndoCard(page, `${what}, after one press`);
  await pressShortcut(page, 'undo');
  await expect
    .poll(async () => (await readScene(page)).belts.length, {
      message: `${what}: the second press took the belt`,
      timeout: frameBudgetMs(STAGE_FRAMES),
    })
    .toBe(beltsAfter);
}

/** A good draw must never flash the undo card, in the packets before its docks arrive. */
async function expectNoUndoCardSeen(page: Page, what: string): Promise<void> {
  const seen = (await readRecord(page)).filter((e) => e.stageId === 'belt-undo');
  expect(seen, `${what}: the card never asked for Undo`).toEqual([]);
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
  await expectNoUndoCardSeen(page, 'the reversed belt');

  // The arrival check, on a belt drawn this way.
  await continueLesson(page, LESSON, { from: 'press-play' });
  expect((await readProbe(page)).card, 'the lesson finished').toBe('finished');
  await expectRenderLoopAlive(page, 'after the reversed belt');
  errors.assertNone('during the reversed belt');
});

test('a line drawn in two pieces finishes the same step', async ({ page }) => {
  const errors = watchPageErrors(page);
  await startFromDemo(page);
  await walkLesson(page, LESSON, { until: 'draw-belt' });

  await reachStage(page, DRAW_BELT, 'belt-tool');
  const tool = await ringsAt(page, DRAW_BELT, 'belt-tool');
  await pressPointByHand(page, pointInRect(tool.hint, { x: -6, y: 3 }));

  await reachStage(page, DRAW_BELT, 'belt-draw');
  const rings = await ringsAt(page, DRAW_BELT, 'belt-draw');
  if (rings.hintTo === null) throw new Error('belt-draw reported no release ring');
  const before = await readProbe(page);
  const board = await readScene(page);
  const source = board.nodes.find((n) => n.id === before.bound.source)?.cells[0] as readonly [number, number] | undefined;
  const sink = board.nodes.find((n) => n.id === before.bound.sink)?.cells[0] as readonly [number, number] | undefined;
  if (source === undefined || sink === undefined) throw new Error('the bound machines are not both on the board');
  expect(sink[1], 'the two machines share a row, so a straight piece stops short between them').toBe(source[1]);

  // The first piece stops two cells past the Source's doorstep, short of the Sink.
  const shortCell = [source[0] + 3, source[1]] as const;
  const shortAt = await screenCellCentre(page, shortCell[0], shortCell[1]);
  await dragByHand(page, pointInRect(rings.hint, { x: 3, y: -2 }), { x: shortAt.x + 3, y: shortAt.y - 2 });
  await expect
    .poll(async () => (await readScene(page)).belts.length, {
      message: 'the first piece reached the board',
      timeout: frameBudgetMs(STAGE_FRAMES),
    })
    .toBe(1);
  await waitTwoTickRises(page);
  const held = await readProbe(page);
  expect(held.stepIndex, 'a piece that stops short finishes nothing').toBe(DRAW_BELT);

  // The card stops asking for the drag the host refuses: one ring, on the Sink's input, and words that
  // send the hand to the end of the belt already drawn.
  await reachStage(page, DRAW_BELT, 'belt-carry-on');
  const carryOn = stageNamed(DRAW_BELT, 'belt-carry-on');
  await expect(page.locator('[data-fab-step-card]'), 'the card names the end of the belt').toContainText(phrasePlain(carryOn.text));
  const into = await ringsAt(page, DRAW_BELT, 'belt-carry-on');
  expect(into.hintTo, 'one ring: the belt end wears the app\'s own').toBeNull();
  expect(into.hint.x + into.hint.width / 2, 'the ring is the one the plain drag let go on').toBeCloseTo(rings.hintTo.x + rings.hintTo.width / 2, 0);
  expect(into.hint.y + into.hint.height / 2, 'on both axes').toBeCloseTo(rings.hintTo.y + rings.hintTo.height / 2, 0);
  expect(lineDoorstep(await readScene(page), before.bound.source as number), 'the end the card names is the free cell past the short piece').toEqual([shortCell[0] + 1, shortCell[1]]);

  // The pointer hasn't moved since the release, and the rings already match the card: one on the belt's
  // end, and no filled one left on the doorstep the press came from. The runner reads the end's ring off
  // the screen when it carries on below.
  const endRing = { x: (shortCell[0] + 1) * CELL + CELL / 2, y: shortCell[1] * CELL + CELL / 2, filled: false };
  await expect
    .poll(async () => (await targetRingsPlotted(page)).resting.filter((r) => r.filled || r.x === endRing.x), {
      message: 'with the pointer at rest, the rings show the belt end and no grabbed ring',
      timeout: frameBudgetMs(STAGE_FRAMES),
    })
    .toEqual([endRing]);

  // The runner drives this stage from its gesture, so a walk reaching it can finish the lesson.
  await continueLesson(page, LESSON, { from: 'draw-belt' });
  expect((await readProbe(page)).card, 'the lesson finished').toBe('finished');

  const probe = await readProbe(page);
  const scene = await readScene(page);
  expect(scene.belts, 'the line is two belts').toHaveLength(2);
  const last = scene.belts.find((b) => b.id === probe.bound.belt);
  const first = scene.belts.find((b) => b.id !== probe.bound.belt);
  console.log(`MEASURE two-piece-docks first=${JSON.stringify(first?.docks)} last=${JSON.stringify(last?.docks)}`);
  expect(last?.docks.find((d) => d.end === 'Head')?.node, 'the bound piece runs into the Sink').toBe(probe.bound.sink);
  expect(last?.docks.find((d) => d.end === 'Tail')?.node, 'and follows the first piece').toBe(first?.id);
  expect(first?.docks.find((d) => d.end === 'Tail')?.node, 'which leaves the Source').toBe(probe.bound.source);
  expect(first?.docks.find((d) => d.end === 'Head')?.node, 'and runs into the second piece').toBe(last?.id);
  await expectNoUndoCardSeen(page, 'the line in two pieces');
  await expectRenderLoopAlive(page, 'after the line in two pieces');
  errors.assertNone('during the line in two pieces');
});

test('a click on the output ring, or a drag let go too early, gets the undo card and the lesson still finishes', async ({ page }) => {
  const errors = watchPageErrors(page);
  const { rings, sourceId } = await armedForTheBelt(page);
  // The ring's east half is the Source's doorstep, where a press seeds a belt on that one cell.
  const press = pointInRect(rings.hint, { x: 3, y: -2 });

  await pressPointByHand(page, press);
  await expectUndoCard(page, 'after the click');
  const clicked = (await readScene(page)).belts;
  console.log(`MEASURE stuck-click belts=${JSON.stringify(clicked.map((b) => ({ tiles: b.tiles.length, docks: b.docks })))}`);
  expect(clicked, 'the click drew one belt').toHaveLength(1);
  expect(clicked[0]?.tiles, 'of one tile').toHaveLength(1);
  expect(clicked[0]?.docks.find((d) => d.end === 'Tail')?.node, 'docked to the Source').toBe(sourceId);

  await undoTheBelt(page, 0, 'the click');
  await reachStage(page, DRAW_BELT, 'belt-draw');

  await dragByHand(page, press, { x: press.x + 2, y: press.y + 1 });
  await expectUndoCard(page, 'after the drag let go on its first cell');
  await undoTheBelt(page, 0, 'the early release');
  await reachStage(page, DRAW_BELT, 'belt-draw');

  await continueLesson(page, LESSON, { from: 'draw-belt', undone: true });
  expect((await readProbe(page)).card, 'the lesson finished').toBe('finished');
  await expectRenderLoopAlive(page, 'after the stuck click');
  errors.assertNone('during the stuck click');
});

test('a click on the ring at a free end gets the undo card, and Undo goes back to carrying on', async ({ page }) => {
  const errors = watchPageErrors(page);
  const { rings, sourceId, source } = await armedForTheBelt(page);
  const shortAt = await screenCellCentre(page, source[0] + 3, source[1]);
  await dragByHand(page, pointInRect(rings.hint, { x: 3, y: -2 }), { x: shortAt.x + 3, y: shortAt.y - 2 });
  await reachStage(page, DRAW_BELT, 'belt-carry-on');

  const door = lineDoorstep(await readScene(page), sourceId);
  if (door === null) throw new Error('the short piece has no free end');
  const doorAt = await screenCellCentre(page, door[0], door[1]);
  await pressPointByHand(page, { x: doorAt.x + 3, y: doorAt.y - 2 });
  await expectUndoCard(page, 'after the click on the free end');
  const clicked = (await readScene(page)).belts;
  console.log(`MEASURE stuck-free-end belts=${JSON.stringify(clicked.map((b) => ({ tiles: b.tiles.length, docks: b.docks })))}`);
  expect(clicked.map((b) => b.tiles.length).sort(), 'the click drew a second piece of one tile').toEqual([1, 3]);

  await undoTheBelt(page, 1, 'the second piece');
  await reachStage(page, DRAW_BELT, 'belt-carry-on');

  await continueLesson(page, LESSON, { from: 'draw-belt', undone: true });
  expect((await readProbe(page)).card, 'the lesson finished').toBe('finished');
  await expectRenderLoopAlive(page, 'after the click on the free end');
  errors.assertNone('during the click on the free end');
});

test('a short piece drawn backwards from the Sink gets the undo card and the lesson still finishes', async ({ page }) => {
  const errors = watchPageErrors(page);
  const { rings, sinkId, sink } = await armedForTheBelt(page);
  // Pressed on the ring's west half, the Sink's doorstep, and let go two cells short of the Source's.
  const stopAt = await screenCellCentre(page, sink[0] - 3, sink[1]);
  await dragByHand(page, pointInRect(rings.hintTo, { x: -3, y: 2 }), { x: stopAt.x + 3, y: stopAt.y - 2 });
  await expectUndoCard(page, 'after the backward piece');
  const drawn = (await readScene(page)).belts;
  console.log(`MEASURE stuck-backward belts=${JSON.stringify(drawn.map((b) => ({ tiles: b.tiles.length, docks: b.docks })))}`);
  expect(drawn, 'one belt').toHaveLength(1);
  expect(drawn[0]?.docks.find((d) => d.end === 'Head')?.node, 'running into the Sink').toBe(sinkId);
  expect(drawn[0]?.docks.find((d) => d.end === 'Tail'), 'with nothing behind it').toBeUndefined();

  await undoTheBelt(page, 0, 'the backward piece');
  await reachStage(page, DRAW_BELT, 'belt-draw');

  await continueLesson(page, LESSON, { from: 'draw-belt', undone: true });
  expect((await readProbe(page)).card, 'the lesson finished').toBe('finished');
  await expectRenderLoopAlive(page, 'after the backward piece');
  errors.assertNone('during the backward piece');
});

test('a belt brought down onto the top of the Sink gets the undo card, because no ring can show at its end', async ({ page }) => {
  const errors = watchPageErrors(page);
  const { rings, sourceId, source, sink } = await armedForTheBelt(page);
  // Up off the output's doorstep, along two rows above, then down to stop on the cell over the Sink.
  const handOn = async (x: number, y: number): Promise<{ x: number; y: number }> => {
    const at = await screenCellCentre(page, x, y);
    return { x: at.x + 3, y: at.y - 2 };
  };
  await dragAlongByHand(page, [
    pointInRect(rings.hint, { x: 3, y: -2 }),
    await handOn(source[0] + 1, source[1] - 2),
    await handOn(sink[0], source[1] - 2),
    await handOn(sink[0], sink[1] - 1),
  ]);
  await expectUndoCard(page, 'after the belt onto the Sink');
  const scene = await readScene(page);
  const drawn = scene.belts[0];
  console.log(`MEASURE stuck-blocked belts=${JSON.stringify(scene.belts.map((b) => ({ tiles: b.tiles.map((t) => [t.cell_x, t.cell_y]), docks: b.docks })))}`);
  expect(scene.belts, 'one belt').toHaveLength(1);
  expect(drawn?.docks.find((d) => d.end === 'Head'), 'that docked to nothing at its end').toBeUndefined();
  expect(lineDoorstep(scene, sourceId), "the belt's next cell is the Sink").toEqual([sink[0], sink[1]]);

  await undoTheBelt(page, 0, 'the belt onto the Sink');
  await reachStage(page, DRAW_BELT, 'belt-draw');
  await continueLesson(page, LESSON, { from: 'draw-belt', undone: true });
  expect((await readProbe(page)).card, 'the lesson finished').toBe('finished');
  await expectRenderLoopAlive(page, 'after the belt onto the Sink');
  errors.assertNone('during the belt onto the Sink');
});

/** The lesson has moved past the belt step on this line. */
async function expectPastTheBelt(page: Page, what: string): Promise<void> {
  await expect
    .poll(async () => (await readProbe(page)).stepIndex, {
      message: `${what} finished draw-belt`,
      timeout: frameBudgetMs(STAGE_FRAMES),
    })
    .toBeGreaterThan(DRAW_BELT);
}

/*
 * The three tests below press Undo on a finished line, and on a running board that press races the
 * first item. A full first piece puts the front item one tile from the Sink, about 6 ticks, and a single
 * belt puts it about 30 ticks away. A finished lesson keeps its card and ignores Undo, which is the
 * product's rule (the Finish row in UI-SPEC), so the Undo has to land before any item arrives. So these
 * tests hold the board before the last draw. On a held board only Step moves the sim, and the Undo folds
 * before an item can reach the Sink. The undo card is still read after Play, on a running board.
 *
 * A paused host doesn't stop at once. It keeps ticking with Timer fires held until no belt holds an
 * item, and stops after `MAX_SETTLE_TICKS` (512) regardless. The first piece of the two-piece line ends
 * short of the Sink, so once items are on it they never leave and the host runs all 512 ticks: about 18 s
 * at the 28 ticks a second the budget helpers assume, longer than `pauseAndSettle`'s 10 s in
 * beltBoard.ts. So these tests hold the board with `holdTheBoard`, which waits on the same still tick
 * under a cap derived from that bound. No item reaches the Sink while the host drains, because the
 * second piece isn't drawn until it has stopped.
 *
 * The check that a good draw never shows the undo card can't fail while the board is held, because the
 * paused stage comes first in draw-belt's stage list. So it lives on the running-board draws in the
 * reversed-belt and two-piece tests, on the first piece of the two-piece Undo test, and in the
 * generated walk's record rule.
 */

/**
 * Pause from the toolbar and wait until two reads 200 ms apart see the same tick, under the host's own
 * settle bound. Answers the tick the host stopped on.
 */
async function holdTheBoard(page: Page, what: string): Promise<number> {
  await transport(page).click();
  await expect(transport(page), `${what}: the sim is paused (the toggle offers Play)`).toHaveAttribute('aria-label', 'Play');
  let pausedAt = -1;
  await expect
    .poll(
      async () => {
        const t = (await readScene(page)).tick;
        const settled = t === pausedAt;
        pausedAt = t;
        return settled;
      },
      {
        message: `${what}: the host stopped ticking`,
        intervals: [200],
        timeout: addWaitBudget(tickBudgetMs(HOST_SETTLE_TICKS), `${what}: the paused host draining its belts`),
      },
    )
    .toBe(true);
  return pausedAt;
}

/**
 * Hold the board, make the last draw on it, and move the sim only by Step: one to mint the belt and one
 * to dock both ends. The lesson leaves draw-belt and is still running. Answers the tick the hold began on.
 */
async function finishOnHeldBoard(page: Page, draw: () => Promise<void>, beltsAfter: number, what: string): Promise<number> {
  await expect(transport(page), `${what}: the board is playing before the hold`).toHaveAttribute('aria-label', 'Pause');
  const pausedAt = await holdTheBoard(page, `${what}: hold the board`);
  await reachStage(page, DRAW_BELT, 'board-paused');
  await expect(page.getByTitle(/^Draw belts/), `${what}: the Belt tool is still armed on the held board`).toHaveAttribute('aria-pressed', 'true');

  const sentBefore = await inputsSent(page);
  await draw();
  await expect
    .poll(() => inputsSent(page), {
      message: `${what}: the page sent the draw`,
      timeout: addWaitBudget(frameBudgetMs(STAGE_FRAMES), `${what}: the draw leaving the page`),
    })
    .toBe(sentBefore + 1);
  await stepOnce(page, `${what}: mint the belt`);
  await pollScene(page, (s) => s.belts.length, { message: `${what}: the belt was echoed after its one Step` }).toBe(beltsAfter);
  await expect
    .poll(() => inputsSent(page), {
      message: `${what}: the page sent both Docks once the belt was echoed`,
      timeout: addWaitBudget(frameBudgetMs(DOCKS_SENT_FRAMES), `${what}: the Docks leaving the page`),
    })
    .toBe(sentBefore + 3);
  await stepOnce(page, `${what}: dock both belt ends`);
  await expectPastTheBelt(page, what);

  const probe = await readProbe(page);
  const scene = await readScene(page);
  expect(probe.card, `${what}: the lesson is still running, so the Undo lands on a finished line and not a finished lesson`).toBe('running');
  expect(scene.tick, `${what}: the held board moved only by its two Steps`).toBe(pausedAt + 2);
  const intoSink = scene.belts.find((b) => b.docks.some((d) => d.end === 'Head' && d.node === probe.bound.sink));
  const sinkSlot = intoSink?.occupiedSlots[0] ?? 'none';
  console.log(`MEASURE held-line what=${what} paused=${pausedAt} tick=${scene.tick} step=${probe.stepId} card=${probe.card} sink_slot=${sinkSlot}`);
  return pausedAt;
}

/**
 * One press on a finished line, on the held board. The page sends the Undo, one Step folds it, and the
 * lesson goes back to the belt step while it still reads running. Then Play, and the undo card is read on
 * a running board, because what the press left stays there until the next press.
 */
async function undoOnHeldBoard(page: Page, pausedAt: number, what: string): Promise<void> {
  const sent = await inputsSent(page);
  await pressShortcut(page, 'undo');
  await expect
    .poll(() => inputsSent(page), {
      message: `${what}: the page sent the Undo`,
      timeout: addWaitBudget(frameBudgetMs(STAGE_FRAMES), `${what}: the Undo leaving the page`),
    })
    .toBe(sent + 1);
  await stepOnce(page, `${what}: fold the Undo`);
  await expect
    .poll(async () => (await readProbe(page)).stepIndex, {
      message: `${what}: Undo took the lesson back to draw-belt`,
      timeout: frameBudgetMs(STAGE_FRAMES),
    })
    .toBe(DRAW_BELT);
  expect((await readProbe(page)).card, `${what}: the lesson is still running after the Undo`).toBe('running');
  expect((await readScene(page)).tick, `${what}: the held board moved only by the Undo's Step`).toBe(pausedAt + 3);
  await resumeIfPaused(page);
  await waitTwoTickRises(page);
  await expectUndoCard(page, what);
}

/**
 * The plain drag from the current rings, then the rest of the lesson by hand. The runner's record rule
 * reads a step going back as a fault, and these tests go back on purpose.
 */
async function redrawAndFinish(page: Page, what: string): Promise<void> {
  await reachStage(page, DRAW_BELT, 'belt-draw');
  const again = await ringsAt(page, DRAW_BELT, 'belt-draw');
  if (again.hintTo === null) throw new Error('belt-draw reported no release ring');
  await dragByHand(page, pointInRect(again.hint, { x: 3, y: -2 }), pointInRect(again.hintTo, { x: -2, y: 3 }));
  await expectPastTheBelt(page, `the plain drag after ${what}`);
  await expectLessonFinishes(page, what);
}

async function expectLessonFinishes(page: Page, what: string): Promise<void> {
  await expect
    .poll(async () => (await readProbe(page)).card, {
      message: `${what}: an item reached the Sink and the lesson finished`,
      timeout: addWaitBudget(tickBudgetMs(ARRIVAL_TICKS) + frameBudgetMs(STAGE_FRAMES), 'the first item riding the redrawn line'),
    })
    .toBe('finished');
}

test('one Undo on a finished belt asks for Undo until the belt has gone, and the plain drag then works', async ({ page }) => {
  const errors = watchPageErrors(page);
  const { rings, sourceId, sinkId } = await armedForTheBelt(page);
  const pausedAt = await finishOnHeldBoard(
    page,
    () => dragByHand(page, pointInRect(rings.hint, { x: 3, y: -2 }), pointInRect(rings.hintTo, { x: -2, y: 3 })),
    1,
    'the plain drag',
  );
  await undoOnHeldBoard(page, pausedAt, 'after one press');
  const [left] = (await readScene(page)).belts;
  console.log(`MEASURE undone-once docks=${JSON.stringify(left?.docks)}`);
  expect(left?.docks.find((d) => d.end === 'Tail')?.node, 'the belt still leaves the Source').toBe(sourceId);
  expect(left?.docks.find((d) => d.node === sinkId), 'and has let go of the Sink').toBeUndefined();

  await undoTheBelt(page, 0, 'the belt with its Tail docked');
  await redrawAndFinish(page, 'the undone belt');
  await expectRenderLoopAlive(page, 'after the undone belt');
  errors.assertNone('during the undone belt');
});

test('Undo on a finished line of two pieces asks for Undo until the second piece has gone, then to carry on', async ({ page }) => {
  const errors = watchPageErrors(page);
  const { rings, sourceId, source } = await armedForTheBelt(page);
  const shortAt = await screenCellCentre(page, source[0] + 3, source[1]);
  await dragByHand(page, pointInRect(rings.hint, { x: 3, y: -2 }), { x: shortAt.x + 3, y: shortAt.y - 2 });
  await reachStage(page, DRAW_BELT, 'belt-carry-on');
  const into = await ringsAt(page, DRAW_BELT, 'belt-carry-on');
  const carryOn = async (): Promise<void> => {
    const door = lineDoorstep(await readScene(page), sourceId);
    if (door === null) throw new Error('the short piece has no free end');
    const doorAt = await screenCellCentre(page, door[0], door[1]);
    await dragByHand(page, { x: doorAt.x + 3, y: doorAt.y - 2 }, pointInRect(into.hint, { x: -2, y: 3 }));
  };
  await expectNoUndoCardSeen(page, 'the first piece, drawn on the running board');
  const pausedAt = await finishOnHeldBoard(page, carryOn, 2, 'the second piece');
  await undoOnHeldBoard(page, pausedAt, 'after one press on the line');
  console.log(`MEASURE undone-line belts=${JSON.stringify((await readScene(page)).belts.map((b) => ({ tiles: b.tiles.length, docks: b.docks })))}`);
  expect((await readScene(page)).belts, 'both pieces are still on the board').toHaveLength(2);

  await undoTheBelt(page, 1, 'the second piece');
  await reachStage(page, DRAW_BELT, 'belt-carry-on');
  await carryOn();
  await expectPastTheBelt(page, 'the second piece, drawn again');
  await expectLessonFinishes(page, 'the line drawn again');
  await expectRenderLoopAlive(page, 'after the undone line');
  errors.assertNone('during the undone line');
});

test('one Undo on a belt drawn from the Sink asks for Undo until the belt has gone', async ({ page }) => {
  const errors = watchPageErrors(page);
  const { rings } = await armedForTheBelt(page);
  const pausedAt = await finishOnHeldBoard(
    page,
    () => dragByHand(page, pointInRect(rings.hintTo, { x: -3, y: 2 }), pointInRect(rings.hint, { x: 2, y: -3 })),
    1,
    'the reversed belt',
  );
  await undoOnHeldBoard(page, pausedAt, 'after one press on the reversed belt');
  console.log(`MEASURE undone-reversed docks=${JSON.stringify((await readScene(page)).belts[0]?.docks)}`);

  await undoTheBelt(page, 0, 'the reversed belt');
  await redrawAndFinish(page, 'the undone reversed belt');
  await expectRenderLoopAlive(page, 'after the undone reversed belt');
  errors.assertNone('during the undone reversed belt');
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
