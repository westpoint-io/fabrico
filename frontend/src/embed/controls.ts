// The control bar under a read-only board: Restart, Play/Pause, Step, the tick counter, the speed
// select and the hash badge. Plain DOM inside the board's shadow root. Every word is set with
// `textContent`, and the glyphs are the app's own SVG files read as text at build time.
//
// The bar binds no keyboard shortcut: several boards share one page, and a global key would
// collide with the other boards and with the page. Buttons take Tab, Enter and Space like any
// button.

import PAUSE_SVG from '../chrome/assets/pause.svg?raw';
import PLAY_SVG from '../chrome/assets/play.svg?raw';
import RESTART_SVG from '../chrome/assets/restart.svg?raw';
import STEP_SVG from '../chrome/assets/step.svg?raw';
import WARNING_SVG from '../chrome/assets/warning.svg?raw';
import { badgeText, badgeTitle, BADGE_LABEL, BADGE_PLACEHOLDER, BADGE_HASH_CHARS, isFailure, type BadgeState, type Verdict } from './badge';
import { SPEEDS, type Speed } from './controller';
import type { ManifestEntry } from './registry';

/** The glyph edge inside a control, CSS px (UI-SPEC: 16 px). */
export const GLYPH_PX = 16;

/** A tick with the app's `en-US` separators: 1204 reads `1,204`. */
export function formatTick(tick: number): string {
  return tick.toLocaleString('en-US');
}

/** The counter's text: `tick {current} / {end}`. */
export function tickText(tick: number, end: number): string {
  return `tick ${formatTick(tick)} / ${formatTick(end)}`;
}

/**
 * One of the chrome glyphs as an inline SVG element. The file's provenance comment sits before
 * the `<svg>` element, so taking the document element leaves it behind, and whitespace text nodes
 * are dropped so the glyph adds nothing to its control's `textContent`.
 */
export function glyph(raw: string, px = GLYPH_PX): SVGSVGElement {
  const doc = new DOMParser().parseFromString(raw, 'image/svg+xml');
  const svg = document.importNode(doc.documentElement, true) as unknown as SVGSVGElement;
  const walk = (node: Node): void => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === Node.TEXT_NODE && (child.textContent ?? '').trim() === '') {
        child.remove();
      } else if (child.nodeType === Node.COMMENT_NODE) {
        child.remove();
      } else {
        walk(child);
      }
    }
  };
  walk(svg);
  svg.setAttribute('width', String(px));
  svg.setAttribute('height', String(px));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  return svg;
}

/** Where the board is, as the bar needs to know it. */
export type BarState = 'loading' | 'running' | 'stopped' | 'error';

/** Everything the bar shows, read fresh from the board each update. */
export interface BarView {
  state: BarState;
  tick: number;
  endTick: number;
  bootTick: number;
  playing: boolean;
  /** A caption holds the board, so Play reads Continue. */
  holding: boolean;
  speed: Speed;
  badge: BadgeState;
  /** The board's manifest line, for the mismatch title. */
  entry: ManifestEntry | null;
}

export interface BarHandlers {
  onRestart(): void;
  onPlayPause(): void;
  onStep(): void;
  onSpeed(speed: Speed): void;
}

export interface ControlBar {
  root: HTMLDivElement;
  restart: HTMLButtonElement;
  play: HTMLButtonElement;
  step: HTMLButtonElement;
  speed: HTMLSelectElement;
  counter: HTMLSpanElement;
  badge: HTMLOutputElement;
  update(view: BarView): void;
}

function button(className: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = className;
  return b;
}

/** Set an attribute only when it changes, so a 60 Hz update writes nothing on most frames. */
function setAttr(el: Element, name: string, value: string): void {
  if (el.getAttribute(name) !== value) el.setAttribute(name, value);
}

function setText(el: Node, value: string): void {
  if (el.textContent !== value) el.textContent = value;
}

