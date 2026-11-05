import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
// loading state shows "Loading board" with every control disabled. A second page,
// badge-width.html, checks the widest hash badge text and a 4-digit board's transport row at 288,
// 328, 340 and 360 px.

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

// The widest badge text, "final state xxxxxxxx order-dependent", at element widths of 288, 328,
// 340 and 360 px (badge-width.html). Martian Mono at 12 px advances 8 px a character in Chromium,
// so on one line the badge is 302 px: 36 characters with a 4 px gap for the space between the
// hash and the verdict, 16 px of padding and a 2 px border. The frame's padding and bezel take
// 28 px, so the badge needs a 330 px element to sit on one line. 288 px is a docs column on a
// 320 px phone with 16 px gutters, the narrowest viewport WCAG 1.4.10 reflow asks for; 328 px is
// one on a 360 px phone, and 340 px one on a 375 px phone, rounded down.
//
// The same board has a 4-digit end tick, so its transport row (three 44 px buttons, the counter
// "tick 1,000 / 1,000" and the gaps) is 300 px on one line. That fits a 328 px element and not a
// 288 px one, where the counter has to drop under the buttons. So every control is checked
// against the bar's box and every target against 44 px at each width, not only the badge.
//
// No bundled board ends off its pin when fed in reverse order, so the test copies the built page
// and moves docs/script-outcomes' pin in the manifest the bundle inlines. The run, the verdict
// function, the bar and the stylesheet are the real ones; only the value the run is graded
// against changes, and the badge then reads what an order-dependent board reads.
const BADGE_PAGE = pageUrl('badge-width.html');
const BADGE_WIDTHS = [288, 328, 340, 360] as const;
const OUTCOMES_PIN = /(examples\/boards\/docs\/script-outcomes\.board\.ron \d+ )([0-9a-f]{64})/g;

/** Every hex digit turned round (0 to f, 1 to e, ...), so the result differs at every place. */
function flipHex(hash: string): string {
  return [...hash].map((d) => (15 - Number.parseInt(d, 16)).toString(16)).join('');
}

/** The badge-width page with docs/script-outcomes pinned somewhere its run doesn't end. Returns its URL and the real pin. */
function pageWithMovedPin(outPath: string): { url: string; pin: string } {
  const text = readFileSync(fileURLToPath(BADGE_PAGE), 'utf8');
  const pins = [...text.matchAll(OUTCOMES_PIN)];
  expect(pins.length, 'the built page inlines docs/script-outcomes\' manifest line once').toBe(1);
  const pin = pins[0][2];
  const moved = text.replace(OUTCOMES_PIN, (_line, head: string, hash: string) => `${head}${flipHex(hash)}`);
  expect(moved, 'the copy moves the pin').not.toBe(text);
  writeFileSync(outPath, moved);
  return { url: pathToFileURL(outPath).href, pin };
}

interface BadgeRead {
  state: string;
  tick: number;
  endTick: number;
  /** The bar's box, which is the frame's content box: inside the padding and the bezel ring. */
  bar: Rect;
  badge: Rect;
  hash: Rect;
  verdictWord: Rect;
  controls: { name: string; rect: Rect; tag: string }[];
  verdict: string;
  text: string;
  /** The badge's content is wider than its box, so part of it is cut off or spills. */
  overflows: boolean;
}

async function readBadge(page: Page, width: number): Promise<BadgeRead> {
  return page.evaluate((w) => {
    const rect = (e: Element): Rect => {
      const r = e.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
    };
    const el = document.querySelector(`[data-badge-width="${w}"] fabrico-board`) as HTMLElement & {
      fabricoProbe(): { state: string; tick: number; endTick: number };
    };
    const root = el.shadowRoot as ShadowRoot;
    const badge = root.querySelector('.bar .badge') as HTMLElement;
    const probe = el.fabricoProbe();
    return {
      state: probe.state,
      tick: probe.tick,
      endTick: probe.endTick,
      bar: rect(root.querySelector('.bar') as Element),
      badge: rect(badge),
      hash: rect(badge.querySelector('.badge-hash') as Element),
      verdictWord: rect(badge.querySelector('.badge-verdict') as Element),
      controls: [...root.querySelectorAll('.bar button, .bar select, .bar .counter, .bar .badge')].map((c) => ({
        name: (c as HTMLElement).dataset.control ?? c.className,
        rect: rect(c),
        tag: c.tagName,
      })),
      verdict: badge.dataset.verdict ?? '',
      text: badge.textContent ?? '',
      overflows: badge.scrollWidth > badge.clientWidth,
    };
  }, width);
}

