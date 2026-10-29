import { test, expect, type Page } from '@playwright/test';
import {
  buildPacket,
  CMD,
  expectExactlyOneFrame,
  mockRenderSocket,
  screenCellCentre,
  waitForChrome,
  type Harness,
  type InjectBelt,
  type InjectNode,
  type InjectWire,
  waitForBoard,
} from './support/wire';
import { PORT_STATUS } from '../src/chrome/configCopy';

// panel-disconnect.spec.ts (CONNECT-01, Phase 67-02) - the end-to-end proof that
// the config panel's Disconnect control puts a REAL, correctly-addressed
// certified command on the wire, driven through the whole production path:
//
//   injected render packet -> SceneState.{nodes,belts} -> App's ~10Hz poll ->
//   selectedNodePortFlow (the belt/wire join) -> PortFlow.link ->
//   <ConfigPanel flow> -> <PortsSection> disconnect control -> ConfigPanel's
//   onDisconnect -> encodeGridCommand -> sendInput -> the emitted frame
//
// WHY IT DECODES ALL FOUR FIELDS RATHER THAN JUST THE DISCRIMINANT. The one
// thing that can be silently wrong on this path is the KEYSPACE. A belt dock
// carries the Out ROUTING key (the nth role===1 port); `Unlink` carries the
// SPATIAL CATALOG index, because the host owns the routing-key translation at
// freeze time (D-11). On the fixture below those two numbers are DIFFERENT (dock
// key 0, catalog index 1), and confusing them TYPECHECKS - so a discriminant-only
// assertion would leave a wrong-port command green. The `port` assertion here is
// the load-bearing one.

/** A FACTORY (kind 2, 3x3) at (10,8) carrying an In, an Out and a Fault port -
 *  real catalog geometry, mirroring panel-io.spec.ts so a click on the body
 *  centre never lands on a nub. The Out is CATALOG INDEX 1 and Out ROUTING KEY 0;
 *  that mismatch is what the port assertion below is for. */
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

/** The Factory body cell (never a nub cell) - the safe click-to-select point. */
const FACTORY_BODY: [number, number] = [11, 9];

/** A belt whose TAIL docks the Factory's Out. `port: 0` is the Out ROUTING key
 *  (the 0th role===1 port), which resolves to catalog index 1. Tail = the FIRST
 *  tile, so the run starts at the cell outside the Out nub and heads east. */
const BELT_ID = 1;
const OUT_DOCKED_BELT: InjectBelt = {
  id: BELT_ID,
  tiles: [
    [13, 9],
    [14, 9],
  ],
  // Phase 91 (CHROME-13): two items behind an empty head slot, a flowing belt, so the
  // docked row reads `moving`.
  itemSlots: [6, 7],
  docks: [{ end: 'Tail', node: 7, port: 0 }],
};

const FACTORY_CONFIG = { kind: 'Factory', source: 'export default (payload) => payload;' };

// --- every docked role, and the two-control row ------------------------------
//
// A Factory whose In, Out AND Fault are all docked, plus a SECOND, UNDOCKED Out.
// One machine carrying every case at once is deliberate: the five behaviours
// below are about which rows do and do not grow a control, and a fixture per case
// could not catch a gate that keys off something other than `docked`.
//
// The two Out rows share a label ("Output - Item"), so every query below
// disambiguates them by the row's own STATUS word - which is exactly the thing
// the control is gated on, and therefore the honest discriminator.

/** In@0 W, Out@1 E (docked), Fault@2 S (docked), Out@3 E (UNDOCKED). */
const MIXED_FACTORY: InjectNode = {
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
    { index: 3, cell_x: 12, cell_y: 8, side: 1, role: 1, medium: 0 },
  ],
};

/** One belt per docked role, each through a DIFFERENT dock keyspace: the In takes
 *  a Head raw catalog index, the Out a Tail routing key, the Fault the 65535
 *  sentinel. If the control were gated on anything but `docked`, at least one of
 *  the three would go missing. */
const MIXED_BELTS: InjectBelt[] = [
  { id: 11, tiles: [[8, 9], [9, 9]], itemCount: 0, docks: [{ end: 'Head', node: 7, port: 0 }] },
  { id: 12, tiles: [[13, 9], [14, 9]], itemSlots: [6, 7], docks: [{ end: 'Tail', node: 7, port: 0 }] },
  { id: 13, tiles: [[11, 11], [11, 12]], itemCount: 0, docks: [{ end: 'Tail', node: 7, port: 65535 }] },
];

