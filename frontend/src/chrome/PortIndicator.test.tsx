import { describe, expect, it } from 'vitest';
import { PortIndicator, PORT_INDICATOR_PX, PORT_INDICATOR_VIEW_U } from './PortIndicator.tsx';
import {
  MEDIUM_ELECTRICAL,
  MEDIUM_MECHANICAL,
  NUB_ELECTRICAL_HALF,
  NUB_FAULT_CORE_R,
  NUB_FAULT_RING_R,
  NUB_R,
  NUB_STEM,
  NUB_STROKE,
} from '../protocol/ports.ts';

// PortIndicator.test.tsx (51-UI-REVIEW fix 3) - the panel glyph's SILHOUETTE
// contract, which had no node coverage at all: the shape was asserted only by
// `panel-flow.spec.ts` counting `svg > *` children, and a child count cannot
// tell a ring from a restroke of its own fill. That is exactly how the defect
// this file pins survived: role 2 drew `circle(r).fill()` + `circle(r).stroke()`
// - two children, one shape - so the count assertion was green while In and
// Fault rendered as the same disc half a device pixel apart at 12px.
//
// The vitest env is `node` (no DOM, no testing-library - the repo's zero-new-
// packages discipline). `PortIndicator` is a pure function, so it is invoked
// directly and the returned element tree walked, exactly like
// `PortsSection.test.tsx` / `ConfigPanel.test.tsx`.

interface El {
  type: unknown;
  props: Record<string, unknown> & { children?: unknown };
}
function isEl(x: unknown): x is El {
  return typeof x === 'object' && x !== null && 'props' in x && 'type' in x;
}
function findAll(node: unknown, pred: (el: El) => boolean): El[] {
  const hits: El[] = [];
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) {
      n.forEach(walk);
      return;
    }
    if (!isEl(n)) return;
    if (pred(n)) hits.push(n);
    walk(n.props.children);
  };
  walk(node);
  return hits;
}

const ROLE_IN = 0;
const ROLE_OUT = 1;
const ROLE_FAULT = 2;

/** The glyph's drawn primitives (everything under the <svg>). */
const shapes = (role: number): El[] =>
  findAll(PortIndicator({ role }), (el) => el.type === 'circle' || el.type === 'line');
const circles = (role: number): El[] => shapes(role).filter((el) => el.type === 'circle');
const svgOf = (role: number): El => findAll(PortIndicator({ role }), (el) => el.type === 'svg')[0];

/** The viewBox extent, so "does it fit" is asked against the real box. */
const viewBox = (): { size: number; centre: number } => {
  const parts = String(svgOf(ROLE_IN).props.viewBox).split(' ').map(Number);
  return { size: parts[2], centre: parts[2] / 2 };
};

