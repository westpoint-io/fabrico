import { test, expect, type Page } from '@playwright/test';
import { addFrameBudget } from '../e2e/support/frameSampler';
// The PNG decoder @playwright/test already bundles (pngjs), the idiom
// `06-fault-red-probe.spec.ts` uses: no new dependency is added to read the canvas.
// eslint-disable-next-line @typescript-eslint/no-var-requires
import { PNG } from 'playwright-core/lib/utilsBundle';
import {
  DEMO_NODE_COUNT,
  cameraOf,
  captureClip,
  captureCostLine,
  clickAt,
  expectRefusalStayedSilent,
  expectRenderLoopAlive,
  newBoard,
  pointerTravel,
  pollScene,
  readScene,
  resetToDemo,
  resetZoomToActualSize,
  screenCellCentre,
  screenPoint,
  tileKindAt,
  waitForAppReady,
  waitForCameraSettle,
  watchPageErrors,
  type SceneFacts,
} from './support/oracle';
import { CELL, rampOracles, colorToRgb } from '../shared/geometry';
// Phase 91 (D-10, CHROME-10): the empty board's words, imported so the hint's boxes are found by
// the words the app renders (a retyped body stopped matching and its box silently dropped out).
import { EMPTY_FLOOR_BODY, EMPTY_FLOOR_HEADING } from '../src/chrome/configCopy';

// 74.1-seam-corner.live.spec.ts (CORNER-01, CORNER-06) - the JOIN graded on what the user
// SEES: the tile kind the real `dev_render_server` ships at a docked seam.
//
// ---------------------------------------------------------------------------
// WHAT THIS FILE IS FOR (gap 1 of 74.1-VERIFICATION.md)
// ---------------------------------------------------------------------------
//
// S1, S2 and S4 were rejected on the real binary: a belt drawn north at once off a belt end
// docked in the model, but the join drew as a T, the old belt's end butting into the side of
// a straight tile with a collar between them. Every earlier check graded the LINK (a dock
// read 1/1 from both sides) and passed while the screen showed the T. So this file grades the seam on
// the shipped tile KIND: the new belt's first tile must arrive as a 90 degree Corner from
// the old belt's flow (east) into its own (north). Since plan 74.1-07 the host derives that
// kind at read (`GridState::effective_belt_tiles`, shipped by `render_packet.rs`
// `current_views`); the stored geometry stays the Straight route() typed.
//
// ---------------------------------------------------------------------------
// WHY A NEW FILE
// ---------------------------------------------------------------------------
//
// `74.1-corner-connects.live.spec.ts` is count-gated at exactly 6 tests by its plans, so the
// seam legs live here. The helpers below are COPIED from it, not imported: spec files export
// nothing. This file declares exactly 1 test after plan 74.1-07 and 3 after plan 74.1-09.
//
// ---------------------------------------------------------------------------
// THE THREE LEGS (this file declares exactly 3 tests)
// ---------------------------------------------------------------------------
//
//   1. S1 ON THE REAL HOST (plan 74.1-07): the seam tile KIND the packet ships is the
//      corner, the link alone is not the claim.
//   2. THE SEAM DRAWS AS THE REFERENCE CORNER (plan 74.1-09, gap 3): the canvas PIXELS
//      of the seam tile read like a reference Corner{E,N} drawn east then north on the same
//      board, and unlike a reference north-south straight, at scale 1 and at 3 or more.
//      This is the one leg here that reads no model fact for its claim: a renderer that
//      drew the shipped Corner as a straight would pass leg 1 and fail this one. Since plan
//      74.1-21 (review WR-06) it also grades the corner's PRESENCE and DIRECTION with two
//      positive boxes, so a seam tile drawn blank, not drawn, or turned the wrong way
//      fails it too (each watched RED at both scales).
//   3. A HANDLE DRAG THAT DOCKS SIDEWAYS SHIPS A CORNER (plan 74.1-09, review CR-01): the
//      Dock command path that adds no tile still ships the derived corner, and one Ctrl+Z,
//      which undoes the Dock, returns the straight end.
//
// ---------------------------------------------------------------------------
// EVERY BELT-DRAWING LEG DRIVES SUB-CELL POINTER SAMPLES
// ---------------------------------------------------------------------------
//
// A fixture that teleports one clean cell per pointer event hides gesture defects that a
// real hand exposes, so every move here emits STEPS_PER_CELL samples per cell
// (`page.mouse.move(..., { steps })`), the first several inside the tile the press landed in.
//
// MODEL FIRST, THEN RENDER HEALTH. The scene oracle reads the decoded packet, which keeps
// advancing with a dead renderer, so the leg ends with `expectRenderLoopAlive` and
// `watchPageErrors(...).assertNone`.

/** Belt A, drawn first on an empty board: four cells east, Head (7,6). */
const FIRST_CELLS: readonly (readonly [number, number])[] = [
  [4, 6],
  [5, 6],
  [6, 6],
  [7, 6],
];
/** Belt A's Head tile. The junction is read here; it is NOT pressed. */
const HEAD_CELL = [7, 6] as const;
/** The Head's doorstep: the empty floor tile it faces, where the press lands. */
const BELT_DOORSTEP = [8, 6] as const;
/** The new belt: off the doorstep, north at once, four cells. */
const CORNER_CELLS: readonly (readonly [number, number])[] = [
  [8, 6],
  [8, 5],
  [8, 4],
  [8, 3],
];

