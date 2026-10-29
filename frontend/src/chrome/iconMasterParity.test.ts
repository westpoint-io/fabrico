// iconMasterParity.test.ts - the geometry parity gate, D-07 and MARK-06 (plan 81-01).
//
// WHAT THIS SPEC IS ACTUALLY FOR. The project now carries the same mark twice: once as
// `chrome/assets/logomark.svg`, painted in CSS custom properties for the application, and
// once as `docs/brand/fabrico-icon-master.svg`, painted in resolved hex for the operating
// system. Two files, one drawing. This spec is what makes "one drawing" a measurement rather
// than a claim: it reads BOTH files from disk, matches their layers by name, and asserts the
// `d` strings are equal.
//
// PAINT IS DELIBERATELY EXCLUDED FROM THE COMPARISON, because paint is the entire reason the
// two files exist separately. usvg cannot parse a CSS custom property; it warns and falls
// back, to black for a fill and to NO STROKE for a stroke, so an icon pipeline fed the token
// painted file writes a black square without failing. Test 8 below turns that exclusion into
// an assertion instead of a comment: the two files are shown to DISAGREE on every paint value
// while the geometry case passes.
//
// FOUR VACUOUS SHAPES THIS SPEC IS BUILT TO AVOID, all four named in 81-VALIDATION.md:
//
//   (a) Comparing a DIGEST of either whole file. The provenance headers differ by
//       construction, so a whole-file digest cannot distinguish a geometry change from a
//       comment edit. The subject is the `d` strings.
//   (b) Deriving the expected `d` strings from the master itself, or from a shared constant
//       both sides import. The assertion would then agree with a wrong master. Both files are
//       read FROM DISK, and `iconCuts.test.ts` separately proves the generator never reads the
//       chrome square, so the two declarations are genuinely independent.
//   (c) Comparing a SORTED copy of the part list. A sorted list is a set, and paint order is
//       document order in SVG, so a set comparison cannot see a reordering. Test 7 carries the
//       anti-set case first established in `LogoMark.test.tsx`, which was retired with
//       `LogoMark.tsx` on 2026-10-11 (the square is no longer rendered in the app); this file
//       now carries that case on its own.
//   (d) `parts.slice(1)` to skip the plate. That is an index and it drifts the moment the
//       plate moves. Every match below is BY `data-part` NAME.
//
// THE MASTER HAS FOUR PATHS WHERE THE SQUARE HAS THREE. D-08 gives the icon master a full
// bleed plate, which the in-app symbol must not have. The plate is therefore expected to be
// present in one subject and absent from the other, and the shared set is named rather than
// counted.
//
// IT READS BOTH FILES THROUGH `parseIconParts`, the reader every chrome glyph renders
// through (`chrome/svgToElements.ts`). Not a second SVG reader: a second reader is a second dialect, and the one in
// `svgToElements.ts` already throws by name on a long-form tag, an attribute outside the
// closed allowlist, a missing `data-part` or `d`, and a file with no paths at all.
//
// No `@vitest-environment` docblock. The project default is the node environment, and that
// is what lets this spec import a module which resolves its paths from `import.meta.url`.
// A jsdom spec touching disk would have to use `import.meta.dirname` instead, the trap
// documented three times at `render/assets/vertexBudget.test.ts:66-92`.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { colorToCss } from '../../shared/geometry.ts';
import { SHIPPED_MARK } from '../../scripts/mark-craft.ts';
import { skinToCssVars } from '../render/synth/chrome/skinToCssVars.ts';
import { LOCKED_SKIN } from '../render/synth/skins/locked.ts';
import { type IconPart, parseIconParts } from './svgToElements.ts';

/**
 * The literal colour master, read from disk.
 *
 * The path is resolved here rather than imported from `build-icons.ts`, so this spec names its
 * own subject. Importing the generator's constant would still be a disk read of the same file,
 * but it would make the assertion depend on the module it is measuring.
 */
const MASTER_PATH = fileURLToPath(
  new URL('../../../docs/brand/fabrico-icon-master.svg', import.meta.url),
);

/**
 * The independent subject: the token painted square in `chrome/assets/logomark.svg`. Nothing
 * in the app renders it since `LogoMark.tsx` was deleted on 2026-10-11; this test is now what
 * keeps the file equal to the master, shape for shape.
 *
 * Reached through the TRACKED constant `SHIPPED_MARK` rather than a second derivation of the
 * same path, the way `markErasure.test.ts:36` does. A re-derived path is a second declaration
 * that can drift from the one the craft instrument measures.
 */
