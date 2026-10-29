// The READ-05 LOD kind-tint constants + the solid-block baker (display-only).
//
// At low zoom the body-scaled machine glyphs go sub-pixel and every machine reads
// as an identical grey dot. Below the `machines.ts` LOD cutoff each machine sprite
// is swapped for a SOLID BLOCK baked here, whose base colour encodes KIND (a per-
// kind tint), whose CORNER CODE also encodes kind (`LOD_KIND_CODES`, added in plan
// 58-04 and the thing that actually carries kind under colour-vision deficiency),
// and whose top-left pip encodes STATE (IDLE = no pip / WORKING = emerald pip /
// FAULTED = red pip). So kind and state both survive when the glyph cannot.
//
// ============================================================================
// WHAT THESE TINTS ARE, AND - MORE IMPORTANTLY - WHAT THEY ARE NOT.
// (Plan 58-04. Read this before citing `LOD_TINTS` in any argument about colour.)
// ============================================================================
//
// SCOPE: these 8 hues are a DISPLAY-ONLY FALLBACK that exists ONLY BELOW the
// glyph-legibility cut (`machines.ts` `LOD_MIN_MACHINE_PX`). Above that cut every
// machine draws as its authored vector glyph in ONE ink (`ramp[4]`) and these
// constants are not on screen at all. Kind-by-colour exists here for exactly one
// reason: at 8-16 device px per cell, kind-by-SHAPE is physically unavailable,
// because the shape that would carry it is smaller than a pixel.
//
// THESE ARE NOT THE ART-02 KIND ENCODING. ART-02 asked for kind to be encoded by
// CHASSIS-FILL HUE IN FAMILIES across the whole board at every zoom. It is
// formally SUPERSEDED (`58-CONTEXT.md`, the maintainer's call 2026-08-01) by
// `57-ART-LOCK.md` AXIS 9: "no family encoding drawn, one ink (`ramp[4]`) for
// every kind", on an open chassis with no fill (axis 3) for the hue to live on.
// No kind-hue encoding ships on the board. A future reader must not be able to
// cite this constant as evidence that one was re-approved: a sub-pixel fallback
// for a size at which no other channel exists is not the same decision, does not
// reopen axis 9, and is not a precedent for putting kind hue anywhere else.
//
// AND THE HUES DO NOT CARRY KIND ON THEIR OWN. Measured in plan 58-04 through the
// colour-vision transforms in `render/colourChannels.ts` (see
// `render/assets/colourVision.test.ts` for the full four-channel table, which is the
// gate that recomputes them): under DEUTAN the worst pair (`tee`/`router`) separates
// by a squared-RGB distance of 5 against this set's own 2500 bar, and in pure
// GREYSCALE the worst pair (`tee`/`router`, tied with `balancer`/`sink`) separates by 48 (it was
// `factory`/`balancer` at 12 before the phase 92 review re-hued the source and the factory). A re-spacing
// search over the eight hues (holding the rotation, requiring every block to stay
// legible against the board background `ramp[0]`) tops out at 1452 - still under
// the bar - so no re-authoring of these eight numbers can reach it. That measured
// fact is why `LOD_KIND_CODES` exists, and why the tints are gated as a REPORTED
// figure while the CODE is gated as an ASSERTION.
// ============================================================================
//
// ============================================================================
// THIS MODULE IS EXEMPT FROM VEC-01, AND THE EXEMPTION IS A DECISION.
// (the maintainer's ruling, 2026-08-10, `61-CONTEXT.md` H5. Plan 61-05 writes it here.)
// ============================================================================
//
// VEC-01 says no baked pixel matrix remains on the canvas render path. Phase 61
// converted the belt tread, the corner elbow and the item dot to resolution-
// independent vector geometry. **THE BLOCKS BELOW STAY BAKED, DELIBERATELY.**
//
// THE REASON, WHICH IS THE WHOLE OF THE EXEMPTION: these are SOLID BLOCKS displayed
// ONLY BELOW the machine detail cut (`machines.ts` `LOD_MIN_MACHINE_PX`), where by
// construction there is NO DETAIL TO LOSE TO RESAMPLING. A flat rectangle with three
// square corner bites and one square pip has no curve, no hairline and no glyph; at
// 8-16 device px per cell it is a handful of pixels of one colour. Converting it to
// vector would make nothing crisper, which is the only thing VEC-01 is for. The
// requirement's PURPOSE is satisfied here by the geometry being flat, not by the
// representation being vector.
//
// WHAT A LATER READER WOULD OTHERWISE MISTAKE THIS FOR: an oversight in the phase that
// removed the last baked matrices from the canvas. It is not one. It was found (by the
// Phase 61 pattern mapper, alongside `layers/items.ts`), raised, and ruled on - the maintainer
// converted `items.ts` and EXEMPTED this module in the same call, and required the
// exemption to be written in the code rather than only in a planning document. That is
// the same discipline this file already applies to its own eight hues not being the
// ART-02 encoding (see the block above): a decision that reads as an omission when it
// is not written down will be "fixed" by somebody later.
//
// **THE CONSEQUENCE, STATED RATHER THAN LEFT TO BE INFERRED: VEC-01 IS TICKED ON A
// STATED, NARROWER READING THAN ITS LITERAL TEXT.** The machine-checked exemption list
// lives in `render/vectorOnly.test.ts`, which fails on any NEW baked-matrix consumer on
// this path, so the narrowing is bounded rather than open-ended. Do not report VEC-01
// as unqualified anywhere.
//
// IF THESE BLOCKS EVER GAIN DETAIL - a glyph, an outline, a curve, anything with an
// edge that resampling can soften - the reason above stops holding and this exemption
// must be revisited rather than inherited.
// ============================================================================
//
// These 8 tints are DISPLAY-ONLY RENDER CONSTANTS: a deterministic low-saturation
// hue rotation authored as fixed hex, living in this render-layer module and never
// written into `locked.ts` / `palette.ts` (they are not a skin property - a reskin
// must NOT change them, and the sim never sees them). Each is authored distinct
// from the four RESERVED accents (working emerald / fault red / item amber / build
// blue) and from every other tint by a minimum perceptual delta, gated by
// lodTints.test.ts - otherwise a kind block would read as a STATE cue at low zoom.
//
// The block baker is a frozen record of per-kind thunks, integer-only, byte-lossless
// (only A=0 / A=255 ever written), so
// the downstream nearest-neighbour texture is a clean cache variant (T-33-BAKE) and
// never a live `sprite.alpha` / `sprite.tint` mutation (MOTION-05). It is pure -
// no Date.now / Math.random / float into a pixel byte - so a re-bake is byte-stable.

