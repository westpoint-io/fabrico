// THE GROWTH READ OFF THE CANVAS IN THE PAGE (plan 84-16).
//
// WHY. Plan 84-15 stopped here: leg 2's growth captures went through CDP
// `Page.captureScreenshot`, and one capture took about 3.8 s at the GPU proxy (about 240 model
// ticks) against a 40-tick stage, so no limit on captures in flight let a capture be requested and
// answered inside a stage, and leg 2 failed `GROWTH UNMEASURED` on every proxy run (no in-flight
// depth fits at the proxy). The decision (not a grading change): read the Pixi WebGL canvas in the page itself, stamped with the model tick read in the
// same animation-frame callback. The 84-15 spike (`b8415/spike-inpage.diff`) passed legs 1 and 2
// three times at the proxy and three times unthrottled, and both of plan 84-11's drawing bites went
// red, but each synchronous `gl.readPixels` stalled the page about 380 ms at the proxy (p50 380 to
// 383 ms, max about 4 s) and the in-page tick recorder missed about three ticks in four (0.75 to
// 0.78); unthrottled the read took about 8.5 ms.
//
// THE FRAME ORDERING IT RELIES ON. Pixi's `Ticker._tick` requests its next animation frame at the
// END of its tick, after the render loop and the Application's render ran. So an animation-frame
// callback this function requests between frames is queued after Pixi's and runs after Pixi drew
// that frame, and before the browser composites it: the drawing buffer still holds the frame (Pixi
// boots without `preserveDrawingBuffer`, so a read BEFORE Pixi draws could find a cleared buffer,
// which `flat` flags). The scene and the item layer's `drawnAtTick` are read in that same callback,
// so the pixels and the stamp are one frame's.
//
// THE STAMP IS THE ISSUING FRAME'S. In `pbo` mode the pixels are copied into a WebGL2 pixel-pack
// buffer on the frame they are issued (`readPixels` into a bound `PIXEL_PACK_BUFFER` copies at call
// time on the GPU timeline), a fence is set, and the bytes are read back with `getBufferSubData` on a
// later frame once the fence reads `SIGNALED`. The bytes are the issuing frame's, so the capture
// carries the issuing frame's tick and `drawnAtTick`, never the read-back frame's.
//
// SHIPPED AS SOURCE. `page.evaluate(captureFrameInPage, args)` sends this function's source text
// into the page, so the body references nothing outside itself: no import, no module constant, no
// helper outside it. `env` is the unit test's fake page (`src/gates/frameCapture.test.ts`); absent,
// the page's own globals are used and the store lives on `window.__fabGrowthCapture`.

/** How the canvas is read: synchronously in the callback, or through a WebGL2 pack buffer. */
export type CaptureMode = 'pbo' | 'sync';

/** A rectangle in CSS px, half-open. */
export interface CaptureRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface CaptureArgs {
  rect: CaptureRect;
  mode: CaptureMode;
  /** False to only drain reads already issued (one animation frame, no new read). */
  issue: boolean;
  /** A buffered read not read back after this many animation frames throws by name. */
  readbackFramesMax: number;
}

/** One frame read off the canvas, stamped with the frame it was issued on. */
export interface CapturedFrame {
  seq: number;
  /** `scene().tick` read in the callback whose frame the pixels are. */
  tick: number;
  /** The item layer's `drawnAtTick` read in that same callback. */
  drawnAtTick: number | null;
  /** True when `drawnAtTick` is not `tick`. */
  unpaired: boolean;
  /** RGBA, top-down rows, base64. */
  b64: string;
  w: number;
  h: number;
  /** Device px per CSS px (`canvas.width / box.width`). */
  k: number;
  /** Every pixel the same RGBA value (a cleared buffer). */
  flat: boolean;
  /** The longest single stretch of GL calls this capture cost the main thread in one callback. */
  blockMs: number;
  /** Animation frames from the issue to the read-back (0 for `sync`). */
  readbackFrames: number;
  /** Ms from the issue to the read-back (0 for `sync`). */
  readbackMs: number;
}

export interface CaptureReply {
  /** The scene read in this call's callback (the page's `__fabrico.scene()` value). */
  scene: unknown;
  /** Every capture read back in this call, in issue order. */
  captures: CapturedFrame[];
  /** Buffered reads issued and not yet read back. */
  inFlight: number;
  context: 'webgl2' | 'webgl';
}

/** What the function reaches outside itself; the page's own globals when absent. */
export interface CaptureEnv {
  raf(cb: (ts: number) => void): void;
  elementFromPoint(x: number, y: number): Element | null;
  fabrico(): { scene(): unknown; itemDotsFrame(): { drawnAtTick: number | null } } | undefined;
  store: Record<string, unknown>;
  now(): number;
  btoa(s: string): string;
}

