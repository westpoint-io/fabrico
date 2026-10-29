import { test, expect, type Page } from '@playwright/test';
import { PNG } from 'playwright-core/lib/utilsBundle';
import { buildPacket, mockRenderSocket, waitForBoard, waitForChrome, type InjectNode } from './support/wire';

// name-tags-under-chrome.spec.ts (phase 91, plan 91-09, CHROME-08, D-07, success criterion 2,
// UI-SPEC section 3 and walk step 5) - machine name tags sit UNDER every chrome surface.
//
// WHAT WAS BROKEN (91-MEASURE.md `## CHROME-08: still broken`). The name-tag layer
// (`MachineLabels.tsx`) shared zIndex 2 with the chrome and was mounted after the Palette, the
// Toolbar, the Legend and the Help panel, so a tag drawn over the Legend read as part of it, and
// tags painted over the palette's right edge and the toolbar.
//
// THE GRADE IS PIXELS. Tags take no pointer events, so a hit test cannot see them. With Names on,
// the Legend and Help open, the board zoomed in so tags lie under every surface (a precondition
// asserts each overlap exists by box), every overlap of a tag and a surface is read three times:
//
//   - as the page shows it;
//   - with the tag layer hidden (an injected `!important` rule, since each chip writes its own
//     inline `visibility`): the overlap must EQUAL the first reading within 2 per channel, so
//     the surface is on top;
//   - with the surface hidden, tags shown and then hidden: those two must DIFFER, so a tag is
//     really drawn there and the first check is not vacuous.
//
// Every overlap is inset by the surface's corner radius (outside a rounded corner the board shows
// through), the surfaces' own words and icons are inked transparent for the shots and CSS
// transitions are cut to their end (a button's 120 ms transition moved pixels between two shots;
// the tags keep their ink).
//
// Surfaces: the toolbar, the palette, the Legend and Help (Names, Legend and Help open), then the
// inspector (a machine selected, which closes Help: the two share one slot, UI-SPEC 2.3). At
// 1024x768 and 1280x800.
//
// RED FIRST (D-17): run once against PHASE91_START by `redfirst.sh` in the kept start worktree,
// this spec carried in; the record is in 91-EVIDENCE.md.

const SIZES = [
  { width: 1024, height: 768 },
  { width: 1280, height: 800 },
] as const;

/** A dense field of Sources, one every third cell, so a zoomed-in board puts tags everywhere. */
const FIELD: InjectNode[] = [];
for (let y = 0; y <= 36; y += 3) {
  for (let x = 0; x <= 54; x += 3) {
    const id = 100 + FIELD.length;
    FIELD.push({ id, kind: 0, cell_x: x, cell_y: y, ports: [{ index: 0, cell_x: x, cell_y: y, side: 1, role: 1, medium: 0 }] });
  }
}

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const TAG_HIDE = 'fab-test-hide-tags';
const SURFACE_HIDE = 'fab-test-hide-surface';
const TEXT_OFF = 'fab-test-text-off';

/** Add or remove a test stylesheet by id. */
async function setRule(page: Page, id: string, css: string | null): Promise<void> {
  await page.evaluate(
    ([id, css]) => {
      document.getElementById(id)?.remove();
      if (css !== null) {
        const el = document.createElement('style');
        el.id = id;
        el.textContent = css;
        document.head.appendChild(el);
      }
    },
    [id, css] as const,
  );
}

/** Wait two animation frames, so the tags' per-frame placement and any style change have painted. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
}

/** One full-page shot, decoded. */
async function shoot(page: Page): Promise<{ data: Buffer; width: number }> {
  const png = PNG.sync.read(await page.screenshot());
  return { data: png.data, width: png.width };
}

/** The worst channel difference between two shots inside `r` (CSS px at device ratio 1). */
function worstDiff(a: { data: Buffer; width: number }, b: { data: Buffer; width: number }, r: Box): number {
  let worst = 0;
  for (let y = Math.ceil(r.top); y < Math.floor(r.bottom); y += 1) {
    for (let x = Math.ceil(r.left); x < Math.floor(r.right); x += 1) {
      const i = (y * a.width + x) * 4;
      for (let c = 0; c < 3; c += 1) worst = Math.max(worst, Math.abs(a.data[i + c] - b.data[i + c]));
    }
  }
  return worst;
}

