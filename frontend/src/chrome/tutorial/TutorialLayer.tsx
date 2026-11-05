// TutorialLayer.tsx - the React side of the lesson engine.
//
// It reads the board and the chrome once a frame and hands them to the pure reducer. Its one way
// of changing the board is the `doNewThen` prop: the tutorial asks the host for a new board and
// never holds the transport, so it can't place a machine or finish a step for the user. Progress goes
// through a `ProgressStore` and stays on this machine.

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type JSX, type MutableRefObject, type RefObject } from 'react';
import { MIN_ZOOM } from '../../render/camera';
import type { SceneHandle } from '../../render/pixiApp';
import { sceneSnapshot } from '../../render/sceneState';
import { LESSONS } from '../../tutorial/lessons';
import { IDLE, currentStage, noteTokens, reduce, rowViews, stageKey, viewKey, type Card, type RowAction, type TutorialEvent, type TutorialState } from '../../tutorial/machine';
import { coachLine, noteFor, type NoteView } from '../../tutorial/note';
import { phrasePlain } from '../../tutorial/phrase';
import { localStorageProgress, withLessonDone, withLessonStarted, type ProgressStore } from '../../tutorial/progress';
import type { BindingName, BoardFacts, ChromeFacts, LessonId, PhraseToken, PortRoleName, Stage } from '../../tutorial/types';
import { frameTarget, offScreen as rectOffScreen } from '../../tutorial/view';
import type { ArmedTool } from '../Palette';
import { CLIENT_REFUSAL_COPY, REFUSAL_COPY } from '../RefusalMessage';
import { moveCamera, readCamera } from './cameraRead';
import { HintPointer, type HintTarget } from './HintPointer';
import { LESSONS_PANEL_ID, LessonPanel, focusListClose, type ResetFooter } from './LessonPanel';
import { StepCard, type StepCardView } from './StepCard';
import { readAppliedTrigger } from './triggerRead';

export interface HintRect {
  x: number;
  y: number;
  width: number;
  height: number;
  shape: 'square' | 'circle';
  /** A disc only: the centre of the hit circle its inner edge sits on, in window px. */
  hitCentre?: { x: number; y: number };
  /** A disc only: that circle's radius in CSS px, as the ring painted it this frame. */
  hitRadiusPx?: number;
}

/** What `window.__fabrico.tutorial()` answers: a fresh plain object per call, with nothing live in it. */
export interface TutorialProbe {
  lessonId: string | null;
  card: Card;
  stepIndex: number;
  stepCount: number;
  stepId: string | null;
  stageId: string | null;
  hint: HintRect | null;
  hintTo: HintRect | null;
  bound: Record<string, number>;
  /** The card note slot's kind (`refusal` or a lesson note's kind), or empty when the slot is empty. */
  noteKind: string;
  /** The words of a note that shows, or empty when the slot is empty or hidden. */
  noteText: string;
  /** Is the stage's ring (for a drag, either ring) out of the free area? Never for a panel target. */
  offScreen: boolean;
}

/** The facts the last frame used. */
interface FrameFacts {
  board: BoardFacts;
  chrome: ChromeFacts;
}

/** A ring's shape, by the rule HintPointer paints with: a disc on an In port, a square on anything else. */
function shapeOf(role: PortRoleName | null): HintRect['shape'] {
  return role === 'in' ? 'circle' : 'square';
}

/** A ring element's rect, and for a disc the hit circle it was painted around. */
function rectOf(el: HTMLElement, shape: HintRect['shape']): HintRect {
  const r = el.getBoundingClientRect();
  const rect: HintRect = { x: r.x, y: r.y, width: r.width, height: r.height, shape };
  const hitR = el.getAttribute('data-fab-hit-r');
  if (shape === 'circle' && hitR !== null) {
    rect.hitCentre = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    rect.hitRadiusPx = Number(hitR);
  }
  return rect;
}

/**
 * The ring's rect, only if the ring was last placed for `key`. A stage change reaches the ring a
 * frame after the state, and until then its rect belongs to the old stage, so a rect in a probe read
 * always belongs to the stage named in that same read.
 */
