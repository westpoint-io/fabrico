import { expect, test, type Page } from '@playwright/test';
import {
  autoContinueCaptions,
  installGlCounter,
  pageUrl,
  recordConsoleErrors,
  recordRequests,
  watchPageErrors,
  WHOLE_PAGE_VIEWPORT,
} from './support/health.ts';

// The demo board at element widths of 360, 600 and 1024 px (layout.html). The control bar wraps
// when its two groups don't fit on one line, no control leaves the frame, every button and the
// select measure at least 44 px, name chips stay in the stage and never cover a control, and the
// loading state shows "Loading board" with every control disabled.

const PAGE = pageUrl('layout.html');
// Every board on this page runs at once, so the viewport holds the whole page.
test.use({ viewport: WHOLE_PAGE_VIEWPORT });
const WIDTHS = [360, 600, 1024] as const;

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

interface LayoutRead {
  element: Rect;
  frame: Rect;
  stage: Rect;
  play: Rect;
  speed: Rect;
  controls: { name: string; rect: Rect; tag: string }[];
  chips: { rect: Rect; visible: boolean }[];
  stageClips: boolean;
  /** Controls whose centre point hits something other than the control itself. */
  covered: string[];
  state: string;
  tick: number;
  endTick: number;
}

async function readLayout(page: Page, width: number): Promise<LayoutRead> {
  return page.evaluate((w) => {
    const rect = (e: Element): Rect => {
      const r = e.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
    };
    const el = document.querySelector(`[data-width="${w}"] fabrico-board`) as HTMLElement & {
      fabricoProbe(): { state: string; tick: number; endTick: number };
    };
    const root = el.shadowRoot as ShadowRoot;
    const named = [...root.querySelectorAll('.bar button, .bar select, .bar .counter, .bar .badge')];
    const covered: string[] = [];
    for (const c of root.querySelectorAll('.bar button, .bar select, .bar .badge')) {
      const r = c.getBoundingClientRect();
      const hit = root.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (hit === null || !(hit === c || c.contains(hit))) covered.push((c as HTMLElement).dataset.control ?? c.className);
    }
    const stage = root.querySelector('.stage') as HTMLElement;
    const labels = root.querySelector('.labels') as HTMLElement | null;
    const probe = el.fabricoProbe();
    return {
      element: rect(el),
      frame: rect(root.querySelector('.frame') as Element),
      stage: rect(stage),
      play: rect(root.querySelector('button[data-control="play"]') as Element),
      speed: rect(root.querySelector('select') as Element),
      controls: named.map((c) => ({ name: (c as HTMLElement).dataset.control ?? c.className, rect: rect(c), tag: c.tagName })),
      chips: [...root.querySelectorAll('.chip')].map((c) => ({ rect: rect(c), visible: getComputedStyle(c).visibility === 'visible' })),
      stageClips:
        getComputedStyle(stage).overflow === 'hidden' && labels !== null && getComputedStyle(labels).overflow === 'hidden',
      covered,
      state: probe.state,
      tick: probe.tick,
      endTick: probe.endTick,
    };
  }, width);
}

function expectLayoutHolds(read: LayoutRead, width: number, when: string): void {
  const at = `${width} px, ${when}`;
  expect(read.element.width, `${at}: the element fills its container`).toBe(width);
  for (const c of read.controls) {
    expect(c.rect.left, `${at}: ${c.name} starts inside the frame`).toBeGreaterThanOrEqual(read.frame.left);
    expect(c.rect.right, `${at}: ${c.name} ends inside the frame`).toBeLessThanOrEqual(read.frame.right);
    expect(c.rect.bottom, `${at}: ${c.name} sits inside the frame`).toBeLessThanOrEqual(read.frame.bottom);
    expect(c.rect.top, `${at}: ${c.name} sits below the stage`).toBeGreaterThanOrEqual(read.stage.bottom);
    if (c.tag === 'BUTTON' || c.tag === 'SELECT') {
      expect(c.rect.width, `${at}: ${c.name} is at least 44 px wide`).toBeGreaterThanOrEqual(44);
      expect(c.rect.height, `${at}: ${c.name} is at least 44 px tall`).toBeGreaterThanOrEqual(44);
    }
  }
  if (width < 1024) {
    expect(read.speed.top, `${at}: the bar wraps, so the speed select's top is below the play button's bottom`).toBeGreaterThanOrEqual(
      read.play.bottom,
    );
  } else {
    expect(Math.abs(read.speed.top - read.play.top), `${at}: the bar is one row`).toBeLessThanOrEqual(2);
  }
  expect(read.stageClips, `${at}: the stage and the label layer clip what falls outside them`).toBe(true);
  const shown = read.chips.filter((c) => c.visible);
  expect(read.chips.length, `${at}: the overlay holds a chip per machine`).toBeGreaterThan(0);
  if (width === 360) {
    // At this width the board is drawn below the chips' zoom floor, so they hide.
    expect(shown.length, `${at}: name chips hide below their zoom floor`).toBe(0);
  } else {
    expect(shown.length, `${at}: name chips show over the machines`).toBe(read.chips.length);
  }
  for (const c of shown) {
    const cx = (c.rect.left + c.rect.right) / 2;
    const cy = (c.rect.top + c.rect.bottom) / 2;
    const inside = cx >= read.stage.left && cx <= read.stage.right && cy >= read.stage.top && cy <= read.stage.bottom;
    expect(inside, `${at}: a chip centred at ${Math.round(cx)},${Math.round(cy)} sits in the stage`).toBe(true);
  }
  expect(read.covered, `${at}: no chip or other layer covers a control`).toEqual([]);
}

