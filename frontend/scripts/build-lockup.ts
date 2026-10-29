// build-lockup.ts - the generator for the Fabrico wordmark lockup (MARK-08, MARK-16, plan 80-02).
//
// WHAT THIS EMITS. `docs/brand/fabrico-lockup.svg`, the primary brand artefact: `Fabrico` set
// in Martian Mono standing on a belt above `THE GRID IS THE PROGRAM`. Every letterform is flat
// `<path>` geometry outlined from the committed font binary at build time, and so is every
// piece of the machine under it: the plate, the dot grid, the belt and its outline, the
// cleats, the empty cell, the two drums and the amber item. No app surface imports the file;
// it is the source Phases 81 and 83 cut their surfaces from.
//
// THE FILE IS GENERATED AND NEVER HAND-WRITTEN. A change to the artwork is a change to this
// script. Regenerate with `npm run build:lockup`. `src/render/assets/lockup.test.ts`
// regenerates in memory and compares byte for byte against the committed file, so a hand edit
// to the artefact and a drift in the generator both redden the unit suite rather than
// surviving to a release.
//
// NO LIVE TEXT SURVIVES, WHICH IS THE POINT. The comparison drawing this replaces
// (the Phase 79 evidence copy of `fabrico-lockup.svg`) sets `<text>` in a face that is
// only on this machine because Phase 79 installed it. Measured: with the font hidden from
// fontconfig, 6,996 of its 228,800 pixels change. Outlining removes that dependency, and
// removes the two others it carried - librsvg and ImageMagick disagreed about the tagline's
// width by 20.8%, and the amber item was a hard-coded rect 6.5 units off the `i` stem it is
// supposed to be the tittle of.
//
// IT ADDS TWO BUILD-TIME DEPENDENCIES, AND NEITHER REACHES `dist/`. `wawoff2` decompresses
// the committed WOFF2 into a TTF; `fontkit` instances the `wght` axis on that TTF and hands
// back glyph outlines. The order is not a preference: fontkit opens a WOFF2 but
// `getVariation()` on one returns a font whose table directory is garbage and `layout()` then
// throws inside `CmapProcessor.findSubtable` (80-RESEARCH.md section 1 result 1). Both are
// devDependencies of `frontend/`, neither is imported by app code, and nothing in
// `vite.config.ts` reaches this directory, so the bundle is unchanged (D-07 binds the
// bundle, not the toolchain).
//
// NO PATH INPUT, EVER, following `mark-craft.ts` and `lint-svg.ts`. Every path is resolved
// from `import.meta.url`. This module reads no argv and no cwd, so `node
// frontend/scripts/build-lockup.ts` works from the repository root and from `frontend/` alike.
//
// THE BUILDER NEVER READS ITS OWN OUTPUT. `buildLockup()` does not reference `LOCKUP_PATH` at
// all; only `writeLockup()` and the gate do. A generator that read the committed file back and
// returned it would make the regenerate-and-compare gate pass on anything, which is this
// repository's signature defect class rather than a hypothetical.
//
// THE FONT'S IDENTITY IS READ, NOT REPEATED. The sha256 and byte size are parsed out of
// `src/assets/fonts/NOTICE.md` and asserted against the binary. The hex is deliberately absent
// from this file: the property worth holding is that the notice and the binary agree, and a
// literal here would only make this file agree with itself.
//
// THE AMBER ITEM'S ANCHOR IS MEASURED, NEVER PASTED. Its x is the centre of the `i` stem's
// measured extent and its y the centre of the measured tittle contour, both taken at the
// emitted layout. The judged drawing's own coordinates for it appear below only so the header
// can report how far the measured anchor moved from them; nothing is drawn from those numbers.
//
// ERASURE-ONLY TYPESCRIPT. Node runs this file directly through native type stripping, which
// is erasure only: interfaces, type aliases, annotations and `import type` only, no enums, no
// namespaces, no parameter properties, an explicit `.ts` extension on every relative import.
// The contract is stated at `scripts/lint-svg.ts:29-34`.
//
// NO EM DASH (U+2014) ANYWHERE IN THIS FILE OR IN ANYTHING IT EMITS.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fontkit from 'fontkit';
import { decompress } from 'wawoff2';
import type { Font, PathCommand } from 'fontkit';
// The shipped header height, in CSS px, from the ONE module that declares it. This generator
// bakes CSS-px figures computed from it into the emitted cut's provenance header, and
// `src/chrome/HeaderLockup.tsx` renders at it; a second declaration here would let the
// artefact document a height the app had stopped using. Importing app source from a script is
// the existing direction: `mark-craft.ts` and `build-mark-sheet.ts` both read `src/`.
import { HEADER_PX } from '../src/chrome/headerLockupMetrics.ts';

/* ------------------------------------------------------------------ *
 * Paths - resolved from the module URL, never from cwd and never from argv
 * ------------------------------------------------------------------ */

/** The committed variable WOFF2. Read as bytes; never resolved through fontconfig. */
export const FONT_PATH = fileURLToPath(
  new URL('../src/assets/fonts/MartianMono.woff2', import.meta.url),
);

/** The provenance record the font's sha256 and byte size are read out of. */
export const NOTICE_PATH = fileURLToPath(new URL('../src/assets/fonts/NOTICE.md', import.meta.url));

/**
 * The generated brand artefact. Committed, because it is the source every later cut is taken
 * from. Never edited. `buildLockup()` MUST NOT reference this constant.
 */
export const LOCKUP_PATH = fileURLToPath(
  new URL('../../docs/brand/fabrico-lockup.svg', import.meta.url),
);

/**
 * The generated header cut (D-07, MARK-17): the same geometry as the lockup, cropped to a
 * header-shaped window and painted in app tokens. Committed, because the app imports it.
 * Never edited. `buildHeaderCutDetailed()` MUST NOT reference this constant, for the reason
 * `buildLockupDetailed` already states: a builder that read its own output back would make
 * the regenerate-and-compare gate pass on any file at all.
 *
 * It lives outside `src/chrome/assets/` on purpose. `scripts/lint-svg.ts` admits that
 * directory on four exact viewBox strings and refuses non-integer coordinates and curves,
 * and the cut has a measured crop origin, glyph outlines and stadium arcs. So it takes the
 * `docs/brand/` rule subset instead, and `EXPECTED_CHROME_ASSET_COUNT` does not move.
 */
export const HEADER_CUT_PATH = fileURLToPath(
  new URL('../src/chrome/brand/fabrico-header.svg', import.meta.url),
);

/* ------------------------------------------------------------------ *
 * Colour - literals, because nothing reskins a docs artefact
 * ------------------------------------------------------------------ */

/** LOCKED_SKIN values, quoted as literals: `fab-page-bg`, `fab-panel-fill`, `fab-ink`. */
const PLATE_FILL = '#1b1f27';
const PANEL_FILL = '#3b4250';
const WORD_FILL = '#b0bacb';
/** `fab-accent-item`. The one accent-valued layer in the drawing. */
const ITEM_FILL = '#ffb454';
/** Brand-register greys (docs/brand/README.md, Colour): spent here, and on nothing the app itself paints. */
const STRUCTURE_INK = '#8a94a6';
const TAG_FILL = '#6d7481';

/* ------------------------------------------------------------------ *
 * Colour - the header cut's register, which is TOKENS and never hex
 * ------------------------------------------------------------------ */

/**
 * The header cut's four paints, as CSS custom-property references.
 *
 * NOT HEX, AND THE DIFFERENCE IS NOT COSMETIC. `src/chrome/svgToElements.ts` rewrites any
 * paint whose value is a LOCKED_SKIN ramp hex to `currentColor`, so a ramp literal authored
 * here would collapse the plate, the belt lane and the belt ink onto one colour the moment
 * the file reached the DOM, silently, with every gate still green. The brand-register rule
 * forbids the lockup's two brand greys on an app surface independently of that.
 */
