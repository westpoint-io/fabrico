// machine.ts - the lesson state, as a pure reducer.
//
// It answers one question per animation frame: given the board and the chrome as they stand, where
// is the lesson? Nothing here can write to the board. `reduce` returns the same object when nothing
// changed, so the React layer can skip an update on all but the frames that matter.

import { CELL } from '../../shared/geometry';
import { beltJoining, evaluateCheck, lineDoorstep, lowestSlotInto, nodeKey } from './check';
import type { Progress } from './progress';
import type {
  BindingName,
  BoardFacts,
  Check,
  ChromeFacts,
  Lesson,
  LessonId,
  PhraseToken,
  Stage,
  StageWhen,
  Step,
} from './types';

/**
 * A bound machine. `nodeKey` is `${kind}@${x},${y}`, which survives a re-minted handle; `id` is the
 * current handle. It isn't called `key` because the keyboard gate in `shortcuts.test.ts` treats any
 * shipped `.key` read as a keyboard read.
 */
export interface BoundNode {
  nodeKey: string;
  id: number;
}

/**
 * What a step compares with. It isn't a plain snapshot of the board at step start, because a snapshot
 * taken when step 2 begins already holds a Sink placed during step 1, and the user would have to place
 * a second one. So `knownKeys` holds the keys earlier steps bound, and a machine no step has claimed
 * still counts as new. Another board can't finish anything, because a lesson begins only on an empty
 * board with a higher swap floor. The rest are read when the step begins.
 */
export interface StepBaseline {
  knownKeys: readonly string[];
  tick: number;
  /** Was the board playing when the step began? It decides whether the step-5 note applies. */
  playing: boolean;
  /**
   * The last frame's lowest occupied slot on the belt into the watched Sink: updated each frame at the
   * watch step, null with nothing to compare with yet. `Infinity` is an empty belt.
   */
  lowestSlot: number | null;
  /** The generation `lowestSlot` was read at. A keyframe re-mints handles and would look like a false rise. */
  generation: number;
}

export type Card = 'none' | 'starting' | 'running' | 'swapped' | 'finished';

/** What the card says about steps the user didn't do. `a` and `b` are step numbers, counted from 1. */
export interface LessonNote {
  kind: 'skippedOne' | 'skippedMany' | 'alreadyRunning' | 'wentBack';
  a: number;
  b: number;
}

export interface TutorialState {
  card: Card;
  lessonId: LessonId | null;
  stepIndex: number;
  /**
   * While starting, the swap floor when New was sent. From the first frame of the new board on, that
   * board's own floor. A board swapped in after either has a higher one.
   */
  floor: number;
  /** The floor of the board the lesson was left on, or null when it wasn't left on a running step. */
  leftFloor: number | null;
  /**
   * Set by Resume, and every step found true while it's set counts as one the user didn't do here. It
   * ends with the first frame that has nothing left to read. At the Timer step that's the frame holding
   * the host's first answer about the Source, because that answer comes by query, a few frames later.
   */
  rechecking: boolean;
  bindings: Partial<Record<BindingName, BoundNode>>;
  baseline: StepBaseline | null;
  /** The floor spot of the stage showing now, fixed in world cells when that stage begins, so it follows pan and zoom. */
  spot: { stageId: string; cell: readonly [number, number] } | null;
  note: LessonNote | null;
}

export const IDLE: TutorialState = {
  card: 'none',
  lessonId: null,
  stepIndex: 0,
  floor: 0,
  leftFloor: null,
  rechecking: false,
  bindings: {},
  baseline: null,
  spot: null,
  note: null,
};

export type TutorialEvent =
  | { type: 'newSent'; lessonId: LessonId; floorAtSend: number }
  | { type: 'left' }
  | { type: 'resumed' }
  | { type: 'cancelledRun' }
  | { type: 'frame'; board: BoardFacts; chrome: ChromeFacts };

