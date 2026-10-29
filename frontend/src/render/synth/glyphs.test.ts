import { describe, expect, it } from 'vitest';
import { GLYPHS, getGlyph, stampGlyph } from './glyphs.ts';
import { makeMatrix, type PixelMatrix, type Rect } from './types.ts';
import { machine_kind, state_tag } from '../../protocol/kinds.ts';
import { makeGenerators } from './generators.ts';
import { bakeRamp } from './palette.ts';
import { LOCKED_SKIN } from './skins/locked.ts';

const INK = 0xff8800;

// The 4 confusable ROUTING kinds sharpened in this phase (READ-02).
const ROUTING_KINDS = [
  machine_kind.TEE,
  machine_kind.BALANCER,
  machine_kind.ROUTER,
  machine_kind.MERGE,
] as const;

/** The set of set-bit "col,row" coordinates for a bit matrix. */
function setBits(g: number[][]): Set<string> {
  const s = new Set<string>();
  for (let r = 0; r < g.length; r++) {
    for (let c = 0; c < g[r].length; c++) {
      if (g[r][c] === 1) s.add(`${c},${r}`);
    }
  }
  return s;
}

/** Count of cells that differ between two matrices (symmetric-difference size). */
function silhouetteDistance(a: number[][], b: number[][]): number {
  const sa = setBits(a);
  const sb = setBits(b);
  let diff = 0;
  for (const k of sa) if (!sb.has(k)) diff++;
  for (const k of sb) if (!sa.has(k)) diff++;
  return diff;
}

/** Longest contiguous run of 1s in a row. */
function longestRun(row: number[]): number {
  let best = 0;
  let cur = 0;
  for (const bit of row) {
    cur = bit === 1 ? cur + 1 : 0;
    if (cur > best) best = cur;
  }
  return best;
}

const rowSum = (row: number[]): number => row.reduce((a, b) => a + b, 0);

// Count opaque (alpha>0) pixels and collect their coordinates.
function opaquePixels(m: PixelMatrix): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  for (let y = 0; y < m.height; y++) {
    for (let x = 0; x < m.width; x++) {
      if (m.data[(y * m.width + x) * 4 + 3] > 0) out.push({ x, y });
    }
  }
  return out;
}

describe('GLYPHS table', () => {
  it('has a bit-matrix entry for every machine_kind value', () => {
    // WIRE/ENDPOINT are inert render-protocol seams (kinds.ts caught up to the Rust
    // machine_kind contract in 40-02): wires are drawn by the dedicated wires.ts
    // layer and endpoints are a host bridge, so neither carries a palette glyph.
    // getGlyph falls back safely for them (asserted in the next test).
    //
    // HANDLER (kind 10) JOINED THEM AT 72-10, and the reason is the same one, not a
    // deferral. `GLYPHS` is the PIXEL-MATRIX table the synth generators bake from; the
    // Palette and the Legend render `MachineGlyphIcon`, which resolves `SUBJECT_OF`
    // to an authored SVG and never reaches `GLYPHS` at all. A Handler draws the
    // Factory's authored asset through `SUBJECT_OF[10]`, so a kind-10 key here would
    // be a dead entry in a table nothing on that path reads. Asserted in the next
    // test, which is the RETIRED form of plan 72-05's dormancy case: see there.
    //
    // LABEL (kind 11) JOINED THEM IN PHASE 76: a label is a note, drawn by the machines
    // layer's own label branch at every zoom and shown in the palette by the chrome
    // `LabelIcon` (`label.svg`), so a bit matrix here would be a table entry nothing reads.
    const NO_MATRIX_KINDS: number[] = [
      machine_kind.WIRE,
      machine_kind.ENDPOINT,
      machine_kind.HANDLER,
      machine_kind.LABEL,
    ];
    for (const kind of Object.values(machine_kind)) {
      if (NO_MATRIX_KINDS.includes(kind)) continue;
      const g = GLYPHS[kind];
      expect(Array.isArray(g), `kind ${kind} has a matrix`).toBe(true);
      expect(g.length).toBeGreaterThan(0);
      // Every row is a same-width array of 0/1 bits.
      const w = g[0].length;
      for (const row of g) {
        expect(row.length).toBe(w);
        for (const bit of row) expect(bit === 0 || bit === 1).toBe(true);
      }
    }
  });

  it('kind 10 carries no bit matrix, and does not need one: SUBJECT_OF resolves it', () => {
    // RETIRED at 72-10, the plan named as this exception's closer, and retired to a
    // DIFFERENT answer than the one 72-05 predicted. 72-05 wrote this case as a
    // DORMANCY test - "kind 10 has no glyph YET" - on the expectation that giving the
    // Handler a palette row would give it a `GLYPHS` matrix. 72-10 gave it the palette
    // row and it needed no matrix, because that row renders `MachineGlyphIcon` and
    // that component resolves `SUBJECT_OF[10]` to the authored `factory` SVG.
    //
    // So the exception is not dated any more; it is permanent, with a stated reason,
    // and the assertion says the reason rather than the date. It still fails if
    // someone adds a kind-10 matrix, which is the property the dormancy form bought:
    // a dead entry in a table nothing on the palette path reads is exactly the kind of
    // thing that gets added once and believed forever.
    expect(
      GLYPHS[machine_kind.HANDLER],
      'a HANDLER draws the Factory asset through SUBJECT_OF[10]; a GLYPHS matrix here ' +
        'would be a dead entry in a table the palette and Legend never reach',
    ).toBeUndefined();
  });

  it('getGlyph falls back to a default dot matrix for an unknown kind (never throws)', () => {
    const g = getGlyph(9999);
    expect(Array.isArray(g)).toBe(true);
    expect(g.length).toBeGreaterThan(0);
  });
});

