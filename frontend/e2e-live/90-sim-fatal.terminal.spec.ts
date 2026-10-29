import { test, expect, type Page } from '@playwright/test';
import { addWaitBudget, frameBudgetMs } from '../e2e/support/frameSampler';
import {
  DRAWN_STATE_FRAMES,
  cameraOf,
  drawnNodesOf,
  expectRenderLoopAlive,
  pollScene,
  readScene,
  recordStatusStripDuring,
  resetToDemo,
  screenCellCentre,
  waitForAppReady,
  watchPageErrors,
} from './support/oracle';

// 90-sim-fatal.terminal.spec.ts (phase 90, plan 90-06, FAIL-01, D-11 to D-13, success criterion 4,
// UI-SPEC section 1 and walk steps 10 to 15) - a fatal sim error reaches the user as "Simulation
// stopped", not a frozen board, on the REAL host (dev_render_server, real Core -> RenderProducer
// -> postcard -> WS). Zero mocks, zero injected packets: the fault goes through the shipped
// store-error path, fired by the dev host's own fault switch.
//
// ---------------------------------------------------------------------------
// WHAT WAS BROKEN (90-MEASURE.md `## FAIL-01: still broken`)
// ---------------------------------------------------------------------------
//
// A fatal store error ended the sim loop and nothing told the user. On the dev host the process
// died through its sim-loop expect; on a paused board the page showed nothing at all, and on a
// playing board the stall watchdog wrote `Disconnected - live view frozen`, a connection that may
// come back, over a simulation that never will. D-11: the host keeps the reason and tells every
// page, including one that connects later; D-12: the status line reads `Simulation stopped`.
//
// ---------------------------------------------------------------------------
// HOW THE FAULT IS FIRED, AND WHY THIS SPEC RUNS LAST (D-13, research Findings A and B)
// ---------------------------------------------------------------------------
//
// `fireDevFault` opens a second WebSocket to the dev host from the test process and sends the
// `dev_fault` TEXT frame (`transport_ws.rs` `DEV_FAULT_FRAME`). Only `dev_render_server` wires the
// switch, so the shipped app has no path to it. The switch is read at the top of the sim loop's
// `step()`, so it fires on a paused board too, and it returns the same `StoreError` a real store
// failure returns.
//
// A fatal error ends the ONE shared dev host, so this spec runs in the `live-terminal` Playwright
// project, which the `live` project names as its `teardown`: it runs after every other live spec,
// even when one of them failed. It never restores the host (there is no host to restore after the
// fault), and its tests run in order on the one stopped host.
//
// ---------------------------------------------------------------------------
// THE LEGS, GRADED ON WHAT THE USER SEES
// ---------------------------------------------------------------------------
//
//   1. On the demo, PLAYING (the transport reads Pause and the tick rises), the fault is fired,
//      the case the original bug was measured on: the stall watchdog wrote `Disconnected - live
//      view frozen` over a playing board. The status strip is recorded on every change from
//      BEFORE the fault (review WR-C-02: until review pass 2 the recording began only once the
//      strip already read `Simulation stopped`, so a `Disconnected` before it was invisible), and
//      the recording holds `Simulation stopped` and nothing else; the transport flips to Play; for
//      3 s, sampled every 200 ms, the disconnected dim covers the board, which is still drawn
//      machine for machine (review WR-C-04). The paused board's case is the same frame on a page
//      whose watchdog is disarmed (a paused page cannot show `Disconnected`, statusWatchdog.test.ts);
//      the dev host can be stopped once, so this leg takes the harder, playing case.
//   2. A reload (the host still holds the reason): the page boots playing, so its stall watchdog
//      arms on the first packet, and then meets the held reason. The strip is recorded from the
//      document's start (review WR-C-02, an init script), so the reloaded page is seen never to
//      show `Disconnected`, before or after `Simulation stopped`; for 3 s the dim stays and the
//      board is still drawn.
//   3. (plan 90-07, D-12, UI-SPEC 1.2 and 1.3) The stopped card: one alert at the viewport
//      centre, clear of the status strip, holding the heading, the host's reason (graded by its
//      prefix), the consequence sentence and one button, `Copy details`, which has focus; its
//      words in ink on the panel fill at AA contrast or better, the fill itself opaque (review
//      WR-C-05: the contrast read refuses a translucent or missing fill instead of grading the
//      words against black). Pressing it reads `Copied`, the
//      clipboard holds the three lines with the tick the board last drew, and the label returns
//      to `Copy details`. A reload brings the card back.
//   4. (plan 90-07, D-12, UI-SPEC 1.4) Nothing that would reach the stopped host works, and the
//      board can still be looked at: Play, Step, Undo, Redo, New, Save, Load, Examples and every
//      palette item are disabled with the title `Unavailable: the simulation stopped`; Space,
//      `.`, Ctrl+Z and Ctrl+S (focus on the board, not on a button) open no dialog, leave Play
//      unpressed, and SEND nothing (review WR-C-03: the page's own send counts, `controlsSent`
//      and `inputsSent`, are read before and after; a tick that does not move proves nothing on
//      a dead host); a click on a machine opens no panel and sends nothing; a middle-button drag
//      moves the camera, the wheel changes the zoom and Help still opens.
//
// RED FIRST (D-14, research Pitfall 8): run once at the commit that wired the switch and nothing
// else (`SEAM_REV` in 90-EVIDENCE.md): there the host dies through its sim-loop expect and the
// status line never says the simulation stopped (`LIVE_RED 90-sim-fatal`).
//
// Render health in every test: `watchPageErrors` before `goto`, `expectRenderLoopAlive` and the
// watcher's `assertNone` at its end (fabrico-model-oracle-blindspot). On the stopped board the
// render clock is held by design (it follows the sim clock), so the check after the stop reads the
// Pixi ticker instead (`boardHeld`).

