import { test, expect, type Page } from '@playwright/test';
import {
  cameraOf,
  deselectViaEmptyCell,
  expectRenderLoopAlive,
  handDragBetween,
  handPlaceAt,
  newBoard,
  nodeAtAnchor,
  nubAnchor,
  pollScene,
  readScene,
  resetZoomToActualSize,
  screenCellCentre,
  screenPoint,
  waitForAppReady,
  waitForCameraSettle,
  watchPageErrors,
  wirePreviewPolylines,
  type PortFacts,
} from './support/oracle';

// 76-label-never-connects.live.spec.ts (plan 76-04, SHAPE-14, D-07) - on the REAL host
// (dev_render_server, real Core -> RenderProducer -> postcard -> WS), neither the Wire
// tool nor the Belt tool can start a connection from a label. Zero mocks, zero injected
// packets. The spec reads the oracle (`window.__fabrico.scene()`, the MODEL) and the wire
// preview read off the overlay's own plot (`wirePreviewPolylines`), because a model read
// cannot see a corridor that was drawn and never committed.
//
// ---------------------------------------------------------------------------
// THE RULING
// ---------------------------------------------------------------------------
//
// D-07 (default): "A label cannot be connected. Dock (including the fault-port branch,
// which would accept one today: WINDOWS 68, command.rs:2266-2290), DrawWire and AddPort
// (no kind check today, command.rs:2299-2312) all refuse a label by error variant, with
// one new refusal tag and sentence (for example "Labels are notes. They do not
// connect."), locked to host verdicts."
//
// The host half is graded in Rust (`fabrico-command/tests/label.rs`, five shapes, and
// `fabrico-host/tests/refusal_copy_truth.rs`, the sentence). This spec is the user's half:
// what a hand meets when it tries (UI-SPEC 6.1, "Hover a label with the Belt or Wire
// tool: no nub ring, because a label has no ports"), and the ground truth the walk's J-1
// judgement ("clearly not a machine a user could wire to") stands on.
//
// ---------------------------------------------------------------------------
// THE LEG
// ---------------------------------------------------------------------------
//
//   1. On an empty board at zoom 1, a Route placed by hand at (16,12) (its electrical In
//      nub faces W) and a label placed by hand at (10,12) (cells 10 to 13 on row 12). The
//      label's panel is closed with a click on empty floor. WIRE: the Wire tool is armed by
//      its title; the pointer presses a few px off the centre of the label's cell (11,12),
//      is held, and travels in moves of at most 6 px, one stretch diagonal, to a point
//      beside the Route's In nub, and releases. After the press and after EVERY move,
//      `wirePreviewPolylines` is empty; after release the scene's wire count is unchanged.
//      BELT: the Belt tool is armed by its title and the same press-and-drag is made from
//      the label's body to the Route's In nub; after release the scene's belt count is
//      unchanged. The label still holds its four cells and no ports throughout.
//
// RENDER HEALTH. `watchPageErrors` is installed before `goto`, and `expectRenderLoopAlive`
// runs on both sides of each drag (memory fabrico-model-oracle-blindspot).
//
// AT THE START REVISION THIS LEG PASSED (`1 passed (12.2s)`): the UI already
// offered no way to connect a label, which is why the host refusals are answers to forged
// input. So the leg's own ability to fail was proved instead (2026-10-07, a scratch copy,
// deleted): the same `handDragBetween` with the press moved a few px off a second Route's
// Out nub reddened "no wire corridor was plotted at any point of the hold" with 53 sampled
// steps each holding a corridor (`step 4: [[{"x":224.5,"y":466},{"x":240,"y":466}]]` on).
// The per-move sampler sees a corridor the moment one is plotted.

type Cell = readonly [number, number];
type Pt = { x: number; y: number };

/** The label kind byte (protocol `machine_kind::LABEL`). A number on purpose: the live
 *  suite imports no product source. */
const KIND_LABEL = 11;
/** The Route kind byte (protocol `machine_kind::ENDPOINT`). */
const KIND_ROUTE = 9;
const ROLE_IN = 0;
const MEDIUM_ELECTRICAL = 1;
const ROUTE_AT: Cell = [16, 12];
const LABEL_AT: Cell = [10, 12];
/** The label cell the press lands on, one in from its west end. */
const PRESS_CELL: Cell = [11, 12];
/** Empty floor, clicked to close the label's panel. */
const EMPTY_CELL: Cell = [4, 6];
/** How long after a release the scene is watched for a late echo, ms. */
const SETTLE_MS = 600;

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

