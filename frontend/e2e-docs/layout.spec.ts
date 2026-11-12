import { expect, test, type Page } from '@playwright/test';
import { docsUrl, fixturePage, fixturePages, sitemapPages } from './support/site.ts';

// The page frame at the widths readers use. No page scrolls sideways at 360, 768, 1280 or 1440 px;
// the demo board fills the content column; a 60-character title wraps in the h1 and in the sidebar;
// a code line and a table wider than the column each scroll inside their own focusable box; the
// left sidebar scrolls on its own; its six groups start open and the four Reference subgroups start
// closed, except the one holding the current page; and code tokens take the skin's colours.
//
// The published pages come from the site's sitemap and the test pages from the fixture build's
// sitemap, so nothing here guesses a page address.

const WIDTHS = [360, 768, 1280, 1440] as const;
const HEIGHT = 900;

const pages = [...(await sitemapPages()), ...(await fixturePages())];
const longTitle = await fixturePage('_fixture-long-title');
const LONG_TITLE = 'A long page title to check that headings and links wrap well';

const pathOf = (url: string): string => new URL(url).pathname;

/** Open a page at a width and wait for its fonts, so text has its final size before measuring. */
async function open(page: Page, url: string, width: number): Promise<void> {
  await page.setViewportSize({ width, height: HEIGHT });
  await page.goto(url);
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
}

/** The computed colour of a token, as the browser writes it (`rgb(r, g, b)`). */
async function tokenColour(page: Page, token: string): Promise<string> {
  return page.evaluate((name) => {
    const probe = document.createElement('span');
    probe.style.color = `var(${name})`;
    document.body.append(probe);
    const colour = getComputedStyle(probe).color;
    probe.remove();
    return colour;
  }, token);
}

for (const url of pages) {
  test(`${pathOf(url)}: no sideways scroll at ${WIDTHS.join(', ')} px`, async ({ page }) => {
    for (const width of WIDTHS) {
      await open(page, url, width);
      const { scrollWidth, innerWidth } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      }));
      expect(scrollWidth, `${pathOf(url)} at ${width} px: page width against the window's ${innerWidth} px`).toBeLessThanOrEqual(innerWidth);
    }
  });
}

test('the demo board on Get started is as wide as the content column', async ({ page }) => {
  for (const width of WIDTHS) {
    await open(page, docsUrl('get-started/'), width);
    await page.waitForFunction(() => document.querySelector('fabrico-board')?.shadowRoot != null);
    const { board, column } = await page.evaluate(() => ({
      board: document.querySelector('fabrico-board')!.getBoundingClientRect().width,
      column: document.querySelector('.sl-markdown-content')!.getBoundingClientRect().width,
    }));
    expect(Math.abs(board - column), `at ${width} px: board ${board} px against column ${column} px`).toBeLessThanOrEqual(1);
  }
});

test('at 360 px the 60-character page title wraps to at most four lines, unclipped', async ({ page }) => {
  await open(page, longTitle, 360);
  const h1 = await page.evaluate(() => {
    const el = document.querySelector('h1#_top') as HTMLElement;
    const style = getComputedStyle(el);
    return {
      text: el.textContent?.trim() ?? '',
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      height: el.getBoundingClientRect().height,
      lineHeight: parseFloat(style.lineHeight),
    };
  });
  expect(h1.text, 'the h1 text').toBe(LONG_TITLE);
  expect(h1.text.length, 'the title length').toBe(60);
  expect(h1.scrollWidth, 'the h1 content width against its box').toBeLessThanOrEqual(h1.clientWidth);
  expect(h1.lineHeight, 'the h1 line height in px').toBeGreaterThan(0);
  expect(h1.height, `the h1 height against four lines of ${h1.lineHeight} px`).toBeLessThanOrEqual(4 * h1.lineHeight + 1);
});

