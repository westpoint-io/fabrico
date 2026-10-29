import { test, type Page } from '@playwright/test';

// support/frameSampler.ts (plan 84-08, GATE-01) - a requestAnimationFrame sampler that
// ends on the frames it has OBSERVED, not on a wall-clock window alone.
//
// WHY IT EXISTS. The 2026-10-09 CI run (a GitHub runner with 2 vCPUs)
// failed `panel-add-remove.spec.ts` G1 with `press 2: the sampler ran`, expected > 20,
// received 13 (and 11 on the retry). The sampler there ran for a fixed 2000 ms and then
// asserted it had seen more than 20 frames. This 32-thread machine draws well over 20
// frames in 2 s; the runner, rendering the board through software GL on two cores, drew
// 13. Plan 84-08 reproduced it here with the run on two cores at a 100% CPU quota: 10 and
// 16 frames. So the floor measured the machine's frame rate, not the app.
//
// THE SHAPE. A sampler started here runs until it has BOTH covered `minMs` (the window
// the property is about, so a status that would appear at 400 ms is still inside it) AND
// observed `frames` frames (the old floor, so "on every frame" is a claim over enough
// frames to mean something). On a fast machine that is the old window; on a slow one it
// runs on until the frames are in. "N frames, and on every one of them X" then means the
// same on a desktop and on a runner, with no number made smaller to let the slow one pass.
//
// THE CAP IS A FAILURE, NOT A WAIT. `waitForFrames` gives up after `capMs` and throws an
// error naming the key, the frames reached, the frames needed and the cap. A page whose
// frames never come (a dead render loop, a sampler that never ticks) is a named red,
// never a pass.
//
// THE PROBE. The per-frame read is the spec's own: a self-contained function (the same
// rule as any `page.evaluate` callback: no closures over test-side variables) that reads
// the page and updates the tallies object it is handed. It runs once per frame, BEFORE
// that frame is counted, so a frame is counted only when the probe ran on it.
//
// A WINDOW THAT OPENS ON AN EVENT (plan 84-09, the live suite). Some live samplers grade a
// window that starts when something shows, not when the sampler starts: the add note's
// window opens on the first frame the `+ Add output` press has latched, the paused-edits
// window on the first frame the paused wording shows. The probe says so by returning
// `false`: while the window is shut a `false` frame is probed (its tallies may record what
// came before) but neither counted nor timed, and the first frame that returns anything
// else opens the window and is counted. Once open, every frame is counted whatever the
// probe returns. A probe that returns nothing (the mock users) opens it on the first
// frame, which is the behaviour plan 84-08 shipped. A window that never opens is a named
// failure at the cap, never a pass.
//
// THE PROBE'S ARGUMENT. The probe is serialised, so it cannot close over a spec constant
// (a transcribed copy string); `startFrameSampler` takes an optional JSON-serialisable
// `arg` and hands it to the probe on every frame, so the copy stays one constant.
//
// THE LIVE SUITE'S CAP IS DERIVED, AT THE FLOOR (plan 84-13, D-12). The midday 2026-10-13 CI run
// (2026-10-13) drew the live suite's pages at about 5 to 5.8 frames a second (software GL
// on two shared cores): a 101-frame window read 99 frames in 19.9 s and failed on the mock
// suite's fifteen second cap, which was a number picked for a desktop. The D-12 ruling
// keeps every frame count, every per-frame property and the hand's 6 px step, and restates
// only the WALL-CLOCK cap around a frame-bound wait, derived from the frames the grade
// needs at `FLOOR_FPS` (the slowest window measured, below): `frameBudgetMs(frames, minMs)`
// is the longer of the window and the frames at the floor, plus a tenth of that, plus
// `FRAME_BUDGET_SLACK_FRAMES` at the floor. A window that opens on an event gets its cap
// from the moment it is first seen open, not from the call (review 84 WR-02), so the time
// the event took to arrive is never taken out of the window's own frames.
// Every live wait on frames takes its cap from here, never from a millisecond literal:
// `waitForFramesAtFloor` reads the window's own frames and milliseconds from the in-page
// record, and `addFrameBudget` extends the running test's limit by the frames a gesture
// costs and annotates the test `frame-budget`, so a timeout's report names the budget it
// missed. The cap is still a failure, never a wait: a page slower than the floor (or a
// sampler that never counts) is a named red at the derived cap.
//
// EVERY CAP IS ADDED TO THE TEST'S LIMIT (review 84 iteration 2 WR-03). A cap that runs past
// the test's own limit never fires: Playwright's unnamed test timeout does first, and the
// report no longer says which window was short. So `waitForFrames` adds its cap to the running
// test's limit when it is called, and the extra time when the cap re-arms at the window's
// opening; a derived `expect.poll` passes its timeout through `addWaitBudget`, which does the
// same. Each is annotated `frame-budget`. A passing run spends none of it.
//
// The mock suite keeps `FRAME_CAP_MS`: its windows are short and the mock pages are not
// rendered by CI's live software-GL path, and plan 84-08 calibrated it on a runner-sized
// machine. `FRAME_CAP_MS` stays the mock default of `waitForFrames`.

