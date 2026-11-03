// `<fabrico-board name="demo_scene">`: one example board, run by its own player instance and drawn
// by the app's own renderer (`bootPixi`), read-only. The camera takes no pointer or wheel input,
// the board's packet source has no way to send anything back to the player, and the element binds
// no key. The reader's only levers are the control bar's buttons and speed select, which reach the
// player through the tick clock: `step`, `restart` and read exports, nothing else.
//
// Layout, top to bottom inside a panel frame: the stage (the canvas, sized 16:10 to the element's
// width and clamped to 240 to 560 px, or to the `height` attribute) and the control bar. The stage
// holds its size while loading, so the page never shifts.
//
// Each board owns one Pixi Application, so one WebGL context. Teardown is `handle.stop()` then
// `handle.app.destroy(true)`: Pixi frees the context itself in `destroy`, and only removing the
// canvas would leave the context alive and counted against the browser's per-page limit.

import { createPacketPipeline } from '../render/packetPipeline';
import { fitToFactory } from '../render/camera';
import { bootPixi, type SceneHandle } from '../render/pixiApp';
import { instantiatePlayer, type BoardPlayer } from '../player/playerWasm';
import { verdictOf, type BadgeState } from './badge';
import { createBoardClock, type BoardClock, type Speed } from './controller';
import { createControlBar, type BarState, type ControlBar } from './controls';
import { beltRegion, tickHashes, type BoardProbe } from './probe';
import { boardText, compiledPlayer, manifestEntry } from './registry';
import { boardStylesheet, injectFonts } from './styles';
import { createWasmPacketSource } from './wasmPacketSource';

/** The padding, in CSS px, between the board's machines and the stage edge. */
const FIT_INSET = 24;

/** Did the page ask for per-tick hashes before the bundle ran? */
function traceRequested(): boolean {
  return (globalThis as { __FABRICO_EMBED_TRACE__?: unknown }).__FABRICO_EMBED_TRACE__ === true;
}

/** Everything a mounted board holds, dropped whole on disconnect. */
interface Mounted {
  handle: SceneHandle;
  player: BoardPlayer;
  clock: BoardClock;
  resize: ResizeObserver;
  frames: { n: number };
}

export class FabricoBoardElement extends HTMLElement {
  static get observedAttributes(): string[] {
    return ['height'];
  }

