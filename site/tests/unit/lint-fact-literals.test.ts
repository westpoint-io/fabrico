// The fact-literal lint: a page that types a value from the code as prose fails.
// Run with `npm run test:unit` in site/ (plain Node, which strips the types).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { blank, formatFinding, lintFiles, run, type LintFact } from '../../scripts/lint-fact-literals.ts';

const FACTS: Record<string, LintFact> = {
  'embed.ticks_per_second': { kind: 'quantity', value: 60, unit: 'ticks a second', also: ['ticks per second'] },
  'limit.max_belt_tiles': { kind: 'quantity', value: 1024, unit: 'tiles', also: ['tiles a belt'] },
  'limit.default_ticks_per_slot': { kind: 'quantity', value: 2, unit: 'ticks a slot', also: ['ticks per slot'] },
  'limit.factory_memory': { kind: 'quantity', value: 8, unit: 'MiB', also: ['MiB of memory'] },
  'limit.grid_min': { kind: 'quantity', value: -512, unit: 'on each axis', also: [] },
  'refusal.OutOfBounds': { kind: 'text', value: 'That cell is past the edge of the grid.' },
  'refusal.Short': { kind: 'text', value: 'No room here.' },
  'fault.NoMatch': { kind: 'code', value: 'NoMatch' },
};

const PAGE = 'site/src/content/docs/concepts/index.mdx';

/** The finding lines for one page's text. */
function lint(text: string, page = PAGE): string[] {
  return lintFiles([{ path: page, text }], FACTS).map(formatFinding);
}

const typed = (line: number, col: number, matched: string, id: string, page = PAGE): string =>
  `${page}:${line}:${col}: "${matched}" types the generated fact ${id} as prose. Write <Fact id="${id}" /> so the page changes when the code does.`;

const RAW = (line: number, col: number, page = PAGE): string =>
  `${page}:${line}:${col}: write <Board name="..." /> here, not <fabrico-board>, so the build checks the board name.`;

test('a typed tick rate fails, naming the fact at its line and column', () => {
  const text = '---\ntitle: Concepts\n---\n\nThe board plays at 60 ticks a second.\n';
  assert.deepEqual(lint(text), [typed(5, 20, '60 ticks a second', 'embed.ticks_per_second')]);
});

test('the other spelling of a unit fails too', () => {
  assert.deepEqual(lint('It runs at 60 ticks per second.'), [typed(1, 12, '60 ticks per second', 'embed.ticks_per_second')]);
});

test('a belt length fails with and without the thousands separator', () => {
  assert.deepEqual(lint('A belt holds 1,024 tiles.'), [typed(1, 14, '1,024 tiles', 'limit.max_belt_tiles')]);
  assert.deepEqual(lint('A belt holds 1024 tiles.'), [typed(1, 14, '1024 tiles', 'limit.max_belt_tiles')]);
});

test('case and a line break inside the phrase still fail', () => {
  assert.deepEqual(lint('At 60 Ticks A\nSecond.'), [typed(1, 4, '60 Ticks A Second', 'embed.ticks_per_second')]);
});

test('a bare number or a number with another unit passes', () => {
  assert.deepEqual(lint('In step 60, watch 60 items move. Each slot takes 2 ticks.'), []);
  assert.deepEqual(lint('Wait 160 ticks a second time, or 601 tiles.'), []);
  assert.deepEqual(lint('Version 1.1024 tiles is not a count, nor is 3,1024 tiles.'), []);
});

test('a negative value matches with its sign, and the positive number alone does not', () => {
  assert.deepEqual(lint('Cells run to -512 on each axis.'), [typed(1, 14, '-512 on each axis', 'limit.grid_min')]);
  assert.deepEqual(lint('Cells run to 512 on each axis.'), []);
});

test('a byte size typed as MiB fails through its unit', () => {
  assert.deepEqual(lint('A Factory gets 8 MiB of memory.'), [typed(1, 16, '8 MiB of memory', 'limit.factory_memory')]);
});

test('the value inside a Fact element, a fenced code block or frontmatter passes', () => {
  assert.deepEqual(lint('The board plays at <Fact id="embed.ticks_per_second" note="60 ticks a second" />.'), []);
  assert.deepEqual(lint('Before.\n\n```text\nThe board plays at 60 ticks a second.\n```\n\nAfter.'), []);
  assert.deepEqual(lint('~~~\n1024 tiles\n~~~\n'), []);
  assert.deepEqual(lint('---\ndescription: The board plays at 60 ticks a second.\n---\n\nBody.\n'), []);
});

