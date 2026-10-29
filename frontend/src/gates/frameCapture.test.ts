// THE GROWTH CAPTURE PAIRS ITS PIXELS WITH ITS STAMP (plan 84-16).
//
// `e2e-live/support/frameCapture.ts` `captureFrameInPage` reads leg 2's growth off the Pixi WebGL
// canvas inside one animation-frame callback and stamps it with the model tick read in that same
// callback; in `pbo` mode the pixels travel through a WebGL2 pack buffer and are read back frames
// later, still carrying the tick of the frame they were issued on. A capture whose stamp is not the
// frame its pixels came from would grade the drawing against the wrong stage. So these cases drive
// it against a fake page whose every frame n is drawn by a fake "Pixi" step as R = n mod 256, G =
// the device x, B = the device y (top-down), A = 255, with `scene().tick` and the item layer's
// `drawnAtTick` set to 1000 + 5n, on a canvas of 2 device px per CSS px at a non-zero offset: a
// capture of the wrong frame, offset, scale or row order decodes to the wrong values. Animation
// frame callbacks run in the order they were requested, Pixi's first, as in the browser.
//
// Lives under `src/` because `vitest.config.ts` includes `src/**/*.{test,spec}.{ts,tsx}` only.

import { describe, expect, it } from 'vitest';
import {
  captureFrameInPage,
  type CaptureArgs,
  type CaptureEnv,
  type CapturedFrame,
  type CaptureReply,
} from '../../e2e-live/support/frameCapture';

const K = 2;
const BOX = { left: 37, top: 21, width: 100, height: 60 };
const DEV_W = BOX.width * K;
const DEV_H = BOX.height * K;
/** A rect in CSS px inside the canvas, away from every edge. */
const RECT = { x0: 50, y0: 30, x1: 70, y1: 41 };
const tickOf = (n: number): number => 1000 + 5 * n;

const GL_CONST = {
  PIXEL_PACK_BUFFER: 0x88eb,
  PIXEL_PACK_BUFFER_BINDING: 0x88ed,
  READ_FRAMEBUFFER: 0x8ca8,
  READ_FRAMEBUFFER_BINDING: 0x8caa,
  FRAMEBUFFER: 0x8d40,
  FRAMEBUFFER_BINDING: 0x8ca6,
  STREAM_READ: 0x88e1,
  SYNC_GPU_COMMANDS_COMPLETE: 0x9117,
  SYNC_STATUS: 0x9112,
  SIGNALED: 0x9119,
  UNSIGNALED: 0x9118,
  RGBA: 0x1908,
  UNSIGNED_BYTE: 0x1401,
};

interface FakeOpts {
  /** Frames after its creation a fence reads SIGNALED. */
  signalAfter?: number;
  /** No WebGL2 context: `getContext('webgl2')` returns null. */
  webgl1?: boolean;
  /** Frames drawn as one flat colour. */
  flatFrames?: Set<number>;
  /** Frames whose item layer drew from another tick than the scene's. */
  staleItemFrames?: Set<number>;
}

