// The GL-backend pin's config-shape gate (VEC-05, Plan 56-01).
//
// WHAT THIS GATE COVERS: that all seven Playwright configs listed below name the SAME GL
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
  'playwright.walk.config.ts',
  'playwright.embed.config.ts',
  'playwright.player.config.ts',
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

/**
 * The one project allowed to launch with more than the pinned arguments: the embed config's
 * `chromium-nowebgl`, which turns WebGL off to check the poster a board shows without it. It may
 * add `--disable-webgl` after the pin and nothing else.
 */
const NO_WEBGL_PROJECT = {
  config: 'playwright.embed.config.ts',
  name: 'chromium-nowebgl',
  args: [...PINNED_ARGS, '--disable-webgl'],
} as const;

/**
 * Check one config's launch arguments. Returns what is wrong, or an empty list.
 *
 * The first `launchOptions.args` is the top-level pin and must equal it. A config may carry one
 * more only if it is the no-WebGL project's config, the extra array equals the pin plus
 * `--disable-webgl`, and the nearest project name before it is that project's.
 */
function launchArgProblems(name: string, source: string): string[] {
  const all = extractAllLaunchArgs(source);
  const problems: string[] = [];
  if (all.length === 0) return [`${name}: no use.launchOptions.args, so the pin is missing`];
  if (JSON.stringify(all[0]) !== JSON.stringify(PINNED_ARGS)) {
    problems.push(`${name}: the first launch args are ${JSON.stringify(all[0])}, not the pin`);
  }
  const extras = all.slice(1);
  if (extras.length === 0) return problems;
  if (name !== NO_WEBGL_PROJECT.config || extras.length > 1) {
    problems.push(
      `${name}: ${extras.length} more launchOptions.args after the pin; only ${NO_WEBGL_PROJECT.config}'s ` +
        `${NO_WEBGL_PROJECT.name} project may carry one`,
    );
    return problems;
  }
  if (JSON.stringify(extras[0]) !== JSON.stringify(NO_WEBGL_PROJECT.args)) {
    problems.push(`${name}: the extra launch args are ${JSON.stringify(extras[0])}, not ${JSON.stringify(NO_WEBGL_PROJECT.args)}`);
  }
  const matches = [...source.matchAll(/launchOptions:\s*\{\s*args:/g)];
  const at = matches[1]?.index ?? 0;
  const names = [...source.slice(0, at).matchAll(/name:\s*['"]([^'"]+)['"]/g)];
  const owner = names[names.length - 1]?.[1];
  if (owner !== NO_WEBGL_PROJECT.name) {
    problems.push(`${name}: the extra launch args belong to project ${String(owner)}, not ${NO_WEBGL_PROJECT.name}`);
  }
  return problems;
}

describe('the no-WebGL project is the one allowed extra', () => {
  const pin = `'--use-gl=angle', '--use-angle=swiftshader'`;
  const shape = (extra: string, project = 'chromium-nowebgl'): string =>
    `use: { launchOptions: { args: [${pin}] } },\n  projects: [{ name: 'chromium' }, { name: '${project}', use: { launchOptions: { args: [${pin}${extra}] } } }],`;

  it('accepts the pin plus --disable-webgl on the chromium-nowebgl project of the embed config', () => {
    expect(launchArgProblems('playwright.embed.config.ts', shape(`, '--disable-webgl'`))).toEqual([]);
  });

  it('refuses a second extra argument', () => {
    expect(launchArgProblems('playwright.embed.config.ts', shape(`, '--disable-webgl', '--use-gl=swiftshader'`))).toHaveLength(1);
  });

  it('refuses the extra arguments on another project or in another config', () => {
    expect(launchArgProblems('playwright.embed.config.ts', shape(`, '--disable-webgl'`, 'chromium-2'))).toHaveLength(1);
    expect(launchArgProblems('playwright.config.ts', shape(`, '--disable-webgl'`))).toHaveLength(1);
  });

  it('refuses a project that drops the pin while adding --disable-webgl', () => {
    const source = `use: { launchOptions: { args: [${pin}] } },\n  projects: [{ name: 'chromium-nowebgl', use: { launchOptions: { args: ['--disable-webgl'] } } }],`;
    expect(launchArgProblems('playwright.embed.config.ts', source)).toHaveLength(1);
  });
});

describe('VEC-05 GL pin: all Playwright configs name the same GL backend', () => {
  it('checks exactly 7 configs (a shrinking list cannot pass vacuously)', () => {
    expect(CONFIG_FILES).toHaveLength(7);
  });

  for (const name of CONFIG_FILES) {
    it(`${name} declares the GL pin exactly ONCE, and it is the pinned array`, () => {
      const source = readFileSync(configPath(name), 'utf8');
      expect(launchArgProblems(name, source), `${name}: launch args`).toEqual([]);
      // The no-WebGL project's own array is checked by launchArgProblems; the pin itself is the first.
      const all = extractAllLaunchArgs(source).slice(0, name === NO_WEBGL_PROJECT.config ? 1 : undefined);
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

  it('all 7 configs carry a byte-identical arg array', () => {
    const extracted = CONFIG_FILES.map((name) => ({
      name,
      // The pin is the first array; the embed config's no-WebGL project is checked above.
      all: extractAllLaunchArgs(readFileSync(configPath(name), 'utf8')).slice(0, name === NO_WEBGL_PROJECT.config ? 1 : undefined),
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
