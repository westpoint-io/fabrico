// @vitest-environment jsdom
//
// The `<fabrico-board>` element against a stub player, a stub renderer and the real page
// scheduler logic. The browser specs in `e2e-embed/` drive the real player, which never traps on a
// bundled board, so the failure paths here (a trapped instance, a renderer that won't boot) are
// reached only through stubs.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlayerError, PlayerTrapped, type BoardInfo, type BoardPlayer, type CreateBoardOptions, type PlayerModule } from '../player/playerWasm';
import type { ScheduledBoard } from './scheduler';

const h = vi.hoisted(() => ({
  /** How many player modules the element instantiated. */
  modules: 0,
  createBoard: null as null | ((text: string, options?: CreateBoardOptions) => BoardPlayer),
  boot: null as null | ((stage: HTMLElement, opts: { scene: unknown }) => Promise<unknown>),
  texts: new Map<string, string>(),
  manifest: new Map<string, { endTick: number; hash: string }>(),
  core: null as null | {
    report(entries: readonly { board: ScheduledBoard; near: boolean }[]): void;
    isLive(board: ScheduledBoard): boolean;
  },
  added: [] as ScheduledBoard[],
  removed: [] as ScheduledBoard[],
  /** Make the label overlay throw, as a layer that fails after Pixi booted would. */
  labelsThrow: false,
}));

vi.mock('../player/playerWasm', async (importOriginal) => {
  const real = await importOriginal<typeof import('../player/playerWasm')>();
  return {
    ...real,
    instantiatePlayer: async (): Promise<PlayerModule> => {
      h.modules += 1;
      return { createBoard: (text, options) => h.createBoard!(text, options) };
    },
  };
});

vi.mock('./registry', () => ({
  boardText: (id: string) => h.texts.get(id) ?? null,
  bundledInfo: () => null,
  compiledPlayer: async () => ({}),
  manifestEntry: (id: string) => h.manifest.get(id) ?? null,
  onBoardRegistered: () => () => {},
  posterAlt: () => '',
  posterFor: () => null,
}));

vi.mock('./webgl', () => ({ hasWebGL: () => true, isWebGLRenderer: () => true }));
vi.mock('../render/camera', () => ({ fitToFactory: () => {} }));
vi.mock('../render/pixiApp', () => ({
  bootPixi: (stage: HTMLElement, opts: { scene: unknown }) => h.boot!(stage, opts),
}));
vi.mock('./captions', async (importOriginal) => {
  const real = await importOriginal<typeof import('./captions')>();
  return {
    ...real,
    createCaptionRing: (stage: HTMLElement) => {
      const root = document.createElement('div');
      stage.append(root);
      return { root, probe: () => null, missedRing: () => false };
    },
  };
});
vi.mock('./labelOverlay', () => ({
  createLabelOverlay: (stage: HTMLElement) => {
    if (h.labelsThrow) throw new Error('label layer failed');
    const root = document.createElement('div');
    stage.append(root);
    return { root, counts: () => ({ chips: 0, words: 0 }) };
  },
}));
vi.mock('./scheduler', async (importOriginal) => {
  const real = await importOriginal<typeof import('./scheduler')>();
  const core = real.createScheduler();
  h.core = core;
  const page = {
    add(board: ScheduledBoard) {
      h.added.push(board);
      core.add(board);
    },
    remove(board: ScheduledBoard) {
      h.removed.push(board);
      core.remove(board);
    },
    isLive: (board: ScheduledBoard) => core.isLive(board),
  };
  return { ...real, pageScheduler: () => page, pageIsHidden: () => false, prefersReducedMotion: () => false };
});

// After the mocks, so the element module reads them.
const { FabricoBoardElement } = await import('./element');

const HASH = 'ab'.repeat(32);

/** A player that runs `end` ticks, and traps on the step that reaches `trapAt`. */
class FakePlayer implements BoardPlayer {
  t = 0;
  end = 10;
  trapAt: number | null = null;
  trapped = false;
  /** Make `boardInfo` refuse, as a read after create that fails would. */
  infoThrows = false;
  destroyed = false;
  packets: Uint8Array[] = [];

