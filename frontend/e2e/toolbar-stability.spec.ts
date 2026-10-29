import { test, expect, type Page } from '@playwright/test';
// The PNG decoder Playwright already bundles (pngjs), as `dpr-crispness.spec.ts` reaches it.
import { PNG } from 'playwright-core/lib/utilsBundle';
import {
  buildPacket,
  mockRenderSocket,
  screenCellCentre,
  waitForChrome,
  type Harness,
  type InjectNode,
  waitForBoard,
} from './support/wire';

// toolbar-stability.spec.ts (Phase 32-04, SHELL-02) - the LIVE proof that the
// transport toolbar never jitters (growing tick) and never reflows (Undo/Redo
// enable), and that the primary CTA is never clipped at common desktop widths.
//
// Layout-stability invariants, all driven through the REAL app + the mock
// render socket (inject a scene packet, read the DOM geometry - never canvas
// pixels):
//   1. Enabling Undo does not change the Undo button's box. HALF OF THIS IS NOW
//      UNFALSIFIABLE - see the measured block below test 1, which splits the ring
//      half (tautology) from the border half (still live) and names the
//      replacement guards for the half that died.
//   2. The growing `tick N` readout never shifts the transport cluster - the
//      fixed-width tabular tick slot absorbs the digits. (Plan 91-10: the cluster is
//      the header grid's centre column now, not centred by an auto margin.)
//   3. (plan-check WARNING 1) The `.fab-cta` primary CTA (now `Examples`, EX-02
//      - the shorter label replacing `Load demo scene`; since plan 91-10 a plain
//      labelled button, `[data-fab-examples-trigger]`) keeps its right edge
//      within the viewport (never clipped) across a representative narrow->wide
//      width range, and at a hiDPI DPR.
//   4. (WINDOWS id 4 backstop, 55-UI-SPEC) The MEASURED minimum non-clipping
//      toolbar width, clean AND dirty (the dirty case actually injected - the
//      pre-52 gap was that no test did), stays <= 992 / <= 1106: id 4 is not
//      worsened by the Examples CTA. Measured 990 clean / 1072 dirty. Plan 91-10
//      (CHROME-15, UI-SPEC 5.2) moved both bounds to 872, clean and dirty alike.
//      NOTE the UI-SPEC's stated mechanism ("the shorter label narrows the
//      cluster by ~50px at the 12px mono advance") did NOT hold: at the minimum
//      the row is already past its natural width, so the CTA's label advance is
//      not what sets the bound - the neighbouring labelled buttons absorb the
//      shrink instead, and a LONGER CTA label simply squeezes them further. An
//      A/B in the same harness put the pre-55 CTA shape at 1072 -> 1064 dirty,
//      i.e. 8px the other way. The bound is met on the ledgered numbers; the
//      predicted mechanism is not the reason. See 55-02-SUMMARY.

/** Read the trimmed text of the header tick readout (title="Current sim tick"). */
async function tickText(page: Page): Promise<string> {
  const el = page.locator('header [title="Current sim tick"]');
  return (await el.textContent())?.trim() ?? '';
}

/**
 * The mock host's stream cadence while the board plays: an eighth of the app's 800 ms
 * SAFE-01 stall threshold (`DISCONNECT_MS`), so a live stream never looks stalled.
 */
const HOST_STREAM_MS = 100;

/**
 * Keep the mock host's render stream alive while the board PLAYS, as the real host does
 * (plan 84-08). `stop()` ends it; it also ends when the page closes.
 *
 * WHY. The app boots playing, and a playing board whose host sends nothing for 800 ms is a
 * stalled stream: the SAFE-01 watchdog then reads `Disconnected - live view frozen`, and
 * that latch is sticky until a packet comes, so it outlives the Pause and returns whenever
 * a transient notice auto-clears. This file's mock host used to send ONE packet and go
 * silent while the test clicked Pause, waited for queued edits to land or measured the
 * header. On this machine that silence was shorter than 800 ms; on the 2026-10-09 CI run's
 * two-CPU runner it was not once (the flaky PAUSE-TOOLBAR 1600x1000 leg: `toHaveText('')`
 * received the Disconnected sentence), here at a 50% CPU quota it was not in 10 runs of
 * 10, and the badge-leg sweep met the same sentence at its first probe. The app was right
 * and the fixture was not a live host. Each beat is an empty diff carrying the current
 * tick and undo flags: no node, no structural edit (so it dirties nothing) and no new tick
 * (so it ends no undo hold), only the delivery the watchdog listens for. `follow` changes
 * what the beats say, and is called BEFORE injecting the packet that changes it, so no
 * beat ever repeats an older tick after a newer one.
 */
interface HostStream {
  follow(beat: { tick: number; canUndo: boolean; canRedo: boolean }): void;
  stop(): void;
}
function streamWhilePlaying(
  page: Page,
  h: Harness,
  beat: { tick: number; canUndo: boolean; canRedo: boolean },
): HostStream {
  let packet = buildPacket({ ...beat, full: false });
  const timer = setInterval(() => {
    try {
      h.inject(packet);
    } catch {
      // The page closed under a beat (a failed test tearing down): nothing to keep alive.
    }
  }, HOST_STREAM_MS);
  const stop = (): void => clearInterval(timer);
  page.once('close', stop);
  return {
    follow: (next) => {
      packet = buildPacket({ ...next, full: false });
    },
    stop,
  };
}

test('enabling Undo does not change the Undo button geometry (no bevel reflow) [SHELL-02]', async ({
  page,
}) => {
  const h = await mockRenderSocket(page);
  await page.goto('/');
  await waitForChrome(page);
  await h.connected;

  const undo = page.locator('header button[aria-label="Undo"]');
  await expect(undo).toBeVisible();
  // Fresh boot: the undo stack is empty, so the button is disabled.
  await expect(undo).toBeDisabled();
  const disabledBox = await undo.boundingBox();
  expect(disabledBox, 'disabled Undo has a layout box').not.toBeNull();

  // The "dispatch that flips canUndo": inject a scene packet with can_undo=1.
  // The App poll lifts props.canUndo, re-enabling the button.
  h.inject(buildPacket({ tick: 1, canUndo: true, canRedo: false }));
  await expect(undo).toBeEnabled();
  const enabledBox = await undo.boundingBox();
  expect(enabledBox, 'enabled Undo has a layout box').not.toBeNull();

  // THIS ASSERTION IS HALF TAUTOLOGY AND HALF LIVE GUARD, and the split was MEASURED
  // rather than reasoned (plan 59-05). Two prior documents - 59-03's SUMMARY and
  // `chromeCss.ts`'s disabled-button docblock, and 59-05's own plan text after them -
  // state flatly that this case "becomes a TAUTOLOGY" and that "its mutation value is
  // zero". Two mutations run against the real app say that is true of one half only.
  //
  // SUPERSEDED ROOT-CAUSE PROOF, QUOTED RATHER THAN DELETED: "the :disabled rule no
  // longer swaps border-image-source:none + border-width:1px, so the bezel geometry is
  // CONSTANT across disabled<->enabled - the width/height are equal within a sub-pixel
  // tolerance. A regression (re-added collapse) inflates the enabled button by ~5px/side
  // and fails here." The MECHANISM it names is deleted: 59-03 replaced the rasterised
  // nine-slice with a composed inset ring and 59-05 deleted the bake, the three raster
  // tokens and `chrome/bezelUrl.ts`. But the DEFECT CLASS it guards is not deleted.
  //
  // THE TWO MUTATIONS, both run on the real app through this spec, both reverted:
  //
  //   6a  `box-shadow: none` on `.fab-tool-btn:disabled` (ring stripped, nothing else)
  //       -> this spec GREEN, 5 passed. `box-shadow` is paint: it sits outside layout,
  //          so no ring mutation can move the box. THE RING HALF IS A TAUTOLOGY.
  //   6   the same, PLUS `border: 1px solid var(--fab-outline)` re-added
  //       -> this spec RED, on this exact assertion. A `<button>` is border-box by UA
  //          reckoning but auto-WIDTH here, so a re-added border still grows the outer
  //          box by 2px. THE BORDER HALF STILL BITES, and it is the 32-04 defect
  //          verbatim: a `:disabled` rule that swaps the frame for a border.
  //
  // SO THE HONEST READING. What this case can no longer catch is a disabled button
  // LOSING ITS RING - that is now invisible to geometry, and the loss is real. What it
  // still catches is a disabled button GAINING A BORDER, which is the regression the
  // 32-04 fix was written against and the one a future author is most likely to reach
  // for. Recording it as fully tautological would have retired a guard that still works;
  // recording it as fully live would have hidden the half that stopped working.
  //
  // THE REPLACEMENT GUARDS FOR THE HALF THAT DIED, named so neither reads as an optional
  // extra:
  //   - the DISABLED-BUTTON BASELINE plan 59-06 writes. It is the only surface that can
  //     see a disabled button rendering ringless, since its geometry no longer moves.
  //   - the TWO SHADOW WALKER GATES plan 59-03 added in `src/chrome/chromeCss.test.ts`.
  //     Under mutation 6a they went RED THREE WAYS while this spec stayed green:
  //     `Only .fab-dialog-btn--cancel may cancel the ring`, `expected 'none' to contain
  //     '--fab-bezel-ring-shadow'`, and `.fab-tool-btn state list lengths: 5, 5, 5, 1`.
  //     That contrast IS the demonstration: the coverage moved, it did not vanish.
  //
  // The phase's other tautology is `logo.spec.ts`'s "the old passive accent logo square
  // is removed from the header", recorded by plan 59-04 with its own 7-to-1 measurement.
  // That one is unconditional; this one is not. Both are in 59-05-SUMMARY.md so a reader
  // counting green specs as coverage gets the right count.
  expect(Math.abs(enabledBox!.width - disabledBox!.width)).toBeLessThan(0.5);
  expect(Math.abs(enabledBox!.height - disabledBox!.height)).toBeLessThan(0.5);
});

