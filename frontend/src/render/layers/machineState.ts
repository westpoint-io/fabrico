// THE MACHINE STATE CUES (58-UI-SPEC "The State Contract on an Open Chassis",
// plan 58-03 task 2) - the two board-drawn marks that carry machine state on a
// chassis that has no body to carry it.
//
// WHY THIS MODULE EXISTS, and it is one measured number rather than a preference.
// Lock axis 3 locks an OPEN chassis: no fill, no body. The pixel era put state in two
// places that both lived in that body - a body TINT for WORKING and a baked 2x2 corner
// MARKER for FAULTED - and both lost their home at once. The obvious replacement is to
// move state onto the outline's COLOUR, and the UI-SPEC measured why that is not
// enough on its own:
//
//   ink                    hex        relative luminance   WCAG vs ramp[4]
//   ramp[4] (idle)         #b0bacb    0.485                -
//   accents.working        #34d399    0.497                1.02 : 1
//   accents.fault          #f0506e    0.253                1.77 : 1
//
// A WORKING outline against an IDLE one is 1.02 : 1 in greyscale - a 2.5% luminance
// difference, inside a rounding error. Under ART-01's "every silhouette identifiable
// in pure greyscale", colour is a REINFORCEMENT channel for state and nothing more.
// So the outline still recolours (`chassisInk`), and each non-idle state ALSO carries
// a mandatory non-colour cue, which is what this module draws:
//
//   WORKING  a 6u x 3u `ramp[0]` NOTCH travelling clockwise around the chassis
//            perimeter. Dark ink on a light outline is an 8.4 : 1 step, and it is a
//            substrate-versus-ink step rather than a hue difference, so it holds in
//            greyscale AND in all three CVD channels by construction.
//   FAULTED  a board-drawn ALERT RING at the style-bible section 4 asymmetric cadence,
//            present when and only when the node is faulted.
//   BACKED_UP a still LOAD GAUGE: a run of up to four `ramp[4]` ticks floating in a band
//            9.000 .. 12.000 px ABOVE the effective box top edge, and at full load the
//            gaps close into ONE solid 25u bar.
//
// THREE CUES, NOT TWO (71-UI-SPEC, plan 71-06). The gauge joins the notch and the ring
// and it is separated from BOTH on three independent axes, any ONE of which would do:
//   PLANE     the notch is ON the chassis wall (2.5 .. 5.5 px inside the box edge), the
//             ring hugs the wall from outside (2.000 .. 4.000 px out), the gauge floats
//             5.000 px clear of the ring's outer edge. Nothing else in the renderer
//             draws in the 9 .. 12 px band above a machine.
//   POLARITY  the notch is DARK ink cutting a LIGHT outline; the gauge is LIGHT ink
//             (`ramp[4]`) on the DARK board (`ramp[0]`), 8.438 : 1 - the notch's own
//             argument run in the opposite direction. At one device pixel the two read
//             as opposite events rather than as the same mark in two places.
//   MOTION    the notch travels, the ring blinks, the gauge is STILL. Motion is the
//             cheapest thing the eye resolves once detail is gone, so the still choice
//             is a legibility choice; it is also the zero-cost choice (MOTION-05).
//
// AND IT ANSWERS REASON 2 BELOW BY A DIFFERENT MECHANISM THAN THE NOTCH DOES, which is
// the one thing a reader is likely to mistake for a contradiction. Reason 2 is that a
// perimeter has no top, so any cue keyed to one edge would read as a different state
// once the machine is rotated. The notch answers it by TRAVELLING the perimeter, so it
// has no home edge to lose. The gauge answers it by NOT ROTATING AT ALL: its Graphics
// parents to `entry.root` rather than to `entry.body` (the precedent `entry.nubs`
// already sets), so a rotated machine keeps its gauge horizontal over its head, filling
// left to right at every `rot`. Both are legal answers to the same rule. What is NOT
// legal is a cue that rotates with the body and keys off one edge, and neither cue is
// that. The gauge satisfies reasons 1, 3 and 4 directly: it is a substrate-versus-ink
// step (1), a count of what is piled inside is exactly what a factory jam looks like
// (3), and it is plotted only inside the layer's signature guard with zero per-frame
// work of any kind (4).
//
// FOUR REASONS THE NOTCH IS THIS CUE and not the pixel era's sweeping accent pixel:
//   1. GREYSCALE-SAFE BY CONSTRUCTION. The old cue was an accent pixel ON an accent
//      body: an accent-on-accent mark is exactly the 1.02 : 1 case above. A dark notch
//      on a light outline cannot be washed out by removing colour.
//   2. ROTATION-INVARIANT. A perimeter has no top. The machine carries a `rot` term,
//      so any cue keyed to one edge would read as a different state once rotated.
//   3. SEMANTICALLY RIGHT FOR A FACTORY. It reads as throughput moving through the
//      machine, which is what the sweeping pixel meant.
//   4. MOTION-05 SAFE. ONE board-drawn Graphics per working machine, plotted once and
//      moved by TRANSFORM. Never a re-bake, never a per-frame `clear()`, never a new
//      `GraphicsContext`.
//
// AND WHY THE WHOLE OUTLINE IS THE STATE CHANNEL rather than a top-edge trim, which is
// the obvious-looking alternative and was the v4.0 precedent. Two reasons, both
// structural: the machine carries a `rot` term, so a top-edge trim rotates with the
// machine and a rotated machine would read as a different state; and splitting a
// closed rectangle into two stroked paths puts butt caps at two corners, which cannot
// be overlapped away because a 1.5u half-stroke is not an integer coordinate.
//
// Everything here is PURE and INTEGER in `u`: no wall clock, no RNG, no Pixi state.
// The one clock it reads is the pinned MOTION-01 quantized frame, passed in.