test('blanking keeps every line and column where it was', () => {
  const text = '---\ntitle: x\n---\n```\ncode\n```\nA <Fact id="a" /> b';
  const out = blank(text);
  assert.equal(out.length, text.length);
  assert.deepEqual(out.split('\n').map((l) => l.length), text.split('\n').map((l) => l.length));
  assert.ok(out.endsWith(' b'));
});

test('a raw fabrico-board tag in an .mdx body fails with the raw-element line', () => {
  assert.deepEqual(lint('Intro.\n\n<fabrico-board name="demo_scene"></fabrico-board>\n'), [RAW(3, 1)]);
});

test('a raw fabrico-board tag in a fenced code block or a .md page passes', () => {
  assert.deepEqual(lint('```html\n<fabrico-board name="demo_scene"></fabrico-board>\n```\n'), []);
  assert.deepEqual(lint('<fabrico-board name="x">', 'site/src/content/docs/404.md'), []);
});

test('a refusal message longer than 20 characters pasted into prose fails', () => {
  const text = 'The app says That cell is past the edge of the grid. and stops.';
  assert.deepEqual(lint(text), [typed(1, 14, 'That cell is past the edge of the grid.', 'refusal.OutOfBounds')]);
});

test('a short text fact in prose passes', () => {
  assert.deepEqual(lint('No room here. Move on.'), []);
});

test('a code fact in prose passes; only quantities and long text are checked', () => {
  assert.deepEqual(lint('The fault reads NoMatch.'), []);
});

// The command around the check: scan set from git, facts.json from disk, exit codes.

function siteRepo(pages: number, factsText: string | null): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-facts-'));
  const site = path.join(root, 'site');
  fs.mkdirSync(path.join(site, 'src/content/docs'), { recursive: true });
  fs.mkdirSync(path.join(site, 'src/generated'), { recursive: true });
  for (let i = 0; i < pages; i++) fs.writeFileSync(path.join(site, `src/content/docs/p${i}.mdx`), `Page ${i}.\n`);
  if (factsText !== null) fs.writeFileSync(path.join(site, 'src/generated/facts.json'), factsText);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1' };
  for (const args of [['init', '-q'], ['add', '.']]) {
    const r = spawnSync('git', args, { cwd: root, env, encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  }
  return site;
}

const FACTS_TEXT = `${JSON.stringify({ schema: 1, facts: FACTS, machines: [] })}\n`;

test('a clean scan of 8 files exits 0 and prints the FACT_LINT line', () => {
  const site = siteRepo(8, FACTS_TEXT);
  try {
    const result = run(site);
    assert.equal(result.code, 0);
    assert.deepEqual(result.stdout, ['FACT_LINT files=8 facts=6 findings=0']);
  } finally {
    fs.rmSync(path.dirname(site), { recursive: true, force: true });
  }
});

test('a finding exits 1 and prints the finding with the site/ path', () => {
  const site = siteRepo(8, FACTS_TEXT);
  try {
    fs.writeFileSync(path.join(site, 'src/content/docs/p3.mdx'), 'It plays at 60 ticks a second.\n');
    const result = run(site);
    assert.equal(result.code, 1);
    assert.deepEqual(result.stderr, [typed(1, 13, '60 ticks a second', 'embed.ticks_per_second', 'site/src/content/docs/p3.mdx')]);
    assert.deepEqual(result.stdout, ['FACT_LINT files=8 facts=6 findings=1']);
  } finally {
    fs.rmSync(path.dirname(site), { recursive: true, force: true });
  }
});

test('fewer than 8 files exits 2', () => {
  const site = siteRepo(7, FACTS_TEXT);
  try {
    const result = run(site);
    assert.equal(result.code, 2);
    assert.match(result.stderr.join('\n'), /scanned 7 files, fewer than 8/);
  } finally {
    fs.rmSync(path.dirname(site), { recursive: true, force: true });
  }
});

test('a missing facts.json exits 2', () => {
  const site = siteRepo(8, null);
  try {
    const result = run(site);
    assert.equal(result.code, 2);
    assert.match(result.stderr.join('\n'), /can't read .*facts\.json/);
  } finally {
    fs.rmSync(path.dirname(site), { recursive: true, force: true });
  }
});

test('an unparseable facts.json exits 2', () => {
  const site = siteRepo(8, '{ "facts": ');
  try {
    assert.equal(run(site).code, 2);
  } finally {
    fs.rmSync(path.dirname(site), { recursive: true, force: true });
  }
});

test('a facts.json with no facts object exits 2', () => {
  const site = siteRepo(8, '{ "schema": 1 }\n');
  try {
    const result = run(site);
    assert.equal(result.code, 2);
    assert.match(result.stderr.join('\n'), /no "facts" object/);
  } finally {
    fs.rmSync(path.dirname(site), { recursive: true, force: true });
  }
});
