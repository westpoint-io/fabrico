import { defineConfig, devices } from '@playwright/test';

// Sandbox/CI variant of playwright.config.ts: identical testDir + chromium project,
// but with NO `webServer` block. Playwright's own webServer subprocess management is
// unusable in some restricted shells (it spawns Vite in a detached process group that
// such a shell kills at signal 16). Here the caller starts Vite externally (on :5173) and
// Playwright only launches Chromium and connects to the already-running app.
//
// snapshotDir defaults to testDir (./e2e), matching playwright.config.ts, so baselines
// generated through this reuse config land in the SAME `e2e/<spec>-snapshots/` dir the
// blocking test:e2e run reads. The project name is 'chromium' so the `-chromium-linux`
// baseline suffix matches the main config exactly.
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: false,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:5173',
    // VEC-05: pin the GL backend explicitly rather than trusting the headless
    // default, so a maxDiffPixels:0 baseline holds identically local and in CI.
    // Verified 2026-07-30: byte-neutral - all 7 committed baselines (3
    // pixel-guard + 4 dpr-crispness) pass with AND without these args, and
    // UNMASKED_RENDERER_WEBGL is character-identical either way. This array is
    // byte-identical to playwright.config.ts's (this file mirrors it EXACTLY):
    // baselines are regenerated through THIS config and read by the blocking
    // one, so a GL divergence here is a latent baseline mismatch.
    launchOptions: { args: ['--use-gl=angle', '--use-angle=swiftshader'] },
    trace: 'off',
    // Mirror playwright.config.ts EXACTLY: run as a RETURNING user so the
    // first-run WelcomeCard (itself an `aside.fab-panel`) never double-matches
    // locators in chrome specs. Without this seed a FULL suite run under this
    // reuse config trips strict-mode violations the blocking config never sees.
    storageState: {
      cookies: [],
      origins: [
        {
          origin: 'http://127.0.0.1:5173',
          localStorage: [{ name: 'fab.onboarding.seen.v1', value: '1' }],
        },
      ],
    },
  },
  // EVIDENCE INTEGRITY (phase 58) - see playwright.config.ts for the full note.
  // `maxDiffPixels: 0` is not byte-exactness on its own: Playwright's per-pixel
  // `threshold` defaults to 0.2 (YIQ maxDelta 1408.6), so a whole ink swap (616)
  // passed unnoticed. Pinned to 0; verified byte-neutral, no baseline re-blessed.
  expect: {
    toHaveScreenshot: { threshold: 0 },
    toMatchSnapshot: { threshold: 0 },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // No webServer: the caller owns the Vite lifecycle.
});
