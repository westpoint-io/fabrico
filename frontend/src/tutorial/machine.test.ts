import { describe, expect, it } from 'vitest';
import { LESSONS } from './lessons/index.ts';
import {
  IDLE,
  currentStage,
  floorSpot,
  noteTokens,
  reduce,
  viewKey,
  type TutorialState,
} from './machine.ts';
import { MAX_INSTRUCTION_CHARS, MAX_NOTE_CHARS, auditLessonWords, phrasePlain } from './phrase.ts';
import type { BoardBelt, BoardFacts, BoardNode, ChromeFacts } from './types.ts';

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

const THE_SOURCE = node(4, SOURCE, 2, 2);
const THE_SINK = node(5, SINK, 8, 2);
const JOINED: BoardBelt = {
  id: 9,
  items: 0,
  occupiedSlots: [],
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
    expect(stages('draw-belt')).toEqual(['board-paused', 'belt-tool', 'belt-draw']);
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
});

describe('reduce: a lesson that starts from a swap', () => {
  it('a frame with the old swap floor leaves the state in starting', () => {
    const sent = reduce(IDLE, { type: 'newSent', lessonId: LESSON, floorAtSend: FLOOR }, LESSONS);
    const next = frame(sent, { swapFloor: FLOOR, nodes: [THE_SOURCE] });
    expect(next.card).toBe('starting');
    expect(next.stepIndex).toBe(0);
  });

  it("the first board's nodes become known, so the old board can't finish anything", () => {
    const sent = reduce(IDLE, { type: 'newSent', lessonId: LESSON, floorAtSend: FLOOR }, LESSONS);
    const next = frame(sent, { nodes: [THE_SOURCE] });
    expect(next.card).toBe('running');
    expect(next.stepIndex).toBe(0);
    expect(next.baseline?.knownKeys).toEqual(['0@2,2']);
    expect(frame(next, { nodes: [THE_SOURCE] }).stepIndex, 'the same machine a frame later').toBe(0);
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

  it('keeps the old handle when the machine is gone', () => {
    const s = frame(started(), { nodes: [THE_SOURCE] });
    expect(frame(s, { nodes: [] }).bindings.source?.id).toBe(THE_SOURCE.id);
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
