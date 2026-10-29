import { test, expect, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addWaitBudget, frameBudgetMs, tickBudgetMs } from '../e2e/support/frameSampler';
import {
  DEMO_NODE_COUNT,
  CELL,
  DRAWN_STATE_FRAMES,
  HOST_APPLY_TICKS,
  RENDER_LOOP_ADVANCES,
  RENDER_FRAME_TICKS,
  armAndPlaceAt,
  cameraOf,
  expectRenderLoopAlive,
  loadDemoViaExamples,
  loadExample,
  newBoard,
  openExamples,
  pollScene,
  readScene,
  resetToDemo,
  waitForAppReady,
  waitForCameraSettle,
  watchPageErrors,
  type CameraSnapshot,
  type SceneFacts,
} from './support/oracle';

// 85-scene-load-undo-and-fit.live.spec.ts (DEMO-05, DEMO-07, phase 85 success criterion 3,
// D-10 to D-13).
//
// RIGHT AFTER A SCENE LOADS, UNDO IS GREYED, CTRL+Z CHANGES NOTHING, AND THE CAMERA FRAMES
// THE WHOLE NEW BOARD. Walk-112 found each Ctrl+Z on a freshly loaded demo unplugging one of
// the scene's own docks: the scene was built from ordinary logged commands, and every one of
// them was an undo step. `seed_scene` now ends with a logged history seal, and the command
// layer reads it as the undo floor. Walk-113 found an example load keeping the old zoom: the
// camera fitted once per mount. App.tsx now holds a pending fit per scene load (`fitPendingRef`,
// taken by `takeFit` in `src/chrome/sceneFit.ts`). A user's own `.fab` Open keeps the camera
// the user had (the done-walk spec, 77 leg 4, expects a reopened label back at the same place
// on screen), and so does New.
//
// WHAT IS GRADED IS WHAT THE USER SEES (D-13, Pitfall 5). The Undo button's disabled state is
// read from the DOM, not from the model's `canUndo` flag; Ctrl+Z is graded by the board (the
// node, belt and link sets compared byte for byte before the key and after a fixed number of
// sim ticks and drawn frames); the fit is graded by where every machine lands on screen (its
// whole screen box inside the canvas less the toolbar and the palette, the region the Fit
// reserves) and by the camera equalling the one the shipped Fit button gives on the same
// board. Each scene leg first zooms the camera hard into a corner and checks a machine is off
// screen, so a build that keeps the old camera fails the fit check rather than passing on a
// camera that happened to frame the board already.
//
// Render health in every test: `watchPageErrors` is installed before `page.goto`, and every
// test ends with `expectRenderLoopAlive` and the watcher's `assertNone`
// (fabrico-model-oracle-blindspot: the scene oracle reads the model, which a dead canvas
// does not stop).

/** Machines in each shipped scene, as the oracle's own loaders settle on them. */
const ORDER_NODES = 6;
const ADVANCED_NODES = 12;

/** The topology a user sees, without anything that moves on its own (item counts, pulses,
 *  machine state). Node ids, kinds, cells and ports; belt ids, tiles and docks; wire ends. */
function topologyOf(scene: SceneFacts): string {
  const nodes = scene.nodes
    .map((n) => ({ id: n.id, kind: n.kind, cells: n.cells, ports: n.ports, label: n.label }))
    .sort((a, b) => a.id - b.id);
  const belts = scene.belts
    .map((b) => ({ id: b.id, tiles: b.tiles, docks: b.docks }))
    .sort((a, b) => a.id - b.id);
  const wires = scene.wires
    .map((w) => ({ id: w.id, from: w.from, to: w.to, path: w.path }))
    .sort((a, b) => a.id - b.id);
  return JSON.stringify({ nodes, belts, wires });
}

/** The machines and belts by what they are and where they sit, without ids (a reopened
 *  file's render handles may be numbered afresh). */
function shapeOf(scene: SceneFacts): string {
  const nodes = scene.nodes.map((n) => JSON.stringify([n.kind, n.cells])).sort();
  const belts = scene.belts.map((b) => JSON.stringify(b.tiles.map((t) => [t.cell_x, t.cell_y]))).sort();
  return JSON.stringify({ nodes, belts, wires: scene.wires.length });
}

