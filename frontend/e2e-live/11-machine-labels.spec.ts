import { test, expect } from '@playwright/test';
import { PNG } from 'playwright-core/lib/utilsBundle';
import { cameraOf, captureClip, expectRenderLoopAlive, readScene, waitForAppReady, watchPageErrors } from './support/oracle';
import { KIND_NAMES } from '../shared/kindNames';
import { CELL, INSET } from '../shared/geometry';

// 11-machine-labels.spec.ts (READ-01) - the LIVE proof that machine names reveal
// on demand and the legend key opens, driven end-to-end against the REAL host
// (real dev_render_server boot -> shipped decoder -> window.__fabrico.scene()),
// never injected packets. It exercises the shipped chrome + the read-only camera
// anchor: the Alt-hold (Factorio alt-mode) AND the persistent Names toggle (named Labels until plan 76-03) both
// reveal a kind-name chip over EVERY machine, the collapsible Legend panel opens
// from its toolbar button, and a lost-focus Alt never sticks the labels on
// (RESEARCH Pitfall 4). If the KIND_NAMES single source, the rAF anchor, the App
// wiring, or the stable accessible names regress, this gate fails.
//
// Drive rules (live suite, locked): real pointer/keyboard events only; every
// wait is an expect assertion on a specific DOM/model fact (no fixed sleeps);
// readiness resolves via the stable getByRole('button', name 'Place Factory') in
// waitForAppReady (never a volatile getByTitle). The expected chip strings are
// DERIVED from the shipped `KIND_NAMES` map through the GATE-01 shared values
// directory, so the live suite stays zero-mock (see the block below).

test.describe.configure({ mode: 'serial' });

/** A label's kind byte (`machine_kind::LABEL`). */
const KIND_LABEL = 11;

// ══════════════════════ WIDENED AT 72-13 (ruling R-85, handed on by 72-09's R-62) ═══════
//
// WHAT WAS HERE, AND WHY IT HAD TO GO. A LOCAL array literal of the eight kind names,
// walked at `:67-68` by a PRESENCE-ONLY check ("each one is visible as a legend row").
// Plan 72-10 added a Route row and an HTTP Handler row to the Legend. Neither addition
// would have reddened this file - a presence check over a list of eight cannot notice a
// ninth or a tenth - so this spec would have SILENTLY STOPPED COVERING the legend's
// membership while staying green forever.
//
// A CHECK THAT QUIETLY STOPS COVERING WHAT IT WAS NAMED FOR IS THE SAME DEFECT CLASS AS
// ONE THAT CANNOT FAIL, and this phase must not close having created one. So the list is
// DERIVED from the shipped map and the assertion is EXACT: every name the app can put on
// a machine must appear in the Legend exactly once, and an eleventh kind added with no
// Legend row reddens this file the day it lands.
//
// THE IMPORT IS GATE-01 AND DOES NOT COST THE ZERO-MOCK AUDIT. `shared/kindNames.ts`
// lives OUTSIDE `src/` for exactly this reason, following `shared/geometry.ts` verbatim:
// a dependency-free VALUES module, no Pixi, no React, no product logic. The live suite
// still imports no mock packet builder, no WS route-mocking helper and no product source
// - and both suites now assert against the same strings, which strengthens the audit
// rather than weakening it. `src/chrome/kindNames.ts` re-exports this module, so there is
// still exactly ONE name table; `kindNames.test.ts` locks its byte keys against
// `machine_kind` in the same run.
// PHASE 92 (CHROME-12, D-03, UI-SPEC 1.2): every name, the Label's (kind 11) INCLUDED. Phase 76
// left the Label out on purpose ("no Legend row and no Help row for labels in this phase") and
// asserted its absence here; walk-112 then read the Legend as not listing every thing a user can
// place, so the Legend now has a row for every palette entry that lands on the board, and this
// list derives from the whole map with no exclusion.
const LABEL_KIND = 11;
const LEGEND_KIND_NAMES = Object.values(KIND_NAMES);
const SOURCE_NAME = 'Source';
const LEGEND_PANEL = '#fab-legend-panel';

