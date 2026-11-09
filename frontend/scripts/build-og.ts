// build-og.ts - writes the docs site's default link-preview image, site/public/og/default.png.
//
// Run it from frontend/ with `node scripts/build-og.ts`, then commit the PNG. The site build
// doesn't run it, so building the site needs no browser.
//
// The image is the brand lockup (docs/brand/fabrico-lockup.svg) at its native 880 x 260, with its
// top-left corner at (160, 185) on a 1200 x 630 page of the board-floor colour. That colour is read
// from LOCKED_SKIN, the app's one skin, so the image can't drift from the app. It's also the
// lockup's own plate colour, so the lockup's edge doesn't show.
//
// It follows capture-lockup-hero.ts on three rules:
// - It lives in frontend/ because @playwright/test resolves only from here.
// - The SVG is inlined as markup, never loaded through <img src>, because an image that fails
//   to load renders an empty box of the right size.
// - The capture uses scale: 'device', and the PNG is measured before it's kept: a size other
//   than 1200 x 630, or too few colours (a blank plate), fails the run with exit 1.
//
// Every path comes from import.meta.url, so the script reads no argv and works from any folder.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const FRONTEND = fileURLToPath(new URL('..', import.meta.url));
const LOCKUP_PATH = fileURLToPath(new URL('../../docs/brand/fabrico-lockup.svg', import.meta.url));
const OUT_PATH = fileURLToPath(new URL('../../site/public/og/default.png', import.meta.url));

/** The image size link previews expect, in pixels. */
export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;

/** The lockup's native size (its viewBox is 0 0 880 260) and where its top-left corner goes. */
export const LOCKUP_WIDTH = 880;
export const LOCKUP_HEIGHT = 260;
export const LOCKUP_LEFT = 160;
export const LOCKUP_TOP = 185;

/**
 * The PNG needs more unique colours than this. The lockup carries several; a page where the
 * artwork failed to inline is one flat colour. capture-lockup-hero.ts uses the same floor.
 */
export const MIN_UNIQUE_COLOURS = 2;

/** `#rrggbb` for a 24-bit colour. */
export function hex(rgb: number): string {
  return `#${rgb.toString(16).padStart(6, '0')}`;
}

/** The page the image is captured from. Pure: the same inputs give the same HTML. */
export function buildOgHtml(svgMarkup: string, ground: string): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8" />',
    '<style>',
    `  html, body { margin: 0; padding: 0; background: ${ground}; }`,
    `  #og { position: relative; width: ${String(OG_WIDTH)}px; height: ${String(OG_HEIGHT)}px;`,
    `        background: ${ground}; overflow: hidden; }`,
    `  #lockup { position: absolute; left: ${String(LOCKUP_LEFT)}px; top: ${String(LOCKUP_TOP)}px;`,
    `            width: ${String(LOCKUP_WIDTH)}px; height: ${String(LOCKUP_HEIGHT)}px; }`,
    '  #lockup svg { display: block; width: 100%; height: 100%; }',
    '</style>',
    '</head>',
    '<body>',
    `<div id="og"><div id="lockup">${svgMarkup}</div></div>`,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/** The board-floor colour, from LOCKED_SKIN, loaded through Vite's module runner. */
async function substrate(): Promise<string> {
  type Locked = typeof import('../src/render/synth/skins/locked.ts');
  const { runnerImport } = await import('vite');
  const { module } = await runnerImport<Locked>(path.join(FRONTEND, 'src/render/synth/skins/locked.ts'), {
    configFile: false,
    root: FRONTEND,
    logLevel: 'silent',
  });
  return hex(module.LOCKED_SKIN.palette.ramp[0]);
}

/** Width, height and unique-colour count of a PNG, from ImageMagick. */
function identify(file: string): { width: number; height: number; colours: number } {
  const out = execFileSync('magick', ['identify', '-format', '%w %h %k', file], { encoding: 'utf8' }).trim();
  const [width, height, colours] = out.split(/\s+/).map(Number);
  if (![width, height, colours].every(Number.isInteger)) {
    throw new Error(`magick identify returned '${out}' for ${file}`);
  }
  return { width, height, colours };
}

async function main(): Promise<void> {
  const svg = readFileSync(LOCKUP_PATH, 'utf8');
  if (!svg.includes('<svg')) throw new Error(`${LOCKUP_PATH} holds no <svg> element, so there is nothing to draw`);
  const ground = await substrate();
  if (!svg.toLowerCase().includes(ground)) {
    throw new Error(
      `the lockup's plate isn't the board-floor colour ${ground}, so its edge would show on the image. ` +
        'Check docs/brand/fabrico-lockup.svg against LOCKED_SKIN.',
    );
  }

  mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  // Capture to a side file and move it into place only once it passes, so a failed run leaves
  // the committed image alone.
  const draft = `${OUT_PATH}.draft.png`;
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ deviceScaleFactor: 1, viewport: { width: OG_WIDTH, height: OG_HEIGHT } });
    const page = await context.newPage();
    await page.setContent(buildOgHtml(svg, ground));
    const og = page.locator('#og');
    await og.waitFor({ state: 'visible' });
    await og.screenshot({ path: draft, scale: 'device' });
  } finally {
    await browser.close();
  }

  const png = identify(draft);
  if (png.width !== OG_WIDTH || png.height !== OG_HEIGHT) {
    rmSync(draft, { force: true });
    throw new Error(
      `the image came out ${String(png.width)} x ${String(png.height)}, and link previews need ` +
        `${String(OG_WIDTH)} x ${String(OG_HEIGHT)}`,
    );
  }
  if (png.colours <= MIN_UNIQUE_COLOURS) {
    rmSync(draft, { force: true });
    throw new Error(
      `the image has ${String(png.colours)} unique colours, which is a blank plate: the lockup didn't draw`,
    );
  }
  renameSync(draft, OUT_PATH);
  console.log(
    `build-og: ${path.relative(path.join(FRONTEND, '..'), OUT_PATH)} ${String(png.width)} x ${String(png.height)}, ` +
      `${String(png.colours)} colours, ground ${ground}`,
  );
}

// Only a direct `node scripts/build-og.ts` run captures; importing the module does nothing.
if ((import.meta as ImportMeta & { main?: boolean }).main === true) {
  try {
    await main();
  } catch (err) {
    console.error(`build-og: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
