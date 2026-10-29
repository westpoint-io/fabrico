import { defineConfig, devices } from '@playwright/test';

// Playwright config for the LIVE e2e gate (Phase 22, E2E-01..04): the real
// dev_render_server (real Core -> RenderProducer -> postcard -> WS) plus the
// real Vite app, ZERO mocks. This file exists because webServer is a
// config-global property, not a per-project one (Pitfall 1): folding the live
// project into playwright.config.ts would make the fast mock suite require a
// Rust toolchain. The mock config stays byte-identical and Rust-free.
//
// Run via `npm run e2e:live` (the gate command): it pre-builds the host binary
// so compilation never eats the readiness window below (Pitfall 3).
export default defineConfig({
  testDir: './e2e-live',
  // Generous per-test timeout (review WR-02): the default 30s is thin against
  // waitForAppReady's up-to-30s budget plus 03's ~5s of mandatory real packet
  // accumulation on a cold CI runner. retries: 0 means a timeout IS a red
  // gate, so the budget must absorb cargo/CI slowness, never race it.
  timeout: 90_000,
  // A ceiling on the whole run (review 84 WR-06), so a wedged browser ends in a written report
  // instead of a runner killed at the CI job's limit: Playwright stops, marks what is left not
  // run, and writes the JSON report with a top-level "Timed out waiting ... for the test suite
  // to run" error, which scripts/check-live-red-set.sh refuses by name (exit 2, never a pass).
  // The slowest whole pass measured was 1.3 h (78 min, the GPU proxy; a full CI
  // run took 1.2 h), and the CI job's own limit is 120 min with about ten of build
  // before the suite starts, so 100.
  globalTimeout: 100 * 60_000,
  // ONE mutable host process is shared by every spec: serialize everything
  // (Pitfall 4 - a parallel worker would mutate the scene under another spec).
  fullyParallel: false,
  workers: 1,
  // CI must never green-light a stray `test.only`.
  forbidOnly: !!process.env.CI,
  // LOCKED flake policy: a flaky gate is a broken gate. retries stays 0
  // unconditionally - the mock config's CI retry must never apply here.
  retries: 0,
  // The JSON report is the live gate's input: scripts/check-live-red-set.sh reads
  // test-results/live-report.json and passes only when the failed set is exactly the
  // declared CUTs (plan 84-02, GATE-07), because the CUT makes this run exit 1 forever.
  reporter: [['list'], ['json', { outputFile: 'test-results/live-report.json' }]],
  use: {
    baseURL: 'http://127.0.0.1:5173',
    // VEC-05: pin the GL backend explicitly rather than trusting the headless
    // default, so a maxDiffPixels:0 baseline holds identically local and in CI.
    // Verified 2026-07-30: byte-neutral - all 7 committed baselines (3
    // pixel-guard + 4 dpr-crispness) pass with AND without these args, and
    // UNMASKED_RENDERER_WEBGL is character-identical either way. Identical to
    // the array in the other three configs; the live suite renders the same
    // WebGL canvas, so it must not run on a different backend.
    launchOptions: { args: ['--use-gl=angle', '--use-angle=swiftshader'] },
    // CFG-03 needs the browser to ACTUALLY OWN the clipboard, because the app
    // deliberately refuses to lie about a write it did not make. `clipboardCopy.ts`
    // exists to kill `void navigator.clipboard?.writeText(url)` followed by an
    // unconditional "Copied"; it awaits the write and shows `Copy failed` when the
    // write rejects. Headless Chromium denies `clipboard-write` by default, so
    // `writeText` rejected with NotAllowedError, the button showed `Copy failed` for
    // its 1.5s hold and returned to `Copy`, and `12-config-apply.spec.ts` waited 5s
    // for a `Copied` that correctly never came.
    //
    // Granting the permission is the right fix and NOT a loosened assertion: the spec
    // is about the app's copy path, and denying the browser capability under it tests
    // Chromium's default permission policy instead. The failure branch is not lost -
    // `clipboardCopy.test.ts` drives a rejecting `writeText` directly and pins that
    // the button says `Copy failed` rather than `Copied` (found and fixed while
    // running the plan 58-03 live leg; the red predates that plan and is unrelated
    // to it).
    permissions: ['clipboard-write'],
    // retries: 0 means on-first-retry could never fire; retain the trace on
    // failure instead so a red gate is always debuggable.
    trace: 'retain-on-failure',
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
  // TWO PROJECTS, THE TERMINAL SPECS LAST (phase 90, D-13, research Finding B). A terminal
  // spec ends the one shared dev host (the fatal sim error spec fires the host's fault switch),
  // so it must run after every other live spec, in a project of its own. Terminal specs are
  // named `*.terminal.spec.ts` (review IN-C-01), so a second one lands here by its name, not by
  // an exact file regex. `live` names the project as its `teardown`, which runs it LAST and also
  // when a `live` test failed (the declared CUT always does); `dependencies` would be the wrong
  // keyword, because a project whose dependency failed is skipped, and the checker reads a
  // skipped test as did-not-run (red). A file-filtered run of a `live` spec also runs the
  // teardown, so a touched-spec run passes `--no-deps`; a run of the fatal spec alone passes
  // `--project live-terminal`. `scripts/check-live-red-set.sh` refuses a full pass that holds no
  // test from the fatal spec, or ran it before another test ended (review WR-C-01), and
  // `liveProjects.source.test.ts` keeps this block and the reuse config's the same. Neither
  // project carries `launchOptions` (glPinConfig.test.ts: exactly one, the top-level pin above).
  projects: [
    {
      name: 'live',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: /\.terminal\.spec\.ts$/,
      teardown: 'live-terminal',
    },
    {
      name: 'live-terminal',
      use: { ...devices['Desktop Chrome'] },
      testMatch: /\.terminal\.spec\.ts$/,
    },
  ],
  webServer: [
    {
      // The npm script pre-builds; running the binary DIRECTLY (never a cargo
      // wrapper) keeps the process tree trivial for Playwright's teardown
      // tree-kill (T-20-12: no orphaned listener on 8787) and fails fast +
      // legibly if the pre-build was skipped (Pitfall 3).
      command: '../target/debug/examples/dev_render_server',
      // Live-verified: a plain GET on the WS route returns 400 (no upgrade
      // headers), which Playwright's readiness probe accepts
      // (2xx/3xx/400/401/402/403). The root path returns 404 - NOT accepted -
      // so the probe MUST hit /render exactly (Pitfall 2). Loopback only
      // (T-07-EXPOSE: the server itself asserts a 127.0.0.1 bind).
      url: 'http://127.0.0.1:8787/render',
      // Stateful server: NEVER reuse a stale, possibly-mutated instance - a
      // dev server mutated by manual testing must not masquerade as a cold
      // boot (Pitfall 7). An occupied port 8787 is a correct fail-fast.
      reuseExistingServer: false,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 60_000,
    },
    {
      // Bind explicitly to 127.0.0.1:5173 (strict) so the readiness probe
      // matches the actual bind - mirrors the mock config's webServer block.
      command: 'npm run dev -- --host 127.0.0.1 --port 5173 --strictPort',
      url: 'http://127.0.0.1:5173',
      // Vite is stateless: reusing a local dev server is safe (matches the
      // mock config); CI always spawns fresh.
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
