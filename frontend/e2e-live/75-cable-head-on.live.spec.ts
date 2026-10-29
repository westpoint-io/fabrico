import { test, expect, type Page } from '@playwright/test';
import {
  DEMO_NODE_COUNT,
  armAndPlaceAt,
  cameraOf,
  demoCallerAndHandler,
  deselectViaEmptyCell,
  expectHeadOn,
  expectRenderLoopAlive,
  handDrawWire,
  newBoard,
  nodeAtAnchor,
  nubAnchor,
  pollScene,
  readScene,
  resetToDemo,
  resetZoomToActualSize,
  screenCellCentre,
  screenPoint,
  selectMachineAt,
  waitForAppReady,
  waitForCameraSettle,
  watchPageErrors,
  type PortFacts,
  type SceneFacts,
} from './support/oracle';

// 75-cable-head-on.live.spec.ts (plan 75-01, CABLE-06) - a cable a HAND draws on the REAL
// host (dev_render_server, real Core -> RenderProducer -> postcard -> WS) leaves its port
// along the direction the port faces and enters the other port head-on. Zero mocks, zero
// injected packets. The cable is graded by its CELLS (`WireFacts.path`), never by a tile
// count: a count cannot say which way a cable leaves or arrives.
//
// ---------------------------------------------------------------------------
// THE RULING
// ---------------------------------------------------------------------------
//
// D-01 (design ruling from phase 72, WINDOWS 191): "Honour BOTH ends. Where
// today's short bend honours only one face, the cable goes around ... make it go around."
//
// D-09: "The specified geometry ((10,10) to (16,14) rotated once) is already correct on
// HEAD, so a test on it cannot fail. Use a pair wrong on HEAD, for example A at (10,14) and
// B at (16,10) with A rotated once (HEAD leaves north from a south-facing port)."
//
// ---------------------------------------------------------------------------
// THE LEGS
// ---------------------------------------------------------------------------
//
//   1. D-09's pair. Route A at (10,14) and Route B at (16,10) from the palette, A selected
//      and turned once with `r` so its Out faces S, then a hand-drawn wire from A's Out to
//      B's In. The cells are (10,14) (10,15) (11,15) .. (15,15) (15,14) .. (15,10) (16,10):
//      first step (0,+1), down out of the south-facing Out; last step (+1,0), east into
//      the west-facing In. Before phase 75 the first step was (0,-1), leaving a
//      south-facing port northwards.
//   2. No rotation. Route C at (10,17) and Route D at (11,19): D's In is one column east
//      of C's Out on a different row, the one shape D-01 changes on an unrotated board.
//      The cells are (10,17) (11,17) (11,18) (10,18) (10,19) (11,19). Before phase 75 the
//      first step was (0,+1), leaving an east-facing port southwards.
//   3. The demo board (plan 75-02, D-01's changed outcome). Nothing is drawn: the shipped
//      board's caller and handler are found BY KIND (`demoCallerAndHandler`, plan 85-07)
//      and their two cables by their ENDPOINTS, never by id. Each cable is graded as the
//      statement the leg means, on any layout: it runs from its source port's cell to its
//      target port's cell one orthogonal step at a time, never revisits a cell, crosses no
//      machine between its two ends, and is plugged in head-on at both prongs.
//      UNTIL 85-07 THE CELLS WERE PINNED LITERALLY, true only of the old 1x1 pair at
//      (10,6) and (14,6): forward (10,6) (11,6) (12,6) (13,6) (14,6), byte-identical to the
//      build before phase 75 (D-02); return (14,6) (15,6) (15,5) (14,5) (13,5) (12,5) (11,5)
//      (11,6) (10,6), going around above the two machines because the old caller's one port
//      faced E (before phase 75 it ran straight west along row 6, leaving an east-facing
//      Out with first step (-1,0)). Phase 85 rebuilds the pair (plan 85-08), and the cells
//      it measures are recorded there; the head-on rule is what the user sees on any of them.
//
// THE CAMERA. Every leg resets the zoom to 100% at a 1280x800 viewport and asserts each
// drop cell and each nub is on the canvas (not under chrome) before it is pressed. The
// cells above needed no whole-cell shift: they were on the canvas at that camera when this
// spec was written, and the on-canvas assertion is what would say so if that changed.
//
// RENDER HEALTH. `watchPageErrors` is installed before `goto`, and `expectRenderLoopAlive`
// runs on both sides of the gesture: the model oracle is blind to a dead Pixi ticker.