import { state_tag, type StateTag } from '../../protocol/kinds.ts';
import { effectiveBox } from '../../protocol/footprint.ts';
import { DEFAULT_NATIVE_CELL, type GenKey } from '../synth/generators.ts';
import { makeMatrix, type PixelMatrix } from '../synth/types.ts';
import type { Skin } from '../synth/skin.ts';

/**
 * The 8 per-kind LOD block tints (READ-05), one per `GenKey`. Authored as a low-
 * saturation hue rotation (S~0.45, L~0.52, hue stepped ~45deg) so the set is evenly
 * spread and legible as SOLID blocks, then hand-verified distinct from each other
 * and from the four reserved accents (see lodTints.test.ts). These are render
 * constants ONLY - never a skin/palette entry (a reskin must not move them).
 *
 * Hue map (authored, discretion per CONTEXT): source=periwinkle, balancer=gold,
 * belt=brown, sink=green, factory=lime, router=blue, tee=violet, merge=magenta. `belt` is
 * present for totality with the generator keyspace; belts are never drawn here.
 *
 * RE-HUED BY THE PHASE 92 REVIEW (WR-B-05, UI review fixes 2 and 3), a review
 * decision: no kind block may read red on an unfaulted board, judged by the eye and by the
 * shared red predicate (`shared/redPixel.ts`), and no kind block may share the cable's hue.
 * The Source was brick red (0xbc4e4e), so at every zoom below 0.5 an idle Source looked like a
 * fault and a faulted Source's red pip almost vanished on it (1.40 : 1); the Factory was cyan
 * (0x46afbe, hue 188) on the cable teal's hue (186), so at 25 % the cables round a Handler read as
 * part of its block. The Factory takes the lime the never-drawn belt held (hue 90), the Source a
 * new periwinkle (0x8c87e1, hue 243: 58 degrees from the cable, light enough to clear the router
 * blue and the tee violet by 6113 and 4667), and the belt, never drawn, a dark brown (0x6f4d2a, hue
 * 30) so that no value in the set is red or cable-hued at all. The other five are unchanged.
 * `lodTints.test.ts` holds every tint to the 2500 bar against the others and the four accents, to
 * the red predicate, and to 35 degrees of hue from the cable (the router blue, unchanged, is the
 * nearest at 39.7).
 */
