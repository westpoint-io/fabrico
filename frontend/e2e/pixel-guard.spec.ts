import { test, expect, type Locator, type Page } from '@playwright/test';

// pixel-guard.spec.ts (QAGUARD-01, Plan 43-03) - the WebGL pixel/visual-regression
// gate for the render layer Phase 42 fixed. It drives the deterministic
// pixel-guard.html fixture (a root-level, non-build-input dev page) and screenshots
// FIVE surfaces, one per render-regression class, against committed chromium-linux
// baselines so a future sprite-size, corner-geometry, wire-pulse or wire-occlusion
// regression fails a gate instead of relying on a human's eyes:
//   - operator-footprint.png  ART-01 / RENDER-01  the VECTOR machine, drawn through
//                              the SHIPPED primitives (drawChassis +
//                              getAssetContext('router')) at the Router's base 2x3
//                              AND at a GROWN 2x4. Re-pointed in plan 58-06: it
//                              previously baked a Router through makeGenerators, and
//                              `machines.ts` no longer imports a generator at all, so
//                              the baked surface would have stayed green forever while
//                              the shipped machine path moved to vector underneath it.
//                              The grown cell is the only pixel-level evidence in the
//                              repo for the parametric chassis - `grow_to_fit` clamps
//                              at MAX_FOOTPRINT_DIM=64 while the legal `viewBox`
//                              whitelist has four entries, so a grown machine has no
//                              legal asset and the chassis has to be drawn in code.
//                              A chassis-geometry, glyph, shared-context, author-box
//                              centring or footprint-math regression flips this surface.
//   - belt-corner.png         RENDER-02  the SHIPPED VECTOR belt corner, drawn through
//                              the shipped painter's own `corner` tread context over its
//                              `cornerRails` context, at BOTH chiralities x three sampled
//                              march buckets. Re-pointed in plan 61-07: it previously
//                              composed a sheet of raster corner bakes into an
//                              <img>, and plan 61-03 had made the belt layer fully
//                              vector, so the baked sheet pinned bytes no user could see
//                              - the same "gate that stopped guarding the shipped path"
//                              failure the operator surface was moved off in 58-06. A
//                              corner-geometry, chirality, march or rail-band regression
//                              flips this surface.
//   - wire-comet.png          RENDER-03  the amber reply comet frozen mid-sweep on a
//                              fixed render clock (frac 0.5) - a wire-pulse/latch or a
//                              frac regression flips it.
//   - wire-occlusion.png      WIRE-02 / E6  the real belt, machine AND wire layers
//                              mounted TOGETHER over a scene carrying a machine, a belt
//                              run and TWO BENDING, CROSSING wires. Added in plan 66-05,
//                              in the same wave as the cable/terminal split. It is what
//                              closes the hole `wire-comet.png` leaves: that surface
//                              mounts the wire layer alone on an empty canvas, so it can
//                              never see an occlusion or a z-order change against a
//                              machine or a belt. A cables/terminals reorder, a
//                              machines-above-cables reorder, or a routing change that
//                              moves a crossing all flip this surface. Both deliberate
//                              reorders were RUN and seen to redden it before it was
//                              committed.
//   - vector-pilot.png        VEC-03     the pilot calibration asset
//                              (render/assets/pilot.svg) drawn three times from ONE
//                              shared GraphicsContext at scale 1, 2 and 1.77 - a
//                              tessellation, shared-context or antialias regression
//                              flips it.
//
// READ THIS BEFORE FILING THE vector-pilot BASELINE AS A BUG: at scale 1.77 the
// geometry lands on FRACTIONAL device pixels by design. With antialias off the
// rasteriser snaps each edge to a whole pixel, so "crisp" in this contract means NO
// SOFT EDGE - it does NOT mean the edge sits at the mathematically ideal position.
// The rounding contract is ANGLE/SwiftShader's, not ours. The baseline holds
// whatever that snapping produces; an edge one pixel off the ideal is the expected
// result, not a defect.
//
// DPR is pinned to 1 (deviceScaleFactor 1) so the backing-store size never varies with
// the host display density (the fixture also pins the Pixi resolution to 1). The
// baselines are chromium-linux PNGs; regenerate on ubuntu/chromium with
// `CI=1 npx playwright test pixel-guard --update-snapshots` (a stale dev server
// no-ops the regen, so CI=1 forces a fresh Vite spawn).
//
// TOLERANCE (empirical, RESEARCH A2/Q2 - do NOT assume 0 holds on the WebGL path):
// THREE surfaces hold maxDiffPixels:0 via EXACT - operator, belt corner AND vector
// pilot, and since plan 61-07 ALL THREE are live WebGL canvases. There is no longer a
// baked pixel-matrix surface on this fixture at all. They hold 0 because antialias is
// off, the Pixi resolution is pinned to 1 and the GL backend is pinned (VEC-05:
// --use-gl=angle --use-angle=swiftshader) - which is what the previous wording was
// already at pains to say: being canvas-FREE was never what earned a surface
// maxDiffPixels:0 here, so the belt corner's move onto a canvas cost it nothing. A
// reader who assumes otherwise will reach for a tolerance the first time a canvas
// surface flakes; the honest response to a vector surface that will not hold byte
// exactness is a FINDING, never a wider number. The
// wire-comet surface keeps its own separately-named constant below
// (COMET_SCREENSHOT_OPTS) whose value is also 0 - see 43-03-SUMMARY.md for the recorded
// two-run byte-stability outcome - so a future platform-flake can widen that ONE
// surface without touching the three exact ones.
//
// AND `maxDiffPixels: 0` NOW MEANS WHAT IT SAYS (phase 58). It did
// not before: Playwright's per-pixel `threshold` defaults to 0.2, giving pixelmatch a
// YIQ maxDelta of 35215 * 0.2^2 = 1408.6, so a whole ink swap scoring 616 passed this
// gate unnoticed. All four Playwright configs now pin `threshold: 0`, verified
// byte-neutral against every committed baseline. Do NOT loosen either number.