test('the growing tick never shifts the centered transport cluster [SHELL-02]', async ({
  page,
}) => {
  const h = await mockRenderSocket(page);
  await page.goto('/');
  await waitForChrome(page);
  await h.connected;

  // The leftmost item of the centered transport cluster (Play OR Pause glyph);
  // its x is the cluster's left edge, which re-centers if the cluster widens.
  const transport = page
    .locator('header button[aria-label="Play"], header button[aria-label="Pause"]')
    .first();
  await expect(transport).toBeVisible();

  // A low tick. The board plays for the whole test, so the host streams throughout
  // (plan 84-08, `streamWhilePlaying`): a Disconnected sentence in the right cluster is
  // what a silent host would put beside the measured transport. Each new tick is
  // followed BEFORE it is injected.
  const live = streamWhilePlaying(page, h, { tick: 1, canUndo: false, canRedo: false });
  h.inject(buildPacket({ tick: 1, canUndo: false, canRedo: false }));
  await expect.poll(() => tickText(page)).toBe('tick 1');
  const lowBox = await transport.boundingBox();
  expect(lowBox, 'transport button has a layout box at low tick').not.toBeNull();

  // WR-04: cross the 7-digit boundary that overflowed the old 13ch slot.
  // "tick 1,000,000" is 14 chars (the old 13ch minWidth grew the slot here and
  // re-shifted the centered cluster - the exact SHELL-02 reflow this test guards).
  live.follow({ tick: 1000000, canUndo: false, canRedo: false });
  h.inject(buildPacket({ tick: 1000000, canUndo: false, canRedo: false }));
  await expect.poll(() => tickText(page)).toBe('tick 1,000,000');
  const millionBox = await transport.boundingBox();
  expect(millionBox, 'transport button has a layout box at a 1M tick').not.toBeNull();
  expect(
    Math.abs(millionBox!.x - lowBox!.x),
    'the centered cluster does not shift at a >= 1,000,000 tick (WR-04)',
  ).toBeLessThan(0.5);

  // The widest grouped form below the compact threshold still fits the slot without
  // shifting the cluster. MOVED BY PLAN 91-10 (CHROME-15, UI-SPEC 5.1 and 11.1): it was
  // "tick 99,999,999" (15 chars, the 16ch slot); compact notation now starts at 10,000,000,
  // so the widest grouped form is "tick 9,999,999" (14 chars, the 14ch slot), and
  // 99,999,999 reads "tick 100M".
  live.follow({ tick: 9999999, canUndo: false, canRedo: false });
  h.inject(buildPacket({ tick: 9999999, canUndo: false, canRedo: false }));
  await expect.poll(() => tickText(page)).toBe('tick 9,999,999');
  const wideBox = await transport.boundingBox();
  expect(wideBox, 'transport button has a layout box at the widest grouped tick').not.toBeNull();
  expect(
    Math.abs(wideBox!.x - lowBox!.x),
    'the centered cluster does not shift at the widest grouped tick',
  ).toBeLessThan(0.5);

  // Plan 91-10: the threshold itself reads compact, and Play holds its x there too.
  live.follow({ tick: 10000000, canUndo: false, canRedo: false });
  h.inject(buildPacket({ tick: 10000000, canUndo: false, canRedo: false }));
  await expect.poll(() => tickText(page)).toBe('tick 10M');
  const thresholdBox = await transport.boundingBox();
  expect(thresholdBox, 'transport button has a layout box at the compact threshold').not.toBeNull();
  expect(
    Math.abs(thresholdBox!.x - lowBox!.x),
    'the transport does not shift at the compact threshold (tick 10M)',
  ).toBeLessThan(0.5);

  // Past the threshold the readout switches to compact notation ("tick 100M"),
  // which is always shorter than the reserved slot - so an arbitrarily large tick
  // has a HARD width ceiling and can never widen the cluster.
  live.follow({ tick: 100000000, canUndo: false, canRedo: false });
  h.inject(buildPacket({ tick: 100000000, canUndo: false, canRedo: false }));
  await expect.poll(() => tickText(page)).toBe('tick 100M');
  const compactBox = await transport.boundingBox();
  expect(compactBox, 'transport button has a layout box at a compact tick').not.toBeNull();
  expect(
    Math.abs(compactBox!.x - lowBox!.x),
    'the centered cluster does not shift once the tick goes compact',
  ).toBeLessThan(0.5);  live.stop();
});

test('the primary CTA is never clipped across common widths [SHELL-02 / plan-check WARNING 1]', async ({
  page,
}) => {
  const h = await mockRenderSocket(page);
  await page.goto('/');
  await waitForChrome(page);
  await h.connected;
  // A realistic mid tick so the tick slot sits at its reserved width (worst case
  // for the right-hand controls' horizontal budget).
  h.inject(buildPacket({ tick: 123456, canUndo: true, canRedo: true }));

  const cta = page.locator('header button[data-fab-examples-trigger]');
  await expect(cta).toBeVisible();

  // Layout is in CSS px (DPR-independent), so clipping is WIDTH-driven: probe a
  // representative narrow->wide desktop range. The CTA's right edge must stay
  // within the viewport at every width, and the left edge must not go negative.
  for (const width of [1024, 1440, 1920]) {
    await page.setViewportSize({ width, height: 800 });
    const box = await cta.boundingBox();
    expect(box, `CTA has a layout box at ${width}px`).not.toBeNull();
    expect(
      box!.x + box!.width,
      `CTA right edge within the ${width}px viewport (not clipped)`,
    ).toBeLessThanOrEqual(width + 0.5);
    expect(box!.x, `CTA left edge on-screen at ${width}px`).toBeGreaterThanOrEqual(0);
  }
});

// ---------------------------------------------------------------------------
// WINDOWS id 4 backstop (55-UI-SPEC "overflow" row): MEASURE the minimum
// non-clipping toolbar width with the `Examples` CTA, on a CLEAN and a DIRTY
// board. The ledgered pre-55 numbers are 992 clean / 1106 dirty (the row
// overflows 1024px whenever "Unsaved" shows); the shorter CTA label must not
// worsen either. The dirty case is ACTUALLY injected - the pre-52 gap was that
// no test ever measured the dirty row.
// ---------------------------------------------------------------------------

/** A SOURCE machine for the boot keyframe (the structural-edit dirty base). */
const MACHINE: InjectNode = { id: 1, kind: 0, cell_x: 12, cell_y: 8 };
/** A NEW node on a diff packet - a genuine structural edit -> dirty. */
const NEW_MACHINE: InjectNode = { id: 2, kind: 0, cell_x: 14, cell_y: 8 };

/**
 * The smallest viewport width (CSS px) at which the `.fab-cta` fits fully
 * on-screen. Clipping is monotone in width (narrower -> more clipped), so a
 * binary search over [lo, hi] converges in ~9 setViewportSize round-trips.
 *
 * MEASUREMENT HYGIENE (the contaminant this search was caught by, 55-02): the
 * right cluster carries the SHELL-07 status readout, which is EMPTY at rest but
 * renders `Disconnected - live view frozen` when SAFE-01's stall watchdog fires.
 * That string is 31 chars of Martian Mono plus the fault glyph and gap: it
 * widens the cluster by ~268px and pushes the measured minimum from 990 to
 * 1258. Because the watchdog is a WALL-CLOCK timer (DISCONNECT_MS after the
 * last packet), it lands at a different probe on every run - so the sweep
 * returned 990 alone and 1000 under parallel-suite load, a silent bimodal
 * result rather than an honest failure. The caller PAUSES the sim first (a
 * paused sim's silence is expected by design, so the watchdog disarms), and
 * every probe asserts the readout is still empty, so contamination can never
 * again skew the number quietly - it fails loudly at the probe that saw it.
 */
async function minNonClippingWidth(page: Page): Promise<number> {
  const fits = async (width: number): Promise<boolean> => {
    await page.setViewportSize({ width, height: 800 });
    // The SHELL-07 readout, told apart from the SAVE-05 "Unsaved" badge (both
    // are role=status aria-live=polite live regions in this same cluster).
    const status = await page
      .locator('header [role="status"]')
      .filter({ hasNotText: 'Unsaved' })
      .innerText();
    expect(
      status.trim(),
      `the status readout must stay empty for the whole sweep (probe ${width}px): a status string widens the right cluster and corrupts the measurement`,
    ).toBe('');
    const box = await page.locator('header button[data-fab-examples-trigger]').boundingBox();
    return box !== null && box.x >= 0 && box.x + box.width <= width + 0.5;
  };
  let lo = 700; // assumed clipped
  let hi = 1300; // assumed clean
  expect(await fits(hi), 'the bracket top (1300px) renders the CTA clean').toBe(true);
  if (await fits(lo)) {
    return lo; // already clean at the bracket floor - strictly better than the bound
  }
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (await fits(mid)) {
      hi = mid;
    } else {
      lo = mid;
    }
  }
  return hi;
}

