import { test, expect, type Page } from '@playwright/test';
import { cameraOf, waitForAppReady } from './support/oracle';

// 07-zoom-readout.spec.ts (NAV-02) - the live proof that the on-canvas camera
// cluster's zoom-percentage readout REFLECTS the real camera scale and UPDATES
// as the user zooms. The drive path is real: page.mouse.wheel over the real
// canvas -> the shipped camera.onWheel zoom-about-cursor -> container.scale ->
// App's ~10Hz poll folds cam.worldScale() into snap.worldScale -> CameraCluster
// renders Math.round(worldScale*100)+'%'. The oracle is the read-only
// window.__fabrico.camera() (29-03); the readout must always agree with it.
//
// Drive rules (live suite, locked): real pointer/wheel events only, every wait
// is an expect.poll on a specific value (no fixed sleeps), and any camera-derived
// expectation re-reads cameraOf AFTER the gesture (assumption A5 - the camera
// moved). The readout is located by its affordance text, never a baked selector
// beyond the cluster's own title/role.

test.describe.configure({ mode: 'serial' });

/** The zoom-readout button (the "NN%" control whose tooltip resets to 100%). */
function readoutButton(page: Page) {
  return page.getByTitle('Reset zoom to 100%');
}

/** The current readout string, e.g. "100%", trimmed of any incidental whitespace. */
async function readoutText(page: Page): Promise<string> {
  return (await readoutButton(page).textContent())?.trim() ?? '';
}

/** The readout string the camera scale IMPLIES right now: Math.round(scale*100)+'%'. */
async function expectedFromCamera(page: Page): Promise<string> {
  const cam = await cameraOf(page);
  return `${Math.round(cam.scale * 100)}%`;
}

test.describe('NAV-02: the camera cluster zoom readout tracks the real camera', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForAppReady(page);
  });

  test('the readout equals the camera scale at boot, after a wheel-zoom, and after Fit', async ({
    page,
  }) => {
    // (1) At boot (post fit-to-factory): the readout agrees with the live camera.
    const bootReadout = await readoutText(page);
    expect(bootReadout, 'the boot readout renders a percentage').toMatch(/^\d+%$/);
    expect(
      bootReadout,
      'the boot readout equals Math.round(camera.scale*100)+"%" (NAV-02 readout is the real scale)',
    ).toBe(await expectedFromCamera(page));

    // (2) Wheel-zoom over the canvas and prove the readout UPDATES live. Move the
    // pointer to the viewport centre (over the canvas floor, clear of the top
    // toolbar and the bottom-right cluster), then dispatch a classic mouse-wheel
    // notch. The shipped isMouseWheel heuristic reads a large, integral, purely
    // vertical PIXEL delta as a wheel -> zoom-about-cursor. Direction is chosen
    // AWAY from the nearer zoom clamp (MIN 0.25 / MAX 4) so the scale is
    // guaranteed to move (a clamped no-op would make "updates live" unfalsifiable).
    const boot = await cameraOf(page);
    const viewport = page.viewportSize();
    expect(viewport, 'the live viewport size is known').not.toBeNull();
    await page.mouse.move(viewport!.width / 2, viewport!.height / 2);
    const deltaY = boot.scale >= 1 ? 200 : -200; // >=1 -> zoom out; <1 -> zoom in
    await page.mouse.wheel(0, deltaY);

    // The zoom is applied synchronously in onWheel, so the camera is already at
    // its new settled scale; assert it actually moved, then poll the readout
    // (fed at ~10Hz) until it catches up to the new camera-implied percentage.
    const zoomed = await cameraOf(page);
    expect(
      zoomed.scale,
      'the wheel-zoom moved the real camera scale off its boot value',
    ).not.toBeCloseTo(boot.scale, 4);
    const zoomedExpected = `${Math.round(zoomed.scale * 100)}%`;
    expect(zoomedExpected, 'the wheel changed the rounded percentage').not.toBe(bootReadout);
    await expect
      .poll(() => readoutText(page), {
        message:
          'the readout updates live to Math.round(camera.scale*100)+"%" after the wheel-zoom (NAV-02)',
        timeout: 15_000,
        intervals: [100, 250, 500],
      })
      .toBe(zoomedExpected);

    // (3) Click the Fit button: it re-frames via the SAME fit as boot/Home, so on
    // an unchanged host scene the camera returns to the boot fit and the readout
    // returns to its boot value (idempotent re-frame).
    await page.getByRole('button', { name: 'Fit factory to view' }).click();
    await expect
      .poll(() => readoutText(page), {
        message: 'the Fit button re-frames: the readout returns to the boot fitted percentage',
        timeout: 15_000,
        intervals: [100, 250, 500],
      })
      .toBe(bootReadout);
    // And it still agrees with the live camera after the re-fit.
    expect(await readoutText(page)).toBe(await expectedFromCamera(page));
  });

  test('clicking the zoom readout resets zoom to 100%', async ({ page }) => {
    // Zoom away from 100% first (same clamp-aware direction choice), then click
    // the readout: onResetZoom snaps the camera to scale 1.0, so the readout
    // reads exactly "100%" and the live camera scale is 1.
    const boot = await cameraOf(page);
    const viewport = page.viewportSize();
    await page.mouse.move(viewport!.width / 2, viewport!.height / 2);
    await page.mouse.wheel(0, boot.scale >= 1 ? 200 : -200);
    await expect
      .poll(() => readoutText(page), {
        message: 'the readout left 100% after the wheel-zoom (so the reset is falsifiable)',
        timeout: 15_000,
        intervals: [100, 250, 500],
      })
      .not.toBe('100%');

    await readoutButton(page).click();
    await expect
      .poll(() => readoutText(page), {
        message: 'clicking the zoom readout resets the zoom to exactly 100%',
        timeout: 15_000,
        intervals: [100, 250, 500],
      })
      .toBe('100%');
    const reset = await cameraOf(page);
    expect(reset.scale, 'the live camera scale is exactly 1.0 after the reset').toBeCloseTo(1, 4);
  });
});