test('at 1280 px the long title wraps inside the sidebar', async ({ page }, testInfo) => {
  await open(page, longTitle, 1280);
  const link = page.locator('#starlight__sidebar a', { hasText: LONG_TITLE });
  await expect(link, 'the sidebar link to the long-title page').toHaveCount(1);
  await link.scrollIntoViewIfNeeded();
  const box = await link.evaluate((a) => {
    const sidebar = a.closest('.sidebar-pane') as HTMLElement;
    const range = document.createRange();
    range.selectNodeContents(a);
    // One rectangle per line box of the text; tops that differ are separate lines.
    const lines = new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size;
    const l = a.getBoundingClientRect();
    const s = sidebar.getBoundingClientRect();
    return { lines, left: l.left, right: l.right, sidebarLeft: s.left, sidebarRight: s.right, sidebarWidth: s.width };
  });
  await testInfo.attach('sidebar at 1280 px', { body: await page.locator('.sidebar-pane').screenshot(), contentType: 'image/png' });
  expect(box.sidebarWidth, 'the sidebar width').toBeCloseTo(300, 0);
  expect(box.left, 'the link left edge against the sidebar').toBeGreaterThanOrEqual(box.sidebarLeft);
  expect(box.right, 'the link right edge against the sidebar').toBeLessThanOrEqual(box.sidebarRight);
  expect(box.lines, 'lines the link text takes').toBeGreaterThan(1);
});

test('a wide code block and a wide table scroll in their own focusable box', async ({ page }) => {
  await open(page, longTitle, 1280);
  const focus = await tokenColour(page, '--fab-focus');
  const boxes = { 'the code block': page.locator('.sl-markdown-content .expressive-code pre'), 'the table': page.locator('.sl-markdown-content table') };
  for (const [name, box] of Object.entries(boxes)) {
    await expect(box, `${name} on the page`).toHaveCount(1);
    // Expressive Code adds tabindex to an overflowing code block from its own script, at idle.
    await expect(box, `${name}: tabindex`).toHaveAttribute('tabindex', '0');
    const sizes = await box.evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, tabIndex: (el as HTMLElement).tabIndex }));
    expect(sizes.scrollWidth, `${name}: content width against its box`).toBeGreaterThan(sizes.clientWidth);
    expect(sizes.tabIndex, `${name}: tabIndex`).toBe(0);
    await box.focus();
    const outline = await box.evaluate((el) => {
      const style = getComputedStyle(el);
      return { visible: el.matches(':focus-visible'), style: style.outlineStyle, width: style.outlineWidth, offset: style.outlineOffset, colour: style.outlineColor };
    });
    expect(outline.visible, `${name}: matches :focus-visible once focused`).toBe(true);
    expect(outline, `${name}: its outline when focused`).toEqual({ visible: true, style: 'solid', width: '2px', offset: '-2px', colour: focus });
  }
  const page_ = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
  expect(page_.scrollWidth, 'the page width with both wide boxes on it').toBeLessThanOrEqual(page_.innerWidth);
});

/** The Reference group's four subgroups, in sidebar order. */
const SUBGROUPS = ['Machines', 'Board and engine', 'Code and HTTP', 'Commands and files'];

/** The sidebar's top-level groups and the subgroups inside Reference, with whether each is open. */
async function sidebarGroups(page: Page): Promise<{ top: { label: string; open: boolean }[]; sub: { label: string; open: boolean }[] }> {
  return page.evaluate(() => {
    const label = (d: Element): string => d.querySelector(':scope > summary .group-label')?.textContent?.trim() ?? '';
    const tops = [...document.querySelectorAll('#starlight__sidebar ul.top-level > li > details')];
    const reference = tops.find((d) => label(d) === 'Reference');
    return {
      top: tops.map((d) => ({ label: label(d), open: (d as HTMLDetailsElement).open })),
      sub: [...(reference?.querySelectorAll(':scope > ul details') ?? [])].map((d) => ({ label: label(d), open: (d as HTMLDetailsElement).open })),
    };
  });
}

test('the left sidebar scrolls on its own under the header', async ({ page }) => {
  await open(page, longTitle, 1280);
  const sidebar = await page.evaluate(() => {
    const pane = document.querySelector('.sidebar-pane') as HTMLElement;
    const header = document.querySelector('.page > .header') as HTMLElement;
    const style = getComputedStyle(pane);
    return {
      overflowY: style.overflowY,
      position: style.position,
      top: pane.getBoundingClientRect().top,
      headerBottom: header.getBoundingClientRect().bottom,
    };
  });
  expect(['auto', 'scroll'], 'the sidebar overflow-y').toContain(sidebar.overflowY);
  expect(sidebar.position, 'the sidebar position').toBe('fixed');
  expect(sidebar.top, 'the sidebar top against the header bottom').toBeGreaterThanOrEqual(sidebar.headerBottom - 1);
});

