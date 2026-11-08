import { describe, expect, it } from 'vitest';
import { boundMachineHandles, evaluateCheck, nodeKey } from './check.ts';
import { LESSONS } from './lessons/index.ts';
import { TWO_OUTPUTS } from './lessons/twoOutputs.ts';
import { YOUR_FIRST_LINE } from './lessons/yourFirstLine.ts';
import {
  IDLE,
  currentStage,
  floorSpot,
  noteTokens,
  reduce,
  rowViews,
  viewKey,
  type RowView,
  type TutorialState,
} from './machine.ts';
import { MAX_INSTRUCTION_CHARS, MAX_NOTE_CHARS, REAL_TABLES, auditLessonWords, phrasePlain } from './phrase.ts';
import { EMPTY_PROGRESS, localStorageProgress, withLessonDone, withLessonStarted, type Progress } from './progress.ts';
import type { AppliedConfig, BoardBelt, BoardFacts, BoardNode, ChromeFacts, Lesson, LessonId } from './types.ts';

const SOURCE = 0;
const SINK = 7;
const LESSON = 'your-first-line';
const FLOOR = 4;

const node = (id: number, kind: number, x: number, y: number): BoardNode => ({ id, kind, cells: [[x, y]], ports: [] });

const VIEW: ChromeFacts['view'] = {
  camera: { x: 0, y: 0, scale: 1 },
  freeArea: { left: 0, right: 1000, top: 0, bottom: 600 },
};

function chrome(over: Partial<ChromeFacts> = {}): ChromeFacts {
  return { armed: null, selectedNode: null, selectedBelt: null, playing: true, editsInFlight: false, triggerPressed: null, appliedTrigger: null, appliedConfigs: [], codeNotApplied: false, codeText: null, view: VIEW, ...over };
}

function board(over: Partial<BoardFacts> = {}): BoardFacts {
  return { tick: 10, generation: 1, swapFloor: FLOOR + 1, nodes: [], belts: [], ...over };
}

function frame(s: TutorialState, b: Partial<BoardFacts>, c: Partial<ChromeFacts> = {}): TutorialState {
  return reduce(s, { type: 'frame', board: board(b), chrome: chrome(c) }, LESSONS);
}

/** A lesson just started on an empty board. */
function started(): TutorialState {
  const sent = reduce(IDLE, { type: 'newSent', lessonId: LESSON, floorAtSend: FLOOR }, LESSONS);
  return frame(sent, {});
}

const THE_SOURCE: BoardNode = { ...node(4, SOURCE, 2, 2), ports: [{ index: 0, cell_x: 2, cell_y: 2, side: 1, role: 1 }] };
const THE_SINK: BoardNode = {
  ...node(5, SINK, 8, 2),
  ports: [
    { index: 0, cell_x: 8, cell_y: 2, side: 2, role: 2 },
    { index: 1, cell_x: 8, cell_y: 2, side: 3, role: 0 },
  ],
};
const JOINED: BoardBelt = {
  id: 9,
  items: 0,
  occupiedSlots: [],
  tiles: [],
  docks: [
    { end: 'Tail', node: THE_SOURCE.id, port: 0 },
    { end: 'Head', node: THE_SINK.id, port: 0 },
  ],
};
const BOTH = [THE_SOURCE, THE_SINK];
const TIMER = { appliedTrigger: { node: THE_SOURCE.id, kind: 'Timer' as const } };

/** Bring a lesson to the step with this index, one step a frame. */
function atStep(index: number): TutorialState {
  let s = started();
  if (index >= 1) s = frame(s, { nodes: [THE_SOURCE] });
  if (index >= 2) s = frame(s, { nodes: BOTH });
  if (index >= 3) s = frame(s, { nodes: BOTH }, TIMER);
  if (index >= 4) s = frame(s, { nodes: BOTH, belts: [JOINED] }, TIMER);
  if (index >= 5) s = frame(s, { nodes: BOTH, belts: [JOINED], tick: 11 }, TIMER);
  return s;
}

describe('the lesson data', () => {
  it('has the six steps in order', () => {
    expect(LESSONS[0]?.steps.length).toBe(6);
    expect(LESSONS[0]?.steps.map((s) => s.id)).toEqual([
      'place-source',
      'place-sink',
      'set-timer',
      'draw-belt',
      'press-play',
      'watch-items',
    ]);
  });

  it('has the stages each step needs, in the order the script reads', () => {
    const stages = (id: string): string[] =>
      LESSONS[0]?.steps.find((s) => s.id === id)?.stages.map((stage) => stage.id) ?? [];
    expect(stages('set-timer')).toEqual(['board-paused', 'tool-down', 'select-source', 'press-timer', 'apply-timer']);
    expect(stages('draw-belt')).toEqual(['board-paused', 'belt-tool', 'belt-undo', 'belt-carry-on', 'belt-draw']);
    expect(stages('press-play')).toEqual(['board-paused', 'board-running']);
    expect(stages('watch-items')).toEqual(['board-paused', 'watch']);
  });

  it('types no table word as text', () => {
    expect(auditLessonWords(LESSONS)).toEqual([]);
  });

  it('keeps every instruction inside the card', () => {
    for (const step of LESSONS[0]?.steps ?? []) {
      for (const stage of step.stages) {
        const text = phrasePlain(stage.text);
        expect(text.length, `${step.id} ${stage.id}: ${text}`).toBeLessThanOrEqual(MAX_INSTRUCTION_CHARS);
      }
    }
  });

  it('marks the Source out to the Sink in, for the drag', () => {
    const stage = LESSONS[0]?.steps.find((s) => s.id === 'draw-belt')?.stages.find((x) => x.id === 'belt-draw');
    expect(stage?.hint).toEqual({ on: 'port', of: 'source', role: 'out', to: { of: 'sink', role: 'in' } });
    expect(stage?.gesture).toEqual({ do: 'dragHint' });
  });

  it('marks only the Sink in, once a belt has left the Source and stopped short', () => {
    const stage = LESSONS[0]?.steps.find((s) => s.id === 'draw-belt')?.stages.find((x) => x.id === 'belt-carry-on');
    expect(stage?.hint).toEqual({ on: 'port', of: 'sink', role: 'in' });
    expect(stage?.gesture).toEqual({ do: 'dragToHint' });
    expect(phrasePlain(stage?.text ?? [])).toBe("That Belt stops before the Sink. Drag from the ring at its end to the Sink's input dot.");
  });
});

describe('a Timer applied before its step comes up', () => {
  const NOTE = { kind: 'skippedOne', a: 3, b: 3 };

  it('finishes with the Sink and writes the note, when the answer is already held', () => {
    const atSink = frame(started(), { nodes: [THE_SOURCE] }, TIMER);
    expect(atSink.stepIndex, 'the Sink is still to come').toBe(1);
    const landed = frame(atSink, { nodes: BOTH }, TIMER);
    expect(landed.stepIndex).toBe(3);
    expect(landed.note).toEqual(NOTE);
  });

  it('does the same when the Timer was applied while left at the Sink step', () => {
    const left = reduce(atStep(1), { type: 'left' }, LESSONS);
    const back = frame(reduce(left, { type: 'resumed' }, LESSONS), { nodes: [THE_SOURCE] }, TIMER);
    expect(back.stepIndex, 'nothing to skip yet').toBe(1);
    expect(back.note).toBeNull();
    const landed = frame(back, { nodes: BOTH }, TIMER);
    expect(landed.stepIndex).toBe(3);
    expect(landed.note).toEqual(NOTE);
  });
});

describe('the stage for a belt that cannot be carried on', () => {
  const stage = LESSONS[0]?.steps.find((s) => s.id === 'draw-belt')?.stages.find((x) => x.id === 'belt-undo');

  it('marks nothing and asks for the undo key', () => {
    expect(stage?.hint).toBeNull();
    expect(stage?.gesture).toEqual({ do: 'key', shortcut: 'undo' });
  });

  it('names the key through the shortcut table', () => {
    expect(stage?.text).toContainEqual({ key: 'undo' });
    expect(phrasePlain(stage?.text ?? [])).toBe("That Belt can't be carried on. Press Ctrl+Z until it's gone, then draw it again.");
  });
});

describe('reduce: a lesson that starts from a swap', () => {
  it('a frame with the old swap floor leaves the state in starting', () => {
    const sent = reduce(IDLE, { type: 'newSent', lessonId: LESSON, floorAtSend: FLOOR }, LESSONS);
    const next = frame(sent, { swapFloor: FLOOR, nodes: [THE_SOURCE] });
    expect(next.card).toBe('starting');
    expect(next.stepIndex).toBe(0);
  });

  it('a higher floor with machines on it is a Load that was already on its way, so the lesson waits', () => {
    const sent = reduce(IDLE, { type: 'newSent', lessonId: LESSON, floorAtSend: FLOOR }, LESSONS);
    const loaded = frame(sent, { nodes: [THE_SOURCE], swapFloor: FLOOR + 1 });
    expect(loaded.card).toBe('starting');
    expect(loaded.floor, 'the floor to beat is still the one at the send').toBe(FLOOR);

    const lessonBoard = frame(loaded, { swapFloor: FLOOR + 2 });
    expect(lessonBoard.card, "New's empty board starts the lesson").toBe('running');
    expect(lessonBoard.floor).toBe(FLOOR + 2);
    expect(lessonBoard.stepIndex).toBe(0);
    expect(lessonBoard.baseline?.knownKeys).toEqual([]);
    expect(frame(lessonBoard, { swapFloor: FLOOR + 2 }).card, 'and it reads no swap on the next frame').toBe('running');
  });

  it('a higher floor with only a belt on it is not the empty board either', () => {
    const sent = reduce(IDLE, { type: 'newSent', lessonId: LESSON, floorAtSend: FLOOR }, LESSONS);
    expect(frame(sent, { belts: [JOINED] }).card).toBe('starting');
  });
});

describe('reduce: steps in another order', () => {
  it('a Sink placed at step 1 finishes step 2 in the same reduce call that finishes step 1', () => {
    const withSink = frame(started(), { nodes: [THE_SINK] });
    expect(withSink.stepIndex, 'a Sink finishes nothing at step 1').toBe(0);
    const next = frame(withSink, { nodes: BOTH });
    expect(next.stepIndex).toBe(2);
    expect(next.bindings.source?.id).toBe(THE_SOURCE.id);
    expect(next.bindings.sink?.id).toBe(THE_SINK.id);
    expect(next.note).toEqual({ kind: 'skippedOne', a: 2, b: 2 });
  });

  it('a step finished the plain way carries no note', () => {
    expect(frame(started(), { nodes: [THE_SOURCE] }).note).toBeNull();
  });

  it('several steps finished at once read as a range', () => {
    const withBoth = frame(started(), { nodes: [THE_SINK] });
    const next = frame(withBoth, { nodes: BOTH, belts: [JOINED] }, TIMER);
    expect(next.stepIndex, 'it stops at press-play').toBe(4);
    expect(next.note).toEqual({ kind: 'skippedMany', a: 2, b: 4 });
  });

  it('the note goes when the next step finishes', () => {
    const skipped = frame(frame(started(), { nodes: [THE_SINK] }), { nodes: BOTH });
    expect(skipped.note).not.toBeNull();
    expect(frame(skipped, { nodes: BOTH }, TIMER).note).toBeNull();
  });

  it('a machine added earlier that no step claimed still counts as new', () => {
    const s = frame(started(), { nodes: [THE_SINK] });
    expect(s.baseline?.knownKeys).not.toContain('7@8,2');
  });

  it("step 1's Source isn't a candidate for a later Source step, because a bound key is known", () => {
    const s = frame(started(), { nodes: [THE_SOURCE] });
    expect(s.baseline?.knownKeys).toContain('0@2,2');
  });
});

