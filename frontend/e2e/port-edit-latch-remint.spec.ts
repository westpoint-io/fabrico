import { test, expect, type Page } from '@playwright/test';
import {
  CMD,
  buildPacket,
  mockRenderSocket,
  screenCellCentre,
  waitForChrome,
  type Harness,
  type InjectNode,
  waitForBoard,
} from './support/wire';

// port-edit-latch-remint.spec.ts (plan 76-19, the handle-reuse audit's F2 finding).
//
// WHAT IT PROVES. A port edit (Add output, Remove) closes a latch keyed by the machine's
// render handle, and the panel holds the machine's port controls disabled until the host
// shows the edit folded. A `full` packet can hand that handle to ANOTHER machine. After an
// Undo, a Redo, a Load or a New the keyframe is a timeline restructure and records release
// evidence for the latch. A transport LAG RESYNC whose lag spanned a `RenderProducer::reset`
// also carries reminted handles. Until the 76-19 refuter round it was tagged
// `resync: true`, `isTimelineRestructure` read it as no restructure, and no evidence was
// written. Plan 76-19 dropped, on every `full` packet, a latch whose handle no longer names a
// machine with the same origin cell and kind (the second leg). The refuters showed that is
// not enough: another Factory on the same cell, or the user's own edit undone in the lag,
// reads as the same machine. The host now sends a lag that spanned a reset as a restructure
// (`resync: false`, `RenderRelay::lagged`, proved in
// `crates/fabrico-host/tests/lag_resync_across_reset.rs`). The third leg is the client half
// of that contract: the positive control's exact keyframe, same handle, cell, kind and
// ports, with only the bit false, releases the latch.
//
// The positive control is the same resync with the handles unchanged: the latch must still
// hold across it (73-12: a lag resync is not evidence the edit folded), which is also what
// shows this spec can see a held latch at all.

/** The catalog Factory on handle 1 at (10,8): In W, one Out E, Fault S. */
const FACTORY_A_ON_1: InjectNode = {
  id: 1,
  kind: 2,
  cell_x: 10,
  cell_y: 8,
  w: 3,
  h: 3,
  ports: [
    { index: 0, cell_x: 10, cell_y: 9, side: 3, role: 0, medium: 0 },
    { index: 1, cell_x: 12, cell_y: 9, side: 1, role: 1, medium: 0 },
    { index: 2, cell_x: 11, cell_y: 10, side: 2, role: 2, medium: 0 },
  ],
};

/**
 * A second catalog Factory at (20,8), on handle `id`. Its port list has the SAME shape as
 * A's, so the latch's successor check cannot read it as A's AddPort folding (a two-Out
 * Factory here would be exactly that successor and release the latch for the wrong reason).
 */
const factoryB = (id: number): InjectNode => ({
  id,
  kind: 2,
  cell_x: 20,
  cell_y: 8,
  w: 3,
  h: 3,
  ports: [
    { index: 0, cell_x: 20, cell_y: 9, side: 3, role: 0, medium: 0 },
    { index: 1, cell_x: 22, cell_y: 9, side: 1, role: 1, medium: 0 },
    { index: 2, cell_x: 21, cell_y: 10, side: 2, role: 2, medium: 0 },
  ],
});

/** Factory A moved onto handle `id`, nothing else changed. */
const factoryA = (id: number): InjectNode => ({ ...FACTORY_A_ON_1, id });

const FACTORY_CONFIG = { kind: 'Factory', source: 'export default (payload) => payload;' };

/** The `<section aria-label="Ports">` of the open panel, and its Add output control. */
const addButton = (page: Page) =>
  page.getByRole('region', { name: 'Ports' }).getByRole('button', { name: '+ Add output' });

/** The live selection, read off the read-only hook. */
async function selectedNode(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const hook = (window as unknown as { __fabrico?: { selectedNode?(): number | null } }).__fabrico;
    if (!hook?.selectedNode) throw new Error('window.__fabrico.selectedNode() not installed');
    return hook.selectedNode();
  });
}

/** Click the centre of cell (cx, cy) on the canvas: a select gesture. */
async function clickCell(page: Page, cx: number, cy: number): Promise<void> {
  const at = await screenCellCentre(page, cx, cy);
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.up();
}

/** The AddPort frames the page has sent. */
const addPorts = (h: Harness): number => h.sent.filter((f) => f[0] === CMD.AddPort).length;

/**
 * RENDER HEALTH on the mock socket: the Pixi ticker is still running. `frame()` is the
 * render clock quantized, and the clock only moves inside the ticker toward the latest sim
 * tick, so each poll injects one more idle diff tick and the frame index must take three
 * distinct values.
 */
async function expectRenderAlive(page: Page, h: Harness, fromTick: number, context: string): Promise<void> {
  const seen = new Set<number>();
  let tick = fromTick;
  await expect
    .poll(
      async () => {
        tick += 1;
        h.inject(buildPacket({ tick, full: false }));
        seen.add(
          await page.evaluate(
            () => (window as unknown as { __fabrico: { frame(): number } }).__fabrico.frame(),
          ),
        );
        return seen.size;
      },
      { message: `the Pixi render loop is still advancing ${context}`, timeout: 15_000 },
    )
    .toBeGreaterThanOrEqual(3);
}

/**
 * Boot the real App with `machine_config` answered, inject Factory A on handle 1 and
 * Factory B on handle 2, select A, press `+ Add output` once, and check the latch holds.
 */
