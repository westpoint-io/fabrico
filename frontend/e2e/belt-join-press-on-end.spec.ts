import { test, expect, type Page } from '@playwright/test';
import {
  CMD,
  buildPacket,
  mockRenderSocket,
  screenCellCentre,
  waitForChrome,
  type InjectBelt,
  type InjectNode,
  waitForBoard,
} from './support/wire';

// belt-join-press-on-end.spec.ts (74-05, LINK-10) - browser-level proof of the PRIMARY
// join gesture in the manual walk: with the Belt tool armed, press on an existing belt's
// free end and draw a new run away from it. Asserted on the EMITTED BINARY FRAMES.
//
// WHY THIS NEEDED NO NEW GESTURE PATH, which is the claim the spec really pins. A belt
// is a ported node in the core from 74-02 on: its Head is `Role::Out`. The SHIPPED
// port-to-port start path serves this press unchanged - it records `startDock` on any
// Out or Fault port and the release emits it as the new belt's Tail. If a second path
// had been written for belts, the two would have started disagreeing, which is this
// repository's named failure class.
//
// PHASE 74.1 MOVED THE PRESS POINT, AND ONLY THE PRESS POINT. With the Belt tool armed a
// press now resolves BY CELL on the port's DOORSTEP (`gestures.ts` doorstepPressHit):
// for this belt's Head at (13,9), the floor cell (14,9) one past it, where its ring now
// sits. The draw seeds on that same cell, so the emitted bytes below did not move. A
// press on the end tile (13,9) itself is now an ordinary press on an occupied tile.
//
// WHAT WOULD MAKE THIS A CHECK THAT CANNOT FAIL, and how each is closed:
//
//   1. "A Dock appeared" would pass on a build that emitted three, and "a DrawBelt
//      appeared" on one that emitted two. Every frame is COUNTED BY KIND against a
//      named number, never merely found.
//   2. A board with a machine on it would let the shipped auto-dock produce a Dock all
//      by itself and the spec would pass with the belt-end admission deleted. The first
//      board below therefore holds NO MACHINE AT ALL, so the only thing a Dock can name
//      is the belt - and the assertion states that in the negative too.
//   3. The ROLE edge is the other half of the claim and gets its own case: a press on
//      the same belt's TAIL is `Role::In`, falls through to the plain cell seed, and
//      emits no Dock. Without it, an implementation that docked on ANY belt end press
//      would pass everything above.
//
//   4. EVERY MOVE THIS SPEC MAKES TELEPORTS A WHOLE CELL (the case below presses the
//      head's doorstep centre and goes straight to the next cell centres), so it
//      cannot see the first sample a real mouse emits: the one still INSIDE the tile the
//      press landed in. That sample appended the pressed belt's own tile backwards and
//      killed the draw, and this spec passed throughout. Measured on the real host
//      2026-09-09 and fixed by plan 74-13. The gap is now covered by
//      `src/input/gestures.test.ts` ("a sub-cell sample inside the pressed tile does not
//      break the draw") and by `e2e-live/74-belt-join-press-on-end.live.spec.ts` ("THE
//      GESTURE AS A HAND DRIVES IT"), whose teleporting twin is this spec's live
//      counterpart. This spec is deliberately UNCHANGED otherwise: its value is that the
//      teleporting path's emitted bytes did not move, which is the frame-level half of
//      that discriminator. Its green has never meant the gesture works for a hand and
//      this entry exists so no later reader reads it that way.
//
// No pixel assertion, for the reason 74-UI-SPEC 1.4 gives: D-07 means the resting board
// is unchanged, and no pixel-guard fixture holds a draw in flight.

// ---------------------------------------------------------------------------
// Fixture geometry. ONE belt running EAST, (10,9) -> (13,9), free at both ends.
// Its HEAD is (13,9) with outward E, so its doorstep - the cell a Belt-armed press
// resolves on and seeds at since 74.1 - is (14,9). Its TAIL is (10,9) with outward W.
//
// D-05 keeps `ports` off `BeltView`, so the hand-authored belt carries none: a belt's
// spatial ports are DERIVED from its tiles by the same rule on both sides of the wire.
// ---------------------------------------------------------------------------

const TILES: [number, number][] = [
  [10, 9],
  [11, 9],
  [12, 9],
  [13, 9],
];
const BELT: InjectBelt = { id: 3, tiles: TILES };

/** A belt's Head catalog port index: `Role::Out`, declared SECOND (74-02). */
const BELT_PORT_HEAD = 1;

/** A SINK (kind 7, 1x1) at (18,9): its In sits on its own cell and faces W. */
const SINK: InjectNode = {
  id: 8,
  kind: 7,
  cell_x: 18,
  cell_y: 9,
  ports: [{ index: 0, cell_x: 18, cell_y: 9, side: 3, role: 0 }],
};

