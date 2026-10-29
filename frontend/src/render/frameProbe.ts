// Dev frame-time probe (v3.0 baseline for Phase 28 / GATE-05). Records a bounded
// rolling average of per-frame draw deltas (`app.ticker.deltaMS`) so the shipped
// default scene's render cost can be read off `window.__fabrico.frameTime()` and
// captured as the pre-reskin baseline. This is a MEASUREMENT probe only: it reads
// the ticker delta and never writes the scene or feeds any deterministic path
// (the sim clock is wall-clock-free; this wall-clock frame delta stays render-side
// and read-only, T-14-FABRICO-RO / T-23-06).

import type { Application } from 'pixi.js';

/** Default rolling window cap - ~2s of 60fps frames. */
export const FRAME_SAMPLE_CAP = 120;

/**
 * A pure bounded rolling window over frame deltas (ms). `push` appends a sample,
 * dropping the oldest once the window is full so it never grows past `cap`.
 * `avg()` is a side-effect-free read of the current mean (0 over an empty window).
 * Kept Pixi-free so the averaging math is unit-testable without a renderer.
 */
export interface RollingWindow {
  push(sample: number): void;
  avg(): number;
  samples(): number;
}

export function createRollingWindow(cap = FRAME_SAMPLE_CAP): RollingWindow {
  // Fixed-capacity ring buffer: O(1) push, no unbounded growth, stable memory.
  const buf = new Float64Array(cap);
  let count = 0; // number of valid samples (<= cap)
  let head = 0; // next write index

  return {
    push(sample: number): void {
      buf[head] = sample;
      head = (head + 1) % cap;
      if (count < cap) count += 1;
    },
    avg(): number {
      if (count === 0) return 0;
      let sum = 0;
      for (let i = 0; i < count; i++) sum += buf[i];
      return sum / count;
    },
    samples(): number {
      return count;
    },
  };
}

/**
 * The live probe: subscribes a callback to `app.ticker` that pushes each frame's
 * `deltaMS` into a bounded rolling window. `avg()` / `samples()` read it; `stop()`
 * detaches the ticker callback (call it in the mount effect cleanup so a torn-down
 * handle is never sampled).
 */
export interface FrameProbe {
  /** Rolling-average frame time in ms (0 until the first frame). */
  avg(): number;
  /** Current sample count in the window. */
  samples(): number;
  /** Detach the ticker callback. */
  stop(): void;
}

export function createFrameProbe(app: Application, cap = FRAME_SAMPLE_CAP): FrameProbe {
  const win = createRollingWindow(cap);
  const onTick = (): void => {
    win.push(app.ticker.deltaMS);
  };
  app.ticker.add(onTick);
  return {
    avg: () => win.avg(),
    samples: () => win.samples(),
    stop: () => {
      app.ticker.remove(onTick);
    },
  };
}
