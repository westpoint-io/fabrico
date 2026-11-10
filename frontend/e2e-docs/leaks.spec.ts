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
// The id patterns are read from the residue gate at run time, so the two can't drift apart. They
// apply to HTML and XML only: minified JavaScript, ours or a dependency's, can hold a string such as
// `D-10` as code.

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
 * The residue gate's site/ id patterns, as `{ label, pattern }`, read from its SITE_PATTERNS array.
 * Throws unless exactly four come out, so a change to the gate's layout fails here loudly.
 */
function sitePatterns(): { label: string; pattern: RegExp }[] {
  const gate = fs.readFileSync(RESIDUE_GATE, 'utf8');
  const prefixes = /^REQ_PREFIXES='([^']+)'$/m.exec(gate);
  const block = /^SITE_PATTERNS=\(\n([\s\S]*?)\n\)$/m.exec(gate);
  if (prefixes === null || block === null) {
    throw new Error(`${RESIDUE_GATE} has no REQ_PREFIXES line or SITE_PATTERNS array to read`);
  }
  const patterns = block[1]
    .split('\n')
    .map((line) => /^\s*"([^\t"]+)\t([-i])\t(.+)"$/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({
      label: m[1],
      pattern: new RegExp(m[3].replaceAll('${REQ_PREFIXES}', prefixes[1]), m[2] === 'i' ? 'gim' : 'gm'),
    }));
  if (patterns.length !== 4) {
    throw new Error(`read ${patterns.length} site/ patterns from ${RESIDUE_GATE}, expected 4`);
  }
  return patterns;
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
    for (const { label, pattern } of ids) {
      pattern.lastIndex = 0;
      for (const m of text.matchAll(pattern)) out.push(`${shown}: ${label}: "${m[0].trim()}"`);
    }
  }
  return out;
}

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
