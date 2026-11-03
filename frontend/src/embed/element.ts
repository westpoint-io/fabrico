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
// `order="forward"` or `order="reversed"`, read at connect, loads the board with its same-tick
// inputs in file order or turned round, and shows a one-line order strip at the top of the frame.
// Any other value is treated as absent. Two boards on one page, one of each, are the "run it
// twice" pair: a board whose run doesn't depend on arrival order shows the same hash on both at
// every tick.
//
// States: `loading` until the player has booted the board (the stage says "Loading board" and
// every control is disabled), then `running`. A name with no board, an old board format or a
// board the player refuses puts an error card in the stage and leaves the controls disabled. An
// engine that stops mid-run puts its card over the last frame and leaves only Restart enabled.
//
// MOUNTING. The page's scheduler (`scheduler.ts`) decides when a board holds a renderer: while it
// is within 200 px of the viewport and one of the page's 8 slots is free. A board has two parts.
// The board part (its player, its scene, its tick clock) lives from connect to disconnect. The
// view part (one Pixi Application, so one WebGL context, plus the label and ring layers) lives
// only while the board holds a slot. Leaving pauses the clock, remembers whether it was playing,
// and tears the view down with `handle.stop()` then `handle.app.destroy(true)`: Pixi frees the
// context itself in `destroy`, and only removing the canvas would leave the context alive and
// counted against the browser's per-page limit. Coming back boots a new Pixi app on the kept
// scene (the player sends a keyframe only at create and restart) and plays on from the same tick
// if the board was playing.
//
// A bundled board's info (title, captions, code) is in the bundle from build time, so the code
// column and the caption strip are laid out at connect and the stage keeps its width when the
// player finishes loading.

import { createPacketPipeline } from '../render/packetPipeline';
import { createSceneState, type SceneState } from '../render/sceneState';
import { fitToFactory } from '../render/camera';
import { bootPixi, type SceneHandle } from '../render/pixiApp';
import { instantiatePlayer, type BoardFactory, type BoardInfo, type BoardPlayer } from '../player/playerWasm';
import { verdictOf, type BadgeState } from './badge';
import { createCaptionRing, createCaptionStrip, type CaptionRing, type CaptionStrip } from './captions';
import { createCodeView, type CodeView } from './codeView';
import { createEffectLog, rowsFromBytes, type EffectLog } from './effectLog';
import { createBoardClock, type BoardClock, type Speed } from './controller';
import { createControlBar, type BarState, type ControlBar } from './controls';
import { buildErrorCard, classifyPlayerError, errorCopy, unknownBoardCopy, type ErrorCopy } from './errors';
import { createLabelOverlay, type LabelOverlay } from './labelOverlay';
import { beltRegion, tickHashes, type BoardProbe } from './probe';
import { boardText, bundledInfo, compiledPlayer, manifestEntry, onBoardRegistered } from './registry';
import { pageScheduler, type ScheduledBoard } from './scheduler';
import { boardStylesheet, injectFonts } from './styles';
import { createWasmPacketSource } from './wasmPacketSource';

/** The padding, in CSS px, between the board's machines and the stage edge. */
const FIT_INSET = 24;

type BoardOrder = 'forward' | 'reversed';

/** The order strip's words for each `order` value. */
const ORDER_STRIP: Record<BoardOrder, string> = {
  forward: 'same-tick events in file order',
  reversed: 'same-tick events in reverse order',
};

/** `forward` or `reversed`; any other value, or none, is null. */
function orderOf(value: string | null): BoardOrder | null {
  return value === 'forward' || value === 'reversed' ? value : null;
}

/** Did the page ask for per-tick hashes before the bundle ran? */
function traceRequested(): boolean {
  return (globalThis as { __FABRICO_EMBED_TRACE__?: unknown }).__FABRICO_EMBED_TRACE__ === true;
}

/** The board part: lives from connect to disconnect, across any number of mounts. */
interface Board {
  player: BoardPlayer;
  info: BoardInfo;
  /** The scene the packets build. Each new Pixi app draws this same object. */
  scene: SceneState;
  clock: BoardClock;
  /** Pixi ticker callbacks across every mount, for the probe. */
  frames: { n: number };
  /** Has the board been mounted and started once? The first mount autoplays. */
  started: boolean;
}

