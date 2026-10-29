import { test, expect } from '@playwright/test';
// The PNG decoder Playwright already bundles (pngjs) - same reach dpr-crispness.spec
// uses; no new dependency is added this phase.
import { PNG } from 'playwright-core/lib/utilsBundle';
// The lit-edge probe color sources from the ONE shared values module (GATE-02):
// the locked lit edge is LOCKED ramp[4]; no hex literal lives in this spec.
import { rampOracles, colorToRgb } from '../shared/geometry';

// chrome-bezel.spec.ts (CHROME-01 / CHROME-02 / CHROME-04) - the LIVE proof that
// CHROME_CSS turns every chrome panel into a bezel in the REAL running app, and that
// the reskin did NOT relayout the chrome.
//
// SUPERSEDED SUBJECT, QUOTED RATHER THAN DELETED (plan 59-03). This spec used to prove
// "a 9-slice `border-image` bezel", on the reasoning that "RESEARCH Pitfall 4: a
// border-image paints NOTHING without `border-style: solid` + a `border-width`. So we
// assert BOTH that .fab-panel resolves a data:image/png border-image-source AND that its
// border-style computes to solid". FOUR of its assertions became false BY DESIGN when
// the bezel became a pure-CSS composed inset ring: there is no image, no border style
// and no border width. Deleting the spec would have left the surface with no live
// coverage at all, so it is repointed rather than removed - it now asserts the three
// inset entries in their load-bearing order, a border-width that computes to exactly
// 0px (the ring reserves NO space), and band colours read off the same shared oracle.
// We also pin the Toolbar <header> and Palette <aside> screen positions so this stays a
// reskin, not a relayout (a11y/delete-guard couple to the same chrome geometry).

/** Read a computed style value of the first `.fab-panel` (the Toolbar header). */
async function panelStyle(
  page: import('@playwright/test').Page,
  prop: string,
): Promise<string> {
  return page.evaluate((p) => {
    const el = document.querySelector('.fab-panel');
    if (el == null) return '';
    return getComputedStyle(el).getPropertyValue(p).trim();
  }, prop);
}

/** The locked-skin lit edge colour (bible section 6: the locked lit-edge ramp step, LOCKED ramp[4]), sourced. */
const LIT = colorToRgb(rampOracles.locked[4]);
/** The locked-skin shadow edge / hairline outline colour (LOCKED ramp[0]), sourced. */
const SHADOW = colorToRgb(rampOracles.locked[0]);

/** `rgb(r, g, b)` as Chromium serialises a resolved colour in a computed box-shadow. */
function rgbText(c: { r: number; g: number; b: number }): string {
  return `rgb(${c.r}, ${c.g}, ${c.b})`;
}

function eqColour(
  a: { r: number; g: number; b: number },
  b: { r: number; g: number; b: number },
  tol = 12,
): boolean {
  return Math.abs(a.r - b.r) <= tol && Math.abs(a.g - b.g) <= tol && Math.abs(a.b - b.b) <= tol;
}

test('chrome panels render as a composed inset ring, and it reserves NO space', async ({
  page,
}) => {
  await page.goto('/');
  // Chrome mounts only once the app is `ready`; the palette entry is the signal
  // (same readiness gate a11y.spec.ts uses; chrome-skin-swap.spec.ts used it too and
  // was deleted with the runtime skin swap in Phase 56).
  await page.getByRole('button', { name: /Source/ }).waitFor();

  const shadow = await panelStyle(page, 'box-shadow');

  // THREE inset entries, in the bake's INVERTED order, because the first-listed inset
  // paints on top: the bottom/right shadow band leads so it wins the two corners both
  // bands claim (only the top-left corner stays lit), then the top/left lit band, then
  // a uniform two-band outline whose outer band is fully covered.
  const entries = shadow.split(/,(?![^(]*\))/).map((e) => e.trim());
  expect(entries, `unexpected composed ring: ${shadow}`).toHaveLength(3);
  for (const e of entries) expect(e).toContain('inset');
  expect(entries[0]).toContain(rgbText(SHADOW));
  expect(entries[1]).toContain(rgbText(LIT));
  // The outline band is the same locked ramp[0] as the shadow edge, and it is the one
  // carrying a spread (the two-band uniform ring) rather than an offset pair.
  expect(entries[2]).toContain(rgbText(SHADOW));

  // NO IMAGE ANYWHERE. `none` is what an unset border-image-source computes to.
  expect(await panelStyle(page, 'border-image-source')).toBe('none');

  // THE RING IS PAINT: it reserves no space. This assertion is FALSE before the
  // migration (the border reserved 6 / 9.6 / 8 / 6 CSS px depending on DPR), which is
  // what makes it a real proof of the fix rather than a tautology.
  expect(parseFloat(await panelStyle(page, 'border-top-width'))).toBe(0);
});

