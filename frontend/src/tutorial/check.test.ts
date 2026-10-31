import { describe, expect, it } from 'vitest';
import { evaluateCheck, nodeKey, type CheckContext } from './check.ts';
import type { StepBaseline, TutorialState } from './machine.ts';
import type { BoardBelt, BoardFacts, BoardNode, ChromeFacts } from './types.ts';

const SOURCE = 0;
const SINK = 7;

const node = (id: number, kind: number, x: number, y: number): BoardNode => ({ id, kind, cells: [[x, y]], ports: [] });

const belt = (id: number, slots: readonly number[], docks: BoardBelt['docks']): BoardBelt => ({
  id,
  items: slots.length,
  occupiedSlots: slots,
  tiles: [],
  docks,
});

const THE_SOURCE = node(4, SOURCE, 2, 2);
const THE_SINK = node(5, SINK, 8, 2);
const BINDINGS: TutorialState['bindings'] = {
  source: { nodeKey: nodeKey(THE_SOURCE), id: THE_SOURCE.id },
  sink: { nodeKey: nodeKey(THE_SINK), id: THE_SINK.id },
};

const INTO_THE_SINK: BoardBelt['docks'] = [
  { end: 'Tail', node: THE_SOURCE.id, port: 0 },
  { end: 'Head', node: THE_SINK.id, port: 0 },
];

function ctx(over: {
  board?: Partial<BoardFacts>;
  baseline?: Partial<StepBaseline>;
  chrome?: Partial<ChromeFacts>;
  bindings?: TutorialState['bindings'];
}): CheckContext {
  return {
    board: { tick: 10, generation: 1, swapFloor: 1, nodes: [], belts: [], ...over.board },
    baseline: { knownKeys: [], tick: 10, playing: true, lowestSlot: null, generation: 1, ...over.baseline },
    chrome: {
      armed: null,
      selectedNode: null,
      playing: true,
      triggerPressed: null,
      appliedTrigger: null,
      view: { camera: { x: 0, y: 0, scale: 1 }, freeArea: { left: 0, right: 800, top: 0, bottom: 600 } },
      ...over.chrome,
    },
    bindings: over.bindings ?? BINDINGS,
  };
}

describe('nodeAppeared', () => {
  const check = { is: 'nodeAppeared', kind: SOURCE, bind: 'source' } as const;

  it('finishes on a new machine of the kind it names, and binds it', () => {
    const result = evaluateCheck(check, ctx({ board: { nodes: [THE_SOURCE] } }));
    expect(result).toEqual({ done: true, bound: { name: 'source', node: { nodeKey: '0@2,2', id: 4 } } });
  });

  it('a Sink on the board does not finish a Source step', () => {
    expect(evaluateCheck(check, ctx({ board: { nodes: [THE_SINK] } })).done).toBe(false);
  });

  it('a node whose key is known does not count, even with a different id', () => {
    const remade = node(99, SOURCE, 2, 2);
    expect(evaluateCheck(check, ctx({ board: { nodes: [remade] }, baseline: { knownKeys: ['0@2,2'] } })).done).toBe(false);
  });

  it('ignores how many machines there are, so three of another kind finish nothing', () => {
    const others = [node(1, SINK, 1, 1), node(2, SINK, 1, 2), node(3, SINK, 1, 3)];
    expect(evaluateCheck(check, ctx({ board: { nodes: others } })).done).toBe(false);
  });
});

describe('triggerApplied', () => {
  const check = { is: 'triggerApplied', of: 'source', trigger: 'Timer' } as const;

  it('a pressed Timer with a Webhook answer stays not done', () => {
    const result = evaluateCheck(
      check,
      ctx({ chrome: { triggerPressed: 'Timer', appliedTrigger: { node: THE_SOURCE.id, kind: 'Webhook' } } }),
    );
    expect(result.done).toBe(false);
  });

  it('a Timer answer for another node stays not done', () => {
    expect(evaluateCheck(check, ctx({ chrome: { appliedTrigger: { node: 77, kind: 'Timer' } } })).done).toBe(false);
  });

  it('no answer yet stays not done', () => {
    expect(evaluateCheck(check, ctx({ chrome: { triggerPressed: 'Timer', appliedTrigger: null } })).done).toBe(false);
  });

  it('a Timer answer for the bound Source is done, and binds nothing', () => {
    const result = evaluateCheck(check, ctx({ chrome: { appliedTrigger: { node: THE_SOURCE.id, kind: 'Timer' } } }));
    expect(result).toEqual({ done: true, bound: null });
  });
});

