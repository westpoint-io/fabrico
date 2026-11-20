import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { PNG } from 'playwright-core/lib/utilsBundle';
import { pauseAndSettle, resumeIfPaused } from './support/beltBoard';
import { measureTile, sceneMachines } from './support/boardMeasure';
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
// against, and measures the machines whose whole outline is clear there. It writes the PNGs
// (`z-<zoom>-t<tile>.png`) and `manifest.json` under `test-results/capture/<boot id>/`, entries
// in zoom order then tile order, which the grading project (`board-grade.capture.ts`) reads.
//
// No capture is compared with a stored image. Every check is a measured property, graded in the
// grading project. This test fails only on broken plumbing: a page error, a render loop that
// stopped, a zoom that didn't land, a pan that didn't land, a live antialiasing state (the WebGL
// context's `antialias` attribute and its SAMPLES) that disagrees with the boot, or a capture
// with no machine in it.

/** The viewport every boot captures, in CSS px. */
const VIEWPORT = { width: 1600, height: 1000 } as const;

for (const boot of CAPTURE_BOOTS) {
  test(`capture dpr=${boot.dpr} aa=${boot.aa}`, async ({ browser }, testInfo) => {
    const id = bootId(boot);
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
      const entries: CaptureEntry[] = [];
      for (const zoom of CAPTURE_ZOOMS) {
        const zid = zoomId(zoom);
        const zoomCamera = zoom === 'boot' ? await cameraOf(page) : await zoomTo(page, zoom);
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
            // A pan wheel moves the board by minus its delta (`camera.ts` onWheel, pan branch).
            camera = await panBy(page, -(want.dx - at.dx), -(want.dy - at.dy));
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
          const scene = sceneMachines(facts);
          expect(scene.length, `${label}: the scene has machines`).toBeGreaterThan(0);
          const outlines = measureTile(image, facts);
          if (plan.length === 1) expect(outlines.length, `${label}: the capture has machines clear of chrome to measure`).toBeGreaterThan(0);

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
            scene,
            measurements: { 'outline-sides': outlines },
          });
        }
        console.log(`CAPTURE_TILES ${id} zoom=${zid} tiles=${plan.length} scale=${zoomCamera.scale}`);
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
