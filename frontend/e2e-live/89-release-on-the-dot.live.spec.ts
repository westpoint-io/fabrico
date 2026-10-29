import { test, expect, type Page } from '@playwright/test';
import { addWaitBudget, frameBudgetMs } from '../e2e/support/frameSampler';
import {
  CELL,
  DRAWN_STATE_FRAMES,
  beltPreviewPlottedOf,
  cameraOf,
  expectRefusalStayedSilent,
  expectRenderLoopAlive,
  handDragBetween,
  nodeAtAnchor,
  nubAnchor,
  pollScene,
  readScene,
  restoreHostAfterFailedTest,
  screenPoint,
  selectMachineAt,
  waitForAppReady,
  watchPageErrors,
  type SceneFacts,
} from './support/oracle';
import { doorstep, portOf, beltOn, rowCells, cellPoint, emptyBoardAtScaleOne, place, turnUntilFacing, deselectOnFloor, zoomTo } from './support/beltBoard';
import { PORT_STATUS } from '../src/chrome/configCopy';

// 89-release-on-the-dot.live.spec.ts (phase 89, plan 89-05, BELT-03, success criterion 1, WINDOWS
// 249, D-03, D-04, UI-SPEC 1.3, walk step 2) - a belt released on the port's dot docks, and a
// near miss on a neighbour's dot never steals the dock the head faces, on the REAL host
// (dev_render_server, real Core -> RenderProducer -> postcard -> WS). Zero mocks, zero injected
// packets: the machines are placed and turned with the shipped palette and `r` key, and every belt
// is drawn with the shipped Belt tool by a hand drag.
//
// ---------------------------------------------------------------------------
// WHAT WAS BROKEN (89-MEASURE.md `## BELT-03` and `## BELT-03/W249`)
// ---------------------------------------------------------------------------
//
// An In's dot straddles its machine's edge, so the last sample of a real drag lands inside the
// dot and, half the time, inside the machine's own cell. The walk pushed that cell, the preview
// went red on the last samples, and the release sent NOTHING, with no flash and no sentence. And
// the release took the nearest In in reach before it ever asked the auto-dock, so a neighbour's
// Electrical In beside the doorstep the head faced took the Head slot: a Dock the host refused in
// words, and no dock to the In the belt actually reached. D-03: one shared trim drops the target
// machine's own trailing cells back to its doorstep, read by the preview and the release alike.
// D-04: an accepting hit first, else the one auto-dock target the head faces, else the nearest
// refused hit.
//
// ---------------------------------------------------------------------------
// THE LEGS, GRADED ON WHAT THE EYE SEES
// ---------------------------------------------------------------------------
//
//   1. A Merge's output to a Router's input, six cells along a row, the hand's final sample
//      4 world px inside the Router's West edge (inside the dot, inside the Router's own cell),
//      every sample sub-cell (`handDragBetween`). On EVERY sample the drag preview the overlay
//      PLOTTED is the build colour (`beltPreviewPlottedOf`, read off the preview Graphics), so the
//      belt the hand saw never turned red; one belt is minted on the six cells, its Head docked to
//      the Router's input and its Tail to the Merge; the Router's input row reads connected.
//   2. WINDOWS 249's corner board: a Source's output to a Sink's input, six cells along a row,
//      with a Route machine (its Electrical input facing South, its dot on the top edge of the
//      Sink input's doorstep) standing on the row above. The hand is released inside the Route's
//      dot and outside the Sink's: the Head docks the Sink, the input the head faces, and no
//      refusal sentence appears for the whole gesture (`expectRefusalStayedSilent`).
//
// Each leg is walked on two rows of one board: at camera scale 1, then after the wheel has zoomed
// the camera below 1 (to about 0.5 for leg 1, MEASURE's zoom, where the hit radius reaches 24
// world px into the machine), every screen point read again after the zoom.
//
// RED FIRST (D-16): run once against the plan's start revision (frontend from a throwaway
// worktree with this spec copied in), both legs red (89-EVIDENCE.md, `LIVE_RED
// 89-release-on-the-dot`).
//
// Render health in every test: `watchPageErrors` before `goto`, `expectRenderLoopAlive` and the
// watcher's `assertNone` after every test (fabrico-model-oracle-blindspot).

/** Wire kinds (kinds.ts). */
const KIND_SOURCE = 0;
const KIND_MERGE = 6;
const KIND_ROUTER = 5;
const KIND_SINK = 7;
const KIND_ENDPOINT = 9;
/** Port roles (oracle `PortFacts.role`). */
const ROLE_IN = 0;
const ROLE_OUT = 1;
/** Sides, the wire's numbering (y-down). */
const E = 1;
const S = 2;
const W = 3;
/**
 * A connected port row's status word (`PortsSection.tsx`, phase 91 `PORT_STATUS`): `idle` when
 * something is attached and still, `moving` when items flow on it, `backed up` when its head item
 * cannot leave. A row that reads `not connected` matches none of them.
 */
