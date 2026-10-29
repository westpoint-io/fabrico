import { describe, expect, it } from 'vitest';

// RENDER-04: the fault-port nub is honest - it reads DIM/OUTLINE (ramp[3]) and never
// as a stuck alarm. The role-2 "danger exit" silhouette (filled circle + 1.25px ring)
// is preserved in EVERY state (VIS-03 colour-blind shape redundancy). This suite pins
// that contract at the symbolic level: nubColor is a pure token map, and drawRoleNub
// is driven on a call-recording stub Graphics so no pixi GPU/DOM surface is touched.
//
// AMENDED 2026-08-02 (the maintainer's ruling on the 58 code review's CR-01, "Option A", taken
// on a real render of all three candidates). NO NUB IS EVER `accents.fault` NOW, in
// any role or any state. Until that ruling a FAULTED machine painted every nub fault
// red and role 2 filled SOLID fault on a live fault - and the FAULTED alert ring
// (`machineState.ts`) strokes the same accent in a band all three nub silhouettes
// cross, so halo and port fused into one red mass. The overlap is deliberately still
// there; only the ink was separated. The ring-side gate lives in
// `machineState.test.ts`; what this file pins is the token map that feeds it.

// The machine layer imports pixi.js at module load; mock it away (the drawRoleNub
// silhouette test drives a local stub Graphics, never the real class).
import { vi } from 'vitest';
vi.mock('pixi.js', () => ({
  Container: class {},
  Graphics: class {},
  Sprite: class {},
}));

import { labelStrokeWidth, nubColor, drawRoleNub } from './machines.ts';
import { state_tag } from '../../protocol/kinds.ts';
import { LOCKED_SKIN } from '../synth/skins/locked.ts';
import {
  MEDIUM_ELECTRICAL,
  MEDIUM_MECHANICAL,
  NUB_ELECTRICAL_HALF,
  NUB_FAULT_CORE_R,
  NUB_FAULT_RING_R,
  NUB_R,
  NUB_STROKE,
  type NubSpec,
} from '../../protocol/ports.ts';
import { INSET, NUB_PUSH } from '../../../shared/geometry.ts';
import { MAX_NUB_REACH_PX } from './machineState.ts';

// The real token values from LOCKED_SKIN (locked.ts) - the test asserts the honest
// idle-dim vs live-fault fills against the shipped palette, never an inlined guess.
const RAMP3_DIM = 0x565f70; // LOCKED_SKIN.palette.ramp[3] - idle fault-nub dim/outline
const FAULT = 0xf0506e; // LOCKED_SKIN.palette.accents.fault - live fault fill
const WORKING = 0x34d399; // LOCKED_SKIN.palette.accents.working
const RAMP_LAST = 0xb0bacb; // ramp[4] - IDLE Out (role 1)
const RAMP_PENULT = 0x565f70; // ramp[3] - IDLE In (role 0)

// Roles: In=0, Out=1, Fault=2.
const ROLE_IN = 0;
const ROLE_OUT = 1;
const ROLE_FAULT = 2;

describe('RENDER-04 nubColor: the role-2 fault nub reads DIM, never as an alarm', () => {
  it('idle role-2 fault nub reads DIM ramp[3] (not always-red)', () => {
    expect(nubColor(ROLE_FAULT, state_tag.IDLE, LOCKED_SKIN)).toBe(RAMP3_DIM);
  });

  it('idle role-2 fault nub matches the locked palette ramp[3] token', () => {
    expect(nubColor(ROLE_FAULT, state_tag.IDLE, LOCKED_SKIN)).toBe(LOCKED_SKIN.palette.ramp[3]);
  });

  it('a LIVE fault leaves the role-2 nub DIM too - the ring announces the fault, not the port', () => {
    // The maintainer's CR-01 ruling, 2026-08-02 ("Option A"). This assertion is the exact inverse
    // of the one that stood here until that date, and the inversion is the point: the
    // alert ring strokes accents.fault through the band this nub's annulus occupies, so
    // a fault-red annulus inside a fault-red ring was one shape, not two.
    expect(nubColor(ROLE_FAULT, state_tag.FAULTED, LOCKED_SKIN)).toBe(RAMP3_DIM);
    expect(nubColor(ROLE_FAULT, state_tag.FAULTED, LOCKED_SKIN)).not.toBe(FAULT);
  });

  it('a WORKING machine does not paint its role-2 nub the working accent either', () => {
    // The fault EXIT is a ROLE. It does not track the machine's state in any direction.
    expect(nubColor(ROLE_FAULT, state_tag.WORKING, LOCKED_SKIN)).toBe(RAMP3_DIM);
  });
});

