import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { autoContinueCaptions, readProbeAt } from '../e2e-embed/support/health.ts';
import { docsRoot, docsUrl, fixturePages, fixturesRoot, sitemapPages } from './support/site.ts';

// axe finds no accessibility violation on any built page. Each page the sitemap lists, the 404
// page, and each test page of the fixture build is scanned after every board on it has mounted, so
// the boards' shadow DOM is in the scan. One more scan runs on the Get started page with the search
// dialog open and "board" typed in, because the dialog is the one overlay the site adds.
//
// The tags are WCAG 2.0, 2.1 and 2.2 at levels A and AA, and no rule is switched off. A page that
// fails gets fixed, never the rule set.
//
// One test per page, sorted by path, so the listed count and the test names are the same on every run.

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

/** A page to scan: its URL and the name its test carries. */
interface Target {
  url: string;
  name: string;
}

const published: Target[] = [...(await sitemapPages()), docsUrl('404.html')].sort().map((url) => ({
  url,
  name: url.slice(docsRoot().length - '/fabrico/'.length),
}));
const fixtures: Target[] = (await fixturePages()).map((url) => ({
  url,
  name: `fixture ${url.slice(fixturesRoot().length - '/fabrico/'.length)}`,
}));

/** Scrolls each board on the page into view and waits for it to mount. */
async function mountBoards(page: Page, name: string): Promise<void> {
  const count = await page.evaluate(() => {
    const all = document.querySelectorAll('fabrico-board');
    all.forEach((el, i) => el.setAttribute('data-docs-axe-board', String(i)));
    return all.length;
  });
  for (let i = 0; i < count; i += 1) {
    const selector = `fabrico-board[data-docs-axe-board="${i}"]`;
    await page.locator(selector).scrollIntoViewIfNeeded();
    await expect
      .poll(async () => (await readProbeAt(page, selector)).mounted, { message: `${name} board ${i + 1} mounts`, timeout: 20_000 })
      .toBe(true);
  }
}

/**
 * Waits for the page's own scripts to settle. Expressive Code gives a code block that scrolls
 * sideways tabindex="0" from a resize observer, 250 ms after layout and then at idle, and the site's
 * table script does the same for a wide table. Scanning before that would report a box a reader can
 * reach with the keyboard. The wait gives up after 5 s and the scan still runs, so a box that never
 * becomes focusable fails on axe's own rule.
 */
async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await page
    .waitForFunction(
      () =>
        [...document.querySelectorAll('.sl-markdown-content pre, .sl-markdown-content table')].every(
          (el) => el.scrollWidth <= el.clientWidth || el.hasAttribute('tabindex'),
        ),
      undefined,
      { timeout: 5_000 },
    )
    .catch(() => undefined);
}

/** Runs axe over the whole page and fails with every violation's id, targets and summary. */
async function expectNoViolations(page: Page, name: string): Promise<void> {
  await settle(page);
  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const lines = results.violations.flatMap((v) =>
    v.nodes.map((node) => `${v.id} (${v.impact ?? 'no impact given'}) at ${node.target.join(' > ')}: ${node.failureSummary ?? v.help}`),
  );
  console.log(`AXE ${name} passes=${results.passes.length} violations=${results.violations.length}`);
  expect(lines, `${name}: axe violations\n${lines.join('\n')}`).toEqual([]);
}

test('the axe scan covers the published pages and the fixture pages', () => {
  expect(published.length, 'published pages scanned').toBeGreaterThanOrEqual(8);
  expect(fixtures.length, 'fixture pages scanned').toBeGreaterThanOrEqual(1);
});

for (const { url, name } of [...published, ...fixtures]) {
  test(`${name}: axe reports no violations`, async ({ page }) => {
    test.setTimeout(90_000);
    await autoContinueCaptions(page);
    await page.goto(url);
    await mountBoards(page, name);
    await expectNoViolations(page, name);
  });
}

test('/fabrico/get-started/ with the search dialog open: axe reports no violations', async ({ page }) => {
  test.setTimeout(90_000);
  const name = '/fabrico/get-started/ with search open';
  // No autoContinueCaptions here: its click on a board's Continue button bubbles to the window, and
  // the search dialog closes on any click outside itself. A reader typing a search makes no such click.
  await page.goto(docsUrl('get-started/'));
  await mountBoards(page, name);
  await page.locator('site-search button[data-open-modal]').click();
  const dialog = page.locator('dialog[aria-label="Search"]');
  await expect(dialog, 'the search dialog opens').toBeVisible();
  await page.keyboard.type('board');
  await expect(dialog.locator('a.pagefind-ui__result-link').first(), 'a result for "board"').toBeVisible({ timeout: 10_000 });
  await expectNoViolations(page, name);
});
