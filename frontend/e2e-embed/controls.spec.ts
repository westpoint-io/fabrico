import { expect, test, type Page } from '@playwright/test';
import {
  autoContinueCaptions,
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
  shadowText,
  watchPageErrors,
  WHOLE_PAGE_VIEWPORT,
  fileCaptions,
} from './support/health.ts';

// Three boards on one page (three-boards.html), each in a column of its own width, each drawn by
// the app's renderer and played by its own player. The controls drive the tick clock only, and
// every tick the page runs is compared with the native engine's dump for that board.

const BOARDS = ['demo_scene', 'order_processing', 'advanced'] as const;
const COLUMN_PX: Record<(typeof BOARDS)[number], number> = { demo_scene: 960, order_processing: 600, advanced: 420 };
const PAGE = pageUrl('three-boards.html');
// Every board on this page runs at once, so the viewport holds the whole page.
test.use({ viewport: WHOLE_PAGE_VIEWPORT });

/** Everything a test on this page checks at the end: no page error, no console error, no request. */
async function openPage(page: Page): Promise<() => Promise<void>> {
  const errors = watchPageErrors(page);
  const consoleErrors = recordConsoleErrors(page);
  const requests = recordRequests(page);
  await installGlCounter(page);
  await enableTrace(page);
  // A board stops at each caption it has; press Continue at once, as a reader would.
  await autoContinueCaptions(page);
  await page.goto(PAGE);
  for (const name of BOARDS) {
    await expect.poll(async () => (await readProbe(page, name)).state, { timeout: 20_000 }).toBe('running');
  }
  return async () => {
    // A board that ended on "not pinned" can't be checked, so the page fails on it, as it does on
    // a mismatch.
    for (const name of BOARDS) {
      const probe = await readProbe(page, name);
      expect(probe.verdict, `${name}: the badge verdict`).not.toBe('not pinned');
      expect(probe.verdict, `${name}: the badge verdict`).not.toBe('mismatch');
    }
    expect(await glCounts(page)).toMatchObject({ live: 3, lost: 0, hidden: 1 });
    errors.assertNone('on the three-board page');
    expect(consoleErrors).toEqual([]);
    expect(requests).toEqual([PAGE]);
  };
}

/** Click one of a board's controls through Playwright's real pointer path. */
function control(page: Page, name: string, which: 'restart' | 'play' | 'step') {
  return page.locator(`fabrico-board[name="${name}"]`).locator(`button[data-control="${which}"]`);
}

/** Pick a speed with the board's own select. */
async function pickSpeed(page: Page, name: string, label: string): Promise<void> {
  await page.locator(`fabrico-board[name="${name}"]`).locator('select').selectOption({ label });
}

test('three boards draw with the app renderer, each stage sized to its own column', async ({ page }) => {
  test.setTimeout(120_000);
  const finish = await openPage(page);
  for (const name of BOARDS) {
    await page.locator(`fabrico-board[name="${name}"]`).scrollIntoViewIfNeeded();
    // order_processing's items all arrive by tick 256 (about 4 s at 1x), and a board with nothing
    // moving draws the same picture every frame. Restart puts each board early in its run first.
    await control(page, name, 'restart').click();
    await expectBoardDrawing(page, name, 'on the three-board page');
    const box = await page.evaluate((n) => {
      const el = document.querySelector(`fabrico-board[name="${n}"]`) as HTMLElement;
      const col = el.parentElement as HTMLElement;
      const frame = el.shadowRoot?.querySelector('.frame') as HTMLElement;
      const stage = el.shadowRoot?.querySelector('.stage') as HTMLElement;
      const code = el.shadowRoot?.querySelector('.code-column') as HTMLElement;
      const cs = getComputedStyle(frame);
      const s = stage.getBoundingClientRect();
      const c = code.getBoundingClientRect();
      // The code column shares the stage's row when it sits beside it (720 px and wider).
      const beside = getComputedStyle(code).display !== 'none' && Math.abs(c.top - s.top) < 1;
      return {
        column: col.clientWidth,
        element: el.getBoundingClientRect().width,
        frameContent: frame.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
        stageWidth: s.width,
        stageHeight: s.height,
        besideWidth: beside ? c.right - s.right : 0,
      };
    }, name);
    console.log(`${name}: column ${box.column}, stage ${box.stageWidth} x ${box.stageHeight}`);
    expect(box.column, `${name}: the column width`).toBe(COLUMN_PX[name]);
    expect(box.element, `${name}: the element fills its column`).toBe(box.column);
    expect(box.besideWidth > 0, `${name}: the code column sits beside the stage only at 720 px and wider`).toBe(box.column >= 720);
    expect(box.stageWidth + box.besideWidth, `${name}: the stage and any code column beside it fill the frame's content width`).toBeCloseTo(
      box.frameContent,
      0,
    );
    const want = Math.min(560, Math.max(240, (box.stageWidth * 10) / 16));
    expect(Math.abs(box.stageHeight - want), `${name}: stage height ${box.stageHeight} follows 16:10 in 240..560`).toBeLessThanOrEqual(1);
  }
  await finish();
});

