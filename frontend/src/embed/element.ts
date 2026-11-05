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
// `name` picks the board. A page framework that reuses the element changes it in place, so a
// change on a connected board drops the board it loaded and loads the named one, as a disconnect
// and a connect would.
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
// and tears the view down with `handle.stop()` then `handle.app.destroy({ removeView: true })`:
// Pixi frees the context itself in `destroy`, and only removing the canvas would leave the
// context alive and counted against the browser's per-page limit. Not `destroy(true)`: `true`
// also clears Pixi's page-wide pools, which the other boards' renderers are still using, and the
// next board to draw from them throws (`Cannot read properties of null (reading 'clear')`). Coming back boots a new Pixi app on the kept
// scene (the player sends a keyframe only at create and restart) and plays on from the same tick
// if the board was playing.
//
// A bundled board's info (title, captions, code) is in the bundle from build time, so the code
// column and the caption strip are laid out at connect and the stage keeps its width when the
// player finishes loading.
//
// WAITING, LOST, HIDDEN, REDUCED MOTION. A board that comes near while all 8 slots are taken
// shows its poster with the page-cap line and mounts when another board leaves. When the browser
// takes back a mounted board's context (`webglcontextlost` on a canvas not marked for teardown),
// the board tears its renderer down, shows its poster with the lost-context line, and Play (or
// Restart or Step) boots a new renderer on the kept scene. A hidden tab pauses every playing
// board, and showing the tab resumes those. With `prefers-reduced-motion: reduce`, read at
// connect, a board loads paused with Play showing, and Restart leaves it paused.
//
// POSTERS. Each bundled board carries a PNG of its end tick, taken from the real renderer when the
// bundle was built. Without WebGL (`webgl.ts` checks before booting and again after) the poster
// fills the stage with its alt text, the line "This browser can't run WebGL..." takes the control
// bar's place, and the caption strip and effect log go, since nothing runs. When the browser can't
// compile or start the player module, the ENGINE DID NOT START card sits over the poster.

import { createPacketPipeline } from '../render/packetPipeline';
import { createSceneState, type SceneState } from '../render/sceneState';
import { fitToFactory } from '../render/camera';
import { bootPixi, type SceneHandle } from '../render/pixiApp';
import { instantiatePlayer, PlayerTrapped, type BoardFactory, type BoardInfo, type BoardPlayer } from '../player/playerWasm';
import { verdictOf, type BadgeState } from './badge';
import { createCaptionRing, createCaptionStrip, type CaptionRing, type CaptionStrip } from './captions';
import { createCodeView, type CodeView } from './codeView';
import { createEffectLog, rowsFromBytes, type EffectLog } from './effectLog';
import { createBoardClock, type BoardClock, type Speed } from './controller';
import { createControlBar, type BarState, type ControlBar } from './controls';
import {
  buildErrorCard,
  classifyPlayerError,
  drawingDidNotStartCopy,
  engineDidNotStartCopy,
  errorCopy,
  unknownBoardCopy,
  type ErrorCopy,
} from './errors';
import { createLabelOverlay, type LabelOverlay } from './labelOverlay';
import { beltTiles, overlayBoxes, tickHashes, type BoardProbe } from './probe';
import { boardText, bundledInfo, compiledPlayer, manifestEntry, onBoardRegistered, posterAlt, posterFor } from './registry';
import { pageIsHidden, pageScheduler, prefersReducedMotion, type ScheduledBoard } from './scheduler';
import { boardStylesheet, injectFonts } from './styles';
import { createWasmPacketSource } from './wasmPacketSource';
import { hasWebGL, isWebGLRenderer } from './webgl';

/** The padding, in CSS px, between the board's machines and the stage edge. */
const FIT_INSET = 24;

type BoardOrder = 'forward' | 'reversed';

/** The order strip's words for each `order` value. */
const ORDER_STRIP: Record<BoardOrder, string> = {
  forward: 'same-tick events in file order',
  reversed: 'same-tick events in reverse order',
};

