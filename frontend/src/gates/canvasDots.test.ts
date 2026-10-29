// THE CANVAS READERS ON REAL PIXELS (the 77-02 refuter round, phase 77 D-04).
//
// `e2e-live/support/canvasDots.ts` reads the item dots and the junction collar off a decoded
// screenshot. Leg 2 of the composed walk reads both (`COLLAR ON THE CANVAS`, `PACK GROWS ON THE
// CANVAS`, `PACK DRAWN ON THE CANVAS`), leg 3 the dots (`JAM DRAWN ON THE CANVAS`) and leg 4 the
// dots against the plotted particles (`ITEMS VISIBLE ON THE CANVAS`). The fixtures are screenshots
// a live run of leg 2 captured at a pre-release revision (Desktop Chrome, camera scale 1, device pixel ratio 1):
// the run strip (tiles (5,12) to (10,12), 192 by 32 px) empty, with its first item, with one and
// three tiles packed, packed whole, and with four items bunched in transit behind a gap, and the 64 by 32 px clip around the junction seam before and
// after the press-on-end join. So the floors are proved against the real dot, the real Source nub
// over the first slot and the real belt ink, not a drawing written to fit. The REFUSES cases are
// the refuters' defects: dots placed but not visible, a collar drawn somewhere else, a pack drawn
// growing from the wrong end.
//
// Lives under `src/` because `vitest.config.ts` includes `src/**/*.{test,spec}.{ts,tsx}` only.

import { readFileSync } from 'node:fs';
import { PNG } from 'playwright-core/lib/utilsBundle';
import { describe, expect, it } from 'vitest';
import {
  alphaOver,
  BOARD_RGB,
  CABLE_ALPHA,
  CABLE_CELL_EMPTY_MAX,
  CABLE_CELL_MIN,
  CABLE_RGB,
  cableInkRgb,
  cablesOnCanvas,
  collarInk,
  TERMINAL_INK_MIN,
  TERMINAL_RGB,
  gaugeOnCanvas,
  labelOnCanvas,
  LABEL_BAND_PX,
  LABEL_FILL_ALPHA_EXPECTED,
  gradeGrowth,
  packedDepth,
  unresolvedStages,
  boundaryBrackets,
  packOrderViolations,
  resolvingSamples,
  type BoundaryBracket,
  type RunReading,
  visibleDotsPerTile,
  windowInk,
  GAUGE_GAP_PX,
  GAUGE_INK_RGB,
  GAUGE_OUTSET_PX,
  GAUGE_RUN_PX,
  GAUGE_THICK_PX,
  GAUGE_TICK_PX,
  type CableToRead,
  type DecodedImage,
  type ImageFrame,
  type StageSample,
  type TileInImage,
} from '../../e2e-live/support/canvasDots';
import { nubAnchor } from '../../shared/geometry';
import {
  GAUGE_GAP_U,
  GAUGE_OUTSET_U,
  GAUGE_RUN_U,
  GAUGE_THICK_U,
  GAUGE_TICK_U,
} from '../render/layers/machineState';
import { CHASSIS_INSET_U, U_TO_PX, uToPx } from '../render/layers/machineChassis';
import { LABEL_FILL_ALPHA } from '../render/layers/machines';
import { CABLE_ALPHA_IDLE } from '../render/layers/wires';
import { LOCKED_SKIN } from '../render/synth/skins/locked';

const fixture = (name: string): DecodedImage => {
  const png = PNG.sync.read(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
  return { width: png.width, height: png.height, data: png.data };
};

/** The run's tiles, tail first, as they sit in the 192 by 32 px strip. */
const RUN = ['5,12', '6,12', '7,12', '8,12', '9,12', '10,12'];
const HEAD_FIRST = [...RUN].reverse();
const TILES: TileInImage[] = RUN.map((key, i) => ({
  key,
  rect: { x0: i * 32, y0: 0, x1: (i + 1) * 32, y1: 32 },
  axis: 'x',
}));
const dotsOf = (img: DecodedImage): Record<string, number> =>
  Object.fromEntries(Object.entries(visibleDotsPerTile(img, TILES, 1)).map(([k, v]) => [k, v.dots]));
const each = (n: number): Record<string, number> => Object.fromEntries(RUN.map((k) => [k, n]));

/** A copy of `img` with every dot-ink pixel painted over in the board's ground colour. */
function inkErased(img: DecodedImage): DecodedImage {
  const data = Uint8Array.from(img.data);
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] - data[i + 2] > 40) {
      data[i] = 0x1b;
      data[i + 1] = 0x1f;
      data[i + 2] = 0x27;
    }
  }
  return { ...img, data };
}

/**
 * A copy of `img` mirrored left to right inside each belt's 96 px (refuter 6's mutation: every dot
 * drawn at `latency - 1 - slot`, so each belt's pack shows at its tail end).
 */
function mirroredPerBelt(img: DecodedImage): DecodedImage {
  const data = new Uint8Array(img.data.length);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const belt = Math.floor(x / 96);
      const mx = belt * 96 + (95 - (x - belt * 96));
      const from = (y * img.width + mx) << 2;
      data.set(img.data.subarray(from, from + 4), (y * img.width + x) << 2);
    }
  }
  return { ...img, data };
}

