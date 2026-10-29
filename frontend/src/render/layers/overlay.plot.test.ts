// @vitest-environment jsdom
//
// THE ALERT-RING PLOT READ (73-14, WINDOWS 219). REAL PIXI, NO MOCK.
//
// Why a second overlay spec instead of four more cases in `overlay.test.ts`: that file
// opens with `vi.mock('pixi.js', ...)` and a call-recording `Graphics` stub, which is
// exactly right for what it asserts (a circle count, a stroke colour, an alpha ride) and
// fatal here. The stub has no `GraphicsContext` at all, so `alertRings.context.instructions`
// would be a property of the double rather than of a drawing, and every assertion below
// would be a check on the mock. That is the same reasoning `machineVector.test.ts:16-24`
// wrote down when it declined to mock Pixi for the glyph-context claim, and this file
// follows it.
//
// WHAT THIS FILE CAN AND CANNOT SEE, stated so no reader over-reads it. It can see that
// the probe is WIRED - exported, reading the ring Graphics rather than the retained point
// list, and going back to zero when the ring is cleared. It cannot prove non-vacuity on
// the shipped renderer; that proof is a mutation of `paintAlertRings` watched against the
// UNDO-06 live leg, recorded in `73-14-SUMMARY.md`.

import { describe, expect, it } from 'vitest';
import type { SceneState } from '../sceneState';
import { createOverlay } from './overlay';

/** A frozen, empty scene. The ring probe never reads it; the layer requires one. */
const scene = (): (() => SceneState) => {
  const s = { tick: 0, nodes: new Map(), belts: new Map() } as unknown as SceneState;
  return () => s;
};

const ONE = [{ x: 100, y: 100 }];
const TWO = [
  { x: 100, y: 100 },
  { x: 160, y: 100 },
];

