// Render health for the read-only board, measured from outside the page.
//
// A board whose WebGL context was taken keeps its Pixi ticker, and so its frame count, rising
// while it draws nothing. So a board check reads four things: the frame count rises, a compositor
// screenshot of the board's belt tiles changes, no mounted board's canvas got `webglcontextlost`,
// and the page logged no error. The tiles leave out machines, cables and the DOM chips over the
// canvas, so the pixels that change there are belts and items. The live-context count comes from an init script that wraps
// `HTMLCanvasElement.prototype.getContext`, never from the embed's own bookkeeping, which would
// go down on unmount whether or not the context was freed.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, type Page } from '@playwright/test';
// The PNG decoder Playwright already bundles (pngjs). No new dependency.
import { PNG } from 'playwright-core/lib/utilsBundle';
import type { BeltTile, BoardProbe } from '../../src/embed/probe.ts';
import { watchPageErrors } from '../../e2e-live/support/oracle.ts';

export { watchPageErrors };

/** What the init script exposes on `window.__fabGl`. */
export interface GlCounts {
  /** Contexts on canvases that were ever in the document, not lost. */
  live: number;
  /**
   * `webglcontextlost` events on canvases that were in the document and that the embed didn't
   * mark as torn down (`data-fab-teardown`).
   */
  lost: number;
  /**
   * Contexts on canvases never put in the document, not lost. Pixi keeps one such context per page
   * for its own capability probe (`getTestContext`), so 1 is expected and more is a leak.
   */
  hidden: number;
  /** Every WebGL context handed out since the page loaded. */
  made: number;
}

declare global {
  interface Window {
    __fabGl?: { counts(): GlCounts };
  }
}

/**
 * Install the context recorder. Call before `page.goto`.
 *
 * A canvas counts as shown once an animation frame sees it connected to the document (a shadow
 * root inside the document counts). A board torn down by only removing its canvas was shown, so
 * its still-live context is counted; Pixi's off-document probe canvases never are.
 */
export async function installGlCounter(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type Entry = {
      canvas: HTMLCanvasElement;
      ctx: WebGLRenderingContext | WebGL2RenderingContext;
      shown: boolean;
    };
    const entries: Entry[] = [];
    let lost = 0;
    const markShown = (): void => {
      for (const e of entries) if (!e.shown && e.canvas.isConnected) e.shown = true;
    };
    const watch = (): void => {
      markShown();
      requestAnimationFrame(watch);
    };
    requestAnimationFrame(watch);
    const original = HTMLCanvasElement.prototype.getContext;
    const wrapped = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]): unknown {
      const ctx = (original as (this: HTMLCanvasElement, ...a: unknown[]) => unknown).call(this, type, ...rest);
      const isGl = type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl';
      if (isGl && ctx !== null && !entries.some((e) => e.ctx === ctx)) {
        const entry: Entry = { canvas: this, ctx: ctx as WebGLRenderingContext, shown: false };
        entries.push(entry);
        this.addEventListener('webglcontextlost', () => {
          markShown();
          if (entry.shown && !entry.canvas.hasAttribute('data-fab-teardown')) lost += 1;
        });
      }
      return ctx;
    };
    HTMLCanvasElement.prototype.getContext = wrapped as typeof HTMLCanvasElement.prototype.getContext;
    window.__fabGl = {
      counts: () => {
        markShown();
        const alive = entries.filter((e) => !e.ctx.isContextLost());
        return {
          live: alive.filter((e) => e.shown).length,
          lost,
          hidden: alive.filter((e) => !e.shown).length,
          made: entries.length,
        };
      },
    };
  });
}

/**
 * A viewport tall enough to hold every board on the test pages that run all their boards at once.
 * A board holds a renderer only within 200 px of the viewport, so a spec about something other
 * than scrolling uses this to have every board on its page mounted from the start.
 */
export const WHOLE_PAGE_VIEWPORT = { width: 1280, height: 3200 } as const;

/**
 * The names of the boards whose element box is within `margin` CSS px of the viewport, measured
 * by the test from the page's layout, not read from the embed.
 */
