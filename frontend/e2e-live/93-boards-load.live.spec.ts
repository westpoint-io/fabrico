import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect, type Page } from '@playwright/test';
import { addWaitBudget, frameBudgetMs, tickBudgetMs } from '../e2e/support/frameSampler';
import {
  CELL,
  captureClip,
  cameraOf,
  expectRenderLoopAlive,
  loadDemoViaExamples,
  loadExample,
  pollScene,
  readScene,
  resetToDemo,
  restoreHostAfterFailedTest,
  screenCellCentre,
  waitForAppReady,
  waitForCameraSettle,
  watchPageErrors,
  webhookUrl,
  type SceneFacts,
} from './support/oracle';

// 93-boards-load.live.spec.ts
//
// EACH SHIPPED BOARD FILE OPENS THROUGH THE REAL EXAMPLES MENU, AND A PERSON WATCHING SEES IT RUN.
//
// This spec grades what a person sees, because a read of the model passes on a dead canvas: the
// model keeps ticking whether or not anything is drawn. So each board has to show, on screen, that
// the Undo button is greyed out in the DOM and that the pixels of its first belt change while
// that belt carries items.
//
// Every belt's tread marches from the render clock whether or not it carries anything, so a pixel
// change alone proves nothing about items. The check pins the render clock, which holds the tread
// still and leaves the item dots moving with the scene, and it counts a pixel change only on a
// sample where the model reports items on that belt around the capture. The negative
// control below hides the item layer and requires the same check to see no change, on every board:
// that is what shows the check can fail with the model still reporting items.
//
// The node count is read from the board file itself, which shows that the board on screen is that
// file. Every test installs `watchPageErrors` before `page.goto` and ends with
// `expectRenderLoopAlive` and the watcher's `assertNone`.

const KIND_SOURCE = 0;

/** A real order. The order board has no timer, so nothing moves on it until one of these arrives. */
const ORDER_BODY = '{"id":"ord-1","items":[{"sku":"widget","qty":2,"price":5}]}';

/** The ticks a timer needs to fire and its item to cross a Source's first belt, generously. */
const FIRST_BELT_TICKS = 240;
/** The frames two differing clips of a moving belt can take, each clip being one poll sample. */
const FIRST_BELT_FRAMES = 30;
/** The samples with items on the belt that the negative control takes with the item layer hidden. */
const CONTROL_SAMPLES = 8;
/** The gap between samples. An item crosses a first belt quickly, so a slower poll samples between items. */
const SAMPLE_GAP_MS = 50;

type BoardId = 'demo_scene' | 'order_processing' | 'advanced';
type Belt = SceneFacts['belts'][number];

