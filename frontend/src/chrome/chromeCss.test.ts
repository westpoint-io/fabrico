// chromeCss.test.ts (CHROME-02, plan 59-03) - the four CSS walker gates that hold the
// pure-CSS bezel ring's load-bearing properties.
//
// WHY THESE ARE WALKERS AND NOT RENDER TESTS. Three of this phase's defects ship with a
// fully GREEN board: a disabled chunky button whose `box-shadow: none` erases the entire
// frame (no baseline covers a disabled toolbar button), a fifth ring-carrying class an
// earlier reading of the stylesheet missed entirely (the guard-dialog button, which
// would have lost its frame silently), and a panel that is a ring carrier AND a scroll
// container on the same element (the rect gate reads geometry, and no baseline captures
// a SCROLLED panel). None of the three is visible to a geometry assertion or to a
// screenshot of a resting surface. They are visible in the DECLARATIONS, which is where
// these gates look.
//
// COMMENTS ARE STRIPPED BEFORE SCANNING, AND THAT IS LOAD-BEARING. The corrected
// docblocks in this phase legitimately QUOTE the retired constructs by name - that is
// the tree's correct-in-place doctrine, quote the superseded claim rather than silently
// delete it - so a walker that measured prose would be self-invalidating: the act of
// recording the deletion would trip the gate that proves it. Same idiom as
// `ConfigPanel.test.tsx:340-358` and `bitMatrixIdiom.test.ts`.
//
// EVERY ASSERTION HERE WAS MUTATION-PROVED in the plan that added it; the mutations are
// named beside the cases they redden and recorded in 59-03-SUMMARY.md.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHROME_CSS, BEZEL_CLASSES, BEZEL_RING_EXEMPT } from './chromeCss.ts';

/** `frontend/src/chrome/` - this spec lives in it. */
const CHROME_DIR = import.meta.dirname;

/** The composed ring token. A rule "carries the ring" iff its shadow references this. */
const RING_TOKEN = '--fab-bezel-ring-shadow';

/**
 * The retired raster bezel vocabulary. Any of these on a ring carrier means the
 * nine-slice survived the migration on that selector.
 */
const RETIRED_BEZEL = [
  'border-image',
  'border-image-source',
  'border-image-slice',
  'border-image-width',
  'border-image-outset',
  'border-image-repeat',
] as const;
const RETIRED_BEZEL_VARS = ['--fab-bezel-url', '--fab-bezel-slice', '--fab-bezel-width'] as const;

/** Blank CSS block comments in place, preserving newlines so a finding keeps its line. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

interface Rule {
  /** The rule's selector list, split and trimmed. */
  selectors: string[];
  /** `prop` lowercased, `value` trimmed. */
  decls: { prop: string; value: string }[];
}

/** An at-rule block cut out of the sheet before the flat parse: `@media (...)` and its body. */
interface AtBlock {
  /** The at-keyword, lowercased, without the `@`: `keyframes`, `media`, or anything else found. */
  keyword: string;
  /** Everything between the at-keyword and the block's `{`, trimmed: a keyframes name or a media query. */
  prelude: string;
  /** The text inside the block's outer braces. */
  body: string;
}

/**
 * Cut every at-rule that holds nested rules out of the sheet by balanced braces, and return the rest
 * of the sheet with each cut blanked in place (newlines kept, so a finding keeps its line).
 *
 * WHY THE BLOCKS COME OUT FIRST. `parseRules` is a flat bracket-pair scan. The sheet has two
 * `@font-face` rules (flat, kept for the scan, and harmless: an at-keyword selector carries no class),
 * the lesson ring's two `@keyframes` and one `@media (prefers-reduced-motion: reduce)`. Fed to the
 * flat scan, a keyframes block reads as rules named `0%, 100%` and `50%`, and the media block's
 * `.fab-hint { animation: none; }` reads as a TOP-LEVEL rule that would win the cascade for every user.
 * So the nested blocks are listed here and checked as blocks, and the flat scan never sees them.
 *
 * Every at-rule with a nested block is cut, whatever its keyword, so `atBlockFindings` can report one
 * nobody expected rather than let its insides leak into the flat parse as top-level rules.
 */
