// TutorialLayer.tsx - the React side of the lesson engine.
//
// It reads the board and the chrome once a frame and hands them to the pure reducer. Its one way
// of changing the board is the `doNewThen` prop: the tutorial asks the host for a new board and
// never holds the transport, so it can't place a machine or finish a step for the user. Progress goes
// through a `ProgressStore` and stays on this machine.

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type JSX, type MutableRefObject, type RefObject } from 'react';
import type { SceneHandle } from '../../render/pixiApp';
import { sceneSnapshot } from '../../render/sceneState';
import { LESSONS } from '../../tutorial/lessons';
import { IDLE, currentStage, noteTokens, reduce, rowViews, stageKey, viewKey, type Card, type RowAction, type TutorialEvent, type TutorialState } from '../../tutorial/machine';
import { localStorageProgress, withLessonDone, withLessonStarted, type ProgressStore } from '../../tutorial/progress';
import type { BindingName, BoardFacts, ChromeFacts, LessonId, Stage } from '../../tutorial/types';
import type { ArmedTool } from '../Palette';
import { readCamera } from './cameraRead';
import { HintPointer, type HintTarget } from './HintPointer';
import { LESSONS_PANEL_ID, LessonPanel, focusListClose } from './LessonPanel';
import { StepCard, type StepCardView } from './StepCard';
import { readAppliedTrigger } from './triggerRead';

export interface HintRect {
  x: number;
  y: number;
  width: number;
  height: number;
  shape: 'square' | 'circle';
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
}

/** The facts the last frame used. */
interface FrameFacts {
  board: BoardFacts;
  chrome: ChromeFacts;
}

/**
 * The ring's rect, only if the ring was last placed for `key`. A stage change reaches the ring a
 * frame after the state, and until then its rect belongs to the old stage, so a rect in a probe read
 * always belongs to the stage named in that same read.
 */
function ringRectFor(key: string, shape: HintRect['shape']): HintRect | null {
  const ring = document.querySelector<HTMLElement>('[data-fab-hint]');
  if (ring === null || ring.getAttribute('data-fab-hint-stage') !== key) return null;
  const r = ring.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height, shape };
}

/** The drag's far ring, under the same comparison: the ring records the stage both were written for. */
function ringToRectFor(key: string): HintRect | null {
  const ring = document.querySelector<HTMLElement>('[data-fab-hint]');
  const to = document.querySelector<HTMLElement>('[data-fab-hint-to]');
  if (ring === null || to === null || ring.getAttribute('data-fab-hint-stage') !== key) return null;
  const r = to.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height, shape: 'circle' };
}

function probeOf(s: TutorialState, facts: FrameFacts | null): TutorialProbe {
  const lesson = LESSONS.find((l) => l.id === s.lessonId) ?? null;
  const bound: Record<string, number> = {};
  for (const [name, node] of Object.entries(s.bindings)) {
    if (node !== undefined) bound[name] = node.id;
  }
  const stage = facts === null ? null : currentStage(s, facts.board, facts.chrome, LESSONS);
  return {
    lessonId: s.lessonId,
    card: s.card,
    stepIndex: s.stepIndex,
    stepCount: lesson?.steps.length ?? 0,
    stepId: lesson?.steps[s.stepIndex]?.id ?? null,
    stageId: stage?.id ?? null,
    hint: stage === null ? null : ringRectFor(stageKey(s.stepIndex, stage.id), stage.hint?.on === 'port' ? 'circle' : 'square'),
    hintTo: stage?.hint?.on === 'port' && stage.hint.to !== undefined ? ringToRectFor(stageKey(s.stepIndex, stage.id)) : null,
    bound,
  };
}

