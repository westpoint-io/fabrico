import { expect, test, type Page } from '@playwright/test';
import {
  autoContinueCaptions,
  enableTrace,
  expectBoardDrawingAt,
  expectTraceMatchesNative,
  glCounts,
  installGlCounter,
  manifestLine,
  pageUrl,
  readProbeAt,
  readTraceAt,
  recordConsoleErrors,
  recordRequests,
  watchPageErrors,
} from './support/health.ts';

// The "run it twice" pair on pair.html: two docs-arrival-order boards, the first with
// order="forward" and the second with order="reversed", so the second is fed the webhooks that
// share a tick in reverse order. The board sends each same-tick webhook to a different Source, so
// arrival order can't change its run: the two boards must hold the same state hash after every
// tick, not only at the end. The per-tick comparison is the first check, and it names the first
// tick that differs. Then the forward run is checked against the native engine's dump, the two
// badges against each other and the manifest, the order strips, render health, and the layout:
// side by side at a wrapper of 960 px or more, stacked below that.

const PAGE = pageUrl('pair.html');
const BOARD = 'docs-arrival-order';
const FORWARD = '#forward';
const REVERSED = '#reversed';

async function openPage(page: Page): Promise<() => Promise<void>> {
  const errors = watchPageErrors(page);
  const consoleErrors = recordConsoleErrors(page);
  const requests = recordRequests(page);
  await installGlCounter(page);
  await enableTrace(page);
  // The board stops at its caption; press Continue at once, as a reader would.
  await autoContinueCaptions(page);
  await page.goto(PAGE);
  for (const sel of [FORWARD, REVERSED]) {
    await expect.poll(async () => (await readProbeAt(page, sel)).state, { timeout: 20_000 }).toBe('running');
  }
  return async () => {
    expect(await glCounts(page)).toMatchObject({ live: 2, lost: 0 });
    errors.assertNone('on the pair page');
    expect(consoleErrors).toEqual([]);
    expect(requests).toEqual([PAGE]);
  };
}

const control = (page: Page, sel: string, which: string) => page.locator(sel).locator(`button[data-control="${which}"]`);

async function badgeOf(page: Page, sel: string): Promise<string> {
  return page.evaluate((s) => document.querySelector(s)?.shadowRoot?.querySelector('.badge')?.textContent?.trim() ?? '', sel);
}

test('the forward and reversed boards hold the same state at every tick and end on the same hash', async ({ page }) => {
  test.setTimeout(120_000);
  const finish = await openPage(page);

  for (const sel of [FORWARD, REVERSED]) {
    await page.locator(sel).locator('select').selectOption({ label: '4x' });
    await control(page, sel, 'restart').click();
  }
  for (const sel of [FORWARD, REVERSED]) {
    await expect.poll(async () => (await readProbeAt(page, sel)).endHash, { timeout: 60_000, intervals: [250] }).not.toBeNull();
  }
  const forward = await readTraceAt(page, FORWARD);
  const reversed = await readTraceAt(page, REVERSED);
  const fwdProbe = await readProbeAt(page, FORWARD);

  // 1. Tick by tick, the two runs.
  let firstDiff: string | null = null;
  for (let i = 0; i < Math.max(forward.length, reversed.length); i++) {
    const f = forward[i];
    const r = reversed[i];
    if (f === undefined || r === undefined || f[0] !== r[0]) {
      firstDiff = `trace entry ${i}: forward is at tick ${f?.[0]}, reversed at tick ${r?.[0]}`;
      break;
    }
    if (f[1] !== r[1]) {
      firstDiff = `tick ${f[0]}: forward ${f[1].slice(0, 8)}, reversed ${r[1].slice(0, 8)}`;
      break;
    }
  }
  expect(firstDiff, 'the first tick where the reversed board differs from the forward one').toBeNull();
  const compared = forward.length - 1;
  console.log(
    `${BOARD}: forward and reversed equal at the boot tick ${fwdProbe.bootTick} and at all ${compared} ticks after it, to tick ${fwdProbe.endTick}`,
  );
  expect(compared, 'every tick from the boot tick to the end tick was compared').toBe(fwdProbe.endTick - fwdProbe.bootTick);

  // 2. The forward run is the native engine's run.
  expectTraceMatchesNative(BOARD, forward, 'all');

  // 3. What the reader sees: two badges with the same 8 characters, both matching the pin.
  const pinned = manifestLine(BOARD);
  const want = `final state ${pinned.hash.slice(0, 8)} match`;
  expect(await badgeOf(page, FORWARD), 'the forward badge').toBe(want);
  expect(await badgeOf(page, REVERSED), 'the reversed badge').toBe(want);
  console.log(`both badges read "${want}"`);

  // 4. The order strips.
  expect((await readProbeAt(page, FORWARD)).orderStrip).toBe('same-tick events in file order');
  expect((await readProbeAt(page, REVERSED)).orderStrip).toBe('same-tick events in reverse order');
  await expect(page.locator(FORWARD).locator('.order-strip')).toBeVisible();

  // 5. Both still draw. From the boot tick at 1x, the webhooks' items cross the long belt.
  for (const sel of [FORWARD, REVERSED]) {
    await page.locator(sel).locator('select').selectOption({ label: '1x' });
    await control(page, sel, 'restart').click();
  }
  for (const sel of [FORWARD, REVERSED]) await expectBoardDrawingAt(page, sel, 'on the pair page');

  // 6. Side by side at this width: the wrapper is wider than 960 px.
  const boxes = await page.evaluate(() =>
    ['#forward', '#reversed'].map((s) => (document.querySelector(s) as HTMLElement).getBoundingClientRect().toJSON() as DOMRect),
  );
  const wrapper = await page.evaluate(() => (document.querySelector('.pair-wrap') as HTMLElement).clientWidth);
  expect(wrapper).toBeGreaterThanOrEqual(960);
  expect(boxes[1].left - boxes[0].right, 'a 16 px gap between the pair').toBeCloseTo(16, 0);
  expect(boxes[1].top).toBeCloseTo(boxes[0].top, 0);
  await finish();
});

test('at a 900 px viewport the pair stacks with a 16 px gap', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 900, height: 900 });
  const finish = await openPage(page);
  const wrapper = await page.evaluate(() => (document.querySelector('.pair-wrap') as HTMLElement).clientWidth);
  expect(wrapper).toBeLessThan(960);
  const boxes = await page.evaluate(() =>
    ['#forward', '#reversed'].map((s) => (document.querySelector(s) as HTMLElement).getBoundingClientRect().toJSON() as DOMRect),
  );
  expect(boxes[1].top - boxes[0].bottom, 'the reversed board sits 16 px below the forward one').toBeCloseTo(16, 0);
  expect(boxes[1].left).toBeCloseTo(boxes[0].left, 0);
  expect(boxes[0].width).toBeCloseTo(wrapper, 0);
  await page.locator(REVERSED).scrollIntoViewIfNeeded();
  await control(page, REVERSED, 'restart').click();
  await expectBoardDrawingAt(page, REVERSED, 'stacked at 900 px');
  await finish();
});
