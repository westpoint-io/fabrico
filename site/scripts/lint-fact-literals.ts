// lint-fact-literals.ts - fails a docs page that types a value from the code as prose.
//
// Run it with `npm run lint:facts` from site/. Values from the code reach a page only through
// <Fact id="..." />, so the page changes when the code does. This lint reads every tracked .md
// and .mdx file under site/ (from `git ls-files`, so node_modules is never read) and reports:
//   - a quantity fact's value followed by its unit or one of its other spellings, such as
//     "60 ticks a second" or "1,024 tiles", with or without the thousands separator, in any case.
//     A spelling in `also` that starts with a digit is a whole phrase, such as "8 MiB". A bare
//     number, or a number with some other unit ("step 60", "60 items", "2 ticks"), passes;
//   - a text fact longer than 20 characters, such as a refusal message, pasted word for word;
//   - a raw <fabrico-board> tag in an .mdx page, which skips the build's board-name check.
// Frontmatter, fenced code blocks and <Fact .../> elements are skipped. Line and column numbers
// count from the top of the file, frontmatter included.
//
// The patterns come from src/generated/facts.json, so a new fact is checked with no change here.
//
// OUTPUT: one line per finding on stderr, in the docs site's message format, then one line on
// stdout:
//   FACT_LINT files=<n> facts=<n> findings=<n>
// where facts counts the facts that made a pattern (quantities, and text longer than 20 characters).
//
// EXIT CODES
//   0  no findings.
//   1  at least one finding.
//   2  no check: fewer than 8 files scanned, git couldn't list them, or facts.json is missing or
//      isn't the expected JSON.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The fewest files a real scan reads. Fewer means the scan set is broken, not that pages are clean. */
export const MIN_FILES = 8;

/** A text fact shorter than this is too likely to appear in prose by chance. */
export const MIN_TEXT_LENGTH = 21;

export interface LintFile {
  /** The path printed in messages, such as site/src/content/docs/concepts/index.mdx. */
  path: string;
  text: string;
}

export interface LintFact {
  kind: string;
  value?: unknown;
  unit?: unknown;
  also?: unknown;
}

export interface Finding {
  path: string;
  line: number;
  col: number;
  message: string;
}

/** The text with frontmatter, fenced code and <Fact .../> elements turned to spaces, newlines kept. */
export function blank(text: string): string {
  const spaces = (s: string): string => s.replace(/[^\n]/g, ' ');
  let out = text;
  const front = /^---\r?\n[\s\S]*?\r?\n---(?=\r?\n|$)/.exec(out);
  if (front !== null) out = spaces(front[0]) + out.slice(front[0].length);

  const lines = out.split('\n');
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(lines[i]);
    if (fence === null) {
      if (open !== null) {
        fence = open[1];
        lines[i] = spaces(lines[i]);
      }
    } else {
      const closes = open !== null && open[1][0] === fence[0] && open[1].length >= fence.length && lines[i].trim() === open[1];
      lines[i] = spaces(lines[i]);
      if (closes) fence = null;
    }
  }
  out = lines.join('\n');
  return out.replace(/<Fact\b[^>]*\/>/g, spaces);
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A phrase as a pattern where any run of white space may be any other (a line break, say). */
function phrase(s: string): string {
  return s.trim().split(/\s+/).map(escape).join('\\s+');
}

interface Rule {
  id: string;
  pattern: RegExp;
}

/** The rules the facts make, in id order. */
export function rulesOf(facts: Record<string, LintFact>): Rule[] {
  const rules: Rule[] = [];
  for (const id of Object.keys(facts).sort()) {
    const fact = facts[id];
    if (fact.kind === 'quantity' && typeof fact.value === 'number' && typeof fact.unit === 'string' && fact.unit !== '') {
      const also = Array.isArray(fact.also) ? fact.also.filter((a): a is string => typeof a === 'string' && a !== '') : [];
      // Longest first, so "MiB of memory" is matched whole rather than stopping at "MiB".
      const units = [fact.unit, ...also.filter((a) => !/^[-\d]/.test(a))].sort((a, b) => b.length - a.length);
      const values = [...new Set([String(fact.value), fact.value.toLocaleString('en-US')])];
      const alternatives = [`(?:${values.map(escape).join('|')})\\s+(?:${units.map(phrase).join('|')})`];
      for (const whole of also.filter((a) => /^[-\d]/.test(a))) alternatives.push(phrase(whole));
      rules.push({ id, pattern: new RegExp(`(?<![\\w.,-])(?:${alternatives.join('|')})(?!\\w)`, 'gi') });
    } else if (fact.kind === 'text' && typeof fact.value === 'string' && fact.value.length >= MIN_TEXT_LENGTH) {
      rules.push({ id, pattern: new RegExp(phrase(fact.value), 'g') });
    }
  }
  return rules;
}