describe('visibleDotsPerTile on the live run strip', () => {
  it('ACCEPTS the packed run: four dots on every tile, the first slot read through the Source nub', () => {
    const img = fixture('77-run-strip-packed.png');
    expect(dotsOf(img)).toEqual(each(4));
    // The Source's port nub covers most of the first slot's dot: 6 ink pixels survive, against 16.
    expect(windowInk(img, TILES[0])).toEqual([6, 16, 16, 16]);
  });

  it('ACCEPTS the empty run and the first item at the tail', () => {
    expect(dotsOf(fixture('77-run-strip-empty.png'))).toEqual(each(0));
    expect(dotsOf(fixture('77-run-strip-first-item.png'))).toEqual({ ...each(0), '5,12': 1 });
  });

  it('ACCEPTS three tiles packed from the head, the items in transit behind them counted one per slot', () => {
    expect(dotsOf(fixture('77-run-strip-three-full.png'))).toEqual({
      '5,12': 2,
      '6,12': 3,
      '7,12': 2,
      '8,12': 4,
      '9,12': 4,
      '10,12': 4,
    });
  });

  it('REFUSES a packed run whose dots are placed but not visible (refuters 1 and 4: zero scale, hidden layer, alpha 0)', () => {
    expect(dotsOf(inkErased(fixture('77-run-strip-packed.png')))).toEqual(each(0));
  });

  it('scales the floor with the device pixel ratio: at 2x a 6-pixel scrap is not a dot', () => {
    const img = fixture('77-run-strip-packed.png');
    expect(visibleDotsPerTile(img, TILES, 2)['5,12'].dots).toBe(3);
  });
});

describe('gradeGrowth', () => {
  const stage = (n: number): Record<string, number> => {
    const s = each(2);
    for (const k of HEAD_FIRST.slice(0, n)) s[k] = 4;
    return s;
  };

  it('ACCEPTS a pack growing tile by tile back from the head, read off the real strips at depths 0, 1, 3 and 6', () => {
    const real = [
      dotsOf(fixture('77-run-strip-empty.png')),
      dotsOf(fixture('77-run-strip-one-full.png')),
      stage(2),
      dotsOf(fixture('77-run-strip-three-full.png')),
      stage(4),
      stage(5),
      dotsOf(fixture('77-run-strip-packed.png')),
    ];
    expect(gradeGrowth(real, HEAD_FIRST)).toEqual({ samples: 7, stages: [0, 1, 2, 3, 4, 5, 6], shrank: null });
  });

  it('ACCEPTS four items bunched in transit on (9,12) behind a gap: a full tile is not packed until every tile ahead is', () => {
    // Captured on a correct build: the model held the downstream belt's slots 4 to 7 with 3 empty.
    const bunch = dotsOf(fixture('77-run-strip-bunch-in-transit.png'));
    expect(bunch['9,12']).toBe(4);
    expect(bunch['10,12']).toBe(0);
    expect(packedDepth(bunch, HEAD_FIRST)).toBe(0);
    expect(gradeGrowth([dotsOf(fixture('77-run-strip-empty.png')), bunch], HEAD_FIRST).stages).toEqual([0]);
  });

  it('REFUSES the pack drawn growing tail first on each belt (refuter 6), on the real strip mirrored per belt', () => {
    const oneFull = fixture('77-run-strip-one-full.png');
    expect(packedDepth(dotsOf(oneFull), HEAD_FIRST)).toBe(1);
    // Mirrored, the downstream belt's packed head slots show on (8,12), and the head tile is not full.
    const mirrored = dotsOf(mirroredPerBelt(oneFull));
    expect(mirrored['8,12']).toBe(4);
    expect(packedDepth(mirrored, HEAD_FIRST)).toBe(0);
    // So the depth jumps 0 to 3 when the whole downstream belt is packed, and 3 to 6 for the upstream.
    const tailFirst = [stage(0), mirrored, stage(3), stage(6)];
    expect(gradeGrowth(tailFirst, HEAD_FIRST).stages).toEqual([0, 3, 6]);
  });

  it('REFUSES a pack that never shows on the canvas: it never leaves depth 0', () => {
    expect(gradeGrowth([each(0), each(0), each(0)], HEAD_FIRST).stages).toEqual([0]);
  });

  it('REFUSES a skipped stage and a packed tile that empties again', () => {
    expect(gradeGrowth([stage(0), stage(2), stage(3)], HEAD_FIRST).stages).toEqual([0, 2, 3]);
    expect(gradeGrowth([stage(2), stage(1)], HEAD_FIRST).shrank).toEqual({ sample: 1, from: 2, to: 1 });
  });
});

