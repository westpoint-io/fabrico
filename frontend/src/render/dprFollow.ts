// The pixel-ratio follower: keeps the canvas backing store at the screen's current pixel
// ratio while the app runs.
//
// `bootPixi` hands Pixi `window.devicePixelRatio` once, at `app.init`. When the ratio later
// changes (the window moves to a monitor with a different scale, the desktop's text scaling
// changes, a test switches the ratio), the canvas would keep its old backing store and the
// browser would stretch it, so every edge on the board goes soft.
//
// No event reports a ratio change everywhere. Measured in Chromium under a CDP ratio switch:
// a `matchMedia` resolution listener, a window `resize` listener and a
// `device-pixel-content-box` ResizeObserver all stayed silent while `devicePixelRatio`
// changed. So the renderer compares the ratio with its own resolution once per frame, on
// the ticker ahead of the render. An unchanged ratio costs one float compare and returns.
//
// This module imports nothing from pixi.js, so `dprFollow.test.ts` drives it with a fake
// renderer and no WebGL.

/** The one renderer capability the follower uses: Pixi's `app.renderer` satisfies it. */
export interface ResolutionTarget {
  readonly resolution: number;
  resize(width: number, height: number, resolution: number): void;
}

/**
 * Build the per-frame follower. `readDpr` reads the current ratio, `target` is the renderer,
 * and `cssSize` returns the canvas's CSS size the way Pixi's ResizePlugin reads it (the
 * window's inner size, or the element's client size).
 *
 * A ratio that is not a finite number above 0 reads as 1, so a broken environment value
 * can never make the follower resize on every frame or hand Pixi a zero-sized store.
 */
export function createDprFollower(
  readDpr: () => number,
  target: ResolutionTarget,
  cssSize: () => { width: number; height: number },
): () => void {
  return () => {
    const raw = readDpr();
    const ratio = Number.isFinite(raw) && raw > 0 ? raw : 1;
    if (ratio === target.resolution) return;
    const { width, height } = cssSize();
    target.resize(width, height, ratio);
  };
}
