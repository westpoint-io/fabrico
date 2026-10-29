// svgToElements.ts (CHROME-01, plan 59-01) - authored `.svg` TEXT in, real React
// `<path>` elements out. The one place the DOM half of the app turns an asset file
// into markup.
//
// THIS MODULE IS PURE, AND THE PURITY IS A GATE SEAM RATHER THAN A STYLE PREFERENCE.
// It imports no `?raw` asset, no registry and no DOM. Three consequences, each of
// which is the reason for one of the others:
//
//   1. NO `DOMParser`, EVER, and no setting of element inner HTML from a string. All
//      sixteen chrome component specs run under vitest's default `environment: 'node'`
//      with no DOM at all, so a module-scope markup parser would throw at IMPORT in
//      every one of them. The parse below is the `glyphOccupancy.parseParts`
//      (`assets/glyphOccupancy.ts:109-123`) idiom extended, which is text-only.
//   2. Because the input is a STRING and not a registry name, the plan-59-02 on-disk
//      shared-file gate can feed this function bytes it just wrote to a scratch copy
//      under the OS temp directory (the WR-10 contract) and compare the emitted markup
//      against the canvas geometry digest. A module that read its own `?raw` import
//      could not be handed a mutated file at all.
//   3. Elements are BUILT from a parsed part list. Nothing in this module concatenates
//      markup or hands a string to the DOM, so an authored file cannot smuggle an
//      element or a handler through (T-59-01). The five-entry attribute allowlist below
//      is a WHITELIST, not a sanitiser: an unexpected attribute is a named throw, never
//      a silent pass-through.
//
// THREE ATTRIBUTES ARE REWRITTEN AND EXACTLY THREE. `fill` and `stroke` become
// `currentColor` when their authored value is a member of the `LOCKED_SKIN.palette.ramp`
// VALUE SET, and `stroke-width` is multiplied by the caller's placement scale. `d` is
// copied character for character and is NEVER touched - that verbatim copy is what makes
// "the icon and the canvas share ONE file" a checkable claim instead of a rhetorical one.

import { createElement, type ReactElement } from 'react';
import { colorToCss } from '../../shared/geometry.ts';
import { LOCKED_SKIN } from '../render/synth/skins/locked.ts';

/**
 * The CLOSED set of attributes an authored `<path>` may carry.
 *
 * A whitelist rather than a blocklist, and the difference is the whole security
 * property: a blocklist has to predict `onload`, `onclick`, `href`, `xlink:href` and
 * whatever the next spec adds, and it fails silently on the one it did not predict. A
 * sixth attribute here - benign or not - is a NAMED failure that names itself.
 */
const ALLOWED_PATH_ATTRS: readonly string[] = ['d', 'fill', 'stroke', 'stroke-width', 'data-part'];

/** The allowlist rendered for a human, joined once so every message reads identically. */
const ALLOWED_LIST = ALLOWED_PATH_ATTRS.join(' / ');

/**
 * Every `LOCKED_SKIN` ramp step as a lowercase CSS hex.
 *
 * A VALUE SET, mirroring `shippedAssets.test.ts`'s ink allowlist, and deliberately not
 * the literal `'#b0bacb'` the shipped assets happen to carry. A frozen literal stops
 * matching the day a ramp value moves and then ships the STALE colour into the DOM,
 * where it no longer desaturates with its disabled button and no longer lifts with its
 * hovered palette item - the two behaviours `currentColor` exists to give.
 */
const RAMP_CSS: ReadonlySet<string> = new Set(
  LOCKED_SKIN.palette.ramp.map((c) => colorToCss(c).toLowerCase()),
);

/** One authored `<path>`, as read off the file. Attribute values are verbatim strings. */
export interface IconPart {
  /** The `data-part` attribute - the stable per-part handle. Unique within a file. */
  readonly part: string;
  /** The `d` attribute, verbatim. Never rewritten anywhere in this module. */
  readonly d: string;
  /** The authored `fill`, if declared. */
  readonly fill?: string;
  /** The authored `stroke`, if declared. */
  readonly stroke?: string;
  /** The authored `stroke-width`, if declared, as its authored TEXT. */
  readonly strokeWidth?: string;
}

/** What a caller must tell the builder about where the glyph is being placed. */
export interface IconRenderOpts {
  /**
   * The multiplier applied to every authored `stroke-width`.
   *
   * It is the exact INVERSE of the glyph's placement scale. A 2u stroke authored in a
   * 64u box is placed into a 32u icon at scale 1/2, so it would render at 1u - half the
   * weight the same stroke gets on a 1x1 subject beside it. Passing
   * `max(boxW, boxH) / 32` here makes it `stroke-width="4"`, which after the placement
   * scale is exactly 2u again. Every subject's glyph therefore renders at the SAME
   * locked detail weight (`59-UI-SPEC.md`, "The stroke arithmetic").
   */
  readonly strokeWidthScale: number;
}

