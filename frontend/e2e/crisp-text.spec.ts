import { test, expect, type Page } from '@playwright/test';
import { mockRenderSocket, waitForChrome, buildPacket, screenCellCentre, waitForBoard } from './support/wire';
import type { InjectNode, InjectBelt } from './support/wire';
import { rampOracles, colorToRgb } from '../shared/geometry';
// Phase 91 (D-10, CHROME-10): the empty board's words, imported so a copy edit moves this check too.
import { EMPTY_FLOOR_BODY, EMPTY_FLOOR_HEADING } from '../src/chrome/configCopy';

// crisp-text.spec.ts (SHELL-08 origin, rewritten Plan 47-03) - the AUTOMATED gate
// for the Phase 47 two-font VECTOR typography contract across ALL chrome text
// surfaces (panels, wordmark, empty-state, dialog), NOT just the bezel that
// dpr-crispness.spec.ts covers.
//
// The contract this spec locks (FEEL-05, forks D-02/D-03/D-06/D-08):
//  (1) LINE-HEIGHT ratios survive the font swap unchanged: headings 1.2,
//      multi-line body 1.4, single-line readouts 1.
//  (2) FAMILIES: all body/HUD text computes to "Martian Mono" at the plain 12px
//      base; the title tier (dialog h2, Palette h2, Legend h2) computes to "Sono"
//      ALL-CAPS at 18px. Sizes are DPR-independent CSS px (the x16 device-snap
//      contract is retired).
//
//      CORRECTED IN PLACE (plan 80.1-01, MARK-17). Clauses (1) and (2) both used
//      to name the toolbar wordmark heading: (1) said the single-line readout tier
//      was "(the wordmark) 1", and (2) opened the title tier with the toolbar
//      wordmark heading. Neither subject exists any more. The header now wears the
//      generated cut of the lockup, which draws the product name as outlined
//      geometry, so the app's one level-1 heading is visually hidden and paints no
//      glyph at all. Both assertion blocks that measured it are deleted below
//      rather than left green against an invisible element.
//  (3) SMOOTHING is NOT forced off: the pixel-era `-webkit-font-smoothing: none`
//      pins are gone; vector outlines render smooth.
//  (4) GLYPH COVERAGE: the embedded latin subset carries the load-bearing HUD
//      glyphs (the U+00B7 readout separator and digits) - a canvas raster probe
//      against the pure-monospace fallback proves the bundled woff2 actually
//      maps them, so the tick readout "tick 22,233" never falls back mid-string.
//      The probe anchors on the DEFAULT ALPHABETIC baseline (font-independent),
//      so a glyph absent from the subset falls back and rasters IDENTICALLY in
//      both stacks; a CJK negative control proves the discriminator itself works.
//      (document.fonts.check cannot prove coverage: with no unicode-range on the
//      @font-face it returns true for ANY character once the face loads.)

/** Contract line-height ratios from 32-UI-SPEC Typography (unchanged by Phase 47). */
const HEADING_LH = 1.2;
const BODY_LH = 1.4;
const READOUT_LH = 1;
const LH_TOL = 0.03;

/** Read the line-height / font-size ratio of an element by computed style. */
async function lineHeightRatio(page: Page, selector: string): Promise<number> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el == null) return NaN;
    const cs = getComputedStyle(el);
    const lh = parseFloat(cs.lineHeight);
    const fs = parseFloat(cs.fontSize);
    return lh / fs;
  }, selector);
}

/** Read the Phase 47 typography contract of an element by computed style. */
async function typography(
  page: Page,
  selector: string,
): Promise<{ family: string; smoothing: string; transform: string; sizePx: number } | null> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el == null) return null;
    const cs = getComputedStyle(el);
    return {
      family: cs.fontFamily,
      smoothing: cs.getPropertyValue('-webkit-font-smoothing').trim(),
      transform: cs.textTransform,
      sizePx: parseFloat(cs.fontSize),
    };
  }, selector);
}

