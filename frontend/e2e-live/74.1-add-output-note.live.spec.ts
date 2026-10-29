import { test, expect, type Page } from '@playwright/test';
import {
  DEMO_NODE_COUNT,
  armAndPlaceAt,
  cameraOf,
  expectRenderLoopAlive,
  newBoard,
  pollScene,
  readScene,
  resetToDemo,
  resetZoomToActualSize,
  selectMachineAt,
  waitForCameraSettle,
  waitForAppReady,
  watchPageErrors,
  type SceneFacts,
  restoreHostAfterFailedTest,
} from './support/oracle';
import { startFrameSampler, waitForFramesAtFloor } from '../e2e/support/frameSampler';

// 74.1-add-output-note.live.spec.ts (plan 74.1-19, re-walk J10, review WR-02) - the note
// beside `+ Add output` on the REAL host (dev_render_server, real Core -> RenderProducer
// -> postcard -> WS). Zero mocks, zero injected packets. The default live viewport is
// 1280x720, the window size the note must be readable at.
//
// ---------------------------------------------------------------------------
// WHAT THE USER SAW, MEASURED
// ---------------------------------------------------------------------------
//
// J10: "note appears and disappears very fast". Sampled every animation frame against
// this same host, what flashed was the pending status "Waiting for the host to apply this
// change.", painted for 59 to 173 ms on every `+ Add output` press and cleared by the
// ~10 Hz chrome poll once the fold landed. The note itself never appeared on the board
// used (a fresh Factory with no fault belt), and where it did appear it promised a
// release the host never performs.
//
// ---------------------------------------------------------------------------
// THE LEGS
// ---------------------------------------------------------------------------
//
//   1. The demo Factory (the 3x3 at (4,2), the large square second from the left, whose
//      fault belt runs down from (5,5) to a Sink), `+ Add output` twice. For 600 ms after
//      each click a requestAnimationFrame sampler records, frame by frame, whether ANY
//      status text is in the Ports section (plan 74.1-28 widened it from the exact
//      pending sentence) and whether the button is disabled. No frame may show any; at least one frame must show the button disabled and
//      the Factory must gain the output, so the leg cannot pass on a press that never
//      happened. After the second add (three outputs, every Out slot taken, the fault
//      belt where a fourth row would go) the note reads "One more output needs another
//      row, and a belt is in the way. Move it first.", lies inside the panel's visible
//      scroll area, and still reads so 1.5 s later.
//   2. The same Factory, a third press: the host refuses with "Growing would cover a belt.
//      Move that belt first.", the ports and the box are unchanged, and the note stays.
//      Plan 74.1-28 (re-walk G1): sampled every frame for 2.5 s from the press, no Ports
//      status text ever paints, and from the refusal on `+ Add output` and every
//      Disconnect control stay enabled - the refusal ends the panel's wait.
//   3. A fresh Factory on an empty board (no fault belt), two adds: the note never
//      appears on any frame and no pending sentence flashes.
//   4. Plan 74.1-28 (round-3 review WR-05): pause from the toolbar, `+ Add output` on the
//      demo Factory (the paused wording shows at once), Resume from the toolbar. Sampled
//      every frame for 1 s from the Resume click, once the paused wording clears no frame
//      carries any Ports status text: the waiting line no longer flashes on Resume.
//      Plan 84-17: the leg also records, timed from the Resume click itself (a capture-phase
//      listener, as legs 1 and 3 time from the add click), when the held add folded as the
//      page's scene shows it, when the waiting line was first in the Ports DOM and first
//      painted, and when `+ Add output` was released, in the DOM and painted, sampled by a
//      5 ms in-page watcher beside the frame sampler. Every run logs them as one
//      `RESUME_TIMING` line.
//
// THE WINDOWS WAIT FOR THEIR FRAMES (plan 84-09, GATE-01). The 2026-10-09 CI run (a 2-vCPU
// GitHub runner drawing the board through software GL at 12 to 15 frames a second) failed
// leg 1 on `press to 2 outputs: the sampler ran`: 9 frames where above 10 was needed, in a
// window fixed at 600 ms. Legs 2 and 4 carry the same shape (2.5 s and above 30 frames; 1 s
// and above 20 frames after the paused wording clears), and leg 4 reproduced red on two
// cores here (15). Every window now keeps its stated time as a minimum AND runs on until
// the frame count its old floor meant is in, through `frameSampler.ts`, so a slow machine
// samples longer, never less, and each per-frame property is still graded on every frame
// observed. A window whose frames never come, or that never opens, is a named failure at
// the helper's cap.
//
// A SLOW HOST'S WAITING LINE IS NOT A FLASH (plan 84-11). Legs 1 and 3 assumed the host applies
// every add inside the panel's 400 ms grace. At a 100% CPU quota (one CPU's time) plan 84-09 saw one
// frame of "Waiting for the host to apply this change." in leg 3 (once in seven runs): the add
// applied just past the grace, and the panel showed the true line until it did, as designed. The
// chosen default (plan 84-11): the J10 wording stays,
// and each press may paint that line only when the host took longer than the grace to apply it,
// measured from the click (`waitingLineVerdict`). The line on a press applied inside the grace, any
// other status text, or the line after the add applied is still red.
//
// A SLOW HOST'S WAITING LINE AFTER RESUME (plan 84-17). Plan 84-16's counted pass at the GPU proxy
// went red here on one frame of "Waiting for the host to apply this change." after Resume. Measured
// with this leg's Resume timings at the proxy (on 10 / off 182, 3.96 to 4.31 frames a second), the
// class was PRODUCT: in 3 of 4 runs the page's scene showed the held add applied 24 to 61 ms after
// the click and the line still went into the DOM at 406 to 411 ms, because the grace's wall-clock
// timer found the edit latched and the frame-bound chrome poll that releases the latch did not run
// until 448 to 449 ms. Plan 84-17 fixed the product first (`portEditGrace.ts`: when the grace runs
// out it asks the scene), and this leg is now graded by `waitingLineVerdict` from the Resume click,
// as legs 1 and 3 are from the add click: the line may paint only once the host took longer than the
// grace to apply the held add; the line inside the grace, after the add applied, or any other text
// is red. Every run logs `RESUME_TIMING`.
//
// MODEL FIRST, THEN RENDER HEALTH: every leg opens with `watchPageErrors` before `goto`
// and closes with `expectRenderLoopAlive`.