test('WINDOWS id 4 backstop: min non-clipping width <= 872 clean and dirty [55-UI-SPEC, 91-UI-SPEC 5.2]', async ({
  page,
}) => {
  const h = await mockRenderSocket(page);
  // Suppress the first-run welcome card (set-flag-before-navigation, the v5.0
  // live-spec lesson): an undismissed overlay during the width sweep is a
  // measurement contaminant (transient scrollbars shift the effective width).
  await page.addInitScript(() => {
    try {
      localStorage.setItem('fab.onboarding.seen.v1', '1');
    } catch {
      // locked-down webview: harmless.
    }
  });
  await page.goto('/');
  await waitForChrome(page);
  await h.connected;

  // Worst-case right-cluster budget: the reserved tick slot at a mid tick plus
  // enabled Undo/Redo (same posture as the width-sweep probe above), with one
  // machine so the later diff packet is a genuine structural edit.
  h.inject(buildPacket({ tick: 123456, canUndo: true, canRedo: true, nodes: [MACHINE] }));
  // Plan 84-08: the host streams while the board plays, until the Pause below has landed
  // (`streamWhilePlaying`). Pausing alone left a gap: on a slow machine the 800 ms of
  // silence before the Pause landed was enough for the sentence this comment describes.
  const live = streamWhilePlaying(page, h, { tick: 123456, canUndo: true, canRedo: true });
  await waitForBoard(page, { machines: 1 });

  // Disarm SAFE-01's stall watchdog for the sweep. The chrome boots PLAYING
  // (SIM_BOOTS_PLAYING), and the mock socket sends one packet and then goes
  // quiet, so DISCONNECT_MS later the sticky `Disconnected - live view frozen`
  // readout appears mid-sweep and adds ~268px to the right cluster. Pausing is
  // the app's OWN disarm path (App.tsx: "pause disarms it - a paused sim emits
  // zero packets by design"), so this measures the healthy steady state the
  // WINDOWS id 4 ledger describes rather than a transient fault state. The
  // per-probe status assertion in minNonClippingWidth is the belt-and-braces.
  await page.getByRole('button', { name: 'Pause' }).click();
  await expect(page.getByRole('button', { name: 'Play' })).toBeVisible();
  live.stop();

  // Deterministic text metrics: every label width (and therefore the min
  // non-clipping width) depends on Martian Mono being LOADED - the bundled
  // woff2 is `font-display: block`, so a measurement taken during the block
  // period would read fallback-mono advances (72px vs 80px per 10 chars).
  await page.evaluate(async () => {
    await document.fonts.load('12px "Martian Mono"');
    await document.fonts.ready;
  });

  // CLEAN: a fresh keyframe is never a user edit; no "Unsaved" badge.
  await expect(page.getByText('Unsaved', { exact: true })).toBeHidden();
  // MOVED BY PLAN 91-10 (CHROME-15, UI-SPEC 5.2 and 11.1): the ledgered 992 clean / 1106 dirty
  // became 872 clean AND dirty. The grid's centre and right columns hold the transport (304)
  // and the right cluster (476) at their own widths, the left column can go to 0, and with the
  // header's 14 px padding, its two 8 px gaps and the 24 px insets that is 872; `Unsaved` and
  // the status sit in the strip under the row, so the dirty row is no wider than the clean one.
  const clean = await minNonClippingWidth(page);
  expect(
    clean,
    `clean-board min non-clipping width ${clean}px must not exceed the UI-SPEC 5.2 872px`,
  ).toBeLessThanOrEqual(872);

  // DIRTY, actually injected: a NEW node on a diff packet -> structural edit ->
  // the "Unsaved" badge widens the right cluster (the ledgered worst case).
  h.inject(buildPacket({ nodes: [MACHINE, NEW_MACHINE], full: false, tick: 123457 }));
  await expect(page.getByText('Unsaved', { exact: true })).toBeVisible();
  const dirty = await minNonClippingWidth(page);
  expect(
    dirty,
    `dirty-board min non-clipping width ${dirty}px must not exceed the UI-SPEC 5.2 872px`,
  ).toBeLessThanOrEqual(872);

  // The measured record for the SUMMARY (id 4 tracking). Both bounds hold; see
  // the file header for why the UI-SPEC's ~50px prediction did not materialise.
  console.log(
    `[WINDOWS id 4] min non-clipping toolbar width: clean=${clean}px dirty=${dirty}px`,
  );
});

// ---------------------------------------------------------------------------
// N-1b / C-17 (plan 80.1-01, D-13): the SAME backstop, swept with the widest
// real brand cluster - `loadedScene` set to `Order processing`, the longest
// shipped scene name.
//
// WHY THIS IS A SEPARATE test() AND NOT FOUR MORE LINES INSIDE THE ONE ABOVE.
// D-13 requires BOTH legs measured: `loadedScene` null AND `Order processing`.
// The scene load has to happen on a CLEAN board or it opens the `example`
// discard guard first (quit-guard.spec.ts:169-173 exercises exactly that path),
// and it CLEARS dirty when it lands. So it can only be slotted between
// waitForChrome and the Pause click - which is upstream of the null leg's own
// clean and dirty sweeps, and would therefore DELETE the null leg rather than
// add to it. One page context cannot hold both legs in the required order. Two
// tests can, and this one is a permanent assertion against the same ledgered
// ceiling, not a one-time probe: C-17 was booked precisely because no gate had
// ever measured the badge-present cluster, and measuring it once without
// keeping it would recreate the gap it was filed for.
//
// Every measurement-hygiene step from the null leg is reproduced verbatim: the
// onboarding init script, the keyframe with one machine so the later diff is a
// genuine structural edit, the Pause that disarms SAFE-01's stall watchdog, the
// `document.fonts.ready` await, and the per-probe status assertion inside
// minNonClippingWidth.
// ---------------------------------------------------------------------------

/** A THIRD node for the badge leg's diff packet (the structural edit -> dirty). */
const THIRD_MACHINE: InjectNode = { id: 3, kind: 0, cell_x: 16, cell_y: 8 };

/**
 * The smallest viewport width (CSS px) at which the brand cluster is not
 * squeezed AT ALL, i.e. its layout width covers its own scroll width.
 *
 * A DIFFERENT QUANTITY FROM minNonClippingWidth, and the difference is the
 * point of recording it (N-1c). That function finds the width at which the
 * primary CTA starts being clipped, which is the gate. This finds the width at
 * which the brand cluster starts losing pixels at all, which is what a user at
 * 1280 actually sees. The two are roughly 300 px apart, so reporting only the
 * gate number hides the thing the narrow-window question was actually about.
 *
 * The cluster is found through the cut's own parent rather than by an
 * nth-child index, so moving the visually-hidden heading or adding a sibling
 * cluster cannot silently repoint this at a different box.
 */
async function firstUnsqueezedClusterWidth(page: Page): Promise<number> {
  const unsqueezed = async (width: number): Promise<boolean> => {
    await page.setViewportSize({ width, height: 800 });
    // REPOINTED BY PLAN 91-10 (CHROME-15, UI-SPEC 5.3): the cut's parent is now its own slot,
    // which never shrinks, inside the grid's left column; the column is the box that clips, so
    // the column (`closest`, not an nth-child index) is what is read.
    const m = await page.evaluate(() => {
      const cut = document.querySelector('header [data-testid="header-lockup"]');
      const cluster = cut === null ? null : cut.closest('[data-fab-brand-column]');
      if (cluster === null) return null;
      return { w: cluster.getBoundingClientRect().width, sw: cluster.scrollWidth };
    });
    expect(
      m,
      `the brand cluster must be findable as the header lockup's parent (probe ${width}px): a null here means the search measured nothing at all`,
    ).not.toBeNull();
    return m!.w + 0.5 >= m!.sw;
  };
  let lo = 700; // assumed squeezed
  let hi = 2200; // assumed whole
  expect(await unsqueezed(hi), 'the bracket top (2200px) shows the brand cluster whole').toBe(true);
  expect(await unsqueezed(lo), 'the bracket floor (700px) squeezes the brand cluster').toBe(false);
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (await unsqueezed(mid)) {
      hi = mid;
    } else {
      lo = mid;
    }
  }
  return hi;
}

