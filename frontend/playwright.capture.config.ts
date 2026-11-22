import { defineConfig, devices, type ReporterDescription } from '@playwright/test';

/** The caller owns the host and Vite: `FABRICO_CAPTURE_REUSE=1`. A restricted shell kills servers Playwright spawns. */
const CAPTURE_REUSE = process.env.FABRICO_CAPTURE_REUSE === '1';

// The run's exit code is the verdict. The JSON report keeps each test's result and duration.
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
  // at the CI job's limit. The slowest recorded run is CI run 45022991094 on 1df4880: its runner was
  // 1.6 to 1.9 times slower than run 44867588480's (18.5 job minutes). The capture test for ratio 2
  // with antialiasing on hit its per-test limit after zoom 4, and the job ended at 29.8 minutes,
  // the steps after the suite included. The part that never ran, timed on the same runner, is about
  // 2.6 minutes: the last zoom (7 tiles, 107 s for the ratio-2 shipped boot times 1.29, aa-on's
  // slowdown at zoom 2, so 138 s) and the 216 grading tests (7.5 s on the earlier run times 1.9, so
  // 14 s). That makes 32.4 job minutes. Doubled that is 64.8, rounded up to the next five minutes
  // the way the walk's 58.4 became 60, which gives 65. The CI job's limit is 80: these 65 plus 15
  // for the build. The 40 minutes this replaces were 1.2 times that run, under ci.yml's 1.5 to 2
  // rule.
  globalTimeout: 65 * 60_000,
  // One mutable host process is shared by every test, so tests run one at a time.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  // A test that fails and then passes on a retry fails the run. With retries at 0 this only
  // matters if someone raises retries later.
  failOnFlakyTests: true,
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