/** The dev host's render socket (`devWebSocket.ts` `DEFAULT_DEV_WS_URL`). */
const DEV_WS_URL = 'ws://127.0.0.1:8787/render';
/** The dev host's fault switch frame (`transport_ws.rs` `DEV_FAULT_FRAME`). */
const DEV_FAULT_FRAME = 'dev_fault';
/** The status line once the simulation stopped (`controlHandlers.ts` `STATUS_COPY.simStopped`). */
const STOPPED = 'Simulation stopped';
/** How long the socket that fires the fault may take to open. Loopback, so seconds are generous. */
const FIRE_OPEN_MS = 10_000;
/** The status strip's sentence for a dropped stream (`controlHandlers.ts` `STATUS_COPY`). */
const DISCONNECTED = 'Disconnected';
/** The dim the page lays over the board (`App.tsx`), for a dropped stream and a stopped sim. */
const DIM = '[data-fab-disconnected-dim]';
/** How far apart the watch samples are taken, and how many: 3 s. */
const SAMPLE_MS = 200;
const WATCH_SAMPLES = 15;
/** The stopped card's mounted node (`SimStoppedCard.tsx`). */
const CARD = '[data-fab-sim-stopped]';
/** The card's heading, its consequence and its one button (`SIM_STOPPED_COPY`). */
const CARD_HEADING = 'The simulation stopped.';
const CARD_CONSEQUENCE = 'This board can no longer run, change or be saved. To keep working, close Fabrico and open it again.';
const COPY_IDLE = 'Copy details';
const COPY_DONE = 'Copied';
/** The dev host's reason starts with the store-error prefix (`sim_fatal.rs` `fatal_reason`). */
const REASON_PREFIX = 'sim loop terminated with a fatal store error:';
/** WCAG AA for body text. */
const AA_TEXT = 4.5;
/** The title every control that would reach the stopped host carries (`SIM_STOPPED_COPY`). */
const DISABLED_TITLE = 'Unavailable: the simulation stopped';
/** How long leg 4 waits after a key or a click for anything it might have started to show. */
const SETTLE_AFTER_INPUT_MS = 1_000;

// The card's Copy details leg reads the clipboard back in the page (Chromium grants both).
test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

/** The transport button: `Pause` while the page believes the sim runs, `Play` while paused. */
function transportOf(page: Page) {
  return page.getByRole('button', { name: /^(Play|Pause)$/ });
}

/** The status line's text (the readout's `role="status"` live region). */
async function statusText(page: Page): Promise<string> {
  return ((await page.getByRole('status').textContent()) ?? '').trim();
}

