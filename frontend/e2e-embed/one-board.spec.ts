import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, test } from '@playwright/test';
import {
  autoContinueCaptions,
  expectBoardDrawing,
  glCounts,
  installGlCounter,
  readProbe,
  recordConsoleErrors,
  recordRequests,
  watchPageErrors,
} from './support/health.ts';

// One example board on a page opened from disk: drawn by the app's renderer, played from its boot
// tick at 60 ticks a second, ending on the hash the native engine pinned in hashes.manifest.
const BOARD = 'demo_scene';
const BOARD_PATH = 'examples/boards/demo_scene.board.ron';

const repoPath = (path: string): string => fileURLToPath(new URL(`../../${path}`, import.meta.url));
const PAGE_URL = pathToFileURL(fileURLToPath(new URL('../dist-embed/pages/one-board.html', import.meta.url))).href;

/** The board's manifest line, read at run time. */
function manifestLine(): { endTick: number; hash: string } {
  const line = readFileSync(repoPath('examples/boards/hashes.manifest'), 'utf8')
    .split('\n')
    .find((candidate) => candidate.startsWith(`${BOARD_PATH} `));
  if (line === undefined) throw new Error(`hashes.manifest has no line for ${BOARD_PATH}`);
  const [, endTick, hash] = line.split(' ');
  return { endTick: Number(endTick), hash };
}

test(`${BOARD} draws on a file:// page and ends on its manifest hash`, async ({ page }) => {
  test.setTimeout(90_000);
  const errors = watchPageErrors(page);
  const consoleErrors = recordConsoleErrors(page);
  const requests = recordRequests(page);
  await installGlCounter(page);
  // A board stops at each caption it has; press Continue at once, as a reader would.
  await autoContinueCaptions(page);

  await page.goto(PAGE_URL);
  await expect.poll(async () => (await readProbe(page, BOARD)).mounted, { timeout: 20_000 }).toBe(true);

  await expectBoardDrawing(page, BOARD, 'while it plays');
  expect(await glCounts(page)).toMatchObject({ live: 1, lost: 0, hidden: 1 });

  const expected = manifestLine();
  await expect
    .poll(async () => (await readProbe(page, BOARD)).tick, {
      message: `${BOARD} reaches tick ${expected.endTick}`,
      timeout: 60_000,
      intervals: [500],
    })
    .toBe(expected.endTick);
  const end = await readProbe(page, BOARD);
  console.log(`${BOARD}: end tick ${end.endTick}, hash ${end.endHash}, frames ${end.frames}`);
  expect(end.endTick, `${BOARD}: the end tick`).toBe(expected.endTick);
  expect(end.endHash, `${BOARD} at tick ${expected.endTick}: the end hash`).toBe(expected.hash);
  expect(end.playing).toBe(false);

  expect(await glCounts(page)).toMatchObject({ live: 1, lost: 0, hidden: 1 });
  errors.assertNone('on the one-board page');
  expect(consoleErrors).toEqual([]);
  expect(requests).toEqual([PAGE_URL]);
});
