// Legend.tsx - the collapsible machine legend panel (READ-01).
//
// A `.fab-panel` key, toggled from the Toolbar `Legend` button (App owns the
// `legendOpen` state and conditionally mounts this; the button carries
// `aria-expanded` + `aria-controls` pointing at this panel's id). CLOSED by
// default (zero permanent screen cost).
//
// DOCK (52-06, WINDOWS id 2). This panel used to be a bottom-LEFT column, on the
// claim that it "floats clear of the vertically-centred Palette". Measurement
// disproved that claim: with the Legend open, `document.elementFromPoint` at each
// palette tool's own centre returned a Legend element for 6 of 9 tools at
// 1280x800 and 7 of 9 at 1280x720, Belt among them. The tool the app tells a
// newcomer to click was silently unclickable in the exact state the app tells the
// same newcomer to enter.
//
// So it is now a horizontal wrapping STRIP along the bottom edge, beginning to
// the RIGHT of the Palette column and stopping short of the leftmost RIGHT-DOCKED
// surface. Rows lay out horizontally instead of stacking, so the left column is
// never shared at any window height BY CONSTRUCTION rather than by a computed cap.
//
// BOTH bounds are MEASURED and told in (`paletteRightPx`, `cornerInsetPx`), never
// written as literals here: the Palette is `width: fit-content` and already grew
// once this phase (153 to 174px when the R0 badge landed), so a literal inset
// would drift back into the collision it replaces and the "by construction" claim
// would become a claim about luck.
//
// The right-hand reserve is the leftmost `[data-fab-corner-dock]`, and that set
// includes the ConfigPanel (52 CR-01). The first cut reserved only the always-
// mounted bottom-right cluster, so selecting a machine - the ordinary build state,
// and the state the phase's own QA journey enters - put the full-height config
// panel straight back over the strip's right end, hiding the Request/Reply rows
// this same change added. The reserve is now "the leftmost right-docked surface,
// whatever that turns out to be": adding another such panel later means adding
// the attribute, not editing arithmetic. `legendBand.ts` holds the model, and
// refuses to produce a band at all rather than degrade to an unmeasured one.
//
// The property this shape buys, and the one to preserve in any future change: a
// user can READ the Request/Reply rows (how a reply travelled back) and CLICK the
// Belt tool at the same time, without dismissing anything.
//
// It lists every palette entry that lands on the board (glyph + name), the four state cues, the
// three port shapes and the cable's pulses, so a user can read the board without clicking. Kind
// names come from the shared KIND_NAMES map.
//
// FOUR GROUPS, AND NOTHING LEFT AT A LINE END (phase 92, CHROME-12, D-02, UI-SPEC 1.1). Until
// phase 92 every row, both separators and a bare `Connections` heading were loose items of one
// wrapping row, so where the strip wrapped decided whether a separator or that heading was left
// alone at the end of a line, and at every measured width one was (92-MEASURE.md `### 12a`). Now
// the rows sit in four `role="group"` boxes (kinds, states, ports, connections), each labelled by
// its heading, and each heading shares one `nowrap` head pair with its group's first row, so no
// width can part them. The separators became a 1 px left hairline on each group, inside a clip box
// whose groups row starts 17 px (`md` + 1) left of it: a group that starts a line has its hairline
// and lead clipped, so a hairline shows only between two groups on one line. At every checked width
// the groups stack, so the headings do the grouping. `e2e/legend-lines.spec.ts` grades it by boxes
// and pixels at five layouts. The glyphs come from MachineGlyphIcon, which is still the
// PIXEL-ERA `GLYPHS` matrix set: since plan 58-03 the canvas draws authored VECTOR
// art (`render/assets/*.svg`) through `getAssetContext`, so the legend and the
// canvas DIVERGE for the kind rows until CHROME-01 (Phase 59) points both at the
// same asset. Chrome icons are deliberately out of Phase 58's scope
// (58-CONTEXT.md line 26) - what is NOT acceptable is this header continuing to
// claim they are "pixel- and copy-identical to the real machines by construction",
// which it did through two edits to this file in a phase that made it false (58
// review WR-09; by this repo's own rule an overstated comment IS the defect).
// The state swatches below DO still equal the canvas by construction - they call
// `chassisInk`. Every string renders as a React text child (no innerHTML).
//
// Colour discipline (UI-SPEC): the three state swatches show the CANVAS cue
// colours as reference only (Working emerald, Faulted red, Idle neutral). Those
// accents are canvas-only and never a chrome affordance; here they are inert
// reference fills produced by `chassisInk` - the SAME function the canvas strokes
// each machine's chassis with - and formatted by the SAME `colorToCss` the e2e
// oracles use. No hand-authored hex and no hand-copied skin index (plan 58-05).
// The build accent is reserved for the toggle button's focus/pressed convention
// and never appears on a swatch.