describe('beltJoins', () => {
  const check = { is: 'beltJoins', a: 'source', b: 'sink', bind: 'belt' } as const;

  it('finishes on a belt that joins the two bound machines, and binds the belt', () => {
    const result = evaluateCheck(check, ctx({ board: { belts: [belt(9, [], INTO_THE_SINK)] } }));
    expect(result.done).toBe(true);
    expect(result.done && result.bound?.name).toBe('belt');
    expect(result.done && result.bound?.node.id).toBe(9);
  });

  it('finishes with the docks in reversed order, whichever way round the belt was drawn', () => {
    const reversed = [...INTO_THE_SINK].reverse();
    expect(evaluateCheck(check, ctx({ board: { belts: [belt(9, [], reversed)] } })).done).toBe(true);
  });

  it('finishes when the Sink sits at the Tail and the Source at the Head', () => {
    const swapped = [
      { end: 'Head', node: THE_SOURCE.id, port: 0 },
      { end: 'Tail', node: THE_SINK.id, port: 0 },
    ];
    expect(evaluateCheck(check, ctx({ board: { belts: [belt(9, [], swapped)] } })).done).toBe(true);
  });

  it('a belt docked to only one bound machine does not', () => {
    const halfway = [{ end: 'Tail', node: THE_SOURCE.id, port: 0 }];
    expect(evaluateCheck(check, ctx({ board: { belts: [belt(9, [], halfway)] } })).done).toBe(false);
  });

  it('a belt between one bound machine and a stranger does not', () => {
    const stranger = [
      { end: 'Tail', node: THE_SOURCE.id, port: 0 },
      { end: 'Head', node: 123, port: 0 },
    ];
    expect(evaluateCheck(check, ctx({ board: { belts: [belt(9, [], stranger)] } })).done).toBe(false);
  });

  describe('a line drawn in two pieces', () => {
    const FIRST = 20;
    const SECOND = 21;
    const THIRD = 22;
    const intoFirst: BoardBelt['docks'] = [
      { end: 'Head', node: SECOND, port: 0 },
      { end: 'Tail', node: THE_SOURCE.id, port: 0 },
    ];
    const intoSink: BoardBelt['docks'] = [
      { end: 'Head', node: THE_SINK.id, port: 0 },
      { end: 'Tail', node: FIRST, port: 0 },
    ];

    it('finishes, and binds the piece that runs into the Sink', () => {
      const result = evaluateCheck(check, ctx({ board: { belts: [belt(FIRST, [], intoFirst), belt(SECOND, [], intoSink)] } }));
      expect(result.done).toBe(true);
      expect(result.done && result.bound?.node.id).toBe(SECOND);
    });

    it('finishes through three pieces, whichever order the board lists them in', () => {
      const first = belt(FIRST, [], intoFirst);
      const second = belt(SECOND, [], [
        { end: 'Head', node: THIRD, port: 0 },
        { end: 'Tail', node: FIRST, port: 0 },
      ]);
      const third = belt(THIRD, [], [
        { end: 'Head', node: THE_SINK.id, port: 0 },
        { end: 'Tail', node: SECOND, port: 0 },
      ]);
      const result = evaluateCheck(check, ctx({ board: { belts: [third, first, second] } }));
      expect(result.done && result.bound?.node.id).toBe(THIRD);
    });

    it('does not finish while the first piece stops short of the Sink', () => {
      const shortOfTheSink: BoardBelt['docks'] = [{ end: 'Tail', node: THE_SOURCE.id, port: 0 }];
      expect(evaluateCheck(check, ctx({ board: { belts: [belt(FIRST, [], shortOfTheSink)] } })).done).toBe(false);
    });

    it('does not finish when the two pieces only abut, with no join between them', () => {
      const fromSource: BoardBelt['docks'] = [{ end: 'Tail', node: THE_SOURCE.id, port: 0 }];
      const toSink: BoardBelt['docks'] = [{ end: 'Head', node: THE_SINK.id, port: 0 }];
      expect(evaluateCheck(check, ctx({ board: { belts: [belt(FIRST, [], fromSource), belt(SECOND, [], toSink)] } })).done).toBe(false);
    });

    it('does not finish on a line from the Source into another machine', () => {
      const elsewhere: BoardBelt['docks'] = [
        { end: 'Head', node: 123, port: 0 },
        { end: 'Tail', node: FIRST, port: 0 },
      ];
      const fromStranger: BoardBelt['docks'] = [
        { end: 'Head', node: THE_SINK.id, port: 0 },
        { end: 'Tail', node: 123, port: 0 },
      ];
      const belts = [belt(FIRST, [], intoFirst), belt(SECOND, [], elsewhere), belt(THIRD, [], fromStranger)];
      expect(evaluateCheck(check, ctx({ board: { belts } })).done, 'a machine between them is not one line').toBe(false);
    });

    it('survives a loop of belts, and finishes nothing', () => {
      const looped: BoardBelt['docks'] = [
        { end: 'Head', node: FIRST, port: 0 },
        { end: 'Tail', node: FIRST, port: 0 },
      ];
      expect(evaluateCheck(check, ctx({ board: { belts: [belt(FIRST, [], intoFirst), belt(SECOND, [], looped)] } })).done).toBe(false);
    });
  });

  it('with no bound Sink, nothing joins', () => {
    const noSink = { source: BINDINGS.source! };
    expect(evaluateCheck(check, ctx({ board: { belts: [belt(9, [], INTO_THE_SINK)] }, bindings: noSink })).done).toBe(false);
  });
});

