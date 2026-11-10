// lint-prose.ts - fails a docs page that holds an em dash or a banned phrase.
//
// Run it with `npm run lint:prose` from site/. It reads every tracked .md and .mdx file under
// site/ (from `git ls-files`, so node_modules and build output are never read) and reports:
//   - every em dash (U+2014), on any line: prose, frontmatter and fenced code alike. An en dash
//     (U+2013) passes;
//   - every phrase from BANNED_PHRASES in prose, in any letter case, with a straight or a curly
//     apostrophe, and where a line break sits between two of its words. Frontmatter and fenced
//     code blocks are skipped for phrases. A listed word inside a longer word ("crucially")
//     passes.
// Line and column numbers count from the top of the file, frontmatter included.
//
// The lint is the machine half of the prose rules. The other half is a person reading each page
// before it merges.
//
// OUTPUT: one line per finding on stderr, in the docs site's message format, then one line on
// stdout:
//   PROSE_LINT files=<n> findings=<n>
//
// EXIT CODES
//   0  no findings.
//   1  at least one finding.
//   2  no check: fewer than 8 files scanned, or git couldn't list them.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { blank } from './lint-fact-literals.ts';

/** The fewest files a real scan reads. Fewer means the scan set is broken, not that pages are clean. */
export const MIN_FILES = 8;

/** The em dash, written as an escape so this file doesn't hold one. */
const EM_DASH = '—';

/** Phrases that read as filler or as machine-written prose. Lowercase, straight apostrophes. */
export const BANNED_PHRASES: readonly string[] = [
  'quietly',
  'load-bearing',
  'delve',
  'delves',
  'delved',
  'tapestry',
  'pivotal',
  'testament to',
  'seamless',
  'seamlessly',
  'underscore',
  'underscores',
  'crucial',
  "let's dive",
  "here's the thing",
  "that's the real",
  'the real win',
  'let that sink in',
  "it's worth noting",
];

export interface LintFile {
  /** The path printed in messages, such as site/src/content/docs/patterns/index.mdx. */
  path: string;
  text: string;
}

export interface Finding {
  path: string;
  line: number;
  col: number;
  message: string;
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The phrase as a pattern: any run of white space may be any other, an apostrophe may be curly. */
function phrasePattern(phrase: string): RegExp {
  const body = phrase
    .split(/\s+/)
    .map((word) => escape(word).replaceAll("'", "['’]"))
    .join('\\s+');
  return new RegExp(`(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])`, 'giu');
}

const PHRASE_RULES = BANNED_PHRASES.map((phrase) => ({ phrase, pattern: phrasePattern(phrase) }));

function position(text: string, index: number): { line: number; col: number } {
  const before = text.slice(0, index);
  const line = before.split('\n').length;
  return { line, col: index - before.lastIndexOf('\n') };
}

/** Every finding in the files, in file order then position. Overlapping phrase matches report once. */
export function lintFiles(files: readonly LintFile[]): Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    const hits: { start: number; end: number; message: string }[] = [];

    for (let i = file.text.indexOf(EM_DASH); i !== -1; i = file.text.indexOf(EM_DASH, i + 1)) {
      hits.push({ start: i, end: i + 1, message: 'em dash (U+2014). Use a comma, a colon, parentheses or two sentences.' });
    }

    const prose = blank(file.text);
    const phraseHits: typeof hits = [];
    for (const rule of PHRASE_RULES) {
      rule.pattern.lastIndex = 0;
      for (const m of prose.matchAll(rule.pattern)) {
        phraseHits.push({ start: m.index, end: m.index + m[0].length, message: `banned phrase "${rule.phrase}". Say it plainly.` });
      }
    }
    phraseHits.sort((a, b) => a.start - b.start || b.end - a.end);
    let reached = -1;
    for (const hit of phraseHits) {
      if (hit.start < reached) continue;
      reached = hit.end;
      hits.push(hit);
    }

    hits.sort((a, b) => a.start - b.start);
    for (const hit of hits) findings.push({ path: file.path, ...position(file.text, hit.start), message: hit.message });
  }
  return findings;
}

/** The finding as the line an author reads. */
export function formatFinding(f: Finding): string {
  return `${f.path}:${f.line}:${f.col}: ${f.message}`;
}

export interface RunResult {
  code: 0 | 1 | 2;
  stdout: string[];
  stderr: string[];
}

/** The whole command over a site folder: list its tracked pages, lint, report. */
export function run(siteDir: string): RunResult {
  const noCheck = (message: string): RunResult => ({ code: 2, stdout: [], stderr: [`lint-prose: ${message}`] });

  const listed = spawnSync('git', ['ls-files', '-z', '--', '*.md', '*.mdx'], { cwd: siteDir, encoding: 'utf8' });
  if (listed.error !== undefined || listed.status !== 0) {
    return noCheck(`git ls-files failed in ${siteDir}: ${listed.error?.message ?? listed.stderr.trim()}`);
  }
  const rels = listed.stdout.split('\0').filter((p) => p !== '').sort();

  const prefix = path.basename(siteDir) === 'site' ? 'site/' : '';
  const files: LintFile[] = [];
  for (const rel of rels) {
    const full = path.join(siteDir, rel);
    if (!fs.existsSync(full)) continue; // deleted in the working tree, not yet in the index
    files.push({ path: `${prefix}${rel}`, text: fs.readFileSync(full, 'utf8') });
  }
  if (files.length < MIN_FILES) {
    return noCheck(`scanned ${files.length} files, fewer than ${MIN_FILES}. The scan set is broken, so this is no check.`);
  }

  const findings = lintFiles(files);
  return {
    code: findings.length === 0 ? 0 : 1,
    stdout: [`PROSE_LINT files=${files.length} findings=${findings.length}`],
    stderr: findings.map(formatFinding),
  };
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = run(fileURLToPath(new URL('..', import.meta.url)));
  for (const line of result.stderr) console.error(line);
  for (const line of result.stdout) console.log(line);
  process.exit(result.code);
}