const FACTORY_KIND = 2;
/** `PORT_EDIT_PENDING`, transcribed, not imported. */
const PENDING_COPY = 'Waiting for the host to apply this change.';
/** `ADD_BLOCKED_BY_BELT_NOTE`, transcribed, not imported. */
const NOTE_COPY = 'One more output needs another row, and a belt is in the way. Move it first.';
/** `REFUSAL_COPY.GrowCoversBelt`, transcribed, not imported. */
const GROW_COVERS_BELT_COPY = 'Growing would cover a belt. Move that belt first.';
/** `PORT_EDIT_PENDING_GRACE_MS`, transcribed, not imported: how long an unfolded add waits before
 *  the panel shows the waiting line. */
const GRACE_MS = 400;
/** How long after each click the sampler watches, at least. */
const SAMPLE_MS = 600;
/** And how many frames it reads, at least: the old floor (above 10) as a count reached. */
const ADD_FRAMES = 11;
/** `PORT_EDIT_PENDING_PAUSED`, transcribed, not imported. */
const PAUSED_COPY = 'The sim is paused - this change applies when you resume.';
/** Plan 74.1-28: how long the leg-4 sampler watches once the paused wording clears, at least. */
const RESUME_SAMPLE_MS = 1000;
/** And how many frames after the clear it reads, at least: the old floor (above 20). */
const RESUME_FRAMES = 21;

/** What the leg-4 Resume sampler counted (plan 74.1-28, WR-05). */
interface ResumeSample {
  frames: number;
  /** Frames still showing the paused wording right after the click. */
  pausedFrames: number;
  /** Frames from the first one without the paused wording. */
  afterClear: number;
  /** Of those, frames with any Ports status text. */
  flashed: number;
  flashSeen: string;
  /** Plan 84-17, each a `performance.now()` (-1 when never seen): the first frame after the
   *  clear with any Ports status text, the first such frame showing the waiting line, and the
   *  first probed frame with `+ Add output` enabled. */
  firstStatusAt: number;
  firstLineAt: number;
  unlatchAt: number;
  /** Frames after the clear whose status text is neither empty nor the waiting line. */
  otherStatus: number;
  /** Frames after the clear with status text and `+ Add output` enabled (the add applied). */
  statusReleased: number;
}

/** What leg 4's 5 ms in-page watcher recorded from the Resume click (plan 84-17). Every time is a
 *  `performance.now()`, -1 when never seen. */
interface ResumeWatch {
  clickAt: number;
  clickTick: number;
  /** The first sample on which the page's scene showed the Factory with two outputs. */
  foldAt: number;
  foldTick: number;
  /** The first sample with the waiting line in the Ports section's DOM. */
  lineDomAt: number;
  /** The first sample with `+ Add output` enabled. */
  releaseDomAt: number;
  /** Samples with the waiting line in the DOM AND `+ Add output` enabled. */
  lineDomWithRelease: number;
  /** Milliseconds between consecutive samples that both showed the line, after `foldAt`. */
  lineDomAfterFoldMs: number;
}

/** Plan 74.1-28: how long the leg-2 sampler watches from the refused press, at least. */
const G1_SAMPLE_MS = 2500;
/** And how many frames it reads, at least: the old floor (above 30) as a count reached. */
const G1_FRAMES = 31;
/** And how many frames it grades from the refusal's first drawn frame on, at least: the old
 *  "on screen for most of the window" floor (above 20), kept as a count reached (plan 84-13). */
