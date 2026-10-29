// iconCuts.test.ts - the structural gates on the icon generator (MARK-06, MARK-05, MARK-07,
// ICON-03, plans 81-01 and 81-02).
//
// WHAT THIS SPEC IS ACTUALLY FOR. All three files in `docs/brand/` that this generator emits
// are generated files, and a generated file that nothing regenerates is just a drawing with a
// comment claiming otherwise. This spec rebuilds each of the three in memory and compares it
// byte for byte against what is on disk, so a hand edit to any artefact and a drift in the
// generator both redden here rather than surviving to a release.
//
// THE THREE CUTS ARE PINNED AS NAMED FILES, NEVER AS A COUNT (plan 81-02). The brand walk's
// asset list is asserted to contain `fabrico-icon-master.svg`, `fabrico-icon-16.svg` and
// `fabrico-icon-stencil.svg` by name. A count literal would have to be hand-edited the moment
// a later cut is added to the same directory, and a literal that reddens on correct work is how
// an executor learns to edit assertions instead of artefacts. This phase's floor lives HERE, in
// this phase's own spec, and NOT in `lintSvg.test.ts`: that file holds
// `EXPECTED_CHROME_ASSET_COUNT = 15` (D-01), one of the two hand-maintained literals this phase
// must not move, and every walker over `chrome/assets/` is non-recursive so `docs/brand/`
// growing cannot move it. Putting the floor here gets the same property with none of that risk.
//
// AND IT HOLDS THE TWO INDEPENDENCE PROPERTIES THE PARITY GATE RESTS ON. `iconMasterParity`
// asserts the master's geometry equals the shipped chrome square's, reading both from disk.
// That assertion is worth nothing if the generator OBTAINED its geometry from the square:
// the two would then be one declaration read twice, and no coordinate could ever disagree.
// The `does not read` cases below are what make the parity gate a comparison rather than a
// tautology. They are the load-bearing half of this file.
//
// WHY THE NON-VACUITY FLOOR HERE IS A PROBE AND NOT A COUNT, and this is the one place this
// spec departs from `lockup.test.ts`'s shape on a measurement. `buildLockup()` reads two real
// inputs, so "the recorder saw at least one path" is a meaningful floor there.
// `buildIconMaster()` reads NOTHING: its geometry is its own literals and its paint comes
// from an imported function Node resolved before any case ran. So `expect(seen).not.toEqual([])`
// would be RED ON CORRECT WORK here, and an executor who met it would be taught to weaken the
// assertion. The floor that actually carries the claim is a PROBE: read the very path the
// case is about to prove was not read, confirm the recorder caught it, reset, then run the
// builder. A recorder that had silently stopped working fails the probe rather than turning
// the `not.toContain` below it green for free.
//
// WHAT ELSE WOULD MAKE THIS SPEC VACUOUS. Two more shapes, each with a floor against it:
//
//   1. A committed artefact read INSIDE a case. That value is read after whatever the case
//      did, which is the shape that cannot notice a mutation. `COMMITTED_AT_LOAD` is read at
//      module load instead.
//   2. A write-set comparison in one direction only. A generator that wrote its declared
//      outputs AND a fifth file would pass a subset check; one that wrote nothing would pass
//      the other subset check. The comparison below runs in both directions, as sets.
//   3. A cut that emitted an EMPTY BODY. `no-paths` was added to `BRAND_RULES` in review WR-04
//      naming this phase as the reason: the directory grows, so the first added file that
//      failed to generate would have landed green. The rule
//      being present is not the same claim as this generator being covered by it, so the last
//      case below proves the coverage on this phase's own artefact rather than asserting it.
//
// WHY THE MUTATION WRITES THROUGH `node:fs/promises`. The `node:fs` mock below INTERCEPTS
// `writeFileSync` and puts no bytes on disk, which is what lets `writeIcons()` run inside a
// case on a shared checkout. The mutation case needs a real file for `lintDir` to walk, so it
// writes through `node:fs/promises`, a different module and therefore unmocked, into a
// `mkdtempSync` directory removed in `afterAll`. It never writes into `docs/brand/`.
//
// HOW THE RECORDER IS INSTALLED. `vi.mock('node:fs')` below wraps `readFileSync` in a
// pass-through that appends the path to `FS_READS` and then calls the real function, and
// wraps `writeFileSync` in an INTERCEPTOR that records the path and writes nothing. The read
// wrapper is transparent; the write wrapper deliberately is not, so running `writeIcons()`
// inside a case puts no bytes on the tree at all. Concurrent runs may share a checkout, and
// a spec that rewrites tracked files on every `npx vitest run` is a corruption waiting for
// two overlapping runs. `vi.spyOn` is NOT an alternative and was measured on the sibling
// spec: vitest 4 refuses it with `Cannot spy on export "readFileSync". Module namespace is
// not configurable in ESM.`
//
// No `@vitest-environment` docblock. The project default is the node environment, and that
// is what lets this spec import a module which resolves its paths from `import.meta.url`.
// A jsdom spec touching disk would have to use `import.meta.dirname` instead, the trap
// documented three times at `render/assets/vertexBudget.test.ts:66-92`.

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ICNS_PATH,
  ICON_16_PATH,
  ICON_OUTPUTS,
  ICO_PATH,
  MASTER_PATH,
  RASTER_128_PATH,
  STENCIL_PATH,
  buildIcon16,
  buildIconArtifacts,
  buildIconCuts,
  buildIconMaster,
  buildIconStencil,
  emittedPathCount,
  refuseEmptyCuts,
  writeIcons,
} from '../../../scripts/build-icons.ts';
import { BRAND_DIR, BRAND_RULES, lintDir } from '../../../scripts/lint-svg.ts';
import { skinToCssVars } from '../../render/synth/chrome/skinToCssVars.ts';
import { LOCKED_SKIN } from '../../render/synth/skins/locked.ts';