const CUT_SUBSTRATE = 'var(--fab-substrate)';
const CUT_PANEL_FILL = 'var(--fab-panel-fill)';
const CUT_INK = 'var(--fab-ink)';
const CUT_ACCENT_ITEM = 'var(--fab-accent-item)';

/* ------------------------------------------------------------------ *
 * Layout constants - Phase 79's judged literals, re-expressed
 * ------------------------------------------------------------------ */

/** The drawing's box. Phase 79 judged the lockup at this aspect. */
const VIEW_W = 880;
const VIEW_H = 260;

/** The word's font size, from the judged drawing's `font-size="116"`. */
export const WORD_SIZE = 116;

/** The word's left edge and baseline, from the judged drawing's first `<text x="152" y="135">`. */
const WORD_X0 = 152;
const WORD_BASELINE = 135;

/**
 * The face is monospace: every glyph in both strings advances 700 units, `xOffset` is 0 and
 * there is no kerning. Asserted at layout time rather than assumed, because `WORD_TRACKING`
 * below is derived from it and a face that gained kerning would silently move every letter.
 */
const MONO_ADVANCE = 700;

/**
 * Tracking, as the pen advance the judged drawing implies. Phase 79 set seven cells over 580
 * units from x=152, a pitch of 580/7 = 82.857; the face advances 81.2 at this size, so the
 * remainder is the tracking. Expressed as the difference rather than as 1.657 so the pitch
 * stays exact and a change to `WORD_SIZE` moves it correctly.
 */
export const WORD_TRACKING = 580 / 7 - (MONO_ADVANCE * WORD_SIZE) / 1000;

/** The word, and the `wght` axis instance it is set at. */
const WORD = 'Fabrico';
const WORD_WEIGHT = 500;

/** The tagline, set lighter and much wider than the word. */
const TAGLINE = 'THE GRID IS THE PROGRAM';
export const TAG_SIZE = 15;
export const TAG_TRACKING = 13.659;
const TAG_BASELINE = 225;
/** The tagline is centred on the belt's midpoint rather than left aligned. */
const TAG_CENTRE_X = 440;
const TAG_WEIGHT = 400;

/** The amber item: an 18 unit square standing in for the tittle of the `i`. */
const ITEM_SIZE = 18;

/**
 * The judged drawing's hard-coded item rect, kept for ONE purpose: reporting in the emitted
 * header how far the measured anchor moved from it. Nothing is drawn from these numbers, and
 * the measured anchor is never snapped to them.
 */
const JUDGED_ITEM_X = 518.875;
const JUDGED_ITEM_Y = 36.5;

/** The dot grid: three full rows of twenty 4 unit dots on a 40 unit pitch. */
const GRID_X0 = 58;
const GRID_Y0 = 26;
const GRID_PITCH = 40;
const GRID_COLS = 20;
const GRID_ROWS = 3;
const GRID_DOT = 4;

/**
 * The judged drawing's grid was a `<pattern>` tiled into a rect ending at y=148, so its fourth
 * row at y=146 came out as a 2 unit sliver of a 4 unit dot. That is a rendering artefact of a
 * clip rather than a design decision, and this generator drops the row instead of inheriting
 * it. Kept only to name the sliver's height in the header.
 */
const JUDGED_GRID_CLIP_BOTTOM = 148;

/** The belt band and its inner outline, both stadiums (corner radius is half the height). */
const BELT_X = 40;
const BELT_Y = 157;
const BELT_W = 800;
const BELT_H = 36;
const BELT_R = 18;
const BELT_OUTLINE_INSET = 1.5;
const BELT_OUTLINE_W = 3;

/** The nineteen cleats, one diagonal each, rising 11 units over the belt's depth. */
const CLEAT_X0 = 96.5;
const CLEAT_PITCH = 38;
const CLEAT_COUNT = 19;
const CLEAT_BOTTOM = 187;
const CLEAT_TOP = 163;
const CLEAT_RUN = 11;
const CLEAT_W = 3;

/** The empty cell riding the belt: a filled tray with an outlined hole in it. */
const CELL_X = 510.875;
const CELL_Y = 160;
const CELL_W = 34;
const CELL_H = 30;
const CELL_INSET = 4;
const CELL_OUTLINE_W = 2;

/** The two drums the belt runs over, at the ends of the band's centre line. */
const DRUM_Y = 175;
const DRUM_R = 10;
const DRUM_HUB_R = 3;
const DRUM_W = 3;

/* ------------------------------------------------------------------ *
 * The header cut's own constants - phase 80.1's decisions, as numbers
 * ------------------------------------------------------------------ */

// The shipped header height in CSS px lives in `src/chrome/headerLockupMetrics.ts` and is
// imported at the top of this file. It used to be declared here AND in `HeaderLockup.tsx`,
// which meant this generator could report the drawing's CSS-px sizes at a height the app no
// longer rendered it at (code review 80.1 WR-01). See that module for the whole argument.

/** The plate's padding around the belt, in drawing units (D-06). */
const PAD = 12;

/**
 * The plate's corner radius, in drawing units (D-04). Four corner arcs, never two caps: see
 * `roundedRectPath`, and see `stadiumPath` for why it cannot be asked to draw this.
 */
const PLATE_R = 16;

/**
 * The tagline's outlined cap box in the 880x260 brand drawing, MEASURED in phase 80.1.
 *
 * Kept as a constant so the emitted header quotes the measurement D-02 was decided on rather
 * than a sentence about it: at `HEADER_PX` the band is `TAG_CAP_BAND * HEADER_PX / VIEW_H`
 * CSS px, which is what the drop is justified by. Nothing is drawn from it.
 */
const TAG_CAP_BAND = 12.48;

/** The lockup height in CSS px at which that band would reach `TAG_TARGET_CAP_PX` (D-02). */
const TAG_LEGIBLE_PX = 173;

/** A marginal cap height in CSS px, the bar D-02 measured the tagline against. */
const TAG_TARGET_CAP_PX = 8;

/**
 * The measured WCAG contrast ratios the paint decisions turn on (D-03, D-06), recorded here
 * so the emitted header ships the number beside the decision instead of the claim alone.
 */
const LANE_ON_TOOLBAR = 1.0;
const LANE_ON_PLATE = 1.64;
const STRUCTURE_ON_LANE = 5.16;
const NEXT_RAMP_ON_LANE = 1.57;

/* ------------------------------------------------------------------ *
 * Font identity - read from NOTICE.md, asserted against the binary
 * ------------------------------------------------------------------ */

export interface FontPins {
  sha256: string;
  bytes: number;
}

/**
 * The `## MartianMono.woff2` section's two pinned facts, parsed by name.
 *
 * Throws naming the missing line rather than returning a partial: a regex that quietly failed
 * to match would leave the assertion below comparing a value against `undefined`, which is the
 * shape of a check that cannot fail. If `NOTICE.md` is reflowed, this throws by name and the
 * regex is what gets corrected.
 */
export function readFontPins(noticeText: string): FontPins {
  const match =
    /## MartianMono\.woff2[\s\S]*?- \*\*SHA-256:\*\* ([0-9a-f]{64})[\s\S]*?- \*\*Size:\*\* ([\d,]+) bytes\./.exec(
      noticeText,
    );
  if (match === null) {
    throw new Error(
      'build-lockup: NOTICE.md has no "## MartianMono.woff2" section carrying both a ' +
        '"- **SHA-256:** <hex>" line and a "- **Size:** <n> bytes." line. The generator reads ' +
        'the font pins from that section by name and will not fall back to a literal.',
    );
  }
  return { sha256: match[1]!, bytes: Number(match[2]!.replace(/,/g, '')) };
}

