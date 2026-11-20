import fs from 'node:fs';
import { test, expect, type Browser, type CDPSession, type Page } from '@playwright/test';
import { CELL, buildPacket, cameraOf, mockRenderSocket, waitForBoard, waitForChrome, type CameraSnapshot, type InjectNode } from './support/wire';
import { machine_kind } from '../src/protocol/kinds';
// The PNG decoder Playwright already bundles (pngjs), as `dpr-crispness.spec.ts` uses it.
// eslint-disable-next-line @typescript-eslint/no-var-requires
import { PNG } from 'playwright-core/lib/utilsBundle';

// dpr-follow.spec.ts - the board canvas follows a pixel-ratio change while the app runs.
//
// WHAT IT PROVES. `bootPixi` reads `devicePixelRatio` once at boot. Without a follower, a
// window that moves to a monitor with another scale keeps its old backing store and the
// browser stretches it, so every edge goes soft. This spec switches the ratio on a running
// page (no reload) and checks three things:
//   1. the canvas backing store becomes round(client size x ratio) after each switch,
//      through 2, then the fractional 1.181793212890625 (a common desktop text scale), then 1;
//   2. the camera's pan and zoom are exactly what they were before the first switch;
//   3. a board switched from 1 to 2 is pixel-for-pixel the board a fresh page opened at 2
//      draws, over the machine's footprint, so a switched board is as sharp as a new one.
//
// WHY THIS SUBJECT. One Factory and no belts, cables or items: nothing moves, the fit is the
// same on every boot, and the render clock is pinned, so two captures can be compared byte
// for byte. A Factory's chassis gives straight edges a stretched store would blur.
//
// HOW THE RATIO IS SWITCHED. CDP `Emulation.setDeviceMetricsOverride` changes the ratio on
// the live page. Captures after a switch go through CDP `Page.captureScreenshot`, never
// `page.screenshot()`: Playwright re-applies the context's own ratio when it captures, which
// would undo the switch. No browser event reports a CDP ratio switch, which is why the
// renderer compares the ratio once per frame (`src/render/dprFollow.ts`).
//
// GATE NOTES. Chromium only (SwiftShader). The WebKitGTK side has no automated harness here;
// the follower itself is the same code in both engines, and `src/render/dprFollow.test.ts` pins
// its compare-and-resize rule.

const RATIOS = [2, 1.181793212890625, 1] as const;

/** One Factory, portless, idle, in the middle of the board. */
const FACTORY: InjectNode = { id: 1, kind: machine_kind.FACTORY, cell_x: 10, cell_y: 6, w: 3, h: 3 };

interface BackingRead {
  canvases: number;
  width: number;
  height: number;
  clientWidth: number;
  clientHeight: number;
  left: number;
  top: number;
  dpr: number;
}

/**
 * Read the board canvas: the one canvas that fills the window. Also reports how many
 * canvases fill the window, so a second full-window canvas can't make the read ambiguous.
 */
async function readBacking(page: Page): Promise<BackingRead> {
  return page.evaluate(() => {
    const full = Array.from(document.querySelectorAll('canvas')).filter(
      (c) => c.clientWidth === window.innerWidth && c.clientHeight === window.innerHeight,
    );
    const c = full[0];
    if (c === undefined) throw new Error('no canvas fills the window');
    const r = c.getBoundingClientRect();
    return {
      canvases: full.length,
      width: c.width,
      height: c.height,
      clientWidth: c.clientWidth,
      clientHeight: c.clientHeight,
      left: r.left,
      top: r.top,
      dpr: window.devicePixelRatio,
    };
  });
}

/** Wait `n` animation frames, so the ticker (follower, render, grid redraw) has run. */
async function frames(page: Page, n: number): Promise<void> {
  await page.evaluate(async (count) => {
    for (let i = 0; i < count; i += 1) await new Promise<void>((r) => requestAnimationFrame(() => r()));
  }, n);
}

/** The grey wash the app lays over a board whose stream stalled while playing. */
const STALE_DIM = '[data-fab-disconnected-dim]';

/**
 * Boot the app route with the one-Factory board, paused, its render clock pinned, and return
 * the page's errors list (filled by a `pageerror` listener attached before navigation).
 *
 * PAUSED ON PURPOSE. The mock socket sends one packet and then nothing, and a PLAYING board
 * that hears nothing for about a second is named disconnected and greyed out (the stall
 * watchdog). Measured: with two workers the fresh page crossed that threshold before its
 * capture, so every pixel of its Factory came back grey and the comparison failed for a
 * reason that has nothing to do with the ratio. Pausing before the packet keeps the watchdog
 * from ever arming, and the dim is asserted absent before every capture.
 */