function cutAtBlocks(css: string): { rest: string; blocks: AtBlock[] } {
  const src = stripComments(css);
  const blocks: AtBlock[] = [];
  let rest = '';
  let i = 0;
  while (i < src.length) {
    const at = src.indexOf('@', i);
    if (at < 0) break;
    const open = src.indexOf('{', at);
    const semi = src.indexOf(';', at);
    const keyword = (src.slice(at + 1).match(/^[-\w]+/)?.[0] ?? '').toLowerCase();
    // A statement at-rule (`@import x;`) or a flat one (`@font-face { ... }`) stays where it is.
    if (open < 0 || (semi >= 0 && semi < open) || keyword === 'font-face') {
      rest += src.slice(i, at + 1);
      i = at + 1;
      continue;
    }
    let depth = 0;
    let close = open;
    for (; close < src.length; close++) {
      if (src[close] === '{') depth++;
      else if (src[close] === '}' && --depth === 0) break;
    }
    if (depth !== 0) throw new Error(`@${keyword} at offset ${at} never closes`);
    blocks.push({ keyword, prelude: src.slice(at + 1 + keyword.length, open).trim(), body: src.slice(open + 1, close) });
    rest += src.slice(i, at) + src.slice(at, close + 1).replace(/[^\n]/g, ' ');
    i = close + 1;
  }
  return { rest: rest + src.slice(i), blocks };
}

/** The pulse's two keyframes, by name, in sheet order. */
const PULSE_KEYFRAMES = ['fab-hint-pulse', 'fab-hint-pulse-panel'] as const;

/**
 * What is wrong with a sheet's at-rule blocks, as findings: an empty list when the sheet holds exactly
 * the pulse's two keyframes, each moving opacity only, and one reduced-motion media block whose body is
 * the single rule `.fab-hint { animation: none; }`.
 */
function atBlockFindings(blocks: readonly AtBlock[]): string[] {
  const found: string[] = [];
  for (const b of blocks) {
    if (b.keyword !== 'keyframes' && b.keyword !== 'media') found.push(`an unexpected at-rule block: @${b.keyword} ${b.prelude}`);
  }
  const frames = blocks.filter((b) => b.keyword === 'keyframes');
  const names = frames.map((b) => b.prelude);
  if (names.join('|') !== PULSE_KEYFRAMES.join('|')) found.push(`keyframes are [${names.join(', ')}], not [${PULSE_KEYFRAMES.join(', ')}]`);
  for (const f of frames) {
    for (const step of parseRules(f.body)) {
      for (const d of step.decls) {
        if (d.prop !== 'opacity') found.push(`@keyframes ${f.prelude} ${step.selectors.join(', ')} animates ${d.prop}, not opacity`);
      }
    }
  }
  const media = blocks.filter((b) => b.keyword === 'media');
  if (media.length !== 1) found.push(`${media.length} @media blocks, not 1`);
  for (const m of media) {
    if (m.prelude !== '(prefers-reduced-motion: reduce)') found.push(`an @media block for ${m.prelude}`);
    const inner = parseRules(m.body);
    const shape = inner.map((r) => `${r.selectors.join(', ')} { ${r.decls.map((d) => `${d.prop}: ${d.value}`).join('; ')} }`);
    if (shape.join(' ') !== '.fab-hint { animation: none }') found.push(`@media ${m.prelude} holds ${shape.length} rule(s): ${shape.join(' ')}`);
  }
  return found;
}

/**
 * Parse a sheet with no nested blocks into selector-scoped declaration blocks: a flat bracket-pair
 * scan, exact for what `cutAtBlocks` leaves. A rule whose "selector" is an at-keyword (`@font-face`)
 * carries no class and therefore never enters any of the four scopes below.
 */
function parseRules(css: string): Rule[] {
  const out: Rule[] = [];
  for (const m of stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = m[1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const decls = m[2]
      .split(';')
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => {
        const i = d.indexOf(':');
        return { prop: d.slice(0, i).trim().toLowerCase(), value: d.slice(i + 1).trim() };
      })
      .filter((d) => d.prop.length > 0);
    out.push({ selectors, decls });
  }
  return out;
}

const CUT = cutAtBlocks(CHROME_CSS);
const RULES = parseRules(CUT.rest);

