// check.ts - does the board now hold what a step asked for?
//
// Pure, so one evaluator serves the app and its tests. A check names what it looks for by kind and
// relation and compares with the step's baseline. It never counts nodes, because a count can be
// satisfied by a machine the user didn't place for this step.

import type { BoundNode, StepBaseline } from './machine';
import type { BindingName, BoardFacts, BoardNode, Check } from './types';

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
}

export type CheckResult = { done: false } | { done: true; bound: { name: BindingName; node: BoundNode } };

export function evaluateCheck(check: Check, ctx: CheckContext): CheckResult {
  const candidates = ctx.board.nodes
    .filter((n) => n.kind === check.kind && !ctx.baseline.knownKeys.includes(nodeKey(n)))
    .sort((a, b) => a.id - b.id);
  const first = candidates[0];
  if (first === undefined) return { done: false };
  return { done: true, bound: { name: check.bind, node: { nodeKey: nodeKey(first), id: first.id } } };
}
