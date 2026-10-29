import { test, expect, type Page } from '@playwright/test';
import { buildPacket, mockRenderSocket, waitForBoard, waitForChrome, type InjectNode } from './support/wire';
import { machine_kind } from '../src/protocol/kinds';

// wait-for-board.spec.ts (phase 91 plan 91-02, CHROME-01, D-02, research Finding F) - the proof that
// `waitForBoard`, the readiness wait every mock spec now uses in place of the old bottom-right
// readout's text, cannot pass before the board it waits for.
//
// Finding F names the trap: the start scene holds no machine before any packet lands, so a model
// wait for 0 machines with no tick is true at once. The helper refuses that wait before it polls,
// matches the tick when it is given, leaves labels out of the count (a label is a note on the
// board, not a machine) and then waits for the toolbar's tick text. Each case below is a race of
// the helper against a 1 s timer where it must not resolve, and a resolution where it must.

const SOURCE: InjectNode = { id: 1, kind: machine_kind.SOURCE, cell_x: 12, cell_y: 8 };
/** A 4 by 1 label: a node on the board that is not a machine. */
const LABEL: InjectNode = {
  id: 2,
  kind: machine_kind.LABEL,
  cell_x: 4,
  cell_y: 10,
  w: 4,
  h: 1,
  label: { text: 'A note', colour: 0 },
};

/** How long a wait that must not resolve is given before the timer wins. */
const STILL_PENDING_MS = 1_000;

/** Race `wait` against a `ms` timer: `board` when the wait resolved first, `timer` when it did not. */
async function raceTimer(wait: Promise<void>, ms: number): Promise<'board' | 'timer' | 'rejected'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timer'>((resolve) => {
    timer = setTimeout(() => resolve('timer'), ms);
  });
  const settled = wait.then(
    () => 'board' as const,
    () => 'rejected' as const,
  );
  try {
    return await Promise.race([settled, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function bootMock(page: Page) {
  const h = await mockRenderSocket(page);
  await page.goto('/');
  await waitForChrome(page);
  await h.connected;
  return h;
}

test.describe('waitForBoard cannot pass before the board it waits for (CHROME-01)', () => {
  test('a wait for 0 machines with no tick is refused before any poll', async () => {
    // A stand-in page that counts every read, so "before any poll" is measured, not assumed.
    let reads = 0;
    const stub = {
      evaluate: async () => {
        reads += 1;
        throw new Error('stub page: no scene');
      },
      locator: () => {
        reads += 1;
        throw new Error('stub page: no toolbar');
      },
    } as unknown as Page;

    await expect(waitForBoard(stub, { machines: 0 })).rejects.toThrow(/must name the tick/);
    expect(reads, 'the tickless zero wait read nothing from the page').toBe(0);

    // The counter counts: a zero wait that names its tick does read the page.
    await expect(waitForBoard(stub, { machines: 0, tick: 3 }, { timeout: 300 })).rejects.toThrow();
    expect(reads, 'a zero wait with a tick polls the model').toBeGreaterThan(0);
  });

  test('a zero wait with tick 3 does not resolve before the tick-3 packet, and does after it', async ({ page }) => {
    const h = await bootMock(page);
    const before = await page.evaluate(
      () => (window as unknown as { __fabrico: { scene(): { tick: number; nodes: unknown[] } } }).__fabrico.scene(),
    );
    expect(before.nodes, 'PRECONDITION: the start scene holds no node').toHaveLength(0);
    expect(before.tick, 'PRECONDITION: no tick-3 packet has landed').not.toBe(3);

    const wait = waitForBoard(page, { machines: 0, tick: 3 }, { timeout: 10_000 });
    expect(
      await raceTimer(wait, STILL_PENDING_MS),
      'the wait for the empty tick-3 board is still pending before its packet',
    ).toBe('timer');

    h.inject(buildPacket({ tick: 3 }));
    await wait;
    await expect(page.locator('header [title="Current sim tick"]'), 'the toolbar drew tick 3').toHaveText('tick 3');
  });

  // Review WR-C01: THE TOOLBAR LEG IS GRADED ON ITS OWN. The model takes a packet in the socket
  // callback, and the chrome draws it on its next animation frame, so pausing the page's clock
  // holds the toolbar back while the model already holds the board: the wait must still be
  // pending then, and resolve once the clock runs and the toolbar draws the tick. Every case above
  // is held back by the model leg, so deleting the toolbar leg left them all green.
  test('the wait does not resolve while the toolbar has not drawn the board, and does once it has', async ({ page }) => {
    await page.clock.install();
    const h = await bootMock(page);
    await page.clock.pauseAt(Date.now() + 1_000);
    h.inject(buildPacket({ tick: 5, nodes: [SOURCE] }));
    await expect
      .poll(() =>
        page.evaluate(() => (window as unknown as { __fabrico: { scene(): { tick: number } } }).__fabrico.scene().tick),
      )
      .toBe(5);
    await expect(page.locator('header [title="Current sim tick"]'), 'PRECONDITION: the paused chrome has not drawn tick 5').not.toHaveText('tick 5');
    const wait = waitForBoard(page, { machines: 1, tick: 5 }, { timeout: 10_000 });
    expect(
      await raceTimer(wait, STILL_PENDING_MS),
      'the model holds the board, but the toolbar has not drawn it, so the wait is still pending',
    ).toBe('timer');
    await page.clock.resume();
    await wait;
    await expect(page.locator('header [title="Current sim tick"]'), 'the toolbar drew tick 5').toHaveText('tick 5');
  });

  test('a board at tick 0, or at a tick no later than the last graded board, is refused before any poll', async ({ page }) => {
    const h = await bootMock(page);
    await expect(waitForBoard(page, { machines: 1, tick: 0 })).rejects.toThrow(/tick 0 cannot be graded/);
    h.inject(buildPacket({ tick: 4, nodes: [SOURCE] }));
    await waitForBoard(page, { machines: 1, tick: 4 });
    await expect(waitForBoard(page, { machines: 1, tick: 4 }), 'the same tick again').rejects.toThrow(/not past tick 4/);
    await expect(waitForBoard(page, { machines: 1, tick: 2 }), 'an earlier tick').rejects.toThrow(/not past tick 4/);
    // A tickless wait waits for a board past the last graded one, so the board already graded
    // (one machine, tick 4) does not satisfy it.
    const again = waitForBoard(page, { machines: 1 }, { timeout: 3_000 });
    expect(await raceTimer(again, STILL_PENDING_MS), 'a tickless wait does not match the board it graded before').toBe('timer');
    h.inject(buildPacket({ tick: 6, nodes: [SOURCE] }));
    await again;
  });

  test('a board of one Source and one label holds 1 machine, not 2', async ({ page }) => {
    const h = await bootMock(page);
    h.inject(buildPacket({ tick: 2, nodes: [SOURCE, LABEL] }));
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as unknown as { __fabrico: { scene(): { nodes: unknown[] } } }).__fabrico.scene().nodes.length,
        ),
      )
      .toBe(2);

    await waitForBoard(page, { machines: 1, tick: 2 });

    const two = waitForBoard(page, { machines: 2 }, { timeout: 3_000 });
    expect(await raceTimer(two, STILL_PENDING_MS), 'the label is not counted as a machine').toBe('timer');
    await expect(two, 'the two-machine wait never matches this board').rejects.toThrow(/2 machine/);
  });
});
