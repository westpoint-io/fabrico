// The prose lint: a page with an em dash or a banned phrase fails.
// Run with `npm run test:unit` in site/ (plain Node, which strips the types).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { BANNED_PHRASES, formatFinding, lintFiles, run } from '../../scripts/lint-prose.ts';

const PAGE = 'site/src/content/docs/patterns/index.mdx';
const EM = '\u2014';
const EN = '\u2013';
const CURLY = '\u2019';

/** The finding lines for one page's text. */
function lint(text: string, page = PAGE): string[] {
  return lintFiles([{ path: page, text }]).map(formatFinding);
}

const dash = (line: number, col: number, page = PAGE): string =>
  `${page}:${line}:${col}: em dash (U+2014). Use a comma, a colon, parentheses or two sentences.`;

const banned = (line: number, col: number, phrase: string, page = PAGE): string =>
  `${page}:${line}:${col}: banned phrase "${phrase}". Say it plainly.`;

test('an em dash in prose fails at its line and column', () => {
  assert.deepEqual(lint(`# Title\n\nBelts move items${EM}one tile a tick.\n`), [dash(3, 17)]);
});

test('an em dash inside a fenced code block fails too', () => {
  assert.deepEqual(lint(`Text.\n\n\`\`\`js\nconst a = 1; // one${EM}two\n\`\`\`\n`), [dash(4, 20)]);
});

test('an em dash in frontmatter fails too', () => {
  assert.deepEqual(lint(`---\ntitle: Belts ${EM} and items\n---\n\nText.\n`), [dash(2, 14)]);
});

test('every em dash on a line is reported', () => {
  assert.deepEqual(lint(`a${EM}b${EM}c\n`), [dash(1, 2), dash(1, 4)]);
});

test('an en dash passes', () => {
  assert.deepEqual(lint(`Ticks 1${EN}60 run first.\n`), []);
});

test('each listed phrase fails in prose', () => {
  for (const phrase of BANNED_PHRASES) {
    assert.deepEqual(lint(`Here: ${phrase} now.\n`), [banned(1, 7, phrase)], phrase);
  }
});

test('a listed phrase fails in any letter case', () => {
  assert.deepEqual(lint('It is CRUCIAL.\n'), [banned(1, 7, 'crucial')]);
  assert.deepEqual(lint('Pivotal moment.\n'), [banned(1, 1, 'pivotal')]);
  assert.deepEqual(lint("It's Worth Noting that belts stop.\n"), [banned(1, 1, "it's worth noting")]);
});

test('the phrases with an apostrophe fail with a straight or a curly one', () => {
  const withApostrophe = BANNED_PHRASES.filter((p) => p.includes("'"));
  assert.ok(withApostrophe.length >= 3, 'the list holds the apostrophe phrases');
  for (const phrase of withApostrophe) {
    assert.deepEqual(lint(`So ${phrase}.\n`), [banned(1, 4, phrase)], `${phrase} (straight)`);
    assert.deepEqual(lint(`So ${phrase.replaceAll("'", CURLY)}.\n`), [banned(1, 4, phrase)], `${phrase} (curly)`);
  }
});

test('a phrase broken across a line still fails', () => {
  assert.deepEqual(lint('And let that\nsink in.\n'), [banned(1, 5, 'let that sink in')]);
});

test('a listed phrase inside a fenced code block passes', () => {
  assert.deepEqual(lint('Text.\n\n```txt\nThis is crucial and pivotal.\n```\n\n~~~\nquietly\n~~~\n'), []);
});

test('a listed phrase in frontmatter passes', () => {
  assert.deepEqual(lint('---\ntitle: A crucial page\ndescription: The real win.\n---\n\nText.\n'), []);
});

test('a listed word inside a longer word passes', () => {
  assert.deepEqual(lint('Disquietly, unpivotal, crucially, tapestrying, seamlessness, the real winner.\n'), []);
});