describe('reduce: press-play and watch-items', () => {
  it('the frame that finishes draw-belt with a higher tick still stops at press-play', () => {
    const before = atStep(3);
    const next = frame(before, { nodes: BOTH, belts: [JOINED], tick: 500 }, TIMER);
    expect(before.stepIndex).toBe(3);
    expect(next.stepIndex).toBe(4);
    expect(next.baseline?.tick, 'the baseline tick is the frame press-play began on').toBe(500);
  });

  it('press-play holds on an equal tick', () => {
    const s = frame(atStep(4), { nodes: BOTH, belts: [JOINED], tick: 10 }, TIMER);
    expect(s.stepIndex).toBe(4);
  });

  it('press-play on a running board finishes on the next higher tick, with the alreadyRunning note', () => {
    const s = frame(atStep(4), { nodes: BOTH, belts: [JOINED], tick: 11 }, TIMER);
    expect(s.stepIndex).toBe(5);
    expect(s.note).toEqual({ kind: 'alreadyRunning', a: 5, b: 5 });
  });

  it('a user who pressed Play reads no note', () => {
    const paused = frame(atStep(3), { nodes: BOTH, belts: [JOINED], tick: 10 }, { ...TIMER, playing: false });
    expect(paused.stepIndex).toBe(4);
    expect(paused.baseline?.playing).toBe(false);
    const s = frame(paused, { nodes: BOTH, belts: [JOINED], tick: 11 }, { ...TIMER, playing: true });
    expect(s.stepIndex).toBe(5);
    expect(s.note).toBeNull();
  });

  it("watch-items doesn't finish in the call that begins it, whatever the belt holds", () => {
    const carrying: BoardBelt = { ...JOINED, items: 1, occupiedSlots: [9] };
    const s = frame(atStep(4), { nodes: BOTH, belts: [carrying], tick: 11 }, TIMER);
    expect(s.stepIndex).toBe(5);
    expect(s.card).toBe('running');
    expect(s.baseline?.lowestSlots, 'the lowest slot is taken when the step begins').toEqual({ sink: 9 });
  });

  it('the first delivery finishes the lesson', () => {
    const carrying = (slots: number[]): BoardBelt => ({ ...JOINED, items: slots.length, occupiedSlots: slots });
    let s = frame(atStep(4), { nodes: BOTH, belts: [carrying([5])], tick: 11 }, TIMER);
    s = frame(s, { nodes: BOTH, belts: [carrying([0])], tick: 12 }, TIMER);
    expect(s.card, 'an item at the head has not been taken yet').toBe('running');
    s = frame(s, { nodes: BOTH, belts: [carrying([])], tick: 13 }, TIMER);
    expect(s.card).toBe('finished');
  });

  it('a refused delivery holds the lesson on the watch step', () => {
    const held: BoardBelt = { ...JOINED, items: 3, occupiedSlots: [0, 1, 2] };
    let s = atStep(5);
    for (let tick = 20; tick < 40; tick++) s = frame(s, { nodes: BOTH, belts: [held], tick }, TIMER);
    expect(s.card).toBe('running');
    expect(s.stepIndex).toBe(5);
  });

  it('a keyframe between two frames looks like a rise and is not one', () => {
    const carrying = (slots: number[]): BoardBelt => ({ ...JOINED, items: slots.length, occupiedSlots: slots });
    let s = frame(atStep(4), { nodes: BOTH, belts: [carrying([0])], tick: 11 }, TIMER);
    s = frame(s, { nodes: BOTH, belts: [carrying([7])], tick: 12, generation: 2 }, TIMER);
    expect(s.card, 'the generation moved').toBe('running');
    expect(s.baseline?.generation).toBe(2);
    expect(s.baseline?.lowestSlots, 'the read starts again from the new frame').toEqual({ sink: 7 });
    s = frame(s, { nodes: BOTH, belts: [carrying([])], tick: 13, generation: 2 }, TIMER);
    expect(s.card, 'a real rise after it still counts').toBe('finished');
  });

  it('reduce returns the same object when nothing changed, so the layer can skip work', () => {
    const s = atStep(5);
    const again = frame(s, { nodes: BOTH, belts: [JOINED], tick: 12 }, TIMER);
    expect(again.baseline?.lowestSlots).toEqual(s.baseline?.lowestSlots);
    expect(frame(again, { nodes: BOTH, belts: [JOINED], tick: 13 }, TIMER)).toBe(again);
  });
});

describe('reduce: bindings follow a re-minted handle', () => {
  it('finds a bound machine by key when its handle changes', () => {
    const s = frame(started(), { nodes: [THE_SOURCE] });
    const reminted = node(40, SOURCE, 2, 2);
    const next = frame(s, { nodes: [reminted] });
    expect(next.bindings.source).toEqual({ nodeKey: '0@2,2', id: 40 });
  });

  it("a machine that's gone loses its binding, because its step has to be done again", () => {
    const s = frame(started(), { nodes: [THE_SOURCE] });
    const next = frame(s, { nodes: [] });
    expect(next.bindings.source).toBeUndefined();
    expect(next.stepIndex).toBe(0);
  });

  it('follows the bound belt through re-minted machines', () => {
    const s = atStep(4);
    expect(s.bindings.belt?.id).toBe(JOINED.id);
    const source = node(41, SOURCE, 2, 2);
    const sink = node(42, SINK, 8, 2);
    const belt: BoardBelt = {
      ...JOINED,
      id: 43,
      docks: [
        { end: 'Tail', node: 41, port: 0 },
        { end: 'Head', node: 42, port: 0 },
      ],
    };
    const next = frame(s, { nodes: [source, sink], belts: [belt], tick: 10, generation: 2 }, { appliedTrigger: { node: 41, kind: 'Timer' } });
    expect(next.bindings.belt?.id).toBe(43);
    expect(next.bindings.source?.id).toBe(41);
    expect(next.bindings.sink?.id).toBe(42);
  });
});

describe('reduce: a line drawn in two pieces', () => {
  const FIRST_PIECE: BoardBelt = {
    id: 20,
    items: 0,
    occupiedSlots: [],
    tiles: [],
    docks: [
      { end: 'Head', node: 21, port: 0 },
      { end: 'Tail', node: THE_SOURCE.id, port: 0 },
    ],
  };
  const SECOND_PIECE: BoardBelt = {
    id: 21,
    items: 0,
    occupiedSlots: [],
    tiles: [],
    docks: [
      { end: 'Head', node: THE_SINK.id, port: 0 },
      { end: 'Tail', node: 20, port: 0 },
    ],
  };
  const PIECES = [FIRST_PIECE, SECOND_PIECE];
  const drawn = (): TutorialState => frame(atStep(3), { nodes: BOTH, belts: PIECES }, TIMER);

  it('finishes the belt step', () => {
    const s = drawn();
    expect(s.stepIndex).toBe(4);
    expect(s.note).toBeNull();
    expect(s.bindings.belt?.id).toBe(SECOND_PIECE.id);
  });

  it('stays finished on later frames', () => {
    const s = frame(drawn(), { nodes: BOTH, belts: PIECES, tick: 11 }, TIMER);
    expect(s.stepIndex).toBe(5);
    expect(s.note?.kind).not.toBe('wentBack');
  });

  it('goes back to the belt step when either piece is taken away', () => {
    for (const left of PIECES) {
      const s = frame(drawn(), { nodes: BOTH, belts: [left] }, TIMER);
      expect(s.stepIndex, `with only belt ${left.id}`).toBe(3);
      expect(s.note).toEqual({ kind: 'wentBack', a: 4, b: 4 });
    }
  });

  it('follows the bound piece through a re-mint', () => {
    const source = node(41, SOURCE, 2, 2);
    const sink = node(42, SINK, 8, 2);
    const first: BoardBelt = { ...FIRST_PIECE, id: 43, docks: [{ end: 'Head', node: 44, port: 0 }, { end: 'Tail', node: 41, port: 0 }] };
    const second: BoardBelt = { ...SECOND_PIECE, id: 44, docks: [{ end: 'Head', node: 42, port: 0 }, { end: 'Tail', node: 43, port: 0 }] };
    const s = frame(drawn(), { nodes: [source, sink], belts: [first, second], generation: 2 }, { appliedTrigger: { node: 41, kind: 'Timer' } });
    expect(s.stepIndex).toBe(4);
    expect(s.bindings.belt?.id).toBe(44);
  });

  it('finishes the lesson when an item leaves the piece that runs into the Sink', () => {
    const carrying = (slots: number[]): BoardBelt => ({ ...SECOND_PIECE, items: slots.length, occupiedSlots: slots });
    let s = frame(drawn(), { nodes: BOTH, belts: [FIRST_PIECE, carrying([0])], tick: 11 }, TIMER);
    expect(s.stepIndex).toBe(5);
    s = frame(s, { nodes: BOTH, belts: [FIRST_PIECE, carrying([])], tick: 12 }, TIMER);
    expect(s.card).toBe('finished');
  });
});

