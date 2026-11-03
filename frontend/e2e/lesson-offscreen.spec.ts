import { test, expect, type Page } from '@playwright/test';
import type { HintRect, TutorialProbe } from '../src/chrome/tutorial/TutorialLayer';
import { CELL, buildPacket, cameraOf, type CameraSnapshot } from './support/wire';
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
  type Box,
} from './support/lessonMock';

// lesson-offscreen.spec.ts - the step card says when its ring is out of view (HINT-03), on the mock host.
//
// Out of view is the locked rule from 103-CONTEXT, "Off-screen target": the ring's box (for a drag,
// either ring's) shares no area with the free area, right of the palette, left of the inspector
// reserve, under the toolbar and above the card. A panel target never counts. Each case reads the
// probe's `offScreen`, the card's `data-fab-offscreen` and the row's visibility, at a floor, a machine
// and a port stage with the flag both on and off. The real-host checks are plan 103-05's.

const TOLERANCE = 1;
const ROW = `${CARD} [data-fab-offscreen-row]`;
/** One wheel notch the camera reads as a mouse wheel. Each moves the scale by e^0.09. */
const WHEEL_NOTCH = 60;
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
 * `min(420, 33vw) + 52`, 116 from the top, and the card's top.
 */
async function freeAreaOf(page: Page): Promise<Free> {
  return page.evaluate(() => {
    const dock = document.querySelector('[data-fab-left-dock]');
    const card = document.querySelector('[data-fab-step-card]');
    return {
      left: dock === null ? 0 : dock.getBoundingClientRect().right,
      right: window.innerWidth - 24 - (Math.min(420, 0.33 * window.innerWidth) + 2 * 22 + 8),
      top: 116,
      bottom: card === null ? window.innerHeight : card.getBoundingClientRect().top,
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

/** Wheel at `at` one notch at a time until the camera's scale reads in `[lo, hi]`. */
async function zoomInto(page: Page, at: { x: number; y: number }, lo: number, hi: number): Promise<number> {
  await page.mouse.move(at.x, at.y);
  for (let notch = 0; notch < 60; notch++) {
    const { scale } = await cameraOf(page);
    if (scale >= lo && scale <= hi) return scale;
    await page.mouse.wheel(0, scale > hi ? WHEEL_NOTCH : -WHEEL_NOTCH);
    await expect.poll(async () => (await cameraOf(page)).scale, { message: 'the wheel notch moved the zoom' }).not.toBe(scale);
  }
  throw new Error(`the zoom never reached [${lo}, ${hi}]`);
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