function ringRectFor(key: string, shape: HintRect['shape']): HintRect | null {
  const ring = document.querySelector<HTMLElement>('[data-fab-hint]');
  if (ring === null || ring.getAttribute('data-fab-hint-stage') !== key) return null;
  return rectOf(ring, shape);
}

/** The drag's far ring, under the same comparison: the ring records the stage both were written for. */
function ringToRectFor(key: string, shape: HintRect['shape']): HintRect | null {
  const ring = document.querySelector<HTMLElement>('[data-fab-hint]');
  const to = document.querySelector<HTMLElement>('[data-fab-hint-to]');
  if (ring === null || to === null || ring.getAttribute('data-fab-hint-stage') !== key) return null;
  return rectOf(to, shape);
}

/**
 * The stage's board rings as painted this frame: the main ring, and for a drag the far ring too. Null
 * when the stage marks a panel or nothing, or the ring wasn't last placed for `key`.
 */
function boardRingRects(stage: Stage, key: string): DOMRect[] | null {
  const hint = stage.hint;
  if (hint === null || hint.on === 'panel') return null;
  const ring = document.querySelector<HTMLElement>('[data-fab-hint]');
  if (ring === null || ring.getAttribute('data-fab-hint-stage') !== key) return null;
  const rects = [ring.getBoundingClientRect()];
  if (hint.on === 'port' && hint.to !== undefined) {
    const to = document.querySelector<HTMLElement>('[data-fab-hint-to]');
    if (to === null) return null;
    rects.push(to.getBoundingClientRect());
  }
  return rects;
}

/**
 * This frame's off-screen flag. A panel target or no target is never out of view. A board ring not yet
 * placed for the shown stage keeps the last value, because its rect still belongs to the old stage.
 */
function offScreenNow(stage: Stage | null, key: string | null, free: ChromeFacts['view']['freeArea'], last: boolean): boolean {
  if (stage === null || key === null || stage.hint === null || stage.hint.on === 'panel') return false;
  const rects = boardRingRects(stage, key);
  if (rects === null) return last;
  return rects.some((r) => rectOffScreen(r, free));
}

function probeOf(s: TutorialState, facts: FrameFacts | null, refusal: RefusalRecord | null, offScreen: boolean): TutorialProbe {
  const lesson = LESSONS.find((l) => l.id === s.lessonId) ?? null;
  const bound: Record<string, number> = {};
  for (const [name, node] of Object.entries(s.bindings)) {
    if (node !== undefined) bound[name] = node.id;
  }
  const stage = facts === null ? null : currentStage(s, facts.board, facts.chrome, LESSONS);
  const slot = s.card === 'running' && stage !== null ? noteViewOf(s, stage, refusal, offScreen).slot : null;
  return {
    lessonId: s.lessonId,
    card: s.card,
    stepIndex: s.stepIndex,
    stepCount: lesson?.steps.length ?? 0,
    stepId: lesson?.steps[s.stepIndex]?.id ?? null,
    stageId: stage?.id ?? null,
    hint: stage === null ? null : ringRectFor(stageKey(s.stepIndex, stage.id), shapeOf(stage.hint?.on === 'port' ? stage.hint.role : null)),
    hintTo:
      stage?.hint?.on === 'port' && stage.hint.to !== undefined
        ? ringToRectFor(stageKey(s.stepIndex, stage.id), shapeOf(stage.hint.to.role))
        : null,
    bound,
    noteKind: slot?.kind ?? '',
    noteText: slot === null || slot.hidden ? '' : phrasePlain(slot.tokens),
    offScreen: s.card === 'running' && offScreen,
  };
}

/** The probe before the layer mounts: no lesson. */
export function idleTutorialProbe(): TutorialProbe {
  return probeOf(IDLE, null, null, false);
}

/** The shared dock offset, the top of the panels on the right. */
const FREE_AREA_TOP_PX = 116;
/** The window's right edge less `--fab-space-lg`. */
const FREE_AREA_RIGHT_INSET_PX = 24;
/** The inspector's padding on both sides, and a gap so a machine beside it isn't touching it. */
const INSPECTOR_CHROME_PX = 2 * 22 + 8;

/**
 * The inspector opens at step 3 and stays open while the belt is drawn, so a spot chosen as if it
 * weren't there puts the Sink under it, with the belt's release point out of reach. This is the panel's
 * own `min(420px, 33vw)`, kept free from the start. It's the width whether or not the panel is open,
 * so the two spots don't depend on which step the panel opened at.
 */
