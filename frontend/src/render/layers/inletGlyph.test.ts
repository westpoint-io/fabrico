import { describe, expect, it } from 'vitest';
import { INLET_HALF, inletGlyphRects } from './inletGlyph';
import { PORT_ROLE, unitDelta } from '../../protocol/ports';

// inletGlyph.test.ts - the red-proof geometry gate for the endpoint inlet terminal
// (FEEL-04, phase 46). The Phase-45 lesson (F2 shipped because only one chirality
// was asserted) is closed here: TWO orientations are pinned against INDEPENDENTLY
// hard-coded expected lists (never computed by calling the module under test), and
// all four normals carry structural invariants (bounds, count, asymmetry) so a
// mouth flip or chevron inversion cannot slip through green.
//
// THE ROLE AXIS, added at plan 72-09 (R-60, UI-SPEC 5.4). The chevron MIRRORS for a
// `Role::Out` terminal so its arrow points along the direction traffic actually travels
// at that nub. Every case above passes `PORT_ROLE.IN` EXPLICITLY rather than relying on
// a default, so the request-in half stays pinned exactly as it was, and the Out half is
// swept separately below over all four normals. The Phase-45 lesson generalises: one
// chirality asserted is one chirality shipped, and role is now a second chirality.

// The canonical EAST list, hand-derived in 46-01-PLAN "Canonical inlet glyph
// geometry": outward normal (1, 0), socket mouth opening toward +x, chevron apex
// pointing toward -x (INTO the endpoint square, request-in, D-01).
const EAST_EXPECTED = [
  { x: -7, y: -7, w: 3, h: 14 }, // back wall
  { x: -4, y: -7, w: 11, h: 3 }, // top arm
  { x: -4, y: 4, w: 11, h: 3 }, // bottom arm
  { x: -2, y: -1, w: 2, h: 2 }, // chevron apex
  { x: 0, y: -3, w: 2, h: 2 }, // chevron upper arm
  { x: 0, y: 1, w: 2, h: 2 }, // chevron lower arm
];

// The NORTH list, derived INDEPENDENTLY in the plan via the corner rule
// (u, v) -> (u*nx - v*ny, u*ny + v*nx) with min-corner re-normalization, for
// normal (0, -1) (mouth up). Written out literally: red-proof, not computed.
const NORTH_EXPECTED = [
  { x: -7, y: 4, w: 14, h: 3 }, // back wall
  { x: -7, y: -7, w: 3, h: 11 }, // left arm
  { x: 4, y: -7, w: 3, h: 11 }, // right arm
  { x: -1, y: 0, w: 2, h: 2 }, // chevron apex
  { x: -3, y: -2, w: 2, h: 2 }, // chevron arm A
  { x: 1, y: -2, w: 2, h: 2 }, // chevron arm B
];