describe('stampGlyph - centered with 1px padding, clamped inside innerRect', () => {
  const inner: Rect = { x: 4, y: 4, w: 40, h: 40 };

  it('stamps FACTORY (a large glyph) fully inside innerRect with >=1px padding', () => {
    const m = makeMatrix(48, 48);
    stampGlyph(m, getGlyph(machine_kind.FACTORY), INK, inner);
    const px = opaquePixels(m);
    expect(px.length).toBeGreaterThan(0);
    for (const p of px) {
      expect(p.x).toBeGreaterThanOrEqual(inner.x + 1);
      expect(p.x).toBeLessThanOrEqual(inner.x + inner.w - 2);
      expect(p.y).toBeGreaterThanOrEqual(inner.y + 1);
      expect(p.y).toBeLessThanOrEqual(inner.y + inner.h - 2);
    }
  });

  it('stamps a 1x1 default glyph at the center of innerRect', () => {
    const m = makeMatrix(48, 48);
    stampGlyph(m, [[1]], INK, inner);
    const px = opaquePixels(m);
    expect(px.length).toBe(1);
    // Center of a 40-wide inner interior (with 1px pad) lands at floor((38-1)/2).
    const availW = inner.w - 2;
    const availH = inner.h - 2;
    const cx = inner.x + 1 + ((availW - 1) >> 1);
    const cy = inner.y + 1 + ((availH - 1) >> 1);
    expect(px[0]).toEqual({ x: cx, y: cy });
  });

  it('writes ink pixels at full alpha with the exact ink RGB', () => {
    const m = makeMatrix(48, 48);
    stampGlyph(m, [[1]], INK, inner);
    const p = opaquePixels(m)[0];
    const idx = (p.y * m.width + p.x) * 4;
    expect(m.data[idx]).toBe((INK >> 16) & 0xff);
    expect(m.data[idx + 1]).toBe((INK >> 8) & 0xff);
    expect(m.data[idx + 2]).toBe(INK & 0xff);
    expect(m.data[idx + 3]).toBe(255);
  });

  it('never writes a pixel outside innerRect even for an oversized glyph', () => {
    const m = makeMatrix(48, 48);
    const huge = Array.from({ length: 60 }, () => Array.from({ length: 60 }, () => 1));
    stampGlyph(m, huge, INK, inner);
    for (const p of opaquePixels(m)) {
      expect(p.x).toBeGreaterThanOrEqual(inner.x + 1);
      expect(p.x).toBeLessThanOrEqual(inner.x + inner.w - 2);
      expect(p.y).toBeGreaterThanOrEqual(inner.y + 1);
      expect(p.y).toBeLessThanOrEqual(inner.y + inner.h - 2);
    }
  });

  it('is deterministic: a repeated stamp is byte-identical', () => {
    const a = makeMatrix(48, 48);
    const b = makeMatrix(48, 48);
    stampGlyph(a, getGlyph(machine_kind.SOURCE), INK, inner);
    stampGlyph(b, getGlyph(machine_kind.SOURCE), INK, inner);
    expect(a.data).toEqual(b.data);
  });
});

