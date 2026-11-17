// Every pattern page answers one search and shows its answer running on one board, and the text
// on the page has to agree with that board. This test reads each page under patterns/ (except
// index.mdx and test pages whose name starts with _) and its board file under
// examples/boards/docs/, and fails, naming the file and what to change, when:
// - the pages on disk differ from the Patterns entry in site/coverage-manifest.json, or there are
//   fewer than MIN_PATTERN_PAGES of them;
// - a page has no searchPhrase, or the phrase is in neither its title nor its description;
// - a page has no <Board>, more than one, or one named for another page, or its one <Board> sits
//   inside an MDX comment, a code block or a {...} expression, where a reader never sees it. The one
//   exception is reproduce-a-bug.mdx, which shows its board twice: exactly two tags, both naming it;
// - a `Factory code` or `Handler code` block differs from the board's Factory sources (a Handler's
//   code is a Factory source in the board file), or the page has none outside MDX comments;
// - the How the board works steps differ from the board's captions. A numbered line inside an MDX
//   comment, a code block or inline code isn't a step;
// - a page's board has faultsAbout and the page has no `faults` in its frontmatter, so the docs suite
//   would have no count to compare with the board's effect log;
// - a page with `faults` types a count such as "2 faults" in its body, outside code, instead of
//   writing {frontmatter.faults}, so the text could drift from the number the suite checks.
// The last two are here because page text drifted from the code it describes more than once. The
// board file is read with a small RON reader below, not a pattern, so a caption or Factory written
// with a trailing comma, fields in another order, a r##"..."## string, a comment around it or,
// for a caption, no Caption name in front of its (...) is still read the way the engine reads it,
// and a layout the reader doesn't know fails the test rather than dropping out of it.
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
 * can't pass. It ends at 23 once all twenty-three pattern pages are written.
 */
const MIN_PATTERN_PAGES = 13;

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

/**
 * Pages that show a shipped example board instead of a docs board of their own, by file name. The
 * order processing page shows the whole-workflow example the app ships under Examples, so the page
 * and the app run the same board.
 */
const SHIPPED_BOARDS: Record<string, string> = { 'order-processing.mdx': 'order_processing' };

/**
 * The board id a page must show, from its file stem: `forward-a-webhook.mdx` shows
 * `docs-patterns-forward-a-webhook`, and a page in SHIPPED_BOARDS shows the board named there.
 */
const boardIdOf = (file: string): string => SHIPPED_BOARDS[file] ?? `docs-patterns-${file.replace(/\.mdx$/, '')}`;

/** The board file behind a board id, as `boardPathOf` in the embed suite maps it. */
const boardFileOf = (id: string): string =>
  Object.values(SHIPPED_BOARDS).includes(id) ? path.resolve(BOARDS, '..', `${id}.board.ron`) : path.join(BOARDS, `${id.replace(/^docs-/, '')}.board.ron`);

/** The board file behind a board id as the failure messages name it, from the repo root. */
const boardShown = (id: string): string => path.relative(path.resolve(SITE, '..'), boardFileOf(id)).split(path.sep).join('/');

/** The one page that shows its board twice, and how many <Board> tags every other page shows. */
const TWO_BOARD_PAGE = 'reproduce-a-bug.mdx';
const boardTagsFor = (file: string): number => (file === TWO_BOARD_PAGE ? 2 : 1);

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

/**
 * The page with the parts a reader never sees blanked to spaces: MDX comments `{/* ... *\/}`
 * always, and fenced code blocks and inline code too when `code` is 'blank'. Newlines stay, so
 * line numbers and positions still match the page. A `{/*` inside a fenced block or inline code
 * is code, and doesn't start a comment.
 */