const SQUARE_PATH = SHIPPED_MARK;

/**
 * The monochrome stencil (MARK-07), read from disk.
 *
 * Phase 81 criterion 1 claims the master, the 16 unit cut and the stencil are "proven one
 * geometry". Until 2026-10-11 nothing tied the stencil to the master but the generator's shared
 * source constants, and the re-verification proved it: the stencil `item` redrawn as a different
 * rectangle in `build-icons.ts` and regenerated passed all 62 icon tests (mutation M8,
 * `reverify-2026-10-11/phase-81.md`). Shared constants are source, not a gate; the cases below
 * read the committed stencil off disk and compare it to the committed master.
 */
const STENCIL_PATH = fileURLToPath(
  new URL('../../../docs/brand/fabrico-icon-stencil.svg', import.meta.url),
);

/**
 * The layers both files carry, NAMED and in the master's authored paint order.
 *
 * A named floor rather than a count, for the reason this repository has now recorded three
 * times: a count has to be hand-edited the moment a cut gains a layer, and a literal that
 * reddens on correct work teaches an executor to edit the assertion. The plate is
 * deliberately absent from this list - it is the one layer the master has and the square must
 * not (D-08).
 */
const SHARED_PARTS: readonly string[] = ['rail', 'cell', 'item'];

/** The part the master carries and the square must not. */
const PLATE = 'plate';

function partsOf(path: string): IconPart[] {
  return parseIconParts(readFileSync(path, 'utf8'));
}

/** One file's parts as a name to part map, so every match below is by name and never by index. */
function byName(parts: readonly IconPart[]): Map<string, IconPart> {
  return new Map(parts.map((p) => [p.part, p]));
}

