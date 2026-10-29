// @vitest-environment jsdom
//
// THE STATE CONTRACT ON AN OPEN CHASSIS (58-UI-SPEC, plan 58-03 task 2).
//
// This spec exists because of ONE measured number. Lock axis 3 removed the filled
// body that used to carry machine state, and the obvious replacement - move state
// onto the outline's COLOUR - does not work: `working` #34d399 against the idle
// `ramp[4]` #b0bacb is 1.02 : 1 in greyscale, inside a rounding error. So every
// non-idle state carries a MANDATORY non-colour cue, and these are the cues.
//
// What is asserted here is the pure geometry: integer, clock-free, RNG-free, and
// testable without a renderer. The wiring (which Graphics, which z-order, what moves
// per frame) is asserted at the layer in `machineVector.test.ts`, because those are
// claims about the layer and not about this module.
//
// jsdom for the same reason `machineVector.test.ts` uses it: the drawing helpers take
// a REAL Pixi `Graphics` and the assertions read Pixi's OWN recorded instructions
// rather than the arguments that were passed in. Nothing is mocked.

import { describe, expect, it } from 'vitest';
import { Graphics } from 'pixi.js';
import { CELL } from '../../../shared/geometry';
import { LOCKED_SKIN } from '../synth/skins/locked.ts';
import { FRAMES, faultBlinkAlpha, phaseOffset } from '../faultBlink.ts';
import { CHASSIS_INSET_U, U_PER_CELL, U_TO_PX, chassisInk, uToPx } from './machineChassis.ts';
import { machine_kind, state_tag } from '../../protocol/kinds.ts';
import { INSET, NUB_PUSH } from '../../../shared/geometry.ts';
import { MEDIUM_ELECTRICAL, localNubSpecs } from '../../protocol/ports.ts';
import type { NodeView } from '../../protocol/decode.ts';
import { drawRoleNub } from './machines.ts';
import {
  ALERT_RING_OUTSET_U,
  GAUGE_GAP_U,
  GAUGE_OUTSET_U,
  GAUGE_RUN_U,
  GAUGE_SLOTS,
  GAUGE_THICK_U,
  GAUGE_TICK_U,
  MAX_NUB_REACH_PX,
  NOTCH_LEN_U,
  alertRingAlpha,
  alertRingBandPx,
  chassisPerimeterU,
  drawAlertRing,
  drawLoadGauge,
  drawNotch,
  notchOffset,
  resolveNotch,
} from './machineState.ts';

/** Every footprint the chassis can take that this spec sweeps: base and GROWN. */
const FOOTPRINTS: ReadonlyArray<readonly [w: number, h: number]> = [
  [1, 1], // source / sink / endpoint
  [2, 2], // tee / balancer / merge
  [2, 3], // router
  [3, 3], // factory
  [2, 6], // GROWN - a router after three `+ Add output` gestures
  [5, 7], // GROWN on both axes, a footprint no kind has
];

/* ------------------------------------------------------------------ *
 * The perimeter itself
 * ------------------------------------------------------------------ */

describe('chassisPerimeterU is the chassis CENTRELINE perimeter, in whole u', () => {
  for (const [w, h] of FOOTPRINTS) {
    it(`${w}x${h}: 2 * ((w*32 - 2*inset) + (h*32 - 2*inset))`, () => {
      const innerW = w * U_PER_CELL - 2 * CHASSIS_INSET_U;
      const innerH = h * U_PER_CELL - 2 * CHASSIS_INSET_U;
      expect(chassisPerimeterU(w, h)).toBe(2 * (innerW + innerH));
      expect(Number.isInteger(chassisPerimeterU(w, h))).toBe(true);
    });
  }

  it('a TALLER footprint has a LONGER perimeter - not one number for every box', () => {
    expect(chassisPerimeterU(2, 4)).toBeGreaterThan(chassisPerimeterU(2, 2));
    expect(chassisPerimeterU(2, 4) - chassisPerimeterU(2, 2)).toBe(2 * 2 * U_PER_CELL);
  });
});

/* ------------------------------------------------------------------ *
 * notchOffset: a PURE INTEGER FUNCTION of the quantized frame
 * ------------------------------------------------------------------ */

describe('notchOffset is a pure integer function of the quantized frame', () => {
  it('the same frame yields the same offset on every call', () => {
    for (const [w, h] of FOOTPRINTS) {
      for (let f = 0; f < FRAMES; f++) {
        expect(notchOffset(f, w, h)).toBe(notchOffset(f, w, h));
      }
    }
  });

  it('every offset is a whole number of u', () => {
    for (const [w, h] of FOOTPRINTS) {
      for (let f = 0; f < FRAMES; f++) {
        expect(Number.isInteger(notchOffset(f, w, h))).toBe(true);
      }
    }
  });

  it('it is periodic in FRAMES - the same phase of the bounded loop is the same offset', () => {
    for (const [w, h] of FOOTPRINTS) {
      for (let f = 0; f < FRAMES; f++) {
        expect(notchOffset(f + FRAMES, w, h)).toBe(notchOffset(f, w, h));
        expect(notchOffset(f + 5 * FRAMES, w, h)).toBe(notchOffset(f, w, h));
      }
    }
  });

  it('it is Euclidean-safe on negative and fractional frames, exactly as faultBlinkAlpha is', () => {
    // The clock is pinned, but `quantizedFrame` is documented as tolerating negative
    // and fractional input rather than throwing, and this consumer must match it.
    expect(notchOffset(-1, 2, 2)).toBe(notchOffset(FRAMES - 1, 2, 2));
    expect(notchOffset(-FRAMES, 2, 2)).toBe(notchOffset(0, 2, 2));
    expect(notchOffset(3.7, 2, 2)).toBe(notchOffset(3, 2, 2));
  });

  it('it reads no wall clock and no RNG - two runs a real millisecond apart agree', () => {
    const before = notchOffset(7, 2, 2);
    const start = Date.now();
    while (Date.now() === start) {
      /* spin until the wall clock has definitely moved */
    }
    expect(notchOffset(7, 2, 2)).toBe(before);
  });
});

