import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type { PlayerResult } from '../src/spike/playerTestPage.ts';

// The demo board in headless Chromium: the page loads its data file and the optimised wasm through
// the same loader Node uses, and has to end on the native engine's hash with no request to another
// origin. There's no canvas in this check, so it reads the hash and the decoded packets.
const BOARD_PATH = 'examples/boards/demo_scene.board.ron';
const PAGE_ORIGIN = 'http://127.0.0.1:5181';

const repoPath = (path: string): string => fileURLToPath(new URL(`../../${path}`, import.meta.url));

/** The demo line of the manifest the native engine wrote, read at run time. */
function manifestLine(): { endTick: number; hash: string } {
  const line = readFileSync(repoPath('examples/boards/hashes.manifest'), 'utf8')
    .split('\n')
    .find((candidate) => candidate.startsWith(`${BOARD_PATH} `));
  if (line === undefined) throw new Error(`hashes.manifest has no line for ${BOARD_PATH}`);
  const [, endTick, hash] = line.split(' ');
  return { endTick: Number(endTick), hash };
}

test('the demo board reaches its manifest hash in Chromium and calls nothing outside', async ({ page }) => {
  const wasmPath = process.env.FABRICO_PLAYER_WASM;
  if (wasmPath === undefined) {
    throw new Error('FABRICO_PLAYER_WASM is unset. Build the player and run this through scripts/check-player-browser.sh.');
  }

  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const requests: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('request', (request) => requests.push(request.url()));

  // A request to another origin is recorded above and stopped here, so even a failing run of this
  // spec doesn't reach the network.
  await page.route(
    (url) => url.origin !== PAGE_ORIGIN,
    (route) => route.abort(),
  );
  await page.route('**/__fabrico_player/fabrico_player.wasm', (route) =>
    route.fulfill({ contentType: 'application/wasm', body: readFileSync(wasmPath) }),
  );
  await page.route('**/__fabrico_player/board.ron', (route) =>
    route.fulfill({ contentType: 'text/plain', body: readFileSync(repoPath(BOARD_PATH)) }),
  );

  await page.goto('/player-test.html');
  await page.waitForFunction(() => window.__playerResult !== undefined);
  const result = (await page.evaluate(() => window.__playerResult)) as PlayerResult;

  // This comes first, because a blocked request also throws in the page, and that error wouldn't
  // say which URL the page called.
  expect(requests.filter((url) => new URL(url).origin !== PAGE_ORIGIN)).toEqual([]);
  if ('error' in result) throw new Error(`the page reported: ${result.error}`);

  const expected = manifestLine();
  expect(result.endTick).toBe(expected.endTick);
  expect(result.hash, `${BOARD_PATH} at tick ${expected.endTick}: the end hash`).toBe(expected.hash);
  expect(result.packets).toBeGreaterThan(1);
  expect(result.placed).toBeGreaterThan(0);
  expect(result.belts).toBeGreaterThan(0);
  expect(result.sawItem).toBe(true);
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});
