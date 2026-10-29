import { describe, expect, it } from 'vitest';
import { CABLE_LANE_OFFSET, cablePoints, nubEndAt } from './cableGeometry.ts';
import { cableLane } from './cableLane.ts';
import { cellBody, wireRouteTraced, type WireBody, type WireDock } from '../protocol/wireRoute.ts';

// cableEnds.test.ts (plan 75-09, CR-01) - every DRAWN cable end lies on its nub, by sweep.
//
// WHAT THIS CATCHES. 75-REVIEW CR-01: a cable whose end segment runs ALONG its port's
// normal but backwards (the cable leaves its port's cell through the back, or enters it
// from behind) was drawn from the cell centre, inside the machine, 16.5 px short of its
// nub. The clamp declined it on the WR-02 range bound and the nub elbow did not fire (its
// first term needs the segment to run ACROSS the normal). On a touching pair the cable
// then left through the opposite face, where the machine's OTHER port sits, so the picture
// said the cable was plugged into the wrong port.
//
// WHY A SWEEP OVER DRAWN VERTICES AND NOT A FIXTURE. `wires.test.ts` E3/E3c graded
// hand-picked fixtures, and the reversed class was never among them: every fixture's
// awkward end ran across its normal, so the elbow fired and the test passed.
// `crates/fabrico-command/tests/wire_side_aware.rs` sweeps the ROUTER's cells over every
// real-size pair, but never the drawn vertices, so it could not see a render-side end
// either. This file routes every pair through `wireRouteTraced`, draws it through the one
// end geometry (`cablePoints`, in the lane `cableLane` gives the landed cable), and grades
// the first and last DRAWN vertex against the nub.
//
// The grade: each drawn end within `CABLE_LANE_OFFSET` of its nub (the lane may move an
// end across its own segment by exactly that, never along it), and every drawn segment
// axis-aligned (40-UI-SPEC: no diagonal strokes).

const SIDES = [0, 1, 2, 3] as const;
const SIDE_NAME = ['N', 'E', 'S', 'W'];
const EPS = 1e-9;

/**
 * The body of a machine of resolved extent `(w, h)` whose port sits at `cell` on the face
 * `side` names, centred on that face. A mirror of `place_body` in
 * `crates/fabrico-command/tests/common/mod.rs` (test geometry for the physical sweep, the
 * corpus's own placement rule; NOT a copy of anything in the router, which is handed the
 * finished rectangle). `(w - 1) / 2` is Rust integer division on a non-negative value, so
 * `Math.floor` here.
 */
function placeBody(cell: [number, number], side: number, w: number, h: number): WireBody {
  const [x, y] = cell;
  const hw = Math.floor((w - 1) / 2);
  const hh = Math.floor((h - 1) / 2);
  switch (side) {
    case 0: // N: the dock is the top row, the body extends SOUTH
      return { min_x: x - hw, min_y: y, max_x: x - hw + w - 1, max_y: y + h - 1 };
    case 1: // E: the dock is the right column, the body extends WEST
      return { min_x: x - (w - 1), min_y: y - hh, max_x: x, max_y: y - hh + h - 1 };
    case 2: // S: the dock is the bottom row, the body extends NORTH
      return { min_x: x - hw, min_y: y - (h - 1), max_x: x - hw + w - 1, max_y: y };
    default: // W: the dock is the left column, the body extends EAST
      return { min_x: x, min_y: y - hh, max_x: x + w - 1, max_y: y - hh + h - 1 };
  }
}

/** `rects_overlap` in the same Rust module: inclusive bounds. */
function rectsOverlap(a: WireBody, b: WireBody): boolean {
  return a.min_x <= b.max_x && a.max_x >= b.min_x && a.min_y <= b.max_y && a.max_y >= b.min_y;
}

/** One failing pair, in the message's own grammar. */
interface Miss {
  line: string;
  cand: number;
}

const dockName = (d: WireDock): string => `(${d.cell[0]},${d.cell[1]})${SIDE_NAME[d.side]}`;

/**
 * Route `from -> to`, draw it, and grade both drawn ends and every segment. Returns null on
 * a pass, the failure otherwise. A router refusal is a failure: every pair here has two
 * disjoint bodies, so the router owes it a cable.
 */