/** The cap after which `waitForFrames` fails, well under Playwright's 30 s test timeout (the mock suite's). */
export const FRAME_CAP_MS = 15_000;

/**
 * The slowest frame rate a live grade is budgeted for: the slowest WINDOW measured on a
 * renderer as slow as CI's, rounded down (review 84 WR-02). The midday 2026-10-13 CI run read
 * `__trafficMarkWindow` at 4.98 frames a second, already under the 5 that plan 84-13 first
 * chose. The GPU proxy (scripts/live-gpu-proxy.sh), calibrated on that same window to 4.83,
 * read the page right after Resume (`__afterResume`, `74.1-paused-edits`) at 3.7 to 4.4, and
 * its full-suite pass's slowest window at 3.54. So 3.5. The evening 2026-10-13 CI run drew faster (median
 * 7.19, slowest 6.39); a cap is a failure time, never a wait, so a lower floor costs a passing
 * run nothing and a broken page only fails later.
 */
export const FLOOR_FPS = 3.5;

/**
 * The share added to a window's frames-at-floor time, so a window drawn somewhat under the
 * floor still fits and a long window gets a long margin (review 84 WR-02: a constant slack
 * left the 101-frame windows with none at the proxy's 4.5 frames a second).
 */
export const FRAME_BUDGET_MARGIN = 0.1;

/**
 * Frames of fixed slack on every derived budget (plan 84-13): the most frames by which a
 * window measured at the GPU proxy ran past its frames-at-5-a-second time, rounded up:
 * `__afterResume`, 30 of its 31 frames over 8052 ms where 30 frames at 5 a second take 6000
 * ms, 10.3 frames past, so 11. Kept as the allowance for the poll and the frames before the
 * first counted one; the floor and the margin above now carry the slow page itself.
 */
export const FRAME_BUDGET_SLACK_FRAMES = 11;

/**
 * The wall-clock budget for a grade that needs `frames` frames over at least `minMs`: the
 * longer of the two at `FLOOR_FPS`, plus `FRAME_BUDGET_MARGIN` of that, plus the slack frames
 * at `FLOOR_FPS`.
 */
export function frameBudgetMs(frames: number, minMs = 0): number {
  const frameMs = 1000 / FLOOR_FPS;
  return Math.ceil(Math.max(minMs, frames * frameMs) * (1 + FRAME_BUDGET_MARGIN) + FRAME_BUDGET_SLACK_FRAMES * frameMs);
}

/**
 * The slowest board clock a live grade is budgeted for, in sim ticks a second (review 84
 * WR-03). The host runs 60 a second at full speed; on a starved machine the page sees fewer.
 * The slowest measured: `75-reroute-mark` leg 1 at a 100% CPU quota (plan 84-11, `q100`, which
 * slows the host as well as the page) read the last mark 54 ticks after the key, 1905 ms of
 * wall time, 28.3 a second. The evening 2026-10-13 CI run read the same span at 65 ticks over 1135 ms. So 28.
 */
export const FLOOR_TPS = 28;

/**
 * The wall-clock budget for `ticks` sim ticks at `FLOOR_TPS`, plus `FRAME_BUDGET_MARGIN` of
 * it. For a wait that needs records (one per sim tick) as well as page frames, add this to the
 * frames' own `frameBudgetMs`.
 */
export function tickBudgetMs(ticks: number): number {
  return Math.ceil(((ticks * 1000) / FLOOR_TPS) * (1 + FRAME_BUDGET_MARGIN));
}

/** Add `ms` to the running test's limit (none when the limit is off) and annotate why. */
function extendTestLimit(ms: number, description: string): void {
  const info = test.info();
  if (info.timeout > 0) info.setTimeout(info.timeout + ms);
  info.annotations.push({ type: 'frame-budget', description });
}