/**
 * The byte-exact surfaces (operator, belt corner, vector pilot and, since plan 66-05,
 * wire occlusion) hold maxDiffPixels:0 at the pinned `threshold: 0`. All FOUR are WebGL
 * canvases, and all four hold 0 for the same three reasons: AA is off, the resolution is
 * pinned and the GL backend is pinned. The occlusion surface qualifies because both of
 * its wires are IDLE in the frozen frame - there is no comet motion on it at all.
 */
const EXACT: { maxDiffPixels: number } = { maxDiffPixels: 0 };

// The WebGL comet surface tolerance. EMPIRICAL RESULT (Task 2, 43-03-SUMMARY.md): two
// fresh `--update-snapshots` runs produced BYTE-IDENTICAL PNGs for all three surfaces,
// INCLUDING this software-GL (SwiftShader, antialias-off, resolution-pinned) comet
// canvas. So maxDiffPixels:0 holds here too - no maxDiffPixelRatio fallback was needed
// (the fallback was pre-licensed by 43-CONTEXT.md but the WebGL path proved stable at
// 0). Keep the wider type so a future platform-flake can adopt maxDiffPixelRatio for
// THIS surface only without touching the byte-exact bake surfaces.
const COMET_SCREENSHOT_OPTS: { maxDiffPixels?: number; maxDiffPixelRatio?: number } = {
  maxDiffPixels: 0,
};

interface Surface {
  /** The render-regression class this surface guards. */
  readonly name: string;
  /** The committed baseline PNG name (chromium-linux suffix added by Playwright). */
  readonly baseline: string;
  /** Locate the single screenshot target inside the fixture. */
  readonly locate: (page: Page) => Locator;
  /** Per-surface tolerance (bake surfaces exact; comet empirically-decided). */
  readonly opts: { maxDiffPixels?: number; maxDiffPixelRatio?: number };
}

