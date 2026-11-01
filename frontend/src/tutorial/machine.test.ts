import { describe, expect, it } from 'vitest';
import { LESSONS } from './lessons/index.ts';
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
import { MAX_INSTRUCTION_CHARS, MAX_NOTE_CHARS, auditLessonWords, phrasePlain } from './phrase.ts';
import { EMPTY_PROGRESS, localStorageProgress, withLessonDone, withLessonStarted, type Progress } from './progress.ts';
import type { BoardBelt, BoardFacts, BoardNode, ChromeFacts, Lesson, LessonId } from './types.ts';

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
  return { armed: null, selectedNode: null, playing: true, triggerPressed: null, appliedTrigger: null, view: VIEW, ...over };
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
    expect(s.baseline?.lowestSlot, 'the lowest slot is taken when the step begins').toBe(9);
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
    expect(s.baseline?.lowestSlot, 'the read starts again from the new frame').toBe(7);
    s = frame(s, { nodes: BOTH, belts: [carrying([])], tick: 13, generation: 2 }, TIMER);
    expect(s.card, 'a real rise after it still counts').toBe('finished');
  });

  it('reduce returns the same object when nothing changed, so the layer can skip work', () => {
    const s = atStep(5);
    const again = frame(s, { nodes: BOTH, belts: [JOINED], tick: 12 }, TIMER);
    expect(again.baseline?.lowestSlot).toBe(s.baseline?.lowestSlot);
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
      expect(stageOf(atStep(3), { nodes: BOTH, belts: [first, touching] }, ARMED)).toBe('belt-carry-on');
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

      it("doesn't flash the undo card in the packet before a good draw's docks arrive", () => {
        const whole: BoardBelt = { ...JOINED, tiles: tilesOf(3, 4, 5, 6, 7), docks: [] };
        const s = run(atStep(3), [whole]);
        expect(shown(s, [whole])).toBe('belt-draw');
      });

      it("doesn't flash it on the good draw after an undo either", () => {
        const cleared = run(run(run(atStep(3), [ONE_TILE]), [LOOSE]), []);
        const whole: BoardBelt = { ...JOINED, tiles: tilesOf(3, 4, 5, 6, 7), docks: [] };
        expect(shown(run(cleared, [whole]), [whole])).toBe('belt-draw');
      });

      it('forgets it when the lesson goes back past the step', () => {
        const stuck = run(atStep(3), [ONE_TILE]);
        expect(stuck.undoing).toBe(true);
        const back = frame(stuck, { nodes: [THE_SOURCE], belts: [] }, TIMER);
        expect(back.stepIndex).toBe(1);
        expect(back.undoing).toBe(false);
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