/** The order the shared parts appear in, as authored. */
function sharedOrder(parts: readonly IconPart[]): string[] {
  return parts.map((p) => p.part).filter((name) => SHARED_PARTS.includes(name));
}

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'fabrico-icon-parity-'));
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('the icon master is the shipped geometry (D-07, MARK-06)', () => {
  it('matches the shipped square d string for d string, matched by data-part name', () => {
    const master = byName(partsOf(MASTER_PATH));
    const square = byName(partsOf(SQUARE_PATH));

    // NON-VACUITY FIRST. An empty map on either side would make the loop body never run and
    // this case would pass having compared nothing. `parseIconParts` throws on a zero-path
    // file, so this floor is about a file that parsed to a DIFFERENT set of names.
    expect(SHARED_PARTS.length, 'the shared part list is empty, so this case is vacuous').toBeGreaterThan(0);
    for (const name of SHARED_PARTS) {
      expect(master.has(name), `the master has no part named ${name}`).toBe(true);
      expect(square.has(name), `the shipped square has no part named ${name}`).toBe(true);
    }

    // THE LOAD-BEARING LINES. One per shared layer, each naming the part and quoting both
    // `d` strings, so a reader of a red run knows which coordinate moved and in which file.
    for (const name of SHARED_PARTS) {
      const m = master.get(name)!;
      const s = square.get(name)!;
      expect(
        m.d,
        `part ${name}: the master draws "${m.d}" and the shipped square draws "${s.d}"`,
      ).toBe(s.d);
    }
  });

  it('carries the plate the square must not, so the match is by name and not by index', () => {
    // D-08. The master gets a full bleed plate because an installer icon dropped into a light
    // theme dock with a transparent ground would show pale ink strokes on white and vanish.
    // The in-app symbol must NOT have one. This case is why `parts.slice(1)` would have been
    // the wrong reader: it pins the asymmetry rather than working around it.
    const master = byName(partsOf(MASTER_PATH));
    const square = byName(partsOf(SQUARE_PATH));
    expect(master.has(PLATE), 'the master has lost its full bleed plate').toBe(true);
    expect(square.has(PLATE), 'the in-app symbol has grown a full bleed plate').toBe(false);
  });

  it('carries exactly the layers each file is supposed to, and no others', () => {
    // WR-05. Every other case in this file iterates `SHARED_PARTS`, and `sharedOrder` filters
    // to that list, so a FOURTH layer added to either file is invisible to all of them: a
    // master that grew a `glow` the square lacks, or a square that grew one the master lacks,
    // passed every case here. D-07 and this module's header both say "path for path"; the gate
    // was "three named paths".
    //
    // The expected sets are NAMED, not counted - `[PLATE, ...SHARED_PARTS]` for the master and
    // `SHARED_PARTS` for the square - so a legitimate new layer reddens this one case with a
    // message that says which file gained what, rather than reddening a count nobody can read.
    const master = [...byName(partsOf(MASTER_PATH)).keys()].sort();
    const square = [...byName(partsOf(SQUARE_PATH)).keys()].sort();

    expect(
      master,
      'the master gained or lost a layer the parity comparison does not read',
    ).toEqual([PLATE, ...SHARED_PARTS].sort());
    expect(
      square,
      'the shipped square gained or lost a layer the parity comparison does not read',
    ).toEqual([...SHARED_PARTS].sort());
  });

  it('THE GATE CAN FAIL: a fourth layer in the master is rejected by name', () => {
    // The mutation, written into the same `mkdtempSync` scratch the coordinate mutation below
    // uses. It never touches a tracked file.
    const committed = readFileSync(MASTER_PATH, 'utf8');
    const extra = '  <path data-part="glow" d="M 1 1 H 31 V 31 H 1 Z" fill="#ffb454" />';
    const mutantText = committed.replace(/(\n)(\s*<path data-part="item")/, `$1${extra}$2`);
    expect(mutantText, 'the fourth-layer splice matched nothing, so this case is vacuous').not.toBe(
      committed,
    );

    const mutantPath = join(tmpRoot, 'mutant-fourth-layer.svg');
    writeFileSync(mutantPath, mutantText);

    const parts = [...byName(partsOf(mutantPath)).keys()].sort();
    expect(parts, 'the reader did not see the spliced layer at all').toContain('glow');
    expect(() => {
      expect(
        parts,
        'the master gained or lost a layer the parity comparison does not read',
      ).toEqual([PLATE, ...SHARED_PARTS].sort());
    }).toThrowError(/gained or lost a layer/);

    // The tracked master is untouched.
    expect(readFileSync(MASTER_PATH, 'utf8'), 'this spec modified the committed master').toBe(
      committed,
    );
  });

  it('keeps the shared layers in the same paint order, and that order is not a set', () => {
    // SVG paint order IS document order, so a correct SET of layers in the wrong order is a
    // visual defect no membership assertion can see.
    const masterOrder = sharedOrder(partsOf(MASTER_PATH));
    const squareOrder = sharedOrder(partsOf(SQUARE_PATH));

    expect(masterOrder, 'the master carries none of the shared parts').not.toEqual([]);
    expect(masterOrder).toEqual(squareOrder);

    // THE ANTI-SET CASE, the idiom the retired `LogoMark.test.tsx` established (removed
    // 2026-10-11 with the component; this is now its only home). The authored order is
    // rail, cell, item; its alphabetisation is cell, item, rail. If those two ever coincided,
    // the case above would be satisfied by a sorted list and would have stopped discriminating
    // an order from a set without anybody noticing.
    expect(
      [...masterOrder].sort(),
      'the authored order is its own alphabetisation, so this case no longer discriminates an order from a set',
    ).not.toEqual(masterOrder);
  });

  it('excludes paint from the comparison, proven by the two files disagreeing on every value', () => {
    // The exclusion is the whole reason two files exist, so it is asserted rather than
    // commented. Every paint value the shared layers declare differs between the two subjects:
    // the master is resolved hex, the square is `var(--fab-*)`. If they ever agreed, the
    // geometry case above would no longer be proving that paint was excluded - it would be
    // passing on two identical files.
    const master = byName(partsOf(MASTER_PATH));
    const square = byName(partsOf(SQUARE_PATH));

    let compared = 0;
    for (const name of SHARED_PARTS) {
      const m = master.get(name)!;
      const s = square.get(name)!;
      for (const key of ['fill', 'stroke'] as const) {
        const mv = m[key];
        const sv = s[key];
        if (mv === undefined && sv === undefined) continue;
        // `fill="none"` is the one value both files legitimately share: it is an absence of
        // paint rather than a colour, and the shipped square uses it on `cell`.
        if (mv === 'none' && sv === 'none') continue;
        compared++;
        expect(
          mv,
          `part ${name} ${key}: the master and the shipped square declare the same paint, so the geometry case is not excluding paint, it is comparing identical files`,
        ).not.toBe(sv);
      }
    }

    // NON-VACUITY. A loop that compared nothing would leave every assertion above unrun.
    expect(compared, 'no paint value was compared, so this case is vacuous').toBeGreaterThan(0);
  });

  it('THE GATE CAN FAIL: a master with one coordinate moved is rejected by name', () => {
    // A gate proven only to pass on correct work is not proven. This case moves ONE coordinate
    // in a scratch copy of the master - `item`'s right edge, 20 to 21 - and asserts the
    // comparison rejects it, naming the part and quoting both `d` strings.
    //
    // The mutation is written into a `mkdtempSync` scratch directory and read back, the way
    // `markErasure.test.ts:110-115` does. It NEVER mutates a tracked file: concurrent test runs
    // may share a checkout, and a spec that rewrites the master on every run is a corruption
    // waiting for two overlapping runs.
    const committed = readFileSync(MASTER_PATH, 'utf8');
    const square = byName(partsOf(SQUARE_PATH));
    const original = square.get('item')!.d;
    const moved = original.replace(/H 20 /, 'H 21 ');

    // NON-VACUITY, and it is the half that carries the case. A `replace` that matched nothing
    // would leave the mutant identical to the master, and the assertion below would then be
    // testing that a correct file passes - green, and proving the opposite of what it claims.
    expect(moved, 'the coordinate substitution matched nothing, so this case is vacuous').not.toBe(
      original,
    );
    const mutantText = committed.replace(original, moved);
    expect(mutantText, 'the mutation did not change the master text').not.toBe(committed);

    const mutantPath = join(tmpRoot, 'mutant-icon-master.svg');
    writeFileSync(mutantPath, mutantText);

    const mutant = byName(partsOf(mutantPath));
    const m = mutant.get('item')!;
    const s = square.get('item')!;

    // THE EXPECTED MESSAGE IS DERIVED, NOT TRANSCRIBED (WR-06). This used to read
    // `.toThrowError(/part item: the master draws "M 12 6 H 21 V 14 H 12 Z"/)`, which is the
    // current `item` geometry with one coordinate bumped - a hard-coded copy of the subject. The
    // day the mark's item legitimately moves, that literal stops matching and this case goes red
    // on correct work, reporting a `toThrowError` mismatch rather than anything a reader can act
    // on. `moved` is derived from the SQUARE, the independent subject, plus the deterministic
    // mutation recipe, so the expectation follows the geometry without becoming circular: it is
    // not read from the master, which is the file under test.
    const escaped = `part item: the master draws "${moved}"`.replace(
      /[.*+?^${}()|[\]\\]/g,
      '\\$&',
    );
    expect(() => {
      expect(
        m.d,
        `part item: the master draws "${m.d}" and the shipped square draws "${s.d}"`,
      ).toBe(s.d);
    }).toThrowError(new RegExp(escaped));

    // And the two shared layers the mutation did not touch still agree, so the gate is shown
    // to discriminate a moved coordinate rather than simply rejecting any mutant file.
    for (const name of ['rail', 'cell']) {
      expect(mutant.get(name)!.d, `part ${name} changed under a mutation aimed at item`).toBe(
        square.get(name)!.d,
      );
    }

    // The tracked master is untouched.
    expect(readFileSync(MASTER_PATH, 'utf8'), 'this spec modified the committed master').toBe(
      committed,
    );
  });
});

