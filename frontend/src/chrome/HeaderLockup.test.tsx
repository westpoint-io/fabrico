import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { HeaderLockup, readCropBox } from './HeaderLockup.tsx';
import { LOCKED_SKIN } from '../render/synth/skins/locked.ts';
import { skinToCssVars } from '../render/synth/chrome/skinToCssVars.ts';
import { colorToCss } from '../../shared/geometry.ts';

// HeaderLockup.test.tsx - the header cut's inertness and paint contract (MARK-17, phase 80.1,
// plan 80.1-02). Contract row A-3 of `80.1-UI-SPEC.md` and contract row D-6.
//
// MIRRORED FROM `LogoMark.test.tsx` CASE FOR CASE, and that is deliberate rather than lazy.
// The square this component replaces carried exactly these properties, they were gated there,
// and a swap that quietly dropped one would be a regression nothing else in this phase sees.
// Same recursive walk, same memo unwrap, same derived accent set, same order-versus-set guard.
// That file was retired with the square's component on 2026-10-11 (nothing in the app
// rendered the square after MARK-17), so this file now stands on its own; the references to
// it below are history, not pointers to a file in the tree.
//
// IT IS THE GATE ON THE `paintOf` TRAP AT THE COMPONENT EDGE, where
// `render/assets/headerCut.test.ts` gates it at the file edge and the fourth `lint:svg` walk
// gates it at the lint edge. Three nets, deliberately different: the spec beside this one
// measures the COMMITTED bytes, the lint measures the AUTHORED attribute values, and this
// measures what actually reached the DOM after `chrome/svgToElements.ts` had its turn. Only
// this one can see a parser that rewrote a paint on the way through.
//
// THE VITEST ENV IS `node`. No DOM, no testing-library, and the phase's zero-new-packages
// discipline holds. A React function component is a function returning a plain element tree,
// so it is invoked directly and the returned tree walked, exactly as `Toolbar.test.tsx`,
// `PortIndicator.test.tsx` and `PortsSection.test.tsx` do.
//
// IT ASSERTS PAINT ORDER, NOT LAYER MEMBERSHIP. A correct SET of twelve layers in the wrong
// order is a visual defect no membership assertion can see, and order is not cosmetic in SVG:
// paint order IS document order. The stack reads bottom to top as the drawing does, the plate
// beneath the belt beneath the word, with the amber item last so nothing overdraws it.
//
// AND IT ASSERTS INERTNESS IN BOTH DIRECTIONS. `aria-hidden` and `focusable` are asserted
// PRESENT, and `role`, `tabIndex` and every handler prop are asserted ABSENT. The negative
// half is the half that matters: D-12 keeps the lockup inert, the header is not a navigation
// surface, and the failure this catches is a later phase adding a click target by habit
// because a logo in a toolbar usually is one.

// IN-04: HeaderLockup is wrapped in React.memo, whose callable render function lives on
// `.type`. Unwrap it (falling back to the value itself if it is ever a plain function again)
// so the direct-invocation walk keeps working.
const renderLockup = ((HeaderLockup as unknown as { type?: (p: object) => unknown }).type ??
  HeaderLockup) as unknown as (p: object) => unknown;

interface El {
  type: unknown;
  props: Record<string, unknown> & { children?: unknown; style?: Record<string, unknown> };
}

function isEl(x: unknown): x is El {
  return typeof x === 'object' && x !== null && 'props' in x && 'type' in x;
}

/** Every element in the rendered tree, in DOM order (which is PAINT order). */
function collectElements(node: unknown): El[] {
  const out: El[] = [];
  const visit = (n: unknown): void => {
    if (Array.isArray(n)) {
      n.forEach(visit);
      return;
    }
    if (!isEl(n)) {
      return;
    }
    out.push(n);
    visit(n.props.children);
  };
  visit(node);
  return out;
}

/** Every `<path>` in the rendered tree, in DOM order. */
function collectPaths(node: unknown): El[] {
  return collectElements(node).filter((el) => el.type === 'path');
}