describe('currentStage', () => {
  const stageOf = (s: TutorialState, b: Partial<BoardFacts>, c: Partial<ChromeFacts>): string | undefined =>
    currentStage(s, board(b), chrome(c), LESSONS)?.id;

  it('walks step 3 through its four stages', () => {
    const s = atStep(2);
    const b = { nodes: BOTH };
    expect(stageOf(s, b, { armed: { kind: 'machine', machineKind: SINK } })).toBe('tool-down');
    expect(stageOf(s, b, {})).toBe('select-source');
    expect(stageOf(s, b, { selectedNode: THE_SINK.id }), 'the wrong machine selected').toBe('select-source');
    expect(stageOf(s, b, { selectedNode: THE_SOURCE.id })).toBe('press-timer');
    expect(stageOf(s, b, { selectedNode: THE_SOURCE.id, triggerPressed: 'Webhook' })).toBe('press-timer');
    expect(stageOf(s, b, { selectedNode: THE_SOURCE.id, triggerPressed: 'Timer' })).toBe('apply-timer');
    expect(
      stageOf(s, b, { selectedNode: THE_SOURCE.id, triggerPressed: 'Timer', appliedTrigger: { node: THE_SOURCE.id, kind: 'Webhook' } }),
      'pressing Timer with the host still on Webhook waits for Apply',
    ).toBe('apply-timer');
  });

  it('walks step 4 through the tool and the drag', () => {
    const s = atStep(3);
    expect(stageOf(s, { nodes: BOTH }, {})).toBe('belt-tool');
    expect(stageOf(s, { nodes: BOTH }, { armed: { kind: 'machine', machineKind: SINK } }), 'another tool').toBe('belt-tool');
    expect(stageOf(s, { nodes: BOTH }, { armed: { kind: 'belt' } })).toBe('belt-draw');
  });

  describe('a belt that left the Source and stopped short', () => {
    const tilesOf = (...xs: number[]): BoardBelt['tiles'] => xs.map((cell_x) => ({ cell_x, cell_y: 2 }));
    const SHORT: BoardBelt = { ...JOINED, tiles: tilesOf(3, 4), docks: [{ end: 'Tail', node: THE_SOURCE.id, port: 0 }] };
    const ARMED = { armed: { kind: 'belt' } as const };

    it('stops asking for a drag from the output that belt already holds', () => {
      expect(stageOf(atStep(3), { nodes: BOTH, belts: [SHORT] }, ARMED)).toBe('belt-carry-on');
    });

    it('asks for the tool first, and for Play before that', () => {
      const s = atStep(3);
      expect(stageOf(s, { nodes: BOTH, belts: [SHORT] }, {})).toBe('belt-tool');
      expect(stageOf(s, { nodes: BOTH, belts: [SHORT] }, { ...ARMED, playing: false })).toBe('board-paused');
    });

    it('holds through a second piece that also stops short', () => {
      const first: BoardBelt = { ...SHORT, docks: [...SHORT.docks, { end: 'Head', node: 30, port: 0 }] };
      const second: BoardBelt = { ...JOINED, id: 30, tiles: tilesOf(5, 6), docks: [{ end: 'Tail', node: first.id, port: 0 }] };
      expect(stageOf(atStep(3), { nodes: BOTH, belts: [first, second] }, ARMED)).toBe('belt-carry-on');
    });

    it('holds for the packet where the last piece touches the Sink and has not docked', () => {
      const first: BoardBelt = { ...SHORT, docks: [...SHORT.docks, { end: 'Head', node: 30, port: 0 }] };
      const touching: BoardBelt = { ...JOINED, id: 30, tiles: tilesOf(5, 6, 7), docks: [{ end: 'Tail', node: first.id, port: 0 }] };
      expect(THE_SINK.cells[0]?.[0], 'its next cell is the Sink').toBe(8);
      expect(stageOf(atStep(3), { nodes: BOTH, belts: [first, touching] }, { ...ARMED, editsInFlight: true })).toBe('belt-carry-on');
    });

    it('asks for Undo when that belt has no end a press can carry on from', () => {
      const s = atStep(3);
      expect(stageOf(s, { nodes: BOTH, belts: [{ ...SHORT, tiles: tilesOf(3) }] }, ARMED), 'a single tile').toBe('belt-undo');
      const intoAnother: BoardBelt = { ...SHORT, docks: [...SHORT.docks, { end: 'Head', node: 123, port: 0 }] };
      expect(stageOf(s, { nodes: BOTH, belts: [intoAnother] }, ARMED), 'a line into another machine').toBe('belt-undo');
    });

    it('asks for Undo when the belt points at the top of the Sink, where no ring can show', () => {
      const down: BoardBelt = { ...SHORT, tiles: [{ cell_x: 8, cell_y: 0 }, { cell_x: 8, cell_y: 1 }] };
      expect(stageOf(atStep(3), { nodes: BOTH, belts: [down] }, ARMED)).toBe('belt-undo');
    });

    it('asks for Undo when a short piece was drawn backwards from the Sink', () => {
      const backward: BoardBelt = { ...JOINED, tiles: tilesOf(6, 7), docks: [{ end: 'Head', node: THE_SINK.id, port: 0 }] };
      expect(stageOf(atStep(3), { nodes: BOTH, belts: [backward] }, ARMED)).toBe('belt-undo');
    });

    describe('while the user undoes it', () => {
      const ONE_TILE: BoardBelt = { ...SHORT, tiles: tilesOf(3) };
      const LOOSE: BoardBelt = { ...ONE_TILE, docks: [] };
      const run = (s: TutorialState, belts: readonly BoardBelt[]): TutorialState => frame(s, { nodes: BOTH, belts }, { ...TIMER, ...ARMED });
      const shown = (s: TutorialState, belts: readonly BoardBelt[]): string | undefined => stageOf(s, { nodes: BOTH, belts }, ARMED);

      it('stays on the undo card when the first press leaves the belt with no docks', () => {
        const stuck = run(atStep(3), [ONE_TILE]);
        expect(shown(stuck, [ONE_TILE])).toBe('belt-undo');
        const firstPress = run(stuck, [LOOSE]);
        expect(shown(firstPress, [LOOSE]), 'the plain drag would be refused here').toBe('belt-undo');
        const secondPress = run(firstPress, []);
        expect(shown(secondPress, []), 'the belt has gone').toBe('belt-draw');
      });

      it('does the same for a backward piece on the input doorstep', () => {
        const backward: BoardBelt = { ...JOINED, tiles: tilesOf(6, 7), docks: [{ end: 'Head', node: THE_SINK.id, port: 0 }] };
        const loose: BoardBelt = { ...backward, docks: [] };
        const firstPress = run(run(atStep(3), [backward]), [loose]);
        expect(shown(firstPress, [loose])).toBe('belt-undo');
      });

      it("doesn't flash the undo card while a good draw's docks are on the way", () => {
        const whole: BoardBelt = { ...JOINED, tiles: tilesOf(3, 4, 5, 6, 7), docks: [] };
        const inFlight = { ...ARMED, editsInFlight: true };
        const s = frame(atStep(3), { nodes: BOTH, belts: [whole] }, { ...TIMER, ...inFlight });
        expect(stageOf(s, { nodes: BOTH, belts: [whole] }, inFlight)).toBe('belt-draw');
      });

      it("doesn't flash it on the good draw after an undo either", () => {
        const cleared = run(run(run(atStep(3), [ONE_TILE]), [LOOSE]), []);
        const whole: BoardBelt = { ...JOINED, tiles: tilesOf(3, 4, 5, 6, 7), docks: [] };
        const inFlight = { ...ARMED, editsInFlight: true };
        const s = frame(cleared, { nodes: BOTH, belts: [whole] }, { ...TIMER, ...inFlight });
        expect(stageOf(s, { nodes: BOTH, belts: [whole] }, inFlight)).toBe('belt-draw');
      });

      it('asks for Undo when two presses in one frame leave the belt with no docks', () => {
        const whole: BoardBelt = { ...JOINED, tiles: tilesOf(3, 4, 5, 6, 7) };
        const loose: BoardBelt = { ...whole, docks: [] };
        const s = frame(atStep(5), { nodes: BOTH, belts: [loose] }, { ...TIMER, ...ARMED });
        expect(s.stepIndex).toBe(3);
        expect(shown(s, [loose])).toBe('belt-undo');
      });
    });

    describe('a finished line taken back by Undo', () => {
      const run = (s: TutorialState, belts: readonly BoardBelt[]): TutorialState => frame(s, { nodes: BOTH, belts }, { ...TIMER, ...ARMED });
      const shown = (s: TutorialState, belts: readonly BoardBelt[]): string | undefined => stageOf(s, { nodes: BOTH, belts }, ARMED);
      const WHOLE: BoardBelt = { ...JOINED, tiles: tilesOf(3, 4, 5, 6, 7) };
      const TAIL_ONLY: BoardBelt = { ...WHOLE, docks: [{ end: 'Tail', node: THE_SOURCE.id, port: 0 }] };
      const HEAD_ONLY: BoardBelt = { ...WHOLE, docks: [{ end: 'Head', node: THE_SINK.id, port: 0 }] };
      const LOOSE: BoardBelt = { ...WHOLE, docks: [] };

      it('keeps the undo card through each press until the belt has gone, then asks for the plain drag', () => {
        const first = run(atStep(5), [TAIL_ONLY]);
        expect(first.stepIndex, 'the lesson went back to the belt').toBe(3);
        expect(shown(first, [TAIL_ONLY]), 'its last tile rests on the doorstep and nothing will dock it').toBe('belt-undo');
        const second = run(first, [LOOSE]);
        expect(shown(second, [LOOSE]), 'the belt still takes the output and the input').toBe('belt-undo');
        const third = run(second, []);
        expect(shown(third, []), 'the belt has gone').toBe('belt-draw');
      });

      it('keeps the card on a later frame too, because the state lasts until the next press', () => {
        const first = run(run(atStep(5), [TAIL_ONLY]), [TAIL_ONLY]);
        expect(shown(first, [TAIL_ONLY])).toBe('belt-undo');
      });

      it('does the same when the press leaves the Head dock and takes the Tail dock', () => {
        const first = run(atStep(5), [HEAD_ONLY]);
        expect(first.stepIndex).toBe(3);
        expect(shown(first, [HEAD_ONLY])).toBe('belt-undo');
      });

      it('sends a line of two pieces to Undo, and back to carrying on once the second piece has gone', () => {
        const fromSource: BoardBelt = { ...JOINED, id: 9, tiles: tilesOf(3, 4), docks: [{ end: 'Tail', node: THE_SOURCE.id, port: 0 }] };
        const intoSecond: BoardBelt = { ...fromSource, docks: [...fromSource.docks, { end: 'Head', node: 30, port: 0 }] };
        const secondJoined: BoardBelt = {
          ...JOINED,
          id: 30,
          tiles: tilesOf(5, 6, 7),
          docks: [
            { end: 'Tail', node: 9, port: 0 },
            { end: 'Head', node: THE_SINK.id, port: 0 },
          ],
        };
        const secondTailOnly: BoardBelt = { ...secondJoined, docks: [{ end: 'Tail', node: 9, port: 0 }] };
        const secondLoose: BoardBelt = { ...secondJoined, docks: [] };
        const line = run(atStep(3), [intoSecond, secondJoined]);
        expect(line.stepIndex).toBeGreaterThan(3);
        const first = run(line, [intoSecond, secondTailOnly]);
        expect(first.stepIndex).toBe(3);
        expect(shown(first, [intoSecond, secondTailOnly]), 'the second piece rests on the doorstep').toBe('belt-undo');
        const second = run(first, [fromSource, secondLoose]);
        expect(shown(second, [fromSource, secondLoose]), 'the second piece sits on the cell the first would carry on into').toBe('belt-undo');
        const third = run(second, [fromSource]);
        expect(shown(third, [fromSource]), 'the first piece has a free end again').toBe('belt-carry-on');
      });
    });

    it('asks for the tool first, and for Play before that, even with a belt that needs undoing', () => {
      const s = atStep(3);
      const one: BoardBelt = { ...SHORT, tiles: tilesOf(3) };
      expect(stageOf(s, { nodes: BOTH, belts: [one] }, {})).toBe('belt-tool');
      expect(stageOf(s, { nodes: BOTH, belts: [one] }, { ...ARMED, playing: false })).toBe('board-paused');
    });

    it('stays on the plain drag for a belt that left some other machine', () => {
      const other: BoardBelt = { ...SHORT, docks: [{ end: 'Tail', node: 123, port: 0 }] };
      expect(stageOf(atStep(3), { nodes: BOTH, belts: [other] }, ARMED)).toBe('belt-draw');
    });

    it('moves the lesson on once the line reaches the Sink', () => {
      const first: BoardBelt = { ...SHORT, docks: [...SHORT.docks, { end: 'Head', node: 30, port: 0 }] };
      const second: BoardBelt = {
        ...JOINED,
        id: 30,
        tiles: tilesOf(5, 6, 7),
        docks: [
          { end: 'Tail', node: first.id, port: 0 },
          { end: 'Head', node: THE_SINK.id, port: 0 },
        ],
      };
      const held = frame(atStep(3), { nodes: BOTH, belts: [SHORT] }, { ...TIMER, ...ARMED });
      expect(held.stepIndex, 'the short piece finishes nothing').toBe(3);
      expect(frame(held, { nodes: BOTH, belts: [first, second] }, { ...TIMER, ...ARMED }).stepIndex).toBe(4);
    });
  });

  it('puts the paused stage first in steps 3, 4, 5 and 6', () => {
    for (const index of [2, 3, 4, 5]) {
      const s = atStep(index);
      expect(stageOf(s, { nodes: BOTH }, { playing: false }), `step ${index + 1}`).toBe('board-paused');
    }
  });

  it('gives a running board a stage at step 5, so its one frame still has a stage', () => {
    expect(stageOf(atStep(4), { nodes: BOTH }, {})).toBe('board-running');
  });

  it('shows the watch stage at step 6', () => {
    expect(stageOf(atStep(5), { nodes: BOTH }, {})).toBe('watch');
  });
});

describe('viewKey', () => {
  it('stays put when only the lowest slot moves, because a person sees no change', () => {
    const carrying = (slots: number[]): BoardBelt => ({ ...JOINED, items: slots.length, occupiedSlots: slots });
    const a = frame(atStep(4), { nodes: BOTH, belts: [carrying([9])], tick: 11 }, TIMER);
    const b = frame(a, { nodes: BOTH, belts: [carrying([8])], tick: 12 }, TIMER);
    expect(b).not.toBe(a);
    expect(viewKey(b)).toBe(viewKey(a));
  });

  it('changes with the step, the card, the note and the bound handles', () => {
    const s = atStep(2);
    expect(viewKey({ ...s, stepIndex: 3 })).not.toBe(viewKey(s));
    expect(viewKey({ ...s, card: 'finished' })).not.toBe(viewKey(s));
    expect(viewKey({ ...s, note: { kind: 'skippedOne', a: 2, b: 2 } })).not.toBe(viewKey(s));
    expect(viewKey({ ...s, bindings: { ...s.bindings, source: { nodeKey: '0@2,2', id: 99 } } })).not.toBe(viewKey(s));
    expect(viewKey({ ...s, spot: { stageId: 'x', cell: [1, 1] } })).not.toBe(viewKey(s));
  });
});

describe('noteTokens', () => {
  it('reads the copy for each note', () => {
    expect(phrasePlain(noteTokens({ kind: 'skippedOne', a: 2, b: 2 }))).toBe('Step 2 was already done, so the lesson moved on.');
    expect(phrasePlain(noteTokens({ kind: 'skippedMany', a: 2, b: 4 }))).toBe('Steps 2 to 4 were already done, so the lesson moved on.');
    expect(phrasePlain(noteTokens({ kind: 'alreadyRunning', a: 5, b: 5 }))).toBe(
      'The board was already running, so step 5 is done. Space pauses it.',
    );
  });

  it('keeps each note inside its budget', () => {
    for (const note of [
      { kind: 'skippedOne', a: 2, b: 2 },
      { kind: 'skippedMany', a: 2, b: 4 },
      { kind: 'alreadyRunning', a: 5, b: 5 },
    ] as const) {
      expect(phrasePlain(noteTokens(note)).length).toBeLessThanOrEqual(MAX_NOTE_CHARS);
    }
  });

  it('names the pause key through the table', () => {
    const tables = {
      shortcuts: { playPause: { label: 'Tab' } },
      kinds: {},
    } as unknown as Parameters<typeof phrasePlain>[1];
    expect(phrasePlain(noteTokens({ kind: 'alreadyRunning', a: 5, b: 5 }), tables)).toContain('Tab pauses it.');
  });
});