const G1_AFTER_REFUSAL_FRAMES = 21;
/** `REFUSAL_HOLD_MS`, transcribed, not imported (`frontend/src/chrome/RefusalMessage.tsx:34`):
 *  how long the band holds one refusal sentence before it takes itself away. */
const REFUSAL_HOLD_MS = 4000;

/** What the leg-2 refusal sampler counted (plan 74.1-28, re-walk G1). */
interface G1Sample {
  frames: number;
  /** Frames with any non-empty `role=status` text in the Ports section. */
  status: number;
  statusSeen: string;
  /** Frames graded from the refusal's first drawn frame on (plan 84-13; before it, the frames
   *  on which `#fab-refusal` carried text, the same set on a 60 fps page). */
  afterRefusal: number;
  /** Of those, frames with `+ Add output` or any Disconnect control disabled. */
  greyedAfterRefusal: number;
  /** Of those, frames drawn inside the refusal's hold that did NOT show it (a flash or an
   *  early drop), the hold measured from the last frame drawn before it showed. */
  missingInHold: number;
  /** Frames drawn inside the hold that showed it. */
  shownInHold: number;
  /** The most Disconnect controls seen on one frame. */
  disconnects: number;
}

function theFactory(scene: SceneFacts): SceneFacts['nodes'][number] {
  const fs = scene.nodes.filter((n) => n.kind === FACTORY_KIND);
  expect(fs, 'the board carries exactly one Factory').toHaveLength(1);
  return fs[0];
}

function outCount(node: SceneFacts['nodes'][number]): number {
  return node.ports.filter((p) => p.role === 1).length;
}

const addButton = (page: Page) =>
  page.getByRole('region', { name: 'Ports' }).getByRole('button', { name: '+ Add output' });

/** What the per-frame sampler saw. */
interface Sampled {
  frames: number;
  /** Frames with ANY non-empty `role=status` text in the Ports section (plan 74.1-28:
   *  widened from the exact pending sentence, like its mock twin, so a different
   *  flashing line fails it too). */
  status: number;
  /** The last status text a frame carried, for the failure message. */
  statusSeen: string;
  /** Milliseconds from the window's first frame to the window's last, and to the first
   *  status frame and the first frame with the button released (-1 when none). */
  elapsedMs: number;
  firstStatusMs: number;
  unlatchMs: number;
  disabled: number;
  note: number;
  /** Frames whose Ports status text was anything but the waiting line. */
  otherStatus: number;
  /** Frames with Ports status text on which the button was already released (the add applied). */
  statusReleased: number;
  /** Milliseconds from the click on `+ Add output` to the first frame with the button released:
   *  how long the host took to apply the add, as the panel saw it (-1 when it never released in
   *  the window). */
  applyMs: number;
  /** Milliseconds from the click to the first frame with Ports status text (-1 when none). */
  statusFromClickMs: number;
}

/**
 * THE WAITING LINE, HONEST (plan 84-11, a stated default). The
 * panel holds "Waiting for the host to apply this change." back for `GRACE_MS` after the click
 * and shows it until the host applies the add, with no minimum time on screen (`portEditGrace.ts`),
 * which is the J10 ruling: no flash when the host is quick. On a slow host the line is true, and
 * it shows; plan 84-09 saw it for one frame at a 100% CPU quota. So a press may paint
 * that line, and only that line, and only when the host took longer than the grace to apply it: the
 * line first painted at least `GRACE_MS` after the click, the add applied more than `GRACE_MS` after
 * the click, and no frame shows it after the add applied. Any other status text, the line on a press
 * the host applied within the grace, or the line after the add applied, is red.
 *
 * Leg 4 is graded by it too since plan 84-17, timed from the Resume click: Resume restarts the grace
 * on the held add (WR-05), so the click on Play is where its 400 ms start, as the click on `+ Add
 * output` is for legs 1 and 3.
 */
function waitingLineVerdict(s: Pick<Sampled, 'status' | 'otherStatus' | 'statusReleased' | 'applyMs' | 'statusFromClickMs'>): { other: number; afterApply: number; inTheGrace: boolean } {
  return {
    other: s.otherStatus,
    afterApply: s.statusReleased,
    // `applyMs` is -1 when the add had not applied by the window's end, which is after the grace.
    inTheGrace: s.status > 0 && !((s.applyMs > GRACE_MS || s.applyMs === -1) && s.statusFromClickMs >= GRACE_MS),
  };
}

/**
 * Click `+ Add output` with a requestAnimationFrame sampler running for `SAMPLE_MS` after
 * the click, then wait for the host to fold the add (`outsAfter` outputs). Returns what
 * the sampler counted: frames, frames showing any status text in the Ports section,
 * frames with the button disabled, frames showing the add note.
 */
