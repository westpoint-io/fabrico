import { test, expect, type Page } from '@playwright/test';
import { PNG } from 'playwright-core/lib/utilsBundle';
import {
  alertRingCentres,
  alertRingInstructions,
  alertRingsPainted,
  armAndPlaceAt,
  armAndPlaceFactoryAt,
  cameraOf,
  captureClip,
  cellCentre,
  clickAt,
  expectRenderLoopAlive,
  handDragBetween,
  handPath,
  pollScene,
  readScene,
  resetToDemo,
  resetZoomToActualSize,
  restoreHostAfterFailedTest,
  rotateHandle,
  screenCellCentre,
  screenPoint,
  waitForAppReady,
  waitForCameraSettle,
  watchPageErrors,
  type SceneFacts,
} from './support/oracle';
import { pauseAndSettle, transport } from './support/beltBoard';
import { addWaitBudget, frameBudgetMs } from '../e2e/support/frameSampler';
import { CELL, colorOracles, nubAnchor, rampOracles } from '../shared/geometry';
import { isRedPixel, redPixelCount } from '../shared/redPixel';
import { LOCKED_SKIN } from '../src/render/synth/skins/locked';
import { LABEL_COLOURS } from '../src/render/synth/skin';

// 92-red-means-faulted.live.spec.ts (phase 92, plan 92-01, CHROME-18, D-06, D-07, success
// criterion 1, UI-SPEC 3.4) - on the real dev host and the real Pixi renderer, red on the board
// means a machine is faulted, and nothing else at rest.
//
// WHAT WAS BROKEN (92-MEASURE.md 18b and 18c). A belt docked at a machine's fault exit ended in a
// solid cap in the fault accent (`belts.ts` `plugCapColor`), so the demo board showed a permanent
// red dot where the Factory's fault belt plugs into it, with nothing faulted. The fix gives that
// cap the fault nub's own neutral (`ramp[3]`) and keeps its role by shape: a ring around a core.
//
// WHY THE DEMO IS PAUSED AND STEPPED (92-RESEARCH.md Finding G). The demo's Factory throws on
// about one emit in twenty, and the host paints it FAULTED on the tick it throws even though its
// fault exit is docked and drains. A capture of a playing demo races that throw. So the board is
// paused from the toolbar and stepped one tick at a time until the model reads no FAULTED node
// for REST_RUN ticks in a row with the fault belt empty (an item dot on it could cover the cap),
// and the tick is asserted unchanged across every capture.
//
// WHY THE LABEL PRECONDITION READS THE LABEL COLOURS (Finding G). The demo places seven Labels,
// all colour byte 0 (sand, which is not red). A Label's colour is the user's own pick, so the
// precondition is that no Label carries a colour the red predicate counts (today one: clay, byte 5),
// read from the model and computed from the skin, never typed.
//
// THE RED PREDICATE is the shared hue predicate `shared/redPixel.ts` (phase 92 review WR-B-06),
// pinned by `src/gates/redPixel.test.ts`, widened to the whole viewport. It replaced
// `87-factory-two-emits`'s channel offsets, which could not see a brick red and counted a magenta.
// The chrome is hidden (`visibility: hidden`, the phase 91 name-tag method) with the board canvas
// left visible, so a chrome red (a warning glyph) cannot count and the board is read whole.
//
// THE LEGS
//   1. the paused cold demo at rest: one whole-viewport capture at each of four zooms, every red
//      count 0, the tick unchanged: the boot zoom, 100%, 0.6 (below the belt LOD cut of 0.75,
//      where the fault-belt cap grows) and 0.25, the zoom floor, below the machine LOD cut, where
//      every machine is its low-zoom kind block (review IN-C-02 and WR-B-05: the boot zoom and 100%
//      were one zoom, and the zoom the user zooms out to, where the Source block was brick red,
//      was never read).
//   2. at 100%, the 1x1 pixel on the Factory's fault-belt cap ring (6.25 px out along the port's
//      normal; the cap's centre lies under the fault nub's own core, see the leg) reads `ramp[3]`
//      within 2 per channel, and the pixel 3.25 px out, between the cap's core and its ring, does
//      NOT (review IN-C-03): a cap fallen back to a solid disc would read `ramp[3]` there too, and
//      the ring shape is what carries the fault role (D-06).
//   3. THE PERSISTENT EXCEPTION (UI-SPEC 3.3 row 6, the 2026-08-30 amendment, D-07): a belt end
//      the user's own edit left unplugged keeps its red ring. The `22-stranded-reconnect`
//      arrangement (a Factory turned so its Out docks a hand-drawn belt, a side Source facing the
//      belt's Tail tile), stranded by turning the Factory back; past the 5 s pulse the red count
//      in the ring's clip is above 0; the ring dragged onto the Source's Out re-docks the belt, and
//      the count reads 0 with no ring plotted.
//   4. NON-VACUITY: the same paused demo stepped to a tick where a node reads FAULTED; at the boot
//      zoom and again at the 0.25 floor (the faulted block's pip) the whole-viewport count is above
//      0 and every counted pixel lies inside a FAULTED node's box plus RING_MARGIN, so the count can
//      see red at both zooms, and sees it only on a faulted machine.
//
// Render health in every test: `watchPageErrors` before `page.goto`, `expectRenderLoopAlive`
// (the held-board form on a paused board) and `assertNone`.

