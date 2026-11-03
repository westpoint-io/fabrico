import { expect, test, type Page } from '@playwright/test';
import {
  autoContinueCaptions,
  expectBoardDrawing,
  installGlCounter,
  pageUrl,
  readProbe,
  recordConsoleErrors,
  recordRequests,
  watchPageErrors,
} from './support/health.ts';

// The error cards (errors.html): a name the bundle has no board for, a board file in format 1 and
// a board whose engine stops on tick 120. The last two are added by the page with
// FabricoEmbed.registerBoard. Each card shows its UI-SPEC copy inside the stage, and the stage
// keeps the size a running board has at the same width.

const PAGE = pageUrl('errors.html');

interface StageRead {
  width: number;
  height: number;
  heading: string;
  body: string;
  restart: boolean;
  play: boolean;
  step: boolean;
  speed: boolean;
  cardInStage: boolean;
}

async function readStage(page: Page, name: string): Promise<StageRead> {
  return page.evaluate((n) => {
    const el = document.querySelector(`fabrico-board[name="${n}"]`) as HTMLElement;
    const root = el.shadowRoot as ShadowRoot;
    const stage = root.querySelector('.stage') as HTMLElement;
    const card = root.querySelector('.card');
    const s = stage.getBoundingClientRect();
    const c = card?.getBoundingClientRect();
    const enabled = (sel: string): boolean => !(root.querySelector(sel) as HTMLButtonElement | HTMLSelectElement).disabled;
    return {
      width: s.width,
      height: s.height,
      heading: root.querySelector('.card-heading')?.textContent ?? '',
      body: root.querySelector('.card-body')?.textContent ?? '',
      restart: enabled('button[data-control="restart"]'),
      play: enabled('button[data-control="play"]'),
      step: enabled('button[data-control="step"]'),
      speed: enabled('select'),
      cardInStage:
        c !== undefined && c.left >= s.left && c.right <= s.right && c.top >= s.top && c.bottom <= s.bottom && c.width <= 420,
    };
  }, name);
}

test('each error shows its card inside a stage the size of a running board', async ({ page }) => {
  test.setTimeout(90_000);
  const errors = watchPageErrors(page);
  const consoleErrors = recordConsoleErrors(page);
  const requests = recordRequests(page);
  await installGlCounter(page);
  // A board stops at each caption it has; press Continue at once, as a reader would.
  await autoContinueCaptions(page);
  await page.goto(PAGE);

  await expect.poll(async () => (await readProbe(page, 'demo_scene')).state, { timeout: 20_000 }).toBe('running');
  await expectBoardDrawing(page, 'demo_scene', 'beside the error cards');
  const running = await readStage(page, 'demo_scene');

  const cards = [
    {
      name: 'no_such_board',
      heading: 'BOARD DID NOT LOAD',
      body: 'There\'s no board named "no_such_board" in this bundle. Check the name attribute against the files in examples/boards/.',
    },
    {
      name: 'old-format',
      heading: 'BOARD DID NOT LOAD',
      body: 'This board file is format 1, and this player reads format 2. Update the file to format 2 and give it a captions list.',
    },
  ];
  for (const card of cards) {
    await expect.poll(async () => (await readProbe(page, card.name)).state, { timeout: 20_000 }).toBe('error');
    const read = await readStage(page, card.name);
    expect(read.heading, `${card.name}: the heading`).toBe(card.heading);
    expect(read.body, `${card.name}: the body`).toBe(card.body);
    expect(read.cardInStage, `${card.name}: the card sits inside the stage, at most 420 px wide`).toBe(true);
    expect({ width: read.width, height: read.height }, `${card.name}: the stage keeps a running board's size`).toEqual({
      width: running.width,
      height: running.height,
    });
    expect(
      { restart: read.restart, play: read.play, step: read.step, speed: read.speed },
      `${card.name}: every control is disabled`,
    ).toEqual({ restart: false, play: false, step: false, speed: false });
  }

  // The engine-stopped board runs until its script reaches tick 120.
  const stopped = 'stops-mid-run';
  await expect.poll(async () => (await readProbe(page, stopped)).state, { timeout: 30_000 }).toBe('error');
  const read = await readStage(page, stopped);
  const probe = await readProbe(page, stopped);
  console.log(`${stopped}: ${read.heading} / ${read.body}`);
  expect(read.heading).toBe('ENGINE STOPPED');
  expect(read.body).toBe(
    "The engine stopped at tick 120: the script entry at tick 120 names handle 42, which isn't minted yet. Press Restart to run it again. If it stops at the same tick, report it with this board's name.",
  );
  expect(probe.tick, `${stopped}: the board stays on the tick it stopped at`).toBe(120);
  expect(read.cardInStage).toBe(true);
  expect({ width: read.width, height: read.height }).toEqual({ width: running.width, height: running.height });
  expect(
    { restart: read.restart, play: read.play, step: read.step, speed: read.speed },
    `${stopped}: only Restart stays enabled`,
  ).toEqual({ restart: true, play: false, step: false, speed: false });

  // Restart runs it again from its boot tick, and it stops on the same tick.
  await page.locator(`fabrico-board[name="${stopped}"]`).locator('button[data-control="restart"]').click();
  await expect.poll(async () => (await readProbe(page, stopped)).tick).toBeLessThan(120);
  await expect.poll(async () => (await readProbe(page, stopped)).state, { timeout: 30_000 }).toBe('error');
  expect((await readProbe(page, stopped)).tick).toBe(120);

  errors.assertNone('on the error page');
  expect(consoleErrors).toEqual([]);
  expect(requests).toEqual([PAGE]);
});