/** The value the ring records as `data-fab-hint-stage`. The step index is in it because a stage id can recur across steps. */
export function stageKey(stepIndex: number, stageId: string): string {
  return `${stepIndex}:${stageId}`;
}

/**
 * What a person can see of the state, so the layer calls `setState` only when this changes. The
 * baseline isn't in it, because the lowest slot moves on most frames of the watch step and the card
 * and the ring show nothing of it.
 */
export function viewKey(s: TutorialState): string {
  const bound = (['source', 'sink', 'belt'] as const).map((name) => s.bindings[name]?.id ?? '-').join(',');
  const note = s.note === null ? '-' : `${s.note.kind}:${s.note.a}:${s.note.b}`;
  const spot = s.spot === null ? '-' : `${s.spot.stageId}:${s.spot.cell[0]},${s.spot.cell[1]}`;
  return [s.card, s.lessonId ?? '-', s.stepIndex, bound, note, spot].join('|');
}

/** The note's words. The pause key's name comes from the shortcut table, like every lesson word. */
export function noteTokens(note: LessonNote): readonly PhraseToken[] {
  if (note.kind === 'skippedOne') return [`Step ${note.a} was already done, so the lesson moved on.`];
  if (note.kind === 'skippedMany') return [`Steps ${note.a} to ${note.b} were already done, so the lesson moved on.`];
  if (note.kind === 'wentBack') return [`Step ${note.a} needs doing again, so the lesson went back.`];
  return [`The board was already running, so step ${note.a} is done. `, { key: 'playPause' }, ' pauses it.'];
}

function holds(when: StageWhen, board: BoardFacts, chrome: ChromeFacts, bindings: TutorialState['bindings']): boolean {
  const { armed } = chrome;
  switch (when.is) {
    case 'always':
      return true;
    case 'paused':
      return chrome.playing === false;
    case 'toolArmed':
      return armed?.kind === 'machine' && armed.machineKind === when.machineKind;
    case 'toolNotArmed':
      return !(armed?.kind === 'machine' && armed.machineKind === when.machineKind);
    case 'anyToolArmed':
      return armed !== null;
    case 'beltArmed':
      return armed?.kind === 'belt';
    case 'beltNotArmed':
      return armed?.kind !== 'belt';
    case 'lineStopsShort': {
      const from = bindings[when.from];
      return armed?.kind === 'belt' && from !== undefined && lineDoorstep(board, from.id) !== null;
    }
    case 'notSelected':
      return chrome.selectedNode === null || chrome.selectedNode !== bindings[when.of]?.id;
    case 'triggerNotPressed':
      return chrome.triggerPressed !== when.trigger;
    case 'triggerNotApplied':
      // Only a Source has a trigger, and the lesson's one Source is the bound one.
      return !(chrome.appliedTrigger?.kind === when.trigger && chrome.appliedTrigger.node === bindings.source?.id);
  }
}

/** The first stage of the current step whose condition holds, or null when no step is running. */
export function currentStage(
  s: TutorialState,
  board: BoardFacts,
  chrome: ChromeFacts,
  lessons: readonly Lesson[],
): Stage | null {
  if (s.card !== 'running') return null;
  const step = lessons.find((l) => l.id === s.lessonId)?.steps[s.stepIndex];
  return step?.stages.find((stage) => holds(stage.when, board, chrome, s.bindings)) ?? null;
}

/** Cells east or west of the Source that the Sink's spot sits, leaving room for a belt. */
const SINK_OFFSET_CELLS = 6;

/**
 * Where a floor ring goes. New keeps the camera, so a fixed cell could be off screen and the spot
 * is worked out from what the user can see: the Source under the point 40% across and 50% down the
 * free area, the Sink on the Source's row, six cells east, or west when east is past the free area's
 * right edge. Either one moves down a row at a time past any machine or belt tile already there, so the
 * ring marks a cell the host will take and is never the Source's own.
 */
