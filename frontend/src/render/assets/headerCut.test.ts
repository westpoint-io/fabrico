// headerCut.test.ts - the regenerate-and-compare gate for the header cut (MARK-17, phase
// 80.1, plan 80.1-02). Contract rows D-1 through D-7 of `80.1-UI-SPEC.md`, one case each.
//
// WHAT THIS SPEC IS ACTUALLY FOR. `frontend/src/chrome/brand/fabrico-header.svg` is the
// drawing the shipped toolbar wears, and it is GENERATED: it is a token-painted crop of the
// same geometry as `docs/brand/fabrico-lockup.svg`, emitted by the same script from the same
// constants through one shared geometry function. Phase 80.1's criterion 3 is that the cut
// cannot drift from the brand lockup, and the ROADMAP names the shape of that proof: a
// byte-comparison against a FRESH IN-MEMORY GENERATION. Not an assertion against a pinned
// literal, which would only make this file agree with itself, and would pass on a hand-edited
// asset that no longer shares a source with anything.
//
// THE SECOND CASE IS THE ONE THAT CARRIES IT. A builder that read its own committed output
// back and returned it would satisfy the byte-identity case against ANY file at all, which is
// this repository's signature defect class rather than a hypothetical: a check that cannot
// fail. `does not read its own output` RECORDS every path the builder reads and asserts
// `HEADER_CUT_PATH` is not among them.
//
// THIS SPEC WRITES NOTHING TO THE TREE. It instruments the READ rather than mutating the
// artefact, which is the repair `lockup.test.ts:156-192` records in full: parking the file
// emptied a linted directory, and writing a decoy over it corrupted the artefact permanently
// whenever two runs in one shared checkout overlapped. The claim never required
// touching the disk, because the claim is about what the builder READS.
//
// HOW THE RECORDER IS INSTALLED. `vi.mock('node:fs')` below wraps `readFileSync` in a
// pass-through that appends the path to `FS_READS` and then calls the real function. It is a
// recorder, not a stub: nothing about behaviour changes, and every other case in this file
// reads real bytes exactly as before. `readFileSync` is the ONLY read primitive
// `build-lockup.ts` imports (`scripts/build-lockup.ts:60`), so recording it records every file
// the builder can read. `vi.spyOn(fs, 'readFileSync')` is NOT an alternative and the analog
// records the measurement: vitest 4 refuses it with `Cannot spy on export "readFileSync".
// Module namespace is not configurable in ESM.`
//
// No `@vitest-environment` docblock. The project default is the node environment, and that is
// what lets this spec import a module which resolves its paths from `import.meta.url`. A jsdom
// spec touching disk would have to use `import.meta.dirname` instead, the trap documented
// three times at `render/assets/vertexBudget.test.ts:66-92`.
//
// ONE DELIBERATE DIVERGENCE FROM THE ANALOG, AND THE REASON BELONGS IN THE FILE.
// `lockup.test.ts:73-81` refuses a path COUNT on principle, and says why:
//
//     "Deliberately named parts rather than a path count. A count would have to be
//     hand-edited the moment Phase 81 or 83 adds a cut to the drawing, and a literal that
//     reddens on correct work teaches an executor to edit the assertion instead of the code."
//
// That reasoning is correct about ITS subject and does not transfer to this one. The brand
// lockup is a source drawing that is EXPECTED to gain layers: Phase 81 (favicon and icon cuts)
// added to `docs/brand/` and any later brand cut would too, so a count there would redden on
// correct work. The header cut's twelve layers are a LOCKED CONTRACT - `80.1-UI-SPEC.md`'s
// layer table and contract row D-7 - and the failure they exist to catch is a PARTIAL cut,
// which no named-floor assertion can see. Eleven of these twelve still draws a plausible mark:
// drop the item, or the cleats, or the plate, and the header renders something that looks like
// a lockup and is not the one that was judged. So D-7 below is an EQUALITY on 12, and no
// at-least matcher appears anywhere in this file by design. If a later phase changes
// the cut's layer set, that is a change to the contract and this literal moves WITH it, in the
// same commit, deliberately.

import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  FONT_PATH,
  HEADER_CUT_PATH,
  LOCKUP_PATH,
  NOTICE_PATH,
  buildHeaderCut,
} from '../../../scripts/build-lockup.ts';
import { LOCKED_SKIN } from '../synth/skins/locked.ts';
import { skinToCssVars } from '../synth/chrome/skinToCssVars.ts';

