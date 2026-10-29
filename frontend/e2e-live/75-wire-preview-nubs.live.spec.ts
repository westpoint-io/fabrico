import { test, expect, type Page } from '@playwright/test';
import {
  armAndPlaceAt,
  cameraOf,
  deselectViaEmptyCell,
  expectRenderLoopAlive,
  handDrawWire,
  newBoard,
  nodeAtAnchor,
  nubAnchor,
  pollScene,
  readScene,
  resetZoomToActualSize,
  screenCellCentre,
  screenPoint,
  selectMachineAt,
  waitForAppReady,
  waitForCameraSettle,
  watchPageErrors,
  wirePreviewPolylines,
  type PortFacts,
  type SceneFacts,
} from './support/oracle';

// 75-wire-preview-nubs.live.spec.ts (plan 75-05, CABLE-08) - while a HAND drags a wire on
// the REAL host (dev_render_server, real Core -> RenderProducer -> postcard -> WS), the
// corridor the overlay draws starts on the nub that was pressed and ends on the nub the
// pointer is over, and the cable that lands takes the same cells. Zero mocks, zero
// injected packets. The corridor is read OFF THE PLOT (`window.__fabrico
// .wirePreviewPolylines()`, the route Graphics' own instructions), never off the
// arguments the gesture handed to `showRoute`: an argument log says what was asked for,
// not what is on screen.
//
// ---------------------------------------------------------------------------
// THE RULING
// ---------------------------------------------------------------------------
//
// D-08 (phase 75 CONTEXT): the preview's ends come from the same function the cable uses,
// and the nub arguments are REQUIRED, so the old cell-centre pin cannot stay green.
//
// UI-SPEC 3.1: "Corridor start: on the source nub. Corridor end over an acquired target:
// on the target nub. Corridor end with no target acquired: unchanged (the explicit no-nub
// value)." Width, alpha, colour, caps and lane are identical.
//
// ---------------------------------------------------------------------------
// THE LEG
// ---------------------------------------------------------------------------
//
// D-09's pair, the cells `75-cable-head-on.live.spec.ts` leg 1 uses: Route A at (10,14)
// turned once so its Out faces S, Route B at (16,10) with its In facing W. The hand
// presses A's south nub off-centre, moves in sub-cell steps with a diagonal stretch, and
// while it is held over B's west nub the corridor is read off the plot.
//
// The numbers, worked by hand (CELL 32, INSET 2, NUB_PUSH 2.5):
//   A's S nub   x = 10*32 + 16       = 336,   y = 14*32 + 32 - 2 + 2.5 = 480.5
//   A's cell centre                    (336, 464), 16.5 px above the nub
//   B's W nub   x = 16*32 + 2 - 2.5  = 511.5, y = 10*32 + 16           = 336
//   B's cell centre                    (528, 336), 16.5 px right of the nub
// The corridor runs in lane +1 (first cell (10,14) sorts before last (16,10)), so each
// end vertex may sit up to CABLE_LANE_OFFSET = 2 world px off the nub ACROSS its own
// segment, and must sit exactly on it ALONG its segment.
//
// Before plan 75-05 the first vertex sat at (338, 464): the cell centre, 16.5 px short.
//
// LEG 2 (plan 75-09, 75-REVIEW CR-01): a target port that faces AWAY. Route E at (10,12)
// unturned (Out faces E), Route F at (11,12) turned twice (its In faces E, its Out faces
// W). The corridor from E's Out to F's In runs east along both normals' axis, and enters
// F's cell from behind (through F's west face, where F's own Out nub sits). Before the fix
// the clamp declined that end on the WR-02 range bound and the corridor stopped on F's
// cell centre, inside F, 16.5 px short of the In nub it was plugged into.
//
// The numbers, worked by hand:
//   E's E nub (Out)  x = 10*32 + 32 - 2 + 2.5 = 352.5, y = 12*32 + 16 = 400
//   F's E nub (In)   x = 11*32 + 32 - 2 + 2.5 = 384.5, y = 400
//   F's W nub (Out)  x = 11*32 + 2 - 2.5      = 351.5, y = 400, 1 px from E's Out nub
//   cells (10,12) (11,12), lane +1 (first sorts before last on x), so y 402
// Before the fix the corridor's last vertex was (368, 402), F's cell centre; after it
// (384.5, 402). `handDrawWire` presses at E's Out nub plus (3, -2) screen px, which is
// nearer E's Out (3.6 px) than F's Out (4.5 px), so the press picks E's Out.
//
// RENDER HEALTH. `watchPageErrors` is installed before `goto`, and `expectRenderLoopAlive`
// runs on both sides of the gesture: the model oracle is blind to a dead Pixi ticker, and
// the shared end geometry runs inside it.

type Cell = readonly [number, number];
type Pt = { x: number; y: number };

