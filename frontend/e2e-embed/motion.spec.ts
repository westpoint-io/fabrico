import { expect, test, type Page } from '@playwright/test';
import {
  expectBoardDrawing,
  fileCaptions,
  pageUrl,
  readProbe,
  recordConsoleErrors,
  recordRequests,
  watchPageErrors,
  WHOLE_PAGE_VIEWPORT,
} from './support/health.ts';

// The tab and the reader's motion setting, on three-boards.html.
//
// A hidden tab: the test pauses one board itself, then hides the tab by overriding
// document.visibilityState (and document.hidden) and firing visibilitychange on the document,
// which is the event the page's one listener hears. Headless Chromium keeps running animation
// frames for a page in that state, so a board that ignored the event would keep stepping. Every
// tick counter must hold; showing the tab again resumes the two boards that were playing and
// leaves the paused one paused.
//
// Reduced motion: with prefers-reduced-motion: reduce emulated before the page loads, every board
// loads paused with Play showing and holds its tick for two seconds; Play runs it at the selected
// speed, and Restart takes it back to its boot tick and leaves it paused.
//
// Neither test presses Continue for the reader, so each waits until a board is past its captions
// before it measures, or measures before the first one.

const PAGE = pageUrl('three-boards.html');
const BOARDS = ['demo_scene', 'order_processing', 'advanced'] as const;

test.use({ viewport: WHOLE_PAGE_VIEWPORT });

const control = (page: Page, name: string, which: 'restart' | 'play' | 'step') =>
  page.locator(`fabrico-board[name="${name}"]`).locator(`button[data-control="${which}"]`);

async function setTabHidden(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate((h) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
}

async function ticks(page: Page): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const name of BOARDS) out[name] = (await readProbe(page, name)).tick;
  return out;
}

test('a hidden tab pauses every board, and showing it resumes only the ones that were playing', async ({ page }) => {
  test.setTimeout(90_000);
  const errors = watchPageErrors(page);
  const consoleErrors = recordConsoleErrors(page);
  const requests = recordRequests(page);
  await page.goto(PAGE);
  for (const name of BOARDS) {
    await expect.poll(async () => (await readProbe(page, name)).state, { timeout: 20_000 }).toBe('running');
  }
  // Past the demo board's last caption, so no caption pauses a board during the test.
  const lastCaption = Math.max(...fileCaptions('demo_scene').map((c) => c.tick));
  await expect
    .poll(async () => {
      const p = await readProbe(page, 'demo_scene');
      if (p.caption !== null) await control(page, 'demo_scene', 'play').click();
      return p.tick;
    }, { timeout: 30_000, intervals: [100], message: 'the demo board passes its last caption' })
    .toBeGreaterThan(lastCaption + 5);

  // The reader pauses one board.
  await control(page, 'advanced', 'play').click();
  await expect.poll(async () => (await readProbe(page, 'advanced')).playing).toBe(false);
  for (const name of ['demo_scene', 'order_processing'] as const) {
    expect((await readProbe(page, name)).playing, `${name} plays before the tab hides`).toBe(true);
  }

  await setTabHidden(page, true);
  const hiddenAt = await ticks(page);
  for (const name of BOARDS) expect((await readProbe(page, name)).playing, `${name} is paused while the tab is hidden`).toBe(false);
  await page.waitForTimeout(1000);
  const later = await ticks(page);
  expect(later, 'no board steps while the tab is hidden').toEqual(hiddenAt);
  console.log(`hidden tab: ticks held at ${JSON.stringify(hiddenAt)} for 1 s`);

  await setTabHidden(page, false);
  for (const name of ['demo_scene', 'order_processing'] as const) {
    await expect.poll(async () => (await readProbe(page, name)).tick, { message: `${name} plays on once the tab is back` }).toBeGreaterThan(hiddenAt[name] + 5);
    expect((await readProbe(page, name)).playing).toBe(true);
  }
  await page.waitForTimeout(500);
  const advanced = await readProbe(page, 'advanced');
  expect(advanced.playing, 'the board the reader paused stays paused').toBe(false);
  expect(advanced.tick, 'the board the reader paused holds its tick').toBe(hiddenAt.advanced);
  await expectBoardDrawing(page, 'demo_scene', 'after the tab came back');

  errors.assertNone('across the hidden tab');
  expect(consoleErrors).toEqual([]);
  expect(requests).toEqual([PAGE]);
});

test('with reduced motion every board loads paused, Play runs it at the selected speed, and Restart leaves it paused', async ({ page }) => {
  test.setTimeout(90_000);
  const errors = watchPageErrors(page);
  const consoleErrors = recordConsoleErrors(page);
  const requests = recordRequests(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(PAGE);
  for (const name of BOARDS) {
    await expect
      .poll(async () => {
        const p = await readProbe(page, name);
        return `${p.state}:${p.mounted ? 'mounted' : 'not mounted'}`;
      }, { timeout: 20_000 })
      .toBe('running:mounted');
  }
  const loaded = await ticks(page);
  for (const name of BOARDS) {
    const p = await readProbe(page, name);
    expect(p.playing, `${name} loads paused`).toBe(false);
    expect(p.tick, `${name} is on its boot tick`).toBe(p.bootTick);
    await expect(control(page, name, 'play'), `${name} shows Play`).toHaveAttribute('aria-label', 'Play');
    await expect(control(page, name, 'play')).toBeEnabled();
  }
  await page.waitForTimeout(2000);
  expect(await ticks(page), 'no board moves for two seconds').toEqual(loaded);

  for (const name of BOARDS) {
    const board = page.locator(`fabrico-board[name="${name}"]`);
    await board.locator('select').selectOption({ label: '2x' });
    await control(page, name, 'play').click();
    const start = await readProbe(page, name);
    expect(start.speed, `${name} runs at the selected speed`).toBe(2);
    await expect.poll(async () => (await readProbe(page, name)).tick, { message: `${name} runs once Play is pressed` }).toBeGreaterThan(start.tick + 10);
    await expect(control(page, name, 'play')).toHaveAttribute('aria-label', /Pause|Continue/);

    await control(page, name, 'restart').click();
    const restarted = await readProbe(page, name);
    expect(restarted.tick, `${name}: Restart goes back to the boot tick`).toBe(restarted.bootTick);
    expect(restarted.playing, `${name}: Restart leaves it paused`).toBe(false);
    await page.waitForTimeout(500);
    expect((await readProbe(page, name)).tick, `${name}: and it stays on the boot tick`).toBe(restarted.bootTick);
    await expect(control(page, name, 'play')).toHaveAttribute('aria-label', 'Play');
  }

  errors.assertNone('under reduced motion');
  expect(consoleErrors).toEqual([]);
  expect(requests).toEqual([PAGE]);
});
