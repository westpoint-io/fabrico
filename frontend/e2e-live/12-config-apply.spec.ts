import { test, expect } from '@playwright/test';
import {
  readScene,
  screenCellCentre,
  clickAt,
  pollScene,
  waitForAppReady,
  resetToDemo,
  armAndPlaceAt,
  nodeAtAnchor,
  selectMachineAt,
  watchPageErrors,
  expectRenderLoopAlive,
  type SceneFacts,
} from './support/oracle';
import { CONFIG_NOT_APPLIED_MARKER } from '../src/chrome/configCopy';

// 12-config-apply.spec.ts (CFG-01/02/03) — the config-authoring live gate.
//
// ────────────────────────────────────────────────────────────────────────────
// The e2e:live oracle is the browser + `dev_render_server` (real Core ->
// RenderProducer -> WS), the ONLY live harness in the repo (no tauri-driver /
// WebDriver is installed, and Playwright-WebKit will not launch on some Linux
// distributions). Chromium only.
//
// 40-05 UNBLOCK: the ConfigPanel's config-READ bridges — `machine_config`,
// `webhook_url`, `validate_factory_js` — were Tauri `invoke`-only (serviced by
// fabrico-app's tick-boundary control channel + `oneshot` reply, 39-06). Plan
// 40-05 added a dev-WS config-query request/reply verb (`transport_ws::decode_query`
// + a bounded reply channel) that re-frames the SAME `ControlMsg::Query*` seam onto
// the WebSocket, plus a dev-path `devWsInvoke` (`ConfigInvoke`) that App injects into
// the ConfigPanel on the dev transport. The config COMMIT still rides the EXISTING
// binary `GridCommand::Configure` gesture over `sendInput` (unchanged) — the bridge
// is READ/validate only. That closes the boundary the 4 round-trips below waited on,
// so the formerly-`test.fixme` blocks are now real, executed, green tests.
//
// NOTE on "byte-identical replay": full sim-state snapshot byte-identity
// (`replay_two_logs` + `snapshot()`) is the Rust HOST guarantee, certified in the
// host suite / Front 4. What a browser live test CAN prove — and asserts here — is
// the LIVE round-trip that DRIVES that certified path: the edit folds into the
// certified edit-log (canUndo flips), and the authored source read back through
// `machine_config` after the commit is byte-identical to what was typed (the config
// round-trips through the certified Configure path with zero drift).
//
// RENDER HEALTH (plan 85-01, the fabrico-model-oracle-blindspot rule). Every test here
// runs under `watchPageErrors`, installed in its describe's `beforeEach` before
// `page.goto`, and ends in an `afterEach` that asserts `expectRenderLoopAlive` and no
// uncaught page error. The oracle reads the MODEL, so a dead renderer would pass every
// model and DOM assertion below.
// ────────────────────────────────────────────────────────────────────────────

const KIND_FACTORY = 2;
// machine_kind::SOURCE = 0 (fabrico-protocol); the render NodeView kind is identity
// with machine_kind (the Factory match at 2 == machine_kind::FACTORY proves it).
const KIND_SOURCE = 0;

test.describe('CFG-01 live: real-app selection mounts the config panel (achievable frontend-only)', () => {
  let errs: ReturnType<typeof watchPageErrors>;
  test.beforeEach(async ({ page }) => {
    errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    // Shared-host isolation: start from the pristine demo baseline (LoadDemo, which now
    // resumes - CR-01) so a prior spec's leftover placements/config/Frozen state can't
    // shift the node this spec selects or stall the Configure fold.
    await resetToDemo(page);
  });
  test.afterEach(async ({ page }) => {
    await expectRenderLoopAlive(page, 'after the CFG-01 selection test');
    errs.assertNone('during the CFG-01 selection test');
  });

  test('selecting a Factory node mounts the ConfigPanel with the Factory kind heading (real chrome)', async ({
    page,
  }) => {
    // Drive the REAL app: read the live demo topology, click the demo Factory's
    // anchor cell (min-x/min-y of its footprint) through real pointer events — no
    // injected packet, no mock. The panel mounts on the same selectedNode gate as
    // DeleteControl.
    const scene = await readScene(page);
    const factory = scene.nodes.find((n) => n.kind === KIND_FACTORY);
    expect(factory, 'the demo scene has a Factory to select').toBeDefined();
    const minX = Math.min(...factory!.cells.map((c) => c[0]));
    const minY = Math.min(...factory!.cells.map((c) => c[1]));
    const anchor = await screenCellCentre(page, minX, minY);
    await clickAt(page, anchor.x, anchor.y);

    // The docked config panel mounts through the real app with the Factory kind
    // heading (KIND_NAMES) — the live proof that selection -> panel mount works
    // end-to-end (the 39-07 shell + the 39-08 App wiring), not just under vitest.
    const heading = page.getByRole('heading', { name: 'Factory' });
    await expect(heading, 'the ConfigPanel mounts with the Factory heading on live selection').toBeVisible({
      timeout: 10_000,
    });
  });

  test('deselecting unmounts the panel (no machine selected is the empty state)', async ({ page }) => {
    const scene = await readScene(page);
    const factory = scene.nodes.find((n) => n.kind === KIND_FACTORY);
    const minX = Math.min(...factory!.cells.map((c) => c[0]));
    const minY = Math.min(...factory!.cells.map((c) => c[1]));
    const anchor = await screenCellCentre(page, minX, minY);
    await clickAt(page, anchor.x, anchor.y);
    await expect(page.getByRole('heading', { name: 'Factory' })).toBeVisible({ timeout: 10_000 });

    // Press Escape (the shipped deselect) — the panel unmounts (empty state).
    await page.keyboard.press('Escape');
    await expect(
      page.getByRole('heading', { name: 'Factory' }),
      'deselecting unmounts the ConfigPanel',
    ).toBeHidden({ timeout: 10_000 });
  });
});

