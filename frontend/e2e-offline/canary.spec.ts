import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, test } from '@playwright/test';
import { watchPageErrors } from '../e2e-embed/support/health.ts';

// The Firefox leg's proof that it runs with a reader's file policy. Playwright's Firefox profile
// relaxes security.fileuri.strict_origin_policy, and with it relaxed a file:// page can load the
// files beside it, which a reader's Firefox refuses. The offline projects set the pref back; this
// page asks for a sibling module script and a sibling JSON file, and both must be refused. The
// offline tests in Firefox depend on this one, so they don't run when it fails.

const CANARY_URL = pathToFileURL(fileURLToPath(new URL('./canary/canary.html', import.meta.url))).href;

test('a file:// page can load neither a sibling module script nor a sibling fetch', async ({ page }) => {
  const errors = watchPageErrors(page);
  await page.goto(CANARY_URL);
  await page.waitForFunction(() => (window as { __canary?: unknown }).__canary !== undefined, null, { timeout: 10_000 });
  const canary = await page.evaluate(() => (window as unknown as { __canary: { module: boolean; fetch: boolean } }).__canary);
  console.log(`file policy canary: module loaded=${canary.module}, fetch loaded=${canary.fetch}`);
  expect(canary, 'both sibling files are refused under the stock file:// policy').toEqual({ module: false, fetch: false });
  errors.assertNone('on the canary page');
});
