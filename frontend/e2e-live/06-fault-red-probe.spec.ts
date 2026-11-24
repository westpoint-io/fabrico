import { test, expect, type Page } from './support/liveTest';
// The PNG decoder @playwright/test already bundles (pngjs). No new dependency is
// added by this spec - we reach the bundled decoder rather than installing one
// (the same idiom as e2e/dpr-crispness.spec.ts).
// eslint-disable-next-line @typescript-eslint/no-var-requires
import { PNG } from 'playwright-core/lib/utilsBundle';
import {
  DEMO_NODE_COUNT,
  captureClip,
  CAPTURE_FRAMES,
  CAPTURE_POLL_TRIES,
  DRAWN_STATE_FRAMES,
  readScene,
  pollScene,
  loadDemoViaExamples,
  waitForAppReady,
  cameraOf,
  watchPageErrors,
  expectRenderLoopAlive,
  type SceneFacts,
} from './support/oracle';
import { addWaitBudget, frameBudgetMs } from '../e2e/support/frameSampler';
// The single allowed shared import (GATE-01): the pure, product-free geometry +
// oracle values module. nubAnchor computes the nub screen point from the
// oracle-read port facts, and rampOracles.locked[3] is the skin-schema DIM step
// (mirrors LOCKED_SKIN.palette.ramp[3]) - the probe NEVER hardcodes a hex.
// rampOracles is intentionally NOT re-exported from oracle.ts; this spec stays
// self-contained by importing it straight from the shared source.
//
// BELT-07 / VEC-01 (plan 61-05) adds a second measurement to this file and takes four
// more values from the same shared source: CELL and BELT_GEOM size the belt lane strip
// the probe samples, cellCentreX/Y put it on screen, rampOracles.locked[4] is the belt
// tread's own ink and colorOracles.itemHalo is the item-dot accent. Same rule as
// above, and it is the file's standing one: EVERY expected colour comes from the skin
// schema and EVERY coordinate from the scene oracle.
import {
  BELT_GEOM,
  CELL,
  cellCentreX,
  cellCentreY,
} from '../shared/geometry';

