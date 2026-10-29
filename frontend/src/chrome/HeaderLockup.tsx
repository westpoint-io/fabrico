// HeaderLockup.tsx - the header cut of the Fabrico lockup (MARK-17, SHELL-03, phase 80.1).
//
// WHAT THIS REPLACES, AND WHY THE REPLACEMENT IS NOT A RESKIN. Until this plan the
// application header drew the product name TWICE: a 32u square (the retired `LogoMark`
// component, removed 2026-10-11 once nothing rendered it) beside a
// visible `<h1>` reading FABRICO in Sono all-caps. Two typefaces, two claims to the same
// name, and neither of them the drawing that was judged. This component draws the name ONCE,
// as outlined geometry, inside the lockup chosen in Phase 79: the word standing on a
// belt, on its own dark plate, with the tagline dropped. The accessible name does not
// live here at all any more; it moved to a visually-hidden `<h1>` that is a direct child
// of `<header>` (D-11), and this element is `aria-hidden` exactly as the square was.
//
// ONE INLINE <svg> OVER ONE GENERATED ASSET, the chrome glyph idiom. Inline is the only form in which the `--fab-*` custom properties
// resolve: a data URL would freeze the colours at bake time and stop the cut re-skinning
// with the rest of the chrome, and a hand-authored path sitting in a `.tsx` is precisely
// the idiom Phase 59 removed from this directory. The geometry reaches the DOM through
// the same pure parser (`chrome/svgToElements.ts`) every other chrome glyph uses.
//
// FOUR PLACES THIS COMPONENT DEPARTS FROM THE CHROME GLYPH CONVENTION, EACH FOR A MEASURED
// REASON.
//
//   1. THE SOURCE IS A `?raw` IMPORT, NOT THE `chrome/assets/` REGISTRY ACCESSOR. That
//      accessor serves the registry table, whose fifteen rows are the chrome GLYPH set:
//      icons authored in a 32u, 64u or 96u box, linted under the icon rules, counted by
//      `EXPECTED_CHROME_ASSET_COUNT` in two places. The header cut is none of those
//      things. It is a generated brand artefact at an 824x180.842 crop window, it lives
//      in the sibling directory `chrome/brand/`, and registering it would have moved two
//      asset-count literals to describe a file that is not an icon. `?raw` is a Vite core
//      transform needing no config; `src/chrome/assets/registry.ts` and
//      `src/render/svgAssets.ts` already resolve it from two other directories, under
//      Vite AND under vitest with `environment: 'node'`, so a third directory adds no
//      machinery and no ambient declaration (`vite/client`, via `src/vite-env.d.ts`).
//
//   2. `svgToElements`'s ICON AUTHOR-BOX READER IS NOT USED, AND THAT IS A FINDING RATHER
//      THAN A PREFERENCE. It matches `/viewBox="0 0 (\d+) (\d+)"/`: it demands a `0 0`
//      origin and INTEGER extents. This file's box is `28 24.158 824 180.842`, a crop
//      WINDOW onto a larger drawing, so its origin is non-zero on both axes and its
//      extents are non-integer on one. That reader would throw on a perfectly correct
//      file, at import, in every spec that loads this module. `readCropBox` below is the
//      reader for this dialect. Nothing about the icon reader is wrong; it is answering a
//      different question, about a glyph authored IN the box it renders at.
//
//   3. THE REFUSAL IS ABOUT SHAPE, NOT ABOUT A REMEMBERED VALUE. A chrome glyph can compare
//      its asset's box against a constant because its author box IS its rendered box, so
//      `32u` is a contract rather than a transcription. Here the four crop numbers
//      are `headerCrop()`'s COMPUTED output: its top edge is derived from the amber item's
//      centre, which the generator measures off the emitted `i` tittle contour at build
//      time. Pinning those numbers here as a string literal would put a transcribed value
//      in the app that has to agree with a computed value in the generator, and a
//      transcription can be right for the wrong reason. Worse, it would silently distort
//      the drawing if the crop ever moved, because the rendered width is a function of the
//      box aspect. So this module PARSES the box and refuses on shape: the box parses at
//      all, its height is greater than zero, and the file declares exactly twelve paths.
//      The claim that the committed box equals a fresh `headerCrop()` is machine-checked
//      where it belongs, against the generator, in `render/assets/headerCut.test.ts`.
//
//   4. `strokeWidthScale: 1` IS PASSED, AND THE PROP'S OWN DOCBLOCK ARGUES AGAINST IT HERE.
//      (The retired square passed the same value for the opposite reason: its author box was
//      its icon box, so the inverse placement scale WAS 1.) See the comment at the call site.
//
// THE WHOLE CUT IS ANTI-ALIASED, AND D-09 IS SUPERSEDED IN PLACE RATHER THAN DELETED.
// This paragraph used to read, and it is quoted rather than removed because the reasoning
// it carried was sound and only its SCOPE was wrong:
//
//   "THE PLATE ARC IS THE ONE RENDERING HINT THAT IS NOT INLINE HERE (D-09). The root
//    below carries `shapeRendering: 'crispEdges'`, the chrome convention, and `CHROME_CSS`
//    scopes `shape-rendering: geometricPrecision` to `[data-part=\"plate\"]` inside
//    `.fab-header-lockup`. The plate is the only path in the cut carrying a curve (a 16u
//    corner radius, 2.831 CSS px at the shipped height) and `crispEdges` renders a corner
//    arc that small as a staircase. ... A CSS declaration beats an inherited presentation
//    attribute at any specificity, so the other eleven paths keep `crispEdges`."
//
// D-09 WAS OVERTURNED BY THE MAINTAINER WHO HAD MADE IT (plan 80.1-04, 2026-09-08), on the
// real WebKitGTK binary, at 8x, in the same breath as approving the lockup: ship as drawn,
// but enable anti-aliasing in the header, for the logo and for any future animation of it.
// That approval is the authority for this change.
//
// WHY THAT IS RIGHT, WHICH IS WORTH WRITING DOWN BECAUSE THE OLD SCOPE LOOKED PRINCIPLED.
// `crispEdges` snaps edges to whole device pixels. That is correct for a glyph whose every
// stroke edge sits on an even unit, so snapping moves nothing (the D-04 justification for the
// retired 32u square, and the case for the chrome icons). It is WRONG for this cut, and not only at the corner arc: the belt structure
// stroke lands at 0.531 CSS px and the cell outline at 0.354 CSS px, both far under one
// device pixel even at a 1.1818 effective device pixel ratio. A sub-pixel stroke under
// `crispEdges` does not become a thin line, it becomes a hard on/off dotted rule - which is
// exactly what the 8x plate showed. The curve was never the only casualty; it was just
// the only one anybody had looked at.
//
// THE HINT IS NOW ONE DECLARATION, ON THE ROOT, INHERITED BY ALL TWELVE PATHS.
// `shape-rendering` is an inherited SVG property and no path carries its own (the
// `svgToElements` allowlist is CLOSED at five attributes and throws by name on a sixth,
// T-59-01, so a per-path attribute was never available anyway). The `CHROME_CSS` rule is
// therefore GONE rather than widened: an inline root declaration and a stylesheet rule
// saying different things about the same tree is two sources of truth waiting to drift.
// `chromeCss.ts` carries the removal record at the point the rule used to sit.
//
// THE PAINT IS TOKENS, NOT HEX, AND THAT IS LOAD-BEARING RATHER THAN TIDY.
// `svgToElements.paintOf` rewrites any authored value that is a member of the
// `LOCKED_SKIN.palette.ramp` VALUE SET to `currentColor`. The cut's plate, lane and ink
// are ramp steps by design (D-03, D-06), so authoring them as `#1b1f27` / `#3b4250` /
// `#b0bacb` would collapse three distinct layers onto ONE inherited colour, silently, with
// every existing gate green. The generator authors `var(--fab-*)` instead, which is not in
// that value set and passes through verbatim. Nothing in this component has to know that,
// and it is written here because the failure it prevents is invisible.
//
// THIS ELEMENT IS INERT (D-12). No ARIA role, no tab stop, no click handler, and it stays
// that way. The square it replaces was inert, the header is not a navigation surface, and
// adding an affordance in a brand phase would be a new interaction surface nobody asked
// for. `aria-hidden="true"` plus `focusable="false"` keeps it out of the accessibility
// tree and out of the tab order in every engine, including the ones where an `<svg>` is
// focusable by default.