async function sampledAdd(page: Page, outsAfter: number): Promise<Sampled> {
  // The window opens on the first frame the press has landed (the button latched; the
  // pending mirror and the latch commit together, so no status frame precedes it) and
  // runs for SAMPLE_MS AND ADD_FRAMES frames, whichever comes later (the 2026-10-09 CI run read
  // 9 frames in a fixed 600 ms). A press that never latches never opens it: a named
  // failure at the cap.
  // The click's own time, taken in the capture phase before the panel's handler starts the grace,
  // so the apply time and the line's time are measured from where the grace is (plan 84-11).
  await page.evaluate(() => {
    const w = window as unknown as { __addClickAt?: number; __addClickListener?: boolean };
    w.__addClickAt = -1;
    if (w.__addClickListener === true) return;
    w.__addClickListener = true;
    document.addEventListener(
      'click',
      (e) => {
        const b = e.target instanceof Element ? e.target.closest('button') : null;
        if (b?.textContent === '+ Add output' && w.__addClickAt === -1) w.__addClickAt = performance.now();
      },
      true,
    );
  });
  await startFrameSampler(
    page,
    '__addNoteSample',
    { minMs: SAMPLE_MS, frames: ADD_FRAMES },
    {
      open: 0,
      openedAt: -1,
      status: 0,
      statusSeen: '',
      firstStatusMs: -1,
      firstStatusAt: -1,
      unlatchMs: -1,
      unlatchAt: -1,
      disabled: 0,
      note: 0,
      otherStatus: 0,
      statusReleased: 0,
    },
    (t) => {
      const sec = document.querySelector('section[aria-label="Ports"]');
      const add = Array.from(sec?.querySelectorAll('button') ?? []).find((b) => b.textContent === '+ Add output');
      const now = performance.now();
      if (t.open === 0) {
        if (add?.disabled !== true) return false;
        t.open = 1;
        t.openedAt = now;
      }
      const statusText = Array.from(sec?.querySelectorAll('[role="status"]') ?? [])
        .map((el) => el.textContent ?? '')
        .join('|');
      if (statusText !== '') {
        t.status++;
        t.statusSeen = statusText;
        if (t.firstStatusMs < 0) {
          t.firstStatusMs = Math.round(now - t.openedAt);
          t.firstStatusAt = now;
        }
        if (statusText !== 'Waiting for the host to apply this change.') t.otherStatus++;
        if (add?.disabled !== true) t.statusReleased++;
      }
      if (add?.disabled === true) t.disabled++;
      else if (t.unlatchMs < 0) {
        t.unlatchMs = Math.round(now - t.openedAt);
        t.unlatchAt = now;
      }
      if (document.getElementById('fab-port-add-advisory') !== null) t.note++;
      return true;
    },
  );
  await addButton(page).click();
  const r = await waitForFramesAtFloor<{
    status: number;
    statusSeen: string;
    firstStatusMs: number;
    firstStatusAt: number;
    unlatchMs: number;
    unlatchAt: number;
    disabled: number;
    note: number;
    otherStatus: number;
    statusReleased: number;
  }>(page, '__addNoteSample');
  const clickAt = await page.evaluate(() => (window as unknown as { __addClickAt?: number }).__addClickAt ?? -1);
  const since = (at: number): number => (at < 0 || clickAt < 0 ? -1 : Math.round(at - clickAt));
  await pollScene(page, (s) => outCount(theFactory(s)), {
    message: `the real host folded the AddPort (the Factory now has ${outsAfter} outputs)`,
  }).toBe(outsAfter);
  const out: Sampled = {
    frames: r.frames,
    elapsedMs: r.elapsedMs,
    status: r.tallies.status,
    statusSeen: r.tallies.statusSeen,
    firstStatusMs: r.tallies.firstStatusMs,
    unlatchMs: r.tallies.unlatchMs,
    disabled: r.tallies.disabled,
    note: r.tallies.note,
    otherStatus: r.tallies.otherStatus,
    statusReleased: r.tallies.statusReleased,
    applyMs: since(r.tallies.unlatchAt),
    statusFromClickMs: since(r.tallies.firstStatusAt),
  };
  console.log(`ADD_NOTE_SAMPLE to ${outsAfter} ${JSON.stringify(out)}`);
  return out;
}

/** The add note is inside the panel's visible scroll area right now. */
async function noteInView(page: Page): Promise<string> {
  return page.evaluate(() => {
    const note = document.getElementById('fab-port-add-advisory');
    const scroller = document.querySelector<HTMLElement>('[data-fab-panel-scroll]');
    if (note === null || scroller === null) return 'missing';
    const v = scroller.getBoundingClientRect();
    const top = v.top + scroller.clientTop;
    const bottom = top + scroller.clientHeight;
    const n = note.getBoundingClientRect();
    return n.top >= top && n.bottom <= bottom && n.height > 0
      ? 'in view'
      : `note y ${Math.round(n.top)}..${Math.round(n.bottom)}, panel shows ${Math.round(top)}..${Math.round(bottom)}`;
  });
}

async function bootOnDemo(page: Page): Promise<ReturnType<typeof watchPageErrors>> {
  const errs = watchPageErrors(page);
  await page.goto('/');
  await waitForAppReady(page);
  await resetToDemo(page, DEMO_NODE_COUNT);
  return errs;
}