/**
 * Every path `readFileSync` was called with since the last reset, in call order.
 *
 * `vi.hoisted` because `vi.mock`'s factory runs BEFORE this file's imports do, so an ordinary
 * `const` here would still be in its temporal dead zone when the factory closes over it.
 */
const FS_READS = vi.hoisted(() => [] as string[]);

/** Every path `writeFileSync` was called with since the last reset, in call order. */
const FS_WRITES = vi.hoisted(() => [] as string[]);

/**
 * The read recorder and the write interceptor. See the module header for both, and for why
 * `vi.spyOn` is not an alternative in vitest 4.
 *
 * `default` is rebuilt alongside the named exports because a module that does
 * `import fs from 'node:fs'` would otherwise get an unwrapped copy, which would be a hole in
 * the recorder rather than a convenience.
 */
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();

  type ReadFileSync = typeof actual.readFileSync;
  const recordedRead = ((...args: Parameters<ReadFileSync>): ReturnType<ReadFileSync> => {
    FS_READS.push(String(args[0]));
    return actual.readFileSync(...args);
  }) as ReadFileSync;

  type WriteFileSync = typeof actual.writeFileSync;
  const interceptedWrite = ((...args: Parameters<WriteFileSync>): void => {
    FS_WRITES.push(String(args[0]));
  }) as WriteFileSync;

  // `mkdirSync` is intercepted too (81-REVIEW.md IN-02). The mock used to spread `...actual`
  // and override only the two, so `writeIcons()`'s `mkdirSync(dirname(path), { recursive:
  // true })` ran FOR REAL inside a case. Harmless today because every output directory already
  // exists, but the header's claim that the case "puts no bytes on disk" was true only of
  // files: a wrong path constant would have created real directories on a checkout that
  // concurrent runs share.
  type MkdirSync = typeof actual.mkdirSync;
  const interceptedMkdir = ((): ReturnType<MkdirSync> => undefined) as MkdirSync;

  return {
    ...actual,
    default: {
      ...actual,
      readFileSync: recordedRead,
      writeFileSync: interceptedWrite,
      mkdirSync: interceptedMkdir,
    },
    readFileSync: recordedRead,
    writeFileSync: interceptedWrite,
    mkdirSync: interceptedMkdir,
  };
});

/**
 * The committed master's bytes, read ONCE at module load.
 *
 * Read at load rather than inside a case because a value read inside the case would be read
 * AFTER whatever the case did, which is the shape that cannot notice a mutation.
 */
