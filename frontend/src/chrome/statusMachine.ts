// statusMachine.ts - the SHELL-07 honest Save/Load status latch (WR-02/WR-03).
//
// A chrome-only state machine that observes the EXISTING render stream: no host
// echo, no packet/command change. It owns the load-in-flight latch and its two
// timers (the load timeout and the terminal-state auto-clear), which used to
// live as loose refs inside App. Extracting them here makes the honesty-critical
// reconciliation (a superseding status/keyframe must never produce a dishonest
// readout) directly unit-testable with injected timers.
//
// The rules it enforces (phase 90, D-06, research Findings D and E, and the slow-Load fix):
//   - `loading`          -> latch the load, record the swap floor the scene stood at
//                            (`readSwapFloor`), and arm the cut-off.
//   - `resolveKeyframe(p)`-> every packet goes through here. `loaded` is resolved ONLY by
//                            the Load's own swap keyframe (`isLoadSwap`, dirtyState.ts): a
//                            full packet whose swap floor equals its generation and is above
//                            the floor at dispatch. An Undo or Redo keyframe never stands in
//                            for it, so Undo and Redo do not cancel a pending Load.
//   - THE CUT-OFF        -> `Load failed` is written for a Load the host has not refused
//                            only when the host has stopped answering it: no packet at all
//                            for `loadTimeoutMs` (every packet restarts that window, and a
//                            draining host sends one every tick), or more than
//                            `loadTickBudget` ticks seen since dispatch with no swap (the
//                            host forces its swap within MAX_SETTLE_TICKS drain ticks). A
//                            long drain is therefore never called a failure. If the swap
//                            still comes after a cut-off, it resolves `loaded`.
//   - ANY other status   -> leaves a pending Load exactly as pending (phase 90 review pass 2,
//                            CR-B-01 and WR-B-01): the held-undo and queued-edits notices, a
//                            Save, a failed Save, a second Open whose dialog failed, and a
//                            cancelled dialog's `idle` (shown as `loading` while the Load is
//                            pending). When a transient's auto-clear runs with the Load still
//                            pending, the strip returns to `loading`, not idle. The old WR-02
//                            rule (every other status supersedes) is gone: the cut-off above
//                            fires only when the host has stopped answering, so a `Load failed`
//                            it writes over a newer status is true.
//   - `refuseLoad()`     -> the host refused this page's Load: drop the latch and the cut-off
//                            and write `loadFailed`.
//   - `supersedeLoad()`  -> New or an example during a Load: drop the latch + cut-off, and
//                            if `Loading…` is what this machine last showed, clear it.
//   - terminal states auto-clear back to `idle` after `autoClearMs` (or re-assert
//                            `disconnected` while the stream is down, WR-03).
//   - `stop()`           -> the host's sim loop ended (phase 90, FAIL-01, D-12): drop the
//                            latch and both timers, commit `simStopped`, and from then on
//                            `apply`, `supersedeLoad` and `resolveKeyframe` do nothing. The
//                            stopped status is STICKY and HIGHEST: nothing clears it.

import type { StatusKind } from './controlHandlers';
import { isLoadSwap, type SwapFields } from './dirtyState';

type RealTimerId = ReturnType<typeof setTimeout>;

/**
 * The tick budget App gives a pending Load (`loadTickBudget`): twice the host's
 * `MAX_SETTLE_TICKS` (512, crates/fabrico-host/src/sim_loop.rs), the drain after which the
 * host freezes and swaps whatever the board holds. The other 512 cover the frames the
 * transport still had queued from before the dispatch (the broadcast holds 256). A Load
 * still unanswered past it was lost by the host. statusMachine.test.ts reads the host
 * constant, so the two cannot drift apart.
 */
export const LOAD_TICK_BUDGET = 1024;

/**
 * The packet fields `resolveKeyframe` reads: the three swap fields, plus the sim tick the
 * cut-off counts (absent in the pure swap tests, which then count no ticks).
 */
export interface KeyframeFields extends SwapFields {
  tick?: number;
}

/**
 * `TId` is the opaque timer-handle type: `ReturnType<typeof setTimeout>` in the
 * app, but a plain `number` under a fake clock in tests - so the seam stays
 * portable across host timer implementations.
 */