/** Read the font bytes and assert they are the binary `NOTICE.md` pins. */
function readPinnedFont(): { bytes: Buffer; pins: FontPins } {
  const bytes = readFileSync(FONT_PATH);
  const pins = readFontPins(readFileSync(NOTICE_PATH, 'utf8'));
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== pins.sha256) {
    throw new Error(
      `build-lockup: MartianMono.woff2 hashes ${actual}, NOTICE.md pins ${pins.sha256}. ` +
        'The binary and its provenance record disagree; neither is edited to match the other ' +
        'without a decision.',
    );
  }
  if (bytes.length !== pins.bytes) {
    throw new Error(
      `build-lockup: MartianMono.woff2 is ${bytes.length} bytes, NOTICE.md pins ${pins.bytes}.`,
    );
  }
  return { bytes, pins };
}

/* ------------------------------------------------------------------ *
 * Outline geometry
 * ------------------------------------------------------------------ */

/** Three decimal places, the precision the judged drawing's own coordinates carry. */
export function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Thousands separators, so the header quotes the byte size the way NOTICE.md does. */
function grouped(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Split a glyph's command list into contours, one per `moveTo`.
 *
 * This is how the tittle of the `i` is dropped: it is a second contour sitting entirely above
 * the x-height, and the generator simply does not emit it. No knockout rectangle is painted
 * over it, which is what the judged drawing did and what left 2,181 floating pixels the moment
 * the artwork sat on anything but its own dark plate.
 */
export function contours(commands: PathCommand[]): PathCommand[][] {
  const out: PathCommand[][] = [];
  for (const c of commands) {
    if (c.command === 'moveTo') out.push([]);
    const current = out[out.length - 1];
    if (current === undefined) {
      throw new Error(`build-lockup: glyph outline opens with ${c.command} rather than moveTo`);
    }
    current.push(c);
  }
  return out;
}

export interface Extent {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** The bounding box of one contour, in font units with y pointing up. */
export function contourBox(contour: PathCommand[]): Extent {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const c of contour) {
    for (let i = 0; i + 1 < c.args.length; i += 2) {
      xs.push(c.args[i]!);
      ys.push(c.args[i + 1]!);
    }
  }
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
  };
}

/**
 * The x-extent of a stem: the vertical edges of the contour that cross its mid-height.
 *
 * For the `i` at weight 500 this is 320 to 446. The serif arm (from x=139) and the foot
 * (to x=627) are excluded because neither is a vertical edge spanning the middle of the
 * letter, which is the whole reason the rule is stated as an edge crossing rather than as the
 * contour's bounding box.
 */
export function stemExtent(contour: PathCommand[]): { minX: number; maxX: number } {
  const box = contourBox(contour);
  const mid = (box.minY + box.maxY) / 2;
  const points: Array<[number, number]> = [];
  for (const c of contour) {
    for (let i = 0; i + 1 < c.args.length; i += 2) points.push([c.args[i]!, c.args[i + 1]!]);
  }
  const xs: number[] = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    if (a[0] === b[0] && Math.min(a[1], b[1]) < mid && Math.max(a[1], b[1]) > mid) xs.push(a[0]);
  }
  if (xs.length === 0) {
    throw new Error('build-lockup: no vertical edge crosses the contour mid-height; no stem');
  }
  return { minX: Math.min(...xs), maxX: Math.max(...xs) };
}

/**
 * One contour into SVG space: scaled by size/unitsPerEm, y flipped about the baseline.
 *
 * The font's y points up from the baseline and SVG's points down from the top, so
 * `svgY = baseline - fontY * scale`. Commands are emitted in input order, so the emitted `d`
 * is a pure function of the outline and carries no set-like ambiguity.
 */
export function emitContour(
  contour: PathCommand[],
  penX: number,
  baseline: number,
  size: number,
  unitsPerEm: number,
): string {
  const s = size / unitsPerEm;
  const pt = (c: PathCommand, i: number): string =>
    `${round3(penX + c.args[i]! * s)} ${round3(baseline - c.args[i + 1]! * s)}`;
  let d = '';
  for (const c of contour) {
    if (c.command === 'moveTo') d += `M${pt(c, 0)}`;
    else if (c.command === 'lineTo') d += `L${pt(c, 0)}`;
    else if (c.command === 'quadraticCurveTo') d += `Q${pt(c, 0)} ${pt(c, 2)}`;
    else if (c.command === 'bezierCurveTo') d += `C${pt(c, 0)} ${pt(c, 2)} ${pt(c, 4)}`;
    else if (c.command === 'closePath') d += 'Z';
    else throw new Error(`build-lockup: unhandled path command ${c.command}`);
  }
  return d;
}

/* ------------------------------------------------------------------ *
 * Machine geometry - every primitive re-expressed as path data
 * ------------------------------------------------------------------ */

/** An axis-aligned rectangle, closed. Replaces every `<rect>` in the judged drawing. */
function rectPath(x: number, y: number, w: number, h: number): string {
  return `M${round3(x)} ${round3(y)}H${round3(x + w)}V${round3(y + h)}H${round3(x)}Z`;
}

/**
 * A rounded rectangle whose corner radius is half its height: two straight edges joined by two
 * semicircular caps. Replaces the judged drawing's `rx` attribute, which the brand dialect has
 * no `<rect>` to carry.
 *
 * NOT AN ANALOG OF `roundedRectPath`, AND NOT A PARAMETER CHANGE AWAY FROM ONE. The two `A`
 * commands below are 180 degree caps spanning the full height, so passing a small `r` here
 * draws two enormous partial arcs rather than four corner arcs. The header cut's plate needs
 * corners on a box eleven times taller than its radius; use `roundedRectPath` for that.
 */
function stadiumPath(x: number, y: number, w: number, h: number, r: number): string {
  const left = round3(x + r);
  const right = round3(x + w - r);
  const top = round3(y);
  const bottom = round3(y + h);
  return (
    `M${left} ${top}H${right}A${r} ${r} 0 0 1 ${right} ${bottom}` +
    `H${left}A${r} ${r} 0 0 1 ${left} ${top}Z`
  );
}

/**
 * A rectangle with four corner arcs of radius `r`, closed. The header cut's plate (D-04).
 *
 * The one genuinely new geometry primitive in the header cut. `stadiumPath` looks like it
 * could do this and cannot: its arcs are two semicircular caps, so it has no corners to give.
 * Every coordinate is `round3`ed, in the same style as the two primitives above, because the
 * crop window's own top edge is a measured non-integer.
 */
function roundedRectPath(x: number, y: number, w: number, h: number, r: number): string {
  const left = round3(x);
  const right = round3(x + w);
  const top = round3(y);
  const bottom = round3(y + h);
  const leftIn = round3(x + r);
  const rightIn = round3(x + w - r);
  const topIn = round3(y + r);
  const bottomIn = round3(y + h - r);
  return (
    `M${leftIn} ${top}H${rightIn}A${r} ${r} 0 0 1 ${right} ${topIn}` +
    `V${bottomIn}A${r} ${r} 0 0 1 ${rightIn} ${bottom}` +
    `H${leftIn}A${r} ${r} 0 0 1 ${left} ${bottomIn}` +
    `V${topIn}A${r} ${r} 0 0 1 ${leftIn} ${top}Z`
  );
}

/** A circle as two half-arcs. Replaces every `<circle>` in the judged drawing. */
function circlePath(cx: number, cy: number, r: number): string {
  const l = round3(cx - r);
  const right = round3(cx + r);
  return `M${l} ${cy}A${r} ${r} 0 0 1 ${right} ${cy}A${r} ${r} 0 0 1 ${l} ${cy}Z`;
}

/** The dot grid as one path of `GRID_ROWS * GRID_COLS` square subpaths. */
function gridPath(): string {
  let d = '';
  for (let j = 0; j < GRID_ROWS; j++) {
    for (let k = 0; k < GRID_COLS; k++) {
      d += rectPath(GRID_X0 + k * GRID_PITCH, GRID_Y0 + j * GRID_PITCH, GRID_DOT, GRID_DOT);
    }
  }
  return d;
}

/** The cleats as one path of `CLEAT_COUNT` open diagonals. */
function cleatsPath(): string {
  let d = '';
  for (let i = 0; i < CLEAT_COUNT; i++) {
    const x = CLEAT_X0 + i * CLEAT_PITCH;
    d += `M${round3(x)} ${CLEAT_BOTTOM}L${round3(x + CLEAT_RUN)} ${CLEAT_TOP}`;
  }
  return d;
}