/**
 * Reduce a selector to the bezel class it targets, or to its raw last compound if it
 * targets none.
 *
 * This is what makes the exhaustiveness gate a SET-EQUALITY check rather than a
 * membership sample: `.fab-tool-btn:disabled`, `.fab-cta.is-pressed` and
 * `header.fab-panel .fab-cta` all reduce to the base class whose ring they are
 * composing, while `.fab-scratch-btn` reduces to itself and shows up as an extra.
 *
 * The exempt list is checked FIRST and matched EXACTLY, so `.fab-dialog-btn--cancel:hover`
 * reduces to the ghost rather than to `.fab-dialog-btn` - the ghost cancels its state
 * rings too, and folding it into the base class would let a real cancellation hide inside
 * the base class's entry.
 *
 * A BEM MODIFIER OF A RING CARRIER IS A RING CARRIER, and this reduction says so by
 * PREFIX rather than by a hand-derived list. The superseded form matched whole class
 * TOKENS only ("for (const c of classes) if (BEZEL_CLASSES.includes(c)) return c"), so
 * `.fab-dialog-btn--drain`, `.fab-dialog-btn--danger` and `.fab-tool-btn--labeled`
 * reduced to THEMSELVES, came back unregistered, and were skipped by GATE 1, GATE 2 and
 * GATE 4 entirely - while GATE 3 only derives a selector whose shadow carries the ring
 * token or is exactly `none`, so a CLOBBERING shadow on any of the three was invisible
 * there too. All three inherit the ring from a base rule and all three are LATER at equal
 * (0,1,0) specificity, so a `box-shadow` on one wins the cascade and erases that
 * control's frame with all four walkers green. That is the `.fab-dialog-btn` miss this
 * closed list was grepped to close, reproduced one modifier further out - which is why
 * the fix is to make the SCOPE derived rather than to add three names to it. `the closed
 * bezel class list` re-derives the modifier population from the CSS and reddens if one
 * ever falls out of scope again.
 */
function baseSelectorOf(selector: string): string {
  const last = selector.split(/\s+|>/).filter(Boolean).pop() ?? selector;
  const classes = (last.match(/\.[-\w]+/g) ?? []).filter((c) => c !== '.is-pressed');
  for (const c of classes) if ((BEZEL_RING_EXEMPT as readonly string[]).includes(c)) return c;
  for (const c of classes) {
    for (const b of BEZEL_CLASSES) if (c === b || c.startsWith(`${b}--`)) return b;
  }
  // Not a bezel selector: report it verbatim so a finding names what was found.
  return last.replace(/::?[-\w()]+$/, '');
}

/** Every registered selector: the six carriers plus the one allowlisted ghost. */
const REGISTERED = new Set<string>([...BEZEL_CLASSES, ...BEZEL_RING_EXEMPT]);

/** Rules whose selector list touches a registered selector (any state or modifier). */
const REGISTERED_RULES = RULES.filter((r) => r.selectors.some((s) => REGISTERED.has(baseSelectorOf(s))));

