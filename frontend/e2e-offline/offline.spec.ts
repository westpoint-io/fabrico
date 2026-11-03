import { readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, test } from '@playwright/test';
import {
  autoContinueCaptions,
  expectBoardDrawing,
  glCounts,
  installGlCounter,
  manifestLine,
  readProbe,
  recordConsoleErrors,
  recordRequests,
  shadowText,
  watchPageErrors,
} from '../e2e-embed/support/health.ts';

// The offline file, opened from disk the way a reader double-clicks it. It must hold one section
// per board file under examples/boards/ (counted from the folder here, not from the file), link to
// each and back, draw each board (frames rise and a screenshot of a belt region changes), end each
// on its pinned hash, and ask for nothing but itself.

const FILE = fileURLToPath(new URL('../dist-examples/fabrico-examples.html', import.meta.url));
const FILE_URL = pathToFileURL(FILE).href;
const REPO = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
const BOARDS_DIR = path.join(REPO, 'examples', 'boards');
const LIST_ID = 'board-list';
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

test('the file carries no source map reference and no build machine path', () => {
  const text = readFileSync(FILE, 'utf8');
  expect(text.includes('sourceMappingURL'), 'a sourceMappingURL comment in the file').toBe(false);
  expect(text.includes(os.homedir()), `the home folder ${os.homedir()} in the file`).toBe(false);
  expect(text.includes(REPO), `the repo path ${REPO} in the file`).toBe(false);
});

test('one section and one link per board file, in path order', async ({ page }) => {
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
  expect(requests).toEqual([FILE_URL]);
});

for (const id of IDS) {
  test(`${id}: its link scrolls to it, it draws, ends on its pinned hash, and links back`, async ({ page }) => {
    test.setTimeout(180_000);
    const errors = watchPageErrors(page);
    const consoleErrors = recordConsoleErrors(page);
    const requests = recordRequests(page);
    await installGlCounter(page);
    // A board stops at each caption it has; press Continue at once, as a reader would.
    await autoContinueCaptions(page);
    await page.goto(FILE_URL);

    await page.locator(`#${LIST_ID} a[href="#${id}"]`).click();
    await expect(page).toHaveURL(`${FILE_URL}#${id}`);
    const section = page.locator(`section[id="${id}"]`);
    await expect(section.locator('h2'), `${id}: its heading is on screen after the link`).toBeInViewport();

    await expect
      .poll(async () => {
        const p = await readProbe(page, id);
        return p.state === 'running' && p.mounted;
      }, { message: `${id} mounts and runs`, timeout: 30_000 })
      .toBe(true);
    // Restart first, so the belts move now whichever tick the board had reached on its own.
    const board = section.locator('fabrico-board');
    await board.locator('button[data-control="restart"]').click();
    await expectBoardDrawing(page, id, `${id} after its link`);

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
    expect(requests).toEqual([FILE_URL]);
  });
}
