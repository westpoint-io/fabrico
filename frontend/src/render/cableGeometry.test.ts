import { describe, expect, it } from 'vitest';
import { CABLE_LANE_OFFSET, NO_NUB, cablePoints, nubEndAt } from './cableGeometry.ts';
import { cableLane } from './cableLane.ts';
import { wireRouteTraced } from '../protocol/wireRoute.ts';

// cableGeometry.test.ts (plan 75-05, D-08, 75-UI-SPEC 2.1, 2.2 and 3.2) - the ONE end
// geometry the landed cable and the drag preview both draw through, pinned BY NUMBER.
//
// Every expected vertex below is a literal worked by hand from `nubAnchor`'s formula
// (CELL 32, INSET 2, NUB_PUSH 2.5: a nub sits on its cell's edge midpoint, pulled in by
// INSET and pushed out by NUB_PUSH along the outward normal, so 0.5 px past the edge).
// `nubEndAt` builds the INPUTS; no expected value calls it, so a change to the nub math
// cannot carry its own expectation along with it.
//
// Lane 0 is handed to the builder unless the case is about the lane: the lane
// displacement is pinned separately (`cableLane.test.ts`, `overlay.test.ts`), so no pin
// here depends on a lane sign.

/** Cells from `[x, y]` pairs. */
const cells = (...xs: Array<[number, number]>) => xs.map(([cell_x, cell_y]) => ({ cell_x, cell_y }));

const N = 0;
const E = 1;
const W = 3;

/** Every segment runs on one axis. */
function expectAxisAligned(pts: Array<{ x: number; y: number }>, label: string): void {
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    expect(a.x === b.x || a.y === b.y, `${label}: segment ${i - 1} (${a.x},${a.y}) to (${b.x},${b.y})`).toBe(true);
  }
}