export function floorSpot(args: {
  spot: 'source' | 'sink';
  view: ChromeFacts['view'];
  board: BoardFacts;
  sourceKey?: string;
}): readonly [number, number] {
  const { camera, freeArea } = args.view;
  const size = CELL * camera.scale;
  const free = (x: number, y: number): readonly [number, number] => {
    const taken = (cy: number): boolean =>
      args.board.nodes.some((n) => n.cells.some((c) => c[0] === x && c[1] === cy)) ||
      args.board.belts.some((b) => b.tiles.some((t) => t.cell_x === x && t.cell_y === cy));
    let row = y;
    while (taken(row)) row += 1;
    return [x, row];
  };
  const source = /@(-?\d+),(-?\d+)$/.exec(args.sourceKey ?? '');
  if (args.spot === 'source' || source === null) {
    const px = freeArea.left + 0.4 * (freeArea.right - freeArea.left);
    const py = freeArea.top + 0.5 * (freeArea.bottom - freeArea.top);
    return free(Math.floor((px - camera.x) / size), Math.floor((py - camera.y) / size));
  }
  const sx = Number(source[1]);
  const sy = Number(source[2]);
  const east = sx + SINK_OFFSET_CELLS;
  const eastEdge = (east + 1) * size + camera.x;
  return free(eastEdge > freeArea.right ? sx - SINK_OFFSET_CELLS : east, sy);
}

/** Fix the floor spot when a floor stage begins, and drop it when that stage ends. */
function withSpot(s: TutorialState, board: BoardFacts, chrome: ChromeFacts, lessons: readonly Lesson[]): TutorialState {
  const stage = currentStage(s, board, chrome, lessons);
  if (stage === null || stage.hint?.on !== 'floor') {
    return s.spot === null ? s : { ...s, spot: null };
  }
  if (s.spot?.stageId === stage.id) return s;
  const sourceKey = s.bindings.source?.nodeKey;
  const cell = floorSpot({
    spot: stage.hint.spot,
    view: chrome.view,
    board,
    ...(sourceKey === undefined ? {} : { sourceKey }),
  });
  return { ...s, spot: { stageId: stage.id, cell } };
}

/** The value `lowestSlot` starts from when this step begins: only a step that watches a belt has one. */
function lowestSlotFor(check: Check | undefined, board: BoardFacts, bindings: TutorialState['bindings']): number | null {
  if (check?.is !== 'itemArrived') return null;
  const bound = bindings[check.at];
  return bound === undefined ? null : lowestSlotInto(board, bound.id);
}

function baselineFor(
  step: Step | undefined,
  knownKeys: readonly string[],
  board: BoardFacts,
  chrome: ChromeFacts,
  bindings: TutorialState['bindings'],
): StepBaseline {
  return {
    knownKeys,
    tick: board.tick,
    playing: chrome.playing,
    lowestSlot: lowestSlotFor(step?.done, board, bindings),
    generation: board.generation,
  };
}

/**
 * Finish every step that is true now. A step already true when it comes up is done in the same pass,
 * and the note says so. The first step finished in a pass is the one the user was on; any after it
 * were already done. Steps `tickRose` and `itemArrived` can't finish in the pass that begins them,
 * because their baseline is read off this same frame, so each lasts at least one frame on any board.
 * The walk's step record depends on that.
 */