/** A SOURCE at (12,8) plus a belt carrying items - mirrors chrome-dialog.spec. */
const MACHINE: InjectNode = {
  id: 1,
  kind: 0,
  cell_x: 12,
  cell_y: 8,
  ports: [{ index: 0, cell_x: 12, cell_y: 8, side: 1, role: 1 }],
};
const beltCarrying = (items: number): InjectBelt => ({
  id: 3,
  tiles: [
    [13, 8],
    [14, 8],
    [15, 8],
    [16, 8],
  ],
  itemCount: items,
  docks: [{ end: 'Tail', node: 1, port: 0 }],
});


// ---------------------------------------------------------------------------
// HERMETICITY (added 2026-09-04, phase 72 gate re-run finding H-1)
// ---------------------------------------------------------------------------
//
// Every test in this file installs `mockRenderSocket` BEFORE `page.goto('/')`, and that
// is not ceremony. Until this commit five of the six did not, so the page connected to
// the REAL dev host at `ws://127.0.0.1:8787/render` (`src/transport/devWebSocket.ts`,
// `DEFAULT_DEV_WS_URL`). MEASURED: with `dev_render_server` running, the live host pushes
// the DEMO scene, `machineCount` is not 0, "Empty factory floor" never renders and the
// first test below FAILS; with :8787 down it passes. So the test graded whether a dev
// server happened to be running, not typography.
//
// 25 of the 31 specs in this directory already installed the mock; this file was the
// outlier. The whole value of the MOCK suite is that it does not depend on a live host,
// so all five were converted, not just the one that could be seen to fail: a test that
// passes today only because the live host happens to serve a scene it tolerates is the
// same defect with a luckier assertion.