/** The view part: one Pixi Application and the layers over it, while the board holds a slot. */
interface View {
  handle: SceneHandle;
  resize: ResizeObserver;
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
  readonly #orderStrip: HTMLParagraphElement;
  /** The order the board was loaded in, read at connect, or null without the attribute. */
  #order: BoardOrder | null = null;
  /** The board's Factories and Handlers, once it has booted. */
  #factories: BoardFactory[] = [];
  #board: Board | null = null;
  #view: View | null = null;
  /** True while the scheduler has given this board a slot. */
  #inSlot = false;
  /** Bumped on every slot grant and leave, so a view boot that finishes late knows it is stale. */
  #run = 0;
  /** Whether the board was playing when it last left; null before it ever left. */
  #wasPlaying: boolean | null = null;
  /** What the page scheduler sees of this board. */
  readonly #slot: ScheduledBoard = {
    element: this,
    mount: () => this.#onSlot(),
    unmount: () => this.#onLeave(),
    setCapped: () => {},
  };
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
        const clock = this.#live()?.clock;
        if (clock === undefined) return;
        if (clock.playing()) clock.pause();
        else clock.play();
      },
      onStep: () => this.#live()?.clock.stepOne(),
      onSpeed: (speed) => this.#setSpeed(speed),
    });
    this.#captions = createCaptionStrip();
    this.#code = createCodeView();
    this.#log = createEffectLog();
    // The stage and the code column share a row when the element is wide; when it's narrow the
    // row's box drops out of the layout (`display: contents`) and the code column moves under the
    // control bar by its flex order.
    this.#orderStrip = document.createElement('p');
    this.#orderStrip.className = 'order-strip';
    this.#orderStrip.hidden = true;
    const main = document.createElement('div');
    main.className = 'main';
    main.append(this.#stage, this.#code.root);
    frame.append(this.#orderStrip, main, this.#captions.root, this.#bar.root, this.#log.root);
    root.append(style, frame);
    this.#applyHeight();
    this.#showLoading();
  }

  connectedCallback(): void {
    injectFonts();
    this.#order = orderOf(this.getAttribute('order'));
    this.#orderStrip.hidden = this.#order === null;
    this.#orderStrip.textContent = this.#order === null ? '' : ORDER_STRIP[this.#order];
    this.#generation += 1;
    this.#wasPlaying = null;
    this.#state = 'loading';
    this.#layOut(bundledInfo(this.#name()));
    this.#showLoading();
    this.#refresh();
    pageScheduler().add(this.#slot);
  }

  disconnectedCallback(): void {
    this.#generation += 1;
    this.#stopWaiting?.();
    this.#stopWaiting = null;
    pageScheduler().remove(this.#slot);
    this.#inSlot = false;
    this.#run += 1;
    this.#teardownView();
    this.#dropBoard();
  }

  attributeChangedCallback(name: string): void {
    if (name === 'height') this.#applyHeight();
    if (name === 'no-code') this.#applyCode();
  }

  /** A plain-data snapshot for tests. */
  fabricoProbe(): BoardProbe {
    const b = this.#board;
    const v = this.#view;
    const badge = this.#badgeState();
    const base = {
      id: this.#name(),
      state: this.#state === 'running' ? ('running' as const) : this.#state === 'loading' ? ('loading' as const) : ('error' as const),
      speed: this.#speed,
      verdict: badge.verdict,
      badgeText: this.#bar.badge.textContent ?? '',
      error: this.#error === null ? null : { ...this.#error },
      caption: v?.ring.probe() ?? null,
      captionWithoutRing: v?.ring.missedRing() ?? false,
      codeTabs: this.#code.root.hidden ? [] : this.#code.labels(),
      codeText: this.#code.root.hidden ? null : this.#code.text(),
      effectRows: [...this.#log.well.querySelectorAll('.row')].map((row) => ({
        cells: [...row.children].map((c) => c.textContent ?? ''),
        title: (row as HTMLElement).title,
      })),
      logScrollTop: this.#log.well.scrollTop,
      orderStrip: this.#orderStrip.hidden ? null : this.#orderStrip.textContent,
      mounted: v !== null,
      wasPlaying: this.#wasPlaying,
      frames: b?.frames.n ?? 0,
      cameraSnapshot: v?.handle.cameraSnapshot() ?? null,
      beltRegion: v === null ? null : beltRegion(v.handle.sceneState, v.handle.cam, v.handle.app.canvas),
    };
    if (b === null) {
      return { ...base, tick: 0, endTick: 0, bootTick: 0, playing: false, endHash: null };
    }
    return {
      ...base,
      tick: b.player.tick(),
      endTick: b.player.endTick(),
      bootTick: b.clock.bootTick(),
      playing: b.clock.playing(),
      endHash: b.clock.endHash(),
    };
  }

  /** Every tick and its hash since boot or the last restart, when the page asked for a trace. */
  fabricoTickHashes(): [number, string][] {
    return tickHashes(this.#board?.clock.tickHashes() ?? []);
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

  /**
   * Lay the panels out from a board's info: the code column, the caption strip and the effect
   * log's empty line. Called at connect with the info the bundle carries, so the layout is final
   * before the player loads, and again with the player's own info once it has.
   */
  #layOut(info: BoardInfo | null): void {
    this.#factories = info?.factories ?? [];
    this.#applyCode();
    this.#captions.setCaptions(info?.captions ?? []);
    this.#log.clear();
    this.#log.setCallsOut(info?.callsOut ?? false);
  }

  /** The board, when it has a view to play on. Controls act only then. */
  #live(): Board | null {
    return this.#view === null ? null : this.#board;
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
    const fault = this.#board?.clock.fault();
    const message = fault?.message ?? (error instanceof Error ? error.message : String(error));
    console.warn(`fabrico-board "${name}" stopped`, error);
    this.#showError(errorCopy(classifyPlayerError(message, 'step'), { message, tick: fault?.tick ?? 0 }), 'stopped');
  }

  #restart(): void {
    const b = this.#live();
    if (b === null) return;
    if (this.#state === 'stopped') {
      this.#hideStatus();
      this.#state = 'running';
    }
    b.clock.restart();
  }

  /** Wait for the page to register this name, then mount again. */
  #waitForRegistration(name: string): void {
    this.#stopWaiting?.();
    this.#stopWaiting = onBoardRegistered((id) => {
      if (id !== name || this.#name() !== name || !this.isConnected) return;
      this.#stopWaiting?.();
      this.#stopWaiting = null;
      this.#generation += 1;
      this.#state = 'loading';
      this.#showLoading();
      this.#refresh();
      // Back in the scheduler, which reports the board at once and mounts it when it is near.
      pageScheduler().add(this.#slot);
    });
  }

  #badgeState(): BadgeState {
    const hash = this.#board?.clock.endHash() ?? null;
    if (hash === null) return { hash: null, verdict: null };
    return { hash, verdict: verdictOf(hash, manifestEntry(this.#name())) };
  }

  #setSpeed(speed: Speed): void {
    this.#speed = speed;
    this.#board?.clock.setSpeed(speed);
    this.#view?.handle.setRenderPace(speed);
  }

  /** Bring the control bar in line with the board. */
  #refresh(): void {
    const b = this.#board;
    // Controls act only on a board with a view; while it loads, or sits out of view, they wait.
    const state = b !== null && this.#view === null && this.#state === 'running' ? 'loading' : this.#state;
    this.#bar.update({
      state,
      tick: b?.player.tick() ?? 0,
      // The bundled info's end tick sizes the tick counter's slot before the player loads.
      endTick: b?.player.endTick() ?? bundledInfo(this.#name())?.endTick ?? 0,
      bootTick: b?.clock.bootTick() ?? 0,
      playing: b?.clock.playing() ?? false,
      holding: (b?.clock.caption() ?? null) !== null,
      speed: this.#speed,
      badge: this.#badgeState(),
      entry: manifestEntry(this.#name()),
    });
    if (b !== null) this.#captions.update({ held: b.clock.caption(), last: b.clock.lastCaption() });
  }

  /** The scheduler gave this board a slot. */
  #onSlot(): void {
    this.#inSlot = true;
    const generation = this.#generation;
    const run = ++this.#run;
    void this.#mountView(generation, run).catch((error: unknown) => {
      console.error(`fabrico-board "${this.#name()}" failed to start`, error);
    });
  }

  /** The board left the margin: pause, remember whether it played, and free the WebGL context. */
  #onLeave(): void {
    this.#inSlot = false;
    this.#run += 1;
    const b = this.#board;
    if (this.#view === null || b === null) return;
    this.#wasPlaying = b.clock.playing();
    b.clock.pause();
    this.#teardownView();
    this.#refresh();
  }

  /** Is a view boot for this connect and this slot grant still wanted? */
  #current(generation: number, run: number): boolean {
    return generation === this.#generation && run === this.#run && this.#inSlot;
  }

  /**
   * Load the board part once per connect: the player, its info, the scene and the clock. Returns
   * null after showing the card for a board that can't load.
   */
  async #loadBoard(generation: number): Promise<Board | null> {
    if (this.#board !== null) return this.#board;
    const module = await instantiatePlayer(await compiledPlayer());
    if (generation !== this.#generation) return null;
    if (this.#board !== null) return this.#board;
    // Looked up after the awaits, so a page script that registers a board right after the
    // bundle has run is in time.
    const name = this.#name();
    const text = boardText(name);
    if (text === null) {
      this.#showError(unknownBoardCopy(name), 'error');
      pageScheduler().remove(this.#slot);
      this.#waitForRegistration(name);
      return null;
    }
    let player: BoardPlayer;
    try {
      player = module.createBoard(text, { order: this.#order ?? 'forward' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#showError(errorCopy(classifyPlayerError(message, 'create'), { message, tick: 0 }), 'error');
      pageScheduler().remove(this.#slot);
      return null;
    }
    const info = player.boardInfo();
    const scene = createSceneState();
    const pipeline = createPacketPipeline(() => scene);
    const source = createWasmPacketSource(player);
    source.onPacket((bytes) => pipeline.handle(bytes));
    // The keyframe the player queued at create, into the kept scene.
    source.drain();
    this.#layOut(info);
    this.#drainEffects(player);
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
    this.#board = { player, info, scene, clock, frames: { n: 0 }, started: false };
    return this.#board;
  }

  /** Boot a Pixi app on the board's kept scene and put the layers over it. */
  async #mountView(generation: number, run: number): Promise<void> {
    const board = await this.#loadBoard(generation);
    if (board === null || !this.#current(generation, run) || this.#view !== null) return;
    const handle = await bootPixi(this.#stage, { interactive: false, resizeTo: this.#stage, scene: board.scene });
    if (!this.#current(generation, run) || this.#view !== null) {
      handle.app.canvas.setAttribute('data-fab-teardown', '');
      handle.stop();
      handle.app.destroy(true);
      return;
    }
    const title = board.info.title || this.#name();
    handle.app.canvas.setAttribute('role', 'img');
    handle.app.canvas.setAttribute('aria-label', `${title}, a running Fabrico board`);

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
    handle.app.ticker.add(() => {
      board.frames.n += 1;
    });
    handle.setRenderPace(this.#speed);
    // The ring layer sits under the labels, so a name chip stays readable over the ring's edge.
    const ring = createCaptionRing(this.#stage, handle, board.info.captions, () => board.clock.caption());
    const labels = createLabelOverlay(this.#stage, handle);
    // The status layer (loading line, error cards) stays above the canvas and the labels.
    this.#stage.append(this.#status);
    this.#view = { handle, resize, labels, ring };
    if (this.#state === 'loading') {
      this.#state = 'running';
      this.#hideStatus();
    }
    if (!board.started) {
      board.started = true;
      board.clock.play();
    } else if (this.#wasPlaying === true) {
      board.clock.play();
    }
    this.#refresh();
  }

  /** Free the WebGL context and the layers over it. The board part stays. */
  #teardownView(): void {
    const v = this.#view;
    if (v === null) return;
    this.#view = null;
    v.resize.disconnect();
    // Tests count live WebGL contexts from outside the page; this marks a canvas being torn
    // down on purpose, so its context loss is not read as a fault.
    v.handle.app.canvas.setAttribute('data-fab-teardown', '');
    v.handle.stop();
    v.handle.app.destroy(true);
    v.labels.root.remove();
    v.ring.root.remove();
  }

  /** Drop the board part on disconnect. A later connect loads the board afresh. */
  #dropBoard(): void {
    const b = this.#board;
    if (b === null) return;
    this.#board = null;
    b.clock.stop();
    try {
      b.player.destroy();
    } catch {
      // A trapped instance can take no more calls; it goes with the page.
    }
  }
}

if (customElements.get('fabrico-board') === undefined) {
  customElements.define('fabrico-board', FabricoBoardElement);
}
