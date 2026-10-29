import { test, expect, type Page } from '@playwright/test';
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
  screenPoint,
  armAndPlaceFactoryAt,
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
  colorOracles,
  nubAnchor,
  rampOracles,
} from '../shared/geometry';

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
// fresh FACTORY in a CLEAR grid region via the shipped palette drag (the proven
// 04-canredo recipe) puts a role-2 Fault nub where it is actually composited.
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
// Drive rules (LOCKED, inherited from 02-round-trip / 04-canredo): page.mouse +
// getByTitle to ISSUE; page.evaluate for READS/render-pin ONLY (never to issue a
// command); every wait is a pollScene predicate with a message; NO fixed sleeps;
// ZERO mocks (runs against the real dev_render_server).

/** FACTORY wire kind (mirrored from kinds.ts / 01-default-scene). */
const KIND_FACTORY = 2;
/** Port role Fault (In=0, Out=1, Fault=2) - PortFacts.role keyspace. */
const ROLE_FAULT = 2;
/**
 * The drop cell for the probe FACTORY: a verified-empty cell. The demo's belt
 * machinery all sits on rows 0..5 (SOURCE (1,3) through the MERGE (22,2) 2x2 and
 * the terminal SINK (26,2), with the long-branch SINK at (22,5) since the EX-03
 * re-space); below that live only the demo's caller and handler pair (on row 6 when
 * plan 85-07 measured it) and the fault SINK at (5,8). So the probe's 3x3 footprint at
 * cols 6..8 / rows 8..10 is clear, and stays clear after the re-space (which
 * moved the long-branch sink one row SOUTH, from (22,4) to (22,5) - nowhere near
 * this drop). The drop screen point is
 * routed through the live camera (screenCellCentre), so under the 29-04 boot-fit
 * it lands wherever this cell is now composited - and this row keeps the factory's
 * SOUTH-facing Fault nub fully on-screen and clear of the chrome (the demo is
 * centred by boot-fit; row 8 sits just below it in the mid-viewport). The old
 * (20,12) was chosen for the IDENTITY boot camera ("near viewport centre" then);
 * under boot-fit's zoom that far cell's downward nub scrolled off the viewport
 * bottom, so its 1x1 screenshot clip fell outside the image - the exact Pitfall 4
 * the camera-aware oracle corrects.
 */
const PROBE_DROP = [6, 8] as const;

/** Decode a 0xRRGGBB numeric color to 8-bit { r, g, b } via shifts (inline, numeric). */
function hexToRgb(color: number): { r: number; g: number; b: number } {
  return { r: (color >> 16) & 0xff, g: (color >> 8) & 0xff, b: color & 0xff };
}

/**
 * Reset the SHARED live host to the known demo baseline via the shipped
 * Load-demo CTA (the 04-canredo genesis-swap reset). dev_render_server persists
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

/**
 * Place a fresh FACTORY via the shipped palette drag (the proven 04-canredo
 * recipe): press the palette Factory tile at its bbox centre, drag onto the clear
 * drop cell, release. Polls until the real host echoes a SECOND kind-2 node, then
 * returns the placed node's id (diffed from the pre-place kind-2 id set, never a
 * hardcoded handle).
 */
async function placeFactory(page: Page): Promise<number> {
  const beforeIds = new Set(
    (await readScene(page)).nodes.filter((n) => n.kind === KIND_FACTORY).map((n) => n.id),
  );
  // Arm-then-click (30-05): arm the Factory tool, click the drop cell, disarm.
  await armAndPlaceFactoryAt(page, PROBE_DROP[0], PROBE_DROP[1]);

  await pollScene(page, (s) => s.nodes.filter((n) => n.kind === KIND_FACTORY).length, {
    message: 'the real host echoes the placed FACTORY (kind-2 node count grows by one)',
  }).toBe(beforeIds.size + 1);

  const placed = (await readScene(page)).nodes.find(
    (n) => n.kind === KIND_FACTORY && !beforeIds.has(n.id),
  );
  expect(placed, 'the placed factory is found by diffing pre/post kind-2 ids').toBeDefined();
  return placed!.id;
}

