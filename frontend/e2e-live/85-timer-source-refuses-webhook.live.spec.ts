import { test, expect, type Page } from '@playwright/test';
import {
  applyConfig,
  armAndPlaceAt,
  drawOffloadBelt,
  ensurePlaying,
  expectRenderLoopAlive,
  nodeAtAnchor,
  pollScene,
  pressSegment,
  readPanelUrl,
  readScene,
  resetToDemo,
  selectMachineAt,
  waitForAppReady,
  watchPageErrors,
  webhookUrl,
  type SceneFacts,
} from './support/oracle';

// 85-timer-source-refuses-webhook.live.spec.ts (DEMO-08, phase 85 success criterion 5).
//
// A Source set to Timer is fed by the host's own clock, so it has no webhook door: a
// POST to its URL is refused, and the panel shows no URL to copy. The same Source set
// back to Webhook shows the URL again and accepts the POST. walk-112 and walk-114 found
// the demo's Timer Source answering 200 and showing a URL it should not.
//
// WHAT IS GRADED IS WHAT THE USER MEETS: the HTTP status a POST gets, the item a POST
// puts on the board, and whether the URL row (and its Copy button) is in the DOM, both
// after each Apply and while a trigger is typed but not yet applied. The host refuses with 404
// and an empty body because a Timer Source is left out of the route table, so the
// handler's existing unknown-target branch answers before anything is enqueued (D-20).
//
// The Source is placed from the palette, not taken from the demo, so the spec does not
// depend on which trigger the shipped board gives its own Source. Its cell is chosen at
// run time from the live board: the first free run of four cells, two cells clear of
// every machine and belt, inside the board's own bounds (so the fitted camera shows it).
// An offload belt from its Out holds each accepted item where the model can count it.
//
// Render health is asserted (watchPageErrors before goto, expectRenderLoopAlive and
// assertNone at the end): the oracle reads the model, and a dead renderer would pass
// every model assertion here.

/** Cells a Source plus its three-cell offload belt need, with a two-cell clear margin. */
const RUN = 4;
const MARGIN = 2;

/** The anchor of the first free run of RUN cells on a row, scanning from the bottom. The scan
 *  starts just BELOW the board (MARGIN + 1 rows under its lowest node, so the margin clears
 *  it): the demo rebuilt by plan 85-08 fills its own box too densely for a run with a
 *  two-cell margin inside it, and the floor below the board is empty on a fresh demo. */
function freeRunOn(scene: SceneFacts): [number, number] {
  const taken = new Set<string>();
  for (const n of scene.nodes) for (const [x, y] of n.cells) taken.add(`${x},${y}`);
  for (const b of scene.belts) for (const t of b.tiles) taken.add(`${t.cell_x},${t.cell_y}`);
  const xs = scene.nodes.flatMap((n) => n.cells.map((c) => c[0]));
  const ys = scene.nodes.flatMap((n) => n.cells.map((c) => c[1]));
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  for (let y = maxY + MARGIN + 1; y >= minY; y -= 1) {
    for (let x = minX; x + RUN - 1 <= maxX; x += 1) {
      let clear = true;
      for (let dy = -MARGIN; dy <= MARGIN && clear; dy += 1) {
        for (let dx = -MARGIN; dx < RUN + MARGIN && clear; dx += 1) {
          if (taken.has(`${x + dx},${y + dy}`)) clear = false;
        }
      }
      if (clear) return [x, y];
    }
  }
  throw new Error('no free run of cells on the demo board for the placed Source');
}

/** The item count on the belt whose first tile is (x, y), or -1 when there is none. */
function itemsOnBeltAt(scene: SceneFacts, x: number, y: number): number {
  const belt = scene.belts.find((b) => b.tiles.some((t) => t.cell_x === x && t.cell_y === y));
  return belt?.items ?? -1;
}

/** The panel's URL value, the span `readPanelUrl` reads (an empty locator when absent). */
function urlRow(page: Page) {
  return page.locator('span.fab-field', { hasText: 'http://127.0.0.1:' });
}

