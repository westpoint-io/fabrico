// Render health for the read-only board, measured from outside the page.
//
// A board whose WebGL context was taken keeps its Pixi ticker, and so its frame count, rising
// while it draws nothing. So a board check reads four things: the frame count rises, a compositor
// screenshot of a belt region changes, no mounted board's canvas got `webglcontextlost`, and the
// page logged no error. The live-context count comes from an init script that wraps
// `HTMLCanvasElement.prototype.getContext`, never from the embed's own bookkeeping, which would
// go down on unmount whether or not the context was freed.

import { createHash } from 'node:crypto';
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