describe('the notch walks the WHOLE perimeter exactly once per bounded loop', () => {
  for (const [w, h] of FOOTPRINTS) {
    it(`${w}x${h}: it starts at 0 and returns to 0 after exactly FRAMES frames`, () => {
      expect(notchOffset(0, w, h)).toBe(0);
      expect(notchOffset(FRAMES, w, h)).toBe(0);
    });

    it(`${w}x${h}: the offset advances in ONE direction and never wraps mid-loop`, () => {
      for (let f = 1; f < FRAMES; f++) {
        expect(
          notchOffset(f, w, h),
          `frame ${f} did not advance past frame ${f - 1}`,
        ).toBeGreaterThan(notchOffset(f - 1, w, h));
      }
    });

    it(`${w}x${h}: the final frame is within one step of the end, so the loop is covered`, () => {
      // "Walks the whole perimeter" stated as a number rather than an impression: the
      // last frame of the loop must be inside one frame-step of the full perimeter,
      // which is what makes the wrap back to 0 continuous rather than a jump back from
      // the middle of an edge.
      const p = chassisPerimeterU(w, h);
      const step = p / FRAMES;
      expect(notchOffset(FRAMES - 1, w, h)).toBeGreaterThan(p - 2 * step);
      expect(notchOffset(FRAMES - 1, w, h)).toBeLessThan(p);
    });

    it(`${w}x${h}: one loop visits all four edges`, () => {
      const edges = new Set(
        Array.from({ length: FRAMES }, (_, f) => resolveNotch(notchOffset(f, w, h), w, h).edge),
      );
      expect(edges).toEqual(new Set(['top', 'right', 'bottom', 'left']));
    });
  }
});

/* ------------------------------------------------------------------ *
 * resolveNotch: offset -> a place on the chassis rectangle
 * ------------------------------------------------------------------ */

describe('resolveNotch walks CLOCKWISE, and the direction is consistent at every footprint', () => {
  for (const [w, h] of FOOTPRINTS) {
    it(`${w}x${h}: x rises along the top, y along the right, x falls along the bottom, y along the left`, () => {
      const p = chassisPerimeterU(w, h);
      // Sample every u so the direction claim is made over the whole edge, not over a
      // pair of endpoints that could be right while the middle runs backwards.
      const seen: Record<string, Array<{ x: number; y: number }>> = {
        top: [],
        right: [],
        bottom: [],
        left: [],
      };
      for (let o = 0; o < p; o++) {
        const n = resolveNotch(o, w, h);
        seen[n.edge].push({ x: n.x, y: n.y });
      }
      // A loop over an empty range passes every claim inside it. Say out loud that
      // every edge was actually sampled before believing anything about direction.
      for (const edge of ['top', 'right', 'bottom', 'left'] as const) {
        expect(seen[edge].length, `no samples on the ${edge} edge`).toBeGreaterThan(1);
      }
      const nonDecreasing = (v: number[]) => v.every((n, i) => i === 0 || n >= v[i - 1]);
      const nonIncreasing = (v: number[]) => v.every((n, i) => i === 0 || n <= v[i - 1]);
      expect(nonDecreasing(seen.top.map((q) => q.x)), 'top runs left -> right').toBe(true);
      expect(nonDecreasing(seen.right.map((q) => q.y)), 'right runs top -> bottom').toBe(true);
      expect(nonIncreasing(seen.bottom.map((q) => q.x)), 'bottom runs right -> left').toBe(true);
      expect(nonIncreasing(seen.left.map((q) => q.y)), 'left runs bottom -> top').toBe(true);
    });

    it(`${w}x${h}: the notch is ALWAYS fully inside the chassis outer edge`, () => {
      // Rotation-invariance is bought by putting the cue on the whole perimeter, but a
      // 6u notch centred exactly on a corner would poke 1.5u past the outer corner into
      // empty substrate. The resolver clamps instead; this is that clamp, stated.
      const p = chassisPerimeterU(w, h);
      const half = (NOTCH_LEN_U / 2) * U_TO_PX;
      const across = (LOCKED_SKIN.strokeStructural / 2) * U_TO_PX;
      const outer = CHASSIS_INSET_U * U_TO_PX - across;
      expect(p, 'nothing was sampled').toBeGreaterThan(0);
      for (let o = 0; o < p; o++) {
        const n = resolveNotch(o, w, h);
        const halfX = n.rotation === 0 ? half : across;
        const halfY = n.rotation === 0 ? across : half;
        expect(n.x - halfX, `offset ${o} left`).toBeGreaterThanOrEqual(outer - 1e-9);
        expect(n.y - halfY, `offset ${o} top`).toBeGreaterThanOrEqual(outer - 1e-9);
        expect(n.x + halfX, `offset ${o} right`).toBeLessThanOrEqual(w * CELL - outer + 1e-9);
        expect(n.y + halfY, `offset ${o} bottom`).toBeLessThanOrEqual(h * CELL - outer + 1e-9);
      }
    });

    it(`${w}x${h}: it sits ON the chassis centreline, so the notch covers the stroke exactly`, () => {
      const p = chassisPerimeterU(w, h);
      const inset = CHASSIS_INSET_U * U_TO_PX;
      expect(p, 'nothing was sampled').toBeGreaterThan(0);
      for (let o = 0; o < p; o++) {
        const n = resolveNotch(o, w, h);
        const onCentreline =
          n.edge === 'top'
            ? n.y === inset
            : n.edge === 'bottom'
              ? n.y === h * CELL - inset
              : n.edge === 'left'
                ? n.x === inset
                : n.x === w * CELL - inset;
        expect(onCentreline, `offset ${o} (${n.edge}) is off the centreline`).toBe(true);
      }
    });
  }

  it('the notch is rotated a quarter turn on the vertical edges and not on the horizontal ones', () => {
    const p = chassisPerimeterU(2, 2);
    for (let o = 0; o < p; o++) {
      const n = resolveNotch(o, 2, 2);
      const want = n.edge === 'top' || n.edge === 'bottom' ? 0 : Math.PI / 2;
      expect(n.rotation).toBe(want);
    }
  });

  it('it is Euclidean-safe on an out-of-range offset', () => {
    const p = chassisPerimeterU(2, 2);
    expect(resolveNotch(p, 2, 2)).toEqual(resolveNotch(0, 2, 2));
    expect(resolveNotch(-1, 2, 2)).toEqual(resolveNotch(p - 1, 2, 2));
  });
});

