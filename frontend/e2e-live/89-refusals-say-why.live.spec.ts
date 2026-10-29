import { test, expect, type Page } from '@playwright/test';
import { addFrameBudget, addWaitBudget, frameBudgetMs } from '../e2e/support/frameSampler';
import {
  CELL,
  DRAWN_STATE_FRAMES,
  HAND_MOVE_FRAMES,
  armAndPlaceAt,
  beltPreviewPlottedOf,
  cameraOf,
  captureRefusalText,
  expectRefusalStayedSilent,
  expectRenderLoopAlive,
  handDragBetween,
  handPath,
  latchRejectFlashCells,
  nodeAtAnchor,
  nubAnchor,
  pollScene,
  readScene,
  rejectFlashCell,
  rejectFlashCellsSeen,
  stopRejectFlashLatch,
  restoreHostAfterFailedTest,
  screenCellCentre,
  screenPoint,
  selectMachineAt,
  waitForAppReady,
  waitForCameraSettle,
  watchPageErrors,
  type SceneFacts,
} from './support/oracle';
import { cellPoint, expectOnCanvas, turnUntilFacing, transport, resumeIfPaused, pauseAndSettle, emptyBoardAtScaleOne, place, deselectOnFloor, zoomTo } from './support/beltBoard';

// 89-refusals-say-why.live.spec.ts (phase 89, plan 89-09, FAIL-02, BELT-09, success criterion 5,
// D-12, D-13, UI-SPEC section 6 and walk step 8; the todos `2026-10-06-belt-overlap-says-nothing`
// and `2026-10-08-belt-press-on-the-machine-edge-does-nothing-silently`) - a belt the host will
// not draw says why, and one flash names the cell it is about, on the REAL host (dev_render_server,
// real Core -> RenderProducer -> postcard -> WS). Zero mocks, zero injected packets: machines are
// placed with the shipped palette, every belt is drawn with the shipped Belt tool by a hand drag.
//
// ---------------------------------------------------------------------------
// WHAT WAS BROKEN (89-MEASURE.md `## FAIL-02/overlap`, `## FAIL-02/edge-press`, `## BELT-09/W250`)
// ---------------------------------------------------------------------------
//
// The belt release was the last gesture that let the client's prediction decide WHETHER to send.
// A drag across a machine or a label, or a press just inside a machine's edge (whose seed is the
// machine's own cell), previewed red and the release sent NOTHING: no flash, no sentence, the red
// corridor just went away. D-13: every non-empty release is sent, and the host's sentence says
// why. D-12: one flash per release, on the cell the host's first failing check is about.
//
// ---------------------------------------------------------------------------
// THE LEGS, GRADED ON WHAT THE USER SEES
// ---------------------------------------------------------------------------
//
//   1. On a playing board, a hand drag from open floor across a Factory and on across a Label,
//      released on open floor: the flash the overlay PLOTTED (`rejectFlashCell`, latched on every
//      frame) is ONE cell, the first Factory cell crossed; `#fab-refusal` reads the collision
//      sentence; the belt count is unchanged.
//   2. The same on a paused board: the flash at the release, no belt and no sentence and no held
//      picture while paused (the host answers when it drains the draw at Play), then Play: the
//      sentence, and still no belt.
//   3. The edge presses, at camera scale 1 and again after the wheel has zoomed below 1: a press 2
//      screen px inside a Source's East edge, dragged about 80 screen px East in 3 px samples and
//      released: the sentence and the flash on the pressed (Source) cell. The same 2 px inside a
//      drawn belt's last tile, beside its end ring: the sentence and the flash on that tile. Then
//      the regression guard: a press on each ring itself (the Source's doorstep and the belt's)
//      still draws a belt.
//   4. Past the grid edge (WINDOWS 251, D-12): the camera is panned by the shipped pan gesture (a
//      left drag on open floor, no tool armed) in bounded steps until cell 512, the last cell on
//      the grid, is on screen; a hand drag from (509,y) to (515,y): the drag preview the overlay
//      PLOTTED (`beltPreviewPlottedOf`) is the build colour while the hand is on the grid and red
//      once it is past it; after the release, `That cell is past the edge of the grid.` and ONE
//      flash on (513,y), the first cell off the grid. No belt.
//   5. An illegal path released on an Electrical In's dot (WINDOWS 250, D-12), at zoom 1 and below
//      1: a drag from floor across a Sink, released on a Route's (Electrical) In dot: ONE flash,
//      on the Sink cell crossed, never on the dot; the collision sentence; no belt.
//   6. A dock owed and never sent (WINDOWS 254, D-14): on a paused board, Ctrl+Z (queued; it will
//      take away the Factory placed last), then a docked draw from a Source's Out doorstep to the
//      Factory's In doorstep. On Play the Undo folds first, the belt lands in the Undo's table, its
//      Tail docks the Source and its Head Dock cannot be named again: `#fab-refusal` reads `A belt
//      you drew is missing a connection.` The Undo comes before the draw because the shipped
//      PAUSE-TOOLBAR hold sends no Undo after a paused draw (74.1-31).
//
// RED FIRST (D-16): run once against the plan's start revision (the frontend from a throwaway
// worktree with this spec, the oracle helpers and the `rejectFlashCell` read copied in): every leg
// red (89-EVIDENCE.md, `LIVE_RED 89-refusals-say-why`).
//
// Render health in every test: `watchPageErrors` before `goto`, `expectRenderLoopAlive` and the
// watcher's `assertNone` after every test (fabrico-model-oracle-blindspot).