function inspectorReservePx(): number {
  return Math.min(420, 0.33 * window.innerWidth) + INSPECTOR_CHROME_PX;
}

/**
 * The part of the window no panel covers or will cover: right of the palette, left of where the
 * inspector opens, under the toolbar, above the card.
 */
function readFreeArea(): ChromeFacts['view']['freeArea'] {
  const dock = document.querySelector<HTMLElement>('[data-fab-left-dock]');
  const card = document.querySelector<HTMLElement>('[data-fab-step-card]');
  return {
    left: dock === null ? 0 : dock.getBoundingClientRect().right,
    right: window.innerWidth - FREE_AREA_RIGHT_INSET_PX - inspectorReservePx(),
    top: FREE_AREA_TOP_PX,
    bottom: card === null ? window.innerHeight : card.getBoundingClientRect().top,
  };
}

/** The gap between the card's right edge and the open inspector's left edge. */
const CARD_INSPECTOR_GAP_PX = 8;

/**
 * The card's left edge in its container's px while the open inspector meets the card's centred place,
 * or null for centred. The card keeps its width, so its right edge sits 8 px short of the inspector; at
 * 1024 wide that puts it over the palette's lower rows, which UI-SPEC "Card placement" accepts. The
 * inspector is found by its heading, because the camera cluster carries `[data-fab-corner-dock]` too.
 * Help hides the inspector with `display: none`, which reads as an empty rect, so the card is centred
 * again. Only x depends on this, and the centred place is worked out from the container and the card's
 * width, never the card's current x, so the shift can't feed back into itself.
 */
function readCardLeft(): number | null {
  const card = document.querySelector<HTMLElement>('[data-fab-step-card]');
  const inspector = document.querySelector<HTMLElement>('aside[aria-labelledby="fab-config-heading"]');
  if (card === null || inspector === null) return null;
  const ins = inspector.getBoundingClientRect();
  if (ins.width === 0 || ins.height === 0) return null;
  const box = card.getBoundingClientRect();
  const parent = card.offsetParent;
  const host = parent === null ? { left: 0, width: window.innerWidth } : parent.getBoundingClientRect();
  const centredLeft = host.left + (host.width - box.width) / 2;
  const meets = ins.left < centredLeft + box.width && ins.right > centredLeft && ins.top < box.bottom && ins.bottom > box.top;
  if (!meets) return null;
  return ins.left - CARD_INSPECTOR_GAP_PX - box.width - host.left;
}

/**
 * A refusal the app showed while a stage was on the card: its tag, and the `stageKey` of the stage it
 * landed on. It stays until that stage or step changes or the next refusal replaces it, with no timer.
 */
export interface RefusalRecord {
  tag: string;
  at: string;
}

/** The host and client sentences by tag, as one lookup. The two tag sets don't overlap. */
const BAND_COPY: Readonly<Record<string, string>> = { ...REFUSAL_COPY, ...CLIENT_REFUSAL_COPY };

/**
 * What the card says about a refusal at this stage: the lesson's coaching line for the tag if the stage
 * has one, otherwise the band's own sentence, so a refusal during a lesson always gets words on the
 * card. A tag in neither table gives nothing, never the word "undefined". Own keys only, so a tag
 * can't match an inherited name.
 */
function refusalWords(stage: Stage, tag: string): readonly PhraseToken[] | null {
  const coached = coachLine(stage, tag);
  if (coached !== null) return coached;
  return Object.hasOwn(BAND_COPY, tag) ? [BAND_COPY[tag] as string] : null;
}

/** The running card's note slot and off-screen row, by `noteFor`'s one rule. */
function noteViewOf(s: TutorialState, stage: Stage, refusal: RefusalRecord | null, offScreen: boolean): NoteView {
  const pending = refusal !== null && refusal.at === stageKey(s.stepIndex, stage.id) ? refusalWords(stage, refusal.tag) : null;
  return noteFor({
    refusal: pending,
    offScreen,
    lessonNote: s.note === null ? null : { kind: s.note.kind, tokens: noteTokens(s.note) },
  });
}