test('empty-state + wordmark honor the line-height contract on the vector fonts', async ({ page }) => {
  const h = await mockRenderSocket(page);
  await page.goto('/');
  await waitForChrome(page);
  await h.connected;
  // The empty floor is now something the HOST said, not something that happened not to
  // arrive: a full keyframe carrying no nodes. That is the state this test is about, and
  // asserting it against a socket that merely stayed silent would be a weaker claim.
  h.inject(buildPacket({ nodes: [], belts: [] }));

  // Empty-state is shown on a fresh floor (machineCount === 0).
  const heading = page.getByText(EMPTY_FLOOR_HEADING);
  await expect(heading).toBeVisible();

  // (a) Heading line-height 1.2, body 1.4 (multi-line), wordmark 1 (single-line).
  const emptyHeadingRatio = await page.evaluate((title) => {
    // IN-03: the empty-state title is now an <h2> (screen-reader heading nav),
    // not a <div>: include it in the search.
    const nodes = Array.from(document.querySelectorAll('h2, div'));
    const el = nodes.find((n) => n.childElementCount === 0 && n.textContent === title);
    if (el == null) return NaN;
    const cs = getComputedStyle(el);
    return parseFloat(cs.lineHeight) / parseFloat(cs.fontSize);
  }, EMPTY_FLOOR_HEADING);
  expect(emptyHeadingRatio).toBeGreaterThanOrEqual(HEADING_LH - LH_TOL);
  expect(emptyHeadingRatio).toBeLessThanOrEqual(HEADING_LH + LH_TOL);

  const emptyBodyRatio = await page.evaluate((body) => {
    const nodes = Array.from(document.querySelectorAll('div'));
    const el = nodes.find((n) => n.childElementCount === 0 && n.textContent === body);
    if (el == null) return NaN;
    const cs = getComputedStyle(el);
    return parseFloat(cs.lineHeight) / parseFloat(cs.fontSize);
  }, EMPTY_FLOOR_BODY);
  expect(emptyBodyRatio).toBeGreaterThanOrEqual(BODY_LH - LH_TOL);
  expect(emptyBodyRatio).toBeLessThanOrEqual(BODY_LH + LH_TOL);

  // (b) Empty-state BODY text is a body surface: Martian Mono at the 12px base,
  //     rendered smooth (the pixel-era smoothing-off pin is retired).
  const emptyBody = await page.evaluate((body) => {
    const nodes = Array.from(document.querySelectorAll('div'));
    const el = nodes.find((n) => n.childElementCount === 0 && n.textContent === body);
    if (el == null) return null;
    const cs = getComputedStyle(el);
    return {
      family: cs.fontFamily,
      smoothing: cs.getPropertyValue('-webkit-font-smoothing').trim(),
      sizePx: parseFloat(cs.fontSize),
    };
  }, EMPTY_FLOOR_BODY);
  expect(emptyBody, 'empty-state body text present').not.toBeNull();
  expect(emptyBody!.family).toContain('Martian Mono');
  expect(emptyBody!.sizePx).toBe(12);
  expect(emptyBody!.smoothing).not.toBe('none');

  // (c) The single-line readout tier: line-height 1.
  //
  // REPOINTED by plan 80.1-01 (MARK-17), and the move is the point. This block used
  // to read the line-height ratio of the toolbar wordmark heading. That heading no
  // longer renders a glyph: the header now wears the generated cut of the lockup,
  // which draws the product name as outlined geometry, so the app's one level-1
  // heading is visually hidden out of layout and carries `.fab-visually-hidden`
  // rather than `.fab-title`. Left pointed at it, this assertion would have gone on
  // passing while measuring the line-height of an element that paints nothing, which
  // is a check that cannot fail: this repository's signature defect class, and it
  // would have been introduced by the very phase that removes the word.
  //
  // DELETING IT OUTRIGHT WAS THE OTHER OPTION AND IS WORSE. `READOUT_LH` has exactly
  // one assertion in this file, so a straight deletion would have silently dropped
  // clause (1)'s readout tier from the contract this spec exists to lock, leaving an
  // orphaned constant behind as the only trace. The header tick readout is a real,
  // VISIBLE single-line readout carrying the same `lineHeight: 1` from the same
  // typography contract, so the tier keeps a subject that can actually fail.
  const readoutRatio = await lineHeightRatio(page, 'header [title="Current sim tick"]');
  expect(readoutRatio, 'the tick readout was not found, so this measured nothing').not.toBeNaN();
  expect(readoutRatio).toBeGreaterThanOrEqual(READOUT_LH - LH_TOL);
  expect(readoutRatio).toBeLessThanOrEqual(READOUT_LH + LH_TOL);
});

