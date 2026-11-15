// firstFactory.ts - the first-factory tutorial done by hand on the live host, shared by the
// tutorial's live spec (`98-first-factory.live.spec.ts`) and the first-webhook spec, which starts
// from the tutorial's step 1 board.
//
// The live host's Examples menu loads only its three scenes, so a docs board can't be loaded by
// name. Each step here is built with the same palette clicks, belt drags, Delete key and inspector
// edits the tutorial page lists, and the spec then compares what the live board holds with the
// step's board file under `examples/boards/docs/`.
//
// Files are read at run time from this module's own location (never the cwd), so nothing from the
// docs site is compiled into the live suite.
//
// THE CELLS BELOW ARE THE GESTURES' OWN, NOT READ FROM THE BOARD FILES. That is what lets the
// layout comparison fail: a gesture that lands one cell off gives a board unlike the file, and the
// spec says which machine or belt differs. The board files and these constants are kept equal by
// that comparison, so a change to one without the other turns the spec red.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, type Page } from '@playwright/test';
import {
  CELL,
  anchorOf,
  applyConfig,
  clickAt,
  drawBeltThroughCells,
  nodeAtAnchor,
  pollScene,
  readFactorySource,
  readScene,
  selectMachineAt,
  typeFactorySource,
  type PortFacts,
  type SceneFacts,
} from './oracle';
import { beltOn, cellPoint, deselectOnFloor, doorstep, emptyBoardAtScaleOne, place, portOf, rowCells, type Cell } from './beltBoard';

/** Kind bytes (protocol `machine_kind`), transcribed: the live suite imports no product source. */
export const KIND_SOURCE = 0;
export const KIND_FACTORY = 2;
export const KIND_SINK = 7;
/** Port roles (oracle `PortFacts.role`). */
const ROLE_IN = 0;
const ROLE_OUT = 1;
/** Port sides (oracle `PortFacts.side`): the palette's unturned Source sends east, its Sink takes from the west. */
const EAST = 1;
const WEST = 3;

/** Where step 1 puts the Source and the Sink: one row, seven empty cells between them. */
export const SOURCE_AT: Cell = [10, 8];
export const SINK_AT: Cell = [18, 8];
/** Where step 2 puts the 3 by 3 Factory, its In and Out on its middle row, level with the line. */
export const FACTORY_AT: Cell = [13, 7];
/** Empty floor cells a deselect click lands on, clear of every machine and belt here. */
export const FLOOR: readonly Cell[] = [
  [12, 12],
  [14, 12],
  [16, 12],
];

/** Every cell a gesture here touches, checked to be open canvas before the build starts. */
const CELLS_IN_USE: readonly Cell[] = [
  SOURCE_AT,
  SINK_AT,
  ...rowCells(SOURCE_AT[0] + 1, SINK_AT[0] - 1, SOURCE_AT[1]),
  FACTORY_AT,
  [FACTORY_AT[0] + 2, FACTORY_AT[1] + 2],
  ...FLOOR,
];

/** The tutorial's step boards, by step number. */
export function stepBoardPath(step: 1 | 2 | 3): string {
  return fileURLToPath(new URL(`../../../examples/boards/docs/start-first-factory-${step}.board.ron`, import.meta.url));
}

/** The tutorial page, read for its `Factory code` block. */
export const TUTORIAL_PAGE = fileURLToPath(new URL('../../../site/src/content/docs/get-started/first-factory.mdx', import.meta.url));

/**
 * A board's machines and belts, as sorted strings so two layouts compare with one `toEqual` and a
 * failure prints both sides: a machine is `kind@x,y` at its anchor, a belt its cells tail first.
 */
export interface Layout {
  machines: string[];
  belts: string[];
}

function cellsKey(cells: ReadonlyArray<readonly [number, number]>): string {
  return cells.map(([x, y]) => `${x},${y}`).join(' > ');
}

/**
 * The layout a board file builds: its `Place(kind, cell_x, cell_y)` and `DrawBelt(cells: [...])`
 * commands. Only the text before `script:` is read, with `//` comment lines dropped, so a header
 * comment or a Factory's code can't add a machine. A file with no Place is thrown by name.
 */