/**
 * Fire the dev host's fault switch: a second WebSocket from the test process (Node's global
 * `WebSocket`) sends `DEV_FAULT_FRAME` once it opens, waits for the frame to leave, and closes.
 */
async function fireDevFault(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(DEV_WS_URL);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`fireDevFault: ${DEV_WS_URL} did not open within ${FIRE_OPEN_MS} ms`));
    }, FIRE_OPEN_MS);
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error(`fireDevFault: the socket to ${DEV_WS_URL} failed`));
    });
    ws.addEventListener('open', () => {
      ws.send(DEV_FAULT_FRAME);
      const drained = (): void => {
        if (ws.bufferedAmount > 0) {
          setTimeout(drained, 10);
          return;
        }
        clearTimeout(timer);
        ws.close();
        resolve();
      };
      drained();
    });
  });
}

/** Poll the status line until it reads `Simulation stopped`. */
async function expectStopped(page: Page, message: string): Promise<void> {
  await expect.poll(() => statusText(page), { timeout: 15_000, intervals: [100, 250, 500], message }).toBe(STOPPED);
}

/**
 * The stopped board, watched for `WATCH_SAMPLES` samples `SAMPLE_MS` apart: the readout holds the
 * warning glyph, and the dim covers the board at every sample. Each leg runs it inside
 * `recordStatusStripDuring`, so the strip is recorded on every change across the window.
 */
async function watchStopped(page: Page, context: string): Promise<void> {
  await expect(page.getByRole('status').locator('svg'), `${context}: the readout holds the warning glyph`).toHaveCount(1);
  for (let i = 0; i < WATCH_SAMPLES; i += 1) {
    await page.waitForTimeout(SAMPLE_MS);
    const dim = await page.locator(DIM).count();
    expect(dim, `${context}: sample ${i + 1} of ${WATCH_SAMPLES}: the dim covers the stopped board`).toBe(1);
  }
  await expectBoardStillDrawn(page, context);
}

/**
 * Review WR-C-04: the stopped board stays visible (D-12), graded on the drawn machine layer, not
 * only on the model: every node the model holds is drawn, machine or label, and nothing else is.
 * A stop path that reset the scene layers or hid them under the dim would keep the model's nodes
 * and the ticker alive, and pass every other read in this spec.
 */
async function expectBoardStillDrawn(page: Page, context: string): Promise<void> {
  const drawn = await drawnNodesOf(page);
  const model = (await readScene(page)).nodes.map((n) => n.id).sort((a, b) => a - b);
  const drawnIds = [...drawn.machines, ...drawn.labels].sort((a, b) => a - b);
  console.log(`P90-FAIL-01 ${context.replace(/\s+/g, '-')} drawn=${JSON.stringify(drawnIds)} model=${JSON.stringify(model)} strays=${drawn.strays}`);
  expect(model.length, `${context}: the stopped board has machines`).toBeGreaterThan(0);
  expect(drawnIds, `${context}: the stopped board is still drawn, node for node`).toEqual(model);
  expect(drawn.strays, `${context}: and nothing stray is drawn on it`).toBe(0);
}

/** The page's own send counts (review WR-C-03), read through the DEV hooks; throws when absent. */
async function sendCounts(page: Page): Promise<{ controls: number; inputs: number }> {
  return page.evaluate(() => {
    const hook = (window as unknown as { __fabrico?: { controlsSent?(): number; inputsSent?(): number } }).__fabrico;
    if (typeof hook?.controlsSent !== 'function' || typeof hook.inputsSent !== 'function') {
      throw new Error('sendCounts: window.__fabrico.controlsSent / inputsSent are not installed (a DEV build has them)');
    }
    return { controls: hook.controlsSent(), inputs: hook.inputsSent() };
  });
}

/** The selected node, through the hook; throws when the hook is absent (review IN-C-02). */
async function selectedNodeOf(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const hook = (window as unknown as { __fabrico?: { selectedNode?(): number | null } }).__fabrico;
    if (typeof hook?.selectedNode !== 'function') throw new Error('selectedNodeOf: window.__fabrico.selectedNode is not installed');
    return hook.selectedNode();
  });
}