/** The overlaps of every visible tag with the surface `selector`, each inset by 1 px. */
async function overlapsWith(page: Page, selector: string): Promise<Box[]> {
  return page.evaluate((selector) => {
    const surface = document.querySelector<HTMLElement>(selector);
    if (surface === null || surface.offsetWidth === 0) return [];
    // Inset by the surface's corner radius: outside a rounded corner the board, and a tag on it,
    // show through, which is not a tag over the surface.
    const cs = getComputedStyle(surface);
    const radius = Math.max(
      ...[cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomLeftRadius, cs.borderBottomRightRadius].map(
        (v) => parseFloat(v) || 0,
      ),
    );
    const b = surface.getBoundingClientRect();
    const s = { left: b.left + radius, top: b.top + radius, right: b.right - radius, bottom: b.bottom - radius };
    const out: { left: number; top: number; right: number; bottom: number }[] = [];
    for (const tag of Array.from(document.querySelectorAll<HTMLElement>('[data-testid="machine-label"]'))) {
      if (getComputedStyle(tag).visibility !== 'visible') continue;
      const t = tag.getBoundingClientRect();
      const r = {
        left: Math.max(s.left, t.left) + 1,
        top: Math.max(s.top, t.top) + 1,
        right: Math.min(s.right, t.right) - 1,
        bottom: Math.min(s.bottom, t.bottom) - 1,
      };
      if (r.right - r.left >= 2 && r.bottom - r.top >= 2) out.push(r);
    }
    return out;
  }, selector);
}

/** Grade every tag overlap with each named surface; return one line per failure. */
async function gradeSurfaces(page: Page, surfaces: { name: string; selector: string }[], size: string): Promise<string[]> {
  const fails: string[] = [];
  // The surfaces' own words and icons are inked transparent for the shots, and every CSS
  // transition is cut to its end: measured, the inspector's `Copy` button read 4 to 9 per channel
  // apart between two shots that differ only in the tag layer, because its 120 ms enable
  // transition was still running after the URL row loaded. That is not a tag. Tags keep their ink.
  await setRule(
    page,
    TEXT_OFF,
    '.fab-panel, .fab-panel * { color: transparent !important; caret-color: transparent !important; } *, *::before, *::after { transition: none !important; animation: none !important; }',
  );
  await setRule(page, TAG_HIDE, null);
  await settle(page);
  const shown = await shoot(page);
  await setRule(page, TAG_HIDE, '[data-testid="machine-label"] { visibility: hidden !important; }');
  await settle(page);
  const tagless = await shoot(page);
  await setRule(page, TAG_HIDE, null);
  await settle(page);
  for (const s of surfaces) {
    const overlaps = await overlapsWith(page, s.selector);
    console.log(`P91-CHROME-08 ${size} ${s.name} overlaps=${overlaps.length}`);
    // PRECONDITION (non-vacuity): a tag crosses this surface.
    expect(overlaps.length, `PRECONDITION: a name tag crosses ${s.name} at ${size}`).toBeGreaterThan(0);
    // The tag is really drawn there: with the surface hidden, tags shown and hidden differ.
    await setRule(page, SURFACE_HIDE, `${s.selector} { visibility: hidden !important; }`);
    await settle(page);
    const bare = await shoot(page);
    await setRule(page, TAG_HIDE, '[data-testid="machine-label"] { visibility: hidden !important; }');
    await settle(page);
    const bareTagless = await shoot(page);
    await setRule(page, TAG_HIDE, null);
    await setRule(page, SURFACE_HIDE, null);
    await settle(page);
    let drawn = 0;
    let covered = 0;
    let worst = 0;
    for (const r of overlaps) {
      if (worstDiff(bare, bareTagless, r) > 2) drawn += 1;
      const d = worstDiff(shown, tagless, r);
      worst = Math.max(worst, d);
      if (d > 2) covered += 1;
    }
    console.log(`P91-CHROME-08 ${size} ${s.name} drawn=${drawn}/${overlaps.length} tag_over_surface=${covered} worst=${worst}`);
    expect(drawn, `NON-VACUITY: with ${s.name} hidden a tag is drawn in its overlaps at ${size}`).toBeGreaterThan(0);
    if (covered > 0) fails.push(`${s.name}: ${covered} of ${overlaps.length} overlaps show the tag over the surface (worst ${worst})`);
  }
  await setRule(page, TEXT_OFF, null);
  return fails;
}