export const LOD_TINTS: Readonly<Record<GenKey, number>> = Object.freeze({
  source: 0x8c87e1, // periwinkle (was red, phase 92 review)
  belt: 0x6f4d2a, // brown, never drawn (was lime)
  factory: 0x85bc4e, // lime (was cyan, the cable's hue, phase 92 review)
  tee: 0x854ebc, // violet
  balancer: 0xbca04e, // gold
  router: 0x4e69bc, // blue
  merge: 0xbc4ea0, // magenta
  sink: 0x4ebc69, // green
});

/**
 * The per-kind LOD CORNER CODE (plan 58-04): three bits, one per non-pip corner.
 *
 * WHY THIS EXISTS. `LOD_TINTS` cannot carry kind for a colour-vision-deficient
 * viewer, and that is a MEASURED fact rather than a caution - the module header
 * records the figures and `render/assets/colourVision.test.ts` recomputes them
 * every run. The maintainer's 2026-08-01 call on this set named exactly two permitted
 * remedies, "re-space the hues" or "add a non-colour cue at LOD size", and
 * forbade the third (exempting the set). Re-spacing was tried FIRST, by search,
 * and measured insufficient: the reachable ceiling holding the hue rotation is
 * 1452 unconstrained-by-hue-identity and 2214 if blocks are allowed to go black,
 * against a bar of 2500. So the cue is not a preference, it is the remaining
 * remedy.
 *
 * WHY ALPHA AND NOT A SECOND COLOUR. Each set bit CUTS ITS CORNER OUT of the
 * block - the pixels become A=0 and the board shows through. Alpha is the one
 * channel `render/colourChannels.ts`'s `transformRgba` passes through UNTOUCHED
 * (`out[p + 3] = src[p + 3]`), so a silhouette cue is colour-transform-proof BY
 * CONSTRUCTION rather than by measurement: there is no greyscale, deutan, protan
 * or tritan rendering of a hole. A cue drawn in a dark ink would merely be a
 * luminance cue whose survival had to be re-measured on every palette edit.
 *
 * WHY CORNERS. At the LOD cut a machine is 8-16 device px across. A corner bite
 * changes the SILHOUETTE, which is the most resolvable feature at that size, and
 * the bite is sized as a FRACTION of the block (see `bakeLodBlock`) so a 1x1
 * source and a 3x3 factory present the same relative cue on screen. The top-left
 * corner is reserved for the STATE pip and is therefore not part of the code -
 * which is also what keeps kind and state from ever writing the same pixel.
 *
 * THE BITS: `0b100` = top-right, `0b010` = bottom-right, `0b001` = bottom-left.
 *
 * THE ASSIGNMENT IS NOT ARBITRARY. Machines that SHARE A FOOTPRINT are the ones a
 * viewer cannot separate by block size, so those are the pairs the code has to
 * work hardest for. Every same-footprint pair here differs in TWO of the three
 * corners:
 *
 *   1x1  source 000 / belt 011 / sink 101     - pairwise Hamming 2, 2, 2
 *   2x2  tee 111 / balancer 010 / merge 100   - pairwise Hamming 2, 2, 2
 *   2x3  router 001, 3x3 factory 110          - unique footprints, Hamming 3
 *
 * All eight codes are distinct, which is what `lodTints.test.ts` asserts; the
 * footprint grouping above is the reason for the particular assignment and is
 * NOT leaned on as a discriminator, because `grow_to_fit` can move a machine
 * between footprint groups at runtime (`58-CONTEXT.md`).
 *
 * `source` is `0b000` - the uncut square. Absence is a legal code point in a
 * three-bit space and it is still pairwise distinct from all seven others; it is
 * recorded here so nobody reads the uncut block as an unencoded one.
 */
