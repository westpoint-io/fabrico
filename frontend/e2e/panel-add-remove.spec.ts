import { test, expect, type Locator, type Page } from '@playwright/test';
import { PORT_NOTE_NARROWEST_COLS } from '../src/chrome/portNoteWrap';
import { startFrameSampler, waitForFrames } from './support/frameSampler';
import {
  CMD,
  buildPacket,
  mockRenderSocket,
  screenCellCentre,
  waitForChrome,
  type GestureAnswer,
  type Harness,
  type InjectBelt,
  type InjectNode,
  waitForBoard,
} from './support/wire';
import { PORT_STATUS } from '../src/chrome/configCopy';

// panel-add-remove.spec.ts (PANEL-03, Phase 51-03) - by-hand add/remove of a
// FACTORY's outputs from the config panel, over the already-certified
// AddPort (disc 7) / RemovePort (disc 8) EditOps.
//
// 73-08 REMOVED THE FRONTEND DOCK-SAFETY GATE this spec used to be written
// around. It refused to OFFER a removal that would strand a belt or silently
// renumber a later one, because the core's `fold_remove_port` dropped the port
// and never touched `links`. Plan 73-06 made that false: the fold re-points every
// route, dock and default keyed to the removed port, releases exactly the one belt
// that was on it, and the `RemovePort` inverse emits a compensating `Dock` so one
// Ctrl+Z restores both. The invariant now lives in
// `crates/fabrico-core/src/tick.rs` and is asserted by
// `crates/fabrico-core/tests/remove_port_repoint.rs`. Every case below that used
// to prove a block now proves the removal is OFFERED and EMITS.
//
// What each case proves, driven through the REAL path (injected packet ->
// SceneState -> App poll -> ports/flow props -> PortsSection -> emitted frame):
//
//   - Add emits EXACTLY ONE frame whose decoded fields are the locked defaults
//     (role = Out, medium = Item), on a Factory and nowhere else.
//   - A dock-safe Out's remove emits exactly one RemovePort carrying the right
//     PACKET port index.
//   - The two formerly-unsafe cases are OFFERED and carry NO reason element:
//       * the Out's own docked belt, and
//       * an EARLIER Out whose LATER sibling is docked - the index-shift case,
//         where the row itself still reads "not connected". Each now proves it by
//         CLICKING and decoding the emitted frame, which is stronger than the
//         disabled-and-silent assertion it replaces: an enabled button that
//         emitted nothing would have passed the old shape's inverse.
//   - A plain Add is ONE host action = ONE undo step (a single disc-5 frame).
//
// Fixture geometry is the reseated (post-AddPort) shape the host really
// produces - `reseat_ports` seats In on the W column, every Out down the E
// column and Fault on the S row - so the two-Out fixture is not invented.

/** A FACTORY (kind 2, 3x3) at (10,8) with ONE Out: In (10,9) W, Out (12,9) E,
 *  Fault (11,10) S. The catalog shape, shared with panel-io / panel-flow. */
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

/** The SAME Factory after a host AddPort: TWO Outs stacked down the East column
 *  (reseat_ports Out_k -> (w-1, k) facing E), In re-seated to (0,0) and Fault to
 *  (0,h-1). This is the shape the index-shift case needs.
 *
 *  WR-02: the PACKET ORDER here is `[In@0, Out@1, Fault@2, Out@3]`, and it used
 *  to be `[In@0, Out@1, Out@2, Fault@3]`. The geometry is identical either way -
 *  only the index field moved - but the old order is a fold the core cannot
 *  produce: `fold_add_port` does `ports.push(*port)` (tick.rs:392-394) and
 *  `resize_footprint_for_ports` -> `reseat_ports` rewrites `side`/`local_offset`
 *  in place WITHOUT reordering (state.rs:1010), so a hand-added Out always lands
 *  after the seeded Fault. Grouping the Outs together was the intuitive shape and
 *  the wrong one, which is exactly the assumption `PortsSection`'s header warns
 *  about. It mattered once the latch's release became a SUCCESSOR check: the
 *  "latch RELEASES on the host fold" case below injects this node as the fold of
 *  FACTORY, and an unreachable fold is not evidence of anything. */
const FACTORY_TWO_OUT: InjectNode = {
  id: 7,
  kind: 2,
  cell_x: 10,
  cell_y: 8,
  w: 3,
  h: 3,
  ports: [
    { index: 0, cell_x: 10, cell_y: 8, side: 3, role: 0, medium: 0 },
    { index: 1, cell_x: 12, cell_y: 8, side: 1, role: 1, medium: 0 },
    { index: 2, cell_x: 10, cell_y: 10, side: 2, role: 2, medium: 0 },
    { index: 3, cell_x: 12, cell_y: 9, side: 1, role: 1, medium: 0 },
  ],
};

/** 74.1-14: the SAME Factory after two host AddPorts, seated centre-out from the
 *  catalog box (`reseat_ports`, the 2026-10-04 ruling): packet order `[In@0, Out@1,
 *  Fault@2, Out@3, Out@4]`, In (10,9) W, Outs down the E column on rows 1, 2, 0 by
 *  role index ((12,9), (12,10), (12,8)), Fault (11,10) S. Every Out slot is taken, so
 *  one more output needs a fourth row, y = 11 (plan 74.1-16's growth on the far edge). */
const FACTORY_THREE_OUT: InjectNode = {
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
    { index: 3, cell_x: 12, cell_y: 10, side: 1, role: 1, medium: 0 },
    { index: 4, cell_x: 12, cell_y: 8, side: 1, role: 1, medium: 0 },
  ],
};

/** A belt draining the Factory's Fault nub (11,10) south, keyed on the 65535
 *  `FAULT_PORT` sentinel. */
const FAULT_BELT: InjectBelt = {
  id: 120,
  tiles: [
    [11, 11],
    [11, 12],
  ],
  itemCount: 0,
  docks: [{ end: 'Tail', node: 7, port: 65535 }],
};

/** The Factory body cell (never a nub cell) - the safe click-to-select point. */
const FACTORY_BODY: [number, number] = [11, 9];
const FACTORY_CONFIG = { kind: 'Factory', source: 'export default (payload) => payload;' };

/** A SOURCE (kind 0) with one Out - a non-Factory kind that HAS an output, so
 *  "no controls" cannot pass vacuously on a machine with nothing to remove. */
const SOURCE: InjectNode = {
  id: 11,
  kind: 0,
  cell_x: 4,
  cell_y: 4,
  ports: [{ index: 0, cell_x: 4, cell_y: 4, side: 1, role: 1, medium: 0 }],
};
const SOURCE_BODY: [number, number] = [4, 4];

/** A TEE (kind 3) - two ports, NULL machine_config (the port-only kind). */
const TEE: InjectNode = {
  id: 12,
  kind: 3,
  cell_x: 6,
  cell_y: 6,
  ports: [
    { index: 0, cell_x: 6, cell_y: 6, side: 3, role: 0, medium: 0 },
    { index: 1, cell_x: 6, cell_y: 6, side: 1, role: 1, medium: 0 },
  ],
};
const TEE_BODY: [number, number] = [6, 6];

/**
 * A belt Tail-docked to the Factory's Out at ROUTING key `outKey` (the nth
 * role===1 port - the exact keyspace `dockPort` reverse-maps and `RemovePort`
 * renumbers). Tail = FIRST tile, so it sits on the cell the Out port feeds.
 */
const outBelt = (outKey: number, tailCell: [number, number]): InjectBelt => ({
  id: 100 + outKey,
  tiles: [tailCell, [tailCell[0] + 1, tailCell[1]]],
  // Phase 91 (CHROME-13): two items behind an empty head slot (slots 6 and 7 of 8),
  // a flowing belt, so the docked row reads `moving`. Packed from slot 0 with the
  // head on open floor it would read `backed up`.
  itemSlots: [6, 7],
  docks: [{ end: 'Tail', node: FACTORY.id, port: outKey }],
});

