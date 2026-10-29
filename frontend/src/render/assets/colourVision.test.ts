// THE ART-03 COLOUR-VISION GATE over the SHIPPED colour set (plan 58-04).
//
// Phase 57 built the colour-vision channel transforms to judge CANDIDATES on the art
// board. This spec points the SAME transforms - greyscale plus the Machado deutan /
// protan / tritan simulations in linear light, all 27 coefficients verified verbatim
// in the Phase 57 review - at the colours that actually SHIP. No matrix is re-authored
// here and none may be: `transformRgba` is imported, and if it ever moved, this gate
// would move with it rather than quietly disagreeing with the board.
//
// THAT IMPORT IS WHY THE TRANSFORMS ARE NOT DEV TOOLING. They were written beside the
// board in `src/spike/`, and this gate - a SHIPPED gate, on the shipped palette - is a
// second consumer of them. They now live at `render/colourChannels.ts`, on the same
// side of the tree as the colours they are pointed at, and the board imports them from
// there. Its own spec, `render/colourChannels.test.ts`, still owns the transforms; this
// file owns what the shipped inks do once they go through them.
//
// WHY VITEST AND NOT PLAYWRIGHT. Phase 56 added a CI `unit` job (vitest + tsc);
// Playwright does not run there. A colour gate that only fires in a job nobody
// runs on every push is a gate that reports green by absence. `transformRgba`
// takes a flat `Uint8ClampedArray` rather than an `ImageData`, so this spec runs
// under the project default node environment with no jsdom and no canvas.
//
// TWO SUBJECTS, and they reach opposite conclusions - which is the point of
// measuring rather than asserting:
//
//   A. THE STATE INK SET (`ramp[4]`, `working`, `fault`, `build`). Reported in
//      four channels; ONE thing asserted - `fault` against `working` under deutan
//      and protan, the classic red/green confusion and the one state pair where a
//      user-visible collapse is plausible.
//
//   B. THE EIGHT LOD TINTS, under colour vision for the FIRST time. Reported in
//      four channels, and the report is DAMNING: the hues do not survive. What is
//      ASSERTED is the thing that does - `LOD_KIND_CODES`, the alpha silhouette
//      cue added in this same plan.
//
// WHAT THIS SPEC DOES NOT DO, so nobody builds it twice. The ramp-value ink
// allowlist over the eight shipped `.svg` subjects already exists as GATE 2 of
// `assets/shippedAssets.test.ts` (plan 58-02): it is what guarantees every glyph
// paints in `ramp[4]` and nothing else, which is in turn why the SHAPE gate
// (`assets/shapeDistinctness.test.ts`) and not a colour gate is what separates
// one machine from another above the LOD cut. One ink cannot be confused with
// itself; there is nothing for a CVD transform to collapse.

import { describe, expect, it } from 'vitest';
import { transformRgba, CHANNELS, type ChannelKind } from '../colourChannels.ts';
import { LOCKED_SKIN } from '../synth/skins/locked.ts';
import { LOD_KIND_CODES, LOD_TINTS, makeLodBlocks } from '../layers/lodTints.ts';
import { state_tag, type StateTag } from '../../protocol/kinds.ts';
import { CELL } from '../../../shared/geometry.ts';
import type { GenKey } from '../synth/generators.ts';

/* ------------------------------------------------------------------ *
 * Measurement helpers
 * ------------------------------------------------------------------ */

/** A 0xRRGGBB int as the one-pixel opaque RGBA buffer `transformRgba` takes. */
function pixel(rgb: number): Uint8ClampedArray {
  return new Uint8ClampedArray([(rgb >> 16) & 0xff, (rgb >> 8) & 0xff, rgb & 0xff, 255]);
}

/**
 * One colour through one channel, back as a 0xRRGGBB int.
 *
 * `colour` is not a `ChannelKind` - it is the untransformed rendering and there is
 * nothing to transform - so it short-circuits here rather than being faked with an
 * identity matrix.
 */