const ROLE_IN = 0;
const ROLE_OUT = 1;
const MEDIUM_ELECTRICAL = 1;
const SIDE_E = 1;
const SIDE_S = 2;
/** A cell no leg places anything on, clicked to drop the selection after the turn. */
const EMPTY_CELL: Cell = [13, 12];
/** The lane displacement, `CABLE_LANE_OFFSET` in `cableGeometry.ts`, in world px. */
const LANE_OFFSET = 2;
/** A's S nub and B's W nub, worked by hand in the header. */
const A_NUB: Pt = { x: 336, y: 480.5 };
const B_NUB: Pt = { x: 511.5, y: 336 };
/** Leg 2: E's E-facing Out nub and F's E-facing In nub, worked by hand in the header. */
const E_NUB: Pt = { x: 352.5, y: 400 };
const F_NUB: Pt = { x: 384.5, y: 400 };

/** Every point is on the canvas, not under a chrome panel. */
async function expectOnCanvas(page: Page, pts: Pt[], ctx: string): Promise<void> {
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

/**
 * One end of a plotted corridor sits on its nub: exactly on it along the end segment's
 * own axis, and within the lane offset of it across that axis. `axis` is the axis the
 * end segment must run on, stated by the caller from the routed shape.
 */
function expectEndOnNub(end: Pt, inner: Pt, nub: Pt, axis: 'x' | 'y', label: string): void {
  const runsOn: 'x' | 'y' | 'neither' = end.y === inner.y ? 'x' : end.x === inner.x ? 'y' : 'neither';
  expect(runsOn, `${label}: the end segment runs on the ${axis} axis`).toBe(axis);
  const across: 'x' | 'y' = axis === 'x' ? 'y' : 'x';
  expect(
    end[axis],
    `${label}: on the nub along its own axis; plotted (${end.x}, ${end.y}), nub (${nub.x}, ${nub.y})`,
  ).toBe(nub[axis]);
  expect(
    Math.abs(end[across] - nub[across]),
    `${label}: within the lane offset of the nub across its axis; plotted (${end.x}, ${end.y})`,
  ).toBeLessThanOrEqual(LANE_OFFSET);
}

test.describe('CABLE-08 live: the wire drag preview runs nub to nub, read off the plot', () => {
  test('the drag preview starts on the pressed nub and ends on the target nub, then lands on the same cells', async ({
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
      { message: "the real host folded the turn: Route A's Out now faces S" },
    ).toBe(SIDE_S);
    await deselectViaEmptyCell(page, EMPTY_CELL[0], EMPTY_CELL[1]);

    const scene = await readScene(page);
    const out = portOf(scene, A, ROLE_OUT);
    const inn = portOf(scene, B, ROLE_IN);
    // The hand-worked nubs are the oracle's nubs too, so the literals cannot drift from
    // the board without this saying so.
    expect(nubAnchor(out.cell_x, out.cell_y, out.side), "A's S nub, worked by hand").toEqual(A_NUB);
    expect(nubAnchor(inn.cell_x, inn.cell_y, inn.side), "B's W nub, worked by hand").toEqual(B_NUB);
    await expectOnCanvas(page, [await screenPoint(page, A_NUB), await screenPoint(page, B_NUB)], 'both nubs');
    const srcId = nodeAtAnchor(scene, A[0], A[1])!.id;
    const dstId = nodeAtAnchor(scene, B[0], B[1])!.id;

    await expectRenderLoopAlive(page, 'before the drag');
    // A box rather than a bare `let`: an assignment inside the callback is invisible to
    // TypeScript's narrowing, which would read the variable as still `null` after it.
    const held: { runs: Array<Array<Pt>> | null } = { runs: null };
    await handDrawWire(page, out, inn, async () => {
      // The pointer has stopped over B's west nub and the button is still down. The
      // corridor is polled rather than read once, because the last pointer move and the
      // frame that plots it are not the same instant.
      await expect
        .poll(async () => (await wirePreviewPolylines(page)).length, {
          message: 'one corridor is on screen while the hand is held over the target',
        })
        .toBe(1);
      held.runs = await wirePreviewPolylines(page);
      await expectRenderLoopAlive(page, 'while the drag is held');
    });
    expect(held.runs, 'the corridor was read while held').not.toBeNull();
    const run = held.runs![0];
    const shown = JSON.stringify(run);
    expect(run.length, `the corridor has at least two vertices; plotted ${shown}`).toBeGreaterThanOrEqual(2);

    expectEndOnNub(run[0], run[1], A_NUB, 'y', `the first vertex (leaves A's S nub downward); plotted ${shown}`);
    expect(run[1].y, 'the first segment leaves downward, away from A').toBeGreaterThan(run[0].y);
    expectEndOnNub(
      run[run.length - 1],
      run[run.length - 2],
      B_NUB,
      'x',
      `the last vertex (enters B's W nub heading east); plotted ${shown}`,
    );
    expect(run[run.length - 1].x, 'the last segment arrives heading east').toBeGreaterThan(run[run.length - 2].x);
    for (let i = 1; i < run.length; i++) {
      const a = run[i - 1];
      const b = run[i];
      expect(
        a.x === b.x || a.y === b.y,
        `segment ${i - 1} is axis-aligned: (${a.x}, ${a.y}) to (${b.x}, ${b.y})`,
      ).toBe(true);
    }

    await pollScene(
      page,
      (s) =>
        s.wires.length === 1 &&
        s.wires[0].from.node === srcId &&
        s.wires[0].from.port === out.index &&
        s.wires[0].to.node === dstId &&
        s.wires[0].to.port === inn.index,
      { message: 'the real host folded ONE wire between exactly the two ports the hand named' },
    ).toBe(true);
    await expectRenderLoopAlive(page, 'after the release');
    const cells = (await readScene(page)).wires[0].path.map((c) => [c.cell_x, c.cell_y]);
    // 75-01's literal for this pair (75-cable-head-on.live.spec.ts leg 1).
    expect(cells, `the landed cable's cells; drawn ${JSON.stringify(cells)}`).toEqual([
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
    errs.assertNone('the preview leg');
  });
  test('CR-01: a corridor whose target port faces away still ends on that nub, read off the plot', async ({ page }) => {
    const errs = watchPageErrors(page);
    await emptyBoardAtScaleOne(page);
    const E: Cell = [10, 12];
    const F: Cell = [11, 12];
    await placeRoute(page, E);
    await placeRoute(page, F);

    // Turn F twice: its In (W by default) now faces E, its Out faces W.
    await selectMachineAt(page, F[0], F[1]);
    await page.keyboard.press('r');
    await page.keyboard.press('r');
    await pollScene(
      page,
      (s) => nodeAtAnchor(s, F[0], F[1])?.ports.find((p) => p.role === ROLE_IN && p.medium === MEDIUM_ELECTRICAL)?.side,
      { message: "the real host folded both turns: Route F's In now faces E" },
    ).toBe(SIDE_E);
    await deselectViaEmptyCell(page, EMPTY_CELL[0], EMPTY_CELL[1]);

    const scene = await readScene(page);
    const out = portOf(scene, E, ROLE_OUT);
    const inn = portOf(scene, F, ROLE_IN);
    expect(nubAnchor(out.cell_x, out.cell_y, out.side), "E's Out nub, worked by hand").toEqual(E_NUB);
    expect(nubAnchor(inn.cell_x, inn.cell_y, inn.side), "F's In nub, worked by hand").toEqual(F_NUB);
    await expectOnCanvas(page, [await screenPoint(page, E_NUB), await screenPoint(page, F_NUB)], 'both nubs');
    const srcId = nodeAtAnchor(scene, E[0], E[1])!.id;
    const dstId = nodeAtAnchor(scene, F[0], F[1])!.id;
    const wiresBefore = scene.wires.length;

    await expectRenderLoopAlive(page, 'before the drag');
    const held: { runs: Array<Array<Pt>> | null } = { runs: null };
    await handDrawWire(page, out, inn, async () => {
      await expect
        .poll(async () => (await wirePreviewPolylines(page)).length, {
          message: 'one corridor is on screen while the hand is held over F',
        })
        .toBe(1);
      held.runs = await wirePreviewPolylines(page);
      await expectRenderLoopAlive(page, 'while the drag is held');
    });
    expect(held.runs, 'the corridor was read while held').not.toBeNull();
    const run = held.runs![0];
    const shown = JSON.stringify(run);
    expect(run.length, `the corridor has at least two vertices; plotted ${shown}`).toBeGreaterThanOrEqual(2);
    expectEndOnNub(run[0], run[1], E_NUB, 'x', `the first vertex (leaves E's Out nub heading east); plotted ${shown}`);
    expectEndOnNub(
      run[run.length - 1],
      run[run.length - 2],
      F_NUB,
      'x',
      `CR-01, the last vertex (enters F's In from behind); plotted ${shown}`,
    );
    for (let i = 1; i < run.length; i++) {
      const a = run[i - 1];
      const b = run[i];
      expect(
        a.x === b.x || a.y === b.y,
        `segment ${i - 1} is axis-aligned: (${a.x}, ${a.y}) to (${b.x}, ${b.y})`,
      ).toBe(true);
    }

    const landed = (s: SceneFacts) =>
      s.wires.filter(
        (w) => w.from.node === srcId && w.from.port === out.index && w.to.node === dstId && w.to.port === inn.index,
      );
    await pollScene(page, (s) => landed(s).length, {
      message: "the real host folded exactly one wire from E's Out to F's In",
    }).toBe(1);
    await expectRenderLoopAlive(page, 'after the release');
    const after = await readScene(page);
    expect(after.wires.length, 'the hand drew one new wire').toBeGreaterThan(wiresBefore);
    const cells = landed(after)[0].path.map((c) => [c.cell_x, c.cell_y]);
    expect(cells, `the landed cable's cells; drawn ${JSON.stringify(cells)}`).toEqual([
      [10, 12],
      [11, 12],
    ]);
    errs.assertNone('the CR-01 leg');
  });
});
