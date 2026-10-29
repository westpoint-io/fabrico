import { test, expect, type Page } from '@playwright/test';
import { buildPacket, mockRenderSocket, screenCellCentre, waitForChrome, type InjectNode } from './support/wire';

// status-line-review.spec.ts (phase 90 review fix pass 2) - the page's half of five review findings,
// driven through the real App against the mock render socket, where the host's timing is built by
// hand: the packets a playing host streams, the silence while it swaps or writes, its refusal.
//
//   WR-B-02  (walk todo 2026-10-24, a Load on a running board flashes Disconnected): while a Load, a
//            Save, a New or an example the host is working on is in flight, the stall watchdog does
//            not write `Disconnected - live view frozen` over the silence. A host that never answers
//            again is still named: a Load by its own cut-off (`Load failed`, then `Disconnected`), a
//            Save or New after the settle window.
//   WR-B-03  (walk todo 2026-10-24, New before Play drops a paused Apply): an edit queued on a paused
//            board is work the guards ask about, and the guard says the queued edits will be lost.
//   WR-B-06  a refused Open keeps the `Demo scene` badge (the badge moves on the swap, D-02).
//   IN-B-04  `.` then Space in one task sends `step` then `resume` (the glyph ref follows at once).
//
// The silence is the host's: the mock stops sending packets, exactly what the sim thread does while
// `load_swap` builds the new board or `do_save` writes the file (the walk measured 1.4 s on the debug
// desktop build). `DISCONNECT_MS` is 800 (App.tsx), so a 1.5 s silence crosses it.

/** The status readout's sentence for a dropped stream (`STATUS_COPY.disconnected`). */
const DISCONNECTED = 'Disconnected - live view frozen';
/** How long the mock host stays silent through a swap or a write: above `DISCONNECT_MS` (800). */
const SWAP_SILENCE_MS = 1_500;
/** The page's settle window for a Save or New the host is working on (`STATUS_LOAD_TIMEOUT_MS`). */
const SETTLE_WINDOW_MS = 10_000;
/** `STATUS_AUTOCLEAR_MS` (App.tsx). */
const AUTOCLEAR_MS = 4_000;
const READOUT = '[data-fab-status-strip] [role="status"]';
const MACHINE: InjectNode = { id: 1, kind: 0, cell_x: 12, cell_y: 8 };

type Harness = Awaited<ReturnType<typeof mockRenderSocket>>;

/** A playing host: one diff every 16 ms, which can fall silent and speak again. */
function streamFrom(h: Harness, firstTick: number) {
  let tick = firstTick;
  let on = true;
  const id = setInterval(() => {
    if (on) h.inject(buildPacket({ tick: tick++, full: false }));
  }, 16);
  return {
    silence: () => {
      on = false;
    },
    speak: () => {
      on = true;
    },
    stop: () => clearInterval(id),
    tick: () => tick,
  };
}

/** Boot the page on one machine, playing, the stream running. */
async function bootPlaying(page: Page, answerQuery?: (verb: string) => unknown) {
  const h = await mockRenderSocket(page, answerQuery ? { answerQuery } : {});
  await page.goto('/');
  await waitForChrome(page);
  await h.connected;
  h.inject(buildPacket({ tick: 1, nodes: [MACHINE] }));
  const stream = streamFrom(h, 2);
  await expect(page.getByRole('button', { name: 'Pause' }), 'the board plays').toBeVisible();
  // Long enough for the watchdog to have seen the stream start and armed.
  await page.waitForTimeout(200);
  return { h, stream };
}

/** Record every text the status readout shows, from now until `seen` reads it. */
async function recordReadout(page: Page): Promise<void> {
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el === null) throw new Error(`recordReadout: ${sel} is not on the page`);
    const w = window as unknown as { __reviewSeen?: string[] };
    const seen: string[] = [];
    const sample = (): void => {
      const t = (el.textContent ?? '').trim();
      if (seen.at(-1) !== t) seen.push(t);
    };
    sample();
    new MutationObserver(sample).observe(el, { childList: true, subtree: true, characterData: true });
    w.__reviewSeen = seen;
  }, READOUT);
}

function seen(page: Page): Promise<string[]> {
  return page.evaluate(() => [...((window as unknown as { __reviewSeen?: string[] }).__reviewSeen ?? [])]);
}