function through(rgb: number, channel: (typeof CHANNELS)[number]): number {
  if (channel === 'colour') return rgb;
  const out = transformRgba(pixel(rgb), channel);
  return (out[0]! << 16) | (out[1]! << 8) | out[2]!;
}

/**
 * Squared RGB distance between two 0xRRGGBB ints. Integer-only, no sqrt.
 *
 * THE SAME METRIC AND THE SAME BAR the render layer already uses. `MIN_SQ` below
 * is `layers/lodTints.test.ts`'s existing constant, not a number invented here:
 * the question this gate asks is "does the set still clear ITS OWN bar once a
 * channel is removed", which is only a meaningful question if the bar came from
 * somewhere else.
 */
function sqDist(a: number, b: number): number {
  const dr = ((a >> 16) & 0xff) - ((b >> 16) & 0xff);
  const dg = ((a >> 8) & 0xff) - ((b >> 8) & 0xff);
  const db = (a & 0xff) - (b & 0xff);
  return dr * dr + dg * dg + db * db;
}

/**
 * The minimum squared-RGB delta, transcribed from `layers/lodTints.test.ts:61`
 * where it was established and justified: "~= a euclidean gap of 50 - a
 * comfortable perceptual separation for solid blocks at 8-12px on screen".
 *
 * Kept as a literal rather than imported because a spec importing another spec's
 * private constant couples two gates that should be able to disagree; the pairing
 * is recorded here in prose so a future edit to either is visible as a divergence.
 */
const MIN_SQ = 2500;

/**
 * sRGB EOTF, byte -> linear light.
 *
 * PRESENT ONLY TO EXPRESS THE REPORT IN THE UNITS `58-UI-SPEC.md` AND THE PLAN USE
 * (relative luminance 0..1, e.g. "0.253 against 0.497" for fault against working).
 * It is NOT a re-derivation of any transform: every colour below is put through
 * `transformRgba` FIRST and this only decodes the greyscale byte that comes back.
 * The Rec.709 weighting that produces that byte lives in `colourChannels.ts` and
 * is deliberately not duplicated here.
 */
