import { test, expect, type Browser } from '@playwright/test';
import { BELT_GEOM, CELL } from '../shared/geometry';

// THE BELT RAIL-CONTINUITY GATE (BELT-05 - plan 61-09).
//
// WHY IT EXISTS. `61-UI-SPEC` A8 held "a 1 world px rail may drop out at fractional
// zoom" out as a RISK TO MEASURE. Plan 61-03 measured it and it FAILED: over a ten-tile
// straight run at `antialias: false`, DPR 1, the vector belt lost a WHOLE RAIL at three
// of six camera scales and grew interior gap columns at a fourth. A follow-up then
// measured the PRE-PHASE raster belt at the same six scales (2026-08-10, a throwaway
// worktree at the annotated tag `phase-60-final`, since removed) and found the same
// defect class at two of six - so the class is INHERITED and this phase roughly doubled
// its frequency by moving the rails off the tile boundary onto interior rows. The maintainer ruled
// on 2026-08-10 that it is fixed inside this phase. This file is the gate on that fix.
//
// IT ASSERTS NUMBERS AND COMMITS NO IMAGE, and that is a choice rather than a shortcut.
// "Both rails present, with no interior gap columns" is a COUNT. A committed PNG of a
// ten-tile run would be a baseline that says nothing about whether the count held - it
// would go green on a rail that had vanished, as soon as it was blessed with the rail
// already gone. The fixture reads pixels back through Pixi's OWN extract path and
// publishes the counts; this spec reads them and does the arithmetic.
//
// IT CARRIES ITS OWN FAILING CONTROL, IN THE SAME RUN. The fixture draws every scale
// TWICE: once with the shipped device-quantum rail family, and once with a CONTROL
// family produced by calling the SAME emitter at quantum 1. At integer quanta the
// device rule takes its identity values, so `rails(skin, 1)` IS the pre-fix geometry,
// byte for byte - a control that cannot drift away from what it is controlling for, as
// a transcribed copy of the old code inevitably would. **A gate that cannot fail is not
// a gate**, and the control rows below are transcribed from the 2026-08-10 measurement
// rather than discovered here.
//
// SURFACE OWNERSHIP. This drives `#surface-belt-rail`, the FIFTH pixel-guard surface,
// which is additive and independently locatable. Plan 61-07 re-points the SEPARATE
// `#surface-belt-corner` surface at the shipped vector corner and blesses its baseline a
// second time; nothing here may become entangled with that.
//
// GATE NOTES. This is a MOCK-suite spec, which has no file-count pin; the live suite's
// twenty-file pin is untouched and no live spec is added. `npx tsc --noEmit` typechecks
// ZERO e2e specs (tsconfig includes only `src`/`shared`), so the Playwright run is the
// ONLY gate for this file - do not cite tsc for it. And the rasteriser here is
// CHROMIUM's, not the WebKitGTK one Fabrico ships on: Playwright-WebKit is not run in
// this suite, so Chromium is a backstop and never the verdict. The arithmetic the
// fix rests on is rasteriser-INDEPENDENT and is gated on the CPU in
// `src/render/synth/beltGeometry.test.ts`; this file is the evidence that the arithmetic
// reaches real pixels.

/** One rail band's continuity, as the fixture publishes it. */
interface RailBandReport {
  present: boolean;
  rows: number[];
  columns: number;
  total: number;
  gaps: number;
}

/** One tile-to-tile join, probed on both rail lanes over a 3-device-pixel window. */
interface SeamReport {
  index: number;
  flow: 'x' | 'y';
  laneA: number;
  laneB: number;
  window: number;
}

interface RailReport {
  run: string;
  scale: number;
  variant: 'shipped' | 'control';
  width: number;
  height: number;
  /** Whole-canvas band continuity. `null` for a run that is more than one cell deep. */
  north: RailBandReport | null;
  south: RailBandReport | null;
  /**
   * The 2 world px tread band, `null` for a run more than one cell deep.
   *
   * ADDED in the phase-69 follow-up, not invented: `src/spike/pixelGuard.tsx:464`
   * publishes it and the low-zoom clamp case at the foot of this file reads it. This
   * mirror interface had simply drifted from the fixture's, and nothing noticed
   * because `e2e/` was outside `tsconfig.json`'s include.
   */
  tread: RailBandReport | null;
  /** Per-join seam windows, for EVERY run - straight and bent alike. */
  seams: SeamReport[];
}

