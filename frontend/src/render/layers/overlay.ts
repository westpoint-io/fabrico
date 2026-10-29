// The overlay layer (UI-SPEC "Interaction Affordances" VIS-05 + Phase 21
// sections 3/4/5/6/8) — the RENDER half of the build affordances. This layer
// only DRAWS; the gesture controller computes validity, routes, and selection
// identity and DRIVES these primitives, then emits a logged GridCommand. There
// is NO optimistic write here: the overlay is display-only, no affordance
// writes scene state or emits commands (SC5 / T-21-05 — gestures/host own
// mutation).
//
// build accent = construct/valid/selection; fault accent = invalid/fault. The
// item accent is never used here (reserved for live items). Every affordance
// derives its colours from ONE held palette derived once from the ONE locked
// skin (D-22), NOT a hardcoded per-draw import — so the whole affordance colour
// set is defined in a single place and belongs to the same data-driven world as
// the machine/belt/item layers. Each affordance owns its own Graphics so it
// clears independently of the others.

import { Container, Graphics } from 'pixi.js';
import { plottedCircles, plottedFilledRects, plottedInstructions, plottedPolylines } from '../plotRead';
import { BELT_GEOM, CELL } from '../../../shared/geometry';
import type { CellCoord } from '../camera';
import type { SceneState } from '../sceneState';
import type { TileKindView, TileView } from '../../protocol/decode';
import { effectiveBox } from '../../protocol/footprint';
import { machine_kind, state_tag } from '../../protocol/kinds';
import { NUB_RING_R, NUB_RING_STROKE, nubAnchor, unitDelta, type NubSpec } from '../../protocol/ports';
import { cablePoints, type CableNubs } from '../cableGeometry';
import { drawBeltTilePath } from './belts';
import { LOCKED_SKIN } from '../synth/skins/locked';
import { CHASSIS_INSET_U, uToPx } from './machineChassis';
import { drawRoleNub, labelStrokeWidth } from './machines';
import type { Skin } from '../synth/skin';

/**
 * The affordance colour set derived from a skin's ramp + accents. Every draw
 * site reads from a single held instance of this, derived once, so the whole
 * overlay's colours have exactly one source (accents carry the semantic jobs,
 * the ramp supplies neutral chrome).
 */
interface AffordancePalette {
  /**
   * build accent - ghost/selection/route/rotate-handle/armed-nub affordances, and as
   * of plan 66-06 the resting wire-target rings (`showWireTargets`) too.
   */
  build: number;
  /** fault accent — invalid placement + stranded-dock alert rings. */
  fault: number;
  /** working accent — retained for the bible §5 working port-nub state cue. */
  working: number;
  /** subtle neutral hover/ring stroke (brightest ramp step, was hoverRing). */
  hover: number;
  /** rotate-handle disc fill (dark panel ramp step, was panelElevated). */
  handleFill: number;
  /** high-contrast rim under handles (darkest ramp step, was void). */
  rim: number;
  /** The pending-placement shimmer's neutral (near-lit ramp step, was portNub). The ghost's
   *  preview nubs are the canvas's own `drawRoleNub` (phase 92), so the `nubOut` this palette
   *  carried for them was dead and is gone (phase 92 review IN-B-01). */
  nubNeutral: number;
}

/**
 * Derive the affordance palette from a skin. Accents map to their reserved
 * semantic jobs (bible §1); the neutral chrome (hover ring, rotate-handle fill,
 * contrast rim, passive nubs) maps onto FIXED ramp indices (never a brightness
 * multiply), so the chrome tracks the skin's own ramp rather than hand-authored
 * hex, and legibility follows the ramp's contrast by construction.
 */
function deriveAffordancePalette(skin: Skin): AffordancePalette {
  const { accents, ramp } = skin.palette;
  const light = ramp[ramp.length - 1]; // brightest step
  return {
    build: accents.build,
    fault: accents.fault,
    working: accents.working,
    hover: light,
    handleFill: ramp[1],
    rim: ramp[0],
    nubNeutral: ramp[ramp.length - 2],
  };
}

const BODY = 28; // full body inside the 32px cell (small inset for CELL=32 affordance legibility)
const INSET = (CELL - BODY) / 2; // 2px, never negative at CELL=32
const RADIUS = 8;

/** Ghost fill alpha — port preview nubs draw at the same alpha (UI-SPEC). */
const GHOST_ALPHA = 0.6;
/**
 * Where the stranded-dock alert ring's pulse SETTLES.
 *
 * AMENDED 2026-08-30 (maintainer decision, post-UI-review F2), in the same commit as the
 * UI-SPEC text. This constant used to be `ALERT_TTL_MS` and it CLEARED the
 * ring: a stranded dock announced itself for five seconds and then healed by
 * being ignored. That was correct while the ring was purely an ALERT (Phase 21
 * / 26). Phase 67 promoted it to the SOLE recovery control - `gestures.ts`
 * gates the reconnect press on `alertRingsActive()`, so the capability died
 * with the paint - which put a user who looked away for six seconds straight
 * back into the v7.0 FEEL row 62-d symptom the phase exists to close.
 *
 * A stranded dock is a real broken state, not a transient notification. The
 * ring now persists until it is RESOLVED: reconnected (the press retires it via
 * `clearAlertRingAt`), or cleared by the next structural edit (App.tsx's
 * `clearAlertRings` branch - the edit-clear half of the lifetime contract,
 * unchanged). What the five seconds now buys is ATTENTION decay rather than
 * CAPABILITY decay, which is exactly the split the review asked for.
 *
 * The number itself does not move. Reusing 5000 keeps the shouting phase
 * byte-identical to what has shipped since Phase 21 and mints no new timing.
 */
const ALERT_SETTLE_MS = 5000;
/** Alert pulse: alpha = FLOOR + AMP * (0.5 + 0.5*sin(2*PI*1Hz*t)) — the same
 * 1Hz cadence as the machine fault pulse, gentler floor (UI-SPEC section 6). */
const ALERT_PULSE_FLOOR = 0.35;
const ALERT_PULSE_AMP = 0.45;
/**
 * The calm steady alpha a SETTLED ring holds: 0.75, which plots `pal.fault` over the ground at
 * 3.22 : 1 (`#bb445c` on `#1b1f27`, WCAG relative luminance), over the 3 : 1 floor for a graphic
 * that carries meaning (WCAG 1.4.11).
 *
 * RAISED BY THE PHASE 89 UI REVIEW (UI-03), from the pulse's own midpoint 0.575, which plotted
 * 2.37 : 1: the settled ring is the one a user meets after looking away for five seconds, so it is
 * the one that must clear the floor. 0.70 (2.95 : 1) does not; 0.72 (3.04 : 1) clears it with no
 * margin for the stroke's anti-aliased edge. The reduced-motion arm below holds this value from
 * birth, as it held the old one.
 */
const ALERT_SETTLED_ALPHA = 0.75;
/**
 * When the pulse hands over to the settled alpha: the first moment at or after `ALERT_SETTLE_MS`
 * where the 1 Hz sine, RISING, passes through `ALERT_SETTLED_ALPHA`. The old settled value was the
 * sine's midpoint, which the pulse crosses at exactly 5 s, so the settle never stepped; the new one
 * sits above the midpoint, and settling at 5 s sharp would jump from 0.575 to 0.75 in one frame.
 * Settling on the rise keeps the hand-over continuous: the ring stops moving, it does not step.
 * About 5142 ms (5 s plus asin(0.778) / 2 PI of a second).
 */
const ALERT_SETTLE_AT_MS =
  ALERT_SETTLE_MS +
  (1000 * Math.asin((2 * (ALERT_SETTLED_ALPHA - ALERT_PULSE_FLOOR)) / ALERT_PULSE_AMP - 1)) / (2 * Math.PI);

/** Pending-shimmer pulse (UI-SPEC §5b, IX-05): alpha = FLOOR + AMP * (0.5 +
 * 0.5*sin(2*PI*1.5Hz*t)) → oscillates 0.30..0.55. The high floor keeps the
 * neutral ink legible pre-SHELL-01 (the coordinated contrast raise is Phase
 * 32's); the gentle 1.5Hz cadence reads as "awaiting", not the 1Hz fault pulse. */
const PENDING_FLOOR = 0.3;
const PENDING_AMP = 0.25;
const PENDING_HZ = 1.5;
/** Very low fill under the shimmering silhouette outline (UI-SPEC §5b). */
const PENDING_FILL_ALPHA = 0.15;
/** Reject-flash one-shot lifetime (UI-SPEC §5a): ease-out over 180ms then clear. */
const REJECT_MS = 180;

/**
 * The pending-size outline's stroke alpha (76-UI-SPEC 5.4: "alpha 0.5, the ghost alpha").
 * The placement ghost's FILL is {@link GHOST_ALPHA} 0.6; the spec's 0.5 is the outline's
 * own figure and is kept as written, a still outline over a tinted box reading lighter
 * than a moving filled ghost.
 */
export const LABEL_RESIZE_ALPHA = 0.5;

/** The plain-data read-back {@link OverlayApi.labelResizePreview} returns. */
export interface LabelResizeReadback {
  instructions: number;
  stroke: { color: number; alpha: number; width: number } | null;
  /** The plotted rectangle in WORLD px. */
  rect: { x: number; y: number; w: number; h: number } | null;
  /** Whether any fill was plotted (the outline never fills). */
  filled: boolean;
}

/** A rotated catalog port in ghost-local cells (plan 21-07 supplies these). */
export interface GhostPort {
  lx: number;
  ly: number;
  side: number;
  role: number;
  /**
   * The catalog port's transport medium (`MEDIUM_MECHANICAL` / `MEDIUM_ELECTRICAL`), so the
   * ghost previews an electrical port as the canvas's square (phase 92, CHROME-18). Optional
   * for the reason `NubSpec.medium` is: an absent byte draws the mechanical disc.
   */
  medium?: number;
}

