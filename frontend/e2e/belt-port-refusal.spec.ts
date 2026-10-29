import { test, expect, type Page } from '@playwright/test';
import {
  buildPacket,
  CMD,
  mockRenderSocket,
  nubAnchor,
  screenPoint,
  waitForChrome,
  type Harness,
  type InjectNode,
  waitForBoard,
} from './support/wire';

// belt-port-refusal.spec.ts (plan 75-07, D-12, the mock half) - the refusal band's ONE SLOT
// when the sentence comes from the client rather than the host.
//
// THE RULING (75-CONTEXT D-12, 2026-10-06, "Fix it in 75"): "With the Wire tool, pressing
// a port that only takes belts (for example a Router's) is refused immediately with a plain
// sentence saying that port takes belts, not wires. No red drag." UI-SPEC 5.3: the sentence
// reaches the band "through the same single slot, hold and live region", and "a host verdict
// arriving after it replaces it (one slot, last wins)".
//
// WHY A PLAYWRIGHT SPEC. `vitest.config.ts` runs in `node` with no DOM, so the slot, the live
// region's mutations and the wall-clock hold can only be seen in a browser (the reasoning
// `gesture-verdict.spec.ts` records in its header). The press logic itself is pinned in
// `gestures.test.ts` P1 to P9, and the real host in `e2e-live/75-belt-port-refusal.live.spec.ts`.
//
// THE SCENE. A Router-kind node at (12,9) whose two ports both take belts only: In facing W,
// Out facing E. An Endpoint-kind node at (8,9) with one ELECTRICAL Out facing E, 3 cells clear
// of the Router, used only by the third case to put a real gesture on the wire.
//
// THE CASES
//   1. A Wire press on the Router's Out shows the D-12 sentence, and no gesture frame is sent
//      by the press, the drag or the release.
//   2. Pressing it again re-arms the 4000 ms hold without a second announcement (no text
//      rewrite and no remount, V9's measure), and the box outlives the first window.
//   3. A host refusal verdict arriving after it replaces it: a DrawWire from the Endpoint's
//      electrical Out onto the Router's belt-only In is answered `MediumMismatch`, and the band
//      then reads the host's sentence.

const REFUSAL = '#fab-refusal';
const REFUSAL_BOX = '#fab-refusal .fab-panel';
/** `REFUSAL_HOLD_MS`, mirrored rather than imported, as `gesture-verdict.spec.ts` does. */
const REFUSAL_HOLD_MS = 4000;
/** `CLIENT_REFUSAL_COPY.BeltOnlyPort`, transcribed from 75-UI-SPEC section 5.2. */
const BELT_ONLY_PORT = 'That port takes belts, not wires.';
/** `REFUSAL_COPY.MediumMismatch`, transcribed. */
const MEDIUM_MISMATCH = 'Belts and wires use different ports.';

const MECHANICAL = 0;
const ELECTRICAL = 1;
const ROUTER: InjectNode = {
  id: 21,
  kind: 5,
  cell_x: 12,
  cell_y: 9,
  ports: [
    { index: 0, cell_x: 12, cell_y: 9, side: 3, role: 0, medium: MECHANICAL },
    { index: 1, cell_x: 12, cell_y: 9, side: 1, role: 1, medium: MECHANICAL },
  ],
};
const ENDPOINT: InjectNode = {
  id: 22,
  kind: 9,
  cell_x: 8,
  cell_y: 9,
  ports: [{ index: 0, cell_x: 8, cell_y: 9, side: 1, role: 1, medium: ELECTRICAL }],
};
const ROUTER_OUT_NUB = nubAnchor(12, 9, 1);
const ROUTER_IN_NUB = nubAnchor(12, 9, 3);
const ENDPOINT_OUT_NUB = nubAnchor(8, 9, 1);

/**
 * Boot the scene on Playwright's clock and leave the page's clock PAUSED (plan 84-08).
 *
 * The refusal's 4000 ms hold starts at the press, and a press here is a down, 14 pointer
 * moves and an up. On the 2026-10-09 CI run's two-CPU runner, and here on two cores at a 50%
 * CPU quota, those moves took seconds, so the hold could expire before the press had even
 * returned: the sentence was gone by the time a case looked for it, or the next press
 * announced it afresh. With the page's clock paused a press takes no page time however slow
 * the machine is, and a case moves page time only on purpose, with `fastForward`. `pauseAt`
 * only jumps forward, so it is aimed a second past the page's present to leave room for the
 * round trip; timers due in that second fire once, as they would have in real time.
 */
async function boot(page: Page): Promise<Harness> {
  await page.clock.install();
  await page.addInitScript(() => localStorage.setItem('fab.onboarding.seen.v1', '1'));
  // Every gesture the page sends is refused as the real host refuses a DrawWire onto a
  // belt-only In. Only case 3 sends one; cases 1 and 2 assert none was sent.
  const h = await mockRenderSocket(page, { answerGesture: () => 'MediumMismatch' });
  await page.goto('/');
  await waitForChrome(page);
  await h.connected;
  h.inject(buildPacket({ nodes: [ROUTER, ENDPOINT] }));
  await waitForBoard(page, { machines: 2 });
  await expect(page.locator(REFUSAL), 'the band is empty before any press').toHaveText('');
  await page.getByTitle(/^Draw wires/).click();
  const pageNow = await page.evaluate(() => Date.now());
  await page.clock.pauseAt(pageNow + 1000);
  return h;
}

