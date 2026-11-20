// testAntialias.ts - a test-only switch that boots the board canvas with antialiasing on.
//
// WHY IT EXISTS. The board ships with antialiasing off. The capture set also photographs
// every scene with it on, because a grey fringe beside a stroke only shows with it on, so a
// stroke check run only with it off could never catch one. WebGL fixes antialiasing when
// the context is created, so there is no way to turn it on later: the value has to be known
// before `app.init` builds the context, and a URL flag read at boot is the simplest way to
// hand it in.
//
// WHERE IT WORKS. Only in the Vite dev server, which is what the live and capture suites
// run on. `vite build` replaces `import.meta.env.DEV` with `false`, the early return below
// becomes unconditional, and the minifier drops the rest of the function with the flag's
// name. So the shipped app and the docs embed boot with antialiasing off whatever the URL
// says. `scripts/check-test-aa-switch-absent.sh` proves the built bundles carry no flag
// name, and CI runs it on every commit together with a proof that it can still fail.
//
// The flag's name is written once, inline in the guarded line, on purpose: an exported
// constant would survive the build even after this function folds away.

/**
 * The `antialias` option for the board's WebGL context. True only in the dev server and
 * only when `search` (a page's `location.search`) names the test flag; false everywhere
 * else, which is every shipped build.
 */
export function antialiasForBoot(search: string): boolean {
  if (!import.meta.env.DEV) return false;
  return new URLSearchParams(search).has('fab-test-antialias');
}
