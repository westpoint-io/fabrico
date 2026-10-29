import { test, expect, type Page } from '@playwright/test';
import {
  CMD,
  buildPacket,
  expectExactlyOneFrame,
  mockRenderSocket,
  screenCellCentre,
  waitForChrome,
  type Harness,
  type InjectBelt,
  type InjectNode,
  waitForBoard,
} from './support/wire';

// delete-guard.spec.ts (REND-03, Phase 14-09; re-based on the CURRENT wire in
// 21-08) — the delete-with-in-flight-items guard proven at the UI edge.
//
// When a delete target still carries in-flight items, the guard dialog intercepts
// BEFORE any `Delete` command is issued and offers three choices. We drive the
// production UI through the same `page.routeWebSocket` harness as
// emits-command.spec.ts and assert the EMITTED GridCommand bytes (Delete = disc 1
// post the 17-02 renumber), never canvas pixels:
//   - the guard appears and sends NO command before a choice is made;
//   - Cancel       → ZERO Delete frames;
//   - Delete anyway → EXACTLY ONE disc-1 frame (core BELT-08 discards the items);
//   - Drain first   → EXACTLY ONE disc-1 frame, only AFTER the injected belt item
//                     count is drained to zero (passive poll via window.__fabrico).
//
// The "docked to the machine" read is the host-authoritative link graph now
// (gestures.beltDockedToNode matches belt.docks[].node — WR-02), so the fixture
// belt carries a REAL Tail dock naming the machine's handle, not an endpoint-cell
// coincidence. The drain is a UI-orchestrated wait (no stop-feed command): we
// simulate the belt draining by injecting diff packets that decrement its item
// count, and assert the "Draining… N left" indicator tracks it, then the single
// Delete fires.

/** A SOURCE at (12,8) with its catalog Out port (own cell, faces E). */
const MACHINE: InjectNode = {
  id: 1,
  kind: 0,
  cell_x: 12,
  cell_y: 8,
  ports: [{ index: 0, cell_x: 12, cell_y: 8, side: 1, role: 1 }],
};

/** A drawn belt Tail-docked to the machine's Out port, carrying `items`. */
const beltCarrying = (items: number): InjectBelt => ({
  id: 3,
  tiles: [
    [13, 8],
    [14, 8],
    [15, 8],
    [16, 8],
  ],
  itemCount: items,
  docks: [{ end: 'Tail', node: 1, port: 0 }],
});

/**
 * Inject a machine + an item-carrying docked belt, select the machine, and press
 * Delete — landing on the guard. Asserts the dialog appears and NO command was
 * sent yet. Returns the harness for the per-outcome assertions.
 */
async function openGuard(page: Page, items: number): Promise<Harness> {
  const h = await mockRenderSocket(page);
  await page.goto('/');
  await waitForChrome(page);
  await h.connected;

  h.inject(buildPacket({ nodes: [MACHINE], belts: [beltCarrying(items)] }));
  await waitForBoard(page, { machines: 1 });

  // Select the machine (click, no drag), then press Delete → the guard intercepts.
  const at = await screenCellCentre(page, MACHINE.cell_x, MACHINE.cell_y);
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.up();
  await page.keyboard.press('Delete');

  // The guard appeared; NO command was issued before a choice is made.
  await expect(page.locator('.fab-dialog-panel')).toBeVisible();
  await expect(page.locator('.fab-dialog-panel')).toContainText(
    'Delete with items still moving?',
  );
  await page.waitForTimeout(150);
  expect(h.sent.length, 'no command before a guard choice').toBe(0);
  return h;
}