/** The fake page: a canvas, its framebuffer, a fake WebGL2 context and an animation-frame queue. */
function fakePage(opts: FakeOpts = {}) {
  const signalAfter = opts.signalAfter ?? 1;
  let frame = 0;
  let queue: ((ts: number) => void)[] = [];
  /** The default framebuffer, GL rows bottom-up, RGBA. */
  const fb = new Uint8Array(DEV_W * DEV_H * 4);
  const scene = { tick: tickOf(0) };
  const items = { drawnAtTick: tickOf(0) as number | null };
  const SENTINEL_PACK = { name: 'pixi-pack' };
  const SENTINEL_FB = { name: 'pixi-fb' };
  const buffers = new Map<object, Uint8Array>();
  const fences = new Map<object, number>();
  let packBound: object | null = SENTINEL_PACK;
  let readFbBound: object | null = SENTINEL_FB;
  const calls: string[] = [];
  const pixi = (): void => {
    const n = frame;
    const flat = opts.flatFrames?.has(n) === true;
    for (let gy = 0; gy < DEV_H; gy++) {
      const dy = DEV_H - 1 - gy;
      for (let dx = 0; dx < DEV_W; dx++) {
        const i = (gy * DEV_W + dx) * 4;
        fb[i] = flat ? 9 : n % 256;
        fb[i + 1] = flat ? 9 : dx;
        fb[i + 2] = flat ? 9 : dy;
        fb[i + 3] = 255;
      }
    }
    scene.tick = tickOf(n);
    items.drawnAtTick = opts.staleItemFrames?.has(n) === true ? tickOf(n) - 1 : tickOf(n);
    queue.push(pixi);
  };
  const readInto = (x: number, y: number, w: number, h: number, dst: Uint8Array, off: number): void => {
    for (let r = 0; r < h; r++) {
      for (let c = 0; c < w; c++) {
        const s = ((y + r) * DEV_W + (x + c)) * 4;
        const d = off + (r * w + c) * 4;
        if (readFbBound === null) {
          dst.set(fb.subarray(s, s + 4), d);
        } else {
          // Pixi's own render target: another pattern entirely.
          dst.set([200, 201, 202, 203], d);
        }
      }
    }
  };
  const gl2 = {
    ...GL_CONST,
    getParameter(p: number): unknown {
      if (p === GL_CONST.PIXEL_PACK_BUFFER_BINDING) return packBound;
      if (p === GL_CONST.READ_FRAMEBUFFER_BINDING) return readFbBound;
      if (p === GL_CONST.FRAMEBUFFER_BINDING) return readFbBound;
      throw new Error(`fake gl: getParameter(${p}) not faked`);
    },
    bindBuffer(target: number, b: object | null): void {
      if (target !== GL_CONST.PIXEL_PACK_BUFFER) throw new Error('fake gl: bindBuffer target');
      packBound = b;
    },
    bindFramebuffer(target: number, f: object | null): void {
      if (target !== GL_CONST.READ_FRAMEBUFFER && target !== GL_CONST.FRAMEBUFFER) throw new Error('fake gl: bindFramebuffer target');
      readFbBound = f;
    },
    createBuffer(): object {
      const b = { name: `buf${buffers.size}` };
      buffers.set(b, new Uint8Array(0));
      return b;
    },
    deleteBuffer(b: object): void {
      buffers.delete(b);
    },
    bufferData(target: number, size: number, usage: number): void {
      if (target !== GL_CONST.PIXEL_PACK_BUFFER || usage !== GL_CONST.STREAM_READ) throw new Error('fake gl: bufferData');
      if (packBound === null || !buffers.has(packBound)) throw new Error('fake gl: bufferData with no buffer bound');
      buffers.set(packBound, new Uint8Array(size));
    },
    readPixels(x: number, y: number, w: number, h: number, format: number, type: number, dst: Uint8Array | number): void {
      if (format !== GL_CONST.RGBA || type !== GL_CONST.UNSIGNED_BYTE) throw new Error('fake gl: readPixels format');
      calls.push('readPixels');
      if (typeof dst === 'number') {
        if (packBound === null || !buffers.has(packBound)) throw new Error('fake gl: readPixels to offset with no pack buffer bound');
        readInto(x, y, w, h, buffers.get(packBound) as Uint8Array, dst);
      } else {
        if (packBound !== null) throw new Error('fake gl: readPixels into an array with a pack buffer bound');
        readInto(x, y, w, h, dst, 0);
      }
    },
    fenceSync(cond: number, flags: number): object {
      if (cond !== GL_CONST.SYNC_GPU_COMMANDS_COMPLETE || flags !== 0) throw new Error('fake gl: fenceSync args');
      const f = { name: `fence${fences.size}` };
      fences.set(f, frame);
      return f;
    },
    getSyncParameter(f: object, p: number): number {
      if (p !== GL_CONST.SYNC_STATUS) throw new Error('fake gl: getSyncParameter pname');
      const made = fences.get(f);
      if (made === undefined) throw new Error('fake gl: getSyncParameter on a deleted fence');
      return frame - made >= signalAfter ? GL_CONST.SIGNALED : GL_CONST.UNSIGNALED;
    },
    deleteSync(f: object): void {
      fences.delete(f);
    },
    getBufferSubData(target: number, off: number, dst: Uint8Array): void {
      if (target !== GL_CONST.PIXEL_PACK_BUFFER || packBound === null) throw new Error('fake gl: getBufferSubData with no pack buffer bound');
      const src = buffers.get(packBound) as Uint8Array;
      dst.set(src.subarray(off, off + dst.length));
    },
    flush(): void {},
  };
  const gl1 = {
    ...GL_CONST,
    getParameter: gl2.getParameter,
    bindFramebuffer: gl2.bindFramebuffer,
    // WebGL1 has no pack buffer: the read always lands in the given array.
    readPixels(x: number, y: number, w: number, h: number, format: number, type: number, dst: Uint8Array): void {
      if (format !== GL_CONST.RGBA || type !== GL_CONST.UNSIGNED_BYTE) throw new Error('fake gl: readPixels format');
      calls.push('readPixels');
      readInto(x, y, w, h, dst, 0);
    },
  };
  const canvas = {
    tagName: 'CANVAS',
    width: DEV_W,
    height: DEV_H,
    getBoundingClientRect: () => ({ ...BOX, right: BOX.left + BOX.width, bottom: BOX.top + BOX.height, x: BOX.left, y: BOX.top }),
    getContext: (kind: string): unknown => (kind === 'webgl2' ? (opts.webgl1 ? null : gl2) : kind === 'webgl' ? gl1 : null),
  };
  let clock = 0;
  const env: CaptureEnv = {
    raf: (cb) => {
      queue.push(cb);
    },
    elementFromPoint: (x, y) =>
      x >= BOX.left && x < BOX.left + BOX.width && y >= BOX.top && y < BOX.top + BOX.height ? (canvas as unknown as Element) : null,
    fabrico: () => ({ scene: () => ({ ...scene }), itemDotsFrame: () => ({ drawnAtTick: items.drawnAtTick }) }),
    store: {},
    now: () => (clock += 0.25),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  };
  // Pixi's ticker requested its frame first.
  queue.push(pixi);
  /** One animation frame: the callbacks queued before it ran, in request order (Pixi first). */
  const runFrame = (): void => {
    frame++;
    const now = queue;
    queue = [];
    for (const cb of now) cb(frame * 16);
  };
  return {
    env,
    runFrame,
    frame: () => frame,
    bindings: () => ({ pack: packBound, fb: readFbBound }),
    SENTINELS: { pack: SENTINEL_PACK, fb: SENTINEL_FB },
    calls,
  };
}

