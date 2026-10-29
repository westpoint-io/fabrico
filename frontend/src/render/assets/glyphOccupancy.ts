// GLYPH SHAPE METRICS (ART-03, plan 58-04): the machinery the shape gate measures
// with, in a module rather than buried in a test body so it is readable, reusable
// and reviewable on its own.
//
// TWO METRIC SOURCES, AND EVERY CONSUMER MUST SAY WHICH IT USED:
//
//   1. THE OCCUPANCY BITMAP - symmetry, mass distribution, heaviness ratios and the
//      normalised Hamming backstop. These are properties of the glyph's COVERAGE,
//      so they are measured off the rasterised ink.
//   2. THE `d` COMMAND LIST - the axis-aligned share of path length. This is a
//      property of the drawing's EDGES rather than of its coverage; a diamond and a
//      square of the same area cover comparable numbers of cells and differ
//      entirely in edge direction, which is exactly the SOURCE / SINK
//      discriminator.
//
// THE BITMAP COMES FROM PIXI'S OWN TESSELLATION, NOT FROM AN OFFLINE RE-PLOT.
// `occupancyOf` calls `measureSvg`, which runs the file through the same
// `SVGParser` + `GraphicsContext` the running app uses, and then fills the
// resulting TRIANGLE LIST. So the gate measures the real parse path - stroke
// widths, joins, caps and the attribute-to-style mapping all included - which is
// the whole point of VEC-04. A `d`-string re-plot would re-implement that mapping
// offline and then agree with itself forever. (`measureSvg` needs a DOM, so every
// spec that calls `occupancyOf` carries `// @vitest-environment jsdom`.)
//
// WHY 64 x 64. One cell is 0.5u on a 1x1 subject, 1u on a 2x2 and 1.5u on a 3x3 -
// at or below the 2u detail stroke on every footprint, so no authored feature is
// thinner than a cell. It is also EVEN, which makes index mirroring exact: for a
// `viewBox` of `0 0 W H`, cell centres sit at `(i + 0.5) * W / 64`, and the mirror
// `x -> W - x` maps that to `((63 - i) + 0.5) * W / 64`. Mirroring is therefore the
// integer map `i -> 63 - i` with no resampling error, and a genuinely symmetric
// glyph scores EXACTLY 1.0 rather than 0.997-ish. That is what lets the
// classification bands be tight.

import { measureSvg } from '../svgAssets.ts';

/** The occupancy grid's side, in cells. See the header for why 64. */
export const OCCUPANCY_SIZE = 64;

/** One authored `<path>`, as the gate needs to see it. */
export interface GlyphPart {
  /** The `data-part` attribute. Every authored path carries one. */
  part: string;
  /** The `d` attribute, verbatim. */
  d: string;
  /**
   * Whether this part is STROKED, read off the authored attributes:
   * `fill="none" stroke="..."` is stroked, a fill part is not. See
   * `shapeDistinctness.test.ts`'s `EDGE_ORIENTATION` for why the distinction is
   * load-bearing rather than cosmetic.
   */
  stroked: boolean;
}

/** A glyph's ink as a normalised boolean grid over its own `viewBox`. */
export interface Occupancy {
  /** `size * size` bytes, 1 where the cell centre is inside the ink. */
  grid: Uint8Array;
  /** The grid's side, in cells. */
  size: number;
  /** The number of set cells. Carried so callers never re-count. */
  ink: number;
}

/* ------------------------------------------------------------------ *
 * The authored file
 * ------------------------------------------------------------------ */

/**
 * The author box, read off the file's own `viewBox`.
 *
 * DERIVED FROM THE ARTIFACT, never a hand table - the same rule
 * `svgAssets.ts:getAssetBox` states. This function exists separately because
 * `getAssetBox` is keyed by `AssetName` and the shape gate must also measure the
 * `__fixtures__` file, which is deliberately not a registered asset.
 *
 * Throws rather than defaulting: a default box would rasterise a wrongly-authored
 * file onto a plausible grid and report a clean measurement of the wrong thing.
 */