async function bootAndLatchA(page: Page, errors: string[]): Promise<Harness> {
  page.on('pageerror', (e) => errors.push(`${e.message}\n${e.stack ?? '(no stack)'}`));
  await page.addInitScript(() => localStorage.setItem('fab.onboarding.seen.v1', '1'));
  const h = await mockRenderSocket(page, {
    answerQuery: (verb) => (verb === 'machine_config' ? FACTORY_CONFIG : undefined),
  });
  await page.goto('/');
  await waitForChrome(page);
  await h.connected;

  h.inject(buildPacket({ tick: 1, nodes: [FACTORY_A_ON_1, factoryB(2)] }));
  await waitForBoard(page, { machines: 2 });

  await clickCell(page, 11, 9);
  await expect.poll(() => selectedNode(page)).toBe(1);
  await expect(page.getByRole('heading', { name: 'Factory' })).toBeVisible({ timeout: 10_000 });
  await expect(addButton(page), 'PRECONDITION: Add output is offered on Factory A').toBeEnabled();

  await addButton(page).click();
  await expect.poll(() => addPorts(h), { message: 'PRECONDITION: one AddPort went out' }).toBe(1);
  await expect(
    addButton(page),
    'PRECONDITION: the latch holds Add output while the edit is unacknowledged',
  ).toBeDisabled();
  return h;
}

/**
 * Inject a keyframe carrying `nodes`, and wait for the deselect it causes. A lag resync by
 * default; `resync: false` is the keyframe a lag that spanned a reset arrives as.
 */
async function resyncWith(page: Page, h: Harness, nodes: InjectNode[], resync = true): Promise<void> {
  h.inject(buildPacket({ tick: 2, full: true, resync, nodes }));
  await expect.poll(() => selectedNode(page), { message: 'PRECONDITION: the keyframe deselected' }).toBeNull();
  await expect(page.getByRole('heading', { name: 'Factory' })).toHaveCount(0);
}

test.describe('a port-edit latch across a lag resync that reminted its handle (plan 76-19, F2)', () => {
  test('positive control: a resync that keeps the handles keeps the latch on the same Factory', async ({
    page,
  }) => {
    const errors: string[] = [];
    const h = await bootAndLatchA(page, errors);

    await resyncWith(page, h, [FACTORY_A_ON_1, factoryB(2)]);
    await clickCell(page, 11, 9);
    await expect.poll(() => selectedNode(page)).toBe(1);
    await expect(page.getByRole('heading', { name: 'Factory' })).toBeVisible();
    await page.waitForTimeout(300);
    await expect(
      addButton(page),
      'POSITIVE CONTROL: Factory A on handle 1 is still latched after a resync that changed no handle',
    ).toBeDisabled();
    expect(addPorts(h), 'nothing more was sent').toBe(1);
    await expectRenderAlive(page, h, 2, 'after the resync');
    expect(errors, 'no uncaught page error').toEqual([]);
  });

  test('a resync that hands the latched handle to another Factory does not latch that Factory', async ({
    page,
  }) => {
    const errors: string[] = [];
    const h = await bootAndLatchA(page, errors);

    // The lag spanned a reset: handle 1 now names Factory B at (20,8), A moved to handle 2.
    await resyncWith(page, h, [factoryB(1), factoryA(2)]);
    await clickCell(page, 21, 9);
    await expect.poll(() => selectedNode(page), {
      message: 'PRECONDITION: clicking Factory B selects handle 1',
    }).toBe(1);
    await expect(page.getByRole('heading', { name: 'Factory' })).toBeVisible();
    expect(
      await page.evaluate(() => {
        const hook = (window as unknown as {
          __fabrico: { scene(): { nodes: { id: number; kind: number; cells: [number, number][] }[] } };
        }).__fabrico;
        const n = hook.scene().nodes.find((x) => x.id === 1);
        return n ? { kind: n.kind, origin: n.cells[0] } : null;
      }),
      'PRECONDITION: handle 1 now names Factory B, whose body starts at (20,8)',
    ).toEqual({ kind: 2, origin: [20, 8] });
    await page.waitForTimeout(300);
    await expect(
      addButton(page),
      'LATCH: Factory B, now on the handle Factory A was latched on, offers Add output',
    ).toBeEnabled();
    expect(addPorts(h), 'nothing more was sent').toBe(1);
    await expectRenderAlive(page, h, 2, 'after the resync');
    expect(errors, 'no uncaught page error').toEqual([]);
  });

  test('a lag across a reset arrives as a restructure, and the same handle, cell, kind and ports release the latch', async ({
    page,
  }) => {
    const errors: string[] = [];
    const h = await bootAndLatchA(page, errors);

    // The positive control's exact nodes. Only the bit differs: the host sends a lag that
    // spanned an undo, a New or a Load with `resync: false`. The machine on handle 1 may be
    // A with its edit undone, or another Factory placed on A's cell; the bytes cannot say.
    await resyncWith(page, h, [FACTORY_A_ON_1, factoryB(2)], false);
    await clickCell(page, 11, 9);
    await expect.poll(() => selectedNode(page)).toBe(1);
    await expect(page.getByRole('heading', { name: 'Factory' })).toBeVisible();
    await page.waitForTimeout(300);
    await expect(
      addButton(page),
      'RESTRUCTURE: the Factory on handle 1 offers Add output after a keyframe the host sent as a restructure',
    ).toBeEnabled();
    await expect(
      page.getByText('Waiting for the host to apply this change.'),
      'RESTRUCTURE: the panel does not say the change is waiting',
    ).toHaveCount(0);
    expect(addPorts(h), 'nothing more was sent').toBe(1);
    await expectRenderAlive(page, h, 2, 'after the restructure');
    expect(errors, 'no uncaught page error').toEqual([]);
  });
});
