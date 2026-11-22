// boardMeasure.test.ts - the board capture set's measurer, run over images built in code.
//
// Every case builds a small capture with one machine outline drawn on the board floor, measures
// it with the same functions the capture set runs, and checks two things: the defect it plants is
// reported, and its clean twin passes. That pair is what keeps the measurer from becoming a check
// that can't fail: a reader that returned 3 for every side, or skipped every line, would pass the
// clean twins and fail the defect cases here.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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
  factoryGlyph,
  gradeBeltDash,
  gradeCapInCell,
  gradeCell,
  gradeFaultRing,
  gradeGlyphStrokes,
  gradeOutlineSides,
  gradeRailVsOutline,
  liveAntialias,
  measureBeltDash,
  measureCapWidth,
  measureCapture,
  measureFaultRing,
  measureGlyphStrokes,
  measureRailWidth,
  measureTile,
  measureTileProperties,
  outlineBandFor,
  outlineClearOfChrome,
  outlineWidthOf,
  outlinesForCell,
  readSampleLine,
  type GlyphLegRow,
  type GlyphSegment,
  type MachineOutline,
  type Rgb,
  type SideName,
  type TileRecord,
} from '../../e2e-live/support/boardMeasure';
import type { DecodedImage } from '../../e2e-live/support/canvasDots';
import type { CaptureBelt, CaptureFacts, CaptureNode } from '../../e2e-live/support/captureFacts';
import type { CaptureCell } from '../../e2e-live/support/captureMatrix';
import {
  DECLARED_DEFECTS,
  assertDeclaredRowsMatchCells,
  checkDeclared,
  runGradeCell,
  type DeclaredDefect,
} from '../../e2e-live/support/captureDefects';
import {
  CAPTURE_BOOT_CEILING_MS,
  CAPTURE_BOOTS,
  CAPTURE_GLOBAL_TIMEOUT_MS,
  PROPERTY_IDS,
  bootId,
  captureBootCeilingMs,
  captureLimitProblems,
  gradingCells,
  type PropertyId,
} from '../../e2e-live/support/captureMatrix';

const FLOOR = 0x1b1f27;
const IDLE_INK = chassisInk(state_tag.IDLE, LOCKED_SKIN);
const SIZE = 128;