/** The `role="list"` of a group, named by its own header via aria-labelledby. */
function group(page: Page, name: 'Inputs' | 'Outputs') {
  return page.getByRole('list', { name });
}

/** One row, addressed by its full composite accessible name (`{label}, {status}`).
 *  The status half is what tells the two same-labelled Out rows apart. */
function row(page: Page, name: string) {
  return page.getByRole('listitem', { name });
}

// --- the WIRE half (decision D1) --------------------------------------------
//
// Two ENDPOINTs (kind 9, the only catalog arm with ELECTRICAL ports: In@0 facing
// W, Out@1 facing E, both medium 1) joined by one wire. A wire endpoint's `port`
// is a RAW POSITIONAL PortId - a FOURTH keyspace that `dockPort` has never heard
// of - and it is the same number `PortView.index` carries, which is why the join
// looks it up directly.

const WIRE_ID = 40;

/** The wire's SOURCE machine. Its Out@1 is `wire.from`, so it is the endpoint the
 *  core holds NO `links` entry for at all - and it must still offer the verb. */
const ENDPOINT_FROM: InjectNode = {
  id: 21,
  kind: 9,
  cell_x: 4,
  cell_y: 4,
  ports: [
    { index: 0, cell_x: 4, cell_y: 4, side: 3, role: 0, medium: 1 },
    { index: 1, cell_x: 4, cell_y: 4, side: 1, role: 1, medium: 1 },
  ],
};
const ENDPOINT_FROM_BODY: [number, number] = [4, 4];

/** The wire's TARGET machine. Its In@0 is `wire.to`. */
const ENDPOINT_TO: InjectNode = {
  id: 22,
  kind: 9,
  cell_x: 9,
  cell_y: 4,
  ports: [
    { index: 0, cell_x: 9, cell_y: 4, side: 3, role: 0, medium: 1 },
    { index: 1, cell_x: 9, cell_y: 4, side: 1, role: 1, medium: 1 },
  ],
};

const WIRE: InjectWire = {
  id: WIRE_ID,
  from: { node: ENDPOINT_FROM.id, port: 1 },
  to: { node: ENDPOINT_TO.id, port: 0 },
  path: [
    [5, 4],
    [6, 4],
    [7, 4],
    [8, 4],
  ],
};

/**
 * Boot the mocked app, inject a packet, click-select `body` and leave the panel
 * mounted. Returns the harness so a case can assert on the emitted frames.
 *
 * `machine_config` MUST be answered or the panel hangs in "Loading config..." and
 * the Ports section (gated on `!loading`) never mounts - an unanswered query
 * would mask the control's absence as a timeout pointing at the wrong layer.
 */
async function selectMachine(
  page: Page,
  packet: Buffer,
  body: [number, number],
  machineCount: number,
  config: unknown = FACTORY_CONFIG,
): Promise<Harness> {
  await page.addInitScript(() => localStorage.setItem('fab.onboarding.seen.v1', '1'));
  const h = await mockRenderSocket(page, {
    answerQuery: (verb) => (verb === 'machine_config' ? config : undefined),
  });
  await page.goto('/');
  await waitForChrome(page);
  await h.connected;

  h.inject(packet);
  await waitForBoard(page, { machines: machineCount });

  const at = await screenCellCentre(page, body[0], body[1]);
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.up();
  return h;
}

/** A postcard varintU reader over an emitted frame, mirroring
 *  `decode.ts PostcardWriter.varintU` exactly (LEB128, little-endian groups of
 *  7 bits). Written here rather than imported so this spec decodes the wire the
 *  way a HOST would read it, not the way the app wrote it. */
function readVarints(frame: Buffer, count: number): number[] {
  const out: number[] = [];
  let i = 0;
  for (let n = 0; n < count; n++) {
    let value = 0;
    let shift = 1;
    for (;;) {
      if (i >= frame.length) {
        throw new Error(`frame underran after ${n} varints: ${frame.toString('hex')}`);
      }
      const byte = frame[i++];
      value += (byte & 0x7f) * shift;
      if ((byte & 0x80) === 0) break;
      shift *= 128;
    }
    out.push(value);
  }
  return out;
}