export const LOD_KIND_CODES: Readonly<Record<GenKey, number>> = Object.freeze({
  source: 0b000,
  belt: 0b011,
  factory: 0b110,
  tee: 0b111,
  balancer: 0b010,
  router: 0b001,
  merge: 0b100,
  sink: 0b101,
});

/** `LOD_KIND_CODES` bit -> top-right corner. */
const CODE_TOP_RIGHT = 0b100;
/** `LOD_KIND_CODES` bit -> bottom-right corner. */
const CODE_BOTTOM_RIGHT = 0b010;
/** `LOD_KIND_CODES` bit -> bottom-left corner. */
const CODE_BOTTOM_LEFT = 0b001;

/**
 * The corner code the ENDPOINT presence block carries: NONE. An uncut square.
 *
 * Named rather than written as a bare `0` at the call site, because the value is the
 * whole decision: the endpoint takes no code point out of the saturated three-bit
 * space, and an uncut block is how it says it is not one of the eight kinds. See
 * {@link makeEndpointPresenceBlock}.
 */
const ENDPOINT_PRESENCE_CODE = 0b000;

/**
 * Fill an integer-color rectangle at FULL alpha (A=255), clamped to the matrix.
 * The byte-lossless sibling of generators.ts `paintRect`, re-implemented locally so
 * this render-layer module does not reach into the synth layer's private painter -
 * same integer-only discipline (no float into a byte, no wall-clock, no RNG).
 */
function fillRect(m: PixelMatrix, x0: number, y0: number, w: number, h: number, color: number): void {
  const r = (color >> 16) & 0xff;
  const g = (color >> 8) & 0xff;
  const b = color & 0xff;
  const yEnd = y0 + h;
  const xEnd = x0 + w;
  for (let y = y0; y < yEnd; y++) {
    if (y < 0 || y >= m.height) continue;
    for (let x = x0; x < xEnd; x++) {
      if (x < 0 || x >= m.width) continue;
      const idx = (y * m.width + x) * 4;
      m.data[idx] = r;
      m.data[idx + 1] = g;
      m.data[idx + 2] = b;
      m.data[idx + 3] = 255;
    }
  }
}

/**
 * Zero an RGBA rectangle - the alpha-cutting sibling of {@link fillRect}, clamped
 * to the matrix the same way. Writes 0,0,0,0, so the block stays byte-lossless
 * (every alpha byte in the matrix is still exactly 0 or 255) and the cut region
 * is a genuine hole rather than a dark ink that a palette edit could brighten.
 */
function clearRect(m: PixelMatrix, x0: number, y0: number, w: number, h: number): void {
  const yEnd = y0 + h;
  const xEnd = x0 + w;
  for (let y = y0; y < yEnd; y++) {
    if (y < 0 || y >= m.height) continue;
    for (let x = x0; x < xEnd; x++) {
      if (x < 0 || x >= m.width) continue;
      const idx = (y * m.width + x) * 4;
      m.data[idx] = 0;
      m.data[idx + 1] = 0;
      m.data[idx + 2] = 0;
      m.data[idx + 3] = 0;
    }
  }
}