describe('cableGeometry: the one end geometry for the cable and the drag preview', () => {
  it('the E nub pin: 96.5 against 80', () => {
    // CABLE-08's case, the one where the clamp MOVES something. A straight corridor east
    // from an E-facing port on (2,5) over open floor: (2,5) (3,5) (4,5), the far end free.
    //   E nub of (2,5): x = 2*32 + 32 - 2 + 2.5 = 96.5, y = 5*32 + 16 = 176
    //   cell centre of (2,5): (80, 176), so the clamp moves the first vertex 16.5 px east.
    // The free end stays on (4,5)'s centre, (144, 176). Before plan 75-05 the drag
    // preview stroked (80, 176) here: it had no clamp at all.
    const pts = cablePoints(cells([2, 5], [3, 5], [4, 5]), 0, { from: nubEndAt(2, 5, E), to: NO_NUB });
    expect(pts).toEqual([
      { x: 96.5, y: 176 },
      { x: 112, y: 176 },
      { x: 144, y: 176 },
    ]);
    expect(pts[0].y, 'the perpendicular coordinate is untouched').toBe(176);
    expectAxisAligned(pts, 'E nub pin');
  });

  it('an impossible pair gets the nub elbow at the end that cannot be head-on', () => {
    // 75-UI-SPEC 2.1, the P2 shape: two touching 1x1 docks, (2,5) facing E into (3,5),
    // whose port faces N. The router's path is (2,5) (3,5) and the last segment runs
    // east, ACROSS the N port's normal, so the clamp can only leave that end on the cell
    // centre. The elbow adds ONE vertex at the nub, so the cable turns at (3,5)'s centre
    // and runs up the normal onto it.
    //   E nub of (2,5): (96.5, 176)
    //   N nub of (3,5): x = 3*32 + 16 = 112, y = 5*32 + 2 - 2.5 = 159.5
    // The named cost: 16.5 px of cable over the port's own cell, the CABLE-05 exception.
    const end = cablePoints(cells([2, 5], [3, 5]), 0, { from: nubEndAt(2, 5, E), to: nubEndAt(3, 5, N) });
    expect(end).toEqual([
      { x: 96.5, y: 176 },
      { x: 112, y: 176 },
      { x: 112, y: 159.5 },
    ]);
    expect(end.slice(-2), 'the last two vertices, the turn and the nub').toEqual([
      { x: 112, y: 176 },
      { x: 112, y: 159.5 },
    ]);
    expectAxisAligned(end, 'elbow at the target');

    // The same shape at the SOURCE end: (2,5) facing N out to (3,5) facing W.
    //   N nub of (2,5): x = 2*32 + 16 = 80, y = 159.5
    //   W nub of (3,5): x = 3*32 + 2 - 2.5 = 95.5, y = 176
    const start = cablePoints(cells([2, 5], [3, 5]), 0, { from: nubEndAt(2, 5, N), to: nubEndAt(3, 5, W) });
    expect(start).toEqual([
      { x: 80, y: 159.5 },
      { x: 80, y: 176 },
      { x: 95.5, y: 176 },
    ]);
    expectAxisAligned(start, 'elbow at the source');

    // Lane +1 displaces the horizontal leg 2 px down (y 178). The elbow leg still runs
    // straight up the N normal: the turn vertex keeps x 112, which is the nub's x.
    const laned = cablePoints(cells([2, 5], [3, 5]), 1, { from: nubEndAt(2, 5, E), to: nubEndAt(3, 5, N) });
    expect(CABLE_LANE_OFFSET).toBe(2);
    expect(laned).toEqual([
      { x: 96.5, y: 178 },
      { x: 112, y: 178 },
      { x: 112, y: 159.5 },
    ]);
    const [turn, nub] = laned.slice(-2);
    expect(turn.x, 'the elbow leg is parallel to the N normal after the lane displacement').toBe(nub.x);
    expectAxisAligned(laned, 'elbow in lane +1');
  });

  it("the comet surface's geometry gains no elbow", () => {
    // 75-RESEARCH Pitfall 3. Since plan 75-09 this case is also the own-cell reach's guard:
    // both nubs lie behind their end vertices but off the end cells, so the reach must not
    // fire. `pixelGuard.tsx` `wireScene()`: an E-facing Out on (0,0) and
    // a W-facing In on (5,0), the path hand-authored from (1,0) to (4,0), so neither
    // nub's port cell is its end tile's cell. Both clamps decline on the WR-02 range
    // bound, and the line stays on the four cell centres.
    //   E nub of (0,0): (32.5, 16); W nub of (5,0): (159.5, 16)
    const path = cells([1, 0], [2, 0], [3, 0], [4, 0]);
    const centres = [
      { x: 48, y: 16 },
      { x: 80, y: 16 },
      { x: 112, y: 16 },
      { x: 144, y: 16 },
    ];
    expect(cablePoints(path, 0, { from: nubEndAt(0, 0, E), to: nubEndAt(5, 0, W) })).toEqual(centres);

    // ELBOW TERM (b), the case it alone decides. Turn the comet's source port to face N:
    // the first segment now runs ACROSS the normal (term (a) holds), but the nub's port
    // cell (0,0) is not the end tile (1,0). An elbow here would join (16, -0.5) to
    // (48, 16) on a DIAGONAL. Term (b) keeps it out.
    //   N nub of (0,0): x = 16, y = 0 + 2 - 2.5 = -0.5
    expect(cablePoints(path, 0, { from: nubEndAt(0, 0, N), to: nubEndAt(5, 0, W) })).toEqual(centres);
  });

  it('the same-cell stub draws nub to faced cell, outside its machine', () => {
    // 75-UI-SPEC 2.2, CABLE-09: plan 75-03's host stub for a coincident pair. The source
    // port on (5,5) faces E, the target port is on the SAME cell facing W, and the host
    // draws the source cell then the cell the source faces: (5,5) (6,5).
    //   E nub of (5,5): x = 5*32 + 32 - 2 + 2.5 = 192.5, y = 176
    //   W nub of (5,5): x = 5*32 + 2 - 2.5 = 159.5, y = 176
    //   centre of (6,5): (208, 176)
    // The two nubs read as CROSSED against the path, but the target nub is not on the
    // end tile's cell, so the WR-01 collapse does not fire: the start clamps onto the E
    // nub and the far end stays on (6,5)'s centre, 15.5 px of cable outside the machine.
    // Before plan 75-05 the collapse joined (192.5, 176) to (159.5, 176), straight
    // across the machine body.
    const pts = cablePoints(cells([5, 5], [6, 5]), 0, { from: nubEndAt(5, 5, E), to: nubEndAt(5, 5, W) });
    expect(pts).toEqual([
      { x: 192.5, y: 176 },
      { x: 208, y: 176 },
    ]);
    expect(pts[1].x - pts[0].x, 'a visible 15.5 world px cable').toBe(15.5);
    for (const p of pts) {
      expect(p.x > 160 && p.x < 192, `vertex (${p.x},${p.y}) is not inside the machine on (5,5)`).toBe(false);
    }
  });

  it('CR-01: an end that runs along its normal but backwards still reaches its nub', () => {
    // 75-REVIEW CR-01, plan 75-09. The end segment runs ON its port normal's axis, but the
    // nub lies BEHIND the end vertex (the cable leaves its port's cell through the back, or
    // enters it from behind). The elbow does not fire (the segment does not run across the
    // normal) and the WR-02 range bound used to decline the clamp, so the end stayed on the
    // cell centre, inside the machine, 16.5 px from its nub. Shapes 1 and 2 run in lane +1
    // (the first cell sorts before the last), so their horizontal leg sits 2 px below the
    // cell centres.

    // 1. REVERSED TARGET. A Route's Out on (2,5) facing E, to a 1x1 In on (3,5) also facing
    //    E: the cable enters (3,5) from its back (west) face.
    //      E nub of (2,5): x = 2*32 + 32 - 2 + 2.5 = 96.5
    //      E nub of (3,5): x = 3*32 + 32 - 2 + 2.5 = 128.5
    //      lane +1: y = 5*32 + 16 + 2 = 178
    //    Before the fix the last vertex stayed on (3,5)'s centre, x 112.
    expect(cablePoints(cells([2, 5], [3, 5]), 1, { from: nubEndAt(2, 5, E), to: nubEndAt(3, 5, E) })).toEqual([
      { x: 96.5, y: 178 },
      { x: 128.5, y: 178 },
    ]);

    // 2. REVERSED SOURCE, the review's board: a 1x1 Out on (0,0) facing W, to a Handler In
    //    on (1,0) facing W. The cable leaves (0,0) through its back (east) face.
    //      W nub of (0,0): x = 0 + 2 - 2.5 = -0.5
    //      W nub of (1,0): x = 32 + 2 - 2.5 = 31.5
    //      lane +1: y = 16 + 2 = 18
    //    Before the fix the first vertex stayed on (0,0)'s centre, x 16.
    expect(cablePoints(cells([0, 0], [1, 0]), 1, { from: nubEndAt(0, 0, W), to: nubEndAt(1, 0, W) })).toEqual([
      { x: -0.5, y: 18 },
      { x: 31.5, y: 18 },
    ]);

    // 3. THE THIN MACHINE, candidate 4 (the review's example): a port on (6,2) facing N on a
    //    one-cell-thick body (5,2)-(8,2), to a port on (6,0) facing W, body (6,-2)-(7,1).
    //    The source's only free neighbour is directly behind it, so the route leaves (6,2)
    //    SOUTH. The first cell (6,2) and the last (6,0) tie on x and the first sorts after
    //    the last on y, so `cableLane` gives -1 and the vertical first leg sits 2 px left
    //    of the cell centre column.
    //      N nub of (6,2): x = 6*32 + 16 = 208, y = 2*32 + 2 - 2.5 = 63.5
    //    The vertical first leg sits at x 206 (lane -1). Before the fix the first vertex
    //    was (206, 80), (6,2)'s centre row, 16.5 px below the nub.
    const r = wireRouteTraced(
      { cell: [6, 2], side: N, body: { min_x: 5, min_y: 2, max_x: 8, max_y: 2 } },
      { cell: [6, 0], side: W, body: { min_x: 6, min_y: -2, max_x: 7, max_y: 1 } },
    );
    expect(r.ok, 'the router serves the thin-machine pair').toBe(true);
    if (!r.ok) return;
    expect(r.cand, 'candidate 4, clear of bodies').toBe(4);
    const tiles = r.geometry.tiles;
    expect([tiles[0].cell_x, tiles[0].cell_y], 'the path starts on the port cell').toEqual([6, 2]);
    expect([tiles[1].cell_x, tiles[1].cell_y], 'and leaves it SOUTH, through the back').toEqual([6, 3]);
    const thin = cablePoints(tiles, cableLane(tiles), { from: nubEndAt(6, 2, N), to: nubEndAt(6, 0, W) });
    expect(thin[0], 'the first drawn vertex is on the N nub row').toEqual({ x: 206, y: 63.5 });
    expectAxisAligned(thin, 'thin machine');
  });

  it('two adjacent machines still collapse onto both nubs', () => {
    // WR-01's own case: (5,5) facing E and (6,5) facing W, directly adjacent, path
    // (5,5) (6,5). Each nub IS on its end tile's cell, so the collapse still fires.
    //   E nub of (5,5): (192.5, 176); W nub of (6,5): x = 6*32 + 2 - 2.5 = 191.5
    expect(cablePoints(cells([5, 5], [6, 5]), 0, { from: nubEndAt(5, 5, E), to: nubEndAt(6, 5, W) })).toEqual([
      { x: 192.5, y: 176 },
      { x: 191.5, y: 176 },
    ]);
  });
});