test.describe('Config panel Disconnect (CONNECT-01)', () => {
  test('a docked Out port offers Disconnect, and one click emits exactly one correctly-addressed Unlink', async ({
    page,
  }) => {
    const h = await selectMachine(
      page,
      buildPacket({ nodes: [FACTORY], belts: [OUT_DOCKED_BELT] }),
      FACTORY_BODY,
      1,
    );

    // Heading first: a failure here points at the selection/query bridge rather
    // than at the control (the panel-io.spec.ts diagnosis discipline).
    await expect(page.getByRole('heading', { name: 'Factory' })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('region', { name: 'Ports' })).toBeVisible();

    // The row really reads as docked - otherwise the control's presence below
    // would be proving something about a row in the wrong state.
    await expect(
      page.getByRole('listitem', { name: `Output - Item, ${PORT_STATUS.moving}`, exact: true }),
    ).toHaveCount(1);

    // Composed accessible name, never a bare "Disconnect".
    const disconnect = page.getByRole('button', { name: 'Disconnect Output - Item' });
    await expect(disconnect).toBeEnabled();

    await disconnect.click();

    // Exactly one frame of discriminant 11, and no LATE duplicate.
    await expectExactlyOneFrame(page, h, CMD.Unlink);

    // ALL FOUR FIELDS, in `encodeGridCommand`'s Unlink order:
    //   disc(11), belt(u64 handle), endpoint(Head=0/Tail=1), node(u64), port
    const [disc, belt, end, node, port] = readVarints(h.sent[0], 5);
    expect(disc, 'discriminant 11 = Unlink').toBe(CMD.Unlink);
    expect(belt, "the docked belt's own render handle").toBe(BELT_ID);
    expect(end, "the dock's own BeltEnd, read verbatim: Tail = 1").toBe(1);
    expect(node, 'the selected node handle').toBe(FACTORY.id);
    expect(
      port,
      'the SPATIAL CATALOG index (1), NOT the Out routing key the dock carried (0) - ' +
        'the host owns the routing-key translation at freeze time (D-11)',
    ).toBe(1);
    // Stated as its own assertion so a future fixture change cannot quietly make
    // the two keyspaces agree and turn the case above into a tautology.
    expect(
      OUT_DOCKED_BELT.docks![0].port,
      'the fixture must keep the dock keyspace DIFFERENT from the catalog index, ' +
        'or the port assertion above proves nothing',
    ).not.toBe(port);
  });

  test('an undocked port offers no Disconnect at all - the row says "not connected" once, in words', async ({
    page,
  }) => {
    await selectMachine(page, buildPacket({ nodes: [FACTORY] }), FACTORY_BODY, 1);
    await expect(page.getByRole('heading', { name: 'Factory' })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('region', { name: 'Ports' })).toBeVisible();

    // Every row reads not connected...
    await expect(
      page.getByRole('region', { name: 'Ports' }).getByRole('listitem'),
    ).toHaveCount(3);
    await expect(
      page.getByRole('listitem', { name: /^Output - Item, not connected$/ }),
    ).toHaveCount(1);
    // ...and there is no control anywhere restating it as a dead button.
    await expect(page.getByRole('button', { name: /^Disconnect / })).toHaveCount(0);
  });

  // --- the WIRE half (decision D1) ------------------------------------------

  test('a wire-docked port offers the SAME verb, and its click DELETES the wire rather than unlinking it', async ({
    page,
  }) => {
    // The selected machine is the wire's SOURCE. That is the load-bearing choice:
    // a wire source has NO `links` entry in the core at all, so an `Unlink` here
    // is not merely invisible - there is nothing for it to remove. It would be
    // accepted, folded to a no-op, and reported as a success the user could not
    // see, which is the precise failure shape `command.rs:1451-1453` says this
    // verb exists to avoid.
    const h = await selectMachine(
      page,
      buildPacket({ nodes: [ENDPOINT_FROM, ENDPOINT_TO], wires: [WIRE] }),
      ENDPOINT_FROM_BODY,
      2,
      null,
    );
    await expect(page.getByRole('heading', { name: 'Route' })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('region', { name: 'Ports' })).toBeVisible();

    // The wire really landed and the row really reads docked - a wire contributes
    // presence and never items, so a wired port reads `idle`, not `moving`.
    await expect(page.getByRole('listitem', { name: /^Output - Wire, idle$/ })).toHaveCount(1);
    // The wire's own In@0 is untouched by this cable, so it stays undocked.
    await expect(
      page.getByRole('listitem', { name: /^Input - Wire, not connected$/ }),
    ).toHaveCount(1);

    const disconnect = page.getByRole('button', { name: 'Disconnect Output - Wire' });
    await expect(disconnect).toHaveCount(1);
    await disconnect.click();

    await expectExactlyOneFrame(page, h, CMD.Delete);

    // Delete's field order: disc(1), node(u64 handle). The handle is the WIRE's,
    // not either endpoint machine's - deleting the wire node is what makes the
    // cable go away.
    const [disc, deletedNode] = readVarints(h.sent[0], 2);
    expect(disc, 'discriminant 1 = Delete').toBe(CMD.Delete);
    expect(deletedNode, "the WIRE's own render handle").toBe(WIRE_ID);
    expect(deletedNode, 'never one of the endpoint machines').not.toBe(ENDPOINT_FROM.id);

    // The negative half, and it is not redundant with the count assertion above:
    // it names the specific wrong command this decision exists to prevent.
    expect(
      h.sent.map((f) => f[0]),
      'no Unlink may be emitted on the wire path - it is a no-op the user cannot see (D1)',
    ).not.toContain(CMD.Unlink);
  });

  test('the wire TARGET end reads docked in the panel too - both endpoints resolve, not just the source', async ({
    page,
  }) => {
    // `wire.to` DOES have a core `links` entry, so it is the end where an `Unlink`
    // would at least change something at core level - and still nothing the user
    // could see, because `WireView` is projected from the wire node's own from/to
    // fields and never from `links`. Same verb, same reason.
    //
    // This case asserts the JOIN reaches the target end. The target here is an In
    // port, and the CONTROL on In and Fault rows is added by task 3 of this plan -
    // task 1 wires the Out row alone. The click assertion lives in the
    // every-role case below, which is where that widening is proved.
    await selectMachine(
      page,
      buildPacket({ nodes: [ENDPOINT_FROM, ENDPOINT_TO], wires: [WIRE] }),
      [9, 4],
      2,
      null,
    );
    await expect(page.getByRole('heading', { name: 'Route' })).toBeVisible({ timeout: 10_000 });
    // Docked (`idle`, never a count - a wire is presence, never items), and the
    // machine's OTHER port is untouched by this cable.
    await expect(page.getByRole('listitem', { name: /^Input - Wire, idle$/ })).toHaveCount(1);
    await expect(
      page.getByRole('listitem', { name: /^Output - Wire, not connected$/ }),
    ).toHaveCount(1);
  });
});

