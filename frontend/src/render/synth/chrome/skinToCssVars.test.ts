// The STRICT sync-guard for skinToCssVars (CHROME-03, CONTEXT Area 3). This test
// is the CI tripwire that keeps the runtime chrome token source, the locked skin
// schema, and docs/style-bible.md section 6 in lockstep: any drift between the
// three fails here. Every asserted hex is the EXACT bible section 6 value, and
// every colour is proven to come from bakeRamp fixed-index selection (the SAME
// source the canvas uses) - not from new chrome colour math - by also asserting a
// DIFFERENT skin produces a DIFFERENT panel fill. SKIN-02 (v7.0) deleted the second
// built-in, so that data-driven half now runs on a synthetic test fixture; it is a
// generator proof, not a skin picker, and nothing the app reaches imports it.
//
// THE GUARD IS EXHAUSTIVE IN BOTH DIRECTIONS as of plan 59-05. Until then it was a
// PER-TOKEN guard: a sequence of named `pick()` assertions, each pinning one row to its
// bible value. That shape catches a token whose VALUE drifts and misses a token that is
// ADDED to either document, which is how eight spacing rows, `--fab-substrate` and
// `--fab-focus` came to be emitted while section 6 never named them. The set case below
// re-derives section 6's token set FROM THE MARKDOWN at test time and compares it to the
// emitted set, so a row appearing or disappearing on either side reddens with the
// offending name printed.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIN_TARGET_PX, skinToCssVars } from './skinToCssVars.ts';
import { LOCKED_SKIN } from '../skins/locked.ts';
import { TEST_SKIN_B } from '../__fixtures__/testSkins.ts';
import { bakeRamp } from '../palette.ts';
import { colorToCss } from '../../../../shared/geometry.ts';

/**
 * Extract the trimmed value of a single `--<name>: <value>;` declaration. Matches
 * greedily to the trailing `;` at end-of-line so a value that itself contains a `;`
 * is captured whole. The greed was originally there for the bezel data URL
 * (`data:image/png;base64,...`), which plan 59-05 deleted; it stays because
 * `--fab-bezel-ring-shadow` is a comma-and-paren value that the same greed protects.
 */
function pick(css: string, name: string): string {
  const m = css.match(new RegExp(`--${name}\\s*:\\s*(.+);\\s*$`, 'm'));
  if (!m) throw new Error(`token --${name} not found in:\n${css}`);
  return m[1].trim();
}

/** `docs/style-bible.md`, five levels up from `frontend/src/render/synth/chrome/`. */
const BIBLE = join(import.meta.dirname, '../../../../../docs/style-bible.md');

/**
 * The `--fab-*` token names section 6 DECLARES, re-derived from the markdown at test
 * time rather than transcribed into this file.
 *
 * Scoped two ways, and both narrowings are load-bearing. First to section 6 (from its
 * `## 6.` heading to the next `## ` heading), so a token named anywhere else in the bible
 * cannot satisfy this section's contract. Then to TABLE ROWS only (lines starting `|`),
 * because section 6's prose deliberately names the three RETIRED raster tokens
 * (`--fab-bezel-url`, `--fab-bezel-slice`, `--fab-bezel-width`) in the paragraph recording
 * their deletion - counting prose would make the gate demand the emitter re-add them.
 */
