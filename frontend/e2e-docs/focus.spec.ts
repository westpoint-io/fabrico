import { expect, test, type Page } from '@playwright/test';
import { docsUrl, fixturesUrl } from './support/site.ts';

// Keyboard focus on the Get started page, at 1280 px. The first Tab from the top lands on Skip to
// content, and Enter on it moves the keyboard into the main content. Tabbing on reaches a sidebar
// link, the search button and a pagination link, each drawn with the site's 2 px focus outline in the
// accent colour, and reaches the demo board's Play button inside the board's shadow root.
//
// On the fixture build's Reference index, Tab reaches the closed "Commands and files" subgroup
// summary with the same outline, Enter opens it, and the next Tab reaches the link inside it.

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

test('Tab reaches a closed Reference subgroup with the focus outline, Enter opens it, and the next Tab reaches its link', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(fixturesUrl('reference/'));
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  const focus = (): Promise<{ summary: string | null; open: boolean | null; href: string | null; visible: boolean; outline: string }> =>
    page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      const style = el === null ? null : getComputedStyle(el);
      const details = el?.tagName === 'SUMMARY' ? (el.parentElement as HTMLDetailsElement) : null;
      return {
        summary: el?.tagName === 'SUMMARY' ? (el.textContent ?? '').trim().replace(/\s+/g, ' ') : null,
        open: details === null ? null : details.open,
        href: el instanceof HTMLAnchorElement ? el.getAttribute('href') : null,
        visible: el?.matches(':focus-visible') ?? false,
        outline: style === null ? '' : `${style.outlineWidth} ${style.outlineStyle} ${style.outlineColor}`,
      };
    });

  const seen: string[] = [];
  let reached = false;
  for (let i = 0; i < MAX_TABS && !reached; i++) {
    await page.keyboard.press('Tab');
    const stop = await focus();
    seen.push(stop.summary ?? stop.href ?? '?');
    reached = stop.summary === 'Commands and files';
  }
  expect(reached, `the Commands and files summary within ${MAX_TABS} presses; stops seen:\n${seen.join('\n')}`).toBe(true);
  const summary = await focus();
  expect(summary.open, 'the Commands and files subgroup starts closed on the Reference index').toBe(false);
  expect(summary.visible, 'the summary matches :focus-visible').toBe(true);
  expect(summary.outline, 'the summary outline').toBe('2px solid rgb(79, 168, 255)');

  await page.keyboard.press('Enter');
  expect((await focus()).open, 'the subgroup after Enter').toBe(true);
  await page.keyboard.press('Tab');
  const link = await focus();
  expect(link.href ?? '', 'the next Tab after opening the subgroup lands on its link').toContain('/reference/files/_fixture-long-title/');
});
