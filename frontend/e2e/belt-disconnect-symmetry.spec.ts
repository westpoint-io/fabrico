import { test, expect, type Page } from '@playwright/test';
import {
  CMD,
  buildPacket,
  expectExactlyOneFrame,
  mockRenderSocket,
  screenCellCentre,
  waitForChrome,
  type Harness,
  type InjectBelt,
} from './support/wire';

// belt-disconnect-symmetry.spec.ts (74-07, LINK-09) - browser-level proof that a
// user can UNMAKE the belt-to-belt link they just made, from EITHER side, and that
// the two presses emit ONE identical command.
//
// WHY THIS SPEC EXISTS AT ALL. LINK-06 ships the refusal sentence
// `That output is already connected. Disconnect it first.`, which names a control.
// Until this plan the belt panel rendered no ports section, so on a belt that
// sentence pointed at a button that existed nowhere: the locator resolved to
// nothing and the manual walk failed at the press. The unit cases in
// `ConfigPanel.test.tsx` pin the ENCODE; only a browser case proves the PRESS
// reaches it through the production panel.
//
// WHAT WOULD MAKE THIS A CHECK THAT CANNOT FAIL, and how each is closed:
//
//   1. Asserting that the section RENDERED is not asserting that Disconnect WORKS.
//      Phase 73 shipped `alertRingsPainted` as a call latch on a non-null field and
//      a build whose ring drew nothing passed the whole user-visible claim. So both
//      cases here press the button and decode the emitted FRAME.
//   2. Asserting only the discriminant would leave a wrong-node or wrong-end unlink
//      green - which is exactly T-74-33, destroying a link the user did not point
//      at. All four fields are decoded and asserted.
//   3. Asserting the two sides "both emitted an Unlink" would stay green on a build
//      where they named different links. The two frames are compared BYTE FOR BYTE.
//   4. The `machine_config` query is answered, because the ports section is gated
//      on `!loading`: an unanswered query would leave the panel on
//      `Loading config...` and every absence below would be true for the wrong
//      reason.
//
// WHAT IT CANNOT PROVE. Anything about the host. The packet and the config reply
// are hand copies with no link to the Rust producer, so a `belt_docks` regression
// cannot reach this file. `crates/fabrico-command/tests/dock_occupancy.rs` and the
// `crates/fabrico-host` render-packet cases hold that side.

// ---------------------------------------------------------------------------
// Fixture. Two ABUTTING belts on row 9, both running EAST, ALREADY JOINED.
//
//   UP   (id 3): (10,9) -> (13,9). Head at (13,9), outward E.
//   DOWN (id 4): (14,9) -> (17,9). Tail at (14,9), outward W.
//
// ONE link, `(3,0) -> (4,0)`, and the packet carries it TWICE because that is what
// `belt_docks` emits: the upstream's own Head dock naming the downstream, and the
// downstream's Tail dock naming the upstream. The two rows the panel builds off
// those two records are the two sides this spec presses.
//
// A Head dock's `port` is a RAW CATALOG INDEX in the target's keyspace, and a
// belt's admit port is catalog 0 (`Role::In` declared FIRST, 74-02) - so `UP`'s
// Head dock carries port 0, naming `DOWN`'s Tail port.
// ---------------------------------------------------------------------------

const UP_ID = 3;
const DOWN_ID = 4;

const UP: InjectBelt = {
  id: UP_ID,
  tiles: [
    [10, 9],
    [11, 9],
    [12, 9],
    [13, 9],
  ],
  docks: [{ end: 'Head', node: DOWN_ID, port: 0 }],
};
const DOWN: InjectBelt = {
  id: DOWN_ID,
  tiles: [
    [14, 9],
    [15, 9],
    [16, 9],
    [17, 9],
  ],
  docks: [{ end: 'Tail', node: UP_ID, port: 0 }],
};

/** A tile of each belt, away from the seam, as the click-to-select point. */
const UP_TILE: [number, number] = [11, 9];
const DOWN_TILE: [number, number] = [16, 9];

/** The `ConfigView::Belt` reply the host answers `machine_config(beltId)` with. */
const BELT_CONFIG = { kind: 'Belt', ticks_per_slot: 4 };

/** `BeltEnd::Head` on the wire (postcard: Head=0, Tail=1). */
const END_HEAD = 0;

/** LEB128 reader, the inverse of `PostcardWriter.varintU`. Written here rather than
 *  imported for the reason `belt-pace.spec.ts` states at its own copy:
 *  `frontend/tsconfig.json`'s `include` omits `e2e/`, so a helper shared across
 *  specs is typechecked by nothing. It also decodes the wire the way a HOST would
 *  read it, not the way the app wrote it. */
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

/** One click on a grid cell centre. */
async function clickCell(page: Page, cell: [number, number]): Promise<void> {
  const at = await screenCellCentre(page, cell[0], cell[1]);
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.up();
}