/**
 * The side of one corner bite, in matrix pixels: a QUARTER of the block's shorter
 * side, floor'd, never below 2.
 *
 * PROPORTIONAL, NOT A FIXED PIXEL COUNT, and that is the whole reason the cue
 * reads at LOD. The block is drawn at the machine's real on-screen size, so a
 * fixed 8px bite would be a quarter of a 1x1 source and a twelfth of a 3x3
 * factory - the cue would fade out on exactly the machines that occupy the most
 * screen. A quarter of the shorter side gives every footprint the same relative
 * silhouette change. The floor of 2 keeps the cue non-empty for a degenerate
 * `nativeCell` in a test.
 */
function biteSize(width: number, height: number): number {
  return Math.max(2, Math.floor(Math.min(width, height) / 4));
}

/**
 * Bake one kind's LOD block for `state`: a solid `LOD_TINTS[key]` square at the
 * kind's effective native footprint, CUT by that kind's `LOD_KIND_CODES` corner
 * code, with a STATE pip in the top-left (IDLE = none, WORKING = working accent,
 * FAULTED = fault accent). A CORNER pip (not a full wash) preserves the maximum
 * kind-tint area so kind stays readable at 8-12px on screen while state still
 * reads as colour (Open Question 1 resolution).
 *
 * THE THREE WRITES ARE ORDERED AND THE ORDER IS LOAD-BEARING: fill the tint, then
 * CUT the code, then draw the state pip. The pip occupies the TOP-LEFT corner and
 * the code only ever cuts the other three, so the two encodings are disjoint by
 * construction and no ordering between them could lose either.
 *
 * WHAT THAT ORDERING DOES *NOT* BUY, corrected (58 review WR-05). This docblock used
 * to claim that writing the pip last "means a future pip enlargement fails loudly (it
 * would overwrite a hole with opaque accent) rather than silently eating a kind bit".
 * At the shipped geometry that is FALSE for the entire realistic range. On a 1x1 block
 * (32x32) `biteSize` is 8 and the coded corners begin at x/y 24, while the pip is 8 -
 * so the pip would have to exceed 24px, THREE TIMES its current size, before the
 * ordering did anything at all. A 2x pip changes the rendered block and collides with
 * nothing. The ordering claim is true only at the far boundary; the real protection for
 * the pip's size is the measured-extent gate in `lodTints.test.ts`, which pins the
 * pip's actual run length rather than sampling one pixel at (1, 1).
 *
 * Byte-lossless: every alpha byte written is exactly 0 (a cut corner) or 255 (tint
 * or pip). No partial alpha is produced anywhere on this path.
 */