describe('the closed bezel class list', () => {
  it('has six carriers and exactly one ring-exempt selector', () => {
    // The five were GREPPED, not read. An earlier reading of this stylesheet produced
    // four and missed `.fab-dialog-btn`. 5 -> 6 BY HAND at plan 76-03: `.fab-swatch`, the
    // label colour swatch, wears the chunky button's ring and states and is registered so
    // every gate below covers it.
    expect(BEZEL_CLASSES).toHaveLength(6);
    expect(BEZEL_CLASSES[5]).toBe('.fab-swatch');
    // MUTATION 3: add a second entry here -> this pin reddens. The length is a stated
    // literal precisely so widening the allowlist to hide a second regression is a
    // visible one-line diff rather than a silent pass.
    expect(BEZEL_RING_EXEMPT).toHaveLength(1);
    expect(BEZEL_RING_EXEMPT[0]).toBe('.fab-dialog-btn--cancel');
  });

  it('puts every BEM modifier of a registered carrier IN SCOPE, derived from the CSS', () => {
    // THE GATES BELOW ARE ALL SCOPED BY `REGISTERED.has(baseSelectorOf(sel))`, so a
    // selector that reduces to itself is not merely unasserted - it is INVISIBLE.
    // GATE 1, GATE 2 and GATE 4 iterate REGISTERED_RULES and never see it; GATE 3 adds
    // a selector to `derived` only when its shadow carries the ring token or is exactly
    // `none`, so a CLOBBERING shadow (`inset 1px 1px 0 0 var(--fab-edge-lit)`) is
    // neither carried nor cancelled and is invisible there as well. Three live modifier
    // rules shipped that way.
    //
    // The population is RE-DERIVED FROM THE STYLESHEET, not restated, so the next
    // modifier anybody authors is either in scope or this case reddens. Only the
    // CARDINALITY is a stated literal, as the vacuity refusal: a scan that matched
    // nothing would make the emptiness assertion below trivially true.
    //
    // MUTATION: add `.fab-dialog-btn--danger { box-shadow: inset 1px 1px 0 0
    // var(--fab-edge-lit); }` to CHROME_CSS -> GATE 2 reddens on "replaces the frame
    // instead of composing over it". Under the superseded whole-token reduction that
    // mutation was GREEN on all four gates.
    const modifiers = new Set<string>();
    for (const rule of RULES) {
      for (const sel of rule.selectors) {
        for (const c of sel.match(/\.[-\w]+/g) ?? []) {
          if (BEZEL_CLASSES.some((b) => c.startsWith(`${b}--`))) modifiers.add(c);
        }
      }
    }
    expect(modifiers.size, `BEM modifiers of a ring carrier: ${[...modifiers].sort().join(', ')}`).toBe(4);
    expect(
      [...modifiers].filter((c) => !REGISTERED.has(baseSelectorOf(c))),
      'A modifier of a ring carrier reduces to ITSELF, so it is outside the scope of ' +
        'GATE 1, GATE 2 and GATE 4, and a clobbering shadow on it is outside GATE 3 too. ' +
        'Reduce it to its base class rather than adding it to a list.',
    ).toEqual([]);
    // Named, because these three shipped outside all four gates and the descendant form
    // is how `.fab-tool-btn--labeled` appears in the header-scoped reclaim rule.
    expect(baseSelectorOf('.fab-dialog-btn--drain')).toBe('.fab-dialog-btn');
    expect(baseSelectorOf('.fab-dialog-btn--danger')).toBe('.fab-dialog-btn');
    expect(baseSelectorOf('header.fab-panel .fab-tool-btn--labeled')).toBe('.fab-tool-btn');
    // And the ghost must NOT fold into its base class: the exempt check is exact and
    // runs first, which is what keeps its sanctioned cancellation from hiding inside
    // `.fab-dialog-btn`'s entry.
    expect(baseSelectorOf('.fab-dialog-btn--cancel')).toBe('.fab-dialog-btn--cancel');
    expect(baseSelectorOf('.fab-dialog-btn--cancel:hover')).toBe('.fab-dialog-btn--cancel');
  });

  it('walks a non-empty stylesheet (the vacuity refusal)', () => {
    // A parse that silently returned nothing would certify every gate below over zero
    // rules - the exact shape of a gate that "proves" an absence by looking at nothing.
    expect(RULES.length).toBeGreaterThan(20);
    expect(REGISTERED_RULES.length).toBeGreaterThan(5);
  });
});