type Cell = readonly [number, number];

const ROLE_IN = 0;
const ROLE_OUT = 1;
const MEDIUM_ELECTRICAL = 1;
const SIDE_S = 2;
/** A cell no leg places anything on, clicked to drop the selection after the turn. */
const EMPTY_CELL: Cell = [13, 12];

/** Every point is on the canvas, not under a chrome panel. */
async function expectOnCanvas(page: Page, pts: { x: number; y: number }[], ctx: string): Promise<void> {
  const tags = await page.evaluate(
    (ps) => ps.map((p) => document.elementFromPoint(p.x, p.y)?.tagName ?? null),
    pts,
  );
  expect(tags, `${ctx}: every point is on the canvas, not under chrome`).toEqual(pts.map(() => 'CANVAS'));
}

/** An empty board at camera scale 1. */
async function emptyBoardAtScaleOne(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await waitForAppReady(page);
  await newBoard(page);
  await resetZoomToActualSize(page);
  await waitForCameraSettle(page);
  expect((await cameraOf(page)).scale, 'the camera is at scale 1').toBe(1);
}

/** Place a Route at `at` from the palette and wait for the host to echo it. */
async function placeRoute(page: Page, at: Cell): Promise<void> {
  await expectOnCanvas(page, [await screenCellCentre(page, at[0], at[1])], `the drop cell (${at[0]},${at[1]})`);
  const before = (await readScene(page)).nodes.length;
  await armAndPlaceAt(page, 'Route', at[0], at[1]);
  await pollScene(page, (s) => nodeAtAnchor(s, at[0], at[1]) !== undefined, {
    message: `the real host echoed the Route placed at (${at[0]},${at[1]})`,
  }).toBe(true);
  expect((await readScene(page)).nodes.length, 'exactly one machine was added').toBe(before + 1);
}

/** The electrical port of `role` on the machine anchored at `at`. */
function portOf(scene: SceneFacts, at: Cell, role: number): PortFacts {
  const node = nodeAtAnchor(scene, at[0], at[1]);
  expect(node, `a machine is anchored at (${at[0]},${at[1]})`).toBeDefined();
  const port = node!.ports.find((p) => p.role === role && p.medium === MEDIUM_ELECTRICAL);
  expect(port, `the machine at (${at[0]},${at[1]}) has an electrical ${role === ROLE_OUT ? 'Out' : 'In'}`).toBeDefined();
  return port as PortFacts;
}

/** Draw by hand from `src`'s Out to `dst`'s In, then return the one wire's cells. */
async function drawAndReadCells(page: Page, src: Cell, dst: Cell, ctx: string): Promise<[number, number][]> {
  const scene = await readScene(page);
  const out = portOf(scene, src, ROLE_OUT);
  const inn = portOf(scene, dst, ROLE_IN);
  await expectOnCanvas(
    page,
    [
      await screenPoint(page, nubAnchor(out.cell_x, out.cell_y, out.side)),
      await screenPoint(page, nubAnchor(inn.cell_x, inn.cell_y, inn.side)),
    ],
    `${ctx}: both nubs`,
  );
  const srcId = nodeAtAnchor(scene, src[0], src[1])!.id;
  const dstId = nodeAtAnchor(scene, dst[0], dst[1])!.id;

  await expectRenderLoopAlive(page, `${ctx}: before the hand-drawn wire`);
  await handDrawWire(page, out, inn);
  await pollScene(
    page,
    (s) =>
      s.wires.length === 1 &&
      s.wires[0].from.node === srcId &&
      s.wires[0].from.port === out.index &&
      s.wires[0].to.node === dstId &&
      s.wires[0].to.port === inn.index,
    { message: `${ctx}: the real host folded ONE wire between exactly the two ports the hand named` },
  ).toBe(true);
  await expectRenderLoopAlive(page, `${ctx}: after the hand-drawn wire`);
  const wire = (await readScene(page)).wires[0];
  return wire.path.map((c) => [c.cell_x, c.cell_y] as [number, number]);
}

