import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { PNG } from 'playwright-core/lib/utilsBundle';
import { addWorkBudget } from '../e2e/support/frameSampler';
import { pauseAndSettle, resumeIfPaused } from './support/beltBoard';
import { measureTileProperties } from './support/boardMeasure';
import { collectCaptureFacts } from './support/captureFacts';
import {
  CAPTURE_BOOTS,
  CAPTURE_ROOT,
  CAPTURE_ZOOMS,
  bootId,
  captureDir,
  zoomId,
  type CaptureEntry,
  type CaptureManifest,
} from './support/captureMatrix';
import { ZOOM_TOLERANCE, panBy, tilePlan, zoomTo, type TileOffset } from './support/captureZoom';
import {
  cameraOf,
  captureClip,
  expectRenderLoopAlive,
  resetToDemo,
  waitForAppReady,
  waitForCameraSettle,
  watchPageErrors,
} from './support/oracle';

// board.capture.ts - captures the demo board on the real host, one test per boot (pixel ratio and
// antialiasing setting), and measures each capture.
//
// Each test opens its own browser context at the boot's pixel ratio (an `on` boot adds the dev-only
// antialiasing flag from `src/render/testAntialias.ts` to the URL), brings the shared host back
// to the demo board, reloads so the board's own fit runs, pauses through the toolbar and pins the
// render clock so nothing moves between the model read and the capture. Then for each zoom it
// sets the camera through the shipped controls (`captureZoom.ts`). Where the board overflows the
// viewport it pans to further tiles (`tilePlan`), tile 0 being the zoom's own camera. At each tile
// it checks render health, takes one viewport capture, reads the facts the capture is measured
// against, and measures every graded property (`measureTileProperties`) for the subjects whose
// whole sampling area is clear there. It writes the PNGs
// (`z-<zoom>-t<tile>.png`), each capture's facts (`z-<zoom>-t<tile>.facts.json`) and `manifest.json` under `test-results/capture/<boot id>/`, entries
// in zoom order then tile order, which the grading project (`board-grade.capture.ts`) reads.
//
// THE TIME LIMIT. A test's limit is the config's 90 s, plus the budget every wait adds for itself
// (`addWaitBudget`, `addFrameBudget`), plus two measured shares added here with `addWorkBudget`:
// `BOOT_WORK_BUDGET_MS` once, for the boot, and `TILE_WORK_BUDGET_MS` once per tile, for whatever
// the tile spends beyond its waits' budgets. Without the two shares the boot and the tiles' overrun
// came out of the 90 s, and on CI run 45022991094 the ratio-2 test with antialiasing on ran out
// after zoom 4. Each boot logs `CAPTURE_BOOT ... uncoveredMs=` and each zoom `CAPTURE_TILES ...
// uncoveredMsMax=`, the numbers the two shares are derived from, so a CI log is enough to check them.
//
// No capture is compared with a stored image. Every check is a measured property, graded in the
// grading project. This test fails only on broken plumbing: a page error, a render loop that
// stopped, a zoom that didn't land, a pan that didn't land, a live antialiasing state (the WebGL
// context's `antialias` attribute and its SAMPLES) that disagrees with the boot, or a capture
// with no machine in it.

/** The viewport every boot captures, in CSS px. */
const VIEWPORT = { width: 1600, height: 1000 } as const;

/**
 * The test-limit share each tile gets for the time it spends beyond the budgets its waits add:
 * the zoom or pan gesture and its settle (which add none), reading the facts, decoding and measuring
 * the capture, writing the files, and any overrun of the render health check and the capture past
 * their own frame budgets (4.4 s and 11.9 s at `FLOOR_FPS`).
 *
 * Measured on this machine on one core under a 50% CPU quota with the 4-CPU shim, the slowest
 * setting at which the render health check still holds (at 25% the board draws under one frame a
 * second, far below the 3.5 floor). A ratio-2 tile there takes about 1.6 times as long as on the
 * slow runner of CI run 45022991094 (30 to 32 s against 19 to 21). Over two runs that covered both
 * ratio-2 boots, the slowest tile spent 16.65 s beyond its waits' budgets (antialiasing on,
 * full-screen boot zoom). Doubled that is 33.3 s, rounded up to 35.
 */
const TILE_WORK_BUDGET_MS = 35_000;

