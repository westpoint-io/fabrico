// machine.ts - the lesson state, as a pure reducer.
//
// It answers one question per animation frame: given the board and the chrome as they stand, where
// is the lesson? Nothing here can write to the board. `reduce` returns the same object when nothing
// changed, so the React layer can skip an update on all but the frames that matter.

import { CELL } from '../../shared/geometry';
import { evaluateCheck, nodeKey } from './check';
import type { BindingName, BoardFacts, ChromeFacts, Lesson, LessonId, Stage, StageWhen } from './types';

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
  /** The floor spot of the stage showing now, fixed in world cells when that stage begins, so it follows pan and zoom. */
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
  | { type: 'frame'; board: BoardFacts; chrome: ChromeFacts };

/** The value the ring records as `data-fab-hint-stage`. The step index is in it because a stage id can recur across steps. */
export function stageKey(stepIndex: number, stageId: string): string {
  return `${stepIndex}:${stageId}`;
}

function holds(when: StageWhen, chrome: ChromeFacts): boolean {
  if (when.is === 'always') return true;
  const armedKind = chrome.armed?.kind === 'machine' ? chrome.armed.machineKind : null;
  return when.is === 'toolArmed' ? armedKind === when.machineKind : armedKind !== when.machineKind;
}

/** The first stage of the current step whose condition holds, or null when no step is running. */
export function currentStage(
  s: TutorialState,
  _board: BoardFacts,
  chrome: ChromeFacts,
  lessons: readonly Lesson[],
): Stage | null {
  if (s.card !== 'running') return null;
  const step = lessons.find((l) => l.id === s.lessonId)?.steps[s.stepIndex];
  return step?.stages.find((stage) => holds(stage.when, chrome)) ?? null;
}

/** Cells east or west of the Source that the Sink's spot sits, leaving room for a belt. */
const SINK_OFFSET_CELLS = 6;

/**
 * Where a floor ring goes. New keeps the camera, so a fixed cell could be off screen and the spot
 * is worked out from what the user can see: the Source under the point 40% across and 50% down the
 * free area, the Sink on the Source's row, six cells east, or west when east is past the free area's
 * right edge, and one row down if that cell is taken.
 */
export function floorSpot(args: {
  spot: 'source' | 'sink';
  view: ChromeFacts['view'];
  board: BoardFacts;
  sourceKey?: string;
}): readonly [number, number] {
  const { camera, freeArea } = args.view;
  const size = CELL * camera.scale;
  const source = /@(-?\d+),(-?\d+)$/.exec(args.sourceKey ?? '');
  if (args.spot === 'source' || source === null) {
    const px = freeArea.left + 0.4 * (freeArea.right - freeArea.left);
    const py = freeArea.top + 0.5 * (freeArea.bottom - freeArea.top);
    return [Math.floor((px - camera.x) / size), Math.floor((py - camera.y) / size)];
  }
  const sx = Number(source[1]);
  const sy = Number(source[2]);
  const east = sx + SINK_OFFSET_CELLS;
  const eastEdge = (east + 1) * size + camera.x;
  const x = eastEdge > freeArea.right ? sx - SINK_OFFSET_CELLS : east;
  const taken = args.board.nodes.some((n) => n.cells.some((c) => c[0] === x && c[1] === sy));
  return [x, taken ? sy + 1 : sy];
}

/** Fix the floor spot when a floor stage begins, and drop it when that stage ends. */
function withSpot(s: TutorialState, board: BoardFacts, chrome: ChromeFacts, lessons: readonly Lesson[]): TutorialState {
  const stage = currentStage(s, board, chrome, lessons);
  if (stage === null || stage.hint?.on !== 'floor') {
    return s.spot === null ? s : { ...s, spot: null };
  }
  if (s.spot?.stageId === stage.id) return s;
  const sourceKey = s.bindings.source?.key;
  const cell = floorSpot({
    spot: stage.hint.spot,
    view: chrome.view,
    board,
    ...(sourceKey === undefined ? {} : { sourceKey }),
  });
  return { ...s, spot: { stageId: stage.id, cell } };
}

/** Finish every step that is true now. A step already true when it comes up is done in the same pass. */
function advance(s: TutorialState, board: BoardFacts, lessons: readonly Lesson[]): TutorialState {
  const lesson = lessons.find((l) => l.id === s.lessonId);
  if (lesson === undefined) return s;
  let next = s;
  while (next.card === 'running' && next.baseline !== null) {
    const step = lesson.steps[next.stepIndex];
    if (step === undefined) break;
    const result = evaluateCheck(step.done, { board, baseline: next.baseline });
    if (!result.done) break;
    const isLast = next.stepIndex === lesson.steps.length - 1;
    next = {
      ...next,
      card: isLast ? 'finished' : 'running',
      stepIndex: isLast ? next.stepIndex : next.stepIndex + 1,
      bindings: { ...next.bindings, [result.bound.name]: result.bound.node },
      baseline: { knownKeys: [...next.baseline.knownKeys, result.bound.node.key], tick: board.tick },
    };
  }
  return next;
}

export function reduce(s: TutorialState, e: TutorialEvent, lessons: readonly Lesson[]): TutorialState {
  if (e.type === 'newSent') {
    return { ...IDLE, card: 'starting', lessonId: e.lessonId, floor: e.floorAtSend };
  }
  if (s.card === 'starting') {
    // The swap floor, not the generation: Undo raises the generation too, and only a real swap
    // means the empty board has arrived. Frames from the old board wait here, so its machines
    // can't finish a step.
    if (e.board.swapFloor <= s.floor) return s;
    const running: TutorialState = {
      ...s,
      card: 'running',
      stepIndex: 0,
      baseline: { knownKeys: e.board.nodes.map(nodeKey), tick: e.board.tick },
    };
    return withSpot(advance(running, e.board, lessons), e.board, e.chrome, lessons);
  }
  if (s.card === 'running') {
    return withSpot(advance(s, e.board, lessons), e.board, e.chrome, lessons);
  }
  return s;
}
