import { expect, test, type Page } from '@playwright/test';
import { docsUrl } from './support/site.ts';

// Keyboard focus on the Get started page, at 1280 px. The first Tab from the top lands on Skip to
// content, and Enter on it moves the keyboard into the main content. Tabbing on reaches a sidebar
// link, the search button and a pagination link, each drawn with the site's 2 px focus outline in the
// accent colour, and reaches the demo board's Play button inside the board's shadow root.

const URL_PATH = 'get-started/';
/** Tab presses allowed before a part counts as unreachable. The page has about 30 tab stops. */
const MAX_TABS = 80;

/** What the keyboard is on: the focused element, followed into shadow roots. */
interface Stop {
  kind: 'skip' | 'search' | 'sidebar' | 'pagination' | 'play' | 'board' | 'main' | 'other';
  label: string;
  focusVisible: boolean;
  outline: { style: string; width: string; colour: string };
}

async function open(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(docsUrl(URL_PATH));
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
}

/** The colour of --fab-focus as the browser computes it (`rgb(r, g, b)`). */
async function focusColour(page: Page): Promise<string> {
  return page.evaluate(() => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--fab-focus)';
    document.body.append(probe);
    const colour = getComputedStyle(probe).color;
    probe.remove();
    return colour;
  });
}

async function currentStop(page: Page): Promise<Stop> {
  return page.evaluate(() => {
    let el = document.activeElement;
    // The outermost element holding the focus in the page's own tree, before any shadow root.
    const host = el;
    let inBoard = false;
    while (el?.shadowRoot?.activeElement) {
      if (el.tagName === 'FABRICO-BOARD') inBoard = true;
      el = el.shadowRoot.activeElement;
    }
    if (el === null || el === document.body) {
      return { kind: 'other', label: 'body', focusVisible: false, outline: { style: '', width: '', colour: '' } } as const;
    }
    const style = getComputedStyle(el);
    // closest() stops at a shadow root, so ask the page-level host.
    const has = (selector: string): boolean => host?.closest(selector) != null;
    let kind: Stop['kind'] = 'other';
    if (el.matches('.sl-skip-link')) kind = 'skip';
    else if (el.matches('site-search button[data-open-modal]')) kind = 'search';
    else if (el.tagName === 'A' && has('#starlight__sidebar')) kind = 'sidebar';
    else if (el.tagName === 'A' && has('.pagination-links')) kind = 'pagination';
    else if (inBoard && el.matches('[data-control="play"]')) kind = 'play';
    else if (inBoard) kind = 'board';
    else if (has('main')) kind = 'main';
    return {
      kind,
      label: `${el.tagName.toLowerCase()} "${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40)}"`,
      focusVisible: el.matches(':focus-visible'),
      outline: { style: style.outlineStyle, width: style.outlineWidth, colour: style.outlineColor },
    };
  }) as Promise<Stop>;
}

test('the first Tab focuses Skip to content, and Enter moves the keyboard into the main content', async ({ page }) => {
  await open(page);
  await page.keyboard.press('Tab');
  const first = await currentStop(page);
  expect(first.kind, `the first tab stop is ${first.label}`).toBe('skip');
  expect(first.label, 'the skip link text').toBe('a "Skip to content"');

  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => location.hash), 'the address after Enter').toBe('#_top');
  // A followed fragment link moves the point Tab starts from to its target, the page title.
  await page.keyboard.press('Tab');
  const next = await currentStop(page);
  expect(next.kind, `the tab stop after the skip link is ${next.label}`).toMatch(/^(main|board|play)$/);
  expect(await page.evaluate(() => document.activeElement?.closest('main') != null), 'the focused element is inside <main>').toBe(true);
});

test('Tab reaches a sidebar link, the search button, a pagination link and the board Play button, each with the focus outline', async ({ page }) => {
  await open(page);
  // The board's controls exist once its element has upgraded and mounted.
  await page.waitForFunction(() => document.querySelector('fabrico-board')?.shadowRoot?.querySelector('[data-control="play"]') != null, undefined, { timeout: 20_000 });
  await page.evaluate(() => window.scrollTo(0, 0));
  const colour = await focusColour(page);

  const firstOf = new Map<Stop['kind'], Stop>();
  const seen: string[] = [];
  for (let i = 0; i < MAX_TABS; i++) {
    await page.keyboard.press('Tab');
    const stop = await currentStop(page);
    seen.push(`${stop.kind}: ${stop.label}`);
    if (!firstOf.has(stop.kind)) firstOf.set(stop.kind, stop);
    if (firstOf.has('search') && firstOf.has('sidebar') && firstOf.has('pagination') && firstOf.has('play')) break;
  }

  for (const kind of ['sidebar', 'search', 'pagination'] as const) {
    const stop = firstOf.get(kind);
    expect(stop, `a ${kind} tab stop within ${MAX_TABS} presses; stops seen:\n${seen.join('\n')}`).toBeDefined();
    expect(stop!.focusVisible, `${kind} ${stop!.label}: matches :focus-visible`).toBe(true);
    expect(stop!.outline, `${kind} ${stop!.label}: its outline`).toEqual({ style: 'solid', width: '2px', colour });
  }
  expect(firstOf.get('play'), `the board's Play button within ${MAX_TABS} presses; stops seen:\n${seen.join('\n')}`).toBeDefined();
});
