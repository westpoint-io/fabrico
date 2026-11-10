import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';

// The built site holds nothing private. scripts/check-no-private-residue.sh reads tracked files
// only, and site/dist/ and site/dist-fixtures/ are build output, so this spec reads them from disk
// instead. Every text file in both folders must hold no sourceMappingURL comment, no home folder
// path, no absolute path of this checkout and no pointer into the private planning folder. The
// built HTML and XML must also hold none of the planning ids the residue gate refuses under site/.
//
// The id patterns and the allowed tokens (real names such as `UTF-16` that have the requirement-id
// shape) are read from the residue gate at run time, so the two can't drift apart. They apply to HTML
// and XML only: minified JavaScript, ours or a dependency's, can hold a string such as `D-10` as code.

const REPO = path.resolve(import.meta.dirname, '../..');
const FOLDERS = [path.join(REPO, 'site/dist'), path.join(REPO, 'site/dist-fixtures')];
const RESIDUE_GATE = path.join(REPO, 'scripts/check-no-private-residue.sh');

/** The file extensions read as text. Everything else (images, fonts, the search index) is binary. */
const TEXT_EXTENSIONS = new Set(['.html', '.js', '.mjs', '.css', '.json', '.xml', '.txt', '.svg', '.webmanifest']);

/** The extensions the planning-id patterns apply to. */
const ID_EXTENSIONS = new Set(['.html', '.xml']);

/** The fewest HTML pages a real build of either folder holds. */
const MIN_HTML = 8;

/**
 * Files copied verbatim from a pinned dependency that may keep a sourceMappingURL comment, by path
 * under the build folder, with the package they come from. Empty: nothing in the build needs one.
 */
const SOURCE_MAP_ALLOWED: ReadonlyMap<string, string> = new Map();

/** The private planning folder, built in two parts so this file doesn't hold the path itself. */
const PLANNING_PATH = ['.plan', 'ning/'].join('');

/** Every file under a folder, as paths relative to it, sorted. */
function walk(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) out.push(path.relative(root, full));
    }
  };
  visit(root);
  return out.sort();
}

/**
 * The residue gate's site/ id patterns, as `{ label, pattern }`, read from its SITE_PATTERNS array,
 * and its allowed tokens. Throws unless exactly four patterns and at least one token come out, so a
 * change to the gate's layout fails here loudly.
 *
 * The gate's ERE boundaries `(^|[^A-Za-z0-9])` and `([^A-Za-z0-9]|$)` become lookarounds here. As
 * written they take the character beside a match, so a global search would skip `GATE-07` right after
 * `UTF-16 ` (the space already taken), and the allowed token would hide the id beside it. The gate
 * reads whole lines with grep, which has no such gap.
 */
function sitePatterns(): { patterns: { label: string; pattern: RegExp }[]; allowed: Set<string> } {
  const gate = fs.readFileSync(RESIDUE_GATE, 'utf8');
  const prefix = /^REQ_PREFIX='([^']+)'$/m.exec(gate);
  const tokens = /^SITE_ALLOWED_TOKENS='([^']*)'$/m.exec(gate);
  const block = /^SITE_PATTERNS=\(\n([\s\S]*?)\n\)$/m.exec(gate);
  if (prefix === null || tokens === null || block === null) {
    throw new Error(`${RESIDUE_GATE} has no REQ_PREFIX line, SITE_ALLOWED_TOKENS line or SITE_PATTERNS array to read`);
  }
  const patterns = block[1]
    .split('\n')
    .map((line) => /^\s*"([^\t"]+)\t([-i])\t(.+)"$/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({
      label: m[1],
      pattern: new RegExp(
        m[3]
          .replaceAll('${REQ_PREFIX}', prefix[1])
          .replaceAll('(^|[^A-Za-z0-9])', '(?<![A-Za-z0-9])')
          .replaceAll('([^A-Za-z0-9]|$)', '(?![A-Za-z0-9])'),
        m[2] === 'i' ? 'gim' : 'gm',
      ),
    }));
  if (patterns.length !== 4) {
    throw new Error(`read ${patterns.length} site/ patterns from ${RESIDUE_GATE}, expected 4`);
  }
  const allowed = new Set(tokens[1].split(/\s+/).filter((t) => t !== ''));
  if (allowed.size === 0) throw new Error(`read no allowed token from ${RESIDUE_GATE}`);
  return { patterns, allowed };
}

