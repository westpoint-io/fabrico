// seamInk.ts - reads the belt ink drawn inside one tile, box by box, off a screenshot clip. Moved out of
// `74.1-seam-corner.live.spec.ts` (phase 106, plan 106-08) so lesson 2's walk can grade the corner it
// draws at the seam with the same reader; the 74.1 spec imports it from here.
//
// The 74.1 boxes are drawn for a Corner fed from the west and leaving north, Corner{E,N}. Lesson 2's seam
// is fed from the west and leaves south, Corner{E,S}, so its boxes are the 74.1 boxes mirrored top to
// bottom (y becomes CELL - y), with floors measured on lesson 2's own joined board.

import { expect, type Page } from '@playwright/test';
// The PNG decoder @playwright/test already bundles (pngjs), the idiom
// `06-fault-red-probe.spec.ts` uses: no new dependency is added to read the canvas.
// eslint-disable-next-line @typescript-eslint/no-var-requires
import { PNG } from 'playwright-core/lib/utilsBundle';
import { cameraOf, captureClip, screenPoint } from './oracle';
import { CELL, rampOracles, colorToRgb } from '../../shared/geometry';
// Phase 91 (D-10, CHROME-10): the empty board's words, imported so the hint's boxes are found by
// the words the app renders (a retyped body stopped matching and its box silently dropped out).
import { EMPTY_FLOOR_BODY, EMPTY_FLOOR_HEADING } from '../../src/chrome/configCopy';

/** A world-px box inside a tile, relative to the tile's top-left corner: [x0, x1) x [y0, y1). */
export type Box = readonly [number, number, number, number];

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
export const SIG_BOXES: readonly Box[] = [
  [18, 30, 24, 30],
  [24, 30, 18, 30],
];
export const SIG_NAMES = ['S', 'E'] as const;
/**
 * THE FLOORS, measured at this tree on the live suite's Desktop Chrome (three runs, every
 * count identical), and set as 74.1-04 set its ring floor: half the smaller measured inked
 * count of the reference straight. Measured S/E: 5/11 at scale 1, 57/117 at scale 3.32; so
 * 2 at scale 1 and 28 at 3 or more. The seam and the reference corner measured 0/0 at both
 * scales, so the corner ceiling is 0.
 */
export const SIG_FLOOR_AT_1 = 2;
export const SIG_FLOOR_AT_3_PLUS = 28;
export const SIG_CORNER_CEILING = 0;

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
export const ARC_BOX: Box = [14, 24, 14, 24];
/**
 * THE ARC FLOORS, measured on the REFERENCE CORNER (12,6) on the real renderer, three runs
 * at plan 74.1-21 on the live suite's Desktop Chrome, every reading identical: 10 at scale
 * 1, 103 at scale 3.32. Set as the straight floors above were: half the smallest reading.
 */
export const ARC_INK_FLOOR_AT_1 = 5;
export const ARC_INK_FLOOR_AT_3_PLUS = 51;
/**
 * THE DIRECTION HALF, added because the rail box alone was WATCHED to pass a reversed
 * corner (plan 74.1-21, mutation 3: tile 0 drawn as Corner{S,W}, ARC seam 10 / 103, leg
 * green). Corner{S,W} rounds the SAME north-west vertex, and a corner's two rails are
 * symmetric under reversing the flow, so no rail box can tell the two apart. The TREAD can:
 * `cornerCommands` lays its dashes by arc length from the ENTRY edge, so the pattern of a
 * reversed corner is the mirror image along the arc.
 *
 * THE PHASE IS FIXED, which is what makes a tread box sound here. The render clock is
 * pinned at 0, so a tile's march bucket is a function of its tail offset alone
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
export const ARC_EXIT_TREAD_BOX: Box = [13, 19, 0.5, 4];
/**
 * Measured on the reference corner exactly as the arc floors were: 4 at scale 1, 58 at
 * scale 3.32, every one of three runs identical; half the smallest reading.
 */
export const ARC_EXIT_TREAD_FLOOR_AT_1 = 2;
export const ARC_EXIT_TREAD_FLOOR_AT_3_PLUS = 29;

/** A pixel is belt ink when some channel is more than this many levels from the ground. */
export const INK_TOLERANCE = 24;

/** Mirror a box top to bottom inside its tile: y becomes CELL - y. */
function mirrorTopToBottom([x0, x1, y0, y1]: Box): Box {
  return [x0, x1, CELL - y1, CELL - y0];
}

