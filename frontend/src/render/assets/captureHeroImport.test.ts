// captureHeroImport.test.ts - importing a CLI script must not run the CLI (WR-05, plan 80-07).
//
// WHAT THIS GUARDS. `scripts/capture-lockup-hero.ts` exports thirteen names - `buildHeroHtml`,
// `identifyPng`, `captureHero`, `HERO_WIDTH`, `PLATE` and the rest - so it is written to be
// imported, and `identifyPng` is a genuinely reusable helper a future spec will want. Until
// this plan its whole pipeline ran at TOP LEVEL and unconditionally: importing it launched
// Chromium, rewrote `80-lockup-hero.html` and `80-a-lockup-hero.png` under its evidence
// directory (now the ignored `frontend/evidence/80/`), shelled out to `magick`, and on any
// failure called `process.exit(1)`, which tears down the importing test runner mid-suite.
//
// The fix is the `import.meta.main` guard the four sibling scripts already carry. This spec is
// what stops the guard being deleted again, and it asserts BEHAVIOUR rather than the presence
// of a line of source: a grep for `import.meta.main` would pass on a file that had the guard
// and also had a stray top-level `await main()` beneath it.
//
// THE OBSERVABLE IS MTIME, AND THE FIRST DRAFT OF THIS SPEC WAS A CHECK THAT COULD NOT FAIL.
// It compared sha256 digests of the two evidence files across the import. Measured with the
// guard stripped: vitest DOES evaluate the module's top level, the pipeline DOES run, and both
// files ARE rewritten - and the case still passed, because `capture-lockup-hero.ts` is
// deterministic and rewrote byte-identical output. A digest cannot distinguish "was not
// written" from "was written with the same bytes", which is exactly the distinction this case
// exists to make. `mtimeNs` moves on any write whatever its content.
//
// No `@vitest-environment` docblock: the project default is node, which is what lets this
// spec touch disk and import a module resolving its paths from `import.meta.url`.

import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Mirrors `EVIDENCE_DIR` in `scripts/capture-lockup-hero.ts` as a literal, because importing
// that module is the subject of the case and must not happen before the first measurement.
const EVIDENCE_DIR = new URL('../../../evidence/80/', import.meta.url);

/** The two files `captureHero()` writes, into an ignored output directory. */
const OUTPUTS = [
  new URL('80-lockup-hero.html', EVIDENCE_DIR),
  new URL('80-a-lockup-hero.png', EVIDENCE_DIR),
];

function writeTimes(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const url of OUTPUTS) {
    const name = url.pathname.slice(url.pathname.lastIndexOf('/') + 1);
    out[name] = existsSync(url) ? String(statSync(url, { bigint: true }).mtimeNs) : 'ABSENT';
  }
  return out;
}

describe('capture-lockup-hero is safe to import', () => {
  it('writes no evidence and launches no browser when it is imported rather than run', async () => {
    // NON-VACUITY FIRST, AND IT IS NOT A FORMALITY HERE. `writeTimes` returns the sentinel
    // `ABSENT` for a missing file, and two `ABSENT`s compare equal, so a case that only
    // compared before against after would pass on a tree where the evidence had been deleted.
    // The output directory is ignored and absent on a fresh checkout, so the case seeds any
    // missing file with a placeholder first; both must be present for the comparison below
    // to be a measurement.
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    for (const url of OUTPUTS) {
      if (!existsSync(url)) writeFileSync(url, 'placeholder seeded by captureHeroImport.test.ts\n');
    }
    for (const url of OUTPUTS) {
      expect(existsSync(url), `${url.pathname} is missing, so this case is vacuous`).toBe(true);
    }

    const before = writeTimes();
    expect(Object.values(before)).not.toContain('ABSENT');

    // The import itself is the subject. Under an unguarded module this call runs the whole
    // pipeline, rewrites both files, and can kill this worker outright.
    const mod = await import('../../../scripts/capture-lockup-hero.ts');

    // The module DID load and DID evaluate its top level: without this the assertion below
    // would be satisfied by an import that resolved to nothing.
    expect(typeof mod.identifyPng, 'the module did not evaluate its exports').toBe('function');
    expect(typeof mod.buildHeroHtml).toBe('function');
    expect(typeof mod.captureHero).toBe('function');

    expect(
      writeTimes(),
      'importing capture-lockup-hero.ts rewrote its evidence output, so it ran its CLI',
    ).toEqual(before);
  });
});