// ── UNBLOCKED by the 40-05 dev-WS config-query bridge (see the header). ──
// The plan's CFG-01/02/03 live acceptance criteria, now driven end-to-end through
// the real app + real Core over the dev WS.

/** Click a node's anchor cell (min-x/min-y of its footprint) through real pointer
 *  events to select it, exactly like the shipped Factory-selection tests above. */
async function selectNodeOfKind(page: import('@playwright/test').Page, kind: number) {
  const scene = await readScene(page);
  const node = scene.nodes.find((n) => n.kind === kind);
  expect(node, `the demo scene has a node of kind ${kind} to select`).toBeDefined();
  const minX = Math.min(...node!.cells.map((c) => c[0]));
  const minY = Math.min(...node!.cells.map((c) => c[1]));
  const anchor = await screenCellCentre(page, minX, minY);
  await clickAt(page, anchor.x, anchor.y);
  return node!;
}

/** The first board cell, scanning from the bottom row of the board's machines, with no
 *  machine or belt within two cells of it, so a Source placed there stands alone inside
 *  the fitted camera's view. */
function freeCellOn(scene: SceneFacts): [number, number] {
  const taken = new Set<string>();
  for (const n of scene.nodes) for (const [x, y] of n.cells) taken.add(`${x},${y}`);
  for (const b of scene.belts) for (const t of b.tiles) taken.add(`${t.cell_x},${t.cell_y}`);
  const xs = scene.nodes.flatMap((n) => n.cells.map((c) => c[0]));
  const ys = scene.nodes.flatMap((n) => n.cells.map((c) => c[1]));
  for (let y = Math.max(...ys); y >= Math.min(...ys); y -= 1) {
    for (let x = Math.min(...xs); x <= Math.max(...xs); x += 1) {
      let clear = true;
      for (let dy = -2; dy <= 2 && clear; dy += 1) {
        for (let dx = -2; dx <= 2 && clear; dx += 1) if (taken.has(`${x + dx},${y + dy}`)) clear = false;
      }
      if (clear) return [x, y];
    }
  }
  throw new Error('no free cell on the demo board for the placed Source');
}

