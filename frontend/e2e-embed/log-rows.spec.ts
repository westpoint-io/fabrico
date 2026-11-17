import { expect, test, type Page } from '@playwright/test';
import {
  autoContinueCaptions,
  glCounts,
  installGlCounter,
  pageUrl,
  readProbe,
  recordConsoleErrors,
  recordRequests,
  watchPageErrors,
  WHOLE_PAGE_VIEWPORT,
} from './support/health.ts';

// The effect log's FAULT, ROUTE and REPLY rows on log-rows.html. A fault that reaches a dead letter
// Debug Sink, a Debug Sink at the end of a fault path, prints as `FAULT <Reason>` where it used to
// print the fault's raw bytes. The player decides which Debug messages are faults, by the engine's
// own fault-path rule, so this spec only reads the rows the page shows. Each request the script
// sends in through a Route prints as a ROUTE row, and the Handler's reply as a REPLY row with the
// status it carries, both numbered by the request's correlation id from 0. On a board that calls
// out, the empty line goes when the first row of any kind lands, a DEBUG row included.

const PAGE = pageUrl('log-rows.html');
// Every board on this page runs at once, so the viewport holds the whole page.
test.use({ viewport: WHOLE_PAGE_VIEWPORT });
const TIMEOUT = 'docs-faults-command-timeout';
const HANDLER = 'docs-machines-http-handler';
const DEBUG_FIRST = 'debug-first';
const BOARDS = [TIMEOUT, HANDLER, DEBUG_FIRST] as const;
const EMPTY_LINE = 'No outbound calls yet. Each call this board makes shows up here with its tick and its scripted result.';
/** The C0 control characters a row must never print, leaving out tab and the line breaks. */
const CONTROL = /[\u0000-\u0008\u000e-\u001f]/;

async function openPage(page: Page): Promise<() => Promise<void>> {
  const errors = watchPageErrors(page);
  const consoleErrors = recordConsoleErrors(page);
  const requests = recordRequests(page);
  await installGlCounter(page);
  // The boards' captions would hold them; this spec is about the rows, so it reads each note at once.
  await autoContinueCaptions(page);
  await page.goto(PAGE);
  for (const name of BOARDS) {
    await expect.poll(async () => (await readProbe(page, name)).state, { timeout: 20_000 }).toBe('running');
  }
  return async () => {
    expect(requests, 'the page made no request after itself').toEqual([PAGE]);
    expect((await glCounts(page)).lost).toBe(0);
    errors.assertNone('on the log rows page');
    expect(consoleErrors, 'the page logged no console error').toEqual([]);
  };
}

const board = (page: Page, name: string) => page.locator(`fabrico-board[name="${name}"]`);

/** Restart a board at 4x and wait for its end hash, checking that it draws frames on the way. */
async function runToEnd(page: Page, name: string): Promise<Awaited<ReturnType<typeof readProbe>>> {
  const b = board(page, name);
  await b.scrollIntoViewIfNeeded();
  await b.locator('select').selectOption({ label: '4x' });
  const before = (await readProbe(page, name)).frames;
  await b.locator('button[data-control="restart"]').click();
  await expect
    .poll(async () => (await readProbe(page, name)).frames - before, { message: `${name}'s frame count rises after Restart`, timeout: 20_000 })
    .toBeGreaterThanOrEqual(2);
  await expect.poll(async () => (await readProbe(page, name)).endHash, { timeout: 60_000 }).not.toBeNull();
  return readProbe(page, name);
}

