// bitMatrixIdiom.test.ts (CHROME-01, plan 59-02) - the bit-matrix icon idiom is GONE
// from `frontend/src/chrome/`, not left dormant.
//
// WHY AN ANTI-PATTERN NEEDS ITS OWN GATE. CHROME-01's success criterion is written as an
// ABSENCE ("the idiom is gone rather than left dormant"), and an absence is not proved by
// a passing happy path: every icon can render perfectly from a vector asset while a dead
// `SpriteIcon` and eleven matrices sit beside it waiting to be reached for by the next
// person who needs a twelfth icon in a hurry. The three shapes below are the ones that
// would let that happen, and this file is the thing that reddens.
//
// COMMENTS ARE STRIPPED BEFORE SCANNING, AND THAT IS LOAD-BEARING RATHER THAN TIDY. The
// corrected `icons.tsx` header legitimately QUOTES the retired constructs by name - that
// is the repo's correct-in-place documentation rule, quote the superseded claim rather
// than silently delete it - so a walker that measured prose would be self-invalidating:
// the very act of recording the deletion would trip the gate that proves it. Same idiom
// as `ConfigPanel.test.tsx:340-358`, extended to preserve LINE NUMBERS so a finding can
// name where it is.
//
// THE STRIPPER IS DELIBERATELY NAIVE and its one failure mode is stated here rather than
// discovered: it does not understand string literals or regex literals, so a `//` inside
// a URL string blanks the rest of that line. That direction of error can only produce a
// FALSE GREEN, never a false red, which is why the mutation below is not optional - a
// re-introduced matrix literal is observed to redden this file rather than assumed to.
//
// THE GREEN NEGATIVE IS A REQUIRED ASSERTION, NOT AN OPTIONAL ONE. Plan 59-03 introduces
// `--fab-bezel-ring-shadow`, a legitimately COMPOSED multi-band `box-shadow`. A walker
// that also killed that would be weakened or reverted by the next executor rather than
// tightened, so the case that proves it does not fire on the ring ships in the same file
// as the case that proves it fires on a matrix.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** `frontend/src/chrome/` - this spec lives in it. */
const CHROME_DIR = import.meta.dirname;

// THE ONE EXEMPTION IS GONE, AND IT RETIRED ITSELF EXACTLY AS DESIGNED. Plan 59-02 shipped
// a length-pinned allowlist here:
//
//   const PENDING_59_04: readonly string[] = ['LogoMark.tsx'];
//
// ... guarding the last file in the directory that still carried the idiom, together with a
// case asserting the exempt file STILL TRIPPED all three rules. That case's own message read
// "Delete PENDING_59_04 and this case; the gate above then covers the whole directory".
// Plan 59-04 vectorised the mark, the case reddened on the first full run
// (`expected Set{} to deeply equal Set{ 'matrix-literal', 'matrix-shadow-helper',
// 'per-bit-shadow' }`), and the list and the case were DELETED rather than extended or
// re-pointed at another file. THE GATE IS NOW ABSOLUTE: every shipped module under
// `frontend/src/chrome` is scanned, with no skip and no allowlist to grow, which is what
// CHROME-01's absence criterion asks for. Recorded here rather than silently removed,
// because an allowlist that leaves no trace is one nobody can tell was ever discharged.

type RuleId = 'matrix-literal' | 'matrix-shadow-helper' | 'per-bit-shadow';

interface Finding {
  rule: RuleId;
  /** 1-based source line. */
  line: number;
  /** The matched text, trimmed, for a message a reader can act on. */
  found: string;
}

/**
 * Blank out line and block comments IN PLACE, preserving every newline and every column.
 *
 * Column preservation is what lets a finding carry a real line number; the
 * `ConfigPanel.test.tsx` version collapses the text because it only ever answers yes/no.
 */
function stripComments(source: string): string {
  const blank = (m: string): string => m.replace(/[^\n]/g, ' ');
  return source.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (source.charCodeAt(i) === 10) line++;
  return line;
}

/**
 * THE THREE SHAPES, scanned over comment-stripped source.
 *
 * Exported as a PURE function of a string so the same walker that measures the shipped
 * tree can be pointed at a fixture - which is what makes both the RED mutation and the
 * GREEN negative real assertions instead of narrated ones.
 */
