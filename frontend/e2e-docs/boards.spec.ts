import { expect, test } from '@playwright/test';
import {
  autoContinueCaptions,
  expectBoardDrawingAt,
  installGlCounter,
  manifestLine,
  readProbeAt,
  recordConsoleErrors,
  watchPageErrors,
} from '../e2e-embed/support/health.ts';
import { boardNames, docsRoot, fetchText, sitemapPages } from './support/site.ts';

// Every board on every page of the built docs site runs in Chromium: it mounts, it draws (its frame
// count rises and its belt pixels change), it reaches the end tick hashes.manifest pins, its end
// hash equals the manifest's, and its badge reads "match". The page logs no error while it runs.
//
// The pages come from the site's own sitemap, so a page added to the site is checked with no change
// here. One test per page that holds a board, plus one that fails when the site holds no board at
// all, so an empty sitemap can't pass by running nothing.

const pages: { url: string; boards: string[] }[] = [];
for (const url of await sitemapPages()) {
  const boards = boardNames(await fetchText(url));
  if (boards.length > 0) pages.push({ url, boards });
}

const pathOf = (url: string): string => url.slice(docsRoot().length - '/fabrico/'.length);

test('the site holds at least one board', () => {
  const total = pages.reduce((n, p) => n + p.boards.length, 0);
  expect(total, `boards across ${pages.length} pages`).toBeGreaterThanOrEqual(1);
});

for (const { url, boards } of pages) {
  test(`${pathOf(url)}: each board runs to its manifest hash and draws`, async ({ page }) => {
    test.setTimeout(60_000 + boards.length * 90_000);
    const errors = watchPageErrors(page);
    const consoleErrors = recordConsoleErrors(page);
    await installGlCounter(page);
    // A board stops at each caption it has; press Continue at once, as a reader would.
    await autoContinueCaptions(page);

    await page.goto(url);
    // Tag each board with its place on the page, so two boards of one name stay apart.
    const count = await page.evaluate(() => {
      const all = document.querySelectorAll('fabrico-board');
      all.forEach((el, i) => el.setAttribute('data-docs-board', String(i)));
      return all.length;
    });
    expect(count, `${pathOf(url)}: boards in the page`).toBe(boards.length);

    for (const [i, id] of boards.entries()) {
      const selector = `fabrico-board[data-docs-board="${i}"]`;
      const label = `${pathOf(url)} board ${i + 1} (${id})`;
      // A board holds a renderer only within 200 px of the viewport.
      await page.locator(selector).scrollIntoViewIfNeeded();
      await expect
        .poll(async () => (await readProbeAt(page, selector)).mounted, { message: `${label} mounts`, timeout: 20_000 })
        .toBe(true);
      await expectBoardDrawingAt(page, selector, 'while it plays', label);

      const expected = manifestLine(id);
      await expect
        .poll(async () => (await readProbeAt(page, selector)).tick, {
          message: `${label} reaches tick ${expected.endTick}`,
          timeout: 60_000,
          intervals: [500],
        })
        .toBe(expected.endTick);
      const end = await readProbeAt(page, selector);
      console.log(`${label}: end tick ${end.endTick}, hash ${end.endHash}, frames ${end.frames}, verdict ${end.verdict}`);
      expect(end.endHash, `${label} at tick ${expected.endTick}: the end hash`).toBe(expected.hash);
      expect(end.verdict, `${label}: the badge's verdict`).toBe('match');
      expect(end.decodeErrors, `${label}: refused render packets`).toBe(0);
    }

    errors.assertNone(`on ${pathOf(url)}`);
    expect(consoleErrors, `${pathOf(url)}: console errors`).toEqual([]);
  });
}