function blankHidden(text: string, code: 'blank' | 'keep'): string {
  const blank = (s: string): string => s.replace(/[^\n]/g, ' ');
  const out: string[] = [];
  let fence: RegExp | null = null;
  let inComment = false;
  for (const line of text.split('\n')) {
    if (fence !== null) {
      out.push(code === 'keep' ? line : blank(line));
      if (fence.test(line)) fence = null;
      continue;
    }
    const open = inComment ? null : /^\s*(`{3,}|~{3,})/.exec(line);
    if (open !== null) {
      fence = new RegExp(`^\\s*${open[1][0]}{${open[1].length},}\\s*$`);
      out.push(code === 'keep' ? line : blank(line));
      continue;
    }
    let rest = line;
    let done = '';
    while (rest.length > 0) {
      if (inComment) {
        const end = rest.indexOf('*/}');
        const cut = end < 0 ? rest.length : end + 3;
        done += blank(rest.slice(0, cut));
        rest = rest.slice(cut);
        if (end >= 0) inComment = false;
        continue;
      }
      const next = /\{\/\*|`[^`]*`/.exec(rest);
      if (next === null) {
        done += rest;
        break;
      }
      done += rest.slice(0, next.index);
      if (next[0] === '{/*') {
        inComment = true;
        done += '   ';
      } else {
        done += code === 'keep' ? next[0] : blank(next[0]);
      }
      rest = rest.slice(next.index + next[0].length);
    }
    out.push(done);
  }
  return out.join('\n');
}

/**
 * Each fenced js block titled `Factory code` or `Handler code` a reader sees, with the list indent it sits under
 * removed, and the line it starts on. A block inside an MDX comment, or inside another fenced
 * block, doesn't count.
 */
function pageCodeBlocks(mdx: string): { line: number; code: string }[] {
  const lines = blankHidden(mdx, 'keep').split('\n');
  const blocks: { line: number; code: string }[] = [];
  for (let start = 0; start < lines.length; start += 1) {
    const open = /^(\s*)(`{3,}|~{3,})(.*)$/.exec(lines[start]);
    if (open === null) continue;
    const close = new RegExp(`^\\s*${open[2][0]}{${open[2].length},}\\s*$`);
    const indent = open[1];
    const body: string[] = [];
    let i = start + 1;
    for (; i < lines.length && !close.test(lines[i]); i += 1) {
      body.push(lines[i].startsWith(indent) ? lines[i].slice(indent.length) : lines[i].trimStart());
    }
    if (open[2] === '```' && /^js title="(Factory|Handler) code"\s*$/.test(open[3])) {
      blocks.push({ line: start + 1, code: tidy(body.join('\n')) });
    }
    start = i;
  }
  return blocks;
}

/** One token of a board file: a name, a string (escapes decoded), a number, or a bracket, colon or comma. */
type RonToken = { kind: 'ident' | 'str' | 'num' | 'punct'; value: string; line: number };

/** Rust's string escapes, which RON uses: `\n`, `\u{41}` and so on. Anything else is an error. */
function ronEscape(src: string, at: number, where: () => string): { text: string; next: number } {
  const c = src[at];
  const simple: Record<string, string> = { n: '\n', r: '\r', t: '\t', '0': '\0', '\\': '\\', '"': '"', "'": "'" };
  if (c in simple) return { text: simple[c], next: at + 1 };
  if (c === 'x' && /^[0-7][0-9a-fA-F]$/.test(src.slice(at + 1, at + 3))) {
    return { text: String.fromCharCode(parseInt(src.slice(at + 1, at + 3), 16)), next: at + 3 };
  }
  const unicode = c === 'u' ? /^\{([0-9a-fA-F]{1,6})\}/.exec(src.slice(at + 1)) : null;
  if (unicode !== null) return { text: String.fromCodePoint(parseInt(unicode[1], 16)), next: at + 1 + unicode[0].length };
  throw new Error(`${where()}: the escape \\${c} isn't one this test can read.`);
}

/**
 * Splits a board file into tokens the way RON does, leaving out `//` and nested `/* *\/` comments,
 * so text inside a comment or a string never counts as a caption or a Factory.
 */
function ronTokens(src: string, file: string): RonToken[] {
  const tokens: RonToken[] = [];
  let line = 1;
  let i = 0;
  const where = (): string => `${file}:${line}`;
  const advance = (to: number): void => {
    for (let k = i; k < to; k += 1) if (src[k] === '\n') line += 1;
    i = to;
  };
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      advance(i + 1);
    } else if (src.startsWith('//', i)) {
      const end = src.indexOf('\n', i);
      advance(end < 0 ? src.length : end);
    } else if (src.startsWith('/*', i)) {
      let depth = 0;
      let k = i;
      do {
        if (src.startsWith('/*', k)) (depth += 1), (k += 2);
        else if (src.startsWith('*/', k)) (depth -= 1), (k += 2);
        else if (k >= src.length) throw new Error(`${where()}: a /* comment never ends.`);
        else k += 1;
      } while (depth > 0);
      advance(k);
    } else if (/^r#*"/.test(src.slice(i, i + 300))) {
      const hashes = /^r(#*)"/.exec(src.slice(i))![1];
      const close = `"${hashes}`;
      const start = i + hashes.length + 2;
      const end = src.indexOf(close, start);
      if (end < 0) throw new Error(`${where()}: a raw string never ends.`);
      const startLine = line;
      advance(end + close.length);
      tokens.push({ kind: 'str', value: src.slice(start, end), line: startLine });
    } else if (c === '"') {
      const startLine = line;
      let text = '';
      let k = i + 1;
      for (;;) {
        if (k >= src.length) throw new Error(`${where()}: a string never ends.`);
        if (src[k] === '"') break;
        if (src[k] === '\\') {
          const e = ronEscape(src, k + 1, where);
          text += e.text;
          k = e.next;
        } else {
          text += src[k];
          k += 1;
        }
      }
      advance(k + 1);
      tokens.push({ kind: 'str', value: text, line: startLine });
    } else if (/[A-Za-z_]/.test(c)) {
      const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))![0];
      tokens.push({ kind: 'ident', value: word, line });
      advance(i + word.length);
    } else if (/[-+0-9]/.test(c)) {
      const num = /^[-+]?[0-9][0-9A-Za-z_.]*/.exec(src.slice(i));
      if (num === null) throw new Error(`${where()}: "${c}" doesn't start anything this test can read.`);
      tokens.push({ kind: 'num', value: num[0], line });
      advance(i + num[0].length);
    } else if ('()[]{}:,'.includes(c)) {
      tokens.push({ kind: 'punct', value: c, line });
      advance(i + 1);
    } else {
      throw new Error(`${where()}: "${c}" isn't something this test can read in a board file.`);
    }
  }
  return tokens;
}

