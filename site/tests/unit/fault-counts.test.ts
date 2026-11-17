// A page can say how many FAULT rows its failure board's effect log shows at the end tick, as
// `faults: <n>` in its frontmatter. Board.astro writes that number only on a board with faultsAbout,
// and the docs suite compares it with the log only there. So a page that sets faults and has no board
// with faultsAbout would state a count nothing checks. This test reads every page under
// src/content/docs/ (except test pages whose name starts with _) and fails, naming each one, when it
// sets faults and none of its boards has faultsAbout.
// Run with `npm run test:unit` in site/.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const SITE = path.resolve(import.meta.dirname, '../..');
const DOCS = path.join(SITE, 'src/content/docs');

/** Every .mdx file under src/content/docs/, as paths relative to it, skipping test pages whose name starts with `_`. */
function pages(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.mdx') && !entry.name.startsWith('_')) out.push(path.relative(DOCS, full).split(path.sep).join('/'));
    }
  };
  walk(DOCS);
  return out.sort();
}

/** A page's `faults` value as written in its frontmatter, or null when it doesn't set one, and its body. */
function readPage(rel: string): { faults: string | null; body: string } {
  const text = fs.readFileSync(path.join(DOCS, rel), 'utf8');
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (match === null) return { faults: null, body: text };
  const line = /^faults:\s*(.*)$/m.exec(match[1]);
  return { faults: line === null ? null : line[1].trim(), body: match[2] };
}

/** True when some `<Board ...>` tag in the body has a faultsAbout attribute. */
const hasFaultsAboutBoard = (body: string): boolean => /<Board\b[^>]*\bfaultsAbout=/.test(body);

test('a page that sets faults in its frontmatter has a board with faultsAbout', () => {
  const all = pages();
  const counted = all.filter((rel) => readPage(rel).faults !== null);
  // At least one page states a count today, so a reader that never finds the field can't pass by
  // checking nothing.
  assert.ok(counted.length >= 1, `fault-counts: no page under site/src/content/docs/ sets faults in its frontmatter, among ${all.length} pages. Did the reader or the field name change?`);
  const problems = counted
    .filter((rel) => !hasFaultsAboutBoard(readPage(rel).body))
    .map(
      (rel) =>
        `site/src/content/docs/${rel} sets faults: ${readPage(rel).faults} in its frontmatter, and none of its boards has faultsAbout. Only a board that faults on purpose can state a fault count.`,
    );
  assert.equal(problems.length, 0, `\n${problems.join('\n')}\n`);
});