export function createControlBar(handlers: BarHandlers): ControlBar {
  const root = document.createElement('div');
  root.className = 'bar';
  root.setAttribute('role', 'toolbar');
  root.setAttribute('aria-label', 'Board controls');

  const transport = document.createElement('div');
  transport.className = 'group transport';
  const restart = button('fab-tool-btn');
  restart.dataset.control = 'restart';
  restart.append(glyph(RESTART_SVG));
  const play = button('fab-tool-btn');
  play.dataset.control = 'play';
  const playGlyph = glyph(PLAY_SVG);
  const pauseGlyph = glyph(PAUSE_SVG);
  play.append(playGlyph);
  const step = button('fab-tool-btn');
  step.dataset.control = 'step';
  step.append(glyph(STEP_SVG));
  setAttr(step, 'aria-label', 'Step one tick');
  setAttr(step, 'title', 'Step one tick');
  const counter = document.createElement('span');
  counter.className = 'counter';
  transport.append(restart, play, step, counter);

  const readout = document.createElement('div');
  readout.className = 'group readout';
  const speedLabel = document.createElement('label');
  speedLabel.className = 'speed-label';
  const speedWord = document.createElement('span');
  speedWord.textContent = 'speed';
  const speed = document.createElement('select');
  speed.className = 'fab-field';
  for (const s of SPEEDS) {
    const option = document.createElement('option');
    option.value = String(s);
    option.textContent = `${s}x`;
    if (s === 1) option.selected = true;
    speed.append(option);
  }
  speedLabel.append(speedWord, speed);

  const badge = document.createElement('output');
  badge.className = 'badge';
  badge.setAttribute('aria-live', 'polite');
  const badgeGlyph = glyph(WARNING_SVG);
  badgeGlyph.classList.add('badge-glyph');
  badgeGlyph.style.display = 'none';
  const badgeHash = document.createElement('span');
  badgeHash.className = 'badge-hash';
  badgeHash.textContent = `${BADGE_LABEL} ${BADGE_PLACEHOLDER}`;
  const badgeVerdict = document.createElement('span');
  badgeVerdict.className = 'badge-verdict';
  // The two words sit in one span, so the flex gap falls only between the glyph and the text.
  const badgeWords = document.createElement('span');
  badgeWords.className = 'badge-words';
  badgeWords.append(badgeHash, badgeVerdict);
  badge.append(badgeGlyph, badgeWords);
  readout.append(speedLabel, badge);

  root.append(transport, readout);

  restart.addEventListener('click', () => handlers.onRestart());
  play.addEventListener('click', () => handlers.onPlayPause());
  step.addEventListener('click', () => handlers.onStep());
  speed.addEventListener('change', () => {
    const picked = Number(speed.value) as Speed;
    if (SPEEDS.includes(picked)) handlers.onSpeed(picked);
  });

  let slotFor = -1;
  let lastVerdict: Verdict | null | undefined;

  const update = (view: BarView): void => {
    const live = view.state === 'running';
    const atEnd = live && view.tick >= view.endTick;
    restart.disabled = !(live || view.state === 'stopped');
    play.disabled = !live;
    step.disabled = !live || atEnd;
    speed.disabled = !live;

    const restartName = `Restart from tick ${formatTick(view.bootTick)}`;
    setAttr(restart, 'aria-label', restartName);
    setAttr(restart, 'title', restartName);

    const showPause = live && view.playing;
    if (showPause) {
      setAttr(play, 'aria-label', 'Pause');
      setAttr(play, 'title', 'Pause');
      play.classList.add('is-pressed');
      if (play.firstChild !== pauseGlyph) play.replaceChildren(pauseGlyph);
    } else if (live && view.holding) {
      setAttr(play, 'aria-label', 'Continue');
      setAttr(play, 'title', 'Continue');
      play.classList.remove('is-pressed');
      if (play.firstChild !== playGlyph) play.replaceChildren(playGlyph);
    } else {
      setAttr(play, 'aria-label', 'Play');
      setAttr(play, 'title', atEnd ? `Play again from tick ${formatTick(view.bootTick)}` : 'Play');
      play.classList.remove('is-pressed');
      if (play.firstChild !== playGlyph) play.replaceChildren(playGlyph);
    }

    if (view.state === 'loading' || view.state === 'error') {
      setText(counter, '');
    } else {
      // The slot is as wide as the widest string this board can show, so the bar never shifts.
      if (slotFor !== view.endTick) {
        slotFor = view.endTick;
        counter.style.minWidth = `${tickText(view.endTick, view.endTick).length}ch`;
      }
      setText(counter, tickText(view.tick, view.endTick));
    }
    if (String(view.speed) !== speed.value) speed.value = String(view.speed);

    const verdict = view.badge.hash === null ? null : view.badge.verdict;
    const full = badgeText(view.badge);
    const hashPart =
      verdict === null ? full : `${BADGE_LABEL} ${(view.badge.hash ?? '').slice(0, BADGE_HASH_CHARS)}`;
    setText(badgeHash, hashPart);
    // The space keeps the badge's textContent equal to badgeText() for screen readers and the
    // probe. The stylesheet collapses it, and the gap between the two words does the spacing, so a
    // verdict that wraps under the hash starts flush with it.
    setText(badgeVerdict, verdict === null ? '' : ` ${verdict}`);
    if (verdict !== lastVerdict) {
      lastVerdict = verdict;
      const failure = isFailure(verdict);
      badgeGlyph.style.display = failure ? '' : 'none';
      badge.classList.toggle('is-failure', failure);
      badge.dataset.verdict = verdict ?? '';
    }
    setAttr(badge, 'title', badgeTitle(verdict, view.entry));
  };

  return { root, restart, play, step, speed, counter, badge, update };
}