const COMMITTED_AT_LOAD = readFileSync(MASTER_PATH, 'utf8');

/**
 * The token painted chrome square, as an independent path.
 *
 * NAMED HERE RATHER THAN IMPORTED FROM THE GENERATOR, on purpose: this spec asserts the
 * generator never reads it, and asking the generator for the path would be asking the subject
 * to define the property. Resolved from `import.meta.url`, the way every path in this tree is.
 */
const SHIPPED_SQUARE = fileURLToPath(new URL('../../chrome/assets/logomark.svg', import.meta.url));

/**
 * The generator's own source, as TEXT.
 *
 * Every other case in this file imports the module; this one reads it, because the property is
 * about what the file SAYS and not about what it returns. The generator's header claims "no hex
 * literal for any of the four appears anywhere in this file, comments included, and a spec greps
 * the comment stripped source to hold that" - and until 81-REVIEW.md WR-03 no such spec existed.
 * The grep lived only as a plan-time verify in 81-01-PLAN.md and never reached the tree, so the
 * shipped file asserted a guarantee this repository did not hold, which is its second recorded
 * defect class after the check that cannot fail.
 */
const GENERATOR_PATH = fileURLToPath(new URL('../../../scripts/build-icons.ts', import.meta.url));

/**
 * Prove the recorder would catch a read of exactly `path`, then hand back a clean recorder.
 *
 * This is the non-vacuity floor for both `does not read` cases, and it is a probe rather than
 * a count for the reason the module header gives: the builder legitimately reads nothing, so
 * "the recorder saw something during the build" is red on correct work.
 */
function probeRecorderOn(path: string): void {
  FS_READS.length = 0;
  readFileSync(path, 'utf8');
  expect(
    FS_READS,
    `a real read of ${path} did not reach the recorder, so the assertion below is vacuous`,
  ).toContain(path);
  FS_READS.length = 0;
}

/** Set equality, reported as sorted arrays so a failure names the difference. */
function sortedUnique(paths: readonly string[]): string[] {
  return [...new Set(paths)].sort();
}

