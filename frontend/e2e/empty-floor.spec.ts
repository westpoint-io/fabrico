import { test, expect } from '@playwright/test';
import { buildPacket, mockRenderSocket, waitForBoard, waitForChrome, type InjectBelt, type InjectNode } from './support/wire';
import { EMPTY_FLOOR_BODY, EMPTY_FLOOR_HEADING } from '../src/chrome/configCopy';

// empty-floor.spec.ts (plan 74.1-31, third re-walk EMPTY-FLOOR) - the empty-board hint
// shows only on an EMPTY board.
//
// The walk found "EMPTY FACTORY FLOOR" in the middle of a board that held belts but no
// machine: the hint was gated on `machineCount === 0` alone, so belts did not count. The
// rule pinned here: the hint shows when the board holds no machine AND no belt; one belt
// hides it; a packet that removes the last belt brings it back.

/** The hint's heading (`EMPTY_FLOOR_HEADING`); `.fab-title` upper-cases it on screen. */
function hint(page: import('@playwright/test').Page) {
  return page.getByRole('heading', { name: EMPTY_FLOOR_HEADING, exact: true });
}

/** One animation frame as the probe saw it: is the hint on screen, and how many machines are drawn. */
interface ProbeFrame {
  hint: boolean;
  drawn: number;
}

/**
 * Start a `requestAnimationFrame` probe (phase 91, D-10, CHROME-10, research Finding Q). Every
 * frame it records what the user sees: whether the hint's heading is on screen (in the DOM and
 * visible by computed style) and how many machines the machine layer has DRAWN
 * (`__fabrico.drawnNodes()`, the Pixi display list), never the model.
 */