import { memo, type CSSProperties, type JSX } from 'react';
import HEADER_CUT_SVG_RAW from './brand/fabrico-header.svg?raw';
import { iconElements, parseIconParts } from './svgToElements.ts';
// The cut's rendered HEIGHT, in CSS px. IMPORTED RATHER THAN DECLARED (code review WR-01):
// `scripts/build-lockup.ts` reads the same constant to compute the CSS-px figures it bakes
// into the shipped asset's provenance header, and until this import existed both files
// declared their own 32 with nothing comparing them, so changing the height here left the
// committed SVG documenting a size it no longer rendered at. The WIDTH is still derived from
// this and the parsed box aspect, never typed.
import { HEADER_PX } from './headerLockupMetrics.ts';

/**
 * The number of paths the cut must declare, asserted for EQUALITY.
 *
 * A floor would not fail on a partial cut: eleven of these twelve paths still draws a
 * plausible mark, missing only its item, or its cleats, or its plate, and a `>=` assertion
 * would pass on every one of those. That is this tree's signature defect class and the
 * refusal below is written as equality specifically to be outside it.
 */
const HEADER_CUT_PART_COUNT = 12;

/**
 * The crop window declared on the emitted cut's root, as four numbers.
 *
 * NOT `svgToElements`'s icon author-box reader, and the difference is the whole reason
 * this function exists. That reader matches `viewBox="0 0 W H"` with integer extents,
 * which is the ICON dialect: a glyph authored in the box it renders at, so that its
 * placement is the identity. This file is a CROP of a larger drawing, so its origin is
 * `28 24.158` and its height is fractional. That reader throws on it, at import, on a
 * correct file.
 *
 * COMMENTS ARE STRIPPED BEFORE THE ROOT IS FOUND, which is `bodyOf`'s WR-02 rule applied
 * again rather than assumed. Every generated asset in this tree opens with a long
 * provenance header that QUOTES its own geometry back at the reader, and this one is
 * seventy lines of exactly that. A scan over the whole text could take a quoted number out
 * of the prose and render the drawing at whatever the header happened to be discussing.
 */