describe('the icon master is generated, not drawn', () => {
  it('regenerates byte-identical to the committed file', () => {
    // What reddens this: move one coordinate, one attribute or one header line in
    // `build-icons.ts` and the two strings stop matching. Edit the committed SVG by hand and
    // the same thing happens. The comparison is byte for byte on the UTF-8 text, so
    // whitespace and element order are pinned along with the geometry.
    expect(buildIconMaster()).toBe(readFileSync(MASTER_PATH, 'utf8'));
  });

  it('writes exactly the paths ICON_OUTPUTS declares, in both directions', async () => {
    // T-81-02. A generator is a build-time script with a licence to write tracked files, so
    // WHICH files is a property worth pinning rather than trusting. `ICON_OUTPUTS` is the
    // generator's own declared allowlist; this case is the outside assertion that makes it a
    // contract instead of documentation.
    //
    // BOTH DIRECTIONS, and that is not belt and braces. A subset check ("everything declared
    // was written") passes a generator that also wrote a fourth file; the other subset check
    // ("everything written was declared") passes a generator that wrote nothing at all. Only
    // set equality refuses both.
    //
    // The write interceptor means this case puts no bytes on disk, which is why it can run on
    // a shared checkout at all.
    FS_WRITES.length = 0;
    await writeIcons();
    const wrote = sortedUnique(FS_WRITES);

    // NON-VACUITY. An empty declared set would make set equality against an empty write set
    // trivially true, and an empty write set would mean the generator wrote nothing.
    expect(
      ICON_OUTPUTS.length,
      'ICON_OUTPUTS is empty, so the comparison below is vacuous',
    ).toBeGreaterThan(0);
    expect(wrote, 'writeIcons() wrote nothing, so the comparison below is vacuous').not.toEqual([]);

    expect(wrote, 'writeIcons() wrote outside its declared output set').toEqual(
      sortedUnique(ICON_OUTPUTS),
    );

    // And the four paths are the ones this phase actually ships, named rather than counted.
    expect(ICON_OUTPUTS, 'the master is not in the declared write set').toContain(MASTER_PATH);
    expect(ICON_OUTPUTS, 'the 16 unit optical cut is not in the declared write set').toContain(
      ICON_16_PATH,
    );
    expect(ICON_OUTPUTS, 'the monochrome stencil is not in the declared write set').toContain(
      STENCIL_PATH,
    );
    expect(ICON_OUTPUTS, 'the 128px raster is not in the declared write set').toContain(
      RASTER_128_PATH,
    );
    expect(ICON_OUTPUTS, 'the Windows container is not in the declared write set').toContain(
      ICO_PATH,
    );
    expect(ICON_OUTPUTS, 'the macOS container is not in the declared write set').toContain(
      ICNS_PATH,
    );
  });

  it('transcribes no palette value, so the paint stays one declaration', () => {
    // WR-03. The four paints this generator uses are DERIVED from `skinToCssVars(LOCKED_SKIN)`,
    // and two of the four come through `bakeRamp` and are not readable off the skin file at all.
    // A transcribed constant is a second declaration of the palette that agrees with the first
    // one TODAY and drifts the moment a ramp step moves - and it drifts silently, because byte
    // identity stays green while the transcribed value still happens to equal the derived one.
    //
    // Measured before this case existed: replacing `const ink = paint('--fab-ink')` with
    // `const ink = '#b0bacb'` left `iconCuts`, `iconRaster`, `iconMasterParity` and `icon16Cut`
    // at 31 passed and `npm run lint:svg` at 0 violations.
    //
    // THE EXPECTED SET IS DERIVED FROM THE SKIN, NOT FROM THE GENERATOR. A list of hex literals
    // here would be the very transcription the case forbids, one file further out, and it would
    // stop following the palette the day a ramp step moved.
    const declared = [...skinToCssVars(LOCKED_SKIN).matchAll(/#[0-9a-f]{6}/gi)].map((m) =>
      m[0].toLowerCase(),
    );

    // NON-VACUITY, and it is the half that carries the case: an empty expected set would make
    // the loop below never run and this case would pass having compared nothing.
    expect(
      declared.length,
      'the locked skin emitted no hex at all, so this case is vacuous',
    ).toBeGreaterThan(0);

    // Comments included, because the header's claim is "comments included" - but comment lines
    // are stripped for the OPPOSITE reason to `installScript.test.ts`: a comment naming a value
    // is still a second declaration a reader can copy, so the strip here removes only the
    // leading markers and keeps the text, and the search runs over the whole file.
    const source = readFileSync(GENERATOR_PATH, 'utf8').toLowerCase();
    expect(source, 'the generator source read empty').not.toBe('');

    for (const hex of new Set(declared)) {
      expect(
        source,
        `${hex} is transcribed into build-icons.ts instead of derived from skinToCssVars(LOCKED_SKIN)`,
      ).not.toContain(hex);
    }
  });

  it('THE GATE CAN FAIL: a transcribed palette value is rejected by name', () => {
    // The mutation, on an in-memory copy of the generator text. It never writes to the tree:
    // concurrent runs may share a checkout.
    const declared = [...skinToCssVars(LOCKED_SKIN).matchAll(/#[0-9a-f]{6}/gi)].map((m) =>
      m[0].toLowerCase(),
    );
    const transcribed = declared[0];
    expect(transcribed, 'the locked skin emitted no hex, so this mutation is vacuous').toMatch(
      /^#[0-9a-f]{6}$/,
    );

    const mutant = readFileSync(GENERATOR_PATH, 'utf8')
      .replace("const ink = paint('--fab-ink');", `const ink = '${transcribed}';`)
      .toLowerCase();
    expect(mutant, 'the transcription mutation matched nothing').toContain(transcribed);

    const complaints = [...new Set(declared)].filter((hex) => mutant.includes(hex));
    expect(complaints, 'the search cannot see a transcribed palette value').toContain(transcribed);

    // And the committed generator is untouched by this case.
    expect(readFileSync(GENERATOR_PATH, 'utf8'), 'this spec modified the generator').not.toContain(
      transcribed,
    );
  });

  it('refuses an empty cut BEFORE it writes anything, not after', () => {
    // WR-07. The entry point used to run `writeIcons()` and only then loop the cuts checking
    // `emittedPathCount(cut.svg) === 0`, so a cut with an empty body was written to
    // `docs/brand/` first and reported second. Plan 81-02's transcript records it: the build
    // printed `fabrico-icon-stencil.svg  0 paths, 2369 bytes` as a WRITE line and the tracked
    // file had to be restored with `git checkout --`.
    //
    // BOTH DIRECTIONS. A refusal that fired on everything would be as useless as one that never
    // fired, and this is the shape that would make the assertion below vacuous.
    expect(
      () => { refuseEmptyCuts(buildIconCuts()); },
      'the real cuts are being refused, so this refusal fires on correct work',
    ).not.toThrow();

    expect(() => {
      refuseEmptyCuts([{ path: '/tmp/fabrico-icon-emitted-nothing.svg', svg: '<svg/>', paths: 0 }]);
    }).toThrowError(/refusing to write fabrico-icon-emitted-nothing\.svg/);

    // And it names EVERY empty cut, not just the first, because a generator that broke would
    // usually break more than one.
    expect(() => {
      refuseEmptyCuts([
        { path: '/tmp/one.svg', svg: '<svg/>', paths: 0 },
        { path: '/tmp/two.svg', svg: '<svg/>', paths: 0 },
      ]);
    }).toThrowError(/one\.svg, two\.svg/);
  });

  it('writes through node:fs only, which is the module the write-set recorder covers', () => {
    // WR-09. The write-set gate records `writeFileSync` through a `vi.mock('node:fs')`
    // interceptor and asserts set equality in both directions, which is the right shape - but
    // the recorder only covers `node:fs`. This file's own header says plainly that
    // `node:fs/promises` is a DIFFERENT specifier and therefore unmocked, and the mutation case
    // below relies on that fact to write its scratch file. So a generator that wrote through
    // `writeFile` from `node:fs/promises`, or through `createWriteStream`, would put real bytes
    // on the tree and be invisible to the allowlist assertion - and that case would still pass,
    // because the recorded set would be a subset it happened to match.
    //
    // CLOSED WITH A SOURCE ASSERTION RATHER THAN A SECOND MOCK, deliberately: mocking
    // `node:fs/promises` too would take away the scratch-write escape hatch the `no-paths`
    // mutation case needs, and this property is about which module the generator IMPORTS, which
    // is a fact about its text.
    const source = readFileSync(GENERATOR_PATH, 'utf8');

    const specifiers = [...source.matchAll(/from\s+'(node:[^']*)'/g)].map((m) => m[1]);
    // NON-VACUITY: a generator importing no node builtin at all would satisfy an `every` check
    // for free, and it would also mean this whole file is measuring the wrong module.
    expect(specifiers, 'the generator imports no node builtin at all, so this case is vacuous')
      .not.toEqual([]);
    expect(
      specifiers.filter((specifier) => specifier.startsWith('node:fs')),
      'the generator writes through an fs module the write-set recorder does not intercept',
    ).toEqual(['node:fs']);

    // And the two escapes that need no import at all.
    expect(source, 'the generator streams a write past the recorder').not.toContain(
      'createWriteStream',
    );
    expect(source, 'the generator reaches fs through a dynamic import the recorder cannot see')
      .not.toMatch(/import\(\s*['"]node:fs/);
  });

  it('THE GATE CAN FAIL: a node:fs/promises import in the generator is rejected', () => {
    // The mutation, on an in-memory copy of the generator text. It never writes to the tree.
    const mutant = readFileSync(GENERATOR_PATH, 'utf8').replace(
      "import { mkdirSync, writeFileSync } from 'node:fs';",
      "import { mkdirSync, writeFileSync } from 'node:fs';\nimport { writeFile } from 'node:fs/promises';",
    );
    expect(mutant, 'the import splice matched nothing, so this case is vacuous').not.toBe(
      readFileSync(GENERATOR_PATH, 'utf8'),
    );

    const specifiers = [...mutant.matchAll(/from\s+'(node:[^']*)'/g)]
      .map((m) => m[1])
      .filter((specifier) => specifier.startsWith('node:fs'));
    expect(specifiers, 'the reader cannot see a second fs specifier').toContain(
      'node:fs/promises',
    );
    expect(() => {
      expect(
        specifiers,
        'the generator writes through an fs module the write-set recorder does not intercept',
      ).toEqual(['node:fs']);
    }).toThrowError(/the write-set recorder does not intercept/);
  });

  it('every declared output regenerates byte-identical to the committed file at that path', () => {
    // THE WHOLE SET, not only the three SVG cuts. ICON-03's claim is that the icon set is a
    // property of this repository rather than of whoever last ran a command, and that claim is
    // only worth as much as the artefacts it covers: the ladder, the ICO and the ICNS are
    // exactly the files a bare `tauri icon` call would flatten, so they are the ones that have
    // to be pinned.
    //
    // Buffers are compared as buffers and text as text. `toEqual` on two Buffers compares their
    // contents, and the length is asserted first so a failure reports two numbers rather than a
    // wall of bytes.
    //
    // This case puts nothing on disk: `buildIconArtifacts()` reads nothing and writes nothing,
    // which is why it exists separately from `writeIcons()` at all.
    const artifacts = buildIconArtifacts();

    // NON-VACUITY, both directions, before a single comparison is made. An empty artefact list
    // would make the loop below trivially true, and an artefact set that had drifted from the
    // declared write set would leave a committed file unchecked by this case while still
    // passing it.
    expect(artifacts.length, 'the generator produced no artefacts at all').toBeGreaterThan(0);
    expect(
      sortedUnique(artifacts.map((artifact) => artifact.path)),
      'the rebuilt artefact set is not the declared write set',
    ).toEqual(sortedUnique(ICON_OUTPUTS));

    for (const artifact of artifacts) {
      const name = basename(artifact.path);
      expect(existsSync(artifact.path), `${name} is declared but missing from disk`).toBe(true);

      if (typeof artifact.bytes === 'string') {
        expect(readFileSync(artifact.path, 'utf8'), `${name} differs from the generator`).toBe(
          artifact.bytes,
        );
        continue;
      }

      const committed = readFileSync(artifact.path);
      expect(committed.length, `${name} differs from the generator in length`).toBe(
        artifact.bytes.length,
      );
      expect(
        committed.equals(artifact.bytes),
        `${name} regenerates to different bytes than the committed file`,
      ).toBe(true);
    }
  });

  it('never reads its own committed output', () => {
    // A builder that read its committed output back and returned it would satisfy the
    // byte-identity case above against ANY file at all. This is the case that stops it.
    //
    // It instruments the READ rather than mutating the artefact. `buildIconMaster()` does not
    // reference `MASTER_PATH`, so recording every path that goes through `readFileSync`
    // records every file the builder can possibly read. That is strictly stronger than a
    // decoy: a decoy only catches a builder that returns its output WHOLE, and this catches
    // one that reads it at all, including one that read a single attribute out of it.
    probeRecorderOn(MASTER_PATH);

    const built = buildIconMaster();
    const seen = [...FS_READS];

    // THE LOAD-BEARING LINE.
    expect(seen, 'the builder read its own committed output').not.toContain(MASTER_PATH);

    // And the committed artefact is untouched.
    expect(existsSync(MASTER_PATH), 'the committed master is missing').toBe(true);
    expect(readFileSync(MASTER_PATH, 'utf8'), 'the committed master was modified by this spec').toBe(
      COMMITTED_AT_LOAD,
    );
    expect(built.length).toBeGreaterThan(0);
  });

  it('never reads the shipped chrome square, which is what makes the parity gate independent', () => {
    // THE CASE `iconMasterParity.test.ts` RESTS ON. A builder that read the chrome square for
    // its three `d` strings would make that spec compare a file with its own source: every
    // coordinate would agree by construction and no moved coordinate could ever be caught.
    // The generator declares those three strings as its OWN literals precisely so an
    // independent assertion has something to disagree with.
    probeRecorderOn(SHIPPED_SQUARE);

    const built = buildIconMaster();
    const seen = [...FS_READS];

    // THE LOAD-BEARING LINE.
    expect(
      seen,
      'the builder read the shipped chrome square, which makes the parity gate circular',
    ).not.toContain(SHIPPED_SQUARE);

    expect(existsSync(SHIPPED_SQUARE), 'the shipped chrome square is missing').toBe(true);
    expect(built.length).toBeGreaterThan(0);
  });

  it('THE FLOOR: the recorder catches a real read of both subjects', () => {
    // Asserted as a case in its own right, not only inline, so a recorder that silently
    // stopped working reddens BY NAME here rather than being diagnosed from two unrelated
    // `not.toContain` lines that went green for free.
    FS_READS.length = 0;
    const master = readFileSync(MASTER_PATH, 'utf8');
    const square = readFileSync(SHIPPED_SQUARE, 'utf8');

    expect(master.length, 'the committed master is empty').toBeGreaterThan(0);
    expect(square.length, 'the shipped chrome square is empty').toBeGreaterThan(0);
    expect(FS_READS, 'the recorder missed a real read of the master').toContain(MASTER_PATH);
    expect(FS_READS, 'the recorder missed a real read of the chrome square').toContain(
      SHIPPED_SQUARE,
    );
  });
});

/* ------------------------------------------------------------------ *
 * The other two cuts (plan 81-02, MARK-05 and MARK-07)
 * ------------------------------------------------------------------ */

/** The committed optical cut and stencil, read ONCE at module load, for the same reason. */
const COMMITTED_16_AT_LOAD = readFileSync(ICON_16_PATH, 'utf8');
const COMMITTED_STENCIL_AT_LOAD = readFileSync(STENCIL_PATH, 'utf8');

/**
 * The three cut names, as the walker renders them.
 *
 * `fabrico-icon-master.svg` and NOT `brand/fabrico-icon-master.svg`: `displayPath` renders a
 * path outside `frontend/src/` as its bare filename, which is exactly the form this walk
 * produces and the form the CLI prints.
 *
 * DECLARED HERE AS LITERALS RATHER THAN DERIVED FROM THE GENERATOR'S PATH CONSTANTS, for the
 * same reason `SHIPPED_SQUARE` above is: `[MASTER_PATH, ICON_16_PATH, STENCIL_PATH].map(basename)`
 * would ask the subject to define the property, and a generator that renamed an output would
 * silently rename the expectation with it. Two independent declarations that can be found in
 * DISAGREEMENT is the only shape that proves anything, so the case below also asserts these
 * names ARE the basenames of the generator's declared SVG outputs: a rename now has to happen
 * in both places or it reddens.
 */
const CUT_NAMES = [
  'fabrico-icon-master.svg',
  'fabrico-icon-16.svg',
  'fabrico-icon-stencil.svg',
] as const;

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'fabrico-icon-cuts-'));
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('the 16 unit cut and the stencil are generated too', () => {
  it('the 16 unit optical cut regenerates byte-identical to the committed file', () => {
    // Same property as the master's, and it carries more here: this cut is AUTHORED on a
    // 16 unit grid (D-04), so the only thing standing between it and a silent resample is
    // that the committed bytes are the generator's bytes. `icon16Cut.test.ts` asserts the
    // geometry; this asserts nobody edited the artefact behind the generator's back.
    expect(buildIcon16()).toBe(readFileSync(ICON_16_PATH, 'utf8'));
  });

  it('the monochrome stencil regenerates byte-identical to the committed file', () => {
    expect(buildIconStencil()).toBe(readFileSync(STENCIL_PATH, 'utf8'));
  });

  it('the brand walk is clean and its asset list NAMES all three cuts', () => {
    // THE FLOOR FOR THIS PHASE, AS NAMED FILES rather than an asset count. See the module
    // header: a count would have to be hand-edited the moment a later cut lands, and it
    // would tempt an executor toward `lintSvg.test.ts`'s `EXPECTED_CHROME_ASSET_COUNT`, which
    // D-01 forbids this phase from moving. Three names cannot be satisfied by a walk over
    // nothing and are undisturbed by a directory that grows.
    const result = lintDir(BRAND_DIR, { only: BRAND_RULES });

    expect(result.dir).toBe('brand/');

    // The two declarations, held in agreement. These names are typed out above; the paths come
    // from the generator. If either side renames a cut alone, this reddens by name.
    expect([...CUT_NAMES].sort(), 'the spec and the generator disagree about the cut names').toEqual(
      [MASTER_PATH, ICON_16_PATH, STENCIL_PATH].map((p) => basename(p)).sort(),
    );

    for (const name of CUT_NAMES) {
      expect(result.assets, `the brand walk did not find ${name}`).toContain(name);
    }
    expect(result.violations, 'a committed cut is dirty under BRAND_RULES').toEqual([]);
  });

  it('every committed cut carries at least one path', () => {
    // D-02's observable, measured on the COMMITTED artefacts rather than on the builders, so
    // a generator that emitted a body and a write step that dropped it are both caught.
    for (const path of [MASTER_PATH, ICON_16_PATH, STENCIL_PATH]) {
      const text = readFileSync(path, 'utf8');
      expect(text.length, `${basename(path)} is empty on disk`).toBeGreaterThan(0);
      expect(
        emittedPathCount(text),
        `${basename(path)} draws nothing, which is the failure no-paths exists for`,
      ).toBeGreaterThan(0);
    }
  });

  it('THE GATE CAN FAIL: a cut that emitted nothing is caught by BOTH guards', async () => {
    // D-02 IN FULL, and it is the case this phase was named in. `no-paths` was added to
    // `BRAND_RULES` in review WR-04 because the directory grows, so the first added file that
    // failed to generate would have landed green.
    // That the RULE bites was proven in 81-RESEARCH.md section S2, in an isolated worktree.
    // This case proves THIS GENERATOR'S artefact shape is covered by it, which is a different
    // claim and the one that matters.
    //
    // TWO GUARDS, ASSERTED SEPARATELY. `emittedPathCount()` is the predicate the entry point
    // in `build-icons.ts` uses to set a non zero exit code, and `no-paths` is what reddens
    // `npm run lint:svg`. Either alone would leave a hole: a generator run outside the lint
    // and a hand-emptied file committed without a regeneration.
    const emptyCut = '<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">\n</svg>\n';

    // NON-VACUITY, first: the predicate must return a POSITIVE number for a real cut, or
    // "returns 0 for the empty one" would be true of a function that always returns 0.
    expect(
      emittedPathCount(COMMITTED_16_AT_LOAD),
      'emittedPathCount reports zero for a real cut, so the assertion below proves nothing',
    ).toBeGreaterThan(0);
    expect(emittedPathCount(emptyCut), 'a root-only document reported a path').toBe(0);

    // IN-03. And a document whose HEADER names the element while its body is empty still
    // reports zero: the count is of what was drawn, not of what was described.
    const emptyCutWithChattyHeader =
      '<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">\n' +
      '  <!-- this cut emits one <path> per layer, or it did until it emitted none -->\n' +
      '</svg>\n';
    expect(
      emittedPathCount(emptyCutWithChattyHeader),
      'a document whose comment mentions <path> reported a path it never drew',
    ).toBe(0);

    // Written through `node:fs/promises` because the `node:fs` mock swallows `writeFileSync`
    // (module header), and into a scratch directory because concurrent runs may share a
    // checkout. NEVER into `docs/brand/`.
    const name = 'fabrico-icon-emitted-nothing.svg';
    const scratch = join(tmpRoot, name);
    await writeFile(scratch, emptyCut, 'utf8');
    expect(readFileSync(scratch, 'utf8'), 'the mutation did not reach disk').toBe(emptyCut);

    const violations = lintDir(tmpRoot, { only: BRAND_RULES }).violations;
    expect(violations, 'the empty cut linted clean under BRAND_RULES').not.toEqual([]);
    expect(
      violations.map((v) => `${v.path}:${v.rule}`),
      'no no-paths violation names the empty cut',
    ).toContain(`${name}:no-paths`);

    // And the committed cuts are untouched by this case.
    expect(readFileSync(ICON_16_PATH, 'utf8'), 'this spec modified the committed cut').toBe(
      COMMITTED_16_AT_LOAD,
    );
    expect(readFileSync(STENCIL_PATH, 'utf8'), 'this spec modified the committed stencil').toBe(
      COMMITTED_STENCIL_AT_LOAD,
    );
  });
});
