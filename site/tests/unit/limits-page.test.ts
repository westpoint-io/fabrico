// The Limits page has to list every limit in the facts file. This test reads facts.json and
// limits.mdx from disk and fails, naming each one, when a limit.* fact has no <Fact> on the page.
// Run with `npm run test:unit` in site/.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const FACTS = path.resolve(import.meta.dirname, '../../src/generated/facts.json');
const PAGE = path.resolve(import.meta.dirname, '../../src/content/docs/reference/board/limits.mdx');

/** The fewest limits the facts file held when this test was written. A smaller count means the exporter lost some. */
const MIN_LIMITS = 25;

/** Every limit.* id in facts.json, sorted. */
function limitIds(): string[] {
  const file = JSON.parse(fs.readFileSync(FACTS, 'utf8')) as { facts: Record<string, unknown> };
  return Object.keys(file.facts)
    .filter((id) => id.startsWith('limit.'))
    .sort();
}

/** The limit.* ids the page cites through <Fact id="...">. */
function citedIds(mdx: string): Set<string> {
  const cited = new Set<string>();
  for (const match of mdx.matchAll(/<Fact\s+id="(limit\.[^"]+)"/g)) cited.add(match[1]);
  return cited;
}

test(`facts.json holds at least ${MIN_LIMITS} limits`, () => {
  const ids = limitIds();
  assert.ok(ids.length >= MIN_LIMITS, `site/src/generated/facts.json has ${ids.length} limit.* facts, fewer than ${MIN_LIMITS}`);
});

test('the Limits page cites every limit in facts.json', () => {
  const cited = citedIds(fs.readFileSync(PAGE, 'utf8'));
  const missing = limitIds().filter((id) => !cited.has(id));
  assert.deepEqual(
    missing,
    [],
    `site/src/content/docs/reference/board/limits.mdx has no <Fact id="..."> for ${missing.length} limit(s): ${missing.join(', ')}`,
  );
});

test('the Limits page cites no limit that facts.json lacks', () => {
  const known = new Set(limitIds());
  const unknown = [...citedIds(fs.readFileSync(PAGE, 'utf8'))].filter((id) => !known.has(id));
  assert.deepEqual(unknown, [], `limits.mdx cites limit ids facts.json doesn't have: ${unknown.join(', ')}`);
});
