// capture-lockup-hero.ts - the criterion 8 approval render for the lockup (plan 80-04, D-08).
//
// Writes the page the reviewer opens and the PNG that page produces, so the verdict they record has
// file evidence a later reader can open without re-running anything. The lockup is the
// PRIMARY brand artefact and this is the only point in Phase 80 where it is judged; the
// toolbar walk in plan 80-06 can only ever show a derivative cut from it.
//
// A STANDALONE SCRIPT, NOT A SPEC IN THE SUITE, following `capture-mark-evidence.ts`.
// Playwright's `testDir` is `./e2e`, so a capture spec would rewrite the evidence on every
// gate-4 run and leave churn in a working tree the suite is supposed to leave clean.
// `@playwright/test` is already a devDependency and `chromium` drives fine from bare node.
// It has to live HERE rather than in a scratch directory: a script outside `frontend/`
// cannot resolve `@playwright/test`, because that is where `node_modules` is.
//
// THE ARTWORK IS INLINED AS MARKUP, NEVER REFERENCED WITH <img src>. This is the Phase 79
// lesson, recorded in STATE and paid for once already: a file that fails to load renders an
// EMPTY BOX, and an empty box on a page headed "the Fabrico lockup" reads as a mark with
// nothing in it rather than as a broken page. Inlining makes a load failure impossible -
// there is nothing to load.
//
// THE PNG IS MEASURED BEFORE ANYONE IS ASKED TO LOOK AT IT. `magick identify` reports the
// dimensions and the unique-colour count, and this script refuses to finish on anything
// other than 1760x520 with more than two colours. A page that failed to inline the artwork
// produces a PNG of exactly the right size carrying one flat colour, and that is the one
// failure a human cannot be asked to catch: they would be judging a blank plate and reporting
// on the artwork.
//
// EVERY CAPTURE CARRIES `scale: 'device'` (the `capture-mark-evidence.ts` rule). Without it
// Playwright captures in CSS pixels and DOWNSAMPLES out of the device buffer, which is how
// four `logomark-dpr-*` baselines once came back byte-identical across four device pixel
// ratios (those baselines were retired with `LogoMark.tsx` on 2026-10-11).
//
// NO PATH INPUT, EVER (threat T-80-15). Every path is resolved from `import.meta.url`, so
// `node frontend/scripts/capture-lockup-hero.ts` works from the repository root and from
// `frontend/` alike. This module reads no argv and no cwd.
//
// ERASURE-ONLY TYPESCRIPT, the dialect stated at `scripts/lint-svg.ts:29-34`.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

/* ------------------------------------------------------------------ *
 * The exported contract
 * ------------------------------------------------------------------ */

/** The artefact being judged. Read, never written. */
export const LOCKUP_PATH = fileURLToPath(
  new URL('../../docs/brand/fabrico-lockup.svg', import.meta.url),
);

/** Where the evidence lands: an ignored output directory, never the tracked tree. */
export const EVIDENCE_DIR = fileURLToPath(
  new URL('../evidence/80/', import.meta.url),
);

/** The page the reviewer opens in their own browser. */
export const HERO_HTML_PATH = fileURLToPath(
  new URL('../evidence/80/80-lockup-hero.html', import.meta.url),
);

/** The PNG the verdict cites. */
export const HERO_PNG_PATH = fileURLToPath(
  new URL('../evidence/80/80-a-lockup-hero.png', import.meta.url),
);

/**
 * The hero size, in CSS pixels, and the artwork's own aspect ratio.
 *
 * The lockup's viewBox is `0 0 880 260`, so an 880 CSS px wide copy is 260 CSS px tall and
 * the drawing renders at exactly 1:1 user units. Captured at `deviceScaleFactor: 2` that is
 * 1760 by 520 device pixels, which is the pin below.
 */
export const HERO_WIDTH = 880;
export const HERO_HEIGHT = 260;

/** The second, smaller copy, so the judgement is made at two sizes rather than one. */
export const HALF_WIDTH = 440;
export const HALF_HEIGHT = 130;

/** The capture's device pixel ratio, pinned. A capture at any other ratio documents a rendering nobody looked at. */
export const DEVICE_SCALE = 2;