/** What the card shows, or null when it has nothing to show. */
function cardViewOf(
  s: TutorialState,
  stage: Stage | null,
  refusal: RefusalRecord | null,
  offScreen: boolean,
  drawing: boolean,
): StepCardView | null {
  if (s.card === 'starting') return { state: 'starting' };
  if (s.card === 'swapped') return { state: 'swapped' };
  const lesson = LESSONS.find((l) => l.id === s.lessonId);
  if (s.card === 'finished' && lesson !== undefined) return { state: 'finished', text: lesson.closing };
  if (s.card !== 'running' || stage === null) return null;
  const running = { state: 'running', stepNumber: s.stepIndex + 1, stepCount: lesson?.steps.length ?? 0, text: stage.text } as const;
  const { slot, row } = noteViewOf(s, stage, refusal, offScreen);
  const flags = { offScreen: row, drawing };
  if (slot === null) return { ...running, ...flags, note: null, noteKind: '', noteHidden: false };
  return { ...running, ...flags, note: slot.tokens, noteKind: slot.kind, noteHidden: slot.hidden };
}

/** A store over this browser's `localStorage`, which a locked-down webview can refuse just by being read. */
function browserProgress(): ProgressStore {
  let storage: Storage | null = null;
  try {
    storage = localStorage;
  } catch {
    // No storage means no saved progress, and the lessons still run.
  }
  return localStorageProgress(storage, LESSONS.map((l) => l.id));
}

/**
 * Where focus goes when the list closes. With no lesson on screen it's the toolbar's Help button, the
 * way back to the list. During a lesson it's the page, because the card asks for keys such as Space
 * and the board stands down for a focused button, so Space would press Help and the board would stay paused.
 */
export function handFocusBackFromList(lessonOnScreen: boolean): void {
  if (!lessonOnScreen) {
    document.querySelector<HTMLElement>('button[aria-label="Help"]')?.focus();
    return;
  }
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
}

/** How often the layer asks the host for the bound Source's trigger: slower than a person presses Apply. */
export const TRIGGER_POLL_MS = 400;

/** The binding the lesson's trigger step asks about. Null when the lesson has no such step. */
function triggerWatch(s: TutorialState): BindingName | null {
  const steps = LESSONS.find((l) => l.id === s.lessonId)?.steps ?? [];
  const done = steps.find((step) => step.done.is === 'triggerApplied')?.done;
  return done?.is === 'triggerApplied' ? done.of : null;
}

/** The pressed segment of the inspector's Trigger group: the unapplied buffer, read from the DOM. */
function readTriggerPressed(): ChromeFacts['triggerPressed'] {
  const text = document.querySelector('[role="group"][aria-label="Trigger"] button[aria-pressed="true"]')?.textContent?.trim();
  return text === 'Webhook' || text === 'Timer' ? text : null;
}

export interface TutorialLayerProps {
  handleRef: RefObject<SceneHandle | null>;
  armed: ArmedTool | null;
  selectedNode: number | null;
  playing: boolean;
  lessonsOpen: boolean;
  onLessonsOpenChange: (open: boolean) => void;
  /** New, behind the same unsaved-work question. `onSent` runs only if New really went out. */
  doNewThen: (onSent?: () => void) => void;
  probeRef: MutableRefObject<() => TutorialProbe>;
  /**
   * App calls this with the tag of each host or client refusal it shows, so the card can say why the gesture was
   * refused. The layer fills it while mounted. It only reads the tag: nothing goes back to the host.
   */
  refusalRef: MutableRefObject<((tag: string) => void) | null>;
  /**
   * App calls this last in its Escape chain, after a draw, a tool, a selection and the welcome card. The layer
   * fills it while mounted. It closes an open lesson list, else a finished card (as Keep building) or a swapped
   * card (as Leave), and does nothing to a running or starting card.
   */
  escapeRef: MutableRefObject<(() => void) | null>;
  /** Tells App a lesson is on screen, so the empty-floor text stands down. */
  onActiveChange: (active: boolean) => void;
  /** False on a stopped or disconnected simulation: the ring hides, and the card keeps its text. */
  boardLive: boolean;
  /** New can't reach a stopped host, so Start and Restart say so. */
  simStopped: boolean;
  /** Has the app sent a draw or a dock the board doesn't show yet, or does it still owe one? */
  readEditsInFlight: () => boolean;
  /** Is a belt draw held? Show me waits for it to end. A read with no effect. */
  readBeltDrawInFlight: () => boolean;
}