describe('floorSpot', () => {
  const sourceAt = (x: number, y: number): string => `0@${x},${y}`;

  it('puts the Sink six cells east on the same row by default', () => {
    expect(floorSpot({ spot: 'sink', view: VIEW, board: board(), sourceKey: sourceAt(2, 2) })).toEqual([8, 2]);
  });

  it("goes six cells west past the free area's right edge", () => {
    const view = { ...VIEW, freeArea: { ...VIEW.freeArea, right: 200 } };
    expect(floorSpot({ spot: 'sink', view, board: board(), sourceKey: sourceAt(2, 2) })).toEqual([-4, 2]);
  });

  it('goes one row down when that cell is taken', () => {
    const b = board({ nodes: [node(1, SINK, 8, 2)] });
    expect(floorSpot({ spot: 'sink', view: VIEW, board: b, sourceKey: sourceAt(2, 2) })).toEqual([8, 3]);
  });

  it('keeps going down when that row is taken too', () => {
    const b = board({ nodes: [node(1, SINK, 8, 2), node(2, SINK, 8, 3)] });
    expect(floorSpot({ spot: 'sink', view: VIEW, board: b, sourceKey: sourceAt(2, 2) })).toEqual([8, 4]);
  });

  it("is never the Source's own cell, at any zoom or window width", () => {
    const source = node(1, SOURCE, 3, 3);
    for (const scale of [0.25, 0.5, 1, 2, 4]) {
      for (const right of [10, 100, 400, 1000, 4000]) {
        const view = { camera: { x: 0, y: 0, scale }, freeArea: { left: 0, right, top: 0, bottom: 600 } };
        const spot = floorSpot({ spot: 'sink', view, board: board({ nodes: [source] }), sourceKey: sourceAt(3, 3) });
        expect(spot, `scale ${scale}, right ${right}`).not.toEqual([3, 3]);
      }
    }
  });

  it('goes one row down when a belt tile holds that cell, because the host refuses a Place there too', () => {
    const b = board({ belts: [{ ...JOINED, tiles: [7, 8, 9].map((x) => ({ cell_x: x, cell_y: 2 })) }] });
    expect(floorSpot({ spot: 'sink', view: VIEW, board: b, sourceKey: sourceAt(2, 2) })).toEqual([8, 3]);
  });

  it('keeps going down past a machine and a belt in turn', () => {
    const b = board({
      nodes: [node(1, SINK, 8, 2)],
      belts: [{ ...JOINED, tiles: [{ cell_x: 8, cell_y: 3 }] }],
    });
    expect(floorSpot({ spot: 'sink', view: VIEW, board: b, sourceKey: sourceAt(2, 2) })).toEqual([8, 4]);
  });

  it('moves the Source spot down when a belt runs through it', () => {
    const free = floorSpot({ spot: 'source', view: VIEW, board: board() });
    const taken = floorSpot({
      spot: 'source',
      view: VIEW,
      board: board({ belts: [{ ...JOINED, tiles: [{ cell_x: free[0], cell_y: free[1] }] }] }),
    });
    expect(taken).toEqual([free[0], free[1] + 1]);
  });

  it('moves the Source spot down when a machine already sits there', () => {
    const free = floorSpot({ spot: 'source', view: VIEW, board: board() });
    const taken = floorSpot({
      spot: 'source',
      view: VIEW,
      board: board({ nodes: [node(1, SINK, free[0], free[1])] }),
    });
    expect(taken).toEqual([free[0], free[1] + 1]);
  });
});

const SINK_KEY = '7@8,2';
const SOURCE_KEY = '0@2,2';

describe('reduce: a swapped board', () => {
  it('a higher swap floor while running moves the card to swapped', () => {
    const s = frame(atStep(2), { nodes: BOTH, swapFloor: FLOOR + 2, generation: 7 });
    expect(s.card).toBe('swapped');
    expect(s.stepIndex, 'the lesson keeps its place').toBe(2);
  });

  it("the lesson's own swap isn't a swap: the floor it started on stays the lesson's floor", () => {
    const s = frame(frame(started(), { nodes: [THE_SOURCE], swapFloor: FLOOR + 1 }), { nodes: [THE_SOURCE], swapFloor: FLOOR + 1 });
    expect(s.card).toBe('running');
    expect(s.floor, 'the floor of the board the lesson runs on').toBe(FLOOR + 1);
  });

  it('Undo raises the generation and not the swap floor, and the card stays running', () => {
    const s = atStep(2);
    const undone = frame(s, { nodes: BOTH, generation: 2 });
    expect(undone.card).toBe('running');
    expect(undone.stepIndex).toBe(2);
    expect(undone.note).toBeNull();
  });

  it('a swapped card never carries on against that board', () => {
    const swapped = frame(atStep(0), { swapFloor: FLOOR + 2 });
    expect(swapped.card).toBe('swapped');
    const next = frame(swapped, { nodes: [THE_SOURCE], swapFloor: FLOOR + 2 });
    expect(next).toBe(swapped);
  });

  it('a finished card stays finished when the board is swapped', () => {
    const finished = { ...atStep(5), card: 'finished' as const };
    expect(frame(finished, { swapFloor: FLOOR + 2 }).card).toBe('finished');
  });

  it('a swapped card has no stage, so the ring has nothing to mark', () => {
    const swapped = frame(atStep(2), { nodes: BOTH, swapFloor: FLOOR + 2 });
    expect(currentStage(swapped, board({ nodes: BOTH }), chrome(), LESSONS)).toBeNull();
  });
});

describe('reduce: leave and resume', () => {
  const left = (s: TutorialState): TutorialState => reduce(s, { type: 'left' }, LESSONS);
  const resumed = (s: TutorialState): TutorialState => reduce(s, { type: 'resumed' }, LESSONS);

  it('leaving records the floor the lesson runs on', () => {
    const s = left(atStep(1));
    expect(s.card).toBe('none');
    expect(s.leftFloor).toBe(FLOOR + 1);
    expect(s.stepIndex, 'the saved step stays').toBe(1);
    expect(s.bindings.source?.nodeKey, 'and the bindings').toBe(SOURCE_KEY);
  });

  it('leaving a swapped card records no floor, so it can never resume', () => {
    expect(left(frame(atStep(2), { nodes: BOTH, swapFloor: FLOOR + 2 })).leftFloor).toBeNull();
  });

  it('leaving a lesson still starting records no floor: it has no step to come back to', () => {
    const sent = reduce(IDLE, { type: 'newSent', lessonId: LESSON, floorAtSend: FLOOR }, LESSONS);
    expect(left(sent).leftFloor).toBeNull();
  });

  it('Resume with nothing changed puts the card back on the saved step, with no note', () => {
    const s = frame(resumed(left(atStep(1))), { nodes: [THE_SOURCE] });
    expect(s.card).toBe('running');
    expect(s.stepIndex).toBe(1);
    expect(s.note).toBeNull();
    expect(s.leftFloor, 'it is no longer left').toBeNull();
  });

  it('a Source placed while left finishes step 1 on Resume, and the note says so', () => {
    const s = frame(resumed(left(atStep(0))), { nodes: [THE_SOURCE] });
    expect(s.stepIndex).toBe(1);
    expect(s.note).toEqual({ kind: 'skippedOne', a: 1, b: 1 });
    expect(s.bindings.source?.id).toBe(THE_SOURCE.id);
  });

  it('several steps done while left read as a range from the saved step', () => {
    const s = frame(resumed(left(atStep(0))), { nodes: BOTH });
    expect(s.stepIndex).toBe(2);
    expect(s.note).toEqual({ kind: 'skippedMany', a: 1, b: 2 });
  });

  it('only the first frame after Resume reads as a re-check', () => {
    const first = frame(resumed(left(atStep(0))), {});
    expect(first.stepIndex).toBe(0);
    const later = frame(first, { nodes: [THE_SOURCE] });
    expect(later.stepIndex).toBe(1);
    expect(later.note, 'a step the user does after Resume carries no note').toBeNull();
  });

  it('a board swapped while left stops the lesson on Resume, whatever the list showed', () => {
    const s = frame(resumed(left(atStep(1))), { nodes: [THE_SOURCE], swapFloor: FLOOR + 2 });
    expect(s.card).toBe('swapped');
  });

  it('Resume means nothing with no lesson left', () => {
    expect(resumed(IDLE)).toBe(IDLE);
    const running = atStep(1);
    expect(resumed(running)).toBe(running);
  });

  describe('a trigger applied while left', () => {
    const LEFT_AT_TIMER = (): TutorialState => left(atStep(2));

    it('finishes the Timer step with a note, when the first answer after Resume reads Timer', () => {
      const waiting = frame(resumed(LEFT_AT_TIMER()), { nodes: BOTH }, { appliedTrigger: null });
      expect(waiting.stepIndex, 'no answer yet finishes nothing').toBe(2);
      expect(waiting.note).toBeNull();
      const s = frame(waiting, { nodes: BOTH }, TIMER);
      expect(s.stepIndex).toBe(3);
      expect(s.note).toEqual({ kind: 'skippedOne', a: 3, b: 3 });
    });

    it('widens the note when the machines were also placed while left', () => {
      const first = frame(resumed(left(atStep(1))), { nodes: BOTH }, { appliedTrigger: null });
      expect(first.stepIndex, 'the Sink finished its step on the first frame').toBe(2);
      expect(first.note).toEqual({ kind: 'skippedOne', a: 2, b: 2 });
      const s = frame(first, { nodes: BOTH }, TIMER);
      expect(s.stepIndex).toBe(3);
      expect(s.note).toEqual({ kind: 'skippedMany', a: 2, b: 3 });
    });

    it('ends the re-check on a Webhook answer, so a Timer applied after it carries no note', () => {
      const webhook = { appliedTrigger: { node: THE_SOURCE.id, kind: 'Webhook' as const } };
      const answered = frame(resumed(LEFT_AT_TIMER()), { nodes: BOTH }, webhook);
      expect(answered.stepIndex).toBe(2);
      const s = frame(answered, { nodes: BOTH }, TIMER);
      expect(s.stepIndex).toBe(3);
      expect(s.note, 'the user applied this one with the card on screen').toBeNull();
    });

    it('waits through an answer about an older handle', () => {
      const old = { appliedTrigger: { node: 99, kind: 'Webhook' as const } };
      const waiting = frame(resumed(LEFT_AT_TIMER()), { nodes: BOTH }, old);
      const s = frame(waiting, { nodes: BOTH }, TIMER);
      expect(s.note).toEqual({ kind: 'skippedOne', a: 3, b: 3 });
    });

    it('a Timer step reached live is no re-check', () => {
      const s = frame(atStep(2), { nodes: BOTH }, TIMER);
      expect(s.stepIndex).toBe(3);
      expect(s.note).toBeNull();
    });
  });

  describe('the floor spot across a leave', () => {
    const SINK_ARMED = { armed: { kind: 'machine', machineKind: SINK } } as const;
    /** Left at the Sink's floor stage, with the ring on its spot. */
    const leftAtSinkFloor = (): TutorialState => left(frame(atStep(1), { nodes: [THE_SOURCE] }, SINK_ARMED));

    it('is worked out again from the board as it stands', () => {
      const before = leftAtSinkFloor();
      expect(before.spot?.cell, 'the spot before the leave').toEqual([8, 2]);
      const inTheWay = node(6, 3, 8, 2);
      const s = frame(resumed(before), { nodes: [THE_SOURCE, inTheWay] }, SINK_ARMED);
      expect(s.spot?.cell, 'a machine now holds the old spot').toEqual([8, 3]);
    });

    it('is the same cell when nothing took it', () => {
      const s = frame(resumed(leftAtSinkFloor()), { nodes: [THE_SOURCE] }, SINK_ARMED);
      expect(s.spot?.cell).toEqual([8, 2]);
    });
  });

  it('a result removed while left sends the lesson back on Resume', () => {
    const s = frame(resumed(left(atStep(2))), { nodes: [THE_SINK] });
    expect(s.stepIndex).toBe(0);
    expect(s.note).toEqual({ kind: 'wentBack', a: 1, b: 1 });
  });
});

