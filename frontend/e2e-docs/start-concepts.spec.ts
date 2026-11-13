import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { distFileFor, docsUrl } from './support/site.ts';

// The Get started and Concepts pages put a running board beside each idea. Three checks:
//
// - Every Concepts page the coverage manifest lists, plus What is Fabrico, Your first factory and
//   Send your first webhook, is built and holds at least one board slot. A page the manifest lists
//   that hasn't been written yet fails here by name, so the check can't pass on a short section.
// - On What is Fabrico and each Concepts page with a board, the first board starts inside the first
//   screen at 1440 x 900. Your first factory and Send your first webhook are left out on purpose:
//   their layouts put each board after the Steps list it illustrates.
// - On Determinism and replay, the board playing same-tick events in file order sits directly above
//   the same board playing them in reverse, 16 px apart, so the two read as one exhibit. Both end
//   hashes are boards.spec.ts's job, which checks every board, either order, against the manifest.
//
// The manifest is read from disk at run time, never imported, as coverage.spec.ts does.

const REPO = path.resolve(import.meta.dirname, '../..');
const MANIFEST = path.join(REPO, 'site/coverage-manifest.json');
const DIST = path.join(REPO, 'site/dist');

/** The three Get started pages that must hold a board, as paths under site/src/content/docs/. */
const START_PAGES = ['get-started/index.mdx', 'get-started/first-factory.mdx', 'get-started/first-webhook.mdx'] as const;
/** The page holding the run-it-twice pair, by its path under /fabrico/. */
const PAIR_PAGE = 'concepts/determinism-and-replay/';
const VIEWPORT = { width: 1440, height: 900 } as const;

/** The pages the coverage manifest lists for the Concepts section. Throws on a manifest it can't read. */
function conceptPages(): string[] {
  const raw = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) as { sections?: { name?: unknown; pages?: unknown }[] };
  const section = (raw.sections ?? []).find((s) => s.name === 'Concepts');
  if (section === undefined || !Array.isArray(section.pages) || !section.pages.every((p) => typeof p === 'string')) {
    throw new Error(`${MANIFEST} has no Concepts section with a list of pages`);
  }
  return section.pages as string[];
}

/** The built HTML of a source page, or null when the build has no page there. */
function builtHtml(sourcePage: string): string | null {
  const file = path.join(DIST, distFileFor(sourcePage));
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

/** The URL path under /fabrico/ a source page is published at: `concepts/ticks.mdx` is `concepts/ticks/`. */
function urlPathOf(sourcePage: string): string {
  return distFileFor(sourcePage).replace(/index\.html$/, '');
}

const hasSlot = (html: string): boolean => /class="fab-board-slot\b/.test(html);

test('a running board beside each idea: every Concepts page and What is Fabrico, Your first factory and Send your first webhook hold a board', () => {
  const pages = [...conceptPages(), ...START_PAGES];
  const problems: string[] = [];
  for (const page of pages) {
    const html = builtHtml(page);
    if (html === null) problems.push(`site/src/content/docs/${page} isn't built: the site has no page at /fabrico/${urlPathOf(page)}.`);
    else if (!hasSlot(html)) problems.push(`/fabrico/${urlPathOf(page)} holds no <Board>, and each page here puts a running board beside its idea.`);
  }
  console.log(`BOARD_BESIDE pages=${pages.length} problems=${problems.length}`);
  expect(pages.length, 'pages checked').toBeGreaterThanOrEqual(4);
  expect(problems, problems.join('\n')).toEqual([]);
});

test('on What is Fabrico and each Concepts page, the first board starts inside the first screen at 1440 x 900', async ({ page }) => {
  const pages = ['get-started/index.mdx', ...conceptPages()].filter((p) => {
    const html = builtHtml(p);
    return html !== null && hasSlot(html);
  });
  expect(pages.length, 'pages with a board to check').toBeGreaterThanOrEqual(1);
  await page.setViewportSize(VIEWPORT);
  const late: string[] = [];
  for (const source of pages) {
    await page.goto(docsUrl(urlPathOf(source)));
    await page.evaluate(async () => {
      await document.fonts.ready;
    });
    const top = await page.evaluate(() => {
      const slot = document.querySelector('.fab-board-slot');
      return slot === null ? null : slot.getBoundingClientRect().top + window.scrollY;
    });
    console.log(`FIRST_BOARD page=/fabrico/${urlPathOf(source)} top=${top}`);
    if (top === null || top >= VIEWPORT.height) {
      late.push(`/fabrico/${urlPathOf(source)}: the first board starts ${top} px from the top, outside the first ${VIEWPORT.height} px screen.`);
    }
  }
  expect(late, late.join('\n')).toEqual([]);
});

test('Determinism and replay: the forward board sits directly above the reversed board with a 16 px gap', async ({ page }) => {
  const response = await page.request.get(docsUrl(PAIR_PAGE));
  expect(response.status(), `/fabrico/${PAIR_PAGE} answers 200`).toBe(200);
  await page.setViewportSize(VIEWPORT);
  await page.goto(docsUrl(PAIR_PAGE));
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  const pair = await page.evaluate(() => {
    const slots = [...document.querySelectorAll('.fab-board-slot')];
    const forward = slots.find((s) => s.querySelector(':scope > fabrico-board[order="forward"]') !== null);
    if (forward === undefined) return { found: 'no slot holds a board with order="forward"' } as const;
    const next = forward.nextElementSibling;
    if (next === null || !next.matches('.fab-board-slot') || next.querySelector(':scope > fabrico-board[order="reversed"]') === null) {
      return {
        found: `the element after the forward board is ${next === null ? 'nothing' : `<${next.tagName.toLowerCase()} class="${next.className}">`}, not a slot holding order="reversed"`,
      } as const;
    }
    return { found: 'pair', gap: next.getBoundingClientRect().top - forward.getBoundingClientRect().bottom } as const;
  });
  expect(pair.found, `/fabrico/${PAIR_PAGE}: the forward board is directly followed by the reversed board`).toBe('pair');
  const gap = pair.found === 'pair' ? pair.gap : NaN;
  console.log(`PAIR_GAP page=/fabrico/${PAIR_PAGE} gap=${gap}`);
  expect(Math.abs(gap - 16), `the gap between the two boards is 16 px within 1 (it is ${gap})`).toBeLessThanOrEqual(1);
});
