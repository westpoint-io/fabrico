import { defineConfig, devices } from '@playwright/test';

/** Whether the caller asks for the terminal project (review IN-C-01): `FABRICO_LIVE_TERMINAL=1`. */
const LIVE_TERMINAL = process.env.FABRICO_LIVE_TERMINAL === '1';

// Sandbox/CI variant of playwright.live.config.ts: identical project + timeouts,
// but with NO `webServer` block. Playwright's own webServer subprocess management
// is unusable in some restricted shells (it spawns the dev_render_server + Vite in a
// detached process group that such a shell kills at signal 16). Here the caller starts both
// servers externally (dev_render_server on :8787, Vite on :5173) and Playwright only
// launches Chromium and connects to the already-running app. Loopback binding +
// Chromium both work foreground; only Playwright-spawned servers do not.
export default defineConfig({
  testDir: './e2e-live',
  timeout: 90_000,
  // A ceiling on the whole run (review 84 WR-06), so a wedged browser ends in a written report
  // instead of a runner killed at the CI job's limit: Playwright stops, marks what is left not
  // run, and writes the JSON report with a top-level "Timed out waiting ... for the test suite
  // to run" error, which scripts/check-live-red-set.sh refuses by name (exit 2, never a pass).
  // The slowest whole pass measured was 1.3 h (78 min, the GPU proxy; a full CI
  // run took 1.2 h), and the CI job's own limit is 120 min with about ten of build
  // before the suite starts, so 100.
  globalTimeout: 100 * 60_000,
  fullyParallel: false,
  workers: 1,
  forbidOnly: false,
  retries: 0,
  // MIRROR playwright.live.config.ts: the JSON report is what
  // scripts/check-live-red-set.sh reads for the live verdict (plan 84-02, GATE-07).
  reporter: [['line'], ['json', { outputFile: 'test-results/live-report.json' }]],
  use: {
    baseURL: 'http://127.0.0.1:5173',
    // VEC-05: pin the GL backend explicitly rather than trusting the headless
    // default, so a maxDiffPixels:0 baseline holds identically local and in CI.
    // Verified 2026-07-30: byte-neutral - all 7 committed baselines (3
    // pixel-guard + 4 dpr-crispness) pass with AND without these args, and
    // UNMASKED_RENDERER_WEBGL is character-identical either way. Identical to
    // the array in playwright.live.config.ts, which this file mirrors.
    launchOptions: { args: ['--use-gl=angle', '--use-angle=swiftshader'] },
    // MIRROR playwright.live.config.ts. Plan 58-03 granted `clipboard-write` there
    // so CFG-03's Copy button can flip to `Copied` - the app deliberately refuses to
    // fake a write it did not make, so without the grant headless Chromium rejects
    // and the button honestly reads `Copy failed`. The grant was NOT mirrored here,
    // and THIS is the config a restricted shell actually runs (the blocking one spawns
    // its own servers and is killed at signal 16), so the fix was landing where it could
    // not be observed: 47/48 with 12-config-apply red. Measured 2026-08-02. Any
    // future `use:` change to the blocking config belongs here too - that is the
    // whole contract of this file.
    permissions: ['clipboard-write'],
    trace: 'off',
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
  // TWO PROJECTS, THE TERMINAL SPECS LAST: MIRROR playwright.live.config.ts (phase 90, D-13;
  // review IN-C-01 and WR-C-01), with one difference. This config runs against a host the CALLER
  // started, and Playwright promotes a teardown to a dependency on any file-filtered run without
  // `--no-deps`, which would fire the fault switch on that host and leave every later run against
  // it red. So here the `live-terminal` project, and the `live` project's teardown edge to it,
  // exist only when the caller asks for them with FABRICO_LIVE_TERMINAL=1 (the full-pass recipe and
  // a run of the fatal spec alone set it). `scripts/check-live-red-set.sh` refuses a full pass that
  // holds no test from the fatal spec, so a full pass run without the flag cannot read OK.
  // `liveProjects.source.test.ts` keeps the two configs' projects the same.
  projects: [
    {
      name: 'live',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: /\.terminal\.spec\.ts$/,
      ...(LIVE_TERMINAL ? { teardown: 'live-terminal' } : {}),
    },
    ...(LIVE_TERMINAL
      ? [
          {
            name: 'live-terminal',
            use: { ...devices['Desktop Chrome'] },
            testMatch: /\.terminal\.spec\.ts$/,
          },
        ]
      : []),
  ],
  // No webServer: the caller owns the dev_render_server + Vite lifecycle.
});