describe('the at-rule blocks, read as blocks', () => {
  it('holds the two pulse keyframes and one reduced-motion block, and nothing else nested', () => {
    expect(CUT.blocks.map((b) => `@${b.keyword} ${b.prelude}`)).toEqual([
      '@keyframes fab-hint-pulse',
      '@keyframes fab-hint-pulse-panel',
      '@media (prefers-reduced-motion: reduce)',
    ]);
    expect(atBlockFindings(CUT.blocks)).toEqual([]);
  });

  it('reads no keyframe step and no media rule as a top-level rule', () => {
    const selectors = RULES.flatMap((r) => r.selectors);
    expect(selectors.filter((s) => /^(\d+(\.\d+)?%|from|to)$/.test(s))).toEqual([]);
    // The one top-level `.fab-hint` rule is the ring's paint, which pulses. The media block's
    // `animation: none` never reaches the flat parse, or it would stop the pulse for everyone.
    const hint = RULES.filter((r) => r.selectors.includes('.fab-hint'));
    expect(hint).toHaveLength(1);
    expect(hint[0].decls.find((d) => d.prop === 'animation')?.value).toBe('fab-hint-pulse 1600ms ease-in-out infinite');
    const panel = RULES.filter((r) => r.selectors.includes('.fab-hint--panel'));
    expect(panel.flatMap((r) => r.decls)).toEqual([{ prop: 'animation-name', value: 'fab-hint-pulse-panel' }]);
  });

  it('animates opacity only: no top-level hint rule animates or transitions a box property', () => {
    for (const r of RULES.filter((rule) => rule.selectors.some((sel) => sel.startsWith('.fab-hint')))) {
      for (const d of r.decls) {
        expect(d.prop, `${r.selectors.join(', ')} ${d.prop}`).not.toMatch(/^transition/);
      }
    }
  });

  // The mutation cases run the same checks over a sheet built to break each one.
  const SHEET = `
    .a { color: red; }
    @keyframes fab-hint-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.6; } }
    @keyframes fab-hint-pulse-panel { 0%, 100% { opacity: 1; } 50% { opacity: 0.8; } }
    @media (prefers-reduced-motion: reduce) { .fab-hint { animation: none; } }
    .b { color: blue; }`;

  it('passes the sheet the mutations start from', () => {
    const cut = cutAtBlocks(SHEET);
    expect(atBlockFindings(cut.blocks)).toEqual([]);
    expect(parseRules(cut.rest).map((r) => r.selectors.join(','))).toEqual(['.a', '.b']);
  });

  it('reports a third at-rule block', () => {
    const cut = cutAtBlocks(`${SHEET}\n@supports (display: grid) { .c { display: grid; } }`);
    expect(atBlockFindings(cut.blocks)).toEqual(['an unexpected at-rule block: @supports (display: grid)']);
    expect(parseRules(cut.rest).map((r) => r.selectors.join(',')), 'and keeps its rule out of the flat parse').toEqual(['.a', '.b']);
  });

  it('reports a second rule inside the media block', () => {
    const cut = cutAtBlocks(SHEET.replace('.fab-hint { animation: none; }', '.fab-hint { animation: none; } .fab-cta { animation: none; }'));
    expect(atBlockFindings(cut.blocks)).toEqual([
      '@media (prefers-reduced-motion: reduce) holds 2 rule(s): .fab-hint { animation: none } .fab-cta { animation: none }',
    ]);
  });

  it('reports a missing media block, and a keyframe that moves more than opacity', () => {
    const noMedia = cutAtBlocks(SHEET.replace(/@media[^}]*\}\s*\}/, ''));
    expect(atBlockFindings(noMedia.blocks)).toEqual(['0 @media blocks, not 1']);
    const grows = cutAtBlocks(SHEET.replace('50% { opacity: 0.6; }', '50% { opacity: 0.6; transform: scale(1.2); }'));
    expect(atBlockFindings(grows.blocks)).toEqual(['@keyframes fab-hint-pulse 50% animates transform, not opacity']);
  });

  it("never reads a keyframe's 0% as a selector, which the flat parse alone would", () => {
    const cut = cutAtBlocks(SHEET);
    expect(parseRules(cut.rest).flatMap((r) => r.selectors)).not.toContain('0%');
    // The flat parse over the whole sheet, the reading this cut exists to prevent.
    expect(parseRules(SHEET).flatMap((r) => r.selectors)).toContain('0%');
  });
});

describe('GATE 1: no retired bezel declaration survives on a ring carrier', () => {
  it('declares no border-image-* and reads no retired --fab-bezel-* var', () => {
    const offenders: string[] = [];
    for (const rule of REGISTERED_RULES) {
      for (const d of rule.decls) {
        if ((RETIRED_BEZEL as readonly string[]).includes(d.prop)) {
          offenders.push(`${rule.selectors.join(', ')}  ${d.prop}: ${d.value}`);
        }
        for (const v of RETIRED_BEZEL_VARS) {
          if (d.value.includes(v)) offenders.push(`${rule.selectors.join(', ')}  ${d.prop}: ${d.value}`);
        }
      }
    }
    expect(
      offenders,
      'The rasterised nine-slice bezel is back on a ring carrier. The bezel is a composed ' +
        'inset ring; there is no image, no slice and no border width.\n' +
        offenders.join('\n'),
    ).toEqual([]);
  });

  it('and the retired vocabulary is gone from the WHOLE stylesheet, not just the carriers', () => {
    // Strictly stronger than the scoped case above, and it holds today. It is a separate
    // case rather than a replacement because the scoped one is the property CHROME-02
    // actually states, and it is the one that must survive if a non-bezel surface ever
    // legitimately needs a border-image.
    const css = stripComments(CHROME_CSS);
    for (const prop of RETIRED_BEZEL) expect(css).not.toContain(`${prop}:`);
    for (const v of RETIRED_BEZEL_VARS) expect(css).not.toContain(v);
  });
});