// WHAT IS LEFT IN THIS FILE. One test: SLOT-04 in the BELT-07 describe, which checks that
// trailing interpolation keeps the render loop alive and error-free while item dots move.
// The Fault-nub pixel probe and the two item-dot pixel probes this file was written for were
// cut: 92-red-means-faulted.live.spec.ts reads the fault nub's neutral grey by pixel, and
// 93-boards-load.live.spec.ts shows an item drawn on the demo's first belt. The history below
// still explains the machinery SLOT-04 uses (the lane strip, the clock pin, the chrome-clear
// bounds and the demo reset).
//
// 06-fault-red-probe.spec.ts (GATE-03 / RENDER-04) - a checked-in SECONDARY live
// pixel probe proving the FACTORY Fault OUTPUT-NUB renders HONESTLY: a freshly
// placed, NON-faulted FACTORY paints its role-2 Fault nub DIM/OUTLINE
// (rampOracles.locked[3] = ramp[3]), NOT a stuck fault red. The dim step is read
// from the skin schema (never a literal hex) and the nub is located from the scene
// oracle (never a baked coordinate).
//
// WHY the read is deterministic WITHOUT any fault-driving choreography:
//   machines.ts nubColor() returns the dim ramp[3] for role === 2 in EVERY machine
//   state, so a freshly placed FACTORY paints the DIM step by construction. Driving
//   a real fault is non-deterministic (fault backpressure choreography) and is an
//   explicit anti-pattern for this probe.
//
//   CORRECTED 2026-08-02 (the maintainer's ruling on the 58 code review's CR-01, "Option A").
//   This block used to say nubColor "returns accents.fault ONLY when state ===
//   FAULTED", which made the probe's determinism argument rest on the machine not
//   being faulted. It no longer does: NO nub is ever accents.fault now, in any role
//   or state, because the FAULTED alert ring strokes that accent through the band
//   every nub silhouette crosses and the two fused into one red mass. The probe's
//   assertion is unchanged and now holds for a STRONGER reason - the dim step is
//   unconditional. The ring-versus-nub ink separation is gated in
//   frontend/src/render/layers/machineState.test.ts; a FAULTED machine has still
//   never been rasterised by any gate (WINDOWS row 28).
//
//   EXTENDED 2026-10-25 (phase 92, CHROME-18, D-06). A belt DOCKED at a fault exit
//   used to end in a solid cap in the fault accent, so a docked fault exit stayed red
//   at rest even though this nub read the dim step. That cap is now neutral too: the
//   fault nub's own ramp[3], drawn as a ring around a core so shape, not hue, carries
//   the role. The cap's live grade is e2e-live/92-red-means-faulted.live.spec.ts (the
//   whole-board red count on the paused demo and the cap-ring pixel); this probe's
//   assertions are unchanged.
//
// WHY a freshly-PLACED factory rather than the demo factory in-place (the
// probe-location correction that IS this plan's purpose): the demo scene renders
// at the world origin under the IDENTITY camera, and that top-left region is
// OCCLUDED by the app chrome - the top toolbar (top ~95px) and the left machine
// palette panel (left ~210px, whose fill is ramp[2]). The demo FACTORY's Fault
// nub at world (176,160.5) lands BEHIND the palette panel and cannot be read
// (this is exactly the "wrong location" the old carry-in fell into). Placing a
// fresh FACTORY in a CLEAR grid region via the shipped palette drag puts a
// role-2 Fault nub where it is actually composited.
// Under the 29-04 boot-fit the camera is NO LONGER identity, so both the drop
// point and the nub sample are routed through the live camera (screenCellCentre
// / screenPoint read window.__fabrico.camera()); the role-driven skin contract
// is unchanged and the coordinate is still read from the oracle. Any FACTORY
// proves the identical contract.
//
// WHY pinClock is safe: window.__fabrico.pinClock(0) is the Phase 26-01
// render-clock freeze (MOTION-04). It writes ONLY the render clock (a display
// concern) - never scene.tick, a GridCommand, or the event log - and is
// production-inert (null default). It is READ-adjacent: it stills render motion
// so the screenshot is a stable single frame; it never mutates sim state.
//
// Drive rules (LOCKED, the same as 05-undo-strand-ring): page.mouse +
// getByTitle to ISSUE; page.evaluate for READS/render-pin ONLY (never to issue a
// command); every wait is a pollScene predicate with a message; NO fixed sleeps;
// ZERO mocks (runs against the real dev_render_server).

/**
 * Reset the SHARED live host to the known demo baseline via the shipped
 * Load-demo CTA (a genesis-swap reset). dev_render_server persists
 * scene state across tests, so this clears any factory a prior run placed - the
 * probe drop cell is free every run and placement is deterministic. LoadDemo
 * restarts the sim tick, so polling for the tick dropping below the pre-click
 * value proves the swap folded, and nodes.length === DEMO_NODE_COUNT pins it.
 */
async function loadDemoReset(page: Page): Promise<void> {
  const tickBefore = (await readScene(page)).tick;
  await loadDemoViaExamples(page);
  await pollScene(page, (s) => s.tick < tickBefore && s.nodes.length === DEMO_NODE_COUNT, {
    message:
      'the LoadDemo genesis swap folded (sim tick restarted below the pre-click tick) onto the demo baseline',
  }).toBe(true);
}

