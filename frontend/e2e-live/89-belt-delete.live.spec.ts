import { test, expect, type Page } from '@playwright/test';
import { addWaitBudget, frameBudgetMs } from '../e2e/support/frameSampler';
import {
  DRAWN_STATE_FRAMES,
  applyConfig,
  cameraOf,
  clickAt,
  expectRenderLoopAlive,
  fillPanelField,
  handDragBetween,
  nodeAtAnchor,
  nubAnchor,
  pollScene,
  pressSegment,
  readScene,
  restoreHostAfterFailedTest,
  screenPoint,
  selectMachineAt,
  waitForAppReady,
  watchPageErrors,
  type SceneFacts,
} from './support/oracle';
import { doorstep, portOf, beltOn, rowCells, cellPoint, emptyBoardAtScaleOne, place, turnUntilFacing, deselectOnFloor, zoomBelowOne, treadRotationAt } from './support/beltBoard';

// 89-belt-delete.live.spec.ts (phase 89, plan 89-06, BELT-02, success criterion 2, D-07, UI-SPEC
// section 2, walk step 3; 68-UI-SPEC finding 3, which held belt deletion back, is superseded by
// D-07) - a selected belt is deleted by the Delete key and by its panel's `Delete belt` button,
// through the shipped items guard when items are on it, and Ctrl+Z brings it back docked at both
// ends, on the REAL host (dev_render_server, real Core -> RenderProducer -> postcard -> WS). Zero
// mocks, zero injected packets: the machines are placed and turned with the shipped palette and
// `r` key, and the belt is drawn with the shipped Belt tool by a hand drag.
//
// ---------------------------------------------------------------------------
// WHAT WAS BROKEN (89-MEASURE.md `## BELT-02: still broken`)
// ---------------------------------------------------------------------------
//
// The host deletes a belt and undoes it, and the guard dialog has a belt branch, but nothing in
// the app routed a selected belt to a Delete: the Delete key read the node selection only, and the
// belt panel had no delete control.
//
// ---------------------------------------------------------------------------
// THE LEGS, GRADED ON WHAT THE EYE SEES
// ---------------------------------------------------------------------------
//
// Each row: a Source facing East and a Sink facing West, and a belt drawn by a hand drag from the
// Source output's doorstep onto the Sink's input dot, docked at both ends. The belt is selected by
// a click on a middle tile (its panel opens).
//
//   (a) the Delete key removes it: gone from the model and from the canvas (no tread drawn on its
//       middle tile), and no belt panel stays; Ctrl+Z brings it back on the same cells, docked at
//       both ends, its tread drawn again, and the Source's output row and the Sink's input row read
//       `idle`. At zoom 1, then again below 1 on the second row;
//   (b) the same with the panel's `Delete belt` button (`#fab-belt-delete`);
//   (c) on a board that is playing, the Source on a Timer and items on the belt: Delete opens the
//       guard dialog (the belt body copy), sends nothing, Cancel keeps the belt; Delete again and
//       `Delete anyway` removes it;
//   (d) Backspace inside the pace field edits the text only: the belt is still there many ticks
//       later.
//
// RED FIRST (D-16): run once against the plan's start revision (frontend from a throwaway worktree
// with this spec copied in), every leg red but (d), which guards the focused field the new key
// route must respect. 89-EVIDENCE.md, `LIVE_RED 89-belt-delete`.
//
// Render health in every test: `watchPageErrors` before `goto`, `expectRenderLoopAlive` and the
// watcher's `assertNone` after every test (fabrico-model-oracle-blindspot).

/** Wire kinds (kinds.ts). */
const KIND_SOURCE = 0;
const KIND_SINK = 7;
/** Port roles (oracle `PortFacts.role`). */
const ROLE_IN = 0;
const ROLE_OUT = 1;
/** Sides, the wire's numbering (y-down). */
const E = 1;
const W = 3;
/** The Timer interval the Source of leg (c) runs on, in sim ticks. */
const FEED_EVERY = 8;
/** Ticks leg (d) waits after the Backspace: far past any Delete's fold. */
const AFTER_KEY_TICKS = 40;

/** A board row: the Source and Sink anchor columns are shared; two floor cells to deselect on. */
interface Row {
  name: string;
  y: number;
  floor: ReadonlyArray<readonly [number, number]>;
}
const SOURCE_X = 8;
const SINK_X = 16;
const ROWS: readonly Row[] = [
  { name: 'at zoom 1', y: 7, floor: [[11, 9], [12, 9]] },
  { name: 'below zoom 1', y: 12, floor: [[11, 14], [12, 14]] },
];

