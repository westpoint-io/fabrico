// PortIndicator.tsx (PANEL-04) - the panel-side echo of the on-canvas port nub.
//
// The config panel's I/O rows must be readable as the SAME vocabulary the grid
// speaks, so this glyph reproduces `render/layers/machines.ts drawRoleNub`
// (:83-106) shape-for-shape at panel scale:
//
//   role 0 (In)    plain filled body
//   role 1 (Out)   the same body + outward stem  (NUB_R -> NUB_STEM along the normal)
//   role 2 (Fault) a SMALL core inside a ring at a LARGER radius - an annulus,
//                  the heaviest "danger exit"
//
// MEDIUM IS THE SECOND AXIS IT NOW MIRRORS (UI-SPEC 1.2, plan 72-09). `drawRoleNub`
// draws an ELECTRICAL port's body as a SQUARE of side `2 * NUB_ELECTRICAL_HALF` where
// a mechanical port draws a disc, and this reproduces that too. It is not decoration:
// without it an unwired Handler's ports read identically to a Factory's, and the panel
// row beside one would say something different from the canvas.
//
// THE TWO SIDES ARE CHECKED SEPARATELY, and that is the whole reason this component
// exists (72-09 R-56). The defect it prevents is the PANEL AND THE CANVAS DISAGREEING,
// and a single test on either side alone cannot see a disagreement. So
// `PortIndicator.test.tsx` and `render/layers/machines.test.ts` each assert the
// silhouette independently, and BOTH read the shipped constants rather than a mirrored
// literal.
//
// An unknown or absent medium byte draws the MECHANICAL disc and never throws, exactly
// as an unknown role byte draws the In disc. Both keyspaces are open on the wire.
//
// The numbers are IMPORTED from `protocol/ports.ts`, not restated here. They used
// to be local literals "verbatim from drawRoleNub", and a comment is not a
// constraint: the role-2 shape was a stroke on the SAME radius as its own fill in
// the SAME colour, which composites into a marginally fatter disc rather than a
// ring. At 12px that made Fault and In the same silhouette, half a device pixel
// apart (51-UI-REVIEW fix 3 - reasoning on the constants).
//
// The SILHOUETTE is the load-bearing role cue, exactly as on the canvas: colour
// is only ever reinforcement (the project SAFE rule), and the geometry is
// IDENTICAL in all three flow states - a dimming fill must never make a shape
// disappear (the role-2 invariant machines.test.ts pins, RENDER-04).
//
// The glyph is decorative: it is `aria-hidden`, because the row's own text
// already names the role ("Output - Item") and the flow as a state word ("moving",
// "backed up"; no item count since plan 91-07, CHROME-13). A screen
// reader loses nothing by skipping it.
//
// Colour comes from `currentColor` - the CALLER sets `color` on the wrapper from
// the three-step flow tint (`--fab-outline` / `--fab-ink` / `--fab-accent-item`).
// Keeping the fill indirect is what lets one component serve all three states
// without ever naming a token (let alone a hex) of its own.

import type { JSX } from 'react';
import {
  MEDIUM_ELECTRICAL,
  NUB_ELECTRICAL_HALF,
  NUB_FAULT_CORE_R,
  NUB_FAULT_RING_R,
  NUB_R,
  NUB_STEM,
  NUB_STROKE,
} from '../protocol/ports.ts';

/** Core role bytes (state.rs:703): In=0, Out=1, Fault=2. */
const ROLE_OUT = 1;
const ROLE_FAULT = 2;

/**
 * The glyph viewBox. 13 units so ALL the widest silhouettes land inside it
 * rather than being clipped: the role-1 stem reaches `NUB_STEM` (6.5) from the
 * centre, exactly the edge, the role-2 ring's outer edge reaches
 * `NUB_FAULT_RING_R + NUB_STROKE / 2` (5.625), and the electrical square's corner
 * reaches `NUB_ELECTRICAL_HALF` (5) on each axis - all comfortably inside it. Rendered
 * at the 12px box the 51-UI-SPEC fixes (assumption A2, matching
 * `--fab-font-size-hud` / the Legend glyph).
 */
const VIEW = 13;
const C = VIEW / 2;
/**
 * The viewBox side in units, exported so a caller that wants the silhouette at ONE PIXEL PER UNIT
 * (the canvas's own nub radii, 1:1) can ask for exactly this many pixels: the Legend's Ports
 * swatches do (phase 92, D-04, RESEARCH Finding K).
 */
export const PORT_INDICATOR_VIEW_U = VIEW;
/** The default rendered box (px) - a glyph, not a hit target (the 44px rule is for buttons). */
export const PORT_INDICATOR_PX = 12;