const rgb = (c: number): Rgb => [(c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff];
const grey = (v: number): number => (v << 16) | (v << 8) | v;

function blank(width = SIZE, height = width): DecodedImage {
  const data = new Uint8Array(width * height * 4);
  const [r, g, b] = rgb(FLOOR);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = 255;
  }
  return { width, height, data };
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
  glyph: null,
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
    belts: [],
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
    expect(gradeOutlineSides([m], SHIPPED_AT_1, false).offenders).toEqual([]);
  });

  it('fails the same outline with its right side 2 px, naming the right side', () => {
    const img = blank();
    outline(img, SOLID3, { right: [FLOOR, IDLE_INK, IDLE_INK] });
    const [m] = measure(img);
    expect(coresOf(m)).toEqual({ top: 3, right: 2, bottom: 3, left: 3 });
    const g = gradeOutlineSides([m], SHIPPED_AT_1, false);
    expect(g.offenders.map((o) => o.key)).toEqual(['1:right']);
    expect(g.offenders[0]).toMatchObject({ unmeasured: false });
    expect(g.offenders[0].text).toContain('right 2');
  });

  it('finds the ink per line, so a working, faulted or backed-up machine measures the same as an idle one', () => {
    for (const state of [state_tag.IDLE, state_tag.WORKING, state_tag.FAULTED, state_tag.BACKED_UP]) {
      const ink = chassisInk(state, LOCKED_SKIN);
      const img = blank();
      outline(img, [ink, ink, ink]);
      const [m] = measure(img, facts({ nodes: [{ ...NODE, state }] }));
      expect(coresOf(m), `state ${state}`).toEqual({ top: 3, right: 3, bottom: 3, left: 3 });
      expect(gradeOutlineSides([m], SHIPPED_AT_1, false).offenders, `state ${state}`).toEqual([]);
      // The defect twin in the same colour: one side a pixel thinner fails.
      const thin = blank();
      outline(thin, [ink, ink, ink], { bottom: [FLOOR, ink, ink] });
      expect(gradeOutlineSides(measure(thin, facts({ nodes: [{ ...NODE, state }] })), SHIPPED_AT_1, false).offenders, `state ${state}`).toHaveLength(1);
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
    const atOne = gradeOutlineSides(results, AA_ON_AT_1, true);
    expect(atOne.offenders.map((o) => o.key)).toEqual(['1:top', '1:right', '1:bottom', '1:left']);
    expect(atOne.offenders.every((o) => !o.unmeasured && o.text.includes('grey fringe'))).toBe(true);
    expect(gradeOutlineSides(results, AA_ON_AT_2, true).offenders).toEqual([]);
  });

  /** One machine whose sides measured these effective widths, with no fringe. */
  function withEffective(widths: Record<SideName, number>): MachineOutline {
    const side = (effective: number) => ({ measured: true as const, core: 3, fringe: 0, effective, lines: 5, skipped: 0 });
    return { nodeId: 1, kind: 2, sides: { top: side(widths.top), right: side(widths.right), bottom: side(widths.bottom), left: side(widths.left) } };
  }

  it(`passes effective widths spread by exactly ${AA_ON_TOLERANCE} px and fails a spread of 0.26 px`, () => {
    expect(AA_ON_TOLERANCE).toBe(0.25);
    expect(gradeOutlineSides([withEffective({ top: 3, right: 3, bottom: 3, left: 3.25 })], AA_ON_AT_2, true).offenders).toEqual([]);
    const over = gradeOutlineSides([withEffective({ top: 3, right: 3, bottom: 3, left: 3.26 })], AA_ON_AT_2, true);
    expect(over.offenders.map((o) => o.key)).toEqual(['1:left']);
    expect(over.offenders[0].text).toContain('spread 0.26');
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
    const withPort: CaptureNode = { ...NODE, ports: [{ index: 0, cell_x: 2, cell_y: 1, side: 1, role: 0 }] };
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
    const g = gradeOutlineSides([m], SHIPPED_AT_1, false);
    expect(g.offenders.map((o) => [o.key, o.unmeasured])).toEqual([['1:right', true]]);
    expect(g.offenders[0].text).toMatch(/right: not measured .*a chrome panel/);
    // The clean twin: the same capture with no panel grades clean.
    expect(gradeOutlineSides(measure(img), SHIPPED_AT_1, false).offenders).toEqual([]);
  });

  it('reads an image with no outline at the expected place as not measured on every side, never as a width of 0', () => {
    const [m] = measure(blank());
    expect(Object.values(m.sides).map((s) => s.measured)).toEqual([false, false, false, false]);
    const g = gradeOutlineSides([m], SHIPPED_AT_1, false);
    expect(g.offenders).toHaveLength(4);
    expect(g.offenders.every((o) => o.unmeasured && o.text.includes('not measured'))).toBe(true);
    // An outline drawn somewhere else is no better: still nothing at the expected place.
    const moved = blank();
    outline(moved, SOLID3, {}, 5, 30);
    expect(Object.values(measure(moved)[0].sides).every((s) => !s.measured)).toBe(true);
  });

  it('grades a capture with no machine in it as an offender', () => {
    expect(gradeOutlineSides([], SHIPPED_AT_1, false).offenders).toEqual([
      { key: 'capture:no-machine', unmeasured: true, text: 'no machine was measured in this capture' },
    ]);
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
    const label: CaptureNode = { id: 9, kind: 11, state: 0, cells: [[3, 0]], ports: [], isLabel: true, glyph: null };
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

describe('tiles: each machine is graded in the first tile that holds its whole outline', () => {
  const SECOND: CaptureNode = { ...NODE, id: 2, cells: [[0, 3]] };
  const wholeImage = { width: SIZE, height: SIZE };

  it('calls an outline clear only when its band and sample margin lie on the canvas and off every panel', () => {
    expect(outlineClearOfChrome(facts(), NODE, wholeImage)).toBe(true);
    // A toolbar over the top 34 px reaches the band's outer edge at 34.5 less the 2 px margin.
    expect(outlineClearOfChrome(facts({ panels: [{ left: 0, top: 0, width: SIZE, height: 34 }] }), NODE, wholeImage)).toBe(false);
    // Its clean twin: a toolbar that stops well short of the band.
    expect(outlineClearOfChrome(facts({ panels: [{ left: 0, top: 0, width: SIZE, height: 20 }] }), NODE, wholeImage)).toBe(true);
    // Panned so the machine's right side runs past the canvas edge.
    expect(outlineClearOfChrome(facts({ camera: { x: 40, y: 0, scale: 1 } }), NODE, wholeImage)).toBe(false);
    // A canvas narrower than the image: the machine is in the image but not on the canvas.
    expect(outlineClearOfChrome(facts({ clientRect: { left: 0, top: 0, width: 90, height: SIZE } }), NODE, wholeImage)).toBe(false);
  });

  it('leaves a machine under a panel out of the tile, and keeps the clear one', () => {
    const img = blank();
    outline(img, SOLID3);
    const f = facts({ nodes: [NODE, SECOND], panels: [{ left: 0, top: 96, width: 40, height: 32 }] });
    expect(measureTile(img, f).map((m) => m.nodeId)).toEqual([1]);
  });

  it('takes each machine from the first tile that measured it and names a machine no tile held', () => {
    const img = blank();
    outline(img, SOLID3);
    const [clean] = measure(img);
    const thin = blank();
    outline(thin, SOLID3, { right: [IDLE_INK, IDLE_INK] });
    const [thinOne] = measure(thin);
    const scene = [
      { nodeId: 1, kind: 2 },
      { nodeId: 2, kind: 2 },
      { nodeId: 3, kind: 7 },
    ];
    const tiles = [
      { scene, outlines: [{ ...clean, nodeId: 1 }] },
      { scene, outlines: [{ ...thinOne, nodeId: 1 }, { ...clean, nodeId: 2 }] },
    ];
    const { outlines, neverClear } = outlinesForCell(tiles);
    // Machine 1 comes from tile 0 (clean), not tile 1 (thin); machine 2 from tile 1.
    expect(outlines.map((o) => o.nodeId)).toEqual([1, 2]);
    expect(coresOf(outlines[0]).right).toBe(3);
    expect(neverClear).toEqual([{ nodeId: 3, kind: 7 }]);
    const g = gradeOutlineSides(outlines, SHIPPED_AT_1, false, neverClear);
    expect(g.offenders.map((o) => [o.key, o.unmeasured])).toEqual([['3:never-clear', true]]);
    expect(g.offenders[0].text).toContain('machine 3 (kind 7): never clear of chrome');
    // Swapping the tile order makes the thin outline the one graded.
    const swapped = outlinesForCell([tiles[1], tiles[0]]);
    expect(coresOf(swapped.outlines[0]).right).toBe(2);
    expect(gradeOutlineSides(swapped.outlines, SHIPPED_AT_1, false, swapped.neverClear).offenders.map((o) => o.key)).toEqual(['1:right', '3:never-clear']);
  });

  it('grades a cell whose every machine was never clear as offenders, not as an empty pass', () => {
    const { outlines, neverClear } = outlinesForCell([{ scene: [{ nodeId: 4, kind: 2 }], outlines: [] }]);
    expect(outlines).toEqual([]);
    expect(gradeOutlineSides(outlines, SHIPPED_AT_1, false, neverClear).offenders.map((o) => o.text)).toEqual([
      'machine 4 (kind 2): never clear of chrome (no tile held its whole outline on the canvas)',
    ]);
  });
});

describe('outline offenders: the side that differs, keyed by machine and side', () => {
  /** One machine whose sides read these cores (null: not measured), with no fringe. */
  function withCores(nodeId: number, cores: Record<SideName, number | null>): MachineOutline {
    const side = (core: number | null) =>
      core === null ? { measured: false as const, reason: 'all 5 sample lines skipped: 5 x the line crosses a label' } : { measured: true as const, core, fringe: 0, effective: core, lines: 5, skipped: 0 };
    return { nodeId, kind: 7, sides: { top: side(cores.top), right: side(cores.right), bottom: side(cores.bottom), left: side(cores.left) } };
  }

  it('names the side that differs from the other three, not the machine', () => {
    const g = gradeOutlineSides([withCores(3, { top: 4, right: 3, bottom: 4, left: 4 })], SHIPPED_AT_1, false);
    expect(g.offenders.map((o) => o.key)).toEqual(['3:right']);
  });

  it('names the thinner pair when two sides read one width and two another', () => {
    const g = gradeOutlineSides([withCores(6, { top: 8, right: 7, bottom: 8, left: 7 })], SHIPPED_AT_1, false);
    expect(g.offenders.map((o) => o.key)).toEqual(['6:right', '6:left']);
  });

  it('keys a side that was not measured as unmeasured', () => {
    const g = gradeOutlineSides([withCores(4, { top: 3, right: null, bottom: 3, left: 3 })], SHIPPED_AT_1, false);
    expect(g.offenders).toEqual([expect.objectContaining({ key: '4:right', unmeasured: true })]);
  });
});

describe('runGradeCell', () => {
  const CELL_BOOT: CaptureCell = { dpr: 1, aa: 'shipped', zoom: 'boot' };
  const ROW: DeclaredDefect = {
    property: 'outline-sides',
    dpr: 1,
    aa: 'shipped',
    zoom: 'boot',
    fixes: 'STRK-01',
    offenders: ['3:right'],
    why: 'machine 3 right reads core 3 against 4 on its other sides',
  };
  const side = (core: number | null) =>
    core === null ? { measured: false as const, reason: 'all 5 sample lines skipped: 5 x the line crosses a label' } : { measured: true as const, core, fringe: 0, effective: core, lines: 5, skipped: 0 };
  const machine = (nodeId: number, top: number | null, right: number | null, bottom: number | null, left: number | null): MachineOutline => ({
    nodeId,
    kind: 7,
    sides: { top: side(top), right: side(right), bottom: side(bottom), left: side(left) },
  });
  const EVEN3 = machine(3, 4, 4, 4, 4);
  const THIN3 = machine(3, 4, 3, 4, 4);
  const EVEN5 = machine(5, 4, 4, 4, 4);
  const THIN5 = machine(5, 4, 4, 4, 3);

  /** A grade function over fixed outlines, the shape board-grade.capture.ts hands in. */
  const gradeOf = (outlines: MachineOutline[], neverClear: { nodeId: number; kind: number }[] = []) => (cell: CaptureCell) =>
    gradeOutlineSides(outlines, cell, false, neverClear);

  /** Run one cell and answer whether it threw (and with what) and whether the mark was reached. */
  function run(row: DeclaredDefect | undefined, grade: (cell: CaptureCell) => ReturnType<typeof gradeOutlineSides>) {
    let marked = false;
    let error: Error | null = null;
    try {
      runGradeCell(CELL_BOOT, row, grade, () => {
        marked = true;
      });
    } catch (e) {
      error = e as Error;
    }
    return { marked, error };
  }

  it('declared cell, the manifest entry is missing: throws and never reaches the expected-failure mark', () => {
    const r = run(ROW, () => {
      throw new Error('the manifest for boot dpr1-aa-shipped has no capture at zoom boot, which this cell expects');
    });
    expect(r.error?.message).toContain('has no capture at zoom boot');
    expect(r.marked).toBe(false);
  });

  it('declared cell, the declared offender reads not measured: throws and never reaches the mark', () => {
    const r = run(ROW, gradeOf([machine(3, 4, null, 4, 4), EVEN5]));
    expect(r.error?.message).toMatch(/3:right.*not measured/);
    expect(r.marked).toBe(false);
  });

  it('declared cell, a machine never clear of chrome: throws and never reaches the mark', () => {
    const r = run(ROW, gradeOf([THIN3, EVEN5], [{ nodeId: 7, kind: 2 }]));
    expect(r.error?.message).toContain('7:never-clear');
    expect(r.marked).toBe(false);
  });

  it('declared cell, the declared offender now passes and another machine fails: throws and never reaches the mark', () => {
    const r = run(ROW, gradeOf([EVEN3, THIN5]));
    expect(r.error?.message).toContain('3:right');
    expect(r.error?.message).toContain('5:left');
    expect(r.marked).toBe(false);
  });

  it('declared cell, the declared offenders plus one extra: throws and never reaches the mark', () => {
    const r = run(ROW, gradeOf([THIN3, THIN5]));
    expect(r.error?.message).toContain('5:left');
    expect(r.marked).toBe(false);
  });

  it('declared cell, exactly the declared offenders: reaches the mark, then throws the grade', () => {
    const r = run(ROW, gradeOf([THIN3, EVEN5]));
    expect(r.marked).toBe(true);
    expect(r.error?.message).toContain('machine 3 (kind 7) right');
  });

  it('declared cell, no offenders (the defect was fixed): reaches the mark and does not throw, so test.fail() reports it', () => {
    const r = run(ROW, gradeOf([EVEN3, EVEN5]));
    expect(r.marked).toBe(true);
    expect(r.error).toBeNull();
  });

  it('cell without a row, one offender: throws and never reaches the mark', () => {
    const r = run(undefined, gradeOf([THIN3, EVEN5]));
    expect(r.error?.message).toContain('machine 3 (kind 7) right');
    expect(r.marked).toBe(false);
  });

  it('cell without a row, no offenders: no throw, never reaches the mark', () => {
    const r = run(undefined, gradeOf([EVEN3, EVEN5]));
    expect(r.error).toBeNull();
    expect(r.marked).toBe(false);
  });

  it('checkDeclared lists each unmeasured offender, each declared key missing and each key not declared', () => {
    const g = gradeOutlineSides([machine(3, 4, 4, 4, 4), machine(5, 4, null, 4, 3)], CELL_BOOT, false);
    const reasons = checkDeclared(ROW, g);
    expect(reasons).toHaveLength(3);
    expect(reasons.filter((r) => r.startsWith('5:right was not measured'))).toHaveLength(1);
    expect(reasons.filter((r) => r.startsWith("5:right fails but the row doesn't declare it"))).toHaveLength(1);
    expect(reasons.some((r) => r.includes('3:right') && r.includes('declared'))).toBe(true);
    expect(checkDeclared(ROW, gradeOutlineSides([THIN3], CELL_BOOT, false))).toEqual([]);
  });
});

describe('the declared rows', () => {
  const ROW: DeclaredDefect = {
    property: 'outline-sides',
    dpr: 1,
    aa: 'shipped',
    zoom: 'boot',
    fixes: 'STRK-01',
    offenders: ['3:right'],
    why: 'machine 3 right reads core 3 against 4',
  };

  it('stops collection on a row that matches no grading cell, such as a zoom no requirement grades', () => {
    expect(() => assertDeclaredRowsMatchCells([{ ...ROW, zoom: 0.5 }])).toThrow(/matches no grading cell/);
    expect(() => assertDeclaredRowsMatchCells([{ ...ROW, dpr: 1.5 }])).toThrow(/matches no grading cell/);
    expect(() => assertDeclaredRowsMatchCells([ROW])).not.toThrow();
  });

  it('stops collection on two rows that declare one cell', () => {
    expect(() => assertDeclaredRowsMatchCells([ROW, { ...ROW, offenders: ['5:left'] }])).toThrow(/2 rows declare/);
  });

  it('holds rows the collection check accepts, each with its property\'s offender keys and tag, no repeats and numbers in its reason', () => {
    expect(() => assertDeclaredRowsMatchCells()).not.toThrow();
    expect(DECLARED_DEFECTS.length).toBeGreaterThan(0);
    for (const property of PROPERTY_IDS) {
      expect(DECLARED_DEFECTS.filter((r) => r.property === property).length, property).toBeLessThanOrEqual(gradingCells(property).length);
    }
    const keyShape: Record<PropertyId, RegExp> = {
      'outline-sides': /^\d+:(top|right|bottom|left)$/,
      'glyph-strokes': /^\d+:leg-\d+$/,
      'fault-ring': /^\d+:fault-\d+$/,
      'belt-dash': /^\d+:tile-\d+$/,
      'rail-vs-outline': /^\d+:rail$/,
      'cap-in-cell': /^\d+:collar-\d+$/,
    };
    const tagOf: Record<PropertyId, DeclaredDefect['fixes']> = {
      'outline-sides': 'STRK-01',
      'glyph-strokes': 'STRK-01',
      'fault-ring': 'STRK-02',
      'belt-dash': 'STRK-02',
      'rail-vs-outline': 'STRK-03',
      'cap-in-cell': 'STRK-03',
    };
    for (const row of DECLARED_DEFECTS) {
      expect(row.offenders.length, row.why).toBeGreaterThan(0);
      expect(new Set(row.offenders).size, row.why).toBe(row.offenders.length);
      for (const k of row.offenders) expect(k, row.why).toMatch(keyShape[row.property]);
      expect(row.offenders, row.why).not.toContain('no-subjects');
      expect(row.fixes, row.why).toBe(tagOf[row.property]);
      expect(row.why).toMatch(/\d/);
    }
  });
});

// ---------------------------------------------------------------------------
// Glyph legs, fault rings, belt dash, rail against outline and cap against cell (plan 107-07)
// ---------------------------------------------------------------------------

const GLYPH_INK = LOCKED_SKIN.palette.ramp[4];
const NUB_INK = LOCKED_SKIN.palette.ramp[3];
const TREAD_INK = LOCKED_SKIN.palette.ramp[4];
const BOOT_SHIPPED: CaptureCell = { dpr: 1, aa: 'shipped', zoom: 'boot' };
const BOOT_ON: CaptureCell = { dpr: 1, aa: 'on', zoom: 'boot' };
const AT_HALF: CaptureCell = { dpr: 1, aa: 'shipped', zoom: 0.5 };
const AT_QUARTER: CaptureCell = { dpr: 1, aa: 'shipped', zoom: 0.25 };

/** The colour `t` of the way from the floor to `ink`. */
function blend(ink: number, t: number): number {
  const [fr, fg, fb] = rgb(FLOOR);
  const [ir, ig, ib] = rgb(ink);
  const mix = (f: number, i: number) => Math.round(f + (i - f) * t);
  return (mix(fr, ir) << 16) | (mix(fg, ig) << 8) | mix(fb, ib);
}

// --- the Factory glyph -------------------------------------------------------------------------

/** A 3x3 Factory on cells (0,0) to (2,2), its glyph box the whole 96 px footprint. Scale 1.5: a 2u leg is 3 px. */
const GLYPH_SCALE = 1.5;
const GLYPH_NODE: CaptureNode = {
  id: 1,
  kind: 2,
  state: state_tag.IDLE,
  cells: [0, 1, 2].flatMap((y) => [0, 1, 2].map((x) => [x, y] as [number, number])),
  ports: [],
  isLabel: false,
  glyph: { subject: 'factory', box: { x: 0, y: 0, w: 96, h: 96, footW: 96, footH: 96 } },
};
const GLYPH_SIZE = 160;

function glyphFacts(over: Partial<CaptureFacts> = {}): CaptureFacts {
  return facts({
    backing: { width: GLYPH_SIZE, height: GLYPH_SIZE },
    client: { width: GLYPH_SIZE, height: GLYPH_SIZE },
    clientRect: { left: 0, top: 0, width: GLYPH_SIZE, height: GLYPH_SIZE },
    camera: { x: 0, y: 0, scale: GLYPH_SCALE },
    nodes: [GLYPH_NODE],
    ...over,
  });
}

/** Paint one leg `profile` across (pixel values from its low edge), as long as the segment plus the stroke. */
function paintLeg(img: DecodedImage, seg: GlyphSegment, profile: number[]): void {
  const k = GLYPH_SCALE;
  const start = Math.round(seg.at * k - profile.length / 2);
  const lo = Math.floor(Math.min(seg.from, seg.to) * k - profile.length / 2);
  const hi = Math.ceil(Math.max(seg.from, seg.to) * k + profile.length / 2) - 1;
  for (let along = lo; along <= hi; along++) {
    profile.forEach((c, i) => (seg.orient === 'V' ? paint(img, start + i, along, c) : paint(img, along, start + i, c)));
  }
}

/** The whole glyph, every leg `profile` unless `override` swaps one leg's. */
function glyph(img: DecodedImage, profile: number[], override: Record<number, number[]> = {}): void {
  for (const seg of factoryGlyph().segments) paintLeg(img, seg, override[seg.leg] ?? profile);
}

const LEG3 = [GLYPH_INK, GLYPH_INK, GLYPH_INK];

describe('glyph strokes: the Factory glyph legs', () => {
  it('reads the legs from factory.svg itself: 14 H and V segments of the two braces', () => {
    const { segments } = factoryGlyph();
    expect(segments).toHaveLength(14);
    expect(segments[0]).toMatchObject({ leg: 0, part: 'brace-left', orient: 'H', at: 26, from: 44, to: 32 });
    expect(segments[1]).toMatchObject({ leg: 1, part: 'brace-left', orient: 'V', at: 32, from: 26, to: 44 });
  });

  it('reads every leg at 3 px as a core of 3, and the grade passes', () => {
    const img = blank(GLYPH_SIZE);
    glyph(img, LEG3);
    const rows = measureGlyphStrokes(img, glyphFacts(), GLYPH_NODE);
    expect(rows).toHaveLength(14);
    for (const r of rows) expect(r.width, r.segment).toMatchObject({ measured: true, core: 3, fringe: 0 });
    expect(gradeGlyphStrokes(rows, BOOT_SHIPPED, false).offenders).toEqual([]);
  });

  it('fails one leg at 2 px beside legs at 3 px, naming the leg', () => {
    const img = blank(GLYPH_SIZE);
    glyph(img, LEG3, { 1: [GLYPH_INK, GLYPH_INK] });
    const g = gradeGlyphStrokes(measureGlyphStrokes(img, glyphFacts(), GLYPH_NODE), BOOT_SHIPPED, false);
    expect(g.offenders).toEqual([expect.objectContaining({ key: '1:leg-1', unmeasured: false })]);
  });

  it('with antialiasing on, passes equal effective widths away from the zooms people work at, and fails the fringe at boot zoom', () => {
    const img = blank(GLYPH_SIZE);
    const half = blend(GLYPH_INK, 0.5);
    glyph(img, [half, GLYPH_INK, GLYPH_INK, half]);
    const rows = measureGlyphStrokes(img, glyphFacts(), GLYPH_NODE);
    for (const r of rows) expect(r.width, r.segment).toMatchObject({ measured: true, core: 2, fringe: 2 });
    expect(gradeGlyphStrokes(rows, AA_ON_AT_2, true).offenders).toEqual([]);
    const atBoot = gradeGlyphStrokes(rows, BOOT_ON, true);
    expect(atBoot.offenders).toHaveLength(14);
    expect(atBoot.explain).toMatch(/fringe/);
  });

  it('fails effective widths spread by more than the tolerance with antialiasing on', () => {
    const img = blank(GLYPH_SIZE);
    glyph(img, LEG3, { 4: [GLYPH_INK, GLYPH_INK, blend(GLYPH_INK, 0.5)] });
    const g = gradeGlyphStrokes(measureGlyphStrokes(img, glyphFacts(), GLYPH_NODE), AA_ON_AT_2, true);
    expect(g.offenders.map((o) => o.key)).toEqual(['1:leg-4']);
  });

  it('reads a glyph under a chrome panel as not measured on every leg, and the grade lists each one', () => {
    const img = blank(GLYPH_SIZE);
    glyph(img, LEG3);
    const f = glyphFacts({ panels: [{ left: 0, top: 0, width: GLYPH_SIZE, height: GLYPH_SIZE }] });
    const rows = measureGlyphStrokes(img, f, GLYPH_NODE);
    for (const r of rows) expect(r.width.measured).toBe(false);
    const g = gradeGlyphStrokes(rows, BOOT_SHIPPED, false);
    expect(g.offenders).toHaveLength(14);
    expect(g.offenders.every((o) => o.unmeasured)).toBe(true);
  });

  it('refuses to map a glyph whose drawn footprint disagrees with the scene footprint, such as a rotated body', () => {
    const img = blank(GLYPH_SIZE);
    glyph(img, LEG3);
    const odd: CaptureNode = { ...GLYPH_NODE, glyph: { subject: 'factory', box: { x: 0, y: 0, w: 96, h: 96, footW: 96, footH: 64 } } };
    const rows = measureGlyphStrokes(img, glyphFacts({ nodes: [odd] }), odd);
    expect(rows.every((r) => !r.width.measured)).toBe(true);
  });
});

// --- the fault ring ----------------------------------------------------------------------------

/**
 * A 1x1 machine on cell (0,0) with a fault port on its south side. Camera scale 2 and a pan put the
 * nub anchor (16, 32.5) at device (64, 40): core radius 4, ring from 8.75 to 11.25 px.
 */
const RING_NODE: CaptureNode = {
  id: 4,
  kind: 7,
  state: state_tag.IDLE,
  cells: [[0, 0]],
  ports: [{ index: 2, cell_x: 0, cell_y: 0, side: 2, role: 2 }],
  isLabel: false,
  glyph: null,
};
const RING_CENTRE = { x: 64, y: 40 };

function ringFacts(over: Partial<CaptureFacts> = {}): CaptureFacts {
  return facts({ camera: { x: 32, y: -25, scale: 2 }, nodes: [RING_NODE], ...over });
}

/** Paint the fault nub: a core disc and a ring, `ringInk(angle)` choosing each ring pixel's colour (null: leave the floor). */
function ring(img: DecodedImage, opts: { holeFilled?: boolean; ringInk?: (deg: number) => number | null } = {}): void {
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const dx = x + 0.5 - RING_CENTRE.x;
      const dy = y + 0.5 - RING_CENTRE.y;
      const d = Math.hypot(dx, dy);
      // Degrees from the outward normal (south, +y), either way round.
      const deg = Math.abs((Math.atan2(dx, dy) * 180) / Math.PI);
      if (d <= 4 || (opts.holeFilled === true && d <= 11.25)) paint(img, x, y, NUB_INK);
      else if (d >= 8.75 && d <= 11.25) {
        const c = opts.ringInk ? opts.ringInk(deg) : NUB_INK;
        if (c !== null) paint(img, x, y, c);
      }
    }
  }
}

const PORT = RING_NODE.ports[0];

describe('fault ring: continuous, keeps its hole, at least one device pixel wide', () => {
  it('reads a clean ring as no gap, an open hole and a core of at least 1 on every ray, and the grade passes', () => {
    const img = blank();
    ring(img);
    const row = measureFaultRing(img, ringFacts(), RING_NODE, PORT);
    expect(row.ring).toMatchObject({ measured: true, gaps: 0, holeClosed: 0 });
    if (!row.ring.measured) throw new Error('not measured');
    expect(row.ring.rays).toBeGreaterThanOrEqual(16);
    expect(row.ring.minCore).toBeGreaterThanOrEqual(1);
    expect(gradeFaultRing([row], AT_HALF, false).offenders).toEqual([]);
  });

  it('fails a ring with a 30 degree arc missing, on its gaps', () => {
    const img = blank();
    ring(img, { ringInk: (deg) => (deg <= 15 ? null : NUB_INK) });
    const row = measureFaultRing(img, ringFacts(), RING_NODE, PORT);
    expect(row.ring).toMatchObject({ measured: true });
    if (!row.ring.measured) throw new Error('not measured');
    expect(row.ring.gaps).toBeGreaterThanOrEqual(2);
    const g = gradeFaultRing([row], AT_HALF, false);
    expect(g.offenders).toEqual([expect.objectContaining({ key: '4:fault-2', unmeasured: false })]);
    expect(g.explain).toMatch(/gap/);
  });

  it('fails a ring whose hole is filled with ink, on the hole', () => {
    const img = blank();
    ring(img, { holeFilled: true });
    const row = measureFaultRing(img, ringFacts(), RING_NODE, PORT);
    expect(row.ring).toMatchObject({ measured: true, gaps: 0 });
    if (!row.ring.measured) throw new Error('not measured');
    expect(row.ring.holeClosed).toBe(row.ring.rays);
    const g = gradeFaultRing([row], AT_HALF, false);
    expect(g.offenders.map((o) => o.key)).toEqual(['4:fault-2']);
    expect(g.explain).toMatch(/hole/);
  });

  it('fails a ring whose radial core is 0 at some angle with antialiasing as shipped, on the one-pixel floor', () => {
    const img = blank();
    ring(img, { ringInk: (deg) => (deg >= 20 && deg <= 50 ? blend(NUB_INK, 0.5) : NUB_INK) });
    const row = measureFaultRing(img, ringFacts(), RING_NODE, PORT);
    expect(row.ring).toMatchObject({ measured: true, gaps: 0, holeClosed: 0, minCore: 0 });
    const g = gradeFaultRing([row], AT_HALF, false);
    expect(g.offenders.map((o) => o.key)).toEqual(['4:fault-2']);
    expect(g.explain).toMatch(/core/);
  });

  it('reads a ring under a chrome panel as not measured, and the grade counts it as an unmeasured offender', () => {
    const img = blank();
    ring(img);
    const row = measureFaultRing(img, ringFacts({ panels: [{ left: 40, top: 20, width: 50, height: 50 }] }), RING_NODE, PORT);
    expect(row.ring.measured).toBe(false);
    expect(gradeFaultRing([row], AT_HALF, false).offenders).toEqual([expect.objectContaining({ key: '4:fault-2', unmeasured: true })]);
  });
});

// --- the belt dash, the rail and the cap -------------------------------------------------------

const straight = (cell_x: number, cell_y: number, axis = 0): CaptureBelt['tiles'][number] => ({ cell_x, cell_y, kind: { Straight: { axis } } });

/** A three-tile horizontal belt on cells (1,1) to (3,1). */
const DASH_BELT: CaptureBelt = { id: 7, tiles: [straight(1, 1), straight(2, 1), straight(3, 1)], docks: [], collars: [] };

/** At scale 1: rails on rows 38 and 57, the 2 px dash on rows 47 and 48, 10 on and 6 off from x 32. */
function dashBelt(img: DecodedImage, opts: { holeAt?: number } = {}): void {
  for (let x = 32; x < 128; x++) {
    paint(img, x, 38, TREAD_INK);
    paint(img, x, 57, TREAD_INK);
    if ((x - 32) % 16 < 10 && x !== opts.holeAt) {
      paint(img, x, 47, TREAD_INK);
      paint(img, x, 48, TREAD_INK);
    }
  }
}

/** At scale 0.5 the tile centres sit at device x 24, 40, 56 on row 24: rails on rows 19 and 28, an 8 px tick on row 24. */
function tickBelt(img: DecodedImage, opts: { missing?: number } = {}): void {
  for (let x = 16; x < 64; x++) {
    paint(img, x, 19, TREAD_INK);
    paint(img, x, 28, TREAD_INK);
  }
  [24, 40, 56].forEach((c, i) => {
    if (i !== opts.missing) for (let x = c - 4; x < c + 4; x++) paint(img, x, 24, TREAD_INK);
  });
}

const HALF_FACTS = (over: Partial<CaptureFacts> = {}) => facts({ camera: { x: 0, y: 0, scale: 0.5 }, nodes: [], belts: [DASH_BELT], ...over });

describe('belt dash: no gap in a straight tile dash or its low-zoom tick', () => {
  it('reads a run of 10-on, 6-off dashes as no gap in any tile, and the grade passes', () => {
    const img = blank();
    dashBelt(img);
    const rows = measureBeltDash(img, facts({ nodes: [], belts: [DASH_BELT] }), DASH_BELT);
    expect(rows.map((r) => r.tile)).toEqual([0, 1, 2]);
    for (const r of rows) expect(r.stroke, `tile ${r.tile}`).toMatchObject({ measured: true, gaps: 0 });
    expect(rows[0].mode).toBe('dash');
    expect(gradeBeltDash(rows, SHIPPED_AT_1, false).offenders).toEqual([]);
  });

  it('fails the same run with a one-pixel hole inside one dash, naming the tile', () => {
    const img = blank();
    dashBelt(img, { holeAt: 52 });
    const rows = measureBeltDash(img, facts({ nodes: [], belts: [DASH_BELT] }), DASH_BELT);
    expect(rows[0].stroke).toMatchObject({ measured: true, gaps: 1, longestGapPx: 1 });
    expect(gradeBeltDash(rows, SHIPPED_AT_1, false).offenders).toEqual([expect.objectContaining({ key: '7:tile-0', unmeasured: false })]);
  });

  it('below the switch zoom, passes a present 1 px tick and fails a tile whose tick is missing', () => {
    const clean = blank();
    tickBelt(clean);
    const rows = measureBeltDash(clean, HALF_FACTS(), DASH_BELT);
    expect(rows[0].mode).toBe('tick');
    for (const r of rows) expect(r.stroke, `tile ${r.tile}`).toMatchObject({ measured: true, gaps: 0, core: 1 });
    expect(gradeBeltDash(rows, AT_HALF, false).offenders).toEqual([]);

    const img = blank();
    tickBelt(img, { missing: 1 });
    const g = gradeBeltDash(measureBeltDash(img, HALF_FACTS(), DASH_BELT), AT_HALF, false);
    expect(g.offenders.map((o) => o.key)).toEqual(['7:tile-1']);
  });

  it('reads a tile fully under a cable as not measured, and the grade counts it as unmeasured', () => {
    const img = blank();
    dashBelt(img);
    const f = facts({ nodes: [], belts: [DASH_BELT], cables: [[{ x: 30, y: 48 }, { x: 130, y: 48 }]] });
    const rows = measureBeltDash(img, f, DASH_BELT);
    for (const r of rows) expect(r.stroke.measured).toBe(false);
    expect(gradeBeltDash(rows, SHIPPED_AT_1, false).offenders.every((o) => o.unmeasured)).toBe(true);
  });
});

/** NODE's 3 px outline plus a two-tile belt on cells (1,3) and (2,3): rails on rows 102 and 121. */
const RAIL_BELT: CaptureBelt = { id: 8, tiles: [straight(1, 3), straight(2, 3)], docks: [], collars: [] };

function railBelt(img: DecodedImage, width: number): void {
  for (let x = 32; x < 96; x++) {
    for (let i = 0; i < width; i++) {
      paint(img, x, 102 + i, TREAD_INK);
      paint(img, x, 121 - i, TREAD_INK);
    }
  }
}

describe('rail against outline: a belt rail no wider than a machine outline', () => {
  const railFacts = (over: Partial<CaptureFacts> = {}) => facts({ belts: [RAIL_BELT], ...over });

  it('reads a 1 px rail beside a 3 px outline, reports the ratio 1:3, and the grade passes', () => {
    const img = blank();
    outline(img, SOLID3);
    railBelt(img, 1);
    const f = railFacts();
    const row = measureRailWidth(img, f, RAIL_BELT, outlineWidthOf(measureCapture(img, f)));
    expect(row.rail).toMatchObject({ measured: true, core: 1 });
    expect(row.outline).toMatchObject({ measured: true, core: 3 });
    expect(row.ratio).toBe('1:3');
    expect(gradeRailVsOutline([row], SHIPPED_AT_1).offenders).toEqual([]);
  });

  it('fails a 4 px rail beside a 3 px outline', () => {
    const img = blank();
    outline(img, SOLID3);
    railBelt(img, 4);
    const f = railFacts();
    const row = measureRailWidth(img, f, RAIL_BELT, outlineWidthOf(measureCapture(img, f)));
    expect(row.rail).toMatchObject({ measured: true, core: 4 });
    expect(gradeRailVsOutline([row], SHIPPED_AT_1).offenders).toEqual([expect.objectContaining({ key: '8:rail', unmeasured: false })]);
  });

  it('reads a rail fully under cables as not measured, and the grade counts it as unmeasured', () => {
    const img = blank();
    outline(img, SOLID3);
    railBelt(img, 1);
    const f = railFacts({ cables: [[{ x: 30, y: 102 }, { x: 100, y: 102 }], [{ x: 30, y: 121 }, { x: 100, y: 121 }]] });
    const row = measureRailWidth(img, f, RAIL_BELT, outlineWidthOf(measureCapture(img, f)));
    expect(row.rail.measured).toBe(false);
    expect(gradeRailVsOutline([row], SHIPPED_AT_1).offenders).toEqual([expect.objectContaining({ key: '8:rail', unmeasured: true })]);
  });
});

/**
 * A 1x1 machine on cell (2,2) with an Out on its east side, and a belt whose Tail plugs into it. At
 * scale 0.25 a cell is 8 px and the cap sits at device (24, 20).
 */
const CAP_NODE: CaptureNode = {
  id: 1,
  kind: 0,
  state: state_tag.IDLE,
  cells: [[2, 2]],
  ports: [{ index: 0, cell_x: 2, cell_y: 2, side: 1, role: 1 }],
  isLabel: false,
  glyph: null,
};
const CAP_BELT: CaptureBelt = { id: 7, tiles: [straight(3, 2), straight(4, 2)], docks: [{ end: 'Tail', node: 1, port: 0 }], collars: [] };
const capFacts = (over: Partial<CaptureFacts> = {}) => facts({ camera: { x: 0, y: 0, scale: 0.25 }, nodes: [CAP_NODE], belts: [CAP_BELT], ...over });

function capDisc(img: DecodedImage, diameter: number): void {
  for (let y = 0; y < 48; y++) {
    for (let x = 0; x < 48; x++) if (Math.hypot(x + 0.5 - 24, y + 0.5 - 20) <= diameter / 2) paint(img, x, y, LOCKED_SKIN.palette.ramp[4]);
  }
}

describe('cap in cell: a belt end cap no wider than one cell', () => {
  it('passes an 8 px cap in an 8 px cell', () => {
    const img = blank();
    capDisc(img, 8);
    const rows = measureCapWidth(img, capFacts(), CAP_BELT);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ beltId: 7, n: 1, end: 'Tail', mark: 'cap', cellPx: 8 });
    expect(rows[0].cap).toMatchObject({ measured: true, widthPx: 8 });
    expect(gradeCapInCell(rows, AT_QUARTER).offenders).toEqual([]);
  });

  it('fails a 12 px cap in an 8 px cell', () => {
    const img = blank();
    capDisc(img, 12);
    const rows = measureCapWidth(img, capFacts(), CAP_BELT);
    expect(rows[0].cap).toMatchObject({ measured: true, widthPx: 12 });
    expect(gradeCapInCell(rows, AT_QUARTER).offenders).toEqual([expect.objectContaining({ key: '7:collar-1', unmeasured: false })]);
  });

  it('reads a cap under an item dot as not measured, and the grade counts it as unmeasured', () => {
    const img = blank();
    capDisc(img, 12);
    const rows = measureCapWidth(img, capFacts({ itemDots: [{ x: 96, y: 80 }] }), CAP_BELT);
    expect(rows[0].cap.measured).toBe(false);
    expect(gradeCapInCell(rows, AT_QUARTER).offenders).toEqual([expect.objectContaining({ key: '7:collar-1', unmeasured: true })]);
  });
});