describe('PortIndicator - the role silhouette', () => {
  it('draws In as a single plain disc at the shared nub radius', () => {
    const s = shapes(ROLE_IN);
    expect(s).toHaveLength(1);
    expect(s[0].type).toBe('circle');
    expect(s[0].props.r).toBe(NUB_R);
    expect(s[0].props.fill).toBe('currentColor');
    expect(s[0].props.stroke, 'the In disc carries no stroke of any kind').toBeUndefined();
  });

  it('draws Out as the SAME disc plus an outward stem', () => {
    const s = shapes(ROLE_OUT);
    expect(s.map((el) => el.type)).toEqual(['circle', 'line']);
    expect(s[0].props.r, 'Out and In share the disc - the stem is the difference').toBe(NUB_R);
    // The stem leaves the disc's edge and reaches the canvas number.
    const { centre } = viewBox();
    expect(s[1].props.x1).toBe(centre + NUB_R);
    expect(s[1].props.x2).toBe(centre + NUB_STEM);
    expect(s[1].props.strokeWidth).toBe(NUB_STROKE);
  });

  it('draws Fault as a small core inside a ring at a LARGER radius (an annulus)', () => {
    // The finding. Before this, role 2 was `circle(NUB_R).fill()` +
    // `circle(NUB_R).stroke()` - a stroke straddling the same radius as its own
    // fill, in the same `currentColor`. That composites into one disc 0.625
    // units fatter than In: two elements, one shape.
    const c = circles(ROLE_FAULT);
    expect(c).toHaveLength(2);
    const [core, ring] = c;

    expect(core.props.r).toBe(NUB_FAULT_CORE_R);
    expect(core.props.fill).toBe('currentColor');

    expect(ring.props.r).toBe(NUB_FAULT_RING_R);
    expect(ring.props.fill, 'the ring is hollow - that is what makes it a ring').toBe('none');
    expect(ring.props.strokeWidth).toBe(NUB_STROKE);

    // The two are genuinely separated, with substrate between them, so the shape
    // does not close up into a disc when rastered.
    expect(Number(ring.props.r)).toBeGreaterThan(Number(core.props.r));
    expect(Number(ring.props.r) - NUB_STROKE / 2).toBeGreaterThan(Number(core.props.r));
  });

  it('makes Fault unmistakable from In: different core, and an outer edge ~2 units further out', () => {
    const inOuter = NUB_R;
    const faultOuter = NUB_FAULT_RING_R + NUB_STROKE / 2;
    expect(NUB_FAULT_CORE_R, 'the fault core is smaller than the In disc').toBeLessThan(NUB_R);
    expect(faultOuter, 'and its silhouette reaches further out').toBeGreaterThan(inOuter);
    // At the 12px render box the difference must survive the raster: the glyph
    // is drawn from a `size`-unit viewBox, so one unit is PORT_INDICATOR_PX/size
    // device px. A sub-pixel difference is what the old construction gave.
    const pxPerUnit = PORT_INDICATOR_PX / viewBox().size;
    expect(
      (faultOuter - inOuter) * pxPerUnit,
      'the outer radii differ by more than a device pixel at 12px',
    ).toBeGreaterThan(1);
  });

  it('keeps every silhouette inside the viewBox', () => {
    const { size, centre } = viewBox();
    const outer = [
      NUB_R,
      NUB_STEM,
      NUB_FAULT_CORE_R,
      NUB_FAULT_RING_R + NUB_STROKE / 2,
    ];
    for (const r of outer) {
      expect(centre + r, `extent ${r} fits`).toBeLessThanOrEqual(size);
      expect(centre - r).toBeGreaterThanOrEqual(0);
    }
  });

  it('falls an UNKNOWN role byte back to the In disc rather than drawing nothing', () => {
    // The role keyspace is open on the wire (T-51-01): a byte this build predates
    // must still draw a glyph, and it must not borrow the fault silhouette.
    const s = shapes(99);
    expect(s).toHaveLength(1);
    expect(s[0].props.r).toBe(NUB_R);
  });

  it('names no colour of its own - the caller sets it via currentColor', () => {
    for (const role of [ROLE_IN, ROLE_OUT, ROLE_FAULT, 99]) {
      for (const el of shapes(role)) {
        for (const key of ['fill', 'stroke']) {
          const v = el.props[key];
          if (v === undefined) continue;
          expect(v, `${key} on role ${role}`).toMatch(/^(currentColor|none)$/);
        }
      }
    }
  });

  it('is a decorative glyph at the fixed panel size, not a target', () => {
    for (const role of [ROLE_IN, ROLE_OUT, ROLE_FAULT]) {
      const svg = svgOf(role);
      expect(svg.props['aria-hidden']).toBe('true');
      expect(svg.props.focusable).toBe('false');
      expect(svg.props.width).toBe(PORT_INDICATOR_PX);
      expect(svg.props.height).toBe(PORT_INDICATOR_PX);
    }
  });

  // Phase 92 (D-04, RESEARCH Finding K): the Legend's Ports swatches draw the nub through this
  // component at one pixel per unit, so the box is a prop; the default is unchanged at 12.
  it('takes an optional px box, defaults it to 12, and never changes the geometry with it', () => {
    expect(PORT_INDICATOR_PX).toBe(12);
    expect(PORT_INDICATOR_VIEW_U).toBe(13);
    for (const role of [ROLE_IN, ROLE_OUT, ROLE_FAULT]) {
      const at = (px?: number): El => findAll(PortIndicator({ role, px }), (el) => el.type === 'svg')[0];
      expect(at().props.width, 'absent px is the 12 px default').toBe(12);
      expect(at(PORT_INDICATOR_VIEW_U).props.width).toBe(13);
      expect(at(PORT_INDICATOR_VIEW_U).props.height).toBe(13);
      expect(at(PORT_INDICATOR_VIEW_U).props.viewBox, 'the same viewBox at every box').toBe(at().props.viewBox);
      const prims = (px?: number) =>
        findAll(PortIndicator({ role, px }), (el) => el.type === 'circle' || el.type === 'line').map((el) => el.props);
      expect(prims(PORT_INDICATOR_VIEW_U), 'the same primitives at every box').toEqual(prims());
    }
  });
});

/* ------------------------------------------------------------------ *
 * UI-SPEC 1.2: the panel speaks the SAME medium vocabulary as the grid
 * (plan 72-09, R-56, SERVE-03)
 * ------------------------------------------------------------------ */

