import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { LOCKED_SKIN } from './src/render/synth/skins/locked.ts';
import { colorToCss } from './shared/geometry.ts';

/**
 * The placeholder `index.html` carries in place of a hand-authored page background.
 * Nothing else in the tree contains it. `index.html` is the one rollup input; the
 * dev-only fixture pages beside it (`art-board.html`, `chrome-dpr-spike.html`,
 * `pixel-guard.html`, and the static `mark-sheet.html`) are served by the dev server
 * only, never built, and never mention the token (`devFixtureGuardPlugin` below keeps
 * them out of the build).
 */
const PAGE_BG_TOKEN = '%FAB_PAGE_BG%';

/**
 * Generate the page background from the LOCKED skin at build time (SKIN-03).
 *
 * WHY THIS IS A BUILD PLUGIN AND NOT A CSS CUSTOM PROPERTY. The background has to be
 * painted BEFORE the first React render - it is what the user sees during module
 * evaluation and before Pixi's first frame - so it cannot come from
 * `skinToCssVars()`, which runs in the app. The only other option is a literal in the
 * markup, and that literal WAS the leak: `index.html` hardcoded `#0e1116` while the
 * ramp's darkest step is `#1b1f27`, so the page and the canvas disagreed about the
 * colour of the void for the whole of the project's life until plan 58-05.
 *
 * NOT GATED WITH `apply: 'serve'`, deliberately, and this was verified by experiment
 * rather than assumed (58-05 task 1, assumption A1): `transformIndexHtml` runs in
 * `vite build` too, so `dist/index.html` - which is exactly what the self-contained
 * `tauri/custom-protocol` bundle ships as `frontendDist` - carries the substituted
 * value. A `serve`-only plugin would have shipped the raw token to every desktop user.
 *
 * T-58-22 (HTML injection through the build transform): the ONLY thing this plugin
 * can write into the markup is a string that has already matched `/^#[0-9a-f]{6}$/`.
 * It is a pure literal substitution with no free text, no user input and no
 * interpolation of anything else. A malformed value throws at CONFIG LOAD, which
 * fails the build rather than producing markup.
 *
 * Positive side effect, also verified by experiment (assumption A2): importing
 * `skins/locked.ts` here runs its module-load `validate(LOCKED_SKIN)` inside the Node
 * config context, so a malformed shipped skin now fails `vite build` and `vite`
 * itself - not merely the app at runtime.
 */
function pageBackgroundPlugin(): Plugin {
  const css = colorToCss(LOCKED_SKIN.palette.ramp[0]);
  if (!/^#[0-9a-f]{6}$/.test(css)) {
    throw new Error(
      `fab-page-background: refusing to substitute a non-#rrggbb value into index.html (got ${JSON.stringify(css)})`,
    );
  }
  return {
    name: 'fab-page-background',
    transformIndexHtml: {
      order: 'pre' as const,
      /**
       * THE SUBSTITUTION IS MANDATORY ON THE APP ENTRY (58 review WR-11).
       *
       * `transformIndexHtml` runs for EVERY html entry, and this project has four
       * (`index.html` plus three spike/fixture pages). A plain
       * `html.split(TOKEN).join(css)` is a silent no-op on the three that do not carry
       * the token, which is correct - and an equally silent no-op if `index.html` ever
       * STOPS carrying it, which is not.
       *
       * `index.html` argues the latter is safe because an unsubstituted token is
       * invalid CSS and the page would paint unstyled "LOUDLY". That covers THE
       * TRANSFORM NOT RUNNING. It does not cover the likelier regression: someone
       * replaces the token with a literal colour, this plugin no-ops, and the exact
       * hardcoded-background leak SKIN-03 closed is back with nothing to catch it.
       * `e2e/crisp-text.spec.ts` asserts the SERVED colour and would still pass on a
       * hand-typed `#1b1f27`, and the `dist/` backstop (`servedBackground.test.ts`) is
       * `skipIf(!built)` while the CI `frontend unit` job never runs `npm run build` -
       * so the built-artifact leg is skipped in CI by construction.
       *
       * Throwing here fails the build and the dev server, which is the only signal
       * that cannot be skipped.
       */
      handler(html: string, ctx: { path: string }): string {
        const isEntry = ctx.path.endsWith('/index.html');
        if (isEntry && !html.includes(PAGE_BG_TOKEN)) {
          throw new Error(
            `fab-page-background: index.html no longer carries ${PAGE_BG_TOKEN}. The page ` +
              'background must be GENERATED from LOCKED_SKIN.palette.ramp[0] (SKIN-03), ' +
              'never hand-authored - a literal here is the leak that plan 58-05 closed.',
          );
        }
        return html.split(PAGE_BG_TOKEN).join(css);
      },
    },
  };
}