import type { CSSProperties, JSX } from 'react';
import { LOCKED_SKIN } from '../render/synth/skins/locked';
import { INLET_HALF, inletGlyphRects } from '../render/layers/inletGlyph';
import { MEDIUM_ELECTRICAL, PORT_ROLE } from '../protocol/ports';
import { chassisInk } from '../render/layers/machineChassis';
import { machine_kind, state_tag } from '../protocol/kinds';
import { nubColor } from '../render/layers/machines';
import { CABLE_WIDTH } from '../render/cableGeometry';
import { colorToCss } from '../../shared/geometry';
import { KIND_NAMES, KIND_LEGEND_ORDER } from './kindNames';
import { LabelIcon, MachineGlyphIcon } from './icons';
import { PortIndicator, PORT_INDICATOR_VIEW_U } from './PortIndicator';
import { ICON_MD_PX } from '../render/synth/chrome/iconSizes';

/** The Legend's Route hint (phase 91, D-12, CHROME-13): a Route calls its Handler, the
 *  machine at the far end of its wire, never "the wire" itself. */
export const ROUTE_LEGEND_HINT = 'POST here to call its Handler';

/** The HTTP Handler row's hint (72-UI-SPEC 2.5): the user's code answers a Route's request. */
const HANDLER_LEGEND_HINT = 'your JavaScript answers it';

/** The Wire row's hint (phase 92, UI-SPEC A6). It read `carries the request` and the reply as one
 *  phrase, which made the `Connections` head pair 384 px, too wide for the 344 px strip at 1024x768
 *  with a machine selected; at 17 characters the pair is 304 px. */
const WIRE_LEGEND_HINT = 'request and reply';

/** The Legend panel's stable DOM id - the Toolbar Legend button aria-controls it. */
export const LEGEND_PANEL_ID = 'fab-legend-panel';

/**
 * Legend glyph size - the shared `--fab-icon-md` step.
 *
 * NOTE, CORRECTED IN PLACE BY PLAN 59-01 (CHROME-01). This used to read: "Glyph size
 * matching the Palette's PALETTE_GLYPH_PX so legend == palette == canvas." That
 * invariant is deliberately BROKEN here, and the reason it can be broken is that it was
 * never the real property. PIXEL EQUALITY WAS A PROXY FOR ASSET EQUALITY - the only way
 * to know the legend showed the same machine as the board, back when each surface baked
 * its own raster, was to bake them at the same size. Phase 59 makes the three surfaces
 * read ONE authored `.svg` through one parse, so asset equality is now a fact rather
 * than something a matched integer stands in for. The proxy is dropped and the real
 * property is recorded in its place.
 *
 * The two sizes now differ ON PURPOSE, because the two surfaces do different jobs. The
 * Palette icon must be identified BEFORE its label is read and it carries a chassis, so
 * it takes `ICON_LG_PX`. A Legend glyph sits directly beside the kind's NAME, so the
 * name carries identification and the glyph carries recognition - `ICON_MD_PX` is
 * enough, and 16px is the floor at which the 2u detail stroke is exactly one whole CSS
 * pixel (derivation on `iconSizes.ts`).
 *
 * Exported so the node harness asserts the swatch box against the SAME constant the
 * rows render at, rather than against a literal that could drift from it.
 */
export const LEGEND_GLYPH_PX = ICON_MD_PX;

/**
 * The endpoint inlet swatch renders at its NATIVE size (INLET_HALF * 2 = 14px, the
 * exact size the canvas stamps at zoom 1) instead of downscaling into
 * LEGEND_GLYPH_PX. At 11/14 the crispEdges rects snapped to arbitrary whole pixels
 * (merged chevron stairs, uneven gaps), so the RASTER diverged from the canvas the
 * module claims to mirror. 1:1 makes crispEdges exact; the 3px size difference over
 * the 11px machine glyphs also mirrors the canvas (the inlet IS larger than the
 * plain nub - the D-05 size cue). The row is alignItems:'center', so it stays aligned.
 */
const INLET_SWATCH_PX = INLET_HALF * 2;

// The local `hex()` formatter that lived here was DELETED BY PLAN 58-05 in favour of
// `colorToCss` from `shared/geometry.ts` - the ONE conversion the e2e suites already
// compare both computed `--fab-*` CSS custom properties AND decoded PNG pixels
// against. Two byte-identical implementations of the same six characters is still two
// declarations, and this panel's whole claim is that it equals the canvas by
// construction rather than by two things happening to agree.

/** One state cue: name + reference swatch fill + the shape/motion hint copy. */
interface StateCue {
  name: string;
  /** Reference swatch fill - a CANVAS cue colour, shown inert (never an affordance). */
  fill: string;
  /** The colour + shape (+ motion) hint (colour-blind-safe cue description). */
  hint: string;
}

