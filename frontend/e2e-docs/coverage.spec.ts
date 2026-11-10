import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { distFileFor } from './support/site.ts';

// Section coverage. site/coverage-manifest.json lists, for each of the site's six sections in
// sidebar order, the source pages that section must have. This spec checks the manifest against the
// sidebar in site/astro.config.mjs and against the built site in site/dist/: every listed page must
// have been built. A section that adds a page to its list and forgets the page fails here.
//
// The manifest and the config are read from disk at run time, never imported: a docs-only change
// doesn't run the frontend's type check, so the suite must not depend on site/ files at compile time.

const REPO = path.resolve(import.meta.dirname, '../..');
const MANIFEST = path.join(REPO, 'site/coverage-manifest.json');
const CONFIG = path.join(REPO, 'site/astro.config.mjs');
const DIST = path.join(REPO, 'site/dist');
const SOURCE_ROOT = 'site/src/content/docs';

interface Section {
  name: string;
  folder: string;
  pages: string[];
}

/** The manifest's sections. Throws unless the file has schema 1 and a list of sections. */
function manifestSections(): Section[] {
  const raw: unknown = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  if (typeof raw !== 'object' || raw === null) throw new Error(`${MANIFEST} is not a JSON object`);
  const { schema, sections } = raw as { schema?: unknown; sections?: unknown };
  if (schema !== 1) throw new Error(`${MANIFEST} has schema ${String(schema)}, and this spec reads schema 1`);
  if (!Array.isArray(sections)) throw new Error(`${MANIFEST} has no sections list`);
  return sections.map((s: unknown, i: number) => {
    const { name, folder, pages } = (s ?? {}) as { name?: unknown; folder?: unknown; pages?: unknown };
    if (typeof name !== 'string' || typeof folder !== 'string' || !Array.isArray(pages) || !pages.every((p) => typeof p === 'string')) {
      throw new Error(`section ${i + 1} of ${MANIFEST} needs a string name, a string folder and a list of page paths`);
    }
    return { name, folder, pages: pages as string[] };
  });
}

/** The sidebar's groups as astro.config.mjs states them, `group('<label>', '<folder>')`, in order. */
function sidebarGroups(): { name: string; folder: string }[] {
  const config = fs.readFileSync(CONFIG, 'utf8');
  const block = /sidebar:\s*\[([\s\S]*?)\]/.exec(config);
  if (block === null) throw new Error(`${CONFIG} has no sidebar list`);
  const groups = [...block[1].matchAll(/group\('([^']+)',\s*'([^']+)'\)/g)].map((m) => ({ name: m[1], folder: m[2] }));
  if (groups.length !== 6) throw new Error(`read ${groups.length} sidebar groups from ${CONFIG}, not 6`);
  return groups;
}

test('the coverage manifest names the sidebar sections in order, each with at least one page in its folder', () => {
  const sections = manifestSections();
  expect(
    sections.map((s) => ({ name: s.name, folder: s.folder })),
    'the manifest sections and folders, in sidebar order',
  ).toEqual(sidebarGroups());
  for (const section of sections) {
    expect(section.pages.length, `section "${section.name}" lists at least one page`).toBeGreaterThanOrEqual(1);
    for (const page of section.pages) {
      expect(page.startsWith(`${section.folder}/`), `section "${section.name}" lists ${page}, outside its folder ${section.folder}/`).toBe(
        true,
      );
      expect(/\.mdx?$/.test(page), `section "${section.name}" lists ${page}, which is not a .md or .mdx page`).toBe(true);
    }
  }
});

test('every page the coverage manifest lists was built', () => {
  const missing: string[] = [];
  let checked = 0;
  for (const section of manifestSections()) {
    for (const page of section.pages) {
      checked += 1;
      if (!fs.existsSync(path.join(DIST, distFileFor(page)))) {
        missing.push(`Section "${section.name}" lists ${SOURCE_ROOT}/${page} in the coverage manifest, and the built site has no page there.`);
      }
    }
  }
  console.log(`COVERAGE pages=${checked} missing=${missing.length}`);
  expect(checked, 'pages the coverage manifest lists').toBeGreaterThanOrEqual(6);
  expect(missing, missing.join('\n')).toEqual([]);
});