// --- every grading cell fails when it finds nothing to grade -----------------------------------

describe('a cell with no subject for its property fails', () => {
  const noSubject = (property: Parameters<typeof gradeCell>[0], cell: CaptureCell, tile: TileRecord) => {
    const g = gradeCell(property, cell, [tile]);
    expect(g.offenders).toEqual([expect.objectContaining({ key: 'no-subjects', unmeasured: true })]);
  };
  const passes = (property: Parameters<typeof gradeCell>[0], cell: CaptureCell, tile: TileRecord) => {
    expect(gradeCell(property, cell, [tile]).offenders).toEqual([]);
  };

  it('no subjects, outline-sides: a cell with no machine fails, and one clean machine passes', () => {
    noSubject('outline-sides', SHIPPED_AT_1, measureTileProperties(blank(), facts({ nodes: [] })));
    const img = blank();
    outline(img, SOLID3);
    passes('outline-sides', SHIPPED_AT_1, measureTileProperties(img, facts()));
  });

  it('no subjects, glyph-strokes: a cell with no Factory glyph fails, and one clean glyph passes', () => {
    noSubject('glyph-strokes', BOOT_SHIPPED, measureTileProperties(blank(), facts()));
    const img = blank(GLYPH_SIZE);
    glyph(img, LEG3);
    passes('glyph-strokes', BOOT_SHIPPED, measureTileProperties(img, glyphFacts()));
  });

  it('no subjects, fault-ring: a cell with no fault port fails, and one clean ring passes', () => {
    noSubject('fault-ring', AT_HALF, measureTileProperties(blank(), facts()));
    const img = blank();
    ring(img);
    passes('fault-ring', AT_HALF, measureTileProperties(img, ringFacts()));
  });

  it('no subjects, belt-dash: a cell with no straight tile fails, and one clean straight tile passes', () => {
    noSubject('belt-dash', SHIPPED_AT_1, measureTileProperties(blank(), facts({ nodes: [] })));
    const one: CaptureBelt = { ...DASH_BELT, tiles: [straight(1, 1)] };
    const img = blank();
    dashBelt(img);
    passes('belt-dash', SHIPPED_AT_1, measureTileProperties(img, facts({ nodes: [], belts: [one] })));
  });

  it('no subjects, rail-vs-outline: a cell with a rail and no outline to compare it with fails, and a clean pair passes', () => {
    const rails = blank();
    railBelt(rails, 1);
    noSubject('rail-vs-outline', SHIPPED_AT_1, measureTileProperties(rails, facts({ nodes: [], belts: [RAIL_BELT] })));
    noSubject('rail-vs-outline', SHIPPED_AT_1, measureTileProperties(blank(), facts()));
    const img = blank();
    outline(img, SOLID3);
    railBelt(img, 1);
    passes('rail-vs-outline', SHIPPED_AT_1, measureTileProperties(img, facts({ belts: [RAIL_BELT] })));
  });

  it('no subjects, cap-in-cell: a cell with no belt end cap or collar fails, and one clean cap passes', () => {
    noSubject('cap-in-cell', AT_QUARTER, measureTileProperties(blank(), capFacts({ belts: [{ ...CAP_BELT, docks: [] }] })));
    const img = blank();
    capDisc(img, 8);
    passes('cap-in-cell', AT_QUARTER, measureTileProperties(img, capFacts()));
  });

  it('declared cell: no subjects, glyph-strokes: throws and never reaches the expected-failure mark', () => {
    const row: DeclaredDefect = {
      property: 'glyph-strokes',
      dpr: 1,
      aa: 'shipped',
      zoom: 'boot',
      fixes: 'STRK-01',
      offenders: ['1:leg-1'],
      why: 'machine 1 leg-1 reads core 2 against 3',
    };
    const empty = measureTileProperties(blank(), facts());
    let marked = false;
    expect(() =>
      runGradeCell(BOOT_SHIPPED, row, (cell) => gradeCell('glyph-strokes', cell, [empty]), () => {
        marked = true;
      }),
    ).toThrow(/no-subjects was not measured/);
    expect(marked).toBe(false);
  });

  it('a subject the scene holds that no tile measured is an unmeasured offender, never a pass', () => {
    const img = blank(GLYPH_SIZE);
    glyph(img, LEG3);
    const tile = measureTileProperties(img, glyphFacts({ panels: [{ left: 0, top: 0, width: 20, height: 20 }] }));
    expect(tile.subjects['glyph-strokes']).toEqual(['1']);
    expect(tile.measurements['glyph-strokes']).toEqual([]);
    expect(gradeCell('glyph-strokes', BOOT_SHIPPED, [tile]).offenders).toEqual([expect.objectContaining({ key: '1:never-clear', unmeasured: true })]);
  });
});

