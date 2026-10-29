import { test, expect, type Page } from '@playwright/test';
import { addWaitBudget, frameBudgetMs } from '../e2e/support/frameSampler';
import {
  DRAWN_STATE_FRAMES,
  CELL,
  applyConfig,
  beltCollarCentresOn,
  cameraOf,
  expectRenderLoopAlive,
  fillPanelField,
  handDragBetween,
  nodeAtAnchor,
  nubAnchor,
  pollScene,
  pressSegment,
  readBeltFlowWatch,
  readScene,
  restoreHostAfterFailedTest,
  screenPoint,
  selectMachineAt,
  startBeltFlowWatch,
  stopBeltFlowWatch,
  tileKindAt,
  waitForAppReady,
  watchPageErrors,
} from './support/oracle';
import { cardinalOfRotation, doorstep, portOf, beltOn, rowCells, cellPoint, emptyBoardAtScaleOne, place, turnUntilFacing, deselectOnFloor, zoomBelowOne, treadRotationAt } from './support/beltBoard';

// 89-finish-on-a-belt-start.live.spec.ts (phase 89, plan 89-05, BELT-04 second half, success
// criterion 1, WINDOWS 248, D-06, UI-SPEC 3.2, walk step 5) - a belt draw finished on another
// belt's start docks to it, on the start's first tile and one cell short of it, on the REAL host
// (dev_render_server, real Core -> RenderProducer -> postcard -> WS). Zero mocks, zero injected
// packets: the machines are placed and turned with the shipped palette and `r` key, and every belt
// is drawn with the shipped Belt tool by a hand drag.
//
// ---------------------------------------------------------------------------
// WHAT WAS BROKEN (89-MEASURE.md `## BELT-04/W248: still broken`)
// ---------------------------------------------------------------------------
//
// The belt draw release ranked machine ports only, and the auto-dock fallback looked at machines
// only. A draw finished with the hand on another belt's first tile pushed that occupied tile, so
// the path went red and nothing was sent; one cell short, the belt was sent with its Head free.
// D-06: the release also takes belt Tail ends (judged by the one-step rule, no doorstep append),
// dropping the target's first tile when the head ends on it, and the auto-dock also takes a free
// belt Tail one step past the head and facing it. Either way ONE Head Dock names the target belt.
//
// ---------------------------------------------------------------------------
// THE LEGS, GRADED ON WHAT THE EYE SEES
// ---------------------------------------------------------------------------
//
// A Source on a Timer and a Sink with a belt B between them that does NOT reach the Source: B is
// drawn by a hand drag from open floor onto the Sink's input dot, so its Head docks the Sink and
// its Tail is free. Then a new belt A is drawn by a hand drag (`handDragBetween`, many sub-cell
// samples, five or six cells) from the Source output's doorstep toward B's first tile:
//
//   1. released on B's first tile (off-centre, inside the tile);
//   2. released one cell short of it.
//
// Either way: A ends one cell before B's first tile, A's Head is docked to B's Tail and A's Tail
// to the Source; the junction collar is PLOTTED at the A|B seam, on the shared edge of A's last
// tile and B's first, and no collar was plotted anywhere near it before the draw (review fix
// CR-C-01: `beltCollarCentresOn`, read off the belt end Graphics, so the grade is the seam the user
// looks at and it was false before the join); B's first tile still ships its straight kind and
// its tread still points East (the join did not damage B: B was drawn straight, so these held
// before the join too and are not the seam grade); and items flow through both belts after Play
// (each belt's head-most item leaves it, which only a delivery downstream can do:
// `startBeltFlowWatch`'s `headCleared`).
//
// Each leg is walked on two rows of one board: at camera scale 1, then after the wheel has zoomed
// the camera below 1, every screen point read again after the zoom.
//
// RED FIRST (D-16): run once against the plan's start revision (frontend from a throwaway
// worktree with this spec copied in), both legs red (89-EVIDENCE.md, `LIVE_RED
// 89-finish-on-a-belt-start`).
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
const CARDINAL_NAME = ['N', 'E', 'S', 'W'] as const;
/** The Timer interval the Source runs on, in sim ticks. */
const FEED_EVERY = 16;
/** A belt's Tail port index on the wire (`Role::In`, declared first). */
const BELT_PORT_TAIL = 0;