/** Wire kinds (kinds.ts). */
const KIND_SOURCE = 0;
const KIND_FACTORY = 2;
const KIND_LABEL = 11;
/** Port roles (oracle `PortFacts.role`). */
const ROLE_OUT = 1;
/** Sides, the wire's numbering (y-down). */
const E = 1;
/** The host's FootprintCollision sentence, as plan 89-08 worded it (a literal, so a copy edit is seen). */
const COLLISION_COPY = 'That space is taken. Clear it or try elsewhere.';
/** How far inside an edge an edge press lands, in screen px (the todo measured 1 to 3). */
const EDGE_INSET_PX = 2;
/** The edge-press drag: about 80 screen px, in samples of this many px (the todo measured 2 to 4). */
const EDGE_DRAG_PX = 80;
const EDGE_STEP_PX = 3;

type Cell = readonly [number, number];

/** The screen point is on the open canvas, where a hand reaches the board, not under chrome. */

/** Turn the selected machine at `cell` with `r` until its first Out faces `side`. */
async function turnOutToward(page: Page, cell: Cell, side: number, what: string): Promise<void> {
  await turnUntilFacing(page, cell, ROLE_OUT, side, what);
}

/**
 * Press at `start`, drag `EDGE_DRAG_PX` screen px East in samples of `EDGE_STEP_PX` with a small
 * wobble off the row (never leaving it), and release: the todo's measured edge-press hand.
 */
async function edgeDragEast(page: Page, start: { x: number; y: number }): Promise<number> {
  const samples = Math.ceil(EDGE_DRAG_PX / EDGE_STEP_PX);
  addFrameBudget((samples + 2) * HAND_MOVE_FRAMES, `edgeDragEast ${samples} samples`);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.waitForTimeout(8);
  let x = start.x;
  for (let i = 0; i < samples; i += 1) {
    x = Math.min(start.x + EDGE_DRAG_PX, x + EDGE_STEP_PX);
    await page.mouse.move(x, start.y + [0, 1, -1, 1][i % 4]);
    await page.waitForTimeout(8);
  }
  await page.mouse.up();
  return samples;
}

/** The flash cells the per-frame latch saw, once at least one was plotted. */
async function flashCellsAfterRelease(page: Page, what: string): Promise<Array<{ cx: number; cy: number }>> {
  await expect
    .poll(async () => (await rejectFlashCellsSeen(page)).length, {
      timeout: addWaitBudget(frameBudgetMs(DRAWN_STATE_FRAMES * 4), `${what}: the flash latch`),
      message: `${what}: the canvas plotted a reject flash at the release`,
    })
    .toBeGreaterThan(0);
  // A few frames more, so a second flash, were there one, would be latched too.
  await page.waitForTimeout(addWaitBudget(frameBudgetMs(DRAWN_STATE_FRAMES * 2), `${what}: the second-flash window`));
  const seen = await rejectFlashCellsSeen(page);
  await stopRejectFlashLatch(page);
  return seen;
}

/** How many geometry instructions the drag preview and the held pictures hold right now. */
async function beltPictureInstructions(page: Page): Promise<number> {
  return page.evaluate(() => {
    const hook = (window as { __fabrico?: { beltPreviewInstructions?(): number } }).__fabrico;
    if (typeof hook?.beltPreviewInstructions !== 'function') {
      throw new Error('window.__fabrico.beltPreviewInstructions() not installed');
    }
    return hook.beltPreviewInstructions();
  });
}

/** The belt whose first tile is `cell`, or undefined. */
function beltFrom(s: SceneFacts, cell: Cell) {
  return s.belts.find((b) => b.tiles.length > 0 && b.tiles[0].cell_x === cell[0] && b.tiles[0].cell_y === cell[1]);
}

// The crossing board (legs 1 and 2): a 3x3 Factory at (10,8) and a 4x1 Label at (15,8), crossed
// along row 8, the Factory's top row (no port on it), from floor (7,8) to floor (21,8).
const FACTORY_AT: Cell = [10, 8];
const LABEL_AT: Cell = [15, 8];
const CROSS_FROM: Cell = [7, 8];
const CROSS_TO: Cell = [21, 8];
const CROSS_FLOOR: ReadonlyArray<Cell> = [
  [8, 13],
  [6, 13],
];

