import { test, expect, type Page } from '@playwright/test';
import type { HintRect, TutorialProbe } from '../src/chrome/tutorial/TutorialLayer';
import { MIN_ZOOM } from '../src/render/camera';
import { CELL, buildPacket, cameraOf, type CameraSnapshot, type Harness } from './support/wire';
import {
  CARD,
  armSourceForFloor,
  boot,
  boxOf,
  configuredHost,
  placeBoth,
  pressRing,
  pressTimer,
  readProbe,
  ringAt,
  sourceAt,
  startLesson,
  toBeltDraw,
  zoomInto,
  type Box,
} from './support/lessonMock';

// lesson-offscreen.spec.ts - the step card says when its ring is out of view (HINT-03), on the mock host.
//
// Out of view is the locked rule from 103-CONTEXT, "Off-screen target": the ring's box (for a drag,
// either ring's) shares no area with the free area, right of the palette, left of the inspector
// reserve, under the toolbar and above the card. A panel target never counts. Each case reads the
// probe's `offScreen`, the card's `data-fab-offscreen` and the row's visibility, at a floor, a machine
// and a port stage with the flag both on and off. The real-host checks are plan 103-05's.
//
// Show me moves the camera and nothing else. Each Show me case reads what the app has sent before the
// press and checks those counts first, then the board, and only then the camera and the ring, so a
// Show me that sends anything fails on the count whatever else it does.

const TOLERANCE = 1;
const ROW = `${CARD} [data-fab-offscreen-row]`;
/** A point on the board inside the free area at 1280x800, where a middle-drag starts. */
const PAN_FROM = { x: 520, y: 320 };

