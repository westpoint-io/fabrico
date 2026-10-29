import { test, expect, type Page } from '@playwright/test';
import {
  CMD,
  GESTURE_ACCEPTED,
  buildPacket,
  expectExactlyOneFrame,
  mockRenderSocket,
  screenCellCentre,
  waitForChrome,
  type InjectBelt,
} from './support/wire';

// belt-repeat-dock-refusal.spec.ts (74-06, LINK-06) - browser-level proof that when the
// host refuses a repeat drop, the user READS the sentence that names the rule and tells
// them what to do about it.
//
// THE SYMPTOM THIS CLOSES. Until this phase the `Dock` validate arm had no occupancy
// guard at all: a second drop onto an already-connected output returned `Ok`, replaced
// the link, and the connection the user drew was gone with nothing on screen (WINDOWS
// 128). `crates/fabrico-command/tests/dock_occupancy.rs` pins the refusal itself. This
// spec pins the other half, the half no Rust test can see: that the refusal REACHES the
// screen, on the shipped surface, as the shipped sentence.
//
// THE TAG MOVED IN PLAN 74.1-32 (the third re-walk's HEAD-WORDS). Until then the host
// answered this drop `PortOccupied`, and the user read "That output is already connected.
// Disconnect it first." for a belt end they had dragged. A drop whose taken source is a
// belt's end now answers `BeltEndTaken`, which `RefusalMessage.tsx` maps to "That belt end
// is already joined. Use a free end.", and this spec asserts that exact string. A machine
// output keeps `PortOccupied` (`dock_occupancy.rs`,
// `a_tail_dock_onto_a_machine_out_already_linked_keeps_port_occupied`).
//
// WHAT WOULD MAKE THIS A CHECK THAT CANNOT FAIL, and how each is closed:
//
//   1. `toContainText` would stay green on a build that rendered a longer or a
//      differently-worded sentence, which is exactly the drift the 50-character copy
//      budget in `RefusalMessage.tsx` exists to prevent. The assertion is EXACT string
//      equality, so a single word changing on either side reddens it.
//   2. Asserting the sentence alone would stay green on a build that painted a message
//      OPTIMISTICALLY on every Dock, without any host verdict. The CONTROL case drives
//      the identical gesture with the mock ACCEPTING it - which sends nothing at all on
//      this wire, exactly as the host does (D-30) - and asserts the region stays empty.
//      That pair is what makes the sentence attributable to the refusal frame.
//   3. Asserting only that a Dock appeared would stay green on a build that emitted
//      three. The frame is COUNTED by kind and all four of its fields are decoded.
//
// THE HOLD IS NOT RE-TESTED HERE. `REFUSAL_HOLD_MS` and the live-region semantics are
// pinned by `gesture-verdict.spec.ts` (rows V9 and V3), on the same surface. Re-asserting
// them here would be a second copy of a property that already has an owner.
//
// NO PIXEL ASSERTION, for the reason 74-UI-SPEC 1.4 gives: no pixel-guard fixture holds a
// drag in flight, and D-07 leaves the resting board unchanged.

/** The refusal live region's always-mounted wrapper (`RefusalMessage.tsx`). */
const REFUSAL = '#fab-refusal';

/**
 * The sentence `BeltEndTaken` maps to, MIRRORED from `REFUSAL_COPY` rather than imported.
 *
 * Mirrored deliberately, on `gesture-verdict.spec.ts`'s own precedent: importing the copy
 * would make this spec assert that a string equals itself, which is green against every
 * possible wording. The mirror is what makes an edit to the shipped sentence show up
 * here as a red diff naming both versions.
 */
const BELT_END_TAKEN_SENTENCE = 'That belt end is already joined. Use a free end.';

// ---------------------------------------------------------------------------
// Fixture geometry. Two ABUTTING belts on row 9, both running EAST.
//
//   UP:   (10,9) -> (13,9). Its HEAD is (13,9), outward E.
//   DOWN: (14,9) -> (17,9). Its TAIL is (14,9), outward W.
//
// The board carries NO MACHINE. The shipped auto-dock arms a Head dock when a plain
// release faces exactly one accepting In port, so a machine here would let a Dock frame
// appear without the belt-end path being involved at all.
//
// WHY `up` IS DRAWN UNCONNECTED, which is a MEASUREMENT and not a convenience. The first
// draft of this spec injected `up` already carrying `docks: [{end:'Head', node:4,
// port:0}]`, on the reasoning that a repeat drop should start from a connected end. It
// emitted NO Dock frame at all, twice, on both cases: a belt end that is already docked
// carries no grab handle, so there is nothing there to drag.
//
// That is the right client behaviour and it locates this spec correctly. The repeat drop
// a user actually makes is one where the CLIENT believes the end is free and the HOST
// knows better - the client holds a packet, not the authority, and occupancy is decided
// in `validate_normalize`. So the division of labour is: `dock_occupancy.rs` proves the
// host refuses, and this spec proves the refusal reaches the screen intact. Neither
// half can see the other's.
// ---------------------------------------------------------------------------

