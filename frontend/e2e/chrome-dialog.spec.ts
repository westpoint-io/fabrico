import { test, expect } from '@playwright/test';
import {
  buildPacket,
  mockRenderSocket,
  screenCellCentre,
  waitForChrome,
  type InjectBelt,
  type InjectNode,
  waitForBoard,
} from './support/wire';
// The band colours source from the ONE shared values module (GATE-02), exactly as
// chrome-bezel.spec.ts does for the panel: no hex literal lives in this spec.
import { rampOracles, colorToRgb } from '../shared/geometry';

// chrome-dialog.spec.ts (CHROME-01 / CHROME-02) - the LIVE proof that the one
// modal (DeleteGuardDialog) renders as a real bezel panel in the REAL running app,
// and keeps its alertdialog role. This is a lightweight RENDER smoke that COMPLEMENTS
// delete-guard.spec.ts: it asserts the reskin (bezel + role) WITHOUT duplicating the
// command-byte contracts (Cancel / Drain first / Delete anyway) that
// delete-guard.spec.ts owns.
//
// SUPERSEDED SUBJECT, QUOTED RATHER THAN DELETED (plan 59-03). This spec used to prove
// "a 9-slice `border-image` bezel panel", reasoning that "RESEARCH Pitfall 4 (mirrors
// chrome-bezel.spec.ts): a border-image paints NOTHING without `border-style: solid` +
// a non-zero `border-width`, so we assert border-image-source is a baked data:image/png
// AND the border is solid with width". All three of those became false BY DESIGN when
// the bezel became a pure-CSS composed inset ring. Repointed, not deleted: a spec whose
// subject changed and was removed leaves the surface with no coverage at all.
//
// COMPLETED IN PLAN 59-05, which owns this rewrite. 59-03 did the repoint early, because
// its own acceptance criterion was a green Playwright suite and a red spec trains the
// next executor to weaken it. What 59-03's version did NOT carry across from its sibling
// was the BAND COLOUR half: it asserted three inset entries and a zero border width, but
// not that the bands are the locked skin's lit, shadow and outline values. A ring of
// three entries in the right order painted in the wrong colours satisfied it. The colour
// assertions below close that, sourced from the same `rampOracles.locked` the panel spec
// reads, so neither spec can drift onto a typed-in hex.

/** The locked-skin lit edge (LOCKED ramp[4]), sourced from the shared oracle. */
const LIT = colorToRgb(rampOracles.locked[4]);
/** The locked-skin shadow edge (LOCKED ramp[0]), sourced. */
const SHADOW = colorToRgb(rampOracles.locked[0]);
/**
 * The hairline outline. Bible section 6 gives `--fab-outline` the SAME ramp index as
 * `--fab-edge-shadow`, so this is deliberately a second name for ramp[0] rather than a
 * duplicate: naming it separately is what keeps the third assertion meaningful if a
 * future skin ever separates the two.
 */
const OUTLINE = colorToRgb(rampOracles.locked[0]);

/** `rgb(r, g, b)` as Chromium serialises a resolved colour in a computed box-shadow. */
function rgbText(c: { r: number; g: number; b: number }): string {
  return `rgb(${c.r}, ${c.g}, ${c.b})`;
}

/** A SOURCE at (12,8) with its catalog Out port (mirrors delete-guard fixture). */
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
 * Drive the one modal open through the delete-guard wire pattern, and return its
 * panel locator. Extracted in plan 59-07 so the ring assertion and the button-row
 * overflow backstop share ONE opening path: two copies of a fixture drift, and a
 * backstop measuring a differently-opened dialog measures a different dialog.
 */
async function openDeleteGuard(page: import('@playwright/test').Page) {
  const h = await mockRenderSocket(page);
  await page.goto('/');
  await waitForChrome(page);
  await h.connected;

  h.inject(buildPacket({ nodes: [MACHINE], belts: [beltCarrying(2)] }));
  await waitForBoard(page, { machines: 1 });

  // Select the machine (click, no drag), then press Delete -> the guard intercepts.
  const at = await screenCellCentre(page, MACHINE.cell_x, MACHINE.cell_y);
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.up();
  await page.keyboard.press('Delete');

  const panel = page.locator('.fab-dialog-panel');
  await expect(panel).toBeVisible();
  return panel;
}

