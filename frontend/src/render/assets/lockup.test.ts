// lockup.test.ts - the regenerate-and-compare gate for the brand lockup (MARK-08, MARK-16,
// plan 80-02).
//
// WHAT THIS SPEC IS ACTUALLY FOR. `docs/brand/fabrico-lockup.svg` is a generated file, and a
// generated file that nothing regenerates is just a drawing with a comment claiming otherwise.
// This spec rebuilds the lockup in memory from the committed font binary and compares it byte
// for byte against what is on disk, so a hand edit to the artefact and a drift in the
// generator both redden here rather than surviving to a release.
//
// THE LAST CASE IS THE ONE THAT MATTERS. A builder that read its own committed output back
// and returned it would satisfy the first case against ANY file at all, which is this
// repository's signature defect class rather than a hypothetical: a check that cannot fail.
// `does not read its own output` RECORDS every path the builder reads and asserts the set is
// the builder's two declared inputs and nothing else.
//
// THIS SPEC WRITES NOTHING TO THE TREE, and that is the third mechanism for the same claim.
// It first took the committed artefact AWAY for the duration of a font parse (which left
// `docs/brand/` momentarily empty, and `lint:svg` refuses an empty directory), then wrote a
// DECOY over it (which left the primary brand artefact mutated on every `npx vitest run`, and
// two overlapping runs in this shared checkout corrupt it permanently). Neither was ever
// necessary: the claim is about what the builder READS. See the case body for the full
// account of both retirements.
//
// HOW THE RECORDER IS INSTALLED. `vi.mock('node:fs')` below wraps `readFileSync` in a
// pass-through that appends the path to `FS_READS` and then calls the real function. It is a
// recorder, not a stub: nothing about behaviour changes, and every other case in this file
// reads and hashes real bytes exactly as before. `readFileSync` is the ONLY read primitive
// `build-lockup.ts` imports (`scripts/build-lockup.ts:60`), so recording it records every
// file the builder can read. `vi.spyOn(fs, 'readFileSync')` is NOT an alternative here and
// was measured: vitest 4 refuses it with `Cannot spy on export "readFileSync". Module
// namespace is not configurable in ESM.`
//
// No `@vitest-environment` docblock. The project default is the node environment, and that
// is what lets this spec import a module which resolves its paths from `import.meta.url`.
// A jsdom spec touching disk would have to use `import.meta.dirname` instead, the trap
// documented three times at `render/assets/vertexBudget.test.ts:66-92`.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FONT_PATH, LOCKUP_PATH, NOTICE_PATH, buildLockup } from '../../../scripts/build-lockup.ts';

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
 * The two NAMED parts that are this file's anti-vacuity floor.
 *
 * Deliberately named parts rather than a path count. A count would have to be hand-edited the
 * moment Phase 81 or 83 adds a cut to the drawing, and a literal that reddens on correct work
 * teaches an executor to edit the assertion instead of the code. These two names are the
 * property actually worth holding: they are the type, which is the whole reason the lockup is
 * generated rather than drawn, and an empty or truncated file cannot satisfy either.
 */
const FLOOR_PARTS = ['wordmark', 'tagline'];

/**
 * The committed artefact's bytes, read ONCE at module load.
 *
 * This spec asserts against it at the end of the read-recorder case, so a future edit that
 * reintroduces a write to `LOCKUP_PATH` reddens rather than passing quietly. Read at load
 * rather than inside the case because a value read inside the case would be read AFTER
 * whatever the case did, which is the shape that cannot notice a mutation.
 */
const COMMITTED_AT_LOAD = readFileSync(LOCKUP_PATH, 'utf8');

/**
 * The OFL text, located BESIDE the binary it covers rather than by a second hard-coded
 * path. `FONT_PATH` is the file whose glyph outlines this artefact is made of, and the
 * licence obligation attaches to exactly that file, so deriving the licence path from it
 * is the relationship LIC-06 is actually about.
 */
const LICENCE_PATH = join(dirname(FONT_PATH), 'OFL-1.1-MartianMono.txt');

