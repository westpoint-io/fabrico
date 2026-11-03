// The tick clock for one board on a page. Wall time decides only WHEN the player steps, never what
// a tick does, so the per-tick hashes are the ones the native engine produces at any speed.
//
// Each animation frame adds `elapsedMs * 60 * speed / 1000` to a count of ticks due, steps the
// whole part (at most 16 in one frame, never past the next caption tick and never past the end
// tick), and hands every packet the player queued to the packet pipeline in order. Catch-up beyond 16 ticks is dropped, so a tab that
// wakes after an hour doesn't try to run an hour of ticks in one frame. At the end tick the clock
// stops and reads the board's state hash once.
//
// CAPTIONS. The caption ticks come from the player's `boardInfo()` once, at create; the player
// fixes the board info at boot, so a restart doesn't change them. When a step lands on a caption
// tick, by playing or by Step, the clock pauses and holds that caption. `play()` from a hold is
// Continue: it drops the hold and plays on. A multi-tick frame never steps over a caption tick,
// so the board stops on the same tick at 0.25x and at 4x. Restart drops the hold and forgets
// which captions were shown.
//
// The clock calls only `step`, `restart` and the read exports on the player. Play, pause, Step,
// Restart and the speed are the reader's only levers, and none of them reaches inside a tick.
//
// TRACE MODE. When the page sets `globalThis.__FABRICO_EMBED_TRACE__ = true` before the bundle
// runs, the clock steps one tick per call and records each tick's hash, starting with the boot
// tick, so a test can compare every tick with the native engine's dump. The ticks are the same
// either way: `step(4)` and four `step(1)` calls run the same four ticks.

/** The engine's rate at 1x. */
export const TICKS_PER_SECOND = 60;
/** The most ticks one animation frame may step. */
export const MAX_STEP_PER_FRAME = 16;
/** The speeds the reader can pick, slowest first. */
export const SPEEDS = [0.25, 0.5, 1, 2, 4] as const;
export type Speed = (typeof SPEEDS)[number];

/** What the clock needs from a player: stepping, restarting and reads. Nothing else. */
export interface ClockPlayer {
  step(ticks: number): void;
  restart(): void;
  tick(): number;
  endTick(): number;
  tickHash(): string;
  /** The board's captions, in tick order. Read once, at create. */
  boardInfo(): { captions: readonly { tick: number }[] };
}

/** Where the clock gets its frames. The page's `requestAnimationFrame` unless a test swaps it. */
export interface FrameClock {
  request(cb: (now: number) => void): number;
  cancel(id: number): void;
}

/** Why the engine stopped: the tick it was on and the player's own error text. */
export interface ClockFault {
  tick: number;
  message: string;
}

export interface BoardClock {
  /** Play from where the board is. At the end tick, restart from the boot tick and play. */
  play(): void;
  pause(): void;
  /** Pause if playing, then advance exactly one tick. Does nothing at the end tick. */
  stepOne(): void;
  /**
   * Back to the boot tick, keeping the speed, and play. With `play` false it stays paused there,
   * which is what Restart does for a reader who prefers reduced motion.
   */
  restart(play?: boolean): void;
  setSpeed(speed: Speed): void;
  speed(): Speed;
  /** Pause and drop the pending frame, for teardown. */
  stop(): void;
  playing(): boolean;
  /** The tick the board booted to, read right after create. */
  bootTick(): number;
  /** The state hash at the end tick, or null before the board gets there. */
  endHash(): string | null;
  /** Why stepping stopped, or null while the engine runs. Only Restart clears it. */
  fault(): ClockFault | null;
  /** Every tick and its hash since boot or the last restart, in trace mode; empty otherwise. */
  tickHashes(): [number, string][];
  /** The index of the caption holding the board, or null. `play()` drops the hold. */
  caption(): number | null;
  /** The index of the last caption the board reached since boot or Restart, or null. */
  lastCaption(): number | null;
}

export interface BoardClockOptions {
  player: ClockPlayer;
  /** Hand every packet the player has queued to the renderer. */
  drain: () => void;
  /** Called after anything a reader can see changed: a step, play, pause, speed, restart, end. */
  onChange?: () => void;
  /** Called once when stepping throws. The clock has already stopped. */
  onFault?: (error: unknown) => void;
  /** Called right after the player restarts, before its keyframe is drained. */
  onRestart?: () => void;
  /** Step one tick at a time and record each tick's hash. */
  trace?: boolean;
  frames?: FrameClock;
}

/** How many ticks to step this frame, and what's left due. Pure, so a test can drive it. */
export function ticksThisFrame(
  due: number,
  elapsedMs: number,
  speed: number,
  ticksToEnd: number,
  ticksToNextCaption = Infinity,
): { step: number; due: number } {
  const total = due + (elapsedMs * TICKS_PER_SECOND * speed) / 1000;
  const whole = Math.floor(total);
  return {
    step: Math.max(0, Math.min(whole, ticksToNextCaption, ticksToEnd, MAX_STEP_PER_FRAME)),
    due: total - whole,
  };
}