/** The toolbar's Undo button, by its accessible name. */
function undoButton(page: Page) {
  return page.getByRole('button', { name: 'Undo', exact: true });
}

/** A screen rectangle in canvas-local px. */
interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * The canvas region the Fit frames into: the board canvas less the toolbar (the only
 * `header.fab-panel`) and the palette (the only `aside.fab-panel`), the two rects
 * `computeChromeInsets` in App.tsx reads. Canvas-local, the space the camera maps into.
 */
async function fitRegion(page: Page): Promise<Rect> {
  return page.evaluate(() => {
    const canvases = Array.from(document.querySelectorAll('canvas'));
    const canvas = canvases.reduce((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      return rb.width * rb.height > ra.width * ra.height ? b : a;
    });
    const c = canvas.getBoundingClientRect();
    const t = document.querySelector('header.fab-panel')?.getBoundingClientRect();
    const p = document.querySelector('aside.fab-panel')?.getBoundingClientRect();
    if (!t || !p) throw new Error('the toolbar and the palette are both on screen');
    return { left: p.right - c.left, top: t.bottom - c.top, right: c.width, bottom: c.height };
  });
}

/** One node's screen box under `cam`: its cells' world box, mapped screen = world*scale+pan. */
function screenBoxOf(node: SceneFacts['nodes'][number], cam: CameraSnapshot): Rect {
  const xs = node.cells.map(([x]) => x);
  const ys = node.cells.map(([, y]) => y);
  const wx0 = Math.min(...xs) * CELL;
  const wy0 = Math.min(...ys) * CELL;
  const wx1 = (Math.max(...xs) + 1) * CELL;
  const wy1 = (Math.max(...ys) + 1) * CELL;
  return {
    left: wx0 * cam.scale + cam.x,
    top: wy0 * cam.scale + cam.y,
    right: wx1 * cam.scale + cam.x,
    bottom: wy1 * cam.scale + cam.y,
  };
}

/** Sub-pixel slack on each edge. */
const EDGE_SLACK_PX = 1;

/** The nodes whose screen box is not wholly inside `region`, named for the failure. */
function nodesOutside(scene: SceneFacts, cam: CameraSnapshot, region: Rect): string[] {
  return scene.nodes
    .filter((n) => {
      const b = screenBoxOf(n, cam);
      return (
        b.left < region.left - EDGE_SLACK_PX ||
        b.top < region.top - EDGE_SLACK_PX ||
        b.right > region.right + EDGE_SLACK_PX ||
        b.bottom > region.bottom + EDGE_SLACK_PX
      );
    })
    .map((n) => `handle ${n.id} kind=${n.kind} box=${JSON.stringify(screenBoxOf(n, cam))}`);
}

/**
 * Move the camera AWAY from the board: wheel-zoom in hard on the top-left of the fit region,
 * as a user does, until at least one machine is off screen. Read back with `cameraOf`, and
 * proven: a camera that still framed every machine would make the fit check unable to fail.
 */
async function moveCameraAway(page: Page): Promise<CameraSnapshot> {
  const region = await fitRegion(page);
  await page.mouse.move(region.left + 40, region.top + 40);
  for (let i = 0; i < 12; i++) {
    await page.mouse.wheel(0, -200);
  }
  await waitForCameraSettle(page);
  const cam = await cameraOf(page);
  const scene = await readScene(page);
  expect(
    nodesOutside(scene, cam, region).length,
    `NON-VACUITY: the camera was moved away (zoom ${Math.round(cam.scale * 100)}%), so a machine is off screen`,
  ).toBeGreaterThan(0);
  return cam;
}

/**
 * The fit half of success criterion 3 on the board on screen: every machine's whole screen box
 * lies inside the fit region, and the camera is the one the shipped Fit button gives on this
 * same board (the load framed it exactly as Fit, Home and boot do).
 */