// --- measuring bugs the first live runs found (plan 107-07, Task 1 step 8) -----------------------

describe('measuring bugs found on the live board', () => {
  it('reads an antialiased 1.25 px ring as at least 1 px wide on every ray, diagonals included', () => {
    // Area coverage from 8x8 subsamples per pixel, the way MSAA blends a thin stroke. Scale 1:
    // core radius 2, ring 4.375 to 5.625 px, centred on device (64, 40) by a pan.
    const img = blank();
    const cx = 64;
    const cy = 40;
    for (let y = 30; y < 50; y++) {
      for (let x = 54; x < 74; x++) {
        let inside = 0;
        for (let sy = 0; sy < 8; sy++) {
          for (let sx = 0; sx < 8; sx++) {
            const d = Math.hypot(x + (sx + 0.5) / 8 - cx, y + (sy + 0.5) / 8 - cy);
            if (d <= 2 || (d >= 4.375 && d <= 5.625)) inside++;
          }
        }
        if (inside > 0) paint(img, x, y, blend(NUB_INK, inside / 64));
      }
    }
    const row = measureFaultRing(img, ringFacts({ camera: { x: 48, y: 7.5, scale: 1 } }), RING_NODE, PORT);
    expect(row.ring).toMatchObject({ measured: true, gaps: 0, holeClosed: 0 });
    if (!row.ring.measured) throw new Error('not measured');
    expect(row.ring.minEffective).toBeGreaterThanOrEqual(1);
    expect(gradeFaultRing([row], { dpr: 1, aa: 'on', zoom: 1 }, true).offenders).toEqual([]);
  });

  it('reads caps merged into one blob along a machine side as wider than the cell, not as unmeasured', () => {
    // Three 12 px Out caps one cell (8 px) apart down the east side: one light column with no floor on the scan.
    const img = blank();
    for (const cyDev of [12, 20, 28]) {
      for (let y = 0; y < 48; y++) for (let x = 0; x < 48; x++) if (Math.hypot(x + 0.5 - 24, y + 0.5 - cyDev) <= 6) paint(img, x, y, LOCKED_SKIN.palette.ramp[4]);
    }
    const rows = measureCapWidth(img, capFacts(), CAP_BELT);
    expect(rows[0].cap.measured).toBe(true);
    if (!rows[0].cap.measured) throw new Error('not measured');
    expect(rows[0].cap.widthPx).toBeGreaterThan(8);
    expect(gradeCapInCell(rows, AT_QUARTER).offenders).toEqual([expect.objectContaining({ key: '7:collar-1', unmeasured: false })]);
  });

  it('reads the rails of a two-tile belt plugged at both ends, between the plug stems', () => {
    // Belt 8 on cells (1,3) and (2,3), Tail plugged into an Out east of cell (0,3) and Head into an In west of cell (3,3).
    const img = blank();
    outline(img, SOLID3);
    railBelt(img, 1);
    const stem = LOCKED_SKIN.palette.ramp[1];
    fillRect(img, 32, 108, 95, 115, stem);
    const src: CaptureNode = { id: 2, kind: 0, state: state_tag.IDLE, cells: [[0, 3]], ports: [{ index: 0, cell_x: 0, cell_y: 3, side: 1, role: 1 }], isLabel: false, glyph: null };
    const dst: CaptureNode = { id: 3, kind: 7, state: state_tag.IDLE, cells: [[3, 3]], ports: [{ index: 0, cell_x: 3, cell_y: 3, side: 3, role: 0 }], isLabel: false, glyph: null };
    const plugged: CaptureBelt = { ...RAIL_BELT, docks: [{ end: 'Head', node: 3, port: 0 }, { end: 'Tail', node: 2, port: 0 }] };
    const f = facts({ nodes: [NODE, src, dst], belts: [plugged] });
    const row = measureRailWidth(img, f, plugged, outlineWidthOf(measureCapture(img, facts())));
    // Three lines per rail per tile, all clear of the stems that run between the rails.
    expect(row.rail).toMatchObject({ measured: true, core: 1, lines: 12, skipped: 0 });
  });
});