test('the six sidebar groups start open and the four Reference subgroups start closed', async ({ page }) => {
  await open(page, docsUrl(''), 1280);
  const { top, sub } = await sidebarGroups(page);
  expect(top.length, 'top-level sidebar groups').toBe(6);
  expect(top.filter((g) => !g.open).map((g) => g.label), 'top-level groups rendered closed').toEqual([]);
  expect(sub, 'the Reference subgroups on the root page, in order, all closed').toEqual(SUBGROUPS.map((label) => ({ label, open: false })));
});

test('on a page inside a Reference subgroup, that subgroup is open and the other three are closed', async ({ page }) => {
  await open(page, longTitle, 1280);
  const { top, sub } = await sidebarGroups(page);
  expect(top.filter((g) => !g.open).map((g) => g.label), 'top-level groups rendered closed').toEqual([]);
  expect(sub, 'the Reference subgroups on the long-title page, which lives in reference/files/').toEqual(
    SUBGROUPS.map((label) => ({ label, open: label === 'Commands and files' })),
  );
});

test('code tokens take the skin colours: keywords blue, strings green, numbers amber', async ({ page }) => {
  await open(page, longTitle, 1280);
  const expected = {
    keyword: await tokenColour(page, '--fab-focus'),
    string: await tokenColour(page, '--fab-accent-working'),
    number: await tokenColour(page, '--fab-accent-item'),
  };
  const colourOf = (text: string): Promise<string[]> =>
    page.evaluate((t) => {
      const spans = [...document.querySelectorAll('.sl-markdown-content .expressive-code pre code span')];
      return spans.filter((s) => s.children.length === 0 && s.textContent?.trim() === t).map((s) => getComputedStyle(s).color);
    }, text);
  const found = {
    const: await colourOf('const'),
    return: await colourOf('return'),
    string: await colourOf("'this string makes the line wider than the content column of the page'"),
    number: await colourOf('1200'),
  };
  // A string token may be split into its quotes and its text; fall back to the text alone.
  if (found.string.length === 0) found.string = await colourOf('this string makes the line wider than the content column of the page');
  expect(found.const, 'the const keyword').toEqual([expected.keyword]);
  expect(found.return, 'the return keyword').toEqual([expected.keyword]);
  expect(found.string, 'the string').toEqual([expected.string]);
  expect(found.number, 'the number 1200').toEqual([expected.number]);
});

test('at 375 px the menu button keeps its dark ground and a 1 px border, and centres its glyph, closed and open', async ({ page }) => {
  await open(page, docsUrl('get-started/'), 375);
  const measure = (): Promise<{ ground: string; border: string; top: number; left: number }> =>
    page.evaluate(() => {
      const button = document.querySelector('.sl-menu-button') as HTMLElement;
      const glyph = [...button.querySelectorAll('svg')].find((svg) => getComputedStyle(svg).display !== 'none') as SVGElement;
      const b = button.getBoundingClientRect();
      const g = glyph.getBoundingClientRect();
      const style = getComputedStyle(button);
      return { ground: style.backgroundColor, border: style.borderTopWidth, top: g.top - b.top, left: g.left - b.left };
    });
  for (const state of ['closed', 'open'] as const) {
    if (state === 'open') await page.locator('.sl-menu-button').click();
    const m = await measure();
    expect(m.ground, `the menu button ground, menu ${state}`).toBe('rgb(27, 31, 39)');
    expect(m.border, `the menu button top border, menu ${state}`).toBe('1px');
    expect(Math.abs(m.top - 14), `the glyph's offset from the button top is 14 px (it is ${m.top}), menu ${state}`).toBeLessThanOrEqual(1);
    expect(Math.abs(m.left - 14), `the glyph's offset from the button left is 14 px (it is ${m.left}), menu ${state}`).toBeLessThanOrEqual(1);
  }
});