const ANIMATION_FRAMES: FrameClock = {
  request: (cb) => requestAnimationFrame(cb),
  cancel: (id) => cancelAnimationFrame(id),
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createBoardClock(opts: BoardClockOptions): BoardClock {
  const { player, drain } = opts;
  const frames = opts.frames ?? ANIMATION_FRAMES;
  const trace = opts.trace === true;
  const changed = (): void => opts.onChange?.();

  let speed: Speed = 1;
  let raf = 0;
  let last: number | null = null;
  let due = 0;
  let playing = false;
  let endHash: string | null = null;
  let fault: ClockFault | null = null;
  let bootTick = player.tick();
  let hashes: [number, string][] = [];
  const captionTicks = player.boardInfo().captions.map((c) => c.tick);
  let held: number | null = null;
  let lastShown: number | null = null;

  /** Ticks from here to the next caption tick, or Infinity with none ahead. */
  const ticksToNextCaption = (): number => {
    const now = player.tick();
    for (const t of captionTicks) if (t > now) return t - now;
    return Infinity;
  };
  /** Hold the caption on this tick, if there is one. Returns whether it did. */
  const holdIfCaption = (): boolean => {
    const at = captionTicks.indexOf(player.tick());
    if (at < 0) return false;
    held = at;
    lastShown = at;
    playing = false;
    cancelFrame();
    return true;
  };

  const record = (): void => {
    if (trace) hashes.push([player.tick(), player.tickHash()]);
  };
  record();

  const atEnd = (): boolean => player.tick() >= player.endTick();
  const cancelFrame = (): void => {
    if (raf !== 0) frames.cancel(raf);
    raf = 0;
  };
  const finish = (): void => {
    playing = false;
    cancelFrame();
    endHash = player.tickHash();
  };

  /** Read the tick for a fault report; a trapped player can't answer, so fall back. */
  const safeTick = (fallback: number): number => {
    try {
      return player.tick();
    } catch {
      return fallback;
    }
  };

  /** Run `n` ticks. Returns false when the player threw, after recording the fault. */
  const advance = (n: number): boolean => {
    let tickBefore = bootTick;
    try {
      tickBefore = player.tick();
      if (trace) {
        for (let i = 0; i < n; i++) {
          player.step(1);
          record();
        }
      } else {
        player.step(n);
      }
      drain();
      if (atEnd()) finish();
      holdIfCaption();
      return true;
    } catch (error) {
      // Whatever the player queued before it stopped still belongs on screen.
      try {
        drain();
      } catch {
        // A trapped player can't hand anything over.
      }
      playing = false;
      cancelFrame();
      fault = { tick: safeTick(tickBefore), message: messageOf(error) };
      opts.onFault?.(error);
      return false;
    }
  };

  const frame = (now: number): void => {
    raf = 0;
    if (!playing) return;
    const elapsed = last === null ? 0 : Math.max(0, now - last);
    last = now;
    const next = ticksThisFrame(due, elapsed, speed, player.endTick() - player.tick(), ticksToNextCaption());
    due = next.due;
    if (next.step > 0 && !advance(next.step)) {
      changed();
      return;
    }
    if (held !== null) {
      changed();
      return;
    }
    if (atEnd()) {
      if (endHash === null) finish();
      changed();
      return;
    }
    changed();
    raf = frames.request(frame);
  };

  const startFrames = (): void => {
    playing = true;
    last = null;
    due = 0;
    cancelFrame();
    raf = frames.request(frame);
  };

  const restart = (play = true): void => {
    cancelFrame();
    playing = false;
    endHash = null;
    fault = null;
    due = 0;
    hashes = [];
    held = null;
    lastShown = null;
    try {
      player.restart();
      opts.onRestart?.();
      bootTick = player.tick();
      record();
      // The restart queued a keyframe, which resets the scene.
      drain();
    } catch (error) {
      fault = { tick: safeTick(bootTick), message: messageOf(error) };
      opts.onFault?.(error);
      changed();
      return;
    }
    if (play) startFrames();
    changed();
  };

  return {
    play(): void {
      if (fault !== null || playing) return;
      if (held !== null) {
        // Continue. A caption on the end tick leaves the board at its end.
        held = null;
        if (atEnd()) {
          changed();
          return;
        }
        startFrames();
        changed();
        return;
      }
      if (atEnd()) {
        restart();
        return;
      }
      startFrames();
      changed();
    },
    pause(): void {
      if (!playing) return;
      playing = false;
      cancelFrame();
      changed();
    },
    stepOne(): void {
      if (fault !== null) return;
      if (playing) {
        playing = false;
        cancelFrame();
      }
      held = null;
      if (!atEnd()) advance(1);
      changed();
    },
    restart: (play?: boolean): void => restart(play ?? true),
    setSpeed(next: Speed): void {
      if (!SPEEDS.includes(next)) throw new RangeError(`speed is one of ${SPEEDS.join(', ')}, not ${String(next)}`);
      speed = next;
      changed();
    },
    speed: (): Speed => speed,
    stop(): void {
      playing = false;
      cancelFrame();
    },
    playing: (): boolean => playing,
    bootTick: (): number => bootTick,
    endHash: (): string | null => endHash,
    fault: (): ClockFault | null => (fault === null ? null : { ...fault }),
    tickHashes: (): [number, string][] => hashes.map(([t, h]) => [t, h]),
    caption: (): number | null => held,
    lastCaption: (): number | null => lastShown,
  };
}