/** How many `Place(` commands a board file holds outside `//` comments: its node count. */
function placesInBoard(id: BoardId): number {
  const path = fileURLToPath(new URL(`../../examples/boards/${id}.board.ron`, import.meta.url));
  const places = readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .filter((line) => /^\s*Place\(/.test(line)).length;
  expect(places, `${path} holds Place( commands`).toBeGreaterThan(0);
  return places;
}

/**
 * Opens a board through the Examples menu and waits for the swap to land: the board on screen has
 * the file's node count, and either its tick restarted or the board before it had another shape.
 */
async function openBoard(page: Page, id: BoardId): Promise<void> {
  const nodes = placesInBoard(id);
  if (id !== 'demo_scene') {
    await loadExample(page, id, nodes);
    return;
  }
  const before = await readScene(page);
  const sameShape = before.nodes.length === nodes;
  await loadDemoViaExamples(page);
  await pollScene(page, (s) => (s.tick < before.tick || !sameShape) && s.nodes.length === nodes, {
    message: 'the demo board replaced the board before it',
  }).toBe(true);
  await waitForCameraSettle(page);
}

/** The Undo button as the toolbar draws it, by its accessible name. */
function undoButton(page: Page) {
  return page.getByRole('button', { name: 'Undo', exact: true });
}

/** The node count and the greyed-out Undo: the two things a load promises straight away. */
async function expectFreshBoard(page: Page, id: BoardId): Promise<void> {
  expect((await readScene(page)).nodes.length, `${id}: the board on screen is the file's nodes`).toBe(
    placesInBoard(id),
  );
  await expect(undoButton(page), `${id}: nothing on a freshly loaded board can be undone`).toBeDisabled();
}

/** The belt that leaves the board's first Source, the first place an item can show. */
function firstBelt(scene: SceneFacts): Belt {
  const sources = scene.nodes.filter((n) => n.kind === KIND_SOURCE).sort((a, b) => a.id - b.id);
  expect(sources.length, 'the board has a Source').toBeGreaterThan(0);
  const belt = scene.belts.find((b) => b.docks.some((d) => d.end === 'Tail' && d.node === sources[0].id));
  expect(belt, 'a belt leaves the first Source').toBeDefined();
  return belt as Belt;
}

/**
 * A screen box along a belt's tiles, kept inside the viewport. Along the run it stops at the centres
 * of the first and last tiles. The machine at each end of a belt draws its port over the outer half
 * of the belt's end tile, and that port's look follows the scene, so the negative control saw it
 * change with no item drawn. An item still crosses everything between those two centres.
 */
async function clipAround(page: Page, belt: Belt): Promise<{ x: number; y: number; width: number; height: number }> {
  const half = (CELL * (await cameraOf(page)).scale) / 2;
  const centres = await Promise.all(belt.tiles.map((t) => screenCellCentre(page, t.cell_x, t.cell_y)));
  const viewport = page.viewportSize();
  if (viewport === null) throw new Error('the live project sets a viewport');
  const xs = centres.map((c) => c.x);
  const ys = centres.map((c) => c.y);
  const padX = Math.max(...xs) > Math.min(...xs) ? 0 : half;
  const padY = Math.max(...ys) > Math.min(...ys) ? 0 : half;
  const left = Math.max(0, Math.floor(Math.min(...xs) - padX));
  const top = Math.max(0, Math.floor(Math.min(...ys) - padY));
  const right = Math.min(viewport.width, Math.ceil(Math.max(...xs) + padX));
  const bottom = Math.min(viewport.height, Math.ceil(Math.max(...ys) + padY));
  expect(right - left > 0 && bottom - top > 0, 'the first belt is inside the viewport').toBe(true);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * Holds the belt treads still by pinning the render clock, or frees them again with `null`. The
 * pin reaches the canvas on the next draw, so this returns after two display frames, and a capture
 * taken after it can't hold a tread from before the pin.
 */
async function pinTreads(page: Page, frame: number | null): Promise<void> {
  await page.evaluate(async (pinned) => {
    const hook = (window as { __fabrico?: { pinClock(n: number | null): void } }).__fabrico;
    if (!hook) throw new Error('window.__fabrico not installed');
    hook.pinClock(pinned);
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
  }, frame);
}

/** Shows or hides the item layer, returning after two display frames, as `pinTreads` does. */
async function showItemLayer(page: Page, on: boolean): Promise<void> {
  await page.evaluate(async (visible) => {
    const hook = (window as { __fabrico?: { setItemLayerVisible(on: boolean): void } }).__fabrico;
    if (!hook) throw new Error('window.__fabrico not installed');
    hook.setItemLayerVisible(visible);
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
  }, on);
}

/**
 * One sample of a belt under pinned treads: whether the model reports items on it just before or
 * just after the capture, and whether the clip differs from `reference`. A change is only graded on
 * a belt the model says is carrying around that capture. An item can land or leave during a capture,
 * so one read beside it isn't enough to say the belt was empty for it.
 */
async function sampleBelt(
  page: Page,
  beltId: number,
  clip: { x: number; y: number; width: number; height: number },
  reference: Buffer,
): Promise<{ carrying: boolean; changed: boolean }> {
  const itemsOn = (scene: SceneFacts) => scene.belts.find((b) => b.id === beltId)?.items ?? 0;
  const before = itemsOn(await readScene(page));
  const shot = await captureClip(page, clip);
  const after = itemsOn(await readScene(page));
  return { carrying: before > 0 || after > 0, changed: !shot.equals(reference) };
}

/**
 * Polls, under pinned treads, until a sample that has items on the board's first belt also differs
 * from the clip taken at the start. `beforeSample` runs ahead of each sample: it does nothing on a
 * board with a timer, and on the order board it posts a real order. The result names both halves,
 * so a failure says which one was missing: pixels false with items true is a canvas that doesn't
 * draw what the model reports.
 */
async function expectItemDrawnOnFirstBelt(page: Page, id: BoardId, beforeSample: () => Promise<void>): Promise<void> {
  const belt = firstBelt(await readScene(page));
  const clip = await clipAround(page, belt);
  await pinTreads(page, 0);
  const reference = await captureClip(page, clip);
  let pixelsChanged = false;
  let itemsSeen = false;
  await expect
    .poll(
      async () => {
        await beforeSample();
        const sample = await sampleBelt(page, belt.id, clip, reference);
        itemsSeen = itemsSeen || sample.carrying;
        pixelsChanged = pixelsChanged || (sample.carrying && sample.changed);
        return { pixelsChanged, itemsSeen };
      },
      {
        message: `${id}: belt ${belt.id}, the first belt, changes pixels on screen under pinned treads while it carries items`,
        intervals: [SAMPLE_GAP_MS],
        timeout: addWaitBudget(
          frameBudgetMs(FIRST_BELT_FRAMES) + tickBudgetMs(FIRST_BELT_TICKS),
          'an item drawn on the first belt, under pinned treads',
        ),
      },
    )
    .toEqual({ pixelsChanged: true, itemsSeen: true });
  await pinTreads(page, null);
}

/**
 * The negative control. With the item layer hidden and the treads pinned, `CONTROL_SAMPLES` samples
 * that have items on the first belt must all match the clip taken at the start: the check that
 * `expectItemDrawnOnFirstBelt` makes can't pass with no item drawn. Then the layer comes back, and
 * the same clip must change, so the control can't pass on a belt whose items never reach the clip.
 */
async function expectNoChangeWithItemsHidden(page: Page, id: BoardId, beforeSample: () => Promise<void>): Promise<void> {
  const belt = firstBelt(await readScene(page));
  const clip = await clipAround(page, belt);
  await showItemLayer(page, false);
  await pinTreads(page, 0);
  const reference = await captureClip(page, clip);
  let carrying = 0;
  let changedWhileCarrying = 0;
  await expect
    .poll(
      async () => {
        await beforeSample();
        const sample = await sampleBelt(page, belt.id, clip, reference);
        if (sample.carrying) {
          carrying += 1;
          if (sample.changed) changedWhileCarrying += 1;
        }
        return carrying;
      },
      {
        message: `${id}: belt ${belt.id} carries items on ${CONTROL_SAMPLES} samples with the item layer hidden`,
        intervals: [SAMPLE_GAP_MS],
        timeout: addWaitBudget(
          frameBudgetMs(CONTROL_SAMPLES * FIRST_BELT_FRAMES) + tickBudgetMs(FIRST_BELT_TICKS),
          'the negative control: samples of a carrying belt with the item layer hidden',
        ),
      },
    )
    .toBeGreaterThanOrEqual(CONTROL_SAMPLES);
  expect(
    changedWhileCarrying,
    `${id}: with the item layer hidden and the treads pinned, the first belt's clip changed on ${changedWhileCarrying} of ${carrying} samples, so something other than an item passes the check`,
  ).toBe(0);

  await showItemLayer(page, true);
  await expect
    .poll(
      async () => {
        await beforeSample();
        const sample = await sampleBelt(page, belt.id, clip, reference);
        return sample.carrying && sample.changed;
      },
      {
        message: `${id}: belt ${belt.id}'s clip changes once the item layer is shown again`,
        intervals: [SAMPLE_GAP_MS],
        timeout: addWaitBudget(
          frameBudgetMs(FIRST_BELT_FRAMES) + tickBudgetMs(FIRST_BELT_TICKS),
          'the negative control: the same clip with the item layer shown again',
        ),
      },
    )
    .toBe(true);
  await pinTreads(page, null);
}

/** Posts one real order at the board's Source through its own webhook URL. */
async function postOrder(page: Page): Promise<void> {
  const url = await webhookUrl(page, 0);
  expect(url, 'Source handle 0 resolves to a loopback webhook URL').toMatch(
    /^http:\/\/127\.0\.0\.1:\d+\/hook\/src-\d+$/,
  );
  const resp = await page.request.post(url as string, {
    data: ORDER_BODY,
    headers: { 'content-type': 'application/json' },
  });
  expect(resp.ok(), `the webhook accepted the order, status ${resp.status()}`).toBe(true);
}

test.afterEach(async ({ page }, testInfo) => {
  await restoreHostAfterFailedTest(page, testInfo);
});

test.describe('the shipped board files, opened through the Examples menu', () => {
  test('the demo board opens with Undo greyed out and an item shows on its first belt', async ({ page }) => {
    const errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await openBoard(page, 'demo_scene');
    await expectFreshBoard(page, 'demo_scene');
    await expectItemDrawnOnFirstBelt(page, 'demo_scene', async () => {});
    await expectRenderLoopAlive(page, 'after the demo board moved');
    errs.assertNone('on the demo board');
  });

  test('the order board opens with Undo greyed out and a real order shows on its first belt', async ({
    page,
  }) => {
    const errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await openBoard(page, 'order_processing');
    await expectFreshBoard(page, 'order_processing');
    await expectItemDrawnOnFirstBelt(page, 'order_processing', () => postOrder(page));
    await expectRenderLoopAlive(page, 'after an order crossed the order board');
    errs.assertNone('on the order board');
  });

  test('the advanced board opens with Undo greyed out and an item shows on its first belt', async ({ page }) => {
    const errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await openBoard(page, 'advanced');
    await expectFreshBoard(page, 'advanced');
    await expectItemDrawnOnFirstBelt(page, 'advanced', async () => {});
    await expectRenderLoopAlive(page, 'after the advanced board moved');
    errs.assertNone('on the advanced board');
  });

  for (const id of ['demo_scene', 'order_processing', 'advanced'] as const) {
    test(`the pixel check fails on the ${id} board with the item layer hidden, and passes when it comes back`, async ({
      page,
    }) => {
      const errs = watchPageErrors(page);
      await page.goto('/');
      await waitForAppReady(page);
      await openBoard(page, id);
      await expectNoChangeWithItemsHidden(page, id, id === 'order_processing' ? () => postOrder(page) : async () => {});
      await expectRenderLoopAlive(page, `after the negative control on ${id}`);
      errs.assertNone(`in the negative control on ${id}`);
    });
  }

  test('three boards loaded back to back in one page each end on their own nodes with Undo greyed out', async ({
    page,
  }) => {
    const errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    for (const id of ['order_processing', 'advanced', 'demo_scene'] as const) {
      await openBoard(page, id);
      await expectFreshBoard(page, id);
      errs.assertNone(`after loading ${id}`);
    }
    await expectRenderLoopAlive(page, 'after three loads in one page');
    await resetToDemo(page);
    errs.assertNone('after the file put the demo back');
  });
});