describe('RENDER-04 nubColor: the role 0/1 state channel', () => {
  it('WORKING role 0/1 nubs are the working accent - the channel is still live', () => {
    expect(nubColor(ROLE_IN, state_tag.WORKING, LOCKED_SKIN)).toBe(WORKING);
    expect(nubColor(ROLE_OUT, state_tag.WORKING, LOCKED_SKIN)).toBe(WORKING);
  });

  it('FAULTED role 0/1 nubs fall back to their NORMAL idle ink (CR-01, Option A)', () => {
    // Also inverted by the 2026-08-02 ruling. A faulted machine still recolours its
    // chassis OUTLINE to accents.fault (`machineChassis.ts chassisInk`, 2.5..5.5 px
    // INSIDE the box edge and so nowhere near the ring band) and blinks the alert ring.
    // The PORTS stay neutral so the ring has the fault accent to itself where they meet.
    expect(nubColor(ROLE_IN, state_tag.FAULTED, LOCKED_SKIN)).toBe(RAMP_PENULT);
    expect(nubColor(ROLE_OUT, state_tag.FAULTED, LOCKED_SKIN)).toBe(RAMP_LAST);
    expect(nubColor(ROLE_IN, state_tag.FAULTED, LOCKED_SKIN)).not.toBe(FAULT);
    expect(nubColor(ROLE_OUT, state_tag.FAULTED, LOCKED_SKIN)).not.toBe(FAULT);
  });

  it('IDLE role 0 rests on ramp[3] (In), IDLE role 1 rests on ramp[4] (Out a touch brighter)', () => {
    expect(nubColor(ROLE_IN, state_tag.IDLE, LOCKED_SKIN)).toBe(RAMP_PENULT);
    expect(nubColor(ROLE_OUT, state_tag.IDLE, LOCKED_SKIN)).toBe(RAMP_LAST);
  });

  it('NO (role, state) pair anywhere in the space returns accents.fault', () => {
    // The whole-space statement, so a future edit cannot reintroduce fault ink on some
    // role the cases above happen not to name. The role keyspace is open on the wire,
    // so it is swept past the three known roles.
    for (const role of [0, 1, 2, 3, 7, 255]) {
      for (const state of [state_tag.IDLE, state_tag.WORKING, state_tag.FAULTED]) {
        expect(nubColor(role, state, LOCKED_SKIN), `role ${role} state ${state}`).not.toBe(FAULT);
      }
    }
  });
});

// A minimal call-recording Graphics stub: every method returns `this` so the fluent
// pixi Graphics chain (circle().fill(), moveTo().lineTo().stroke(), circle().stroke())
// works, and each call is logged so the test can assert the drawn silhouette.
interface Call {
  op: string;
  args: unknown[];
}
function makeStubGraphics(): { calls: Call[] } & Record<string, (...a: unknown[]) => unknown> {
  const calls: Call[] = [];
  const g = { calls } as { calls: Call[] } & Record<string, (...a: unknown[]) => unknown>;
  for (const op of ['circle', 'fill', 'moveTo', 'lineTo', 'stroke', 'rect', 'clear']) {
    g[op] = (...args: unknown[]) => {
      calls.push({ op, args });
      return g;
    };
  }
  return g;
}

const faultNub: NubSpec = { x: 10, y: 10, nx: 0, ny: 1, role: ROLE_FAULT, side: 2 } as NubSpec;
const inNub: NubSpec = { x: 10, y: 10, nx: 0, ny: -1, role: ROLE_IN, side: 0 } as NubSpec;

