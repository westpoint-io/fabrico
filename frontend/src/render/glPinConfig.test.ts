// The GL-backend pin's config-shape gate (VEC-05, Plan 56-01).
//
// WHAT THIS GATE COVERS: that all four Playwright configs name the SAME GL
// backend, in their ONLY `launchOptions.args` declaration. The "only" is
// load-bearing and was added by the phase 56 review (WR-04): Playwright replaces
// `launchOptions` wholesale when a project-level `use` declares it, so a gate
// that reads one occurrence per file proves nothing about the array Chromium
// actually launches with. See `extractAllLaunchArgs`.
// Playwright chooses the backend at browser launch, so a
// `maxDiffPixels: 0` baseline is only portable if every config that can
// screenshot - the blocking mock config, the sandbox reuse config baselines are
// REGENERATED through, and the two live variants - launches Chromium with a
// byte-identical arg array. A drift between the blocking config and the reuse
// config is a latent baseline mismatch that would surface as an unexplained
// pixel diff in some later phase, which is exactly the class of question this
// phase exists to make answerable.
//
// WHAT IT DOES NOT COVER: whether the pinned backend is the one Chromium would
// have picked anyway (measured 2026-07-30: it is - all 7 committed baselines
// pass with and without the args and UNMASKED_RENDERER_WEBGL is identical), and
// whether the args are spelled correctly for the installed Chromium. Only an
// actual Playwright run proves those; this spec proves AGREEMENT.
//
// WHY A TEXT SCAN, NOT AN IMPORT: the Playwright configs are outside
// `tsconfig.json`'s `include` and importing `@playwright/test`'s `defineConfig`
// into a vitest run would drag the Playwright runner into the unit suite. The
// scan reads the committed source, which is also the artifact a reviewer reads.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The GL args VEC-05 pins, in order. Order is load-bearing: the assertion below
 * compares the EXTRACTED arrays element-by-element, so a reordering in one file
 * is a divergence even though Chromium would accept either order.
 */
const PINNED_ARGS = ['--use-gl=angle', '--use-angle=swiftshader'] as const;

/**
 * Every Playwright config that can launch a browser, repo-relative to
 * `frontend/`. This list is a LITERAL, not a directory glob: a new config added
 * without its GL pin must fail this gate, and a glob would silently accept a
 * config that simply had not been written yet. Adding a config means adding a
 * row here - that is the point.
 */
const CONFIG_FILES = [
  'playwright.config.ts',
  'playwright.mock.reuse.config.ts',
  'playwright.live.config.ts',
  'playwright.live.reuse.config.ts',
] as const;

/** cwd-independent resolution (the `src/protocol/route.test.ts` idiom). */
const configPath = (name: string): string =>
  fileURLToPath(new URL(`../../${name}`, import.meta.url));

/**
 * Pull EVERY `launchOptions.args` array literal out of a config's source, in
 * source order, each as its string entries.
 *
 * "EVERY", not "the first", is the whole point (phase 56 review WR-04). This used
 * to call `.exec` on a non-global regex, which returns the FIRST match only, and
 * Playwright does not deep-merge `launchOptions`: a project-level `use` REPLACES
 * the top-level one wholesale. So a config shaped like
 *
 *     use: { launchOptions: { args: ['--use-gl=angle', '--use-angle=swiftshader'] } },
 *     projects: [{ name: 'mock', use: { launchOptions: { args: [] } } }],
 *
 * launched Chromium with NO GL pin at all while this gate reported all four
 * configs agreeing - it read the first occurrence and never saw the override that
 * defeated it. A comment carrying the same shape is the likelier accidental
 * version of the same hole and is caught the same way.
 *
 * Returns an empty array when the config declares no `launchOptions.args` at all,
 * so "missing", "one", and "more than one" are all distinguishable below.
 */
function extractAllLaunchArgs(source: string): Array<readonly string[]> {
  return [...source.matchAll(/launchOptions:\s*\{\s*args:\s*\[([^\]]*)\]/g)].map((m) =>
    [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((q) => q[1]),
  );
}

describe('VEC-05 GL pin: all Playwright configs name the same GL backend', () => {
  it('checks exactly 4 configs (a shrinking list cannot pass vacuously)', () => {
    expect(CONFIG_FILES).toHaveLength(4);
  });

  for (const name of CONFIG_FILES) {
    it(`${name} declares the GL pin exactly ONCE, and it is the pinned array`, () => {
      const all = extractAllLaunchArgs(readFileSync(configPath(name), 'utf8'));
      // EXACTLY one. Zero means the pin is missing. More than one means some
      // occurrence is not being asserted - and since Playwright resolves project
      // `use` over top-level `use` by replacement, the one this gate would have
      // read is not necessarily the one Chromium launches with.
      expect(
        all,
        `${name}: expected exactly ONE use.launchOptions.args; found ${all.length}` +
          ' (0 = the pin is missing; >1 = a project-level override or a commented' +
          ' copy that this gate cannot prove is harmless - fold it into the single' +
          ' top-level declaration)',
      ).toHaveLength(1);
      expect(all[0]).toEqual([...PINNED_ARGS]);
    });
  }

  it('all 4 configs carry a byte-identical arg array', () => {
    const extracted = CONFIG_FILES.map((name) => ({
      name,
      all: extractAllLaunchArgs(readFileSync(configPath(name), 'utf8')),
    }));
    // Assert the whole shape at once so the failure message names WHICH config
    // diverged and what it carries, rather than only that a comparison failed.
    expect(extracted).toEqual(
      CONFIG_FILES.map((name) => ({ name, all: [[...PINNED_ARGS]] })),
    );
    // Guard against the vacuous pass where the extractor regex broke and every
    // config resolved to an empty list: an empty-vs-empty comparison would agree.
    for (const { name, all } of extracted) {
      expect(all, `${name}: exactly one args array must be found`).toHaveLength(1);
      expect(all[0], `${name}: args must be a real array, not empty`).toHaveLength(2);
    }
  });
});
