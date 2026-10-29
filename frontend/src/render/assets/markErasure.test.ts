// markErasure.test.ts - MARK-11, measured (plan 80-06).
//
// WHAT MARK-11 ASKS. "The symbol has no opaque full-bleed ground; any container which is
// part of the identity is a stroked frame with a real hole; and the silhouette survives a
// circular crop." Three claims about OPACITY: whether a background shows through the
// drawing, and whether what is left after a round mask still reads as the mark. A tray
// icon, a menu-bar glyph and a circular avatar are all circular crops of this file.
//
// WHY THIS SPEC EXISTS AT ALL, AND WHY IT HAS A CONTROL. Phase 79's verdict finding 3 was a
// measurement that could not fail: a `magick` chain that ran `-alpha extract` and then
// `-colorize 100` over the result, which DISCARDS the alpha it had just extracted, so it
// returned ONE AND THE SAME CONSTANT for a fully transparent input and a fully opaque one.
// A number identical at both poles of the property it claims to measure is not a
// measurement. That figure is deliberately not repeated here, in this tree, or in any file
// this plan touched: it is a wrong number and quoting it is how a wrong number survives.
//
// THE REPLACEMENT DOES NOT READ A THRESHOLD EITHER. Every number this spec compares is
// measured in THIS run, from two drawings committed to this repository. A hard-coded
// survival floor would be a number remembered from one rasteriser at one sampling density,
// and it stops being a measurement the moment either changes - a new ImageMagick, a
// different render size, a changed live area. The control is the retired Phase 59 mark,
// whose first path fills the whole author box, so it is a genuine full-bleed negative
// subject rather than a synthetic one.
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
import { GRID, LIVE_MAX, LIVE_MIN, SHIPPED_MARK, paintedCells, type Cell } from '../../../scripts/mark-craft.ts';

/** The shipped square: composition A, the mark under test. */
const SQUARE = SHIPPED_MARK;

/**
 * THE FULL-BLEED CONTROL, and it is a committed drawing rather than a constructed one.
 *
 * `retired-logomark-59.svg`'s first path is `M 0 0 H 32 V 32 H 0 Z` with a panel-grey
 * fill: it paints every cell of the author box, so nothing behind it is ever visible and a
 * circular crop of it can only ever keep the inscribed circle's share of a square. It is
 * exactly what MARK-11 refuses, which is what makes it the right negative subject. Plan
 * 80-05 committed it for the craft gates; this spec is its second reader.
 */
const CONTROL = fileURLToPath(new URL('./__fixtures__/craft/retired-logomark-59.svg', import.meta.url));

/**
 * Unpainted cells INSIDE THE LIVE AREA.
 *
 * The live area (units 2 to 30) is the window every craft rule is measured over: at a 16px
 * render one device pixel is two units, so that is the 14 by 14 device-pixel grid the icon
 * actually gets. A hole outside it is a hole in a margin.
 *
 * `null` means NO PATH PAINTED THIS CELL, which is the question MARK-11 asks. It is
 * deliberately not `isInk`: that helper treats a substrate-coloured cell as void, which is
 * the right answer for counting SHAPES and the wrong one for counting HOLES. A cell painted
 * the ground colour is opaque in every rasteriser - `rsvg-convert` writes alpha 255 there
 * and a circular crop keeps it - so calling it a hole would report a hole the rendered file
 * does not have.
 */
function holes(buf: readonly (Cell | null)[]): number {
  let n = 0;
  for (let y = LIVE_MIN; y < LIVE_MAX; y++) {
    for (let x = LIVE_MIN; x < LIVE_MAX; x++) {
      if (buf[y * GRID + x] === null) n++;
    }
  }
  return n;
}