/* ------------------------------------------------------------------ *
 * The type runs
 * ------------------------------------------------------------------ */

export interface WordRun {
  /** The concatenated `d` of every emitted contour, in input-string order. */
  d: string;
  /** The x centre of the `i`'s measured stem, in SVG units. The amber item's x anchor. */
  stemCentreX: number;
  /** The `i` stem's measured extent in FONT units, for the provenance header. */
  stemFontExtent: { minX: number; maxX: number };
  /** The centre of the `i`'s dropped tittle contour, in SVG units. The item's y anchor. */
  tittleCentre: { x: number; y: number };
  /**
   * The topmost EMITTED contour's y, in SVG units, which is the `b`'s ascender.
   *
   * MEASURED SO THE CROP CAN BE REFUSED RATHER THAN ASSUMED (code review 80.1 WR-03).
   * `headerCrop()` anchors the header cut's top edge on the amber item, which is correct only
   * while the item is the topmost thing in the drawing. It is, by 0.474 units, and NOTHING
   * held that: a change to `WORD_WEIGHT`, `WORD_SIZE`, `WORD_BASELINE` or the font binary
   * could move the ascender above the item and crop it out of the shipped header with every
   * gate green. This is the number that makes the margin checkable.
   *
   * TAKEN OVER EVERY POINT INCLUDING OFF-CURVE CONTROL POINTS, because `contourBox` bounds
   * the args rather than the rendered curve. That over-estimates the ink's height slightly,
   * which is the safe direction for a top edge: the refusal fires early rather than late.
   *
   * THE DROPPED TITTLE IS EXCLUDED, because it is not emitted. The amber item stands where it
   * was, which is exactly why the item is the topmost geometry at all.
   */
  topY: number;
}

/** Outline `Fabrico`, dropping the tittle contour and measuring what replaces it. */
export function layoutWord(font: Font): WordRun {
  const upem = font.unitsPerEm;
  const scale = WORD_SIZE / upem;
  const run = font.layout(WORD);
  let d = '';
  let stemCentreX = Number.NaN;
  let stemFontExtent = { minX: Number.NaN, maxX: Number.NaN };
  let tittleCentre = { x: Number.NaN, y: Number.NaN };
  // The topmost EMITTED contour, in SVG units. Called for exactly the contours that reach the
  // `d` string, never for the dropped tittle: see `WordRun.topY` for why that distinction is
  // the whole point. Font y points up and SVG y points down, so the maximum font y is the
  // minimum SVG y.
  let topY = Number.POSITIVE_INFINITY;
  const noteTop = (contour: PathCommand[]): void => {
    topY = Math.min(topY, WORD_BASELINE - contourBox(contour).maxY * scale);
  };
  let pen = WORD_X0;
  run.glyphs.forEach((glyph, k) => {
    const advance = run.positions[k]!.xAdvance;
    if (advance !== MONO_ADVANCE) {
      throw new Error(
        `build-lockup: ${WORD}[${k}] advances ${advance} units, not the monospace ${MONO_ADVANCE}. ` +
          'WORD_TRACKING is derived from that advance, so the layout would silently drift.',
      );
    }
    const parts = contours(glyph.path.commands);
    if (WORD[k] === 'i') {
      const stem = parts.find((c) => contourBox(c).minY < font.xHeight);
      const tittle = parts.find((c) => contourBox(c).minY >= font.xHeight);
      if (stem === undefined || tittle === undefined) {
        throw new Error(
          'build-lockup: the `i` no longer has one contour below the x-height and one above it, ' +
            'so the tittle cannot be identified and the amber item has no anchor.',
        );
      }
      stemFontExtent = stemExtent(stem);
      stemCentreX = pen + ((stemFontExtent.minX + stemFontExtent.maxX) / 2) * scale;
      const tb = contourBox(tittle);
      tittleCentre = {
        x: pen + ((tb.minX + tb.maxX) / 2) * scale,
        y: WORD_BASELINE - ((tb.minY + tb.maxY) / 2) * scale,
      };
      // The tittle is dropped by NOT EMITTING IT. The amber item takes its place.
      noteTop(stem);
      d += emitContour(stem, pen, WORD_BASELINE, WORD_SIZE, upem);
    } else {
      for (const c of parts) {
        noteTop(c);
        d += emitContour(c, pen, WORD_BASELINE, WORD_SIZE, upem);
      }
    }
    pen += (advance * WORD_SIZE) / 1000 + WORD_TRACKING;
  });
  if (!Number.isFinite(stemCentreX)) {
    throw new Error(`build-lockup: ${WORD} carries no \`i\`, so the amber item has no anchor`);
  }
  if (!Number.isFinite(topY)) {
    throw new Error(
      `build-lockup: ${WORD} emitted no contour with a measurable top, so the header crop ` +
        'cannot check that the amber item dominates the wordmark. headerCrop() anchors the ' +
        "cut's top edge on the item alone, and that is only correct while this number exists.",
    );
  }
  return { d, stemCentreX, stemFontExtent, tittleCentre, topY };
}

export interface TagRun {
  d: string;
  /** The run's advance box, from the first pen position to the last glyph's right edge. */
  width: number;
  /** Where the run starts, so it sits centred on `TAG_CENTRE_X`. */
  startX: number;
}

/**
 * Outline `THE GRID IS THE PROGRAM`, centred on the belt's midpoint.
 *
 * Tracking is a per-glyph pen advance rather than an SVG `letter-spacing`, which is what makes
 * the run's width a property of this file instead of a property of whichever rasteriser opens
 * it: librsvg and ImageMagick disagreed about the judged drawing's tagline width by 20.8%.
 */
export function layoutTagline(font: Font): TagRun {
  const upem = font.unitsPerEm;
  const run = font.layout(TAGLINE);
  const pitch = (advance: number): number => (advance * TAG_SIZE) / upem + TAG_TRACKING;
  const width = run.positions.reduce((w, p) => w + pitch(p.xAdvance), 0) - TAG_TRACKING;
  const startX = TAG_CENTRE_X - width / 2;
  let pen = startX;
  let d = '';
  run.glyphs.forEach((glyph, k) => {
    // A space glyph has no contours, so it contributes nothing but its advance.
    for (const c of contours(glyph.path.commands)) {
      d += emitContour(c, pen, TAG_BASELINE, TAG_SIZE, upem);
    }
    pen += pitch(run.positions[k]!.xAdvance);
  });
  return { d, width, startX };
}

/** Where the amber item sits: measured off the emitted `i`, never off a literal. */
export function itemAnchor(word: WordRun): { x: number; y: number } {
  return { x: word.stemCentreX, y: word.tittleCentre.y };
}

/* ------------------------------------------------------------------ *
 * The shared-geometry seam - one source, two paint registers
 * ------------------------------------------------------------------ */

/** One layer's geometry and its PAINT ROLE, with the colour deliberately absent. */
export interface SharedLayer {
  /** The layer's stable handle, emitted as `data-part` in both files. */
  readonly part: string;
  /** The path data, byte-identical in both emitted files. */
  readonly d: string;
  readonly role: 'fill' | 'stroke';
  /** Present iff `role` is `'stroke'`. */
  readonly width?: number;
}

/**
 * The eleven layers both emitted files share, computed ONCE from the module constants.
 *
 * THIS FUNCTION IS THE ANTI-DRIFT PROOF. Both `buildLockupDetailed` and
 * `buildHeaderCutDetailed` read it, so moving `BELT_X` by one unit reddens the brand file's
 * byte comparison and the header cut's together. An emitter that re-derived even one of these
 * paths would leave that path unproved while a mutation still reddened both files for a
 * different reason, which is worse than no proof at all.
 *
 * THE COLOUR IS NOT HERE AND MUST NOT BE. The two files paint the same geometry from two
 * different registers, brand hex against app token, and folding the paint in would either
 * force one file to carry the other's palette or reintroduce the drift this exists to stop.
 * The paint ROLE is here, because it decides the attribute shape rather than the value.
 *
 * The order is the document order both files emit, and the brand file splices its `tagline`
 * between `wordmark` and `item`.
 */