/** Boot the mocked app on the joined pair and select one of the two belts. */
async function selectBelt(page: Page, tile: [number, number]): Promise<Harness> {
  await page.addInitScript(() => localStorage.setItem('fab.onboarding.seen.v1', '1'));
  const h = await mockRenderSocket(page, {
    answerQuery: (verb) => (verb === 'machine_config' ? BELT_CONFIG : undefined),
  });
  await page.goto('/');
  await waitForChrome(page);
  await h.connected;

  h.inject(buildPacket({ belts: [UP, DOWN] }));
  await clickCell(page, tile);
  await expect(page.locator('#fab-belt-config')).toBeVisible({ timeout: 10_000 });
  return h;
}

test.describe('a belt-to-belt junction can be unmade from either side (LINK-09)', () => {
  test('the UPSTREAM belt\'s Outputs row disconnects, naming the OTHER belt', async ({ page }) => {
    const h = await selectBelt(page, UP_TILE);

    await expect(page.getByRole('heading', { name: 'Belt' })).toBeVisible();
    const ports = page.getByRole('region', { name: 'Ports' });
    await expect(ports).toBeVisible();

    // The row really reads as DOCKED, otherwise the control's presence below would
    // be proving something about a row in the wrong state. `idle` and not a count:
    // the fixture belts carry no items, and a docked belt with nothing on it is the
    // shipped idle step rather than "not connected".
    await expect(ports.getByRole('listitem', { name: /^Output - Item, idle$/ })).toHaveCount(1);
    // The Tail is free on this belt, so the Inputs row offers nothing. That is the
    // partial state UI-SPEC 4.4 calls ordinary, and it is asserted here so the
    // press below cannot be reaching the wrong row.
    await expect(
      ports.getByRole('listitem', { name: /^Input - Item, not connected$/ }),
    ).toHaveCount(1);
    await expect(ports.getByRole('button', { name: /^Disconnect/ })).toHaveCount(1);

    // Composed accessible name, never a bare "Disconnect" - the shipped join.
    await ports.getByRole('button', { name: 'Disconnect Output - Item' }).click();

    await expectExactlyOneFrame(page, h, CMD.Unlink);

    // ALL FOUR FIELDS, in `encodeGridCommand`'s Unlink order:
    //   disc(11), belt(u64 handle), endpoint(Head=0/Tail=1), node(u64), port
    const [disc, belt, end, node, port] = readVarints(h.sent[0], 5);
    expect(disc, 'discriminant 11 = Unlink').toBe(CMD.Unlink);
    expect(belt, 'the CARRIER belt, which here is the panel subject itself').toBe(UP_ID);
    expect(end, 'the carrier\'s own end: Head = 0').toBe(END_HEAD);
    expect(
      node,
      'THE OTHER BELT. The panel subject is the carrier on this row, so naming the ' +
        'subject here would name the wrong side of the link (T-74-33)',
    ).toBe(DOWN_ID);
    expect(node, 'and it is NOT the panel subject').not.toBe(UP_ID);
    expect(
      port,
      'the TARGET\'s admit port, read off the dock record - not this row\'s own ' +
        'index, which is 1 (the Head is the belt\'s second port)',
    ).toBe(0);
  });

  test('the DOWNSTREAM belt\'s Inputs row emits the IDENTICAL command, byte for byte', async ({
    page,
  }) => {
    const h = await selectBelt(page, DOWN_TILE);

    const ports = page.getByRole('region', { name: 'Ports' });
    await expect(ports).toBeVisible();
    // The mirror of the case above: on THIS belt the Tail is joined and the Head is
    // free, so exactly one control renders and it is on the Inputs row.
    await expect(ports.getByRole('listitem', { name: /^Input - Item, idle$/ })).toHaveCount(1);
    await expect(
      ports.getByRole('listitem', { name: /^Output - Item, not connected$/ }),
    ).toHaveCount(1);
    await expect(ports.getByRole('button', { name: /^Disconnect/ })).toHaveCount(1);

    await ports.getByRole('button', { name: 'Disconnect Input - Item' }).click();

    await expectExactlyOneFrame(page, h, CMD.Unlink);

    const [disc, belt, end, node, port] = readVarints(h.sent[0], 5);
    expect(disc).toBe(CMD.Unlink);
    expect(belt, 'the CARRIER is the UPSTREAM belt, which is NOT the panel subject').toBe(UP_ID);
    expect(end).toBe(END_HEAD);
    expect(node, 'the panel\'s own subject, because it IS the target side here').toBe(DOWN_ID);
    expect(port, 'this row\'s own catalog index: a belt\'s admit port is 0').toBe(0);

    // ONE LINK HAS ONE IDENTITY. The four assertions above already spell out the
    // same command the upstream case decoded; this states the property directly, in
    // the units the host reads, so a build where the two sides drifted apart fails
    // here even if both were internally consistent.
    const expected = Buffer.from([CMD.Unlink, UP_ID, END_HEAD, DOWN_ID, 0]);
    expect(
      Buffer.from(h.sent[0]).subarray(0, expected.length).toString('hex'),
      'both sides of one link emit the identical Unlink',
    ).toBe(expected.toString('hex'));
  });
});
