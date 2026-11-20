import { test, expect, type Page } from '@playwright/test';
import { buildPacket, mockRenderSocket, waitForBoard, waitForChrome, type InjectNode } from './support/wire';
import { machine_kind } from '../src/protocol/kinds';

// test-antialias-switch.spec.ts - the dev server's test flag really boots the board with
// antialiasing on, and the board boots with it off without the flag.
//
// WHAT IT READS. The board canvas's own WebGL context, not the option Pixi was handed.
// Asking a canvas for the context type it already has returns that context, so
// `getContextAttributes().antialias` and `getParameter(SAMPLES)` report what the driver
// actually built. A driver that ignored the request, or a boot that read the flag too late
// (after the context existed), shows up here as `antialias: false, samples: 0`.
//
// WHY THIS MATTERS. The capture set photographs the board with antialiasing on to see grey
// fringes beside strokes. If the flag silently did nothing, every "antialiasing on" capture
// would be an "off" capture under another name and no fringe check could fail.
//
// SCOPE. This suite runs on the Vite dev server, where the flag is live. The shipped bundles
// drop the flag at build time; `scripts/check-test-aa-switch-absent.sh` checks that, in CI.
// Chromium only (SwiftShader reports 4 samples with antialiasing on).

/** One idle Factory, so the board has something to draw with the context it booted. */
const FACTORY: InjectNode = { id: 1, kind: machine_kind.FACTORY, cell_x: 10, cell_y: 6, w: 3, h: 3 };

interface GlRead {
  /** How many canvases fill the window; the board canvas is the only one. */
  canvases: number;
  /** 'webgl2', 'webgl' or null when neither context type is on the canvas. */
  kind: string | null;
  antialias: boolean | null;
  samples: number | null;
}

/** Read the live antialiasing state off the board canvas's existing WebGL context. */
async function readGl(page: Page): Promise<GlRead> {
  return page.evaluate(() => {
    const full = Array.from(document.querySelectorAll('canvas')).filter(
      (c) => c.clientWidth === window.innerWidth && c.clientHeight === window.innerHeight,
    );
    const c = full[0];
    if (c === undefined) return { canvases: 0, kind: null, antialias: null, samples: null };
    const gl2 = c.getContext('webgl2');
    const gl = (gl2 ?? c.getContext('webgl')) as WebGLRenderingContext | null;
    if (gl === null) return { canvases: full.length, kind: null, antialias: null, samples: null };
    return {
      canvases: full.length,
      kind: gl2 !== null ? 'webgl2' : 'webgl',
      antialias: gl.getContextAttributes()?.antialias ?? null,
      samples: gl.getParameter(gl.SAMPLES) as number,
    };
  });
}

/** Boot the app route at `path` with the one-Factory board; returns the page's errors. */
async function bootAt(page: Page, path: string): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`${e.message}\n${e.stack ?? '(no stack)'}`));
  const h = await mockRenderSocket(page);
  await page.goto(path);
  await waitForChrome(page);
  await h.connected;
  h.inject(buildPacket({ tick: 3, nodes: [FACTORY] }));
  await waitForBoard(page, { machines: 1, tick: 3 });
  return errors;
}

test.describe('the test antialiasing flag in the dev server', () => {
  test('without the flag the board context has antialiasing off and no samples', async ({ page }) => {
    const errors = await bootAt(page, '/');
    const gl = await readGl(page);
    expect(gl.canvases, 'exactly one canvas fills the window').toBe(1);
    expect(gl.kind, 'the board canvas has a WebGL context').not.toBeNull();
    expect(gl.antialias, 'the live context reports antialiasing off').toBe(false);
    expect(gl.samples, 'the default framebuffer has no samples').toBe(0);
    expect(errors, 'no page error').toEqual([]);
  });

  test('with the flag the board context has antialiasing on and samples above 0', async ({ page }) => {
    const errors = await bootAt(page, '/?fab-test-antialias');
    const gl = await readGl(page);
    expect(gl.canvases, 'exactly one canvas fills the window').toBe(1);
    expect(gl.kind, 'the board canvas has a WebGL context').not.toBeNull();
    expect(gl.antialias, 'the live context reports antialiasing on').toBe(true);
    expect(gl.samples, 'the default framebuffer is multisampled').toBeGreaterThan(0);
    expect(errors, 'no page error').toEqual([]);
  });
});
