import { expect, test, type Page } from '@playwright/test';
import {
  autoContinueCaptions,
  expectBoardDrawingAt,
  glCounts,
  installGlCounter,
  pageUrl,
  readProbeAt,
  recordConsoleErrors,
  recordRequests,
  watchPageErrors,
} from './support/health.ts';

// The page cap and lost contexts, on cap.html: ten boards, all within 200 px of a 1920 x 1500
// viewport at once. A page runs at most 8, so the last two in page order wait, each showing its
// poster with the page-cap line. The live-context count comes from the getContext wrapper, never
// from the embed.
//
// Then the browser takes one running board's context (the test calls WEBGL_lose_context on it):
// that board shows its poster with the lost-context line and keeps its slot, so the waiting boards
// keep waiting, and Play draws it again. Last, the test scrolls the first board more than 200 px
// out of view, and the first waiting board takes its slot and draws.

const PAGE = pageUrl('cap.html');
const SLOTS = ['b0', 'b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8', 'b9'] as const;
type Slot = (typeof SLOTS)[number];
const CAPPED = 'Paused to save graphics memory. Scroll the boards above or below out of view to run this one.';
const LOST = "The browser took back this board's graphics. Press Play to redraw it.";

test.use({ viewport: { width: 1920, height: 1500 } });

const sel = (slot: Slot): string => `[data-slot="${slot}"] fabrico-board`;

async function states(page: Page): Promise<Record<Slot, string>> {
  const out = {} as Record<Slot, string>;
  for (const slot of SLOTS) {
    const p = await readProbeAt(page, sel(slot));
    out[slot] = p.mounted ? 'mounted' : p.capped ? 'capped' : p.lostShown ? 'lost' : 'neither';
  }
  return out;
}

/** What a waiting or lost board's stage shows: the band's words, the poster, and any canvas. */
async function stillParts(page: Page, slot: Slot): Promise<{ band: string; poster: boolean; posterWidth: number; canvases: number }> {
  return page.evaluate((s) => {
    const root = (document.querySelector(s) as HTMLElement).shadowRoot as ShadowRoot;
    const band = root.querySelector('.poster-band') as HTMLElement | null;
    const img = root.querySelector('.stage img') as HTMLImageElement | null;
    const visible = (el: Element | null): boolean => el !== null && (el as HTMLElement).getClientRects().length > 0;
    return {
      band: visible(band) ? (band?.textContent ?? '') : '',
      poster: visible(img),
      posterWidth: img?.naturalWidth ?? 0,
      canvases: root.querySelectorAll('canvas').length,
    };
  }, sel(slot));
}