/** `Head@sink,Tail@source` for the belt on `cells`, re-found by cell (an Undo remints ids). */
function docksOn(s: SceneFacts, cells: ReadonlyArray<readonly [number, number]>, y: number): string {
  const belt = beltOn(s, cells);
  if (belt === undefined) return 'no belt on the drawn cells';
  const source = nodeAtAnchor(s, SOURCE_X, y);
  const sink = nodeAtAnchor(s, SINK_X, y);
  return belt.docks
    .map((d) => `${d.end}@${d.node === source?.id ? 'source' : d.node === sink?.id ? 'sink' : d.node}`)
    .sort()
    .join(',');
}

/** Whether the canvas draws a belt tile on `cell`, polled until it reads `drawn`. */
async function expectDrawn(page: Page, cell: readonly [number, number], drawn: boolean, why: string): Promise<void> {
  await expect
    .poll(async () => (await treadRotationAt(page, cell)) !== null, {
      timeout: addWaitBudget(frameBudgetMs(DRAWN_STATE_FRAMES), why),
      intervals: [100, 250, 500],
      message: why,
    })
    .toBe(drawn);
}

/** The live belt selection, read off the page (`window.__fabrico.selectedBelt()`). */
async function selectedBeltOf(page: Page): Promise<number | null> {
  return page.evaluate(
    () => (window as { __fabrico?: { selectedBelt(): number | null } }).__fabrico?.selectedBelt() ?? null,
  );
}

/** Select the belt on `cells` by a click on its middle tile; its panel opens. */
async function selectBelt(page: Page, cells: ReadonlyArray<readonly [number, number]>, what: string): Promise<number> {
  const middle = cells[Math.floor(cells.length / 2)];
  const pt = await cellPoint(page, middle[0], middle[1], 0.45, 0.55);
  await expect
    .poll(() => page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.tagName ?? 'NONE', [pt.x, pt.y] as const), {
      message: `${what}: the belt's middle tile is on the open board before it is clicked`,
    })
    .toBe('CANVAS');
  await clickAt(page, pt.x, pt.y);
  await expect(page.locator('#fab-belt-config'), `${what}: clicking the belt's middle tile opened its panel`).toBeVisible();
  const belt = beltOn(await readScene(page), cells)!;
  expect(await selectedBeltOf(page), `${what}: the selected belt is the one on the drawn cells`).toBe(belt.id);
  return belt.id;
}

/**
 * Build a row: a Source facing East (on a Timer when `feed`) and a Sink facing West, and a belt
 * drawn by a hand drag from the Source output's doorstep onto the Sink's input dot. Returns the
 * belt's cells, Tail first, once both ends are docked.
 */
async function buildRow(page: Page, row: Row, feed: boolean): Promise<Array<[number, number]>> {
  const sourceCell: [number, number] = [SOURCE_X, row.y];
  const sinkCell: [number, number] = [SINK_X, row.y];
  await place(page, 'Source', KIND_SOURCE, sourceCell, row.name);
  await place(page, 'Sink', KIND_SINK, sinkCell, row.name);
  await selectMachineAt(page, ...sourceCell);
  await turnUntilFacing(page, sourceCell, ROLE_OUT, E, `${row.name}: the Source's output`);
  if (feed) {
    await pressSegment(page, 'Trigger', 'Timer');
    await fillPanelField(page, 'fab-timer-interval', String(FEED_EVERY));
    await applyConfig(page);
  }
  await selectMachineAt(page, ...sinkCell);
  await turnUntilFacing(page, sinkCell, ROLE_IN, W, `${row.name}: the Sink's input`);
  await deselectOnFloor(page, row.floor, `${row.name}: after the turns`);
  const s = await readScene(page);
  const outDoor = doorstep(portOf(s, sourceCell, ROLE_OUT)!);
  const sinkIn = portOf(s, sinkCell, ROLE_IN)!;
  const cells = rowCells(outDoor[0], doorstep(sinkIn)[0], row.y);
  await page.getByTitle(/^Draw belts/).click();
  const start = await cellPoint(page, outDoor[0], outDoor[1], 0.4, 0.55);
  const nub = nubAnchor(sinkIn.cell_x, sinkIn.cell_y, sinkIn.side);
  const end = await screenPoint(page, { x: nub.x - 3, y: nub.y + 2 });
  const moves = await handDragBetween(page, start, end);
  await page.keyboard.press('Escape');
  expect(moves, `${row.name}: the belt was drawn through many samples, not one teleport`).toBeGreaterThanOrEqual(10);
  await pollScene(page, (q) => docksOn(q, cells, row.y), {
    message: `${row.name}: the belt on ${JSON.stringify(cells)} is docked to the Source and the Sink`,
  }).toBe('Head@sink,Tail@source');
  return cells;
}

