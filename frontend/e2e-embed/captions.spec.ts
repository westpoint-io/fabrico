import { expect, test, type Page } from '@playwright/test';
// The PNG decoder Playwright already bundles (pngjs). No new dependency.
import { PNG } from 'playwright-core/lib/utilsBundle';
import {
  expectBoardDrawing,
  expectDrawsAfter,
  fileCaptions,
  glCounts,
  installGlCounter,
  pageUrl,
  placedCell,
  readProbe,
  recordConsoleErrors,
  recordRequests,
  watchPageErrors,
} from './support/health.ts';

// Captions on panels.html, where the demo board sits in a 600 px column, so it draws at about half
// zoom and a ring placed in CSS px rather than world px misses by more than the tolerance. The demo
// board's file has three captions. At 1x and at 4x the board
// must stop on each caption's tick exactly, show `NOTE i OF 3 · TICK t` and the sentence from the
// file with the rail on, and draw a ring around the machine the caption names: the ring's box sits
// 4 world px outside the machine's footprint on every side, the footprint's corner is the cell the
// board file places that machine on, and the ring's blue shows in a compositor screenshot. Play
// reads Continue while a caption holds; Continue removes the ring, the tick rises, and the canvas
// draws again. After the last caption the strip keeps its text without the rail, and Restart
// brings the opening line back.

const PAGE = pageUrl('panels.html');
const DEMO = 'demo_scene';
/** `--fab-focus` in the locked skin, the ring's colour. */
const FOCUS_RGB = [0x4f, 0xa8, 0xff] as const;

async function openPage(page: Page): Promise<() => Promise<void>> {
  const errors = watchPageErrors(page);
  const consoleErrors = recordConsoleErrors(page);
  const requests = recordRequests(page);
  await installGlCounter(page);
  await page.goto(PAGE);
  for (const name of [DEMO, 'docs-script-outcomes', 'docs-arrival-order']) {
    await expect.poll(async () => (await readProbe(page, name)).state, { timeout: 20_000 }).toBe('running');
  }
  return async () => {
    for (const name of [DEMO, 'docs-script-outcomes', 'docs-arrival-order', 'one-factory']) {
      expect((await readProbe(page, name)).captionWithoutRing, `${name}: every caption found its machine`).toBe(false);
    }
    expect((await glCounts(page)).lost).toBe(0);
    errors.assertNone('on the panels page');
    expect(consoleErrors).toEqual([]);
    expect(requests).toEqual([PAGE]);
  };
}

const board = (page: Page, name: string) => page.locator(`fabrico-board[name="${name}"]`);

/** What the strip shows and whether its rail is on. */
async function readStrip(page: Page, name: string): Promise<{ hidden: boolean; text: string; lines: string[]; rail: boolean; height: number }> {
  return page.evaluate((n) => {
    const root = (document.querySelector(`fabrico-board[name="${n}"]`) as HTMLElement).shadowRoot as ShadowRoot;
    const strip = root.querySelector('.captions') as HTMLElement;
    const cs = getComputedStyle(strip);
    return {
      hidden: strip.hidden === true || cs.display === 'none',
      text: strip.textContent ?? '',
      lines: [...strip.children].map((c) => c.textContent ?? ''),
      // The rail is an inset shadow in the focus colour; without it the shadow is transparent.
      rail: cs.boxShadow.includes('rgb(79, 168, 255)'),
      height: strip.getBoundingClientRect().height,
    };
  }, name);
}

/** Click Restart and read the strip in the same turn, before a frame can run. */
async function restartAndReadStrip(page: Page, name: string): Promise<{ lines: string[]; tick: number; bootTick: number }> {
  return page.evaluate((n) => {
    const el = document.querySelector(`fabrico-board[name="${n}"]`) as HTMLElement & {
      fabricoProbe(): { tick: number; bootTick: number };
    };
    const root = el.shadowRoot as ShadowRoot;
    (root.querySelector('button[data-control="restart"]') as HTMLButtonElement).click();
    const p = el.fabricoProbe();
    return { lines: [...(root.querySelector('.captions') as HTMLElement).children].map((c) => c.textContent ?? ''), tick: p.tick, bootTick: p.bootTick };
  }, name);
}