/**
 * Review WR-C-02: record the status strip from the document's start, on every load of the page,
 * into `window.__fabBootStripSeen`: an init script, so a reloaded page's first frames are seen too.
 * Like `recordStatusStripDuring`, each sample drops the scene badge's subtree (phase 91, plan 91-10:
 * the badge moved into the strip; it names the loaded example and is not a message).
 */
async function recordStripFromDocumentStart(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __fabBootStripSeen?: string[] };
    const seen: string[] = [];
    w.__fabBootStripSeen = seen;
    let strip: Element | null = null;
    const sample = (): void => {
      if (strip === null || !strip.isConnected) strip = document.querySelector('[data-fab-status-strip]');
      if (strip === null) return;
      const clone = strip.cloneNode(true) as Element;
      clone.querySelectorAll('[data-fab-scene-badge]').forEach((b) => b.remove());
      const text = (clone.textContent ?? '').trim();
      if (seen.at(-1) !== text) seen.push(text);
    };
    const observer = new MutationObserver(sample);
    const start = (): void => observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    if (document.documentElement !== null) start();
    else document.addEventListener('DOMContentLoaded', start);
  });
}

async function bootStripSeen(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const seen = (window as unknown as { __fabBootStripSeen?: string[] }).__fabBootStripSeen;
    if (seen === undefined) throw new Error('bootStripSeen: the init-script recording is not installed');
    return [...seen];
  });
}

/** The recorded strip never showed `Disconnected`, only `Simulation stopped`. */
function expectStripStayedStopped(strip: string[], context: string): void {
  console.log(`P90-FAIL-01 ${context.replace(/\s+/g, '-')} strip=${JSON.stringify(strip)}`);
  expect(strip.length, `${context}: the strip was recorded`).toBeGreaterThan(0);
  expect(
    strip.filter((t) => t.includes(DISCONNECTED)),
    `${context}: the status strip never read "${DISCONNECTED}" (every text it showed: ${JSON.stringify(strip)})`,
  ).toEqual([]);
  expect(strip.filter((t) => t !== STOPPED), `${context}: the strip showed only "${STOPPED}"`).toEqual([]);
}

/**
 * The WCAG contrast ratio of `selector`'s text colour on the first opaque background at or above
 * it, read off the computed styles in the page.
 */
async function contrastOf(page: Page, selector: string): Promise<number> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!(el instanceof HTMLElement)) throw new Error(`contrastOf: ${sel} is not on the page`);
    const rgb = (c: string): [number, number, number, number] => {
      const m = c.match(/rgba?\(([^)]+)\)/);
      if (m === null) throw new Error(`contrastOf: cannot read colour ${c}`);
      const p = m[1]!.split(/[ ,/]+/).filter((x) => x !== '').map(Number);
      return [p[0]!, p[1]!, p[2]!, p[3] ?? 1];
    };
    // Review WR-C-05: the first OPAQUE fill at or above the element. A translucent fill on the way
    // is refused (the words would sit over whatever is under it, the dimmed canvas here), and so is
    // reaching the root with no opaque fill at all: `rgba(0, 0, 0, 0)` was read as opaque black, so
    // light ink "passed" over a card whose fill had gone.
    let bgEl: HTMLElement = el;
    let bg = rgb(getComputedStyle(el).backgroundColor);
    for (;;) {
      if (bg[3] > 0 && bg[3] < 1) {
        throw new Error(`contrastOf: ${sel} sits on a translucent fill (${getComputedStyle(bgEl).backgroundColor} on <${bgEl.tagName.toLowerCase()}>)`);
      }
      if (bg[3] === 1) break;
      if (bgEl.parentElement === null) throw new Error(`contrastOf: no opaque fill at or above ${sel}`);
      bgEl = bgEl.parentElement;
      bg = rgb(getComputedStyle(bgEl).backgroundColor);
    }
    const fg = rgb(getComputedStyle(el).color);
    if (fg[3] !== 1) throw new Error(`contrastOf: ${sel}'s text colour is translucent (${getComputedStyle(el).color})`);
    const lum = ([r, g, b]: [number, number, number, number]): number => {
      const ch = (v: number): number => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
    };
    const a = lum(fg);
    const b = lum(bg);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  }, selector);
}

