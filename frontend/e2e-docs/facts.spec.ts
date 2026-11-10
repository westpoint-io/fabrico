import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { docsUrl, sitemapPages } from './support/site.ts';

// Values from the code on built pages. Every element with data-fact on every published page must
// name a fact that site/src/generated/facts.json holds, and its text must be that fact's value in
// the form <Fact> renders it. So a page can't show a fact the file doesn't have, and a stale page
// build next to a regenerated file fails here.
//
// facts.json is read from disk at run time, not imported, so this suite doesn't depend on site/
// source at compile time.

const FACTS_FILE = path.resolve(import.meta.dirname, '../../site/src/generated/facts.json');

type Fact =
  | { kind: 'quantity'; value: number; unit: string; source: string }
  | { kind: 'code' | 'text'; value: string; source: string }
  | { kind: 'shortcut'; label: string; labelMac: string; source: string };

type Found = { id: string; text: string; title: string; tag: string; bare: boolean; kbd: string[] };

function readFacts(): Record<string, Fact> {
  const parsed = JSON.parse(fs.readFileSync(FACTS_FILE, 'utf8')) as { facts?: Record<string, Fact> };
  if (parsed.facts === undefined) throw new Error(`${FACTS_FILE} has no "facts" object`);
  return parsed.facts;
}

/** The text a reader should see for a fact. */
function expectedText(fact: Fact, bare: boolean): string {
  switch (fact.kind) {
    case 'quantity': {
      const number = fact.value.toLocaleString('en-US');
      return bare ? number : `${number} ${fact.unit}`;
    }
    case 'code':
    case 'text':
      return fact.value;
    case 'shortcut':
      return fact.labelMac === fact.label ? fact.label : `${fact.label} (${fact.labelMac} on macOS)`;
  }
}

/** The keys a shortcut renders, one <kbd> each, in order: "Ctrl+S (Cmd+S on macOS)" is Ctrl, S, Cmd, S. */
function expectedKeys(fact: Fact & { kind: 'shortcut' }): string[] {
  const keys = (label: string): string[] => label.split(' or ').flatMap((group) => group.split('+'));
  return fact.labelMac === fact.label ? keys(fact.label) : [...keys(fact.label), ...keys(fact.labelMac)];
}

test('every fact on every published page matches facts.json', async ({ page }) => {
  const facts = readFacts();
  const pages = await sitemapPages();
  expect(pages.length, 'pages in the sitemap').toBeGreaterThan(0);
  let seen = 0;
  for (const url of pages) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    const found: Found[] = await page.locator('[data-fact]').evaluateAll((els) =>
      els.map((el) => ({
        id: el.getAttribute('data-fact') ?? '',
        text: (el.textContent ?? '').replace(/\s+/g, ' ').trim(),
        title: el.getAttribute('title') ?? '',
        tag: el.tagName.toLowerCase(),
        bare: el.classList.contains('fab-fact-bare'),
        kbd: [...el.querySelectorAll('kbd')].map((k) => k.textContent ?? ''),
      })),
    );
    for (const f of found) {
      const where = `${new URL(url).pathname}: data-fact="${f.id}"`;
      const fact = facts[f.id];
      expect(fact, `${where} names a fact facts.json doesn't hold`).toBeDefined();
      expect(f.text, `${where}: its text`).toBe(expectedText(fact, f.bare));
      expect(f.title, `${where}: its title`).toBe(`Generated from ${fact.source}`);
      if (fact.kind === 'code' || fact.kind === 'text') expect(f.tag, `${where}: its element`).toBe('code');
      if (fact.kind === 'quantity') expect(f.tag, `${where}: its element`).toBe('span');
      if (fact.kind === 'shortcut') expect(f.kbd, `${where}: its <kbd> keys`).toEqual(expectedKeys(fact));
      seen += 1;
    }
  }
  expect(seen, 'fact elements across the published pages').toBeGreaterThanOrEqual(2);
});

test('the Reference page shows the board tick rate and the play/pause shortcut', async ({ page }) => {
  const facts = readFacts();
  await page.goto(docsUrl('reference/'), { waitUntil: 'domcontentloaded' });
  const all = page.locator('main [data-fact]');
  expect(await all.count(), 'fact elements on /fabrico/reference/').toBeGreaterThanOrEqual(2);

  const rate = page.locator('main span.fab-fact[data-fact="embed.ticks_per_second"]');
  await expect(rate).toHaveCount(1);
  await expect(rate).toHaveText(expectedText(facts['embed.ticks_per_second'], false));
  await expect(rate).toHaveAttribute('title', 'Generated from frontend/src/embed/controller.ts');

  const playPause = page.locator('main [data-fact="shortcut.playPause"] kbd');
  await expect(playPause).toHaveText(['Space']);
});
