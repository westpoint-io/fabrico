// iconRaster.test.ts - MARK-06's and MARK-07's premises, measured (plans 81-01 and 81-02).
//
// THE SECOND BLOCK IN THIS FILE IS MARK-07, and it asks a different question of the same
// instrument. "A monochrome stencil exists whose silhouette carries real holes." A stencil is
// what a tray, a menu bar or a single colour print paints THE MARK ITSELF with, so the only
// thing carrying the identity there is the outline: if the silhouette has collapsed to a solid
// slab, what ships is a square, and a square is not a mark. So the claim is about TRANSPARENCY
// rather than colour, and it is measured as an ENCLOSED HOLE COUNT taken by flooding the
// transparent region inward from the border and counting what is left over. A coverage
// percentage is NOT a proxy for that: a drawing can cover 39 percent of its box and enclose
// nothing at all.
//
// ITS CONTROL IS THE PLATED MASTER, MEASURED IN THE SAME RUN, and never the token painted
// square. D-08 gives the master a full bleed plate, so it has no holes and full coverage BY
// CONSTRUCTION, which makes it the honest negative subject. Pointing this gate at
// `logomark.svg` instead would calibrate it against a drawing usvg has silently stripped both
// strokes from (see the paragraph below, and 81-RESEARCH.md F-4), so the gate would pass a mark
// that had lost them. That is this repository's signature defect arriving through a parser
// warning nobody reads.
//
// WHAT MARK-06 IS ACTUALLY ABOUT, and it is not a second drawing for its own sake. usvg, the
// SVG parser inside every resvg build, CANNOT RESOLVE A CSS CUSTOM PROPERTY. It does not fail
// on one. It warns, on stderr, and falls back: to BLACK for a fill and to NO STROKE for a
// stroke. So handing the token painted square (`chrome/assets/logomark.svg`) to an icon pipeline produces a
// black square, silently, with a zero exit code and a plausible ink coverage figure. Every
// downstream gate that asks "did a PNG get written" says yes. This spec is the assertion that
// says no.
//
// THE DISCRIMINATING CONTROL IS THE TOKEN PAINTED FILE ITSELF, and that is the one assertion
// in this phase no reader would think to write. A gate whose control were the master itself,
// or a remembered colour count, could not tell a correct master from one that had lost both
// its strokes: both would render "some colours" and pass. The control here is a MEASURED
// degenerate result taken from a file committed to this repository, in the SAME RUN, on the
// same binding. If usvg ever learns to resolve `var()`, this control stops being degenerate
// and the case reddens by name rather than quietly ceasing to discriminate.
//
// NO REMEMBERED NUMBER APPEARS IN THIS FILE. Every value compared below is measured in this
// run from two committed drawings. The master's expected colour set is not a literal: it is
// PARSED OUT OF THE MASTER'S OWN AUTHORED PAINT ATTRIBUTES and converted to RGBA, so the
// assertion is "the render shows exactly the colours the file declares" rather than "the
// render shows four colours". A count would have to be hand-edited the moment a layer gained
// a paint, and a literal that reddens on correct work teaches an executor to edit the
// assertion. A percentage threshold would be worse still: it stops being a measurement the
// moment the rasteriser or the sampling density moves.
//
// THE RASTERISER IS PINNED, AND MIXING VERSIONS INVALIDATES EVERY NUMBER HERE. These
// measurements are `@resvg/resvg-js` 2.6.2, the napi binding, and nothing else. The
// `/usr/bin/resvg` 0.48.1 CLI that may be on a developer box wraps a NEWER resvg core and
// produces DIFFERENT BYTES for the same source; the two were compared at the same render size
// and disagreed. A ladder half rendered by each is a byte identity failure waiting for the
// next regeneration. `frontend/scripts/build-icons.ts` renders through the same binding, on
// purpose.
//
// No `@vitest-environment` docblock. The project default is the node environment, and that
// is what lets this spec import a module which resolves its paths from `import.meta.url`.
// A jsdom spec touching disk would have to use `import.meta.dirname` instead, the trap
// documented three times at `render/assets/vertexBudget.test.ts:66-92`.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SHIPPED_MARK } from '../../../scripts/mark-craft.ts';
import { parseIconParts } from '../../chrome/svgToElements.ts';
import { skinToCssVars } from '../synth/chrome/skinToCssVars.ts';
import { LOCKED_SKIN } from '../synth/skins/locked.ts';