interface Free {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * The free area by the rule `readFreeArea` in TutorialLayer.tsx uses, worked out again here from the
 * page: the palette dock's right edge, the window less 24 and the inspector's reserve of
 * `min(420, 33vw) + 52`, 116 from the top, and the card's top or the open Legend's top, whichever is
 * higher.
 */
async function freeAreaOf(page: Page): Promise<Free> {
  return page.evaluate(() => {
    const dock = document.querySelector('[data-fab-left-dock]');
    const card = document.querySelector('[data-fab-step-card]');
    const legend = document.querySelector('#fab-legend-panel')?.getBoundingClientRect() ?? null;
    const legendTop = legend === null || legend.width === 0 || legend.height === 0 ? window.innerHeight : legend.top;
    return {
      left: dock === null ? 0 : dock.getBoundingClientRect().right,
      right: window.innerWidth - 24 - (Math.min(420, 0.33 * window.innerWidth) + 2 * 22 + 8),
      top: 116,
      bottom: Math.min(card === null ? window.innerHeight : card.getBoundingClientRect().top, legendTop),
    };
  });
}

function inside(r: Box, free: Free): boolean {
  return r.x >= free.left && r.x + r.width <= free.right && r.y >= free.top && r.y + r.height <= free.bottom;
}

function sharesArea(r: Box, free: Free): boolean {
  return Math.min(r.x + r.width, free.right) > Math.max(r.x, free.left) && Math.min(r.y + r.height, free.bottom) > Math.max(r.y, free.top);
}

/** A middle-button drag on the board by `(dx, dy)`, waiting for the camera to move by it. */
async function panBy(page: Page, dx: number, dy: number): Promise<void> {
  const before = await cameraOf(page);
  await page.mouse.move(PAN_FROM.x, PAN_FROM.y);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(PAN_FROM.x + dx / 2, PAN_FROM.y + dy / 2, { steps: 5 });
  await page.mouse.move(PAN_FROM.x + dx, PAN_FROM.y + dy, { steps: 5 });
  await page.mouse.up({ button: 'middle' });
  await expect
    .poll(async () => {
      const cam = await cameraOf(page);
      return Math.max(Math.abs(cam.x - before.x - dx), Math.abs(cam.y - before.y - dy));
    }, { message: `the middle-drag panned the board by (${dx}, ${dy})` })
    .toBeLessThanOrEqual(TOLERANCE);
}

/** The flag's three readers agree on `on`: the probe, the card's attribute and the row's visibility. */
async function expectFlag(page: Page, on: boolean, what: string): Promise<void> {
  await expect.poll(async () => (await readProbe(page)).offScreen, { message: `${what}: the probe's offScreen` }).toBe(on);
  await expect(page.locator(CARD), `${what}: the card's data-fab-offscreen`).toHaveAttribute('data-fab-offscreen', on ? 'true' : 'false');
  if (on) {
    await expect(page.locator(ROW), `${what}: the row shows`).toBeVisible();
    await expect(page.locator(ROW), `${what}: the row says why`).toContainText('The ring is out of view.');
  } else {
    await expect(page.locator(ROW), `${what}: the row is hidden`).toBeHidden();
    expect(await page.locator(ROW).evaluate((el) => getComputedStyle(el).visibility), `${what}: hidden in place`).toBe('hidden');
  }
}

/** The probe's main ring after a camera move, polled until it is painted under the camera that moved. */
async function ringAfterMove(page: Page, stageId: string, cam: CameraSnapshot): Promise<HintRect> {
  let ring: HintRect | null = null;
  await expect
    .poll(async () => {
      const { probe, now } = await page.evaluate(async () => {
        // Two frames, so the ring has been painted under the camera this read compares.
        for (let i = 0; i < 2; i++) await new Promise((r) => requestAnimationFrame(() => r(undefined)));
        const hook = (window as unknown as { __fabrico: { tutorial(): TutorialProbe; camera(): CameraSnapshot } }).__fabrico;
        return { probe: hook.tutorial(), now: hook.camera() };
      });
      if (probe.stageId !== stageId || probe.hint === null) return 'no ring';
      if (now.x !== cam.x || now.y !== cam.y || now.scale !== cam.scale) return 'the camera moved again';
      ring = probe.hint;
      return 'held';
    }, { message: `the ${stageId} ring under the moved camera` })
    .toBe('held');
  return ring!;
}

/**
 * Read the probe on each of `frames` animation frames and report whether any read had the flag on,
 * so a flag that blinks on for one frame can't pass as off.
 */
async function anyFrameOffScreen(page: Page, frames: number): Promise<boolean> {
  return page.evaluate(async (n) => {
    const hook = (window as unknown as { __fabrico: { tutorial(): TutorialProbe } }).__fabrico;
    let seen = false;
    for (let i = 0; i < n; i++) {
      await new Promise((r) => requestAnimationFrame(() => r(undefined)));
      seen ||= hook.tutorial().offScreen;
    }
    return seen;
  }, frames);
}

/** Start lesson 1 at zoom about 2, place the Source on its ring, and arm the Sink. */
async function toSinkFloorAtZoom2(page: Page, h: Awaited<ReturnType<typeof boot>>): Promise<HintRect> {
  await startLesson(page, h);
  await ringAt(page, 'source-tool');
  await zoomInto(page, PAN_FROM, 1.9, 2.1);
  const { cell } = await armSourceForFloor(page);
  h.inject(buildPacket({ full: false, tick: 6, generation: 1, swapFloor: 1, nodes: [sourceAt(cell)] }));
  await ringAt(page, 'sink-tool');
  await page.getByRole('button', { name: 'Place Sink', exact: true }).click();
  return ringAt(page, 'sink-floor');
}

/**
 * From step 1 to the belt-draw stage at zoom about 1, on a host that answers Timer. The mock boots an
 * empty board at the zoom limit, where the Sink's spot can land far off; at zoom 1 both spots sit in
 * the free area, the Sink six cells east of the Source.
 */
async function toBeltDrawAtZoom1(page: Page): Promise<{ h: Awaited<ReturnType<typeof boot>> }> {
  const host = configuredHost();
  const h = await boot(page, host.opts);
  await startLesson(page, h);
  await ringAt(page, 'source-tool');
  await zoomInto(page, PAN_FROM, 0.9, 1.1);
  await placeBoth(page, h);
  await toBeltDraw(page, host);
  const probe = await readProbe(page);
  const free = await freeAreaOf(page);
  expect(inside(probe.hint!, free) && inside(probe.hintTo!, free), 'both belt-draw rings start in view').toBe(true);
  await expectFlag(page, false, 'with both belt-draw rings in view');
  return { h };
}

/** The belt-draw stage with the Sink's In disc out of view and the Source's doorstep in view. */
async function toBeltDrawWithSinkOut(page: Page): Promise<{ h: Awaited<ReturnType<typeof boot>> }> {
  const { h } = await toBeltDrawAtZoom1(page);
  await pushFarRingOut(page);
  return { h };
}

/**
 * Pan so the belt-draw stage's far ring, the Sink's In disc, sits just past the free area's nearer
 * side edge while the Source's doorstep square stays inside. Asserts both before it returns.
 */
async function pushFarRingOut(page: Page): Promise<void> {
  const probe = await readProbe(page);
  const from = probe.hint;
  const to = probe.hintTo;
  expect(from, 'the doorstep square is painted').not.toBeNull();
  expect(to, 'the In disc is painted').not.toBeNull();
  const free = await freeAreaOf(page);
  const east = to!.x > from!.x;
  const dx = Math.round(east ? free.right - to!.x + 6 : free.left - (to!.x + to!.width) - 6);
  expect(sharesArea({ ...to!, x: to!.x + dx }, free), 'the pan puts the disc out of view').toBe(false);
  expect(inside({ ...from!, x: from!.x + dx }, free), 'and leaves the square in view').toBe(true);
  await panBy(page, dx, 0);
  const after = await readProbe(page);
  expect(sharesArea(after.hintTo!, free), 'the disc is out of view').toBe(false);
  expect(inside(after.hint!, free), 'the square is in view').toBe(true);
}

test.describe('flag', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('a floor stage: the Sink spot under the palette reads out of view, and back in view after a pan', async ({ page }) => {
    const h = await boot(page);
    // At 1280 wide and zoom 2 the Sink's spot six cells east of the Source passes the free area's
    // right edge, so floorSpot puts it six cells west, under the palette (102 deferred items). No pan
    // is needed to put it out; the assertion below says so if that ever changes.
    const ring = await toSinkFloorAtZoom2(page, h);
    const free = await freeAreaOf(page);
    expect(ring.x + ring.width, 'the Sink spot lands left of the free area').toBeLessThanOrEqual(free.left);
    await expectFlag(page, true, 'with the Sink spot under the palette');
    const cardOut = await boxOf(page.locator(CARD), 'the card, flag on');

    const dx = Math.round(free.left - ring.x + 40);
    await panBy(page, dx, 0);
    const moved = await ringAfterMove(page, 'sink-floor', await cameraOf(page));
    expect(inside(moved, free), 'the ring is inside the free area after the pan').toBe(true);
    await expectFlag(page, false, 'with the ring panned into view');
    const cardIn = await boxOf(page.locator(CARD), 'the card, flag off');
    for (const key of ['x', 'y', 'width', 'height'] as const) {
      expect(Math.abs(cardIn[key] - cardOut[key]), `the card's ${key} holds as the flag flips`).toBeLessThanOrEqual(TOLERANCE);
    }
  });

  test('a machine stage: the Source panned out of view and back', async ({ page }) => {
    const h = await boot(page);
    await startLesson(page, h);
    await placeBoth(page, h);
    await ringAt(page, 'tool-down');
    await page.keyboard.press('Escape');
    const ring = await ringAt(page, 'select-source');
    const free = await freeAreaOf(page);
    expect(inside(ring, free), 'the Source starts in view').toBe(true);
    await expectFlag(page, false, 'with the Source in view');

    const dx = Math.round(free.left - (ring.x + ring.width) - 20);
    await panBy(page, dx, 0);
    const out = await ringAfterMove(page, 'select-source', await cameraOf(page));
    expect(sharesArea(out, free), 'the Source ring left the free area').toBe(false);
    await expectFlag(page, true, 'with the Source panned out');

    await panBy(page, -dx, 0);
    await expectFlag(page, false, 'with the Source panned back');
  });

  // Review WR-03: a lesson note held back while the row shows used to leave the accessibility tree with
  // `visibility: hidden`. Inside the card's atomic live region, its coming back read the whole step out again
  // on every pan across the edge. The region's tree has to read the same with the flag on and off.
  test('a held-back lesson note leaves the live region the same for a screen reader as the flag flips', async ({ page }) => {
    const h = await boot(page);
    await startLesson(page, h);
    const { cell } = await armSourceForFloor(page);
    h.inject(buildPacket({ full: false, tick: 6, generation: 1, swapFloor: 1, nodes: [sourceAt(cell)] }));
    await ringAt(page, 'sink-tool');
    // A keyframe on the same floor with the Source gone: the lesson goes back to step 1 with a note.
    h.inject(buildPacket({ full: true, tick: 7, generation: 2, swapFloor: 1 }));
    await expect.poll(async () => (await readProbe(page)).noteKind, { message: 'the going-back note shows' }).toBe('wentBack');
    if ((await readProbe(page)).stageId === 'source-tool') await page.getByRole('button', { name: 'Place Source', exact: true }).click();
    const ring = await ringAt(page, 'source-floor');
    await expectFlag(page, false, 'with the Source spot in view');
    const NOTE = `${CARD} [data-fab-step-note="wentBack"]`;
    const LIVE = `${CARD} [aria-live]`;
    await expect(page.locator(NOTE), 'the note shows').toHaveCSS('opacity', '1');
    const before = await page.locator(LIVE).ariaSnapshot();
    expect(before, 'the region holds the note').toContain('needs doing again');

    const free = await freeAreaOf(page);
    const dx = Math.round(free.left - (ring.x + ring.width) - 20);
    await panBy(page, dx, 0);
    await expectFlag(page, true, 'with the Source spot panned out');
    expect((await readProbe(page)).noteKind, 'the note is still the going-back one').toBe('wentBack');
    await expect(page.locator(NOTE), 'the note is out of sight').toHaveCSS('opacity', '0');
    expect(await page.locator(LIVE).ariaSnapshot(), "the reader's tree is the same with the note held back").toBe(before);

    await panBy(page, -dx, 0);
    await expectFlag(page, false, 'with the Source spot panned back');
    await expect(page.locator(NOTE), 'the note shows again').toHaveCSS('opacity', '1');
    expect(await page.locator(LIVE).ariaSnapshot(), 'and the same again with it back').toBe(before);
  });

  test('a port stage: one ring of the drag out of view is enough', async ({ page }) => {
    await toBeltDrawWithSinkOut(page);
    await expectFlag(page, true, "with only the Sink's In disc out of view");
  });

  test('a panel stage never reads out of view, with the board panned far away', async ({ page }) => {
    const host = configuredHost();
    const h = await boot(page, host.opts);
    await startLesson(page, h);
    const { source } = await placeBoth(page, h);
    await pressTimer(page);
    await pressRing(page, await ringAt(page, 'apply-timer'));
    host.set({ kind: 'Timer', interval_ticks: 60 });
    await ringAt(page, 'belt-tool');
    await panBy(page, -500, 0);
    await panBy(page, -500, 0);
    const free = await freeAreaOf(page);
    const cam = await cameraOf(page);
    const size = CELL * cam.scale;
    const sourceBox = { x: source.cell_x * size + cam.x, y: source.cell_y * size + cam.y, width: size, height: size };
    expect(sharesArea(sourceBox, free), 'the board is far enough away that a machine ring would read out of view').toBe(false);
    expect((await readProbe(page)).stageId, 'still the panel stage').toBe('belt-tool');
    expect(await anyFrameOffScreen(page, 20), 'no frame read the panel target as out of view').toBe(false);
    await expectFlag(page, false, 'at the panel stage');
  });

  test('the locked rule: a floor ring right of the inspector reserve reads out of view with the inspector closed', async ({ page }) => {
    // 103-RESEARCH Pitfall 3 and Open Question 1. The free area's right edge leaves room for the
    // inspector whether or not it is open, so at 1280 wide a ring at x 900 is inside the window and on
    // an empty strip of board, and still reads out of view. That is the locked rule; changing it to
    // the window's edge is the owner's call.
    const h = await boot(page);
    await startLesson(page, h);
    const { ring } = await armSourceForFloor(page);
    await expect(page.locator('aside[aria-labelledby="fab-config-heading"]'), 'the inspector is closed').toHaveCount(0);
    await panBy(page, Math.round(900 - ring.x), 0);
    const moved = await ringAfterMove(page, 'source-floor', await cameraOf(page));
    const free = await freeAreaOf(page);
    expect(Math.abs(moved.x - 900), 'the ring sits at x 900').toBeLessThanOrEqual(TOLERANCE);
    expect(moved.x + moved.width, 'inside the window').toBeLessThan(1280);
    expect(moved.x, 'and right of the inspector reserve').toBeGreaterThan(free.right);
    await expectFlag(page, true, 'right of the inspector reserve');
  });
});