test('the delete-guard dialog renders as a composed inset ring with role=alertdialog', async ({
  page,
}) => {
  const panel = await openDeleteGuard(page);

  // The panel is an alertdialog (aria contract preserved through the reskin).
  await expect(panel).toHaveAttribute('role', 'alertdialog');

  // The bezel is three composed inset bands in the load-bearing order, painted in the
  // locked skin's own band colours, and it reserves NO space: the zero border-width is
  // FALSE before the migration, so this is a real proof rather than a tautology.
  const bezel = await page.evaluate(() => {
    const el = document.querySelector('.fab-dialog-panel');
    if (el == null) return null;
    const cs = getComputedStyle(el);
    return {
      shadow: cs.getPropertyValue('box-shadow').trim(),
      source: cs.getPropertyValue('border-image-source').trim(),
      width: cs.getPropertyValue('border-top-width').trim(),
    };
  });
  expect(bezel, 'dialog panel is present').not.toBeNull();
  const entries = bezel!.shadow.split(/,(?![^(]*\))/).map((e) => e.trim());
  expect(entries, `unexpected composed ring: ${bezel!.shadow}`).toHaveLength(3);
  for (const e of entries) expect(e).toContain('inset');

  // ORDER + COLOUR together. The first-listed inset paints on top, so the bottom/right
  // shadow band leads (it wins the two corners both bands claim, leaving only the
  // top-left corner lit), then the top/left lit band, then the uniform two-band outline
  // whose outer band is fully covered. Entry 2 is the same locked ramp[0] as entry 0
  // because the hairline outline and the shadow edge are the same ramp index by design.
  expect(entries[0], 'entry 0 is the bottom/right shadow band').toContain(rgbText(SHADOW));
  expect(entries[1], 'entry 1 is the top/left lit band').toContain(rgbText(LIT));
  expect(entries[2], 'entry 2 is the hairline outline band').toContain(rgbText(OUTLINE));

  expect(bezel!.source).toBe('none');
  expect(parseFloat(bezel!.width)).toBe(0);
});