export function boardLayout(path: string): Layout {
  const text = readFileSync(path, 'utf8');
  const commands = text
    .slice(0, text.indexOf('script:') >= 0 ? text.indexOf('script:') : text.length)
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
  const machines = [...commands.matchAll(/Place\(kind:\s*(\d+),\s*cell_x:\s*(-?\d+),\s*cell_y:\s*(-?\d+)\)/g)].map(
    (m) => `${m[1]}@${m[2]},${m[3]}`,
  );
  const belts = [...commands.matchAll(/DrawBelt\(cells:\s*\[([^\]]*)\]\)/g)].map((m) =>
    cellsKey([...m[1].matchAll(/\((-?\d+),\s*(-?\d+)\)/g)].map((c) => [Number(c[1]), Number(c[2])] as [number, number])),
  );
  if (machines.length === 0) throw new Error(`boardLayout: found no Place command in ${path}`);
  return { machines: machines.sort(), belts: belts.sort() };
}

/** The same layout read off the live board through the scene oracle. */
export async function liveLayout(page: Page): Promise<Layout> {
  return layoutOf(await readScene(page));
}

/** `liveLayout` over a scene already read, for a `pollScene`. */
export function layoutOf(s: SceneFacts): Layout {
  return {
    machines: s.nodes.map((n) => `${n.kind}@${anchorOf(n).join(',')}`).sort(),
    belts: s.belts.map((b) => cellsKey(b.tiles.map((t) => [t.cell_x, t.cell_y] as [number, number]))).sort(),
  };
}

/** A belt's docks as sorted `End@node:key` strings. */
function dockSet(s: SceneFacts, cells: ReadonlyArray<Cell>): string[] {
  return (beltOn(s, cells)?.docks ?? []).map((d) => `${d.end}@${d.node}:${d.port}`).sort();
}

/** The key a dock on `port` of `node` carries (the host's `dock_link_key`, transcribed from
 *  `87-factory-two-emits`): an In keeps its catalog index, an Out is numbered among the node's Outs. */
function linkKey(node: SceneFacts['nodes'][number], port: PortFacts): number {
  if (port.role !== ROLE_OUT) return port.index;
  return node.ports.filter((p) => p.role === ROLE_OUT && p.index < port.index).length;
}

/**
 * Draw one belt with the Belt tool from `fromCell`'s Out doorstep to `toCell`'s In, along the row,
 * and wait until both ends are docked. Returns the belt's cells, tail first.
 */
async function beltBetween(page: Page, fromCell: Cell, toCell: Cell, what: string): Promise<Array<[number, number]>> {
  const s = await readScene(page);
  const from = portOf(s, fromCell, ROLE_OUT, 0);
  const to = portOf(s, toCell, ROLE_IN, 0);
  expect(from, `${what}: the machine at (${fromCell.join(',')}) has an output`).toBeDefined();
  expect(to, `${what}: the machine at (${toCell.join(',')}) has an input`).toBeDefined();
  const cells = rowCells(doorstep(from!)[0], doorstep(to!)[0], from!.cell_y);
  await drawBeltThroughCells(page, from!, cells, to!);
  const fromNode = nodeAtAnchor(s, fromCell[0], fromCell[1])!;
  const toNode = nodeAtAnchor(s, toCell[0], toCell[1])!;
  const want = [`Head@${toNode.id}:${linkKey(toNode, to!)}`, `Tail@${fromNode.id}:${linkKey(fromNode, from!)}`].sort();
  await pollScene(page, (q) => dockSet(q, cells), {
    message: `${what}: the belt on ${cellsKey(cells)} is docked at both ends`,
  }).toEqual(want);
  return cells;
}

/**
 * Step 1 by gestures: New, a Source, a Sink eight cells to its right on the same row, and one belt
 * drawn from the Source's output to the Sink's input. The page must already be on the app.
 * Neither machine is turned: the tutorial relies on the palette's unturned facing, so that is
 * checked rather than fixed.
 */