/**
 * The body of the document, with the provenance header stripped.
 *
 * ANCHORED AT THE ROOT TAG (WR-02), the rule `glyphOccupancy.parseParts` and
 * `svgAssets.getAssetBox` both already follow. Every authored asset opens with a long
 * docblock that NAMES other parts and QUOTES other `d` strings and `viewBox` values -
 * `router.svg`'s header quotes the transposed `0 0 96 64` box precisely in order to call
 * it illegal. A scanner that read the whole text would parse the counter-example.
 *
 * COMMENTS ARE REMOVED BEFORE THE ANCHOR IS TAKEN, so the strip is a property of the
 * FORMAT rather than of where the first `<svg` happens to fall. The anchor alone is
 * defeated by the one token a provenance header is most likely to quote: its own root
 * element. A header that writes "the root looks like `<svg viewBox="0 0 64 64">`" becomes
 * the anchor, and every counter-example after it - the quoted illegal box, the quoted
 * ghost `<path/>` - stops being commentary and becomes real markup that paints FIRST.
 * These headers are 30 to 80 lines of exactly that kind of prose. For a chrome asset
 * `icons.tsx`'s 32u author-box refusal contains the blast radius by throwing loudly; for
 * a `render/assets/*.svg` subject the box comes from `svgAssets.getAssetBox`, a different
 * reader, so the ghost path would be emitted into the DOM alongside the real ones.
 */
function bodyOf(svgText: string): string {
  const stripped = svgText.replace(/<!--[\s\S]*?-->/g, '');
  const at = stripped.indexOf('<svg');
  if (at < 0) {
    throw new Error(
      'svgToElements: the text contains no <svg> root tag at all. The parse is anchored at ' +
        'the root so a provenance header cannot contribute markup; without a root there is ' +
        'nothing to anchor to.',
    );
  }
  return stripped.slice(at);
}

/**
 * The AUTHOR BOX, read off the file's own `viewBox`.
 *
 * Mirrors `svgAssets.ts:151-175`, including its refusal: a missing or unparseable box
 * THROWS rather than defaulting to a plausible 32x32. The box is what scales and centres
 * a glyph inside the icon, so a default would render a wrongly-authored asset at a
 * plausible-looking wrong size and report nothing at all.
 */
export function readAuthorBox(svgText: string): { w: number; h: number } {
  const m = /viewBox="0 0 (\d+) (\d+)"/.exec(bodyOf(svgText));
  if (m === null) {
    throw new Error(
      'svgToElements: no parseable viewBox="0 0 W H" on the root <svg>. The author box is ' +
        'what scales and centres the glyph in the icon; a default would silently mis-scale it.',
    );
  }
  return { w: Number(m[1]), h: Number(m[2]) };
}

/**
 * Every `name="value"` or `name='value'` pair inside one tag, in the order they are
 * authored.
 *
 * BOTH QUOTE STYLES, because `scripts/lint-svg.ts:parseSvg` accepts both and a scanner
 * that reads a NARROWER dialect than the gate in front of it does not narrow the input -
 * it goes BLIND to part of it. The superseded pattern matched `name="value"` only, with
 * two consequences and neither was theoretical:
 *
 *   1. THE CLOSED ALLOWLIST WAS NOT CLOSED. `fill='currentColor' onload='alert(1)'`
 *      produced no match, so the sixth-attribute throw never fired and the attribute was
 *      dropped in silence. Nothing is forwarded anywhere, so this was not exploitable -
 *      but the stated security property is a whitelist that NAMES what it rejects
 *      (T-59-01, and the `onload` spec case cited as its mitigation used double quotes),
 *      and a silent drop is the one behaviour a whitelist must not have.
 *   2. A SINGLE-QUOTED `fill` WAS A REAL VISUAL DEFECT. `fill='currentColor'` was
 *      dropped, and an SVG `<path>` with no `fill` attribute defaults to SOLID BLACK. The
 *      lint passed the file, `chrome-ink` read the value fine, Pixi rendered it
 *      correctly, and the DOM icon rendered a black blob.
 *
 * The two alternations are exclusive by construction (a `"`-delimited value cannot
 * contain `"`), so exactly one of the two groups is defined per match.
 */