const NORMALS: Array<[number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

const centroidDot = (r: { x: number; y: number; w: number; h: number }, nx: number, ny: number) =>
  (r.x + r.w / 2) * nx + (r.y + r.h / 2) * ny;

describe('inletGlyph - hard-coded canonical lists (red-proof, two orientations)', () => {
  it('EAST (1, 0) equals the canonical hand-authored list exactly', () => {
    expect(inletGlyphRects(1, 0, PORT_ROLE.IN)).toEqual(EAST_EXPECTED);
  });

  it('NORTH equals the independently derived list (unitDelta maps N to (0, -1))', () => {
    // Guard: side 0 (N) really is the (0, -1) normal this expected list was derived for.
    expect(unitDelta(0)).toEqual([0, -1]);
    expect(inletGlyphRects(0, -1, PORT_ROLE.IN)).toEqual(NORTH_EXPECTED);
  });
});

describe('inletGlyph - structural invariants for all four normals', () => {
  it.each(NORMALS)('normal (%i, %i): 6 positive-size rects inside [-INLET_HALF, INLET_HALF]', (nx, ny) => {
    const rects = inletGlyphRects(nx, ny, PORT_ROLE.IN);
    expect(rects).toHaveLength(6);
    for (const r of rects) {
      expect(r.w).toBeGreaterThan(0);
      expect(r.h).toBeGreaterThan(0);
      expect(r.x).toBeGreaterThanOrEqual(-INLET_HALF);
      expect(r.y).toBeGreaterThanOrEqual(-INLET_HALF);
      expect(r.x + r.w).toBeLessThanOrEqual(INLET_HALF);
      expect(r.y + r.h).toBeLessThanOrEqual(INLET_HALF);
    }
  });

  it.each(NORMALS)(
    'normal (%i, %i): back wall on the negative-normal side, chevron apex pointing INTO the square',
    (nx, ny) => {
      const rects = inletGlyphRects(nx, ny, PORT_ROLE.IN);
      // The back wall is the UNIQUE rect with a 14-long edge; it must sit on the
      // NEGATIVE-normal side (the endpoint-square side), i.e. its centroid dot < 0.
      const walls = rects.filter((r) => Math.max(r.w, r.h) === 14);
      expect(walls).toHaveLength(1);
      expect(centroidDot(walls[0], nx, ny)).toBeLessThan(0);

      // The chevron is three 2x2 rects; the apex is the one NEAREST the back wall
      // along the normal axis (minimum centroid dot). It must sit STRICTLY closer
      // to the endpoint than both arms: the "<" points INTO the square (D-01). A
      // mouth flip or an inverted chevron breaks this for at least one normal.
      const chevrons = rects.filter((r) => r.w === 2 && r.h === 2);
      expect(chevrons).toHaveLength(3);
      const dots = chevrons.map((r) => centroidDot(r, nx, ny)).sort((a, b) => a - b);
      const [apex, armA, armB] = dots;
      expect(apex).toBeLessThan(armA);
      expect(apex).toBeLessThan(armB);
    },
  );
});

describe('inletGlyph - the chevron MIRRORS for a Role::Out terminal (72-09 R-60)', () => {
  /**
   * WHY THIS MATTERS NOW. `wires.ts` stamps this glyph whenever the DOCKED NODE is a
   * Route, with no reference to the port's role. Under D-04 both cables terminate at the
   * Route, so the FORWARD cable's glyph sits on the Route's **Out** nub - and an arrow
   * pointing INTO the port a request is LEAVING FROM is a shape telling the user the
   * opposite of what happens. Today that ships only on the genesis demo board; after
   * this phase every user-built route grows one.
   */

  /** The EAST list for an OUT terminal, hand-derived rather than computed from the
   *  module under test: the three SOCKET rects are byte-identical to EAST_EXPECTED, and
   *  the three chevron rects are reflected in u about 0 (x -> -(x + w)). */
  const EAST_OUT_EXPECTED = [
    { x: -7, y: -7, w: 3, h: 14 }, // back wall, UNMOVED
    { x: -4, y: -7, w: 11, h: 3 }, // top arm, UNMOVED
    { x: -4, y: 4, w: 11, h: 3 }, // bottom arm, UNMOVED
    { x: 0, y: -1, w: 2, h: 2 }, // chevron apex, now pointing OUT toward the cable
    { x: -2, y: -3, w: 2, h: 2 }, // chevron upper arm
    { x: -2, y: 1, w: 2, h: 2 }, // chevron lower arm
  ];

  it('EAST at Role::Out equals the independently derived mirrored list exactly', () => {
    expect(inletGlyphRects(1, 0, PORT_ROLE.OUT)).toEqual(EAST_OUT_EXPECTED);
  });

  it.each(NORMALS)(
    'normal (%i, %i): the three SOCKET rects do NOT move - the mouth still faces the cable',
    (nx, ny) => {
      // The socket says "a cable lands here", which is true at either role. Only the
      // ARROW carries direction. If the socket mirrored too, the mouth would face the
      // machine and the glyph would stop reading as a connector at all.
      const inn = inletGlyphRects(nx, ny, PORT_ROLE.IN);
      const out = inletGlyphRects(nx, ny, PORT_ROLE.OUT);
      const socketOf = (rects: typeof inn) => rects.filter((r) => Math.max(r.w, r.h) > 2);
      expect(socketOf(out)).toHaveLength(3);
      expect(socketOf(out)).toEqual(socketOf(inn));
    },
  );

  it.each(NORMALS)(
    'normal (%i, %i): the apex points AWAY from the square at Out - the exact inverse of In',
    (nx, ny) => {
      // The mirror image of the In invariant above, asserted in the direction that makes
      // it a genuine inverse: at Role::In the apex is the chevron rect NEAREST the
      // machine; at Role::Out it is the one FURTHEST from it.
      const chevrons = inletGlyphRects(nx, ny, PORT_ROLE.OUT).filter(
        (r) => r.w === 2 && r.h === 2,
      );
      expect(chevrons).toHaveLength(3);
      const dots = chevrons.map((r) => centroidDot(r, nx, ny)).sort((a, b) => a - b);
      const [armA, armB, apex] = dots;
      expect(apex).toBeGreaterThan(armA);
      expect(apex).toBeGreaterThan(armB);
    },
  );

  it.each(NORMALS)(
    'normal (%i, %i): the Out glyph still fits [-INLET_HALF, INLET_HALF] and is 6 rects',
    (nx, ny) => {
      const rects = inletGlyphRects(nx, ny, PORT_ROLE.OUT);
      expect(rects).toHaveLength(6);
      for (const r of rects) {
        expect(r.w).toBeGreaterThan(0);
        expect(r.h).toBeGreaterThan(0);
        expect(r.x).toBeGreaterThanOrEqual(-INLET_HALF);
        expect(r.y).toBeGreaterThanOrEqual(-INLET_HALF);
        expect(r.x + r.w).toBeLessThanOrEqual(INLET_HALF);
        expect(r.y + r.h).toBeLessThanOrEqual(INLET_HALF);
      }
    },
  );

  it.each(NORMALS)(
    'normal (%i, %i): the two roles are genuinely DIFFERENT glyphs, not the same one twice',
    (nx, ny) => {
      // The non-vacuity arm. Without it every assertion above would pass if the role
      // argument were silently ignored, which is precisely the shape of the defect this
      // whole block exists to prevent.
      expect(inletGlyphRects(nx, ny, PORT_ROLE.OUT)).not.toEqual(
        inletGlyphRects(nx, ny, PORT_ROLE.IN),
      );
    },
  );

  it('an UNKNOWN role byte draws the request-in chevron and never throws', () => {
    // The role keyspace is open on the wire (`ports.ts PORT_ROLE`), and this runs inside
    // the Pixi ticker, where a throw kills the renderer permanently while every model
    // assertion stays green.
    for (const role of [PORT_ROLE.FAULT, 3, 99, 255]) {
      expect(() => inletGlyphRects(1, 0, role)).not.toThrow();
      expect(inletGlyphRects(1, 0, role)).toEqual(inletGlyphRects(1, 0, PORT_ROLE.IN));
    }
  });
});