/** Every point is on the canvas, not under a chrome panel. */
async function expectOnCanvas(page: Page, pts: Pt[], ctx: string): Promise<void> {
  const tags = await page.evaluate(
    (ps) => ps.map((p) => document.elementFromPoint(p.x, p.y)?.tagName ?? null),
    pts,
  );
  expect(tags, `${ctx}: every point is on the canvas, not under chrome`).toEqual(pts.map(() => 'CANVAS'));
}

/** The label still holds its four cells and has no ports. */
async function expectLabelUntouched(page: Page, when: string): Promise<void> {
  const label = nodeAtAnchor(await readScene(page), LABEL_AT[0], LABEL_AT[1]);
  expect(label?.kind, `${when}: the label is still at (10,12)`).toBe(KIND_LABEL);
  expect(label!.cells.length, `${when}: the label still holds its four cells`).toBe(4);
  expect(label!.ports, `${when}: the label still has no ports`).toEqual([]);
}

test.describe('SHAPE-14 live: a label never connects', () => {
  test('leg 1: neither the Wire tool nor the Belt tool can start from a label', async ({ page }) => {
    const errs = watchPageErrors(page);
    await emptyBoardAtScaleOne(page);

    // The Route first (its tool stays armed after a placement, so put it down), then the
    // label, whose panel opens over the right of the board and is closed on empty floor.
    await handPlaceAt(page, 'Route', ROUTE_AT[0], ROUTE_AT[1]);
    await pollScene(page, (s) => nodeAtAnchor(s, ROUTE_AT[0], ROUTE_AT[1])?.kind, {
      message: 'the real host echoed the Route at (16,12)',
    }).toBe(KIND_ROUTE);
    await page.keyboard.press('Escape');
    await handPlaceAt(page, 'Label', LABEL_AT[0], LABEL_AT[1]);
    await pollScene(page, (s) => nodeAtAnchor(s, LABEL_AT[0], LABEL_AT[1])?.kind, {
      message: 'the real host echoed the label at (10,12)',
    }).toBe(KIND_LABEL);
    await deselectViaEmptyCell(page, EMPTY_CELL[0], EMPTY_CELL[1]);
    await expectLabelUntouched(page, 'before either drag');

    const route = nodeAtAnchor(await readScene(page), ROUTE_AT[0], ROUTE_AT[1])!;
    const inn = route.ports.find((p) => p.role === ROLE_IN && p.medium === MEDIUM_ELECTRICAL) as
      | PortFacts
      | undefined;
    expect(inn, 'the Route has an electrical In').toBeDefined();
    const centre = await screenCellCentre(page, PRESS_CELL[0], PRESS_CELL[1]);
    const nub = await screenPoint(page, nubAnchor(inn!.cell_x, inn!.cell_y, inn!.side));
    // A few px off the label cell's centre, and a few px off the nub: no hand lands exactly.
    const start = { x: centre.x + 4, y: centre.y - 3 };
    const end = { x: nub.x - 2, y: nub.y + 3 };
    await expectOnCanvas(page, [start, end], 'the press and the release');

    // WIRE.
    const wiresBefore = (await readScene(page)).wires.length;
    await expectRenderLoopAlive(page, 'before the wire drag');
    await page.getByTitle(/^Draw wires/).click();
    const shown: string[] = [];
    const wireSteps = await handDragBetween(page, start, end, async (step) => {
      const runs = await wirePreviewPolylines(page);
      if (runs.length !== 0) shown.push(`step ${step}: ${JSON.stringify(runs)}`);
    });
    expect(wireSteps, 'the wire drag crossed the board in many sub-cell moves').toBeGreaterThan(20);
    expect(shown, 'no wire corridor was plotted at any point of the hold from the label').toEqual([]);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(SETTLE_MS);
    expect((await readScene(page)).wires.length, 'no wire landed from the label').toBe(wiresBefore);
    await expectRenderLoopAlive(page, 'after the wire drag');
    await expectLabelUntouched(page, 'after the wire drag');

    // BELT.
    const beltsBefore = (await readScene(page)).belts.length;
    await expectRenderLoopAlive(page, 'before the belt drag');
    await page.getByTitle(/^Draw belts/).click();
    const beltSteps = await handDragBetween(page, start, end);
    expect(beltSteps, 'the belt drag crossed the board in many sub-cell moves').toBeGreaterThan(20);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(SETTLE_MS);
    expect((await readScene(page)).belts.length, 'no belt landed from the label').toBe(beltsBefore);
    await expectRenderLoopAlive(page, 'after the belt drag');
    await expectLabelUntouched(page, 'after the belt drag');

    errs.assertNone('dragging a wire and a belt from a label');
  });
});