describe('the lockup is generated, not drawn', () => {
  it('regenerates byte-identical to the committed file', async () => {
    // What reddens this: change one glyph advance, one tracking value or one coordinate
    // rounding in `build-lockup.ts` and the two strings stop matching. Edit the committed
    // SVG by hand and the same thing happens. The comparison is byte for byte on the UTF-8
    // text, so whitespace and element order are pinned along with the geometry.
    expect(await buildLockup()).toBe(readFileSync(LOCKUP_PATH, 'utf8'));
  });

  it('reads the font pins out of NOTICE.md by name, and the binary matches them', () => {
    // The sha256 and the byte size are parsed from the `## MartianMono.woff2` section rather
    // than repeated here as literals: a literal would only make this spec agree with itself,
    // where the property worth holding is that the notice and the binary agree. Mutation:
    // swap the font binary and this fails naming the file. Reflow the notice and the regex
    // fails to match, which throws here rather than passing on `undefined`.
    const notice = readFileSync(NOTICE_PATH, 'utf8');
    const row =
      /## MartianMono\.woff2[\s\S]*?- \*\*SHA-256:\*\* ([0-9a-f]{64})[\s\S]*?- \*\*Size:\*\* ([\d,]+) bytes\./.exec(
        notice,
      );
    expect(row, 'NOTICE.md has no MartianMono.woff2 section carrying both pins').not.toBeNull();
    const bytes = readFileSync(FONT_PATH);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(row![1]);
    expect(bytes.length).toBe(Number(row![2]!.replace(/,/g, '')));
  });

  it('ships the OFL-1.1 text beside the binary its outlines came from (LIC-06)', () => {
    // An outlined wordmark IS glyph geometry taken from an OFL-1.1 face, so the licence is
    // due the day the artefact lands rather than at release. Two properties, and neither is
    // satisfiable by a placeholder: the OFL 1.1 body is a shade over 4,300 bytes, so a
    // truncated or stubbed file reddens on the length; and the opening line of the licence
    // is its COPYRIGHT LINE, which names the holder. Pasting some other project's OFL - the
    // easy mistake, since every OFL body below the copyright line is identical - reddens on
    // the name. Mutation: truncate the file, or replace the first line with another
    // foundry's, and exactly one of these two assertions fires.
    const licence = readFileSync(LICENCE_PATH, 'utf8');
    expect(licence.length).toBeGreaterThan(4000);
    const firstNonEmpty = licence.split('\n').find((line) => line.trim().length > 0) ?? '';
    expect(firstNonEmpty).toContain('The Martian Mono Project Authors');
  });

  it('carries no live text, no banned element, and both named floor parts', () => {
    // The whole point of outlining: with the font hidden from fontconfig the judged drawing
    // moved 6,996 of its 228,800 pixels and this file moves none. A surviving `<text>` would
    // put that dependency straight back, and no pixel comparison in CI would notice.
    const svg = readFileSync(LOCKUP_PATH, 'utf8');
    expect(svg).not.toMatch(/<text\b/);
    for (const banned of ['<title', '<g ', '<rect', '<circle', '<defs', '<pattern', '<use', '<style']) {
      expect(svg, `banned element ${banned} survived`).not.toContain(banned);
    }
    for (const part of FLOOR_PARTS) {
      expect(svg, `the named floor part ${part} is missing`).toContain(`data-part="${part}"`);
    }
  });

  it('does not read its own output: every path the builder reads is one of its two inputs', async () => {
    // THE CASE THAT STOPS THE GATE PASSING ON ANYTHING. A builder that read its committed
    // output back and returned it would satisfy the byte-identity case above against ANY
    // file at all.
    //
    // IT INSTRUMENTS THE READ RATHER THAN MUTATING THE ARTEFACT, and that is a repair rather
    // than a preference (WR-04 in `80-REVIEW.md`; the paragraphs below are the two mechanisms
    // this replaces, kept because each was retired for a measured reason).
    //
    //   1. It used to `renameSync` the committed lockup to
    //      `fabrico-lockup.svg.parked-by-lockup-test` for the duration of a font parse. The
    //      parked name does not end in `.svg`, and `docs/brand/` holds exactly ONE `.svg`, so
    //      for the 5-13ms of that parse the brand directory contained zero assets - and
    //      `lint-svg.ts`'s `report()` refuses a directory it finds nothing in. Reproduced on
    //      a shared working tree: with this spec looping, `npm run lint:svg` hit that vacuity
    //      refusal and exited 1 on 1 run in 175.
    //   2. Plan 80-05 replaced the rename with a DECOY written over the committed path and
    //      restored in a `finally`. That closed the empty-directory window and left a
    //      modified tracked file rather than a deleted one, but it still mutated the primary
    //      brand artefact on every `npx vitest run`. Two agent sessions share this checkout,
    //      and two overlapping runs corrupt it permanently: A reads `committed` (good) and
    //      writes the decoy; B reads `committed` and gets THE DECOY; A restores the good
    //      bytes; B restores its own, which is the decoy. The tree is left carrying
    //      `data-part="wordmark-decoy"` and `lint:svg` reports it clean, because `data-part`
    //      is not in `BRAND_RULES`. A `finally` also does not survive a SIGKILL to the worker
    //      during the WOFF2 decompress.
    //
    // THE CLAIM NEVER REQUIRED TOUCHING THE DISK. `buildLockup()` does not reference
    // `LOCKUP_PATH`, and `readFileSync` is the ONLY read primitive `build-lockup.ts` imports
    // from `node:fs` (`:60`), so recording every path that goes through it records every file
    // the builder can possibly read. This is strictly stronger than the decoy was: the decoy
    // only caught a builder that returned its output WHOLE, and this catches one that reads
    // its output at all, including one that read a single attribute out of it.
    //
    // The recorder is a transparent pass-through installed by the `vi.mock` at the head of
    // this file. It writes nothing, takes no lock, and an interrupted run leaves the tree
    // exactly as it found it.
    FS_READS.length = 0;
    const built = await buildLockup();
    const seen = [...FS_READS];

    // NON-VACUITY, and it is the half that carries the case. `not.toContain` over an EMPTY
    // array passes, so a mock that silently stopped recording - or a builder that failed
    // before reading anything - would satisfy the load-bearing line below while proving
    // nothing whatever. These two names are the builder's entire legitimate input set.
    expect(seen, 'the read recorder saw nothing, so the assertion below is vacuous').not.toEqual([]);
    expect(seen, 'the builder did not read the committed font binary').toContain(FONT_PATH);
    expect(seen, 'the builder did not read NOTICE.md for its font pins').toContain(NOTICE_PATH);

    // THE LOAD-BEARING LINE.
    expect(seen, 'the builder read its own committed output').not.toContain(LOCKUP_PATH);

    // And the committed artefact is untouched, which is the property the two retired
    // mechanisms could not offer at all.
    expect(existsSync(LOCKUP_PATH), 'the committed lockup is missing').toBe(true);
    expect(readFileSync(LOCKUP_PATH, 'utf8'), 'the committed lockup was modified by this spec').toBe(
      COMMITTED_AT_LOAD,
    );
    expect(built.length).toBeGreaterThan(0);
  });
});