export function sharedLayers(word: WordRun, item: { x: number; y: number }): SharedLayer[] {
  return [
    { part: 'belt-body', d: stadiumPath(BELT_X, BELT_Y, BELT_W, BELT_H, BELT_R), role: 'fill' },
    { part: 'cleats', d: cleatsPath(), role: 'stroke', width: CLEAT_W },
    { part: 'cell-fill', d: rectPath(CELL_X, CELL_Y, CELL_W, CELL_H), role: 'fill' },
    {
      part: 'cell-outline',
      d: rectPath(
        CELL_X + CELL_INSET,
        CELL_Y + CELL_INSET / 2,
        CELL_W - 2 * CELL_INSET,
        CELL_H - CELL_INSET,
      ),
      role: 'stroke',
      width: CELL_OUTLINE_W,
    },
    {
      part: 'belt-outline',
      d: stadiumPath(
        BELT_X + BELT_OUTLINE_INSET,
        BELT_Y + BELT_OUTLINE_INSET,
        BELT_W - 2 * BELT_OUTLINE_INSET,
        BELT_H - 2 * BELT_OUTLINE_INSET,
        BELT_R - BELT_OUTLINE_INSET,
      ),
      role: 'stroke',
      width: BELT_OUTLINE_W,
    },
    {
      part: 'drum-left',
      d: circlePath(BELT_X + BELT_R, DRUM_Y, DRUM_R),
      role: 'stroke',
      width: DRUM_W,
    },
    { part: 'drum-left-hub', d: circlePath(BELT_X + BELT_R, DRUM_Y, DRUM_HUB_R), role: 'fill' },
    {
      part: 'drum-right',
      d: circlePath(BELT_X + BELT_W - BELT_R, DRUM_Y, DRUM_R),
      role: 'stroke',
      width: DRUM_W,
    },
    {
      part: 'drum-right-hub',
      d: circlePath(BELT_X + BELT_W - BELT_R, DRUM_Y, DRUM_HUB_R),
      role: 'fill',
    },
    { part: 'wordmark', d: word.d, role: 'fill' },
    {
      part: 'item',
      d: rectPath(item.x - ITEM_SIZE / 2, item.y - ITEM_SIZE / 2, ITEM_SIZE, ITEM_SIZE),
      role: 'fill',
    },
  ];
}

/**
 * A stroke layer's width, refused BY NAME when absent.
 *
 * `SharedLayer.width` is optional because it is present iff the role is stroke, and an
 * optional read with a fallback would emit `stroke-width="undefined"` into a file that still
 * parses as XML. This throws instead.
 */
function strokeWidthOf(layer: SharedLayer): number {
  if (layer.width === undefined) {
    throw new Error(
      `build-lockup: shared layer '${layer.part}' has role 'stroke' and carries no width, so it ` +
        'would emit stroke-width="undefined". SharedLayer.width is present iff the role is stroke.',
    );
  }
  return layer.width;
}

/**
 * One register's colour for one shared layer, refused BY NAME when the table has no entry.
 *
 * The two paint tables are keyed by `data-part`, so adding a twelfth shared layer without
 * giving it a colour in BOTH registers throws here rather than emitting `fill="undefined"`.
 */
function paintFor(table: Readonly<Record<string, string>>, part: string): string {
  const colour = table[part];
  if (colour === undefined) {
    throw new Error(
      `build-lockup: no paint is registered for the shared layer '${part}'. Every layer ` +
        'sharedLayers() returns needs an entry in BRAND_PAINT and in CUT_PAINT.',
    );
  }
  return colour;
}

/* ------------------------------------------------------------------ *
 * Element emission - ONE set of closures, shared by both emitters
 * ------------------------------------------------------------------ */

/*
 * WHY THESE ARE UP HERE AND NOT INSIDE THE TWO BUILDERS (code review 80.1 WR-04).
 *
 * Both emitters used to declare `path`, `fill`, `stroke` and `layerLine` verbatim, and the
 * header emitter's copy carried the comment "Byte-exact with the brand emitter's own
 * closures: two leading spaces, self-closing, one element per line". That was an assertion
 * held by NOTHING. `sharedLayers()` shares GEOMETRY only, and `headerCut.test.ts` D-3
 * compares the `d` string per `data-part`, so an edit to attribute order, to the spacing, to
 * the self-closing form or to the shape of the stroke attributes in ONE emitter diverged
 * silently: each file's regenerate-and-compare gate is satisfied by regenerating that file.
 * That was the single seam in this phase where the anti-drift argument was asserted rather
 * than mechanised, and it was asserted in a comment sitting on the duplicated code.
 *
 * The shared function IS the enforcement, so the claim is gone with the duplication. What
 * these four hold, which is what the deleted comment described: two leading spaces, one
 * element per line, self-closing, and nothing outside the five-name attribute allowlist.
 * `svgToElements.parseIconParts` throws by name on `<path ...></path>`, and the `path-only`
 * and `one-element-per-line` lint rules refuse any other form independently.
 */

/** One `<path>` line: two leading spaces, self-closing, attributes in a fixed order. */
function pathLine(part: string, d: string, paint: string): string {
  return `  <path data-part="${part}" d="${d}" ${paint} />`;
}

/** A filled layer's paint attributes. */
function fillAttr(colour: string): string {
  return `fill="${colour}"`;
}

/** A stroked layer's paint attributes, including the `fill="none"` the contract requires. */
function strokeAttr(colour: string, width: number): string {
  return `fill="none" stroke="${colour}" stroke-width="${width}"`;
}

/** One shared layer, rendered in one register's colour. The role picks the paint form. */
function layerLine(layer: SharedLayer, colour: string): string {
  return pathLine(
    layer.part,
    layer.d,
    layer.role === 'stroke' ? strokeAttr(colour, strokeWidthOf(layer)) : fillAttr(colour),
  );
}

/** The brand register: the eleven shared layers in `docs/brand/fabrico-lockup.svg`. */
const BRAND_PAINT: Readonly<Record<string, string>> = {
  'belt-body': PANEL_FILL,
  cleats: STRUCTURE_INK,
  'cell-fill': PANEL_FILL,
  'cell-outline': STRUCTURE_INK,
  'belt-outline': STRUCTURE_INK,
  'drum-left': STRUCTURE_INK,
  'drum-left-hub': STRUCTURE_INK,
  'drum-right': STRUCTURE_INK,
  'drum-right-hub': STRUCTURE_INK,
  wordmark: WORD_FILL,
  item: ITEM_FILL,
};

/**
 * The app register: the same eleven layers in `src/chrome/brand/fabrico-header.svg` (D-06).
 *
 * `wordmark` and the belt structure share `fab-ink` here where the brand file gives them two
 * different greys, because the brand greys are brand register and may not paint an app
 * surface, and because on the plate the next ramp step down sits at 1.57:1 and the mechanism
 * stops reading.
 */
const CUT_PAINT: Readonly<Record<string, string>> = {
  'belt-body': CUT_PANEL_FILL,
  cleats: CUT_INK,
  'cell-fill': CUT_PANEL_FILL,
  'cell-outline': CUT_INK,
  'belt-outline': CUT_INK,
  'drum-left': CUT_INK,
  'drum-left-hub': CUT_INK,
  'drum-right': CUT_INK,
  'drum-right-hub': CUT_INK,
  wordmark: CUT_INK,
  item: CUT_ACCENT_ITEM,
};

