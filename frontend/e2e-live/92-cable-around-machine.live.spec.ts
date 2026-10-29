import { test, expect, type Page } from '@playwright/test';
import { PNG } from 'playwright-core/lib/utilsBundle';
import {
  cablePolylines,
  cameraOf,
  captureClip,
  deselectViaEmptyCell,
  expectRenderLoopAlive,
  handDrawWire,
  nodeAtAnchor,
  pollScene,
  readRerouteMarkSampler,
  readScene,
  rerouteMarkStrokes,
  resetToDemo,
  restoreHostAfterFailedTest,
  screenPoint,
  selectMachineAt,
  startRerouteMarkSampler,
  stopRerouteMarkSampler,
  waitForAppReady,
  watchPageErrors,
  wirePreviewPolylines,
  type PortFacts,
  type SceneFacts,
} from './support/oracle';
import { emptyBoardAtScaleOne, pauseAndSettle, place, portOf, resumeIfPaused, rowCells, type Cell } from './support/beltBoard';
import { CELL, nubAnchor } from '../shared/geometry';
import { CABLE_CELL_MIN, cablesOnCanvas } from './support/canvasDots';
import { LOCKED_SKIN } from '../src/render/synth/skins/locked';

// 92-cable-around-machine.live.spec.ts (phase 92, plan 92-03, CHROME-19, D-09, success criterion
// 2, UI-SPEC 4.1 and 4.3) - on the real dev host and the real Pixi renderer, a cable drawn between
// two machines goes around a third machine in its way.
//
// WHAT WAS BROKEN (92-MEASURE.md section 4, WINDOWS 192). Both cable routers knew only the two
// machines a cable joins, so a cable from a Route to an HTTP Handler with a Factory between them
// was drawn straight through the Factory. Plan 92-02 gave both routers the machine list
// (`wire_route_avoiding` and `wireRouteAvoiding`); plan 92-03 makes the render packet's landed
// cable and the drag preview call them with one list read off the same board.
//
// THE BOARD, the one `crates/fabrico-host/tests/cable_obstacles.rs` and the gesture-harness case
// `the ghost leg goes around a third machine` build: on an empty board at camera scale 1 and
// 1280x800, a palette Route at (8,8), a palette Factory (3x3) anchored at (12,7) and a palette HTTP
// Handler (3x3) anchored at (18,7). The Route's Out and the Handler's In both sit on row 8, so
// today's straight path runs through the Factory's middle row.
//
// THE LEGS
//   1. a landed cable leaves the Factory pixels alone. The board is paused, the Factory's screen
//      rectangle inset by the nub reach is captured, the wire is drawn by hand with the Wire tool
//      and folded by one Step, and the same rectangle is captured again: no pixel differs. The
//      same before-and-after pair over the whole board span outside that rectangle differs (the
//      cable did land), and the scene holds both legs docked at their ports. THE CABLE IS SEEN
//      (review WR-C-03): every run cell of the landed forward path, outside its two port cells,
//      holds at least `CABLE_CELL_MIN` pixels of cable ink in the after capture, read by the 77
//      walk's own reader (`support/canvasDots.ts` `cablesOnCanvas`). The pixel diff alone passed
//      with the cable stroked at alpha 0, because the wire layer's electric terminals at both ends
//      change pixels outside the Factory too. RED AT `PHASE92_START`: the forward cable ran
//      through the rectangle.
//   2. the preview shows the path the cable lands on (UI-SPEC 4.1 rule 5). The same drag, held
//      over the Handler's In: the two corridors the overlay plotted (`wirePreviewPolylines`)
//      equal, vertex for vertex, the two resting cables the wire layer plots after the release
//      (`cablePolylines`, the one `cablePoints` builder both draw through), and every corner of
//      each lies on a cell of the landed path `readScene` reports, so the preview corridor and
//      the landed cable are the same cells. The fresh cable carries no re-route mark.
//   3. moving the machine re-routes the cable (UI-SPEC 4.1 rule 6). With the cable drawn around
//      the Factory, the Factory is deleted: the forward cable's path becomes today's straight
//      path along row 8 and the shipped re-route mark draws on that change. The Factory placed
//      again out of the cable's window, at (12,12), moves nothing.
//   4. the cable reads teal and apart from the grid on the canvas (plan 92-04, D-10, UI-SPEC 4.2
//      and 4.3). With both legs landed and the selection dropped, three screen pixels are read
//      off one capture at 1280x800 and default zoom: a cable pixel at the centre of a straight
//      run cell of the model path beside the column-16 major grid line, a pixel on that major
//      line one cell above or below the cable, and a floor pixel in the same cell. The cable
//      reads `LOCKED_SKIN.palette.cable` within 2 per channel, the major line `ramp[2]` within
//      2, the contrast computed from the two read pixels is at least 2:1 and from the cable and
//      the floor pixel at least 3:1, and no pixel inside the Factory's box is within 4 per
//      channel of the cable ink. RED AT `PHASE92_START`: the cable was `ramp[3]` at alpha 0.35,
//      a dimmer copy of the grid's grey.
//
// The obstacle grade reads pixels on a paused board and needs no cable colour; leg 4 is the
// colour and contrast read (D-10), its expected ink taken from the locked skin, never a retyped
// hex. Render health in every test: `watchPageErrors` before the first `page.goto`,
// `expectRenderLoopAlive` (the held-board form on a paused board) and `assertNone`.

