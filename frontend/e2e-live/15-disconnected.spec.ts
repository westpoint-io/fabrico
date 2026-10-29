import { test, expect, type Page } from '@playwright/test';
import { expectRenderLoopAlive, readScene, waitForAppReady, watchPageErrors } from './support/oracle';

// 15-disconnected.spec.ts (SAFE-01) - the honest disconnected state gate.
//
// When the render stream drops WHILE PLAYING, the app must stop passing the
// frozen last frame off as live: the role="status" aria-live readout announces
// "Disconnected - live view frozen" in the fault treatment (the destructive glyph
// beside the ink word, phase 90 UI review) and the canvas is visibly dimmed. The load-bearing correctness
// check (T-34-DISCONNECT-FALSE) is that PAUSING the sim - which legitimately
// emits ZERO packets by design - must NOT produce "Disconnected". On reconnect
// the readout clears back to idle and the dim is removed.
//
// Drive rules (mirrors 09): getByRole/getByTitle + expect.poll on the LIVE
// announced copy; nothing is injected. The one dev seam used is
// window.__fabrico.simulateStreamDrop(on), which makes the transport ignore
// inbound bytes so the watchdog stalls EXACTLY as a real dropped stream would
// (the canvas freezes; the watchdog is never reset). It writes no scene/command/
// log - it is the honest way to exercise a real producer stall in a test.
//
// Shared-host note: these specs run against ONE mutable dev host (workers:1). A
// prior spec can leave the host paused (until phase 90, D-08, a Save in 09
// Save/Load left it FROZEN too), while the frontend boots optimistically
// 'playing'. `ensureStreaming` deterministically returns the host to
// Playing+streaming before each case (the LAST control it sends is 'resume'),
// so the drop/pause behaviours are exercised against a genuine live stream.

const DISCONNECT_COPY = 'Disconnected - live view frozen';

/** Poll the live role="status" readout text (the real announced copy). */
function pollStatusText(page: Page, message: string) {
  return expect.poll(
    async () => ((await page.getByRole('status').textContent()) ?? '').trim(),
    { timeout: 15_000, intervals: [100, 250, 500], message },
  );
}

/** Toggle the dev stream-drop simulator on the real app. */
async function setStreamDrop(page: Page, on: boolean): Promise<void> {
  await page.evaluate((v) => {
    const hook = (window as { __fabrico?: { simulateStreamDrop?(on: boolean): void } }).__fabrico;
    if (!hook?.simulateStreamDrop) {
      throw new Error('window.__fabrico.simulateStreamDrop not installed');
    }
    hook.simulateStreamDrop(v);
  }, on);
}

/**
 * Return the shared host to a Playing+streaming state, whatever a prior spec left
 * it in. Toggling Play/Pause TWICE means the last control sent is always 'resume'
 * and the frontend ends optimistically playing; then we confirm a real heartbeat
 * (the tick advances across two reads) before returning.
 */
async function ensureStreaming(page: Page): Promise<void> {
  const btn = () => page.getByRole('button', { name: /^(Play|Pause)$/ });
  await btn().click();
  await page.waitForTimeout(150);
  await btn().click();
  await expect
    .poll(async () => (await readScene(page)).tick, {
      timeout: 10_000,
      intervals: [100, 200, 400],
    })
    .toBeGreaterThan(0);
  const a = (await readScene(page)).tick;
  await expect
    .poll(async () => (await readScene(page)).tick, {
      timeout: 10_000,
      intervals: [100, 200, 400],
      message: 'the host is streaming (the tick advances)',
    })
    .toBeGreaterThan(a);
}