// ---------------------------------------------------------------------------
// Every docked role, and the two-control row (67-02 task 3)
// ---------------------------------------------------------------------------

test.describe('Disconnect on every docked role (CONNECT-01)', () => {
  /** Select the mixed Factory and wait for its Ports section. */
  async function mixed(page: Page): Promise<Harness> {
    const h = await selectMachine(
      page,
      buildPacket({ nodes: [MIXED_FACTORY], belts: MIXED_BELTS }),
      FACTORY_BODY,
      1,
    );
    await expect(page.getByRole('heading', { name: 'Factory' })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('region', { name: 'Ports' })).toBeVisible();
    return h;
  }

  /** Every button inside one row, as `{ name, marginLeft }` in DOM order. The
   *  margin is read off the INLINE style attribute, which is the DOM's record of
   *  what the component set - `getComputedStyle` resolves a flex item's `auto`
   *  margin to its USED pixel value and could never report the word. */
  async function buttonsIn(locator: ReturnType<typeof row>) {
    return locator.getByRole('button').evaluateAll((els) =>
      els.map((el) => ({
        name: el.getAttribute('aria-label') ?? el.textContent ?? '',
        marginLeft: (el as HTMLElement).style.marginLeft,
        disabled: (el as HTMLButtonElement).disabled,
        left: el.getBoundingClientRect().left,
        right: el.getBoundingClientRect().right,
      })),
    );
  }

  test('a docked Input row grows a Disconnect - the Inputs group carries a control for the first time', async ({
    page,
  }) => {
    await mixed(page);
    await expect(group(page, 'Inputs').getByRole('button')).toHaveCount(1);
    const buttons = await buttonsIn(row(page, 'Input - Item, idle'));
    expect(buttons.map((b) => b.name)).toEqual(['Disconnect Input - Item']);
    expect(buttons[0].disabled).toBe(false);
  });

  test('a docked Fault row grows a Disconnect and still has no Remove - Remove stays Out-only', async ({
    page,
  }) => {
    await mixed(page);
    const buttons = await buttonsIn(row(page, 'Fault - Item, idle'));
    expect(buttons.map((b) => b.name)).toEqual(['Disconnect Fault - Item']);
    // The row-scoped assertion above is the real one; this restates it as a
    // whole-section negative so a Remove leaking onto a Fault row anywhere fails.
    await expect(page.getByRole('button', { name: /^Remove/ })).toHaveCount(2);
  });

  test('a docked, editable Out row carries BOTH controls, anchored together at the right edge', async ({
    page,
  }) => {
    await mixed(page);
    const buttons = await buttonsIn(row(page, `Output - Item, ${PORT_STATUS.moving}`));

    // Order is load-bearing (UI-SPEC 2.3): Disconnect first, Remove second.
    expect(buttons.map((b) => b.name)).toEqual(['Disconnect Output - Item', 'Remove output 1']);

    // EXACTLY ONE auto margin. Two would split the row's free space between the
    // buttons and push the pair apart instead of anchoring it as a unit.
    expect(buttons.filter((b) => b.marginLeft === 'auto')).toHaveLength(1);
    expect(buttons[0].marginLeft, 'the FIRST control in the cluster is the one that pins').toBe(
      'auto',
    );

    // The geometric consequence, measured rather than inferred from the style:
    // the two are adjacent (one row gap apart), not spread across the line.
    //
    // Measured at the DEFAULT 1280px viewport, where the panel content box is
    // 420px and the row's 364px of demand fits on one line. At the 992px
    // minimum the box is 327px and Remove WRAPS below Disconnect - see the width
    // case at the end of this file, and 67-UI-SPEC 2.3 as amended by plan 67-02.
    const gap = buttons[1].left - buttons[0].right;
    expect(gap, `the pair is one gap apart, measured ${gap}px`).toBeLessThanOrEqual(8);
    expect(gap).toBeGreaterThanOrEqual(0);

    // 73-08: BOTH controls on this row are LIVE. Until this phase Remove rendered
    // disabled here under "Disconnect it first" while Disconnect stood enabled
    // beside it - the honest arrangement while `fold_remove_port` could not survive
    // removing a docked Out. Plan 73-06 made it survivable (the fold re-points and
    // releases, and the undo re-docks), so Disconnect is a CHOICE rather than a
    // prerequisite and the cluster geometry above is unchanged either way.
    expect(buttons[0].disabled, 'Disconnect is live').toBe(false);
    expect(buttons[1].disabled, 'Remove is live too, since 73-08').toBe(false);
  });

  test('an UNDOCKED Out row on a Factory is unchanged: Remove alone, still self-pinned', async ({
    page,
  }) => {
    await mixed(page);
    const buttons = await buttonsIn(row(page, 'Output - Item, not connected'));
    expect(buttons.map((b) => b.name)).toEqual(['Remove output 2']);
    // Remove is FIRST in its own one-element cluster, so it still carries the auto
    // margin - which is what makes every pre-CONNECT-01 row byte-identical.
    expect(buttons[0].marginLeft).toBe('auto');
    expect(buttons[0].disabled).toBe(false);
  });

  test('one Disconnect per docked row and none on the undocked one, across all three roles', async ({
    page,
  }) => {
    await mixed(page);
    const names = await page
      .getByRole('button', { name: /^Disconnect / })
      .evaluateAll((els) => els.map((el) => el.getAttribute('aria-label') ?? ''));
    expect(names.sort()).toEqual([
      'Disconnect Fault - Item',
      'Disconnect Input - Item',
      'Disconnect Output - Item',
    ]);
    // The undocked Out has no Disconnect - proved by the count above being 3 on a
    // machine with FOUR ports, and by the row-scoped case above.
    await expect(page.getByRole('region', { name: 'Ports' }).getByRole('listitem')).toHaveCount(4);
  });

  test('the two-control row demands more width than the incumbent and still overflows its box no more', async ({
    page,
  }) => {
    // THE RELATIVE GUARD (the quick/260825-iae shape, recorded in
    // 66-PALETTE-HEIGHT.md). Deliberately NOT an absolute "nothing clips at
    // Npx" assertion: WINDOWS id 4 is the standing precedent for an absolute
    // bound measured against a state the user never meets - its CTA-clipping
    // test injected a CLEAN board while the dirty board overflowed by 40px, so
    // the assertion written against it passed for no honest production string.
    //
    // Both figures are measured in the SAME run, on the SAME machine, at the
    // 992px viewport minimum STATE.md and WINDOWS id 4 both name.
    await page.setViewportSize({ width: 992, height: 720 });
    await mixed(page);

    /** A row's control LINE, measured three ways.
     *
     *  `scrollWidth` is NOT the demand here and must not be used as one:
     *  `ROW_MAIN_STYLE` sets `flexWrap: 'wrap'`, so a line that cannot fit WRAPS
     *  and its scrollWidth stays pinned to the box. Measured 992px: both rows
     *  report scrollWidth 327 = clientWidth 327, which would make an overflow
     *  comparison a check that cannot fail - WINDOWS id 4 exactly.
     *
     *  So `demand` is the INTRINSIC width: the children's own widths plus the
     *  gaps between them, i.e. what the line would need on one row. And `lines`
     *  is the observable consequence - how many rows the children actually
     *  occupy, read off their distinct `top` coordinates. */
    const lineOf = (name: string) =>
      row(page, name)
        .locator('div')
        .first()
        .evaluate((el) => {
          const kids = Array.from(el.children) as HTMLElement[];
          const gap = parseFloat(getComputedStyle(el).columnGap) || 0;
          const demand =
            kids.reduce((sum, k) => sum + k.getBoundingClientRect().width, 0) +
            gap * Math.max(0, kids.length - 1);
          // Group by the vertical CENTRE, not by `top`. The line sets
          // `alignItems: center`, so a 44px button and a 12px text span on the
          // SAME line have different tops and the same centre - counting tops
          // reports every row with a control as "wrapped" and the guard would
          // then be measuring vertical centring rather than overflow.
          const centres = new Set(
            kids.map((k) => {
              const r = k.getBoundingClientRect();
              return Math.round(r.top + r.height / 2);
            }),
          );
          // CLIPPING, which is the thing that would actually be a defect: how far
          // past the line's own content box any child extends. Wrapping is NOT
          // clipping - `flexWrap` is there precisely so a line that cannot fit
          // drops a control to a second row instead of running past the panel
          // edge (ROW_MAIN_STYLE's own comment).
          const boxRight = el.getBoundingClientRect().left + el.clientWidth;
          const clip = kids.reduce(
            (worst, k) => Math.max(worst, k.getBoundingClientRect().right - boxRight),
            0,
          );
          return {
            demand: Math.round(demand),
            box: el.clientWidth,
            children: kids.length,
            lines: centres.size,
            clip: Math.round(Math.max(0, clip)),
          };
        });

    // The incumbent worst case: the widest row shape that shipped BEFORE this
    // phase - an Out with the Remove control and the longest status word.
    const incumbent = await lineOf('Output - Item, not connected');
    // The candidate: the same row shape plus a Disconnect.
    const candidate = await lineOf(`Output - Item, ${PORT_STATUS.moving}`);

    // VACUITY REFUSAL. Comparing two rows that demand the same width would prove
    // nothing about the control this phase adds, so assert first that the
    // candidate really IS the heavier shape.
    expect(
      candidate.demand,
      `candidate ${candidate.demand}px must genuinely exceed incumbent ${incumbent.demand}px, ` +
        'or this guard is comparing a row to itself',
    ).toBeGreaterThan(incumbent.demand);
    expect(candidate.box, 'both rows must be measured in the same box').toBe(incumbent.box);
    expect(candidate.children, 'the candidate really carries the extra control').toBe(
      incumbent.children + 1,
    );

    // THE GUARD: the heavier row CLIPS no worse than the incumbent. Both measure
    // 0 today, and this can genuinely fail - drop `flexWrap` from ROW_MAIN_STYLE
    // and the candidate's 364px of demand runs 37px past its 327px box while the
    // incumbent's 276px still fits, so the comparison separates them.
    expect(
      candidate.clip,
      `docked-Out row clips ${candidate.clip}px past its box vs the incumbent's ` +
        `${incumbent.clip}px (demand ${candidate.demand}px vs ${incumbent.demand}px, ` +
        `box ${candidate.box}px)`,
    ).toBeLessThanOrEqual(incumbent.clip);

    // THE MEASUREMENT, PINNED RATHER THAN ASSUMED. At the 992px minimum the
    // two-control row does NOT fit on one line: 364px of demand against a 327px
    // box, so `flexWrap` drops Remove to a second line and the pair is anchored
    // together only above ~1104px of viewport. Nothing clips and nothing is
    // unreachable, but it is not what UI-SPEC 2.3 described, so 2.3 was amended
    // with these numbers in the same commit as this test. Pinned at 2 so a future
    // change that pushes it to 3 - or one that quietly fixes it to 1 - has to
    // come back here and say so.
    expect(incumbent.lines, 'the incumbent Remove-only row fits on one line').toBe(1);
    expect(
      candidate.lines,
      'the two-control row wraps to exactly 2 lines at the 992px minimum (measured, ' +
        'not assumed - see 67-UI-SPEC 2.3 as amended by plan 67-02)',
    ).toBe(2);

    // Surface both measurements in the run log so the SUMMARY records readings
    // rather than an assertion of fit.
    console.log(
      `[67-02 row width @992px] box=${candidate.box}px | ` +
        `incumbent demand=${incumbent.demand}px lines=${incumbent.lines} clip=${incumbent.clip}px | ` +
        `candidate demand=${candidate.demand}px lines=${candidate.lines} clip=${candidate.clip}px`,
    );
  });
});

