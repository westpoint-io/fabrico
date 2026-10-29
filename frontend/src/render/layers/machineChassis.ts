// The PARAMETRIC MACHINE CHASSIS (ART-01, plan 58-01) - the vector body every
// machine kind shares, drawn in CODE rather than authored into artwork.
//
// WHY THIS MODULE EXISTS AT ALL, because "the chassis is just a rectangle, put it
// in the SVG" is the obvious wrong answer and it was the plan of record until
// 2026-08-02. A user can GROW a machine's footprint through the shipped, documented
// `+ Add output` gesture: `grow_to_fit` (`crates/fabrico-core/src/state.rs`) clamps
// only at `MAX_FOOTPRINT_DIM = 64`, so a Router at base 2x3 becomes 2x6 and beyond.
// The authored-asset format has a CLOSED four-value `viewBox` whitelist covering the
// four BASE footprints, so a grown machine has no legal asset and never can have one.
// The pixel bake hid this because it sized its matrix per call; a fixed-`viewBox` SVG
// cannot. The maintainer's call: the chassis is two numbers - a 4u inset and a 3u stroke - and
// two numbers draw every footprint, grown or not. The `.svg` carries only the glyph.
//
// TWO PROPERTIES THIS MODULE HOLDS, both pinned by `machineVector.test.ts`:
//
//   1. `drawChassis` is a function of `(w, h)` ONLY. There is no per-kind table and
//      no base-footprint lookup anywhere in this file. That is what makes a grown
//      footprint correct with no new artwork, and it is the whole reason the chassis
//      left the asset.
//   2. It reads its stroke weight and its corner radius FROM THE SKIN, never from a
//      second literal. `LOCKED_SKIN.strokeStructural` is the one declaration of "3u"
//      that the shipped chassis obeys, so the schema axis is live rather than a
//      transcription that can silently disagree with the thing it describes.
//
// Pure and integer-only in `u`: no wall clock, no RNG, no float into a colour byte.

import type { Graphics } from 'pixi.js';
import { CELL } from '../../../shared/geometry';
import { state_tag } from '../../protocol/kinds';
import { effectiveBox } from '../../protocol/footprint';
import type { Skin } from '../synth/skin';

/**
 * The chassis CENTRELINE inset from the effective-box edge, in `u`.
 *
 * Lock axis 4 as DRAWN AND JUDGED: every Direction A candidate is "the same 4u-inset
 * rectangle", and that is the artwork the maintainer picked on the board.
 *
 * A RENDER CONSTANT, DELIBERATELY NOT A SKIN AXIS. `58-UI-SPEC.md`'s schema block
 * carries five numbers and this is not one of them: the inset is a property of the
 * chassis PRIMITIVE (where the one shared rectangle sits inside its box), not a
 * styling knob a skin varies. Promoting it to `Skin` would add a sixth axis with
 * exactly one legal value, which is the dead-value trap SKIN-01 forbids.
 *
 * WHAT ACTUALLY GATES THIS VALUE, stated because the answer used to be "less than you
 * would think" (58 review WR-04). Two things, and only together:
 *
 *   1. `machineVector.test.ts` pins the LITERAL 4. Everything else in that file
 *      derives its expected geometry FROM this constant, so a derivation-only suite
 *      agrees with itself at any value - mutation-proven, `4 -> 6` passed all 1422
 *      vitest cases and all 87 spec files before the literal pin was added.
 *   2. The Playwright `operator-footprint.png` baseline catches the RENDERED result
 *      (verified: mutating this reddens that one surface and no other). Note it does
 *      NOT run in the `frontend unit (vitest + tsc)` CI job, and `tsc` typechecks zero
 *      e2e specs - so it is a real gate but not one a unit run can cite.
 */
export const CHASSIS_INSET_U = 4;

/**
 * The authoring grid: `u` per cell. The lock, the UI-SPEC and every authored
 * `viewBox` are written in `u` on a 32u-per-cell grid.
 */
export const U_PER_CELL = 32;

/**
 * `u` -> px, derived from `CELL / U_PER_CELL` rather than from `CELL` alone.
 *
 * At the shipped `CELL = 32` this is exactly 1, which is precisely why it is written
 * out: a reader (or a later `CELL` change) would otherwise be relying on the two
 * numbers HAPPENING to be equal, and every `u` figure in this file would silently
 * become a px figure. The unit story is explicit or it is not a unit story.
 */
export const U_TO_PX = CELL / U_PER_CELL;

/** One length in `u`, in px. */
export function uToPx(u: number): number {
  return u * U_TO_PX;
}