/**
 * Every path `readFileSync` was called with since the last reset, in call order.
 *
 * `vi.hoisted` because `vi.mock`'s factory runs BEFORE this file's imports do, so an ordinary
 * `const` here would still be in its temporal dead zone when the factory closes over it.
 */
const FS_READS = vi.hoisted(() => [] as string[]);

/**
 * The read recorder. See the module header for why it exists and why `vi.spyOn` is not an
 * alternative in vitest 4.
 *
 * TRANSPARENT BY CONSTRUCTION. Only `readFileSync` is wrapped, the wrapper delegates to the
 * real implementation and returns its exact value, and everything else on the namespace is
 * passed through untouched. `default` is rebuilt alongside the named exports because a module
 * that does `import fs from 'node:fs'` would otherwise get an unwrapped copy, which would be a
 * hole in the recorder rather than a convenience.
 */
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  type ReadFileSync = typeof actual.readFileSync;
  const recorded = ((...args: Parameters<ReadFileSync>): ReturnType<ReadFileSync> => {
    FS_READS.push(String(args[0]));
    return actual.readFileSync(...args);
  }) as ReadFileSync;
  return { ...actual, default: { ...actual, readFileSync: recorded }, readFileSync: recorded };
});

/**
 * The twelve `data-part` names the cut declares, in PAINT ORDER, which in SVG is document
 * order.
 *
 * TRANSCRIBED FROM `80.1-UI-SPEC.md`'s layer table, which is the contract, and NOT read back
 * out of the asset: a list derived from the file it is checking cannot fail. Bottom to top,
 * the stack reads as the drawing does - the dark plate the whole cut sits on, then the belt
 * body, its cleats, the framed cell, the two drums, the word standing on the belt, and the
 * amber item last so it paints over everything beneath it.
 *
 * THE NAMES ARE DELIBERATELY NOT IN SORTED ORDER, and that is a requirement rather than an
 * accident. Alphabetical would open `belt-body`, `belt-outline`, `cell-fill`; this list does
 * not. The anti-set check in the D-7 case asserts a sorted copy DIFFERS from this, because an
 * order assertion that a sorted copy also satisfies cannot distinguish an order from a set.
 */