const CONNECTED_IDLE = PORT_STATUS.idle;
const CONNECTED_STATUS = new RegExp(`, (${PORT_STATUS.idle}|${PORT_STATUS.moving}|${PORT_STATUS.backedUp})$`);
/** The dot leg's release, world px inside the target machine's West edge. */
const INSIDE_PX = 4;

/** A board row a leg is walked on, and floor cells to deselect on. */
interface Row {
  name: string;
  y: number;
  /** The wheel stops once the scale is at or below this (1 means "stay at 1"). */
  zoomTo: number;
  floor: ReadonlyArray<readonly [number, number]>;
}

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

const portsRegion = (page: Page) => page.getByRole('region', { name: 'Ports' });

/** The selected machine's panel has an `Input` row that reads connected. */
async function expectInputConnected(page: Page, cell: readonly [number, number], what: string): Promise<void> {
  await selectMachineAt(page, cell[0], cell[1]);
  await expect(
    portsRegion(page).getByRole('listitem', { name: new RegExp(`^Input[^,]*${CONNECTED_STATUS.source}`) }),
    `${what}: an input row reads ${CONNECTED_IDLE} or moving, never not connected`,
  ).not.toHaveCount(0);
}

const DOT_ROWS: readonly Row[] = [
  { name: 'at zoom 1', y: 7, zoomTo: 1, floor: [[14, 10], [13, 10]] },
  { name: 'at zoom 0.5', y: 12, zoomTo: 0.55, floor: [[14, 9], [13, 9]] },
];
/** The Merge's anchor column (2x2) and the Router's (2x3). */
const MERGE_X = 9;
const ROUTER_X = 17;

const CORNER_ROWS: readonly Row[] = [
  { name: 'at zoom 1', y: 7, zoomTo: 1, floor: [[13, 10], [12, 10]] },
  { name: 'below zoom 1', y: 12, zoomTo: 0.8, floor: [[13, 9], [12, 9]] },
];
/** The corner board's Source, Sink and Route columns; the Route stands on the row above. */
const C_SOURCE_X = 10;
const C_SINK_X = 17;
const C_ROUTE_X = 16;