function stepOf(a: [number, number], b: [number, number]): [number, number] {
  return [b[0] - a[0], b[1] - a[1]];
}

test.describe('CABLE-06 live: a hand-drawn cable leaves along its facing and plugs in head-on', () => {
  test('leg 1: Route A turned once (Out faces S) to Route B, the cable leaves downward and enters B from the west', async ({
    page,
  }) => {
    const errs = watchPageErrors(page);
    await emptyBoardAtScaleOne(page);
    const A: Cell = [10, 14];
    const B: Cell = [16, 10];
    await placeRoute(page, A);
    await placeRoute(page, B);

    // Turn A once: a Route's Out faces E, a quarter turn clockwise makes it face S.
    await selectMachineAt(page, A[0], A[1]);
    await page.keyboard.press('r');
    await pollScene(
      page,
      (s) => nodeAtAnchor(s, A[0], A[1])?.ports.find((p) => p.role === ROLE_OUT && p.medium === MEDIUM_ELECTRICAL)?.side,
      {
        message: 'the real host folded the turn: Route A\'s Out now faces S',
      },
    ).toBe(SIDE_S);
    await deselectViaEmptyCell(page, EMPTY_CELL[0], EMPTY_CELL[1]);

    const cells = await drawAndReadCells(page, A, B, 'leg 1');
    expect(cells, `leg 1: the cable cells, source port first; drawn ${JSON.stringify(cells)}`).toEqual([
      [10, 14],
      [10, 15],
      [11, 15],
      [12, 15],
      [13, 15],
      [14, 15],
      [15, 15],
      [15, 14],
      [15, 13],
      [15, 12],
      [15, 11],
      [15, 10],
      [16, 10],
    ]);
    expect(stepOf(cells[0], cells[1]), 'leg 1: the first step leaves the S-facing Out downward').toEqual([0, 1]);
    expect(
      stepOf(cells[cells.length - 2], cells[cells.length - 1]),
      'leg 1: the last step enters the W-facing In heading east',
    ).toEqual([1, 0]);
    errs.assertNone('leg 1');
  });

  test('leg 2: no rotation, Route D one column east of Route C on another row, the cable leaves east and enters from the west', async ({
    page,
  }) => {
    const errs = watchPageErrors(page);
    await emptyBoardAtScaleOne(page);
    const C: Cell = [10, 17];
    const D: Cell = [11, 19];
    await placeRoute(page, C);
    await placeRoute(page, D);

    const cells = await drawAndReadCells(page, C, D, 'leg 2');
    expect(cells, `leg 2: the cable cells, source port first; drawn ${JSON.stringify(cells)}`).toEqual([
      [10, 17],
      [11, 17],
      [11, 18],
      [10, 18],
      [10, 19],
      [11, 19],
    ]);
    expect(stepOf(cells[0], cells[1]), 'leg 2: the first step leaves the E-facing Out eastward').toEqual([1, 0]);
    expect(
      stepOf(cells[cells.length - 2], cells[cells.length - 1]),
      'leg 2: the last step enters the W-facing In heading east',
    ).toEqual([1, 0]);
    errs.assertNone('leg 2');
  });

  test('leg 3: the demo board, both shipped cables named cell by cell and plugged in head-on at both prongs', async ({
    page,
  }) => {
    const errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await resetToDemo(page, DEMO_NODE_COUNT);
    await waitForCameraSettle(page);
    await expectRenderLoopAlive(page, 'leg 3: on the shipped demo board');

    const scene = await readScene(page);
    // The pair BY KIND (plan 85-07): the board's Route, and the HTTP Handler its cable
    // delivers into. Until 85-07 these were the cells (10,6) and (14,6).
    const pair = await demoCallerAndHandler(page);
    await expectRenderLoopAlive(page, 'leg 3: right after finding the demo pair by kind');
    const caller = scene.nodes.find((n) => n.id === pair.caller.id);
    const handler = scene.nodes.find((n) => n.id === pair.handler.id);
    expect(caller, 'leg 3: the demo carries its caller Route').toBeDefined();
    expect(handler, 'leg 3: the demo carries its HTTP Handler').toBeDefined();
    const electrical = (n: (typeof scene.nodes)[number], role: number): PortFacts => {
      const port = n.ports.find((p) => p.role === role && p.medium === MEDIUM_ELECTRICAL);
      expect(port, `leg 3: node ${n.id} has an electrical ${role === ROLE_OUT ? 'Out' : 'In'}`).toBeDefined();
      return port as PortFacts;
    };
    const callerOut = electrical(caller!, ROLE_OUT);
    const handlerIn = electrical(handler!, ROLE_IN);
    const handlerOut = electrical(handler!, ROLE_OUT);

    // By ENDPOINTS, never by id: a reseeded board mints new ids. The return cable docks
    // the caller at whichever of its ports takes it: on the old 1x1 pair that was its one
    // port, the Out (a 1x1-only fact); a palette Route takes it on its In.
    const between = (a: number, ap: number, b: number, bp: number) =>
      scene.wires.filter((w) => w.from.node === a && w.from.port === ap && w.to.node === b && w.to.port === bp);
    const forward = between(caller!.id, callerOut.index, handler!.id, handlerIn.index);
    const back = scene.wires.filter(
      (w) => w.from.node === handler!.id && w.from.port === handlerOut.index && w.to.node === caller!.id,
    );
    expect(forward.length, 'leg 3: exactly one forward cable, caller Out to handler In').toBe(1);
    expect(back.length, 'leg 3: exactly one return cable, handler Out to the caller').toBe(1);
    const backTo = caller!.ports.find((p) => p.index === back[0].to.port);
    expect(
      backTo && backTo.medium,
      "leg 3: the return cable lands on one of the caller's own electrical ports",
    ).toBe(MEDIUM_ELECTRICAL);
    const cellsOf = (w: (typeof scene.wires)[number]) => w.path.map((c) => [c.cell_x, c.cell_y] as [number, number]);

    // THE ROUTE, as the general statement (see the leg list above for the literal cells this
    // replaced): source port cell to target port cell, one orthogonal step at a time, no
    // cell twice, and no machine crossed between the two ends.
    const machineCells = new Set(scene.nodes.flatMap((n) => n.cells.map(([x, y]) => `${x},${y}`)));
    const expectRouted = (cells: [number, number][], from: PortFacts, to: PortFacts, label: string): void => {
      const drawn = JSON.stringify(cells);
      expect(cells[0], `${label}: starts on its source port's cell; drawn ${drawn}`).toEqual([from.cell_x, from.cell_y]);
      expect(cells[cells.length - 1], `${label}: ends on its target port's cell; drawn ${drawn}`).toEqual([
        to.cell_x,
        to.cell_y,
      ]);
      expect(
        cells.slice(1).every(([x, y], i) => Math.abs(x - cells[i][0]) + Math.abs(y - cells[i][1]) === 1),
        `${label}: every step is one orthogonal cell; drawn ${drawn}`,
      ).toBe(true);
      expect(new Set(cells.map(([x, y]) => `${x},${y}`)).size, `${label}: no cell is visited twice; drawn ${drawn}`).toBe(
        cells.length,
      );
      expect(
        cells.slice(1, -1).filter(([x, y]) => machineCells.has(`${x},${y}`)),
        `${label}: no cell between its two ends lies on a machine; drawn ${drawn}`,
      ).toEqual([]);
    };
    expectRouted(cellsOf(forward[0]), callerOut, handlerIn, 'leg 3: the forward cable');
    expectRouted(cellsOf(back[0]), handlerOut, backTo!, 'leg 3: the return cable');
    expectHeadOn(scene, forward[0], 'leg 3: the forward cable');
    expectHeadOn(scene, back[0], 'leg 3: the return cable');

    await expectRenderLoopAlive(page, 'leg 3: after reading both cables');
    errs.assertNone('leg 3');
  });
});