test.describe('SAFE-01 honest disconnected state (real app + host)', () => {
  // RENDER HEALTH in every test (plan 90-02, THE RENDER-HEALTH COUNT; fabrico-model-oracle-blindspot):
  // the watcher goes in BEFORE `page.goto`, and the loop and the watcher are read after every test,
  // once the afterEach below has left the stream playing (a paused or dropped stream holds the
  // render clock by design).
  let errs: ReturnType<typeof watchPageErrors>;

  test.beforeEach(async ({ page }) => {
    errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    // Establish a genuine live stream regardless of the contaminated shared-host
    // start state, then let any transient boot-time disconnect clear to idle.
    await ensureStreaming(page);
    await pollStatusText(page, 'the readout settles to idle once the stream is live').toBe('');
  });

  test.afterEach(async ({ page }) => {
    // Hygiene: the PAUSE test pauses the SHARED host, and LoadDemo now RESPECTS a user
    // pause (CR-01), so a later spec's LoadDemo reset would inherit a Frozen sim. Leave
    // it PLAYING. The play/pause glyph is consistent within THIS page (this spec drove
    // it), so a single Play click reliably resumes (a fresh downstream page cannot,
    // because its optimistic glyph starts "playing" regardless of the real host).
    const play = page.getByRole('button', { name: 'Play' });
    if ((await play.count()) > 0) {
      const before = (await readScene(page)).tick;
      await play.click();
      await expect
        .poll(async () => (await readScene(page)).tick, {
          timeout: 8_000,
          intervals: [100, 200, 400],
          message: 'the shared sim is left streaming for the next spec',
        })
        .toBeGreaterThan(before);
    }
    await expectRenderLoopAlive(page, 'at the end of the test, the stream playing');
    errs.assertNone('the disconnected-state walk');
  });

  test('a stream drop WHILE PLAYING announces "Disconnected" with the fault treatment and dims the canvas', async ({
    page,
  }) => {
    // Sanity: before the drop the canvas is NOT dimmed - the frozen-frame overlay
    // exists only while disconnected.
    await expect(page.locator('[data-fab-disconnected-dim]')).toHaveCount(0);

    // Drop the stream while still playing: the playing-gated watchdog stalls and
    // fires 'disconnected' after the threshold (no reset because no bytes arrive).
    await setStreamDrop(page, true);

    // Cue 1 (word): the generic announced copy - never a file path (T-32-06-01).
    await pollStatusText(
      page,
      'a stream drop while playing announces the honest disconnected copy',
    ).toBe(DISCONNECT_COPY);

    const readout = page.getByRole('status');
    // Cue 2 (glyph): the WarningIcon renders ONE decorative glyph element inside the
    // readout - colour is never the only cue (red + glyph + word).
    //
    // THE ELEMENT CHANGED IN PHASE 59, THE PROPERTY DID NOT. This used to read
    // `readout.locator('span[aria-hidden]')`, because the pixel-era `SpriteIcon` drew
    // the glyph as a box-shadow sprite on a `<span>`. Plan 59-02 deleted that path:
    // every chrome icon is now an inline `<svg aria-hidden="true">` built from an
    // authored `chrome/assets/*.svg` (`icons.tsx` -> `ChromeGlyphIcon`). The span is
    // gone from the app, so the old selector matched 0 and the SPEC was the stale half.
    //
    // What the old assertion guarded, and what is re-proved below against the new
    // markup: (a) EXACTLY ONE glyph element is present while disconnected - it is
    // absent at idle, so this is a state-dependent count and not a presence-only
    // check; (b) it is `aria-hidden`, so the redundant visual cue never leaks into the
    // announced copy the test just pinned to DISCONNECT_COPY.
    const glyph = readout.locator('svg[aria-hidden="true"]');
    await expect(
      glyph,
      'the disconnected readout carries the warning glyph (a redundant non-colour cue)',
    ).toHaveCount(1);
    // ...and it is the WARNING mark specifically, drawn rather than empty. An inline
    // `<svg>` can exist with no geometry in it, which the old box-shadow span could
    // not; the three stable `data-part` handles authored in `chrome/assets/warning.svg`
    // (triangle + exclamation bar + dot) are the identity of that one glyph, so this
    // fails both on a blank `<svg>` and on the wrong icon being rendered here.
    expect(
      await glyph
        .locator('path[data-part]')
        .evaluateAll((els) => els.map((el) => el.getAttribute('data-part')).sort()),
      'the glyph is the authored warning mark (triangle + bar + dot), not an empty or wrong svg',
    ).toEqual(['bar', 'dot', 'triangle']);
    // Cue 3 (tone), phase 90 UI review (Color, finding 4): the fault's tone is the GLYPH, in
    // --fab-destructive, and the WORD is --fab-ink. The destructive word read 2.92:1 on the
    // strip's panel fill, below AA for text; ink reads 5.16:1 (the `Simulation stopped` rule).
    const { color, glyphColor, destructive, ink } = await readout.evaluate((el) => {
      const cs = getComputedStyle(el);
      const probe = (name: string): string => {
        const s = document.createElement('span');
        s.style.color = `var(${name})`;
        document.body.appendChild(s);
        const c = getComputedStyle(s).color;
        s.remove();
        return c;
      };
      const svg = el.querySelector('svg');
      return {
        color: cs.color,
        glyphColor: svg === null ? null : getComputedStyle(svg).color,
        destructive: probe('--fab-destructive'),
        ink: probe('--fab-ink'),
      };
    });
    expect(color, 'the disconnected word is the ink tone (AA on the panel fill)').toBe(ink);
    expect(glyphColor, 'the warning glyph carries the destructive tone').toBe(destructive);

    // The frozen canvas is visibly de-emphasised so the stale frame cannot pass
    // as live (the display-only stale-dim overlay).
    await expect(
      page.locator('[data-fab-disconnected-dim]'),
      'the frozen canvas is dimmed while disconnected',
    ).toBeVisible();

    // Reconnect: resume delivery. The first real packet signals reconnect and the
    // readout clears back to idle; the dim overlay is removed.
    await setStreamDrop(page, false);
    await pollStatusText(page, 'the first packet after the drop clears the readout to idle').toBe(
      '',
    );
    await expect(
      page.locator('[data-fab-disconnected-dim]'),
      'the stale-dim is removed on reconnect',
    ).toHaveCount(0);
  });

  test('PAUSING the sim does NOT announce "Disconnected" (a paused sim emits zero packets by design)', async ({
    page,
  }) => {
    // Pause: the host stops emitting packets. A naive stall watchdog would fire
    // 'Disconnected' here - the gate (arm only while playing) must suppress it.
    await page.getByTitle('Pause (Space)').click();

    // The stream goes silent (the paused/draining producer stops emitting), so the
    // frontend tick stops advancing - this is the genuine zero-packet condition a
    // naive watchdog would misread as a drop. A Pause first DRAINS in-flight items
    // (ticking) and only THEN freezes, so poll until the tick genuinely settles rather
    // than assuming a fixed window - a fresh flowing demo (a prior spec's LoadDemo
    // reset) can take longer than a fixed timeout to drain to quiescence.
    let prevTick = -1;
    await expect
      .poll(
        async () => {
          const t = (await readScene(page)).tick;
          const settled = t === prevTick;
          prevTick = t;
          return settled;
        },
        {
          message: 'the paused sim drains to a settled (frozen) tick',
          timeout: 15_000,
          intervals: [150, 200, 250],
        },
      )
      .toBe(true);
    const paused = (await readScene(page)).tick;
    await page.waitForTimeout(400);
    expect((await readScene(page)).tick, 'the paused sim stopped streaming (zero packets)').toBe(
      paused,
    );

    // Wait comfortably past the 800ms disconnect threshold: the readout must stay
    // idle and NEVER announce the disconnected fault while merely paused.
    await page.waitForTimeout(1200);
    for (let i = 0; i < 4; i += 1) {
      const t = ((await page.getByRole('status').textContent()) ?? '').trim();
      expect(t, 'a paused sim never announces "Disconnected" (T-34-DISCONNECT-FALSE)').not.toBe(
        DISCONNECT_COPY,
      );
    }
    await expect(
      page.locator('[data-fab-disconnected-dim]'),
      'a paused sim never dims the canvas as disconnected',
    ).toHaveCount(0);
  });
});