const SURFACES: readonly Surface[] = [
  {
    // The locator moved `img` -> `canvas` with the surface (plan 58-06). NOTE the
    // gate note at the bottom of this file: `tsconfig.json` includes `e2e` and
    // `e2e-live`, so `npx tsc --noEmit` typechecks every spec, but a wrong selector
    // string still typechecks, so the Playwright run is what catches a wrong locator.
    name: 'vector machine at base 2x3 + grown 2x4 (ART-01 / RENDER-01)',
    baseline: 'operator-footprint.png',
    locate: (page) => page.locator('#surface-operator canvas'),
    opts: EXACT,
  },
  {
    // The locator moved `img` -> `canvas` with the surface (plan 61-07), exactly as the
    // operator surface's did in 58-06. NOTE the gate note at the bottom of this file:
    // `npx tsc --noEmit` typechecks every spec (`tsconfig.json` includes `e2e` and
    // `e2e-live`), but a selector is a string it cannot judge, so the Playwright run is
    // what catches a wrong locator here - a stale `img` locator fails loudly rather than
    // silently, which is the good case, but only if the spec is actually run.
    name: 'belt corner apex (RENDER-02)',
    baseline: 'belt-corner.png',
    locate: (page) => page.locator('#surface-belt-corner canvas'),
    opts: EXACT,
  },
  {
    name: 'wire reply comet mid-sweep (RENDER-03)',
    baseline: 'wire-comet.png',
    locate: (page) => page.locator('#surface-wire-comet canvas'),
    opts: COMET_SCREENSHOT_OPTS,
  },
  {
    // ADDED BY PLAN 66-05, in the SAME WAVE as the cable/terminal layer split. Until
    // this row the ONLY wire baseline was `wire-comet.png`, which mounts the wire layer
    // ALONE on an empty canvas over a ONE-wire fixture: it proves painter order WITHIN a
    // wire and can never see a crossing, an occlusion, or a z-order change against a
    // machine or a belt, in either direction (66-UI-SPEC.md:1131-1132). This surface
    // mounts the REAL belt, machine and wire layers together over a scene carrying a
    // machine, a belt run and TWO BENDING, CROSSING wires. Two wires is load-bearing,
    // not decorative: the split reorders cables against terminals only at wire count
    // greater than one, so a one-wire surface would pass while blind to the one defect
    // the split can introduce.
    //
    // EXACT, not the comet tolerance: both wires are IDLE in the frozen frame, so
    // nothing on this canvas moves and there is no comet sub-pixel motion to absorb.
    //
    // NOTE the gate note at the bottom of this file: `npx tsc --noEmit` typechecks every
    // spec (`tsconfig.json` includes `e2e` and `e2e-live`), but a wrong selector string
    // still typechecks, so a wrong locator here is caught by running Playwright.
    name: 'wire vs machine and belt occlusion, two crossing wires (WIRE-02 / E6)',
    baseline: 'wire-occlusion.png',
    locate: (page) => page.locator('#surface-wire-occlusion canvas'),
    opts: EXACT,
  },
  {
    // ADDED BY PLAN 72-16, in the SAME commit as the union-box perimeter ring, because
    // MEASURED, no pixel or visual gate in this repository could see that shape at all:
    // both `wire-occlusion` cables decline at the ring's D2 gate (occlusion wire A has
    // leave_x and arrive_x true, wire B has leave_x and arrive_y true), and the
    // `wire-comet` path is hand-authored and never calls wireRoute. A change to
    // `ring_index`, to the ring's terminal runs, or to `clampEndToNub` would have moved
    // no committed pixel.
    //
    // The surface carries the row-aligned Route/Handler PAIR: the 4-cell REQUEST leg,
    // which declines at D2 and is unchanged since 72-15, and the 14-cell REPLY leg,
    // which is J-7's cable going around. The machine layer is mounted too, because the
    // defect J-7 named is a cable whose stroke starts inside the Handler's own chassis,
    // and that is only readable against a drawn chassis.
    //
    // EXACT, not the comet tolerance: both wires are IDLE in the frozen frame, so
    // nothing on this canvas moves.
    //
    // THE BASELINE WAS READ, NOT MERELY GENERATED, per the rule at `wires.ts` (and
    // 66-VERIFICATION.md, where an unblessed comet baseline shipped once already on this
    // exact code). WHAT IT SHOWS, at 320x192 on the darkest-ramp substrate: the 1x1 Route
    // at cell (2,2) drawn as an ENDPOINT with cyan nubs on its W and E faces and the
    // asymmetric inlet glyph; the 3x3 Handler chassis outline spanning cells (5,1)-(7,3)
    // with cyan nubs on its W face at (5,2) and its E face at (7,2). One straight
    // horizontal REQUEST cable runs nub-to-nub between the Route's E nub and the Handler's
    // W nub. The REPLY cable leaves the Handler's E nub heading EAST, one cell clear of
    // the chassis, turns south down the outside of the east wall, runs west along the row
    // one below both machines, turns north up the outside of the Route's west wall, and
    // turns east into the Route's W nub. Both of its ends terminate ON their nub squares.
    // NO cable stroke appears inside either chassis outline, which is J-7's defect: at
    // HEAD the reply started roughly 14 px inside the Handler's own chassis.
    //
    // OBSERVED REDDENING (run, observed, reverted): making the x arm of
    // `clampEndToNub` a no-op moves this baseline by 88 pixels. It also moves
    // `wire-occlusion` by 68, which is the cross-check that the mutation was real.
    //
    // NOTE the gate note at the bottom of this file: `npx tsc --noEmit` typechecks every
    // spec (`tsconfig.json` includes `e2e` and `e2e-live`), but a wrong selector string
    // still typechecks, so a wrong locator here is caught by running Playwright.
    name: 'the go-around reply cable, plugged in at both ends (J-7 / 72-16)',
    baseline: 'wire-goaround.png',
    locate: (page) => page.locator('#surface-wire-goaround canvas'),
    opts: EXACT,
  },
  {
    name: 'vector pilot at 1x / 2x / 1.77x (VEC-03)',
    baseline: 'vector-pilot.png',
    locate: (page) => page.locator('#surface-vector-pilot canvas'),
    opts: EXACT,
  },
];