  readonly #stage: HTMLDivElement;
  readonly #status: HTMLDivElement;
  readonly #bar: ControlBar;
  #mounted: Mounted | null = null;
  #state: BarState = 'loading';
  #speed: Speed = 1;
  /** Bumped on every connect and disconnect, so a mount that finishes late knows it is stale. */
  #generation = 0;

  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = boardStylesheet(window.devicePixelRatio || 1);
    const frame = document.createElement('div');
    frame.className = 'frame fab-panel';
    this.#stage = document.createElement('div');
    this.#stage.className = 'stage';
    this.#status = document.createElement('div');
    this.#status.className = 'status';
    this.#stage.append(this.#status);
    this.#bar = createControlBar({
      onRestart: () => this.#mounted?.clock.restart(),
      onPlayPause: () => {
        const clock = this.#mounted?.clock;
        if (clock === undefined) return;
        if (clock.playing()) clock.pause();
        else clock.play();
      },
      onStep: () => this.#mounted?.clock.stepOne(),
      onSpeed: (speed) => this.#setSpeed(speed),
    });
    frame.append(this.#stage, this.#bar.root);
    root.append(style, frame);
    this.#applyHeight();
    this.#showLoading();
  }

  connectedCallback(): void {
    injectFonts();
    const generation = ++this.#generation;
    this.#state = 'loading';
    this.#showLoading();
    this.#refresh();
    void this.#mount(generation).catch((error: unknown) => {
      console.error(`fabrico-board "${this.#name()}" failed to start`, error);
    });
  }

  disconnectedCallback(): void {
    this.#generation += 1;
    this.#unmount();
  }

  attributeChangedCallback(name: string): void {
    if (name === 'height') this.#applyHeight();
  }

  /** A plain-data snapshot for tests. */
  fabricoProbe(): BoardProbe {
    const m = this.#mounted;
    const badge = this.#badgeState();
    const base = {
      id: this.#name(),
      state: this.#state === 'running' || this.#state === 'stopped' ? ('running' as const) : this.#state,
      speed: this.#speed,
      verdict: badge.verdict,
      badgeText: this.#bar.badge.textContent ?? '',
      error: null,
    };
    if (m === null) {
      return {
        ...base,
        mounted: false,
        tick: 0,
        endTick: 0,
        bootTick: 0,
        playing: false,
        frames: 0,
        endHash: null,
        cameraSnapshot: null,
        beltRegion: null,
      };
    }
    return {
      ...base,
      mounted: true,
      tick: m.player.tick(),
      endTick: m.player.endTick(),
      bootTick: m.clock.bootTick(),
      playing: m.clock.playing(),
      frames: m.frames.n,
      endHash: m.clock.endHash(),
      cameraSnapshot: m.handle.cameraSnapshot(),
      beltRegion: beltRegion(m.handle.sceneState, m.handle.cam, m.handle.app.canvas),
    };
  }

  /** Every tick and its hash since boot or the last restart, when the page asked for a trace. */
  fabricoTickHashes(): [number, string][] {
    return tickHashes(this.#mounted?.clock.tickHashes() ?? []);
  }

  #name(): string {
    return this.getAttribute('name') ?? '';
  }

  #applyHeight(): void {
    const raw = this.getAttribute('height');
    const px = raw === null ? NaN : Number(raw);
    if (Number.isFinite(px) && px > 0) {
      this.#stage.style.aspectRatio = 'auto';
      this.#stage.style.minHeight = '0';
      this.#stage.style.maxHeight = 'none';
      this.#stage.style.height = `${px}px`;
    } else {
      this.#stage.style.removeProperty('aspect-ratio');
      this.#stage.style.removeProperty('min-height');
      this.#stage.style.removeProperty('max-height');
      this.#stage.style.removeProperty('height');
    }
  }

  #showLoading(): void {
    const line = document.createElement('span');
    line.className = 'loading';
    line.textContent = 'Loading board';
    this.#status.replaceChildren(line);
    this.#status.hidden = false;
  }

  #hideStatus(): void {
    this.#status.replaceChildren();
    this.#status.hidden = true;
  }

  #badgeState(): BadgeState {
    const hash = this.#mounted?.clock.endHash() ?? null;
    if (hash === null) return { hash: null, verdict: null };
    return { hash, verdict: verdictOf(hash, manifestEntry(this.#name())) };
  }

  #setSpeed(speed: Speed): void {
    this.#speed = speed;
    const m = this.#mounted;
    if (m === null) return;
    m.clock.setSpeed(speed);
    m.handle.setRenderPace(speed);
  }

  /** Bring the control bar in line with the board. */
  #refresh(): void {
    const m = this.#mounted;
    this.#bar.update({
      state: this.#state,
      tick: m?.player.tick() ?? 0,
      endTick: m?.player.endTick() ?? 0,
      bootTick: m?.clock.bootTick() ?? 0,
      playing: m?.clock.playing() ?? false,
      speed: this.#speed,
      badge: this.#badgeState(),
      entry: manifestEntry(this.#name()),
    });
  }

  async #mount(generation: number): Promise<void> {
    const module = await instantiatePlayer(await compiledPlayer());
    if (generation !== this.#generation) return;
    // Looked up after the awaits, so a page script that registers a board right after the
    // bundle has run is in time.
    const name = this.#name();
    const text = boardText(name);
    if (text === null) {
      this.#state = 'error';
      this.#status.textContent = `No example board is named "${name}".`;
      this.#refresh();
      return;
    }
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
    const title = player.boardInfo().title || name;
    handle.app.canvas.setAttribute('role', 'img');
    handle.app.canvas.setAttribute('aria-label', `${title}, a running Fabrico board`);

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
      onChange: () => this.#refresh(),
      onFault: (error) => console.warn(`fabrico-board "${name}" stopped`, error),
      trace: traceRequested(),
    });
    clock.setSpeed(this.#speed);
    handle.setRenderPace(this.#speed);
    this.#mounted = { handle, player, clock, resize, frames };
    this.#state = 'running';
    this.#hideStatus();
    this.#refresh();
    clock.play();
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