function position(text: string, index: number): { line: number; col: number } {
  const before = text.slice(0, index);
  const line = before.split('\n').length;
  return { line, col: index - before.lastIndexOf('\n') };
}

/** Every finding in the files, in file order then position. Overlapping matches report once. */
export function lintFiles(files: readonly LintFile[], facts: Record<string, LintFact>): Finding[] {
  const rules = rulesOf(facts);
  const findings: Finding[] = [];
  for (const file of files) {
    const text = blank(file.text);
    const hits: { start: number; end: number; message: string }[] = [];
    for (const rule of rules) {
      rule.pattern.lastIndex = 0;
      for (const m of text.matchAll(rule.pattern)) {
        const shown = m[0].replace(/\s+/g, ' ');
        hits.push({
          start: m.index,
          end: m.index + m[0].length,
          message: `"${shown}" types the generated fact ${rule.id} as prose. Write <Fact id="${rule.id}" /> so the page changes when the code does.`,
        });
      }
    }
    if (file.path.endsWith('.mdx')) {
      for (const m of text.matchAll(/<fabrico-board\b/gi)) {
        hits.push({
          start: m.index,
          end: m.index + m[0].length,
          message: 'write <Board name="..." /> here, not <fabrico-board>, so the build checks the board name.',
        });
      }
    }
    hits.sort((a, b) => a.start - b.start || b.end - a.end);
    let reached = -1;
    for (const hit of hits) {
      if (hit.start < reached) continue;
      reached = hit.end;
      findings.push({ path: file.path, ...position(file.text, hit.start), message: hit.message });
    }
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

/** The whole command over a site folder: list its tracked pages, read facts.json, lint, report. */
export function run(siteDir: string): RunResult {
  const stderr: string[] = [];
  const noCheck = (message: string): RunResult => ({ code: 2, stdout: [], stderr: [...stderr, `lint-fact-literals: ${message}`] });

  const factsFile = path.join(siteDir, 'src/generated/facts.json');
  let facts: Record<string, LintFact>;
  try {
    const parsed = JSON.parse(fs.readFileSync(factsFile, 'utf8')) as { facts?: unknown };
    if (typeof parsed.facts !== 'object' || parsed.facts === null || Array.isArray(parsed.facts)) {
      return noCheck(`${factsFile} has no "facts" object. Regenerate it with npm run facts.`);
    }
    facts = parsed.facts as Record<string, LintFact>;
  } catch (err) {
    return noCheck(`can't read ${factsFile}: ${err instanceof Error ? err.message : String(err)}. Regenerate it with npm run facts.`);
  }

  const listed = spawnSync('git', ['ls-files', '-z', '--', '*.md', '*.mdx'], { cwd: siteDir, encoding: 'utf8' });
  if (listed.error !== undefined || listed.status !== 0) {
    return noCheck(`git ls-files failed in ${siteDir}: ${listed.error?.message ?? listed.stderr.trim()}`);
  }
  const rels = listed.stdout.split('\0').filter((p) => p !== '').sort();
  if (rels.length < MIN_FILES) {
    return noCheck(`scanned ${rels.length} files, fewer than ${MIN_FILES}. The scan set is broken, so this is no check.`);
  }

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

  const findings = lintFiles(files, facts);
  for (const f of findings) stderr.push(formatFinding(f));
  return {
    code: findings.length === 0 ? 0 : 1,
    stdout: [`FACT_LINT files=${files.length} facts=${rulesOf(facts).length} findings=${findings.length}`],
    stderr,
  };
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = run(fileURLToPath(new URL('..', import.meta.url)));
  for (const line of result.stderr) console.error(line);
  for (const line of result.stdout) console.log(line);
  process.exit(result.code);
}
