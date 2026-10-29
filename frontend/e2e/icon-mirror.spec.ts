import { test, expect } from '@playwright/test';
import { PNG } from 'playwright-core/lib/utilsBundle';
import { buildPacket, mockRenderSocket, waitForChrome } from './support/wire';

// icon-mirror.spec.ts (phase 91, plan 91-10, CHROME-20, D-16, WINDOWS 233, success criterion 3) -
// Undo and Redo are mirror images on screen at the user's own 1.18 text scale.
//
// `chrome/assets/redo.svg` is `undo.svg` reflected about x = 16, part for part (the mirror
// contract both files state). At a fractional GDK_DPI_SCALE such as 1.1818 the two toolbar glyphs
// did not read as mirrors: every chrome icon root carried `shapeRendering: 'crispEdges'`, which
// snaps each edge to a whole device pixel, and at a fractional device scale the two buttons sit at
// different sub-pixel phases, so the same edge snapped one way on Undo and the other way on Redo.
// `geometricPrecision` draws the true geometry with anti-aliasing at any phase.
//
// THE METRIC (research Finding J, A4). A Chromium context at `deviceScaleFactor` 1.1818 on the real
// app route, both buttons enabled, transitions off, the pointer away, at four CSS widths: 1024,
// 1083 (the 1280 x 800 window at that scale, research Finding O), 1280 and 1600. One device-scale
// page shot per width; each pixel's ink coverage (0..255, its luminance placed between the button's
// fill and the glyph's ink) over Undo's `<svg>` box in device pixels, two pixels of margin each
// side. Redo is mirrored about a vertical axis and laid over Undo at the WHOLE-PIXEL alignment that
// fits best (the smallest summed difference over seven candidate axes around the boxes' own
// mirror axis), and the reading is the largest per-pixel difference at that alignment.
//
// Why this shape, measured while writing it (91-EVIDENCE.md `## Plan 91-10`):
//   - Chromium paints a glyph whose box starts between device pixels at a phase of its own, and
//     the two buttons' phases differ. With `crispEdges` some edges snap one way on Undo and the
//     other way on Redo, so at the best alignment a whole pixel is ink on one and floor on the
//     other: a difference of 255. With `geometricPrecision` an edge is a partial pixel on both,
//     and at the best whole-pixel alignment the two differ by at most half a pixel of ink, 128.
//   - At 1083 alone Chromium happened to put both glyphs at matching phases, and `crispEdges`
//     mirrored exactly (0). A test at that one width would pass the defect, so the four widths
//     are graded together and the worst reading is the verdict.
//   - A mean over the ink, and the maximum after interpolating Redo to Undo's exact sub-pixel
//     mirror, were tried first and did not separate the two hints (a mean of 10.5 for
//     `crispEdges` and 11.4 for `geometricPrecision` at 1083).
//
// THE THRESHOLD is set between the two readings measured at this plan's layout, with margin on
// both sides: the fix (`geometricPrecision`) and the defect (`crispEdges` restored in a throwaway
// worktree, `MUT icon-mirror verdict=RED by=crispedges-restored`). The numbers are below. The
// real WebKitGTK app at GDK_DPI_SCALE 1.1818 is graded by eye on the close plan's walk.

/**
 * 192 of 255, between the two readings at plan 91-10's layout, 64 above the fix and 63 below the
 * defect. THE FIX (`geometricPrecision`): worst 128 (1024 x 768 128, 1083 x 677 64, 1280 x 800 128,
 * 1600 x 1000 64), the same on two runs. THE DEFECT (`crispEdges` restored in a throwaway worktree,
 * `MUT icon-mirror verdict=RED by=crispedges-restored`): worst 255 (1024 255, 1083 0, 1280 255,
 * 1600 255). At `PHASE91_START` (its own layout, `crispEdges`): worst 255 (243, 255, 255, 255).
 * Recorded in 91-EVIDENCE.md `## Plan 91-10`.
 */
const MAX_DIFF_THRESHOLD = 192;

const DPR = 1.1818;

const WIDTHS = [
  { width: 1024, height: 768 },
  { width: 1083, height: 677 },
  { width: 1280, height: 800 },
  { width: 1600, height: 1000 },
] as const;

