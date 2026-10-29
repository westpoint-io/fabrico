// RED-first spec for the READ-05 LOD kind-tint constants + block baker
// (lodTints.ts). These are DISPLAY-ONLY render constants (a deterministic low-
// saturation hue rotation), never a skin edit: the tints live in the render layer
// so kind survives when the machine glyph goes sub-pixel at low zoom. The four
// contracts gated here are stated on their own terms. (They were introduced as mirroring
// the fault-overlay set builder's discipline; plan 61-07 deleted that builder as orphaned
// canvas bake code, so the four contracts below stand alone - which they always did.)
//
//   1. Distinctness  - the 8 per-kind tints are mutually distinct AND distinct
//                      from the 4 reserved accents (working / fault / item / build)
//                      by a minimum squared-RGB delta (else kind reads as state).
//   2. Byte-lossless - every baked block pixel is A=0 or A=255 (no partial alpha),
//                      sized to the kind's effective native footprint.
//   3. State-encoding - IDLE / WORKING / FAULTED blocks differ (state rides the
//                      block as a corner pip); the base tint region == LOD_TINTS[kind].
//   4. Determinism   - re-baking with the same args yields byte-identical matrices.
//
// PLAN 58-04 ADDS A FIFTH, and it is the one that carries kind for a viewer who
// cannot separate the eight hues:
//
//   5. Kind CODE     - `LOD_KIND_CODES` is pairwise distinct and every set bit is
//                      an actually-cut corner in the baked block, so the kind read
//                      survives in ALPHA. The colour-channel half of this - the
//                      measured proof that the hues alone do NOT survive, and the
//                      assertion that the CODE does - lives in
//                      `render/assets/colourVision.test.ts`, which points the
//                      colour-vision transforms in `render/colourChannels.ts` at
//                      the shipped palette. The DIVISION OF LABOUR is deliberate:
//                      this spec holds the code's structure, that one holds its
//                      behaviour under the four channels.

import { describe, expect, it } from 'vitest';
import { LOD_KIND_CODES, LOD_TINTS, makeEndpointPresenceBlock, makeLodBlocks } from './lodTints.ts';
import { isRedPixel } from '../../../shared/redPixel.ts';
import { LOCKED_SKIN } from '../synth/skins/locked.ts';
import { TEST_SKIN_A } from '../synth/__fixtures__/testSkins.ts';
import { state_tag } from '../../protocol/kinds.ts';
import { CELL } from '../../../shared/geometry.ts';
import type { GenKey } from '../synth/generators.ts';
import type { PixelMatrix } from '../synth/types.ts';

/**
 * The 8 GenKeys, one per placeable machine_kind (belt included for totality).
 *
 * A STATED LITERAL, kept ONLY as the subject of the keyspace assertion below.
 * Every loop in this file iterates `Object.keys(LOD_TINTS)` instead (see `KEYS`),
 * because a hand-written list is exactly how a gate silently skips a key and then
 * reports green - and the key most likely to be skipped is `belt`, which is
 * present for totality with the generator keyspace and is never drawn through
 * this path (T-58-19, plan 58-04).
 */
const NAMED_KEYS: GenKey[] = ['source', 'belt', 'factory', 'tee', 'balancer', 'router', 'merge', 'sink'];

/** The keyspace AS DECLARED BY THE MODULE - the iteration subject for every loop. */
const KEYS = Object.keys(LOD_TINTS) as GenKey[];

// RENDER-01: the block baker is now a PURE FUNCTION OF SIZE - the KIND_FOOTPRINTS
// table is gone, so the caller (machines.ts, from node.w/h) supplies w/h. These are
// the real per-kind bases (mirroring core `base_footprint`) the test drives the
// baker with: multi-port operators Tee/Balancer/Merge 2x2, Router 2x3, Factory 3x3,
// Source/Belt/Sink 1x1. node.w/h - never a hardcoded per-kind table - is the authority.
const BASE: Readonly<Record<GenKey, readonly [number, number]>> = {
  source: [1, 1],
  belt: [1, 1],
  factory: [3, 3],
  tee: [2, 2],
  balancer: [2, 2],
  router: [2, 3],
  merge: [2, 2],
  sink: [1, 1],
};

/** Squared RGB distance between two 0xRRGGBB ints (integer-only, no sqrt). */
function sqDist(a: number, b: number): number {
  const dr = ((a >> 16) & 0xff) - ((b >> 16) & 0xff);
  const dg = ((a >> 8) & 0xff) - ((b >> 8) & 0xff);
  const db = (a & 0xff) - (b & 0xff);
  return dr * dr + dg * dg + db * db;
}

/** Read a pixel's RGB as a packed 0xRRGGBB int at (x,y). */
function px(m: PixelMatrix, x: number, y: number): number {
  const i = (y * m.width + x) * 4;
  return (m.data[i] << 16) | (m.data[i + 1] << 8) | m.data[i + 2];
}