describe('unresolvedStages (plans 84-11 and 84-15)', () => {
  // A capture whose reply came back on the tick it was requested: request and reply agree, so the
  // request-only rule of plan 84-11 and plan 84-15's rule read these series alike.
  const at = (t: number): StageSample => ({ requestTick: t, replyTick: t });
  const ats = (ts: number[]): StageSample[] => ts.map(at);
  // The model's first ticks at packed depths 1 to 6, as leg 2's PACK_ORDER line logged them at a
  // 100% CPU quota (plan 84-11's reproduction): 37 to 64 ticks per tile.
  const BOUNDARIES = [2162, 2201, 2265, 2325, 2362, 2401];

  it('ACCEPTS a series with a sample inside every stage, before the first boundary and after the last', () => {
    expect(unresolvedStages(ats([2100, 2170, 2230, 2300, 2340, 2380, 2420]), BOUNDARIES)).toEqual([]);
  });

  it('NAMES the stages a slow series straddled: the 2026-10-09 CI run sampled about every 3 s', () => {
    // Two consecutive samples 2140 and 2240 straddle the boundaries at 2162 and 2201: stage 1 had no sample.
    expect(unresolvedStages(ats([2100, 2140, 2240, 2300, 2350, 2390, 2450]), BOUNDARIES)).toEqual([1]);
    // Samples a second apart at this sim rate see every other stage at best.
    expect(unresolvedStages(ats([2100, 2200, 2300, 2400, 2500]), BOUNDARIES)).toEqual([2, 4]);
  });

  it('NAMES stage 0 when the first sample comes after the first boundary, and the last when the series stops early', () => {
    expect(unresolvedStages(ats([2170, 2230, 2300, 2340, 2380, 2420]), BOUNDARIES)).toEqual([0]);
    expect(unresolvedStages(ats([2100, 2170, 2230, 2300, 2340, 2380]), BOUNDARIES)).toEqual([6]);
  });

  it('NAMES every stage after a boundary the model never reached', () => {
    expect(
      unresolvedStages(ats([2100, 2170, 2230, 2300, 2340, 2380, 2420]), [2162, 2201, 2265, 2325, null, null]),
    ).toEqual([5, 6]);
  });

  // THE R4 PROXY RED (plan 84-14, `g8414/proxy-full.log`): the stage ticks leg 2's PACK_ORDER line
  // logged at R4 at the GPU proxy, where each capture came back 3.8 to 5.3 s after its
  // request. Stage s is [R4[s - 1], R4[s]): stage 4 is model ticks 3361 to 3400.
  const R4 = [3201, 3241, 3301, 3361, 3401, 3451];
  /** A capture requested and answered inside each stage, except stage `skip`. */
  const bracketedBut = (skip: number): StageSample[] =>
    [
      { requestTick: 3150, replyTick: 3190 },
      { requestTick: 3205, replyTick: 3235 },
      { requestTick: 3250, replyTick: 3290 },
      { requestTick: 3310, replyTick: 3350 },
      { requestTick: 3365, replyTick: 3395 },
      { requestTick: 3405, replyTick: 3445 },
      { requestTick: 3460, replyTick: 3500 },
    ].filter((_, s) => s !== skip);

  it('ACCEPTS a series with a capture requested and answered inside every stage', () => {
    expect(unresolvedStages(bracketedBut(-1), R4)).toEqual([]);
  });

  it('NAMES the stage of the R4 proxy red: captures requested inside stage 4 answered after it ended', () => {
    const late = [
      { requestTick: 3365, replyTick: 3420 },
      { requestTick: 3380, replyTick: 3452 },
    ];
    expect(unresolvedStages([...bracketedBut(4), ...late], R4)).toEqual([4]);
  });

  it('NAMES a stage whose only capture was requested before it began', () => {
    // Requested in stage 1 (tick 3230), answered in stage 2 (tick 3260).
    const early = { requestTick: 3230, replyTick: 3260 };
    expect(unresolvedStages([...bracketedBut(2), early], R4)).toEqual([2]);
  });

  it('NAMES a stage whose only capture was answered on the next boundary tick', () => {
    // Requested in stage 3 (tick 3320), answered on tick 3361, the first tick of stage 4.
    const onEdge = { requestTick: 3320, replyTick: 3361 };
    expect(unresolvedStages([...bracketedBut(3), onEdge], R4)).toEqual([3]);
  });

  it('REFUSES a capture answered before it was requested, by name', () => {
    expect(() => unresolvedStages([...bracketedBut(-1), { requestTick: 3300, replyTick: 3290 }], R4)).toThrow(
      /answered at tick 3290, before it was requested at tick 3300/,
    );
  });
});