function advance(s: TutorialState, board: BoardFacts, chrome: ChromeFacts, lessons: readonly Lesson[]): TutorialState {
  const lesson = lessons.find((l) => l.id === s.lessonId);
  if (lesson === undefined) return s;
  let next = s;
  let finished = 0;
  let endedOnRunningBoard = false;
  while (next.card === 'running' && next.baseline !== null) {
    const step = lesson.steps[next.stepIndex];
    if (step === undefined) break;
    const result = evaluateCheck(step.done, { board, baseline: next.baseline, chrome, bindings: next.bindings });
    if (!result.done) break;
    finished += 1;
    endedOnRunningBoard = step.done.is === 'tickRose' && next.baseline.playing;
    const isLast = next.stepIndex === lesson.steps.length - 1;
    const bindings = result.bound === null ? next.bindings : { ...next.bindings, [result.bound.name]: result.bound.node };
    const knownKeys = result.bound === null ? next.baseline.knownKeys : [...next.baseline.knownKeys, result.bound.node.nodeKey];
    const stepIndex = isLast ? next.stepIndex : next.stepIndex + 1;
    next = {
      ...next,
      card: isLast ? 'finished' : 'running',
      stepIndex,
      bindings,
      baseline: baselineFor(isLast ? undefined : lesson.steps[stepIndex], knownKeys, board, chrome, bindings),
    };
  }
  if (finished === 0) return next;
  const lastDone = s.stepIndex + finished;
  // The first step finished in a pass is the one the user was on, unless they've only just come back
  // from leaving: then they did all of them somewhere the card couldn't see. A re-check can take two
  // passes, machines and then the trigger, and the note covers both.
  const earlier = s.rechecking && (s.note?.kind === 'skippedOne' || s.note?.kind === 'skippedMany') ? s.note.a : null;
  const firstSkipped = earlier ?? (s.rechecking ? s.stepIndex + 1 : s.stepIndex + 2);
  let note: LessonNote | null = null;
  if (finished === 1 && endedOnRunningBoard) note = { kind: 'alreadyRunning', a: lastDone, b: lastDone };
  else if (firstSkipped === lastDone) note = { kind: 'skippedOne', a: lastDone, b: lastDone };
  else if (firstSkipped < lastDone) note = { kind: 'skippedMany', a: firstSkipped, b: lastDone };
  return { ...next, note };
}

/** Does an earlier step's result still stand? Only a structural step can stop standing: 5 and 6 are latched. */
function stillStands(check: Check, s: TutorialState, board: BoardFacts, chrome: ChromeFacts): boolean {
  switch (check.is) {
    case 'nodeAppeared': {
      const bound = s.bindings[check.bind];
      return bound !== undefined && board.nodes.some((n) => nodeKey(n) === bound.nodeKey);
    }
    case 'triggerApplied': {
      // No answer yet isn't an answer of Webhook, and an answer about an older handle isn't about this machine.
      const applied = chrome.appliedTrigger;
      return !(applied !== null && applied.node === s.bindings[check.of]?.id && applied.kind !== check.trigger);
    }
    case 'beltJoins': {
      const a = s.bindings[check.a];
      const b = s.bindings[check.b];
      return a !== undefined && b !== undefined && beltJoining(board, a.id, b.id) !== undefined;
    }
    case 'tickRose':
    case 'itemArrived':
      return true;
  }
}

/** The binding a check leaves behind, if any. */
function bindingOf(check: Check): BindingName | null {
  return check.is === 'nodeAppeared' || check.is === 'beltJoins' ? check.bind : null;
}

/**
 * If Undo, Delete or a config change took away an earlier step's result, go back to the earliest such
 * step. The bindings from it on are cleared and their keys forgotten, so a machine that's still there
 * counts again when its step comes back round.
 */
function withGoingBack(s: TutorialState, board: BoardFacts, chrome: ChromeFacts, lessons: readonly Lesson[]): TutorialState {
  const steps = lessons.find((l) => l.id === s.lessonId)?.steps;
  if (steps === undefined || s.baseline === null) return s;
  const gone = steps.slice(0, s.stepIndex).findIndex((step) => !stillStands(step.done, s, board, chrome));
  if (gone < 0) return s;
  const bindings = { ...s.bindings };
  const forgotten = new Set<string>();
  for (const step of steps.slice(gone)) {
    const name = bindingOf(step.done);
    if (name === null) continue;
    const key = bindings[name]?.nodeKey;
    if (key !== undefined) forgotten.add(key);
    delete bindings[name];
  }
  const knownKeys = s.baseline.knownKeys.filter((key) => !forgotten.has(key));
  return {
    ...s,
    stepIndex: gone,
    bindings,
    baseline: baselineFor(steps[gone], knownKeys, board, chrome, bindings),
    spot: null,
    note: { kind: 'wentBack', a: gone + 1, b: gone + 1 },
  };
}