test('title tier + panel body render the two-font vector contract', async ({ page }) => {
  const h = await mockRenderSocket(page);
  await page.goto('/');
  await waitForChrome(page);
  await h.connected;

  // Title tier (D-02/D-08): Sono, ALL-CAPS. BOTH always-visible panel titles, which
  // sit at the 18px hero size.
  //
  // CORRECTED IN PLACE (plan 80.1-01, MARK-17). This comment used to read "The
  // wordmark h1 plus both always-visible panel titles", and the block that followed
  // it asserted the family, transform and smoothing of that heading. Both are gone
  // for the same reason: the header now wears the generated cut of the lockup, so
  // the app's one level-1 heading is visually hidden and paints no glyph. Nothing on
  // the title tier applies to an element that renders nothing, so those four
  // assertions would have gone on passing while measuring the typography of an
  // invisible box. The tier keeps real coverage in this same test through the
  // palette heading and the Legend heading below, both visible and both already
  // asserted for Sono, uppercase and the 18px hero size.
  const paletteTitle = await typography(page, '#fab-palette-heading');
  expect(paletteTitle, 'Palette h2 present').not.toBeNull();
  expect(paletteTitle!.family).toContain('Sono');
  expect(paletteTitle!.transform).toBe('uppercase');
  expect(paletteTitle!.sizePx).toBe(18);

  // The Legend panel mounts only while open (READ-01, closed by default):
  // toggle it from the Toolbar before asserting its title typography.
  //
  // Matched by PREFIX regex (the palette-grouping.spec.ts precedent), not by the
  // full literal. This spec was green before AND after 52-04 widened that title
  // to "Show machine legend (kinds, states, connections)" - getByTitle matches by
  // substring, case-insensitively, unless given { exact: true } or a regex, so
  // the old string kept matching on its own. The regex is here because a
  // selector that survives on prefix luck is one reword away from breaking
  // silently; it states the intent instead. Resilience, not repair.
  await page.getByTitle(/^Show machine legend/i).click();
  await expect(page.locator('#fab-legend-heading')).toBeVisible();
  const legendTitle = await typography(page, '#fab-legend-heading');
  expect(legendTitle, 'Legend h2 present').not.toBeNull();
  expect(legendTitle!.family).toContain('Sono');
  expect(legendTitle!.transform).toBe('uppercase');
  expect(legendTitle!.sizePx).toBe(18);

  // Panel BODY surface: the Palette aside is a .fab-panel, so its inherited
  // body text is Martian Mono at the 12px base, rendered smooth.
  const panelBody = await typography(page, 'aside[aria-labelledby="fab-palette-heading"]');
  expect(panelBody, 'Palette panel present').not.toBeNull();
  expect(panelBody!.family).toContain('Martian Mono');
  expect(panelBody!.sizePx).toBe(12);
  expect(panelBody!.smoothing).not.toBe('none');
});

test('the embedded latin subset covers the load-bearing HUD glyphs', async ({ page }) => {
  const h = await mockRenderSocket(page);
  await page.goto('/');
  await waitForChrome(page);
  await h.connected;

  // Encoding edge: the tick readout ("tick 22,233") and the U+00B7 middle-dot
  // separator are load-bearing HUD glyphs. document.fonts.check CANNOT prove
  // coverage: per the CSS Font Loading spec it filters faces by unicode-range
  // (not the cmap), and our @font-face declares none (default U+0-10FFFF), so
  // once the face loads check() returns true for ANY character. Instead we
  // raster each glyph in '"Martian Mono", monospace' vs pure 'monospace' on the
  // default ALPHABETIC baseline: the anchor is then the glyph's OWN baseline,
  // identical in both stacks regardless of which face supplies the glyph, so a
  // glyph MISSING from the subset falls back to monospace and rasters
  // identically - a pixel difference proves Martian Mono itself supplied it.
  // (A 'middle' baseline would break this: its anchor derives from the FIRST
  // AVAILABLE font's em metrics - Martian Mono in stack A, monospace in stack
  // B - so every raster would differ and the probe would be vacuous.) A CJK
  // negative control (U+4E2D, certainly absent from the latin subset) proves
  // the discriminator works before we trust the positives. check() is kept
  // only as a face-loaded proof.
  const coverage = await page.evaluate(async () => {
    // load() (not just fonts.ready) forces the as-yet-unused 48px face in,
    // closing the lazy-load race where ready resolves before the face loads.
    await document.fonts.load('48px "Martian Mono"');
    const raster = (fontStack: string, ch: string): string => {
      const canvas = document.createElement('canvas');
      canvas.width = 64;
      canvas.height = 64;
      const c = canvas.getContext('2d');
      if (c == null) return '';
      c.font = `48px ${fontStack}`;
      // Default alphabetic baseline: the anchor is the glyph's own baseline at
      // y=48, identical for both stacks, so a fallback glyph rasters
      // IDENTICALLY in both. ('middle' would anchor on the FIRST AVAILABLE
      // font's em metrics, making every raster differ.)
      c.fillText(ch, 4, 48);
      return canvas.toDataURL();
    };
    const suppliedByMartianMono = (ch: string): boolean =>
      raster('"Martian Mono", monospace', ch) !== raster('monospace', ch);
    return {
      loaded: document.fonts.check('12px "Martian Mono"'),
      separator: suppliedByMartianMono('·'),
      digits: [...'0123456789,'].every(suppliedByMartianMono),
      control: suppliedByMartianMono('中'),
    };
  });
  expect(coverage.loaded, 'Martian Mono face is loaded').toBe(true);
  // Negative control: a glyph NOT in the latin subset must read as NOT supplied -
  // this proves the discriminator itself works before trusting the positives.
  expect(coverage.control, 'CJK control glyph falls back (probe is discriminating)').toBe(false);
  expect(coverage.separator, 'U+00B7 middle dot maps in Martian Mono').toBe(true);
  expect(coverage.digits, 'digits + comma map in Martian Mono').toBe(true);
});

