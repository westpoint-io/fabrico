import { defineConfig, devices, type ReporterDescription } from '@playwright/test';

/** The caller owns the host and Vite: `FABRICO_CAPTURE_REUSE=1`. A restricted shell kills servers Playwright spawns. */
const CAPTURE_REUSE = process.env.FABRICO_CAPTURE_REUSE === '1';

// The JSON report is what a report checker reads, because this run exits 0 on a skipped test.
const REPORTERS: ReporterDescription[] = [['list'], ['json', { outputFile: 'test-results/capture-report.json' }]];

// Playwright config for the board capture set: the real dev_render_server plus the real Vite app,
// as the live suite runs them, over files named *.capture.ts only. The live projects use
// Playwright's default .spec and .test names, so no live config picks these files up.
//
// Two projects. `capture` boots the board once per pixel ratio and antialiasing setting, captures
// every zoom and writes the PNGs and a manifest under test-results/capture/. `grade` depends on it
// and grades each (property, cell) from the manifest alone, so a grading failure never re-runs a
// boot, and a failed capture leaves its grading tests not run, which the report shows.
//
// Run via `npm run e2e:capture`, which builds the host first.
export default defineConfig({
  testDir: './e2e-live',
  testMatch: /\.capture\.ts$/,
  timeout: 90_000,
  // A ceiling on one run, so a wedged browser ends in a written report instead of a runner killed
  // at the CI job's limit. 30 minutes is a first estimate. The first recorded CI run replaces it
  // with the walk's rule: the slowest recorded job minutes doubled, rounded up to the next five.
  globalTimeout: 30 * 60_000,
  // One mutable host process is shared by every test, so tests run one at a time.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: REPORTERS,
  use: {
    baseURL: 'http://127.0.0.1:5173',
    // The same GL backend as every other config (glPinConfig.test.ts).
    launchOptions: { args: ['--use-gl=angle', '--use-angle=swiftshader'] },
    trace: 'retain-on-failure',
  },
  // `threshold: 0` is what makes `maxDiffPixels: 0` mean byte-exact. No test here compares a
  // stored image; the block is kept so a later one can't quietly compare loosely.
  expect: {
    toHaveScreenshot: { threshold: 0 },
    toMatchSnapshot: { threshold: 0 },
  },
  projects: [
    {
      name: 'capture',
      testMatch: /board\.capture\.ts$/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'grade',
      testMatch: /board-grade\.capture\.ts$/,
      dependencies: ['capture'],
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  ...(CAPTURE_REUSE
    ? {}
    : {
        webServer: [
          {
            // The npm script pre-builds. The binary runs directly, so an unbuilt host fails fast.
            command: '../target/debug/examples/dev_render_server',
            // A plain GET on the WebSocket route answers 400, which the readiness probe accepts.
            url: 'http://127.0.0.1:8787/render',
            // Stateful server: a mutated instance must not pass for a cold boot.
            reuseExistingServer: false,
            stdout: 'pipe' as const,
            stderr: 'pipe' as const,
            timeout: 60_000,
          },
          {
            command: 'npm run dev -- --host 127.0.0.1 --port 5173 --strictPort',
            url: 'http://127.0.0.1:5173',
            reuseExistingServer: !process.env.CI,
            timeout: 120_000,
          },
        ],
      }),
});