const VIEWPORT = { width: 1280, height: 800 };
/** Model state byte for a faulted machine (`protocol/kinds.ts` `state_tag.FAULTED`). */
const STATE_FAULTED = 2;
/** The demo Factory's wire kind. */
const KIND_FACTORY = 2;
/** The Label colour bytes the red predicate counts, computed from the skin (today `clay`, 5). */
const RED_LABEL_BYTES = LABEL_COLOURS.flatMap((name, i) => {
  const c = LOCKED_SKIN.palette.labels[name];
  return isRedPixel((c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff) ? [i] : [];
});
/** The fault-port keyspace on a dock (`fabrico_core::FAULT_PORT`). */
const FAULT_PORT = 65535;
/** Port role Fault (In=0, Out=1, Fault=2). */
const ROLE_FAULT = 2;
/** Consecutive at-rest ticks required before a capture, so no frame still draws the FAULTED tick. */
const REST_RUN = 3;
/** Steps tried before the board is declared never at rest. */
const STEP_BOUND = 120;
/** How far out along the fault port's normal the cap-ring pixel is read, in screen px at 100%. */
const CAP_RING_READ_PX = 6.25;
/** How far out the between-core-and-ring pixel is read (core r 2, ring 5 to 7, the nub's ring from
 *  4.375): whatever the sub-pixel offset, the pixel spans 2.75 to 4.25 px. */
const CAP_GAP_READ_PX = 3.25;
/** `camera.ts` onWheel: one wheel delta of `dy` px scales the camera by `exp(-dy * WHEEL_K)`. */
const WHEEL_K = 0.0015;
/** `camera.ts` `MIN_ZOOM`, the zoom floor. */
const ZOOM_FLOOR = 0.25;
/** The belt LOD cut (`belts.ts`): below this zoom the belt draws its far-zoom path. */
const BELT_LOD_ZOOM = 0.75;
/** The machine LOD cut (`machines.ts` `LOD_MIN_MACHINE_PX`): below this many screen px a cell is a kind block. */
const LOD_MIN_MACHINE_PX = 16;
/** Pixels around a machine's box the fault probe reads (`87-factory-two-emits`): the alert ring
 *  sits a few px outside the box edge, so a third of a cell covers it. */
const RING_MARGIN = Math.round(CELL / 3);
/** Steps tried while looking for a FAULTED tick on the paused demo. */
const FAULT_STEP_BOUND = 400;
/** Past the stranded ring's 5 s pulse (ALERT_SETTLE_AT_MS, about 5142 ms) with margin. */
const RING_SETTLED_MS = 6000;
/** Half the side of the clip read around a stranded ring (r 8, stroke 2, at 100%). */
const RING_HALF = 14;
/** The leg 3 arrangement, `22-stranded-reconnect`'s cells: the 3x3 Factory's anchor and the side
 *  Source one West of the belt's Tail tile. Row 11 is below the demo. */
const PLACE_CELL: [number, number] = [6, 11];
const SOURCE_CELL: [number, number] = [6, 10];
const KIND_SOURCE = 0;
const ROLE_OUT = 1;
const FACTORY_W = 3;
const UNIT: ReadonlyArray<readonly [number, number]> = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];
/** The injected rule's element id. */
const CHROME_HIDE_ID = 'fab-92-chrome-hide';