// ===========================================================================
// BELT-07 / VEC-01 (plan 61-05): the item dot on the LIVE Chromium path.
// ===========================================================================
//
// WHY THIS LIVES HERE AND NOT IN NODE VITEST. `61-VALIDATION.md` maps BELT-07 to
// "node vitest + Chromium live e2e", and the vitest half cannot reach what these two
// cases assert: every unit assertion in `interp.test.ts` and `layers/items.test.ts`
// runs against emitted point lists and a HEADLESS layer whose pixi.js is a stub. The
// reason this project keeps a live suite at all is that an injected-packet suite once
// stayed green while the shipped default scene was broken.
//
// WHY IT EXTENDS THIS FILE RATHER THAN ADDING ONE. `dev_render_server` stalls
// emergently after about eleven SPEC FILES, so a new file is a suite-wide hazard - and
// this file is already the live suite's ONLY canvas pixel probe. It has the bundled
// PNG decoder, the oracle-located read point and the skin-schema colour reads this
// measurement needs, so extending it costs no new machinery. (`01-default-scene` was
// the other candidate and is the wrong one: it is a cold-boot spec that performs no
// gesture and must run first.)
//
// WHAT IS MEASURED, AND WHY IT IS A MEASUREMENT RATHER THAN AN ASSERTION. The two
// sample points are found by criteria that are INDEPENDENT of the values expected of
// them - the dot by maximum WARMTH (`r - b`; the whole substrate ramp is cool, so only
// an accent can be warm at all), the tread by AREA (the second most common cool colour
// in the lane, the first being the board the belt sits on). Only THEN are they
// compared against the skin schema. Searching for "the pixel that equals the accent"
// would have made the comparison circular; this way a dot rendering dimmed, blended or
// in the wrong ink is found and then fails.
//
// THE TREAD IS FOUND BY AREA AND NOT BY BRIGHTNESS, AND THAT IS A CORRECTION MADE
// AGAINST A MEASUREMENT rather than a preference. Brightness was tried first and is
// WRONG: a WORKING-state emerald pixel (relative luminance 0.4962) outbrightens the
// belt's own tread ink (0.4867), so on any run where a machine happened to be working
// the "brightest cool pixel" was a machine cue and not the belt. Measured live,
// 2026-08-10: 32 emerald pixels against 1120 of tread in the same strip. Area
// separates them by 35x and does not depend on machine state, so it is the criterion
// that actually identifies the thing being named.
//
// THE 1.11 FLOOR IS ONE-SIDED ON PURPOSE. The dot-against-tread greyscale separation
// is INHERITED, not introduced: today's wider lane carries the identical pairing, and
// plan 61-05 is not licensed to improve it - the dot is a locked cell (53-BELT-LOCK.md
// axis 5) and a halo would need its own signed supersession. So this gate can only
// catch the conversion making it WORSE.

/**
 * The belt tread mark is only drawn at full detail above the layer's LOD cut
 * (`belts.ts LOD_MIN_TREAD_PX` = 24 device px per tile). The demo boots fitted at
 * roughly a third of a cell, where the belt draws its bold low-zoom tick instead, so
 * the probe zooms IN to a whole cell before sampling - real wheel events over the real
 * canvas, exactly as `10-machine-lod.spec.ts` drives the opposite direction.
 *
 * Mirrored here as a target rather than imported: `e2e-live/` may import the shared
 * geometry module and nothing else from the product (GATE-01).
 */
const LOD_MIN_TREAD_PX = 24;

/** Chrome-clear bounds: the top toolbar is about 95 px tall and the left palette about 210 px wide. */
const CHROME_CLEAR_X = 210;
const CHROME_CLEAR_Y = 95;

/** One belt run selected for sampling: its screen strip and the facts behind it. */
interface LaneStrip {
  beltId: number;
  tiles: number;
  /** The strip's tiles as `x,y` cell keys, so a model wait can ask for an item on them. */
  cells: string[];
  clip: { x: number; y: number; width: number; height: number };
}

/** `fabrico_core` `SLOTS_PER_TILE`, transcribed: four item slots per belt tile. */
const SLOTS_PER_TILE = 4;

/**
 * Whether the model holds an item on one of the strip's tiles (plan 84-18). A belt's slots count
 * from its HEAD (slot 0, the deliver end) and its tiles from its tail, so slot `s` of a belt of
 * `n` slots lies on tile `floor((n - 1 - s) / SLOTS_PER_TILE)` (the composed walk's
 * `modelItemsPerCell`).
 */
function itemOnStrip(scene: SceneFacts, strip: LaneStrip): boolean {
  const belt = scene.belts.find((b) => b.id === strip.beltId);
  if (belt === undefined) return false;
  const slots = belt.tiles.length * SLOTS_PER_TILE;
  return belt.occupiedSlots.some((s) => {
    const tile = belt.tiles[Math.floor((slots - 1 - s) / SLOTS_PER_TILE)];
    return tile !== undefined && strip.cells.includes(`${tile.cell_x},${tile.cell_y}`);
  });
}

/**
 * Drive REAL wheel-zoom IN over the canvas centre until a belt tile is at least
 * `LOD_MIN_TREAD_PX` device px across, so the marching tread is drawn at full detail.
 * Bounded and clamp-aware, mirroring `10-machine-lod.spec.ts`; polls the live camera
 * after every notch, never sleeps.
 */