/**
 * Raise the running test's limit by the frames a frame-bound step costs at `FLOOR_FPS`, and
 * annotate the test `frame-budget` with the reason, so a test that still times out reports
 * the budget it was given. Returns the milliseconds added.
 */
export function addFrameBudget(frames: number, reason: string): number {
  const ms = frameBudgetMs(frames);
  extendTestLimit(ms, `${reason}: ${frames} frames at ${FLOOR_FPS} fps = ${ms} ms`);
  return ms;
}

/**
 * Raise the running test's limit by `ms`, a wait's cap already derived from `frameBudgetMs` /
 * `tickBudgetMs`, and return `ms` unchanged, so a derived `expect.poll` writes
 * `timeout: addWaitBudget(frameBudgetMs(n), 'what')` and its own named message fires before
 * the test's limit can (review 84 iteration 2 WR-03).
 */
export function addWaitBudget(ms: number, reason: string): number {
  extendTestLimit(ms, `${reason}: a derived ${ms} ms wait`);
  return ms;
}

/** What a finished sampler reports. */
export interface FrameSample<T> {
  /** Frames the probe ran on. */
  frames: number;
  /** Milliseconds from the first sampled frame to the last. */
  elapsedMs: number;
  /** The spec's own per-frame tallies. */
  tallies: T;
}

/** The record the sampler keeps under `window[key]`. */
interface SamplerRecord<T> extends FrameSample<T> {
  done: boolean;
  /** Whether the probe has opened the window (always, at once, for a probe that returns nothing). */
  opened: boolean;
  needFrames: number;
  minMs: number;
  /** A tally the window must also bring to `frames` before it ends (plan 84-13), or null. */
  tallyAtLeast: { key: string; frames: number } | null;
}

/**
 * A window's shape: it runs for `minMs` AND `frames` frames, whichever comes later, and,
 * when `tallyAtLeast` is given, also until the probe's tally `key` has reached `frames`
 * (plan 84-13: a count of frames graded after an event inside the window, such as the
 * frames after a refusal first showed, which the probe's return value cannot express).
 */
export interface SamplerOpts {
  minMs: number;
  frames: number;
  tallyAtLeast?: { key: string; frames: number };
}

/**
 * The in-page installer. Serialised by `startFrameSampler`, so it must stay
 * self-contained: it may use only its arguments and page globals.
 */