/** How many pixels on the ring's band are the ring's blue, from a compositor screenshot. */
async function ringBluePixels(page: Page, ring: { x: number; y: number; width: number; height: number }): Promise<{ blue: number; band: number }> {
  const clip = { x: Math.floor(ring.x), y: Math.floor(ring.y), width: Math.ceil(ring.width) + 1, height: Math.ceil(ring.height) + 1 };
  const png = PNG.sync.read(await page.screenshot({ clip, animations: 'allow' }));
  let blue = 0;
  let band = 0;
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      // The 2 px border sits just inside the box's edge; count the outer 4 px band.
      const onBand = x < 4 || y < 4 || x >= png.width - 4 || y >= png.height - 4;
      if (!onBand) continue;
      band += 1;
      const i = (y * png.width + x) * 4;
      const d =
        Math.abs(png.data[i] - FOCUS_RGB[0]) + Math.abs(png.data[i + 1] - FOCUS_RGB[1]) + Math.abs(png.data[i + 2] - FOCUS_RGB[2]);
      if (d <= 24) blue += 1;
    }
  }
  return { blue, band };
}

test('the demo board stops on each caption tick at 1x and 4x and rings the machine the caption names', async ({ page }) => {
  test.setTimeout(180_000);
  const finish = await openPage(page);
  const captions = fileCaptions(DEMO);
  expect(captions.length, 'the demo board file has at least two captions').toBeGreaterThanOrEqual(2);
  await board(page, DEMO).scrollIntoViewIfNeeded();

  for (const speed of ['1x', '4x'] as const) {
    await board(page, DEMO).locator('select').selectOption({ label: speed });
    const restarted = await restartAndReadStrip(page, DEMO);
    expect(restarted.tick, `${speed}: Restart returns to the boot tick`).toBe(restarted.bootTick);
    expect(restarted.lines, `${speed}: Restart brings back the opening line`).toEqual([
      `${captions.length} notes on this run. The board stops at each one.`,
    ]);

    for (const [i, want] of captions.entries()) {
      const at = `${DEMO} at ${speed}, caption ${i + 1}`;
      await expect
        .poll(async () => (await readProbe(page, DEMO)).caption !== null, { message: `${at}: a caption holds the board`, timeout: 30_000, intervals: [50] })
        .toBe(true);
      const p = await readProbe(page, DEMO);
      expect(p.tick, `${at}: the board stopped on the caption's tick`).toBe(want.tick);
      expect(p.playing, `${at}: the board is paused`).toBe(false);
      expect(p.caption?.index).toBe(i);
      expect(p.caption?.tick).toBe(want.tick);
      expect(p.caption?.text).toBe(want.text);
      await page.waitForTimeout(300);
      expect((await readProbe(page, DEMO)).tick, `${at}: the board stays on the tick while the caption holds`).toBe(want.tick);

      // What the reader reads.
      const strip = await readStrip(page, DEMO);
      expect(strip.lines, `${at}: the strip`).toEqual([
        `NOTE ${i + 1} OF ${captions.length} · TICK ${want.tick.toLocaleString('en-US')}`,
        want.text,
      ]);
      expect(strip.rail, `${at}: the rail shows while the caption holds`).toBe(true);
      await expect(board(page, DEMO).locator('button[data-control="play"]')).toHaveAttribute('aria-label', 'Continue');
      await expect(board(page, DEMO).locator('button[data-control="play"]')).toHaveAttribute('title', 'Continue');

      // What the reader sees: the ring, around the right machine, through this board's camera.
      const ring = p.caption?.ringRect ?? null;
      const foot = p.caption?.footprintRect ?? null;
      expect(ring, `${at}: a ring shows`).not.toBeNull();
      expect(foot, `${at}: the machine is in the scene`).not.toBeNull();
      if (ring === null || foot === null || p.cameraSnapshot === null) return;
      const scale = p.cameraSnapshot.scale;
      // A ring drawn 4 CSS px out, ignoring the zoom, must miss by more than the 1 px tolerance.
      expect(Math.abs(4 - 4 * scale), `${at}: the zoom ${scale.toFixed(3)} is far enough from 1 to tell world px from CSS px`).toBeGreaterThan(1);
      const offsets = {
        left: foot.x - ring.x,
        top: foot.y - ring.y,
        right: ring.x + ring.width - (foot.x + foot.width),
        bottom: ring.y + ring.height - (foot.y + foot.height),
      };
      for (const [side, gap] of Object.entries(offsets)) {
        expect(Math.abs(gap - 4 * scale), `${at}: the ring's ${side} side is ${gap.toFixed(2)} px out; 4 world px is ${(4 * scale).toFixed(2)}`).toBeLessThanOrEqual(1);
      }
      const cell = placedCell(DEMO, want.highlight);
      const stage = await page.evaluate((n) => {
        const r = ((document.querySelector(`fabrico-board[name="${n}"]`) as HTMLElement).shadowRoot?.querySelector('.stage') as HTMLElement).getBoundingClientRect();
        return { x: r.left, y: r.top };
      }, DEMO);
      const cornerX = stage.x + cell.cellX * 32 * scale + p.cameraSnapshot.x;
      const cornerY = stage.y + cell.cellY * 32 * scale + p.cameraSnapshot.y;
      expect(Math.abs(foot.x - cornerX), `${at}: the footprint starts on handle ${want.highlight}'s cell x ${cell.cellX}`).toBeLessThanOrEqual(1);
      expect(Math.abs(foot.y - cornerY), `${at}: the footprint starts on handle ${want.highlight}'s cell y ${cell.cellY}`).toBeLessThanOrEqual(1);
      const pixels = await ringBluePixels(page, ring);
      expect(pixels.blue, `${at}: the ring's blue is on screen (${pixels.blue} of ${pixels.band} band pixels)`).toBeGreaterThan(pixels.band * 0.25);
      console.log(
        `${at}: held at tick ${p.tick}, ring around handle ${want.highlight} at cell (${cell.cellX},${cell.cellY}), scale ${scale.toFixed(4)}, ` +
          `offsets left ${offsets.left.toFixed(2)} top ${offsets.top.toFixed(2)} right ${offsets.right.toFixed(2)} bottom ${offsets.bottom.toFixed(2)} px, ` +
          `${pixels.blue} of ${pixels.band} band pixels blue`,
      );

      // Continue: the ring goes, the tick rises, and the canvas draws again.
      await expectDrawsAfter(page, DEMO, () => board(page, DEMO).locator('button[data-control="play"]').click(), `${at}, after Continue`);
      await expect.poll(async () => (await readProbe(page, DEMO)).tick, { message: `${at}: the tick rises after Continue`, intervals: [20] }).toBeGreaterThan(want.tick);
      const after = await page.evaluate((n) => {
        const root = (document.querySelector(`fabrico-board[name="${n}"]`) as HTMLElement).shadowRoot as ShadowRoot;
        const r = root.querySelector('.caption-ring') as HTMLElement;
        return { ringShown: !r.hidden && getComputedStyle(r).display !== 'none' };
      }, DEMO);
      const next = await readProbe(page, DEMO);
      if (next.caption === null) {
        expect(after.ringShown, `${at}: Continue removes the ring`).toBe(false);
      }
    }

    // After the last caption the strip keeps it, without the rail.
    const last = captions[captions.length - 1];
    const strip = await readStrip(page, DEMO);
    expect(strip.lines, `${speed}: after the last Continue the strip keeps the last caption`).toEqual([
      `NOTE ${captions.length} OF ${captions.length} · TICK ${last.tick.toLocaleString('en-US')}`,
      last.text,
    ]);
    expect(strip.rail, `${speed}: the rail is off after Continue`).toBe(false);
    await expect(board(page, DEMO).locator('button[data-control="play"]')).toHaveAttribute('aria-label', 'Pause');
    await expectBoardDrawing(page, DEMO, `${speed}, after the last Continue`);
  }

  const back = await restartAndReadStrip(page, DEMO);
  expect(back.lines, 'Restart returns the opening line').toEqual([`${captions.length} notes on this run. The board stops at each one.`]);
  await finish();
});

