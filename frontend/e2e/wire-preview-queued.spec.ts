import { test, expect, type Page } from '@playwright/test';
import {
  CELL,
  CMD,
  buildPacket,
  mockRenderSocket,
  nubAnchor,
  screenCellCentre,
  screenPoint,
  waitForBoard,
  waitForChrome,
  type Harness,
  type InjectNode,
} from './support/wire';

// wire-preview-queued.spec.ts (review fix pass 1, WR-A-04, threat T-92-11) - the drag preview
// on a PAUSED board routes round the board the landed cable will see.
//
// A gesture made on a paused board waits in the host queue until Play, and the host routes
// every landed cable around the board the queue folds into. Until this fix the wire preview
// read only the folded scene, so a Place queued between two machines was drawn through by the
// preview and gone round by the cable on Play (UI-SPEC 4.1 rule 5: "the drag preview shows the
// path the cable lands on"). The unit layer (`gestures.test.ts` WR-A-04) pins the Place, the
// Delete and the Rotate; this is the browser half for the Place: a real palette arm, a real
// click on the canvas, a real Place frame on the wire, and the corridor read off the overlay's
// own plot (`wirePreviewPolylines`), never off the gesture's arguments.
//
// THE SCENE. A Route (kind 9) at (8,9), its electrical Out facing E; an HTTP Handler (kind 10,
// 3x3) anchored at (18,8), its electrical In at (18,9) facing W. Nothing between them, so the
// ladder runs row 9 straight. The queued Place is a Factory anchored at (12,8): its box
// (12..14, 8..10) holds row 9.
//
// The mock host answers no gesture, so the Place stays queued, as it does on a paused host.

const ELECTRICAL = 1;
const MECHANICAL = 0;
const ROUTE: InjectNode = {
  id: 31,
  kind: 9,
  cell_x: 8,
  cell_y: 9,
  ports: [
    { index: 0, cell_x: 8, cell_y: 9, side: 3, role: 0, medium: ELECTRICAL },
    { index: 1, cell_x: 8, cell_y: 9, side: 1, role: 1, medium: ELECTRICAL },
  ],
};
const HANDLER: InjectNode = {
  id: 32,
  kind: 10,
  cell_x: 18,
  cell_y: 8,
  w: 3,
  h: 3,
  ports: [
    { index: 0, cell_x: 18, cell_y: 9, side: 3, role: 0, medium: ELECTRICAL },
    { index: 1, cell_x: 20, cell_y: 9, side: 1, role: 1, medium: ELECTRICAL },
    { index: 2, cell_x: 19, cell_y: 10, side: 2, role: 2, medium: MECHANICAL },
  ],
};
/** The queued Factory's box, in cells: (12..14, 8..10). */
const QUEUED = { x0: 12, y0: 8, x1: 14, y1: 10 };

async function boot(page: Page): Promise<Harness> {
  await page.addInitScript(() => localStorage.setItem('fab.onboarding.seen.v1', '1'));
  const h = await mockRenderSocket(page);
  await page.goto('/');
  await waitForChrome(page);
  await h.connected;
  h.inject(buildPacket({ tick: 3, nodes: [ROUTE, HANDLER] }));
  await waitForBoard(page, { machines: 2, tick: 3 });
  // The sim boots Playing, so the toolbar shows Pause.
  await page.getByRole('button', { name: 'Pause' }).click();
  await expect(page.getByRole('button', { name: 'Play' })).toBeVisible();
  return h;
}

/** Arm the Factory and click its anchor cell: one Place goes out and waits for Play. */
async function queueFactoryPlace(page: Page, h: Harness): Promise<void> {
  const item = page.getByRole('button', { name: 'Place Factory', exact: true });
  await item.click();
  await expect(item).toHaveAttribute('aria-pressed', 'true');
  const drop = await screenCellCentre(page, QUEUED.x0, QUEUED.y0);
  await page.mouse.move(drop.x, drop.y);
  await page.mouse.down();
  await page.mouse.up();
  await expect.poll(() => h.sent.length, { message: 'one Place went out' }).toBe(1);
  expect(h.sent[0][0], 'the frame is a Place').toBe(CMD.Place);
  await page.keyboard.press('Escape');
}

/** Arm the Wire tool, press the Route's Out and hold over the Handler's In: the corridors. */
async function heldCorridors(page: Page): Promise<Array<Array<{ x: number; y: number }>>> {
  await page.getByTitle(/^Draw wires/).click();
  const from = await screenPoint(page, nubAnchor(8, 9, 1));
  const to = await screenPoint(page, nubAnchor(18, 9, 3));
  await page.mouse.move(from.x + 2, from.y + 1);
  await page.mouse.down();
  await page.mouse.move(to.x - 3, to.y + 1, { steps: 14 });
  const read = (): Promise<Array<Array<{ x: number; y: number }>>> =>
    page.evaluate(() =>
      (
        window as unknown as { __fabrico: { wirePreviewPolylines(): Array<Array<{ x: number; y: number }>> } }
      ).__fabrico.wirePreviewPolylines(),
    );
  await expect.poll(async () => (await read()).length, { message: 'a corridor is on screen' }).toBeGreaterThan(0);
  return read();
}

/** Whether any straight run of a corridor passes through the queued box's cells (world px). */
function entersQueuedBox(runs: Array<Array<{ x: number; y: number }>>): boolean {
  const [bx0, by0, bx1, by1] = [QUEUED.x0 * CELL, QUEUED.y0 * CELL, (QUEUED.x1 + 1) * CELL, (QUEUED.y1 + 1) * CELL];
  for (const run of runs) {
    for (let i = 1; i < run.length; i++) {
      const [a, b] = [run[i - 1], run[i]];
      const [x0, x1] = [Math.min(a.x, b.x), Math.max(a.x, b.x)];
      const [y0, y1] = [Math.min(a.y, b.y), Math.max(a.y, b.y)];
      if (x1 > bx0 && x0 < bx1 && y1 > by0 && y0 < by1) {
        return true;
      }
    }
  }
  return false;
}

test.describe('WR-A-04 mock: the paused-board wire preview routes round a queued Place', () => {
  test('NON-VACUITY: with nothing queued the corridor runs straight through where the Factory will go', async ({
    page,
  }) => {
    await boot(page);
    const runs = await heldCorridors(page);
    expect(entersQueuedBox(runs), `the corridor crosses (12..14, 8..10); plotted ${JSON.stringify(runs)}`).toBe(true);
  });

  test('a Place queued between the ends is in the corridor\'s way, as it will be in the landed cable\'s', async ({
    page,
  }) => {
    const h = await boot(page);
    await queueFactoryPlace(page, h);
    const runs = await heldCorridors(page);
    expect(entersQueuedBox(runs), `no corridor enters the queued Factory; plotted ${JSON.stringify(runs)}`).toBe(false);
    expect(h.sent.length, 'holding the drag sent nothing more').toBe(1);
  });
});