/**
 * The chassis outline ink for one machine state.
 *
 * This is the state channel for vector machines. Lock axis 9 puts every kind's glyph
 * on ONE ink (`ramp[4]`) with no family encoding, so the outline is where state
 * lives: `ramp[4]` at rest, the working accent while running, the fault accent on a
 * live fault. ART-02's second sentence survives its first - kind loses its colour
 * channel, state keeps it.
 *
 * BACKED_UP DIMS THE OUTLINE TO `ramp[3]` (71-UI-SPEC, plan 71-06), and the two obvious
 * alternatives are both lies. `accents.working` would say a machine that is refusing
 * deliveries is producing. `accents.fault` would put a jam in the alarm colour and
 * destroy the fault-versus-jam distinction PILE-08 exists to draw - a jam is a normal,
 * expected, self-healing operating condition. Leaving it at the idle `ramp[4]` is honest
 * but unreadable: it would make BACKED_UP identical to IDLE on this channel, so a
 * greyscale screenshot would get nothing here at all and the Legend would carry two
 * identical swatches. `ramp[3]` is the shipped dim/outline step one below the highlight
 * (`nubColor` already returns it for role 2), so it mints nothing, and it measures
 * 3.285 : 1 against the idle outline - a greyscale-legible step. The machine goes quiet,
 * which is what a jam is.
 *
 * Total over the byte: an unknown `state` reads as IDLE rather than throwing, matching
 * the open-keyspace treatment `nubColor` gives an unknown port role.
 */
export function chassisInk(state: number, skin: Skin): number {
  if (state === state_tag.FAULTED) return skin.palette.accents.fault;
  if (state === state_tag.BACKED_UP) return skin.palette.ramp[skin.palette.ramp.length - 2];
  if (state === state_tag.WORKING) return skin.palette.accents.working;
  return skin.palette.ramp[skin.palette.ramp.length - 1];
}

/**
 * ONE machine chassis, described rather than drawn. Every length is in AUTHORING
 * UNITS (`u`), never in px.
 *
 * WHY `u` AND NOT px, stated because px is the tempting choice (the Pixi drawer wants
 * px and would then need no conversion). This spec is ALSO serialised into a 32u
 * `viewBox` by `chassisPathD` for the DOM icon. A px spec would emit CSS pixel numbers
 * into a `u` coordinate system, which is correct only for as long as `CELL` happens to
 * be 32 - and `U_TO_PX` exists in this very file precisely because that coincidence is
 * not allowed to be load-bearing. One unit system in the description; the conversion
 * happens at each consumer's own boundary.
 *
 * INK IS DELIBERATELY ABSENT. `chassisInk(state, skin)` is a function of STATE, and the
 * DOM icon has no state - it paints `currentColor` and lets the button it sits in decide
 * (that is what makes it desaturate with a disabled button). Putting ink in the spec
 * would force the icon to supply a state byte it does not have.
 */
export interface ChassisSpec {
  /** Left edge of the stroke CENTRELINE, in `u` from the effective box's min corner. */
  x: number;
  /** Top edge of the stroke centreline, in `u`. */
  y: number;
  /** Centreline width, in `u`. */
  w: number;
  /** Centreline height, in `u`. */
  h: number;
  /** Corner radius, in `u`, read from the skin. The locked value is 0. */
  radiusU: number;
  /** Stroke weight, in `u`, read from the skin. The locked value is 3. */
  strokeU: number;
}

/**
 * The chassis of a `w x h` machine, as data.
 *
 * A function of `(w, h)` and the skin ONLY - no kind, no base-footprint lookup - which
 * is property 1 of this module's header, now stated where both consumers read it.
 *
 * THE PIXEL IDENTITY WITH THE OLD IN-LINE ARITHMETIC IS ALGEBRAIC, NOT HOPED FOR, and it
 * is written out here so the next reader does not have to re-derive it before trusting
 * the refactor:
 *
 *     uToPx(ew * U_PER_CELL - 2 * CHASSIS_INSET_U)
 *       = (ew * 32 - 8) * (CELL / 32)
 *       = ew * CELL - 8 * CELL / 32
 *       = ew * CELL - 2 * uToPx(CHASSIS_INSET_U)
 *
 * which is exactly the expression `drawChassis` used to compute in place, for EVERY
 * `CELL` and not merely for the shipped 32. The rendered control on that claim is the
 * Playwright `operator-footprint.png` baseline, which must not move.
 */
export function chassisSpec(w: number, h: number, skin: Skin): ChassisSpec {
  const { ew, eh } = effectiveBox(w, h, 0);
  return {
    x: CHASSIS_INSET_U,
    y: CHASSIS_INSET_U,
    w: ew * U_PER_CELL - 2 * CHASSIS_INSET_U,
    h: eh * U_PER_CELL - 2 * CHASSIS_INSET_U,
    radiusU: skin.cornerRadius,
    strokeU: skin.strokeStructural,
  };
}