type NodeFacts = SceneFacts['nodes'][number];
type BeltFacts = SceneFacts['belts'][number];

/** The demo's Factory, and the belt docked at its fault exit. */
function faultBeltOf(s: SceneFacts): { factory: NodeFacts | undefined; belt: BeltFacts | undefined } {
  const factory = s.nodes.find((n) => n.kind === KIND_FACTORY);
  const belt = factory
    ? s.belts.find((b) => b.docks.some((d) => d.end === 'Tail' && d.node === factory.id && d.port === FAULT_PORT))
    : undefined;
  return { factory, belt };
}

/** At rest: no FAULTED node and nothing on the Factory's fault belt. */
function atRest(s: SceneFacts): boolean {
  const { belt } = faultBeltOf(s);
  return s.nodes.every((n) => n.state !== STATE_FAULTED) && (belt === undefined || belt.items === 0);
}

/** Boot the demo cold (the shipped genesis swap, camera fitted as at boot), playing. */
async function coldDemo(page: Page): Promise<void> {
  await page.setViewportSize(VIEWPORT);
  await page.goto('/');
  await waitForAppReady(page);
  await resetToDemo(page);
  await waitForCameraSettle(page);
}

/**
 * Pause from the toolbar, then Step one tick at a time until the model has read at rest for
 * REST_RUN ticks in a row. Answers the tick it stopped on.
 */
async function pauseAtRest(page: Page): Promise<number> {
  await pauseAndSettle(page, 'the cold demo');
  const step = page.getByRole('button', { name: 'Step' });
  let run = 0;
  for (let i = 0; i < STEP_BOUND; i++) {
    const s = await readScene(page);
    run = atRest(s) ? run + 1 : 0;
    if (run >= REST_RUN) return s.tick;
    await step.click();
    await pollScene(page, (x) => x.tick > s.tick, { message: `one Step advanced the paused demo past tick ${s.tick}` }).toBe(true);
  }
  throw new Error(`the paused demo never read at rest for ${REST_RUN} ticks within ${STEP_BOUND} steps`);
}

/** Hide every chrome element, leaving the one board canvas visible. */
async function hideChrome(page: Page): Promise<void> {
  await page.evaluate((id) => {
    let el = document.getElementById(id);
    if (!el) {
      el = document.createElement('style');
      el.id = id;
      document.head.appendChild(el);
    }
    el.textContent = 'body * { visibility: hidden !important; } canvas { visibility: visible !important; }';
  }, CHROME_HIDE_ID);
}

/** Show the chrome again (the injected rule removed). */
async function showChrome(page: Page): Promise<void> {
  await page.evaluate((id) => document.getElementById(id)?.remove(), CHROME_HIDE_ID);
}

/** Whole-viewport capture's count of pixels that read as the fault accent (the 87 predicate). */
async function viewportRedCount(page: Page): Promise<number> {
  const png = PNG.sync.read(await captureClip(page, { x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height }));
  expect(
    isRedPixel((colorOracles.fault >> 16) & 0xff, (colorOracles.fault >> 8) & 0xff, colorOracles.fault & 0xff),
    'NON-VACUITY: the fault accent itself passes the probe',
  ).toBe(true);
  return redPixelCount(png.data);
}

/**
 * Wheel the camera to about `target`, the pointer on open floor at the window's centre, and answer
 * the scale it reached. One whole-pixel vertical delta: `camera.ts` reads a fractional or small
 * delta as a trackpad PAN, not a zoom. A target at the `MIN_ZOOM` floor is overshot so the clamp
 * lands it exactly.
 */
async function wheelTo(page: Page, target: number): Promise<number> {
  const s = (await cameraOf(page)).scale;
  await page.mouse.move(VIEWPORT.width / 2, VIEWPORT.height / 2);
  const dy = Math.round(Math.log(s / target) / WHEEL_K) + (target <= ZOOM_FLOOR ? 200 : 0);
  await page.mouse.wheel(0, dy);
  await waitForCameraSettle(page);
  return (await cameraOf(page)).scale;
}