function installSampler<T, A>(
  key: string,
  opts: SamplerOpts,
  initial: T,
  probe: (tallies: T, arg: A) => void | boolean,
  arg: A,
): void {
  const rec: SamplerRecord<T> = {
    frames: 0,
    elapsedMs: 0,
    tallies: initial,
    done: false,
    opened: false,
    needFrames: opts.frames,
    minMs: opts.minMs,
    tallyAtLeast: opts.tallyAtLeast ?? null,
  };
  (window as unknown as Record<string, SamplerRecord<T>>)[key] = rec;
  let t0: number | null = null;
  const step = (): void => {
    const now = performance.now();
    const verdict = probe(rec.tallies, arg);
    if (!rec.opened) {
      if (verdict === false) {
        requestAnimationFrame(step);
        return;
      }
      rec.opened = true;
    }
    if (t0 === null) t0 = now;
    rec.frames++;
    rec.elapsedMs = now - t0;
    const extra = rec.tallyAtLeast;
    const extraIn =
      extra === null || Number((rec.tallies as unknown as Record<string, unknown>)[extra.key] ?? 0) >= extra.frames;
    if (rec.elapsedMs >= rec.minMs && rec.frames >= rec.needFrames && extraIn) rec.done = true;
    else requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/**
 * Start a sampler under `window[key]`. It runs `probe` once per animation frame until
 * it has covered `opts.minMs` AND observed `opts.frames` frames, then stops itself. The
 * window opens on the first frame the probe does not return `false` for; `arg` (plain
 * JSON) is handed to the probe on every frame.
 */
export async function startFrameSampler<T extends Record<string, number | string>, A = null>(
  page: Page,
  key: string,
  opts: SamplerOpts,
  initial: T,
  probe: (tallies: T, arg: A) => void | boolean,
  arg: A | null = null,
): Promise<void> {
  await page.evaluate(
    `(${installSampler.toString()})(${JSON.stringify(key)}, ${JSON.stringify(opts)}, ${JSON.stringify(initial)}, ${probe.toString()}, ${JSON.stringify(arg)})`,
  );
}

/** Read the sampler's record as it stands. */
async function readRecord<T>(page: Page, key: string): Promise<SamplerRecord<T> | null> {
  return page.evaluate(
    (k) => (window as unknown as Record<string, SamplerRecord<T> | undefined>)[k] ?? null,
    key,
  );
}

/**
 * Wait until the sampler under `key` has observed the frames it needs over its window,
 * and return what it saw. Fails, naming the key, the frames reached, the frames needed
 * and the cap, when `capMs` passes first. The cap runs from the call until the window is
 * first seen open, and from that moment once it is (review 84 WR-02): a window that opens
 * on an event is never charged for the wait before the event, and a window that never
 * opens still fails `capMs` after the call.
 */
export async function waitForFrames<T>(
  page: Page,
  key: string,
  capMs: number = FRAME_CAP_MS,
): Promise<FrameSample<T>> {
  const startedAt = Date.now();
  let deadline = startedAt + capMs;
  let openSeenAt: number | null = null;
  // The cap is added to the test's limit, so the named error below fires before the test's
  // own timeout can (review 84 iteration 2 WR-03).
  extendTestLimit(capMs, `waitForFrames ${key}: a ${capMs} ms cap`);
  for (;;) {
    const rec = await readRecord<T>(page, key);
    if (rec === null) throw new Error(`frameSampler ${key}: no sampler was started under window.${key}`);
    if (rec.opened && openSeenAt === null) {
      openSeenAt = Date.now();
      const rearmed = openSeenAt + capMs;
      if (rearmed > deadline) {
        // The re-armed cap runs past the first one by this much: the test's limit grows by it too.
        extendTestLimit(rearmed - deadline, `waitForFrames ${key}: the cap re-armed at the window's opening, ${rearmed - deadline} ms later`);
        deadline = rearmed;
      }
    }
    if (rec.done) {
      const elapsedMs = Math.round(rec.elapsedMs);
      const fps = elapsedMs > 0 ? ((rec.frames * 1000) / elapsedMs).toFixed(2) : 'inf';
      // Every finished window states the page's frame rate, so CI's own log carries it.
      console.log(
        `FRAME_SAMPLE ${key} frames=${rec.frames} elapsedMs=${elapsedMs} fps=${fps} ` +
          `waitedMs=${Date.now() - startedAt} openedAfterMs=${(openSeenAt ?? Date.now()) - startedAt} capMs=${capMs}`,
      );
      return { frames: rec.frames, elapsedMs, tallies: rec.tallies };
    }
    if (Date.now() >= deadline) {
      if (!rec.opened) {
        throw new Error(
          `frameSampler ${key}: the probe never opened the ${rec.minMs} ms window; the ${capMs} ms cap passed first`,
        );
      }
      const extra = rec.tallyAtLeast;
      const extraNote =
        extra === null
          ? ''
          : ` and ${Number((rec.tallies as unknown as Record<string, unknown>)[extra.key] ?? 0)} of the ${extra.frames} ${extra.key} frames needed`;
      throw new Error(
        `frameSampler ${key}: observed ${rec.frames} of the ${rec.needFrames} frames needed${extraNote} ` +
          `over ${Math.round(rec.elapsedMs)} ms of a ${rec.minMs} ms window; the ${capMs} ms cap from its opening passed first`,
      );
    }
    // A Node-side poll, so it works whether the page's clock is real or a Playwright
    // fake clock the spec has paused; it only re-reads the record, it decides nothing.
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * `waitForFrames` with its cap derived at `FLOOR_FPS` (D-12) from the window's OWN
 * `needFrames` and `minMs`, read from the in-page record, so no caller restates a window's
 * numbers. A miss is the same named cap error, carrying the derived cap.
 */
export function waitForFramesAtFloor<T>(page: Page, key: string): Promise<FrameSample<T>>;
export async function waitForFramesAtFloor(page: Page, key: string): Promise<FrameSample<unknown>> {
  const rec = await readRecord<unknown>(page, key);
  if (rec === null) throw new Error(`frameSampler ${key}: no sampler was started under window.${key}`);
  // A window that must also bring a tally to a count can need both counts in turn (the
  // event may come only after the window's own frames), so its frames are their sum.
  const frames = rec.needFrames + (rec.tallyAtLeast?.frames ?? 0);
  return waitForFrames<unknown>(page, key, frameBudgetMs(frames, rec.minMs));
}