describe('reduce: going back', () => {
  it('removing a bound Source at step 3 returns to step 1 with the wentBack note', () => {
    const s = frame(atStep(2), { nodes: [THE_SINK], generation: 2 });
    expect(s.stepIndex).toBe(0);
    expect(s.card).toBe('running');
    expect(s.note).toEqual({ kind: 'wentBack', a: 1, b: 1 });
  });

  it('clears the bindings from that step on and forgets their keys', () => {
    const s = frame(atStep(2), { nodes: [THE_SINK], generation: 2 });
    expect(s.bindings).toEqual({});
    expect(s.baseline?.knownKeys, 'the Sink still there can finish its step again').not.toContain(SINK_KEY);
    expect(s.baseline?.knownKeys).not.toContain(SOURCE_KEY);
  });

  it('removing the Sink at step 3 keeps the Source and returns to step 2', () => {
    const s = frame(atStep(2), { nodes: [THE_SOURCE], generation: 2 });
    expect(s.stepIndex).toBe(1);
    expect(s.note).toEqual({ kind: 'wentBack', a: 2, b: 2 });
    expect(s.bindings.source?.id, 'the earlier binding stands').toBe(THE_SOURCE.id);
    expect(s.bindings.sink).toBeUndefined();
    expect(s.baseline?.knownKeys).toContain(SOURCE_KEY);
    expect(s.baseline?.knownKeys).not.toContain(SINK_KEY);
  });

  it('the earliest gone step wins', () => {
    expect(frame(atStep(4), { nodes: [], generation: 2 }).stepIndex).toBe(0);
  });

  it('a host answer reading Webhook returns to the Timer step', () => {
    const s = frame(atStep(3), { nodes: BOTH }, { appliedTrigger: { node: THE_SOURCE.id, kind: 'Webhook' } });
    expect(s.stepIndex).toBe(2);
    expect(s.note).toEqual({ kind: 'wentBack', a: 3, b: 3 });
    expect(s.bindings.source?.id, 'the machines stay bound').toBe(THE_SOURCE.id);
    expect(s.bindings.sink?.id).toBe(THE_SINK.id);
  });

  it("no answer about the trigger isn't an answer of Webhook", () => {
    expect(frame(atStep(3), { nodes: BOTH }, { appliedTrigger: null }).stepIndex).toBe(3);
  });

  it("an answer about another handle says nothing about the bound Source", () => {
    expect(frame(atStep(3), { nodes: BOTH }, { appliedTrigger: { node: 99, kind: 'Webhook' } }).stepIndex).toBe(3);
  });

  it('a belt no longer joining its machines returns to the belt step', () => {
    const s = frame(atStep(4), { nodes: BOTH, belts: [], tick: 10 }, TIMER);
    expect(s.stepIndex).toBe(3);
    expect(s.note).toEqual({ kind: 'wentBack', a: 4, b: 4 });
    expect(s.bindings.belt).toBeUndefined();
  });

  it("a machine put back by Undo counts again: the step it finished comes back with the note gone", () => {
    const back = frame(atStep(2), { nodes: [THE_SOURCE], generation: 2 });
    expect(back.stepIndex).toBe(1);
    const again = frame(back, { nodes: BOTH, generation: 3 });
    expect(again.stepIndex).toBe(2);
    expect(again.bindings.sink?.id).toBe(THE_SINK.id);
    expect(again.note).toBeNull();
  });

  it('a re-minted handle with the same kind and cell keeps its binding and sends nothing back', () => {
    const s = atStep(2);
    const reminted = [node(40, SOURCE, 2, 2), node(41, SINK, 8, 2)];
    const next = frame(s, { nodes: reminted, generation: 2 });
    expect(next.stepIndex).toBe(2);
    expect(next.note).toBeNull();
    expect(next.bindings.source).toEqual({ nodeKey: SOURCE_KEY, id: 40 });
    expect(next.bindings.sink).toEqual({ nodeKey: SINK_KEY, id: 41 });
  });

  it('a machine moved to another cell comes straight back to the same step with no note', () => {
    const moved = node(4, SOURCE, 3, 2);
    const s = frame(atStep(2), { nodes: [moved, THE_SINK], generation: 2 });
    expect(s.stepIndex).toBe(2);
    expect(s.note).toBeNull();
    expect(s.bindings.source?.nodeKey).toBe('0@3,2');
  });

  it('the latched steps send nothing back on their own: a falling tick and an empty belt', () => {
    const s = frame(atStep(5), { nodes: BOTH, belts: [JOINED], tick: 1 }, TIMER);
    expect(s.stepIndex).toBe(5);
  });

  it('a finished lesson goes nowhere when its machines go', () => {
    const finished = { ...atStep(5), card: 'finished' as const };
    expect(frame(finished, { nodes: [] }).stepIndex).toBe(5);
  });
});

describe('reduce: the end of a run', () => {
  it('cancelledRun forgets the run', () => {
    expect(reduce(atStep(2), { type: 'cancelledRun' }, LESSONS)).toEqual(IDLE);
  });

  it('a new lesson while one runs ends the running one', () => {
    const s = reduce(atStep(2), { type: 'newSent', lessonId: LESSON, floorAtSend: FLOOR + 1 }, LESSONS);
    expect(s.card).toBe('starting');
    expect(s.stepIndex).toBe(0);
    expect(s.bindings).toEqual({});
    expect(s.leftFloor).toBeNull();
  });
});

describe('noteTokens: going back', () => {
  it('reads the copy, inside its budget', () => {
    const text = phrasePlain(noteTokens({ kind: 'wentBack', a: 3, b: 3 }));
    expect(text).toBe('Step 3 needs doing again, so the lesson went back.');
    expect(text.length).toBeLessThanOrEqual(MAX_NOTE_CHARS);
  });
});

describe('rowViews', () => {
  const lessonNamed = (id: string): Lesson => ({ ...YOUR_FIRST_LINE, id: id as LessonId, title: id });
  const FIVE = ['one', 'two', 'three', 'four', 'five'].map(lessonNamed);
  const ONE = [YOUR_FIRST_LINE];
  const SWAP = FLOOR + 1;
  const NOTHING: Progress = EMPTY_PROGRESS;
  const stored = (status: 'inProgress' | 'done', ...ids: string[]): Progress => ({
    version: 1,
    lessons: Object.fromEntries(ids.map((id) => [id, status])) as Progress['lessons'],
  });
  const rows = (over: Partial<Parameters<typeof rowViews>[0]> = {}): RowView[] =>
    rowViews({ lessons: ONE, progress: NOTHING, state: IDLE, swapFloor: SWAP, simStopped: false, ...over });
  const leftRun = (): TutorialState => reduce(atStep(1), { type: 'left' }, LESSONS);

  it('not started: Start, in the accent', () => {
    expect(rows()[0]).toEqual({ id: LESSON, title: YOUR_FIRST_LINE.title, status: 'notStarted', actions: ['start'], accent: 'start', disabled: false });
  });

  it('left, with its board still on screen: Resume in the accent, and Restart', () => {
    const [row] = rows({ state: leftRun(), progress: stored('inProgress', LESSON) });
    expect(row?.status).toBe('inProgress');
    expect(row?.actions).toEqual(['resume', 'restart']);
    expect(row?.accent).toBe('resume');
  });

  it('running now: Restart alone, with no accent', () => {
    const [row] = rows({ state: atStep(1), progress: stored('inProgress', LESSON) });
    expect(row?.status).toBe('inProgress');
    expect(row?.actions).toEqual(['restart']);
    expect(row?.accent).toBeNull();
  });

  it('left, and the board was swapped: Restart alone', () => {
    const [row] = rows({ state: leftRun(), progress: stored('inProgress', LESSON), swapFloor: SWAP + 1 });
    expect(row?.status).toBe('inProgress');
    expect(row?.actions).toEqual(['restart']);
    expect(row?.accent).toBeNull();
  });

  it('left, and the app reloaded: Restart alone', () => {
    const [row] = rows({ progress: stored('inProgress', LESSON) });
    expect(row?.status).toBe('inProgress');
    expect(row?.actions).toEqual(['restart']);
  });

  it('finished: Done, with Restart and no accent', () => {
    const [row] = rows({ progress: stored('done', LESSON) });
    expect(row?.status).toBe('done');
    expect(row?.actions).toEqual(['restart']);
    expect(row?.accent).toBeNull();
  });

  it('a finished lesson restarted reads in progress while its run is live, and done when the run is gone', () => {
    const done = stored('done', LESSON);
    expect(rows({ state: atStep(1), progress: done })[0]?.status, 'running').toBe('inProgress');
    expect(rows({ state: leftRun(), progress: done })[0]?.status, 'left with its board').toBe('inProgress');
    expect(rows({ state: leftRun(), progress: done, swapFloor: SWAP + 1 })[0]?.status, 'left, board swapped').toBe('done');
    expect(rows({ state: IDLE, progress: done })[0]?.status, 'after a reload').toBe('done');
  });

  it('a run that has just finished reads done even if the store could not write', () => {
    const finished = { ...atStep(5), card: 'finished' as const };
    expect(rows({ state: finished })[0]?.status).toBe('done');
  });

  it('a run finished with a store that could not write still reads done after Back to lessons', () => {
    const store = localStorageProgress(
      {
        getItem: () => null,
        setItem: () => {
          throw new Error('full');
        },
        removeItem: () => {},
      },
      [LESSON],
    );
    store.write(withLessonDone(store.read(), LESSON));
    const afterBack = reduce({ ...atStep(5), card: 'finished' }, { type: 'cancelledRun' }, LESSONS);
    const [row] = rows({ state: afterBack, progress: store.read() });
    expect(row?.status).toBe('done');
    expect(row?.actions).toEqual(['restart']);
  });

  it('a swapped card reads in progress with Restart', () => {
    const swapped = frame(atStep(1), { nodes: [THE_SOURCE], swapFloor: FLOOR + 2 });
    const [row] = rows({ state: swapped, swapFloor: FLOOR + 2 });
    expect(row?.status).toBe('inProgress');
    expect(row?.actions).toEqual(['restart']);
  });

  it('with the first two of five done, exactly one row has an accent, on the third row\'s Start', () => {
    const views = rows({ lessons: FIVE, progress: stored('done', 'one', 'two') });
    expect(views.filter((r) => r.accent !== null).map((r) => [r.id, r.accent])).toEqual([['three', 'start']]);
  });

  it('with nothing done, exactly one of five rows has an accent, on the first', () => {
    const views = rows({ lessons: FIVE });
    expect(views.filter((r) => r.accent !== null).map((r) => [r.id, r.accent])).toEqual([['one', 'start']]);
  });

  it('with every row done, no row has an accent', () => {
    const views = rows({ lessons: FIVE, progress: stored('done', 'one', 'two', 'three', 'four', 'five') });
    expect(views.every((r) => r.accent === null)).toBe(true);
  });

  it('a first unfinished row with only Restart leaves the later rows without the accent', () => {
    const views = rows({ lessons: FIVE, progress: stored('inProgress', 'one') });
    expect(views.every((r) => r.accent === null)).toBe(true);
  });

  it('keeps the order of the lessons whatever their status', () => {
    const views = rows({ lessons: FIVE, progress: { version: 1, lessons: { five: 'done', one: 'inProgress', three: 'done' } as Progress['lessons'] } });
    expect(views.map((r) => r.id)).toEqual(['one', 'two', 'three', 'four', 'five']);
  });

  it('a stopped simulation disables the row', () => {
    expect(rows({ simStopped: true })[0]?.disabled).toBe(true);
    expect(rows({ simStopped: false })[0]?.disabled).toBe(false);
  });

  it('starting a lesson while another runs leaves the first in progress in the store', () => {
    const [first, second] = FIVE as [Lesson, Lesson];
    const lessons = [first, second];
    let progress = withLessonStarted(EMPTY_PROGRESS, first.id);
    const running = reduce(atStep(1), { type: 'newSent', lessonId: second.id, floorAtSend: SWAP }, lessons);
    progress = withLessonStarted(progress, second.id);
    expect(progress.lessons[first.id]).toBe('inProgress');
    const views = rows({ lessons, progress, state: running });
    expect(views[0]?.status).toBe('inProgress');
    expect(views[0]?.actions, 'the first has no run to resume').toEqual(['restart']);
    expect(views[1]?.status).toBe('inProgress');
    expect(views[1]?.actions).toEqual(['restart']);
  });
});