/**
 * The header cut's viewBox: a crop WINDOW on the lockup's own coordinate space, not a
 * re-origin.
 *
 * Expressing the crop in the viewBox rather than by translating coordinates is what keeps the
 * eleven shared `d` strings byte-identical between the two files, which is what makes "they
 * share one source" checkable at path-string level rather than only through a shared build.
 *
 * EVERY EDGE IS COMPUTED AND NONE IS TYPED. The top edge in particular: `item.y` comes from
 * `itemAnchor(word)`, which is measured off the emitted `i` tittle contour at build time, so
 * a hand-typed top edge would agree with a WRONG measurement. That is the same rule this
 * generator's own header already states for the item: anchored on MEASURED geometry.
 *
 * AND THE TOP EDGE IS ANCHORED ON ONE FEATURE THAT MUST DOMINATE ANOTHER, WHICH IS NOW
 * CHECKED RATHER THAN STATED (code review 80.1 WR-03). Computing the top from the item is
 * correct only while the item is the topmost geometry in the drawing. It is, and the margin is
 * small: measured on the committed cut, the item's top is 36.158 and the wordmark's `b`
 * ascender is 36.632, so there are 0.474 drawing units of clearance, about 0.084 CSS px at the
 * shipped header height. `80.1-UI-SPEC.md` states that fact and nothing held it, so a change to
 * `WORD_WEIGHT`, `WORD_SIZE`, `WORD_BASELINE` or the font binary that raised the ascender by
 * half a unit would crop it out of the shipped header silently, with the crop still computed
 * and every gate still green.
 *
 * THE MARGIN IS ONE AXIS STEP WIDE, WHICH IS WHY THIS IS NOT A THEORETICAL GUARD. Measured
 * across the face's `wght` axis at `WORD_SIZE` 116, the clearance in drawing units is: 500
 * (shipped) +0.474, 600 +0.996, 700 +1.576, and going the other way 400 is ALREADY NEGATIVE at
 * -0.048, 300 at -0.454, 200 at -1.440. The item's y follows the tittle it replaces and the
 * ascender does not, so the two features cross between the shipped weight and the next step
 * down. Instancing the word one step lighter, which is the app's own body weight and the most
 * likely thing anybody tries, clips the `b`. Verified: `WORD_WEIGHT` 500 -> 400 now refuses at
 * build time and reddens `headerCut.test.ts` D-1 and D-4, where before this it emitted a
 * quietly cropped header and every gate stayed green.
 *
 * IT REFUSES RATHER THAN SILENTLY RE-ANCHORING. Taking `Math.min(itemTop, wordTopY)` would
 * keep the drawing whole and move the crop window, which changes a picture the maintainer judged at true
 * size without anyone looking at it. A throw names the two numbers and makes it a decision.
 */
export function headerCrop(
  item: { x: number; y: number },
  wordTopY: number,
): {
  x: number;
  y: number;
  w: number;
  h: number;
} {
  const itemTop = item.y - ITEM_SIZE / 2;
  if (!(itemTop <= wordTopY)) {
    throw new Error(
      `build-lockup: the wordmark's top (${round3(wordTopY)}) now sits above the amber item's ` +
        `top (${round3(itemTop)}), so a crop anchored on the item would clip the ascender out ` +
        'of the shipped header. The item was the topmost geometry by 0.474 units when this ' +
        'crop was judged. Re-anchor the top edge on the topmost geometry rather than on the ' +
        'item, and have the new drawing judged, rather than deleting this refusal.',
    );
  }
  const top = round3(itemTop - PAD);
  return {
    x: round3(BELT_X - PAD),
    y: top,
    w: round3(BELT_W + 2 * PAD),
    h: round3(BELT_Y + BELT_H + PAD - top),
  };
}

/* ------------------------------------------------------------------ *
 * The provenance header
 * ------------------------------------------------------------------ */

/**
 * The file's opening XML comment (MARK-12).
 *
 * Every number here is emitted from the same constant the drawing is built with, so a change
 * to a size or a tracking value moves the artwork and its own documentation together. No token
 * carries its leading dashes and no line contains the two-character sequence that would make
 * the comment illegal XML: `markCraft.test.ts:98-101` states that rule, and plan 80-05 turns
 * it into a lint rule.
 */
function provenanceHeader(
  pins: FontPins,
  faceName: string,
  word: WordRun,
  tag: TagRun,
  item: { x: number; y: number },
): string[] {
  const judgedX = JUDGED_ITEM_X + ITEM_SIZE / 2;
  const judgedY = JUDGED_ITEM_Y + ITEM_SIZE / 2;
  const sliver = round3(JUDGED_GRID_CLIP_BOTTOM - (GRID_Y0 + GRID_ROWS * GRID_PITCH));
  return [
    '<!--',
    '  docs/brand/fabrico-lockup.svg - the Fabrico wordmark lockup, and the PRIMARY BRAND',
    '  ARTEFACT of the project (MARK-08, MARK-16). Every later surface is cut from this file.',
    '  NOTHING IN THE APP IMPORTS IT: no component, no Vite input and no bundle reaches docs/,',
    '  so this drawing is a brand source rather than a shipped asset.',
    '',
    '  GENERATED FILE. Written by frontend/scripts/build-lockup.ts and regenerated rather than',
    '  edited: run npm run build:lockup. frontend/src/render/assets/lockup.test.ts rebuilds it',
    '  in memory and compares byte for byte, so a hand edit reddens the unit suite.',
    '',
    '  ART-04 PROVENANCE: authored from scratch, from the chosen Fabrico mark. No icon pack',
    '  was consulted, copied, traced or redrawn. Nothing here derives from game-icons.net',
    '  (CC-BY-3.0, which redrawing does not clear) or from Remix Icon, whose licence forbids',
    '  logo and trademark use by name.',
    '',
    '  THE TYPE IS OUTLINED, NOT SET. No live text element survives, so this file renders the',
    '  same with no font installed anywhere. The face is what the binary calls itself,',
    `  ${faceName}: a variable font carrying a single wght axis, instanced at`,
    `  ${WORD_WEIGHT} for the word and at ${TAG_WEIGHT} for the tagline.`,
    '',
    '  FONT SOURCE: frontend/src/assets/fonts/MartianMono.woff2, by Evil Martians, licensed',
    '  under the SIL Open Font License 1.1 (OFL-1.1).',
    `    sha256  ${pins.sha256}`,
    `    size    ${grouped(pins.bytes)} bytes`,
    '  The generator asserts both against frontend/src/assets/fonts/NOTICE.md before it reads',
    '  a single outline, and neither value is repeated in the generator as a literal.',
    '',
    `  LAYOUT: the word at size ${WORD_SIZE} with ${round3(WORD_TRACKING)} units of tracking, seven`,
    `  cells from x ${WORD_X0} on a baseline of ${WORD_BASELINE}; the tagline at size ${TAG_SIZE} with`,
    `  ${TAG_TRACKING} units of tracking, its ${round3(tag.width)} unit advance box centred on`,
    `  x ${TAG_CENTRE_X}, on a baseline of ${TAG_BASELINE}.`,
    '',
    '  THE TITTLE OF THE i IS THE AMBER ITEM. The tittle contour is dropped by NOT EMITTING',
    '  IT, never by painting a knockout rectangle over it: the drawing this was re-authored',
    '  from used an opaque knockout, which leaves floating pixels the moment the artwork sits',
    '  on anything but its own dark plate. The amber square that replaces it is anchored on',
    '  MEASURED geometry: its x is the centre of the i stem extent (font units',
    `  ${word.stemFontExtent.minX} to ${word.stemFontExtent.maxX} at weight ${WORD_WEIGHT}), and its y the centre of the measured`,
    `  tittle contour. That lands it at ${round3(item.x)}, ${round3(item.y)}. The judged drawing hard`,
    `  coded ${judgedX}, ${judgedY}. The measured values are kept and the drawing's are not:`,
    `  a difference of ${round3(Math.abs(item.x - judgedX))} units horizontally and ${round3(Math.abs(item.y - judgedY))} units vertically.`,
    '',
    '  ONE ROW OF THE DOT GRID WAS DROPPED ON PURPOSE. The judged drawing tiled a pattern',
    `  whose fourth row, at y ${GRID_Y0 + GRID_ROWS * GRID_PITCH}, was clipped to a ${sliver} unit sliver of a ${GRID_DOT} unit dot by`,
    `  the tiling rect's bottom edge at ${JUDGED_GRID_CLIP_BOTTOM}. A part dot is an artefact of a clip and not a`,
    `  design decision, so this file emits ${GRID_ROWS} full rows of ${GRID_COLS} and stops.`,
    '',
    `  COLOUR REGISTER (docs/brand/README.md): ${STRUCTURE_INK.slice(1)} (belt structure) and ${TAG_FILL.slice(1)} (tagline)`,
    '  are BRAND colours, spent here and on nothing the app itself paints.',
    `  ${PLATE_FILL.slice(1)}, ${PANEL_FILL.slice(1)}, ${WORD_FILL.slice(1)} and ${ITEM_FILL.slice(1)} are LOCKED_SKIN values quoted`,
    '  as literals, because nothing reskins a docs artefact.',
    '',
    '  GEOMETRY: one self-closing path per semantic layer, each carrying its own stable',
    '  data-part; no g, no title, no rect, no circle, no defs, no pattern, no use, no style,',
    '  no text. Arcs and quadratics are legal here: this file lives outside chrome/assets/ and',
    "  is not held to the chrome dialect's integer-coordinate and zero-curve rules.",
    '-->',
  ];
}

