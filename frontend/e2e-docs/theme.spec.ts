import { expect, test, type Page } from '@playwright/test';
import { docsUrl } from './support/site.ts';

// The site's look comes from the app's locked skin. The build writes the app's --fab-* tokens into
// the page, and the site's theme maps Starlight's colours onto them, so the content ground, the
// header, the left sidebar and the body text each show a token's colour.

/** A custom property declared on :root, resolved to a computed colour through a probe element. */
async function tokenColour(page: Page, token: string): Promise<string> {
  return page.evaluate((name) => {
    const declared = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    if (declared === '') throw new Error(`:root declares no ${name}`);
    const probe = document.createElement('div');
    probe.style.color = `var(${name})`;
    document.body.append(probe);
    const colour = getComputedStyle(probe).color;
    probe.remove();
    return colour;
  }, token);
}

/** The background a reader sees behind an element: its own, or the first ancestor's that isn't transparent. */
async function groundOf(page: Page, selector: string): Promise<string> {
  return page.evaluate((sel) => {
    let el: Element | null = document.querySelector(sel);
    if (el === null) throw new Error(`no element matches ${sel}`);
    while (el !== null) {
      const bg = getComputedStyle(el).backgroundColor;
      if (bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') return bg;
      el = el.parentElement;
    }
    return 'transparent';
  }, selector);
}

test('the ground, the header, the sidebar and the text take their colours from the skin tokens', async ({ page }) => {
  await page.goto(docsUrl('get-started/'));
  const substrate = await tokenColour(page, '--fab-substrate');
  const panel = await tokenColour(page, '--fab-panel-fill');
  const ink = await tokenColour(page, '--fab-ink');
  expect(new Set([substrate, panel, ink]).size, 'the three tokens are three different colours').toBe(3);

  expect(await groundOf(page, 'main .sl-markdown-content'), 'the content ground').toBe(substrate);
  expect(await groundOf(page, '.page > .header'), 'the header background').toBe(panel);
  expect(await groundOf(page, '#starlight__sidebar'), 'the left sidebar background').toBe(panel);

  const text = await page.evaluate(() => ({
    body: getComputedStyle(document.body).color,
    paragraph: getComputedStyle(document.querySelector('main .sl-markdown-content p') as Element).color,
  }));
  expect(text.body, 'the body text colour').toBe(ink);
  expect(text.paragraph, 'a paragraph in the page body').toBe(ink);
});