export interface StatusMachineDeps<TId = RealTimerId> {
  /** Commit a status kind to the observable readout (App stamps + setState). */
  setStatus: (kind: StatusKind) => void;
  /**
   * The silence window: a pending Load fails when NO packet arrives for this long. Every
   * packet restarts it, so it measures a host that has stopped, never a long drain (a
   * draining host sends a packet every tick).
   */
  loadTimeoutMs: number;
  /**
   * The tick budget: a pending Load fails when the packets seen since dispatch span more
   * than this many sim ticks with no swap. The host forces its swap within
   * `MAX_SETTLE_TICKS` drain ticks (sim_loop.rs), so a budget above that plus the
   * transport's backlog never fires on a legitimate drain. Absent: no tick budget.
   */
  loadTickBudget?: number;
  /** Auto-clear budget: a terminal state returns to idle after this. */
  autoClearMs: number;
  /**
   * The scene's swap floor (`sceneState.swapFloor`), read when a Load is dispatched, so
   * only a swap ABOVE it resolves that Load (D-06). Absent (default `() => 0`) for the
   * pure smoke tests.
   */
  readSwapFloor?: () => number;
  /**
   * WR-03: is the render stream currently DOWN (the SAFE-01 watchdog's sticky
   * 'disconnected' latch)? A transient status (e.g. 'Save requested') displaces
   * the sticky 'disconnected' readout; when that transient auto-clears, it must
   * NOT quiesce to 'idle' while the stream is still dead (no reconnecting packet
   * will ever come to re-fire the once-per-stall watchdog). Instead it RE-ASSERTS
   * 'disconnected' so a frozen board never passes as a normal idle board. Absent
   * (default `() => false`) for the pure smoke tests that ignore the stream state.
   */
  isStreamDown?: () => boolean;
  /** Injectable timer seam (default: real timers). Tests pass fakes. */
  setTimer?: (fn: () => void, ms: number) => TId;
  clearTimer?: (id: TId) => void;
}

export interface StatusMachine {
  /** Apply a status kind, reconciling the load latch + timers. */
  apply: (kind: StatusKind) => void;
  /** New or an example during a Load: drop the latch, clear a `Loading…` it left. */
  supersedeLoad: () => void;
  /** A packet arrived: resolve `loaded` iff it is the pending Load's own swap keyframe. */
  resolveKeyframe: (p: KeyframeFields) => void;
  /** True between a load dispatch and its resolving/superseding event. */
  isLoadInFlight: () => boolean;
  /**
   * True while a swap would still be this page's Load (phase 90 review WR-B-07): from the
   * dispatch until the host answers it (its swap or its refusal), New or an example supersedes
   * it, or the stop. Unlike `isLoadInFlight` it stays true past the cut-off, because a swap that
   * still comes then resolves `Loaded`. App holds its pending save target exactly this long.
   */
  isAwaitingSwap: () => boolean;
  /** The host refused this page's Load: end it and write `loadFailed` (WR-B-07). */
  refuseLoad: () => void;
  /**
   * The host's sim loop ended (phase 90, FAIL-01): drop the load latch and both timers,
   * commit `simStopped`, and make every later call a no-op. Once stopped, always stopped.
   */
  stop: () => void;
  /** True once `stop()` has run. */
  isStopped: () => boolean;
  /** Cancel both timers (mount cleanup - no leak across StrictMode double-boot). */
  dispose: () => void;
}