// The three state cues, colours pulled from the LOCKED skin (canvas source of
// truth), shown here as inert reference swatches only:
//   Idle    = the idle chassis OUTLINE ink (at rest)
//   Working = working accent (emerald) - the outline recolours + a notch travels it
//   Faulted = fault accent (red) - a board-drawn alert ring + blink
//
// ALL THREE ROWS MOVED IN PLAN 58-03, because the canvas underneath them did. Lock
// axis 3 made the machine an OPEN chassis, so there is no body left to tint and no
// body left to hold a baked corner marker; state now lives on the outline plus a
// board-drawn cue (`render/layers/machineState.ts`). Leaving the old strings would
// have made this panel describe a canvas that no longer exists - the exact drift
// CONNECTION_FILL's comment below calls "legend == canvas by construction".
//
// ALL THREE FILLS MOVED AGAIN IN PLAN 58-05 - to the same VALUES by a different
// ROUTE, and the route is the point. 58-03 left each swatch reaching into the skin
// by hand: `ramp[ramp.length - 1]` here, `accents.working` and `accents.fault`
// below. Those three expressions are a hand-copy of `chassisInk`'s three branches
// (`render/layers/machineChassis.ts`), so the legend equalled the canvas only for as
// long as nobody edited one of them. They now CALL `chassisInk` with the same
// `state_tag` the renderer passes it, which makes the swatch the canvas function
// rather than a colour that happens to match it: a future re-routing of state ink -
// a different ramp step for idle, a desaturated fault - moves both together or
// neither. SKIN-03's one-world requirement, closed by construction.
//
// VALUE-NEUTRAL BY DESIGN, and asserted as such: 58-03 already moved the idle swatch
// onto the idle canvas ink, so `Legend.test.tsx`'s rendered colours must not move.
const STATE_CUES: StateCue[] = [
  {
    name: 'Idle',
    fill: colorToCss(chassisInk(state_tag.IDLE, LOCKED_SKIN)),
    hint: 'at rest',
  },
  // Hint kept SHORT on purpose (a gap-closure review decision), but the REQUEST
  // semantic is load-bearing and must survive any future trim. 43-02 deliberately
  // reworded this from a bare mechanism to name what Working means, and pins it in
  // Legend.test.tsx; do not revert to mechanism-only.
  //
  // Why it is short: at 1024x768 the ConfigPanel reserve narrows the strip to a 344px
  // content box and every row is `nowrap`, so `(handling a request)` measured 357px
  // and bled 5px onto the panel's own bezel. `(on a request)` keeps both the visual
  // mechanism and 43-02's meaning. `tint` -> `outline` in plan 58-03 adds three
  // characters; it was RE-MEASURED at every viewport rather than estimated, and
  // `palette-grouping.spec.ts` still reports an overflow of 0. If you lengthen this
  // again, re-run that spec - its budget is 0 at EVERY viewport and is meant to stay
  // that way, and if it ever bleeds, shorten the MECHANISM half and never the
  // `(on a request)` half.
  {
    name: 'Working',
    fill: colorToCss(chassisInk(state_tag.WORKING, LOCKED_SKIN)),
    hint: 'outline + motion (on a request)',
  },
  // `marker` -> `ring`, two characters SHORTER, so this row cannot regress on width.
  // The v4.0 baked 2x2 corner marker lived in the body and there is no body; its
  // VIS-03 job (a colour-independent shape cue, always present when faulted and never
  // otherwise) moved to the board-drawn alert ring, and the blink came with it.
  {
    name: 'Faulted',
    fill: colorToCss(chassisInk(state_tag.FAULTED, LOCKED_SKIN)),
    hint: 'ring + blink',
  },
  // THE FOURTH STATE (PILE-08, plan 71-06). The swatch is the DIMMED outline
  // (`chassisInk` returns `ramp[3]`, 3.285 : 1 against idle), and the hint names the
  // other channel: a run of ticks over the machine's head that closes into one solid bar
  // when the inbox is full. Mechanism then meaning, the same grammar the two rows above
  // follow.
  //
  // THE CHARACTER COUNT IS NOT THE GATE. `palette-grouping.spec.ts` holds an overflow
  // budget of 0 at EVERY viewport and it is the only thing that may declare this row
  // safe; it was RUN for this row rather than estimated, which is the discipline the
  // `Working` note above records after a wording measured 357px and bled onto the bezel.
  // If you lengthen this, re-run that spec and shorten the HINT, never the name.
  {
    name: 'Backed up',
    fill: colorToCss(chassisInk(state_tag.BACKED_UP, LOCKED_SKIN)),
    hint: 'bar fills (inbox full)',
  },
];

// The electric accent the wire layer stamps for the square terminal nub, the Route's inlet and
// the forward spark (wires.ts reads `accents.electric` for each), so these swatches equal the
// canvas by construction (no hand-authored hex). CORRECTED IN PHASE 92: this also named "the cyan
// cable". The resting cable has not been electric since it went grey, and since plan 92-04 it is
// its own token, `palette.cable`, which the Wire swatch below reads.
const CONNECTION_FILL = colorToCss(LOCKED_SKIN.palette.accents.electric);