/**
 * The three probed runs and how many joins each has.
 *
 * `bend` carries BOTH mixed joins (straight-to-corner and corner-to-straight); `sbend`
 * carries a CORNER-TO-CORNER join, which is the hard case - no straight neighbour
 * overhangs it, so it is closed entirely by the corner emitter's own swept extension.
 */
const RUNS: ReadonlyArray<{ name: string; joins: number }> = [
  { name: 'straight', joins: 9 },
  { name: 'bend', joins: 4 },
  { name: 'sbend', joins: 5 },
];

/**
 * The six camera scales, transcribed from the measurement rather than re-chosen.
 *
 * 0.75 is the belt LOD cut (`belts.ts LOD_MIN_TREAD_PX` 24 over `CELL` 32), i.e. the
 * LOWEST zoom at which the full-detail tread is selected at all; 1.00 is the identity.
 */
const SCALES = [0.75, 0.8, 0.85, 0.9, 0.95, 1] as const;

/**
 * WHAT THE PRE-FIX GEOMETRY DOES, TRANSCRIBED FROM THE 2026-08-10 MEASUREMENT.
 *
 * `north` / `south` are the two rail bands. `absent` means the band was not drawn
 * ANYWHERE across the run - the whole-rail dropout that is worse than the "dropouts
 * along a run" A8 anticipated. `gaps` is the count of interior device columns the band
 * fails to cover.
 *
 * The two `ok` rows are load-bearing evidence in their own right: the control is not
 * uniformly broken, so the four failing rows are a property of those particular
 * fractional scales and not of a control that draws nothing.
 */
const CONTROL_EXPECTED: Record<
  string,
  { north: 'absent' | number; south: 'absent' | number }
> = {
  '0.75': { north: 0, south: 'absent' },
  '0.8': { north: 0, south: 0 },
  '0.85': { north: 0, south: 'absent' },
  '0.9': { north: 8, south: 8 },
  '0.95': { north: 4, south: 'absent' },
  '1': { north: 0, south: 0 },
};

/** The four scales at which the pre-fix geometry is BROKEN - 4 of 6. */
const CONTROL_FAILING_SCALES = [0.75, 0.85, 0.9, 0.95] as const;

