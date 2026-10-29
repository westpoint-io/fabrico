import { expect, type Page } from '@playwright/test';
import {
  CELL,
  armAndPlaceAt,
  cameraOf,
  clickAt,
  newBoard,
  nodeAtAnchor,
  outwardStep,
  pointerTravel,
  pollScene,
  readScene,
  resetZoomToActualSize,
  screenCellCentre,
  screenPoint,
  waitForAppReady,
  waitForCameraSettle,
  type PortFacts,
  type SceneFacts,
} from './oracle';

// beltBoard.ts - the board helpers every phase 89 live spec shares (review fix WR-C-08).
//
// Until the review each 89 spec carried its own copy of these, and the copies had drifted: three
// `deselectOnFloor` copies waited for the machine panel only, two `rowCells` copies ascended only,
// and `cardinalOfRotation`, the mapping every tread grade reads, was defined five times. One copy
// each now, taking the stricter variant: `deselectOnFloor` waits for BOTH panels to close,
// `rowCells` walks either way, and the probe wrappers throw when the page hook is missing instead
// of reading "nothing drawn" (review IN-C-02), the convention `oracle.ts` keeps.
//
// Pure test support: it imports `@playwright/test` and `./oracle` only, like the other support
// modules, and touches the app only through the shipped chrome and the read-only `__fabrico` hooks.

/** A board cell, `[x, y]`. */
export type Cell = readonly [number, number];
/** One belt as the scene oracle reads it. */
export type BeltFacts = SceneFacts['belts'][number];
/** One machine as the scene oracle reads it. */
export type NodeFacts = SceneFacts['nodes'][number];

/**
 * The travel cardinal a tread rotation draws (`belts.ts` `tileRotation`): the native tread points
 * West, and each quarter turn clockwise is the next cardinal, so W=0, N=PI/2, E=PI, S=3PI/2.
 * Answers the wire's side numbering (N=0, E=1, S=2, W=3).
 */
export function cardinalOfRotation(r: number): number {
  const q = ((Math.round(r / (Math.PI / 2)) % 4) + 4) % 4;
  return (q + 3) % 4;
}

/** A port's doorstep cell: its own cell stepped once along the side it faces. */
export function doorstep(p: PortFacts): [number, number] {
  const [dx, dy] = outwardStep(p.side);
  return [p.cell_x + dx, p.cell_y + dy];
}

/**
 * The first port of `role` on the machine anchored at `cell`, or undefined. With `medium`, the
 * first port of that role on that medium (0 Mechanical, 1 Electrical).
 */
export function portOf(s: SceneFacts, cell: Cell, role: number, medium?: number): PortFacts | undefined {
  return nodeAtAnchor(s, cell[0], cell[1])?.ports.find((p) => p.role === role && (medium === undefined || p.medium === medium));
}

/** The side the first `role` port of the machine anchored at `cell` faces, or -1. */
export function sideOf(s: SceneFacts, cell: Cell, role: number): number {
  return portOf(s, cell, role)?.side ?? -1;
}

/** The belt whose tiles are exactly `cells`, in order, or undefined. */
export function beltOn(s: SceneFacts, cells: ReadonlyArray<Cell>): BeltFacts | undefined {
  return s.belts.find(
    (b) => b.tiles.length === cells.length && b.tiles.every((t, i) => t.cell_x === cells[i][0] && t.cell_y === cells[i][1]),
  );
}

/** The cells from (x0, y) to (x1, y) inclusive, in that order, either way along the row. */
export function rowCells(x0: number, x1: number, y: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const dir = Math.sign(x1 - x0) || 1;
  for (let x = x0; dir * (x1 - x) >= 0; x += dir) out.push([x, y]);
  return out;
}

/** A screen point at a fraction of cell (cx, cy): off-centre, the way a hand lands. */
export async function cellPoint(page: Page, cx: number, cy: number, fx: number, fy: number): Promise<{ x: number; y: number }> {
  return screenPoint(page, { x: (cx + fx) * CELL, y: (cy + fy) * CELL });
}

/** Every screen point is on the canvas, so no chrome panel or control eats the press. */
export async function expectOnCanvas(page: Page, pts: ReadonlyArray<{ x: number; y: number }>, why: string): Promise<void> {
  const tags = await page.evaluate((ps) => ps.map((q) => document.elementFromPoint(q.x, q.y)?.tagName ?? null), [...pts]);
  expect(tags, `${why}: every point is on the canvas, not under chrome`).toEqual(pts.map(() => 'CANVAS'));
}

/** The toolbar's transport toggle: `Pause` while playing, `Play` while paused (74.1-paused-edits). */
export function transport(page: Page) {
  return page.getByRole('button', { name: /^(Play|Pause)$/ });
}