function checkPair(from: WireDock, to: WireDock): Miss | null {
  const r = wireRouteTraced(from, to);
  if (!r.ok) return { line: `${dockName(from)} -> ${dockName(to)} refused (${r.error})`, cand: -1 };
  const tiles = r.geometry.tiles;
  const fromNub = nubEndAt(from.cell[0], from.cell[1], from.side);
  const toNub = nubEndAt(to.cell[0], to.cell[1], to.side);
  const pts = cablePoints(tiles, cableLane(tiles), { from: fromNub, to: toNub });
  const first = pts[0];
  const last = pts[pts.length - 1];
  const head = `${dockName(from)} -> ${dockName(to)} cand=${r.cand}`;
  if (Math.hypot(first.x - fromNub.x, first.y - fromNub.y) > CABLE_LANE_OFFSET + EPS) {
    return { line: `${head} drawn=(${first.x},${first.y}) nub=(${fromNub.x},${fromNub.y})`, cand: r.cand };
  }
  if (Math.hypot(last.x - toNub.x, last.y - toNub.y) > CABLE_LANE_OFFSET + EPS) {
    return { line: `${head} drawn=(${last.x},${last.y}) nub=(${toNub.x},${toNub.y})`, cand: r.cand };
  }
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    if (a.x !== b.x && a.y !== b.y) {
      return { line: `${head} diagonal segment (${a.x},${a.y}) to (${b.x},${b.y})`, cand: r.cand };
    }
  }
  return null;
}

/** The four unit steps from the source cell to an adjacent target: E, S, W, N. */
const ADJACENT: Array<[number, number]> = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
];

/**
 * The seven shape pairs of the physical sweep, `PHYSICAL_SHAPES` in
 * `crates/fabrico-command/tests/wire_side_aware.rs`, `(source (w, h), target (w, h))`.
 */
const PHYSICAL_SHAPES: Array<[[number, number], [number, number]]> = [
  [
    [1, 1],
    [1, 1],
  ],
  [
    [3, 3],
    [1, 1],
  ],
  [
    [1, 1],
    [3, 3],
  ],
  [
    [3, 3],
    [3, 3],
  ],
  [
    [3, 1],
    [1, 3],
  ],
  [
    [2, 3],
    [3, 3],
  ],
  [
    [1, 3],
    [3, 1],
  ],
];
/** `PHYSICAL_TOTAL` in the same Rust file: the cases left after overlapping bodies drop. */
const PHYSICAL_TOTAL = 23888;

describe('every drawn cable end is on its nub, by sweep (CR-01, plan 75-09)', () => {
  it('every adjacent 1x1 pair, all 16 side pairs in all four directions', () => {
    const misses: Miss[] = [];
    let total = 0;
    for (const [dx, dy] of ADJACENT) {
      for (const fs of SIDES) {
        for (const ts of SIDES) {
          total += 1;
          const from: WireDock = { cell: [0, 0], side: fs, body: cellBody(0, 0) };
          const to: WireDock = { cell: [dx, dy], side: ts, body: cellBody(dx, dy) };
          const m = checkPair(from, to);
          if (m) misses.push(m);
        }
      }
    }
    expect(total, 'the adjacent sweep visits 4 directions x 16 side pairs').toBe(64);
    expect(
      misses.length,
      `adjacent off-nub ${misses.length} of ${total}\n${misses
        .slice(0, 10)
        .map((m) => m.line)
        .join('\n')}`,
    ).toBe(0);
  });

  it("every physical-sweep pair, the Rust sweep's own set", () => {
    const misses: Miss[] = [];
    let total = 0;
    for (const [[fw, fh], [tw, th]] of PHYSICAL_SHAPES) {
      for (const fs of SIDES) {
        for (const ts of SIDES) {
          for (let dy = -7; dy <= 7; dy++) {
            for (let dx = -7; dx <= 7; dx++) {
              const from: WireDock = { cell: [0, 0], side: fs, body: placeBody([0, 0], fs, fw, fh) };
              const to: WireDock = { cell: [dx, dy], side: ts, body: placeBody([dx, dy], ts, tw, th) };
              if (rectsOverlap(from.body, to.body)) continue;
              total += 1;
              const m = checkPair(from, to);
              if (m) misses.push({ line: `(${fw}x${fh})->(${tw}x${th}) ${m.line}`, cand: m.cand });
            }
          }
        }
      }
    }
    // Pinned to the Rust count, so this sweep visits the same set and cannot shrink to
    // nothing and pass.
    expect(total, 'the physical sweep visits the Rust PHYSICAL_TOTAL').toBe(PHYSICAL_TOTAL);
    const byCand = new Map<number, number>();
    for (const m of misses) byCand.set(m.cand, (byCand.get(m.cand) ?? 0) + 1);
    const perCand = [...byCand.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([c, n]) => `cand ${c}: ${n}`)
      .join(', ');
    expect(
      misses.length,
      `physical off-nub ${misses.length} of ${total} (${perCand})\n${misses
        .slice(0, 10)
        .map((m) => m.line)
        .join('\n')}`,
    ).toBe(0);
  });
});