describe('tickRose', () => {
  const check = { is: 'tickRose' } as const;

  it('an equal tick is not done', () => {
    expect(evaluateCheck(check, ctx({ board: { tick: 10 }, baseline: { tick: 10 } })).done).toBe(false);
  });

  it('a higher tick is done', () => {
    expect(evaluateCheck(check, ctx({ board: { tick: 11 }, baseline: { tick: 10 } }))).toEqual({ done: true, bound: null });
  });
});

describe('itemArrived', () => {
  const check = { is: 'itemArrived', at: 'sink' } as const;
  const withSlots = (slots: readonly number[], lowestSlot: number | null, id = 9): CheckContext =>
    ctx({ board: { belts: [belt(id, slots, INTO_THE_SINK)] }, baseline: { lowestSlot } });

  it('a refused delivery: slot 0 held across frames is not done', () => {
    expect(evaluateCheck(check, withSlots([0, 4, 8], 0)).done).toBe(false);
  });

  it('a lowest slot that only falls is not done', () => {
    expect(evaluateCheck(check, withSlots([3, 7], 4)).done).toBe(false);
  });

  it('a rise on the belt docked at its Head to the bound Sink is done', () => {
    expect(evaluateCheck(check, withSlots([4], 0))).toEqual({ done: true, bound: null });
  });

  it('a belt emptied by the delivery is a rise too', () => {
    expect(evaluateCheck(check, withSlots([], 0)).done).toBe(true);
  });

  it('an empty belt that stays empty is not done', () => {
    expect(evaluateCheck(check, withSlots([], Number.POSITIVE_INFINITY)).done).toBe(false);
  });

  it('a rise on another belt is not done', () => {
    const elsewhere = [
      { end: 'Tail', node: THE_SINK.id, port: 0 },
      { end: 'Head', node: 55, port: 0 },
    ];
    const result = evaluateCheck(check, ctx({ board: { belts: [belt(3, [8], elsewhere)] }, baseline: { lowestSlot: 0 } }));
    expect(result.done).toBe(false);
  });

  it('a rise on a belt with the Sink at its Tail is not done, because nothing arrives at that end', () => {
    const backwards = [
      { end: 'Head', node: THE_SOURCE.id, port: 0 },
      { end: 'Tail', node: THE_SINK.id, port: 0 },
    ];
    const result = evaluateCheck(check, ctx({ board: { belts: [belt(3, [8], backwards)] }, baseline: { lowestSlot: 0 } }));
    expect(result.done).toBe(false);
  });

  it('a generation change between two frames is not done, because a keyframe re-mints handles', () => {
    const result = evaluateCheck(
      check,
      ctx({ board: { generation: 2, belts: [belt(9, [8], INTO_THE_SINK)] }, baseline: { generation: 1, lowestSlot: 0 } }),
    );
    expect(result.done).toBe(false);
  });

  it('no earlier value to compare with is not done', () => {
    expect(evaluateCheck(check, withSlots([8], null)).done).toBe(false);
  });
});