async function readout(page: Page): Promise<string> {
  return ((await page.locator(READOUT).textContent()) ?? '').trim();
}

test.describe('the stall watchdog stands down while the host works on a request (WR-B-02)', () => {
  test('LOAD-SILENCE: a Load on a running board reads Loading through the swap silence, then Loaded', async ({ page }) => {
    const { h, stream } = await bootPlaying(page);
    try {
      await recordReadout(page);
      page.once('dialog', (d) => void d.accept('/tmp/review-90-load.fab'));
      await page.getByTitle('Load a saved factory').click();
      await expect.poll(() => h.controls.some((c) => c.startsWith('load')), { message: 'the Load went on the wire' }).toBe(true);
      // The host drains for a while (a packet a tick), then builds the board in silence.
      await page.waitForTimeout(300);
      stream.silence();
      await page.waitForTimeout(SWAP_SILENCE_MS);
      expect(await page.locator('[data-fab-disconnected-dim]').count(), 'no stall dim over the swap').toBe(0);
      // The swap keyframe: full, the swap floor equal to its generation and above the floor at dispatch.
      h.inject(buildPacket({ tick: 3, full: true, nodes: [MACHINE], generation: 1, swapFloor: 1 }));
      await expect.poll(() => readout(page), { message: 'the Load reads Loaded' }).toBe('Loaded');
      const texts = await seen(page);
      console.log(`REVIEW-90 load-silence seen=${JSON.stringify(texts)}`);
      expect(texts.filter((t) => t.includes(DISCONNECTED)), `never Disconnected (${JSON.stringify(texts)})`).toEqual([]);
    } finally {
      stream.stop();
    }
  });

  test('SAVE-SILENCE: a Save on a running board never reads Disconnected through the write', async ({ page }) => {
    const { h, stream } = await bootPlaying(page);
    try {
      await recordReadout(page);
      page.once('dialog', (d) => void d.accept('/tmp/review-90-save.fab'));
      await page.getByTitle('Save (Ctrl+S) - Shift for Save As').click();
      await expect.poll(() => h.controls.some((c) => c.startsWith('save')), { message: 'the Save went on the wire' }).toBe(true);
      // The host drains (a packet a tick) until just before `Save requested` fades, then writes
      // in silence across that fade: the strip must not read the fade as a dropped stream.
      await page.waitForTimeout(AUTOCLEAR_MS - 1_500);
      stream.silence();
      // The stall is seen 800 ms in, before the fade at 4 s; the host speaks again after it.
      await page.waitForTimeout(2_000);
      stream.speak();
      await page.waitForTimeout(500);
      const texts = await seen(page);
      console.log(`REVIEW-90 save-silence seen=${JSON.stringify(texts)}`);
      expect(texts.filter((t) => t.includes(DISCONNECTED)), `never Disconnected (${JSON.stringify(texts)})`).toEqual([]);
      expect(await page.locator('[data-fab-disconnected-dim]').count(), 'no stall dim after the write').toBe(0);
    } finally {
      stream.stop();
    }
  });

  test('NEW-SILENCE: a New on a running board never reads Disconnected through the swap', async ({ page }) => {
    const { h, stream } = await bootPlaying(page);
    try {
      await recordReadout(page);
      await page.getByRole('button', { name: 'New' }).click();
      await expect.poll(() => h.controls.includes('new'), { message: 'New went on the wire' }).toBe(true);
      stream.silence();
      await page.waitForTimeout(SWAP_SILENCE_MS);
      h.inject(buildPacket({ tick: 1, full: true, generation: 1, swapFloor: 1 }));
      stream.speak();
      await page.waitForTimeout(500);
      const texts = await seen(page);
      console.log(`REVIEW-90 new-silence seen=${JSON.stringify(texts)}`);
      expect(texts.filter((t) => t.includes(DISCONNECTED)), `never Disconnected (${JSON.stringify(texts)})`).toEqual([]);
    } finally {
      stream.stop();
    }
  });

  // The host's work on a New or an example ends at its swap keyframe: a stall after it is a dropped
  // stream again, named at once, not held for the settle window. Found by the fatal spec's playing
  // leg against a page that heard the fatal late (review pass 2 red-first): the example load the leg
  // began with kept the stall held for 16 s.
  test('STALL-AFTER-SWAP: once an example has swapped in, a stall reads Disconnected at once', async ({ page }) => {
    const { h, stream } = await bootPlaying(page);
    try {
      await page.getByRole('button', { name: 'Examples' }).click();
      await page.getByRole('button', { name: 'Load order processing' }).click();
      await expect
        .poll(() => h.controls.some((c) => c.startsWith('load_example')), { message: 'the example went on the wire' })
        .toBe(true);
      // The swap keyframe, then the new board plays a while.
      h.inject(buildPacket({ tick: 1, full: true, nodes: [MACHINE], generation: 1, swapFloor: 1 }));
      await page.waitForTimeout(500);
      await recordReadout(page);
      stream.silence();
      await expect
        .poll(() => readout(page), { timeout: 3_000, intervals: [100], message: 'a stall after the swap is a dropped stream' })
        .toBe(DISCONNECTED);
    } finally {
      stream.stop();
    }
  });

  test('DEAD-HOST-SAVE: a Save to a host that never speaks again reads Disconnected after the settle window', async ({ page }) => {
    test.setTimeout(60_000);
    const { h, stream } = await bootPlaying(page);
    try {
      page.once('dialog', (d) => void d.accept('/tmp/review-90-dead-save.fab'));
      await page.getByTitle('Save (Ctrl+S) - Shift for Save As').click();
      await expect.poll(() => h.controls.some((c) => c.startsWith('save')), { message: 'the Save went on the wire' }).toBe(true);
      stream.silence();
      const silentAt = Date.now();
      await page.waitForTimeout(AUTOCLEAR_MS + 1_000);
      expect(await readout(page), 'inside the settle window the host is still given its time').not.toBe(DISCONNECTED);
      await expect
        .poll(() => readout(page), { timeout: SETTLE_WINDOW_MS + 5_000, intervals: [250], message: 'a dead host is still named' })
        .toBe(DISCONNECTED);
      console.log(`REVIEW-90 dead-save named_after_ms=${Date.now() - silentAt}`);
    } finally {
      stream.stop();
    }
  });

  test('DEAD-HOST-LOAD: a Load to a host that never speaks again reads Load failed, then Disconnected', async ({ page }) => {
    test.setTimeout(60_000);
    const { h, stream } = await bootPlaying(page);
    try {
      await recordReadout(page);
      page.once('dialog', (d) => void d.accept('/tmp/review-90-dead-load.fab'));
      await page.getByTitle('Load a saved factory').click();
      await expect.poll(() => h.controls.some((c) => c.startsWith('load')), { message: 'the Load went on the wire' }).toBe(true);
      stream.silence();
      await expect
        .poll(() => readout(page), {
          timeout: SETTLE_WINDOW_MS + AUTOCLEAR_MS + 5_000,
          intervals: [250],
          message: 'the Load cut-off, then the stream named down',
        })
        .toBe(DISCONNECTED);
      const texts = (await seen(page)).filter((t) => t !== '');
      console.log(`REVIEW-90 dead-load seen=${JSON.stringify(texts)}`);
      expect(texts, 'Loading, then Load failed, then Disconnected').toEqual(['Loading…', 'Load failed', DISCONNECTED]);
    } finally {
      stream.stop();
    }
  });
});