describe('the monochrome stencil is a cut of the master geometry (MARK-07, D-07)', () => {
  it('draws every shared layer with the master d string, matched by data-part name, paint excluded', () => {
    const master = byName(partsOf(MASTER_PATH));
    const stencil = byName(partsOf(STENCIL_PATH));

    // NON-VACUITY FIRST: both sides must carry every shared layer, or the loop below compares
    // nothing and passes.
    for (const name of SHARED_PARTS) {
      expect(master.has(name), `the master has no part named ${name}`).toBe(true);
      expect(stencil.has(name), `the stencil has no part named ${name}`).toBe(true);
    }

    // THE LOAD-BEARING LINES. Paint is not read: the stencil is one ink colour by design, the
    // master is the full palette, and only the `d` strings make them one drawing.
    for (const name of SHARED_PARTS) {
      const m = master.get(name)!;
      const st = stencil.get(name)!;
      expect(
        st.d,
        `stencil part ${name}: the stencil draws "${st.d}" and the master draws "${m.d}"`,
      ).toBe(m.d);
    }
  });

  it('carries exactly the shared layers, no plate, in the master paint order', () => {
    // D-08: the stencil must not carry the plate, or a tray filling the template glyph paints a
    // solid square. Named sets, not counts, so a gained layer reddens with a readable message.
    const stencilParts = partsOf(STENCIL_PATH);
    const names = [...byName(stencilParts).keys()].sort();
    expect(
      names,
      'the stencil gained or lost a layer the parity comparison does not read',
    ).toEqual([...SHARED_PARTS].sort());
    expect(names, 'the stencil has grown the full bleed plate').not.toContain(PLATE);

    // Paint order is document order; compare the authored order, not a set.
    expect(sharedOrder(stencilParts)).toEqual(sharedOrder(partsOf(MASTER_PATH)));
  });

  it('THE GATE CAN FAIL: a stencil with its item redrawn is rejected by name', () => {
    // The re-verification's M8 mutation, replayed on a scratch copy in `os.tmpdir()`. It never
    // touches the tracked stencil: concurrent runs may share a checkout.
    const committed = readFileSync(STENCIL_PATH, 'utf8');
    const master = byName(partsOf(MASTER_PATH));
    const original = byName(partsOf(STENCIL_PATH)).get('item')!.d;
    const redrawn = 'M 13 8 H 19 V 13 H 13 Z';
    expect(redrawn, 'the redrawn item equals the committed one, so this case is vacuous').not.toBe(
      original,
    );
    const mutantText = committed.replace(`d="${original}"`, `d="${redrawn}"`);
    expect(mutantText, 'the item substitution matched nothing, so this case is vacuous').not.toBe(
      committed,
    );

    const mutantPath = join(tmpRoot, 'mutant-icon-stencil.svg');
    writeFileSync(mutantPath, mutantText);
    const mutant = byName(partsOf(mutantPath));

    const escaped = `stencil part item: the stencil draws "${redrawn}"`.replace(
      /[.*+?^${}()|[\]\\]/g,
      '\\$&',
    );
    expect(() => {
      const st = mutant.get('item')!;
      const m = master.get('item')!;
      expect(
        st.d,
        `stencil part item: the stencil draws "${st.d}" and the master draws "${m.d}"`,
      ).toBe(m.d);
    }).toThrowError(new RegExp(escaped));

    // The untouched layers still agree, so the gate discriminates a moved part rather than
    // rejecting any mutant file.
    for (const name of ['rail', 'cell']) {
      expect(mutant.get(name)!.d, `stencil part ${name} changed under a mutation aimed at item`).toBe(
        master.get(name)!.d,
      );
    }

    expect(readFileSync(STENCIL_PATH, 'utf8'), 'this spec modified the committed stencil').toBe(
      committed,
    );
  });
});

