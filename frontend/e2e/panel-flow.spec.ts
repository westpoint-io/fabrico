import { test, expect, type Locator, type Page } from '@playwright/test';
import {
  buildPacket,
  mockRenderSocket,
  screenCellCentre,
  waitForChrome,
  type InjectBelt,
  type InjectNode,
  waitForBoard,
} from './support/wire';
import { PORT_STATUS } from '../src/chrome/configCopy';

// panel-flow.spec.ts (PANEL-04, Phase 51-02) - the end-to-end proof that each I/O
// row reads what is ACTUALLY flowing at that port, through the real path:
//
//   injected packet (nodes + belts with items + docks) -> SceneState ->
//   App's ~10Hz poll -> selectedNodePortFlow -> `flow` prop -> PortsSection row
//
// Every assertion here is on the LIVE correlation: the port list carries no flow
// data of its own and `machine_config` carries none either - only the belts do.
//
// The colour assertions resolve the `--fab-*` token to its computed rgb() at
// runtime (`tokenColor`) rather than hard-coding a hex, so the spec stays true
// under a skin swap and can never accidentally bless a hand-authored literal.
//
// PHASE 91 (D-12, CHROME-13, UI-SPEC 8.5 as amended in plan 91-07): a row reads one
// of four words, never an item count. The words are graded with the belt's item list
// in the packet: items at slots behind an empty head slot (`moving`), items packed
// from the head slot with the head on open floor (`backed up`), no items (`idle`).
// On the wire `arrival_tick` IS the slot index, slot 0 the head.

/** A FACTORY (kind 2, 3x3) at (10,8): In (10,9) W, Out (12,9) E, Fault (11,10) S.
 *  The same fixture geometry as panel-io.spec.ts / port-gestures.spec.ts. */