test('the opening line counts the notes, and a board with no captions has no strip', async ({ page }) => {
  test.setTimeout(90_000);
  const finish = await openPage(page);

  const one = await restartAndReadStrip(page, 'docs-arrival-order');
  expect(fileCaptions('docs-arrival-order')).toHaveLength(1);
  expect(one.lines, 'arrival-order has one note').toEqual(['1 note on this run. The board stops when it comes up.']);

  const many = await restartAndReadStrip(page, DEMO);
  expect(many.lines, 'the demo board has many').toEqual([`${fileCaptions(DEMO).length} notes on this run. The board stops at each one.`]);

  for (const name of ['docs-script-outcomes', 'one-factory']) {
    await expect.poll(async () => (await readProbe(page, name)).state, { timeout: 20_000 }).toBe('running');
    const strip = await readStrip(page, name);
    expect(strip.hidden, `${name} has no captions, so no strip`).toBe(true);
    expect(strip.height, `${name}: the strip takes no room`).toBe(0);
    expect((await readProbe(page, name)).caption).toBeNull();
  }

  // The arrival-order board's one caption rings its first Merge too.
  await board(page, 'docs-arrival-order').scrollIntoViewIfNeeded();
  await expect.poll(async () => (await readProbe(page, 'docs-arrival-order')).caption !== null, { timeout: 20_000 }).toBe(true);
  const held = await readProbe(page, 'docs-arrival-order');
  const want = fileCaptions('docs-arrival-order')[0];
  expect(held.tick).toBe(want.tick);
  expect(held.caption?.ringRect).not.toBeNull();
  const strip = await readStrip(page, 'docs-arrival-order');
  expect(strip.lines).toEqual([`NOTE 1 OF 1 · TICK ${want.tick}`, want.text]);
  await finish();
});