/**
 * Every authored paint across the rendered tree - each element's `fill` and then its `stroke`,
 * in DOM order, with the non-paint keyword `none` dropped.
 *
 * BOTH properties, never just `fill`. Six of the cut's twelve paths are strokes carrying
 * `fill="none"` - the cleats, the two outlines and the two drum rings - so a collector that
 * read fills alone would see six of the twelve paints and report a clean pass over the half it
 * could see, with every stroke in the drawing unmeasured.
 */
function collectPaints(node: unknown): string[] {
  const out: string[] = [];
  for (const el of collectElements(node)) {
    for (const key of ['fill', 'stroke'] as const) {
      const v = el.props[key];
      if (typeof v === 'string' && v !== 'none') out.push(v);
    }
  }
  return out;
}

/**
 * The PINNED paint order, bottom to top: the dark plate the whole cut sits on, the belt body
 * and its cleats, the framed cell, the two drums, the word standing on the belt, and the amber
 * item last.
 *
 * TRANSCRIBED FROM `80.1-UI-SPEC.md`'s layer table, which is the contract for this drawing,
 * and NOT read back out of the component: a list derived from the thing it is checking cannot
 * fail. `render/assets/headerCut.test.ts` pins the same twelve names against the committed
 * FILE, so the asset and the component are held to one contract from two directions.
 *
 * THE NAMES ARE DELIBERATELY NOT IN SORTED ORDER, and that is a requirement rather than an
 * accident. Alphabetical would open `belt-body`, `belt-outline`, `cell-fill`; this list does
 * not. The anti-set check in the order case below asserts `[...names].sort()` differs from
 * this, and an order assertion a sorted copy also satisfies cannot distinguish an order from a
 * set.
 */
const PINNED_PART_ORDER: readonly string[] = [
  'plate',
  'belt-body',
  'cleats',
  'cell-fill',
  'cell-outline',
  'belt-outline',
  'drum-left',
  'drum-left-hub',
  'drum-right',
  'drum-right-hub',
  'wordmark',
  'item',
];

/** name -> value for every custom property the runtime chrome emitter declares. */
const EMITTED_TOKENS: ReadonlyMap<string, string> = new Map(
  [...skinToCssVars(LOCKED_SKIN).matchAll(/(--fab-[a-z0-9-]+)\s*:\s*([^;]+);/g)].map((m) => [
    m[1]!,
    m[2]!.trim().toLowerCase(),
  ]),
);

/**
 * THE PAINT EXISTS, NOT MERELY THE PAINT'S SHAPE (code review 80.1 WR-02).
 *
 * EVERY OTHER PAINT GATE IN THE TREE MEASURED SHAPE AND NOTHING ELSE, which made all of them
 * checks that cannot fail against the one-character defect they are most exposed to. The four
 * token names the cut paints with are hand-typed strings in `scripts/build-lockup.ts`, which
 * imports neither `LOCKED_SKIN` nor `skinToCssVars` and so cannot know whether the app
 * declares them. Downstream, `headerCut.test.ts`'s D-6, the two colour cases below and the
 * `chrome-ink` lint rule all tested the same regex, `^var\(--fab-[a-z0-9-]+\)$`.
 *
 * MEASURED, NOT REASONED ABOUT. `CUT_SUBSTRATE` was changed to `var(--fab-substratee)` and the
 * asset regenerated through `npm run build:header-cut`: the unit suite reported 73 of 73
 * passed, `lint:svg` reported 0 violations over all four directories and `tsc` was clean, on a
 * header whose plate paints nothing. An unresolvable `var()` on the inherited `fill` property
 * is invalid at computed-value time, so the path falls back to its parent's colour, which is
 * the flat one-colour smear the whole `paintOf` argument exists to prevent. This assertion
 * is the check that turns that mutation red.
 *
 * WHY THE ACCENT WAS ALREADY SAFE AND THE OTHER THREE WERE NOT. `ACCENT_TOKENS` and
 * `ITEM_ACCENT_TOKENS` are DERIVED from the emitted set, so a typo in the accent name fails
 * membership and reddens; the three ramp tokens are only ever tested for shape and for NOT
 * being an accent, and a token that does not exist satisfies both trivially. That asymmetry is
 * exactly why this is asserted once, by name, over every paint.
 */
