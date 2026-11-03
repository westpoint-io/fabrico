// `<fabrico-board name="demo_scene">`: one example board, run by its own player instance and drawn
// by the app's own renderer (`bootPixi`), read-only. The camera takes no pointer or wheel input,
// the board's packet source has no way to send anything back to the player, and the element binds
// no key. The reader's only levers are the control bar's buttons and speed select, which reach the
// player through the tick clock: `step`, `restart` and read exports, nothing else.
//
// Layout, top to bottom inside a panel frame: the stage (the canvas, sized 16:10 to its column's
// width and clamped to 240 to 560 px, or to the `height` attribute), the caption strip (only on a
// board with captions), the control bar, and the effect log. A board with a Factory or an HTTP
// Handler also gets the code column: beside the stage (60/40, at least 280 px) when the element is
// 720 px or wider, and under the control bar at 240 px when it's narrower. The `no-code` attribute
// hides it. The stage holds its size while loading, behind an error card and after the engine
// stops. Over the canvas sit the caption ring and the label overlay (name chips and label words).
//
// States: `loading` until the player has booted the board (the stage says "Loading board" and
// every control is disabled), then `running`. A name with no board, an old board format or a
// board the player refuses puts an error card in the stage and leaves the controls disabled. An
// engine that stops mid-run puts its card over the last frame and leaves only Restart enabled.
//
// Each board owns one Pixi Application, so one WebGL context. Teardown is `handle.stop()` then
// `handle.app.destroy(true)`: Pixi frees the context itself in `destroy`, and only removing the
// canvas would leave the context alive and counted against the browser's per-page limit.

import { createPacketPipeline } from '../render/packetPipeline';
import { fitToFactory } from '../render/camera';
import { bootPixi, type SceneHandle } from '../render/pixiApp';
import { instantiatePlayer, type BoardFactory, type BoardPlayer } from '../player/playerWasm';
import { verdictOf, type BadgeState } from './badge';
import { createCaptionRing, createCaptionStrip, type CaptionRing, type CaptionStrip } from './captions';
import { createCodeView, type CodeView } from './codeView';
import { createEffectLog, rowsFromBytes, type EffectLog } from './effectLog';
import { createBoardClock, type BoardClock, type Speed } from './controller';
import { createControlBar, type BarState, type ControlBar } from './controls';
import { buildErrorCard, classifyPlayerError, errorCopy, unknownBoardCopy, type ErrorCopy } from './errors';
import { createLabelOverlay, type LabelOverlay } from './labelOverlay';
import { beltRegion, tickHashes, type BoardProbe } from './probe';
import { boardText, compiledPlayer, manifestEntry, onBoardRegistered } from './registry';
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
  labels: LabelOverlay;
  ring: CaptionRing;
}

export class FabricoBoardElement extends HTMLElement {
  static get observedAttributes(): string[] {
    return ['height', 'no-code'];
  }