export function makeStatusMachine<TId = RealTimerId>(deps: StatusMachineDeps<TId>): StatusMachine {
  const setTimer =
    deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms) as unknown as TId);
  const clearTimer =
    deps.clearTimer ?? ((id: TId) => clearTimeout(id as unknown as RealTimerId));
  // WR-03: default to "stream up" so the pure smoke tests are unaffected.
  const isStreamDown = deps.isStreamDown ?? (() => false);
  const readSwapFloor = deps.readSwapFloor ?? (() => 0);
  const tickBudget = deps.loadTickBudget ?? Number.POSITIVE_INFINITY;

  let loadInFlight = false;
  // The swap floor the scene stood at when the pending Load was dispatched (D-06).
  let floorAtDispatch = 0;
  // The tick of the first packet seen after dispatch: the tick budget counts from it.
  let tickAtFirstPacket: number | null = null;
  // A Load the cut-off failed is still resolved `loaded` by its own swap, should the host
  // answer after all, so the strip never keeps `Load failed` over a board the Load produced.
  let lateSwapOpen = false;
  // The kind this machine last committed (the watchdog writes `disconnected` outside it).
  let shown: StatusKind | null = null;
  let statusClearTimer: TId | undefined;
  let loadTimeoutTimer: TId | undefined;
  // FAIL-01 (D-12): set once by `stop()`, never cleared.
  let stopped = false;

  function commit(kind: StatusKind): void {
    shown = kind;
    deps.setStatus(kind);
  }

  function clearLoadTimer(): void {
    if (loadTimeoutTimer !== undefined) {
      clearTimer(loadTimeoutTimer);
      loadTimeoutTimer = undefined;
    }
  }

  function clearAutoClear(): void {
    if (statusClearTimer !== undefined) {
      clearTimer(statusClearTimer);
      statusClearTimer = undefined;
    }
  }

  /** The cut-off fired: the host has stopped answering this Load. */
  function failPendingLoad(): void {
    clearLoadTimer();
    if (!loadInFlight) return;
    loadInFlight = false;
    apply('loadFailed');
    lateSwapOpen = true;
  }

  /** (Re-)arm the silence window: a single fresh timer, restarted by every packet. */
  function armSilenceWindow(): void {
    clearLoadTimer();
    loadTimeoutTimer = setTimer(() => {
      loadTimeoutTimer = undefined;
      failPendingLoad();
    }, deps.loadTimeoutMs);
  }

  function apply(kind: StatusKind): void {
    // FAIL-01 (D-12): nothing replaces the stopped status, a cut-off's `loadFailed` included.
    if (stopped) return;
    // A new status supersedes any pending auto-clear.
    clearAutoClear();

    if (kind === 'loading') {
      loadInFlight = true;
      lateSwapOpen = false;
      floorAtDispatch = readSwapFloor();
      tickAtFirstPacket = null;
      // A fresh 'loading' owns the ONLY armed cut-off: a prior in-flight load's goes (WR-02).
      armSilenceWindow();
    }
    // Every other status leaves a pending Load as it was (review pass 2, CR-B-01, WR-B-01): it
    // says something about the paused board, a Save or a dialog, never about the Load. Only the
    // host (`resolveKeyframe`, `refuseLoad`, the cut-off), New or an example (`supersedeLoad`) and
    // `stop` end it. A cancelled dialog's `idle` would blank the strip under a running Load, so
    // the Load's own word stays.
    commit(kind === 'idle' && loadInFlight ? 'loading' : kind);

    // Auto-clear the transient TERMINAL states back to idle (never the in-progress
    // 'loading', which resolves on its swap keyframe).
    //
    // 'editsQueued' joins this TRANSIENT tier rather than the sticky
    // 'disconnected' one: it fades after `autoClearMs` (STATUS_AUTOCLEAR_MS, 4s),
    // and because the `clearAutoClear()` at the top of apply() runs first, EACH
    // further queued edit re-applies the kind and therefore re-arms a fresh 4s
    // window - a user editing steadily on a paused board keeps seeing it rather
    // than watching it expire mid-session.
    //
    // It leaves a pending Load latched (review pass 2, CR-B-01): an edit made during a Load
    // leaves the Load exactly as pending as before, and when the notice fades the strip
    // returns to `Loading…`.
    if (
      kind === 'saveRequested' ||
      kind === 'loaded' ||
      kind === 'saveFailed' ||
      kind === 'loadFailed' ||
      kind === 'editsQueued' ||
      // Plan 74.1-31: the held-undo notice is the same client-originated transient as
      // `editsQueued`, and each further held press re-arms its 4 s window.
      kind === 'undoHeld'
    ) {
      statusClearTimer = setTimer(() => {
        statusClearTimer = undefined;
        // WR-03: if the render stream is still DOWN, a transient status that
        // displaced the sticky 'disconnected' readout must RE-ASSERT it here
        // rather than quiescing to 'idle' - otherwise a dead stream passes as a
        // normal idle board forever (the once-per-stall watchdog never re-fires).
        // D-06 (research Finding E): the held-undo notice over a pending Load clears
        // back to that Load's `Loading…`, keeping its latch and cut-off; the swap
        // keyframe then still resolves `Loaded`.
        if (isStreamDown()) commit('disconnected');
        else commit(loadInFlight ? 'loading' : 'idle');
      }, deps.autoClearMs);
    }
  }

  function supersedeLoad(): void {
    if (stopped) return;
    loadInFlight = false;
    lateSwapOpen = false;
    clearLoadTimer();
    // The superseded Load's `Loading…` would otherwise stand until the next status: it
    // has no auto-clear, and its swap will now resolve nothing.
    if (shown === 'loading') commit(isStreamDown() ? 'disconnected' : 'idle');
  }

  function resolveKeyframe(p: KeyframeFields): void {
    if (stopped) return;
    if (!loadInFlight && !lateSwapOpen) return;
    if (isLoadSwap(p, floorAtDispatch)) {
      loadInFlight = false;
      lateSwapOpen = false;
      clearLoadTimer();
      apply('loaded');
      return;
    }
    if (!loadInFlight) return;
    // The host spoke: the silence window starts again.
    armSilenceWindow();
    if (p.tick !== undefined) {
      if (tickAtFirstPacket === null) tickAtFirstPacket = p.tick;
      else if (p.tick - tickAtFirstPacket > tickBudget) failPendingLoad();
    }
  }

  function isLoadInFlight(): boolean {
    return loadInFlight;
  }

  function isAwaitingSwap(): boolean {
    return loadInFlight || lateSwapOpen;
  }

  function refuseLoad(): void {
    if (stopped) return;
    loadInFlight = false;
    lateSwapOpen = false;
    clearLoadTimer();
    apply('loadFailed');
  }

  function stop(): void {
    if (stopped) return;
    loadInFlight = false;
    lateSwapOpen = false;
    clearAutoClear();
    clearLoadTimer();
    commit('simStopped');
    stopped = true;
  }

  function isStopped(): boolean {
    return stopped;
  }

  function dispose(): void {
    clearAutoClear();
    clearLoadTimer();
  }

  return { apply, supersedeLoad, resolveKeyframe, isLoadInFlight, isAwaitingSwap, refuseLoad, stop, isStopped, dispose };
}
