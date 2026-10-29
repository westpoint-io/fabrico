import { test, expect, type Page } from '@playwright/test';
import {
  CMD,
  buildPacket,
  expectExactlyOneFrame,
  mockRenderSocket,
  screenCellCentre,
  waitForChrome,
  type InjectBelt,
} from './support/wire';

// belt-join-handle-drag.spec.ts (74-05, LINK-02) - browser-level proof that a user
// can JOIN TWO BELT RUNS by dragging one belt's end handle onto another belt's end,
// through the production UI, asserted on the EMITTED BINARY FRAME and never on pixels.
//
// THE SYMPTOM THIS CLOSES. WINDOWS 140 records a manual walk making exactly this drag on the
// real binary and getting NO DOCK AND NO VISIBLE REFUSAL. Both halves had a cause: a
// belt end was not in `nubsInRadius` at all (so the release addressed nothing and, by
// the release-on-nothing rule, emitted nothing), and nothing on screen had ever told
// the user where a drop could land.
//
// WHAT WOULD MAKE THIS A CHECK THAT CANNOT FAIL, and how each is closed:
//
//   1. Asserting only that "a Dock appeared" would stay green on a build that emitted
//      three. The COUNT is asserted by kind, via `expectExactlyOneFrame`, which also
//      settles a window afterwards so a LATE duplicate cannot slip past a poll that
//      resolves the instant the count first reaches one.
//   2. Asserting only the discriminant would leave a wrong-END or wrong-TARGET join
//      green. All four decoded fields are asserted byte for byte.
//   3. Both control cases below - the ring-sourced flash and the handle-drag silence -
//      are asserted in the SAME spec as the feature, because they are the two shipped
//      behaviours the new hit-set entry is most able to break: the belt end now sits
//      in the hit set at the very point a cancel is released on.
//
// NO PIXEL ASSERTION, deliberately. No pixel-guard fixture holds a drag in flight, and
// D-07 means the resting board is unchanged, so a screenshot here would either be
// redundant or would mint a baseline nothing asked for.

// ---------------------------------------------------------------------------
// Fixture geometry. Two ABUTTING belts on row 9, both running EAST.
//
//   UP:   (10,9) -> (13,9). Its HEAD is (13,9), outward E.
//   DOWN: (14,9) -> (17,9). Its TAIL is (14,9), outward W.
//
// The two end tile centres are one CELL apart and their shared edge is the seam.
// `up`'s Head is `Role::Out` and `down`'s Tail is `Role::In`, which is the role
// pairing `command.rs`'s Dock arm requires of a Head (load) dock.
//
// D-05 KEEPS `ports` OFF `BeltView`, so neither hand-authored belt below carries one:
// a belt's spatial ports are DERIVED from its tiles by the same rule the host applies,
// on both sides of the wire. A fixture that invented a `ports` member would be
// encoding a field the protocol does not have.
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

const UP: InjectBelt = { id: 3, tiles: UP_TILES };
const DOWN: InjectBelt = { id: 4, tiles: DOWN_TILES };

/** A belt's Tail catalog port index: `Role::In`, declared FIRST (74-02). */
const BELT_PORT_TAIL = 0;

/** Click (press+release, no drag) at a screen point. */
async function clickAt(page: Page, x: number, y: number): Promise<void> {
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.up();
}

/** How many frames of each GridCommand discriminant the page has emitted. */
function frameCounts(sent: Buffer[]): Record<number, number> {
  const counts: Record<number, number> = {};
  for (const f of sent) {
    counts[f[0]] = (counts[f[0]] ?? 0) + 1;
  }
  return counts;
}