export function scanBitMatrixIdiom(source: string): Finding[] {
  const src = stripComments(source);
  const out: Finding[] = [];
  const add = (rule: RuleId, index: number, found: string): void => {
    out.push({ rule, line: lineOf(src, index), found: found.trim().replace(/\s+/g, ' ').slice(0, 80) });
  };

  // --- 1. A TWO-DIMENSIONAL NUMERIC ARRAY LITERAL, in either of its two written forms:
  // the `number[][]` type annotation the shipped code used on every matrix, and the bare
  // `[[0, 1, ...]` value an author could reach for without ever naming the type.
  for (const m of src.matchAll(/\bnumber\s*\[\s*\]\s*\[\s*\]/g)) {
    add('matrix-literal', m.index, m[0]);
  }
  for (const m of src.matchAll(/\[\s*\[\s*-?\d+\s*(?:,|\])/g)) {
    add('matrix-literal', m.index, m[0]);
  }

  // --- 2. A HELPER THAT BUILDS A SHADOW LIST BY ITERATING A MATRIX. Caught two ways: by
  // the shipped NAME (`spriteShadow`, which is what a copy-paste from git history brings
  // back), and structurally - a function whose parameters mention a matrix and whose body
  // mentions a shadow. The structural form is the one that survives a rename.
  for (const m of src.matchAll(/\bspriteShadow\b/g)) {
    add('matrix-shadow-helper', m.index, m[0]);
  }
  const FN = /\bfunction\s+[A-Za-z0-9_$]*\s*\(([^)]*)\)|(?:const|let|var)\s+[A-Za-z0-9_$]+\s*(?::[^=\n]*)?=\s*\(([^)]*)\)\s*(?::[^=>\n]*)?=>/g;
  for (const m of src.matchAll(FN)) {
    const params = m[1] ?? m[2] ?? '';
    if (!/\bmatrix\b/i.test(params)) continue;
    // The body is not parsed - a fixed window after the signature is enough to separate
    // "takes a matrix and composes a shadow" from "takes a matrix" for any other reason.
    if (!/shadow/i.test(src.slice(m.index, m.index + 600))) continue;
    add('matrix-shadow-helper', m.index, m[0]);
  }

  // --- 3. A SHADOW VALUE COMPOSED PER SET BIT. The shape is an interpolated OFFSET PAIR
  // with zero blur and zero spread - `${c * scale}px ${r * scale}px 0 0` - which is what
  // one filled block per bit looks like and is nothing else. Deliberately NOT "a
  // box-shadow with several commas": that is the legitimate composed bezel ring plan
  // 59-03 introduces, and the green negative below pins that it stays green.
  for (const m of src.matchAll(/`[^`]*\$\{[^`{}]*\}px\s+\$\{[^`{}]*\}px\s+0\s+0[^`]*`/g)) {
    add('per-bit-shadow', m.index, m[0]);
  }
  // ... and the assignment form, where the composition has been moved into a helper whose
  // name still says what it does.
  for (const m of src.matchAll(/\bboxShadow\s*:\s*[A-Za-z0-9_$.]*[Ss]hadow\s*\(/g)) {
    add('per-bit-shadow', m.index, m[0]);
  }

  return out.sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule));
}

/**
 * Every SHIPPED `.ts` / `.tsx` module under `frontend/src/chrome/`, recursively.
 *
 * SPECS ARE OUT OF SCOPE, and the reason is the definition of the thing being hunted
 * rather than convenience. The bit-matrix idiom is a RENDER PATH: it is a defect only
 * where it can put pixels on a user's screen, and no `*.test.ts(x)` file does. Scoping it
 * to shipped modules also keeps the gate HONEST in the other direction - measured, two
 * committed chrome specs carry legitimate two-dimensional numeric arrays that have
 * nothing to do with icons (`PortsSection.test.tsx:422` and `:440`, a port-layout
 * expectation table; `reducedMotion.test.ts:65`, a frame-pair table). Including specs
 * would mean writing those three in as exemptions on day one, and a rule that ships with
 * an exemption list is the rule this milestone keeps finding has stopped meaning
 * anything. This file's OWN fixtures would be a fourth.
 */
function chromeSourceFiles(dir = CHROME_DIR, prefix = ''): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.isDirectory()) {
      out.push(...chromeSourceFiles(join(dir, e.name), `${prefix}${e.name}/`));
    } else if (e.isFile() && /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
      out.push(`${prefix}${e.name}`);
    }
  }
  return out;
}

