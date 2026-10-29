// THE VEC-01 SOURCE GUARD (plan 61-05): no module on the canvas render path imports
// the baked-matrix type, EXCEPT the ones on the written exemption list below.
//
// ===========================================================================
// VEC-01 IS TICKED ON A STATED, NARROWER READING THAN ITS LITERAL TEXT.
// ===========================================================================
//
// THIS SENTENCE MUST APPEAR IN THOSE WORDS in the phase SUMMARY and beside the
// requirement in the requirements ledger, and VEC-01 must NEVER be reported
// unqualified. A silently narrowed requirement is a bookkeeping defect an earlier phase
// already filed once (the executor's state-update step marks every id in a plan's
// frontmatter Complete regardless of what the plan built; Phases 57 and 58 both hit it).
//
// The literal text is "no `PixelMatrix` remains in the canvas render path". What
// actually shipped is "no baked matrix remains on the canvas render path EXCEPT the
// low-detail machine tint blocks, which are exempt for a written reason". The maintainers ruled
// both halves of that on 2026-08-10 (`61-CONTEXT.md` H5) in one call: `layers/items.ts`
// CONVERTS, `layers/lodTints.ts` is EXEMPT in writing.
//
// WHY A LIST IN THE FILE RATHER THAN A COUNT OR A SILENCE. An exemption that exists
// only as the absence of a failure teaches a future reader nothing: they cannot tell a
// deliberate carve-out from a module the guard never reached. Every entry below carries
// its own one-line reason, so the decision is READ rather than inferred - and adding an
// entry is a visible, reviewable diff rather than a test quietly going green again.
//
// ===========================================================================
// THE SCOPE, AND WHAT IS DELIBERATELY OUTSIDE IT.
// ===========================================================================
//
// SCANNED: every non-test module under `src/render/layers/` (the canvas layer set) and
// every non-test `belt*` module under `src/render/synth/` (the belt synth path). Those
// are the two directories `61-CONTEXT.md` names, and between them they are what the
// board actually draws.
//
// NOT SCANNED, each for a stated reason rather than by omission:
//
//   - `src/spike/` is DEV TOOLING (the art board, the pixel guard, the belt corner
//     sheet), not the canvas render path, so VEC-01 does not reach it at all
//     (`61-CONTEXT.md` section F says so explicitly). It is named here because "the
//     guard does not cover it" and "the guard forgot about it" look identical from the
//     outside.
//   - `src/render/synth/generators.ts` HELD the RASTER belt bakes when this guard was
//     written, and plan 61-07 has since DELETED them. The tense is corrected here
//     (plan 61-08) rather than left reading as a pending action, because a comment
//     that describes work as still owed is a comment a reader will go looking for.
//     They were a producer of matrices, not a consumer on the drawn path, so they were
//     never this guard's subject either before or after the deletion. What remains in
//     that module is the MACHINE bake path, and it is likewise not scanned for the same
//     producer-not-consumer reason. RE-GREPPED 2026-08-11 rather than assumed: the
//     matrix PRODUCER `makeGenerators` has exactly ONE non-test consumer in the tree,
//     the art board's slate module, which sits in `src/spike/` - the exempt dev-tooling
//     directory named above. `layers/machines.ts` and `layers/lodTints.ts` import from
//     this module too,
//     but only the `GenKey` TYPE and `DEFAULT_NATIVE_CELL` - never a baker - so the
//     canvas draws no baked matrix except the low-detail tint blocks the list exempts.
//   - TEST modules. A spec may import the type to assert about it - `items.test.ts`
//     did for years - and gating tests would make the retirement untestable.
//
// WHAT THE PATTERN DOES NOT SEE, so its green is not over-read: it matches the baked
// matrix TYPE and its constructor by name in an import clause. It does not follow the
// TEXTURE-UPLOAD path (`matrixToTexture` / `SynthTextureCache`), which several layers
// legitimately still use to upload the exempt blocks; and a module that reconstructed a
// raw RGBA buffer by hand, without naming either symbol, would pass. Both are accepted:
// the requirement is about the baked-matrix REPRESENTATION, and the mutation control at
// the bottom of this file proves the pattern fires on the shape that actually occurs.

import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** `src/render/` - this spec lives in it. */
const RENDER_DIR = import.meta.dirname;

