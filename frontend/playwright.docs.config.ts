import { defineConfig, devices } from '@playwright/test';

// The docs suite, run over the built docs site (site/dist/) that scripts/check-docs.sh serves at
// /fabrico/ on 127.0.0.1. Run it through that script, which starts and stops the server, sets
// FABRICO_DOCS_URL, and fails unless every listed test passed. There is no `webServer`.
export default defineConfig({
  testDir: './e2e-docs',
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
