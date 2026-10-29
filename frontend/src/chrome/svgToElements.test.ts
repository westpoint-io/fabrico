// svgToElements.test.ts (CHROME-01, plan 59-01) - the spec for the PURE text parser
// and React element builder that puts an authored `.svg` into the DOM.
//
// NO `@vitest-environment` DOCBLOCK, AND THAT IS THE POINT. This spec runs on the
// project default `environment: 'node'`, with no DOM at all, because the module under
// test must not need one. All sixteen chrome component specs run on that default, so a
// module-scope `DOMParser` in `svgToElements.ts` would throw at IMPORT in every one of
// them - and the purity is also the seam the on-disk shared-file gate (plan 59-02) feeds
// scratch bytes to. A parser that reached for the browser's markup parser could not be
// handed a string from a temp file in a node spec.
//
// The element half is asserted by walking the returned `{ type, props }` descriptors
// directly (`PortIndicator.test.tsx:19-22`'s idiom): no @testing-library/react, no
// react-dom, zero new packages.

import { describe, expect, it } from 'vitest';
import { LOCKED_SKIN } from '../render/synth/skins/locked.ts';
import { colorToCss } from '../../shared/geometry.ts';
import { iconElements, parseIconParts, readAuthorBox } from './svgToElements.ts';

/** The one authored ink every shipped machine asset carries: `ramp[4]`. */
const RAMP4 = colorToCss(LOCKED_SKIN.palette.ramp[4]!);

/** A two-path body, so document ORDER is observable rather than incidental. */
const FIRST = `  <path data-part="alpha" d="M 0 0 H 8" fill="none" stroke="${RAMP4}" stroke-width="2" />`;
const SECOND = `  <path data-part="beta" d="M 0 8 H 16" fill="none" stroke="${RAMP4}" stroke-width="3" />`;

function svgOf(...lines: string[]): string {
  return ['<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">', ...lines, '</svg>'].join(
    '\n',
  );
}

/**
 * A provenance header of the shape every shipped asset carries, and DELIBERATELY a
 * hostile one: it quotes a `viewBox` and a `d` string, exactly as `router.svg`'s real
 * header quotes the illegal `0 0 96 64` box in order to call it illegal. A scanner that
 * read the whole text would parse the counter-example being discussed.
 *
 * IT QUOTES A ROOT `<svg` TAG, and that line is the whole point of the fixture. The
 * superseded version quoted a `viewBox` and a `<path/>` but NOT an `<svg` tag - the one
 * token that defeats an anchor at the first literal `<svg`, and the single most likely
 * thing an author writes in a header describing the root element. Without it the fixture
 * proved only that the anchor lands somewhere after the prose it happened to precede.
 * With it, the two cases below fail on an anchor-only strip and pass on a comment strip.
 */
const HOSTILE_HEADER = [
  '<!--',
  '  chrome/assets/probe.svg - a header that QUOTES markup in order to discuss it.',
  '  The root looks like <svg viewBox="0 0 64 64"> and a wrong box would be',
  '  viewBox="0 0 96 64", and a wrong part would be',
  '  <path data-part="ghost" d="M 99 99 H 99" fill="none" stroke="#ffffff" />.',
  '-->',
].join('\n');

const OPTS = { strokeWidthScale: 1 } as const;

/* ------------------------------------------------------------------ *
 * parseIconParts - document order
 * ------------------------------------------------------------------ */

describe('parseIconParts emits parts in SOURCE DOCUMENT ORDER', () => {
  it('returns a two-path asset in the order it is written', () => {
    expect(parseIconParts(svgOf(FIRST, SECOND)).map((p) => p.part)).toEqual(['alpha', 'beta']);
  });

  it('REVERSING the two paths in the input reverses the output', () => {
    // Paint order is load-bearing: a later path paints over an earlier one. So any
    // Map, Set or sort between the file and the emitted elements is a defect even when
    // the SET of parts is right, and this is the case that sees it. A `Map` keyed by
    // `data-part` would pass the forward case above and pass this one too, so the
    // discriminator is the pairing: same set, different order, different output.
    expect(parseIconParts(svgOf(SECOND, FIRST)).map((p) => p.part)).toEqual(['beta', 'alpha']);
  });

  it('carries every authored attribute through onto the part', () => {
    const [alpha] = parseIconParts(svgOf(FIRST, SECOND));
    expect(alpha).toEqual({
      part: 'alpha',
      d: 'M 0 0 H 8',
      fill: 'none',
      stroke: RAMP4,
      strokeWidth: '2',
    });
  });
});

/* ------------------------------------------------------------------ *
 * The header strip
 * ------------------------------------------------------------------ */

describe('the provenance header is stripped before anything is scanned', () => {
  it('a docblock quoting a <path> contributes NO part', () => {
    const parts = parseIconParts(`${HOSTILE_HEADER}\n${svgOf(FIRST)}`);
    expect(parts.map((p) => p.part)).toEqual(['alpha']);
  });

  it('a docblock quoting a viewBox contributes NO box', () => {
    // The header quotes `0 0 96 64`; the drawn box is `0 0 32 32`. Reading the header's
    // would silently mis-scale every glyph placed through this box.
    expect(readAuthorBox(`${HOSTILE_HEADER}\n${svgOf(FIRST)}`)).toEqual({ w: 32, h: 32 });
  });
});