test.describe('LINK-02: a belt end handle joins two belt runs', () => {
  test('dragging the HEAD handle onto another belt TAIL emits EXACTLY ONE Dock naming that belt', async ({
    page,
  }) => {
    const h = await mockRenderSocket(page);
    await page.goto('/');
    await waitForChrome(page);
    await h.connected;

    h.inject(buildPacket({ belts: [UP, DOWN] }));
    await expect.poll(() => beltIds(page)).toEqual([3, 4]);

    // Select `up`: click one of its tiles. Belt selection paints the endpoint grab
    // handles and emits nothing.
    const tile = await screenCellCentre(page, 11, 9);
    await clickAt(page, tile.x, tile.y);
    expect(h.sent, 'selecting a belt emits no command').toHaveLength(0);

    // Grab `up`'s Head handle at its end tile centre and drag it onto `down`'s Tail
    // end. Before this phase the release addressed nothing at all, because no belt
    // end was in the hit set.
    const head = await screenCellCentre(page, 13, 9);
    const tail = await screenCellCentre(page, 14, 9);
    await page.mouse.move(head.x, head.y);
    await page.mouse.down();
    await page.mouse.move(tail.x, tail.y, { steps: 4 });
    await page.mouse.up();

    // THE COUNT BY KIND, not the presence of a frame.
    await expectExactlyOneFrame(page, h, CMD.Dock);
    expect(frameCounts(h.sent), 'one Dock and no other command of any kind').toEqual({
      [CMD.Dock]: 1,
    });

    // ALL FOUR FIELDS. `node` carries the TARGET BELT's dense handle - `command.rs`
    // resolves a belt handle exactly as it resolves a machine's - and `port` is the
    // target's TAIL catalog index, which is 0 because a belt declares `Role::In` first.
    //   Dock wire = [disc=4, belt, end (Head=0/Tail=1), node, port]
    expect(
      Array.from(h.sent[0]),
      'Dock{belt:3, end:Head, node:4 (a BELT), port:0 (its Tail)}',
    ).toEqual([CMD.Dock, 3, 0, 4, BELT_PORT_TAIL]);
  });

  test('CONTROL: a ring-sourced drag released on empty floor still FLASHES', async ({
    page,
  }) => {
    // The first of the two shipped controls the new hit-set entry could break. A
    // STRANDED-RING drag is a recovery attempt: the user aimed at something and
    // missed, so silence is the WINDOWS row 113 symptom and the flash is right. It is
    // asserted through the overlay's own recorded state, not through pixels.
    const h = await mockRenderSocket(page);
    await page.goto('/');
    await waitForChrome(page);
    await h.connected;

    // A belt DOCKED to a machine, then re-emitted WITHOUT the dock: the input
    // condition `detectStrandedDocks` fires on. The ring lands on the orphaned Tail.
    h.inject(
      buildPacket({
        nodes: [
          {
            id: 7,
            kind: 2,
            cell_x: 7,
            cell_y: 8,
            w: 3,
            h: 3,
            ports: [
              { index: 0, cell_x: 7, cell_y: 9, side: 3, role: 0 },
              { index: 1, cell_x: 9, cell_y: 9, side: 1, role: 1 },
              { index: 2, cell_x: 8, cell_y: 10, side: 2, role: 2 },
            ],
          },
        ],
        belts: [{ id: 3, tiles: UP_TILES, docks: [{ end: 'Tail', node: 7, port: 1 }] }],
      }),
    );
    await expect.poll(() => beltDockCount(page, 3)).toBe(1);
    h.inject(buildPacket({ tick: 2, full: false, belts: [{ id: 3, tiles: UP_TILES }] }));
    await expect.poll(() => beltDockCount(page, 3)).toBe(0);
    expect(h.sent, 'stranding emits no command of its own').toHaveLength(0);

    // Press the ring on the orphaned Tail (10,9) and release on EMPTY FLOOR, far from
    // every port and every belt end.
    const ring = await screenCellCentre(page, 10, 9);
    const empty = await screenCellCentre(page, 10, 2);
    await page.mouse.move(ring.x, ring.y);
    await page.mouse.down();
    await page.mouse.move(empty.x, empty.y, { steps: 4 });
    await page.mouse.up();

    // Nothing is emitted - there was no port to name - and the flash fires, which is
    // the honest WHERE with no invented reason.
    await page.waitForTimeout(150);
    expect(h.sent, 'a release on nothing addresses no port and emits nothing').toHaveLength(0);
    expect(
      await rejectFlashActive(page),
      'a ring-sourced near-miss says WHERE it landed rather than nothing at all',
    ).toBe(true);
  });

  test('CONTROL: a HANDLE drag released on empty floor emits nothing and does NOT flash', async ({
    page,
  }) => {
    // The second control, and it is the opposite verdict on the same shape. From a
    // SELECTED BELT's endpoint handle a release on nothing is the DOCUMENTED CANCEL
    // (`21-UI-SPEC.md:137`, "No command; handle snaps back") and it is that gesture's
    // only abort. Flashing at a user who deliberately backed out would be the app
    // arguing with an intent it was told. Phase 67 measured a regression here that the
    // whole 2012-case suite stayed green through, so it is pinned per provenance.
    const h = await mockRenderSocket(page);
    await page.goto('/');
    await waitForChrome(page);
    await h.connected;

    h.inject(buildPacket({ belts: [UP, DOWN] }));
    await expect.poll(() => beltIds(page)).toEqual([3, 4]);

    const tile = await screenCellCentre(page, 11, 9);
    await clickAt(page, tile.x, tile.y);

    const head = await screenCellCentre(page, 13, 9);
    const empty = await screenCellCentre(page, 13, 2);
    await page.mouse.move(head.x, head.y);
    await page.mouse.down();
    await page.mouse.move(empty.x, empty.y, { steps: 4 });
    await page.mouse.up();

    await page.waitForTimeout(150);
    expect(h.sent, 'the documented cancel emits nothing').toHaveLength(0);
    expect(
      await rejectFlashActive(page),
      'a deliberate cancel is not argued with',
    ).toBe(false);
  });
});

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

/** One belt's dock count, as the page's own oracle reports it. */
async function beltDockCount(page: Page, id: number): Promise<number> {
  return page.evaluate((beltId) => {
    const hook = window.__fabrico;
    if (!hook) {
      throw new Error('window.__fabrico not installed');
    }
    const scene = hook.scene() as { belts: Array<{ id: number; docks: unknown[] }> };
    return scene.belts.find((b) => b.id === beltId)?.docks.length ?? -1;
  }, id);
}

/**
 * Whether the overlay's reject-flash Graphics currently holds geometry.
 *
 * READ AS AN INSTRUCTION COUNT, NOT AS A CALL LATCH. This project shipped
 * `alertRingsPainted` as a latch on a non-null field in phase 73, so a build whose
 * ring drew NOTHING passed the entire user-visible claim. The flash is a rounded rect
 * plotted into its own Graphics, so its geometry instruction count is the honest
 * observable: zero means nothing was painted, whatever was called.
 */
async function rejectFlashActive(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const hook = window.__fabrico;
    if (!hook) {
      throw new Error('window.__fabrico not installed');
    }
    if (typeof hook.rejectFlashInstructions !== 'function') {
      throw new Error('window.__fabrico.rejectFlashInstructions() not installed');
    }
    return hook.rejectFlashInstructions() > 0;
  });
}