const SHOW_ME = `${ROW} button`;

/** The board as the app's scene holds it, for a before-and-after comparison. */
async function sceneOf(page: Page): Promise<string> {
  return page.evaluate(() => JSON.stringify((window as unknown as { __fabrico: { scene(): unknown } }).__fabrico.scene()));
}

/**
 * Press Show me through `press`, then check in this order: nothing sent (binary commands and control
 * frames alike), the board unchanged. Waits for the camera to move first without asserting it, plus a
 * quiet spell for any frame the page might still send, so the counts are read after the press has
 * done everything it does.
 */
async function showMeSendsNothing(page: Page, h: Harness, press: () => Promise<void>): Promise<void> {
  const sent = h.sent.length;
  const controls = h.controls.length;
  const scene = await sceneOf(page);
  const cam = await cameraOf(page);
  await press();
  for (let i = 0; i < 40; i++) {
    const now = await cameraOf(page);
    if (now.x !== cam.x || now.y !== cam.y || now.scale !== cam.scale) break;
    await page.waitForTimeout(25);
  }
  await page.waitForTimeout(250);
  expect(h.sent.length, 'Show me sent no command').toBe(sent);
  expect(h.controls.length, 'Show me sent no control frame').toBe(controls);
  expect(await sceneOf(page), 'the board is as it was').toBe(scene);
}