type Page = ReturnType<typeof fakePage>;

/** Call once and run frames until the call settles (at most 10). */
async function call(p: Page, args: CaptureArgs): Promise<CaptureReply & { scene: { tick: number } }> {
  let settled = false;
  const pr = captureFrameInPage(args, p.env).finally(() => {
    settled = true;
  }) as Promise<CaptureReply & { scene: { tick: number } }>;
  for (let i = 0; i < 10 && !settled; i++) {
    p.runFrame();
    await Promise.resolve();
    await Promise.resolve();
  }
  return pr;
}

const args = (mode: 'pbo' | 'sync', issue = true, readbackFramesMax = 30): CaptureArgs => ({
  rect: RECT,
  mode,
  issue,
  readbackFramesMax,
});

/** Every pixel of a capture decoded: one frame number, and the right device rectangle top-down. */
function decode(c: CapturedFrame): { frames: Set<number>; geometryOk: boolean } {
  const px = new Uint8Array(Buffer.from(c.b64, 'base64'));
  const x0 = (RECT.x0 - BOX.left) * K;
  const y0 = (RECT.y0 - BOX.top) * K;
  const frames = new Set<number>();
  let geometryOk = c.w === (RECT.x1 - RECT.x0) * K && c.h === (RECT.y1 - RECT.y0) * K && px.length === c.w * c.h * 4;
  for (let r = 0; r < c.h; r++) {
    for (let col = 0; col < c.w; col++) {
      const i = (r * c.w + col) * 4;
      frames.add(px[i]);
      if (px[i + 1] !== x0 + col || px[i + 2] !== y0 + r || px[i + 3] !== 255) geometryOk = false;
    }
  }
  return { frames, geometryOk };
}

/** The stamp is 1000 + 5 times the frame the pixels name, and the pixels are the right rectangle. */
function expectPaired(c: CapturedFrame): void {
  const { frames, geometryOk } = decode(c);
  expect(frames.size, 'one frame in the pixels').toBe(1);
  const n = [...frames][0];
  expect(c.tick, `stamp of a capture whose pixels are frame ${n}`).toBe(tickOf(n));
  expect(geometryOk, 'device rectangle, scale and row order').toBe(true);
  expect(c.k).toBe(K);
  expect(c.flat).toBe(false);
  expect(c.unpaired).toBe(false);
}

