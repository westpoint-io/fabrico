import { defineConfig, devices } from '@playwright/test';

/** The caller owns the host and Vite: `FABRICO_WALK_REUSE=1`. A restricted shell kills servers Playwright spawns. */
const WALK_REUSE = process.env.FABRICO_WALK_REUSE === '1';

// Playwright config for the lesson walk: the real dev_render_server plus the real Vite app, as
// the live suite runs them, over files named *.walk.ts only. It is a separate config because the
// live suite overruns its CI limit, so a lesson test there could sit among the tests that never
// start. The live projects use Playwright's default .spec and .test names, so neither live config
// picks these files up and none of them counts toward the live suite's test floor.
//
// Run via `npm run e2e:walk`, which builds both Rust examples first.
export default defineConfig({
  testDir: './e2e-live',
  testMatch: /\.walk\.ts$/,
  timeout: 90_000,
  // A ceiling on the whole run, so a wedged browser ends in a written report instead of a runner
  // killed at the CI job's limit. The slowest whole run measured was 22 minutes, on two CPUs at a
  // 100% quota. With about ten minutes of build before the suite, doubled, the CI job's limit is 64
  // minutes, and this is that limit less those ten.
  globalTimeout: 54 * 60_000,
  // One mutable host process is shared by every test.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  // The JSON report is what scripts/check-walk-report.sh reads, because this run exits 0 on a skipped test.
  reporter: [['list'], ['json', { outputFile: 'test-results/walk-report.json' }]],
  use: {
    baseURL: 'http://127.0.0.1:5173',
    // The same GL backend as every other config (glPinConfig.test.ts).
    launchOptions: { args: ['--use-gl=angle', '--use-angle=swiftshader'] },
    permissions: ['clipboard-write'],
    trace: 'retain-on-failure',
  },
  // `threshold: 0` is what makes `maxDiffPixels: 0` mean byte-exact.
  expect: {
    toHaveScreenshot: { threshold: 0 },
    toMatchSnapshot: { threshold: 0 },
  },
  projects: [
    {
      name: 'walk',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  ...(WALK_REUSE
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
