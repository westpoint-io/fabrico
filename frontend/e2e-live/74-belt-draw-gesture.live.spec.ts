import { test, expect, type Page } from '@playwright/test';
import {
  DEMO_NODE_COUNT,
  armAndPlaceAt,
  cameraOf,
  expectRenderLoopAlive,
  newBoard,
  pollScene,
  readScene,
  resetToDemo,
  resetZoomToActualSize,
  screenCellCentre,
  waitForAppReady,
  waitForCameraSettle,
  watchPageErrors,
  type SceneFacts,
} from './support/oracle';

// 74-belt-draw-gesture.live.spec.ts (plan 74-14) - the belt draw gesture on the REAL
// `dev_render_server`, driven the way a HAND drives it: with pointer samples that cross
// more than one cell, and with a diagonal sample at the corner.
//
// ---------------------------------------------------------------------------
// WHY THIS FILE EXISTS
// ---------------------------------------------------------------------------
//
// The maintainer's manual walkthrough on the real WebKitGTK binary reported three things
// unprompted: corners do not draw, a skipped cell freezes the belt, and an illegal cell
// leaves it red and stuck. All three are the same rule in `gestures.ts`'s in-drag
// accumulator, which considered only the CURRENT sample's own cell and could only PUSH.
//
// WHAT EVERY BELT-DRAW FIXTURE IN THIS REPOSITORY SHARED THAT A HAND DOES NOT: it
// advances such that no sample is ever more than one cell from the head.
// `oracle.ts`'s `drawBeltThroughCells` steps cell by cell. So does
// `74-belt-run-joins.spec.ts`'s `drawBeltOnFloor`, so does `74-belt-join-press-on-end`'s
// driver, so do the mock e2e drags. The shipped suites therefore CANNOT fail on any of
// the three findings, and a fix verified against them is verified by a check that cannot
// fail. Every leg here emits at least one MULTI-CELL sample for that reason, and the
// elbow leg emits one that changes both cell axes at once.
//
// NO LIVE OR MOCK FIXTURE IN THIS REPOSITORY DRAWS A BELT CORNER AT ALL. Every authored
// belt run in the e2e and live suites is a straight line. The elbow leg below is
// therefore new coverage rather than a faster version of something already covered, and
// it is the only place a `Corner` tile is asserted to exist on a belt a gesture landed.
//
// ---------------------------------------------------------------------------
// A NEW FILE, NOT AN ADDITION TO `74-belt-join-press-on-end.live.spec.ts`
// ---------------------------------------------------------------------------
//
// That file's own exit gate asserts it declares EXACTLY 2 tests (plan 74-13), and a
// later plan does not get to quietly retire another plan's gate to save a file.
//
// ---------------------------------------------------------------------------
// THE RENDER-HEALTH PAIR IS NOT DECORATION
// ---------------------------------------------------------------------------
//
// The live oracle reads only the MODEL, through `sceneSnapshot`. A build whose Pixi
// renderer was dead would satisfy every model assertion in this file, so every leg
// carries `watchPageErrors` plus `expectRenderLoopAlive`.

/**
 * The elbow corridor, on an EMPTY board. The press is at `ELBOW_FROM` and the single
 * diagonal sample lands at `ELBOW_TO`, THREE cells east and TWO cells south.
 *
 * The cells the segment between those two centres crosses, in crossing order, are
 * `ELBOW_PATH` - a staircase, because a straight diagonal across a square lattice is
 * exactly that.
 *
 * WHY 3 BY 2 AND NOT 2 BY 2, MEASURED ON THE REAL HOST RATHER THAN REASONED. A 45
 * degree centre-to-centre diagonal crosses every column line and row line at the SAME
 * parameter, so the accumulator's lattice-corner tie-break (step X first) decides the
 * whole staircase - and on the real host the two parameters are computed from live
 * screen coordinates, where a sub-pixel canvas or device-pixel offset of a fraction of
 * a cell is enough to make the row line arrive first. Driven at 2 by 2 this leg landed
 * (4,6) (4,7) (5,7) (5,8) (6,8), the Y-first staircase, which is an equally correct
 * report of the same swept segment. Pinning an exact tile list on a tie is pinning
 * sub-pixel geometry, so the LIVE leg uses a 3 by 2 diagonal where no crossing ties
 * and the order is decided by margins of roughly a tenth of the segment. The tie-break
 * itself is pinned exactly by the vitest case `a diagonal elbow sample draws the corner
 * it swept`, where the rig's arithmetic is integral and the tie is exact.
 */