async function bootBoard(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`${e.message}\n${e.stack ?? '(no stack)'}`));
  const h = await mockRenderSocket(page);
  await page.goto('/');
  await waitForChrome(page);
  await h.connected;
  // Pause BEFORE the packet: the watchdog only arms once a packet has arrived on a playing
  // board, so a board paused first never starts the stall timer (pausing after the packet
  // lost that race once in 16 runs at eight workers).
  await page.getByRole('button', { name: 'Pause' }).click();
  await expect.poll(() => h.controls, { message: 'the page sent pause' }).toContain('pause');
  h.inject(buildPacket({ tick: 3, nodes: [FACTORY] }));
  await waitForBoard(page, { machines: 1, tick: 3 });
  await expect(page.locator(STALE_DIM), 'the board is not greyed out as disconnected').toHaveCount(0);
  await page.evaluate(() => {
    (window as unknown as { __fabrico: { pinClock(n: number | null): void } }).__fabrico.pinClock(0);
  });
  await frames(page, 3);
  return errors;
}

async function switchRatio(cdp: CDPSession, page: Page, ratio: number): Promise<void> {
  const vp = page.viewportSize();
  if (vp === null) throw new Error('the page has no fixed viewport');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: vp.width,
    height: vp.height,
    deviceScaleFactor: ratio,
    mobile: false,
  });
}

/**
 * Poll until the page reads `ratio` and the board canvas backing is round(client size x
 * ratio) in both directions, all read in one sample so the sizes come from the same frame.
 */
async function expectBackingFollows(page: Page, ratio: number, poll: typeof expect = expect): Promise<void> {
  await poll
    .poll(
      async () => {
        const b = await readBacking(page);
        return {
          dpr: b.dpr,
          width: b.width,
          height: b.height,
          widthMinusWant: b.width - Math.round(b.clientWidth * ratio),
          heightMinusWant: b.height - Math.round(b.clientHeight * ratio),
        };
      },
      { message: `the board canvas backing store follows ratio ${ratio}`, timeout: 5_000 },
    )
    .toEqual(expect.objectContaining({ dpr: ratio, widthMinusWant: 0, heightMinusWant: 0 }));
}

/** The Factory's footprint in device pixels of a capture at `ratio`. */
function footprintDevicePx(cam: CameraSnapshot, back: BackingRead, ratio: number): { x0: number; y0: number; x1: number; y1: number } {
  const css = (wx: number, wy: number): [number, number] => [
    back.left + wx * cam.scale + cam.x,
    back.top + wy * cam.scale + cam.y,
  ];
  const [l, t] = css(FACTORY.cell_x * CELL, FACTORY.cell_y * CELL);
  const [r, b] = css((FACTORY.cell_x + (FACTORY.w ?? 1)) * CELL, (FACTORY.cell_y + (FACTORY.h ?? 1)) * CELL);
  return {
    x0: Math.floor(l * ratio),
    y0: Math.floor(t * ratio),
    x1: Math.ceil(r * ratio),
    y1: Math.ceil(b * ratio),
  };
}

/** Capture through CDP (keeps a CDP ratio switch) and cut the region out as raw RGBA. */
async function captureRegion(
  cdp: CDPSession,
  region: { x0: number; y0: number; x1: number; y1: number },
): Promise<{ bytes: Buffer; png: { width: number; height: number } }> {
  const { data } = (await cdp.send('Page.captureScreenshot', { format: 'png' })) as { data: string };
  const png = PNG.sync.read(Buffer.from(data, 'base64'));
  const w = region.x1 - region.x0;
  const out = Buffer.alloc(w * (region.y1 - region.y0) * 4);
  for (let y = region.y0; y < region.y1; y += 1) {
    const src = (y * png.width + region.x0) * 4;
    png.data.copy(out, (y - region.y0) * w * 4, src, src + w * 4);
  }
  return { bytes: out, png: { width: png.width, height: png.height } };
}

/** Count the bytes where two equal-length buffers differ, and the distinct colours in one. */
function diffBytes(a: Buffer, b: Buffer): number {
  let n = 0;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) n += 1;
  return n;
}

function distinctColours(rgba: Buffer): number {
  const seen = new Set<number>();
  for (let i = 0; i < rgba.length; i += 4) seen.add(rgba.readUInt32BE(i));
  return seen.size;
}

async function freshBoardAt(browser: Browser, page: Page, ratio: number) {
  const vp = page.viewportSize();
  if (vp === null) throw new Error('the page has no fixed viewport');
  const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: ratio });
  const fresh = await ctx.newPage();
  return { ctx, fresh };
}