/** The line that takes the control bar's place when the browser has no WebGL. */
export const NO_WEBGL_TEXT = "This browser can't run WebGL, so this is a still picture of the board at its last tick.";
/** The band over the poster while the board waits for one of the page's 8 slots. */
export const CAPPED_TEXT = 'Paused to save graphics memory. Scroll the boards above or below out of view to run this one.';
/** The band over the poster after the browser took the board's WebGL context. */
export const LOST_TEXT = "The browser took back this board's graphics. Press Play to redraw it.";
/** The same line for a board the page registered, which has no poster to show. */
export const NO_WEBGL_NO_POSTER_TEXT = "This browser can't run WebGL, so this board can't be shown here.";

/**
 * Free a board's Pixi app and its WebGL context. The canvas is marked first: tests count live
 * contexts from outside the page, and the mark tells a context freed on purpose from one the
 * browser took. `removeView` without Pixi's global release: the page's other boards share Pixi's
 * pools.
 */
function destroyRenderer(handle: SceneHandle): void {
  handle.app.canvas.setAttribute('data-fab-teardown', '');
  handle.stop();
  handle.app.destroy({ removeView: true });
}

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
    return ['height', 'no-code', 'name'];
  }

  readonly #stage: HTMLDivElement;
  readonly #status: HTMLDivElement;
  readonly #bar: ControlBar;
  readonly #captions: CaptionStrip;
  readonly #frame: HTMLDivElement;
  readonly #code: CodeView;
  readonly #log: EffectLog;
  readonly #orderStrip: HTMLParagraphElement;
  /** The poster and the band of words over it, above the canvas and below the status layer. */
  readonly #posterLayer: HTMLDivElement;
  /** Made the first time a poster shows, so a running board carries no img element. */
  #poster: HTMLImageElement | null = null;
  readonly #posterBand: HTMLParagraphElement;
  /** The line in the control bar's place when there's no WebGL. */
  readonly #noWebGLLine: HTMLParagraphElement;
  /** No WebGL here: the poster stands in for the board and nothing runs. */
  #noWebGL = false;
  /**
   * The board can't run here: the browser couldn't compile or start the player, or couldn't start
   * the board's renderer. Its card sits over the poster.
   */
  #engineFailed = false;
  /**
   * The board's player instance trapped. Every later call on it throws, so nothing reads it any
   * more, and Restart loads the board on a new instance instead of restarting this one.
   */
  #trapped = false;
  /** Waiting for one of the page's slots: the poster with the page-cap line. */
  #capped = false;
  /** The browser took this board's context: the poster with the lost-context line until Play. */
  #lost = false;
  /** Paused because the tab went into the background while it played; resumes when it's back. */
  #resumeOnShow = false;
  /** The reader prefers reduced motion, read at connect: load paused, and Restart stays paused. */
  #reducedMotion = false;
  /** What a control pressed on a lost board does once the new renderer is up. */
  #afterRedraw: ((board: Board) => void) | null = null;
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
    setCapped: (capped) => this.#setCapped(capped),
    setPageHidden: (hidden) => this.#setPageHidden(hidden),
  };
  #state: BarState = 'loading';
  #speed: Speed = 1;
  /** The card the stage shows, or null. */
  #error: ErrorCopy | null = null;
  /** Stops listening for a page registering this board's name, when it found no board. */
  #stopWaiting: (() => void) | null = null;
  /** Bumped on every connect and disconnect, so a mount that finishes late knows it is stale. */
  #generation = 0;
  /** Between connectedCallback and disconnectedCallback. */
  #connected = false;

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
    this.#posterLayer = document.createElement('div');
    this.#posterLayer.className = 'poster-layer';
    this.#posterLayer.hidden = true;
    this.#posterBand = document.createElement('p');
    this.#posterBand.className = 'poster-band';
    this.#posterBand.hidden = true;
    this.#posterLayer.append(this.#posterBand);
    this.#stage.append(this.#posterLayer, this.#status);
    this.#bar = createControlBar({
      onRestart: () => {
        if (this.#trapped) this.#reloadTrapped();
        else if (this.#lost) this.#redraw((b) => this.#restartBoard(b));
        else this.#restart();
      },
      onPlayPause: () => {
        if (this.#lost) {
          this.#redraw((b) => b.clock.play());
          return;
        }
        const clock = this.#live()?.clock;
        if (clock === undefined) return;
        if (clock.playing()) clock.pause();
        else clock.play();
      },
      onStep: () => {
        if (this.#lost) this.#redraw((b) => b.clock.stepOne());
        else this.#live()?.clock.stepOne();
      },
      onSpeed: (speed) => this.#setSpeed(speed),
    });
    this.#captions = createCaptionStrip();
    this.#code = createCodeView();
    this.#log = createEffectLog();
    this.#noWebGLLine = document.createElement('p');
    this.#noWebGLLine.className = 'no-webgl';
    this.#noWebGLLine.hidden = true;
    // The stage and the code column share a row when the element is wide; when it's narrow the
    // row's box drops out of the layout (`display: contents`) and the code column moves under the
    // control bar by its flex order.
    this.#orderStrip = document.createElement('p');
    this.#orderStrip.className = 'order-strip';
    this.#orderStrip.hidden = true;
    const main = document.createElement('div');
    main.className = 'main';
    main.append(this.#stage, this.#code.root);
    frame.append(this.#orderStrip, main, this.#captions.root, this.#bar.root, this.#noWebGLLine, this.#log.root);
    root.append(style, frame);
    this.#applyHeight();
    this.#showLoading();
  }

  connectedCallback(): void {
    this.#connected = true;
    injectFonts();
    this.#order = orderOf(this.getAttribute('order'));
    this.#orderStrip.hidden = this.#order === null;
    this.#orderStrip.textContent = this.#order === null ? '' : ORDER_STRIP[this.#order];
    this.#generation += 1;
    this.#wasPlaying = null;
    this.#capped = false;
    this.#lost = false;
    this.#resumeOnShow = false;
    this.#afterRedraw = null;
    this.#reducedMotion = prefersReducedMotion();
    this.#engineFailed = false;
    this.#frame.classList.remove('no-engine');
    this.#setNoWebGL(false);
    this.#state = 'loading';
    this.#layOut(bundledInfo(this.#name()));
    this.#showLoading();
    this.#refresh();
    if (!hasWebGL()) {
      this.#showNoWebGL();
      return;
    }
    pageScheduler().add(this.#slot);
  }

  disconnectedCallback(): void {
    this.#connected = false;
    this.#generation += 1;
    this.#stopWaiting?.();
    this.#stopWaiting = null;
    pageScheduler().remove(this.#slot);
    this.#inSlot = false;
    this.#run += 1;
    this.#teardownView();
    this.#dropBoard();
  }

  attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null): void {
    if (name === 'height') this.#applyHeight();
    if (name === 'no-code') this.#applyCode();
    // The badge, the poster and the probe read `name` live, so a board left running under a new
    // name would be graded against the other board's manifest line. Load the named board instead.
    // Before the first connect (an upgrade reports every attribute) there is nothing to reload.
    if (name === 'name' && oldValue !== newValue && this.#connected) {
      this.disconnectedCallback();
      this.connectedCallback();
    }
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
      noWebGL: this.#noWebGL,
      capped: this.#capped,
      lostShown: this.#lost && !this.#posterLayer.hidden,
      posterShown: !this.#posterLayer.hidden && this.#poster !== null && !this.#poster.hidden,
      posterAlt: this.#posterLayer.hidden || this.#poster === null || this.#poster.hidden ? null : this.#poster.alt,
      frames: b?.frames.n ?? 0,
      cameraSnapshot: v?.handle.cameraSnapshot() ?? null,
      beltTiles:
        v === null
          ? []
          : beltTiles(
              v.handle.sceneState,
              (x, y) => v.handle.cam.worldToScreen(x, y),
              v.handle.app.canvas.getBoundingClientRect(),
              { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight },
              overlayBoxes(this.#stage),
            ),
    };
    if (b === null) {
      return { ...base, tick: 0, endTick: 0, bootTick: 0, playing: false, endHash: null };
    }
    const { tick, endTick } = this.#ticks(b);
    return {
      ...base,
      tick,
      endTick,
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

  /** Show the poster layer when the board can't run (or isn't running) here, else hide it. */
  #syncPoster(): void {
    const show = this.#noWebGL || this.#engineFailed || this.#capped || this.#lost;
    const name = this.#name();
    const src = posterFor(name);
    this.#posterLayer.hidden = !show;
    if (!show) return;
    if (src === null) {
      if (this.#poster !== null) this.#poster.hidden = true;
    } else {
      if (this.#poster === null) {
        this.#poster = document.createElement('img');
        this.#poster.className = 'poster';
        this.#poster.decoding = 'async';
        this.#posterLayer.prepend(this.#poster);
      }
      if (this.#poster.getAttribute('src') !== src) this.#poster.src = src;
      this.#poster.alt = posterAlt(this.#board?.info ?? bundledInfo(name), name);
      this.#poster.hidden = false;
    }
    // The band explains a poster that stands in for a board that can run here.
    const band = this.#noWebGL || this.#engineFailed ? null : this.#capped ? CAPPED_TEXT : this.#lost ? LOST_TEXT : null;
    this.#posterBand.hidden = band === null;
    this.#posterBand.textContent = band ?? '';
  }

  /** Swap the running layout for the still one: no bar, strip or log, the WebGL line instead. */
  #setNoWebGL(on: boolean): void {
    this.#noWebGL = on;
    this.#frame.classList.toggle('is-still', on);
    this.#noWebGLLine.hidden = !on;
    this.#noWebGLLine.textContent = posterFor(this.#name()) === null ? NO_WEBGL_NO_POSTER_TEXT : NO_WEBGL_TEXT;
    this.#syncPoster();
  }

  /** No WebGL: the poster stands in for the board. The board leaves the scheduler for good. */
  #showNoWebGL(): void {
    pageScheduler().remove(this.#slot);
    this.#inSlot = false;
    this.#run += 1;
    this.#teardownView();
    this.#dropBoard();
    this.#hideStatus();
    this.#state = 'error';
    this.#setNoWebGL(true);
    this.#refresh();
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
    if (error instanceof PlayerTrapped) this.#trapped = true;
    console.warn(`fabrico-board "${name}" stopped`, error);
    this.#showError(errorCopy(classifyPlayerError(message, 'step'), { message, tick: fault?.tick ?? 0 }), 'stopped');
  }

  #restart(): void {
    const b = this.#live();
    if (b === null) return;
    this.#restartBoard(b);
  }

  /** Restart a board with a view: it plays again, unless the reader prefers reduced motion. */
  #restartBoard(b: Board): void {
    if (this.#trapped) {
      this.#reloadTrapped();
      return;
    }
    if (this.#state === 'stopped') {
      this.#hideStatus();
      this.#state = 'running';
    }
    b.clock.restart(!this.#reducedMotion);
  }

  /**
   * Restart a board whose player instance trapped. That instance takes no more calls, so the board
   * part goes with its renderer, and the board loads again on a new instance. The board keeps its
   * slot, and plays from its boot tick once loaded unless the reader prefers reduced motion, as
   * Restart does. Out of the margin, it loads when it next gets a slot.
   */
  #reloadTrapped(): void {
    this.#run += 1;
    this.#afterRedraw = null;
    this.#lost = false;
    this.#wasPlaying = null;
    this.#resumeOnShow = false;
    this.#teardownView();
    this.#dropBoard();
    this.#state = 'loading';
    this.#showLoading();
    this.#error = null;
    this.#syncPoster();
    this.#refresh();
    if (!this.#inSlot) return;
    const generation = this.#generation;
    const run = ++this.#run;
    void this.#mountView(generation, run).catch((error: unknown) => this.#onMountFailed(generation, run, 'restart', error));
  }

  /** Waiting on the page cap, or not any more. */
  #setCapped(capped: boolean): void {
    if (this.#capped === capped) return;
    this.#capped = capped;
    // The band says why the board waits; the loading line would only repeat it.
    if (this.#state === 'loading') {
      if (capped) this.#hideStatus();
      else this.#showLoading();
    }
    this.#syncPoster();
    this.#refresh();
  }

  /** The tab went into the background, or came back. */
  #setPageHidden(hidden: boolean): void {
    const b = this.#board;
    if (hidden) {
      if (b !== null && this.#view !== null && b.clock.playing()) {
        this.#resumeOnShow = true;
        b.clock.pause();
      }
      return;
    }
    if (!this.#resumeOnShow) return;
    this.#resumeOnShow = false;
    if (b !== null && this.#view !== null && !b.clock.playing()) b.clock.play();
  }

  /** Play the board unless the tab is in the background; then play it when the tab comes back. */
  #playOrWait(b: Board): void {
    if (pageIsHidden()) this.#resumeOnShow = true;
    else b.clock.play();
  }

  /** The browser took this board's context while it was mounted. */
  #onLost(): void {
    const b = this.#board;
    if (this.#view === null || b === null) return;
    this.#wasPlaying = b.clock.playing() || this.#resumeOnShow;
    this.#resumeOnShow = false;
    b.clock.pause();
    this.#teardownView();
    this.#lost = true;
    this.#syncPoster();
    this.#refresh();
  }

  /** Boot a new renderer for a lost board, then do what the pressed control asked. */
  #redraw(then: (board: Board) => void): void {
    if (!this.#inSlot || this.#view !== null) return;
    this.#lost = false;
    this.#afterRedraw = then;
    this.#syncPoster();
    const generation = this.#generation;
    const run = ++this.#run;
    void this.#mountView(generation, run).catch((error: unknown) => this.#onMountFailed(generation, run, 'redraw', error));
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

  /**
   * The board's tick and end tick. A trapped player can't answer, so those come from the tick the
   * clock recorded at the fault and the end tick the board booted with.
   */
  #ticks(b: Board): { tick: number; endTick: number } {
    if (!this.#trapped) {
      try {
        return { tick: b.player.tick(), endTick: b.player.endTick() };
      } catch {
        // Fall through to what the board part already knows.
      }
    }
    return { tick: b.clock.fault()?.tick ?? b.clock.bootTick(), endTick: b.info.endTick };
  }

  /** Bring the control bar in line with the board. */
  #refresh(): void {
    const b = this.#board;
    // Controls act only on a board with a view; while it loads, or sits out of view, they wait.
    // A lost board keeps its controls: pressing one draws it again.
    const waiting = b !== null && this.#view === null && this.#state === 'running' && !this.#lost;
    const state = waiting ? 'loading' : this.#state;
    const ticks = b === null ? null : this.#ticks(b);
    this.#bar.update({
      state,
      tick: ticks?.tick ?? 0,
      // The bundled info's end tick sizes the tick counter's slot before the player loads.
      endTick: ticks?.endTick ?? bundledInfo(this.#name())?.endTick ?? 0,
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
    void this.#mountView(generation, run).catch((error: unknown) => this.#onMountFailed(generation, run, 'start', error));
  }

  /**
   * A view boot threw: in Pixi's own init, in a layer set up after it, or in loading the board.
   * The boot has already freed what it held. The board gives up its slot so a waiting board can
   * have it, drops its player, and shows its card over the poster. A boot that a leave or a
   * disconnect already made stale changes nothing.
   */
  #onMountFailed(generation: number, run: number, what: string, error: unknown): void {
    console.error(`fabrico-board "${this.#name()}" failed to ${what}`, error);
    if (generation !== this.#generation || run !== this.#run) return;
    pageScheduler().remove(this.#slot);
    this.#inSlot = false;
    this.#run += 1;
    this.#afterRedraw = null;
    this.#lost = false;
    this.#teardownView();
    this.#dropBoard();
    this.#engineFailed = true;
    this.#frame.classList.add('no-engine');
    this.#syncPoster();
    this.#showError(drawingDidNotStartCopy(error instanceof Error ? error.message : String(error)), 'error');
  }

  /** The board left the margin: pause, remember whether it played, and free the WebGL context. */
  #onLeave(): void {
    this.#inSlot = false;
    this.#run += 1;
    this.#afterRedraw = null;
    if (this.#lost) {
      // It comes back with a new renderer anyway, playing if it was when the context went.
      this.#lost = false;
      this.#syncPoster();
    }
    const b = this.#board;
    if (this.#view === null || b === null) return;
    this.#wasPlaying = b.clock.playing() || this.#resumeOnShow;
    this.#resumeOnShow = false;
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
    let module: Awaited<ReturnType<typeof instantiatePlayer>>;
    try {
      module = await instantiatePlayer(await compiledPlayer());
    } catch (error) {
      if (generation !== this.#generation) return null;
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`fabrico-board "${this.#name()}" engine did not start`, error);
      pageScheduler().remove(this.#slot);
      this.#engineFailed = true;
      // Nothing will run, so the caption strip's opening line and the empty log would mislead.
      this.#frame.classList.add('no-engine');
      this.#syncPoster();
      this.#showError(engineDidNotStartCopy(reason), 'error');
      return null;
    }
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
    // Everything after create can still throw: a read the player refuses, a trap, or effect bytes
    // that don't decode. The player is destroyed then, so its instance doesn't outlive the card.
    try {
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
    } catch (error) {
      try {
        player.destroy();
      } catch {
        // A trapped instance can take no more calls; it goes with the page.
      }
      const message = error instanceof Error ? error.message : String(error);
      const kind = classifyPlayerError(message, 'create');
      // Nothing ran yet, so this is a board that didn't load, even when the player trapped.
      const copy = errorCopy(kind.kind === 'engine-stopped' ? { kind: 'load-failed' } : kind, { message, tick: 0 });
      this.#showError(copy, 'error');
      pageScheduler().remove(this.#slot);
      return null;
    }
  }

  /** Boot a Pixi app on the board's kept scene and put the layers over it. */
  async #mountView(generation: number, run: number): Promise<void> {
    const board = await this.#loadBoard(generation);
    if (board === null || !this.#current(generation, run) || this.#view !== null) return;
    // Pixi falls back to WebGPU or a canvas renderer rather than failing, so ask first.
    if (!hasWebGL()) {
      this.#showNoWebGL();
      return;
    }
    const handle = await bootPixi(this.#stage, { interactive: false, resizeTo: this.#stage, scene: board.scene });
    const dispose = (): void => destroyRenderer(handle);
    if (!this.#current(generation, run) || this.#view !== null) {
      dispose();
      return;
    }
    // And check what Pixi picked: a board on any renderer other than WebGL shows its poster.
    if (!isWebGLRenderer(handle.app)) {
      dispose();
      this.#showNoWebGL();
      return;
    }
    // Pixi is up and holds a WebGL context from here. A throw before the view is kept frees the
    // renderer and whatever layers were made, or the context would stay counted against the page.
    const made: { resize?: ResizeObserver; ring?: CaptionRing; labels?: LabelOverlay } = {};
    let view: View;
    try {
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
      made.resize = resize;
      resize.observe(this.#stage);
      handle.app.ticker.add(() => {
        board.frames.n += 1;
      });
      handle.setRenderPace(this.#speed);
      // The ring layer sits under the labels, so a name chip stays readable over the ring's edge.
      const ring = createCaptionRing(this.#stage, handle, board.info.captions, () => board.clock.caption());
      made.ring = ring;
      // A context the browser takes: the teardown marker tells it apart from one this board frees.
      handle.app.canvas.addEventListener('webglcontextlost', (event) => {
        const canvas = event.target as HTMLCanvasElement;
        if (canvas.hasAttribute('data-fab-teardown') || this.#view?.handle !== handle) return;
        this.#onLost();
      });
      const labels = createLabelOverlay(this.#stage, handle);
      made.labels = labels;
      view = { handle, resize, labels, ring };
    } catch (error) {
      made.resize?.disconnect();
      made.ring?.root.remove();
      made.labels?.root.remove();
      dispose();
      throw error;
    }
    // The poster layer and the status layer (loading line, error cards) stay above the canvas and
    // the labels.
    this.#stage.append(this.#posterLayer, this.#status);
    this.#view = view;
    if (this.#state === 'loading') {
      this.#state = 'running';
      this.#hideStatus();
    }
    const after = this.#afterRedraw;
    this.#afterRedraw = null;
    if (after !== null) {
      // A control pressed on a lost board: its action, now that the board draws again.
      after(board);
    } else if (!board.started) {
      board.started = true;
      // A reader who prefers reduced motion starts each board with Play.
      if (!this.#reducedMotion) this.#playOrWait(board);
    } else if (this.#wasPlaying === true) {
      this.#playOrWait(board);
    }
    board.started = true;
    this.#refresh();
  }

  /** Free the WebGL context and the layers over it. The board part stays. */
  #teardownView(): void {
    const v = this.#view;
    if (v === null) return;
    this.#view = null;
    v.resize.disconnect();
    destroyRenderer(v.handle);
    v.labels.root.remove();
    v.ring.root.remove();
  }

  /** Drop the board part on disconnect. A later connect loads the board afresh. */
  #dropBoard(): void {
    const b = this.#board;
    if (b === null) return;
    this.#board = null;
    this.#trapped = false;
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