describe('GATE 2: no unsanctioned ring cancellation, and every state COMPOSES', () => {
  it('cancels the ring only on the allowlisted ghost, and always leads with the ring', () => {
    const cancels: string[] = [];
    const clobbers: string[] = [];
    for (const rule of REGISTERED_RULES) {
      for (const d of rule.decls) {
        if (d.prop !== 'box-shadow') continue;
        for (const sel of rule.selectors) {
          const base = baseSelectorOf(sel);
          if (!REGISTERED.has(base)) continue;
          if (d.value.trim() === 'none') {
            // MUTATION 1: restore `box-shadow: none` on `.fab-tool-btn:disabled` ->
            // this reddens. Under the retired border-image that cancelled only a
            // highlight; under the ring it erases the entire frame, and no baseline
            // covers a disabled toolbar button.
            if (!(BEZEL_RING_EXEMPT as readonly string[]).includes(base)) {
              cancels.push(`${sel}  box-shadow: none`);
            }
            continue;
          }
          // MUTATION 2: strip the ring token from `.fab-dialog-btn:hover` -> this
          // reddens. That is the mutation that would have caught the missed class.
          if (!d.value.includes(RING_TOKEN)) {
            clobbers.push(`${sel}  box-shadow: ${d.value}`);
            continue;
          }
          // THE RING LEADS, and this is geometry rather than style. MEASURED in
          // Chromium: the first-listed inset shadow paints ON TOP, and an inset shadow
          // always paints from the padding-box edge inward, so a state highlight listed
          // BEFORE the ring overpaints the frame it is meant to sit inside (measured
          // `lit lit lit` down the top edge, versus `lit, outline, highlight` when the
          // ring leads). 59-UI-SPEC asks for both "the highlight lands INSIDE the ring"
          // and "the list ends with the ring token"; those are incompatible, and the
          // first is the real requirement.
          const entries = d.value.split(/,(?![^(]*\))/).map((e) => e.trim());
          if (!entries[0].includes(RING_TOKEN)) {
            clobbers.push(`${sel}  ring is not the FIRST entry: ${d.value}`);
          }
        }
      }
    }
    expect(
      cancels,
      `Only ${BEZEL_RING_EXEMPT.join(', ')} may cancel the ring.\n${cancels.join('\n')}`,
    ).toEqual([]);
    expect(
      clobbers,
      'A state rule on a ring carrier replaces the frame instead of composing over it. ' +
        'Every shadow list on these selectors must BEGIN with var(--fab-bezel-ring-shadow).\n' +
        clobbers.join('\n'),
    ).toEqual([]);
  });

  it('the disabled chunky button KEEPS the ring (the single most dangerous line)', () => {
    // Called out by name rather than left to the sweep above, because this exact line
    // shipped as `box-shadow: none` and would have erased every disabled button's frame
    // with the whole board green.
    const disabled = RULES.find((r) => r.selectors.includes('.fab-tool-btn:disabled'));
    expect(disabled, '.fab-tool-btn:disabled rule is present').toBeDefined();
    const shadow = disabled!.decls.find((d) => d.prop === 'box-shadow');
    expect(shadow?.value).toContain(RING_TOKEN);
    // And its dead border-colour declaration is gone: there is no border.
    expect(disabled!.decls.some((d) => d.prop === 'border-color')).toBe(false);
  });

  it('keeps the shadow list LENGTH constant across every state of both button families', () => {
    // These selectors declare `transition: box-shadow`, and lists of unequal length with
    // mismatched inset-ness do not interpolate: without a placeholder slot at rest the
    // app's most-hovered surface hard-jumps its ENTIRE frame on every hover.
    const countEntries = (sel: string): number => {
      // The LAST rule that DECLARES box-shadow for this selector, which is the cascade
      // winner at equal specificity. Not the first matching rule (`.fab-tool-btn`
      // appears in the interpolated base ring rule AND in the later chunky-button rule)
      // and not simply the last matching rule (a still later one sets only the
      // background). Either shortcut measures a value the browser never uses.
      const v = RULES.filter((r) => r.selectors.includes(sel))
        .flatMap((r) => r.decls.filter((d) => d.prop === 'box-shadow'))
        .pop()?.value;
      expect(v, `${sel} declares a box-shadow`).toBeDefined();
      // The ring token expands to THREE entries; the rest are literal.
      return v!.split(/,(?![^(]*\))/).length + (v!.includes(RING_TOKEN) ? 2 : 0);
    };
    for (const family of [
      ['.fab-tool-btn', '.fab-tool-btn:hover', '.fab-tool-btn:active', '.fab-tool-btn:disabled'],
      ['.fab-dialog-btn', '.fab-dialog-btn:hover', '.fab-dialog-btn:active'],
      // Plan 76-03: the swatch shares the chunky button's state rules and transition.
      ['.fab-swatch', '.fab-swatch:hover', '.fab-swatch:active', '.fab-swatch:disabled'],
    ]) {
      const lengths = family.map(countEntries);
      expect(new Set(lengths), `${family[0]} state list lengths: ${lengths.join(', ')}`).toHaveProperty(
        'size',
        1,
      );
      expect(lengths[0]).toBe(5);
    }
  });
});