/** What `TILE_WORK_BUDGET_MS` pays for, as each tile's budget annotation names it. */
const TILE_WORK = 'the zoom or pan and its settle, the facts read, decode, measure and write';

/**
 * The test-limit share for the boot: opening the page, loading the demo, reloading so the fit runs,
 * and pausing. None of those waits adds a budget, and most of the time is the page's own start-up,
 * which scales with the machine. The slowest boot measured at the setting above was 87.7 s (ratio 2,
 * antialiasing on). Doubled that is 175.4 s, rounded up to 180.
 */
const BOOT_WORK_BUDGET_MS = 180_000;

for (const boot of CAPTURE_BOOTS) {
  test(`capture dpr=${boot.dpr} aa=${boot.aa}`, async ({ browser }, testInfo) => {
    const id = bootId(boot);
    addWorkBudget(BOOT_WORK_BUDGET_MS, `${id}: open, load the demo, reload and pause`);
    const bootStart = Date.now();
    const limitAtBootStart = testInfo.timeout;
    const dir = captureDir(boot);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });

    const context = await browser.newContext({
      baseURL: testInfo.project.use.baseURL,
      viewport: VIEWPORT,
      deviceScaleFactor: boot.dpr,
    });
    const page = await context.newPage();
    const errors = watchPageErrors(page);
    let paused = false;
    try {
      await page.goto(boot.aa === 'on' ? '/?fab-test-antialias' : '/');
      await waitForAppReady(page);
      // The host is shared, so whatever ran before may have left another board. Load the demo,
      // then reload: the board's fit runs only at boot, and LoadDemo keeps the old camera.
      await resetToDemo(page);
      await page.reload();
      await waitForAppReady(page);
      await waitForCameraSettle(page);

      await resumeIfPaused(page);
      const pausedAt = await pauseAndSettle(page, id);
      paused = true;
      await page.evaluate((n) => {
        const hook = (window as unknown as { __fabrico?: { pinClock(n: number | null): void } }).__fabrico;
        if (hook === undefined) throw new Error('window.__fabrico is not installed');
        hook.pinClock(n);
      }, pausedAt);

      const bootScale = (await cameraOf(page)).scale;
      const bootMs = Date.now() - bootStart;
      // As for a tile: the boot's time beyond the budgets its waits added is what BOOT_WORK_BUDGET_MS covers.
      console.log(
        `CAPTURE_BOOT ${id} bootMs=${bootMs} uncoveredMs=${bootMs - (testInfo.timeout - limitAtBootStart)} bootBudgetMs=${BOOT_WORK_BUDGET_MS}`,
      );
      const entries: CaptureEntry[] = [];
      for (const zoom of CAPTURE_ZOOMS) {
        const zid = zoomId(zoom);
        const zoomStart = Date.now();
        let gestureMsMax = 0;
        let workMsMax = 0;
        let uncoveredMsMax = 0;
        // Tile 0's share is given before the zoom gesture, each later tile's before its pan.
        addWorkBudget(TILE_WORK_BUDGET_MS, `${id} zoom=${zid} tile=0: ${TILE_WORK}`);
        let tileStart = Date.now();
        let limitAtTileStart = testInfo.timeout;
        const zoomGestureStart = tileStart;
        const zoomCamera = zoom === 'boot' ? await cameraOf(page) : await zoomTo(page, zoom);
        gestureMsMax = Date.now() - zoomGestureStart;
        if (zoom !== 'boot') {
          expect(Math.abs(zoomCamera.scale - zoom), `${id} zoom=${zid}: the camera landed on the zoom asked for`).toBeLessThanOrEqual(ZOOM_TOLERANCE);
        }
        // The tile plan is made from tile 0's facts: where the board and the chrome sit at the
        // zoom's own camera.
        let plan: TileOffset[] = [{ dx: 0, dy: 0 }];
        let at: TileOffset = { dx: 0, dy: 0 };
        for (let tile = 0; tile < plan.length; tile++) {
          const label = `${id} zoom=${zid} tile=${tile}`;
          let camera = zoomCamera;
          if (tile > 0) {
            const want = plan[tile];
            addWorkBudget(TILE_WORK_BUDGET_MS, `${label}: ${TILE_WORK}`);
            const panStart = Date.now();
            tileStart = panStart;
            limitAtTileStart = testInfo.timeout;
            // A pan wheel moves the board by minus its delta (`camera.ts` onWheel, pan branch).
            camera = await panBy(page, -(want.dx - at.dx), -(want.dy - at.dy));
            gestureMsMax = Math.max(gestureMsMax, Date.now() - panStart);
            at = want;
            expect(camera.scale, `${label}: a pan keeps the zoom's scale`).toBe(zoomCamera.scale);
            const off = Math.max(Math.abs(camera.x - (zoomCamera.x + want.dx)), Math.abs(camera.y - (zoomCamera.y + want.dy)));
            expect(off, `${label}: the pan landed the board where the tile plan put it (CSS px off)`).toBeLessThanOrEqual(1e-6);
          }
          // The held-board health check waits for the ticker to finish two frames, so by the time
          // it passes the board has been drawn at the new camera.
          errors.assertNone(label);
          await expectRenderLoopAlive(page, label, { boardHeld: true });

          const png = `${id}/z-${zid}-t${tile}.png`;
          const buf = await captureClip(page, { x: 0, y: 0, ...VIEWPORT }, join(CAPTURE_ROOT, png));
          const workStart = Date.now();
          const facts = await page.evaluate(collectCaptureFacts);

          expect(facts.camera, `${label}: the camera didn't move between the pan and the capture`).toEqual(camera);
          expect(facts.dpr, `${label}: the page reads the boot's pixel ratio`).toBe(boot.dpr);
          expect(facts.gl, `${label}: the live WebGL context's antialiasing matches the boot`).toEqual(
            boot.aa === 'on' ? { antialias: true, samples: expect.any(Number) } : { antialias: false, samples: 0 },
          );
          if (boot.aa === 'on') expect(facts.gl.samples, `${label}: an antialiased context has samples`).toBeGreaterThan(0);
          expect(facts.tick, `${label}: the board is still held on the tick it paused on`).toBe(pausedAt);

          const image = PNG.sync.read(buf);
          expect([image.width, image.height], `${label}: the capture is the viewport in device px`).toEqual([
            Math.round(VIEWPORT.width * boot.dpr),
            Math.round(VIEWPORT.height * boot.dpr),
          ]);
          if (tile === 0) plan = tilePlan(facts, VIEWPORT);
          // The facts beside the PNG, so a capture can be measured again without the app.
          writeFileSync(join(CAPTURE_ROOT, png.replace(/\.png$/, '.facts.json')), `${JSON.stringify(facts)}\n`);
          const measured = measureTileProperties(image, facts);
          expect(measured.scene.length, `${label}: the scene has machines`).toBeGreaterThan(0);
          if (plan.length === 1) expect(measured.measurements['outline-sides'].length, `${label}: the capture has machines clear of chrome to measure`).toBeGreaterThan(0);

          entries.push({
            cell: { ...boot, zoom },
            zoomId: zid,
            tile,
            png,
            bootScale,
            camera: facts.camera,
            dpr: facts.dpr,
            backing: facts.backing,
            client: facts.client,
            gl: facts.gl,
            tick: facts.tick,
            scene: measured.scene,
            subjects: measured.subjects,
            measurements: measured.measurements,
          });
          const tileEnd = Date.now();
          workMsMax = Math.max(workMsMax, tileEnd - workStart);
          // What the tile spent beyond the budgets its waits added: the share TILE_WORK_BUDGET_MS covers.
          uncoveredMsMax = Math.max(uncoveredMsMax, tileEnd - tileStart - (testInfo.timeout - limitAtTileStart));
        }
        // `uncoveredMsMax` is what TILE_WORK_BUDGET_MS is derived from: read it off a CI run.
        console.log(
          `CAPTURE_TILES ${id} zoom=${zid} tiles=${plan.length} scale=${zoomCamera.scale} zoomMs=${Date.now() - zoomStart} gestureMsMax=${gestureMsMax} workMsMax=${workMsMax} uncoveredMsMax=${uncoveredMsMax} workBudgetMs=${TILE_WORK_BUDGET_MS}`,
        );
      }
      const manifest: CaptureManifest = { boot, entries };
      writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
      errors.assertNone(`${id} after the last capture`);
    } finally {
      // The host is shared by every boot and every later suite: free the render clock and play.
      await page
        .evaluate(() => (window as unknown as { __fabrico?: { pinClock(n: number | null): void } }).__fabrico?.pinClock(null))
        .catch(() => undefined);
      if (paused) await resumeIfPaused(page).catch(() => undefined);
      await context.close();
    }
  });
}