import type { Graphics } from 'pixi.js';
import { CELL, INSET, NUB_PUSH } from '../../../shared/geometry';
import { effectiveBox } from '../../protocol/footprint';
import {
  NUB_ELECTRICAL_HALF,
  NUB_FAULT_RING_R,
  NUB_R,
  NUB_STEM,
  NUB_STROKE,
} from '../../protocol/ports';
import { FRAMES, faultBlinkAlpha, phaseOffset } from '../faultBlink';
import { CHASSIS_INSET_U, U_PER_CELL, uToPx } from './machineChassis';
import type { Skin } from '../synth/skin';

/**
 * The notch's length ALONG the perimeter, in `u` (58-UI-SPEC: a 6u x 3u mark).
 *
 * Its size ACROSS the perimeter is deliberately NOT a constant here - it is
 * `skin.strokeStructural`, read at draw time. A notch narrower than the chassis stroke
 * leaves a hairline of outline showing through it (so the "notch" reads as a smudge);
 * a notch wider than the stroke eats substrate on both sides of the outline (so it
 * reads as a blob that has escaped the box). Exact cover is the only correct value,
 * and exact cover is a property of the stroke weight, not a number to transcribe.
 * At the locked skin the two agree: `strokeStructural` is 3u, which is the UI-SPEC's
 * stated 3u.
 */
export const NOTCH_LEN_U = 6;

/**
 * The furthest ANY port silhouette reaches OUTSIDE the effective-box edge, in px.
 *
 * DERIVED from the shipped nub constants, never transcribed. This constant exists
 * because the transcription was tried first and was wrong: the docblock below used to
 * state the reach as "1.5u (`nubAnchor` INSET 2 minus `NUB_R` 3.5)", which drops
 * {@link NUB_PUSH} entirely (`ports.ts:200` applies it unconditionally to every anchor)
 * and models only the role-0 disc. Both role-1 and role-2 are heavier. The gate that
 * was supposed to catch that re-derived the SAME wrong arithmetic by hand, so it went
 * green on a false premise for the whole phase (58 code review, CR-01).
 *
 * The three role silhouettes (`machines.ts drawRoleNub`), measured off real Pixi
 * `getLocalBounds()` at a 1x1 footprint and reproduced by the gate in
 * `machineState.test.ts`:
 *
 *   role 0 (In)     disc      NUB_R 3.5                     -> 4.000 px outside
 *   role 1 (Out)    disc+stem NUB_STEM 6.5 + NUB_STROKE/2    -> 7.625 px outside  <- max
 *   role 2 (Fault)  annulus   NUB_FAULT_RING_R 5 + STROKE/2  -> 6.125 px outside
 *
 * ...and the FOURTH silhouette, on the medium axis rather than the role axis (plan
 * 72-09, UI-SPEC 1.2). It is listed here rather than left out because a derivation
 * that omits a shipped silhouette is a constant that agrees with itself:
 *
 *   ELECTRICAL      square    NUB_ELECTRICAL_HALF 5          -> 5.500 px outside
 *
 * It provably does not move the maximum: 5.500 sits between the role-0 disc and the
 * role-2 annulus, and well inside the role-1 stem that already defines it. So
 * `ALERT_RING_OUTSET_U` is untouched and the square crosses the alert-ring band
 * (2.000 .. 4.000) exactly as all three role silhouettes already do. That was the one
 * geometric consequence the new silhouette could have had, and it is asserted rather
 * than argued (`machines.test.ts`, `machineState.test.ts`).
 *
 * Each is `extent - INSET + NUB_PUSH`: the anchor sits `INSET` INSIDE the cell edge and
 * is then pushed `NUB_PUSH` back out along the outward normal.
 */