test('the reskin keeps the Toolbar and Palette positions (reskin, not relayout)', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Source/ }).waitFor();

  const header = page.locator('header.fab-panel');
  const aside = page.locator('aside.fab-panel');
  await expect(header).toBeVisible();
  await expect(aside).toBeVisible();

  const headerBox = await header.boundingBox();
  const asideBox = await aside.boundingBox();
  expect(headerBox, 'toolbar header has a layout box').not.toBeNull();
  expect(asideBox, 'palette aside has a layout box').not.toBeNull();

  // The Toolbar is pinned to the top edge (top:24 = --fab-space-lg) and the Palette
  // to the left edge - both offsets unchanged by the reskin. Assert the anchored
  // edges rather than full geometry (content size may breathe with the pixel font).
  expect(headerBox!.y).toBeLessThan(64);
  expect(asideBox!.x).toBeLessThan(64);
});

// WR-02: the check above proves a ring is DECLARED. This test proves the ring EDGE
// actually paints: it samples the horizontal MIDPOINT of the Toolbar's top ring (far
// from either corner) and asserts the lit ring colour is present there. Under the
// pre-CR-01 `side = ring*2` geometry the retired nine-slice collapsed its four edge
// slices to 0px and painted only its corners, so the mid-edge showed only the hollow
// panel fill. "The ring paints along the edge, not only at the corners" is still a real
// property of a composed inset shadow, and it is still the thing WR-02 exists to prove -
// so the strip is re-sized from the retired `borderTopWidth` to the computed
// `--fab-bezel-ring` and the sample point is unchanged.
test('the bezel ring is continuous along the top EDGE, not just the corners (WR-02)', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Source/ }).waitFor();

  const header = page.locator('header.fab-panel');
  await expect(header).toBeVisible();
  const box = (await header.boundingBox())!;
  expect(box, 'toolbar header has a layout box').not.toBeNull();

  // The ring thickness in CSS px, read off the shipped token rather than restated.
  const ring = await page.evaluate(() => {
    const el = document.querySelector('header.fab-panel')!;
    return parseFloat(getComputedStyle(el).getPropertyValue('--fab-bezel-ring'));
  });
  expect(ring, 'the ring has a paintable thickness').toBeGreaterThan(0);

  // A thin strip spanning the FULL top ring at the horizontal centre of the panel
  // (well away from both corner slices). Clip coords are CSS px; the decoded PNG is
  // device px (deviceScaleFactor), so we scan every decoded pixel in the strip.
  const stripW = 4;
  const shot = await page.screenshot({
    clip: {
      x: box.x + box.width / 2 - stripW / 2,
      y: box.y,
      width: stripW,
      height: Math.ceil(ring) + 1,
    },
  });
  const png = PNG.sync.read(shot);

  // The lit ring colour must appear somewhere in the mid-edge ring strip. A
  // corner-only (broken) ring leaves this strip painted the hollow panel fill, so
  // the lit colour is absent and the assertion fails - exactly the CR-01 regression.
  let litSeen = false;
  for (let i = 0; i < png.data.length && !litSeen; i += 4) {
    const px = { r: png.data[i], g: png.data[i + 1], b: png.data[i + 2] };
    if (eqColour(px, LIT)) litSeen = true;
  }
  expect(
    litSeen,
    `the locked lit-edge ramp step (ramp[4]) must paint the MIDPOINT of the top ring ` +
      `(a continuous edge, not corner-only); its absence is the CR-01 zero-middle-band regression`,
  ).toBe(true);
});