// The resting cable's colour (phase 92, D-10): the token `wires.ts` strokes every cable in.
const CABLE_FILL = colorToCss(LOCKED_SKIN.palette.cable);

// The board's own floor, `ramp[0]`, behind the Ports and Wire swatches (UI-SPEC A7). The In and
// fault exit grey reads 1.57 : 1 on the panel and 2.57 : 1 on the floor, and the cable teal 2.65 : 1
// against 4.33 : 1, so each swatch shows its mark on the ground the board draws it on.
const FLOOR_FILL = colorToCss(LOCKED_SKIN.palette.ramp[0]);

/** One port cue: the role and medium bytes the canvas draws, its name and what it is for. */
interface PortCue {
  role: number;
  /** `MEDIUM_ELECTRICAL` for a wire's square nub; absent for the mechanical disc. */
  medium?: number;
  name: string;
  hint: string;
}

// THE PORTS GROUP (phase 92, CHROME-18's "the Legend explains", D-04, D-08, UI-SPEC 1.3). The board
// draws three nub shapes, a disc, a disc with a stem and a ring round a small core, and the Legend
// named none of them, so the one fault-exit shape on a cold board read as unexplained. Each swatch
// is `PortIndicator`, the chrome copy of `drawRoleNub` that reads the same `ports.ts` constants
// (RESEARCH Finding K: no third copy of the silhouettes), at one pixel per unit, coloured by
// `nubColor` for an IDLE machine, the function the canvas strokes the nub with. So the Legend equals
// the canvas by construction, the way the state swatches call `chassisInk`. A bare nub on the board
// is an unconnected port of that role (D-08: no extra dimming), which is exactly what these show.
// No hint names a colour: the shape carries the role.
//
// THE WIRE PORT ROW (phase 92 review IN-B-04). A Route's and an HTTP Handler's unconnected ports are
// electrical, and the board draws them as a square (a square with a stem for an Out), not a disc:
// the same unexplained-nub complaint that put this group in. One row explains the square; the stem
// already reads "out" from the Out row above it, in either medium.
const PORT_CUES: readonly PortCue[] = [
  { role: PORT_ROLE.IN, name: 'In', hint: 'items enter here' },
  { role: PORT_ROLE.OUT, name: 'Out', hint: 'items leave here' },
  { role: PORT_ROLE.FAULT, name: 'Fault exit', hint: 'items that fail leave here' },
  { role: PORT_ROLE.IN, medium: MEDIUM_ELECTRICAL, name: 'Wire port', hint: 'a wire docks here' },
];

// The reply comet's fill is the SAME item accent `wires.ts` hands `drawComet` for
// a DIR_REPLY pulse (`isReply ? accents.item : accents.electric`), read from the
// LOCKED skin exactly as CONNECTION_FILL is. Reading the accent rather than
// writing a literal is what makes the legend equal the canvas BY CONSTRUCTION: a
// skin swap moves both together, and neither can silently drift into describing a
// colour the canvas no longer draws (T-52-06).
const REPLY_FILL = colorToCss(LOCKED_SKIN.palette.accents.item);

// Swatch geometry for the two pulse rows, derived from LEGEND_GLYPH_PX so the
// column stays aligned and no loose literal creeps in. It mirrors the wire layer's
// own dimensions at legend scale: `HEAD_R = 3` becomes a 3px head square at the
// leading (right) edge, the compact `FORWARD_TAIL = 0.3 * CELL` becomes one short
// bar behind it, and the `REPLY_GLOW = 1.5 * CELL` trailing glow becomes a long
// stepped fade spanning the rest of the box.
//
// STEPPED OPACITY RECTS, never a linearGradient: this swatch family renders
// `crispEdges`, and a smooth gradient would be the one soft thing in a pixel-crisp
// chrome. The clause used to read "`crispEdges` + `imageRendering: 'pixelated'`";
// plan 59-03 deleted the second half here and on four sibling swatches, because
// MEASURED it never did anything: `image-rendering` acts on RASTER content (an
// <img>, a <canvas>, a background-image, an SVG <image>), and every swatch in this
// file is an inline <svg> of <rect>s or a solid-colour <span>. `crispEdges` is what
// actually turns off antialiasing on shapes, and it is untouched.
const SWATCH_HEAD_PX = 3;
const SWATCH_HEAD_X = LEGEND_GLYPH_PX - SWATCH_HEAD_PX;
const SWATCH_HEAD_Y = Math.floor((LEGEND_GLYPH_PX - SWATCH_HEAD_PX) / 2);
const SWATCH_TAIL_Y = Math.floor((LEGEND_GLYPH_PX - 1) / 2);
const SWATCH_TAIL_H = 1;
/** The forward spark's short trailing bar - the compact FORWARD_TAIL read. */
const SWATCH_SHORT_TAIL_W = 3;
/** The reply comet's long stepped glow, head-adjacent segment first. Each entry
 *  abuts the next, together spanning the whole box behind the head, and the alpha
 *  descends toward zero - the pixel-art reading of REPLY_GLOW_ALPHA fading out. */