/** The stopped card as the user reads it, graded on the page (leg 3). */
async function expectStoppedCard(page: Page, context: string): Promise<void> {
  const card = page.locator(CARD);
  await expect(card, `${context}: the stopped card is on the board`).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('alert'), `${context}: the card is the page's one alert`).toHaveCount(1);
  await expect(card, `${context}: the card is an alert`).toHaveAttribute('role', 'alert');
  await expect(card.locator('h2'), `${context}: the heading`).toHaveText(CARD_HEADING);
  await expect(card.locator('svg'), `${context}: the warning glyph beside the heading`).toHaveCount(1);
  const reason = ((await card.locator('[data-fab-sim-stopped-reason]').textContent()) ?? '').trim();
  console.log(`P90-FAIL-01 ${context.replace(/\s+/g, '-')} reason=${JSON.stringify(reason)}`);
  expect(reason.startsWith(REASON_PREFIX), `${context}: the host's reason is shown (${JSON.stringify(reason)})`).toBe(true);
  await expect(card.locator('p').last(), `${context}: the consequence sentence`).toHaveText(CARD_CONSEQUENCE);
  const buttons = await card.locator('button').allTextContents();
  expect(buttons.map((b) => b.trim()), `${context}: one button and nothing that claims to bring the sim back`).toEqual([COPY_IDLE]);
  // The card's place: centred in the viewport, inside it, and clear of the status strip.
  const box = await card.boundingBox();
  const vp = page.viewportSize();
  const strip = await page.locator('[data-fab-status-strip]').boundingBox();
  expect(box, `${context}: the card has a box`).not.toBeNull();
  expect(vp, `${context}: the viewport has a size`).not.toBeNull();
  console.log(`P90-FAIL-01 ${context.replace(/\s+/g, '-')} card=${JSON.stringify(box)} viewport=${JSON.stringify(vp)} strip=${JSON.stringify(strip)}`);
  expect(Math.abs(box!.x + box!.width / 2 - vp!.width / 2), `${context}: the card is centred across`).toBeLessThanOrEqual(1);
  expect(Math.abs(box!.y + box!.height / 2 - vp!.height / 2), `${context}: the card is centred down`).toBeLessThanOrEqual(1);
  expect(box!.y >= 0 && box!.y + box!.height <= vp!.height, `${context}: nothing of the card is cut off`).toBe(true);
  if (strip !== null) {
    expect(box!.y, `${context}: the card clears the status strip`).toBeGreaterThanOrEqual(strip.y + strip.height);
  }
  // The card's own fill is opaque (review WR-C-05): the grade below is on the fill the UI-SPEC
  // names, not on whatever is under a translucent card.
  const cardFill = await card.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(cardFill.startsWith('rgb(') || /,\s*1\)$/.test(cardFill), `${context}: the card's fill is opaque (${cardFill})`).toBe(true);
  // Ink on the panel fill, not the destructive red: AA for text.
  for (const sel of [`${CARD} h2`, `${CARD} [data-fab-sim-stopped-reason]`, `${CARD} p:last-of-type`, `${CARD} button`]) {
    const ratio = await contrastOf(page, sel);
    expect(ratio, `${context}: ${sel} reads at AA contrast or better (${ratio.toFixed(2)}:1)`).toBeGreaterThanOrEqual(AA_TEXT);
  }
  // The one control has focus, so a keyboard user lands on it.
  expect(
    await page.evaluate(() => document.activeElement?.hasAttribute('data-fab-sim-stopped-copy') ?? false),
    `${context}: Copy details has focus`,
  ).toBe(true);
}