// ---------------------------------------------------------------------------
// VALIDATION ROW 36 (plan 59-07): the guard-dialog button row at the narrowest
// LEDGERED viewport. Added here rather than reasoned about, because getting the
// dismiss-versus-destroy contrast wrong on a destructive dialog is the one place a
// look defect has a real cost.
//
// 992x768 is the narrowest LEDGERED viewport in this project: the internal
// defect ledger (WINDOWS id 4) records the toolbar's minimum non-clipping width at 992 clean / 1106 dirty,
// and the shipped Tauri window opens at 1280x800 resizable with NO minimum, so a
// user can drag into that range. 1024x768 (palette-grouping's tightest) and
// 1280x720 (WINDOWS id 2's worst) are both wider.
//
// TWO CLAIMS THE PLAN AND 59-UI-SPEC MAKE ABOUT THIS ROW ARE FALSE, MEASURED IN
// PLAN 59-07, AND THEY ARE QUOTED HERE RATHER THAN QUIETLY WORKED AROUND:
//
//   1. "four buttons, end-justified with a gap". Measured: NO guard dialog renders
//      four. DeleteGuardDialog renders THREE (Cancel / Drain first / Delete anyway)
//      and has no un-modified base button at all; QuitGuardDialog renders TWO in its
//      quit arm (Cancel / Quit anyway) and THREE in its New-Open arm (Cancel /
//      Discard / Save). So the ledgered "+48px = 4 x 12" growth figure is at most
//      3 x 12 = 36px, and the widest real row is this one.
//   2. "neither guard dialog declares a width bound". Measured: `.fab-dialog-panel`
//      declares `width: calc(100% - (var(--fab-space-xl) * 2)); max-width: 420px`
//      in `chromeCss.ts`, and BOTH guards use that class. The panel measures a
//      constant 480x207.98 outer (420 content + 2 x 30 padding) at 1280, 1106,
//      1024, 992, 900, 800, 720 AND 640 CSS px of viewport width. The row's
//      available width does not depend on the viewport at all in that range.
//
// WHICH HALF OF THIS TEST IS LOAD-BEARING, stated so a later reader does not count
// the cheap half twice. The row is `display: flex` with the DEFAULT
// `flex-wrap: nowrap`, so a wrap is STRUCTURALLY IMPOSSIBLE and the single-row
// assertion is close to free - it is kept because it is the property the contract
// names, not because it can catch much. The real failure mode under width pressure
// is the opposite one: flex items default to `flex-shrink: 1`, so every button stays
// on one line while SQUEEZING. Measured under a deliberately narrowed panel: "Drain
// first" goes 132 -> 84px and "Delete anyway" 148 -> 92px, all three still on one
// row. The NO-SQUEEZE assertion is the one with mutation value.
//
// AND THE OBVIOUS OVERFLOW ORACLE DOES NOT WORK HERE, WHICH IS WHY IT IS NOT USED.
// `scrollWidth - clientWidth` is blind to this row: with `justify-content: flex-end`
// a squeezed row spills towards the START edge, and `scrollWidth` in LTR reports only
// end-side overflow. Measured under the same narrowed panel: the buttons visibly did
// not fit (270px of button plus 16px of gap inside a 260px box) and `scrollWidth`
// still equalled `clientWidth` exactly. So the fit is asserted ARITHMETICALLY against
// the container's own content box, and the squeeze against each button's NATURAL
// width measured from an off-screen `width: max-content` clone of the real row.
test('the guard-dialog button row does not wrap or squeeze at the narrowest ledgered viewport [row 36]', async ({
  page,
}) => {
  await page.setViewportSize({ width: 992, height: 768 });
  await openDeleteGuard(page);

  const row = await page.evaluate(() => {
    const round2 = (n: number) => Math.round(n * 100) / 100;
    const panel = document.querySelector('.fab-dialog-panel');
    if (panel == null) return null;
    const buttons = [...panel.querySelectorAll('.fab-dialog-btn')];
    if (buttons.length === 0) return null;
    const container = buttons[0]!.parentElement as HTMLElement;

    // NATURAL widths: an off-screen clone of the REAL row at `width: max-content`,
    // so nothing shrinks. Cloning the row (rather than restating the buttons) is what
    // keeps the reference honest if a class or a label ever changes.
    const ghost = container.cloneNode(true) as HTMLElement;
    ghost.style.position = 'absolute';
    ghost.style.left = '-10000px';
    ghost.style.top = '0';
    ghost.style.width = 'max-content';
    ghost.style.visibility = 'hidden';
    document.body.appendChild(ghost);
    const natural = [...ghost.querySelectorAll('.fab-dialog-btn')].map(
      (b) => b.getBoundingClientRect().width,
    );
    ghost.remove();

    const gap = parseFloat(getComputedStyle(container).columnGap || '0') || 0;
    const measured = buttons
      .map((b, i) => {
        const r = b.getBoundingClientRect();
        return {
          label: (b.textContent ?? '').trim(),
          x: r.x,
          top: round2(r.y),
          width: round2(r.width),
          naturalWidth: round2(natural[i] ?? NaN),
        };
      })
      .sort((a, b) => a.x - b.x);

    const usedPx = round2(
      measured.reduce((a, m) => a + m.width, 0) + gap * (measured.length - 1),
    );
    return {
      ladder: measured.map((m) => m.label),
      distinctTops: new Set(measured.map((m) => m.top)).size,
      squeezed: measured
        .filter((m) => m.width < m.naturalWidth - 0.5)
        .map((m) => `${m.label} ${m.width}px < natural ${m.naturalWidth}px`),
      gapPx: gap,
      availablePx: round2(container.clientWidth),
      usedPx,
    };
  });

  expect(row, 'the guard dialog has a button row').not.toBeNull();

  // VACUITY REFUSAL. Three buttons is the widest real guard row; a run that found one
  // or none would satisfy every assertion below while proving nothing.
  expect(row!.ladder, 'the delete guard renders its three-button row').toHaveLength(3);

  // The destroy-versus-dismiss ladder, in left-to-right RENDERED order (not DOM
  // order): the dismiss ghost first, the destructive action last and furthest from
  // the pointer's resting place.
  expect(row!.ladder, 'dismiss first, destroy last').toEqual([
    'Cancel',
    'Drain first',
    'Delete anyway',
  ]);

  // ONE LINE. Cheap (see the note above), and the property the contract names.
  expect(row!.distinctTops, `the row spans ${row!.distinctTops} lines: ${row!.ladder}`).toBe(1);

  // THE LOAD-BEARING HALF. (1) No button is narrower than its own natural width, so
  // the destroy-versus-dismiss ladder is not being read at a squeezed label. (2) The
  // buttons plus their gaps fit the row's content box arithmetically. Both report the
  // numbers, so a future narrowing is legible in the failure rather than only as a
  // boolean.
  expect(
    row!.squeezed,
    `these guard-dialog buttons are squeezed at 992px: ${row!.squeezed.join('; ')}`,
  ).toEqual([]);
  expect(
    row!.usedPx,
    `the button row needs ${row!.usedPx}px (three buttons plus ${row!.gapPx}px gaps) ` +
      `inside a ${row!.availablePx}px content box`,
  ).toBeLessThanOrEqual(row!.availablePx);
});
