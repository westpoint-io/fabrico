// legendBand.test.ts - the band model's REFUSALS, driven directly.
//
// WHY THIS FILE EXISTS (52 IN-01/WR-01). `Legend.test.tsx` asserts that the
// component interpolates the two numbers the test just handed it, which pins that
// the props are consumed and nothing more. Nothing at any level asserted that a
// NON-ZERO band is ever produced - and that was precisely the failure mode: 52-06
// early-returned on a missing dock, leaving the band at its `{0, 0}` seed, which
// renders `left: calc(0px + var(--fab-space-lg))` - the exact bottom-left dock
// whose occlusion of the Belt tool the strip exists to remove. The defect restored
// itself with no throw, no log and no red test.
//
// So the model is a pure function now, and every degradation path is a named
// refusal with a case below. These ARE the negative controls: each one fails if
// the guard is removed, which is what "fails closed" has to mean to be a gate.

import { describe, it, expect } from 'vitest';
import {
  cornerLeftsReachingStrip,
  computeLegendBand,
  LEGEND_MIN_STRIP_PX,
  LEGEND_MIN_CORNER_DOCKS,
  type LegendBandInput,
} from './legendBand';

/** The measured 1280x800 shape with a machine selected (Chromium, 2026-07-29):
 *  Palette right edge 198; CameraCluster/ConfigPanel left edges 1068/792;
 *  container 1280; `--fab-space-lg` 24. The bottom-right readout's 1048 left the
 *  set in plan 91-03 with the readout (CHROME-01). */
const LIVE_1280: LegendBandInput = {
  containerWidth: 1280,
  leftDockCount: 1,
  leftDockRightPx: 198,
  visibleCornerLeftsPx: [1068, 792],
  spaceLgPx: 24,
};

const at = (over: Partial<LegendBandInput>): LegendBandInput => ({ ...LIVE_1280, ...over });

describe('computeLegendBand - the happy path reproduces the LIVE measurement', () => {
  it('reserves the LEFTMOST right-docked surface, not the bottom-right cluster', () => {
    const r = computeLegendBand(LIVE_1280);
    expect(r.ok).toBe(true);
    // 1280 - 792 (the ConfigPanel, the leftmost of the two) = 488.
    expect(r.ok && r.band).toEqual({ paletteRightPx: 198, cornerInsetPx: 488 });
    // The kind of number the FIRST cut produced, kept here as the thing that must
    // NOT come back: reserving only the CameraCluster gives 1280 - 1068 = 212, which
    // would put the strip's right edge straight under the panel at 792.
    expect(r.ok && r.band.cornerInsetPx).not.toBe(212);
  });

  it('re-measures when the ConfigPanel unmounts (nothing is cached or literal)', () => {
    const r = computeLegendBand(at({ visibleCornerLeftsPx: [1068] }));
    expect(r.ok && r.band).toEqual({ paletteRightPx: 198, cornerInsetPx: 212 });
  });

  it('follows the Palette when it grows (the reason both bounds are measured)', () => {
    // The Palette is `width: fit-content` and grew 153 -> 174px this milestone.
    const grown = computeLegendBand(at({ leftDockRightPx: 260 }));
    expect(grown.ok && grown.band.paletteRightPx).toBe(260);
  });
});