test('the frontmatter and fences shift no line numbers', () => {
  assert.deepEqual(lint('---\ntitle: T\n---\n\n```\ncode\n```\n\nThis is crucial.\n'), [banned(9, 9, 'crucial')]);
});

test('findings come in file order, then position', () => {
  const files = [
    { path: 'site/a.md', text: `quietly${EM}\n` },
    { path: 'site/b.mdx', text: 'pivotal\n' },
  ];
  assert.deepEqual(lintFiles(files).map(formatFinding), [
    banned(1, 1, 'quietly', 'site/a.md'),
    dash(1, 8, 'site/a.md'),
    banned(1, 1, 'pivotal', 'site/b.mdx'),
  ]);
});

test('a clean page passes', () => {
  assert.deepEqual(lint('---\ntitle: Belts\n---\n\nBelts carry items from one machine to the next.\n'), []);
});

// The command around the check: scan set from git, exit codes.

function siteRepo(pages: number, untracked = 0): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-prose-'));
  const site = path.join(root, 'site');
  fs.mkdirSync(path.join(site, 'src/content/docs'), { recursive: true });
  for (let i = 0; i < pages; i++) fs.writeFileSync(path.join(site, `src/content/docs/p${i}.mdx`), `Page ${i}.\n`);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1' };
  for (const args of [['init', '-q'], ['add', '.']]) {
    const r = spawnSync('git', args, { cwd: root, env, encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  }
  for (let i = 0; i < untracked; i++) fs.writeFileSync(path.join(site, `src/content/docs/u${i}.md`), `Loose${EM}page.\n`);
  return site;
}

test('a clean scan of 8 files exits 0 and prints the PROSE_LINT line', () => {
  const site = siteRepo(8);
  try {
    const result = run(site);
    assert.equal(result.code, 0);
    assert.deepEqual(result.stdout, ['PROSE_LINT files=8 findings=0']);
  } finally {
    fs.rmSync(path.dirname(site), { recursive: true, force: true });
  }
});

test('a finding exits 1 and prints the finding with the site/ path', () => {
  const site = siteRepo(8);
  try {
    fs.writeFileSync(path.join(site, 'src/content/docs/p3.mdx'), `Belts${EM}items.\n`);
    const result = run(site);
    assert.equal(result.code, 1);
    assert.deepEqual(result.stderr, [dash(1, 6, 'site/src/content/docs/p3.mdx')]);
    assert.deepEqual(result.stdout, ['PROSE_LINT files=8 findings=1']);
  } finally {
    fs.rmSync(path.dirname(site), { recursive: true, force: true });
  }
});

test('an untracked page is not read', () => {
  const site = siteRepo(8, 2);
  try {
    const result = run(site);
    assert.equal(result.code, 0);
    assert.deepEqual(result.stdout, ['PROSE_LINT files=8 findings=0']);
  } finally {
    fs.rmSync(path.dirname(site), { recursive: true, force: true });
  }
});

test('fewer than 8 files exits 2', () => {
  const site = siteRepo(7);
  try {
    const result = run(site);
    assert.equal(result.code, 2);
    assert.deepEqual(result.stdout, []);
    assert.match(result.stderr.join('\n'), /scanned 7 files, fewer than 8/);
  } finally {
    fs.rmSync(path.dirname(site), { recursive: true, force: true });
  }
});

test('a folder git cannot list exits 2', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-prose-nogit-'));
  try {
    const result = run(dir);
    assert.equal(result.code, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the lint and this test hold the dashes and the curly apostrophe only as escapes', () => {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const sources = [path.join(here, '../../scripts/lint-prose.ts'), new URL(import.meta.url).pathname];
  for (const file of sources) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      for (const ch of [EM, EN, CURLY]) {
        assert.ok(
          !line.includes(ch),
          `${path.basename(file)}:${i + 1} holds U+${ch.codePointAt(0)!.toString(16).toUpperCase()} as a literal; write it as an escape`,
        );
      }
    });
  }
});
