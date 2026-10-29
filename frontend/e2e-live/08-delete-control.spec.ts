import { test, expect, type Page } from '@playwright/test';
import {
  DEMO_NODE_COUNT,
  expectRenderLoopAlive,
  watchPageErrors,
  CELL,
  INSET,
  HANDLE_OFFSET,
  armAndPlaceFactoryAt,
  cameraOf,
  clickAt,
  loadDemoViaExamples,
  pollScene,
  readScene,
  screenCellCentre,
  screenPoint,
  waitForAppReady,
  type SceneFacts,
} from './support/oracle';

// 08-delete-control.spec.ts (IX-04, 30-06) - the LIVE proof that the discoverable
// DOM delete control is real end-to-end: it appears glued to a selected machine's
// ring, it STAYS glued as the real camera zooms/pans (the camera-projected DOM
// overlay, re-projected every frame through the read-only window.__fabrico.camera()),
// and clicking it deletes the machine through the shipped guarded requestDelete
// path so the real core echoes the removal. No mock: real pointer/wheel events ->
// shipped gesture controller + camera + transport -> real host -> echo packet ->
// window.__fabrico.scene(). If the projection math, the App wiring, or the
// requestDelete route regresses, this gate fails.
//
// Drive rules (live suite, locked): real pointer/wheel events + getByRole/getByTitle
// only; every state wait is an expect.poll on a specific model change (no fixed
// sleeps); any camera-derived expectation RE-READS the camera after the gesture
// (the camera moved). Geometry values come from the ONE allowed shared import via
// the oracle; the 32px control size is a chrome constant documented inline.

test.describe.configure({ mode: 'serial' });

const KIND = { FACTORY: 2 } as const;
/** Empty space below the demo (rows 2..8): a 3x3 factory here stays in the 1280x720 viewport. */
const PLACE_CELL = [6, 11] as const;
/** DeleteControl visual size (px) - a chrome constant (DeleteControl width), not grid geometry. */
const DELETE_SIZE = 32;
/** Screen-px tolerance for the glued-position assertions (subpixel rounding). */
const TOL = 2;

type NodeFacts = SceneFacts['nodes'][number];

/**
 * The placed round-trip factory: the kind-2 node anchored at PLACE_CELL. Cell-found
 * (robust to the demo now shipping TWO factories at boot — the belt-transform factory
 * AND the WUI-01 headline handler — so it targets the one WE placed, never the handler,
 * keeping the headline wire intact for the wire-visual gate).
 */
function placedFactory(s: SceneFacts): NodeFacts {
  const placed = s.nodes.find(
    (n) =>
      n.kind === KIND.FACTORY &&
      n.cells.some((c) => c[0] === PLACE_CELL[0] && c[1] === PLACE_CELL[1]),
  );
  expect(placed, 'the placed factory is present in the oracle').toBeDefined();
  return placed as NodeFacts;
}

/** The ring top-LEFT world corner (mirrors overlay.showSelection origin: cellOrigin+INSET). */
function ringTopLeftWorld(node: NodeFacts): { x: number; y: number } {
  const minX = Math.min(...node.cells.map((c) => c[0]));
  const minY = Math.min(...node.cells.map((c) => c[1]));
  return { x: minX * CELL + INSET, y: minY * CELL + INSET };
}

/**
 * The screen-space top-left the delete control SHOULD sit at right now: project the
 * ring's top-left world corner through the live camera, then apply the App's
 * screen-space offset (-HANDLE_OFFSET - size on X, -HANDLE_OFFSET on Y) that mirrors
 * the rotate handle's top-right offset at the opposite corner (UI-SPEC section 4).
 */
async function expectedControlTopLeft(
  page: Page,
  node: NodeFacts,
): Promise<{ left: number; top: number }> {
  const corner = await screenPoint(page, ringTopLeftWorld(node));
  return { left: corner.x - HANDLE_OFFSET - DELETE_SIZE, top: corner.y - HANDLE_OFFSET };
}