/** Pointer samples per one-cell move at scale 1: an eighth of a cell each (4 screen px). */
const STEPS_PER_CELL = 8;

/** The most wheel notches the probe takes to reach scale 3 or more (the zoom's own bound). */
const WHEEL_NOTCHES_MAX = 20;
/**
 * The frames one wheel notch costs, measured at the GPU proxy (plan 84-18 Task 1): a notch is an
 * input event the page acknowledges like a pointer move, but the trace timed 24 notches at up to
 * 833 ms each (median 407 to 605), at THE PAIR's 4.53 frames a second 3.8 frames, so 4, not
 * `HAND_MOVE_FRAMES` (2).
 */
const WHEEL_NOTCH_FRAMES = 4;

/** Leg 3's belt A: drawn north, Head (8,6). */
const HANDLE_A_CELLS: readonly (readonly [number, number])[] = [
  [8, 9],
  [8, 8],
  [8, 7],
  [8, 6],
];
/** Leg 3's belt B: drawn east, Tail (9,6), one step east of A's Head. */
const HANDLE_B_CELLS: readonly (readonly [number, number])[] = [
  [9, 6],
  [10, 6],
  [11, 6],
];

/**
 * The wire encodings the kinds below are written in (`TileKindView`): Axis X=0, Y=1;
 * Dir N=0, E=1, S=2, W=3. The seam turns from A's flow (E) into the new belt's (N).
 */
const SEAM_CORNER = { Corner: { from: 1, to: 0 } };
/** A north-flowing belt end docked to a run that leaves east: Corner{from:N, to:E}. */
const HEAD_CORNER_N_TO_E = { Corner: { from: 0, to: 1 } };
const STRAIGHT_NS = { Straight: { axis: 1 } };
const STRAIGHT_EW = { Straight: { axis: 0 } };

/** Every belt that occupies (cx, cy). */
function beltsAt(scene: SceneFacts, cx: number, cy: number) {
  return scene.belts.filter((b) => b.tiles.some((t) => t.cell_x === cx && t.cell_y === cy));
}

/**
 * The junction between belt A and the run drawn off its doorstep, read from BOTH SIDES and
 * resolved BY CELL (handles can be reminted by a keyframe). `'1/1'` is joined, `'0/0'` is two
 * runs that only abut, `'MISSING'` is fewer than two belts there.
 */
function junction(scene: SceneFacts): string {
  const up = beltsAt(scene, HEAD_CELL[0], HEAD_CELL[1])[0];
  const down = beltsAt(scene, BELT_DOORSTEP[0], BELT_DOORSTEP[1])[0];
  if (!up || !down || up.id === down.id) return 'MISSING';
  const a = (up.docks ?? []).filter((d) => d.end === 'Head' && d.node === down.id).length;
  const b = (down.docks ?? []).filter((d) => d.end === 'Tail' && d.node === up.id).length;
  return `${a}/${b}`;
}

/** The new belt's shipped tile kinds, in tile order, or `null` before it exists. */
function seamBeltKinds(scene: SceneFacts): unknown[] | null {
  const down = beltsAt(scene, BELT_DOORSTEP[0], BELT_DOORSTEP[1]);
  if (down.length !== 1) return null;
  return down[0].tiles.map((t) => t.kind);
}

/** Assert every screen point is on the CANVAS, so no chrome panel eats the press. */
async function expectOnCanvas(page: Page, pts: { x: number; y: number }[], context: string): Promise<void> {
  const tags = await page.evaluate(
    (ps) => ps.map((p) => document.elementFromPoint(p.x, p.y)?.tagName ?? null),
    pts,
  );
  expect(tags, `${context}: every point is on the canvas, not under chrome`).toEqual(pts.map(() => 'CANVAS'));
}

/**
 * Drive the pointer through `cells` (the first already pressed), cell centre to cell centre,
 * each move emitting `steps` samples, so the first samples land inside the pressed tile.
 */
async function moveThroughCells(
  page: Page,
  cells: readonly (readonly [number, number])[],
  steps: number,
): Promise<void> {
  for (const [cx, cy] of cells) {
    const pt = await screenCellCentre(page, cx, cy);
    await pointerTravel(page, pt.x, pt.y, steps);
  }
}

/**
 * An empty board at camera scale 1 (READ and asserted) holding belt A, drawn with sub-cell
 * samples, with the Belt tool left ARMED.
 */
