// boardMeasure.test.ts - the board capture set's measurer, run over images built in code.
//
// Every case builds a small capture with one machine outline drawn on the board floor, measures
// it with the same functions the capture set runs, and checks two things: the defect it plants is
// reported, and its clean twin passes. That pair is what keeps the measurer from becoming a check
// that can't fail: a reader that returned 3 for every side, or skipped every line, would pass the
// clean twins and fail the defect cases here.

import { describe, expect, it } from 'vitest';
import { CELL } from '../../shared/geometry';
import { state_tag } from '../protocol/kinds';
import { chassisInk } from '../render/layers/machineChassis';
import { LOCKED_SKIN } from '../render/synth/skins/locked';
import {
  AA_ON_TOLERANCE,
  CORE_MIN,
  FRINGE_MIN,
  NUB_ALONG_REACH_PX,
  captureMasks,
  coverageOf,
  gradeOutlineSides,
  measureCapture,
  outlineBandFor,
  readSampleLine,
  type MachineOutline,
  type Rgb,
  type SideName,
} from '../../e2e-live/support/boardMeasure';
import type { DecodedImage } from '../../e2e-live/support/canvasDots';
import type { CaptureFacts, CaptureNode } from '../../e2e-live/support/captureFacts';
import type { CaptureCell } from '../../e2e-live/support/captureMatrix';

const FLOOR = 0x1b1f27;
const IDLE_INK = chassisInk(state_tag.IDLE, LOCKED_SKIN);
const SIZE = 128;

const rgb = (c: number): Rgb => [(c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff];
const grey = (v: number): number => (v << 16) | (v << 8) | v;

function blank(): DecodedImage {
  const data = new Uint8Array(SIZE * SIZE * 4);
  const [r, g, b] = rgb(FLOOR);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = 255;
  }
  return { width: SIZE, height: SIZE, data };
}

function paint(img: DecodedImage, x: number, y: number, colour: number): void {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
  const i = (y * img.width + x) * 4;
  [img.data[i], img.data[i + 1], img.data[i + 2]] = rgb(colour);
}

function fillRect(img: DecodedImage, x0: number, y0: number, x1: number, y1: number, colour: number): void {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) paint(img, x, y, colour);
}

/**
 * A 2x2 machine on cells (1,1) to (2,2), camera at scale 1 with no pan, ratio 1. Its footprint is
 * world px 32 to 96 on both axes; the chassis band sits 2.5 to 5.5 px inside each edge, so its
 * pixels are 35, 36, 37 on the left and top and 90, 91, 92 on the right and bottom.
 */
const NODE: CaptureNode = {
  id: 1,
  kind: 2,
  state: state_tag.IDLE,
  cells: [
    [1, 1],
    [2, 1],
    [1, 2],
    [2, 2],
  ],
  ports: [],
  isLabel: false,
};

function facts(over: Partial<CaptureFacts> = {}): CaptureFacts {
  return {
    dpr: 1,
    backing: { width: SIZE, height: SIZE },
    client: { width: SIZE, height: SIZE },
    clientRect: { left: 0, top: 0, width: SIZE, height: SIZE },
    camera: { x: 0, y: 0, scale: 1 },
    tick: 0,
    nodes: [NODE],
    panels: [],
    gl: { antialias: false, samples: 0 },
    cables: [],
    itemDots: [],
    labelWords: [],
    alertRings: [],
    ...over,
  };
}

/**
 * Paint a square outline from the outer pixel `o` to the far outer pixel `f` on both axes, each
 * side drawn as `profile` (pixel values from the outer edge inward). `override` swaps one side's
 * profile.
 */
function outline(img: DecodedImage, profile: number[], override: Partial<Record<SideName, number[]>> = {}, o = 35, f = 92): void {
  const sideProfile = (s: SideName) => override[s] ?? profile;
  for (let along = o; along <= f; along++) {
    sideProfile('left').forEach((c, k) => paint(img, o + k, along, c));
    sideProfile('right').forEach((c, k) => paint(img, f - k, along, c));
    sideProfile('top').forEach((c, k) => paint(img, along, o + k, c));
    sideProfile('bottom').forEach((c, k) => paint(img, along, f - k, c));
  }
}

const SOLID3 = [IDLE_INK, IDLE_INK, IDLE_INK];
const SHIPPED_AT_1: CaptureCell = { dpr: 1, aa: 'shipped', zoom: 1 };
const AA_ON_AT_1: CaptureCell = { dpr: 1, aa: 'on', zoom: 1 };
const AA_ON_AT_2: CaptureCell = { dpr: 1, aa: 'on', zoom: 2 };

function measure(img: DecodedImage, f: CaptureFacts = facts()): MachineOutline[] {
  return measureCapture(img, f);
}