describe('stage brackets (plan 84-17)', () => {
  // 84-16 SERIES RUN 5 AT THE GPU PROXY (`b8416/series-px-5.out`): `PACK_ORDER ... ticks=3629,3668,
  // 3722,3789,3827,3895 ... boundaryGaps=12,36,13,27,12,27`, `depthsSeen=0|1|2|3,4|4|5|6`. The
  // recorder's record before each boundary's first is at `first - gap - 1`, so the brackets are
  // (3616, 3629], (3631, 3668], (3708, 3722], (3761, 3789], (3814, 3827], (3867, 3895]. One reading
  // at each bracket edge, with the packed slots on each side of the boundary.
  const BOUNDARIES = [4, 8, 12, 16, 20, 24];
  const FIRSTS = [3629, 3668, 3722, 3789, 3827, 3895];
  const READINGS: RunReading[] = [
    { t: 3616, packed: 3 },
    { t: 3629, packed: 4 },
    { t: 3631, packed: 7 },
    { t: 3668, packed: 8 },
    { t: 3708, packed: 11 },
    { t: 3722, packed: 12 },
    { t: 3761, packed: 15 },
    { t: 3789, packed: 16 },
    { t: 3814, packed: 19 },
    { t: 3827, packed: 20 },
    { t: 3867, packed: 23 },
    { t: 3895, packed: 24 },
  ];
  const BRACKETS: BoundaryBracket[] = [
    { lo: 3616, hi: 3629 },
    { lo: 3631, hi: 3668 },
    { lo: 3708, hi: 3722 },
    { lo: 3761, hi: 3789 },
    { lo: 3814, hi: 3827 },
    { lo: 3867, hi: 3895 },
  ];
  const at = (t: number): StageSample => ({ requestTick: t, replyTick: t });
  /** One capture inside each stage's certain window: stage 0 up to 3616, stage 1 3629 to 3631, and so on. */
  const CERTAIN = [3600, 3630, 3690, 3740, 3800, 3845, 3910].map(at);
  // Run 5's capture that read depth 4 while the recorder placed it in stage 3 was not logged by tick
  // (84-16 logged no per-capture tick); 3775 lies inside boundary 16's bracket (3761, 3789), where it
  // could have been.
  const MISCREDIT = at(3775);

  it('BRACKETS each boundary between the last reading below it and the first at or above it (84-16 series run 5)', () => {
    expect(boundaryBrackets(READINGS, BOUNDARIES)).toEqual(BRACKETS);
    // In any order, and a boundary no reading reaches is null.
    expect(boundaryBrackets([...READINGS].reverse(), [...BOUNDARIES, 28])).toEqual([...BRACKETS, null]);
    // No reading before the first one at or above the boundary: the bracket opens at minus infinity.
    expect(boundaryBrackets([{ t: 10, packed: 5 }], [4])).toEqual([{ lo: Number.NEGATIVE_INFINITY, hi: 10 }]);
  });

  it('CREDITS NO STAGE with a capture stamped inside the bracket of a boundary: the 84-16 mis-credit, stage 3 shown at depth 4', () => {
    const samples = [...CERTAIN, MISCREDIT];
    const m = samples.length - 1;
    const byBracket = resolvingSamples(samples, BRACKETS);
    expect(byBracket.some((by) => by.includes(m)), 'no stage holds the capture inside (3761, 3789]').toBe(false);
    expect(byBracket).toEqual([[0], [1], [2], [3], [4], [5], [6]]);
    // With run 5's first recorded ticks as plain numbers, stage 3 ([3722, 3789)) holds it: the mis-credit.
    expect(resolvingSamples(samples, FIRSTS)[3]).toEqual([3, m]);
  });

  it('NAMES a stage whose only capture was stamped inside a bracket', () => {
    const samples = [...CERTAIN.filter((_, s) => s !== 3), MISCREDIT];
    expect(unresolvedStages(samples, BRACKETS)).toEqual([3]);
    expect(unresolvedStages(samples, FIRSTS)).toEqual([]);
  });

  it('PLACES a capture by its own reading of the model, merged with the recorder readings', () => {
    // The capture read the model at its own tick: 16 slots packed at 3775.
    const brackets = boundaryBrackets([...READINGS, { t: 3775, packed: 16 }], BOUNDARIES);
    expect(brackets[3]).toEqual({ lo: 3761, hi: 3775 });
    const samples = [...CERTAIN, MISCREDIT];
    const by = resolvingSamples(samples, brackets);
    expect(by[4]).toEqual([4, samples.length - 1]);
    expect(by[3]).toEqual([3]);
  });

  it('REFUSES two readings of one tick that disagree, by name', () => {
    expect(() => boundaryBrackets([...READINGS, { t: 3775, packed: 16 }, { t: 3775, packed: 15 }], BOUNDARIES)).toThrow(
      /boundaryBrackets: two readings of tick 3775 disagree \(16 and 15 slots packed\)/,
    );
    // Two readings of one tick that agree are one reading.
    expect(boundaryBrackets([...READINGS, { t: 3789, packed: 16 }], BOUNDARIES)).toEqual(BRACKETS);
  });

  it('KEEPS 84-15 rule for a boundary read on its own tick: the bracket (b - 1, b] places captures as the number b does', () => {
    const asBrackets = FIRSTS.map((b) => ({ lo: b - 1, hi: b }));
    // Every tick from before the first boundary to after the last, each a capture of its own.
    const every = Array.from({ length: 3920 - 3600 }, (_, i) => at(3600 + i));
    expect(resolvingSamples(every, asBrackets)).toEqual(resolvingSamples(every, FIRSTS));
    // The boundary tick itself opens the stage, the tick before it closes the one before.
    const edge = [at(3788), at(3789)];
    expect(resolvingSamples(edge, asBrackets)[3]).toEqual([0]);
    expect(resolvingSamples(edge, asBrackets)[4]).toEqual([1]);
    expect(resolvingSamples(edge, FIRSTS)[4]).toEqual([1]);
  });
});