async function boardWithOneBelt(page: Page): Promise<void> {
  await resetToDemo(page, DEMO_NODE_COUNT);
  await newBoard(page);
  await resetZoomToActualSize(page);
  await waitForCameraSettle(page);
  expect((await cameraOf(page)).scale, 'the camera is at scale 1').toBe(1);
  await page.getByTitle(/^Draw belts/).click();
  const start = await screenCellCentre(page, FIRST_CELLS[0][0], FIRST_CELLS[0][1]);
  const end = await screenCellCentre(page, HEAD_CELL[0], HEAD_CELL[1]);
  await expectOnCanvas(page, [start, end], 'belt A');
  await pointerTravel(page, start.x, start.y);
  await page.mouse.down();
  await moveThroughCells(page, FIRST_CELLS.slice(1), STEPS_PER_CELL);
  await page.mouse.up();
  await pollScene(page, (s) => s.belts.length, {
    message: 'the real host folded the first DrawBelt (one belt on an otherwise empty board)',
  }).toBe(1);
  const only = await readScene(page);
  expect(
    only.belts[0].tiles.map((t) => [t.cell_x, t.cell_y]),
    'belt A is exactly FIRST_CELLS',
  ).toEqual(FIRST_CELLS.map(([x, y]) => [x, y]));
  expect(only.belts[0].docks ?? [], 'belt A starts undocked').toHaveLength(0);
}

/**
 * The reference belt for the pixel probe: east then north, its interior (12,6) a
 * Corner{E,N}. Every probed tile sits in rows 5 and 6, and the zoom is anchored on row 5's
 * top edge, so at both scales the clips stay below the empty-floor hint, an HTML overlay
 * centred on the canvas (measured: at 3.32 a row-4 tile lies under its text).
 */
const REF_CELLS: readonly (readonly [number, number])[] = [
  [10, 6],
  [11, 6],
  [12, 6],
  [12, 5],
  [12, 4],
];
/** The reference corner: the approved shape at J4 (a belt drawn east then north). */
const REF_CORNER = [12, 6] as const;
/** The reference straight: the seam belt's own interior north-south tile next to the seam. */
const REF_STRAIGHT = [8, 5] as const;
/** Empty floor inside the probed region, where the board ground colour is read. */
const GROUND_TILE = [10, 5] as const;
/** The world point the pointer parks on and the zoom is anchored at: row 5's top edge. */
const PARK_WORLD = { x: 10.5 * CELL, y: 5 * CELL } as const;

/** A world-px box inside a tile, relative to the tile's top-left corner: [x0, x1) x [y0, y1). */
type Box = readonly [number, number, number, number];

/**
 * THE INK SIGNATURE, and why it reads these two boxes. The belt lane is HOLLOW: two 1 px
 * rails `laneHalf` 10 either side of the centreline, painted on the board's own ground
 * colour, plus a centreline dash that marches with the render clock (`BELT_GEOM`,
 * `shared/geometry.ts`). So the signature reads RAILS, never the centreline:
 *
 *   - S, by the SOUTH edge east of centre, x 18..30, y 24..30; E, by the EAST edge south
 *     of centre, x 24..30, y 18..30 (world px inside the tile).
 *   - A north-south STRAIGHT has its east rail at x 26 through both; an east-west straight
 *     has its south rail at y 26 through both. The centreline (x or y 15..17) is in
 *     neither, so the count does not depend on tread phase.
 *   - A Corner{E,N} (in from the west, out to the north) is a quarter annulus about the
 *     tile's north-west corner, outer rail radius 26: at y >= 24 it is at x <= 10, at
 *     x >= 24 it is at y <= 10. Neither box holds any of it.
 *   - Neither box touches the WEST edge, where the junction collar is drawn on the seam,
 *     or a tile edge, where the floor grid lines are.
 *
 * Measured on the grid of 4 world px boxes at scale 1 and 3.32 before these were chosen.
 */
const SIG_BOXES: readonly Box[] = [
  [18, 30, 24, 30],
  [24, 30, 18, 30],
];
const SIG_NAMES = ['S', 'E'] as const;
/**
 * THE FLOORS, measured at this tree on the live suite's Desktop Chrome (three runs, every
 * count identical), and set as 74.1-04 set its ring floor: half the smaller measured inked
 * count of the reference straight. Measured S/E: 5/11 at scale 1, 57/117 at scale 3.32; so
 * 2 at scale 1 and 28 at 3 or more. The seam and the reference corner measured 0/0 at both
 * scales, so the corner ceiling is 0.
 */
const SIG_FLOOR_AT_1 = 2;
const SIG_FLOOR_AT_3_PLUS = 28;
const SIG_CORNER_CEILING = 0;

/**
 * THE POSITIVE HALF (plan 74.1-21, review WR-06). The two boxes above only grade where a
 * straight's rail WOULD be, and every assertion on them is an upper bound, so a seam tile
 * drawn blank, not drawn at all, or drawn at zero alpha scores 0/0 and passes. This box
 * reads ink that only a drawn corner puts there: the corner's OUTER RAIL ARC.
 *
 * WHERE IT IS, DERIVED FROM THE BELTS LAYER'S CORNER GEOMETRY (`beltGeometry.ts`
 * `cornerRailCommands`): a Corner{E,N} is a quarter annulus about the tile's north-west
 * vertex, centreline radius `elbowR` 16, and its outer rail inks radius 25..26 at the
 * identity quantum (`elbowR + laneHalf` with the half-band inset). The box x 14..24,
 * y 14..24 holds the arc's middle third (about 30 to 60 degrees off either axis):
 *
 *   - its nearest point to the vertex, (14,14), is at radius 19.8, clear of the tread band
 *     (radius 15..17) and the inner rail (6..7), so it does not depend on tread phase;
 *   - its nearest point to the west-edge midpoint (0,16), where the junction collar is
 *     drawn (ring radius 7, stroke 2, so ink to radius 8), is (14,16) at 14 world px, so the
 *     collar never reaches it;
 *   - it touches no tile edge, where the floor grid lines are.
 *
 * A north-south straight's centreline dash crosses it, so on its own this box cannot tell
 * a corner from a straight: the S and E ceilings above do that. This box tells a drawn
 * corner from NO corner.
 */