export const MAX_NUB_REACH_PX =
  Math.max(
    NUB_R, // role 0: plain disc
    NUB_STEM + NUB_STROKE / 2, // role 1: the outward stem, half-stroke included
    NUB_FAULT_RING_R + NUB_STROKE / 2, // role 2: the "danger exit" annulus
    NUB_ELECTRICAL_HALF, // medium ELECTRICAL: the square's half-extent, un-stroked
  ) -
  INSET +
  NUB_PUSH;

/**
 * The alert ring's CENTRELINE offset OUTSIDE the effective box, in `u`.
 *
 * OUTSIDE, not inside, and the inside was measured before it was rejected. The band
 * between the chassis inner edge (5.5u from the box edge) and the nearest shipped
 * glyph ink (9u - `source`, `sink` and `router` all reach it) is 3.5u wide, and a ring
 * at the locked 2u detail stroke leaves 0.5u of substrate on one side of it at a base
 * 1x1 footprint. At `antialias: false` a 0.5u gap does not survive rasterisation: the
 * ring would fuse into either the chassis or the glyph and stop being a distinct shape,
 * which is the one job it has. That rejection still stands, and moving the ring back
 * inside is NOT a way out of the paragraph below.
 *
 * THE PORT-NUB OVERLAP IS REAL, IT IS STILL HERE, AND IT IS DELIBERATE. Do not read
 * the paragraph below as "CR-01 was fixed by moving something". Nothing moved.
 *
 * This docblock used to claim "the ring clears every nub". It does not, and the claim
 * was wrong by exactly one {@link NUB_PUSH}. At the shipped value the ring band spans
 * 2.000 .. 4.000 px outside the box edge while {@link MAX_NUB_REACH_PX} is 7.625 px, so
 * ALL THREE role silhouettes cross the band (measured: role 0 to 4.000, role 1 to
 * 7.625, role 2 to 6.125). Those extents are UNCHANGED and are pinned in
 * `machineState.test.ts`.
 *
 * WHAT WAS RESOLVED IS THE INK, NOT THE GEOMETRY (maintainer decision, 2026-08-02, judging a real
 * render of all three candidate treatments - the 58 code review's CR-01, "Option A").
 * `machines.ts nubColor` no longer returns `accents.fault` for ANY role in ANY state,
 * so the ring is the only thing in the fault accent that reaches this band. Two
 * silhouettes still cross each other; they now cross in two different inks, and the
 * pair reads as an alarm ring around a machine with ports rather than as one smeared
 * red mass. The role-2 annulus keeps its SHAPE, because the shape is what encodes the
 * role (VIS-03); only its fill changed.
 *
 * BOTH GEOMETRIC ROUTES OUT WERE REJECTED ON MEASUREMENT. Do not re-derive them.
 *   - OUTSET 9u (clearing the nubs needs `uToPx(outset) - uToPx(strokeDetail)/2 >
 *     MAX_NUB_REACH_PX`): the halo becomes the dominant element in the cell, spilling
 *     10 px into the neighbour instead of 4 - and it does not even buy clean
 *     clearance, because the role-1 stem tip (7.625) would clear the ring's inner
 *     edge (8.000) by 0.375 px. That is under one device pixel, so with
 *     `antialias: false` the two may snap to touching anyway: worse spill, unsafe
 *     margin.
 *   - INSIDE the chassis band: already rejected in the paragraph above (0.5u of
 *     substrate at a 1x1 does not survive `antialias: false`). Still rejected.
 *
 * No pixel baseline covers a FAULTED machine (`spike/pixelGuard.tsx:425` draws IDLE at
 * both footprints), so no gate has ever RASTERISED this; the ink separation is gated
 * in `machineState.test.ts` off Pixi's own recorded instructions, and the missing
 * FAULTED pixel surface stays open as WINDOWS row 28.
 *
 * THE OTHER ACCEPTED CONSEQUENCE, recorded rather than hidden: on two DIRECTLY ADJACENT
 * machines the ring crosses the neighbour's chassis outline. That is the behaviour of an
 * alarm halo and it has precedent in this codebase - the stranded-dock alert ring
 * (`overlay.ts`) is an r=8 circle drawn at a port that spills across cells freely. It is
 * FEEL row 58-d for plan 58-06 rather than a silent choice.
 */