test.describe('RENDER-04: the idle FACTORY Fault OUTPUT-NUB renders DIM ramp[3], not stuck-red (LIVE pixel probe, real host)', () => {
  // RENDER HEALTH (plan 85-07, the model-oracle blind spot). The pixel probe below pins
  // the render clock, so a dead ticker would not show in its one sample; the watcher is
  // installed BEFORE `page.goto`, and after the test the pin is released and the loop is
  // asserted alive, the BELT-07 describe's shape (`expectHealthyAfterProbe`).
  let errs: ReturnType<typeof watchPageErrors>;

  test.beforeEach(async ({ page }) => {
    errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
  });

  test.afterEach(async ({ page }) => {
    await page.evaluate(() => {
      const hook = (window as { __fabrico?: { pinClock(n: number | null): void } }).__fabrico;
      hook?.pinClock(null);
    });
    await expectRenderLoopAlive(page, 'after the Fault-nub pixel probe, with the clock pin released');
    errs.assertNone('the Fault-nub pixel probe');
  });

  test('the idle role-2 Fault nub center pixel exactly equals the dim ramp[3] (rampOracles.locked[3])', async ({ page }) => {
    // --- Arrange: clean demo baseline (resets the shared host), then a
    // FACTORY placed in a chrome-clear region (see header). ---
    await loadDemoReset(page);
    const placedId = await placeFactory(page);

    // --- Read the fault port location off the style-independent scene oracle. ---
    const factory = (await readScene(page)).nodes.find((n) => n.id === placedId);
    expect(factory, 'the placed FACTORY is present in the scene oracle').toBeDefined();
    const faultPort = factory!.ports.find((p) => p.role === ROLE_FAULT);
    expect(faultPort, 'the FACTORY exposes a role-2 Fault port').toBeDefined();

    // --- Freeze render motion: pin the render clock (READ-adjacent, sim-inert). ---
    await page.evaluate(() => {
      const hook = (window as { __fabrico?: { pinClock(n: number | null): void } }).__fabrico;
      if (!hook) throw new Error('window.__fabrico not installed');
      hook.pinClock(0);
    });

    // --- Compute the nub center from the ORACLE-read port facts (never baked). ---
    // The world nub point is routed through the live camera (screenPoint); under
    // the identity boot camera it is world*1 + 0, and with deviceScaleFactor 1
    // (playwright.live.config Desktop Chrome) a world CSS point maps 1:1 to a
    // device pixel after rounding. When the boot camera moves (29-04) this
    // samples the nub's transformed screen position instead.
    const anchor = nubAnchor(faultPort!.cell_x, faultPort!.cell_y, faultPort!.side);
    const screen = await screenPoint(page, anchor);
    const x = Math.round(screen.x);
    const y = Math.round(screen.y);

    // Guard: the computed nub must be clear of the chrome overlays (top toolbar /
    // left palette), else we would sample panel fill, not the nub (the carry-in
    // failure mode). The drop cell is chosen clear; this makes any regression read.
    expect(x, 'the Fault nub is clear of the left palette panel (x > 210)').toBeGreaterThan(210);
    expect(y, 'the Fault nub is clear of the top toolbar (y > 95)').toBeGreaterThan(95);

    // Guard (WR-03): the sample MUST lie inside the live viewport. The chrome
    // guards above are lower bounds; under the 29-04 boot-fit a future demo-layout
    // or fit-tuning change could scroll the SOUTH-facing nub off the viewport
    // bottom/right, and page.mouse.move / page.screenshot({clip}) would then sample
    // a stray off-viewport pixel instead of the nub. Assert 0 <= x < width and
    // 0 <= y < height so such a regression fails loudly here rather than matching
    // (or mismatching) garbage in the pixel probe below.
    const vp = page.viewportSize();
    expect(vp, 'the live page reports a viewport size for the bounds guard').not.toBeNull();
    expect(x, 'the Fault nub sample is within the viewport left/right bounds').toBeGreaterThanOrEqual(0);
    expect(x, 'the Fault nub sample is within the viewport width').toBeLessThan(vp!.width);
    expect(y, 'the Fault nub sample is within the viewport top/bottom bounds').toBeGreaterThanOrEqual(0);
    expect(y, 'the Fault nub sample is within the viewport height').toBeLessThan(vp!.height);

    // --- Sample a 1x1 device-pixel clip at the nub center and decode it. ---
    const clip = await captureClip(page, { x, y, width: 1, height: 1 });
    const png = PNG.sync.read(clip);
    const i = ((png.width * 0 + 0) << 2); // device pixel (0,0) of the 1x1 clip
    const sampled = { r: png.data[i], g: png.data[i + 1], b: png.data[i + 2] };

    // --- Assert: exact match against the skin-schema DIM step (RENDER-04). ---
    // The freshly placed FACTORY is NOT faulted, so its role-2 Fault nub reads the
    // dim ramp[3], not fault red. Antialias is OFF as of Phase 25's final
    // canvas-reskin step, so the center pixel is exact (no blend). The message names
    // rampOracles.locked[3] so a skin drift reads clearly. The always-red premise is
    // retired; the live-FAULTED colour is covered by machines.test.ts + the FEEL kit.
    const expected = hexToRgb(rampOracles.locked[3]);
    expect(
      sampled,
      `the idle Fault nub center at screen (${x},${y}) must render the dim ramp[3] rampOracles.locked[3] (${expected.r},${expected.g},${expected.b}), not stuck fault-red`,
    ).toEqual(expected);
  });
});

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