test.describe('the board canvas follows a pixel-ratio change without a reload', () => {
  test('the backing store tracks 1 -> 2 -> 1.181793212890625 -> 1 and the camera never moves', async ({ page }) => {
    const errors = await bootBoard(page);
    const start = await readBacking(page);
    expect(start.canvases, 'exactly one canvas fills the window').toBe(1);
    expect(start.dpr, 'the page boots at ratio 1').toBe(1);
    expect([start.width, start.height], 'the boot backing store is the client size at ratio 1').toEqual([
      start.clientWidth,
      start.clientHeight,
    ]);
    const cam0 = await cameraOf(page);
    expect(cam0.scale, 'the fit gave the camera a zoom').toBeGreaterThan(0);

    const cdp = await page.context().newCDPSession(page);
    // The backing checks are soft, so a run with the follower missing still reaches the
    // camera checks after each switch and reports both.
    const soft = expect.configure({ soft: true });
    for (const ratio of RATIOS) {
      await switchRatio(cdp, page, ratio);
      await expectBackingFollows(page, ratio, soft);
      await frames(page, 3);
      expect(await cameraOf(page), `the camera after switching to ratio ${ratio}`).toEqual(cam0);
    }
    expect(errors, 'no page error').toEqual([]);
  });

  test('a board switched from 1 to 2 matches a fresh ratio-2 boot over the Factory, byte for byte', async ({
    page,
    browser,
  }) => {
    const errors = await bootBoard(page);
    const cam0 = await cameraOf(page);
    const cdp = await page.context().newCDPSession(page);
    await switchRatio(cdp, page, 2);
    // Let the follower and the grid redraw run. The sharpness comparison below is the check
    // here; it doesn't wait on the backing size, so a missing follower fails on the pixels.
    await expect.poll(async () => (await readBacking(page)).dpr, { message: 'the page reads ratio 2' }).toBe(2);
    await frames(page, 6);
    expect(await cameraOf(page), 'the switched board kept its camera').toEqual(cam0);
    const back = await readBacking(page);
    const region = footprintDevicePx(cam0, back, 2);
    await expect(page.locator(STALE_DIM), 'no disconnected wash over the switched board').toHaveCount(0);
    const switched = await captureRegion(cdp, region);
    const vp = page.viewportSize();
    expect(switched.png, 'the CDP capture is at ratio 2').toEqual({ width: vp!.width * 2, height: vp!.height * 2 });

    const { ctx, fresh } = await freshBoardAt(browser, page, 2);
    try {
      const freshErrors = await bootBoard(fresh);
      const freshBack = await readBacking(fresh);
      expect(freshBack.dpr, 'the fresh page boots at ratio 2').toBe(2);
      expect([freshBack.width, freshBack.height], 'the fresh backing store').toEqual([
        Math.round(freshBack.clientWidth * 2),
        Math.round(freshBack.clientHeight * 2),
      ]);
      expect(await cameraOf(fresh), 'the fresh ratio-2 boot fits the same camera').toEqual(cam0);
      // CDP `Page.captureScreenshot` on a context opened at ratio 2 comes back at the CSS
      // size (measured), so the fresh page gets the same ratio-2 override the switched page
      // has, and both captures go through the same path. The fresh page already reads 2, so
      // the override changes nothing it draws: its backing store must not move.
      const freshCdp = await ctx.newCDPSession(fresh);
      await switchRatio(freshCdp, fresh, 2);
      await frames(fresh, 6);
      const freshAfter = await readBacking(fresh);
      expect([freshAfter.width, freshAfter.height], 'the fresh backing store after the same-ratio override').toEqual([
        freshBack.width,
        freshBack.height,
      ]);
      await expect(fresh.locator(STALE_DIM), 'no disconnected wash over the fresh board').toHaveCount(0);
      const reference = await captureRegion(freshCdp, region);
      expect(reference.png, 'the fresh CDP capture is at ratio 2').toEqual(switched.png);

      // Non-vacuity: the region holds the drawn Factory, not a flat floor.
      expect(distinctColours(reference.bytes), 'colours in the fresh Factory region').toBeGreaterThan(2);
      expect(reference.bytes.length, 'the two regions are the same size').toBe(switched.bytes.length);
      if (diffBytes(switched.bytes, reference.bytes) !== 0) {
        // On a mismatch, attach both regions so a reader can see what differs.
        const w = region.x1 - region.x0;
        const h = region.y1 - region.y0;
        for (const [name, bytes] of [['switched', switched.bytes], ['fresh', reference.bytes]] as const) {
          const png = new PNG({ width: w, height: h });
          bytes.copy(png.data);
          fs.writeFileSync(test.info().outputPath(`${name}-factory-region.png`), PNG.sync.write(png));
        }
      }
      expect(
        diffBytes(switched.bytes, reference.bytes),
        `bytes that differ between the switched and the fresh ratio-2 Factory region (${region.x1 - region.x0}x${region.y1 - region.y0} device px)`,
      ).toBe(0);
      expect(freshErrors, 'no page error on the fresh page').toEqual([]);
    } finally {
      await ctx.close();
    }
    expect(errors, 'no page error').toEqual([]);
  });
});