/** How many frames of each GridCommand discriminant the page has emitted. */
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

/**
 * Arm the Belt tool. Prefix-matched, not exact: the tool's title is user-facing COPY
 * that doubles as a SELECTOR, so an exact match makes every copy edit a multi-spec
 * breakage (52-05). `Draw belts` stays unique in the palette.
 */
async function armBelt(page: Page): Promise<void> {
  await page.getByTitle(/^Draw belts/).click();
}

test.describe('LINK-10: the Belt tool draws a new run off an existing belt end', () => {
  test('pressing a free HEAD draws a belt AND docks its Tail to the pressed belt, once each', async ({
    page,
  }) => {
    // Plan 88-06 (D-06): the host accepts the DrawBelt naming the belt it minted (9), and the
    // Dock waits for that accept and a packet holding belt 9.
    const h = await mockRenderSocket(page, {
      answerGesture: (frame) => (frame[0] === CMD.DrawBelt ? { accept: [9] } : undefined),
    });
    await page.goto('/');
    await waitForChrome(page);
    await h.connected;

    // NO MACHINE ON THIS BOARD. The shipped auto-dock arms a Head dock when a plain
    // release faces exactly one accepting In port; with no machine present there is
    // nothing for it to find, so any Dock this gesture produces can only be the belt
    // one. That is what makes the assertions below non-vacuous.
    h.inject(buildPacket({ belts: [BELT] }));
    await expect.poll(() => beltIds(page)).toEqual([3]);

    await armBelt(page);

    // Press the belt Head's DOORSTEP (14,9), the floor cell one past its end tile (13,9)
    // and the Belt-armed press target since 74.1. The draw seeds on that cell - the
    // same seeding a machine Out press gets - and records `startDock` naming the BELT.
    const door = await screenCellCentre(page, 14, 9);
    await page.mouse.move(door.x, door.y);
    await page.mouse.down();
    for (const cx of [15, 16]) {
      const p = await screenCellCentre(page, cx, 9);
      await page.mouse.move(p.x, p.y);
    }
    await page.mouse.up();

    // Exactly ONE DrawBelt, and nothing else yet: the follow-up Dock cannot ride the
    // same handler, because the new belt has no handle until the host echoes it.
    await expect.poll(() => h.sent.length).toBe(1);
    expect(frameCounts(h.sent), 'one DrawBelt and no Dock before the echo').toEqual({
      [CMD.DrawBelt]: 1,
    });
    expect(h.sent[0][0], 'the first frame is a DrawBelt').toBe(CMD.DrawBelt);

    // Inject the host echo of the minted belt as a DIFF: the packet for the tick that folded
    // the DrawBelt, which holds the belt its accept named.
    h.inject(
      buildPacket({
        full: false,
        tick: 2,
        belts: [
          {
            id: 9,
            tiles: [
              [14, 9],
              [15, 9],
              [16, 9],
            ],
          },
        ],
      }),
    );

    // EXACTLY ONE Dock follows, and no second DrawBelt.
    await expect.poll(() => h.sent.length).toBe(2);
    await page.waitForTimeout(150);
    expect(frameCounts(h.sent), 'one DrawBelt and exactly one Dock, no late duplicate').toEqual({
      [CMD.DrawBelt]: 1,
      [CMD.Dock]: 1,
    });

    // ALL FOUR FIELDS. The new belt's TAIL joins the PRESSED BELT's Head, which is
    // catalog index 1 because a belt declares `Role::In` first and `Role::Out` second.
    //   Dock wire = [disc=4, belt, end (Head=0/Tail=1), node, port]
    expect(
      Array.from(h.sent[1]),
      'Dock{belt:9 (the new run), end:Tail, node:3 (a BELT), port:1 (its Head)}',
    ).toEqual([CMD.Dock, 9, 1, 3, BELT_PORT_HEAD]);

    // AND NO DOCK NAMING A MACHINE, stated in the negative as well as the positive.
    // There is no machine on this board, so the only handle a Dock could carry is 3.
    for (const frame of h.sent.filter((f) => f[0] === CMD.Dock)) {
      expect(frame[3], 'every Dock names the belt, never a machine handle').toBe(3);
    }
  });

  test('a press on the TAIL falls through to the plain cell seed and emits NO Dock', async ({
    page,
  }) => {
    // THE ROLE EDGE. A Tail is `Role::In`, and an In press cannot be a belt SOURCE -
    // the shipped rule, applied to a belt end for the first time. It seeds at the
    // PRESSED CELL rather than at a facing cell and records no dock at all.
    //
    // A SINK IS ON THIS BOARD ON PURPOSE, and it is what makes the case bite rather
    // than merely observe silence: the drawn run ends facing the Sink's In, so the
    // shipped auto-dock arms ITS Head dock. The gesture therefore emits a DrawBelt and
    // exactly ONE Dock, and that one Dock names the SINK. A build that wrongly docked
    // on a Tail press would emit TWO, which the count catches.
    //
    // Plan 88-06 (D-06): every DrawBelt is accepted naming the belt the host minted, the one
    // the packet below shows for its cells: the wrong seed's run, from (9,9), as 10, and the
    // positive half's, from (15,9), as 11. A DrawBelt body is `[3, cell count, x, y, ...]` with
    // each coordinate zigzag-encoded, so a non-negative x of one byte reads as `frame[2] / 2`.
    const h = await mockRenderSocket(page, {
      answerGesture: (frame) =>
        frame[0] === CMD.DrawBelt ? { accept: [frame[2] / 2 === 15 ? 11 : 10] } : undefined,
    });
    await page.goto('/');
    await waitForChrome(page);
    await h.connected;

    h.inject(buildPacket({ nodes: [SINK], belts: [BELT] }));
    await waitForBoard(page, { machines: 1 });
    await expect.poll(() => beltIds(page)).toEqual([3]);

    await armBelt(page);

    // Press the belt's TAIL at (10,9) and draw WEST, away from the belt.
    //
    // THE TWO SEEDS DIVERGE HERE, AND THAT IS THE WHOLE CASE. Correct behaviour seeds
    // at the PRESSED CELL (10,9) - which is the belt's own tile, so the drawn path is
    // occupied and illegal. Since plan 89-09 (D-13, FAIL-02) an illegal release is still
    // SENT, as ONE DrawBelt from (10,9) with no follow-up, so the host refuses it in words;
    // until then nothing was emitted. A build that wrongly treated the In-role Tail as a
    // belt SOURCE would seed at the facing cell (9,9) instead, draw a perfectly legal
    // two-cell run, and emit a DrawBelt from (9,9) plus a Dock. So this asserts ONE
    // DrawBelt from the pressed cell and no Dock against an alternative that produces two.
    //
    // The first draft of this case pressed and released without moving AND without
    // injecting an echo, so the follow-up Dock could never have fired for ANY
    // implementation - it survived exactly the mutation it was written to catch.
    const tail = await screenCellCentre(page, 10, 9);
    await page.mouse.move(tail.x, tail.y);
    await page.mouse.down();
    for (const cx of [9, 8]) {
      const p = await screenCellCentre(page, cx, 9);
      await page.mouse.move(p.x, p.y);
    }
    await page.mouse.up();
    await page.waitForTimeout(150);
    expect(frameCounts(h.sent), 'a Tail press seeds on its own occupied tile: one DrawBelt, to be refused').toEqual({
      [CMD.DrawBelt]: 1,
    });
    // `[3, cell count, x, y, ...]`, each coordinate zigzag-encoded (10 is 20, 9 is 18).
    expect([...h.sent[0].subarray(0, 4)], 'the DrawBelt starts on the pressed Tail tile (10,9), three cells').toEqual([
      CMD.DrawBelt,
      3,
      20,
      18,
    ]);

    // AND THE ECHO IS INJECTED ANYWAY, matching the run the WRONG seed would have
    // drawn. If a follow-up dock had been armed against it, this is the packet that
    // fires it - so the zero below is a measured absence rather than an untested path.
    h.inject(
      buildPacket({
        full: false,
        tick: 2,
        belts: [
          {
            id: 10,
            tiles: [
              [9, 9],
              [8, 9],
            ],
          },
        ],
      }),
    );
    await page.waitForTimeout(150);
    expect(frameCounts(h.sent)[CMD.Dock] ?? 0, 'a Tail press records no dock').toBe(0);

    // NOW THE POSITIVE HALF, on the same board and the same armed tool: a plain draw
    // that ENDS facing the Sink's In still auto-docks, so the machinery this case is
    // asserting the ABSENCE of is demonstrably live.
    const sent0 = h.sent.length;
    const start = await screenCellCentre(page, 15, 9);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    for (const cx of [16, 17]) {
      const p = await screenCellCentre(page, cx, 9);
      await page.mouse.move(p.x, p.y);
    }
    await page.mouse.up();
    await expect.poll(() => h.sent.length).toBe(sent0 + 1);

    h.inject(
      buildPacket({
        full: false,
        tick: 2,
        belts: [
          {
            id: 11,
            tiles: [
              [15, 9],
              [16, 9],
              [17, 9],
            ],
          },
        ],
      }),
    );
    await expect.poll(() => h.sent.length).toBe(sent0 + 2);
    await page.waitForTimeout(150);
    expect(
      Array.from(h.sent[h.sent.length - 1]),
      'the auto-dock is LIVE on this board: Dock{belt:11, end:Head, node:8 (the Sink), port:0}',
    ).toEqual([CMD.Dock, 11, 0, 8, 0]);
  });
});
