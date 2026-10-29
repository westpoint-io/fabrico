import { test, expect, type Page } from '@playwright/test';
import { addWaitBudget, frameBudgetMs } from '../e2e/support/frameSampler';
import {
  CELL,
  DRAWN_STATE_FRAMES,
  applyConfig,
  fillPanelField,
  pressSegment,
  cameraOf,
  clickAt,
  drawBeltThroughCells,
  expectRenderLoopAlive,
  handDragBetween,
  nodeAtAnchor,
  pollScene,
  readBeltFlowWatch,
  readScene,
  restoreHostAfterFailedTest,
  screenCellCentre,
  selectMachineAt,
  startBeltFlowWatch,
  stopBeltFlowWatch,
  targetRingsPlotted,
  waitForAppReady,
  watchPageErrors,
  type SceneFacts,
} from './support/oracle';
import { cardinalOfRotation, doorstep, portOf, beltOn, rowCells, cellPoint, emptyBoardAtScaleOne, place, turnUntilFacing, deselectOnFloor, zoomBelowOne, treadRotationAt } from './support/beltBoard';
import { PORT_STATUS } from '../src/chrome/configCopy';

// 89-belt-from-an-input.live.spec.ts (phase 89, plan 89-05, BELT-01, success criterion 1, D-02,
// UI-SPEC 1.1 and 1.2, walk step 1; the gesture walk 114 found backwards) - a belt drawn by
// pressing on a machine's INPUT flows into that input and docks at both ends, on the REAL host
// (dev_render_server, real Core -> RenderProducer -> postcard -> WS). Zero mocks, zero injected
// packets: the machines are placed and turned with the shipped palette and `r` key, and the belt
// under test is drawn with the shipped Belt tool by a hand drag.
//
// ---------------------------------------------------------------------------
// WHAT WAS BROKEN (89-MEASURE.md `## BELT-01: still broken`)
// ---------------------------------------------------------------------------
//
// The draw treated the press end as the belt's Tail and the release end as its Head
// unconditionally, and an In's doorstep was no press target. A belt pressed on a Sink's input
// and dragged to a Factory's output was drawn flowing OUT of the Sink toward the Factory, with
// no dock at either end, and the Sink's input wore no start ring while the Belt tool was armed.
// D-02: a press on a free Mechanical In's doorstep starts a REVERSED draw, its Head docked into
// the pressed In and its Tail into the Out the hand is released on; released on floor it still
// flows into the pressed In, its Tail free. The In's doorstep wears the start ring.
//
// ---------------------------------------------------------------------------
// THE LEGS, GRADED ON WHAT THE EYE SEES
// ---------------------------------------------------------------------------
//
//   1. A Source feeds a 3x3 Factory (a board-building belt, `drawBeltThroughCells`); a Sink
//      stands five cells East of the Factory's output. With the Belt tool armed the start ring
//      is PLOTTED on the Sink input's doorstep (`targetRingsPlotted`, read off the ring
//      Graphics). A hand drag (`handDragBetween`, many sub-cell samples, six cells) from that
//      doorstep to the Factory output's doorstep makes ONE belt: its Tail docked to the Factory,
//      its Head docked to the Sink; the belt panel, the Factory's output row and the Sink's
//      input row read connected (`idle` or `<n> moving`, never `not connected`); the tread drawn
//      on a middle tile points East, toward the Sink (`beltTreadRotationAt`); and items reach the
//      Sink (the belt's head-most item leaves it, which only a delivery into the docked Sink can
//      do: `startBeltFlowWatch`'s `headCleared`).
//   2. A Sink alone. The same press on its input's doorstep, dragged West over four cells and
//      released on empty floor: ONE belt, its Head docked to the Sink, its Tail free; the Sink's
//      input row reads connected and the belt's input row reads `not connected`; the tread
//      points East, into the Sink.
//
// Each leg is walked twice on one board: once at camera scale 1 and once after the wheel has
// zoomed the camera below 1 (where the hit radii and the cell size on screen change), every
// screen point read again after the zoom.
//
// RED FIRST (D-16): run once against the plan's start revision (frontend from a throwaway
// worktree with this spec copied in), both legs red (89-EVIDENCE.md, `LIVE_RED
// 89-belt-from-an-input`).
//
// Render health in every test: `watchPageErrors` before `goto`, `expectRenderLoopAlive` and the
// watcher's `assertNone` after every test (fabrico-model-oracle-blindspot).

