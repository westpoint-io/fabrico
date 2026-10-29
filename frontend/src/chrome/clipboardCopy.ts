// clipboardCopy.ts - the env-branched clipboard writer and the copy-result
// orchestration behind the endpoint/webhook Copy button (QA-01).
//
// The bug this module exists to kill: `void navigator.clipboard?.writeText(url)`
// followed by an unconditional "Copied". That single expression carried TWO
// false-success paths. The optional chain short-circuits to `undefined` when the
// API is absent, which is the SHIPPED WebKitGTK reality (the custom-protocol
// webview is not a secure context, so `navigator.clipboard` is simply not there),
// and the `void` discards the promise, so even an outright REJECTED write still
// confirmed. Both are gone: a write is awaited, and a missing API is an error,
// not a silent success.
//
// The binding contract (52-UI-SPEC, Copywriting Contract):
//
//   `Copy failed` is reachable ONLY from an observed rejection, a synchronous
//   throw, or a provably absent API. NEVER from elapsed time.
//
// `runCopy` therefore takes NO clock, has no timeout, and has no cap. A 3.1s
// Tauri IPC round-trip that eventually resolves is a SUCCESS, not a failure: at
// any hypothetical cap-fire moment the outcome is UNOBSERVED, and unobserved is
// not failed. A write that never settles is a hung IPC, a distinct pathology a
// three-second word swap would only fake a diagnosis for. The only timer in this
// feature is the result-hold in `WebhookUrlRow`, and it never produces a verdict.

import { detectEnv, type TransportEnv } from '../transport/transport.ts';

/** Every reachable state of the Copy button, each with a name (52-UI-SPEC §1). */
export type CopyState = 'idle' | 'copying' | 'copied' | 'failed';

/** How long `copied` / `failed` hold before the button returns to `idle`.
 *  The result-hold, and the ONLY timer in the copy feature. It never decides an
 *  outcome; it only returns an already-observed outcome to rest. */
export const COPY_RESULT_HOLD_MS = 1500;

/**
 * Thrown when there is provably no clipboard write function to call at all.
 * This is the case the shipped optional chain swallowed into a fake success, so
 * it is deliberately a REJECTION: an absent API is an observed inability to
 * write, and the user must be told the URL is not on their clipboard.
 */
export class ClipboardUnavailableError extends Error {
  constructor() {
    super('No clipboard write function is available in this runtime');
    this.name = 'ClipboardUnavailableError';
  }
}

/**
 * Write `text` to the clipboard, branching on the runtime.
 *
 * Under Tauri the write goes through the OS-native Rust plugin, dynamically
 * imported ONLY on that branch (the `defaultPickSavePath` discipline in
 * `controlHandlers.ts`) so the dev-browser bundle never evaluates a Tauri symbol.
 * In a real browser (dev on localhost, a secure context) the web API is used.
 *
 * Rejections are propagated, never swallowed: propagation is precisely what
 * makes failure observable to the caller.
 */
export async function clipboardCopy(text: string, env: TransportEnv = detectEnv()): Promise<void> {
  if (env.hasTauri) {
    const { writeText } = await import('@tauri-apps/plugin-clipboard-manager');
    await writeText(text);
    return;
  }
  // Guard the global itself so this module stays importable in the node test env,
  // where `navigator` may not exist at all.
  const board = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
  if (board == null || typeof board.writeText !== 'function') throw new ClipboardUnavailableError();
  await board.writeText(text);
}

/**
 * Run one copy and report what was OBSERVED.
 *
 * The whole correctness contract of QA-01 lives here, in one node-testable
 * function: there is no branch that returns `'copied'` without having awaited a
 * resolved promise, and there is no elapsed-time input of any kind. The `copy`
 * call sits INSIDE the `try` so a writer that throws synchronously (rather than
 * returning a rejected promise) also lands on `'failed'`.
 *
 * THE REASON IS LOGGED, NEVER SWALLOWED. A bare `catch {}` here would make this
 * the second silent clipboard path in the same feature. QA-01 exists precisely
 * because a clipboard failure was invisible in the shipped WebKitGTK binary, and
 * a capability rejection, a `NotAllowedError` from an unfocused document and a
 * missing plugin all produce the identical two words on screen. The user-facing
 * verdict is unchanged by the log; only the cause stops being unrecoverable.
 *
 * The log is NOT an input to the verdict and NOT a clock: `'failed'` is still
 * returned from, and only from, an observed rejection or throw (A1 intact).
 */
export async function runCopy(
  text: string,
  copy: (t: string) => Promise<void>,
): Promise<'copied' | 'failed'> {
  try {
    await copy(text);
    return 'copied';
  } catch (err) {
    console.error('[fabrico] clipboard write failed', err);
    return 'failed';
  }
}

type RealTimerId = ReturnType<typeof setTimeout>;

