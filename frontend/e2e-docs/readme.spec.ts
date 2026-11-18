import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { curlBlocksOf, fencesOf, parseFirstWebhookCurl, README_PATH, type Fence } from '../e2e-live/support/pageCurl.ts';
import { PUBLISHED_ROOT } from './support/site.ts';

// The repository README, held to what it points at and to the site it repeats.
//
// - Every relative link and image path is a file git tracks, so a clone or a fork shows it.
// - Every link or image under the Pages address maps to a page, a file or an anchor in the built
//   site in site/dist/ (build it first with scripts/build-site.sh).
// - The README has exactly one bash block that starts with curl, and the parser the live specs
//   run accepts it (`pageCurl.ts`), so a README-only push that breaks the command fails here.
// - The install block's commands are the install page's Linux tab, steps 1 to 4, in order.
// - The pitch is the lead on What is Fabrico, word for word, with the bold markers taken out.
// - The h2 headings, in order, and the file's length.
//
// Every file is read from disk at run time. Nothing here imports from site/, because a change
// that touches only the README or the site doesn't run the frontend's type check.

const REPO = path.resolve(import.meta.dirname, '../..');
const DIST = path.join(REPO, 'site/dist');
const DOCS = path.join(REPO, 'site/src/content/docs');
const README = fs.readFileSync(README_PATH, 'utf8');

/** The README's h2 headings, in order. */
const H2_ORDER = ['Install', 'Quickstart', 'Links', 'Status', 'Licence'];
/** `wc -l README.md` must fall in this range (about 120 lines). */
const MIN_LINES = 100;
const MAX_LINES = 140;

/** Every link and image target in the README: Markdown links, autolinks, and src, href and srcset attributes. */
function targetsOf(md: string): string[] {
  const out: string[] = [];
  for (const m of md.matchAll(/\]\(([^)\s]+)\)/g)) out.push(m[1]);
  for (const m of md.matchAll(/<(https?:\/\/[^>\s]+)>/g)) out.push(m[1]);
  for (const m of md.matchAll(/\b(?:src|href|srcset)="([^"]+)"/g)) out.push(m[1]);
  return out;
}

const isAbsolute = (target: string): boolean => /^[a-z][a-z0-9+.-]*:/i.test(target);

/** The built file a Pages path maps to, or null when site/dist has none. */
function builtFileFor(sitePath: string): string | null {
  const candidates = sitePath === '' || sitePath.endsWith('/') ? [`${sitePath}index.html`] : [sitePath, `${sitePath}/index.html`];
  for (const rel of candidates) {
    const file = path.join(DIST, rel);
    if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
  }
  return null;
}

/** The text between a line and the next h2, or the end of the file. */
function sectionOf(md: string, heading: string): string {
  const start = md.indexOf(`\n## ${heading}\n`);
  if (start < 0) throw new Error(`README.md has no "## ${heading}" heading`);
  const next = md.indexOf('\n## ', start + 1);
  return md.slice(start, next < 0 ? undefined : next);
}

const trimmed = (fence: Fence): string[] => fence.lines.map((l) => l.trim()).filter((l) => l !== '');
const words = (text: string): string => text.replace(/\s+/g, ' ').trim();

test.beforeAll(() => {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    throw new Error(`${DIST}/index.html is missing. Run scripts/build-site.sh first.`);
  }
});

test('README: every relative link and image path is a file git tracks', () => {
  const relative = [...new Set(targetsOf(README).filter((t) => !isAbsolute(t) && !t.startsWith('#')))];
  expect(relative.length, 'the README links at least one file in the repository').toBeGreaterThan(0);
  for (const target of relative) {
    const file = decodeURIComponent(target.split('#')[0]);
    let tracked = true;
    try {
      execFileSync('git', ['ls-files', '--error-unmatch', '--', file], { cwd: REPO, stdio: 'ignore' });
    } catch {
      tracked = false;
    }
    expect(tracked, `README.md links ${file}, and no such file exists in the tree.`).toBe(true);
  }
});

