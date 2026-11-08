import { describe, expect, it } from 'vitest';
import { nodeKey } from './check.ts';
import { awaitingConfigs, beltTilesIn, boardShape, handlesByKey, sameShape, stableJson, withConfigs } from './shape.ts';
import type { AppliedConfig, BoardBelt, BoardFacts, BoardNode } from './types.ts';

const SOURCE = 0;
const SINK = 7;
const STRAIGHT = { Straight: { axis: 0 } };

function source(id: number): BoardNode {
  return { id, kind: SOURCE, cells: [[2, 2]], ports: [{ index: 0, cell_x: 2, cell_y: 2, side: 1, role: 1 }] };
}

/** A Sink at (8, 2): its fault on the south side and its input on the west, or turned, on the north and east. */
function sink(id: number, turned = false): BoardNode {
  return {
    id,
    kind: SINK,
    cells: [[8, 2]],
    ports: [
      { index: 0, cell_x: 8, cell_y: 2, side: turned ? 0 : 2, role: 2 },
      { index: 1, cell_x: 8, cell_y: 2, side: turned ? 1 : 3, role: 0 },
    ],
  };
}

function belt(id: number, from: number, to: number, over: Partial<BoardBelt> = {}): BoardBelt {
  return {
    id,
    items: 0,
    occupiedSlots: [],
    tiles: [3, 4, 5, 6, 7].map((x) => ({ cell_x: x, cell_y: 2, kind: STRAIGHT })),
    docks: [
      { end: 'Tail', node: from, port: 0 },
      { end: 'Head', node: to, port: 1 },
    ],
    ...over,
  };
}

function line(ids: { source: number; sink: number; belt: number }, over: Partial<BoardBelt> = {}, turned = false): Pick<BoardFacts, 'nodes' | 'belts'> {
  return { nodes: [source(ids.source), sink(ids.sink, turned)], belts: [belt(ids.belt, ids.source, ids.sink, over)] };
}

const BEFORE = line({ source: 4, sink: 5, belt: 9 });

const GEN = 1;
const WEBHOOK: AppliedConfig['config'] = { kind: 'Source', trigger: { kind: 'Webhook' } };
const DEBUG: AppliedConfig['config'] = { kind: 'Sink', target: { kind: 'Debug' } };

/** The host's answer for every machine on `b`, at generation `GEN`: the Source on Webhook and the Sink on Debug. */
function answered(b: Pick<BoardFacts, 'nodes'>, over: Partial<Record<number, AppliedConfig['config']>> = {}): AppliedConfig[] {
  return b.nodes.map((n) => ({ node: n.id, generation: GEN, config: n.id in over ? (over[n.id] ?? null) : n.kind === SOURCE ? WEBHOOK : DEBUG }));
}

/**
 * The shape of `b` at generation `GEN`, every machine answered unless `answers` says otherwise. Every
 * machine's config is read unless `read` names fewer, so these cases mean what they did before the read set.
 */
function shapeOf(
  b: Pick<BoardFacts, 'nodes' | 'belts'>,
  answers: readonly AppliedConfig[] = answered(b),
  read: ReadonlySet<string> = new Set(b.nodes.map(nodeKey)),
) {
  return boardShape({ ...b, generation: GEN }, answers, read);
}