const REPLY_GLOW_STEPS: readonly { x: number; w: number; alpha: number }[] = [
  { x: SWATCH_HEAD_X - 3, w: 3, alpha: 0.9 },
  { x: SWATCH_HEAD_X - 6, w: 3, alpha: 0.5 },
  { x: 0, w: SWATCH_HEAD_X - 6, alpha: 0.25 },
];

/** The shared swatch frame for the two pulse rows: same box, same crisp raster,
 *  same flex behaviour as every other Connections swatch. */
const pulseSwatchProps = {
  'aria-hidden': true,
  // `focusable="false"` (added by plan 59-07's exit block, and it is a FIX rather than
  // a tidy). An inline <svg> is a tab stop in some engines even when aria-hidden, which
  // is the keyboard-trap class IX-09 guards against - and 59-UI-SPEC's accessibility
  // contract makes the attribute mandatory on EVERY inline chrome <svg>, not only on the
  // ones `icons.tsx` emits. These two swatches (52-03) and the Endpoint inlet swatch
  // below (phase 46) predate that contract and were outside its live gate, because
  // `chrome-icons.spec.ts` audited `header svg, aside svg` and the Legend is neither.
  // The gate now covers this mount point too.
  focusable: 'false' as const,
  width: LEGEND_GLYPH_PX,
  height: LEGEND_GLYPH_PX,
  viewBox: `0 0 ${LEGEND_GLYPH_PX} ${LEGEND_GLYPH_PX}`,
  shapeRendering: 'crispEdges' as const,
  style: { flex: '0 0 auto' },
};

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--fab-space-sm)',
  fontFamily: 'var(--fab-font)',
  fontSize: 'var(--fab-font-size-base)',
  color: 'var(--fab-ink)',
  lineHeight: 1,
  whiteSpace: 'nowrap',
};

/** Groups 2 to 4's heading (UI-SPEC Typography): 12 px ink at weight 700, the weight the
 *  `.fab-title` tier already uses, so the strip still has two weights. */
const groupHeadingStyle: CSSProperties = {
  fontFamily: 'var(--fab-font)',
  fontSize: 'var(--fab-font-size-base)',
  fontWeight: 700,
  color: 'var(--fab-ink)',
  lineHeight: 1,
  whiteSpace: 'nowrap',
};

/** One group: its own wrapping row, its boundary a left hairline with a `md` lead (UI-SPEC 1.1). */
const groupStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  columnGap: 'var(--fab-space-md)',
  rowGap: 'var(--fab-space-sm)',
  borderLeft: '1px solid var(--fab-outline)',
  paddingLeft: 'var(--fab-space-md)',
};

/** A heading and its group's first row, one flex item that never wraps, so the heading cannot be
 *  left at a line end on its own. */
const headPairStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  columnGap: 'var(--fab-space-md)',
  whiteSpace: 'nowrap',
};

/** The 16 px floor well a Ports or Wire swatch sits in (UI-SPEC A7). */
const wellStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: LEGEND_GLYPH_PX,
  height: LEGEND_GLYPH_PX,
  background: FLOOR_FILL,
  flex: '0 0 auto',
};

/**
 * The hint's opacity over the panel (phase 92 UI review fix 4, the review's decision: a dimmer
 * ink that still clears 4.5 : 1 on the panel). A row's name and its hint were one ink and weight, so
 * `Idle at rest` read as one phrase. `--fab-ink` (ramp[4]) on `--fab-panel-fill` (ramp[2]) is only
 * 5.16 : 1, so the room is narrow: at 0.92 the hint composites to 4.62 : 1 (`Legend.test.tsx`
 * computes it from the skin), a step dimmer than the name and still over the floor. Opacity over the
 * panel rather than a new colour, so no chrome colour is minted outside the skin's tokens.
 */
export const LEGEND_HINT_OPACITY = 0.92;

/**
 * The mark between a row's name and its hint (phase 92 review fix pass 2, UI review fix 4's second
 * option). The 0.92 dim alone left `Fault exit items that fail leave here` reading as one phrase on
 * the real app, since the 4.5 : 1 floor leaves the hint almost no room below the name's ink. The dot
 * is decoration: aria-hidden, so a screen reader still hears the name and then the hint.
 */
export const LEGEND_HINT_MARK = '·';

/** The mark takes the place of the row gap instead of adding to it: both 8 px gaps are pulled back
 *  in, so the dot sits in its own monospace cell (about 2.5 px of side bearing each side) and a hinted
 *  row is no wider than it was. Any added width wraps a group in the strip beside the inspector at
 *  1024 x 768 and the Legend grows a whole row over the board (measured: 318 to 344 px tall with a
 *  4 px gap kept each side), and the widest rows, `HTTP Handler` and `Working`, end at the content
 *  edge with a Factory selected (`legend-lines.spec.ts`, `palette-grouping.spec.ts`). */