/**
 * THE FILE COUNT, as a stated literal - never `chromeSourceFiles().length`.
 *
 * The same vacuity refusal `lintSvg.test.ts` and `vertexBudget.test.ts` carry, and it
 * bites hardest on a WALKER: a discovery that silently returned nothing would report a
 * clean pass over zero files, which is precisely the shape of a gate that "proves" an
 * absence by looking at nothing. Edited by hand when a chrome module is added. 39 -> 40
 * 39 -> 41 in plan 61-06 (`graphicsSettings.ts`, the storage adapter; `GraphicsPanel.tsx`,
 * the panel itself). 41 -> 42 in plan 62-07 (the development pace panel, which was behind
 * a Vite define and absent from every shipped bundle - but it was a chrome SOURCE file
 * and this walker reads sources, not bundles). 42 -> 43 in plan 64-06
 * (`RefusalMessage.tsx`, the host-refusal message surface: the always-mounted polite live
 * region and its 17-row copy table). 43 -> 44 in plan 65-02 (`RouterConfigBody.tsx`, the
 * Router rules editor body). 44 -> 45 in plan 68-02 (`BeltConfigBody.tsx`, the Belt pace
 * segmented control). 45 -> 44 in plan 68-07, which DELETED the development pace panel
 * added at 62-07 along with the rest of the development pace switch (BELT-05 / D-68-12;
 * the deleted path is named in `68-07-SUMMARY.md`, and deliberately not named here -
 * `scripts/check-dev-pace-switch-absent.sh` asserts that name appears zero times
 * anywhere in the tree, and this file is inside its scan set). A `.test.ts` sibling is
 * NOT counted - the walk excludes specs by design, see the note above.
 *
 * 44 -> 45 in plan 72-10 (`RouteConfigBody.tsx`, the Route's Path field and the
 * client-side path gate - the per-kind body every other configurable kind already has).
 * This move does NOT offset anything: 72-10 deletes no chrome source, so unlike the
 * 68-02/68-07 pair below it is a plain increment with one cause.
 *
 * IT MOVED TWICE INSIDE PHASE 68, THE TWO MOVES OFFSET EXACTLY, AND THAT IS THE HAZARD.
 * 68-02 added a chrome source; 68-07 deleted one. **Across the phase this number is net
 * unmoved, so it could not have caught a 68-07 that shipped the addition and forgot the
 * deletion** - both walkers would have sat green at 45. That is `68-UI-SPEC.md` 6.1's
 * arithmetic-accident warning, and the two history lines above are the only thing that
 * makes the offsetting pair visible to a reader. The check that actually catches the
 * omission is `scripts/check-dev-pace-switch-absent.sh`, which is why its non-vacuity
 * prover is load-bearing for this file and not only for the host half of the removal.
 * Holding the constant at 44 through the gap would ALSO have left this walker RED for
 * three waves and made every intermediate plan's frontend gate unsatisfiable, so the
 * honest number is stated at each wave rather than netted out invisibly.
 *
 * 45 -> 46 in plan 73-04 (`LoadRefusedCard.tsx`, the card that says why a `.fab` file
 * will not open - UNDO-09). A plain increment with one cause: 73-04 deletes no chrome
 * source. Its `.test.tsx` sibling is NOT counted, per the exclusion above.
 *
 * 46 -> 47 in plan 80.1-01 (`HeaderLockup.tsx`, the component that renders the generated
 * header cut of the lockup - MARK-17). A plain increment with one cause: 80.1-01 deletes
 * no chrome source. Its emitted asset, `chrome/brand/fabrico-header.svg`, is NOT counted
 * and could not be: this walk filters `/\.tsx?$/`, so the whole `chrome/brand/`
 * subdirectory is invisible to it.
 *
 * 47 -> 48 in the 80.1 code review fix pass (`headerLockupMetrics.ts`, the ONE declaration
 * of the header lockup's shipped height, WR-01). A plain increment with one cause and no
 * offsetting deletion. It is a values module rather than a component, which is why it is
 * worth naming here: this walk counts chrome SOURCE FILES, not chrome components, so the
 * number moves for it exactly as it does for a new panel.
 *
 * 48 -> 49 in plan 74.1-19 (`portEditGrace.ts`, the controller that holds the pending
 * port-edit status back for its grace so a fast fold paints no text, re-walk J10). A
 * plain increment with one cause and no offsetting deletion; its `.test.ts` sibling is
 * not counted.
 *
 * 49 -> 51 in plan 76-02 (phase 76, labels): `LabelConfigBody.tsx`, the label panel's
 * Text field, and `LabelWords.tsx`, the DOM overlay that draws a label's words on the
 * board. Two plain increments, no offsetting deletion; their `.test.tsx` siblings are not
 * counted.
 *
 * 51 -> 52 in the plan 76-17 refuter round (`selectionEpoch.ts`, the counter App keys its
 * ConfigPanels on and gates their sends on, so a reminted handle number is not mistaken
 * for the old selection). A plain increment, no offsetting deletion; its `.test.ts`
 * sibling is not counted.
 *
 * 52 -> 53 in plan 77-04 (`hudCounts.ts`, `machineCountOf`, the HUD's machine count that
 * leaves labels out). A plain increment, no offsetting deletion; its `.test.ts` sibling is
 * not counted.
 *
 * 53 -> 52 on 2026-10-11, BY HAND: `LogoMark.tsx` deleted. The square's component had no
 * production consumer after MARK-17 (the header draws `HeaderLockup`), so it was retired
 * under the clean-break rule. A plain decrement, no offsetting addition; its deleted
 * `.test.tsx` sibling was never counted.
 *
 * 52 -> 53 in plan 85-06 (`sceneFit.ts`, `takeFit`, the rule that frames each loaded
 * board, DEMO-07). A plain increment, no offsetting deletion; its `.test.ts` sibling is
 * not counted.
 *
 * 53 -> 54 in plan 90-05 on 2026-10-23 (`configCopy.ts`, the config panel's not-applied
 * words, D-05). A plain increment, no offsetting deletion; its `.test.ts` sibling is not
 * counted.
 *
 * 54 -> 55 in plan 90-07 on 2026-10-24 (SimStoppedCard.tsx, the card a fatal sim error shows,
 * D-12). A plain increment, no offsetting deletion; its .test.tsx sibling is not counted.
 *
 * 55 -> 53 in plan 91-03 on 2026-10-24 (Hud.tsx and hudCounts.ts deleted, D-02): the
 * bottom-right readout and its machine count, removed with no replacement (CHROME-01). Two
 * plain decrements, no offsetting addition; the deleted hudCounts.test.ts was never counted.
 *
 * 53 -> 51 in plan 91-03 on 2026-10-24 (GraphicsPanel.tsx and graphicsSettings.ts deleted,
 * D-04): the Graphics panel and its belt step setting, removed with their trigger
 * (CHROME-03). Two plain decrements; their deleted test siblings were never counted.
 */