/** The probe before the layer mounts: no lesson. */
export function idleTutorialProbe(): TutorialProbe {
  return probeOf(IDLE, null);
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

/** What the card shows, or null when it has nothing to show. */
function cardViewOf(s: TutorialState, stage: Stage | null): StepCardView | null {
  if (s.card === 'starting') return { state: 'starting' };
  if (s.card === 'swapped') return { state: 'swapped' };
  const lesson = LESSONS.find((l) => l.id === s.lessonId);
  if (s.card === 'finished' && lesson !== undefined) return { state: 'finished', text: lesson.closing };
  if (s.card !== 'running' || stage === null) return null;
  const note = s.note === null ? null : noteTokens(s.note);
  return { state: 'running', stepNumber: s.stepIndex + 1, stepCount: lesson?.steps.length ?? 0, note, text: stage.text };
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

/** The step that waits on an applied trigger, and the binding it names. Null when the lesson has none. */
function triggerWatch(s: TutorialState): { from: number; of: BindingName } | null {
  const steps = LESSONS.find((l) => l.id === s.lessonId)?.steps ?? [];
  const from = steps.findIndex((step) => step.done.is === 'triggerApplied');
  const done = steps[from]?.done;
  return done?.is === 'triggerApplied' ? { from, of: done.of } : null;
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
  /** Tells App a lesson is on screen, so the empty-floor text stands down. */
  onActiveChange: (active: boolean) => void;
  /** False on a stopped or disconnected simulation: the ring hides, and the card keeps its text. */
  boardLive: boolean;
  /** New can't reach a stopped host, so Start and Restart say so. */
  simStopped: boolean;
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
  onActiveChange,
  boardLive,
  simStopped,
}: TutorialLayerProps): JSX.Element {
  // The ref is the truth, and the probe reads it, so a test sees every value `reduce` returns.
  // React state follows only so the panel and the ring can mount and unmount.
  const stateRef = useRef<TutorialState>(IDLE);
  const [state, setState] = useState<TutorialState>(IDLE);
  // The stage can change with the chrome while the lesson state stands still, for example when a tool
  // arms. The stages are constants, so setting the same one each frame costs no render.
  const [stage, setStage] = useState<Stage | null>(null);
  const factsRef = useRef<FrameFacts | null>(null);
  const targetRef = useRef<HintTarget | null>(null);
  const paintRingRef = useRef<(() => void) | null>(null);
  // The host's last answer about the bound Source's trigger. The frame loop reads only this.
  const appliedRef = useRef<ChromeFacts['appliedTrigger']>(null);
  // The frame loop below outlives any one render, so it reads the chrome's props through this.
  const chromeRef = useRef({ armed, selectedNode, playing });
  chromeRef.current = { armed, selectedNode, playing };
  const boardLiveRef = useRef(boardLive);
  boardLiveRef.current = boardLive;
  const progressRef = useRef<ProgressStore | null>(null);
  progressRef.current ??= browserProgress();
  const progress = progressRef.current;

  // THE TRIGGER READ, only while the lesson sits at or past the Timer step. It's async, so it runs on
  // a timer and the frame loop reads the ref, because a query per frame is what the Route sweep in
  // App.tsx warns against. It reads and enqueues nothing, so the simulation can't tell it ran.
  const watch = triggerWatch(state);
  const watchedNode =
    watch !== null && state.card === 'running' && state.stepIndex >= watch.from ? (state.bindings[watch.of]?.id ?? null) : null;
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
    probeRef.current = () => probeOf(stateRef.current, factsRef.current);
    return () => {
      probeRef.current = idleTutorialProbe;
    };
  }, [probeRef]);

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
        targetRef.current =
          shown === null || !boardLiveRef.current
            ? null
            : { stageKey: stageKey(next.stepIndex, shown.id), hint: shown.hint, cell: next.spot?.cell ?? null, bindings: next.bindings };
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [active, handleRef, progress]);

  /** One step of the state that a press caused, as opposed to a frame. */
  const dispatch = useCallback((e: TutorialEvent): void => {
    const next = reduce(stateRef.current, e, LESSONS);
    stateRef.current = next;
    setState(next);
    // So the ring can't paint this run's last target before the next frame works out a new one.
    targetRef.current = null;
  }, []);

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

  const onRowAction = useCallback(
    (lessonId: LessonId, action: RowAction): void => {
      if (action === 'resume') resume();
      else start(lessonId);
    },
    [resume, start],
  );

  const view = cardViewOf(state, stage);
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

  return (
    <>
      {lessonsOpen && <LessonPanel rows={rows} onAction={onRowAction} onClose={closeList} />}
      {active && <HintPointer handleRef={handleRef} targetRef={targetRef} paintRef={paintRingRef} />}
      {view !== null && (
        <StepCard
          view={view}
          onLeave={leave}
          onBackToLessons={backToLessons}
          onKeepBuilding={keepBuilding}
          simStopped={simStopped}
          {...(lessonId === null ? {} : { onRestart: () => start(lessonId) })}
        />
      )}
    </>
  );
}