/** A struct's fields: a field whose value is one string or number keeps that token, and a bigger value reads as null. */
type RonFields = Map<string, RonToken | null>;

/**
 * Reads the struct whose `(` is tokens[open]: its fields, where each field's value starts, and the
 * index just past its closing `)`.
 */
function ronStructAt(tokens: RonToken[], open: number, file: string): { fields: RonFields; valueAt: Map<string, number>; end: number } {
  const fields: RonFields = new Map();
  const valueAt = new Map<string, number>();
  let depth = 1;
  let k = open + 1;
  for (; k < tokens.length && depth > 0; k += 1) {
    const t = tokens[k];
    if (t.kind === 'punct' && '([{'.includes(t.value)) depth += 1;
    else if (t.kind === 'punct' && ')]}'.includes(t.value)) depth -= 1;
    else if (depth === 1 && t.kind === 'ident' && tokens[k + 1]?.value === ':') {
      const value = tokens[k + 2];
      const after = tokens[k + 3]?.value;
      const single = value !== undefined && (value.kind === 'str' || value.kind === 'num') && (after === ',' || after === ')');
      fields.set(t.value, single ? value : null);
      valueAt.set(t.value, k + 2);
    }
  }
  if (depth > 0) throw new Error(`${file}:${tokens[open].line}: this ( never closes.`);
  return { fields, valueAt, end: k };
}

/** Each `name(...)` struct in a board file, wherever it sits, with its fields. */
function ronStructs(tokens: RonToken[], name: string, file: string): { line: number; fields: RonFields }[] {
  const found: { line: number; fields: RonFields }[] = [];
  for (let i = 0; i + 1 < tokens.length; i += 1) {
    if (tokens[i].kind !== 'ident' || tokens[i].value !== name || tokens[i + 1].value !== '(') continue;
    found.push({ line: tokens[i].line, fields: ronStructAt(tokens, i + 1, file).fields });
  }
  return found;
}

/** Every Factory source the board sets, in file order. A Factory(...) with no string source is an error. */
function boardSources(ron: string, file: string): string[] {
  return ronStructs(ronTokens(ron, file), 'Factory', file).map(({ line, fields }) => {
    const source = fields.get('source');
    if (source?.kind !== 'str') throw new Error(`${file}:${line}: this Factory(...) has no source string this test can read.`);
    return tidy(source.value);
  });
}