// ---------------------------------------------------------------------------
// The NOTE line (67-06 task 2, rewritten at 73-08, and again in phase 91)
// ---------------------------------------------------------------------------
//
// Phase 91 (D-12, CHROME-13, UI-SPEC 8.4): the one note a port row carries is
// `Removing this output disconnects its belt.`, on a Factory Out row whose port has a
// docked belt and on no other row. It replaced the 94-character last-output sentence,
// shown under a Factory's ONLY Out whether or not anything was docked, which wrapped
// over three lines and spoke on the row where the press cost nothing.
//
// The guard is rewritten around the new note's contract: it is ONE line at every
// checked window size (42 characters in a column UI-SPEC 8.4 measured at about 338 px
// wide at 1024), it never runs past its row box, the clean Out on the same machine
// carries no note, and a lone UNDOCKED Out carries none either. The width is graded
// in the browser, never as an estimate: `PortsSection.test.tsx` runs under node, with
// no fonts and no layout.
//
// A Factory with TWO Outs where the FIRST is clean and the SECOND is docked.
const NOTE_LATER_DOCK_FACTORY: InjectNode = {
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
    { index: 3, cell_x: 12, cell_y: 8, side: 1, role: 1, medium: 0 },
  ],
};
const NOTE_LATER_DOCK_BODY: [number, number] = [11, 9];

