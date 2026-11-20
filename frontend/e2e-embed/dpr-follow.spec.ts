import { expect, test, type Page } from '@playwright/test';
import { pageUrl, readProbe, recordConsoleErrors, watchPageErrors } from './support/health.ts';

// A docs board follows a pixel-ratio change without a reload.
//
// The board boots through the same `bootPixi` as the app, which reads `devicePixelRatio` once.
// The renderer compares the ratio with its resolution once per frame (`src/render/dprFollow.ts`),
// so a page moved to a monitor with another scale gets a backing store at the new ratio instead of
// a stretched one. This spec switches the ratio on the open page with CDP
// `Emulation.setDeviceMetricsOverride` through 2, the fractional 1.181793212890625 and back to 1,
// and after each switch checks that the board's shadow-root canvas backing store is
// round(client size x ratio) and that the probe's camera is exactly the camera read before the
// first switch.
//
// The camera half matters here because the embed refits its camera when its stage resizes (a
// ResizeObserver on the stage). A ratio-only change gave that observer no callback when measured,
// so the camera should stay put, and this spec is what shows it does.

const BOARD = 'demo_scene';
const RATIOS = [2, 1.181793212890625, 1] as const;

interface BoardCanvas {
  width: number;
  height: number;
  clientWidth: number;
  clientHeight: number;
  dpr: number;
}

/** The board's canvas, read inside its shadow root. */
async function readCanvas(page: Page): Promise<BoardCanvas> {
  return page.evaluate((name) => {
    const el = document.querySelector(`fabrico-board[name="${name}"]`);
    const canvas = el?.shadowRoot?.querySelector('canvas');
    if (canvas === null || canvas === undefined) throw new Error(`fabrico-board ${name} has no canvas in its shadow root`);
    return {
      width: canvas.width,
      height: canvas.height,
      clientWidth: canvas.clientWidth,
      clientHeight: canvas.clientHeight,
      dpr: window.devicePixelRatio,
    };
  }, BOARD);
}

test(`${BOARD}: the canvas backing store follows 1 -> 2 -> 1.181793212890625 -> 1 and the camera never moves`, async ({
  page,
}) => {
  test.setTimeout(60_000);
  const errors = watchPageErrors(page);
  const consoleErrors = recordConsoleErrors(page);

  await page.goto(pageUrl('one-board.html'));
  await expect.poll(async () => (await readProbe(page, BOARD)).mounted, { timeout: 20_000 }).toBe(true);
  // Drawn: the ticker has run frames and the canvas has a size.
  await expect.poll(async () => (await readProbe(page, BOARD)).frames, { timeout: 20_000 }).toBeGreaterThan(5);

  const start = await readCanvas(page);
  expect(start.dpr, 'the page opens at ratio 1').toBe(1);
  expect(start.clientWidth, 'the board canvas has a width').toBeGreaterThan(0);
  expect([start.width, start.height], 'the boot backing store is the client size at ratio 1').toEqual([
    start.clientWidth,
    start.clientHeight,
  ]);
  const cam0 = (await readProbe(page, BOARD)).cameraSnapshot;
  expect(cam0, 'the probe reports a camera').not.toBeNull();

  const vp = page.viewportSize();
  if (vp === null) throw new Error('the page has no fixed viewport');
  const cdp = await page.context().newCDPSession(page);
  // The backing checks are soft, so a run with the follower missing still reaches the camera
  // check after each switch and reports both.
  const soft = expect.configure({ soft: true });
  for (const ratio of RATIOS) {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: vp.width,
      height: vp.height,
      deviceScaleFactor: ratio,
      mobile: false,
    });
    await soft
      .poll(
        async () => {
          const c = await readCanvas(page);
          return {
            dpr: c.dpr,
            width: c.width,
            height: c.height,
            widthMinusWant: c.width - Math.round(c.clientWidth * ratio),
            heightMinusWant: c.height - Math.round(c.clientHeight * ratio),
          };
        },
        { message: `the board canvas backing store follows ratio ${ratio}`, timeout: 5_000 },
      )
      .toEqual(expect.objectContaining({ dpr: ratio, widthMinusWant: 0, heightMinusWant: 0 }));
    // A few more frames, so a refit the switch might cause has had its chance to run.
    const after = (await readProbe(page, BOARD)).frames;
    await expect.poll(async () => (await readProbe(page, BOARD)).frames, { timeout: 5_000 }).toBeGreaterThan(after + 3);
    expect((await readProbe(page, BOARD)).cameraSnapshot, `the camera after switching to ratio ${ratio}`).toEqual(cam0);
  }

  errors.assertNone('on the one-board page across the ratio switches');
  expect(consoleErrors).toEqual([]);
});
