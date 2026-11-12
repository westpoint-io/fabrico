// The Crate layout page shows the repository in one FileTree, and the tree names each crate folder
// under crates/. This test reads the folders under crates/ that hold a Cargo.toml and the entries
// directly under `crates/` in the page's tree, and fails naming any crate the page leaves out or
// any crate the page names that isn't on disk. A crate added or removed without the page changing
// fails here.
// Run with `npm run test:unit` in site/.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const REPO = path.resolve(import.meta.dirname, '../../..');
const CRATES = path.join(REPO, 'crates');
const PAGE = path.join(REPO, 'site/src/content/docs/contributing/crate-layout.mdx');

/** The fewest crates the workspace held when this test was written. A walk that finds fewer is broken. */
const MIN_CRATES = 10;

/** The folders under crates/ that hold a Cargo.toml, sorted. */
export function cratesOnDisk(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(dir, entry.name, 'Cargo.toml')))
    .map((entry) => entry.name)
    .sort();
}

/**
 * The names listed directly under the `crates/` entry of the page's one FileTree, without the
 * trailing slash, sorted. Each tree line is `- name comment`, nested by indentation. Throws when the
 * page has no FileTree, more than one, or no `crates/` entry, so a broken parse can't read as an
 * empty list.
 */
export function cratesOnPage(mdx: string): string[] {
  const trees = [...mdx.matchAll(/<FileTree>([\s\S]*?)<\/FileTree>/g)];
  if (trees.length !== 1) throw new Error(`expected one <FileTree> on the page, found ${trees.length}`);
  const stack: { indent: number; name: string }[] = [];
  const found: string[] = [];
  let sawCrates = false;
  for (const line of trees[0][1].split('\n')) {
    const entry = /^(\s*)- (\S+)/.exec(line);
    if (entry === null) continue;
    const indent = entry[1].length;
    const name = entry[2];
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack[stack.length - 1]?.name;
    if (name === 'crates/' && stack.length === 0) sawCrates = true;
    if (parent === 'crates/' && stack.length === 1) found.push(name.replace(/\/$/, ''));
    stack.push({ indent, name });
  }
  if (!sawCrates) throw new Error('the FileTree has no top-level crates/ entry');
  return found.sort();
}

test('the Crate layout page names every crate folder on disk, and no other', () => {
  const disk = cratesOnDisk(CRATES);
  assert.ok(disk.length >= MIN_CRATES, `found ${disk.length} folders under crates/ holding a Cargo.toml, expected at least ${MIN_CRATES}`);
  const page = cratesOnPage(fs.readFileSync(PAGE, 'utf8'));
  const missing = disk.filter((name) => !page.includes(name));
  const extra = page.filter((name) => !disk.includes(name));
  assert.deepEqual(
    missing,
    [],
    `crate folders under crates/ missing from the FileTree in site/src/content/docs/contributing/crate-layout.mdx: ${missing.join(', ')}`,
  );
  assert.deepEqual(
    extra,
    [],
    `the FileTree in site/src/content/docs/contributing/crate-layout.mdx names crates with no folder holding a Cargo.toml under crates/: ${extra.join(', ')}`,
  );
});

test('the tree parse reads only the entries directly under crates/', () => {
  const mdx = [
    '<FileTree>',
    '- Cargo.toml the workspace',
    '- crates/',
    '  - alpha/ the first crate',
    '    - src/ not a crate',
    '  - beta/ the second crate',
    '- frontend/',
    '  - gamma/ not a crate',
    '</FileTree>',
  ].join('\n');
  assert.deepEqual(cratesOnPage(mdx), ['alpha', 'beta']);
});

test('a page with no FileTree, or no crates/ entry, throws instead of reading as no crates', () => {
  assert.throws(() => cratesOnPage('No tree here.'), /expected one <FileTree> on the page, found 0/);
  assert.throws(() => cratesOnPage('<FileTree>\n- frontend/\n</FileTree>'), /no top-level crates\/ entry/);
});