describe('computeLegendBand - every degradation path fails CLOSED', () => {
  it('refuses when the left dock attribute has been dropped (the WINDOWS id 2 restore)', () => {
    expect(computeLegendBand(at({ leftDockCount: 0, leftDockRightPx: null }))).toEqual({
      ok: false,
      reason: 'no-left-dock',
    });
  });

  it('refuses when TWO elements claim the left-dock contract', () => {
    // `querySelector` would silently take the first in document order and re-point
    // the whole band with no type error and no test error.
    expect(computeLegendBand(at({ leftDockCount: 2 })).ok).toBe(false);
    expect(computeLegendBand(at({ leftDockCount: 2 }))).toEqual({
      ok: false,
      reason: 'ambiguous-left-dock',
    });
  });

  it('opens on the one permanent corner dock, and refuses when it has been dropped', () => {
    // Plan 91-03 (CHROME-01, D-02): the bottom-right readout was the second
    // permanent dock, and it is gone. With nothing selected the CameraCluster is the
    // only `data-fab-corner-dock` left, so one dock is the ordinary state and must
    // open the strip (at 2 the Legend never opened with nothing selected)...
    expect(computeLegendBand(at({ visibleCornerLeftsPx: [1068] }))).toEqual({
      ok: true,
      band: { paletteRightPx: 198, cornerInsetPx: 212 },
    });
    // ...while no dock at all means the cluster's attribute was dropped, and the
    // strip would run under the Fit and zoom controls.
    expect(computeLegendBand(at({ visibleCornerLeftsPx: [] }))).toEqual({
      ok: false,
      reason: 'too-few-corner-docks',
    });
    expect(LEGEND_MIN_CORNER_DOCKS).toBe(1);
  });

  it('refuses when a dock reports no box (a display:none dock reads offsetLeft 0)', () => {
    // This is the WR-02 inversion at ANY viewport size: an `offsetLeft` of 0 makes
    // `cornerInsetPx === containerWidth`. The caller filters on `offsetWidth > 0`,
    // so such a dock arrives here as an ABSENT one...
    expect(computeLegendBand(at({ visibleCornerLeftsPx: [] })).ok).toBe(false);
    // ...and if a zero ever did leak through, the room check catches it rather
    // than handing back an inverted strip.
    expect(computeLegendBand(at({ visibleCornerLeftsPx: [0, 1068] }))).toEqual({
      ok: false,
      reason: 'no-room',
    });
  });

  it('refuses a window too narrow for a strip instead of inverting it', () => {
    // tauri.conf.json is `"resizable": true` with NO `minWidth`. Below the point
    // where `left` + `right` cross, the used width of the absolutely-positioned box
    // floors at 0 while every row inside is `whiteSpace: nowrap`, so the content
    // cannot shrink and overflows to the right over the corner docks and the canvas.
    expect(computeLegendBand(at({ containerWidth: 480, visibleCornerLeftsPx: [240, 260] }))).toEqual(
      { ok: false, reason: 'no-room' },
    );
  });

  it('puts the room threshold exactly at LEGEND_MIN_STRIP_PX, and it BITES', () => {
    // Build a container that lands the strip one pixel either side of the floor:
    //   stripWidth = containerWidth - paletteRight - cornerInset - 2*gutter
    const exact = (stripWidthPx: number): LegendBandInput => {
      const containerWidth = 198 + 300 + 48 + stripWidthPx;
      return at({ containerWidth, leftDockRightPx: 198, visibleCornerLeftsPx: [containerWidth - 300, containerWidth - 280] });
    };
    expect(computeLegendBand(exact(LEGEND_MIN_STRIP_PX)).ok).toBe(true);
    expect(computeLegendBand(exact(LEGEND_MIN_STRIP_PX - 1))).toEqual({
      ok: false,
      reason: 'no-room',
    });
    // ...and the floor is BELOW the tightest supported band, so no shipped window
    // size trips it. Measured 2026-07-29 at 1024x768 with a machine selected: the
    // strip gets 372px.
    expect(LEGEND_MIN_STRIP_PX).toBeLessThan(372);
  });

  it('refuses when the --fab-space-lg gutter did not parse', () => {
    // `Number.parseFloat(getComputedStyle(...).getPropertyValue('--fab-space-lg'))`
    // is NaN if the token is ever renamed or the skin stylesheet has not landed.
    // NaN arithmetic would otherwise produce a NaN band and `left: calc(NaNpx ...)`.
    expect(computeLegendBand(at({ spaceLgPx: Number.NaN }))).toEqual({
      ok: false,
      reason: 'bad-gutter',
    });
    expect(computeLegendBand(at({ spaceLgPx: -1 })).ok).toBe(false);
  });

  it('refuses a container with no width (a detached or pre-layout tree)', () => {
    expect(computeLegendBand(at({ containerWidth: 0 }))).toEqual({
      ok: false,
      reason: 'bad-container',
    });
    expect(computeLegendBand(at({ containerWidth: Number.NaN })).ok).toBe(false);
  });

  it('NEVER returns a zero band - the shape that restored the defect', () => {
    const inputs: Partial<LegendBandInput>[] = [
      { leftDockCount: 0, leftDockRightPx: null },
      { leftDockCount: 3 },
      { visibleCornerLeftsPx: [] },
      { visibleCornerLeftsPx: [0] },
      { visibleCornerLeftsPx: [0, 1068] },
      { spaceLgPx: Number.NaN },
      { containerWidth: 0 },
      { containerWidth: 480, visibleCornerLeftsPx: [240, 260] },
    ];
    for (const over of inputs) {
      const r = computeLegendBand(at(over));
      expect(r.ok, `must refuse for ${JSON.stringify(over)}`).toBe(false);
      // The whole point: there is no branch that yields a paintable `{0, 0}`.
      expect(r).not.toHaveProperty('band');
    }
  });
});

describe('cornerLeftsReachingStrip - only a dock the strip would run under is reserved (review IN-B-04)', () => {
  const CLUSTER = { left: 1068, bottom: 776 };
  const SHORT_SOURCE = { left: 792, bottom: 521.6 };
  const TALL_ROUTER = { left: 792, bottom: 696 };
  it('a short inspector that ends above the strip is not reserved; the cluster always is', () => {
    expect(cornerLeftsReachingStrip([CLUSTER, SHORT_SOURCE], 696)).toEqual([1068]);
  });
  it('an inspector whose bottom reaches the strip top is reserved', () => {
    expect(cornerLeftsReachingStrip([CLUSTER, TALL_ROUTER], 640)).toEqual([1068, 792]);
  });
  it('a bottom exactly at the strip top does not reach it (they touch, they do not overlap)', () => {
    expect(cornerLeftsReachingStrip([CLUSTER, TALL_ROUTER], 696)).toEqual([1068]);
  });
  it('with no strip on screen every dock counts', () => {
    expect(cornerLeftsReachingStrip([CLUSTER, SHORT_SOURCE], null)).toEqual([1068, 792]);
    expect(cornerLeftsReachingStrip([CLUSTER, SHORT_SOURCE], Number.NaN)).toEqual([1068, 792]);
  });
});