/** A board row: the Source at SOURCE_X, B from B_START_X to the Sink input's doorstep. */
interface Row {
  name: string;
  y: number;
  floor: ReadonlyArray<readonly [number, number]>;
}
const SOURCE_X = 8;
const B_START_X = 15;
const SINK_X = 20;
const ROWS: readonly Row[] = [
  { name: 'at zoom 1', y: 7, floor: [[13, 9], [12, 9]] },
  { name: 'below zoom 1', y: 12, floor: [[13, 10], [12, 10]] },
];

/** "At" a point on the plot: the collar centre is device-pixel snapped, this absorbs that. */
const AT_PX = 2;

/** Every belt that plots a junction collar within AT_PX of `pt`, as `belt <id>`, by belt id. */
async function collarsAt(page: Page, pt: { x: number; y: number }): Promise<string[]> {
  const out: string[] = [];
  for (const b of (await readScene(page)).belts) {
    const near = (await beltCollarCentresOn(page, b.id)).some((c) => Math.hypot(c.x - pt.x, c.y - pt.y) <= AT_PX);
    if (near) out.push(`belt ${b.id}`);
  }
  return out.sort();
}

/**
 * Build a row: a Source facing East on a Timer and a Sink facing West, and belt B drawn by a hand
 * drag from open floor at B_START_X onto the Sink's input dot (its Head docked, its Tail free).
 * Returns B's cells, Tail first.
 */
async function buildRow(page: Page, row: Row): Promise<Array<[number, number]>> {
  const sourceCell: [number, number] = [SOURCE_X, row.y];
  const sinkCell: [number, number] = [SINK_X, row.y];
  await place(page, 'Source', KIND_SOURCE, sourceCell, row.name);
  await place(page, 'Sink', KIND_SINK, sinkCell, row.name);
  await selectMachineAt(page, ...sourceCell);
  await turnUntilFacing(page, sourceCell, ROLE_OUT, E, `${row.name}: the Source's output`);
  await pressSegment(page, 'Trigger', 'Timer');
  await fillPanelField(page, 'fab-timer-interval', String(FEED_EVERY));
  await applyConfig(page);
  await selectMachineAt(page, ...sinkCell);
  await turnUntilFacing(page, sinkCell, ROLE_IN, W, `${row.name}: the Sink's input`);
  await deselectOnFloor(page, row.floor, `${row.name}: after the turns`);
  const sinkIn = portOf(await readScene(page), sinkCell, ROLE_IN)!;
  const bCells = rowCells(B_START_X, doorstep(sinkIn)[0], row.y);
  await page.getByTitle(/^Draw belts/).click();
  const start = await cellPoint(page, B_START_X, row.y, 0.3, 0.45);
  const nub = nubAnchor(sinkIn.cell_x, sinkIn.cell_y, sinkIn.side);
  const end = await screenPoint(page, { x: nub.x - 3, y: nub.y + 2 });
  await handDragBetween(page, start, end);
  await page.keyboard.press('Escape');
  const sink = nodeAtAnchor(await readScene(page), ...sinkCell)!;
  await pollScene(
    page,
    (s) =>
      beltOn(s, bCells)
        ?.docks.map((d) => `${d.end}@${d.node === sink.id ? 'sink' : d.node}`)
        .join(',') ?? 'no belt B',
    { message: `${row.name}: belt B on ${JSON.stringify(bCells)}, its Head docked to the Sink and its Tail free` },
  ).toBe('Head@sink');
  return bCells;
}