/** Find each bound thing again by its key, so a handle re-minted by Undo keeps its binding. */
function rebound(s: TutorialState, board: BoardFacts): TutorialState {
  let bindings = s.bindings;
  for (const name of ['source', 'sink'] as const) {
    const bound = bindings[name];
    if (bound === undefined) continue;
    const found = board.nodes.find((n) => nodeKey(n) === bound.nodeKey);
    if (found !== undefined && found.id !== bound.id) bindings = { ...bindings, [name]: { ...bound, id: found.id } };
  }
  const { belt, source, sink } = bindings;
  if (belt !== undefined && source !== undefined && sink !== undefined) {
    const found = beltJoining(board, source.id, sink.id);
    if (found !== undefined && found.id !== belt.id) bindings = { ...bindings, belt: { ...belt, id: found.id } };
  }
  return bindings === s.bindings ? s : { ...s, bindings };
}

/** The watch step's read: forget the last slot across a keyframe, then take this frame's. */
function withWatchRead(s: TutorialState, board: BoardFacts, lessons: readonly Lesson[]): TutorialState {
  const check = lessons.find((l) => l.id === s.lessonId)?.steps[s.stepIndex]?.done;
  if (s.card !== 'running' || s.baseline === null || check?.is !== 'itemArrived') return s;
  const lowestSlot = lowestSlotFor(check, board, s.bindings);
  if (lowestSlot === s.baseline.lowestSlot && board.generation === s.baseline.generation) return s;
  return { ...s, baseline: { ...s.baseline, lowestSlot, generation: board.generation } };
}

/** Is a re-check on the Timer step still waiting for the host's first answer about the bound Source? */
function awaitsTriggerAnswer(s: TutorialState, chrome: ChromeFacts, lessons: readonly Lesson[]): boolean {
  if (s.card !== 'running') return false;
  const check = lessons.find((l) => l.id === s.lessonId)?.steps[s.stepIndex]?.done;
  return check?.is === 'triggerApplied' && chrome.appliedTrigger?.node !== s.bindings[check.of]?.id;
}

/** One frame of a running lesson. The check reads last frame's slot, and only then is it replaced. */
function runFrame(s: TutorialState, board: BoardFacts, chrome: ChromeFacts, lessons: readonly Lesson[]): TutorialState {
  const found = rebound(s, board);
  const checked = withGoingBack(found, board, chrome, lessons);
  let next = advance(checked, board, chrome, lessons);
  // A machine moved to another cell has a new key, so its step goes back and finishes again in this one
  // pass. The user is on the step they were on, and there's nothing to tell them.
  if (checked !== found && next.card === 'running' && next.stepIndex >= found.stepIndex) next = { ...next, note: found.note };
  if (next.rechecking && !awaitsTriggerAnswer(next, chrome, lessons)) next = { ...next, rechecking: false };
  return withSpot(withWatchRead(next, board, lessons), board, chrome, lessons);
}