export async function boardsNearViewport(page: Page, margin = 200): Promise<string[]> {
  return page.evaluate((m) => {
    const out: string[] = [];
    for (const el of document.querySelectorAll('fabrico-board')) {
      const r = el.getBoundingClientRect();
      if (r.bottom >= -m && r.top <= window.innerHeight + m && r.right >= -m && r.left <= window.innerWidth + m) {
        out.push(el.getAttribute('name') ?? '');
      }
    }
    return out;
  }, margin);
}

/** Read the outside context counts. */
export async function glCounts(page: Page): Promise<GlCounts> {
  return page.evaluate(() => {
    if (window.__fabGl === undefined) throw new Error('the GL counter init script is not installed');
    return window.__fabGl.counts();
  });
}

/** Every request the page makes, by URL. */
export function recordRequests(page: Page): string[] {
  const urls: string[] = [];
  page.on('request', (request) => urls.push(request.url()));
  return urls;
}

/** Every console error the page logs. */
export function recordConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  return errors;
}

/** A board's probe snapshot, by its `name` attribute. */
export async function readProbe(page: Page, name: string): Promise<BoardProbe> {
  return page.evaluate((n) => {
    const el = document.querySelector(`fabrico-board[name="${n}"]`) as (Element & { fabricoProbe?: () => unknown }) | null;
    if (el === null || typeof el.fabricoProbe !== 'function') throw new Error(`no fabrico-board named ${n}`);
    return el.fabricoProbe();
  }, name) as Promise<BoardProbe>;
}

const BUDGET_MS = 10_000;
const POLL_MS = 250;

/**
 * A tile's cell and its box on screen. A tile is compared only with itself at the same place: when
 * the page's layout moves the board (another board's effect log grows, the browser anchors the
 * scroll), its tiles get new keys rather than counting as changed pixels.
 */
const tileKey = (t: BeltTile): string =>
  `${t.cellX},${t.cellY}@${t.x.toFixed(2)},${t.y.toFixed(2)},${t.width.toFixed(2)},${t.height.toFixed(2)}`;

/**
 * One sample of a board's belt tiles: a compositor screenshot of the box around them, and a hash
 * of each tile's pixels, by {@link tileKey}. The probe is read before and after the screenshot and
 * only tiles in both lists are kept, so neither a chip or ring that appeared over a tile nor a
 * layout move while the screenshot was taken counts as the tile changing.
 */
async function sampleTiles(page: Page, selector: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const before = (await readProbeAt(page, selector)).beltTiles;
  if (before.length === 0) return out;
  const x0 = Math.floor(Math.min(...before.map((t) => t.x)));
  const y0 = Math.floor(Math.min(...before.map((t) => t.y)));
  const x1 = Math.ceil(Math.max(...before.map((t) => t.x + t.width)));
  const y1 = Math.ceil(Math.max(...before.map((t) => t.y + t.height)));
  const clip = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  const png = PNG.sync.read(await page.screenshot({ clip, animations: 'allow' }));
  const still = new Set((await readProbeAt(page, selector)).beltTiles.map(tileKey));
  const scale = png.width / clip.width;
  for (const t of before) {
    const key = tileKey(t);
    if (!still.has(key)) continue;
    const left = Math.max(0, Math.round((t.x - clip.x) * scale));
    const top = Math.max(0, Math.round((t.y - clip.y) * scale));
    const right = Math.min(png.width, Math.round((t.x + t.width - clip.x) * scale));
    const bottom = Math.min(png.height, Math.round((t.y + t.height - clip.y) * scale));
    const digest = createHash('sha256');
    for (let y = top; y < bottom; y++) digest.update(png.data.subarray((y * png.width + left) * 4, (y * png.width + right) * 4));
    out.set(key, digest.digest('hex'));
  }
  return out;
}

/**
 * Fold a sample into `seen`, the first hash of each tile key. True when a tile already in `seen`
 * now has different pixels.
 */
