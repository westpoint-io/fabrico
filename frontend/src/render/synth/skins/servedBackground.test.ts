// servedBackground.test.ts (SKIN-03, plan 58-05) - the BUILT-ARTIFACT backstop for
// the generated page background.
//
// THE ASSERTION IS OVER THE ARTIFACT, NEVER OVER THE SOURCE LINE. `index.html` no
// longer contains a colour at all: it carries the `%FAB_PAGE_BG%` token, and the
// `fab-page-background` plugin in `vite.config.ts` substitutes
// `colorToCss(LOCKED_SKIN.palette.ramp[0])` in both `vite` and `vite build`. Reading
// the source would therefore prove nothing about what a user is served - the whole
// house rule Phase 56 set when it asserted `antialias: false` from the live WebGL
// context rather than from a `.ts` file.
//
// TWO LEGS, AND THIS IS THE SECOND ONE.
//   PRIMARY (the dev-served artifact): `e2e/crisp-text.spec.ts` navigates to `/` and
//     reads the COMPUTED background of `body`. That leg always has an artifact to
//     read, because Vite is serving.
//   BACKSTOP (this file): `dist/index.html`, which is literally the file the
//     self-contained `tauri/custom-protocol` bundle ships as `frontendDist`
//     (`crates/fabrico-app/tauri.conf.json`). The dev server and the production
//     bundle are two different transforms of the same markup and only this leg
//     covers the second one.
//
// WHY IT SKIPS RATHER THAN PASSES WHEN `dist/` IS ABSENT. `dist/` is a build
// artifact, gitignored, and absent on a fresh clone - so an unguarded spec would go
// GREEN on a checkout where the thing it checks does not exist. That vacuous pass is
// worse than no spec: it reports coverage it does not have. The skip carries a NAMED
// message saying exactly what to run.

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { LOCKED_SKIN } from './locked.ts';
import { colorToCss } from '../../../../shared/geometry.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
/** `frontend/dist/index.html` - the built markup the Tauri bundle ships. */
const DIST_INDEX = resolve(HERE, '../../../../dist/index.html');

const EXPECTED = colorToCss(LOCKED_SKIN.palette.ramp[0]);

describe('the SERVED page background is generated from the locked ramp (SKIN-03)', () => {
  const built = existsSync(DIST_INDEX);

  it.skipIf(!built)(
    'dist/index.html paints the page LOCKED_SKIN.palette.ramp[0], substituted at build',
    () => {
      const html = readFileSync(DIST_INDEX, 'utf8');

      // A STALE `dist/` FAILS HERE, and that is the correct verdict, not a false
      // alarm: the claim under test is "the artifact a user is served carries the
      // locked colour", and a `dist/` built before the last source edit does not.
      // The message says so, because the fix (`npm run build`) is not guessable from
      // a bare colour mismatch.
      const stale = `(if this is a stale build, re-run \`npm run build\` - ${DIST_INDEX})`;

      // 1. The transform RAN. An un-substituted token would otherwise slip through
      //    every colour assertion below by simply not being a colour.
      expect(html, `%FAB_PAGE_BG% was never substituted ${stale}`).not.toContain('%FAB_PAGE_BG%');

      // 2. The built markup paints the ramp's darkest step.
      expect(html, `built html does not paint ${EXPECTED} ${stale}`).toContain(
        `background: ${EXPECTED};`,
      );

      // 3. THE ANTI-VACUITY LEG. Every check above would also pass on an html file
      //    that had lost the `<style>` block entirely, so pin that the rule this is
      //    about is still there and still applies to the page root.
      expect(html).toMatch(/html,\s*body,\s*#root\s*\{/);

      // 4. The RETIRED literal is gone. `#0e1116` was the hand-authored value and it
      //    is NOT `ramp[0]` (`#1b1f27`), so its absence is a real check and not a
      //    restatement of (2): a half-done cutover that left the old rule in place
      //    below the new one would still satisfy (2) and fail here.
      expect(html).not.toContain('#0e1116');
    },
  );

  it('the substituted value is a validated #rrggbb, whatever the ramp holds', () => {
    // Runs with or without `dist/`: it pins the CONTRACT the build plugin enforces
    // (T-58-22 - only a validated `#rrggbb` is ever written into markup), so the
    // guard has coverage on a fresh clone even when the artifact leg is skipped.
    expect(EXPECTED).toMatch(/^#[0-9a-f]{6}$/);
  });

  it.skipIf(built)('SKIPPED: frontend/dist/index.html is absent - run `npm run build`', () => {
    // A placeholder that exists so a skipped artifact leg is VISIBLE in the reporter
    // as a named reason rather than as silence. It never runs when `dist/` is present.
    expect(built).toBe(false);
  });
});
