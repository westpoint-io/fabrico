// capture-posters.ts - a PNG of every example board at its end tick, taken from the real renderer.
//
// A board shows its poster when the browser has no WebGL, when the engine can't start, while it
// waits on the page's cap of 8 running boards, and after the browser takes its graphics back. The
// poster has to be the board as the bundle draws it, so this script runs the built bundle itself:
// it wraps `dist-embed/fabrico-board.js` into one capture page per board with the same page shell
// and policy as the test pages (`build-offline.ts`), opens the pages in Playwright's Chromium with
// the same GL arguments as the embed checks, runs each board to its end tick at 4x, pressing
// Continue at each caption, and screenshots the stage at 960 by 600 CSS px.
//
// It writes `dist-embed/posters/<board id>.png` and the capture pages under `dist-embed/capture/`.
// `scripts/build-embed.sh` then builds the bundle a second time with the posters inlined.
//
// It exits non-zero, naming the board, when a board doesn't reach its end tick, ends on a hash
// other than its pinned one, has a stage of another size, or comes out as a blank picture.
//
// NO PATH INPUT. Every path comes from this file's own location, so it runs the same from the
// repo root and from `frontend/`. Erasure-only TypeScript, so Node runs it as it is.

import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, type Page } from '@playwright/test';
import { PNG } from 'playwright-core/lib/utilsBundle';
import { buildPage, BUNDLE_MARKER } from './build-offline.ts';

const FRONTEND = fileURLToPath(new URL('..', import.meta.url));
const REPO = path.resolve(FRONTEND, '..');
const BOARDS_DIR = path.join(REPO, 'examples', 'boards');
const BUNDLE = path.join(FRONTEND, 'dist-embed', 'fabrico-board.js');
const POSTER_DIR = path.join(FRONTEND, 'dist-embed', 'posters');
const CAPTURE_DIR = path.join(FRONTEND, 'dist-embed', 'capture');

/** The poster's size in CSS px, at a device pixel ratio of 1. */
export const POSTER_WIDTH = 960;
export const POSTER_HEIGHT = 600;
/** The GL arguments every embed check launches Chromium with. */
const GL_ARGS = ['--use-gl=angle', '--use-angle=swiftshader'];
/** A board's run at 4x is 1200 ticks in 5 s; this leaves room for a slow machine. */
const RUN_TIMEOUT_MS = 120_000;
/** The stage background, `--fab-substrate`. A poster with almost nothing else is a blank stage. */
const SUBSTRATE = [0x1b, 0x1f, 0x27] as const;
const MIN_DRAWN_PERCENT = 5;

/** Every `*.board.ron` under `examples/boards/`, as board ids (`docs/x.board.ron` is `docs-x`). */
export function boardIds(): string[] {
  const found: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      const child = rel === '' ? name : `${rel}/${name}`;
      if (statSync(full).isDirectory()) walk(full, child);
      else if (name.endsWith('.board.ron')) found.push(child.slice(0, -'.board.ron'.length).replace(/\//g, '-'));
    }
  };
  walk(BOARDS_DIR, '');
  return found.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The capture page for one board: the element alone, full width (no code column), 600 px tall. */
export function captureTemplate(id: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Poster capture</title>
<style>
  html, body { margin: 0; background: #1b1f27; }
  #wrap { width: ${POSTER_WIDTH}px; }
</style>
</head>
<body>
<div id="wrap"><fabrico-board name="${id}" no-code height="${POSTER_HEIGHT}"></fabrico-board></div>
${BUNDLE_MARKER}
</body>
</html>
`;
}

type Probe = { state: string; tick: number; endTick: number; endHash: string | null; verdict: string | null; mounted: boolean };

const probe = (page: Page): Promise<Probe> =>
  page.evaluate(() => (document.querySelector('fabrico-board') as unknown as { fabricoProbe(): Probe }).fabricoProbe());

const stageBox = (page: Page): Promise<{ x: number; y: number; width: number; height: number }> =>
  page.evaluate(() => {
    const el = document.querySelector('fabrico-board') as HTMLElement;
    const r = ((el.shadowRoot as ShadowRoot).querySelector('.stage') as HTMLElement).getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });

async function waitFor<T>(what: string, read: () => Promise<T>, done: (v: T) => boolean, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await read();
  while (!done(last)) {
    if (Date.now() > deadline) throw new Error(`${what}: still ${JSON.stringify(last)} after ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 100));
    last = await read();
  }
  return last;
}

