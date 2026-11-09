// check.ts - does the board now hold what a step asked for?
//
// Pure, so one evaluator serves the app and its tests. A check names what it looks for by kind and
// relation and compares with the step's baseline. It never counts nodes, because a count can be
// satisfied by a machine the user didn't place for this step.

import { PORT_ROLE, beltEndPort, doorstepCell, unitDelta } from '../protocol/ports';
import type { BoundNode, StepBaseline, TutorialState } from './machine';
import { beltTilesIn, boardShape, sameShape, type BoardShape } from './shape';
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

/**
 * The belt bindings, each with the two machines it joins, from the output end to the input end. A belt
 * holds no cell the lesson keeps, so it's found again by these two after Undo re-mints every handle.
 */
export const BELT_ENDS: Readonly<Partial<Record<BindingName, readonly [BindingName, BindingName]>>> = {
  belt: ['source', 'sink'],
  beltIn: ['source', 'factory'],
  beltOut: ['factory', 'sink'],
  beltOut2: ['factory', 'sink2'],
};

/** Every binding name, so a loop over the bindings can't leave a new one out: the type below fails to compile if it does. */
export const BINDING_NAMES = ['source', 'sink', 'belt', 'factory', 'sink2', 'beltIn', 'beltOut', 'beltOut2'] as const satisfies readonly BindingName[];
type UnlistedBinding = Exclude<BindingName, (typeof BINDING_NAMES)[number]>;
/** True only while `BINDING_NAMES` lists every member of `BindingName`. */
export const BINDING_NAMES_COMPLETE: [UnlistedBinding] extends [never] ? true : false = true;

/**
 * The handles of the bound machines, sorted with no repeats. Belts are left out. This is the set the
 * layer's config poll asks the host about, so it's also the only set a frame can hold answers for.
 */
export function boundMachineHandles(bindings: TutorialState['bindings']): number[] {
  const ids = BINDING_NAMES.filter((name) => BELT_ENDS[name] === undefined)
    .map((name) => bindings[name]?.id)
    .filter((id): id is number => id !== undefined);
  return [...new Set(ids)].sort((a, b) => a - b);
}

/** The `nodeKey`s of the bound machines: the machines whose config the restored check reads. */
export function boundMachineKeys(bindings: TutorialState['bindings']): ReadonlySet<string> {
  return new Set(
    BINDING_NAMES.filter((name) => BELT_ENDS[name] === undefined)
      .map((name) => bindings[name]?.nodeKey)
      .filter((key): key is string => key !== undefined),
  );
}

/**
 * The board's shape captured when the step `since` began, for the restored check. A machine whose config
 * answer hadn't come yet takes it later from the answer about its handle then, at `generation`, so
 * `handles` keeps those handles by `nodeKey`. It never goes into the shape.
 */
export interface ShapeCapture {
  since: string;
  generation: number;
  handles: Readonly<Record<string, number>>;
  shape: BoardShape;
}