export async function buildStepOne(page: Page): Promise<void> {
  await emptyBoardAtScaleOne(page, CELLS_IN_USE);
  await place(page, 'Source', KIND_SOURCE, SOURCE_AT, 'step 1');
  await place(page, 'Sink', KIND_SINK, SINK_AT, 'step 1');
  const s = await readScene(page);
  expect(portOf(s, SOURCE_AT, ROLE_OUT, 0)?.side, 'step 1: a palette Source sends east, toward the Sink').toBe(EAST);
  expect(portOf(s, SINK_AT, ROLE_IN, 0)?.side, 'step 1: a palette Sink takes from the west, facing the Source').toBe(WEST);
  await beltBetween(page, SOURCE_AT, SINK_AT, 'step 1');
}

/** The live belt selection (`window.__fabrico.selectedBelt()`). */
async function selectedBeltOf(page: Page): Promise<number | null> {
  return page.evaluate(() => (window as { __fabrico?: { selectedBelt(): number | null } }).__fabrico?.selectedBelt() ?? null);
}

/**
 * Step 2 by gestures: click the long belt and press Delete (Delete anyway if the app asks about
 * items on it), then a Factory in the gap and two belts, Source to Factory and Factory to Sink.
 * The app has no move, so the long belt goes by Delete and the new parts by Place.
 */
export async function buildStepTwo(page: Page): Promise<void> {
  const long = rowCells(SOURCE_AT[0] + 1, SINK_AT[0] - 1, SOURCE_AT[1]);
  const before = beltOn(await readScene(page), long);
  expect(before, 'step 2: the step 1 belt is on the board to delete').toBeDefined();
  const middle = long[Math.floor(long.length / 2)];
  const pt = await cellPoint(page, middle[0], middle[1], 0.45, 0.55);
  await clickAt(page, pt.x, pt.y);
  await expect(page.locator('#fab-belt-config'), 'step 2: clicking the belt opened its panel').toBeVisible();
  expect(await selectedBeltOf(page), 'step 2: the selected belt is the long one').toBe(before!.id);
  const carrying = (beltOn(await readScene(page), long)?.items ?? 0) > 0;
  await page.keyboard.press('Delete');
  if (carrying) {
    const dialog = page.getByRole('alertdialog');
    await expect(dialog, 'step 2: a belt with items on it asks before it goes').toBeVisible();
    await dialog.getByRole('button', { name: 'Delete anyway' }).click();
  }
  await pollScene(page, (s) => s.belts.length, { message: 'step 2: Delete removed the long belt' }).toBe(0);
  await place(page, 'Factory', KIND_FACTORY, FACTORY_AT, 'step 2');
  await deselectOnFloor(page, FLOOR, 'step 2: after the Factory');
  await beltBetween(page, SOURCE_AT, FACTORY_AT, 'step 2, Source to Factory');
  await beltBetween(page, FACTORY_AT, SINK_AT, 'step 2, Factory to Sink');
}

/**
 * The `Factory code` block on the tutorial page: the fenced `js` block titled `Factory code`, with
 * the list indent it sits under removed. Thrown by name when the page has none or more than one.
 */
export function pageFactoryCode(path: string = TUTORIAL_PAGE): string {
  const lines = readFileSync(path, 'utf8').split('\n');
  const starts = lines.flatMap((l, i) => (/^\s*```js title="Factory code"\s*$/.test(l) ? [i] : []));
  if (starts.length !== 1) throw new Error(`pageFactoryCode: ${path} has ${starts.length} Factory code blocks, expected 1`);
  const indent = /^(\s*)/.exec(lines[starts[0]])![1];
  const body: string[] = [];
  for (let i = starts[0] + 1; i < lines.length; i += 1) {
    if (/^\s*```\s*$/.test(lines[i])) return body.join('\n');
    body.push(lines[i].startsWith(indent) ? lines[i].slice(indent.length) : lines[i].trimStart());
  }
  throw new Error(`pageFactoryCode: the Factory code block in ${path} never closes`);
}