function bakeBlock(
  tint: number,
  code: number,
  w: number,
  h: number,
  nativeCell: number,
  skin: Skin,
  state: StateTag,
): PixelMatrix {
  const { ew, eh } = effectiveBox(w, h, 0);
  const width = ew * nativeCell;
  const height = eh * nativeCell;
  const m = makeMatrix(width, height);
  // Base: the whole block is the tint (for a kind block, the kind read at low zoom
  // for a viewer who can separate these hues).
  fillRect(m, 0, 0, width, height, tint);
  // The kind CODE: cut the coded corners out. This is the kind read for a viewer
  // who cannot - see LOD_KIND_CODES for why it is alpha and not a second ink. A
  // code of 0 cuts nothing and leaves the square uncut, which is a legal code point
  // (`source` is `0b000`) and is what the endpoint presence block passes.
  const bite = biteSize(width, height);
  if ((code & CODE_TOP_RIGHT) !== 0) clearRect(m, width - bite, 0, bite, bite);
  if ((code & CODE_BOTTOM_RIGHT) !== 0) clearRect(m, width - bite, height - bite, bite, bite);
  if ((code & CODE_BOTTOM_LEFT) !== 0) clearRect(m, 0, height - bite, bite, bite);
  // State pip: a corner square in the reserved accent. IDLE draws none, so the
  // block stays pure kind tint - the "at rest" read.
  if (state === state_tag.IDLE) return m;
  const pip = Math.max(3, Math.floor(nativeCell / 4));

  // BACKED_UP IS A COUNT, NOT A HUE (71-UI-SPEC "Below the LOD cut", plan 71-06). Two
  // stacked pips in the structural ink, separated by one row of the KIND TINT (71-review
  // IN-03: the code fills y 0..pip and y pip+1..2*pip+1 and leaves row `pip` at the base
  // tint from the block fill above - `clearRect` is what clears, and it is used only for
  // the corner code bites, so "one CLEARED row" named the wrong thing). The choice is
  // measured rather than aesthetic: `ramp[4]` against the working accent is 1.018 : 1,
  // so colour alone would carry nothing at all down here. A COUNT does, and it is the
  // same family as the load gauge above the cut (a run of marks means "how much").
  //
  // NO NEW HUE IS MINTED AND NONE COULD BE. `makeEndpointPresenceBlock` below records
  // both halves: the eight kind tints are the eight the maintainer gated on 2026-08-01 (three re-hued by
  // the phase 92 review, see `LOD_TINTS`),
  // and `LOD_KIND_CODES` is a SATURATED three-bit space with the top-left corner already
  // reserved for this pip. The ink is read from the skin, never written as a literal.
  //
  // THIS DOES NOT REOPEN THE LOD PIP'S COLOUR-ONLY STATE CHANNEL, and must not be cited
  // as though it did. Working-versus-faulted down here has always been hue-only
  // (1.797 : 1) and this phase neither fixes nor worsens it. PILE-08's greyscale read
  // happens ABOVE the cut, which is where PILE-11's walk happens too: the demo board's
  // fit zoom is ~1.46, i.e. 46.7 device px per cell against a cut of 16, so the cut is
  // crossed only below zoom 0.5.
  if (state === state_tag.BACKED_UP) {
    const structural = skin.palette.ramp[skin.palette.ramp.length - 1];
    fillRect(m, 0, 0, pip, pip, structural);
    // THE DEGENERATE GUARD, written rather than left as a comment. At the tightest
    // SHIPPED footprint (1x1, nativeCell 32) `pip` is 8, the stack occupies y 0..17 and
    // the bottom-left coded corner begins at y 24, so it clears by 7 px. A test-only
    // `nativeCell` can make `pip` large relative to the block, and a second pip that ran
    // into the bite region would EAT A KIND BIT - the one thing the corner code cannot
    // survive. When the stack does not fit, one pip is the honest degradation: state is
    // still non-IDLE and kind is still readable.
    if (2 * pip + 1 <= height - bite) {
      fillRect(m, 0, pip + 1, pip, pip, structural);
    }
    return m;
  }

  const color = state === state_tag.FAULTED ? skin.palette.accents.fault : skin.palette.accents.working;
  fillRect(m, 0, 0, pip, pip, color);
  return m;
}

/**
 * Bake one KIND's LOD block: {@link bakeBlock} driven by that kind's authored tint and
 * corner code. The `GenKey`-keyed entry point, and the only one `makeLodBlocks` uses.
 */
function bakeLodBlock(key: GenKey, w: number, h: number, nativeCell: number, skin: Skin, state: StateTag): PixelMatrix {
  return bakeBlock(LOD_TINTS[key], LOD_KIND_CODES[key], w, h, nativeCell, skin, state);
}

