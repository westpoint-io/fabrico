// The Factory sandbox leaves out global names such as Math.pow, but it can't leave out the `**`
// operator, which QuickJS sends to the same C library pow. So `**` is a second place, after the
// memory and stack limits, where a Factory's result can differ between computers. This test reads
// each docs sentence or section that says where Factory determinism stops and fails, naming the
// page, when one of them doesn't name `**`. Run with `npm run test:unit` in site/.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const DOCS = path.resolve(import.meta.dirname, '../../src/content/docs');

function read(page: string): string {
  return fs.readFileSync(path.join(DOCS, page), 'utf8');
}

/** The text under a `## ` heading, up to the next `## ` heading. Throws when the heading is missing. */
function section(mdx: string, heading: string): string {
  const lines = mdx.split('\n');
  const start = lines.indexOf(`## ${heading}`);
  assert.notEqual(start, -1, `no "## ${heading}" heading`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## '));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

/** The first paragraph of prose in a block of mdx text: the first non-empty run of lines that isn't an import. */
function firstParagraph(text: string): string {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p !== '' && !p.startsWith('import ') && !p.startsWith('---'));
  assert.ok(paragraphs.length > 0, 'no paragraph found');
  return paragraphs[0];
}

/** The body of an mdx page, after its frontmatter. */
function body(mdx: string): string {
  const match = mdx.match(/^---\n[\s\S]*?\n---\n/);
  return match ? mdx.slice(match[0].length) : mdx;
}

const OPERATOR = '`**`';

test('the Limits page sentence on where determinism ends names **', () => {
  const page = 'reference/board/limits.mdx';
  const line = read(page)
    .split('\n')
    .find((l) => l.startsWith('Determinism ends at'));
  assert.ok(line, `${page} has no line that starts "Determinism ends at"`);
  assert.ok(line.includes(OPERATOR), `${page}: "${line.slice(0, 90)}..." doesn't name ${OPERATOR}`);
});

test('the opening of Where determinism ends names **', () => {
  const page = 'concepts/determinism-and-replay.mdx';
  const opening = firstParagraph(section(read(page), 'Where determinism ends'));
  assert.ok(opening.includes(OPERATOR), `${page}: the first paragraph under "Where determinism ends" doesn't name ${OPERATOR}`);
});

test('the Factory API Withheld globals section names **', () => {
  const page = 'reference/code-and-http/factory-api.mdx';
  assert.ok(
    section(read(page), 'Withheld globals').includes(OPERATOR),
    `${page}: the "Withheld globals" section doesn't say ${OPERATOR} gets through the sandbox`,
  );
});

test('the opening of The Factory sandbox names **', () => {
  const page = 'concepts/factory-sandbox.mdx';
  const opening = firstParagraph(body(read(page)));
  assert.ok(opening.includes(OPERATOR), `${page}: the first paragraph doesn't name ${OPERATOR}`);
});