// THE SQUARE'S ACCENT RULE (MARK-02, MARK-09), moved here on 2026-10-11 from the retired
// `LogoMark.test.tsx`. Until then that spec was the only gate on "the item is the ONE accent,
// painted with the item accent token BY NAME, and the rail and cell stay on the ramp".
// `lint:svg` has no accent rule, and the parity cases above exclude paint by design, so after
// the component was deleted a square repainted with two accents, or with none, reddened only
// `markSheet.test.ts`'s byte digest, which a rebuild clears without naming any rule. The square
// is no longer rendered in the app, but it is still the token painted declaration the icon
// master is held to, and MARK-02 still claims this rule for it.
//
// THE ACCENT SET IS DERIVED FROM THE EMITTER, never hand-typed: every `--fab-*` custom property
// `skinToCssVars(LOCKED_SKIN)` declares whose VALUE is one of the locked skin's accent colours.
// A hand list misses the next accent-valued alias (it once missed `--fab-focus`). The item
// token is derived the same way, from `LOCKED_SKIN.palette.accents.item`, because the set alone
// cannot see a swap from one accent to another: `--fab-btn-primary` is a member too.

/** name -> value for every custom property the runtime chrome emitter declares. */
const EMITTED_TOKENS: ReadonlyMap<string, string> = new Map(
  [...skinToCssVars(LOCKED_SKIN).matchAll(/(--fab-[a-z0-9-]+)\s*:\s*([^;]+);/g)].map((m) => [
    m[1]!,
    m[2]!.trim().toLowerCase(),
  ]),
);
const ACCENT_VALUES: ReadonlySet<string> = new Set(
  Object.values(LOCKED_SKIN.palette.accents).map((c) => colorToCss(c).toLowerCase()),
);
const ACCENT_TOKENS: ReadonlySet<string> = new Set(
  [...EMITTED_TOKENS].filter(([, value]) => ACCENT_VALUES.has(value)).map(([name]) => name),
);
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

/** The authored paints of one part, `none` dropped (an absence of paint, not a colour). */
function paintsOf(part: IconPart): string[] {
  return [part.fill, part.stroke].filter((v): v is string => v !== undefined && v !== 'none');
}

