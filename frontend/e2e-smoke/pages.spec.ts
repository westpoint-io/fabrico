import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
  autoContinueCaptions,
  expectBoardDrawingSteppedAt,
  glCounts,
  installGlCounter,
  manifestLine,
  readProbeAt,
  recordConsoleErrors,
  watchPageErrors,
} from '../e2e-embed/support/health.ts';
import { boardNames, distFileFor, locsOf, PUBLISHED_ROOT, toLocal } from '../e2e-docs/support/site.ts';
import { readWebpInfo } from '../scripts/webp-info.ts';

// The Pages smoke: what a visitor meets on the deployed docs site, checked against this checkout.
//
// It runs over FABRICO_DOCS_URL, which is the live address in CI and a served copy of site/dist
// locally. Every URL the site publishes is written under PUBLISHED_ROOT and goes through toLocal,
// which maps it onto FABRICO_DOCS_URL (onto itself when that is the live address).
//
// The tests run in order and stop at the first failure:
//   1. build.json names FABRICO_SMOKE_SHA. Pages serves the previous deployment for a while after a
//      deploy, so the smoke polls build.json with a query no cache has seen until the sha matches,
//      and fails after FABRICO_SMOKE_POLL_CEILING_S seconds naming both shas. Every later test
//      checks that build, never the old one. When the site already serves a later commit (the next
//      push deployed first), it fails at once instead of polling to the ceiling, and
//      scripts/check-pages-smoke.sh turns that failure into its superseded exit 0 (review 101 WR-01).
//   2. One test per section of site/coverage-manifest.json, read at run time: the first listed page
//      whose HTML holds a <fabrico-board> runs each of its boards to the end tick hashes.manifest
//      pins, ends on the manifest's hash, and draws (frames rise and belt pixels change between
//      board ticks), with no page error, no console error and no WebGL context lost. A section with
//      no board page (Troubleshooting and Contributing today) loads its index page with no error.
//   3. sitemap-index.xml names sitemap-0.xml, and sitemap-0.xml lists every coverage-manifest
//      page, compared as a set, so the sitemap's order doesn't matter.
//   4. The hero is an animated WebP of more than one frame, served as image/webp, and its sidecar
//      names the sha256 of this checkout's demo board, so the picture comes from this commit.
//   5. Every absolute https link in README.md answers with a 2xx or 3xx status.
//
// Every wait is on board ticks or on build.json, never a fixed sleep for a result.

test.describe.configure({ mode: 'serial' });

const REPO = path.resolve(import.meta.dirname, '../..');
const DEMO_BOARD = 'examples/boards/demo_scene.board.ron';
const POLL_INTERVAL_MS = 10_000;
const POLL_CEILING_S = Number(process.env.FABRICO_SMOKE_POLL_CEILING_S ?? 900);

/** The site root the smoke runs over, ending in /fabrico/. */
function smokeRoot(): string {
  const root = process.env.FABRICO_DOCS_URL;
  if (root === undefined || root === '') {
    throw new Error('pages-smoke: FABRICO_DOCS_URL is unset. Run the smoke through scripts/check-pages-smoke.sh.');
  }
  return root.endsWith('/') ? root : `${root}/`;
}

/** The commit the deployed site must come from. */
function expectedSha(): string {
  const sha = process.env.FABRICO_SMOKE_SHA;
  if (sha === undefined || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`pages-smoke: FABRICO_SMOKE_SHA is "${sha ?? ''}", not a 40-character commit sha.`);
  }
  return sha;
}

/** A published URL (under PUBLISHED_ROOT), on the site the smoke runs over. */
const served = (published: string): string => toLocal(published, smokeRoot());

/** A response whose status is 200, or an error naming the URL and the status it got. */
async function fetchOk(url: string): Promise<Response> {
  const response = await fetch(url);
  if (response.status !== 200) throw new Error(`pages-smoke: ${url} answered ${response.status}, expected 200.`);
  return response;
}

/** A coverage-manifest source path to the URL the site publishes it at. */
function publishedUrlOf(sourcePath: string): string {
  return PUBLISHED_ROOT + distFileFor(sourcePath).replace(/(^|\/)index\.html$/, '$1');
}

interface Section {
  name: string;
  folder: string;
  pages: string[];
}
const sections: Section[] = (
  JSON.parse(fs.readFileSync(path.join(REPO, 'site/coverage-manifest.json'), 'utf8')) as { sections: Section[] }
).sections;

/**
 * Whether `served` is a later commit than `sha` on the same history, that is, `sha` is its ancestor.
 * A served commit git can't find locally (the CI checkout is shallow) is fetched from origin once.
 */