/** The preconditions every at-rest leg stands on, read from the model. */
async function expectRestPreconditions(page: Page, tick: number): Promise<{ factory: NodeFacts; belt: BeltFacts }> {
  const s = await readScene(page);
  expect(s.tick, 'the paused demo holds the tick it stopped on').toBe(tick);
  expect(s.nodes.filter((n) => n.state === STATE_FAULTED).map((n) => n.id), 'PRECONDITION: no machine reads FAULTED').toEqual([]);
  expect(RED_LABEL_BYTES, 'the skin has a Label colour the predicate counts (clay), so the precondition can bite').not.toEqual([]);
  expect(
    s.nodes.filter((n) => n.label !== null && RED_LABEL_BYTES.includes(n.label.colour)).map((n) => n.id),
    `PRECONDITION: no Label carries a colour the red predicate counts (bytes ${RED_LABEL_BYTES.join(',')})`,
  ).toEqual([]);
  const { factory, belt } = faultBeltOf(s);
  expect(factory, 'PRECONDITION: the demo holds its Factory').toBeDefined();
  expect(belt, 'NON-VACUITY: a belt is docked at the Factory\'s fault exit (the cap under test)').toBeDefined();
  expect(belt!.items, 'PRECONDITION: the fault belt is empty, so no item dot covers its cap').toBe(0);
  const canvases = await page.evaluate(() => document.querySelectorAll('canvas').length);
  expect(canvases, 'PRECONDITION: the page holds one canvas, the board').toBe(1);
  return { factory: factory!, belt: belt! };
}

/** Red-predicate pixels of a whole-viewport capture, as screen points. */
async function viewportRedPoints(page: Page): Promise<Array<{ x: number; y: number }>> {
  const png = PNG.sync.read(await captureClip(page, { x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height }));
  const out: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < png.data.length; i += 4) {
    if (isRedPixel(png.data[i], png.data[i + 1], png.data[i + 2])) out.push({ x: (i / 4) % png.width, y: Math.floor(i / 4 / png.width) });
  }
  return out;
}

/** Red-predicate count of a clip. */
async function clipRedCount(page: Page, clip: { x: number; y: number; width: number; height: number }): Promise<number> {
  const png = PNG.sync.read(await captureClip(page, clip));
  return redPixelCount(png.data);
}

/** Pause, then Step until the model reads a FAULTED node. Answers the tick and the faulted ids. */
async function pauseAtFault(page: Page): Promise<{ tick: number; faulted: NodeFacts[] }> {
  await pauseAndSettle(page, 'the cold demo');
  addWaitBudget(frameBudgetMs(FAULT_STEP_BOUND * 6), `up to ${FAULT_STEP_BOUND} steps looking for a FAULTED tick`);
  const step = page.getByRole('button', { name: 'Step' });
  for (let i = 0; i < FAULT_STEP_BOUND; i++) {
    const s = await readScene(page);
    const faulted = s.nodes.filter((n) => n.state === STATE_FAULTED);
    if (faulted.length > 0) {
      console.log(`P92-CHROME-18 faulted tick=${s.tick} after ${i} steps nodes=${faulted.map((n) => `${n.id}:${n.kind}`).join(',')}`);
      return { tick: s.tick, faulted };
    }
    await step.click();
    await pollScene(page, (x) => x.tick > s.tick, { message: `one Step advanced the paused demo past tick ${s.tick}` }).toBe(true);
  }
  throw new Error(`no node read FAULTED within ${FAULT_STEP_BOUND} steps of the paused demo`);
}

/** Rotate a placed node via the on-canvas handle (CCW with Shift); waits for the ports re-stamp. */
async function rotatePlaced(page: Page, id: number, ccw: boolean): Promise<void> {
  const before = (await readScene(page)).nodes.find((n) => n.id === id)!;
  const beforePorts = JSON.stringify(before.ports);
  const minX = Math.min(...before.cells.map((c) => c[0]));
  const minY = Math.min(...before.cells.map((c) => c[1]));
  const anchor = await screenCellCentre(page, minX, minY);
  await clickAt(page, anchor.x, anchor.y);
  const handlePt = await screenPoint(page, rotateHandle(minX, minY, FACTORY_W));
  if (ccw) await page.keyboard.down('Shift');
  await clickAt(page, handlePt.x, handlePt.y);
  if (ccw) await page.keyboard.up('Shift');
  await pollScene(page, (s) => JSON.stringify(s.nodes.find((n) => n.id === id)?.ports), {
    message: 'the Rotate echo re-stamps the placed factory ports (the edit landed)',
  }).not.toBe(beforePorts);
}