/* ------------------------------------------------------------------ *
 * Assembly
 * ------------------------------------------------------------------ */

export interface Lockup {
  svg: string;
  item: { x: number; y: number };
  paths: number;
}

/**
 * The instanced face and the pins it was asserted against.
 *
 * Extracted so BOTH emitters open the font the same way. The order is not a preference:
 * fontkit opens a WOFF2, but `getVariation()` on one returns a font whose table directory is
 * garbage and `layout()` then throws inside `CmapProcessor.findSubtable`. A second emitter
 * re-deriving these three lines is exactly how that gets rediscovered the hard way.
 */
export async function loadFace(): Promise<{ base: Font; pins: FontPins }> {
  const { bytes, pins } = readPinnedFont();
  const ttf = Buffer.from(await decompress(bytes));
  return { base: fontkit.create(ttf), pins };
}

/**
 * Build the lockup's SVG text and report the measured item anchor.
 *
 * Reads the font binary and `NOTICE.md`. Reads NOTHING ELSE, and in particular never reads
 * `LOCKUP_PATH`: `src/render/assets/lockup.test.ts` compares this return value against the
 * committed bytes, and a builder that read those bytes back would make that comparison pass on
 * any file at all.
 *
 * (This docblock was orphaned onto `loadFace` when that function was extracted between it and
 * the function it describes, and was moved back in the 80.1 code review fix pass, WR-05. It is
 * the file's most load-bearing contract statement and it was documenting the wrong function.)
 */
export async function buildLockupDetailed(): Promise<Lockup> {
  const { base, pins } = await loadFace();
  const word = layoutWord(base.getVariation({ wght: WORD_WEIGHT }));
  const tag = layoutTagline(base.getVariation({ wght: TAG_WEIGHT }));
  const item = itemAnchor(word);

  const shared = sharedLayers(word, item);
  const brandLines = shared.map((layer) => layerLine(layer, paintFor(BRAND_PAINT, layer.part)));

  // THE TAGLINE IS SPLICED BETWEEN `wordmark` AND `item`, AND THAT IS NOT COSMETIC: it is the
  // document order the committed file carries, and getting it wrong moves a file whose whole
  // job in this refactor is to not move. The splice point is FOUND rather than indexed, so a
  // change to sharedLayers() throws by name instead of silently reordering the artefact.
  const itemAt = shared.findIndex((layer) => layer.part === 'item');
  if (itemAt < 0) {
    throw new Error(
      'build-lockup: sharedLayers() no longer emits an `item` layer, so the tagline has no ' +
        'splice point and the committed document order cannot be reproduced.',
    );
  }

  const body = [
    pathLine('plate', rectPath(0, 0, VIEW_W, VIEW_H), fillAttr(PLATE_FILL)),
    pathLine('grid', gridPath(), fillAttr(PANEL_FILL)),
    ...brandLines.slice(0, itemAt),
    pathLine('tagline', tag.d, fillAttr(TAG_FILL)),
    ...brandLines.slice(itemAt),
  ];

  const lines = [
    ...provenanceHeader(pins, base.familyName, word, tag, item),
    `<svg viewBox="0 0 ${VIEW_W} ${VIEW_H}" xmlns="http://www.w3.org/2000/svg">`,
    ...body,
    '</svg>',
  ];
  return { svg: `${lines.join('\n')}\n`, item, paths: body.length };
}

/** The lockup's SVG text. The shape `lockup.test.ts` compares against the committed bytes. */
export async function buildLockup(): Promise<string> {
  return (await buildLockupDetailed()).svg;
}

/** Write the lockup to its committed path. The only function that touches `LOCKUP_PATH`. */
export async function writeLockup(): Promise<Lockup> {
  const built = await buildLockupDetailed();
  mkdirSync(dirname(LOCKUP_PATH), { recursive: true });
  writeFileSync(LOCKUP_PATH, built.svg, 'utf8');
  return built;
}

/* ------------------------------------------------------------------ *
 * The header cut - the same geometry, cropped and painted in app tokens
 * ------------------------------------------------------------------ */

/**
 * A token paint's bare name, e.g. `fab-ink` from the reference the file paints with.
 *
 * The emitted provenance header names its tokens through this rather than as literals, so the
 * header and the paint cannot disagree, and so that no line in the comment can be written with
 * the leading dashes by hand. See `headerProvenanceHeader` for why that would be fatal.
 */
function tokenName(paint: string): string {
  return paint.replace(/^var\(-+/, '').replace(/\)$/, '');
}

/**
 * The header cut's opening XML comment.
 *
 * NOT THE BRAND FILE'S HEADER AND NEVER COPIED FROM IT: that one names the tagline, the
 * dropped grid row and the two brand-register greys, and none of the three is true here. Every
 * number is emitted from the constant the drawing is built with, so a change to a size, a
 * padding or a radius moves the artwork and its own documentation together.
 *
 * NO TOKEN CARRIES ITS LEADING DASHES. Two hyphens in a row are illegal inside an XML comment
 * and every strict parser refuses the WHOLE document, so the natural sentence naming a paint
 * as a custom property makes this file unopenable. It also fires the `comment-hyphen` lint
 * rule. The correct text reads wrong and the wrong text reads right, which is why the rule is
 * stated out loud here and why `tokenName` exists. No U+2014 anywhere either.
 */