const ARC_BOX: Box = [14, 24, 14, 24];
/**
 * THE ARC FLOORS, measured on the REFERENCE CORNER (12,6) on the real renderer, three runs
 * at plan 74.1-21 on the live suite's Desktop Chrome, every reading identical: 10 at scale
 * 1, 103 at scale 3.32. Set as the straight floors above were: half the smallest reading.
 */
const ARC_INK_FLOOR_AT_1 = 5;
const ARC_INK_FLOOR_AT_3_PLUS = 51;
/**
 * THE DIRECTION HALF, added because the rail box alone was WATCHED to pass a reversed
 * corner (plan 74.1-21, mutation 3: tile 0 drawn as Corner{S,W}, ARC seam 10 / 103, leg
 * green). Corner{S,W} rounds the SAME north-west vertex, and a corner's two rails are
 * symmetric under reversing the flow, so no rail box can tell the two apart. The TREAD can:
 * `cornerCommands` lays its dashes by arc length from the ENTRY edge, so the pattern of a
 * reversed corner is the mirror image along the arc.
 *
 * THE PHASE IS FIXED, which is what makes a tread box sound here. The render clock is
 * pinned at 0 below, so a tile's march bucket is a function of its tail offset alone
 * (`bucketOf`), and both probed corners sit at offset 0 mod the 16 px dash period: the
 * seam is its belt's tile 0 (offset 0) and the reference corner is the reference belt's
 * tile 2 (offset 64). At that phase a Corner{E,N} inks its centreline band (radius
 * 15..17) at arc length 6..16 and 22..25.1 from its WEST entry; a Corner{S,W} inks 0..3.1
 * and 9.1..19.1 measured from the west. The run at 22..25.1 (78.8 to 90 degrees off the
 * vertical, ending on the NORTH edge midpoint) is ink ONLY for the right direction, and
 * the reversed corner is blank from 68.5 degrees up.
 *
 * The box x 13..19, y 0.5..4 holds that run: at the band's inner radius 15 its lowest row
 * is 74.5 degrees off the vertical, 6 degrees clear of the reversed dash's radial end cap;
 * it starts half a pixel below the tile's north edge, clear of the floor grid line; and it
 * is 13 world px from the west-edge collar. A north-south straight's dash also crosses it,
 * which, as for `ARC_BOX`, the S and E ceilings answer.
 */
const ARC_EXIT_TREAD_BOX: Box = [13, 19, 0.5, 4];
/**
 * Measured on the reference corner exactly as the arc floors were: 4 at scale 1, 58 at
 * scale 3.32, every one of three runs identical; half the smallest reading.
 */
const ARC_EXIT_TREAD_FLOOR_AT_1 = 2;
const ARC_EXIT_TREAD_FLOOR_AT_3_PLUS = 29;

/** A pixel is belt ink when some channel is more than this many levels from the ground. */
const INK_TOLERANCE = 24;

/** The empty-floor hint's two text blocks, which are drawn over the canvas without pointer events. */
async function hintRects(page: Page): Promise<{ x: number; y: number; width: number; height: number }[]> {
  const out: { x: number; y: number; width: number; height: number }[] = [];
  for (const loc of [
    page.getByRole('heading', { name: EMPTY_FLOOR_HEADING, exact: true }),
    page.getByText(EMPTY_FLOOR_BODY, { exact: true }),
  ]) {
    if ((await loc.count()) > 0 && (await loc.first().isVisible())) {
      const bb = await loc.first().boundingBox();
      if (bb) out.push(bb);
    }
  }
  return out;
}

/**
 * The ink count of world-px boxes inside one tile, read off a decoded screenshot clip of
 * that tile (so the device pixel ratio is the image's, not assumed). The clip must lie on
 * the canvas, inside the viewport, and clear of the empty-floor hint's text.
 */