describe('PortIndicator draws a SQUARE for an electrical port', () => {
  /**
   * TWO TESTS, NOT ONE, AND THAT IS THE WHOLE REASON THIS COMPONENT EXISTS (R-56).
   *
   * This file's header states the job: the panel's I/O rows must be readable as the
   * SAME vocabulary the grid speaks, so the glyph reproduces `drawRoleNub` shape for
   * shape at panel scale. The defect it exists to prevent is therefore THE PANEL AND
   * THE CANVAS DISAGREEING, and a single test on either side cannot see a
   * disagreement. The canvas half is
   * `render/layers/machines.test.ts > drawRoleNub draws a SQUARE for an electrical
   * port`; this is the panel half. Both read the SHIPPED `NUB_ELECTRICAL_HALF`, so a
   * change to the constant moves both silhouettes or neither.
   */
  const allShapes = (role: number, medium?: number): El[] =>
    findAll(
      PortIndicator({ role, medium }),
      (el) => el.type === 'circle' || el.type === 'line' || el.type === 'rect',
    );
  const rectsOf = (role: number, medium?: number): El[] =>
    allShapes(role, medium).filter((el) => el.type === 'rect');
  const circlesOf = (role: number, medium?: number): El[] =>
    allShapes(role, medium).filter((el) => el.type === 'circle');

  for (const role of [ROLE_IN, ROLE_OUT]) {
    it(`role ${role} at medium=ELECTRICAL renders a <rect> of side 2*NUB_ELECTRICAL_HALF and no <circle> body`, () => {
      const rects = rectsOf(role, MEDIUM_ELECTRICAL);
      expect(rects, `role ${role} rendered no <rect>`).toHaveLength(1);
      expect(rects[0].props.width).toBe(2 * NUB_ELECTRICAL_HALF);
      expect(rects[0].props.height).toBe(2 * NUB_ELECTRICAL_HALF);
      expect(circlesOf(role, MEDIUM_ELECTRICAL), `role ${role} kept its disc body`).toHaveLength(
        0,
      );
    });

    it(`role ${role} at medium=MECHANICAL still renders the <circle> - the converse`, () => {
      expect(rectsOf(role, MEDIUM_MECHANICAL)).toHaveLength(0);
      const cs = circlesOf(role, MEDIUM_MECHANICAL);
      expect(cs).toHaveLength(1);
      expect(cs[0].props.r).toBe(NUB_R);
    });
  }

  it('the square is CENTRED in the viewBox, exactly where the disc was', () => {
    // Otherwise the panel column would jitter between an electrical row and a
    // mechanical one, which is the sort of thing that reads as a rendering bug.
    const { centre } = viewBox();
    const rect = rectsOf(ROLE_IN, MEDIUM_ELECTRICAL)[0];
    expect(rect.props.x).toBe(centre - NUB_ELECTRICAL_HALF);
    expect(rect.props.y).toBe(centre - NUB_ELECTRICAL_HALF);
  });

  it('the square FITS the 13-unit viewBox rather than being clipped', () => {
    const { size, centre } = viewBox();
    expect(centre - NUB_ELECTRICAL_HALF).toBeGreaterThanOrEqual(0);
    expect(centre + NUB_ELECTRICAL_HALF).toBeLessThanOrEqual(size);
  });

  it('an electrical role-1 Out keeps its outward stem - role is not lost to medium', () => {
    const out = allShapes(ROLE_OUT, MEDIUM_ELECTRICAL).filter((el) => el.type === 'line');
    const inn = allShapes(ROLE_IN, MEDIUM_ELECTRICAL).filter((el) => el.type === 'line');
    expect(out).toHaveLength(1);
    expect(inn).toHaveLength(0);
    // The stem geometry is the SHIPPED one, unchanged by medium: that is what keeps
    // `MAX_NUB_REACH_PX` at 7.625 on the canvas side.
    expect(out[0].props.x2).toBe(viewBox().centre + NUB_STEM);
  });

  it('an UNKNOWN or ABSENT medium falls back to the mechanical disc and never throws', () => {
    // The medium keyspace is open on the wire exactly as the role keyspace is, and
    // `portLabels.ts` already reads an unknown medium as `Item`. `undefined` is the
    // live case: every caller that predates this prop passes no medium at all.
    for (const medium of [undefined, 2, 7, 255]) {
      expect(() => PortIndicator({ role: ROLE_IN, medium })).not.toThrow();
      expect(rectsOf(ROLE_IN, medium), `medium ${medium}`).toHaveLength(0);
      expect(circlesOf(ROLE_IN, medium), `medium ${medium}`).toHaveLength(1);
    }
  });

  it('a role-2 FAULT port keeps its annulus at every medium - the danger exit is a ROLE', () => {
    for (const medium of [MEDIUM_MECHANICAL, MEDIUM_ELECTRICAL]) {
      expect(circlesOf(ROLE_FAULT, medium), `medium ${medium}`).toHaveLength(2);
      expect(rectsOf(ROLE_FAULT, medium), `medium ${medium}`).toHaveLength(0);
    }
  });

  it('the square names no colour of its own - the caller still sets it via currentColor', () => {
    for (const role of [ROLE_IN, ROLE_OUT]) {
      for (const el of allShapes(role, MEDIUM_ELECTRICAL)) {
        for (const key of ['fill', 'stroke']) {
          const v = el.props[key];
          if (v === undefined) continue;
          expect(v, `${key} on role ${role}`).toMatch(/^(currentColor|none)$/);
        }
      }
    }
  });
});