const hintMarkStyle: CSSProperties = {
  color: 'var(--fab-ink)',
  marginInline: 'calc(-1 * var(--fab-space-sm))',
};

/** One Legend row: swatch, name, and an optional hint. `data-fab-legend-row` is what the mock
 *  specs read a row by, so a wrapper box is never mistaken for one. */
function legendRow(key: string | number, swatch: JSX.Element, name: string, hint?: string): JSX.Element {
  return (
    <div key={key} data-fab-legend-row="" style={rowStyle}>
      {swatch}
      <span>{name}</span>
      {hint !== undefined && (
        <span data-fab-legend-hint-mark="" aria-hidden style={{ ...hintMarkStyle, opacity: LEGEND_HINT_OPACITY }}>
          {LEGEND_HINT_MARK}
        </span>
      )}
      {hint !== undefined && <span data-fab-legend-hint="" style={{ color: 'var(--fab-ink)', opacity: LEGEND_HINT_OPACITY }}>{hint}</span>}
    </div>
  );
}

/**
 * One labelled group: its heading and first row in the head pair, the other rows after it. The
 * group's accessible name is its heading (`aria-labelledby`), or `label` where the heading names
 * something else: the kinds group's heading is the panel's own `Legend` h2, so the group is named
 * `Machines` (phase 92 review IN-B-03; it was announced "Legend, group" inside "Legend").
 *
 * The head pair is a `div` (review IN-B-02): it holds the heading, an `<h2>` for the kinds group,
 * and a row `div`, block content a `span` may not hold. `inline-flex` gives the same layout.
 */
function legendGroup(name: string, headingId: string, heading: JSX.Element, rows: JSX.Element[], label?: string): JSX.Element {
  const naming = label === undefined ? { 'aria-labelledby': headingId } : { 'aria-label': label };
  return (
    <div role="group" {...naming} data-fab-legend-group={name} style={groupStyle}>
      <div data-fab-legend-head="" style={headPairStyle}>
        {heading}
        {rows[0]}
      </div>
      {rows.slice(1)}
    </div>
  );
}

/** A 12 px bold group heading (groups 2 to 4). */
function groupHeading(id: string, text: string): JSX.Element {
  return (
    <span id={id} style={groupHeadingStyle}>
      {text}
    </span>
  );
}

/** A kind's machine glyph, the same authored asset the Palette and the canvas read. */
function machineGlyph(kind: number): JSX.Element {
  return (
    <span className="fab-glyph" style={{ display: 'inline-flex' }}>
      <MachineGlyphIcon kind={kind} color="currentColor" px={LEGEND_GLYPH_PX} />
    </span>
  );
}

/** The endpoint inlet terminal (FEEL-04, D-02): legend == canvas by construction - the swatch
 *  renders the SAME 6 rects the wire layer stamps for a kind-9 dock, mapped straight from
 *  inletGlyphRects(1, 0) (E-facing, mouth toward the cable, matching the demo endpoint), filled
 *  with the same CONNECTION_FILL. The glyph silhouette replaces the old bounding-box square; a
 *  border would misrepresent the canvas shape. */
function routeSwatch(): JSX.Element {
  return (
    <svg
      aria-hidden
      // See `pulseSwatchProps` above for why this attribute is here (plan 59-07).
      focusable="false"
      width={INLET_SWATCH_PX}
      height={INLET_SWATCH_PX}
      viewBox={`${-INLET_HALF} ${-INLET_HALF} ${INLET_HALF * 2} ${INLET_HALF * 2}`}
      shapeRendering="crispEdges"
      style={{ flex: '0 0 auto' }}
    >
      {/* PORT_ROLE.IN explicitly (72-09 R-60): the chevron mirrors for a Role::Out terminal, and
          this row's own copy is the request-in reading ("POST here to call its Handler"). Passing
          the role rather than taking a default is what keeps this swatch's meaning a decision. */}
      {inletGlyphRects(1, 0, PORT_ROLE.IN).map((r, i) => (
        <rect key={i} x={r.x} y={r.y} width={r.w} height={r.h} fill={CONNECTION_FILL} />
      ))}
    </svg>
  );
}