// --- STRK-01's fringe half in every cell, and the rule chosen by the live context (review CR-01) --

describe('the grey-fringe rule and the live antialiasing state', () => {
  /** One machine whose four sides each read this core, fringe and effective width. */
  const machineReading = (core: number, fringe: number, effective: number[]): MachineOutline => {
    const side = (e: number) => ({ measured: true as const, core, fringe, effective: e, lines: 5, skipped: 0 });
    return { nodeId: 1, kind: 2, sides: { top: side(effective[0]), right: side(effective[1]), bottom: side(effective[2]), left: side(effective[3]) } };
  };
  /** A tile record holding only that machine, as a context with this `antialias` reported it. */
  const tileOf = (m: MachineOutline, antialias: boolean | null): TileRecord => ({
    scene: [{ nodeId: m.nodeId, kind: m.kind }],
    gl: { antialias, samples: antialias === true ? 4 : 0 },
    subjects: { 'outline-sides': [String(m.nodeId)], 'glyph-strokes': [], 'fault-ring': [], 'belt-dash': [], 'rail-vs-outline': [], 'cap-in-cell': [] },
    measurements: { 'outline-sides': [m], 'glyph-strokes': [], 'fault-ring': [], 'belt-dash': [], 'rail-vs-outline': [], 'cap-in-cell': [] },
  });

  it('fails a shipped cell whose four sides read core 3 fringe 2, which the cores alone would pass', () => {
    const fringed = machineReading(3, 2, [4, 4, 4, 4]);
    const g = gradeOutlineSides([fringed], SHIPPED_AT_1, false);
    expect(g.offenders.map((o) => o.key)).toEqual(['1:top', '1:right', '1:bottom', '1:left']);
    expect(g.offenders.every((o) => !o.unmeasured && o.text.includes('grey fringe'))).toBe(true);
    // Its crisp twin passes, and away from zoom 1 and the boot zooms the fringe isn't promised.
    expect(gradeOutlineSides([machineReading(3, 0, [3, 3, 3, 3])], SHIPPED_AT_1, false).offenders).toEqual([]);
    expect(gradeOutlineSides([fringed], { dpr: 1, aa: 'shipped', zoom: 2 }, false).offenders).toEqual([]);
  });

  it('fails a fringed glyph leg in a shipped cell, and passes its crisp twin', () => {
    const leg = (name: string, fringe: number): GlyphLegRow => ({
      nodeId: 1,
      leg: name,
      segment: 'H',
      width: { measured: true as const, core: 2, fringe, effective: 2 + fringe / 2, lines: 3, skipped: 0 },
    });
    const crisp = [leg('leg-0', 0), leg('leg-1', 0)];
    const fringed = [leg('leg-0', 1), leg('leg-1', 0)];
    expect(gradeGlyphStrokes(crisp, BOOT_SHIPPED, false).offenders).toEqual([]);
    const g = gradeGlyphStrokes(fringed, BOOT_SHIPPED, false);
    expect(g.offenders.map((o) => o.key)).toEqual(['1:leg-0']);
    expect(g.offenders[0].text).toContain('grey fringe');
  });

  it('grades by the antialias the tiles measured, not by the cell label', () => {
    // Equal cores and no fringe, but effective widths 0.5 px apart: the unantialiased rule passes
    // it and the antialiased rule fails it.
    const m = machineReading(3, 0, [3, 3, 3, 2.5]);
    const shippedLabel: CaptureCell = { dpr: 1, aa: 'shipped', zoom: 2 };
    const onLabel: CaptureCell = { dpr: 1, aa: 'on', zoom: 2 };
    expect(gradeCell('outline-sides', shippedLabel, [tileOf(m, false)]).offenders).toEqual([]);
    expect(gradeCell('outline-sides', shippedLabel, [tileOf(m, true)]).offenders.map((o) => o.key)).toEqual(['1:left']);
    expect(gradeCell('outline-sides', onLabel, [tileOf(m, false)]).offenders).toEqual([]);
    expect(gradeCell('outline-sides', onLabel, [tileOf(m, true)]).offenders.map((o) => o.key)).toEqual(['1:left']);
  });

  it('grades nothing when the tiles report no antialias, or disagree', () => {
    const m = machineReading(3, 0, [3, 3, 3, 3]);
    expect(liveAntialias([tileOf(m, true), tileOf(m, true)])).toBe(true);
    expect(liveAntialias([tileOf(m, false)])).toBe(false);
    for (const tiles of [[tileOf(m, null)], [tileOf(m, false), tileOf(m, true)]]) {
      const g = gradeCell('outline-sides', SHIPPED_AT_1, tiles);
      expect(g.offenders).toEqual([expect.objectContaining({ key: 'antialias-unknown', unmeasured: true })]);
    }
  });
});