const ELBOW_FROM: readonly [number, number] = [4, 6];
const ELBOW_TO: readonly [number, number] = [7, 8];
const ELBOW_PATH: readonly (readonly [number, number])[] = [
  [4, 6],
  [5, 6],
  [5, 7],
  [6, 7],
  [6, 8],
  [7, 8],
];
/** The staircase's corner inference: both endpoints straight, every interior a corner. */
const ELBOW_KINDS = ['Straight', 'Corner', 'Corner', 'Corner', 'Corner', 'Straight'];

/**
 * The retreat corridor. A SOURCE machine is placed at `RETREAT_BLOCKED` on an empty
 * board, the draw sweeps INTO it in one multi-cell sample (which paints red), and one
 * sample back out pops the offending cell.
 *
 * A SOURCE is 1x1 with a single Out port on its E side (`port_catalog`), so nothing on
 * the WEST approach used here is a nub the release could auto-dock onto. The auto-dock
 * fallback only looks for In(0) nubs, and this machine has none at all, which is why the
 * "no dock" assertion below is a real observation rather than a coincidence of distance.
 */
const RETREAT_FROM: readonly [number, number] = [3, 5];
const RETREAT_BLOCKED: readonly [number, number] = [6, 5];
const RETREAT_BACK: readonly [number, number] = [5, 5];
const RETREAT_PATH: readonly (readonly [number, number])[] = [
  [3, 5],
  [4, 5],
  [5, 5],
];

/** The newest belt on the board: the one the gesture under test just landed. */
function newestBelt(scene: SceneFacts) {
  expect(scene.belts.length, 'the gesture landed a belt at all').toBeGreaterThan(0);
  return scene.belts.reduce((newest, b) => (b.id > newest.id ? b : newest));
}

/** The tile list of a belt as plain cell pairs. */
function tilesOf(belt: SceneFacts['belts'][number]): number[][] {
  return belt.tiles.map((t) => [t.cell_x, t.cell_y]);
}

/**
 * The tile-kind discriminant names on a belt, in tile order: `Straight` or `Corner`.
 * The render packet carries `kind` as the Rust enum's externally-tagged object
 * (`{ Straight: { axis } }` / `{ Corner: { from, to } }`, `src/protocol/decode.ts`), so
 * the tag is the object's single key.
 */
function tileKinds(belt: SceneFacts['belts'][number]): string[] {
  return belt.tiles.map((t) => Object.keys(t.kind as Record<string, unknown>)[0] ?? 'UNKNOWN');
}

/**
 * An EMPTY board at scale 1, with the Belt tool NOT yet armed.
 *
 * Scale 1 is read rather than trusted, because every cell centre below is computed in
 * world px and driven as a screen point.
 */
async function emptyBoardAtScaleOne(page: Page): Promise<void> {
  await resetToDemo(page, DEMO_NODE_COUNT);
  await newBoard(page);
  await resetZoomToActualSize(page);
  await waitForCameraSettle(page);
  expect(
    (await cameraOf(page)).scale,
    'the camera is at scale 1, so a world px is a screen px and every cell centre below is exact',
  ).toBe(1);
}

/** Assert, from the LIVE scene, that every named cell carries no machine and no belt. */
function expectCellsFree(
  scene: SceneFacts,
  cells: readonly (readonly [number, number])[],
  why: string,
): void {
  for (const [cx, cy] of cells) {
    expect(
      scene.belts.some((b) => b.tiles.some((t) => t.cell_x === cx && t.cell_y === cy)),
      `(${cx},${cy}) carries no belt (${why})`,
    ).toBe(false);
    expect(
      scene.nodes.some((n) => n.cells.some(([nx, ny]) => nx === cx && ny === cy)),
      `(${cx},${cy}) is outside every machine footprint (${why})`,
    ).toBe(false);
  }
}