export interface PortIndicatorProps {
  /** The port's role byte. Anything other than 1/2 draws the plain In circle -
   *  the role keyspace is open on the wire, so an unknown byte must still draw. */
  role: number;
  /**
   * The port's transport medium byte (`MEDIUM_MECHANICAL` 0 / `MEDIUM_ELECTRICAL` 1).
   * OPTIONAL: the medium keyspace is open on the wire exactly as the role keyspace is,
   * and an absent or unknown byte draws the MECHANICAL disc rather than nothing -
   * matching `portLabels.ts`, which already reads an unknown medium as `Item`.
   */
  medium?: number;
  /**
   * The rendered box in px, OPTIONAL, default {@link PORT_INDICATOR_PX} (12, the inspector's I/O
   * rows). The geometry never changes with it: the box scales the same 13-unit viewBox. The Legend
   * passes {@link PORT_INDICATOR_VIEW_U} (13) so its swatches show the nub at the canvas's size
   * (phase 92, D-04); a third copy of the silhouettes is the drift this module exists to prevent.
   */
  px?: number;
}

/**
 * One role-silhouette glyph (12px unless `px` says otherwise), filled with `currentColor`. Pure,
 * no hooks, no tokens of its own.
 */
export function PortIndicator({ role, medium, px = PORT_INDICATOR_PX }: PortIndicatorProps): JSX.Element {
  // The MEDIUM axis, on the BODY of roles 0 and 1 only: role 2's annulus is a ROLE cue
  // and stays an annulus at every medium, exactly as it does on the canvas.
  const electrical = medium === MEDIUM_ELECTRICAL && role !== ROLE_FAULT;
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width={px}
      height={px}
      viewBox={`0 0 ${VIEW} ${VIEW}`}
      style={{
        // `imageRendering: 'pixelated'` WAS HERE and is deleted by plan 59-03.
        // 59-UI-SPEC's retirement table lists this module as KEPT because it is
        // "still a baked matrix" - MEASURED, it is not: this is an inline <svg> of
        // a <circle> and two <rect>s, with no raster anywhere, so the hint was inert
        // and read as intent. `shapeRendering` is what does the work here.
        // CORRECTED IN PLACE BY PLAN 91-10 (CHROME-20, D-16, UI-SPEC 7.1): this opened "The
        // skin is a pixel-art skin: soften nothing (the Legend glyph idiom)" over
        // `crispEdges`. At the user's 1.18 text scale a snapped disc is a lumpy polygon whose
        // shape depends on its sub-pixel phase; `geometricPrecision` draws the same disc in
        // every row, as every other chrome icon now does.
        shapeRendering: 'geometricPrecision',
        display: 'block',
        flexShrink: 0,
      }}
    >
      {/* The BODY. An ELECTRICAL port is a SQUARE where a mechanical one is a disc -
          the same 10-unit square the canvas draws, at the same half-extent, read from
          the same shipped constant so the panel and the grid move together or not at
          all. Role 2 shrinks its core so the ring around it has somewhere to be:
          a same-radius fill would swallow the ring and hand Fault the In disc. */}
      {electrical ? (
        <rect
          x={C - NUB_ELECTRICAL_HALF}
          y={C - NUB_ELECTRICAL_HALF}
          width={NUB_ELECTRICAL_HALF * 2}
          height={NUB_ELECTRICAL_HALF * 2}
          fill="currentColor"
        />
      ) : (
        <circle
          cx={C}
          cy={C}
          r={role === ROLE_FAULT ? NUB_FAULT_CORE_R : NUB_R}
          fill="currentColor"
        />
      )}
      {role === ROLE_OUT && (
        // The outward stem. On the canvas it follows the port's side normal;
        // in a list there is no side, so it points along the reading direction
        // (right) - the "something leaves here" silhouette is preserved.
        <line
          x1={C + NUB_R}
          y1={C}
          x2={C + NUB_STEM}
          y2={C}
          stroke="currentColor"
          strokeWidth={NUB_STROKE}
        />
      )}
      {role === ROLE_FAULT && (
        // The ring, OUTSIDE the core with clear substrate between the two, so
        // the fault exit is a genuinely different shape from the In disc rather
        // than a marginally fatter one - and still the heaviest of the three.
        <circle
          cx={C}
          cy={C}
          r={NUB_FAULT_RING_R}
          fill="none"
          stroke="currentColor"
          strokeWidth={NUB_STROKE}
        />
      )}
    </svg>
  );
}