export function readCropBox(svgText: string): { x: number; y: number; w: number; h: number } {
  const body = svgText.replace(/<!--[\s\S]*?-->/g, '');
  const at = body.indexOf('<svg');
  const m =
    at < 0
      ? null
      : /viewBox="(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+)"/.exec(body.slice(at));
  if (m === null) {
    throw new Error(
      'HeaderLockup.readCropBox: no parseable four-number viewBox on the root <svg> of the ' +
        "header cut. This is NOT svgToElements' icon author-box reader and must not be " +
        'replaced by it: that reader matches the regex viewBox="0 0 W H" with INTEGER ' +
        'extents, and the cut is a CROP WINDOW onto a larger drawing, so it has a ' +
        'non-zero origin (the crop starts at the ' +
        "belt's left padding edge and at the amber item's top edge, both computed by " +
        'headerCrop() rather than typed) and a fractional height. The rendered width is ' +
        'derived from this box, so a default would silently distort the drawing.',
    );
  }
  // EVERY EDGE IS CHECKED FOR FINITENESS, NOT ONLY THE HEIGHT (code review 80.1 WR-08). The
  // four capture groups are `(-?[\d.]+)`, which matches `1.2.3` and a bare `.` as readily as a
  // number, and `Number()` turns both into NaN without complaining. Only `h` was guarded,
  // below, and that guard's stated reason is division by zero. A NaN `w` flows into
  // `HEADER_PX * (w / h)` and into the emitted viewBox string and renders an unsized lockup,
  // which is exactly the silent failure this module's refusals exist to convert into a loud
  // one: the docblock above frames this function as the safe reader for the crop dialect, so
  // a partially validated return is a gap in a stated guarantee.
  const box = { x: Number(m[1]), y: Number(m[2]), w: Number(m[3]), h: Number(m[4]) };
  for (const [name, value] of Object.entries(box)) {
    if (!Number.isFinite(value)) {
      throw new Error(
        `HeaderLockup.readCropBox: the viewBox's ${name} parsed to ${value} from ` +
          `"${m[0]}". The rendered width is derived from this box and the box is written ` +
          'back out as the root viewBox, so a non-finite edge would size the lockup at NaN ' +
          'rather than failing. Regenerate with npm run build:header-cut.',
      );
    }
  }
  return box;
}

