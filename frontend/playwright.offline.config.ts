import { defineConfig, devices } from '@playwright/test';

// The offline file's checks: `dist-examples/fabrico-examples.html` opened by file:// URL, the way a
// reader double-clicks it. Build it with `scripts/build-embed.sh` and run this config through
// `npx playwright test --config=playwright.offline.config.ts`. There is no `webServer` and no `baseURL`.
export default defineConfig({
  testDir: './e2e-offline',
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: 'list',
  use: {
    // The same GL backend as the mock suite's config, for the Chromium project.
    launchOptions: { args: ['--use-gl=angle', '--use-angle=swiftshader'] },
    trace: 'off',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] }, testIgnore: 'canary.spec.ts' },
  ],
});