/** The literal colour master: the subject. */
const MASTER_PATH = fileURLToPath(
  new URL('../../../../docs/brand/fabrico-icon-master.svg', import.meta.url),
);

/**
 * THE CONTROL, and it is a committed drawing rather than a constructed one.
 *
 * The token painted square in `chrome/assets/logomark.svg`. Rendering it through this binding is a MEASURED
 * degenerate result: both `var(--fab-ink)` strokes fall back to no stroke and both fills fall
 * back to black, so what survives is two filled rectangles painted the same colour on nothing.
 * That is exactly what MARK-06 exists to prevent shipping, which is what makes it the right
 * negative subject. Reached through the tracked `SHIPPED_MARK` constant rather than a second
 * derivation of the same path, the way `markErasure.test.ts:36` does.
 */
const CONTROL_PATH = SHIPPED_MARK;

/** The render size. One number, used for both subjects, so neither is measured differently. */
const RENDER_WIDTH = 256;

/** Fully opaque black, the value usvg falls back to on an unresolvable fill. */
const OPAQUE_BLACK = '0,0,0,255';

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'fabrico-icon-raster-'));
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** One render: its distinct RGBA quadruples as `r,g,b,a` strings, and its pixel count. */
function renderColours(svgText: string): { colours: Set<string>; pixels: number } {
  const img = new Resvg(svgText, {
    fitTo: { mode: 'width', value: RENDER_WIDTH },
  }).render();
  const px = img.pixels;
  const colours = new Set<string>();
  for (let i = 0; i < px.length; i += 4) {
    colours.add(`${px[i]},${px[i + 1]},${px[i + 2]},${px[i + 3]}`);
  }
  return { colours, pixels: px.length / 4 };
}

/** `#rrggbb` to the `r,g,b,255` form `renderColours` reports. */
function hexToRgba(hex: string): string {
  const h = hex.trim().replace('#', '');
  return `${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},255`;
}

/**
 * The paint values a file DECLARES, read out of its own `fill` and `stroke` attributes.
 *
 * This is what makes the master's expected colour set a measurement rather than a literal:
 * the assertion becomes "the render shows exactly the colours the file declares", which
 * follows the artwork if a layer's paint moves and reddens if a declared colour fails to
 * appear. `none` is excluded because it is an absence of paint rather than a colour.
 */
function declaredPaints(svgText: string): string[] {
  const out = new Set<string>();
  for (const part of parseIconParts(svgText)) {
    for (const value of [part.fill, part.stroke]) {
      if (value === undefined || value.trim() === 'none') continue;
      out.add(value.trim().toLowerCase());
    }
  }
  return [...out].sort();
}

/**
 * Token value to token name, baked from `LOCKED_SKIN` rather than transcribed.
 *
 * Used only by the mutation case, so the `var(--fab-*)` references it substitutes back in are
 * the real token names the application uses rather than names this spec invented. First
 * binding wins: two tokens can legitimately resolve to the same ramp step.
 */
function tokenByValue(): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of skinToCssVars(LOCKED_SKIN).split('\n')) {
    const m = /^(--fab-[a-z0-9-]+):(#[0-9a-fA-F]{6});$/.exec(line.trim());
    if (m !== null && !out.has((m[2] as string).toLowerCase())) {
      out.set((m[2] as string).toLowerCase(), m[1] as string);
    }
  }
  return out;
}