function foldSample(seen: Map<string, string>, sample: Map<string, string>): boolean {
  let changed = false;
  for (const [key, hash] of sample) {
    const was = seen.get(key);
    if (was === undefined) seen.set(key, hash);
    else if (was !== hash) changed = true;
  }
  return changed;
}

/**
 * Assert the board is drawing: its frame count rises by at least 2, and the pixels of at least one
 * of its belt tiles, in screenshots taken by the browser's compositor, change within the budget.
 */
export async function expectBoardDrawing(page: Page, name: string, context: string): Promise<void> {
  await expectBoardDrawingAt(page, `fabrico-board[name="${name}"]`, context, name);
}

/** {@link expectBoardDrawing} for the board a CSS selector finds, for pages with two of one name. */
export async function expectBoardDrawingAt(page: Page, selector: string, context: string, name = selector): Promise<void> {
  const before = (await readProbeAt(page, selector)).frames;
  await expect
    .poll(async () => (await readProbeAt(page, selector)).frames - before, {
      message: `${context}: ${name}'s frame count rises`,
      timeout: BUDGET_MS,
      intervals: [POLL_MS],
    })
    .toBeGreaterThanOrEqual(2);
  // A dropped packet stops the board with a card, but a decode error has no console line, so
  // read the counters as well.
  const packets = await readProbeAt(page, selector);
  expect(packets.decodeErrors, `${context}: ${name} refused no render packet`).toBe(0);
  expect(packets.packetsApplied, `${context}: ${name} applied its render packets`).toBeGreaterThan(0);

  const deadline = Date.now() + BUDGET_MS;
  const seen = new Map<string, string>();
  let samples = 0;
  while (Date.now() < deadline) {
    samples += 1;
    if (foldSample(seen, await sampleTiles(page, selector))) return;
    await page.waitForTimeout(POLL_MS);
  }
  expect(seen.size, `${context}: ${name} reports belt tiles on screen`).toBeGreaterThan(0);
  throw new Error(
    `${context}: ${name}'s ${seen.size} belt tiles showed the same pixels in ${samples} screenshots over ${BUDGET_MS} ms`,
  );
}

// --- Board files, the manifest and the native per-tick oracle ---

const repoPath = (path: string): string => fileURLToPath(new URL(`../../../${path}`, import.meta.url));

/** A built test page's file:// URL. */
export function pageUrl(name: string): string {
  return pathToFileURL(fileURLToPath(new URL(`../../dist-embed/pages/${name}`, import.meta.url))).href;
}

/** `demo_scene` to `examples/boards/demo_scene.board.ron`; `docs-x` to `examples/boards/docs/x.board.ron`. */
export function boardPathOf(id: string): string {
  const parts = id.split('-');
  const nested = parts[0] === 'docs' && parts.length > 1;
  return nested ? `examples/boards/docs/${parts.slice(1).join('-')}.board.ron` : `examples/boards/${id}.board.ron`;
}

/** The board's line in hashes.manifest, read at run time. */
export function manifestLine(id: string): { endTick: number; hash: string } {
  const path = boardPathOf(id);
  const line = readFileSync(repoPath('examples/boards/hashes.manifest'), 'utf8')
    .split('\n')
    .find((candidate) => candidate.startsWith(`${path} `));
  if (line === undefined) throw new Error(`hashes.manifest has no line for ${path}`);
  const [, endTick, hash] = line.split(' ');
  return { endTick: Number(endTick), hash };
}

/**
 * The native engine's hash at every tick of a board, from the dump `scripts/check-embed.sh` writes
 * into FABRICO_PLAYER_NATIVE_DUMP: `<path with / turned into _>.hashes`, one `<tick> <hash>` a line.
 */
export function nativeHashes(id: string): [number, string][] {
  const dir = process.env.FABRICO_PLAYER_NATIVE_DUMP;
  if (dir === undefined || dir === '') {
    throw new Error('FABRICO_PLAYER_NATIVE_DUMP is unset. Run the embed specs through scripts/check-embed.sh.');
  }
  const file = path.join(dir, `${boardPathOf(id).replace(/\//g, '_')}.hashes`);
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const [tick, hash] = line.split(' ');
      return [Number(tick), hash];
    });
}