describe('lesson 3: Delete and Undo', () => {
  const DU = 'delete-and-undo';
  const SRC: BoardNode = THE_SOURCE;
  const SNK: BoardNode = THE_SINK;
  const tile = (x: number, kind: unknown) => ({ cell_x: x, cell_y: 2, kind });
  const STRAIGHT = { Straight: { axis: 0 } };
  /** The Source's output at (3, 2) to the Sink's input at (7, 2), Tail first. */
  const beltBetween = (id: number, from: number, to: number, docked = true): BoardBelt => ({
    id,
    items: 0,
    occupiedSlots: [],
    tiles: [tile(3, STRAIGHT), tile(4, STRAIGHT), tile(5, STRAIGHT), tile(6, STRAIGHT), tile(7, STRAIGHT)],
    docks: docked
      ? [
          { end: 'Tail', node: from, port: 0 },
          { end: 'Head', node: to, port: 1 },
        ]
      : [],
  });
  const BELT = beltBetween(9, SRC.id, SNK.id);
  /** The same machines and belt as an Undo keyframe puts them back: every handle new. */
  const reminted = (base: number): Partial<BoardFacts> => {
    const source = { ...SRC, id: base };
    const sink = { ...SNK, id: base + 1 };
    return { nodes: [source, sink], belts: [beltBetween(base + 2, source.id, sink.id)] };
  };
  const step = (s: TutorialState): string | undefined => LESSONS.find((l) => l.id === DU)?.steps[s.stepIndex]?.id;
  const WEBHOOK = { kind: 'Source', trigger: { kind: 'Webhook' } } as const;
  const DEBUG = { kind: 'Sink', target: { kind: 'Debug' } } as const;
  /** The host's answer about each machine on the board, at the board's generation. Only for a case that sets its own answers. */
  const answersAbout = (b: Partial<BoardFacts>): AppliedConfig[] =>
    (b.nodes ?? []).map((n) => ({ node: n.id, generation: b.generation ?? 1, config: n.kind === SOURCE ? WEBHOOK : DEBUG }));
  /**
   * The answers a frame carries, filtered the way the layer filters them: only about the handles in
   * `boundMachineHandles` of the state before the frame, the set the poll asks about, and only where
   * that handle names a machine on this frame's board, at this board's generation. So a keyframe frame
   * carries no answer about the handles it re-mints, and the next frame does, as the real poll restarts
   * once React re-renders with the rebound handles.
   */
  const answersFor = (s: TutorialState, b: Partial<BoardFacts>): AppliedConfig[] => {
    const polled = new Set(boundMachineHandles(s.bindings));
    return answersAbout(b).filter((a) => polled.has(a.node));
  };
  /** A frame of lesson 3 with the answers the layer would hand over, unless the chrome says otherwise. */
  const frame = (s: TutorialState, b: Partial<BoardFacts>, c: Partial<ChromeFacts> = {}): TutorialState =>
    reduce(s, { type: 'frame', board: board(b), chrome: chrome({ appliedConfigs: answersFor(s, b), ...c }) }, LESSONS);
  /** Two frames of the same board: the keyframe frame, and the one after it that carries the answers. */
  const twice = (s: TutorialState, b: Partial<BoardFacts>): TutorialState => frame(frame(s, b), b);

  function startedDU(): TutorialState {
    const sent = reduce(IDLE, { type: 'newSent', lessonId: DU, floorAtSend: FLOOR }, LESSONS);
    return frame(sent, {});
  }

  /** Lesson 3 brought to the step with this index, one step a frame, on generation 1. */
  function atDU(index: number): TutorialState {
    let s = startedDU();
    if (index >= 1) s = frame(s, { nodes: [SRC] });
    if (index >= 2) s = frame(s, { nodes: [SRC, SNK] });
    if (index >= 3) s = frame(s, { nodes: [SRC, SNK], belts: [BELT] });
    if (index >= 4) s = frame(s, { nodes: [SRC, SNK], belts: [] });
    if (index >= 5) s = frame(s, { nodes: [SRC], belts: [] });
    return s;
  }

  it('walks the six steps with two deletes and two Undo keyframes', () => {
    expect(step(atDU(3))).toBe('delete-belt');
    expect(atDU(3).capture?.since).toBe('delete-belt');
    expect(step(atDU(4))).toBe('delete-sink');
    expect(step(atDU(5))).toBe('bring-back');
    const sinkBack = frame(atDU(5), { nodes: [{ ...SRC, id: 50 }, { ...SNK, id: 51 }], belts: [], generation: 2 });
    expect(sinkBack.card).toBe('running');
    expect(currentStage(sinkBack, board({ nodes: [{ ...SRC, id: 50 }, { ...SNK, id: 51 }], generation: 2 }), chrome(), LESSONS)?.id).toBe('undo-belt');
    const done = twice(sinkBack, { ...reminted(60), generation: 3 });
    expect(done.card).toBe('finished');
  });

  it('a Delete on the delete-belt step moves on', () => {
    const s = frame(atDU(3), { nodes: [SRC, SNK], belts: [] });
    expect(step(s)).toBe('delete-sink');
    expect(s.note).toBeNull();
    // And the frame after it, with the belt still gone, leaves the lesson where it is.
    expect(step(frame(s, { nodes: [SRC, SNK], belts: [] }))).toBe('delete-sink');
  });

  it('an Undo of the original draw on the delete-belt step sends the lesson back to draw-belt', () => {
    const s = frame(atDU(3), { nodes: [{ ...SRC, id: 30 }, { ...SNK, id: 31 }], belts: [beltBetween(32, 30, 31, false)], generation: 2 });
    expect(step(s)).toBe('draw-belt');
    expect(s.note).toEqual({ kind: 'wentBack', a: 3, b: 3 });
  });

  it('an Undo on the delete-sink step that brings the belt back sends the lesson back to delete-belt', () => {
    const s = frame(atDU(4), { ...reminted(30), generation: 2 });
    expect(step(s)).toBe('delete-belt');
    expect(s.note).toEqual({ kind: 'wentBack', a: 4, b: 4 });
    expect(s.bindings.belt?.id).toBe(32);
  });

  it('the restore step, bring-back, never goes back, whatever the board does', () => {
    const s = atDU(5);
    for (const b of [{ nodes: [], belts: [] }, { nodes: [SRC, SNK], belts: [beltBetween(9, SRC.id, SNK.id, false)], generation: 4 }, { nodes: [SRC] }]) {
      expect(step(frame(s, b))).toBe('bring-back');
    }
  });

  it('a Sink deleted at delete-belt finishes delete-belt and delete-sink in one pass, and one Undo finishes the lesson', () => {
    const s = frame(atDU(3), { nodes: [SRC], belts: [] });
    expect(step(s)).toBe('bring-back');
    expect(s.note).toEqual({ kind: 'skippedOne', a: 5, b: 5 });
    expect(s.bindings.sink).toBeDefined();
    expect(s.bindings.belt).toBeDefined();
    // place-sink and draw-belt still stand on the next frame too, with both targets gone.
    expect(step(frame(s, { nodes: [SRC], belts: [] }))).toBe('bring-back');
    expect(twice(s, { ...reminted(70), generation: 2 }).card).toBe('finished');
  });

  it('a Sink deleted at draw-belt still sends the lesson back to place-sink', () => {
    const s = frame(atDU(2), { nodes: [SRC] });
    expect(step(s)).toBe('place-sink');
  });

  it('has six steps in order, each opening with the paused stage, inside the card budgets', () => {
    const du = LESSONS.find((l) => l.id === DU);
    expect(LESSONS.map((l) => l.id)).toEqual(['your-first-line', 'delete-and-undo', 'a-factory-with-two-outputs']);
    expect(du?.title).toBe('Delete and Undo');
    expect(du?.steps.map((s) => s.id)).toEqual(['place-source', 'place-sink', 'draw-belt', 'delete-belt', 'delete-sink', 'bring-back']);
    for (const s of du?.steps ?? []) expect(s.stages[0]?.id, s.id).toBe('board-paused');
    expect(auditLessonWords(du === undefined ? [] : [du])).toEqual([]);
    for (const s of du?.steps ?? []) {
      for (const stage of s.stages) {
        const text = phrasePlain(stage.text);
        expect(text.length, `${s.id} ${stage.id}: ${text}`).toBeLessThanOrEqual(MAX_INSTRUCTION_CHARS);
        for (const line of Object.values(stage.coach ?? {})) {
          expect(phrasePlain(line).length, `${s.id} ${stage.id} coach`).toBeLessThanOrEqual(MAX_NOTE_CHARS);
        }
      }
    }
    expect(phrasePlain(du?.closing ?? [])).toBe('Delete or Backspace takes a machine or a Belt off the board, and Ctrl+Z puts it back the way it was.');
  });

  it('reads the belt as selected through selectedBelt', () => {
    const s = atDU(3);
    const b = board({ nodes: [SRC, SNK], belts: [BELT] });
    expect(currentStage(s, b, chrome(), LESSONS)?.id).toBe('select-belt');
    expect(currentStage(s, b, chrome({ selectedBelt: BELT.id }), LESSONS)?.id).toBe('press-delete');
    expect(currentStage(s, b, chrome({ selectedNode: BELT.id }), LESSONS)?.id).toBe('select-belt');
  });
  it('bring-back waits for an answer about each re-minted handle, at the new generation', () => {
    const back = { ...reminted(80), generation: 3 };
    // No answer yet about the new handles: the line is back and the lesson still waits.
    const waiting = frame(atDU(5), back, { appliedConfigs: [] });
    expect(waiting.card).toBe('running');
    expect(step(waiting)).toBe('bring-back');
    // Answers about the new handles, but asked before the keyframe: they don't count. The layer drops
    // these itself, so the case passes them by hand to show the reader checks the generation too.
    expect(frame(waiting, back, { appliedConfigs: answersAbout({ ...back, generation: 1 }) }).card).toBe('running');
    // Only the Source answered at the new generation: still waiting.
    expect(frame(waiting, back, { appliedConfigs: answersAbout(back).slice(0, 1) }).card).toBe('running');
    // Both answered at the new generation: done.
    expect(frame(waiting, back).card).toBe('finished');
  });

  it('bring-back stays open when a restored Sink has another config', () => {
    const back = { ...reminted(80), generation: 3 };
    const http = { kind: 'Sink', target: { kind: 'Http', url: 'http://127.0.0.1:9/x', method: 0 } } as const;
    // The keyframe frame carries no answer about the new handles in the app; the case hands them over
    // at once, because it reads the comparison and not the timing.
    const other = answersAbout(back).map((a) => (a.node === 81 ? { ...a, config: http } : a));
    expect(frame(atDU(5), back, { appliedConfigs: other }).card).toBe('running');
  });

  it('a capture read before the answers came takes them later at its own generation, and keeps the belt deleted meanwhile', () => {
    let s = startedDU();
    s = frame(s, { nodes: [SRC] });
    s = frame(s, { nodes: [SRC, SNK] });
    // The belt finishes draw-belt on a frame with no answers, so the capture at delete-belt is incomplete.
    s = frame(s, { nodes: [SRC, SNK], belts: [BELT] }, { appliedConfigs: [] });
    expect(step(s)).toBe('delete-belt');
    expect(s.capture?.shape.complete).toBe(false);
    // The belt goes, and only then do the answers arrive.
    s = frame(s, { nodes: [SRC, SNK], belts: [] });
    expect(s.capture?.shape.complete).toBe(true);
    expect(s.capture?.shape.belts.length).toBe(1);
    s = frame(s, { nodes: [SRC], belts: [] });
    expect(step(s)).toBe('bring-back');
    expect(twice(s, { ...reminted(90), generation: 2 }).card).toBe('finished');
  });

  it("a second Source from a repeat floor click doesn't stop bring-back", () => {
    // The Source tool stays armed after a place, so a second floor click puts down a second Source.
    // The lesson binds the lower handle, and the config poll never asks about the other one.
    const EXTRA: BoardNode = { ...node(6, SOURCE, 2, 5), ports: [{ index: 0, cell_x: 2, cell_y: 5, side: 1, role: 1 }] };
    let s = startedDU();
    s = frame(s, { nodes: [SRC, EXTRA] });
    expect(s.bindings.source?.id, 'the lesson binds the lower handle').toBe(SRC.id);
    s = frame(s, { nodes: [SRC, EXTRA, SNK] });
    s = frame(s, { nodes: [SRC, EXTRA, SNK], belts: [BELT] });
    expect(step(s)).toBe('delete-belt');
    s = frame(s, { nodes: [SRC, EXTRA, SNK], belts: [] });
    s = frame(s, { nodes: [SRC, EXTRA], belts: [] });
    expect(step(s)).toBe('bring-back');
    // The first Undo: every handle re-minted, the second Source's too.
    const sinkBack = { nodes: [{ ...SRC, id: 40 }, { ...EXTRA, id: 41 }, { ...SNK, id: 42 }], belts: [], generation: 2 };
    expect(sinkBack.nodes.length, 'three machines at the first Undo').toBe(3);
    s = twice(s, sinkBack);
    expect(s.card).toBe('running');
    // The second Undo: the belt back joined at both ends, every handle new again.
    const back = { nodes: [{ ...SRC, id: 50 }, { ...EXTRA, id: 51 }, { ...SNK, id: 52 }], belts: [beltBetween(53, 50, 52)], generation: 3 };
    expect(back.nodes.length, 'three machines at the second Undo').toBe(3);
    s = frame(s, back);
    const stages: (string | undefined)[] = [];
    for (let i = 0; i < 2 && s.card === 'running'; i++) {
      s = frame(s, back);
      stages.push(currentStage(s, board(back), chrome({ appliedConfigs: answersFor(s, back) }), LESSONS)?.id);
    }
    expect(s.card, `finished within two frames of the board being back; it read stages ${JSON.stringify(stages)}`).toBe('finished');
    expect(stages, 'no frame after the second keyframe shows the too-far stage').not.toContain('too-far');
  });

});

