// check.ts - does the board now hold what a step asked for?
//
// Pure, so one evaluator serves the app and its tests. A check names what it looks for by kind and
// relation and compares with the step's baseline. It never counts nodes, because a count can be
// satisfied by a machine the user didn't place for this step.

import type { BoundNode, StepBaseline, TutorialState } from './machine';
import type { BindingName, BoardBelt, BoardFacts, BoardNode, Check, ChromeFacts } from './types';

/**
 * A node's identity on the board: its kind and the minimum of its cells. Undo re-mints handles, so
 * the handle can't be the identity. Occupancy is exclusive, so no two machines share this key.
 */
export function nodeKey(node: Pick<BoardNode, 'kind' | 'cells'>): string {
  const x = Math.min(...node.cells.map((c) => c[0] as number));
  const y = Math.min(...node.cells.map((c) => c[1] as number));
  return `${node.kind}@${x},${y}`;
}

export interface CheckContext {
  board: BoardFacts;
  baseline: StepBaseline;
  chrome: ChromeFacts;
  bindings: TutorialState['bindings'];
}

export type CheckResult = { done: false } | { done: true; bound: { name: BindingName; node: BoundNode } | null };

const NOT_DONE: CheckResult = { done: false };
const DONE: CheckResult = { done: true, bound: null };

/**
 * The belt joining the two handles. One belt counts whichever way round it was drawn. A line drawn in
 * pieces counts too, from `a` to `b`: a piece's Head docks the next piece by its handle, so this
 * follows Head docks through belts until one reaches `b`, and that last piece is the answer. A machine
 * on the way stops the walk, because that's two lines. A host orients a belt from its Out end, so a
 * line of pieces only ever runs from the Source to the Sink.
 */
export function beltJoining(board: BoardFacts, a: number, b: number): BoardBelt | undefined {
  const direct = board.belts.find((belt) => belt.docks.some((d) => d.node === a) && belt.docks.some((d) => d.node === b));
  if (direct !== undefined) return direct;
  const seen = new Set<number>();
  const queue = board.belts.filter((belt) => belt.docks.some((d) => d.end === 'Tail' && d.node === a));
  for (const belt of queue) {
    if (seen.has(belt.id)) continue;
    seen.add(belt.id);
    const head = belt.docks.find((d) => d.end === 'Head')?.node;
    if (head === b) return belt;
    const next = board.belts.find((other) => other.id === head);
    if (next !== undefined) queue.push(next);
  }
  return undefined;
}

/** The name a bound belt goes by. A belt holds no cell the lesson keeps, so it goes by the machines it joins. */
export function beltKey(a: BoundNode, b: BoundNode): string {
  return `belt:${a.nodeKey}+${b.nodeKey}`;
}

/**
 * The lowest occupied slot of the belt docked at its Head to this handle, `Infinity` for an empty
 * belt, or null with no such belt. Slot 0 is the end pressed against the machine. Items leave a head
 * only by delivery into the docked In, and a refused delivery never leaves, so a rise in this value
 * means the machine took an item.
 */
export function lowestSlotInto(board: BoardFacts, node: number): number | null {
  const belt = board.belts.find((b) => b.docks.some((d) => d.end === 'Head' && d.node === node));
  return belt === undefined ? null : (belt.occupiedSlots[0] ?? Number.POSITIVE_INFINITY);
}

export function evaluateCheck(check: Check, ctx: CheckContext): CheckResult {
  const { board, baseline, chrome, bindings } = ctx;
  switch (check.is) {
    case 'nodeAppeared': {
      const candidates = board.nodes
        .filter((n) => n.kind === check.kind && !baseline.knownKeys.includes(nodeKey(n)))
        .sort((a, b) => a.id - b.id);
      const first = candidates[0];
      if (first === undefined) return NOT_DONE;
      return { done: true, bound: { name: check.bind, node: { nodeKey: nodeKey(first), id: first.id } } };
    }
    case 'triggerApplied': {
      const bound = bindings[check.of];
      const applied = chrome.appliedTrigger;
      return bound !== undefined && applied?.node === bound.id && applied.kind === check.trigger ? DONE : NOT_DONE;
    }
    case 'beltJoins': {
      const a = bindings[check.a];
      const b = bindings[check.b];
      if (a === undefined || b === undefined) return NOT_DONE;
      const belt = beltJoining(board, a.id, b.id);
      if (belt === undefined) return NOT_DONE;
      return { done: true, bound: { name: check.bind, node: { nodeKey: beltKey(a, b), id: belt.id } } };
    }
    case 'tickRose':
      return board.tick > baseline.tick ? DONE : NOT_DONE;
    case 'itemArrived': {
      const bound = bindings[check.at];
      if (bound === undefined || baseline.lowestSlot === null || board.generation !== baseline.generation) return NOT_DONE;
      const low = lowestSlotInto(board, bound.id);
      return low !== null && low > baseline.lowestSlot ? DONE : NOT_DONE;
    }
  }
}
