// Render health for the read-only board, measured from outside the page.
//
// A board whose WebGL context was taken keeps its Pixi ticker, and so its frame count, rising
// while it draws nothing. So a board check reads four things: the frame count rises, a compositor
// screenshot of a belt region changes, no mounted board's canvas got `webglcontextlost`, and the
// page logged no error. The live-context count comes from an init script that wraps
// `HTMLCanvasElement.prototype.getContext`, never from the embed's own bookkeeping, which would
// go down on unmount whether or not the context was freed.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, type Page } from '@playwright/test';
import type { BoardProbe } from '../../src/embed/probe.ts';
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
 * Assert the board is drawing: its frame count rises by at least 2, and a screenshot of its
 * longest belt's region, taken by the browser's compositor, changes within the budget.
 */
export async function expectBoardDrawing(page: Page, name: string, context: string): Promise<void> {
  const before = (await readProbe(page, name)).frames;
  await expect
    .poll(async () => (await readProbe(page, name)).frames - before, {
      message: `${context}: ${name}'s frame count rises`,
      timeout: BUDGET_MS,
      intervals: [POLL_MS],
    })
    .toBeGreaterThanOrEqual(2);

  const deadline = Date.now() + BUDGET_MS;
  let first: string | null = null;
  let samples = 0;
  while (Date.now() < deadline) {
    const region = (await readProbe(page, name)).beltRegion;
    expect(region, `${context}: ${name} reports a belt region on screen`).not.toBeNull();
    if (region === null) return;
    const png = await page.screenshot({ clip: region, animations: 'allow' });
    samples += 1;
    const hash = createHash('sha256').update(png).digest('hex');
    if (first === null) {
      first = hash;
    } else if (hash !== first) {
      return;
    }
    await page.waitForTimeout(POLL_MS);
  }
  throw new Error(`${context}: ${name}'s belt region showed the same pixels in ${samples} screenshots over ${BUDGET_MS} ms`);
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
 * paused before the action, so its belt region holds still; this takes that picture first, runs
 * the action, and passes once the frame count has risen by 2 and a compositor screenshot of the
 * same region differs from the held one. A board whose canvas stopped drawing shows the held
 * picture (or a blank one) forever and fails.
 */
export async function expectDrawsAfter(page: Page, name: string, action: () => Promise<void>, context: string): Promise<void> {
  const held = await readProbe(page, name);
  const region = held.beltRegion;
  expect(region, `${context}: ${name} reports a belt region on screen`).not.toBeNull();
  if (region === null) return;
  const before = createHash('sha256').update(await page.screenshot({ clip: region, animations: 'allow' })).digest('hex');
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
  while (Date.now() < deadline) {
    const png = await page.screenshot({ clip: region, animations: 'allow' });
    samples += 1;
    if (createHash('sha256').update(png).digest('hex') !== before) return;
    await page.waitForTimeout(50);
  }
  throw new Error(`${context}: ${name}'s belt region kept its held picture in ${samples} screenshots over ${BUDGET_MS} ms`);
}