/* ------------------------------------------------------------------ *
 * The named refusals - every one of them throws rather than defaulting
 * ------------------------------------------------------------------ */

describe('every malformed input is a NAMED throw, never a silent default', () => {
  it('a <path> with no data-part throws, naming the tag', () => {
    const bad = svgOf('  <path d="M 0 0 H 8" fill="none" stroke="currentColor" />');
    expect(() => parseIconParts(bad)).toThrow(/data-part/);
  });

  it('a <path> with no d throws, naming the tag', () => {
    const bad = svgOf('  <path data-part="alpha" fill="none" stroke="currentColor" />');
    expect(() => parseIconParts(bad)).toThrow(/\bd\b/);
  });

  it('a file declaring ZERO paths throws rather than returning an empty list', () => {
    // An empty part list renders an empty <svg>: a silent, invisible icon that passes
    // every assertion about what it does NOT contain. Same vacuous-pass refusal as
    // `glyphOccupancy.parseParts` and `svgAssets.assertVertexBudget`.
    expect(() => parseIconParts(svgOf())).toThrow(/no <path>/);
  });

  it('a NON-self-closing <path> throws rather than being silently dropped', () => {
    // The scan accepts `<path ... />` only, while `scripts/lint-svg.ts` and Pixi both
    // also accept `<path ...></path>`. Under the superseded regex the long form was
    // SKIPPED, and the zero-path refusal below only fires when every path is dropped -
    // so a MIXED file rendered a silently incomplete icon: the canvas drawing the whole
    // glyph, the DOM drawing part of it, and `icons.test.tsx`'s verbatim gate blind to
    // it because it can only compare the paths that were emitted.
    const long = svgOf('  <path data-part="a" d="M 0 0 H 8" fill="none"></path>');
    expect(() => parseIconParts(long)).toThrow(/not self-closing/);
  });

  it('a MIXED file throws rather than returning the self-closing parts only', () => {
    // The discriminator, and the shape the defect actually took. A file where SOME
    // paths are self-closing satisfies the zero-path refusal, so nothing downstream can
    // tell a truncated part list from a short one.
    const mixed = svgOf(FIRST, '  <path data-part="beta" d="M 0 8 H 16" fill="none"></path>');
    expect(() => parseIconParts(mixed)).toThrow(/not self-closing/);
  });

  it('a file with no parseable root box throws rather than defaulting to 32x32', () => {
    const noBox = '<svg xmlns="http://www.w3.org/2000/svg">\n' + FIRST + '\n</svg>';
    expect(() => readAuthorBox(noBox)).toThrow(/viewBox/);
  });
});

/* ------------------------------------------------------------------ *
 * The CLOSED attribute allowlist - a whitelist, not a sanitiser
 * ------------------------------------------------------------------ */

describe('the attribute allowlist is CLOSED at five entries', () => {
  it('accepts exactly d, fill, stroke, stroke-width and data-part', () => {
    expect(() =>
      parseIconParts(
        svgOf('  <path data-part="a" d="M 0 0 H 8" fill="none" stroke="currentColor" stroke-width="2" />'),
      ),
    ).not.toThrow();
  });

  it('a SIXTH authored attribute throws, NAMING the attribute', () => {
    // T-59-01: the whitelist is what makes an unexpected attribute a loud failure
    // instead of a silent pass-through into the DOM. `opacity` is chosen because it is
    // harmless-looking; the rule must not depend on the attribute being scary.
    const sixth = svgOf(
      '  <path data-part="a" d="M 0 0 H 8" fill="none" stroke="currentColor" stroke-width="2" opacity="0.5" />',
    );
    expect(() => parseIconParts(sixth)).toThrow(/opacity/);
  });

  it('an inline event handler throws by the same rule, naming it', () => {
    const evil = svgOf('  <path data-part="a" d="M 0 0 H 8" fill="none" onload="alert(1)" />');
    expect(() => parseIconParts(evil)).toThrow(/onload/);
  });

  it('a SINGLE-QUOTED sixth attribute throws too - the allowlist reads both dialects', () => {
    // `scripts/lint-svg.ts` accepts both quote styles, so a scanner that read only the
    // double-quoted form did not narrow its input, it went BLIND to part of it: the
    // case above passed while its single-quoted twin produced no match, no throw and a
    // silent drop. A whitelist whose stated property is that it NAMES what it rejects
    // cannot have a silent-drop path (T-59-01).
    //
    // THE ASSERTION NAMES THE ALLOWLIST, not just the attribute, and that is
    // load-bearing rather than fussy. Under the superseded double-quote-only scan this
    // tag yielded NO attributes at all, so it threw "missing data-part or d" - and that
    // message echoes the offending tag, which contains the string `onload`. A bare
    // `toThrow(/onload/)` therefore passed the broken parser for entirely the wrong
    // reason. Measured: with the single-quote branch removed, this case reddens only in
    // this form.
    const evil = svgOf("  <path data-part='a' d='M 0 0 H 8' fill='none' onload='alert(1)' />");
    expect(() => parseIconParts(evil)).toThrow(/carries the attribute 'onload'/);
  });

  it('a SINGLE-QUOTED fill is read, not dropped - a dropped fill renders solid black', () => {
    // The visual half of the same defect, and the reason this is not only a security
    // tidy-up. An SVG <path> with no `fill` attribute defaults to SOLID BLACK, so a
    // dropped `fill='currentColor'` rendered a black blob in the DOM while the lint
    // passed the file, `chrome-ink` read the value fine and Pixi drew it correctly.
    const [p] = parseIconParts(svgOf("  <path data-part='a' d='M 0 0 H 8' fill='currentColor' />"));
    expect(p).toEqual({ part: 'a', d: 'M 0 0 H 8', fill: 'currentColor' });
  });

  it('reads a MIXED-quote tag, since the lint in front of it accepts one', () => {
    const [p] = parseIconParts(
      svgOf(`  <path data-part="a" d='M 0 0 H 8' fill="none" stroke='${RAMP4}' stroke-width="2" />`),
    );
    expect(p).toEqual({ part: 'a', d: 'M 0 0 H 8', fill: 'none', stroke: RAMP4, strokeWidth: '2' });
  });
});

