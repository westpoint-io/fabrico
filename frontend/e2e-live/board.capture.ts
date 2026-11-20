import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { PNG } from 'playwright-core/lib/utilsBundle';
import { pauseAndSettle, resumeIfPaused } from './support/beltBoard';
import { measureCapture } from './support/boardMeasure';
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
import { ZOOM_TOLERANCE, zoomTo } from './support/captureZoom';
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
// Each test opens its own browser context at the boot's pixel ratio, brings the shared host back
// to the demo board, reloads so the board's own fit runs, pauses through the toolbar and pins the
// render clock so nothing moves between the model read and the capture. Then for each zoom it
// sets the camera through the shipped controls (`captureZoom.ts`), checks render health, takes one
// viewport capture, reads the facts the capture is measured against, and measures it. It writes
// the PNGs and `manifest.json` under `test-results/capture/<boot id>/`, which the grading project
// (`board-grade.capture.ts`) reads.
//
// No capture is compared with a stored image. Every check is a measured property, graded in the
// grading project. This test fails only on broken plumbing: a page error, a render loop that
// stopped, a zoom that didn't land, a live antialiasing state that disagrees with the boot, or a
// capture with no machine in it.

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

      const entries: CaptureEntry[] = [];
      for (const zoom of CAPTURE_ZOOMS) {
        const label = `${id} zoom=${zoomId(zoom)}`;
        const camera = zoom === 'boot' ? await cameraOf(page) : await zoomTo(page, zoom);
        if (zoom !== 'boot') {
          expect(Math.abs(camera.scale - zoom), `${label}: the camera landed on the zoom asked for`).toBeLessThanOrEqual(ZOOM_TOLERANCE);
        }
        // The held-board health check waits for the ticker to finish two frames, so by the time
        // it passes the board has been drawn at the new camera.
        errors.assertNone(label);
        await expectRenderLoopAlive(page, label, { boardHeld: true });

        const png = `${id}/z-${zoomId(zoom)}.png`;
        const buf = await captureClip(page, { x: 0, y: 0, ...VIEWPORT }, join(CAPTURE_ROOT, png));
        const facts = await page.evaluate(collectCaptureFacts);

        expect(facts.camera, `${label}: the camera didn't move between the zoom and the capture`).toEqual(camera);
        expect(facts.dpr, `${label}: the page reads the boot's pixel ratio`).toBe(boot.dpr);
        expect(facts.gl.antialias, `${label}: the live WebGL context's antialiasing matches the boot`).toBe(boot.aa === 'on');
        expect(facts.tick, `${label}: the board is still held on the tick it paused on`).toBe(pausedAt);

        const image = PNG.sync.read(buf);
        expect([image.width, image.height], `${label}: the capture is the viewport in device px`).toEqual([
          Math.round(VIEWPORT.width * boot.dpr),
          Math.round(VIEWPORT.height * boot.dpr),
        ]);
        const outlines = measureCapture(image, facts);
        expect(outlines.length, `${label}: the capture has machines to measure`).toBeGreaterThan(0);

        entries.push({
          cell: { ...boot, zoom },
          png,
          camera: facts.camera,
          dpr: facts.dpr,
          backing: facts.backing,
          client: facts.client,
          gl: facts.gl,
          tick: facts.tick,
          measurements: { 'outline-sides': outlines },
        });
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