describe('MARK-06 - the master rasterises to the mark, and the token file does not', () => {
  it('THE FLOOR: both subjects render a non-empty pixel buffer', () => {
    // Asserted first and as a case in its own right. A render that returned zero pixels would
    // produce an EMPTY colour set, and an empty set satisfies every `not.toContain` below it
    // for free - the exact vacuous shape this repository has found fourteen times.
    const master = renderColours(readFileSync(MASTER_PATH, 'utf8'));
    const control = renderColours(readFileSync(CONTROL_PATH, 'utf8'));

    expect(master.pixels, 'the master rendered zero pixels, so every case below is vacuous').toBeGreaterThan(0);
    expect(control.pixels, 'the control rendered zero pixels, so every case below is vacuous').toBeGreaterThan(0);
    expect(master.colours, 'the master rendered no colour at all').not.toEqual(new Set());
    expect(control.colours, 'the control rendered no colour at all').not.toEqual(new Set());
  });

  it('renders exactly the colours the master declares, every one of them fully opaque', () => {
    const svg = readFileSync(MASTER_PATH, 'utf8');
    const declared = declaredPaints(svg);
    const { colours, pixels } = renderColours(svg);

    // NON-VACUITY. A master that declared nothing would make the set comparison below trivial.
    expect(pixels, 'the master rendered zero pixels, so this case is vacuous').toBeGreaterThan(0);
    expect(declared, 'the master declares no paint at all, so this case is vacuous').not.toEqual([]);

    // THE LOAD-BEARING LINE. Not a count: the expected set is parsed out of the file's own
    // paint attributes, so it follows the artwork and cannot be satisfied by a render that
    // dropped a layer or invented a colour.
    expect([...colours].sort()).toEqual(declared.map(hexToRgba).sort());

    // And every one of them is fully opaque, which is the plate doing its job (D-08): an
    // installer icon with a transparent ground disappears in a light theme dock.
    for (const colour of colours) {
      expect(colour, `the master rendered a non-opaque colour ${colour}`).toMatch(/,255$/);
    }
  });

  it('carries no fully opaque black, which is what a var() reference falls back to', () => {
    // The tripwire. If a `var(--fab-*)` reference ever creeps back into the master - by a hand
    // edit, or by a generator change that stopped resolving the token - usvg falls that fill
    // back to black and this case reddens. None of the four authored values is black, so the
    // property is real rather than incidental.
    const { colours, pixels } = renderColours(readFileSync(MASTER_PATH, 'utf8'));
    expect(pixels, 'the master rendered zero pixels, so this case is vacuous').toBeGreaterThan(0);
    expect(
      [...colours],
      'the master rendered fully opaque black, which is what usvg falls an unresolvable fill back to',
    ).not.toContain(OPAQUE_BLACK);
  });

  it('THE CONTROL, measured in this same run: the token painted square renders degenerate', () => {
    // This is the case that makes the three above mean something. Same binding, same render
    // width, same call, in the same run - and the token painted file collapses.
    const control = renderColours(readFileSync(CONTROL_PATH, 'utf8'));
    const master = renderColours(readFileSync(MASTER_PATH, 'utf8'));

    expect(control.pixels, 'the control rendered zero pixels, so this case is vacuous').toBeGreaterThan(0);

    // It carries the fallback colour the master is asserted not to carry.
    expect(
      [...control.colours],
      'the control did NOT render opaque black, so usvg now resolves var() and this control has stopped discriminating',
    ).toContain(OPAQUE_BLACK);

    // It carries NONE of the colours the master's paint attributes declare: both strokes fell
    // back to no stroke and both fills fell back to black, so every authored value is gone.
    for (const declared of declaredPaints(readFileSync(MASTER_PATH, 'utf8'))) {
      expect(
        [...control.colours],
        `the control rendered the authored value ${declared}, so it is not degenerate and cannot be the control`,
      ).not.toContain(hexToRgba(declared));
    }

    // And it is strictly poorer than the master, relationally rather than by a count literal.
    expect(control.colours.size).toBeLessThan(master.colours.size);
  });

  it('THE GATE CAN FAIL: substituting the paints back to var() collapses the master to a black square', () => {
    // A gate proven only to pass on correct work is not proven. This case takes the committed
    // master and puts the `var(--fab-*)` references BACK, then renders it through the same
    // binding. The substitution reads its values out of the committed file rather than
    // repeating them here, so the mutation cannot drift from the file it mutates, and the
    // token names come from `skinToCssVars(LOCKED_SKIN)` rather than from this spec.
    //
    // MEASURED OUTCOME, AND IT IS NOT THE CONTROL'S. Plan 81-01's behaviour note predicted the
    // mutant would collapse to the control's two colour result. It does not, and the reason is
    // D-08: the master carries a FULL BLEED PLATE and the control does not. With the plate's
    // fill falling back to black the whole canvas is opaque black, so the mutant renders
    // ONE colour where the control renders two. That is a strictly stronger demonstration of
    // MARK-06's premise, not a weaker one: it is literally the black square the requirement
    // exists to prevent. Both relations are asserted below so the case still discriminates.
    const committed = readFileSync(MASTER_PATH, 'utf8');
    const tokens = tokenByValue();

    let mutantText = committed;
    let substituted = 0;
    for (const declared of declaredPaints(committed)) {
      const token = tokens.get(declared);
      expect(token, `no LOCKED_SKIN token resolves to the authored value ${declared}`).toBeDefined();
      const before = mutantText;
      mutantText = mutantText.split(declared).join(`var(${token})`);
      if (mutantText !== before) substituted++;
    }

    // NON-VACUITY, and it is the half that carries the case. A substitution that matched
    // nothing would leave the mutant identical to the master, and the assertions below would
    // then be measuring a correct file while claiming to measure a broken one.
    expect(substituted, 'no paint value was substituted, so this case is vacuous').toBeGreaterThan(0);
    expect(mutantText, 'the substitution did not change the master text').not.toBe(committed);

    // Written to a scratch directory and read back, the way `markErasure.test.ts:110-115`
    // does. NEVER mutate a tracked file: concurrent runs may share a checkout.
    const mutantPath = join(tmpRoot, 'var-substituted-master.svg');
    writeFileSync(mutantPath, mutantText);

    const mutant = renderColours(readFileSync(mutantPath, 'utf8'));
    const control = renderColours(readFileSync(CONTROL_PATH, 'utf8'));

    expect(mutant.pixels, 'the mutant rendered zero pixels, so this case is vacuous').toBeGreaterThan(0);

    // The three properties the correct master holds are all gone.
    expect([...mutant.colours], 'the mutant did not collapse to the fallback colour').toContain(
      OPAQUE_BLACK,
    );
    for (const declared of declaredPaints(committed)) {
      expect(
        [...mutant.colours],
        `the mutant still renders the authored value ${declared}, so var() resolved and this case proves nothing`,
      ).not.toContain(hexToRgba(declared));
    }

    // And its colour set is a SUBSET of the control's: the same degenerate failure, minus the
    // transparency the control has and the plate denies the master.
    for (const colour of mutant.colours) {
      expect(
        [...control.colours],
        `the mutant rendered ${colour}, which the token painted control does not, so the two failures are not the same failure`,
      ).toContain(colour);
    }

    // The tracked master is untouched.
    expect(readFileSync(MASTER_PATH, 'utf8'), 'this spec modified the committed master').toBe(
      committed,
    );
  });
});