async function expectBoardFramed(page: Page, what: string): Promise<void> {
  await waitForCameraSettle(page);
  const scene = await readScene(page);
  expect(scene.nodes.length, `NON-VACUITY: the ${what} has machines to frame`).toBeGreaterThan(0);
  const region = await fitRegion(page);
  const cam = await cameraOf(page);
  expect(nodesOutside(scene, cam, region), `every machine of the ${what} is on screen after it loads`).toEqual([]);
  await page.getByTitle('Fit factory to view (Home)').click();
  await waitForCameraSettle(page);
  const fit = await cameraOf(page);
  expect(
    Math.abs(cam.scale - fit.scale) / fit.scale,
    `the ${what} loaded at the Fit camera's zoom (loaded ${cam.scale}, Fit ${fit.scale})`,
  ).toBeLessThan(0.005);
  expect(Math.abs(cam.x - fit.x), `the ${what} loaded at the Fit camera's x pan`).toBeLessThan(2);
  expect(Math.abs(cam.y - fit.y), `the ${what} loaded at the Fit camera's y pan`).toBeLessThan(2);
}

/**
 * Press Ctrl+Z, then wait a FIXED amount of host and render progress before the caller
 * compares the board: `HOST_APPLY_TICKS` sim ticks (a command folds inside that many, plan
 * 84-17's measurement) twice over, and then `expectRenderLoopAlive`, which needs
 * `RENDER_LOOP_ADVANCES` advances of the drawn frame. An undo that did land is on the board by
 * then; the wait is derived from the oracle's budgets, never picked.
 */
async function pressUndoAndWait(page: Page, context: string): Promise<void> {
  const tickBefore = (await readScene(page)).tick;
  await page.keyboard.press('Control+z');
  const ticks = 2 * HOST_APPLY_TICKS;
  await expect
    .poll(async () => (await readScene(page)).tick - tickBefore, {
      message: `the board ran ${ticks} sim ticks after Ctrl+Z ${context}`,
      timeout: addWaitBudget(
        tickBudgetMs(ticks + RENDER_LOOP_ADVANCES * RENDER_FRAME_TICKS) + frameBudgetMs(DRAWN_STATE_FRAMES),
        'ticks after the Ctrl+Z: a fold lands inside HOST_APPLY_TICKS, taken twice',
      ),
      intervals: [100, 250, 500],
    })
    .toBeGreaterThanOrEqual(ticks);
  await expectRenderLoopAlive(page, `after Ctrl+Z ${context}`);
}

/**
 * The undo half of success criterion 3 on the board on screen: Undo is disabled in the DOM,
 * and Ctrl+Z leaves the topology byte-equal.
 */
async function expectUndoInertOnFreshScene(page: Page, scene: string): Promise<void> {
  const before = await readScene(page);
  expect(before.nodes.length, `NON-VACUITY: the ${scene} has machines`).toBeGreaterThan(0);
  // Soft, so a red run still reaches the Ctrl+Z and shows what it does to the board.
  await expect
    .soft(undoButton(page), `the Undo button is greyed right after the ${scene} loads`)
    .toBeDisabled();
  await pressUndoAndWait(page, `on the freshly loaded ${scene}`);
  const after = await readScene(page);
  expect(
    topologyOf(after),
    `Ctrl+Z on the freshly loaded ${scene} changed nothing: no machine, belt, dock or cable moved`,
  ).toBe(topologyOf(before));
  await expect(undoButton(page), `the Undo button is still greyed after Ctrl+Z on the ${scene}`).toBeDisabled();
}

/**
 * Start a page-side latch, sampled on every drawn frame, that records the board's tick
 * dropping below `before`: the swap a Load or a scene load makes re-seeds the tick lower, and
 * a playing board climbs back within a second, so a coarser poll could miss the dip (the
 * `newBoard` discipline). Read-only: it observes the scene and issues nothing.
 */
async function startSwapLatch(page: Page): Promise<number> {
  const before = (await readScene(page)).tick;
  await page.evaluate((b) => {
    const w = window as unknown as {
      __fabrico: { scene(): { tick: number } };
      __swapSeen?: boolean;
      __swapStop?: boolean;
    };
    w.__swapSeen = false;
    w.__swapStop = false;
    const step = (): void => {
      if (w.__fabrico.scene().tick < b) {
        w.__swapSeen = true;
        return;
      }
      if (w.__swapStop !== true) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }, before);
  return before;
}

/** Wait for the latch above to see the swap, then stop it. */
async function waitForSwap(page: Page, what: string, before: number): Promise<void> {
  try {
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __swapSeen?: boolean }).__swapSeen === true), {
        message: `${what} swapped the board in (the tick restarted below ${before})`,
        timeout: 30_000,
      })
      .toBe(true);
  } finally {
    await page
      .evaluate(() => {
        (window as unknown as { __swapStop?: boolean }).__swapStop = true;
      })
      .catch(() => undefined);
  }
}