const UP_TILES: [number, number][] = [
  [10, 9],
  [11, 9],
  [12, 9],
  [13, 9],
];
const DOWN_TILES: [number, number][] = [
  [14, 9],
  [15, 9],
  [16, 9],
  [17, 9],
];

/** A belt's Tail catalog port index: `Role::In`, declared FIRST (74-02). */
const BELT_PORT_TAIL = 0;

const DOWN: InjectBelt = { id: 4, tiles: DOWN_TILES };
const UP: InjectBelt = { id: 3, tiles: UP_TILES };

/** How many frames of each `GridCommand` discriminant the page has emitted. */
function frameCounts(sent: Buffer[]): Record<number, number> {
  const counts: Record<number, number> = {};
  for (const f of sent) {
    counts[f[0]] = (counts[f[0]] ?? 0) + 1;
  }
  return counts;
}

/** The belt ids the page's own oracle reports, ascending. */
async function beltIds(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const hook = window.__fabrico;
    if (!hook) {
      throw new Error('window.__fabrico not installed');
    }
    const scene = hook.scene() as { belts: Array<{ id: number }> };
    return scene.belts.map((b) => b.id).sort((a, b) => a - b);
  });
}

/** Click one of `up`'s tiles to select it, then drag its Head handle onto `down`'s Tail. */
async function repeatDrop(page: Page): Promise<void> {
  const tile = await screenCellCentre(page, 11, 9);
  await page.mouse.move(tile.x, tile.y);
  await page.mouse.down();
  await page.mouse.up();

  const head = await screenCellCentre(page, 13, 9);
  const tail = await screenCellCentre(page, 14, 9);
  await page.mouse.move(head.x, head.y);
  await page.mouse.down();
  await page.mouse.move(tail.x, tail.y, { steps: 4 });
  await page.mouse.up();
}

test.describe('LINK-06: a repeat drop is refused in a sentence the user reads', () => {
  test('the host refusing a Dock with BeltEndTaken shows exactly the shipped sentence', async ({
    page,
  }) => {
    const h = await mockRenderSocket(page, {
      // The host's answer to THIS gesture. Every other frame is accepted, so the
      // sentence below can only have come from the Dock's verdict.
      // Since plan 74.1-32 a belt end that is already joined is `BeltEndTaken`.
      answerGesture: (frame) => (frame[0] === CMD.Dock ? 'BeltEndTaken' : GESTURE_ACCEPTED),
    });
    await page.goto('/');
    await waitForChrome(page);
    await h.connected;

    h.inject(buildPacket({ belts: [UP, DOWN] }));
    await expect.poll(() => beltIds(page)).toEqual([3, 4]);

    // The region is EMPTY before the gesture. Without this the sentence assertion below
    // could be satisfied by a message left over from boot.
    await expect(page.locator(REFUSAL), 'nothing is on the refusal surface yet').toHaveText(
      '',
    );

    await repeatDrop(page);

    // THE COUNT BY KIND, not the presence of a frame.
    await expectExactlyOneFrame(page, h, CMD.Dock);
    expect(frameCounts(h.sent), 'one Dock and no other command of any kind').toEqual({
      [CMD.Dock]: 1,
    });
    // ALL FOUR FIELDS, so a wrong-end or wrong-target drop cannot pass as this one.
    //   Dock wire = [disc=4, belt, end (Head=0/Tail=1), node, port]
    expect(
      Array.from(h.sent[0]),
      'Dock{belt:3, end:Head, node:4 (a BELT), port:0 (its Tail)}',
    ).toEqual([CMD.Dock, 3, 0, 4, BELT_PORT_TAIL]);

    // THE HEADLINE: the exact shipped sentence, by string equality and never a substring.
    await expect(
      page.locator(REFUSAL),
      'the user reads the BeltEndTaken sentence, verbatim',
    ).toHaveText(BELT_END_TAKEN_SENTENCE);
  });

  test('CONTROL: the identical gesture ACCEPTED leaves the refusal surface empty', async ({
    page,
  }) => {
    // The half that makes the case above attributable. On this transport an accepted
    // gesture produces NO FRAME AT ALL, so an implementation that painted the sentence
    // from its own client-side prediction rather than from a host verdict would have
    // text on screen here with nothing having arrived, and this case would be red.
    const h = await mockRenderSocket(page, {
      answerGesture: () => GESTURE_ACCEPTED,
    });
    await page.goto('/');
    await waitForChrome(page);
    await h.connected;

    h.inject(buildPacket({ belts: [UP, DOWN] }));
    await expect.poll(() => beltIds(page)).toEqual([3, 4]);

    await repeatDrop(page);
    await expectExactlyOneFrame(page, h, CMD.Dock);

    // Settle past anything a late frame could still deliver, then assert the silence.
    await page.waitForTimeout(500);
    await expect(
      page.locator(REFUSAL),
      'an accepted gesture says nothing at all',
    ).toHaveText('');
  });
});