/** The dimensions the written PNG must identify as. */
export const EXPECTED_PNG_WIDTH = HERO_WIDTH * DEVICE_SCALE;
export const EXPECTED_PNG_HEIGHT = HERO_HEIGHT * DEVICE_SCALE;

/**
 * The floor on unique colours. The committed lockup carries six authored values; a page
 * that failed to inline the artwork carries ONE (the plate). Two is the strictest floor
 * that cannot be reached by a plate plus a single stray antialiased edge.
 */
export const MIN_UNIQUE_COLOURS = 2;

/** The ground the mark is judged on - the app's own plate colour, and the lockup's. */
export const PLATE = '#1b1f27';

/** What one `magick identify` run reported. */
export interface PngFacts {
  readonly width: number;
  readonly height: number;
  readonly uniqueColours: number;
  readonly bytes: number;
}

export interface HeroCaptureResult {
  readonly htmlPath: string;
  readonly pngPath: string;
  readonly png: PngFacts;
}

/* ------------------------------------------------------------------ *
 * The page
 * ------------------------------------------------------------------ */

/**
 * Build the self-contained page. Pure: same SVG markup in, same HTML out, so the page can
 * be regenerated identically and the caption cannot drift from the constants above.
 */
export function buildHeroHtml(svgMarkup: string): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8" />',
    '<title>Fabrico lockup - hero size (phase 80, criterion 8)</title>',
    '<style>',
    `  html, body { margin: 0; padding: 0; background: ${PLATE}; }`,
    // INTEGER LINE HEIGHTS, DELIBERATELY. A fractional one (13px * 1.6 = 20.8) puts the
    // hero box at a fractional y offset, Playwright rounds the clip outward, and the
    // capture comes back 1760x522 instead of 1760x520. Measured, not guessed.
    '  body { font: 13px/20px ui-monospace, SFMono-Regular, Menlo, monospace; color: #8a94a6; }',
    '  main { padding: 48px 40px 56px; }',
    '  h1 { font-size: 13px; line-height: 20px; font-weight: 400; letter-spacing: 0.08em;',
    '       text-transform: uppercase; color: #6d7481; margin: 0 0 24px; }',
    `  #hero { width: ${String(HERO_WIDTH)}px; height: ${String(HERO_HEIGHT)}px;`,
    '          box-sizing: border-box; padding: 0; border: 0; }',
    `  #half { width: ${String(HALF_WIDTH)}px; height: ${String(HALF_HEIGHT)}px;`,
    '          box-sizing: border-box; padding: 0; border: 0; margin-top: 56px; }',
    '  #hero svg, #half svg { display: block; width: 100%; height: 100%; }',
    '  .caption { margin: 20px 0 0; max-width: 880px; line-height: 22px; }',
    '  .caption code { color: #b0bacb; }',
    '</style>',
    '</head>',
    '<body>',
    '<main>',
    `<h1>The Fabrico lockup at ${String(HERO_WIDTH)} css px, on the app ground ${PLATE}</h1>`,
    // THE ARTWORK, INLINED. Not <img src>: see the header.
    `<div id="hero">${svgMarkup}</div>`,
    `<div id="half">${svgMarkup}</div>`,
    '<p class="caption">',
    `  Above: ${String(HERO_WIDTH)} css px. Below it: the same drawing at ${String(HALF_WIDTH)} css px.`,
    '  <br />',
    '  The file is <code>docs/brand/fabrico-lockup.svg</code>, a GENERATED artefact.',
    '  Regenerate it with <code>npm run build:lockup</code> from <code>frontend/</code>;',
    '  a change to this artwork is a change to <code>frontend/scripts/build-lockup.ts</code>',
    '  followed by a regeneration, never a hand edit to the committed SVG.',
    '  <br />',
    '  This page and its PNG are written by',
    '  <code>npm run capture:lockup-hero</code>.',
    '</p>',
    '</main>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/* ------------------------------------------------------------------ *
 * The measurement
 * ------------------------------------------------------------------ */

/**
 * Read a PNG's dimensions and unique-colour count. `%k` is ImageMagick's exact count of
 * distinct colours in the image, which is what separates a rendered drawing from a plate.
 */
