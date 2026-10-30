// machine.ts - the lesson state, as a pure reducer.
//
// It answers one question per animation frame: given the board as it stands, where is the lesson?
// Nothing here can write to the board. `reduce` returns the same object when nothing changed, so
// the React layer can skip an update on all but the frames that matter.

import type { BindingName, BoardFacts, Lesson, LessonId } from './types';

/** A bound machine. `key` is `${kind}@${x},${y}`, which survives a re-minted handle; `id` is the current handle. */
export interface BoundNode {
  key: string;
  id: number;
}

/** What the board held when a step began, so a step can tell what is new. */
export interface StepBaseline {
  knownKeys: readonly string[];
  tick: number;
}

export type Card = 'none' | 'starting' | 'running' | 'finished';

export interface TutorialState {
  card: Card;
  lessonId: LessonId | null;
  stepIndex: number;
  /** The swap floor when New was sent. A board swapped in after it has a higher one. */
  floor: number;
  bindings: Partial<Record<BindingName, BoundNode>>;
  baseline: StepBaseline | null;
  spot: { stageId: string; cell: readonly [number, number] } | null;
}

export const IDLE: TutorialState = {
  card: 'none',
  lessonId: null,
  stepIndex: 0,
  floor: 0,
  bindings: {},
  baseline: null,
  spot: null,
};

export type TutorialEvent =
  | { type: 'newSent'; lessonId: LessonId; floorAtSend: number }
  | { type: 'frame'; board: BoardFacts };

/** A node's identity across a re-minted handle: its kind and its smallest cell. */
function keyOf(node: BoardFacts['nodes'][number]): string {
  const x = Math.min(...node.cells.map((c) => c[0] ?? 0));
  const y = Math.min(...node.cells.map((c) => c[1] ?? 0));
  return `${node.kind}@${x},${y}`;
}

export function reduce(s: TutorialState, e: TutorialEvent, _lessons: readonly Lesson[]): TutorialState {
  if (e.type === 'newSent') {
    return { ...IDLE, card: 'starting', lessonId: e.lessonId, floor: e.floorAtSend };
  }
  if (s.card === 'starting') {
    // The swap floor, not the generation: Undo raises the generation too, and only a real swap
    // means the empty board has arrived. Frames from the old board wait here, so its machines
    // can't finish a step.
    if (e.board.swapFloor <= s.floor) return s;
    return {
      ...s,
      card: 'running',
      stepIndex: 0,
      baseline: { knownKeys: e.board.nodes.map(keyOf), tick: e.board.tick },
    };
  }
  return s;
}