function coresOf(m: MachineOutline): Record<SideName, number | null> {
  const out = {} as Record<SideName, number | null>;
  for (const [side, s] of Object.entries(m.sides) as [SideName, MachineOutline['sides'][SideName]][]) out[side] = s.measured ? s.core : null;
  return out;
}

describe('coverage and one sample line', () => {
  it('reads coverage 0 on the floor, 1 on the ink and the blend in between', () => {
    expect(coverageOf(rgb(FLOOR), rgb(FLOOR), rgb(IDLE_INK))).toBe(0);
    expect(coverageOf(rgb(IDLE_INK), rgb(FLOOR), rgb(IDLE_INK))).toBe(1);
    expect(coverageOf(rgb(grey(110)), rgb(FLOOR), rgb(IDLE_INK))).toBeGreaterThan(FRINGE_MIN);
    expect(coverageOf(rgb(grey(110)), rgb(FLOOR), rgb(IDLE_INK))).toBeLessThan(CORE_MIN);
  });

  it('reads the antialiased edge row 110/188/188/110 as a core of 2 and a fringe of 2', () => {
    const line = [FLOOR, FLOOR, grey(110), grey(188), grey(188), grey(110), FLOOR, FLOOR].map(rgb);
    const r = readSampleLine(line);
    expect(r).toMatchObject({ ok: true, core: 2, fringe: 2 });
    // Its crisp twin: the same width with no grey reads a core of 3 and no fringe.
    expect(readSampleLine([FLOOR, FLOOR, IDLE_INK, IDLE_INK, IDLE_INK, FLOOR, FLOOR].map(rgb))).toMatchObject({ ok: true, core: 3, fringe: 0 });
  });

  it('refuses a line with no stroke on it rather than reading a width of 0', () => {
    expect(readSampleLine([FLOOR, FLOOR, FLOOR, FLOOR, FLOOR].map(rgb))).toMatchObject({ ok: false });
  });

  it('refuses a line with other ink beside the stroke, and reads its clean twin', () => {
    // One pixel of another shape, a floor pixel, then the 3 px stroke.
    expect(readSampleLine([FLOOR, IDLE_INK, FLOOR, IDLE_INK, IDLE_INK, IDLE_INK, FLOOR, FLOOR].map(rgb))).toMatchObject({ ok: false });
    expect(readSampleLine([FLOOR, FLOOR, FLOOR, IDLE_INK, IDLE_INK, IDLE_INK, FLOOR, FLOOR].map(rgb))).toMatchObject({ ok: true, core: 3 });
  });

  it('refuses a stroke touched by a pixel of another colour, such as a cable terminal', () => {
    const cyan = LOCKED_SKIN.palette.accents.electric;
    expect(readSampleLine([FLOOR, FLOOR, cyan, IDLE_INK, IDLE_INK, IDLE_INK, FLOOR, FLOOR].map(rgb))).toMatchObject({ ok: false });
    expect(readSampleLine([FLOOR, FLOOR, FLOOR, IDLE_INK, IDLE_INK, IDLE_INK, FLOOR, FLOOR].map(rgb))).toMatchObject({ ok: true, core: 3 });
  });

  it('refuses a line whose two ends differ by more than the grid lines do, such as a dim rail end', () => {
    expect(readSampleLine([grey(0x60), FLOOR, IDLE_INK, IDLE_INK, IDLE_INK, FLOOR, FLOOR].map(rgb))).toMatchObject({ ok: false });
    // The board's major grid line at the end is allowed: it is floor, not a shape.
    expect(readSampleLine([0x3b4250, FLOOR, IDLE_INK, IDLE_INK, IDLE_INK, FLOOR, FLOOR].map(rgb))).toMatchObject({ ok: true, core: 3 });
  });

  it('reads a minor grid line crossing the sample line as no stroke, not as a 1 px outline', () => {
    expect(readSampleLine([FLOOR, FLOOR, 0x2a2f3a, FLOOR, FLOOR].map(rgb))).toMatchObject({ ok: false });
  });

  it('refuses a line with ink at both ends rather than reading the dark gap between as the stroke', () => {
    // A glyph inside and a nub outside, both in the outline's ink, with 2 px of floor between.
    expect(readSampleLine([IDLE_INK, IDLE_INK, FLOOR, FLOOR, IDLE_INK, IDLE_INK].map(rgb))).toMatchObject({ ok: false });
    expect(readSampleLine([FLOOR, IDLE_INK, IDLE_INK, FLOOR, FLOOR, FLOOR].map(rgb))).toMatchObject({ ok: true, core: 2 });
  });
});