/* ------------------------------------------------------------------ *
 * MARK-07: the stencil is a silhouette, not a slab (plan 81-02, D-08)
 * ------------------------------------------------------------------ */

/** The monochrome stencil: the subject of the second block. */
const STENCIL_PATH = fileURLToPath(
  new URL('../../../../docs/brand/fabrico-icon-stencil.svg', import.meta.url),
);

/** What one render says about a drawing's silhouette. No number here is written down. */
interface Silhouette {
  /** Distinct RGBA quadruples. */
  colours: Set<string>;
  /** Fully opaque pixels as a fraction of the whole canvas. */
  coverage: number;
  /** Fully transparent pixels. */
  transparent: number;
  /** Connected transparent regions that the border cannot reach. THE HOLES. */
  enclosed: number;
  /** Total pixels, the non-vacuity floor for every ratio above. */
  pixels: number;
}

/**
 * Measure one drawing's silhouette at `RENDER_WIDTH`.
 *
 * THE HOLE COUNT IS A FLOOD FILL, not a coverage figure and not a proxy for one. Every fully
 * transparent pixel on the border seeds a 4-connected flood through the transparent region;
 * whatever transparent pixels the flood never reaches are enclosed, and they are counted as
 * connected components rather than as an area, because "at least one real hole" is a claim
 * about topology. The ring between the inner wall of the cell and the amber item is the hole
 * MARK-07 is about, and a full bleed plate erases it.
 */