// ---------------------------------------------------------------------------
// Frame decoding - the emitted bytes are asserted by FIELD, not by byte index,
// so a fixture handle change can never silently turn a wrong-field assertion
// green (the encoder writes node/index as varints, role/side/medium as u8).
// ---------------------------------------------------------------------------

/** Read an LEB128 unsigned varint at `at`; returns [value, nextOffset]. */
function varintU(buf: Buffer, at: number): [number, number] {
  let value = 0;
  let shift = 1;
  let i = at;
  for (;;) {
    const b = buf[i];
    i += 1;
    value += (b & 0x7f) * shift;
    if ((b & 0x80) === 0) break;
    shift *= 128;
  }
  return [value, i];
}

/** Decode an `AddPort` frame: disc(7), node(varintU), role/side/medium(u8). */
function decodeAddPort(frame: Buffer) {
  expect(frame[0], 'AddPort discriminant').toBe(CMD.AddPort);
  const [node, at] = varintU(frame, 1);
  return { node, role: frame[at], side: frame[at + 1], medium: frame[at + 2] };
}

/** Decode a `RemovePort` frame: disc(8), node(varintU), index(varintU). */
function decodeRemovePort(frame: Buffer) {
  expect(frame[0], 'RemovePort discriminant').toBe(CMD.RemovePort);
  const [node, at] = varintU(frame, 1);
  const [index] = varintU(frame, at);
  return { node, index };
}

/**
 * Assert the interaction emitted EXACTLY ONE NEW frame of `discriminant` since
 * `from` - the multi-action variant of wire.ts `expectExactlyOneFrame` (this
 * spec's Ctrl+Z case fires a SECOND command after the Add). The settle re-check
 * is the same discipline: `expect.poll(...).toBe(n)` resolves the instant the
 * count first reaches n and would miss a LATE duplicate (WR-13-03).
 */
async function expectOneNewFrame(
  page: Page,
  h: Harness,
  from: number,
  discriminant: number,
): Promise<Buffer> {
  await expect.poll(() => h.sent.length).toBe(from + 1);
  expect(h.sent[from][0]).toBe(discriminant);
  await page.waitForTimeout(150);
  expect(h.sent.length, 'the control must emit no late duplicate frame').toBe(from + 1);
  return h.sent[from];
}

/**
 * Boot the mocked app, inject `node` (plus optional belts), click-select it and
 * wait for the panel heading. `canUndo` seeds the trailing packet flag the
 * Toolbar/keyboard undo is gated on (App only emits an Undo while the session
 * says one is available).
 */
async function selectMachine(
  page: Page,
  opts: {
    node: InjectNode;
    body: [number, number];
    config: unknown;
    heading: string;
    belts?: InjectBelt[];
    canUndo?: boolean;
    /** How the mock host answers each gesture frame (default: silence, an accept). */
    answerGesture?: (frame: Buffer, seq: number) => GestureAnswer;
  },
): Promise<Harness> {
  await page.addInitScript(() => localStorage.setItem('fab.onboarding.seen.v1', '1'));
  const h = await mockRenderSocket(page, {
    answerQuery: (verb) => (verb === 'machine_config' ? opts.config : undefined),
    answerGesture: opts.answerGesture,
  });
  await page.goto('/');
  await waitForChrome(page);
  await h.connected;

  h.inject(buildPacket({ nodes: [opts.node], belts: opts.belts, canUndo: opts.canUndo }));
  await waitForBoard(page, { machines: 1 });

  const at = await screenCellCentre(page, opts.body[0], opts.body[1]);
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.up();
  await expect(page.getByRole('heading', { name: opts.heading })).toBeVisible({ timeout: 10_000 });
  // The select-click is a canvas gesture, so it never lands a frame on the wire;
  // every spec below counts frames from zero.
  expect(h.sent.length, 'selecting a machine emits no GridCommand').toBe(0);
  return h;
}

/** The `<section aria-label="Ports">` mounted below the per-kind body. */
function portsSection(page: Page) {
  return page.getByRole('region', { name: 'Ports' });
}

/** One port row, located by the stable label prefix of its composite name. */
function row(page: Page, label: string): Locator {
  return portsSection(page).getByRole('listitem', { name: label });
}

const addButton = (page: Page) => portsSection(page).getByRole('button', { name: '+ Add output' });
const removeButton = (page: Page, n: number) =>
  portsSection(page).getByRole('button', { name: `Remove output ${n}` });

/** 73-08: THE TWO BLOCK-CAUSE LITERALS THAT USED TO SIT HERE ARE GONE with the
 *  gate that produced them. They were kept as literals on purpose - this spec is
 *  the contract check, so importing the constant would let a copy change pass
 *  silently on both sides - and the same discipline applies to their absence: the
 *  assertions below check for NO reason element at all rather than for the absence
 *  of a particular sentence, so a resurrected block under new words would still
 *  redden this file. */

/** Phase 91 (D-12, CHROME-13, UI-SPEC 8.4): the consequence stated under a Factory Out
 *  row whose port has a docked belt, and on no other row. It replaced the standing
 *  last-output sentence. Same literal-on-purpose discipline as the two reasons above. */
const DOCKED_OUTPUT_NOTE = 'Removing this output disconnects its belt.';

/** Phase 91 (UI-SPEC 8.4): a non-Factory Outputs group ends at its last row. The QA-02
 *  wall 3 sentence that stood under it is deleted, so the spec grades the ABSENCE of any
 *  note element in the Ports section rather than of one wording. */

/** The frames the J10 and G1 samplers must observe: the old `> 20` floor, now reached
 *  rather than hoped for inside a fixed window (plan 84-08, the 2026-10-09 CI run). */
const J10_FRAMES = 21;
const G1_FRAMES = 21;
/** J10: the page time between the AddPort send and the host's fold, inside the 400 ms
 *  grace and in the 59 to 173 ms measured on the manual walk (plan 74.1-19). */
const FOLD_AFTER_MS = 150;
/** One frame of page time on the paused clock (60 Hz). */
const FRAME_MS = 16;
/** `portEditGrace.ts` PORT_EDIT_PENDING_GRACE_MS, mirrored rather than imported, as this
 *  file mirrors its copy literals: the spec is the contract check. */
const PORT_EDIT_PENDING_GRACE_MS = 400;

/**
 * Assert a remove control is OFFERED and says nothing (73-08).
 *
 * Both halves are load-bearing. `toBeEnabled` alone would pass on a build that
 * kept a stale sentence under a live button, which is the worse of the two
 * regressions: a warning under an offered control reads as a hazard that no
 * longer exists. Asserting the ABSENCE of the `aria-describedby` element rather
 * than the absence of a particular string is what makes it survive a reword.
 */
async function expectOfferedWithoutReason(page: Page, n: number): Promise<void> {
  const btn = removeButton(page, n);
  await expect(btn, `remove ${n} is offered`).toBeEnabled();
  expect(
    await btn.getAttribute('aria-describedby'),
    `remove ${n} carries no reason element`,
  ).toBeNull();
}

/**
 * Assert a remove control is offered AND carries `note` on a visible element its
 * `aria-describedby` resolves to. Resolving the id (rather than looking for the
 * words somewhere on screen) is what proves a screen reader hears it on THIS
 * control. The only note left after 73-08 is the last-output consequence.
 */
async function expectOfferedWithNote(page: Page, n: number, note: string): Promise<void> {
  const btn = removeButton(page, n);
  await expect(btn, `remove ${n} is offered`).toBeEnabled();
  const describedBy = await btn.getAttribute('aria-describedby');
  expect(describedBy, `remove ${n} names its note element`).toBeTruthy();
  const noteEl = page.locator(`#${describedBy}`);
  await expect(noteEl).toBeVisible();
  await expect(noteEl).toHaveText(note);
}