/**
 * THE WRITTEN EXEMPTION LIST. Every entry carries the reason it is here.
 *
 * Keyed by path relative to `src/render/`. Adding an entry is a deliberate act with a
 * reviewable diff; it is not something a passing test should ever do quietly.
 */
const EXEMPT: Readonly<Record<string, string>> = Object.freeze({
  'layers/lodTints.ts':
    'The low-detail machine tint blocks. Solid rectangles shown ONLY below the machine ' +
    'detail cut, where by construction there is no detail to lose to resampling, so ' +
    'converting them would make nothing crisper. The maintainers ruled the exemption on 2026-08-10 ' +
    '(61-CONTEXT.md H5) and required it be written in the code; it is, in that file, ' +
    'naming both the reason and the oversight a reader would otherwise mistake it for.',
});

/**
 * The baked-matrix symbols. The TYPE and its constructor, both from
 * `render/synth/types.ts`: a module that imports either is holding a baked matrix,
 * whichever way it spells the import.
 */
const BAKED_MATRIX_SYMBOLS = ['PixelMatrix', 'makeMatrix'] as const;

/**
 * Blank `//` and block comments in place, preserving newlines and columns.
 *
 * LOAD-BEARING, not tidy - the same reason `chrome/pixelatedRetirement.test.ts` gives.
 * This phase's corrected docblocks deliberately NAME the retired type in prose
 * ("no belt asset is a baked matrix any more", "the retired PixelMatrix bake"), so a
 * walker that measured prose would redden on the very comments that record the
 * retirement. The stripper is deliberately naive - it does not understand string or
 * regex literals - and that error direction can only produce a false GREEN, never a
 * false red, which is why the mutation control below is not optional.
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

export interface MatrixImportFinding {
  line: number;
  /** The symbol that put this import on the list. */
  symbol: string;
  /** The module specifier the import reads from. */
  from: string;
}

/**
 * Scan one module's source for a baked-matrix import.
 *
 * Exported as a PURE function of a string so the same scanner that measures the shipped
 * tree can be pointed at a fixture - which is what makes both the RED mutation and the
 * GREEN negative real assertions rather than narrated ones.
 */
/**
 * THE IMPORT CLAUSE, MATCHED BY ITS REAL SHAPES RATHER THAN BY `import ... from`.
 *
 * The pattern this replaces was `/import\s[\s\S]*?from\s*['"]([^'"]+)['"]/g`, and it is
 * corrected because it MIS-ATTRIBUTED. It required a `from`, so a side-effect import
 * (`import './x.css';`) did not match on its own; instead the lazy `[\s\S]*?` spanned
 * FROM it to the NEXT import's `from`, scanning two statements as one clause and
 * reporting the finding at the side-effect import's line. MEASURED: a total miss is not
 * reachable that way (every matrix import carries a `from`, so the symbol is still
 * found), so the cost was a wrong line number in the offender list rather than a false
 * green. No shipped module in the scanned set uses a side-effect import today, so the
 * guard was correct in fact and fragile by construction.
 *
 * The four arms are the four clause shapes TypeScript admits ahead of a `from`: named,
 * default, default-plus-named, and namespace. A bare side-effect import matches NONE of
 * them, which is right on the merits as well as safe: it binds no symbol, so it cannot
 * import a baked matrix.
 */
const IMPORT_CLAUSE =
  /import\s+(?:type\s+)?(?:\{[^}]*\}|\*\s+as\s+[A-Za-z_$][\w$]*|[A-Za-z_$][\w$]*\s*,\s*\{[^}]*\}|[A-Za-z_$][\w$]*\s*,\s*\*\s+as\s+[A-Za-z_$][\w$]*|[A-Za-z_$][\w$]*)\s*from\s*['"]([^'"]+)['"]/g;

export function scanBakedMatrixImports(source: string): MatrixImportFinding[] {
  const src = stripComments(source);
  const out: MatrixImportFinding[] = [];
  for (const m of src.matchAll(new RegExp(IMPORT_CLAUSE))) {
    const clause = m[0].slice(0, m[0].lastIndexOf('from'));
    for (const symbol of BAKED_MATRIX_SYMBOLS) {
      if (new RegExp(`\\b${symbol}\\b`).test(clause)) {
        out.push({ line: lineOf(src, m.index), symbol, from: m[1] });
      }
    }
  }
  return out;
}