// THE SHARED HOST AFTER A TEST THAT DID NOT PASS (plan 84-13, D-12): this spec pauses the
// one shared host, and a test that times out while paused never reaches its `finally`.
// `restoreHostAfterFailedTest` puts the host back to running after a failed or timed-out
// test only, logs `HOST RESTORED after <title>`, and never changes that test's verdict.
test.afterEach(async ({ page }, testInfo) => {
  await restoreHostAfterFailedTest(page, testInfo);
});

test.describe.configure({ mode: 'serial' });

test.describe('74.1-19 live: the add note is true, readable and nothing flashes (J10)', () => {
  test('leg 1: two adds on the demo Factory flash nothing, and the note then stays, in view', async ({ page }) => {
    const errs = await bootOnDemo(page);
    const f0 = theFactory(await readScene(page));
    expect(outCount(f0), 'the demo Factory starts with one output').toBe(1);
    await selectMachineAt(page, 4, 2);
    await expect(page.locator('#fab-port-add-advisory'), 'one output: the add would be accepted, no note').toHaveCount(0);

    for (const outs of [2, 3]) {
      const s = await sampledAdd(page, outs);
      expect(s.frames, `press to ${outs} outputs: the sampler ran (${JSON.stringify(s)})`).toBeGreaterThan(10);
      expect(s.disabled, `press to ${outs} outputs: the button latched on at least one frame`).toBeGreaterThan(0);
      expect(
        waitingLineVerdict(s),
        `press to ${outs} outputs: no frame painted any Ports status text, saw "${s.statusSeen}" (before plan 74.1-19 "${PENDING_COPY}" flashed for 59 to 173 ms), except that line once the host took longer than its ${GRACE_MS} ms grace to apply the add (applied after ${s.applyMs} ms, line from ${s.statusFromClickMs} ms)`,
      ).toEqual({ other: 0, afterApply: 0, inTheGrace: false });
    }

    // Three outputs: the fourth would need a fourth row, over the fault belt's tile (5,5).
    const note = page.locator('#fab-port-add-advisory');
    await expect(note, 'the note says why one more output would be refused').toHaveText(NOTE_COPY);
    expect(await addButton(page).getAttribute('aria-describedby'), 'wired to the button').toBe('fab-port-add-advisory');
    await expect(addButton(page), 'the note never gates the add').toBeEnabled();
    expect(await noteInView(page), 'the note lies inside the panel at 1280x720').toBe('in view');
    await page.waitForTimeout(1500);
    await expect(note, 'and it is still there 1.5 s later: steady, not a flash').toHaveText(NOTE_COPY);
    expect(await noteInView(page), 'still in view').toBe('in view');

    await expectRenderLoopAlive(page, 'after leg 1');
    errs.assertNone('leg 1');
  });

  test('leg 2: the third press on the demo Factory is refused with the growth sentence and nothing moves', async ({
    page,
  }) => {
    const errs = await bootOnDemo(page);
    await selectMachineAt(page, 4, 2);
    for (const outs of [2, 3]) {
      await addButton(page).click();
      await pollScene(page, (s) => outCount(theFactory(s)), { message: `the host folded output ${outs}` }).toBe(outs);
    }
    await expect(page.locator('#fab-port-add-advisory')).toHaveText(NOTE_COPY);
    const held = theFactory(await readScene(page));

    await expect(addButton(page), 'the button is still offered: the host is the judge').toBeEnabled();
    // Plan 74.1-28 (re-walk G1): a per-frame sample from the press for 2.5 s. Before the
    // fix the refusal landed at about 0.2 s and then the panel said it was waiting (0.4 to
    // 0.6 s) and stalled (from about 0.73 s) with every control greyed. After it, no frame
    // carries Ports status text, and every frame after the refusal shows `+ Add output`
    // and each Disconnect control enabled.
    // Plan 84-09: the window runs for G1_SAMPLE_MS AND G1_FRAMES frames, whichever comes
    // later, so a slow machine grades more of the refusal, never less (the 2026-10-09 CI run).
    //
    // A COUNT INSIDE A PRODUCT HOLD (plan 84-13, D-12, a stated default). The
    // midday 2026-10-13 CI run failed `the refusal was on screen for most of the window` at 18 frames where
    // above 20 was needed: the band holds the sentence for REFUSAL_HOLD_MS (4 s), and a page
    // drawing 5 frames a second draws about 20 frames in it, so no cap could make "21 frames
    // showing it" pass. By plan 84-08's rule (a floor becomes a count reached) the window keeps
    // its 2.5 s and 31 frames from the press and ALSO runs until 21 frames have been graded from
    // the refusal's first drawn frame on; both per-frame properties after the refusal (no Ports
    // status text; `+ Add output` and every Disconnect enabled) are graded on every one of them;
    // and the presence clause is: the refusal is on screen on EVERY frame from its first drawn
    // frame until its hold ends, the hold measured from the last frame drawn before it showed,
    // so a flash or an early drop is red. On a 60 fps desktop the graded frames are the same set
    // as before (every frame after the refusal inside a 2.5 s window lies inside its hold).
    await startFrameSampler(
      page,
      '__g1Live',
      { minMs: G1_SAMPLE_MS, frames: G1_FRAMES, tallyAtLeast: { key: 'afterRefusal', frames: G1_AFTER_REFUSAL_FRAMES } },
      {
        status: 0,
        statusSeen: '',
        afterRefusal: 0,
        greyedAfterRefusal: 0,
        disconnects: 0,
        missingInHold: 0,
        shownInHold: 0,
        firstRefusalAt: -1,
        lastBeforeAt: -1,
      },
      (t, a) => {
        const now = performance.now();
        const sec = document.querySelector('section[aria-label="Ports"]');
        const text = Array.from(sec?.querySelectorAll('[role="status"]') ?? [])
          .map((el) => el.textContent ?? '')
          .join('|');
        if (text !== '') {
          t.status++;
          t.statusSeen = text;
        }
        const shows = (document.getElementById('fab-refusal')?.textContent ?? '').trim() !== '';
        if (t.firstRefusalAt < 0) {
          if (!shows) {
            t.lastBeforeAt = now;
            return;
          }
          t.firstRefusalAt = now;
        }
        t.afterRefusal++;
        const buttons = Array.from(sec?.querySelectorAll('button') ?? []);
        const add = buttons.find((b) => b.textContent === '+ Add output');
        const disconnects = buttons.filter((b) => (b.getAttribute('aria-label') ?? '').startsWith('Disconnect'));
        t.disconnects = Math.max(t.disconnects, disconnects.length);
        if (add === undefined || add.disabled || disconnects.some((b) => b.disabled)) t.greyedAfterRefusal++;
        const holdFrom = t.lastBeforeAt >= 0 ? t.lastBeforeAt : t.firstRefusalAt;
        if (now < holdFrom + a.holdMs) {
          if (shows) t.shownInHold++;
          else t.missingInHold++;
        }
      },
      { holdMs: REFUSAL_HOLD_MS },
    );
    await addButton(page).click();
    let latched = '';
    await expect
      .poll(
        async () => {
          const now = ((await page.locator('#fab-refusal').textContent()) ?? '').trim();
          if (now !== '' && latched === '') latched = now;
          return latched;
        },
        { timeout: 15_000, intervals: [100, 250, 500], message: 'the third press was answered with a refusal sentence' },
      )
      .not.toBe('');
    expect(latched, 'the refusal says the same thing the note said, in growth words').toBe(GROW_COVERS_BELT_COPY);
    const after = theFactory(await readScene(page));
    expect(after.ports, 'the ports are unchanged').toEqual(held.ports);
    expect(after.cells, 'the box is unchanged').toEqual(held.cells);
    await expect(page.locator('#fab-port-add-advisory'), 'the note still stands').toHaveText(NOTE_COPY);

    const g1w = await waitForFramesAtFloor<Omit<G1Sample, 'frames'>>(page, '__g1Live');
    const g1: G1Sample = { frames: g1w.frames, ...g1w.tallies };
    console.log(`G1_LIVE ${JSON.stringify({ ...g1, elapsedMs: g1w.elapsedMs })}`);
    expect(g1.frames, `the sampler ran (${JSON.stringify(g1)})`).toBeGreaterThan(30);
    expect(g1.afterRefusal, 'the window graded more than 20 frames from the refusal\'s first drawn frame on').toBeGreaterThan(20);
    expect(
      g1.missingInHold,
      `the refusal was on screen on every frame from its first drawn frame until its ${REFUSAL_HOLD_MS} ms hold ended (${g1.shownInHold} frames showed it): no flash, no early drop`,
    ).toBe(0);
    expect(g1.disconnects, 'the demo Factory has docked rows, so the Disconnect half is not vacuous').toBeGreaterThan(0);
    expect(g1.status, `no frame carried Ports status text after a refused add (saw "${g1.statusSeen}")`).toBe(0);
    expect(g1.greyedAfterRefusal, 'no frame after the refusal greyed + Add output or a Disconnect').toBe(0);
    await expect(addButton(page), 'the panel is ready for the next click').toBeEnabled();
    expect(outCount(theFactory(await readScene(page))), 'still three outputs').toBe(3);

    await expectRenderLoopAlive(page, 'after leg 2');
    errs.assertNone('leg 2');
  });

  test('leg 3: a fresh Factory with no fault belt never shows the note, and its adds flash nothing', async ({
    page,
  }) => {
    const errs = await bootOnDemo(page);
    await newBoard(page);
    await resetZoomToActualSize(page);
    await waitForCameraSettle(page);
    expect((await cameraOf(page)).scale, 'the camera is at scale 1').toBe(1);
    await armAndPlaceAt(page, 'Factory', 10, 4);
    await pollScene(page, (s) => s.nodes.length, { message: 'the real host echoed the placed Factory' }).toBe(1);
    expect(
      (await readScene(page)).belts,
      'nothing on the board but the Factory: no belt anywhere it could grow onto',
    ).toEqual([]);
    await selectMachineAt(page, 10, 4);
    for (const outs of [2, 3]) {
      const s = await sampledAdd(page, outs);
      expect(s.disabled, `press to ${outs} outputs: the button latched on at least one frame`).toBeGreaterThan(0);
      expect(
        waitingLineVerdict(s),
        `press to ${outs} outputs: no frame painted any Ports status text (saw "${s.statusSeen}"), except "${PENDING_COPY}" once the host took longer than its ${GRACE_MS} ms grace to apply the add (applied after ${s.applyMs} ms, line from ${s.statusFromClickMs} ms)`,
      ).toEqual({ other: 0, afterApply: 0, inTheGrace: false });
      expect(s.note, `press to ${outs} outputs: no frame showed the add note`).toBe(0);
    }
    await page.waitForTimeout(500);
    await expect(page.locator('#fab-port-add-advisory'), 'three outputs, nothing in the way: no note').toHaveCount(0);
    expect(await addButton(page).getAttribute('aria-describedby')).toBeNull();

    await expectRenderLoopAlive(page, 'after leg 3');
    errs.assertNone('leg 3');
  });

  test('leg 4: Resume with a paused add pending flashes no waiting line (WR-05)', async ({ page }) => {
    const errs = await bootOnDemo(page);
    await selectMachineAt(page, 4, 2);
    // Pause from the toolbar and let the host drain to a frozen tick.
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    let last = -1;
    await expect
      .poll(
        async () => {
          const t = (await readScene(page)).tick;
          const still = t === last;
          last = t;
          return still;
        },
        { timeout: 8_000, intervals: [300], message: 'the paused host stops ticking' },
      )
      .toBe(true);
    const status = page.getByRole('region', { name: 'Ports' }).getByRole('status');
    await addButton(page).click();
    await expect(status, 'a paused add says so at once').toHaveText(PAUSED_COPY);
    expect(outCount(theFactory(await readScene(page))), 'held by the paused host').toBe(1);

    // Plan 84-17: WHEN THE HELD ADD FOLDED AND WHEN THE WAITING LINE APPEARED, from the Resume
    // click. A capture-phase listener stamps the click on the toolbar's Play button (its label is
    // read before the app's handler flips it to Pause), and a 5 ms watcher records the first
    // moment the page's scene shows the Factory with two outputs (the fold as the page knows it),
    // the first moment the waiting line is in the Ports DOM, and the first moment `+ Add output`
    // is enabled. The frame sampler below records the first painted frame of each.
    await page.evaluate(
      (a) => {
        const w = window as unknown as {
          __resumeWatch?: Record<string, number>;
          __fabrico?: { scene(): { tick: number; nodes: { kind: number; ports: { role: number }[] }[] } };
        };
        const rec: Record<string, number> = {
          clickAt: -1,
          clickTick: -1,
          foldAt: -1,
          foldTick: -1,
          lineDomAt: -1,
          releaseDomAt: -1,
          lineDomWithRelease: 0,
          lineDomAfterFoldMs: 0,
          interval: -1,
          lastLineAt: -1,
        };
        w.__resumeWatch = rec;
        document.addEventListener(
          'click',
          (e) => {
            const b = e.target instanceof Element ? e.target.closest('button') : null;
            if (rec.clickAt === -1 && b?.getAttribute('aria-label') === 'Play') {
              rec.clickAt = performance.now();
              rec.clickTick = w.__fabrico?.scene().tick ?? -1;
            }
          },
          true,
        );
        rec.interval = window.setInterval(() => {
          if (rec.clickAt === -1) return;
          const now = performance.now();
          const sec = document.querySelector('section[aria-label="Ports"]');
          const text = Array.from(sec?.querySelectorAll('[role="status"]') ?? [])
            .map((el) => el.textContent ?? '')
            .join('|');
          const add = Array.from(sec?.querySelectorAll('button') ?? []).find((b) => b.textContent === '+ Add output');
          const enabled = add !== undefined && !add.disabled;
          const scene = w.__fabrico?.scene();
          const factories = (scene?.nodes ?? []).filter((n) => n.kind === a.kind);
          const outs = factories.length === 1 ? factories[0].ports.filter((p) => p.role === a.role).length : -1;
          if (rec.foldAt === -1 && outs === a.outs) {
            rec.foldAt = now;
            rec.foldTick = scene?.tick ?? -1;
          }
          const line = text === a.pendingCopy;
          if (line && rec.lineDomAt === -1) rec.lineDomAt = now;
          if (enabled && rec.releaseDomAt === -1) rec.releaseDomAt = now;
          if (line && enabled) rec.lineDomWithRelease++;
          if (line) {
            if (rec.foldAt !== -1 && rec.lastLineAt !== -1 && rec.lastLineAt >= rec.foldAt) {
              rec.lineDomAfterFoldMs += now - rec.lastLineAt;
            }
            rec.lastLineAt = now;
          } else {
            rec.lastLineAt = -1;
          }
        }, 5);
      },
      { kind: FACTORY_KIND, role: 1, outs: 2, pendingCopy: PENDING_COPY },
    );

    // Plan 84-09: the window opens on the first frame without the paused wording and runs
    // for RESUME_SAMPLE_MS AND RESUME_FRAMES frames, whichever comes later (this leg read 15
    // frames after the clear on two cores, where above 20 was needed).
    await startFrameSampler(
      page,
      '__resumeSample',
      { minMs: RESUME_SAMPLE_MS, frames: RESUME_FRAMES },
      {
        cleared: 0,
        pausedFrames: 0,
        afterClear: 0,
        flashed: 0,
        flashSeen: '',
        firstStatusAt: -1,
        firstLineAt: -1,
        unlatchAt: -1,
        otherStatus: 0,
        statusReleased: 0,
      },
      (t, a) => {
        const sec = document.querySelector('section[aria-label="Ports"]');
        const text = Array.from(sec?.querySelectorAll('[role="status"]') ?? [])
          .map((el) => el.textContent ?? '')
          .join('|');
        const add = Array.from(sec?.querySelectorAll('button') ?? []).find((b) => b.textContent === '+ Add output');
        const enabled = add !== undefined && !add.disabled;
        const now = performance.now();
        if (enabled && t.unlatchAt < 0) t.unlatchAt = now;
        if (t.cleared === 0 && text === a.pausedCopy) {
          t.pausedFrames++;
          return false;
        }
        t.cleared = 1;
        t.afterClear++;
        if (text !== '') {
          t.flashed++;
          t.flashSeen = text;
          if (t.firstStatusAt < 0) t.firstStatusAt = now;
          if (text === a.pendingCopy && t.firstLineAt < 0) t.firstLineAt = now;
          if (text !== a.pendingCopy) t.otherStatus++;
          if (enabled) t.statusReleased++;
        }
        return true;
      },
      { pausedCopy: PAUSED_COPY, pendingCopy: PENDING_COPY },
    );
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    const rw = await waitForFramesAtFloor<Omit<ResumeSample, 'frames'>>(page, '__resumeSample');
    await pollScene(page, (s) => outCount(theFactory(s)), { message: 'the resumed host folded the held add' }).toBe(2);
    const r: ResumeSample = { frames: rw.tallies.pausedFrames + rw.frames, ...rw.tallies };
    const watch = await page.evaluate(() => {
      const w = window as unknown as { __resumeWatch?: Record<string, number> };
      const rec = w.__resumeWatch;
      if (rec === undefined) return null;
      window.clearInterval(rec.interval);
      return { ...rec };
    });
    expect(watch, 'the Resume watcher was installed').not.toBeNull();
    const wt = watch as unknown as ResumeWatch;
    const fromClick = (at: number): number => (at < 0 || wt.clickAt < 0 ? -1 : Math.round(at - wt.clickAt));
    const timing = {
      clickToFoldMs: fromClick(wt.foldAt),
      ticksToFold: wt.foldTick < 0 || wt.clickTick < 0 ? -1 : wt.foldTick - wt.clickTick,
      clickToLineDomMs: fromClick(wt.lineDomAt),
      clickToReleaseDomMs: fromClick(wt.releaseDomAt),
      statusFromClickMs: fromClick(r.firstStatusAt),
      clickToLinePaintMs: fromClick(r.firstLineAt),
      applyMs: fromClick(r.unlatchAt),
      lineFrames: r.flashed,
      statusReleased: r.statusReleased,
      otherStatus: r.otherStatus,
      lineDomWithRelease: wt.lineDomWithRelease,
      lineDomAfterFoldMs: Math.round(wt.lineDomAfterFoldMs),
      frames: r.frames,
      afterClear: r.afterClear,
    };
    console.log(`RESUME_TIMING ${JSON.stringify(timing)}`);
    expect(r.afterClear, `the paused wording cleared and the sampler ran on (${JSON.stringify(r)})`).toBeGreaterThan(20);
    expect(
      waitingLineVerdict({
        status: timing.lineFrames,
        otherStatus: timing.otherStatus,
        statusReleased: timing.statusReleased,
        applyMs: timing.applyMs,
        statusFromClickMs: timing.statusFromClickMs,
      }),
      `no frame after Resume carried Ports status text (saw "${r.flashSeen}"), except "${PENDING_COPY}" once the host took longer than its ${GRACE_MS} ms grace to apply the held add (applied after ${timing.applyMs} ms, line from ${timing.statusFromClickMs} ms, both from the Resume click)`,
    ).toEqual({ other: 0, afterApply: 0, inTheGrace: false });
    await expect(status).toHaveCount(0);
    await expect(addButton(page)).toBeEnabled();

    await expectRenderLoopAlive(page, 'after leg 4');
    errs.assertNone('leg 4');
  });
});
