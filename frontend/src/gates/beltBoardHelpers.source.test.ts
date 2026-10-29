// THE GUARD OVER THE PHASE 89 LIVE SPECS' SHARED BOARD HELPERS (review fix WR-C-08).
//
// Until the review every `e2e-live/89-*.live.spec.ts` carried its own copy of about a dozen board
// helpers, and the copies had drifted: three `deselectOnFloor` copies waited for the machine panel
// only, two `rowCells` copies walked one way only, and `cardinalOfRotation`, the mapping every
// tread grade reads, was defined three times. They live once now, in `e2e-live/support/beltBoard.ts`.
// This gate keeps it that way: no 89 spec may define one of those names at its top level again, and
// every 89 spec that calls one imports it from the shared module.
//
// Read as source, comments and strings included, never imported: the specs are Playwright files.
// Seen red before the fix: run against the specs at a pre-release revision (the pass's start) it names 83
// local copies across the ten files (`89-REVIEW-DISPOSITION.md`, WR-C-08).

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const LIVE = join(__dirname, '..', '..', 'e2e-live');

/** The helpers that live in `support/beltBoard.ts` and nowhere else among the 89 specs. */
const SHARED = [
  'cardinalOfRotation',
  'doorstep',
  'portOf',
  'sideOf',
  'beltOn',
  'rowCells',
  'cellPoint',
  'expectOnCanvas',
  'transport',
  'resumeIfPaused',
  'pauseAndSettle',
  'emptyBoardAtScaleOne',
  'place',
  'turnUntilFacing',
  'deselectOnFloor',
  'zoomBelowOne',
  'zoomTo',
  'treadRotationAt',
  'previewKindAt',
  'installFrameSniffer',
  'sentCount',
] as const;

const specs = readdirSync(LIVE)
  .filter((f) => /^89-.*\.live\.spec\.ts$/.test(f))
  .sort();

/** Every top-level `function NAME` or `const NAME =` a spec defines, for a shared name. */
function localCopies(src: string): string[] {
  const out: string[] = [];
  for (const name of SHARED) {
    const fn = new RegExp(`^(export )?(async )?function ${name}\\b`, 'm');
    const arrow = new RegExp(`^(export )?const ${name}\\s*=`, 'm');
    if (fn.test(src) || arrow.test(src)) out.push(name);
  }
  return out;
}

describe('phase 89 live specs share one copy of the board helpers (WR-C-08)', () => {
  it('finds the ten phase 89 live specs (NON-VACUITY)', () => {
    expect(specs.length).toBeGreaterThanOrEqual(10);
  });

  it('no phase 89 spec defines a shared helper at its top level', () => {
    const found = specs.flatMap((f) => localCopies(readFileSync(join(LIVE, f), 'utf8')).map((n) => `${f}: ${n}`));
    expect(found).toEqual([]);
  });

  it('a spec that calls a shared helper imports it from support/beltBoard', () => {
    const missing: string[] = [];
    for (const f of specs) {
      const src = readFileSync(join(LIVE, f), 'utf8');
      const imp = /import \{([^}]*)\} from '\.\/support\/beltBoard';/.exec(src);
      const imported = new Set((imp?.[1] ?? '').split(',').map((s) => s.trim()).filter(Boolean));
      for (const name of SHARED) {
        if (new RegExp(`(?<![\\w.])${name}\\(`).test(src) && !imported.has(name)) {
          // A call with no import is either a local copy (caught above) or a nested helper of the
          // same name; either way it is not the shared one.
          missing.push(`${f}: ${name}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('the shared deselect waits for both panels, and rowCells walks both ways (the stricter copies)', () => {
    const src = readFileSync(join(LIVE, 'support', 'beltBoard.ts'), 'utf8');
    const deselect = /export async function deselectOnFloor[\s\S]*?\n\}/.exec(src)?.[0] ?? '';
    expect(deselect).toContain("'#fab-config-heading'");
    expect(deselect).toContain("'#fab-belt-config'");
    const row = /export function rowCells[\s\S]*?\n\}/.exec(src)?.[0] ?? '';
    expect(row).toContain('Math.sign(x1 - x0)');
  });
});
