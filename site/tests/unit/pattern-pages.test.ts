// Every pattern page answers one search and shows its answer running on one board, and the text
// on the page has to agree with that board. This test reads each page under patterns/ (except
// index.mdx and test pages whose name starts with _) and its board file under
// examples/boards/docs/, and fails, naming the file and what to change, when:
// - the pages on disk differ from the Patterns entry in site/coverage-manifest.json, or there are
//   fewer than MIN_PATTERN_PAGES of them;
// - a page has no searchPhrase, or the phrase is in neither its title nor its description;
// - a page has no <Board>, more than one, or one named for another page;
// - a `Factory code` block differs from the board's Factory source;
// - the How the board works steps differ from the board's captions.
// The last two are here because page text drifted from the code it describes more than once.
// Run with `npm run test:unit` in site/.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const SITE = path.resolve(import.meta.dirname, '../..');
const DOCS = path.join(SITE, 'src/content/docs');
const PATTERNS = path.join(DOCS, 'patterns');
const MANIFEST = path.join(SITE, 'coverage-manifest.json');
const BOARDS = path.resolve(SITE, '../examples/boards/docs');

/**
 * The number of pattern pages the section holds now. Each change that adds pattern pages raises
 * it to the new page count in the same commit, so a glob that matches nothing, or a lost page,
 * can't pass. It ends at 12 once all twelve pattern pages are written.
 */
const MIN_PATTERN_PAGES = 8;