/**
 * The `22-stranded-reconnect` arrangement at 100%: a Factory turned CCW so its Out faces North, a
 * belt drawn north off its doorstep by hand (its Tail docked to the Out), and a side Source West of
 * the Tail tile facing it. Answers the ids and the Tail tile.
 */
async function arrangeStrandable(page: Page): Promise<{ factoryId: number; beltId: number; endTile: [number, number]; sourceId: number }> {
  const before = new Set((await readScene(page)).nodes.filter((n) => n.kind === KIND_FACTORY).map((n) => n.id));
  await armAndPlaceFactoryAt(page, PLACE_CELL[0], PLACE_CELL[1]);
  await pollScene(page, (s) => s.nodes.some((n) => n.kind === KIND_FACTORY && !before.has(n.id)), {
    message: 'the real host echoes the placed Factory',
  }).toBe(true);
  const factoryId = (await readScene(page)).nodes.find((n) => n.kind === KIND_FACTORY && !before.has(n.id))!.id;
  await rotatePlaced(page, factoryId, true);
  const s1 = await readScene(page);
  const out = s1.nodes.find((n) => n.id === factoryId)!.ports.find((p) => p.role === ROLE_OUT)!;
  const [dx, dy] = UNIT[out.side & 3];
  const front: [number, number] = [out.cell_x + dx, out.cell_y + dy];
  const beltsBefore = new Set(s1.belts.map((b) => b.id));
  await page.getByTitle(/^Draw belts/).click();
  await handDragBetween(page, await screenCellCentre(page, front[0], front[1]), await screenCellCentre(page, front[0] + dx * 3, front[1] + dy * 3));
  await pollScene(page, (s) => s.belts.length, { message: 'the real host echoes the drawn belt' }).toBe(beltsBefore.size + 1);
  await page.keyboard.press('Escape');
  const beltId = (await readScene(page)).belts.find((b) => !beltsBefore.has(b.id))!.id;
  await pollScene(page, (s) => s.belts.find((b) => b.id === beltId)?.docks.length ?? 0, {
    message: "the draw pressed on the Out's doorstep docked the belt's Tail to the Factory",
  }).toBe(1);
  await page.keyboard.press('Escape');
  expect(front, 'PRECONDITION: the Tail tile is the one the side Source will face').toEqual([SOURCE_CELL[0] + 1, SOURCE_CELL[1]]);
  const sourcesBefore = new Set((await readScene(page)).nodes.filter((n) => n.kind === KIND_SOURCE).map((n) => n.id));
  await armAndPlaceAt(page, 'Source', SOURCE_CELL[0], SOURCE_CELL[1]);
  await pollScene(page, (s) => s.nodes.some((n) => n.kind === KIND_SOURCE && !sourcesBefore.has(n.id)), {
    message: 'the real host echoes the side Source',
  }).toBe(true);
  const sourceId = (await readScene(page)).nodes.find((n) => n.kind === KIND_SOURCE && !sourcesBefore.has(n.id))!.id;
  await pollScene(page, (s) => s.belts.find((b) => b.id === beltId)?.docks.length ?? 0, {
    message: 'placing the Source docked nothing: the belt still holds its one dock',
  }).toBe(1);
  return { factoryId, beltId, endTile: front, sourceId };
}

let errs: ReturnType<typeof watchPageErrors>;

test.beforeEach(async ({ page }) => {
  errs = watchPageErrors(page);
});

test.afterEach(async ({ page }, testInfo) => {
  await restoreHostAfterFailedTest(page, testInfo);
  if (testInfo.status !== testInfo.expectedStatus) return;
  // Leave the shared host playing for the next spec.
  await showChrome(page);
  if ((await transport(page).getAttribute('aria-label')) === 'Play') await transport(page).click();
  await expect(transport(page), 'the demo is playing again for the next spec').toHaveAttribute('aria-label', 'Pause');
});

