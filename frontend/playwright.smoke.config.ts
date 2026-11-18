import { defineConfig, devices } from '@playwright/test';

// The Pages smoke, run over the deployed docs site at FABRICO_DOCS_URL: in CI the live address,
// https://westpoint-io.github.io/fabrico/, after the pages job deploys; locally a served copy of
// site/dist. Run it through scripts/check-pages-smoke.sh, which fails unless every listed test
// passed. There is no `webServer`: the smoke serves nothing.
//
// OUTPUT. Playwright clears its output folder at the start of a run, so the smoke writes to its own
// subfolder of test-results/ and leaves the other suites' reports in place. CI uploads this folder
// when the smoke fails.
//
// WORKERS. One. The spec is serial: the first test waits until the site serves this commit's build,
// and every later test checks that build.
export default defineConfig({
  testDir: './e2e-smoke',
  outputDir: './test-results/smoke',
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: process.env.FABRICO_DOCS_URL,
    // The same GL backend as the docs suite's config.
    launchOptions: { args: ['--use-gl=angle', '--use-angle=swiftshader'] },
    trace: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