export function identifyPng(path: string): PngFacts {
  const out = execFileSync('magick', ['identify', '-format', '%w %h %k', path], {
    encoding: 'utf8',
  }).trim();
  const parts = out.split(/\s+/);
  if (parts.length !== 3) {
    throw new Error(`magick identify returned '${out}' for ${path}`);
  }
  const [width, height, uniqueColours] = parts.map(Number);
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    !Number.isInteger(uniqueColours)
  ) {
    throw new Error(`magick identify returned '${out}' for ${path}`);
  }
  return {
    width: width as number,
    height: height as number,
    uniqueColours: uniqueColours as number,
    bytes: statSync(path).size,
  };
}

/* ------------------------------------------------------------------ *
 * The capture
 * ------------------------------------------------------------------ */

export async function captureHero(): Promise<HeroCaptureResult> {
  mkdirSync(EVIDENCE_DIR, { recursive: true });

  const svgMarkup = readFileSync(LOCKUP_PATH, 'utf8');
  if (!svgMarkup.includes('<svg')) {
    throw new Error(
      `capture-lockup-hero: ${LOCKUP_PATH} carries no <svg> root, so there is nothing to inline`,
    );
  }
  writeFileSync(HERO_HTML_PATH, buildHeroHtml(svgMarkup), 'utf8');

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      deviceScaleFactor: DEVICE_SCALE,
      viewport: { width: 1024, height: 800 },
    });
    const page = await context.newPage();
    await page.goto(`file://${HERO_HTML_PATH}`);
    const hero = page.locator('#hero');
    await hero.waitFor({ state: 'visible' });
    await hero.screenshot({ path: HERO_PNG_PATH, scale: 'device' });
  } finally {
    await browser.close();
  }

  const png = identifyPng(HERO_PNG_PATH);

  // THE TWO REFUSALS. Neither is a formality: together they are the only guard that the reviewer is
  // shown a rendered mark rather than a blank plate at the criterion 8 approval.
  if (png.width !== EXPECTED_PNG_WIDTH || png.height !== EXPECTED_PNG_HEIGHT) {
    throw new Error(
      `capture-lockup-hero: the hero PNG is ${String(png.width)}x${String(png.height)} and must be ` +
        `${String(EXPECTED_PNG_WIDTH)}x${String(EXPECTED_PNG_HEIGHT)}. The #hero box is not ` +
        `${String(HERO_WIDTH)}x${String(HERO_HEIGHT)} css px, or the capture lost scale: 'device'.`,
    );
  }
  if (png.uniqueColours <= MIN_UNIQUE_COLOURS) {
    throw new Error(
      `capture-lockup-hero: the hero PNG has ${String(png.uniqueColours)} unique colours, which is a ` +
        'blank or two-tone plate rather than a rendered mark. The artwork did not inline.',
    );
  }

  return { htmlPath: HERO_HTML_PATH, pngPath: HERO_PNG_PATH, png };
}

/* ------------------------------------------------------------------ *
 * The CLI
 * ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const result = await captureHero();
  console.log(
    `capture-lockup-hero  ${String(result.png.width)}x${String(result.png.height)} device px, ` +
      `${String(result.png.uniqueColours)} unique colours, ${String(result.png.bytes)} bytes`,
  );
  console.log(`  page  ${result.htmlPath}`);
  console.log(`  png   ${result.pngPath}`);
  console.log(`\nOpen the page in a browser:\n  file://${result.htmlPath}`);
}

// `import.meta.main` is true only under bare `node scripts/capture-lockup-hero.ts`; under Vite
// and vitest it is undefined, so importing this module never launches a browser, never
// overwrites the evidence under `frontend/evidence/80/`, and never kills the
// importing process. The idiom is the one at `lint-svg.ts:1135`, `mark-craft.ts:986`,
// `build-lockup.ts:714` and `build-mark-sheet.ts:1128`; this file was the one that did not
// have it (WR-05), while exporting thirteen names - `buildHeroHtml`, `identifyPng`,
// `captureHero`, `HERO_WIDTH`, `PLATE` among them - so it is written to be imported.
//
// `process.exitCode` RATHER THAN `process.exit(1)`. `exit` tears the process down
// immediately, which truncates buffered stdout and would kill an importing test runner
// mid-suite; `exitCode` lets the module finish and still exits non-zero. This script owns a
// browser lifecycle, so a failure still has to be loud and still has to set a code rather
// than leaving a half-written PNG behind a zero exit.
if ((import.meta as ImportMeta & { main?: boolean }).main === true) {
  try {
    await main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