/** Wire kinds (kinds.ts). */
const KIND_SOURCE = 0;
const KIND_FACTORY = 2;
const KIND_SINK = 7;
/** Port roles (oracle `PortFacts.role`). */
const ROLE_IN = 0;
const ROLE_OUT = 1;
/** Sides, the wire's numbering (y-down). */
const E = 1;
const W = 3;
const CARDINAL_NAME = ['N', 'E', 'S', 'W'] as const;
/**
 * A connected port row's status word (`PortsSection.tsx`, phase 91 `PORT_STATUS`): `idle` when
 * something is attached and still, `moving` when items flow on it, `backed up` when its head item
 * cannot leave. A row that reads `not connected` matches none of them.
 */
const CONNECTED_IDLE = PORT_STATUS.idle;
const CONNECTED_STATUS = new RegExp(`, (${PORT_STATUS.idle}|${PORT_STATUS.moving}|${PORT_STATUS.backedUp})$`);

/** One board row a leg is walked on: the machines' anchor cells and a floor cell to deselect on. */
interface Row {
  name: string;
  /** The row the belt runs along. */
  y: number;
  /** Two empty floor cells beside the row, the first one on the open canvas is clicked to deselect. */
  floor: ReadonlyArray<readonly [number, number]>;
}
/** The Source's anchor column, the Factory's anchor column (3x3) and the Sink's column. */
const SOURCE_X = 8;
const FACTORY_X = 11;
const SINK_X = 20;
const ROWS: readonly Row[] = [
  { name: 'at zoom 1', y: 7, floor: [[16, 9], [17, 9]] },
  { name: 'below zoom 1', y: 12, floor: [[16, 10], [17, 10]] },
];
/** The Timer interval each Source runs on, in sim ticks. */
const FEED_EVERY = 16;
/** The floor leg's release column: four cells West of the Sink input's doorstep. */
const FLOOR_RELEASE_X = 16;

type NodeFacts = SceneFacts['nodes'][number];
type BeltFacts = SceneFacts['belts'][number];

/** `Head@<who>,Tail@<who>`, sorted, naming the machines by role in the leg; or `no belt`. */
function docksOf(belt: BeltFacts | undefined, names: ReadonlyMap<number, string>): string {
  if (belt === undefined) return 'no belt on the drawn cells';
  return belt.docks
    .map((d) => `${d.end}@${names.get(d.node) ?? d.node}`)
    .sort()
    .join(',');
}

/**
 * The start ring the overlay PLOTTED on `cell`'s centre, read off the ring Graphics: true when a
 * resting ring is drawn there.
 */
async function startRingPlottedOn(page: Page, cell: readonly [number, number]): Promise<boolean> {
  const c = { x: (cell[0] + 0.5) * CELL, y: (cell[1] + 0.5) * CELL };
  const rings = await targetRingsPlotted(page);
  return rings.resting.some((r) => Math.abs(r.x - c.x) <= 1 && Math.abs(r.y - c.y) <= 1);
}

/** The belt panel is open and every one of its port rows reads connected, or the named rows do. */
async function selectBeltOn(page: Page, cell: readonly [number, number], what: string): Promise<void> {
  const pt = await screenCellCentre(page, cell[0], cell[1]);
  await expect
    .poll(() => page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.tagName ?? 'NONE', [pt.x, pt.y] as const), {
      message: `${what}: the belt's middle tile is on the open board before it is clicked`,
    })
    .toBe('CANVAS');
  await clickAt(page, pt.x, pt.y);
  await expect(page.locator('#fab-belt-config'), `${what}: clicking the belt's middle tile selected the belt`).toBeVisible();
}

const portsRegion = (page: Page) => page.getByRole('region', { name: 'Ports' });