describe('GATE 3: the class list is EXHAUSTIVE, not a membership sample', () => {
  it('the ring-carrying/cancelling selector set derived from the CSS EQUALS the two literals', () => {
    // THE ENUMERATION IS RE-RUN AT TEST TIME. This is the only one of the three CSS
    // walkers that cannot be satisfied by a hand-picked subset, which is why it is not
    // optional: a gate over a hand-picked subset is not a gate, and one class was
    // already missed once by reading.
    //
    // MUTATION 4: add `.fab-scratch-btn { box-shadow: var(--fab-bezel-ring-shadow); }`
    // -> reddens as an unregistered ring carrier.
    // MUTATION 5: delete `.fab-dialog-btn` from BEZEL_CLASSES -> reddens the other way.
    const derived = new Set<string>();
    for (const rule of RULES) {
      for (const d of rule.decls) {
        if (d.prop !== 'box-shadow') continue;
        const carries = d.value.includes(RING_TOKEN);
        const cancels = d.value.trim() === 'none';
        if (!carries && !cancels) continue;
        for (const sel of rule.selectors) derived.add(baseSelectorOf(sel));
      }
    }
    expect(
      [...derived].sort(),
      'The set of selectors that CARRY or CANCEL the ring must equal ' +
        'BEZEL_CLASSES + BEZEL_RING_EXEMPT exactly - no extra (an unregistered ring ' +
        'carrier), no missing (a registered class with no ring).',
    ).toEqual([...REGISTERED].sort());
  });

  it('is not vacuous: the derived set is non-empty and includes the class a reading missed', () => {
    expect(REGISTERED.has('.fab-dialog-btn')).toBe(true);
  });
});