/** Press Play if the toolbar offers it, then wait for the tick to advance. */
export async function resumeIfPaused(page: Page): Promise<void> {
  if ((await transport(page).getAttribute('aria-label')) === 'Play') await transport(page).click();
  const t0 = (await readScene(page)).tick;
  await pollScene(page, (s) => s.tick > t0, { message: 'the board is playing', timeout: 10_000 }).toBe(true);
}

/**
 * Pause from the toolbar and wait until two reads 200 ms apart see the same tick
 * (74.1-paused-edits). Answers the tick the host stopped on.
 */
export async function pauseAndSettle(page: Page, what: string): Promise<number> {
  await transport(page).click();
  await expect(transport(page), `${what}: the sim is paused (the toggle offers Play)`).toHaveAttribute('aria-label', 'Play');
  let pausedAt = -1;
  await expect
    .poll(
      async () => {
        const t = (await readScene(page)).tick;
        const settled = t === pausedAt;
        pausedAt = t;
        return settled;
      },
      { message: `${what}: the host stopped ticking`, intervals: [200], timeout: 10_000 },
    )
    .toBe(true);
  return pausedAt;
}

/**
 * An empty, playing board at camera scale 1, every named cell on the open canvas. The page is
 * opened again on the empty board so it boots at its identity camera, whatever ran before (the
 * `87-source-backed-up` shape).
 */
export async function emptyBoardAtScaleOne(page: Page, cells: ReadonlyArray<Cell>): Promise<void> {
  await newBoard(page);
  await page.goto('/');
  await waitForAppReady(page);
  await resetZoomToActualSize(page);
  await waitForCameraSettle(page);
  expect((await cameraOf(page)).scale, 'the camera is at scale 1').toBe(1);
  for (const [cx, cy] of cells) {
    const pt = await screenCellCentre(page, cx, cy);
    const under = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.tagName ?? 'NONE', [pt.x, pt.y] as const);
    expect(under, `cell (${cx},${cy}) is on the open canvas, where a hand reaches the board`).toBe('CANVAS');
  }
  await resumeIfPaused(page);
}

/** Place a machine from the palette row `Place <name>` at `cell` and wait until the host seated it. */
export async function place(page: Page, name: string, kind: number, cell: Cell, what: string): Promise<void> {
  await armAndPlaceAt(page, name, cell[0], cell[1]);
  await pollScene(page, (s) => nodeAtAnchor(s, cell[0], cell[1])?.kind ?? -1, {
    message: `${what}: the palette ${name} was placed at (${cell.join(',')})`,
  }).toBe(kind);
}

/** Turn the selected machine at `cell` with `r` (at most three turns) until its first `role` port faces `side`. */
export async function turnUntilFacing(page: Page, cell: Cell, role: number, side: number, what: string): Promise<void> {
  for (let k = 0; k < 3 && sideOf(await readScene(page), cell, role) !== side; k += 1) {
    const before = sideOf(await readScene(page), cell, role);
    await page.keyboard.press('r');
    await pollScene(page, (s) => sideOf(s, cell, role), { message: `${what}: turn ${k + 1} landed` }).not.toBe(before);
  }
  expect(sideOf(await readScene(page), cell, role), `${what} faces side ${side}`).toBe(side);
}

/**
 * Click the first of `floor` that is on the open canvas, and wait for BOTH panels to close: the
 * machine panel (`#fab-config-heading`) and the belt panel (`#fab-belt-config`). The stricter of
 * the copies the specs carried (review WR-C-08): a floor click that left a belt selected passed the
 * machine-only wait.
 */
export async function deselectOnFloor(page: Page, floor: ReadonlyArray<Cell>, why: string): Promise<void> {
  for (const [cx, cy] of floor) {
    const pt = await screenCellCentre(page, cx, cy);
    const tag = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.tagName ?? 'NONE', [pt.x, pt.y] as const);
    if (tag !== 'CANVAS') continue;
    await clickAt(page, pt.x, pt.y);
    await expect(page.locator('#fab-config-heading'), `${why}: the machine panel closed on the floor click`).toHaveCount(0, {
      timeout: 10_000,
    });
    await expect(page.locator('#fab-belt-config'), `${why}: the belt panel closed on the floor click`).toHaveCount(0, {
      timeout: 10_000,
    });
    return;
  }
  throw new Error(`${why}: none of the floor cells ${JSON.stringify(floor)} is on the open canvas`);
}