const KIND_ENDPOINT = 9;
const KIND_FACTORY = 2;
const KIND_HANDLER = 10;
const ROLE_IN = 0;
const ROLE_OUT = 1;
const MEDIUM_ELECTRICAL = 1;

const ROUTE_AT: Cell = [8, 8];
const FACTORY_AT: Cell = [12, 7];
const HANDLER_AT: Cell = [18, 7];
const FACTORY_SIZE = 3;
/** A cell no machine and no cable takes, clicked to drop the selection. */
const EMPTY_CELL: Cell = [10, 13];
/** Every cell a gesture presses or the grade reads, checked on the open canvas first. */
const BOARD_CELLS: Cell[] = [ROUTE_AT, FACTORY_AT, [14, 9], HANDLER_AT, [20, 9], EMPTY_CELL, [7, 4], [21, 12], [14, 14]];
/** Where leg 3 places the Factory again: below the board's cables and outside the cable's window. */
const FACTORY_AGAIN_AT: Cell = [12, 12];
/** Today's path of the forward cable with nothing in its way: row 8, from the Route to the Handler In. */
const STRAIGHT: Array<[number, number]> = rowCells(8, 18, 8);
/** UI-SPEC 4.1 rule 1: a nub reaches 7.6 px past its machine's edge at zoom 1, so the Factory's
 *  own nubs are kept out of the graded rectangle by an inset of 8 px a side. */
const NUB_INSET_PX = 8;
/** The board span the non-vacuity read covers, in cells: one cell beyond the three machines and
 *  three rows above and below them, where every way round the Factory runs. */
const SPAN = { x0: 7, y0: 4, x1: 21, y1: 12 };

type Rect = { x: number; y: number; width: number; height: number };

test.afterEach(async ({ page }, testInfo) => {
  await restoreHostAfterFailedTest(page, testInfo);
});

/** A screen rectangle for the world-cell box (x0..x1, y0..y1) inclusive, inset by `inset` world px. */
async function screenRectOfCells(page: Page, x0: number, y0: number, x1: number, y1: number, inset: number): Promise<Rect> {
  const a = await screenPoint(page, { x: x0 * CELL + inset, y: y0 * CELL + inset });
  const b = await screenPoint(page, { x: (x1 + 1) * CELL - inset, y: (y1 + 1) * CELL - inset });
  return { x: Math.round(a.x), y: Math.round(a.y), width: Math.round(b.x - a.x), height: Math.round(b.y - a.y) };
}

/** The three machines on an empty board at scale 1 and 1280x800, selection dropped. Call it after
 *  `watchPageErrors`, so a boot-time throw is seen. */