export function TutorialLayer({
  handleRef,
  armed,
  selectedNode,
  playing,
  lessonsOpen,
  onLessonsOpenChange,
  doNewThen,
  probeRef,
  refusalRef,
  escapeRef,
  onActiveChange,
  boardLive,
  simStopped,
  readEditsInFlight,
  readBeltDrawInFlight,
}: TutorialLayerProps): JSX.Element {
  // The ref is the truth, and the probe reads it, so a test sees every value `reduce` returns.
  // React state follows only so the panel and the ring can mount and unmount.
  const stateRef = useRef<TutorialState>(IDLE);
  const [state, setState] = useState<TutorialState>(IDLE);
  // The stage can change with the chrome while the lesson state stands still, for example when a tool
  // arms. The stages are constants, so setting the same one each frame costs no render.
  const [stage, setStage] = useState<Stage | null>(null);
  const factsRef = useRef<FrameFacts | null>(null);
  // The last refusal shown on a stage. The ref is what the frame loop compares; the state renders it.
  const refusalRecordRef = useRef<RefusalRecord | null>(null);
  const [refusal, setRefusal] = useState<RefusalRecord | null>(null);
  // Is the shown stage's ring out of view? Worked out every frame into the ref; React state follows
  // only when it flips, so a pan costs no render until the ring crosses the free area's edge.
  const offScreenRef = useRef(false);
  const [offScreen, setOffScreen] = useState(false);
  // Is a belt draw held? The same pattern: read each frame, state only on a flip.
  const drawingRef = useRef(false);
  const [drawing, setDrawing] = useState(false);
  // The card's left edge while the open inspector meets its centred place. The same pattern again.
  const cardLeftRef = useRef<number | null>(null);
  const [cardLeft, setCardLeft] = useState<number | null>(null);
  const targetRef = useRef<HintTarget | null>(null);
  const paintRingRef = useRef<(() => void) | null>(null);
  // The host's last answer about the bound Source's trigger. The frame loop reads only this.
  const appliedRef = useRef<ChromeFacts['appliedTrigger']>(null);
  // The frame loop below outlives any one render, so it reads the chrome's props through this.
  const chromeRef = useRef({ armed, selectedNode, playing });
  chromeRef.current = { armed, selectedNode, playing };
  const readEditsInFlightRef = useRef(readEditsInFlight);
  readEditsInFlightRef.current = readEditsInFlight;
  const readBeltDrawInFlightRef = useRef(readBeltDrawInFlight);
  readBeltDrawInFlightRef.current = readBeltDrawInFlight;
  const boardLiveRef = useRef(boardLive);
  boardLiveRef.current = boardLive;
  const progressRef = useRef<ProgressStore | null>(null);
  progressRef.current ??= browserProgress();
  const progress = progressRef.current;
  // The Lessons panel's Reset progress footer. Closing the list, from anywhere, drops the question and
  // the "Progress cleared." line, so the next open starts at rest. Set during render, which React allows
  // for state that follows a prop, so the panel never paints a stale footer.
  const [footer, setFooter] = useState<ResetFooter>('rest');
  if (!lessonsOpen && footer !== 'rest') setFooter('rest');
  // Which footer button takes focus once the press that changed the footer has rendered.
  const footerFocusRef = useRef<'keep' | 'reset' | null>(null);

  // THE TRIGGER READ, from the moment the Source is bound. A Timer applied before its step comes up
  // has to be known when that step does, so the step finishes in the same pass and the note says so.
  // It's async, so it runs on a timer and the frame loop reads the ref, because a query per frame is
  // what the Route sweep in App.tsx warns against. It reads and enqueues nothing, so the simulation
  // can't tell it ran.
  const watch = triggerWatch(state);
  const watchedNode = watch !== null && state.card === 'running' ? (state.bindings[watch]?.id ?? null) : null;
  useEffect(() => {
    if (watchedNode === null) return undefined;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const read = async (): Promise<void> => {
      try {
        const applied = await readAppliedTrigger(watchedNode);
        if (!disposed) appliedRef.current = applied;
      } catch {
        // A query that fails says nothing about the trigger, so the last answer stands.
      }
      if (!disposed) timer = setTimeout(() => void read(), TRIGGER_POLL_MS);
    };
    void read();
    return () => {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [watchedNode]);

  useLayoutEffect(() => {
    probeRef.current = () => probeOf(stateRef.current, factsRef.current, refusalRecordRef.current, offScreenRef.current);
    return () => {
      probeRef.current = idleTutorialProbe;
    };
  }, [probeRef]);

  const clearRefusal = useCallback((): void => {
    if (refusalRecordRef.current === null) return;
    refusalRecordRef.current = null;
    setRefusal(null);
  }, []);

  // A refusal counts only while a running card shows a stage, and it is pinned to that stage.
  useLayoutEffect(() => {
    refusalRef.current = (tag: string): void => {
      const s = stateRef.current;
      const facts = factsRef.current;
      if (s.card !== 'running' || facts === null) return;
      const shown = currentStage(s, facts.board, facts.chrome, LESSONS);
      if (shown === null) return;
      const record = { tag, at: stageKey(s.stepIndex, shown.id) };
      // A quiet repeat on the same stage changes nothing, so the card's text node stays and the polite
      // live region doesn't announce it again.
      const held = refusalRecordRef.current;
      if (held !== null && held.tag === record.tag && held.at === record.at) return;
      refusalRecordRef.current = record;
      setRefusal(record);
    };
    return () => {
      refusalRef.current = null;
    };
  }, [refusalRef]);

  const active = state.card !== 'none';
  useLayoutEffect(() => {
    onActiveChange(active);
  }, [active, onActiveChange]);
  // ONE LOOP, RING FIRST, so each frame paints the ring from the last frame's target and only then
  // works out the lesson. A reader that starts later reads the probe after both, which is the frame
  // a stale rect would show under a new stage. Two separate animation-frame loops can't hold that
  // order: StrictMode re-runs a newly mounted child's effect after its parent's, which in a dev build
  // put the ring's loop behind this one, so the stale frame the walk has to see never happened there.
  useLayoutEffect(() => {
    if (!active) return undefined;
    let raf = 0;
    const frame = (): void => {
      paintRingRef.current?.();
      const handle = handleRef.current;
      const camera = readCamera();
      if (handle !== null && camera !== null) {
        const board = sceneSnapshot(handle.sceneState);
        const chrome: ChromeFacts = {
          ...chromeRef.current,
          editsInFlight: readEditsInFlightRef.current(),
          triggerPressed: readTriggerPressed(),
          appliedTrigger: appliedRef.current,
          view: { camera, freeArea: readFreeArea() },
        };
        const next = reduce(stateRef.current, { type: 'frame', board, chrome }, LESSONS);
        factsRef.current = { board, chrome };
        if (next.card === 'finished' && stateRef.current.card !== 'finished' && next.lessonId !== null) {
          progress.write(withLessonDone(progress.read(), next.lessonId));
        }
        if (next !== stateRef.current) {
          // The watch step's slot read changes the state on most frames and shows nothing.
          const seen = viewKey(next) !== viewKey(stateRef.current);
          stateRef.current = next;
          if (seen) setState(next);
        }
        const shown = currentStage(next, board, chrome, LESSONS);
        setStage(shown);
        // The clearing rule: the card stops running, or the stage or step the refusal landed on changes.
        const held = refusalRecordRef.current;
        if (held !== null && (next.card !== 'running' || shown === null || held.at !== stageKey(next.stepIndex, shown.id))) {
          clearRefusal();
        }
        targetRef.current =
          shown === null || !boardLiveRef.current
            ? null
            : { stageKey: stageKey(next.stepIndex, shown.id), hint: shown.hint, cell: next.spot?.cell ?? null, bindings: next.bindings };
        // The off-screen flag, against this frame's free area. A ring hidden because the board isn't
        // live has nothing to bring into view.
        const shownKey = next.card === 'running' && shown !== null ? stageKey(next.stepIndex, shown.id) : null;
        const out = boardLiveRef.current && offScreenNow(shown, shownKey, chrome.view.freeArea, offScreenRef.current);
        if (out !== offScreenRef.current) {
          offScreenRef.current = out;
          setOffScreen(out);
          // The row hides, and a hidden button holding focus would keep Space and Escape off the
          // board, so focus goes back to the page.
          const focused = document.activeElement;
          if (!out && focused instanceof HTMLElement && focused.closest('[data-fab-offscreen-row]') !== null) focused.blur();
        }
        const drawNow = readBeltDrawInFlightRef.current();
        if (drawNow !== drawingRef.current) {
          drawingRef.current = drawNow;
          setDrawing(drawNow);
        }
        const leftNow = readCardLeft();
        if (leftNow !== cardLeftRef.current) {
          cardLeftRef.current = leftNow;
          setCardLeft(leftNow);
        }
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [active, clearRefusal, handleRef, progress]);

  /**
   * Show me: frame the shown stage's rings (both, for a drag) in the free area, at the user's zoom if
   * they fit. One camera write through `cameraRead.ts`, and nothing goes to the host, so the board,
   * the event log and Undo are as they were.
   */
  const showMe = useCallback((): void => {
    const s = stateRef.current;
    const facts = factsRef.current;
    const camera = readCamera();
    if (s.card !== 'running' || facts === null || camera === null || drawingRef.current) return;
    const shown = currentStage(s, facts.board, facts.chrome, LESSONS);
    if (shown === null) return;
    const rects = boardRingRects(shown, stageKey(s.stepIndex, shown.id));
    if (rects === null) return;
    const left = Math.min(...rects.map((r) => r.left));
    const top = Math.min(...rects.map((r) => r.top));
    const right = Math.max(...rects.map((r) => r.right));
    const bottom = Math.max(...rects.map((r) => r.bottom));
    // Screen to world: world = (screen - pan) / scale.
    const box = {
      x: (left - camera.x) / camera.scale,
      y: (top - camera.y) / camera.scale,
      w: (right - left) / camera.scale,
      h: (bottom - top) / camera.scale,
    };
    moveCamera(handleRef.current, frameTarget(box, readFreeArea(), camera, MIN_ZOOM));
  }, [handleRef]);

  /** One step of the state that a press caused, as opposed to a frame. */
  const dispatch = useCallback(
    (e: TutorialEvent): void => {
      const next = reduce(stateRef.current, e, LESSONS);
      stateRef.current = next;
      setState(next);
      // So the ring can't paint this run's last target before the next frame works out a new one.
      targetRef.current = null;
      // A start, leave, resume or close begins a new sitting, so an old refusal has nothing to say.
      clearRefusal();
    },
    [clearRefusal],
  );

  const start = useCallback(
    (lessonId: LessonId): void => {
      // Everything happens in the callback, so a Cancel in the unsaved-work question leaves the
      // lesson state and the open panel as they were.
      doNewThen(() => {
        const floorAtSend = handleRef.current?.sceneState.swapFloor ?? 0;
        // Done sticks, and a lesson this one replaces stays In progress: one lesson runs at a time.
        progress.write(withLessonStarted(progress.read(), lessonId));
        dispatch({ type: 'newSent', lessonId, floorAtSend });
        appliedRef.current = null;
        setStage(null);
        onLessonsOpenChange(false);
      });
    },
    [dispatch, doNewThen, handleRef, onLessonsOpenChange, progress],
  );

  const resume = useCallback((): void => {
    // The last answer is from before the lesson was left, and the poll stopped there, so it can't say
    // what the trigger is now. The re-check waits for a fresh one.
    appliedRef.current = null;
    dispatch({ type: 'resumed' });
    onLessonsOpenChange(false);
  }, [dispatch, onLessonsOpenChange]);

  // Leave asks nothing, because the board stays as it is.
  const leave = useCallback((): void => {
    dispatch({ type: 'left' });
    setStage(null);
  }, [dispatch]);

  // The lesson is over and the board is the user's, so it's gone from the row and the board keeps running.
  const keepBuilding = useCallback((): void => {
    dispatch({ type: 'cancelledRun' });
    setStage(null);
  }, [dispatch]);

  const backToLessons = useCallback((): void => {
    keepBuilding();
    onLessonsOpenChange(true);
  }, [keepBuilding, onLessonsOpenChange]);

  const closeList = useCallback((): void => {
    onLessonsOpenChange(false);
    handFocusBackFromList(stateRef.current.card !== 'none');
  }, [onLessonsOpenChange]);

  // THE ESCAPE RULE: a running card ignores Escape. Lesson 1's tool-down step asks the user to press Esc to put
  // the tool away, and a second press on the next step would otherwise drop the lesson, so a running lesson ends
  // only on Leave. A finished card closes as Keep building and a swapped one as Leave, and an open list goes first.
  // This is the last row of App's Escape chain, for focus on the page. With focus on one of the card's
  // own buttons the board's chain stops at the button, so the card applies the same rule itself
  // (`cardEscape` in StepCard.tsx).
  useLayoutEffect(() => {
    escapeRef.current = (): void => {
      if (lessonsOpen) {
        closeList();
        return;
      }
      const card = stateRef.current.card;
      if (card === 'finished') keepBuilding();
      else if (card === 'swapped') leave();
    };
    return () => {
      escapeRef.current = null;
    };
  }, [escapeRef, lessonsOpen, closeList, keepBuilding, leave]);

  // Ask first, with the safe answer focused, so the destructive button is never the default.
  const askReset = useCallback((): void => {
    footerFocusRef.current = 'keep';
    setFooter('confirming');
  }, []);

  const keepProgress = useCallback((): void => {
    footerFocusRef.current = 'reset';
    setFooter('rest');
  }, []);

  // Only the store changes. A running lesson keeps running, and its row reads In progress from the
  // run. The Done write stays on the finished transition alone, so a reset under the finished card
  // stays a reset after Keep building.
  const clearProgress = useCallback((): void => {
    progress.clear();
    footerFocusRef.current = 'reset';
    setFooter('cleared');
  }, [progress]);

  const onRowAction = useCallback(
    (lessonId: LessonId, action: RowAction): void => {
      if (action === 'resume') resume();
      else start(lessonId);
    },
    [resume, start],
  );

  const view = cardViewOf(state, stage, refusal, offScreen, drawing);
  // Read at render, which App's 10 Hz re-render keeps fresh enough for a list a person is reading.
  const rows = lessonsOpen
    ? rowViews({
        lessons: LESSONS,
        progress: progress.read(),
        state,
        swapFloor: handleRef.current?.sceneState.swapFloor ?? 0,
        simStopped,
      })
    : [];
  const lessonId = state.lessonId;

  // A swap can take away the action that holds focus, and focus then falls to the page, where Escape
  // can't reach the list. Read during render, because this is the last moment that button is mounted.
  const focusInList = useRef<Element | null>(null);
  const focused = document.activeElement;
  focusInList.current = focused !== null && document.getElementById(LESSONS_PANEL_ID)?.contains(focused) === true ? focused : null;
  // Keyed on what the rows offer, so a press on the board later on can't pull focus back here.
  const offered = rows.map((row) => `${row.id}:${row.actions.join(',')}`).join('|');
  useLayoutEffect(() => {
    const held = focusInList.current;
    if (held !== null && !held.isConnected && document.activeElement === document.body) focusListClose();
  }, [offered]);
  // After the effect above, which a Clear can trigger by changing the rows, so the footer has the last word.
  useLayoutEffect(() => {
    const target = footerFocusRef.current;
    if (target === null) return;
    footerFocusRef.current = null;
    const selector = target === 'keep' ? '[data-fab-reset-keep]' : '[data-fab-reset]';
    document.getElementById(LESSONS_PANEL_ID)?.querySelector<HTMLElement>(selector)?.focus();
  }, [footer]);

  return (
    <>
      {lessonsOpen && (
        <LessonPanel
          rows={rows}
          onAction={onRowAction}
          onClose={closeList}
          footer={footer}
          onReset={askReset}
          onKeep={keepProgress}
          onClear={clearProgress}
        />
      )}
      {active && <HintPointer handleRef={handleRef} targetRef={targetRef} paintRef={paintRingRef} />}
      {view !== null && (
        <StepCard
          view={view}
          onLeave={leave}
          onBackToLessons={backToLessons}
          onKeepBuilding={keepBuilding}
          onShowMe={showMe}
          simStopped={simStopped}
          {...(cardLeft === null ? {} : { left: cardLeft })}
          {...(lessonId === null ? {} : { onRestart: () => start(lessonId) })}
        />
      )}
    </>
  );
}