/** The crossing board on an empty, playing board; returns the belt count before the drag. */
async function crossingBoard(page: Page): Promise<number> {
  await emptyBoardAtScaleOne(page, [CROSS_FROM, CROSS_TO, FACTORY_AT, LABEL_AT, ...CROSS_FLOOR]);
  await place(page, 'Factory', KIND_FACTORY, FACTORY_AT, 'the crossing board');
  await deselectOnFloor(page, CROSS_FLOOR, 'after the Factory');
  await armAndPlaceAt(page, 'Label', LABEL_AT[0], LABEL_AT[1]);
  await pollScene(page, (s) => nodeAtAnchor(s, LABEL_AT[0], LABEL_AT[1])?.kind ?? -1, {
    message: 'the crossing board: the palette Label was placed',
  }).toBe(KIND_LABEL);
  await deselectOnFloor(page, CROSS_FLOOR, 'after the Label');
  const s = await readScene(page);
  const factory = nodeAtAnchor(s, ...FACTORY_AT)!;
  expect(
    factory.cells.filter(([, y]) => y === 8).map(([x]) => x).sort((a, b) => a - b),
    'PRECONDITION: the Factory covers (10..12, 8), so (10,8) is the first cell the row crosses',
  ).toEqual([10, 11, 12]);
  const label = nodeAtAnchor(s, ...LABEL_AT)!;
  expect([...label.cells].sort((a, b) => a[0] - b[0]), 'PRECONDITION: the Label holds (15..18, 8)').toEqual([
    [15, 8],
    [16, 8],
    [17, 8],
    [18, 8],
  ]);
  await expectRenderLoopAlive(page, 'with the crossing board built');
  return s.belts.length;
}

/** The hand drag across the Factory and the Label, released on floor, with the flash latched from before the press. */
async function dragAcross(page: Page): Promise<void> {
  await page.getByTitle(/^Draw belts/).click();
  const start = await cellPoint(page, CROSS_FROM[0], CROSS_FROM[1], 0.4, 0.55);
  const end = await cellPoint(page, CROSS_TO[0], CROSS_TO[1], 0.45, 0.5);
  await expectOnCanvas(page, [start], 'the press');
  await expectOnCanvas(page, [end], 'the release');
  expect(await rejectFlashCell(page), 'no reject flash is plotted before the press').toBeNull();
  await latchRejectFlashCells(page);
  const moves = await handDragBetween(page, start, end);
  expect(moves, 'the drag moved through many samples, not one teleport').toBeGreaterThanOrEqual(3);
}

/** The edge-press rows: one at camera scale 1, one below 1. */
interface Row {
  name: string;
  y: number;
  /** The wheel stops once the scale is at or below this (1 means "stay at 1"). */
  zoomTo: number;
  floor: ReadonlyArray<Cell>;
}
const EDGE_ROWS: readonly Row[] = [
  { name: 'at zoom 1', y: 7, zoomTo: 1, floor: [[12, 10], [11, 10]] },
  { name: 'below zoom 1', y: 13, zoomTo: 0.6, floor: [[12, 10], [11, 10]] },
];
/** The Source's anchor column, and the free belt's three cells' first column. */
const SOURCE_X = 8;
const BELT_X = 16;
/** The host's OutOfBounds sentence (shipped, unchanged). */
const OUT_OF_BOUNDS_COPY = 'That cell is past the edge of the grid.';
/** The client's DockNotSent sentence (plan 89-09, D-14), a literal so a copy edit is seen. */
const DOCK_NOT_SENT_COPY = 'A belt you drew is missing a connection.';
/** The last cell on the grid on either axis (`fabrico_core::state::GRID_MAX`). */
const GRID_EDGE = 512;
const KIND_SINK = 7;
const KIND_ROUTE = 9;
const W = 3;
/** Leg 5's rows: the start on floor, the Sink crossed, the Route whose In dot takes the release. */
const NUB_ROWS: readonly Row[] = [
  { name: 'at zoom 1', y: 7, zoomTo: 1, floor: [[10, 10], [11, 10]] },
  { name: 'below zoom 1', y: 13, zoomTo: 0.6, floor: [[10, 10], [11, 10]] },
];
const N_FROM_X = 7;
const N_SINK_X = 10;
const N_ROUTE_X = 15;