export const ALERT_RING_OUTSET_U = 3;

/**
 * The ring band's INNER and OUTER edge, in px outside the effective-box edge, at `skin`.
 *
 * Exported so the gate measures the band the drawing code actually strokes instead of
 * re-deriving it by hand beside it. Re-deriving it by hand beside it is precisely what
 * CR-01 was.
 */
export function alertRingBandPx(skin: Skin): { inner: number; outer: number } {
  const half = uToPx(skin.strokeDetail) / 2;
  const centre = uToPx(ALERT_RING_OUTSET_U);
  return { inner: centre - half, outer: centre + half };
}

/* ------------------------------------------------------------------ *
 * THE LOAD GAUGE (71-UI-SPEC "The Load Gauge - full geometry", plan 71-06)
 * ------------------------------------------------------------------ */

/**
 * The gauge band's INNER edge, in `u` OUTSIDE the effective box's top edge.
 *
 * NINE, NOT EIGHT, AND THE REASON IS THE SAME MEASUREMENT THIS FILE ALREADY MADE ONCE.
 * The tight neighbour is not the alert ring (it clears by 5.000 px) but the heaviest
 * port nub silhouette: {@link MAX_NUB_REACH_PX} is 7.625 px, so at 9 u the bare
 * substrate between the nub tip and the gauge's inner edge is 1.375 px. At 8 u it would
 * be 0.375 px - UNDER ONE DEVICE PIXEL, which with `antialias: false` may snap the two
 * silhouettes to touching. That is verbatim the failure {@link ALERT_RING_OUTSET_U}
 * measured and rejected when it refused a 9 u ring outset, reached here on a different
 * mark. Do not shrink this to 8 without re-deriving that.
 *
 * NOTE WHICH ORIGIN THAT COMPARISON IS ON, because this file carries two and they differ
 * by exactly `NUB_PUSH - INSET` = 0.5 px. Both 9.000 and 7.625 are measured from the
 * EFFECTIVE BOX EDGE, so subtracting them is the same question asked twice and 1.375 is
 * right. A nub-to-nub gap is a different question on the NUB-CENTRE origin, and
 * `MAX_NUB_REACH_PX` is the wrong constant for it: feeding it into one double-counts
 * `NUB_PUSH - INSET` and lands 1.0 px out, which is CR-01 a second time.
 *
 * The N edge is chosen over the S edge because N is the ONE side with zero shipped
 * catalog ports across all nine kinds, and because S carries the fault drain a user is
 * dragging a belt onto in this very phase.
 */
export const GAUGE_OUTSET_U = 9;

/** The gauge band's thickness, in `u`. The band therefore spans 9 .. 12 u out. */
export const GAUGE_THICK_U = 3;

/** One tick's length ALONG the run, in `u`. */
export const GAUGE_TICK_U = 4;

/** The bare substrate between two adjacent ticks, in `u`. At full load it CLOSES. */
export const GAUGE_GAP_U = 3;

/** How many ticks a full gauge carries. The wire `load` byte is a level of 0 .. 4. */
export const GAUGE_SLOTS = 4;

/**
 * The whole run's length, in `u`: four ticks and the three gaps between them.
 *
 * WRITTEN AS THE EXPRESSION, NEVER AS ITS TOTAL, on the {@link NOTCH_LEN_U} /
 * {@link MAX_NUB_REACH_PX} precedent for a constant that carries its own derivation. A
 * transcribed 25 agrees with itself forever while the parts drift underneath it, and
 * this file already paid for exactly that mistake once (CR-01).
 */
export const GAUGE_RUN_U = GAUGE_SLOTS * GAUGE_TICK_U + (GAUGE_SLOTS - 1) * GAUGE_GAP_U;

/** Where the travelling notch sits on the chassis, in px, in UNROTATED effective-box
 *  coordinates with the box's min corner at the local origin (the same frame
 *  `drawChassis` draws in). `rotation` is a quarter turn on the vertical edges. */
