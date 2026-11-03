import { defineConfig, devices } from '@playwright/test';

// The offline file's checks: `dist-examples/fabrico-examples.html` opened by file:// URL, the way a
// reader double-clicks it. Build it with `scripts/build-embed.sh` and run this config through
// `scripts/check-offline-browsers.sh`, which also runs the WebKitGTK leg and fails unless every
// listed test passed. There is no `webServer` and no `baseURL`.
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
    // FIREFOX WITH ITS STOCK FILE POLICY. Playwright's Firefox profile sets
    // security.fileuri.strict_origin_policy to false, which lets a file:// page load its sibling
    // files. A reader's Firefox has it true. Both projects set it back to true, and the offline
    // tests depend on the canary, which fails unless a sibling module script and a sibling fetch
    // are both blocked; so a relaxed profile stops the Firefox leg instead of passing it.
    //
    // Each project's `launchOptions` replaces the top-level one whole, so Firefox gets no Chromium
    // arguments. glPinConfig.test.ts reads only `launchOptions.args` arrays, and these declare
    // none.
    {
      name: 'firefox-canary',
      testMatch: 'canary.spec.ts',
      use: {
        ...devices['Desktop Firefox'],
        browserName: 'firefox',
        launchOptions: { firefoxUserPrefs: { 'security.fileuri.strict_origin_policy': true } },
      },
    },
    {
      name: 'firefox-strict',
      testMatch: 'offline.spec.ts',
      dependencies: ['firefox-canary'],
      use: {
        ...devices['Desktop Firefox'],
        browserName: 'firefox',
        launchOptions: { firefoxUserPrefs: { 'security.fileuri.strict_origin_policy': true } },
      },
    },
  ],
});
