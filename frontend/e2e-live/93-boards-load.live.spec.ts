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
// that belt carries items. The pixel change on its own could be a cosmetic animation, and items on
// the belt on their own could be a canvas that has stopped, so the check needs both.
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

/** A screen box around a belt's tiles, kept inside the viewport. */
async function clipAround(page: Page, belt: Belt): Promise<{ x: number; y: number; width: number; height: number }> {
  const half = (CELL * (await cameraOf(page)).scale) / 2;
  const centres = await Promise.all(belt.tiles.map((t) => screenCellCentre(page, t.cell_x, t.cell_y)));
  const viewport = page.viewportSize();
  if (viewport === null) throw new Error('the live project sets a viewport');
  const left = Math.max(0, Math.floor(Math.min(...centres.map((c) => c.x)) - half));
  const top = Math.max(0, Math.floor(Math.min(...centres.map((c) => c.y)) - half));
  const right = Math.min(viewport.width, Math.ceil(Math.max(...centres.map((c) => c.x)) + half));
  const bottom = Math.min(viewport.height, Math.ceil(Math.max(...centres.map((c) => c.y)) + half));
  expect(right - left > 0 && bottom - top > 0, 'the first belt is inside the viewport').toBe(true);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * Polls until two clips of the board's first belt differ and a sample has seen items on that belt.
 * `beforeSample` runs ahead of each sample: it does nothing on a board with a timer, and on the
 * order board it posts a real order. The result names both halves, so a failure says which one was
 * missing: pixels false with items true is a dead canvas over a live model.
 */
async function expectFirstBeltMoves(page: Page, id: BoardId, beforeSample: () => Promise<void>): Promise<void> {
  const belt = firstBelt(await readScene(page));
  const clip = await clipAround(page, belt);
  const first = await captureClip(page, clip);
  let pixelsChanged = false;
  let itemsSeen = false;
  await expect
    .poll(
      async () => {
        await beforeSample();
        const scene = await readScene(page);
        const now = scene.belts.find((b) => b.id === belt.id);
        itemsSeen = itemsSeen || (now?.items ?? 0) > 0;
        pixelsChanged = pixelsChanged || !(await captureClip(page, clip)).equals(first);
        return { pixelsChanged, itemsSeen };
      },
      {
        message: `${id}: belt ${belt.id}, the first belt, changes pixels on screen and carries items`,
        timeout: addWaitBudget(
          frameBudgetMs(FIRST_BELT_FRAMES) + tickBudgetMs(FIRST_BELT_TICKS),
          'two differing clips of the first belt and an item on it',
        ),
      },
    )
    .toEqual({ pixelsChanged: true, itemsSeen: true });
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
  test('the demo board opens with Undo greyed out and its first belt moves on screen', async ({ page }) => {
    const errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await openBoard(page, 'demo_scene');
    await expectFreshBoard(page, 'demo_scene');
    await expectFirstBeltMoves(page, 'demo_scene', async () => {});
    await expectRenderLoopAlive(page, 'after the demo board moved');
    errs.assertNone('on the demo board');
  });

  test('the order board opens with Undo greyed out and a real order moves its first belt on screen', async ({
    page,
  }) => {
    const errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await openBoard(page, 'order_processing');
    await expectFreshBoard(page, 'order_processing');
    await expectFirstBeltMoves(page, 'order_processing', () => postOrder(page));
    await expectRenderLoopAlive(page, 'after an order crossed the order board');
    errs.assertNone('on the order board');
  });

  test('the advanced board opens with Undo greyed out and its first belt moves on screen', async ({ page }) => {
    const errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await openBoard(page, 'advanced');
    await expectFreshBoard(page, 'advanced');
    await expectFirstBeltMoves(page, 'advanced', async () => {});
    await expectRenderLoopAlive(page, 'after the advanced board moved');
    errs.assertNone('on the advanced board');
  });

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