function assertEmitted(token: string | null, paint: string): void {
  expect(token, `${paint} is not a --fab-* token reference`).not.toBeNull();
  expect(
    EMITTED_TOKENS.has(token!),
    `${token} is not a custom property skinToCssVars actually declares, so at runtime it ` +
      'resolves to nothing, the declaration is invalid at computed-value time and the layer ' +
      "inherits its parent's colour instead of painting its own",
  ).toBe(true);
}

/**
 * THE ACCENT TOKEN SET, DERIVED AT TEST TIME rather than hand-listed - and the derivation is
 * what makes it a gate instead of a spelling.
 *
 * `ACCENT_VALUES` is every colour the locked skin calls an accent; `ACCENT_TOKENS` is every
 * emitted `--fab-*` custom property whose VALUE is one of them. Written against a single name
 * the assertion below would pass the day somebody repaints the item with a different accent,
 * which is the hole the retired `LogoMark.test.tsx` recorded measuring: the emitter also declares
 * `--fab-focus`, which resolves byte-identically to `--fab-btn-primary`, so a set hand-typed
 * from any spec's prose would have left one accent-valued token outside the gate.
 */
const ACCENT_VALUES: ReadonlySet<string> = new Set(
  Object.values(LOCKED_SKIN.palette.accents).map((c) => colorToCss(c).toLowerCase()),
);
const ACCENT_TOKENS: ReadonlySet<string> = new Set(
  [...EMITTED_TOKENS].filter(([, value]) => ACCENT_VALUES.has(value)).map(([name]) => name),
);

/**
 * THE TOKEN THAT CARRIES THE SKIN'S `item` ACCENT, derived from
 * `LOCKED_SKIN.palette.accents.item` and never typed as a string.
 *
 * WHY THIS EXISTS BESIDE `ACCENT_TOKENS` RATHER THAN INSTEAD OF IT, and the reason transfers
 * from the analog verbatim. The set gate asks WHICH LAYER carries an accent and answers it
 * well: move the amber off the item and onto the belt and the equal-list assertion reddens. It
 * cannot ask WHICH ACCENT, and by construction never will, because `--fab-btn-primary` is
 * itself a member of `ACCENT_TOKENS` - so repainting the item with the blue build accent would
 * leave the accented-part list at `['item']` and the whole unit suite green. The cut depicts an
 * item riding a belt, so it takes the token reserved for exactly that.
 */
const ITEM_ACCENT_VALUE: string = colorToCss(LOCKED_SKIN.palette.accents.item).toLowerCase();
const ITEM_ACCENT_TOKENS: readonly string[] = [...EMITTED_TOKENS]
  .filter(([, value]) => value === ITEM_ACCENT_VALUE)
  .map(([name]) => name)
  .sort();

/** `var(--fab-x)` -> `--fab-x`; anything else -> null. */
function tokenOf(paint: string): string | null {
  const m = /^var\((--fab-[a-z0-9-]+)\)$/.exec(paint.trim());
  return m === null ? null : m[1]!;
}

/**
 * A TypeScript source with its comments removed, so a scan measures the CODE.
 *
 * See the no-hash case at the foot of this file for why the analog's blunt whole-file scan
 * does not transfer to this subject, and for the fixture that proves this function is live
 * rather than trusted.
 */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

describe('the accent token SET is derived from the emitter, and is non-empty', () => {
  // The vacuity refusal for the gate below. An empty or one-element set would make "exactly
  // one accent" trivially satisfiable, and a derivation that silently returned nothing is
  // precisely the shape of a gate that proves a property by looking at nothing.
  it('derives every accent-valued token the emitter declares', () => {
    expect(EMITTED_TOKENS.size).toBeGreaterThan(20);
    expect([...ACCENT_TOKENS].sort()).toEqual([
      '--fab-accent-item',
      '--fab-accent-working',
      '--fab-btn-primary',
      '--fab-destructive',
      '--fab-focus',
    ]);
  });
});