test.describe('IX-04 live: the delete control appears, tracks the camera, and deletes via the guard', () => {
  test.beforeAll(async ({ browser }) => {
    // Known baseline: reset to the demo via the shipped Load-demo CTA (the
    // same falsifiable reset 02-round-trip uses) so rows 11+ are known-empty to
    // place a clean, item-free factory into.
    const context = await browser.newContext({ baseURL: 'http://127.0.0.1:5173' });
    const page = await context.newPage();
    await page.goto('/');
    await waitForAppReady(page);
    const tickBefore = (await readScene(page)).tick;
    await loadDemoViaExamples(page);
    await pollScene(page, (s) => s.tick < tickBefore && s.nodes.length === DEMO_NODE_COUNT, {
      message: 'the LoadDemo genesis swap folded onto the demo baseline',
    }).toBe(true);
    await context.close();
  });

  // RENDER HEALTH in every test (plan 85-08, THE RENDER-HEALTH COUNT;
  // fabrico-model-oracle-blindspot): the watcher goes in BEFORE `page.goto`, and the loop
  // and the watcher are read after every test.
  let errs: ReturnType<typeof watchPageErrors>;

  test.beforeEach(async ({ page }) => {
    errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
  });

  test.afterEach(async ({ page }) => {
    await expectRenderLoopAlive(page, 'at the end of the test');
    errs.assertNone('the delete-control walk');
  });

  test('a selected machine shows a "Delete machine" control glued to its ring, and clicking it deletes via the guarded path', async ({
    page,
  }) => {
    // Place a fresh, item-free factory (no docked belts -> requestDelete sees zero
    // in-flight items -> resolves straight to one commitDelete, no guard dialog).
    // The demo ships TWO factories at boot (belt-transform + WUI-01 headline handler),
    // so assert the placed factory grows the count by exactly one (delta-robust).
    const factoryCount = (s: SceneFacts) => s.nodes.filter((n) => n.kind === KIND.FACTORY).length;
    const beforeFactories = factoryCount(await readScene(page));
    await armAndPlaceFactoryAt(page, PLACE_CELL[0], PLACE_CELL[1]);
    await pollScene(page, factoryCount, {
      message: 'the placed factory appears on the host echo (kind-2 count grows by one)',
    }).toBe(beforeFactories + 1);
    const placed = placedFactory(await readScene(page));

    // No control before selection.
    await expect(page.getByRole('button', { name: 'Delete machine' })).toBeHidden();

    // Select the factory: click its anchor body cell (min-x/min-y of the footprint).
    const minX = Math.min(...placed.cells.map((c) => c[0]));
    const minY = Math.min(...placed.cells.map((c) => c[1]));
    const anchor = await screenCellCentre(page, minX, minY);
    await clickAt(page, anchor.x, anchor.y);

    // The discoverable control appears, glued to the ring's top-left corner.
    const control = page.getByRole('button', { name: 'Delete machine' });
    await expect(control).toBeVisible();
    const want = await expectedControlTopLeft(page, placed);
    await expect
      .poll(async () => (await control.boundingBox())?.x ?? -1, {
        message: 'the control X sits at the projected ring top-left corner',
        timeout: 5_000,
      })
      .toBeCloseTo(want.left, -1); // within ~5px (toBeCloseTo precision -1 = 0.5*10^1)
    const box0 = await control.boundingBox();
    expect(box0, 'the control has a box').not.toBeNull();
    expect(Math.abs(box0!.x - want.left), 'control X glued (boot camera)').toBeLessThanOrEqual(TOL);
    expect(Math.abs(box0!.y - want.top), 'control Y glued (boot camera)').toBeLessThanOrEqual(TOL);

    // Zoom the REAL camera (wheel over the canvas floor) and prove the control
    // TRACKS the machine: re-read the camera, recompute the projected corner, and
    // assert the control moved to stay glued (Pitfall 3 - it must not trail).
    const boot = await cameraOf(page);
    const viewport = page.viewportSize();
    expect(viewport, 'the live viewport size is known').not.toBeNull();
    await page.mouse.move(viewport!.width / 2, viewport!.height / 2);
    await page.mouse.wheel(0, boot.scale >= 1 ? 200 : -200); // zoom-out keeps it on-screen
    const zoomed = await cameraOf(page);
    expect(zoomed.scale, 'the wheel-zoom moved the real camera scale').not.toBeCloseTo(boot.scale, 4);

    const wantZoomed = await expectedControlTopLeft(page, placed);
    // The projected target actually moved (otherwise "tracks" is unfalsifiable).
    expect(
      Math.abs(wantZoomed.left - want.left) + Math.abs(wantZoomed.top - want.top),
      'the projected glue point moved with the camera',
    ).toBeGreaterThan(TOL);
    await expect
      .poll(async () => (await control.boundingBox())?.x ?? -1, {
        message: 'the control re-projects and tracks the machine after the zoom',
        timeout: 5_000,
      })
      .toBeCloseTo(wantZoomed.left, -1);
    const box1 = await control.boundingBox();
    expect(Math.abs(box1!.x - wantZoomed.left), 'control X tracked after zoom').toBeLessThanOrEqual(TOL);
    expect(Math.abs(box1!.y - wantZoomed.top), 'control Y tracked after zoom').toBeLessThanOrEqual(TOL);

    // Click the control: no in-flight items -> the guarded requestDelete resolves
    // to a single Delete; the real core echoes the removal (factory count back to the
    // boot baseline) and the selection clears, unmounting the control.
    await control.click();
    await pollScene(page, factoryCount, {
      message: 'the clicked delete control removes the factory via the real-core echo (count back to baseline)',
    }).toBe(beforeFactories);
    await expect(
      page.getByRole('button', { name: 'Delete machine' }),
      'the control unmounts when the selection clears after the delete',
    ).toBeHidden();
  });
});
