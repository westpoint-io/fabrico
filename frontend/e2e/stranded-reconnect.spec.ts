import { test, expect, type Page } from '@playwright/test';
import {
  alertRingsPainted,
  CMD,
  buildPacket,
  expectExactlyOneFrame,
  mockRenderSocket,
  nubAnchor,
  screenCellCentre,
  screenPoint,
  waitForChrome,
  type InjectBelt,
  type InjectNode,
  waitForBoard,
} from './support/wire';

// stranded-reconnect.spec.ts (67-05, CONNECT-02) - browser-level proof that a
// STRANDED dock is recoverable IN THE APP: press the fault ring on the orphaned
// belt end, drag it to the machine's port nub, release, and exactly ONE
// correctly-addressed `Dock` frame goes out.
//
// This is the symptom reported on the real binary at v7.0 FEEL row
// 62-d, where the only recovery was reloading the scene.
//
// WHAT IS BEING PROVED, AND WHY IT NEEDED A NEW SPEC. Almost every part of this
// gesture already shipped: `detectStrandedDocks` (the pre-apply diff), the ring
// paint (`overlay.showAlertRings`), the two resolved world points (App.tsx's
// packet handler), the in-drag candidate ranking, the release emit and the
// refusal path. The one genuinely new shape is the CHANNEL from the stranded
// event to the gesture layer (`GestureController.setStrandedRings`), because
// App used to flatten both resolved points into one bare `pts` array for the
// overlay - losing which point is a port nub and which is a belt end - and the
// gesture layer could not see them at all (67-RESEARCH Finding 9). This spec
// walks that channel end to end through the production UI and asserts on the
// EMITTED BINARY FRAME, never on canvas pixels.
//
// THE TWO THINGS THAT WOULD MAKE THIS A CHECK THAT CANNOT FAIL, both closed:
//   1. Pressing with SOMETHING selected would let `hitHandle` produce the same
//      Dock and the spec would pass with the new arm deleted. The press below is
//      made with NOTHING selected, which no shipped path can serve.
//   2. Asserting only the discriminant would leave a wrong-END or wrong-PORT
//      reconnect green. All four decoded fields are asserted byte for byte.

// ---------------------------------------------------------------------------
// Fixture geometry - all anchors come from the shared geometry helpers
// (frontend/shared/geometry.ts, GATE-01); no arithmetic is spelled out here.
// Identity camera: screen px == world px.
// ---------------------------------------------------------------------------

/**
 * A FACTORY-shaped node (kind 2, 3x3) at (10,8) with its catalog ports resolved
 * to world cells: In (10,9) W, Out (12,9) E, Fault (11,10) S. Same shape as
 * `port-gestures.spec.ts`'s fixture, which is the shipped precedent for driving
 * a canvas nub gesture under the mock socket.
 */
const FACTORY: InjectNode = {
  id: 7,
  kind: 2,
  cell_x: 10,
  cell_y: 8,
  w: 3,
  h: 3,
  ports: [
    { index: 0, cell_x: 10, cell_y: 9, side: 3, role: 0 },
    { index: 1, cell_x: 12, cell_y: 9, side: 1, role: 1 },
    { index: 2, cell_x: 11, cell_y: 10, side: 2, role: 2 },
  ],
};

/**
 * A 4-tile belt (13,9)->(16,9). Its TAIL end (13,9) sits on the cell the factory
 * Out port faces, travelling away - the exact `acceptsDock` geometry - so a Tail
 * dock onto the Out nub is legal both before the strand and after the reconnect.
 */
const BELT_TILES: [number, number][] = [
  [13, 9],
  [14, 9],
  [15, 9],
  [16, 9],
];

/** The belt AS DOCKED: Tail -> factory port 1. This is the baseline the scene holds. */
const DOCKED_BELT: InjectBelt = {
  id: 3,
  tiles: BELT_TILES,
  docks: [{ end: 'Tail', node: 7, port: 1 }],
};

/**
 * The SAME belt re-emitted WITHOUT the dock - literally the input condition
 * `detectStrandedDocks` fires on ("a belt re-emitted without the dock the scene
 * still holds", strandedDocks.ts). On the real host this arrives when a Rotate
 * moves the machine's port off the belt end and the link is severed.
 */
const STRANDED_BELT: InjectBelt = { id: 3, tiles: BELT_TILES, docks: [] };

/** The factory Out nub's world/screen anchor: the E-side nub of its cell (12,9). */
const OUT_NUB = nubAnchor(12, 9, 1); // side E=1

/** The belt's docks as the page's own oracle reports them. */
async function beltDockCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const hook = window.__fabrico;
    if (!hook) {
      throw new Error('window.__fabrico not installed');
    }
    const scene = hook.scene() as { belts: Array<{ id: number; docks: unknown[] }> };
    return scene.belts.find((b) => b.id === 3)?.docks.length ?? -1;
  });
}