/**
 * Compare a page's trace with the native dump, tick by tick, from the native file's first tick.
 * Fails naming the first tick that differs or is missing. Returns how many ticks matched.
 */
export function expectTraceMatchesNative(id: string, trace: [number, string][], ticks: number | 'all'): number {
  const native = nativeHashes(id);
  const want = ticks === 'all' ? native : native.slice(0, ticks + 1);
  // Tick by tick first, so a skipped, repeated or different tick is named by its number.
  for (let i = 0; i < want.length; i++) {
    const [nativeTick, nativeHash] = want[i];
    const got = trace[i];
    expect(got?.[0], `${id}: trace entry ${i} is tick ${nativeTick} (a tick was skipped or repeated)`).toBe(nativeTick);
    expect(got?.[1], `${id} at tick ${nativeTick}: the page's hash equals the native engine's`).toBe(nativeHash);
  }
  if (ticks === 'all') {
    expect(trace.length, `${id}: the page traced ${trace.length} ticks and the native dump has ${native.length}`).toBe(
      native.length,
    );
  }
  return want.length;
}

/** A board's trace: every tick and hash since boot or its last restart. Needs the trace init script. */
export async function readTrace(page: Page, name: string): Promise<[number, string][]> {
  return page.evaluate((n) => {
    const el = document.querySelector(`fabrico-board[name="${n}"]`) as
      | (Element & { fabricoTickHashes?: () => [number, string][] })
      | null;
    if (el === null || typeof el.fabricoTickHashes !== 'function') throw new Error(`no fabrico-board named ${n}`);
    return el.fabricoTickHashes();
  }, name);
}

/** Ask the page for per-tick hashes. Call before `page.goto`. */
export async function enableTrace(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (globalThis as { __FABRICO_EMBED_TRACE__?: boolean }).__FABRICO_EMBED_TRACE__ = true;
  });
}

/** The text of a shadow-root element of a board. */
export async function shadowText(page: Page, name: string, selector: string): Promise<string> {
  return page.evaluate(
    ([n, sel]) => {
      const el = document.querySelector(`fabrico-board[name="${n}"]`);
      return el?.shadowRoot?.querySelector(sel)?.textContent ?? '';
    },
    [name, selector] as const,
  );
}

// --- Captions ---

/**
 * Press Continue whenever a caption holds a board, the way a reader who reads each note at once
 * would. Specs whose subject isn't captions install this before `page.goto`, so a demo board run
 * to its end isn't left waiting on a note. It clicks the play button only while its accessible
 * name reads "Continue", which the element sets only while a caption holds the board.
 */
export async function autoContinueCaptions(page: Page): Promise<void> {
  await page.addInitScript(() => {
    setInterval(() => {
      for (const board of document.querySelectorAll('fabrico-board')) {
        const play = board.shadowRoot?.querySelector('button[data-control="play"][aria-label="Continue"]');
        if (play instanceof HTMLButtonElement && !play.disabled) play.click();
      }
    }, 50);
  });
}

/** A caption as the board file states it. */
export interface FileCaption {
  tick: number;
  highlight: number;
  text: string;
}

/** A board file's text, by board id. */
export function boardFileText(id: string): string {
  return readFileSync(repoPath(boardPathOf(id)), 'utf8');
}

/** The captions list of a board file, read with a pattern rather than the player. */
export function fileCaptions(id: string): FileCaption[] {
  const out: FileCaption[] = [];
  const re = /Caption\(tick: (\d+), highlight: (\d+), text: "((?:[^"\\]|\\.)*)"\)/g;
  for (const m of boardFileText(id).matchAll(re)) {
    out.push({ tick: Number(m[1]), highlight: Number(m[2]), text: m[3].replace(/\\(.)/g, '$1') });
  }
  return out;
}