/**
 * A board's captions in file order, read by position: each element of the `captions: [...]` list
 * of the top-level Board(...). RON lets a struct leave out its name, so an element written
 * `(tick: 85, ...)` is a Caption to the engine and counts here too. An element that is neither
 * `Caption(...)` nor an unnamed `(...)`, or one without a whole-number tick and a string text,
 * is an error naming its line.
 */
function captionsOf(ron: string, file: string): { tick: number; text: string }[] {
  const tokens = ronTokens(ron, file);
  const named = tokens[0]?.kind === 'ident';
  const open = named ? 1 : 0;
  if (tokens[open]?.value !== '(' || (named && tokens[0].value !== 'Board')) {
    throw new Error(`${file}:${tokens[0]?.line ?? 1}: the file doesn't start with Board(...).`);
  }
  const board = ronStructAt(tokens, open, file);
  if (board.end !== tokens.length) throw new Error(`${file}:${tokens[board.end].line}: there is more after the Board(...).`);
  const at = board.valueAt.get('captions');
  if (at === undefined) return [];
  if (tokens[at]?.value !== '[') throw new Error(`${file}:${tokens[at]?.line ?? 1}: captions isn't a [...] list.`);
  const captions: { tick: number; text: string }[] = [];
  let k = at + 1;
  while (tokens[k]?.value !== ']') {
    const t = tokens[k];
    if (t === undefined) throw new Error(`${file}:${tokens[at].line}: the captions list never closes.`);
    const elementOpen = t.kind === 'ident' && t.value === 'Caption' ? k + 1 : k;
    if (tokens[elementOpen]?.kind !== 'punct' || tokens[elementOpen].value !== '(') {
      throw new Error(`${file}:${t.line}: the captions list holds "${t.value}", and this test reads only Caption(...) or an unnamed (...) there.`);
    }
    const { fields, end } = ronStructAt(tokens, elementOpen, file);
    const tick = fields.get('tick');
    const text = fields.get('text');
    if (tick?.kind !== 'num' || !/^[0-9]+$/.test(tick.value) || text?.kind !== 'str') {
      throw new Error(`${file}:${t.line}: this caption needs a whole-number tick and a string text that this test can read.`);
    }
    captions.push({ tick: Number(tick.value), text: text.value });
    k = end;
    if (tokens[k]?.value === ',') k += 1;
    else if (tokens[k]?.value !== ']') throw new Error(`${file}:${tokens[k]?.line ?? t.line}: a caption is followed by something other than , or ].`);
  }
  return captions;
}

/**
 * The <Board> tags a reader sees: each one alone on its line, outside MDX comments, code blocks
 * and {...} expressions. `all` counts every `<Board` in the page, so a tag hidden in one of those
 * places, or written some other way, shows up as a difference between the two.
 */
function boardTagsOf(body: string): { shown: string[]; all: number } {
  const visible = blankHidden(body, 'blank');
  const shown: string[] = [];
  let depth = 0;
  for (const l of visible.split('\n')) {
    const tag = /^<Board\b[^>]*\/>\s*$/.exec(l);
    if (tag !== null && depth === 0) shown.push(tag[0].trim());
    for (const c of l) {
      if (c === '{') depth += 1;
      else if (c === '}') depth -= 1;
    }
  }
  return { shown, all: [...body.matchAll(/<Board\b/g)].length };
}

/**
 * The items a reader sees in the ordered list under `## How the board works`, without their `1. `
 * numbers. A numbered line or heading inside an MDX comment, a code block or inline code doesn't
 * count, and a comment at the end of a step is left out of its text.
 */
function stepsOf(mdx: string): string[] {
  const visible = blankHidden(mdx, 'blank').split('\n');
  const text = blankHidden(mdx, 'keep').split('\n');
  const start = visible.findIndex((l) => l.trimEnd() === '## How the board works');
  if (start < 0) return [];
  const steps: string[] = [];
  for (let i = start + 1; i < visible.length && !visible[i].startsWith('## '); i += 1) {
    if (/^\d+\.\s/.test(visible[i])) steps.push(text[i].replace(/^\d+\.\s+/, '').trimEnd());
  }
  return steps;
}