/**
 * `TId` is the opaque timer-handle type: `ReturnType<typeof setTimeout>` in the
 * app, a plain `number` under a fake clock in tests - the `statusMachine.ts`
 * seam, verbatim.
 */
export interface CopyMachineDeps<TId = RealTimerId> {
  /** The clipboard writer. Injected so both branches are node-testable. */
  copy: (text: string) => Promise<void>;
  /** Commit a state to the observable button (the React setter). */
  setState: (state: CopyState) => void;
  /** Injectable timer seam (default: real timers). Tests pass fakes. */
  setTimer?: (fn: () => void, ms: number) => TId;
  clearTimer?: (id: TId) => void;
}

export interface CopyMachine {
  /**
   * Handle one click.
   *
   * @returns `false` when the click was REFUSED because a write is already in
   *          flight. Returning the verdict (rather than swallowing it) is what
   *          lets the node test prove the write is called exactly once.
   */
  click: (text: string) => boolean;
  /** Row unmounted: cancel the hold timer and make any in-flight write inert. */
  dispose: () => void;
}

/**
 * The copy button's guards, as a PURE machine so every one of them is provable
 * in the node test env (the `statusMachine.ts` / `portEditLatch.ts` house
 * pattern). It lives here rather than inside the `WebhookUrlRow` hook because
 * this repo's vitest environment is `node`: a guard that can only be exercised
 * through a rendered React tree cannot be tested at all here, and the ONE thing
 * QA-01 must never rely on is a browser suite (Chromium on `localhost` exposes
 * the clipboard API the shipped WebKitGTK binary lacks).
 *
 * ---------------------------------------------------------------------------
 * THE RE-ENTRANCY GUARD IS AN EARLY RETURN, NEVER THE `disabled` ATTRIBUTE
 *
 * Disabling a FOCUSED `<button>` moves focus to `<body>` in both Chromium and
 * WebKit. A keyboard user who pressed Enter on `Copy` would lose their place in
 * the panel AND never hear the polite announcement of the result - the exact
 * user for whom that announcement is the only feedback there is. So the view
 * sets `aria-disabled="true"` (the button keeps its tabstop and its live region)
 * and this machine refuses the click.
 *
 * ---------------------------------------------------------------------------
 * THE CLICK EPOCH, AND WHAT IT IS NOT
 *
 * A monotonic counter captured at click time and compared before every state
 * update. With the cap withdrawn (A1) its job is exactly two cases and no
 * others: (a) UNMOUNT - the row is gone before the promise settles; (b)
 * RE-CLICK - a newer click must not have its state overwritten or its timer
 * restarted by an older write. It is NOT a mechanism for discarding a late
 * settlement in favour of a guess, because with no cap there is no guess left to
 * protect: a late settlement is still the truth and is still committed.
 *
 * Case (b) is currently unreachable BY CONSTRUCTION - the early return means at
 * most one write is ever in flight - and it is implemented anyway, because it is
 * the only thing standing between a future loosening of the early return and a
 * stale write flipping a fresh button. What case (b) DOES reach today is the
 * timer half: a re-click during the hold window clears the standing timer, so
 * the superseded result can never fire `idle` over the newer `copying`.
 *
 * ---------------------------------------------------------------------------
 * THE DECIDED HUNG-IPC END STATE (52-UI-SPEC A10)
 *
 * Removing the cap correctly (A1) leaves one end state the spec did not
 * describe: a write that NEVER settles. The decision:
 *
 *   A never-settling write leaves the button in state 3 for the lifetime of the
 *   MOUNTED ROW - label held at `Copy`, `aria-busy="true"`,
 *   `aria-disabled="true"`, further clicks refused. This is deliberate, and it
 *   is bounded rather than permanent: `WebhookUrlRow` unmounts when the machine
 *   is deselected or the config panel closes (`ConfigPanel.tsx:4-6` renders per
 *   selection and App's `key={selectedNode}` forces a fresh subtree), so
 *   clicking away and back yields a fresh idle button - two clicks, or one when
 *   selecting another machine.
 *
 *   THE ESCAPE IS ESCAPE, NOT DIAGNOSIS. While hung, the button is VISUALLY
 *   IDENTICAL to idle: the same word `Copy`, the same `fab-tool-btn` class, the
 *   same reserved width, no spinner and no tint, because the only two
 *   differences are `aria-busy` and `aria-disabled`, which a sighted mouse user
 *   never perceives. A user in this state CAN get out, but CANNOT tell from the
 *   UI that anything went wrong, and will most likely read the hung button as
 *   one they have not clicked yet. The mechanism is real; the awareness is not.
 *
 * The three alternatives are all worse and are refused on the record:
 *
 *   1. A TIMEOUT TO `failed` is forbidden by A1. It asserts an unobserved
 *      outcome as a failure, and a slow-but-successful write would read
 *      `Copy failed` with the URL already on the clipboard - the user retries
 *      and pastes twice.
 *   2. A FOURTH WORD for the in-flight window is forbidden by the Copywriting
 *      Contract. The triad is the button's entire vocabulary, and inventing a
 *      word for a sub-millisecond common case buys a flicker.
 *   3. RELEASING THE GUARD ON A TIMER and permitting a second write would put
 *      two writes in flight with no way to attribute either result,
 *      reintroducing exactly the spammability the guard exists to stop.
 *
 * What keeps this honest rather than a lie is that `aria-busy="true"` is TRUE
 * for as long as it is set: a write genuinely has not settled. The visual
 * identity with idle is the deliberate cost of avoiding a flicker on the common
 * path, accepted with its diagnostic cost named rather than hidden.
 */