/**
 * A {@link ChassisSpec} as an SVG `d` string, for the DOM icon.
 *
 * THROWS ON A NON-ZERO RADIUS rather than silently emitting a square - the
 * throw-rather-than-default rule this file already applies at `drawChassis` and
 * `svgAssets.getAssetBox` follows at the author box. The chrome authoring grid forbids
 * curve commands (lock axis 5; `scripts/lint-svg.ts`'s `curve` rule is at `fail`
 * severity), so a rounded chassis is not expressible here at all. Emitting a square one
 * anyway would put a SQUARE icon beside a ROUNDED canvas machine with nothing to
 * diagnose it by - the two-surfaces-silently-disagreeing failure CHROME-01 exists to
 * remove.
 *
 * THE GRID IS `M H V L Z`; WHAT THIS FUNCTION EMITS IS `M H V H Z` (phase 59 review
 * IN-03, which found the two named as though they were the same thing - this docblock
 * said "`M H V H Z` only, matching the authored dialect" four lines above a throw
 * message calling the dialect `M H V L Z`). `M H V L Z` is the chrome authoring grid:
 * the closed set of commands an asset may use, zero of them curves. `M H V H Z` is the
 * subset this serialiser needs for an axis-aligned rectangle, which uses no `L` at all.
 * Both are correct; they are answers to different questions, and the emitted string is
 * `M .. H .. V .. H .. Z`. Either way the path is legible beside the `.svg` files it is
 * composed with, which is the property the sentence was making.
 */
export function chassisPathD(spec: ChassisSpec): string {
  if (spec.radiusU > 0) {
    throw new Error(
      `machineChassis: chassisPathD cannot serialise a corner radius (radiusU=${spec.radiusU}). ` +
        'The chrome authoring grid is M H V L Z with zero curve commands, so a rounded chassis ' +
        'has no representation here. Emitting a square one would put a square icon beside a ' +
        'rounded canvas machine with nothing to diagnose the difference.',
    );
  }
  return `M ${spec.x} ${spec.y} H ${spec.x + spec.w} V ${spec.y + spec.h} H ${spec.x} Z`;
}

/**
 * Draw one machine's chassis into `g`, in UNROTATED effective-box coordinates with
 * the box's min corner at the local origin.
 *
 * `rot` is deliberately absent from the signature. Rotation is a transform on the
 * parent container (`body.rotation`, pivoted at the unrotated box centre), exactly as
 * the pixel sprite's `rotation` + anchor-0.5 already worked, so this function draws
 * the rot-0 box and nothing here needs to know about quarter-turns. `effectiveBox`
 * is still called - with a literal `0` - so the box arithmetic goes through the ONE
 * shared footprint primitive rather than open-coding `w * CELL`.
 *
 * STROKE ALIGNMENT IS CENTRED (Pixi's default, stated explicitly because the whole
 * inset arithmetic depends on it). A 4u centreline inset at a 3u stroke puts the
 * chassis OUTER edge at `4 - 1.5 = 2.5` px from the cell edge, against the shipped
 * `INSET = 2` that `localNubSpecs` anchors port stems to. So a nub stem OVERLAPS the
 * chassis by half a pixel rather than leaving a gap - which is the correct direction
 * to err, and is why `shared/geometry.ts`'s `INSET` is NOT changed to 2.5 (58-UI-SPEC
 * Integration Contract: moving it would push a non-integer into a constant that cell
 * arithmetic, `nubAnchor`, the selection rect and the e2e oracles all depend on).
 *
 * No fill: lock axis 3 is an OPEN chassis, and the one fill lock axis 6 permits is
 * spent by the glyph, not by the body.
 */
export function drawChassis(
  g: Graphics,
  w: number,
  h: number,
  skin: Skin,
  state: number,
): void {
  g.clear();
  // A CONSUMER of the shared description, not a second derivation of it. The rectangle
  // is declared ONCE, in `chassisSpec`, and the DOM palette icon serialises that same
  // description through `chassisPathD` - which is the honest reading of CHROME-01's
  // "share one declaration, not two code paths that agree".
  const spec = chassisSpec(w, h, skin);
  const x = uToPx(spec.x);
  const y = uToPx(spec.y);
  const width = uToPx(spec.w);
  const height = uToPx(spec.h);
  // `radiusU` is READ, not assumed. The locked value is 0 (axis 5: "radius 0, square,
  // 0 curve commands") and `rect` is the zero-curve primitive that expresses it, but a
  // skin carrying a non-zero radius gets a real rounded chassis rather than a silently
  // ignored axis - the difference between a schema field and a comment.
  if (spec.radiusU > 0) {
    g.roundRect(x, y, width, height, uToPx(spec.radiusU));
  } else {
    g.rect(x, y, width, height);
  }
  g.stroke({
    width: uToPx(spec.strokeU),
    color: chassisInk(state, skin),
    alignment: 0.5,
  });
}