describe('captureFrameInPage pairs the pixels it reads with the tick it stamps', () => {
  it('PAIRS a synchronous read with the tick of the frame it read', async () => {
    const p = fakePage();
    const got: CapturedFrame[] = [];
    for (let i = 0; i < 3; i++) {
      p.runFrame();
      const reply = await call(p, args('sync'));
      expect(reply.context).toBe('webgl2');
      expect(reply.inFlight).toBe(0);
      expect(reply.captures).toHaveLength(1);
      expect(reply.scene.tick).toBe(reply.captures[0].tick);
      got.push(...reply.captures);
    }
    for (const c of got) expectPaired(c);
    expect(new Set(got.map((c) => c.tick)).size).toBe(3);
    expect(got.every((c) => c.readbackFrames === 0 && c.readbackMs === 0)).toBe(true);
  });

  it('PAIRS a buffered read with the tick of the frame it was issued on, read back one frame later', async () => {
    const p = fakePage({ signalAfter: 1 });
    p.runFrame();
    const issued = await call(p, args('pbo'));
    expect(issued.captures).toHaveLength(0);
    expect(issued.inFlight).toBe(1);
    const issuedTick = issued.scene.tick;
    const back = await call(p, args('pbo', false));
    expect(back.captures).toHaveLength(1);
    expect(back.inFlight).toBe(0);
    const c = back.captures[0];
    expect(c.tick).toBe(issuedTick);
    expect(back.scene.tick).toBeGreaterThan(issuedTick);
    expect(c.readbackFrames).toBe(1);
    expectPaired(c);
  });

  it('PAIRS a buffered read read back three frames later', async () => {
    const p = fakePage({ signalAfter: 3 });
    const issued = await call(p, args('pbo'));
    const issuedTick = issued.scene.tick;
    const got: CapturedFrame[] = [];
    for (let i = 0; i < 5 && got.length === 0; i++) got.push(...(await call(p, args('pbo', false))).captures);
    expect(got).toHaveLength(1);
    expect(got[0].tick).toBe(issuedTick);
    expect(got[0].readbackFrames).toBe(3);
    expectPaired(got[0]);
  });

  it('RETURNS buffered reads in the order they were issued', async () => {
    const p = fakePage({ signalAfter: 2 });
    const got: CapturedFrame[] = [];
    const issuedTicks: number[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await call(p, args('pbo'));
      issuedTicks.push(r.scene.tick);
      got.push(...r.captures);
    }
    for (let i = 0; i < 6; i++) {
      const r = await call(p, args('pbo', false));
      got.push(...r.captures);
      if (r.inFlight === 0) break;
    }
    expect(got.map((c) => c.seq)).toEqual([0, 1, 2, 3]);
    expect(got.map((c) => c.tick)).toEqual(issuedTicks);
    for (const c of got) expectPaired(c);
  });

  it('RESTORES the pack buffer and read framebuffer bindings it found', async () => {
    for (const mode of ['sync', 'pbo'] as const) {
      const p = fakePage({ signalAfter: 1 });
      for (let i = 0; i < 3; i++) {
        await call(p, args(mode));
        expect(p.bindings(), `${mode}: after call ${i}`).toEqual({ pack: p.SENTINELS.pack, fb: p.SENTINELS.fb });
      }
      const r = await call(p, args(mode, false));
      expect(p.bindings(), `${mode}: after the drain`).toEqual({ pack: p.SENTINELS.pack, fb: p.SENTINELS.fb });
      expect(r.inFlight).toBe(0);
      expect(p.calls.length).toBe(3);
    }
  });

  it('FLAGS a frame the item layer drew from another tick as unpaired', async () => {
    for (const mode of ['sync', 'pbo'] as const) {
      const p = fakePage({ signalAfter: 1, staleItemFrames: new Set([2]) });
      const got: CapturedFrame[] = [];
      for (let i = 0; i < 3; i++) got.push(...(await call(p, args(mode))).captures);
      got.push(...(await call(p, args(mode, false))).captures);
      expect(got.map((c) => c.unpaired), mode).toEqual([false, true, false]);
      expect(got[1].drawnAtTick, mode).toBe(got[1].tick - 1);
    }
  });

  it('FLAGS a flat frame', async () => {
    for (const mode of ['sync', 'pbo'] as const) {
      const p = fakePage({ signalAfter: 1, flatFrames: new Set([2]) });
      const got: CapturedFrame[] = [];
      for (let i = 0; i < 3; i++) got.push(...(await call(p, args(mode))).captures);
      got.push(...(await call(p, args(mode, false))).captures);
      expect(got.map((c) => c.flat), mode).toEqual([false, true, false]);
    }
  });

  it('THROWS by name when a buffered read is not ready after the frame limit', async () => {
    const p = fakePage({ signalAfter: 100 });
    await call(p, args('pbo', true, 3));
    let err: unknown = null;
    for (let i = 0; i < 8 && err === null; i++) {
      try {
        await call(p, args('pbo', false, 3));
      } catch (e) {
        err = e;
      }
    }
    expect(String(err)).toMatch(/CAPTURE NEVER READ BACK: the read of tick \d+ was not ready after 4 animation frames \(limit 3\)/);
  });

  it('THROWS by name for buffered reads on a context without WebGL2', async () => {
    const p = fakePage({ webgl1: true });
    await expect(call(p, args('pbo'))).rejects.toThrow(/BUFFERED READ NEEDS WEBGL2/);
    const sync = await call(p, args('sync'));
    expect(sync.context).toBe('webgl');
    expectPaired(sync.captures[0]);
  });
});
