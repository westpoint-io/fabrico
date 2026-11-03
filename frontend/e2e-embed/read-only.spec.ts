import { expect, test, type Page } from '@playwright/test';
import {
  enableTrace,
  expectBoardDrawing,
  expectTraceMatchesNative,
  glCounts,
  installGlCounter,
  manifestLine,
  pageUrl,
  readProbe,
  readTrace,
  recordConsoleErrors,
  recordRequests,
  watchPageErrors,
} from './support/health.ts';

// A reader's input can't reach the run. On three-boards.html, which is taller than the viewport,
// the demo board plays at 4x from its boot tick while the test clicks a machine, drags across the
// stage, presses Delete, Backspace, Space, R, Control+Z, Escape and the arrow keys with the stage
// clicked first, and turns the wheel three times over the stage. Every tick of the run must still
// equal the native engine's dump (FABRICO_PLAYER_NATIVE_DUMP), the end hash the manifest pin, the
// board's camera must not move, and the page must scroll under the wheel. Frames and ticks keep
// rising through the input, and the board still draws afterwards.

const BOARD = 'demo_scene';
const PAGE = pageUrl('three-boards.html');
const KEYS = ['Delete', 'Backspace', 'Space', 'KeyR', 'Control+KeyZ', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];

type Sample = { frames: number; tick: number };

async function sample(page: Page): Promise<Sample> {
  const p = await readProbe(page, BOARD);
  return { frames: p.frames, tick: p.tick };
}

/** The demo board's stage box and the box of one of its machines, in viewport px. */
async function targets(page: Page): Promise<{ stage: DOMRectReadOnly; machine: { x: number; y: number } }> {
  return page.evaluate((n) => {
    const root = (document.querySelector(`fabrico-board[name="${n}"]`) as HTMLElement).shadowRoot as ShadowRoot;
    const stage = (root.querySelector('.stage') as HTMLElement).getBoundingClientRect();
    // A name chip sits 4 px above its machine's top edge, so 16 px below the chip is on the machine.
    const chips = [...root.querySelectorAll('.chip')].filter((c) => getComputedStyle(c).visibility === 'visible');
    const factory = chips.find((c) => c.textContent === 'Factory') ?? chips[0];
    if (factory === undefined) throw new Error('no visible machine chip to aim at');
    const r = factory.getBoundingClientRect();
    return { stage: stage.toJSON() as DOMRectReadOnly, machine: { x: r.left + r.width / 2, y: r.bottom + 16 } };
  }, BOARD);
}

test('clicks, drags, keys and wheel turns leave every tick, the end hash and the camera as they were', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors = watchPageErrors(page);
  const consoleErrors = recordConsoleErrors(page);
  const requests = recordRequests(page);
  await installGlCounter(page);
  await enableTrace(page);
  await page.goto(PAGE);
  await expect.poll(async () => (await readProbe(page, BOARD)).state, { timeout: 20_000 }).toBe('running');
  const pageHeight = await page.evaluate(() => document.documentElement.scrollHeight);
  const viewport = page.viewportSize();
  expect(pageHeight, 'the page is taller than the viewport, so it can scroll').toBeGreaterThan((viewport?.height ?? 0) + 200);

  // 4x from the boot tick, so the trace covers the whole run.
  const board = page.locator(`fabrico-board[name="${BOARD}"]`);
  await board.locator('select').selectOption({ label: '4x' });
  await board.locator('button[data-control="restart"]').click();
  const cameraBefore = (await readProbe(page, BOARD)).cameraSnapshot;
  expect(cameraBefore).not.toBeNull();
  const { stage, machine } = await targets(page);
  const samples: Sample[] = [await sample(page)];
  const pause = (): Promise<void> => page.waitForTimeout(120);

  // A click on a machine.
  await page.mouse.click(machine.x, machine.y);
  await pause();
  samples.push(await sample(page));

  // A drag across the stage.
  await page.mouse.move(stage.x + stage.width * 0.2, stage.y + stage.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(stage.x + stage.width * 0.8, stage.y + stage.height * 0.3, { steps: 8 });
  await page.mouse.up();
  await pause();
  samples.push(await sample(page));

  // Keys, with the stage clicked first.
  await page.mouse.click(stage.x + stage.width / 2, stage.y + stage.height / 2);
  for (const key of KEYS) await page.keyboard.press(key);
  await pause();
  samples.push(await sample(page));

  // Three wheel turns over the stage. The page scrolls; the board must not zoom.
  const scrollBefore = await page.evaluate(() => window.scrollY);
  await page.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2);
  for (let i = 0; i < 3; i++) await page.mouse.wheel(0, 120);
  await expect.poll(() => page.evaluate(() => window.scrollY), { message: 'the wheel scrolls the page' }).toBeGreaterThan(scrollBefore);
  await pause();
  samples.push(await sample(page));

  const end = manifestLine(BOARD);
  for (let i = 1; i < samples.length; i++) {
    expect(samples[i].frames, `frames rise during the input (sample ${i})`).toBeGreaterThan(samples[i - 1].frames);
    expect(samples[i].tick, `the tick rises during the input (sample ${i})`).toBeGreaterThan(samples[i - 1].tick);
  }
  expect(samples[samples.length - 1].tick, 'the input finished before the run did').toBeLessThan(end.endTick);
  console.log(`samples during input: ${samples.map((s) => `tick ${s.tick} frames ${s.frames}`).join(', ')}`);

  // The run, start to end, is the native engine's run.
  await expect.poll(async () => (await readProbe(page, BOARD)).endHash, { timeout: 60_000 }).not.toBeNull();
  const after = await readProbe(page, BOARD);
  const matched = expectTraceMatchesNative(BOARD, await readTrace(page, BOARD), 'all');
  expect(after.endHash, 'the end hash').toBe(end.hash);
  expect(after.verdict).toBe('match');
  expect(after.cameraSnapshot, "the board's camera didn't move").toEqual(cameraBefore);
  console.log(`${BOARD}: ${matched} ticks equal the native dump after input; camera ${JSON.stringify(after.cameraSnapshot)}`);

  // And it still draws: Play at the end runs it again, and the belts move on screen.
  await board.scrollIntoViewIfNeeded();
  await board.locator('button[data-control="play"]').click();
  await expectBoardDrawing(page, BOARD, 'after the input');
  expect(await glCounts(page)).toMatchObject({ live: 3, lost: 0, hidden: 1 });

  errors.assertNone('during and after the input');
  expect(consoleErrors).toEqual([]);
  expect(requests).toEqual([PAGE]);
});