test.describe('CHROME-18 live: red on the board means a faulted machine (the real dev host)', () => {
  test('the paused cold demo shows no red at rest', async ({ page }) => {
    await coldDemo(page);
    await expectRenderLoopAlive(page, 'on the cold demo, playing');
    const tick = await pauseAtRest(page);
    await expectRestPreconditions(page, tick);
    const bootScale = (await cameraOf(page)).scale;

    const counts: Record<string, number> = {};
    const scales: Record<string, number> = {};
    const capture = async (name: string): Promise<void> => {
      await hideChrome(page);
      await expectRenderLoopAlive(page, `on the paused demo, chrome hidden, at ${name}`, { boardHeld: true });
      scales[name] = (await cameraOf(page)).scale;
      counts[name] = await viewportRedCount(page);
      await showChrome(page);
    };
    await capture('the boot zoom');
    await resetZoomToActualSize(page);
    await capture('100%');
    const mid = await wheelTo(page, 0.6);
    expect(mid, 'PRECONDITION: the third zoom is below the belt LOD cut').toBeLessThan(BELT_LOD_ZOOM);
    expect(mid * CELL, 'PRECONDITION: the third zoom is above the machine LOD cut').toBeGreaterThanOrEqual(LOD_MIN_MACHINE_PX);
    await capture('0.6');
    const floor = await wheelTo(page, ZOOM_FLOOR);
    expect(floor * CELL, 'PRECONDITION: at the zoom floor every machine is its low-zoom kind block').toBeLessThan(LOD_MIN_MACHINE_PX);
    await capture('the 0.25 floor');
    console.log(`P92-CHROME-18 tick=${tick} boot_scale=${bootScale} scales=${JSON.stringify(scales)} counts=${JSON.stringify(counts)}`);

    expect((await readScene(page)).tick, 'the tick did not move across the captures').toBe(tick);
    expect(
      counts,
      `RED-FIRST CHROME-18-cap-live (and review WR-B-05 at the floor): whole-viewport red-pixel count per zoom on the paused demo at rest (tick ${tick})`,
    ).toEqual({ 'the boot zoom': 0, '100%': 0, '0.6': 0, 'the 0.25 floor': 0 });
    errs.assertNone('on the paused cold demo');
  });

  test('the fault-belt cap reads the fault nub grey', async ({ page }) => {
    await coldDemo(page);
    await expectRenderLoopAlive(page, 'on the cold demo, playing');
    const tick = await pauseAtRest(page);
    const { factory } = await expectRestPreconditions(page, tick);
    const faultPort = factory.ports.find((p) => p.role === ROLE_FAULT);
    expect(faultPort, 'the Factory exposes its fault exit').toBeDefined();

    // At 100% the cap is exactly CAP_R = 6 px, its ring stroked 2 px wide at r = 6 (5 to 7).
    await resetZoomToActualSize(page);
    expect((await cameraOf(page)).scale, 'the camera is at 100%').toBe(1);
    await hideChrome(page);
    await expectRenderLoopAlive(page, 'on the paused demo, chrome hidden, at 100%', { boardHeld: true });
    // WHERE THE PIXEL IS READ, measured at PHASE92_START: the cap's centre lies under the fault
    // nub's own core (the machine layer is drawn above the belt layer), so it read ramp[3] before
    // the fix as well and cannot grade the cap. The pixel read is the cap's own ring, on the port's
    // outward normal at 6.25 px from the anchor: whatever the sub-pixel camera offset (at most half
    // a pixel), its centre lies 5.75 to 6.75 px out, inside the new ring (5 to 7) and outside the
    // nub's ring (out to 5.625). Before the fix that pixel is the solid red cap (up to 6 px) or the
    // belt's stem beyond it, never ramp[3].
    const anchor = await screenPoint(page, nubAnchor(faultPort!.cell_x, faultPort!.cell_y, faultPort!.side));
    const normal: Record<number, [number, number]> = { 0: [0, -1], 1: [1, 0], 2: [0, 1], 3: [-1, 0] };
    const [nx, ny] = normal[faultPort!.side & 3];
    const x = Math.floor(anchor.x + nx * CAP_RING_READ_PX);
    const y = Math.floor(anchor.y + ny * CAP_RING_READ_PX);
    expect(x >= 0 && x < VIEWPORT.width && y >= 0 && y < VIEWPORT.height, `the cap ring pixel (${x},${y}) is inside the viewport`).toBe(true);
    const png = PNG.sync.read(await captureClip(page, { x, y, width: 1, height: 1 }));
    const got = { r: png.data[0], g: png.data[1], b: png.data[2] };
    const want = { r: (rampOracles.locked[3] >> 16) & 0xff, g: (rampOracles.locked[3] >> 8) & 0xff, b: rampOracles.locked[3] & 0xff };
    const worst = Math.max(Math.abs(got.r - want.r), Math.abs(got.g - want.g), Math.abs(got.b - want.b));
    console.log(
      `P92-CHROME-18 cap tick=${tick} anchor=(${anchor.x.toFixed(2)},${anchor.y.toFixed(2)}) side=${faultPort!.side} at=(${x},${y}) got=${JSON.stringify(got)} want=${JSON.stringify(want)}`,
    );
    expect(
      worst,
      `RED-FIRST CHROME-18-cap-live: the fault-belt cap ring at (${x},${y}), ${CAP_RING_READ_PX} px out from the fault exit, reads ${JSON.stringify(got)}; the fault nub grey ramp[3] is ${JSON.stringify(want)} (within 2 per channel)`,
    ).toBeLessThanOrEqual(2);
    // THE RING, NOT A DISC (review IN-C-03): between the cap's core (r 2) and its ring (5 to 7) the
    // cap draws nothing, so the pixel there is the belt's stem or the floor, never the cap grey. A
    // fault cap fallen back to a solid `ramp[3]` disc of r 6 would read the cap grey here.
    const gx = Math.floor(anchor.x + nx * CAP_GAP_READ_PX);
    const gy = Math.floor(anchor.y + ny * CAP_GAP_READ_PX);
    const gpng = PNG.sync.read(await captureClip(page, { x: gx, y: gy, width: 1, height: 1 }));
    const gap = { r: gpng.data[0], g: gpng.data[1], b: gpng.data[2] };
    const gapWorst = Math.max(Math.abs(gap.r - want.r), Math.abs(gap.g - want.g), Math.abs(gap.b - want.b));
    console.log(`P92-CHROME-18 cap-gap at=(${gx},${gy}) got=${JSON.stringify(gap)} off_ramp3=${gapWorst}`);
    expect(
      gapWorst,
      `the pixel ${CAP_GAP_READ_PX} px out, between the cap's core and its ring, reads ${JSON.stringify(gap)}, not the cap grey ${JSON.stringify(want)}: the cap is a ring`,
    ).toBeGreaterThan(8);
    errs.assertNone('on the fault-belt cap');
  });

  test('the stranded-belt ring keeps red until the reconnect clears it', async ({ page }) => {
    await page.setViewportSize(VIEWPORT);
    await page.goto('/');
    await waitForAppReady(page);
    await resetToDemo(page);
    await resetZoomToActualSize(page);
    await waitForCameraSettle(page);
    expect((await cameraOf(page)).scale, 'leg 3 runs at 100%').toBe(1);
    const a = await arrangeStrandable(page);
    await expectRenderLoopAlive(page, 'after the strandable arrangement');

    // The ring and the drag's two points, read before the strand.
    const ring = await screenCellCentre(page, a.endTile[0], a.endTile[1]);
    const source = (await readScene(page)).nodes.find((n) => n.id === a.sourceId)!;
    const sourceOut = source.ports.find((p) => p.role === ROLE_OUT)!;
    const target = await screenPoint(page, nubAnchor(sourceOut.cell_x, sourceOut.cell_y, sourceOut.side));
    const clip = { x: Math.floor(ring.x - RING_HALF), y: Math.floor(ring.y - RING_HALF), width: 2 * RING_HALF + 1, height: 2 * RING_HALF + 1 };
    const beforeStrand = await clipRedCount(page, clip);

    // Strand: deselect, one clockwise turn of the Factory spins its Out off the belt end.
    await page.keyboard.press('Escape');
    await rotatePlaced(page, a.factoryId, false);
    await pollScene(page, (s) => s.belts.find((b) => b.id === a.beltId)?.docks.length ?? 0, {
      message: 'rotating the docked Factory severs the dock (the strand)',
    }).toBe(0);
    await page.keyboard.press('Escape');
    const endPt = { x: cellCentre(a.endTile[0]), y: cellCentre(a.endTile[1]) };
    await expect
      .poll(async () => (await alertRingCentres(page)).some((c) => Math.hypot(c.x - endPt.x, c.y - endPt.y) <= 2), {
        timeout: addWaitBudget(frameBudgetMs(30), 'the ring plot read after the strand'),
        intervals: [100, 250, 500],
        message: 'the warning ring is plotted on the stranded end tile',
      })
      .toBe(true);
    // Past the 5 s pulse: the ring has settled and stays (the dated exception).
    const strandedAt = Date.now();
    await expect
      .poll(() => Date.now() - strandedAt >= RING_SETTLED_MS, {
        timeout: addWaitBudget(RING_SETTLED_MS + 2000, 'past the stranded ring pulse to its settled alpha'),
        intervals: [250],
        message: 'past the stranded ring pulse',
      })
      .toBe(true);
    expect(await alertRingsPainted(page), 'the ring is still painted past its pulse').toBe(true);
    const stranded = await clipRedCount(page, clip);

    // Reconnect: press the ring and drag it onto the side Source's Out.
    const path = handPath(ring, target);
    await page.mouse.move(ring.x, ring.y);
    await page.mouse.down();
    for (const p of path) await page.mouse.move(p.x, p.y);
    await page.mouse.up();
    await pollScene(page, (s) => s.belts.find((b) => b.id === a.beltId)?.docks[0]?.node ?? -1, {
      message: 'the ring dragged onto the side Source re-docks the belt to it',
    }).toBe(a.sourceId);
    await expect
      .poll(() => alertRingInstructions(page), {
        timeout: addWaitBudget(frameBudgetMs(30), 'the ring cleared after the reconnect'),
        intervals: [100, 250, 500],
        message: 'no ring is plotted after the reconnect',
      })
      .toBe(0);
    await expectRenderLoopAlive(page, 'after the reconnect');
    const reconnected = await clipRedCount(page, clip);
    console.log(`P92-CHROME-18 ring clip=${JSON.stringify(clip)} before=${beforeStrand} stranded=${stranded} reconnected=${reconnected}`);
    expect(beforeStrand, 'NON-VACUITY: no red in the ring clip before the strand').toBe(0);
    expect(stranded, 'the stranded ring is red past its pulse (the persistent exception, UI-SPEC 3.3 row 6)').toBeGreaterThan(0);
    expect(reconnected, 'the reconnect leaves no red in the ring clip').toBe(0);
    errs.assertNone('on the stranded-ring leg');
  });

  test('the red count sees red on a faulted machine and only there', async ({ page }) => {
    await coldDemo(page);
    await expectRenderLoopAlive(page, 'on the cold demo, playing');
    const { tick, faulted } = await pauseAtFault(page);
    const readAtZoom = async (name: string): Promise<void> => {
      await hideChrome(page);
      await expectRenderLoopAlive(page, `on the paused demo at a FAULTED tick, chrome hidden, at ${name}`, { boardHeld: true });
      const boxes: Array<{ x0: number; y0: number; x1: number; y1: number }> = [];
      for (const n of faulted) {
        const xs = n.cells.map((c) => c[0]);
        const ys = n.cells.map((c) => c[1]);
        const nw = await screenCellCentre(page, Math.min(...xs), Math.min(...ys));
        const se = await screenCellCentre(page, Math.max(...xs), Math.max(...ys));
        const half = ((await cameraOf(page)).scale * CELL) / 2;
        boxes.push({ x0: nw.x - half - RING_MARGIN, y0: nw.y - half - RING_MARGIN, x1: se.x + half + RING_MARGIN, y1: se.y + half + RING_MARGIN });
      }
      const red = await viewportRedPoints(page);
      const outside = red.filter((p) => !boxes.some((b) => p.x + 0.5 >= b.x0 && p.x + 0.5 <= b.x1 && p.y + 0.5 >= b.y0 && p.y + 0.5 <= b.y1));
      expect((await readScene(page)).tick, 'the tick did not move across the capture').toBe(tick);
      console.log(`P92-CHROME-18 nonvacuity ${name} tick=${tick} red=${red.length} outside=${outside.length} boxes=${JSON.stringify(boxes)}`);
      expect(red.length, `NON-VACUITY: at ${name} the whole-viewport count sees red on a FAULTED machine`).toBeGreaterThan(0);
      expect(outside.slice(0, 10), `at ${name} every red pixel lies inside a FAULTED node box plus the ring margin`).toEqual([]);
      await showChrome(page);
    };
    await readAtZoom('the boot zoom');
    const floor = await wheelTo(page, ZOOM_FLOOR);
    expect(floor * CELL, 'PRECONDITION: at the zoom floor every machine is its low-zoom kind block').toBeLessThan(LOD_MIN_MACHINE_PX);
    await readAtZoom('the 0.25 floor');
    errs.assertNone('on the faulted non-vacuity leg');
  });
});
