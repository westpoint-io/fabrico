import { expect, test, type Page } from '@playwright/test';
import { recordRequests, watchPageErrors } from '../e2e-embed/support/health.ts';
import { boardNames, docsRoot, fetchText, fixturePage, sitemapPages } from './support/site.ts';

// What each page asks the network for. A page with no board never fetches the board script; a page
// with two boards fetches it once; and no published page asks any origin but its own for anything,
// so a reader's visit reaches no third party.
//
// The published pages come from the site's sitemap, and the two-board page from the fixture
// build's sitemap, so nothing here guesses a page address.

/** The path every page loads the board script from, under the site's base. */
const BUNDLE = '/embed/fabrico-board.js';

const published: { url: string; boards: number }[] = [];
for (const url of await sitemapPages()) published.push({ url, boards: boardNames(await fetchText(url)).length });

const withoutBoard = published.filter((p) => p.boards === 0);
const pathOf = (url: string): string => new URL(url).pathname;

/** Load a page and wait until its network has been quiet, so a late script request is counted. */
async function loadAndSettle(page: Page, url: string): Promise<string[]> {
  const requests = recordRequests(page);
  await page.goto(url);
  await page.waitForLoadState('networkidle');
  return requests;
}

const bundleRequests = (requests: string[]): string[] => requests.filter((r) => new URL(r).pathname.endsWith(BUNDLE));

/**
 * The `<script>` elements in the page that load the board script. Counting requests alone can't see
 * a second copy: Chromium serves a second script with the same address from its memory cache with no
 * new request, and the script itself skips defining <fabrico-board> when it is already defined, so
 * a page that adds the script twice makes one request and throws nothing.
 */
async function bundleScripts(page: Page): Promise<number> {
  return page.evaluate(
    (bundle) => [...document.querySelectorAll('script[src]')].filter((s) => new URL((s as HTMLScriptElement).src).pathname.endsWith(bundle)).length,
    BUNDLE,
  );
}

test('the site has published pages with no board to check', () => {
  expect(withoutBoard.length, 'published pages with no board').toBeGreaterThanOrEqual(1);
});

for (const { url } of withoutBoard) {
  test(`${pathOf(url)}: a page with no board doesn't fetch the board script`, async ({ page }) => {
    const requests = await loadAndSettle(page, url);
    expect(bundleRequests(requests), `${pathOf(url)}: requests for ${BUNDLE}`).toEqual([]);
    expect(await bundleScripts(page), `${pathOf(url)}: <script> elements loading ${BUNDLE}`).toBe(0);
  });
}

test('the two-board test page fetches the board script once', async ({ page }) => {
  const url = await fixturePage('_fixture-two-boards');
  const errors = watchPageErrors(page);
  const requests = await loadAndSettle(page, url);
  expect(await page.locator('fabrico-board').count(), `${pathOf(url)}: boards in the page`).toBe(2);
  expect(bundleRequests(requests), `${pathOf(url)}: requests for ${BUNDLE}`).toHaveLength(1);
  expect(await bundleScripts(page), `${pathOf(url)}: <script> elements loading ${BUNDLE}`).toBe(1);
  errors.assertNone(`on ${pathOf(url)}`);
});

for (const { url } of published) {
  test(`${pathOf(url)}: every request goes to the site's own origin`, async ({ page }) => {
    const origin = new URL(docsRoot()).origin;
    const requests = await loadAndSettle(page, url);
    expect(requests.length, `${pathOf(url)}: requests made`).toBeGreaterThan(0);
    const elsewhere = requests.filter((r) => new URL(r).origin !== origin);
    expect(elsewhere, `${pathOf(url)}: requests to an origin other than ${origin}`).toEqual([]);
  });
}