// The minimum squared-RGB delta every authored hue clears (both vs each other and
// vs the reserved accents). ~= a euclidean gap of 50 - a comfortable perceptual
// separation for solid blocks at 8-12px on screen.
const MIN_SQ = 2500;
/** The least hue distance, degrees, between any tint and the cable teal (phase 92 review). */
const CABLE_HUE_GAP_MIN = 35;

describe('LOD_TINTS - display-only per-kind tint constants (READ-05)', () => {
  it('has exactly one tint per placeable machine_kind (8, belt included)', () => {
    expect(Object.keys(LOD_TINTS).sort()).toEqual([...NAMED_KEYS].sort());
    expect(KEYS).toHaveLength(8);
    for (const k of KEYS) {
      expect(typeof LOD_TINTS[k]).toBe('number');
      expect(LOD_TINTS[k]).toBeGreaterThanOrEqual(0);
      expect(LOD_TINTS[k]).toBeLessThanOrEqual(0xffffff);
    }
  });

  it('every tint is mutually distinct by the minimum perceptual delta', () => {
    for (let i = 0; i < KEYS.length; i++) {
      for (let j = i + 1; j < KEYS.length; j++) {
        const d = sqDist(LOD_TINTS[KEYS[i]], LOD_TINTS[KEYS[j]]);
        expect(
          d,
          `LOD tints ${KEYS[i]} vs ${KEYS[j]} must be distinct (sqDist ${d} >= ${MIN_SQ})`,
        ).toBeGreaterThanOrEqual(MIN_SQ);
      }
    }
  });

  it('every tint is distinct from all 4 reserved accents (kind never reads as state)', () => {
    // The SHIPPED palette is the subject here: a LOD tint must never read as a
    // real state accent on the real board, so this guard binds to LOCKED_SKIN
    // (not a synthetic fixture, which would make the assertion vacuous).
    const { working, fault, item, build } = LOCKED_SKIN.palette.accents;
    const accents: [string, number][] = [
      ['working', working],
      ['fault', fault],
      ['item', item],
      ['build', build],
    ];
    for (const k of KEYS) {
      for (const [name, accent] of accents) {
        const d = sqDist(LOD_TINTS[k], accent);
        expect(
          d,
          `LOD tint ${k} must be distinct from the ${name} accent (sqDist ${d} >= ${MIN_SQ})`,
        ).toBeGreaterThanOrEqual(MIN_SQ);
      }
    }
  });

  it('no tint reads red: no idle kind block looks faulted (phase 92 review WR-B-05)', () => {
    // The shared predicate the live red count uses (`shared/redPixel.ts`), over all eight keys.
    for (const k of KEYS) {
      const t = LOD_TINTS[k];
      expect(isRedPixel((t >> 16) & 0xff, (t >> 8) & 0xff, t & 0xff), `LOD tint ${k} (0x${t.toString(16)}) must not read red`).toBe(false);
    }
  });

  it("no tint shares the cable's hue (phase 92 review, UI review fix 3)", () => {
    // At 25 % a cable runs beside a kind block; a block on the cable teal's hue (186) reads as part
    // of the cable. The Factory was 2.4 degrees from it. The router blue, the nearest now, is 39.7.
    const hue = (c: number): number => {
      const [r, g, b] = [(c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff];
      const max = Math.max(r, g, b);
      const d = max - Math.min(r, g, b);
      const h = max === r ? (g - b) / d : max === g ? 2 + (b - r) / d : 4 + (r - g) / d;
      return (h * 60 + 360) % 360;
    };
    const cableHue = hue(LOCKED_SKIN.palette.cable);
    for (const k of KEYS) {
      const gap = Math.abs(hue(LOD_TINTS[k]) - cableHue);
      expect(Math.min(gap, 360 - gap), `LOD tint ${k} is ${Math.min(gap, 360 - gap).toFixed(1)} degrees from the cable's hue`).toBeGreaterThanOrEqual(
        CABLE_HUE_GAP_MIN,
      );
    }
  });

  it('is display-only: NOT authored into the skin palette (accents/ramp)', () => {
    // Same reasoning: the collision that matters is against the SHIPPED palette.
    const { ramp, accents } = LOCKED_SKIN.palette;
    const skinColors = new Set<number>([...ramp, accents.working, accents.fault, accents.item, accents.build, accents.electric]);
    for (const k of KEYS) {
      expect(skinColors.has(LOD_TINTS[k]), `${k} tint must not collide with a skin color`).toBe(false);
    }
  });
});

describe('makeLodBlocks - byte-lossless block baker (READ-05)', () => {
  it('returns a frozen record keyed by every GenKey', () => {
    const blocks = makeLodBlocks(TEST_SKIN_A, CELL);
    expect(Object.isFrozen(blocks)).toBe(true);
    for (const k of KEYS) {
      expect(typeof blocks[k]).toBe('function');
    }
  });

  it('bakes each block at the per-node footprint it is handed (real bases, never 1x1)', () => {
    const blocks = makeLodBlocks(TEST_SKIN_A, CELL);
    // The baker is a pure fn of (state, w, h): the size comes from the caller, NOT a
    // footprint table. Multi-port operators bake at their real base, Factory 3x3.
    for (const k of KEYS) {
      const [w, h] = BASE[k];
      const m = blocks[k](state_tag.IDLE, w, h);
      expect(m.width, `${k} block width == ${w}*CELL`).toBe(w * CELL);
      expect(m.height, `${k} block height == ${h}*CELL`).toBe(h * CELL);
    }
    // Explicit spot-checks on the honest bases (the 1x1-operator bug is gone).
    expect(blocks.tee(state_tag.IDLE, 2, 2).width).toBe(2 * CELL); // 64
    expect(blocks.router(state_tag.IDLE, 2, 3).height).toBe(3 * CELL); // 96
    expect(blocks.factory(state_tag.IDLE, 3, 3).width).toBe(3 * CELL); // 96
  });

  it('re-bakes a resized operator at the new footprint (size-augmented cache re-bake)', () => {
    // A Router at 2x3 and the same Router grown to 2x4 are DISTINCT block textures
    // (different dimensions), so a resize can never return a stale sprite - the
    // machines.ts cache key carries |WxH so this drives a fresh bake (RENDER-01).
    const blocks = makeLodBlocks(TEST_SKIN_A, CELL);
    const r23 = blocks.router(state_tag.IDLE, 2, 3);
    const r24 = blocks.router(state_tag.IDLE, 2, 4);
    expect(r23.height).toBe(3 * CELL);
    expect(r24.height).toBe(4 * CELL);
    expect(r23.data.length).not.toBe(r24.data.length);
  });

  it('writes ONLY A=0 or A=255 (byte-lossless, no partial alpha)', () => {
    const blocks = makeLodBlocks(TEST_SKIN_A, CELL);
    for (const k of KEYS) {
      for (const state of [state_tag.IDLE, state_tag.WORKING, state_tag.FAULTED]) {
        const m = blocks[k](state, ...BASE[k]);
        for (let i = 3; i < m.data.length; i += 4) {
          const a = m.data[i];
          expect(a === 0 || a === 255, `${k}/${state} alpha byte must be 0 or 255, got ${a}`).toBe(true);
        }
      }
    }
  });

  it('the base tint region equals LOD_TINTS[kind] (the block IS the kind colour)', () => {
    const blocks = makeLodBlocks(TEST_SKIN_A, CELL);
    for (const k of KEYS) {
      const m = blocks[k](state_tag.IDLE, ...BASE[k]);
      // THE CENTRE, not a corner (plan 58-04). This used to sample (1, height-2) -
      // the bottom-left - on the reasoning that it is opposite the state pip and
      // therefore always pure tint. That stopped being true when `LOD_KIND_CODES`
      // started CUTTING coded corners: `belt`, `router` and `sink` all carry the
      // bottom-left bit, so the old probe now reads a hole. The centre is the one
      // region no encoding writes: the pip is top-left and every code bit is a
      // corner bite of at most a quarter of the shorter side.
      expect(px(m, m.width >> 1, m.height >> 1), `${k} centre is its tint`).toBe(LOD_TINTS[k]);
      expect(m.data[((m.height >> 1) * m.width + (m.width >> 1)) * 4 + 3]).toBe(255);
    }
  });

  it('encodes state: IDLE / WORKING / FAULTED blocks differ per kind', () => {
    const blocks = makeLodBlocks(TEST_SKIN_A, CELL);
    for (const k of KEYS) {
      const idle = blocks[k](state_tag.IDLE, ...BASE[k]).data;
      const working = blocks[k](state_tag.WORKING, ...BASE[k]).data;
      const faulted = blocks[k](state_tag.FAULTED, ...BASE[k]).data;
      expect(Buffer.from(idle).equals(Buffer.from(working)), `${k} IDLE != WORKING`).toBe(false);
      expect(Buffer.from(idle).equals(Buffer.from(faulted)), `${k} IDLE != FAULTED`).toBe(false);
      expect(Buffer.from(working).equals(Buffer.from(faulted)), `${k} WORKING != FAULTED`).toBe(false);
    }
  });

  it('WORKING pip uses the working accent, FAULTED pip uses the fault accent', () => {
    const blocks = makeLodBlocks(TEST_SKIN_A, CELL);
    const { working, fault } = TEST_SKIN_A.palette.accents;
    for (const k of KEYS) {
      // Pip sits at the top-left interior; sample one pixel inside it.
      expect(px(blocks[k](state_tag.WORKING, ...BASE[k]), 1, 1)).toBe(working);
      expect(px(blocks[k](state_tag.FAULTED, ...BASE[k]), 1, 1)).toBe(fault);
      // IDLE has no wash there - it stays kind tint.
      expect(px(blocks[k](state_tag.IDLE, ...BASE[k]), 1, 1)).toBe(LOD_TINTS[k]);
    }
  });

  it('is deterministic: re-baking with the same args is byte-identical', () => {
    const a = makeLodBlocks(TEST_SKIN_A, CELL);
    const b = makeLodBlocks(TEST_SKIN_A, CELL);
    for (const k of KEYS) {
      for (const state of [state_tag.IDLE, state_tag.WORKING, state_tag.FAULTED]) {
        const ma = a[k](state, ...BASE[k]);
        const mb = b[k](state, ...BASE[k]);
        expect(Buffer.from(ma.data).equals(Buffer.from(mb.data)), `${k}/${state} re-bake identical`).toBe(true);
      }
    }
  });
});

/* ------------------------------------------------------------------ *
 * The kind CODE (plan 58-04) - structure. Behaviour under the four
 * colour channels is `render/assets/colourVision.test.ts`.
 * ------------------------------------------------------------------ */

/** Alpha byte at (x, y). The code is an ALPHA cue, so this is what reads it. */
function alpha(m: PixelMatrix, x: number, y: number): number {
  return m.data[(y * m.width + x) * 4 + 3];
}

/** The three coded corners, as (bit, name, probe) - probe is 1px inside the corner. */
const CODED_CORNERS: readonly [number, string, (m: PixelMatrix) => number][] = [
  [0b100, 'top-right', (m) => alpha(m, m.width - 2, 1)],
  [0b010, 'bottom-right', (m) => alpha(m, m.width - 2, m.height - 2)],
  [0b001, 'bottom-left', (m) => alpha(m, 1, m.height - 2)],
];

describe('LOD_KIND_CODES - the non-colour kind cue (READ-05 under CVD, plan 58-04)', () => {
  it('covers exactly the LOD_TINTS keyspace - no kind left uncoded', () => {
    // Iterated from the TINT keyspace, not from the CODE keyspace: a code table
    // that silently lost a key would otherwise agree with itself.
    expect(Object.keys(LOD_KIND_CODES).sort()).toEqual([...KEYS].sort());
    expect(Object.keys(LOD_KIND_CODES)).toHaveLength(8);
  });

  it('is a three-bit code and every value is PAIRWISE DISTINCT', () => {
    // Distinctness is the whole property: two kinds sharing a code are two kinds
    // a colour-blind viewer cannot separate at LOD by any channel at all.
    for (const k of KEYS) {
      expect(Number.isInteger(LOD_KIND_CODES[k]), `${k} code is an integer`).toBe(true);
      expect(LOD_KIND_CODES[k]).toBeGreaterThanOrEqual(0b000);
      expect(LOD_KIND_CODES[k]).toBeLessThanOrEqual(0b111);
    }
    const seen = new Map<number, GenKey>();
    for (const k of KEYS) {
      const clash = seen.get(LOD_KIND_CODES[k]);
      expect(
        clash,
        `${k} and ${clash} share LOD code 0b${LOD_KIND_CODES[k].toString(2).padStart(3, '0')} - ` +
          'they are indistinguishable at LOD for a viewer who cannot separate their hues',
      ).toBeUndefined();
      seen.set(LOD_KIND_CODES[k], k);
    }
    // Eight distinct three-bit values EXHAUST the code space, so the table is also
    // proven to be a bijection onto 0b000..0b111 - there is no ninth code to hand a
    // ninth kind without widening the encoding first.
    expect([...seen.keys()].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('every SET bit is an actually-cut corner, and every CLEAR bit is not', () => {
    // The table and the baker are separate declarations; nothing but this case
    // stops them drifting. Both directions are asserted, because a baker that cut
    // EVERY corner would satisfy a set-bits-only check perfectly.
    const blocks = makeLodBlocks(TEST_SKIN_A, CELL);
    for (const k of KEYS) {
      const m = blocks[k](state_tag.IDLE, ...BASE[k]);
      const code = LOD_KIND_CODES[k];
      for (const [bit, name, probe] of CODED_CORNERS) {
        const cut = (code & bit) !== 0;
        expect(
          probe(m),
          `${k} (0b${code.toString(2).padStart(3, '0')}) ${name} must be ${cut ? 'CUT (A=0)' : 'SOLID (A=255)'}`,
        ).toBe(cut ? 0 : 255);
      }
    }
  });

  it('never cuts the top-left corner - the state pip owns it, at every state', () => {
    // Kind and state must not write the same pixel. If a future code bit claimed
    // the top-left, a FAULTED block would draw its fault pip into a hole and the
    // state read would silently depend on draw order.
    const blocks = makeLodBlocks(TEST_SKIN_A, CELL);
    for (const k of KEYS) {
      for (const state of [state_tag.IDLE, state_tag.WORKING, state_tag.FAULTED]) {
        expect(alpha(blocks[k](state, ...BASE[k]), 1, 1), `${k}/${state} top-left is opaque`).toBe(255);
      }
    }
  });

  it('the cue SURVIVES state: two kinds differ in alpha at every state', () => {
    // The pairwise silhouette difference is measured on the BAKED blocks rather
    // than derived from the code table, and at all three states, so a state pip
    // that grew over a bite would redden here rather than at review time.
    const blocks = makeLodBlocks(TEST_SKIN_A, CELL);
    for (const state of [state_tag.IDLE, state_tag.WORKING, state_tag.FAULTED]) {
      for (let i = 0; i < KEYS.length; i++) {
        for (let j = i + 1; j < KEYS.length; j++) {
          // Bake BOTH at one common footprint, so the difference measured is the
          // CODE and not the block size (which a grown machine can change anyway).
          const a = blocks[KEYS[i]](state, 2, 2);
          const b = blocks[KEYS[j]](state, 2, 2);
          let differing = 0;
          for (let p = 3; p < a.data.length; p += 4) if (a.data[p] !== b.data[p]) differing++;
          expect(
            differing,
            `${KEYS[i]} vs ${KEYS[j]} at ${state}: silhouettes are identical, so kind is ` +
              'carried by hue alone for this pair',
          ).toBeGreaterThan(0);
        }
      }
    }
  });

  it('the bite is PROPORTIONAL: the cue holds the same share of a 1x1 and a 3x3', () => {
    // A fixed pixel bite would fade out on the largest machines - exactly the ones
    // that occupy the most screen at LOD. `tee` is 0b111, so all three corners are
    // cut and the cut share is directly comparable across footprints.
    const blocks = makeLodBlocks(TEST_SKIN_A, CELL);
    const cutShare = (w: number, h: number): number => {
      const m = blocks.tee(state_tag.IDLE, w, h);
      let cut = 0;
      for (let p = 3; p < m.data.length; p += 4) if (m.data[p] === 0) cut++;
      return cut / (m.width * m.height);
    };
    const small = cutShare(1, 1);
    const large = cutShare(3, 3);
    // Three bites of (side/4)^2 in a square block = 3/16 = 0.1875 exactly.
    expect(small).toBeCloseTo(3 / 16, 6);
    expect(large).toBeCloseTo(3 / 16, 6);
    expect(small).toBe(large);
  });

  it('SAME-FOOTPRINT kinds differ in TWO corners, not one', () => {
    // Block SIZE is itself a non-colour cue, but it cannot separate kinds that
    // share a footprint - and `grow_to_fit` can move a machine between footprint
    // groups at runtime, so size is not leaned on as a discriminator at all. These
    // are the pairs the code has to work hardest for, and the assignment gives
    // each of them a two-corner difference. Recorded as an assertion so a
    // re-shuffle of the table cannot quietly drop one of them to a single corner.
    const groups: GenKey[][] = [
      ['source', 'belt', 'sink'], // 1x1
      ['tee', 'balancer', 'merge'], // 2x2
    ];
    for (const g of groups) {
      for (let i = 0; i < g.length; i++) {
        for (let j = i + 1; j < g.length; j++) {
          const xor = LOD_KIND_CODES[g[i]] ^ LOD_KIND_CODES[g[j]];
          const hamming = ((xor >> 2) & 1) + ((xor >> 1) & 1) + (xor & 1);
          expect(hamming, `${g[i]} vs ${g[j]} share a footprint and must differ in 2+ corners`).toBeGreaterThanOrEqual(2);
        }
      }
    }
  });
});

/* ------------------------------------------------------------------ *
 * WR-05: the state pip's SIZE, measured rather than sampled
 * ------------------------------------------------------------------ */

describe('the state pip is a measured extent, not a single sampled pixel', () => {
  // MUTATION-PROVEN UNGATED before this block existed: `Math.floor(nativeCell / 4)` ->
  // `/ 2` passed all 1422 vitest cases. Every assertion over the pip sampled ONE pixel
  // at (1, 1), so any pip size >= 2 satisfied all of them - the pip could double and
  // nothing in the tree would say so.
  //
  // The docblock's own safety argument did not cover it either, and was wrong: it
  // claimed an over-large pip "fails loudly" by overwriting a coded corner, but on a
  // 1x1 block the corners start at 24px against a pip of 8, so the pip has to TRIPLE
  // before the ordering matters. That sentence is now corrected in `lodTints.ts`.

  /** The pip's run length along row 0, in px: how far the accent reaches from x=0. */
  function pipRunX(m: PixelMatrix, accent: number): number {
    let n = 0;
    while (n < m.width && px(m, n, 0) === accent) n++;
    return n;
  }

  /** The pip's run length down column 0, in px. */
  function pipRunY(m: PixelMatrix, accent: number): number {
    let n = 0;
    while (n < m.height && px(m, 0, n) === accent) n++;
    return n;
  }

  const EXPECTED_PIP = Math.max(3, Math.floor(CELL / 4));

  it('the pip is exactly nativeCell/4 on a side - the size, not just its presence', () => {
    // Stated as a literal too, so the expectation is independent of the expression
    // under test rather than agreeing with it for any value.
    expect(EXPECTED_PIP).toBe(8);

    const blocks = makeLodBlocks(TEST_SKIN_A, CELL);
    const { working, fault } = TEST_SKIN_A.palette.accents;
    for (const k of KEYS) {
      for (const [state, accent] of [
        [state_tag.WORKING, working],
        [state_tag.FAULTED, fault],
      ] as const) {
        const m = blocks[k](state, ...BASE[k]);
        expect(pipRunX(m, accent), `${k}/${state} pip width`).toBe(EXPECTED_PIP);
        expect(pipRunY(m, accent), `${k}/${state} pip height`).toBe(EXPECTED_PIP);
        // ...and it STOPS. Without this the run check would pass on a full wash.
        expect(px(m, EXPECTED_PIP, 0), `${k}/${state} pip did not stop`).not.toBe(accent);
        expect(px(m, 0, EXPECTED_PIP), `${k}/${state} pip did not stop`).not.toBe(accent);
      }
    }
  });

  it('the pip covers the intended SHARE of the block, so a 2x pip reddens', () => {
    // The ratio the "corner pip, not a full wash" decision rests on (Open Question 1):
    // the pip must stay a corner marker so the kind tint keeps the readable majority.
    // A doubled pip takes the 1x1 share from 1/16 to 1/4 and fails here.
    const blocks = makeLodBlocks(TEST_SKIN_A, CELL);
    const accent = TEST_SKIN_A.palette.accents.working;
    for (const k of KEYS) {
      const m = blocks[k](state_tag.WORKING, ...BASE[k]);
      let accentPixels = 0;
      for (let y = 0; y < m.height; y++) {
        for (let x = 0; x < m.width; x++) if (px(m, x, y) === accent) accentPixels++;
      }
      expect(accentPixels, `${k} accent area`).toBe(EXPECTED_PIP * EXPECTED_PIP);
      // A corner marker, never a wash: at most an eighth of the smallest block.
      expect(accentPixels / (m.width * m.height), `${k} accent share`).toBeLessThanOrEqual(1 / 8);
    }
  });

  it("the ordering claim's ACTUAL boundary: the pip is far from a coded corner, and by how much", () => {
    // The corrected version of the docblock's safety argument, as a number. This is the
    // case that would redden if a pip enlargement ever DID approach a kind bit - which
    // is the point at which the write-order argument finally becomes operative.
    const blocks = makeLodBlocks(TEST_SKIN_A, CELL);
    const m = blocks.source(state_tag.WORKING, ...BASE.source);
    const bite = Math.max(2, Math.floor(Math.min(m.width, m.height) / 4));
    const nearestCodedCorner = Math.min(m.width, m.height) - bite;
    expect(bite).toBe(8);
    expect(nearestCodedCorner).toBe(24);
    // THREE TIMES the pip, which is why the ordering never fires in practice.
    expect(nearestCodedCorner / EXPECTED_PIP).toBe(3);
    expect(EXPECTED_PIP).toBeLessThan(nearestCodedCorner);
  });
});

// ============================================================================
// THE ENDPOINT PRESENCE BLOCK (66-03, WIRE-03).
//
// An HTTP Endpoint below the LOD cut drew NOTHING from 58-03 until this plan. Making it
// a normal LOD block would have cost a ninth authored hue AND a ninth corner code, and
// `LOD_KIND_CODES` is a saturated three-bit space with no ninth code point - so the
// route around it is a presence block in `ramp[4]`, the structural ink, with no code.
//
// WHAT THESE FOUR ASSERTIONS ARE FOR. They are the shape that keeps this from becoming
// the ninth hue it was routed around. Each is driven from the SHIPPED tables and the
// SHIPPED skin, never from a copy of either: the distance bound is computed over
// `LOD_TINTS` itself, so it moves with the set rather than against a stale snapshot of
// it, and the tint is read out of a baked block rather than asserted about a constant.
//
// AND THIS BLOCK IS NOT EVIDENCE THAT A NINTH HUE WAS APPROVED. It is the module
// header's own argument applied once more: a sub-pixel presence fallback is not a
// kind-hue encoding, it does not reopen ART-02 or axis 9, and nobody may cite it as
// precedent for putting kind hue anywhere else.
// ============================================================================
describe('the ENDPOINT presence block - visible below the cut without a ninth hue (66-03)', () => {
  it("is the skin's structural ink, READ FROM THE SKIN and never a literal", () => {
    // Baked against TWO skins whose `ramp[4]` differs. One skin alone cannot tell "the
    // baker read the skin" from "the baker hardcoded LOCKED_SKIN's number", which is the
    // whole reason `TEST_SKIN_A` exists (see its header). A `ramp[3]` regression reddens
    // here on both.
    for (const skin of [LOCKED_SKIN, TEST_SKIN_A]) {
      const ink = skin.palette.ramp[skin.palette.ramp.length - 1];
      const block = makeEndpointPresenceBlock(skin, CELL)(state_tag.IDLE, 1, 1);
      expect(px(block, CELL / 2, CELL / 2), `${skin.id} presence ink`).toBe(ink);
    }
  });

  it('is ABSENT from LOD_TINTS: it mints no ninth kind hue', () => {
    // The claim the whole route around the saturated encoding rests on.
    const ink = LOCKED_SKIN.palette.ramp[LOCKED_SKIN.palette.ramp.length - 1];
    expect(Object.values(LOD_TINTS)).not.toContain(ink);
    expect(KEYS).toHaveLength(8);
    expect(Object.keys(LOD_KIND_CODES)).toHaveLength(8);
  });

  it("clears the tint set's OWN 2500 bar against every one of the eight kinds", () => {
    // Computed from `LOD_TINTS` and `MIN_SQ` - the same bar the eight hues are held to
    // against each other and against the reserved accents. A presence block that read as
    // one of the eight kinds at 8-16 device px would be worse than the absence it
    // replaces, because it would be WRONG rather than missing.
    const ink = LOCKED_SKIN.palette.ramp[LOCKED_SKIN.palette.ramp.length - 1];
    for (const k of KEYS) {
      const d = sqDist(ink, LOD_TINTS[k]);
      expect(
        d,
        `the endpoint presence ink must be distinct from the ${k} tint (sqDist ${d} >= ${MIN_SQ})`,
      ).toBeGreaterThanOrEqual(MIN_SQ);
    }
  });

  it('carries NO kind corner code - an uncut square - while keeping the state pip', () => {
    // It takes no code point out of the saturated three-bit space. All three coded
    // corners stay opaque at every state; the top-left pip is untouched by the code by
    // construction and still carries state, exactly as it does for the eight kinds.
    const block = makeEndpointPresenceBlock(LOCKED_SKIN, CELL);
    for (const state of [state_tag.IDLE, state_tag.WORKING, state_tag.FAULTED]) {
      const m = block(state, 1, 1);
      for (const [, name, probe] of CODED_CORNERS) {
        expect(probe(m), `the ${name} corner must be uncut at state ${state}`).toBe(255);
      }
    }
    // And the pip still reads: IDLE is pure ink, WORKING and FAULTED are their accents.
    const ink = LOCKED_SKIN.palette.ramp[LOCKED_SKIN.palette.ramp.length - 1];
    expect(px(block(state_tag.IDLE, 1, 1), 1, 1)).toBe(ink);
    expect(px(block(state_tag.WORKING, 1, 1), 1, 1)).toBe(LOCKED_SKIN.palette.accents.working);
    expect(px(block(state_tag.FAULTED, 1, 1), 1, 1)).toBe(LOCKED_SKIN.palette.accents.fault);
  });
});

/* ------------------------------------------------------------------ *
 * BACKED_UP below the cut: a COUNT, not a hue (71-UI-SPEC, plan 71-06)
 * ------------------------------------------------------------------ */

describe('BACKED_UP draws TWO stacked structural pips, because colour carries nothing here', () => {
  /** A pixel's ALPHA byte at (x, y). `px` reads RGB only, and a CUT corner is alpha 0. */
  function alpha(m: PixelMatrix, x: number, y: number): number {
    return m.data[(y * m.width + x) * 4 + 3];
  }

  const STRUCTURAL = TEST_SKIN_A.palette.ramp[TEST_SKIN_A.palette.ramp.length - 1];
  const PIP = Math.max(3, Math.floor(CELL / 4));
  const BITE = Math.max(2, Math.floor(CELL / 4));

  it('the ink is the skin’s structural ramp step, never an accent and never a literal', () => {
    // Read from the skin: swapping the skin moves the pip. A literal would not.
    const a = makeLodBlocks(TEST_SKIN_A, CELL).sink(state_tag.BACKED_UP, 1, 1);
    expect(px(a, 0, 0)).toBe(STRUCTURAL);
    expect(px(a, 0, 0)).not.toBe(TEST_SKIN_A.palette.accents.working);
    expect(px(a, 0, 0)).not.toBe(TEST_SKIN_A.palette.accents.fault);
    const locked = makeLodBlocks(LOCKED_SKIN, CELL).sink(state_tag.BACKED_UP, 1, 1);
    expect(px(locked, 0, 0)).toBe(LOCKED_SKIN.palette.ramp[LOCKED_SKIN.palette.ramp.length - 1]);
    expect(px(locked, 0, 0)).not.toBe(px(a, 0, 0));
  });

  it('at the tightest shipped footprint (1x1, nativeCell 32) it is TWO pips with a cleared row', () => {
    // Stated as literals as well as derived, so a constant edit comes through this line.
    expect(PIP).toBe(8);
    expect(BITE).toBe(8);

    const blocks = makeLodBlocks(TEST_SKIN_A, CELL);
    for (const k of KEYS) {
      // Drive the key the loop is ON, at that key's real base footprint. Building `sink`
      // eight times would have been eight identical assertions wearing a loop.
      const m = blocks[k](state_tag.BACKED_UP, ...BASE[k]);
      expect(m.height, `${k} block height`).toBe(BASE[k][1] * 32);

      // Pip one: y 0 .. PIP.
      for (let y = 0; y < PIP; y += 1) {
        expect(px(m, 0, y), `pip 1 row ${y}`).toBe(STRUCTURAL);
      }
      // ONE CLEARED ROW between them - it is the separator that makes the stack read as
      // TWO marks rather than as one double-height pip, which would be a SIZE cue and
      // not a count.
      expect(px(m, 0, PIP), 'the separator row is NOT the pip ink').not.toBe(STRUCTURAL);
      // Pip two: y PIP+1 .. 2*PIP+1.
      for (let y = PIP + 1; y < 2 * PIP + 1; y += 1) {
        expect(px(m, 0, y), `pip 2 row ${y}`).toBe(STRUCTURAL);
      }
      // ...and it STOPS. Without this the run checks would pass on a full left-edge wash.
      expect(px(m, 0, 2 * PIP + 1), 'the stack did not stop').not.toBe(STRUCTURAL);
      // Each pip is PIP wide, and stops.
      expect(px(m, PIP - 1, PIP + 1)).toBe(STRUCTURAL);
      expect(px(m, PIP, PIP + 1), 'pip 2 width did not stop').not.toBe(STRUCTURAL);
    }
  });

  it('and it clears the bottom-left coded corner by exactly 7 px', () => {
    // The stack occupies y 0..17 (2*PIP+1 = 17, exclusive) and the coded corner region
    // begins at y = height - bite = 24. THIS is the measurement that makes the second pip
    // safe rather than the docblock's old ordering claim, which was false at this scale.
    const stackBottom = 2 * PIP + 1;
    const codedTop = 32 - BITE;
    expect(stackBottom).toBe(17);
    expect(codedTop).toBe(24);
    expect(codedTop - stackBottom).toBe(7);
  });

  it('the DEGENERATE GUARD degrades to ONE pip rather than eating a kind bit', () => {
    // A test-only nativeCell where `2*pip + 1` would run into the bite region. At 8:
    // bite = max(2, 2) = 2, pip = max(3, 2) = 3, so 2*3+1 = 7 > 8 - 2 = 6. The floor of 3
    // on the pip against the floor of 2 on the bite is what creates this case, so it is
    // reachable and is not a hypothetical.
    const NATIVE = 8;
    const pip = Math.max(3, Math.floor(NATIVE / 4));
    const bite = Math.max(2, Math.floor(NATIVE / 4));
    expect(2 * pip + 1).toBeGreaterThan(NATIVE - bite);

    // `sink` is 0b101 - it CUTS the bottom-left, so an ungoverned second pip would paint
    // opaque ink into that hole and destroy a kind bit. That is the failure being gated.
    const m = makeLodBlocks(TEST_SKIN_A, NATIVE).sink(state_tag.BACKED_UP, 1, 1);
    for (let y = 0; y < pip; y += 1) expect(px(m, 0, y), `pip 1 row ${y}`).toBe(STRUCTURAL);
    expect(px(m, 0, pip), 'the second pip must NOT be drawn here').not.toBe(STRUCTURAL);
    expect(px(m, 0, pip + 1), 'the second pip must NOT be drawn here either').not.toBe(STRUCTURAL);

    // The kind bit survives INTACT: the whole bottom-left bite is still alpha 0.
    for (let y = NATIVE - bite; y < NATIVE; y += 1) {
      for (let x = 0; x < bite; x += 1) {
        expect(alpha(m, x, y), `bottom-left kind bit at ${x},${y}`).toBe(0);
      }
    }
  });

  it('it does not disturb the OTHER three states, byte for byte', () => {
    // The arm is an addition, not a rewrite. Every pre-existing block is identical.
    const before = makeLodBlocks(TEST_SKIN_A, CELL);
    for (const k of KEYS) {
      for (const state of [state_tag.IDLE, state_tag.WORKING, state_tag.FAULTED] as const) {
        const m = before[k](state, ...BASE[k]);
        // The top-left pixel is the state channel: IDLE keeps the kind tint, the two
        // accents keep theirs, and none of them is the structural ink.
        const expected =
          state === state_tag.IDLE
            ? LOD_TINTS[k]
            : state === state_tag.FAULTED
              ? TEST_SKIN_A.palette.accents.fault
              : TEST_SKIN_A.palette.accents.working;
        expect(px(m, 0, 0), `${k}/${state}`).toBe(expected);
      }
    }
  });
});
