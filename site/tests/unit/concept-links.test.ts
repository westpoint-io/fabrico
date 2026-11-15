// Every concept page needs at least one link from a page a reader looks things up on, so someone on
// a reference or troubleshooting page can reach the idea behind a rule. This test reads the
// Concepts section's pages from the coverage manifest, collects every link on every page under
// reference/ and troubleshooting/, resolves each one against its source page's published URL, and
// fails, naming each concept page, when no page links to it.
// Run with `npm run test:unit` in site/.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const SITE = path.resolve(import.meta.dirname, '../..');
const DOCS = path.join(SITE, 'src/content/docs');
const MANIFEST = path.join(SITE, 'coverage-manifest.json');

/** The site's base path; links that start with it are taken as written. */
const BASE = '/fabrico/';

/** The folders whose pages count as "the reference side". */
const LINKING_FOLDERS = ['reference', 'troubleshooting'];

/** The Concepts section held 11 pages when this test was written. Fewer means the manifest lost some. */
const MIN_CONCEPT_PAGES = 11;

/** The published URL of a page, from its path under src/content/docs/: `a/b.mdx` is `/fabrico/a/b/`, `a/index.mdx` is `/fabrico/a/`. */
function publishedUrl(relPath: string): string {
  const noExt = relPath.replace(/\.mdx?$/, '');
  const route = noExt === 'index' ? '' : noExt.endsWith('/index') ? noExt.slice(0, -'/index'.length) : noExt;
  return route === '' ? BASE : `${BASE}${route}/`;
}

/** Every .md and .mdx file under a folder, as paths relative to src/content/docs/, skipping test pages whose name starts with `_`. */
function pagesUnder(folder: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.mdx?$/.test(entry.name) && !entry.name.startsWith('_')) out.push(path.relative(DOCS, full).split(path.sep).join('/'));
    }
  };
  walk(path.join(DOCS, folder));
  return out.sort();
}

/** The link targets on a page: Markdown links `[text](target)` and `href="target"` attributes. */
function linkTargets(mdx: string): string[] {
  const targets: string[] = [];
  for (const m of mdx.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) targets.push(m[1]);
  for (const m of mdx.matchAll(/href=["']([^"']+)["']/g)) targets.push(m[1]);
  return targets;
}

/** A link target resolved to a site URL with a trailing slash and no fragment, or null for external and fragment-only links. */
function resolveTarget(target: string, fromUrl: string): string | null {
  const bare = target.split('#')[0].split('?')[0];
  if (bare === '' || /^[a-z][a-z0-9+.-]*:/i.test(bare)) return null;
  const resolved = bare.startsWith('/') ? path.posix.normalize(bare) : path.posix.join(fromUrl, bare);
  return resolved.endsWith('/') ? resolved : `${resolved}/`;
}

/** The Concepts section's pages from the coverage manifest, as paths relative to src/content/docs/. */
function conceptPages(): string[] {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) as { sections: { name: string; pages: string[] }[] };
  const section = manifest.sections.find((s) => s.name === 'Concepts');
  assert.ok(section, 'site/coverage-manifest.json has no section named "Concepts"');
  return section.pages;
}

/** Each site URL that some reference or troubleshooting page links to, with the pages that link it. */
function inboundLinks(): Map<string, string[]> {
  const inbound = new Map<string, string[]>();
  for (const folder of LINKING_FOLDERS) {
    for (const page of pagesUnder(folder)) {
      const from = publishedUrl(page);
      for (const target of linkTargets(fs.readFileSync(path.join(DOCS, page), 'utf8'))) {
        const url = resolveTarget(target, from);
        if (url === null) continue;
        const list = inbound.get(url) ?? [];
        if (!list.includes(page)) list.push(page);
        inbound.set(url, list);
      }
    }
  }
  return inbound;
}

test(`the coverage manifest lists at least ${MIN_CONCEPT_PAGES} concept pages`, () => {
  const pages = conceptPages();
  assert.ok(pages.length >= MIN_CONCEPT_PAGES, `the Concepts section lists ${pages.length} pages, fewer than ${MIN_CONCEPT_PAGES}`);
});

test('the URL resolver maps relative and /fabrico/ links the way the built site does', () => {
  assert.equal(publishedUrl('reference/board/ports.mdx'), '/fabrico/reference/board/ports/');
  assert.equal(publishedUrl('concepts/index.mdx'), '/fabrico/concepts/');
  assert.equal(resolveTarget('../../../concepts/ticks/#a-tick', '/fabrico/reference/board/ports/'), '/fabrico/concepts/ticks/');
  assert.equal(resolveTarget('../../concepts/', '/fabrico/troubleshooting/common-problems/'), '/fabrico/concepts/');
  assert.equal(resolveTarget('/fabrico/concepts/backpressure', '/fabrico/reference/'), '/fabrico/concepts/backpressure/');
  assert.equal(resolveTarget('https://example.com/concepts/', '/fabrico/reference/'), null);
  assert.equal(resolveTarget('#term-belt', '/fabrico/reference/files/glossary/'), null);
});

test('every concept page has a link from a reference or troubleshooting page', () => {
  const inbound = inboundLinks();
  const unlinked = conceptPages()
    .filter((page) => !inbound.has(publishedUrl(page)))
    .map((page) => `${page} (${publishedUrl(page)}) has no link from any page under reference/ or troubleshooting/`);
  assert.deepEqual(unlinked, [], `${unlinked.length} concept page(s) have no inbound link:\n${unlinked.join('\n')}`);
});