/** Wheel the camera out over `cell` until it reads below scale 1 (bounded), then settle it. */
export async function zoomBelowOne(page: Page, cell: Cell): Promise<number> {
  const over = await screenCellCentre(page, cell[0], cell[1]);
  await pointerTravel(page, over.x, over.y);
  for (let notch = 0; notch < 6 && (await cameraOf(page)).scale >= 1; notch += 1) {
    await page.mouse.wheel(0, 200);
    await page.waitForTimeout(30);
  }
  await waitForCameraSettle(page);
  const scale = (await cameraOf(page)).scale;
  expect(scale, 'the wheel zoomed the camera below scale 1').toBeLessThan(1);
  return scale;
}

/** Wheel the camera out over `cell` until it reads at or below `target` (bounded), then settle it. */
export async function zoomTo(page: Page, cell: Cell, target: number): Promise<number> {
  const over = await screenCellCentre(page, cell[0], cell[1]);
  await pointerTravel(page, over.x, over.y);
  for (let notch = 0; notch < 12 && (await cameraOf(page)).scale > target; notch += 1) {
    await page.mouse.wheel(0, 200);
    await page.waitForTimeout(30);
  }
  await waitForCameraSettle(page);
  const scale = (await cameraOf(page)).scale;
  expect(scale, 'the wheel zoomed the camera below scale 1').toBeLessThan(1);
  expect(scale, `the wheel reached the leg's zoom (${target})`).toBeLessThanOrEqual(target);
  return scale;
}

/**
 * The tread rotation the belts layer drew on `cell` (`__fabrico.beltTreadRotationAt`, read off the
 * drawn tile object), or null when no belt tile is drawn there. Throws when the hook is missing,
 * so a page without it never reads as "nothing drawn" (review IN-C-02).
 */
export async function treadRotationAt(page: Page, cell: Cell): Promise<number | null> {
  return page.evaluate(([x, y]) => {
    const hook = (window as { __fabrico?: { beltTreadRotationAt?(x: number, y: number): number | null } }).__fabrico;
    if (!hook) throw new Error('window.__fabrico not installed');
    if (typeof hook.beltTreadRotationAt !== 'function') throw new Error('window.__fabrico.beltTreadRotationAt() not installed');
    return hook.beltTreadRotationAt(x, y);
  }, [cell[0], cell[1]] as const);
}

/**
 * The kind the draw preview last plotted on `cell` (`__fabrico.beltPreviewKindAt`), or null.
 * Throws when the hook is missing (review IN-C-02).
 */
export async function previewKindAt(page: Page, cell: Cell): Promise<unknown> {
  return page.evaluate(([x, y]) => {
    const hook = (window as { __fabrico?: { beltPreviewKindAt?(x: number, y: number): unknown } }).__fabrico;
    if (!hook) throw new Error('window.__fabrico not installed');
    if (typeof hook.beltPreviewKindAt !== 'function') throw new Error('window.__fabrico.beltPreviewKindAt() not installed');
    return hook.beltPreviewKindAt(x, y);
  }, [cell[0], cell[1]] as const);
}

/** GridCommand body discriminants (`decode.ts` `encodeGridCommand`, the Rust enum order). */
export const CMD = { Place: 0, Delete: 1, Rotate: 2, DrawBelt: 3, Dock: 4, Undo: 5, Redo: 6, Configure: 9 } as const;

/**
 * Record the body discriminant of every gesture frame the page puts on the render socket
 * (promoted from `88-paused-occupancy.live.spec.ts` by review fixes WR-C-02, WR-C-03 and WR-C-06).
 * An observer on `WebSocket.prototype.send`, installed before the app boots (call it before the
 * first `page.goto`): it forwards every frame unchanged and records only binary frames' first BODY
 * byte, skipping the gesture header's two varints (board generation, gesture id; phase 88, plan
 * 88-03). A reload keeps it installed and starts a fresh list.
 */
export async function installFrameSniffer(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __sentCmds: number[] };
    w.__sentCmds = [];
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (this: WebSocket, data: string | ArrayBufferLike | Blob | ArrayBufferView) {
      let bytes: Uint8Array | null = null;
      if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
      else if (ArrayBuffer.isView(data)) bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      if (bytes !== null) {
        let i = 0;
        for (let field = 0; field < 2; field++) {
          while (i < bytes.length && (bytes[i] & 0x80) !== 0) i++;
          i++;
        }
        if (i < bytes.length) w.__sentCmds.push(bytes[i]);
      }
      return send.call(this, data as Parameters<WebSocket['send']>[0]);
    };
  });
}

/** How many frames of GridCommand `cmd` the page has sent since it loaded. Throws without the sniffer. */
export async function sentCount(page: Page, cmd: number): Promise<number> {
  return page.evaluate((c) => {
    const sent = (window as unknown as { __sentCmds?: number[] }).__sentCmds;
    if (!Array.isArray(sent)) throw new Error('the frame sniffer is not installed (installFrameSniffer before goto)');
    return sent.filter((x) => x === c).length;
  }, cmd);
}
