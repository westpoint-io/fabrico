import { defineConfig, devices } from '@playwright/test';

// The WebAssembly player's Chromium check, kept apart from the mock suite in `e2e/` because it needs
// a built module, and the mock job doesn't build one. Run it through
// `scripts/check-player-browser.sh`, which owns the Vite server. There is no `webServer` block
// because Playwright's own server management dies at signal 16 in some restricted shells. Port 5181
// keeps it clear of the mock and live suites on 5173.
export default defineConfig({
  testDir: './e2e-player',
  forbidOnly: false,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:5181',
    // The same GL backend as the mock suite's config.
    launchOptions: { args: ['--use-gl=angle', '--use-angle=swiftshader'] },
    trace: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