// VEC-03: the SHIPPED app's renderer runs with antialias OFF. The pixel-guard
// fixture asserts the same thing about its own canvases, but the fixture builds its
// own Applications - only this test reaches the canvas a user actually looks at, so
// a regression that flipped bootPixi alone would escape the fixture entirely.
//
// Read from the LIVE context's getContextAttributes(), never from the source line
// pixiApp.ts:114: that reports what the GL driver actually created, so a driver
// silently ignoring `antialias: false` is caught, which reading the passed-in option
// cannot do. A missing canvas or an unreadable context FAILS here; it never skips
// and never reports a pass over a context that was never obtained.
//
// This is a REGRESSION GUARD over an already-correct invariant, not new behaviour -
// bootPixi has passed `antialias: false` since SKIN-05 - so it is expected to be
// green from the moment it lands. That is not a vacuous test: it is the net under
// the milestone's single load-bearing rendering condition.
//
// GATE NOTE: `npx tsc --noEmit` typechecks ZERO e2e specs (tsconfig.json includes
// only `src`/`shared`, and Playwright strips types via babel). The Playwright run is
// the ONLY gate for this edit - do not cite tsc for it.
test('the shipped renderer runs with antialias OFF (VEC-03)', async ({ page }) => {
  const h = await mockRenderSocket(page);
  await page.goto('/');
  await waitForChrome(page);
  await h.connected;
  // bootPixi is async and mounts the canvas itself; wait for it explicitly so the
  // probe below can never race the mount and read a null canvas as a pass.
  await page.locator('canvas').first().waitFor();

  const live = await page.evaluate(() => {
    const c = document.querySelector('canvas');
    if (c == null) return { canvas: false, context: false, antialias: null as boolean | null };
    // Re-requesting the context type returns the ALREADY-CREATED context, so this
    // reads the resolved attributes of the context Pixi is rendering through.
    const gl = (c.getContext('webgl2') ?? c.getContext('webgl')) as WebGLRenderingContext | null;
    if (gl == null) return { canvas: true, context: false, antialias: null as boolean | null };
    const attrs = gl.getContextAttributes();
    return { canvas: true, context: true, antialias: attrs == null ? null : attrs.antialias };
  });

  expect(live.canvas, 'the shipped app mounted a canvas').toBe(true);
  expect(live.context, 'a WebGL context was readable off the shipped canvas').toBe(true);
  expect(live.antialias, 'live WebGL antialias state on the shipped canvas').toBe(false);
});

