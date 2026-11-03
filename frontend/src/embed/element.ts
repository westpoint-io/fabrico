// `<fabrico-board name="demo_scene">`: one example board, run by its own player instance and drawn
// by the app's own renderer (`bootPixi`), read-only. The camera takes no pointer or wheel input,
// and the board's packet source has no way to send anything back to the player.
//
// Each board owns one Pixi Application, so one WebGL context. Teardown is `handle.stop()` then
// `handle.app.destroy(true)`: Pixi frees the context itself in `destroy`, and only removing the
// canvas would leave the context alive and counted against the browser's per-page limit.

import { createPacketPipeline } from '../render/packetPipeline';
import { fitToFactory } from '../render/camera';
import { bootPixi, type SceneHandle } from '../render/pixiApp';
import { instantiatePlayer, type BoardPlayer } from '../player/playerWasm';
import { createBoardClock, type BoardClock } from './controller';
import { beltRegion, type BoardProbe } from './probe';
import { boardText, compiledPlayer } from './registry';
import { createWasmPacketSource } from './wasmPacketSource';

/** The padding, in CSS px, between the board's machines and the stage edge. */
const FIT_INSET = 24;

const STAGE_CSS = `
:host { display: block; }
.stage {
  display: block;
  position: relative;
  width: 100%;
  aspect-ratio: 16 / 10;
  overflow: hidden;
}
.stage > canvas { display: block; }
`;

/** Everything a mounted board holds, dropped whole on disconnect. */
interface Mounted {
  handle: SceneHandle;
  player: BoardPlayer;
  clock: BoardClock;
  resize: ResizeObserver;
  frames: { n: number };
}

export class FabricoBoardElement extends HTMLElement {
  readonly #stage: HTMLDivElement;
  #mounted: Mounted | null = null;
  /** Bumped on every connect and disconnect, so a mount that finishes late knows it is stale. */
  #generation = 0;

  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = STAGE_CSS;
    this.#stage = document.createElement('div');
    this.#stage.className = 'stage';
    root.append(style, this.#stage);
  }

  connectedCallback(): void {
    const generation = ++this.#generation;
    void this.#mount(generation).catch((error: unknown) => {
      console.error(`fabrico-board "${this.#name()}" failed to start`, error);
    });
  }

  disconnectedCallback(): void {
    this.#generation += 1;
    this.#unmount();
  }

  /** A plain-data snapshot for tests. */
  fabricoProbe(): BoardProbe {
    const m = this.#mounted;
    if (m === null) {
      return {
        id: this.#name(),
        mounted: false,
        tick: 0,
        endTick: 0,
        playing: false,
        frames: 0,
        endHash: null,
        beltRegion: null,
      };
    }
    return {
      id: this.#name(),
      mounted: true,
      tick: m.player.tick(),
      endTick: m.player.endTick(),
      playing: m.clock.playing(),
      frames: m.frames.n,
      endHash: m.clock.endHash(),
      beltRegion: beltRegion(m.handle.sceneState, m.handle.cam, m.handle.app.canvas),
    };
  }

  #name(): string {
    return this.getAttribute('name') ?? '';
  }

  async #mount(generation: number): Promise<void> {
    const name = this.#name();
    const text = boardText(name);
    if (text === null) {
      this.#stage.textContent = `No example board is named "${name}".`;
      return;
    }
    const module = await instantiatePlayer(await compiledPlayer());
    if (generation !== this.#generation) return;
    const player = module.createBoard(text);
    let handle: SceneHandle;
    try {
      handle = await bootPixi(this.#stage, { interactive: false, resizeTo: this.#stage });
    } catch (error) {
      player.destroy();
      throw error;
    }
    if (generation !== this.#generation) {
      handle.stop();
      handle.app.destroy(true);
      player.destroy();
      return;
    }

    const pipeline = createPacketPipeline(() => handle.sceneState);
    const source = createWasmPacketSource(player);
    source.onPacket((bytes) => pipeline.handle(bytes));
    // The keyframe the player queued at create.
    source.drain();

    const fit = (): void => {
      const { width, height } = handle.app.screen;
      fitToFactory(handle.cam, handle.sceneState, width, height, {
        top: FIT_INSET,
        left: FIT_INSET,
        right: FIT_INSET,
        bottom: FIT_INSET,
      });
    };
    fit();
    // Pixi's `resizeTo` only re-reads the stage on a window resize, so watch the stage itself.
    const resize = new ResizeObserver(() => {
      handle.app.resize();
      fit();
    });
    resize.observe(this.#stage);

    const frames = { n: 0 };
    handle.app.ticker.add(() => {
      frames.n += 1;
    });

    const clock = createBoardClock({
      player,
      drain: () => {
        source.drain();
      },
      onFault: (error) => console.error(`fabrico-board "${name}" stopped`, error),
    });
    this.#mounted = { handle, player, clock, resize, frames };
    clock.start();
  }

  #unmount(): void {
    const m = this.#mounted;
    if (m === null) return;
    this.#mounted = null;
    m.clock.stop();
    m.resize.disconnect();
    // Tests count live WebGL contexts from outside the page; this marks a canvas being torn
    // down on purpose, so its context loss is not read as a fault.
    m.handle.app.canvas.setAttribute('data-fab-teardown', '');
    m.handle.stop();
    m.handle.app.destroy(true);
    try {
      m.player.destroy();
    } catch {
      // A trapped instance can take no more calls; it goes with the page.
    }
  }
}

if (customElements.get('fabrico-board') === undefined) {
  customElements.define('fabrico-board', FabricoBoardElement);
}