/**
 * The badge's text as Chromium's accessibility tree holds it: the StaticText nodes under the
 * badge's status node, joined in order. A screen reader announces this, not textContent. The tree
 * is built from laid-out text, so a space the stylesheet collapses is missing here even though
 * textContent still has it.
 */
async function badgeAxText(page: Page, width: number): Promise<string> {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { result } = await cdp.send('Runtime.evaluate', {
      expression: `document.querySelector('[data-badge-width="${width}"] fabrico-board').shadowRoot.querySelector('.bar .badge')`,
    });
    expect(result.objectId, `${width} px: the badge element resolves over CDP`).toBeTruthy();
    const { nodes } = await cdp.send('Accessibility.queryAXTree', { objectId: result.objectId, role: 'StaticText' });
    return nodes.map((n) => String(n.name?.value ?? '')).join('');
  } finally {
    await cdp.detach();
  }
}

test('the order-dependent badge and every control stay inside the bar at 288, 328, 340 and 360 px', async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const errors = watchPageErrors(page);
  const consoleErrors = recordConsoleErrors(page);
  const { url, pin } = pageWithMovedPin(testInfo.outputPath('badge-width.html'));
  await autoContinueCaptions(page);
  await page.goto(url);
  for (const w of BADGE_WIDTHS) {
    await expect.poll(async () => (await readBadge(page, w)).state, { timeout: 20_000 }).toBe('running');
    await page.locator(`[data-badge-width="${w}"] fabrico-board`).locator('select').selectOption({ label: '4x' });
  }
  for (const w of BADGE_WIDTHS) {
    await expect
      .poll(async () => {
        const r = await readBadge(page, w);
        return r.tick === r.endTick;
      }, { timeout: 30_000 })
      .toBe(true);
    await page.locator(`[data-badge-width="${w}"] fabrico-board`).scrollIntoViewIfNeeded();
    const read = await readBadge(page, w);
    const at = `${w} px at the end tick`;
    console.log(
      `${at}: bar ${Math.round(read.bar.left)} to ${Math.round(read.bar.right)}, badge ${Math.round(read.badge.left)} to ${Math.round(read.badge.right)}, ${Math.round(read.badge.height)} px tall`,
    );
    // The widest text is what this case is for, so a badge that reads anything else proves nothing.
    expect(read.verdict, `${at}: the reversed run ends off the moved pin`).toBe('order-dependent');
    // The run itself ended where it always does. The probe reads textContent.
    const words = `final state ${pin.slice(0, 8)} order-dependent`;
    expect(read.text, `${at}: the badge's textContent`).toBe(words);
    // Wrapping is visual only: what a screen reader hears keeps a space between the hash and the
    // verdict, on one line and wrapped.
    expect(await badgeAxText(page, w), `${at}: the badge's text in the accessibility tree`).toBe(words);
    // Inside the bar, not only inside the frame's outer edge: a badge that runs into the frame's
    // padding sits against the bezel ring.
    expect(read.badge.left, `${at}: the badge starts inside the bar`).toBeGreaterThanOrEqual(read.bar.left);
    expect(read.badge.right, `${at}: the badge ends inside the bar`).toBeLessThanOrEqual(read.bar.right);
    expect(read.badge.height, `${at}: the badge is at least 44 px tall`).toBeGreaterThanOrEqual(44);
    expect(read.overflows, `${at}: the badge's words fit in its box`).toBe(false);
    for (const [part, r] of [
      ['hash', read.hash],
      ['verdict', read.verdictWord],
    ] as const) {
      expect(r.left, `${at}: the ${part} starts inside the badge`).toBeGreaterThanOrEqual(read.badge.left);
      expect(r.right, `${at}: the ${part} ends inside the badge`).toBeLessThanOrEqual(read.badge.right);
    }
    if (read.verdictWord.top >= read.hash.bottom) {
      // Wrapped: the verdict starts its own line flush with the hash, with no leading space.
      expect(Math.abs(read.verdictWord.left - read.hash.left), `${at}: the wrapped verdict lines up with the hash`).toBeLessThanOrEqual(1);
    }
    for (const c of read.controls) {
      expect(c.rect.left, `${at}: ${c.name} starts inside the bar`).toBeGreaterThanOrEqual(read.bar.left);
      expect(c.rect.right, `${at}: ${c.name} ends inside the bar`).toBeLessThanOrEqual(read.bar.right);
      if (c.tag === 'BUTTON' || c.tag === 'SELECT') {
        expect(c.rect.width, `${at}: ${c.name} is at least 44 px wide`).toBeGreaterThanOrEqual(44);
        expect(c.rect.height, `${at}: ${c.name} is at least 44 px tall`).toBeGreaterThanOrEqual(44);
      }
    }
  }
  errors.assertNone('on the badge width page');
  expect(consoleErrors).toEqual([]);
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