test.describe('CFG-01/02 live: Factory JS edit -> Apply commits + replays byte-identical', () => {
  let errs: ReturnType<typeof watchPageErrors>;
  test.beforeEach(async ({ page }) => {
    errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    // Shared-host isolation: start from the pristine demo baseline (LoadDemo, which now
    // resumes - CR-01) so a prior spec's leftover placements/config/Frozen state can't
    // shift the node this spec selects or stall the Configure fold.
    await resetToDemo(page);
  });
  test.afterEach(async ({ page }) => {
    await expectRenderLoopAlive(page, 'after the Factory JS Apply test');
    errs.assertNone('during the Factory JS Apply test');
  });

  test('edit the CodeMirror editor and Apply -> a Configure folds into the certified edit-log (canUndo) and the authored source round-trips byte-identical', async ({
    page,
  }) => {
    // (1) Factory panel PRE-FILLS via machine_config over the dev WS: the CodeMirror
    // editor only renders once loadConfig resolves (config.kind === 'Factory'), so a
    // visible `.cm-content` is the live proof the WS machine_config bridge answered.
    await selectNodeOfKind(page, KIND_FACTORY);
    await expect(page.getByRole('heading', { name: 'Factory' })).toBeVisible({ timeout: 10_000 });
    const editor = page.locator('.cm-content');
    await expect(editor, 'the CodeMirror editor renders after machine_config pre-fills').toBeVisible({
      timeout: 10_000,
    });

    // Type a NEW, uniquely-identifiable valid handler into the live editor.
    const NEW_SOURCE = 'export default (payload) => payload;';
    await editor.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Delete');
    await page.keyboard.type(NEW_SOURCE);
    await expect(editor, 'the editor holds exactly the typed source').toHaveText(NEW_SOURCE);

    // The user edit marks the panel dirty (the not-applied marker, `CONFIG_NOT_APPLIED_MARKER`,
    // enables Apply).
    await expect(page.getByText(CONFIG_NOT_APPLIED_MARKER)).toBeVisible({ timeout: 5_000 });

    // (2) Apply gates on validate_factory_js (dev WS), then commits a Configure over
    // the EXISTING sendInput path. canUndo flips once the edit folds into the
    // certified edit-log (observed back through the render packet).
    await page.getByRole('button', { name: 'Apply' }).click();
    await pollScene(page, (s) => s.canUndo, {
      message: 'the Apply Configure folds into the certified edit-log (canUndo flips true)',
    }).toBe(true);
    await expect(page.getByText('Applied', { exact: true })).toBeVisible({ timeout: 10_000 });

    // Byte-identity through the certified path: re-select the Factory so the panel
    // remounts and re-pulls machine_config from the POST-commit core state. The
    // editor pre-fills with EXACTLY the authored source — the config round-tripped
    // through the certified Configure path with zero drift (full sim-state snapshot
    // byte-identity is the host-level guarantee, Front 4).
    await page.keyboard.press('Escape');
    await expect(page.getByRole('heading', { name: 'Factory' })).toBeHidden({ timeout: 10_000 });
    await selectNodeOfKind(page, KIND_FACTORY);
    const reread = page.locator('.cm-content');
    await expect(reread, 'the committed source reads back byte-identical over machine_config').toHaveText(
      NEW_SOURCE,
      { timeout: 10_000 },
    );
  });
});

test.describe('CFG-03 live: Source webhook URL copies through the real app', () => {
  let errs: ReturnType<typeof watchPageErrors>;
  test.beforeEach(async ({ page }) => {
    errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    // Shared-host isolation: start from the pristine demo baseline (LoadDemo, which now
    // resumes - CR-01) so a prior spec's leftover placements/config/Frozen state can't
    // shift the node this spec selects or stall the Configure fold.
    await resetToDemo(page);
  });
  test.afterEach(async ({ page }) => {
    await expectRenderLoopAlive(page, 'after the Source URL copy test');
    errs.assertNone('during the Source URL copy test');
  });

  test('select a Source -> the webhook URL row shows a loopback URL and Copy flips to "Copied"', async ({
    page,
  }) => {
    // RE-POINTED BY PLAN 85-01 (DEMO-08), NO ASSERTION WEAKENED. This test used to select
    // the DEMO's Source, which is on Timer: a Timer Source has no webhook door, so the
    // panel now correctly shows no URL row for it. The test moves onto a Source placed
    // from the palette (a fresh Source is on Webhook), and keeps every assertion it made
    // about the row and its Copy button. The Timer half is graded by
    // `85-timer-source-refuses-webhook.live.spec.ts`.
    const [sx, sy] = freeCellOn(await readScene(page));
    await armAndPlaceAt(page, 'Source', sx, sy);
    await pollScene(page, (s) => nodeAtAnchor(s, sx, sy)?.kind ?? -1, {
      message: `the palette Source was placed at (${sx},${sy})`,
    }).toBe(KIND_SOURCE);
    // Select it; its panel mounts SourceConfigBody -> WebhookUrlRow, which fetches the
    // bound URL via webhook_url over the dev WS.
    await selectMachineAt(page, sx, sy);
    await expect(page.getByRole('heading', { name: 'Source' })).toBeVisible({ timeout: 10_000 });

    // (3) The webhook URL row shows the bound LOOPBACK URL (host-formatted from the
    // real bound port threaded into the dev-WS query bridge).
    const urlValue = page.locator('span.fab-field', { hasText: 'http://127.0.0.1:' });
    await expect(urlValue, 'the webhook URL row renders the loopback URL').toBeVisible({
      timeout: 10_000,
    });
    await expect(urlValue).toContainText(/^http:\/\/127\.0\.0\.1:\d+\/hook\/src-/);

    // (4) Copy flips to "Copied" through the real button.
    const copyBtn = page.getByRole('button', { name: 'Copy' });
    await expect(copyBtn).toBeEnabled();
    await copyBtn.click();
    await expect(
      page.getByRole('button', { name: 'Copied' }),
      'Copy flips to Copied after a click',
    ).toBeVisible({ timeout: 5_000 });
  });
});