/** After Show me: the zoom as given, every ring of the stage inside the free area, and the row hidden. */
async function expectFramed(page: Page, stageId: string, scale: number | null, what: string): Promise<CameraSnapshot> {
  const cam = await cameraOf(page);
  if (scale !== null) expect(cam.scale, `${what}: Show me kept the zoom`).toBe(scale);
  await ringAfterMove(page, stageId, cam);
  const probe = await readProbe(page);
  const free = await freeAreaOf(page);
  expect(inside(probe.hint!, free), `${what}: the ring is inside the free area`).toBe(true);
  if (probe.hintTo !== null) expect(inside(probe.hintTo, free), `${what}: the far ring is inside the free area`).toBe(true);
  await expectFlag(page, false, `${what}, after Show me`);
  return cam;
}

test.describe('show me', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('a floor stage: Show me brings the Sink spot into view at the same zoom and sends nothing', async ({ page }) => {
    const h = await boot(page);
    await toSinkFloorAtZoom2(page, h);
    await expectFlag(page, true, 'with the Sink spot under the palette');
    const { scale } = await cameraOf(page);
    await showMeSendsNothing(page, h, () => page.locator(SHOW_ME).click());
    await expectFramed(page, 'sink-floor', scale, 'the floor stage');
  });

  test('with the Legend open, a floor ring under the Legend reads out of view, and Show me frames it above the Legend', async ({ page }) => {
    const h = await boot(page);
    await startLesson(page, h);
    await page.getByRole('button', { name: 'Legend' }).click();
    const legend = page.locator('#fab-legend-panel');
    await expect(legend).toBeVisible();
    await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
    await ringAt(page, 'source-tool');
    await zoomInto(page, PAN_FROM, 0.9, 1.1);
    await page.getByRole('button', { name: 'Place Source', exact: true }).click();
    const ring = await ringAt(page, 'source-floor');
    const free = await freeAreaOf(page);
    expect(inside(ring, free), 'the Source spot starts above the Legend').toBe(true);
    await expectFlag(page, false, 'with the Source spot above the Legend');

    // Down by just enough to put the ring wholly under the Legend's top and still above the card's, so
    // only the Legend's part of the rule can read it out of view.
    const legendBox = await boxOf(legend, 'the Legend');
    const cardBox = await boxOf(page.locator(CARD), 'the card');
    const dy = Math.round(legendBox.y - ring.y + 6);
    expect(ring.y + dy + ring.height, 'the moved ring stays above the card').toBeLessThan(cardBox.y);
    await panBy(page, 0, dy);
    const under = await ringAfterMove(page, 'source-floor', await cameraOf(page));
    expect(under.y, "the ring's top is under the Legend's top").toBeGreaterThan(legendBox.y);
    await expectFlag(page, true, 'with the Source spot under the Legend');

    const { scale } = await cameraOf(page);
    await showMeSendsNothing(page, h, () => page.locator(SHOW_ME).click());
    await expectFramed(page, 'source-floor', scale, 'the floor stage under the Legend');
    const framed = (await readProbe(page)).hint!;
    expect(framed.y + framed.height, "after Show me the ring ends above the Legend's top").toBeLessThanOrEqual((await boxOf(legend, 'the Legend')).y);
  });

  test('a machine stage: Show me brings the Source back and sends nothing', async ({ page }) => {
    const h = await boot(page);
    await startLesson(page, h);
    await placeBoth(page, h);
    await ringAt(page, 'tool-down');
    await page.keyboard.press('Escape');
    const ring = await ringAt(page, 'select-source');
    const free = await freeAreaOf(page);
    await panBy(page, Math.round(free.left - (ring.x + ring.width) - 20), 0);
    await expectFlag(page, true, 'with the Source panned out');
    const { scale } = await cameraOf(page);
    await showMeSendsNothing(page, h, () => page.locator(SHOW_ME).click());
    await expectFramed(page, 'select-source', scale, 'the machine stage');
  });

  test('a port stage: Show me frames both belt-draw rings and sends nothing', async ({ page }) => {
    // One of three slow Show me tests. On a loaded CI runner each wheel notch cost about 0.66 s and
    // these tests zoomed one notch per round trip; the shared zoomInto now sends two wheel events per
    // zoom. test.slow() triples the 30 s budget and comes off once a CI mock shard runs all three under 15 s.
    test.slow();
    const { h } = await toBeltDrawWithSinkOut(page);
    await expectFlag(page, true, "with the Sink's In disc out of view");
    const { scale } = await cameraOf(page);
    await showMeSendsNothing(page, h, () => page.locator(SHOW_ME).click());
    await expectFramed(page, 'belt-draw', scale, 'the port stage');
  });

  test('at zoom 4 with both belt-draw rings out of view, Show me zooms out until both fit, not below the floor', async ({ page }) => {
    // One of three slow Show me tests. On a loaded CI runner each wheel notch cost about 0.66 s and
    // these tests zoomed one notch per round trip; the shared zoomInto now sends two wheel events per
    // zoom. test.slow() triples the 30 s budget and comes off once a CI mock shard runs all three under 15 s.
    test.slow();
    const { h } = await toBeltDrawAtZoom1(page);
    await zoomInto(page, PAN_FROM, 3.6, 4);
    const zoomed = await cameraOf(page);
    const probe = await ringAfterMove(page, 'belt-draw', zoomed).then(() => readProbe(page));
    const free = await freeAreaOf(page);
    // Lift both rings above the free area's top, so neither is in view.
    const lowest = Math.max(probe.hint!.y + probe.hint!.height, probe.hintTo!.y + probe.hintTo!.height);
    await panBy(page, 0, Math.round(free.top - lowest - 20));
    const out = await readProbe(page);
    expect(sharesArea(out.hint!, free), 'the doorstep square is out of view').toBe(false);
    expect(sharesArea(out.hintTo!, free), 'the In disc is out of view').toBe(false);
    await expectFlag(page, true, 'with both rings out of view at zoom 4');
    const span = Math.max(out.hint!.x + out.hint!.width, out.hintTo!.x + out.hintTo!.width) - Math.min(out.hint!.x, out.hintTo!.x);
    expect(span + 96, 'the two rings and the margin are wider than the free area at this zoom').toBeGreaterThan(free.right - free.left);

    await showMeSendsNothing(page, h, () => page.locator(SHOW_ME).click());
    const cam = await expectFramed(page, 'belt-draw', null, 'zoom 4');
    expect(cam.scale, 'Show me zoomed out').toBeLessThan(zoomed.scale);
    expect(cam.scale, 'and not below the camera floor').toBeGreaterThanOrEqual(MIN_ZOOM);
  });

  test('Show me is disabled with its title while a belt draw is held, and enabled after Escape', async ({ page }) => {
    // One of three slow Show me tests. On a loaded CI runner each wheel notch cost about 0.66 s and
    // these tests zoomed one notch per round trip; the shared zoomInto now sends two wheel events per
    // zoom. test.slow() triples the 30 s budget and comes off once a CI mock shard runs all three under 15 s.
    test.slow();
    await toBeltDrawWithSinkOut(page);
    await expectFlag(page, true, "with the Sink's In disc out of view");
    const button = page.locator(SHOW_ME);
    await expect(button, 'enabled before the draw').toBeEnabled();
    const from = (await readProbe(page)).hint!;
    const at = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    await page.mouse.move(at.x + CELL / 2, at.y, { steps: 3 });
    await page.mouse.move(at.x + CELL, at.y, { steps: 3 });
    await expect(button, 'disabled while the draw is held').toBeDisabled();
    await expect(button).toHaveAttribute('title', 'Finish or cancel the belt first.');
    await page.keyboard.press('Escape');
    await expect(button, 'enabled once Escape ended the draw').toBeEnabled();
    await expect(button, 'with no title').not.toHaveAttribute('title', /./);
    await page.mouse.up();
  });

  test('a keyboard Show me hands focus back to the board, so Space toggles play', async ({ page }) => {
    const h = await boot(page);
    await toSinkFloorAtZoom2(page, h);
    await expectFlag(page, true, 'with the Sink spot under the palette');
    // focus() stands in for the Tab presses that reach the card after the toolbar and the palette.
    await page.locator(SHOW_ME).focus();
    expect(await page.evaluate(() => document.activeElement?.textContent), 'Show me has focus').toBe('Show me');
    const { scale } = await cameraOf(page);
    await showMeSendsNothing(page, h, () => page.keyboard.press('Enter'));
    await expectFramed(page, 'sink-floor', scale, 'after a keyboard Show me');
    expect(await page.evaluate(() => document.activeElement === document.body), 'focus went back to the page').toBe(true);
    const controls = h.controls.length;
    await page.keyboard.press('Space');
    await expect.poll(() => h.controls.length, { message: 'Space reached the board and toggled play' }).toBe(controls + 1);
    expect(['pause', 'resume'], 'the frame Space sent').toContain(h.controls[controls]);
  });
});
