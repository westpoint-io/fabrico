// cableTrace.ts - the PURE grader of the DRAWN cables against the model's ROUTED CELLS (the 77-01
// refuter round, phase 77 D-04). Plain data in, plain data out. It imports NOTHING, so it carries
// no product source and no Playwright, and `src/gates/cableTrace.test.ts` grades every rule here on
// the polylines a live run of the composed walk logged.
//
// WHY IT EXISTS. The composed walk read the drawn cables two ways before this: leg 1 counted them
// (`TWO CABLES DRAWN`, exactly two strokes) and leg 5 compared them with what leg 1 drew. Neither
// compares a drawn line with the cells the model routed. A wire layer that strokes every cable
// three cells below its route passes both, because the count is still two and leg 5 compares a
// wrong drawing with the same wrong drawing (refuter 1: `+96` on every stroked y, leg 1 green
// with the drawn y at 370 instead of 274). This grader says WHERE each cable was drawn.
//
// WHAT "DRAWN ON ITS CELLS" MEANS. The wire layer strokes the routed cells' centres, displaced
// into the cable's lane (`CABLE_LANE_OFFSET`, 2 world px) and clamped at both ends onto the two
// port nubs, which sit half a world pixel past the end cell's outer edge (`cableGeometry.ts`
// `cablePoints`). So a drawn polyline FOLLOWS a routed cell list when:
//   1. every point along it (sampled every world pixel) lies inside the union of those cells,
//      each widened by `slack` on every side, and
//   2. every one of those cells, widened by the same `slack`, holds at least one sampled point.
// The default slack is a quarter cell (8 world px): the lane and the nub overhang fit inside it
// with room, and a cable drawn a whole cell (32 px) or more off its route leaves the union.
// Rule 2 refuses a cable cut short, rule 1 a cable drawn somewhere else.
//
// THE PAIRING. Each model cable must be followed by a DIFFERENT drawn polyline, and every drawn
// polyline must follow some model cable: a perfect matching, found by a small backtracking search
// (a board here holds a handful of cables). The grade reports the cables no drawn line follows
// and the drawn lines that follow no cable, by count, so an assertion can name both.

/** A point in world px. */
export interface WorldPoint {
  x: number;
  y: number;
}

/** One model cable: a name the grade reports it by, and its routed cells in order. */
export interface ModelCable {
  key: string;
  cells: readonly (readonly [number, number])[];
}

/** What `gradeDrawnCables` returns. A correct drawing reads `unmatchedModel: []` and
 *  `strayDrawn: 0`, with `drawn` equal to `model`. */
export interface CableTraceGrade {
  /** How many polylines the wire layer drew. */
  drawn: number;
  /** How many cables the model holds. */
  model: number;
  /** The model cables no drawn polyline follows, by key, sorted. */
  unmatchedModel: string[];
  /** How many drawn polylines follow no model cable. */
  strayDrawn: number;
}

/** Every point along a polyline, its vertices included, at most one world pixel apart. */
export function samplePolyline(pts: readonly WorldPoint[]): WorldPoint[] {
  const out: WorldPoint[] = [];
  if (pts.length === 0) return out;
  out.push({ x: pts[0].x, y: pts[0].y });
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y)));
    for (let k = 1; k <= steps; k++) {
      const t = k / steps;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  return out;
}

/** True when `p` lies in cell `c` widened by `slack` on every side. */
function inWidenedCell(p: WorldPoint, c: readonly [number, number], cell: number, slack: number): boolean {
  return (
    p.x >= c[0] * cell - slack &&
    p.x <= (c[0] + 1) * cell + slack &&
    p.y >= c[1] * cell - slack &&
    p.y <= (c[1] + 1) * cell + slack
  );
}

/**
 * Whether a drawn polyline follows a routed cell list (the two rules in the header). A polyline
 * of fewer than two points, or an empty cell list, follows nothing.
 */
export function followsCells(
  pts: readonly WorldPoint[],
  cells: readonly (readonly [number, number])[],
  cell: number,
  slack = cell / 4,
): boolean {
  if (pts.length < 2 || cells.length === 0) return false;
  const samples = samplePolyline(pts);
  for (const p of samples) {
    if (!cells.some((c) => inWidenedCell(p, c, cell, slack))) return false;
  }
  for (const c of cells) {
    if (!samples.some((p) => inWidenedCell(p, c, cell, slack))) return false;
  }
  return true;
}

/**
 * Grade the drawn polylines against the model's cables: the largest pairing in which every pair
 * is a drawn line following its cable's cells, each line and each cable used once.
 */
export function gradeDrawnCables(
  drawn: readonly (readonly WorldPoint[])[],
  model: readonly ModelCable[],
  cell: number,
  slack = cell / 4,
): CableTraceGrade {
  const follows = model.map((m) => drawn.map((pl) => followsCells(pl, m.cells, cell, slack)));
  // Maximum bipartite matching by augmenting paths (Kuhn): small, exact, order-independent.
  const ownerOfDrawn: number[] = drawn.map(() => -1);
  const tryCable = (mi: number, seen: boolean[]): boolean => {
    for (let di = 0; di < drawn.length; di++) {
      if (!follows[mi][di] || seen[di]) continue;
      seen[di] = true;
      if (ownerOfDrawn[di] === -1 || tryCable(ownerOfDrawn[di], seen)) {
        ownerOfDrawn[di] = mi;
        return true;
      }
    }
    return false;
  };
  for (let mi = 0; mi < model.length; mi++) tryCable(mi, drawn.map(() => false));
  // A later augmenting path can move an earlier cable to another line but never unmatch it, so
  // the matched cables are read back off the final owners.
  const owned = new Set(ownerOfDrawn.filter((o) => o !== -1));
  return {
    drawn: drawn.length,
    model: model.length,
    unmatchedModel: model
      .filter((_, mi) => !owned.has(mi))
      .map((m) => m.key)
      .sort((a, b) => a.localeCompare(b)),
    strayDrawn: ownerOfDrawn.filter((o) => o === -1).length,
  };
}