/**
 * THE DEV-FIXTURE GUARD (phase 91 plan 91-03, CHROME-06, D-05): nothing built for a dev
 * page may reach the shipped bundle, and the build fails BY NAME if it does.
 *
 * `dist/` is what the self-contained Tauri binary ships (`frontendDist`), so it must
 * hold `index.html`, its own assets, and nothing written for the dev-only fixture pages:
 * no module under `src/spike/` (the fixture pages' code) and not the pilot calibration
 * fixture `src/render/assets/pilot.svg`, whose text once rode the shipped asset table
 * into `dist/`. Two hooks, both `apply: 'build'` (the dev server serves the fixture pages
 * on purpose):
 *
 *   - `buildEnd` walks every module id in the finished graph. An id is matched BY PATH,
 *     relative to the frontend root, with its query stripped and its separators
 *     normalised, never by words: shipped SVG comments name the fixture pages in prose,
 *     so a word grep of `dist/` would go red on a comment.
 *   - `generateBundle` refuses any emitted `.html` other than `index.html`, the shape a
 *     second rollup input would take.
 *
 * THROWING IS THE ONLY SIGNAL A BUILD CANNOT SKIP, the rule `pageBackgroundPlugin` above
 * states: a warning scrolls past. `npm run check:board` in CI builds and counts the html
 * files in `dist/`, a second net for HTML PAGES ONLY (phase 91 review IN-A-04): a module
 * under `src/spike/` or the pilot fixture's text bundled into a script is caught by
 * `buildEnd` here and by nothing else, because `dist/` keeps no module paths to check by.
 */
function devFixtureGuardPlugin(): Plugin {
  let root = process.cwd();
  const devOnly = (id: string): string | null => {
    const clean = id.replace(/^\0/, '').split('?')[0].replace(/\\/g, '/');
    if (!path.isAbsolute(clean)) return null;
    const rel = path.relative(root, clean).replace(/\\/g, '/');
    if (rel.startsWith('src/spike/')) return rel;
    if (rel === 'src/render/assets/pilot.svg') return rel;
    return null;
  };
  return {
    name: 'fab-dev-fixture-guard',
    apply: 'build',
    enforce: 'post',
    configResolved(config) {
      root = config.root;
    },
    buildEnd() {
      const leaked = [...this.getModuleIds()].map(devOnly).filter((r): r is string => r !== null);
      if (leaked.length > 0) {
        throw new Error(
          `fab-dev-fixture-guard: dev-only modules entered the shipped build graph: ${[...new Set(leaked)].sort().join(', ')}. ` +
            'src/spike/ and render/assets/pilot.svg serve the dev fixture pages only; import them from a fixture or a test, never from the app (CHROME-06).',
        );
      }
    },
    generateBundle(_options, bundle) {
      const extra = Object.keys(bundle)
        .filter((f) => f.endsWith('.html') && f !== 'index.html')
        .sort();
      if (extra.length > 0) {
        throw new Error(
          `fab-dev-fixture-guard: the build emits html other than index.html: ${extra.join(', ')}. ` +
            'The shipped bundle holds exactly one page; the dev fixture pages are served by the dev server only (CHROME-06).',
        );
      }
    },
  };
}

// Browser-first dev server. Tauri later points devUrl at http://localhost:5173
// and frontendDist at ../frontend/dist — the SAME renderer, two transports.
export default defineConfig({
  plugins: [react(), pageBackgroundPlugin(), devFixtureGuardPlugin()],
  // Vite 8 needs Node >=20.19 / >=22.12 (22.20 present).
  server: {
    port: 5173,
    strictPort: true,
  },
});