/** Curly quotes made straight and runs of space made one, so markdown and HTML compare as text. */
function plain(text: string): string {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The page's path as the failure messages name it. */
const shown = (file: string): string => `site/src/content/docs/patterns/${file}`;

/** The board id a page must show, from its file stem: `forward-a-webhook.mdx` shows `docs-patterns-forward-a-webhook`. */
const boardIdOf = (file: string): string => `docs-patterns-${file.replace(/\.mdx$/, '')}`;

/** The board file behind a board id, as `boardPathOf` in the embed suite maps it. */
const boardFileOf = (id: string): string => path.join(BOARDS, `${id.replace(/^docs-/, '')}.board.ron`);

/** Every pattern page file name, sorted, leaving out index.mdx and test pages whose name starts with _. */
function patternFiles(): string[] {
  return fs
    .readdirSync(PATTERNS)
    .filter((name) => name.endsWith('.mdx') && name !== 'index.mdx' && !name.startsWith('_'))
    .sort();
}

/** A page's frontmatter fields and body. A missing field reads as ''. */
function readPage(file: string): { field: (name: string) => string; body: string; text: string } {
  const text = fs.readFileSync(path.join(PATTERNS, file), 'utf8');
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (match === null) throw new Error(`${shown(file)} has no frontmatter`);
  const field = (name: string): string => {
    const line = new RegExp(`^${name}:\\s*(.*)$`, 'm').exec(match[1]);
    if (line === null) return '';
    return line[1].trim().replace(/^(["'])(.*)\1$/, '$2');
  };
  return { field, body: match[2], text };
}

/** Trailing spaces off each line and newlines off the end, so code compares as text. */
const tidy = (code: string): string =>
  code
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n+$/, '');

/** Each fenced js block titled `Factory code`, with the list indent it sits under removed, and the line it starts on. */
function pageCodeBlocks(mdx: string): { line: number; code: string }[] {
  const lines = mdx.split('\n');
  const blocks: { line: number; code: string }[] = [];
  for (let start = 0; start < lines.length; start += 1) {
    if (!/^\s*```js title="Factory code"\s*$/.test(lines[start])) continue;
    const indent = /^(\s*)/.exec(lines[start])![1];
    const body: string[] = [];
    let i = start + 1;
    for (; i < lines.length && !/^\s*```\s*$/.test(lines[i]); i += 1) {
      body.push(lines[i].startsWith(indent) ? lines[i].slice(indent.length) : lines[i].trimStart());
    }
    blocks.push({ line: start + 1, code: tidy(body.join('\n')) });
    start = i;
  }
  return blocks;
}

/** Every Factory source a board's Configure commands set, from `source: r#"` to `"#`. */
function boardSources(ron: string): string[] {
  return [...ron.matchAll(/Configure\(node:\s*\d+,\s*config:\s*Factory\(source:\s*r#"([\s\S]*?)"#\)\)/g)].map((m) => tidy(m[1]));
}

/** A board's captions in file order, with RON's escapes decoded (they are JSON's escapes too). */
const CAPTION = /Caption\(tick:\s*(\d+),\s*highlight:\s*\d+,\s*text:\s*"((?:[^"\\]|\\.)*)"\)/g;
function captionsOf(ron: string): { tick: number; text: string }[] {
  return [...ron.matchAll(CAPTION)].map((m) => ({ tick: Number(m[1]), text: JSON.parse(`"${m[2]}"`) as string }));
}

/** The items of the ordered list under `## How the board works`, without their `1. ` numbers. */
function stepsOf(mdx: string): string[] {
  const start = mdx.indexOf('\n## How the board works\n');
  if (start < 0) return [];
  const rest = mdx.slice(start + 1).split('\n').slice(1);
  const end = rest.findIndex((l) => l.startsWith('## '));
  return (end < 0 ? rest : rest.slice(0, end)).filter((l) => /^\d+\.\s/.test(l)).map((l) => l.replace(/^\d+\.\s+/, ''));
}

/** The board file for a page, or a problem line when it doesn't exist. */
function boardOf(file: string): { id: string; ron: string | null; problem: string | null } {
  const id = boardIdOf(file);
  const boardFile = boardFileOf(id);
  if (!fs.existsSync(boardFile)) {
    return { id, ron: null, problem: `${shown(file)}: examples/boards/docs/${id.replace(/^docs-/, '')}.board.ron doesn't exist. A pattern page's board file is named after the page.` };
  }
  return { id, ron: fs.readFileSync(boardFile, 'utf8'), problem: null };
}

/** Fails with every problem at once, one per line, so one page's problem doesn't hide another's. */
function noProblems(problems: string[]): void {
  assert.equal(problems.length, 0, `\n${problems.join('\n')}\n`);
}

test('the pattern pages on disk are the Patterns entry in the coverage manifest, and there are at least MIN_PATTERN_PAGES', () => {
  const files = patternFiles();
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) as { sections: { name: string; pages: string[] }[] };
  const section = manifest.sections.find((s) => s.name === 'Patterns');
  assert.ok(section, 'site/coverage-manifest.json has no section named "Patterns"');
  const listed = section.pages.filter((p) => p !== 'patterns/index.mdx').map((p) => p.replace(/^patterns\//, ''));
  // The floor is one more problem line rather than an early assert, so a lost page reports both
  // the count and the manifest line that names it.
  const problems: string[] = [];
  if (files.length < MIN_PATTERN_PAGES) {
    problems.push(`pattern-pages: found ${files.length} pattern pages under site/src/content/docs/patterns/, expected at least ${MIN_PATTERN_PAGES}. Did the folder move?`);
  }
  for (const file of files) {
    if (!listed.includes(file)) {
      problems.push(`${shown(file)} is on disk but not in the Patterns entry of site/coverage-manifest.json. Add patterns/${file} to its pages and raise its pageCount.`);
    }
  }
  for (const file of listed) {
    if (!files.includes(file)) {
      problems.push(`site/coverage-manifest.json lists patterns/${file} under Patterns, but ${shown(file)} doesn't exist. Restore the page, or take it out of the entry and lower its pageCount.`);
    }
  }
  noProblems(problems);
});

test('each pattern page has a searchPhrase in its frontmatter', () => {
  const problems = patternFiles()
    .filter((file) => readPage(file).field('searchPhrase') === '')
    .map((file) => `${shown(file)} has no searchPhrase in its frontmatter. Add the words a reader would type into a search, and put them in the title.`);
  noProblems(problems);
});

test("each pattern page's searchPhrase is in its title or its description", () => {
  const problems: string[] = [];
  for (const file of patternFiles()) {
    const { field } = readPage(file);
    const phrase = field('searchPhrase');
    if (phrase === '') continue; // the test above names it
    const title = field('title');
    const wanted = plain(phrase).toLowerCase();
    if (plain(title).toLowerCase().includes(wanted) || plain(field('description')).toLowerCase().includes(wanted)) continue;
    problems.push(`${shown(file)}: searchPhrase "${phrase}" is in neither the title "${title}" nor the description. Put the phrase in the title word for word.`);
  }
  noProblems(problems);
});

test('each pattern page shows exactly one board, named for the page', () => {
  const problems: string[] = [];
  for (const file of patternFiles()) {
    const tags = [...readPage(file).body.matchAll(/<Board\b[^>]*>/g)].map((m) => m[0]);
    if (tags.length !== 1) {
      problems.push(`${shown(file)} has ${tags.length} <Board> tags. A pattern page shows its pattern running on exactly one board.`);
      continue;
    }
    const name = /\bname="([^"]*)"/.exec(tags[0])?.[1] ?? '';
    const id = boardIdOf(file);
    if (name !== id) {
      problems.push(`${shown(file)} shows the board "${name}". Its board is ${id}, from examples/boards/docs/${id.replace(/^docs-/, '')}.board.ron.`);
    }
  }
  noProblems(problems);
});

test("each pattern page's Factory code blocks equal its board's Factory sources", () => {
  const problems: string[] = [];
  for (const file of patternFiles()) {
    const board = boardOf(file);
    if (board.ron === null) {
      problems.push(board.problem!);
      continue;
    }
    const blocks = pageCodeBlocks(readPage(file).text);
    const sources = boardSources(board.ron);
    const boardName = board.id.replace(/^docs-/, '');
    if (blocks.length === 0) {
      problems.push(`${shown(file)} has no js block titled "Factory code".`);
      continue;
    }
    for (const block of blocks) {
      if (!sources.includes(block.code)) {
        problems.push(`${shown(file)}: its Factory code block on line ${block.line} doesn't match any Factory in examples/boards/docs/${boardName}.board.ron. Copy the source from the board file.`);
      }
    }
    for (const source of new Set(sources)) {
      if (!blocks.some((b) => b.code === source)) {
        problems.push(`${shown(file)} has no Factory code block for the Factory source starting "${source.split('\n')[0]}" in examples/boards/docs/${boardName}.board.ron. Copy the source from the board file.`);
      }
    }
  }
  noProblems(problems);
});

test("each pattern page's How the board works steps restate its board's captions in order", () => {
  const problems: string[] = [];
  for (const file of patternFiles()) {
    const board = boardOf(file);
    if (board.ron === null) {
      problems.push(board.problem!);
      continue;
    }
    const boardName = board.id.replace(/^docs-/, '');
    const steps = stepsOf(readPage(file).body);
    const captions = captionsOf(board.ron);
    if (steps.length !== captions.length) {
      problems.push(`${shown(file)}: How the board works has ${steps.length} steps and examples/boards/docs/${boardName}.board.ron has ${captions.length} captions.`);
      continue;
    }
    captions.forEach((caption, i) => {
      const want = plain(`Tick ${caption.tick}: ${caption.text}`);
      if (!plain(steps[i]).startsWith(want)) {
        problems.push(`${shown(file)}: step ${i + 1} should start "${want}".`);
      }
    });
  }
  noProblems(problems);
});