// --- each capture test's ceiling, and the ceilings against the global limit (review WR-05) -------

describe('the capture tests time limits', () => {
  it('gives every boot a ceiling, and the ceilings with the rest of the run fit the 65 min global limit', () => {
    expect(CAPTURE_GLOBAL_TIMEOUT_MS).toBe(65 * 60_000);
    expect(captureLimitProblems()).toEqual([]);
    for (const boot of CAPTURE_BOOTS) expect(captureBootCeilingMs(boot)).toBeGreaterThan(0);
  });

  it('checks the ceilings against the globalTimeout the capture config really sets', () => {
    // The config keeps its own literal, so this reads it rather than having the config import it.
    const config = readFileSync(fileURLToPath(new URL('../../playwright.capture.config.ts', import.meta.url)), 'utf8');
    const m = /^\s*globalTimeout: (\d+) \* 60_000,$/m.exec(config);
    expect(m, 'playwright.capture.config.ts sets globalTimeout as <minutes> * 60_000').not.toBeNull();
    expect(Number(m?.[1]) * 60_000).toBe(CAPTURE_GLOBAL_TIMEOUT_MS);
  });

  it('names ceilings that sum past the global limit, a boot with no ceiling and a ceiling for no boot', () => {
    const ratio2On = bootId({ dpr: 2, aa: 'on' });
    const over = captureLimitProblems({ ...CAPTURE_BOOT_CEILING_MS, [ratio2On]: CAPTURE_BOOT_CEILING_MS[ratio2On] + 3 * 60_000 });
    expect(over).toEqual([expect.stringContaining('over the 65 min globalTimeout')]);
    const missing = Object.fromEntries(Object.entries(CAPTURE_BOOT_CEILING_MS).filter(([id]) => id !== ratio2On));
    expect(captureLimitProblems(missing)).toEqual([`boot ${ratio2On} has no ceiling`]);
    expect(() => captureBootCeilingMs({ dpr: 2, aa: 'on' }, missing)).toThrow(/has no entry/);
    expect(captureLimitProblems({ ...CAPTURE_BOOT_CEILING_MS, 'dpr3-aa-on': 60_000 })).toEqual(
      expect.arrayContaining(['the ceiling for dpr3-aa-on belongs to no boot']),
    );
  });
});