/** The data-part names of every layer carrying at least one accent token, in paint order. */
function accentedParts(parts: readonly IconPart[]): string[] {
  return parts
    .filter((p) => paintsOf(p).some((v) => {
      const t = tokenOf(v);
      return t !== null && ACCENT_TOKENS.has(t);
    }))
    .map((p) => p.part);
}

describe('the token painted square carries ONE accent, on the item, by name (MARK-02, MARK-09)', () => {
  it('derives a live accent set and exactly one item accent token from the emitter', () => {
    // VACUITY REFUSALS. An empty set makes "exactly one accent" provable by looking at
    // nothing; two names for the item colour would make the by-name case accept a choice.
    expect(EMITTED_TOKENS.size, 'the emitter parse found almost nothing').toBeGreaterThan(20);
    expect(ACCENT_TOKENS.size, 'the derived accent set is empty').toBeGreaterThan(1);
    expect(ITEM_ACCENT_TOKENS, 'the item accent is not carried by exactly one token').toHaveLength(1);
    expect(ACCENT_TOKENS.has(ITEM_ACCENT_TOKENS[0]!)).toBe(true);
  });

  it('carries an accent on the item layer and on no other, as an equal list rather than a count', () => {
    // An equal LIST, because a count of 1 is unchanged when the accent moves off the item and
    // onto the rail.
    expect(
      accentedParts(partsOf(SQUARE_PATH)),
      'the item is the ONLY accent on the square; the rail and the cell are ramp steps',
    ).toEqual(['item']);
  });

  it('paints the item with the ITEM accent token by name, not merely with some accent', () => {
    const item = byName(partsOf(SQUARE_PATH)).get('item');
    expect(item, 'the square has no data-part="item" layer').toBeDefined();
    expect(
      paintsOf(item!).map(tokenOf),
      'the item is painted with the token reserved for an item riding a belt, not the build accent',
    ).toEqual([ITEM_ACCENT_TOKENS[0]]);
  });

  it('keeps every other paint a non-accent skin token', () => {
    const others = partsOf(SQUARE_PATH).filter((p) => p.part !== 'item');
    let compared = 0;
    for (const part of others) {
      for (const paint of paintsOf(part)) {
        compared++;
        const token = tokenOf(paint);
        expect(token, `part ${part.part}: ${paint} is not a skin token`).not.toBeNull();
        expect(ACCENT_TOKENS.has(token!), `part ${part.part}: ${paint} is an accent`).toBe(false);
      }
    }
    expect(compared, 'no non-item paint was read, so this case is vacuous').toBeGreaterThan(0);
  });

  it('THE GATE CAN FAIL: a second accent, a swapped accent and a lost accent are each rejected', () => {
    const committed = readFileSync(SQUARE_PATH, 'utf8');
    const item = ITEM_ACCENT_TOKENS[0]!;
    // A non-item accent, derived rather than named, for the swap mutant.
    const other = [...ACCENT_TOKENS].filter((t) => t !== item).sort()[0]!;
    const ink = 'var(--fab-ink)';

    const mutate = (from: RegExp, to: string, label: string): IconPart[] => {
      const text = committed.replace(from, to);
      expect(text, `the ${label} splice matched nothing, so this case is vacuous`).not.toBe(committed);
      const path = join(tmpRoot, `mutant-accent-${label}.svg`);
      writeFileSync(path, text);
      return partsOf(path);
    };

    // Two accents: the cell stroke repainted with the item accent.
    const two = mutate(
      /(data-part="cell"[^>]*stroke=")var\(--fab-ink\)/,
      `$1var(${item})`,
      'two',
    );
    expect(accentedParts(two)).toEqual(['cell', 'item']);

    // Swapped: the item painted with a different accent stays a one-accent square, so only
    // the by-name case can see it.
    const swapped = mutate(
      /(data-part="item"[^>]*fill=")var\(--fab-accent-item\)/,
      `$1var(${other})`,
      'swapped',
    );
    expect(accentedParts(swapped)).toEqual(['item']);
    expect(paintsOf(byName(swapped).get('item')!).map(tokenOf)).not.toEqual([item]);

    // Lost: the item painted ink, so the square carries no accent at all.
    const lost = mutate(/(data-part="item"[^>]*fill=")var\(--fab-accent-item\)/, `$1${ink}`, 'lost');
    expect(accentedParts(lost)).toEqual([]);

    expect(readFileSync(SQUARE_PATH, 'utf8'), 'this spec modified the committed square').toBe(
      committed,
    );
  });
});