function headerProvenanceHeader(
  pins: FontPins,
  faceName: string,
  item: { x: number; y: number },
  crop: { x: number; y: number; w: number; h: number },
): string[] {
  // D-02's number, recomputed from the measured band rather than quoted: the band scaled from
  // the 260 unit brand box down to the shipped header height.
  const tagBand = round3((TAG_CAP_BAND * HEADER_PX) / VIEW_H);
  // D-05's number: the crop this drawing WOULD need if it kept the dot grid, whose top row
  // sits at GRID_Y0. The percentage is what dropping the grid returns to the word.
  const cropWithGrid = round3(BELT_Y + BELT_H + PAD - (GRID_Y0 - PAD));
  const gridGain = round3((cropWithGrid / crop.h - 1) * 100);
  return [
    '<!--',
    '  frontend/src/chrome/brand/fabrico-header.svg - the header cut of the Fabrico lockup, the',
    '  drawing the application toolbar wears (MARK-17, phase 80.1). Unlike the brand file this',
    '  is a SHIPPED ASSET: the app imports it and the bundle contains it.',
    '',
    '  GENERATED FILE. Written by frontend/scripts/build-lockup.ts and regenerated rather than',
    '  edited: run npm run build:header-cut.',
    '',
    '  D-07, WHICH IS THE POINT OF THE FILE. This is a token painted CROP of the SAME geometry',
    '  as docs/brand/fabrico-lockup.svg, emitted by the same script from the same constants',
    '  through one shared geometry function. It is NOT an edit to the brand file, and the brand',
    '  file does not move when this one does. Eleven of the twelve paths below carry a d string',
    '  byte identical to the brand file. Only the plate is new geometry, because the crop window',
    '  has its own box and a rounded corner.',
    '',
    `  THE CROP IS COMPUTED, NEVER TYPED: viewBox ${crop.x} ${crop.y} ${crop.w} ${crop.h}. The top edge is`,
    '  the amber item, whose y is measured off the emitted i tittle contour at build time, so a',
    `  hand typed edge would agree with a wrong measurement. The item lands at ${round3(item.x)}, ${round3(item.y)}.`,
    '',
    `  D-02: THE TAGLINE IS DROPPED, ON A MEASUREMENT. At the shipped ${HEADER_PX} px header height`,
    `  the tagline band is ${tagBand} CSS px, which is ${tagBand} device px at ratio 1 and`,
    `  ${round3(tagBand * 2)} at ratio 2. Reaching even a marginal ${TAG_TARGET_CAP_PX} px cap height would take a`,
    `  lockup about ${TAG_LEGIBLE_PX} px tall, five times the header's budget. The layer is ABSENT here`,
    '  rather than painted in a transparent colour: a knockout is the exact defect the brand',
    '  drawing records having removed.',
    '',
    `  D-05: THE DOT GRID IS DROPPED. Keeping it would make this crop ${cropWithGrid} units tall instead`,
    `  of ${crop.h}, so dropping it returns ${gridGain} percent of the word's size at the same header`,
    '  height. At 32 px the dots read as speckle and collide with the letterforms at the cap',
    '  line. They earn their place again at splash or about page scale.',
    '',
    `  D-03: THE PLATE IS THE ${tokenName(CUT_SUBSTRATE)} TOKEN. On the bare toolbar the belt lane is the`,
    `  same value as the toolbar itself, contrast ${LANE_ON_TOOLBAR.toFixed(2)}:1, so the lane has no body and only`,
    `  its outline survives. On this plate the same lane is ${LANE_ON_PLATE}:1 and reads. Nothing was`,
    '  recoloured to achieve it. COROLLARY: the plate is invisible if this cut is ever placed on',
    '  the substrate itself, such as a dialog over the board or a splash screen.',
    '',
    `  D-04: THE PLATE CORNER RADIUS IS ${PLATE_R} DRAWING UNITS, ${round3((PLATE_R * HEADER_PX) / crop.h)} CSS px at the shipped`,
    '  height, drawn as four corner arcs and never as two caps. If the header height ever',
    '  changes the radius must GROW with it rather than stay a fixed unit count, or it stops',
    '  drawing as a curve at all.',
    '',
    `  D-06: THE BELT STRUCTURE TAKES THE ${tokenName(CUT_INK)} TOKEN, ${STRUCTURE_ON_LANE}:1 on the lane. The next`,
    `  ramp step down is ${NEXT_RAMP_ON_LANE}:1, where the cleats and the drums nearly vanish and the belt`,
    `  stops reading as a belt. The plate padding is ${PAD} drawing units.`,
    '',
    `  COLOUR REGISTER (docs/brand/README.md): every paint here is an app token. ${tokenName(CUT_SUBSTRATE)},`,
    `  ${tokenName(CUT_PANEL_FILL)}, ${tokenName(CUT_INK)} and ${tokenName(CUT_ACCENT_ITEM)}. NEITHER BRAND GREY`,
    '  APPEARS IN THIS FILE, and no token above is written with its leading dashes: two of those',
    '  characters in a row make the whole document illegal XML and no rasteriser will open it.',
    '',
    '  ART-04 PROVENANCE: authored from scratch, from the chosen Fabrico mark. No icon pack',
    '  was consulted, copied, traced or redrawn. Nothing here derives from game-icons.net',
    '  (CC-BY-3.0, which redrawing does not clear) or from Remix Icon, whose licence forbids',
    '  logo and trademark use by name.',
    '',
    '  THE TYPE IS OUTLINED, NOT SET. No live text element survives, so this file renders the',
    `  same with no font installed anywhere. The face is ${faceName}, instanced at`,
    `  wght ${WORD_WEIGHT} for the word.`,
    '',
    '  FONT SOURCE: frontend/src/assets/fonts/MartianMono.woff2, by Evil Martians, licensed',
    '  under the SIL Open Font License 1.1 (OFL-1.1).',
    `    sha256  ${pins.sha256}`,
    `    size    ${grouped(pins.bytes)} bytes`,
    '  The generator asserts both against frontend/src/assets/fonts/NOTICE.md before it reads a',
    '  single outline.',
    '-->',
  ];
}

export interface HeaderCut {
  svg: string;
  item: { x: number; y: number };
  crop: { x: number; y: number; w: number; h: number };
  paths: number;
}

/**
 * Build the header cut's SVG text, its measured item anchor and its computed crop.
 *
 * Reads the font binary and `NOTICE.md`. Reads NOTHING ELSE, and in particular never reads
 * the committed cut: a builder that read its own output back and returned it would make the
 * regenerate-and-compare gate pass on any file at all, which is this repository's signature
 * defect class rather than a hypothetical.
 *
 * TWELVE PATHS. The lockup's fourteen minus the dot grid (D-05) and the tagline (D-02), both
 * of which are ABSENT rather than painted transparent, plus a plate whose geometry is the
 * rounded crop window rather than the brand file's full-bleed rectangle.
 */
export async function buildHeaderCutDetailed(): Promise<HeaderCut> {
  const { base, pins } = await loadFace();
  const word = layoutWord(base.getVariation({ wght: WORD_WEIGHT }));
  const item = itemAnchor(word);
  const crop = headerCrop(item, word.topY);

  // The element emitters are the SHARED ones at module scope (WR-04). Both files are written
  // by one set of closures, so the two documents cannot diverge in attribute order, spacing or
  // self-closing form; that used to be a comment claiming byte-exactness with a copy of the
  // same code twenty lines up, held by no test.
  const body = [
    pathLine(
      'plate',
      roundedRectPath(crop.x, crop.y, crop.w, crop.h, PLATE_R),
      fillAttr(CUT_SUBSTRATE),
    ),
    ...sharedLayers(word, item).map((layer) => layerLine(layer, paintFor(CUT_PAINT, layer.part))),
  ];

  const lines = [
    ...headerProvenanceHeader(pins, base.familyName, item, crop),
    `<svg viewBox="${crop.x} ${crop.y} ${crop.w} ${crop.h}" xmlns="http://www.w3.org/2000/svg">`,
    ...body,
    '</svg>',
  ];
  return { svg: `${lines.join('\n')}\n`, item, crop, paths: body.length };
}

/** The header cut's SVG text. The shape plan 80.1-02's gate compares against the bytes. */
export async function buildHeaderCut(): Promise<string> {
  return (await buildHeaderCutDetailed()).svg;
}

/** Write the header cut to its committed path. The only function that touches its path. */
export async function writeHeaderCut(): Promise<HeaderCut> {
  const built = await buildHeaderCutDetailed();
  mkdirSync(dirname(HEADER_CUT_PATH), { recursive: true });
  writeFileSync(HEADER_CUT_PATH, built.svg, 'utf8');
  return built;
}

// `import.meta.main` is true only under bare `node scripts/build-lockup.ts`; under Vite and
// vitest it is undefined, so importing this module never writes a file. Deliberately NOT an
// argv comparison: this generator reads no argv at all.
if ((import.meta as ImportMeta & { main?: boolean }).main === true) {
  const built = await writeLockup();
  process.stdout.write(
    `build-lockup  ${built.paths} paths, ${built.svg.length} bytes, ` +
      `item centre ${round3(built.item.x)} ${round3(built.item.y)}\n`,
  );
  if (built.paths === 0) process.exitCode = 1;
}