describe('RENDER-04 drawRoleNub: role-2 silhouette preserved in BOTH states', () => {
  const countOps = (g: { calls: Call[] }, op: string): number =>
    g.calls.filter((c) => c.op === op).length;

  it('idle role-2 nub still draws the filled circle + 1.25px ring silhouette', () => {
    const g = makeStubGraphics();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    drawRoleNub(g as any, faultNub, state_tag.IDLE, LOCKED_SKIN);
    // filled circle + ring = two circle() calls, one fill(), one stroke().
    expect(countOps(g, 'circle')).toBe(2);
    expect(countOps(g, 'fill')).toBe(1);
    expect(countOps(g, 'stroke')).toBe(1);
    // The ring is drawn at the dim idle fill (ramp[3]), not fault red.
    const strokeArgs = g.calls.find((c) => c.op === 'stroke')!.args[0] as {
      width: number;
      color: number;
    };
    expect(strokeArgs.width).toBe(1.25);
    expect(strokeArgs.color).toBe(RAMP3_DIM);
  });

  it('faulted role-2 nub draws the SAME silhouette in the SAME dim ink (CR-01, Option A)', () => {
    // The SHAPE is the load-bearing half and it is untouched by the ruling: two
    // circles, one filled core, one stroked annulus, at the same radii as idle. Only
    // the ink stopped tracking the fault, so the alert ring owns that accent alone.
    const g = makeStubGraphics();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    drawRoleNub(g as any, faultNub, state_tag.FAULTED, LOCKED_SKIN);
    expect(countOps(g, 'circle')).toBe(2);
    expect(countOps(g, 'fill')).toBe(1);
    expect(countOps(g, 'stroke')).toBe(1);
    const strokeArgs = g.calls.find((c) => c.op === 'stroke')!.args[0] as {
      width: number;
      color: number;
    };
    expect(strokeArgs.color).toBe(RAMP3_DIM);
    expect(strokeArgs.color).not.toBe(FAULT);
    // The radii, so "same silhouette" is measured and not asserted by adjective.
    const radii = g.calls.filter((c) => c.op === 'circle').map((c) => c.args[2] as number);
    expect(radii).toEqual([NUB_FAULT_CORE_R, NUB_FAULT_RING_R]);
  });

  it('the role-2 ring sits OUTSIDE its core - a true annulus, not a same-radius restroke', () => {
    // 51-UI-REVIEW fix 3. The two circles used to be drawn at the SAME radius in
    // the SAME colour, so the "ring" composited into the fill and the fault nub
    // was simply an In disc 0.625 units fatter. The panel's PortIndicator copied
    // that construction verbatim, and at 12px it made Fault and In the same
    // silhouette - which broke the one thing the glyph column exists for.
    const g = makeStubGraphics();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    drawRoleNub(g as any, faultNub, state_tag.IDLE, LOCKED_SKIN);
    const [core, ring] = g.calls.filter((c) => c.op === 'circle').map((c) => c.args[2] as number);
    expect(core).toBe(NUB_FAULT_CORE_R);
    expect(ring).toBe(NUB_FAULT_RING_R);
    expect(ring, 'the ring is not a restroke of the fill').toBeGreaterThan(core);
    // ...and there is clear substrate between the two, so the gap survives a
    // raster rather than closing up into one solid shape.
    expect(ring - NUB_STROKE / 2, 'the ring clears the core').toBeGreaterThan(core);

    // The In disc is a different size from BOTH parts, so no scale exists at
    // which the fault silhouette collapses onto it.
    const gi = makeStubGraphics();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    drawRoleNub(gi as any, inNub, state_tag.IDLE, LOCKED_SKIN);
    const inR = gi.calls.find((c) => c.op === 'circle')!.args[2] as number;
    expect(inR).toBe(NUB_R);
    expect(core).toBeLessThan(inR);
    expect(ring).toBeGreaterThan(inR);
  });

  it('role-0 In nub is a plain circle (no ring) - unchanged', () => {
    const g = makeStubGraphics();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    drawRoleNub(g as any, inNub, state_tag.IDLE, LOCKED_SKIN);
    expect(countOps(g, 'circle')).toBe(1);
    expect(countOps(g, 'fill')).toBe(1);
    expect(countOps(g, 'stroke')).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * UI-SPEC 1.2: MEDIUM is a SILHOUETTE cue - an ELECTRICAL port draws a
 * SQUARE where a mechanical port draws a DISC (plan 72-09, SERVE-03)
 * ------------------------------------------------------------------ */

describe('drawRoleNub draws a SQUARE for an electrical port', () => {
  const countOps = (g: { calls: Call[] }, op: string): number =>
    g.calls.filter((c) => c.op === op).length;

  /** One nub spec at a given role and medium, on a North-facing side. */
  const nub = (role: number, medium: number | undefined): NubSpec =>
    ({ x: 10, y: 10, nx: 0, ny: -1, role, side: 0, medium }) as NubSpec;

  const draw = (role: number, medium: number | undefined) => {
    const g = makeStubGraphics();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    drawRoleNub(g as any, nub(role, medium), state_tag.IDLE, LOCKED_SKIN);
    return g;
  };

  for (const role of [ROLE_IN, ROLE_OUT]) {
    it(`role ${role} at medium=ELECTRICAL draws a 2*NUB_ELECTRICAL_HALF square and NO disc body`, () => {
      // THE DEFECT THIS CLOSES. On HEAD `drawRoleNub` discriminates on ROLE alone, so an
      // unwired Handler's electrical ports are pixel-identical to a Factory's mechanical
      // ones and two 3x3 machines side by side are the same machine to a reader. The
      // board is the program; it has to show what it is running.
      const g = draw(role, MEDIUM_ELECTRICAL);
      const rects = g.calls.filter((c) => c.op === 'rect');
      expect(rects, `role ${role} drew no square`).toHaveLength(1);
      // The SHIPPED constant, never a mirrored literal: a 5 written here and a
      // NUB_ELECTRICAL_HALF in the source is two sources of truth for one silhouette.
      const [x, y, w, h] = rects[0].args as [number, number, number, number];
      expect(w).toBe(2 * NUB_ELECTRICAL_HALF);
      expect(h).toBe(2 * NUB_ELECTRICAL_HALF);
      // Centred on the nub anchor, so the unconnected port and the terminal a landed
      // cable stamps are the SAME object at the SAME place.
      expect(x).toBe(10 - NUB_ELECTRICAL_HALF);
      expect(y).toBe(10 - NUB_ELECTRICAL_HALF);
      // ...and the disc body is GONE, or the square would merely be a disc with a box
      // around it and the two mediums would still read alike at a glance.
      expect(countOps(g, 'circle'), `role ${role} still drew a disc body`).toBe(0);
    });

    it(`role ${role} at medium=MECHANICAL still draws the DISC - the converse`, () => {
      const g = draw(role, MEDIUM_MECHANICAL);
      expect(countOps(g, 'rect')).toBe(0);
      expect(countOps(g, 'circle')).toBe(1);
      const r = g.calls.find((c) => c.op === 'circle')!.args[2] as number;
      expect(r).toBe(NUB_R);
    });
  }

  it('the electrical role-1 Out keeps its outward stem - role is not lost to medium', () => {
    // Medium is the SECOND axis, not a replacement for the first. Without this the
    // square could have swallowed the Out/In distinction on every electrical port.
    const out = draw(ROLE_OUT, MEDIUM_ELECTRICAL);
    const inn = draw(ROLE_IN, MEDIUM_ELECTRICAL);
    expect(countOps(out, 'stroke')).toBe(1);
    expect(countOps(inn, 'stroke')).toBe(0);
  });

  it('the ink is UNCHANGED by medium - no new hue, and never accents.electric', () => {
    // R-59. The locked bible reserves `electric` for wire ENERGY and a resting nub
    // carries none; `nubColor` already carries the machine-STATE channel and a
    // medium-keyed hue would collide with it head on. Medium is a SILHOUETTE cue.
    const ELECTRIC = LOCKED_SKIN.palette.accents.electric;
    for (const [role, expected] of [
      [ROLE_IN, RAMP_PENULT],
      [ROLE_OUT, RAMP_LAST],
    ] as const) {
      const g = draw(role, MEDIUM_ELECTRICAL);
      const inks = g.calls
        .filter((c) => c.op === 'fill' || c.op === 'stroke')
        .map((c) => (c.args[0] as { color: number }).color);
      expect(inks.length).toBeGreaterThan(0);
      for (const ink of inks) {
        expect(ink, `role ${role} electrical nub ink`).toBe(expected);
        expect(ink).not.toBe(ELECTRIC);
      }
    }
  });

  it('an UNKNOWN medium byte draws the mechanical disc and does NOT throw', () => {
    // T-72-09-01. `portLabels.ts` already reads an unknown medium as `Item`; this
    // matches that conservatism. A throw inside the Pixi ticker kills the renderer
    // permanently while every model assertion stays green, which is this project's
    // recorded model-oracle blind spot.
    for (const medium of [2, 7, 255, undefined]) {
      const g = makeStubGraphics();
      expect(() =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        drawRoleNub(g as any, nub(ROLE_IN, medium), state_tag.IDLE, LOCKED_SKIN),
      ).not.toThrow();
      expect(countOps(g, 'rect'), `medium ${medium} drew a square`).toBe(0);
      expect(countOps(g, 'circle'), `medium ${medium} drew no disc`).toBe(1);
    }
  });

  it('a role-2 FAULT port keeps its annulus at every medium - the danger exit is a ROLE', () => {
    // Unreachable on a shipped board today (a Handler's Fault is Mechanical and a Route
    // has no Fault nub), so it is asserted rather than left to a future reader to guess.
    for (const medium of [MEDIUM_MECHANICAL, MEDIUM_ELECTRICAL]) {
      const g = draw(ROLE_FAULT, medium);
      expect(countOps(g, 'circle'), `medium ${medium}`).toBe(2);
      expect(countOps(g, 'rect'), `medium ${medium}`).toBe(0);
    }
  });

  it('the square does NOT move MAX_NUB_REACH_PX - the one geometric consequence it could have had', () => {
    // R-57, asserted rather than argued. Reach is `extent - INSET + NUB_PUSH`. The
    // square reaches 5.500 px outside the box edge: between the role-0 disc at 4.000
    // and the role-2 annulus at 6.125, and well inside the role-1 stem at 7.625 that
    // already defines the maximum. So `ALERT_RING_OUTSET_U` is untouched and the square
    // crosses the alert-ring band (2.000 .. 4.000) exactly as all three shipped
    // silhouettes already do.
    const squareReach = NUB_ELECTRICAL_HALF - INSET + NUB_PUSH;
    expect(squareReach).toBeCloseTo(5.5, 6);
    expect(squareReach).toBeGreaterThan(NUB_R - INSET + NUB_PUSH);
    expect(squareReach).toBeLessThan(MAX_NUB_REACH_PX);
    // The shipped derived maximum, unmoved. `machineState.test.ts` measures this off
    // real Pixi bounds; this states the number the new silhouette must not have moved.
    expect(MAX_NUB_REACH_PX).toBeCloseTo(7.625, 6);
  });
});

// Phase 76 (SHAPE-10, UI-SPEC 3.4). This file mocks pixi.js away, so the label box's
// PLOT cases live in `machineVector.test.ts`, which drives the real Graphics; the pure
// width rule is pinned here.
describe('the label box stroke width (phase 76)', () => {
  it('is the plan 75-10 cable floor over the 2u detail weight', () => {
    expect(labelStrokeWidth(LOCKED_SKIN, 1)).toBe(2);
    expect(labelStrokeWidth(LOCKED_SKIN, 0.5)).toBe(2);
    expect(labelStrokeWidth(LOCKED_SKIN, 0.25)).toBe(4);
  });
});