/** Build a Source feeding a Factory, and a Sink East of the Factory's output, on `row`. */
async function buildFactoryRow(page: Page, row: Row): Promise<{ source: NodeFacts; factory: NodeFacts; sink: NodeFacts }> {
  const sourceCell: [number, number] = [SOURCE_X, row.y];
  const factoryCell: [number, number] = [FACTORY_X, row.y - 1];
  const sinkCell: [number, number] = [SINK_X, row.y];
  await place(page, 'Factory', KIND_FACTORY, factoryCell, row.name);
  await place(page, 'Source', KIND_SOURCE, sourceCell, row.name);
  await place(page, 'Sink', KIND_SINK, sinkCell, row.name);
  await selectMachineAt(page, ...factoryCell);
  await turnUntilFacing(page, factoryCell, ROLE_OUT, E, `${row.name}: the Factory's output`);
  expect(portOf(await readScene(page), factoryCell, ROLE_IN)?.side, `${row.name}: the Factory's input faces West`).toBe(W);
  await selectMachineAt(page, ...sourceCell);
  await turnUntilFacing(page, sourceCell, ROLE_OUT, E, `${row.name}: the Source's output`);
  // The Source on a Timer, so items flow once the Factory's output is connected.
  await pressSegment(page, 'Trigger', 'Timer');
  await fillPanelField(page, 'fab-timer-interval', String(FEED_EVERY));
  await applyConfig(page);
  await selectMachineAt(page, ...sinkCell);
  await turnUntilFacing(page, sinkCell, ROLE_IN, W, `${row.name}: the Sink's input`);
  await deselectOnFloor(page, row.floor, `${row.name}: after the turns`);
  // The board-building belt: the Source feeds the Factory (drawn forward, Out to In).
  const s = await readScene(page);
  const out = portOf(s, sourceCell, ROLE_OUT)!;
  const into = portOf(s, factoryCell, ROLE_IN)!;
  const feedCells = rowCells(doorstep(out)[0], doorstep(into)[0], row.y);
  await drawBeltThroughCells(page, out, feedCells, into);
  const scene = await readScene(page);
  const source = nodeAtAnchor(scene, ...sourceCell)!;
  const factory = nodeAtAnchor(scene, ...factoryCell)!;
  const sink = nodeAtAnchor(scene, ...sinkCell)!;
  const names = new Map([
    [source.id, 'source'],
    [factory.id, 'factory'],
  ]);
  await pollScene(page, (st) => docksOf(beltOn(st, feedCells), names), {
    message: `${row.name}: the Source feeds the Factory`,
  }).toBe('Head@factory,Tail@source');
  return { source, factory, sink };
}

/**
 * Arm the Belt tool, grade the start ring on the Sink input's doorstep, and drag a hand from that
 * doorstep to `releaseCell`. Returns the cells the drag crossed, from the release to the doorstep
 * (the belt's Tail first, as the host stores it).
 */
async function dragFromSinkInput(
  page: Page,
  row: Row,
  sink: NodeFacts,
  releaseCell: readonly [number, number],
): Promise<Array<[number, number]>> {
  const soft = expect.configure({ soft: true });
  const inPort = sink.ports.find((p) => p.role === ROLE_IN)!;
  const inDoor = doorstep(inPort);
  await page.getByTitle(/^Draw belts/).click();
  // Soft, so a red run names this read and the docks below in one go.
  await soft
    .poll(() => startRingPlottedOn(page, inDoor), {
      timeout: addWaitBudget(frameBudgetMs(DRAWN_STATE_FRAMES), `${row.name}: the start ring read`),
      intervals: [100, 250, 500],
      message: `${row.name}: with the Belt tool armed the start ring is plotted on the Sink input's doorstep (${inDoor.join(',')})`,
    })
    .toBe(true);
  // Pressed off-centre inside the doorstep, released off-centre inside the release cell.
  const start = await cellPoint(page, inDoor[0], inDoor[1], 0.35, 0.6);
  const end = await cellPoint(page, releaseCell[0], releaseCell[1], 0.62, 0.4);
  const tags = await page.evaluate((ps) => ps.map((q) => document.elementFromPoint(q.x, q.y)?.tagName ?? null), [start, end]);
  expect(tags, `${row.name}: the drag starts and ends on the canvas, not under chrome`).toEqual(['CANVAS', 'CANVAS']);
  const moves = await handDragBetween(page, start, end);
  expect(moves, `${row.name}: the drag moved through several samples, not one teleport`).toBeGreaterThanOrEqual(3);
  await page.keyboard.press('Escape');
  return rowCells(releaseCell[0], inDoor[0], row.y);
}