async function tileInk(
  page: Page,
  cell: readonly [number, number],
  boxes: readonly Box[],
  ground: { r: number; g: number; b: number },
): Promise<number[]> {
  const cam = await cameraOf(page);
  const tl = await screenPoint(page, { x: cell[0] * CELL, y: cell[1] * CELL });
  const x0 = Math.floor(tl.x);
  const y0 = Math.floor(tl.y);
  const side = Math.ceil(CELL * cam.scale) + 2;
  const vp = page.viewportSize();
  expect(vp, 'the live page reports a viewport size').not.toBeNull();
  expect(
    x0 >= 0 && y0 >= 0 && x0 + side <= vp!.width && y0 + side <= vp!.height,
    `the clip of tile (${cell[0]},${cell[1]}) lies inside the viewport at scale ${cam.scale}`,
  ).toBe(true);
  await expectOnCanvas(
    page,
    [
      { x: x0, y: y0 },
      { x: x0 + side - 1, y: y0 },
      { x: x0, y: y0 + side - 1 },
      { x: x0 + side - 1, y: y0 + side - 1 },
    ],
    `the clip of tile (${cell[0]},${cell[1]})`,
  );
  for (const r of await hintRects(page)) {
    const clear = r.x >= x0 + side || r.x + r.width <= x0 || r.y >= y0 + side || r.y + r.height <= y0;
    expect(clear, `the clip of tile (${cell[0]},${cell[1]}) is clear of the empty-floor hint text`).toBe(true);
  }
  const png = PNG.sync.read(await captureClip(page, { x: x0, y: y0, width: side, height: side }));
  const ratio = png.width / side;
  return boxes.map(([bx0, bx1, by0, by1]) => {
    const px0 = Math.ceil((tl.x + bx0 * cam.scale - x0) * ratio);
    const px1 = Math.floor((tl.x + bx1 * cam.scale - x0) * ratio);
    const py0 = Math.ceil((tl.y + by0 * cam.scale - y0) * ratio);
    const py1 = Math.floor((tl.y + by1 * cam.scale - y0) * ratio);
    let ink = 0;
    for (let py = Math.max(0, py0); py < Math.min(png.height, py1); py++) {
      for (let px = Math.max(0, px0); px < Math.min(png.width, px1); px++) {
        const i = (py * png.width + px) << 2;
        if (
          Math.abs(png.data[i] - ground.r) > INK_TOLERANCE ||
          Math.abs(png.data[i + 1] - ground.g) > INK_TOLERANCE ||
          Math.abs(png.data[i + 2] - ground.b) > INK_TOLERANCE
        ) {
          ink++;
        }
      }
    }
    return ink;
  });
}

/**
 * The board ground colour: the most common pixel in the middle of an empty floor tile,
 * asserted to be the skin's `ramp[0]`, the colour the floor and a belt's hollow share.
 */
