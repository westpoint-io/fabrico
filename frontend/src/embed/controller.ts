// The tick clock for one board on a page. Wall time decides only WHEN the player steps, never what
// a tick does, so the per-tick hashes are the ones the native engine produces at any speed.
//
// Each animation frame adds `elapsedMs * 60 * speed / 1000` to a count of ticks due, steps the
// whole part (at most 16 in one frame, and never past the end tick), and hands every packet the
// player queued to the packet pipeline in order. Catch-up beyond 16 ticks is dropped, so a tab that
// wakes after an hour doesn't try to run an hour of ticks in one frame. At the end tick the clock
// stops and reads the board's state hash once.

import type { BoardPlayer } from '../player/playerWasm';

/** The engine's rate at 1x. */
export const TICKS_PER_SECOND = 60;
/** The most ticks one animation frame may step. */
export const MAX_STEP_PER_FRAME = 16;

export interface BoardClock {
  start(): void;
  stop(): void;
  playing(): boolean;
  /** The state hash at the end tick, or null before the board gets there. */
  endHash(): string | null;
}

export interface BoardClockOptions {
  player: BoardPlayer;
  /** Hand every packet the player has queued to the renderer. */
  drain: () => void;
  /** Called once when stepping throws (a trapped instance). The clock has already stopped. */
  onFault?: (error: unknown) => void;
}

/** How many ticks to step this frame, and what's left due. Pure, so a test can drive it. */
export function ticksThisFrame(
  due: number,
  elapsedMs: number,
  speed: number,
  ticksToEnd: number,
): { step: number; due: number } {
  const total = due + (elapsedMs * TICKS_PER_SECOND * speed) / 1000;
  const whole = Math.floor(total);
  return { step: Math.max(0, Math.min(whole, ticksToEnd, MAX_STEP_PER_FRAME)), due: total - whole };
}

export function createBoardClock(opts: BoardClockOptions): BoardClock {
  const { player, drain } = opts;
  // Speed is fixed at 1x until the board has controls.
  const speed = 1;
  let raf = 0;
  let last: number | null = null;
  let due = 0;
  let playing = false;
  let endHash: string | null = null;

  const atEnd = (): boolean => player.tick() >= player.endTick();
  const finish = (): void => {
    playing = false;
    endHash = player.tickHash();
  };

  const frame = (now: number): void => {
    raf = 0;
    if (!playing) return;
    const elapsed = last === null ? 0 : Math.max(0, now - last);
    last = now;
    try {
      const next = ticksThisFrame(due, elapsed, speed, player.endTick() - player.tick());
      due = next.due;
      if (next.step > 0) {
        player.step(next.step);
        drain();
      }
      if (atEnd()) {
        finish();
        return;
      }
    } catch (error) {
      playing = false;
      opts.onFault?.(error);
      return;
    }
    raf = requestAnimationFrame(frame);
  };

  return {
    start(): void {
      if (playing) return;
      if (atEnd()) {
        if (endHash === null) finish();
        return;
      }
      playing = true;
      last = null;
      raf = requestAnimationFrame(frame);
    },
    stop(): void {
      playing = false;
      if (raf !== 0) cancelAnimationFrame(raf);
      raf = 0;
    },
    playing: (): boolean => playing,
    endHash: (): string | null => endHash,
  };
}