test.describe('CONNECT-02: a stranded dock is recoverable by dragging its ring', () => {
  test('pressing the orphaned belt-end ring with NOTHING selected redocks the belt', async ({
    page,
  }) => {
    const h = await mockRenderSocket(page);
    await page.goto('/');
    await waitForChrome(page);
    await h.connected;

    // --- Arrange: a keyframe holding the belt DOCKED to the factory Out. ---
    h.inject(buildPacket({ nodes: [FACTORY], belts: [DOCKED_BELT] }));
    await waitForBoard(page, { machines: 1 });
    await expect.poll(() => beltDockCount(page)).toBe(1);

    // --- Act 1: STRAND it. A DIFF packet (full: false) re-emits the belt with
    // no dock. `detectStrandedDocks` runs PRE-apply, sees the dock vanish, and
    // App paints the alert rings AND hands the gesture layer the structured
    // ring record for the orphaned belt end. A `full` keyframe would be skipped
    // by the detector by construction, so the diff flag is load-bearing.
    h.inject(buildPacket({ tick: 2, full: false, belts: [STRANDED_BELT] }));
    await expect.poll(() => beltDockCount(page)).toBe(0);

    // The gesture must emit NOTHING up to this point - the strand itself is an
    // echo, not a user action.
    expect(h.sent, 'stranding emits no command of its own').toHaveLength(0);

    // --- Act 2: press the ring and drag it to the port nub. ---
    // NOTHING IS SELECTED. No belt has been clicked, no node has been clicked.
    // `hitHandle`'s only precondition is `selection.kind === 'belt'`, so under
    // the shipped code this press falls straight through to the belt-tile
    // select arm and no drag starts at all. Only the new stranded-ring arm can
    // serve it, which is what makes this assertion non-vacuous.
    //
    // The ring sits at the ORPHANED BELT END's tile centre - the Tail tile
    // (13,9) - which is exactly where App resolved it with `beltEndCell`.
    const ringPt = await screenCellCentre(page, 13, 9);
    const outNub = await screenPoint(page, OUT_NUB);

    // THE RING IS ON SCREEN, ASSERTED RATHER THAN ASSUMED (67-REVIEW WR-05).
    // Everything else in this spec reads the scene model or the emitted frame,
    // and neither can see a RENDERER regression: a build in which
    // `overlay.showAlertRings` stopped painting while `setStrandedRings` still
    // fired would emit the identical Dock and pass every assertion below, over a
    // canvas showing the user nothing to press. That is this project's recorded
    // model-oracle blind spot, and this is the one line that closes it here.
    expect(
      await alertRingsPainted(page),
      'the stranded-dock alert ring is actually PAINTED before the press - the ' +
        'gesture below is only honest if the user can see what it grabs',
    ).toBe(true);

    await page.mouse.move(ringPt.x, ringPt.y);
    await page.mouse.down();
    await page.mouse.move(outNub.x, outNub.y, { steps: 4 });
    await page.mouse.up();

    // --- Assert: exactly ONE Dock frame, with no late duplicate. ---
    await expectExactlyOneFrame(page, h, CMD.Dock);

    // ALL FOUR FIELDS DECODED, not just the discriminant. A wrong END or a wrong
    // PORT reconnect is still a `Dock` frame and would pass a discriminant-only
    // check while docking the wrong thing to the wrong place.
    //   Dock wire = [disc=4, belt varintU, end varintU (Head=0/Tail=1),
    //                node varintU, port varintU]
    // `port` is the SPATIAL CATALOG index verbatim - the host owns the
    // Out-routing-key / FAULT_PORT translation at freeze time (D-11).
    expect(
      Array.from(h.sent[0]),
      'Dock{belt:3, end:Tail (the recorded BeltEnd, never assumed), node:7, port:1}',
    ).toEqual([CMD.Dock, 3, 1, 7, 1]);
  });

  // EVIDENCE CAPTURE, not an assertion, and it is deliberately not one.
  //
  // 67-UI-SPEC's UI Considerations `overflow` row asks whether a `pal.hover`
  // ring at r=8 stroke 1.5px sitting over a still-pulsing `pal.fault` ring at
  // r=8 stroke 2px reads as TWO rings or as one thickened ring. That is a FEEL
  // judgment, not a measurable one: no pixel count answers it, and inventing a
  // verdict here would be worse than leaving it open. The row therefore stays at
  // `backstop` and the judgment is routed to plan 67-07's real-binary walk and
  // to the v8.0 FEEL kit. This test's whole job is to produce the frame that
  // judgment is made against, from the real renderer, so nobody has to
  // reconstruct the state by hand.
  test('EVIDENCE: capture the hover ring layered over the fault ring', async ({ page }) => {
    const h = await mockRenderSocket(page);
    await page.goto('/');
    await waitForChrome(page);
    await h.connected;

    h.inject(buildPacket({ nodes: [FACTORY], belts: [DOCKED_BELT] }));
    await waitForBoard(page, { machines: 1 });
    h.inject(buildPacket({ tick: 2, full: false, belts: [STRANDED_BELT] }));
    await expect.poll(() => beltDockCount(page)).toBe(0);

    // ZOOM IN FIRST. Both rings are r=8 WORLD px, so at the boot camera the two
    // strokes are a handful of device pixels apart and the frame cannot answer
    // the question it is being captured for. The wheel is the shipped zoom
    // gesture; the rings are drawn in world units, so zooming magnifies the
    // strokes and their separation exactly as a user leaning in would see them.
    const preZoom = await screenCellCentre(page, 13, 9);
    await page.mouse.move(preZoom.x, preZoom.y);
    for (let i = 0; i < 12; i += 1) {
      await page.mouse.wheel(0, -120);
    }

    // HOVER, do not press: the press retires the fault ring, which is exactly
    // the state this frame must NOT be in. Both rings have to be on screen at
    // once for the question to be answerable. Re-read the point AFTER the zoom -
    // screenCellCentre is camera-aware, so this is where the ring now sits.
    const ringPt = await screenCellCentre(page, 13, 9);
    await page.mouse.move(ringPt.x, ringPt.y);

    // Crop around the ring so the frame is about the two circles and not about
    // the rest of the board.
    // The committed PNG is v8.0's record; a gate run must never rewrite a tracked file.
    await page.screenshot({
      path: test.info().outputPath('67-05-hover-over-fault-ring.png'),
      clip: { x: ringPt.x - 120, y: ringPt.y - 120, width: 240, height: 240 },
    });
  });
});