export interface NotchPlacement {
  /** Notch CENTRE x, px. */
  x: number;
  /** Notch CENTRE y, px. */
  y: number;
  /** 0 on the horizontal edges, `PI/2` on the vertical ones. */
  rotation: number;
  /** Which edge of the chassis the notch is currently on. */
  edge: 'top' | 'right' | 'bottom' | 'left';
}

/** Euclidean modulo - negative-safe, matching `faultBlinkAlpha`'s own wrap. */
function wrap(v: number, m: number): number {
  return ((v % m) + m) % m;
}

/** The chassis CENTRELINE rectangle for a `w x h` footprint, in `u`. */
function centrelineBox(w: number, h: number): { x: number; y: number; w: number; h: number } {
  const { ew, eh } = effectiveBox(w, h, 0);
  return {
    x: CHASSIS_INSET_U,
    y: CHASSIS_INSET_U,
    w: ew * U_PER_CELL - 2 * CHASSIS_INSET_U,
    h: eh * U_PER_CELL - 2 * CHASSIS_INSET_U,
  };
}

/**
 * The perimeter of the chassis CENTRELINE rectangle for a `w x h` footprint, in whole
 * `u`. Integer for every integer footprint, because the inset and the grid both are.
 *
 * A function of `(w, h)` only, exactly like `drawChassis` - which is what makes the
 * notch correct on a GROWN footprint with no new artwork and no per-kind table.
 */
export function chassisPerimeterU(w: number, h: number): number {
  const box = centrelineBox(w, h);
  return 2 * (box.w + box.h);
}

/**
 * The notch's perimeter offset in `u` for `frame`, as a PURE INTEGER FUNCTION of the
 * MOTION-01 quantized frame over the existing bounded loop.
 *
 * `floor(f * perimeter / FRAMES)` over the Euclidean-wrapped frame. Three properties
 * follow directly and are each pinned by a case in `machineState.test.ts`:
 *
 *   - PERIODIC in `FRAMES`, so the notch returns to its start exactly once per bounded
 *     loop and the animation has no drift and no unbounded state.
 *   - STRICTLY INCREASING across a loop at every legal footprint (the smallest
 *     perimeter is a 1x1 at 96u, which is four whole u per frame), so the travel has
 *     ONE consistent rotational direction and never stutters backwards.
 *   - INTEGER, so the same frame lands on the same `u` on every replay, on every
 *     machine, forever. No wall clock is read here and no RNG exists in this module.
 *
 * Note the notch MARCHES rather than glides: at 2x2 the step is 9.33u per frame
 * against a 6u mark, so it advances in discrete jumps at the 10fps quantized cadence.
 * That is deliberate and it is the house idiom, not a compromise - the belt tread
 * marches 8px per phase on the same clock (`53-BELT-LOCK.md`).
 */
export function notchOffset(frame: number, w: number, h: number): number {
  const p = chassisPerimeterU(w, h);
  const f = wrap(Math.floor(frame), FRAMES);
  return Math.floor((f * p) / FRAMES);
}

/**
 * Turn a perimeter offset into a place on the chassis rectangle: centre point in px,
 * plus the quarter turn that puts the notch's long axis along the edge it is on.
 *
 * Clockwise from the top-left corner: top edge left to right, right edge top to
 * bottom, bottom edge right to left, left edge bottom to top.
 *
 * THE CORNER CLAMP, because it is the one non-obvious line. The notch centre is held
 * at least half a notch away from each corner, so the whole 6u mark always sits on the
 * edge it belongs to. Without the clamp a notch centred on a corner would poke 1.5u
 * past the outer corner into bare substrate - a dark tick floating outside the box.
 * The cost is that the notch dwells for at most one frame at each corner (the frame
 * step is 9.33u at 2x2 against a 3u clamp zone), which is invisible at a marching
 * cadence; the alternative cost is a visible defect four times per loop.
 */