export function reduce(s: TutorialState, e: TutorialEvent, lessons: readonly Lesson[]): TutorialState {
  if (e.type === 'newSent') {
    return { ...IDLE, card: 'starting', lessonId: e.lessonId, floor: e.floorAtSend };
  }
  if (e.type === 'left') {
    // The board stays, and so do the step index, bindings and baseline, so the lesson can resume. Only
    // a running step can come back: a lesson still starting has no step yet, and a swapped one has lost
    // its board.
    return { ...s, card: 'none', leftFloor: s.card === 'running' ? s.floor : null };
  }
  if (e.type === 'resumed') {
    if (s.card !== 'none' || s.leftFloor === null) return s;
    // The spot goes too: the user may have built on it, and the first frame works it out from the board as it stands.
    return { ...s, card: 'running', leftFloor: null, spot: null, note: null, rechecking: true };
  }
  if (e.type === 'cancelledRun') {
    return IDLE;
  }
  if (s.card === 'starting') {
    // The swap floor, not the generation: Undo raises the generation too, and only a real swap
    // means the empty board has arrived. Frames from the old board wait here, so its machines
    // can't finish a step. So does a board with anything on it: New's board is always empty, and a
    // higher floor with machines is a Load sent before this New, whose keyframe landed first.
    if (e.board.swapFloor <= s.floor || e.board.nodes.length > 0 || e.board.belts.length > 0) return s;
    const running: TutorialState = {
      ...s,
      card: 'running',
      stepIndex: 0,
      floor: e.board.swapFloor,
      baseline: baselineFor(lessons.find((l) => l.id === s.lessonId)?.steps[0], [], e.board, e.chrome, s.bindings),
    };
    return runFrame(running, e.board, e.chrome, lessons);
  }
  if (s.card === 'running') {
    // The swap floor again. Undo raises the generation and keeps the lesson going; only Load, an example
    // or New raises this, and the lesson never carries on against a board it didn't start on.
    if (e.board.swapFloor > s.floor) return { ...s, card: 'swapped', spot: null, note: null, rechecking: false };
    return runFrame(s, e.board, e.chrome, lessons);
  }
  return s;
}

export type RowStatus = 'notStarted' | 'inProgress' | 'done';
export type RowAction = 'start' | 'resume' | 'restart';

export interface RowView {
  id: LessonId;
  title: string;
  status: RowStatus;
  actions: readonly RowAction[];
  /** The one action drawn in the accent. Only the first lesson that isn't done can have one. */
  accent: RowAction | null;
  disabled: boolean;
}

function rowOf(lesson: Lesson, progress: Progress, state: TutorialState, swapFloor: number): Pick<RowView, 'status' | 'actions'> {
  const run = state.lessonId === lesson.id ? state : null;
  const card = run?.card ?? 'none';
  if (card === 'starting' || card === 'running' || card === 'swapped') return { status: 'inProgress', actions: ['restart'] };
  // A lesson never carries on against another board, so Resume needs the board it was left on.
  if (run !== null && card === 'none' && run.leftFloor !== null && run.leftFloor === swapFloor) {
    return { status: 'inProgress', actions: ['resume', 'restart'] };
  }
  const stored = progress.lessons[lesson.id];
  if (card === 'finished' || stored === 'done') return { status: 'done', actions: ['restart'] };
  if (stored === 'inProgress') return { status: 'inProgress', actions: ['restart'] };
  return { status: 'notStarted', actions: ['start'] };
}

/**
 * The list's rows, in the order of the lessons. Done sticks in the store, and a live run reads In
 * progress on top of it. Restart is never the accent, because it replaces the board.
 */
export function rowViews(args: {
  lessons: readonly Lesson[];
  progress: Progress;
  state: TutorialState;
  swapFloor: number;
  simStopped: boolean;
}): RowView[] {
  const { lessons, progress, state, swapFloor, simStopped } = args;
  const rows = lessons.map((lesson) => ({ lesson, ...rowOf(lesson, progress, state, swapFloor) }));
  const first = rows.find((row) => row.status !== 'done');
  return rows.map(({ lesson, status, actions }) => ({
    id: lesson.id,
    title: lesson.title,
    status,
    actions,
    accent: lesson === first?.lesson ? (actions.find((a) => a === 'start' || a === 'resume') ?? null) : null,
    disabled: simStopped,
  }));
}
