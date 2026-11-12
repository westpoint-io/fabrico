import { defineConfig, devices } from '@playwright/test';

// The docs suite, run over the built docs site (site/dist/) that scripts/check-docs.sh serves at
// /fabrico/ on 127.0.0.1. Run it through that script, which starts and stops the server, sets
// FABRICO_DOCS_URL, and fails unless every listed test passed. There is no `webServer`.
//
// OUTPUT. Playwright clears its output folder at the start of a run. The docs suite writes to its
// own subfolder of test-results/, so a docs run leaves the live pass's test-results/live-report.json
// in place.
//
// WORKERS. Set explicitly so CI and a local run don't depend on the machine's core count, which
// Playwright's default (half the cores) does. WORKERS_LOCAL is the count measured fastest locally;
// the CI runner has 4 vCPUs, so it gets 2.
const WORKERS_LOCAL = Number(process.env.FABRICO_DOCS_WORKERS ?? 4);
export default defineConfig({
  testDir: './e2e-docs',
  outputDir: './test-results/docs',
  workers: process.env.CI ? 2 : WORKERS_LOCAL,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: process.env.FABRICO_DOCS_URL,
    // The same GL backend as the mock suite's config.
    launchOptions: { args: ['--use-gl=angle', '--use-angle=swiftshader'] },
    trace: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