/** The board file for a page, or a problem line when it doesn't exist. */
function boardOf(file: string): { id: string; ron: string | null; problem: string | null } {
  const id = boardIdOf(file);
  const boardFile = boardFileOf(id);
  if (!fs.existsSync(boardFile)) {
    return { id, ron: null, problem: `${shown(file)}: ${boardShown(id)} doesn't exist. A pattern page's board file is named after the page.` };
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

test('each pattern page shows exactly one board, named for the page, and the bug page shows its board twice', () => {
  const problems: string[] = [];
  for (const file of patternFiles()) {
    const { shown: tags, all } = boardTagsOf(readPage(file).body);
    const want = boardTagsFor(file);
    if (tags.length !== want || all !== want) {
      const rule =
        want === 1
          ? `A pattern page shows its pattern running on exactly one board (only ${TWO_BOARD_PAGE} shows two)`
          : `${TWO_BOARD_PAGE} shows its board exactly twice`;
      problems.push(
        `${shown(file)} has ${tags.length} <Board> tags a reader sees and ${all} in the file. ${rule}, written as \`<Board name="..." />\` on a line of its own, outside comments, code blocks and {...}.`,
      );
      continue;
    }
    const id = boardIdOf(file);
    for (const tag of tags) {
      const name = /\bname="([^"]*)"/.exec(tag)?.[1] ?? '';
      if (name !== id) {
        problems.push(`${shown(file)} shows the board "${name}". Its board is ${id}, from ${boardShown(id)}.`);
      }
    }
  }
  noProblems(problems);
});

