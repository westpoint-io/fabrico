import { test, expect, type Page } from '@playwright/test';
import {
  buildPacket,
  mockRenderSocket,
  screenCellCentre,
  waitForBoard,
  waitForChrome,
  type Harness,
  type InjectNode,
} from './support/wire';
import { encodeGridCommand, type MachineConfig } from '../src/protocol/decode';
import { CONFIG_NOT_APPLIED_MARKER } from '../src/chrome/configCopy';

// field-typing.spec.ts (phase 91 review WR-B-01, CR-B-01, T-91-24, UF-91-02) - the timer `Every`
// field and the Router `At byte` field, typed one key at a time in a real browser, and pasted.
//
// WHAT WAS BROKEN. Both fields became `type="text"` in plan 91-08 (CHROME-14, D-08) and both are
// controlled inputs that showed the SANITIZED number after every change, so a key that made the
// text not yet a whole number was put back under the caret: `12.7` typed key by key read `127`
// (the point was dropped at `12.` and the `7` appended), `1.5` read `15`, a stray letter reset the
// field to 1 or 0, and a cleared field could not be typed into (`30` read `130`). The unit rigs
// in `SourceConfigBody.test.tsx` and `RouterConfigBody.test.tsx` model the keys; this spec presses
// them in Chromium, the way a user does, through the mounted panel and its state.
//
// AND A PASTE HUNG APPLY. A pasted `Infinity` or `1e400` was kept as `Infinity`, and Apply's
// encode (`PostcardWriter.varintU`) looped forever on it until the renderer ran out of memory.
// The paste cases read the Configure frame Apply sent within 5 s (a hung encoder sends none),
// then ask the page to run one line of script.
//
// Every case keeps the field's shown text and the frame Apply sends in one read: the field shows
// what was typed while it has focus, the sanitized figure once it is left, and Apply sends that
// figure.

const SOURCE: InjectNode = {
  id: 11,
  kind: 0,
  cell_x: 15,
  cell_y: 5,
  ports: [{ index: 0, cell_x: 15, cell_y: 5, side: 1, role: 1, medium: 0 }],
};
const ROUTER: InjectNode = {
  id: 23,
  kind: 5,
  cell_x: 14,
  cell_y: 4,
  w: 2,
  h: 3,
  ports: [
    { index: 0, cell_x: 14, cell_y: 5, side: 3, role: 0, medium: 0 },
    { index: 1, cell_x: 15, cell_y: 6, side: 1, role: 1, medium: 0 },
    { index: 2, cell_x: 15, cell_y: 4, side: 1, role: 1, medium: 0 },
    { index: 3, cell_x: 15, cell_y: 5, side: 1, role: 1, medium: 0 },
    { index: 4, cell_x: 14, cell_y: 6, side: 2, role: 2, medium: 0 },
  ],
};
const TIMER_CONFIG = { kind: 'Source', trigger: { kind: 'Timer', interval_ticks: 60 } } as const;
const ROUTER_CONFIG = { kind: 'Router', routes: [[{ offset: 4, expect: [97] }, 0]], default: null } as const;

function panel(page: Page) {
  return page.locator('aside.fab-panel[aria-labelledby="fab-config-heading"]');
}

/** Boot on the mock host with one machine, click it, and wait for `field`. */
async function select(page: Page, node: InjectNode, config: unknown, field: string, cell: [number, number]): Promise<Harness> {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(() => localStorage.setItem('fab.onboarding.seen.v1', '1'));
  const h = await mockRenderSocket(page, {
    answerQuery: (verb) => (verb === 'machine_config' ? config : undefined),
  });
  await page.goto('/');
  await waitForChrome(page);
  await h.connected;
  h.inject(buildPacket({ tick: 2, nodes: [node] }));
  await waitForBoard(page, { machines: 1, tick: 2 });
  const at = await screenCellCentre(page, cell[0], cell[1]);
  await page.mouse.click(at.x, at.y);
  await expect(panel(page).locator(field), 'the field shows').toBeVisible({ timeout: 10_000 });
  return h;
}

/** Select all of the focused field's text, then type `text` one key at a time. */
async function retype(page: Page, field: string, text: string): Promise<void> {
  const f = panel(page).locator(field);
  await f.click();
  await page.keyboard.press('ControlOrMeta+a');
  await f.pressSequentially(text, { delay: 20 });
}

/** The Configure frames Apply sent for `node`, as bytes. */
function configures(h: Harness): string[] {
  return h.sent.filter((b) => b[0] === 9).map((b) => b.toString('hex'));
}

function configureHex(node: number, config: MachineConfig): string {
  return Buffer.from(encodeGridCommand({ kind: 'Configure', node, config })).toString('hex');
}