// READ-04: stampGlyph gains a trailing integer `scale` param (default 1). Each
// set bit expands into a scale x scale opaque block, re-centered on the scaled
// extent, still clamped strictly inside the padded inner interior (oversized
// glyphs crop, never overflow). The default-1 path MUST be byte-identical to the
// pre-scale behaviour so the chrome MachineGlyphIcon (which never passes a scale)
// cannot shift.
describe('stampGlyph - integer scale block expansion (READ-04)', () => {
  const inner: Rect = { x: 4, y: 4, w: 40, h: 40 };

  it('default (no scale arg) is byte-identical to an explicit scale of 1', () => {
    const a = makeMatrix(48, 48);
    const b = makeMatrix(48, 48);
    const glyph = getGlyph(machine_kind.FACTORY);
    stampGlyph(a, glyph, INK, inner); // default
    stampGlyph(b, glyph, INK, inner, 1); // explicit
    expect(a.data).toEqual(b.data);
  });

  it('scale=2 expands each set bit into a 2x2 block (4x the ink pixel count)', () => {
    const one = makeMatrix(48, 48);
    const two = makeMatrix(48, 48);
    const glyph = getGlyph(machine_kind.FACTORY); // 9x9 -> 18x18 at scale 2, fits in 38x38 avail
    stampGlyph(one, glyph, INK, inner, 1);
    stampGlyph(two, glyph, INK, inner, 2);
    const n1 = opaquePixels(one).length;
    const n2 = opaquePixels(two).length;
    expect(n1).toBeGreaterThan(0);
    expect(n2).toBe(n1 * 4);
  });

  it('re-centers on the scaled extent (a single-bit glyph at scale 2 lands as a centered 2x2 block)', () => {
    const m = makeMatrix(48, 48);
    stampGlyph(m, [[1]], INK, inner, 2);
    const px = opaquePixels(m);
    expect(px.length).toBe(4);
    // startX = (inner.x+1) + ((availW - gw*scale) >> 1), gw=1, scale=2, availW=38.
    const minX = inner.x + 1;
    const minY = inner.y + 1;
    const availW = inner.w - 2;
    const availH = inner.h - 2;
    const startX = minX + ((availW - 1 * 2) >> 1);
    const startY = minY + ((availH - 1 * 2) >> 1);
    const coords = new Set(px.map((p) => `${p.x},${p.y}`));
    expect(coords).toEqual(
      new Set([
        `${startX},${startY}`,
        `${startX + 1},${startY}`,
        `${startX},${startY + 1}`,
        `${startX + 1},${startY + 1}`,
      ]),
    );
  });

  it('crops (never overflows) when the scaled glyph exceeds the padded inner rect', () => {
    const m = makeMatrix(48, 48);
    const glyph = getGlyph(machine_kind.FACTORY); // 9x9 -> 90x90 at scale 10, far bigger than 38x38
    stampGlyph(m, glyph, INK, inner, 10);
    const px = opaquePixels(m);
    for (const p of px) {
      expect(p.x).toBeGreaterThanOrEqual(inner.x + 1);
      expect(p.x).toBeLessThanOrEqual(inner.x + inner.w - 2);
      expect(p.y).toBeGreaterThanOrEqual(inner.y + 1);
      expect(p.y).toBeLessThanOrEqual(inner.y + inner.h - 2);
    }
  });

  it('every scaled ink pixel is written at full alpha with the exact ink RGB (byte-lossless)', () => {
    const m = makeMatrix(48, 48);
    stampGlyph(m, getGlyph(machine_kind.SOURCE), INK, inner, 3);
    const px = opaquePixels(m);
    expect(px.length).toBeGreaterThan(0);
    for (const p of px) {
      const idx = (p.y * m.width + p.x) * 4;
      expect(m.data[idx]).toBe((INK >> 16) & 0xff);
      expect(m.data[idx + 1]).toBe((INK >> 8) & 0xff);
      expect(m.data[idx + 2]).toBe(INK & 0xff);
      expect(m.data[idx + 3]).toBe(255);
    }
  });
});