/**
 * The share of a drawing's painted cells that a circular crop keeps: painted cells whose
 * centre lies inside the circle inscribed in the author box, over painted cells overall.
 *
 * This is the TypeScript form of the corrected raster instrument
 * (`mean(alpha AND circle) / mean(alpha)`, with the circle MULTIPLIED into the alpha), read
 * off the same 32 by 32 buffer the craft rules use. Measured over the whole box rather than
 * the live area, because the crop a tray icon applies does not know what a live area is.
 *
 * A drawing that paints nothing scores 0, so an empty subject can never satisfy the
 * strictly-greater case below by accident.
 */
function survival(buf: readonly (Cell | null)[]): number {
  const centre = GRID / 2;
  const radius = GRID / 2;
  let painted = 0;
  let kept = 0;
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      if (buf[y * GRID + x] === null) continue;
      painted++;
      if (Math.hypot(x + 0.5 - centre, y + 0.5 - centre) <= radius) kept++;
    }
  }
  return painted === 0 ? 0 : kept / painted;
}

/** Painted cells anywhere in the box. The non-vacuity floor for every case below. */
function paintedCount(buf: readonly (Cell | null)[]): number {
  let n = 0;
  for (const cell of buf) if (cell !== null) n++;
  return n;
}

let tmpRoot: string;

/** Write a fixture and read back its painted buffer. Copied in shape from `markCraft.test.ts`. */
function paintFixture(name: string, body: string): readonly (Cell | null)[] {
  const abs = join(tmpRoot, name);
  writeFileSync(abs, body);
  return paintedCells(abs);
}

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'fabrico-mark-erasure-'));
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('MARK-11 erasure - the mark has real holes and survives a circular crop', () => {
  it('the full-bleed control has ZERO holes in the live area', () => {
    const buf = paintedCells(CONTROL);
    // Non-vacuity first: a file that failed to parse would paint nothing, and a buffer of
    // 1024 nulls would report 784 holes rather than zero, so this floor is what stops a
    // broken read looking like a passing control.
    expect(paintedCount(buf)).toBeGreaterThan(0);
    expect(holes(buf)).toBe(0);
  });

  it('the shipped square has real holes in the live area', () => {
    const buf = paintedCells(SQUARE);
    expect(paintedCount(buf)).toBeGreaterThan(0);
    // The frame's interior is `fill="none"` and the ground between the frame and the belt
    // band is painted by nothing at all. Both are the "real hole" MARK-11 requires.
    expect(holes(buf)).toBeGreaterThan(0);
  });

  it('the shipped square survives a circular crop strictly better than the control', () => {
    // BOTH numbers are measured in this run. Neither is written down here, and that is the
    // whole point of the case: a hard-coded threshold is a number remembered from a
    // different rasteriser at a different sampling density, and it stops being a
    // measurement the moment either changes. Compared against a control measured beside it,
    // this assertion holds on any grid and any renderer.
    const square = survival(paintedCells(SQUARE));
    const control = survival(paintedCells(CONTROL));
    expect(control).toBeGreaterThan(0);
    expect(square).toBeGreaterThan(control);
  });

  it('THE GATE CAN FAIL: giving the square a full-bleed ground erases both properties', () => {
    // The mutation, run as a case rather than described in a comment. A ground path added
    // beneath composition A's three paths is exactly the change MARK-11 forbids: it is the
    // opaque full-bleed ground, and it is what a careless "give the icon a background so it
    // reads on light chrome" edit would do.
    const ground = '  <path data-part="ground" d="M 0 0 H 32 V 32 H 0 Z" fill="var(--fab-panel-fill)" />';
    const three = readFileSync(SQUARE, 'utf8')
      .split('\n')
      .filter((l) => l.trimStart().startsWith('<path'))
      .join('\n');
    const mutated = paintFixture(
      'square-with-full-bleed-ground.svg',
      `<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">\n${ground}\n${three}\n</svg>\n`,
    );
    const control = paintedCells(CONTROL);

    expect(paintedCount(mutated)).toBe(GRID * GRID);
    // Both properties the three cases above assert are gone at once, which is what proves
    // they are properties of the drawing rather than of the instrument.
    expect(holes(mutated)).toBe(0);
    expect(survival(mutated)).toBe(survival(control));
  });
});
