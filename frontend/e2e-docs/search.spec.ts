import { expect, test } from '@playwright/test';
import { docsUrl } from './support/site.ts';

// Search on the built site: Starlight's dialog over the Pagefind index the build writes. A reader
// opens it from the header, types at once, and gets the Get started page for "board"; a word no
// page holds gets the site's own no-results copy.

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
