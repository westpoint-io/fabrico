import { expect, test } from '@playwright/test';
import { autoContinueCaptions, readProbeAt, recordConsoleErrors, watchPageErrors } from '../e2e-embed/support/health.ts';
import { docsRoot, docsUrl, sitemapPages } from './support/site.ts';

// Every page loads clean. Each page the sitemap lists, plus the 404 page an unknown address gets,
// loads in Chromium with no uncaught page error and no console error, with every board on it
// mounted. watchPageErrors catches uncaught errors and the embed's failed packet lines;
// recordConsoleErrors catches a plain console.error, which watchPageErrors lets through.
//
// One test per page, sorted by path, so the listed count and the test names are the same on every
// run. A guard fails under 8 pages, so a sitemap that lost its pages can't pass by running nothing.

/** The fewest pages a real build holds: the sitemap's pages plus the 404 page. */
const MIN_PAGES = 8;

/** An address no page uses. The server answers it with the 404 page. */
const UNKNOWN = 'no-page-lives-here/';

const pathOf = (url: string): string => url.slice(docsRoot().length - '/fabrico/'.length);

const pages = [...(await sitemapPages()), docsUrl(UNKNOWN)].sort();

test(`the suite loads at least ${MIN_PAGES} pages`, () => {
  expect(pages.length, `pages listed: ${pages.map(pathOf).join(', ')}`).toBeGreaterThanOrEqual(MIN_PAGES);
});

for (const url of pages) {
  const unknown = url === docsUrl(UNKNOWN);
  const name = unknown ? `${pathOf(url)} (the 404 page)` : pathOf(url);
  test(`${name}: loads with no page error and no console error, its boards mounted`, async ({ page }) => {
    test.setTimeout(90_000);
    const errors = watchPageErrors(page);
    const consoleErrors = recordConsoleErrors(page);
    // The 404 status of the address itself, which Chromium logs as a console error. Only a line
    // whose source is the page's own address counts here, so a missing image or script still fails.
    const ownStatus: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error' && message.location().url === url && /status of 404/.test(message.text())) {
        ownStatus.push(message.text());
      }
    });
    await autoContinueCaptions(page);

    const response = await page.goto(url);
    if (unknown) {
      expect(response?.status(), `${name}: the server's status`).toBe(404);
      await expect(page.locator('h1'), `${name}: the 404 page's heading`).toHaveText('Page not found');
    } else {
      expect(response?.status(), `${name}: the server's status`).toBe(200);
    }

    const count = await page.evaluate(() => {
      const all = document.querySelectorAll('fabrico-board');
      all.forEach((el, i) => el.setAttribute('data-docs-page-board', String(i)));
      return all.length;
    });
    for (let i = 0; i < count; i += 1) {
      const selector = `fabrico-board[data-docs-page-board="${i}"]`;
      // A board holds a renderer only within 200 px of the viewport.
      await page.locator(selector).scrollIntoViewIfNeeded();
      await expect
        .poll(async () => (await readProbeAt(page, selector)).mounted, { message: `${name} board ${i + 1} mounts`, timeout: 20_000 })
        .toBe(true);
    }
    await page.waitForLoadState('networkidle');

    // An unknown address may log its own 404 status, once, and nothing else.
    const unexpected = [...consoleErrors];
    if (unknown && ownStatus.length <= 1) {
      for (const line of ownStatus) unexpected.splice(unexpected.indexOf(line), 1);
    }
    errors.assertNone(`on ${name}`);
    expect(unexpected, `${name}: console errors`).toEqual([]);
  });
}
