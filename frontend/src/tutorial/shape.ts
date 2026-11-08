// shape.ts - the board as a plain value with no handle in it, for the check that says a board came back.
//
// Undo re-mints every handle it puts back, and a keyframe can even hand an old handle to another
// element, so two boards are compared by what a person could see of them: each machine's kind, cells
// and ports, and each belt's tiles and what its ends dock to, named by the docked machine's `nodeKey`.
// Item counts stay out, so a belt that lost its items still reads as the same belt. Pure, like the rest
// of this folder.

import { nodeKey } from './check';
import type { BoardFacts } from './types';

export interface MachineShape {
  nodeKey: string;
  kind: number;
  cells: ReadonlyArray<readonly [number, number]>;
  /** In the board's port order, which is the order a dock's `port` counts in. The side carries the turn. */
  ports: ReadonlyArray<{ role: number; cell_x: number; cell_y: number; side: number }>;
  /** The machine's applied config. Plan 104-02 fills it through the tutorial's one host read; null until then. */
  config: unknown;
}

export interface BeltShape {
  /** Tail first, each tile's kind written with its keys sorted, so two equal kinds give one string. */
  tiles: ReadonlyArray<{ cell_x: number; cell_y: number; kind: string }>;
  /** Each end's dock: the docked machine's `nodeKey` (or `belt@x,y` for a belt, by its first tile) and the port. */
  docks: ReadonlyArray<{ end: string; to: string; port: number }>;
}

export interface BoardShape {
  machines: readonly MachineShape[];
  belts: readonly BeltShape[];
}

/** JSON with every object's keys sorted, so the same value always writes the same string. */
export function stableJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableJson((value as Record<string, unknown>)[k])}`);
  return `{${entries.join(',')}}`;
}

function compareCells(a: readonly number[], b: readonly number[]): number {
  return (a[0] as number) - (b[0] as number) || (a[1] as number) - (b[1] as number);
}

/** The board's shape. It holds no handle: every reference to another element goes by that element's key. */
export function boardShape(board: Pick<BoardFacts, 'nodes' | 'belts'>): BoardShape {
  const nameOf = (handle: number): string => {
    const node = board.nodes.find((n) => n.id === handle);
    if (node !== undefined) return nodeKey(node);
    const first = board.belts.find((b) => b.id === handle)?.tiles[0];
    return first === undefined ? '?' : `belt@${first.cell_x},${first.cell_y}`;
  };
  const machines: MachineShape[] = board.nodes
    .map((n) => ({
      nodeKey: nodeKey(n),
      kind: n.kind,
      cells: n.cells.map((c) => [c[0] as number, c[1] as number] as const).sort(compareCells),
      ports: [...n.ports]
        .sort((a, b) => a.index - b.index)
        .map((p) => ({ role: p.role, cell_x: p.cell_x, cell_y: p.cell_y, side: p.side })),
      config: null,
    }))
    .sort((a, b) => (a.nodeKey < b.nodeKey ? -1 : a.nodeKey > b.nodeKey ? 1 : 0));
  const belts: BeltShape[] = board.belts
    .map((b) => ({
      tiles: b.tiles.map((t) => ({ cell_x: t.cell_x, cell_y: t.cell_y, kind: stableJson(t.kind ?? null) })),
      docks: b.docks
        .map((d) => ({ end: d.end, to: nameOf(d.node), port: d.port }))
        .sort((x, y) => (x.end < y.end ? -1 : x.end > y.end ? 1 : 0)),
    }))
    .sort((a, b) => {
      const ta = a.tiles[0];
      const tb = b.tiles[0];
      if (ta === undefined || tb === undefined) return (ta === undefined ? 0 : 1) - (tb === undefined ? 0 : 1);
      return ta.cell_x - tb.cell_x || ta.cell_y - tb.cell_y;
    });
  return { machines, belts };
}

/** Do two shapes match? One stable serialisation each, compared whole. */
export function sameShape(a: BoardShape, b: BoardShape): boolean {
  return stableJson(a) === stableJson(b);
}

/**
 * The tiles the belt docked to these two machines had in the shape, found by the machines' keys, or null
 * when the shape holds no such belt. A belt joined through pieces names each machine on a different piece,
 * so only a belt docked to both counts here.
 */
export function beltTilesIn(shape: BoardShape, a: string, b: string): BeltShape['tiles'] | null {
  const belt = shape.belts.find((x) => x.docks.some((d) => d.to === a) && x.docks.some((d) => d.to === b));
  return belt === undefined ? null : belt.tiles;
}