test.describe('Config panel add/remove output (PANEL-03)', () => {
  test('"+ Add output" on a Factory emits exactly ONE AddPort with the locked Out/Item defaults', async ({
    page,
  }) => {
    const h = await selectMachine(page, {
      node: FACTORY,
      body: FACTORY_BODY,
      config: FACTORY_CONFIG,
      heading: 'Factory',
    });

    await addButton(page).click();
    const frame = await expectOneNewFrame(page, h, 0, CMD.AddPort);

    // Decoded by field: the node handle, and the two locked defaults - role Out
    // (1) and medium Item/Mechanical (0). A Wire medium picker is deferred, so
    // medium MUST be 0 here or the panel would be minting wire ports silently.
    const cmd = decodeAddPort(frame);
    expect(cmd.node, 'the AddPort targets the selected node').toBe(FACTORY.id);
    expect(cmd.role, 'role = Out').toBe(1);
    expect(cmd.medium, 'medium = Item (Mechanical)').toBe(0);
    // WR-04: the side is the CONSTANT East, never read off the live port list.
    // `PortView.side` is the WORLD side after rotation (render_packet.rs:462-472),
    // so mirroring it would put a rotation-dependent byte into the certified
    // AddPort that `command.rs:812` freezes into the append-only edit log - even
    // though the fold's `reseat_ports` overrides it. Shape-only, and constant.
    expect(cmd.side, 'side is the constant East, not the rotated last Out').toBe(1);
  });

  test('a dock-safe Out removes with exactly ONE RemovePort carrying its packet port index', async ({
    page,
  }) => {
    // No belts at all: the Out is clean and no later Out exists -> removable.
    const h = await selectMachine(page, {
      node: FACTORY,
      body: FACTORY_BODY,
      config: FACTORY_CONFIG,
      heading: 'Factory',
    });

    const btn = removeButton(page, 1);
    await expect(btn, 'a clean Out is offered for removal').toBeEnabled();
    // Phase 91 (UI-SPEC 8.4): a fresh Factory's lone UNDOCKED Out says nothing. The
    // note is for a removal that drops a belt, and this one drops none.
    await expectOfferedWithoutReason(page, 1);
    await expect(portsSection(page).getByText(DOCKED_OUTPUT_NOTE)).toHaveCount(0);
    await btn.click();

    const cmd = decodeRemovePort(await expectOneNewFrame(page, h, 0, CMD.RemovePort));
    expect(cmd.node).toBe(FACTORY.id);
    // The PACKET port index (1), not the Out ordinal (0) - the core splices its
    // rot-0 port LIST, so sending the ordinal would delete the In port.
    expect(cmd.index, 'RemovePort carries the packet port index, not the Out ordinal').toBe(1);
  });

  test('a DOUBLE-click on a remove control emits exactly ONE RemovePort (the in-flight latch)', async ({
    page,
  }) => {
    // CR-01 regression. The panel's port indices refresh on the ~10Hz poll, which
    // waits on the host fold + the next packet - so for ~120-200ms after the
    // first click the button is still pointing at the PRE-removal index. Without
    // the latch a second click inside that window re-sends the stale index, and
    // the host's validate arm (out-of-range only) folds it verbatim: two ports
    // deleted from one gesture, two Ctrl+Z to reverse, and - with a fault dock in
    // play - a belt stranded on a port that no longer exists.
    //
    // The mock host never echoes a fold, which is exactly the pessimal case: the
    // latch must hold on the SEND, not on the echo.
    const h = await selectMachine(page, {
      node: FACTORY_TWO_OUT,
      body: FACTORY_BODY,
      config: FACTORY_CONFIG,
      heading: 'Factory',
    });

    const btn = removeButton(page, 1);
    await expect(btn, 'both Outs are clean, so the first is offered').toBeEnabled();
    await btn.dblclick();

    // Exactly one frame, and it is the FIRST index - never a second removal.
    await expect.poll(() => h.sent.length).toBe(1);
    // The whole Outputs edit group reads busy while the edit is in flight, so an
    // Add cannot be queued behind a pending Remove either.
    await expect(btn, 'the remove control latches until the topology refreshes').toBeDisabled();
    await expect(addButton(page), 'Add is latched by the same in-flight edit').toBeDisabled();

    await page.waitForTimeout(200);
    expect(h.sent.length, 'the second click of the double must emit nothing').toBe(1);
    expect(decodeRemovePort(h.sent[0]).index).toBe(1);
  });

  test('an Out with its OWN docked belt is OFFERED, and its click really emits (73-08)', async ({
    page,
  }) => {
    // The `own-dock` case, the one the walk board measured on the shipped demo
    // Factory: "Disconnect it first" under a dead x. Since 73-06 the fold releases
    // exactly that belt and records it, and one Ctrl+Z re-adds the port AND
    // re-docks the belt, so the removal is ordinary and fully reversible.
    const h = await selectMachine(page, {
      node: FACTORY,
      body: FACTORY_BODY,
      config: FACTORY_CONFIG,
      heading: 'Factory',
      belts: [outBelt(0, [13, 9])],
    });

    // The row itself still reports the dock - the readout is untouched by this
    // phase, so this is a docked Out and not a fixture that lost its belt.
    await expect(row(page, 'Output - Item')).toContainText(PORT_STATUS.moving);
    // A belt is docked on it, so the note slot carries the docked-output CONSEQUENCE
    // (phase 91). That note never disabled anything and still does not.
    await expectOfferedWithNote(page, 1, DOCKED_OUTPUT_NOTE);

    // ...and it EMITS. An enabled button that sent nothing would pass a
    // toBeEnabled-only assertion, which is the shape this replaces.
    await removeButton(page, 1).click();
    const cmd = decodeRemovePort(await expectOneNewFrame(page, h, 0, CMD.RemovePort));
    expect(cmd.node, 'the RemovePort targets the selected node').toBe(FACTORY.id);
    expect(cmd.index, 'and carries the docked Out\'s PACKET port index').toBe(1);
  });

  test('an EARLIER Out is OFFERED when a LATER Out is docked - the index-shift case (73-08)', async ({
    page,
  }) => {
    // The load-bearing case, inverted. Only Out 2 has a belt; Out 1 is completely
    // clean, and removing it DOES shift Out 2 down a routing key - which used to be
    // the whole reason the panel refused, because `reseat_ports` is positional and
    // `fold_remove_port` touched no links, so the later belt silently started
    // draining a different output.
    //
    // UNDO-04 and UNDO-05 closed exactly that: the fold re-keys every surviving
    // dock and re-points `routes` and `default`, so the later belt stays on its OWN
    // output. The renumber is performed correctly rather than refused.
    const h = await selectMachine(page, {
      node: FACTORY_TWO_OUT,
      body: FACTORY_BODY,
      config: FACTORY_CONFIG,
      heading: 'Factory',
      belts: [outBelt(1, [13, 9])],
    });

    const rows = portsSection(page).getByRole('listitem', { name: 'Output - Item' });
    await expect(rows).toHaveCount(2);
    // Out 1 carries NO dock of its own. The pairing still matters: it is what makes
    // this the RENUMBER case rather than the own-dock one.
    await expect(rows.first(), 'the earlier Out is genuinely unconnected').toContainText(
      'not connected',
    );
    await expectOfferedWithoutReason(page, 1);

    // ...and the docked Out 2 is offered too. It carries the docked-output note
    // (phase 91): removing it releases its belt. No block, only the consequence.
    await expect(rows.nth(1)).toContainText(PORT_STATUS.moving);
    await expectOfferedWithNote(page, 2, DOCKED_OUTPUT_NOTE);

    // The earlier Out's click emits, carrying ITS packet index (1) and not the
    // docked sibling's (3). A control that fired the wrong index would be worse
    // than the block it replaced, so the index is decoded rather than counted.
    await removeButton(page, 1).click();
    const cmd = decodeRemovePort(await expectOneNewFrame(page, h, 0, CMD.RemovePort));
    expect(cmd.index, 'the EARLIER Out\'s own packet index').toBe(1);
  });

  /** The CONFIG panel (the Palette is an `aside.fab-panel` too). */
  const configPanel = (page: Page) =>
    page.locator('aside.fab-panel[aria-labelledby="fab-config-heading"]');

  /** SELECT THE ROW THAT CARRIES THE ONE ROW NOTE THE SECTION SHIPS.
   *
   *  73-08 deleted the three block reasons, and phase 91 (UI-SPEC 8.4) replaced the
   *  standing last-output sentence with the docked-output note, so the two layout
   *  cases below take the lone-Out Factory with a belt docked on its Out: the row
   *  that note is shown on. They are about the NOTE SLOT rather than about one
   *  sentence. */
  const selectWidestNoteFactory = (page: Page) =>
    selectMachine(page, {
      node: FACTORY,
      body: FACTORY_BODY,
      config: FACTORY_CONFIG,
      heading: 'Factory',
      belts: [outBelt(0, [13, 9])],
    });

  test('a noted Out row gives its note a FULL-WIDTH line of its own', async ({ page }) => {
    // 51-UI-REVIEW fix 2, and the measured shape of the defect rather than the
    // predicted one. The row used to be ONE flex line holding
    // `[glyph][Output - Item][not connected][44px x][<the later-dock reason>]`.
    // It did not clip at the default viewport - a text flex item's
    // automatic minimum size is its MIN-CONTENT (longest word), so the reason
    // shrank instead. It shrank to 207px: the longest string in the section,
    // wrapped into a ragged ribbon in the ~200px left over beside a 44px button,
    // at the row's `lineHeight: 1`. Squeezing it narrower is what the panel does
    // as the window narrows (105px at 900, 59px at 760), until at 640 it finally
    // does overflow - see the narrow-viewport case below.
    //
    // This is the COMMON case, not an edge case: a Factory has one Out until the
    // builder adds another. The measured numbers in the paragraph above were taken
    // against the 51-character `later-dock` sentence 73-08 deleted; the note now
    // under test is the 42-character docked-output note (phase 91).
    await selectWidestNoteFactory(page);
    await expectOfferedWithNote(page, 1, DOCKED_OUTPUT_NOTE);

    const row = portsSection(page).getByRole('listitem', { name: 'Output - Item' }).first();
    const describedBy = await removeButton(page, 1).getAttribute('aria-describedby');
    const reason = page.locator(`#${describedBy}`);

    // The reason spans the row rather than the leftover gap beside the button.
    // Pre-fix this was 207 against a 420px row; the indent that aligns it under
    // the label column is the only width it gives up.
    const rowW = (await row.boundingBox())!.width;
    const reasonW = (await reason.boundingBox())!.width;
    expect(reasonW, 'the reason gets the row, not the gap').toBeGreaterThan(rowW * 0.9);

    // The mechanism: it sits BELOW the control line, not beside the button.
    const reasonBox = (await reason.boundingBox())!;
    const btnBox = (await removeButton(page, 1).boundingBox())!;
    expect(reasonBox.y, 'the reason is on its own line under the row').toBeGreaterThanOrEqual(
      btnBox.y + btnBox.height - 1,
    );
  });

  test('a noted Out row does not overflow the panel on a NARROW window', async ({ page }) => {
    // The panel is `width: min(420px, 33vw)`, so its content box tracks the
    // window: at 640px wide it is ~211px. Pre-fix the blocked row's control line
    // plus its squeezed reason could not fit that (row scrollWidth 240 vs
    // clientWidth 211) and the panel gained a horizontal scroll it has no story
    // for - the reader simply could not reach the end of the sentence explaining
    // why the button beside it is dead.
    await page.setViewportSize({ width: 640, height: 720 });
    await selectWidestNoteFactory(page);
    await expectOfferedWithNote(page, 1, DOCKED_OUTPUT_NOTE);

    // `overflow-y: auto` makes the panel a scroll container on BOTH axes, so
    // scrollWidth is the honest measure of anything inside running wide.
    const panel = await configPanel(page).evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    }));
    expect(panel.scrollWidth, 'nothing in the panel runs wide').toBeLessThanOrEqual(
      panel.clientWidth,
    );

    const row = await portsSection(page)
      .getByRole('listitem', { name: 'Output - Item' })
      .first()
      .evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }));
    expect(row.scrollWidth, 'the noted row fits its own box').toBeLessThanOrEqual(
      row.clientWidth,
    );
  });

  test('a docked FAULT port blocks nothing - NEGATIVE CONTROL after 73-08', async ({
    page,
  }) => {
    // DECLARED AS A NEGATIVE CONTROL rather than left reading as coverage. It was
    // green before this phase because a fault dock is sentinel-addressed and never
    // renumbered, so the gate carved it out; it is green after for the wider reason
    // that no dock blocks a Remove at all. What it still genuinely pins is that the
    // Fault row itself has NO remove control - only Out ports are editable - which
    // is untouched by 73-08 and would redden if the row set ever widened.
    await selectMachine(page, {
      node: FACTORY,
      body: FACTORY_BODY,
      config: FACTORY_CONFIG,
      heading: 'Factory',
      belts: [
        {
          id: 200,
          tiles: [
            [11, 11],
            [11, 12],
          ],
          itemSlots: [7],
          docks: [{ end: 'Tail', node: FACTORY.id, port: 65535 }],
        },
      ],
    });

    await expect(row(page, 'Fault - Item')).toContainText(PORT_STATUS.moving);
    // The Fault row has NO remove control of its own (only Out ports are
    // editable), and it does not block the Out either.
    await expect(portsSection(page).getByRole('button', { name: /^Remove output/ })).toHaveCount(1);
    await expect(removeButton(page, 1), 'a docked Fault cannot block an Out').toBeEnabled();
  });

  test('non-Factory kinds keep the read-only list: no Add button, no remove control, and no note', async ({
    page,
  }) => {
    // A Source HAS an Out port, so this cannot pass vacuously.
    await selectMachine(page, {
      node: SOURCE,
      body: SOURCE_BODY,
      config: { kind: 'Source', trigger: { kind: 'Webhook' } },
      heading: 'Source',
    });
    await expect(row(page, 'Output - Item')).toBeVisible();
    await expect(addButton(page)).toHaveCount(0);
    await expect(portsSection(page).getByRole('button', { name: /^Remove output/ })).toHaveCount(0);
    // Phase 91 (UI-SPEC 8.4): the group ends at its last row. No note element at all.
    await expect(portsSection(page).locator('p')).toHaveCount(0);

    // ...and the same for a port-only kind whose machine_config is null.
    await page.reload();
    await selectMachine(page, { node: TEE, body: TEE_BODY, config: null, heading: 'Tee' });
    await expect(row(page, 'Output - Item')).toBeVisible();
    await expect(addButton(page)).toHaveCount(0);
    await expect(portsSection(page).getByRole('button', { name: /^Remove output/ })).toHaveCount(0);
    await expect(portsSection(page).locator('p')).toHaveCount(0);
  });

  test('a non-Factory Outputs group ends at its last row and describes nothing (phase 91, UI-SPEC 8.4)', async ({
    page,
  }) => {
    // QA-02 wall 3 used to hang a sentence under every non-Factory Outputs group, about
    // a control nothing on those machines suggests exists. It is deleted: the group's
    // last child is its last row, and the list points at no description.
    await selectMachine(page, { node: TEE, body: TEE_BODY, config: null, heading: 'Tee' });
    const outputs = portsSection(page).getByRole('list').nth(1);
    expect(await outputs.getAttribute('aria-describedby'), 'the Outputs group describes nothing').toBeNull();
    expect(
      await outputs.evaluate((list) => list.nextElementSibling?.tagName ?? 'NONE'),
      'nothing follows the Outputs list in the Ports section',
    ).toBe('NONE');

    // On a Factory the real control is there, and the group still describes nothing.
    await page.reload();
    await selectMachine(page, {
      node: FACTORY,
      body: FACTORY_BODY,
      config: FACTORY_CONFIG,
      heading: 'Factory',
    });
    await expect(addButton(page)).toBeVisible();
    await expect(
      portsSection(page).getByRole('list').nth(1),
      'a Factory group describes nothing - there is no absence to explain',
    ).not.toHaveAttribute('aria-describedby', /./);
  });

  test('the Ports column runs at the measured note column count at 640, 800 and 1024 (WINDOWS id 3)', async ({
    page,
  }) => {
    // 52-UI-SPEC's two-line note budget was measured here on the non-Factory note, and
    // the column count it ran at is `PORT_NOTE_NARROWEST_COLS`, the number the node test
    // wraps the WR-08 note (`Outputs cannot be added or removed here.`) against. That
    // note's state is unreachable from the app, so it cannot be measured itself. Phase 91
    // deleted the non-Factory note, so the column is measured on what the note slot
    // spans: the Ports section's own content width, in the rows' font. A note `<p>` is a
    // block child of that column, so its run is this width.
    await selectMachine(page, { node: TEE, body: TEE_BODY, config: null, heading: 'Tee' });
    const section = portsSection(page);
    const NARROWEST_VIEWPORT_PX = 640;
    for (const width of [1024, 800, NARROWEST_VIEWPORT_PX]) {
      await page.setViewportSize({ width, height: 720 });
      await expect(section).toBeVisible();
      const cols = await section.evaluate((el) => {
        const rowEl = el.querySelector('[role="listitem"]') as HTMLElement;
        const probe = document.createElement('span');
        probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre';
        probe.style.font = getComputedStyle(rowEl).font;
        probe.textContent = 'M'.repeat(100);
        el.appendChild(probe);
        const advance = probe.getBoundingClientRect().width / 100;
        probe.remove();
        const run = el.clientWidth;
        return { advance, run, cols: Math.floor(run / advance) };
      });
      expect(
        Number.isFinite(cols.advance) && cols.advance > 0,
        `the row font's character advance measures at ${width}px (got ${String(cols.advance)})`,
      ).toBe(true);
      if (width === NARROWEST_VIEWPORT_PX) {
        expect(
          cols.cols,
          `the wrap model's column count matches the browser at ${width}px (advance ${cols.advance}px over a ${cols.run}px run)`,
        ).toBe(PORT_NOTE_NARROWEST_COLS);
      } else {
        expect(
          cols.cols,
          `${width}px is wider than the ${NARROWEST_VIEWPORT_PX}px case the constant is taken from`,
        ).toBeGreaterThanOrEqual(PORT_NOTE_NARROWEST_COLS);
      }
    }
  });

  test('Add warns BEFORE the click exactly when the host would refuse one more output for a belt', async ({
    page,
  }) => {
    // RE-AUTHORED IN 74.1-19 as a NAMED CHANGED OUTCOME (review WR-02, re-walk J10).
    // The 74.1-14 note said "Adding an output makes this machine bigger and disconnects
    // its fault belt." and showed on Out count >= height plus a docked Fault. The host
    // never did that: an add whose taller box would cover a belt is refused
    // (`GrowCoversBelt`, plan 74.1-18) and an accepted add releases nothing (74.1-16).
    // The note now follows `addOutputVerdict`, held to the engine's own AddPort
    // verdicts in `addOutput.test.ts`; this leg proves the App wiring end to end.
    //
    // (1) A wired one-output Factory: a free Out slot, so the box does not grow and
    // the add is accepted. No note.
    await selectMachine(page, {
      node: FACTORY,
      body: FACTORY_BODY,
      config: FACTORY_CONFIG,
      heading: 'Factory',
      belts: [outBelt(0, [13, 9])],
    });
    await expect(addButton(page), 'a wired one-output Factory carries no note').not.toHaveAttribute(
      'aria-describedby',
      /./,
    );
    await expect(portsSection(page).getByText(/a belt is in the way/)).toHaveCount(0);

    // (2) Three outputs on a 3-tall Factory with a belt on its Fault port: one more
    // output needs a fourth row, whose first occupied cell is that belt's tile (11,11).
    // The host refuses; the note says so before the click, wired to the button.
    await page.reload();
    await selectMachine(page, {
      node: FACTORY_THREE_OUT,
      body: FACTORY_BODY,
      config: FACTORY_CONFIG,
      heading: 'Factory',
      belts: [FAULT_BELT],
    });
    const describedBy = await addButton(page).getAttribute('aria-describedby');
    expect(describedBy, 'the Add control names its note').toBeTruthy();
    await expect(page.locator(`#${describedBy}`)).toHaveText(
      'One more output needs another row, and a belt is in the way. Move it first.',
    );
    await expect(addButton(page), 'the note never gates the add (D-07)').toBeEnabled();

    // (3) The same Factory with belts on its outputs and none where it would grow:
    // the host accepts, so it says nothing.
    await page.reload();
    await selectMachine(page, {
      node: FACTORY_THREE_OUT,
      body: FACTORY_BODY,
      config: FACTORY_CONFIG,
      heading: 'Factory',
      belts: [outBelt(0, [13, 9]), outBelt(1, [13, 10])],
    });
    await expect(addButton(page), 'nothing in the growth row, no note').not.toHaveAttribute('aria-describedby', /./);
    await expect(portsSection(page).getByText(/a belt is in the way/)).toHaveCount(0);
  });

  test('at 1280x720 the add note and + Add output both sit inside the panel with no user scroll (re-walk J10)', async ({
    page,
  }) => {
    // Plan 74.1-19. The note is only worth showing if it can be read where it applies.
    // On a full Factory the Ports section sits below the code editor, and at the
    // smallest window this project designs for, a note placed AFTER the button fell
    // below the panel's visible scroll area (RED BEFORE THE FIX: y 754..785 against a
    // visible 46..674), and so did one placed directly above it (y 702..733). The
    // panel now scrolls the note and the button into view itself when the note first
    // appears (`revealAddNote`); the user scrolls nothing. Measured by bounding boxes
    // against the scroll container's own client rect, never by a screenshot.
    await page.setViewportSize({ width: 1280, height: 720 });
    await selectMachine(page, {
      node: FACTORY_THREE_OUT,
      body: FACTORY_BODY,
      config: FACTORY_CONFIG,
      heading: 'Factory',
      belts: [FAULT_BELT],
    });
    const describedBy = await addButton(page).getAttribute('aria-describedby');
    expect(describedBy, 'the note is shown on this board').toBeTruthy();
    const note = page.locator(`#${describedBy}`);
    await expect(note).toHaveText('One more output needs another row, and a belt is in the way. Move it first.');
    // The panel has had its layout pass: measure once it is settled.
    await page.waitForTimeout(200);
    const scroller = page.locator('[data-fab-panel-scroll]');
    const view = await scroller.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top + el.clientTop, bottom: r.top + el.clientTop + el.clientHeight, scrollTop: el.scrollTop };
    });
    for (const [name, loc] of [
      ['the note', note],
      ['+ Add output', addButton(page)],
    ] as const) {
      const box = await loc.boundingBox();
      expect(box, `${name} has a box`).not.toBeNull();
      const b = box as NonNullable<typeof box>;
      expect(b.height, `${name} is rendered`).toBeGreaterThan(0);
      expect(
        b.y >= view.top && b.y + b.height <= view.bottom,
        `${name} spans y ${Math.round(b.y)}..${Math.round(b.y + b.height)}; the panel shows ${Math.round(view.top)}..${Math.round(view.bottom)}`,
      ).toBe(true);
    }
    // The note goes ABOVE the button, so the two read as one unit.
    const noteBox = (await note.boundingBox()) as NonNullable<Awaited<ReturnType<Locator['boundingBox']>>>;
    const btnBox = (await addButton(page).boundingBox()) as NonNullable<Awaited<ReturnType<Locator['boundingBox']>>>;
    expect(noteBox.y + noteBox.height, 'the note sits directly above the button').toBeLessThanOrEqual(btnBox.y);
    // The reveal happens when the note FIRST appears, not on every ~10 Hz re-render:
    // a user who scrolls back to the top is not pulled down again.
    await scroller.evaluate((el) => {
      el.scrollTop = 0;
    });
    await page.waitForTimeout(600);
    expect(await scroller.evaluate((el) => el.scrollTop), 'the panel stays where the user put it').toBe(0);
  });

  test('a port edit that folds inside the grace paints NO status text on any frame (re-walk J10)', async ({
    page,
  }) => {
    // Plan 74.1-19. The flash seen on the manual walk: the pending status painted for 59 to 173 ms on
    // every add. The mock host folds 150 ms after the click, inside the 400 ms grace, and
    // a requestAnimationFrame sampler records whether `role="status"` text is in the Ports
    // section on every frame.
    //
    // THE 150 ms IS THE PAGE'S OWN TIME, HELD BY THE TEST (plan 84-08). The fold used to
    // be injected by the test after `expectOneNewFrame`, whose poll back-off and 150 ms
    // settle sat between the send and the fold, so "150 ms" was however long the test's
    // own round trips took. On two cores at a 50% CPU quota that was about 600 ms of page
    // time, past the grace: the pending status painted and the test measured its waits
    // instead of the app (plan 84-08's runs; the 2026-10-09 CI run's two-CPU runner is where
    // this file's samplers were first seen measuring the machine). Now the page runs on
    // Playwright's clock: it is paused before the click, run forward exactly FOLD_AFTER_MS
    // with the latch in flight, the fold is delivered and applied while page time stands
    // still, and only then does time flow again. The fold lands at 150 ms of page time on
    // any machine, so a status that showed before 150 ms (a grace that failed) is caught,
    // and one that would show at 400 ms never does.
    await page.clock.install();
    const h = await selectMachine(page, {
      node: FACTORY,
      body: FACTORY_BODY,
      config: FACTORY_CONFIG,
      heading: 'Factory',
    });
    // Stop the page's clock. `pauseAt` only jumps forward, so it is aimed a second past
    // the page's present to leave room for the round trip; timers due in that second fire
    // once, as they would have anyway.
    const pageNow = await page.evaluate(() => Date.now());
    await page.clock.pauseAt(pageNow + 1000);
    //
    // THE SAMPLER ENDS ON FRAMES OBSERVED, NOT ON 1500 ms ALONE (plan 84-08). It used to
    // run for a fixed 1500 ms and then assert it had seen more than 20 frames, which
    // measured the machine: on the 2026-10-09 CI run's two-CPU runner the sibling G1 sampler
    // below counted 13 and 11 frames in its 2000 ms. It now covers the same 1500 ms AND
    // runs on until it has observed J10_FRAMES frames (the old floor, > 20), so the claim
    // "on every one of N frames, no status" means the same on a desktop and a runner. A
    // page that never reaches N frames is a named failure of `waitForFrames`.
    await startFrameSampler(
      page,
      '__j10',
      { minMs: 1500, frames: J10_FRAMES },
      { withStatus: 0, disabled: 0 },
      (t) => {
        const sec = document.querySelector('section[aria-label="Ports"]');
        if (sec && (sec.querySelector('[role="status"]')?.textContent ?? '') !== '') t.withStatus++;
        const add = Array.from(sec?.querySelectorAll('button') ?? []).find((b) => b.textContent === '+ Add output');
        if (add?.disabled) t.disabled++;
      },
    );
    await addButton(page).click();
    await expectOneNewFrame(page, h, 0, CMD.AddPort);
    // The latch is in flight for FOLD_AFTER_MS of page time, frame by frame.
    await page.clock.runFor(FOLD_AFTER_MS);
    // The fold is delivered while page time stands still: the socket's message handler
    // decodes it at once (it counts in `stats().packetsApplied`), and the panel shows it
    // on the next frames, which are stepped one at a time and must all fall inside the
    // grace, or the test says so.
    const applied = (): Promise<number> => page.evaluate(() => window.__fabrico?.stats().packetsApplied ?? -1);
    const before = await applied();
    h.inject(buildPacket({ tick: 2, full: false, nodes: [FACTORY_TWO_OUT] }));
    await expect.poll(applied, { message: 'the page received the fold while its clock stood still' }).toBe(before + 1);
    const rows = portsSection(page).getByRole('listitem', { name: 'Output - Item' });
    let stepped = 0;
    while ((await rows.count()) !== 2) {
      expect(
        FOLD_AFTER_MS + stepped,
        'the fold shows on the panel inside the 400 ms grace, in page time',
      ).toBeLessThan(PORT_EDIT_PENDING_GRACE_MS);
      await page.clock.runFor(FRAME_MS);
      stepped += FRAME_MS;
    }
    await page.clock.resume();
    const rec = await waitForFrames<{ withStatus: number; disabled: number }>(page, '__j10');
    expect(rec.frames, `the sampler observed at least ${J10_FRAMES} frames`).toBeGreaterThanOrEqual(J10_FRAMES);
    expect(rec.elapsedMs, 'over the whole 1500 ms window').toBeGreaterThanOrEqual(1500);
    expect(rec.tallies.disabled, 'the button was latched for at least one frame, so the press really was in flight').toBeGreaterThan(0);
    expect(rec.tallies.withStatus, `no frame of ${rec.frames} over ${rec.elapsedMs} ms painted the pending status`).toBe(0);
    await expect(addButton(page)).toBeEnabled();
  });

  test('an unfolded port edit stays LATCHED and says it is waiting - it never accuses the host', async ({
    page,
  }) => {
    // CR-01 (iteration 2). This test used to assert the opposite: that after
    // 1000ms the panel released the latch and raised "Could not add an output -
    // no room to grow the machine here." Elapsed time is not evidence of a
    // rejection. `SimLoop::step` skips `acquire_input()` in RunState::Frozen and
    // HOLDS input in RunState::Draining (sim_loop.rs:1520-1589), and the gesture
    // channel is unbounded - so a paused sim buffers the edit indefinitely and
    // folds it on Resume. The old behaviour told the user it had failed, and the
    // obvious response (click again) queued the duplicate the latch exists to
    // prevent.
    //
    // The mock host folds NOTHING ever, which is exactly the "held indefinitely"
    // case. The panel must stay latched, say what it actually knows, and emit
    // nothing further however long it waits or how hard it is clicked.
    const h = await selectMachine(page, {
      node: FACTORY,
      body: FACTORY_BODY,
      config: FACTORY_CONFIG,
      heading: 'Factory',
    });

    await addButton(page).click();
    await expectOneNewFrame(page, h, 0, CMD.AddPort);

    // A STATUS, not an alert: nothing has gone wrong, and the panel has no
    // channel that could tell it otherwise.
    await expect(portsSection(page).getByRole('status')).toHaveText(
      'Waiting for the host to apply this change.',
    );
    await expect(page.getByRole('alert'), 'an unfolded edit is not an error').toHaveCount(0);

    // Well past the 1000ms the old self-heal used: the latch is DURABLE.
    await page.waitForTimeout(1400);
    await expect(addButton(page), 'the latch does not release on elapsed time').toBeDisabled();
    await expect(removeButton(page, 1)).toBeDisabled();
    await expect(page.getByRole('alert')).toHaveCount(0);

    // ...and clicking again emits nothing. Note what this does and does not
    // prove: a natively `disabled` button swallows a real pointer click before
    // React ever sees it, so this pins the VISIBLE half of the latch. The send
    // guard underneath it (which is what covers a render that has not landed
    // between two clicks, and any non-pointer dispatch path) is pinned directly
    // in `portEditLatch.test.ts`.
    await addButton(page).click({ force: true });
    await page.waitForTimeout(150);
    expect(h.sent.length, 'a latched Add emits nothing, however it is clicked').toBe(1);
  });

  test('the latch RELEASES on the host fold, and the next edit is then allowed', async ({
    page,
  }) => {
    // WR-05: the success path, which had no coverage at any level - both existing
    // latch tests ran against a host that folds nothing, so "released too early"
    // and "never releases" were indistinguishable from "works".
    //
    // The release condition is causal, not timed: an observed topology change is
    // exactly the event that makes the next index we would send fresh. Injecting
    // the post-AddPort packet IS that fold.
    const h = await selectMachine(page, {
      node: FACTORY,
      body: FACTORY_BODY,
      config: FACTORY_CONFIG,
      heading: 'Factory',
    });

    await addButton(page).click();
    await expectOneNewFrame(page, h, 0, CMD.AddPort);
    await expect(addButton(page), 'latched while unacknowledged').toBeDisabled();

    // The host folds: the same node comes back with the appended Out. A DIFF
    // packet (`full: false`), because that is what an AddPort echo really is -
    // a keyframe would clear the ephemeral selection and unmount the panel,
    // which is a different story than the one this test is about.
    h.inject(buildPacket({ tick: 2, full: false, nodes: [FACTORY_TWO_OUT] }));
    await expect(
      portsSection(page).getByRole('listitem', { name: 'Output - Item' }),
      'the folded add reaches the panel',
    ).toHaveCount(2);

    // The latch opens, the waiting status clears, and nothing was ever accused.
    await expect(addButton(page), 'the observed fold released the latch').toBeEnabled();
    await expect(portsSection(page).getByRole('status')).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(removeButton(page, 1)).toBeEnabled();
    await expect(removeButton(page, 2)).toBeEnabled();

    // ...and a SECOND edit is accepted, addressed against the NEW topology.
    await removeButton(page, 2).click();
    const cmd = decodeRemovePort(await expectOneNewFrame(page, h, 1, CMD.RemovePort));
    // Out ORDINAL 1 is PACKET index 3, not 2: `fold_add_port` pushes, so the
    // hand-added Out sits after the seeded Fault. This is the assertion that
    // makes the fixture's packet order load-bearing rather than decorative.
    expect(cmd.index, 'the second edit carries the appended Out packet index').toBe(3);
  });

  test('the latch SURVIVES a deselect/reselect - the remount does not hand out a second send (CR-01)', async ({
    page,
  }) => {
    // CR-01 (iteration 3), the regression that reopened the Critical. The latch
    // used to be a `useRef` inside ConfigPanel, and App mounts that as
    // `<ConfigPanel key={selectedNode} .../>` - so a deselect UNMOUNTED it and
    // threw away the in-flight record while the `RemovePort` was still sitting in
    // the host's unbounded gesture channel. The remounted panel then repainted
    // the PRE-fold indices with every control live and offered the identical
    // removal again.
    //
    // Three ordinary clicks reach it - "click away, click back, click x again" -
    // and on a paused host it is not even a retry reflex: with the latch durable,
    // deselect/reselect is the ONLY way the panel will accept a second port edit
    // at all, so the documented workaround for the liveness limit WAS the
    // stranding path. On a `[In@0, Out@1, Fault@2, Out@3]` Factory the second
    // `RemovePort{index:1}` splices the FAULT port, and `fold_remove_port` never
    // touches `links` - a belt left docked to a port that no longer exists, in
    // the certified edit log.
    //
    // The mock host folds nothing, which is exactly the window this lives in.
    const h = await selectMachine(page, {
      node: FACTORY_TWO_OUT,
      body: FACTORY_BODY,
      config: FACTORY_CONFIG,
      heading: 'Factory',
    });

    await removeButton(page, 1).click();
    await expectOneNewFrame(page, h, 0, CMD.RemovePort);
    await expect(removeButton(page, 1), 'latched on the send').toBeDisabled();

    // DESELECT. Blur first - the app-wide LW-02 accelerator guard stands Escape
    // down while a BUTTON holds focus, so this models the ordinary "click
    // elsewhere, then press Escape" flow rather than a synthetic key event.
    await page.getByRole('heading', { name: 'Outputs' }).click();
    await page.keyboard.press('Escape');
    await expect(
      page.getByRole('heading', { name: 'Factory' }),
      'the panel really did unmount (this test is worthless if it did not)',
    ).toBeHidden({ timeout: 10_000 });

    // RESELECT - a genuinely fresh ConfigPanel instance, re-pulling machine_config.
    const at = await screenCellCentre(page, FACTORY_BODY[0], FACTORY_BODY[1]);
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    await page.mouse.up();
    await expect(page.getByRole('heading', { name: 'Factory' })).toBeVisible({ timeout: 10_000 });

    // The port list is unchanged (nothing folded), so the latch must still be
    // closed: the controls stay dead and the panel still says it is waiting.
    await expect(
      removeButton(page, 1),
      'the latch outlived the panel that opened it',
    ).toBeDisabled();
    await expect(removeButton(page, 2)).toBeDisabled();
    await expect(addButton(page)).toBeDisabled();
    await expect(portsSection(page).getByRole('status')).toHaveText(
      'Waiting for the host to apply this change.',
    );

    // ...and the third click of the sequence emits nothing at all.
    await removeButton(page, 1).click({ force: true });
    await page.waitForTimeout(200);
    expect(h.sent.length, 'deselect/reselect must not grant a second send slot').toBe(1);
  });

  test('a never-folded edit offers [Try again], and only THEN is a second edit allowed (WR-01)', async ({
    page,
  }) => {
    // WR-01, which had to land with CR-01 or the hoist would have made things
    // worse. `observePorts` releases on an observed fold and on nothing else, and
    // there are reachable cases with no fold at all: `AddPort` returns
    // `OutOfBounds` / `FootprintCollision` when the grown min-rect leaves the grid
    // or collides (command.rs:825-846) - which a Factory reaches on its 4th Out at
    // a grid edge or on a packed board - plus the `UnknownNode` / `Malformed`
    // arms. Before the hoist, deselecting cleared the dead end. After it, nothing
    // would have.
    //
    // The wait is bounded in SIMULATED ticks, which is the one clock that carries
    // information: it is packet-derived, so it cannot advance while we are blind
    // to a fold, and it does not advance at all while the host is paused.
    const h = await selectMachine(page, {
      node: FACTORY,
      body: FACTORY_BODY,
      config: FACTORY_CONFIG,
      heading: 'Factory',
    });

    await addButton(page).click();
    await expectOneNewFrame(page, h, 0, CMD.AddPort);
    await expect(portsSection(page).getByRole('status')).toHaveText(
      'Waiting for the host to apply this change.',
    );
    await expect(
      portsSection(page).getByRole('button', { name: 'Try again' }),
      'no escape while the wait is still ordinary',
    ).toHaveCount(0);

    // The sim runs on past the threshold and our fold never arrives: a DIFF
    // packet that advances the tick and changes NO port topology. This is the
    // shape of a rejected AddPort exactly.
    h.inject(buildPacket({ tick: 400, full: false }));

    const retry = portsSection(page).getByRole('button', { name: 'Try again' });
    await expect(retry, 'the panel stops promising and offers a way out').toBeVisible();
    await expect(portsSection(page).getByRole('status')).toHaveText(
      'The host has not applied this yet.',
    );
    // It is still not an error, and it is still not a release: the destructive
    // controls stay dead until the user explicitly acts.
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(addButton(page), 'elapsed sim time does not re-arm the control').toBeDisabled();
    await expect(removeButton(page, 1)).toBeDisabled();
    expect(h.sent.length, 'nothing is re-sent behind the user').toBe(1);

    // THE ESCAPE. One explicit press clears the latch - it re-sends nothing.
    await retry.click();
    await expect(addButton(page), 'the group is usable again').toBeEnabled();
    await expect(portsSection(page).getByRole('status')).toHaveCount(0);
    expect(h.sent.length, '[Try again] clears the latch, it does not re-send').toBe(1);

    // ...and now a second edit is accepted, as the user's own deliberate act
    // against the topology they can see.
    await addButton(page).click();
    await expectOneNewFrame(page, h, 1, CMD.AddPort);
  });

  // -------------------------------------------------------------------------
  // Plan 74.1-28 (re-walk G1): A REFUSAL THAT NAMES THE LATCHED EDIT ENDS THE WAIT.
  //
  // On the walk the fourth output was refused (`GrowCoversBelt`, correct), and then the
  // panel said "Waiting for the host to apply this change." at 0.4 to 0.6 s and "The host
  // has not applied this yet." with [Try again] from about 0.73 s, `+ Add output` and the
  // Disconnect buttons greyed for 20 s and more. The latch could not tell which refusal
  // was its own. The host's refusal frame now names the refused command and its node, and
  // a refusal naming the latched node's port edit is proof the edit will never fold.
  // -------------------------------------------------------------------------

  /**
   * Install a per-frame sampler over the Ports section that covers `ms` from now AND
   * observes G1_FRAMES frames (plan 84-08, see `support/frameSampler.ts`).
   *
   * It used to stop at `ms` and the spec then asserted more than 20 frames. The
   * 2026-10-09 CI run's two-CPU runner drew 13 and 11 frames in the 2000 ms, so that floor
   * measured the machine's frame rate; plan 84-08 reproduced it on two cores at a 100%
   * CPU quota (10 and 16). Now the window is still the 2000 ms the refusal and the
   * 400 ms grace sit inside, and the sampler runs on until the frames are in.
   */
  async function sampleStatus(page: Page, ms: number): Promise<void> {
    await startFrameSampler(
      page,
      '__g1',
      { minMs: ms, frames: G1_FRAMES },
      { withStatus: 0, statusSeen: '' },
      (t) => {
        const sec = document.querySelector('section[aria-label="Ports"]');
        const text = Array.from(sec?.querySelectorAll('[role="status"]') ?? [])
          .map((el) => el.textContent ?? '')
          .join('|');
        if (text !== '') {
          t.withStatus++;
          t.statusSeen = text;
        }
      },
    );
  }

  async function sampled(
    page: Page,
  ): Promise<{ frames: number; elapsedMs: number; withStatus: number; statusSeen: string }> {
    const s = await waitForFrames<{ withStatus: number; statusSeen: string }>(page, '__g1');
    return { frames: s.frames, elapsedMs: s.elapsedMs, ...s.tallies };
  }

  /** Every Disconnect control in the Ports section is enabled. */
  async function expectDisconnectsEnabled(page: Page, why: string): Promise<void> {
    const ds = portsSection(page).getByRole('button', { name: /^Disconnect/ });
    // A RETRYING read (plan 84-08). `ds.count()` read once could run before the panel had
    // drawn its docked rows: one run in five of this test failed that way, unthrottled, at
    // 'before the press'. The claim is unchanged: a fixture with no docked rows still
    // fails here, by this message.
    await expect
      .poll(() => ds.count(), { message: 'the fixture carries docked rows, so the Disconnect half is not vacuous' })
      .toBeGreaterThan(0);
    const n = await ds.count();
    for (let i = 0; i < n; i++) await expect(ds.nth(i), `${why}: Disconnect ${i + 1}`).toBeEnabled();
  }

  const GROW_COVERS_BELT_COPY = 'Growing would cover a belt. Move that belt first.';
  const PENDING_COPY = 'Waiting for the host to apply this change.';

  test('a refused add that NAMES this node ends the wait: only the refusal shows, every control is usable (G1)', async ({
    page,
  }) => {
    // The mock host refuses every AddPort with `GrowCoversBelt`, its frame naming the
    // command and the node off the frame exactly as `transport_ws::refusal_frame` does.
    const h = await selectMachine(page, {
      node: FACTORY_THREE_OUT,
      body: FACTORY_BODY,
      config: FACTORY_CONFIG,
      heading: 'Factory',
      belts: [FAULT_BELT, outBelt(0, [13, 9])],
      answerGesture: (frame) => (frame[0] === CMD.AddPort ? 'GrowCoversBelt' : undefined),
    });
    await expectDisconnectsEnabled(page, 'before the press');

    for (const press of [1, 2]) {
      await sampleStatus(page, 2000);
      await addButton(page).click();
      await expectOneNewFrame(page, h, press - 1, CMD.AddPort);
      await expect(page.locator('#fab-refusal'), `press ${press}: the refusal is said`).toHaveText(
        GROW_COVERS_BELT_COPY,
      );
      const s = await sampled(page);
      expect(s.frames, `press ${press}: the sampler observed at least ${G1_FRAMES} frames`).toBeGreaterThanOrEqual(
        G1_FRAMES,
      );
      expect(s.elapsedMs, `press ${press}: over the whole 2 s window`).toBeGreaterThanOrEqual(2000);
      expect(
        s.withStatus,
        `press ${press}: no Ports status text on any of ${s.frames} frames over ${s.elapsedMs} ms (saw "${s.statusSeen}")`,
      ).toBe(0);
      await expect(addButton(page), `press ${press}: + Add output is usable again`).toBeEnabled();
      await expectDisconnectsEnabled(page, `press ${press}: after the refusal`);
      await expect(portsSection(page).getByRole('button', { name: 'Try again' })).toHaveCount(0);
    }
    // The second press proves a REPEATED refusal (the same tag, which the display layer
    // re-arms without re-announcing) still releases: the release runs before that.
    expect(h.sent.length, 'each press sent exactly one AddPort and nothing was re-sent').toBe(2);
  });

  for (const [what, override] of [
    ['a DIFFERENT node', { tag: 'GrowCoversBelt', cmd: 'AddPort', node: 99 }],
    ['a command that is not a port edit', { tag: 'GrowCoversBelt', cmd: 'Rotate', node: 7 }],
    ['nothing (an undecodable frame)', { tag: 'GrowCoversBelt', cmd: null, node: null }],
  ] as const) {
    test(`a refusal naming ${what} leaves this node's latch in place (G1, T-74.1-97)`, async ({ page }) => {
      const h = await selectMachine(page, {
        node: FACTORY,
        body: FACTORY_BODY,
        config: FACTORY_CONFIG,
        heading: 'Factory',
        answerGesture: (frame) => (frame[0] === CMD.AddPort ? override : undefined),
      });
      await addButton(page).click();
      await expectOneNewFrame(page, h, 0, CMD.AddPort);
      await expect(page.locator('#fab-refusal'), 'the refusal itself is still said').toHaveText(GROW_COVERS_BELT_COPY);
      await expect(addButton(page), 'the latch holds').toBeDisabled();
      await expect(portsSection(page).getByRole('status'), 'and the panel still waits').toHaveText(PENDING_COPY);
      await addButton(page).click({ force: true });
      await page.waitForTimeout(150);
      expect(h.sent.length, 'no second AddPort').toBe(1);
    });
  }

  test('an Add is ONE host action: Ctrl+Z emits exactly one Undo frame', async ({ page }) => {
    // canUndo seeds the session-availability flag App gates the undo on.
    const h = await selectMachine(page, {
      node: FACTORY,
      body: FACTORY_BODY,
      config: FACTORY_CONFIG,
      heading: 'Factory',
      canUndo: true,
    });

    await addButton(page).click();
    await expectOneNewFrame(page, h, 0, CMD.AddPort);

    // Move focus off the button first: the app-wide LW-02 accelerator guard
    // stands the canvas keybindings down while a BUTTON/INPUT holds focus (only
    // the file accelerators are exempt), so a Ctrl+Z fired straight into the
    // just-clicked control is by design a no-op. Clicking the section's own
    // header is a plain user click on a non-focusable element - the panel eats
    // it (pointerEvents:auto), so the selection survives.
    await page.getByRole('heading', { name: 'Outputs' }).click();
    await page.keyboard.press('Control+z');

    // ONE Undo command - the whole AddPort reverses in a single step, with no
    // frontend batching and no second frame.
    await expectOneNewFrame(page, h, 1, CMD.Undo);
  });
});