// READ-02: the 4 routing kinds (Tee / Balancer / Router / Merge) must each read
// as a clearly DIFFERENT silhouette at on-grid size. These assertions are the
// objective gate on the hand-authored matrices - a future edit that re-confuses
// two kinds, or erases a kind's motif, fails here.
describe('routing glyphs - distinct silhouettes (READ-02)', () => {
  // Test A: pairwise distinctness. Every pair of routing glyphs differs by at
  // least this many cells (a Hamming-style silhouette distance), so no two read
  // as the same shape at 32 native px.
  const MIN_SILHOUETTE_DISTANCE = 6;

  it('every pair of routing glyphs differs by a meaningful bit count', () => {
    for (let i = 0; i < ROUTING_KINDS.length; i++) {
      for (let j = i + 1; j < ROUTING_KINDS.length; j++) {
        const ka = ROUTING_KINDS[i];
        const kb = ROUTING_KINDS[j];
        const d = silhouetteDistance(GLYPHS[ka], GLYPHS[kb]);
        expect(
          d,
          `routing kinds ${ka} vs ${kb} differ by >= ${MIN_SILHOUETTE_DISTANCE} cells`,
        ).toBeGreaterThanOrEqual(MIN_SILHOUETTE_DISTANCE);
      }
    }
  });

  it('no two routing glyphs share an identical row-signature set', () => {
    // Encode each glyph as its sorted list of row bit-strings; two distinct
    // silhouettes must not serialize to the same multiset of rows.
    const sigs = ROUTING_KINDS.map((k) =>
      GLYPHS[k].map((row) => row.join('')).join('|'),
    );
    const unique = new Set(sigs);
    expect(unique.size).toBe(ROUTING_KINDS.length);
  });

  // Test B: grid discipline. Odd width (single-pixel spine centers), equal-length
  // rows, strictly 0/1 values.
  it('each routing matrix keeps an odd width, equal rows, and 0/1 values', () => {
    for (const k of ROUTING_KINDS) {
      const g = GLYPHS[k];
      expect(g.length).toBeGreaterThan(0);
      const w = g[0].length;
      expect(w % 2, `kind ${k} width ${w} is odd`).toBe(1);
      for (const row of g) {
        expect(row.length, `kind ${k} rows equal-length`).toBe(w);
        for (const bit of row) expect(bit === 0 || bit === 1).toBe(true);
      }
    }
  });

  // Test C: motif landmarks. Each kind carries a concrete signature so a future
  // edit that erases the motif fails here (33-UI-SPEC READ-02 intent).
  it('TEE carries a one-in / two-out fork (left spine forking to two right tips)', () => {
    const g = GLYPHS[machine_kind.TEE];
    // A single horizontal input spine row entering from the left edge.
    const spineRow = g.find((row) => row[0] === 1 && longestRun(row) >= 5);
    expect(spineRow, 'TEE has a left-anchored horizontal spine (run >= 5)').toBeDefined();
    // Two divergent output tips on the far side (top-right + bottom-right).
    const w = g[0].length;
    expect(g[0][w - 1], 'TEE upper output tip').toBe(1);
    expect(g[g.length - 1][w - 1], 'TEE lower output tip').toBe(1);
  });

  it('BALANCER carries two parallel horizontal bars (even split)', () => {
    const g = GLYPHS[machine_kind.BALANCER];
    const w = g[0].length;
    const fullRows = g.filter((row) => rowSum(row) === w);
    expect(fullRows.length, 'BALANCER has two full-width parallel bars').toBe(2);
  });

  it('ROUTER carries a decision diamond (single-cell top + bottom apex, widest middle)', () => {
    const g = GLYPHS[machine_kind.ROUTER];
    const w = g[0].length;
    const mid = w >> 1;
    // Top and bottom apexes are single centered cells.
    expect(rowSum(g[0]), 'ROUTER top apex is a single cell').toBe(1);
    expect(g[0][mid], 'ROUTER top apex is centered').toBe(1);
    expect(rowSum(g[g.length - 1]), 'ROUTER bottom apex is a single cell').toBe(1);
    expect(g[g.length - 1][mid], 'ROUTER bottom apex is centered').toBe(1);
    // The widest band spans to both outer columns (the diamond's equator).
    const equator = g.find((row) => row[0] === 1 && row[w - 1] === 1);
    expect(equator, 'ROUTER equator touches both outer columns').toBeDefined();
    // A central inner switch cell on that equator.
    expect(equator![mid], 'ROUTER carries a central switch cell').toBe(1);
  });

  it('MERGE narrows top-to-bottom to a 1-wide neck (many-to-one funnel)', () => {
    const g = GLYPHS[machine_kind.MERGE];
    const w = g[0].length;
    const mid = w >> 1;
    // Wide mouth at the top (the "many").
    expect(rowSum(g[0]), 'MERGE has a wide top mouth').toBeGreaterThanOrEqual(w - 2);
    // A 1-wide centered neck at the bottom (the "one").
    expect(rowSum(g[g.length - 1]), 'MERGE bottom neck is 1-wide').toBe(1);
    expect(g[g.length - 1][mid], 'MERGE neck is centered').toBe(1);
  });

  it('SOURCE and SINK stay distinct from each other and from the routing kinds', () => {
    const source = GLYPHS[machine_kind.SOURCE];
    const sink = GLYPHS[machine_kind.SINK];
    expect(silhouetteDistance(source, sink)).toBeGreaterThanOrEqual(MIN_SILHOUETTE_DISTANCE);
    for (const k of ROUTING_KINDS) {
      expect(silhouetteDistance(source, GLYPHS[k])).toBeGreaterThanOrEqual(
        MIN_SILHOUETTE_DISTANCE,
      );
      expect(silhouetteDistance(sink, GLYPHS[k])).toBeGreaterThanOrEqual(
        MIN_SILHOUETTE_DISTANCE,
      );
    }
  });
});