test('README: every link and image under the Pages address maps to a page, file or anchor in the built site', () => {
  const site = [...new Set(targetsOf(README).filter((t) => t.startsWith(PUBLISHED_ROOT)))];
  expect(site.length, 'the README links at least one page on the site').toBeGreaterThan(0);
  for (const url of site) {
    const [rest, fragment] = url.slice(PUBLISHED_ROOT.length).split('#');
    const sitePath = decodeURIComponent(rest);
    const file = builtFileFor(sitePath);
    expect(file, `README.md links ${url}, and the built site has no page at ${path.join('site/dist', sitePath)}.`).not.toBeNull();
    if (fragment !== undefined && file !== null) {
      const html = fs.readFileSync(file, 'utf8');
      expect(html.includes(`id="${fragment}"`), `README.md links ${url}, and the built page ${path.relative(REPO, file)} has no element with id ${fragment}.`).toBe(true);
    }
  }
});

test('README: exactly one bash block starts with curl, and the live specs\' parser accepts it', () => {
  const blocks = curlBlocksOf(README);
  expect(blocks.length, `README.md has ${blocks.length} bash blocks that start with curl, expected 1.`).toBe(1);
  const curl = parseFirstWebhookCurl(README);
  expect(curl.deliveryId, 'the command sends the delivery id readme-1').toBe('readme-1');
  expect(JSON.parse(curl.body), 'the body is the first order the Order processing board sends').toEqual({
    id: 'ord-1',
    items: [{ sku: 'widget', qty: 2, price: 5 }],
  });
});

test('README: the Linux build commands equal the install page\'s Linux tab, steps 1 to 4', () => {
  const install = fs.readFileSync(path.join(DOCS, 'get-started/install.mdx'), 'utf8');
  const linuxStart = install.indexOf('<TabItem label="Linux">');
  const linuxEnd = install.indexOf('</TabItem>', linuxStart);
  expect(linuxStart, 'the install page has a Linux tab').toBeGreaterThanOrEqual(0);
  const tabBlocks = fencesOf(install.slice(linuxStart, linuxEnd)).filter((f) => f.lang === 'bash');
  expect(tabBlocks.length, 'the Linux tab has at least 5 bash blocks (steps 1 to 5)').toBeGreaterThanOrEqual(5);
  const pageLines = tabBlocks.slice(0, 4).flatMap(trimmed);

  const readmeBlocks = fencesOf(sectionOf(README, 'Install')).filter((f) => f.lang === 'bash');
  expect(readmeBlocks.length, 'README.md\'s Install section has one bash block').toBe(1);
  const readmeLines = trimmed(readmeBlocks[0]);

  const longest = Math.max(readmeLines.length, pageLines.length);
  for (let k = 0; k < longest; k += 1) {
    const mine = readmeLines[k] ?? '(no line)';
    const theirs = pageLines[k] ?? '(no line)';
    expect(mine, `README.md's Linux build commands differ from the install page's Linux tab at line ${k + 1}: ${mine} vs ${theirs}.`).toBe(theirs);
  }
});

test('README: the pitch is the lead on get-started/index.mdx, word for word', () => {
  const page = fs.readFileSync(path.join(DOCS, 'get-started/index.mdx'), 'utf8');
  const lead = /<div data-pagefind-meta="lead">\s*([\s\S]*?)\s*<\/div>/.exec(page);
  expect(lead, 'get-started/index.mdx has its lead block').not.toBeNull();
  const afterHero = README.slice(README.indexOf('</picture></a></p>') + '</picture></a></p>'.length).trimStart();
  const pitch = afterHero.slice(0, afterHero.indexOf('\n\n')).replaceAll('**', '');
  expect(words(pitch), "README.md's pitch differs from the lead on get-started/index.mdx.").toBe(words(lead![1]));
});

test('README: no h1, and the h2 headings are Install, Quickstart, Links, Status and Licence, in order', () => {
  const outside = README.replace(/^\s*```[\s\S]*?^\s*```\s*$/gm, '');
  expect(outside.match(/^# /gm), 'README.md has an h1; the lockup is the title').toBeNull();
  const h2 = [...outside.matchAll(/^## (.+)$/gm)].map((m) => m[1].trim());
  expect(h2, `README.md's h2 headings are ${h2.join(', ')}, expected ${H2_ORDER.join(', ')}.`).toEqual(H2_ORDER);
});

test('README: 100 to 140 lines', () => {
  const lines = (README.match(/\n/g) ?? []).length;
  expect(lines >= MIN_LINES && lines <= MAX_LINES, `README.md is ${lines} lines, expected ${MIN_LINES} to ${MAX_LINES}.`).toBe(true);
});