/* ------------------------------------------------------------------ *
 * The notch as INK: it survives the colour channel being deleted
 * ------------------------------------------------------------------ */

/** WCAG relative luminance of a 0xRRGGBB colour (sRGB -> linear, Rec.709 weights). */
function luminance(color: number): number {
  const ch = [(color >> 16) & 0xff, (color >> 8) & 0xff, color & 0xff].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

/** WCAG contrast ratio, the SAME formula down the whole column (58-UI-SPEC). */
function contrast(a: number, b: number): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe('the notch is a SUBSTRATE-versus-INK step, not a hue difference', () => {
  const RAMP0 = LOCKED_SKIN.palette.ramp[0];
  const RAMP4 = LOCKED_SKIN.palette.ramp[LOCKED_SKIN.palette.ramp.length - 1];

  it('the notch is filled ramp[0] - the darkest step of the ramp, read from the skin', () => {
    const g = new Graphics();
    drawNotch(g, LOCKED_SKIN);
    const fills = g.context.instructions
      .filter((ins) => ins.action === 'fill')
      .map((ins) => (ins.data as { style: { color: number } }).style.color);
    expect(fills).toEqual([RAMP0]);
    expect(RAMP0).toBe(Math.min(...LOCKED_SKIN.palette.ramp));
  });

  it('notch-on-idle-outline clears 8 : 1 by WCAG, so it survives greyscale', () => {
    expect(contrast(RAMP0, RAMP4)).toBeGreaterThanOrEqual(8);
  });

  it('it clears the WORKING outline too - the outline the notch actually travels', () => {
    // The notch is only ever drawn on a WORKING machine, so the contrast that matters
    // is against `accents.working`, not against the idle ink.
    expect(contrast(RAMP0, LOCKED_SKIN.palette.accents.working)).toBeGreaterThanOrEqual(8);
    expect(chassisInk(state_tag.WORKING, LOCKED_SKIN)).toBe(LOCKED_SKIN.palette.accents.working);
  });

  it('and it is the cue the COLOUR channel could not be: working-vs-idle is 1.02 : 1', () => {
    // The measurement the whole contract rests on, asserted rather than quoted, so a
    // future palette edit that made colour sufficient would show up here as a red test
    // telling the truth rather than as a silently redundant notch.
    const colourOnly = contrast(LOCKED_SKIN.palette.accents.working, RAMP4);
    expect(colourOnly).toBeLessThan(1.1);
    expect(contrast(RAMP0, RAMP4) / colourOnly).toBeGreaterThan(7);
  });
});

describe('the notch geometry covers the chassis stroke exactly', () => {
  it('it is NOTCH_LEN_U long and exactly strokeStructural across, read from the skin', () => {
    const g = new Graphics();
    drawNotch(g, LOCKED_SKIN);
    const b = g.getLocalBounds();
    expect(b.width).toBeCloseTo(NOTCH_LEN_U * U_TO_PX, 6);
    expect(b.height).toBeCloseTo(LOCKED_SKIN.strokeStructural * U_TO_PX, 6);
    // The across-size is the STROKE WEIGHT and not a third literal: narrower leaves a
    // hairline of outline showing through the notch, wider eats substrate outside it.
    expect(LOCKED_SKIN.strokeStructural).toBe(3);
    expect(NOTCH_LEN_U).toBe(6);
  });

  it('it is centred on its own origin, so a placement is a transform and never a re-plot', () => {
    const g = new Graphics();
    drawNotch(g, LOCKED_SKIN);
    const b = g.getLocalBounds();
    // An EMPTY Graphics is centred on its origin too. Refuse that reading first.
    expect(b.width).toBeGreaterThan(0);
    expect(b.height).toBeGreaterThan(0);
    expect(b.x + b.width / 2).toBeCloseTo(0, 6);
    expect(b.y + b.height / 2).toBeCloseTo(0, 6);
  });

  it('a skin with a heavier structural stroke gets a wider notch - the axis is live', () => {
    const heavy = { ...LOCKED_SKIN, strokeStructural: 6 };
    const g = new Graphics();
    drawNotch(g, heavy);
    expect(g.getLocalBounds().height).toBeCloseTo(6 * U_TO_PX, 6);
  });
});

/* ------------------------------------------------------------------ *
 * The FAULTED alert ring
 * ------------------------------------------------------------------ */

/**
 * A 1x1 node carrying ONE port of each role, each on a different side, so the three
 * silhouettes can be measured independently off a single scene fact. Shared by the
 * reach measurement and the fault-ink gate below so the two cannot drift apart.
 */
const THREE_ROLE_NODE = {
  handle: 1,
  kind: machine_kind.ROUTER,
  state: state_tag.FAULTED,
  cell_x: 0,
  cell_y: 0,
  w: 1,
  h: 1,
  rot: 0,
  ports: [
    { cell_x: 0, cell_y: 0, side: 3, role: 0, index: 0 }, // In, West
    { cell_x: 0, cell_y: 0, side: 1, role: 1, index: 1 }, // Out, East
    { cell_x: 0, cell_y: 0, side: 0, role: 2, index: 2 }, // Fault, North
  ],
} as unknown as NodeView;

/**
 * Every colour Pixi actually recorded for `g`, in draw order, read off the context's
 * OWN instruction list rather than off the arguments the test passed in. A `fill` and
 * a `stroke` instruction both carry `data.style.color`
 * (`GraphicsContext.mjs:151,184`), so this sees the whole inked surface of a Graphics.
 */
const inkOrder = (g: Graphics): number[] =>
  g.context.instructions
    .filter((ins) => ins.action === 'fill' || ins.action === 'stroke')
    .map((ins) => (ins.data as { style: { color: number } }).style.color);

/** All three role nubs plotted into ONE Graphics at `state`, exactly as the shipped
 *  `machines.ts rebuildNubs` plots them. */
const plotNubs = (state: number): Graphics => {
  const g = new Graphics();
  for (const spec of localNubSpecs(THREE_ROLE_NODE)) {
    drawRoleNub(g, spec, state, LOCKED_SKIN);
  }
  return g;
};

describe('the alert ring is a SHAPE cue at the shipped fault cadence', () => {
  it('it is a fault-accent ring at the DETAIL stroke, both read from the skin', () => {
    const g = new Graphics();
    drawAlertRing(g, 2, 2, LOCKED_SKIN);
    const strokes = g.context.instructions
      .filter((ins) => ins.action === 'stroke')
      .map((ins) => (ins.data as { style: { color: number; width: number } }).style);
    expect(strokes).toHaveLength(1);
    expect(strokes[0].color).toBe(LOCKED_SKIN.palette.accents.fault);
    expect(strokes[0].width).toBe(LOCKED_SKIN.strokeDetail * U_TO_PX);
  });

  for (const [w, h] of FOOTPRINTS) {
    it(`${w}x${h}: it rings the whole effective box, OUTSIDE the chassis`, () => {
      const g = new Graphics();
      drawAlertRing(g, w, h, LOCKED_SKIN);
      const b = g.getLocalBounds();
      const outer = ALERT_RING_OUTSET_U * U_TO_PX + (LOCKED_SKIN.strokeDetail / 2) * U_TO_PX;
      expect(b.x).toBeCloseTo(-outer, 6);
      expect(b.y).toBeCloseTo(-outer, 6);
      expect(b.x + b.width).toBeCloseTo(w * CELL + outer, 6);
      expect(b.y + b.height).toBeCloseTo(h * CELL + outer, 6);
    });
  }

  it('MAX_NUB_REACH_PX is the MEASURED reach of the real nubs, not a transcribed number', () => {
    // The whole point of CR-01: the gate that used to stand here hand-typed `3.5 - 2`,
    // dropping NUB_PUSH and modelling only role 0, and therefore agreed with a docblock
    // that was wrong. So the derived constant is checked against Pixi's OWN bounds on
    // the SHIPPED `drawRoleNub`, one port per role, each on a different side of a 1x1.
    //
    // Outward reach per side, with the effective box spanning 0..CELL on both axes:
    //   N -> -bounds.y                E -> bounds.right - CELL
    //   S -> bounds.bottom - CELL     W -> -bounds.x
    const reach = new Map<number, number>();
    for (const spec of localNubSpecs(THREE_ROLE_NODE)) {
      const g = new Graphics();
      drawRoleNub(g, spec, state_tag.FAULTED, LOCKED_SKIN);
      const b = g.getLocalBounds();
      const outward =
        spec.side === 0
          ? -b.y
          : spec.side === 1
            ? b.x + b.width - CELL
            : spec.side === 2
              ? b.y + b.height - CELL
              : -b.x;
      reach.set(spec.role, outward);
    }

    // The measured per-role reaches. Each is `radius - INSET + NUB_PUSH`; the naive
    // `radius - INSET` reading gives 1.5 / 4.5 / 3.125 and is exactly what CR-01 was.
    expect(reach.get(0)).toBeCloseTo(4.0, 6);
    expect(reach.get(1)).toBeCloseTo(7.625, 6);
    expect(reach.get(2)).toBeCloseTo(6.125, 6);
    expect(MAX_NUB_REACH_PX).toBeCloseTo(Math.max(...reach.values()), 6);
    // Stated, not derived, so a nub-constant edit has to come through this line.
    expect(MAX_NUB_REACH_PX).toBeCloseTo(7.625, 6);
  });

  it('the ELECTRICAL square is MEASURED too, and it does not move the maximum', () => {
    // Plan 72-09, UI-SPEC 1.2. `MAX_NUB_REACH_PX` now folds a FOURTH silhouette into
    // its `Math.max` - the electrical square, on the medium axis rather than the role
    // axis. Folding one in without measuring it is how CR-01 happened the first time:
    // the constant would agree with the docblock and neither would agree with Pixi.
    //
    // Measured the same way as the three roles above, off the SHIPPED `drawRoleNub`
    // with a real `Graphics`, on a North-facing 1x1 so the outward reach is `-bounds.y`.
    const g = new Graphics();
    drawRoleNub(
      g,
      { x: CELL / 2, y: INSET - NUB_PUSH, nx: 0, ny: -1, side: 0, role: 0, medium: MEDIUM_ELECTRICAL, index: 0 },
      state_tag.IDLE,
      LOCKED_SKIN,
    );
    const squareReach = -g.getLocalBounds().y;
    expect(squareReach).toBeCloseTo(5.5, 6);
    // BETWEEN the role-0 disc (4.000) and the role-2 annulus (6.125)...
    expect(squareReach).toBeGreaterThan(4.0);
    expect(squareReach).toBeLessThan(6.125);
    // ...and strictly inside the role-1 stem, which still defines the maximum. This is
    // the assertion that says the new silhouette moved no geometry: if it ever DOES
    // become the maximum, `ALERT_RING_OUTSET_U`'s clearance argument has to be redone.
    expect(squareReach).toBeLessThan(MAX_NUB_REACH_PX);
    expect(MAX_NUB_REACH_PX).toBeCloseTo(7.625, 6);
  });

  it('it does NOT clear the port nubs, and that is now a DECISION rather than a defect', () => {
    // THE HONEST INVERSE OF THE OLD ASSERTION. The old one claimed clearance and passed
    // only because it re-derived the docblock's wrong arithmetic. Measured off the
    // shipped `drawAlertRing`, the band is 2.000 .. 4.000 px outside the box edge and
    // every one of the three roles crosses it.
    //
    // The maintainer ruled on 2026-08-02, on a real render of all three candidates: the geometry
    // STAYS, and the collision is resolved in INK instead (the next case gates that).
    // So this case is no longer a defect assertion waiting to flip - it is the pin that
    // stops anyone "helpfully" moving the ring later. The 9u alternative was rejected
    // twice over: the halo becomes the dominant element in the cell, AND it does not
    // even clear cleanly (the role-1 tip at 7.625 would sit 0.375 px inside a ring
    // whose inner edge is 8.000 - under one device pixel, and `antialias: false` may
    // snap them to touching regardless).
    const g = new Graphics();
    drawAlertRing(g, 1, 1, LOCKED_SKIN);
    const b = g.getLocalBounds();
    const band = alertRingBandPx(LOCKED_SKIN);

    // The band the drawing code actually produces, cross-checked against Pixi's bounds.
    expect(band.inner).toBeCloseTo(2, 6);
    expect(band.outer).toBeCloseTo(4, 6);
    expect(-b.x).toBeCloseTo(band.outer, 6);

    // The overlap, asserted in the direction it is TRUE in.
    expect(MAX_NUB_REACH_PX).toBeGreaterThan(band.inner);
    // The outset that WOULD clear it, so the figure in the docblock cannot rot...
    const clearingOutsetU = (MAX_NUB_REACH_PX + uToPx(LOCKED_SKIN.strokeDetail) / 2) / U_TO_PX;
    expect(Math.ceil(clearingOutsetU)).toBe(9);
    expect(ALERT_RING_OUTSET_U).toBeLessThan(9);
    // ...along with the sub-pixel margin that made 9u the WRONG answer rather than the
    // expensive one. `9 - 1 = 8.000` inner edge against a 7.625 tip.
    const marginAt9u = uToPx(9) - uToPx(LOCKED_SKIN.strokeDetail) / 2 - MAX_NUB_REACH_PX;
    expect(marginAt9u).toBeCloseTo(0.375, 6);
    expect(marginAt9u, 'a "clearance" thinner than one device pixel is not clearance').toBeLessThan(
      1,
    );
  });

  it('a FAULTED machine inks the fault accent on the RING ONLY - the nubs keep normal ink', () => {
    // THE RULING ON CR-01, 2026-08-02, taken on a real render of all three candidate
    // treatments ("Option A"). The geometric overlap above is untouched; what changed
    // is that `machines.ts nubColor` no longer returns `accents.fault` for any role in
    // any state. So of the two silhouettes that share the ring's band, exactly one is
    // drawn in the fault accent, and the overlap reads as two distinct objects instead
    // of one smeared red mass.
    const FAULT = LOCKED_SKIN.palette.accents.fault;

    const ring = new Graphics();
    drawAlertRing(ring, 1, 1, LOCKED_SKIN);
    expect(inkOrder(ring), 'the ring is one fault-accent stroke and nothing else').toEqual([FAULT]);

    const faultedNubs = plotNubs(state_tag.FAULTED);
    // Refuse a vacuous pass first: three roles must actually have inked something.
    // role 0 fill; role 1 fill + stem stroke; role 2 core fill + annulus stroke.
    expect(inkOrder(faultedNubs), 'the nubs really were plotted').toHaveLength(5);
    expect(
      inkOrder(faultedNubs).filter((c) => c === FAULT),
      'no port nub is fault ink on a FAULTED machine',
    ).toEqual([]);

    // "Normal ink" stated as the render the maintainer actually judged: the faulted nubs are
    // ink-for-ink what an unfaulted machine draws. Asserted as the whole ordered
    // sequence, so it also pins that the role-2 annulus is still STROKED (its shape
    // encodes the ROLE and survives the ink change - VIS-03).
    expect(inkOrder(faultedNubs)).toEqual(inkOrder(plotNubs(state_tag.IDLE)));
  });

  it('...and the nub ink channel is still LIVE - this is not "nubs ignore state"', () => {
    // The discriminator for the case above. Deleting the state argument entirely would
    // satisfy it, so prove WORKING still moves the role 0/1 ink and that the role-2
    // dim step is deliberate rather than a dead branch.
    const working = inkOrder(plotNubs(state_tag.WORKING));
    const idle = inkOrder(plotNubs(state_tag.IDLE));
    expect(working).not.toEqual(idle);
    expect(working, 'a WORKING machine paints its In/Out nubs the working accent').toContain(
      LOCKED_SKIN.palette.accents.working,
    );
    // The fault EXIT stays on the dim step even while the machine works - the annulus
    // is a role, not a state.
    expect(working.filter((c) => c === LOCKED_SKIN.palette.ramp[3]).length).toBeGreaterThan(0);
  });

  it('ALERT_RING_OUTSET_U is pinned by the properties it was chosen for (WR-03)', () => {
    // Mutation-proven ungated before this case existed: 3 -> 5 passed all 1422 vitest
    // cases, because the only two assertions over it both DERIVED their expectation
    // from it. Both bounds below were watched to redden on that same 3 -> 5 mutation.
    //
    // Lower bound: the band must lie wholly OUTSIDE the box. Inside it is the variant
    // that was measured and rejected - a 2u ring in a 3.5u band leaves 0.5u of
    // substrate, which does not survive `antialias: false`.
    expect(alertRingBandPx(LOCKED_SKIN).inner).toBeGreaterThan(0);

    // Upper bound, and it is the property 58-d actually turns on. The halo CROSSING a
    // directly-adjacent neighbour's chassis OUTLINE is the accepted cost (that outline
    // occupies CHASSIS_INSET_U -/+ strokeStructural/2 = 2.5u..5.5u into the neighbour's
    // cell). Reaching PAST it, into the neighbour's interior where its own glyph lives,
    // is not: the halo would then read as the NEIGHBOUR's own mark and an operator
    // could not tell which machine is faulted, which is 58-d's stated failure mode.
    const neighbourInteriorPx = uToPx(CHASSIS_INSET_U + LOCKED_SKIN.strokeStructural / 2);
    expect(neighbourInteriorPx).toBeCloseTo(5.5, 6);
    expect(alertRingBandPx(LOCKED_SKIN).outer).toBeLessThan(neighbourInteriorPx);

    // And the literal, stated, so any change has to be a deliberate edit to this line.
    expect(ALERT_RING_OUTSET_U, 'the halo spill FEEL row 58-d asks the maintainer to judge').toBe(3);
  });

  it('its alpha IS the shipped faultBlinkAlpha at the shipped per-node phase - no second clock', () => {
    for (const [cx, cy] of [
      [0, 0],
      [3, 7],
      [-2, 11],
    ]) {
      for (let f = 0; f < FRAMES; f++) {
        const local = (((f + phaseOffset(cx, cy)) % FRAMES) + FRAMES) % FRAMES;
        expect(alertRingAlpha(f, cx, cy)).toBe(faultBlinkAlpha(local));
      }
    }
  });

  it('adjacent cells blink OUT of phase - a grid of faults is not one synchronized pulse', () => {
    const a = Array.from({ length: FRAMES }, (_, f) => alertRingAlpha(f, 4, 4));
    const b = Array.from({ length: FRAMES }, (_, f) => alertRingAlpha(f, 5, 4));
    expect(a).not.toEqual(b);
  });

  it('it never reaches full opacity and never vanishes - the section 4 peak and floor', () => {
    const all = Array.from({ length: FRAMES }, (_, f) => alertRingAlpha(f, 0, 0));
    expect(Math.max(...all)).toBeLessThanOrEqual(0.8);
    expect(Math.min(...all)).toBeGreaterThanOrEqual(0.25);
  });
});

/* ------------------------------------------------------------------ *
 * THE LOAD GAUGE (71-UI-SPEC, plan 71-06)
 *
 * The third cue, and the one whose whole argument is that it has NO colour channel to
 * remove. Measured off real Pixi `getLocalBounds()` and off Pixi's own recorded
 * instructions, exactly as the notch and the ring above are - never off the arguments
 * that were passed in.
 * ------------------------------------------------------------------ */

/** Count the FILL instructions Pixi actually recorded - one per plotted rect. */
function fillCount(g: Graphics): number {
  return g.context.instructions.filter((ins) => ins.action === 'fill').length;
}

/** The colours of every fill Pixi actually recorded, in order. */
function fillColors(g: Graphics): number[] {
  return g.context.instructions
    .filter((ins) => ins.action === 'fill')
    .map((ins) => (ins.data as { style: { color: number } }).style.color);
}

describe('GAUGE_RUN_U carries its own derivation rather than a transcribed total', () => {
  it('is the expression over slots, tick and gap - and the parts still total 25', () => {
    // BOTH halves, deliberately. The first line is the contract (the run is four ticks
    // and the three gaps between them); the second is the shipped figure stated rather
    // than derived, so an edit to ANY of the three parts has to come through this line
    // instead of quietly re-agreeing with itself. That is the CR-01 shape this file
    // already paid for once.
    expect(GAUGE_RUN_U).toBe(GAUGE_SLOTS * GAUGE_TICK_U + (GAUGE_SLOTS - 1) * GAUGE_GAP_U);
    expect(GAUGE_RUN_U).toBe(25);
    expect([GAUGE_SLOTS, GAUGE_TICK_U, GAUGE_GAP_U, GAUGE_THICK_U, GAUGE_OUTSET_U]).toEqual([
      4, 4, 3, 3, 9,
    ]);
  });
});

describe('drawLoadGauge plots one rect per level, and ONE merged run at full load', () => {
  it('load 0 plots NOTHING AT ALL - a calm board carries zero gauges', () => {
    const g = new Graphics();
    drawLoadGauge(g, 0, 1, 1, LOCKED_SKIN);
    expect(fillCount(g)).toBe(0);
    expect(g.context.instructions.length).toBe(0);
  });

  for (const level of [1, 2, 3] as const) {
    it(`load ${level} plots ${level} tick(s), left-aligned, ${level - 1} gap(s)`, () => {
      const g = new Graphics();
      drawLoadGauge(g, level, 1, 1, LOCKED_SKIN);
      // One rect per tick, and the count is what distinguishes 3 from 4.
      expect(fillCount(g)).toBe(level);
      const b = g.getLocalBounds();
      // The run is LEFT-ALIGNED inside the full 25u run, so `level` ticks span
      // `level*4 + (level-1)*3` u and always start at the same x.
      const spanU = level * GAUGE_TICK_U + (level - 1) * GAUGE_GAP_U;
      expect(b.width).toBeCloseTo(uToPx(spanU), 6);
      expect(b.width).toBeCloseTo([4, 11, 18][level - 1], 6);
      // Left edge is the run's own left edge at every level: a partial gauge grows
      // rightward from a FIXED origin rather than staying centred, which is what makes
      // two machines side by side comparable at a glance.
      expect(b.x).toBeCloseTo(CELL / 2 - uToPx(GAUGE_RUN_U) / 2, 6);
      expect(b.x).toBeCloseTo(3.5, 6);
    });
  }

  it('load 4 plots ONE SOLID 25u BAR - the gaps CLOSE, which is a FORM step', () => {
    const g = new Graphics();
    drawLoadGauge(g, 4, 1, 1, LOCKED_SKIN);
    // ONE rect, not four abutting ones. This is the assertion that separates the form
    // step from "four ticks that happen to touch": a merged run is one piece of
    // geometry and the eye reads it as one.
    expect(fillCount(g)).toBe(1);
    const b = g.getLocalBounds();
    expect(b.width).toBeCloseTo(uToPx(GAUGE_RUN_U), 6);
    expect(b.width).toBeCloseTo(25, 6);
    // And it is genuinely WIDER than the three-tick case rather than merely denser.
    const three = new Graphics();
    drawLoadGauge(three, 3, 1, 1, LOCKED_SKIN);
    expect(b.width).toBeGreaterThan(three.getLocalBounds().width);
  });
});

describe('the gauge band measures 9.000 .. 12.000 px OUTSIDE the box top edge', () => {
  // Asserted to 6 decimal places, the same precision the nub-reach gate above uses,
  // because the whole reason GAUGE_OUTSET_U is 9 rather than 8 is a 1.375 px margin and
  // a coarser assertion could not tell the two apart.
  for (const [w, h] of FOOTPRINTS) {
    it(`${w}x${h}: the band is at negative y and the run is CENTRED on the top edge`, () => {
      const g = new Graphics();
      drawLoadGauge(g, GAUGE_SLOTS, w, h, LOCKED_SKIN);
      const b = g.getLocalBounds();
      // `y` increases downward and the box's min corner is the local origin, so the
      // band's near side is -9 and its far side is -12.
      expect(-(b.y + b.height)).toBeCloseTo(uToPx(GAUGE_OUTSET_U), 6);
      expect(-(b.y + b.height)).toBeCloseTo(9, 6);
      expect(-b.y).toBeCloseTo(uToPx(GAUGE_OUTSET_U + GAUGE_THICK_U), 6);
      expect(-b.y).toBeCloseTo(12, 6);
      expect(b.height).toBeCloseTo(uToPx(GAUGE_THICK_U), 6);

      // FIXED SIZE AT EVERY FOOTPRINT. The gauge reports a NUMBER, not a proportion of
      // the machine, so a 1x1 Sink and a 3x3 Factory get the same 25u run. A run that
      // scaled would make a Factory's one tick look bigger than a Sink's four.
      expect(b.width).toBeCloseTo(uToPx(GAUGE_RUN_U), 6);
      // Centred on the effective box's top edge, which is what makes it read as this
      // machine's gauge and not the neighbour's.
      const ew = w;
      expect(b.x + b.width / 2).toBeCloseTo((ew * CELL) / 2, 6);
    });
  }

  it('it clears the heaviest port nub by 1.375 px, which is why the outset is 9 and not 8', () => {
    // BOTH figures below are on the EFFECTIVE BOX EDGE origin, so subtracting them is
    // the same question asked twice. Do NOT reuse this comparison for a nub-to-nub gap:
    // that is the NUB-CENTRE origin, the two differ by exactly `NUB_PUSH - INSET` = 0.5,
    // and feeding MAX_NUB_REACH_PX into a centre-to-centre gap double-counts that term
    // and lands 1.0 px out. That is CR-01 landing a second time.
    const clearance = uToPx(GAUGE_OUTSET_U) - MAX_NUB_REACH_PX;
    expect(clearance).toBeCloseTo(1.375, 6);
    expect(clearance).toBeGreaterThan(1);
    // At 8u it would be 0.375 px, UNDER ONE DEVICE PIXEL - the exact failure
    // ALERT_RING_OUTSET_U measured and rejected for the ring. Stated so a later shrink
    // has to argue with a number rather than with a preference.
    expect(uToPx(8) - MAX_NUB_REACH_PX).toBeCloseTo(0.375, 6);
    // And it clears the FAULTED alert ring's outer edge by 5.000 px, so a machine that
    // is both faulted and full shows two separate marks rather than one smear.
    expect(uToPx(GAUGE_OUTSET_U) - alertRingBandPx(LOCKED_SKIN).outer).toBeCloseTo(5, 6);
  });
});

describe('the gauge is total over the load byte, exactly as chassisInk is over state', () => {
  // `decode.ts` reads `load` RAW off the wire under the open-keyspace rule, so the clamp
  // lives at the draw call. None of these may throw.
  it('a byte at or above GAUGE_SLOTS draws the FULL BAR and does not throw', () => {
    for (const raw of [4, 5, 42, 255]) {
      const g = new Graphics();
      expect(() => drawLoadGauge(g, raw, 1, 1, LOCKED_SKIN)).not.toThrow();
      expect(fillCount(g)).toBe(1);
      expect(g.getLocalBounds().width).toBeCloseTo(uToPx(GAUGE_RUN_U), 6);
    }
  });

  it('a byte at or below 0, or non-finite, draws NOTHING and does not throw', () => {
    for (const raw of [0, -1, -255, Number.NaN, Number.POSITIVE_INFINITY * 0]) {
      const g = new Graphics();
      expect(() => drawLoadGauge(g, raw, 1, 1, LOCKED_SKIN)).not.toThrow();
      expect(g.context.instructions.length).toBe(0);
    }
  });

  it('a fractional byte floors rather than plotting a partial tick', () => {
    const g = new Graphics();
    drawLoadGauge(g, 2.9, 1, 1, LOCKED_SKIN);
    expect(fillCount(g)).toBe(2);
  });

  it('the leading clear() means a re-plot never leaves a stale run underneath', () => {
    const g = new Graphics();
    drawLoadGauge(g, 4, 1, 1, LOCKED_SKIN);
    expect(fillCount(g)).toBe(1);
    drawLoadGauge(g, 1, 1, 1, LOCKED_SKIN);
    expect(fillCount(g)).toBe(1);
    expect(g.getLocalBounds().width).toBeCloseTo(uToPx(GAUGE_TICK_U), 6);
    drawLoadGauge(g, 0, 1, 1, LOCKED_SKIN);
    expect(g.context.instructions.length).toBe(0);
  });
});

describe('the gauge has NO colour channel to remove, which is what PILE-08 asks for', () => {
  const RAMP0 = LOCKED_SKIN.palette.ramp[0];
  const RAMP3 = LOCKED_SKIN.palette.ramp[LOCKED_SKIN.palette.ramp.length - 2];
  const RAMP4 = LOCKED_SKIN.palette.ramp[LOCKED_SKIN.palette.ramp.length - 1];

  it('every tick is filled ramp[4] - the STRUCTURAL ink, read from the skin', () => {
    const g = new Graphics();
    drawLoadGauge(g, 3, 1, 1, LOCKED_SKIN);
    expect(fillColors(g)).toEqual([RAMP4, RAMP4, RAMP4]);
    expect(RAMP4).toBe(Math.max(...LOCKED_SKIN.palette.ramp));
  });

  it('it is a SUBSTRATE-versus-INK step against the board, not a hue difference', () => {
    // The notch's own argument run in the opposite direction: dark ink on a light
    // outline there, light ink on the dark board here. Same formula, same column.
    expect(contrast(RAMP4, RAMP0)).toBeGreaterThanOrEqual(8);
    expect(contrast(RAMP4, RAMP0)).toBeCloseTo(8.438, 3);
    // And it is not an accent-on-accent step, which is the 1.02 : 1 case the whole
    // doctrine exists because of.
    expect(contrast(RAMP4, LOCKED_SKIN.palette.accents.working)).toBeLessThan(1.1);
  });

  it('the item accent was BETTER on contrast and is still refused, on the LOCK', () => {
    // Recorded as a measurement so nobody re-derives it and concludes the refusal was
    // about legibility. `accents.item` is reserved by the locked style bible for item
    // dots riding belts; extending a reserved usage is a re-lock decision for the maintainer.
    expect(contrast(LOCKED_SKIN.palette.accents.item, RAMP0)).toBeGreaterThan(
      contrast(RAMP4, RAMP0),
    );
    expect(fillColors(new Graphics())).not.toContain(LOCKED_SKIN.palette.accents.item);
  });

  it('and the OUTLINE carries the state too: BACKED_UP dims to ramp[3], 3.285 : 1 vs idle', () => {
    // The second colour-independent channel. Without it a greyscale screenshot would get
    // the state ONLY from the gauge, and the Legend would carry two identical swatches.
    expect(chassisInk(state_tag.BACKED_UP, LOCKED_SKIN)).toBe(RAMP3);
    expect(contrast(RAMP3, RAMP4)).toBeCloseTo(3.285, 3);
    expect(contrast(RAMP3, RAMP4)).toBeGreaterThan(3);
    // Every other state's ink is byte-identical to before the arm was added.
    expect(chassisInk(state_tag.IDLE, LOCKED_SKIN)).toBe(RAMP4);
    expect(chassisInk(state_tag.WORKING, LOCKED_SKIN)).toBe(LOCKED_SKIN.palette.accents.working);
    expect(chassisInk(state_tag.FAULTED, LOCKED_SKIN)).toBe(LOCKED_SKIN.palette.accents.fault);
    // The unknown-state fallthrough is unchanged: an unknown byte still reads as IDLE.
    expect(chassisInk(99, LOCKED_SKIN)).toBe(RAMP4);
  });
});