/**
 * The ENDPOINT PRESENCE BLOCK (66-03, WIRE-03) - what an HTTP Endpoint draws below the
 * LOD cut. It drew NOTHING there until now.
 *
 * # WHY IT IS A PRESENCE BLOCK AND NOT A NINTH KIND. BOTH HALVES ARE MEASURED.
 * Making the endpoint a normal LOD block would need two things that do not exist:
 *
 *   1. A NINTH HUE. `LOD_TINTS` is `Readonly<Record<GenKey, number>>`, so a ninth key
 *      demands a ninth authored tint, and the eight that exist are the eight the maintainer was
 *      shown and gated on 2026-08-01 (three re-hued by the phase 92 review, see
 *      `LOD_TINTS`). Minting one here puts an unjudged colour on the board.
 *   2. A NINTH CORNER CODE, WHICH DOES NOT EXIST. `LOD_KIND_CODES` is a THREE-BIT
 *      space with the top-left corner reserved for the state pip. All eight code
 *      points are taken. There is no ninth code and no fourth corner to widen into,
 *      and a ninth kind SHARING a code is not a cosmetic compromise: the module header
 *      records that the hues do not carry kind on their own under the colour-vision
 *      transforms, which is precisely why the code exists. Sharing one defeats the one
 *      cue that was measured to work.
 *
 * # WHAT IT DRAWS INSTEAD
 * `skin.palette.ramp[4]` - the structural ink every machine outline already draws in
 * above the cut - at the same block geometry, with the same state pip, and with NO kind
 * corner code at all (an uncut square). It mints no colour: `ramp[4]` is not a member of
 * the eight-hue kind set and does not claim to be. An endpoint is a host bridge, not one
 * of the eight machine families, and the neutral structural ink says exactly that. At 8
 * to 16 device px the only question is whether a machine is THERE; kind at that size is
 * carried by the wire terminal, which is the only structure an endpoint ever has.
 *
 * # THIS DOES NOT REOPEN ART-02 OR AXIS 9
 * It is the module header's own argument applied one more time: a sub-pixel presence
 * fallback is not a kind-hue encoding. NOBODY may cite this block as evidence that a
 * ninth hue was approved, or that kind-by-colour was re-admitted anywhere.
 *
 * The colour is READ FROM THE SKIN at bake time and is never written here as a literal,
 * so a reskin moves the block with the outlines it matches. `lodTints.test.ts` asserts
 * that by baking against a fixture skin whose `ramp[4]` differs from the locked one.
 */
export function makeEndpointPresenceBlock(
  skin: Skin,
  nativeCell: number = DEFAULT_NATIVE_CELL,
): (state: StateTag, w: number, h: number) => PixelMatrix {
  return (state: StateTag, w: number, h: number): PixelMatrix =>
    bakeBlock(skin.palette.ramp[skin.palette.ramp.length - 1], ENDPOINT_PRESENCE_CODE, w, h, nativeCell, skin, state);
}

/**
 * A frozen record of per-kind LOD block bakers (READ-05).
 *
 * IT USED TO BE DESCRIBED AS A SIBLING OF THE FAULT-OVERLAY SET BUILDER, and that claim
 * is deleted rather than reworded: plan 61-07 deleted that builder as orphaned canvas
 * bake code, and parity with a deleted thing is not a contract. The discipline the
 * comparison was pointing at is stated directly below instead, which is where it should
 * always have lived.
 *
 * Each thunk is a PURE FUNCTION OF SIZE - `(state, w, h)` - so
 * the caller (machines.ts, from `node.w/h`) is the single sizing authority
 * (RENDER-01); there is NO per-kind footprint table in this module. The machine
 * layer caches the result per (kind|state|WxH|skin) via the shared
 * SynthTextureCache with an `|lod` cache-key suffix, so a RESIZE (e.g. a Router
 * gaining a port, 2x3 -> 2x4) re-bakes a distinct texture variant instead of
 * returning a stale block - never a live mutation (T-33-BAKE, MOTION-05). The set is
 * keyed in GenKey order (from `LOD_TINTS`) for deterministic construction.
 */
export function makeLodBlocks(
  skin: Skin,
  nativeCell: number = DEFAULT_NATIVE_CELL,
): Readonly<Record<GenKey, (state: StateTag, w: number, h: number) => PixelMatrix>> {
  const set = {} as Record<GenKey, (state: StateTag, w: number, h: number) => PixelMatrix>;
  for (const key of Object.keys(LOD_TINTS) as GenKey[]) {
    set[key] = (state: StateTag, w: number, h: number): PixelMatrix =>
      bakeLodBlock(key, w, h, nativeCell, skin, state);
  }
  return Object.freeze(set);
}