export function resolveNotch(offset: number, w: number, h: number): NotchPlacement {
  const box = centrelineBox(w, h);
  const o = wrap(offset, 2 * (box.w + box.h));
  const half = NOTCH_LEN_U / 2;
  const clamp = (t: number, span: number): number => Math.min(Math.max(t, half), span - half);

  if (o < box.w) {
    return {
      x: uToPx(box.x + clamp(o, box.w)),
      y: uToPx(box.y),
      rotation: 0,
      edge: 'top',
    };
  }
  if (o < box.w + box.h) {
    return {
      x: uToPx(box.x + box.w),
      y: uToPx(box.y + clamp(o - box.w, box.h)),
      rotation: Math.PI / 2,
      edge: 'right',
    };
  }
  if (o < 2 * box.w + box.h) {
    return {
      x: uToPx(box.x + box.w - clamp(o - box.w - box.h, box.w)),
      y: uToPx(box.y + box.h),
      rotation: 0,
      edge: 'bottom',
    };
  }
  return {
    x: uToPx(box.x),
    y: uToPx(box.y + box.h - clamp(o - 2 * box.w - box.h, box.h)),
    rotation: Math.PI / 2,
    edge: 'left',
  };
}

/**
 * Plot the WORKING liveness notch into `g`, ONCE, centred on its OWN origin.
 *
 * Centred on the origin is the load-bearing part: it makes a placement a pure
 * transform (`position` + `rotation`) rather than a re-plot, which is how MOTION-05
 * holds on a per-frame path. The caller sets the transform from {@link resolveNotch};
 * this geometry never changes and is never redrawn.
 *
 * `ramp[0]` - the darkest step of the ramp, the substrate colour - so the notch reads
 * as the outline being CUT rather than as a second accent painted over it. That is the
 * whole greyscale argument: a substrate-versus-ink step survives the colour channel
 * being deleted; an accent-versus-accent step does not.
 */
export function drawNotch(g: Graphics, skin: Skin): void {
  g.clear();
  const len = uToPx(NOTCH_LEN_U);
  const across = uToPx(skin.strokeStructural);
  g.rect(-len / 2, -across / 2, len, across).fill({ color: skin.palette.ramp[0] });
}

/**
 * Plot the FAULTED alert ring into `g`, in the same unrotated effective-box
 * coordinates {@link resolveNotch} uses.
 *
 * WHY A RING INHERITS THE RETIRED MARKER'S JOB rather than the fault simply being
 * dropped to a colour. The v4.0 fault cue was a baked 2x2 corner marker that lived in
 * the body, and axis 3 deleted the body. VIS-03 asks for a colour AND shape floor, so
 * the shape half has to land somewhere: the ring is a shape cue that is always present
 * when faulted and never present otherwise, and the blink on top of it is a temporal
 * cue. Both are colour-independent, so the VIS-03 guarantee is PRESERVED rather than
 * lost - and it is preserved on a channel an open chassis cannot swallow, which is
 * exactly what the body-resident marker could not offer any more.
 *
 * Drawn at the DETAIL stroke, deliberately lighter than the 3u chassis: the ring is an
 * alarm halo around the machine, not a second machine outline competing with the first.
 * `cornerRadius` is read through the same branch `drawChassis` uses so the two shapes
 * stay in one family under any skin; the locked value is 0, so the shipped ring is
 * square with zero curve commands.
 */
export function drawAlertRing(g: Graphics, w: number, h: number, skin: Skin): void {
  g.clear();
  const { ew, eh } = effectiveBox(w, h, 0);
  const outset = uToPx(ALERT_RING_OUTSET_U);
  const x = -outset;
  const y = -outset;
  const width = ew * CELL + 2 * outset;
  const height = eh * CELL + 2 * outset;
  if (skin.cornerRadius > 0) {
    g.roundRect(x, y, width, height, uToPx(skin.cornerRadius));
  } else {
    g.rect(x, y, width, height);
  }
  g.stroke({
    width: uToPx(skin.strokeDetail),
    color: skin.palette.accents.fault,
    alignment: 0.5,
  });
}

