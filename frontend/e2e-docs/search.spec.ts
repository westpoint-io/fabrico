import { expect, test } from '@playwright/test';
import { docsUrl } from './support/site.ts';

// Search on the built site: Starlight's dialog over the Pagefind index the build writes. A reader
// opens it from the header, types at once, and gets the Get started page for "board"; a word no
// page holds gets the site's own no-results copy. A sub-result (a heading inside a page) reads 12 px
// regular under its 16 px bold page result.

const noResults = (term: string): string =>
  `No pages match "${term}". Try a machine name such as Router or Factory, or a fault reason.`;

test('search finds the Get started page and says plainly when nothing matches', async ({ page }) => {
  await page.goto(docsUrl('get-started/'));
  await page.locator('site-search button[data-open-modal]').click();
  const dialog = page.locator('dialog[aria-label="Search"]');
  await expect(dialog, 'the search dialog opens').toBeVisible();

  // Type into whatever has focus, straight away: the input must take keys as soon as it opens.
  await page.keyboard.type('board');
  const input = dialog.locator('input.pagefind-ui__search-input');
  await expect(input, 'the search input holds what was typed').toHaveValue('board');
  await expect
    .poll(
      async () =>
        dialog.locator('a.pagefind-ui__result-link').evaluateAll((links) => links.map((a) => (a as HTMLAnchorElement).href)),
      { message: 'a result for "board" links to the Get started page', timeout: 10_000 },
    )
    .toContain(docsUrl('get-started/'));

  await input.fill('');
  await input.pressSequentially('zzqxjv');
  await expect(dialog.locator('.pagefind-ui__message'), 'the no-results copy').toHaveText(noResults('zzqxjv'), {
    timeout: 10_000,
  });
});

test('search sub-results are 12 px regular under 16 px bold page results', async ({ page }) => {
  await page.goto(docsUrl('get-started/'));
  await page.locator('site-search button[data-open-modal]').click();
  const dialog = page.locator('dialog[aria-label="Search"]');
  await expect(dialog, 'the search dialog opens').toBeVisible();
  await page.keyboard.type('board');
  const nested = dialog.locator('.pagefind-ui__result-nested .pagefind-ui__result-link').first();
  await expect(nested, 'a sub-result for "board"').toBeVisible({ timeout: 10_000 });
  const style = (el: Element): { size: string; weight: string } => ({ size: getComputedStyle(el).fontSize, weight: getComputedStyle(el).fontWeight });
  expect(await nested.evaluate(style), 'the first sub-result link').toEqual({ size: '12px', weight: '400' });
  const pageLink = dialog.locator('.pagefind-ui__result-link:not(.pagefind-ui__result-nested *)').first();
  expect(await pageLink.evaluate(style), 'the first page result link').toEqual({ size: '16px', weight: '700' });
});
