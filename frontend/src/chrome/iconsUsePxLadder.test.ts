// iconsUsePxLadder.test.ts (CHROME-01, phase 59 review WR-05) - no shipped chrome module
// hands an icon a NUMERIC LITERAL for its `px` size.
//
// WHY THIS EXISTS, AND WHY IT IS A SOURCE WALKER. `render/synth/chrome/iconSizes.ts` is
// declared to be the ONE declaration of the size ladder, and until this gate landed that
// was a claim nobody checked: five call sites passed the literal `16` rather than
// `ICON_MD_PX`, so if the floor ever moved they would silently stay at 16 - the exact
// drift the ladder was created to remove, in the surface it was created for. All five were
// also redundant, since 16 IS the `px` default, which is what makes the literal so easy to
// write and so invisible afterwards.
//
// A RENDER TEST CANNOT SEE THIS. `<WarningIcon px={16} />` and `<WarningIcon />` produce
// byte-identical markup today; the defect is not in what renders, it is in what the render
// is COUPLED to. The declaration is where it is visible, which is where this looks.
//
// SCOPED TO SHIPPED MODULES, the `bitMatrixIdiom.test.ts` scoping and for its reason: a
// spec or a fixture may legitimately pass an explicit size to pin a rendered box, and a
// rule that ships with exemptions is the shape of rule this milestone keeps finding has
// stopped meaning anything. `src/spike/chromeDpr.tsx` is outside this directory and passes
// `ICON_MD_PX` / `ICON_LG_PX` by name anyway.
//
// COMMENTS ARE BLANKED BEFORE SCANNING, the same load-bearing idiom as the sibling
// walkers: this file's own record of the five deleted literals, and any docblock that
// quotes one, must not trip the gate that records their deletion.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as icons from './icons.tsx';
import { ICON_MD_PX, ICON_LG_PX } from '../render/synth/chrome/iconSizes.ts';

/** `frontend/src/chrome/` - this spec lives in it. */
const CHROME_DIR = import.meta.dirname;