test("each pattern page's Factory code and Handler code blocks equal its board's Factory sources", () => {
  const problems: string[] = [];
  for (const file of patternFiles()) {
    const board = boardOf(file);
    if (board.ron === null) {
      problems.push(board.problem!);
      continue;
    }
    const blocks = pageCodeBlocks(readPage(file).text);
    const boardFile = boardShown(board.id);
    let sources: string[];
    try {
      sources = boardSources(board.ron, boardFile);
    } catch (error) {
      problems.push(`${shown(file)}: ${(error as Error).message}`);
      continue;
    }
    if (blocks.length === 0) {
      problems.push(`${shown(file)} has no js block titled "Factory code" or "Handler code".`);
      continue;
    }
    for (const block of blocks) {
      if (!sources.includes(block.code)) {
        problems.push(`${shown(file)}: its code block on line ${block.line} doesn't match any Factory in ${boardFile}. Copy the source from the board file.`);
      }
    }
    for (const source of new Set(sources)) {
      if (!blocks.some((b) => b.code === source)) {
        problems.push(`${shown(file)} has no Factory code or Handler code block for the Factory source starting "${source.split('\n')[0]}" in ${boardFile}. Copy the source from the board file.`);
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
    const boardFile = boardShown(board.id);
    const steps = stepsOf(readPage(file).body);
    let captions: { tick: number; text: string }[];
    try {
      captions = captionsOf(board.ron, boardFile);
    } catch (error) {
      problems.push(`${shown(file)}: ${(error as Error).message}`);
      continue;
    }
    if (steps.length !== captions.length) {
      problems.push(`${shown(file)}: How the board works has ${steps.length} steps and ${boardFile} has ${captions.length} captions.`);
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

test('the caption reader counts every element of captions, named or not, and fails on one it cannot read', () => {
  const board = (captions: string): string =>
    `Board(format: 2, title: "t", seed: 1, commands: [], script: [], captions: [${captions}], executor: Executor(), end_tick: 9)`;
  assert.deepEqual(
    captionsOf(board('Caption(tick: 3, highlight: 1, text: "a"), (text: "b (Caption(tick: 1))", highlight: 2, tick: 5,),'), 'x.board.ron'),
    [
      { tick: 3, text: 'a' },
      { tick: 5, text: 'b (Caption(tick: 1))' },
    ],
  );
  assert.deepEqual(captionsOf(board('/* Caption(tick: 1, highlight: 1, text: "c") */'), 'x.board.ron'), []);
  assert.throws(() => captionsOf(board('Caption(tick: 3, highlight: 1, text: "a"),\n  Note(tick: 4, highlight: 1, text: "b")'), 'x.board.ron'), /^Error: x\.board\.ron:2: /);
  assert.throws(() => captionsOf(board('(tick: 4, highlight: 1)'), 'x.board.ron'), /x\.board\.ron:1: this caption needs/);
});

test('the step reader skips numbered lines in a comment, a code block or inline code', () => {
  const page = [
    '## How the board works',
    '',
    '1. Tick 3: a',
    '{/*',
    '2. Tick 4: hidden',
    '*/}',
    '```text',
    '3. Tick 5: fenced',
    '```',
    '`4. Tick 6: inline`',
    '2. Tick 7: b `ctx.emit` {/* note */}',
    '',
    '{/* ## Hidden heading */}',
    '3. Tick 8: c',
    '',
    '## Next',
    '1. Tick 9: later',
  ].join('\n');
  assert.deepEqual(stepsOf(page), ['Tick 3: a', 'Tick 7: b `ctx.emit`', 'Tick 8: c']);
  assert.deepEqual(stepsOf('{/*\n## How the board works\n\n1. Tick 1: a\n*/}'), []);
});

test('the code block reader takes Factory code and Handler code blocks and skips one in a comment or inside another fenced block', () => {
  const page = [
    '```js title="Factory code"',
    'shown()',
    '```',
    '{/*',
    '```js title="Factory code"',
    'hidden()',
    '```',
    '*/}',
    '````md',
    '```js title="Factory code"',
    'fenced()',
    '```',
    '````',
    '```js title="Factory code"',
    'if (x) {/* not a comment */}',
    '```',
    '```js title="Handler code"',
    'handler()',
    '```',
    '```js title="Other code"',
    'other()',
    '```',
  ].join('\n');
  assert.deepEqual(pageCodeBlocks(page), [
    { line: 1, code: 'shown()' },
    { line: 14, code: 'if (x) {/* not a comment */}' },
    { line: 17, code: 'handler()' },
  ]);
});

test('each pattern page whose board has faultsAbout states faults in its frontmatter', () => {
  const problems: string[] = [];
  for (const file of patternFiles()) {
    const { field, body } = readPage(file);
    if (field('faults') !== '') continue;
    for (const tag of boardTagsOf(body).shown) {
      if (!/\bfaultsAbout=/.test(tag)) continue;
      const id = /\bname="([^"]*)"/.exec(tag)?.[1] ?? '';
      problems.push(
        `${shown(file)}: board "${id}" has faultsAbout, and the page has no faults in its frontmatter. Add faults: with the number of FAULT rows the board's effect log shows at its end tick.`,
      );
    }
  }
  noProblems(problems);
});

/** A typed fault count in a page body: a number, a space and "fault" or "faults", in any case. */
const TYPED_COUNT = /\b\d+ faults?\b/gi;

test('a pattern page with faults writes the count as {frontmatter.faults}, never as a typed number', () => {
  const problems: string[] = [];
  for (const file of patternFiles()) {
    const { field, body } = readPage(file);
    if (field('faults') === '') continue;
    for (const match of blankHidden(body, 'blank').matchAll(TYPED_COUNT)) {
      problems.push(
        `${shown(file)} types "${match[0]}" in its body. Write the count as {frontmatter.faults} so the page and the docs suite read the same number.`,
      );
    }
  }
  noProblems(problems);
});

test('a shipped board page maps to its example board file, and every other page to its docs board', () => {
  assert.equal(boardIdOf('order-processing.mdx'), 'order_processing');
  assert.equal(boardShown(boardIdOf('order-processing.mdx')), 'examples/boards/order_processing.board.ron');
  assert.equal(boardShown(boardIdOf('rate-limit.mdx')), 'examples/boards/docs/patterns-rate-limit.board.ron');
  assert.ok(fs.existsSync(boardFileOf('order_processing')), 'examples/boards/order_processing.board.ron is missing');
  assert.equal(boardTagsFor('reproduce-a-bug.mdx'), 2);
  assert.equal(boardTagsFor('rate-limit.mdx'), 1);
});

test('the typed-count check reads prose and skips code, inline code and comments', () => {
  const body = ['It shows 2 faults.', '`3 faults`', '{/* 4 faults */}', '```text', '5 faults', '```', 'and 1 FAULT row, then {frontmatter.faults} faults.'].join('\n');
  assert.deepEqual(
    [...blankHidden(body, 'blank').matchAll(TYPED_COUNT)].map((m) => m[0]),
    ['2 faults', '1 FAULT'],
  );
});
