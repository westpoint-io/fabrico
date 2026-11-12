import { expect, test, type Page } from '@playwright/test';
import { docsUrl, sitemapPages } from './support/site.ts';

// The site's look comes from the app's locked skin. The build writes the app's --fab-* tokens into
// the page, and the site's theme maps Starlight's colours onto them, so the content ground, the
// header, the left sidebar and the body text each show a token's colour.
//
// On every published page, the text inside .sl-markdown-content keeps to the site's four sizes
// (12, 16, 18 and 24 px) and two weights (400 and 700), and code inside an h2 or h3 keeps its case.
// The pages come from the sitemap, so a new page joins the check with no change here.

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

// Dark only. The app's skin has no light palette, so a reader whose system asks for light still
// gets the dark theme, and there is no theme picker.

test.describe('with a light colour scheme requested', () => {
  test.use({ colorScheme: 'light' });

  test('the page is still dark and has no theme picker', async ({ page }) => {
    await page.goto(docsUrl('get-started/'));
    const state = await page.evaluate(() => ({
      theme: document.documentElement.dataset.theme,
      scheme: getComputedStyle(document.documentElement).colorScheme,
      prefersLight: matchMedia('(prefers-color-scheme: light)').matches,
      pickers: document.querySelectorAll('starlight-theme-select').length,
    }));
    expect(state.prefersLight, 'the browser reports a light colour scheme').toBe(true);
    expect(state.theme, '<html data-theme>').toBe('dark');
    expect(state.scheme, 'the root color-scheme').toBe('dark');
    expect(state.pickers, 'starlight-theme-select elements').toBe(0);
  });
});

/** The site's type scale: four sizes and two weights. */
const TYPE_SIZES = ['12px', '16px', '18px', '24px'];
const TYPE_WEIGHTS = ['400', '700'];

for (const url of await sitemapPages()) {
  const where = new URL(url).pathname;
  test(`${where} keeps to four type sizes and two weights, and heading code keeps its case`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(url);
    await page.evaluate(async () => {
      await document.fonts.ready;
    });
    const found = await page.evaluate(() => {
      const content = document.querySelector('.sl-markdown-content');
      if (content === null) return null;
      const texts: { tag: string; text: string; size: string; weight: string }[] = [];
      for (const el of [content, ...content.querySelectorAll('*')]) {
        const own = [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim() !== '');
        if (!own) continue;
        const style = getComputedStyle(el);
        texts.push({ tag: el.tagName.toLowerCase(), text: (el.textContent ?? '').trim().slice(0, 40), size: style.fontSize, weight: style.fontWeight });
      }
      const headingCode = [...content.querySelectorAll(':is(h2, h3) code')].map((el) => ({
        text: (el.textContent ?? '').trim().slice(0, 40),
        transform: getComputedStyle(el).textTransform,
      }));
      return { texts, headingCode };
    });
    expect(found, `${where} has a .sl-markdown-content block`).not.toBeNull();
    if (found === null) return;
    const sizes = [...new Set(found.texts.map((t) => t.size))].sort();
    const weights = [...new Set(found.texts.map((t) => t.weight))].sort();
    console.log(`TYPE_SCALE page=${where} sizes=${sizes.join(',')} weights=${weights.join(',')} headingCode=${found.headingCode.length}`);
    const offSize = found.texts.filter((t) => !TYPE_SIZES.includes(t.size)).map((t) => `<${t.tag}> "${t.text}" at ${t.size}`);
    const offWeight = found.texts.filter((t) => !TYPE_WEIGHTS.includes(t.weight)).map((t) => `<${t.tag}> "${t.text}" at ${t.weight}`);
    expect(offSize, `${where}: text outside the sizes ${TYPE_SIZES.join(', ')}`).toEqual([]);
    expect(offWeight, `${where}: text outside the weights ${TYPE_WEIGHTS.join(', ')}`).toEqual([]);
    const cased = found.headingCode.filter((c) => c.transform !== 'none').map((c) => `"${c.text}" has text-transform ${c.transform}`);
    expect(cased, `${where}: code in an h2 or h3 keeps its case`).toEqual([]);
  });
}