async function zoomToFullBeltDetail(page: Page): Promise<number> {
  const viewport = page.viewportSize();
  expect(viewport, 'the live viewport size is known').not.toBeNull();
  await page.mouse.move(viewport!.width / 2, viewport!.height / 2);

  let cam = await cameraOf(page);
  for (let i = 0; i < 60 && cam.scale * CELL < LOD_MIN_TREAD_PX; i++) {
    await page.mouse.wheel(0, -200); // negative delta -> zoom IN (shipped onWheel)
    const next = await cameraOf(page);
    if (Math.abs(next.scale - cam.scale) < 1e-6) {
      cam = next;
      break; // the max-zoom clamp pinned the scale; no further movement is possible
    }
    cam = next;
  }
  expect(
    cam.scale * CELL,
    `the wheel-in drove the belt tile size to the full-detail tread cut (${LOD_MIN_TREAD_PX}px)`,
  ).toBeGreaterThanOrEqual(LOD_MIN_TREAD_PX);
  return cam.scale;
}

/**
 * Choose a belt run to sample and compute its LANE STRIP in screen px.
 *
 * EVERY COORDINATE COMES FROM THE SCENE ORACLE. The belt's own `tiles[]` give the
 * cells; the live camera maps them to screen. The strip is clipped to the LANE
 * (`+/- BELT_GEOM.laneHalf` about the run's centreline) rather than to the tile boxes,
 * so a machine in a neighbouring row cannot enter the sample.
 *
 * Only HORIZONTAL runs are considered, and only tiles whose whole cell clears the
 * chrome and sits inside the viewport - the two guards the cut Fault-nub probe used,
 * for the same reason: sampling panel fill instead of the board is the carry-in
 * failure mode this file was rewritten to avoid.
 */
async function laneStripOf(page: Page, scene: SceneFacts): Promise<LaneStrip> {
  const cam = await cameraOf(page);
  const viewport = page.viewportSize();
  expect(viewport, 'the live viewport size is known').not.toBeNull();
  const half = (CELL / 2) * cam.scale;
  const laneHalf = BELT_GEOM.laneHalf * cam.scale;

  const candidates: LaneStrip[] = [];
  for (const belt of scene.belts) {
    // A belt is a ROUTED PATH, not a row: the demo's longest run turns a corner, so the
    // strip is cut from the longest CONTIGUOUS SAME-ROW segment of it rather than from
    // the whole belt. Grouping by row and then taking a run of consecutive cell_x is
    // what keeps the clip inside one straight lane with no gap in it.
    const byRow = new Map<number, number[]>();
    for (const t of belt.tiles) {
      const row = byRow.get(t.cell_y) ?? [];
      row.push(t.cell_x);
      byRow.set(t.cell_y, row);
    }
    for (const [cellY, cellXs] of byRow) {
      cellXs.sort((a, b) => a - b);
      // Longest run of consecutive columns in this row.
      let bestStart = 0;
      let bestLen = 1;
      let runStart = 0;
      for (let i = 1; i <= cellXs.length; i++) {
        if (i < cellXs.length && cellXs[i] === cellXs[i - 1] + 1) continue;
        if (i - runStart > bestLen) {
          bestLen = i - runStart;
          bestStart = runStart;
        }
        runStart = i;
      }
      // INTERIOR TILES ONLY: drop the first and last of the run. A belt's ends carry
      // dock hardware (the machine nub the belt terminates on), and this probe is about
      // the tread BENEATH a dot, not about a dock.
      if (bestLen < 5) continue;
      const from = bestStart + 1;
      const runLen = bestLen - 2;

      const cy = cellCentreY(cellY) * cam.scale + cam.y;
      const top = Math.ceil(cy - laneHalf);
      const bottom = Math.floor(cy + laneHalf);
      if (top <= CHROME_CLEAR_Y || bottom >= viewport!.height) continue;

      const first = cellCentreX(cellXs[from]) * cam.scale + cam.x;
      const lastX = cellCentreX(cellXs[from + runLen - 1]) * cam.scale + cam.x;
      const left = Math.ceil(first - half);
      const right = Math.floor(lastX + half);
      if (left <= CHROME_CLEAR_X || right >= viewport!.width) continue;

      candidates.push({
        beltId: belt.id,
        tiles: runLen,
        cells: cellXs.slice(from, from + runLen).map((x) => `${x},${cellY}`),
        clip: { x: left, y: top, width: right - left, height: bottom - top },
      });
    }
  }

  expect(
    candidates.length,
    'at least one straight belt run of 5+ tiles is fully visible and clear of the chrome',
  ).toBeGreaterThan(0);
  // The longest visible run: the most tread to find, and the most slots an item can be
  // sitting in when the shutter opens.
  candidates.sort((a, b) => b.tiles - a.tiles);
  return candidates[0];
}