/** Blank `//` and block comments in place, preserving newlines so a finding keeps its line. */
function stripJsComments(source: string): string {
  const blank = (m: string): string => m.replace(/[^\n]/g, ' ');
  return source.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

/** Every SHIPPED `.ts` / `.tsx` module under `frontend/src/chrome/`, recursively. */
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

/**
 * Every icon component name, DERIVED from the module namespace rather than transcribed.
 *
 * Same derivation `icons.test.tsx` uses for its coverage sweep, and for the same reason: a
 * twenty-first icon is covered the moment it is exported, not when somebody remembers to
 * add it here. `LogoMark` and `HeaderLockup` are included by name because they are the TWO
 * chrome glyph components that do NOT live in `icons.tsx` - neither takes a `px` prop
 * today, and naming them is what makes the gate bite if either ever gains one.
 *
 * CORRECTED IN PLACE (plan 80.1-01, MARK-17). That sentence read "`LogoMark` is included
 * by name because it is the ONE chrome glyph component that does NOT live in
 * `icons.tsx`", and it went false the moment this phase added a second one. THE DECISION
 * TO ADD `HeaderLockup` RATHER THAN LEAVE IT OUT, written down because both were
 * defensible. Leaving it out is arguable on the grounds that the header cut is not an
 * icon: it is a brand artefact at a crop viewBox, it renders at a derived width rather
 * than on the size ladder, and it takes no `px` prop. But the docblock's OWN stated reason
 * for naming `LogoMark` applies to it verbatim - a chrome glyph component outside
 * `icons.tsx`, whose gate should bite if it ever gains a `px` prop - and the alternative
 * leaves a true-sounding sentence false with no gate on it. The sentence is corrected and
 * the component is named.
 *
 * `LogoMark` LEFT THE LIST ON 2026-10-11, WITH ITS FILE. The square's component,
 * `LogoMark.tsx`, was retired because no production surface rendered it after MARK-17, so
 * no chrome module can mount it and naming it would scan for a tag nothing can write
 * without first failing to import. `HeaderLockup` is now the ONE chrome glyph component
 * outside `icons.tsx`, and the reason for naming it stands on its own.
 */
const ICON_COMPONENTS: readonly string[] = [
  ...Object.keys(icons).filter((k) => /^[A-Z]/.test(k)),
  'HeaderLockup',
];

describe('the chrome icon size ladder has no second declaration at a call site', () => {
  it('derives a non-empty icon component set from the module namespace', () => {
    // Vacuity refusal. A namespace walk that matched nothing would make the sweep below
    // pass over zero components forever. Twenty-two exports today (20 -> 21 at plan
    // 61-06, the Graphics trigger's fader glyph; 21 -> 22 at plan 66-01, `WireIcon`), the same stated figure
    // `icons.test.tsx` pins, plus `LogoMark` and `HeaderLockup` (23 -> 24 at plan
    // 80.1-01, the second chrome glyph component outside `icons.tsx`). 24 -> 25 in phase
    // 76 (plan 76-01): `LabelIcon`, the Palette Label row's glyph. 25 -> 24 on 2026-10-11,
    // BY HAND: `LogoMark` left the named list when `LogoMark.tsx` was deleted (the square
    // was no longer rendered anywhere in the app). No icons.tsx export moved.
    // 24 -> 23 in plan 91-03 on 2026-10-24 (the Graphics trigger's fader glyph deleted with
    // the Graphics panel, D-04).
    expect(ICON_COMPONENTS).toContain('WarningIcon');
    expect(ICON_COMPONENTS).toContain('MachineGlyphIcon');
    expect(ICON_COMPONENTS).toContain('LabelIcon');
    expect(ICON_COMPONENTS.length).toBe(23);
  });

  it('no shipped chrome module passes a NUMERIC LITERAL to an icon px prop', () => {
    // MUTATION: put `px={16}` back on any one of the five call sites this closed
    // (StatusReadout, ConfigPanel, DeleteControl, DeleteGuardDialog, QuitGuardDialog)
    // -> this reddens, naming the file, the line and the component.
    const names = ICON_COMPONENTS.join('|');
    const offenders: string[] = [];
    for (const rel of chromeSourceFiles()) {
      const src = stripJsComments(readFileSync(join(CHROME_DIR, rel), 'utf8'));
      const lines = src.split('\n');
      lines.forEach((line, i) => {
        for (const m of line.matchAll(new RegExp(`<(${names})\\b[^>]*?\\bpx=\\{\\s*(\\d)`, 'g'))) {
          offenders.push(`${rel}:${i + 1}  <${m[1]} px={${m[2]}...}>`);
        }
      });
    }
    expect(
      offenders,
      'An icon size is a LITERAL at the call site. iconSizes.ts is the one declaration of ' +
        `the ladder (ICON_MD_PX ${ICON_MD_PX} / ICON_LG_PX ${ICON_LG_PX}); a literal here ` +
        'silently stays put if the floor moves. Pass ICON_MD_PX / ICON_LG_PX, or drop the ' +
        `prop entirely if the value is the ${ICON_MD_PX}px default.\n` + offenders.join('\n'),
    ).toEqual([]);
  });

  it('is not vacuous: the same walk DOES find the ladder constants being used by name', () => {
    // The required positive control. An `offenders` list that is empty because the scan
    // matches nothing is indistinguishable from one that is empty because the tree is
    // clean - unless something proves the walk reaches real call sites. `Palette.tsx`,
    // `Legend.tsx` and `Toolbar.tsx` each bind a size constant to the ladder by name.
    const bound: string[] = [];
    for (const rel of chromeSourceFiles()) {
      const src = stripJsComments(readFileSync(join(CHROME_DIR, rel), 'utf8'));
      if (/\b(ICON_MD_PX|ICON_LG_PX)\b/.test(src)) bound.push(rel);
    }
    expect(bound.sort()).toEqual(['Legend.tsx', 'Palette.tsx', 'Toolbar.tsx', 'icons.tsx']);
  });
});