async function startHintProbe(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate((heading) => {
    const w = window as unknown as {
      __fabrico: { drawnNodes(): { machines: number[] } };
      __hintProbe?: { frames: { hint: boolean; drawn: number }[]; stop: boolean };
    };
    const probe = { frames: [] as { hint: boolean; drawn: number }[], stop: false };
    w.__hintProbe = probe;
    const step = (): void => {
      const h = Array.from(document.querySelectorAll('h2')).find((e) => (e.textContent ?? '').trim() === heading);
      const on = h !== undefined && h.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
      probe.frames.push({ hint: on, drawn: w.__fabrico.drawnNodes().machines.length });
      if (!probe.stop) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }, EMPTY_FLOOR_HEADING);
  // Two frames recorded before the caller acts, so the probe has seen the board as it was.
  await page.waitForFunction(
    () => ((window as unknown as { __hintProbe?: { frames: unknown[] } }).__hintProbe?.frames.length ?? 0) >= 2,
  );
}

/** Stop the probe after `settle` more frames and return every frame it recorded. */
async function stopHintProbe(page: import('@playwright/test').Page, settle = 10): Promise<ProbeFrame[]> {
  return page.evaluate(async (n) => {
    const w = window as unknown as { __hintProbe: { frames: { hint: boolean; drawn: number }[]; stop: boolean } };
    for (let i = 0; i < n; i += 1) await new Promise<void>((r) => requestAnimationFrame(() => r()));
    w.__hintProbe.stop = true;
    return w.__hintProbe.frames;
  }, settle);
}

const BELT: InjectBelt = {
  id: 7,
  tiles: [
    [5, 5],
    [6, 5],
    [7, 5],
  ],
};
const MACHINE: InjectNode = { id: 1, kind: 0, cell_x: 12, cell_y: 8 };
/** A 4 by 1 label (kind 11) with its words: a note on the board, not a machine (plan 77-04). */
const LABEL: InjectNode = {
  id: 2,
  kind: 11,
  cell_x: 4,
  cell_y: 10,
  w: 4,
  h: 1,
  label: { text: 'A note', colour: 0 },
};

test.describe('the empty-board hint shows only on an empty board', () => {
  test('a board with no machine and no belt shows the hint', async ({ page }) => {
    const h = await mockRenderSocket(page);
    await page.goto('/');
    await waitForChrome(page);
    await h.connected;
    h.inject(buildPacket({ tick: 3 }));
    // The tick is named: the start scene holds no machine before any packet lands, so a count
    // alone would pass before this packet (research Finding F).
    await waitForBoard(page, { machines: 0, tick: 3 });
    await expect(hint(page)).toBeVisible();
  });

  test('one belt and no machine hides the hint, and removing the last belt brings it back', async ({ page }) => {
    const h = await mockRenderSocket(page);
    await page.goto('/');
    await waitForChrome(page);
    await h.connected;
    h.inject(buildPacket({ tick: 3 }));
    // The empty tick-3 board drawn first (review IN-C08): the start scene is empty and shows the
    // hint already, so a visibility check straight after the inject graded the start scene.
    await waitForBoard(page, { machines: 0, tick: 3 });
    await expect(hint(page)).toBeVisible();

    h.inject(buildPacket({ tick: 4, belts: [BELT] }));
    await expect.poll(() =>
      page.evaluate(() => (window as unknown as { __fabrico: { scene(): { belts: unknown[] } } }).__fabrico.scene().belts.length),
    ).toBe(1);
    await expect(hint(page), 'a board holding a belt is not empty').toBeHidden();

    // A keyframe without the belt: the board is empty again.
    h.inject(buildPacket({ tick: 5, belts: [] }));
    await expect(hint(page), 'the hint returns when the last belt goes').toBeVisible();
  });

  test('a machine alone hides the hint (unchanged)', async ({ page }) => {
    const h = await mockRenderSocket(page);
    await page.goto('/');
    await waitForChrome(page);
    await h.connected;
    h.inject(buildPacket({ tick: 3, nodes: [MACHINE] }));
    await waitForBoard(page, { machines: 1 });
    await expect(hint(page)).toBeHidden();
  });

  // Plan 77-04: the hint reads every node, so a board holding only a note is not an empty floor.
  // The machine counts below are `waitForBoard`'s own readiness rule (labels left out, owned by
  // `wait-for-board.spec.ts`); no app surface counts machines since plan 91-03 (review IN-C04), so
  // what these cases grade is the hint.
  test('a label alone hides the hint (a note is not an empty floor)', async ({ page }) => {
    const h = await mockRenderSocket(page);
    await page.goto('/');
    await waitForChrome(page);
    await h.connected;
    h.inject(buildPacket({ tick: 3, nodes: [LABEL] }));
    await expect.poll(() =>
      page.evaluate(() => (window as unknown as { __fabrico: { scene(): { nodes: unknown[] } } }).__fabrico.scene().nodes.length),
    ).toBe(1);
    // The model's machine count, labels left out, at this packet's tick: the count alone would
    // pass on the empty start scene (measured in plan 77-04 against the old readout, which then
    // still counted the label), so `tick 3` proves the count is the one from this packet.
    await waitForBoard(page, { machines: 0, tick: 3 });
    await expect(hint(page), 'a board holding a label is not empty').toBeHidden();
  });

  test('a machine and a label hide the hint', async ({ page }) => {
    const h = await mockRenderSocket(page);
    await page.goto('/');
    await waitForChrome(page);
    await h.connected;
    h.inject(buildPacket({ tick: 3, nodes: [MACHINE, LABEL] }));
    await expect.poll(() =>
      page.evaluate(() => (window as unknown as { __fabrico: { scene(): { nodes: unknown[] } } }).__fabrico.scene().nodes.length),
    ).toBe(2);
    // The machine is counted and the label is not, at this packet's tick.
    await waitForBoard(page, { machines: 1, tick: 3 });
    await expect(hint(page)).toBeHidden();
  });
  // Phase 91 (D-10, CHROME-10, UI-SPEC 8.2): the words are the shared constants, imported, so
  // a copy edit moves the app and this check together.
  test('the empty board reads the shared heading and the click-to-place body', async ({ page }) => {
    const h = await mockRenderSocket(page);
    await page.goto('/');
    await waitForChrome(page);
    await h.connected;
    h.inject(buildPacket({ tick: 3 }));
    await waitForBoard(page, { machines: 0, tick: 3 });
    await expect(hint(page)).toBeVisible();
    await expect(hint(page)).toHaveText(EMPTY_FLOOR_HEADING);
    await expect(page.getByText(EMPTY_FLOOR_BODY, { exact: true }), 'the body says the gestures that work').toBeVisible();
  });

  // Phase 91 (D-10, CHROME-10, research Finding Q, todo 2026-10-06 "empty floor hint lingers"):
  // the hint goes on the packet that first carries a machine, so no frame shows it over a
  // machine the canvas has drawn. It used to wait for the 100 ms chrome poll.
  test('no frame shows the hint over a drawn machine when the first machine lands', async ({ page }) => {
    const h = await mockRenderSocket(page);
    await page.goto('/');
    await waitForChrome(page);
    await h.connected;
    h.inject(buildPacket({ tick: 3 }));
    await waitForBoard(page, { machines: 0, tick: 3 });
    await expect(hint(page)).toBeVisible();

    await startHintProbe(page);
    h.inject(buildPacket({ tick: 4, nodes: [MACHINE] }));
    await expect
      .poll(
        () =>
          page.evaluate(() =>
            (window as unknown as { __fabrico: { drawnNodes(): { machines: number[] } } }).__fabrico.drawnNodes().machines.length,
          ),
        { message: 'the machine layer drew the machine' },
      )
      .toBe(1);
    await expect(hint(page), 'the hint is gone once the machine is on the board').toBeHidden();
    const frames = await stopHintProbe(page);

    const overlap = frames.filter((f) => f.hint && f.drawn > 0).length;
    console.log(
      `P91-CHROME-10 mock frames=${frames.length} hint_only=${frames.filter((f) => f.hint && f.drawn === 0).length} overlap=${overlap} drawn_only=${frames.filter((f) => !f.hint && f.drawn > 0).length}`,
    );
    // NON-VACUITY: the probe saw the hint alone before the packet and the machine alone after.
    expect(frames.some((f) => f.hint && f.drawn === 0), 'PRECONDITION: the probe saw the empty board with its hint').toBe(true);
    expect(frames.some((f) => !f.hint && f.drawn > 0), 'PRECONDITION: the probe saw the drawn machine without the hint').toBe(true);
    expect(overlap, 'no animation frame shows the hint and a drawn machine together').toBe(0);
  });
});