/**
 * Plot the BACKED_UP load gauge into `g`, in the same unrotated effective-box
 * coordinates {@link resolveNotch} and {@link drawAlertRing} use: the box's min corner
 * at the local origin, `y` increasing downward, so the gauge sits at negative `y`.
 *
 * FOUR PROPERTIES COPIED FROM {@link drawAlertRing} DELIBERATELY, because they are what
 * make a board-drawn cue cheap and re-derivable: the leading `g.clear()`, every length
 * through `uToPx`, the box dims from `effectiveBox(w, h, 0)`, and the ink read off
 * `skin.palette` rather than written as a literal.
 *
 * THE FORM STEP IS THE WHOLE DESIGN. Levels 1 .. 3 draw that many 4 u ticks with a 3 u
 * gap between each; level 4 draws ONE SOLID {@link GAUGE_RUN_U} bar because the gaps
 * close. That is a change of FORM at exactly the moment that matters (the machine is
 * now refusing), it carries no colour channel at all, and it survives being scaled down
 * further than "four ticks versus three ticks" ever could. `ramp[4]` on the `ramp[0]`
 * board is 8.438 : 1, a substrate-versus-ink step, so PILE-08's readable-with-the-
 * colour-removed clause holds BY CONSTRUCTION: there is no hue here to remove.
 *
 * FIXED SIZE AT EVERY FOOTPRINT, AND THAT IS THE DESIGN. The run is 25 u on a 1x1 Sink
 * and 25 u on a 3x3 Factory. The gauge reports a NUMBER, not a proportion of the
 * machine, so a run that scaled with the footprint would make a Factory's one tick look
 * larger than a Sink's four and destroy the cross-machine scan the cue exists for.
 * Contrast `lodTints.ts:biteSize`, which IS proportional because it encodes a
 * per-machine identity rather than a cross-machine quantity.
 *
 * TOTAL OVER THE BYTE, matching `chassisInk`'s unknown-state contract and the
 * open-keyspace treatment `nubColor` gives an unknown port role. `load` arrives RAW off
 * the wire (`decode.ts` reads the u8 without clamping, by design), so the clamp lives
 * here: at or above {@link GAUGE_SLOTS} draws the full bar, at or below 0 draws nothing,
 * and a non-finite byte draws nothing. It never throws.
 *
 * `load === 0` PLOTS NOTHING AT ALL. A calm board carries zero gauges, and that silence
 * is the empty state - the cue costs the eye nothing until there is something to say.
 */
/** The ink the load gauge is plotted in: the skin's last ramp step. One place, so the gauge form
 *  read-back (`machines.ts` `readLoadGaugeForm`) compares against the ink this file draws in. */
export function gaugeInk(skin: Skin): number {
  return skin.palette.ramp[skin.palette.ramp.length - 1];
}

export function drawLoadGauge(g: Graphics, load: number, w: number, h: number, skin: Skin): void {
  g.clear();
  if (!Number.isFinite(load)) return;
  const level = Math.min(Math.floor(load), GAUGE_SLOTS);
  if (level <= 0) return;

  const { ew } = effectiveBox(w, h, 0);
  const run = uToPx(GAUGE_RUN_U);
  const tick = uToPx(GAUGE_TICK_U);
  const pitch = uToPx(GAUGE_TICK_U + GAUGE_GAP_U);
  // Centred on the effective box's top edge; the band's near side is GAUGE_OUTSET_U out
  // and it is ABOVE, so the whole band sits at negative y.
  const x0 = (ew * CELL) / 2 - run / 2;
  const y0 = -uToPx(GAUGE_OUTSET_U + GAUGE_THICK_U);
  const thick = uToPx(GAUGE_THICK_U);
  const ink = gaugeInk(skin);

  if (level >= GAUGE_SLOTS) {
    // The gaps close. ONE rect, not four abutting ones: a merged run is what the eye is
    // being asked to read, and one rect is also what makes the form step assertable.
    g.rect(x0, y0, run, thick).fill({ color: ink });
    return;
  }
  for (let i = 0; i < level; i += 1) {
    g.rect(x0 + i * pitch, y0, tick, thick).fill({ color: ink });
  }
}

/**
 * The alert ring's alpha for `frame` at the node's STABLE origin cell.
 *
 * A one-line reuse of the SHIPPED cadence (`render/faultBlink`), never a second timing
 * source: attack 3 frames, release 11, hold 10, peak 0.80, floor 0.25, with the
 * per-node FNV-1a phase desync keyed on the origin cell so adjacent faults never read
 * as one synchronized pulse and a machine that stays put keeps its phase across
 * undo / redo / load. It exists as a named function rather than as two lines at the
 * call site precisely so there is ONE place the machine layer can get a fault cadence
 * from, and so `machineState.test.ts` can assert equality against `faultBlinkAlpha`
 * itself rather than against a copy of its shape.
 *
 * Paused holds steady for free: the frame is the pinned sim clock, so a paused sim
 * freezes the frame and the alpha holds at wherever it was.
 */
export function alertRingAlpha(frame: number, cellX: number, cellY: number): number {
  return faultBlinkAlpha(wrap(frame + phaseOffset(cellX, cellY), FRAMES));
}