export interface OverlayApi {
  /** The overlay Container (added to the camera, above all other layers). */
  layer: Container;
  /**
   * Translucent build ghost snapped to a cell: build-blue if valid, red if not.
   * `dims` (rot-0 `w`/`h` + `rot`) draws the real multi-cell footprint
   * silhouette. `ports` (rotated catalog ports, ghost-local cells) draws each
   * nub with the canvas's own `drawRoleNub` at the idle state, inside the ghost
   * at its alpha (D-14 support; phase 92 D-06).
   */
  showGhost(
    cell: CellCoord,
    valid: boolean,
    dims?: { w: number; h: number; rot: number },
    ports?: GhostPort[],
  ): void;
  clearGhost(): void;
  /**
   * Orthogonal/Manhattan wire-route preview through a path of cells.
   *
   * `nubs` are the corridor's two ends (plan 75-05, D-08, CABLE-08): the pressed port's
   * nub and the acquired port's nub, or `NO_NUB` for the free end over open floor. They
   * are REQUIRED, with no default, because an optional pair let the preview stroke cell
   * centre to cell centre for three phases while the cable that landed reached both nubs:
   * a corridor 16.5 px short at each end promises a different cable. The ends are placed
   * by `cablePoints`, the same builder the wire layer draws the cable with.
   *
   * `lane` is D1's lane key for the SAME route (`cableLane(geometry.tiles)`, 66-UI-SPEC
   * 5.1), and it exists so THE GHOST OCCUPIES THE LANE THE LANDED CABLE WILL OCCUPY. It
   * is passed in rather than derived here because the caller already holds the routed
   * tiles, and because a second independent computation of that key is exactly the
   * ghost-shows-one-corridor / cable-shows-another split that disqualified the
   * `fabrico-command` corridor offset. Defaults to 0 (no displacement).
   *
   * Every `pairedLegs` entry carries its OWN `nubs`, the two ports of the return leg.
   */
  showRoute(
    path: CellCoord[],
    nubs: CableNubs,
    valid?: boolean,
    lane?: number,
    pairedLegs?: ReadonlyArray<{ path: CellCoord[]; lane: number; nubs: CableNubs }>,
  ): void;
  clearRoute(): void;
  /**
   * The wire drag preview's PLOT READ (plan 75-05, CABLE-08): every stroked run the route
   * `Graphics` holds right now, as an array of world points per run, read back off its own
   * `context.instructions` with any primitive transform applied (the `plottedCircles`
   * shape, for polylines). One run per corridor, so a paired preview reads as two.
   *
   * Added because the corridor's ENDS had no instrument: a call log of `showRoute`'s
   * arguments says what the gesture asked for, never what was drawn, and a preview that
   * stopped 16.5 px short of both nubs passed every test that read arguments. This goes to
   * an empty array the moment the Graphics is cleared. Read-only, fresh arrays of plain
   * numbers, no setter, no Pixi ref.
   */
  wirePreviewPolylines(): Array<Array<{ x: number; y: number }>>;
  /** Live draw-belt preview: routed tiles, build-blue if valid, red if not. */
  showBeltPreview(tiles: TileView[], valid: boolean): void;
  clearBeltPreview(): void;
  /**
   * The draw-belt preview's PLOT READ (plan 74.1-26, review WR-08): how many geometry
   * instructions the preview `Graphics` holds right now, read off its own
   * `context.instructions`, never off the retained `beltPreviewLast` tile list.
   *
   * Added because the moment after a release had no instrument for the preview at all:
   * the live release leg could see the belt the belts layer drew, but not whether the
   * preview was still on screen in the frames before the DrawBelt echo, so a frame
   * showing NEITHER (S1R, 1 to 3 blank frames on the walk) passed. A tile-list read
   * would agree with any drawing function, including one that plots nothing; this
   * goes to zero the moment the Graphics is emptied. A COUNT for the reason
   * {@link alertRingInstructions} gives. Read-only: no clock, no setter, no Pixi ref.
   *
   * SINCE PLAN 74.1-30 IT COUNTS BOTH BELT-PICTURE SURFACES: the drag preview and the
   * held pictures of committed belts ({@link showHeldBelts}), because from the release
   * on the picture of the belt lives on the second one.
   */
  beltPreviewInstructions(): number;
  /**
   * WHAT SHAPE the draw-belt preview PLOTTED at one cell (plan 74.1-30, review round 4
   * CR-01): the tile kind at `(cellX, cellY)` in the tile list the preview surface last
   * PLOTTED, or null when no plotted tile covers that cell. The list is recorded inside
   * the same call that hands it to `drawBeltTilePath` (the retained shape too, when a
   * typed reject repaints it in fault) and dropped inside the same call that clears the
   * Graphics, so it is a read of what was plotted, never of what a caller meant.
   *
   * Added because a count cannot see a straight preview: the S1R live leg graded a frame
   * good whenever {@link beltPreviewInstructions} was above zero, so the straight seam the
   * walk saw on the first frame after every docked release (and for the whole pause when
   * paused) passed. Read-only: a fresh plain object, no clock, no setter, no Pixi ref.
   *
   * It answers from BOTH belt-picture surfaces, the drag preview and the held pictures
   * ({@link showHeldBelts}), each from the list its own plotting call recorded, the drag
   * preview first. The two CAN cover one cell, and this docblock said they could not until
   * plan 88-07: a drag over a held belt was drawn build-blue and sent, because the occupancy
   * read saw only the folded scene. Since plan 88-07 the queued claims are counted
   * (`input/queuedClaims.ts`, read by `ghost.ts` `cellOccupied`), so a held belt's cells are
   * taken in the preview: a drag over them is still PLOTTED, in fault, and is never sent, and
   * no committed draw covers a held belt's cell.
   */
  beltPreviewKindAt(cellX: number, cellY: number): TileKindView | null;
  /**
   * THE DRAG PREVIEW'S COLOUR, AS PLOTTED (plan 88-07, BELT-06): the colour of the first
   * stroke the draw-belt drag preview `Graphics` holds, and whether it is the build accent
   * (`valid`, the path the release would send) rather than fault. `null` when the drag preview
   * holds nothing. Only the drag preview: the held pictures of committed belts are always
   * drawn in build and are not this read's subject.
   *
   * Added because a count ({@link beltPreviewInstructions}) and a kind
   * ({@link beltPreviewKindAt}) cannot say whether the user was shown "yes" or "no", which is
   * the whole of BELT-06's claim: a second paused draw over a held belt, whose cells are a
   * queued claim the occupancy read counts, must be drawn as not allowed. Read back off the
   * Graphics' own instructions, never off the `valid` argument.
   * Read-only plain data.
   */
  beltPreviewPlotted(): { color: number; valid: boolean } | null;
  /**
   * THE PLACEMENT GHOST, AS PLOTTED (plan 88-07, BELT-06): the ghost body's rectangle in
   * world px and its fill colour, read back off the ghost `Graphics`' own first fill
   * instruction, and whether that colour is the build accent (`valid`) rather than fault.
   * `null` when the ghost holds nothing. The same reason as {@link beltPreviewPlotted}: a live
   * leg grades the red ghost over a queued Place's cell off the canvas, never off the
   * prediction that chose the colour. Read-only plain data.
   */
  ghostPlotted(): { rect: { x: number; y: number; w: number; h: number }; color: number; valid: boolean } | null;
  /**
   * THE HELD PICTURES (plan 74.1-30, S1R and PAUSE-SECOND-DRAW): the picture of every
   * committed belt the host has not drawn yet, one tile list per belt, on ITS OWN labelled
   * Graphics (`held-belts`), drawn with the preview's lane width, build colour and alpha.
   * Each call replaces every picture on that surface; the gesture layer hands over the
   * whole set each time an entry is added or ends.
   *
   * Its own surface so a new drag and a held picture can both show: the drag preview is
   * the hand's gesture, cleared at the release, and a held picture is a belt already
   * committed, which ends on its DrawBelt's own verdict and the packet that holds the belt
   * (plan 88-06), the playing-tick fallback, or teardown. Render-only: nothing in the scene or
   * on the wire reads it. The CELLS it pictures are a queued claim since plan 88-07, so the
   * editor counts them as taken: a new drag over them is drawn in fault and never sent.
   */
  showHeldBelts(pictures: ReadonlyArray<readonly TileView[]>): void;
  /** Empty the held-picture surface (keyframe, teardown, the last entry ending). */
  clearHeldBelts(): void;
  /**
   * Solid build-blue selection outline + corner ticks spanning the node's full
   * EFFECTIVE box (REND-05), plus the rotate handle at its top-right corner.
   */
  showSelection(id: number): void;
  clearSelection(): void;
  /** Soft hover ring on the cell under the cursor. */
  hoverRing(cell: CellCoord): void;
  clearHover(): void;
  /**
   * Belt-end grab handles at the GIVEN points (positions are computed by
   * gestures via ports.beltHandlePoints; the overlay stays dumb): filled
   * circles r=5 build with a 1.5px void contrast rim (UI-SPEC section 3).
   */
  showBeltHandles(head: { x: number; y: number }, tail: { x: number; y: number }): void;
  clearBeltHandles(): void;
  /**
   * Handle hover ring (UI-SPEC section 3 hover row): ring r=8, stroke 1.5px
   * hoverRing, centered on the hovered endpoint handle (gestures compute the
   * point; the overlay stays dumb).
   */
  showHandleRing(pt: { x: number; y: number }): void;
  clearHandleRing(): void;
  /** The dragged belt-end handle following the cursor, alpha 0.9. */
  showDraggedHandle(pt: { x: number; y: number }): void;
  clearDraggedHandle(): void;
  /**
   * Nub ring (UI-SPEC section 4): passive hover = r=7 stroke 1.5px hoverRing;
   * armed (dockable gesture in flight) = r=7 stroke 2px build.
   */
  showNubRing(pt: { x: number; y: number }, armed: boolean): void;
  clearNubRing(): void;
  /**
   * The RESTING wire affordance (WIRE-05, UI-SPEC 6.2): a ring on EVERY nub the armed
   * Wire tool can reach, painted BEFORE any press. `filled` additionally paints a disc
   * inside the ring, which marks the one nub a press has unambiguously grabbed.
   *
   * This is the discoverability mechanism, not decoration. Until this API the only nub
   * affordance was `showNubRing`, which appears once the pointer is ALREADY inside the
   * hit radius - invisible until you have already succeeded, which is WINDOWS row 113.
   *
   * STATIC BY DESIGN: it appears with the arm, disappears with the disarm, owns no TTL
   * and reads no clock, so `tick` gains no case and `motionFrozen` gains no branch.
   */
  showWireTargets(pts: Array<{ x: number; y: number; filled: boolean }>): void;
  clearWireTargets(): void;
  /**
   * The armed BELT tool's resting dock targets, and the in-flight drop targets of a
   * belt end handle drag (LINK-02 / LINK-10, 74-UI-SPEC 1.2 and 3.1): the SAME ring
   * `showWireTargets` paints, on its own Graphics, driven by the other tool.
   *
   * STATIC BY DESIGN, for the same reason and by the same rule: it appears with the
   * arm, disappears with the disarm, owns no TTL and reads no clock. D-07 - a belt end
   * wears a mark only while the Belt tool is armed or the belt is selected, never at
   * rest - is the paint condition, and it is why the two shipped pixel-guard baselines
   * cannot move.
   */
  showDockTargets(pts: Array<{ x: number; y: number; filled: boolean }>): void;
  clearDockTargets(): void;
  /** Rotate-handle center in world px, or null when no node is selected. */
  rotateHandleCenter(): { x: number; y: number } | null;
  /** Hover styling for the rotate handle (hoverRing stroke + outer ring). */
  setRotateHandleHover(on: boolean): void;
  /**
   * Stranded-dock alert rings (UI-SPEC section 6): r=8 stroke 2px fault at
   * each point; `nowMs` stamps creation for the 1Hz pulse and its settle at
   * `ALERT_SETTLE_MS`. There is NO TTL: a ring lives until the strand is
   * resolved (2026-08-30, see that constant's docblock). App/loop driven for the
   * two SHOW/CLEAR halves (NOT part of the gesture-facing OverlayAffordances);
   * the read-only {@link alertRingsActive} probe below IS, because the
   * CONNECT-02 stranded-ring press must not outlive the paint.
   */
  showAlertRings(pts: Array<{ x: number; y: number }>, nowMs: number): void;
  clearAlertRings(): void;
  /**
   * Retire the alert ring at ONE point, keeping the rest (CONNECT-02, press).
   * Returns whether a ring was actually found and removed (67-REVIEW WR-03) - the
   * caller keys its own bookkeeping off the answer rather than assuming a hit.
   */
  clearAlertRingAt(pt: { x: number; y: number }): boolean;
  /** Are the stranded-dock alert rings currently painted? (CONNECT-02, read-only.) */
  alertRingsActive(): boolean;
  /**
   * The PLOT READ for the same rings (73-14): how many draw instructions the ring
   * `Graphics` is HOLDING right now, straight off `alertRings.context`.
   *
   * `alertRingsActive` above is a CALL LATCH. It answers off `alertBornMs`, which
   * `showAlertRings` stamps whatever the drawing that followed it produced, so a build
   * whose ring geometry plotted nothing passes it - and walk step 5's whole
   * user-visible claim is that exactly ONE belt draws its rings. That claim had no
   * machine instrument at all until this one; it was carried by a human observation on
   * the acceptance walk (WINDOWS 219).
   *
   * A COUNT, not a boolean, and the same shape as `MachineLayer.portNubInstructionsOn`
   * (73-10) for the same reason: "is anything painted" cannot see a ring set that
   * plotted the wrong number of rings, and the UNDO-06 leg's assertion is that the
   * count goes to ZERO on the undo. Read-only: no clock, no setter, no Pixi ref.
   */
  alertRingInstructions(): number;
  /**
   * WHERE the rings are (plan 74.1-27, review WR-06): the centre of every circle the
   * ring `Graphics` has PLOTTED, in world px, read back off its own
   * `context.instructions` (each stroke's path, built into shape primitives, with the
   * primitive's transform applied), never off the point list handed to
   * {@link showAlertRings}.
   *
   * Added because a count cannot see a ring in the wrong place: the walk saw a ring on
   * a still-connected output after `Remove output 1` (N5) while the UNDO-06 leg, which
   * read only {@link alertRingInstructions} > 0, stayed green. A read of the retained
   * points would agree with any drawing function, including one that plots somewhere
   * else, for the reason {@link alertRingInstructions} gives. Read-only: a fresh array
   * of plain numbers, no clock, no setter, no Pixi ref.
   */
  alertRingCentres(): Array<{ x: number; y: number }>;
  /**
   * WHAT THE TARGET RINGS SAY (plan 74.1-33, review round 4 WR-02): every target ring this
   * layer has PLOTTED for a belt gesture, read back off the two Graphics that draw them,
   * never off the point lists handed to the paints.
   *
   *   - `resting`: one entry per ring {@link showDockTargets} plotted, in paint order, with
   *     `filled` true when the disc that marks a grabbed target was plotted at that centre.
   *   - `drop`: the hovered drop ring {@link showNubRing} plotted, or null, with
   *     `accepting` true when it was drawn in the armed (`build`) colour and false when it
   *     was drawn in the passive hover colour, which is how a refused drop reads.
   *
   * Each half is written by its plotting call (the stroke and fill instructions the
   * Graphics holds) and dropped by its clear (`clearDockTargets`, `clearNubRing`), so the
   * read can never report a ring the canvas does not hold. Added because the review found
   * an accepting ring on the very Out a dragged Tail was docked to, and nothing outside a
   * unit stub could see which rings were painted or how. Read-only: fresh plain objects,
   * no clock, no setter, no Pixi ref.
   */
  targetRingsPlotted(): {
    resting: Array<{ x: number; y: number; filled: boolean }>;
    drop: { x: number; y: number; accepting: boolean } | null;
  };
  /**
   * Pending "placing" shimmer (UI-SPEC §5b, IX-05): a NEUTRAL-ink silhouette
   * (2px outline + low fill) fixed at the placed `cell`, pulsing 0.30..0.55 off
   * the `tick(nowMs)` heartbeat while awaiting the host echo. Display-only; it
   * NEVER reads build accent (that would falsely signal committed success) and
   * never writes scene state (SC5). `dims` supplies the rot-0 footprint + rot.
   */
  showPending(cell: CellCoord, dims: { w: number; h: number; rot: number }): void;
  clearPending(): void;
  /**
   * Reject flash (UI-SPEC §5a, IX-05): a one-shot fault fade over the attempted
   * footprint box, fired by an illegal-cell click, that self-clears via the
   * `tick(nowMs)` heartbeat after ~180ms. Display-only, no command, no packet.
   */
  showRejectFlash(cell: CellCoord, dims: { w: number; h: number; rot: number }): void;
  clearRejectFlash(): void;
  /**
   * The PLOT READ for the reject flash - how many geometry instructions its `Graphics`
   * currently holds - and the same shape, for the same stated reason, as
   * {@link alertRingInstructions} above.
   *
   * ADDED BY PLAN 74-05, because LINK-02's browser spec has to pin the two shipped
   * controls a belt end entering the nub hit set is most able to break: a RING-sourced
   * drag released on empty floor must still flash, and a HANDLE drag released on empty
   * floor must still not. Phase 67 measured a regression on exactly that split which
   * the whole 2012-case gesture suite stayed green through, and there was no
   * browser-level instrument for the flash at all - so the only alternative was a spec
   * that asserted the emit half and took the paint half on trust. A count, never a
   * boolean latch: "the flash function was called" is not "anything was painted".
   */
  rejectFlashInstructions(): number;
  /**
   * WHERE the reject flash is PLOTTED, as a cell (phase 89, plan 89-09, D-12, BELT-09): the
   * cell under the centre of the box the flash `Graphics` holds right now, read back off its
   * own fill instruction (the rounded rectangle and its world px bounds), or null when the
   * flash holds no geometry. Not the cell handed to `showRejectFlash`: a stored argument would
   * name a cell over a canvas that drew nothing. It is what lets a live spec grade that one
   * flash names the cell the host will blame (UI-SPEC 6.2), from the side of the app the user
   * sees. Read-only, a fresh object each call.
   */
  rejectFlashCell(): CellCoord | null;
  /**
   * How many reject flashes have been shown since the overlay was made (review fix IN-C-01): a
   * number that rises by one per `showRejectFlash`. Read beside {@link rejectFlashCell}, it tells
   * two back-to-back flashes on ONE cell apart, which the cell alone reads as one. Not a plot read
   * on its own; a latch pairs it with the plotted cell, so a flash that plots nothing never counts.
   */
  rejectFlashSerial(): number;
  /**
   * The PLOT READ for the pending "placing" shimmer (phase 88, plan 88-05, D-10, FAIL-07): how
   * many geometry instructions its `Graphics` holds right now, read-only, the same shape and the
   * same reason as {@link rejectFlashInstructions} beside it. It is what lets a live spec grade
   * that a refused placement shows the red flash ALONE: a model flag would agree with any paint
   * whatsoever, including a shimmer still drawn beside the refusal (WINDOWS 87).
   */
  pendingInstructions(): number;
  /**
   * THE LABEL'S PENDING-SIZE OUTLINE (phase 76, plan 76-03, 76-UI-SPEC 5.4, U-5): while
   * the label panel's width or depth differs from the committed size, the outline of the
   * box the label WOULD have, anchored at its top-left cell (a label grows right and
   * down): the box rectangle (the cell rect inset `CHASSIS_INSET_U` on the centreline, as
   * the label's own box sits), stroked at the label box's width rule (2 world px, never
   * under one screen pixel) at alpha {@link LABEL_RESIZE_ALPHA}, no fill. `fits` picks the
   * colour: `build` when every new cell is on the grid and free, `fault` otherwise; the
   * caller decides it with `ghost.ts` `footprintFits`, the one client prediction. It
   * NEVER moves the box: the board shows the committed size only (U-7).
   */
  showLabelResize(anchor: CellCoord, w: number, h: number, fits: boolean): void;
  clearLabelResize(): void;
  /**
   * What the pending-size outline PLOTTED, read back off the `label-resize-preview`
   * Graphics' own `context.instructions` (the stroke style and the rectangle primitive),
   * never the arguments handed to {@link showLabelResize}; `null` when it holds nothing.
   * Read-only plain data, no Pixi ref (T-14-FABRICO-RO).
   */
  labelResizePreview(): LabelResizeReadback | null;
  /**
   * Per-display-frame heartbeat: alert-ring 1Hz pulse + TTL expiry, pending
   * shimmer 1.5Hz pulse, and the reject-flash one-shot ease-out.
   *
   * `nowMs` is ALWAYS the real wall clock. `motionFrozen` (SAFE-02) gates ONLY
   * the two sinusoid alphas; every elapsed / TTL / decay computation runs on
   * real time in both motion modes. See the `tick` implementation for the bug
   * this split closes.
   */
  tick(nowMs: number, motionFrozen?: boolean): void;
}