async function buildBoard(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await waitForAppReady(page);
  await emptyBoardAtScaleOne(page, BOARD_CELLS);
  await place(page, 'Route', KIND_ENDPOINT, ROUTE_AT, 'the Route');
  await place(page, 'Factory', KIND_FACTORY, FACTORY_AT, 'the Factory');
  await place(page, 'HTTP Handler', KIND_HANDLER, HANDLER_AT, 'the Handler');
  await deselectViaEmptyCell(page, EMPTY_CELL[0], EMPTY_CELL[1]);
}

function electrical(s: SceneFacts, at: Cell, role: number): PortFacts {
  const p = portOf(s, at, role, MEDIUM_ELECTRICAL);
  expect(p, `the machine at (${at.join(',')}) has an electrical port of role ${role}`).toBeDefined();
  return p as PortFacts;
}

/** Pixels of `a` and `b` (same clip) that differ, split by whether they lie inside `inner`. */
function diffSplit(a: Buffer, b: Buffer, clip: Rect, inner: Rect): { inside: number; outside: number } {
  const pa = PNG.sync.read(a);
  const pb = PNG.sync.read(b);
  expect([pb.width, pb.height], 'both captures are the same size').toEqual([pa.width, pa.height]);
  let inside = 0;
  let outside = 0;
  for (let y = 0; y < pa.height; y++) {
    for (let x = 0; x < pa.width; x++) {
      const i = (y * pa.width + x) * 4;
      if (pa.data[i] === pb.data[i] && pa.data[i + 1] === pb.data[i + 1] && pa.data[i + 2] === pb.data[i + 2]) continue;
      const sx = clip.x + x;
      const sy = clip.y + y;
      if (sx >= inner.x && sx < inner.x + inner.width && sy >= inner.y && sy < inner.y + inner.height) inside += 1;
      else outside += 1;
    }
  }
  return { inside, outside };
}

/** A polyline with its vertices rounded to 1/100 px, as a comparable string. */
function runKey(run: Array<{ x: number; y: number }>): string {
  return JSON.stringify(run.map((v) => [Math.round(v.x * 100) / 100, Math.round(v.y * 100) / 100]));
}

/** The forward cable's cells (the one leaving the Route), or null when there is none. */
function forwardCells(s: SceneFacts): Array<[number, number]> | null {
  const w = s.wires.find((x) => x.path[0]?.cell_x === ROUTE_AT[0] && x.path[0]?.cell_y === ROUTE_AT[1]);
  return w ? w.path.map((c) => [c.cell_x, c.cell_y] as [number, number]) : null;
}

/** Whether any cell of `cells` lies in the Factory's box anchored at `at`. */
function entersFactory(cells: ReadonlyArray<readonly [number, number]>, at: Cell): boolean {
  return cells.some(([x, y]) => x >= at[0] && x < at[0] + FACTORY_SIZE && y >= at[1] && y < at[1] + FACTORY_SIZE);
}

/** WCAG relative luminance of an { r, g, b } pixel. */
function luminance(p: { r: number; g: number; b: number }): number {
  const lin = (c: number): number => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(p.r) + 0.7152 * lin(p.g) + 0.0722 * lin(p.b);
}