/** One box of a seam read: its name, where it is in the tile, and what its ink stands for. */
export interface SeamBox {
  name: string;
  box: Box;
  /** What the box is for, in the failure message. */
  reads: string;
}

/**
 * THE SEAM BOXES FOR A CORNER FED FROM THE WEST AND LEAVING SOUTH, Corner{from: E, to: S}, the turn
 * lesson 2 asks for at its ring cell (phase 106, plan 106-08). Each is a 74.1 box mirrored top to
 * bottom, so every clearance argued above holds with north and south swapped:
 *
 *   - N and E: where a north-south straight's east rail runs (x 26), by the NORTH edge and by the EAST
 *     edge north of centre. A Corner{E,S} rounds the SOUTH-west vertex and puts none of its ink there.
 *     These are the ceilings: the stored Straight drawn at the seam, the T, inks both.
 *   - ARC: the corner's outer rail arc, its middle third, about the south-west vertex.
 *   - EXIT: the tread run that ends on the SOUTH edge midpoint, ink only for a corner turning the
 *     right way at the pinned phase (the seam is its belt's tile 0, offset 0, as in 74.1).
 *   - W: belt ink by the WEST edge, north of the junction collar: the corner's outer rail meets the
 *     west edge at y 6 to 7. Its nearest point to the collar's centre (0,16) is (2,7), 9.2 world px
 *     away, past the collar's 8; it stays 2 px off the north and west edges, where the grid lines are.
 *     A straight inks it too (its west rail at x 6), so it says the seam is drawn, not which way.
 */
export const SEAM_BOXES_E_TO_S = {
  N: { name: 'N', box: mirrorTopToBottom(SIG_BOXES[0]), reads: 'rail ink where a straight runs, by the north edge' },
  E: { name: 'E', box: mirrorTopToBottom(SIG_BOXES[1]), reads: 'rail ink where a straight runs, by the east edge' },
  ARC: { name: 'ARC', box: mirrorTopToBottom(ARC_BOX), reads: "the corner's outer rail arc" },
  EXIT: { name: 'EXIT', box: mirrorTopToBottom(ARC_EXIT_TREAD_BOX), reads: 'the tread run ending on the south edge' },
  W: { name: 'W', box: [2, 8, 2, 7] as Box, reads: 'rail ink by the west edge' },
} as const satisfies Record<string, SeamBox>;

/** Assert every screen point is on the CANVAS, so no chrome panel eats the press. */
export async function expectOnCanvas(page: Page, pts: { x: number; y: number }[], context: string): Promise<void> {
  const tags = await page.evaluate(
    (ps) => ps.map((p) => document.elementFromPoint(p.x, p.y)?.tagName ?? null),
    pts,
  );
  expect(tags, `${context}: every point is on the canvas, not under chrome`).toEqual(pts.map(() => 'CANVAS'));
}

/** The empty-floor hint's two text blocks, which are drawn over the canvas without pointer events. */
export async function hintRects(page: Page): Promise<{ x: number; y: number; width: number; height: number }[]> {
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
export async function tileInk(
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
 * `groundTile` is a cell the caller knows is empty floor.
 */
export async function groundColour(page: Page, groundTile: readonly [number, number]): Promise<{ r: number; g: number; b: number }> {
  const cam = await cameraOf(page);
  const tl = await screenPoint(page, { x: groundTile[0] * CELL + 8, y: groundTile[1] * CELL + 8 });
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

/**
 * THE FLOORS AND CEILINGS FOR LESSON 2'S SEAM, Corner{E,S} at zoom 1 with the render clock pinned at 0 and
 * the item layer hidden. Measured on lesson 2's own joined board on the real host at plan 106-08 (Desktop
 * Chrome, three captures of the ring cell (6,2) and of the carry-on's straight (6,3), every reading
 * identical): seam N/E 0/0, ARC 10, EXIT 4, W 3; the straight N/E 6/12. Each floor is half the smaller
 * reading, the 74.1 rule, rounded down. ARC and EXIT read what 74.1 measured on its reference Corner{E,N}
 * (10 and 4), which is what the mirror predicts.
 */
export const SEAM_E_TO_S_AT_1 = {
  /** At most this much ink in N and E on the seam: a drawn corner puts none there. */
  cornerCeiling: 0,
  /** At least this much ink in ARC, EXIT and W on the seam. */
  arcFloor: 5,
  exitFloor: 2,
  westFloor: 1,
  /** At least this much ink in N and E on the carry-on's own straight next to the seam: the probe can see a straight. */
  straightNFloor: 3,
  straightEFloor: 6,
} as const;
