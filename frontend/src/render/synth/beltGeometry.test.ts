// THE STRAIGHT BELT TILE'S GEOMETRY GATE (BELT-05, BELT-08 - plan 61-02).
//
// It runs in the project's DEFAULT environment with no pragma comment at the top of
// this file, and that is the property `beltGeometry.ts` is Pixi-free FOR: there is no
// GL context here, no DOM, and no renderer of any kind. The module under test emits
// numbers, so the gate reads numbers.
//
// TWO KINDS OF ASSERTION, DELIBERATELY NOT ONE (`61-RESEARCH.md` names both forms).
//
//   - A GEOMETRIC PROPERTY is measured off the EMITTED POINT LIST. "The lane is 20px
//     wide" is a fact about the shape that got drawn, so it is read back from the
//     drawn shape. Asserting it from the record instead would only prove the record
//     equals itself.
//   - An IDENTITY OVER THE RECORD is asserted from the record. "A straight-to-straight
//     seam is 0px" is true because `CELL` is a whole multiple of the dash period - an
//     arithmetic fact, not a measurement, and one that would be WEAKER if sampled
//     (a sampled seam is bounded by the sampling, an identity is exact).
//
// Splitting them is what stops a record change and a geometry change from cancelling
// each other out: if `laneHalf` moved and the emitter moved with it, the measured
// lane would still agree with the record and only the LITERAL PIN below would notice.
//
// THE COUNTER-RULE, from `machineChassis.ts:44-57`. A derivation-only suite agrees
// with itself at ANY value: mutating `CHASSIS_INSET_U` from 4 to 6 passed all 1422
// vitest cases and all 87 spec files before a literal pin was added. So at least one
// LITERAL is pinned per locked number here, and the mutation control is recorded in
// the plan summary rather than assumed.
//
// CORNERS ARE ASSERTED FROM PLAN 61-03 DOWN (the second half of this file). The same
// two-kinds-of-assertion split applies there and is load-bearing in the same way: the
// R = 16 tangent property is an IDENTITY over the record and is additionally asserted
// to FAIL at four neighbouring radii, so it is a discriminator rather than a tautology;
// the lane, the band, the cap angles and the pace are MEASURED off the emitted points.

import { describe, expect, it } from 'vitest';
import { BELT_DASH_PERIOD, BELT_GEOM, CELL } from '../../../shared/geometry.ts';
import {
  ARC_SAMPLES,
  cornerRailCommands,
  railBandAt,
  railCommands,
  BELT_MARCH_BUCKETS,
  BELT_MARCH_BUCKET_COUNTS,
  BELT_MARCH_QUANTUM_TICKS,
  MARCH_NYQUIST_CEILING_PX_PER_TICK,
  LOD_ARC_SAMPLES,
  CORNER_ARC_LENGTH,
  ticksPerDashPeriod,
  bucketOf,
  bucketSizePx,
  cornerCommands,
  cornerTickCommands,
  marchPxPerTick,
  resyncLurchPx,
  straightCommands,
  straightTickCommands,
  worstCaseQuantizationPx,
  type BeltPathCommand,
} from './beltGeometry.ts';
// The ONE integer the lurch metric needs, read from the module that owns it rather
// than re-typed. See the lurch case for why importing `loop.ts` keeps this suite
// DOM-free and GL-free.
import { RESYNC_GAP_TICKS } from '../loop.ts';

/** Every march bucket of the shipped lattice, so no case looks at one bucket only. */
const K = 4;
const BUCKETS = [0, 1, 2, 3];

/** The x coordinates of one emitted path (even indices of the flat point list). */
const xsOf = (c: BeltPathCommand): number[] => c.points.filter((_, i) => i % 2 === 0);

/** The y coordinates of one emitted path (odd indices of the flat point list). */
const ysOf = (c: BeltPathCommand): number[] => c.points.filter((_, i) => i % 2 === 1);

/** The axis-aligned extent of one emitted path, read purely off its points. */
const extentOf = (c: BeltPathCommand): { x0: number; x1: number; y0: number; y1: number } => {
  const xs = xsOf(c);
  const ys = ysOf(c);
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
};

const railsOf = (cmds: BeltPathCommand[]): BeltPathCommand[] =>
  cmds.filter((c) => c.role === 'rail');
const treadsOf = (cmds: BeltPathCommand[]): BeltPathCommand[] =>
  cmds.filter((c) => c.role === 'tread');

/**
 * THE LEGAL DEVICE-QUANTUM RANGE, swept rather than sampled.
 *
 * The floor is the camera's minimum-zoom clamp at DPR 1 (`belts.ts MIN_SCALE` = 0.25);
 * the ceiling is the maximum zoom (4) at DPR 2. The step is 0.01 - fine enough that
 * every rounding boundary of `laneHalf * q` (a 1/10 lattice) and of `16q` (a 1/16
 * lattice) is crossed many times over, so no property below passes by landing only on
 * convenient quanta.
 */
const Q_MIN = 0.25;
const Q_MAX = 8;
const Q_STEP = 0.01;
const sweepQuanta = (): number[] => {
  const out: number[] = [];
  for (let i = 0; i <= Math.round((Q_MAX - Q_MIN) / Q_STEP); i++) {
    out.push(Math.round((Q_MIN + i * Q_STEP) * 100) / 100);
  }
  return out;
};

/**
 * THE PRE-FIX STRAIGHT RAIL GEOMETRY, TRANSCRIBED AS LITERALS.
 *
 * These are the two rectangles the quantum-free emitter produced before plan 61-09:
 * `rect(-16, -10, 32, 1)` and `rect(-16, 9, 32, 1)`, each as `rect`'s own closed
 * 4-point winding. They are written out rather than derived from `BELT_GEOM`, because
 * the integer-quantum identity is exactly the claim that the NEW emitter reproduces
 * the OLD BYTES - and a derivation from the record would be satisfied by any emitter
 * that also read the record.
 */
/**
 * A measured device-space quantity, with binary-float round-trip noise removed.
 *
 * THE NOISE IS AN ARTEFACT OF THE MEASUREMENT, NOT OF THE GEOMETRY. The rule computes
 * its band in DEVICE integers and divides by `q` to express it in world units; a test
 * that multiplies by `q` again lands 1 ULP away (`(1 / 0.26) * 0.26` is
 * 0.9999999999999997). The 1e-9 quantum is the same discipline the committed digest
 * table records for its own 1/256 quantum: far below anything a real geometry change
 * can hide behind, since a regression here moves a band by WHOLE device pixels.
 */
const deviceExact = (v: number): number => Math.round(v * 1e9) / 1e9;

const PRE_FIX_STRAIGHT_RAILS: readonly (readonly number[])[] = [
  [-16, -10, 16, -10, 16, -9, -16, -9],
  [-16, 9, 16, 9, 16, 10, -16, 10],
];