describe('collarInk on the live seam clip', () => {
  it('ACCEPTS the joined seam: ring ink in all four quadrants, and none before the join', () => {
    expect(collarInk(fixture('77-seam-before-join.png'), 32, 16, 'x', 1).quads).toEqual([0, 0, 0, 0]);
    const after = collarInk(fixture('77-seam-after-join.png'), 32, 16, 'x', 1);
    expect(after.quads.every((q) => q >= 16)).toBe(true);
  });

  it('REFUSES a collar read anywhere but on its seam (refuter 2: the collar drawn 9999 px away)', () => {
    // The joined clip read one tile to the left of the seam, on plain belt.
    expect(collarInk(fixture('77-seam-after-join.png'), 0, 16, 'x', 1).quads.filter((q) => q >= 8)).toHaveLength(0);
    // The seam with no collar drawn on it reads as the clip before the join.
    expect(collarInk(fixture('77-seam-before-join.png'), 32, 16, 'x', 1).total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// THE LOAD GAUGE ON SCREEN (the 77-03 refuter round, refuter 1). Leg 3 read the Tee's backed-up
// mark off the gauge Graphics only, which a hidden gauge still holds. The fixtures are the 42 by
// 12 px clips leg 3's `gaugeOnScreen` took on a live run of this round's spec over a pre-release revision (camera
// scale 1, device pixel ratio 1): the merged bar in the steady jam, and the empty band after the
// release. The band is rows 3 to 7 of the clip (the 3 px band with a row either side).
// ---------------------------------------------------------------------------

describe('gaugeOnCanvas, the load gauge read off screen pixels', () => {
  const BAND = { x0: 0, x1: 42, y0: 3, y1: 8 };

  it("pins the gauge geometry and ink against the product's own constants", () => {
    expect(U_TO_PX).toBe(1);
    expect({
      outset: GAUGE_OUTSET_PX,
      thick: GAUGE_THICK_PX,
      tick: GAUGE_TICK_PX,
      gap: GAUGE_GAP_PX,
      run: GAUGE_RUN_PX,
    }).toEqual({ outset: GAUGE_OUTSET_U, thick: GAUGE_THICK_U, tick: GAUGE_TICK_U, gap: GAUGE_GAP_U, run: GAUGE_RUN_U });
    const ramp4 = LOCKED_SKIN.palette.ramp[LOCKED_SKIN.palette.ramp.length - 1];
    expect(GAUGE_INK_RGB).toEqual({ r: (ramp4 >> 16) & 0xff, g: (ramp4 >> 8) & 0xff, b: ramp4 & 0xff });
  });

  it('reads the merged bar in the steady jam: one run of 25 px, level 4', () => {
    expect(gaugeOnCanvas(fixture('77-gauge-jam-merged.png'), BAND, 1)).toMatchObject({
      runs: [25],
      merged: true,
      level: 4,
    });
  });

  it('reads an empty band after the release: level 0', () => {
    expect(gaugeOnCanvas(fixture('77-gauge-released.png'), BAND, 1)).toMatchObject({ runs: [], ink: 0, merged: false, level: 0 });
  });

  it('REFUSES the merged bar when the gauge is not on screen (the Graphics would still hold it)', () => {
    const img = fixture('77-gauge-jam-merged.png');
    const data = Uint8Array.from(img.data);
    for (let i = 0; i < data.length; i += 4) {
      if (Math.abs(data[i] - GAUGE_INK_RGB.r) <= 48 && Math.abs(data[i + 2] - GAUGE_INK_RGB.b) <= 48) {
        data[i] = 0x1b;
        data[i + 1] = 0x1f;
        data[i + 2] = 0x27;
      }
    }
    expect(gaugeOnCanvas({ ...img, data }, BAND, 1)).toMatchObject({ merged: false, level: 0 });
  });

  it('reads three ticks as level 3, never as the merged bar', () => {
    const img = fixture('77-gauge-released.png');
    const data = Uint8Array.from(img.data);
    for (const x0 of [9, 9 + GAUGE_TICK_PX + GAUGE_GAP_PX, 9 + 2 * (GAUGE_TICK_PX + GAUGE_GAP_PX)]) {
      for (let y = 4; y < 4 + GAUGE_THICK_PX; y++) {
        for (let x = x0; x < x0 + GAUGE_TICK_PX; x++) {
          const i = (y * img.width + x) * 4;
          data[i] = GAUGE_INK_RGB.r;
          data[i + 1] = GAUGE_INK_RGB.g;
          data[i + 2] = GAUGE_INK_RGB.b;
        }
      }
    }
    expect(gaugeOnCanvas({ ...img, data }, BAND, 1)).toMatchObject({ runs: [4, 4, 4], merged: false, level: 3 });
  });

  it('REFUSES a bar broken by a gap as the merged bar (a form drawLoadGauge never draws)', () => {
    const img = fixture('77-gauge-jam-merged.png');
    const data = Uint8Array.from(img.data);
    for (let y = 0; y < img.height; y++) {
      for (let x = 20; x < 23; x++) {
        const i = (y * img.width + x) * 4;
        data[i] = 0x1b;
        data[i + 1] = 0x1f;
        data[i + 2] = 0x27;
      }
    }
    expect(gaugeOnCanvas({ ...img, data }, BAND, 1)).toMatchObject({ runs: [11, 11], merged: false, level: null });
  });
});

// THE LABEL ON SCREEN (the 77-04 refuter round, refuters 2 and 3). The fixtures are the 192 by 64 px
// clip of exactly the label's cells, (5,13) to (10,14), that a live run of leg 4 captured at
// a pre-release revision (Desktop Chrome, camera scale 1, device pixel ratio 1): the Lilac label reading `Order
// intake` deselected before the save (`77-label-drawn.png`) and selected with its panel open
// (`77-label-selected.png`), and the same moment under refuter 2's mutation (`box.g.visible =
// false`, `77-label-box-hidden.png`) and refuter 3's (the words overlay at `opacity: 0`,
// `77-label-words-hidden.png`). Each run's clip after the Load was byte-identical to its clip
// before the save.
describe('labelOnCanvas, the label read off screen pixels', () => {
  const LILAC = LOCKED_SKIN.palette.labels.lilac;
  const SAND = LOCKED_SKIN.palette.labels.sand;
  /** A copy of `img` with every pixel `from` (exact) painted `to`. */
  const recoloured = (img: DecodedImage, pairs: Array<[number, number]>): DecodedImage => {
    const data = Uint8Array.from(img.data);
    for (let i = 0; i < data.length; i += 4) {
      const k = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
      const hit = pairs.find(([from]) => from === k);
      if (hit) {
        data[i] = (hit[1] >> 16) & 0xff;
        data[i + 1] = (hit[1] >> 8) & 0xff;
        data[i + 2] = hit[1] & 0xff;
      }
    }
    return { ...img, data };
  };

  it("pins the label's fill alpha, colour and inset against the product's own", () => {
    expect(LABEL_FILL_ALPHA_EXPECTED).toBe(LABEL_FILL_ALPHA);
    expect(LILAC).toBe(0xbea2ea);
    // The stroke (2 px, centred on the box inset by CHASSIS_INSET_U) lies inside the edge band.
    expect(uToPx(CHASSIS_INSET_U) + 2).toBeLessThan(LABEL_BAND_PX);
  });

  it('reads the drawn label: Lilac on all four sides, the fill at alpha 0.16, the words', () => {
    const read = labelOnCanvas(fixture('77-label-drawn.png'), LILAC, 1);
    expect(read).toMatchObject({ sides: [352, 96, 352, 96], sideMin: [176, 48, 176, 48], words: 178, boxDrawn: true, wordsDrawn: true });
    expect(read.fillAlpha).toBeCloseTo(0.159, 2);
    expect(read.fillResidual).toBeLessThan(1);
  });

  it('reads the selected label the same way: the selection ring outside the box takes nothing from it', () => {
    expect(labelOnCanvas(fixture('77-label-selected.png'), LILAC, 1)).toMatchObject({ words: 178, boxDrawn: true, wordsDrawn: true });
  });

  it('REFUSES the box when its Graphics is hidden (refuter 2): no stroke, no tint, the words still read', () => {
    const read = labelOnCanvas(fixture('77-label-box-hidden.png'), LILAC, 1);
    expect(read).toMatchObject({ sides: [0, 0, 0, 0], boxDrawn: false, wordsDrawn: true });
    expect(Math.abs(read.fillAlpha)).toBeLessThan(0.02);
  });

  it('REFUSES the words when the overlay is at opacity 0 (refuter 3): the box still reads', () => {
    expect(labelOnCanvas(fixture('77-label-words-hidden.png'), LILAC, 1)).toMatchObject({ words: 0, boxDrawn: true, wordsDrawn: false });
  });

  it('REFUSES a box stroked but not filled', () => {
    const img = recoloured(fixture('77-label-drawn.png'), [
      [0x353446, 0x1b1f27],
      [0x414156, 0x2a2f3a],
    ]);
    const read = labelOnCanvas(img, LILAC, 1);
    expect(read.boxDrawn).toBe(false);
    expect(Math.abs(read.fillAlpha)).toBeLessThan(0.02);
  });

  it('REFUSES a box drawn in another colour (Sand where Lilac was asked)', () => {
    const img = recoloured(fixture('77-label-drawn.png'), [[LILAC, SAND]]);
    expect(labelOnCanvas(img, LILAC, 1)).toMatchObject({ sides: [0, 0, 0, 0], boxDrawn: false });
  });

  it('REFUSES the label drawn a cell to the right of its cells (its left side is gone)', () => {
    const img = fixture('77-label-drawn.png');
    const data = Uint8Array.from(img.data);
    for (let y = 0; y < img.height; y++) {
      for (let x = img.width - 1; x >= 0; x--) {
        const i = (y * img.width + x) * 4;
        const j = (y * img.width + (x - 32)) * 4;
        for (let c = 0; c < 4; c++) data[i + c] = x >= 32 ? img.data[j + c] : c === 3 ? 255 : [0x1b, 0x1f, 0x27][c];
      }
    }
    const read = labelOnCanvas({ ...img, data }, LILAC, 1);
    expect(read.sides[3]).toBe(0);
    expect(read.boxDrawn).toBe(false);
  });

  it('alphaOver: a colour on the line from the board to the label reads its alpha with no residual', () => {
    const bg = { r: 27, g: 31, b: 39 };
    const fg = { r: 190, g: 162, b: 234 };
    expect(alphaOver(bg, bg, fg)).toEqual({ alpha: 0, residual: 0 });
    expect(alphaOver(fg, bg, fg).alpha).toBeCloseTo(1, 6);
    expect(alphaOver({ r: 53, g: 52, b: 70 }, bg, fg).alpha).toBeCloseTo(0.159, 2);
  });
});

// THE CABLE AND ITS PRONGS (the 77-05 refuter round). The fixtures are 352 by 160 px clips of the
// cells around leg 1's pair (cells (6,7) to (16,11)), re-shot in plan 92-04 with the resting cable
// in `palette.cable` at alpha 1 by the composed walk's own capture helper (`captureCablesFixture`
// in `e2e-live/77-one-board-all-five.live.spec.ts`, run with `FABRICO_CAPTURE_DIR` set; its
// comment names the one command): Desktop Chrome, 1280x800, camera scale 1, device pixel ratio 1,
// the camera at x 243.5132, y 304.2488, the clip at 436, 528. `drawn` after leg 5's Ctrl+Z and
// deselect; `gone` after leg 5's Disconnect, with the Route selected and its delete chip over cell
// (7,8); `unseen` the `drawn` moment in a build whose resting cable is stroked at alpha 0 (refuter
// 1); `prongs-dropped` the `drawn` moment in a build that leaves every wire terminal undrawn, which
// after the Undo is every terminal of a wire that arrived by a keyframe (refuter 7). The two breaks
// were switched on just before the `drawn` capture, so the walk reached it. Until plan 92-04 the
// captures came from an uncommitted probe at a pre-release revision (camera x 281.2187, y 299.2576) with the
// cable `ramp[3]` at alpha 0.35.
describe('cablesOnCanvas: the cable and its prongs in screen pixels (the 77-05 refuter round)', () => {
  const FRAME: ImageFrame = { originX: 243.5131914893617 - 436, originY: 304.24882011605416 - 528, scale: 1, dpr: 1, cell: 32 };
  const cells = (xs: Array<[number, number]>): Array<[number, number]> => xs;
  /** Leg 1's pair as the model routes it: the forward leg Route Out (8,8 E) to Handler In (12,8 W),
   *  the return leg Handler Out (14,8 E) round row 10 to Route In (8,8 W). */
  const PAIR: CableToRead[] = [
    {
      key: '8,8:1 -> 12,7:0',
      cells: cells([[8, 8], [9, 8], [10, 8], [11, 8], [12, 8]]),
      ends: [nubAnchor(8, 8, 1), nubAnchor(12, 8, 3)],
    },
    {
      key: '12,7:1 -> 8,8:0',
      cells: cells([
        [14, 8], [15, 8], [15, 9], [15, 10], [14, 10], [13, 10], [12, 10], [11, 10],
        [10, 10], [9, 10], [8, 10], [7, 10], [7, 9], [7, 8], [8, 8],
      ]),
      ends: [nubAnchor(14, 8, 1), nubAnchor(8, 8, 3)],
    },
  ];
  const DRAWN_CELLS = [
    [64, 64, 52],
    [52, 64, 54, 64, 64, 64, 64, 64, 64, 64, 65, 64, 69],
  ];
  /** The same cells on `prongs-dropped`: no terminal covers the cable's clamped ends. */
  const PRONGS_DROPPED_CELLS = [
    [64, 64, 64],
    [62, 64, 54, 64, 64, 64, 64, 64, 64, 64, 65, 64, 73],
  ];

  it("pins the cable's colour and alpha, the board and the terminal colour to the product's own", () => {
    const { ramp, accents, cable } = LOCKED_SKIN.palette;
    expect(CABLE_RGB).toBe(cable);
    expect(BOARD_RGB).toBe(ramp[0]);
    expect(CABLE_ALPHA).toBe(CABLE_ALPHA_IDLE);
    expect(TERMINAL_RGB).toBe(accents.electric);
    // At alpha 1 the composite is the token itself (phase 92, D-10).
    expect(cableInkRgb()).toEqual({ r: (cable >> 16) & 0xff, g: (cable >> 8) & 0xff, b: cable & 0xff });
  });

  it('reads the drawn pair: every run cell holds the cable, every end its electric terminal', () => {
    const read = cablesOnCanvas(fixture('77-cables-drawn.png'), PAIR, FRAME);
    expect(read.cables.map((c) => c.cellInk)).toEqual(DRAWN_CELLS);
    expect(read.cables.map((c) => c.endInk)).toEqual([[120, 102], [100, 124]]);
    expect(read).toMatchObject({ seen: true, gone: false });
    expect(Math.min(...DRAWN_CELLS.flat())).toBeGreaterThanOrEqual(CABLE_CELL_MIN);
    expect(Math.min(120, 102, 100, 124)).toBeGreaterThanOrEqual(TERMINAL_INK_MIN);
  });

  it('REFUSES the cable stroked at alpha 0 or hidden (refuters 1 and 5): no cell holds it, the terminals still read', () => {
    const read = cablesOnCanvas(fixture('77-cables-unseen.png'), PAIR, FRAME);
    expect(read.cables.map((c) => c.cellInk.every((n) => n === 0))).toEqual([true, true]);
    expect(read.cables.map((c) => c.endInk)).toEqual([[120, 102], [100, 124]]);
    expect(read).toMatchObject({ seen: false, gone: false });
  });

  it('REFUSES the prongs dropped after a keyframe (refuter 7): the cable reads, no end does', () => {
    const read = cablesOnCanvas(fixture('77-cables-prongs-dropped.png'), PAIR, FRAME);
    // With the terminals undrawn the opaque cable shows where a terminal used to cover it, so the
    // cells next to a port read a few pixels more than `DRAWN_CELLS`; every one still holds it.
    expect(read.cables.map((c) => c.cellInk)).toEqual(PRONGS_DROPPED_CELLS);
    expect(Math.min(...PRONGS_DROPPED_CELLS.flat())).toBeGreaterThanOrEqual(CABLE_CELL_MIN);
    expect(read.cables.map((c) => c.endInk)).toEqual([[0, 0], [0, 0]]);
    expect(read).toMatchObject({ seen: false, gone: false });
  });

  it('reads the pair gone after the Disconnect: the delete chip over (7,8) takes nothing from it', () => {
    const read = cablesOnCanvas(fixture('77-cables-gone.png'), PAIR, FRAME);
    expect(read).toMatchObject({ seen: false, gone: true });
    expect(Math.max(...read.cables.flatMap((c) => c.cellInk))).toBeLessThanOrEqual(CABLE_CELL_EMPTY_MAX);
  });

  it('REFUSES gone on the drawn pair', () => {
    expect(cablesOnCanvas(fixture('77-cables-drawn.png'), PAIR, FRAME).gone).toBe(false);
  });

  it('REFUSES the pair read one row off the cells it was drawn on', () => {
    const off = PAIR.map((c) => ({
      ...c,
      cells: c.cells.map(([x, y]) => [x, y + 1] as const),
      ends: [{ x: c.ends[0].x, y: c.ends[0].y + 32 }, { x: c.ends[1].x, y: c.ends[1].y + 32 }] as const,
    }));
    expect(cablesOnCanvas(fixture('77-cables-drawn.png'), off, FRAME).seen).toBe(false);
  });

  it('REFUSES the cable stroked at another alpha (0.5 where 1 is drawn)', () => {
    // The teal (46,143,153) at alpha 0.5 over the floor (27,31,39).
    const half = { r: Math.round(27 + 0.5 * 19), g: Math.round(31 + 0.5 * 112), b: Math.round(39 + 0.5 * 114) };
    const src = fixture('77-cables-drawn.png');
    const data = Uint8Array.from(src.data);
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] === 46 && data[i + 1] === 143 && data[i + 2] === 153) {
        data[i] = half.r;
        data[i + 1] = half.g;
        data[i + 2] = half.b;
      }
    }
    const img = { ...src, data };
    const read = cablesOnCanvas(img, PAIR, FRAME);
    expect(read.cables.flatMap((c) => c.cellInk).every((n) => n === 0)).toBe(true);
    expect(read.seen).toBe(false);
  });

  it('REFUSES an empty list as either verdict', () => {
    expect(cablesOnCanvas(fixture('77-cables-drawn.png'), [], FRAME)).toMatchObject({ seen: false, gone: false });
  });
});

// THE PACK ORDER FROM BRACKETS (plan 84-18, push 6; the D-12 approval "Grade from brackets").
// Run 5 (CI, 2026-10-18) failed leg 2's PACK ORDER STRICT with boundaries 4 and 8 both first read
// at tick 3180: its recorder had missed the 63 ticks before that record, so two boundaries crossed
// 40-odd ticks apart landed on one record. A boundary lies inside its bracket (the last reading
// below it, the first at or past it]; two consecutive boundaries are out of order only when no tick
// in the second bracket can be later than a tick in the first.
describe('the pack order graded from the boundary brackets (plan 84-18)', () => {
  const B = [4, 8, 12, 16, 20, 24] as const;
  /** Run 5's record, rebuilt from its own line: `PACK_ORDER ... ticks=3180,3180,3221,3309,3354,3406
   *  ... boundaryGaps=63,63,37,37,41,47` (each boundary's first record, and the ticks missed before it). */
  const RUN5 = [
    { t: 2717, packed: 0 },
    { t: 3116, packed: 2 },
    { t: 3180, packed: 9 },
    { t: 3183, packed: 10 },
    { t: 3221, packed: 13 },
    { t: 3271, packed: 15 },
    { t: 3309, packed: 17 },
    { t: 3312, packed: 18 },
    { t: 3354, packed: 21 },
    { t: 3358, packed: 22 },
    { t: 3406, packed: 24 },
  ];
  /** A run read on every tick, one slot every four ticks from the head back: in order. */
  const dense = (packedAt: (t: number) => number) => Array.from({ length: 120 }, (_, i) => ({ t: 1000 + i, packed: packedAt(1000 + i) }));

  it("PASSES run 5's record: boundaries 4 and 8 first read on one record after a 63-tick gap", () => {
    const firsts = B.map((k) => RUN5.find((r) => r.packed >= k)!.t);
    const gaps = B.map((k) => {
      const j = RUN5.findIndex((r) => r.packed >= k);
      return RUN5[j].t - RUN5[j - 1].t - 1;
    });
    expect({ firsts, gaps }).toEqual({ firsts: [3180, 3180, 3221, 3309, 3354, 3406], gaps: [63, 63, 37, 37, 41, 47] });
    expect(packOrderViolations(RUN5, B)).toEqual([]);
  });

  it('PASSES a run read on every tick that packs one slot at a time', () => {
    expect(packOrderViolations(dense((t) => Math.min(24, Math.floor((t - 1000) / 4))), B)).toEqual([]);
  });

  it('REFUSES a run that packs from the back (the mutant): the run from the head jumps 0 to 24 between two consecutive ticks', () => {
    const v = packOrderViolations(dense((t) => (t < 1060 ? 0 : 24)), B);
    expect(v.length).toBeGreaterThan(0);
    expect(v[0]).toMatch(/^boundary 8 was reached in the same tick as boundary 4/);
  });

  it('REFUSES two boundaries crossed between consecutive ticks', () => {
    const v = packOrderViolations(dense((t) => (t < 1050 ? Math.floor((t - 1000) / 7) : t < 1051 ? 7 : 13 + Math.floor((t - 1051) / 4))).map((r) => ({ ...r, packed: Math.min(24, r.packed) })), B);
    expect(v).toContainEqual(expect.stringMatching(/^boundary 12 was reached in the same tick as boundary 8/));
  });

  it('REFUSES a boundary never reached', () => {
    expect(packOrderViolations(RUN5.filter((r) => r.packed < 24), B)).toContainEqual('boundary 24 never reached');
  });
});