/** Every shipped (non-test) module the guard covers, as paths relative to `src/render/`. */
function scannedModules(): string[] {
  const isShipped = (name: string): boolean => /\.ts$/.test(name) && !/\.test\.ts$/.test(name);
  const layers = readdirSync(join(RENDER_DIR, 'layers'))
    .filter(isShipped)
    .sort()
    .map((n) => `layers/${n}`);
  const beltSynth = readdirSync(join(RENDER_DIR, 'synth'))
    .filter((n) => isShipped(n) && basename(n).startsWith('belt'))
    .sort()
    .map((n) => `synth/${n}`);
  return [...layers, ...beltSynth];
}

/**
 * THE FILE COUNTS, as stated literals - never `scannedModules().length`.
 *
 * The same vacuity refusal `chrome/pixelatedRetirement.test.ts`, `bitMatrixIdiom.test.ts`
 * and `lintSvg.test.ts` all carry, and it bites hardest on a walker proving an ABSENCE:
 * a discovery that silently returned nothing would report a clean pass over zero files.
 * Edited by hand when a layer or a belt synth module is added or removed. 11 since plan
 * 85-02 added `layers/glyphFit.ts` (the glyph placement), which is scanned like the rest.
 */
const EXPECTED_LAYER_MODULES = 11;
const EXPECTED_BELT_SYNTH_MODULES = 3;

describe('VEC-01: the canvas render path holds no baked matrix outside the written exemptions', () => {
  const modules = scannedModules();

  it('walks a non-empty, stated number of shipped modules on both scanned paths', () => {
    expect(modules.filter((m) => m.startsWith('layers/'))).toHaveLength(EXPECTED_LAYER_MODULES);
    expect(modules.filter((m) => m.startsWith('synth/'))).toHaveLength(
      EXPECTED_BELT_SYNTH_MODULES,
    );
    // Named anchors on both paths, so a walk that silently stopped at one directory - or
    // returned a set that happened to be the right SIZE - still fails.
    expect(modules).toContain('layers/items.ts');
    expect(modules).toContain('layers/lodTints.ts');
    expect(modules).toContain('synth/beltGeometry.ts');
    expect(modules).toContain('synth/beltPainter.ts');
  });

  it('finds a baked-matrix import in NO module except the written exemptions', () => {
    const offenders: string[] = [];
    for (const rel of modules) {
      if (rel in EXEMPT) continue;
      for (const f of scanBakedMatrixImports(readFileSync(join(RENDER_DIR, rel), 'utf8'))) {
        offenders.push(`${rel}:${f.line}  imports ${f.symbol} from '${f.from}'`);
      }
    }
    expect(
      offenders,
      'A baked matrix is back on the canvas render path, in a module carrying no written ' +
        'exemption. VEC-01 replaced these with resolution-independent vector geometry so ' +
        'nothing is resampled at a fractional zoom. If this module genuinely cannot lose ' +
        'detail to resampling, add it to EXEMPT with its reason - deliberately, in a diff a ' +
        'reviewer can read - rather than deleting this case.\n' +
        offenders.join('\n'),
    ).toEqual([]);
  });

  it('every exemption is a real module, and every exemption is really exempt', () => {
    // BOTH DIRECTIONS. A stale entry (naming a module that no longer exists, or one that
    // stopped importing a matrix) would silently widen the carve-out and nothing else
    // would notice - which is exactly how a narrowed requirement becomes an open-ended
    // one. The reverse leg keeps every listed reason attached to a live fact.
    for (const [rel, reason] of Object.entries(EXEMPT)) {
      expect(modules, `exemption "${rel}" names a module the guard does not scan`).toContain(rel);
      expect(reason.length, `exemption "${rel}" carries no reason`).toBeGreaterThan(40);
      expect(
        scanBakedMatrixImports(readFileSync(join(RENDER_DIR, rel), 'utf8')).length,
        `exemption "${rel}" no longer imports a baked matrix - delete the entry rather than ` +
          'leaving a carve-out that covers nothing',
      ).toBeGreaterThan(0);
    }
  });

  it('the exempt module carries its exemption IN THE CODE, greppable, with its reason', () => {
    // `61-CONTEXT.md` H5 requires the exemption to live in the code and not only in a
    // planning document, because that is where a future reader lands. This case is what
    // makes that requirement machine-checked rather than a hope.
    const source = readFileSync(join(RENDER_DIR, 'layers/lodTints.ts'), 'utf8');
    expect(source, 'the exemption is not greppable').toMatch(/\bEXEMPT\b/);
    // The REASON, and the MISREADING it forestalls - the two things a bare marker would
    // leave out.
    expect(source, 'the exemption does not name the machine LOD cut it depends on').toMatch(
      /LOD_MIN_MACHINE_PX/,
    );
    expect(source, 'the exemption does not name what it would be mistaken for').toMatch(
      /oversight/i,
    );
    expect(source, 'the exemption is not attributable to the ruling that made it').toMatch(
      /2026-08-10/,
    );
    // And the narrowed reading of VEC-01 is stated where the exemption is, not only here.
    expect(source, 'the narrowed VEC-01 reading is not stated at the exemption').toMatch(
      /stated,\s*narrower reading/i,
    );
  });
});