  #check(): void {
    if (this.trapped) throw new PlayerTrapped(new WebAssembly.RuntimeError('unreachable'));
  }
  step(ticks: number): void {
    this.#check();
    if (this.trapAt !== null && this.t + ticks >= this.trapAt) {
      this.t = this.trapAt;
      this.trapped = true;
      throw new PlayerTrapped(new WebAssembly.RuntimeError('unreachable'));
    }
    this.t = Math.min(this.end, this.t + ticks);
  }
  takePacket(): Uint8Array | null {
    this.#check();
    return this.packets.shift() ?? null;
  }
  takeEffects(): Uint8Array {
    this.#check();
    return new Uint8Array([0]);
  }
  restart(): void {
    this.#check();
    this.t = 0;
  }
  tick(): number {
    this.#check();
    return this.t;
  }
  endTick(): number {
    this.#check();
    return this.end;
  }
  tickHash(): string {
    this.#check();
    return HASH;
  }
  boardInfo(): BoardInfo {
    this.#check();
    if (this.infoThrows) throw new PlayerError('board info failed');
    return { title: 'stub', endTick: this.end, captions: [], factories: [], callsOut: false };
  }
  destroy(): void {
    this.#check();
    this.destroyed = true;
  }
}

/** The renderer handle `bootPixi` would give, with only what the element touches. */
function fakeHandle(stage: HTMLElement, scene: unknown) {
  const canvas = document.createElement('canvas');
  stage.append(canvas);
  const destroy = vi.fn(() => canvas.remove());
  return {
    app: {
      canvas,
      screen: { width: 320, height: 200 },
      resize: () => {},
      ticker: { add: () => {} },
      destroy,
      renderer: { type: 1 },
    },
    stop: vi.fn(),
    setRenderPace: () => {},
    cam: { worldToScreen: (x: number, y: number) => ({ x, y }) },
    sceneState: scene,
    cameraSnapshot: () => ({ x: 0, y: 0, scale: 1 }),
  };
}

let frames: ((now: number) => void)[] = [];
let players: FakePlayer[] = [];
let handles: ReturnType<typeof fakeHandle>[] = [];