export function parseViewBox(svgText: string): { w: number; h: number } {
  // ANCHORED AT THE ROOT TAG, exactly as `parseParts` below already does (WR-02).
  // This used to scan the WHOLE text, header docblock included, and `router.svg`'s
  // header discusses the transposed `0 0 96 64` box explicitly in order to say it is
  // ILLEGAL - so the first `viewBox="..."` in that file is a counter-example being
  // quoted, not the box being drawn. The irony this module was living with: the lint
  // gate for this exact defect (`shippedAssets.test.ts` `checkSubjectViewBox`) strips
  // comments FIRST and has a dedicated case named "reads the DRAWN viewBox, not one
  // quoted in a header comment", so the gate was comment-safe while the shipping code
  // was not - and this function sat two above a `parseParts` that already sliced.
  const body = svgText.slice(svgText.indexOf('<svg'));
  const m = /viewBox="0 0 (\d+) (\d+)"/.exec(body);
  if (m === null) {
    throw new Error('glyphOccupancy: no parseable viewBox="0 0 W H" - cannot normalise the grid');
  }
  return { w: Number(m[1]), h: Number(m[2]) };
}

/**
 * Every authored `<path>` in the file, in document order.
 *
 * THE HEADER COMMENT IS STRIPPED FIRST. Every shipped asset opens with a long
 * provenance docblock that NAMES other parts and quotes other `d` strings; a
 * scanner that read the whole text would find paths that are not drawn. The same
 * "strip the header before scanning markup" rule `shippedAssets.test.ts` (plan
 * 58-02) established.
 *
 * Throws on a path with no `data-part` or no `d`: both are authored on every path
 * in this repo, and a silently-skipped part is a silently-shrunk measurement.
 */
export function parseParts(svgText: string): GlyphPart[] {
  const body = svgText.slice(svgText.indexOf('<svg'));
  const out: GlyphPart[] = [];
  for (const tag of body.match(/<path\b[^>]*\/>/g) ?? []) {
    const part = /data-part="([^"]*)"/.exec(tag)?.[1];
    const d = /\bd="([^"]*)"/.exec(tag)?.[1];
    if (part === undefined || d === undefined) {
      throw new Error(`glyphOccupancy: a <path> is missing data-part or d: ${tag}`);
    }
    const stroke = /\bstroke="([^"]*)"/.exec(tag)?.[1];
    out.push({ part, d, stroked: stroke !== undefined && stroke !== 'none' });
  }
  if (out.length === 0) throw new Error('glyphOccupancy: the file declares no <path> at all');
  return out;
}

/* ------------------------------------------------------------------ *
 * The occupancy bitmap
 * ------------------------------------------------------------------ */

/**
 * Is `(px, py)` inside the triangle `(ax, ay) (bx, by) (cx, cy)`?
 *
 * Half-plane sign test, INCLUSIVE of the edges and orientation-agnostic (Pixi's
 * tessellator emits both windings). Degenerate triangles - zero area, which the
 * tessellator does produce at joins - contain nothing and are skipped by the
 * caller rather than dividing by zero here.
 */
