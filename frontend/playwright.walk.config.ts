import { defineConfig, devices, type ReporterDescription } from '@playwright/test';

/** The caller owns the host and Vite: `FABRICO_WALK_REUSE=1`. A restricted shell kills servers Playwright spawns. */
const WALK_REUSE = process.env.FABRICO_WALK_REUSE === '1';

/**
 * `FABRICO_WALK_SHARD=<i>/<n>` runs shard i of n and adds a blob report, which CI's walk verdict
 * job merges with the other shards' blobs before `scripts/check-walk-report.sh` reads the result.
 * It is an environment variable rather than `--shard` so that the `e2e:walk` script and its CI run
 * line stay the same whole command. Unset or empty, the walk runs whole with no blob report, as it
 * does on a developer's machine. Any other value stops the config here: a typo must not quietly run
 * the whole walk on one leg and the same whole walk again on the next.
 */
function walkShard(raw: string | undefined): { current: number; total: number } | undefined {
  if (raw === undefined || raw === '') return undefined;
  const match = /^([1-9][0-9]*)\/([1-9][0-9]*)$/.exec(raw);
  const current = match ? Number(match[1]) : NaN;
  const total = match ? Number(match[2]) : NaN;
  if (!match || total < 2 || current > total) {
    throw new Error(
      `FABRICO_WALK_SHARD is '${raw}'; it must be <i>/<n> in whole numbers with n at least 2 and i from 1 to n, or unset for the whole walk`,
    );
  }
  return { current, total };
}

const WALK_SHARD = walkShard(process.env.FABRICO_WALK_SHARD);

// The JSON report is what scripts/check-walk-report.sh reads, because this run exits 0 on a skipped
// test. A shard also writes blob-report/report-<i>.zip, which Playwright empties at the start of
// each run, so a blob left by an earlier run can't be merged as this one.
const REPORTERS: ReporterDescription[] = [
  ['list'],
  ['json', { outputFile: 'test-results/walk-report.json' }],
  ...(WALK_SHARD ? [['blob'] as const] : []),
];

// Playwright config for the lesson walk: the real dev_render_server plus the real Vite app, as
// the live suite runs them, over files named *.walk.ts only. It is a separate config because the
// live suite overruns its CI limit, so a lesson test there could sit among the tests that never
// start. The live projects use Playwright's default .spec and .test names, so neither live config
// picks these files up and none of them counts toward the live suite's test floor.
//
// Run via `npm run e2e:walk`, which builds both Rust examples first. CI runs it as three legs, each
// with FABRICO_WALK_SHARD set (see walkShard above).
export default defineConfig({
  testDir: './e2e-live',
  testMatch: /\.walk\.ts$/,
  timeout: 90_000,
  // A ceiling on one run, so a wedged browser ends in a written report instead of a runner killed
  // at the CI job's limit. CI runs the walk as three shards split by whole file, and the slowest is
  // lesson-variants.walk.ts alone, which took 26.2 minutes of CI run 42083745921, at 25 tests. Doubled
  // and rounded up, that is 55 minutes. The CI job's limit is 70: these 55 plus 15 for the build. At
  // 27 tests, run unthrottled on one machine, that file took 354 s against 383 s at 25, which scales
  // to about 24.2 CI minutes, 49 doubled, so 55 stands until a recorded CI run of 27 tests replaces it.
  globalTimeout: 55 * 60_000,
  // One mutable host process is shared by every test, so a shard runs its files one at a time and
  // a file never splits across shards.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: REPORTERS,
  ...(WALK_SHARD ? { shard: WALK_SHARD } : {}),
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