/**
 * Arm the Belt tool and draw A by a hand drag from the Source output's doorstep to `releaseCell`,
 * then grade A's docks, B's first tile and the flow through both.
 */
async function drawOntoB(
  page: Page,
  row: Row,
  bCells: ReadonlyArray<readonly [number, number]>,
  releaseCell: readonly [number, number],
  fx: number,
): Promise<void> {
  const soft = expect.configure({ soft: true });
  const s0 = await readScene(page);
  const source = nodeAtAnchor(s0, SOURCE_X, row.y)!;
  const outDoor = doorstep(portOf(s0, [SOURCE_X, row.y], ROLE_OUT)!);
  const b = beltOn(s0, bCells)!;
  const aCells = rowCells(outDoor[0], bCells[0][0] - 1, row.y);
  // The A|B seam: the midpoint of the edge B's first tile shares with the cell before it, where
  // the collar of the belt that feeds B is plotted (`beltSeamPoint`).
  const seam = { x: bCells[0][0] * CELL, y: (row.y + 0.5) * CELL };
  const collarBefore = await collarsAt(page, seam);
  expect(collarBefore, `${row.name}: NON-VACUITY: no junction collar is plotted at the A|B seam before A is drawn`).toEqual([]);
  await startBeltFlowWatch(page);
  await page.getByTitle(/^Draw belts/).click();
  const start = await cellPoint(page, outDoor[0], outDoor[1], 0.4, 0.55);
  const end = await cellPoint(page, releaseCell[0], releaseCell[1], fx, 0.45);
  const tags = await page.evaluate((ps) => ps.map((q) => document.elementFromPoint(q.x, q.y)?.tagName ?? null), [start, end]);
  expect(tags, `${row.name}: the drag starts and ends on the canvas, not under chrome`).toEqual(['CANVAS', 'CANVAS']);
  const moves = await handDragBetween(page, start, end);
  await page.keyboard.press('Escape');
  expect(moves, `${row.name}: the drag moved through several samples, not one teleport`).toBeGreaterThanOrEqual(3);

  // A on the cells before B's first tile, its Head docked to B's Tail (port 0), its Tail to the
  // Source: the same Dock a selected-belt Head handle dropped on B's Tail sends.
  await pollScene(
    page,
    (s) =>
      beltOn(s, aCells)
        ?.docks.map((d) => `${d.end}@${d.node === source.id ? 'source' : d.node === b.id ? `B:${d.port}` : d.node}`)
        .sort()
        .join(',') ?? `no belt on ${JSON.stringify(aCells)}`,
    {
      message: `${row.name}: belt A on ${JSON.stringify(aCells)} (B's first tile not in it), its Head docked to B's Tail and its Tail to the Source`,
    },
  ).toBe(`Head@B:${BELT_PORT_TAIL},Tail@source`);
  const a = beltOn(await readScene(page), aCells)!;
  console.log(`P89-W248 ${row.name}: release=${JSON.stringify(releaseCell)} A=${a.id} docks=${JSON.stringify(a.docks)} B=${b.id}`);

  // The seam the user looks at: the junction collar is plotted where A meets B, drawn by A (the
  // upstream Head owns the collar). Red with the collar branch of `rebuildEnds` skipped, every
  // dock read above still green (89-REVIEW-DISPOSITION.md, CR-C-01).
  await expect
    .poll(async () => JSON.stringify(await collarsAt(page, seam)), {
      timeout: addWaitBudget(frameBudgetMs(DRAWN_STATE_FRAMES), `${row.name}: the seam collar read`),
      intervals: [100, 250, 500],
      message: `${row.name}: the junction collar is plotted at the A|B seam ${JSON.stringify(seam)}, drawn by A`,
    })
    .toBe(JSON.stringify([`belt ${a.id}`]));

  // B's first tile still ships its straight kind and its tread still points East: the join did
  // not damage B. Not the seam grade (B was drawn straight, so both held before the join).
  await soft
    .poll(async () => tileKindAt(await readScene(page), bCells[0][0], bCells[0][1]), {
      timeout: addWaitBudget(frameBudgetMs(DRAWN_STATE_FRAMES), `${row.name}: B's first tile kind read`),
      intervals: [100, 250, 500],
      message: `${row.name}: B's first tile still ships Straight on X after the join`,
    })
    .toEqual({ Straight: { axis: 0 } });
  await soft
    .poll(
      async () => {
        const r = await treadRotationAt(page, bCells[0]);
        return r === null ? 'no tile drawn' : CARDINAL_NAME[cardinalOfRotation(r)];
      },
      {
        timeout: addWaitBudget(frameBudgetMs(DRAWN_STATE_FRAMES), `${row.name}: B's first tread read`),
        intervals: [100, 250, 500],
        message: `${row.name}: the tread drawn on B's first tile still points East after the join`,
      },
    )
    .toBe(CARDINAL_NAME[E]);

  // Items flow through both: A's head-most item leaves A (into B), and B's leaves B (into the Sink).
  await expect
    .poll(
      async () => {
        const w = await readBeltFlowWatch(page);
        return `A:${w.headCleared.includes(a.id)} B:${w.headCleared.includes(b.id)}`;
      },
      {
        timeout: 30_000,
        intervals: [250, 500, 1000],
        message: `${row.name}: items flow through A into B and through B into the Sink`,
      },
    )
    .toBe('A:true B:true');
  await stopBeltFlowWatch(page);
  await expectRenderLoopAlive(page, `after the ${row.name} draw`);
}

