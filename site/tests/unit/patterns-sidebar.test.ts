// The Patterns sidebar lists its pages in closed subgroups that src/lib/pattern-groups.mjs names by
// slug, so a page left out of that list never shows in the sidebar, and a slug with no page leaves a
// broken entry. This test reads the list and the pages under src/content/docs/patterns/ (except
// index.mdx and test pages whose name starts with _), and fails, naming each page or subgroup, when:
// - a pattern page sits in no subgroup, or in more than one;
// - a subgroup lists a slug with no page;
// - the subgroup labels differ from the h2 headings of patterns/index.mdx, or come in another order.
// Run with `npm run test:unit` in site/.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { PATTERN_GROUPS } from '../../src/lib/pattern-groups.mjs';

const SITE = path.resolve(import.meta.dirname, '../..');
const DOCS = path.join(SITE, 'src/content/docs');
const PATTERNS = path.join(DOCS, 'patterns');

const groups = PATTERN_GROUPS as [string, string[]][];

/** Every pattern page slug, sorted, leaving out index.mdx and test pages whose name starts with _. */
function patternSlugs(): string[] {
  return fs
    .readdirSync(PATTERNS)
    .filter((name) => /\.mdx?$/.test(name) && name !== 'index.mdx' && !name.startsWith('_'))
    .map((name) => name.replace(/\.mdx?$/, ''))
    .sort();
}

/** The `## ` headings of patterns/index.mdx a reader sees, in page order, skipping fenced code and MDX comments. */
function indexHeadings(): string[] {
  const text = fs.readFileSync(path.join(PATTERNS, 'index.mdx'), 'utf8').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
  const headings: string[] = [];
  let fenced = false;
  for (const line of text.split('\n')) {
    if (/^\s*(`{3,}|~{3,})/.test(line)) fenced = !fenced;
    else if (!fenced && line.startsWith('## ')) headings.push(line.slice(3).trim());
  }
  return headings;
}

test('each pattern page sits in exactly one Patterns subgroup', () => {
  const slugs = patternSlugs();
  assert.ok(slugs.length > 0, 'patterns-sidebar: found no pattern pages under site/src/content/docs/patterns/. Did the folder move?');
  const problems: string[] = [];
  for (const slug of slugs) {
    // A slug listed twice in one subgroup counts twice, so it fails like one listed in two.
    const k = groups.reduce((n, [, listed]) => n + listed.filter((s) => s === slug).length, 0);
    if (k === 0) {
      problems.push(`site/astro.config.mjs: patterns/${slug} is in no Patterns subgroup. Add it to the subgroup whose index heading it sits under.`);
    } else if (k > 1) {
      problems.push(`site/astro.config.mjs: patterns/${slug} is in ${k} Patterns subgroups. A page belongs to one.`);
    }
  }
  assert.equal(problems.length, 0, `\n${problems.join('\n')}\n`);
});

test('each slug a Patterns subgroup lists has a page', () => {
  const slugs = new Set(patternSlugs());
  const problems: string[] = [];
  for (const [label, listed] of groups) {
    for (const slug of listed) {
      if (!slugs.has(slug)) {
        problems.push(`site/astro.config.mjs: the Patterns subgroup "${label}" lists patterns/${slug}, and there is no such page.`);
      }
    }
  }
  assert.equal(problems.length, 0, `\n${problems.join('\n')}\n`);
});

test('the Patterns subgroup labels equal the h2 headings of the Patterns index page, in order', () => {
  const labels = groups.map(([label]) => label);
  const headings = indexHeadings();
  assert.deepEqual(
    labels,
    headings,
    `site/astro.config.mjs: the Patterns subgroups are ${JSON.stringify(labels)} (site/src/lib/pattern-groups.mjs), and the h2 headings of site/src/content/docs/patterns/index.mdx are ${JSON.stringify(headings)}. Give each subgroup the label of the index heading its pages sit under, in the same order.`,
  );
});