describe('HeaderLockup: one <path> per named layer, in the PINNED paint order (D-7)', () => {
  it('renders exactly one <path> per named layer, no duplicates', () => {
    const parts = collectPaths(renderLockup({})).map((el) => String(el.props['data-part']));
    // AN EQUALITY ON TWELVE, never a floor. Eleven of these twelve still draws a plausible
    // mark: drop the item and the belt runs empty, drop the plate and the word sits on the
    // bare toolbar. A `>=` assertion passes on every one of those, which is the partial-cut
    // failure this phase is most able to ship silently.
    expect(parts).toHaveLength(PINNED_PART_ORDER.length);
    expect(new Set(parts).size, 'every data-part is unique').toBe(parts.length);
  });

  it('emits the twelve data-part values in the PINNED paint order, not merely as a set', () => {
    const parts = collectPaths(renderLockup({})).map((el) => String(el.props['data-part']));
    expect(
      parts,
      'Paint order is document order. The plate is the ground the cut sits on, the belt and ' +
        'its cleats sit on the plate, the word stands on the belt, and the amber item paints ' +
        'last so nothing overdraws it. Reordering the emitter changes the picture, not just ' +
        'the markup.',
    ).toEqual(PINNED_PART_ORDER);
    // The order assertion is only meaningful if it can distinguish an order from a set.
    expect([...parts].sort()).not.toEqual(PINNED_PART_ORDER);
  });
});

describe('HeaderLockup is INERT: no role, no tab stop, no handler (A-3, D-12)', () => {
  it('roots at one <svg> carrying aria-hidden, focusable=false and the brand test id', () => {
    const root = renderLockup({}) as El;
    expect(root.type).toBe('svg');
    expect(root.props['aria-hidden']).toBe('true');
    expect(root.props.focusable).toBe('false');
    expect(root.props['data-testid']).toBe('header-lockup');
    // THE `fab-header-lockup` ASSERTION IS DELETED WITH THE CLASS (code review 80.1 WR-06).
    // It was corrected once already, in plan 80.1-04, to read "the brand hook the toolbar and
    // the DPR baselines select on" - and that reason was verifiably untrue of both. Neither
    // the toolbar nor any spec ever selected it; every live selector is
    // `[data-testid="header-lockup"]`, asserted on the line above. The class's only consumer
    // was the CHROME_CSS plate rule that D-09's supersession deleted, so the tree was carrying
    // an attribute nothing reads and a green assertion with a false justification, which is
    // worse than either alone: the next reader trusts the reason. Both are gone.
    expect(root.props.className, 'the dead brand class is back without a consumer').toBe(
      undefined,
    );
    // Presentational: the visually-hidden <h1> in `Toolbar.tsx` carries the accessible name,
    // so the cut must contribute neither a title element nor an img role.
    expect(collectElements(root).some((el) => el.type === 'title')).toBe(false);
  });

  it('carries no role, no tab stop and no handler prop anywhere in the tree', () => {
    // THE NEGATIVE HALF, AND IT IS THE HALF THAT CATCHES THE LIKELY REGRESSION. `aria-hidden`
    // and `focusable` above say the cut is out of the accessibility tree and out of the tab
    // order. They say nothing about a click handler, and a brand mark in a toolbar is exactly
    // the element somebody later makes clickable "to go home" - which would put an
    // interaction on an element screen readers cannot see and keyboards cannot reach.
    //
    // Over the WHOLE TREE rather than the root alone: a handler on one of the twelve paths is
    // the same defect one level down, and `svgToElements` builds those elements from a closed
    // five-attribute allowlist, so their prop shape is worth asserting rather than assuming.
    const all = collectElements(renderLockup({}));

    // NON-VACUITY. A component that failed to render would make every `for` below iterate
    // over nothing and satisfy all three absences by finding no elements at all.
    expect(all.length, 'the rendered tree is empty, so the absences below prove nothing').toBe(
      PINNED_PART_ORDER.length + 1,
    );

    for (const el of all) {
      expect(el.props.role, 'an element declares an ARIA role').toBeUndefined();
      expect(el.props.tabIndex, 'an element declares a tab stop').toBeUndefined();
      expect(el.props.onClick, 'an element declares a click handler').toBeUndefined();
      const handlers = Object.keys(el.props).filter((k) => /^on[A-Z]/.test(k));
      expect(handlers, `handler props reached the inert lockup: ${handlers.join(', ')}`).toEqual(
        [],
      );
    }
  });
});