/** Arm the Belt tool. Prefix-matched: the title is user-facing COPY (the 52-05 lesson). */
async function armBeltTool(page: Page): Promise<void> {
  await page.getByTitle(/^Draw belts/).click();
}

test.describe.configure({ mode: 'serial' });

test.describe('the belt draw gesture on the real host: a corner, and a retreat', () => {
  test('THE ELBOW AS A HAND DRAWS IT: one sample that crosses a column line and a row line together', async ({
    page,
  }) => {
    const errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await emptyBoardAtScaleOne(page);
    expectCellsFree(await readScene(page), ELBOW_PATH, 'the elbow corridor on a new board');

    await armBeltTool(page);
    const from = await screenCellCentre(page, ELBOW_FROM[0], ELBOW_FROM[1]);
    const to = await screenCellCentre(page, ELBOW_TO[0], ELBOW_TO[1]);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    // THE WHOLE EXPERIMENT, IN ONE LINE. One `page.mouse.move` with no `steps`, so
    // Playwright emits exactly ONE pointermove, and it crosses THREE column lines and
    // TWO row lines together.
    await page.mouse.move(to.x, to.y);
    await page.mouse.up();
    await page.keyboard.press('Escape');

    await pollScene(page, (s) => s.belts.length, {
      message:
        'ONE diagonal pointer sample landed a belt. Before plan 74-14 the accumulator ' +
        'considered only the sample own cell, which is two cells diagonally from the head, ' +
        'so the sample was discarded and the release committed a single-cell belt instead.',
    }).toBe(1);

    const belt = newestBelt(await readScene(page));
    expect(
      tilesOf(belt),
      'the belt is the staircase the cursor swept, in crossing order, x-axis first at the ' +
        'lattice corners the centre-to-centre diagonal hits exactly',
    ).toEqual(ELBOW_PATH.map(([x, y]) => [x, y]));
    // A CORNER EXISTS, and this is the assertion no other fixture in this repository
    // makes: every authored belt run in the e2e and live suites is straight, so until
    // this leg nothing proved a gesture could land a corner at all.
    const kinds = tileKinds(belt);
    expect(kinds, 'the landed belt carries at least one Corner tile').toContain('Corner');
    expect(kinds, 'a staircase turns at every interior tile and runs straight at both ends')
      .toEqual(ELBOW_KINDS);
    expect(
      belt.docks ?? [],
      'the draw was floor to floor, so the gesture docked nothing',
    ).toHaveLength(0);

    await expectRenderLoopAlive(page, 'after the one-sample elbow draw');
    errs.assertNone('the one-sample elbow draw');
  });

  test('THE DISCRIMINATOR: with cell-teleporting moves the same corner lands', async ({ page }) => {
    // THE ONE-VARIABLE CONTROL. Same board, same two endpoints, same expected belt: the
    // ONLY difference is that the pointer steps every intermediate cell centre instead of
    // jumping the diagonal in one sample. This is what makes a red on the leg above mean
    // THE DIAGONAL SAMPLE rather than the board, the harness or the host, and it is the
    // shape `74-belt-join-press-on-end.live.spec.ts` already uses for the same purpose.
    // Neither leg may be deleted, renamed, skipped or weakened without the other losing
    // its meaning.
    const errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await emptyBoardAtScaleOne(page);
    expectCellsFree(await readScene(page), ELBOW_PATH, 'the elbow corridor on a new board');

    await armBeltTool(page);
    const first = await screenCellCentre(page, ELBOW_PATH[0][0], ELBOW_PATH[0][1]);
    await page.mouse.move(first.x, first.y);
    await page.mouse.down();
    for (const [cx, cy] of ELBOW_PATH.slice(1)) {
      const pt = await screenCellCentre(page, cx, cy);
      await page.mouse.move(pt.x, pt.y);
    }
    await page.mouse.up();
    await page.keyboard.press('Escape');

    await pollScene(page, (s) => s.belts.length, {
      message: 'a cell-teleporting draw lands the same staircase (the control)',
    }).toBe(1);

    const belt = newestBelt(await readScene(page));
    expect(tilesOf(belt), 'the teleporting draw lands the SAME tiles as the diagonal one').toEqual(
      ELBOW_PATH.map(([x, y]) => [x, y]),
    );
    expect(tileKinds(belt), 'and the same corner inference').toEqual(ELBOW_KINDS);

    await expectRenderLoopAlive(page, 'after the teleporting elbow draw');
    errs.assertNone('the teleporting elbow draw');
  });

  test('THE RETREAT AS A HAND DRIVES IT: dragging back out of a tile you clipped recovers the draw', async ({
    page,
  }) => {
    const errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await emptyBoardAtScaleOne(page);

    // The obstacle, placed rather than borrowed from a board that could move under this
    // spec. A SOURCE is 1x1 and its only port is an Out on the E side, so the WEST
    // approach below touches no nub.
    await armAndPlaceAt(page, 'Source', RETREAT_BLOCKED[0], RETREAT_BLOCKED[1]);
    await pollScene(page, (s) => s.nodes.length, {
      message: 'the real host folded the Place (one machine on an otherwise empty board)',
    }).toBe(1);

    const before = await readScene(page);
    expectCellsFree(before, RETREAT_PATH, 'the retreat corridor');
    expect(
      before.nodes[0].cells.map(([x, y]) => [x, y]),
      'the obstacle really occupies the cell the drag is going to clip',
    ).toEqual([[RETREAT_BLOCKED[0], RETREAT_BLOCKED[1]]]);
    expect(
      before.nodes[0].ports.map((pt) => [pt.cell_x, pt.cell_y, pt.side, pt.role]),
      'a SOURCE has exactly one port, an Out on its E side, so the W approach passes no nub',
    ).toEqual([[RETREAT_BLOCKED[0], RETREAT_BLOCKED[1], 1, 1]]);

    await armBeltTool(page);
    const start = await screenCellCentre(page, RETREAT_FROM[0], RETREAT_FROM[1]);
    const clipped = await screenCellCentre(page, RETREAT_BLOCKED[0], RETREAT_BLOCKED[1]);
    const back = await screenCellCentre(page, RETREAT_BACK[0], RETREAT_BACK[1]);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    // ONE multi-cell sample, three cells east, ending INSIDE the machine's tile. Every
    // cell the cursor crossed is appended, the machine's tile included, so the preview
    // paints red - which is the shipped occupancy decision and is not what this leg
    // changes.
    await page.mouse.move(clipped.x, clipped.y);
    // And ONE sample back the way it came. That is the recovery: before plan 74-14 the
    // path could only be pushed, so this sample appended a duplicate, `route()` answered
    // SelfCrossing, and the drag was dead with no way back except starting over.
    await page.mouse.move(back.x, back.y);
    await page.mouse.up();
    await page.keyboard.press('Escape');

    await pollScene(page, (s) => s.belts.length, {
      message:
        'the retreat recovered the draw and the release committed the SHORTER belt. Before ' +
        'plan 74-14 nothing committed at all: the returning sample poisoned the path.',
    }).toBe(1);

    const belt = newestBelt(await readScene(page));
    expect(
      tilesOf(belt),
      'the committed belt is the path as it stood AFTER the retreat: the clipped tile is gone',
    ).toEqual(RETREAT_PATH.map(([x, y]) => [x, y]));
    expect(
      tilesOf(belt).some(
        ([x, y]) => x === RETREAT_BLOCKED[0] && y === RETREAT_BLOCKED[1],
      ),
      'and the machine tile the cursor clipped is not in it',
    ).toBe(false);
    expect(
      belt.docks ?? [],
      'the release landed on plain floor beside a machine with no In port, so no dock was made',
    ).toHaveLength(0);

    await expectRenderLoopAlive(page, 'after the retreat draw');
    errs.assertNone('the retreat draw');
  });
});
