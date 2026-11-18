import { readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, test } from '@playwright/test';
import {
  autoContinueCaptions,
  expectBoardDrawingStepped,
  glCounts,
  installGlCounter,
  manifestLine,
  readProbe,
  recordConsoleErrors,
  recordRequests,
  shadowText,
  watchPageErrors,
} from '../e2e-embed/support/health.ts';
import { idsIn, sitePatterns } from '../e2e-docs/support/residuePatterns.ts';

// The offline file, opened from disk the way a reader double-clicks it. It must hold one section
// per board file under examples/boards/ (counted from the folder here, not from the file), link to
// each and back, draw each board (frames rise and a screenshot of a belt region changes), end each
// on its pinned hash, and ask for nothing but itself. It ends with a footer naming Fabrico's two
// licences and the fonts' OFL, carries both OFL texts byte for byte, and holds none of the planning
// ids the residue gate refuses under site/.
//
// FABRICO_OFFLINE_FILE names another copy of the file to check, such as one downloaded from a
// release; scripts/check-offline-browsers.sh passes the same path to its WebKitGTK leg. The board
// files it is compared with are always this checkout's.

const FILE =
  process.env.FABRICO_OFFLINE_FILE !== undefined && process.env.FABRICO_OFFLINE_FILE !== ''
    ? path.resolve(process.env.FABRICO_OFFLINE_FILE)
    : fileURLToPath(new URL('../dist-examples/fabrico-examples.html', import.meta.url));
const FILE_URL = pathToFileURL(FILE).href;
const REPO = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
const BOARDS_DIR = path.join(REPO, 'examples', 'boards');
const LIST_ID = 'board-list';
/** The fonts' licence texts the file must carry, from this checkout. */
const FONTS_DIR = path.join(REPO, 'frontend', 'src', 'assets', 'fonts');
const OFL_FILES = ['OFL-1.1-MartianMono.txt', 'OFL-1.1-Sono.txt'] as const;
/** At 4x a 1200-tick board takes 5 s; a slow software renderer gets far more. */
const END_TIMEOUT_MS = 120_000;