function attrsOf(tag: string): Map<string, string> {
  const out = new Map<string, string>();
  // The tag name itself is skipped by starting the scan after `<path`.
  for (const m of tag
    .slice('<path'.length)
    .matchAll(/([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    out.set(m[1]!, m[2] ?? m[3]!);
  }
  return out;
}

/**
 * Every authored `<path>` in the file, IN SOURCE DOCUMENT ORDER.
 *
 * ORDER IS LOAD-BEARING, not incidental. SVG paint order is document order: a later
 * path paints over an earlier one. So routing the parts through any `Map`, `Set` or
 * sort keyed on `data-part` would produce the right SET of parts and the wrong picture,
 * and it would do so silently. The list below is an array appended to in match order and
 * is handed on as one.
 *
 * Extends `glyphOccupancy.parseParts` with the closed attribute allowlist; the header
 * strip, the named per-tag throws and the zero-path refusal are carried verbatim from it.
 *
 * THE SELF-CLOSING FORM IS THE ONLY ACCEPTED ONE, AND THE LONG FORM IS NOW A NAMED THROW.
 * The scan used to be `/<path\b[^>]*\/>/g`, which matched self-closing tags and SILENTLY
 * IGNORED `<path ...></path>` - a form `scripts/lint-svg.ts` accepts, `one-element-per-line`
 * is satisfied by when both tags share a line, and Pixi draws. The zero-path refusal below
 * fires only when EVERY path is dropped, so a mixed file produced a silently INCOMPLETE
 * icon: the canvas drawing the whole glyph, the DOM drawing part of it, and nothing
 * reddening, because `icons.test.tsx`'s verbatim gate can only compare the paths that were
 * emitted. That is the "two surfaces silently disagree" failure CHROME-01 exists to remove,
 * at the one seam meant to make it impossible.
 *
 * Closed from BOTH ends rather than by widening this parser. The narrow dialect is now a
 * `path-only` lint violation, so the file never reaches here; and if it does, this refuses
 * by name instead of dropping the part. Widening the parser instead would have made the two
 * accepted dialects agree by making both permissive, which is the weaker of the two fixes
 * for a first-party format.
 */
export function parseIconParts(svgText: string): IconPart[] {
  const body = bodyOf(svgText);
  const out: IconPart[] = [];
  for (const tag of body.match(/<path\b[^>]*>/g) ?? []) {
    if (!tag.endsWith('/>')) {
      throw new Error(
        `svgToElements: <path> is not self-closing: ${tag}. This parser accepts the ` +
          '`<path ... />` form ONLY, while scripts/lint-svg.ts and Pixi both also accept ' +
          '`<path ...></path>` - so the long form would draw on the canvas and vanish from ' +
          'the DOM icon. Close the tag with "/>". The lint refuses this file too ' +
          '(rule `path-only`); this throw is the backstop for text that never went through it.',
      );
    }
    const attrs = attrsOf(tag);
    for (const name of attrs.keys()) {
      if (ALLOWED_PATH_ATTRS.includes(name)) continue;
      throw new Error(
        `svgToElements: <path> carries the attribute '${name}', which is outside the closed ` +
          `allowlist (${ALLOWED_LIST}). The allowlist is a WHITELIST, not a sanitiser: an ` +
          'unexpected attribute is a loud failure rather than a silent pass-through into the ' +
          `DOM. Offending tag: ${tag}`,
      );
    }
    const part = attrs.get('data-part');
    const d = attrs.get('d');
    if (part === undefined || d === undefined) {
      throw new Error(
        `svgToElements: a <path> is missing data-part or d: ${tag}. Both are authored on every ` +
          'path in this repo, and a silently-skipped part is a silently-incomplete icon.',
      );
    }
    const fill = attrs.get('fill');
    const stroke = attrs.get('stroke');
    const strokeWidth = attrs.get('stroke-width');
    out.push({
      part,
      d,
      ...(fill === undefined ? {} : { fill }),
      ...(stroke === undefined ? {} : { stroke }),
      ...(strokeWidth === undefined ? {} : { strokeWidth }),
    });
  }
  if (out.length === 0) {
    throw new Error(
      'svgToElements: the file declares no <path> at all. An empty part list renders an EMPTY ' +
        '<svg> - a silent, invisible icon that satisfies every assertion about what it does not ' +
        'contain. Same vacuous-pass refusal as glyphOccupancy.parseParts.',
    );
  }
  return out;
}

/** An authored paint value, with a ramp member rewritten to `currentColor`. */
function paintOf(value: string): string {
  return RAMP_CSS.has(value.trim().toLowerCase()) ? 'currentColor' : value;
}

/**
 * One authored file's parts as real React `<path>` elements.
 *
 * `data-part` stays kebab (React passes `data-*` through verbatim); `stroke-width`
 * becomes the React prop `strokeWidth`; `d`, `fill` and `stroke` keep their names.
 *
 * The `key` is the part's own `data-part`, which the lint holds unique within a file, so
 * the key set is stable across renders and derived from the artifact rather than from an
 * array index.
 */
export function iconElements(svgText: string, opts: IconRenderOpts): ReactElement[] {
  return parseIconParts(svgText).map((p) => {
    let strokeWidth: number | undefined;
    if (p.strokeWidth !== undefined) {
      const authored = Number(p.strokeWidth);
      if (!Number.isFinite(authored)) {
        throw new Error(
          `svgToElements: part '${p.part}' has a non-numeric stroke-width "${p.strokeWidth}". ` +
            'The width is multiplied by the placement scale, so a value that is not a number ' +
            'would render at NaN and draw nothing.',
        );
      }
      strokeWidth = authored * opts.strokeWidthScale;
    }
    return createElement('path', {
      key: p.part,
      'data-part': p.part,
      // VERBATIM. This is the only attribute in the file that must survive byte for byte.
      d: p.d,
      ...(p.fill === undefined ? {} : { fill: paintOf(p.fill) }),
      ...(p.stroke === undefined ? {} : { stroke: paintOf(p.stroke) }),
      ...(strokeWidth === undefined ? {} : { strokeWidth }),
    });
  });
}
