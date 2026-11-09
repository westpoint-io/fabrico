import { describe, expect, it } from 'vitest';
import { BELT_ENDS, BINDING_NAMES_COMPLETE, boundBeltIds, boundMachineKeys, evaluateCheck, freeOutputs, lineDoorstep, lineStuck, looseBeltInTheWay, nodeKey, outputFacing, type CheckContext } from './check.ts';
import { boardShape } from './shape.ts';
import type { StepBaseline, TutorialState } from './machine.ts';
import type { AppliedConfig, BoardBelt, BoardFacts, BoardNode, ChromeFacts } from './types.ts';

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
  capture?: CheckContext['capture'];
}): CheckContext {
  return {
    board: { tick: 10, generation: 1, swapFloor: 1, nodes: [], belts: [], ...over.board },
    baseline: { knownKeys: [], tick: 10, playing: true, lowestSlots: {}, rose: [], generation: 1, factorySource: null, ...over.baseline },
    chrome: {
      armed: null,
      selectedNode: null,
      selectedBelt: null,
      playing: true,
      editsInFlight: false,
      triggerPressed: null,
      appliedTrigger: null,
      appliedConfigs: [],
      codeNotApplied: false,
      codeText: null,
      view: { camera: { x: 0, y: 0, scale: 1 }, freeArea: { left: 0, right: 800, top: 0, bottom: 600 } },
      ...over.chrome,
    },
    bindings: over.bindings ?? BINDINGS,
    capture: over.capture ?? null,
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

describe('lineDoorstep', () => {
  const FIRST = 20;
  const SECOND = 21;
  const tiles = (...cells: ReadonlyArray<readonly [number, number]>): BoardBelt['tiles'] =>
    cells.map(([cell_x, cell_y]) => ({ cell_x, cell_y }));
  const piece = (id: number, cells: BoardBelt['tiles'], docks: BoardBelt['docks']): BoardBelt => ({ ...belt(id, [], docks), tiles: cells });
  const leavesSource: BoardBelt['docks'] = [{ end: 'Tail', node: THE_SOURCE.id, port: 0 }];
  const SHORT = piece(FIRST, tiles([3, 2], [4, 2]), leavesSource);
  const on = (belts: readonly BoardBelt[], nodes: readonly BoardNode[] = [THE_SOURCE, THE_SINK]): BoardFacts => ({
    tick: 10,
    generation: 1,
    swapFloor: 1,
    nodes,
    belts,
  });

  it('is the cell past the Head of a piece that stops short', () => {
    expect(lineDoorstep(on([SHORT]), THE_SOURCE.id)).toEqual([5, 2]);
  });

  it('follows the direction of the last tile, so a turn counts', () => {
    const turned = piece(FIRST, tiles([3, 2], [3, 3], [3, 4]), leavesSource);
    expect(lineDoorstep(on([turned]), THE_SOURCE.id)).toEqual([3, 5]);
  });

  it('follows Head docks to the last piece', () => {
    const first = piece(FIRST, tiles([3, 2], [4, 2]), [...leavesSource, { end: 'Head', node: SECOND, port: 0 }]);
    const second = piece(SECOND, tiles([5, 2], [6, 2]), [{ end: 'Tail', node: FIRST, port: 0 }]);
    expect(lineDoorstep(on([second, first]), THE_SOURCE.id)).toEqual([7, 2]);
  });

  it('is null with no belt leaving the machine', () => {
    expect(lineDoorstep(on([]), THE_SOURCE.id)).toBeNull();
    const stranger = piece(FIRST, tiles([3, 2], [4, 2]), [{ end: 'Tail', node: 123, port: 0 }]);
    expect(lineDoorstep(on([stranger]), THE_SOURCE.id)).toBeNull();
  });

  it('is null when the line ends in a machine, because that end is not free', () => {
    const docked = piece(FIRST, tiles([3, 2], [4, 2]), [...leavesSource, { end: 'Head', node: 123, port: 0 }]);
    expect(lineDoorstep(on([docked]), THE_SOURCE.id)).toBeNull();
  });

  it('is null for a single tile, which has no direction and so no Head a press can find', () => {
    expect(lineDoorstep(on([piece(FIRST, tiles([3, 2]), leavesSource)]), THE_SOURCE.id)).toBeNull();
  });

  it('still names the cell when the Sink is on it, for the packet before the last piece docks', () => {
    expect(lineDoorstep(on([SHORT], [THE_SOURCE, node(6, SINK, 5, 2)]), THE_SOURCE.id)).toEqual([5, 2]);
  });

  it('survives a loop of belts', () => {
    const first = piece(FIRST, tiles([3, 2], [4, 2]), [...leavesSource, { end: 'Head', node: SECOND, port: 0 }]);
    const second = piece(SECOND, tiles([5, 2], [6, 2]), [{ end: 'Head', node: FIRST, port: 0 }]);
    expect(lineDoorstep(on([first, second]), THE_SOURCE.id)).toBeNull();
  });
});

describe('lineStuck', () => {
  // The Source's output feeds (3,2) and the Sink's input is fed from (7,2), as on a real board.
  const OUT_EAST = { index: 0, cell_x: 2, cell_y: 2, side: 1, role: 1 };
  const FAULT_SOUTH = { index: 0, cell_x: 8, cell_y: 2, side: 2, role: 2 };
  const IN_WEST = { index: 1, cell_x: 8, cell_y: 2, side: 3, role: 0 };
  const SOURCE_NODE: BoardNode = { ...THE_SOURCE, ports: [OUT_EAST] };
  const SINK_NODE: BoardNode = { ...THE_SINK, ports: [FAULT_SOUTH, IN_WEST] };
  const FIRST = 20;
  const SECOND = 21;
  const tiles = (...cells: ReadonlyArray<readonly [number, number]>): BoardBelt['tiles'] =>
    cells.map(([cell_x, cell_y]) => ({ cell_x, cell_y }));
  const piece = (id: number, cells: BoardBelt['tiles'], docks: BoardBelt['docks']): BoardBelt => ({ ...belt(id, [], docks), tiles: cells });
  const tail = (node: number): BoardBelt['docks'][number] => ({ end: 'Tail', node, port: 0 });
  const head = (node: number): BoardBelt['docks'][number] => ({ end: 'Head', node, port: 0 });
  const read = (belts: readonly BoardBelt[], editsInFlight: boolean): boolean =>
    lineStuck({ nodes: [SOURCE_NODE, SINK_NODE], belts }, SOURCE_NODE.id, SINK_NODE.id, editsInFlight);
  /** With nothing on its way from the app, so what's on the board is how it stays. */
  const stuck = (belts: readonly BoardBelt[]): boolean => read(belts, false);
  /** With a draw or a dock sent and not on the board yet. */
  const arriving = (belts: readonly BoardBelt[]): boolean => read(belts, true);

  it('is false on a board with no belt, and for a belt that has nothing to do with either machine', () => {
    expect(stuck([])).toBe(false);
    expect(stuck([piece(FIRST, tiles([3, 6], [4, 6]), [])])).toBe(false);
  });

  it('is false once the line reaches the Sink, in one piece or two', () => {
    expect(stuck([piece(FIRST, tiles([3, 2], [4, 2], [5, 2], [6, 2], [7, 2]), [tail(SOURCE_NODE.id), head(SINK_NODE.id)])])).toBe(false);
    const first = piece(FIRST, tiles([3, 2], [4, 2]), [tail(SOURCE_NODE.id), head(SECOND)]);
    const second = piece(SECOND, tiles([5, 2], [6, 2], [7, 2]), [tail(FIRST), head(SINK_NODE.id)]);
    expect(stuck([first, second])).toBe(false);
  });

  it('is false for a piece with a free end a press can carry on from', () => {
    expect(stuck([piece(FIRST, tiles([3, 2], [4, 2]), [tail(SOURCE_NODE.id)])])).toBe(false);
  });

  it('holds for a single tile left by a click on the output ring', () => {
    expect(stuck([piece(FIRST, tiles([3, 2]), [tail(SOURCE_NODE.id)])])).toBe(true);
  });

  it('holds for a single tile left by a click on the ring at a free end', () => {
    const first = piece(FIRST, tiles([3, 2], [4, 2]), [tail(SOURCE_NODE.id), head(SECOND)]);
    expect(stuck([first, piece(SECOND, tiles([5, 2]), [tail(FIRST)])])).toBe(true);
  });

  it('is false for a single tile on the input doorstep while its dock is on the way, and holds once none is', () => {
    const first = piece(FIRST, tiles([3, 2], [4, 2], [5, 2], [6, 2]), [tail(SOURCE_NODE.id), head(SECOND)]);
    const belts = [first, piece(SECOND, tiles([7, 2]), [tail(FIRST)])];
    expect(arriving(belts)).toBe(false);
    expect(stuck(belts)).toBe(true);
  });

  it('holds for a short piece drawn backwards from the input', () => {
    expect(stuck([piece(FIRST, tiles([5, 2], [6, 2], [7, 2]), [head(SINK_NODE.id)])])).toBe(true);
  });

  it('holds for that backward piece beside a short piece from the Source, because the input is taken', () => {
    const fromSource = piece(FIRST, tiles([3, 2], [4, 2]), [tail(SOURCE_NODE.id)]);
    expect(stuck([fromSource, piece(SECOND, tiles([6, 2], [7, 2]), [head(SINK_NODE.id)])])).toBe(true);
  });

  it('is false for a whole backward draw while its Tail dock is on the way, and holds once none is', () => {
    const whole = [piece(FIRST, tiles([3, 2], [4, 2], [5, 2], [6, 2], [7, 2]), [head(SINK_NODE.id)])];
    expect(arriving(whole)).toBe(false);
    expect(stuck(whole), 'the output and the input are both taken, so only Undo clears this').toBe(true);
    const fromSource = piece(FIRST, tiles([3, 2], [4, 2]), [tail(SOURCE_NODE.id)]);
    const twoPieces = [fromSource, piece(SECOND, tiles([5, 2], [6, 2], [7, 2]), [head(SINK_NODE.id)])];
    expect(arriving(twoPieces)).toBe(false);
    expect(stuck(twoPieces)).toBe(true);
  });

  it('holds for a belt into the Sink that came from some other machine', () => {
    expect(stuck([piece(FIRST, tiles([5, 2], [6, 2], [7, 2]), [tail(123), head(SINK_NODE.id)])])).toBe(true);
  });

  it('holds for a belt that points at a machine it cannot dock with', () => {
    // Coming down onto the top of the Sink, whose input faces west.
    expect(stuck([piece(FIRST, tiles([3, 2], [3, 0], [8, 0], [8, 1]), [tail(SOURCE_NODE.id)])])).toBe(true);
  });

  it('holds for a belt whose next cell holds another belt it can only cross', () => {
    const crossing = piece(SECOND, tiles([5, 1], [5, 2], [5, 3]), []);
    expect(stuck([piece(FIRST, tiles([3, 2], [4, 2]), [tail(SOURCE_NODE.id)]), crossing])).toBe(true);
  });

  it('is false while the Head dock of a belt on the input doorstep is on the way', () => {
    expect(arriving([piece(FIRST, tiles([3, 2], [4, 2], [5, 2], [6, 2], [7, 2]), [tail(SOURCE_NODE.id)])])).toBe(false);
  });

  it('holds for that belt once no dock is on the way, which is where one Undo leaves a finished belt', () => {
    expect(stuck([piece(FIRST, tiles([3, 2], [4, 2], [5, 2], [6, 2], [7, 2]), [tail(SOURCE_NODE.id)])])).toBe(true);
  });

  it('holds where one Undo leaves a line of two pieces', () => {
    const first = piece(FIRST, tiles([3, 2], [4, 2]), [tail(SOURCE_NODE.id), head(SECOND)]);
    expect(stuck([first, piece(SECOND, tiles([5, 2], [6, 2], [7, 2]), [tail(FIRST)])])).toBe(true);
  });

  it("is false while a new piece's docks are on the way, with its first tile on the next cell", () => {
    const newPiece = piece(SECOND, tiles([5, 2], [6, 2]), []);
    expect(arriving([piece(FIRST, tiles([3, 2], [4, 2]), [tail(SOURCE_NODE.id)]), newPiece])).toBe(false);
  });

  it('holds for that piece once no dock is on the way, because the next cell is taken', () => {
    const loosePiece = piece(SECOND, tiles([5, 2], [6, 2]), []);
    expect(stuck([piece(FIRST, tiles([3, 2], [4, 2]), [tail(SOURCE_NODE.id)]), loosePiece])).toBe(true);
  });

  it('holds for a belt with no docks in the way of the plain drag, once no dock is on the way', () => {
    const onTheOutput = [piece(FIRST, tiles([3, 2], [4, 2]), [])];
    const onTheInput = [piece(FIRST, tiles([6, 2], [7, 2]), [])];
    expect(stuck(onTheOutput)).toBe(true);
    expect(stuck(onTheInput)).toBe(true);
    expect(arriving(onTheOutput), 'a good draw looks like this before its docks arrive').toBe(false);
    expect(arriving(onTheInput)).toBe(false);
  });

  it('holds for a line that ends in some other machine, or in a loop', () => {
    expect(stuck([piece(FIRST, tiles([3, 2], [4, 2]), [tail(SOURCE_NODE.id), head(123)])])).toBe(true);
    const first = piece(FIRST, tiles([3, 2], [4, 2]), [tail(SOURCE_NODE.id), head(SECOND)]);
    expect(stuck([first, piece(SECOND, tiles([5, 2], [6, 2]), [head(FIRST)])])).toBe(true);
  });
});

describe('looseBeltInTheWay', () => {
  const OUT_EAST = { index: 0, cell_x: 2, cell_y: 2, side: 1, role: 1 };
  const IN_WEST = { index: 1, cell_x: 8, cell_y: 2, side: 3, role: 0 };
  const nodes: BoardNode[] = [{ ...THE_SOURCE, ports: [OUT_EAST] }, { ...THE_SINK, ports: [IN_WEST] }];
  const at = (id: number, cells: ReadonlyArray<readonly [number, number]>, docks: BoardBelt['docks'] = []): BoardBelt => ({
    ...belt(id, [], docks),
    tiles: cells.map(([cell_x, cell_y]) => ({ cell_x, cell_y })),
  });
  const loose = (belts: readonly BoardBelt[]): boolean => looseBeltInTheWay({ nodes, belts }, THE_SOURCE.id, THE_SINK.id);

  it("finds a belt with no docks on the Source's output doorstep", () => {
    expect(loose([at(20, [[3, 2]])])).toBe(true);
  });

  it("finds one on the Sink's input doorstep", () => {
    expect(loose([at(20, [[6, 2], [7, 2]])])).toBe(true);
  });

  it('finds one on the cell past the end of the line', () => {
    const line = at(20, [[3, 2], [4, 2]], [{ end: 'Tail', node: THE_SOURCE.id, port: 0 }]);
    expect(loose([line, at(21, [[5, 2]])])).toBe(true);
  });

  it('leaves a belt with no docks somewhere else, and a docked belt, alone', () => {
    expect(loose([at(20, [[3, 6], [4, 6]])])).toBe(false);
    expect(loose([at(20, [[3, 2], [4, 2]], [{ end: 'Tail', node: THE_SOURCE.id, port: 0 }])])).toBe(false);
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
    ctx({ board: { belts: [belt(id, slots, INTO_THE_SINK)] }, baseline: { lowestSlots: { sink: lowestSlot } } });

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
    const result = evaluateCheck(check, ctx({ board: { belts: [belt(3, [8], elsewhere)] }, baseline: { lowestSlots: { sink: 0 } } }));
    expect(result.done).toBe(false);
  });

  it('a rise on a belt with the Sink at its Tail is not done, because nothing arrives at that end', () => {
    const backwards = [
      { end: 'Head', node: THE_SOURCE.id, port: 0 },
      { end: 'Tail', node: THE_SINK.id, port: 0 },
    ];
    const result = evaluateCheck(check, ctx({ board: { belts: [belt(3, [8], backwards)] }, baseline: { lowestSlots: { sink: 0 } } }));
    expect(result.done).toBe(false);
  });

  it('a generation change between two frames is not done, because a keyframe re-mints handles', () => {
    const result = evaluateCheck(
      check,
      ctx({ board: { generation: 2, belts: [belt(9, [8], INTO_THE_SINK)] }, baseline: { generation: 1, lowestSlots: { sink: 0 } } }),
    );
    expect(result.done).toBe(false);
  });

  it('no earlier value to compare with is not done', () => {
    expect(evaluateCheck(check, withSlots([8], null)).done).toBe(false);
  });
});

describe('nodeGone and beltGone', () => {
  const BELT_BINDING = { ...BINDINGS, belt: { nodeKey: 'belt:0@2,2+7@8,2', id: 9 } };

  it('nodeGone is done on a diff frame that drops the bound Sink, with the generation unchanged', () => {
    const check = { is: 'nodeGone', of: 'sink' } as const;
    expect(evaluateCheck(check, ctx({ board: { nodes: [THE_SOURCE, THE_SINK] } })).done).toBe(false);
    expect(evaluateCheck(check, ctx({ board: { nodes: [THE_SOURCE] } }))).toEqual({ done: true, bound: null });
  });

  it('nodeGone is not done on a keyframe that drops it with the generation raised, because that was an Undo', () => {
    const check = { is: 'nodeGone', of: 'sink' } as const;
    expect(evaluateCheck(check, ctx({ board: { generation: 2, nodes: [THE_SOURCE] }, baseline: { generation: 1 } })).done).toBe(false);
  });

  it('nodeGone is not done for a binding the lesson never made', () => {
    expect(evaluateCheck({ is: 'nodeGone', of: 'factory' }, ctx({ board: { nodes: [THE_SOURCE] } })).done).toBe(false);
  });

  it('beltGone is done on a diff frame with no belt joining the two machines', () => {
    const check = { is: 'beltGone', of: 'belt' } as const;
    const joined = { nodes: [THE_SOURCE, THE_SINK], belts: [belt(9, [], INTO_THE_SINK)] };
    expect(evaluateCheck(check, ctx({ board: joined, bindings: BELT_BINDING })).done).toBe(false);
    expect(evaluateCheck(check, ctx({ board: { nodes: [THE_SOURCE, THE_SINK] }, bindings: BELT_BINDING })).done).toBe(true);
  });

  it('beltGone is not done on a keyframe with the generation raised', () => {
    const check = { is: 'beltGone', of: 'belt' } as const;
    expect(evaluateCheck(check, ctx({ board: { generation: 3, nodes: [THE_SOURCE, THE_SINK] }, bindings: BELT_BINDING })).done).toBe(false);
  });

  it('names a belt by its two machines in BELT_ENDS, with every binding name listed', () => {
    expect(BELT_ENDS).toEqual({ belt: ['source', 'sink'], beltIn: ['source', 'factory'], beltOut: ['factory', 'sink'], beltOut2: ['factory', 'sink2'] });
    expect(BINDING_NAMES_COMPLETE).toBe(true);
  });
});

describe('restored', () => {
  const tiles = [3, 4, 5, 6, 7].map((x) => ({ cell_x: x, cell_y: 2, kind: { Straight: { axis: 0 } } }));
  const line = (src: number, snk: number, id: number, docks?: BoardBelt['docks']): Partial<BoardFacts> => ({
    nodes: [{ ...THE_SOURCE, id: src }, { ...THE_SINK, id: snk }],
    belts: [
      {
        ...belt(id, [], [
          { end: 'Tail', node: src, port: 0 },
          { end: 'Head', node: snk, port: 0 },
        ]),
        tiles,
        ...(docks === undefined ? {} : { docks }),
      },
    ],
  });
  /** The host's answers for the Source and the Sink at these handles, asked at generation 1. */
  const answers = (src: number, snk: number): AppliedConfig[] => [
    { node: src, generation: 1, config: { kind: 'Source', trigger: { kind: 'Webhook' } } },
    { node: snk, generation: 1, config: { kind: 'Sink', target: { kind: 'Debug' } } },
  ];
  const CAPTURE = {
    since: 'delete-belt',
    generation: 1,
    handles: {},
    shape: boardShape({ nodes: [], belts: [], generation: 1, ...line(4, 5, 9) }, answers(4, 5), boundMachineKeys(BINDINGS)),
  };
  const check = { is: 'restored', since: 'delete-belt' } as const;

  it('is done when the captured shape comes back under new handles', () => {
    expect(evaluateCheck(check, ctx({ board: line(40, 41, 42), chrome: { appliedConfigs: answers(40, 41) }, capture: CAPTURE })).done).toBe(true);
  });

  it('is not done while a restored machine has no config answer', () => {
    expect(evaluateCheck(check, ctx({ board: line(40, 41, 42), capture: CAPTURE })).done).toBe(false);
    expect(evaluateCheck(check, ctx({ board: line(40, 41, 42), chrome: { appliedConfigs: answers(40, 41).slice(0, 1) }, capture: CAPTURE })).done).toBe(false);
  });

  it("is not done while the belt's Head dock is missing", () => {
    const board = line(40, 41, 42, [{ end: 'Tail', node: 40, port: 0 }]);
    expect(evaluateCheck(check, ctx({ board, capture: CAPTURE })).done).toBe(false);
  });

  it('is not done with no capture, or a capture from another step', () => {
    expect(evaluateCheck(check, ctx({ board: line(40, 41, 42) })).done).toBe(false);
    expect(evaluateCheck(check, ctx({ board: line(40, 41, 42), capture: { ...CAPTURE, since: 'draw-belt' } })).done).toBe(false);
  });
});

// Lesson 4's Factory: 3 by 3 at (6,4), its In on the west of the middle row, its first Out on the east
// of the middle row and its Fault on the south. After + Add output, a second Out sits east of the bottom
// row, so the ports read [In, Out, Fault, Out] and the box doesn't grow.
const FACTORY = 2;
const cells3x3 = (x: number, y: number): number[][] => [0, 1, 2].flatMap((dy) => [0, 1, 2].map((dx) => [x + dx, y + dy]));
const ONE_OUT: BoardNode = {
  id: 6,
  kind: FACTORY,
  cells: cells3x3(6, 4),
  ports: [
    { index: 0, cell_x: 6, cell_y: 5, side: 3, role: 0 },
    { index: 1, cell_x: 8, cell_y: 5, side: 1, role: 1 },
    { index: 2, cell_x: 7, cell_y: 6, side: 2, role: 2 },
  ],
};
const TWO_OUTS: BoardNode = { ...ONE_OUT, ports: [...ONE_OUT.ports, { index: 3, cell_x: 8, cell_y: 6, side: 1, role: 1 }] };
const FACTORY_BOUND: TutorialState['bindings'] = { factory: { nodeKey: nodeKey(ONE_OUT), id: ONE_OUT.id } };

describe('portAdded', () => {
  const check = { is: 'portAdded', of: 'factory', outs: 2 } as const;

  it('a Factory holding [In, Out, Fault, Out] is done', () => {
    expect(evaluateCheck(check, ctx({ board: { nodes: [TWO_OUTS] }, bindings: FACTORY_BOUND }))).toEqual({ done: true, bound: null });
  });

  it('a fresh Factory holding [In, Out, Fault] is not done', () => {
    expect(evaluateCheck(check, ctx({ board: { nodes: [ONE_OUT] }, bindings: FACTORY_BOUND })).done).toBe(false);
  });

  it('a Factory that moved to another cell is not done, because it is found by its key', () => {
    const moved: BoardNode = { ...TWO_OUTS, cells: cells3x3(6, 3) };
    expect(evaluateCheck(check, ctx({ board: { nodes: [moved] }, bindings: FACTORY_BOUND })).done).toBe(false);
  });
});

describe('itemsArriveAtBoth', () => {
  const check = { is: 'itemsArriveAtBoth', at: ['sink', 'sink2'] } as const;
  const SINK_TWO = node(15, SINK, 12, 6);
  const bindings: TutorialState['bindings'] = {
    sink: { nodeKey: nodeKey(THE_SINK), id: THE_SINK.id },
    sink2: { nodeKey: nodeKey(SINK_TWO), id: SINK_TWO.id },
  };
  const into = (id: number, sink: number, slots: readonly number[]): BoardBelt =>
    belt(id, slots, [
      { end: 'Tail', node: ONE_OUT.id, port: 0 },
      { end: 'Head', node: sink, port: 1 },
    ]);
  const at = (first: readonly number[], second: readonly number[], baseline: Partial<StepBaseline>): CheckContext =>
    ctx({ board: { belts: [into(20, THE_SINK.id, first), into(21, SINK_TWO.id, second)] }, baseline, bindings });

  it('a rise into one Sink alone is not done', () => {
    expect(evaluateCheck(check, at([4], [3], { lowestSlots: { sink: 0, sink2: 3 } })).done).toBe(false);
  });

  it('a rise into the second Sink, with the first latched on an earlier frame, is done', () => {
    expect(evaluateCheck(check, at([0], [4], { lowestSlots: { sink: 0, sink2: 0 }, rose: ['sink'] }))).toEqual({ done: true, bound: null });
  });

  it('both rising on the same frame is done', () => {
    expect(evaluateCheck(check, at([4], [4], { lowestSlots: { sink: 0, sink2: 0 } })).done).toBe(true);
  });

  it('a keyframe is no rise, though a latch already taken stands', () => {
    const across = ctx({
      board: { generation: 2, belts: [into(20, THE_SINK.id, [0]), into(21, SINK_TWO.id, [9])] },
      baseline: { generation: 1, lowestSlots: { sink: 0, sink2: 0 }, rose: ['sink'] },
      bindings,
    });
    expect(evaluateCheck(check, across).done).toBe(false);
  });
});

describe('freeOutputs', () => {
  // A Tail dock names an output by its place among the Outs: 0 is the first Out, 1 the second.
  const outOf = (ordinal: number): BoardBelt => belt(30 + ordinal, [], [{ end: 'Tail', node: TWO_OUTS.id, port: ordinal }]);

  it('with a belt on the first Out, the free pick is the second', () => {
    expect(freeOutputs(TWO_OUTS, [outOf(0)]).map((p) => p.index)).toEqual([3]);
  });

  it('with a belt on the second Out, the free pick is the first', () => {
    expect(freeOutputs(TWO_OUTS, [outOf(1)]).map((p) => p.index)).toEqual([1]);
  });

  it('with both Outs docked, there is none', () => {
    expect(freeOutputs(TWO_OUTS, [outOf(0), outOf(1)])).toEqual([]);
  });

  it("a belt docked at another machine's first output doesn't take this one's", () => {
    const elsewhere = belt(40, [], [{ end: 'Tail', node: 99, port: 0 }]);
    expect(freeOutputs(TWO_OUTS, [elsewhere]).map((p) => p.index)).toEqual([1, 3]);
  });
});

describe('outputFacing', () => {
  // Lesson 4's unit Factory: a 3 by 3 at (6, 4), its first Out at (8, 5) and its second at (8, 6), both facing east.
  const factory: BoardNode = {
    id: 31,
    kind: 2,
    cells: [0, 1, 2].flatMap((dy) => [0, 1, 2].map((dx) => [6 + dx, 4 + dy] as [number, number])),
    ports: [
      { index: 0, cell_x: 6, cell_y: 5, side: 3, role: 0 },
      { index: 1, cell_x: 8, cell_y: 5, side: 1, role: 1 },
      { index: 2, cell_x: 7, cell_y: 6, side: 2, role: 2 },
      { index: 3, cell_x: 8, cell_y: 6, side: 1, role: 1 },
    ],
  };
  const at = (x: number, y: number): BoardNode => ({ id: 32, kind: 7, cells: [[x, y]], ports: [] });
  const facing = (x: number, y: number): number | null => outputFacing(factory, at(x, y))?.index ?? null;

  it("a machine on the second output's line faces it, at its ring cell or past it", () => {
    expect(facing(12, 6)).toBe(3);
    expect(facing(13, 6)).toBe(3);
  });

  it("a machine on the first output's line faces the first", () => {
    expect(facing(12, 5)).toBe(1);
    expect(facing(13, 5)).toBe(1);
  });

  it("a machine on neither line, or behind the Factory on the first output's row, faces neither", () => {
    expect(facing(12, 8)).toBeNull();
    expect(facing(2, 5)).toBeNull();
  });
});

describe('the line helpers leave bound belts out', () => {
  const SINK_ONE = { ...node(14, SINK, 12, 5), ports: [{ index: 1, cell_x: 12, cell_y: 5, side: 3, role: 0 }] };
  const SINK_TWO = { ...node(15, SINK, 12, 6), ports: [{ index: 1, cell_x: 12, cell_y: 6, side: 3, role: 0 }] };
  const BELT_OUT: BoardBelt = {
    ...belt(20, [], [
      { end: 'Tail', node: TWO_OUTS.id, port: 0 },
      { end: 'Head', node: SINK_ONE.id, port: 1 },
    ]),
    tiles: [9, 10, 11].map((x) => ({ cell_x: x, cell_y: 5 })),
  };
  const b = { nodes: [TWO_OUTS, SINK_ONE, SINK_TWO], belts: [BELT_OUT] };

  it("read with the first output's belt, the free output's line is stuck, which is why it is left out", () => {
    expect(lineStuck(b, TWO_OUTS.id, SINK_TWO.id, false)).toBe(true);
  });

  it('with that belt bound, the free output has no line yet: not stuck, and no end to carry on from', () => {
    const skip = boundBeltIds({ beltOut: { nodeKey: 'belt:x', id: BELT_OUT.id } });
    expect(lineStuck(b, TWO_OUTS.id, SINK_TWO.id, false, skip)).toBe(false);
    expect(lineDoorstep(b, TWO_OUTS.id, skip)).toBeNull();
  });

  it('only belt bindings count as bound belts', () => {
    expect([...boundBeltIds({ source: { nodeKey: '0@0,0', id: 1 }, beltIn: { nodeKey: 'belt:a', id: 7 }, beltOut2: { nodeKey: 'belt:b', id: 8 } })].sort()).toEqual([7, 8]);
  });
});
