// check.ts - does the board now hold what a step asked for?
//
// Pure, so one evaluator serves the app and its tests. A check names what it looks for by kind and
// relation and compares with the step's baseline. It never counts nodes, because a count can be
// satisfied by a machine the user didn't place for this step.

import { PORT_ROLE, beltEndPort, doorstepCell } from '../protocol/ports';
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
export function beltJoining(board: Pick<BoardFacts, 'belts'>, a: number, b: number): BoardBelt | undefined {
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

/**
 * The cell a line leaving `a` carries on from: the one past the Head of its last piece, or null when
 * there's no such end. That's no belt leaving `a`, a line that ends in a machine, or a single tile (no
 * direction, so no Head a press can find). The app rings this cell while the Belt tool is armed, and a
 * press there joins the new piece on.
 *
 * It doesn't ask whether the cell is free, because a piece drawn into the Sink reaches the board a packet
 * before its dock does, with this cell on the Sink. `lineStuck` tells that packet from a real block.
 */
export function lineDoorstep(board: Pick<BoardFacts, 'belts'>, a: number): readonly [number, number] | null {
  const belt = lastPiece(board, a);
  if (belt === undefined || belt.docks.some((d) => d.end === 'Head')) return null;
  const port = beltEndPort(belt.tiles, 'Head');
  return port === null ? null : doorstepCell(port);
}

/** The last piece of the line leaving `a`, following Head docks through belts. Undefined with no belt leaving it. */
function lastPiece(board: Pick<BoardFacts, 'belts'>, a: number): BoardBelt | undefined {
  const seen = new Set<number>();
  let belt = board.belts.find((b) => b.docks.some((d) => d.end === 'Tail' && d.node === a));
  while (belt !== undefined && !seen.has(belt.id)) {
    seen.add(belt.id);
    const head = belt.docks.find((d) => d.end === 'Head')?.node;
    const next = head === undefined ? undefined : board.belts.find((other) => other.id === head);
    if (next === undefined) return belt;
    belt = next;
  }
  return belt;
}

type Cell = { cell_x: number; cell_y: number };

/** Is this tile on the doorstep of one of the machine's ports in this role? */
function onDoorstep(board: Pick<BoardFacts, 'nodes'>, node: number, role: number, tile: Cell): boolean {
  const ports = board.nodes.find((n) => n.id === node)?.ports ?? [];
  return ports.some((port) => {
    const [x, y] = doorstepCell(port);
    return port.role === role && x === tile.cell_x && y === tile.cell_y;
  });
}

/**
 * Has the user drawn a belt the lesson can't build on from `a` to `b`, so that the only way on is to
 * undo it? The plain drag is refused because the output or the input is taken, and a press can't carry
 * this belt on. That's a belt into `b` that didn't come from `a`, or a line from `a` that ends in another
 * machine, in a single tile (no direction, so no Head a press can find), or against a cell that's taken.
 *
 * The app sends a draw's docks after the host has minted the belt, so a good draw can look like this
 * for a packet. A tile on `b`'s input doorstep is about to dock there, and a belt into `b` starting
 * where its Tail would dock is about to join up. Neither is stuck.
 */
export function lineStuck(board: Pick<BoardFacts, 'belts' | 'nodes'>, a: number, b: number): boolean {
  if (beltJoining(board, a, b) !== undefined) return false;
  const door = lineDoorstep(board, a);
  const into = board.belts.find((belt) => belt.docks.some((d) => d.end === 'Head' && d.node === b));
  if (into !== undefined) {
    const start = into.tiles[0];
    if (start === undefined || into.docks.some((d) => d.end === 'Tail')) return true;
    const atDoor = door !== null && door[0] === start.cell_x && door[1] === start.cell_y;
    return !atDoor && !onDoorstep(board, a, PORT_ROLE.OUT, start);
  }
  const last = lastPiece(board, a);
  if (last === undefined) return false;
  if (last.docks.some((d) => d.end === 'Head')) return true;
  const end = last.tiles[last.tiles.length - 1];
  if (end !== undefined && onDoorstep(board, b, PORT_ROLE.IN, end)) return false;
  return door === null || cellBlocked(board, door);
}

/**
 * Does this cell hold something a new piece can't start on? That's a machine or a belt tile, as the app
 * reads it, and then no ring shows there. The first tile of a belt with no docks doesn't count, because
 * that's the next piece of this line in the packet before its docks arrive.
 */
function cellBlocked(board: Pick<BoardFacts, 'belts' | 'nodes'>, [x, y]: readonly [number, number]): boolean {
  const at = (tile: Cell): boolean => tile.cell_x === x && tile.cell_y === y;
  return (
    board.nodes.some((n) => n.cells.some((c) => c[0] === x && c[1] === y)) ||
    board.belts.some((belt) => {
      const first = belt.tiles[0];
      const arriving = belt.docks.length === 0 && first !== undefined && at(first);
      return !arriving && belt.tiles.some(at);
    })
  );
}

/**
 * Is a belt with no docks left on one of the cells this line needs? Undo takes a draw back one command
 * at a time, the docks first, so one press leaves the belt where it was with nothing holding it. A good
 * draw looks the same for the packet before its docks arrive, so this means nothing on its own, and
 * `machine.ts` only reads it once the line has been stuck.
 */
export function looseBeltInTheWay(board: Pick<BoardFacts, 'belts' | 'nodes'>, a: number, b: number): boolean {
  const door = lineDoorstep(board, a);
  return board.belts.some(
    (belt) =>
      belt.docks.length === 0 &&
      belt.tiles.some(
        (tile) =>
          onDoorstep(board, a, PORT_ROLE.OUT, tile) ||
          onDoorstep(board, b, PORT_ROLE.IN, tile) ||
          (door !== null && door[0] === tile.cell_x && door[1] === tile.cell_y),
      ),
  );
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
