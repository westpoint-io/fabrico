import { test, expect } from '@playwright/test';
import { waitForChromeAndTick } from './support/oracle';

// 12-welcome-card.spec.ts (ONB-01) - the first-run welcome-card gate.
//
// The welcome card is a SEPARATE first-run-gated surface (NOT the EmptyState
// machineCount===0 gate): on a fresh browser context (no localStorage flag) it
// shows ONCE over the non-empty demo boot, names the scene as a demo, and points
// at the "?" help. Dismissing it via "Start building" writes the versioned
// localStorage flag (fab.onboarding.seen.v1) so it NEVER nags again - proven here
// by a reload staying dismissed.
//
// Drive rules (mirrors 01/09): real app + real host, getByRole only, no injected
// state; the localStorage flag is the REAL persistence the shipped app writes.
// Playwright hands each test a fresh context (empty localStorage), so "first run"
// is the genuine cold state here.

test.describe('ONB-01 first-run welcome card (real app, localStorage-gated)', () => {
  test('shows once on first run naming the demo, then stays dismissed across a reload', async ({
    page,
  }) => {
    await page.goto('/');
    await waitForChromeAndTick(page);

    // First run (fresh context, no flag): the card is visible and names the demo.
    const heading = page.getByRole('heading', { name: 'Welcome to Fabrico' });
    await expect(heading, 'the first-run welcome card is visible on a cold context').toBeVisible();
    await expect(
      page.getByText('demo factory', { exact: false }),
      'the welcome card names the current scene as a demo',
    ).toBeVisible();

    // The card is a SEPARATE surface from EmptyState: the demo boot is non-empty,
    // yet the card still shows (it is first-run gated, not machineCount gated).
    // Dismiss it via the primary CTA.
    await page.getByRole('button', { name: 'Start building' }).click();
    await expect(
      heading,
      'clicking "Start building" dismisses the welcome card',
    ).toHaveCount(0);

    // The dismissal wrote the localStorage flag - prove it is the REAL persisted
    // signal the shipped app reads.
    const flag = await page.evaluate(() => localStorage.getItem('fab.onboarding.seen.v1'));
    expect(flag, 'dismissal persisted the versioned first-run flag').toBe('1');

    // Reload the SAME context: the flag persists, so the card must NOT re-show
    // (it never nags a returning user).
    await page.reload();
    await waitForChromeAndTick(page);
    await expect(
      page.getByRole('heading', { name: 'Welcome to Fabrico' }),
      'the welcome card stays dismissed after a reload (localStorage persists)',
    ).toHaveCount(0);
  });
});