describe('outline sides, antialiasing as shipped', () => {
  it('reads a 3 px outline as a core of 3 on all four sides, and the grade passes', () => {
    const img = blank();
    outline(img, SOLID3);
    const [m] = measure(img);
    expect(coresOf(m)).toEqual({ top: 3, right: 3, bottom: 3, left: 3 });
    expect(gradeOutlineSides([m], SHIPPED_AT_1).offenders).toEqual([]);
  });

  it('fails the same outline with its right side 2 px, naming the right side', () => {
    const img = blank();
    outline(img, SOLID3, { right: [FLOOR, IDLE_INK, IDLE_INK] });
    const [m] = measure(img);
    expect(coresOf(m)).toEqual({ top: 3, right: 2, bottom: 3, left: 3 });
    const g = gradeOutlineSides([m], SHIPPED_AT_1);
    expect(g.offenders).toHaveLength(1);
    expect(g.offenders[0]).toContain('right 2');
  });

  it('finds the ink per line, so a working, faulted or backed-up machine measures the same as an idle one', () => {
    for (const state of [state_tag.IDLE, state_tag.WORKING, state_tag.FAULTED, state_tag.BACKED_UP]) {
      const ink = chassisInk(state, LOCKED_SKIN);
      const img = blank();
      outline(img, [ink, ink, ink]);
      const [m] = measure(img, facts({ nodes: [{ ...NODE, state }] }));
      expect(coresOf(m), `state ${state}`).toEqual({ top: 3, right: 3, bottom: 3, left: 3 });
      expect(gradeOutlineSides([m], SHIPPED_AT_1).offenders, `state ${state}`).toEqual([]);
      // The defect twin in the same colour: one side a pixel thinner fails.
      const thin = blank();
      outline(thin, [ink, ink, ink], { bottom: [FLOOR, ink, ink] });
      expect(gradeOutlineSides(measure(thin, facts({ nodes: [{ ...NODE, state }] })), SHIPPED_AT_1).offenders, `state ${state}`).toHaveLength(1);
    }
  });
});

describe('outline sides, antialiasing on', () => {
  const EDGE = [grey(110), grey(188), grey(188), grey(110)];

  it('fails the 110/188/188/110 edge at zoom 1 on its fringe, and passes it at zoom 2 with equal effective widths', () => {
    const img = blank();
    outline(img, EDGE);
    const results = measure(img);
    const [m] = results;
    expect(coresOf(m)).toEqual({ top: 2, right: 2, bottom: 2, left: 2 });
    const atOne = gradeOutlineSides(results, AA_ON_AT_1);
    expect(atOne.offenders).toHaveLength(1);
    expect(atOne.offenders[0]).toContain('grey fringe');
    expect(gradeOutlineSides(results, AA_ON_AT_2).offenders).toEqual([]);
  });

  /** One machine whose sides measured these effective widths, with no fringe. */
  function withEffective(widths: Record<SideName, number>): MachineOutline {
    const side = (effective: number) => ({ measured: true as const, core: 3, fringe: 0, effective, lines: 5, skipped: 0 });
    return { nodeId: 1, kind: 2, sides: { top: side(widths.top), right: side(widths.right), bottom: side(widths.bottom), left: side(widths.left) } };
  }

  it(`passes effective widths spread by exactly ${AA_ON_TOLERANCE} px and fails a spread of 0.26 px`, () => {
    expect(AA_ON_TOLERANCE).toBe(0.25);
    expect(gradeOutlineSides([withEffective({ top: 3, right: 3, bottom: 3, left: 3.25 })], AA_ON_AT_2).offenders).toEqual([]);
    const over = gradeOutlineSides([withEffective({ top: 3, right: 3, bottom: 3, left: 3.26 })], AA_ON_AT_2);
    expect(over.offenders).toHaveLength(1);
    expect(over.offenders[0]).toContain('spread 0.26');
  });
});