/** Docks the SECOND Out (routing key 1 = catalog index 3), leaving the first Out clean. */
const NOTE_LATER_DOCK_BELT: InjectBelt = {
  id: 14,
  tiles: [
    [13, 8],
    [14, 8],
  ],
  itemCount: 0,
  docks: [{ end: 'Tail', node: 7, port: 1 }],
};

/** A SECOND Factory on the same board carrying exactly ONE, undocked Out: the state that
 *  carried the standing last-output sentence until phase 91, and now carries nothing. */
const NOTE_LONE_OUT_FACTORY: InjectNode = {
  id: 8,
  kind: 2,
  cell_x: 2,
  cell_y: 2,
  w: 3,
  h: 3,
  ports: [
    { index: 0, cell_x: 2, cell_y: 3, side: 3, role: 0, medium: 0 },
    { index: 1, cell_x: 4, cell_y: 3, side: 1, role: 1, medium: 0 },
  ],
};
const NOTE_LONE_OUT_BODY: [number, number] = [3, 3];

/** The note, as a literal: this spec restates what the panel says. */
const DOCKED_OUTPUT_NOTE = 'Removing this output disconnects its belt.';

test.describe('The note line (67-06, rewritten at 73-08 and in phase 91)', () => {
  for (const size of [
    { width: 1024, height: 768 },
    { width: 1083, height: 677 },
    { width: 1280, height: 800 },
  ]) {
    test(`at ${size.width}x${size.height} the docked-output note is one line inside its row box, and only on the docked Out`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      const h = await mockRenderSocket(page, {
        answerQuery: (verb) => (verb === 'machine_config' ? FACTORY_CONFIG : undefined),
      });
      await page.addInitScript(() => localStorage.setItem('fab.onboarding.seen.v1', '1'));
      await page.goto('/');
      await waitForChrome(page);
      await h.connected;
      h.inject(
        buildPacket({
          nodes: [NOTE_LATER_DOCK_FACTORY, NOTE_LONE_OUT_FACTORY],
          belts: [NOTE_LATER_DOCK_BELT],
        }),
      );
      await waitForBoard(page, { machines: 2 });

      /** Select a machine by clicking its body cell and wait for the Ports section. Home (Fit)
       *  first: selecting the first Factory slides the board left so it clears the inspector
       *  (phase 91, plan 91-09, CHROME-07), which puts the second under the palette; Home frames
       *  the board again before its point is read. The key, not the Fit button: the first
       *  Factory's panel is at its max height and covers the bottom-right camera cluster. */
      const select = async (body: [number, number]) => {
        await page.keyboard.press('Home');
        const at = await screenCellCentre(page, body[0], body[1]);
        expect(
          await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.tagName ?? 'NONE', [at.x, at.y] as const),
          'PRECONDITION: the machine is on the open board',
        ).toBe('CANVAS');
        await page.mouse.move(at.x, at.y);
        await page.mouse.down();
        await page.mouse.up();
        await expect(page.getByRole('heading', { name: 'Factory' })).toBeVisible({ timeout: 10_000 });
        await expect(page.getByRole('region', { name: 'Ports' })).toBeVisible();
      };
      const reasons = () => page.getByRole('region', { name: 'Ports' }).locator('[id^="fab-port-remove-reason-"]');

      // READING 1: the two-Out board. The docked Out (packet index 3) carries the note,
      // the clean Out carries none.
      await select(NOTE_LATER_DOCK_BODY);
      await expect(reasons(), 'exactly one note on the two-Out Factory').toHaveCount(1);
      const note = await page.locator('#fab-port-remove-reason-3').evaluate((el) => {
        const cs = getComputedStyle(el);
        const probe = el.cloneNode(true) as HTMLElement;
        for (const prop of ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'wordSpacing'] as const) {
          probe.style[prop] = cs[prop];
        }
        probe.style.position = 'absolute';
        probe.style.left = '-99999px';
        probe.style.whiteSpace = 'pre';
        probe.style.paddingLeft = '0';
        probe.style.visibility = 'hidden';
        document.body.appendChild(probe);
        const demand = probe.getBoundingClientRect().width;
        probe.remove();
        const range = document.createRange();
        range.selectNodeContents(el);
        // Distinct line tops, not rect count: one line can be several rects.
        const tops = new Set([...range.getClientRects()].map((r) => Math.round(r.top)));
        const rowEl = el.closest('[role="listitem"]') as HTMLElement;
        const boxRight = rowEl.getBoundingClientRect().left + rowEl.clientWidth;
        return {
          text: el.textContent ?? '',
          demand: Math.round(demand),
          room: Math.round(boxRight - el.getBoundingClientRect().left - Number.parseFloat(cs.paddingLeft)),
          lines: tops.size,
          clip: Math.round(Math.max(0, el.getBoundingClientRect().right - boxRight)),
        };
      });
      console.log(
        `[91-07 note @${size.width}x${size.height}] demand=${note.demand}px room=${note.room}px lines=${note.lines} clip=${note.clip}px`,
      );
      expect(note.text).toBe(DOCKED_OUTPUT_NOTE);
      expect(note.lines, `the note is one line (${note.demand}px of text in ${note.room}px)`).toBe(1);
      expect(note.clip, 'the note runs no px past its row box').toBe(0);
      const describedBy = await page.getByRole('button', { name: 'Remove output 2' }).getAttribute('aria-describedby');
      expect(describedBy, "the docked Out's Remove is described by the note").toBe('fab-port-remove-reason-3');
      expect(
        await page.getByRole('button', { name: 'Remove output 1' }).getAttribute('aria-describedby'),
        'the clean Out says nothing',
      ).toBeNull();

      // READING 2: the lone UNDOCKED Out carries no note at all.
      await select(NOTE_LONE_OUT_BODY);
      await expect(reasons(), 'a fresh Factory with one undocked Out carries no note').toHaveCount(0);
    });
  }
});
