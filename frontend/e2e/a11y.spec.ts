import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {
  buildPacket,
  mockRenderSocket,
  waitForChrome,
  type Harness,
  type PacketOpts,
} from './support/wire';

// a11y.spec.ts (TEST-04, Phase 13-04) — an axe accessibility audit of the React
// chrome ONLY.
//
// Scope is deliberate and narrow: the interactive React chrome (the Toolbar
// <header> and the Palette <aside>), with the Pixi <canvas> excluded. We never
// run axe over the canvas (it is a single opaque WebGL surface — axe has nothing
// meaningful to assert there) and we never pixel/screenshot-diff (out of scope).
test('React chrome passes axe with zero violations (canvas excluded)', async ({
  page,
}) => {
  await page.goto('/');
  // Chrome mounts only once the app is `ready`; the palette entry is the signal.
  await page.getByRole('button', { name: /Source/ }).waitFor();

  const results = await new AxeBuilder({ page })
    .include('header') // Toolbar
    .include('aside') // Palette
    .exclude('canvas') // never audit the Pixi surface
    // NOTE: 32-01 SHELL-01/05 gave the Toolbar tick its FINAL treatment - a passive
    // --fab-ink readout at the base size (16px normal text at DPR 1), no longer the
    // build accent. The raised locked ink (#b0bacb, 5.16:1 on the panel fill) passes
    // WCAG AA normal at that size, so the tick is audited here as ordinary text with
    // NO exclusion. The whole chrome (header + aside) passes with ZERO violations.
    .analyze();

  expect(results.violations).toEqual([]);
});

// ---------------------------------------------------------------------------
// SAFE-02 reduced motion (53-09)
// ---------------------------------------------------------------------------
//
// This file was the natural home for it, but note for the record: the coverage
// below is NEW, not an extension. `53-VALIDATION.md` row 18 originally recorded
// this as "exists (a11y.spec.ts) - extend"; verified first-hand before writing,
// `grep -rn "reduced motion\|reduced-motion" e2e/` returned NOTHING and the axe
// audit above carries no motion assertion of any kind. Row 18 was corrected to
// CREATE.
//
// The claim: the SHIPPED board freezes under prefers-reduced-motion. Asserted
// with an anti-vacuity control - the same board demonstrably KEEPS MOVING with
// the preference off - because a freeze assertion on a clock that never ran
// would pass for the wrong reason.
//
// The test writes to neither `reducedMotion.ts` nor the shipped App effect; this
// is coverage only.

/**
 * The MOTION-01 frame index the shipped board pins to under reduce:
 * `REDUCED_MOTION_FRAME` is `SIM_TICKS_PER_FRAME * 3` = 18 sim ticks, and
 * `quantizedFrame(18)` is `18 / 6` = frame 3 (the fault-alarm envelope's peak).
 * Re-derived here as a literal so a change to either constant fails HERE, loudly,
 * rather than being silently agreed with.
 */
const PINNED_FRAME = 3;

/**
 * A belt long enough to give the shipped board a marching tread. Straight
 * orthogonal run, which is the only shape the fixture builder encodes.
 */
// Annotated rather than `as const`. The literal is only ever READ, and `as const` made
// every tile a readonly tuple that `buildPacket(opts: PacketOpts)` refuses - two errors
// the moment `e2e/` entered `tsconfig.json`'s include. The annotation is the stronger
// read anyway: the fixture is now checked AGAINST the injector's contract at its
// declaration instead of at its two call sites.
const FIXTURE_PACKET_OPTS: PacketOpts = {
  tick: 5,
  belts: [{ id: 1, tiles: [[9, 2], [10, 2], [11, 2], [12, 2], [13, 2], [14, 2], [15, 2]] }],
};

/**
 * Sample the render loop's EFFECTIVE frame index once per animation frame for
 * `ms`, in-page. Sampling on rAF rather than sleeping-then-reading is what makes
 * "frozen" mean frozen for the whole interval instead of at two lucky instants.
 */
async function sampleFrames(page: Page, ms: number): Promise<number[]> {
  return page.evaluate(async (duration) => {
    const out: number[] = [];
    const started = performance.now();
    await new Promise<void>((resolve) => {
      const step = (): void => {
        const hook = window.__fabrico;
        if (!hook) {
          resolve();
          return;
        }
        out.push(hook.frame());
        if (performance.now() - started >= duration) resolve();
        else requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
    return out;
  }, ms);
}

/** Boot the board with a belt on it, through the mocked render socket. */
async function bootBoard(page: Page, h: Harness): Promise<void> {
  await page.goto('/');
  await waitForChrome(page);
  await h.connected;
  // Re-injected inside the poll: a navigation opens a NEW socket, and a packet
  // pushed at the previous route would be dropped silently rather than loudly.
  await expect
    .poll(
      async () => {
        h.inject(buildPacket(FIXTURE_PACKET_OPTS));
        return page.evaluate(() => window.__fabrico?.scene().belts.length ?? 0);
      },
      { message: 'the fixture belt landed on the board' },
    )
    .toBe(1);
}

/**
 * Sample the frame index while a REAL rising tick stream is fed to the page.
 *
 * A board holding one static packet is frozen whether or not anything pinned it:
 * the render loop seeds from the first packet, then either snaps to
 * `scene.tick - LAG_TICKS` or crawls toward it, so with a fixed `scene.tick` it
 * parks and stays parked. Streaming ticks while sampling is what makes "frozen"
 * mean "had somewhere to go and did not move", and it is also what lets the
 * control leg show the same board genuinely advancing.
 */
async function sampleFramesWhileStreaming(
  page: Page,
  h: Harness,
  ms: number,
  startTick = 200,
): Promise<number[]> {
  const stepMs = 25;
  const stream = (async () => {
    for (let i = 0; i * stepMs < ms + 100; i++) {
      h.inject(buildPacket({ ...FIXTURE_PACKET_OPTS, tick: startTick + i * 4 }));
      await new Promise((resolve) => setTimeout(resolve, stepMs));
    }
  })();
  const [frames] = await Promise.all([sampleFrames(page, ms), stream]);
  return frames;
}

test.describe('SAFE-02 reduced motion is honoured by the shipped board', () => {
  test('the board freezes on the representative frame, and demonstrably moves without the preference', async ({
    page,
  }) => {
    const h = await mockRenderSocket(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await bootBoard(page, h);

    const frozen = await sampleFramesWhileStreaming(page, h, 700);
    expect(frozen.length, 'the render loop ran while we sampled').toBeGreaterThan(5);
    expect(
      [...new Set(frozen)],
      'every sampled frame is the ONE pinned representative frame, through a rising tick stream',
    ).toEqual([PINNED_FRAME]);

    // ANTI-VACUITY CONTROL. A frozen reading proves nothing unless the SAME board,
    // the same fixture and the same tick stream are shown to move with the
    // preference off. The board is re-booted rather than toggled in place: verified
    // first-hand in this Chromium, `page.emulateMedia` updates `matches` but does
    // NOT dispatch `change` to an already-registered MediaQueryList, so the shipped
    // effect (which listens for `change`) only re-reads the preference on mount.
    // Emulating and then navigating fresh is therefore the honest way to flip it.
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await bootBoard(page, h);
    const live = await sampleFramesWhileStreaming(page, h, 700, 900);
    expect(
      new Set(live).size,
      'with the preference off, the same board advances through several frames',
    ).toBeGreaterThan(1);
  });
});