describe('HeaderLockup colour: every paint a token, exactly one accent (D-6)', () => {
  it('paints every fill and stroke with a var(--fab-*) reference and never a hex', () => {
    const paints = collectPaints(renderLockup({}));
    // A STATED COUNT rather than `> 0`, and twelve rather than "one per path" by coincidence.
    // Six paths are fills contributing one paint each (plate, belt-body, cell-fill, the two
    // drum hubs, wordmark and item is seven); the other five are strokes whose `fill="none"`
    // the collector drops, contributing their stroke only. Twelve paths, twelve paints - and
    // stating the number is what makes a collector that silently read fills alone visible.
    expect(paints).toHaveLength(PINNED_PART_ORDER.length);
    for (const paint of paints) {
      expect(paint, `${paint} is not a --fab-* token reference`).toMatch(
        /^var\(--fab-[a-z0-9-]+\)$/,
      );
      expect(paint.includes('#'), `${paint} bakes a hex literal`).toBe(false);
      // AND THE TOKEN EXISTS, which the regex above cannot ask (WR-02). See `assertEmitted`:
      // `var(--fab-inkk)` is a well-formed token reference to nothing, and every gate in this
      // tree used to accept it.
      assertEmitted(tokenOf(paint), paint);
    }
    // AND NOT `currentColor`, which is the `paintOf` trap arriving. That function rewrites any
    // authored paint that is a member of the LOCKED_SKIN ramp VALUE SET to `currentColor`, and
    // the cut's plate, lane and ink ARE ramp steps by design. Authoring them as the brand file
    // does would collapse three distinct layers onto ONE inherited colour, silently, with the
    // twelve-path count, the paint order and the structural lint rules all still green.
    expect(paints, 'a ramp hex was authored and the parser collapsed it').not.toContain(
      'currentColor',
    );
  });

  it('carries an accent on EXACTLY one part, over the accent SET rather than one name', () => {
    // THE VACUITY REFUSAL, FIRST AND INSIDE THIS CASE. Membership is tested against
    // ACCENT_TOKENS below, and an emitter that declared no accent at all would make the set
    // empty, find nothing on either side, and satisfy the equality with an empty list on a cut
    // that had lost its accent entirely. Asserting the set is non-empty before it is used is
    // what stops "exactly one accent" being provable by looking at nothing. The describe above
    // proves the derivation's exact membership; this proves it is live where it is read.
    expect(
      ACCENT_TOKENS.size,
      'the accent set derived from the emitter is empty, so accent membership below would be ' +
        'decided by looking at nothing',
    ).toBeGreaterThan(0);
    const accented = collectPaths(renderLockup({})).filter((el) => {
      for (const key of ['fill', 'stroke'] as const) {
        const v = el.props[key];
        if (typeof v !== 'string') continue;
        const token = tokenOf(v);
        if (token !== null && ACCENT_TOKENS.has(token)) return true;
      }
      return false;
    });
    // AN EQUAL LIST, NOT A COUNT. A count of 1 is unchanged when the accent moves off the item
    // and onto the belt body; the list names WHICH layer carries it, so moving it reddens.
    expect(
      accented.map((el) => String(el.props['data-part'])),
      'The item is the ONLY accent in the cut. The plate, the lane and the ink are ramp steps ' +
        '(D-03, D-06), and the accent reserve exists so the one amber square reads as the ' +
        'thing the belt is carrying.',
    ).toEqual(['item']);
  });

  it('paints the item layer with the ITEM accent token BY NAME, not merely with some accent', () => {
    // THE VACUITY REFUSAL, before the derivation is used. An empty list would leave nothing to
    // compare against; a list longer than one would mean the skin declares the same colour
    // under two names and the assertion below would be accepting a choice rather than pinning
    // an identity. Either way the comparison would stop discriminating.
    expect(
      ITEM_ACCENT_TOKENS,
      `the locked skin's item accent (${ITEM_ACCENT_VALUE}) is not carried by EXACTLY one ` +
        'emitted --fab-* token: at zero the assertion below compares the cut against nothing, ' +
        'and above one it accepts a choice of names instead of pinning one',
    ).toHaveLength(1);
    const expected = ITEM_ACCENT_TOKENS[0]!;
    // And it must be an accent, so this case sits strictly INSIDE the accent gate above rather
    // than beside it: it narrows "some accent" to "this accent".
    expect(ACCENT_TOKENS.has(expected), `${expected} is not in the derived accent set`).toBe(true);

    const item = collectPaths(renderLockup({})).find((el) => el.props['data-part'] === 'item');
    expect(item, 'the cut has no data-part="item" path, so there is nothing to measure').toBeDefined();

    const tokens = (['fill', 'stroke'] as const)
      .map((key) => item!.props[key])
      .filter((v): v is string => typeof v === 'string' && v !== 'none')
      .map(tokenOf);
    expect(
      tokens,
      'The cut depicts an item riding a belt, so it is painted with the token reserved for ' +
        'exactly that - not with the build accent. The set gate above cannot see this, ' +
        'because the build accent is a member of that set too.',
    ).toEqual([expected]);
  });

  it('keeps the cut on the ramp everywhere else', () => {
    const paints = collectPaths(renderLockup({}))
      .filter((el) => el.props['data-part'] !== 'item')
      .flatMap((el) => [el.props.fill, el.props.stroke])
      .filter((v): v is string => typeof v === 'string' && v !== 'none');
    // NON-VACUITY: eleven non-item layers, so the loop below runs over eleven paints rather
    // than over a filter that matched nothing.
    expect(paints).toHaveLength(PINNED_PART_ORDER.length - 1);
    for (const paint of paints) {
      const token = tokenOf(paint);
      // EXISTENCE BEFORE NON-MEMBERSHIP, AND THIS IS THE LOOP WR-02 WAS ACTUALLY ABOUT. The
      // line below asks whether the token is an accent and wants the answer no. A token the
      // emitter never declares answers no, so on its own that assertion is SATISFIED by a
      // paint that resolves to nothing at all - the one case it most needs to catch, since
      // these eleven non-item layers are the three ramp tokens no other derivation covers.
      assertEmitted(token, paint);
      expect(ACCENT_TOKENS.has(token!), `${paint} is an accent on a non-item layer`).toBe(false);
    }
  });

  it('never bakes a raw hex literal into the component CODE either', () => {
    // THE SECOND NET, AND DELIBERATELY A DIFFERENT ONE. The assertions above measure the
    // EMITTED values, which is where a hex in the asset would surface; this measures the
    // component file, which is where a hex would surface if somebody stopped reading the asset
    // and hand-wrote a paint back into the `.tsx`. Neither subsumes the other.
    //
    // ONE DIVERGENCE FROM THE ANALOG, AND IT IS A DELIBERATE STRENGTHENING RATHER THAN A
    // LOOSENING. The retired `LogoMark.test.tsx` (removed 2026-10-11) scanned the WHOLE file
    // for a hash character, which was sound there only because `LogoMark.tsx` carried no prose
    // about colour. `HeaderLockup.tsx` (its "THE PAINT IS TOKENS, NOT HEX" paragraph)
    // documents the `paintOf` trap by NAMING the three ramp hexes that must never be
    // authored - which is the single most useful paragraph in that file, because the failure
    // it prevents is invisible. A whole-file scan would fail on it, and
    // the only available repairs are deleting the explanation or exempting the file. Both
    // trade real documentation for a spelling.
    //
    // So the scan runs over the CODE. That is the property actually worth holding: a comment
    // cannot paint anything, and an authored paint is code by definition.
    const src = readFileSync(new URL('./HeaderLockup.tsx', import.meta.url), 'utf8');
    expect(codeOnly(src).includes('#'), 'a hex literal reached the component code').toBe(false);

    // AND THE STRIPPER IS PROVED LIVE, not trusted. A `codeOnly` that returned the empty
    // string - or that stripped too greedily and swallowed the file - would satisfy the line
    // above on any input whatever, which is the same defect class this whole spec exists to
    // stay outside of. The fixture carries a hex in each of the three positions and the
    // expectation names which one must survive.
    const fixture = [
      '// a line comment naming #1b1f27',
      '/* a block comment naming #3b4250 */',
      'const authored = "#b0bacb";',
    ].join('\n');
    expect(codeOnly(fixture)).toContain('#b0bacb');
    expect(codeOnly(fixture)).not.toContain('#1b1f27');
    expect(codeOnly(fixture)).not.toContain('#3b4250');
    // And it does not eat the file it is given: the component's own declaration survives.
    expect(codeOnly(src)).toContain('export const HeaderLockup');
  });
});