describe('rebound: every binding follows a re-mint', () => {
  const FACTORY = 2;
  /** A hand-made lesson that binds a Factory, a second Sink and the belt between them, then waits. */
  const HAND_MADE: Lesson = {
    id: 'delete-and-undo',
    title: 'hand-made',
    steps: [
      { id: 'factory', stages: [], done: { is: 'nodeAppeared', kind: FACTORY, bind: 'factory' } },
      { id: 'sink2', stages: [], done: { is: 'nodeAppeared', kind: SINK, bind: 'sink2' } },
      { id: 'out2', stages: [], done: { is: 'beltJoins', a: 'factory', b: 'sink2', bind: 'beltOut2' } },
      { id: 'wait', stages: [], done: { is: 'itemArrived', at: 'sink2' } },
    ],
    closing: [],
    refused: { atStep: 'sink2', atStage: 'none', press: { on: 'machine', of: 'factory' }, tag: 'FootprintCollision' },
  };
  const factory = (id: number): BoardNode => ({ id, kind: FACTORY, cells: [[2, 2], [3, 2], [4, 2], [2, 3], [3, 3], [4, 3], [2, 4], [3, 4], [4, 4]], ports: [] });
  const out2 = (id: number, from: number, to: number): BoardBelt => ({
    id,
    items: 0,
    occupiedSlots: [],
    tiles: [],
    docks: [
      { end: 'Tail', node: from, port: 3 },
      { end: 'Head', node: to, port: 1 },
    ],
  });
  const run = (s: TutorialState, b: Partial<BoardFacts>): TutorialState => reduce(s, { type: 'frame', board: board(b), chrome: chrome() }, [HAND_MADE]);

  it('finds a beltOut2 binding again after a keyframe re-mints the Factory, the second Sink and the belt', () => {
    let s = reduce(IDLE, { type: 'newSent', lessonId: 'delete-and-undo', floorAtSend: FLOOR }, [HAND_MADE]);
    s = run(s, {});
    s = run(s, { nodes: [factory(10)] });
    s = run(s, { nodes: [factory(10), node(11, SINK, 9, 3)] });
    s = run(s, { nodes: [factory(10), node(11, SINK, 9, 3)], belts: [out2(12, 10, 11)] });
    expect(s.stepIndex).toBe(3);
    expect(s.bindings.beltOut2?.id).toBe(12);
    const next = run(s, { nodes: [factory(20), node(21, SINK, 9, 3)], belts: [out2(22, 20, 21)], generation: 2 });
    expect(next.stepIndex).toBe(3);
    expect(next.bindings.factory?.id).toBe(20);
    expect(next.bindings.sink2?.id).toBe(21);
    expect(next.bindings.beltOut2?.id).toBe(22);
  });
});

describe('lesson 1 on the shared stages', () => {
  /** Copied from the lesson at 09c740c, before its stages moved to commonStages.ts, resolved through the real tables. */
  const PAUSED = 'The board is paused, so your edits wait. Press Play in the toolbar, or press Space.';
  const FLOOR_TEXT = 'Click the floor to place it. The ring marks a free spot, but any free spot works.';
  const BEFORE: ReadonlyArray<readonly [string, ReadonlyArray<readonly [string, string]>]> = [
    ['place-source', [['board-paused', PAUSED], ['source-tool', 'A Source makes items. Click Source in the palette.'], ['source-floor', FLOOR_TEXT]]],
    ['place-sink', [['board-paused', PAUSED], ['sink-tool', 'A Sink takes items in at the end of a line. Click Sink in the palette.'], ['sink-floor', FLOOR_TEXT]]],
    [
      'set-timer',
      [
        ['board-paused', PAUSED],
        ['tool-down', 'Press Esc to put the tool down, or click it again in the palette.'],
        ['select-source', 'A new Source waits for a web request, so it makes nothing yet. Click it to select it.'],
        ['press-timer', 'Under Trigger, press Timer so it makes items on its own.'],
        ['apply-timer', 'Press Apply to put the change on the board.'],
      ],
    ],
    [
      'draw-belt',
      [
        ['board-paused', PAUSED],
        ['belt-tool', 'A Belt carries items between machines. Click Belt in the palette.'],
        ['belt-undo', "That Belt can't be carried on. Press Ctrl+Z until it's gone, then draw it again."],
        ['belt-carry-on', "That Belt stops before the Sink. Drag from the ring at its end to the Sink's input dot."],
        ['belt-draw', "Drag from the Source's output dot to the Sink's input dot."],
      ],
    ],
    ['press-play', [['board-paused', 'Press Play in the toolbar, or press Space.'], ['board-running', 'The board is running.']]],
    ['watch-items', [['board-paused', PAUSED], ['watch', 'Watch the dots ride the Belt into the Sink.']]],
  ];

  it('reads as it did: the same stage ids per step and the same words', () => {
    const now = YOUR_FIRST_LINE.steps.map((s) => [s.id, s.stages.map((g) => [g.id, phrasePlain(g.text, REAL_TABLES)])]);
    expect(now).toEqual(BEFORE);
    expect(phrasePlain(YOUR_FIRST_LINE.closing, REAL_TABLES)).toBe(
      'A Source makes items, a Belt carries them and a Sink takes them in. The board is yours, so keep building.',
    );
  });
});

describe('rowViews with three lessons', () => {
  it('puts the accent on Start for Delete and Undo once lesson 1 is Done, with the rows in teaching order', () => {
    const views = rowViews({ lessons: LESSONS, progress: withLessonDone(EMPTY_PROGRESS, 'your-first-line'), state: IDLE, swapFloor: FLOOR, simStopped: false });
    expect(views.map((v) => [v.id, v.title, v.status, v.accent])).toEqual([
      ['your-first-line', 'Your first line', 'done', null],
      ['delete-and-undo', 'Delete and Undo', 'notStarted', 'start'],
      ['a-factory-with-two-outputs', 'A Factory with two outputs', 'notStarted', null],
    ]);
  });
});

// LESSON 4. A Source at (2,5), the Factory 3 by 3 at (6,4) with its In on the Source's row, the first Sink
// at (12,5) on the first Out's row and the second at (12,6) on the second Out's row. Ports as the host
// sends them: [In, Out, Fault] fresh, [In, Out, Fault, Out] after + Add output. A Tail dock names an
// output by its place among the Outs.
const L4 = 'a-factory-with-two-outputs';
const FACTORY = 2;
const DEFAULT_CODE = 'export default function (input, ctx) { ctx.emit(0, input); }';
const TWO_EMITS = 'export default function (input, ctx) { ctx.emit(0, input); ctx.emit(1, input); }';
const square = (x: number, y: number): number[][] => [0, 1, 2].flatMap((dy) => [0, 1, 2].map((dx) => [x + dx, y + dy]));
const L4_SOURCE: BoardNode = { id: 30, kind: SOURCE, cells: [[2, 5]], ports: [{ index: 0, cell_x: 2, cell_y: 5, side: 1, role: 1 }] };
const ONE_OUT: BoardNode = {
  id: 31,
  kind: FACTORY,
  cells: square(6, 4),
  ports: [
    { index: 0, cell_x: 6, cell_y: 5, side: 3, role: 0 },
    { index: 1, cell_x: 8, cell_y: 5, side: 1, role: 1 },
    { index: 2, cell_x: 7, cell_y: 6, side: 2, role: 2 },
  ],
};
const TWO_OUTS: BoardNode = { ...ONE_OUT, ports: [...ONE_OUT.ports, { index: 3, cell_x: 8, cell_y: 6, side: 1, role: 1 }] };
const sinkAt = (id: number, x: number, y: number): BoardNode => ({
  id,
  kind: SINK,
  cells: [[x, y]],
  ports: [
    { index: 0, cell_x: x, cell_y: y, side: 2, role: 2 },
    { index: 1, cell_x: x, cell_y: y, side: 3, role: 0 },
  ],
});
const L4_SINK = sinkAt(32, 12, 5);
const L4_SINK2 = sinkAt(33, 12, 6);
const tilesAlong = (from: number, to: number, y: number): BoardBelt['tiles'] => Array.from({ length: to - from + 1 }, (_, i) => ({ cell_x: from + i, cell_y: y }));
const beltOf = (id: number, tail: [number, number], head: [number, number], tiles: BoardBelt['tiles'], slots: number[] = []): BoardBelt => ({
  id,
  items: slots.length,
  occupiedSlots: slots,
  tiles,
  docks: [
    { end: 'Tail', node: tail[0], port: tail[1] },
    { end: 'Head', node: head[0], port: head[1] },
  ],
});
const BELT_IN = beltOf(40, [L4_SOURCE.id, 0], [ONE_OUT.id, 0], tilesAlong(3, 5, 5));
const beltOut = (slots: number[] = []): BoardBelt => beltOf(41, [ONE_OUT.id, 0], [L4_SINK.id, 1], tilesAlong(9, 11, 5), slots);
const beltOut2 = (slots: number[] = []): BoardBelt => beltOf(42, [ONE_OUT.id, 1], [L4_SINK2.id, 1], tilesAlong(9, 11, 6), slots);
const L4_TIMER = { appliedTrigger: { node: L4_SOURCE.id, kind: 'Timer' as const } };
const factoryAnswer = (source: string, generation = 1): AppliedConfig => ({ node: ONE_OUT.id, generation, config: { kind: 'Factory', source } });

function l4Frame(s: TutorialState, b: Partial<BoardFacts>, c: Partial<ChromeFacts> = {}): TutorialState {
  return frame(s, b, { ...L4_TIMER, ...c });
}

/** Lesson 4 brought to the step with this index, one step a frame. The board at each step is `l4Board(index)`. */
function l4Board(index: number, out: number[] = [], out2: number[] = []): Partial<BoardFacts> {
  const nodes = [L4_SOURCE, ...(index >= 3 ? [index >= 4 ? TWO_OUTS : ONE_OUT] : []), ...(index >= 5 ? [L4_SINK] : []), ...(index >= 6 ? [L4_SINK2] : [])];
  const belts = [...(index >= 7 ? [BELT_IN] : []), ...(index >= 8 ? [beltOut(out)] : []), ...(index >= 9 ? [beltOut2(out2)] : [])];
  return { nodes, belts };
}

function atL4(index: number, c: Partial<ChromeFacts> = {}): TutorialState {
  const sent = reduce(IDLE, { type: 'newSent', lessonId: L4, floorAtSend: FLOOR }, LESSONS);
  let s = frame(sent, {});
  for (let i = 1; i <= index; i++) s = l4Frame(s, l4Board(i), c);
  return s;
}