/** WCAG relative luminance of an 8-bit sRGB triple. Pure; no product import. */
function relativeLuminance(px: { r: number; g: number; b: number }): number {
  const lin = (c: number): number => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(px.r) + 0.7152 * lin(px.g) + 0.0722 * lin(px.b);
}

/** WCAG contrast ratio between two sampled pixels, lighter over darker. */
function contrastRatio(a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * The INHERITED dot-against-tread greyscale separation, as an EXECUTABLE literal
 * rather than prose. The item accent over the belt's own tread ink is a 1.11-to-1
 * contrast, and it was that before this plan touched anything.
 */
const INHERITED_SEPARATION = 1.11;

/**
 * The floor's tolerance, STATED with its reason: 1.11 is a two-decimal rounding of a
 * separation that computes to 1.1096 from the skin schema, so a floor at exactly 1.11
 * would fail on the rounding rather than on a regression. 0.01 is the width of that
 * rounding and nothing more - it is NOT slack for the conversion to spend.
 */
const SEPARATION_TOLERANCE = 0.01;

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

/** Chrome-clear bounds, mirroring the guards the Fault-nub probe above already uses. */
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
 * chrome and sits inside the viewport - the same two guards the Fault-nub probe uses,
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

  /**
   * FREEZE THE FRAME FOR A PIXEL PROBE: pin the render clock AND pin trailing item
   * interpolation OFF (plan 62-05, the D-10 toggle audit).
   *
   * WHY THE SECOND PIN EXISTS, AND WHY IT IS A PIN RATHER THAN AN ASSUMPTION. Under a
   * trailing lerp the interpolation parameter is `(renderClock + LAG_TICKS - <the tick
   * the previous slots were observed at>) / ticks_per_slot` (the `+ LAG_TICKS` is
   * 62-INTERP-FIX: without it the clock's ceiling and that origin are the same number
   * and the parameter is pinned at 0 on every frame, which is what shipped in 62-05).
   * It does not change this pin's arithmetic by anything that matters:
   * `pinClock(0)` holds the render clock at
   * zero while the SIM KEEPS ADVANCING (the pin is display-only), so that parameter is a
   * large NEGATIVE which the clamp turns into 0 - and the layer then draws every dot at
   * its PREVIOUS slot. That is a real, ONE-SLOT-PITCH along-flow displacement of the
   * exact thing these two cases sample.
   *
   * MEASURED rather than reasoned (plan 62-05, task 3):
   *   - the displacement is EXACTLY one slot pitch: 8.000 world px along a straight tile
   *     and 6.283185 through a bend, and 0 for a blocked dot whose slot did not change.
   *     Pinned as exact arc lengths (36 vs 44 on a 2-tile straight) in
   *     `frontend/src/render/layers/items.test.ts`.
   *   - ON SCREEN, with the toggle forced ON (mutation P1, run against the real
   *     `dev_render_server`), both cases below still PASS: the item accent is still the
   *     warmest pixel in the lane, 19 and 38 core pixels were composited on two runs,
   *     and the dot-versus-tread contrast measured 1.1096 to 1 against a floor of 1.10.
   *     The lane strip spans the INTERIOR tiles of a >= 5-tile run (>= 3 tiles = 96
   *     world px), so a one-slot-pitch shift cannot carry a dot out of it.
   *
   * SO THE TOLERANCE IS NOT THE ISSUE, AND THE PIN IS STILL THE RIGHT ANSWER. These are
   * COLOUR probes: they assert which ink is warmest in a lane strip and how it contrasts
   * with the tread. Neither has a positional claim for a tolerance to widen. Pinning the
   * toggle makes them independent of a D-10 decision that has not been taken yet - the
   * default is OFF today, and if the wave-5 sitting ships it ON these two cases must not
   * silently change what they sample. It also costs nothing: the pin writes the same
   * render-side boolean the default already holds.
   */
  async function pinFrameForProbe(page: Page): Promise<void> {
    await page.evaluate(() => {
      const hook = (
        window as {
          __fabrico?: { pinClock(n: number | null): void; setItemInterpolation(on: boolean): void };
        }
      ).__fabrico;
      if (!hook) throw new Error('window.__fabrico not installed');
      hook.pinClock(0);
      hook.setItemInterpolation(false);
    });
  }

  /** Release the clock pin, then assert the loop is genuinely still advancing. */
  async function expectHealthyAfterProbe(
    page: Page,
    context: string,
  ): Promise<void> {
    await page.evaluate(() => {
      const hook = (window as { __fabrico?: { pinClock(n: number | null): void } }).__fabrico;
      hook?.pinClock(null);
    });
    await expectRenderLoopAlive(page, context);
    pageErrors.assertNone(context);
  }

  test('an item dot is VISIBLE on a live belt lane, in the skin-schema item accent', async ({
    page,
  }) => {
    // THE SILENT-EMPTY BACKSTOP for the plan 61-05 representation change. A texture
    // route that produced a zero-extent or never-uploaded dot would pass every node
    // assertion about bindings, buckets and geometry and render NOTHING. Only a real
    // rasteriser can say otherwise, and this is the only place in the tree that has one.
    await loadDemoReset(page);
    await zoomToFullBeltDetail(page);
    await pinFrameForProbe(page);

    // The sim keeps advancing under a pinned RENDER clock (pinClock is display-only),
    // so which slots are occupied moves between the oracle read and the shutter. Poll
    // the whole read-screenshot-decode cycle rather than racing it - no fixed sleeps.
    let last: LaneSample = { dot: null, tread: null, corePixels: 0, treadPixels: 0 };
    let strip: LaneStrip | null = null;
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
          strip = await laneStripOf(page, scene);
          last = await sampleLane(page, strip);
          return last.corePixels;
        },
        {
          message:
            'at least one item dot is composited on the sampled belt lane (a never-uploaded or ' +
            'zero-extent dot texture renders nothing and would read 0 here)',
          timeout: addWaitBudget(frameBudgetMs(CAPTURE_POLL_TRIES * CAPTURE_FRAMES + DRAWN_STATE_FRAMES), 'lane dot poll: two tries of one clip capture'),
        },
      )
      .toBeGreaterThan(0);

    // The warmest pixel in the lane is the dot's core, and it is EXACTLY the item
    // accent: full opacity, right ink, no blend. A dot drawn at partial alpha or in a
    // stale ink would still be the warmest pixel and would fail right here.
    const expected = hexToRgb(colorOracles.itemHalo);
    expect(
      last.dot,
      `the warmest pixel in belt ${strip!.beltId}'s lane must be the item accent ` +
        `colorOracles.itemHalo (${expected.r},${expected.g},${expected.b}) at full opacity`,
    ).toEqual(expected);

    await expectHealthyAfterProbe(page, 'after the live item-dot lane probe');
  });

  test('the dot-against-tread greyscale separation is at least the inherited 1.11 to 1', async ({
    page,
  }) => {
    await loadDemoReset(page);
    await zoomToFullBeltDetail(page);
    await pinFrameForProbe(page);

    let last: LaneSample = { dot: null, tread: null, corePixels: 0, treadPixels: 0 };
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
          last = await sampleLane(page, await laneStripOf(page, scene));
          return last.corePixels;
        },
        {
          message: 'an item dot and the belt tread are both present in the sampled lane',
          timeout: addWaitBudget(frameBudgetMs(CAPTURE_POLL_TRIES * CAPTURE_FRAMES + DRAWN_STATE_FRAMES), 'lane dot and tread poll: two tries of one clip capture'),
        },
      )
      .toBeGreaterThan(0);

    // Both sample points are the SKIN SCHEMA's own values, read off the live canvas
    // rather than assumed - which is what makes the ratio below a measurement.
    expect(last.dot, 'the dot sample is the item accent').toEqual(hexToRgb(colorOracles.itemHalo));
    expect(
      last.tread,
      'the brightest cool pixel in the lane is the belt tread ink rampOracles.locked[4]',
    ).toEqual(hexToRgb(rampOracles.locked[4]));

    // ONE-SIDED: this plan must not make the separation worse, and it is not licensed
    // to make it better (the dot is a locked cell; a halo needs its own supersession).
    const measured = contrastRatio(last.dot!, last.tread!);
    expect(
      measured,
      `the item dot reads ${measured.toFixed(4)} to 1 against the belt tread beneath it; the ` +
        `INHERITED separation is ${INHERITED_SEPARATION} to 1 and the vector conversion must ` +
        `not reduce it`,
    ).toBeGreaterThanOrEqual(INHERITED_SEPARATION - SEPARATION_TOLERANCE);

    await expectHealthyAfterProbe(page, 'after the live dot-versus-tread separation probe');
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