/** The URL row is gone from the DOM, and with it the Copy button: nothing to copy. */
async function expectNoUrlRow(page: Page, why: string): Promise<void> {
  await expect(urlRow(page), `${why}: no URL row`).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByRole('button', { name: /^(Copy|Copied|Copy failed)$/ }), `${why}: no Copy button`).toHaveCount(0);
}

async function post(page: Page, url: string): Promise<number> {
  const resp = await page.request.post(url, { data: { hello: 1 } });
  return resp.status();
}

test.describe('DEMO-08: a Timer Source has no webhook door, the same Source on Webhook does', () => {
  test('POST is accepted on Webhook, refused with 404 on Timer, accepted again on Webhook', async ({ page }) => {
    const pageErrors = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await resetToDemo(page);
    await ensurePlaying(page);

    // (1) A Source from the palette, on Webhook (a fresh Source has no Configure), with
    // an offload belt from its Out so an accepted item comes to rest where it is counted.
    const [sx, sy] = freeRunOn(await readScene(page));
    await armAndPlaceAt(page, 'Source', sx, sy);
    await pollScene(page, (s) => nodeAtAnchor(s, sx, sy)?.kind ?? -1, {
      message: `the palette Source was placed at (${sx},${sy})`,
    }).toBe(0);
    const source = nodeAtAnchor(await readScene(page), sx, sy)!;
    const out = source.ports.find((p) => p.role === 1);
    expect(out, 'NON-VACUITY: the placed Source has an Out port').toBeDefined();
    const belt: [number, number][] = [
      [sx + 1, sy],
      [sx + 2, sy],
      [sx + 3, sy],
    ];
    await drawOffloadBelt(page, out!, belt);
    await pollScene(page, (s) => itemsOnBeltAt(s, sx + 1, sy), {
      message: 'the offload belt from the Source was drawn, empty',
    }).toBe(0);

    // (2) Its URL, read off the panel the user would copy it from, and agreeing with the
    // host's own answer for that node.
    await selectMachineAt(page, sx, sy);
    const url = await readPanelUrl(page);
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/hook\/src-\d+$/);
    expect(await webhookUrl(page, source.id), 'the panel shows the URL the host answers for this node').toBe(url);

    // (3) On Webhook the door is open: 2xx, and the item reaches the board.
    const onWebhook = await post(page, url);
    expect(onWebhook, 'a POST to a Webhook Source is accepted').toBeGreaterThanOrEqual(200);
    expect(onWebhook, 'a POST to a Webhook Source is accepted').toBeLessThan(300);
    await pollScene(page, (s) => itemsOnBeltAt(s, sx + 1, sy), {
      message: 'the accepted POST put one item on the Source\'s belt',
    }).toBeGreaterThanOrEqual(1);

    // (4) Timer, typed but not applied: the host still has the door open, so the row
    // stays (72-UI-SPEC 3.1: the row shows what the host folded, never the buffer).
    await pressSegment(page, 'Trigger', 'Timer');
    await expect(urlRow(page), 'Timer typed but not applied: the URL row stays').toHaveText(url);

    // (5) Timer, applied: the row leaves the DOM and the same URL is refused with 404.
    await applyConfig(page);
    await expectNoUrlRow(page, 'Timer applied');
    expect(await post(page, url), 'a POST to a Source on Timer is refused with 404').toBe(404);

    // (6) Webhook, typed but not applied: no door yet, so still no row.
    await pressSegment(page, 'Trigger', 'Webhook');
    await expectNoUrlRow(page, 'Webhook typed but not applied');

    // (7) Webhook, applied: the row is back with the same URL, and the door opens again.
    await applyConfig(page);
    await expect(urlRow(page), 'Webhook applied: the URL row is back with the same URL').toHaveText(url, {
      timeout: 10_000,
    });
    const again = await post(page, url);
    expect(again, 'back on Webhook, the POST is accepted again').toBeGreaterThanOrEqual(200);
    expect(again, 'back on Webhook, the POST is accepted again').toBeLessThan(300);

    await expectRenderLoopAlive(page, 'after the Timer and Webhook flips');
    pageErrors.assertNone('during the Timer and Webhook flips');
  });
});