const EXPECTED_CHROME_SOURCE_FILES = 51;

describe('the bit-matrix icon idiom is GONE from frontend/src/chrome, not dormant', () => {
  const files = chromeSourceFiles();

  it('walks a non-empty, stated number of chrome source files', () => {
    expect(files.length).toBeGreaterThan(0);
    expect(files).toHaveLength(EXPECTED_CHROME_SOURCE_FILES);
    // The walk reaches SUBDIRECTORIES. `chrome/assets/registry.ts` is the only one today,
    // and a scanner that silently stopped at the top level would certify a directory it
    // never opened.
    expect(files).toContain('assets/registry.ts');
    expect(files).toContain('icons.tsx');
  });

  it('finds no matrix literal, no matrix-shadow helper and no per-bit shadow composition', () => {
    const offenders: string[] = [];
    // NO SKIP. Plan 59-02's `PENDING_59_04` allowlist sat here and was deleted by 59-04.
    for (const rel of files) {
      for (const f of scanBitMatrixIdiom(readFileSync(join(CHROME_DIR, rel), 'utf8'))) {
        offenders.push(`${rel}:${f.line}  ${f.rule}  ${f.found}`);
      }
    }
    expect(
      offenders,
      'The bit-matrix icon idiom is back under frontend/src/chrome. Every chrome glyph is ' +
        'an authored .svg in chrome/assets/ read through svgToElements; a matrix here is a ' +
        'second, drifting art pipeline.\n' +
        offenders.join('\n'),
    ).toEqual([]);
  });

  // A NAMED CASE ON `LogoMark.tsx` SAT HERE AND WAS DELETED WITH THAT FILE (2026-10-11).
  // It read "covers LogoMark.tsx with NO exemption - the last carrier of the idiom, now
  // vectorised" and asserted the walk returned that file and found nothing in it. The file
  // is gone (no production surface rendered the square after MARK-17), so the case had no
  // subject. Its vacuity argument, that a bare "no offenders" read stays green if discovery
  // stops returning files, is still answered by the stated count pin and the two
  // `toContain` reads in the first case of this block.
});

