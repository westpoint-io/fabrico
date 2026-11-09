import { expect, test } from '@playwright/test';
import { docsUrl } from './support/site.ts';

// The site's six sections. The sidebar on the root page lists six groups in a fixed order, each
// group holds a link to its section's first page, and every group renders expanded. A page with no
// h2 lists only "Overview" in its table of contents.

/** The six sections, in sidebar order: the group label and the folder under src/content/docs/. */
const SECTIONS: readonly { label: string; dir: string }[] = [
  { label: 'Get started', dir: 'get-started' },
  { label: 'Concepts', dir: 'concepts' },
  { label: 'Reference', dir: 'reference' },
  { label: 'Patterns', dir: 'patterns' },
  { label: 'Troubleshooting', dir: 'troubleshooting' },
  { label: 'Contributing', dir: 'contributing' },
];

/** One sidebar group as the root page renders it. */
interface Group {
  label: string;
  open: boolean;
  links: string[];
}

test('the sidebar lists the six sections in order, each expanded with its page', async ({ page }) => {
  await page.goto(docsUrl(''));
  const groups: Group[] = await page.evaluate(() =>
    [...document.querySelectorAll('#starlight__sidebar ul.top-level > li > details')].map((d) => ({
      label: d.querySelector(':scope > summary .group-label')?.textContent?.trim() ?? '',
      open: (d as HTMLDetailsElement).open,
      links: [...d.querySelectorAll('a[href]')].map((a) => (a as HTMLAnchorElement).href),
    })),
  );

  expect(
    groups.map((g) => g.label),
    'the sidebar group labels, in order',
  ).toEqual(SECTIONS.map((s) => s.label));
  for (const [i, { label, dir }] of SECTIONS.entries()) {
    expect(groups[i].open, `the ${label} group renders expanded`).toBe(true);
    expect(groups[i].links, `the ${label} group links to its page`).toContain(docsUrl(`${dir}/`));
  }
});

test('the root page has one card per section, linking to its page', async ({ page }) => {
  await page.goto(docsUrl(''));
  const cards = await page.evaluate(() =>
    [...document.querySelectorAll('main a[href]')]
      .filter((a) => a.closest('.sl-link-card') !== null)
      .map((a) => (a as HTMLAnchorElement).href),
  );
  expect(cards, 'the cards on the root page, in order').toEqual(SECTIONS.map((s) => docsUrl(`${s.dir}/`)));
});

test('a page with no h2 lists only Overview in its table of contents', async ({ page }) => {
  await page.goto(docsUrl('concepts/'));
  const entries = await page.evaluate(() =>
    [...document.querySelectorAll('starlight-toc nav li a')].map((a) => a.textContent?.trim() ?? ''),
  );
  expect(entries, 'the Concepts page table of contents').toEqual(['Overview']);
});