test('a CommandTimeout that reaches a dead letter Debug Sink reads as one FAULT row, not its bytes', async ({ page }) => {
  test.setTimeout(120_000);
  const finish = await openPage(page);
  const end = await runToEnd(page, TIMEOUT);
  console.log(`${TIMEOUT} at its end: ${end.effectRows.map((r) => r.cells.join('  ')).join(' | ')}`);

  const faults = end.effectRows.filter((r) => r.cells[1] === 'FAULT');
  expect(faults, 'one fault reaches the dead letter Sink').toHaveLength(1);
  const [fault] = faults;
  expect(fault.cells[0]).toMatch(/^t\d+$/);
  expect(fault.cells.slice(1)).toEqual(['FAULT', 'CommandTimeout', '']);
  expect(fault.title).toBe('CommandTimeout fault, keeps no payload');
  for (const r of end.effectRows) {
    expect(r.cells[2], `row ${r.cells.join(' ')} prints no control character`).not.toMatch(CONTROL);
  }
  expect(end.effectRows.filter((r) => r.cells[1] === 'DEBUG'), 'the dead letter Sink leaves no DEBUG row').toEqual([]);

  // The row carries is-fault, and FAULT takes the destructive colour that the timed-out call's
  // outcome shows, while the reason stays in ink.
  const look = await board(page, TIMEOUT).evaluate((el) => {
    const root = el.shadowRoot as ShadowRoot;
    const row = [...root.querySelectorAll('.log-well .row')].find((r) => r.children[1]?.textContent === 'FAULT') as HTMLElement;
    const colour = (e: Element | null): string => (e === null ? '' : getComputedStyle(e).color);
    return {
      className: row.className,
      method: colour(row.querySelector('.method')),
      target: colour(row.querySelector('.target')),
      failure: colour(root.querySelector('.log-well .outcome.is-failure')),
    };
  });
  expect(look.className).toBe('row is-fault');
  expect(look.failure, 'the timed-out call shows its outcome in the destructive colour').not.toBe('');
  expect(look.method, 'FAULT is in the destructive colour').toBe(look.failure);
  expect(look.target, 'the reason stays in ink').not.toBe(look.failure);
  await finish();
});

test('each request a Route takes is a ROUTE row, paired by number with a REPLY row that shows the Handler\'s status', async ({ page }) => {
  test.setTimeout(120_000);
  const finish = await openPage(page);
  const end = await runToEnd(page, HANDLER);
  console.log(`${HANDLER} at its end: ${end.effectRows.map((r) => r.cells.join('  ')).join(' | ')}`);

  const routes = end.effectRows.filter((r) => r.cells[1] === 'ROUTE');
  const replies = end.effectRows.filter((r) => r.cells[1] === 'REPLY');
  expect(routes.length, 'the script sends requests in').toBeGreaterThan(0);
  const numbers: number[] = [];
  for (const route of routes) {
    const match = /^request (\d+): [A-Z]+ \/endpoint\/\S+$/.exec(route.cells[2]);
    expect(match, `ROUTE target ${route.cells[2]}`).not.toBeNull();
    expect(route.cells[3], 'a ROUTE row has no outcome').toBe('');
    const n = Number(match?.[1]);
    numbers.push(n);
    const paired = replies.filter((r) => r.cells[2].startsWith(`request ${n}: status `));
    expect(paired, `exactly one REPLY row answers request ${n}`).toHaveLength(1);
    expect(paired[0].cells[2]).toMatch(new RegExp(`^request ${n}: status \\d+$`));
    expect(paired[0].title).toMatch(new RegExp(`^Reply to request ${n}: status \\d+, answered at tick \\d+$`));
  }
  expect(Math.min(...numbers), 'requests are numbered from 0').toBe(0);
  expect(replies, 'every REPLY row pairs with a ROUTE row').toHaveLength(routes.length);
  await finish();
});

test('the empty line on a board that calls out goes when its first row lands, though that row is DEBUG', async ({ page }) => {
  test.setTimeout(120_000);
  const finish = await openPage(page);
  const b = board(page, DEBUG_FIRST);
  await b.scrollIntoViewIfNeeded();
  await b.locator('button[data-control="restart"]').click();
  await expect(b.locator('.log-well .note')).toHaveText(EMPTY_LINE);

  // The rows and the note, read in one go, the moment the first row is there.
  const read = () =>
    b.evaluate((el) => {
      const well = (el.shadowRoot as ShadowRoot).querySelector('.log-well') as HTMLElement;
      return {
        rows: [...well.querySelectorAll('.row')].map((r) => r.children[1]?.textContent ?? ''),
        note: well.querySelector('.note')?.textContent ?? null,
      };
    });
  await expect.poll(async () => (await read()).rows.length, { message: 'the first row lands', timeout: 30_000 }).toBeGreaterThan(0);
  const first = await read();
  console.log(`${DEBUG_FIRST} at its first row: rows ${first.rows.join(', ')}; note ${JSON.stringify(first.note)}`);
  expect(first.rows, 'only the DEBUG row has landed, before the call').toEqual(['DEBUG']);
  expect(first.note, 'the empty line is gone').toBeNull();

  await expect.poll(async () => (await readProbe(page, DEBUG_FIRST)).endHash, { timeout: 60_000 }).not.toBeNull();
  const end = await read();
  expect(end.rows, 'the call follows the DEBUG row').toEqual(['DEBUG', 'POST']);
  expect(end.note).toBeNull();
  await finish();
});