describe('readCropBox refuses a box it cannot size the lockup from (WR-08)', () => {
  // WHY THIS DESCRIBE EXISTS. `readCropBox` is exported and was covered by nothing. Its own
  // refusal message frames it as THE safe reader for the crop dialect, and it validated one
  // of the four numbers it returns: the height, and only because a zero divides. The other
  // three flowed straight out of `Number()`, which turns the regex's happily matched `1.2.3`
  // into NaN without a word. A NaN width reaches `HEADER_PX * (w / h)` and the emitted
  // viewBox string, so the lockup renders unsized instead of failing loudly, which is the
  // failure mode every other refusal in that module exists to prevent.

  it('reads the COMMITTED cut to four finite numbers, so the refusals below mean something', () => {
    // THE POSITIVE CONTROL. Every case below asserts a throw, and a `readCropBox` that threw
    // on everything would satisfy all of them while breaking the app at import. This proves
    // the reader accepts the real asset.
    //
    // NO TRANSCRIBED EDGE VALUES, deliberately, which is `HeaderLockup.tsx`'s own stated rule:
    // the four numbers are `headerCrop()`'s computed output, and pinning them here would put a
    // transcription in a spec that has to agree with a measurement. `headerCut.test.ts` D-1
    // compares the whole file against a fresh build, which is where that claim belongs.
    const box = readCropBox(readFileSync(new URL('./brand/fabrico-header.svg', import.meta.url), 'utf8'));
    for (const [name, value] of Object.entries(box)) {
      expect(Number.isFinite(value), `the committed cut's ${name} did not parse`).toBe(true);
    }
    expect(box.h > 0, 'the committed cut has no positive height').toBe(true);
    expect(box.w > 0, 'the committed cut has no positive width').toBe(true);
  });

  it('refuses a viewBox number the regex matches and Number() cannot parse', () => {
    // `1.2.3` matches `(-?[\d.]+)` and yields NaN. The width is the dangerous one: it is the
    // numerator of the rendered width, so it silently sizes the header at NaN.
    const svg = '<svg viewBox="28 24.158 1.2.3 180.842" xmlns="http://www.w3.org/2000/svg" />';
    expect(() => readCropBox(svg)).toThrow(/viewBox's w parsed to NaN/);
  });

  it('refuses a bare dot in the origin, which is the same hole one group along', () => {
    // Named separately rather than looped, because a guard written for the width alone would
    // pass the case above and fail this one, and that is exactly the shape of the finding.
    const svg = '<svg viewBox=". 24.158 824 180.842" xmlns="http://www.w3.org/2000/svg" />';
    expect(() => readCropBox(svg)).toThrow(/viewBox's x parsed to NaN/);
  });

  it('still refuses a document with no parseable viewBox at all', () => {
    // The pre-existing refusal, kept under test so the new loop cannot be mistaken for it.
    expect(() => readCropBox('<svg xmlns="http://www.w3.org/2000/svg" />')).toThrow(
      /no parseable four-number viewBox/,
    );
  });

  it('does not read a viewBox out of the provenance comment', () => {
    // The comment strip is load-bearing and is asserted rather than assumed: the emitted cut
    // opens with seventy lines of provenance that quote its own crop back at the reader, so a
    // scan over the whole text could size the drawing from prose. The fixture quotes a
    // DIFFERENT box in a comment than the one on the root.
    const svg = [
      '<!-- THE CROP IS COMPUTED: viewBox 1 2 3 4 -->',
      '<svg viewBox="28 24.158 824 180.842" xmlns="http://www.w3.org/2000/svg" />',
    ].join('\n');
    expect(readCropBox(svg)).toEqual({ x: 28, y: 24.158, w: 824, h: 180.842 });
  });
});