export function makeCopyMachine<TId = RealTimerId>(deps: CopyMachineDeps<TId>): CopyMachine {
  const setTimer =
    deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms) as unknown as TId);
  const clearTimer = deps.clearTimer ?? ((id: TId) => clearTimeout(id as unknown as RealTimerId));

  let state: CopyState = 'idle';
  let epoch = 0;
  let holdTimer: TId | undefined;
  let disposed = false;

  function clearHold(): void {
    if (holdTimer !== undefined) {
      clearTimer(holdTimer);
      holdTimer = undefined;
    }
  }

  function commit(next: CopyState): void {
    state = next;
    deps.setState(next);
  }

  return {
    click(text: string): boolean {
      // A disposed machine is INERT, and says so, rather than being wedged by
      // whatever state it happened to be left in (see `dispose`).
      if (disposed) return false;
      // The re-entrancy guard. An early return, never `disabled` - see above.
      if (state === 'copying') return false;
      epoch += 1;
      const mine = epoch;
      // A click supersedes any standing hold: the older result must not fire
      // `idle` over the window this click just opened.
      clearHold();
      commit('copying');
      // The ONLY route to 'copied' is the resolved branch inside runCopy. There
      // is no cap, no `Promise.race` and no elapsed-time input: state 3 ends
      // when, and only when, the write settles. The timer below is armed AFTER
      // an observed result and merely returns that result to rest.
      void runCopy(text, deps.copy)
        .then((result) => {
          if (mine !== epoch) return;
          commit(result);
          clearHold();
          holdTimer = setTimer(() => {
            holdTimer = undefined;
            // The ONE state commit that used to trust an injected seam. The
            // module's claim that "a re-click during the hold window clears the
            // standing timer, so the superseded result can never fire `idle`
            // over the newer `copying`" rested ENTIRELY on `clearTimer` doing
            // its job - and `clearTimer` is a substitutable dependency with no
            // contract check. A no-op or id-mismatched one (a fake-clock bug, a
            // future AbortController seam) would fire this callback over a live
            // write and show an idle button while a write was still in flight.
            // One comparison makes the guarantee independent of the seam, and
            // matches every other commit in this file.
            if (mine !== epoch) return;
            commit('idle');
          }, COPY_RESULT_HOLD_MS);
        })
        .catch((err: unknown) => {
          // A COMMIT/SCHEDULING fault, never a copy verdict. `runCopy` itself
          // cannot reject - it returns a verdict for every outcome - so the only
          // way here is `deps.setState` or `setTimer` throwing (a React error
          // boundary tearing down mid-commit, a stale setter). That throw lands
          // AFTER `commit(result)` and BEFORE the hold is armed, which without
          // this handler leaves an unhandled rejection plus a button stuck on
          // `Copied` or `Copy failed` with no timer to return it to rest. In the
          // shipped WebKit webview an unhandled rejection is a silent console
          // entry, so the diagnostic is the whole point.
          //
          // It deliberately does NOT touch state: re-entering the setter that
          // just threw would be the same fault twice, and inventing a verdict
          // here would be a verdict from something other than an observed write.
          console.error('[fabrico] copy machine commit failed', err);
        });
      return true;
    },
    dispose(): void {
      // Bumping the epoch is what makes an in-flight settlement inert: it can
      // neither call setState on a gone row nor arm a timer behind it.
      disposed = true;
      epoch += 1;
      clearHold();
      // WEDGED vs INERT. Disposing while a write was in flight used to leave
      // `state === 'copying'` forever, so every later click hit the re-entrancy
      // early return and the button was permanently dead. Nothing in THIS file
      // prevented that; the only thing that did was one line in a different one
      // (`machineRef.current = null` in WebhookUrlRow). `makeCopyMachine` is an
      // exported factory with a documented public interface and no stated
      // "do not reuse after dispose" rule, so the next caller had no signal.
      // The refusal is now explicit and the state is honest: rest, not mid-write.
      state = 'idle';
    },
  };
}