test('pause stops the counter, play resumes it, step advances one tick, restart returns to the boot tick', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const finish = await openPage(page);
  for (const name of BOARDS) {
    // A caption pauses the board by itself and the page presses Continue for it, so either can
    // land between this test's clicks. Start once the board is past its last caption.
    const lastCaption = Math.max(0, ...fileCaptions(name).map((c) => c.tick));
    await expect
      .poll(async () => (await readProbe(page, name)).tick, { timeout: 30_000, message: `${name} passes its last caption` })
      .toBeGreaterThan(lastCaption + 5);
    const probe0 = await readProbe(page, name);
    if (!probe0.playing) await control(page, name, 'play').click();
    await expect.poll(async () => (await readProbe(page, name)).playing).toBe(true);
    await expect(control(page, name, 'play')).toHaveAttribute('aria-label', 'Pause');

    await control(page, name, 'play').click();
    await expect.poll(async () => (await readProbe(page, name)).playing).toBe(false);
    const paused = (await readProbe(page, name)).tick;
    const pausedText = await shadowText(page, name, '.counter');
    await page.waitForTimeout(500);
    expect((await readProbe(page, name)).tick, `${name}: the tick holds while paused`).toBe(paused);
    expect(await shadowText(page, name, '.counter'), `${name}: the counter holds while paused`).toBe(pausedText);
    await expect(control(page, name, 'play')).toHaveAttribute('aria-label', 'Play');

    await control(page, name, 'step').click();
    await expect.poll(async () => (await readProbe(page, name)).tick, { message: `${name}: Step advances` }).toBe(paused + 1);
    await page.waitForTimeout(300);
    expect((await readProbe(page, name)).tick, `${name}: Step advanced exactly one tick`).toBe(paused + 1);
    const stepped = await readProbe(page, name);
    expect(await shadowText(page, name, '.counter')).toBe(
      `tick ${stepped.tick.toLocaleString('en-US')} / ${stepped.endTick.toLocaleString('en-US')}`,
    );

    await control(page, name, 'play').click();
    await expect.poll(async () => (await readProbe(page, name)).tick, { message: `${name}: Play resumes` }).toBeGreaterThan(paused + 3);

    // Step while playing pauses first.
    await control(page, name, 'step').click();
    await expect.poll(async () => (await readProbe(page, name)).playing).toBe(false);

    // Restart, clicked and read in one turn of the page, so no frame runs in between.
    const restarted = await page.evaluate((n) => {
      const el = document.querySelector(`fabrico-board[name="${n}"]`) as Element & { fabricoProbe(): { tick: number; bootTick: number; playing: boolean } };
      (el.shadowRoot?.querySelector('button[data-control="restart"]') as HTMLButtonElement).click();
      return el.fabricoProbe();
    }, name);
    expect(restarted.tick, `${name}: Restart returns to the boot tick`).toBe(restarted.bootTick);
    expect(restarted.playing, `${name}: Restart plays`).toBe(true);
    const nativeBoot = expectTraceMatchesNative(name, await readTrace(page, name), 0);
    expect(nativeBoot).toBe(1);
    await expect(control(page, name, 'restart')).toHaveAttribute('aria-label', `Restart from tick ${restarted.bootTick}`);
  }
  await finish();
});

test('at 0.25x the first 120 ticks equal the native engine tick by tick', async ({ page }) => {
  test.setTimeout(120_000);
  const finish = await openPage(page);
  for (const name of BOARDS) {
    await pickSpeed(page, name, '0.25x');
    await control(page, name, 'restart').click();
    expect((await readProbe(page, name)).speed).toBe(0.25);
  }
  for (const name of BOARDS) {
    const boot = (await readProbe(page, name)).bootTick;
    await expect
      .poll(async () => (await readProbe(page, name)).tick, { timeout: 30_000, intervals: [500] })
      .toBeGreaterThanOrEqual(boot + 120);
    const matched = expectTraceMatchesNative(name, await readTrace(page, name), 120);
    console.log(`${name} at 0.25x: ticks ${boot} to ${boot + 120} (${matched} ticks) equal the native dump`);
  }
  await finish();
});

test('at 4x the whole run equals the native engine and each board ends on its manifest hash', async ({ page }) => {
  test.setTimeout(120_000);
  const finish = await openPage(page);
  for (const name of BOARDS) {
    await pickSpeed(page, name, '4x');
    await control(page, name, 'restart').click();
  }
  for (const name of BOARDS) {
    const pinned = manifestLine(name);
    await expect
      .poll(async () => (await readProbe(page, name)).endHash, { timeout: 60_000, intervals: [500] })
      .not.toBeNull();
    const end = await readProbe(page, name);
    expect(end.speed).toBe(4);
    expect(end.tick, `${name}: the end tick`).toBe(pinned.endTick);
    // What the reader sees first: the badge, then the hash behind it, then every tick.
    const badge = (await shadowText(page, name, '.badge')).trim();
    expect(badge, `${name}: the hash badge`).toBe(`final state ${pinned.hash.slice(0, 8)} match`);
    expect(end.verdict, `${name}: the badge verdict`).toBe('match');
    expect(end.endHash, `${name}: the end hash`).toBe(pinned.hash);
    const matched = expectTraceMatchesNative(name, await readTrace(page, name), 'all');
    const counter = await shadowText(page, name, '.counter');
    expect(counter).toMatch(/^tick [\d,]+ \/ [\d,]+$/);
    expect(counter).toBe(`tick ${pinned.endTick.toLocaleString('en-US')} / ${pinned.endTick.toLocaleString('en-US')}`);
    await expect(control(page, name, 'step')).toBeDisabled();
    await expect(control(page, name, 'play')).toHaveAttribute('title', `Play again from tick ${end.bootTick}`);
    console.log(`${name} at 4x: ${matched} ticks (${end.bootTick} to ${end.tick}) equal the native dump; badge "${badge}"`);
  }
  await finish();
});