/**
 * The cut's crop window, read ONCE at module load.
 *
 * Eager and at module scope, for two reasons. It is the memo: IN-04's concern is the 10Hz chrome poll, and re-parsing an 84-line file
 * ten times a second to rebuild immutable React elements is work nobody asked for. And it
 * is the REFUSAL, at import rather than inside a render, so a malformed asset fails the
 * whole module loudly instead of painting an empty box in a running app.
 */
const HEADER_CUT_BOX = readCropBox(HEADER_CUT_SVG_RAW);

/**
 * The cut's twelve parts as React elements, parsed and built ONCE at module load.
 *
 * The shape refusal lives here rather than in `readCropBox` because it is about the FILE
 * and not about the box: a zero-height box would divide the derived width by zero, and a
 * part count other than twelve means the file being imported is not the cut this component
 * was written against.
 */
const HEADER_CUT_PARTS = (() => {
  if (!(HEADER_CUT_BOX.h > 0)) {
    throw new Error(
      `HeaderLockup: the header cut declares a viewBox height of ${HEADER_CUT_BOX.h}. The ` +
        'rendered width is HEADER_PX * (w / h), so a zero or negative height renders the ' +
        'lockup at an infinite or mirrored width rather than failing.',
    );
  }
  const count = parseIconParts(HEADER_CUT_SVG_RAW).length;
  if (count !== HEADER_CUT_PART_COUNT) {
    throw new Error(
      `HeaderLockup: the header cut declares ${count} paths, not ${HEADER_CUT_PART_COUNT}. ` +
        'The count is asserted for EQUALITY rather than as a floor because eleven of the ' +
        'twelve still draws a plausible mark: drop the item, or the cleats, or the plate, ' +
        'and the header renders something that looks like a lockup and is not the one that ' +
        'was judged. Regenerate with npm run build:header-cut rather than editing the file.',
    );
  }
  // strokeWidthScale 1, AND THIS IS THE OPPOSITE OF WHAT `IconRenderOpts.strokeWidthScale`
  // ARGUES FOR. That prop is documented as "the exact INVERSE of the glyph's placement
  // scale", so that every chrome ICON renders at one locked detail weight whatever box it
  // was authored in: a 2u stroke in a 64u box gets scale 2 and lands as 2u again. That rule
  // is right for chrome furniture and wrong here. These strokes are not furniture, they are
  // part of a drawing judged at true size, and they must scale WITH it: the belt
  // outline's 3u lands at 3 * (32 / 180.842) = 0.531 CSS px and the cell outline's 2u at
  // 0.354 CSS px, which is the sub-pixel line work the DPR baselines record. Inverting the
  // placement scale here would render a hairline drawing with icon-weight rails and the
  // lockup would stop being the artefact that was approved. Do not "fix" this to match the
  // docblock.
  return iconElements(HEADER_CUT_SVG_RAW, { strokeWidthScale: 1 });
})();

