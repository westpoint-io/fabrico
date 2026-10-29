import { test, expect, type Page } from '@playwright/test';
import {
  buildPacket,
  mockRenderSocket,
  screenCellCentre,
  waitForChrome,
  type InjectNode,
  waitForBoard,
} from './support/wire';

// factory-editor-height.spec.ts (FEEL-01, Phase 44-01) - the regression lock for
// finding F4 of a live WebKitGTK FEEL pass: selecting a Factory node showed
// the ConfigPanel "Factory" heading + Apply/Revert but an EMPTY body, because the
// CodeMirror editor had no definite height (its rendered height depended on flex
// cross-axis stretch of a nested flex child, which Blink performs and WebKitGTK
// collapses toward 0px, after which the host's overflow hidden clipped it).
//
// This is the FIRST spec ever to mount the Factory editor path in the mock
// chromium suite - the coverage gap that let F4 ship. It pins the Fork E
// contract (D-01): the host has a DEFINITE height of clamp(180px, 40vh, 480px),
// the editor fills it (fabTheme '&' height 100%), and long sources scroll
// INSIDE it (.cm-scroller overflow auto). Asserting >= 180 (the clamp floor) is
// strictly stronger than > 0 and viewport-safe: Desktop Chrome's 720px viewport
// yields 40vh = 288, so clamp resolves to 288 there and never below 180.
//
// NOTE (per 44-RESEARCH): on Chromium the pre-fix editor DID stretch, so this
// spec is regression-lock coverage, not a bug reproduction - the bug only
// reproduces on WebKitGTK, which has no automated runner in this suite. The
// WebKitGTK half is a milestone-end re-FEEL by hand on the rebuilt binary.

/** A FACTORY node at (12,8) - machine_kind.FACTORY = 2 (src/protocol/kinds.ts). */
const FACTORY: InjectNode = { id: 7, kind: 2, cell_x: 12, cell_y: 8 };

/**
 * Drive the one FEEL-01 path end-to-end: mocked dev socket -> injected Factory
 * node -> click-select (no drag, the delete-guard precedent) -> ConfigPanel ->
 * answered machine_config dev-WS query -> mounted FactoryConfigBody. Asserts the
 * heading FIRST so a hang points at the query bridge, not the click.
 */
async function openFactoryPanel(page: Page): Promise<void> {
  // Suppress the first-run WelcomeCard: the reuse config lacks the main
  // config's storageState onboarding seed (harmless duplicate under the main
  // config, where storageState already sets it).
  await page.addInitScript(() => localStorage.setItem('fab.onboarding.seen.v1', '1'));

  // Mock BEFORE goto (routeWebSocket must register pre-navigation), answering
  // the machine_config query the ConfigPanel's dev-WS bridge awaits - without
  // a reply the panel hangs in "Loading config..." and FactoryConfigBody never
  // mounts. The reply mirrors the frozen MachineConfig TS shape
  // (src/protocol/decode.ts): { kind: 'Factory', source: string }.
  const h = await mockRenderSocket(page, {
    answerQuery: (verb) =>
      verb === 'machine_config'
        ? { kind: 'Factory', source: 'export default (payload) => payload;' }
        : undefined,
  });
  await page.goto('/');
  await waitForChrome(page);
  await h.connected;

  h.inject(buildPacket({ nodes: [FACTORY] }));
  await waitForBoard(page, { machines: 1 });

  // Select the Factory (click, no drag), projected through the live camera.
  const at = await screenCellCentre(page, FACTORY.cell_x, FACTORY.cell_y);
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.up();

  // Heading first: proves the answerQuery bridge resolved machine_config.
  await expect(page.getByRole('heading', { name: 'Factory' })).toBeVisible({
    timeout: 10_000,
  });
}

test.describe('Factory editor renders at a definite height (FEEL-01 / F4)', () => {
  test('selecting a Factory node mounts the ConfigPanel with the Factory heading (the answered machine_config bridge)', async ({
    page,
  }) => {
    await openFactoryPanel(page);
  });

  test('the CodeMirror editor renders at the clamp floor: boundingBox height >= 180', async ({
    page,
  }) => {
    await openFactoryPanel(page);

    const box = await page.locator('.cm-editor').boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(180);
  });

  test('long sources scroll INSIDE the fixed-height editor: .cm-scroller overflowY is auto', async ({
    page,
  }) => {
    await openFactoryPanel(page);

    // overflowY rather than the shorthand: robust to computed-value
    // serialization across engines.
    const overflowY = await page
      .locator('.cm-scroller')
      .evaluate((el) => getComputedStyle(el).overflowY);
    expect(overflowY).toBe('auto');
  });
});