describe('boardShape', () => {
  it('reads the same for the same line under re-minted handles, so Undo can match it', () => {
    const after = line({ source: 40, sink: 41, belt: 42 });
    expect(sameShape(shapeOf(after), shapeOf(BEFORE))).toBe(true);
    // Handles in a different order on the board change nothing either.
    const shuffled = { nodes: [...after.nodes].reverse(), belts: after.belts };
    expect(sameShape(shapeOf(shuffled), shapeOf(BEFORE))).toBe(true);
  });

  it('holds no handle anywhere', () => {
    const text = stableJson(shapeOf(line({ source: 1234, sink: 5678, belt: 9012 })));
    for (const handle of ['1234', '5678', '9012']) expect(text).not.toContain(handle);
  });

  it('reads a different shape for a turned Sink, whose ports sit on other sides', () => {
    const turned = line({ source: 40, sink: 41, belt: 42 }, {}, true);
    expect(sameShape(shapeOf(turned), shapeOf(BEFORE))).toBe(false);
  });

  it("reads a different shape for a belt whose Head docks another port", () => {
    const other = line({ source: 40, sink: 41, belt: 42 }, {
      docks: [
        { end: 'Tail', node: 40, port: 0 },
        { end: 'Head', node: 41, port: 0 },
      ],
    });
    expect(sameShape(shapeOf(other), shapeOf(BEFORE))).toBe(false);
  });

  it('reads a different shape for a belt with its Head dock missing', () => {
    const loose = line({ source: 40, sink: 41, belt: 42 }, { docks: [{ end: 'Tail', node: 40, port: 0 }] });
    expect(sameShape(shapeOf(loose), shapeOf(BEFORE))).toBe(false);
  });

  it('reads a different shape for a tile of another kind', () => {
    const tiles = BEFORE.belts[0]!.tiles.map((t, i) => (i === 4 ? { ...t, kind: { Corner: { from: 0, to: 1 } } } : t));
    expect(sameShape(shapeOf(line({ source: 4, sink: 5, belt: 9 }, { tiles })), shapeOf(BEFORE))).toBe(false);
  });

  it('reads the same shape for a belt carrying items as for an empty one', () => {
    const full = line({ source: 40, sink: 41, belt: 42 }, { items: 3, occupiedSlots: [0, 2, 4] });
    expect(sameShape(shapeOf(full), shapeOf(BEFORE))).toBe(true);
  });

  it('reads a different shape for a restored Sink whose config differs from the captured one', () => {
    const after = line({ source: 40, sink: 41, belt: 42 });
    const http: AppliedConfig['config'] = { kind: 'Sink', target: { kind: 'Http', url: 'http://127.0.0.1:9/x', method: 0 } };
    expect(sameShape(shapeOf(after, answered(after, { 41: http })), shapeOf(BEFORE))).toBe(false);
    // And the same config under new handles still matches.
    expect(sameShape(shapeOf(after, answered(after)), shapeOf(BEFORE))).toBe(true);
  });

  it('is incomplete with a machine unanswered, and an incomplete shape never matches, not even itself', () => {
    const missing = shapeOf(BEFORE, answered(BEFORE).slice(0, 1));
    expect(missing.complete).toBe(false);
    expect(sameShape(missing, missing)).toBe(false);
    expect(sameShape(missing, shapeOf(BEFORE))).toBe(false);
    expect(shapeOf(BEFORE).complete).toBe(true);
  });

  it('reads no answer from another generation, so an answer from before an Undo keyframe never counts', () => {
    const stale = answered(BEFORE).map((a) => ({ ...a, generation: GEN - 1 }));
    expect(shapeOf(BEFORE, stale).complete).toBe(false);
  });

  it('takes an answer of no config as an answer', () => {
    const none = shapeOf(BEFORE, answered(BEFORE, { 5: null }));
    expect(none.complete).toBe(true);
    expect(sameShape(none, shapeOf(BEFORE))).toBe(false);
  });

  describe('with a machine the lesson never bound', () => {
    /** BEFORE plus a second Source at (2, 5), as a repeat floor click leaves one. */
    const withExtra = (ids: { source: number; sink: number; belt: number; extra: number }) => {
      const b = line(ids);
      return { nodes: [...b.nodes, { ...source(ids.extra), cells: [[2, 5]] as [number, number][] }], belts: b.belts };
    };
    const bound = new Set(['0@2,2', '7@8,2']);
    const before = withExtra({ source: 4, sink: 5, belt: 9, extra: 6 });
    const after = withExtra({ source: 40, sink: 41, belt: 42, extra: 43 });

    it("matches when the two differ only in that machine's config", () => {
      const timer: AppliedConfig['config'] = { kind: 'Source', trigger: { kind: 'Timer', interval_ticks: 30 } };
      expect(sameShape(shapeOf(after, answered(after, { 43: timer }), bound), shapeOf(before, answered(before), bound))).toBe(true);
    });

    it("doesn't match when a bound machine's config differs", () => {
      const http: AppliedConfig['config'] = { kind: 'Sink', target: { kind: 'Http', url: 'http://127.0.0.1:9/x', method: 0 } };
      expect(sameShape(shapeOf(after, answered(after, { 41: http }), bound), shapeOf(before, answered(before), bound))).toBe(false);
    });

    it('is complete with no answer about it, and marks it unread', () => {
      const shape = shapeOf(before, answered(before).filter((a) => a.node !== 6), bound);
      expect(shape.complete).toBe(true);
      expect(shape.machines.find((m) => m.nodeKey === '0@2,5')?.config).toBe('unread');
    });
  });

  it('writes a tile kind the same whatever order its keys came in', () => {
    expect(stableJson({ Corner: { to: 1, from: 0 } })).toBe(stableJson({ Corner: { from: 0, to: 1 } }));
  });
});