const PINNED_CUT_PARTS: readonly string[] = [
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

/**
 * The eleven layers the two emitted files SHARE, which is every part of the cut except its
 * `plate`.
 *
 * The plate is the one path the cut draws for itself: the brand file's plate spans a
 * `0 0 880 260` document and the cut's is a rounded rectangle over the crop window, so they
 * are two different shapes serving the same role and `sharedLayers()` does not emit either.
 * Everything else in the cut comes out of that one function, which is what makes the D-3
 * comparison below a real measurement of "they share one source".
 *
 * DERIVED from `PINNED_CUT_PARTS` rather than typed a second time, so the two lists cannot
 * disagree; the ONE name that differs is stated as the filter.
 */
const SHARED_PARTS: readonly string[] = PINNED_CUT_PARTS.filter((part) => part !== 'plate');

/**
 * The two brand-register greys, which may not paint an app surface (D-5).
 *
 * `8a94a6` is the brand file's structure ink and `6d7481` its tagline grey. Both are spent on
 * the lockup as a BRAND artefact; the app's own surfaces are painted from the skin's ramp
 * through `--fab-*` tokens. A brand grey reaching the cut would be a colour the skin cannot
 * move and the theme cannot follow.
 */
const BRAND_GREYS: readonly string[] = ['8a94a6', '6d7481'];

/**
 * The number of `data-part` layers the BRAND file declares, as this file's anti-vacuity floor
 * for the D-3 comparison.
 *
 * Fourteen: the cut's eleven shared layers plus `plate`, `grid` and `tagline`, all three of
 * which the cut drops. Asserted BEFORE the shared `d` strings are compared, because a regex
 * that matched nothing would find every shared string identical over an empty map and report
 * a clean pass on two files that share nothing at all.
 */
const BRAND_PART_COUNT = 14;

/**
 * Every `--fab-*` custom property the runtime chrome emitter actually declares.
 *
 * DERIVED FROM THE EMITTER, never transcribed, so it follows the skin rather than agreeing
 * with a list in this file. It is what turns D-6 below from a check on a token's SHAPE into a
 * check on its EXISTENCE, which is the hole code review 80.1 WR-02 measured: the four token
 * names the cut paints with are hand-typed strings in `build-lockup.ts`, which imports neither
 * `LOCKED_SKIN` nor `skinToCssVars` and therefore cannot know whether the app declares them.
 * `var(--fab-inkk)` is a well-formed reference to nothing, and every paint gate in this tree
 * accepted it: measured by regenerating the asset with `CUT_SUBSTRATE` set to
 * `var(--fab-substratee)`, after which the unit suite reported 73 of 73 passed, `lint:svg` 0
 * violations and `tsc` clean, on a header whose plate paints nothing at all. An unresolvable
 * `var()` on the inherited `fill` property is invalid at computed-value time, so the path
 * takes its parent's colour, which is precisely the flat one-colour smear the `paintOf`
 * paragraphs exist to prevent.
 */
const EMITTED_TOKENS: ReadonlySet<string> = new Set(
  [...skinToCssVars(LOCKED_SKIN).matchAll(/(--fab-[a-z0-9-]+)\s*:/g)].map((m) => m[1]!),
);

/**
 * The committed cut's bytes, read ONCE at module load.
 *
 * The D-4 case asserts against it, so a future edit that reintroduces a write to
 * `HEADER_CUT_PATH` reddens rather than passing quietly. Read at load rather than inside the
 * case because a value read inside the case would be read AFTER whatever the case did, which
 * is the shape that cannot notice a mutation.
 */
const COMMITTED_AT_LOAD = readFileSync(HEADER_CUT_PATH, 'utf8');

/**
 * An emitted SVG with its XML comments removed, which is the MARKUP rather than the document.
 *
 * ONE STRIP, USED BY EVERY READER IN THIS FILE (code review 80.1 WR-07). The rule was stated
 * in `paints()` below and applied there alone: both emitted files open with a long provenance
 * header (seventy lines in the cut) that quotes the drawing's own markup and tokens back at
 * the reader, so a scan over the whole text collects prose. `partPaths` and `partNames` were
 * scanning the whole document, and the day a provenance line quotes
 * `<path data-part="plate" ...>` as an example, D-7's exact-order equality reddens on correct
 * work and `partPaths` silently takes the `d` out of a comment. The correct rule was already
 * written down here; it was applied to one reader out of three.
 *
 * `HeaderLockup.readCropBox` applies the same strip before it finds the root, for the same
 * reason, which is why that reader can be trusted with a file whose header discusses viewBoxes.
 */
function bodyOf(svgText: string): string {
  return svgText.replace(/<!--[\s\S]*?-->/g, '');
}

/**
 * `data-part` -> `d`, for every path in an emitted SVG.
 *
 * Both emitted files write one self-closing `<path>` per line with the attributes in a fixed
 * order (`build-lockup.ts`'s shared `pathLine()`), which is the form `path-only` and
 * `one-element-per-line` refuse any deviation from, so a positional regex is a safe reader
 * here and a general XML parse would buy nothing.
 */
function partPaths(svgText: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of bodyOf(svgText).matchAll(/<path data-part="([a-z0-9-]+)" d="([^"]*)"/g)) {
    out.set(m[1]!, m[2]!);
  }
  return out;
}

/**
 * Every `data-part` value in an emitted SVG, in document order.
 *
 * Deliberately a separate reader from `partPaths`: a Map cannot answer a question about
 * DUPLICATES, and document order is the property D-7 is about.
 */
function partNames(svgText: string): string[] {
  return [...bodyOf(svgText).matchAll(/<path data-part="([a-z0-9-]+)"/g)].map((m) => m[1]!);
}

/**
 * Every authored paint in an emitted SVG - each path's `fill` and `stroke` value, in document
 * order.
 *
 * COMMENTS ARE STRIPPED FIRST, through the shared `bodyOf` above: this file opens with seventy
 * lines of provenance that quote the drawing's own tokens back at the reader, and a scan over
 * the whole text would collect prose.
 *
 * `stroke-width` is not matched: the pattern requires the quote immediately after the
 * attribute name, so `stroke-width="3"` is a numeric width rather than a paint and is
 * correctly invisible here.
 */
function paints(svgText: string): string[] {
  return [...bodyOf(svgText).matchAll(/\b(?:fill|stroke)="([^"]*)"/g)].map((m) => m[1]!);
}