/** One sample of a lane strip: the two found pixels and the area each covers. */
interface LaneSample {
  dot: { r: number; g: number; b: number } | null;
  tread: { r: number; g: number; b: number } | null;
  /** How many pixels carry EXACTLY the warmest colour found - the dot's core plateau. */
  corePixels: number;
  /** How many pixels carry the tread colour found. */
  treadPixels: number;
}

/**
 * Screenshot one lane strip, decode it, and find the two sample points by criteria
 * INDEPENDENT of the colours expected of them (see the block header).
 */
async function sampleLane(page: Page, strip: LaneStrip): Promise<LaneSample> {
  const png = PNG.sync.read(await captureClip(page, strip.clip));
  const area = new Map<string, { px: { r: number; g: number; b: number }; n: number }>();
  let dot: LaneSample['dot'] = null;
  let bestWarmth = 0; // strictly positive: the whole substrate ramp is cool (b >= r)
  for (let i = 0; i < png.data.length; i += 4) {
    const px = { r: png.data[i], g: png.data[i + 1], b: png.data[i + 2] };
    if (px.r - px.b > bestWarmth) {
      bestWarmth = px.r - px.b;
      dot = px;
    }
    if (px.r - px.b > 0) continue; // warm pixels are dot ink, never lane substrate
    const key = `${px.r},${px.g},${px.b}`;
    const seen = area.get(key);
    if (seen === undefined) area.set(key, { px, n: 1 });
    else seen.n++;
  }
  // The lane's most common cool colour is the BOARD the belt sits on (the belt's
  // interior is hollow and the board shows through it); the second is the belt's own
  // ink, which the two rails and the marching dash all draw in. An accent cue is
  // orders of magnitude smaller than either and cannot reach second place.
  const byArea = [...area.values()].sort((a, b) => b.n - a.n);
  const tread = byArea.length > 1 ? byArea[1].px : null;
  const corePixels =
    dot === null
      ? 0
      : countExact(png.data, dot);
  return { dot, tread, corePixels, treadPixels: byArea.length > 1 ? byArea[1].n : 0 };
}

/** How many decoded pixels carry exactly `want` - proves a found colour is a REGION. */
function countExact(data: Buffer, want: { r: number; g: number; b: number }): number {
  let n = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] === want.r && data[i + 1] === want.g && data[i + 2] === want.b) n++;
  }
  return n;
}

