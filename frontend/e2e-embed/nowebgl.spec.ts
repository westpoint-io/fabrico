import { expect, test, type Page } from '@playwright/test';
import {
  boardFileText,
  fileCaptions,
  glCounts,
  installGlCounter,
  pageUrl,
  readProbe,
  recordConsoleErrors,
  recordRequests,
  watchPageErrors,
  WHOLE_PAGE_VIEWPORT,
} from './support/health.ts';

// Runs only in the chromium-nowebgl project: Chromium launched with --disable-webgl after the
// pinned GL arguments. Pixi would boot on its canvas renderer here without complaint, so these
// checks fail if the board runs at all. Every board must show its poster (a PNG of its end tick,
// captured at build time) filling the stage, with the alt text the board file gives it, and the
// no-WebGL line in place of the control bar, with no canvas anywhere in its stage.

const NO_WEBGL = "This browser can't run WebGL, so this is a still picture of the board at its last tick.";
const NO_WEBGL_NO_POSTER = "This browser can't run WebGL, so this board can't be shown here.";

test.use({ viewport: WHOLE_PAGE_VIEWPORT });

/** The alt text a bundled board's poster carries, read from the board file. */
function expectedAlt(id: string): string {
  const first = fileCaptions(id)[0];
  if (first !== undefined) return first.text;
  const title = /\btitle: "((?:[^"\\]|\\.)*)"/.exec(boardFileText(id))?.[1] ?? id;
  return `${title}, a Fabrico board, at its last tick`;
}

interface StillRead {
  img: { alt: string; naturalWidth: number; naturalHeight: number; complete: boolean; box: DOMRectInit; fit: string } | null;
  stage: DOMRectInit;
  canvases: number;
  barShown: boolean;
  logShown: boolean;
  captionsShown: boolean;
  line: { shown: boolean; text: string };
}

async function readStill(page: Page, index: number): Promise<StillRead> {
  return page.evaluate((i) => {
    const el = document.querySelectorAll('fabrico-board')[i] as HTMLElement;
    const root = el.shadowRoot as ShadowRoot;
    const shown = (sel: string): boolean => {
      const node = root.querySelector(sel) as HTMLElement | null;
      return node !== null && getComputedStyle(node).display !== 'none' && node.getClientRects().length > 0;
    };
    const stage = (root.querySelector('.stage') as HTMLElement).getBoundingClientRect();
    const img = root.querySelector('.stage img') as HTMLImageElement | null;
    const imgShown = img !== null && getComputedStyle(img).display !== 'none' && img.getClientRects().length > 0;
    const line = root.querySelector('.no-webgl') as HTMLElement | null;
    return {
      img: imgShown && img !== null
        ? {
            alt: img.alt,
            naturalWidth: img.naturalWidth,
            naturalHeight: img.naturalHeight,
            complete: img.complete,
            box: img.getBoundingClientRect().toJSON() as DOMRectInit,
            fit: getComputedStyle(img).objectFit,
          }
        : null,
      stage: stage.toJSON() as DOMRectInit,
      canvases: root.querySelectorAll('canvas').length,
      barShown: shown('.bar'),
      logShown: shown('.effect-log'),
      captionsShown: shown('.captions'),
      line: { shown: shown('.no-webgl'), text: line?.textContent ?? '' },
    };
  }, index);
}

for (const pageName of ['three-boards.html', 'panels.html']) {
  test(`${pageName}: every board shows its poster and the no-WebGL line, and no board runs`, async ({ page }) => {
    const errors = watchPageErrors(page);
    const consoleErrors = recordConsoleErrors(page);
    const requests = recordRequests(page);
    await installGlCounter(page);
    const url = pageUrl(pageName);
    await page.goto(url);

    const names = await page.evaluate(() => [...document.querySelectorAll('fabrico-board')].map((b) => b.getAttribute('name') ?? ''));
    expect(names.length, `${pageName} has boards`).toBeGreaterThan(0);
    // The page's own check that WebGL is off here, so a green run means what it says.
    expect(
      await page.evaluate(() => {
        const c = document.createElement('canvas');
        return c.getContext('webgl2') === null && c.getContext('webgl') === null;
      }),
      'this browser hands out no WebGL context',
    ).toBe(true);

    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      const registered = (await page.evaluate((n) => document.querySelector(`script[type="text/x-fabrico-board"]#${CSS.escape(n)}`) !== null, name));
      await expect.poll(async () => (await readProbe(page, name)).noWebGL, { message: `${name} gives up on WebGL` }).toBe(true);
      // Give a board that wrongly boots anyway time to put a canvas in.
      await page.waitForTimeout(300);
      const read = await readStill(page, i);
      const probe = await readProbe(page, name);
      expect(read.canvases, `${name}: no canvas in the board`).toBe(0);
      expect(probe.mounted, `${name}: no renderer`).toBe(false);
      expect(read.barShown, `${name}: no control bar`).toBe(false);
      expect(read.logShown, `${name}: no effect log`).toBe(false);
      expect(read.captionsShown, `${name}: no caption strip`).toBe(false);
      expect(read.line.shown, `${name}: the no-WebGL line shows`).toBe(true);
      if (registered) {
        // A board the page registered has no poster in the bundle.
        expect(read.line.text, `${name}: the line for a board with no poster`).toBe(NO_WEBGL_NO_POSTER);
        expect(read.img, `${name}: no poster image`).toBeNull();
        continue;
      }
      expect(read.line.text, `${name}: the no-WebGL line`).toBe(NO_WEBGL);
      expect(read.img, `${name}: a poster image shows`).not.toBeNull();
      if (read.img === null) continue;
      await expect
        .poll(async () => (await readStill(page, i)).img?.naturalWidth ?? 0, { message: `${name}: the poster decodes` })
        .toBe(960);
      const decoded = (await readStill(page, i)).img;
      expect(decoded?.naturalHeight, `${name}: the poster is 960 by 600`).toBe(600);
      expect(read.img.alt, `${name}: the poster's alt text`).toBe(expectedAlt(name));
      expect(probe.posterShown, `${name}: the probe reports the poster`).toBe(true);
      expect(probe.posterAlt, `${name}: the probe reports the alt text`).toBe(expectedAlt(name));
      expect(read.img.fit, `${name}: the poster keeps its proportions`).toBe('contain');
      for (const key of ['x', 'y', 'width', 'height'] as const) {
        expect(Math.abs((read.img.box[key] ?? 0) - (read.stage[key] ?? 0)), `${name}: the poster fills the stage (${key})`).toBeLessThanOrEqual(0.5);
      }
      console.log(`${pageName} ${name}: poster ${decoded?.naturalWidth}x${decoded?.naturalHeight} in a ${Math.round(read.stage.width ?? 0)}x${Math.round(read.stage.height ?? 0)} stage, alt "${read.img.alt}"`);
    }

    const counts = await glCounts(page);
    expect(counts.made, 'no WebGL context was ever handed out').toBe(0);
    errors.assertNone(`on ${pageName} without WebGL`);
    expect(consoleErrors).toEqual([]);
    expect(requests).toEqual([url]);
  });
}