test.describe('machine name tags sit under every panel (CHROME-08, D-07)', () => {
  for (const size of SIZES) {
    test(`name tags under the toolbar, the palette, the Legend, Help and the inspector at ${size.width}x${size.height}`, async ({
      page,
    }) => {
      test.setTimeout(90_000);
      await page.setViewportSize(size);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.addInitScript(() => localStorage.setItem('fab.onboarding.seen.v1', '1'));
      const h = await mockRenderSocket(page, {
        answerQuery: (verb) => (verb === 'machine_config' ? { kind: 'Source', trigger: { kind: 'Webhook' } } : verb === 'webhook_url' ? 'http://127.0.0.1:8787/hook/src-1' : undefined),
      });
      await page.goto('/');
      await waitForChrome(page);
      await h.connected;
      h.inject(buildPacket({ nodes: FIELD }));
      await waitForBoard(page, { machines: FIELD.length });
      expect(await page.evaluate(() => devicePixelRatio), 'the shots are 1:1 with CSS px').toBe(1);

      // Zoom in about the window's centre until the board runs under every edge of the window.
      const cx = size.width / 2;
      const cy = size.height / 2;
      await page.mouse.move(cx, cy);
      for (let i = 0; i < 6; i += 1) await page.mouse.wheel(0, -100);

      await page.getByRole('button', { name: 'Names' }).click();
      await expect(page.locator('[data-testid="machine-label"]').first(), 'Names on: tags are drawn').toBeVisible();
      await page.getByRole('button', { name: 'Legend' }).click();
      await expect(page.locator('#fab-legend-panel'), 'the Legend opened').toBeVisible();
      await page.getByRole('button', { name: 'Help' }).click();
      await expect(page.locator('#fab-help-panel'), 'Help opened').toBeVisible();

      const sizeName = `${size.width}x${size.height}`;
      const fails = await gradeSurfaces(
        page,
        [
          { name: 'the toolbar', selector: 'header.fab-panel' },
          { name: 'the palette', selector: '[data-fab-left-dock]' },
          { name: 'the Legend', selector: '#fab-legend-panel' },
          { name: 'Help', selector: '#fab-help-panel' },
        ],
        sizeName,
      );

      // A machine selected: its inspector takes the slot (Help closes). The machine nearest the
      // open board's left part, so it is clear of the column and the selection moves nothing.
      await page.getByRole('button', { name: 'Help' }).click();
      await expect(page.locator('#fab-help-panel'), 'Help closed').toHaveCount(0);
      const pick = { x: 330, y: size.height / 2 };
      const cam = await page.evaluate(() => (window as { __fabrico?: { camera?(): { x: number; y: number; scale: number } } }).__fabrico!.camera!());
      const near = FIELD.reduce((best, n) => {
        const sx = (n.cell_x + 0.5) * 32 * cam.scale + cam.x;
        const sy = (n.cell_y + 0.5) * 32 * cam.scale + cam.y;
        const d = Math.hypot(sx - pick.x, sy - pick.y);
        return d < best.d ? { n, d, sx, sy } : best;
      }, { n: FIELD[0], d: Infinity, sx: 0, sy: 0 });
      await page.mouse.move(near.sx, near.sy);
      await page.mouse.down();
      await page.mouse.up();
      await expect(page.locator('aside[aria-labelledby="fab-config-heading"]'), 'the inspector opened').toBeVisible({ timeout: 10_000 });
      // Its body loaded, so nothing in the panel changes between the shots.
      await expect(page.locator('.fab-field[title="http://127.0.0.1:8787/hook/src-1"]'), 'the Source body loaded').toBeVisible({
        timeout: 10_000,
      });
      fails.push(
        ...(await gradeSurfaces(page, [{ name: 'the inspector', selector: 'aside[aria-labelledby="fab-config-heading"]' }], sizeName)),
      );

      expect(fails, `${sizeName}: every surface paints over every name tag that reaches it`).toEqual([]);
    });
  }
});