describe('the scanner fires on a real import and not on the prose that records the retirement', () => {
  it('fires on the type and on the constructor, and reports where from', () => {
    const findings = scanBakedMatrixImports(
      "import { makeMatrix, type PixelMatrix } from '../synth/types.ts';",
    );
    expect(findings.map((f) => f.symbol).sort()).toEqual(['PixelMatrix', 'makeMatrix']);
    expect(findings[0].from).toBe('../synth/types.ts');
  });

  it('fires on a MULTI-LINE import clause, which is how this tree actually writes them', () => {
    // `items.ts` and `lodTints.ts` both wrap their imports. A single-line-only pattern
    // would have passed the shipped tree while covering nothing.
    expect(
      scanBakedMatrixImports("import {\n  makeMatrix,\n  type PixelMatrix,\n} from '../synth/types.ts';"),
    ).toHaveLength(2);
  });

  it('is quiet on a comment that NAMES the retired type (the required green negative)', () => {
    // The exact shape of the corrected docblocks plan 61-05 wrote. A walker that measured
    // these would make recording the retirement impossible.
    const doc = [
      '// the retired PixelMatrix bake is gone; the dot is two circles now (plan 61-05)',
      '/* no belt asset is a PixelMatrix any more - see beltGeometry.ts */',
      '// makeMatrix was the constructor; nothing on this path calls it.',
    ].join('\n');
    expect(scanBakedMatrixImports(doc)).toEqual([]);
  });

  it('a LEADING SIDE-EFFECT import does not swallow the import after it', () => {
    // The failure gated here, MEASURED against the retired pattern rather than assumed:
    // its lazy body spanned from `import './reset.css';` to the NEXT import's `from`, so
    // the two statements were scanned as ONE clause and the finding was reported at
    // **line 1** - the side-effect import's line - instead of line 2. The symbol was
    // still found (every matrix import carries a `from`, so a total miss is not
    // reachable), which is precisely why the LINE assertion below is the discriminating
    // one: without it this case passes under both patterns.
    const src = ["import './reset.css';", "import { makeMatrix } from '../synth/types.ts';"].join(
      '\n',
    );
    const findings = scanBakedMatrixImports(src);
    expect(findings.map((f) => f.symbol)).toEqual(['makeMatrix']);
    expect(findings[0].from).toBe('../synth/types.ts');
    expect(findings[0].line).toBe(2);
    // A side-effect import ALONE binds no symbol, so it is not a finding either.
    expect(scanBakedMatrixImports("import './reset.css';")).toEqual([]);
  });

  it('fires through a DEFAULT and a NAMESPACE clause, not only a named one', () => {
    // The clause arms are only worth having if each one is exercised; a pattern that
    // silently covered just `{ ... }` would pass every case above it.
    expect(scanBakedMatrixImports("import makeMatrix from '../synth/types.ts';")).toHaveLength(1);
    expect(
      scanBakedMatrixImports("import * as makeMatrix from '../synth/types.ts';"),
    ).toHaveLength(1);
    expect(
      scanBakedMatrixImports("import makeMatrix, { type PixelMatrix } from '../synth/types.ts';"),
    ).toHaveLength(2);
  });

  it('is quiet on an import that merely LOOKS adjacent', () => {
    // The type-upload path is deliberately out of scope (see the module header), so an
    // import of it must not be reported as a baked-matrix consumer.
    expect(
      scanBakedMatrixImports("import { matrixToTexture } from '../synth/textureCache.ts';"),
    ).toEqual([]);
    // A local identifier is not an import.
    expect(scanBakedMatrixImports('const makeMatrixLike = () => null;')).toEqual([]);
  });
});