export interface CheckContext {
  board: BoardFacts;
  baseline: StepBaseline;
  chrome: ChromeFacts;
  bindings: TutorialState['bindings'];
  /** The capture the lesson holds, or null with none taken yet. */
  capture: ShapeCapture | null;
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

/** No belt to leave out. */
const NO_BELTS: ReadonlySet<number> = new Set();

/**
 * The handles of the belts the lesson has bound. The line helpers leave these out, so a Factory's second
 * line is read on its own: its first output's belt already ends in a Sink, and read as this line's last
 * piece it would make the new line look stuck.
 */
export function boundBeltIds(bindings: TutorialState['bindings']): ReadonlySet<number> {
  const ids = BINDING_NAMES.filter((name) => BELT_ENDS[name] !== undefined).flatMap((name) => {
    const bound = bindings[name];
    return bound === undefined ? [] : [bound.id];
  });
  return ids.length === 0 ? NO_BELTS : new Set(ids);
}

/** The board's belts without the ones in `skip`. */
function without<B extends Pick<BoardFacts, 'belts'>>(board: B, skip: ReadonlySet<number>): B {
  return skip.size === 0 ? board : { ...board, belts: board.belts.filter((belt) => !skip.has(belt.id)) };
}

/**
 * The cell a line leaving `a` carries on from: the one past the Head of its last piece, or null when
 * there's no such end. That's no belt leaving `a`, a line that ends in a machine, or a single tile (no
 * direction, so no Head a press can find). The app rings this cell while the Belt tool is armed, and a
 * press there joins the new piece on. Belts in `skip` aren't pieces of this line.
 *
 * It doesn't ask whether the cell is free, because a piece drawn into the Sink reaches the board before
 * its dock does, with this cell on the Sink. `lineStuck` tells that moment from a real block.
 */
export function lineDoorstep(board: Pick<BoardFacts, 'belts'>, a: number, skip: ReadonlySet<number> = NO_BELTS): readonly [number, number] | null {
  const belt = lastPiece(without(board, skip), a);
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
 * A belt with no docks in the way of the drag counts too.
 *
 * The app sends a draw's docks after the host has minted the belt, so a good draw passes through several
 * of these shapes, and Undo stops on the same ones for as long as the user leaves them. The shape can't
 * tell them apart, so `editsInFlight` does. While it's true, a tile on `b`'s input doorstep is about to
 * dock there, a belt into `b` starting where its Tail would dock is about to join up, and a belt with no
 * docks is about to get them. Once it's false, no dock is coming and each of them is stuck.
 */
export function lineStuck(
  board: Pick<BoardFacts, 'belts' | 'nodes'>,
  a: number,
  b: number,
  editsInFlight: boolean,
  skip: ReadonlySet<number> = NO_BELTS,
): boolean {
  // The line's own belts, apart from any an earlier step bound. A cell taken by one of those is still
  // taken, so `cellBlocked` reads the whole board.
  const line = without(board, skip);
  if (beltJoining(line, a, b) !== undefined) return false;
  if (!editsInFlight && looseBeltInTheWay(line, a, b)) return true;
  const door = lineDoorstep(line, a);
  const into = line.belts.find((belt) => belt.docks.some((d) => d.end === 'Head' && d.node === b));
  if (into !== undefined) {
    const start = into.tiles[0];
    if (start === undefined || into.docks.some((d) => d.end === 'Tail') || !editsInFlight) return true;
    const atDoor = door !== null && door[0] === start.cell_x && door[1] === start.cell_y;
    return !atDoor && !onDoorstep(board, a, PORT_ROLE.OUT, start);
  }
  const last = lastPiece(line, a);
  if (last === undefined) return false;
  if (last.docks.some((d) => d.end === 'Head')) return true;
  const end = last.tiles[last.tiles.length - 1];
  if (editsInFlight && end !== undefined && onDoorstep(board, b, PORT_ROLE.IN, end)) return false;
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
 * draw looks the same until its docks arrive, so `lineStuck` only reads this with no edit in flight.
 */
export function looseBeltInTheWay(
  board: Pick<BoardFacts, 'belts' | 'nodes'>,
  a: number,
  b: number,
  skip: ReadonlySet<number> = NO_BELTS,
): boolean {
  const door = lineDoorstep(board, a, skip);
  return without(board, skip).belts.some(
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

/**
 * A machine's Out ports that no belt docks, in port order. A belt's Tail dock names the output by its
 * place among the machine's Outs, not by the port's `index` (`dockPort` in `protocol/ports.ts`).
 */
export function freeOutputs<P extends { role: number }>(
  node: { id: number; ports: readonly P[] },
  belts: Iterable<{ docks: ReadonlyArray<{ end: string; node: number; port: number }> }>,
): P[] {
  const all = [...belts];
  return node.ports
    .filter((p) => p.role === PORT_ROLE.OUT)
    .filter((_, ordinal) => !all.some((b) => b.docks.some((d) => d.end === 'Tail' && d.node === node.id && d.port === ordinal)));
}

/**
 * The first Out of `factory`, in port order, whose straight line out, along the side it faces, passes
 * through a cell of `machine`, at any distance. Null when the machine is on no Out's line. Lesson 4's
 * step 8 ring and the second Sink's floor spot both read this, so they agree on which output the first
 * Sink faces.
 */
export function outputFacing<P extends { role: number; cell_x: number; cell_y: number; side: number }>(
  factory: { ports: readonly P[] },
  machine: { cells: ReadonlyArray<readonly number[]> },
): P | null {
  for (const p of factory.ports) {
    if (p.role !== PORT_ROLE.OUT) continue;
    const [dx, dy] = unitDelta(p.side);
    const onLine = machine.cells.some((c) => {
      const ox = (c[0] as number) - p.cell_x;
      const oy = (c[1] as number) - p.cell_y;
      return dx !== 0 ? oy === 0 && ox * dx > 0 : ox === 0 && oy * dy > 0;
    });
    if (onLine) return p;
  }
  return null;
}

/** How many ports with role Out the bound machine holds, found by its `nodeKey`. 0 when it isn't on the board. */
export function outputsOf(board: Pick<BoardFacts, 'nodes'>, bound: BoundNode | undefined): number {
  const node = bound === undefined ? undefined : board.nodes.find((n) => nodeKey(n) === bound.nodeKey);
  return node === undefined ? 0 : node.ports.filter((p) => p.role === PORT_ROLE.OUT).length;
}

/** The Sinks a check watches, each with a lowest slot of its own. Empty for a check that watches none. */
export function watchedNames(check: Check | undefined): readonly BindingName[] {
  if (check?.is === 'itemArrived') return [check.at];
  if (check?.is === 'itemsArriveAtBoth') return check.at;
  return [];
}

/**
 * Has the lowest slot into the machine bound as `name` risen on this frame, against the read the watch
 * took last frame? Never across a keyframe, which re-mints handles and would look like a rise.
 */
export function slotRoseNow(board: BoardFacts, baseline: StepBaseline, bindings: TutorialState['bindings'], name: BindingName): boolean {
  const bound = bindings[name];
  const last = baseline.lowestSlots[name];
  if (bound === undefined || last === undefined || last === null || board.generation !== baseline.generation) return false;
  const low = lowestSlotInto(board, bound.id);
  return low !== null && low > last;
}

/** The belt joining the two machines `BELT_ENDS` names for this binding, or undefined with no such belt or an end unbound. */
export function boundBeltJoining(board: Pick<BoardFacts, 'belts'>, bindings: TutorialState['bindings'], name: BindingName): BoardBelt | undefined {
  const ends = BELT_ENDS[name];
  const a = ends === undefined ? undefined : bindings[ends[0]];
  const b = ends === undefined ? undefined : bindings[ends[1]];
  return a === undefined || b === undefined ? undefined : beltJoining(board, a.id, b.id);
}

/**
 * Is the bound thing off the board? The one rule for "gone", read by the delete steps' checks, by the
 * test that a delete step's result still stands, by `deliberatelyGone` and by the gone stage, so they
 * can't disagree. A machine is gone when no node holds its `nodeKey`.
 *
 * A belt, when the capture holds it (docked to the two machines `BELT_ENDS` names for it), is on the
 * board only if one belt's tiles include every tile the captured belt had, docked or not: that's the
 * original back, with or without the docks an Undo of the draw takes first. A belt joining the two
 * machines on other tiles is a new belt and doesn't count, because the capture is kept once taken and a
 * board holding that belt could never match it. A belt sharing only some of the tiles, such as a stray
 * drawn from the Source's output, doesn't count either. With no captured belt, a belt is on the board
 * when a belt joins its two machines, found through the current bindings. Gone is the opposite.
 */
export function boundGone(
  name: BindingName,
  board: Pick<BoardFacts, 'nodes' | 'belts'>,
  bindings: TutorialState['bindings'],
  capture: ShapeCapture | null,
): boolean {
  const bound = bindings[name];
  if (bound === undefined) return false;
  const ends = BELT_ENDS[name];
  if (ends === undefined) return !board.nodes.some((n) => nodeKey(n) === bound.nodeKey);
  const a = bindings[ends[0]];
  const b = bindings[ends[1]];
  const tiles = capture === null || a === undefined || b === undefined ? null : beltTilesIn(capture.shape, a.nodeKey, b.nodeKey);
  if (tiles === null || tiles.length === 0) return boundBeltJoining(board, bindings, name) === undefined;
  const back = board.belts.some((belt) => tiles.every((c) => belt.tiles.some((t) => t.cell_x === c.cell_x && t.cell_y === c.cell_y)));
  return !back;
}

export function evaluateCheck(check: Check, ctx: CheckContext): CheckResult {
  const { board, baseline, chrome, bindings, capture } = ctx;
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
    case 'itemArrived':
      return slotRoseNow(board, baseline, bindings, check.at) ? DONE : NOT_DONE;
    // Each Sink latches on its own, so the two rises can come on different frames. The code isn't read:
    // any code that sends items down both belts counts.
    case 'itemsArriveAtBoth':
      return check.at.every((name) => baseline.rose.includes(name) || slotRoseNow(board, baseline, bindings, name)) ? DONE : NOT_DONE;
    case 'portAdded':
      return outputsOf(board, bindings[check.of]) >= check.outs ? DONE : NOT_DONE;
    // A Delete leaves the generation where it was and an Undo raises it, so only a Delete finishes these.
    case 'nodeGone': {
      const bound = bindings[check.of];
      if (bound === undefined || board.generation !== baseline.generation) return NOT_DONE;
      return boundGone(check.of, board, bindings, capture) ? DONE : NOT_DONE;
    }
    case 'beltGone': {
      const ends = BELT_ENDS[check.of];
      if (bindings[check.of] === undefined || ends === undefined || bindings[ends[0]] === undefined || bindings[ends[1]] === undefined) return NOT_DONE;
      if (board.generation !== baseline.generation) return NOT_DONE;
      return boundGone(check.of, board, bindings, capture) ? DONE : NOT_DONE;
    }
    case 'restored':
      return capture !== null && capture.since === check.since && sameShape(boardShape(board, chrome.appliedConfigs, boundMachineKeys(bindings)), capture.shape)
        ? DONE
        : NOT_DONE;
  }
}