test.describe('90 live: a fatal sim error says the simulation stopped (FAIL-01)', () => {
  test.describe.configure({ mode: 'serial' });

  test('the fault on a playing board says the simulation stopped, and nothing before it said Disconnected', async ({ page }) => {
    const errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await resetToDemo(page);
    await expectRenderLoopAlive(page, 'leg 1: the demo playing, before the fault');
    await expect(transportOf(page), 'leg 1: the board plays, the transport offers Pause').toHaveAttribute('aria-label', 'Pause');
    const t0 = (await readScene(page)).tick;
    await pollScene(page, (s) => s.tick, { message: `leg 1: the tick rises past ${t0}` }).toBeGreaterThan(t0);

    // WR-C-02: the recording spans the fault, so anything the strip shows between the fault and
    // the stop is seen.
    const strip1 = await recordStatusStripDuring(page, async () => {
      await fireDevFault();
      await expectStopped(page, 'leg 1: the fault on a playing board puts "Simulation stopped" in the status line');
      await watchStopped(page, 'leg 1');
    });
    console.log(`P90-FAIL-01 leg 1 status=${JSON.stringify(await statusText(page))}`);
    expectStripStayedStopped(strip1.filter((t) => t !== ''), 'leg 1');
    await expect(transportOf(page), 'leg 1: the page is paused, the transport offers Play').toHaveAttribute('aria-label', 'Play');

    await expectRenderLoopAlive(page, 'leg 1: the stopped board', { boardHeld: true });
    errs.assertNone('leg 1, the fault on a playing board');
  });

  test('a reload brings the stopped status back', async ({ page }) => {
    const errs = watchPageErrors(page);
    await recordStripFromDocumentStart(page);
    await page.goto('/');
    // The host still serves its last keyframe, so the board has a tick above 0 without one
    // advancing: `waitForAppReady` waits for exactly that, then settles the camera.
    await waitForAppReady(page);
    await page.reload();
    await expect(page.getByRole('button', { name: 'Place Factory' }), 'leg 2: the chrome is back after the reload').toBeVisible({
      timeout: 15_000,
    });
    await pollScene(page, (s) => s.tick, { message: 'leg 2: the reloaded page drew the last keyframe' }).toBeGreaterThan(0);
    await expectStopped(page, 'leg 2: the reloaded page meets the held reason and reads "Simulation stopped"');
    console.log(`P90-FAIL-01 leg 2 tick=${(await readScene(page)).tick} status=${JSON.stringify(await statusText(page))}`);
    const strip2 = await recordStatusStripDuring(page, () => watchStopped(page, 'leg 2'));
    expectStripStayedStopped(strip2, 'leg 2');
    // WR-C-02: the reloaded page, from its first frame: never `Disconnected`, and once the strip
    // read `Simulation stopped` nothing else.
    const fromStart = (await bootStripSeen(page)).filter((t) => t !== '');
    console.log(`P90-FAIL-01 leg-2 from_document_start=${JSON.stringify(fromStart)}`);
    expect(fromStart.length, 'leg 2: the init script recorded the reloaded strip').toBeGreaterThan(0);
    expectStripStayedStopped(fromStart, 'leg 2 from the document start');

    await expectRenderLoopAlive(page, 'leg 2: the reloaded stopped board', { boardHeld: true });
    errs.assertNone('leg 2, the reload after the fault');
  });

  test('the card says the simulation stopped and copies why', async ({ page }) => {
    const errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await expectStopped(page, 'leg 3: the page meets the held reason');
    await expectStoppedCard(page, 'leg 3');

    // Copy details: `Copied` only after the write, and the clipboard holds the three lines.
    const tick = (await readScene(page)).tick;
    const copyButton = page.locator(`${CARD} [data-fab-sim-stopped-copy]`);
    // Plan 90-08 walk (WebKitGTK): the button narrowed by its padding on every press, because its
    // reserve was a bare `12ch` on a border-box button. Its box is read at each label.
    const idleBox = await copyButton.boundingBox();
    await copyButton.click();
    await expect(copyButton, 'leg 3: the label says the details were copied').toHaveText(COPY_DONE);
    const copiedBox = await copyButton.boundingBox();
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    console.log(`P90-FAIL-01 leg-3 tick=${tick} clipboard=${JSON.stringify(clip)}`);
    const lines = clip.split('\n');
    expect(lines, 'leg 3: the clipboard holds three lines').toHaveLength(3);
    expect(lines[0], 'leg 3: the first line is the heading').toBe(CARD_HEADING);
    expect(lines[1]?.startsWith(`Reason: ${REASON_PREFIX}`), `leg 3: the second line is the full reason (${lines[1]})`).toBe(true);
    expect(lines[2], 'leg 3: the third line is the tick the board last drew').toBe(`Last tick shown: ${tick}`);
    await expect(copyButton, 'leg 3: the label returns after its hold').toHaveText(COPY_IDLE, { timeout: 5_000 });
    const backBox = await copyButton.boundingBox();
    console.log(`P90-FAIL-01 leg-3 copy_box idle=${JSON.stringify(idleBox)} copied=${JSON.stringify(copiedBox)} back=${JSON.stringify(backBox)}`);
    for (const [label, box] of [
      [COPY_DONE, copiedBox],
      [COPY_IDLE, backBox],
    ] as const) {
      expect(box, `leg 3: the button has a box at "${label}"`).not.toBeNull();
      expect(Math.abs((box?.width ?? 0) - (idleBox?.width ?? -1)), `leg 3: the button keeps its width at "${label}"`).toBeLessThan(0.5);
      expect(Math.abs((box?.x ?? 0) - (idleBox?.x ?? -1)), `leg 3: the button does not move at "${label}"`).toBeLessThan(0.5);
    }

    // The card is back after a reload.
    await page.reload();
    await expect(page.getByRole('button', { name: 'Place Factory' }), 'leg 3: the chrome is back after the reload').toBeVisible({
      timeout: 15_000,
    });
    await expectStopped(page, 'leg 3: the reloaded page reads "Simulation stopped"');
    await expectStoppedCard(page, 'leg 3 after the reload');

    await expectRenderLoopAlive(page, 'leg 3: the stopped board under the card', { boardHeld: true });
    errs.assertNone('leg 3, the stopped card');
  });

  test('nothing that would reach the stopped host works, and the board can still be looked at', async ({ page }) => {
    const errs = watchPageErrors(page);
    let dialogs = 0;
    page.on('dialog', (d) => {
      dialogs += 1;
      void d.dismiss();
    });
    await page.goto('/');
    await waitForAppReady(page);
    await expectStopped(page, 'leg 4: the page meets the held reason');
    await expect(page.locator(CARD), 'leg 4: the stopped card is up').toBeVisible({ timeout: 15_000 });

    // Every control that would send to the host: disabled, titled with the reason, its name kept.
    const toolbar = page.locator('header');
    const senders = [
      toolbar.getByRole('button', { name: 'Play', exact: true }),
      toolbar.getByRole('button', { name: 'Step', exact: true }),
      toolbar.getByRole('button', { name: 'Undo', exact: true }),
      toolbar.getByRole('button', { name: 'Redo', exact: true }),
      toolbar.getByRole('button', { name: 'New', exact: true }),
      toolbar.getByRole('button', { name: 'Save', exact: true }),
      toolbar.getByRole('button', { name: 'Load', exact: true }),
      toolbar.getByRole('button', { name: 'Examples', exact: true }),
    ];
    for (const b of senders) {
      await expect(b, 'leg 4: a control that would reach the host is disabled').toBeDisabled();
      await expect(b, 'leg 4: and its title says why').toHaveAttribute('title', DISABLED_TITLE);
    }
    await expect(transportOf(page), 'leg 4: the transport shows Play, not pressed').toHaveAttribute('aria-label', 'Play');
    const palette = page.locator('[data-fab-left-dock] button');
    const paletteCount = await palette.count();
    expect(paletteCount, 'leg 4: the palette lists its items').toBeGreaterThan(0);
    for (let i = 0; i < paletteCount; i += 1) {
      await expect(palette.nth(i), `leg 4: palette item ${i + 1} is disabled`).toBeDisabled();
      await expect(palette.nth(i), `leg 4: palette item ${i + 1} says why`).toHaveAttribute('title', DISABLED_TITLE);
    }

    // The keys, with focus on the board rather than on the card's button (a focused button
    // takes Space as its own press).
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    const tickBefore = (await readScene(page)).tick;
    const sentBefore = await sendCounts(page);
    for (const key of [' ', '.', 'Control+z', 'Control+s']) {
      await page.keyboard.press(key === ' ' ? 'Space' : key);
    }
    await page.waitForTimeout(SETTLE_AFTER_INPUT_MS);
    const sentAfterKeys = await sendCounts(page);
    console.log(
      `P90-FAIL-01 leg-4 dialogs=${dialogs} tick_before=${tickBefore} tick_after=${(await readScene(page)).tick} sent_before=${JSON.stringify(sentBefore)} sent_after_keys=${JSON.stringify(sentAfterKeys)}`,
    );
    expect(dialogs, 'leg 4: Ctrl+S opened no save prompt').toBe(0);
    await expect(transportOf(page), 'leg 4: Space left Play unpressed').toHaveAttribute('aria-label', 'Play');
    // WR-C-03: graded on what the PAGE sends; a dead host moves no tick whatever it is sent.
    expect(
      { controls: sentAfterKeys.controls - sentBefore.controls, gestures: sentAfterKeys.inputs - sentBefore.inputs },
      'leg 4: Space, ., Ctrl+Z and Ctrl+S sent nothing to the stopped host',
    ).toEqual({ controls: 0, gestures: 0 });
    expect((await readScene(page)).tick, 'leg 4: no key moved the tick').toBe(tickBefore);
    expect(await statusText(page), 'leg 4: the status line still says the simulation stopped').toBe(STOPPED);

    // A click on a machine the canvas owns (not one under the card) opens no panel.
    const scene = await readScene(page);
    let target: { x: number; y: number; id: number } | null = null;
    for (const n of scene.nodes) {
      const [cx, cy] = n.cells[0]!;
      const pt = await screenCellCentre(page, cx, cy);
      const tag = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.tagName ?? 'NONE', [pt.x, pt.y] as const);
      if (tag === 'CANVAS') {
        target = { ...pt, id: n.id };
        break;
      }
    }
    expect(target, 'leg 4: a machine of the demo is on the open board, clear of the card').not.toBeNull();
    await page.mouse.click(target!.x, target!.y);
    await page.waitForTimeout(SETTLE_AFTER_INPUT_MS);
    const selected = await selectedNodeOf(page);
    const sentAfterClick = await sendCounts(page);
    console.log(`P90-FAIL-01 leg-4 clicked_node=${target!.id} selected=${String(selected)} sent_after_click=${JSON.stringify(sentAfterClick)}`);
    expect(selected, 'leg 4: the click selected nothing').toBeNull();
    await expect(page.locator('#fab-config-heading'), 'leg 4: and opened no panel').toHaveCount(0);
    expect(sentAfterClick, 'leg 4: and the click sent nothing').toEqual(sentAfterKeys);

    // Looking around still works: a middle-button drag pans, the wheel zooms, Help opens.
    const camBefore = await cameraOf(page);
    await page.mouse.move(target!.x, target!.y);
    await page.mouse.down({ button: 'middle' });
    await page.mouse.move(target!.x + 80, target!.y + 40, { steps: 8 });
    await page.mouse.up({ button: 'middle' });
    await expect
      .poll(async () => {
        const c = await cameraOf(page);
        return Math.round(Math.abs(c.x - camBefore.x) + Math.abs(c.y - camBefore.y));
      }, {
        // Derived (D-12): the camera pans on the pointer events themselves (`camera.ts`), so it
        // reads moved on the frames after the release.
        timeout: addWaitBudget(frameBudgetMs(DRAWN_STATE_FRAMES), 'leg 4: the pan read on the frames after the drag'),
        message: 'leg 4: a middle-button drag moved the camera',
      })
      .toBeGreaterThan(0);
    const scaleBefore = (await cameraOf(page)).scale;
    await page.mouse.move(target!.x, target!.y);
    await page.mouse.wheel(0, -240);
    await expect
      .poll(async () => (await cameraOf(page)).scale, {
        // Derived (D-12): one wheel notch sets the camera in its own event.
        timeout: addWaitBudget(frameBudgetMs(DRAWN_STATE_FRAMES), 'leg 4: the zoom read on the frames after the wheel'),
        message: 'leg 4: the wheel changed the zoom',
      })
      .not.toBe(scaleBefore);
    await toolbar.getByRole('button', { name: 'Help', exact: true }).click();
    await expect(page.locator('#fab-help-panel'), 'leg 4: Help still opens').toBeVisible();

    await expectRenderLoopAlive(page, 'leg 4: the stopped board, looked around', { boardHeld: true });
    errs.assertNone('leg 4, the stopped controls');
  });
});