  readonly #stage: HTMLDivElement;
  readonly #status: HTMLDivElement;
  readonly #bar: ControlBar;
  readonly #captions: CaptionStrip;
  readonly #frame: HTMLDivElement;
  readonly #code: CodeView;
  readonly #log: EffectLog;
  /** The board's Factories and Handlers, once it has booted. */
  #factories: BoardFactory[] = [];
  #mounted: Mounted | null = null;
  #state: BarState = 'loading';
  #speed: Speed = 1;
  /** The card the stage shows, or null. */
  #error: ErrorCopy | null = null;
  /** Stops listening for a page registering this board's name, when it found no board. */
  #stopWaiting: (() => void) | null = null;
  /** Bumped on every connect and disconnect, so a mount that finishes late knows it is stale. */
  #generation = 0;

  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = boardStylesheet(window.devicePixelRatio || 1);
    const frame = document.createElement('div');
    frame.className = 'frame fab-panel';
    this.#frame = frame;
    this.#stage = document.createElement('div');
    this.#stage.className = 'stage';
    this.#status = document.createElement('div');
    this.#status.className = 'status';
    this.#stage.append(this.#status);
    this.#bar = createControlBar({
      onRestart: () => this.#restart(),
      onPlayPause: () => {
        const clock = this.#mounted?.clock;
        if (clock === undefined) return;
        if (clock.playing()) clock.pause();
        else clock.play();
      },
      onStep: () => this.#mounted?.clock.stepOne(),
      onSpeed: (speed) => this.#setSpeed(speed),
    });
    this.#captions = createCaptionStrip();
    this.#code = createCodeView();
    this.#log = createEffectLog();
    // The stage and the code column share a row when the element is wide; when it's narrow the
    // row's box drops out of the layout (`display: contents`) and the code column moves under the
    // control bar by its flex order.
    const main = document.createElement('div');
    main.className = 'main';
    main.append(this.#stage, this.#code.root);
    frame.append(main, this.#captions.root, this.#bar.root, this.#log.root);
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
    this.#stopWaiting?.();
    this.#stopWaiting = null;
    this.#unmount();
  }

  attributeChangedCallback(name: string): void {
    if (name === 'height') this.#applyHeight();
    if (name === 'no-code') this.#applyCode();
  }

  /** A plain-data snapshot for tests. */
  fabricoProbe(): BoardProbe {
    const m = this.#mounted;
    const badge = this.#badgeState();
    const base = {
      id: this.#name(),
      state: this.#state === 'running' ? ('running' as const) : this.#state === 'loading' ? ('loading' as const) : ('error' as const),
      speed: this.#speed,
      verdict: badge.verdict,
      badgeText: this.#bar.badge.textContent ?? '',
      error: this.#error === null ? null : { ...this.#error },
      caption: this.#mounted?.ring.probe() ?? null,
      captionWithoutRing: this.#mounted?.ring.missedRing() ?? false,
      codeTabs: this.#code.root.hidden ? [] : this.#code.labels(),
      codeText: this.#code.root.hidden ? null : this.#code.text(),
      effectRows: [...this.#log.well.querySelectorAll('.row')].map((row) => ({
        cells: [...row.children].map((c) => c.textContent ?? ''),
        title: (row as HTMLElement).title,
      })),
      logScrollTop: this.#log.well.scrollTop,
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

  /** Show the code column for a board with a Factory or Handler, unless `no-code` is set. */
  #applyCode(): void {
    const show = this.#factories.length > 0 && !this.hasAttribute('no-code');
    this.#code.setFactories(show ? this.#factories : []);
    this.#frame.classList.toggle('has-code', show);
  }

  /** Move the effects the player recorded since the last call into the log. */
  #drainEffects(player: BoardPlayer): void {
    this.#log.append(rowsFromBytes(player.takeEffects()));
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
    this.#error = null;
  }

  /** Put an error card in the stage. `stopped` keeps Restart enabled; `error` disables all. */
  #showError(copy: ErrorCopy, state: 'error' | 'stopped'): void {
    this.#error = copy;
    this.#state = state;
    this.#status.replaceChildren(buildErrorCard(copy));
    this.#status.hidden = false;
    this.#refresh();
  }

  /** The engine stopped mid-run: its card over the last frame, Restart still enabled. */
  #onFault(name: string, error: unknown): void {
    const fault = this.#mounted?.clock.fault();
    const message = fault?.message ?? (error instanceof Error ? error.message : String(error));
    console.warn(`fabrico-board "${name}" stopped`, error);
    this.#showError(errorCopy(classifyPlayerError(message, 'step'), { message, tick: fault?.tick ?? 0 }), 'stopped');
  }

  #restart(): void {
    const m = this.#mounted;
    if (m === null) return;
    if (this.#state === 'stopped') {
      this.#hideStatus();
      this.#state = 'running';
    }
    m.clock.restart();
  }

  /** Wait for the page to register this name, then mount again. */
  #waitForRegistration(name: string): void {
    this.#stopWaiting?.();
    this.#stopWaiting = onBoardRegistered((id) => {
      if (id !== name || this.#name() !== name || !this.isConnected) return;
      this.#stopWaiting?.();
      this.#stopWaiting = null;
      const generation = ++this.#generation;
      this.#state = 'loading';
      this.#showLoading();
      this.#refresh();
      void this.#mount(generation).catch((error: unknown) => {
        console.error(`fabrico-board "${name}" failed to start`, error);
      });
    });
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
      holding: (m?.clock.caption() ?? null) !== null,
      speed: this.#speed,
      badge: this.#badgeState(),
      entry: manifestEntry(this.#name()),
    });
    if (m !== undefined && m !== null) this.#captions.update({ held: m.clock.caption(), last: m.clock.lastCaption() });
  }

  async #mount(generation: number): Promise<void> {
    const module = await instantiatePlayer(await compiledPlayer());
    if (generation !== this.#generation) return;
    // Looked up after the awaits, so a page script that registers a board right after the
    // bundle has run is in time.
    const name = this.#name();
    const text = boardText(name);
    if (text === null) {
      this.#showError(unknownBoardCopy(name), 'error');
      this.#waitForRegistration(name);
      return;
    }
    let player: BoardPlayer;
    try {
      player = module.createBoard(text);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#showError(errorCopy(classifyPlayerError(message, 'create'), { message, tick: 0 }), 'error');
      return;
    }
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
    const info = player.boardInfo();
    const title = info.title || name;
    handle.app.canvas.setAttribute('role', 'img');
    handle.app.canvas.setAttribute('aria-label', `${title}, a running Fabrico board`);

    const pipeline = createPacketPipeline(() => handle.sceneState);
    const source = createWasmPacketSource(player);
    source.onPacket((bytes) => pipeline.handle(bytes));
    // The keyframe the player queued at create.
    source.drain();
    this.#factories = info.factories;
    this.#applyCode();
    this.#log.clear();
    this.#log.setCallsOut(info.callsOut);
    this.#drainEffects(player);

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
        this.#drainEffects(player);
      },
      onRestart: () => this.#log.clear(),
      onChange: () => this.#refresh(),
      onFault: (error) => this.#onFault(name, error),
      trace: traceRequested(),
    });
    clock.setSpeed(this.#speed);
    handle.setRenderPace(this.#speed);
    // The ring layer sits under the labels, so a name chip stays readable over the ring's edge.
    const ring = createCaptionRing(this.#stage, handle, info.captions, () => clock.caption());
    const labels = createLabelOverlay(this.#stage, handle);
    this.#captions.setCaptions(info.captions);
    // The status layer (loading line, error cards) stays above the canvas and the labels.
    this.#stage.append(this.#status);
    this.#mounted = { handle, player, clock, resize, frames, labels, ring };
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
    m.labels.root.remove();
    m.ring.root.remove();
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
