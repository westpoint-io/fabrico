import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { SceneState } from '../sceneState.ts';
import { LOCKED_SKIN } from '../synth/skins/locked.ts';
import { BELT_GEOM } from '../../../shared/geometry.ts';

// MOTION-06a — the stranded-dock alert-ring wall-clock PULSE and its settle
// point. The VERIFICATION classifier proxy (`isStructuralEdit`) proves the ring
// is not CLEARED early by a state-only re-emit, but the ring's own lived-timing
// core - "pulses for its first five seconds, keeps pulsing even while the sim is
// paused, then settles" - lived only in a human-eyeball advisory. That clock is
// a pure function of wall-clock `nowMs` (never the sim tick), so it IS
// automatable and could silently regress (a shortened settle constant, a flipped
// `>=` boundary, or an accidental coupling to the frozen sim clock). This suite
// pins it down.
//
// AMENDED 2026-08-30 (maintainer decision, post-UI-review F2), in the same commit as the code.
// This suite used to pin a 5000ms TTL that CLEARED the ring. Phase 67 promoted
// the ring from an alert to the sole recovery CONTROL for a stranded dock, and a
// control that deletes itself five seconds after the mistake puts the user back
// in the v7.0 FEEL row 62-d symptom the phase exists to close. The ring now
// persists until it is RESOLVED (reconnect / delete / structural edit) and the
// 5000ms mark is where the pulse SETTLES instead of where the ring dies. The
// cases that asserted the clear are rewritten rather than deleted: the boundary
// is still load-bearing, only its meaning moved.
//
// GPU-free: pixi.js is stubbed (mirroring belts.test.ts / items.test.ts). The
// alert ring is the 2nd child added to the overlay Container (addChild order:
// hover, alertRings, ...), so `layer.children[1].alpha` observes its live alpha.
// While alive the pulse alpha is bounded in [0.35, 0.80]; clearAlertRings resets
// it to 1 - a clean, unambiguous alive-vs-cleared discriminator.
vi.mock('pixi.js', () => {
  class Container {
    children: Array<{ alpha: number }> = [];
    position = { set: (): void => {} };
    addChild(...c: Array<{ alpha: number }>): unknown {
      this.children.push(...c);
      return c[0];
    }
    removeChild(): void {}
    removeChildren(): unknown[] {
      const r = this.children;
      this.children = [];
      return r;
    }
    destroy(): void {}
  }
  class Graphics {
    alpha = 1;
    // Last colour handed to stroke()/fill() — lets GPU-free tests assert the
    // palette-READ intent (e.g. pending = neutral ink, NOT build accent)
    // without a real renderer. Existing tests ignore these fields.
    lastStrokeColor: number | undefined;
    lastFillColor: number | undefined;
    // Last stroke WIDTH: the observable the BELT-08 preview-width gate reads
    // (see "draw-belt preview lane width" below). Recorded alongside the colour
    // for the same reason: it lets a GPU-free test assert what the affordance
    // actually asks the renderer to draw.
    lastStrokeWidth: number | undefined;
    // Every circle(x, y, r) since the last clear(), in call order. Added by plan
    // 66-06 for the SAME reason lastStrokeWidth was: the resting wire affordance
    // paints a VARIABLE NUMBER of shapes (one ring per reachable nub, plus a disc
    // on the grabbed one), and a last-write-wins colour field cannot see a count or
    // a radius. Without this the only assertable fact would be "the last circle was
    // build-coloured", which is true of an implementation that paints one ring for
    // a twelve-nub board.
    circles: Array<{ x: number; y: number; r: number }> = [];
    // Every moveTo/lineTo vertex since the last clear(), in call order. Added by plan
    // 66-08 for the same reason `circles` was added by 66-06: the D1 lane displacement
    // is a change to WHERE the corridor preview is stroked, and a stub that drops the
    // arguments cannot see a position at all. Without this, `showRoute` could ignore
    // its `lane` argument entirely and every test in the repository would still pass -
    // the ghost would promise a corridor the landed cable declines to take, silently.
    pts: Array<{ x: number; y: number }> = [];
    // Every stroke() since the last clear(), in call order. Added by plan 72-11 for the
    // reason `pts` and `circles` were added before it: `showRoute` now strokes a VARIABLE
    // NUMBER of corridors (the drag's own leg plus the paired leg D-04 will mint beside
    // it), and a last-write-wins colour field cannot see a count. Without this, an
    // implementation that dropped the second leg on the floor - or tinted it a different
    // colour - would leave every assertion in the repository green while the drag on
    // screen promised one cable and the release landed two.
    strokes: Array<{ color: number | undefined; width: number | undefined }> = [];
    // THE ORDERED INSTRUCTION LOG (phase 92, CHROME-18): each circle and rect with the fill or
    // stroke that inked it, so the ghost's nubs can be graded by shape AND colour. The
    // last-write colour fields above cannot say which circle a colour belongs to.
    ops: Array<{ op: string; x?: number; y?: number; r?: number; color?: number; width?: number }> = [];
    label = '';
    anchor = { set: (): void => {} };
    position = { set: (): void => {} };
    clear(): this {
      this.lastStrokeColor = undefined;
      this.lastFillColor = undefined;
      this.lastStrokeWidth = undefined;
      this.circles = [];
      this.pts = [];
      this.strokes = [];
      this.ops = [];
      return this;
    }
    circle(x?: number, y?: number, r?: number): this {
      this.circles.push({ x: x ?? 0, y: y ?? 0, r: r ?? 0 });
      this.ops.push({ op: 'circle', x: x ?? 0, y: y ?? 0, r: r ?? 0 });
      return this;
    }
    stroke(o?: { color?: number; width?: number }): this {
      if (o && typeof o.color === 'number') this.lastStrokeColor = o.color;
      if (o && typeof o.width === 'number') this.lastStrokeWidth = o.width;
      this.strokes.push({ color: o?.color, width: o?.width });
      this.ops.push({ op: 'stroke', color: o?.color, width: o?.width });
      return this;
    }
    roundRect(): this {
      this.ops.push({ op: 'roundRect' });
      return this;
    }
    rect(x?: number, y?: number): this {
      this.ops.push({ op: 'rect', x, y });
      return this;
    }
    poly(): this {
      return this;
    }
    moveTo(x?: number, y?: number): this {
      this.pts.push({ x: x ?? 0, y: y ?? 0 });
      return this;
    }
    lineTo(x?: number, y?: number): this {
      this.pts.push({ x: x ?? 0, y: y ?? 0 });
      return this;
    }
    arc(): this {
      return this;
    }
    fill(o?: { color?: number }): this {
      if (o && typeof o.color === 'number') this.lastFillColor = o.color;
      this.ops.push({ op: 'fill', color: o?.color });
      return this;
    }
    arcTo(): this {
      return this;
    }
    destroy(): void {}
  }
  return {
    Container,
    Graphics,
    Sprite: class {
      texture: unknown;
      anchor = { set: (): void => {} };
      position = { set: (): void => {} };
    },
    Texture: class {},
    BufferImageSource: class {},
  };
});

const { createOverlay } = await import('./overlay.ts');
const { CABLE_LANE_OFFSET } = await import('./wires.ts');
const { NO_NUB, nubEndAt } = await import('../cableGeometry.ts');
const { cableLane } = await import('../cableLane.ts');
const { wireRoute, cellBody } = await import('../../protocol/wireRoute.ts');
const { CELL } = await import('../../../shared/geometry.ts');

// A FROZEN (paused) sim scene: the ring timer must never read this - its pulse
// rides wall-clock `nowMs` alone, so a paused sim still pulses.
const pausedScene = (): (() => SceneState) => {
  const scene = { tick: 42, nodes: new Map(), belts: new Map() } as unknown as SceneState;
  return () => scene;
};

/** The alert-ring Graphics: 2nd child in the overlay Container. */
function ringAlpha(api: { layer: { children: Array<{ alpha: number }> } }): number {
  return api.layer.children[1].alpha;
}

const PT = [{ x: 100, y: 100 }];
/** Where the pulse SETTLES (it used to be where the ring died). */
const SETTLE = 5000;
/** The calm steady alpha the settled ring holds: 0.75, `pal.fault` over the ground at 3.22 : 1
 *  (phase 89 UI review UI-03; it was the pulse midpoint 0.575, 2.37 : 1). The reduced-motion arm
 *  holds it from birth. */
const SETTLED_ALPHA = 0.75;
/** Where the pulse hands over to it: the first RISING crossing of 0.75 at or after 5000 ms,
 *  5000 + 1000 * asin(2 * (0.75 - 0.35) / 0.45 - 1) / (2 PI), about 5141.8 ms. */
const SETTLE_AT = 5000 + (1000 * Math.asin((2 * (0.75 - 0.35)) / 0.45 - 1)) / (2 * Math.PI);