describe('the device-quantum rail rule (plan 61-09)', () => {
  // WHY THIS BLOCK EXISTS. The rails are 1 WORLD px. At camera scale s on a DPR-1
  // display their device width is `q = s`, and under `antialias: false` a band narrower
  // than one device pixel may contain no pixel CENTRE at all - so it is not drawn.
  // Measured on 2026-08-10, the vector belt lost a whole rail at 4 of 6 camera scales
  // in 0.75..1.00 and the pre-phase RASTER belt lost one at 2 of 6. The rule below is
  // the fix, and every property of it is assertable with no renderer at all.

  it('never lets the rail band fall below ONE whole device pixel, over the legal range', () => {
    // THE WHOLE FIX, AS ONE INEQUALITY. A band of at least one device pixel always
    // contains a pixel centre; a narrower band may contain none, and that is a property
    // of the NUMBER, not of where the band sits.
    for (const q of sweepQuanta()) {
      const rails = railCommands(q);
      expect(rails, `q=${q} emits both side rails`).toHaveLength(2);
      for (const e of rails.map(extentOf)) {
        expect(
          deviceExact((e.y1 - e.y0) * q),
          `q=${q} device band thickness`,
        ).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('lands both device edges of both bands on WHOLE device rows, at every quantum', () => {
    // The straight's band is expressed in world units but its EDGES are integers in
    // DEVICE space - which is the only reason a world-space expression can land on a
    // whole device row at all. It works because the tile centre is itself already
    // snapped (`belts.ts` runs `snapToDevicePixel` on every tile position), so the
    // band is snapped RELATIVE to a point that is on a whole device pixel.
    for (const q of sweepQuanta()) {
      for (const e of railCommands(q).map(extentOf)) {
        for (const edge of [e.y0, e.y1]) {
          const device = edge * q;
          expect(
            Math.abs(device - Math.round(device)),
            `q=${q} device edge ${device}`,
          ).toBeLessThan(1e-9);
        }
      }
    }
  });

  it('keeps the lane SYMMETRIC about the tile centre, at every quantum', () => {
    // Derived ONCE as `d` and applied as `-d` and `+d`. Computing the two edges
    // independently would break symmetry, because rounding a negative half-integer
    // does not mirror rounding a positive one (`Math.round(-7.5)` is -7, not -8).
    for (const q of sweepQuanta()) {
      const e = railCommands(q).map(extentOf);
      const outerTop = Math.min(...e.map((r) => r.y0));
      const outerBottom = Math.max(...e.map((r) => r.y1));
      expect(outerTop + outerBottom, `q=${q} lane symmetry`).toBeCloseTo(0, 12);
      // ... and the two bands are the same thickness as each other.
      expect(e[0].y1 - e[0].y0).toBeCloseTo(e[1].y1 - e[1].y0, 12);
    }
  });

  it('spans at least the LARGEST device pitch two snapped tile centres can have', () => {
    // NO GAP COLUMNS, AS AN ARITHMETIC IDENTITY RATHER THAN A PIXEL MEASUREMENT.
    // Consecutive tile centres are `CELL` world px apart, so their SNAPPED device
    // positions differ by at most `ceil(CELL * q)`. The rail spans `2 * ceil(HALF * q)`
    // device px. Sweeping the inequality over the whole legal range is strictly
    // stronger than sampling six scales, and it is what makes "an interior gap column
    // cannot exist" a construction rather than an observation.
    for (const q of sweepQuanta()) {
      const e = railCommands(q).map(extentOf);
      const span = deviceExact(
        (Math.max(...e.map((r) => r.x1)) - Math.min(...e.map((r) => r.x0))) * q,
      );
      const worstPitch = Math.ceil(CELL * q);
      expect(span, `q=${q} device span vs pitch ${worstPitch}`).toBeGreaterThanOrEqual(
        worstPitch,
      );
      // The span is itself a whole number of device px, so the comparison is exact.
      expect(Math.abs(span - Math.round(span))).toBeLessThan(1e-9);
    }
  });

  it('reproduces the PRE-FIX geometry exactly at every integer quantum in 1..8', () => {
    // THE BASELINE-STABILITY CLAIM, GATED. Every committed pixel baseline in this repo
    // is captured at device-pixel ratio 1 and zoom 1, i.e. q = 1 - so if the emitted
    // points at integer quanta are the pre-fix points, no baseline can move.
    for (let q = 1; q <= 8; q++) {
      const rails = railCommands(q);
      expect(rails, `q=${q} rail count`).toHaveLength(2);
      for (const [i, cmd] of rails.entries()) {
        expect([...cmd.points], `q=${q} rail ${i}`).toEqual([...PRE_FIX_STRAIGHT_RAILS[i]]);
        expect(cmd.role).toBe('rail');
        expect(cmd.style.mode).toBe('fill');
        expect(cmd.close).toBe(true);
      }
      // ... and the derived terms take their identity values there.
      const band = railBandAt(q);
      expect(band.d).toBe(BELT_GEOM.laneHalf * q);
      expect(band.t).toBe(BELT_GEOM.rail * q);
      expect(band.over).toBeCloseTo(0, 12);
    }
  });

  it('pins the six gate quanta to the derived integers the plan states', () => {
    // THE LITERAL PIN (the `machineChassis.ts:44-57` counter-rule). Every case above
    // derives from the rule and would therefore agree with itself if the rule changed.
    // These are the numbers the plan predicted BEFORE any code was written, so a
    // silent change to the rounding discipline reddens here.
    const expected: Array<[number, number, number, number]> = [
      // [quantum, d, t, device span]
      [0.75, 8, 1, 24],
      [0.8, 8, 1, 26],
      [0.85, 9, 1, 28],
      [0.9, 9, 1, 30],
      [0.95, 10, 1, 32],
      [1, 10, 1, 32],
    ];
    for (const [q, d, t, span] of expected) {
      const band = railBandAt(q);
      expect(band.d, `q=${q} lane device half-width`).toBe(d);
      expect(band.t, `q=${q} rail device thickness`).toBe(t);
      const e = railCommands(q).map(extentOf);
      const measured = (Math.max(...e.map((r) => r.x1)) - Math.min(...e.map((r) => r.x0))) * q;
      expect(Math.round(measured), `q=${q} device span`).toBe(span);
    }
  });

  it('leaves the four TREAD emitters carrying no rail path at all', () => {
    // THE SPLIT, GATED BEHAVIOURALLY RATHER THAN BY GREP. The rails now live in their
    // own asset family with its own LIFETIME, so a tread emitter that still carried
    // one would put a quantum-free rail back inside the scale-free cache.
    for (const cmds of [straightCommands(0, 12), straightTickCommands()]) {
      expect(cmds.length).toBeGreaterThan(0);
      for (const c of cmds) expect(c.role).toBe('tread');
    }
  });

  it('gives the CORNER rails the same lane as the straight, at every quantum', () => {
    // **THE CORNER CANNOT ACQUIRE ITS OWN LANE, AND NOT MERELY AT ZOOM 1.** Both
    // emitters read the SAME derived `d`, so the claim is swept rather than sampled.
    // The corner rails are strokes: their drawn edges sit half a band width either side
    // of the sampled radius, which is the polar form of the expansion the straight's
    // filled rectangles carry in their own point list.
    for (const q of sweepQuanta()) {
      const rails = cornerRailCommands(ARC_SAMPLES, q, 'cw');
      expect(rails, `q=${q} emits both corner rails`).toHaveLength(2);
      const width = (rails[0].style as { width: number }).width;
      const radii = rails.flatMap((c) =>
        c.points.filter((_, i) => i % 2 === 0).map((_, i) => {
          const x = c.points[i * 2] + BELT_GEOM.elbowR;
          const y = c.points[i * 2 + 1] + BELT_GEOM.elbowR;
          return Math.hypot(x, y);
        }),
      );
      const cornerLane = Math.max(...radii) + width / 2 - (Math.min(...radii) - width / 2);
      const straight = railCommands(q).map(extentOf);
      const straightLane =
        Math.max(...straight.map((e) => e.y1)) - Math.min(...straight.map((e) => e.y0));
      expect(cornerLane, `q=${q} corner lane vs straight lane`).toBeCloseTo(straightLane, 9);
      // ... and the corner band is at least ONE DEVICE PIXEL thick across its normal,
      // which is the half of the rule the corner takes. It does NOT take the position
      // half: a circle has no rows to snap to (see the emitter's docblock).
      expect(deviceExact(width * q), `q=${q} corner band device thickness`).toBeGreaterThanOrEqual(
        1,
      );
    }
  });

  it('reproduces the pre-fix CORNER rail geometry exactly at every integer quantum', () => {
    // The same baseline-stability claim the straight carries, on the corner. Read
    // against the identity-quantum emission rather than against transcribed literals,
    // because a 25-point sampled arc written out by hand would be a transcription bug
    // waiting to happen - and the q = 1 emission IS the pre-fix code path (the rule's
    // three terms all take their identity values there, which the straight's own case
    // pins as literals).
    for (const chirality of CHIRALITIES) {
      const at1 = JSON.stringify(cornerRailCommands(ARC_SAMPLES, 1, chirality));
      for (let q = 2; q <= 8; q++) {
        expect(
          JSON.stringify(cornerRailCommands(ARC_SAMPLES, q, chirality)),
          `${chirality} corner rails at q=${q}`,
        ).toBe(at1);
      }
      // NON-VACUITY: a fractional quantum really does move them, so the equality above
      // is a property of whole quanta and not of an emitter ignoring its argument.
      expect(JSON.stringify(cornerRailCommands(ARC_SAMPLES, 0.85, chirality))).not.toBe(at1);
    }
  });

  it('extends the corner sweep at BOTH ends by the overhang, so a bend has no seam either', () => {
    // The straight closes its gap columns by overhanging its tile; the corner has to
    // meet it there. The extension is an ARC LENGTH turned into an angle exactly once,
    // on the CENTRELINE radius - the same discipline BELT-01 applies to `dashSector` -
    // so both rails of the pair are extended by the same WORLD distance, not by the
    // same angle at two different radii.
    for (const q of [0.8, 0.85, 0.9, 0.95, 1.25, 1.77]) {
      const { over } = railBandAt(q);
      const rails = cornerRailCommands(ARC_SAMPLES, q, 'cw').map(pointsOf);
      for (const [i, pts] of rails.entries()) {
        const r = radiusOf(pts[0], R);
        const t0 = Math.atan2(pts[0].y + R, pts[0].x + R);
        const t1 = Math.atan2(pts[pts.length - 1].y + R, pts[pts.length - 1].x + R);
        // The swept angle exceeds the quarter turn by `2 * over / R` exactly.
        expect(t1 - t0, `q=${q} rail ${i} swept angle`).toBeCloseTo(
          Math.PI / 2 + (2 * over) / R,
          9,
        );
        // Every point of a rail is still ON one radius - the extension moved the caps,
        // not the arc.
        for (const p of pts) expect(radiusOf(p, R)).toBeCloseTo(r, 9);
      }
    }
  });

  it('mirrors the two corner rail chiralities in x and in nothing else', () => {
    for (const q of [0.75, 0.9, 1, 1.77]) {
      const cw = cornerRailCommands(ARC_SAMPLES, q, 'cw');
      const ccw = cornerRailCommands(ARC_SAMPLES, q, 'ccw');
      expect(ccw).toHaveLength(cw.length);
      for (let i = 0; i < cw.length; i++) {
        expect(ccw[i].role).toBe(cw[i].role);
        expect(ccw[i].style).toEqual(cw[i].style);
        expect(ccw[i].points.map((v, j) => (j % 2 === 0 ? -v : v))).toEqual([...cw[i].points]);
      }
      // Non-vacuity: a mirror is not the identity.
      expect(JSON.stringify(ccw)).not.toBe(JSON.stringify(cw));
    }
  });

  it('leaves the CORNER tread emitters carrying no rail path at all', () => {
    for (const chirality of CHIRALITIES) {
      for (const cmds of [cornerCommands(0, 12, chirality), cornerTickCommands(chirality)]) {
        expect(cmds.length).toBeGreaterThan(0);
        for (const c of cmds) expect(c.role).toBe('tread');
      }
    }
  });

  it('refuses a degenerate quantum rather than emitting NaN geometry', () => {
    // `belts.ts` reads the quantum from a live closure; a camera-init transient can
    // hand it 0, and `0` would divide every coordinate to Infinity. Mirror the
    // `items.ts snapToDevicePixel` guard: fall back to the identity quantum, which is
    // the pre-fix geometry and therefore always drawable.
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const rails = railCommands(bad);
      for (const c of rails) for (const v of c.points) expect(Number.isFinite(v)).toBe(true);
      expect(JSON.stringify(rails)).toBe(JSON.stringify(railCommands(1)));
    }
  });
});

describe('the straight tile lane (BELT-05)', () => {
  // Test 1 - MEASURED off the emitted points, never read back off the record.
  it('measures 20.00px rail outer edge to rail outer edge, at every march bucket', () => {
    for (const bucket of BUCKETS) {
      // PLAN 61-09 MOVED THE RAILS OUT OF THE TREAD EMITTER, so the lane is measured
      // off the rail family at the identity quantum. The bucket sweep is KEPT: the
      // claim "the lane does not move as the tread marches" is still exactly the claim,
      // and it is now true by construction rather than by inspection.
      const rails = railCommands(1);
      expect(railsOf(straightCommands(bucket, K)), `bucket ${bucket} tread is rail-free`)
        .toHaveLength(0);
      expect(rails, `bucket ${bucket} emits both side rails`).toHaveLength(2);
      const edges = rails.map(extentOf);
      const outerTop = Math.min(...edges.map((e) => e.y0));
      const outerBottom = Math.max(...edges.map((e) => e.y1));
      // The geometric property, measured: how far apart the two drawn rails are.
      expect(outerBottom - outerTop, `bucket ${bucket} lane width`).toBe(20);
      // ... and the same distance stated as the record's own arithmetic, so a lane
      // that drifted from `laneHalf` fails here rather than silently redefining it.
      expect(outerBottom - outerTop).toBe(2 * BELT_GEOM.laneHalf);
      // Each rail is exactly `rail` thick and lies INSIDE its lane edge (subtracted
      // inward), which is what keeps both of its own edges on integers.
      for (const e of edges) expect(e.y1 - e.y0).toBe(BELT_GEOM.rail);
    }
  });

  // Test 2 - THE LITERAL PIN. Without these two lines every other assertion in this
  // file derives from the record and therefore agrees with itself at any value.
  it('pins the locked lane half-width and dash band to their literals', () => {
    expect(BELT_GEOM.laneHalf).toBe(10);
    expect(BELT_GEOM.band).toBe(2);
  });

  // Test 5 - an identity over the record: the board showing either side of the lane.
  it('leaves 6px of board on each side of the 32px cell', () => {
    expect((CELL - 2 * BELT_GEOM.laneHalf) / 2).toBe(6);
    // Measured against the drawn rails as well, because "6px of board" is a claim
    // about what a player sees and not only about arithmetic. The exposed board is
    // the SAME ramp[0] as the belt's hollow interior (61-UI-SPEC A7.1), so this reads
    // purely as the rails moving inward - not as a strip appearing under the belt.
    const rails = railCommands(1).map(extentOf);
    const outerTop = Math.min(...rails.map((e) => e.y0));
    expect(outerTop - -(CELL / 2)).toBe(6);
  });
});

describe('the straight tile sits on the device-pixel grid', () => {
  // Test 3 - the property that lets `antialias: false` stay honest at zoom 1 / DPR 1.
  it('emits none but integer coordinates, on every path of every bucket', () => {
    for (const cmds of [
      ...BUCKETS.map((b) => straightCommands(b, K)),
      straightTickCommands(),
      // The rail family AT THE IDENTITY QUANTUM. It is integer-coordinate there and
      // deliberately NOT at a fractional quantum: the whole point of the device rule is
      // that a fractional quantum moves the band to whatever WORLD coordinate lands on
      // a whole DEVICE row, which is generally not an integer world coordinate. That
      // stronger, quantum-parameterised property is asserted in the rule block above.
      railCommands(1),
    ]) {
      for (const c of cmds) {
        for (const v of c.points) {
          expect(Number.isInteger(v), `${c.role} coordinate ${v} must be an integer`).toBe(true);
        }
      }
    }
  });

  it('keeps every emitted point inside its own tile, so no tile overhangs its neighbour', () => {
    const half = CELL / 2;
    for (const bucket of BUCKETS) {
      for (const c of straightCommands(bucket, K)) {
        const e = extentOf(c);
        expect(e.x0, `bucket ${bucket} ${c.role} left edge`).toBeGreaterThanOrEqual(-half);
        expect(e.x1, `bucket ${bucket} ${c.role} right edge`).toBeLessThanOrEqual(half);
      }
    }
  });

  // The integer property above holds because the bucket lattice divides the dash
  // period exactly. Stated as its own assertion so a future K that breaks it fails
  // HERE, naming the reason, instead of failing as an unexplained fractional
  // coordinate three cases up.
  it('derives that from K dividing the dash period exactly', () => {
    expect(BELT_DASH_PERIOD % K).toBe(0);
  });
});

describe('the straight-to-straight seam is 0px exactly (61-UI-SPEC A1 row 2)', () => {
  // Test 4 - an IDENTITY over the record, deliberately not a measurement. A sampled
  // seam is only ever as good as its sampling; this is exact.
  it('holds because CELL is a whole multiple of the dash period', () => {
    expect(BELT_DASH_PERIOD).toBe(BELT_GEOM.dash + BELT_GEOM.gap);
    expect(BELT_DASH_PERIOD).toBe(16);
    expect(CELL % BELT_DASH_PERIOD).toBe(0);
    // Which is what makes a tile's EXIT phase equal its ENTRY phase: advancing by a
    // whole cell advances the pattern by a whole number of periods, so the next tile
    // starts where this one ended and the boundary carries no jump at all.
    expect((CELL / BELT_DASH_PERIOD) % 1).toBe(0);
  });
});

describe('dashes are clipped to the tile, never dropped and never overhanging', () => {
  /** Total inked length along flow in one tile, summed off the emitted tread paths. */
  const inkedLength = (bucket: number): number =>
    treadsOf(straightCommands(bucket, K))
      .map(extentOf)
      .reduce((sum, e) => sum + (e.x1 - e.x0), 0);

  // Test 6. This is the whole seam story expressed as a conservation law, and it is
  // stronger than checking that a straddling run "exists": a dropped dash makes the
  // total short, an overhanging one makes it long, and a run split at the wrong point
  // makes it wrong at exactly one bucket.
  it('inks the same total length at every bucket, so nothing is lost at a boundary', () => {
    const expected = (CELL / BELT_DASH_PERIOD) * BELT_GEOM.dash;
    expect(expected).toBe(20);
    for (const bucket of BUCKETS) {
      expect(inkedLength(bucket), `bucket ${bucket} inked length`).toBe(expected);
    }
  });

  it('splits a straddling run so its two parts sum to one whole dash', () => {
    const half = CELL / 2;
    // Bucket 1 (phase 4) is the case that straddles BOTH edges at the shipped K: a
    // 6px stub entering and a 4px stub leaving. Because every straight tile is
    // identical, the entering stub of the next tile IS this tile's own, so the two
    // parts belong to one dash and must sum to `dash`.
    const parts = treadsOf(straightCommands(1, K)).map(extentOf);
    const entry = parts.find((e) => e.x0 === -half);
    const exit = parts.find((e) => e.x1 === half);
    expect(entry, 'bucket 1 straddles the entry edge').toBeDefined();
    expect(exit, 'bucket 1 straddles the exit edge').toBeDefined();
    const entryLen = (entry as { x0: number; x1: number }).x1 - (entry as { x0: number }).x0;
    const exitLen = (exit as { x0: number; x1: number }).x1 - (exit as { x0: number }).x0;
    expect(entryLen).toBeGreaterThan(0);
    expect(exitLen).toBeGreaterThan(0);
    expect(entryLen + exitLen).toBe(BELT_GEOM.dash);
  });

  it('inks each interior dash at its full locked run of 10px', () => {
    const half = CELL / 2;
    for (const bucket of BUCKETS) {
      const interior = treadsOf(straightCommands(bucket, K))
        .map(extentOf)
        .filter((e) => e.x0 > -half && e.x1 < half);
      expect(interior.length, `bucket ${bucket} has at least one whole dash`).toBeGreaterThan(0);
      for (const e of interior) expect(e.x1 - e.x0).toBe(BELT_GEOM.dash);
    }
  });
});

describe('the dash band across flow', () => {
  it('is 2.00px centred on the true tile centre, on the tread and on the LOD tick', () => {
    for (const cmds of [...BUCKETS.map((b) => straightCommands(b, K)), straightTickCommands()]) {
      for (const e of treadsOf(cmds).map(extentOf)) {
        expect(e.y1 - e.y0).toBe(BELT_GEOM.band);
        // Centred: the two edges are equal and opposite about the tile centre.
        expect(e.y0 + e.y1).toBe(0);
      }
    }
  });

  it('marches: a bucket change moves the dashes and nothing else', () => {
    const treadsAt = (b: number): string => JSON.stringify(treadsOf(straightCommands(b, K)));
    // THE RAILS CANNOT MOVE WITH THE BUCKET ANY MORE, because the bucket is not an
    // argument of the rail emitter at all (plan 61-09). The case is kept and restated
    // rather than deleted: "the march moves the dashes and nothing else" is still the
    // property, and it is now enforced by the SIGNATURE rather than by a comparison.
    for (const b of BUCKETS) expect(railsOf(straightCommands(b, K))).toHaveLength(0);
    // Non-vacuity for the line above: the treads really do differ, so "unchanged
    // rails" is a statement about the rails and not about a static tile.
    expect(treadsAt(1)).not.toBe(treadsAt(0));
  });
});

describe('the low-zoom LOD tick (61-UI-SPEC A10)', () => {
  it('is phase-INDEPENDENT: one mark, the same at every bucket', () => {
    const a = JSON.stringify(straightTickCommands());
    const b = JSON.stringify(straightTickCommands());
    expect(a).toBe(b);
    // And it is a DIFFERENT mark from the full tread, not the tread at lower detail -
    // it exists to survive where a 1px rail and a marching 10/6 rhythm cannot.
    expect(a).not.toBe(JSON.stringify(straightCommands(0, K)));
  });

  it('keeps the same two rails and one centred mark of CELL/2 along flow', () => {
    const cmds = straightTickCommands();
    // The tick and the full tread SHARE the one rail family (plan 61-09) - the rails
    // are drawn by a separate child object that the LOD cut does not switch, so "the
    // same two rails" is now true by there being exactly one straight rail asset.
    expect(railsOf(cmds)).toHaveLength(0);
    expect(railCommands(1)).toHaveLength(2);
    const marks = treadsOf(cmds).map(extentOf);
    expect(marks).toHaveLength(1);
    expect(marks[0].x1 - marks[0].x0).toBe(CELL / 2);
    expect(marks[0].x0 + marks[0].x1).toBe(0);
  });
});

// ===========================================================================
// THE CORNER TILE (plan 61-03) - BELT-01 .. BELT-05 and BELT-08
// ===========================================================================
//
// Everything below reads the emitted corner point lists. The corner's arc centre is
// stated here as `(-R, -R)` - the SAME construction `generators.ts` computes as
// `(CELL/2 - R, CELL/2 - R)` in corner-origin coordinates - and is never assumed to be
// the tile corner. Whether it IS the tile corner is exactly what the first block
// below tests, and the answer is "only at R = CELL/2".

/** The corner's arc centre in tile-local, centre-origin coordinates. */
const ARC_C = (R: number): { x: number; y: number } => ({ x: -R, y: -R });

/** The two tile-edge midpoints a corner's centreline must arrive at and leave from. */
const EDGE_MIDPOINTS: ReadonlyArray<{ x: number; y: number }> = [
  { x: 0, y: -CELL / 2 }, // the north edge midpoint: where the entering straight arrives
  { x: -CELL / 2, y: 0 }, // the west edge midpoint: where the leaving straight departs
];

/**
 * Where the quarter arc's two TANGENT POINTS land, at an arbitrary radius, under the
 * shipped construction. Entry is at theta 0, exit at theta 90.
 */
const tangentsOf = (R: number): Array<{ x: number; y: number }> => {
  const c = ARC_C(R);
  return [
    { x: c.x + R, y: c.y },
    { x: c.x, y: c.y + R },
  ];
};

/** THE PROPERTY. Do the tangents land ON the tile-edge midpoints at this radius? */
const tangentsLandOnEdgeMidpoints = (R: number): boolean =>
  tangentsOf(R).every((p, i) => p.x === EDGE_MIDPOINTS[i].x && p.y === EDGE_MIDPOINTS[i].y);

/** Every point of one command as `{x, y}` pairs, read off the flat list. */
const pointsOf = (c: BeltPathCommand): Array<{ x: number; y: number }> => {
  const out: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < c.points.length; i += 2) out.push({ x: c.points[i], y: c.points[i + 1] });
  return out;
};

/** One point's radius from the corner's arc centre. */
const radiusOf = (p: { x: number; y: number }, R: number): number => {
  const c = ARC_C(R);
  return Math.hypot(p.x - c.x, p.y - c.y);
};

/** One point's polar angle about the arc centre, in `[0, pi/2]` on a cw corner. */
const thetaOf = (p: { x: number; y: number }, R: number): number => {
  const c = ARC_C(R);
  return Math.atan2(p.y - c.y, p.x - c.x);
};

/** Summed chord length of a point run - the drawn arc length of that edge. */
const chordSum = (pts: Array<{ x: number; y: number }>): number => {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return s;
};

/**
 * Split one emitted dash sector into its OUTER edge and its INNER edge, in the
 * emission order the module documents: `n + 1` outer points from t0 to t1, then the
 * same count of inner points from t1 back to t0.
 */
const edgesOf = (c: BeltPathCommand): {
  outer: Array<{ x: number; y: number }>;
  inner: Array<{ x: number; y: number }>;
} => {
  const pts = pointsOf(c);
  const half = pts.length / 2;
  return { outer: pts.slice(0, half), inner: pts.slice(half).reverse() };
};

const R = BELT_GEOM.elbowR;
const CHIRALITIES = ['cw', 'ccw'] as const;

/**
 * Undo the `'ccw'` x-mirror so a polar measurement can be taken in the canonical
 * frame. Applied EXPLICITLY at every call site rather than folded into the helpers,
 * because a measurement that silently un-mirrored would stop being a measurement of
 * the drawn ccw geometry and become one of the cw geometry it was derived from.
 */
const unmirror = (
  p: { x: number; y: number },
  chirality: 'cw' | 'ccw',
): { x: number; y: number } => (chirality === 'ccw' ? { x: -p.x, y: p.y } : p);

/** The arc-length span `[s0, s1]` one emitted dash sector covers, read off its points. */
const spanOf = (c: BeltPathCommand, chirality: 'cw' | 'ccw' = 'cw'): { s0: number; s1: number } => {
  const { outer } = edgesOf(c);
  return {
    s0: R * thetaOf(unmirror(outer[0], chirality), R),
    s1: R * thetaOf(unmirror(outer[outer.length - 1], chirality), R),
  };
};

describe('R = 16 puts the arc centre on the tile corner and the tangents ON the edge midpoints (BELT-08)', () => {
  // Test 1a - THE SUPERSESSION'S REQUIRED VERIFICATION, as an executable identity over
  // the record rather than a citation of 61-UI-SPEC A3.
  it('lands the arc centre exactly on the tile corner at the shipped radius', () => {
    expect(CELL / 2 - R).toBe(0);
    expect(ARC_C(R)).toEqual({ x: -CELL / 2, y: -CELL / 2 });
    expect(tangentsOf(R)).toEqual([...EDGE_MIDPOINTS]);
    expect(tangentsLandOnEdgeMidpoints(R)).toBe(true);
  });

  // Test 1b - THE DISCRIMINATOR. Without this the case above is a tautology: a
  // derivation-only assertion agrees with itself at every radius. Four NEIGHBOURING
  // candidates are required to fail, including 15 - the value 53-BELT-LOCK.md locked
  // and the supersession lifts - because 15 is the one a revert would reach for.
  it('fails at every neighbouring radius, 15 included, so the property is not vacuous', () => {
    for (const candidate of [13, 14, 15, 17, 18]) {
      expect(
        tangentsLandOnEdgeMidpoints(candidate),
        `radius ${candidate} must NOT put the tangents on the tile-edge midpoints`,
      ).toBe(false);
    }
    // At 15 specifically the miss is one pixel at EVERY join, on both tangents - the
    // shipped defect this plan removes, stated as a number rather than as a claim.
    const missAt15 = tangentsOf(15).map((p, i) => Math.hypot(p.x - EDGE_MIDPOINTS[i].x, p.y - EDGE_MIDPOINTS[i].y));
    expect(missAt15).toEqual([1, 1]);
  });

  // Test 1c - PHASE 53'S STATED REASON, INVERTED. Its ceiling existed "so the arc
  // tangents fall inside the tile". They do at 16 as well - so that constraint never
  // discriminated, and the one that does is the midpoint landing above.
  it('keeps every drawn point inside the tile at 16, so the old ceiling lifts cleanly', () => {
    const half = CELL / 2;
    for (const chirality of CHIRALITIES) {
      for (const cmds of [...[0, 1, 2, 3].map((b) => cornerCommands(b, 4, chirality)), cornerTickCommands(chirality)]) {
        for (const c of cmds) {
          for (const p of pointsOf(c)) {
            expect(Math.abs(p.x), `${chirality} ${c.role} x=${p.x}`).toBeLessThanOrEqual(half + 1e-9);
            expect(Math.abs(p.y), `${chirality} ${c.role} y=${p.y}`).toBeLessThanOrEqual(half + 1e-9);
          }
        }
      }
    }
  });

  // Test 1d - MEASURED off the emitted geometry, not derived: the drawn CENTRELINE
  // (recovered as the mean of the two drawn rail arcs) begins and ends exactly on the
  // tile-edge midpoints, which is where a neighbouring straight's centreline arrives.
  it('starts and ends the DRAWN centreline on the two tile-edge midpoints', () => {
    // Read at the IDENTITY quantum, where the device rule contributes no overhang. The
    // tangent-landing property is about the RADIUS and the tile, so it is stated where
    // the sweep is exactly the quarter turn; the extended sweep at a fractional quantum
    // is the seam fix and is gated on its own terms.
    const rails = cornerRailCommands(ARC_SAMPLES, 1, 'cw').map(pointsOf);
    expect(rails).toHaveLength(2);
    const mid = (i: number): { x: number; y: number } => ({
      x: (rails[0][i].x + rails[1][i].x) / 2,
      y: (rails[0][i].y + rails[1][i].y) / 2,
    });
    const entry = mid(0);
    const exit = mid(rails[0].length - 1);
    expect(entry.x).toBeCloseTo(EDGE_MIDPOINTS[0].x, 12);
    expect(entry.y).toBeCloseTo(EDGE_MIDPOINTS[0].y, 12);
    expect(exit.x).toBeCloseTo(EDGE_MIDPOINTS[1].x, 12);
    expect(exit.y).toBeCloseTo(EDGE_MIDPOINTS[1].y, 12);
  });
});

describe('the along-flow parameter is arc length on the CENTRELINE radius (BELT-01)', () => {
  // Test 2 - the property that makes the tread read as one bar rather than a sheared
  // spiral. Both bounding angles of a sector come from ONE division by the centreline
  // radius, so the two band edges differ in drawn length by EXACTLY the ratio of their
  // radii and by nothing else. A per-point-radius formulation cannot produce this
  // ratio: its level sets are hyperbolic spirals and the two edges come out parallel.
  it('draws the two band edges at exactly the ratio of the two band radii', () => {
    const ri = R - BELT_GEOM.band / 2; // 15
    const ro = R + BELT_GEOM.band / 2; // 17
    let checked = 0;
    for (let bucket = 0; bucket < 12; bucket++) {
      for (const c of treadsOf(cornerCommands(bucket, 12, 'cw'))) {
        const { outer, inner } = edgesOf(c);
        expect(chordSum(inner) / chordSum(outer)).toBeCloseTo(ri / ro, 12);
        checked++;
      }
    }
    expect(checked, 'the sweep really did see sectors').toBeGreaterThan(12);
  });

  // Test 2b - THE A5 SUBSTITUTION, gated in the place of the axis-6 "3.75px inner-rail
  // dash" that is not a drawn element at the locked art (61-UI-SPEC A5). The drawn
  // dash's own arc length varies across its own 2px band: 9.375px at the inner edge
  // against 10.625px at the outer, an exact +/- 6.25% about the centreline's 10.000.
  it('measures the drawn dash at 9.375 / 10.000 / 10.625 px across its own 2px band', () => {
    // A whole interior dash, taken at a bucket where nothing is clipped.
    const whole = treadsOf(cornerCommands(0, 4, 'cw')).find((c) => {
      const { outer } = edgesOf(c);
      const t0 = thetaOf(outer[0], R);
      const t1 = thetaOf(outer[outer.length - 1], R);
      return R * t0 > 1e-9 || R * (t1 - t0) > BELT_GEOM.dash - 1e-9;
    });
    expect(whole, 'a whole 10px dash exists at bucket 0').toBeDefined();
    const { outer, inner } = edgesOf(whole as BeltPathCommand);
    // Chord sums under-report a sampled arc very slightly; the contract is the ratio,
    // so the absolute figures are asserted to 2dp and the ratio to 12.
    expect(chordSum(inner)).toBeCloseTo(9.375, 2);
    expect(chordSum(outer)).toBeCloseTo(10.625, 2);
    expect(chordSum(inner) / chordSum(outer)).toBeCloseTo(15 / 17, 12);
  });
});

describe('the tread paces at 1.000x through the bend (BELT-01, 61-UI-SPEC A1 row 1)', () => {
  /**
   * Every dash LEADING EDGE the corner draws, at K = 32, in arc length along the drawn
   * centreline - recovered from the emitted points by `s = R * atan2(...)`, never read
   * back off the schedule that produced them.
   *
   * A run clipped by the tile's entry tangent starts at theta 0 and is NOT a leading
   * edge (its real one belongs to the upstream tile), so those are dropped.
   */
  const leadingEdges = (): number[] => {
    const seen = new Set<number>();
    for (let bucket = 0; bucket < 32; bucket++) {
      for (const c of treadsOf(cornerCommands(bucket, 32, 'cw'))) {
        const s = R * thetaOf(edgesOf(c).outer[0], R);
        if (s <= 1e-9) continue;
        seen.add(Number(s.toFixed(9)));
      }
    }
    return [...seen].sort((a, b) => a - b);
  };

  // Test 3 - THE PACE GATE. 32 buckets slide the pattern along the bend in equal
  // ARC-LENGTH steps, so the drawn leading edges sample the whole quarter arc at 32
  // steps per dash period. The step between consecutive drawn edges is the dash period
  // divided by 32, MEASURED at every position along the bend; max/min <= 1.01 is the
  // contract. The shipped raster corner fails it at 1.414: its `u = dx - dy` parameter
  // advances at `sin t + cos t` per unit arc length, which peaks at the bend midpoint.
  it('spaces its drawn dash edges evenly in ARC LENGTH at 32 steps through the corner', () => {
    const edges = leadingEdges();
    expect(edges.length, 'the 32-bucket sweep samples the whole arc').toBeGreaterThanOrEqual(48);
    const gaps: number[] = [];
    for (let i = 1; i < edges.length; i++) gaps.push(edges[i] - edges[i - 1]);
    const max = Math.max(...gaps);
    const min = Math.min(...gaps);
    expect(max / min, `pace ratio over ${gaps.length} measured steps`).toBeLessThanOrEqual(1.01);
    // ... and the step is the dash period over 32, so the even spacing is the RIGHT
    // spacing rather than merely a consistent wrong one.
    expect(min).toBeCloseTo(BELT_DASH_PERIOD / 32, 6);
    // The sweep really does reach both ends of the bend, so "even" is a statement about
    // the whole arc and not about its middle.
    expect(edges[0]).toBeLessThan(1);
    expect(edges[edges.length - 1]).toBeGreaterThan(CORNER_ARC_LENGTH - 1);
  });
});

describe('the corner tread marches ALONG FLOW, not against it (BELT-01 direction)', () => {
  /**
   * WHY THIS BLOCK EXISTS, AND WHY NOTHING ABOVE IT CAUGHT WHAT IT PINS.
   *
   * From plan 61-03 until this block was written, the corner's dash walk marched
   * BACKWARDS - ink retreated toward the bend's entry while the neighbouring straight's
   * ink advanced toward its exit. It shipped, and the whole suite stayed green, because
   * NO TEST HERE DREW AT TWO DIFFERENT CLOCKS AND COMPARED POSITIONS:
   *
   *   - The closed-form clip test restates the emitter's OWN dash predicate, so it
   *     agrees with the emitter at either direction. It is the file's own recorded
   *     counter-rule ("a derivation-only suite agrees with itself at ANY value") in
   *     geometric form.
   *   - The pace gate above sorts its leading edges into a `Set`, which DISCARDS the
   *     order they were produced in - it measures the SPACING of the sweep and is blind
   *     to its SIGN by construction.
   *
   * So the assertion had to be the one shape neither of those is: a SIGNED, per-bucket
   * DIFFERENCE. It is stated in each emitter's own parameter, because the defect was a
   * frame confusion and stating it in a normalized along-flow coordinate would hide the
   * very thing that went wrong.
   *
   * THE TWO PARAMETERS RUN OPPOSITE WAYS, AND THAT IS THE WHOLE POINT:
   *
   *   - The STRAIGHT's parameter is `a = x + HALF`. Native flow is WEST (`belts.ts`
   *     sends dir=W to zero quarter turns), so `a = 0` is the tile's EXIT edge and `a`
   *     DECREASES along flow. Its dash starts therefore advance by MINUS one step.
   *   - The CORNER's parameter is `s = R * theta`. `s = 0` is the north-edge tangent,
   *     where the tangent heading is SOUTH - the native `from = S` ENTRY - so `s`
   *     INCREASES along flow. Its dash starts advance by PLUS one step.
   *
   * Writing the straight's expression into the corner's loop - which is literally what
   * 61-03 did - therefore reverses the corner while looking correct beside its source.
   * The straight arm below is a POSITIVE CONTROL: it proves this recipe can read a
   * direction at all, so the corner arm's sign is a measurement and not a coincidence.
   */

  // A TEST VALUE, NOT A SPEED. K is the pattern's bucket quantization; how fast the
  // belt actually marches is the maintainers' to set at the sitting (D-19) and no assertion
  // here touches it. 32 is chosen only because it makes one step exactly 0.5px.
  const K_DIR = 32;
  const STEP = BELT_DASH_PERIOD / K_DIR;

  const eucModLocal = (n: number, m: number): number => ((n % m) + m) % m;

  /**
   * The lowest dash start this tile draws that is NOT clipped by the tile's own entry
   * edge, in the emitter's OWN parameter.
   *
   * Clipped runs are excluded because their start is pinned to the edge by the clamp
   * and so cannot move with the clock - including them would average a moving quantity
   * with a stationary one and blunt the very difference being measured.
   */
  const lowestInteriorCornerStart = (bucket: number): number =>
    Math.min(
      ...treadsOf(cornerCommands(bucket, K_DIR, 'cw'))
        .map((c) => spanOf(c).s0)
        .filter((s) => s > 1e-9),
    );

  const lowestInteriorStraightStart = (bucket: number): number =>
    Math.min(
      ...treadsOf(straightCommands(bucket, K_DIR))
        .map((c) => c.points[0] + CELL / 2)
        .filter((a) => a > 1e-9),
    );

  /**
   * Per-bucket advances, read modulo the dash period so the wrap that happens when a
   * fresh dash enters the tile is not mistaken for a direction reversal.
   */
  const advances = (at: (bucket: number) => number): number[] => {
    const out: number[] = [];
    for (let b = 1; b <= K_DIR; b++) out.push(eucModLocal(at(b) - at(b - 1), BELT_DASH_PERIOD));
    return out;
  };

  it('advances its dash starts by +period/K per bucket, toward the bend EXIT', () => {
    const seen = advances(lowestInteriorCornerStart);
    for (const d of seen) {
      expect(
        d,
        `corner advance per bucket (a value of ${(BELT_DASH_PERIOD - STEP).toFixed(3)} is the ` +
          `pre-fix REVERSED march, i.e. -${STEP} px/bucket)`,
      ).toBeCloseTo(STEP, 9);
    }
  });

  it('POSITIVE CONTROL: the straight advances by -period/K in its own opposite frame', () => {
    const seen = advances(lowestInteriorStraightStart);
    for (const d of seen) {
      expect(d, 'straight advance per bucket, in a parameter that runs against flow').toBeCloseTo(
        eucModLocal(-STEP, BELT_DASH_PERIOD),
        9,
      );
    }
  });

  /**
   * THE CONSEQUENCE, AND THE INDEPENDENT WITNESS.
   *
   * Direction alone does not fix a junction: a corner marching the right way but offset
   * by a constant would still double its ink at the seam. This measures the belt the
   * way it is actually assembled - two tiles, each at the bucket its OWN
   * `tailOffsets` entry earns it - and merges their drawn ink into one along-flow line.
   *
   * The law: a belt is one continuous dash pattern, so NO junction may carry more than
   * a single dash of unbroken ink. Before the direction fix the corner ENTRY measured
   * 20.000px of solid ink (two whole dashes fused across the seam) and the EXIT
   * measured 17.133px, against a 10px dash.
   */
  const junctionRun = (order: 'straight-then-corner' | 'corner-then-straight'): number => {
    const lens =
      order === 'straight-then-corner' ? [CELL, CORNER_ARC_LENGTH] : [CORNER_ARC_LENGTH, CELL];
    const offsets = [0, lens[0]];
    const junction = lens[0];
    let worst = 0;
    // Sweep a whole dash period of march distance at 1/100px, so every bucket pairing
    // the two tiles can be in is visited many times over.
    for (let d = 0; d < BELT_DASH_PERIOD; d += 0.01) {
      const spans: Array<[number, number]> = [];
      for (let i = 0; i < 2; i++) {
        const isCorner = order === 'straight-then-corner' ? i === 1 : i === 0;
        // pxPerTick = 1 makes `d` read directly as march distance; the belt's real rate
        // is not a term here (D-19).
        const b = bucketOf(d, offsets[i], BELT_MARCH_BUCKETS, 1);
        if (isCorner) {
          for (const c of treadsOf(cornerCommands(b, BELT_MARCH_BUCKETS, 'cw'))) {
            const { s0, s1 } = spanOf(c);
            spans.push([offsets[i] + s0, offsets[i] + s1]);
          }
        } else {
          for (const c of treadsOf(straightCommands(b, BELT_MARCH_BUCKETS))) {
            // Into along-flow: `a` runs against flow, so u = CELL - a.
            const a0 = c.points[0] + CELL / 2;
            const a1 = c.points[2] + CELL / 2;
            spans.push([offsets[i] + CELL - a1, offsets[i] + CELL - a0]);
          }
        }
      }
      spans.sort((x, y) => x[0] - y[0]);
      const merged: Array<[number, number]> = [];
      for (const [a, b] of spans) {
        const last = merged[merged.length - 1];
        if (last && a <= last[1] + 1e-6) last[1] = Math.max(last[1], b);
        else merged.push([a, b]);
      }
      for (const [a, b] of merged) {
        if (a <= junction + 1e-6 && b >= junction - 1e-6) worst = Math.max(worst, b - a);
      }
    }
    return worst;
  };

  // The bucket quantization is the only slack the law allows, and the bound is ONE
  // WHOLE BUCKET rather than the half-bucket a single tile is off by. Two neighbouring
  // tiles round their own phase independently and may round in OPPOSITE directions, so
  // the relative error across the seam is the sum of two half-bucket errors. Derived,
  // not fitted - and the two junctions land either side of it for a reason worth
  // recording: the ENTRY seam measures exactly 10.000, because a straight is 32px and
  // 32 is a whole 2 periods, so both tiles quantize the SAME residue and cannot
  // disagree at all. The EXIT seam measures 11.133, because a corner is 25.132741px and
  // the downstream straight's tail offset is therefore not period-aligned. That
  // irrational-length junction is the only place the allowance is actually spent.
  const SEAM_SLACK = bucketSizePx(BELT_MARCH_BUCKETS);

  it('fuses no more than one dash of ink across the corner ENTRY junction', () => {
    expect(junctionRun('straight-then-corner')).toBeLessThanOrEqual(
      BELT_GEOM.dash + SEAM_SLACK + 1e-6,
    );
  });

  it('fuses no more than one dash of ink across the corner EXIT junction', () => {
    expect(junctionRun('corner-then-straight')).toBeLessThanOrEqual(
      BELT_GEOM.dash + SEAM_SLACK + 1e-6,
    );
  });
});

describe("a corner's along-flow length is the quarter arc, not a whole tile (BELT-02)", () => {
  // Test 4. The literal pin lives here and nowhere else in the corner half of this file.
  it('runs 25.132741px against a straight tile\'s 32.000px', () => {
    expect(BELT_GEOM.elbowR).toBe(16); // THE LITERAL PIN - 61-BELT-LOCK-SUPERSESSION.md
    expect(CORNER_ARC_LENGTH).toBeCloseTo(25.132741, 6);
    expect(CORNER_ARC_LENGTH).toBe((BELT_GEOM.elbowR * Math.PI) / 2);
    expect(CELL).toBe(32);
    // Measured on the drawn geometry: the centreline's own swept angle is a quarter
    // turn, so its drawn length is the quarter arc and not the tile's 32px.
    const rails = cornerRailCommands(ARC_SAMPLES, 1, 'cw').map(pointsOf);
    const swept = thetaOf(rails[0][rails[0].length - 1], R) - thetaOf(rails[0][0], R);
    expect(swept).toBeCloseTo(Math.PI / 2, 12);
    // ... and the raster bake's `u = dx - dy` span, 2R = 32, is the wrong answer by
    // 27%. Stated so the correction is a number rather than an adjective.
    expect(2 * R - CORNER_ARC_LENGTH).toBeCloseTo(6.867259, 6);
  });
});

describe('every dash end cap through the bend is RADIAL (BELT-03)', () => {
  /** The angle, in degrees, between a cap segment and the radial direction at `t`. */
  const capDeviationDeg = (
    from: { x: number; y: number },
    to: { x: number; y: number },
    t: number,
  ): number => {
    const vx = to.x - from.x;
    const vy = to.y - from.y;
    const len = Math.hypot(vx, vy);
    const cross = (vx / len) * Math.sin(t) - (vy / len) * Math.cos(t);
    const dot = (vx / len) * Math.cos(t) + (vy / len) * Math.sin(t);
    const deg = (Math.abs(Math.atan2(cross, dot)) * 180) / Math.PI;
    // A cap is an UNDIRECTED segment and the two caps of a sector are walked in
    // opposite senses by the emission order, so an anti-parallel cap is the same
    // radial line. Fold onto [0, 90]: what is asserted is that the cap lies ALONG the
    // radial direction, which is the flow normal, exactly as 61-UI-SPEC A1 row 3 puts
    // it. Without the fold one of the two caps reads 180.00 and the case would have
    // been "fixed" by dropping it - which would have halved the coverage.
    return Math.min(deg, 180 - deg);
  };

  // Test 5 - asserted as an IDENTITY over the emitted points, never as a pixel
  // measurement. Every cap of every sector at every bucket, which necessarily includes
  // both tangent points and the arc midpoint; those three are then named separately so
  // the 61-UI-SPEC A1 row 3 contract is checked in its own words too.
  it('holds 0.00 degrees at every cap of every sector, at every bucket', () => {
    let caps = 0;
    for (const chirality of CHIRALITIES) {
      for (let bucket = 0; bucket < 12; bucket++) {
        for (const c of treadsOf(cornerCommands(bucket, 12, chirality))) {
          const { outer, inner } = edgesOf(c);
          const n = outer.length - 1;
          // On the mirrored chirality the radial direction mirrors with the points, so
          // the deviation is measured against the MIRRORED radial - which is what makes
          // this a property of the drawn shape rather than of the canonical one.
          const sx = chirality === 'ccw' ? -1 : 1;
          for (const [a, b, t] of [
            [inner[0], outer[0], thetaOf({ x: sx * outer[0].x, y: outer[0].y }, R)],
            [outer[n], inner[n], thetaOf({ x: sx * outer[n].x, y: outer[n].y }, R)],
          ] as const) {
            expect(
              capDeviationDeg({ x: sx * a.x, y: a.y }, { x: sx * b.x, y: b.y }, t as number),
              `${chirality} bucket ${bucket} cap`,
            ).toBeLessThan(1e-9);
            caps++;
          }
        }
      }
    }
    expect(caps, 'the sweep really did measure caps').toBeGreaterThan(40);
  });

  it('names the three positions 61-UI-SPEC A1 row 3 requires: both tangents and the midpoint', () => {
    // Phase 10 puts a cap exactly ON the entry tangent (theta 0) - bucket 5 of 8. The
    // exit tangent is reached by the clipped tail of the last run. The midpoint is
    // covered by any cap inside the sweep; one is located explicitly rather than
    // assumed.
    //
    // THIS USED TO READ BUCKET 0 OF 4, and the change is a consequence of the corner's
    // direction fix rather than a weakening. The walk now starts at `phase - dash`, so
    // the phase that lands a dash start on the entry tangent moved from 0 to `dash`;
    // bucket 0 now opens its first interior run at theta 0.375 instead. All three named
    // positions are still required, and still measured off the drawn points - only the
    // bucket that realizes the first of them moved, because the phase origin did.
    const sectors = treadsOf(cornerCommands(5, 8, 'cw'));
    const thetas = sectors.flatMap((c) => {
      const { outer } = edgesOf(c);
      return [thetaOf(outer[0], R), thetaOf(outer[outer.length - 1], R)];
    });
    expect(Math.min(...thetas)).toBeCloseTo(0, 12); // the ENTRY tangent
    expect(Math.max(...thetas)).toBeCloseTo(Math.PI / 2, 12); // the EXIT tangent
    // A cap strictly inside the bend, on the far side of the arc midpoint from entry.
    expect(thetas.some((t) => t > Math.PI / 4 && t < Math.PI / 2)).toBe(true);
  });
});

describe('the inner-radius-to-lane ratio is 0.300 (BELT-04)', () => {
  // Test 6 - asserted from the geometry RECORD, never measured off pixels: it is an
  // arithmetic fact about the lock, and 61-UI-SPEC A1 row 4 says so in those words.
  it('sits at 6 / 20 = 0.300, inside the 0.25 to 0.35 target band', () => {
    const lane = 2 * BELT_GEOM.laneHalf;
    const innerRadius = BELT_GEOM.elbowR - BELT_GEOM.laneHalf;
    expect(innerRadius).toBe(6);
    expect(lane).toBe(20);
    expect(innerRadius / lane).toBeCloseTo(0.3, 12);
    expect(innerRadius / lane).toBeGreaterThanOrEqual(0.25);
    expect(innerRadius / lane).toBeLessThanOrEqual(0.35);
    // The axis-3 joint guard survives the supersession with one bound moved: the
    // clause that binds is still `rail < laneHalf <= elbowR`, now at +6 rather than
    // +1 - further from the degenerate quarter-disc boundary than the locked value was.
    expect(BELT_GEOM.rail).toBeLessThan(BELT_GEOM.laneHalf);
    expect(BELT_GEOM.laneHalf).toBeLessThanOrEqual(BELT_GEOM.elbowR);
    expect(BELT_GEOM.elbowR - BELT_GEOM.laneHalf).toBe(6);
  });
});

describe('the lane does not pinch: straight 20.00, swept corner 20.00 (BELT-05)', () => {
  /**
   * The corner lane, MEASURED off the emitted rail arcs: the radial span between the
   * two drawn rails' OUTER edges. The rails are strokes, so their drawn edges sit half
   * a rail width either side of the sampled radius - the same expansion the straight's
   * filled rectangles carry in their own point list.
   */
  const cornerLane = (chirality: 'cw' | 'ccw'): number => {
    const radii = cornerRailCommands(ARC_SAMPLES, 1, chirality).flatMap((c) =>
      pointsOf(c).map((p) => radiusOf({ x: chirality === 'ccw' ? -p.x : p.x, y: p.y }, R)),
    );
    return Math.max(...radii) + BELT_GEOM.rail / 2 - (Math.min(...radii) - BELT_GEOM.rail / 2);
  };

  // Test 7 - BOTH as a measurement AND as an identity, so a record change and a
  // geometry change cannot cancel each other out.
  it('measures 20.00 on both, and states the same number as the record identity', () => {
    const straightRails = railCommands(1).map(extentOf);
    const straightLane =
      Math.max(...straightRails.map((e) => e.y1)) - Math.min(...straightRails.map((e) => e.y0));
    expect(straightLane).toBe(20);
    for (const chirality of CHIRALITIES) {
      expect(cornerLane(chirality), `${chirality} corner lane`).toBeCloseTo(20, 9);
    }
    // THE PINCH IS ZERO, measured like for like...
    expect(straightLane - cornerLane('cw')).toBeCloseTo(0, 9);
    // ... and the identity over the record that says why it must be.
    expect(straightLane).toBe(2 * BELT_GEOM.laneHalf);
    expect(cornerLane('cw')).toBeCloseTo(2 * BELT_GEOM.laneHalf, 9);
    // The shipped raster corner pinched by 4px (28 against 32) - the defect removed.
    expect(2 * BELT_GEOM.laneHalf - 20).toBe(0);
  });

  it('puts all four corner rail edges on the integer radii 6, 7, 25 and 26', () => {
    // 61-UI-SPEC A2: every belt edge is an integer in tile-local world px, on the
    // corner as radii and on the straight as coordinates. This is what lets
    // `antialias: false` stay honest on the first live vector arc the project ships.
    const sampled = cornerRailCommands(ARC_SAMPLES, 1, 'cw').map((c) =>
      pointsOf(c).map((p) => radiusOf(p, R)),
    );
    const edges = sampled
      .flatMap((rs) => {
        const r = rs[0];
        for (const other of rs) expect(other).toBeCloseTo(r, 9); // a rail IS an arc
        return [r - BELT_GEOM.rail / 2, r + BELT_GEOM.rail / 2];
      })
      .sort((a, b) => a - b);
    expect(edges.map((e) => Math.round(e * 1e9) / 1e9)).toEqual([6, 7, 25, 26]);
  });
});

describe('the corner band is 2.00 across flow, equal to the straight (61-UI-SPEC A4)', () => {
  // Test 8 - the raster bake's 3px corner band was a property of integer pixel ROWS and
  // does NOT survive VEC-01. The note forbidding a 2px corner band was deleted with the
  // bake rather than paraphrased into the vector module, and this is the assertion that
  // records the deletion as a decision.
  it('measures 2.00 with no odd-radial-pixel carry-forward, at every bucket', () => {
    for (let bucket = 0; bucket < 12; bucket++) {
      for (const c of treadsOf(cornerCommands(bucket, 12, 'cw'))) {
        const radii = pointsOf(c).map((p) => radiusOf(p, R));
        expect(Math.max(...radii) - Math.min(...radii)).toBeCloseTo(BELT_GEOM.band, 9);
        expect(Math.max(...radii) - Math.min(...radii)).toBeCloseTo(2, 9);
      }
    }
    // ... and the straight's band, measured the same way, is the same number.
    for (const e of treadsOf(straightCommands(0, 4)).map(extentOf)) {
      expect(e.y1 - e.y0).toBe(2);
    }
  });

  it('centres that band on the centreline radius, so the sector is symmetric about R', () => {
    for (const c of treadsOf(cornerCommands(0, 4, 'cw'))) {
      const radii = pointsOf(c).map((p) => radiusOf(p, R));
      expect(Math.min(...radii) + Math.max(...radii)).toBeCloseTo(2 * R, 9);
    }
  });
});

describe('the corner tile as a whole', () => {
  it('clips its dashes to the arc, never dropping one and never overhanging', () => {
    // THE STRAIGHT'S CONSERVATION LAW DOES NOT TRANSFER, and saying so is the point of
    // this comment. A straight tile inks the same total at every bucket because CELL is
    // a whole multiple of the dash period; the quarter arc is 25.132741, which is 1.5708
    // periods, so a corner's inked total LEGITIMATELY varies with phase and the
    // neighbouring tiles carry the remainder. Asserting a constant here would have been
    // a wrong law that the correct geometry fails.
    //
    // The transferable statement is the CLOSED FORM: the drawn ink at arc length `s` is
    // exactly the shipped dash predicate at `s`, densely sampled. A dropped run, an
    // overhanging one, or a run split at the wrong point all break it.
    for (let bucket = 0; bucket < 12; bucket++) {
      const phase = (bucket * BELT_DASH_PERIOD) / 12;
      const spans = treadsOf(cornerCommands(bucket, 12, 'cw')).map((c) => spanOf(c));
      let sampled = 0;
      for (let k = 0; k < 2000; k++) {
        const s = (CORNER_ARC_LENGTH * (k + 0.5)) / 2000;
        // `phase - s`, NOT `phase + s`: the corner's `s` increases along flow, so its
        // ink advances WITH the phase. This read `s + phase` while the emitter marched
        // backwards, and the two agreed - which is precisely why this test could not
        // see the defect and the signed gate above had to be written.
        const residue = ((((phase - s) % BELT_DASH_PERIOD) + BELT_DASH_PERIOD) % BELT_DASH_PERIOD);
        // Skip samples sitting on a boundary, where a float comparison decides nothing.
        if (Math.abs(residue) < 1e-6 || Math.abs(residue - BELT_GEOM.dash) < 1e-6) continue;
        const want = residue < BELT_GEOM.dash;
        const got = spans.some((sp) => s >= sp.s0 - 1e-9 && s <= sp.s1 + 1e-9);
        expect(got, `bucket ${bucket} at s=${s.toFixed(4)}`).toBe(want);
        sampled++;
      }
      expect(sampled).toBeGreaterThan(1900);
    }
  });

  it('inks every interior run at the locked 10px and every interior gap at 6px', () => {
    // The complement of the case above, in the lock's own units: a run that touches
    // neither tangent point is a WHOLE dash, and the clear space between two drawn runs
    // is a WHOLE gap - both measured in arc length off the drawn sectors.
    let wholeRuns = 0;
    let wholeGaps = 0;
    for (let bucket = 0; bucket < 12; bucket++) {
      const spans = treadsOf(cornerCommands(bucket, 12, 'cw'))
        .map((c) => spanOf(c))
        .sort((a, b) => a.s0 - b.s0);
      for (const sp of spans) {
        expect(sp.s0).toBeGreaterThanOrEqual(-1e-9);
        expect(sp.s1).toBeLessThanOrEqual(CORNER_ARC_LENGTH + 1e-9);
        expect(sp.s1 - sp.s0).toBeLessThanOrEqual(BELT_GEOM.dash + 1e-9);
        if (sp.s0 > 1e-9 && sp.s1 < CORNER_ARC_LENGTH - 1e-9) {
          expect(sp.s1 - sp.s0, `bucket ${bucket} interior run`).toBeCloseTo(BELT_GEOM.dash, 9);
          wholeRuns++;
        }
      }
      for (let i = 1; i < spans.length; i++) {
        expect(spans[i].s0 - spans[i - 1].s1, `bucket ${bucket} gap`).toBeCloseTo(BELT_GEOM.gap, 9);
        wholeGaps++;
      }
    }
    expect(wholeRuns, 'the sweep saw whole interior runs').toBeGreaterThan(4);
    expect(wholeGaps, 'the sweep saw whole interior gaps').toBeGreaterThan(4);
  });

  it('mirrors the two chiralities in x and in nothing else', () => {
    const cw = cornerCommands(1, 4, 'cw');
    const ccw = cornerCommands(1, 4, 'ccw');
    expect(ccw).toHaveLength(cw.length);
    for (let i = 0; i < cw.length; i++) {
      expect(ccw[i].role).toBe(cw[i].role);
      expect(ccw[i].close).toBe(cw[i].close);
      expect(ccw[i].points.map((v, j) => (j % 2 === 0 ? -v : v))).toEqual([...cw[i].points]);
    }
    // Non-vacuity: a mirror is NOT the identity, so the two really are different bakes
    // (a 90-degree whole-sprite rotation reaches only 4 of the 8 (from,to) corners).
    expect(JSON.stringify(ccw)).not.toBe(JSON.stringify(cw));
  });

  it('marches: a bucket change moves the dashes and leaves the rail arcs alone', () => {
    // The corner rails cannot move with the bucket any more, because the bucket is not
    // an argument of their emitter at all (plan 61-09) - the property is enforced by
    // the SIGNATURE now rather than by a comparison across buckets.
    for (let b = 0; b < 12; b++) expect(railsOf(cornerCommands(b, 12, 'cw'))).toHaveLength(0);
    expect(JSON.stringify(treadsOf(cornerCommands(1, 12, 'cw')))).not.toBe(
      JSON.stringify(treadsOf(cornerCommands(0, 12, 'cw'))),
    );
  });

  it('samples every arc at the measured ARC_SAMPLES = 24 and reaches no Pixi curve', () => {
    // The sample count is a MEASUREMENT (61-RESEARCH FINDING 1 / Pattern 6): 0.11
    // device px of chord error at the maximum device scale, and the largest count that
    // stays inside the batching budget at every bucket (28 enters the warn band).
    expect(ARC_SAMPLES).toBe(24);
    for (const c of cornerRailCommands(ARC_SAMPLES, 1, 'cw')) {
      expect(pointsOf(c)).toHaveLength(ARC_SAMPLES + 1);
    }
    // The LOW-ZOOM cue is a different asset drawn at a different size and carries its
    // own measured count: it is only ever selected below 24 device px per tile, where
    // 12 samples hold 0.027 device px of chord error, and it is the largest single
    // sector the module emits (the WHOLE quarter arc as one closed band). At 24 it
    // measured exactly 300 tessellated vertices - the VEC-04 warn threshold - so the
    // COUNT was lowered rather than the budget assertion loosened.
    expect(LOD_ARC_SAMPLES).toBe(12);
    expect(LOD_ARC_SAMPLES).toBeLessThan(ARC_SAMPLES);
    for (const c of cornerTickCommands('cw')) {
      expect(pointsOf(c), `LOD ${c.role} sample count`).toHaveLength(2 * (LOD_ARC_SAMPLES + 1));
    }
    for (const c of cornerRailCommands(LOD_ARC_SAMPLES, 1, 'cw')) {
      expect(pointsOf(c), `LOD rail sample count`).toHaveLength(LOD_ARC_SAMPLES + 1);
    }
    // A sector's sampling follows its own share of the quarter arc, so a clipped stub
    // is not tessellated at the whole arc's density.
    for (const c of treadsOf(cornerCommands(0, 4, 'cw'))) {
      expect(pointsOf(c).length).toBeGreaterThanOrEqual(6);
      expect(pointsOf(c).length).toBeLessThanOrEqual(2 * (ARC_SAMPLES + 1));
    }
  });

  it('gives the LOD bend cue the same two rail arcs and ONE phase-independent mark', () => {
    for (const chirality of CHIRALITIES) {
      const cmds = cornerTickCommands(chirality);
      // The cue and the full-detail corner SHARE their chirality's rail family shape;
      // the rails are a separate child object (plan 61-09), sampled at the cue's own
      // count below the LOD cut.
      expect(railsOf(cmds)).toHaveLength(0);
      expect(cornerRailCommands(LOD_ARC_SAMPLES, 1, chirality)).toHaveLength(2);
      const marks = treadsOf(cmds);
      expect(marks).toHaveLength(1);
      // The cue sweeps the WHOLE quarter arc (the shipped raster cue's own extent),
      // so it reads as a turn rather than as a straight run with a gap.
      const span = spanOf(marks[0], chirality);
      expect(span.s0).toBeCloseTo(0, 9);
      expect(span.s1 - span.s0).toBeCloseTo(CORNER_ARC_LENGTH, 9);
      // Phase-INDEPENDENT, and a DIFFERENT mark from the marching tread.
      expect(JSON.stringify(cornerTickCommands(chirality))).toBe(JSON.stringify(cmds));
      expect(JSON.stringify(cmds)).not.toBe(JSON.stringify(cornerCommands(0, 4, chirality)));
    }
  });
});

// ---------------------------------------------------------------------------
// THE MARCH: TWO INDEPENDENT KNOBS (BELT-06 - plan 61-04)
// ---------------------------------------------------------------------------
//
// EVERY INVARIANT BELOW IS STATED IN SIM TICKS, NEVER IN FRAMES. "One bucket per
// frame" is a 60 Hz statement that a 120 Hz or 144 Hz display falsifies: `loop.ts`
// advances the render clock by `deltaMs / SIM_TICK_MS` per DISPLAY frame, so at
// 120 Hz each bucket dwells two frames and at 144 Hz three or four, on an uneven
// cadence. None of that touches the march, because the march is a function of the
// CLOCK IN TICK UNITS and the clock tracks the sim. "One bucket per SIM TICK" is
// what is actually true and it is what survives a refresh-rate change.
describe('the march: rate and bucket count are INDEPENDENT knobs (BELT-06)', () => {
  // THE SLOT PITCH THE SHIPPED MODEL PRODUCES, HAND-TYPED rather than imported. A 32px
  // cell divided by 4 slots per tile is 8px, and both halves are pinned in Rust
  // (`belt_slots.rs::slots_per_tile_divides_the_render_tile`). Typing it here is the
  // `machineChassis.ts:44-57` counter-rule: an expectation derived from the thing it
  // checks cannot fail. If the core moves the pitch, this suite reddens and a human
  // decides, which is exactly what the Rust-side pin does for its own constant.
  const SHIPPED_SLOT_PITCH_PX = 8;

  it('derives the advance from the slot pitch and the interval, with no px/sec term', () => {
    // D-05: the tread carries at the speed of its cargo. An item crosses one 8px slot
    // every `ticks_per_slot` ticks, so that quotient IS the advance. The three
    // constants that used to stand in for this (a sim tick rate, an art-directed
    // px/sec march rate, and their quotient) are DELETED; nothing in the render path
    // states a ticks-per-second figure any more.
    expect(marchPxPerTick(SHIPPED_SLOT_PITCH_PX, 1)).toBe(8);
    expect(marchPxPerTick(SHIPPED_SLOT_PITCH_PX, 2)).toBe(4);
    expect(marchPxPerTick(SHIPPED_SLOT_PITCH_PX, 4)).toBe(2);
    // ... and at an interval of 6 it lands on 1.333333, the number the retired
    // art-directed constant carried. Asserted so the supersession is legible as a
    // MEETING POINT rather than as a bare new number: the old look is the case
    // `ticks_per_slot == 6` of the new model, and nothing about 6 is a proposal - the
    // shipped interval is the maintainers' (62-CONTEXT.md D-19, chosen at the wave-5 sitting).
    expect(marchPxPerTick(SHIPPED_SLOT_PITCH_PX, 6)).toBeCloseTo(1.333333, 6);
    expect(BELT_MARCH_BUCKETS).toBe(12);
    expect(BELT_MARCH_QUANTUM_TICKS).toBe(1);
  });

  it('CLAMPS at the aliasing ceiling and is total on a forged packet', () => {
    // The ceiling is half the dash period per tick: a jump of half a period forward is
    // indistinguishable from half a period backward. HAND-TYPED as 8 beside its
    // derivation, so a dash-period move is a visible edit here.
    expect(MARCH_NYQUIST_CEILING_PX_PER_TICK).toBe(8);
    expect(MARCH_NYQUIST_CEILING_PX_PER_TICK).toBe(BELT_DASH_PERIOD / 2);
    // A pitch wider than the ceiling cannot buy a faster tread. This is D-06 as code
    // rather than as a paragraph.
    expect(marchPxPerTick(32, 1)).toBe(MARCH_NYQUIST_CEILING_PX_PER_TICK);
    // TOTALITY IS RENDER HEALTH, NOT DECORATION. A forged zero interval, a NaN, or a
    // non-positive pitch off an untrusted packet must not produce a non-finite advance:
    // a NaN bucket index misses the asset cache and throws inside `Application.render`,
    // which as a Ticker listener stops the render loop PERMANENTLY on a partial frame.
    for (const [pitch, interval] of [
      [8, 0],
      [8, Number.NaN],
      [8, -3],
      [0, 1],
      [Number.NaN, 1],
      [Number.POSITIVE_INFINITY, 1],
    ] as const) {
      const px = marchPxPerTick(pitch, interval);
      expect(Number.isFinite(px), `advance at pitch ${pitch} interval ${interval}`).toBe(true);
      expect(px).toBeGreaterThan(0);
      expect(px).toBeLessThanOrEqual(MARCH_NYQUIST_CEILING_PX_PER_TICK);
    }
  });

  it('does NOT change the per-tick advance when the bucket count is raised', () => {
    // THE WHOLE POINT OF THE SPLIT, asserted rather than described. The shipped model
    // derived the step from K (`step = pitch / K`), so raising K for smoothness
    // necessarily slowed the belt - which is why BELT-06 could not be fixed in place.
    // The advance does not take K as an argument AT ALL now, which is the split stated
    // in the type rather than in an assertion; the sweep below is what makes that a
    // gated fact.
    for (const k of BELT_MARCH_BUCKET_COUNTS) {
      expect(marchPxPerTick(SHIPPED_SLOT_PITCH_PX, 3), `advance at K = ${k}`).toBeCloseTo(
        8 / 3,
        12,
      );
    }
    // ... and the assertion has TEETH because the other knob demonstrably DOES move
    // with K. If both were invariant the case above would be a tautology about a
    // quantity that simply does not take K as an argument.
    const granularities = BELT_MARCH_BUCKET_COUNTS.map((k) => bucketSizePx(k));
    expect(new Set(granularities).size).toBe(BELT_MARCH_BUCKET_COUNTS.length);
    // The OLD welded form, written out once so the diff shows what was broken: under
    // `step = period / K` the advance would have been the granularity itself, i.e. a
    // different speed at every K.
    expect(granularities[0]).not.toBe(granularities[1]);
  });

  it('marches one dash period in fewer ticks the FASTER the tread, per belt', () => {
    // This was a module constant reading 12, computed from the deleted px/sec figures.
    // It is a function of the belt's own advance now, and it is the CEILING on a useful
    // bucket count: `min(K, ticksPerDashPeriod(advance))`.
    expect(ticksPerDashPeriod(8)).toBe(2);
    expect(ticksPerDashPeriod(4)).toBe(4);
    expect(ticksPerDashPeriod(2)).toBe(8);
    expect(ticksPerDashPeriod(16 / 12)).toBe(12);
    // THE DIRECTION, stated as the monotone property rather than as four sampled rows,
    // so an advance this table never lists cannot quietly invert it. It RISES as the
    // tread SLOWS - the correction plan 61-08 made to the inverted sentence (D-61-2).
    for (const [slow, fast] of [
      [1, 2],
      [2, 4],
      [4, 8],
    ] as const) {
      expect(ticksPerDashPeriod(slow)).toBeGreaterThan(ticksPerDashPeriod(fast));
    }
    // The march is exactly even iff K is a multiple of this number (61-UI-SPEC A6), and
    // at the identity interval the ceiling bites hard: TWO distinct positions in a
    // period, whatever K says. That is the aliasing wall, not a defect in K, and it is
    // why D-06 floors the shipped interval well above the identity.
    expect(BELT_MARCH_BUCKETS % ticksPerDashPeriod(8)).toBe(0);
  });

  it('quantizes the phase by at most half a bucket: 0.666667px at the default', () => {
    expect(worstCaseQuantizationPx(BELT_MARCH_BUCKETS)).toBeCloseTo(0.666667, 6);
    // Stated as the spec's own formula (half the dash period, divided by K) as well
    // as the implementation's (half a bucket), so the two cannot drift apart.
    for (const k of BELT_MARCH_BUCKET_COUNTS) {
      expect(worstCaseQuantizationPx(k), `bound at K = ${k}`).toBeCloseTo(
        BELT_DASH_PERIOD / 2 / k,
        12,
      );
    }
  });

  it('selects the bucket purely from the clock in TICK units and the tile tail offset', () => {
    // Two inputs, a knob, and THIS BELT's advance. No wall clock, no frame index, no
    // display rate. `pxPerTick` became a parameter in Phase 62 (SLOT-03) so each belt
    // walks the shared buckets at its own rate.
    //
    // THE ADVANCE USED HERE IS ONE BUCKET PER TICK, HAND-TYPED. Every assertion below
    // pins the SELECTOR - euclidean wrap, offset subtraction, integer output in [0, K)
    // - and none of them is about the belt's speed, so the one-bucket-per-tick lattice
    // is chosen because it makes those properties readable, not because it is what any
    // belt ships. It was the module constant's value until Phase 62 deleted it (D-05),
    // so these cases pin exactly the behaviour they pinned before.
    const px = BELT_DASH_PERIOD / BELT_MARCH_BUCKETS;
    expect(bucketOf(0, 0, BELT_MARCH_BUCKETS, px)).toBe(0);
    // One tick advances exactly one bucket at the default...
    for (let t = 0; t < 12; t++) {
      expect(bucketOf(t, 0, BELT_MARCH_BUCKETS, px), `tick ${t}`).toBe(t);
    }
    // ... and the 12th tick wraps back to 0 (one whole dash period).
    expect(bucketOf(12, 0, BELT_MARCH_BUCKETS, px)).toBe(0);
    // The offset shifts the phase BACKWARDS along flow, so a tile one whole period
    // downstream draws the identical bucket.
    expect(bucketOf(5, BELT_DASH_PERIOD, BELT_MARCH_BUCKETS, px)).toBe(bucketOf(5, 0, BELT_MARCH_BUCKETS, px));
    // EUCLIDEAN WRAP, asserted at a NEGATIVE offset and a NEGATIVE clock: a pinned or
    // rewound render clock, and a tile whose accumulator ran the other way, must both
    // produce a drawn bucket in `[0, K)` rather than a negative index and a gap.
    for (const [clock, offset] of [
      [-1, 0],
      [0, -1],
      [-37, -25.132741228718345],
      [-1000.5, 9.132741228718345],
    ] as const) {
      const b = bucketOf(clock, offset, BELT_MARCH_BUCKETS, px);
      expect(Number.isInteger(b), `bucket at clock ${clock} offset ${offset}`).toBe(true);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(BELT_MARCH_BUCKETS);
    }
    // The specific negative-offset value, pinned: -1px of offset is +1px of phase,
    // which at the 1.333333px lattice is bucket 1 (round(1 / 1.333333) = 1).
    expect(bucketOf(0, -1, BELT_MARCH_BUCKETS, px)).toBe(1);
  });

  it('lurches at most 48.00px on a resync, and SHRINKS at a slower tread', () => {
    // THE PUBLISHED LURCH METRIC (`belts.ts` demands one from any painter proposing a
    // sub-6 quantum, and this phase proposes quantum 1). `RESYNC_GAP_TICKS` is read
    // from `loop.ts` rather than re-typed, so the metric tracks the gap it describes.
    // `loop.ts` is imported here for that one integer: at runtime it pulls in `interp`
    // and nothing else (its Pixi and layer imports are all type-only and erased), so
    // this suite still runs in the default environment with no DOM and no GL.
    expect(RESYNC_GAP_TICKS).toBe(6);
    // THE METRIC IS PER BELT SINCE PHASE 62 (D-05) AND THE HEADLINE NUMBER MOVED WITH
    // IT, in the honest direction: it is the belt's own advance times the gap, so a
    // slower tread lurches LESS. The bound is the aliasing ceiling times the gap, and
    // the clamp inside `marchPxPerTick` is what makes it a bound rather than a hope.
    const worst = resyncLurchPx(RESYNC_GAP_TICKS, MARCH_NYQUIST_CEILING_PX_PER_TICK);
    expect(worst).toBeCloseTo(48, 12);
    expect(worst).toBe(RESYNC_GAP_TICKS * MARCH_NYQUIST_CEILING_PX_PER_TICK);
    // It halves as the interval doubles, which is the whole of "shrinks at a slower
    // tread" stated as arithmetic.
    expect(resyncLurchPx(RESYNC_GAP_TICKS, marchPxPerTick(8, 2))).toBeCloseTo(24, 12);
    expect(resyncLurchPx(RESYNC_GAP_TICKS, marchPxPerTick(8, 4))).toBeCloseTo(12, 12);
    // THE FIGURE THE RETIRED CONSTANT PUBLISHED, kept and re-pointed rather than
    // deleted: 8.00px, EXACTLY half the dash period, which is the maximally
    // direction-ambiguous displacement a periodic pattern can take (a jump forward by
    // half a period is indistinguishable from a jump backward by half a period). It is
    // now the lurch of a tread at 1.333333px per tick, i.e. of the belt whose interval
    // makes the tread run at the retired art-directed pace - not of every belt.
    const atRetiredPace = resyncLurchPx(RESYNC_GAP_TICKS, 16 / 12);
    expect(atRetiredPace).toBeCloseTo(BELT_DASH_PERIOD / 2, 12);
    // At the shipped 10fps quantum the same snap cost exactly ONE bucket and was
    // invisible; the metric moved because the quantum did, not because the belt did.
    expect(atRetiredPace / bucketSizePx(BELT_MARCH_BUCKETS)).toBeCloseTo(6, 12);
  });
});