function silhouette(svgText: string): Silhouette {
  const img = new Resvg(svgText, { fitTo: { mode: 'width', value: RENDER_WIDTH } }).render();
  const w = img.width;
  const h = img.height;
  const px = img.pixels;
  const total = w * h;

  const colours = new Set<string>();
  const clear = new Uint8Array(total);
  let opaque = 0;
  let transparent = 0;
  for (let i = 0; i < total; i++) {
    const o = i * 4;
    colours.add(`${px[o]},${px[o + 1]},${px[o + 2]},${px[o + 3]}`);
    if (px[o + 3] === 255) opaque++;
    if (px[o + 3] === 0) {
      clear[i] = 1;
      transparent++;
    }
  }

  // Flood the transparent region inward from every border pixel.
  const seen = new Uint8Array(total);
  const stack: number[] = [];
  const push = (i: number): void => {
    if (clear[i] === 1 && seen[i] === 0) {
      seen[i] = 1;
      stack.push(i);
    }
  };
  for (let x = 0; x < w; x++) {
    push(x);
    push((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    push(y * w);
    push(y * w + (w - 1));
  }
  while (stack.length > 0) {
    const i = stack.pop() as number;
    const x = i % w;
    const y = (i - x) / w;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (y > 0) push(i - w);
    if (y < h - 1) push(i + w);
  }

  // Whatever the flood never reached is enclosed. Count it in CONNECTED COMPONENTS.
  let enclosed = 0;
  const counted = new Uint8Array(total);
  for (let i = 0; i < total; i++) {
    if (clear[i] === 0 || seen[i] === 1 || counted[i] === 1) continue;
    enclosed++;
    counted[i] = 1;
    const walk = [i];
    while (walk.length > 0) {
      const j = walk.pop() as number;
      const x = j % w;
      const y = (j - x) / w;
      for (const k of [x > 0 ? j - 1 : -1, x < w - 1 ? j + 1 : -1, y > 0 ? j - w : -1, y < h - 1 ? j + w : -1]) {
        if (k >= 0 && clear[k] === 1 && seen[k] === 0 && counted[k] === 0) {
          counted[k] = 1;
          walk.push(k);
        }
      }
    }
  }

  return { colours, coverage: opaque / total, transparent, enclosed, pixels: total };
}

describe('MARK-07 - the stencil is a silhouette with real holes, and the plated master is not', () => {
  it('THE FLOOR: both subjects render a non-empty canvas', () => {
    // Asserted first and as a case in its own right. A render that returned zero pixels would
    // make every ratio below a division by zero and every "greater than" comparison vacuous.
    const stencil = silhouette(readFileSync(STENCIL_PATH, 'utf8'));
    const plated = silhouette(readFileSync(MASTER_PATH, 'utf8'));

    expect(stencil.pixels, 'the stencil rendered zero pixels, so every case below is vacuous').toBeGreaterThan(0);
    expect(plated.pixels, 'the plated master rendered zero pixels, so every case below is vacuous').toBeGreaterThan(0);
    expect(stencil.pixels, 'the two subjects were not rendered at the same size').toBe(plated.pixels);
  });

  it('renders as exactly two values: one fully transparent, one fully opaque, and NOT black', () => {
    const svg = readFileSync(STENCIL_PATH, 'utf8');
    const stencil = silhouette(svg);
    const declared = declaredPaints(svg);

    // NON-VACUITY. A file declaring nothing would make the colour comparison trivial.
    expect(declared, 'the stencil declares no paint at all, so this case is vacuous').not.toEqual([]);

    // MONOCHROME, asserted as the file's OWN declared paint plus transparency rather than as a
    // count of two. `declaredPaints` excludes `none`, so a stencil that gained a second colour
    // fails here by showing a value the comparison did not expect.
    expect([...stencil.colours].sort()).toEqual(['0,0,0,0', ...declared.map(hexToRgba)].sort());
    expect(declared, 'the stencil is no longer monochrome').toHaveLength(1);

    // NOT BLACK, which is what usvg falls an unresolvable paint back to. A stencil painted with
    // a `var()` reference would render one opaque colour too, and it would be the wrong one.
    expect([...stencil.colours], 'the stencil rendered fully opaque black, which is the var() fallback').not.toContain(OPAQUE_BLACK);
    expect(stencil.transparent, 'the stencil has no transparent ground at all').toBeGreaterThan(0);
  });

  it('THE CONTROL, measured in the same run: the plated master has no transparency and no hole', () => {
    // The honest negative subject, and it is a committed file rather than a constructed one.
    // D-08 gives the master a full bleed plate, so it cannot have a hole and cannot be less
    // than fully covered. That is exactly what MARK-07 refuses for a stencil, which is what
    // makes it the right control - and it is hex painted, so unlike `logomark.svg` the
    // rasteriser reads it as authored (81-RESEARCH.md F-4).
    const plated = silhouette(readFileSync(MASTER_PATH, 'utf8'));

    expect(plated.pixels, 'the plated master rendered zero pixels, so this case is vacuous').toBeGreaterThan(0);
    expect(plated.transparent, 'the plated master has a transparent pixel, so its plate is not full bleed').toBe(0);
    expect(plated.enclosed, 'the plated master reported an enclosed hole, so the instrument is not measuring what it claims').toBe(0);
  });

  it('covers strictly less and encloses strictly more than the plated master', () => {
    // BOTH numbers are measured in this run, and neither is written down. A remembered
    // percentage stops being a measurement the moment the rasteriser or the render size moves;
    // compared against a control measured beside it, this holds on any renderer.
    const stencil = silhouette(readFileSync(STENCIL_PATH, 'utf8'));
    const plated = silhouette(readFileSync(MASTER_PATH, 'utf8'));

    expect(plated.coverage, 'the control covers nothing, so this case is vacuous').toBeGreaterThan(0);
    expect(stencil.coverage, 'the stencil covers nothing at all').toBeGreaterThan(0);

    // THE LOAD-BEARING LINES.
    expect(stencil.coverage, 'the stencil covers as much as a plated square, so it is a slab').toBeLessThan(plated.coverage);
    expect(stencil.enclosed, 'the stencil encloses no more holes than a plated square').toBeGreaterThan(plated.enclosed);
  });

  it('THE GATE CAN FAIL: prepending a full bleed plate erases BOTH properties at once', () => {
    // The mutation, run as a case rather than described in a comment, and it is exactly the
    // careless edit MARK-07 exists to catch: "give the stencil a background so it reads on
    // light chrome". The plate path is READ OUT OF THE MASTER rather than authored here, so
    // the mutation cannot drift from the drawing it mutates and no coordinate or colour is
    // transcribed into this spec.
    const committed = readFileSync(STENCIL_PATH, 'utf8');
    const plateLine = readFileSync(MASTER_PATH, 'utf8')
      .split('\n')
      .find((l) => l.trimStart().startsWith('<path') && l.includes('data-part="plate"'));

    // NON-VACUITY, and it is the half that carries the case. A mutation that found no plate
    // would leave the mutant identical to the stencil, and the assertions below would be
    // measuring a correct file while claiming to measure a broken one.
    expect(plateLine, 'the master declares no plate, so this mutation is vacuous').toBeDefined();

    const mutantText = committed.replace(
      /(<svg[^>]*>\n)/,
      (m) => `${m}${(plateLine as string).trimEnd()}\n`,
    );
    expect(mutantText, 'the plate was not prepended, so this case proves nothing').not.toBe(committed);

    const mutantPath = join(tmpRoot, 'stencil-with-full-bleed-plate.svg');
    writeFileSync(mutantPath, mutantText);

    const mutant = silhouette(readFileSync(mutantPath, 'utf8'));
    const plated = silhouette(readFileSync(MASTER_PATH, 'utf8'));

    expect(mutant.pixels, 'the mutant rendered zero pixels, so this case is vacuous').toBeGreaterThan(0);

    // Both properties the cases above assert are gone at once, and each is compared against
    // the control measured in the same run rather than against a literal.
    expect(mutant.enclosed, 'the plated stencil still encloses a hole').toBe(plated.enclosed);
    expect(mutant.coverage, 'the plated stencil does not cover as much as the plated master').toBe(plated.coverage);
    expect(mutant.transparent, 'the plated stencil kept a transparent pixel').toBe(plated.transparent);

    // The tracked stencil is untouched.
    expect(readFileSync(STENCIL_PATH, 'utf8'), 'this spec modified the committed stencil').toBe(committed);
  });
});