/** Pan the camera by left drags on open floor, no tool armed, until `cells` are all on screen. */
async function panUntilOnScreen(page: Page, cells: ReadonlyArray<Cell>): Promise<number> {
  const box = await page.locator('canvas').first().boundingBox();
  expect(box, 'the canvas has a box').not.toBeNull();
  const y = box!.y + box!.height * 0.6;
  const from = box!.x + box!.width * 0.85;
  const to = box!.x + box!.width * 0.25;
  const onScreen = async (): Promise<boolean> => {
    for (const [cx, cy] of cells) {
      const pt = await screenCellCentre(page, cx, cy);
      if (pt.x < box!.x + box!.width * 0.3 || pt.x > box!.x + box!.width * 0.8) return false;
      if (pt.y < box!.y + 60 || pt.y > box!.y + box!.height - 60) return false;
    }
    return true;
  };
  await expectOnCanvas(page, [{ x: from, y }], 'the pan drag start');
  await expectOnCanvas(page, [{ x: to, y }], 'the pan drag end');
  let drags = 0;
  for (; drags < 60 && !(await onScreen()); drags += 1) {
    const left = (await screenCellCentre(page, cells[0][0], cells[0][1])).x;
    // The last drag is only as long as the distance still to go, so the cells land mid-canvas.
    const span = Math.min(from - to, left - (box!.x + box!.width * 0.35));
    addFrameBudget(14 * HAND_MOVE_FRAMES, `pan drag ${drags + 1}`);
    await page.mouse.move(from, y);
    await page.mouse.down();
    await page.mouse.move(from - span, y, { steps: 12 });
    await page.mouse.up();
    await waitForCameraSettle(page);
  }
  expect(await onScreen(), `the pan reached the grid edge in ${drags} drags`).toBe(true);
  return drags;
}

