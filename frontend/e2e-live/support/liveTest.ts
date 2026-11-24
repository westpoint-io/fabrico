import { test as base } from '@playwright/test';
import type { Page } from '@playwright/test';
import { expectRenderLoopAlive, watchPageErrors } from './oracle';

// liveTest.ts - the shared `test` every live spec imports (phase 112, D-06a and D-07).
//
// It overrides the built-in `page` fixture:
//   - Before the test (and before any `beforeEach` that uses `page`), it starts collecting page
//     errors and failed render packets with `watchPageErrors`.
//   - After a test that passed, on a page still showing the app, it checks the render loop once
//     with `expectRenderLoopAlive` (the held-board form when the transport offers Play), then
//     asserts no page error happened over the whole test. A failure there throws and fails the
//     test, naming the test rather than a gesture.
//   - When FABRICO_LIVE_COVERAGE is set, it records JS coverage for the page and adds it to a
//     monocart-coverage-reports reading. That branch is a local reading only: CI never sets the
//     variable, and the package is loaded with a dynamic import inside the branch.
//
// Why override `page` instead of adding an auto fixture: a spec that takes no `page` (the legs of
// 77-one-board-all-five drive a page made in `beforeAll`) never builds this fixture, so it adds no
// check to a page it cannot see. Such a spec keeps its own render-health hooks and calls
// startLiveCoverage / stopLiveCoverage itself.
//
// A spec that stops the sim on purpose and checks the held board itself can turn the end check
// off with `test.use({ renderHealthAtEnd: false })`.
//
// Everything else from '@playwright/test' is re-exported, so a spec swaps only its import path.
// A module's own export wins over a star re-export, so `test` here is this one.

export * from '@playwright/test';

/** The coverage label for this run ('before', 'after', ...), or undefined for a plain run. */
const COVERAGE_LABEL = process.env.FABRICO_LIVE_COVERAGE;

/** The live app's origin (both live configs' baseURL). */
const APP_ORIGIN = 'http://127.0.0.1:5173';

/** How long the end check waits for the transport button before failing the test. */
const TRANSPORT_READ_TIMEOUT_MS = 5_000;

/** The monocart-coverage-reports options for one reading, shared by every add() and generate(). */
export function liveCoverageOptions(label: string) {
  return {
    name: `live suite ${label}`,
    outputDir: `./coverage-live/${label}`,
    reports: ['v8-json', 'console-summary'],
    // First matching pattern wins, so the exclusions come before the app source.
    entryFilter: {
      '**/node_modules/**': false,
      '**/@vite/**': false,
      '**/@react-refresh**': false,
      '**/src/**': true,
    },
    sourceFilter: {
      '**/node_modules/**': false,
      '**/src/**': true,
    },
  };
}

/** Start JS coverage on `page` when a coverage reading was asked for; otherwise do nothing. */
export async function startLiveCoverage(page: Page): Promise<void> {
  if (!COVERAGE_LABEL || page.isClosed()) return;
  await page.coverage.startJSCoverage({ resetOnNavigation: false });
}

/** Stop JS coverage on `page` and add it to the reading; does nothing on a plain run. */
export async function stopLiveCoverage(page: Page): Promise<void> {
  if (!COVERAGE_LABEL || page.isClosed()) return;
  const entries = await page.coverage.stopJSCoverage();
  const { MCR } = await import('monocart-coverage-reports');
  await MCR(liveCoverageOptions(COVERAGE_LABEL)).add(entries);
}

export const test = base.extend<{ renderHealthAtEnd: boolean }>({
  renderHealthAtEnd: [true, { option: true }],
  page: async ({ page, renderHealthAtEnd }, use, testInfo) => {
    await startLiveCoverage(page);
    const errs = watchPageErrors(page);
    try {
      await use(page);
      // `status === 'passed'` rather than a comparison with the expected status, so a skipped
      // test is not checked and a failed one keeps its own message.
      if (
        testInfo.status === 'passed' &&
        renderHealthAtEnd &&
        !page.isClosed() &&
        page.url().startsWith(APP_ORIGIN)
      ) {
        const transport = page.getByRole('button', { name: /^(Play|Pause)$/ });
        const label = await transport.getAttribute('aria-label', { timeout: TRANSPORT_READ_TIMEOUT_MS });
        await expectRenderLoopAlive(page, 'at the end of the test', { boardHeld: label === 'Play' });
        errs.assertNone('over the whole test');
      }
    } finally {
      await stopLiveCoverage(page);
    }
  },
});
