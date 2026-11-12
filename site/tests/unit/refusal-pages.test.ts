// The Refused edits page (troubleshooting) holds the fix for each refusal, and the Refusal messages
// page (reference) lists the same messages with a link to each fix. This test reads both MDX files
// from disk and fails when their h2 groups differ, when their refusal ids come in a different order,
// when either page holds fewer refusals than the facts file had when this test was written, or when
// a row's link points at an anchor other than its own refusal's.
// Run with `npm run test:unit` in site/.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fixAnchor } from '../../src/lib/facts.ts';

const DOCS = path.resolve(import.meta.dirname, '../../src/content/docs');
const FIXES = path.join(DOCS, 'troubleshooting/refusals.mdx');
const MESSAGES = path.join(DOCS, 'reference/files/refusal-messages.mdx');

/** The fewest refusals facts.json held when this test was written (38 from the host, 2 from the app). */
const MIN_REFUSALS = 40;

/** The text of each `## ` heading, in order. */
function h2s(mdx: string): string[] {
  return [...mdx.matchAll(/^## (.+)$/gm)].map((m) => m[1].trim());
}

/**
 * The refusal ids in page order. The fixes page names them as `<Fix id="refusal.X">`, the messages
 * page as `<Fact id="refusal.X" />`; each page uses only its own form for refusals.
 */
function refusalIds(mdx: string, tag: 'Fix' | 'Fact'): string[] {
  const pattern = new RegExp(`<${tag}\\s+id="(refusal\\.[^"]+)"`, 'g');
  return [...mdx.matchAll(pattern)].map((m) => m[1]);
}

/** Each messages-page table row as its refusal id and the anchor its How to fix link names. */
function rowLinks(mdx: string): { id: string; anchor: string | null }[] {
  const rows: { id: string; anchor: string | null }[] = [];
  for (const line of mdx.split('\n')) {
    const id = /^\|\s*<Fact\s+id="(refusal\.[^"]+)"/.exec(line);
    if (id === null) continue;
    const link = /\[How to fix\]\(\.\.\/\.\.\/\.\.\/troubleshooting\/refusals\/#([^)]+)\)/.exec(line);
    rows.push({ id: id[1], anchor: link === null ? null : link[1] });
  }
  return rows;
}

const fixes = fs.readFileSync(FIXES, 'utf8');
const messages = fs.readFileSync(MESSAGES, 'utf8');

test('the two refusal pages have the same h2 groups in the same order', () => {
  assert.deepEqual(
    h2s(messages),
    h2s(fixes),
    'site/src/content/docs/reference/files/refusal-messages.mdx and site/src/content/docs/troubleshooting/refusals.mdx have different h2 lists',
  );
});

test('the two refusal pages list the same refusals in the same order', () => {
  const want = refusalIds(fixes, 'Fix');
  const got = refusalIds(messages, 'Fact');
  const first = want.findIndex((id, i) => got[i] !== id);
  assert.deepEqual(
    got,
    want,
    `refusal-messages.mdx and refusals.mdx differ first at position ${first + 1}: ${got[first] ?? 'nothing'} on the messages page, ${want[first] ?? 'nothing'} on the fixes page`,
  );
});

test(`each refusal page holds at least ${MIN_REFUSALS} refusals`, () => {
  for (const [file, ids] of [
    ['troubleshooting/refusals.mdx', refusalIds(fixes, 'Fix')],
    ['reference/files/refusal-messages.mdx', refusalIds(messages, 'Fact')],
  ] as const) {
    assert.ok(ids.length >= MIN_REFUSALS, `site/src/content/docs/${file} holds ${ids.length} refusal ids, fewer than ${MIN_REFUSALS}`);
  }
});

test("each row on the messages page links to its own refusal's fix", () => {
  const wrong = rowLinks(messages)
    .filter((row) => row.anchor !== fixAnchor(row.id))
    .map((row) => `${row.id} links to ${row.anchor === null ? 'no How to fix anchor' : `#${row.anchor}`}, not #${fixAnchor(row.id)}`);
  assert.deepEqual(wrong, [], `refusal-messages.mdx has rows with the wrong fix link:\n${wrong.join('\n')}`);
});