test('eight boards run, two wait on their posters, a lost context redraws on Play, and a freed slot runs a waiting board', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = watchPageErrors(page);
  const consoleErrors = recordConsoleErrors(page);
  const requests = recordRequests(page);
  await installGlCounter(page);
  // A board stops at each caption it has; press Continue at once, as a reader would.
  await autoContinueCaptions(page);
  await page.goto(PAGE);

  // Every board is near the viewport; the first eight in page order run and the last two wait.
  const near = await page.evaluate(() =>
    [...document.querySelectorAll('fabrico-board')].every((el) => el.getBoundingClientRect().top <= window.innerHeight + 200),
  );
  expect(near, 'all ten boards are within 200 px of the viewport').toBe(true);
  await expect
    .poll(() => states(page), { timeout: 20_000, message: 'eight boards mount and two wait' })
    .toEqual({ b0: 'mounted', b1: 'mounted', b2: 'mounted', b3: 'mounted', b4: 'mounted', b5: 'mounted', b6: 'mounted', b7: 'mounted', b8: 'capped', b9: 'capped' });
  let counts = await glCounts(page);
  expect(counts.live, 'live WebGL contexts, counted from outside the page').toBe(8);
  expect(counts.lost, 'no context was lost').toBe(0);
  for (const slot of ['b8', 'b9'] as const) {
    await expect.poll(async () => (await stillParts(page, slot)).posterWidth, { message: `${slot}: the poster decodes` }).toBe(960);
    const parts = await stillParts(page, slot);
    const probe = await readProbeAt(page, sel(slot));
    expect(parts.band, `${slot} (${probe.id}): the page-cap line over the poster`).toBe(CAPPED);
    expect(parts.poster, `${slot} (${probe.id}): the poster shows`).toBe(true);
    expect(parts.canvases, `${slot} (${probe.id}): no canvas`).toBe(0);
    expect(probe.posterAlt, `${slot} (${probe.id}): the poster has alt text`).not.toBeNull();
    expect(probe.playing, `${slot} (${probe.id}): it doesn't run`).toBe(false);
  }

  // The browser takes b2's context. It keeps its slot, so b8 and b9 keep waiting.
  const lostBoard = 'b2';
  const before = await readProbeAt(page, sel(lostBoard));
  expect(before.playing, `${lostBoard} plays before its context goes`).toBe(true);
  await page.evaluate((s) => {
    const canvas = ((document.querySelector(s) as HTMLElement).shadowRoot as ShadowRoot).querySelector('canvas') as HTMLCanvasElement;
    const gl = (canvas.getContext('webgl2') ?? canvas.getContext('webgl')) as WebGLRenderingContext | null;
    const ext = gl?.getExtension('WEBGL_lose_context');
    if (ext === null || ext === undefined) throw new Error('no WEBGL_lose_context on the board canvas');
    ext.loseContext();
  }, sel(lostBoard));
  await expect.poll(async () => (await readProbeAt(page, sel(lostBoard))).lostShown, { message: `${lostBoard} shows the lost-context line` }).toBe(true);
  const lost = await stillParts(page, lostBoard);
  const lostProbe = await readProbeAt(page, sel(lostBoard));
  expect(lost.band, `${lostBoard}: the lost-context line over the poster`).toBe(LOST);
  expect(lost.poster, `${lostBoard}: the poster shows`).toBe(true);
  expect(lost.canvases, `${lostBoard}: its canvas is gone`).toBe(0);
  expect(lostProbe.mounted, `${lostBoard}: no renderer`).toBe(false);
  expect(lostProbe.playing, `${lostBoard}: paused`).toBe(false);
  await page.waitForTimeout(300);
  expect((await readProbeAt(page, sel(lostBoard))).tick, `${lostBoard}: holds its tick`).toBe(lostProbe.tick);
  expect((await states(page)).b8, 'b8 still waits: the lost board kept its slot').toBe('capped');
  counts = await glCounts(page);
  expect(counts.lost, 'the outside counter saw the one context the test took').toBe(1);
  expect(counts.live, 'seven boards hold a live context').toBe(7);

  // Play draws it again, from the tick it was on.
  await page.locator(sel(lostBoard)).locator('button[data-control="play"]').click();
  await expect.poll(async () => (await readProbeAt(page, sel(lostBoard))).mounted, { message: `${lostBoard} mounts again` }).toBe(true);
  const back = await readProbeAt(page, sel(lostBoard));
  expect(back.lostShown, `${lostBoard}: the line goes`).toBe(false);
  expect(back.tick, `${lostBoard}: picks up at the tick it lost its context on`).toBeGreaterThanOrEqual(lostProbe.tick);
  expect((await stillParts(page, lostBoard)).band, `${lostBoard}: no band`).toBe('');
  await expectBoardDrawingAt(page, sel(lostBoard), 'after Play redraws the lost board', `${lostBoard} (${back.id})`);
  counts = await glCounts(page);
  expect(counts.live).toBe(8);
  expect(counts.lost, 'no other context was lost').toBe(1);

  // Scroll b0 more than 200 px out of view: b8, the first to wait, takes its slot and draws.
  const b0Bottom = await page.evaluate((s) => (document.querySelector(s) as HTMLElement).getBoundingClientRect().bottom, sel('b0'));
  await page.evaluate((y) => window.scrollTo(0, y), Math.ceil(b0Bottom + 240));
  await expect
    .poll(() => states(page), { timeout: 20_000, message: 'b0 leaves, b8 runs, b9 still waits' })
    .toEqual({ b0: 'neither', b1: 'mounted', b2: 'mounted', b3: 'mounted', b4: 'mounted', b5: 'mounted', b6: 'mounted', b7: 'mounted', b8: 'mounted', b9: 'capped' });
  const b8 = await readProbeAt(page, sel('b8'));
  expect(b8.capped, 'b8 no longer waits').toBe(false);
  expect((await stillParts(page, 'b8')).band, 'b8: no band').toBe('');
  await expectBoardDrawingAt(page, sel('b8'), 'after a slot frees', `b8 (${b8.id})`);
  counts = await glCounts(page);
  expect(counts.live, 'still at most 8 live contexts').toBe(8);
  expect(counts.lost, 'no context was lost to the cap').toBe(1);
  console.log(`cap page: 8 live, 2 waiting; after the loss and Play, and a freed slot: live ${counts.live}, lost ${counts.lost}, made ${counts.made}`);

  errors.assertNone('on the cap page');
  expect(consoleErrors).toEqual([]);
  expect(requests).toEqual([PAGE]);
});
