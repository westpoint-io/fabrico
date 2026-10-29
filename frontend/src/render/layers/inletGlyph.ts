// The endpoint inlet TERMINAL glyph (FEEL-04, phase 46). This module is THE single
// geometry source for the asymmetric endpoint wire terminal: the wires layer stamps
// these rects on canvas and the Legend's Route row (in the kinds group since phase 92,
// CHROME-12) mirrors the SAME rects into an inline SVG, so the two cannot drift (the D-02 legend==canvas-by-construction
// dependency). It formally overturns the Phase-43 "no new canvas sprite/marker"
// decision (D-03): the maintainer's live-FEEL finding F5 (at rest the wire is symmetric and
// unreadable) was the designated revisit trigger.
//
// Pure geometry, ZERO pixi.js/DOM imports (the ports.ts discipline): inputs are the
// outward unit normal of the docked port, output is a list of integer axis-aligned
// rects in a nub-local frame centred on the snapped nub centre. Shape, not colour,
// is the differentiator (greyscale-safe): callers fill every rect with the same
// electric accent the plain handler square uses.

import type { Rect } from '../synth/types';
import { PORT_ROLE } from '../../protocol/ports';

/**
 * Glyph half-extent: the inlet glyph spans [-INLET_HALF, INLET_HALF] on both axes
 * (14px vs the handler's 10px plain square; SIZE is the third asymmetry cue, D-05).
 * The mirrored chevron stays well inside it: it spans u in [-2, 2] either way.
 */
export const INLET_HALF = 7;

// The canonical orientation: outward normal (nx, ny) = (1, 0), an EAST-facing port.
// The socket mouth opens toward +x (the cable side); the chevron apex points toward
// -x, INTO the endpoint square (request-in, D-01).
//
// Socket: an open-mouth "C" of three rects (3px wall, 8px mouth aperture).
// Chevron: a "<" of three 2x2 stair rects inside the mouth, apex at -x.
const CANONICAL_EAST: readonly Rect[] = [
  { x: -7, y: -7, w: 3, h: 14 }, // socket back wall
  { x: -4, y: -7, w: 11, h: 3 }, // socket top arm
  { x: -4, y: 4, w: 11, h: 3 }, // socket bottom arm
  { x: -2, y: -1, w: 2, h: 2 }, // chevron apex (points INTO the endpoint)
  { x: 0, y: -3, w: 2, h: 2 }, // chevron upper arm
  { x: 0, y: 1, w: 2, h: 2 }, // chevron lower arm
];

/** How many of {@link CANONICAL_EAST}'s leading rects are the SOCKET, not the chevron. */
const SOCKET_RECTS = 3;

/**
 * The 6 inlet-glyph rects oriented for an outward unit normal `(nx, ny)` (one of
 * the four cardinals, = `unitDelta(port.side)`), with the CHEVRON mirrored for a
 * `Role::Out` terminal. Each canonical rect corner (u, v) maps to
 * (u*nx - v*ny, u*ny + v*nx); axis-aligned rects stay axis-aligned under
 * 90-degree rotations, so each result is re-normalized to min-corner + positive
 * w/h. Coordinates are integer offsets from the snapped nub centre.
 *
 * WHY THE CHEVRON MIRRORS, AND WHY IT ONLY STARTED MATTERING NOW (72-09 R-60,
 * UI-SPEC 5.4). `wires.ts` stamps this glyph whenever the DOCKED NODE is a Route, with
 * no reference to the port's ROLE, and the glyph is asymmetric on purpose: its chevron
 * apex points INTO the Route, meaning "request in".
 *
 * Under D-04 BOTH cables now terminate at the Route. So the FORWARD cable's glyph sits
 * on the Route's **Out** nub, with an arrow pointing inward at the very port the request
 * is LEAVING FROM - a shape telling the user the opposite of what happens. Today that
 * ships only on the genesis demo board; after this phase EVERY user-built route grows
 * one, which is what turns a one-board oddity into the vocabulary.
 *
 * The contract: the three CHEVRON rects mirror in the outward-normal axis for a
 * `Role::Out` terminal, so the arrow points along the direction traffic actually travels
 * at that nub. The three SOCKET rects DO NOT MOVE, so the socket mouth keeps facing the
 * cable in both cases - the socket says "a cable lands here", which is true at either
 * role, and only the arrow carries direction.
 *
 * An unknown role byte is not `Role::Out`, so it draws the request-in chevron. The role
 * keyspace is open on the wire and this must not throw (`ports.ts PORT_ROLE`).
 *
 * # THE MIRROR ALONE DID NOT READ, AND THE PRONG STEM IS WHY (the maintainer's ruling, 2026-09-03)
 * R-60's contract above is implemented exactly as written and every geometric property
 * of it is asserted. It is still not the whole story, and the missing half is NOT in
 * this module: `wires.ts` draws a 2px PRONG STEM along the outward normal from
 * `u = -NUB_HALF` to `u = 0` at every terminal. The IN chevron's apex sits at
 * `u in [-2, 0)` ON that stem with its arms flaring clear at `u in [0, 2)`, so it reads
 * as a notch. MIRRORED, the arms land at `u in [-2, 0)`, inside the stem's run: arms
 * and stem stack into a solid 2x6 bar and the shape reads as a PLUS at 1x, not as ">".
 *
 * The maintainer ruled on 2026-09-03 (candidate 2 of the three costed in `72-09-SUMMARY.md`) that
 * the STEM is suppressed on a glyph-stamping `Role::Out` terminal, which deliberately
 * overrides R-60 / 72-UI-SPEC 5.4. **THE RECTS IN THIS MODULE DID NOT MOVE**, and that
 * is the point of recording the ruling here rather than only at the `wires.ts` site: a
 * reader who finds the fusion described in `72-09-SUMMARY.md` and comes looking for a
 * geometry fix in this file will find none, because the fix is the stem's absence.
 */
export function inletGlyphRects(nx: number, ny: number, role: number): Rect[] {
  const mirror = role === PORT_ROLE.OUT;
  return CANONICAL_EAST.map((r, i) => {
    // Mirror the chevron in u about the nub centre BEFORE the rotation: apex
    // u in [-2,0] becomes [0,2] and the arms swap the other way, turning "<" into ">".
    // Done here rather than after so the four cardinal orientations get it for free.
    if (mirror && i >= SOCKET_RECTS) {
      r = { x: -(r.x + r.w), y: r.y, w: r.w, h: r.h };
    }
    // Transform two opposite corners, then re-normalize to min-corner + size.
    const ax = r.x * nx - r.y * ny;
    const ay = r.x * ny + r.y * nx;
    const bx = (r.x + r.w) * nx - (r.y + r.h) * ny;
    const by = (r.x + r.w) * ny + (r.y + r.h) * nx;
    return {
      x: Math.min(ax, bx),
      y: Math.min(ay, by),
      w: Math.abs(bx - ax),
      h: Math.abs(by - ay),
    };
  });
}