async function groundColour(page: Page): Promise<{ r: number; g: number; b: number }> {
  const cam = await cameraOf(page);
  const tl = await screenPoint(page, { x: GROUND_TILE[0] * CELL + 8, y: GROUND_TILE[1] * CELL + 8 });
  const png = PNG.sync.read(
    await captureClip(page, {
      x: Math.ceil(tl.x),
      y: Math.ceil(tl.y),
      width: Math.floor(14 * cam.scale),
      height: Math.floor(14 * cam.scale),
    }),
  );
  const counts = new Map<string, number>();
  for (let i = 0; i < png.data.length; i += 4) {
    const k = `${png.data[i]},${png.data[i + 1]},${png.data[i + 2]}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const [top] = [...counts].sort((a, b) => b[1] - a[1]);
  const [r, g, b] = top[0].split(',').map(Number);
  expect({ r, g, b }, 'the floor reads as the skin ground ramp[0]').toEqual(colorToRgb(rampOracles.locked[0]));
  return { r, g, b };
}

test.describe.configure({ mode: 'serial' });

test.describe('CORNER-01 seam on the real host: the join is graded on the shipped tile kind', () => {
  test('S1 ON THE REAL HOST: a belt drawn north at once off a belt end ships a 90 degree corner at the seam', async ({
    page,
  }) => {
    const errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await boardWithOneBelt(page);
    const before = await readScene(page);
    for (const [cx, cy] of CORNER_CELLS) {
      expect(beltsAt(before, cx, cy), `(${cx},${cy}) is free floor before the corner`).toHaveLength(0);
    }

    // Press the doorstep centre and drag north at once, sub-cell samples throughout.
    const door = await screenCellCentre(page, BELT_DOORSTEP[0], BELT_DOORSTEP[1]);
    const last = await screenCellCentre(page, CORNER_CELLS[3][0], CORNER_CELLS[3][1]);
    await expectOnCanvas(page, [door, last], 'the seam draw');
    await pointerTravel(page, door.x, door.y);
    await page.mouse.down();
    await moveThroughCells(page, CORNER_CELLS.slice(1), STEPS_PER_CELL);
    await page.mouse.up();
    await page.keyboard.press('Escape');

    // The link, read from both sides. Necessary, and NOT the join claim: this passed while
    // the screen showed a T.
    await pollScene(page, (s) => s.belts.length, { message: 'a second belt was minted' }).toBe(2);
    await pollScene(page, junction, {
      message: "belt A's Head dock names the new belt AND the new belt's Tail dock names A",
    }).toBe('1/1');
    const after = await readScene(page);
    const drawn = beltsAt(after, BELT_DOORSTEP[0], BELT_DOORSTEP[1]);
    expect(drawn, 'exactly one belt starts on the doorstep').toHaveLength(1);
    expect(
      drawn[0].tiles.map((t) => [t.cell_x, t.cell_y]),
      'the new belt starts ON the pressed doorstep and turns north at once',
    ).toEqual([
      [8, 6],
      [8, 5],
      [8, 4],
      [8, 3],
    ]);

    // THE JOIN CLAIM: the seam tile the packet ships is a 90 degree corner from A's flow (E)
    // into the new belt's (N). Polled, because the Dock echo lands one packet after the
    // DrawBelt echo.
    await pollScene(page, (s) => seamBeltKinds(s)?.[0] ?? null, {
      message: "the new belt's seam tile (8,6) ships Corner{from:E, to:N}, not the Straight route() stored",
    }).toEqual({ Corner: { from: 1, to: 0 } });
    const settled = await readScene(page);
    const kinds = seamBeltKinds(settled);
    expect(kinds, 'the new belt is readable by cell').not.toBeNull();
    expect(kinds![0], 'tile 0 is the seam corner').toEqual(SEAM_CORNER);
    for (let i = 1; i < 4; i++) {
      expect(kinds![i], `the new belt's tile ${i} stays a north-south straight`).toEqual(STRAIGHT_NS);
    }
    const a = beltsAt(settled, HEAD_CELL[0], HEAD_CELL[1]);
    expect(a, 'belt A is readable by cell').toHaveLength(1);
    a[0].tiles.forEach((t, i) => {
      expect(t.kind, `belt A's tile ${i} stays an east-west straight (only the carrier bends)`).toEqual(
        STRAIGHT_EW,
      );
    });

    await expectRenderLoopAlive(page, 'after a seam corner off a belt end');
    errs.assertNone('the S1 seam leg');
  });

  test('THE SEAM DRAWS AS THE REFERENCE CORNER, NOT AS A T: pixels at scale 1 and at 3 or more', async ({
    page,
  }) => {
    const errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await boardWithOneBelt(page);

    // The S1 join: press A's doorstep and turn north at once.
    const door = await screenCellCentre(page, BELT_DOORSTEP[0], BELT_DOORSTEP[1]);
    await pointerTravel(page, door.x, door.y);
    await page.mouse.down();
    await moveThroughCells(page, CORNER_CELLS.slice(1), STEPS_PER_CELL);
    await page.mouse.up();
    await pollScene(page, junction, { message: 'the S1 join is docked 1/1' }).toBe('1/1');
    // The reference belt, east then north, on free floor: a plain draw (no doorstep pressed).
    const refStart = await screenCellCentre(page, REF_CELLS[0][0], REF_CELLS[0][1]);
    await expectOnCanvas(page, [refStart], 'the reference belt');
    await pointerTravel(page, refStart.x, refStart.y);
    await page.mouse.down();
    await moveThroughCells(page, REF_CELLS.slice(1), STEPS_PER_CELL);
    await page.mouse.up();
    await page.keyboard.press('Escape');
    await pollScene(page, (s) => s.belts.length, { message: 'the reference belt was minted' }).toBe(3);

    // THE MODEL FIRST: the seam ships the corner, the references are what they claim.
    await pollScene(page, (s) => tileKindAt(s, BELT_DOORSTEP[0], BELT_DOORSTEP[1]), {
      message: 'the seam tile (8,6) ships Corner{from:E, to:N}',
    }).toEqual(SEAM_CORNER);
    const model = await readScene(page);
    expect(tileKindAt(model, REF_CORNER[0], REF_CORNER[1]), 'the reference corner (12,6) is Corner{E,N}').toEqual(
      SEAM_CORNER,
    );
    expect(tileKindAt(model, REF_STRAIGHT[0], REF_STRAIGHT[1]), 'the reference straight (8,5) is north-south').toEqual(
      STRAIGHT_NS,
    );
    expect(tileKindAt(model, GROUND_TILE[0], GROUND_TILE[1]), 'the ground tile (10,5) is empty floor').toBeNull();
    const ref = beltsAt(model, REF_CORNER[0], REF_CORNER[1]);
    expect(ref[0]?.docks ?? [], 'the reference belt docks nothing').toHaveLength(0);

    // Park on empty floor in the middle of the probed region, then freeze the frame: the
    // render clock pinned (06-fault-red-probe's pattern), released in `finally`.
    const park = await screenPoint(page, PARK_WORLD);
    await pointerTravel(page, park.x, park.y, 4);
    await page.evaluate(() => {
      const hook = (window as { __fabrico?: { pinClock(n: number | null): void } }).__fabrico;
      if (!hook) throw new Error('window.__fabrico not installed');
      hook.pinClock(0);
    });
    try {
      const probe = async (label: string): Promise<void> => {
        const scale = (await cameraOf(page)).scale;
        const ground = await groundColour(page);
        const seam = await tileInk(page, BELT_DOORSTEP, SIG_BOXES, ground);
        const corner = await tileInk(page, REF_CORNER, SIG_BOXES, ground);
        const straight = await tileInk(page, REF_STRAIGHT, SIG_BOXES, ground);
        const [seamArc, seamExit] = await tileInk(page, BELT_DOORSTEP, [ARC_BOX, ARC_EXIT_TREAD_BOX], ground);
        const [cornerArc, cornerExit] = await tileInk(page, REF_CORNER, [ARC_BOX, ARC_EXIT_TREAD_BOX], ground);
        console.log(
          `[seam-probe] ${label} scale ${scale} S/E seam ${seam.join('/')} corner ${corner.join('/')} ` +
            `straight ${straight.join('/')} ARC seam ${seamArc} corner ${cornerArc} ` +
            `EXIT seam ${seamExit} corner ${cornerExit}`,
        );
        // THE POSITIVE HALF (WR-06): each box is on corner ink at all, and the seam tile
        // carries as much of it as the floor measured on the reference corner. A seam drawn
        // blank, skipped or at zero alpha fails ARC_BOX; one drawn reversed fails the exit
        // tread box; the ceilings below pass all three. SOFT, so one run grades both scales
        // before the leg fails: a defect that only one scale shows is still reported.
        const arcFloor = scale >= 3 ? ARC_INK_FLOOR_AT_3_PLUS : ARC_INK_FLOOR_AT_1;
        const exitFloor = scale >= 3 ? ARC_EXIT_TREAD_FLOOR_AT_3_PLUS : ARC_EXIT_TREAD_FLOOR_AT_1;
        expect
          .soft(cornerArc, `${label}: the reference corner has outer-rail arc ink in ARC_BOX`)
          .toBeGreaterThanOrEqual(arcFloor);
        expect
          .soft(cornerExit, `${label}: the reference corner has exit-run tread ink in ARC_EXIT_TREAD_BOX`)
          .toBeGreaterThanOrEqual(exitFloor);
        expect
          .soft(
            seamArc,
            `${label}: the seam tile (8,6) is DRAWN as a corner: outer-rail arc ink in ARC_BOX (seam ${seamArc}, ` +
              `corner ${cornerArc}, floor ${arcFloor})`,
          )
          .toBeGreaterThanOrEqual(arcFloor);
        expect
          .soft(
            seamExit,
            `${label}: the seam tile (8,6) turns the right way, E into N: exit-run tread ink in ` +
              `ARC_EXIT_TREAD_BOX (seam ${seamExit}, corner ${cornerExit}, floor ${exitFloor})`,
          )
          .toBeGreaterThanOrEqual(exitFloor);
        SIG_NAMES.forEach((name, k) => {
          // The probe can see a straight: the reference straight's rail is inked in this box.
          const floor = scale >= 3 ? SIG_FLOOR_AT_3_PLUS : SIG_FLOOR_AT_1;
          expect(straight[k], `${label}: the reference straight has rail ink in box ${name}`).toBeGreaterThanOrEqual(
            floor,
          );
          // The reference corner has none there.
          expect(corner[k], `${label}: the reference corner has no ink in box ${name}`).toBeLessThanOrEqual(
            SIG_CORNER_CEILING,
          );
          // THE CLAIM: the seam reads as the corner, not as the straight.
          expect(
            seam[k],
            `${label}: the seam tile (8,6) reads as the corner in box ${name} (seam ${seam[k]}, ` +
              `corner ${corner[k]}, straight ${straight[k]}), not as a T`,
          ).toBeLessThanOrEqual(SIG_CORNER_CEILING);
        });
      };
      expect((await cameraOf(page)).scale, 'the probe starts at camera scale 1').toBe(1);
      await probe('scale 1');
      // Wheel IN about the parked point until the camera READS 3 or more (the walk binary
      // opened at 3.19). Bounded: fail if not reached. The bound is budgeted before the loop at
      // `WHEEL_NOTCH_FRAMES` a notch (plan 84-18, D-12).
      addFrameBudget(
        WHEEL_NOTCHES_MAX * WHEEL_NOTCH_FRAMES,
        `wheel in to scale 3: at most ${WHEEL_NOTCHES_MAX} notches`,
      );
      for (let notch = 0; notch < WHEEL_NOTCHES_MAX && (await cameraOf(page)).scale < 3; notch++) {
        await page.mouse.wheel(0, -100);
        await page.waitForTimeout(30);
      }
      await waitForCameraSettle(page);
      expect((await cameraOf(page)).scale, 'the camera reached a scale of 3 or more').toBeGreaterThanOrEqual(3);
      await probe('scale 3+');
    } finally {
      await page.evaluate(() => {
        const hook = (window as { __fabrico?: { pinClock(n: number | null): void } }).__fabrico;
        hook?.pinClock(null);
      });
    }

    await expectRenderLoopAlive(page, 'after the seam pixel probe');
    errs.assertNone('the seam pixel probe leg');
    console.log(captureCostLine());
  });
  test('A HANDLE DRAG THAT DOCKS SIDEWAYS SHIPS A CORNER, AND UNDOING THE DOCK RETURNS THE STRAIGHT END', async ({
    page,
  }) => {
    const errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await resetToDemo(page, DEMO_NODE_COUNT);
    await newBoard(page);
    await resetZoomToActualSize(page);
    await waitForCameraSettle(page);
    expect((await cameraOf(page)).scale, 'the camera is at scale 1').toBe(1);

    // Two plain draws with sub-cell samples: A north to (8,6), then B east from (9,6). Neither
    // press is a doorstep (A's Head faces north, so its doorstep is (8,5)), so nothing docks.
    await page.getByTitle(/^Draw belts/).click();
    for (const [cells, n] of [
      [HANDLE_A_CELLS, 1],
      [HANDLE_B_CELLS, 2],
    ] as const) {
      const start = await screenCellCentre(page, cells[0][0], cells[0][1]);
      const end = await screenCellCentre(page, cells[cells.length - 1][0], cells[cells.length - 1][1]);
      await expectOnCanvas(page, [start, end], `the draw to ${n} belts`);
      await pointerTravel(page, start.x, start.y);
      await page.mouse.down();
      await moveThroughCells(page, cells.slice(1), STEPS_PER_CELL);
      await page.mouse.up();
      await pollScene(page, (s) => s.belts.length, { message: `the draw made ${n} belt(s)` }).toBe(n);
    }
    await page.keyboard.press('Escape');
    const built = await readScene(page);
    const a0 = beltsAt(built, 8, 6);
    const b0 = beltsAt(built, 9, 6);
    expect(a0, 'A covers (8,6)').toHaveLength(1);
    expect(b0, 'B covers (9,6)').toHaveLength(1);
    expect(a0[0].tiles.map((t) => [t.cell_x, t.cell_y]), 'A is exactly its authored run').toEqual(
      HANDLE_A_CELLS.map(([x, y]) => [x, y]),
    );
    expect(b0[0].tiles.map((t) => [t.cell_x, t.cell_y]), 'B is exactly its authored run').toEqual(
      HANDLE_B_CELLS.map(([x, y]) => [x, y]),
    );
    expect([...(a0[0].docks ?? []), ...(b0[0].docks ?? [])], 'A and B start undocked').toHaveLength(0);
    expect(tileKindAt(built, 8, 6), "undocked, A's Head is a north-south straight").toEqual(STRAIGHT_NS);

    // A's Head dock naming B, read by cell (handles can be reminted by a keyframe).
    const headDocksToB = (s: SceneFacts): number => {
      const a = beltsAt(s, 8, 6)[0];
      const b = beltsAt(s, 9, 6)[0];
      if (!a || !b || a.id === b.id) return -1;
      return (a.docks ?? []).filter((d) => d.end === 'Head' && d.node === b.id).length;
    };

    // THE GESTURE: select A on an interior tile, press its Head handle (the end tile centre,
    // `74-belt-run-joins.spec.ts` joinByHandleDrag's rule), drop it on B's Tail with sub-cell
    // samples. A handle drag adds no tile: only a Dock is sent (review CR-01).
    const sel = await screenCellCentre(page, 8, 8);
    await clickAt(page, sel.x, sel.y);
    await expect(page.locator('#fab-belt-config'), 'clicking (8,8) selected belt A').toBeVisible({
      timeout: 15_000,
    });
    await expectRefusalStayedSilent(page, 'a sideways handle-drag dock', async () => {
      const head = await screenCellCentre(page, 8, 6);
      const tail = await screenCellCentre(page, 9, 6);
      await pointerTravel(page, head.x, head.y);
      await page.mouse.down();
      await pointerTravel(page, tail.x, tail.y, STEPS_PER_CELL);
      await page.mouse.up();
      await pollScene(page, headDocksToB, { message: "A's Head dock names B: the sideways handle drag docked" }).toBe(
        1,
      );
    });

    // THE JOIN THE USER SEES: A's last tile turns from its own flow (N) into B's (E); B's
    // first tile continues A's flow east, so it stays straight.
    await pollScene(page, (s) => tileKindAt(s, 8, 6), {
      message: "A's last tile (8,6) ships Corner{from:N, to:E}: the docked end draws as a 90 degree corner",
    }).toEqual(HEAD_CORNER_N_TO_E);
    expect(tileKindAt(await readScene(page), 9, 6), "B's first tile (9,6) stays an east-west straight").toEqual(
      STRAIGHT_EW,
    );

    // ONE CTRL+Z. MEASURED at plan 74.1-09 on the real host: one Ctrl+Z after this gesture
    // undoes the Dock (the last edit), so A's Head dock is gone and both belts remain. Focus
    // is moved off any button first (the LW-02 guard stands canvas keys down while a button
    // holds focus, `74-belt-run-joins.spec.ts`).
    await page.locator('#fab-config-heading').click();
    await page.keyboard.press('Control+z');
    await pollScene(page, headDocksToB, { message: "one Ctrl+Z undid the Dock: A's Head names B no more" }).toBe(0);
    const undone = await readScene(page);
    expect(undone.belts, 'the undo removed no belt: both draws stand').toHaveLength(2);
    expect(
      beltsAt(undone, 8, 6)[0]?.docks ?? [],
      'A carries no dock at all after the undo',
    ).toHaveLength(0);
    expect(tileKindAt(undone, 8, 6), "A's last tile is a north-south straight again").toEqual(STRAIGHT_NS);
    expect(tileKindAt(undone, 9, 6), "B's first tile is still an east-west straight").toEqual(STRAIGHT_EW);

    await expectRenderLoopAlive(page, 'after a sideways handle-drag dock and its undo');
    errs.assertNone('the handle-drag seam leg');
  });
});