const FACTORY: InjectNode = {
  id: 7,
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
const FACTORY_BODY: [number, number] = [11, 9];
const FACTORY_CONFIG = { kind: 'Factory', source: 'export default (payload) => payload;' };

/** Slots on every belt here (`InjectBelt.latency`'s default). */
const SLOTS = 8;

/**
 * A belt leaving the Factory's Out nub: Tail at (13,9) - the cell just outside
 * the E-facing Out port - running east. The Tail dock uses the OUT ROUTING key
 * (the nth role===1 port), which for this Factory's single Out is 0.
 *
 * Its `itemCount` items sit at the TAIL end (the highest slots) behind an empty
 * head slot: a belt that is flowing, which reads `moving`.
 */
const outBelt = (itemCount: number): InjectBelt => ({
  id: 100,
  tiles: [
    [13, 9],
    [14, 9],
  ],
  itemSlots: Array.from({ length: itemCount }, (_, i) => SLOTS - itemCount + i),
  docks: [{ end: 'Tail', node: FACTORY.id, port: 0 }],
});

/** The same belt packed from its HEAD slot, its head on open floor: nothing on it can
 *  leave, so it reads `backed up` (the jam the old count word read as `n moving`). */
const jammedOutBelt = (itemCount: number): InjectBelt => ({
  ...outBelt(0),
  itemSlots: Array.from({ length: itemCount }, (_, i) => i),
});

/** A belt draining the Factory's FAULT nub - addressed by the 65535 sentinel. */
const faultBelt = (itemCount: number): InjectBelt => ({
  id: 101,
  tiles: [
    [11, 11],
    [11, 12],
  ],
  itemSlots: Array.from({ length: itemCount }, (_, i) => SLOTS - itemCount + i),
  docks: [{ end: 'Tail', node: FACTORY.id, port: 65535 }],
});

/**
 * Boot the mocked app with a Factory (plus optional belts), select it and wait
 * for the panel heading.
 */
async function selectFactory(page: Page, belts: InjectBelt[] = []) {
  await page.addInitScript(() => localStorage.setItem('fab.onboarding.seen.v1', '1'));
  const h = await mockRenderSocket(page, {
    answerQuery: (verb) => (verb === 'machine_config' ? FACTORY_CONFIG : undefined),
  });
  await page.goto('/');
  await waitForChrome(page);
  await h.connected;

  h.inject(buildPacket({ nodes: [FACTORY], belts }));
  await waitForBoard(page, { machines: 1 });

  const at = await screenCellCentre(page, FACTORY_BODY[0], FACTORY_BODY[1]);
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.up();
  await expect(page.getByRole('heading', { name: 'Factory' })).toBeVisible({ timeout: 10_000 });
  return h;
}

/** The `<section aria-label="Ports">` mounted below the per-kind body. */
function portsSection(page: Page) {
  return page.getByRole('region', { name: 'Ports' });
}

/** One port row, located by the STABLE label prefix of its composite accessible
 *  name ("Output - Item, moving") - getByRole name matching is substring by
 *  default, so the locator survives every flow state. */
function row(page: Page, label: string): Locator {
  return portsSection(page).getByRole('listitem', { name: label });
}

/** The row's indicator wrapper - the element carrying the three-step tint that
 *  the SVG glyph inherits via `currentColor`. It is `aria-hidden` in production
 *  (the glyph is decorative), so this locator needs no test-only attribute. */
function indicator(r: Locator): Locator {
  return r.locator('span[aria-hidden="true"]');
}

/** The computed `color` of an element, as an `rgb(...)` string. */
async function colorOf(l: Locator): Promise<string> {
  return l.evaluate((el) => getComputedStyle(el).color);
}

/** Resolve a `--fab-*` token to the SAME computed rgb() the browser gives an
 *  element using it - so the assertion compares like with like and never pins a
 *  hex literal (skin-swap safe). */
async function tokenColor(page: Page, token: string): Promise<string> {
  return page.evaluate((t) => {
    const probe = document.createElement('span');
    probe.style.color = `var(${t})`;
    document.body.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
  }, token);
}

test.describe('Config panel live per-port flow (PANEL-04)', () => {
  test('a docked Out belt carrying items behind an empty head slot reads "moving" in the item accent, with no count', async ({
    page,
  }) => {
    await selectFactory(page, [outBelt(3)]);

    const out = row(page, 'Output - Item');
    // The word is the load-bearing cue - text first, colour second.
    await expect(out).toContainText(PORT_STATUS.moving);
    // ...and it is the row's ACCESSIBLE NAME too, so a screen reader hears the
    // flow without ever reaching the (aria-hidden) glyph.
    await expect(out).toHaveAttribute('aria-label', `Output - Item, ${PORT_STATUS.moving}`);
    // No count anywhere in the row: three items are on the belt, and no digit is shown.
    expect(await out.innerText()).not.toMatch(/\d/);

    expect(await colorOf(indicator(out))).toBe(await tokenColor(page, '--fab-accent-item'));
    // The word itself is ink (UI-SPEC 8.5); only the glyph carries the accent.
    expect(await colorOf(out.getByText(PORT_STATUS.moving, { exact: true }))).toBe(await tokenColor(page, '--fab-ink'));
  });

  test('a belt packed from its head slot with its head on open floor reads "backed up", never moving', async ({
    page,
  }) => {
    await selectFactory(page, [jammedOutBelt(6)]);

    const out = row(page, 'Output - Item');
    await expect(out).toHaveAttribute('aria-label', `Output - Item, ${PORT_STATUS.backedUp}`);
    // The word, not a substring: the row's note under a Factory's Out says "Removing".
    await expect(out.getByText(PORT_STATUS.moving, { exact: true })).toHaveCount(0);
    expect(await colorOf(indicator(out))).toBe(await tokenColor(page, '--fab-accent-item'));
    expect(await colorOf(out.getByText(PORT_STATUS.backedUp, { exact: true }))).toBe(await tokenColor(page, '--fab-ink'));
  });

  test('an undocked port reads "not connected": the glyph recedes to the outline token, the word stays ink', async ({
    page,
  }) => {
    await selectFactory(page, [outBelt(3)]);

    // Only the Out port has a belt: the In and Fault ports are unconnected.
    const input = row(page, 'Input - Item');
    await expect(input).toContainText(PORT_STATUS.notConnected);
    expect(await colorOf(indicator(input))).toBe(await tokenColor(page, '--fab-outline'));
    expect(await colorOf(input.getByText(PORT_STATUS.notConnected, { exact: true }))).toBe(
      await tokenColor(page, '--fab-ink'),
    );
  });

  test('a docked belt with ZERO items reads "idle" in ink - a different state from unconnected', async ({
    page,
  }) => {
    await selectFactory(page, [outBelt(0)]);

    const out = row(page, 'Output - Item');
    await expect(out).toContainText(PORT_STATUS.idle);
    await expect(out).not.toContainText(PORT_STATUS.notConnected);
    expect(await colorOf(indicator(out))).toBe(await tokenColor(page, '--fab-ink'));
  });

  test('an idle Fault exit is never the destructive colour (RENDER-04)', async ({ page }) => {
    // Both flavours of idle fault: docked-but-empty AND unconnected. Neither may
    // read as a live alarm - `--fab-destructive` belongs to the error row alone.
    await selectFactory(page, [faultBelt(0)]);

    const destructive = await tokenColor(page, '--fab-destructive');
    const fault = row(page, 'Fault - Item');
    await expect(fault).toContainText(PORT_STATUS.idle);
    expect(await colorOf(indicator(fault))).toBe(await tokenColor(page, '--fab-ink'));
    expect(await colorOf(indicator(fault))).not.toBe(destructive);

    // ...and the SAME row with no belt at all.
    await page.reload();
    await selectFactory(page);
    const bare = row(page, 'Fault - Item');
    await expect(bare).toContainText(PORT_STATUS.notConnected);
    expect(await colorOf(indicator(bare))).not.toBe(destructive);
  });

  test('a later packet that changes ONLY the items updates the status word: moving, backed up, idle', async ({
    page,
  }) => {
    const h = await selectFactory(page, [outBelt(1)]);
    const out = row(page, 'Output - Item');
    await expect(out).toHaveAttribute('aria-label', `Output - Item, ${PORT_STATUS.moving}`);

    // Same belt, same docks - only the items move, and they arrive as a live DIFF
    // packet (`full: false`), which is what a running sim emits. A `full` keyframe
    // would clear the selection by design (WR-01: a keyframe remints render
    // handles), unmounting the panel and proving nothing. The belt packs to its
    // head slot with nowhere to deliver: the word turns `backed up` while the
    // belt still carries items, which the old count word could not say.
    h.inject(buildPacket({ tick: 2, full: false, belts: [jammedOutBelt(5)] }));
    await expect(out).toHaveAttribute('aria-label', `Output - Item, ${PORT_STATUS.backedUp}`);
    expect(await colorOf(indicator(out))).toBe(await tokenColor(page, '--fab-accent-item'));

    // Draining back to empty returns the row to the idle step, not to
    // "not connected" - the belt is still attached.
    h.inject(buildPacket({ tick: 3, full: false, belts: [outBelt(0)] }));
    await expect(out).toHaveAttribute('aria-label', `Output - Item, ${PORT_STATUS.idle}`);

    // The port TOPOLOGY never changed across all three packets: the list is
    // still the same three rows in the same order (no full-section churn).
    await expect(portsSection(page).getByRole('listitem')).toHaveCount(3);
  });

  test('an unresolvable dock value degrades to "not connected" instead of throwing', async ({
    page,
  }) => {
    // A forged/stale packet: an Out routing key of 9 on a Factory with ONE Out
    // port. `dockPort` returns null, portFlow credits nothing, and the row must
    // simply read unconnected (T-51-03 / the UI-SPEC `partial` backstop).
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await selectFactory(page, [
      {
        id: 102,
        tiles: [
          [13, 9],
          [14, 9],
        ],
        itemCount: 4,
        docks: [{ end: 'Tail', node: FACTORY.id, port: 9 }],
      },
    ]);

    const out = row(page, 'Output - Item');
    await expect(out).toContainText(PORT_STATUS.notConnected);
    expect(await colorOf(indicator(out))).toBe(await tokenColor(page, '--fab-outline'));
    expect(errors, 'a hostile dock value must never throw into the renderer').toEqual([]);
  });

  test('the remove control holds its COLUMN as the flow status changes underneath it', async ({
    page,
  }) => {
    // 51-UI-REVIEW fix 1. The remove button was the control line's last child
    // with no `justify-content`, so its x was `indicator + label + status` - and
    // the status is the one span in the row whose width MOVES. It re-derives at
    // ~10Hz and swaps between `idle` (4 chars), `moving` (6), `backed up` (9) and
    // `not connected` (13), so a DESTRUCTIVE control would slide ~70px between
    // states. (Until phase 91 the count word also twitched by a character every
    // time a running belt crossed ten items.)
    //
    // The whole state space is driven here on ONE page through live diff packets
    // - the same path the poll really takes - and the button must not move by a
    // single pixel across any of it.
    const h = await selectFactory(page, [outBelt(3)]);
    const out = row(page, 'Output - Item');
    const btn = portsSection(page).getByRole('button', { name: 'Remove output 1' });

    /** The button's x once the row is showing `status`. */
    const xAt = async (status: string): Promise<number> => {
      await expect(out).toHaveAttribute('aria-label', `Output - Item, ${status}`);
      return (await btn.boundingBox())!.x;
    };

    const atMoving = await xAt(PORT_STATUS.moving);
    h.inject(buildPacket({ tick: 2, full: false, belts: [jammedOutBelt(8)] }));
    const atBacked = await xAt(PORT_STATUS.backedUp);
    // The slide: the belt drains, then detaches entirely (same belt id, no docks) -
    // `idle` and `not connected` are the extremes of the range.
    h.inject(buildPacket({ tick: 3, full: false, belts: [outBelt(0)] }));
    const atIdle = await xAt(PORT_STATUS.idle);
    h.inject(
      buildPacket({
        tick: 4,
        full: false,
        belts: [{ ...outBelt(0), docks: [] }],
      }),
    );
    const atUnconnected = await xAt(PORT_STATUS.notConnected);

    expect(
      [atBacked, atIdle, atUnconnected],
      'the destructive control never moves as the status re-derives',
    ).toEqual([atMoving, atMoving, atMoving]);

    // ...and it is pinned to the row's RIGHT edge, which is what makes that
    // column independent of every string to its left.
    const rowBox = (await out.boundingBox())!;
    const btnBox = (await btn.boundingBox())!;
    expect(btnBox.x + btnBox.width).toBeCloseTo(rowBox.x + rowBox.width, 0);
  });

  test('each role keeps its own silhouette, and the glyph is hidden from the a11y tree', async ({
    page,
  }) => {
    await selectFactory(page, [outBelt(2)]);

    // Colour is never the sole cue: the In circle, the Out circle+stem and the
    // Fault circle+ring differ in SHAPE (child element count), and the glyph
    // itself is aria-hidden so the row text carries the whole meaning.
    const shapeCount = async (label: string) =>
      indicator(row(page, label)).locator('svg > *').count();
    expect(await shapeCount('Input - Item')).toBe(1);
    expect(await shapeCount('Output - Item')).toBe(2);
    expect(await shapeCount('Fault - Item')).toBe(2);

    // ...and the Fault shape is a real ANNULUS, not a stroke restraddling its own
    // fill (51-UI-REVIEW fix 3). A child COUNT cannot tell those apart, which is
    // how In and Fault shipped as the same disc: the ring must be hollow and its
    // radius must clear both the fault core and the In disc.
    const radii = async (label: string) =>
      indicator(row(page, label))
        .locator('svg > circle')
        .evaluateAll((els) =>
          els.map((el) => ({
            r: Number(el.getAttribute('r')),
            fill: el.getAttribute('fill'),
          })),
        );
    const [inDisc] = await radii('Input - Item');
    const [core, ring] = await radii('Fault - Item');
    expect(ring.fill, 'the fault ring is hollow').toBe('none');
    expect(core.r, 'the fault core is smaller than the In disc').toBeLessThan(inDisc.r);
    expect(ring.r, 'the fault ring is drawn outside both').toBeGreaterThan(inDisc.r);

    // The rendered result, measured rather than inferred: the fault glyph's ink
    // reaches visibly further out than the In glyph's at the shipped 12px box.
    const inkWidth = async (label: string) =>
      indicator(row(page, label))
        .locator('svg')
        .evaluate((svg) => (svg as SVGGraphicsElement).getBBox().width);
    expect(await inkWidth('Fault - Item')).toBeGreaterThan((await inkWidth('Input - Item')) + 1);

    await expect(indicator(row(page, 'Output - Item')).locator('svg')).toHaveAttribute(
      'aria-hidden',
      'true',
    );
    // The status text is NOT a live region (51-UI-SPEC A4): a 10Hz-updating
    // aria-live would turn a flowing belt into a screen-reader machine gun.
    await expect(portsSection(page).locator('[aria-live]')).toHaveCount(0);
  });
});