/**
 * One kind row, in `KIND_LEGEND_ORDER` (palette order since phase 92, D-03, UI-SPEC 1.2). Three
 * kinds pick their own swatch and hint:
 *
 *   ROUTE (kind 9) keeps the shipped inlet swatch and its hint (UI-SPEC A4). `MachineGlyphIcon`
 *   would draw its palette glyph; the Legend row has always shown the terminal the cable docks to.
 *
 *   HTTP HANDLER (kind 10) keeps the Factory glyph and its hint. THE GLYPH REPEATS THE FACTORY'S,
 *   AND THAT IS THE HONEST OUTCOME: `MachineGlyphIcon kind={HANDLER}` resolves `SUBJECT_OF[10]` to
 *   `factory`, because an HTTP Handler IS a Factory chassis running the user's code with two
 *   electrical ports instead of mechanical ones. Minting a second glyph would teach a difference
 *   the canvas does not draw.
 *
 *   LABEL (kind 11) is `LabelIcon`, the Palette's Label glyph. `SUBJECT_OF` has no key for it, so
 *   `MachineGlyphIcon` would draw a bare chassis, which reads as an unknown machine.
 *
 * Until phase 92 Route and HTTP Handler were Connections rows appended after the pulses, on the
 * grounds that growing the kind view minted unreviewed kind rows; walk-112 read that as the Legend
 * leaving them out of the kinds, and Label had no row at all. Phase 92 reviews the eleven.
 */
function kindRow(kind: number): JSX.Element {
  const name = KIND_NAMES[kind] ?? '';
  if (kind === machine_kind.ENDPOINT) return legendRow(kind, routeSwatch(), name, ROUTE_LEGEND_HINT);
  if (kind === machine_kind.HANDLER) return legendRow(kind, machineGlyph(kind), name, HANDLER_LEGEND_HINT);
  if (kind === machine_kind.LABEL) {
    return legendRow(
      kind,
      <span className="fab-glyph" style={{ display: 'inline-flex' }}>
        <LabelIcon color="currentColor" px={LEGEND_GLYPH_PX} />
      </span>,
      name,
    );
  }
  return legendRow(kind, machineGlyph(kind), name);
}

/** One state row: the reference swatch (a `chassisInk` fill) with its shape and motion hint. */
function stateRow(cue: StateCue): JSX.Element {
  return legendRow(
    cue.name,
    <span
      aria-hidden
      style={{
        display: 'inline-block',
        width: LEGEND_GLYPH_PX,
        height: LEGEND_GLYPH_PX,
        background: cue.fill,
        border: '1px solid var(--fab-outline)',
        flex: '0 0 auto',
      }}
    />,
    cue.name,
    cue.hint,
  );
}

/** One port row: the nub `PortIndicator` draws, in the canvas's `nubColor`, on the floor well. */
function portRow(cue: PortCue): JSX.Element {
  return legendRow(
    cue.name,
    <span aria-hidden style={{ ...wellStyle, color: colorToCss(nubColor(cue.role, state_tag.IDLE, LOCKED_SKIN)) }}>
      <PortIndicator role={cue.role} medium={cue.medium} px={PORT_INDICATOR_VIEW_U} />
    </span>,
    cue.name,
    cue.hint,
  );
}

export interface LegendProps {
  /** The MEASURED right edge of the Palette column, in the shared positioning
   *  container's coordinate space. The strip starts one `--fab-space-lg` past it. */
  paletteRightPx: number;
  /** The MEASURED width reserved on the right for the LEFTMOST right-docked
   *  surface (container width minus the smallest `[data-fab-corner-dock]`
   *  offsetLeft). That set is the CameraCluster, PLUS the ConfigPanel
   *  whenever a machine is selected - it once spanned `top:lg` to `bottom:lg`
   *  (52 CR-01); since plan 91-09 it docks below the toolbar and is as tall as its
   *  content, and since review IN-B-04 it is reserved only while its bottom reaches this
   *  strip's top (`legendBand.ts` `cornerLeftsReachingStrip`). The strip stops one
   *  `--fab-space-lg` short of whichever counted surface is furthest left. */
  cornerInsetPx: number;
}

/** Both props are REQUIRED, deliberately. An optional prop with a fallback would
 *  restore the old bottom-left dock, and therefore this exact defect, the moment
 *  App forgot to pass the band. App goes one further and does not MOUNT this
 *  component at all when the band could not be measured (`legendBand.ts` refuses
 *  with a named reason rather than returning zeros). */
