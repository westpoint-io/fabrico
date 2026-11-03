import { expect, test, type Page } from '@playwright/test';
import {
  expectDrawsAfter,
  glCounts,
  installGlCounter,
  pageUrl,
  readProbe,
  recordConsoleErrors,
  recordRequests,
  watchPageErrors,
} from './support/health.ts';

// The code view and the effect log on panels.html. The code view shows each Factory's and HTTP
// Handler's JavaScript as text, with tabs `Factory 1` and `Handler 1` in board order and no tab
// row for one machine; markup in a source stays text. The effect log lists each call the run would
// make with its tick, method, URL and `ok`, `error` or `timeout`, never a status code, cuts a long
// URL with an ellipsis, and follows the newest row unless the reader scrolls up. The page loads
// nothing after itself: the request recorder sees only the page's own URL.

const PAGE = pageUrl('panels.html');
const BOARDS = ['demo_scene', 'docs-script-outcomes', 'docs-arrival-order', 'one-factory'] as const;
const OUTCOMES = 'docs-script-outcomes';
const SUBSTRATE = [0x1b, 0x1f, 0x27] as const;

async function openPage(page: Page): Promise<() => Promise<void>> {
  const errors = watchPageErrors(page);
  const consoleErrors = recordConsoleErrors(page);
  const requests = recordRequests(page);
  await installGlCounter(page);
  await page.goto(PAGE);
  for (const name of BOARDS) {
    await expect.poll(async () => (await readProbe(page, name)).state, { timeout: 20_000 }).toBe('running');
  }
  return async () => {
    // The request list first: it names a URL the page reached for, whether or not the page's
    // policy stopped it. Without the policy a cross-origin fetch still goes out and only its answer
    // is blocked, so the console line would name CORS rather than the request.
    expect(requests, 'the page made no request after itself').toEqual([PAGE]);
    expect((await glCounts(page)).lost).toBe(0);
    errors.assertNone('on the panels page');
    expect(consoleErrors, 'the page logged no console error').toEqual([]);
  };
}

const board = (page: Page, name: string) => page.locator(`fabrico-board[name="${name}"]`);

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

/** The boxes of a board's parts, in viewport px. */
async function readBoxes(page: Page, name: string): Promise<{ element: Box; frameContent: number; stage: Box; bar: Box; code: Box | null }> {
  return page.evaluate((n) => {
    const box = (e: Element): Box => {
      const r = e.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
    };
    const el = document.querySelector(`fabrico-board[name="${n}"]`) as HTMLElement;
    const root = el.shadowRoot as ShadowRoot;
    const frame = root.querySelector('.frame') as HTMLElement;
    const cs = getComputedStyle(frame);
    const code = root.querySelector('.code-column') as HTMLElement;
    return {
      element: box(el),
      frameContent: frame.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
      stage: box(root.querySelector('.stage') as Element),
      bar: box(root.querySelector('.bar') as Element),
      code: code.hidden || getComputedStyle(code).display === 'none' ? null : box(code),
    };
  }, name);
}