/**
 * Wait ONE animation frame and, in that callback, after Pixi drew it: find the canvas under the
 * rect's top-left corner, read the scene (the stamp) and the item layer's `drawnAtTick`, issue a read
 * of the rect (when `issue`), and in `pbo` mode read back every buffered read whose fence has
 * signaled, in issue order. See the file comment for why.
 */
export function captureFrameInPage(args: CaptureArgs, env?: CaptureEnv): Promise<CaptureReply> {
  type Gl = WebGL2RenderingContext;
  type Queued = {
    seq: number;
    tick: number;
    drawnAtTick: number | null;
    buffer: WebGLBuffer;
    fence: WebGLSync;
    issuedFrame: number;
    issuedAt: number;
    issueMs: number;
    w: number;
    h: number;
    k: number;
  };
  type Store = {
    seq: number;
    frame: number;
    counting: boolean;
    queue: Queued[];
    pool: { buffer: WebGLBuffer; size: number }[];
    gl: unknown;
  };
  const w = globalThis as unknown as {
    __fabrico?: { scene(): unknown; itemDotsFrame(): { drawnAtTick: number | null } };
    __fabGrowthCapture?: Record<string, unknown>;
  };
  const e: CaptureEnv = env ?? {
    raf: (cb) => {
      requestAnimationFrame(cb);
    },
    elementFromPoint: (x, y) => document.elementFromPoint(x, y),
    fabrico: () => w.__fabrico,
    store: (w.__fabGrowthCapture ??= {}),
    now: () => performance.now(),
    btoa: (s) => btoa(s),
  };
  const st = e.store as unknown as Store;
  if (st.queue === undefined) {
    st.seq = 0;
    st.frame = 0;
    st.counting = false;
    st.queue = [];
    st.pool = [];
    st.gl = null;
  }
  return new Promise<CaptureReply>((resolve, reject) => {
    e.raf(() => {
      try {
        const { rect, mode, issue, readbackFramesMax } = args;
        const hook = e.fabrico();
        if (!hook) throw new Error('captureFrameInPage: window.__fabrico not installed');
        const el = e.elementFromPoint(rect.x0, rect.y0);
        if (!el || el.tagName !== 'CANVAS') {
          throw new Error(`captureFrameInPage: NO CANVAS under (${rect.x0},${rect.y0}): read ${el ? el.tagName : 'nothing'}`);
        }
        const canvas = el as HTMLCanvasElement;
        let context: 'webgl2' | 'webgl' = 'webgl2';
        let gl = canvas.getContext('webgl2') as Gl | null;
        if (!gl) {
          context = 'webgl';
          gl = canvas.getContext('webgl') as unknown as Gl | null;
        }
        if (!gl) throw new Error('captureFrameInPage: NO WEBGL CONTEXT on the canvas under the clip');
        if (st.gl !== gl) {
          if (st.queue.length > 0) {
            throw new Error(`captureFrameInPage: THE CANVAS CHANGED with ${st.queue.length} buffered reads in flight`);
          }
          st.pool = [];
          st.gl = gl;
        }
        // The stamp, read in the callback whose frame is read.
        const scene = hook.scene();
        const tick = (scene as unknown as { tick: number }).tick;
        const drawnAtTick = hook.itemDotsFrame().drawnAtTick;
        const box = canvas.getBoundingClientRect();
        const k = canvas.width / box.width;
        const x = Math.round((rect.x0 - box.left) * k);
        const y = Math.round((rect.y0 - box.top) * k);
        const cw = Math.round((rect.x1 - rect.x0) * k);
        const ch = Math.round((rect.y1 - rect.y0) * k);
        const glY = canvas.height - y - ch;
        // GL rows run bottom-up: flip to top-down, as a screenshot is; then base64 and `flat`.
        const encode = (raw: Uint8Array, rw: number, rh: number): { b64: string; flat: boolean } => {
          const out = new Uint8Array(rw * rh * 4);
          for (let row = 0; row < rh; row++) {
            out.set(raw.subarray((rh - 1 - row) * rw * 4, (rh - row) * rw * 4), row * rw * 4);
          }
          let flat = true;
          for (let i = 4; i < out.length && flat; i += 4) {
            if (out[i] !== out[0] || out[i + 1] !== out[1] || out[i + 2] !== out[2] || out[i + 3] !== out[3]) flat = false;
          }
          let bin = '';
          for (let i = 0; i < out.length; i += 8192) {
            bin += String.fromCharCode.apply(null, out.subarray(i, i + 8192) as unknown as number[]);
          }
          return { b64: e.btoa(bin), flat };
        };
        const captures: CapturedFrame[] = [];
        if (issue && mode === 'sync') {
          const t0 = e.now();
          const raw = new Uint8Array(cw * ch * 4);
          if (context === 'webgl2') {
            const pack = gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING) as WebGLBuffer | null;
            const fb = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
            try {
              gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
              gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
              gl.readPixels(x, glY, cw, ch, gl.RGBA, gl.UNSIGNED_BYTE, raw);
            } finally {
              gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pack);
              gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fb);
            }
          } else {
            const fb = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
            try {
              gl.bindFramebuffer(gl.FRAMEBUFFER, null);
              gl.readPixels(x, glY, cw, ch, gl.RGBA, gl.UNSIGNED_BYTE, raw);
            } finally {
              gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
            }
          }
          const blockMs = e.now() - t0;
          const { b64, flat } = encode(raw, cw, ch);
          captures.push({
            seq: st.seq++,
            tick,
            drawnAtTick,
            unpaired: drawnAtTick !== tick,
            b64,
            w: cw,
            h: ch,
            k,
            flat,
            blockMs,
            readbackFrames: 0,
            readbackMs: 0,
          });
        }
        if (mode === 'pbo') {
          if (context !== 'webgl2') {
            throw new Error('captureFrameInPage: BUFFERED READ NEEDS WEBGL2, the canvas has a WebGL1 context');
          }
          if (issue) {
            const t0 = e.now();
            const size = cw * ch * 4;
            const pack = gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING) as WebGLBuffer | null;
            const fb = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
            let buffer: WebGLBuffer | null = null;
            let fence: WebGLSync | null = null;
            try {
              const pooled = st.pool.findIndex((p) => p.size === size);
              if (pooled >= 0) {
                buffer = st.pool.splice(pooled, 1)[0].buffer;
                gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer);
              } else {
                buffer = gl.createBuffer();
                if (!buffer) throw new Error('captureFrameInPage: createBuffer returned null');
                gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer);
                gl.bufferData(gl.PIXEL_PACK_BUFFER, size, gl.STREAM_READ);
              }
              gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
              gl.readPixels(x, glY, cw, ch, gl.RGBA, gl.UNSIGNED_BYTE, 0);
              fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
              if (!fence) throw new Error('captureFrameInPage: fenceSync returned null');
            } finally {
              gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pack);
              gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fb);
            }
            gl.flush();
            st.queue.push({
              seq: st.seq++,
              tick,
              drawnAtTick,
              buffer,
              fence,
              issuedFrame: st.frame,
              issuedAt: t0,
              issueMs: e.now() - t0,
              w: cw,
              h: ch,
              k,
            });
          }
          // Drain in issue order, stopping at the first read whose fence has not signaled.
          while (st.queue.length > 0) {
            const q = st.queue[0];
            const frames = st.frame - q.issuedFrame;
            if (gl.getSyncParameter(q.fence, gl.SYNC_STATUS) !== gl.SIGNALED) {
              if (frames > readbackFramesMax) {
                throw new Error(
                  `captureFrameInPage: CAPTURE NEVER READ BACK: the read of tick ${q.tick} was not ready after ${frames} animation frames (limit ${readbackFramesMax})`,
                );
              }
              break;
            }
            st.queue.shift();
            const t1 = e.now();
            const raw = new Uint8Array(q.w * q.h * 4);
            const pack = gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING) as WebGLBuffer | null;
            try {
              gl.bindBuffer(gl.PIXEL_PACK_BUFFER, q.buffer);
              gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, raw);
            } finally {
              gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pack);
            }
            gl.deleteSync(q.fence);
            st.pool.push({ buffer: q.buffer, size: q.w * q.h * 4 });
            const readMs = e.now() - t1;
            const { b64, flat } = encode(raw, q.w, q.h);
            captures.push({
              seq: q.seq,
              tick: q.tick,
              drawnAtTick: q.drawnAtTick,
              unpaired: q.drawnAtTick !== q.tick,
              b64,
              w: q.w,
              h: q.h,
              k: q.k,
              flat,
              blockMs: Math.max(q.issueMs, readMs),
              readbackFrames: frames,
              readbackMs: t1 - q.issuedAt,
            });
          }
          // Count animation frames while reads are in flight: one increment per frame.
          if (st.queue.length > 0 && !st.counting) {
            st.counting = true;
            const step = (): void => {
              st.frame++;
              if (st.queue.length > 0) e.raf(step);
              else st.counting = false;
            };
            e.raf(step);
          }
        }
        resolve({ scene, captures, inFlight: st.queue.length, context });
      } catch (err) {
        reject(err);
      }
    });
  });
}