// SKIN-03 (plan 58-05): the page background is GENERATED from the locked ramp, and
// this is the PRIMARY of the two assertions over it.
//
// It reads the COMPUTED background of `body` off the page the server actually
// served, which is the only way to observe the `fab-page-background` build plugin
// doing its job - `index.html` in the repo contains `%FAB_PAGE_BG%` and no colour at
// all, so reading the source would prove precisely nothing. Same discipline as the
// antialias probe above: measure the artifact, never the source line.
//
// (The second assertion is `src/render/synth/skins/servedBackground.test.ts`, which
// covers `dist/index.html` - the markup the self-contained Tauri bundle ships - and
// SKIPS with a named message rather than passing when `dist/` is absent.)
//
// THE ORACLE IS `rampOracles.locked[0]`, not a hex literal and not a `src/` import:
// the e2e suites read the skin through `shared/geometry.ts`, and
// `skins/oracle-sync.test.ts` cross-checks that mirror against
// `LOCKED_SKIN.palette.ramp` in vitest. So a ramp edit either moves both or fails CI.
//
// THIS IS A DELIBERATE COLOUR CHANGE, PREDICTED RATHER THAN DISCOVERED. Until this
// plan `index.html` hardcoded `#0e1116`, which is NOT `ramp[0]` (`#1b1f27`). The
// canvas already derived its own clear colour from `ramp[0]`, so the two disagreed
// about the colour of the void wherever the canvas does not cover: before first
// paint, and in any letterboxed or overscroll region.
test('the page background is generated from the locked ramp, not hand-authored', async ({
  page,
}) => {
  const h = await mockRenderSocket(page);
  await page.goto('/');
  await waitForChrome(page);
  await h.connected;

  const seen = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);

  const want = colorToRgb(rampOracles.locked[0]);
  expect(seen, 'the SERVED body background is LOCKED_SKIN.palette.ramp[0]').toBe(
    `rgb(${want.r}, ${want.g}, ${want.b})`,
  );

  // Anti-vacuity: a transform that never ran leaves `background: %FAB_PAGE_BG%`,
  // which is invalid CSS and computes to the transparent initial value. Pin that
  // explicitly so this case fails LOUDLY on a broken plugin rather than on a
  // confusing colour mismatch.
  expect(seen, 'the build substitution ran (an unsubstituted token computes transparent)').not.toBe(
    'rgba(0, 0, 0, 0)',
  );
});

test('the delete-guard dialog honors the line-height contract on the vector fonts', async ({ page }) => {
  const h = await mockRenderSocket(page);
  await page.goto('/');
  await waitForChrome(page);
  await h.connected;

  h.inject(buildPacket({ nodes: [MACHINE], belts: [beltCarrying(2)] }));
  await waitForBoard(page, { machines: 1 });

  // Select the machine and press Delete - the guard intercepts (items in flight).
  const at = await screenCellCentre(page, MACHINE.cell_x, MACHINE.cell_y);
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.up();
  await page.keyboard.press('Delete');

  const panel = page.locator('.fab-dialog-panel');
  await expect(panel).toBeVisible();

  // Heading h2 -> 1.2, body p -> 1.4.
  const h2Ratio = await lineHeightRatio(page, '.fab-dialog-panel h2');
  expect(h2Ratio).toBeGreaterThanOrEqual(HEADING_LH - LH_TOL);
  expect(h2Ratio).toBeLessThanOrEqual(HEADING_LH + LH_TOL);

  const bodyRatio = await lineHeightRatio(page, '.fab-dialog-panel p');
  expect(bodyRatio).toBeGreaterThanOrEqual(BODY_LH - LH_TOL);
  expect(bodyRatio).toBeLessThanOrEqual(BODY_LH + LH_TOL);

  // The dialog h2 is on the title tier: Sono, ALL-CAPS, 18px hero.
  const dialogTitle = await typography(page, '.fab-dialog-panel h2');
  expect(dialogTitle, 'dialog h2 present').not.toBeNull();
  expect(dialogTitle!.family).toContain('Sono');
  expect(dialogTitle!.transform).toBe('uppercase');
  expect(dialogTitle!.sizePx).toBe(18);

  // The dialog panel body inherits Martian Mono, rendered smooth.
  const dialogBody = await typography(page, '.fab-dialog-panel');
  expect(dialogBody, 'dialog panel present').not.toBeNull();
  expect(dialogBody!.family).toContain('Martian Mono');
  expect(dialogBody!.smoothing).not.toBe('none');
});