test.describe('the timer and At byte fields keep what is typed, one key at a time (WR-B-01)', () => {
  test('the timer Every field: 12.7, 1.5, a cleared field and a stray letter', async ({ page }) => {
    const h = await select(page, SOURCE, TIMER_CONFIG, '#fab-timer-interval', [15, 5]);
    const f = panel(page).locator('#fab-timer-interval');
    await expect(f, 'PRECONDITION: the field starts on the buffer').toHaveValue('60');

    await retype(page, '#fab-timer-interval', '12.7');
    await expect(f, '12.7 typed key by key reads 12.7, never 127').toHaveValue('12.7');
    await page.keyboard.press('Tab');
    await expect(f, 'leaving the field shows what Apply commits').toHaveValue('12');

    await retype(page, '#fab-timer-interval', '1.5');
    await expect(f, '1.5 reads 1.5, never 15').toHaveValue('1.5');
    await page.keyboard.press('Tab');
    await expect(f).toHaveValue('1');

    await f.click();
    await page.keyboard.press('End');
    await page.keyboard.press('Backspace');
    await expect(f, 'a cleared field stays empty').toHaveValue('');
    await f.pressSequentially('30', { delay: 20 });
    await expect(f, 'then 30 reads 30, never 130').toHaveValue('30');

    await f.pressSequentially('x', { delay: 20 });
    await expect(f, 'a stray letter stays on screen, the value is not reset under the caret').toHaveValue('30x');
    await page.keyboard.press('Backspace');
    await expect(f, 'Backspace gives the typed value back').toHaveValue('30');

    await expect(panel(page).getByText(CONFIG_NOT_APPLIED_MARKER)).toBeVisible();
    await panel(page).getByRole('button', { name: 'Apply' }).click();
    await expect(f, 'Apply shows the figure it sent').toHaveValue('30');
    await expect
      .poll(() => configures(h), { message: 'Apply sent the Configure for 30 ticks' })
      .toContain(configureHex(SOURCE.id, { kind: 'Source', trigger: { kind: 'Timer', interval_ticks: 30 } }));
  });

  test('the Router At byte field: 12.7, a cleared field and a stray letter', async ({ page }) => {
    const h = await select(page, ROUTER, ROUTER_CONFIG, '#fab-route-offset-0', [14, 4]);
    const f = panel(page).locator('#fab-route-offset-0');
    await expect(f, 'PRECONDITION: the field starts on the buffer').toHaveValue('4');

    await retype(page, '#fab-route-offset-0', '12.7');
    await expect(f, '12.7 typed key by key reads 12.7, never 127').toHaveValue('12.7');
    await page.keyboard.press('Tab');
    await expect(f).toHaveValue('12');

    await f.click();
    await page.keyboard.press('End');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');
    await expect(f, 'a cleared field stays empty').toHaveValue('');
    await f.pressSequentially('30x', { delay: 20 });
    await expect(f, 'then 30 and a stray letter read 30x').toHaveValue('30x');
    await page.keyboard.press('Backspace');
    await expect(f).toHaveValue('30');

    await panel(page).getByRole('button', { name: 'Apply' }).click();
    await expect
      .poll(() => configures(h), { message: 'Apply sent the Configure with offset 30' })
      .toContain(
        configureHex(ROUTER.id, { kind: 'Router', routes: [[{ offset: 30, expect: [97] }, 0]], default: null }),
      );
  });
});

test.describe('a pasted Infinity or 1e400 cannot hang Apply (CR-B-01, T-91-24, UF-91-02)', () => {
  for (const pasted of ['Infinity', '1e400', '9'.repeat(30)]) {
    test(`pasting ${pasted.length > 12 ? 'thirty nines' : pasted} shows the cap once the field is left, and Apply sends it`, async ({ page }) => {
      test.setTimeout(30_000);
      const h = await select(page, SOURCE, TIMER_CONFIG, '#fab-timer-interval', [15, 5]);
      const f = panel(page).locator('#fab-timer-interval');
      // `fill` writes the whole text in one input event, which is what a paste does.
      await f.fill(pasted);
      await page.keyboard.press('Tab');
      await panel(page).getByRole('button', { name: 'Apply' }).click();
      // The cap is 2^53 - 1 (`MAX_TIMER_INTERVAL`, pinned to it by `SourceConfigBody.test.tsx`).
      await expect
        .poll(() => configures(h), { message: 'Apply sent a Configure for the cap', timeout: 5_000 })
        .toContain(
          configureHex(SOURCE.id, { kind: 'Source', trigger: { kind: 'Timer', interval_ticks: Number.MAX_SAFE_INTEGER } }),
        );
      await expect(f, 'the field shows the cap it sent').toHaveValue(String(Number.MAX_SAFE_INTEGER));
      // The page still answers: a hung encoder never returns to the event loop.
      expect(await page.evaluate(() => 1 + 1), 'the page still runs script after Apply').toBe(2);
    });
  }
});
