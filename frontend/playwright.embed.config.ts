import { defineConfig, devices } from '@playwright/test';

// The read-only board's checks, run over the built pages in `dist-embed/pages/` by file:// URL.
// Run it through `scripts/check-embed.sh`, which builds nothing and fails unless every listed test
// passed. There is no `webServer` and no `baseURL`: the pages are opened from disk, the way a reader
// opens the offline file.
export default defineConfig({
  testDir: './e2e-embed',
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: 'list',
  use: {
    // The same GL backend as the mock suite's config.
    launchOptions: { args: ['--use-gl=angle', '--use-angle=swiftshader'] },
    trace: 'off',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] }, testIgnore: 'nowebgl.spec.ts' },
    // The same Chromium with WebGL turned off, for the poster state. Playwright replaces a
    // project's launchOptions whole, so the pinned GL arguments are spelled out again, and
    // glPinConfig.test.ts allows this one project to add --disable-webgl and nothing else.
    {
      name: 'chromium-nowebgl',
      testMatch: 'nowebgl.spec.ts',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: { args: ['--use-gl=angle', '--use-angle=swiftshader', '--disable-webgl'] },
      },
    },
  ],
});