/**
 * True when a match is an allowed token standing alone, with no letter, digit or hyphen on either
 * side: the gate's rule, which excuses a whole run of letters, digits and hyphens and nothing else.
 */
function isAllowedToken(text: string, index: number, token: string, allowed: Set<string>): boolean {
  if (!allowed.has(token)) return false;
  const before = index === 0 ? '' : text[index - 1];
  const after = text[index + token.length] ?? '';
  return !/[A-Za-z0-9-]/.test(before) && !/[A-Za-z0-9-]/.test(after);
}

/**
 * What one built file must not hold, as one line per finding. `rel` is the path under the build
 * folder, `shown` the path printed in the finding.
 */
function leaksIn(rel: string, shown: string, text: string, ids: ReturnType<typeof sitePatterns>): string[] {
  const out: string[] = [];
  const home = os.homedir();
  if (text.includes('sourceMappingURL') && !SOURCE_MAP_ALLOWED.has(rel)) out.push(`${shown}: a sourceMappingURL comment`);
  if (home !== '' && home !== '/' && text.includes(home)) out.push(`${shown}: the home folder path ${home}`);
  if (text.includes(REPO)) out.push(`${shown}: the repo path ${REPO}`);
  if (text.includes(PLANNING_PATH)) out.push(`${shown}: the private planning path ${PLANNING_PATH}`);
  if (ID_EXTENSIONS.has(path.extname(rel))) {
    for (const { label, pattern } of ids.patterns) {
      pattern.lastIndex = 0;
      for (const m of text.matchAll(pattern)) {
        if (isAllowedToken(text, m.index, m[0], ids.allowed)) continue;
        out.push(`${shown}: ${label}: "${m[0].trim()}"`);
      }
    }
  }
  return out;
}

test('the id patterns refuse a requirement id with any prefix and excuse an allowed token only when it stands alone', () => {
  const ids = sitePatterns();
  const scan = (text: string): string[] => leaksIn('probe.html', 'probe.html', text, ids);
  const req = 'requirement id under site/';
  expect(scan('<p>This closes GATE-07.</p>'), 'an id from outside the docs workstream').toEqual([`probe.html: ${req}: "GATE-07"`]);
  expect(scan('<p>Generated facts cover SITE-04.</p>'), 'an id from the docs workstream').toEqual([`probe.html: ${req}: "SITE-04"`]);
  expect(scan('<p>A file saved as UTF-16 has a byte-order mark.</p>'), 'an allowed token').toEqual([]);
  expect(scan('<p>UTF-16 GATE-07</p>'), 'an allowed token right before an id').toEqual([`probe.html: ${req}: "GATE-07"`]);
  expect(scan('<p>x-UTF-16</p>'), 'an allowed token inside a longer run').toEqual([`probe.html: ${req}: "UTF-16"`]);
  expect(scan('<p>Built 2026-11-09, UTF-8, ISO-8601, SHA-256.</p>'), 'a date and tokens of other shapes').toEqual([]);
});

for (const folder of FOLDERS) {
  const name = path.relative(REPO, folder);

  test(`${name} holds no source map, home path, repo path, planning path or planning id`, () => {
    expect(fs.existsSync(path.join(folder, 'index.html')), `${name}/index.html exists; run scripts/build-site.sh`).toBe(true);
    const ids = sitePatterns();
    const files = walk(folder).filter((rel) => TEXT_EXTENSIONS.has(path.extname(rel)));
    const html = files.filter((rel) => rel.endsWith('.html'));
    expect(html.length, `${name} holds at least ${MIN_HTML} HTML pages`).toBeGreaterThanOrEqual(MIN_HTML);

    const found: string[] = [];
    for (const rel of files) found.push(...leaksIn(rel, `${name}/${rel}`, fs.readFileSync(path.join(folder, rel), 'utf8'), ids));
    for (const rel of SOURCE_MAP_ALLOWED.keys()) {
      expect(files, `the allowed source-map file ${rel} still exists in ${name}`).toContain(rel);
    }
    console.log(`LEAK_SCAN ${name} text_files=${files.length} html=${html.length} findings=${found.length}`);
    expect(found, `${name} leaks:\n${found.join('\n')}`).toEqual([]);
  });
}