export function Legend({ paletteRightPx, cornerInsetPx }: LegendProps): JSX.Element {
  return (
    <aside
      id={LEGEND_PANEL_ID}
      className="fab-panel"
      aria-labelledby="fab-legend-heading"
      style={{
        position: 'absolute',
        // The two measured bounds. No `width`: the left/right pair sizes the strip,
        // and `width: fit-content` would let it grow back over the Palette column.
        left: `calc(${paletteRightPx}px + var(--fab-space-lg))`,
        right: `calc(${cornerInsetPx}px + var(--fab-space-lg))`,
        bottom: 'var(--fab-space-lg)',
        zIndex: 2,
        display: 'flex',
        // A wrapping ROW, not a column: the content flows across the strip and wraps onto more
        // lines on a narrow window instead of growing UP the left edge.
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        columnGap: 'var(--fab-space-md)',
        rowGap: 'var(--fab-space-sm)',
        // Ring padding (plan 59-03): the 6px the retired border reserved.
        padding: 'calc(var(--fab-space-sm) + var(--fab-bezel-ring))',
        // NO `pointerEvents: 'none'` (T-52-17). It looks free because this panel
        // holds zero interactive elements, but it would let a click here fall
        // through to the canvas and place a machine under an opaque panel: an
        // occlusion defect traded for a silent state-mutation one. Gated in
        // Legend.test.tsx so the refusal is enforced, not just remembered.
      }}
    >
      {/* THE CLIP BOX (UI-SPEC 1.1, A3). Its groups row starts `md` + 1 px left of the box, so a
          group that starts a line has its hairline and its 16 px lead cut off and its first row
          starts flush at the strip's content edge; a group that follows another on one line shows
          its hairline 16 px after that group's last row. Pure CSS, no measurement. */}
      <div data-fab-legend-groups="" style={{ overflow: 'hidden', width: '100%' }}>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            columnGap: 'var(--fab-space-md)',
            rowGap: 'var(--fab-space-sm)',
            marginLeft: 'calc(-1 * (var(--fab-space-md) + 1px))',
          }}
        >
          {legendGroup(
            'kinds',
            'fab-legend-heading',
            // A real <h2> sits under the Toolbar <h1> (no skipped level), mirroring the Palette
            // heading contract. Sono title tier (.fab-title) at the hero size.
            <h2
              id="fab-legend-heading"
              className="fab-title"
              style={{
                margin: 0,
                fontSize: 'var(--fab-font-size-hero)',
                color: 'var(--fab-ink)',
                lineHeight: 1.2,
              }}
            >
              Legend
            </h2>,
            KIND_LEGEND_ORDER.map(kindRow),
            'Machines',
          )}

          {/* States key: four reference swatches with the colour-blind-safe hints. */}
          {legendGroup('states', 'fab-legend-states', groupHeading('fab-legend-states', 'States'), STATE_CUES.map(stateRow))}

          {legendGroup('ports', 'fab-legend-ports', groupHeading('fab-legend-ports', 'Ports'), PORT_CUES.map(portRow))}

          {/* Connections key: the cable and the two pulses that travel it (QA-02 wall 1). The
              canvas has always drawn the pulses differently - an electric-cyan compact spark
              going out, an item-amber comet with a 1.5-cell trailing glow coming back - and these
              rows name them. Tail LENGTH, not tint, is the load-bearing cue - short bar versus
              long stepped fade - so the pair still tells apart in greyscale (VIS-03). The hint
              words carry it too ("out" versus "back"), and both swatches are aria-hidden, so the
              row name plus hint carry the whole meaning to AT. */}
          {legendGroup('connections', 'fab-legend-connections', groupHeading('fab-legend-connections', 'Connections'), [
            // The resting cable (phase 92, D-10, UI-SPEC 1.3): a CABLE_WIDTH bar across the floor
            // well in `palette.cable`, the colour `wires.ts` strokes it in. It was a 3 px bar of the
            // electric accent, which the canvas stopped drawing the cable in when it went grey.
            legendRow(
              'wire',
              <span aria-hidden style={wellStyle}>
                <span
                  style={{
                    display: 'inline-block',
                    width: LEGEND_GLYPH_PX,
                    height: CABLE_WIDTH,
                    background: CABLE_FILL,
                  }}
                />
              </span>,
              'Wire',
              WIRE_LEGEND_HINT,
            ),
            legendRow(
              'request',
              <svg {...pulseSwatchProps}>
                <rect
                  x={SWATCH_HEAD_X - SWATCH_SHORT_TAIL_W}
                  y={SWATCH_TAIL_Y}
                  width={SWATCH_SHORT_TAIL_W}
                  height={SWATCH_TAIL_H}
                  fill={CONNECTION_FILL}
                />
                <rect x={SWATCH_HEAD_X} y={SWATCH_HEAD_Y} width={SWATCH_HEAD_PX} height={SWATCH_HEAD_PX} fill={CONNECTION_FILL} />
              </svg>,
              'Request',
              'cyan spark on the way out',
            ),
            legendRow(
              'reply',
              <svg {...pulseSwatchProps}>
                {/* Glow first, head last, so the opaque head composites on top of its own tail -
                    the same tail-first order drawComet uses on canvas. */}
                {REPLY_GLOW_STEPS.map((step) => (
                  <rect
                    key={step.x}
                    x={step.x}
                    y={SWATCH_TAIL_Y}
                    width={step.w}
                    height={SWATCH_TAIL_H}
                    fill={REPLY_FILL}
                    fillOpacity={step.alpha}
                  />
                ))}
                <rect x={SWATCH_HEAD_X} y={SWATCH_HEAD_Y} width={SWATCH_HEAD_PX} height={SWATCH_HEAD_PX} fill={REPLY_FILL} />
              </svg>,
              'Reply',
              'amber comet on the way back',
            ),
          ])}
        </div>
      </div>
    </aside>
  );
}