test.describe('a refused Open keeps the scene badge (WR-B-06)', () => {
  test('REFUSED-OPEN-BADGE: the demo badge stays when the host refuses the file', async ({ page }) => {
    const { h, stream } = await bootPlaying(page, (verb) => (verb === 'loaded_scene' ? 'demo_scene' : undefined));
    try {
      await expect(page.getByText('Demo scene', { exact: true }), 'the boot echo names the demo').toBeVisible();
      page.once('dialog', (d) => void d.accept('/tmp/review-90-refused.fab'));
      await page.getByTitle('Load a saved factory').click();
      await expect.poll(() => h.controls.some((c) => c.startsWith('load')), { message: 'the Open went on the wire' }).toBe(true);
      h.injectText(JSON.stringify({ kind: 'loadRefused', reason: 'This file is not a Fabrico board.' }));
      await expect.poll(() => readout(page), { message: 'the strip reads Load failed' }).toBe('Load failed');
      await expect(page.getByText('Demo scene', { exact: true }), 'the demo is still on screen, and so is its badge').toBeVisible();
    } finally {
      stream.stop();
    }
  });
});

test.describe('Step then Space in one task (IN-B-04)', () => {
  test('STEP-THEN-SPACE: the Space after a Step from playing sends resume, not a second pause', async ({ page }) => {
    const { h, stream } = await bootPlaying(page);
    try {
      const before = h.controls.length;
      await page.evaluate(() => {
        (document.activeElement as HTMLElement | null)?.blur();
        window.dispatchEvent(new KeyboardEvent('keydown', { key: '.', bubbles: true }));
        window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
      });
      await expect.poll(() => h.controls.length - before, { message: 'two controls went on the wire' }).toBe(2);
      expect(h.controls.slice(before), 'a Step, then the Space plays').toEqual(['step', 'resume']);
      await expect(page.getByRole('button', { name: 'Pause' }), 'the glyph shows the board playing').toBeVisible();
    } finally {
      stream.stop();
    }
  });
});