/** Press the Router's belt-only Out a few px off its anchor, walk a hand's way, release. */
async function pressBeltOnlyOut(page: Page): Promise<void> {
  const a = await screenPoint(page, ROUTER_OUT_NUB);
  const start = { x: a.x + 3, y: a.y - 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  // Sub-cell steps with a diagonal stretch, away to open floor.
  await page.mouse.move(start.x + 20, start.y + 20, { steps: 6 });
  await page.mouse.move(start.x + 60, start.y + 20, { steps: 8 });
  await page.mouse.up();
}

/** Count text rewrites and node remounts inside the band from now on (V9's observer). */
async function watchMutations(page: Page): Promise<void> {
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error(`${sel} is not mounted`);
    const w = window as unknown as { __refusalMutations: { characterData: number; childList: number } };
    w.__refusalMutations = { characterData: 0, childList: 0 };
    new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'characterData') w.__refusalMutations.characterData++;
        if (r.type === 'childList') w.__refusalMutations.childList++;
      }
    }).observe(el, { characterData: true, childList: true, subtree: true });
  }, REFUSAL);
}

test.describe('D-12 mock: the belt-only press sentence shares the one refusal slot', () => {
  test('a Wire press on a belt-only port shows the sentence and sends no gesture frame', async ({ page }) => {
    const h = await boot(page);

    await pressBeltOnlyOut(page);

    await expect(page.locator(REFUSAL), 'the press put the D-12 sentence in the band').toHaveText(BELT_ONLY_PORT);
    await expect(page.locator(REFUSAL_BOX)).toBeVisible();
    // Settle past any render boundary: nothing was sent by the press, the drag or the release.
    // The page's clock is paused (see `boot`), so its frames and timers are run through the
    // same 500 ms as well, or a send deferred to a frame could never happen here.
    await page.clock.runFor(500);
    await page.waitForTimeout(500);
    expect(h.sent.length, 'no gesture frame was sent').toBe(0);
  });

  test('pressing it again re-arms the hold without a second announcement', async ({ page }) => {
    // THE HOLD IS TIMED ON THE PAGE'S CLOCK (plan 84-08, see `boot`). This test used to
    // time its 1500 ms gap and its checks with `Date.now()` in the test runner, taken after
    // each press had RETURNED. Plan 84-08's timeline at a 50% CPU quota (page time,
    // MutationObserver records): the first sentence was REMOVED by its own expired hold
    // before the second press went down, the second press then announced it afresh
    // (correctly), and its own hold expired inside the counting window: the `childList` 3
    // and 2 the 2026-10-09 CI run counted. The app was right; the test's clock was the
    // machine's. Now the gap and the checks are exact page milliseconds. A remount, a
    // rewrite or a hold that is not re-armed still fails here, by the same messages.
    const h = await boot(page);
    const pageTime = (): Promise<number> => page.evaluate(() => Date.now());

    await pressBeltOnlyOut(page);
    await expect(page.locator(REFUSAL)).toHaveText(BELT_ONLY_PORT);
    const firstShownAt = await pageTime();
    await watchMutations(page);

    // The same 1500 ms gap V9 uses, so the two hold windows are distinguishable in time.
    // `fastForward` runs each timer due in the gap once, as the page would in real time.
    await page.clock.fastForward(1500);
    await pressBeltOnlyOut(page);
    const secondPressAt = await pageTime();
    await page.clock.fastForward(300);

    const mutations = await page.evaluate(
      () =>
        (window as unknown as { __refusalMutations: { characterData: number; childList: number } })
          .__refusalMutations,
    );
    expect(mutations.characterData, 'a repeat press rewrites no text').toBe(0);
    expect(mutations.childList, 'and remounts no node, so the region never re-announces').toBe(0);

    await page.clock.fastForward(Math.max(0, firstShownAt + REFUSAL_HOLD_MS + 400 - (await pageTime())));
    const now = await pageTime();
    expect(now - firstShownAt, 'the check runs past the FIRST hold window').toBeGreaterThan(REFUSAL_HOLD_MS);
    expect(now - secondPressAt, 'and inside the SECOND one').toBeLessThan(REFUSAL_HOLD_MS);
    await expect(page.locator(REFUSAL_BOX), 'the second press re-armed the hold').toBeVisible();
    await expect(page.locator(REFUSAL)).toHaveText(BELT_ONLY_PORT);
    expect(h.sent.length, 'neither press sent a frame').toBe(0);
  });

  test('a host refusal verdict arriving afterwards replaces the client sentence', async ({ page }) => {
    const h = await boot(page);

    await pressBeltOnlyOut(page);
    await expect(page.locator(REFUSAL)).toHaveText(BELT_ONLY_PORT);
    expect(h.sent.length).toBe(0);

    // A real gesture the host can refuse: a wire from the Endpoint's electrical Out onto the
    // Router's belt-only In. The Wire tool stays armed after the refused press.
    const from = await screenPoint(page, ENDPOINT_OUT_NUB);
    const to = await screenPoint(page, ROUTER_IN_NUB);
    await page.mouse.move(from.x + 2, from.y + 2);
    await page.mouse.down();
    await page.mouse.move(to.x - 2, to.y + 3, { steps: 12 });
    await page.mouse.up();

    await expect.poll(() => h.sent.length, { message: 'one DrawWire went out' }).toBe(1);
    expect(h.sent[0][0], 'the frame is a DrawWire').toBe(CMD.DrawWire);
    // The client sentence did not advance the host's sequence bar, so this verdict, the
    // first the host has sent, is not dropped as stale: it replaces the sentence.
    await expect(page.locator(REFUSAL), "the host's verdict replaced the client sentence").toHaveText(
      MEDIUM_MISMATCH,
    );
  });
});