test.describe('BELT-07 / VEC-01 (LIVE pixel probe, real host): the item dot renders on the belt and keeps its greyscale separation from the tread', () => {
  // RENDER HEALTH, ARMED BEFORE NAVIGATION (plan 62-04, SLOT-03/D-05).
  //
  // These two cases sample the belt LANE, which is the surface this phase re-times: the
  // tread's px-per-tick is now derived from the belt's own slot pitch and advance
  // interval instead of an art-directed constant. A pixel probe cannot pass on a dead
  // render loop, so it is already stronger evidence than a model read - but it says
  // nothing about an UNCAUGHT error that fires after the shutter, and nothing about the
  // loop still advancing once the pin is released. Both cases pin the render clock, so
  // `expectRenderLoopAlive` is asserted at the END, after the pin is dropped.
  //
  // Phase 62 is named explicitly for this bar because it moves items, and the
  // 2026-08-11 debug record names the mechanism:
  // a throw inside `Application.render`, running as a Ticker listener, stops the loop
  // PERMANENTLY on a partial frame and is invisible to every model-level oracle.
  let pageErrors: { assertNone(context: string): void };

  test.beforeEach(async ({ page }) => {
    pageErrors = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
  });

  test('SLOT-04: the TRAILING-INTERPOLATION path keeps the render loop ALIVE and error-free while item dots are MOVING', async ({
    page,
  }) => {
    // THE ONLY LIVE COVERAGE THE NEW CODE PATH HAS, AND THE REASON IT IS NEEDED.
    // The D-10 toggle defaults OFF, so every other live assertion in this tree - the two
    // pixel probes above included - exercises the path where `draw()` branches AROUND
    // the lerp. A throw inside the interpolation arm (a NaN position from a forged
    // interval, an out-of-range from-slot index, a matcher that walks off its array)
    // would therefore be invisible to the entire live suite while the MODEL stayed
    // perfectly correct: `packetsApplied`, `decodeErrors` and `scene.tick` all keep
    // advancing on a build whose Pixi loop is dead. That is precisely the 2026-08-11
    // mechanism: a throw
    // inside `Application.render` runs as a Ticker listener, and `Ticker._tick` only
    // re-requests its animation frame AFTER `update()` returns, so the board freezes
    // permanently on the partial frame the exception interrupted.
    //
    // THE CLOCK IS DELIBERATELY NOT PINNED HERE. A pinned clock is a still board, and a
    // still board cannot show that a MOVING dot is safe: the interpolation parameter is
    // driven by the render clock, so pinning it would freeze the very arithmetic under
    // test at one value. The probe therefore runs the loop free, waits for the sim to
    // advance a measured number of ticks with items genuinely in flight, and only then
    // asserts health.
    await loadDemoReset(page);
    await zoomToFullBeltDetail(page);
    await page.evaluate(() => {
      const hook = (window as { __fabrico?: { setItemInterpolation(on: boolean): void } })
        .__fabrico;
      if (!hook) throw new Error('window.__fabrico not installed');
      hook.setItemInterpolation(true);
    });

    try {
      const startTick = (await readScene(page)).tick;
      // Items must be IN FLIGHT and the sim must have advanced far enough for many
      // advance intervals to have elapsed - the lerp only runs where a belt has history.
      await pollScene(
        page,
        (s) => s.tick > startTick + 60 && s.belts.some((b) => b.items > 0),
        {
          message:
            'the sim advanced 60+ ticks with at least one belt carrying an item, so dots ' +
            'were interpolated across many advances rather than sampled on a still board',
        },
      ).toBe(true);

      // A REAL PIXEL READ under the ON path, not a model read: the item accent must
      // still be composited in the belt lane. A lerp that put dots off the polyline, at
      // NaN, or nowhere at all would read 0 here while the model stayed perfect.
      let corePixels = 0;
      // SPLIT (plan 84-18, D-12): the lane shows a dot only once the model has carried an item onto
      // it, a count of ticks the Rust demo seed holds and this spec cannot read. That wait is the
      // model's, under the old literal; the capture poll after it is derived from its frames.
      const target = await laneStripOf(page, await readScene(page));
      await pollScene(page, (s) => itemOnStrip(s, target), {
        timeout: 30_000,
        message: `the model carries an item onto the sampled lane of belt ${target.beltId}`,
      }).toBe(true);
      await expect
        .poll(
          async () => {
            const scene = await readScene(page);
            const sample = await sampleLane(page, await laneStripOf(page, scene));
            corePixels = sample.corePixels;
            return sample.corePixels;
          },
          {
            message:
              'item dots are composited on the belt lane while trailing interpolation is ON',
            timeout: addWaitBudget(frameBudgetMs(CAPTURE_POLL_TRIES * CAPTURE_FRAMES + DRAWN_STATE_FRAMES), 'lane dot poll, interpolation on: two tries of one clip capture'),
          },
        )
        .toBeGreaterThan(0);
      expect(corePixels).toBeGreaterThan(0);

      // The loop is genuinely still advancing AFTER all that motion, and nothing threw.
      await expectRenderLoopAlive(page, 'after moving item dots with trailing interpolation ON');
      pageErrors.assertNone('after moving item dots with trailing interpolation ON');
    } finally {
      // The live host is SHARED across specs; leave the toggle at its shipped default so
      // no later spec inherits a non-default render path from this one.
      await page.evaluate(() => {
        (
          window as { __fabrico?: { setItemInterpolation(on: boolean): void } }
        ).__fabrico?.setItemInterpolation(false);
      });
    }
  });
});