/** Boot to the shipped demo, the start of every leg. */
async function bootToDemo(page: Page): Promise<void> {
  await page.goto('/');
  await waitForAppReady(page);
  await resetToDemo(page);
}

test.describe('DEMO-05 and DEMO-07: right after a scene loads, Undo is greyed, Ctrl+Z changes nothing, and the board is framed', () => {
  test('the demo: framed after it loads, Undo greyed, Ctrl+Z leaves the board byte-equal', async ({ page }) => {
    const pageErrors = watchPageErrors(page);
    await bootToDemo(page);

    await moveCameraAway(page);
    // `loadDemoViaExamples` clicks the entry only; `resetToDemo` would also press Fit, which
    // is the very thing this leg must not do for the load.
    const before = await startSwapLatch(page);
    await loadDemoViaExamples(page);
    await waitForSwap(page, 'the demo load', before);
    await pollScene(page, (s) => s.nodes.length === DEMO_NODE_COUNT && s.wires.length === 2, {
      message: 'the demo settled on its baseline',
    }).toBe(true);
    await expectUndoInertOnFreshScene(page, 'demo');
    await expectBoardFramed(page, 'demo');

    await expectRenderLoopAlive(page, 'at the end of the demo leg');
    pageErrors.assertNone('during the demo leg');
  });

  test('Order processing: framed after it loads, Undo greyed, Ctrl+Z leaves the board byte-equal', async ({ page }) => {
    const pageErrors = watchPageErrors(page);
    await bootToDemo(page);

    await moveCameraAway(page);
    await loadExample(page, 'order_processing', ORDER_NODES);
    await expectUndoInertOnFreshScene(page, 'order processing example');
    await expectBoardFramed(page, 'order processing example');

    await expectRenderLoopAlive(page, 'at the end of the order processing leg');
    pageErrors.assertNone('during the order processing leg');
  });

  test('Advanced: framed after it loads, Undo greyed, Ctrl+Z leaves the board byte-equal', async ({ page }) => {
    const pageErrors = watchPageErrors(page);
    await bootToDemo(page);

    await moveCameraAway(page);
    await loadExample(page, 'advanced', ADVANCED_NODES);
    await expectUndoInertOnFreshScene(page, 'advanced example');
    await expectBoardFramed(page, 'advanced example');

    await expectRenderLoopAlive(page, 'at the end of the advanced leg');
    pageErrors.assertNone('during the advanced leg');
  });

  test('a saved and reopened user board: the camera stays, one Ctrl+Z removes only the user machine, then Undo is greyed', async ({
    page,
  }) => {
    const pageErrors = watchPageErrors(page);
    const fab = join(tmpdir(), `fabrico-e2e-85-reopen-${Date.now()}.fab`);
    await bootToDemo(page);

    // The user's own edit: one Source on a free cell, well clear of the demo (rows 0..8).
    const SOURCE_CELL: [number, number] = [10, 12];
    const pristine = await readScene(page);
    await armAndPlaceAt(page, 'Source', SOURCE_CELL[0], SOURCE_CELL[1]);
    await pollScene(page, (s) => s.nodes.length, {
      message: 'the user Source folded on the live host',
    }).toBe(pristine.nodes.length + 1);
    await expect(undoButton(page), 'the user edit is undoable before the save').toBeEnabled();

    page.once('dialog', (d) => void d.accept(fab));
    await page.getByTitle('Save (Ctrl+S) - Shift for Save As').click();
    await expect
      .poll(() => existsSync(fab), {
        timeout: 45_000,
        intervals: [200, 500, 1000],
        message: 'the host wrote the .fab (a real save artifact on disk)',
      })
      .toBe(true);

    const away = await moveCameraAway(page);
    page.once('dialog', (d) => void d.accept(fab));
    await page.getByTitle('Load a saved factory').click();
    // The swap is read off the status strip, not the tick: a Save drains the board to
    // quiescence and holds it there, so the reopened board resumes at the very tick the
    // old one stopped at and no tick dip exists to see (measured: 230 before the Open,
    // 230 on the first packet after it). `Loaded` is shown on the first full keyframe
    // after the Open was dispatched, the repopulate signal 09-save-load-status grades.
    await expect
      .poll(async () => ((await page.getByRole('status').textContent()) ?? '').trim(), {
        timeout: 15_000,
        intervals: [100, 250, 500],
        message: 'the Open resolved to "Loaded" when the saved board repopulated',
      })
      .toBe('Loaded');
    await pollScene(page, (s) => s.nodes.length, {
      message: 'the reopened board holds the demo and the user Source',
    }).toBe(pristine.nodes.length + 1);
    // A user's own board keeps the camera they had: the Open arms no fit (only the demo and
    // the examples do), so the camera the leg moved stays exactly where it was.
    await expectRenderLoopAlive(page, 'on the reopened board');
    await waitForCameraSettle(page);
    expect(await cameraOf(page), 'the Open leaves the camera where the user put it').toEqual(away);

    // UNDO-07: the user's own edit is still undoable after the reopen ...
    await expect(undoButton(page), 'the reopened board keeps the user edit undoable').toBeEnabled();
    await page.keyboard.press('Control+z');
    await pollScene(page, (s) => s.nodes.length, {
      message: 'one Ctrl+Z on the reopened board undid the user Source',
    }).toBe(pristine.nodes.length);
    const undone = await readScene(page);
    expect(
      undone.nodes.some((n) => n.cells.some(([x, y]) => x === SOURCE_CELL[0] && y === SOURCE_CELL[1])),
      'the machine the undo removed is the user Source',
    ).toBe(false);
    expect(shapeOf(undone), 'and only the user Source: the demo is exactly as it loaded').toBe(shapeOf(pristine));
    // ... and the scene under it is not: Undo greys at the scene's floor.
    await expect(undoButton(page), 'Undo is greyed at the scene floor after the user edit is undone').toBeDisabled();
    await pressUndoAndWait(page, 'at the floor of the reopened board');
    expect(topologyOf(await readScene(page)), 'Ctrl+Z at the floor of the reopened board changed nothing').toBe(
      topologyOf(undone),
    );

    await expectRenderLoopAlive(page, 'at the end of the reopened board leg');
    pageErrors.assertNone('during the reopened board leg');
  });

  test('New: the camera does not move', async ({ page }) => {
    const pageErrors = watchPageErrors(page);
    await bootToDemo(page);

    const away = await moveCameraAway(page);
    await newBoard(page);
    await expectRenderLoopAlive(page, 'after New');
    await waitForCameraSettle(page);
    expect(await cameraOf(page), 'New leaves the camera where the user put it').toEqual(away);

    await expectRenderLoopAlive(page, 'at the end of the New leg');
    pageErrors.assertNone('during the New leg');
  });

  test('a Ctrl+Z pressed as an example loads: the new board still arrives framed with Undo greyed', async ({ page }) => {
    const pageErrors = watchPageErrors(page);
    await bootToDemo(page);

    // The old board carries a user edit, so Undo is live on it and the example load raises
    // the discard guard; the Ctrl+Z follows the Discard click at once, inside the window
    // before the swap's keyframe arrives (the DEMO-05 concurrency edge, T-85-16).
    await armAndPlaceAt(page, 'Source', 10, 12);
    await expect(undoButton(page), 'the old board has a user edit to undo').toBeEnabled();
    await moveCameraAway(page);
    await openExamples(page);
    await page.getByRole('button', { name: 'Load order processing' }).click();
    const discard = page.locator('.fab-dialog-panel').getByRole('button', { name: 'Discard' });
    await expect(discard, 'the dirty board raised the discard guard').toBeVisible();
    await discard.click();
    await page.keyboard.press('Control+z');

    await pollScene(page, (s) => s.nodes.length === ORDER_NODES && s.wires.length === 0, {
      message: 'the order processing example arrived',
    }).toBe(true);
    await expect(undoButton(page), 'the new board arrives with Undo greyed').toBeDisabled();
    await expectBoardFramed(page, 'order processing example loaded under a Ctrl+Z');

    await expectRenderLoopAlive(page, 'at the end of the race leg');
    pageErrors.assertNone('during the race leg');
  });
});