test.describe('89 live: a belt released on the dot docks, and the dot the head faces wins (BELT-03, W249)', () => {
  let errs: ReturnType<typeof watchPageErrors>;

  test.beforeEach(async ({ page }) => {
    errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
  });

  test.afterEach(async ({ page }, testInfo) => {
    try {
      await expectRenderLoopAlive(page, 'at the end of the test');
      errs.assertNone('the release-on-the-dot walk');
    } finally {
      await restoreHostAfterFailedTest(page, testInfo);
    }
  });

  test('1: a Merge to Router belt released 4 px inside the Router edge stays blue and docks', async ({ page }) => {
    // The Router is placed first, its input row read off the scene, and the Merge placed so
    // its output is on that row.
    const cells = DOT_ROWS.flatMap((r) => [[MERGE_X, r.y] as const, [ROUTER_X, r.y] as const, ...r.floor]);
    await emptyBoardAtScaleOne(page, cells);
    const boards: Array<{ merge: NodeFacts; router: NodeFacts; mergeCell: [number, number]; routerCell: [number, number] }> = [];
    for (const row of DOT_ROWS) {
      const routerCell: [number, number] = [ROUTER_X, row.y - 1];
      await place(page, 'Router', KIND_ROUTER, routerCell, row.name);
      await selectMachineAt(page, ...routerCell);
      await turnUntilFacing(page, routerCell, ROLE_IN, W, `${row.name}: the Router's input`);
      await deselectOnFloor(page, row.floor, `${row.name}: after the Router turn`);
      const routerIn = portOf(await readScene(page), routerCell, ROLE_IN)!;
      expect(routerIn.cell_y, `${row.name}: the Router's input is on the leg's row`).toBe(row.y);
      const mergeCell: [number, number] = [MERGE_X, row.y];
      await place(page, 'Merge', KIND_MERGE, mergeCell, row.name);
      await selectMachineAt(page, ...mergeCell);
      await turnUntilFacing(page, mergeCell, ROLE_OUT, E, `${row.name}: the Merge's output`);
      await deselectOnFloor(page, row.floor, `${row.name}: after the Merge turn`);
      const s = await readScene(page);
      expect(portOf(s, mergeCell, ROLE_OUT)!.cell_y, `${row.name}: the Merge's output is on the leg's row`).toBe(row.y);
      boards.push({ merge: nodeAtAnchor(s, ...mergeCell)!, router: nodeAtAnchor(s, ...routerCell)!, mergeCell, routerCell });
    }
    await expectRenderLoopAlive(page, 'with both boards built');

    for (let i = 0; i < DOT_ROWS.length; i += 1) {
      const row = DOT_ROWS[i];
      const { merge, router, routerCell } = boards[i];
      const s = await readScene(page);
      const outDoor = doorstep(portOf(s, boards[i].mergeCell, ROLE_OUT)!);
      const routerIn = portOf(s, routerCell, ROLE_IN)!;
      const inDoor = doorstep(routerIn);
      if (row.zoomTo === 1) {
        expect((await cameraOf(page)).scale, `${row.name}: drawn at camera scale 1`).toBe(1);
      } else {
        const scale = await zoomTo(page, inDoor, row.zoomTo);
        console.log(`P89-DOT ${row.name}: camera scale ${scale}`);
      }
      await page.getByTitle(/^Draw belts/).click();
      // Pressed off-centre in the Merge output's doorstep; the final sample 4 world px inside the
      // Router's West edge, on the input's row: inside its dot and inside its own cell.
      const start = await cellPoint(page, outDoor[0], outDoor[1], 0.4, 0.55);
      const end = await screenPoint(page, { x: routerIn.cell_x * CELL + INSIDE_PX, y: (row.y + 0.55) * CELL });
      const dotNub = await screenPoint(page, nubAnchor(routerIn.cell_x, routerIn.cell_y, routerIn.side));
      const tags = await page.evaluate((ps) => ps.map((q) => document.elementFromPoint(q.x, q.y)?.tagName ?? null), [start, end]);
      expect(tags, `${row.name}: the drag starts and ends on the canvas, not under chrome`).toEqual(['CANVAS', 'CANVAS']);
      const plotted: Array<{ step: number; valid: boolean | null }> = [];
      const moves = await handDragBetween(page, start, end, async (step) => {
        const p = await beltPreviewPlottedOf(page);
        plotted.push({ step, valid: p === null ? null : p.valid });
      });
      await page.keyboard.press('Escape');
      expect(moves, `${row.name}: the drag moved through several samples, not one teleport`).toBeGreaterThanOrEqual(3);
      const notBlue = plotted.filter((p) => p.valid !== true);
      console.log(
        `P89-DOT ${row.name}: moves=${moves} end_to_nub_px=${Math.hypot(end.x - dotNub.x, end.y - dotNub.y).toFixed(1)} not_blue=${JSON.stringify(notBlue)}`,
      );
      expect(notBlue, `${row.name}: the preview the overlay plotted was the build colour on every sample, the last included`).toEqual(
        [],
      );
      const drawn = rowCells(outDoor[0], inDoor[0], row.y);
      const names = new Map([
        [merge.id, 'merge'],
        [router.id, 'router'],
      ]);
      await pollScene(page, (st) => docksOf(beltOn(st, drawn), names), {
        message: `${row.name}: one belt on ${JSON.stringify(drawn)} (the Router's own cell not in it), its Head docked to the Router's input and its Tail to the Merge`,
      }).toBe('Head@router,Tail@merge');
      await expectInputConnected(page, routerCell, `${row.name}: the Router`);
      await deselectOnFloor(page, row.floor, `${row.name}: after the panel`);
      await expectRenderLoopAlive(page, `after the ${row.name} dot draw`);
    }
  });

  test('2: released inside a neighbour Route input dot, the belt docks the Sink input it faces, in silence', async ({
    page,
  }) => {
    const cells = CORNER_ROWS.flatMap((r) => [
      [C_SOURCE_X, r.y] as const,
      [C_SINK_X, r.y] as const,
      [C_ROUTE_X, r.y - 1] as const,
      ...r.floor,
    ]);
    await emptyBoardAtScaleOne(page, cells);
    for (const row of CORNER_ROWS) {
      const sourceCell: [number, number] = [C_SOURCE_X, row.y];
      const sinkCell: [number, number] = [C_SINK_X, row.y];
      const routeCell: [number, number] = [C_ROUTE_X, row.y - 1];
      await place(page, 'Source', KIND_SOURCE, sourceCell, row.name);
      await place(page, 'Sink', KIND_SINK, sinkCell, row.name);
      await place(page, 'Route', KIND_ENDPOINT, routeCell, row.name);
      await selectMachineAt(page, ...sourceCell);
      await turnUntilFacing(page, sourceCell, ROLE_OUT, E, `${row.name}: the Source's output`);
      await selectMachineAt(page, ...sinkCell);
      await turnUntilFacing(page, sinkCell, ROLE_IN, W, `${row.name}: the Sink's input`);
      await selectMachineAt(page, ...routeCell);
      await turnUntilFacing(page, routeCell, ROLE_IN, S, `${row.name}: the Route's input`);
      await deselectOnFloor(page, row.floor, `${row.name}: after the turns`);
      const routeIn = portOf(await readScene(page), routeCell, ROLE_IN)!;
      expect(routeIn.medium, `${row.name}: PRECONDITION: the Route's input is Electrical (a belt cannot dock it)`).toBe(1);
      expect(doorstep(routeIn), `${row.name}: PRECONDITION: the Route's input faces the Sink input's doorstep`).toEqual([
        C_SINK_X - 1,
        row.y,
      ]);
    }
    await expectRenderLoopAlive(page, 'with both corner boards built');

    for (let i = 0; i < CORNER_ROWS.length; i += 1) {
      const row = CORNER_ROWS[i];
      const s = await readScene(page);
      const source = nodeAtAnchor(s, C_SOURCE_X, row.y)!;
      const sink = nodeAtAnchor(s, C_SINK_X, row.y)!;
      const route = nodeAtAnchor(s, C_ROUTE_X, row.y - 1)!;
      const outDoor = doorstep(portOf(s, [C_SOURCE_X, row.y], ROLE_OUT)!);
      const routeIn = portOf(s, [C_ROUTE_X, row.y - 1], ROLE_IN)!;
      const sinkIn = portOf(s, [C_SINK_X, row.y], ROLE_IN)!;
      const inDoor = doorstep(sinkIn);
      if (row.zoomTo === 1) {
        expect((await cameraOf(page)).scale, `${row.name}: drawn at camera scale 1`).toBe(1);
      } else {
        const scale = await zoomTo(page, inDoor, row.zoomTo);
        console.log(`P89-W249 ${row.name}: camera scale ${scale}`);
      }
      await page.getByTitle(/^Draw belts/).click();
      // Released 3 world px East of and 3.5 below the Route's input dot, inside the Sink input's
      // doorstep cell: inside the Route's dot, outside the Sink's (18 world px from its centre).
      const routeNub = nubAnchor(routeIn.cell_x, routeIn.cell_y, routeIn.side);
      const sinkNub = nubAnchor(sinkIn.cell_x, sinkIn.cell_y, sinkIn.side);
      const releaseWorld = { x: routeNub.x + 3, y: routeNub.y + 3.5 };
      console.log(
        `P89-W249 ${row.name}: release=${JSON.stringify(releaseWorld)} to_route_dot=${Math.hypot(releaseWorld.x - routeNub.x, releaseWorld.y - routeNub.y).toFixed(1)} to_sink_dot=${Math.hypot(releaseWorld.x - sinkNub.x, releaseWorld.y - sinkNub.y).toFixed(1)}`,
      );
      const start = await cellPoint(page, outDoor[0], outDoor[1], 0.45, 0.6);
      const end = await screenPoint(page, releaseWorld);
      const tags = await page.evaluate((ps) => ps.map((q) => document.elementFromPoint(q.x, q.y)?.tagName ?? null), [start, end]);
      expect(tags, `${row.name}: the drag starts and ends on the canvas, not under chrome`).toEqual(['CANVAS', 'CANVAS']);
      const drawn = rowCells(outDoor[0], inDoor[0], row.y);
      const names = new Map([
        [source.id, 'source'],
        [sink.id, 'sink'],
        [route.id, 'route'],
      ]);
      await expectRefusalStayedSilent(page, `${row.name}: the W249 near-miss release`, async () => {
        const moves = await handDragBetween(page, start, end);
        expect(moves, `${row.name}: the drag moved through several samples, not one teleport`).toBeGreaterThanOrEqual(3);
        await pollScene(page, (st) => docksOf(beltOn(st, drawn), names), {
          message: `${row.name}: one belt on ${JSON.stringify(drawn)}, its Head docked to the Sink (the input the head faces, not the Route) and its Tail to the Source`,
        }).toBe('Head@sink,Tail@source');
        // A refused Dock would answer within a few ticks; give the silence a window past them.
        await page.waitForTimeout(addWaitBudget(frameBudgetMs(DRAWN_STATE_FRAMES * 4), `${row.name}: the silence window`));
      });
      await page.keyboard.press('Escape');
      await expectInputConnected(page, [C_SINK_X, row.y], `${row.name}: the Sink`);
      await deselectOnFloor(page, row.floor, `${row.name}: after the panel`);
      await expectRenderLoopAlive(page, `after the ${row.name} corner draw`);
    }
  });
});