describe('what the measurer refuses to read', () => {
  it('masks the one sample line a port-nub disc touches, measures the side from its other lines, and keeps the core at 3', () => {
    const band = outlineBandFor(facts(), NODE).sides.find((s) => s.side === 'right');
    if (band === undefined) throw new Error('no right side');
    const row = band.lines[Math.floor(band.lines.length / 2)];
    const clean = blank();
    outline(clean, SOLID3);
    const cleanRight = measure(clean)[0].sides.right;
    expect(cleanRight).toMatchObject({ measured: true, core: 3, skipped: 0 });

    // A disc of the outline's own ink, touching the right side's outer edge on that one row only.
    const img = blank();
    outline(img, SOLID3);
    paint(img, 93, row, IDLE_INK);
    fillRect(img, 94, row, 99, row, IDLE_INK);
    const right = measure(img)[0].sides.right;
    expect(right).toMatchObject({ measured: true, core: 3, skipped: 1, lines: band.lines.length - 1 });
  });

  it("keeps sample lines off a port nub's reach along its side, and leaves the side lines elsewhere", () => {
    // A port on cell (2,1)'s east edge: its nub sits on the right side at world y 48.
    const withPort: CaptureNode = { ...NODE, ports: [{ cell_x: 2, cell_y: 1, side: 1, role: 0 }] };
    const right = outlineBandFor(facts({ nodes: [withPort] }), withPort).sides.find((s) => s.side === 'right');
    const bare = outlineBandFor(facts(), NODE).sides.find((s) => s.side === 'right');
    if (right === undefined || bare === undefined) throw new Error('no right side');
    expect(bare.lines.some((y) => Math.abs(y + 0.5 - 48) < NUB_ALONG_REACH_PX)).toBe(true);
    expect(right.lines.length).toBeGreaterThan(0);
    expect(right.lines.filter((y) => Math.abs(y + 0.5 - 48) < NUB_ALONG_REACH_PX)).toEqual([]);
  });

  it('reads a side that a chrome panel covers entirely as not measured, and the grade lists it', () => {
    const img = blank();
    outline(img, SOLID3);
    const covered = facts({ panels: [{ left: 80, top: 0, width: 48, height: SIZE }] });
    const [m] = measure(img, covered);
    expect(m.sides.right.measured).toBe(false);
    expect(m.sides.left.measured).toBe(true);
    const g = gradeOutlineSides([m], SHIPPED_AT_1);
    expect(g.offenders).toHaveLength(1);
    expect(g.offenders[0]).toMatch(/right: not measured .*a chrome panel/);
    // The clean twin: the same capture with no panel grades clean.
    expect(gradeOutlineSides(measure(img), SHIPPED_AT_1).offenders).toEqual([]);
  });

  it('reads an image with no outline at the expected place as not measured on every side, never as a width of 0', () => {
    const [m] = measure(blank());
    expect(Object.values(m.sides).map((s) => s.measured)).toEqual([false, false, false, false]);
    const g = gradeOutlineSides([m], SHIPPED_AT_1);
    expect(g.offenders).toHaveLength(4);
    expect(g.offenders.every((o) => o.includes('not measured'))).toBe(true);
    // An outline drawn somewhere else is no better: still nothing at the expected place.
    const moved = blank();
    outline(moved, SOLID3, {}, 5, 30);
    expect(Object.values(measure(moved)[0].sides).every((s) => !s.measured)).toBe(true);
  });

  it('grades a capture with no machine in it as an offender', () => {
    expect(gradeOutlineSides([], SHIPPED_AT_1).offenders).toEqual(['no machine was measured in this capture']);
  });
});

describe('masks built from the capture facts', () => {
  it('masks a cable from its polyline and stroke width, so a side the cable runs along is not measured', () => {
    // A cable running down the right side's band. The capture shows the outline (the cable is not
    // painted), so only the mask can keep these lines out.
    const img = blank();
    outline(img, SOLID3);
    const f = facts({ cables: [[{ x: 91, y: 0 }, { x: 91, y: SIZE }]] });
    const masks = captureMasks(f);
    expect(masks.some((m) => m.what === 'a cable' && m.x0 <= 90 && m.x1 >= 93)).toBe(true);
    const [m] = measure(img, f);
    expect(m.sides.right).toMatchObject({ measured: false });
    expect(m.sides.right.measured === false && m.sides.right.reason).toContain('a cable');
    expect(m.sides.left.measured).toBe(true);
  });

  it('masks item dots, label words, label nodes and alert rings', () => {
    const label: CaptureNode = { id: 9, kind: 11, state: 0, cells: [[3, 0]], ports: [], isLabel: true };
    const f = facts({
      nodes: [NODE, label],
      itemDots: [{ x: 10, y: 10 }],
      labelWords: [{ left: 100, top: 100, width: 20, height: 10 }],
      alertRings: [{ x: 64, y: 100 }],
    });
    const whats = captureMasks(f).map((m) => m.what);
    expect(whats).toEqual(expect.arrayContaining(['an item dot', 'label words', 'a label', 'an alert ring']));
    const dot = captureMasks(f).find((m) => m.what === 'an item dot');
    expect(dot !== undefined && dot.x0 < 10 && dot.x1 > 10 && dot.y0 < 10 && dot.y1 > 10).toBe(true);
    const lab = captureMasks(f).find((m) => m.what === 'a label');
    expect(lab).toMatchObject({ x0: 3 * CELL, y0: 0, x1: 4 * CELL, y1: CELL });
    // An alert ring over the bottom side masks it, so the side reads not measured.
    const img = blank();
    outline(img, SOLID3);
    const ringed = measure(img, facts({ alertRings: [{ x: 64, y: 91 }, { x: 44, y: 91 }, { x: 84, y: 91 }] }))[0];
    expect(ringed.sides.bottom.measured).toBe(false);
    expect(ringed.sides.top.measured).toBe(true);
  });
});