/**
 * Every open polyline a Graphics has PLOTTED, read back off its own
 * `context.instructions` (plan 75-05), the polyline counterpart of {@link plottedCircles}:
 * each stroke carries the path it drew, a `moveTo`/`lineTo` run builds into one polygon
 * primitive whose flat `points` are the run's vertices, and each vertex is mapped through
 * the transform the context recorded with it. Fills and every non-polygon primitive are
 * skipped, so a ring or a disc on the same Graphics never reads as a run.
 *
 * EXPORTED for its second user (plan 77-05): `WireLayer.cablePolylines` reads the resting
 * cables with it, so the wire preview and the drawn cable are read back by one function and
 * cannot drift apart.
 */
export { plottedPolylines };

/**
 * @param getScene resolves a node handle → its footprint for `showSelection(id)`
 *                 (the gesture layer passes the handle; the overlay looks up
 *                 the position + effective box).
 */
export function createOverlay(
  getScene: () => SceneState,
  // The live camera zoom (plan 76-03), read FRESH by the label pending-size outline so its
  // stroke keeps the label box's one-screen-pixel floor. Display-only and read-only, the
  // `machines.ts` `scale` parameter's contract; defaulted so every existing caller and
  // test stays valid.
  scale: () => number = () => 1,
): OverlayApi {
  // The ONE locked skin (D-22) — every affordance derives its colours from `pal`,
  // derived once here and fixed for the layer's lifetime.
  const skin: Skin = LOCKED_SKIN;
  const pal: AffordancePalette = deriveAffordancePalette(skin);

  const layer = new Container();
  const ghost = new Graphics();
  // LABELLED (phase 92 review IN-C-04), with `ghostNubs` below: a test finds the ghost by name, so a
  // surface added under it cannot shift the index a scan of the ghost starts from.
  ghost.label = 'ghost';
  // THE GHOST'S PORT NUBS (phase 92, CHROME-18, D-06): drawn by the canvas's own
  // `drawRoleNub`, which fills at alpha 1 and takes no alpha, so they go on their own
  // Graphics whose `.alpha` is the ghost's. A SIBLING added directly above the ghost rather
  // than a child of it: Pixi 8 allows children on Containers only. Labelled, so a spec
  // addresses it by name and no index below it moves.
  const ghostNubs = new Graphics();
  ghostNubs.label = 'ghost-nubs';
  ghostNubs.alpha = GHOST_ALPHA;
  const route = new Graphics();
  const beltPreview = new Graphics();
  // THE HELD PICTURES (74.1-30): committed belts the host has not drawn yet. Labelled for
  // the reason `alertRings` is: a spec addresses it by name, never by index.
  const heldBelts = new Graphics();
  heldBelts.label = 'held-belts';
  const selection = new Graphics();
  const hover = new Graphics();
  const beltHandles = new Graphics();
  const handleRing = new Graphics();
  const draggedHandle = new Graphics();
  const nubRing = new Graphics();
  const wireTargets = new Graphics();
  // ITS OWN GRAPHICS, AND THAT IS THE LOAD-BEARING HALF (74-UI-SPEC 1.2). The wire
  // affordance and the belt-dock affordance are live under DIFFERENT armed tools, so a
  // shared object would let each tool's clear silently wipe the other's rings. The ring
  // SHAPE is shared (`drawTargetRing`); the surface it is plotted on is not.
  const dockTargets = new Graphics();
  // LABELLED (74.1-33), with `nubRing` below, for the reason `alertRings` is: the
  // target-ring read is graded on these two surfaces, and a spec addresses them by name.
  dockTargets.label = 'dock-targets';
  nubRing.label = 'nub-ring';
  const rotateHandle = new Graphics();
  const alertRings = new Graphics();
  // LABELLED (73-14), for the reason the nub Graphics was labelled at 73-10: an
  // unaddressable child is a child no spec ever asserts about, and the stranded-dock
  // ring is the one cue on this layer whose only instrument was a human eye. Named,
  // never indexed - an index assertion silently follows a z-order change.
  alertRings.label = 'alert-rings';
  // IX-05 honest-feedback affordances (30-01). rejectFlash is a one-shot fault
  // fade fired by an illegal-cell click; pending is the neutral-ink "awaiting
  // host echo" shimmer that REPLACES the old optimistic build-blue ghost.
  const rejectFlash = new Graphics();
  const pending = new Graphics();
  // Plan 76-03: the label's pending-size outline, LABELLED so the read-back and a live
  // Pixi devtools tree address it by name.
  const labelResize = new Graphics();
  labelResize.label = 'label-resize-preview';
  // Z-order (UI-SPEC Z-Order contract), bottom to top: hover < alert rings <
  // route < belt preview < HELD BELTS < reject flash < selection < belt handles < handle
  // hover ring < dragged handle < nub ring < WIRE TARGETS < DOCK TARGETS <
  // rotate handle < pending < ghost.
  // Alert rings never occlude an active gesture; the handles/rotate handle sit
  // above the outline they decorate; the ghost stays topmost. Deviation-in-
  // spirit, documented: the hover-class nub ring sits ABOVE the handles because
  // it marks the live drop target; the handle hover ring sits directly above
  // the handle it rings. The pending shimmer sits above hover/selection but
  // BELOW the cursor-following ghost (UI-SPEC §5b); the reject flash decorates
  // the selection slot.
  //
  // `wireTargets` slots DIRECTLY ABOVE `nubRing` (plan 66-06, UI-SPEC 6.2) for the
  // same reason the nub ring sits above the handles: it marks live drop targets, and
  // the board-wide resting set must not be occluded by the handle furniture it
  // overlaps. It stays BELOW the rotate handle and the ghost, which are cursor-owned.
  // The indices this shifts are pinned by name in overlay.test.ts; both this chain and
  // that one moved in the SAME commit, because a prose chain left behind becomes the
  // second source of truth.
  //
  // `dockTargets` (Phase 74, 74-UI-SPEC 1.2 / 3.1) slots DIRECTLY ABOVE `wireTargets`
  // for the same reason and by the same argument: it is the other armed tool's board-
  // wide resting set, it must not be occluded by the handle furniture it overlaps, and
  // it stays below the cursor-owned rotate handle and ghost. The two never paint at the
  // same time - a tool is armed or it is not - so their relative order is a convention
  // rather than a contract, and it is written down here so it stays one. This insertion
  // moved `PENDING_IDX` 12 -> 13 in overlay.test.ts, in this same commit.
  //
  // `heldBelts` (plan 74.1-30) slots DIRECTLY ABOVE `beltPreview`: it is the same kind of
  // picture, the belt the hand let go of, and the two never cover the same cell, so their
  // relative order is a convention. It moved every index above it by one in
  // overlay.test.ts and overlay.plot.test.ts, in this same commit.
  //
  // `labelResize` (plan 76-03) slots DIRECTLY ABOVE `rotateHandle` and below `pending`:
  // it decorates the selected label, so it sits over the selection furniture, and stays
  // under the two "awaiting / where it lands" marks a placing tool owns. A label has no
  // rotate handle, so the two never overlap. It moved `PENDING_IDX` 14 -> 15 in
  // overlay.test.ts, in this same commit; nothing below it moved.
  layer.addChild(
    hover,
    alertRings,
    route,
    beltPreview,
    heldBelts,
    rejectFlash,
    selection,
    beltHandles,
    handleRing,
    draggedHandle,
    nubRing,
    wireTargets,
    dockTargets,
    rotateHandle,
    labelResize,
    pending,
    ghost,
    ghostNubs,
  );

  const cellOriginX = (cx: number): number => cx * CELL;
  const cellOriginY = (cy: number): number => cy * CELL;

  const showGhost = (
    cell: CellCoord,
    valid: boolean,
    dims?: { w: number; h: number; rot: number },
    ports?: GhostPort[],
  ): void => {
    const color = valid ? pal.build : pal.fault;
    // The drawn silhouette spans the effective footprint box (the core dim-swap
    // on odd rot); a 1x1/absent footprint stays the single-cell BODY rect.
    const { ew, eh } = dims
      ? effectiveBox(dims.w, dims.h, dims.rot)
      : { ew: 1, eh: 1 };
    const x = cellOriginX(cell.cx) + INSET;
    const y = cellOriginY(cell.cy) + INSET;
    const w = ew * CELL - 2 * INSET;
    const h = eh * CELL - 2 * INSET;
    ghost.clear();
    ghostNubs.clear();
    ghost.roundRect(x, y, w, h, RADIUS).fill({ color, alpha: GHOST_ALPHA });
    ghost.roundRect(x, y, w, h, RADIUS).stroke({ width: 1.5, color });
    if (ports) {
      // Preview nubs: the canvas's own nubs. Each is placed by the SAME per-cell
      // edge-midpoint + 2.5px push math the placed machine uses (ports.nubAnchor) and
      // drawn by the machine layer's own `drawRoleNub` at the idle state (a ghost is
      // unplaced, so it has no machine state yet): In a disc, Out a disc and its stem,
      // the fault exit a neutral ring around a core, an electrical port a square, every
      // colour from `nubColor`. So the ghost previews exactly what will land, and a fault
      // exit is never red: red on the board is a faulted machine's (CHROME-18, phase 92
      // D-06). The refused-drop body above keeps the fault accent (a refusal, D-07).
      for (const [index, p] of ports.entries()) {
        const a = nubAnchor(cell.cx + p.lx, cell.cy + p.ly, p.side);
        const [nx, ny] = unitDelta(p.side);
        const spec: NubSpec = { x: a.x, y: a.y, nx, ny, side: p.side, role: p.role, medium: p.medium, index };
        drawRoleNub(ghostNubs, spec, state_tag.IDLE, skin);
      }
    }
  };
  const clearGhost = (): void => {
    ghost.clear();
    ghostNubs.clear();
  };

  // THE PREVIEW'S VERTICES COME FROM `cablePoints`, THE SAME BUILDER THE CABLE IS DRAWN
  // WITH (plan 75-05, D-08, 75-UI-SPEC 3.2): cell centres, displaced into the lane through
  // the same `laneOffsetPolyline` at the same `CABLE_LANE_OFFSET`, then clamped onto the
  // two nubs by the same `clampEndToNub`. Nothing in this file decides where an end goes.
  //
  // UNTIL 75-05 THE PREVIEW WAS NOT CLAMPED AT ITS ENDS, and this comment called that
  // deliberate: `showRoute` had no nub concept, so the ghost and the landed cable differed
  // by 16.5 px at each end (WINDOWS row 121). Since a common route is now a two-corner
  // shape, the preview is the only thing telling the user which corridor they will get,
  // and a corridor short at both ends promises a different cable. The nubs are now a
  // required argument; the free end over open floor passes `NO_NUB` and stays on the
  // pointer's cell centre (75-UI-SPEC 3.1).
  //
  // `pairedLegs` (plan 72-11, R-70) carries the OTHER legs of the same gesture. Since
  // 72-08 one `DrawWire` between a Route and a Handler mints TWO cables under one
  // action id, so a drag that previewed one corridor and landed two would be the same
  // promise-the-cable-does-not-keep failure one grain coarser. They are drawn HERE, in
  // one call, rather than by a second `showRoute`: this function CLEARS first, so two
  // calls would leave only the last leg on screen. Each carries its own two nubs.
  //
  // BOTH LEGS GO THROUGH `strokeLeg` AND NOTHING ELSE, and that is what makes "the two
  // ghosts stroke identically" structural instead of a convention. Direction is not a
  // property the user is choosing during the drag: it is a property of the pairing they
  // are making, and marking one leg would invent a decision they are not being asked to
  // take. There is one colour, from the one `valid` flag, for the whole gesture.
  const strokeLeg = (path: CellCoord[], nubs: CableNubs, color: number, lane: number): void => {
    if (path.length < 2) return;
    const pts = cablePoints(
      path.map((c) => ({ cell_x: c.cx, cell_y: c.cy })),
      lane,
      nubs,
    );
    route.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) {
      route.lineTo(pts[i].x, pts[i].y);
    }
    route.stroke({ width: 4, color, alpha: 0.7, cap: 'round', join: 'round' });
  };
  const showRoute = (
    path: CellCoord[],
    nubs: CableNubs,
    valid = true,
    lane = 0,
    pairedLegs: ReadonlyArray<{ path: CellCoord[]; lane: number; nubs: CableNubs }> = [],
  ): void => {
    route.clear();
    const color = valid ? pal.build : pal.fault;
    strokeLeg(path, nubs, color, lane);
    for (const leg of pairedLegs) {
      strokeLeg(leg.path, leg.nubs, color, leg.lane);
    }
  };
  const clearRoute = (): void => {
    route.clear();
  };
  /** The plot read of the route Graphics (75-05). See the interface docblock. */
  const wirePreviewPolylines = (): Array<Array<{ x: number; y: number }>> =>
    plottedPolylines(route);

  // The draw-belt preview reuses the SAME tile/corner primitive the committed
  // belt track draws through (drawBeltTilePath, 14-05), so the build-blue/red
  // preview is structurally identical to the belt that will land (preview==commit,
  // BELT-03). build-blue = legal path, red = route reject OR occupancy overlap.
  //
  // THE ROUTE-REJECT HALF OF THAT SENTENCE HAD NEVER RENDERED, and plan 74-13 makes it
  // true rather than deleting it. The reason it could not is structural: a route reject
  // has no ROUTED TILES to hand over, so `evalBeltPath` called this with an empty list
  // (`gestures.ts:556`, comment `typed reject`) and the layer was asked to paint red
  // with nothing to paint it on. The answer is the retained shape below.
  //
  // THE WIDTH IS THE RECORD'S LANE, not a local number (BELT-08). It reads
  // `2 * BELT_GEOM.laneHalf` because `laneHalf` is a HALF-width: the committed
  // tread spans laneHalf either side of the lane centreline, and this stroke is
  // centred on that same centreline, so the full lane is the only width at which
  // the preview covers the belt that will land.
  //
  // Until the v7.0 milestone audit (2026-08-11) this line was `const PREVIEW_W = 10`
  // - a bare literal that happened to equal `laneHalf`, so the preview drew at HALF
  // the committed 20px lane and an edit to `laneHalf` would have moved the belt and
  // left the preview behind. `shared/geometry.ts` asserted the two "cannot drift on
  // lane width" while nothing in the code or the tests held them together. Binding
  // at `laneHalf` instead would have been byte-identical today and was REJECTED by
  // the maintainer on exactly that ground: it would have frozen a coincidence into the rule
  // "the preview is half the lane", which nobody chose. Widening the preview to 20px
  // is a deliberate visual change and is the point of preview == committed.
  //
  // `overlay.test.ts` ("draw-belt preview lane width") gates this by derivation, so
  // the drift cannot silently reopen.
  const PREVIEW_W = 2 * BELT_GEOM.laneHalf;
  // THE LAST DRAWABLE SHAPE, retained so an illegal path can PAINT (LINK-10, plan
  // 74-13). `evalBeltPath` (`gestures.ts:592-605`) is the single evaluator for both
  // the live preview and the release decision, and its route-reject arm calls
  // `showBeltPreview([], false)` meaning red. The early return below is the correct
  // and only possible response to being handed no geometry, so the defect was never
  // the return: it was that a layer with nothing to draw had nothing to say the
  // refusal WITH.
  //
  // In a drag only SelfCrossing reaches that arm, and since 74-14 that is an
  // INVARIANT THE ACCUMULATOR KEEPS rather than an observation about a shipped
  // predicate: the accumulator's only push carries a manhattan test against the
  // current head (branch d of the per-cell rule in `onWinMove`), so no cell whose
  // distance from the head is not exactly 1 can ever enter `drawnCells` and
  // `NonAdjacent` is unreachable from a drag. The empty call therefore has exactly
  // one live cause - the user has drawn back over their own path - and repainting
  // THE LAST ROUTABLE SHAPE, in fault, says that in their own terms. It is the last
  // routable shape and not "what they drew": since 74-14 a fast sample can advance
  // the path several cells at once, so the retained shape is the path as of the last
  // sample that routed, which is a slightly older thing than the cursor's position.
  //
  // Rejected: synthesising one-cell squares for the raw drawn cells. That would put
  // a second belt-geometry source beside `drawBeltTilePath` and break
  // preview-equals-commit (BELT-03) for the sake of a transient.
  let beltPreviewLast: TileView[] | null = null;
  // THE PLOTTED LIST (74.1-30, CR-01): exactly the tiles the last plotting call handed to
  // `drawBeltTilePath`, set in that same branch and dropped wherever the Graphics is
  // emptied. `beltPreviewKindAt` answers from this and nothing else. It is NOT
  // `beltPreviewLast`, which a typed reject keeps after it plots nothing new, and which
  // is the caller's last routable shape rather than a record of a plot.
  let beltPreviewPlotted: TileView[] | null = null;
  const showBeltPreview = (tiles: TileView[], valid: boolean): void => {
    beltPreview.clear();
    beltPreviewPlotted = null;
    if (tiles.length === 0) {
      // A typed reject repaints the retained shape in fault; an empty-and-VALID call
      // is a genuine clear and still paints nothing.
      if (!valid && beltPreviewLast) {
        drawBeltTilePath(beltPreview, beltPreviewLast, {
          width: PREVIEW_W,
          color: pal.fault,
          alpha: 0.7,
        });
        beltPreviewPlotted = beltPreviewLast;
      }
      return;
    }
    beltPreviewLast = tiles;
    const color = valid ? pal.build : pal.fault;
    drawBeltTilePath(beltPreview, tiles, { width: PREVIEW_W, color, alpha: 0.7 });
    beltPreviewPlotted = tiles;
  };
  const clearBeltPreview = (): void => {
    // The red dies with the gesture. Every site in `gestures.ts` that sets
    // `drawnCells = null` already calls this in the same block, and there are FIVE
    // of them, re-pinned here because the shipped list named two lines that were
    // never among them: `:699` (disarmBelt), `:1040` (armBeltDraw), `:1083`
    // (armWireDraw), `:2915` (the release) and `:3380` (the keyframe). The release
    // arm's own `clearBeltPreview()` is `:3070`. So the retained shape inherits a
    // lifecycle that is already correct at every reset site rather than adding a
    // sixth thing for the gesture controller to remember.
    beltPreviewLast = null;
    beltPreviewPlotted = null;
    beltPreview.clear();
  };
  // The held pictures (74.1-30): every list handed in is plotted, and recorded in the same
  // call, so `beltPreviewKindAt` reads what this surface plotted and nothing else.
  let heldPlotted: TileView[][] = [];
  const showHeldBelts = (pictures: ReadonlyArray<readonly TileView[]>): void => {
    heldBelts.clear();
    heldPlotted = [];
    for (const tiles of pictures) {
      if (tiles.length === 0) {
        continue;
      }
      const list = [...tiles];
      drawBeltTilePath(heldBelts, list, { width: PREVIEW_W, color: pal.build, alpha: 0.7 });
      heldPlotted.push(list);
    }
  };
  const clearHeldBelts = (): void => {
    heldPlotted = [];
    heldBelts.clear();
  };

  // ---- rotate handle (UI-SPEC section 5, D-13 overlay half) ----------------
  let rotateCenter: { x: number; y: number } | null = null;
  let rotateHover = false;

  const drawRotateHandle = (): void => {
    rotateHandle.clear();
    if (!rotateCenter) return;
    const { x, y } = rotateCenter;
    // Disc r=7, dark panel-ramp fill; stroke build (hover ramp step when hovered).
    rotateHandle.circle(x, y, 7).fill({ color: pal.handleFill });
    rotateHandle
      .circle(x, y, 7)
      .stroke({ width: 1.5, color: rotateHover ? pal.hover : pal.build });
    if (rotateHover) {
      rotateHandle.circle(x, y, 9).stroke({ width: 1, color: pal.hover });
    }
    // Glyph: CW arc r=3.5 spanning 270 degrees starting at -90 degrees. In
    // screen space (y down) an increasing canvas angle sweeps clockwise.
    const start = -Math.PI / 2;
    const end = start + Math.PI * 1.5;
    rotateHandle
      .moveTo(x + Math.cos(start) * 3.5, y + Math.sin(start) * 3.5)
      .arc(x, y, 3.5, start, end)
      .stroke({ width: 1.25, color: pal.build });
    // Filled 2.5px triangle arrowhead at the arc end, pointing clockwise
    // (along the CW tangent at the end angle).
    const ex = x + Math.cos(end) * 3.5;
    const ey = y + Math.sin(end) * 3.5;
    const tx = -Math.sin(end);
    const ty = Math.cos(end);
    rotateHandle
      .poly([
        ex + tx * 3.5,
        ey + ty * 3.5,
        ex + Math.cos(end) * 2.5,
        ey + Math.sin(end) * 2.5,
        ex - Math.cos(end) * 2.5,
        ey - Math.sin(end) * 2.5,
      ])
      .fill({ color: pal.build });
  };

  const rotateHandleCenter = (): { x: number; y: number } | null => rotateCenter;

  const setRotateHandleHover = (on: boolean): void => {
    if (rotateHover === on) return;
    rotateHover = on;
    drawRotateHandle();
  };

  // ---- selection (REND-05: effective box, UI-SPEC section 8) ---------------
  // NOTE (plan 56-07): the selected node handle used to be RETAINED here purely so
  // the deleted skin-swap hook could re-run this draw from it. Nothing else ever
  // READ it — `clearSelection` and the not-found branch below only WRITE it — so it
  // went with the hook rather than surviving as write-only state. The live selection
  // affordance is the `selection` / `rotateHandle` Graphics plus `rotateCenter`,
  // which ARE read (rotateHandleCenter / setRotateHandleHover) and are untouched.
  const showSelection = (id: number): void => {
    selection.clear();
    const node = getScene().nodes.get(id);
    if (!node) {
      rotateCenter = null;
      rotateHover = false;
      rotateHandle.clear();
      return;
    }
    // The outline spans the full EFFECTIVE box — the same effectiveBox call
    // showGhost makes (dim-swap on odd rot), so selection tells the truth
    // about footprint size.
    const { ew, eh } = effectiveBox(node.w, node.h, node.rot);
    const x = cellOriginX(node.cell_x) + INSET;
    const y = cellOriginY(node.cell_y) + INSET;
    const w = ew * CELL - 2 * INSET;
    const h = eh * CELL - 2 * INSET;
    // Solid build-accent outline.
    selection.roundRect(x, y, w, h, RADIUS).stroke({ width: 2, color: pal.build });
    // Corner ticks scale with the box: 6px for 1x1, 10px for max(ew,eh) >= 2.
    const t = Math.max(ew, eh) >= 2 ? 10 : 6;
    const corners: Array<[number, number, number, number]> = [
      [x, y, 1, 1],
      [x + w, y, -1, 1],
      [x, y + h, 1, -1],
      [x + w, y + h, -1, -1],
    ];
    for (const [px, py, sx, sy] of corners) {
      selection
        .moveTo(px + sx * t, py)
        .lineTo(px, py)
        .lineTo(px, py + sy * t)
        .stroke({ width: 2, color: pal.build, cap: 'round' });
    }
    // Phase 76 (D-04): a selected LABEL shows NO rotate handle, because a label never
    // turns. With no centre the handle hit test answers false, so it cannot be pressed.
    if (node.kind === machine_kind.LABEL) {
      rotateCenter = null;
      rotateHover = false;
      rotateHandle.clear();
      return;
    }
    // Rotate handle diagonally outside the top-right corner tick.
    rotateCenter = { x: x + w + 6, y: y - 6 };
    rotateHover = false;
    drawRotateHandle();
  };
  const clearSelection = (): void => {
    selection.clear();
    rotateCenter = null;
    rotateHover = false;
    rotateHandle.clear();
  };

  const hoverRing = (cell: CellCoord): void => {
    const x = cellOriginX(cell.cx) + INSET;
    const y = cellOriginY(cell.cy) + INSET;
    hover.clear();
    hover.roundRect(x, y, BODY, BODY, RADIUS).stroke({ width: 1, color: pal.hover });
  };
  const clearHover = (): void => {
    hover.clear();
  };

  // ---- belt-end grab handles (UI-SPEC section 3) ----------------------------
  // Handle primitive: filled circle r=5 build with a 1.5px darkest-ramp contrast
  // rim so it lifts off the track.
  const drawHandle = (g: Graphics, pt: { x: number; y: number }): void => {
    g.circle(pt.x, pt.y, 5).fill({ color: pal.build });
    g.circle(pt.x, pt.y, 5).stroke({ width: 1.5, color: pal.rim });
  };

  const showBeltHandles = (
    head: { x: number; y: number },
    tail: { x: number; y: number },
  ): void => {
    beltHandles.clear();
    drawHandle(beltHandles, head);
    drawHandle(beltHandles, tail);
  };
  const clearBeltHandles = (): void => {
    beltHandles.clear();
  };

  // Handle hover ring (UI-SPEC section 3 hover row): r=8, 1.5px hoverRing.
  const showHandleRing = (pt: { x: number; y: number }): void => {
    handleRing.clear();
    handleRing.circle(pt.x, pt.y, 8).stroke({ width: 1.5, color: pal.hover });
  };
  const clearHandleRing = (): void => {
    handleRing.clear();
  };

  const showDraggedHandle = (pt: { x: number; y: number }): void => {
    draggedHandle.clear();
    draggedHandle.alpha = 0.9;
    drawHandle(draggedHandle, pt);
  };
  const clearDraggedHandle = (): void => {
    draggedHandle.clear();
  };

  // ---- nub ring (UI-SPEC section 4) -----------------------------------------
  const showNubRing = (pt: { x: number; y: number }, armed: boolean): void => {
    nubRing.clear();
    if (armed) {
      nubRing.circle(pt.x, pt.y, 7).stroke({ width: 2, color: pal.build });
    } else {
      nubRing.circle(pt.x, pt.y, 7).stroke({ width: 1.5, color: pal.hover });
    }
  };
  const clearNubRing = (): void => {
    nubRing.clear();
  };

  // ---- resting wire targets (WIRE-05, UI-SPEC 6.2) ---------------------------
  //
  // COLOUR DISCIPLINE, AND IT IS A RULE RATHER THAN A TASTE (style bible 1a).
  // `pal.build` is the reserved accent for a build / ghost / selection AFFORDANCE and
  // is already what the armed nub ring above paints in. The `electric` accent is
  // reserved for wire ENERGY - the nub the machine layer fills and the comet the wire
  // layer animates - and this file does not derive it, deliberately: nothing an overlay
  // paints is energy. So a ring here is always `build`, and it is SHAPE that carries
  // the distinction: a ring is an affordance, a filled square or a moving comet is the
  // thing. Colour only reinforces. Read off `pal`, never a hex literal.
  //
  // The radii mirror `showNubRing` exactly (r 7, stroke 2) so the resting ring and the
  // hover ring are the same object at the same size, and entering the hit radius reads
  // as the pointer arriving rather than as a new shape appearing.
  //
  // THE RING ITSELF, EXTRACTED RATHER THAN COPIED (74-UI-SPEC 1.2). Phase 74 gives the
  // armed BELT tool the same affordance the armed WIRE tool has had since 66-06, and a
  // copied ring is a copied radius - which is precisely what `NUB_RING_R` exists to
  // prevent. One shape, two surfaces, two tools.
  const drawTargetRing = (
    g: Graphics,
    pt: { x: number; y: number },
    filled: boolean,
  ): void => {
    g.circle(pt.x, pt.y, NUB_RING_R).stroke({
      width: NUB_RING_STROKE,
      color: pal.build,
    });
    if (filled) {
      // The ONE nub a press has unambiguously grabbed. At the 66-06 radius two Out
      // nubs one cell apart are both in range at their midpoint; nearest-first
      // ranking resolves that deterministically, and THIS is what makes the
      // resolution visible. An invisible disambiguation would be the worse defect.
      g.circle(pt.x, pt.y, 5).fill({ color: pal.build });
    }
  };

  const showWireTargets = (
    pts: Array<{ x: number; y: number; filled: boolean }>,
  ): void => {
    wireTargets.clear();
    // An empty list paints nothing and throws nothing: on a board with no electrical
    // ports the tool still arms and the cursor still changes, and "nothing here is
    // wireable" is legible precisely because no ring appears.
    for (const p of pts) {
      drawTargetRing(wireTargets, p, p.filled);
    }
  };
  const clearWireTargets = (): void => {
    wireTargets.clear();
  };

  // ---- resting DOCK targets (LINK-02/LINK-10, 74-UI-SPEC 1.2 / 3.1) ---------
  //
  // The armed BELT tool's answer to the same question the wire rings answer: where can
  // this gesture land. Two paint conditions feed it and neither reads a clock:
  //
  //   - the tool is ARMED and nothing is pressed: every FREE belt Head rings, so a user
  //     who armed the Belt tool can see the joins that exist to be made.
  //   - a belt end HANDLE is in flight: every end or port that could accept THAT end
  //     rings, machine ports included - because the claim of this phase is that belt
  //     ends stopped being a special kind of target.
  //
  // D-07 IS THE PAINT CONDITION AND IT IS A DESIGN DECISION: a belt end wears a mark only
  // while the Belt tool is ARMED or the belt is SELECTED. NEVER AT REST. So this owns
  // no TTL, reads no clock, adds no case to `tick` and no branch to `motionFrozen` -
  // exactly as `showWireTargets` above owns none.
  const showDockTargets = (
    pts: Array<{ x: number; y: number; filled: boolean }>,
  ): void => {
    dockTargets.clear();
    // An empty list paints nothing and throws nothing. On a board whose every belt Head
    // is already linked, arming the Belt tool rings NOTHING, and "no join is available
    // here" is legible precisely because no ring appears.
    for (const p of pts) {
      drawTargetRing(dockTargets, p, p.filled);
    }
  };
  const clearDockTargets = (): void => {
    dockTargets.clear();
  };

  // ---- stranded-dock alert rings (UI-SPEC section 6) ------------------------
  let alertBornMs: number | null = null;
  // Retained ring points so `paintAlertRings` can repaint them on an ordinary
  // redraw WITHOUT disturbing the pulse phase / TTL (the alpha is left untouched).
  let alertPts: Array<{ x: number; y: number }> = [];

  const paintAlertRings = (): void => {
    alertRings.clear();
    for (const p of alertPts) {
      alertRings.circle(p.x, p.y, 8).stroke({ width: 2, color: pal.fault });
    }
  };

  const showAlertRings = (pts: Array<{ x: number; y: number }>, nowMs: number): void => {
    alertPts = pts;
    paintAlertRings();
    alertBornMs = pts.length > 0 ? nowMs : null;
    // Seed at the t=0 pulse value; tick(nowMs) animates it from here.
    alertRings.alpha = ALERT_PULSE_FLOOR + ALERT_PULSE_AMP * 0.5;
  };
  const clearAlertRings = (): void => {
    alertPts = [];
    alertRings.clear();
    alertBornMs = null;
    alertRings.alpha = 1;
  };
  /**
   * Retire the alert ring at ONE point, keeping the rest (CONNECT-02).
   *
   * Called when a stranded ring is PRESSED: that ring's job - saying "look
   * here" - is done the instant the user grabs it, and `showDraggedHandle`
   * takes over the point unchanged. Any OTHER stranded ring on screen stays,
   * because a single Rotate can strand more than one belt and the others are
   * still unanswered.
   *
   * Retiring the LAST ring routes through `clearAlertRings`, so the pulse
   * seed, the alpha and `alertBornMs` are reset by the one function that owns
   * them rather than by a second copy of the same three lines. No new Graphics
   * child, no new branch in `tick`, and no new timed surface: this is a repaint
   * of an existing child from a shorter list.
   *
   * # EXACTLY ONE, and the miss is REPORTED (67-REVIEW WR-03)
   * This removes the FIRST point matching `pt`, not every point equal to it. A
   * `filter` retired both rings of a Rotate that stranded two belt ends resolving
   * to the same centre (or a belt end coinciding with a vacated nub point) from a
   * single press, while the caller dropped only the one record it pressed - so the
   * survivor stayed pressable with nothing painted under it.
   *
   * The boolean is the other half. Coordinate equality here is EXACT, and nothing
   * in either module enforces that the gesture layer's ring records and App's
   * painted points are the same `{x,y}` values; today they are only because App
   * hands the same object literal to `showAlertRings` and `setStrandedRings`. A
   * silent `return` on a miss let the caller drop a record whose ring was still on
   * screen - painted but no longer pressable, which is the direction CONNECT-02
   * explicitly rules out. Answering `false` lets the caller stay consistent.
   */
  const clearAlertRingAt = (pt: { x: number; y: number }): boolean => {
    const i = alertPts.findIndex((p) => p.x === pt.x && p.y === pt.y);
    if (i < 0) {
      return false;
    }
    const next = alertPts.slice(0, i).concat(alertPts.slice(i + 1));
    if (next.length === 0) {
      clearAlertRings();
      return true;
    }
    alertPts = next;
    paintAlertRings();
    return true;
  };
  /**
   * Are the stranded-dock alert rings CURRENTLY on screen? (CONNECT-02.)
   *
   * `alertBornMs` is the one place the ring lifetime lives: `showAlertRings`
   * stamps it and `clearAlertRings` nulls it. Since the 2026-08-30 TTL
   * retirement those are the ONLY two writers - `tick` reads the birth stamp to
   * drive the pulse and its settle, and never clears - so this answers FALSE
   * only after a real resolution (a reconnect press retiring the last ring, or
   * a structural edit), never after a timeout. That is what makes it a safe gate
   * for the CONNECT-02 press: the PRESSABLE set is exactly the PAINTED set, and
   * neither expires out from under a user who looked away.
   *
   * Read-only by design: no timer, no branch in `tick`, and no timing constant
   * escapes this module. A gesture ALREADY IN FLIGHT never re-reads it (D-25:
   * a decay must not retroactively invalidate a gesture the user is completing).
   */
  const alertRingsActive = (): boolean => alertBornMs !== null;
  /**
   * The PLOT READ beside the latch above (73-14, WINDOWS 219).
   *
   * Read back off the live `Graphics` rather than derived from `alertPts.length`. A
   * length read would agree with the latch for ANY drawing function whatsoever,
   * including one that draws nothing - the vacuous shape this probe exists to avoid,
   * and the same argument `MachineLayer.loadGaugesPainted` records at its own call
   * site. Deleting the `circle(...).stroke(...)` in `paintAlertRings` takes this to 0
   * with `alertPts`, `alertBornMs` and every model-side stranded assertion untouched.
   */
  const alertRingInstructions = (): number => alertRings.context.instructions.length;
  /**
   * The plotted ring centres (74.1-27). See the interface docblock. Walks the Graphics'
   * own instructions: each stroke or fill carries the path it drew, the path builds into
   * shape primitives, and a circle primitive's centre is mapped through the transform the
   * context recorded with it. Nothing here touches `alertPts`.
   */
  const alertRingCentres = (): Array<{ x: number; y: number }> =>
    plottedCircles(alertRings).map((c) => ({ x: c.x, y: c.y }));
  /**
   * The target rings as plotted (74.1-33). See the interface docblock. Reads the
   * `dockTargets` and `nubRing` Graphics through {@link plottedCircles}, the walk the ring
   * centres above use: a STROKED circle is a ring, a FILLED circle at the same centre is the
   * grabbed-target disc, and the drop ring's stroke colour says which way it was drawn
   * (`pal.build` armed, anything else passive). Nothing here reads the point lists.
   */
  const targetRingsPlotted = (): {
    resting: Array<{ x: number; y: number; filled: boolean }>;
    drop: { x: number; y: number; accepting: boolean } | null;
  } => {
    const dock = plottedCircles(dockTargets);
    const discs = dock.filter((c) => c.action === 'fill');
    const resting = dock
      .filter((c) => c.action === 'stroke')
      .map((c) => ({
        x: c.x,
        y: c.y,
        filled: discs.some((d) => d.x === c.x && d.y === c.y),
      }));
    const ring = plottedCircles(nubRing).find((c) => c.action === 'stroke');
    const drop = ring ? { x: ring.x, y: ring.y, accepting: ring.color === pal.build } : null;
    return { resting, drop };
  };
  /** The same plot read for the draw-belt preview (74.1-26). See the interface docblock. */
  const beltPreviewInstructions = (): number =>
    beltPreview.context.instructions.length + heldBelts.context.instructions.length;
  /**
   * The plotted kind at one cell (74.1-30). See the interface docblock. Answers from the
   * two plotted records only (`beltPreviewPlotted`, then `heldPlotted`), a fresh copy of
   * the kind so no caller holds the record.
   */
  const beltPreviewKindAt = (cellX: number, cellY: number): TileKindView | null => {
    const at = (list: readonly TileView[] | null) => list?.find((x) => x.cell_x === cellX && x.cell_y === cellY);
    let t = at(beltPreviewPlotted);
    for (const list of heldPlotted) {
      if (t) {
        break;
      }
      t = at(list);
    }
    return t ? (JSON.parse(JSON.stringify(t.kind)) as TileKindView) : null;
  };
  /** The drag preview's plotted colour (88-07). See the interface docblock. */
  const readBeltPreviewPlotted = (): { color: number; valid: boolean } | null => {
    const stroke = plottedInstructions(beltPreview).find((ins) => ins.action === 'stroke');
    return stroke ? { color: stroke.color, valid: stroke.color === pal.build } : null;
  };
  /** The ghost's plotted body and colour (88-07). See the interface docblock. */
  const ghostPlotted = (): {
    rect: { x: number; y: number; w: number; h: number };
    color: number;
    valid: boolean;
  } | null => {
    const body = plottedFilledRects(ghost)[0];
    if (!body) return null;
    return { rect: { x: body.x, y: body.y, w: body.w, h: body.h }, color: body.color, valid: body.color === pal.build };
  };
  /** The same plot read for the reject flash (74-05). See the interface docblock. */
  const rejectFlashInstructions = (): number => rejectFlash.context.instructions.length;
  /** Where the reject flash is plotted (89-09). See the interface docblock. */
  const rejectFlashCell = (): CellCoord | null => {
    const box = plottedFilledRects(rejectFlash)[0];
    if (!box) return null;
    return { cx: Math.floor((box.x + box.w / 2) / CELL), cy: Math.floor((box.y + box.h / 2) / CELL) };
  };
  /** The same plot read for the pending shimmer (88-05). See the interface docblock. */
  const pendingInstructions = (): number => pending.context.instructions.length;

  // ---- pending "placing" shimmer (UI-SPEC §5b, IX-05) -----------------------
  // The neutral-ink placeholder that marks a legally-placed cell while awaiting
  // the host echo. It REPLACES the old optimistic build-blue ghost (the removed
  // false-success cue): the shimmer is NEVER build accent, is low-fill + pulsing
  // + fixed at the placed cell, so it reads as neither the cursor-attached ghost
  // nor a committed (opaque, glyphed) machine (the three-way legibility contract).
  let pendingBox: { cell: CellCoord; ew: number; eh: number } | null = null;

  const paintPending = (): void => {
    pending.clear();
    if (!pendingBox) return;
    // Same effectiveBox rect + INSET/RADIUS geometry as showGhost/showSelection.
    const x = cellOriginX(pendingBox.cell.cx) + INSET;
    const y = cellOriginY(pendingBox.cell.cy) + INSET;
    const w = pendingBox.ew * CELL - 2 * INSET;
    const h = pendingBox.eh * CELL - 2 * INSET;
    // Neutral ramp read (pal.nubNeutral), NEVER pal.build. The whole-Graphics
    // alpha (pending.alpha) carries the 0.30..0.55 pulse; the fill sits under it
    // at a low fixed fraction so the silhouette reads as a faint pulsing outline.
    pending.roundRect(x, y, w, h, RADIUS).fill({ color: pal.nubNeutral, alpha: PENDING_FILL_ALPHA });
    pending.roundRect(x, y, w, h, RADIUS).stroke({ width: 2, color: pal.nubNeutral });
  };

  const showPending = (cell: CellCoord, dims: { w: number; h: number; rot: number }): void => {
    const { ew, eh } = effectiveBox(dims.w, dims.h, dims.rot);
    pendingBox = { cell, ew, eh };
    paintPending();
    // Seed at the t=0 pulse value; tick(nowMs) animates it from here.
    pending.alpha = PENDING_FLOOR + PENDING_AMP * 0.5;
  };
  const clearPending = (): void => {
    pendingBox = null;
    pending.clear();
    pending.alpha = 1;
  };

  // ---- the label's pending-size outline (plan 76-03, 76-UI-SPEC 5.4) ---------
  let resizeBox: { anchor: CellCoord; w: number; h: number; fits: boolean } | null = null;
  // The stroke width the outline was last plotted at, so `tick` re-strokes it when the
  // zoom moves the one-screen-pixel floor and at no other time.
  let resizeWidth = 0;
  const paintLabelResize = (): void => {
    labelResize.clear();
    resizeWidth = 0;
    if (!resizeBox) return;
    const inset = uToPx(CHASSIS_INSET_U);
    const width = labelStrokeWidth(skin, scale());
    labelResize
      .rect(
        cellOriginX(resizeBox.anchor.cx) + inset,
        cellOriginY(resizeBox.anchor.cy) + inset,
        resizeBox.w * CELL - 2 * inset,
        resizeBox.h * CELL - 2 * inset,
      )
      .stroke({
        width,
        color: resizeBox.fits ? pal.build : pal.fault,
        alpha: LABEL_RESIZE_ALPHA,
      });
    resizeWidth = width;
  };
  const showLabelResize = (anchor: CellCoord, w: number, h: number, fits: boolean): void => {
    resizeBox = { anchor, w, h, fits };
    paintLabelResize();
  };
  const clearLabelResize = (): void => {
    resizeBox = null;
    paintLabelResize();
  };
  const labelResizePreview = (): LabelResizeReadback | null => {
    const ins = labelResize.context.instructions;
    if (ins.length === 0) return null;
    let stroke: LabelResizeReadback['stroke'] = null;
    let rect: LabelResizeReadback['rect'] = null;
    let filled = false;
    for (const i of ins) {
      if (i.action === 'fill') filled = true;
      if (i.action !== 'stroke') continue;
      const data = i.data as {
        style?: { color?: number; alpha?: number; width?: number };
        path?: { shapePath: { shapePrimitives: unknown[] } };
      };
      if (stroke === null) {
        stroke = {
          color: data.style?.color ?? -1,
          alpha: data.style?.alpha ?? -1,
          width: data.style?.width ?? -1,
        };
      }
      if (rect === null && data.path) {
        for (const prim of data.path.shapePath.shapePrimitives as Array<{
          shape: { type: string; x: number; y: number; width: number; height: number };
        }>) {
          if (prim.shape.type !== 'rectangle') continue;
          rect = { x: prim.shape.x, y: prim.shape.y, w: prim.shape.width, h: prim.shape.height };
          break;
        }
      }
    }
    return { instructions: ins.length, stroke, rect, filled };
  };

  // ---- reject flash (UI-SPEC §5a, IX-05) ------------------------------------
  // A single one-shot fault fade fired by an illegal-cell click: fill 0.7→0 +
  // 2px fault stroke 1.0→0, ease-out over REJECT_MS, then self-clears. Birth is
  // stamped on the FIRST tick after showRejectFlash (no nowMs param on show), so
  // it rides the same wall clock as the pulses.
  let rejectBox: { cell: CellCoord; ew: number; eh: number } | null = null;
  let rejectBornMs: number | null = null;
  let rejectSerial = 0;

  const paintRejectFlash = (k: number): void => {
    rejectFlash.clear();
    if (!rejectBox) return;
    const x = cellOriginX(rejectBox.cell.cx) + INSET;
    const y = cellOriginY(rejectBox.cell.cy) + INSET;
    const w = rejectBox.ew * CELL - 2 * INSET;
    const h = rejectBox.eh * CELL - 2 * INSET;
    rejectFlash.roundRect(x, y, w, h, RADIUS).fill({ color: pal.fault, alpha: 0.7 });
    rejectFlash.roundRect(x, y, w, h, RADIUS).stroke({ width: 2, color: pal.fault });
    // k in [0,1] carries the ease-out as a single observable Graphics alpha.
    rejectFlash.alpha = k;
  };

  const showRejectFlash = (
    cell: CellCoord,
    dims: { w: number; h: number; rot: number },
  ): void => {
    const { ew, eh } = effectiveBox(dims.w, dims.h, dims.rot);
    rejectBox = { cell, ew, eh };
    rejectBornMs = null; // unstamped; the first tick stamps the wall-clock birth
    rejectSerial += 1;
    paintRejectFlash(1); // seed full
  };
  const clearRejectFlash = (): void => {
    rejectBox = null;
    rejectBornMs = null;
    rejectFlash.clear();
    // Cleared sentinel 0 (fully faded) — distinct from any live decay (> 0).
    rejectFlash.alpha = 0;
  };

  /**
   * Per-display-frame heartbeat, on a SPLIT clock (SAFE-02, D-25).
   *
   * `nowMs` is ALWAYS the real wall clock: every elapsed, TTL and decay
   * computation below runs on real time regardless of the motion mode.
   * `motionFrozen` gates ONLY the two sinusoid alphas, each holding the
   * mid-band value its own show-function already seeds.
   *
   * That split is the fix for a shipped bug. Before Phase 64 the render loop
   * implemented `prefers-reduced-motion` by feeding this function a CONSTANT
   * captured at pin time, which made the reject flash's elapsed value
   * identically zero (a permanent red box on the canvas, never decaying, never
   * clearing) and made the alert TTL's elapsed value NEGATIVE, because App.tsx
   * stamps `alertBornMs` from a live `performance.now()` (rings retained for
   * the life of the session). A boolean is used rather than a frozen timestamp
   * for exactly that reason: a frozen number compared against a live-stamped
   * birth re-imports the same live-versus-frozen mismatch.
   */
  const tick = (nowMs: number, motionFrozen = false): void => {
    // Alert-ring 1Hz pulse, settling to a calm steady alpha at ALERT_SETTLE_MS.
    // It NEVER clears here: the ring outlives every clock and ends only when the
    // strand is resolved (see ALERT_SETTLE_MS's docblock).
    if (alertBornMs !== null) {
      const elapsedMs = nowMs - alertBornMs;
      if (elapsedMs >= ALERT_SETTLE_AT_MS) {
        alertRings.alpha = ALERT_SETTLED_ALPHA;
      } else {
        // 1Hz pulse, gentler floor than the machine fault pulse: t in seconds.
        const t = elapsedMs / 1000;
        alertRings.alpha = motionFrozen
          ? ALERT_SETTLED_ALPHA
          : ALERT_PULSE_FLOOR + ALERT_PULSE_AMP * (0.5 + 0.5 * Math.sin(2 * Math.PI * t));
      }
    }
    // Pending shimmer: 1.5Hz neutral pulse in the 0.30..0.55 band. Wall-clock
    // driven (nowMs), so it keeps pulsing even while the sim is paused.
    if (pendingBox) {
      const t = nowMs / 1000;
      pending.alpha = motionFrozen
        ? PENDING_FLOOR + PENDING_AMP * 0.5
        : PENDING_FLOOR + PENDING_AMP * (0.5 + 0.5 * Math.sin(2 * Math.PI * PENDING_HZ * t));
    }
    // The label's pending-size outline keeps the box's one-screen-pixel floor across a
    // zoom: re-stroked only when the floor moves the width.
    if (resizeBox && labelStrokeWidth(skin, scale()) !== resizeWidth) paintLabelResize();
    // Reject flash: one-shot fault ease-out over REJECT_MS, then auto-clear.
    if (rejectBox) {
      if (rejectBornMs === null) rejectBornMs = nowMs;
      const e = nowMs - rejectBornMs;
      if (e >= REJECT_MS) {
        clearRejectFlash();
      } else {
        paintRejectFlash(1 - e / REJECT_MS);
      }
    }
  };

  return {
    layer,
    showGhost,
    clearGhost,
    showRoute,
    clearRoute,
    wirePreviewPolylines,
    showBeltPreview,
    clearBeltPreview,
    beltPreviewInstructions,
    beltPreviewKindAt,
    beltPreviewPlotted: readBeltPreviewPlotted,
    ghostPlotted,
    showHeldBelts,
    clearHeldBelts,
    showSelection,
    clearSelection,
    hoverRing,
    clearHover,
    showBeltHandles,
    clearBeltHandles,
    showHandleRing,
    clearHandleRing,
    showDraggedHandle,
    clearDraggedHandle,
    showNubRing,
    clearNubRing,
    showWireTargets,
    clearWireTargets,
    showDockTargets,
    clearDockTargets,
    rejectFlashInstructions,
    rejectFlashCell,
    rejectFlashSerial: () => rejectSerial,
    pendingInstructions,
    rotateHandleCenter,
    setRotateHandleHover,
    showAlertRings,
    clearAlertRings,
    clearAlertRingAt,
    alertRingsActive,
    alertRingInstructions,
    alertRingCentres,
    targetRingsPlotted,
    showPending,
    clearPending,
    showLabelResize,
    clearLabelResize,
    labelResizePreview,
    showRejectFlash,
    clearRejectFlash,
    tick,
  };
}