test.describe('Delete guard intercepts a delete of an item-carrying element (REND-03)', () => {
  test('the guard appears and sends NO command before a choice', async ({ page }) => {
    await openGuard(page, 2);
    // openGuard already asserts the dialog + zero frames; nothing more to do.
  });

  test('WR-05: opening moves focus into the described dialog and traps Tab within it', async ({
    page,
  }) => {
    await openGuard(page, 2);

    const panel = page.locator('.fab-dialog-panel');
    // Focus moved INTO the dialog on open - the panel itself (tabIndex=-1), so no
    // destructive action is pre-selected. An AT user now lands on the labelled +
    // described alertdialog and cannot reach "Delete anyway" without perceiving
    // the data-loss warning.
    await expect(panel).toBeFocused();

    // The data-loss body is wired as the dialog's accessible description.
    await expect(panel).toHaveAttribute('aria-describedby', 'fab-delete-guard-desc');
    await expect(page.locator('#fab-delete-guard-desc')).toBeVisible();

    // Focus trap: Shift+Tab from the panel wraps to the LAST control (never
    // escaping to the chrome behind the modal); Tab from the last wraps to the
    // first.
    await page.keyboard.press('Shift+Tab');
    await expect(page.getByRole('button', { name: 'Delete anyway' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Cancel' })).toBeFocused();
  });

  test('Cancel issues NOTHING and closes the guard', async ({ page }) => {
    const h = await openGuard(page, 2);

    await page.getByRole('button', { name: 'Cancel' }).click();

    await expect(page.locator('.fab-dialog-panel')).toBeHidden();
    await page.waitForTimeout(150);
    expect(h.sent.length, 'Cancel emits zero Delete frames').toBe(0);
  });

  test('Delete anyway issues EXACTLY ONE Delete (disc 1)', async ({ page }) => {
    const h = await openGuard(page, 2);

    await page.getByRole('button', { name: 'Delete anyway' }).click();

    await expect.poll(() => h.sent.length).toBe(1);
    expect(h.sent[0][0], 'Delete discriminant').toBe(CMD.Delete);
    await page.waitForTimeout(150);
    expect(h.sent.length, 'no late duplicate frame').toBe(1);
  });

  test('a full keyframe mid-guard cancels the dialog and issues NOTHING (WR-06)', async ({
    page,
  }) => {
    const h = await openGuard(page, 2);

    // A host-initiated full:true keyframe (undo/redo/load fold) remints
    // handles from 0 — the guard's captured handle may now name a DIFFERENT
    // node, so the dialog must die with the keyframe like the selection does.
    h.inject(buildPacket({ nodes: [MACHINE], belts: [beltCarrying(2)], tick: 2 }));

    await expect(page.locator('.fab-dialog-panel')).toBeHidden();
    await page.waitForTimeout(150);
    expect(h.sent.length, 'a keyframe-cancelled guard emits no Delete').toBe(0);
  });

  test('a full keyframe mid-DRAIN stops the poll: zero-count must NOT fire a stale-handle Delete (WR-06)', async ({
    page,
  }) => {
    const h = await openGuard(page, 2);

    await page.getByRole('button', { name: 'Drain first' }).click();
    await expect(page.locator('.fab-dialog-panel')).toContainText('Draining');

    // The keyframe carries the belt already drained to zero. Without the
    // guard cancel, the drain zero-poll would immediately commitDelete
    // against the pre-keyframe handle — the wrong-target Delete T-21-08
    // closed for selection. The guard must close and NOTHING may emit.
    h.inject(buildPacket({ nodes: [MACHINE], belts: [beltCarrying(0)], tick: 2 }));

    await expect(page.locator('.fab-dialog-panel')).toBeHidden();
    await page.waitForTimeout(200);
    expect(h.sent.length, 'no Delete after a mid-drain keyframe').toBe(0);
  });

  test('Drain first waits for the belt to clear, THEN issues one Delete (disc 1)', async ({
    page,
  }) => {
    const h = await openGuard(page, 2);

    // Enter the passive drain (Cancel-only) state.
    await page.getByRole('button', { name: 'Drain first' }).click();
    await expect(page.locator('.fab-dialog-panel')).toContainText('Draining');
    // No Delete yet — the belt still carries items.
    expect(h.sent.length, 'no Delete while items remain').toBe(0);

    // Simulate the belt draining: decrement to 1, then to 0 (diff packets upsert
    // the same belt id). The "Draining… N left" indicator tracks the live count.
    h.inject(buildPacket({ belts: [beltCarrying(1)], full: false, tick: 2 }));
    await expect(page.locator('.fab-dialog-panel')).toContainText('1 left');
    expect(h.sent.length, 'still no Delete at 1 item').toBe(0);

    h.inject(buildPacket({ belts: [beltCarrying(0)], full: false, tick: 3 }));

    // Reaching zero issues EXACTLY ONE Delete and closes the guard.
    await expect.poll(() => h.sent.length).toBe(1);
    expect(h.sent[0][0], 'Delete discriminant').toBe(CMD.Delete);
    await expect(page.locator('.fab-dialog-panel')).toBeHidden();
    await page.waitForTimeout(150);
    expect(h.sent.length, 'no late duplicate frame after drain').toBe(1);
  });
});

// Phase 89 (plan 89-06, BELT-02, D-07, UI-SPEC A4): a SELECTED BELT carrying items, deleted by the
// Delete key, opens the same guard with the belt body copy, which names no internal handle and
// claims no stop of new items, and sends nothing until a choice; Delete anyway sends ONE Delete
// naming the belt. At the plan's start revision the key did nothing on a belt.
test.describe('Delete guard on a selected belt (BELT-02)', () => {
  test('a belt carrying items opens the guard with the belt body copy, and Delete anyway deletes the belt', async ({ page }) => {
    const h = await mockRenderSocket(page);
    await page.goto('/');
    await waitForChrome(page);
    await h.connected;

    h.inject(buildPacket({ nodes: [MACHINE], belts: [beltCarrying(2)] }));
    await waitForBoard(page, { machines: 1 });

    // Select the belt by a click on a middle tile (the mock answers no config query, so the
    // selection is read off the page rather than off the panel's body).
    const at = await screenCellCentre(page, 15, 8);
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    await page.mouse.up();
    await expect
      .poll(() => page.evaluate(() => (window as { __fabrico?: { selectedBelt(): number | null } }).__fabrico?.selectedBelt() ?? null))
      .toBe(3);
    await page.keyboard.press('Delete');

    const panel = page.locator('.fab-dialog-panel');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('Delete with items still moving?');
    await expect(page.locator('#fab-delete-guard-desc')).toHaveText(
      'This belt still carries 2 items. Deleting now discards them. Drain first waits until the belt is empty, then deletes.',
    );
    await page.waitForTimeout(150);
    expect(h.sent.length, 'no command before a guard choice').toBe(0);

    await page.getByRole('button', { name: 'Delete anyway' }).click();
    await expect.poll(() => h.sent.length).toBe(1);
    expect(Array.from(h.sent[0]), 'Delete{node: belt 3}').toEqual([CMD.Delete, 3]);
    await page.waitForTimeout(150);
    expect(h.sent.length, 'no late duplicate frame').toBe(1);
  });
});

// The DOM delete control (IX-04, 30-06): the discoverable trash button that
// appears glued to a selected machine's ring. It routes through the SAME
// gestures.requestDelete path as the keyboard Delete, so it MUST resolve to the
// identical guarded outcome — exactly one Delete (disc 1) when the machine is
// clear, and the DeleteGuardDialog (no immediate command) when items are still
// in flight. These cases prove there is no second, unguarded delete path
// originating in the React chrome (threat T-30-01).

/**
 * Inject a machine (optionally with an item-carrying docked belt), select it by
 * a plain click (no drag), and return the harness once the discoverable "Delete
 * machine" control is visible near the ring.
 */
async function selectMachineWithDeleteControl(
  page: Page,
  items: number,
): Promise<Harness> {
  const h = await mockRenderSocket(page);
  await page.goto('/');
  await waitForChrome(page);
  await h.connected;

  const belts = items > 0 ? [beltCarrying(items)] : [];
  h.inject(buildPacket({ nodes: [MACHINE], belts }));
  await waitForBoard(page, { machines: 1 });

  // Select the machine (click, no drag) — the DeleteControl mounts glued to the
  // ring, projected through the read-only window.__fabrico.camera().
  const at = await screenCellCentre(page, MACHINE.cell_x, MACHINE.cell_y);
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.up();

  // The discoverable control appears (accessible name "Delete machine").
  await expect(page.getByRole('button', { name: 'Delete machine' })).toBeVisible();
  return h;
}

test.describe('The DOM delete control shares the guarded requestDelete path (IX-04 / T-30-01)', () => {
  test('the control appears on selection and unmounts when the selection clears (IX-07)', async ({
    page,
  }) => {
    await selectMachineWithDeleteControl(page, 0);

    // Escape clears the selection (nothing armed) → the control unmounts.
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Delete machine' })).toBeHidden();
  });

  test('clicking it on a CLEAR machine emits EXACTLY ONE Delete (disc 1) — no guard, matching the keyboard path', async ({
    page,
  }) => {
    const h = await selectMachineWithDeleteControl(page, 0);

    // No in-flight items → requestDelete resolves straight to one commitDelete,
    // exactly like pressing Delete with a clear selection. No guard dialog.
    await page.getByRole('button', { name: 'Delete machine' }).click();

    await expectExactlyOneFrame(page, h, CMD.Delete);
    await expect(page.locator('.fab-dialog-panel')).toBeHidden();
  });

  test('clicking it with items IN FLIGHT opens the guard and emits NOTHING — identical to the keyboard Delete', async ({
    page,
  }) => {
    const h = await selectMachineWithDeleteControl(page, 2);

    // Items in flight → requestDelete defers to the guard; NO command yet.
    await page.getByRole('button', { name: 'Delete machine' }).click();

    await expect(page.locator('.fab-dialog-panel')).toBeVisible();
    await expect(page.locator('.fab-dialog-panel')).toContainText(
      'Delete with items still moving?',
    );
    await page.waitForTimeout(150);
    expect(h.sent.length, 'the DOM button emits no Delete before a guard choice').toBe(0);

    // And resolving the guard with "Delete anyway" emits the single Delete — the
    // same guarded outcome the keyboard path produces.
    await page.getByRole('button', { name: 'Delete anyway' }).click();
    await expectExactlyOneFrame(page, h, CMD.Delete);
  });
});