// READ-06: on an IDLE machine the glyph ink is the SHELL-01 raised token
// (ramp index 4 = #b0bacb on the locked skin), never a hardcoded hex, so the
// glyph inherits the Phase-32 raised contrast rather than re-deriving it.
describe('idle glyph legibility - raised ink token (READ-06)', () => {
  it('baked ramp ink is ramp[4] (#b0bacb) - the SHELL-01 raised contrast, not a hex literal', () => {
    const ramp = bakeRamp(LOCKED_SKIN);
    const last = LOCKED_SKIN.palette.ramp.length - 1;
    expect(ramp.ink).toBe(LOCKED_SKIN.palette.ramp[last]);
    expect(ramp.ink).toBe(0xb0bacb);
  });

  it('an IDLE machine stamps its glyph interior in the raised ink token', () => {
    const gens = makeGenerators(LOCKED_SKIN); // 32 native px per cell
    const ramp = bakeRamp(LOCKED_SKIN);
    const inkR = (ramp.ink >> 16) & 0xff;
    const inkG = (ramp.ink >> 8) & 0xff;
    const inkB = ramp.ink & 0xff;
    const m = gens.tee(state_tag.IDLE, 0); // a 1x1 routing kind, 32x32

    // Glyph ink lives in the interior; the bevel light edge also uses ramp[last],
    // so isolate interior pixels (>= 3px from any border) to read the glyph alone.
    const MARGIN = 3;
    let interiorInk = 0;
    for (let y = MARGIN; y < m.height - MARGIN; y++) {
      for (let x = MARGIN; x < m.width - MARGIN; x++) {
        const idx = (y * m.width + x) * 4;
        if (
          m.data[idx] === inkR &&
          m.data[idx + 1] === inkG &&
          m.data[idx + 2] === inkB &&
          m.data[idx + 3] === 255
        ) {
          interiorInk++;
        }
      }
    }
    // The IDLE glyph is present and rendered in the raised ink token.
    expect(interiorInk).toBeGreaterThan(0);
  });
});