describe('withConfigs', () => {
  it("fills a missing config from the answer about the handle the machine had, at the shape's generation", () => {
    const partial = shapeOf(BEFORE, answered(BEFORE).slice(0, 1));
    const handles = handlesByKey(BEFORE);
    const filled = withConfigs(partial, handles, answered(BEFORE), GEN);
    expect(filled.complete).toBe(true);
    expect(sameShape(filled, shapeOf(BEFORE))).toBe(true);
    // An answer from another generation, or about another handle, leaves it as it was.
    expect(withConfigs(partial, handles, answered(BEFORE).map((a) => ({ ...a, generation: GEN + 1 })), GEN)).toBe(partial);
    expect(withConfigs(partial, handles, [{ node: 77, generation: GEN, config: DEBUG }], GEN)).toBe(partial);
  });
});

describe('awaitingConfigs', () => {
  const after = line({ source: 40, sink: 41, belt: 42 });
  const http: AppliedConfig['config'] = { kind: 'Sink', target: { kind: 'Http', url: 'http://127.0.0.1:9/x', method: 0 } };

  it('is true for equal shapes with one answer still missing', () => {
    expect(awaitingConfigs(shapeOf(BEFORE), shapeOf(after, answered(after).slice(0, 1)))).toBe(true);
    expect(awaitingConfigs(shapeOf(BEFORE), shapeOf(after, []))).toBe(true);
  });

  it("is false when a bound machine's config differs while another is missing", () => {
    expect(awaitingConfigs(shapeOf(BEFORE), shapeOf(after, answered(after, { 41: http }).slice(1)))).toBe(false);
  });

  it('is false for complete equal shapes, which the restored check already matches', () => {
    expect(awaitingConfigs(shapeOf(BEFORE), shapeOf(after))).toBe(false);
  });

  it('is false with the belt missing, whatever the answers', () => {
    const noBelt = { nodes: after.nodes, belts: [] };
    expect(awaitingConfigs(shapeOf(BEFORE), shapeOf(noBelt, answered(noBelt).slice(0, 1)))).toBe(false);
  });
});

describe('beltTilesIn', () => {
  it("finds the belt docked to both machines by their keys, and nothing for a pair it doesn't join", () => {
    const shape = shapeOf(BEFORE);
    expect(beltTilesIn(shape, '0@2,2', '7@8,2')?.map((t) => t.cell_x)).toEqual([3, 4, 5, 6, 7]);
    expect(beltTilesIn(shape, '0@2,2', '7@9,9')).toBeNull();
  });
});