test('WINDOWS id 4 backstop, badge leg: min non-clipping width <= 872 clean and dirty with `Order processing` loaded [80.1 N-1b, 91-UI-SPEC 5.2]', async ({
  page,
}) => {
  const h = await mockRenderSocket(page);
  await page.addInitScript(() => {
    try {
      localStorage.setItem('fab.onboarding.seen.v1', '1');
    } catch {
      // locked-down webview: harmless.
    }
  });
  await page.goto('/');
  await waitForChrome(page);
  await h.connected;

  h.inject(buildPacket({ tick: 123456, canUndo: true, canRedo: true, nodes: [MACHINE] }));
  // Plan 84-08: the host streams while the board plays, until the Pause below has landed
  // (`streamWhilePlaying`); at a 50% CPU quota the sweep's first probe met the Disconnected
  // sentence without it.
  const live = streamWhilePlaying(page, h, { tick: 123456, canUndo: true, canRedo: true });
  await waitForBoard(page, { machines: 1 });

  // The badge, loaded through the REAL popover rather than by poking state: the
  // two clicks quit-guard.spec.ts already uses, on the entry whose label is the
  // exported EXAMPLE_ENTRIES copy verbatim. A fresh keyframe is not a user edit,
  // so the board is still clean here and the load proceeds with no discard
  // guard; it also clears dirty, which is why it must come BEFORE the dirty leg.
  await page.getByRole('button', { name: 'Examples' }).click();
  await page.getByRole('button', { name: 'Load order processing' }).click();
  await expect(page.getByText('Order processing', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Pause' }).click();
  await expect(page.getByRole('button', { name: 'Play' })).toBeVisible();
  live.stop();

  await page.evaluate(async () => {
    await document.fonts.load('12px "Martian Mono"');
    await document.fonts.ready;
  });

  // CLEAN, with the Order processing badge in the brand cluster. It is not the widest
  // badge the app can show: "Advanced pipeline" is wider (its first clip measured
  // 1340px against 1332px in the PR #2 review). The gated widths below are unchanged.
  await expect(page.getByText('Unsaved', { exact: true })).toBeHidden();
  const clean = await minNonClippingWidth(page);
  expect(
    clean,
    `badge-leg clean min non-clipping width ${clean}px must not exceed the UI-SPEC 5.2 872px (plan 91-10)`,
  ).toBeLessThanOrEqual(872);

  // N-1c: the first-clip width, RECORDED rather than gated, and bracket-asserted
  // so it cannot pass on a search that returned its own starting bound. A
  // printed number with no assertion at all would be a check that cannot fail.
  //
  // TAKEN IN BOTH BOARD STATES, and the pair is the point. The "Unsaved" badge
  // widens the RIGHT cluster, which starts squeezing the brand cluster at a
  // WIDER viewport, so a first-clip number quoted without saying which board it
  // came from is ~60px ambiguous. The clean number is the one comparable to the
  // figure phase research produced by simulation; the dirty number is the honest
  // worst case a user with unsaved edits sees.
  const firstClipClean = await firstUnsqueezedClusterWidth(page);
  expect(
    Number.isFinite(firstClipClean),
    'the clean first-clip search returned a finite width',
  ).toBe(true);
  expect(
    firstClipClean,
    `the clean first-clip width ${firstClipClean}px must fall strictly inside the [700, 2200] bracket, not on either bound`,
  ).toBeGreaterThan(700);
  expect(firstClipClean, 'the clean first-clip width is inside the bracket').toBeLessThan(2200);

  // DIRTY, actually injected, same as the null leg: a NEW node on a diff packet.
  h.inject(buildPacket({ nodes: [MACHINE, THIRD_MACHINE], full: false, tick: 123457 }));
  await expect(page.getByText('Unsaved', { exact: true })).toBeVisible();
  const dirty = await minNonClippingWidth(page);
  expect(
    dirty,
    `badge-leg dirty min non-clipping width ${dirty}px must not exceed the UI-SPEC 5.2 872px (plan 91-10)`,
  ).toBeLessThanOrEqual(872);

  const firstClipDirty = await firstUnsqueezedClusterWidth(page);
  expect(
    Number.isFinite(firstClipDirty),
    'the dirty first-clip search returned a finite width',
  ).toBe(true);
  expect(
    firstClipDirty,
    `the dirty first-clip width ${firstClipDirty}px must fall strictly inside the [700, 2200] bracket, not on either bound`,
  ).toBeGreaterThan(700);
  expect(firstClipDirty, 'the dirty first-clip width is inside the bracket').toBeLessThan(2200);

  console.log(
    `[WINDOWS id 4] badge leg (Order processing) min non-clipping toolbar width: clean=${clean}px dirty=${dirty}px`,
  );
  console.log(
    `[WINDOWS id 4] badge leg first-clip brand cluster width: clean=${firstClipClean}px dirty=${firstClipDirty}px`,
  );
});

// The clipping check is width-driven, but honor the plan-check's "widths/DPRs"
// wording literally: re-run the CTA-bounds probe at a hiDPI device scale factor.
// boundingBox() reports CSS px regardless of DPR, so the assertion stays a
// width bound - this proves the DPR font-snapping (32-01) does not push the CTA
// off-screen at a fractional/2x device pixel ratio.
test.describe('CTA bounds at hiDPI', () => {
  test.use({ viewport: { width: 1024, height: 800 }, deviceScaleFactor: 2 });

  test('the primary CTA is never clipped at 1024px @ DPR 2 [plan-check WARNING 1]', async ({
    page,
  }) => {
    const h = await mockRenderSocket(page);
    await page.goto('/');
    await waitForChrome(page);
    await h.connected;
    h.inject(buildPacket({ tick: 123456, canUndo: true, canRedo: true }));

    const cta = page.locator('header button[data-fab-examples-trigger]');
    await expect(cta).toBeVisible();
    const box = await cta.boundingBox();
    expect(box, 'CTA has a layout box at DPR 2').not.toBeNull();
    expect(
      box!.x + box!.width,
      'CTA right edge within the 1024px viewport at DPR 2 (not clipped)',
    ).toBeLessThanOrEqual(1024 + 0.5);
  });
});

// ---------------------------------------------------------------------------
// PAUSE-TOOLBAR (plan 74.1-31, third re-walk): NO TOOLBAR BUTTON MOVES WHEN THE STATUS
// TEXT OR THE `Unsaved` BADGE CHANGES.
//
// On the walk an edit made while paused put `Paused - edits queued until Play` into the
// toolbar's button row. The row is one flex line with the transport cluster centred by
// `margin: 0 auto`, so the sentence pushed the centre buttons left by 130 to 180 px for
// the few seconds it showed: a click where Play had been landed on Undo, and on Play the
// queued Undo deleted the belt just drawn (log seq 11 DrawBelt, seq 12 Undo and Delete).
//
// The rule pinned here is geometric and total: every `header button` keeps its box,
// within half a pixel, across idle, the queued notice, the dirty badge, and both
// together, at three viewports. A second case pins where the text went: the status
// strip covers no button, no palette control and no config-panel heading, with and
// without a machine selected, and it really carries the sentence.
// ---------------------------------------------------------------------------

const QUEUED_COPY = 'Paused - edits queued until Play';
/** `STATUS_COPY.undoHeld`, transcribed: the longest sentence the readout carries. */
const HOLD_COPY = 'Paused - press Play before undo or redo';
const STRIP_VIEWPORTS = [
  { width: 1600, height: 1000 },
  { width: 1280, height: 720 },
  { width: 1024, height: 768 },
] as const;

interface ButtonBox {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Every header button's box, in DOM order, named by its accessible label or text. */
async function headerButtonBoxes(page: Page): Promise<ButtonBox[]> {
  return page.locator('header button').evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      const name = el.getAttribute('aria-label') ?? (el.textContent ?? '').trim();
      // The transport toggle renames itself Play/Pause; its box is what is compared.
      return { name: name === 'Play' || name === 'Pause' ? 'Play/Pause' : name, x: r.x, y: r.y, w: r.width, h: r.height };
    }),
  );
}

function movedBoxes(before: ButtonBox[], after: ButtonBox[]): string[] {
  if (after.map((b) => b.name).join('|') !== before.map((b) => b.name).join('|')) {
    return [`button list changed: ${after.map((b) => b.name).join(',')}`];
  }
  return after
    .map((b, i) => ({ b, a: before[i] }))
    .filter(({ a, b }) => Math.abs(a.x - b.x) > 0.5 || Math.abs(a.y - b.y) > 0.5 || Math.abs(a.w - b.w) > 0.5 || Math.abs(a.h - b.h) > 0.5)
    .map(
      ({ a, b }) =>
        `${b.name}: x ${a.x.toFixed(1)} -> ${b.x.toFixed(1)}, y ${a.y.toFixed(1)} -> ${b.y.toFixed(1)}, ` +
        `w ${a.w.toFixed(1)} -> ${b.w.toFixed(1)}, h ${a.h.toFixed(1)} -> ${b.h.toFixed(1)}`,
    );
}

/**
 * Every header button is where it was. Polled for up to 1 s so a button's own pressed
 * transition (the transport toggle sinks 1px while playing) settles first; a status that
 * moved the row would still be on screen for its full 4 s and fail.
 */
async function expectSameBoxes(page: Page, before: ButtonBox[], label: string): Promise<void> {
  await expect
    .poll(async () => movedBoxes(before, await headerButtonBoxes(page)), { message: `${label}: no header button moved`, timeout: 1_000 })
    .toEqual([]);
}

/** The status readout: the FIRST `header [role="status"]` (the Unsaved badge is the second). */
function statusReadout(page: Page) {
  return page.locator('header [role="status"]').first();
}

/** Boot a paused board with one machine, Undo available, fonts loaded. */
async function bootPausedBoard(page: Page, viewport: { width: number; height: number }) {
  await page.setViewportSize(viewport);
  const h = await mockRenderSocket(page, {
    answerQuery: (verb) => (verb === 'machine_config' ? null : undefined),
  });
  await page.goto('/');
  await waitForChrome(page);
  await h.connected;
  h.inject(buildPacket({ tick: 123456, canUndo: true, canRedo: true, nodes: [MACHINE] }));
  // The board boots playing, so the host streams until the Pause has landed.
  const live = streamWhilePlaying(page, h, { tick: 123456, canUndo: true, canRedo: true });
  try {
    await waitForBoard(page, { machines: 1 });
    // Pause first: the SAFE-01 watchdog is gated on playing, so no `Disconnected` string
    // can race the readings below, and a paused board is the walk's board.
    await page.getByRole('button', { name: 'Pause' }).click();
    await playSettled(page);
  } finally {
    live.stop();
  }
  await page.evaluate(async () => {
    await document.fonts.load('12px "Martian Mono"');
    await document.fonts.ready;
  });
  return h;
}