/** Both machines' panels read the belt connected and still: the Source's output and the Sink's input `idle`. */
async function expectMachinesIdle(page: Page, row: Row): Promise<void> {
  const ports = page.getByRole('region', { name: 'Ports' });
  await selectMachineAt(page, SOURCE_X, row.y);
  await expect(ports.getByRole('listitem', { name: /^Output[^,]*, idle$/ }), `${row.name}: the Source's output row reads idle`).toHaveCount(1);
  // The Source's panel can cover the Sink's cell: close it on the floor first.
  await deselectOnFloor(page, row.floor, `${row.name}: after the Source panel`);
  await selectMachineAt(page, SINK_X, row.y);
  await expect(ports.getByRole('listitem', { name: /^Input[^,]*, idle$/ }), `${row.name}: the Sink's input row reads idle`).toHaveCount(1);
  await deselectOnFloor(page, row.floor, `${row.name}: after the machine panels`);
}

/**
 * The belt is gone (model, canvas, no belt panel), then Ctrl+Z brings it back on the same cells,
 * docked at both ends, drawn again, and both machine panels read `idle`.
 */
async function expectGoneThenBackByUndo(page: Page, row: Row, cells: ReadonlyArray<readonly [number, number]>, how: string): Promise<void> {
  const middle = cells[Math.floor(cells.length / 2)];
  await pollScene(page, (s) => beltOn(s, cells) === undefined, {
    message: `${row.name}: ${how} removed the belt from the model`,
  }).toBe(true);
  await expectDrawn(page, middle, false, `${row.name}: ${how} removed the belt from the canvas (no tread on its middle tile)`);
  await expect(page.locator('#fab-belt-config'), `${row.name}: no belt panel stays after ${how}`).toHaveCount(0);
  expect(await selectedBeltOf(page), `${row.name}: no belt is selected after ${how}`).toBeNull();
  await expectRenderLoopAlive(page, `${row.name}: after ${how}`);
  await page.keyboard.press('Control+z');
  await pollScene(page, (s) => docksOn(s, cells, row.y), {
    message: `${row.name}: Ctrl+Z brought the belt back on its cells, docked at both ends`,
  }).toBe('Head@sink,Tail@source');
  await expectDrawn(page, middle, true, `${row.name}: Ctrl+Z drew the belt again (a tread on its middle tile)`);
  expect(await selectedBeltOf(page), `${row.name}: Ctrl+Z does not reselect the belt (UI-SPEC A20)`).toBeNull();
  await expectMachinesIdle(page, row);
  await expectRenderLoopAlive(page, `${row.name}: after the Ctrl+Z`);
}

