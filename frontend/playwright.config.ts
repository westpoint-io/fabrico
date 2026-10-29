import { defineConfig, devices } from '@playwright/test';

// Playwright config for the Fabrico e2e harness (TEST-04, Phase 13-04).
//
// This is the THIN scaffold proving "one schema, two producers": the real UI is
// driven through the same `GridCommand` schema the headless scenario harness
// produces, and we assert the EMITTED command bytes on the dev render
// WebSocket — never canvas pixels. `webServer` boots the real Vite app so the
// specs exercise the production renderer, not a stub.
//
// Pinned to chromium-only (RESEARCH Pitfall 4): cross-OS chromium download
// flakiness is avoided in CI by running this job on ubuntu alone; the
// determinism gate already covers the three Tauri target platforms.
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  // CI must never green-light a stray `test.only`.
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:5173',
    // VEC-05: pin the GL backend explicitly rather than trusting the headless
    // default, so a maxDiffPixels:0 baseline holds identically local and in CI.
    // Verified 2026-07-30: byte-neutral - all 7 committed baselines (3
    // pixel-guard + 4 dpr-crispness) pass with AND without these args, and
    // UNMASKED_RENDERER_WEBGL is character-identical either way. The identical
    // two-element array MUST appear in all four Playwright configs: if the
    // blocking config and a reuse config disagree on the GL backend, a baseline
    // regenerated through one can fail under the other.
    launchOptions: { args: ['--use-gl=angle', '--use-angle=swiftshader'] },
    // A trace on the first retry is enough to debug a flake without paying the
    // capture cost on every run.
    trace: 'on-first-retry',
    // Run the mock chrome suite as a RETURNING user. Every fresh Playwright
    // context starts with empty localStorage, so the Phase-34 first-run
    // WelcomeCard (itself an `aside.fab-panel`) would render on every spec and
    // double-match locators like `aside.fab-panel`, tripping strict mode in
    // unrelated chrome specs (e.g. chrome-bezel). Pre-seed the onboarding-seen
    // flag as a per-context init so the card never shows here. Onboarding itself
    // is exercised in e2e-live/ spec 12 + vitest - never in this mock suite - so
    // suppressing it here removes noise without dropping coverage. (Scoped to
    // this config only; playwright.live.config.ts is untouched.)
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
  // EVIDENCE INTEGRITY (phase 58, found by mutating a shipped constant).
  // `maxDiffPixels: 0` alone is NOT byte-exactness. Playwright's per-pixel
  // `threshold` defaults to 0.2, which pixelmatch turns into a YIQ maxDelta of
  // 35215 * 0.2^2 = 1408.6: a pixel must differ by MORE than that before it is
  // counted at all, so "zero differing pixels" was really "zero pixels differing
  // by a lot". Measured: a full `ramp[2]` -> `ramp[0]` chassis-ink swap scores
  // 616 and this suite's own `#0e1116` -> `#1b1f27` page-background change scores
  // 100.5 - both invisible to the old gate. A machine-body bevel outline widened
  // 1 -> 3 px passed the entire pixel suite on a cleared cache while provably
  // changing the render. (That mutation moved a machine-body bevel constant that plan
  // 61-07 has since deleted with the last pixel bake; it is quoted as the historical
  // evidence for pinning `threshold: 0`, not as a live knob a reader can go and flip.)
  // Pinning `threshold: 0` makes the assertion mean what every summary in this
  // milestone already claimed it meant. Verified byte-neutral 2026-08-02: all 8
  // committed baselines pass with threshold 0, so nothing was re-blessed to buy
  // this - the baselines were always exact, the GATE was not.
  expect: {
    toHaveScreenshot: { threshold: 0 },
    toMatchSnapshot: { threshold: 0 },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // Boot the REAL app. Bind explicitly to 127.0.0.1:5173 (strict) so the
  // webServer.url probe matches the actual bind and the dev WebSocket loopback
  // discipline is mirrored. Reuse a already-running dev server locally; in CI
  // always spawn a fresh one.
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 5173 --strictPort',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