function bibleSection6Tokens(): Set<string> {
  const md = readFileSync(BIBLE, 'utf8');
  const start = md.search(/^## 6\. /m);
  if (start < 0) throw new Error('style-bible.md: section 6 heading not found');
  const rest = md.slice(start + 1);
  const end = rest.search(/^## /m);
  const section = end < 0 ? rest : rest.slice(0, end);
  const rows = section.split('\n').filter((l) => l.trimStart().startsWith('|'));
  return new Set([...rows.join('\n').matchAll(/--fab-[a-z0-9-]+/g)].map((m) => m[0]));
}

/**
 * The `--fab-min-target` VALUE style-bible section 6 declares, in px, parsed from the
 * markdown at test time (plan 66-06). The token-name set above is parsed the same way
 * and for the same reason: the bible is the contract, so it is what can refuse a value,
 * and nothing here is transcribed.
 *
 * Scoped to section 6 table rows, then matched on the row's own second cell. A missing
 * or unparseable row THROWS rather than returning a default - a silent default is how a
 * gate stops being able to fail.
 */
function bibleMinTargetPx(): number {
  const md = readFileSync(BIBLE, 'utf8');
  const start = md.search(/^## 6\. /m);
  if (start < 0) throw new Error('style-bible.md: section 6 heading not found');
  const rest = md.slice(start + 1);
  const end = rest.search(/^## /m);
  const section = end < 0 ? rest : rest.slice(0, end);
  const row = section.match(/^\|\s*`--fab-min-target`\s*\|\s*`(\d+)px`\s*\|/m);
  if (!row) throw new Error('style-bible.md section 6: no `--fab-min-target` | `Npx` row');
  return Number(row[1]);
}

/** Every custom property name the emitter declares, in emission order. */
function emittedTokens(css: string): string[] {
  return [...css.matchAll(/^(--fab-[a-z0-9-]+)\s*:/gm)].map((m) => m[1]);
}

describe('skinToCssVars (strict sync-guard vs style-bible section 6)', () => {
  const css = skinToCssVars(LOCKED_SKIN, 1);

  it('emits the EXACT style-bible section 6 chrome tokens for the LOCKED skin', () => {
    // Bible section 6: bezel panel body fill = ramp[2] #3b4250.
    expect(pick(css, 'fab-panel-fill')).toBe('#3b4250');
    // lit edge = ramp[4] #b0bacb (raised 32-01 SHELL-01).
    expect(pick(css, 'fab-edge-lit')).toBe('#b0bacb');
    // shadow edge = ramp[0] #1b1f27.
    expect(pick(css, 'fab-edge-shadow')).toBe('#1b1f27');
    // inner definition outline = ramp[0] #1b1f27.
    expect(pick(css, 'fab-outline')).toBe('#1b1f27');
    // label ink = ramp[4] #b0bacb (contrasting extreme, raised 32-01 SHELL-01).
    expect(pick(css, 'fab-ink')).toBe('#b0bacb');
    // neutral button surface = ramp[2] #3b4250.
    expect(pick(css, 'fab-btn-neutral')).toBe('#3b4250');
    // primary / CTA = build accent #4fa8ff.
    expect(pick(css, 'fab-btn-primary')).toBe('#4fa8ff');
    // focus ring = build accent #4fa8ff.
    expect(pick(css, 'fab-focus')).toBe('#4fa8ff');
    // destructive affordance = fault accent #f0506e.
    expect(pick(css, 'fab-destructive')).toBe('#f0506e');
    // syntax string accent = working accent #34d399 (Phase 39 CodeMirror theme).
    expect(pick(css, 'fab-accent-working')).toBe('#34d399');
    // syntax number/constant accent = item accent #ffb454 (Phase 39 CodeMirror theme).
    expect(pick(css, 'fab-accent-item')).toBe('#ffb454');
    // Phase 76 (D-05): the six label colours, bible section 1c, in byte order.
    expect(pick(css, 'fab-label-sand')).toBe('#e0d388');
    expect(pick(css, 'fab-label-stone')).toBe('#a19d95');
    expect(pick(css, 'fab-label-moss')).toBe('#a3c27f');
    expect(pick(css, 'fab-label-lilac')).toBe('#bea2ea');
    expect(pick(css, 'fab-label-rose')).toBe('#e39ac0');
    expect(pick(css, 'fab-label-clay')).toBe('#d68c6c');
  });

  it('does NOT emit a token no CSS reads: --fab-bevel-depth, --fab-icon-md, --fab-icon-lg', () => {
    // No chrome CSS reads var(--fab-bevel-depth); it was dead output that invited
    // drift. Assert it stays removed so it is not reintroduced without a consumer.
    expect(css).not.toContain('--fab-bevel-depth');
    // THE SAME RULE, AND IT WAS BROKEN IN THIS FILE ONE PLAN LATER (phase 59 review
    // WR-05). Plan 59-03 added `--fab-icon-md` and `--fab-icon-lg` while
    // `grep -rn "var(--fab-icon-" frontend/` returned NOTHING - no CSS rule, no inline
    // style, no component - and pinned both into the exhaustive bible contract, three
    // cases below the assertion that names the identical defect. The emitter's docblock
    // claimed "the CSS custom property and the React px prop cannot drift"; they cannot,
    // because one of the two did not exist. Both rows are deleted from the emitter and
    // from bible 6c, and both are held absent HERE, by name, for the same reason
    // `--fab-bevel-depth` is: the size ladder reaches the DOM through the `px` prop and
    // an inline width beats a stylesheet rule anyway, so a reintroduction needs a real
    // consumer argued for first.
    expect(css).not.toContain('--fab-icon-md');
    expect(css).not.toContain('--fab-icon-lg');
  });

  it('emits the substrate (ramp[0])', () => {
    expect(pick(css, 'fab-substrate')).toBe('#1b1f27');
  });

  // THE THREE RASTER-GEOMETRY ASSERTIONS THAT LIVED HERE WERE DELETED BY PLAN 59-05,
  // with their subject. They read `--fab-bezel-url` (a threaded PNG data URL),
  // `--fab-bezel-slice` and `--fab-bezel-width` against `bezelDims(1)`. All three rows,
  // the `bezelDims` helper and `chrome/bezelUrl.ts` itself are gone: the bezel is a
  // composed inset ring with nothing to slice and no image to point at.
  //
  // NOT a coverage loss in either direction. A reintroduced CONSUMER reddens in
  // `chromeCss.test.ts`, whose RETIRED_BEZEL_VARS walk asserts no chrome rule names any
  // of the three; and a reintroduced ROW reddens in the exhaustive token-SET case this
  // plan's next commit adds below, alongside the bible section it pins against.

  it('emits the three RING rows: constant 6px ring, device-snapped band, composed shadow', () => {
    // CHROME-02 (plan 59-03). The ring thickness is CONSTANT at every DPR. It was
    // carried verbatim from the raster path's `BASE_RING`, which plan 59-05 deleted with
    // `chrome/bezelUrl.ts`, so the emitter's own `BEZEL_RING_CSS` is the sole declaration
    // of the 6 now. It is not re-decidable here either: changing it moves every panel's
    // and every chunky button's border-box size.
    expect(pick(css, 'fab-bezel-ring')).toBe('6px');
    // The hairline band at DPR 1 is a whole CSS pixel. Four decimals, not three: it
    // is what holds the DPR-1.5 value to within a thousandth of a device pixel.
    expect(pick(css, 'fab-bezel-band')).toBe('1.0000px');
    // ORDER IS LOAD-BEARING and is the bake's order INVERTED, because the
    // first-listed inset shadow paints on top: the bottom/right shadow band leads so
    // it wins the two corners both bands claim (reproducing "shadow painted after
    // lit", leaving only the top-left corner lit), then the top/left lit band, then a
    // uniform 2-band outline whose outer band is fully covered - so exactly one band
    // of hairline stays visible at depth 1. Body bands need no declaration: they ARE
    // the element's own panel fill showing through the unpainted remainder.
    expect(pick(css, 'fab-bezel-ring-shadow')).toBe(
      'inset calc(-1 * var(--fab-bezel-band)) calc(-1 * var(--fab-bezel-band)) 0 0 var(--fab-edge-shadow),' +
        'inset var(--fab-bezel-band) var(--fab-bezel-band) 0 0 var(--fab-edge-lit),' +
        'inset 0 0 0 calc(2 * var(--fab-bezel-band)) var(--fab-outline)',
    );
  });

  it('device-snaps the band at every DPR bucket: round(dpr)/dpr, never a flat 1px', () => {
    // A flat 1px band at DPR 1.25 is 1.25 device px, which the compositor
    // antialiases into one solid row plus a 25% blend row - a real crispness
    // REGRESSION on the phase whose headline is crispness. Every value below is a
    // whole number of DEVICE pixels: 1 / 1 / 2 / 2.
    expect(pick(skinToCssVars(LOCKED_SKIN, 1), 'fab-bezel-band')).toBe('1.0000px');
    expect(pick(skinToCssVars(LOCKED_SKIN, 1.25), 'fab-bezel-band')).toBe('0.8000px');
    expect(pick(skinToCssVars(LOCKED_SKIN, 1.5), 'fab-bezel-band')).toBe('1.3333px');
    expect(pick(skinToCssVars(LOCKED_SKIN, 2), 'fab-bezel-band')).toBe('1.0000px');
    // The ring thickness does NOT move with the DPR - that is the whole point of the
    // paint-only ring, and it is what makes the border box identical at every DPR.
    for (const d of [1, 1.25, 1.5, 2]) {
      expect(pick(skinToCssVars(LOCKED_SKIN, d), 'fab-bezel-ring')).toBe('6px');
    }
  });

  it('never emits a zero or non-finite band, at any REACHABLE DPR', () => {
    // THE BOUNDARY THE FOUR SHIPPED BUCKETS DO NOT REACH. `Math.round(dpr)` is 0 below
    // DPR 0.5, so the superseded unclamped `round(dpr)/dpr` emitted `0.0000px` at 0.25
    // and 0.33 - and `dpr` is `window.devicePixelRatio` (App.tsx), which tracks browser
    // zoom: 25% and 33% zoom on a 1x display give exactly those. A 0px band collapses
    // EVERY entry of --fab-bezel-ring-shadow (zero offsets, `calc(2 * 0px)` spread), so
    // every panel and every chunky button in the app loses its whole frame while the
    // four bucket assertions above stay green. The band is at minimum ONE DEVICE PIXEL.
    for (const d of [0.25, 0.33, 0.5, 0.67, 1, 1.25, 1.5, 2, 3]) {
      const raw = pick(skinToCssVars(LOCKED_SKIN, d), 'fab-bezel-band');
      const v = parseFloat(raw);
      expect(Number.isFinite(v), `band at dpr ${d} is finite (got ${raw})`).toBe(true);
      expect(v, `band at dpr ${d}`).toBeGreaterThan(0);
      // ONE DEVICE PIXEL IS THE FLOOR, stated as the arithmetic rather than as a table
      // so it cannot drift from the clamp: at DPR 0.25 one device pixel IS 4 CSS px.
      // The 5e-5 is the emitter's OWN four-decimal quantisation and nothing else - at
      // DPR 0.33 the exact floor is 3.030303... and the emitted token is `3.0303px`, a
      // third of a thousandth of a device pixel short. It is a rounding allowance, not
      // a tolerance on the property.
      expect(v, `band at dpr ${d} is at least one device pixel`).toBeGreaterThanOrEqual(1 / d - 5e-5);
    }
    // A degenerate DPR must not emit `NaNpx` either: the CSS parser drops it, which
    // leaves the band token unresolved and invalidates the entire shadow list - the same
    // erasure by a different route. Zero, negative and non-finite all fall back to 1.
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(pick(skinToCssVars(LOCKED_SKIN, bad), 'fab-bezel-band'), `dpr ${bad}`).toBe('1.0000px');
    }
  });

  // `emits the icon size ladder from iconSizes.ts, not from a second literal` LIVED HERE
  // and was deleted with its subject by the phase-59 review (WR-05). It read
  // `pick(css, 'fab-icon-md')` against `ICON_MD_PX`, which was a true statement about two
  // numbers and NOT the property its own comment claimed ("ONE declaration read by both
  // the CSS custom property and the React px prop") - nothing read the custom property.
  // The ladder is still one declaration in `chrome/iconSizes.ts`; its reader is the `px`
  // prop default in `icons.tsx`, and `iconsUsePxLadder.test.ts` is what now holds the
  // call sites to it. The absence of the two tokens is asserted by name above.

  it('emits --fab-min-target from the EXPORTED MIN_TARGET_PX, the same constant the canvas halves', () => {
    // Plan 66-06 / UI-SPEC 6.1. The token used to be a bare `44px` inside the template
    // string, which made it unreadable from anywhere else - and the canvas duly did not
    // honour it (`nubHitRadiusWorld` shipped a 24px-diameter target, WINDOWS row 113).
    // `MIN_TARGET_PX` now has ONE home and TWO consumers: this row, and `ports.ts`'s
    // `wireNubHitRadiusWorld`, which is `(MIN_TARGET_PX / 2) / min(1, scale)`.
    //
    // THIS ASSERTION IS DELIBERATELY NOT `toBe('44px')`. A transcribed literal here
    // would agree with a copy of itself and would stay green while the emitter and the
    // hit test drifted apart. Read against the constant, a change to `MIN_TARGET_PX`
    // reddens this case AND the `wireNubHitRadiusWorld` cases in `ports.test.ts`, which
    // is the whole property being bought. The declared value is pinned separately below,
    // once, so the pair cannot both slide.
    expect(pick(css, 'fab-min-target')).toBe(`${MIN_TARGET_PX}px`);
    // AND THE VALUE ITSELF, PINNED AGAINST THE ONE AUTHORITY OUTSIDE THE CONSTANT.
    // The assertion above proves NON-DRIFT and is BY CONSTRUCTION blind to the constant
    // moving - both sides move together, so it stays green at any value. Measured: with
    // `MIN_TARGET_PX` set to 40 it does not redden. That is correct behaviour for a
    // derivation gate and useless on its own, so the value is read off `style-bible.md`
    // section 6, parsed at test time exactly as the token-SET case below parses the same
    // section. A transcribed `toBe(44)` here would be a literal agreeing with a copy of
    // itself; the bible is the document the emitter is CONTRACTED to, so it is the only
    // thing that can genuinely refuse a new value.
    expect(MIN_TARGET_PX, 'style-bible section 6 declares --fab-min-target').toBe(
      bibleMinTargetPx(),
    );
  });

  it('the emitted token SET equals the style-bible section 6 set EXACTLY (both directions)', () => {
    // THE EXHAUSTIVE HALF (plan 59-05). The per-token cases above pin VALUES; this pins
    // MEMBERSHIP, and it is the only case in this file that reddens on a token nobody
    // thought to assert. Both sides are derived: the bible set is parsed out of the
    // markdown, the emitted set off the running emitter. Neither is transcribed here, so
    // this cannot degrade into a list agreeing with a copy of itself.
    const emitted = emittedTokens(css);
    const bible = bibleSection6Tokens();

    // Vacuity refusal. A parser that silently matched nothing would make the two sets
    // trivially equal at zero, so the count is pinned as a stated literal: 34 tokens,
    // section 6a..6e (18 colour + 3 bezel ring + 0 icon + 8 spacing/target + 5 type).
    //
    // 28 -> 34 BY HAND (phase 76, D-05): the six label colours `--fab-label-sand` to
    // `--fab-label-clay`, added to the emitter and to section 6a in one commit.
    //
    // 30 -> 28 BY HAND (phase 59 review WR-05). `--fab-icon-md` and `--fab-icon-lg` were
    // emitted, bible-pinned and read by NOTHING - the same dead-output defect the
    // `--fab-bevel-depth` case above still names - and were deleted from both sides in
    // one commit, because this gate reddens if only one side moves. Section 6c survives
    // as PROSE recording that the ladder is deliberately not a token, which is why the
    // sub-table count reads 0 rather than the section losing a heading; the parser scopes
    // to TABLE ROWS, so the prose cannot re-add either name.
    expect(emitted, 'the emitter declares 34 tokens').toHaveLength(34);
    expect(bible.size, 'section 6 names 34 tokens across its five sub-tables').toBe(34);

    // No duplicate emission: a token declared twice would let the LAST value win
    // silently while every per-token case above reads the last match too.
    expect(new Set(emitted).size, 'no token is emitted twice').toBe(emitted.length);

    const missingFromBible = emitted.filter((t) => !bible.has(t));
    const missingFromEmitter = [...bible].filter((t) => !emitted.includes(t));
    expect(
      missingFromBible,
      'tokens the emitter declares that style-bible section 6 does not name',
    ).toEqual([]);
    expect(
      missingFromEmitter,
      'tokens style-bible section 6 names that the emitter does not declare',
    ).toEqual([]);
  });

  it('is a pure Skin->string function (no document / no canvas reference)', () => {
    // Re-invoking with the same inputs is byte-identical (determinism).
    expect(skinToCssVars(LOCKED_SKIN, 1)).toBe(css);
  });

  it('takes ONE required parameter and emits no raster URL at any shipped DPR', () => {
    // THE GUARD UNDER THE CORRECTED DOCBLOCK HEAD (plan 59-08, closing
    // 59-VERIFICATION.md gap 2). That head asserted a third argument - "a pre-baked bezel
    // data URL threaded in" - that the emitter has not had since 59-05, while the same
    // docblock recorded the removal sixteen lines further down. The sentence is corrected
    // in place; this is the fact it now claims, held by a gate rather than by prose,
    // because a prose fix with nothing under it is the exact shape of both gaps this
    // phase left open.
    //
    // ITS STRENGTH, STATED HONESTLY: this is a REGRESSION GUARD, not the proof that the
    // docblock is right. No raster token exists anywhere in the module today, so it
    // reddens on a REINTRODUCTION and on nothing else. Whether the corrected sentence
    // describes the shipped emitter is judged by reading it.
    //
    // `Function.length` counts parameters BEFORE the first default, so a two-parameter
    // emitter with `dpr = 1` declares 1. A reintroduced third argument would have to be
    // required to move this, which is precisely how `bezelDataUrl` was declared.
    expect(skinToCssVars.length, 'skinToCssVars(skin, dpr = 1) has ONE required parameter').toBe(1);

    // The four SHIPPED buckets, the same set the band cases above exercise.
    const RASTER_TOKENS = ['url(', 'data:', 'base64', 'image/', '.png'] as const;
    for (const d of [1, 1.25, 1.5, 2]) {
      const block = skinToCssVars(LOCKED_SKIN, d);
      for (const token of RASTER_TOKENS) {
        expect(
          block.includes(token),
          `the token block at DPR ${d} contains '${token}'. The bezel is a composed CSS ` +
            'inset ring (CHROME-02): nothing in this emitter rasterises, and a data URL ' +
            'here is the return of the mechanism plan 59-05 deleted.',
        ).toBe(false);
      }
    }
  });

  // `guards the corner/outline source the bezel bakes` LIVED HERE and was deleted
  // by plan 58-05. It read `LOCKED_SKIN.cornerStyle` / `LOCKED_SKIN.outlineStyle`
  // straight off the shipped skin - two of the four pixel-era axes SKIN-01 removed,
  // because the shipped MACHINE is vector and no longer has a bezel at all.
  //
  // Its subject moved, then STOPPED EXISTING. Plan 58-05 turned both values into module
  // constants in `render/synth/generators.ts` - the shipped corner style and the inner
  // outline thickness; plan 61-07 DELETED both, along with the shared bezel painter, the
  // pixel-era band-depth constant and the four belt bakes. Asserting a constant equals
  // its own literal from here would have been a gate that cannot fail, so the guard was
  // pointed at the painter's own unit spec, which pinned the DEFAULT corner
  // behaviourally. THAT POINTER IS NOW DEAD: the spec retired with its subject in 61-07,
  // and this paragraph is the record of where the coverage went rather than a direction
  // to follow. None of the four names is re-typed here, deliberately - nothing resolves
  // them any more.
  //
  // THREE CLAIMS IN THIS BLOCK STOPPED BEING TRUE. The first two were corrected by plan
  // 59-05; the third is corrected here (plan 61-07):
  //
  //   1. QUOTED: the constants are "read by the chrome bezel until PHASE 59 retires the
  //      PNG-data-URL path". Phase 59 retired it, and the constants stayed. Their reader
  //      was the CANVAS: the fault overlay and the machine-body generator, both in
  //      `generators.ts`. They were mis-filed as chrome-only by a docblock, and an
  //      earlier draft of 59-05 nearly deleted them on that basis.
  //
  //   2. QUOTED: "the four `dpr-crispness` bezel PNGs pin the rendered bytes at
  //      `maxDiffPixels: 0`". They do not, and have not since 59-03 repointed them at a
  //      composed CSS ring that never reaches the bake.
  //
  //   3. QUOTED: "WHAT STILL GATES THE CORNER CONSTANT END-TO-END: NOTHING ... The
  //      retained unit spec is the ONE surviving gate at any level." Both halves are moot
  //      from plan 61-07: there is no corner constant left to gate. Phase 59 accepted the
  //      unit-only gate "for one more phase" precisely because a canvas baseline written
  //      then would be blessed and deleted one phase later - and that is what happened,
  //      so the fallback it named (writing that baseline instead) is NOT owed.
  //      `WINDOWS.md` row 37 closes by deletion.
  //
  // Phase 59 re-measured that gap three times (166, 172 and 173 Playwright cases; zero
  // red every run) and DECIDED EXPLICITLY IN PLAN 59-07 to accept the unit gate for one
  // more phase rather than let it pass a fourth time unremarked - on the stated
  // assumption that Phase 61 would delete the constant and the painter with the last
  // pixel bake, making a canvas baseline written then something that would be blessed and
  // deleted one phase later. PLAN 61-07 DID DELETE THEM, so the assumption held and the
  // fallback never came due. `WINDOWS.md` row 37 closes on the deletion, not on a new
  // baseline.

  it('is data-driven: a different skin emits different tokens (not hard-coded)', () => {
    // The subject is a SYNTHETIC fixture, never a shipped or previously-shipped
    // skin (SKIN-02 / D-25). Expectations are read off the fixture rather than
    // pinned to hex, which is what proves the emitter reads the schema.
    const other = skinToCssVars(TEST_SKIN_B, 1);
    expect(pick(other, 'fab-panel-fill')).not.toBe(pick(css, 'fab-panel-fill'));
    // The panel fill is bakeRamp's fixed-index `fill` - the SAME selection the
    // canvas uses - not a chrome-only colour computation.
    expect(pick(other, 'fab-panel-fill')).toBe(colorToCss(bakeRamp(TEST_SKIN_B).fill));
    // The two syntax accents also track the skin, not a hard-coded literal.
    expect(pick(other, 'fab-accent-working')).not.toBe(pick(css, 'fab-accent-working'));
    expect(pick(other, 'fab-accent-item')).not.toBe(pick(css, 'fab-accent-item'));
    expect(pick(other, 'fab-accent-working')).toBe(
      colorToCss(TEST_SKIN_B.palette.accents.working),
    );
    expect(pick(other, 'fab-accent-item')).toBe(colorToCss(TEST_SKIN_B.palette.accents.item));
  });

  it('emits the Martian Mono body family with a monospace fallback (Phase 47 D-01)', () => {
    // Quoted family first, unquoted generic fallback second: a failed woff2 load
    // degrades to monospace text, never invisible text.
    expect(pick(css, 'fab-font')).toBe('"Martian Mono",monospace');
  });

  it('emits the Sono title family with a monospace fallback (Phase 47 D-02)', () => {
    expect(pick(css, 'fab-font-title')).toBe('"Sono",monospace');
  });

  it('emits the plain vector sizes: base 12px / hero 18px / hud 12px (Phase 47 D-06)', () => {
    expect(pick(css, 'fab-font-size-base')).toBe('12px');
    expect(pick(css, 'fab-font-size-hero')).toBe('18px');
    expect(pick(css, 'fab-font-size-hud')).toBe('12px');
  });

  it('is DPR-independent: identical size emission at dpr 1 and dpr 1.5 (no device snap, Phase 47 D-03)', () => {
    // The x16 device-snap grid is deleted: vector fonts are crisp at any size, so
    // sizes are plain CSS px regardless of devicePixelRatio.
    const hi = skinToCssVars(LOCKED_SKIN, 1.5);
    expect(pick(hi, 'fab-font-size-base')).toBe('12px');
    expect(pick(hi, 'fab-font-size-hero')).toBe('18px');
    expect(pick(hi, 'fab-font-size-hud')).toBe('12px');
  });
});