/** The Play button has finished un-sinking after the Pause click (no pressed transform). */
async function playSettled(page: Page): Promise<void> {
  const play = page.getByRole('button', { name: 'Play' });
  await expect(play).toBeVisible();
  await page.mouse.move(5, 300);
  await expect.poll(() => play.evaluate((el) => getComputedStyle(el).transform), { message: 'the Play button settled' }).toBe('none');
}

/**
 * Let the queued edits land, as the host does: Play (which requests the fold), the
 * host's next packet at a later tick (which ends the undo hold), then Pause again.
 */
async function landQueuedEdits(page: Page, h: Harness, tick: number, nodes: InjectNode[]): Promise<void> {
  await page.getByRole('button', { name: 'Play' }).click();
  h.inject(buildPacket({ nodes, full: false, tick, canUndo: true, canRedo: true }));
  // Playing again: the host streams until the Pause has landed (see `streamWhilePlaying`).
  const live = streamWhilePlaying(page, h, { tick, canUndo: true, canRedo: true });
  try {
    await expect(page.locator('header button[aria-label="Undo"]'), 'the queued edits landed').toBeEnabled();
    await page.getByRole('button', { name: 'Pause' }).click();
    await playSettled(page);
  } finally {
    live.stop();
  }
}

/**
 * Queue one edit on the paused board: a Ctrl+Z with Undo available and nothing queued
 * goes on the wire like any other paused edit, so the queued notice shows.
 */
async function queueOneEdit(page: Page): Promise<void> {
  await page.keyboard.press('Control+z');
  await expect(statusReadout(page), 'the paused edit is announced').toHaveText(QUEUED_COPY);
}

for (const vp of STRIP_VIEWPORTS) {
  test(`PAUSE-TOOLBAR: no header button moves when the status text or Unsaved shows, ${vp.width}x${vp.height} [74.1-31]`, async ({
    page,
  }) => {
    const h = await bootPausedBoard(page, vp);

    await expect(statusReadout(page)).toHaveText('');
    await expect(page.getByText('Unsaved', { exact: true })).toBeHidden();
    const idle = await headerButtonBoxes(page);
    expect(idle.length, 'NON-VACUITY: the header has its buttons').toBeGreaterThanOrEqual(10);

    await queueOneEdit(page);
    await expectSameBoxes(page, idle, 'queued notice');

    // A second Ctrl+Z while the first is still queued is held, and says so: the longest
    // sentence the readout carries (39 characters).
    await page.keyboard.press('Control+z');
    await expect(statusReadout(page)).toHaveText(HOLD_COPY);
    await expectSameBoxes(page, idle, 'held-undo notice');

    // The queued edits land and the board goes dirty in the same packet; a new paused
    // edit then shows the notice beside Unsaved: both at once.
    await landQueuedEdits(page, h, 123457, [MACHINE, NEW_MACHINE]);
    await expect(page.getByText('Unsaved', { exact: true })).toBeVisible();
    await queueOneEdit(page);
    await expectSameBoxes(page, idle, 'queued notice and Unsaved');

    // The notice auto-clears; the badge stays.
    await expect(statusReadout(page)).toHaveText('', { timeout: 8000 });
    await expect(page.getByText('Unsaved', { exact: true })).toBeVisible();
    await expectSameBoxes(page, idle, 'Unsaved alone');
  });

  test(`PAUSE-TOOLBAR: the status strip covers no control and no panel heading, and no panel covers it, ${vp.width}x${vp.height} [74.1-31]`, async ({
    page,
  }) => {
    const h = await bootPausedBoard(page, vp);
    let tick = 123457;
    h.inject(buildPacket({ nodes: [MACHINE, NEW_MACHINE], full: false, tick, canUndo: true, canRedo: true }));
    await expect(page.getByText('Unsaved', { exact: true })).toBeVisible();

    // The widest strip the app shows: the longest sentence (the held undo) beside Unsaved.
    const overlaps = async (label: string): Promise<string[]> => {
      await queueOneEdit(page);
      await page.keyboard.press('Control+z');
      const strip = page.locator('header [data-fab-status-strip]');
      await expect(strip, `${label}: the strip exists`).toHaveCount(1);
      await expect(strip, `${label}: the strip carries the status sentence`).toContainText(HOLD_COPY);
      await expect(strip, `${label}: and the Unsaved badge`).toContainText('Unsaved');
      return page.evaluate(() => {
        const strip = document.querySelector('header [data-fab-status-strip]') as HTMLElement;
        const s = strip.getBoundingClientRect();
        const hit = (r: DOMRect): boolean =>
          r.width > 0 && r.height > 0 && s.left < r.right && r.left < s.right && s.top < r.bottom && r.top < s.bottom;
        const out: string[] = [];
        // Buttons and headings it must not cover, and every panel (`aside`) that would
        // cover IT: the ConfigPanel and the Help panel both dock at 116 px, inside the strip's
        // band, so the strip is measured left of whichever shows.
        for (const el of Array.from(document.querySelectorAll('button, #fab-config-heading, #fab-palette-heading, aside'))) {
          if (strip.contains(el)) continue;
          const r = el.getBoundingClientRect();
          if (hit(r)) {
            const name = el.getAttribute('aria-label') ?? (el.textContent ?? '').trim().slice(0, 30);
            out.push(`${el.tagName.toLowerCase()} "${name}" at ${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`);
          }
        }
        out.unshift(`strip ${Math.round(s.left)},${Math.round(s.top)} ${Math.round(s.width)}x${Math.round(s.height)}`);
        return out;
      });
    };

    const clear = await overlaps('no selection');
    console.log(`[74.1-31 strip] ${vp.width}x${vp.height} no selection: ${clear.join(' | ')}`);
    expect(clear.slice(1), 'no selection: the strip covers nothing').toEqual([]);

    // The Help panel open (the other top-right panel). It is checked first, with nothing
    // selected: Help and the ConfigPanel share one top-right slot (phase 91, UI-SPEC 2.3), so a
    // selection closes Help.
    tick += 1;
    await landQueuedEdits(page, h, tick, [MACHINE, NEW_MACHINE]);
    await expect(statusReadout(page)).toHaveText('', { timeout: 8000 });
    await page.getByRole('button', { name: 'Help' }).click();
    await expect(page.locator('#fab-help-panel')).toBeVisible();
    const help = await overlaps('Help open');
    console.log(`[74.1-31 strip] ${vp.width}x${vp.height} Help open: ${help.join(' | ')}`);
    expect(help.slice(1), 'Help open: the strip covers nothing and nothing covers it').toEqual([]);
    await page.getByRole('button', { name: 'Help' }).click();
    await expect(page.locator('#fab-help-panel')).toHaveCount(0);

    // The queued edit lands (a later tick), and the notice clears.
    tick += 1;
    await landQueuedEdits(page, h, tick, [MACHINE, NEW_MACHINE]);
    await expect(statusReadout(page)).toHaveText('', { timeout: 8000 });
    // Select the machine: its body cell, through the camera the keyframe fitted.
    const at = await screenCellCentre(page, MACHINE.cell_x, MACHINE.cell_y);
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    await page.mouse.up();
    await expect(page.locator('#fab-config-heading'), 'the machine is selected').toBeVisible();
    const selected = await overlaps('machine selected');
    console.log(`[74.1-31 strip] ${vp.width}x${vp.height} machine selected: ${selected.join(' | ')}`);
    expect(selected.slice(1), 'machine selected: the strip covers nothing').toEqual([]);

  });
}

// ---------------------------------------------------------------------------
// PHASE 91, PLAN 91-10 (CHROME-15, D-14, UI-SPEC 5.1 to 5.3): THE TRANSPORT NEVER MOVES, AND THE
// WORDMARK IS WHOLE OR NOT DRAWN.
//
// Measured at the start of phase 91 (91-MEASURE.md `## CHROME-15: still broken`): the header was
// one flex row with the transport centred by an auto margin, the scene badge sat in the brand
// cluster beside the lockup, and that cluster was the row's clip victim. So Play moved with the
// badge's text (up to 59 px between a user board and `Advanced pipeline`), and at 1024 CSS px the
// lockup was clipped to a sliver. The header is now a three-column grid with the lockup alone in
// the left column, the badge in the status strip, and the reclaims of UI-SPEC 5.1, so nothing in
// the row depends on the scene, the dirty state or the tick.
//
// Graded by bounding boxes, never a snapshot (D-17). 1083 x 677 is the user's real 1.18 text scale
// (a 1280 x 800 device window), taken as a CSS viewport with the device scale for rasterising,
// never as a device scale alone (research Finding O).
// ---------------------------------------------------------------------------

const TRANSPORT_VIEWPORTS = [
  { width: 1024, height: 768, dpr: 1, playX: 198 },
  { width: 1083, height: 677, dpr: 1.1818, playX: 257 },
  { width: 1280, height: 800, dpr: 1, playX: 454 },
  { width: 1600, height: 1000, dpr: 1, playX: 648 },
] as const;

/** The three shipped examples: the popover entry and the name the scene badge shows. */
const EXAMPLE_SCENES = [
  { entry: 'Load demo scene', name: 'Demo scene' },
  { entry: 'Load order processing', name: 'Order processing' },
  { entry: 'Load advanced pipeline', name: 'Advanced pipeline' },
] as const;

/** The tick probes past the keyframe's `tick 1`: the widest grouped form below the compact
 *  threshold, the threshold itself and a compact reading past it (UI-SPEC 5.1). */
