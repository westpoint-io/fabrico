// TutorialLayer.tsx - the React side of the lesson engine.
//
// It reads the board and the chrome once a frame and hands them to the pure reducer. Its one way
// of changing anything is the `doNewThen` prop: the tutorial asks the host for a new board and
// never holds the transport, so it can't place a machine or finish a step for the user.

import { useCallback, useLayoutEffect, useRef, useState, type JSX, type MutableRefObject, type RefObject } from 'react';
import type { SceneHandle } from '../../render/pixiApp';
import { sceneSnapshot } from '../../render/sceneState';
import { IDLE, reduce, type Card, type TutorialState } from '../../tutorial/machine';
import { YOUR_FIRST_LINE } from '../../tutorial/lessons/yourFirstLine';
import type { Lesson, LessonId } from '../../tutorial/types';
import type { ArmedTool } from '../Palette';
import { LessonPanel } from './LessonPanel';

const LESSONS: readonly Lesson[] = [YOUR_FIRST_LINE];

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

function probeOf(s: TutorialState): TutorialProbe {
  const lesson = LESSONS.find((l) => l.id === s.lessonId) ?? null;
  const bound: Record<string, number> = {};
  for (const [name, node] of Object.entries(s.bindings)) {
    if (node !== undefined) bound[name] = node.id;
  }
  return {
    lessonId: s.lessonId,
    card: s.card,
    stepIndex: s.stepIndex,
    stepCount: lesson?.steps.length ?? 0,
    stepId: lesson?.steps[s.stepIndex]?.id ?? null,
    stageId: null,
    hint: null,
    hintTo: null,
    bound,
  };
}

/** The probe before the layer mounts: no lesson. */
export function idleTutorialProbe(): TutorialProbe {
  return probeOf(IDLE);
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
}

export function TutorialLayer({ handleRef, lessonsOpen, onLessonsOpenChange, doNewThen, probeRef }: TutorialLayerProps): JSX.Element {
  // The ref is the truth, and the probe reads it, so a test sees every value `reduce` returns.
  // React state follows only so the panel can re-render.
  const stateRef = useRef<TutorialState>(IDLE);
  const [state, setState] = useState<TutorialState>(IDLE);

  useLayoutEffect(() => {
    probeRef.current = () => probeOf(stateRef.current);
    return () => {
      probeRef.current = idleTutorialProbe;
    };
  }, [probeRef]);

  const active = state.card !== 'none';
  useLayoutEffect(() => {
    if (!active) return undefined;
    let raf = 0;
    const frame = (): void => {
      const handle = handleRef.current;
      if (handle !== null) {
        const next = reduce(stateRef.current, { type: 'frame', board: sceneSnapshot(handle.sceneState) }, LESSONS);
        if (next !== stateRef.current) {
          stateRef.current = next;
          setState(next);
        }
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
        onLessonsOpenChange(false);
      });
    },
    [doNewThen, handleRef, onLessonsOpenChange],
  );

  return <>{lessonsOpen && <LessonPanel lessons={LESSONS} onStart={start} onClose={() => onLessonsOpenChange(false)} />}</>;
}