test.describe('an edit queued on a paused board is work the guards ask about (WR-B-03)', () => {
  /** Pause, then place one Source: the Place goes on the wire and is queued. */
  async function pauseAndQueue(page: Page, h: Harness): Promise<void> {
    await page.getByRole('button', { name: 'Pause' }).click();
    await expect(page.getByRole('button', { name: 'Play' })).toBeVisible();
    const sent = h.sent.length;
    await page.getByRole('button', { name: /Source/ }).click();
    const drop = await screenCellCentre(page, 15, 8);
    await page.mouse.move(drop.x, drop.y);
    await page.mouse.down();
    await page.mouse.up();
    await expect.poll(() => h.sent.length, { message: 'the Place went on the wire' }).toBeGreaterThan(sent);
    await expect.poll(() => readout(page), { message: 'the Place is queued' }).toBe('Paused - edits queued until Play');
    await page.keyboard.press('Escape');
    await expect(page.getByText('Unsaved', { exact: true }), 'nothing was accepted, so the badge stays off').toHaveCount(0);
  }

  const QUEUED_WORDS = 'edits queued on the paused board';

  for (const [label, open, heading] of [
    ['New', (p: Page) => p.getByRole('button', { name: 'New' }).click(), 'Start a new board?'],
    [
      'Open',
      (p: Page) => p.getByTitle('Load a saved factory').click(),
      'Open another board?',
    ],
    [
      'an example',
      async (p: Page) => {
        await p.getByRole('button', { name: 'Examples' }).click();
        await p.getByRole('button', { name: 'Load order processing' }).click();
      },
      'Load an example?',
    ],
  ] as const) {
    test(`QUEUED-GUARD: paused, a Place queued, ${label} asks first and names the queued edits`, async ({ page }) => {
      const { h, stream } = await bootPlaying(page);
      stream.stop();
      await pauseAndQueue(page, h);
      const controls = h.controls.length;
      let prompted = false;
      page.once('dialog', (d) => {
        prompted = true;
        void d.dismiss();
      });
      await open(page);
      const panel = page.locator('.fab-dialog-panel');
      await expect(panel, `${label}: the discard guard opened`).toBeVisible();
      await expect(panel.getByRole('heading'), `${label}: its heading`).toHaveText(heading);
      await expect(panel, `${label}: it says the queued edits will be lost`).toContainText(QUEUED_WORDS);
      expect(prompted, `${label}: no file prompt before the guard is answered`).toBe(false);
      expect(h.controls.slice(controls), `${label}: nothing was sent`).toEqual([]);
      await panel.getByRole('button', { name: 'Cancel' }).click();
      await expect(panel).toBeHidden();
      expect(h.controls.slice(controls), `${label}: Cancel sent nothing`).toEqual([]);
    });
  }

  test('QUEUED-GUARD: paused, a Place queued, quit is intercepted and the guard names the queued edits', async ({ page }) => {
    const { h, stream } = await bootPlaying(page);
    stream.stop();
    await pauseAndQueue(page, h);
    const intercepted = await page.evaluate(() => (window as unknown as { __fabrico: { requestQuit(): boolean } }).__fabrico.requestQuit());
    expect(intercepted, 'the quit is intercepted').toBe(true);
    const panel = page.locator('.fab-dialog-panel');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText(QUEUED_WORDS);
  });
});