/** Every board file's id, read from the folder: `docs/x.board.ron` is `docs-x`, in path order. */
function boardIdsOnDisk(): string[] {
  const found: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      const child = rel === '' ? name : `${rel}/${name}`;
      if (statSync(full).isDirectory()) walk(full, child);
      else if (name.endsWith('.board.ron')) found.push(child);
    }
  };
  walk(BOARDS_DIR, '');
  return found
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((rel) => rel.slice(0, -'.board.ron'.length).replace(/\//g, '-'));
}

const IDS = boardIdsOnDisk();

/**
 * The page asked for nothing but the file. Chromium reports the file's own navigation, so there
 * the list must be exactly the file. Playwright's Firefox reports no request for a file:// URL at
 * all, so there the check is that nothing else was asked for: a request to any other place (an
 * http or https URL, say) still shows up in both.
 */
function expectOnlyTheFile(requests: readonly string[], browserName: string): void {
  expect(requests.filter((url) => url !== FILE_URL), 'requests other than the file itself').toEqual([]);
  if (browserName === 'chromium') expect(requests, 'Chromium reports the file itself').toEqual([FILE_URL]);
}

test('the file carries no source map reference and no build machine path', () => {
  const text = readFileSync(FILE, 'utf8');
  expect(text.includes('sourceMappingURL'), 'a sourceMappingURL comment in the file').toBe(false);
  expect(text.includes(os.homedir()), `the home folder ${os.homedir()} in the file`).toBe(false);
  expect(text.includes(REPO), `the repo path ${REPO} in the file`).toBe(false);
});

test('the file holds none of the planning ids the residue gate refuses under site/', () => {
  const found = idsIn(path.basename(FILE), readFileSync(FILE, 'utf8'), sitePatterns());
  expect(found, `planning ids in ${FILE}:\n${found.join('\n')}`).toEqual([]);
});

test('the file carries both OFL licence texts byte for byte', () => {
  const text = readFileSync(FILE, 'utf8');
  for (const name of OFL_FILES) {
    const licence = readFileSync(path.join(FONTS_DIR, name), 'utf8');
    expect(licence.length, `${name} is not empty`).toBeGreaterThan(0);
    expect(text.includes(licence), `${name}, byte for byte, in the file`).toBe(true);
  }
});

test('a footer after the last board names the licences of Fabrico and its fonts', async ({ page, browserName }) => {
  const errors = watchPageErrors(page);
  const requests = recordRequests(page);
  await page.goto(FILE_URL);
  await expect(page.locator('main > section'), 'the footer is not a section').toHaveCount(IDS.length);
  const footer = page.locator('main > footer');
  await expect(footer).toHaveCount(1);
  expect(
    await page.locator('main > *').evaluateAll((els) => els[els.length - 1]?.tagName),
    'the footer is the last element in main',
  ).toBe('FOOTER');
  await expect(footer.locator('p')).toHaveText([
    'Fabrico is licensed under the Apache License 2.0 or the MIT license, at your option.',
    'The fonts Martian Mono and Sono are licensed under the SIL Open Font License 1.1.',
  ]);
  const links = await footer.locator('a').evaluateAll((els) => els.map((a) => [a.textContent, a.getAttribute('href')]));
  expect(links).toEqual([
    ['Apache License 2.0', 'https://github.com/westpoint-io/fabrico/blob/main/LICENSE-APACHE'],
    ['MIT license', 'https://github.com/westpoint-io/fabrico/blob/main/LICENSE-MIT'],
    ['SIL Open Font License 1.1', 'https://github.com/westpoint-io/fabrico/tree/main/frontend/src/assets/fonts'],
  ]);
  errors.assertNone('on the offline file');
  expectOnlyTheFile(requests, browserName);
});

test('one section and one link per board file, in path order', async ({ page, browserName }) => {
  const errors = watchPageErrors(page);
  const requests = recordRequests(page);
  expect(IDS.length, 'board files under examples/boards/').toBeGreaterThan(0);
  await page.goto(FILE_URL);
  await expect(page).toHaveTitle('Fabrico examples');
  const sections = page.locator('main > section');
  await expect(sections, `${IDS.length} board files, so ${IDS.length} sections`).toHaveCount(IDS.length);
  expect(await sections.evaluateAll((els) => els.map((el) => el.id))).toEqual(IDS);
  expect(
    await page.locator('main > section fabrico-board').evaluateAll((els) => els.map((el) => el.getAttribute('name'))),
  ).toEqual(IDS);
  const links = page.locator(`#${LIST_ID} a`);
  await expect(links, `${IDS.length} board files, so ${IDS.length} links`).toHaveCount(IDS.length);
  expect(await links.evaluateAll((els) => els.map((el) => el.getAttribute('href')))).toEqual(IDS.map((id) => `#${id}`));
  for (const id of IDS) {
    const heading = (await page.locator(`section[id="${id}"] h2`).textContent())?.trim() ?? '';
    expect(heading, `${id}: its section has a heading`).not.toBe('');
    await expect(page.locator(`#${LIST_ID} a[href="#${id}"]`), `${id}: the list names it by its heading`).toHaveText(heading);
  }
  errors.assertNone('on the offline file');
  expectOnlyTheFile(requests, browserName);
});

for (const id of IDS) {
  test(`${id}: its link scrolls to it, it draws, ends on its pinned hash, and links back`, async ({ page, browserName }) => {
    test.setTimeout(180_000);
    const errors = watchPageErrors(page);
    const consoleErrors = recordConsoleErrors(page);
    const requests = recordRequests(page);
    await installGlCounter(page);
    // A board stops at each caption it has; press Continue at once, as a reader would.
    await autoContinueCaptions(page);
    await page.goto(FILE_URL);

    // A board left out of the file fails here, at once, rather than when the test times out.
    const link = page.locator(`#${LIST_ID} a[href="#${id}"]`);
    await expect(link, `${id}: the list links to it`).toHaveCount(1, { timeout: 5_000 });
    await link.click();
    await expect(page).toHaveURL(`${FILE_URL}#${id}`);
    const section = page.locator(`section[id="${id}"]`);
    await expect(section.locator('h2'), `${id}: its heading is on screen after the link`).toBeInViewport();

    await expect
      .poll(async () => {
        const p = await readProbe(page, id);
        return p.state === 'running' && p.mounted;
      }, { message: `${id} mounts and runs`, timeout: 30_000 })
      .toBe(true);
    // Restart first, so the belts move now whichever tick the board had reached on its own, and at
    // a quarter speed: some boards carry a single item over their longest belt for well under a
    // second at 1x, and the slower run keeps it in view for several screenshots.
    const board = section.locator('fabrico-board');
    await board.locator('select').selectOption({ label: '0.25x' });
    await board.locator('button[data-control="restart"]').click();
    // In Firefox the page can move on after the link's scroll, and on a board whose belt runs across
    // the middle of a tall canvas it left the belt tiles 0 to 18 px into the viewport, where a
    // screenshot of them never changed. Bring the board into view before the drawing check reads it.
    await board.scrollIntoViewIfNeeded();
    // The drawing check samples at board ticks, not wall time: on a slow runner each screenshot
    // took 1.5 to 2 s, and a 10 s window missed belt motion that lasts only a few ticks.
    await expectBoardDrawingStepped(page, id, `${id} after its link`);

    await board.locator('select').selectOption({ label: '4x' });
    const expected = manifestLine(id);
    await expect
      .poll(async () => (await readProbe(page, id)).verdict, {
        message: `${id} reaches its end tick ${expected.endTick} and shows a verdict`,
        timeout: END_TIMEOUT_MS,
        intervals: [500],
      })
      .not.toBeNull();
    const end = await readProbe(page, id);
    expect(end.tick, `${id}: the end tick`).toBe(expected.endTick);
    expect(end.endHash, `${id} at tick ${expected.endTick}: the end hash`).toBe(expected.hash);
    expect((await shadowText(page, id, '.badge')).trim(), `${id}: the badge a reader sees`).toBe(
      `final state ${expected.hash.slice(0, 8)} match`,
    );

    await section.getByRole('link', { name: 'Back to the list' }).click();
    await expect(page).toHaveURL(`${FILE_URL}#${LIST_ID}`);
    await expect(page.locator(`#${LIST_ID} h2`), 'the list heading is on screen after the back link').toBeInViewport();

    const counts = await glCounts(page);
    expect(counts.lost, `${id}: contexts lost on a mounted board`).toBe(0);
    expect(counts.live, `${id}: live WebGL contexts`).toBeLessThanOrEqual(8);
    errors.assertNone(`on the offline file, board ${id}`);
    expect(consoleErrors).toEqual([]);
    expectOnlyTheFile(requests, browserName);
  });
}