/** WCAG contrast of an `rgb(r, g, b)` colour on the substrate. */
function contrastOnSubstrate(css: string): number {
  const m = /rgba?\((\d+), (\d+), (\d+)/.exec(css);
  if (m === null) throw new Error(`not an rgb colour: ${css}`);
  const lum = (rgb: readonly number[]): number => {
    const c = rgb.map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const a = lum([Number(m[1]), Number(m[2]), Number(m[3])]);
  const b = lum(SUBSTRATE);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

test('each board shows its Factory and Handler code as text, in tabs by board order', async ({ page }) => {
  test.setTimeout(90_000);
  const finish = await openPage(page);

  const arrival = await readProbe(page, 'docs-arrival-order');
  expect(arrival.codeTabs, 'arrival-order has no Factory, so no code column').toEqual([]);
  expect(arrival.codeText).toBeNull();
  const arrivalBoxes = await readBoxes(page, 'docs-arrival-order');
  expect(arrivalBoxes.code).toBeNull();
  expect(arrivalBoxes.stage.width, 'with no code column the stage takes the full width').toBeCloseTo(arrivalBoxes.frameContent, 0);

  const one = await readProbe(page, 'one-factory');
  expect(one.codeTabs, 'one Factory: no tab row').toEqual([]);
  expect(one.codeText).toContain('ctx.emit(0, input);');
  expect(await board(page, 'one-factory').locator('[role="tablist"]').isVisible()).toBe(false);
  // The markup in the source is text: the reader sees the characters and no element is made.
  expect(one.codeText).toContain('const note = "<img src=x onerror=alert(1)>";');
  const made = await page.evaluate(() =>
    [...document.querySelectorAll('fabrico-board')].reduce((n, b) => n + (b.shadowRoot?.querySelectorAll('img, script').length ?? 0), 0),
  );
  expect(made, 'no img or script element inside any board').toBe(0);
  await expect(board(page, 'one-factory').locator('.code-well')).toContainText('<img src=x onerror=alert(1)>');

  const outcomes = await readProbe(page, OUTCOMES);
  expect(outcomes.codeTabs).toEqual(['Factory 1', 'Handler 1']);
  expect(outcomes.codeText).toBe('export default function (input, ctx) { ctx.emit(0, input); }');
  const handlerTab = board(page, OUTCOMES).getByRole('tab', { name: 'Handler 1' });
  const factoryTab = board(page, OUTCOMES).getByRole('tab', { name: 'Factory 1' });
  await expect(factoryTab).toHaveAttribute('aria-selected', 'true');
  await handlerTab.click();
  await expect(handlerTab).toHaveAttribute('aria-selected', 'true');
  await expect(handlerTab).toHaveClass(/is-pressed/);
  expect((await readProbe(page, OUTCOMES)).codeText, "the Handler's source").toContain('body: "hello"');
  await page.keyboard.press('ArrowLeft');
  await expect(factoryTab).toHaveAttribute('aria-selected', 'true');
  await expect(factoryTab).toBeFocused();
  // The tabs and the well are 44 px targets and a focusable scroll box.
  for (const tab of [factoryTab, handlerTab]) {
    const b = await tab.boundingBox();
    expect(b?.height ?? 0).toBeGreaterThanOrEqual(44);
  }
  await expect(board(page, OUTCOMES).locator('.code-well')).toHaveAttribute('tabindex', '0');
  await expect(board(page, OUTCOMES).locator('.tok-keyword').first()).toHaveCSS('color', 'rgb(79, 168, 255)');

  // The no-code attribute hides the column, and the stage takes the width back.
  await page.evaluate((n) => document.querySelector(`fabrico-board[name="${n}"]`)?.setAttribute('no-code', ''), OUTCOMES);
  const hidden = await readBoxes(page, OUTCOMES);
  expect(hidden.code, 'no-code hides the code column').toBeNull();
  expect(hidden.stage.width).toBeCloseTo(hidden.frameContent, 0);
  await page.evaluate((n) => document.querySelector(`fabrico-board[name="${n}"]`)?.removeAttribute('no-code'), OUTCOMES);
  expect((await readBoxes(page, OUTCOMES)).code).not.toBeNull();
  await finish();
});

test('the code column sits beside the stage at 720 px and wider and under the control bar below that', async ({ page }) => {
  test.setTimeout(90_000);
  const finish = await openPage(page);

  const wide = await readBoxes(page, OUTCOMES);
  expect(wide.element.width).toBe(960);
  expect(wide.code).not.toBeNull();
  if (wide.code === null) return;
  console.log(
    `${OUTCOMES} at 960 px: stage ${wide.stage.width.toFixed(1)} x ${wide.stage.height.toFixed(1)}, code ${wide.code.width.toFixed(1)} x ${wide.code.height.toFixed(1)}`,
  );
  expect(wide.code.left - wide.stage.right, 'an 8 px gap between the stage and the code').toBeCloseTo(8, 0);
  expect(wide.code.top, 'the code column starts level with the stage').toBeCloseTo(wide.stage.top, 0);
  expect(Math.abs(wide.code.height - wide.stage.height), 'the code column is as tall as the stage').toBeLessThanOrEqual(1);
  expect(wide.code.width).toBeGreaterThanOrEqual(280);
  expect(Math.abs(wide.stage.width / (wide.stage.width + wide.code.width) - 0.6), 'the stage takes 60 percent').toBeLessThanOrEqual(0.01);
  const want = Math.min(560, Math.max(240, (wide.stage.width * 10) / 16));
  expect(Math.abs(wide.stage.height - want), 'the stage keeps 16:10 in its column').toBeLessThanOrEqual(1);

  for (const name of ['one-factory', 'demo_scene']) {
    const narrow = await readBoxes(page, name);
    expect(narrow.element.width).toBe(600);
    expect(narrow.code, `${name}: the code column shows`).not.toBeNull();
    if (narrow.code === null) return;
    expect(narrow.code.top, `${name}: under 720 px the code column sits below the control bar`).toBeGreaterThanOrEqual(narrow.bar.bottom);
    expect(narrow.code.height, `${name}: stacked, the code column is 240 px tall`).toBeCloseTo(240, 0);
    expect(narrow.code.width, `${name}: stacked, the code column is full width`).toBeCloseTo(narrow.frameContent, 0);
    expect(narrow.stage.width).toBeCloseTo(narrow.frameContent, 0);
  }

  // A line longer than the well scrolls sideways inside it, and the element keeps its width.
  const well = board(page, 'one-factory').locator('.code-well');
  const before = await well.evaluate((w) => ({ scroll: w.scrollWidth, client: w.clientWidth, whiteSpace: getComputedStyle(w.querySelector('pre') as Element).whiteSpace }));
  expect(before.whiteSpace).toBe('pre');
  expect(before.scroll, 'the long comment line is wider than the well').toBeGreaterThan(before.client);
  await well.hover();
  await page.mouse.wheel(200, 0);
  await expect.poll(() => well.evaluate((w) => w.scrollLeft), { message: 'the well scrolls sideways' }).toBeGreaterThan(0);
  expect((await readBoxes(page, 'one-factory')).element.width, 'the element is still 600 px').toBe(600);
  const lineCount = await well.evaluate((w) => Math.round((w.querySelector('pre') as HTMLElement).getBoundingClientRect().height / 16.8));
  expect(lineCount, 'the five lines of source stay five lines, unwrapped').toBeLessThanOrEqual(6);
  await finish();
});

test('the effect log names each scripted call with ok, error or timeout and never a status code', async ({ page }) => {
  test.setTimeout(120_000);
  const finish = await openPage(page);

  // arrival-order makes no outbound call.
  await expect(board(page, 'docs-arrival-order').locator('.log-well .note')).toHaveText('This board makes no outbound calls.');

  // script-outcomes, from the start, at 4x, to its end.
  const b = board(page, OUTCOMES);
  await b.scrollIntoViewIfNeeded();
  await b.locator('select').selectOption({ label: '4x' });
  await b.locator('button[data-control="restart"]').click();
  await expect(b.locator('.log-well .note')).toHaveText(
    'No outbound calls yet. Each call this board makes shows up here with its tick and its scripted result.',
  );
  await expect.poll(async () => (await readProbe(page, OUTCOMES)).endHash, { timeout: 60_000 }).not.toBeNull();
  const end = await readProbe(page, OUTCOMES);
  const calls = end.effectRows.filter((r) => r.cells[1] !== 'DEBUG');
  console.log(`${OUTCOMES} at its end: ${end.effectRows.length} rows, calls ${calls.map((r) => r.cells.join(' ')).join(' | ')}`);
  const find = (path: string) => calls.find((r) => r.cells[2] === `https://example.com${path}`);
  expect(find('/slow')?.cells.slice(1)).toEqual(['POST', 'https://example.com/slow', 'ok']);
  expect(find('/bad')?.cells.slice(1)).toEqual(['POST', 'https://example.com/bad', 'error']);
  expect(find('/lost')?.cells.slice(1)).toEqual(['POST', 'https://example.com/lost', 'timeout']);
  const slowTick = Number(find('/slow')?.cells[0].slice(1));
  expect(find('/slow')?.title).toBe(`https://example.com/slow, answered at tick ${slowTick + 40}`);
  expect(find('/lost')?.title).toBe('https://example.com/lost, no answer, so it timed out');
  const reply = calls.find((r) => r.cells[1] === 'REPLY');
  expect(reply?.cells[2]).toMatch(/^request \d+$/);
  expect(reply?.cells[3]).toBe('ok');
  for (const r of end.effectRows) {
    expect(r.cells[0]).toMatch(/^t\d+$/);
    expect(['ok', 'error', 'timeout', '']).toContain(r.cells[3]);
    expect(`${r.cells[1]} ${r.cells[3]}`, 'no status code in a row').not.toMatch(/\d/);
  }
  const debug = end.effectRows.filter((r) => r.cells[1] === 'DEBUG');
  expect(debug.length, 'the Debug sink and its timer leave muted rows').toBeGreaterThan(0);
  expect(debug.every((r) => r.cells[3] === '')).toBe(true);

  // The colours: ok in ink, error and timeout destructive, Debug muted and still readable.
  const colours = await b.evaluate((el) => {
    const root = el.shadowRoot as ShadowRoot;
    const pick = (sel: string): string => getComputedStyle(root.querySelector(sel) as Element).color;
    const outcomeOf = (word: string): string => {
      const cell = [...root.querySelectorAll('.row .outcome')].find((c) => c.textContent === word) as Element;
      return getComputedStyle(cell).color;
    };
    return { ok: outcomeOf('ok'), error: outcomeOf('error'), timeout: outcomeOf('timeout'), debug: pick('.row.is-debug'), call: pick('.row.is-call') };
  });
  expect(colours.ok).toBe('rgb(176, 186, 203)');
  expect(colours.error).toBe('rgb(240, 80, 110)');
  expect(colours.timeout).toBe('rgb(240, 80, 110)');
  expect(colours.debug, 'Debug rows are muted').not.toBe(colours.call);
  const debugContrast = contrastOnSubstrate(colours.debug);
  console.log(`Debug row colour ${colours.debug}: ${debugContrast.toFixed(2)}:1 on the substrate`);
  expect(debugContrast).toBeGreaterThanOrEqual(4.5);

  // The well caps at 160 px.
  const well = b.locator('.log-well');
  const metrics = await well.evaluate((w) => ({ height: w.getBoundingClientRect().height, scroll: w.scrollHeight, client: w.clientHeight, top: w.scrollTop, role: w.getAttribute('role') }));
  expect(metrics.role).toBe('log');
  expect(metrics.height).toBeLessThanOrEqual(160);
  expect(metrics.scroll, 'the rows overflow the well').toBeGreaterThan(metrics.client);
  expect(metrics.scroll - metrics.top - metrics.client, 'it followed the newest row').toBeLessThanOrEqual(2);
  // And the page still draws. The demo board, held on its first caption since load, moves again
  // when Continue is pressed; its belts carry a steady flow of orders, where script-outcomes'
  // belts carry one item each.
  await board(page, 'demo_scene').scrollIntoViewIfNeeded();
  await expect.poll(async () => (await readProbe(page, 'demo_scene')).caption !== null, { timeout: 20_000 }).toBe(true);
  await expectDrawsAfter(page, 'demo_scene', () => board(page, 'demo_scene').locator('button[data-control="play"]').click(), 'on the panels page');
  await finish();
});

test('the log stays where the reader scrolled it, and a long URL is cut on one line', async ({ page }) => {
  test.setTimeout(120_000);
  const finish = await openPage(page);
  const b = board(page, OUTCOMES);
  await b.scrollIntoViewIfNeeded();
  await b.locator('select').selectOption({ label: '4x' });
  await b.locator('button[data-control="restart"]').click();
  const well = b.locator('.log-well');
  await expect
    .poll(() => well.evaluate((w) => w.scrollHeight - w.clientHeight), { message: 'the log fills its well', timeout: 30_000 })
    .toBeGreaterThan(60);
  // The reader turns the wheel up over the log.
  await b.locator('select').selectOption({ label: '0.5x' });
  await well.hover();
  await page.mouse.wheel(0, -1000);
  await expect.poll(async () => (await readProbe(page, OUTCOMES)).logScrollTop).toBe(0);
  const rowsAtScroll = (await readProbe(page, OUTCOMES)).effectRows.length;
  await expect
    .poll(async () => (await readProbe(page, OUTCOMES)).effectRows.length, { message: 'more rows arrive', timeout: 30_000 })
    .toBeGreaterThan(rowsAtScroll);
  expect((await readProbe(page, OUTCOMES)).logScrollTop, 'the log stays where the reader left it').toBe(0);
  console.log(`rows ${rowsAtScroll} when the reader scrolled up; the log stayed at the top as more came in`);

  // one-factory's Sink has a long URL.
  const longUrl = 'https://example.com/orders/archive/2026/november/first-week/incoming/accepted/by-region/europe/west';
  const lb = board(page, 'one-factory');
  await lb.scrollIntoViewIfNeeded();
  await expect.poll(async () => (await readProbe(page, 'one-factory')).effectRows.length, { timeout: 30_000 }).toBeGreaterThan(0);
  const row = await lb.locator('.log-well .row').first().evaluate((r) => {
    const target = r.querySelector('.target') as HTMLElement;
    const cs = getComputedStyle(target);
    return {
      title: (r as HTMLElement).title,
      text: target.textContent,
      height: r.getBoundingClientRect().height,
      overflow: target.scrollWidth > target.clientWidth,
      ellipsis: cs.textOverflow,
      whiteSpace: cs.whiteSpace,
      rowRight: r.getBoundingClientRect().right,
      wellRight: (r.parentElement as HTMLElement).getBoundingClientRect().right,
    };
  });
  expect(row.text).toBe(longUrl);
  expect(row.title).toBe(`${longUrl}, answered at tick ${Number((await readProbe(page, 'one-factory')).effectRows[0].cells[0].slice(1)) + 40}`);
  expect(row.overflow, 'the URL is wider than its cell').toBe(true);
  expect(row.ellipsis).toBe('ellipsis');
  expect(row.whiteSpace).toBe('nowrap');
  expect(row.height, 'one line: 12 px at line height 1.4 plus 4 px above and below').toBeLessThanOrEqual(26);
  expect(row.rowRight).toBeLessThanOrEqual(row.wellRight);
  await finish();
});