/**
 * The cell a board file places the machine with this dense handle on. Handles mint in command
 * order: a Place or a DrawBelt mints one and a DrawWire two; the other commands mint none.
 * Read from the file, so it doesn't share code with the element under test.
 */
export function placedCell(id: string, handle: number): { kind: number; cellX: number; cellY: number } {
  const text = boardFileText(id);
  const start = text.indexOf('commands: [');
  const end = text.indexOf('\n    script: [');
  if (start < 0 || end < 0) throw new Error(`${id}: no commands list`);
  let next = 0;
  for (const line of text.slice(start, end).split('\n')) {
    const m = /^\s+(Place|DrawBelt|DrawWire)\(/.exec(line);
    if (m === null) continue;
    if (m[1] === 'Place') {
      if (next === handle) {
        const p = /Place\(kind: (\d+), cell_x: (-?\d+), cell_y: (-?\d+)\)/.exec(line);
        if (p === null) throw new Error(`${id}: can't read the Place for handle ${handle}: ${line}`);
        return { kind: Number(p[1]), cellX: Number(p[2]), cellY: Number(p[3]) };
      }
      next += 1;
    } else {
      if (next === handle) throw new Error(`${id}: handle ${handle} is a ${m[1]}, not a machine`);
      next += m[1] === 'DrawWire' ? 2 : 1;
    }
  }
  throw new Error(`${id}: no command mints handle ${handle}`);
}

/** A board's probe snapshot, by a CSS selector for the element. */
export async function readProbeAt(page: Page, selector: string): Promise<BoardProbe> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel) as (Element & { fabricoProbe?: () => unknown }) | null;
    if (el === null || typeof el.fabricoProbe !== 'function') throw new Error(`no fabrico-board at ${sel}`);
    return el.fabricoProbe();
  }, selector) as Promise<BoardProbe>;
}

/**
 * Render health across an action that starts a held board moving, such as Continue. The board is
 * paused before the action, so its belt tiles hold still; this samples them first, runs the
 * action, and passes once the frame count has risen by 2 and a compositor screenshot shows at
 * least one of the same tiles with different pixels. A board whose canvas stopped drawing shows
 * the held picture (or a blank one) forever and fails.
 */
export async function expectDrawsAfter(page: Page, name: string, action: () => Promise<void>, context: string): Promise<void> {
  const selector = `fabrico-board[name="${name}"]`;
  const held = await readProbe(page, name);
  // A held board's tiles are still, but the page around it may move while it settles, which leaves
  // a sample empty; take samples until one holds tiles.
  let before = await sampleTiles(page, selector);
  const settle = Date.now() + BUDGET_MS;
  while (before.size === 0 && Date.now() < settle) {
    await page.waitForTimeout(50);
    before = await sampleTiles(page, selector);
  }
  expect(before.size, `${context}: ${name} reports belt tiles on screen`).toBeGreaterThan(0);
  await action();
  await expect
    .poll(async () => (await readProbe(page, name)).frames - held.frames, {
      message: `${context}: ${name}'s frame count rises`,
      timeout: BUDGET_MS,
      intervals: [50],
    })
    .toBeGreaterThanOrEqual(2);
  const deadline = Date.now() + BUDGET_MS;
  let samples = 0;
  const seen = new Map(before);
  while (Date.now() < deadline) {
    samples += 1;
    if (foldSample(seen, await sampleTiles(page, selector))) return;
    await page.waitForTimeout(50);
  }
  throw new Error(
    `${context}: ${name}'s ${before.size} belt tiles kept their held pixels in ${samples} screenshots over ${BUDGET_MS} ms`,
  );
}

/** A board's trace, by a CSS selector for the element. Needs the trace init script. */
export async function readTraceAt(page: Page, selector: string): Promise<[number, string][]> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel) as (Element & { fabricoTickHashes?: () => [number, string][] }) | null;
    if (el === null || typeof el.fabricoTickHashes !== 'function') throw new Error(`no fabrico-board at ${sel}`);
    return el.fabricoTickHashes();
  }, selector);
}