/**
 * Step 3 by gestures: select the Factory, replace its code with the page's block, Apply. Returns
 * the code the inspector holds after the Apply, for the caller to compare with the block.
 */
export async function buildStepThree(page: Page, code: string): Promise<string> {
  await selectMachineAt(page, FACTORY_AT[0], FACTORY_AT[1]);
  await typeFactorySource(page, code);
  await applyConfig(page);
  const applied = await readFactorySource(page);
  await deselectOnFloor(page, FLOOR, 'step 3: after the Apply');
  return applied;
}

/** The Factory-to-Sink belt's cells, tail first, once step 2 is built. */
export function outletCells(): Array<[number, number]> {
  return rowCells(FACTORY_AT[0] + 3, SINK_AT[0] - 1, SINK_AT[1]);
}

/** What the outlet watch saw since it started. */
export interface OutletWatch {
  /** The model listed at least one item on the outlet belt in some frame. */
  carried: boolean;
  /** The item layer drew at least one dot inside an outlet cell in some frame. */
  drawn: boolean;
  /** The frames in which both held at once. */
  bothFrames: number;
  /** Ids of machines the model showed in the FAULTED state (state byte 2) in any frame. */
  faulted: number[];
}

/**
 * Start an in-page watch over the outlet belt, sampled on every drawn frame: whether the model
 * listed an item on it, whether the item layer drew a dot inside one of its cells, and whether any
 * machine read FAULTED. An item crosses the two-cell outlet in about 16 ticks, a quarter of a
 * second at full speed, so a poll from the test side could miss it; the watch latches it instead.
 * Read with `readOutletWatch`, stop with `stopOutletWatch`.
 */
export async function startOutletWatch(page: Page, cells: ReadonlyArray<Cell>): Promise<void> {
  await page.evaluate(
    ([outlet, cellPx]) => {
      type Scene = { nodes: { id: number; state: number }[]; belts: { tiles: { cell_x: number; cell_y: number }[]; items: number }[] };
      const w = window as unknown as {
        __fabrico: { scene(): Scene; itemDots(): Array<{ x: number; y: number }> };
        __ffOutlet?: { carried: boolean; drawn: boolean; bothFrames: number; faulted: number[]; stop: boolean };
      };
      const key = (x: number, y: number): string => `${x},${y}`;
      const want = new Set(outlet.map(([x, y]) => key(x, y)));
      const watch = { carried: false, drawn: false, bothFrames: 0, faulted: [] as number[], stop: false };
      w.__ffOutlet = watch;
      const step = (): void => {
        if (watch.stop) return;
        const s = w.__fabrico.scene();
        const belt = s.belts.find((b) => b.tiles.length === want.size && b.tiles.every((t) => want.has(key(t.cell_x, t.cell_y))));
        const carried = (belt?.items ?? 0) > 0;
        const drawn = w.__fabrico.itemDots().some((d) => want.has(key(Math.floor(d.x / cellPx), Math.floor(d.y / cellPx))));
        if (carried) watch.carried = true;
        if (drawn) watch.drawn = true;
        if (carried && drawn) watch.bothFrames += 1;
        for (const n of s.nodes) if (n.state === 2 && !watch.faulted.includes(n.id)) watch.faulted.push(n.id);
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    },
    [cells.map(([x, y]) => [x, y] as [number, number]), CELL] as const,
  );
}

/** Read the outlet watch's latched facts. */
export async function readOutletWatch(page: Page): Promise<OutletWatch> {
  return page.evaluate(() => {
    const w = (window as unknown as { __ffOutlet?: OutletWatch }).__ffOutlet;
    if (!w) throw new Error('the outlet watch was not started');
    return { carried: w.carried, drawn: w.drawn, bothFrames: w.bothFrames, faulted: [...w.faulted] };
  });
}

/** Stop the outlet watch (safe on a page that never started one). */
export async function stopOutletWatch(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = (window as unknown as { __ffOutlet?: { stop: boolean } }).__ffOutlet;
    if (w) w.stop = true;
  });
}
