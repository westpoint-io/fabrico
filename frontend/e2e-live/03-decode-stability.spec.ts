import { test, expect } from '@playwright/test';
import {
  readScene,
  readStats,
  pollScene,
  waitForAppReady,
  watchPageErrors,
  expectRenderLoopAlive,
} from './support/oracle';

// 03-decode-stability.spec.ts (E2E-01/E2E-03 decode channel) - the accepted
// zero-DecodeError-over-N-packets gate, N=300 (~5s of packets at 60Hz on the
// flowing demo scene).
//
// The counters come from window.__fabrico.stats() (22-01): packetsApplied
// increments after every successful decodeRenderPacket; decodeErrors counts
// the WR-07 silently-dropped DecodeError branch - the only way a decoder
// regression against REAL wire bytes is observable at all.
//
// Assertion ORDER is the anti-tamper guard (T-22-02-B): packetsApplied >= 300
// is asserted BEFORE decodeErrors === 0, because zero errors over zero
// consumed packets is meaningless - a dead WS or a no-op counter fails the
// poll timeout instead of passing vacuously. A separate tick-advance poll
// proves the sim is genuinely ticking, not replaying one frame.
//
// Order-insensitive by design: no gestures, no reset - this spec only counts
// packets, so it holds regardless of what earlier specs mutated.
//
// RENDER HEALTH IS ASSERTED HERE FROM PLAN 62-01, AND IT WAS NOT BEFORE. Every
// counter above lives in the MODEL: `packetsApplied`, `decodeErrors` and
// `scene.tick` all advance perfectly on a build whose Pixi loop is dead. That is
// not hypothetical - on 2026-08-11 the real binary painted grid and belts only,
// with no machines and no items, while 1673 vitest, 186 mock e2e, 49/50 live e2e,
// tsc and the core-freeze gate were all green. A `RenderTexture`
// freed while still bound threw inside `Application.render`, and because that runs
// as a Ticker listener the loop never re-requested a frame and stopped permanently
// on a partial frame. Phase 62 is named explicitly as a phase
// this bar binds, because it moves items - and this spec is the phase's only live
// evidence that the appended wire field survives the real host, the real decoder
// AND a live render loop. A model-only pass is not acceptable evidence here.

test.describe('E2E decode stability: the shipped decoder over real wire bytes', () => {
  test('300 consecutive REAL packets decode with zero DecodeErrors', async ({ page }) => {
    // Armed BEFORE navigation, so an error thrown during the first frames is caught.
    const pageErrors = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);

    // Gate step 1: the decoder must actually CONSUME 300 real packets first.
    await expect
      .poll(async () => (await readStats(page)).packetsApplied, {
        timeout: 20_000,
        intervals: [100, 250, 500],
        message: 'the shipped decoder consumes 300 consecutive REAL live packets',
      })
      .toBeGreaterThanOrEqual(300);

    // Gate step 2: only now is a zero error count meaningful.
    const stats = await readStats(page);
    expect(
      stats.decodeErrors,
      'the shipped decoder consumed 300 consecutive REAL packets with zero DecodeErrors',
    ).toBe(0);

    // Gate step 3: the sim is genuinely ticking, not replaying one frame.
    const tickBefore = (await readScene(page)).tick;
    await pollScene(page, (s) => s.tick, {
      message: 'the real sim tick advances between two reads (live 60Hz loop, not a stale frame)',
    }).toBeGreaterThan(tickBefore);

    // Gate step 4: RENDER health, which no counter above can see. The sim ticking and
    // the decoder consuming say nothing about whether anything reached the screen.
    await expectRenderLoopAlive(page, 'after 300 decoded packets');
    pageErrors.assertNone('during the 300-packet decode window');
  });
});
