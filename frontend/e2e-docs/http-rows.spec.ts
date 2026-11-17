import { type Page, expect, test } from '@playwright/test';
import {
  autoContinueCaptions,
  boardFileText,
  expectBoardDrawingSteppedAt,
  installGlCounter,
  manifestLine,
  readProbeAt,
  recordConsoleErrors,
  watchPageErrors,
} from '../e2e-embed/support/health.ts';
import { docsUrl } from './support/site.ts';

// The pattern pages whose board serves HTTP: each request the board's script sends in through a
// Route must show in the effect log as a ROUTE row, and each ROUTE row must have exactly one REPLY
// row that answers it with the Handler's status. The ROUTE rows are counted against the Request
// entries in the board file under examples/boards/docs/, read at run time, so a request the embed
// drops, or a reply that loses its status or its number, fails here. Request numbers start at 0.
//
// The exactly-once page's board gets one webhook, and its HTTP Sink must make one call for it: at
// the end tick the log holds exactly one call row, POST to the charges URL with outcome ok, and no
// ROUTE or FAULT row. A second webhook in the script, or a call sent twice, fails that test.
//
// boards.spec.ts already checks that each board reaches its manifest hash; this spec reads only the
// rows at the end tick.

const PAGES: { page: string; board: string }[] = [
  { page: 'patterns/local-http-endpoint/', board: 'docs-patterns-local-http-endpoint' },
  { page: 'patterns/mock-api-server/', board: 'docs-patterns-mock-api-server' },
];

/** The number of `Request(...)` entries in a board file's script. */
function scriptedRequests(board: string): number {
  return [...boardFileText(board).matchAll(/\binput:\s*Request\(/g)].length;
}

/** The page's one board, played to its manifest end tick with each caption continued at once. */
async function rowsAtEnd(page: Page, pagePath: string, board: string): Promise<{ cells: string[] }[]> {
  await installGlCounter(page);
  // The board stops at each caption; press Continue at once, as a reader would.
  await autoContinueCaptions(page);

  await page.goto(docsUrl(pagePath));
  const selector = `fabrico-board[name="${board}"]`;
  await expect(page.locator(selector), `${pagePath}: one ${board} board on the page`).toHaveCount(1);
  await page.locator(selector).scrollIntoViewIfNeeded();
  await expect
    .poll(async () => (await readProbeAt(page, selector)).mounted, { message: `${pagePath}: ${board} mounts`, timeout: 20_000 })
    .toBe(true);
  await expectBoardDrawingSteppedAt(page, selector, 'while it plays', `${pagePath} ${board}`);

  const { endTick } = manifestLine(board);
  await expect
    .poll(async () => (await readProbeAt(page, selector)).tick, {
      message: `${pagePath}: ${board} reaches tick ${endTick}`,
      timeout: 60_000,
      intervals: [500],
    })
    .toBe(endTick);
  const end = await readProbeAt(page, selector);
  console.log(`${pagePath} ${board} at tick ${endTick}: ${end.effectRows.map((r) => r.cells.join('  ')).join(' | ')}`);
  return end.effectRows;
}

for (const { page: pagePath, board } of PAGES) {
  test(`${pagePath}: each scripted request is a ROUTE row with exactly one REPLY row that carries its status`, async ({ page }) => {
    test.setTimeout(120_000);
    const errors = watchPageErrors(page);
    const consoleErrors = recordConsoleErrors(page);
    const effectRows = await rowsAtEnd(page, pagePath, board);

    const routes = effectRows.filter((r) => r.cells[1] === 'ROUTE');
    const replies = effectRows.filter((r) => r.cells[1] === 'REPLY');
    const scripted = scriptedRequests(board);
    expect(scripted, `${pagePath}: the script of ${board} sends at least one request`).toBeGreaterThan(0);
    expect(
      routes.length,
      `${pagePath}: the script of ${board} sends ${scripted} requests, and the effect log shows ${routes.length} ROUTE rows`,
    ).toBe(scripted);

    const numbers: number[] = [];
    for (const route of routes) {
      const match = /^request (\d+): POST \/endpoint\/\S+$/.exec(route.cells[2]);
      expect(match, `${pagePath}: the ROUTE row "${route.cells[2]}" reads request <n>: POST /endpoint/<path>`).not.toBeNull();
      const n = Number(match?.[1]);
      numbers.push(n);
      const answer = new RegExp(`^request ${n}: status \\d+$`);
      const paired = replies.filter((r) => answer.test(r.cells[2]));
      expect(
        paired.length,
        `${pagePath}: request ${n} needs exactly one REPLY row reading "request ${n}: status <code>", and the log has ` +
          `${paired.length} (REPLY rows: ${replies.map((r) => r.cells[2]).join(', ') || 'none'})`,
      ).toBe(1);
    }
    expect(new Set(numbers).size, `${pagePath}: each ROUTE row has its own request number`).toBe(numbers.length);
    expect(Math.min(...numbers), `${pagePath}: requests are numbered from 0`).toBe(0);

    errors.assertNone(`on ${pagePath}`);
    expect(consoleErrors, `${pagePath}: console errors`).toEqual([]);
  });
}

const EXACTLY_ONCE = { page: 'patterns/call-exactly-once/', board: 'docs-patterns-call-exactly-once', url: 'https://example.com/charges' };

/** Row kinds that aren't an HTTP Sink's call; every other method cell is a call's HTTP method. */
const NOT_A_CALL = new Set(['ROUTE', 'REPLY', 'FAULT', 'DEBUG']);

test(`${EXACTLY_ONCE.page}: the effect log shows exactly one call row, POST ${EXACTLY_ONCE.url} ok, and no ROUTE or FAULT row`, async ({ page }) => {
  test.setTimeout(120_000);
  const { page: pagePath, board, url } = EXACTLY_ONCE;
  const errors = watchPageErrors(page);
  const consoleErrors = recordConsoleErrors(page);
  const effectRows = await rowsAtEnd(page, pagePath, board);

  const calls = effectRows.filter((r) => !NOT_A_CALL.has(r.cells[1]));
  const shownRows = effectRows.map((r) => r.cells.join('  ')).join(' | ') || 'none';
  expect(calls.length, `${pagePath}: the page says the board makes one call, and the effect log has ${calls.length} call rows (rows: ${shownRows})`).toBe(1);
  const [, method, target, outcome] = calls[0].cells;
  expect({ method, target, outcome }, `${pagePath}: the one call row`).toEqual({ method: 'POST', target: url, outcome: 'ok' });
  for (const kind of ['ROUTE', 'FAULT']) {
    const found = effectRows.filter((r) => r.cells[1] === kind);
    expect(found.length, `${pagePath}: the board shows no ${kind} rows (rows: ${shownRows})`).toBe(0);
  }

  errors.assertNone(`on ${pagePath}`);
  expect(consoleErrors, `${pagePath}: console errors`).toEqual([]);
});