/** The tread drawn on `cell` points `cardinal`, polled to the drawn-state budget. */
async function expectTread(page: Page, cell: readonly [number, number], cardinal: number, why: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const r = await treadRotationAt(page, cell);
        return r === null ? 'no tile drawn' : CARDINAL_NAME[cardinalOfRotation(r)];
      },
      {
        timeout: addWaitBudget(frameBudgetMs(DRAWN_STATE_FRAMES), why),
        intervals: [100, 250, 500],
        message: why,
      },
    )
    .toBe(CARDINAL_NAME[cardinal]);
}

test.describe('89 live: a belt drawn from an input flows into it and docks at both ends (BELT-01)', () => {
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
      errs.assertNone('the belt-from-an-input walk');
    } finally {
      await restoreHostAfterFailedTest(page, testInfo);
    }
  });

  test('1: a belt pressed on a Sink input and released on a Factory output docks at both ends and delivers', async ({ page }) => {
    const cells = ROWS.flatMap((r) => [
      [SOURCE_X, r.y] as const,
      [FACTORY_X + 1, r.y] as const,
      [SINK_X, r.y] as const,
      ...r.floor,
    ]);
    await emptyBoardAtScaleOne(page, cells);
    const built: Array<{ source: NodeFacts; factory: NodeFacts; sink: NodeFacts }> = [];
    for (const row of ROWS) built.push(await buildFactoryRow(page, row));
    await expectRenderLoopAlive(page, 'with both rows built');

    for (let i = 0; i < ROWS.length; i += 1) {
      const row = ROWS[i];
      const { factory, sink } = built[i];
      const outPort = factory.ports.find((p) => p.role === ROLE_OUT)!;
      const outDoor = doorstep(outPort);
      if (i === 0) {
        expect((await cameraOf(page)).scale, `${row.name}: drawn at camera scale 1`).toBe(1);
      } else {
        const scale = await zoomBelowOne(page, outDoor);
        console.log(`P89-BELT-01 ${row.name}: camera scale ${scale}`);
      }
      await startBeltFlowWatch(page);
      const drawn = await dragFromSinkInput(page, row, sink, outDoor);
      const names = new Map([
        [factory.id, 'factory'],
        [sink.id, 'sink'],
      ]);
      // ONE belt on the drawn cells, Tail at the Factory output, Head at the Sink input.
      await pollScene(page, (s) => docksOf(beltOn(s, drawn), names), {
        message: `${row.name}: one belt from the Factory output's doorstep to the Sink input's doorstep (${JSON.stringify(drawn)}), its Tail docked to the Factory and its Head to the Sink`,
      }).toBe('Head@sink,Tail@factory');
      const belt = beltOn(await readScene(page), drawn)!;
      console.log(`P89-BELT-01 ${row.name}: belt ${belt.id} tiles=${JSON.stringify(drawn)} docks=${JSON.stringify(belt.docks)}`);

      // The tread drawn on a middle tile points East, toward the Sink.
      const middle = drawn[Math.floor(drawn.length / 2)];
      await expectTread(page, middle, E, `${row.name}: the tread drawn on (${middle.join(',')}) points East, toward the Sink`);

      // Items reach the Sink: the belt's head-most item leaves it, which only a delivery into the
      // docked Sink can do.
      await expect
        .poll(async () => (await readBeltFlowWatch(page)).headCleared.includes(belt.id), {
          timeout: 30_000,
          intervals: [250, 500, 1000],
          message: `${row.name}: items reach the Sink through belt ${belt.id} (its head-most item is taken by the Sink)`,
        })
        .toBe(true);
      await stopBeltFlowWatch(page);

      // The three panels read connected.
      await selectBeltOn(page, middle, row.name);
      await expect(
        portsRegion(page).getByRole('listitem', { name: /not connected/ }),
        `${row.name}: no row of the new belt's panel reads not connected`,
      ).toHaveCount(0);
      await expect(
        portsRegion(page).getByRole('listitem', { name: CONNECTED_STATUS }),
        `${row.name}: both of the new belt's port rows read ${CONNECTED_IDLE} or moving`,
      ).toHaveCount(2);
      await selectMachineAt(page, FACTORY_X, row.y - 1);
      await expect(
        portsRegion(page).getByRole('listitem', { name: new RegExp(`^Output[^,]*${CONNECTED_STATUS.source}`) }),
        `${row.name}: the Factory's output row reads ${CONNECTED_IDLE} or moving, never not connected`,
      ).toHaveCount(1);
      await selectMachineAt(page, SINK_X, row.y);
      await expect(
        portsRegion(page).getByRole('listitem', { name: new RegExp(`^Input[^,]*${CONNECTED_STATUS.source}`) }),
        `${row.name}: the Sink's input row reads ${CONNECTED_IDLE} or moving, never not connected`,
      ).toHaveCount(1);
      await deselectOnFloor(page, row.floor, `${row.name}: after the panels`);
      await expectRenderLoopAlive(page, `after the ${row.name} draw`);
    }
  });

  test('2: a belt pressed on a Sink input and released on empty floor flows into the Sink, its Tail free', async ({ page }) => {
    const cells = ROWS.flatMap((r) => [[SINK_X, r.y] as const, [FLOOR_RELEASE_X, r.y] as const, ...r.floor]);
    await emptyBoardAtScaleOne(page, cells);
    for (const row of ROWS) {
      await place(page, 'Sink', KIND_SINK, [SINK_X, row.y], row.name);
      await selectMachineAt(page, SINK_X, row.y);
      await turnUntilFacing(page, [SINK_X, row.y], ROLE_IN, W, `${row.name}: the Sink's input`);
      await deselectOnFloor(page, row.floor, `${row.name}: after the turn`);
    }
    await expectRenderLoopAlive(page, 'with both Sinks placed');

    for (let i = 0; i < ROWS.length; i += 1) {
      const row = ROWS[i];
      const sink = nodeAtAnchor(await readScene(page), SINK_X, row.y)!;
      if (i === 0) {
        expect((await cameraOf(page)).scale, `${row.name}: drawn at camera scale 1`).toBe(1);
      } else {
        const scale = await zoomBelowOne(page, [FLOOR_RELEASE_X, row.y]);
        console.log(`P89-BELT-01-FLOOR ${row.name}: camera scale ${scale}`);
      }
      const drawn = await dragFromSinkInput(page, row, sink, [FLOOR_RELEASE_X, row.y]);
      const names = new Map([[sink.id, 'sink']]);
      await pollScene(page, (s) => docksOf(beltOn(s, drawn), names), {
        message: `${row.name}: one belt from the floor to the Sink input's doorstep (${JSON.stringify(drawn)}), its Head docked to the Sink and its Tail free`,
      }).toBe('Head@sink');
      const middle = drawn[Math.floor(drawn.length / 2)];
      await expectTread(page, middle, E, `${row.name}: the tread drawn on (${middle.join(',')}) points East, into the Sink`);
      await selectBeltOn(page, middle, row.name);
      await expect(
        portsRegion(page).getByRole('listitem', { name: CONNECTED_STATUS }),
        `${row.name}: exactly one of the belt's rows (its output, into the Sink) reads ${CONNECTED_IDLE} or moving`,
      ).toHaveCount(1);
      await expect(
        portsRegion(page).getByRole('listitem', { name: /not connected/ }),
        `${row.name}: the belt's input row reads not connected (its Tail is free)`,
      ).toHaveCount(1);
      await selectMachineAt(page, SINK_X, row.y);
      await expect(
        portsRegion(page).getByRole('listitem', { name: new RegExp(`^Input[^,]*${CONNECTED_STATUS.source}`) }),
        `${row.name}: the Sink's input row reads ${CONNECTED_IDLE}, never not connected`,
      ).toHaveCount(1);
      await deselectOnFloor(page, row.floor, `${row.name}: after the panels`);
      await expectRenderLoopAlive(page, `after the ${row.name} floor draw`);
    }
  });
});