/* ------------------------------------------------------------------ *
 * iconElements - the three rewrites, and the one attribute never touched
 * ------------------------------------------------------------------ */

interface El {
  type: unknown;
  props: Record<string, unknown>;
}

describe('iconElements rewrites exactly three attributes and copies d verbatim', () => {
  it('emits one <path> element per part, in document order', () => {
    const els = iconElements(svgOf(FIRST, SECOND), OPTS) as unknown as El[];
    expect(els.map((e) => e.type)).toEqual(['path', 'path']);
    expect(els.map((e) => e.props['data-part'])).toEqual(['alpha', 'beta']);
  });

  it('copies the d attribute CHARACTER FOR CHARACTER', () => {
    // The verbatim `d` is what makes "icon and canvas share one file" checkable rather
    // than rhetorical. A normaliser that dropped a space would still draw the same
    // shape and would break the claim.
    const d = 'M 0 0 H 8 V 12 L 4 16 Z';
    const els = iconElements(
      svgOf(`  <path data-part="a" d="${d}" fill="none" stroke="currentColor" />`),
      OPTS,
    ) as unknown as El[];
    expect(els[0]!.props.d).toBe(d);
  });

  it('multiplies stroke-width by strokeWidthScale and changes NOTHING else', () => {
    const one = iconElements(svgOf(FIRST), { strokeWidthScale: 1 }) as unknown as El[];
    const two = iconElements(svgOf(FIRST), { strokeWidthScale: 2 }) as unknown as El[];
    expect(one[0]!.props.strokeWidth).toBe(2);
    expect(two[0]!.props.strokeWidth).toBe(4);
    // Everything except strokeWidth is identical between the two renders.
    const without = (e: El): Record<string, unknown> => {
      const { strokeWidth: _drop, ...rest } = e.props;
      return rest;
    };
    expect(without(two[0]!)).toEqual(without(one[0]!));
  });

  it('rewrites an authored ramp ink to currentColor - by VALUE SET, not by a frozen hex', () => {
    // Asserted through the skin rather than against the string `#b0bacb`: a hardcoded
    // comparison stops matching the day a ramp value moves and ships the stale colour
    // into the DOM. Every ramp step is exercised, not just the one the assets use.
    for (const step of LOCKED_SKIN.palette.ramp) {
      const hex = colorToCss(step);
      const els = iconElements(
        svgOf(`  <path data-part="a" d="M 0 0 H 8" fill="${hex}" stroke="${hex}" />`),
        OPTS,
      ) as unknown as El[];
      expect(els[0]!.props.fill, hex).toBe('currentColor');
      expect(els[0]!.props.stroke, hex).toBe('currentColor');
    }
  });

  it('leaves a NON-ramp paint value alone', () => {
    // `none` and a `var(--fab-*)` reference are both legal authored values and neither
    // is a ramp member. A rewrite that swallowed them would turn `fill="none"` into a
    // filled shape.
    const els = iconElements(
      svgOf('  <path data-part="a" d="M 0 0 H 8" fill="none" stroke="var(--fab-ink)" />'),
      OPTS,
    ) as unknown as El[];
    expect(els[0]!.props.fill).toBe('none');
    expect(els[0]!.props.stroke).toBe('var(--fab-ink)');
  });

  it('is DETERMINISTIC: two calls on the same text are structurally equal', () => {
    const text = svgOf(FIRST, SECOND);
    expect(iconElements(text, OPTS)).toEqual(iconElements(text, OPTS));
  });
});