describe('the walker fires on the three shapes and NOT on the legitimate composed ring', () => {
  it('fires on a two-dimensional numeric array literal, typed or bare', () => {
    expect(scanBitMatrixIdiom('const PLAY: number[][] = [];').map((f) => f.rule)).toContain(
      'matrix-literal',
    );
    expect(scanBitMatrixIdiom('const m = [[0, 1], [1, 0]];').map((f) => f.rule)).toContain(
      'matrix-literal',
    );
    // A single-column matrix is still a matrix.
    expect(scanBitMatrixIdiom('const m = [[1], [0]];').map((f) => f.rule)).toContain(
      'matrix-literal',
    );
  });

  it('fires on a matrix-to-shadow helper, by name AND structurally after a rename', () => {
    expect(scanBitMatrixIdiom('const s = spriteShadow(m, 2);').map((f) => f.rule)).toContain(
      'matrix-shadow-helper',
    );
    // Renamed, retyped, arrow form - still a function taking a matrix and composing a
    // shadow, which is the property, not the name.
    const renamed = [
      'function blockList(matrix: ReadonlyArray<ReadonlyArray<number>>, scale: number): string {',
      '  const parts = [];',
      '  return parts.join(", "); // a box-shadow list',
      '}',
    ].join('\n');
    expect(
      scanBitMatrixIdiom(renamed.replace('// a box-shadow list', 'const shadow = 1;')).map(
        (f) => f.rule,
      ),
    ).toContain('matrix-shadow-helper');
  });

  it('fires on a per-set-bit shadow value', () => {
    expect(
      scanBitMatrixIdiom('parts.push(`${c * scale}px ${r * scale}px 0 0`);').map((f) => f.rule),
    ).toContain('per-bit-shadow');
  });

  it('THE REQUIRED GREEN NEGATIVE: it does not fire on plan 59-03 composed bezel ring', () => {
    // The exact composition 59-UI-SPEC specifies, in both the forms it will appear in -
    // the emitted CSS custom property and a rule consuming it. A walker that reddened
    // here would be weakened by the next executor rather than tightened, which is how a
    // gate stops meaning anything.
    const ring = [
      '--fab-bezel-ring: 6px;',
      '--fab-bezel-band: 1px;',
      '--fab-bezel-ring-shadow:',
      '  inset calc(-1 * var(--fab-bezel-band)) calc(-1 * var(--fab-bezel-band)) 0 0 var(--fab-edge-shadow),',
      '  inset var(--fab-bezel-band) var(--fab-bezel-band) 0 0 var(--fab-edge-lit),',
      '  inset 0 0 0 calc(2 * var(--fab-bezel-band)) var(--fab-outline);',
      '.fab-tool-btn { box-shadow: var(--fab-bezel-ring-shadow); }',
      '.fab-tool-btn:hover { box-shadow: inset 1px 1px 0 0 var(--fab-edge-lit), var(--fab-bezel-ring-shadow); }',
      '.fab-dialog-btn.is-pressed { box-shadow: inset 2px 2px 0 0 var(--fab-edge-shadow), inset -2px -2px 0 0 var(--fab-edge-lit), var(--fab-bezel-ring-shadow); }',
    ].join('\n');
    expect(scanBitMatrixIdiom(ring)).toEqual([]);

    // And the band's own emitter, which DOES interpolate a px length. One interpolated
    // offset is not an offset PAIR, so the per-bit rule stays quiet; this is the nearest
    // legitimate neighbour of the shape it hunts.
    expect(scanBitMatrixIdiom('const band = `${Math.round(dpr) / dpr}px`;')).toEqual([]);
  });

  it('does not fire on an ordinary one-dimensional numeric array or a plain box-shadow', () => {
    expect(scanBitMatrixIdiom('const ramp = [0, 1, 2, 3];')).toEqual([]);
    expect(scanBitMatrixIdiom('style={{ boxShadow: "inset 0 0 0 1px var(--fab-outline)" }}')).toEqual(
      [],
    );
  });

  it('measures CODE, not prose: the corrected icons.tsx header names the retired constructs and stays green', () => {
    // The self-invalidation case, made concrete. This text is the shape of the real
    // header. Without comment stripping it trips two of the three rules, and the gate
    // would then be reddened by the documentation of its own success.
    const prose = [
      '// they are STILL authored here in the 0/1 number[][] idiom and rendered as a',
      '// crisp CSS `box-shadow` sprite via spriteShadow(matrix, scale).',
      '/* const PLAY: number[][] = [[0, 1], [1, 0]]; */',
      'export const ok = 1;',
    ].join('\n');
    expect(scanBitMatrixIdiom(prose)).toEqual([]);
    // ... and the same text WITHOUT the comment markers is caught, so the case above is
    // measuring the stripper rather than a scanner that finds nothing anywhere.
    expect(scanBitMatrixIdiom('const PLAY: number[][] = [[0, 1], [1, 0]];').length).toBeGreaterThan(
      0,
    );
  });
});