const TRANSPORT_TICKS = [
  { tick: 9_999_999, text: 'tick 9,999,999' },
  { tick: 10_000_000, text: 'tick 10M' },
  { tick: 12_345_678, text: 'tick 12.3M' },
] as const;

/** Play's left edge in CSS px (the transport toggle reads Play while paused). */
async function playLeft(page: Page): Promise<number> {
  return page
    .locator('header button[aria-label="Play"], header button[aria-label="Pause"]')
    .first()
    .evaluate((el) => el.getBoundingClientRect().left);
}

/** Boot a paused board with one machine at tick 1, the welcome card suppressed, fonts loaded. Tick 1,
 *  not 0: the toolbar reads `tick 0` before any packet lands, so `waitForBoard`'s toolbar leg can
 *  grade the chrome drawing this board only at a later tick (review WR-C01). */
async function bootTransportBoard(page: Page): Promise<Harness> {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('fab.onboarding.seen.v1', '1');
    } catch {
      // locked-down webview: harmless.
    }
  });
  const h = await mockRenderSocket(page, {
    answerQuery: (verb) => (verb === 'machine_config' ? null : undefined),
  });
  await page.goto('/');
  await waitForChrome(page);
  await h.connected;
  h.inject(buildPacket({ tick: 1, canUndo: true, canRedo: true, nodes: [MACHINE] }));
  const live = streamWhilePlaying(page, h, { tick: 1, canUndo: true, canRedo: true });
  try {
    await waitForBoard(page, { machines: 1, tick: 1 });
    await page.getByRole('button', { name: 'Pause' }).click();
    await playSettled(page);
  } finally {
    live.stop();
  }
  await page.evaluate(async () => {
    await document.fonts.load('12px "Martian Mono"');
    await document.fonts.ready;
  });
  return h;
}

/** Load a shipped example through the real popover, through the discard guard when dirty. */
async function loadExampleScene(page: Page, entry: string, name: string): Promise<void> {
  await page.locator('header').getByRole('button', { name: 'Examples' }).click();
  await page.getByRole('button', { name: entry }).click();
  const guard = page.locator('.fab-dialog-panel');
  if (await guard.isVisible()) {
    await guard.getByRole('button', { name: 'Discard' }).click();
    await expect(guard).toBeHidden();
  }
  await expect(page.locator('header').getByText(name, { exact: true }), `the ${name} badge shows`).toBeAttached();
  await expect(page.getByText('Unsaved', { exact: true }), `${name} loads clean`).toBeHidden();
}

for (const vp of TRANSPORT_VIEWPORTS) {
  test.describe(`the transport never moves at ${vp.width}x${vp.height}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.dpr });

    test(`the transport never moves: Play holds one x across boards, scenes, dirty states and ticks, ${vp.width}x${vp.height} [CHROME-15]`, async ({
      page,
    }) => {
      test.setTimeout(90_000);
      const h = await bootTransportBoard(page);
      const reads: { label: string; x: number }[] = [];
      const texts: { want: string; got: string }[] = [];
      const read = async (label: string): Promise<void> => {
        reads.push({ label, x: await playLeft(page) });
      };

      await expect.poll(() => tickText(page)).toBe('tick 1');
      await read('user board, clean, tick 1');
      let tick = 1;
      for (const probe of TRANSPORT_TICKS) {
        const before = await tickText(page);
        tick = probe.tick;
        h.inject(buildPacket({ tick, canUndo: true, canRedo: true, full: false }));
        await expect.poll(() => tickText(page), { message: `the tick readout moves off ${before}` }).not.toBe(before);
        texts.push({ want: probe.text, got: await tickText(page) });
        await read(`user board, clean, ${probe.text}`);
      }

      let nextId = 10;
      const dirtyIt = async (): Promise<void> => {
        tick += 1;
        h.inject(
          buildPacket({
            nodes: [MACHINE, { id: nextId, kind: 0, cell_x: 14 + 2 * (nextId - 10), cell_y: 8 }],
            full: false,
            tick,
            canUndo: true,
            canRedo: true,
          }),
        );
        nextId += 1;
        await expect(page.getByText('Unsaved', { exact: true }), 'the board is dirty').toBeVisible();
      };

      await dirtyIt();
      await read('user board, dirty');
      for (const scene of EXAMPLE_SCENES) {
        await loadExampleScene(page, scene.entry, scene.name);
        await read(`${scene.name}, clean`);
        await dirtyIt();
        await read(`${scene.name}, dirty`);
      }

      const first = reads[0].x;
      console.log(
        `P91-CHROME-15 transport ${vp.width}x${vp.height} play_x=${first.toFixed(2)} ` +
          `spread=${(Math.max(...reads.map((r) => r.x)) - Math.min(...reads.map((r) => r.x))).toFixed(2)} ` +
          reads.map((r) => `[${r.label}: ${r.x.toFixed(2)}]`).join(' '),
      );
      expect(
        reads.filter((r) => Math.abs(r.x - first) > 0.01).map((r) => `${r.label}: ${r.x.toFixed(2)} (first ${first.toFixed(2)})`),
        `${vp.width}x${vp.height}: Play's left x is identical to 0.01 px across a user board, the three examples, clean and dirty, and every tick`,
      ).toEqual([]);
      expect(Math.abs(first - vp.playX), `${vp.width}x${vp.height}: Play sits at the UI-SPEC 5.2 column (${vp.playX} +-1)`).toBeLessThanOrEqual(1);
      expect(texts.map((t) => t.got), 'the tick readout goes compact from 10,000,000').toEqual(texts.map((t) => t.want));
    });
  });
}

/** The lockup's box, the part of it its clipping ancestor shows, its wrapper and its column. */
async function readLockup(page: Page) {
  return page.evaluate(() => {
    const lockup = document.querySelector('header [data-testid="header-lockup"]');
    if (lockup === null) throw new Error('no header lockup');
    const r = lockup.getBoundingClientRect();
    let clip: Element | null = null;
    for (let el = lockup.parentElement; el !== null && el.tagName !== 'HEADER'; el = el.parentElement) {
      if (getComputedStyle(el).overflowX !== 'visible') {
        clip = el;
        break;
      }
    }
    const c = clip?.getBoundingClientRect();
    const shown = c === undefined ? r.width : Math.max(0, Math.min(r.right, c.right) - Math.max(r.left, c.left));
    const wrapper = lockup.parentElement as HTMLElement;
    return {
      width: r.width,
      shown,
      wrapper: { scrollWidth: wrapper.scrollWidth, clientWidth: wrapper.clientWidth },
      visibility: getComputedStyle(lockup).visibility,
      h1: document.querySelector('header h1')?.textContent ?? null,
    };
  });
}

const LOCKUP_W = 145.8;