/** The WCAG contrast ratio of two read pixels. */
function contrast(a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** 0xRRGGBB as { r, g, b }. */
function rgbOfInt(c: number): { r: number; g: number; b: number } {
  return { r: (c >> 16) & 0xff, g: (c >> 8) & 0xff, b: c & 0xff };
}

/** Whether `p` is within `tol` of `want` on every channel. */
function nearRgb(p: { r: number; g: number; b: number }, want: { r: number; g: number; b: number }, tol: number): boolean {
  return Math.abs(p.r - want.r) <= tol && Math.abs(p.g - want.g) <= tol && Math.abs(p.b - want.b) <= tol;
}

/** The scene's wires as cell lists, for messages. */
function wireCells(s: SceneFacts): string {
  return JSON.stringify(s.wires.map((w) => w.path.map((c) => [c.cell_x, c.cell_y])));
}

test.describe('CHROME-19 live: a cable goes around a third machine (the real dev host)', () => {
  test('a landed cable leaves the Factory pixels alone', async ({ page }) => {
    const errs = watchPageErrors(page);
    await buildBoard(page);
    expect((await cameraOf(page)).scale, 'PRECONDITION: the camera is at scale 1').toBe(1);
    const s0 = await readScene(page);
    expect(s0.wires, 'PRECONDITION: no cable on the board yet').toHaveLength(0);
    const from = electrical(s0, ROUTE_AT, ROLE_OUT);
    const to = electrical(s0, HANDLER_AT, ROLE_IN);
    expect([from.cell_y, to.cell_y], 'PRECONDITION: the Route Out and the Handler In share row 8, through the Factory').toEqual([8, 8]);

    const tick = await pauseAndSettle(page, 'the three-machine board');
    await expectRenderLoopAlive(page, 'on the paused board before the cable', { boardHeld: true });
    const inner = await screenRectOfCells(
      page,
      FACTORY_AT[0],
      FACTORY_AT[1],
      FACTORY_AT[0] + FACTORY_SIZE - 1,
      FACTORY_AT[1] + FACTORY_SIZE - 1,
      NUB_INSET_PX,
    );
    const span = await screenRectOfCells(page, SPAN.x0, SPAN.y0, SPAN.x1, SPAN.y1, 0);
    const before = await captureClip(page, span);

    // The gesture on the paused board is queued; one Step folds it.
    await handDrawWire(page, from, to);
    await page.getByRole('button', { name: 'Step' }).click();
    await pollScene(page, (s) => s.wires.length, { message: 'one Step folded both cable legs of the drag' }).toBe(2);
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const hook = (window as { __fabrico?: { cablePolylines?(): unknown[] } }).__fabrico;
            if (typeof hook?.cablePolylines !== 'function') throw new Error('window.__fabrico.cablePolylines() not installed');
            return hook.cablePolylines().length;
          }),
        { message: 'the wire layer plotted both landed cables' },
      )
      .toBe(2);
    await expectRenderLoopAlive(page, 'on the paused board after the cable', { boardHeld: true });
    const s1 = await readScene(page);
    expect(s1.tick, 'the board advanced exactly the one Step').toBe(tick + 1);
    const after = await captureClip(page, span);

    const d = diffSplit(before, after, span, inner);
    expect(d.outside, `NON-VACUITY: the landed cables changed pixels on the board span outside the Factory; cables ${wireCells(s1)}`).toBeGreaterThan(0);
    expect(
      d.inside,
      `RED-FIRST CHROME-19-live: pixels inside the Factory's rectangle (inset ${NUB_INSET_PX} px, ${JSON.stringify(inner)}) that changed when the cable landed; cables ${wireCells(s1)}`,
    ).toBe(0);

    const forward = s1.wires.find((w) => w.path[0]?.cell_x === ROUTE_AT[0] && w.path[0]?.cell_y === ROUTE_AT[1]);
    expect(forward, 'the forward cable leaves the Route').toBeDefined();
    const last = forward!.path[forward!.path.length - 1];
    expect([last.cell_x, last.cell_y], 'the forward cable docks at the Handler In').toEqual([to.cell_x, to.cell_y]);

    // THE CABLE IS SEEN on its own cells (review WR-C-03), not only "something changed".
    const cam = await cameraOf(page);
    const png = PNG.sync.read(after);
    const read = cablesOnCanvas(
      { width: png.width, height: png.height, data: png.data },
      [
        {
          key: 'forward',
          cells: forward!.path.map((c) => [c.cell_x, c.cell_y] as const),
          ends: [nubAnchor(from.cell_x, from.cell_y, from.side), nubAnchor(to.cell_x, to.cell_y, to.side)],
        },
      ],
      { originX: cam.x - span.x, originY: cam.y - span.y, scale: cam.scale, dpr: 1, cell: CELL },
    );
    const ink = read.cables[0].cellInk;
    console.log(`P92-CHROME-19 leg1 cable cell ink ${ink.join(',')} (run cells ${ink.length})`);
    expect(ink.length, 'NON-VACUITY: the forward cable has run cells between its two port cells').toBeGreaterThan(0);
    expect(
      Math.min(...ink),
      `every run cell of the landed forward cable shows cable ink (at least ${CABLE_CELL_MIN} px each; read ${ink.join(',')})`,
    ).toBeGreaterThanOrEqual(CABLE_CELL_MIN);
    errs.assertNone('after the cable landed');

    await resumeIfPaused(page);
    await resetToDemo(page);
  });

  test('the preview shows the path the cable lands on', async ({ page }) => {
    const errs = watchPageErrors(page);
    await buildBoard(page);
    const s0 = await readScene(page);
    const from = electrical(s0, ROUTE_AT, ROLE_OUT);
    const to = electrical(s0, HANDLER_AT, ROLE_IN);
    await expectRenderLoopAlive(page, 'before the drag');

    let preview: Array<Array<{ x: number; y: number }>> = [];
    await handDrawWire(page, from, to, async () => {
      await expect
        .poll(async () => (await wirePreviewPolylines(page)).length, {
          message: 'the held drag previews both corridors (the forward leg and the paired return leg)',
        })
        .toBe(2);
      preview = await wirePreviewPolylines(page);
      await expectRenderLoopAlive(page, 'while the preview is held');
    });
    await pollScene(page, (s) => s.wires.length, { message: 'the release folded both cable legs' }).toBe(2);
    await expect
      .poll(async () => (await cablePolylines(page)).length, { message: 'the wire layer plotted both landed cables' })
      .toBe(2);
    const landed = await cablePolylines(page);
    const s1 = await readScene(page);
    expect(entersFactory(forwardCells(s1) ?? [], FACTORY_AT), `PRECONDITION: the landed cable goes around the Factory; cables ${wireCells(s1)}`).toBe(
      false,
    );
    expect(
      preview.map(runKey).sort(),
      `the previewed corridors equal the landed cables vertex for vertex; cables ${wireCells(s1)}`,
    ).toEqual(landed.map(runKey).sort());
    // Every corner of each landed run lies on a cell of a landed path, so the corridor the
    // preview showed is the landed path's cells (the runs' ends sit on the nubs, at the cell edge).
    for (const run of landed) {
      const corners = run.slice(1, -1).map((v) => [Math.floor(v.x / CELL), Math.floor(v.y / CELL)] as [number, number]);
      const owner = s1.wires.find((w) => corners.every(([x, y]) => w.path.some((c) => c.cell_x === x && c.cell_y === y)));
      expect(owner, `each landed run's corners ${JSON.stringify(corners)} are cells of one landed path; cables ${wireCells(s1)}`).toBeDefined();
    }
    expect(await rerouteMarkStrokes(page), 'a freshly drawn cable is not marked').toBe(0);
    await expectRenderLoopAlive(page, 'after the release');
    errs.assertNone('the preview and the landed cable');
    await resetToDemo(page);
  });

  test('moving the Factory out of the row re-routes the cable with the mark', async ({ page }) => {
    const errs = watchPageErrors(page);
    await buildBoard(page);
    const s0 = await readScene(page);
    await handDrawWire(page, electrical(s0, ROUTE_AT, ROLE_OUT), electrical(s0, HANDLER_AT, ROLE_IN));
    await pollScene(page, (s) => s.wires.length, { message: 'the drag folded both cable legs' }).toBe(2);
    const around = forwardCells(await readScene(page));
    expect(around, 'the forward cable is on the board').not.toBeNull();
    expect(entersFactory(around!, FACTORY_AT), `PRECONDITION: the cable goes around the Factory: ${JSON.stringify(around)}`).toBe(false);
    expect(around, 'PRECONDITION: going around is not today\'s straight path').not.toEqual(STRAIGHT);
    expect(await rerouteMarkStrokes(page), 'a freshly drawn cable is not marked').toBe(0);
    await expectRenderLoopAlive(page, 'with the cable drawn around the Factory');

    await selectMachineAt(page, FACTORY_AT[0], FACTORY_AT[1]);
    await startRerouteMarkSampler(page);
    await page.keyboard.press('Delete');
    await pollScene(page, (s) => nodeAtAnchor(s, FACTORY_AT[0], FACTORY_AT[1]) === undefined, {
      message: 'the Delete key removed the Factory from the host',
    }).toBe(true);
    await pollScene(page, (s) => JSON.stringify(forwardCells(s)), {
      message: 'with the Factory gone the forward cable takes today\'s straight path along row 8',
    }).toBe(JSON.stringify(STRAIGHT));
    await expect
      .poll(async () => (await readRerouteMarkSampler(page)).max, {
        message: 'the shipped re-route mark drew on the cable the delete moved',
      })
      .toBeGreaterThan(0);
    const mark = await stopRerouteMarkSampler(page);
    expect(mark.frames, 'the mark sampler read frames').toBeGreaterThan(0);
    await expectRenderLoopAlive(page, 'after the re-route');

    await place(page, 'Factory', KIND_FACTORY, FACTORY_AGAIN_AT, 'the Factory placed again below the cables');
    await expectRenderLoopAlive(page, 'after the Factory is placed again');
    const s2 = await readScene(page);
    expect(forwardCells(s2), `a machine outside the cable's window never moves it; cables ${wireCells(s2)}`).toEqual(STRAIGHT);
    errs.assertNone('the re-route');
    await resetToDemo(page);
  });

  test('the cable reads teal and apart from the grid on the canvas', async ({ page }) => {
    const errs = watchPageErrors(page);
    await buildBoard(page);
    expect((await cameraOf(page)).scale, 'PRECONDITION: the camera is at scale 1 (default zoom)').toBe(1);
    const s0 = await readScene(page);
    await handDrawWire(page, electrical(s0, ROUTE_AT, ROLE_OUT), electrical(s0, HANDLER_AT, ROLE_IN));
    await pollScene(page, (s) => s.wires.length, { message: 'the drag folded both cable legs' }).toBe(2);
    await expect
      .poll(async () => (await cablePolylines(page)).length, { message: 'the wire layer plotted both landed cables' })
      .toBe(2);
    // Drop the selection and take the pointer off the board's cables, so no hover or chip
    // sits over a read pixel; then the render loop is seen running past the plot.
    await deselectViaEmptyCell(page, EMPTY_CELL[0], EMPTY_CELL[1]);
    await expectRenderLoopAlive(page, 'with both cables landed and the selection dropped');
    const s1 = await readScene(page);
    const runs = await cablePolylines(page);

    // The cable cell: a straight run cell of a model path (both neighbours on its row) in
    // column 15, 16 or 17, beside the column-16 major grid line (every 8 cells), outside every
    // machine. Its drawn y is read off the plotted run that crosses the cell's centre.
    const onAPath = (x: number, y: number): boolean => s1.wires.some((w) => w.path.some((c) => c.cell_x === x && c.cell_y === y));
    type Pick = { cx: number; cy: number; drawnY: number; row: number };
    let pick: Pick | undefined;
    for (const cx of [16, 15, 17]) {
      for (const w of s1.wires) {
        for (let i = 1; i < w.path.length - 1 && pick === undefined; i++) {
          const [a, c, b] = [w.path[i - 1], w.path[i], w.path[i + 1]];
          if (c.cell_x !== cx || a.cell_y !== c.cell_y || b.cell_y !== c.cell_y) continue;
          const midX = (cx + 0.5) * CELL;
          const crosses = (r: Array<{ x: number; y: number }>, k: number): boolean =>
            k > 0 &&
            r[k].y === r[k - 1].y &&
            Math.min(r[k].x, r[k - 1].x) <= midX &&
            Math.max(r[k].x, r[k - 1].x) >= midX &&
            Math.abs(r[k].y - (c.cell_y + 0.5) * CELL) <= CELL / 4;
          const seg = runs.flatMap((r) => r.filter((_, k) => crosses(r, k)))[0];
          if (seg === undefined) continue;
          // The major-line and floor reads sit one cell above or below, on a row no cable takes
          // in columns 15 and 16.
          const row = [c.cell_y - 1, c.cell_y + 1].find((r) => !onAPath(15, r) && !onAPath(16, r));
          if (row !== undefined) pick = { cx, cy: c.cell_y, drawnY: seg.y, row };
        }
      }
      if (pick !== undefined) break;
    }
    expect(pick, `PRECONDITION: a straight cable cell in columns 15 to 17 with a cable-free row beside it; cables ${wireCells(s1)}`).toBeDefined();
    const { cx, cy, drawnY, row } = pick!;

    const span = await screenRectOfCells(page, SPAN.x0, SPAN.y0, SPAN.x1, SPAN.y1, 0);
    const png = PNG.sync.read(await captureClip(page, span));
    const dpr = png.width / span.width;
    const pixelAtWorld = async (wx: number, wy: number): Promise<{ r: number; g: number; b: number }> => {
      const sp = await screenPoint(page, { x: wx, y: wy });
      const ix = Math.floor((sp.x - span.x) * dpr);
      const iy = Math.floor((sp.y - span.y) * dpr);
      const i = (iy * png.width + ix) * 4;
      return { r: png.data[i], g: png.data[i + 1], b: png.data[i + 2] };
    };
    const MAJOR_X = 16 * CELL;
    const cablePx = await pixelAtWorld((cx + 0.5) * CELL, drawnY);
    const majorPx = await pixelAtWorld(MAJOR_X, (row + 0.5) * CELL);
    const floorPx = await pixelAtWorld((16 + 0.5) * CELL, (row + 0.5) * CELL);

    const { ramp } = LOCKED_SKIN.palette;
    const wantCable = rgbOfInt(LOCKED_SKIN.palette.cable);
    const onMajor = contrast(cablePx, majorPx);
    const onFloor = contrast(cablePx, floorPx);
    expect(
      {
        cableReadsTheToken: nearRgb(cablePx, wantCable, 2),
        majorReadsRamp2: nearRgb(majorPx, rgbOfInt(ramp[2]), 2),
        floorReadsRamp0: nearRgb(floorPx, rgbOfInt(ramp[0]), 2),
        majorAtLeast2: onMajor >= 2,
        floorAtLeast3: onFloor >= 3,
      },
      `RED-FIRST CHROME-19-colour-live: at 1280x800 and zoom 1 the cable pixel at cell (${cx},${cy}) reads ` +
        `${JSON.stringify(cablePx)} (want ${JSON.stringify(wantCable)} within 2), the major grid line one cell away at ` +
        `world x ${MAJOR_X}, row ${row} reads ${JSON.stringify(majorPx)} (want ramp[2] within 2), the floor pixel reads ` +
        `${JSON.stringify(floorPx)}; read contrast ${onMajor.toFixed(2)}:1 against the major line (needs 2:1) and ` +
        `${onFloor.toFixed(2)}:1 against the floor (needs 3:1); cables ${wireCells(s1)}`,
    ).toEqual({ cableReadsTheToken: true, majorReadsRamp2: true, floorReadsRamp0: true, majorAtLeast2: true, floorAtLeast3: true });

    // No cable ink inside the Factory's box (the cable never enters it, UI-SPEC 4.1 rule 1).
    const box = await screenRectOfCells(page, FACTORY_AT[0], FACTORY_AT[1], FACTORY_AT[0] + FACTORY_SIZE - 1, FACTORY_AT[1] + FACTORY_SIZE - 1, 0);
    let inBox = 0;
    for (let y = Math.floor((box.y - span.y) * dpr); y < Math.floor((box.y + box.height - span.y) * dpr); y++) {
      for (let x = Math.floor((box.x - span.x) * dpr); x < Math.floor((box.x + box.width - span.x) * dpr); x++) {
        const i = (y * png.width + x) * 4;
        if (nearRgb({ r: png.data[i], g: png.data[i + 1], b: png.data[i + 2] }, wantCable, 4)) inBox += 1;
      }
    }
    expect(inBox, `no pixel inside the Factory's box ${JSON.stringify(box)} is within 4 of the cable ink; cables ${wireCells(s1)}`).toBe(0);
    console.log(
      `CABLE_COLOUR_READ cell=(${cx},${cy}) row=${row} cable=${JSON.stringify(cablePx)} major=${JSON.stringify(majorPx)} ` +
        `floor=${JSON.stringify(floorPx)} on_major=${onMajor.toFixed(2)} on_floor=${onFloor.toFixed(2)} in_box=${inBox}`,
    );
    await expectRenderLoopAlive(page, 'after the colour reads');
    errs.assertNone('the cable colour reads');
    await resetToDemo(page);
  });
});