test('the bar wraps, nothing leaves the frame and every target is 44 px, at 360, 600 and 1024 px', async ({ page }) => {
  test.setTimeout(90_000);
  const errors = watchPageErrors(page);
  const consoleErrors = recordConsoleErrors(page);
  const requests = recordRequests(page);
  await installGlCounter(page);
  // A board stops at each caption it has; press Continue at once, as a reader would.
  await autoContinueCaptions(page);
  await page.goto(PAGE);
  for (const w of WIDTHS) {
    await expect.poll(async () => (await readLayout(page, w)).state, { timeout: 20_000 }).toBe('running');
  }
  for (const w of WIDTHS) {
    await page.locator(`[data-width="${w}"] fabrico-board`).scrollIntoViewIfNeeded();
    expectLayoutHolds(await readLayout(page, w), w, 'while it plays');
  }
  // The badge is widest at the end tick, so look again there.
  for (const w of WIDTHS) {
    await page.locator(`[data-width="${w}"] fabrico-board`).locator('select').selectOption({ label: '4x' });
  }
  for (const w of WIDTHS) {
    await expect
      .poll(async () => {
        const r = await readLayout(page, w);
        return r.tick === r.endTick;
      }, { timeout: 30_000 })
      .toBe(true);
    await page.locator(`[data-width="${w}"] fabrico-board`).scrollIntoViewIfNeeded();
    const read = await readLayout(page, w);
    console.log(
      `${w} px at the end tick: bar rows from y ${Math.round(read.play.top)} and ${Math.round(read.speed.top)}, ${read.chips.length} chips`,
    );
    expectLayoutHolds(read, w, 'at the end tick');
  }
  errors.assertNone('on the layout page');
  expect(consoleErrors).toEqual([]);
  expect(requests).toEqual([PAGE]);
});

test('before the player is ready, the stage says Loading board and every control is disabled', async ({ page }) => {
  test.setTimeout(60_000);
  const errors = watchPageErrors(page);
  await page.addInitScript(() => {
    // Hold every player instance until the test lets it go.
    const original = WebAssembly.instantiate.bind(WebAssembly) as (...a: unknown[]) => Promise<unknown>;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    (window as unknown as { __fabReleasePlayer: () => void }).__fabReleasePlayer = () => release();
    (WebAssembly as unknown as { instantiate: (...a: unknown[]) => Promise<unknown> }).instantiate = async (...args) => {
      await gate;
      return original(...args);
    };
  });
  // A board stops at each caption it has; press Continue at once, as a reader would.
  await autoContinueCaptions(page);
  await page.goto(PAGE);
  await page.waitForTimeout(1000);
  const loadingStage = new Map<number, { width: number; height: number }>();
  for (const w of WIDTHS) {
    const read = await page.evaluate((width) => {
      const el = document.querySelector(`[data-width="${width}"] fabrico-board`) as HTMLElement & {
        fabricoProbe(): { state: string };
      };
      const root = el.shadowRoot as ShadowRoot;
      const stage = (root.querySelector('.stage') as HTMLElement).getBoundingClientRect();
      return {
        state: el.fabricoProbe().state,
        status: root.querySelector('.status')?.textContent ?? '',
        disabled: [...root.querySelectorAll('.bar button, .bar select')].map((c) => (c as HTMLButtonElement).disabled),
        stage: { width: stage.width, height: stage.height },
      };
    }, w);
    expect(read.state, `${w} px: loading`).toBe('loading');
    expect(read.status, `${w} px: the stage text`).toBe('Loading board');
    expect(read.disabled, `${w} px: restart, play, step and speed are disabled`).toEqual([true, true, true, true]);
    const want = Math.min(560, Math.max(240, (read.stage.width * 10) / 16));
    expect(Math.abs(read.stage.height - want), `${w} px: the stage is 16:10 to its own width while loading`).toBeLessThanOrEqual(1);
    loadingStage.set(w, read.stage);
  }
  await page.evaluate(() => (window as unknown as { __fabReleasePlayer: () => void }).__fabReleasePlayer());
  for (const w of WIDTHS) {
    await expect
      .poll(async () => (await readLayout(page, w)).state, { timeout: 20_000, message: `${w} px: runs once released` })
      .toBe('running');
    // The code column and the caption strip are laid out from the bundle before the player loads,
    // so the stage doesn't change size when the board starts.
    const running = await page.evaluate((width) => {
      const el = document.querySelector(`[data-width="${width}"] fabrico-board`) as HTMLElement;
      const box = ((el.shadowRoot as ShadowRoot).querySelector('.stage') as HTMLElement).getBoundingClientRect();
      return { width: box.width, height: box.height };
    }, w);
    const before = loadingStage.get(w) ?? { width: 0, height: 0 };
    console.log(`${w} px: stage ${before.width.toFixed(1)} x ${before.height.toFixed(1)} loading, ${running.width.toFixed(1)} x ${running.height.toFixed(1)} running`);
    expect(Math.abs(running.width - before.width), `${w} px: the stage keeps its width when the board starts`).toBeLessThanOrEqual(0.5);
    expect(Math.abs(running.height - before.height), `${w} px: the stage keeps its height when the board starts`).toBeLessThanOrEqual(0.5);
  }
  errors.assertNone('on the layout page while loading');
});