describe('GATE 4: no ring carrier is a scroll container', () => {
  const SCROLLING = /^(auto|scroll|overlay)$/;

  it('no CHROME_CSS rule on a bezel class declares a scrolling overflow', () => {
    const offenders: string[] = [];
    for (const rule of REGISTERED_RULES) {
      for (const d of rule.decls) {
        if (!/^overflow(-[xy])?$/.test(d.prop)) continue;
        for (const part of d.value.split(/\s+/)) {
          if (SCROLLING.test(part)) offenders.push(`${rule.selectors.join(', ')}  ${d.prop}: ${d.value}`);
        }
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('no INLINE panel site declares a scrolling overflow either', () => {
    // AN INLINE DECLARATION CANNOT BE CAUGHT BY THE CSS WALKER ABOVE, and the one real
    // instance of this defect was inline: `ConfigPanel.tsx` carried `.fab-panel`, the
    // padding and `overflowY: 'auto'` on ONE element. An inset shadow is clipped to the
    // padding box and paints BELOW the content, so scrolled content passed straight
    // through the padding region and ate the panel's top ring band.
    //
    // MUTATION 6: put `overflowY: 'auto'` back on ConfigPanel's panel element -> this
    // reddens.
    const offenders: string[] = [];
    let sites = 0;
    for (const rel of chromeSourceFiles()) {
      const src = stripJsComments(readFileSync(join(CHROME_DIR, rel), 'utf8'));
      for (const m of src.matchAll(/className="(fab-panel|fab-dialog-panel)"/g)) {
        sites++;
        const attrs = elementAttributeRegion(src, m.index);
        const hit = attrs.match(/overflow(?:X|Y)?\s*:\s*'(auto|scroll|overlay)'/);
        if (hit) offenders.push(`${rel}  .${m[1]} site declares ${hit[0]}`);
      }
    }
    // The vacuity refusal: a scanner that found no panel sites would pass over nothing.
    // Thirteen today - nine `.fab-panel` consumers plus the two guard dialogs, the
    // refusal box and the load-refusal card. 10 -> 11 at plan 61-06 (the Graphics panel,
    // the app's first settings surface); 11 -> 12 at plan 62-07 (the development pace
    // panel, which carried the same ring and was therefore held to the same no-scroll
    // rule as every other); 12 -> 13 at plan 64-06 (`RefusalMessage.tsx`), the refusal
    // box, which REUSES this registered class rather than declaring an inline ring the
    // CSS walker above cannot see, so it joins this scan and declares no overflow
    // property at all. 13 -> 12 at plan 68-07, which DELETED the 62-07 panel with the
    // rest of the development pace switch (BELT-05 / D-68-12). The deleted path is named
    // in `68-07-SUMMARY.md` and deliberately not here: this file is inside the scan set
    // of `scripts/check-dev-pace-switch-absent.sh`. 12 -> 13 at plan 73-04
    // (`LoadRefusedCard.tsx`), for the SAME reason 64-06 moved it: the card reuses the
    // registered class rather than hand-rolling a ring, so it joins this scan. 13 -> 14 at
    // plan 90-07 on 2026-10-24 (`SimStoppedCard.tsx`, the card a fatal sim error shows), the
    // same reuse of the registered class, so it joins this scan and declares no overflow.
    // 14 -> 13 in plan 91-03 on 2026-10-24 (GraphicsPanel.tsx deleted, D-04): the Graphics
    // panel and its no-op belt step setting removed with its trigger (CHROME-03).
    // 13 -> 14 with `LessonPanel.tsx`, the lesson list: it reuses the registered class and
    // declares no overflow. 14 -> 15 with `StepCard.tsx`, the lesson's step card, for the same reason.
    //
    // THIS TALLY IS NOT THE RING-CARRIER SET, and confusing the two costs a needless
    // edit in one direction or a missed one in the other. `BEZEL_CLASSES` above counts
    // CSS CLASSES and does NOT move when a component reuses an existing class (ruling
    // R-17 of plan 73-04 is about that one, and it held: neither `BEZEL_CLASSES` nor
    // `chromeCss.ts` moved). This literal counts inline SITES, one per component that
    // carries the class, so it moves for every such component.
    expect(sites, 'inline panel sites scanned').toBe(15);
    expect(
      offenders,
      'A ring-carrying panel is also a scroll container. Move the overflow onto an inner ' +
        'content wrapper (see ConfigPanel.tsx).\n' + offenders.join('\n'),
    ).toEqual([]);
  });
});

/** Blank `//` and block comments in place, preserving newlines and columns. */
function stripJsComments(source: string): string {
  const blank = (m: string): string => m.replace(/[^\n]/g, ' ');
  return source.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

/**
 * The attribute region of the JSX element whose `className` match starts at `from`:
 * everything up to the `>` that closes the opening tag, tracking `{}` depth so the
 * `style={{ ... }}` object (which contains no `>` but plenty of braces) is included
 * whole and a `=>` inside a handler cannot end the scan early.
 */
function elementAttributeRegion(src: string, from: number): string {
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '>' && depth === 0 && src[i - 1] !== '=') return src.slice(from, i);
  }
  return src.slice(from);
}

/** Every shipped `.ts` / `.tsx` module under `frontend/src/chrome/`, recursively. */
function chromeSourceFiles(dir = CHROME_DIR, prefix = ''): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.isDirectory()) out.push(...chromeSourceFiles(join(dir, e.name), `${prefix}${e.name}/`));
    else if (e.isFile() && /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
      out.push(`${prefix}${e.name}`);
    }
  }
  return out;
}