for (const vp of [
  { width: 1024, height: 768, dpr: 1 },
  { width: 1083, height: 677, dpr: 1.1818 },
] as const) {
  test.describe(`the lockup at ${vp.width}x${vp.height}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.dpr });

    test(`the lockup is whole at ${vp.width}x${vp.height}, on a user board and with the longest scene loaded [CHROME-15]`, async ({
      page,
    }) => {
      await bootTransportBoard(page);
      const legs: string[] = [];
      for (const leg of ['user board', 'Advanced pipeline']) {
        if (leg === 'Advanced pipeline') await loadExampleScene(page, 'Load advanced pipeline', 'Advanced pipeline');
        await expect
          .poll(async () => {
            const m = await readLockup(page);
            return m.shown >= m.width - 0.5 && m.visibility === 'visible';
          }, { message: `${leg}: the lockup settles whole`, timeout: 2_000 })
          .toBe(true)
          .catch(() => undefined);
        const m = await readLockup(page);
        console.log(`P91-CHROME-15 lockup ${vp.width}x${vp.height} ${leg} ${JSON.stringify(m)}`);
        if (Math.abs(m.width - LOCKUP_W) > 0.5) legs.push(`${leg}: the lockup box is ${m.width.toFixed(2)} wide, not ${LOCKUP_W}`);
        if (m.shown < m.width - 0.5) legs.push(`${leg}: only ${m.shown.toFixed(2)} of its ${m.width.toFixed(2)} px are shown`);
        if (m.wrapper.scrollWidth !== m.wrapper.clientWidth) {
          legs.push(`${leg}: its wrapper clips (scrollWidth ${m.wrapper.scrollWidth}, clientWidth ${m.wrapper.clientWidth})`);
        }
        if (m.visibility !== 'visible') legs.push(`${leg}: the lockup is ${m.visibility}`);
        if (m.h1 !== 'Fabrico') legs.push(`${leg}: the visually hidden heading reads ${String(m.h1)}`);
      }
      expect(legs, `${vp.width}x${vp.height}: the wordmark reads whole (UI-SPEC 5.3)`).toEqual([]);
    });
  });
}

test.describe('the lockup below its column', () => {
  test.use({ viewport: { width: 1000, height: 768 } });

  test('below 1018 CSS px the lockup is hidden whole, never clipped to a sliver, and the heading stays [CHROME-15]', async ({
    page,
  }) => {
    await bootTransportBoard(page);
    await expect
      .poll(async () => (await readLockup(page)).visibility, { message: 'the lockup hides at 1000 wide', timeout: 2_000 })
      .toBe('hidden')
      .catch(() => undefined);
    const m = await readLockup(page);
    console.log(`P91-CHROME-15 lockup 1000x768 ${JSON.stringify(m)}`);
    expect(
      { visibility: m.visibility, narrower: m.width < LOCKUP_W - 0.5, h1: m.h1 },
      'at 1000 wide the lockup is not drawn at all (visibility hidden), keeps its natural box, and the heading stays',
    ).toEqual({ visibility: 'hidden', narrower: false, h1: 'Fabrico' });
  });
});

// ---------------------------------------------------------------------------
// PHASE 91, PLAN 91-10 (CHROME-15, D-14, UI-SPEC 5.4, 5.5 and 5.x): THE SCENE BADGE READS WHOLE IN
// THE STATUS STRIP, AND THE OPEN EXAMPLES POPOVER NEVER COVERS IT OR `Unsaved`.
//
// Measured at the start of phase 91: the badge sat in the brand cluster, the row's clip victim,
// so it was cut mid-word (at 1024 and 1083 CSS px it had no room at all), and the Examples popover
// hung over the strip and covered `Unsaved`. The badge now lives in `[data-fab-status-strip]`
// between the status and `Unsaved`, ellipsizes only when its own line is narrower than it (and
// takes pointer events only then, so its title can show: the strip lies over the fitted board),
// and the strip dodges the open popover as it dodges the inspector and Help.
//
// The strip is `pointer-events: none` by design, so a plain `elementFromPoint` would answer the
// board under it. The hit tests below lift the strip's and `Unsaved`'s pointer events for the one
// read and put them back: what is read is the paint order at that point, which is what the user's
// eye meets.
// ---------------------------------------------------------------------------

const STRIP_SIZES = [
  { width: 1024, height: 768, dpr: 1 },
  { width: 1280, height: 800, dpr: 1 },
  { width: 1083, height: 677, dpr: 1.1818 },
] as const;

/** The badge inside the strip, and the rule its truncation obeys. */
async function readBadge(page: Page) {
  return page.evaluate(() => {
    const strip = document.querySelector('header [data-fab-status-strip]');
    const badges = strip === null ? [] : Array.from(strip.querySelectorAll<HTMLElement>('[data-fab-scene-badge]'));
    const anywhere = document.querySelectorAll('[data-fab-scene-badge]').length;
    const b = badges[0];
    if (b === undefined) return { inStrip: 0, anywhere };
    const cs = getComputedStyle(b);
    const r = b.getBoundingClientRect();
    return {
      inStrip: badges.length,
      anywhere,
      text: (b.textContent ?? '').trim(),
      title: b.getAttribute('title'),
      scrollWidth: b.scrollWidth,
      clientWidth: b.clientWidth,
      visible: r.width > 0 && r.height > 0 && cs.visibility === 'visible',
      textOverflow: cs.textOverflow,
      pointerEvents: cs.pointerEvents,
    };
  });
}

/** What is painted on top at an element's centre, the strip's pointer events lifted for the read. */
async function topmostAtCentre(page: Page, selector: string): Promise<{ own: boolean; hit: string }> {
  return page.evaluate((sel) => {
    const el = document.querySelector<HTMLElement>(sel);
    const strip = document.querySelector<HTMLElement>('header [data-fab-status-strip]');
    if (el === null || strip === null) throw new Error(`no ${sel} or no strip`);
    const lifted = [strip, ...Array.from(strip.querySelectorAll<HTMLElement>('*'))];
    const prev = lifted.map((x) => x.style.pointerEvents);
    lifted.forEach((x) => (x.style.pointerEvents = 'auto'));
    try {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      const own = hit !== null && (hit === el || el.contains(hit));
      const name =
        hit === null
          ? 'NOTHING'
          : (hit.closest('[id]')?.id ?? '') + ' ' + hit.tagName.toLowerCase() + ' ' + (hit.textContent ?? '').trim().slice(0, 24);
      return { own, hit: name };
    } finally {
      lifted.forEach((x, i) => (x.style.pointerEvents = prev[i]));
    }
  }, selector);
}

function intersects(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

for (const vp of STRIP_SIZES) {
  test.describe(`the scene badge at ${vp.width}x${vp.height}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.dpr });

    test(`the scene badge reads whole in the status strip for every example, ${vp.width}x${vp.height} [CHROME-15]`, async ({
      page,
    }) => {
      test.setTimeout(60_000);
      await bootTransportBoard(page);
      const faults: string[] = [];
      for (const scene of EXAMPLE_SCENES) {
        await loadExampleScene(page, scene.entry, scene.name);
        const m = await readBadge(page);
        const sw = m.scrollWidth ?? 0;
        const cw = m.clientWidth ?? 0;
        console.log(`P91-CHROME-15 badge ${vp.width}x${vp.height} ${scene.name} ${JSON.stringify(m)}`);
        if (m.inStrip !== 1) {
          faults.push(`${scene.name}: ${m.inStrip} badge(s) in the strip, ${m.anywhere} [data-fab-scene-badge] in the page`);
          continue;
        }
        if (!m.visible) faults.push(`${scene.name}: the badge is not visible`);
        if (m.text !== scene.name || m.title !== scene.name) faults.push(`${scene.name}: text ${m.text}, title ${String(m.title)}`);
        if (sw !== cw) faults.push(`${scene.name}: cut (scrollWidth ${sw}, clientWidth ${cw})`);
        if (sw > cw && (m.textOverflow !== 'ellipsis' || m.pointerEvents !== 'auto')) {
          faults.push(`${scene.name}: truncated without the ellipsis rule (${m.textOverflow}, ${m.pointerEvents})`);
        }
        if (sw <= cw && m.pointerEvents !== 'none') {
          faults.push(`${scene.name}: whole but takes pointer events (${m.pointerEvents}), over the board`);
        }
      }

      // The truncation rule itself, on a badge squeezed below its text (T-91-32): ellipsis, and
      // pointer events only while cut, so its title can show. Squeezed by an inline cap for the read.
      if ((await readBadge(page)).inStrip === 1) {
        await page.evaluate(() => {
          (document.querySelector('[data-fab-scene-badge]') as HTMLElement).style.maxWidth = '70px';
        });
        await expect
          .poll(async () => {
            const m = await readBadge(page);
            return { cut: (m.scrollWidth ?? 0) > (m.clientWidth ?? 0), textOverflow: m.textOverflow, pointerEvents: m.pointerEvents };
          }, { message: 'a squeezed badge ellipsizes and takes pointer events' })
          .toEqual({ cut: true, textOverflow: 'ellipsis', pointerEvents: 'auto' });
        await page.evaluate(() => {
          (document.querySelector('[data-fab-scene-badge]') as HTMLElement).style.maxWidth = '';
        });
        await expect
          .poll(async () => (await readBadge(page)).pointerEvents, { message: 'whole again, it gives the board its clicks back' })
          .toBe('none');
      }

      // New: a user board names no scene.
      await page.locator('header').getByRole('button', { name: 'New' }).click();
      await expect(page.locator('[data-fab-scene-badge]'), 'the badge is absent after New').toHaveCount(0);
      await expect(page.getByText('Advanced pipeline', { exact: true }), 'and so is its name').toHaveCount(0);
      expect(faults, `${vp.width}x${vp.height}: every example's name reads whole in the strip (UI-SPEC 5.4)`).toEqual([]);
    });
  });
}

