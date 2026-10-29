// portEditGrace.ts (plan 74.1-19, re-walk J10) - WHEN the pending port-edit status may
// show. A pure controller: no React, no DOM, a timer seam passed in.
//
// THE DEFECT. On the 74.1 re-walk, pressing `+ Add output` and saw a line "appear and
// disappear very fast". Measured per animation frame against the dev host, it was the
// CR-01 pending status, "Waiting for the host to apply this change.", set on every send
// and cleared by the ~10 Hz chrome poll once the fold landed: 59 to 173 ms on screen,
// every add. A sentence that is gone before it can be read says nothing except that
// something flickered.
//
// THE RULE. The button is still disabled from the press (the latch is untouched; that is
// the safety property). Only the SENTENCE waits: it shows once an edit has stayed
// unfolded for `PORT_EDIT_PENDING_GRACE_MS` of wall time. A fold inside the grace paints
// no status text at all.
//
// WHY 400 MS. Above the slowest fold measured (173 ms) with room for a loaded machine,
// and short enough that a real stall still speaks long before the stalled readout
// (`PORT_EDIT_STALL_TICKS` of SIMULATED time, several seconds) offers [Try again].
//
// WHY A PAUSED SIM SPEAKS AT ONCE. A paused or draining sim HOLDS the edit until Resume
// (`SimLoop::step`), so the paused wording ("The sim is paused - this change applies
// when you resume.") is news the user needs immediately, and it stays up until Resume,
// so it is never a flash. `arm(true)` and `setPaused(true)` show it without waiting.
//
// WHY RESUME HIDES THE LINE AND STARTS THE GRACE AGAIN (plan 74.1-28, round-3 review
// WR-05). The paused wording is shown at once, so `shown` is already true when the user
// presses Resume, and the line used to stay shown: the panel swapped to "Waiting for the
// host to apply this change." for the 60 to 170 ms until the held edit folded. That is
// the J10 flash the maintainer rejected, reached by the resume path. A resumed sim is a sim that
// just started on the edit, exactly the moment `arm(false)` describes, so `setPaused
// (false)` while armed and shown does what `arm(false)` does: hide, and wait out the
// grace. A fold inside it paints no status at all; a real stall still speaks at 400 ms.
// Every other Resume (nothing armed, or armed and still inside its grace) is untouched.
//
// WHY THE GRACE ASKS THE SCENE WHEN IT RUNS OUT (plan 84-17). The grace runs on wall time,
// but the latch it waits on is released only by the chrome poll, which runs on animation
// frames. On a slow renderer (the live suite's GPU proxy, about 4 frames a second, the model
// of CI's) the host applied a held add 24 to 63 ms after Resume, the page's scene showed it,
// and the next poll still came 448 to 641 ms after the click: the timer found the edit
// latched at 400 ms and showed "Waiting for the host to apply this change." for an add the
// host had already applied. So `createPortEditGrace` takes `stillUnfolded`, read when the
// grace runs out: the line shows only if the scene still shows an edit unapplied. The grace
// stays 400 ms, the wording and WR-05 are unchanged, and a real stall still speaks at 400 ms;
// the latch itself is still released by the poll alone, so the controls never come back
// before the panel's port list does.
//
// The stalled readout and its [Try again] are not this controller's business: they are
// decided by the latch on sim ticks and rendered whatever this says.

import { isPortEditPending, observePorts, portsKeyOf, type PortAddress, type PortEditLatch } from './portEditLatch';

/** The wall-time grace before the pending status line shows. */
export const PORT_EDIT_PENDING_GRACE_MS = 400;

/** The timer seam (the browser's in the app, fake timers in tests). */
export interface GraceTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface PortEditGrace {
  /** An edit was just sent: hidden for the grace, or visible at once when `paused`. */
  arm(paused: boolean): void;
  /** The sim's run state changed: pausing while armed shows the status at once;
   *  resuming while it shows hides it and restarts the grace (WR-05). */
  setPaused(paused: boolean): void;
  /** The edit ended (folded, reset, or its machine left the scene): hide and cancel. */
  release(): void;
  /** Whether the pending status may show now. */
  visible(): boolean;
}

/**
 * Whether any latched port edit is still unapplied in the scene as it stands now (plan 84-17):
 * each latch read against its machine's current ports exactly as the poll's release reads it
 * (`observePorts`), without releasing anything. A machine gone from the scene, or a restructure
 * keyframe since the send, ends its edit, as the poll's prune and release would.
 */
export function anyPortEditUnfolded(
  latches: ReadonlyMap<number, PortEditLatch>,
  portsOf: (node: number) => readonly PortAddress[] | undefined,
  keyframeSince: ReadonlySet<number>,
): boolean {
  for (const [node, latch] of latches) {
    const ports = portsOf(node);
    if (ports === undefined) continue;
    if (isPortEditPending(observePorts(latch, portsKeyOf(ports), keyframeSince.has(node)))) return true;
  }
  return false;
}

/**
 * A grace controller. `onChange` is called with the new visibility whenever it changes,
 * and only then, so a caller can mirror it into React state without churn. `stillUnfolded`
 * is asked when a grace runs out (plan 84-17): the line shows only if it says an edit is
 * still unapplied.
 */
export function createPortEditGrace(
  timers: GraceTimers,
  onChange: (visible: boolean) => void,
  stillUnfolded: () => boolean = () => true,
): PortEditGrace {
  let armed = false;
  let shown = false;
  let timer: unknown = null;

  const cancel = (): void => {
    if (timer !== null) {
      timers.clearTimeout(timer);
      timer = null;
    }
  };
  const show = (v: boolean): void => {
    if (shown !== v) {
      shown = v;
      onChange(v);
    }
  };

  /** Hide the line and start the grace: an edit the host is now working on. */
  const startGrace = (): void => {
    show(false);
    timer = timers.setTimeout(() => {
      timer = null;
      if (armed && stillUnfolded()) show(true);
    }, PORT_EDIT_PENDING_GRACE_MS);
  };

  return {
    arm(paused) {
      cancel();
      armed = true;
      if (paused) {
        show(true);
        return;
      }
      startGrace();
    },
    setPaused(paused) {
      if (paused && armed && !shown) {
        cancel();
        show(true);
      } else if (!paused && armed && shown) {
        // WR-05: Resume starts the host on the held edit; say nothing for the grace.
        cancel();
        startGrace();
      }
    },
    release() {
      cancel();
      armed = false;
      show(false);
    },
    visible() {
      return shown;
    },
  };
}