async function capture(page: Page, id: string, url: string): Promise<Buffer> {
  // Press Continue whenever a caption holds the board, as a reader who reads each note would.
  await page.addInitScript(() => {
    setInterval(() => {
      const play = document.querySelector('fabrico-board')?.shadowRoot?.querySelector('button[data-control="play"][aria-label="Continue"]');
      if (play instanceof HTMLButtonElement && !play.disabled) play.click();
    }, 50);
  });
  await page.goto(url);
  await waitFor(`${id}: the board starts`, () => probe(page), (p) => p.state === 'running' && p.mounted, 30_000);

  // The frame's padding sits around the stage; widen the wrapper so the stage itself is 960 wide.
  const first = await stageBox(page);
  await page.evaluate((w) => {
    (document.getElementById('wrap') as HTMLElement).style.width = `${w}px`;
  }, POSTER_WIDTH + (POSTER_WIDTH - first.width));

  const board = page.locator('fabrico-board');
  await board.locator('select').selectOption({ label: '4x' });
  await board.locator('button[data-control="restart"]').click();
  const end = await waitFor(`${id}: the board reaches its end tick`, () => probe(page), (p) => p.endHash !== null, RUN_TIMEOUT_MS);
  if (end.tick !== end.endTick) throw new Error(`${id}: the run stopped on tick ${end.tick}, not its end tick ${end.endTick}`);
  if (end.verdict !== 'match') throw new Error(`${id}: the end hash ${end.endHash} is "${end.verdict}" against the manifest`);
  // Let the render clock settle on the last tick.
  await page.waitForTimeout(800);

  const box = await stageBox(page);
  if (Math.abs(box.width - POSTER_WIDTH) > 0.5 || Math.abs(box.height - POSTER_HEIGHT) > 0.5) {
    throw new Error(`${id}: the stage is ${box.width} by ${box.height} CSS px, not ${POSTER_WIDTH} by ${POSTER_HEIGHT}`);
  }
  const png = await page.screenshot({ clip: box, animations: 'allow' });
  const img = PNG.sync.read(png);
  if (img.width !== POSTER_WIDTH || img.height !== POSTER_HEIGHT) {
    throw new Error(`${id}: the screenshot is ${img.width} by ${img.height} px`);
  }
  let drawn = 0;
  for (let i = 0; i < img.data.length; i += 4) {
    const d = Math.abs(img.data[i] - SUBSTRATE[0]) + Math.abs(img.data[i + 1] - SUBSTRATE[1]) + Math.abs(img.data[i + 2] - SUBSTRATE[2]);
    if (d > 24) drawn += 1;
  }
  const percent = (drawn / (img.width * img.height)) * 100;
  if (percent < MIN_DRAWN_PERCENT) throw new Error(`${id}: only ${percent.toFixed(1)} percent of the poster is drawn, so it is a blank stage`);
  console.log(`${id}: tick ${end.tick} of ${end.endTick}, hash ${end.endHash?.slice(0, 8)} ${end.verdict}, ${png.length} bytes, ${percent.toFixed(1)} percent drawn`);
  return png;
}

async function main(): Promise<void> {
  const bundle = readFileSync(BUNDLE, 'utf8');
  const ids = boardIds();
  if (ids.length === 0) throw new Error(`no board files under ${BOARDS_DIR}`);
  rmSync(POSTER_DIR, { recursive: true, force: true });
  rmSync(CAPTURE_DIR, { recursive: true, force: true });
  mkdirSync(POSTER_DIR, { recursive: true });
  mkdirSync(CAPTURE_DIR, { recursive: true });

  const browser = await chromium.launch({ args: GL_ARGS });
  const failures: string[] = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
    await Promise.all(
      ids.map(async (id) => {
        const file = path.join(CAPTURE_DIR, `${id}.html`);
        writeFileSync(file, buildPage(captureTemplate(id), bundle, `${id}.html`));
        const page = await context.newPage();
        const errors: string[] = [];
        page.on('pageerror', (e) => errors.push(e.message));
        try {
          const png = await capture(page, id, pathToFileURL(file).href);
          if (errors.length > 0) throw new Error(`${id}: the page threw: ${errors.join('; ')}`);
          writeFileSync(path.join(POSTER_DIR, `${id}.png`), png);
        } catch (error) {
          failures.push(error instanceof Error ? error.message : String(error));
        } finally {
          await page.close();
        }
      }),
    );
  } finally {
    await browser.close();
  }
  if (failures.length > 0) {
    for (const f of failures) console.error(`capture-posters: ${f}`);
    process.exit(1);
  }
  console.log(`POSTERS wrote=${ids.length} dir=dist-embed/posters`);
}

await main();