describe('alertRingInstructions - the step-5 instrument', () => {
  it('reads ZERO before any ring is shown, and the latch agrees', () => {
    const api = createOverlay(scene());
    expect(api.alertRingInstructions()).toBe(0);
    expect(api.alertRingsActive()).toBe(false);
  });

  it('reads NON-ZERO once a ring is painted', () => {
    const api = createOverlay(scene());
    api.showAlertRings(ONE, 0);
    expect(api.alertRingInstructions()).toBeGreaterThan(0);
  });

  it('counts geometry: two rings plot strictly more than one', () => {
    const api = createOverlay(scene());
    api.showAlertRings(ONE, 0);
    const one = api.alertRingInstructions();
    api.showAlertRings(TWO, 0);
    const two = api.alertRingInstructions();
    expect(one).toBeGreaterThan(0);
    expect(two).toBeGreaterThan(one);
    // MEASURED AND WRITTEN DOWN RATHER THAN ASSERTED AWAY: on real Pixi this
    // drawing plots exactly ONE instruction per ring, so the number here is EQUAL
    // to `alertPts.length` (1 and 2). The count alone therefore cannot tell a plot
    // read from a length read - an assertion that it differs was drafted for this
    // case, measured false, and deleted rather than weakened. The separation is
    // structural, and the case below is what makes it observable.
    expect(two).toBe(TWO.length);
  });

  it('READS THE GRAPHICS, NOT THE POINT LIST: an emptied plot reads 0 while the latch still says yes', () => {
    // THE DISCRIMINATOR. Wipe the ring Graphics directly, which is what a regressed
    // `paintAlertRings` amounts to, and leave `alertPts` and `alertBornMs` exactly as
    // they were. A probe derived from the retained point list answers 2 here and a probe
    // derived from `alertBornMs` answers true; only a read of the Graphics answers 0.
    //
    // This is the in-unit form of the shipped defect class: the model says "stranded"
    // over a canvas that drew nothing, and every model-only assertion passes.
    const api = createOverlay(scene());
    api.showAlertRings(TWO, 0);
    expect(api.alertRingInstructions()).toBe(2);

    const ringGraphics = api.layer.children.find((c) => c.label === 'alert-rings') as unknown as
      | { clear(): void }
      | undefined;
    expect(ringGraphics, 'the alert-ring child is addressable by label').toBeDefined();
    ringGraphics!.clear();

    expect(api.alertRingInstructions(), 'the plot is empty').toBe(0);
    expect(api.alertRingsActive(), 'and the call latch is none the wiser').toBe(true);
  });

  it('goes back to ZERO on the structural-edit clear - the UNDO-06 assertion', () => {
    // This is the exact shape the live leg asserts after the Ctrl+Z: the ring is
    // UNPLOTTED, not merely un-latched. A build that nulled `alertBornMs` while leaving
    // the geometry on screen passes `alertRingsActive()` and fails this.
    const api = createOverlay(scene());
    api.showAlertRings(TWO, 0);
    expect(api.alertRingInstructions()).toBeGreaterThan(0);

    api.clearAlertRings();
    expect(api.alertRingInstructions()).toBe(0);
    expect(api.alertRingsActive()).toBe(false);
  });

  it('a press that retires the LAST ring empties the plot; retiring one of two does not', () => {
    const api = createOverlay(scene());
    api.showAlertRings(TWO, 0);
    const both = api.alertRingInstructions();

    expect(api.clearAlertRingAt(TWO[0])).toBe(true);
    const one = api.alertRingInstructions();
    expect(one).toBeGreaterThan(0);
    expect(one).toBeLessThan(both);

    expect(api.clearAlertRingAt(TWO[1])).toBe(true);
    expect(api.alertRingInstructions()).toBe(0);
  });

  it('the ring Graphics is LABELLED, so a spec addresses it by name and not by index', () => {
    // Same reason the nub Graphics was labelled at 73-10: an unaddressable child is a
    // child no test asserts about. Read off the layer rather than trusting the source.
    const api = createOverlay(scene());
    const named = api.layer.children.filter((c) => c.label === 'alert-rings');
    expect(named, 'exactly one child answers to alert-rings').toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// rejectFlashInstructions - the 74-05 instrument (LINK-02's two controls)
// ---------------------------------------------------------------------------
//
// Added because LINK-02's browser spec has to pin the split a belt end entering the
// nub hit set is most able to break: a RING-sourced drag released on empty floor must
// still flash, and a HANDLE drag released on empty floor must still not. Phase 67
// measured a regression on exactly that split which the whole 2012-case gesture suite
// stayed green through, and there was no browser-level instrument for the flash at all.
//
// A COUNT, never a latch, for the reason `alertRingInstructions` above records: "the
// flash function was CALLED" is not "anything was PAINTED".
describe('rejectFlashInstructions - the LINK-02 control instrument', () => {
  const CELL_AT = { cx: 4, cy: 4 };
  const DIMS = { w: 1, h: 1, rot: 0 };

  it('reads ZERO before any flash', () => {
    const api = createOverlay(scene());
    expect(api.rejectFlashInstructions()).toBe(0);
  });

  it('reads NON-ZERO once a flash is painted', () => {
    const api = createOverlay(scene());
    api.showRejectFlash(CELL_AT, DIMS);
    expect(api.rejectFlashInstructions()).toBeGreaterThan(0);
  });

  it('goes back to ZERO on the explicit clear', () => {
    const api = createOverlay(scene());
    api.showRejectFlash(CELL_AT, DIMS);
    expect(api.rejectFlashInstructions()).toBeGreaterThan(0);
    api.clearRejectFlash();
    expect(api.rejectFlashInstructions()).toBe(0);
  });

  it('is a PLOT read: emptying the Graphics takes it to zero with nothing else touched', () => {
    // The same non-vacuity proof `alertRingInstructions` gets. A build whose flash
    // drawing plotted nothing reads zero here, which is exactly the report wanted.
    const api = createOverlay(scene());
    api.showRejectFlash(CELL_AT, DIMS);
    expect(api.rejectFlashInstructions()).toBeGreaterThan(0);
    const g = api.layer.children[REJECT_FLASH_IDX] as unknown as {
      clear(): void;
    };
    g.clear();
    expect(api.rejectFlashInstructions(), 'the plot is empty').toBe(0);
  });
});

// rejectFlashCell (plan 89-09, D-12): WHERE the flash is plotted, read off its own fill.
describe('rejectFlashCell - the cell the flash is plotted on', () => {
  it('reads null before any flash, the flashed cell once painted, and null once cleared', () => {
    const api = createOverlay(scene());
    expect(api.rejectFlashCell()).toBeNull();
    api.showRejectFlash({ cx: -3, cy: 7 }, { w: 1, h: 1, rot: 0 });
    expect(api.rejectFlashCell()).toEqual({ cx: -3, cy: 7 });
    api.showRejectFlash({ cx: 12, cy: 0 }, { w: 1, h: 1, rot: 0 });
    expect(api.rejectFlashCell(), 'the newest flash replaces the old').toEqual({ cx: 12, cy: 0 });
    api.clearRejectFlash();
    expect(api.rejectFlashCell()).toBeNull();
  });

  it('is a PLOT read: emptying the Graphics takes it to null with nothing else touched', () => {
    const api = createOverlay(scene());
    api.showRejectFlash({ cx: 4, cy: 4 }, { w: 1, h: 1, rot: 0 });
    const g = api.layer.children[REJECT_FLASH_IDX] as unknown as { clear(): void };
    g.clear();
    expect(api.rejectFlashCell(), 'nothing is plotted, so no cell is named').toBeNull();
  });
});

// rejectFlashSerial (review IN-C-01): two flashes on ONE cell read as two, which the cell cannot say.
describe('rejectFlashSerial - one count per flash shown', () => {
  it('rises by one per flash, also for a second flash on the same cell', () => {
    const api = createOverlay(scene());
    expect(api.rejectFlashSerial()).toBe(0);
    api.showRejectFlash({ cx: 4, cy: 4 }, { w: 1, h: 1, rot: 0 });
    const first = { cell: api.rejectFlashCell(), serial: api.rejectFlashSerial() };
    api.showRejectFlash({ cx: 4, cy: 4 }, { w: 1, h: 1, rot: 0 });
    const second = { cell: api.rejectFlashCell(), serial: api.rejectFlashSerial() };
    expect(first).toEqual({ cell: { cx: 4, cy: 4 }, serial: 1 });
    expect(second, 'the same cell, a second flash: the serial moved').toEqual({ cell: { cx: 4, cy: 4 }, serial: 2 });
    api.clearRejectFlash();
    expect(api.rejectFlashSerial(), 'a clear does not count').toBe(2);
  });
});

/** The reject flash's z-slot in `createOverlay`'s addChild list (bottom to top:
 *  hover 0, alertRings 1, route 2, beltPreview 3, heldBelts 4, rejectFlash 5, ...;
 *  plan 74.1-30 moved it from 4). */
const REJECT_FLASH_IDX = 5;

// ---------------------------------------------------------------------------
// beltPreviewInstructions - the 74.1-26 instrument (review WR-08, walk item S1R)
// ---------------------------------------------------------------------------
//
// The live release leg grades every frame after a pointerup on what was on screen: the
// draw-belt preview, the drawn belt, or neither. The drawn belt already had a read-back
// (`beltDrawnKindsOf`); the preview had none, so a frame showing neither could not be
// told from a frame showing the preview. Here, in the real-Pixi file for the reason the
// header gives: `overlay.test.ts` stubs `Graphics` with no `GraphicsContext`.
describe('beltPreviewInstructions - the S1R release-frame instrument', () => {
  const TILES = [
    { cell_x: 2, cell_y: 3, kind: { Straight: { axis: 0 } } },
    { cell_x: 3, cell_y: 3, kind: { Straight: { axis: 0 } } },
  ] as unknown as Parameters<ReturnType<typeof createOverlay>['showBeltPreview']>[0];

  it('reads ZERO before any preview', () => {
    const api = createOverlay(scene());
    expect(api.beltPreviewInstructions()).toBe(0);
  });

  it('reads NON-ZERO while a preview is drawn, valid or not', () => {
    const api = createOverlay(scene());
    api.showBeltPreview(TILES, true);
    expect(api.beltPreviewInstructions()).toBeGreaterThan(0);
    api.showBeltPreview(TILES, false);
    expect(api.beltPreviewInstructions()).toBeGreaterThan(0);
  });

  it('goes back to ZERO on clearBeltPreview', () => {
    const api = createOverlay(scene());
    api.showBeltPreview(TILES, true);
    expect(api.beltPreviewInstructions()).toBeGreaterThan(0);
    api.clearBeltPreview();
    expect(api.beltPreviewInstructions()).toBe(0);
  });

  it('is a PLOT read: emptying the Graphics takes it to zero with the retained shape untouched', () => {
    const api = createOverlay(scene());
    api.showBeltPreview(TILES, true);
    const g = api.layer.children[BELT_PREVIEW_IDX] as unknown as { clear(): void };
    g.clear();
    expect(api.beltPreviewInstructions(), 'the plot is empty').toBe(0);
  });
});

/** The draw-belt preview's z-slot in the same addChild list. */
const BELT_PREVIEW_IDX = 3;

// ---------------------------------------------------------------------------
// beltPreviewKindAt - WHAT SHAPE the preview plotted (74.1-30, review round 4 CR-01)
// ---------------------------------------------------------------------------
//
// The S1R live leg graded a frame good whenever the preview held ANY geometry, so the
// straight seam the walk saw at every docked release passed. This read answers the kind
// the preview PLOTTED at a cell, from the list recorded inside the plotting call.
describe('beltPreviewKindAt - the S1R seam-shape instrument', () => {
  const CORNER_E_N = { Corner: { from: 1, to: 0 } };
  const STRAIGHT_Y = { Straight: { axis: 1 } };
  /** The S1 path: (8,6) fed east, leaving north through (8,5) to (8,4). */
  const S1 = [
    { cell_x: 8, cell_y: 6, kind: CORNER_E_N },
    { cell_x: 8, cell_y: 5, kind: STRAIGHT_Y },
    { cell_x: 8, cell_y: 4, kind: STRAIGHT_Y },
  ] as unknown as Parameters<ReturnType<typeof createOverlay>['showBeltPreview']>[0];

  it('reads null before any preview', () => {
    const api = createOverlay(scene());
    expect(api.beltPreviewKindAt(8, 6)).toBeNull();
  });

  it('reads the plotted kind at a covered cell, and null at a cell the path does not cover', () => {
    const api = createOverlay(scene());
    api.showBeltPreview(S1, true);
    expect(api.beltPreviewKindAt(8, 6), 'the seam is the corner the call plotted').toEqual(CORNER_E_N);
    expect(api.beltPreviewKindAt(8, 5)).toEqual(STRAIGHT_Y);
    expect(api.beltPreviewKindAt(7, 6), 'a cell beside the path').toBeNull();
  });

  it('reads the LATEST plot: a repaint with a straight seam reads straight', () => {
    const api = createOverlay(scene());
    api.showBeltPreview(S1, true);
    const straight = S1.map((t) => ({ ...t, kind: STRAIGHT_Y }));
    api.showBeltPreview(straight, true);
    expect(api.beltPreviewKindAt(8, 6)).toEqual(STRAIGHT_Y);
  });

  it('reads null at every cell after clearBeltPreview', () => {
    const api = createOverlay(scene());
    api.showBeltPreview(S1, true);
    expect(api.beltPreviewKindAt(8, 6), 'NON-VACUITY').toEqual(CORNER_E_N);
    api.clearBeltPreview();
    for (const t of S1) {
      expect(api.beltPreviewKindAt(t.cell_x, t.cell_y)).toBeNull();
    }
  });

  it('reads null after an empty-and-valid call (a genuine clear that plots nothing)', () => {
    const api = createOverlay(scene());
    api.showBeltPreview(S1, true);
    api.showBeltPreview([], true);
    expect(api.beltPreviewInstructions(), 'NON-VACUITY: nothing is plotted').toBe(0);
    expect(api.beltPreviewKindAt(8, 6)).toBeNull();
  });

  it('reads the RETAINED kinds when a typed reject repaints the last routable shape in fault', () => {
    const api = createOverlay(scene());
    api.showBeltPreview(S1, true);
    api.showBeltPreview([], false);
    expect(api.beltPreviewInstructions(), 'NON-VACUITY: the retained shape is plotted').toBeGreaterThan(0);
    expect(api.beltPreviewKindAt(8, 6)).toEqual(CORNER_E_N);
    expect(api.beltPreviewKindAt(8, 4)).toEqual(STRAIGHT_Y);
  });

  // THE HELD PICTURES (plan 74.1-30): the second belt-picture surface. Both reads answer
  // from it, so a frame whose picture lives there is graded on its shape too.
  const HELD = [
    { cell_x: 3, cell_y: 5, kind: { Corner: { from: 1, to: 2 } } },
    { cell_x: 3, cell_y: 6, kind: STRAIGHT_Y },
  ] as unknown as Parameters<ReturnType<typeof createOverlay>['showBeltPreview']>[0];

  it('answers from the HELD surface too, one list per committed belt', () => {
    const api = createOverlay(scene());
    api.showHeldBelts([S1, HELD]);
    expect(api.beltPreviewKindAt(8, 6), 'the first held belt').toEqual(CORNER_E_N);
    expect(api.beltPreviewKindAt(3, 5), 'the second held belt').toEqual({ Corner: { from: 1, to: 2 } });
    expect(api.beltPreviewKindAt(5, 5)).toBeNull();
  });

  it('a held picture and a drag preview both show, each read at its own cells', () => {
    const api = createOverlay(scene());
    api.showHeldBelts([HELD]);
    const heldOnly = api.beltPreviewInstructions();
    expect(heldOnly, 'NON-VACUITY: the held surface plotted').toBeGreaterThan(0);
    api.showBeltPreview(S1, true);
    expect(api.beltPreviewInstructions(), 'the count is both surfaces').toBeGreaterThan(heldOnly);
    expect(api.beltPreviewKindAt(3, 5)).toEqual({ Corner: { from: 1, to: 2 } });
    expect(api.beltPreviewKindAt(8, 6)).toEqual(CORNER_E_N);
    api.clearBeltPreview();
    expect(api.beltPreviewKindAt(3, 5), 'clearing the drag preview leaves the held picture').toEqual({
      Corner: { from: 1, to: 2 },
    });
    expect(api.beltPreviewInstructions()).toBe(heldOnly);
  });

  it('clearHeldBelts empties the held surface: both reads go back to nothing', () => {
    const api = createOverlay(scene());
    api.showHeldBelts([S1]);
    expect(api.beltPreviewKindAt(8, 6), 'NON-VACUITY').toEqual(CORNER_E_N);
    api.clearHeldBelts();
    expect(api.beltPreviewKindAt(8, 6)).toBeNull();
    expect(api.beltPreviewInstructions()).toBe(0);
  });

  it('showHeldBelts replaces every earlier picture on its surface', () => {
    const api = createOverlay(scene());
    api.showHeldBelts([S1, HELD]);
    api.showHeldBelts([HELD]);
    expect(api.beltPreviewKindAt(8, 6), 'the dropped picture is gone').toBeNull();
    expect(api.beltPreviewKindAt(3, 5)).toEqual({ Corner: { from: 1, to: 2 } });
    api.showHeldBelts([]);
    expect(api.beltPreviewInstructions(), 'an empty set plots nothing').toBe(0);
  });

  it('the held surface is LABELLED and is a PLOT read: emptying its Graphics zeroes the count', () => {
    const api = createOverlay(scene());
    api.showHeldBelts([S1]);
    const g = api.layer.children.find((c) => c.label === 'held-belts') as unknown as { clear(): void } | undefined;
    expect(g, 'the held-picture Graphics is addressable by name').toBeDefined();
    g!.clear();
    expect(api.beltPreviewInstructions(), 'the plot is empty').toBe(0);
  });

  it('hands out a fresh object: mutating an answer does not change the next read', () => {
    const api = createOverlay(scene());
    api.showBeltPreview(S1, true);
    const a = api.beltPreviewKindAt(8, 6) as { Corner: { from: number; to: number } };
    a.Corner.to = 3;
    expect(api.beltPreviewKindAt(8, 6)).toEqual(CORNER_E_N);
  });
});

// ---------------------------------------------------------------------------
// alertRingCentres - WHERE the rings are (74.1-27, review WR-06)
// ---------------------------------------------------------------------------
//
// The UNDO-06 live leg read only "the ring Graphics holds geometry", so a ring painted
// on the wrong output (walk item N5) passed it. This read returns the centres the
// Graphics PLOTTED. The discriminating case paints the Graphics directly at a point the
// retained list does not hold: a probe that echoed `alertPts` would answer the old
// points there, and only a plot read answers the new one.
describe('alertRingCentres - the ring-position instrument', () => {
  const ringGraphicsOf = (api: ReturnType<typeof createOverlay>) =>
    api.layer.children.find((c) => c.label === 'alert-rings') as unknown as {
      clear(): void;
      circle(x: number, y: number, r: number): { stroke(s: { width: number; color: number }): void };
    };

  it('reads an EMPTY list before any ring is shown', () => {
    const api = createOverlay(scene());
    expect(api.alertRingCentres()).toEqual([]);
  });

  it('reads the plotted centres after showAlertRings, one per ring, in paint order', () => {
    const api = createOverlay(scene());
    api.showAlertRings(TWO, 0);
    expect(api.alertRingCentres()).toEqual(TWO);
  });

  it('READS THE PLOT, NOT THE INPUT: a paint at an offset point is seen at that point', () => {
    const api = createOverlay(scene());
    api.showAlertRings(ONE, 0);
    const g = ringGraphicsOf(api);
    g.clear();
    g.circle(ONE[0].x + 37, ONE[0].y - 11, 8).stroke({ width: 2, color: 0xff0000 });
    expect(api.alertRingCentres(), 'the moved plot, not the list handed to the paint').toEqual([
      { x: ONE[0].x + 37, y: ONE[0].y - 11 },
    ]);
    expect(api.alertRingsActive(), 'while the latch and the retained list are untouched').toBe(true);
  });

  it('reads an EMPTY list after clearAlertRings, and after the last ring is pressed', () => {
    const api = createOverlay(scene());
    api.showAlertRings(TWO, 0);
    api.clearAlertRings();
    expect(api.alertRingCentres()).toEqual([]);
    api.showAlertRings(TWO, 0);
    expect(api.clearAlertRingAt(TWO[0])).toBe(true);
    expect(api.alertRingCentres(), 'one of two pressed: the other is still plotted').toEqual([TWO[1]]);
    expect(api.clearAlertRingAt(TWO[1])).toBe(true);
    expect(api.alertRingCentres()).toEqual([]);
  });

  it('hands out a FRESH array of plain numbers each call', () => {
    const api = createOverlay(scene());
    api.showAlertRings(ONE, 0);
    const a = api.alertRingCentres();
    a.push({ x: 0, y: 0 });
    expect(api.alertRingCentres()).toEqual(ONE);
  });
});

// ---------------------------------------------------------------------------
// targetRingsPlotted - WHICH target rings are painted, and HOW (74.1-33, review WR-02)
// ---------------------------------------------------------------------------
//
// Review round 4 found an accepting ring on the Out a dragged Tail was docked to, and the
// gesture stub that caught it records the CALLS, not the drawing. This read returns what
// the two target-ring Graphics hold: the resting rings with their grabbed disc, and the
// hovered drop ring with the colour it was drawn in. The discriminating cases paint the
// Graphics directly, where the point lists handed to the paints say something else.
describe('targetRingsPlotted - the target-ring instrument', () => {
  const graphicsNamed = (api: ReturnType<typeof createOverlay>, label: string) =>
    api.layer.children.find((c) => c.label === label) as unknown as {
      clear(): void;
      circle(x: number, y: number, r: number): { stroke(s: { width: number; color: number }): void };
    };

  it('reads nothing before any ring is shown', () => {
    const api = createOverlay(scene());
    expect(api.targetRingsPlotted()).toEqual({ resting: [], drop: null });
  });

  it('reads the resting rings showDockTargets plotted, in paint order, with their filled disc', () => {
    const api = createOverlay(scene());
    api.showDockTargets([
      { x: 100, y: 100, filled: false },
      { x: 160, y: 100, filled: true },
    ]);
    expect(api.targetRingsPlotted()).toEqual({
      resting: [
        { x: 100, y: 100, filled: false },
        { x: 160, y: 100, filled: true },
      ],
      drop: null,
    });
  });

  it('reads the drop ring drawn ACCEPTING as accepting, and drawn REFUSED as refused', () => {
    const api = createOverlay(scene());
    api.showNubRing({ x: 40, y: 50 }, true);
    expect(api.targetRingsPlotted().drop).toEqual({ x: 40, y: 50, accepting: true });
    api.showNubRing({ x: 41, y: 52 }, false);
    expect(api.targetRingsPlotted().drop, 'a repaint replaces the ring').toEqual({
      x: 41,
      y: 52,
      accepting: false,
    });
  });

  it('each clear empties its own half and leaves the other', () => {
    const api = createOverlay(scene());
    api.showDockTargets([{ x: 100, y: 100, filled: false }]);
    api.showNubRing({ x: 40, y: 50 }, true);
    api.clearNubRing();
    expect(api.targetRingsPlotted()).toEqual({
      resting: [{ x: 100, y: 100, filled: false }],
      drop: null,
    });
    api.showNubRing({ x: 40, y: 50 }, true);
    api.clearDockTargets();
    expect(api.targetRingsPlotted()).toEqual({
      resting: [],
      drop: { x: 40, y: 50, accepting: true },
    });
  });

  it('READS THE PLOT, NOT THE INPUT: rings painted straight onto the Graphics are seen as painted', () => {
    const api = createOverlay(scene());
    api.showDockTargets([{ x: 100, y: 100, filled: false }]);
    api.showNubRing({ x: 40, y: 50 }, true);
    // Repaint both Graphics by hand: the dock ring moves, the drop ring turns passive.
    const dock = graphicsNamed(api, 'dock-targets');
    dock.clear();
    dock.circle(137, 89, 7).stroke({ width: 2, color: 0x00ff00 });
    const nub = graphicsNamed(api, 'nub-ring');
    nub.clear();
    nub.circle(40, 50, 7).stroke({ width: 1.5, color: 0x123456 });
    expect(api.targetRingsPlotted()).toEqual({
      resting: [{ x: 137, y: 89, filled: false }],
      drop: { x: 40, y: 50, accepting: false },
    });
  });

  it('hands out fresh objects: mutating an answer does not change the next read', () => {
    const api = createOverlay(scene());
    api.showDockTargets([{ x: 100, y: 100, filled: false }]);
    const a = api.targetRingsPlotted();
    a.resting.push({ x: 0, y: 0, filled: true });
    expect(api.targetRingsPlotted().resting).toEqual([{ x: 100, y: 100, filled: false }]);
  });
});

// Phase 76 (D-04): a selected LABEL shows no rotate handle, so the handle cannot be
// pressed (its hit test reads the centre, which is null). A machine still gets one.
describe('the rotate handle and a selected label (phase 76)', () => {
  const sceneOf = (node: Record<string, unknown>): (() => SceneState) => {
    const s = {
      tick: 0,
      nodes: new Map([[node.id as number, node]]),
      belts: new Map(),
    } as unknown as SceneState;
    return () => s;
  };
  const base = { cell_x: 4, cell_y: 4, state: 0, rot: 0, ports: [], load: 0 };

  it('a label: the selection outline draws and there is NO rotate-handle centre', () => {
    const api = createOverlay(sceneOf({ ...base, id: 9, kind: 11, w: 4, h: 1 }));
    api.showSelection(9);
    expect(api.rotateHandleCenter()).toBeNull();
  });

  it('a machine: the rotate-handle centre exists', () => {
    const api = createOverlay(sceneOf({ ...base, id: 9, kind: 0, w: 1, h: 1 }));
    api.showSelection(9);
    expect(api.rotateHandleCenter()).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// labelResizePreview - the label's pending-size outline (plan 76-03, 76-UI-SPEC 5.4)
// ---------------------------------------------------------------------------
//
// Here, in the real-Pixi file, for the reason the header gives: the read-back walks the
// Graphics' own `context.instructions`, which the `overlay.test.ts` stub does not have.
describe('labelResizePreview - the pending-size outline', () => {
  const BUILD = 0x4fa8ff;
  const FAULT = 0xf0506e;
  // A 7 by 2 box anchored at (10,12): the cell rect inset 4 world px on every side.
  const RECT_7x2 = { x: 10 * 32 + 4, y: 12 * 32 + 4, w: 7 * 32 - 8, h: 2 * 32 - 8 };

  it('reads nothing before any outline is shown', () => {
    expect(createOverlay(scene()).labelResizePreview()).toBeNull();
  });

  it('plots a 2 world px build outline at the pending rect when it fits, alpha 0.5, no fill', () => {
    const api = createOverlay(scene());
    api.showLabelResize({ cx: 10, cy: 12 }, 7, 2, true);
    expect(api.labelResizePreview()).toEqual({
      instructions: 1,
      stroke: { color: BUILD, alpha: 0.5, width: 2 },
      rect: RECT_7x2,
      filled: false,
    });
  });

  it('plots fault when it does not fit, and re-plots on the next call', () => {
    const api = createOverlay(scene());
    api.showLabelResize({ cx: 10, cy: 12 }, 7, 2, true);
    api.showLabelResize({ cx: 10, cy: 12 }, 8, 2, false);
    expect(api.labelResizePreview()).toEqual({
      instructions: 1,
      stroke: { color: FAULT, alpha: 0.5, width: 2 },
      rect: { ...RECT_7x2, w: 8 * 32 - 8 },
      filled: false,
    });
  });

  it('keeps the one-screen-pixel floor: 4 world px at zoom 0.25, re-stroked by tick when the zoom moves', () => {
    let zoom = 1;
    const api = createOverlay(scene(), () => zoom);
    api.showLabelResize({ cx: 10, cy: 12 }, 7, 2, true);
    expect(api.labelResizePreview()?.stroke?.width).toBe(2);
    zoom = 0.25;
    api.tick(0);
    expect(api.labelResizePreview()?.stroke?.width).toBe(4);
  });

  it('clearLabelResize leaves zero instructions', () => {
    const api = createOverlay(scene());
    api.showLabelResize({ cx: 10, cy: 12 }, 7, 2, false);
    api.clearLabelResize();
    expect(api.labelResizePreview()).toBeNull();
    const g = api.layer.children.find((c) => c.label === 'label-resize-preview') as unknown as {
      context: { instructions: unknown[] };
    };
    expect(g, 'the outline Graphics is labelled').toBeDefined();
    expect(g.context.instructions).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// THE "YES OR NO" PLOT READS (plan 88-07, BELT-06)
// ---------------------------------------------------------------------------
//
// BELT-06's live legs grade the colour the user is shown: a second paused draw over a held
// belt, or a ghost over a queued Place, must be drawn as not allowed. Both reads walk the
// Graphics' own instructions, here in the real-Pixi file for the reason the header gives.
describe('beltPreviewPlotted and ghostPlotted - the colour as plotted', () => {
  const BUILD = 0x4fa8ff;
  const FAULT = 0xf0506e;
  const TILES = [
    { cell_x: 2, cell_y: 3, kind: { Straight: { axis: 0 } } },
    { cell_x: 3, cell_y: 3, kind: { Straight: { axis: 0 } } },
  ] as unknown as Parameters<ReturnType<typeof createOverlay>['showBeltPreview']>[0];

  it('the drag preview reads build when valid, fault when not, and nothing once cleared', () => {
    const api = createOverlay(scene());
    expect(api.beltPreviewPlotted()).toBeNull();
    api.showBeltPreview(TILES, true);
    expect(api.beltPreviewPlotted()).toEqual({ color: BUILD, valid: true });
    api.showBeltPreview(TILES, false);
    expect(api.beltPreviewPlotted()).toEqual({ color: FAULT, valid: false });
    api.clearBeltPreview();
    expect(api.beltPreviewPlotted()).toBeNull();
  });

  it('the held pictures are not the drag preview', () => {
    const api = createOverlay(scene());
    api.showHeldBelts([TILES]);
    expect(api.beltPreviewPlotted()).toBeNull();
  });

  it('the ghost reads its body rect and its colour, and nothing once cleared', () => {
    const api = createOverlay(scene());
    expect(api.ghostPlotted()).toBeNull();
    api.showGhost({ cx: 5, cy: 6 }, true);
    const valid = api.ghostPlotted();
    expect(valid?.valid).toBe(true);
    expect(valid?.color).toBe(BUILD);
    expect(Math.floor((valid?.rect.x ?? -1) / 32), 'the body sits in cell column 5').toBe(5);
    expect(Math.floor((valid?.rect.y ?? -1) / 32), 'and row 6').toBe(6);
    api.showGhost({ cx: 5, cy: 6 }, false);
    expect(api.ghostPlotted()).toEqual({ ...valid, color: FAULT, valid: false });
    api.clearGhost();
    expect(api.ghostPlotted()).toBeNull();
  });
});