test.describe('89 live: a selected belt is deleted by key and by its panel, behind the items guard (BELT-02)', () => {
  let errs: ReturnType<typeof watchPageErrors>;

  test.beforeEach(async ({ page }) => {
    errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
  });

  test.afterEach(async ({ page }, testInfo) => {
    try {
      await expectRenderLoopAlive(page, 'at the end of the test');
      errs.assertNone('the belt delete walk');
    } finally {
      await restoreHostAfterFailedTest(page, testInfo);
    }
  });

  test('(a) the Delete key removes a selected belt, and Ctrl+Z brings it back docked, at zoom 1 and below 1', async ({ page }) => {
    const cells = ROWS.flatMap((r) => [[SOURCE_X, r.y] as const, [SINK_X, r.y] as const, ...r.floor]);
    await emptyBoardAtScaleOne(page, cells);
    const belts: Array<Array<[number, number]>> = [];
    for (const row of ROWS) belts.push(await buildRow(page, row, false));
    await expectRenderLoopAlive(page, 'with both rows built');
    for (let i = 0; i < ROWS.length; i += 1) {
      const row = ROWS[i];
      if (i === 0) {
        expect((await cameraOf(page)).scale, `${row.name}: walked at camera scale 1`).toBe(1);
      } else {
        const scale = await zoomBelowOne(page, belts[i][Math.floor(belts[i].length / 2)]);
        console.log(`P89-BELT-02 ${row.name}: camera scale ${scale}`);
      }
      await selectBelt(page, belts[i], row.name);
      await page.keyboard.press('Delete');
      await expectGoneThenBackByUndo(page, row, belts[i], 'the Delete key');
    }
  });

  test("(b) the belt panel's Delete belt button removes it, and Ctrl+Z brings it back docked", async ({ page }) => {
    const row = ROWS[0];
    await emptyBoardAtScaleOne(page, [[SOURCE_X, row.y], [SINK_X, row.y], ...row.floor]);
    const cells = await buildRow(page, row, false);
    await selectBelt(page, cells, row.name);
    const button = page.locator('#fab-belt-delete');
    await expect(button, `${row.name}: the belt panel offers the Delete belt button`).toBeVisible();
    await expect(button, `${row.name}: the button is named Delete belt`).toHaveAccessibleName('Delete belt');
    await button.click();
    await expectGoneThenBackByUndo(page, row, cells, 'the Delete belt button');
  });

  test('(c) a belt carrying items opens the guard: Cancel keeps it, Delete anyway removes it', async ({ page }) => {
    const row = ROWS[0];
    await emptyBoardAtScaleOne(page, [[SOURCE_X, row.y], [SINK_X, row.y], ...row.floor]);
    const cells = await buildRow(page, row, true);
    await pollScene(page, (s) => (beltOn(s, cells)?.items ?? 0) > 0, {
      message: `${row.name}: the playing board put items on the belt`,
      timeout: 20_000,
    }).toBe(true);
    const dialog = page.getByRole('alertdialog');
    await selectBelt(page, cells, row.name);
    await page.keyboard.press('Delete');
    await expect(dialog, `${row.name}: Delete on a belt carrying items opened the guard`).toBeVisible();
    await expect(dialog, `${row.name}: the guard's body names the belt and its items`).toContainText('This belt still carries');
    expect(beltOn(await readScene(page), cells), `${row.name}: the guard sent nothing: the belt is still there`).toBeDefined();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog, `${row.name}: Cancel closed the guard`).toHaveCount(0);
    const t0 = (await readScene(page)).tick;
    await pollScene(page, (s) => s.tick >= t0 + AFTER_KEY_TICKS, {
      message: `${row.name}: the board ran ${AFTER_KEY_TICKS} ticks after Cancel`,
    }).toBe(true);
    expect(beltOn(await readScene(page), cells), `${row.name}: Cancel kept the belt`).toBeDefined();
    await selectBelt(page, cells, row.name);
    await page.keyboard.press('Delete');
    await expect(dialog, `${row.name}: the second Delete opened the guard again`).toBeVisible();
    await dialog.getByRole('button', { name: 'Delete anyway' }).click();
    await pollScene(page, (s) => beltOn(s, cells) === undefined, {
      message: `${row.name}: Delete anyway removed the belt`,
    }).toBe(true);
    await expectDrawn(page, cells[Math.floor(cells.length / 2)], false, `${row.name}: and the canvas no longer draws it`);
    await expect(page.locator('#fab-belt-config'), `${row.name}: no belt panel stays`).toHaveCount(0);
  });

  test('(d) Backspace inside the pace field edits the text and deletes nothing', async ({ page }) => {
    const row = ROWS[0];
    await emptyBoardAtScaleOne(page, [[SOURCE_X, row.y], [SINK_X, row.y], ...row.floor]);
    const cells = await buildRow(page, row, false);
    await selectBelt(page, cells, row.name);
    const field = page.locator('#fab-belt-pace');
    await field.click();
    await field.press('End');
    const before = await field.inputValue();
    expect(before.length, `${row.name}: the pace field holds a figure to edit`).toBeGreaterThan(0);
    await field.press('Backspace');
    await expect(field, `${row.name}: Backspace edited the field's text`).toHaveValue(before.slice(0, -1));
    const t0 = (await readScene(page)).tick;
    await pollScene(page, (s) => s.tick >= t0 + AFTER_KEY_TICKS, {
      message: `${row.name}: the board ran ${AFTER_KEY_TICKS} ticks after the Backspace`,
    }).toBe(true);
    expect(docksOn(await readScene(page), cells, row.y), `${row.name}: the belt is still there, docked as drawn`).toBe(
      'Head@sink,Tail@source',
    );
    await expect(page.locator('#fab-belt-config'), `${row.name}: its panel is still open`).toBeVisible();
  });
});

