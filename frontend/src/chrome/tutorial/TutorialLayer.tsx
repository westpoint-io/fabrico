// TutorialLayer.tsx - the React side of the lesson engine.
//
// It reads the board and the chrome once a frame and hands them to the pure reducer. Its one way
// of changing anything is the `doNewThen` prop: the tutorial asks the host for a new board and
// never holds the transport, so it can't place a machine or finish a step for the user.

import { useCallback, useLayoutEffect, useRef, useState, type JSX, type MutableRefObject, type RefObject } from 'react';
import type { SceneHandle } from '../../render/pixiApp';
import { sceneSnapshot } from '../../render/sceneState';
import { LESSONS } from '../../tutorial/lessons';
import { IDLE, currentStage, reduce, stageKey, type Card, type TutorialState } from '../../tutorial/machine';
import type { BoardFacts, ChromeFacts, LessonId, Stage } from '../../tutorial/types';
import type { ArmedTool } from '../Palette';
import { readCamera } from './cameraRead';
import { HintPointer, type HintTarget } from './HintPointer';
import { LessonPanel } from './LessonPanel';
import { StepCard, type StepCardView } from './StepCard';

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
function ringRectFor(key: string): HintRect | null {
  const ring = document.querySelector<HTMLElement>('[data-fab-hint]');
  if (ring === null || ring.getAttribute('data-fab-hint-stage') !== key) return null;
  const r = ring.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height, shape: 'square' };
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
    hint: stage === null ? null : ringRectFor(stageKey(s.stepIndex, stage.id)),
    hintTo: null,
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

/** The part of the window no panel covers: right of the palette, under the toolbar, above the card. */
function readFreeArea(): ChromeFacts['view']['freeArea'] {
  const dock = document.querySelector<HTMLElement>('[data-fab-left-dock]');
  const card = document.querySelector<HTMLElement>('[data-fab-step-card]');
  return {
    left: dock === null ? 0 : dock.getBoundingClientRect().right,
    right: window.innerWidth - FREE_AREA_RIGHT_INSET_PX,
    top: FREE_AREA_TOP_PX,
    bottom: card === null ? window.innerHeight : card.getBoundingClientRect().top,
  };
}

/** What the card shows, or null when it has nothing to show. */
function cardViewOf(s: TutorialState, stage: Stage | null): StepCardView | null {
  if (s.card === 'starting') return { state: 'starting' };
  if (s.card !== 'running' || stage === null) return null;
  const stepCount = LESSONS.find((l) => l.id === s.lessonId)?.steps.length ?? 0;
  return { state: 'running', stepNumber: s.stepIndex + 1, stepCount, note: null, text: stage.text };
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
  // The frame loop below outlives any one render, so it reads the chrome's props through this.
  const chromeRef = useRef({ armed, selectedNode, playing });
  chromeRef.current = { armed, selectedNode, playing };

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
        const chrome: ChromeFacts = { ...chromeRef.current, view: { camera, freeArea: readFreeArea() } };
        const next = reduce(stateRef.current, { type: 'frame', board, chrome }, LESSONS);
        factsRef.current = { board, chrome };
        if (next !== stateRef.current) {
          stateRef.current = next;
          setState(next);
        }
        const shown = currentStage(next, board, chrome, LESSONS);
        setStage(shown);
        targetRef.current =
          shown === null
            ? null
            : { stageKey: stageKey(next.stepIndex, shown.id), hint: shown.hint, cell: next.spot?.cell ?? null };
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [active, handleRef]);

  const start = useCallback(
    (lessonId: LessonId): void => {
      // Everything happens in the callback, so a Cancel in the unsaved-work question leaves the
      // lesson state and the open panel as they were.
      doNewThen(() => {
        const floorAtSend = handleRef.current?.sceneState.swapFloor ?? 0;
        const next = reduce(stateRef.current, { type: 'newSent', lessonId, floorAtSend }, LESSONS);
        stateRef.current = next;
        setState(next);
        targetRef.current = null;
        onLessonsOpenChange(false);
      });
    },
    [doNewThen, handleRef, onLessonsOpenChange],
  );

  const leave = useCallback((): void => {
    const next = reduce(stateRef.current, { type: 'left' }, LESSONS);
    stateRef.current = next;
    setState(next);
    // So a later Start can't paint this lesson's last target before its first frame.
    targetRef.current = null;
    setStage(null);
  }, []);

  const view = cardViewOf(state, stage);

  return (
    <>
      {lessonsOpen && <LessonPanel lessons={LESSONS} onStart={start} onClose={() => onLessonsOpenChange(false)} />}
      {active && <HintPointer targetRef={targetRef} paintRef={paintRingRef} />}
      {view !== null && <StepCard view={view} onLeave={leave} />}
    </>
  );
}