function toLinear(byte: number): number {
  const c = byte / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Relative luminance of a colour, read off `transformRgba`'s own greyscale byte. */
function relLuminance(rgb: number): number {
  return toLinear((through(rgb, 'greyscale') >> 16) & 0xff);
}

/** WCAG contrast ratio between two colours, from the luminances above. */
function contrastRatio(a: number, b: number): number {
  const la = relLuminance(a);
  const lb = relLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** `#rrggbb` for a report row. */
const hex = (rgb: number): string => `#${rgb.toString(16).padStart(6, '0')}`;

/** Collected report lines, printed ONCE at the end so the output reads as a table. */
const REPORT: string[] = [];
const report = (line: string): void => void REPORT.push(line);

/* ------------------------------------------------------------------ *
 * A. The state ink set
 * ------------------------------------------------------------------ */

const { ramp, accents } = LOCKED_SKIN.palette;

/**
 * The four inks a machine's STATE is read from on the board: the resting outline
 * plus the three state accents that ever replace or ring it.
 *
 * `item` and `electric` are deliberately absent. Neither is a machine-state ink -
 * `item` paints the dots ON belts and `electric` the wire runs - so putting them
 * in a machine-state confusion matrix would report separations nobody reads.
 */
const STATE_INKS: readonly (readonly [string, number])[] = [
  ['ramp[4]', ramp[4]!],
  ['working', accents.working],
  ['fault', accents.fault],
  ['build', accents.build],
];

describe('ART-03 channel A: the STATE ink set under four colour channels', () => {
  it('reports every pairwise separation in every channel', () => {
    report('');
    report('=== ART-03 / A. STATE INKS - pairwise separation by channel ===');
    report('    (sqDist = squared RGB delta, bar 2500;  cr = WCAG contrast ratio)');
    for (const channel of CHANNELS) {
      const cells: string[] = [];
      for (let i = 0; i < STATE_INKS.length; i++) {
        for (let j = i + 1; j < STATE_INKS.length; j++) {
          const [an, av] = STATE_INKS[i]!;
          const [bn, bv] = STATE_INKS[j]!;
          const ta = through(av, channel);
          const tb = through(bv, channel);
          cells.push(`${an}/${bn} sq=${String(sqDist(ta, tb)).padStart(6)} cr=${contrastRatio(ta, tb).toFixed(3)}`);
        }
      }
      report(`  ${channel.padEnd(10)} ${cells.join('  ')}`);
    }
    report('  luminance (relative, 0..1) per channel:');
    for (const channel of CHANNELS) {
      const cells = STATE_INKS.map(([n, v]) => `${n}=${relLuminance(through(v, channel)).toFixed(3)}`);
      report(`  ${channel.padEnd(10)} ${cells.join('  ')}`);
    }
    // The report is the deliverable of this case; the only thing asserted is that
    // it covered the whole set in every channel rather than silently skipping one.
    expect(CHANNELS).toHaveLength(5);
    expect(STATE_INKS).toHaveLength(4);
  });

  it('FAULT stays separated from WORKING under DEUTAN and PROTAN', () => {
    // THE ONE ASSERTION. Red against green is the classic dichromat confusion and
    // `fault` (a red) against `working` (an emerald) is the one state pair where a
    // real user-visible collapse is plausible. Everything else in this describe is
    // reported and not asserted, deliberately - see the next case for why.
    for (const channel of ['deutan', 'protan'] as ChannelKind[]) {
      const f = through(accents.fault, channel);
      const w = through(accents.working, channel);
      const d = sqDist(f, w);
      expect(
        d,
        `fault ${hex(accents.fault)} -> ${hex(f)} and working ${hex(accents.working)} -> ${hex(w)} ` +
          `collapse under ${channel}: sqDist ${d} < ${MIN_SQ}. A faulted machine would read as a ` +
          'working one for a viewer with this deficiency.',
      ).toBeGreaterThanOrEqual(MIN_SQ);
    }
  });

  it('does NOT assert a greyscale floor between WORKING and ramp[4] - and records why', () => {
    // THE DELIBERATE NON-ASSERTION, written as a test so the reasoning is executed
    // rather than merely commented. `working` and `ramp[4]` are within ~1.02:1 in
    // luminance. An assertion there would either fail permanently or be quietly
    // loosened until it passed, and a loosened assertion is precisely the "the gate
    // was green when it was not checking" failure `58-CONTEXT.md` names.
    //
    // THE DIVISION OF LABOUR, stated once here instead of duplicating the guard
    // (the pattern 57-07's M3 finding established): what carries the load is the
    // STRUCTURAL fact that every non-idle state has a mandatory NON-COLOUR cue, and
    // that fact is held by `layers/machineState.test.ts` (plan 58-03). This spec
    // owns the colour channel; that one owns the cue. Neither re-implements the
    // other, and this case exists so a reader who finds no greyscale assertion here
    // is sent to the file that has one rather than concluding nobody checked.
    const cr = contrastRatio(
      through(accents.working, 'greyscale'),
      through(ramp[4]!, 'greyscale'),
    );
    report('');
    report(
      `  NOT ASSERTED: working vs ramp[4] in greyscale is ${cr.toFixed(3)}:1 ` +
        `(sqDist ${sqDist(through(accents.working, 'greyscale'), through(ramp[4]!, 'greyscale'))}). ` +
        'The non-colour state cue carries this - see layers/machineState.test.ts.',
    );
    // Pinned as a MEASUREMENT, not as a bar: this asserts the figure is the small
    // one the reasoning above depends on. If a future palette edit separated them
    // properly, this reddens and the reasoning gets revisited on purpose.
    expect(cr).toBeLessThan(1.1);
  });
});

/* ------------------------------------------------------------------ *
 * B. The eight LOD tints
 * ------------------------------------------------------------------ */

/**
 * ITERATED FROM THE MODULE, NEVER FROM A HAND-WRITTEN LIST (T-58-19).
 *
 * The eighth key is `belt`, present for totality with the generator keyspace and
 * never drawn through this path. A gate written over "the seven machine tints"
 * would skip it and then report green - which is the specific shape of failure
 * this milestone keeps finding.
 */
const TINT_KEYS = Object.keys(LOD_TINTS) as GenKey[];

/** Every unordered pair of tint keys, in a fixed order. */
function tintPairs(): [GenKey, GenKey][] {
  const out: [GenKey, GenKey][] = [];
  for (let i = 0; i < TINT_KEYS.length; i++) {
    for (let j = i + 1; j < TINT_KEYS.length; j++) out.push([TINT_KEYS[i]!, TINT_KEYS[j]!]);
  }
  return out;
}

/** The worst pair in one channel, over the bare tints. */
function worstBareTint(channel: (typeof CHANNELS)[number]): { pair: string; d: number } {
  let worst = { pair: '', d: Number.POSITIVE_INFINITY };
  for (const [a, b] of tintPairs()) {
    const d = sqDist(through(LOD_TINTS[a], channel), through(LOD_TINTS[b], channel));
    if (d < worst.d) worst = { pair: `${a}/${b}`, d };
  }
  return worst;
}

describe('ART-03 channel A: the EIGHT LOD tints under four colour channels', () => {
  it('covers all EIGHT keys, iterated from LOD_TINTS itself', () => {
    expect(TINT_KEYS).toHaveLength(8);
    expect(TINT_KEYS).toContain('belt');
    expect(tintPairs()).toHaveLength(28);
  });

  it('reports the full 28-pair separation table, and the verdict is a FAILURE of hue', () => {
    report('');
    report('=== ART-03 / B. LOD TINTS - all 28 pairs, by channel (bar 2500) ===');
    for (const channel of CHANNELS) {
      const rows = tintPairs()
        .map(([a, b]) => [`${a}/${b}`, sqDist(through(LOD_TINTS[a], channel), through(LOD_TINTS[b], channel))] as const)
        .sort((x, y) => x[1] - y[1]);
      const under = rows.filter(([, d]) => d < MIN_SQ).length;
      report(`  ${channel.padEnd(10)} worst ${String(rows[0]![1]).padStart(6)} (${rows[0]![0]})   ` +
        `${under}/28 pairs UNDER the ${MIN_SQ} bar`);
      report(`             five worst: ${rows.slice(0, 5).map(([n, d]) => `${n}=${d}`).join('  ')}`);
    }
    report('  greyscale byte per tint:');
    report(
      `    ${TINT_KEYS.map((k) => `${k}=${(through(LOD_TINTS[k], 'greyscale') >> 16) & 0xff}`).join('  ')}`,
    );

    // THE MEASURED VERDICT, asserted so it is a fact of record and not a claim in a
    // summary nobody re-runs. In COLOUR the set clears its own bar (that assertion
    // lives in `layers/lodTints.test.ts` and is not duplicated here). In greyscale
    // and under deutan it does not, and not by a small margin.
    expect(worstBareTint('colour').d).toBeGreaterThanOrEqual(MIN_SQ);
    expect(worstBareTint('greyscale').d).toBeLessThan(MIN_SQ);
    expect(worstBareTint('deutan').d).toBeLessThan(MIN_SQ);
  });

  it('records that RE-SPACING the hues cannot reach the bar - the searched ceiling', () => {
    // The 2026-08-01 design call named exactly two permitted remedies - "re-space the
    // hues" or "add a non-colour cue at LOD size" - and forbade the third,
    // exempting the set. The first was tried FIRST, by an offline coordinate-descent
    // search over per-hue lightness holding the authored 45-degree hue rotation
    // (recorded in `58-04-SUMMARY.md`). The reachable ceiling on the worst pair
    // across all four channels was 2214 with blocks allowed to go to near-black, and
    // 1452 once every block is also required to stay legible against the board
    // background `ramp[0]`. Both are under the 2500 bar, so no re-authoring of these
    // eight numbers reaches it: the cue is the remaining remedy, not a preference.
    //
    // THE ARITHMETIC BEHIND THAT, in one line, because it is the durable part: in
    // greyscale the eight collapse onto a single luminance axis, and clearing 2500
    // needs ~29 grey levels between every pair. Eight tints need 203 of the 255
    // available, and every tint must ALSO stay ~29 clear of `ramp[0]` (grey 32) and
    // of the pip accents. The space does not exist.
    const bgGrey = (through(ramp[0]!, 'greyscale') >> 16) & 0xff;
    report('');
    report(`  board background ramp[0] greyscale byte = ${bgGrey}; a tint needs ~29 levels of clearance`);
    report('  re-spacing search ceiling (worst pair, all four channels): 2214 free / 1452 with background clearance');
    // Not a claim about the search - a claim about the space it searched. Eight
    // values pairwise 29 apart need 203 levels; the usable band is what is left of
    // 255 after the background and the two pip accents each claim +-29.
    const REQUIRED_GAP = 29; // sqrt(2500 / 3), rounded up: the greyscale delta that clears MIN_SQ
    expect(REQUIRED_GAP * REQUIRED_GAP * 3).toBeGreaterThanOrEqual(MIN_SQ);
    expect(REQUIRED_GAP * (TINT_KEYS.length - 1)).toBeGreaterThan(255 - 2 * REQUIRED_GAP);
  });
});

/* ------------------------------------------------------------------ *
 * C. What actually carries kind: the alpha silhouette code
 * ------------------------------------------------------------------ */

/** Every kind's LOD block, baked at ONE common footprint so size is not the cue. */
function commonBlocks(state: StateTag = state_tag.IDLE): Record<GenKey, Uint8ClampedArray> {
  const bakers = makeLodBlocks(LOCKED_SKIN, CELL);
  const out = {} as Record<GenKey, Uint8ClampedArray>;
  for (const k of TINT_KEYS) out[k] = bakers[k](state, 2, 2).data;
  return out;
}

/** Transform a whole RGBA block through one channel. */
function blockThrough(data: Uint8ClampedArray, channel: (typeof CHANNELS)[number]): Uint8ClampedArray {
  return channel === 'colour' ? data : transformRgba(data, channel);
}

/**
 * How many pixels of two same-size blocks differ in ALPHA.
 *
 * Alpha, not colour, because alpha is the channel the cue is encoded in and the
 * one no CVD transform touches. Counting colour differences instead would make
 * this metric agree with the hue table above and prove nothing new.
 */
function alphaDifferingPixels(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  let n = 0;
  for (let p = 3; p < a.length; p += 4) if (a[p] !== b[p]) n++;
  return n;
}

describe('ART-03 channel A: the LOD kind CODE is what survives the transforms', () => {
  it('transformRgba passes ALPHA through byte-for-byte, in every channel', () => {
    // The structural claim the whole cue rests on, asserted directly on a real
    // baked block rather than on a synthetic buffer: if a future channel ever
    // touched alpha, the silhouette cue would become channel-dependent and every
    // assertion below would silently weaken instead of reddening.
    const block = makeLodBlocks(LOCKED_SKIN, CELL).tee(state_tag.WORKING, 2, 2).data;
    expect(block.length).toBeGreaterThan(0);
    for (const channel of CHANNELS) {
      if (channel === 'colour') continue;
      const out = transformRgba(block, channel);
      expect(out.length, `${channel} output length`).toBe(block.length);
      for (let p = 3; p < block.length; p += 4) {
        if (out[p] !== block[p]) {
          throw new Error(`${channel} changed the alpha byte at ${p}: ${block[p]} -> ${out[p]}`);
        }
      }
    }
  });

  it('every pair of blocks stays distinguishable in EVERY channel, at every state', () => {
    // THE ASSERTION THE HUE TABLE COULD NOT CARRY. For all 28 pairs, in all five
    // channels, at all three states: the two blocks differ, and they differ by the
    // same number of pixels in every channel - because the difference is alpha and
    // alpha is channel-invariant. A collapsed code table (two kinds sharing a code)
    // drops the count to zero and reddens here.
    for (const state of [state_tag.IDLE, state_tag.WORKING, state_tag.FAULTED]) {
      const blocks = commonBlocks(state);
      for (const [a, b] of tintPairs()) {
        const baseline = alphaDifferingPixels(blocks[a], blocks[b]);
        expect(
          baseline,
          `${a} vs ${b} at ${state}: identical silhouettes, so kind rests on hue alone - ` +
            'and the hue table in this same spec says hue does not carry it',
        ).toBeGreaterThan(0);
        for (const channel of CHANNELS) {
          const d = alphaDifferingPixels(blockThrough(blocks[a], channel), blockThrough(blocks[b], channel));
          expect(d, `${a} vs ${b} under ${channel} at ${state}`).toBe(baseline);
        }
      }
    }
  });

  it('the metric is not trivially positive: a block against ITSELF scores zero', () => {
    // The discriminator. Without it the case above would pass on a broken
    // `alphaDifferingPixels` that returned a positive number for anything.
    const blocks = commonBlocks();
    for (const k of TINT_KEYS) {
      expect(alphaDifferingPixels(blocks[k], blocks[k]), `${k} against itself`).toBe(0);
      for (const channel of CHANNELS) {
        expect(alphaDifferingPixels(blockThrough(blocks[k], channel), blockThrough(blocks[k], channel))).toBe(0);
      }
    }
  });

  it('the cue does not depend on the tint: flatten every hue and it still separates', () => {
    // The strongest form of the claim. Overwrite every OPAQUE pixel of every block
    // with ONE identical colour - the worst case a colour transform could ever
    // produce, total hue collapse, beyond anything deutan or greyscale does - and
    // the eight are still pairwise distinct. This is what "non-colour cue" means
    // operationally, and it is why the shortfall in the hue table is survivable
    // rather than a shipped defect.
    const blocks = commonBlocks();
    const flat = {} as Record<GenKey, Uint8ClampedArray>;
    for (const k of TINT_KEYS) {
      const src = blocks[k];
      const out = new Uint8ClampedArray(src.length);
      for (let p = 0; p < src.length; p += 4) {
        const opaque = src[p + 3] === 255;
        out[p] = opaque ? 0x80 : 0;
        out[p + 1] = opaque ? 0x80 : 0;
        out[p + 2] = opaque ? 0x80 : 0;
        out[p + 3] = src[p + 3]!;
      }
      flat[k] = out;
    }
    for (const [a, b] of tintPairs()) {
      let differing = 0;
      for (let p = 0; p < flat[a].length; p++) if (flat[a][p] !== flat[b][p]) differing++;
      expect(
        differing,
        `${a} (code 0b${LOD_KIND_CODES[a].toString(2).padStart(3, '0')}) and ` +
          `${b} (code 0b${LOD_KIND_CODES[b].toString(2).padStart(3, '0')}) are IDENTICAL once hue is removed`,
      ).toBeGreaterThan(0);
    }
  });

  it('prints the collected report', () => {
    report('');
    report('=== ART-03 / C. VERDICT ===');
    report('  hue alone:      FAILS in greyscale and deutan (table B above), and cannot be re-spaced to pass');
    report('  alpha code:     28/28 pairs separated in all 5 channels at all 3 states (LOD_KIND_CODES)');
    report('  state inks:     fault vs working asserted under deutan and protan; the rest reported');
    // eslint-disable-next-line no-console
    console.log(REPORT.join('\n'));
    expect(REPORT.length).toBeGreaterThan(10);
  });
});