describe('lesson 4: A Factory with two outputs', () => {
  it('has ten steps in order, each opening with the paused stage, inside the card budgets', () => {
    expect(TWO_OUTPUTS.title).toBe('A Factory with two outputs');
    expect(TWO_OUTPUTS.steps.map((s) => s.id)).toEqual([
      'place-source',
      'set-timer',
      'place-factory',
      'add-output',
      'place-sink',
      'place-second-sink',
      'belt-in',
      'belt-out',
      'belt-out-2',
      'change-code',
    ]);
    for (const s of TWO_OUTPUTS.steps) expect(s.stages[0]?.id, s.id).toBe('board-paused');
    expect(auditLessonWords([TWO_OUTPUTS])).toEqual([]);
    for (const s of TWO_OUTPUTS.steps) {
      for (const stage of s.stages) {
        const text = phrasePlain(stage.text);
        expect(text.length, `${s.id} ${stage.id}: ${text}`).toBeLessThanOrEqual(MAX_INSTRUCTION_CHARS);
        for (const line of Object.values(stage.coach ?? {})) {
          expect(phrasePlain(line).length, `${s.id} ${stage.id} coach`).toBeLessThanOrEqual(MAX_NOTE_CHARS);
        }
      }
    }
    expect(phrasePlain(TWO_OUTPUTS.closing)).toBe(
      "A Factory's code decides which output each item leaves by: ctx.emit(0, input) for the first, ctx.emit(1, input) for the second.",
    );
  });

  it('walks to the watch step one step a frame, with + Add output before any Sink or belt', () => {
    const s = atL4(9);
    expect(s.card).toBe('running');
    expect(s.stepIndex).toBe(9);
    expect(s.bindings.factory?.nodeKey).toBe('2@6,4');
    expect(s.bindings.beltOut2?.id).toBe(42);
    expect(TWO_OUTPUTS.steps.findIndex((st) => st.id === 'add-output')).toBeLessThan(TWO_OUTPUTS.steps.findIndex((st) => st.id === 'place-sink'));
  });

  it('a turned Factory whose + Add output moves its corner goes back to place-factory and finishes it again in the same frame, with no note', () => {
    const s = atL4(3);
    expect(s.stepIndex, 'on add-output').toBe(3);
    // Turned once, the grown box keeps its far edge, so its top left moves up a row and the key changes.
    const grown: BoardNode = { ...TWO_OUTS, cells: square(6, 3) };
    const next = l4Frame(s, { nodes: [L4_SOURCE, grown] });
    expect(next.stepIndex, 'on place-sink').toBe(4);
    expect(next.note).toBeNull();
    expect(next.bindings.factory?.nodeKey).toBe('2@6,3');
  });

  describe('the watch read', () => {
    const watching = (): TutorialState => {
      const s = atL4(8);
      return l4Frame(s, l4Board(9, [3], [3]));
    };

    it('a rise into the first Sink and a later rise into the second finishes on the second', () => {
      let s = watching();
      expect(s.stepIndex).toBe(9);
      s = l4Frame(s, l4Board(9, [], [2]));
      expect(s.card, 'one rise, into the first Sink').toBe('running');
      expect(s.baseline?.rose).toEqual(['sink']);
      s = l4Frame(s, l4Board(9, [1], [2]));
      expect(s.card, 'the first falls again, and its latch stands').toBe('running');
      s = l4Frame(s, l4Board(9, [1], []));
      expect(s.card, 'the rise into the second Sink').toBe('finished');
    });

    it('rises into one Sink alone never finish', () => {
      let s = watching();
      for (let i = 0; i < 10; i++) s = l4Frame(s, l4Board(9, i % 2 === 0 ? [] : [0], [3]));
      expect(s.card).toBe('running');
      expect(s.baseline?.rose).toEqual(['sink']);
    });

    it('a keyframe between two frames is no rise, and keeps a latch already taken', () => {
      let s = watching();
      s = l4Frame(s, l4Board(9, [], [2]));
      expect(s.baseline?.rose).toEqual(['sink']);
      s = l4Frame(s, { ...l4Board(9, [0], [9]), generation: 2 });
      expect(s.card, 'the second Sink only looks like it rose').toBe('running');
      expect(s.baseline?.rose, 'the first latch stands across the keyframe').toEqual(['sink']);
      expect(s.baseline?.lowestSlots).toEqual({ sink: 0, sink2: 9 });
      s = l4Frame(s, { ...l4Board(9, [0], []), generation: 2 });
      expect(s.card).toBe('finished');
    });
  });

  it("step 9's stage, with beltOut bound and the Belt tool armed, is the plain drag and not the undo", () => {
    const s = atL4(8);
    expect(s.stepIndex).toBe(8);
    expect(s.bindings.beltOut?.id).toBe(41);
    const stage = currentStage(s, board(l4Board(8)), chrome({ ...L4_TIMER, armed: { kind: 'belt' } }), LESSONS);
    expect(stage?.id).toBe('belt-draw');
  });

  describe('the code stages', () => {
    const SELECTED = { selectedNode: ONE_OUT.id };
    const atCode = (answers: AppliedConfig[]): TutorialState => {
      const s = atL4(8);
      return l4Frame(s, l4Board(9), { appliedConfigs: answers });
    };
    const stageAt = (s: TutorialState, c: Partial<ChromeFacts>): string | undefined =>
      currentStage(s, board(l4Board(9)), chrome({ ...L4_TIMER, ...SELECTED, ...c }), LESSONS)?.id;

    it('the source applied when the step began is held', () => {
      expect(atCode([factoryAnswer(DEFAULT_CODE)]).baseline?.factorySource).toBe(DEFAULT_CODE);
    });

    it('unchanged with no marker shows type-code; the marker shows apply-code; changed text with no marker shows watch', () => {
      const s = atCode([factoryAnswer(DEFAULT_CODE)]);
      expect(stageAt(s, { codeText: DEFAULT_CODE, codeNotApplied: false })).toBe('type-code');
      expect(stageAt(s, { codeText: TWO_EMITS, codeNotApplied: true })).toBe('apply-code');
      expect(stageAt(s, { codeText: DEFAULT_CODE, codeNotApplied: true }), 'typed and typed back, still marked').toBe('apply-code');
      expect(stageAt(s, { codeText: TWO_EMITS, codeNotApplied: false })).toBe('watch');
    });

    it('an unknown source shows type-code, and the first answer is taken once it comes', () => {
      const s = atCode([]);
      expect(s.baseline?.factorySource).toBeNull();
      expect(stageAt(s, { codeText: TWO_EMITS, codeNotApplied: false })).toBe('type-code');
      const answered = l4Frame(s, l4Board(9), { appliedConfigs: [factoryAnswer(DEFAULT_CODE)] });
      expect(answered.baseline?.factorySource).toBe(DEFAULT_CODE);
      const later = l4Frame(answered, l4Board(9), { appliedConfigs: [factoryAnswer(TWO_EMITS)] });
      expect(later.baseline?.factorySource, 'the latch keeps the first answer').toBe(DEFAULT_CODE);
    });

    it('with no Factory editor showing, the stage is still type-code', () => {
      expect(stageAt(atCode([factoryAnswer(DEFAULT_CODE)]), { codeText: null })).toBe('type-code');
    });
  });
});

describe('one watch read for one Sink and for two', () => {
  it('lowestSlots holds exactly the watched names, in lesson 1 and in lesson 4', () => {
    const one = atStep(5);
    expect(one.stepIndex).toBe(5);
    expect(Object.keys(one.baseline?.lowestSlots ?? {}).sort()).toEqual(['sink']);
    const two = atL4(9);
    expect(Object.keys(two.baseline?.lowestSlots ?? {}).sort()).toEqual(['sink', 'sink2']);
    expect(atL4(8).baseline?.lowestSlots, 'a step that watches nothing holds no slot').toEqual({});
  });

  it("lesson 1's itemArrived reads the slot through the map, and nothing else", () => {
    const one = atStep(5);
    const b = board({ nodes: BOTH, belts: [{ ...JOINED, occupiedSlots: [4], items: 1 }] });
    const check = { is: 'itemArrived', at: 'sink' } as const;
    const base = one.baseline!;
    const ctx = (lowestSlots: Record<string, number | null>) => ({ board: b, chrome: chrome(), bindings: one.bindings, capture: null, baseline: { ...base, lowestSlots } });
    expect(evaluateCheck(check, ctx({ sink: 0 })).done, 'a rise against the map').toBe(true);
    expect(evaluateCheck(check, ctx({})).done, 'no slot in the map').toBe(false);
    expect(evaluateCheck(check, ctx({ sink2: 0 })).done, "another Sink's slot").toBe(false);
  });
});

describe('floorSpot for lesson 4', () => {
  // UI-SPEC "Floor spots": the free area at 1024x768 with a Factory selected, at zoom 1 and camera 0.
  const VIEW_1024: ChromeFacts['view'] = { camera: { x: 0, y: 0, scale: 1 }, freeArea: { left: 198, right: 610, top: 116, bottom: 328 } };
  const CELL_PX = 32;

  it('a Factory spot past a machine moves down until all nine cells are free', () => {
    const blocker = node(50, SINK, 7, 6);
    const spot = floorSpot({ spot: 'factory', view: VIEW, board: board({ nodes: [L4_SOURCE, blocker] }), sourceKey: nodeKey(L4_SOURCE) });
    expect(spot).toEqual([6, 7]);
    const covered = square(spot[0], spot[1]);
    expect(covered.some(([x, y]) => x === 7 && y === 6)).toBe(false);
    expect(floorSpot({ spot: 'factory', view: VIEW, board: board({ nodes: [L4_SOURCE] }), sourceKey: nodeKey(L4_SOURCE) }), 'nothing in the way').toEqual([6, 4]);
  });

  it('at 1024x768 the line is centred: the Source near 228 px and the Sinks ending near 580 px, inside 198 to 610', () => {
    const src = floorSpot({ spot: 'centredSource', view: VIEW_1024, board: board() });
    const sourceLeft = src[0] * CELL_PX;
    // The ideal edges are 228 and 580; the cells snap to the grid, here 224 and 576.
    expect(Math.abs(sourceLeft - 228)).toBeLessThan(CELL_PX / 2);
    const sourceNode: BoardNode = { id: 1, kind: SOURCE, cells: [[src[0], src[1]]], ports: [] };
    const bindings = { source: { nodeKey: nodeKey(sourceNode), id: 1 } };
    const f = floorSpot({ spot: 'factory', view: VIEW_1024, board: board({ nodes: [sourceNode] }), bindings });
    expect(f).toEqual([src[0] + 4, src[1] - 1]);
    const [fx, fy] = f;
    const factory: BoardNode = {
      id: 2,
      kind: FACTORY,
      cells: square(fx, fy),
      ports: [
        { index: 0, cell_x: fx, cell_y: fy + 1, side: 3, role: 0 },
        { index: 1, cell_x: fx + 2, cell_y: fy + 1, side: 1, role: 1 },
        { index: 2, cell_x: fx + 1, cell_y: fy + 2, side: 2, role: 2 },
        { index: 3, cell_x: fx + 2, cell_y: fy + 2, side: 1, role: 1 },
      ],
    };
    const withFactory = { ...bindings, factory: { nodeKey: nodeKey(factory), id: 2 } };
    const first = floorSpot({ spot: 'firstOutputSink', view: VIEW_1024, board: board({ nodes: [sourceNode, factory] }), bindings: withFactory });
    expect(first, "the first Sink, on the first output's row").toEqual([fx + 6, fy + 1]);
    const sink: BoardNode = { id: 3, kind: SINK, cells: [[first[0], first[1]]], ports: [] };
    const second = floorSpot({ spot: 'freeOutputSink', view: VIEW_1024, board: board({ nodes: [sourceNode, factory, sink] }), bindings: withFactory });
    expect(second, "the second Sink, on the second output's row").toEqual([fx + 6, fy + 2]);
    const sinksRight = (first[0] + 1) * CELL_PX;
    expect(Math.abs(sinksRight - 580)).toBeLessThan(CELL_PX / 2);
    expect(sourceLeft).toBeGreaterThanOrEqual(VIEW_1024.freeArea.left);
    expect(sinksRight).toBeLessThanOrEqual(VIEW_1024.freeArea.right);
    expect(sinksRight - sourceLeft, 'eleven cells').toBe(11 * CELL_PX);
  });

  it('with a belt on the first output, the second Sink faces the other one, wherever the first Sink went', () => {
    const b = board({ nodes: [L4_SOURCE, TWO_OUTS], belts: [beltOf(41, [ONE_OUT.id, 0], [99, 1], tilesAlong(9, 9, 5))] });
    const bindings = { factory: { nodeKey: nodeKey(TWO_OUTS), id: TWO_OUTS.id } };
    expect(floorSpot({ spot: 'freeOutputSink', view: VIEW, board: b, bindings })).toEqual([12, 6]);
  });

  it("with the Legend open the line's lower row stays above the Legend once the inspector lifts it", () => {
    // 104-06, measured at 1024x768 with the Legend open: the free area is 116 to 426 px when the Source
    // is placed, and 116 to 328 once the Source's inspector opens and the Legend wraps higher. The camera
    // puts a row's top on the old 50% line (271 px), the worst grid snap for that rule.
    const open: ChromeFacts['view'] = { camera: { x: 0, y: 15, scale: 1 }, freeArea: { left: 198, right: 610, top: 116, bottom: 426 } };
    const src = floorSpot({ spot: 'centredSource', view: open, board: board() });
    const sourceNode: BoardNode = { id: 1, kind: SOURCE, cells: [[src[0], src[1]]], ports: [] };
    const bindings = { source: { nodeKey: nodeKey(sourceNode), id: 1 } };
    const shrunk: ChromeFacts['view'] = { ...open, freeArea: { ...open.freeArea, bottom: 328 } };
    const [, fy] = floorSpot({ spot: 'factory', view: shrunk, board: board({ nodes: [sourceNode] }), bindings });
    // The Factory's three rows, and the second Sink on the last of them.
    const bottom = (fy + 3) * CELL_PX + open.camera.y;
    expect(bottom, `the Factory ends at ${bottom} px, above the Legend's 328`).toBeLessThanOrEqual(328);
  });

  it('when 11 cells do not fit, the line starts one cell inside the free area', () => {
    const narrow: ChromeFacts['view'] = { camera: { x: 0, y: 0, scale: 1 }, freeArea: { left: 200, right: 400, top: 116, bottom: 328 } };
    const [x] = floorSpot({ spot: 'centredSource', view: narrow, board: board() });
    expect(x * CELL_PX).toBeGreaterThanOrEqual(200 + CELL_PX - CELL_PX / 2);
    expect(x * CELL_PX).toBeLessThanOrEqual(200 + CELL_PX + CELL_PX / 2);
  });
});