test('Undo and Redo are mirror images at device scale 1.1818, at four window widths [CHROME-20]', async ({ browser }) => {
  test.setTimeout(90_000);
  const readings: string[] = [];
  let worst = 0;
  for (const vp of WIDTHS) {
    const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: DPR });
    const page = await ctx.newPage();
    try {
      const h = await mockRenderSocket(page);
      await page.goto('/');
      await waitForChrome(page);
      await h.connected;
      h.inject(buildPacket({ tick: 1, canUndo: true, canRedo: true }));
      await expect(page.locator('header button[aria-label="Undo"]')).toBeEnabled();
      await expect(page.locator('header button[aria-label="Redo"]')).toBeEnabled();
      await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; }' });
      await page.mouse.move(5, 400);
      await page.evaluate(async () => {
        await document.fonts.ready;
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      });
      const m = await page.evaluate((dpr) => {
        const box = (name: string) => {
          const r = (document.querySelector(`header button[aria-label="${name}"] svg`) as SVGElement).getBoundingClientRect();
          return { left: r.left * dpr, top: r.top * dpr, right: r.right * dpr, bottom: r.bottom * dpr };
        };
        const btn = document.querySelector('header button[aria-label="Undo"]') as HTMLElement;
        const svg = btn.querySelector('svg') as SVGElement;
        return {
          undo: box('Undo'),
          redo: box('Redo'),
          fill: getComputedStyle(btn).backgroundColor,
          ink: getComputedStyle(svg).color,
          shape: getComputedStyle(svg).shapeRendering,
        };
      }, DPR);
      const png = PNG.sync.read(await page.screenshot({ scale: 'device' }));
      const rgb = (c: string): number[] => c.match(/\d+(\.\d+)?/g)!.map(Number);
      const lum = (r: number, g: number, b: number): number => 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const [fr, fg, fb] = rgb(m.fill);
      const [ir, ig, ib] = rgb(m.ink);
      const lFill = lum(fr, fg, fb);
      const lInk = lum(ir, ig, ib);
      expect(Math.abs(lInk - lFill), 'NON-VACUITY: the glyph ink and the button fill differ').toBeGreaterThan(40);
      const cov = (x: number, y: number): number => {
        if (x < 0 || y < 0 || x >= png.width || y >= png.height) return 0;
        const i = (y * png.width + x) * 4;
        return Math.max(0, Math.min(255, ((lum(png.data[i], png.data[i + 1], png.data[i + 2]) - lFill) / (lInk - lFill)) * 255));
      };
      const x0 = Math.floor(m.undo.left) - 2;
      const x1 = Math.ceil(m.undo.right) + 2;
      const y0 = Math.floor(m.undo.top) - 1;
      const y1 = Math.ceil(m.undo.bottom) + 1;
      // Undo's pixel x is laid over Redo's pixel (axis - 1 - x); the boxes' own axis is
      // undo.left + redo.right, and the best whole-pixel axis within three of it is taken.
      const axis0 = Math.round(m.undo.left + m.redo.right);
      let best = { axis: axis0, sum: Infinity, max: 0 };
      for (let axis = axis0 - 3; axis <= axis0 + 3; axis++) {
        let sum = 0;
        let max = 0;
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            const d = Math.abs(cov(x, y) - cov(axis - 1 - x, y));
            sum += d;
            max = Math.max(max, d);
          }
        }
        if (sum < best.sum) best = { axis, sum, max };
      }
      let undoInk = 0;
      let redoInk = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          if (cov(x, y) > 20) undoInk += 1;
          if (cov(best.axis - 1 - x, y) > 20) redoInk += 1;
        }
      }
      expect(undoInk, `NON-VACUITY ${vp.width}: Undo's glyph carries ink`).toBeGreaterThan(20);
      expect(redoInk, `NON-VACUITY ${vp.width}: Redo's glyph carries ink`).toBeGreaterThan(20);
      worst = Math.max(worst, best.max);
      readings.push(
        `${vp.width}x${vp.height} shape=${m.shape} undo_left=${m.undo.left.toFixed(3)} redo_left=${m.redo.left.toFixed(3)} ` +
          `axis=${best.axis}(${best.axis - axis0 >= 0 ? '+' : ''}${best.axis - axis0}) max=${best.max.toFixed(0)} sum=${best.sum.toFixed(0)} ink=${undoInk}/${redoInk}`,
      );
    } finally {
      await ctx.close();
    }
  }
  console.log(`P91-CHROME-20 mirror dpr=${DPR} worst=${worst.toFixed(0)} ${readings.map((r) => `[${r}]`).join(' ')}`);
  expect(
    worst,
    `Redo mirrored matches Undo at every width: worst per-pixel coverage difference ${worst.toFixed(0)} of 255, at most ${MAX_DIFF_THRESHOLD} (${readings.join('; ')})`,
  ).toBeLessThanOrEqual(MAX_DIFF_THRESHOLD);
});
