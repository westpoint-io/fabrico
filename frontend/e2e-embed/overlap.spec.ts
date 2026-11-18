import { expect, test, type Page } from '@playwright/test';
import { pageUrl, readProbe, recordConsoleErrors, watchPageErrors } from './support/health.ts';

// The demo board's name chips and label words never cover each other (overlap.html). The board
// is the front page's hero, drawn at a 960 x 600 stage, and every docs page shows it narrower, so
// it is read at that size and again with a 720 px wide stage. Every `div.chip` and `div.words` in
// the board's shadow root that is visible and has a box of positive area is compared with every
// other one, and any pair whose boxes share a positive area fails, naming both texts and boxes.
//
// A board that drew no overlay would pass a check that only looks for overlaps, so the read must
// also find a chip for each of the demo's 13 machines at both sizes, and the words of each of its 7
// labels wherever the board's zoom is at or above the words' floor. Below that floor (0.75, which
// the 720 px stage is) the overlay hides every label's words on purpose, so the read must find none.
//
// The page loads under reduced motion, so the board sits paused on its boot tick with every
// machine placed and nothing moving while the boxes are read.

const PAGE = pageUrl('overlap.html');
const BOARD = 'demo_scene';
const MACHINES = 13;
const LABELS = 7;
const STAGE_HEIGHT = 600;
const STAGE_WIDTHS = [960, 720] as const;
/** `LABEL_WORDS_MIN_ZOOM` in `src/render/labelGeometry.ts`: below this zoom no label shows its words. */
const WORDS_MIN_ZOOM = 0.75;

// Tall enough that the whole 600 px stage and its control bar sit inside the window.
test.use({ viewport: { width: 1280, height: 1000 } });

interface Box {
  kind: 'chip' | 'words';
  text: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const stageBox = (page: Page): Promise<{ width: number; height: number }> =>
  page.evaluate(() => {
    const el = document.querySelector('fabrico-board') as HTMLElement;
    const r = ((el.shadowRoot as ShadowRoot).querySelector('.stage') as HTMLElement).getBoundingClientRect();
    return { width: r.width, height: r.height };
  });

/** Widen `#wrap` until the stage inside the frame's padding is exactly `width` CSS px wide. */
async function sizeStage(page: Page, width: number): Promise<void> {
  const before = await stageBox(page);
  const wrap = await page.evaluate(() => (document.getElementById('wrap') as HTMLElement).getBoundingClientRect().width);
  await page.evaluate((w) => {
    (document.getElementById('wrap') as HTMLElement).style.width = `${w}px`;
  }, wrap + (width - before.width));
  await expect.poll(async () => (await stageBox(page)).width, { message: `the stage is ${width} px wide` }).toBeCloseTo(width, 1);
  expect((await stageBox(page)).height, 'the stage keeps its 600 px height').toBeCloseTo(STAGE_HEIGHT, 1);
}

/** Wait until the board's Pixi ticker has run `count` more frames, so the overlay has placed every element. */
async function waitFrames(page: Page, count: number): Promise<void> {
  const start = (await readProbe(page, BOARD)).frames;
  await expect.poll(async () => (await readProbe(page, BOARD)).frames, { message: `${count} more frames` }).toBeGreaterThanOrEqual(start + count);
}

/** Every visible chip and label words box with positive area, in screen px. */
function readBoxes(page: Page): Promise<Box[]> {
  return page.evaluate(() => {
    const root = (document.querySelector('fabrico-board') as HTMLElement).shadowRoot as ShadowRoot;
    const out: Box[] = [];
    for (const el of root.querySelectorAll('div.chip, div.words')) {
      if (getComputedStyle(el).visibility !== 'visible') continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      out.push({
        kind: el.classList.contains('chip') ? 'chip' : 'words',
        text: el.textContent ?? '',
        left: r.left,
        top: r.top,
        right: r.right,
        bottom: r.bottom,
      });
    }
    return out;
  });
}

const show = (b: Box): string =>
  `${b.kind} "${b.text}" [${b.left.toFixed(1)}, ${b.top.toFixed(1)}, ${b.right.toFixed(1)}, ${b.bottom.toFixed(1)}]`;

/** Each pair of boxes that share a positive area, described by both elements. */
function overlaps(boxes: readonly Box[]): string[] {
  const found: string[] = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (w > 0 && h > 0) found.push(`${show(a)} overlaps ${show(b)} by ${w.toFixed(1)} x ${h.toFixed(1)} px`);
    }
  }
  return found;
}

test('the demo board draws no name chip over a label or another chip, at a 960 and a 720 px stage', async ({ page }) => {
  test.setTimeout(60_000);
  const errors = watchPageErrors(page);
  const consoleErrors = recordConsoleErrors(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(PAGE);
  await expect
    .poll(async () => {
      const p = await readProbe(page, BOARD);
      return `${p.state}:${p.mounted ? 'mounted' : 'not mounted'}`;
    }, { timeout: 30_000 })
    .toBe('running:mounted');
  await waitFrames(page, 2);

  for (const width of STAGE_WIDTHS) {
    await sizeStage(page, width);
    await waitFrames(page, 2);
    const read = await readBoxes(page);
    const scale = (await readProbe(page, BOARD)).cameraSnapshot?.scale ?? 0;
    const chips = read.filter((b) => b.kind === 'chip');
    const words = read.filter((b) => b.kind === 'words');
    console.log(
      `OVERLAP ${BOARD} stage=${width}x${STAGE_HEIGHT} zoom=${scale.toFixed(3)} chips=${chips.length} words=${words.length} pairs=${overlaps(read).length}`,
    );
    // Soft, so a red run reports both stage sizes before it fails.
    expect.soft(chips.length, `${width} px stage: a visible chip for each of the ${MACHINES} machines`).toBeGreaterThanOrEqual(MACHINES);
    if (scale >= WORDS_MIN_ZOOM) {
      expect.soft(words.length, `${width} px stage, zoom ${scale.toFixed(3)}: visible words for each of the ${LABELS} labels`).toBeGreaterThanOrEqual(LABELS);
    } else {
      expect.soft(words.length, `${width} px stage, zoom ${scale.toFixed(3)}: label words hide below their zoom floor`).toBe(0);
    }
    expect.soft(overlaps(read), `${width} px stage: chips and label words that cover each other`).toEqual([]);
  }

  errors.assertNone('while the chips and words were read');
  expect(consoleErrors).toEqual([]);
});
