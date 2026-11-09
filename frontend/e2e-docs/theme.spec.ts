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

// The app's two faces: Martian Mono for body text, Sono for the page title. Both are served from the
// site's own /fabrico/fonts/ and preloaded from the page head.

test('body text is 16 px Martian Mono at line height 1.7, and the face has loaded', async ({ page }) => {
  await page.goto(docsUrl('get-started/'));
  await page.evaluate(() => document.fonts.ready);
  const body = await page.evaluate(() => {
    const p = getComputedStyle(document.querySelector('main .sl-markdown-content p') as Element);
    return {
      family: getComputedStyle(document.body).fontFamily,
      size: p.fontSize,
      lineHeight: p.lineHeight,
      loaded: document.fonts.check('16px "Martian Mono"'),
    };
  });
  expect(body.family, 'the body font-family').toMatch(/^"?Martian Mono"?,/);
  expect(body.size, 'a paragraph font size').toBe('16px');
  expect(body.lineHeight, 'a paragraph line height, 16 px x 1.7').toBe('27.2px');
  expect(body.loaded, 'document.fonts.check for 16px Martian Mono').toBe(true);
});

for (const width of [360, 1440]) {
  test(`the page title is 24 px Sono in caps at ${width} px wide`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(docsUrl('get-started/'));
    await page.evaluate(() => document.fonts.ready);
    const h1 = await page.evaluate(() => {
      const s = getComputedStyle(document.querySelector('h1#_top') as Element);
      return {
        family: s.fontFamily,
        transform: s.textTransform,
        size: s.fontSize,
        spacing: s.letterSpacing,
        weight: s.fontWeight,
        loaded: document.fonts.check('700 24px "Sono"'),
      };
    });
    expect(h1.family, 'the h1 font-family').toMatch(/^"?Sono"?,/);
    expect(h1.transform, 'the h1 text-transform').toBe('uppercase');
    expect(h1.size, 'the h1 font size').toBe('24px');
    expect(h1.spacing, 'the h1 letter spacing').toBe('0.5px');
    expect(h1.weight, 'the h1 weight').toBe('700');
    expect(h1.loaded, 'document.fonts.check for 700 24px Sono').toBe(true);
  });
}

test('the head preloads both fonts from /fabrico/fonts/, and both answer 200', async ({ page, request }) => {
  await page.goto(docsUrl('get-started/'));
  const hrefs = await page.evaluate(() =>
    [...document.querySelectorAll('link[rel="preload"][as="font"]')].map((l) => l.getAttribute('href') ?? ''),
  );
  expect(hrefs, 'the preloaded font hrefs').toEqual(['/fabrico/fonts/MartianMono.woff2', '/fabrico/fonts/Sono.woff2']);
  for (const href of hrefs) {
    const response = await request.get(new URL(href, docsUrl('')).href);
    expect(response.status(), `${href} status`).toBe(200);
    expect(response.headers()['content-type'] ?? '', `${href} content type`).toContain('font/woff2');
  }
});

test('the header shows the brand icon at 32 px beside the word Fabrico, and the favicon is served', async ({
  page,
  request,
}) => {
  await page.goto(docsUrl('get-started/'));
  const title = page.locator('header a.site-title');
  const icon = title.locator('img');
  await expect(icon).toBeVisible();
  const img = await icon.evaluate((el) => {
    const i = el as HTMLImageElement;
    const r = i.getBoundingClientRect();
    return { complete: i.complete, natural: i.naturalWidth, width: r.width, height: r.height };
  });
  expect(img.complete && img.natural > 0, 'the header icon loaded').toBe(true);
  expect([img.width, img.height], 'the header icon size').toEqual([32, 32]);
  await expect(title, 'the site title text').toContainText('Fabrico');

  const favicon = await page.evaluate(() => document.querySelector('link[rel="shortcut icon"], link[rel="icon"]')?.getAttribute('href'));
  expect(favicon, 'the favicon link').toBe('/fabrico/favicon.svg');
  expect((await request.get(new URL('/fabrico/favicon.svg', docsUrl('')).href)).status(), 'the favicon status').toBe(200);
});