function isLaterCommit(sha: string, served: string, fetched: Set<string>): boolean {
  const git = (args: string[]): boolean => {
    try {
      execFileSync('git', args, { cwd: REPO, stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  };
  if (!git(['cat-file', '-e', `${served}^{commit}`]) && !fetched.has(served)) {
    fetched.add(served);
    git(['fetch', '--quiet', '--no-tags', 'origin', served]);
  }
  return git(['merge-base', '--is-ancestor', sha, served]);
}

test('the site serves the build of this commit', async () => {
  const sha = expectedSha();
  const url = `${smokeRoot()}build.json`;
  const run = process.env.GITHUB_RUN_ID ?? String(Date.now());
  test.setTimeout(POLL_CEILING_S * 1000 + 60_000);
  const deadline = Date.now() + POLL_CEILING_S * 1000;
  let polls = 0;
  let servedSha = 'none';
  const fetched = new Set<string>();
  for (;;) {
    polls += 1;
    try {
      const response = await fetch(`${url}?run=${run}-${polls}`, { headers: { 'cache-control': 'no-cache' } });
      if (response.status === 200) {
        const body = (await response.json()) as { sha?: unknown };
        servedSha = typeof body.sha === 'string' ? body.sha : `with no sha field`;
      } else {
        servedSha = `none (status ${response.status})`;
      }
    } catch (error) {
      servedSha = `none (${error instanceof Error ? error.message : String(error)})`;
    }
    console.log(`pages-smoke: poll ${polls}: ${url} serves build ${servedSha}`);
    if (servedSha === sha) return;
    if (/^[0-9a-f]{40}$/.test(servedSha) && isLaterCommit(sha, servedSha, fetched)) {
      throw new Error(`pages-smoke: ${url} serves build ${servedSha}, a later commit than ${sha}. That commit's smoke checks it.`);
    }
    if (Date.now() + POLL_INTERVAL_MS > deadline) break;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(`pages-smoke: ${url} served build ${servedSha}, expected ${sha} after ${polls} polls.`);
});

/** Run every board on an opened page to its end tick, as boards.spec.ts does, and check its hash. */
async function runBoards(page: Page, pagePath: string, boards: string[], sectionName: string): Promise<void> {
  await page.evaluate(() => {
    document.querySelectorAll('fabrico-board').forEach((el, i) => el.setAttribute('data-smoke-board', String(i)));
  });
  for (const [i, id] of boards.entries()) {
    const selector = `fabrico-board[data-smoke-board="${i}"]`;
    const label = `${sectionName}: ${pagePath} board ${i + 1} (${id})`;
    // A board holds a renderer only within 200 px of the viewport.
    await page.locator(selector).scrollIntoViewIfNeeded();
    await expect
      .poll(async () => (await readProbeAt(page, selector)).mounted, { message: `${label} mounts`, timeout: 20_000 })
      .toBe(true);
    // A later board may have played part of its run beside the ones above it; restart it so the
    // drawing check sees its run from the start, as boards.spec.ts does.
    if (i > 0) await page.locator(selector).locator('button[data-control="restart"]').click();
    await expectBoardDrawingSteppedAt(page, selector, 'while it plays', label);

    const want = manifestLine(id);
    await expect
      .poll(async () => (await readProbeAt(page, selector)).tick, {
        message: `${label} reaches tick ${want.endTick}`,
        timeout: 60_000,
        intervals: [500],
      })
      .toBe(want.endTick);
    const end = await readProbeAt(page, selector);
    console.log(`pages-smoke: ${label}: end tick ${end.endTick}, hash ${end.endHash}, frames ${end.frames}, verdict ${end.verdict}`);
    if (end.endHash !== want.hash) {
      throw new Error(`pages-smoke: ${label} ended on hash ${end.endHash}, the manifest pins ${want.hash}.`);
    }
    expect(end.verdict, `${label}: the badge's verdict`).toBe('match');
    expect(end.decodeErrors, `${label}: refused render packets`).toBe(0);
  }
}

for (const section of sections) {
  test(`${section.name}: a page loads with no error, and the first page with a board runs each board to its manifest hash`, async ({ page }) => {
    // Pick the first listed page whose HTML holds a board, from the site being checked.
    let chosen: { published: string; boards: string[] } | null = null;
    for (const sourcePath of section.pages) {
      const published = publishedUrlOf(sourcePath);
      const html = await (await fetchOk(served(published))).text();
      const boards = boardNames(html);
      if (boards.length > 0) {
        chosen = { published, boards };
        break;
      }
    }
    const published = chosen?.published ?? publishedUrlOf(section.pages[0] as string);
    const boards = chosen?.boards ?? [];
    const pagePath = published.slice(PUBLISHED_ROOT.length - '/fabrico/'.length);
    console.log(
      `pages-smoke: ${section.name}: ${boards.length > 0 ? `board page ${pagePath} (${boards.join(', ')})` : `no board page, loads ${pagePath}`}`,
    );
    test.setTimeout(60_000 + boards.length * 90_000);

    const errors = watchPageErrors(page);
    const consoleErrors = recordConsoleErrors(page);
    await installGlCounter(page);
    // A board stops at each caption it has; press Continue at once, as a reader would.
    await autoContinueCaptions(page);
    const response = await page.goto(served(published));
    expect(response?.status(), `${pagePath}: the page's status`).toBe(200);

    if (boards.length > 0) {
      await runBoards(page, pagePath, boards, section.name);
      expect((await glCounts(page)).lost, `${pagePath}: WebGL contexts lost on a mounted board`).toBe(0);
    }
    errors.assertNone(`on ${pagePath}`);
    expect(consoleErrors, `${pagePath}: console errors`).toEqual([]);
  });
}

test('the sitemaps list every page in the coverage manifest', async () => {
  const indexUrl = served(`${PUBLISHED_ROOT}sitemap-index.xml`);
  const sitemaps = locsOf(await (await fetchOk(indexUrl)).text());
  const sitemap0 = `${PUBLISHED_ROOT}sitemap-0.xml`;
  if (!sitemaps.includes(sitemap0)) {
    throw new Error(`pages-smoke: ${indexUrl} names ${sitemaps.join(', ') || 'no sitemap'}, not ${sitemap0}.`);
  }
  const listed = new Set(locsOf(await (await fetchOk(served(sitemap0))).text()));
  const wanted = sections.flatMap((s) => s.pages.map(publishedUrlOf));
  const missing = wanted.filter((url) => !listed.has(url));
  if (missing.length > 0) {
    throw new Error(
      `pages-smoke: sitemap-0.xml lists ${wanted.length - missing.length} of the ${wanted.length} coverage-manifest pages; missing ${missing.join(', ')}.`,
    );
  }
  console.log(`pages-smoke: sitemap-0.xml lists all ${wanted.length} coverage-manifest pages among its ${listed.size}`);
});

test("the hero is an animated WebP of this commit's demo board", async () => {
  const heroUrl = served(`${PUBLISHED_ROOT}hero/fabrico-hero.webp`);
  const hero = await fetchOk(heroUrl);
  const type = hero.headers.get('content-type') ?? '';
  expect(type.split(';')[0]?.trim(), `${heroUrl}: content-type`).toBe('image/webp');
  const info = readWebpInfo(new Uint8Array(await hero.arrayBuffer()));
  expect(info.frames.length, `${heroUrl}: frames`).toBeGreaterThan(1);

  const sidecarUrl = served(`${PUBLISHED_ROOT}hero/hero.json`);
  const sidecar = (await (await fetchOk(sidecarUrl)).json()) as { board?: unknown; board_sha256?: unknown };
  expect(sidecar.board, `${sidecarUrl}: the board it names`).toBe(DEMO_BOARD);
  const want = createHash('sha256').update(fs.readFileSync(path.join(REPO, DEMO_BOARD))).digest('hex');
  if (sidecar.board_sha256 !== want) {
    throw new Error(`pages-smoke: the hero's sidecar names board sha256 ${String(sidecar.board_sha256)}, this commit's demo board is ${want}.`);
  }
  console.log(`pages-smoke: hero ${info.frames.length} frames, ${info.bytes} bytes, board sha256 ${want}`);
});

/** Every link and image target in the README, found the way readme.spec.ts finds them. */
function readmeTargets(md: string): string[] {
  const out: string[] = [];
  for (const m of md.matchAll(/\]\(([^)\s]+)\)/g)) out.push(m[1] as string);
  for (const m of md.matchAll(/<(https?:\/\/[^>\s]+)>/g)) out.push(m[1] as string);
  for (const m of md.matchAll(/\b(?:src|href|srcset)="([^"]+)"/g)) out.push(m[1] as string);
  return out;
}

test('every absolute README link answers', async () => {
  const links = [
    ...new Set(
      readmeTargets(fs.readFileSync(path.join(REPO, 'README.md'), 'utf8'))
        .filter((t) => t.startsWith('https://'))
        .map((t) => t.replace(/#.*$/, '')),
    ),
  ].sort();
  expect(links.length, 'absolute links in README.md').toBeGreaterThan(0);
  const failed: string[] = [];
  for (const link of links) {
    const url = link.startsWith(PUBLISHED_ROOT) ? served(link) : link;
    let status: number | string;
    try {
      status = (await fetch(url, { redirect: 'manual' })).status;
    } catch (error) {
      status = error instanceof Error ? error.message : String(error);
    }
    console.log(`pages-smoke: README link ${link} (${url}) answered ${status}`);
    if (typeof status !== 'number' || status < 200 || status >= 400) failed.push(`${link} answered ${status}`);
  }
  if (failed.length > 0) throw new Error(`pages-smoke: README.md links that don't answer 2xx or 3xx: ${failed.join('; ')}.`);
});