for (const surface of SURFACES) {
  test(`pixel guard: ${surface.name}`, async ({ browser }) => {
    // Pin DPR so the backing-store size does not vary with the host display density.
    const ctx = await browser.newContext({ deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    try {
      await page.goto('/pixel-guard.html');

      // The fixture marks itself ready only after every surface has painted - one
      // Pixi frame rendered for each canvas surface, the belt corner included since
      // plan 61-07 turned it from a decoded <img> into a drawing. This IS the
      // fixture signal - not an app affordance. The readout is an out-of-flow data
      // marker (display:none), so wait for ATTACHED (not visible - a hidden element is
      // never "visible" and the default state would time out).
      await page
        .locator('#pixel-guard-readout[data-fixture-ready="1"]')
        .waitFor({ state: 'attached' });

      const target = surface.locate(page);
      await expect(target).toHaveScreenshot(surface.baseline, surface.opts);
    } finally {
      await ctx.close();
    }
  });
}

// VEC-03: antialias is ASSERTED, never assumed. It is the single condition under
// which maxDiffPixels:0 survives the move to vector geometry, so a silent flip to
// AA-on would soften every edge above and turn the whole gate into noise.
//
// The fixture derives `data-antialias` from the LIVE WebGL context's own
// getContextAttributes(), on every canvas it created - NOT from the source line
// pixiApp.ts:114. That is a strictly stronger claim: it reports what the GL driver
// actually built, so a driver that silently ignored `antialias: false` is caught,
// which reading the passed-in option can never do. A canvas with no readable
// context reports "1" and reddens this test rather than passing over a missing
// context. This assertion lives OUTSIDE the SURFACES loop and touches no
// screenshot.
//
// GATE NOTE: `tsconfig.json` includes `e2e` and `e2e-live` (since 2026-08-31; before
// that it held only `src` and `shared`), so `npx tsc --noEmit` typechecks every spec,
// this one included. Playwright still strips types without checking them, and tsc cannot
// judge a selector string or a readout value, so the Playwright run is the gate for what
// this test reads; tsc is the gate for its types.
test('pixel guard: antialias is OFF on every live canvas (VEC-03)', async ({ browser }) => {
  const ctx = await browser.newContext({ deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  try {
    await page.goto('/pixel-guard.html');
    const readout = page.locator('#pixel-guard-readout[data-fixture-ready="1"]');
    await readout.waitFor({ state: 'attached' });
    expect(
      await readout.getAttribute('data-antialias'),
      'every live pixel-guard canvas reports antialias off',
    ).toBe('0');
  } finally {
    await ctx.close();
  }
});