test.describe('89 live: a belt the host will not draw says why, and the flash names the cell (FAIL-02, BELT-09)', () => {
  let errs: ReturnType<typeof watchPageErrors>;

  test.beforeEach(async ({ page }) => {
    errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
  });

  test.afterEach(async ({ page }, testInfo) => {
    try {
      await resumeIfPaused(page);
      await expectRenderLoopAlive(page, 'at the end of the test');
      errs.assertNone('the refusals-say-why walk');
    } finally {
      await restoreHostAfterFailedTest(page, testInfo);
    }
  });

  test('1: a hand drag across a Factory and a Label flashes the first Factory cell and says the space is taken', async ({
    page,
  }) => {
    const beltsBefore = await crossingBoard(page);
    await dragAcross(page);
    // The sentence first: it is held 4 s (`REFUSAL_HOLD_MS`), while the flash latch keeps every
    // flash it saw, so the latch is read after.
    expect(await captureRefusalText(page, 'leg 1: the release was answered'), 'leg 1: the host says why').toBe(COLLISION_COPY);
    const flashes = await flashCellsAfterRelease(page, 'leg 1');
    console.log(`P89-SAY leg 1: flashes=${JSON.stringify(flashes)}`);
    expect(flashes, 'ONE flash, on the first Factory cell the drag crossed').toEqual([{ cx: 10, cy: 8 }]);
    await page.keyboard.press('Escape');
    expect((await readScene(page)).belts.length, 'leg 1: no belt landed').toBe(beltsBefore);
    await expectRenderLoopAlive(page, 'after leg 1');
  });

  test('2: the same drag on a paused board flashes at the release and says why at Play', async ({ page }) => {
    const beltsBefore = await crossingBoard(page);
    await pauseAndSettle(page, 'leg 2');
    await expectRefusalStayedSilent(page, 'leg 2: the paused release', async () => {
      await dragAcross(page);
      const flashes = await flashCellsAfterRelease(page, 'leg 2');
      console.log(`P89-SAY leg 2: flashes=${JSON.stringify(flashes)}`);
      expect(flashes, 'leg 2: ONE flash at the release, on the first Factory cell crossed').toEqual([{ cx: 10, cy: 8 }]);
      expect(await beltPictureInstructions(page), 'leg 2: no preview and no held picture stays on the board while paused').toBe(0);
      expect((await readScene(page)).belts.length, 'leg 2: no belt while paused').toBe(beltsBefore);
    });
    await page.keyboard.press('Escape');
    await transport(page).click();
    expect(await captureRefusalText(page, 'leg 2: the release was answered at Play'), 'leg 2: the host says why at Play').toBe(
      COLLISION_COPY,
    );
    expect((await readScene(page)).belts.length, 'leg 2: and no belt landed at Play').toBe(beltsBefore);
    await expectRenderLoopAlive(page, 'after leg 2');
  });

  test('3: a press just inside a Source or a belt end says why and flashes the pressed cell; the rings still draw', async ({
    page,
  }) => {
    const cells = EDGE_ROWS.flatMap((r) => [[SOURCE_X, r.y] as const, [BELT_X + 2, r.y] as const, ...r.floor]);
    await emptyBoardAtScaleOne(page, cells);
    for (const row of EDGE_ROWS) {
      const sourceCell: Cell = [SOURCE_X, row.y];
      await place(page, 'Source', KIND_SOURCE, sourceCell, row.name);
      await selectMachineAt(page, ...sourceCell);
      await turnOutToward(page, sourceCell, E, `${row.name}: the Source's output`);
      await deselectOnFloor(page, row.floor, `${row.name}: after the Source turn`);
      // The free belt, three cells East along the row, drawn by a hand from floor to floor.
      await page.getByTitle(/^Draw belts/).click();
      await handDragBetween(
        page,
        await cellPoint(page, BELT_X, row.y, 0.45, 0.5),
        await cellPoint(page, BELT_X + 2, row.y, 0.5, 0.55),
      );
      await page.keyboard.press('Escape');
      await pollScene(page, (s) => beltFrom(s, [BELT_X, row.y])?.tiles.length ?? 0, {
        message: `${row.name}: the free belt on (${BELT_X}..${BELT_X + 2}, ${row.y})`,
      }).toBe(3);
    }
    await expectRenderLoopAlive(page, 'with both edge rows built');

    for (const row of EDGE_ROWS) {
      let scale = 1;
      if (row.zoomTo === 1) {
        expect((await cameraOf(page)).scale, `${row.name}: pressed at camera scale 1`).toBe(1);
      } else {
        scale = await zoomTo(page, [BELT_X, row.y], row.zoomTo);
        console.log(`P89-SAY leg 3 ${row.name}: camera scale ${scale}`);
      }
      const inset = EDGE_INSET_PX / scale;
      const presses: Array<{ what: string; world: { x: number; y: number }; pressed: Cell }> = [
        {
          what: `${row.name}: 2 px inside the Source's East edge`,
          world: { x: (SOURCE_X + 1) * CELL - inset, y: (row.y + 0.5) * CELL },
          pressed: [SOURCE_X, row.y],
        },
        {
          what: `${row.name}: 2 px inside the belt's last tile, beside its end ring`,
          world: { x: (BELT_X + 3) * CELL - inset, y: (row.y + 0.5) * CELL },
          pressed: [BELT_X + 2, row.y],
        },
      ];
      for (const p of presses) {
        const beltsBefore = (await readScene(page)).belts.length;
        await page.getByTitle(/^Draw belts/).click();
        const start = await screenPoint(page, p.world);
        await expectOnCanvas(page, [start], `${p.what}: the press`);
        await expectOnCanvas(page, [{ x: start.x + EDGE_DRAG_PX, y: start.y }], `${p.what}: the release`);
        expect(await rejectFlashCell(page), `${p.what}: no reject flash is plotted before the press`).toBeNull();
        await latchRejectFlashCells(page);
        const samples = await edgeDragEast(page, start);
        expect(samples, `${p.what}: the drag moved in many small samples`).toBeGreaterThanOrEqual(20);
        expect(await captureRefusalText(page, `${p.what}: the release was answered`), `${p.what}: the host says why`).toBe(
          COLLISION_COPY,
        );
        const flashes = await flashCellsAfterRelease(page, p.what);
        console.log(`P89-SAY leg 3 ${p.what}: flashes=${JSON.stringify(flashes)}`);
        expect(flashes, `${p.what}: ONE flash, on the pressed cell`).toEqual([{ cx: p.pressed[0], cy: p.pressed[1] }]);
        await page.keyboard.press('Escape');
        expect((await readScene(page)).belts.length, `${p.what}: no belt landed`).toBe(beltsBefore);
        // Let the sentence's hold run out, so the next press's sentence is its own.
        await expect(page.locator('#fab-refusal'), `${p.what}: the band clears`).toHaveText('', { timeout: 10_000 });
      }

      // THE REGRESSION GUARD: a press on the ring itself (the doorstep, where the ring is drawn)
      // still starts a docked draw, from the Source and from the belt's Head.
      // Each ring names what it belongs to, and the docked Tail is graded on THAT (review IN-C-09):
      // the Source machine, and the free belt whose Head end the second ring sits past.
      const sAtRings = await readScene(page);
      const rings: Array<{ what: string; door: Cell; owner: number | undefined }> = [
        { what: `${row.name}: the Source's ring`, door: [SOURCE_X + 1, row.y], owner: nodeAtAnchor(sAtRings, SOURCE_X, row.y)?.id },
        { what: `${row.name}: the belt's end ring`, door: [BELT_X + 3, row.y], owner: beltFrom(sAtRings, [BELT_X, row.y])?.id },
      ];
      for (const ring of rings) {
        const beltsBefore = (await readScene(page)).belts.length;
        await page.getByTitle(/^Draw belts/).click();
        const start = await cellPoint(page, ring.door[0], ring.door[1], 0.45, 0.55);
        await expectOnCanvas(page, [start], `${ring.what}: the press`);
        await edgeDragEast(page, start);
        await page.keyboard.press('Escape');
        await pollScene(page, (s) => s.belts.length, { message: `${ring.what}: a press on the ring draws a belt` }).toBe(
          beltsBefore + 1,
        );
        const drawnBelt = beltFrom(await readScene(page), ring.door);
        expect(drawnBelt, `${ring.what}: the new belt starts on the ring's doorstep`).toBeDefined();
        expect(ring.owner, `${ring.what}: PRECONDITION: the ring's owner is on the board`).toBeDefined();
        await pollScene(page, (s) => beltFrom(s, ring.door)?.docks.some((d) => d.end === 'Tail' && d.node === ring.owner) ?? false, {
          message: `${ring.what}: and its Tail is docked to what the ring belongs to (#${ring.owner})`,
        }).toBe(true);
      }
      await expectRenderLoopAlive(page, `after the ${row.name} edge presses`);
    }
  });
  test('4: a run dragged past the grid edge previews red from the first cell off the grid and says why', async ({ page }) => {
    const y = 8;
    await emptyBoardAtScaleOne(page, []);
    await page.keyboard.press('Escape');
    const drags = await panUntilOnScreen(page, [
      [GRID_EDGE - 3, y],
      [GRID_EDGE + 3, y],
    ]);
    console.log(`P89-SAY leg 4: panned in ${drags} drags, camera ${JSON.stringify(await cameraOf(page))}`);
    expect((await cameraOf(page)).scale, 'leg 4: drawn at camera scale 1').toBe(1);
    const beltsBefore = (await readScene(page)).belts.length;
    await page.getByTitle(/^Draw belts/).click();
    const start = await cellPoint(page, GRID_EDGE - 3, y, 0.4, 0.55);
    const end = await cellPoint(page, GRID_EDGE + 3, y, 0.45, 0.5);
    await expectOnCanvas(page, [start], 'leg 4: the press');
    await expectOnCanvas(page, [end], 'leg 4: the release');
    const cam = await cameraOf(page);
    const points = [start, ...handPath(start, end)];
    const plotted: Array<{ cellX: number; valid: boolean | null }> = [];
    expect(await rejectFlashCell(page), 'leg 4: no reject flash is plotted before the press').toBeNull();
    await latchRejectFlashCells(page);
    await handDragBetween(page, start, end, async (step) => {
      const p = await beltPreviewPlottedOf(page);
      const at = points[Math.min(step, points.length - 1)];
      plotted.push({ cellX: Math.floor((at.x - cam.x) / cam.scale / CELL), valid: p === null ? null : p.valid });
    });
    const onGrid = plotted.filter((p) => p.cellX <= GRID_EDGE);
    const offGrid = plotted.filter((p) => p.cellX > GRID_EDGE);
    console.log(`P89-SAY leg 4: on_grid=${onGrid.length} off_grid=${offGrid.length} plotted=${JSON.stringify(plotted)}`);
    expect(onGrid.length, 'leg 4: NON-VACUITY: samples on the grid').toBeGreaterThan(3);
    expect(offGrid.length, 'leg 4: NON-VACUITY: samples past the edge').toBeGreaterThan(3);
    expect(
      onGrid.filter((p) => p.valid !== true),
      'leg 4: while the hand is on the grid the plotted preview is the build colour',
    ).toEqual([]);
    expect(
      offGrid.filter((p) => p.valid !== false),
      'leg 4: once the hand is past cell 512 the plotted preview is red',
    ).toEqual([]);
    expect(await captureRefusalText(page, 'leg 4: the release was answered'), 'leg 4: the host says why').toBe(OUT_OF_BOUNDS_COPY);
    const flashes = await flashCellsAfterRelease(page, 'leg 4');
    console.log(`P89-SAY leg 4: flashes=${JSON.stringify(flashes)}`);
    expect(flashes, 'leg 4: ONE flash, on the first cell off the grid').toEqual([{ cx: GRID_EDGE + 1, cy: y }]);
    await page.keyboard.press('Escape');
    expect((await readScene(page)).belts.length, 'leg 4: no belt landed').toBe(beltsBefore);
    await expectRenderLoopAlive(page, 'after leg 4');
  });

  test('5: an illegal path released on an Electrical In dot flashes the path, not the dot', async ({ page }) => {
    const cells = NUB_ROWS.flatMap((r) => [[N_FROM_X, r.y] as const, [N_ROUTE_X, r.y] as const, ...r.floor]);
    await emptyBoardAtScaleOne(page, cells);
    for (const row of NUB_ROWS) {
      await place(page, 'Sink', KIND_SINK, [N_SINK_X, row.y], row.name);
      await place(page, 'Route', KIND_ROUTE, [N_ROUTE_X, row.y], row.name);
      await deselectOnFloor(page, row.floor, `${row.name}: after the placements`);
      const routeIn = nodeAtAnchor(await readScene(page), N_ROUTE_X, row.y)!.ports.find((q) => q.role === 0)!;
      expect(
        [routeIn.cell_x, routeIn.cell_y, routeIn.side, routeIn.medium],
        `${row.name}: PRECONDITION: the Route's In is Electrical and faces West on the row`,
      ).toEqual([N_ROUTE_X, row.y, W, 1]);
    }
    await expectRenderLoopAlive(page, 'with both dot rows built');
    for (const row of NUB_ROWS) {
      let scale = 1;
      if (row.zoomTo === 1) {
        expect((await cameraOf(page)).scale, `${row.name}: drawn at camera scale 1`).toBe(1);
      } else {
        scale = await zoomTo(page, [N_SINK_X, row.y], row.zoomTo);
        console.log(`P89-SAY leg 5 ${row.name}: camera scale ${scale}`);
      }
      const beltsBefore = (await readScene(page)).belts.length;
      await page.getByTitle(/^Draw belts/).click();
      const start = await cellPoint(page, N_FROM_X, row.y, 0.4, 0.55);
      // On the Route's In dot, a couple of world px off its anchor, the way a hand lands.
      const dot = nubAnchor(N_ROUTE_X, row.y, W);
      const end = await screenPoint(page, { x: dot.x - 1.5, y: dot.y + 2 });
      await expectOnCanvas(page, [start], `${row.name}: the press`);
      await expectOnCanvas(page, [end], `${row.name}: the release`);
      expect(await rejectFlashCell(page), `${row.name}: no reject flash is plotted before the press`).toBeNull();
      await latchRejectFlashCells(page);
      const moves = await handDragBetween(page, start, end);
      expect(moves, `${row.name}: the drag moved through many samples`).toBeGreaterThanOrEqual(3);
      expect(await captureRefusalText(page, `${row.name}: the release was answered`), `${row.name}: the host says why`).toBe(
        COLLISION_COPY,
      );
      const flashes = await flashCellsAfterRelease(page, `leg 5 ${row.name}`);
      console.log(`P89-SAY leg 5 ${row.name}: flashes=${JSON.stringify(flashes)}`);
      expect(flashes, `${row.name}: ONE flash, on the Sink cell the path crosses, not on the dot`).toEqual([
        { cx: N_SINK_X, cy: row.y },
      ]);
      await page.keyboard.press('Escape');
      expect((await readScene(page)).belts.length, `${row.name}: no belt landed`).toBe(beltsBefore);
      await expect(page.locator('#fab-refusal'), `${row.name}: the band clears`).toHaveText('', { timeout: 10_000 });
      await expectRenderLoopAlive(page, `after the ${row.name} release on the dot`);
    }
  });

  test('6: a paused docked draw whose Factory an earlier Undo takes away says a connection is missing', async ({ page }) => {
    const sourceCell: Cell = [6, 8];
    const factoryCell: Cell = [12, 7];
    const floor: ReadonlyArray<Cell> = [
      [8, 13],
      [6, 13],
    ];
    await emptyBoardAtScaleOne(page, [sourceCell, factoryCell, ...floor]);
    // The Source first, then the Factory: the Factory is the last edit, the one Ctrl+Z takes away.
    await place(page, 'Source', KIND_SOURCE, sourceCell, 'leg 6');
    await deselectOnFloor(page, floor, 'leg 6: after the Source');
    await place(page, 'Factory', KIND_FACTORY, factoryCell, 'leg 6');
    await deselectOnFloor(page, floor, 'leg 6: after the Factory');
    const built = await readScene(page);
    const out = nodeAtAnchor(built, ...sourceCell)!.ports.find((q) => q.role === ROLE_OUT)!;
    const inPort = nodeAtAnchor(built, ...factoryCell)!.ports.find((q) => q.role === 0)!;
    expect([out.cell_x, out.cell_y, out.side], 'leg 6: PRECONDITION: the Source Out faces East on row 8').toEqual([6, 8, E]);
    expect([inPort.cell_x, inPort.cell_y, inPort.side], 'leg 6: PRECONDITION: the Factory In faces West on row 8').toEqual([
      12,
      8,
      W,
    ]);
    const beltsBefore = built.belts.length;
    await pauseAndSettle(page, 'leg 6');
    await page.keyboard.press('Control+z');
    // The draw, by hand, from the Source Out's doorstep (7,8) to the Factory In's doorstep (11,8).
    await page.getByTitle(/^Draw belts/).click();
    const start = await cellPoint(page, 7, 8, 0.4, 0.55);
    const end = await cellPoint(page, 11, 8, 0.55, 0.5);
    await expectOnCanvas(page, [start], 'leg 6: the press');
    await expectOnCanvas(page, [end], 'leg 6: the release');
    const plotted: Array<boolean | null> = [];
    await handDragBetween(page, start, end, async () => {
      const p = await beltPreviewPlottedOf(page);
      plotted.push(p === null ? null : p.valid);
    });
    expect(plotted.at(-1), 'leg 6: PRECONDITION: the docked draw previewed the build colour').toBe(true);
    await page.keyboard.press('Escape');
    expect((await readScene(page)).belts.length, 'leg 6: nothing landed while paused').toBe(beltsBefore);
    await transport(page).click();
    expect(
      await captureRefusalText(page, 'leg 6: the dropped Dock was reported at Play'),
      'leg 6: the user is told the drawn belt is missing a connection',
    ).toBe(DOCK_NOT_SENT_COPY);
    await pollScene(page, (st) => beltFrom(st, [7, 8])?.tiles.length ?? 0, {
      message: 'leg 6: the belt landed on (7..11, 8)',
    }).toBe(5);
    const after = await readScene(page);
    expect(nodeAtAnchor(after, ...factoryCell), 'leg 6: the Undo took the Factory away').toBeUndefined();
    await pollScene(page, (st) => (beltFrom(st, [7, 8])?.docks ?? []).map((d) => d.end).sort().join(','), {
      message: 'leg 6: the belt has its Tail Dock to the Source and no Head Dock',
    }).toBe('Tail');
    await expectRenderLoopAlive(page, 'after leg 6');
  });
  test('7: a refused draw near the top of the view: the sentence steps below the flashed cell instead of covering it', async ({
    page,
  }) => {
    // Review UI-02 (89-UI-REVIEW.md, walk capture strip-s8a): the band sits at a fixed place under
    // the toolbar, and a refusal whose flashed cell lay under it hid the WHERE (the flash) behind
    // the WHY (the sentence). The board is panned so the crossing row sits where the band shows,
    // then leg 1's drag: graded on screen, the band's box (DOM) against the flashed cell's box
    // (plot, through the camera). NON-VACUITY: at the band's shipped top it would cover the cell.
    // Red before the fix: the band stayed on the cell.
    const beltsBefore = await crossingBoard(page);
    // The band is centred on the window under the toolbar: the Factory's first cell is panned to
    // the window's middle column and to the band's row.
    const shippedTop = await page.evaluate(() => parseFloat(getComputedStyle(document.getElementById('fab-refusal')!).top));
    const midX = await page.evaluate(() => window.innerWidth / 2);
    const cell = await screenCellCentre(page, FACTORY_AT[0], FACTORY_AT[1]);
    const dx = midX - cell.x;
    const dy = shippedTop + 24 - cell.y;
    await page.keyboard.press('Escape');
    const grab = await cellPoint(page, 8, 13, 0.5, 0.5);
    await expectOnCanvas(page, [grab, { x: grab.x + dx, y: grab.y + dy }], 'the pan');
    addFrameBudget(16 * HAND_MOVE_FRAMES, 'leg 7: the pan drag');
    await page.mouse.move(grab.x, grab.y);
    await page.mouse.down();
    await page.mouse.move(grab.x + dx, grab.y + dy, { steps: 14 });
    await page.mouse.up();
    await waitForCameraSettle(page);
    const cellNow = await screenCellCentre(page, FACTORY_AT[0], FACTORY_AT[1]);
    console.log(`P89-UI02 band shipped top=${shippedTop} cell (10,8) centre ${JSON.stringify(cell)} -> ${JSON.stringify(cellNow)}`);
    expect(Math.abs(cellNow.y - (shippedTop + 24)), 'leg 7: PRECONDITION: the crossing row now sits where the band shows').toBeLessThan(12);
    expect(Math.abs(cellNow.x - midX), "leg 7: PRECONDITION: the Factory's first cell sits under the band's middle").toBeLessThan(12);
    await dragAcross(page);
    expect(await captureRefusalText(page, 'leg 7: the release was answered'), 'leg 7: the host says why').toBe(COLLISION_COPY);
    const band = await page.locator('#fab-refusal > div').boundingBox();
    const flashes = await flashCellsAfterRelease(page, 'leg 7');
    expect(flashes, 'leg 7: ONE flash, on the first Factory cell').toEqual([{ cx: FACTORY_AT[0], cy: FACTORY_AT[1] }]);
    const cam = await cameraOf(page);
    const box = {
      left: FACTORY_AT[0] * CELL * cam.scale + cam.x,
      top: FACTORY_AT[1] * CELL * cam.scale + cam.y,
      right: (FACTORY_AT[0] + 1) * CELL * cam.scale + cam.x,
      bottom: (FACTORY_AT[1] + 1) * CELL * cam.scale + cam.y,
    };
    expect(band, 'leg 7: the band is on screen while the sentence is held').not.toBeNull();
    const b = band!;
    const line = `band ${JSON.stringify(b)} flashed cell ${JSON.stringify(box)} shipped top ${shippedTop}`;
    console.log(`P89-UI02 ${line}`);
    const wouldCover = shippedTop < box.bottom && box.top < shippedTop + b.height && b.x < box.right && box.left < b.x + b.width;
    expect(wouldCover, `leg 7: NON-VACUITY: at its shipped top the band would cover the flashed cell (${line})`).toBe(true);
    const covers = b.y < box.bottom && box.top < b.y + b.height && b.x < box.right && box.left < b.x + b.width;
    expect(covers, `leg 7: the band does not cover the flashed cell (${line})`).toBe(false);
    await page.keyboard.press('Escape');
    expect((await readScene(page)).belts.length, 'leg 7: no belt landed').toBe(beltsBefore);
    await expectRenderLoopAlive(page, 'after leg 7');
  });
});