export interface HeaderLockupProps {
  /** Optional style passthrough (layout only; colour stays a --fab-* token). */
  style?: CSSProperties;
}

/**
 * The Fabrico header lockup: the word `Fabrico` standing on a belt, on a dark plate, with
 * the tagline and the dot grid dropped (D-02, D-05). Twelve paths. Presentational and
 * `aria-hidden`; the visually-hidden `<h1>` in `Toolbar.tsx` carries the accessible name.
 */
// React.memo (IN-04): the only prop is an
// optional layout `style` that the toolbar passes as a stable inline object, unchanged
// across the 10Hz chrome poll re-renders, so memoizing skips rebuilding the root entirely.
export const HeaderLockup = memo(function HeaderLockup({ style }: HeaderLockupProps): JSX.Element {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      data-testid="header-lockup"
      // NO `className` (code review 80.1 WR-06). It carried `fab-header-lockup`, which was
      // the hook for the CHROME_CSS plate rule until plan 80.1-04 deleted that rule with
      // D-09's supersession. After that nothing in the tree selected it: not CHROME_CSS, not
      // Toolbar.tsx, and none of logo.spec.ts, chrome-icons.spec.ts or dpr-crispness.spec.ts,
      // every one of which selects `[data-testid="header-lockup"]`. A class with no consumer
      // and a unit assertion pinning it are two things to keep true for no benefit, so both
      // are gone. The test id is the hook; if a stylesheet ever needs one again, add the class
      // in the commit that adds the rule.
      viewBox={`${HEADER_CUT_BOX.x} ${HEADER_CUT_BOX.y} ${HEADER_CUT_BOX.w} ${HEADER_CUT_BOX.h}`}
      style={{
        // The lockup took this hint first (D-09 superseded, plan 80.1-04): this cut's structure
        // stroke is 0.531 CSS px and its cell outline 0.354 CSS px, and snapping a sub-pixel
        // stroke to whole device pixels turns it into a dotted rule. This comment read "NOT the
        // chrome convention ... Every other chrome glyph takes `crispEdges` because its edges sit
        // on even units"; since plan 91-10 (CHROME-20) every chrome icon takes
        // `geometricPrecision` too, because at a fractional device scale even edges on even units
        // land between device pixels.
        // Inherited by all twelve paths, which is why the CHROME_CSS plate rule is gone. See
        // the docblock. BEFORE the `...style` spread, keeping the chrome glyph passthrough
        // contract: a caller handing in its own shapeRendering still wins.
        shapeRendering: 'geometricPrecision',
        display: 'block',
        // NOT decoration, and the reason is recorded rather than inherited. The brand
        // cluster in `Toolbar.tsx` is a flex row with `minWidth: 0` and `overflow: hidden`,
        // so it can shrink past its own contents and clip them. SHELL-02 wants that clip:
        // the brand cluster is the sanctioned victim when the toolbar is width-starved. An
        // unpinned flex child would be SQUEEZED instead, which shrinks the drawing and
        // clips nothing, and a squeezed lockup is a distorted lockup rather than a
        // partially visible one. Every chrome icon pins for this reason.
        flexShrink: 0,
        verticalAlign: 'middle',
        // DERIVED, never typed. 32 * (824 / 180.842) = 145.807 CSS px at the committed
        // crop. If the crop ever moves, this follows it; a hard-coded width would keep the
        // old aspect and distort the drawing silently.
        width: HEADER_PX * (HEADER_CUT_BOX.w / HEADER_CUT_BOX.h),
        height: HEADER_PX,
        ...style,
      }}
    >
      {HEADER_CUT_PARTS}
    </svg>
  );
});