function inTriangle(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number,
  cx: number, cy: number,
): boolean {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

/**
 * Rasterise one authored SVG's ink into a normalised `size x size` grid over its
 * own `viewBox`.
 *
 * The geometry is Pixi's own tessellation (see the module header). Pixi's
 * `SVGParser` ignores `viewBox` and passes coordinates through as user units, so
 * the normalisation happens HERE, against the box parsed off the same text - which
 * is what makes a 1x1 and a 3x3 subject directly comparable.
 *
 * REFUSES A ZERO-INK RESULT. A glyph that rasterises to nothing is perfectly
 * symmetric on both axes, has 100% of its (zero) mass wherever you ask, and is at
 * distance 0 from every other empty glyph - it would produce the cleanest green in
 * the suite while covering nothing. Same vacuous-pass refusal as
 * `svgAssets.ts:assertVertexBudget`.
 */
export function occupancyOf(svgText: string, size: number = OCCUPANCY_SIZE): Occupancy {
  const { w, h } = parseViewBox(svgText);
  const { vertices, indices } = measureSvg(svgText);
  const grid = new Uint8Array(size * size);
  const sx = w / size;
  const sy = h / size;

  for (let t = 0; t + 2 < indices.length; t += 3) {
    const i0 = indices[t]! * 2;
    const i1 = indices[t + 1]! * 2;
    const i2 = indices[t + 2]! * 2;
    const ax = vertices[i0]!, ay = vertices[i0 + 1]!;
    const bx = vertices[i1]!, by = vertices[i1 + 1]!;
    const cx = vertices[i2]!, cy = vertices[i2 + 1]!;
    // Zero-area triangles contain no cell centre; skip before touching the grid.
    if ((bx - ax) * (cy - ay) - (cx - ax) * (by - ay) === 0) continue;
    // Only sweep the triangle's own cell range - the whole-grid sweep is 4096
    // point-in-triangle tests per triangle and this is a few dozen.
    const jLo = Math.max(0, Math.floor(Math.min(ay, by, cy) / sy - 0.5));
    const jHi = Math.min(size - 1, Math.ceil(Math.max(ay, by, cy) / sy));
    const iLo = Math.max(0, Math.floor(Math.min(ax, bx, cx) / sx - 0.5));
    const iHi = Math.min(size - 1, Math.ceil(Math.max(ax, bx, cx) / sx));
    for (let j = jLo; j <= jHi; j++) {
      const py = (j + 0.5) * sy;
      for (let i = iLo; i <= iHi; i++) {
        const k = j * size + i;
        if (grid[k] === 1) continue;
        if (inTriangle((i + 0.5) * sx, py, ax, ay, bx, by, cx, cy)) grid[k] = 1;
      }
    }
  }

  let ink = 0;
  for (let k = 0; k < grid.length; k++) ink += grid[k]!;
  if (ink === 0) {
    throw new Error(
      'glyphOccupancy: the glyph rasterised to ZERO ink cells. An empty glyph is ' +
        'perfectly symmetric, perfectly peripheral and distance 0 from every other ' +
        'empty glyph - it would pass every assertion in the shape gate by drawing nothing.',
    );
  }
  return { grid, size, ink };
}

/* ------------------------------------------------------------------ *
 * Symmetry
 * ------------------------------------------------------------------ */

/** Jaccard overlap between a grid and an index-mapped copy of itself. */
function selfOverlap(o: Occupancy, mapIndex: (i: number, j: number) => number): number {
  let both = 0;
  let either = 0;
  for (let j = 0; j < o.size; j++) {
    for (let i = 0; i < o.size; i++) {
      const a = o.grid[j * o.size + i]!;
      const b = o.grid[mapIndex(i, j)]!;
      if (a === 1 && b === 1) both++;
      if (a === 1 || b === 1) either++;
    }
  }
  return either === 0 ? 0 : both / either;
}

/**
 * A glyph's mirror symmetry on both axes, as Jaccard overlap with its own mirror.
 *
 * `symV` is the LEFT-RIGHT mirror (about the vertical axis) and `symH` the
 * TOP-BOTTOM mirror, matching `58-UI-SPEC.md:200`'s column headings exactly - the
 * two are trivially transposable and the UI-SPEC's naming is the one the whole
 * phase argues in.
 *
 * MIRRORED ABOUT THE `viewBox` CENTRE, NOT THE INK'S OWN BOUNDING BOX. The board
 * centres every glyph in its machine's effective box, so the reading a user gets
 * is symmetry about that box: `ENDPOINT`'s socket is a shape symmetric about its
 * own centre and DELIBERATELY off-centre in its box (it opens east, the D-01
 * request-in asymmetry), and a bbox-relative measure would score it symmetric and
 * lose the very property the 1x1 group leans on.
 */
export function symmetry(o: Occupancy): { symV: number; symH: number } {
  const n = o.size;
  return {
    symV: selfOverlap(o, (i, j) => j * n + (n - 1 - i)),
    symH: selfOverlap(o, (i, j) => (n - 1 - j) * n + i),
  };
}

/**
 * A symmetry score's CLASS.
 *
 * The middle band is an explicit outcome, not a silent pass: art that is neither
 * symmetric nor deliberately not symmetric is art nobody decided about, and the
 * gate's job is to say so. Bands transcribed from `58-UI-SPEC.md:556`.
 */
export function classifySymmetry(score: number): 'SYMMETRIC' | 'ASYMMETRIC' | 'UNCLASSIFIED' {
  if (score >= 0.9) return 'SYMMETRIC';
  if (score <= 0.6) return 'ASYMMETRIC';
  return 'UNCLASSIFIED';
}

/* ------------------------------------------------------------------ *
 * Mass distribution
 * ------------------------------------------------------------------ */

/** The ink's bounding box in grid indices, inclusive. */
function inkBounds(o: Occupancy): { i0: number; i1: number; j0: number; j1: number } {
  let i0 = o.size, i1 = -1, j0 = o.size, j1 = -1;
  for (let j = 0; j < o.size; j++) {
    for (let i = 0; i < o.size; i++) {
      if (o.grid[j * o.size + i] !== 1) continue;
      if (i < i0) i0 = i;
      if (i > i1) i1 = i;
      if (j < j0) j0 = j;
      if (j > j1) j1 = j;
    }
  }
  return { i0, i1, j0, j1 };
}

/**
 * The share of glyph ink OUTSIDE the central 50% box of the glyph's own bounding
 * box - "mass at the four corners" as a number (`58-UI-SPEC.md:559`).
 *
 * THE CENTRAL BOX IS HALF THE BBOX ON EACH AXIS, i.e. a QUARTER OF ITS AREA,
 * centred. Stated because "the central 50% box" is ambiguous between the two and
 * the choice moves every figure: half-linear is the reading that makes a
 * four-corner glyph score high and a centre-converging one score low, which is
 * the discrimination the metric exists for.
 *
 * BOUNDED BY THE INK, NOT BY THE `viewBox`. A glyph that simply sat small in a
 * large box would otherwise score 1.0 by being nowhere near the centre of a box it
 * never fills.
 */
export function peripheralMassShare(o: Occupancy): number {
  const { i0, i1, j0, j1 } = inkBounds(o);
  const wLo = i0 + (i1 - i0 + 1) * 0.25;
  const wHi = i0 + (i1 - i0 + 1) * 0.75;
  const hLo = j0 + (j1 - j0 + 1) * 0.25;
  const hHi = j0 + (j1 - j0 + 1) * 0.75;
  let outside = 0;
  for (let j = 0; j < o.size; j++) {
    for (let i = 0; i < o.size; i++) {
      if (o.grid[j * o.size + i] !== 1) continue;
      const x = i + 0.5;
      const y = j + 0.5;
      if (x < wLo || x > wHi || y < hLo || y > hHi) outside++;
    }
  }
  return outside / o.ink;
}

/**
 * How deeply the ink REACHES INTO the four corner boxes of its own bounding box,
 * as the worst of the four - `0` for a corner the ink never enters, `1` for a
 * corner the ink spans on both axes.
 *
 * WHY THIS EXISTS ALONGSIDE {@link peripheralMassShare}, WHICH IS THE UI-SPEC'S
 * NAMED METRIC. `58-UI-SPEC.md:559` pairs the peripheral-mass floor with the
 * failure case "a balancer redrawn without its corner returns". MEASURED, IT DOES
 * NOT CATCH THAT: strip BALANCER's four 6u returns and the peripheral share moves
 * 0.881 -> 0.851, nowhere near the 0.70 floor, because the rails were already at
 * the top and bottom EDGES and "peripheral" was never the same claim as "at the
 * four CORNERS". Corner-box ink SHARE is barely better (0.441 -> 0.383): the
 * returns are only ~22% of the glyph's ink, so no global mass statistic separates
 * them. A gate whose stated failure case does not fire is the decorative-gate
 * failure this milestone keeps finding, so the missing coverage is added rather
 * than the claim being quietly dropped.
 *
 * REACH, NOT MASS, IS THE PROPERTY THAT ACTUALLY DIFFERS. A corner return turns
 * the rail end into a BRACKET that occupies the corner box on BOTH axes; without
 * it the corner box is merely grazed by a 2u horizontal bar. Counting distinct
 * occupied ROWS and COLUMNS separates those two by a factor of three where
 * counting area separates them by a seventh:
 *
 *   real BALANCER                 1.000
 *   returns shortened 6u -> 4u    0.714   (still a bracket - passes)
 *   returns REMOVED               0.286   (caught)
 *   the collapsed fixture         0.000
 *
 * The corner box is a quarter of the bbox on each axis (a sixteenth of its area),
 * anchored at the bbox's four actual corners. The score is the MINIMUM over the
 * four, so one dropped return fails the subject - "mass at the FOUR corners"
 * (design decision, 2026-08-01) is a claim about all four of them.
 */
export function cornerReach(o: Occupancy): number {
  const { i0, i1, j0, j1 } = inkBounds(o);
  const cw = Math.max(1, Math.round((i1 - i0 + 1) * 0.25));
  const ch = Math.max(1, Math.round((j1 - j0 + 1) * 0.25));
  const corners: [number, number][] = [
    [i0, j0],
    [i1 - cw + 1, j0],
    [i0, j1 - ch + 1],
    [i1 - cw + 1, j1 - ch + 1],
  ];
  let worst = 1;
  for (const [ci, cj] of corners) {
    const rows = new Set<number>();
    const cols = new Set<number>();
    for (let j = cj; j < cj + ch; j++) {
      for (let i = ci; i < ci + cw; i++) {
        if (o.grid[j * o.size + i] === 1) {
          rows.add(j);
          cols.add(i);
        }
      }
    }
    const v = Math.min(rows.size / ch, cols.size / cw);
    if (v < worst) worst = v;
  }
  return worst;
}

/**
 * A heaviness ratio over the glyph's own bounding box.
 *
 * - `'top-third'`  - top-third ink over bottom-third ink (`58-UI-SPEC.md:560`,
 *   MERGE's funnel). Thirds, not halves, because the middle of a funnel is where
 *   the walls converge and counting it on either side would blunt the ratio.
 * - `'east-half'`  - east-half over west-half (`:561`, TEE's single west stem).
 *   Halves, because a fork has no neutral middle band to exclude.
 *
 * An empty denominator returns `Infinity` rather than throwing: "all of the ink is
 * on one side" is a real and passing measurement for these two floors, and it
 * prints legibly in a report.
 */
export function bandRatio(o: Occupancy, axis: 'top-third' | 'east-half'): number {
  const { i0, i1, j0, j1 } = inkBounds(o);
  let near = 0;
  let far = 0;
  for (let j = 0; j < o.size; j++) {
    for (let i = 0; i < o.size; i++) {
      if (o.grid[j * o.size + i] !== 1) continue;
      if (axis === 'top-third') {
        const t = (j + 0.5 - j0) / (j1 - j0 + 1);
        if (t < 1 / 3) near++;
        else if (t >= 2 / 3) far++;
      } else {
        const t = (i + 0.5 - i0) / (i1 - i0 + 1);
        if (t >= 0.5) near++;
        else far++;
      }
    }
  }
  return far === 0 ? Number.POSITIVE_INFINITY : near / far;
}

/* ------------------------------------------------------------------ *
 * The occupancy backstop
 * ------------------------------------------------------------------ */

/**
 * Normalised Hamming distance between two occupancy bitmaps:
 *
 *     |A xor B| / |A or B|          ( = 1 - Jaccard )
 *
 * THE DENOMINATOR IS THE UNION OF THE TWO INK SETS, and `58-UI-SPEC.md:563` never
 * said which one it meant. Over the 4096-cell BITMAP instead, a 1x1 subject's ~330
 * ink cells cap every possible distance near 0.16 and every binding pair fails,
 * including pairs the named metrics separate cleanly. The union is the only
 * denominator under which the number means "how much of the drawn ink disagrees":
 * 0 for identical ink, 1 for disjoint ink.
 *
 * Two empty grids return 0 (identical), which is consistent with the definition -
 * `occupancyOf` refuses to produce an empty grid in the first place.
 */
export function hammingDistance(a: Occupancy, b: Occupancy): number {
  if (a.size !== b.size) {
    throw new Error(`glyphOccupancy: cannot compare a ${a.size}x${a.size} grid with a ${b.size}x${b.size} one`);
  }
  let diff = 0;
  let union = 0;
  for (let k = 0; k < a.grid.length; k++) {
    const x = a.grid[k]!;
    const y = b.grid[k]!;
    if (x !== y) diff++;
    if (x === 1 || y === 1) union++;
  }
  return union === 0 ? 0 : diff / union;
}

/* ------------------------------------------------------------------ *
 * Edge orientation - from the `d` command list, not the bitmap
 * ------------------------------------------------------------------ */

/**
 * The share of STROKED path length that runs on an axis.
 *
 * MEASURED FROM THE `d` COMMAND LIST, deliberately, because edge direction is a
 * property of the drawing's edges and not of its coverage - see the module header.
 *
 * FILL PARTS ARE EXCLUDED FROM BOTH NUMERATOR AND DENOMINATOR, and the excluded
 * parts come back by `data-part` name so a failure REPORTS the exclusion rather
 * than hiding it in this source. A fill contributes coverage; its outline is an
 * interior boundary rather than the silhouette a reader traces. The full
 * derivation, with the measured figures that forced it, is on `EDGE_ORIENTATION`
 * in `shapeDistinctness.test.ts`.
 *
 * ONLY `M H V L Z` ARE ACCEPTED, and anything else THROWS. Lock axis 5 authorises
 * zero curve commands and `scripts/lint-svg.ts` enforces it at fail severity as of
 * plan 58-02, so an arc reaching this function means a gate upstream stopped
 * working - a silent skip here would then quietly shrink the denominator. Relative
 * commands throw for the same reason: no authored file uses one, and guessing
 * would be worse than stopping.
 */
export function axisAlignedShare(parts: GlyphPart[]): {
  share: number;
  strokedLength: number;
  excluded: string[];
} {
  let axis = 0;
  let total = 0;
  const excluded: string[] = [];

  for (const p of parts) {
    if (!p.stroked) {
      excluded.push(p.part);
      continue;
    }
    const tokens = p.d.trim().split(/[\s,]+/);
    let cx = 0, cy = 0, sx = 0, sy = 0;
    let k = 0;
    while (k < tokens.length) {
      const cmd = tokens[k++]!;
      let nx = cx;
      let ny = cy;
      switch (cmd) {
        case 'M':
          cx = Number(tokens[k++]);
          cy = Number(tokens[k++]);
          sx = cx;
          sy = cy;
          continue;
        case 'H':
          nx = Number(tokens[k++]);
          break;
        case 'V':
          ny = Number(tokens[k++]);
          break;
        case 'L':
          nx = Number(tokens[k++]);
          ny = Number(tokens[k++]);
          break;
        case 'Z':
          nx = sx;
          ny = sy;
          break;
        default:
          throw new Error(
            `glyphOccupancy: unsupported path command '${cmd}' in part '${p.part}'. Only ` +
              'absolute M H V L Z are authored (lock axis 5, enforced by lint-svg.ts `curve` ' +
              'at fail severity). A command reaching here means an upstream gate stopped firing.',
          );
      }
      const dx = nx - cx;
      const dy = ny - cy;
      const len = Math.hypot(dx, dy);
      total += len;
      if (dx === 0 || dy === 0) axis += len;
      cx = nx;
      cy = ny;
    }
  }

  return { share: total === 0 ? 0 : axis / total, strokedLength: total, excluded };
}