async function readReports(browser: Browser): Promise<RailReport[]> {
  // DPR pinned to 1, exactly as `pixel-guard.spec.ts` pins it: the defect is a
  // DEVICE-pixel defect, so the device-pixel ratio is not allowed to vary with the host
  // display. At DPR 2 the LOD cut already floors the quantum at 1.5 and the whole class
  // cannot occur, which is why this must be measured at 1.
  const ctx = await browser.newContext({ deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  try {
    await page.goto('/pixel-guard.html');
    const readout = page.locator('#pixel-guard-readout[data-fixture-ready="1"]');
    await readout.waitFor({ state: 'attached' });
    const raw = await readout.getAttribute('data-rail-continuity');
    expect(raw, 'the fixture published no rail-continuity payload').toBeTruthy();
    return JSON.parse(raw as string) as RailReport[];
  } finally {
    await ctx.close();
  }
}

const pick = (reports: RailReport[], run: string, scale: number, variant: string): RailReport => {
  const found = reports.find(
    (r) => r.run === run && r.scale === scale && r.variant === variant,
  );
  expect(found, `no ${variant} report for the ${run} run at scale ${scale}`).toBeDefined();
  return found as RailReport;
};

test('belt rails: BOTH present with ZERO gap columns at all six camera scales', async ({
  browser,
}) => {
  const reports = await readReports(browser);

  // NON-VACUITY FIRST. A run that produced no reports, or reports over a zero-width
  // canvas, would satisfy every "no gaps" assertion below by having nothing to gap.
  expect(reports.length, 'the fixture drew nothing').toBeGreaterThan(0);

  for (const scale of SCALES) {
    const r = pick(reports, 'straight', scale, 'shipped');
    expect(r.width, `scale ${scale} canvas width`).toBeGreaterThan(0);
    for (const side of ['north', 'south'] as const) {
      const band = r[side] as RailBandReport;
      expect(band, `scale ${scale}: the straight run must report a ${side} band`).toBeTruthy();
      expect(band.present, `scale ${scale}: the ${side} rail is ABSENT`).toBe(true);
      // FULL coverage, not merely "no interior gaps": the rail runs edge to edge of the
      // canvas, so a rail that had lost its first or last tile cannot pass by having no
      // gap BETWEEN what remains.
      expect(band.columns, `scale ${scale} ${side} rail column coverage`).toBe(band.total);
      expect(band.gaps, `scale ${scale} ${side} rail interior gap columns`).toBe(0);
      // Exactly one device row of rail - the `max(1, round(rail * q))` floor doing its
      // job, and NOT a thickened rail (53-BELT-LOCK axis 2 is locked and this phase
      // carries no signature for it).
      expect(band.rows, `scale ${scale} ${side} rail row count`).toHaveLength(1);
    }
    // THE LANE IS SYMMETRIC ABOUT THE SNAPPED TILE CENTRE, so the fix cannot have
    // bought continuity by sliding one rail inward. The centre is the tile centre
    // rounded onto the device grid (`belts.ts` snaps every tile position at the same
    // quantum), NOT the canvas mid-line, which differs from it whenever `CELL * scale`
    // is not an even number of device px.
    //
    // A row INDEX is the band's TOP edge, so the north band's top is `c - d` and the
    // south band's is `c + d - t`; at the one-device-pixel thickness the fix guarantees,
    // their sum is `2c - 1` for any `d`. Stating the identity that way is what makes it
    // independent of `d`, which legitimately moves with the scale.
    const centreRow = Math.round((CELL / 2) * scale);
    const north = r.north as RailBandReport;
    const south = r.south as RailBandReport;
    expect(north.rows[0] + south.rows[0], `scale ${scale} lane symmetry`).toBe(
      2 * centreRow - BELT_GEOM.rail,
    );
    // ... and the north band really is above the centre, so the sum above cannot be
    // satisfied by two bands on the same side of it.
    expect(north.rows[0], `scale ${scale} north band position`).toBeLessThan(centreRow);
    expect(south.rows[0], `scale ${scale} south band position`).toBeGreaterThanOrEqual(
      centreRow,
    );
  }
});

test('the CONTROL fails in the same run, at the rows the 2026-08-10 measurement recorded', async ({
  browser,
}) => {
  const reports = await readReports(browser);

  const broken: number[] = [];
  for (const scale of SCALES) {
    const r = pick(reports, 'straight', scale, 'control');
    const want = CONTROL_EXPECTED[String(scale)];
    for (const side of ['north', 'south'] as const) {
      const band = r[side] as RailBandReport;
      const expected = want[side];
      if (expected === 'absent') {
        expect(band.present, `control scale ${scale}: the ${side} rail should be ABSENT`).toBe(
          false,
        );
        expect(band.columns).toBe(0);
      } else {
        expect(band.present, `control scale ${scale} ${side} rail`).toBe(true);
        expect(band.gaps, `control scale ${scale} ${side} interior gap columns`).toBe(expected);
      }
    }
    if (want.north === 'absent' || want.south === 'absent' || want.north > 0 || want.south > 0) {
      broken.push(scale);
      // Restated as the gate's OWN predicate rather than only as the transcribed table:
      // whatever the mode, the control fails the continuity test this file applies to
      // the shipped family.
      const failed = (['north', 'south'] as const).some((side) => {
        const b = r[side] as RailBandReport;
        return !b.present || b.columns !== b.total || b.gaps > 0;
      });
      expect(failed, `control scale ${scale} should FAIL the continuity gate`).toBe(true);
    }
  }

  // FOUR OF SIX, as the measurement recorded. Pinned as a count so a control that
  // silently started passing everywhere - which is what a broken control looks like -
  // reddens here rather than quietly turning this gate into a tautology.
  expect(broken).toEqual([...CONTROL_FAILING_SCALES]);
  expect(broken).toHaveLength(4);
  expect(SCALES).toHaveLength(6);
});

test('shipped and control differ at exactly the scales the fix was needed at', async ({
  browser,
}) => {
  // THE PAIRED READ, which neither test above makes on its own: at the four broken
  // scales the shipped family draws MORE rail than the control, and at the two scales
  // the control already handled they draw the SAME amount. The second half is what says
  // the fix is a repair rather than a re-art - it does not touch what already worked.
  const reports = await readReports(browser);
  for (const scale of SCALES) {
    const shipped = pick(reports, 'straight', scale, 'shipped');
    const control = pick(reports, 'straight', scale, 'control');
    const total = (r: RailReport): number =>
      (r.north as RailBandReport).columns + (r.south as RailBandReport).columns;
    if ((CONTROL_FAILING_SCALES as readonly number[]).includes(scale)) {
      expect(total(shipped), `scale ${scale} shipped vs control coverage`).toBeGreaterThan(
        total(control),
      );
    } else {
      expect(total(shipped), `scale ${scale} coverage is untouched`).toBe(total(control));
      // ... and on the same device rows, which is the pixel-level form of the
      // integer-quantum identity that keeps every committed PNG baseline unmoved.
      expect((shipped.north as RailBandReport).rows).toEqual(
        (control.north as RailBandReport).rows,
      );
      expect((shipped.south as RailBandReport).rows).toEqual(
        (control.south as RailBandReport).rows,
      );
    }
  }
});

test('every JOIN is rail-continuous - straight, single bend and S-bend alike', async ({
  browser,
}) => {
  // THE SEAM PROBE, WHICH IS WHAT A BENT RUN NEEDS. On a straight run "no gap columns"
  // is a whole-canvas column count; through a bend the rails are ARCS, so most columns
  // of a corner cell carry no ink on the straight's rows BY CONSTRUCTION and a
  // whole-canvas count would report a gap that is not one. The defect is a SEAM defect,
  // so the probe is the seam: a three-device-pixel window centred on each join, on each
  // lane, which must be fully inked.
  const reports = await readReports(browser);

  for (const { name, joins } of RUNS) {
    for (const scale of SCALES) {
      const r = pick(reports, name, scale, 'shipped');
      // NON-VACUITY: the run really has the joins it claims, so "every seam is full"
      // cannot pass over an empty list.
      expect(r.seams, `${name} at ${scale} join count`).toHaveLength(joins);
      for (const seam of r.seams) {
        expect(seam.window, 'the window must be wide enough to see a 1px gap').toBe(3);
        expect(
          seam.laneA,
          `${name} at ${scale}: join ${seam.index} (flow ${seam.flow}) lane A`,
        ).toBe(seam.window);
        expect(
          seam.laneB,
          `${name} at ${scale}: join ${seam.index} (flow ${seam.flow}) lane B`,
        ).toBe(seam.window);
      }
    }
  }

  // The bent runs really do turn, so the corner families are actually being exercised:
  // a run whose joins were all one axis would be a straight run wearing a bend's name.
  for (const name of ['bend', 'sbend']) {
    const axes = new Set(pick(reports, name, 1, 'shipped').seams.map((s) => s.flow));
    expect(axes, `${name} must contain joins on BOTH axes`).toEqual(new Set(['x', 'y']));
  }
  // The S-bend's corner-to-corner join is the one with no straight neighbour to overhang
  // it. It is the third join of that run (indices 2, between the two corner tiles), and
  // naming it here is what stops the case being satisfied by five easy joins.
  const sbend = pick(reports, 'sbend', 0.9, 'shipped');
  expect(sbend.seams[2].laneA).toBe(3);
  expect(sbend.seams[2].laneB).toBe(3);
});

test('the CONTROL breaks the same joins, on the bends as well as on the straight', async ({
  browser,
}) => {
  // The seam probe's own failing control, on all three runs. It fails at exactly the
  // four scales the 2026-08-10 measurement recorded and passes at the other two, so the
  // seam gate above is discriminating rather than tautological - including at the
  // corner-to-corner join, which no straight tile can rescue.
  const reports = await readReports(browser);

  for (const { name } of RUNS) {
    const brokenScales: number[] = [];
    for (const scale of SCALES) {
      const r = pick(reports, name, scale, 'control');
      const broken = r.seams.some((s) => s.laneA !== s.window || s.laneB !== s.window);
      if (broken) brokenScales.push(scale);
    }
    expect(brokenScales, `${name}: the control must break at exactly the measured scales`)
      .toEqual([...CONTROL_FAILING_SCALES]);
  }

  // ... and the corner-to-corner join specifically, which is the join the corner
  // emitter's swept extension exists for. Named rather than left inside the sweep above,
  // because it is the one join whose repair has no second mechanism behind it.
  for (const scale of CONTROL_FAILING_SCALES) {
    const control = pick(reports, 'sbend', scale, 'control');
    const shipped = pick(reports, 'sbend', scale, 'shipped');
    const cornerToCorner = control.seams[2];
    expect(
      cornerToCorner.laneA + cornerToCorner.laneB,
      `control sbend at ${scale}: the corner-to-corner join should be broken`,
    ).toBeLessThan(2 * cornerToCorner.window);
    expect(shipped.seams[2].laneA + shipped.seams[2].laneB).toBe(2 * shipped.seams[2].window);
  }
});

// ---------------------------------------------------------------------------
// THE ONE HAZARD THE DEVICE RULE DELIBERATELY CANNOT REACH (plan 61-09)
// ---------------------------------------------------------------------------
//
// THE ARITHMETIC. The tread band is 2 WORLD px across flow, so it is at least one device
// pixel wide only while the quantum is at or above 0.5. The full-detail band never goes
// below 0.75 (the LOD cut), so the full-detail tread is safe. The LOW-ZOOM tick is
// selected below that cut, and the camera's minimum-zoom clamp (`belts.ts MIN_SCALE`)
// allows a quantum of 0.25 at DPR 1 - where the band is HALF a device pixel and can
// contain no pixel centre at all.
//
// IT IS NOT FIXED HERE, AND THE REASON IS A PROPERTY OF THE DESIGN RATHER THAN OF THE
// CALENDAR. The tread lives inside the SCALE-FREE cached contexts. Applying the device
// rule to it would make the tread geometry scale-dependent, which is exactly the
// property plan 61-09 spent its whole argument preserving (it is why the rails LEFT
// those contexts instead of the contexts acquiring a quantum). Fixing it would need the
// tread to move out too, which is a different design.
//
// OWNER: plan 61-08, for a `WINDOWS.md` row.
const LOW_ZOOM_CLAMP = 0.25;

test('RAISED, not fixed: the low-zoom TREAD band at the minimum-zoom clamp', async ({
  browser,
}) => {
  const reports = await readReports(browser);
  const r = pick(reports, 'straight', LOW_ZOOM_CLAMP, 'shipped');
  const tread = r.tread as RailBandReport;
  expect(tread, 'the fixture must measure the tread band at the clamp').toBeTruthy();

  // THE MEASURED NUMBER, RECORDED AS AN ASSERTION so the finding cannot rot into prose.
  // **IF THIS CASE EVER REDDENS, THE HAZARD HAS BEEN FIXED** - close the WINDOWS row and
  // update this case deliberately. Do NOT re-bless the number to make it pass again.
  expect(tread.present, `the low-zoom tread band at quantum ${LOW_ZOOM_CLAMP}`).toBe(false);
  expect(tread.columns, 'device columns carrying the low-zoom tread band').toBe(0);
  expect(r.width, 'the run really is 80 device px wide at the clamp').toBe(80);

  // THE RAILS, BY CONTRAST, SURVIVE THERE - which is what says the hazard is about the
  // TREAD and not about low zoom in general, and that the rail fix reaches below the six
  // gate scales even though the gate does not assert there.
  const north = r.north as RailBandReport;
  const south = r.south as RailBandReport;
  expect(north.present, 'the north rail at the minimum-zoom clamp').toBe(true);
  expect(south.present, 'the south rail at the minimum-zoom clamp').toBe(true);
  expect(north.columns).toBe(north.total);
  expect(south.columns).toBe(south.total);

  // AND THE THRESHOLD, as arithmetic rather than as a claim: the band is BELT_GEOM.band
  // world px, so it clears one device pixel exactly when the quantum reaches 1/band.
  expect(BELT_GEOM.band).toBe(2);
  expect(1 / BELT_GEOM.band).toBe(0.5);
  expect(LOW_ZOOM_CLAMP).toBeLessThan(1 / BELT_GEOM.band);
  // ... while the LOD cut floors the FULL-detail quantum at 0.75, safely above it.
  expect(24 / CELL).toBe(0.75);
  expect(24 / CELL).toBeGreaterThan(1 / BELT_GEOM.band);
});
