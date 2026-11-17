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

// The effect log's FAULT rows on log-rows.html. A fault that reaches a dead letter Debug Sink, a
// Debug Sink at the end of a fault path, prints as `FAULT <Reason>` where it used to print the
// fault's raw bytes. The player decides which Debug messages are faults, by the engine's own
// fault-path rule, so this spec only reads the rows the page shows.

const PAGE = pageUrl('log-rows.html');
// Every board on this page runs at once, so the viewport holds the whole page.
test.use({ viewport: WHOLE_PAGE_VIEWPORT });
const TIMEOUT = 'docs-faults-command-timeout';
const BOARDS = [TIMEOUT] as const;
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