/** Build both rows, then walk the leg at scale 1 on the first and below 1 on the second. */
async function walk(page: Page, release: (row: Row, bCells: ReadonlyArray<readonly [number, number]>) => [readonly [number, number], number]): Promise<void> {
  const cells = ROWS.flatMap((r) => [[SOURCE_X, r.y] as const, [B_START_X, r.y] as const, [SINK_X, r.y] as const, ...r.floor]);
  await emptyBoardAtScaleOne(page, cells);
  const bs: Array<Array<[number, number]>> = [];
  for (const row of ROWS) bs.push(await buildRow(page, row));
  await expectRenderLoopAlive(page, 'with both rows built');
  for (let i = 0; i < ROWS.length; i += 1) {
    const row = ROWS[i];
    const [cell, fx] = release(row, bs[i]);
    if (i === 0) {
      expect((await cameraOf(page)).scale, `${row.name}: drawn at camera scale 1`).toBe(1);
    } else {
      const scale = await zoomBelowOne(page, cell);
      console.log(`P89-W248 ${row.name}: camera scale ${scale}`);
    }
    await drawOntoB(page, row, bs[i], cell, fx);
  }
}

test.describe("89 live: a belt draw finished on another belt's start docks to it (BELT-04, W248)", () => {
  let errs: ReturnType<typeof watchPageErrors>;

  test.beforeEach(async ({ page }) => {
    errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
  });

  test.afterEach(async ({ page }, testInfo) => {
    try {
      await stopBeltFlowWatch(page).catch(() => undefined);
      await expectRenderLoopAlive(page, 'at the end of the test');
      errs.assertNone('the finish-on-a-belt-start walk');
    } finally {
      await restoreHostAfterFailedTest(page, testInfo);
    }
  });

  test("1: released on another belt's first tile, the new belt's Head docks that belt's Tail", async ({ page }) => {
    // Inside B's first tile, off-centre: inside its Tail end's hit radius.
    await walk(page, (_row, b) => [b[0], 0.6]);
  });

  test("2: released one cell short of another belt's first tile, the new belt's Head docks that belt's Tail", async ({
    page,
  }) => {
    // Inside the cell before B's first tile, just past its centre: out of B's Tail radius, so the
    // auto-dock takes it.
    await walk(page, (row, b) => [[b[0][0] - 1, row.y] as const, 0.55]);
  });
});
