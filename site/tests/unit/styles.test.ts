// The site's own styles carry no colour value. Every colour reaches the site from the app's locked
// skin, through the files the build writes into src/styles/generated/, so a colour typed into a
// style file here would drift from the app the next time the skin changes.
// Run with `npm run test:unit` in site/ (plain Node, which strips the types).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const STYLES = path.resolve(import.meta.dirname, '../../src/styles');
const GENERATED = path.join(STYLES, 'generated');

/** Colour literals: a hex colour, or a colour function such as rgb( or hsla(. */
const LITERALS: readonly { name: string; pattern: RegExp }[] = [
  { name: 'hex colour', pattern: /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{4}|[0-9a-f]{3})(?![0-9a-z_-])/gi },
  { name: 'colour function', pattern: /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/gi },
];

/** Every file under src/styles/, except the generated folder, as absolute paths. */
function styleFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (full !== GENERATED) out.push(...styleFiles(full));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out.sort();
}

/** Each colour literal in a file's text, as `file:line: kind "text"`. */
export function colourLiterals(file: string, text: string): string[] {
  const found: string[] = [];
  for (const [i, line] of text.split('\n').entries()) {
    for (const { name, pattern } of LITERALS) {
      for (const match of line.matchAll(pattern)) found.push(`${file}:${i + 1}: ${name} "${match[0]}"`);
    }
  }
  return found;
}

test('the style files hold no colour literal', () => {
  const files = styleFiles(STYLES);
  assert.ok(files.length >= 1, `found ${files.length} style files under ${STYLES} to scan, expected at least 1`);
  const found = files.flatMap((file) =>
    colourLiterals(path.relative(path.resolve(STYLES, '../..'), file), fs.readFileSync(file, 'utf8')),
  );
  assert.deepEqual(found, [], 'colour literals in the site styles; use a var(--fab-*) token instead');
});

test('the scan finds each kind of colour literal', () => {
  const text = [
    'a { color: #1b1f27; }',
    'b { color: #FFF; }',
    'c { color: rgb(1 2 3); background: rgba(0, 0, 0, 0.5); }',
    'd { color: hsl(0 0% 0%); border-color: hsla(0, 0%, 0%, 1); }',
    'e { color: oklch(0.5 0.1 200); }',
  ].join('\n');
  assert.deepEqual(colourLiterals('x.css', text), [
    'x.css:1: hex colour "#1b1f27"',
    'x.css:2: hex colour "#FFF"',
    'x.css:3: colour function "rgb("',
    'x.css:3: colour function "rgba("',
    'x.css:4: colour function "hsl("',
    'x.css:4: colour function "hsla("',
    'x.css:5: colour function "oklch("',
  ]);
});

test('ids, tokens and color-mix are not colour literals', () => {
  const text = [
    '#starlight__sidebar a { color: var(--fab-ink); }',
    '#_top { background: color-mix(in srgb, var(--fab-substrate) 80%, transparent); }',
    '.x { background-color: var(--fab-panel-fill); }',
  ].join('\n');
  assert.deepEqual(colourLiterals('x.css', text), []);
});