test.describe('READ-01 live: Alt-hold + toggle reveal machine names; the Legend panel opens', () => {
  // RENDER HEALTH in every test (plan 85-08, THE RENDER-HEALTH COUNT;
  // fabrico-model-oracle-blindspot): the watcher goes in BEFORE `page.goto`, and the loop
  // and the watcher are read after every test.
  let errs: ReturnType<typeof watchPageErrors>;

  test.afterEach(async ({ page }) => {
    await expectRenderLoopAlive(page, 'at the end of the test');
    errs.assertNone('the machine-names walk');
  });

  test.beforeEach(async ({ page }) => {
    errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
  });

  test('the Legend + Names toolbar buttons expose stable roles and start closed/off', async ({
    page,
  }) => {
    const legendBtn = page.getByRole('button', { name: 'Legend' });
    const labelsBtn = page.getByRole('button', { name: 'Names' });
    await expect(legendBtn, 'the Legend button resolves by its stable accessible name').toBeVisible();
    await expect(labelsBtn, 'the Names button resolves by its stable accessible name (renamed from Labels by plan 76-03, D-09)').toBeVisible();
    // Closed/off by default: zero permanent screen cost.
    await expect(legendBtn).toHaveAttribute('aria-expanded', 'false');
    await expect(labelsBtn).toHaveAttribute('aria-pressed', 'false');
    // The two new buttons did NOT destabilise the readiness accessible name.
    await expect(
      page.getByRole('button', { name: 'Place Factory' }),
      'the readiness getByRole name is unchanged by the new buttons',
    ).toBeVisible();
  });

  test('the Legend toggle opens a panel with an <h2> heading and every kind row', async ({
    page,
  }) => {
    const legendBtn = page.getByRole('button', { name: 'Legend' });
    // Closed by default -> the panel is not in the DOM.
    await expect(page.locator(LEGEND_PANEL)).toBeHidden();

    await legendBtn.click();
    await expect(legendBtn).toHaveAttribute('aria-expanded', 'true');
    const panel = page.locator(LEGEND_PANEL);
    await expect(panel).toBeVisible();
    // A real <h2> "Legend" (heading nav, no skipped level under the Toolbar <h1>).
    await expect(panel.getByRole('heading', { level: 2, name: 'Legend' })).toBeVisible();
    // EXACT MEMBERSHIP, DERIVED. Every name in the shipped map appears as a legend row,
    // and appears EXACTLY ONCE. `toHaveCount(1)` rather than `toBeVisible()` is the
    // exactness: a duplicated row (the shape 72-09 found live in `chromeDpr.tsx`, where a
    // derived list would have grown correctly and produced a duplicate) is a defect this
    // now catches, and a derived list is only safe when what it derives is what the gate
    // needs.
    expect(
      LEGEND_KIND_NAMES.length,
      'the derivation is non-empty: an empty map would satisfy the loop below vacuously',
    ).toBeGreaterThan(8);
    // The Label is in the derived list, so the loop below requires its row (phase 92, D-03).
    expect(KIND_NAMES[LABEL_KIND], 'kind 11 is the Label').toBe('Label');
    expect(LEGEND_KIND_NAMES, 'the derived list carries the Label').toContain('Label');
    for (const name of LEGEND_KIND_NAMES) {
      await expect(
        panel.getByText(name, { exact: true }),
        `RED-FIRST CHROME-12-live: the Legend names "${name}" exactly once`,
      ).toHaveCount(1);
    }

    // Toggling again closes it (aria-expanded flips back, panel leaves the DOM).
    await legendBtn.click();
    await expect(legendBtn).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator(LEGEND_PANEL)).toBeHidden();
  });

  test('the Names toggle reveals a name chip over every machine, then hides them', async ({
    page,
  }) => {
    const labelsBtn = page.getByRole('button', { name: 'Names' });
    const chips = page.getByTestId('machine-label');
    // Canvas is clean by default: no chips.
    await expect(chips).toHaveCount(0);

    await labelsBtn.click();
    await expect(labelsBtn).toHaveAttribute('aria-pressed', 'true');

    // One chip per MACHINE. Belts are not nodes, and since plan 85-08 the demo also carries
    // section LABELS (kind 11), which are notes on the board, not machines: a label shows its
    // own words and gets no name chip. So the count is the nodes that are not labels, and the
    // demo is asserted to carry labels, so the exclusion is never vacuous.
    const nodes = (await readScene(page)).nodes;
    const machineCount = nodes.filter((n) => n.kind !== KIND_LABEL).length;
    expect(machineCount, 'the demo scene has machines to label').toBeGreaterThan(0);
    expect(nodes.length - machineCount, 'NON-VACUITY: the demo carries section labels too').toBeGreaterThan(0);
    await expect(chips).toHaveCount(machineCount);

    // Single-source proof: the demo SOURCE node's chip reads exactly 'Source'
    // (the KIND_NAMES value), so the canvas label shares the Palette/Legend map.
    await expect(
      chips.filter({ hasText: SOURCE_NAME }).first(),
      'the SOURCE machine chip reads its KIND_NAMES name',
    ).toBeVisible();

    // ANCHORED AT FIT (phase 91, plan 91-09, CHROME-08): every machine has a chip centred on its
    // top edge and sitting 4 px above it (`MachineLabels.tsx`), read from the model and the
    // camera, so moving the layer under the chrome (zIndex 1) moved no chip.
    const cam = await cameraOf(page);
    const boxes = await chips.evaluateAll((els) =>
      els.map((el) => {
        const r = el.getBoundingClientRect();
        return { cx: r.left + r.width / 2, bottom: r.bottom, left: r.left, top: r.top, right: r.right, kind: Number(el.dataset.kind) };
      }),
    );
    const unanchored: string[] = [];
    for (const n of nodes.filter((m) => m.kind !== KIND_LABEL)) {
      const minX = Math.min(...n.cells.map((c) => c[0]));
      const maxX = Math.max(...n.cells.map((c) => c[0]));
      const minY = Math.min(...n.cells.map((c) => c[1]));
      const cx = (minX + (maxX - minX + 1) / 2) * CELL * cam.scale + cam.x;
      const top = (minY * CELL + INSET) * cam.scale + cam.y;
      const hit = boxes.find((b) => b.kind === n.kind && Math.abs(b.cx - cx) <= 1 && Math.abs(b.bottom - (top - 4)) <= 1);
      if (hit === undefined) unanchored.push(`kind ${n.kind} at (${minX},${minY}) wants cx=${cx.toFixed(1)} bottom=${(top - 4).toFixed(1)}`);
    }
    expect(unanchored, 'every machine chip is anchored over its machine at Fit').toEqual([]);

    // DRAWN OVER THE BOARD: a chip clear of every panel paints, read by pixels with the tag layer
    // hidden (an injected rule; each chip writes its own inline visibility), so zIndex 1 left the
    // tags above the board.
    const panels = await page.evaluate(() =>
      Array.from(document.querySelectorAll('aside, header')).map((el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      }),
    );
    const open = boxes.find((b) => panels.every((q) => b.right < q.left || b.left > q.right || b.bottom < q.top || b.top > q.bottom));
    expect(open, 'NON-VACUITY: a chip sits clear of every panel at Fit').toBeDefined();
    const clip = { x: Math.floor(open!.left), y: Math.floor(open!.top), width: Math.ceil(open!.right - open!.left), height: Math.ceil(open!.bottom - open!.top) };
    const withTags = PNG.sync.read(await captureClip(page, clip));
    await page.evaluate(() => {
      const el = document.createElement('style');
      el.id = 'fab-test-hide-tags';
      el.textContent = '[data-testid="machine-label"] { visibility: hidden !important; }';
      document.head.appendChild(el);
    });
    const without = PNG.sync.read(await captureClip(page, clip));
    await page.evaluate(() => document.getElementById('fab-test-hide-tags')?.remove());
    let worst = 0;
    for (let i = 0; i < withTags.data.length; i += 4) {
      for (let c = 0; c < 3; c += 1) worst = Math.max(worst, Math.abs(withTags.data[i + c] - without.data[i + c]));
    }
    console.log(`P91-CHROME-08 live chip clip=${JSON.stringify(clip)} worst=${worst}`);
    expect(worst, 'the chip clear of every panel is drawn over the board').toBeGreaterThan(24);

    // Toggling off clears the canvas again.
    await labelsBtn.click();
    await expect(labelsBtn).toHaveAttribute('aria-pressed', 'false');
    await expect(chips).toHaveCount(0);
  });

  test('holding Alt reveals chips, releasing hides them, and a lost-focus blur resets a stuck Alt', async ({
    page,
  }) => {
    const chips = page.getByTestId('machine-label');
    await expect(chips).toHaveCount(0);

    // Alt-hold (Factorio alt-mode) reveals every machine's name at once.
    await page.keyboard.down('Alt');
    await expect(chips.first(), 'holding Alt reveals the machine name chips').toBeVisible();
    await page.keyboard.up('Alt');
    await expect(chips, 'releasing Alt hides the chips').toHaveCount(0);

    // Pitfall 4: a held Alt that loses focus (Alt+Tab / OS menu steal) must not
    // stick the labels on. Simulate the focus loss with a window blur and prove
    // the Alt-held reveal resets even though keyup never fired.
    await page.keyboard.down('Alt');
    await expect(chips.first(), 'Alt is held again').toBeVisible();
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await expect(chips, 'a window blur resets the stuck Alt reveal').toHaveCount(0);
    // Release the (already-reset) Alt to leave a clean keyboard state.
    await page.keyboard.up('Alt');
  });
});