// PHASE 91 UI REVIEW ITEM 4 AND REVIEW IN-B-05: THE BADGE HOLDS ITS DESCENDERS, AND THE STRIP
// HOLDS IT EVENLY. The badge clips its text at its padding box (`overflow: hidden`, for the
// ellipsis), and at `lineHeight: 1` the line box was the font size, so the `p` and `g` of `Order
// processing` were cut by its bottom border (the 91-11 walk, 1024 unscaled). Graded by glyph ink,
// not by a font metric: the badge is drawn twice with its clip lifted, once with its text and once
// with the text transparent, and any pixel that differs outside the padding box is ink the clip
// would cut. And the always-mounted status readout, empty while no status shows, was a zero-width
// flex item whose row gap put 8 px before the badge, so the strip read 16 px on the left and 8 on
// the right.
for (const vp of STRIP_SIZES) {
  test.describe(`the scene badge's ink and the strip's padding at ${vp.width}x${vp.height}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.dpr });

    test(`no glyph is cut by the badge, and the strip pads it evenly, ${vp.width}x${vp.height} (UI review 4, IN-B-05)`, async ({ page }) => {
      test.setTimeout(60_000);
      await bootTransportBoard(page);
      for (const scene of EXAMPLE_SCENES) {
        await loadExampleScene(page, scene.entry, scene.name);
        const g = await page.evaluate(() => {
          const b = document.querySelector<HTMLElement>('[data-fab-scene-badge]')!;
          const strip = document.querySelector<HTMLElement>('header [data-fab-status-strip]')!;
          const r = b.getBoundingClientRect();
          const sr = strip.getBoundingClientRect();
          const status = strip.querySelector<HTMLElement>('[role="status"]');
          return {
            border: { left: r.left, top: r.top, width: r.width, height: r.height },
            padTop: r.top + b.clientTop,
            padBottom: r.top + b.clientTop + b.clientHeight,
            stripLeft: sr.left,
            stripRight: sr.right,
            statusText: (status?.textContent ?? '').trim(),
            last: strip.lastElementChild === b,
          };
        });
        const clip = { x: g.border.left - 2, y: g.border.top - 6, width: g.border.width + 4, height: g.border.height + 12 };
        const shot = async (css: string): Promise<ReturnType<typeof PNG.sync.read>> => {
          await page.evaluate((c) => {
            const b = document.querySelector<HTMLElement>('[data-fab-scene-badge]')!;
            b.style.cssText += c;
          }, css);
          return PNG.sync.read(await page.screenshot({ clip, animations: 'disabled' }));
        };
        const before = await page.evaluate(() => document.querySelector<HTMLElement>('[data-fab-scene-badge]')!.style.cssText);
        const inked = await shot('overflow: visible; text-overflow: clip;');
        const blank = await shot('color: transparent;');
        await page.evaluate((c) => {
          document.querySelector<HTMLElement>('[data-fab-scene-badge]')!.style.cssText = c;
        }, before);
        const sy = inked.height / clip.height;
        const top = Math.floor((g.padTop - clip.y) * sy);
        const bottom = Math.ceil((g.padBottom - clip.y) * sy);
        let inside = 0;
        let outside = 0;
        for (let y = 0; y < inked.height; y += 1) {
          for (let x = 0; x < inked.width; x += 1) {
            const i = (y * inked.width + x) * 4;
            const d = Math.max(
              Math.abs(inked.data[i] - blank.data[i]),
              Math.abs(inked.data[i + 1] - blank.data[i + 1]),
              Math.abs(inked.data[i + 2] - blank.data[i + 2]),
            );
            if (d <= 24) continue;
            if (y >= top && y < bottom) inside += 1;
            else outside += 1;
          }
        }
        const line = `${scene.name} ${vp.width}x${vp.height} ink inside=${inside} outside=${outside} ${JSON.stringify(g)}`;
        console.log(`P91-UI4 badge ${line}`);
        expect(inside, `NON-VACUITY: ${scene.name}'s text draws ink inside the badge (${line})`).toBeGreaterThan(50);
        expect(outside, `${scene.name}: no glyph ink falls outside the badge's padding box, where its clip cuts it (${line})`).toBe(0);

        expect(g.statusText, `PRECONDITION: ${scene.name} loads with no status line`).toBe('');
        expect(g.last, `PRECONDITION: the badge is the strip's last item (the board is clean)`).toBe(true);
        const left = g.border.left - g.stripLeft;
        const right = g.stripRight - (g.border.left + g.border.width);
        expect(Math.abs(left - right), `${scene.name}: the strip pads the badge evenly, ${left} on the left, ${right} on the right`).toBeLessThanOrEqual(0.5);
      }
    });
  });
}

for (const vp of [...STRIP_SIZES, { width: 1600, height: 1000, dpr: 1 }] as const) {
  test.describe(`the Examples popover at ${vp.width}x${vp.height}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.dpr });

    test(`the open Examples popover covers neither Unsaved nor the scene badge, ${vp.width}x${vp.height} [CHROME-15]`, async ({
      page,
    }) => {
      const h = await bootTransportBoard(page);
      await loadExampleScene(page, 'Load advanced pipeline', 'Advanced pipeline');
      h.inject(buildPacket({ nodes: [MACHINE, NEW_MACHINE], full: false, tick: 1, canUndo: true, canRedo: true }));
      await expect(page.getByText('Unsaved', { exact: true })).toBeVisible();
      await page.locator('header').getByRole('button', { name: 'Examples' }).click();
      const popover = page.locator('#fab-examples-popover');
      await expect(popover).toBeVisible();
      const faults: string[] = [];
      await expect
        .poll(async () => {
          const p = await popover.boundingBox();
          const u = await page.getByText('Unsaved', { exact: true }).boundingBox();
          return p !== null && u !== null && !intersects(p, u);
        }, { message: 'the strip settles left of the open popover', timeout: 2_000 })
        .toBe(true)
        .catch(() => undefined);
      const p = (await popover.boundingBox())!;
      // `Unsaved` is found by its exact words (it has no attribute of its own); the badge by its
      // attribute (review IN-C06: a selector beside `Unsaved` here was never read).
      for (const [label, sel] of [
        ['Unsaved', null],
        ['the scene badge', '[data-fab-scene-badge]'],
      ] as const) {
        const loc = sel === null ? page.getByText('Unsaved', { exact: true }) : page.locator(sel);
        if ((await loc.count()) !== 1) {
          faults.push(`${label}: ${await loc.count()} on the page`);
          continue;
        }
        const b = (await loc.boundingBox())!;
        if (intersects(p, b)) {
          faults.push(`${label} at ${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.width)}x${Math.round(b.height)} is under the popover at ${Math.round(p.x)},${Math.round(p.y)}`);
        }
      }
      await page.evaluate(() => {
        const u = Array.from(document.querySelectorAll('header [data-fab-status-strip] *')).find(
          (el) => (el.textContent ?? '').trim() === 'Unsaved' && el.children.length === 0,
        );
        u?.setAttribute('data-test-unsaved', '');
      });
      const hit = await topmostAtCentre(page, '[data-test-unsaved]');
      if (!hit.own) faults.push(`Unsaved's centre hits ${hit.hit}`);
      console.log(`P91-CHROME-15 popover ${vp.width}x${vp.height} popover=${JSON.stringify(p)} hit=${JSON.stringify(hit)} faults=${JSON.stringify(faults)}`);
      expect(faults, `${vp.width}x${vp.height}: with Examples open, Unsaved and the badge stay whole and uncovered (UI-SPEC 5.5)`).toEqual([]);
    });
  });
}

for (const vp of [
  { width: 1024, height: 768, dpr: 1 },
  { width: 1083, height: 677, dpr: 1.1818 },
] as const) {
  test.describe(`the strip beside Help at ${vp.width}x${vp.height}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.dpr });

    test(`Help open strip: the longest status, the badge and Unsaved are whole beside Help, ${vp.width}x${vp.height} [CHROME-15]`, async ({
      page,
    }) => {
      const h = await bootTransportBoard(page);
      await loadExampleScene(page, 'Load advanced pipeline', 'Advanced pipeline');
      h.inject(buildPacket({ nodes: [MACHINE, NEW_MACHINE], full: false, tick: 1, canUndo: true, canRedo: true }));
      await expect(page.getByText('Unsaved', { exact: true })).toBeVisible();
      await page.locator('header').getByRole('button', { name: 'Help' }).click();
      await expect(page.locator('#fab-help-panel')).toBeVisible();
      await queueOneEdit(page);
      await page.keyboard.press('Control+z');
      await expect(statusReadout(page)).toHaveText(HOLD_COPY);
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      const m = await page.evaluate(() => {
        const strip = document.querySelector('header [data-fab-status-strip]') as HTMLElement;
        const help = (document.querySelector('#fab-help-panel') as HTMLElement).getBoundingClientRect();
        const s = strip.getBoundingClientRect();
        const readout = strip.querySelector('[role="status"]') as HTMLElement;
        const out: string[] = [];
        const inside = (r: DOMRect): boolean => r.left >= s.left - 0.5 && r.right <= s.right + 0.5 && r.top >= s.top - 0.5 && r.bottom <= s.bottom + 0.5;
        const overHelp = (r: DOMRect): boolean => r.left < help.right && help.left < r.right && r.top < help.bottom && help.top < r.bottom;
        // Every word of the status, by a Range over each word of its text node.
        const walker = document.createTreeWalker(readout, NodeFilter.SHOW_TEXT);
        let words = 0;
        for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
          const text = n.textContent ?? '';
          for (const m of text.matchAll(/\S+/g)) {
            const range = document.createRange();
            range.setStart(n, m.index!);
            range.setEnd(n, m.index! + m[0].length);
            const rects = Array.from(range.getClientRects());
            words += 1;
            if (rects.length !== 1) out.push(`the word "${m[0]}" is drawn in ${rects.length} pieces`);
            for (const r of rects) {
              if (r.width <= 0 || !inside(r)) out.push(`the word "${m[0]}" at ${Math.round(r.left)}..${Math.round(r.right)} is outside the strip ${Math.round(s.left)}..${Math.round(s.right)}`);
              if (overHelp(r)) out.push(`the word "${m[0]}" is under Help`);
            }
          }
        }
        for (const [label, el] of [
          ['the scene badge', strip.querySelector('[data-fab-scene-badge]')],
          ['Unsaved', Array.from(strip.querySelectorAll('*')).find((e) => (e.textContent ?? '').trim() === 'Unsaved' && e.children.length === 0) ?? null],
        ] as const) {
          if (el === null) {
            out.push(`${label} is not in the strip`);
            continue;
          }
          const r = el.getBoundingClientRect();
          if (!inside(r)) out.push(`${label} at ${Math.round(r.left)}..${Math.round(r.right)} is outside the strip`);
          if (overHelp(r)) out.push(`${label} is under Help`);
          if (el.scrollWidth > el.clientWidth) out.push(`${label} is cut`);
        }
        if (strip.scrollWidth > strip.clientWidth + 0.5) out.push(`the strip overflows (${strip.scrollWidth} > ${strip.clientWidth})`);
        return { words, out, strip: { left: s.left, right: s.right, top: s.top, bottom: s.bottom }, helpLeft: help.left };
      });
      console.log(`P91-CHROME-15 help-strip ${vp.width}x${vp.height} ${JSON.stringify(m)}`);
      expect(m.words, 'NON-VACUITY: the status words were read').toBe(HOLD_COPY.split(' ').length);
      expect(m.out, `${vp.width}x${vp.height}: with Help open the status wraps between words and the badge and Unsaved stay whole (UI-SPEC 5.x)`).toEqual([]);
    });
  });
}
