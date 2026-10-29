import { test, expect, type Page } from '@playwright/test';
import { expectRenderLoopAlive, waitForAppReady, watchPageErrors } from './support/oracle';

// 14-demo-badge.spec.ts (ONB-01) - the "Demo scene" badge + the getByRole
// stability guard.
//
// The boot loads the demo (LIVE-01), so a passive "Demo scene" badge is visible
// in the toolbar telling the user they are looking at the demo, not a live/saved
// factory. The badge is a READOUT (no button role, --fab-ink, never the accent).
//
// This spec ALSO re-asserts every pre-existing toolbar accessible name (Phase 32
// lesson, threat T-34-NAME): the two new controls ("Help", "Demo scene") must be
// ADD-ONLY - renaming an existing control silently breaks the live getByRole
// gate the whole suite depends on. Guarding the names here fails loudly if a
// future edit destabilises one.
//
// Drive rules (mirrors 01/09): real app + real host, getByRole/getByText only,
// nothing injected.
//
// Phase 91, plan 91-10 (CHROME-15, D-14, UI-SPEC 5.4): the badge moved from the toolbar row's
// brand cluster into the status strip under the toolbar's right end, beside `Unsaved`, where it
// reads whole. The by-text read below holds; a second read locates it by its stable attribute
// inside the strip, so a badge back in the row reddens here. Render health added with it
// (fabrico-model-oracle-blindspot).

/** Assert an existing toolbar button's accessible name still resolves (no rename). */
async function expectButton(page: Page, name: string): Promise<void> {
  await expect(
    page.getByRole('button', { name, exact: true }),
    `existing toolbar control "${name}" still resolves by role+name (no rename)`,
  ).toBeVisible();
}

test.describe('ONB-01 "Demo scene" badge + toolbar name stability (real app)', () => {
  test('the badge is visible on cold boot and every existing toolbar name is intact', async ({
    page,
  }) => {
    const errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);

    // The passive badge shows on the demo boot.
    await expect(
      page.getByText('Demo scene', { exact: true }),
      'the "Demo scene" badge is visible while the demo scene is loaded (cold boot)',
    ).toBeVisible();
    // Plan 91-10: and it is the scene badge inside the status strip, its title the full name.
    const badge = page.locator('header [data-fab-status-strip] [data-fab-scene-badge]');
    await expect(badge, 'the scene badge sits in the status strip (UI-SPEC 5.4)').toHaveText('Demo scene');
    await expect(badge, 'its title is the full scene name').toHaveAttribute('title', 'Demo scene');

    // The badge is a passive readout, NOT a button (no accidental affordance).
    // Exact match so it does not collide with the "Load demo scene" popover entry
    // (55-02 relocated that CTA behind the "Examples" trigger; the badge copy and
    // this assertion are byte-unchanged, which is the point of the exact match).
    await expect(
      page.getByRole('button', { name: 'Demo scene', exact: true }),
      'the "Demo scene" badge is a passive readout, not a button',
    ).toHaveCount(0);

    // Name-stability guard: the transport toggle (boots playing -> "Pause") plus
    // every other pre-existing control must still resolve by its accessible name.
    await expect(
      page.getByRole('button', { name: /^(Play|Pause)$/ }),
      'the transport toggle still resolves (Play/Pause name intact)',
    ).toHaveCount(1);
    // 'Examples' replaces 'Load demo scene' here: 55-02 moved the demo CTA into
    // the Examples popover, so the TOOLBAR-level name to guard is the disclosure
    // trigger. The relocated entry's own name is guarded where it now lives
    // (frontend/e2e/quit-guard.spec.ts, the EX-02 popover describe).
    // 'Names' replaces 'Labels' here: plan 76-03 (D-09) renamed the machine-name toggle
    // once labels became notes with words of their own.
    for (const name of ['Step', 'Undo', 'Redo', 'Legend', 'Names', 'Save', 'Load', 'Examples']) {
      await expectButton(page, name);
    }

    // The one new interactive control is additive and stable.
    await expectButton(page, 'Help');

    await expectRenderLoopAlive(page, 'the demo boot with its badge');
    errs.assertNone('the demo badge and toolbar names');
  });
});