describe('the header cut is generated from the lockup, not drawn beside it (criterion 3)', () => {
  it('D-1: regenerates byte-identical to the committed cut', async () => {
    // What reddens this: change one glyph advance, one tracking value, one coordinate
    // rounding or one crop edge in `build-lockup.ts` and the two strings stop matching. Edit
    // the committed SVG by hand and the same thing happens. The comparison is byte for byte
    // on the UTF-8 text, so whitespace, attribute order, the seventy-line provenance header
    // and the trailing newline are all pinned along with the geometry.
    //
    // AGAINST A FRESH IN-MEMORY BUILD, never against a pinned literal. A `d`-string parity
    // test written against a transcribed expectation would only make this file agree with
    // itself, and would pass on an asset that had stopped sharing a source with the brand
    // lockup entirely. That is what D-08 rules out and what the case below enforces.
    expect(await buildHeaderCut()).toBe(readFileSync(HEADER_CUT_PATH, 'utf8'));
  });

  it('D-4: does not read its own output, so D-1 cannot pass on an arbitrary file', async () => {
    // THE CASE THAT STOPS THE GATE PASSING ON ANYTHING. A builder that read its committed
    // output back and returned it would satisfy the byte-identity case above against ANY file
    // at all, and every other case in this spec measures the COMMITTED file, so none of them
    // would notice either. This is the only case in the file that measures the BUILDER.
    //
    // It instruments the read rather than mutating the artefact. `lockup.test.ts:156-192`
    // records both retired mechanisms and why each was retired: parking the file left a
    // linted directory momentarily empty and `lint:svg` refuses that, and writing a decoy over
    // the artefact corrupts it permanently when two runs in one shared checkout overlap.
    // The recorder writes nothing, takes no lock, and an interrupted run leaves the tree
    // exactly as it found it.
    FS_READS.length = 0;
    const built = await buildHeaderCut();
    const seen = [...FS_READS];

    // NON-VACUITY, and it is the half that carries the case. `not.toContain` over an EMPTY
    // array passes, so a mock that silently stopped recording - or a builder that failed
    // before reading anything - would satisfy the load-bearing line below while proving
    // nothing whatever. These two names are the builder's entire legitimate input set: the
    // font binary its outlines come from, and the notice its font pins are read out of.
    expect(seen, 'the read recorder saw nothing, so the assertion below is vacuous').not.toEqual([]);
    expect(seen, 'the builder did not read the committed font binary').toContain(FONT_PATH);
    expect(seen, 'the builder did not read NOTICE.md for its font pins').toContain(NOTICE_PATH);

    // THE LOAD-BEARING LINE.
    expect(seen, 'the builder read its own committed output').not.toContain(HEADER_CUT_PATH);

    // And it does not read the BRAND file either, which is a distinct hole with the same
    // consequence: an emitter that took the eleven shared `d` strings out of
    // `docs/brand/fabrico-lockup.svg` would make the D-3 comparison below true by
    // construction, on a generator that had stopped computing the geometry at all.
    expect(seen, 'the builder read the committed brand lockup').not.toContain(LOCKUP_PATH);

    // And the committed artefact is untouched, which is the property the two retired
    // mechanisms could not offer at all.
    expect(existsSync(HEADER_CUT_PATH), 'the committed cut is missing').toBe(true);
    expect(
      readFileSync(HEADER_CUT_PATH, 'utf8'),
      'the committed cut was modified by this spec',
    ).toBe(COMMITTED_AT_LOAD);
    expect(built.length).toBeGreaterThan(0);
  });

  it('D-3: the eleven shared layers carry byte-identical d in both committed files', async () => {
    // THE STRONGEST AVAILABLE READING OF "THEY SHARE ONE SOURCE", and it catches a
    // divergence a shared-build test would not. Both emitters calling `sharedLayers()` proves
    // they read one function; it does not prove the STRINGS that reached the two files are the
    // same, and a rounding change applied at one emit site only would leave both builds green
    // while the two drawings quietly disagreed. Comparing per `data-part` rather than as whole
    // documents is what makes that visible: the two files are not meant to be equal, only
    // these eleven paths are.
    const cut = partPaths(readFileSync(HEADER_CUT_PATH, 'utf8'));
    const brand = partPaths(readFileSync(LOCKUP_PATH, 'utf8'));

    // NON-VACUITY, BOTH SIDES, BEFORE ANY COMPARISON. A regex that matched nothing would
    // return two empty maps, and the loop below would then find every shared string identical
    // by iterating over nothing. The brand count is stated as a literal (its own eleven shared
    // layers plus `plate`, `grid` and `tagline`) because that file is not this phase's subject
    // and a count is the only assertion a zero-match read cannot satisfy.
    expect(brand.size, 'the brand lockup parsed to no parts, so the compare below is vacuous').toBe(
      BRAND_PART_COUNT,
    );
    expect(cut.size, 'the header cut parsed to no parts').toBe(PINNED_CUT_PARTS.length);

    for (const part of SHARED_PARTS) {
      expect(cut.get(part), `the cut has no ${part} layer`).toBeDefined();
      expect(brand.get(part), `the brand lockup has no ${part} layer`).toBeDefined();
      expect(
        cut.get(part),
        `${part} has drifted: its d string differs between the header cut and the brand ` +
          'lockup, so the two files no longer share one geometry source',
      ).toBe(brand.get(part));
    }
  });

  it('D-5: neither brand-register grey reaches the cut', async () => {
    // The brand register spends `8a94a6` and `6d7481` on the lockup as a BRAND artefact and neither may
    // paint an app surface. The cut is a shipped app surface: it re-skins with the rest of the
    // chrome because every one of its paints is a token, and a baked brand grey would be a
    // colour the skin cannot move and the theme cannot follow. Case-insensitive, because a hex
    // literal is as legal in upper case and the rule is about the value rather than its
    // spelling. Over the WHOLE file including the provenance header, since a grey quoted in
    // the prose is a grey somebody is about to author.
    const svg = readFileSync(HEADER_CUT_PATH, 'utf8').toLowerCase();
    for (const grey of BRAND_GREYS) {
      expect(svg, `the brand-register grey ${grey} reached a shipped app surface`).not.toContain(
        grey,
      );
    }
  });

  it('D-6: every paint in the cut is a var(--fab-*) reference or none', async () => {
    // THIS IS THE GATE ON THE `paintOf` TRAP, and the trap is worth stating because the
    // failure it prevents is invisible. `chrome/svgToElements.ts`'s `paintOf` rewrites any
    // authored paint that is a member of the `LOCKED_SKIN.palette.ramp` VALUE SET to
    // `currentColor`. The cut's plate, lane and ink ARE ramp steps by design (D-03, D-06), so
    // authoring them as the brand file does - `#1b1f27` / `#3b4250` / `#b0bacb` - would
    // collapse three distinct layers onto ONE inherited colour. The file would still parse,
    // still hold twelve paths in the pinned order, still lint clean under the structural
    // rules, and the header would render a flat one-colour smear. Every other gate would be
    // green.
    const found = paints(readFileSync(HEADER_CUT_PATH, 'utf8'));

    // NON-VACUITY FIRST. "Every paint is a token" is trivially true of no paints at all, and a
    // reader that matched nothing is exactly how that happens. Twelve paths carrying at least
    // one paint each is the floor; the cut authors more, because a stroked path declares
    // `fill="none"` as well as its stroke.
    expect(
      found.length,
      'no paints were read out of the cut, so the loop below would prove nothing',
    ).toBeGreaterThan(PINNED_CUT_PARTS.length - 1);

    // AND THE EMITTED SET IS LIVE BEFORE MEMBERSHIP IS ASKED OF IT. An emitter walk that
    // matched nothing would make every existence assertion below fail on a correct file, which
    // fails safe but reads as a defect in the asset rather than in this reader. Written
    // without an at-least matcher, per the module header's rule about floors.
    expect(
      EMITTED_TOKENS.size === 0,
      'skinToCssVars declared no --fab-* custom properties, so the existence check below is ' +
        'measuring the reader rather than the asset',
    ).toBe(false);

    for (const paint of found) {
      expect(paint === 'none' || /^var\(--fab-[a-z0-9-]+\)$/.test(paint), `${paint} is neither a --fab-* token reference nor none`).toBe(true);
      // THE SHAPE IS NOT THE GATE; THE NAME IS (WR-02). `var(--fab-inkk)` passes the line
      // above, passes `chrome-ink`, passes `tsc`, and paints nothing. See `EMITTED_TOKENS`.
      if (paint !== 'none') {
        const token = /^var\((--fab-[a-z0-9-]+)\)$/.exec(paint)?.[1] ?? paint;
        expect(
          EMITTED_TOKENS.has(token),
          `${token} is not a custom property skinToCssVars declares, so this layer's paint is ` +
            "invalid at computed-value time and it renders in its parent's colour",
        ).toBe(true);
      }
    }
  });

  it('D-7: the cut declares exactly the twelve pinned parts, in paint order', async () => {
    // AN EQUALITY, NEVER A FLOOR, and this case is the reason the divergence in the module
    // header is written down. Eleven of these twelve still draws a plausible mark: drop the
    // item and the belt runs empty, drop the cleats and it runs smooth, drop the plate and the
    // word sits on the bare toolbar. A `>=` assertion on 12 passes on every one of those,
    // which is why no at-least matcher appears anywhere in this file.
    //
    // THIS CASE IS ALSO THE ANTI-VACUITY FLOOR FOR D-3 AND D-6. Both of those quantify over
    // the cut's parts, and an empty part list satisfies "every paint is a token" and "every
    // shared d matches" by looking at nothing. Their own in-case floors catch a reader that
    // broke; this catches a FILE that emptied.
    const names = partNames(readFileSync(HEADER_CUT_PATH, 'utf8'));
    expect(
      names,
      'Paint order is document order. The plate is the ground the whole cut sits on, the belt ' +
        'and its cleats sit on the plate, the word stands on the belt, and the amber item ' +
        'paints last so it is not overdrawn. Reordering the emitter changes the picture, not ' +
        'just the markup.',
    ).toEqual(PINNED_CUT_PARTS);
    expect(new Set(names).size, 'a data-part name is duplicated').toBe(names.length);

    // The order assertion is only meaningful if it can distinguish an order from a set.
    expect([...names].sort()).not.toEqual(PINNED_CUT_PARTS);
  });

  it('reads the MARKUP and not the provenance prose, in all three readers (WR-07)', () => {
    // THE STRIP IS PROVED LIVE RATHER THAN TRUSTED, in both directions, because a `bodyOf`
    // that returned the empty string would make every quantified case in this file pass over
    // nothing, and one that stripped nothing would leave the hole this fix closed.
    //
    // The fixture is the exact hazard: a provenance line quoting a `<path>` back at the
    // reader, which is what both emitted headers habitually do. Before this, `partNames` read
    // ['decoy', 'plate'] and D-7's exact-order equality reddened on a correct file, while
    // `partPaths` silently took the decoy's `d`.
    const svg = [
      '<!--',
      '  An example line, of the kind these headers quote at the reader:',
      '    <path data-part="decoy" d="M0 0" fill="var(--fab-decoy)" />',
      '-->',
      '<svg viewBox="0 0 1 1" xmlns="http://www.w3.org/2000/svg">',
      '  <path data-part="plate" d="M1 1" fill="var(--fab-substrate)" />',
      '</svg>',
    ].join('\n');
    expect(partNames(svg)).toEqual(['plate']);
    expect([...partPaths(svg).keys()]).toEqual(['plate']);
    expect(paints(svg)).toEqual(['var(--fab-substrate)']);

    // AND IT DOES NOT EAT THE MARKUP IT IS GIVEN. The real file still reads its twelve parts,
    // which is the other direction and the one a too-greedy strip would break.
    expect(partNames(readFileSync(HEADER_CUT_PATH, 'utf8'))).toEqual(PINNED_CUT_PARTS);
  });

  it('carries no live text and no banned element', async () => {
    // The whole point of outlining: with the font hidden from fontconfig the judged drawing
    // moved 6,996 of its 228,800 pixels and an outlined file moves none. A surviving `<text>`
    // in a SHIPPED asset would put that dependency into the running app, where the user's own
    // fontconfig decides what the brand looks like.
    //
    // The banned list is the same one the analog scans for, and it is not decoration here:
    // `chrome/svgToElements.ts` parses flat self-closing `<path>` children only, so a `<g>` or
    // a `<defs>` would be silently DROPPED rather than rejected, and the header would render
    // an incomplete drawing with no error anywhere.
    //
    // OVER THE MARKUP, NOT OVER THE DOCUMENT (WR-07). The scan used to run on the raw text,
    // which would redden on correct work the day the provenance header quoted `<g ` or
    // `<rect` while explaining which elements the drawing does not use - and the brand file's
    // header does exactly that. An element inside an XML comment is not an element. This is
    // the deliberate opposite of the D-5 case above, which DOES scan the whole file including
    // the prose, because a brand grey quoted in a comment is a grey somebody is about to
    // author, whereas a `<rect` quoted in a comment is a `<rect` somebody chose not to.
    const svg = bodyOf(readFileSync(HEADER_CUT_PATH, 'utf8'));
    expect(svg).not.toMatch(/<text\b/);
    for (const banned of [
      '<title',
      '<g ',
      '<rect',
      '<circle',
      '<defs',
      '<pattern',
      '<use',
      '<style',
    ]) {
      expect(svg, `banned element ${banned} survived`).not.toContain(banned);
    }
  });
});