describe('overlay alert-ring pulse + settle (MOTION-06a)', () => {
  it('PULSES for the full first 5000ms: at t=4999ms the alpha is still in the pulse band', () => {
    const api = createOverlay(pausedScene());
    api.showAlertRings(PT, 1000); // born at wall-clock 1000ms

    api.tick(1000 + 4999); // one ms before the settle
    const a = ringAlpha(api);
    // Alive -> the pulse alpha, never the cleared sentinel (1).
    expect(a).not.toBe(1);
    expect(a).toBeGreaterThanOrEqual(0.35 - 1e-9);
    expect(a).toBeLessThanOrEqual(0.8 + 1e-9);
  });

  it('SETTLES on the pulse rise through the calm steady alpha just after 5000ms, with no step, and stops moving', () => {
    const api = createOverlay(pausedScene());
    api.showAlertRings(PT, 1000);

    // At 5000ms the pulse is at its midpoint, still pulsing.
    api.tick(1000 + SETTLE);
    expect(ringAlpha(api)).toBeCloseTo(0.575, 6);
    // A millisecond before the hand-over the pulse is a hair under the settled value, and at the
    // hand-over it IS the settled value: continuous, no jump (UI-03 raised it above the midpoint).
    api.tick(1000 + SETTLE_AT - 1);
    const before = ringAlpha(api);
    expect(before).toBeLessThan(SETTLED_ALPHA);
    expect(SETTLED_ALPHA - before, 'no visible step at the hand-over').toBeLessThan(0.005);
    api.tick(1000 + SETTLE_AT + 0.001);
    expect(ringAlpha(api)).toBeCloseTo(SETTLED_ALPHA, 9);

    // It STOPS SHOUTING: two frames a half 1Hz cycle apart, which the pulse
    // would ride from 0.80 to 0.35, now read the identical steady value.
    api.tick(1000 + SETTLE_AT + 250);
    const a = ringAlpha(api);
    api.tick(1000 + SETTLE_AT + 750);
    expect(ringAlpha(api)).toBe(a);
    expect(a).toBeCloseTo(SETTLED_ALPHA, 9);
  });

  it('the settled ring plots the fault colour at 3:1 or more against the ground (UI-03, WCAG 1.4.11)', () => {
    const lin = (c: number): number => {
      const v = c / 255;
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    const lum = (rgb: number): number =>
      0.2126 * lin((rgb >> 16) & 255) + 0.7152 * lin((rgb >> 8) & 255) + 0.0722 * lin(rgb & 255);
    const over = (fg: number, bg: number, a: number): number =>
      [16, 8, 0].reduce((acc, sh) => acc | (Math.round(a * ((fg >> sh) & 255) + (1 - a) * ((bg >> sh) & 255)) << sh), 0);
    const FAULT = 0xf0506e; // LOCKED_SKIN accents.fault
    const GROUND = 0x1b1f27; // LOCKED_SKIN ramp[0]
    const plotted = over(FAULT, GROUND, SETTLED_ALPHA);
    const ratio = (lum(plotted) + 0.05) / (lum(GROUND) + 0.05);
    expect(ratio, `settled ring #${plotted.toString(16)} on #1b1f27`).toBeGreaterThanOrEqual(3);
  });

  it('PERSISTS UNTIL RESOLVED: the ring is still alive and pressable minutes later', () => {
    // THE CASE THE OLD TTL FAILED. Phase 67 made this ring the sole recovery
    // control for a stranded dock (67-UI-SPEC 4.2), and `gestures.ts` gates the
    // PRESS on `alertRingsActive()`. A ring that expired on a clock therefore
    // took the recovery gesture with it five seconds after the mistake - the
    // v7.0 FEEL row 62-d symptom the phase exists to close, reintroduced by the
    // phase itself. A stranded dock is a real broken state, not a transient
    // notification: it must not heal by being ignored.
    const api = createOverlay(pausedScene());
    api.showAlertRings(PT, 1000);

    api.tick(1000 + SETTLE + 60_000); // a minute past the old TTL
    expect(ringAlpha(api), 'not the cleared sentinel').not.toBe(1);
    expect(api.alertRingsActive(), 'still pressable - the press gate reads this').toBe(true);

    api.tick(1000 + SETTLE + 600_000); // ten minutes
    expect(api.alertRingsActive()).toBe(true);
    expect(ringAlpha(api)).toBeCloseTo(SETTLED_ALPHA, 9);
  });

  it('KEEPS PULSING while the sim is paused: alpha varies with wall-clock nowMs alone', () => {
    // getScene returns a frozen tick=42 scene the whole time; the pulse must still
    // move purely off nowMs (proves the ring is NOT tied to the frozen sim clock).
    const api = createOverlay(pausedScene());
    api.showAlertRings(PT, 0);

    // Quarter-second and three-quarter-second into the 1Hz sine ride the extremes.
    api.tick(250); // sin(2π*0.25)=+1 -> alpha = 0.35 + 0.45*1 = 0.80
    const peak = ringAlpha(api);
    api.tick(750); // sin(2π*0.75)=-1 -> alpha = 0.35 + 0.45*0 = 0.35
    const trough = ringAlpha(api);

    expect(peak).toBeCloseTo(0.8, 6);
    expect(trough).toBeCloseTo(0.35, 6);
    expect(peak).not.toBeCloseTo(trough, 3); // it genuinely pulses, not a static ring
  });

  it('starts NO clock when shown with zero points (no born-time -> no pulse, no settle)', () => {
    const api = createOverlay(pausedScene());
    api.showAlertRings([], 1000);
    // alertBornMs stays null (pts.length === 0) -> every tick is an early-return
    // no-op: the alpha never pulses and never runs a settle countdown. Drive well
    // past the settle mark and across pulse extrema; the alpha must be frozen.
    const before = ringAlpha(api);
    api.tick(1250); // would be a pulse PEAK if a clock were running
    api.tick(1000 + SETTLE + 1); // would have SETTLED if a clock were running
    expect(ringAlpha(api)).toBe(before);
    expect(api.alertRingsActive()).toBe(false);
  });

  it('THE ONLY WAY OUT: a structural edit clears the ring, at any age', () => {
    // `clearAlertRings` is the branch App.tsx fires on isStructuralEdit === true,
    // and since the TTL was retired it is the ONLY thing that ends a ring's life
    // (alongside `clearAlertRingAt` on a press, which routes through it on the
    // last ring). The edit-clear half of the lifetime contract is unchanged by
    // the 2026-08-30 amendment; it is now the whole contract.
    const api = createOverlay(pausedScene());
    api.showAlertRings(PT, 0);
    api.tick(1000); // alive mid-pulse
    expect(ringAlpha(api)).not.toBe(1);

    api.clearAlertRings(); // structural edit -> clear now
    expect(ringAlpha(api)).toBe(1);
    expect(api.alertRingsActive()).toBe(false);
    // Subsequent ticks do not resurrect it.
    api.tick(2000);
    expect(ringAlpha(api)).toBe(1);

    // ...and the same is true of a ring that has already SETTLED - age does not
    // make it un-clearable, which is the half that says "until resolved" rather
    // than "forever".
    api.showAlertRings(PT, 0);
    api.tick(SETTLE + 30_000);
    expect(api.alertRingsActive()).toBe(true);
    api.clearAlertRings();
    expect(api.alertRingsActive()).toBe(false);
    expect(ringAlpha(api)).toBe(1);
  });
});

// 67-REVIEW WR-03 — `clearAlertRingAt` retires ONE ring and reports the outcome.
//
// The press-side retire and the gesture layer's own `strandedRings` record are two
// sets that must stay in step, and nothing enforces that mechanically: they agree
// only because App.tsx hands the same `{x, y}` object literal to `showAlertRings`
// and to `setStrandedRings`, and the match here is EXACT coordinate equality. Both
// halves of the old implementation broke that pairing in a way no test could see -
// a `filter` retired EVERY point at the coordinate, and a miss returned silently
// while the caller dropped its record anyway.
describe('overlay clearAlertRingAt retires exactly one ring (67-REVIEW WR-03)', () => {
  /** The alert-ring Graphics child (2nd), whose `circles` log is the painted set.
   *  Cast for the same reason `ringAlpha` reaches into `children` above: the stub
   *  Graphics records what was asked of it, and `ContainerChild` does not model that. */
  const painted = (api: ReturnType<typeof createOverlay>): Array<{ x: number; y: number; r: number }> =>
    (api.layer.children[1] as unknown as { circles?: Array<{ x: number; y: number; r: number }> })
      .circles ?? [];

  it('two rings sharing a coordinate: one press retires ONE of them, not both', () => {
    const api = createOverlay(pausedScene());
    // A Rotate CAN strand two belt ends that resolve to the same centre (or a belt
    // end coinciding with a vacated nub point), so this is a real board, not a
    // contrived one - and it is the only shape in which "exactly one" differs from
    // "every match".
    api.showAlertRings(
      [
        { x: 100, y: 100 },
        { x: 100, y: 100 },
        { x: 300, y: 100 },
      ],
      0,
    );
    expect(painted(api)).toHaveLength(3);

    expect(api.clearAlertRingAt({ x: 100, y: 100 }), 'the retire found a ring').toBe(true);

    const after = painted(api);
    expect(after, 'ONE of the two coincident rings survives, and so does the far one').toEqual([
      { x: 100, y: 100, r: 8 },
      { x: 300, y: 100, r: 8 },
    ]);

    // ...and the survivor is still retirable, one press at a time.
    expect(api.clearAlertRingAt({ x: 100, y: 100 })).toBe(true);
    expect(painted(api)).toEqual([{ x: 300, y: 100, r: 8 }]);
  });

  it('a MISS answers false and leaves every painted ring exactly where it was', () => {
    const api = createOverlay(pausedScene());
    api.showAlertRings([{ x: 100, y: 100 }], 0);

    // One pixel off. Coordinate equality is exact, so this is a miss - and the
    // caller has to be TOLD, because dropping its record on a silent no-op would
    // leave a ring painted with nothing pressable under it.
    expect(api.clearAlertRingAt({ x: 100, y: 101 })).toBe(false);
    expect(painted(api)).toEqual([{ x: 100, y: 100, r: 8 }]);
    expect(ringAlpha(api), 'and the pulse/settle state is untouched by a miss').not.toBe(1);
  });

  it('retiring the LAST ring routes through clearAlertRings and still answers true', () => {
    const api = createOverlay(pausedScene());
    api.showAlertRings([{ x: 100, y: 100 }], 0);
    api.tick(1000);
    expect(ringAlpha(api)).not.toBe(1);

    expect(api.clearAlertRingAt({ x: 100, y: 100 })).toBe(true);
    expect(painted(api)).toEqual([]);
    expect(ringAlpha(api), 'the alpha + born-time reset is the clearAlertRings one').toBe(1);
  });
});

// IX-05 — the two NEW honest-feedback overlay affordances (30-01). Both are
// modelled on the alert-ring pulse above and ride the SAME wall-clock
// `tick(nowMs)` heartbeat. The pending shimmer marks a placed cell in NEUTRAL
// ink (never build accent — build would falsely read as committed success)
// while awaiting the host echo; the reject flash is a one-shot fault fade fired
// by an illegal-cell click. Colour intent is asserted via the palette READ the
// mock records (lastStrokeColor/lastFillColor), not a literal hex.
//
// Z-order (createOverlay addChild): hover(0), alertRings(1), route(2),
// beltPreview(3), heldBelts(4), rejectFlash(5), selection(6), beltHandles(7),
// handleRing(8), draggedHandle(9), nubRing(10), wireTargets(11), dockTargets(12),
// rotateHandle(13), pending(14), ghost(15) - pending sits above hover/selection but
// below the cursor-following ghost; reject flash near the selection slot.
//
// PLAN 66-06 INSERTED `wireTargets` DIRECTLY ABOVE `nubRing`, and the shift was
// MEASURED rather than assumed. Only ONE of this file's four hard-coded indices
// moved: `PENDING_IDX` 11 -> 12 (five pending-shimmer cases reddened). `REJECT_IDX`
// (4), `BELT_PREVIEW_IDX` (3) and the bare `children[1]` alert-ring read all sit
// BELOW the insertion point and were untouched, which the run confirmed rather than
// the plan predicting it. `nubRing` also does NOT move: an insertion ABOVE it leaves
// it at 9. The prose chain in overlay.ts moved in the same commit as this one.
//
// PLAN 74-05 INSERTED `dockTargets` DIRECTLY ABOVE `wireTargets`, for the armed BELT
// tool's target rings, and the shift was MEASURED the same way: only `PENDING_IDX`
// moved again, 12 -> 13 (the same five pending-shimmer cases reddened and nothing
// else). `WIRE_TARGETS_IDX` (10), `NUB_RING_IDX` (9), `REJECT_IDX` (4), `ROUTE_IDX`
// (2) and the bare `children[1]` alert-ring read all sit at or below the insertion
// point and were untouched. Both prose chains moved in this same commit.
//
// PLAN 74.1-30 INSERTED `heldBelts` DIRECTLY ABOVE `beltPreview` (the held pictures of
// committed belts). Every index above it moved by one: `REJECT_IDX` 4 -> 5,
// `NUB_RING_IDX` 9 -> 10, `WIRE_TARGETS_IDX` 10 -> 11, `DOCK_TARGETS_IDX` 11 -> 12,
// `PENDING_IDX` 13 -> 14. `ROUTE_IDX` (2), `BELT_PREVIEW_IDX` (3) and the bare
// `children[1]` alert-ring read sit below it and did not move.
//
// PLAN 76-03 INSERTED `labelResize` (the label's pending-size outline) DIRECTLY ABOVE
// `rotateHandle`. Only `PENDING_IDX` moved, 14 -> 15 (the same five pending-shimmer cases
// reddened, measured, and nothing else); every other index here sits below it.
type RecGraphics = {
  alpha: number;
  lastStrokeColor: number | undefined;
  lastFillColor: number | undefined;
  lastStrokeWidth?: number | undefined;
  circles?: Array<{ x: number; y: number; r: number }>;
  pts?: Array<{ x: number; y: number }>;
  strokes?: Array<{ color: number | undefined; width: number | undefined }>;
};
const ROUTE_IDX = 2;
const REJECT_IDX = 5;
const NUB_RING_IDX = 10;
const WIRE_TARGETS_IDX = 11;
const DOCK_TARGETS_IDX = 12;
const PENDING_IDX = 15;
function pendingG(api: { layer: { children: Array<{ alpha: number }> } }): RecGraphics {
  return api.layer.children[PENDING_IDX] as unknown as RecGraphics;
}
function rejectG(api: { layer: { children: Array<{ alpha: number }> } }): RecGraphics {
  return api.layer.children[REJECT_IDX] as unknown as RecGraphics;
}

// LOCKED_SKIN palette reads (createOverlay defaults to LOCKED_SKIN). The pending
// shimmer must use the NEUTRAL ramp read (deriveAffordancePalette.nubNeutral =
// ramp[len-2]); the reject flash uses the fault accent. Neither may be `build`.
const RAMP = LOCKED_SKIN.palette.ramp;
const NEUTRAL = RAMP[RAMP.length - 2];
const BUILD = LOCKED_SKIN.palette.accents.build;
const FAULT = LOCKED_SKIN.palette.accents.fault;

const CELL_1x1 = { w: 1, h: 1, rot: 0 };
const PENDING_FLOOR = 0.3;
const PENDING_AMP = 0.25;
const PENDING_HZ = 1.5;

describe('overlay pending shimmer (IX-05)', () => {
  it('pulses within the 0.30..0.55 band off wall-clock ticks (two phases differ)', () => {
    const api = createOverlay(pausedScene());
    api.showPending({ cx: 3, cy: 4 }, CELL_1x1);

    // nowMs=500 -> 1.5*0.5=0.75 -> sin(2π*0.75)=-1 -> alpha = floor = 0.30 (trough)
    api.tick(500);
    const trough = pendingG(api).alpha;
    // nowMs=1000 -> 1.5*1=1.5 -> sin(2π*1.5)=sin(3π)=0 -> alpha = 0.30+0.25*0.5 = 0.425
    api.tick(1000);
    const mid = pendingG(api).alpha;

    const expectedTrough =
      PENDING_FLOOR + PENDING_AMP * (0.5 + 0.5 * Math.sin(2 * Math.PI * PENDING_HZ * 0.5));
    const expectedMid =
      PENDING_FLOOR + PENDING_AMP * (0.5 + 0.5 * Math.sin(2 * Math.PI * PENDING_HZ * 1.0));
    expect(trough).toBeCloseTo(expectedTrough, 6);
    expect(mid).toBeCloseTo(expectedMid, 6);
    // Both inside the legibility band, and genuinely different phases.
    for (const a of [trough, mid]) {
      expect(a).toBeGreaterThanOrEqual(PENDING_FLOOR - 1e-9);
      expect(a).toBeLessThanOrEqual(PENDING_FLOOR + PENDING_AMP + 1e-9); // 0.55
    }
    expect(trough).not.toBeCloseTo(mid, 3);
  });

  it('paints NEUTRAL ink (never the build accent) — the false-success removal', () => {
    const api = createOverlay(pausedScene());
    api.showPending({ cx: 0, cy: 0 }, CELL_1x1);
    api.tick(1000);
    const g = pendingG(api);
    expect(g.lastStrokeColor).toBe(NEUTRAL);
    expect(g.lastStrokeColor).not.toBe(BUILD);
    expect(g.lastFillColor).not.toBe(BUILD);
  });

  it('clearPending() empties the shimmer (no residual colour/geometry)', () => {
    const api = createOverlay(pausedScene());
    api.showPending({ cx: 2, cy: 2 }, CELL_1x1);
    api.tick(300);
    expect(pendingG(api).lastStrokeColor).toBe(NEUTRAL);

    api.clearPending();
    expect(pendingG(api).lastStrokeColor).toBeUndefined();
    // A later tick after clear does NOT resurrect the shimmer.
    api.tick(600);
    expect(pendingG(api).lastStrokeColor).toBeUndefined();
  });

  it('keeps shimmering regardless of sim pause (wall-clock driven, frozen scene)', () => {
    // pausedScene() is a frozen tick=42 scene; the pulse must move off nowMs alone.
    const api = createOverlay(pausedScene());
    api.showPending({ cx: 1, cy: 1 }, CELL_1x1);
    api.tick(166.6666667); // 1.5*t=0.25 -> sin(π/2)=+1 -> alpha = 0.55 (peak)
    const peak = pendingG(api).alpha;
    api.tick(500); // trough 0.30
    const trough = pendingG(api).alpha;
    expect(peak).toBeCloseTo(0.55, 6);
    expect(trough).toBeCloseTo(0.3, 6);
    expect(peak).not.toBeCloseTo(trough, 3);
  });
});

describe('overlay reject flash (IX-05)', () => {
  it('fires a decaying one-shot then auto-clears past ~180ms', () => {
    const api = createOverlay(pausedScene());
    api.showRejectFlash({ cx: 5, cy: 5 }, CELL_1x1);

    // First tick stamps birth; e=0 -> full flash.
    api.tick(0);
    const born = rejectG(api).alpha;
    // Mid-window: decays but non-zero.
    api.tick(60);
    const early = rejectG(api).alpha;
    api.tick(120);
    const late = rejectG(api).alpha;

    expect(born).toBeGreaterThan(0);
    expect(early).toBeGreaterThan(0);
    expect(late).toBeGreaterThan(0);
    // Monotonic decay across the window.
    expect(early).toBeLessThan(born);
    expect(late).toBeLessThan(early);

    // At/after 180ms the flash auto-clears (alpha driven to the cleared sentinel 0).
    api.tick(180);
    expect(rejectG(api).alpha).toBe(0);
    // Stays cleared — no revival on later ticks.
    api.tick(400);
    expect(rejectG(api).alpha).toBe(0);
  });

  it('paints the FAULT accent (never build)', () => {
    const api = createOverlay(pausedScene());
    api.showRejectFlash({ cx: 0, cy: 0 }, CELL_1x1);
    api.tick(0);
    const g = rejectG(api);
    expect(g.lastStrokeColor).toBe(FAULT);
    expect(g.lastStrokeColor).not.toBe(BUILD);
    expect(g.lastFillColor).toBe(FAULT);
  });

  it('clearRejectFlash() empties it immediately, independent of the timer', () => {
    const api = createOverlay(pausedScene());
    api.showRejectFlash({ cx: 3, cy: 3 }, CELL_1x1);
    api.tick(0);
    expect(rejectG(api).lastStrokeColor).toBe(FAULT);

    api.clearRejectFlash();
    expect(rejectG(api).lastStrokeColor).toBeUndefined();
    expect(rejectG(api).alpha).toBe(0);
    // No resurrection.
    api.tick(60);
    expect(rejectG(api).lastStrokeColor).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// SAFE-02 / D-25 — the reduced-motion CLOCK SPLIT
// ---------------------------------------------------------------------------
//
// Pre-Phase-64 the render loop implemented `prefers-reduced-motion` by feeding
// `overlay.tick` a CONSTANT captured at pin time. That made every elapsed value
// inside `tick` identically zero, so the 180ms reject flash never decayed and
// never cleared — an illegal-cell click left a permanent red box on the canvas
// for the rest of the session. The alert-ring clock failed worse: App.tsx stamps
// `alertBornMs` from a LIVE `performance.now()`, so a ring born after the pin had
// a NEGATIVE elapsed value and could never reach its boundary either. (That
// boundary was a 5000ms TTL then and is the 5000ms pulse SETTLE now - the bug
// shape is the same and so is the cure.)
//
// The cure is a SPLIT, not a bigger freeze: `nowMs` is always the real wall
// clock, and a boolean `motionFrozen` gates exactly the two sinusoid alphas.
// These tests hold that split from the overlay side. The composed proof that
// the loop stopped freezing the feed is `loop.test.ts`'s rewritten pinOverlay
// suite; what is load-bearing HERE is that the flag never reaches an elapsed,
// TTL or decay computation. The obvious wrong implementation — gate the whole
// tick, or substitute a frozen timestamp inside it — reinstates the shipped bug
// verbatim, and the first three tests below are what refuse it.
/** The value the frozen arm holds: the settled alpha, 0.75 since the phase 89 UI review (UI-03),
 *  so a reduced-motion user's steady ring clears 3:1 too. It used to be the pulse's mid-band seed
 *  (FLOOR + AMP * 0.5 = 0.575), which `showAlertRings` still seeds before the first tick. */
const ALERT_FROZEN_ALPHA = 0.75;
/** Likewise for `showPending` (0.425). */
const PENDING_FROZEN_ALPHA = PENDING_FLOOR + PENDING_AMP * 0.5;

describe('overlay reduced-motion clock split (SAFE-02, D-25)', () => {
  it('LOAD-BEARING: the 180ms reject flash EXPIRES under motionFrozen — the flag never reaches the decay', () => {
    const api = createOverlay(pausedScene());
    api.showRejectFlash({ cx: 5, cy: 5 }, CELL_1x1);

    api.tick(1000, true); // stamps birth off the REAL clock, frozen or not
    expect(rejectG(api).alpha).toBeGreaterThan(0); // alive at full flash
    api.tick(1200, true); // 200ms of real time later — past REJECT_MS (180)
    expect(rejectG(api).alpha).toBe(0); // the cleared sentinel
    api.tick(5000, true); // and no resurrection on later frozen frames
    expect(rejectG(api).alpha).toBe(0);
  });

  it('the unfrozen reject-flash path does not regress (motionFrozen = false)', () => {
    const api = createOverlay(pausedScene());
    api.showRejectFlash({ cx: 5, cy: 5 }, CELL_1x1);
    api.tick(1000, false);
    expect(rejectG(api).alpha).toBeGreaterThan(0);
    api.tick(1200, false);
    expect(rejectG(api).alpha).toBe(0);
  });

  it('the alert SETTLE crosses under motionFrozen too (the negative-elapsed bug)', () => {
    // AMENDED 2026-08-30 with the TTL retirement. This case used to assert the
    // ring EXPIRED while frozen; there is no expiry any more, so it asserts the
    // surviving half of the same bug: `motionFrozen` must never reach an elapsed
    // computation. App.tsx stamps the birth off a LIVE `performance.now()`, so a
    // frozen timestamp fed into `tick` drove elapsed NEGATIVE and the ring never
    // crossed its boundary at all. The boundary is now the settle, and the proof
    // that elapsed is real is that a frozen frame past it reads the SETTLED value
    // rather than the cleared sentinel - and that the ring is still alive, which
    // is what a reduced-motion user's recovery gesture depends on.
    const api = createOverlay(pausedScene());
    api.showAlertRings(PT, 1000); // born off App.tsx's LIVE performance.now()
    api.tick(1000 + SETTLE + 1, true);
    expect(ringAlpha(api)).toBeCloseTo(ALERT_FROZEN_ALPHA, 9);
    expect(ringAlpha(api), 'never the cleared sentinel').not.toBe(1);
    expect(api.alertRingsActive(), 'a frozen clock never retires the ring').toBe(true);
  });

  it('HOLDS the alert pulse at the settled value while frozen', () => {
    const api = createOverlay(pausedScene());
    api.showAlertRings(PT, 1000);

    // 100ms and 600ms in: a half 1Hz cycle apart, so an UNFROZEN pulse would ride
    // from +0.588 to -0.588 of the sine. Frozen, both frames read the seed.
    api.tick(1100, true);
    const a = ringAlpha(api);
    api.tick(1600, true);
    const b = ringAlpha(api);
    expect(a).toBeCloseTo(ALERT_FROZEN_ALPHA, 9);
    expect(b).toBe(a);
  });

  it('HOLDS the pending shimmer at the seeded mid-band value while frozen', () => {
    const api = createOverlay(pausedScene());
    api.showPending({ cx: 3, cy: 4 }, CELL_1x1);

    // 500ms unfrozen is the 0.30 trough; 1000ms unfrozen is 0.425. Frozen, both
    // read 0.425, so the 500ms frame is what discriminates.
    api.tick(500, true);
    const a = pendingG(api).alpha;
    api.tick(1000, true);
    const b = pendingG(api).alpha;
    expect(a).toBeCloseTo(PENDING_FROZEN_ALPHA, 9);
    expect(b).toBe(a);
  });

  it('defaults to UNFROZEN when the flag is omitted — the whole existing suite is that contract', () => {
    // Every other test in this file calls the one-argument form. This one states
    // the default explicitly: with the flag absent the pulse still moves.
    const api = createOverlay(pausedScene());
    api.showAlertRings(PT, 1000);
    api.tick(1100);
    const a = ringAlpha(api);
    api.tick(1600);
    const b = ringAlpha(api);
    expect(a).not.toBeCloseTo(b, 3);
    expect(a).not.toBeCloseTo(ALERT_FROZEN_ALPHA, 3);
  });
});

// ---------------------------------------------------------------------------
// BELT-08: the draw-belt preview's LANE WIDTH is the record's lane
// ---------------------------------------------------------------------------
//
// The v7.0 milestone audit (2026-08-11) found BELT-08's single-source claim
// FALSE for lane width: `overlay.ts` carried `const PREVIEW_W = 10`, a bare
// module-private literal, while the committed tread read `BELT_GEOM.laneHalf`
// (10) as a HALF-width, i.e. a 20px lane. The preview therefore drew at half the
// committed width, and an edit to `laneHalf` moved the belt and left the preview
// behind, exactly the drift BELT-08 says cannot happen. `shared/geometry.ts`
// asserted a binding no code expressed and no test held.
//
// This is that test. It reads the stroke width the preview actually hands the
// renderer and asserts it is the FULL lane, `2 * BELT_GEOM.laneHalf`. It is
// written against the derivation, not against the number 20, so a future lane
// edit moves the expectation and the preview together or fails here.
//
// The `laneHalf` (half-lane) alternative was considered and REJECTED by the maintainer on
// 2026-08-11: it is byte-identical to the old literal today, so it would have
// frozen a coincidence into a rule nobody chose ("the preview is half the lane").
// The preview is the belt that will land, at the width it will land.
const BELT_PREVIEW_IDX = 3;
function beltPreviewG(api: {
  layer: { children: Array<{ alpha: number }> };
}): RecGraphics & { lastStrokeWidth: number | undefined } {
  return api.layer.children[BELT_PREVIEW_IDX] as unknown as RecGraphics & {
    lastStrokeWidth: number | undefined;
  };
}

/** A two-tile straight run; `drawBeltTilePath` needs only cells + kinds. */
const PREVIEW_TILES = [
  { cell_x: 2, cell_y: 3, kind: { Straight: { axis: 0 } } },
  { cell_x: 3, cell_y: 3, kind: { Straight: { axis: 0 } } },
] as unknown as Parameters<ReturnType<typeof createOverlay>['showBeltPreview']>[0];

describe('draw-belt preview lane width (BELT-08 single source)', () => {
  it('strokes the FULL record lane, 2 * BELT_GEOM.laneHalf, not a local literal', () => {
    const api = createOverlay(pausedScene());
    api.showBeltPreview(PREVIEW_TILES, true);
    expect(beltPreviewG(api).lastStrokeWidth).toBe(2 * BELT_GEOM.laneHalf);
  });

  it('is NOT the half-lane: the preview and the committed tread span the same px', () => {
    // The discriminator. `laneHalf` alone (10) is what the audited literal
    // happened to equal, so an assertion that passed at 10 would prove nothing.
    // The committed tread spans laneHalf either side of the centreline; the
    // preview stroke is centred on that same centreline, so equal SPAN means the
    // stroke width equals the full lane and strictly exceeds the half-lane.
    const api = createOverlay(pausedScene());
    api.showBeltPreview(PREVIEW_TILES, true);
    const w = beltPreviewG(api).lastStrokeWidth as number;
    expect(w).not.toBe(BELT_GEOM.laneHalf);
    expect(w / 2).toBe(BELT_GEOM.laneHalf);
  });

  it('holds on the invalid (fault) preview too: width is geometry, not state', () => {
    const api = createOverlay(pausedScene());
    api.showBeltPreview(PREVIEW_TILES, false);
    const g = beltPreviewG(api);
    expect(g.lastStrokeColor).toBe(FAULT);
    expect(g.lastStrokeWidth).toBe(2 * BELT_GEOM.laneHalf);
  });
});

// ---------------------------------------------------------------------------
// AN ILLEGAL PATH PAINTS (LINK-10, plan 74-13)
// ---------------------------------------------------------------------------
//
// `evalBeltPath` (`gestures.ts:549-562`) is the single evaluator for both the live
// preview and the release decision. Its route-reject arm calls
// `showBeltPreview([], false)` with a comment reading `typed reject`, meaning red -
// and `showBeltPreview` returned early on an empty list, so the intent had NEVER
// rendered. In a drag only `SelfCrossing` is reachable there (`evalBeltPath` guards
// length 0 itself and the accumulator only ever appends an orthogonally adjacent
// cell), so the blank preview has exactly ONE live cause: the user has drawn back
// over their own path and the layer is handed no geometry to say so with.
//
// THE EARLY RETURN IS NOT THE DEFECT. Clearing and returning is the only possible
// response to being handed no geometry, and it stays exactly that for a genuine
// clear. What changes is that the layer REMEMBERS the last drawable shape and
// repaints THAT in fault colour when it is asked for a typed reject, which says the
// true thing in the user's own terms: this is the path you drew, and it is now
// illegal.
//
// The rejected alternative was synthesising one-cell squares for the raw drawn
// cells. That would put a second belt-geometry source next to `drawBeltTilePath` and
// break preview-equals-commit (BELT-03) for the sake of a transient.
//
// This is a RESTORATION of a documented promise rather than a new visual language.
// The accumulator's own shipped comment in `gestures.ts` has always said a revisit
// `gets appended, route() then reports SelfCrossing and the preview goes red`. Until
// this block that sentence was false.
describe('the typed reject repaints the last shape in fault (LINK-10)', () => {
  it('a route reject with no geometry repaints the LAST shape in fault, rather than clearing the layer', () => {
    const api = createOverlay(pausedScene());
    api.showBeltPreview(PREVIEW_TILES, true);
    // THE SHAPE, captured before the reject (WR-05, added 2026-09-10). `pts` is every
    // moveTo/lineTo vertex since the last clear(), which `showBeltPreview` calls on
    // entry - so this snapshot has to be taken now, and the comparison below is
    // against a freshly-repainted list rather than an accumulated one.
    const legal = [...(beltPreviewG(api).pts ?? [])];
    api.showBeltPreview([], false);
    const g = beltPreviewG(api);
    expect(g.lastStrokeColor, 'the path the user drew is repainted, in fault').toBe(FAULT);
    expect(
      g.lastStrokeWidth,
      'at the SAME geometry as the legal preview and the committed tread (BELT-03/BELT-08)',
    ).toBe(2 * BELT_GEOM.laneHalf);
    // THE POINT OF THE WHOLE 74-13 OVERLAY CHANGE, and until this line nothing
    // asserted it. Colour and width are both INDEPENDENT of the tiles handed to
    // `drawBeltTilePath`, so the review truncated the repaint to
    // `beltPreviewLast.slice(0, 1)` - one tile instead of the whole path - and this
    // file stayed 53/53 green. `pts` is the observable plan 66-08 added for exactly
    // this class of blindness: a stub that drops its arguments cannot see a position.
    expect(legal.length, 'the legal preview drew real geometry to compare against').toBeGreaterThan(0);
    expect(g.pts, 'the SAME geometry, in fault: the whole retained path, not a stub').toEqual(legal);
  });

  it('the retained shape dies with the clear, so a red preview cannot outlive its gesture', () => {
    // The lifecycle, and it is one this layer inherits rather than one the gesture
    // controller has to remember. Every site in `gestures.ts` that sets
    // `drawnCells = null` already calls `clearBeltPreview()` in the same block, and
    // the release arm calls it too, so dropping the retained shape THERE is enough.
    const api = createOverlay(pausedScene());
    api.showBeltPreview(PREVIEW_TILES, true);
    api.clearBeltPreview();
    api.showBeltPreview([], false);
    expect(
      beltPreviewG(api).lastStrokeColor,
      'a reject with no gesture behind it has nothing to say and says nothing',
    ).toBeUndefined();
  });

  it('an empty-and-VALID call is a genuine clear and still paints nothing', () => {
    // The narrowing. Only the typed reject repaints; being handed no geometry with no
    // complaint attached is a clear, exactly as it always was. Without this case the
    // retained shape could be repainted on any empty call and nothing would notice.
    const api = createOverlay(pausedScene());
    api.showBeltPreview(PREVIEW_TILES, true);
    api.showBeltPreview([], true);
    expect(beltPreviewG(api).lastStrokeColor).toBeUndefined();
  });

  it('with NOTHING drawn yet, an empty-and-invalid call paints nothing', () => {
    // Non-vacuity for the first case: the repaint comes from the retained shape and
    // not from a fault stroke the layer would emit regardless.
    const api = createOverlay(pausedScene());
    api.showBeltPreview([], false);
    expect(beltPreviewG(api).lastStrokeColor).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The RESTING wire affordance (WIRE-05, UI-SPEC 6.2, plan 66-06)
// ---------------------------------------------------------------------------
//
// Maintainer report on the real binary 2026-08-25 (WINDOWS row 113): "DOCKING IS UNDISCOVERABLE
// ... That gesture is silently inert: no preview, no reject flash, no message."
// The affordance these cases pin is the answer: arming the Wire tool rings EVERY
// reachable nub on the board BEFORE the user presses anything, so the board itself
// says where a wire can start. The gesture-side wiring is pinned in gestures.test.ts;
// what is pinned HERE is that the overlay paints the right shapes, in the right
// colour, in the right z-slot.
function wireTargetsG(api: { layer: { children: Array<{ alpha: number }> } }): RecGraphics {
  return api.layer.children[WIRE_TARGETS_IDX] as unknown as RecGraphics;
}
function nubRingG(api: { layer: { children: Array<{ alpha: number }> } }): RecGraphics {
  return api.layer.children[NUB_RING_IDX] as unknown as RecGraphics;
}

describe('overlay resting wire targets (WIRE-05)', () => {
  const P = [
    { x: 10, y: 20, filled: false },
    { x: 30, y: 40, filled: false },
    { x: 50, y: 60, filled: false },
  ];

  it('paints ONE r=7 stroke-2 build ring per point, not merely a build-coloured last shape', () => {
    const api = createOverlay(pausedScene());
    api.showWireTargets(P);
    const g = wireTargetsG(api);
    // The COUNT is the assertion that matters: a three-nub board must light three
    // nubs. A colour-only check passes on an implementation that rings one of them.
    expect(g.circles).toHaveLength(3);
    expect(g.circles?.map((c) => c.r)).toEqual([7, 7, 7]);
    expect(g.circles?.map((c) => ({ x: c.x, y: c.y }))).toEqual([
      { x: 10, y: 20 },
      { x: 30, y: 40 },
      { x: 50, y: 60 },
    ]);
    // Colour intent via the palette READ, never a hex literal: `build` is the
    // reserved accent for a build/ghost/selection affordance (style bible 1a) and is
    // already what the armed nub ring paints in.
    expect(g.lastStrokeColor).toBe(BUILD);
    expect(g.lastStrokeWidth).toBe(2);
    // A ring is an AFFORDANCE, so nothing is filled until a press grabs a nub.
    expect(g.lastFillColor).toBeUndefined();
  });

  it('adds an r=5 build DISC on a filled point, so the grabbed source is visible', () => {
    // The 66-06 radius admits a real ambiguity: two Out nubs one cell apart (32
    // world px) are both inside a 22 world px radius at their midpoint. Nearest-first
    // ranking resolves it deterministically and THIS disc is what makes the
    // resolution visible before the user releases.
    const api = createOverlay(pausedScene());
    api.showWireTargets([
      { x: 10, y: 20, filled: true },
      { x: 30, y: 40, filled: false },
    ]);
    const g = wireTargetsG(api);
    // Ring + disc on the first point, ring only on the second.
    expect(g.circles).toEqual([
      { x: 10, y: 20, r: 7 },
      { x: 10, y: 20, r: 5 },
      { x: 30, y: 40, r: 7 },
    ]);
    expect(g.lastFillColor).toBe(BUILD);
  });

  it('clearWireTargets() empties it (no residual geometry or colour)', () => {
    const api = createOverlay(pausedScene());
    api.showWireTargets(P);
    api.clearWireTargets();
    const g = wireTargetsG(api);
    expect(g.circles).toEqual([]);
    expect(g.lastStrokeColor).toBeUndefined();
  });

  it('an EMPTY list paints nothing and throws nothing (a board with no electrical ports)', () => {
    // UI-SPEC 6.2 empty case: the tool arms, the cursor changes, and no ring appears.
    // "Nothing here is wireable" is legible precisely because the board stays dark.
    const api = createOverlay(pausedScene());
    expect(() => api.showWireTargets([])).not.toThrow();
    expect(wireTargetsG(api).circles).toEqual([]);
  });

  it('repainting REPLACES rather than accumulates (the armed-move recompute is idempotent)', () => {
    // gestures.ts recomputes the point list from the live scene on EVERY armed move,
    // so this function is called at pointer rate. An accumulating implementation
    // would grow the Graphics without bound and would strand rings at stale
    // positions after a keyframe remint, which is exactly what recomputing avoids.
    const api = createOverlay(pausedScene());
    api.showWireTargets(P);
    api.showWireTargets([{ x: 99, y: 99, filled: false }]);
    expect(wireTargetsG(api).circles).toEqual([{ x: 99, y: 99, r: 7 }]);
  });

  it('sits DIRECTLY ABOVE the nub ring, proven by painting both and reading two slots', () => {
    // The z-slot is asserted by IDENTITY through a paint probe, not by trusting the
    // index constants: paint only the nub ring and only slot 9 fills; paint only the
    // wire targets and only slot 10 fills. If the two Graphics were swapped in the
    // addChild list this reads them the wrong way round and reddens.
    const api = createOverlay(pausedScene());
    api.showNubRing({ x: 1, y: 2 }, true);
    expect(nubRingG(api).circles).toEqual([{ x: 1, y: 2, r: 7 }]);
    expect(wireTargetsG(api).circles).toEqual([]);

    api.showWireTargets([{ x: 3, y: 4, filled: false }]);
    expect(wireTargetsG(api).circles).toEqual([{ x: 3, y: 4, r: 7 }]);
    // The nub ring is untouched by the wire-target paint: two Graphics, two slots.
    expect(nubRingG(api).circles).toEqual([{ x: 1, y: 2, r: 7 }]);
  });
});

// ---------------------------------------------------------------------------
// The armed BELT tool's dock targets (LINK-02 / LINK-10, 74-UI-SPEC 1.2 / 3.1)
// ---------------------------------------------------------------------------
//
// Maintainer report on the real binary (WINDOWS 140): dragging a belt end onto another belt's end
// produced no dock and no visible refusal. Half of that is the model; the other half
// is that nothing on screen ever told the user where a drop could land. These cases
// pin the overlay half - the right shapes, the right colour, its OWN z-slot, and the
// separateness from the wire affordance that keeps the two tools from wiping each
// other's rings.
function dockTargetsG(api: { layer: { children: Array<{ alpha: number }> } }): RecGraphics {
  return api.layer.children[DOCK_TARGETS_IDX] as unknown as RecGraphics;
}

describe('overlay dock targets (LINK-02 / LINK-10)', () => {
  const P = [
    { x: 10, y: 20, filled: false },
    { x: 30, y: 40, filled: false },
  ];

  it('paints ONE r=7 stroke-2 build ring per point - the SAME ring the wire tool paints', () => {
    // The COUNT is the assertion that matters: a two-target board must light two
    // targets. A colour-only check passes on an implementation that rings one.
    const api = createOverlay(pausedScene());
    api.showDockTargets(P);
    const g = dockTargetsG(api);
    expect(g.circles).toEqual([
      { x: 10, y: 20, r: 7 },
      { x: 30, y: 40, r: 7 },
    ]);
    expect(g.lastStrokeColor).toBe(BUILD);
    expect(g.lastStrokeWidth).toBe(2);
    expect(g.lastFillColor).toBeUndefined();
  });

  it('is BYTE-FOR-BYTE the wire tool ring, because both call one extracted primitive', () => {
    // A copied ring is a copied radius, which is what NUB_RING_R exists to prevent.
    // Painting the same points through both APIs and comparing the recorded geometry
    // is what makes "extracted, not copied" an assertable claim rather than a comment.
    const a = createOverlay(pausedScene());
    const b = createOverlay(pausedScene());
    const pts = [
      { x: 7, y: 9, filled: true },
      { x: 11, y: 13, filled: false },
    ];
    a.showWireTargets(pts);
    b.showDockTargets(pts);
    expect(dockTargetsG(b).circles).toEqual(wireTargetsG(a).circles);
    expect(dockTargetsG(b).lastStrokeColor).toBe(wireTargetsG(a).lastStrokeColor);
    expect(dockTargetsG(b).lastStrokeWidth).toBe(wireTargetsG(a).lastStrokeWidth);
  });

  it('adds the r=5 build DISC on a filled point, exactly as the wire ring does', () => {
    const api = createOverlay(pausedScene());
    api.showDockTargets([
      { x: 10, y: 20, filled: true },
      { x: 30, y: 40, filled: false },
    ]);
    expect(dockTargetsG(api).circles).toEqual([
      { x: 10, y: 20, r: 7 },
      { x: 10, y: 20, r: 5 },
      { x: 30, y: 40, r: 7 },
    ]);
    expect(dockTargetsG(api).lastFillColor).toBe(BUILD);
  });

  it('an EMPTY list paints nothing and throws nothing (every belt Head already linked)', () => {
    // 74-UI-SPEC 1.2 empty case: the tool arms and NO ring appears, and "no join is
    // available here" is legible precisely because the board stays dark.
    const api = createOverlay(pausedScene());
    expect(() => api.showDockTargets([])).not.toThrow();
    expect(dockTargetsG(api).circles).toEqual([]);
  });

  it('repainting REPLACES rather than accumulates (the armed-move recompute is idempotent)', () => {
    const api = createOverlay(pausedScene());
    api.showDockTargets(P);
    api.showDockTargets([{ x: 99, y: 99, filled: false }]);
    expect(dockTargetsG(api).circles).toEqual([{ x: 99, y: 99, r: 7 }]);
  });

  it('clearDockTargets() empties it, and does NOT touch the wire targets', () => {
    // THE WHOLE REASON THE TWO AFFORDANCES DO NOT SHARE ONE GRAPHICS. They are live
    // under different armed tools; on a shared object each tool's clear would wipe the
    // other's rings, silently, with no gesture and no warning. Both directions are
    // asserted, because a one-way check cannot see a one-way leak.
    const api = createOverlay(pausedScene());
    api.showWireTargets([{ x: 1, y: 2, filled: false }]);
    api.showDockTargets([{ x: 3, y: 4, filled: false }]);
    api.clearDockTargets();
    expect(dockTargetsG(api).circles).toEqual([]);
    expect(wireTargetsG(api).circles).toEqual([{ x: 1, y: 2, r: 7 }]);

    api.showDockTargets([{ x: 5, y: 6, filled: false }]);
    api.clearWireTargets();
    expect(wireTargetsG(api).circles).toEqual([]);
    expect(dockTargetsG(api).circles).toEqual([{ x: 5, y: 6, r: 7 }]);
  });

  it('sits DIRECTLY ABOVE the wire targets, proven by painting each and reading two slots', () => {
    // The z-slot by IDENTITY through a paint probe, not by trusting the constants: if
    // the two Graphics were swapped in the addChild list this reads them the wrong way
    // round and reddens.
    const api = createOverlay(pausedScene());
    api.showWireTargets([{ x: 1, y: 2, filled: false }]);
    expect(wireTargetsG(api).circles).toEqual([{ x: 1, y: 2, r: 7 }]);
    expect(dockTargetsG(api).circles).toEqual([]);

    api.showDockTargets([{ x: 3, y: 4, filled: false }]);
    expect(dockTargetsG(api).circles).toEqual([{ x: 3, y: 4, r: 7 }]);
    expect(wireTargetsG(api).circles).toEqual([{ x: 1, y: 2, r: 7 }]);
  });

  it('the rotate handle still sits ABOVE both target sets after the insertion', () => {
    // The insertion moved every index above it by one. The rotate handle is cursor-
    // owned furniture and must stay on top of the board-wide resting sets; asserted by
    // a paint probe so the claim survives the next insertion too.
    const api = createOverlay(pausedScene());
    api.showDockTargets([{ x: 3, y: 4, filled: false }]);
    const rotateIdx = DOCK_TARGETS_IDX + 1;
    const rotate = api.layer.children[rotateIdx] as unknown as RecGraphics;
    expect(rotate.circles ?? []).toEqual([]);
    expect(dockTargetsG(api).circles).toEqual([{ x: 3, y: 4, r: 7 }]);
  });
});

// ---------------------------------------------------------------------------
// E14: this phase introduces ZERO new timed surfaces, stated so it can be checked
// ---------------------------------------------------------------------------
describe('overlay.tick is unchanged in SHAPE by the wire affordance (E14)', () => {
  // The resting affordance is STATIC by design: it appears with the arm, disappears
  // with the disarm, owns no TTL and no decay, and reads no clock. So `tick` gains no
  // case and `motionFrozen` gains no branch, and reduced motion has nothing to quiet.
  //
  // That is a DESIGNED property, which is why it is verified rather than taken on
  // faith. The counts are read off the shipped source at test time: a later plan that
  // gives the rings a pulse reddens here and has to argue for the new timed surface
  // (Phase 64 D-25) instead of adding it quietly.
  const SRC = readFileSync(
    join(import.meta.dirname, 'overlay.ts'),
    'utf8',
  );
  /**
   * The BODY of `const tick = (...)`, from the `=> {` to the factory's `return {`.
   * The signature is deliberately excluded: `motionFrozen = false` in the parameter
   * list is a default, not a branch, and counting it would make the branch-count case
   * read 3 for a function that branches twice.
   */
  function tickBody(): string {
    const sig = 'const tick = (nowMs: number, motionFrozen = false): void => {';
    const start = SRC.indexOf(sig);
    if (start < 0) throw new Error('overlay.ts: tick not found (signature changed?)');
    const end = SRC.indexOf('\n  return {', start);
    if (end < 0) throw new Error('overlay.ts: factory return not found after tick');
    return SRC.slice(start + sig.length, end);
  }

  it('takes (nowMs, motionFrozen) and nothing else', () => {
    expect(SRC).toContain('const tick = (nowMs: number, motionFrozen = false): void => {');
  });

  it('branches on motionFrozen exactly TWICE: the alert pulse and the pending shimmer', () => {
    const body = tickBody();
    const uses = [...body.matchAll(/motionFrozen/g)].length;
    expect(uses, 'motionFrozen branch count inside tick').toBe(2);
  });

  it('drives exactly THREE timed surfaces: alert settle, pending shimmer, reject decay', () => {
    const body = tickBody();
    // Each timed surface opens with a guard on its own retained birth/box state.
    expect(body).toContain('if (alertBornMs !== null)');
    expect(body).toContain('if (pendingBox)');
    expect(body).toContain('if (rejectBox)');
    // And nothing else in the body is a top-level timed case. Counting `if (` inside
    // tick pins that: three surface guards plus the two nested branches the reject
    // decay uses (`rejectBornMs === null`, `e >= REJECT_MS`) and the alert pulse's
    // own `elapsedMs >= ALERT_SETTLE_MS`. Six. A new timed surface moves this
    // number - and note the 2026-08-30 TTL retirement did NOT move it: the ring's
    // one branch changed meaning (clear -> settle), not existence.
    //
    // 6 -> 7 BY HAND at plan 76-03, and NOT a timed surface: the label's pending-size
    // outline re-strokes when the ZOOM moves its one-screen-pixel floor. It reads the
    // camera through `scale()`, never `nowMs`, which the two assertions after the count
    // pin, so "three timed surfaces" still holds.
    const ifs = [...body.matchAll(/\bif\s*\(/g)].length;
    expect(ifs, 'total if-statements inside tick').toBe(7);
    const resizeLine = body.split('\n').find((l) => l.includes('if (resizeBox'));
    expect(resizeLine, 'the outline guard is in tick').toBeDefined();
    expect(resizeLine, 'the outline guard reads no clock').not.toContain('nowMs');
    // The wire affordance owns no clock: `wireTargets` is never named in tick.
    expect(body).not.toContain('wireTargets');
    // NEITHER DOES THE BELT ONE (D-07, 74-UI-SPEC 1.2). The dock target rings appear
    // with the arm and disappear with the disarm; they own no TTL and read no clock, so
    // `tick` gains no case and the `if (` count above is unmoved. This is the assertion
    // that makes "nothing is painted at rest" checkable at the overlay layer rather
    // than only at the pixel-guard baselines.
    expect(body).not.toContain('dockTargets');
  });
});

// ---------------------------------------------------------------------------
// D1: the wire-route preview OCCUPIES ITS LANE (plan 66-08, 66-UI-SPEC 5.1)
// ---------------------------------------------------------------------------

/** The route-preview Graphics: 3rd child in the overlay Container. */
function routeG(api: { layer: { children: Array<{ alpha: number }> } }): RecGraphics {
  return api.layer.children[ROUTE_IDX] as unknown as RecGraphics;
}

/**
 * The route Graphics with its two VARIABLE-LENGTH recorders narrowed to non-optional, so
 * the D-04 paired-preview cases below can read a LENGTH without restating a fallback at
 * every call. The fallback is a TypeScript concern only: `RecGraphics` declares both
 * fields optional, while the recording class initialises both to `[]` and clears them to
 * `[]`, so neither is ever `undefined` at runtime. A dropped leg therefore shows up as a
 * SHORTER array and never as an absent one.
 */
function routeRec(api: { layer: { children: Array<{ alpha: number }> } }): {
  pts: Array<{ x: number; y: number }>;
  strokes: Array<{ color: number | undefined; width: number | undefined }>;
} {
  const g = routeG(api);
  return { pts: g.pts ?? [], strokes: g.strokes ?? [] };
}

describe('overlay wire-route preview lane (D1, plan 66-08)', () => {
  // (2,2) -> (6,2): a straight corridor, so the lane displacement is purely in y and
  // the arithmetic is legible. `showRoute` takes CELLS; the lane is handed in as the
  // key the landed cable is keyed on, and the overlay applies it through the SAME
  // `laneOffsetPolyline` at the SAME CABLE_LANE_OFFSET that `wires.ts` strokes with.
  const CORRIDOR = [
    { cx: 2, cy: 2 },
    { cx: 3, cy: 2 },
    { cx: 4, cy: 2 },
    { cx: 5, cy: 2 },
    { cx: 6, cy: 2 },
  ];
  const ROW = 2 * CELL + CELL / 2;
  const E = 1;
  const W = 3;
  // The corridor's two ends since plan 75-05 (D-08): an E-facing Out on (2,2) and a
  // W-facing In on (6,2), the two nubs the drag hands over. Worked by hand from
  // `nubAnchor`'s formula (CELL 32, INSET 2, NUB_PUSH 2.5):
  //   E nub of (2,2): x = 2*32 + 32 - 2 + 2.5 = 96.5, y = 2*32 + 16 = 80
  //   W nub of (6,2): x = 6*32 + 2 - 2.5     = 191.5, y = 80
  const NUBS = { from: nubEndAt(2, 2, E), to: nubEndAt(6, 2, W) };

  it('lane 0 strokes nub to nub: the two ends on the nubs, the cells between on their centres', () => {
    // CABLE-08, rewritten from the lane-0 cell-centre pin. Before plan 75-05 this pinned
    // the bare cell centres, (80, 80) to (208, 80): a corridor 16.5 px short at both ends,
    // promising a cable that landed somewhere else.
    const api = createOverlay(pausedScene());
    api.showRoute(CORRIDOR, NUBS, true, 0);
    expect(routeG(api).pts).toEqual([
      { x: 96.5, y: 80 },
      { x: 112, y: 80 },
      { x: 144, y: 80 },
      { x: 176, y: 80 },
      { x: 191.5, y: 80 },
    ]);
  });

  it('a NO_NUB end stays on its cell centre: the free corridor ends on the pointer cell', () => {
    // 75-UI-SPEC 3.1: with nothing acquired the corridor ends on the pointer's own cell
    // centre, (6,2) at (208, 80), while the pressed end is still on its nub.
    const api = createOverlay(pausedScene());
    api.showRoute(CORRIDOR, { from: nubEndAt(2, 2, E), to: NO_NUB }, true, 0);
    expect(routeG(api).pts).toEqual([
      { x: 96.5, y: 80 },
      { x: 112, y: 80 },
      { x: 144, y: 80 },
      { x: 176, y: 80 },
      { x: 208, y: 80 },
    ]);
  });

  it('lane +1 and lane -1 straddle the corridor, separated by twice the cable width', () => {
    // THE GATE THAT MAKES THE `lane` ARGUMENT REAL. Without it `showRoute` could accept
    // the key and drop it on the floor: `gestures.test.ts` would still see the key
    // handed over, `wires.test.ts` would still see the cable in its lane, and the GHOST
    // would silently mark a corridor the cable does not take - which is the precise
    // failure that disqualified the `fabrico-command` corridor offset.
    const api = createOverlay(pausedScene());
    api.showRoute(CORRIDOR, NUBS, true, 1);
    const plus = [...(routeG(api).pts ?? [])];
    api.showRoute(CORRIDOR, NUBS, true, -1);
    const minus = [...(routeG(api).pts ?? [])];

    expect(plus.every((p) => p.y === ROW + CABLE_LANE_OFFSET)).toBe(true);
    expect(minus.every((p) => p.y === ROW - CABLE_LANE_OFFSET)).toBe(true);
    for (let i = 0; i < plus.length; i++) {
      expect(plus[i].x, 'the lane never moves the corridor along its own axis').toBe(minus[i].x);
      expect(plus[i].y - minus[i].y).toBeCloseTo(2 * CABLE_LANE_OFFSET, 9);
      // NOT A RESTATEMENT OF THE LINE ABOVE. Every clause so far is written in terms
      // of CABLE_LANE_OFFSET, so all of them go trivially true at offset 0 - measured,
      // 2026-08-26: with the constant zeroed this whole block still passed. A gate on
      // a lane has to say the two lanes are DIFFERENT without asking the lane how far
      // apart it thinks it is.
      expect(plus[i].y, 'the two lanes are not the same line').not.toBe(minus[i].y);
    }

    // And the separation has to survive `antialias: false` rasterisation at the wire
    // LOD cut (scale 16/CELL = 0.5), which is what killed the original SUB-PIXEL
    // prescription: two cables offset by half a world px land on the same pixel rows
    // and the fix ships as a no-op every gate passes. At the cut the pair must still
    // be at least 2 device px apart - two distinct cables, touching.
    const LOD_CUT_SCALE = 16 / CELL;
    expect(2 * CABLE_LANE_OFFSET * LOD_CUT_SCALE).toBeGreaterThanOrEqual(2);
  });

  it("CR-01: every adjacent 1x1 pair's corridor starts and ends on its nubs", () => {
    // 75-REVIEW CR-01, plan 75-09: the preview strokes through the same `cablePoints` as
    // the landed cable, so it showed the same wrong end, twice to the user (during the
    // drag and after it). A sweep, not a fixture: every adjacent 1x1 pair, 4 directions
    // x 16 side pairs, routed by `wireRoute`, handed to `showRoute` with both nubs and
    // the route's own lane, and read off the PLOTTED route (`routeG(api).pts`). Each end
    // passes within CABLE_LANE_OFFSET of its nub; every segment must be axis-aligned.
    const steps: Array<[number, number]> = [
      [1, 0],
      [0, 1],
      [-1, 0],
      [0, -1],
    ];
    const name = ['N', 'E', 'S', 'W'];
    const misses: string[] = [];
    let total = 0;
    const api = createOverlay(pausedScene());
    for (const [dx, dy] of steps) {
      for (let fs = 0; fs < 4; fs++) {
        for (let ts = 0; ts < 4; ts++) {
          total += 1;
          const head = `(0,0)${name[fs]} -> (${dx},${dy})${name[ts]}`;
          const r = wireRoute(
            { cell: [0, 0], side: fs, body: cellBody(0, 0) },
            { cell: [dx, dy], side: ts, body: cellBody(dx, dy) },
          );
          if (!r.ok) {
            misses.push(`${head} refused`);
            continue;
          }
          const tiles = r.geometry.tiles;
          const from = nubEndAt(0, 0, fs);
          const to = nubEndAt(dx, dy, ts);
          api.showRoute(
            tiles.map((t) => ({ cx: t.cell_x, cy: t.cell_y })),
            { from, to },
            true,
            cableLane(tiles),
          );
          const pts = [...(routeG(api).pts ?? [])];
          if (pts.length < 2) {
            misses.push(`${head} plotted ${pts.length} vertices`);
            continue;
          }
          const first = pts[0];
          const last = pts[pts.length - 1];
          if (Math.hypot(first.x - from.x, first.y - from.y) > CABLE_LANE_OFFSET + 1e-9) {
            misses.push(`${head} drawn=(${first.x},${first.y}) nub=(${from.x},${from.y})`);
          } else if (Math.hypot(last.x - to.x, last.y - to.y) > CABLE_LANE_OFFSET + 1e-9) {
            misses.push(`${head} drawn=(${last.x},${last.y}) nub=(${to.x},${to.y})`);
          } else {
            for (let i = 1; i < pts.length; i++) {
              if (pts[i].x !== pts[i - 1].x && pts[i].y !== pts[i - 1].y) {
                misses.push(`${head} diagonal segment ${i - 1}->${i}`);
                break;
              }
            }
          }
        }
      }
    }
    expect(total).toBe(64);
    expect(misses.length, `adjacent off-nub ${misses.length} of ${total}\n${misses.slice(0, 10).join('\n')}`).toBe(0);
  });

  it('a short path draws nothing at all, in any lane', () => {
    const api = createOverlay(pausedScene());
    api.showRoute([{ cx: 2, cy: 2 }], { from: nubEndAt(2, 2, E), to: NO_NUB }, true, 1);
    expect(routeG(api).pts).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // D-04: the PAIRED preview. Plan 72-11, R-70.
  // -------------------------------------------------------------------------
  //
  // These are the cases `gestures.test.ts` structurally cannot state. That file drives a
  // RECORDING overlay, so it can prove the gesture layer HANDS OVER a second leg and
  // nothing more; an overlay that accepted the argument and dropped it would leave every
  // gesture assertion green while the drag on screen promised one cable and the release
  // landed two. That is the same blind spot the `lane` argument had before 66-08 and it
  // is closed the same way: by reading what the renderer was actually asked to draw.

  /** A second corridor on the row below, run the other way: (6,3) back to (2,3). */
  const RETURN_LEG = [
    { cx: 6, cy: 3 },
    { cx: 5, cy: 3 },
    { cx: 4, cy: 3 },
    { cx: 3, cy: 3 },
    { cx: 2, cy: 3 },
  ];
  const ROW_BELOW = 3 * CELL + CELL / 2;
  // The return leg carries its OWN two nubs (plan 75-05): a W-facing Out on (6,3) back to
  // an E-facing In on (2,3).
  //   W nub of (6,3): x = 6*32 + 2 - 2.5     = 191.5, y = 3*32 + 16 = 112
  //   E nub of (2,3): x = 2*32 + 32 - 2 + 2.5 = 96.5,  y = 112
  const RETURN_NUBS = { from: nubEndAt(6, 3, W), to: nubEndAt(2, 3, E) };

  it('a paired leg is STROKED, not merely accepted: both corridors reach the renderer', () => {
    const api = createOverlay(pausedScene());
    // The anti-vacuity half FIRST: one leg is one stroke, so "two strokes" below is a
    // count this harness can actually distinguish.
    api.showRoute(CORRIDOR, NUBS, true, 1);
    expect(routeRec(api).strokes).toHaveLength(1);

    api.showRoute(CORRIDOR, NUBS, true, 1, [{ path: RETURN_LEG, lane: -1, nubs: RETURN_NUBS }]);
    const g = routeG(api);
    expect(g.strokes, 'two corridors, two strokes').toHaveLength(2);
    // Each leg runs nub to nub on its own row, displaced by its own lane (+1 is y 82, -1
    // on the row below is y 110).
    expect(g.pts).toEqual([
      { x: 96.5, y: 82 },
      { x: 112, y: 82 },
      { x: 144, y: 82 },
      { x: 176, y: 82 },
      { x: 191.5, y: 82 },
      { x: 191.5, y: 110 },
      { x: 176, y: 110 },
      { x: 144, y: 110 },
      { x: 112, y: 110 },
      { x: 96.5, y: 110 },
    ]);
  });

  it('the two ghosts are stroked IDENTICALLY: same colour, same width', () => {
    // R-70. Direction is not a property the user is choosing during the drag, it is a
    // property of the pairing they are making, so nothing on screen may mark one leg as
    // the forward one. Both legs go through ONE stroke routine and take their colour
    // from the ONE `valid` flag, which is what makes this structural rather than a
    // convention someone maintains.
    const api = createOverlay(pausedScene());
    api.showRoute(CORRIDOR, NUBS, true, 1, [{ path: RETURN_LEG, lane: -1, nubs: RETURN_NUBS }]);
    const legal = routeRec(api).strokes;
    expect(legal[0]).toEqual(legal[1]);

    // ...and the flag colours the WHOLE pairing, not just the leg the pointer drew.
    api.showRoute(CORRIDOR, NUBS, false, 1, [{ path: RETURN_LEG, lane: -1, nubs: RETURN_NUBS }]);
    const refused = routeRec(api).strokes;
    expect(refused[0]).toEqual(refused[1]);
    expect(refused[0].color, 'and the two states really are different colours').not.toBe(
      legal[0].color,
    );
  });

  it("the paired leg is displaced by its OWN lane, not the primary's", () => {
    // The pair exists so the two cables do not draw on top of each other. A second leg
    // that inherited the first leg's lane would put them back in one corridor.
    const api = createOverlay(pausedScene());
    api.showRoute(CORRIDOR, NUBS, true, 1, [{ path: RETURN_LEG, lane: -1, nubs: RETURN_NUBS }]);
    const minus = routeRec(api).pts.slice(CORRIDOR.length);
    api.showRoute(CORRIDOR, NUBS, true, 1, [{ path: RETURN_LEG, lane: 1, nubs: RETURN_NUBS }]);
    const plus = routeRec(api).pts.slice(CORRIDOR.length);
    expect(minus.every((p) => p.y === ROW_BELOW - CABLE_LANE_OFFSET)).toBe(true);
    expect(plus.every((p) => p.y === ROW_BELOW + CABLE_LANE_OFFSET)).toBe(true);
    expect(minus[0].y, 'the two lanes are not the same line').not.toBe(plus[0].y);
  });

  it('a later single-leg preview CLEARS the pair: nothing accumulates on the overlay', () => {
    // The pointer leaves the Handler's In and the second corridor has to go with it.
    // `showRoute` clears first, which is also why both legs are drawn in one call.
    const api = createOverlay(pausedScene());
    api.showRoute(CORRIDOR, NUBS, true, 1, [{ path: RETURN_LEG, lane: -1, nubs: RETURN_NUBS }]);
    expect(routeRec(api).strokes).toHaveLength(2);
    api.showRoute(CORRIDOR, NUBS, true, 1);
    expect(routeRec(api).strokes).toHaveLength(1);
    expect(routeRec(api).pts).toEqual([
      { x: 96.5, y: 82 },
      { x: 112, y: 82 },
      { x: 144, y: 82 },
      { x: 176, y: 82 },
      { x: 191.5, y: 82 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// THE PLACEMENT GHOST PREVIEWS THE CANVAS'S OWN NUBS (phase 92, CHROME-18, D-06, UI-SPEC 3.1).
//
// The ghost used to draw every nub as a 3.5 px disc, the fault exit in the fault accent, so an
// armed Factory, Router, Sink or Handler put red on the board over open floor where nothing was
// faulted. It now draws each nub with the machine layer's own `drawRoleNub` at the idle state:
// In a disc, Out a disc and its stem, the fault exit a neutral ring around a core, all from
// `nubColor`, on a Graphics whose alpha is the ghost's. The refused-drop body keeps the fault
// accent (a refusal, D-07; the five refusal-colour pins above stay as they are).
// ---------------------------------------------------------------------------
const { nubColor } = await import('./machines.ts');
const { state_tag } = await import('../../protocol/kinds.ts');
const { NUB_FAULT_CORE_R, NUB_FAULT_RING_R, NUB_R, nubAnchor: nubAnchorAt } = await import('../../protocol/ports.ts');

/** The ghost Graphics' index, found by its label (phase 92 review IN-C-04): it was the literal 16,
 *  which a surface added under the ghost would silently move off the ghost. */
const ghostIdx = (api: { layer: { children: unknown[] } }): number => {
  const i = (api.layer.children as unknown as Array<{ label: string }>).findIndex((c) => c.label === 'ghost');
  expect(i, 'the ghost Graphics is labelled `ghost`').toBeGreaterThanOrEqual(0);
  expect((api.layer.children as unknown as Array<{ label: string }>)[i + 1]?.label, 'its nubs sit directly above it').toBe('ghost-nubs');
  return i;
};
/** `overlay.ts` `GHOST_ALPHA`, hand-typed from the UI-SPEC (0.6) on purpose: the contract value, so
 *  a product change to the alpha reddens here rather than moving with it. */
const GHOST_ALPHA = 0.6;

describe('the placement ghost previews the canvas nubs (CHROME-18)', () => {
  type Rec = { ops: Array<{ op: string; x?: number; y?: number; r?: number; color?: number; width?: number }>; alpha: number; label: string };
  /** Every circle on the ghost and the surfaces above it, with the op that inked it and the
   *  surface's own alpha. */
  const ghostCircles = (api: { layer: { children: unknown[] } }) => {
    const out: Array<{ x: number; y: number; r: number; action: string; color?: number; surfaceAlpha: number }> = [];
    for (const c of api.layer.children.slice(ghostIdx(api)) as unknown as Rec[]) {
      c.ops.forEach((o, i) => {
        if (o.op !== 'circle') return;
        const ink = c.ops[i + 1];
        out.push({ x: o.x ?? NaN, y: o.y ?? NaN, r: o.r ?? NaN, action: ink?.op ?? 'none', color: ink?.color, surfaceAlpha: c.alpha });
      });
    }
    return out;
  };

  it('the ghost previews a neutral fault exit', () => {
    const api = createOverlay(pausedScene());
    // A Factory-shaped 3x3 ghost: In W middle, Out E middle, fault exit S middle.
    const ports = [
      { lx: 0, ly: 1, side: 3, role: 0, medium: 0 },
      { lx: 2, ly: 1, side: 1, role: 1, medium: 0 },
      { lx: 1, ly: 2, side: 2, role: 2, medium: 0 },
    ];
    api.showGhost({ cx: 10, cy: 10 }, true, { w: 3, h: 3, rot: 0 }, ports);
    const circles = ghostCircles(api);
    const at = (cx: number, cy: number, side: number) => {
      const a = nubAnchorAt(cx, cy, side);
      return circles
        .filter((c) => Math.abs(c.x - a.x) < 0.01 && Math.abs(c.y - a.y) < 0.01)
        .map((c) => ({ r: c.r, action: c.action, color: c.color, surfaceAlpha: c.surfaceAlpha }));
    };
    const ramp = LOCKED_SKIN.palette.ramp;
    expect(
      at(11, 12, 2),
      'RED-FIRST CHROME-18-ghost-unit: the ghost fault exit is the canvas annulus in ramp[3] (core r 2 filled, ring r 5 stroked) on a surface at the ghost alpha, never the fault accent',
    ).toEqual([
      { r: NUB_FAULT_CORE_R, action: 'fill', color: ramp[3], surfaceAlpha: GHOST_ALPHA },
      { r: NUB_FAULT_RING_R, action: 'stroke', color: ramp[3], surfaceAlpha: GHOST_ALPHA },
    ]);
    expect(nubColor(2, state_tag.IDLE, LOCKED_SKIN), 'the fault ring takes the canvas nub colour').toBe(ramp[3]);
    expect(at(10, 11, 3), 'the In nub is one disc in the idle In colour').toEqual([
      { r: NUB_R, action: 'fill', color: nubColor(0, state_tag.IDLE, LOCKED_SKIN), surfaceAlpha: GHOST_ALPHA },
    ]);
    expect(at(12, 11, 1), 'the Out nub is one disc in the idle Out colour').toEqual([
      { r: NUB_R, action: 'fill', color: nubColor(1, state_tag.IDLE, LOCKED_SKIN), surfaceAlpha: GHOST_ALPHA },
    ]);
    // The Out stem: one stroke in the Out colour on the nub surface.
    const nubs = (api.layer.children as unknown as Rec[]).find((c) => c.label === 'ghost-nubs');
    expect(nubs, 'the ghost nubs sit on their own labelled surface').toBeDefined();
    expect(
      nubs!.ops.filter((o) => o.op === 'stroke').map((o) => o.color),
      'two strokes: the fault ring and the Out stem',
    ).toEqual([nubColor(1, state_tag.IDLE, LOCKED_SKIN), ramp[3]]);
    // Nothing the valid ghost draws is the fault accent.
    const inks = (api.layer.children.slice(ghostIdx(api)) as unknown as Rec[]).flatMap((c) => c.ops.filter((o) => o.op === 'fill' || o.op === 'stroke'));
    expect(inks.length, 'NON-VACUITY: the scan reads the ghost body and its nubs').toBeGreaterThanOrEqual(5);
    expect(inks.filter((o) => o.color === FAULT), 'no ink of the valid ghost is the fault accent').toEqual([]);
    // Cleared with the ghost.
    api.clearGhost();
    expect(nubs!.ops, 'clearGhost clears the nubs').toEqual([]);
  });

  it('an electrical ghost port previews as the canvas square, not a disc', () => {
    const api = createOverlay(pausedScene());
    api.showGhost({ cx: 4, cy: 4 }, true, { w: 1, h: 1, rot: 0 }, [{ lx: 0, ly: 0, side: 1, role: 0, medium: 1 }]);
    const nubs = (api.layer.children as unknown as Rec[]).find((c) => c.label === 'ghost-nubs');
    expect(nubs?.ops.map((o) => o.op), 'the electrical In is a filled rect').toEqual(['rect', 'fill']);
  });
});
