import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { JSDOM } from 'jsdom';
import { PUBLISHED_ROOT } from './support/site.ts';

// Every internal link in the built site resolves. This spec reads site/dist/ from disk, with no
// browser and no server, and parses each HTML file with jsdom. It collects every href, src and
// srcset URL on a, link, script, img and source elements and checks each one that stays on the
// site:
//
// - A URL on another origin, a mailto:, tel: or data: URL is skipped. External links are never
//   fetched; the suite runs offline.
// - https://westpoint-io.github.io/fabrico/... (the published address, used by canonical links)
//   is checked as /fabrico/....
// - A path under /fabrico/ or a relative path must name a file in site/dist/. x, x/ and
//   x/index.html name the same page.
// - A #fragment must match an element id on the target page (or the same page) exactly.
// - Any other path starting with / is broken. The site is served under /fabrico/, so a markdown
//   link written /get-started/ builds without the base and 404s once published.
//
// Every broken link is reported in one failure, with its page and its href.

const REPO = path.resolve(import.meta.dirname, '../..');
const DIST = path.join(REPO, 'site/dist');
const BASE = '/fabrico/';
/** A stand-in origin for resolving relative links the way a browser would. */
const ORIGIN = 'http://docs.invalid';

/** The fewest internal links a real build holds. */
const MIN_LINKS = 30;

/** Every HTML file under the build folder, as paths relative to it, sorted. */
function htmlFiles(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && entry.name.endsWith('.html')) out.push(path.relative(root, full).split(path.sep).join('/'));
    }
  };
  visit(root);
  return out.sort();
}

/** The address a built file is served at: `x/index.html` at /fabrico/x/, `404.html` at /fabrico/404.html. */
function urlOf(file: string): string {
  if (file === 'index.html') return `${ORIGIN}${BASE}`;
  if (file.endsWith('/index.html')) return `${ORIGIN}${BASE}${file.slice(0, -'index.html'.length)}`;
  return `${ORIGIN}${BASE}${file}`;
}

/**
 * The file under the build folder a path below /fabrico/ names, or null when there is none. x, x/
 * and x/index.html name the same page. Astro writes the 404 route as 404.html, the name static hosts
 * serve for a missing page, so 404 and 404/ name that file (the 404 page's canonical link is /404/).
 */
function fileFor(rel: string): string | null {
  const isFile = (p: string): boolean => fs.existsSync(path.join(DIST, p)) && fs.statSync(path.join(DIST, p)).isFile();
  const bare = rel.replace(/\/+$/, '');
  const candidates =
    bare === '' ? ['index.html'] : rel.endsWith('/') ? [`${bare}/index.html`] : [bare, `${bare}/index.html`];
  if (bare === '404') candidates.push('404.html');
  return candidates.find(isFile) ?? null;
}

const idCache = new Map<string, Set<string>>();

/** The element ids of a built HTML file. */
function idsOf(file: string): Set<string> {
  let ids = idCache.get(file);
  if (ids === undefined) {
    const dom = new JSDOM(fs.readFileSync(path.join(DIST, file), 'utf8'));
    ids = new Set([...dom.window.document.querySelectorAll('[id]')].map((el) => el.id));
    dom.window.close();
    idCache.set(file, ids);
  }
  return ids;
}

/** Every link URL a page carries, as written: href, src and each srcset candidate. */
function linksOf(document: Document): string[] {
  const out: string[] = [];
  for (const el of document.querySelectorAll('a[href], link[href]')) out.push(el.getAttribute('href') ?? '');
  for (const el of document.querySelectorAll('script[src], img[src], source[src]')) out.push(el.getAttribute('src') ?? '');
  for (const el of document.querySelectorAll('img[srcset], source[srcset]')) {
    for (const candidate of (el.getAttribute('srcset') ?? '').split(',')) {
      const url = candidate.trim().split(/\s+/)[0];
      if (url !== undefined && url !== '') out.push(url);
    }
  }
  return out;
}

test('every internal link and fragment in the built site resolves', () => {
  const pages = htmlFiles(DIST);
  expect(pages.length, `HTML files under ${DIST}`).toBeGreaterThanOrEqual(8);

  const broken: string[] = [];
  let checked = 0;
  let skipped = 0;
  for (const page of pages) {
    const dom = new JSDOM(fs.readFileSync(path.join(DIST, page), 'utf8'));
    const hrefs = linksOf(dom.window.document);
    dom.window.close();
    for (const href of hrefs) {
      const where = `site/dist/${page}: ${href}`;
      if (/^(mailto|tel|data):/i.test(href)) {
        skipped += 1;
        continue;
      }
      let url: URL;
      try {
        url = new URL(href.startsWith(PUBLISHED_ROOT) ? href.slice(PUBLISHED_ROOT.length - BASE.length) : href, urlOf(page));
      } catch {
        broken.push(`${where} (not a URL)`);
        continue;
      }
      if (url.origin !== ORIGIN) {
        skipped += 1;
        continue;
      }
      checked += 1;
      if (!url.pathname.startsWith(BASE)) {
        broken.push(`${where} (outside ${BASE}, so it misses the site's base path)`);
        continue;
      }
      let rel: string;
      try {
        rel = decodeURIComponent(url.pathname.slice(BASE.length));
      } catch {
        broken.push(`${where} (a path that doesn't decode)`);
        continue;
      }
      const target = fileFor(rel);
      if (target === null) {
        broken.push(`${where} (no file in site/dist/ for ${url.pathname})`);
        continue;
      }
      if (url.hash !== '' && url.hash !== '#') {
        if (!target.endsWith('.html')) {
          broken.push(`${where} (a fragment on ${target}, which is not a page)`);
          continue;
        }
        const id = decodeURIComponent(url.hash.slice(1));
        if (!idsOf(target).has(id)) broken.push(`${where} (no element with id "${id}" on site/dist/${target})`);
      }
    }
  }

  console.log(`LINKS pages=${pages.length} internal=${checked} skipped=${skipped} broken=${broken.length}`);
  expect(broken, `${broken.length} broken internal link(s):\n${broken.join('\n')}`).toEqual([]);
  expect(checked, 'internal links checked').toBeGreaterThanOrEqual(MIN_LINKS);
});