/** Run every animation frame queued so far, at `now`. */
function runFrames(now: number): void {
  const due = frames;
  frames = [];
  for (const cb of due) cb(now);
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  h.modules = 0;
  h.labelsThrow = false;
  h.added.length = 0;
  h.removed.length = 0;
  h.texts.clear();
  h.texts.set('stub', 'board text');
  h.manifest.clear();
  players = [];
  handles = [];
  frames = [];
  h.createBoard = () => {
    const p = new FakePlayer();
    players.push(p);
    return p;
  };
  h.boot = async (stage, opts) => {
    const handle = fakeHandle(stage, opts.scene);
    handles.push(handle);
    return handle;
  };
  vi.stubGlobal('requestAnimationFrame', (cb: (now: number) => void) => {
    frames.push(cb);
    return frames.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      disconnect(): void {}
    },
  );
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Put a board on the page and give it a slot. Returns the element and its scheduler entry. */
async function mountBoard(name = 'stub', attrs: Record<string, string> = {}) {
  const el = document.createElement('fabrico-board') as InstanceType<typeof FabricoBoardElement>;
  el.setAttribute('name', name);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.body.append(el);
  const slot = h.added[h.added.length - 1];
  h.core!.report([{ board: slot, near: true }]);
  await settle();
  return { el, slot };
}

function control(el: HTMLElement, name: string): HTMLButtonElement {
  return el.shadowRoot!.querySelector(`[data-control="${name}"]`) as HTMLButtonElement;
}

describe('a player that traps', () => {
  it('leaves the board stopped with only Restart enabled, and the probe still answers', async () => {
    const { el } = await mountBoard();
    expect(el.fabricoProbe().state).toBe('running');
    players[0].trapAt = 3;
    runFrames(0);
    // One second at 1x is 60 ticks due; the clock steps 10 at most (the end), and traps at 3.
    expect(() => runFrames(1000)).not.toThrow();

    const probe = el.fabricoProbe();
    expect(probe.state).toBe('error');
    expect(probe.error?.heading).toBe('ENGINE STOPPED');
    // The tick before the step that trapped: a trapped player can't say how far it got.
    expect(probe.tick).toBe(0);
    expect(probe.endTick).toBe(10);
    expect(probe.error?.body).toContain('stopped at tick 0');
    expect(probe.playing).toBe(false);
    expect(control(el, 'restart').disabled).toBe(false);
    expect(control(el, 'play').disabled).toBe(true);
    expect(control(el, 'step').disabled).toBe(true);
  });

  it('a trap from Step leaves the same stopped state and reaches no page error handler', async () => {
    const { el } = await mountBoard();
    const errors: unknown[] = [];
    const onError = (e: ErrorEvent): void => {
      errors.push(e.error);
      e.preventDefault();
    };
    window.addEventListener('error', onError);
    try {
      players[0].trapAt = 1;
      control(el, 'step').click();
    } finally {
      window.removeEventListener('error', onError);
    }
    expect(errors).toEqual([]);
    expect(el.fabricoProbe().error?.heading).toBe('ENGINE STOPPED');
    expect(control(el, 'restart').disabled).toBe(false);
    expect(control(el, 'step').disabled).toBe(true);
  });

  it('Restart loads a fresh player module and the board runs again', async () => {
    const { el } = await mountBoard();
    players[0].trapAt = 2;
    runFrames(0);
    runFrames(1000);
    expect(el.fabricoProbe().error?.heading).toBe('ENGINE STOPPED');
    expect(h.modules).toBe(1);

    control(el, 'restart').click();
    await settle();

    expect(h.modules).toBe(2);
    expect(players).toHaveLength(2);
    const probe = el.fabricoProbe();
    expect(probe.state).toBe('running');
    expect(probe.error).toBeNull();
    expect(probe.mounted).toBe(true);
    expect(probe.tick).toBe(0);
    // The old renderer went with the old player; one live view remains.
    expect(handles[0].app.destroy).toHaveBeenCalled();
    expect(handles).toHaveLength(2);
    // The new board autoplays like a Restart and runs to its end.
    runFrames(0);
    runFrames(1000);
    expect(el.fabricoProbe().tick).toBe(10);
    expect(el.fabricoProbe().endHash).toBe(HASH);
  });

  it('a trapped board that leaves the margin frees its slot', async () => {
    const { el, slot } = await mountBoard();
    players[0].trapAt = 2;
    runFrames(0);
    runFrames(1000);
    expect(h.core!.isLive(slot)).toBe(true);
    expect(() => h.core!.report([{ board: slot, near: false }])).not.toThrow();
    expect(h.core!.isLive(slot)).toBe(false);
    expect(el.fabricoProbe().mounted).toBe(false);
  });
});

describe('a board whose view or board part fails to boot', () => {
  it('a renderer that will not boot shows a card, frees the slot and destroys the player', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    h.boot = async () => {
      throw new Error('context refused');
    };
    const { el, slot } = await mountBoard();
    const probe = el.fabricoProbe();
    expect(probe.state).toBe('error');
    expect(probe.error?.heading).toBe('BOARD DID NOT DRAW');
    expect(probe.error?.body).toContain('context refused');
    expect(probe.mounted).toBe(false);
    expect(h.removed).toContain(slot);
    expect(h.core!.isLive(slot)).toBe(false);
    expect(players[0].destroyed).toBe(true);
    expect(control(el, 'restart').disabled).toBe(true);
  });

  it('a layer that throws after Pixi booted frees the renderer, its canvas and the slot', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    h.labelsThrow = true;
    const { el, slot } = await mountBoard();
    expect(handles).toHaveLength(1);
    expect(handles[0].app.destroy).toHaveBeenCalled();
    expect(handles[0].app.canvas.isConnected).toBe(false);
    expect(el.fabricoProbe().error?.heading).toBe('BOARD DID NOT DRAW');
    expect(h.core!.isLive(slot)).toBe(false);
  });

  it('a player read that fails after create destroys the player and shows the load card', async () => {
    h.createBoard = () => {
      const p = new FakePlayer();
      p.infoThrows = true;
      players.push(p);
      return p;
    };
    const { el, slot } = await mountBoard();
    const probe = el.fabricoProbe();
    expect(probe.state).toBe('error');
    expect(probe.error?.heading).toBe('BOARD DID NOT LOAD');
    expect(probe.error?.body).toContain('board info failed');
    expect(players[0].destroyed).toBe(true);
    expect(h.core!.isLive(slot)).toBe(false);
    expect(handles).toHaveLength(0);
  });
});
